use crate::json::hex_id;
use base64::{engine::general_purpose::STANDARD, Engine};
use bytes::Bytes;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch, Notify},
    time::Instant,
};

pub type Shared = Arc<Mutex<Hub>>;
pub fn id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
#[derive(Clone)]
pub struct Output {
    pub kind: u8,
    pub tid: String,
    pub body: Bytes,
}
pub struct Peer {
    pub tx: mpsc::Sender<Output>,
    pub close: watch::Sender<bool>,
}
impl Peer {
    fn send(&self, kind: u8, tid: String, body: Bytes) {
        if self.tx.try_send(Output { kind, tid, body }).is_err() {
            let _ = self.close.send(true);
        }
    }
    fn event(&self, v: Value) {
        self.send(18, id(), encoded(&v))
    }
    fn reply(&self, tid: &str, v: Value) {
        self.send(17, tid.into(), encoded(&v))
    }
}
pub fn encoded(v: &Value) -> Bytes {
    Bytes::from(serde_json::to_vec(v).expect("JSON value"))
}
struct Session {
    did: String,
    peer: Peer,
    room: Option<u64>,
    udp: bool,
    pending: HashSet<String>,
}
struct Room {
    id: u64,
    name: String,
    members: Vec<String>,
    version: u64,
    seq: u64,
    game: String,
    pending: HashSet<String>,
    p2p: Option<P2p>,
}
struct Forward {
    user: String,
    tid: String,
    room: u64,
    deadline: Instant,
}
struct P2p {
    id: String,
    tokens: [String; 2],
    endpoints: [Option<SocketAddr>; 2],
    local: [Vec<Value>; 2],
    ready: [bool; 2],
    configured: bool,
    created: Instant,
}
pub struct Hub {
    online: HashMap<String, String>,
    sessions: HashMap<String, Session>,
    rooms: BTreeMap<u64, Room>,
    forwards: HashMap<String, Forward>,
    next_room: u64,
    udp_port: u16,
    punch: HashMap<String, (u64, usize)>,
    pub changed: Arc<Notify>,
}
fn ensure(ok: bool, message: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}
impl Room {
    fn envelope(&self, kind: &str) -> Value {
        json!({"type":kind,"roomId":self.id,"version":self.version,"gameId":self.game})
    }
    fn host(&self) -> &str {
        &self.members[0]
    }
}
impl Hub {
    pub fn new(port: u16) -> Shared {
        Arc::new(Mutex::new(Self {
            online: HashMap::new(),
            sessions: HashMap::new(),
            rooms: BTreeMap::new(),
            forwards: HashMap::new(),
            next_room: 1,
            udp_port: port,
            punch: HashMap::new(),
            changed: Arc::new(Notify::new()),
        }))
    }
    pub fn register(&mut self, did: String, udp: bool, peer: Peer) -> String {
        if let Some(old) = self.online.get(&did).cloned() {
            self.disconnect(&old)
        }
        let user = uuid::Uuid::new_v4().to_string();
        peer.event(json!({"type":"SESSION","selfId":user,"udpPort":self.udp_port,"p2p":udp}));
        self.online.insert(did.clone(), user.clone());
        self.sessions.insert(
            user.clone(),
            Session {
                did,
                peer,
                room: None,
                udp,
                pending: HashSet::new(),
            },
        );
        user
    }
    pub fn active(&self, user: &str) -> bool {
        self.sessions.contains_key(user)
    }
    pub fn disconnect(&mut self, user: &str) {
        if !self.active(user) {
            return;
        }
        self.leave(user, "DISCONNECTED");
        if let Some(s) = self.sessions.remove(user) {
            for p in s.pending {
                self.remove_forward(&p);
            }
            self.online.remove(&s.did);
            let _ = s.peer.close.send(true);
        }
    }
    fn event(&self, user: &str, v: Value) {
        if let Some(s) = self.sessions.get(user) {
            s.peer.event(v)
        }
    }
    fn broadcast(&self, r: &Room, v: Value) {
        let b = encoded(&v);
        self.broadcast_bytes(r, b);
    }
    fn broadcast_bytes(&self, r: &Room, b: Bytes) {
        let tid = id();
        for u in &r.members {
            if let Some(s) = self.sessions.get(u) {
                s.peer.send(18, tid.clone(), b.clone());
            }
        }
    }
    fn room_event(&self, r: &Room) {
        let mut v = r.envelope("ROOM");
        v["name"] = r.name.clone().into();
        v["hostId"] = r.host().into();
        v["members"] = json!(r.members);
        v["playing"] = (!r.game.is_empty()).into();
        v["p2pAvailable"] = self.capable(r).into();
        self.broadcast(r, v)
    }
    fn capable(&self, r: &Room) -> bool {
        r.members.len() == 2
            && r.members
                .iter()
                .all(|u| self.sessions.get(u).is_some_and(|s| s.udp))
    }
    fn result(&self, u: &str, tid: &str, cmd: &str, error: Option<&str>) {
        if let Some(s) = self.sessions.get(u) {
            let mut v = json!({"type":"RESULT","request":cmd,"ok":error.is_none()});
            if let Some(e) = error {
                v["error"] = e.into()
            }
            s.peer.reply(tid, v)
        }
    }
    fn remove_forward(&mut self, id: &str) -> Option<Forward> {
        let f = self.forwards.remove(id)?;
        if let Some(s) = self.sessions.get_mut(&f.user) {
            s.pending.remove(id);
        }
        if let Some(r) = self.rooms.get_mut(&f.room) {
            r.pending.remove(id);
        }
        Some(f)
    }
    fn invalidate(&mut self, r: &mut Room) {
        for id in r.pending.drain() {
            if let Some(f) = self.remove_forward(&id) {
                self.result(
                    &f.user,
                    &f.tid,
                    "ACTION",
                    Some("房间状态已变化，旧操作已取消"),
                )
            }
        }
        self.stop_p2p(r);
    }
    fn stop_p2p(&mut self, r: &mut Room) {
        if let Some(p) = r.p2p.take() {
            for token in &p.tokens {
                self.punch.remove(token);
            }
            let mut v = r.envelope("P2P_RELAY");
            v["p2pId"] = p.id.into();
            self.broadcast(r, v)
        }
    }
    fn end(&mut self, r: &mut Room, winner: &str, reason: &str) {
        let mut v = r.envelope("GAME_OVER");
        v["winnerId"] = winner.into();
        v["reason"] = reason.into();
        self.broadcast(r, v);
        self.invalidate(r);
        r.game.clear();
        r.version += 1;
        r.seq = 0;
    }
    fn leave(&mut self, u: &str, reason: &str) {
        let rid = self.sessions.get_mut(u).and_then(|s| s.room.take());
        let Some(mut r) = rid.and_then(|id| self.rooms.remove(&id)) else {
            return;
        };
        if !r.game.is_empty() {
            let other = r
                .members
                .iter()
                .find(|s| s.as_str() != u)
                .cloned()
                .unwrap_or_default();
            self.end(&mut r, &other, reason)
        }
        self.invalidate(&mut r);
        r.members.retain(|s| s != u);
        r.version += 1;
        r.seq = 0;
        if !r.members.is_empty() {
            self.room_event(&r);
            self.rooms.insert(r.id, r);
        }
    }
    pub fn next_deadline(&self) -> Option<Instant> {
        self.forwards.values().map(|f| f.deadline).min()
    }
    pub fn expire(&mut self) {
        let now = Instant::now();
        let ids: Vec<_> = self
            .forwards
            .iter()
            .filter(|(_, f)| f.deadline <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(f) = self.remove_forward(&id) {
                self.result(
                    &f.user,
                    &f.tid,
                    "ACTION",
                    Some("房主响应超时，请刷新状态或退出房间"),
                )
            }
        }
    }
    pub fn handle(&mut self, u: &str, tid: &str, q: Value) {
        if !self.active(u) {
            return;
        }
        let cmd = q["type"].as_str().unwrap_or("");
        match self.command(u, tid, cmd, &q) {
            Ok(true) => self.result(u, tid, cmd, None),
            Ok(false) => {}
            Err(e) => self.result(u, tid, cmd, Some(&e)),
        }
    }
    fn command(&mut self, u: &str, tid: &str, cmd: &str, q: &Value) -> Result<bool, String> {
        let current = self.sessions[u].room;
        match cmd {
            "LIST" => {
                ensure(current.is_none(), "请先退出当前房间")?;
                let after = q["after"].as_u64().unwrap_or(0);
                let mut list = Vec::new();
                let mut next = 0;
                for (_, r) in self
                    .rooms
                    .range((std::ops::Bound::Excluded(after), std::ops::Bound::Unbounded))
                {
                    if list.len() == 64 {
                        next = list.last().unwrap_or(&Value::Null)["id"]
                            .as_u64()
                            .unwrap_or(0);
                        break;
                    }
                    list.push(json!({"type":"ROOM_ENTRY","id":r.id,"name":r.name,"count":r.members.len(),"playing":!r.game.is_empty()}));
                }
                self.sessions[u]
                    .peer
                    .reply(tid, json!({"type":"ROOMS","rooms":list,"next":next}));
                return Ok(false);
            }
            "CREATE" => {
                ensure(current.is_none(), "你已在房间中")?;
                let name = q["name"].as_str().unwrap_or("").trim();
                ensure(
                    !name.is_empty()
                        && name.chars().count() <= 32
                        && !name.chars().any(char::is_control),
                    "房间名须为 1 至 32 个字符，不能含控制字符",
                )?;
                let r = Room {
                    id: self.next_room,
                    name: name.into(),
                    members: vec![u.into()],
                    version: 1,
                    seq: 0,
                    game: String::new(),
                    pending: HashSet::new(),
                    p2p: None,
                };
                self.next_room += 1;
                self.sessions.get_mut(u).unwrap().room = Some(r.id);
                self.room_event(&r);
                self.rooms.insert(r.id, r);
                return Ok(true);
            }
            "LEAVE" => {
                ensure(current.is_some(), "你已不在房间中")?;
                self.leave(u, "LEFT");
                self.event(u, json!({"type":"ROOM_CLOSED","reason":"LEFT"}));
                return Ok(true);
            }
            _ => {}
        }
        let rid = if cmd == "JOIN" {
            ensure(current.is_none(), "你已在房间中")?;
            q["roomId"].as_u64().ok_or("房间不存在")?
        } else {
            current.ok_or("你已不在房间中")?
        };
        let mut room = self.rooms.remove(&rid).ok_or("房间已不存在，请刷新列表")?;
        let result = (|| {
            if cmd != "JOIN" {
                ensure(
                    q["roomId"].as_u64() == Some(room.id)
                        && q["version"].as_u64() == Some(room.version)
                        && q["gameId"].as_str() == Some(&room.game),
                    "房间或对局状态已变化，请刷新",
                )?;
            }
            self.room_command(u, tid, cmd, q, &mut room)
        })();
        if !room.members.is_empty() {
            self.rooms.insert(rid, room);
        }
        result
    }
    fn prepare_state(state: &Value, previous: Option<u64>) -> Result<(u64, Vec<u8>), String> {
        let seq = state["seq"]
            .as_u64()
            .filter(|n| *n <= i64::MAX as u64)
            .ok_or("状态版本无效")?;
        ensure(
            previous.map_or(seq == 0, |old| seq > old),
            "状态版本不一致，请刷新",
        )?;
        let bytes = serde_json::to_vec(state).map_err(|_| "状态格式异常")?;
        ensure(state.is_object() && bytes.len() < 48000, "房间状态过大")?;
        Ok((seq, bytes))
    }
    fn state_bytes(&self, r: &mut Room, seq: u64, bytes: &[u8]) {
        r.seq = seq;
        let mut envelope = serde_json::to_vec(&r.envelope("STATE")).unwrap();
        envelope.pop();
        envelope.extend_from_slice(b",\"state\":");
        envelope.extend_from_slice(bytes);
        envelope.push(b'}');
        self.broadcast_bytes(r, Bytes::from(envelope));
    }
    fn state(&self, r: &mut Room, state: &Value, start: bool) -> Result<(), String> {
        let (seq, bytes) = Self::prepare_state(state, if start { None } else { Some(r.seq) })?;
        self.state_bytes(r, seq, &bytes);
        Ok(())
    }
    fn room_command(
        &mut self,
        u: &str,
        tid: &str,
        cmd: &str,
        q: &Value,
        r: &mut Room,
    ) -> Result<bool, String> {
        if matches!(
            cmd,
            "DISSOLVE" | "HOST_REPLY" | "HOST_STATE" | "START" | "FINISH" | "P2P_KEY"
        ) {
            ensure(r.host() == u, "房主已经变化")?
        }
        match cmd {
            "JOIN" => {
                ensure(
                    r.game.is_empty() && r.members.len() < 2,
                    "房间已满或正在游戏",
                )?;
                self.invalidate(r);
                r.members.push(u.into());
                r.version += 1;
                r.seq = 0;
                self.sessions.get_mut(u).unwrap().room = Some(r.id);
                self.room_event(r)
            }
            "DISSOLVE" => {
                if !r.game.is_empty() {
                    let other = r
                        .members
                        .iter()
                        .find(|s| s.as_str() != u)
                        .cloned()
                        .unwrap_or_default();
                    self.end(r, &other, "HOST_DISSOLVED")
                }
                self.invalidate(r);
                for member in r.members.drain(..) {
                    self.sessions.get_mut(&member).unwrap().room = None;
                    self.event(&member, json!({"type":"ROOM_CLOSED","reason":"DISSOLVED"}))
                }
            }
            "ACTION" => {
                ensure(self.sessions[u].pending.len() < 8, "操作处理中，请稍候")?;
                ensure(q["action"].is_object(), "缺少操作内容")?;
                let request = id();
                let f = Forward {
                    user: u.into(),
                    tid: tid.into(),
                    room: r.id,
                    deadline: Instant::now() + Duration::from_secs(8),
                };
                self.forwards.insert(request.clone(), f);
                r.pending.insert(request.clone());
                self.sessions
                    .get_mut(u)
                    .unwrap()
                    .pending
                    .insert(request.clone());
                self.changed.notify_one();
                let mut v = r.envelope("FORWARD");
                v["requestId"] = request.into();
                v["actorId"] = u.into();
                v["action"] = q["action"].clone();
                if let Some(op) = q["operationId"].as_str().filter(|s| hex_id(s)) {
                    v["operationId"] = op.into()
                }
                self.event(r.host(), v);
                return Ok(false);
            }
            "HOST_REPLY" => {
                let request = q["requestId"].as_str().unwrap_or("");
                ensure(
                    self.forwards.get(request).is_some_and(|f| f.room == r.id),
                    "操作已失效，请刷新状态",
                )?;
                let ok = q["ok"].as_bool() == Some(true);
                if ok {
                    self.state(r, &q["state"], false)?
                }
                let f = self.remove_forward(request).unwrap();
                r.pending.remove(request);
                self.result(
                    &f.user,
                    &f.tid,
                    "ACTION",
                    if ok {
                        None
                    } else {
                        Some(q["error"].as_str().unwrap_or("操作无效"))
                    },
                );
            }
            "HOST_STATE" => self.state(r, &q["state"], false)?,
            "START" => {
                ensure(r.game.is_empty() && r.members.len() == 2, "开局条件已变化")?;
                let (seq, bytes) = Self::prepare_state(&q["state"], None)?;
                self.invalidate(r);
                r.game = uuid::Uuid::new_v4().to_string();
                r.version += 1;
                r.seq = 0;
                self.room_event(r);
                self.state_bytes(r, seq, &bytes);
            }
            "FINISH" => {
                ensure(!r.game.is_empty(), "对局已经结束")?;
                let winner = q["winnerId"].as_str().unwrap_or("");
                let reason = q["reason"].as_str().unwrap_or("");
                ensure(r.members.iter().any(|s| s == winner), "胜方不是当前成员")?;
                ensure(
                    matches!(reason, "TIMEOUT" | "NO_PIECES" | "NO_MOVES"),
                    "结束原因无效",
                )?;
                self.end(r, winner, reason);
                self.room_event(r)
            }
            "P2P_REQUEST" => {
                ensure(
                    !r.game.is_empty() && self.capable(r) && r.host() != u,
                    "当前房间不支持直连",
                )?;
                ensure(r.p2p.is_none(), "直连协商已开始")?;
                let p = P2p {
                    id: id(),
                    tokens: [id(), id()],
                    endpoints: [None, None],
                    local: [vec![], vec![]],
                    ready: [false, false],
                    configured: false,
                    created: Instant::now(),
                };
                let mut v = r.envelope("P2P_OFFER");
                v["p2pId"] = p.id.clone().into();
                self.event(r.host(), v);
                r.p2p = Some(p);
            }
            "P2P_KEY" => {
                let p = r.p2p.as_mut().ok_or("直连已失效")?;
                ensure(
                    q["p2pId"].as_str() == Some(&p.id)
                        && !p.configured
                        && p.created.elapsed() < Duration::from_secs(15),
                    "直连已失效",
                )?;
                let key = q["key"]
                    .as_str()
                    .filter(|s| s.len() == 44)
                    .ok_or("密钥无效")?;
                ensure(
                    STANDARD.decode(key).is_ok_and(|b| b.len() == 32),
                    "密钥无效",
                )?;
                p.configured = true;
                let sid = p.id.clone();
                let tokens = p.tokens.clone();
                for (i, token) in tokens.iter().enumerate() {
                    self.punch.insert(token.clone(), (r.id, i));
                    let mut v = r.envelope("P2P_CONFIG");
                    v["p2pId"] = sid.clone().into();
                    v["token"] = token.clone().into();
                    v["key"] = key.into();
                    v["udpPort"] = self.udp_port.into();
                    v["peerId"] = r.members[1 - i].clone().into();
                    self.event(&r.members[i], v)
                }
            }
            "P2P_LOCAL" => {
                let i = r.members.iter().position(|s| s == u).unwrap();
                let p = r.p2p.as_mut().ok_or("直连已失效")?;
                ensure(q["p2pId"].as_str() == Some(&p.id), "直连已失效")?;
                if let Some(a) = q["candidates"].as_array() {
                    p.local[i] = a
                        .iter()
                        .take(4)
                        .filter(|v| {
                            v["host"]
                                .as_str()
                                .is_some_and(|s| s.parse::<std::net::IpAddr>().is_ok())
                                && v["port"].as_u64().is_some_and(|n| n > 0 && n <= 65535)
                        })
                        .cloned()
                        .collect();
                }
                self.peer_endpoints(r);
            }
            "P2P_READY" => {
                let i = r.members.iter().position(|s| s == u).unwrap();
                let p = r.p2p.as_mut().ok_or("直连已失效")?;
                ensure(
                    q["p2pId"].as_str() == Some(&p.id) && p.configured,
                    "直连已失效",
                )?;
                let was = p.ready.iter().all(|v| *v);
                p.ready[i] = true;
                if !was && p.ready.iter().all(|v| *v) {
                    let sid = p.id.clone();
                    let mut v = r.envelope("P2P_ACTIVE");
                    v["p2pId"] = sid.into();
                    self.broadcast(r, v)
                }
            }
            "P2P_STOP" => {
                if r.p2p
                    .as_ref()
                    .is_some_and(|p| q["p2pId"].as_str() == Some(&p.id))
                {
                    self.stop_p2p(r)
                }
            }
            _ => return Err("未知房间操作".into()),
        }
        Ok(true)
    }
    fn peer_endpoints(&self, r: &Room) {
        let Some(p) = &r.p2p else { return };
        if p.endpoints.iter().any(Option::is_none) {
            return;
        }
        for i in 0..2 {
            let e = p.endpoints[1 - i].unwrap();
            let mut candidates = p.local[1 - i].clone();
            candidates.push(json!({"host":e.ip().to_string(),"port":e.port()}));
            let mut v = r.envelope("P2P_PEER");
            v["p2pId"] = p.id.clone().into();
            v["candidates"] = candidates.into();
            self.event(&r.members[i], v)
        }
    }
    pub fn udp_register(&mut self, b: &[u8], addr: SocketAddr) {
        if b.len() != 36 || &b[..4] != b"CFU1" {
            return;
        }
        let token = uuid::Uuid::from_slice(&b[20..36])
            .unwrap()
            .simple()
            .to_string();
        let Some((rid, i)) = self.punch.get(&token).copied() else {
            return;
        };
        let Some(mut r) = self.rooms.remove(&rid) else {
            return;
        };
        if let Some(p) = &mut r.p2p {
            if p.id
                == uuid::Uuid::from_slice(&b[4..20])
                    .unwrap()
                    .simple()
                    .to_string()
                && p.created.elapsed() < Duration::from_secs(15)
                && p.endpoints[i].is_none()
            {
                p.endpoints[i] = Some(addr);
                self.peer_endpoints(&r)
            }
        }
        self.rooms.insert(rid, r);
    }
}
