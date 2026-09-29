//! 内存业务中心：用户与连接分离；服务器管理房间和直连信令，房主负责棋盘及计时。
//! 调用者短暂持有 Mutex；这里只向有界队列投递，绝不在锁内等待网络 I/O。
use crate::json;
use base64::{engine::general_purpose::STANDARD, Engine};
use bytes::Bytes;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch, Notify},
    time::Instant,
};

// 所有连接共享用户表和房间表。先用简单互斥锁维持状态一致，不预建 Actor/Repository 层。
pub type Shared = Arc<Mutex<Hub>>;
// 随机身份避免时间回拨、同秒启动和多实例碰撞；恢复身份还必须携带独立 token。
pub fn id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
// 控制消息编码一次；广播时仅克隆 Bytes 引用。棋局包体不经过此函数。
pub fn encoded(v: &Value) -> Bytes {
    Bytes::from(serde_json::to_vec(v).expect("JSON value"))
}
// 发送队列保留独立的路由头与包体，共享包体到目标连接，最终封帧由 net/wire 完成。
pub struct Output {
    pub header: Bytes,
    pub body: Bytes,
}
// 连接资源只有有界写队列及关闭信号；用户生命周期不依赖这个对象。
pub struct Peer {
    pub tx: mpsc::Sender<Output>,
    pub close: watch::Sender<bool>,
}
impl Peer {
    // 慢连接队列满时关闭连接，进入正常重连宽限；不能无限堆积快照占用内存。
    fn send(&self, header: Bytes, body: Bytes) {
        if self.tx.try_send(Output { header, body }).is_err() {
            let _ = self.close.send(true);
        }
    }
    // 服务器控制事件使用空路由头，事件内容放在 JSON 包体。
    fn event(&self, value: Value) {
        self.send(Bytes::from_static(b"{}"), encoded(&value));
    }
}
// 逻辑用户可暂时没有 socket。generation 隔离旧连接回调，heartbeat 决定最终过期。
// ready 表示客户端已完成棋面同步；status 区分在线、同步、失联和心跳可疑。昵称不存储。
struct User {
    token: String,
    peer: Option<Peer>,
    generation: u64,
    heartbeat: Instant,
    room: Option<u64>,
    udp: bool,
    ready: bool,
    status: &'static str,
}
// 成员列表首项就是房主；version 在成员/对局切换时递增，阻止旧包进入新棋局。
// game 是本局版本号的字符串，仅在 playing 时非空；不另造 UUID。result 仅保留最近结算供重连读取。
struct Room {
    id: u64,
    name: String,
    members: Vec<String>,
    version: u64,
    game: String,
    start_id: String,
    result: Option<Value>,
    p2p: Option<P2p>,
}
// 一次限时协商的数据：双方登记 token、反射/本地候选、就绪标记。服务器不保存 P2P 密钥。
struct P2p {
    id: String,
    tokens: [String; 2],
    endpoints: [Option<SocketAddr>; 2],
    local: [Vec<Value>; 2],
    ready: [bool; 2],
    configured: bool,
    created: Instant,
    registration: bool,
}
// 只存运行期状态。boot 每次启动随机生成，旧客户端据此丢弃服务器重启前的存档关联。
pub struct Hub {
    users: HashMap<String, User>,
    rooms: BTreeMap<u64, Room>,
    next_room: u64,
    boot: String,
    udp_port: u16,
    punch: HashMap<String, (u64, usize)>,
    pub changed: Arc<Notify>,
}
// 各命令共用的错误返回，便于校验失败时保持原房间并给客户端明确原因。
fn ensure(ok: bool, message: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}
impl Room {
    // 房间事件携带同一上下文；重连不增加版本，成员或对局变化才增加。
    fn context(&self, kind: &str) -> Value {
        json!({"type":kind,"roomId":self.id,"version":self.version,"gameId":self.game})
    }
    // 房主直接取第一名成员；空房间不会保留在 rooms 表中。
    fn host(&self) -> &str {
        &self.members[0]
    }
}
impl Hub {
    // 初始化纯内存服务；没有数据库、恢复文件或定时持久化任务。
    pub fn new(port: u16) -> Shared {
        Arc::new(Mutex::new(Self {
            users: HashMap::new(),
            rooms: BTreeMap::new(),
            next_room: 1,
            boot: id(),
            udp_port: port,
            punch: HashMap::new(),
            changed: Arc::new(Notify::new()),
        }))
    }
    // 先清理已过期用户，再校验 userId/token。有效重连接管连接并保留房间；未知身份重新分配。
    // 旧连接关闭后产生的迟到回调会因 generation 不符被忽略。总用户数含宽限期用户，限制为一万。
    pub fn register(&mut self, meta: &Value, peer: Peer) -> Result<(String, u64), String> {
        ensure(meta["protocol"].as_u64() == Some(2), "请升级客户端至 0.6.0")?;
        self.expire();
        let old = meta["userId"].as_str().unwrap_or("");
        let resume = self
            .users
            .get(old)
            .is_some_and(|u| u.token == meta["token"].as_str().unwrap_or(""));
        ensure(!self.users.contains_key(old) || resume, "重连凭据无效")?;
        ensure(resume || self.users.len() < 10000, "服务器繁忙")?;
        let user = if resume { old.to_owned() } else { id() };
        let u = self.users.entry(user.clone()).or_insert_with(|| User {
            token: format!("{}{}", id(), id()),
            peer: None,
            generation: 0,
            heartbeat: Instant::now(),
            room: None,
            udp: false,
            ready: false,
            status: "syncing",
        });
        if let Some(previous) = u.peer.take() {
            let _ = previous.close.send(true);
        }
        u.generation += 1;
        u.peer = Some(peer);
        u.heartbeat = Instant::now();
        u.ready = false;
        u.status = "syncing";
        u.udp = meta["CHL"] == "ANDROID" && meta["UDP"].as_u64() == Some(1);
        let generation = u.generation;
        let session = json!({"type":"SESSION","selfId":user,"token":u.token,"bootId":self.boot,
            "resumed":resume,"inRoom":u.room.is_some(),"udpPort":self.udp_port,"p2p":u.udp});
        self.event(&user, session);
        if let Some(rid) = self.users[&user].room {
            let mut r = self.rooms.remove(&rid).unwrap();
            self.stop_p2p(&mut r);
            self.event(&user, self.room_value(&r));
            self.broadcast(&r, json!({"type":"PROFILE_REQUEST"}));
            self.presence(&r);
            self.rooms.insert(rid, r);
        }
        self.changed.notify_one();
        Ok((user, generation))
    }
    // 只有当前绑定代次才能处理输入或执行断开清理。
    pub fn active(&self, user: &str, generation: u64) -> bool {
        self.users
            .get(user)
            .is_some_and(|u| u.generation == generation && u.peer.is_some())
    }
    // socket 关闭只解绑、通知灰显、停止旧 P2P；不退出房间、不重置 60 秒期限。
    pub fn disconnect(&mut self, user: &str, generation: u64) {
        if !self.active(user, generation) {
            return;
        }
        let u = self.users.get_mut(user).unwrap();
        u.peer = None;
        u.ready = false;
        u.status = "offline";
        if let Some(rid) = u.room {
            let mut r = self.rooms.remove(&rid).unwrap();
            self.stop_p2p(&mut r);
            self.presence(&r);
            self.rooms.insert(rid, r);
        }
        self.changed.notify_one();
    }
    // 只有应用心跳刷新存活时间；恢复心跳可解除可疑状态，但完成同步前仍不能显示在线。
    pub fn ping(&mut self, user: &str, generation: u64) {
        if !self.active(user, generation) {
            return;
        }
        let u = self.users.get_mut(user).unwrap();
        u.heartbeat = Instant::now();
        let status = if u.ready { "online" } else { "syncing" };
        let changed = u.status != status;
        u.status = status;
        if changed {
            if let Some(r) = u.room.and_then(|id| self.rooms.get(&id)) {
                self.presence(r);
            }
            // 普通心跳只把期限向后推，不必逐包唤醒全局调度；旧期限到达时会重新计算。
            // 从 suspect 恢复则可能把 60 秒期限提前到新的 10 秒检查点，需立即重算。
            self.changed.notify_one();
        }
    }
    // 向指定用户当前连接发送控制事件；离线时不排离线消息，重连后重新同步。
    fn event(&self, user: &str, value: Value) {
        if let Some(peer) = self.users.get(user).and_then(|u| u.peer.as_ref()) {
            peer.event(value);
        }
    }
    // 房间最多两人，共享编码后的控制消息，不为每个成员重复序列化。
    fn broadcast(&self, r: &Room, value: Value) {
        let b = encoded(&value);
        for user in &r.members {
            if let Some(peer) = self.users.get(user).and_then(|u| u.peer.as_ref()) {
                peer.send(Bytes::from_static(b"{}"), b.clone());
            }
        }
    }
    // 临时生成成员状态表，房间自身不维护另一份在线状态。
    fn statuses(&self, r: &Room) -> Value {
        let mut v = json!({});
        for id in &r.members {
            v[id] = self.users.get(id).map_or("offline", |u| u.status).into();
        }
        v
    }
    // 单独推送在线状态，避免一次心跳状态变化触发整份房间重建。
    fn presence(&self, r: &Room) {
        let mut v = r.context("PRESENCE");
        v["presence"] = self.statuses(r);
        self.broadcast(r, v);
    }
    // 只发布房间元数据，不含隐藏棋盘；最近结算用于断线期间结束的对局。
    fn room_value(&self, r: &Room) -> Value {
        let mut v = r.context("ROOM");
        v["name"] = r.name.clone().into();
        v["hostId"] = r.host().into();
        v["members"] = json!(r.members);
        v["playing"] = (!r.game.is_empty()).into();
        v["startId"] = r.start_id.clone().into();
        v["presence"] = self.statuses(r);
        v["p2pAvailable"] = self.capable(r).into();
        if let Some(result) = &r.result {
            v["lastResult"] = result.clone();
        }
        v
    }
    // 成员/对局变化广播房间，并让客户端重新报告昵称，服务器不需要缓存用户名。
    fn room_event(&self, r: &Room) {
        self.broadcast(r, self.room_value(r));
        self.broadcast(r, json!({"type":"PROFILE_REQUEST"}));
    }
    // 仅两名都声明 UDP 能力的 Android 用户可协商直连；Web 始终走中转。
    fn capable(&self, r: &Room) -> bool {
        r.members.len() == 2
            && r.members
                .iter()
                .all(|id| self.users.get(id).is_some_and(|u| u.udp))
    }
    // 控制命令有成功/失败结果；走棋确认由房主按 operationId 回复，服务器不维护转发请求表。
    fn result(&self, user: &str, cmd: &str, error: Option<&str>) {
        self.event(
            user,
            json!({"type":"RESULT","request":cmd,"ok":error.is_none(),"error":error.unwrap_or("")}),
        );
    }
    // 撤销本次登记凭据并通知回退；后续重新协商必须生成新的 ID/token/密钥。
    fn stop_p2p(&mut self, r: &mut Room) {
        if let Some(p) = r.p2p.take() {
            for t in &p.tokens {
                self.punch.remove(t);
            }
            let mut v = r.context("P2P_RELAY");
            v["p2pId"] = p.id.into();
            self.broadcast(r, v);
        }
    }
    // 先广播原对局结算，再推进房间版本回到等待态。完整棋盘与胜负计算仍由房主提供。
    fn end(&mut self, r: &mut Room, winner: &str, reason: &str) {
        let mut result = r.context("GAME_OVER");
        result["winnerId"] = winner.into();
        result["reason"] = reason.into();
        self.broadcast(r, result.clone());
        r.result = Some(result);
        self.stop_p2p(r);
        r.game.clear();
        r.version += 1;
    }
    // 主动退出立即处理；超时退出仅由 expire 调用。房主离开时剩余成员自动成为房主。
    // 双方都已过期则直接清理，不按遍历顺序给其中一方判胜。
    fn leave(&mut self, user: &str, reason: &str) {
        let Some(rid) = self.users.get_mut(user).and_then(|u| u.room.take()) else {
            return;
        };
        let Some(mut r) = self.rooms.remove(&rid) else {
            return;
        };
        if !r.game.is_empty() {
            let other = r
                .members
                .iter()
                .find(|id| id.as_str() != user)
                .cloned()
                .unwrap_or_default();
            let both_expired = reason == "DISCONNECTED"
                && self
                    .users
                    .get(&other)
                    .is_none_or(|u| u.heartbeat.elapsed() >= Duration::from_secs(60));
            if !both_expired {
                self.end(&mut r, &other, reason);
            } else {
                r.game.clear();
            }
        }
        self.stop_p2p(&mut r);
        r.members.retain(|id| id != user);
        r.version += 1;
        if !r.members.is_empty() {
            self.room_event(&r);
            self.rooms.insert(rid, r);
        }
    }
    // 最近期限包括 10 秒心跳可疑、60 秒用户过期、15 秒 P2P 登记窗口。
    pub fn next_deadline(&self) -> Option<Instant> {
        self.users
            .values()
            .map(|u| {
                u.heartbeat
                    + Duration::from_secs(if u.peer.is_some() && u.status != "suspect" {
                        10
                    } else {
                        60
                    })
            })
            .chain(
                self.rooms
                    .values()
                    .filter_map(|r| r.p2p.as_ref())
                    .filter(|p| p.registration)
                    .map(|p| p.created + Duration::from_secs(15)),
            )
            .min()
    }
    // 统一到期扫描：先标记可疑，再处理退出和连接关闭，最后释放过期登记凭据。
    // 直连已建立时只关登记窗口，保留会话元数据以便以后显式停止。
    pub fn expire(&mut self) {
        let mut expired = Vec::new();
        let mut rooms = Vec::new();
        for (id, u) in &mut self.users {
            if u.heartbeat.elapsed() >= Duration::from_secs(60) {
                expired.push(id.clone());
            } else if u.peer.is_some()
                && u.status != "suspect"
                && u.heartbeat.elapsed() >= Duration::from_secs(10)
            {
                u.status = "suspect";
                if let Some(r) = u.room {
                    rooms.push(r);
                }
            }
        }
        for id in &expired {
            self.leave(id, "DISCONNECTED");
        }
        for id in expired {
            if let Some(u) = self.users.remove(&id) {
                if let Some(p) = u.peer {
                    let _ = p.close.send(true);
                }
            }
        }
        for rid in rooms {
            if let Some(r) = self.rooms.get(&rid) {
                self.presence(r);
            }
        }
        let ids: Vec<_> = self
            .rooms
            .iter()
            .filter(|(_, r)| {
                r.p2p.as_ref().is_some_and(|p| {
                    p.registration && p.created.elapsed() >= Duration::from_secs(15)
                })
            })
            .map(|(id, _)| *id)
            .collect();
        for rid in ids {
            let mut r = self.rooms.remove(&rid).unwrap();
            let p = r.p2p.as_mut().unwrap();
            if p.ready.iter().all(|v| *v) {
                p.registration = false;
                for token in &p.tokens {
                    self.punch.remove(token);
                }
            } else {
                self.stop_p2p(&mut r);
            }
            self.rooms.insert(rid, r);
        }
    }
    // Game bytes are never parsed or rebuilt here; identity and context live in the bounded route header.
    // 只校验身份、房间版本、命令方向及大小。actorId 取自绑定用户，忽略客户端自报身份。
    // 包体 Bytes 原样移交目标队列，不解码 JSON；TCP 外层链路仍需解密/再加密，非端到端零拷贝。
    pub fn relay(&self, user: &str, mut header: Value, body: Bytes) -> Result<(), String> {
        ensure(body.len() <= 48000, "棋局消息过大")?;
        let r = self
            .users
            .get(user)
            .and_then(|u| u.room)
            .and_then(|id| self.rooms.get(&id))
            .ok_or("你已不在房间中")?;
        ensure(
            header["roomId"].as_u64() == Some(r.id)
                && header["version"].as_u64() == Some(r.version),
            "房间状态已变化",
        )?;
        let kind = header["type"].as_str().unwrap_or("");
        let target = if kind == "ACTION" {
            r.host().to_owned()
        } else {
            ensure(r.host() == user, "只有房主能同步棋局")?;
            r.members
                .iter()
                .find(|id| id.as_str() != user)
                .cloned()
                .unwrap_or_default()
        };
        if kind == "ACTION" || kind == "HOST_REPLY" {
            ensure(
                header["operationId"].as_str().is_some_and(json::hex_id),
                "操作编号无效",
            )?;
        }
        header["actorId"] = user.into();
        header["gameId"] = r.game.clone().into();
        let peer = self
            .users
            .get(&target)
            .and_then(|u| u.peer.as_ref())
            .ok_or("对方正在重连")?;
        peer.send(encoded(&header), body);
        Ok(())
    }
    // 统一控制命令入口：返回 true 表示还需 RESULT；自行发事件的命令返回 false。
    pub fn handle(&mut self, user: &str, q: Value) {
        let cmd = q["type"].as_str().unwrap_or("");
        match self.command(user, cmd, &q) {
            Ok(true) => self.result(user, cmd, None),
            Ok(false) => {}
            Err(e) => self.result(user, cmd, Some(&e)),
        }
    }
    // 控制命令直接操作用户/房间数据，没有服务层套壳。下半段临时取出房间，校验失败也会放回。
    fn command(&mut self, user: &str, cmd: &str, q: &Value) -> Result<bool, String> {
        let current = self.users[user].room;
        match cmd {
            // 客户端完成状态恢复后报告可操作；连接成功本身不代表棋局已经同步。
            "AVAILABLE" => {
                let u = self.users.get_mut(user).unwrap();
                u.ready = true;
                u.status = "online";
                if let Some(r) = current.and_then(|id| self.rooms.get(&id)) {
                    self.presence(r);
                }
                return Ok(false);
            }
            // 昵称只校验并向当前房间转发，不写用户表，也不落盘。
            "PROFILE" => {
                let name = q["name"].as_str().unwrap_or("").trim();
                ensure(
                    !name.is_empty()
                        && name.chars().count() <= 24
                        && !name.chars().any(char::is_control),
                    "昵称须为 1 至 24 个字符",
                )?;
                if let Some(r) = current.and_then(|id| self.rooms.get(&id)) {
                    self.broadcast(r, json!({"type":"PROFILE","userId":user,"name":name}));
                }
                return Ok(false);
            }
            // 用户主动注销立即退房并废弃身份；和网络断开保留身份的行为区分。
            "LOGOUT" => {
                self.leave(user, "LEFT");
                if let Some(u) = self.users.remove(user) {
                    if let Some(p) = u.peer {
                        let _ = p.close.send(true);
                    }
                }
                return Ok(false);
            }
            // 房间按 ID 游标分页，每次最多 64 条，限制单条响应大小。
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
                    list.push(json!({"id":r.id,"name":r.name,"count":r.members.len(),"playing":!r.game.is_empty()}));
                }
                self.event(user, json!({"type":"ROOMS","rooms":list,"next":next}));
                return Ok(false);
            }
            // 创建或重放创建请求：已有房间就返回原房间，避免回复丢失导致重复创建。
            "CREATE" => {
                // Repeated create after a lost reply just returns the existing room.
                if let Some(r) = current.and_then(|id| self.rooms.get(&id)) {
                    self.event(user, self.room_value(r));
                    return Ok(true);
                }
                let name = q["name"].as_str().unwrap_or("").trim();
                ensure(
                    !name.is_empty()
                        && name.chars().count() <= 32
                        && !name.chars().any(char::is_control),
                    "房间名须为 1 至 32 个字符",
                )?;
                let r = Room {
                    id: self.next_room,
                    name: name.into(),
                    members: vec![user.into()],
                    version: 1,
                    game: String::new(),
                    start_id: String::new(),
                    result: None,
                    p2p: None,
                };
                self.next_room += 1;
                self.users.get_mut(user).unwrap().room = Some(r.id);
                self.room_event(&r);
                self.rooms.insert(r.id, r);
                return Ok(true);
            }
            // 主动离房保留用户身份，可继续在大厅操作。
            "LEAVE" => {
                self.leave(user, "LEFT");
                self.event(user, json!({"type":"ROOM_CLOSED","reason":"LEFT"}));
                return Ok(true);
            }
            // 向请求方返回转发失败信息；不产生另一层请求映射或无限重试。
            "ECHO" => {
                self.event(user, q.clone());
                return Ok(false);
            }
            _ => {}
        }
        // JOIN 指向目标房间；其余命令只能操作绑定用户所在房间，防止任意指定目标。
        let rid = if cmd == "JOIN" {
            q["roomId"].as_u64().ok_or("房间不存在")?
        } else {
            current.ok_or("你已不在房间中")?
        };
        let mut r = self.rooms.remove(&rid).ok_or("房间不存在")?;
        let result = (|| {
            // 加入等待中的房间；重复加入原房间只补发快照。成员变化会递增版本。
            if cmd == "JOIN" {
                if current == Some(rid) {
                    self.event(user, self.room_value(&r));
                    return Ok(true);
                }
                ensure(
                    current.is_none() && r.game.is_empty() && r.members.len() < 2,
                    "房间已满或正在游戏",
                )?;
                self.stop_p2p(&mut r);
                r.members.push(user.into());
                r.version += 1;
                r.result = None;
                self.users.get_mut(user).unwrap().room = Some(rid);
                self.room_event(&r);
                return Ok(true);
            }
            // 开局/结算回复可能丢失；先识别重复请求，不能因此再次开局或重复判负。
            if cmd == "START"
                && r.host() == user
                && !r.game.is_empty()
                && q["operationId"].as_str() == Some(&r.start_id)
            {
                self.event(user, self.room_value(&r));
                return Ok(true);
            }
            if cmd == "FINISH"
                && r.game.is_empty()
                && r.result
                    .as_ref()
                    .is_some_and(|v| v["gameId"] == q["gameId"])
            {
                self.event(user, self.room_value(&r));
                return Ok(true);
            }
            // 所有普通房间命令都必须对应当前代次，旧 socket 中滞留的请求不能改变新房间。
            ensure(
                q["roomId"].as_u64() == Some(rid) && q["version"].as_u64() == Some(r.version),
                "房间状态已变化，请同步",
            )?;
            match cmd {
                // 只有房主能开局，且两人都已同步在线；服务器只分配对局上下文，不生成棋盘。
                "START" => {
                    ensure(
                        r.host() == user
                            && r.game.is_empty()
                            && r.members.len() == 2
                            && r.members
                                .iter()
                                .all(|id| self.users[id].ready && self.users[id].peer.is_some()),
                        "开局条件已变化",
                    )?;
                    let op = q["operationId"]
                        .as_str()
                        .filter(|s| json::hex_id(s))
                        .ok_or("开局编号无效")?;
                    self.stop_p2p(&mut r);
                    r.version += 1;
                    r.game = r.version.to_string();
                    r.start_id = op.into();
                    r.result = None;
                    self.room_event(&r);
                }
                // 接受当前房主的结算结果，并限制赢家和原因范围；不重复执行客户端棋规。
                "FINISH" => {
                    ensure(
                        r.host() == user && !r.game.is_empty(),
                        "对局已结束或房主变化",
                    )?;
                    let winner = q["winnerId"].as_str().unwrap_or("");
                    let reason = q["reason"].as_str().unwrap_or("");
                    ensure(
                        r.members.iter().any(|id| id == winner)
                            && matches!(
                                reason,
                                "TIMEOUT" | "NO_PIECES" | "NO_MOVES" | "RESTORE_FAILED"
                            ),
                        "结算无效",
                    )?;
                    self.end(&mut r, winner, reason);
                    self.room_event(&r);
                }
                // 房主主动解散：进行中的棋局按认输处理，再清除所有成员的房间关联。
                "DISSOLVE" => {
                    ensure(r.host() == user, "只有房主能解散")?;
                    if !r.game.is_empty() {
                        let winner = r.members[1].clone();
                        self.end(&mut r, &winner, "HOST_DISSOLVED");
                    }
                    self.stop_p2p(&mut r);
                    for id in r.members.drain(..) {
                        self.users.get_mut(&id).unwrap().room = None;
                        self.event(&id, json!({"type":"ROOM_CLOSED","reason":"DISSOLVED"}));
                    }
                }
                // 任意一方可触发协商，已有协商则幂等返回；邀请房主生成一次性主密钥。
                "P2P_REQUEST" => {
                    ensure(
                        !r.game.is_empty()
                            && self.capable(&r)
                            && r.members
                                .iter()
                                .all(|id| self.users[id].ready && self.users[id].peer.is_some()),
                        "当前不能直连",
                    )?;
                    if r.p2p.is_some() {
                        return Ok(true);
                    }
                    let p = P2p {
                        id: id(),
                        tokens: [id(), id()],
                        endpoints: [None, None],
                        local: [vec![], vec![]],
                        ready: [false, false],
                        configured: false,
                        created: Instant::now(),
                        registration: true,
                    };
                    let mut v = r.context("P2P_OFFER");
                    v["p2pId"] = p.id.clone().into();
                    self.event(r.host(), v);
                    r.p2p = Some(p);
                    self.changed.notify_one();
                }
                // 校验房主给出的 32 字节密钥并转发，两人获得不同的 UDP 登记 token。密钥不存入 Hub。
                "P2P_KEY" => {
                    ensure(r.host() == user, "只有房主能分发密钥")?;
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
                        self.punch.insert(token.clone(), (rid, i));
                        let mut v = r.context("P2P_CONFIG");
                        v["p2pId"] = sid.clone().into();
                        v["token"] = token.clone().into();
                        v["key"] = key.into();
                        v["udpPort"] = self.udp_port.into();
                        v["peerId"] = r.members[1 - i].clone().into();
                        self.event(&r.members[i], v);
                    }
                }
                // 分别收集本地 IPv4/全局 IPv6 候选，限制地址数量和端口。无需等双方 IPv4 登记完成。
                "P2P_LOCAL" => {
                    let i = r.members.iter().position(|id| id == user).unwrap();
                    let p = r.p2p.as_mut().ok_or("直连已失效")?;
                    ensure(
                        q["p2pId"].as_str() == Some(&p.id) && p.registration,
                        "直连已失效",
                    )?;
                    if let Some(a) = q["candidates"].as_array() {
                        p.local[i] = a
                            .iter()
                            .take(8)
                            .filter(|v| {
                                v["host"]
                                    .as_str()
                                    .and_then(|s| s.parse::<std::net::IpAddr>().ok())
                                    .is_some_and(|a| {
                                        !a.is_loopback() && !a.is_unspecified() && !a.is_multicast()
                                    })
                                    && v["port"].as_u64().is_some_and(|n| n > 0 && n <= 65535)
                            })
                            .cloned()
                            .collect();
                    }
                    self.peer_endpoints(&r);
                }
                // 双方各自确认双向认证探测成功后才激活；单方收到包不能说明路径可用于对战。
                "P2P_READY" => {
                    let i = r.members.iter().position(|id| id == user).unwrap();
                    let p = r.p2p.as_mut().ok_or("直连已失效")?;
                    ensure(
                        q["p2pId"].as_str() == Some(&p.id) && p.configured,
                        "直连已失效",
                    )?;
                    let was = p.ready.iter().all(|v| *v);
                    p.ready[i] = true;
                    if !was && p.ready.iter().all(|v| *v) {
                        let sid = p.id.clone();
                        let mut v = r.context("P2P_ACTIVE");
                        v["p2pId"] = sid.into();
                        self.broadcast(&r, v);
                    }
                }
                // 只停止匹配的协商 ID，迟到的停止包不能撤销新的直连尝试。
                "P2P_STOP" => {
                    if r.p2p
                        .as_ref()
                        .is_some_and(|p| q["p2pId"].as_str() == Some(&p.id))
                    {
                        self.stop_p2p(&mut r);
                    }
                }
                _ => return Err("未知请求，请升级客户端".into()),
            }
            Ok(true)
        })();
        if !r.members.is_empty() {
            self.rooms.insert(rid, r);
        }
        result
    }
    // 每方有候选就立即交换；本地 IPv6 可以经 IPv4 控制连接交给对端，服务端无须先有 IPv6。
    fn peer_endpoints(&self, r: &Room) {
        let Some(p) = &r.p2p else {
            return;
        };
        for i in 0..2 {
            let mut candidates = p.local[1 - i].clone();
            if let Some(e) = p.endpoints[1 - i] {
                candidates.push(json!({"host":e.ip().to_string(),"port":e.port()}));
            }
            if candidates.is_empty() {
                continue;
            }
            let mut v = r.context("P2P_PEER");
            v["p2pId"] = p.id.clone().into();
            v["candidates"] = candidates.into();
            self.event(&r.members[i], v);
        }
    }
    // 固定 36 字节 CFU1 + 会话 ID + token；只接受窗口内凭据。
    // 同一凭据源地址变化时更新反射候选，但不做 NAT 类型推断，也不记录地址日志。
    pub fn udp_register(&mut self, b: &[u8], addr: SocketAddr) {
        if b.len() != 36 || &b[..4] != b"CFU1" {
            return;
        }
        let token = uuid::Uuid::from_slice(&b[20..])
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
                && p.registration
                && p.created.elapsed() < Duration::from_secs(15)
                && p.endpoints[i] != Some(addr)
            {
                p.endpoints[i] = Some(addr);
                self.peer_endpoints(&r);
            }
        }
        self.rooms.insert(rid, r);
    }
}

