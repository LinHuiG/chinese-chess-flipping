//! 通用目录、房主声明的通信授权与原样转发；不解析准入或媒体正文。
use crate::{json, wire};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use bytes::Bytes;
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
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
pub fn encoded(v: &Value) -> Bytes {
    Bytes::from(serde_json::to_vec(v).expect("JSON value"))
}
#[derive(Clone)]
pub struct Output {
    pub kind: u8,
    pub header: Bytes,
    pub body: Bytes,
    pub expires: Option<Instant>,
    pub route: Option<(String, String, String, String, String)>,
}
pub struct Peer {
    pub tx: mpsc::Sender<Output>,
    pub close: watch::Sender<bool>,
}
impl Peer {
    fn send(&self, output: Output) -> Result<(), String> {
        // 可丢弃流量不能耗尽控制消息的保留队列。
        if output.expires.is_some() && self.tx.capacity() <= 8 {
            return Err("DROPPED".into());
        }
        self.tx.try_send(output).map_err(|_| {
            let _ = self.close.send(true);
            "TARGET_UNAVAILABLE".into()
        })
    }
}
struct Memo {
    request: String,
    hash: [u8; 32],
    at: Instant,
    output: Output,
}
struct User {
    token: String,
    peer: Option<Peer>,
    generation: u64,
    heartbeat: Instant,
    rooms: HashSet<String>,
    ticket: Option<(String, Instant)>,
    memo: VecDeque<Memo>,
    rate_at: Instant,
    rate_count: usize,
    rate_bytes: usize,
}
struct Room {
    name: String,
    room_type: String,
    metadata: String,
    host: String,
    routes: HashSet<String>,
    authorized: BTreeMap<String, String>,
    version: u64,
    locked: bool,
}
pub struct Hub {
    users: HashMap<String, User>,
    rooms: BTreeMap<String, Room>,
    pending: HashMap<(String, String, String), Instant>,
    udp_port: u16,
    pub changed: Arc<Notify>,
}
fn ensure(ok: bool, error: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(error.into())
    }
}
fn delivery_deadline(f: &BTreeMap<&str, &str>) -> Result<Option<Instant>, String> {
    match f.get("discard") {
        Some(&"1") => {
            let ms = f
                .get("maxAgeMs")
                .and_then(|s| s.parse::<u64>().ok())
                .ok_or("INVALID_ARGUMENT")?;
            ensure((1..=2000).contains(&ms), "INVALID_ARGUMENT")?;
            Ok(Some(Instant::now() + Duration::from_millis(ms)))
        }
        Some(&"0") | None if !f.contains_key("maxAgeMs") => Ok(None),
        _ => Err("INVALID_ARGUMENT".into()),
    }
}
impl Hub {
    pub fn new(udp_port: u16) -> Shared {
        Arc::new(Mutex::new(Self {
            users: HashMap::new(),
            rooms: BTreeMap::new(),
            pending: HashMap::new(),
            udp_port,
            changed: Arc::new(Notify::new()),
        }))
    }
    pub fn register(&mut self, meta: &Value, peer: Peer) -> Result<(String, u64, Value), String> {
        self.expire();
        let requested = meta["clientId"].as_str().unwrap_or("");
        let supplied = meta["token"].as_str().unwrap_or("");
        let user = if requested.is_empty() && supplied.is_empty() {
            ensure(self.users.len() < 10000, "SERVER_BUSY")?;
            let mut secret = [0; 32];
            OsRng.fill_bytes(&mut secret);
            let user = id();
            self.users.insert(
                user.clone(),
                User {
                    token: URL_SAFE_NO_PAD.encode(secret),
                    peer: None,
                    generation: 0,
                    heartbeat: Instant::now(),
                    rooms: HashSet::new(),
                    ticket: None,
                    memo: VecDeque::new(),
                    rate_at: Instant::now(),
                    rate_count: 0,
                    rate_bytes: 0,
                },
            );
            user
        } else {
            ensure(
                self.users
                    .get(requested)
                    .is_some_and(|u| u.token == supplied),
                "SESSION_EXPIRED",
            )?;
            requested.to_owned()
        };
        let u = self.users.get_mut(&user).unwrap();
        if let Some(old) = u.peer.take() {
            let _ = old.close.send(true);
        }
        u.peer = Some(peer);
        u.generation += 1;
        u.heartbeat = Instant::now();
        u.ticket = None;
        self.changed.notify_one();
        Ok((
            user.clone(),
            u.generation,
            json!({"clientId":user,"token":u.token,"serverVersion":env!("CARGO_PKG_VERSION"),"capabilities":["room-sync","room-broadcast","host-grant","room-descriptors"]}),
        ))
    }
    pub fn active(&self, user: &str, generation: u64) -> bool {
        self.users
            .get(user)
            .is_some_and(|u| u.generation == generation && u.peer.is_some())
    }
    pub fn disconnect(&mut self, user: &str, generation: u64) {
        if self.active(user, generation) {
            let u = self.users.get_mut(user).unwrap();
            u.peer = None;
            u.ticket = None;
        }
    }
    pub fn ping(&mut self, user: &str, generation: u64) {
        if self.active(user, generation) {
            self.users.get_mut(user).unwrap().heartbeat = Instant::now();
        }
    }
    fn send(&self, user: &str, kind: u8, header: Bytes, body: Bytes) -> Result<(), String> {
        self.users
            .get(user)
            .and_then(|u| u.peer.as_ref())
            .ok_or("TARGET_UNAVAILABLE")?
            .send(Output {
                kind,
                header,
                body,
                expires: None,
                route: None,
            })
    }
    fn result(&self, user: &str, op: &str, request: &str, result: Result<Value, String>) -> Output {
        let (suffix, body) = match result {
            Ok(v) => ("ok:1\n".to_owned(), v),
            Err(e) => (format!("ok:0\nerror:{e}\n"), json!({})),
        };
        let output = Output {
            kind: 18,
            header: Bytes::from(format!("op:{op}\nrequestId:{request}\n{suffix}")),
            body: encoded(&body),
            expires: None,
            route: None,
        };
        let _ = self.send(
            user,
            output.kind,
            output.header.clone(),
            output.body.clone(),
        );
        output
    }
    fn event(&self, user: &str, op: u16, body: Value) {
        let _ = self.send(user, 18, Bytes::from(format!("op:{op}\n")), encoded(&body));
    }
    fn forward(
        &self,
        sender: &str,
        target: &str,
        kind: u8,
        control: &[u8],
        body: Bytes,
    ) -> Result<(), String> {
        ensure(control.len() <= 4058, "LIMIT_EXCEEDED")?;
        let mut header = Vec::with_capacity(control.len() + 38);
        header.extend_from_slice(control);
        header.extend_from_slice(format!("from:{sender}\n").as_bytes());
        self.send(target, kind, Bytes::from(header), body)
    }
    pub fn handle(&mut self, user: &str, kind: u8, c: &[u8], body: Bytes) -> Result<(), String> {
        let fields = wire::control(c)?;
        ensure(!fields.contains_key("from"), "INVALID_ARGUMENT")?;
        let op = fields.get("op").copied().ok_or("INVALID_ARGUMENT")?;
        let request = fields.get("requestId").copied().unwrap_or("");
        ensure(
            (matches!(op, "200" | "201") && request.is_empty()) || json::hex_id(request),
            "INVALID_ARGUMENT",
        )?;
        ensure(
            kind == 16 || (kind == 18 && op == "102"),
            "INVALID_ARGUMENT",
        )?;
        let u = self.users.get_mut(user).ok_or("SESSION_EXPIRED")?;
        if u.rate_at.elapsed() >= Duration::from_secs(1) {
            u.rate_at = Instant::now();
            u.rate_count = 0;
            u.rate_bytes = 0;
        }
        u.rate_count += 1;
        let fanout = if op == "201" {
            fields
                .get("to")
                .map(|s| s.split(',').count())
                .unwrap_or(16)
                .min(16)
        } else {
            1
        };
        u.rate_bytes = u
            .rate_bytes
            .saturating_add((body.len() + c.len() + 17) * fanout);
        if u.rate_count > 1000 || u.rate_bytes > 4 * 1024 * 1024 {
            if !request.is_empty() {
                self.result(user, op, request, Err("LIMIT_EXCEEDED".into()));
            }
            return Ok(());
        }
        let result = match (kind, op) {
            (16, "200") => self.relay(user, &fields, c, body).map(|_| Some(json!({}))),
            (16, "201") => self.broadcast(user, &fields, c, body).map(Some),
            (16, "102") => self.join(user, &fields, c, body).map(|_| None),
            (18, "102") => {
                self.join_reply(user, &fields, c, body)?;
                return Ok(());
            }
            (16, _) => {
                let mut digest = Sha256::new();
                digest.update(op.as_bytes());
                digest.update(&body);
                let hash: [u8; 32] = digest.finalize().into();
                if let Some(m) = self.users[user]
                    .memo
                    .iter()
                    .find(|m| m.request == request && m.at.elapsed() < Duration::from_secs(60))
                {
                    ensure(m.hash == hash, "INVALID_ARGUMENT")?;
                    return self.send(
                        user,
                        m.output.kind,
                        m.output.header.clone(),
                        m.output.body.clone(),
                    );
                }
                let result = json::object(&body).and_then(|q| self.command(user, op, &q));
                let output = self.result(user, op, request, result);
                if matches!(op, "100" | "103" | "104" | "105") {
                    let memo = &mut self.users.get_mut(user).unwrap().memo;
                    if memo.len() >= 32 {
                        memo.pop_front();
                    }
                    memo.push_back(Memo {
                        request: request.into(),
                        hash,
                        at: Instant::now(),
                        output,
                    });
                }
                return Ok(());
            }
            _ => Err("INVALID_ARGUMENT".into()),
        };
        match result {
            Ok(None) => {}
            Ok(Some(v)) if !request.is_empty() => {
                self.result(user, op, request, Ok(v));
            }
            Err(e) if !request.is_empty() => {
                self.result(user, op, request, Err(e));
            }
            _ => {}
        }
        Ok(())
    }
    fn command(&mut self, user: &str, op: &str, q: &Value) -> Result<Value, String> {
        match op {
            "100" => {
                ensure(
                    self.rooms.len() < 10000 && self.users[user].rooms.len() < 16,
                    "LIMIT_EXCEEDED",
                )?;
                let name = json::field(q, "name", 64)?;
                ensure(name.chars().count() <= 32, "INVALID_ARGUMENT")?;
                let room_type = json::field(q, "roomType", 128)?;
                ensure(room_type.is_ascii(), "INVALID_ARGUMENT")?;
                let metadata = match q.get("metadata") {
                    None => "",
                    Some(value) => value.as_str().ok_or("INVALID_ARGUMENT")?,
                };
                ensure(metadata.len() <= 2048, "INVALID_ARGUMENT")?;
                let rid = id();
                let routes = HashSet::from([user.to_owned()]);
                self.rooms.insert(
                    rid.clone(),
                    Room {
                        name: name.to_owned(),
                        room_type: room_type.to_owned(),
                        metadata: metadata.to_owned(),
                        host: user.to_owned(),
                        routes,
                        authorized: BTreeMap::from([(user.to_owned(), id())]),
                        version: 1,
                        locked: q["locked"].as_bool().unwrap_or(false),
                    },
                );
                self.users.get_mut(user).unwrap().rooms.insert(rid.clone());
                Ok(json!({"roomId":rid}))
            }
            "101" => {
                let room_type = match q.get("roomType") {
                    None => None,
                    Some(_) => Some(json::field(q, "roomType", 128)?),
                };
                let after = q["after"].as_str().unwrap_or("");
                ensure(after.is_empty() || json::hex_id(after), "INVALID_ARGUMENT")?;
                let mut iter = self.rooms.iter().filter(|(id, r)| {
                    id.as_str() > after && room_type.is_none_or(|t| r.room_type == t)
                });
                let mut rooms = Vec::new();
                let mut bytes = 64;
                let mut next = Value::Null;
                for (id, r) in iter.by_ref() {
                    let entry = json!({"roomId":id,"name":r.name,"roomType":r.room_type,"metadata":r.metadata,"hostId":r.host,"locked":r.locked});
                    let size = serde_json::to_vec(&entry).unwrap().len() + 1;
                    if rooms.len() >= 64 || bytes + size > 60000 {
                        next = rooms
                            .last()
                            .map(|r: &Value| r["roomId"].clone())
                            .unwrap_or(Value::Null);
                        break;
                    }
                    bytes += size;
                    rooms.push(entry);
                }
                Ok(json!({"rooms":rooms,"next":next}))
            }
            "103" => {
                let rid = json::field(q, "roomId", 32)?;
                let room = self.rooms.get(rid).ok_or("ROOM_NOT_FOUND")?;
                ensure(room.authorized.contains_key(user), "NOT_MEMBER")?;
                if q.get("locked").is_some() || q.get("revoke").is_some() {
                    ensure(room.host == user, "NOT_HOST")?;
                    if let Some(locked) = q.get("locked") {
                        ensure(locked.is_boolean(), "INVALID_ARGUMENT")?;
                    }
                    if let Some(revoke) = q.get("revoke") {
                        let targets = revoke.as_array().ok_or("INVALID_ARGUMENT")?;
                        ensure(targets.len() <= 16, "LIMIT_EXCEEDED")?;
                        let ids: Vec<String> = targets
                            .iter()
                            .map(|v| {
                                v.as_str()
                                    .filter(|v| json::hex_id(v) && *v != user)
                                    .map(str::to_owned)
                                    .ok_or("INVALID_ARGUMENT".to_owned())
                            })
                            .collect::<Result<_, _>>()?;
                        for target in ids {
                            self.leave(&target, rid);
                            self.event(
                                &target,
                                104,
                                json!({"roomId":rid,"clientId":target,"revoked":true}),
                            );
                        }
                    }
                    if let Some(locked) = q.get("locked") {
                        let locked = locked.as_bool().ok_or("INVALID_ARGUMENT")?;
                        let room = self.rooms.get_mut(rid).unwrap();
                        room.locked = locked;
                        room.version += 1;
                    }
                }
                let room = &self.rooms[rid];
                let members: Vec<_> = room.authorized.iter().map(|(id, association)| json!({"clientId":id,"association":association,"online":self.users.get(id).is_some_and(|u|u.peer.is_some())})).collect();
                Ok(
                    json!({"roomId":rid,"hostId":room.host,"version":room.version,"locked":room.locked,"members":members}),
                )
            }
            "104" => {
                let rid = json::field(q, "roomId", 32)?;
                self.leave(user, rid);
                Ok(json!({}))
            }
            "105" => {
                let rid = json::field(q, "roomId", 32)?;
                ensure(
                    self.rooms.get(rid).is_some_and(|r| r.host == user),
                    "NOT_HOST",
                )?;
                self.close_room(rid);
                Ok(json!({}))
            }
            "210" => {
                let ticket = id();
                self.users.get_mut(user).unwrap().ticket = Some((ticket.clone(), Instant::now()));
                self.changed.notify_one();
                Ok(json!({"ticket":ticket,"port":self.udp_port}))
            }
            _ => Err("INVALID_ARGUMENT".into()),
        }
    }
    fn join(
        &mut self,
        user: &str,
        f: &BTreeMap<&str, &str>,
        c: &[u8],
        body: Bytes,
    ) -> Result<(), String> {
        let rid = *f.get("roomId").ok_or("INVALID_ARGUMENT")?;
        let host = self.rooms.get(rid).ok_or("ROOM_NOT_FOUND")?.host.clone();
        ensure(host != user, "INVALID_ARGUMENT")?;
        ensure(
            self.users[user].rooms.len() < 16 || self.users[user].rooms.contains(rid),
            "LIMIT_EXCEEDED",
        )?;
        let key = (rid.to_owned(), user.to_owned(), f["requestId"].to_owned());
        if self.pending.contains_key(&key) {
            return Ok(());
        }
        ensure(self.pending.len() < 4096, "SERVER_BUSY")?;
        self.forward(user, &host, 16, c, body)?;
        self.rooms.get_mut(rid).unwrap().routes.insert(user.into());
        self.users.get_mut(user).unwrap().rooms.insert(rid.into());
        self.pending.insert(key, Instant::now());
        self.changed.notify_one();
        Ok(())
    }
    fn join_reply(
        &mut self,
        user: &str,
        f: &BTreeMap<&str, &str>,
        c: &[u8],
        body: Bytes,
    ) -> Result<(), String> {
        let rid = *f.get("roomId").ok_or("INVALID_ARGUMENT")?;
        let target = *f.get("to").ok_or("INVALID_ARGUMENT")?;
        ensure(
            self.rooms.get(rid).is_some_and(|r| r.host == user),
            "NOT_HOST",
        )?;
        let key = (rid.into(), target.into(), f["requestId"].into());
        let Some(at) = self.pending.get(&key) else {
            return Ok(());
        };
        if at.elapsed() < Duration::from_secs(30) {
            let granted = f.get("grant") == Some(&"1");
            ensure(
                matches!(f.get("grant"), Some(&"0" | &"1")),
                "INVALID_ARGUMENT",
            )?;
            if granted {
                let room = self.rooms.get_mut(rid).unwrap();
                if !room.authorized.contains_key(target) {
                    ensure(room.authorized.len() < 16, "LIMIT_EXCEEDED")?;
                    room.authorized.insert(target.into(), id());
                    room.version += 1;
                }
            }
            // The applicant may disconnect while the host is deciding. Its slow
            // socket cannot invalidate the host connection or other members.
            let _ = self.forward(user, target, 18, c, body);
            if !granted && !self.rooms[rid].authorized.contains_key(target) {
                self.leave(target, rid);
            }
        }
        self.pending.remove(&key);
        Ok(())
    }
    fn relay(
        &self,
        user: &str,
        f: &BTreeMap<&str, &str>,
        c: &[u8],
        body: Bytes,
    ) -> Result<(), String> {
        let rid = *f.get("roomId").ok_or("INVALID_ARGUMENT")?;
        let to = *f.get("to").ok_or("INVALID_ARGUMENT")?;
        let room = self.rooms.get(rid).ok_or("ROOM_NOT_FOUND")?;
        ensure(
            room.authorized.contains_key(user) && room.authorized.contains_key(to),
            "TARGET_UNAVAILABLE",
        )?;
        self.deliver(user, to, rid, delivery_deadline(f)?, c, body)
    }
    fn deliver(
        &self,
        user: &str,
        target: &str,
        rid: &str,
        expires: Option<Instant>,
        c: &[u8],
        body: Bytes,
    ) -> Result<(), String> {
        ensure(c.len() <= 4058, "LIMIT_EXCEEDED")?;
        let room = &self.rooms[rid];
        let mut header = Vec::with_capacity(c.len() + 38);
        header.extend_from_slice(c);
        header.extend_from_slice(format!("from:{user}\n").as_bytes());
        let output = Output {
            kind: 64,
            header: header.into(),
            body,
            expires,
            route: Some((
                rid.into(),
                user.into(),
                room.authorized[user].clone(),
                target.into(),
                room.authorized[target].clone(),
            )),
        };
        self.users
            .get(target)
            .and_then(|u| u.peer.as_ref())
            .ok_or("TARGET_UNAVAILABLE")?
            .send(output)
    }
    fn broadcast(
        &self,
        user: &str,
        f: &BTreeMap<&str, &str>,
        c: &[u8],
        body: Bytes,
    ) -> Result<Value, String> {
        let rid = *f.get("roomId").ok_or("INVALID_ARGUMENT")?;
        let room = self.rooms.get(rid).ok_or("ROOM_NOT_FOUND")?;
        ensure(room.authorized.contains_key(user), "NOT_MEMBER")?;
        let expires = delivery_deadline(f)?;
        ensure(c.len() <= 4058, "LIMIT_EXCEEDED")?;
        let targets: HashSet<&str> = match f.get("to") {
            Some(&"") => HashSet::new(),
            Some(list) => {
                ensure(list.len() <= 16 * 33, "LIMIT_EXCEEDED")?;
                list.split(',').collect()
            }
            None => room
                .authorized
                .keys()
                .map(String::as_str)
                .filter(|id| *id != user)
                .collect(),
        };
        ensure(
            targets.len() <= 16
                && targets
                    .iter()
                    .all(|id| json::hex_id(id) && *id != user && room.authorized.contains_key(*id)),
            "INVALID_ARGUMENT",
        )?;
        // A slow/offline target must not interrupt delivery to healthy room members.
        let mut delivered = 0;
        let mut dropped = 0;
        for target in targets {
            if self
                .deliver(user, target, rid, expires, c, body.clone())
                .is_ok()
            {
                delivered += 1
            } else {
                dropped += 1
            }
        }
        Ok(json!({"delivered":delivered,"dropped":dropped}))
    }
    pub fn output_valid(&self, output: &Output) -> bool {
        if output.expires.is_some_and(|at| Instant::now() >= at) {
            return false;
        }
        output.route.as_ref().is_none_or(|(rid, from, fa, to, ta)| {
            self.rooms.get(rid).is_some_and(|r| {
                r.authorized.get(from) == Some(fa) && r.authorized.get(to) == Some(ta)
            })
        })
    }
    fn leave(&mut self, user: &str, rid: &str) {
        if self.rooms.get(rid).is_some_and(|r| r.host == user) {
            self.close_room(rid);
            return;
        }
        self.pending.retain(|(r, u, _), _| r != rid || u != user);
        if let Some(u) = self.users.get_mut(user) {
            u.rooms.remove(rid);
        }
        if let Some(r) = self.rooms.get_mut(rid) {
            if r.authorized.remove(user).is_some() {
                r.version += 1;
            }
            if r.routes.remove(user) {
                let host = r.host.clone();
                self.event(&host, 104, json!({"roomId":rid,"clientId":user}));
            }
        }
    }
    fn close_room(&mut self, rid: &str) {
        if let Some(r) = self.rooms.remove(rid) {
            for user in r.routes {
                if let Some(u) = self.users.get_mut(&user) {
                    u.rooms.remove(rid);
                }
                self.event(&user, 105, json!({"roomId":rid}));
            }
        }
        let pending: Vec<_> = self
            .pending
            .keys()
            .filter(|(r, _, _)| r == rid)
            .cloned()
            .collect();
        for key in pending {
            self.pending.remove(&key);
            self.result(&key.1, "102", &key.2, Err("ROOM_NOT_FOUND".into()));
        }
    }
    pub fn udp_register(&mut self, bytes: &[u8], address: SocketAddr) {
        let Ok((16, c, b)) = wire::plaintext(bytes) else {
            return;
        };
        let Ok(f) = wire::control(c) else { return };
        if f.get("op") != Some(&"210") {
            return;
        }
        let Ok(q) = json::object(b) else { return };
        let user = q["clientId"].as_str().unwrap_or("");
        let Some(u) = self.users.get_mut(user) else {
            return;
        };
        if !u
            .ticket
            .as_ref()
            .is_some_and(|(t, at)| q["ticket"] == *t && at.elapsed() < Duration::from_secs(15))
        {
            return;
        }
        u.ticket = None;
        self.event(
            user,
            210,
            json!({"ip":address.ip().to_string(),"port":address.port()}),
        );
    }
    pub fn next_deadline(&self) -> Option<Instant> {
        self.users
            .values()
            .map(|u| u.heartbeat + Duration::from_secs(60))
            .chain(
                self.pending
                    .values()
                    .map(|at| *at + Duration::from_secs(30)),
            )
            .chain(self.users.values().filter_map(|u| {
                u.ticket
                    .as_ref()
                    .map(|(_, at)| *at + Duration::from_secs(15))
            }))
            .min()
    }
    pub fn expire(&mut self) {
        let expired: Vec<_> = self
            .users
            .iter()
            .filter(|(_, u)| u.heartbeat.elapsed() >= Duration::from_secs(60))
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            let rooms: Vec<_> = self.users[&id].rooms.iter().cloned().collect();
            for rid in rooms {
                self.leave(&id, &rid);
            }
            if let Some(u) = self.users.remove(&id) {
                if let Some(p) = u.peer {
                    let _ = p.close.send(true);
                }
            }
        }
        let old: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, at)| at.elapsed() >= Duration::from_secs(30))
            .map(|(k, _)| k.clone())
            .collect();
        for key in old {
            self.pending.remove(&key);
            self.result(&key.1, "102", &key.2, Err("TIMEOUT".into()));
            if self
                .rooms
                .get(&key.0)
                .is_some_and(|r| !r.authorized.contains_key(&key.1))
            {
                self.leave(&key.1, &key.0);
            }
        }
        for u in self.users.values_mut() {
            if u.ticket
                .as_ref()
                .is_some_and(|(_, at)| at.elapsed() >= Duration::from_secs(15))
            {
                u.ticket = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn peer(
        h: &mut Hub,
    ) -> (
        String,
        u64,
        Value,
        mpsc::Receiver<Output>,
        watch::Receiver<bool>,
    ) {
        let (tx, rx) = mpsc::channel(32);
        let (close, closed) = watch::channel(false);
        let (id, generation, identity) = h.register(&json!({}), Peer { tx, close }).unwrap();
        (id, generation, identity, rx, closed)
    }
    fn admit(h: &mut Hub, host: &str, guest: &str, rid: &str) {
        let request = id();
        h.handle(
            guest,
            16,
            format!("op:102\nrequestId:{request}\nroomId:{rid}\n").as_bytes(),
            Bytes::from_static(b"opaque request"),
        )
        .unwrap();
        h.handle(
            host,
            18,
            format!("op:102\nrequestId:{request}\nroomId:{rid}\nto:{guest}\ngrant:1\nok:1\n")
                .as_bytes(),
            Bytes::from_static(b"opaque approval"),
        )
        .unwrap();
    }
    #[test]
    fn ready_declares_required_generic_capabilities() {
        let shared = Hub::new(8888);
        let mut h = shared.lock().unwrap();
        let (_, _, identity, _, _) = peer(&mut h);
        assert_eq!(identity["serverVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(
            identity["capabilities"],
            json!([
                "room-sync",
                "room-broadcast",
                "host-grant",
                "room-descriptors"
            ])
        );
    }
    #[test]
    fn broadcast_authorization_targets_expiry_and_rejoin_generation() {
        let shared = Hub::new(8888);
        let mut h = shared.lock().unwrap();
        let (host, _, _, mut hr, _) = peer(&mut h);
        let (a, _, _, mut ar, _) = peer(&mut h);
        let (b, _, _, mut br, _) = peer(&mut h);
        let rid = h
            .command(
                &host,
                "100",
                &json!({"name":"room","roomType":"x","locked":true}),
            )
            .unwrap()["roomId"]
            .as_str()
            .unwrap()
            .to_owned();
        admit(&mut h, &host, &a, &rid);
        admit(&mut h, &host, &b, &rid);
        while hr.try_recv().is_ok() {}
        while ar.try_recv().is_ok() {}
        while br.try_recv().is_ok() {}
        let c = format!("op:201\nroomId:{rid}\nto:{b},{b}\ndiscard:1\nmaxAgeMs:200\ncustom:a:b\n");
        let fields = wire::control(c.as_bytes()).unwrap();
        assert_eq!(
            h.broadcast(&a, &fields, c.as_bytes(), Bytes::from_static(&[0, 255]))
                .unwrap()["delivered"],
            1
        );
        let old = br.try_recv().unwrap();
        assert!(h.output_valid(&old));
        assert_eq!(old.body.as_ref(), &[0, 255]);
        assert!(old.header.ends_with(format!("from:{a}\n").as_bytes()));
        assert!(hr.try_recv().is_err());
        let empty = format!("op:201\nroomId:{rid}\nto:\n");
        assert_eq!(
            h.broadcast(
                &a,
                &wire::control(empty.as_bytes()).unwrap(),
                empty.as_bytes(),
                Bytes::new()
            )
            .unwrap()["delivered"],
            0
        );
        let bad = format!("op:201\nroomId:{rid}\ndiscard:1\nmaxAgeMs:no\n");
        assert!(h
            .broadcast(
                &a,
                &wire::control(bad.as_bytes()).unwrap(),
                bad.as_bytes(),
                Bytes::new()
            )
            .is_err());
        assert!(br.try_recv().is_err());
        assert!(h
            .command(
                &host,
                "103",
                &json!({"roomId":rid,"revoke":[b],"locked":"invalid"})
            )
            .is_err());
        assert!(h.rooms[&rid].authorized.contains_key(&b));
        h.leave(&b, &rid);
        assert!(!h.output_valid(&old));
        admit(&mut h, &host, &b, &rid);
        assert!(!h.output_valid(&old));
        let mut expired = old.clone();
        expired.expires = Some(Instant::now() - Duration::from_millis(1));
        assert!(!h.output_valid(&expired));
        let membership = h.command(&host, "103", &json!({"roomId":rid})).unwrap();
        assert_eq!(membership["members"].as_array().unwrap().len(), 3);
    }
    #[test]
    fn pending_join_cannot_broadcast_or_survive_leave() {
        let shared = Hub::new(8888);
        let mut h = shared.lock().unwrap();
        let (host, _, _, _hr, _) = peer(&mut h);
        let (g, _, _, mut gr, _) = peer(&mut h);
        let rid = h
            .command(&host, "100", &json!({"name":"room","roomType":"x"}))
            .unwrap()["roomId"]
            .as_str()
            .unwrap()
            .to_owned();
        let request = id();
        h.handle(
            &g,
            16,
            format!("op:102\nrequestId:{request}\nroomId:{rid}\n").as_bytes(),
            Bytes::new(),
        )
        .unwrap();
        let c = format!("op:201\nroomId:{rid}\n");
        assert!(h
            .broadcast(
                &g,
                &wire::control(c.as_bytes()).unwrap(),
                c.as_bytes(),
                Bytes::new()
            )
            .is_err());
        h.leave(&g, &rid);
        h.handle(
            &host,
            18,
            format!("op:102\nrequestId:{request}\nroomId:{rid}\nto:{g}\ngrant:1\n").as_bytes(),
            Bytes::new(),
        )
        .unwrap();
        assert!(!h.rooms[&rid].authorized.contains_key(&g));
        assert!(gr.try_recv().is_err());
    }
    #[test]
    fn opaque_admission_many_routes_and_host_leave() {
        let shared = Hub::new(8888);
        let mut h = shared.lock().unwrap();
        let (host, _, _, mut host_rx, _) = peer(&mut h);
        let rid = h
            .command(
                &host,
                "100",
                &json!({"name":"anything","roomType":"custom-module"}),
            )
            .unwrap()["roomId"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut guests = vec![];
        for _ in 0..5 {
            let (user, _, _, rx, _) = peer(&mut h);
            let req = id();
            let header = format!("op:102\nrequestId:{req}\nroomId:{rid}\nextension:a:b\n");
            h.handle(&user, 16, header.as_bytes(), Bytes::from_static(&[0, 255]))
                .unwrap();
            let join = host_rx.try_recv().unwrap();
            assert_eq!(join.body.as_ref(), &[0, 255]);
            assert_eq!(join.header, format!("{header}from:{user}\n"));
            h.handle(
                &host,
                18,
                format!("op:102\nrequestId:{req}\nroomId:{rid}\nto:{user}\nok:1\ngrant:1\n")
                    .as_bytes(),
                Bytes::from_static(b"opaque decision"),
            )
            .unwrap();
            guests.push((user, rx));
        }
        for (_, rx) in &mut guests {
            assert_eq!(rx.try_recv().unwrap().body, b"opaque decision".as_slice());
        }
        let hdr = format!(
            "op:200\nroomId:{rid}\nto:{}\nextra:first\nextra:second\n",
            guests[1].0
        );
        h.handle(
            &guests[0].0,
            16,
            hdr.as_bytes(),
            Bytes::from_static(&[0, 1, 255]),
        )
        .unwrap();
        let m = guests[1].1.try_recv().unwrap();
        assert_eq!(m.kind, 64);
        assert_eq!(m.header, format!("{hdr}from:{}\n", guests[0].0));
        assert_eq!(m.body.as_ref(), &[0, 1, 255]);
        assert!(h
            .handle(
                &guests[0].0,
                16,
                format!("op:200\nroomId:{rid}\nto:{host}\nfrom:{host}\n").as_bytes(),
                Bytes::new()
            )
            .is_err());
        h.leave(&host, &rid);
        assert!(!h.rooms.contains_key(&rid));
        for (user, mut rx) in guests {
            assert!(!h.users[&user].rooms.contains(&rid));
            assert_eq!(
                wire::control(&rx.try_recv().unwrap().header).unwrap()["op"],
                "105"
            );
        }
    }
    #[test]
    fn recovery_replaces_connection_and_heartbeat_expiry_closes_host_room() {
        let shared = Hub::new(8888);
        let mut h = shared.lock().unwrap();
        let (host, generation, identity, _, closed) = peer(&mut h);
        let rid = h
            .command(&host, "100", &json!({"name":"room","roomType":"x"}))
            .unwrap()["roomId"]
            .as_str()
            .unwrap()
            .to_owned();
        let (tx, _rx) = mpsc::channel(32);
        let (close, _closed) = watch::channel(false);
        let (_, next, _) = h.register(&identity, Peer { tx, close }).unwrap();
        assert!(next > generation);
        assert!(*closed.borrow());
        h.disconnect(&host, generation);
        assert!(h.active(&host, next));
        h.users.get_mut(&host).unwrap().heartbeat = Instant::now() - Duration::from_secs(61);
        h.expire();
        assert!(!h.rooms.contains_key(&rid));
        assert!(!h.users.contains_key(&host));
    }
    #[test]
    fn join_timeout_and_udp_ticket_are_transport_only() {
        let shared = Hub::new(8888);
        let mut h = shared.lock().unwrap();
        let (host, _, _, _host_rx, _) = peer(&mut h);
        let (guest, _, _, mut rx, _) = peer(&mut h);
        let rid = h
            .command(&host, "100", &json!({"name":"r","roomType":"x"}))
            .unwrap()["roomId"]
            .as_str()
            .unwrap()
            .to_owned();
        let req = id();
        h.handle(
            &guest,
            16,
            format!("op:102\nrequestId:{req}\nroomId:{rid}\n").as_bytes(),
            Bytes::new(),
        )
        .unwrap();
        h.pending.insert(
            (rid.clone(), guest.clone(), req),
            Instant::now() - Duration::from_secs(31),
        );
        h.expire();
        assert_eq!(
            wire::control(&rx.try_recv().unwrap().header).unwrap()["error"],
            "TIMEOUT"
        );
        // Timed-out transport associations never become approved members.
        assert!(!h.rooms[&rid].routes.contains(&guest));
        let info = h.command(&guest, "210", &json!({})).unwrap();
        let body = encoded(&json!({"clientId":guest,"ticket":info["ticket"]}));
        let frame = wire::plain(16, b"op:210\n", &body).unwrap();
        let addr = "127.0.0.1:54321".parse().unwrap();
        h.udp_register(&frame, addr);
        let event = rx.try_recv().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&event.body).unwrap()["port"],
            54321
        );
        h.udp_register(&frame, addr);
        assert!(rx.try_recv().is_err());
        h.leave(&guest, &rid);
        assert!(!h.rooms[&rid].routes.contains(&guest));
    }
    #[test]
    fn room_descriptors_are_opaque_bounded_and_discoverable() {
        let shared = Hub::new(8888);
        let mut h = shared.lock().unwrap();
        let (host, _, _, _, _) = peer(&mut h);
        let metadata = "arbitrary opaque plugin descriptor";
        h.command(
            &host,
            "100",
            &json!({"name":"plugin","roomType":"module","metadata":metadata}),
        )
        .unwrap();
        let rooms = h.command(&host, "101", &json!({})).unwrap();
        assert_eq!(rooms["rooms"][0]["metadata"], metadata);
        assert_eq!(
            h.command(&host, "101", &json!({"roomType":"other"}))
                .unwrap()["rooms"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert!(h
            .command(
                &host,
                "100",
                &json!({"name":"bad","roomType":"module","metadata":"x".repeat(2049)})
            )
            .is_err());
    }
}
