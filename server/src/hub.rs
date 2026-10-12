//! 通用房间目录、会话与原样转发；不保存玩法或正式成员审批。
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
}
pub struct Peer {
    pub tx: mpsc::Sender<Output>,
    pub close: watch::Sender<bool>,
}
impl Peer {
    fn send(&self, output: Output) -> Result<(), String> {
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
}
struct Room {
    name: String,
    room_type: String,
    host: String,
    routes: HashSet<String>,
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
            json!({"clientId":user,"token":u.token}),
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
            .send(Output { kind, header, body })
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
            (op == "200" && request.is_empty()) || json::hex_id(request),
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
        }
        u.rate_count += 1;
        ensure(u.rate_count <= 1000, "LIMIT_EXCEEDED")?;
        let result = match (kind, op) {
            (16, "200") => self.relay(user, &fields, c, body).map(|_| Some(json!({}))),
            (16, "102") => self.join(user, &fields, c, body).map(|_| None),
            (18, "102") => {
                self.join_reply(user, &fields, c, body)?;
                return Ok(());
            }
            (16, _) => {
                let hash: [u8; 32] = Sha256::digest([op.as_bytes(), body.as_ref()].concat()).into();
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
                if matches!(op, "100" | "104" | "105") {
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
                let rid = id();
                let routes = HashSet::from([user.to_owned()]);
                self.rooms.insert(
                    rid.clone(),
                    Room {
                        name: name.to_owned(),
                        room_type: room_type.to_owned(),
                        host: user.to_owned(),
                        routes,
                    },
                );
                self.users.get_mut(user).unwrap().rooms.insert(rid.clone());
                Ok(json!({"roomId":rid}))
            }
            "101" => {
                let room_type = json::field(q, "roomType", 128)?;
                let after = q["after"].as_str().unwrap_or("");
                ensure(after.is_empty() || json::hex_id(after), "INVALID_ARGUMENT")?;
                let mut iter = self
                    .rooms
                    .iter()
                    .filter(|(id, r)| id.as_str() > after && r.room_type == room_type);
                let rooms: Vec<_> = iter
                    .by_ref()
                    .take(64)
                    .map(|(id, r)| json!({"roomId":id,"name":r.name,"hostId":r.host}))
                    .collect();
                let next = if iter.next().is_some() {
                    rooms.last().unwrap()["roomId"].clone()
                } else {
                    Value::Null
                };
                Ok(json!({"rooms":rooms,"next":next}))
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
            self.forward(user, target, 18, c, body)?;
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
            room.routes.contains(user) && room.routes.contains(to),
            "TARGET_UNAVAILABLE",
        )?;
        self.forward(user, to, 64, c, body)
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
                format!("op:102\nrequestId:{req}\nroomId:{rid}\nto:{user}\nok:1\n").as_bytes(),
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
        // Timeout cannot decide logical membership; a caller releases its own route.
        assert!(h.rooms[&rid].routes.contains(&guest));
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
}