// 定向验证会话生命周期、包体透传和 IPv6 候选交换，不依赖外部服务器或真实等待 60 秒。
#[cfg(test)]
mod tests {
    use super::*;
    // 每个虚拟连接保留接收端，和生产的有界队列一致。
    fn peer() -> (Peer, mpsc::Receiver<Output>) {
        let (tx, rx) = mpsc::channel(32);
        let (close, _) = watch::channel(false);
        (Peer { tx, close }, rx)
    }
    // 从队列取出本次所有控制事件，测试只检查相关类型。
    fn events(rx: &mut mpsc::Receiver<Output>) -> Vec<Value> {
        let mut result = vec![];
        while let Ok(value) = rx.try_recv() {
            result.push(serde_json::from_slice(&value.body).unwrap());
        }
        result
    }
    // 断开保留房间，接管后旧代次失效；重新连接本身不递增房间版本。
    #[test]
    fn resume_and_old_close() {
        let shared = Hub::new(8888);
        let mut h = shared.lock().unwrap();
        let (p, mut rx) = peer();
        let (user, g) = h.register(&json!({"protocol":2}), p).unwrap();
        let token = h.users[&user].token.clone();
        h.handle(&user, json!({"type":"CREATE","name":"test"}));
        let rid = h.users[&user].room.unwrap();
        h.disconnect(&user, g);
        assert_eq!(h.rooms[&rid].version, 1);
        assert_eq!(h.users[&user].status, "offline");
        let (p, mut new) = peer();
        let (resumed, next) = h
            .register(&json!({"protocol":2,"userId":user,"token":token}), p)
            .unwrap();
        assert_eq!(resumed, user);
        assert!(next > g);
        h.disconnect(&user, g);
        assert!(h.active(&user, next));
        assert!(events(&mut new)
            .iter()
            .any(|v| v["type"] == "SESSION" && v["resumed"] == true));
        let (p, _rx) = peer();
        assert!(h
            .register(&json!({"protocol":2,"userId":user,"token":"wrong"}), p)
            .is_err());
        events(&mut rx);
    }
    // 最后心跳 60 秒过期，不能因 socket 刚关闭而额外延长；同时过期的两人不互相判胜。
    #[test]
    fn heartbeat_expiry_and_restart() {
        let shared = Hub::new(8888);
        let mut h = shared.lock().unwrap();
        let (p, _a) = peer();
        let (a, g) = h.register(&json!({"protocol":2}), p).unwrap();
        let (p, _b) = peer();
        let (b, _) = h.register(&json!({"protocol":2}), p).unwrap();
        h.handle(&a, json!({"type":"CREATE","name":"test"}));
        h.handle(&b, json!({"type":"JOIN","roomId":1}));
        h.rooms.get_mut(&1).unwrap().game = "2".into();
        for u in h.users.values_mut() {
            u.heartbeat = Instant::now() - Duration::from_secs(59);
        }
        h.disconnect(&a, g);
        h.expire();
        assert_eq!(h.users.len(), 2);
        let token = h.users[&a].token.clone();
        let boot = h.boot.clone();
        for u in h.users.values_mut() {
            u.heartbeat = Instant::now() - Duration::from_secs(60);
        }
        h.expire();
        assert!(h.users.is_empty());
        assert!(h.rooms.is_empty());
        let fresh = Hub::new(8888);
        let mut fresh = fresh.lock().unwrap();
        let (p, mut rx) = peer();
        let (user, _) = fresh
            .register(&json!({"protocol":2,"userId":a,"token":token}), p)
            .unwrap();
        assert_ne!(user, a);
        assert_ne!(fresh.boot, boot);
        assert_eq!(events(&mut rx)[0]["resumed"], false);
    }
    // 非 JSON 字节也能中转，且正文共享原始分配；服务端重写 actor、拒绝旧代次和非房主状态。
    #[test]
    fn opaque_relay_and_permissions() {
        let shared = Hub::new(8888);
        let mut h = shared.lock().unwrap();
        let (p, mut rx) = peer();
        let (a, _) = h.register(&json!({"protocol":2}), p).unwrap();
        let (p, mut other) = peer();
        let (b, _) = h.register(&json!({"protocol":2}), p).unwrap();
        h.handle(&a, json!({"type":"CREATE","name":"test"}));
        h.handle(&b, json!({"type":"JOIN","roomId":1}));
        events(&mut rx);
        events(&mut other);
        let body = Bytes::from(vec![0xff, 0, 1, 2]);
        let route =
            json!({"type":"ACTION","roomId":1,"version":2,"operationId":id(),"actorId":"forged"});
        h.relay(&b, route.clone(), body.clone()).unwrap();
        let out = rx.try_recv().unwrap();
        assert_eq!(body.as_ptr(), out.body.as_ptr());
        assert_eq!(json::object(&out.header).unwrap()["actorId"], b);
        let mut old = route;
        old["version"] = 1.into();
        assert!(h.relay(&b, old, body.clone()).is_err());
        assert!(h
            .relay(
                &b,
                json!({"type":"HOST_STATE","roomId":1,"version":2}),
                body
            )
            .is_err());
    }
    // 两人都未向服务器登记 UDP 时，也可交换全局 IPv6 地址。
    #[test]
    fn ipv6_candidates_without_reflection() {
        let shared = Hub::new(8888);
        let mut h = shared.lock().unwrap();
        let meta = json!({"protocol":2,"CHL":"ANDROID","UDP":1});
        let (p, mut ar) = peer();
        let (a, _) = h.register(&meta, p).unwrap();
        let (p, mut br) = peer();
        let (b, _) = h.register(&meta, p).unwrap();
        h.handle(&a, json!({"type":"CREATE","name":"test"}));
        h.handle(&b, json!({"type":"JOIN","roomId":1}));
        h.handle(&a, json!({"type":"AVAILABLE"}));
        h.handle(&b, json!({"type":"AVAILABLE"}));
        h.handle(
            &a,
            json!({"type":"START","roomId":1,"version":2,"operationId":id()}),
        );
        events(&mut ar);
        events(&mut br);
        h.handle(&b, json!({"type":"P2P_REQUEST","roomId":1,"version":3}));
        let sid = h.rooms[&1].p2p.as_ref().unwrap().id.clone();
        h.handle(&a,json!({"type":"P2P_LOCAL","roomId":1,"version":3,"p2pId":sid,"candidates":[{"host":"2001:db8::1","port":9999}]}));
        assert!(events(&mut br)
            .iter()
            .any(|v| v["type"] == "P2P_PEER" && v["candidates"][0]["host"] == "2001:db8::1"));
        assert!(h.rooms[&1]
            .p2p
            .as_ref()
            .unwrap()
            .endpoints
            .iter()
            .all(Option::is_none));
    }
}
