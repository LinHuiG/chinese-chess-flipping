//! A verified native package runs as an owned child, with bounded private IPC and room-scoped routing.
use crate::{wire, AppState};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager as _;
use tokio::sync::oneshot;
#[derive(Clone, Deserialize, Serialize)]
pub struct Descriptor {
    api: u32,
    kind: String,
    sha256: String,
    size: u64,
    exports: HashMap<String, String>,
    #[serde(default)]
    url: String,
}
impl Descriptor {
    fn validate(&self) -> Result<(), String> {
        if self.api != 1
            || self.kind != "exe"
            || self.size == 0
            || self.size > 200 * 1024 * 1024
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("原生组件描述无效".into());
        }
        Ok(())
    }
}
fn matches(path: &Path, d: &Descriptor) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() != d.size {
        return false;
    }
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => hash.update(&buffer[..n]),
            Err(_) => return false,
        }
    }
    format!("{:x}", hash.finalize()) == d.sha256
}
#[derive(Default)]
struct Scope {
    room: String,
    members: HashSet<String>,
}
struct Session {
    id: String,
    child: Mutex<Child>,
    writer: mpsc::SyncSender<Value>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    foreground: Mutex<Option<(bool, u32)>>,
    exports: HashMap<String, String>,
    next: AtomicU64,
    closed: AtomicBool,
    scope: Mutex<Scope>,
    filters: Mutex<HashSet<String>>,
}
impl Session {
    fn send(&self, value: Value) -> bool {
        !self.closed.load(Ordering::Acquire) && self.writer.try_send(value).is_ok()
    }
    fn stop(&self) {
        self.closed.store(true, Ordering::Release);
        for (_, answer) in self.pending.lock().unwrap().drain() {
            let _ = answer.send(Err("原生组件已停止".into()));
        }
        let _ = self.writer.try_send(json!({"method":"shutdown"}));
        let mut child = self.child.lock().unwrap();
        let deadline = Instant::now() + Duration::from_millis(700);
        while Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}
pub struct Manager {
    directory: PathBuf,
    current: Mutex<Option<Arc<Session>>>,
}
impl Manager {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            current: Mutex::new(None),
        }
    }
    fn path(&self, d: &Descriptor) -> PathBuf {
        self.directory
            .join("components")
            .join(format!("{}.exe", d.sha256))
    }
    pub async fn prepare(&self, d: Descriptor, http: &reqwest::Client) -> Result<Value, String> {
        d.validate()?;
        let path = self.path(&d);
        let copy = d.clone();
        let check = path.clone();
        if tauri::async_runtime::spawn_blocking(move || matches(&check, &copy))
            .await
            .map_err(|_| "组件校验失败")?
        {
            return Ok(json!({"ready":true}));
        }
        let url = reqwest::Url::parse(&d.url).map_err(|_| "原生组件地址无效")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("原生组件地址无效".into());
        }
        fs::create_dir_all(path.parent().unwrap()).map_err(|_| "无法创建组件目录")?;
        let temporary = path.with_extension(format!("{}.part", rand_core::OsRng.next_u64()));
        let result = async {
            let response = http
                .get(url)
                .timeout(Duration::from_secs(150))
                .send()
                .await
                .map_err(|_| "原生组件下载失败")?;
            if !response.status().is_success()
                || response.content_length().is_some_and(|size| size != d.size)
            {
                return Err("原生组件响应无效".into());
            }
            let mut file = fs::File::create(&temporary).map_err(|_| "组件写入失败")?;
            let mut stream = response.bytes_stream();
            let mut hash = Sha256::new();
            let mut size = 0;
            while let Some(bytes) = stream.next().await {
                let bytes = bytes.map_err(|_| "原生组件下载中断")?;
                size += bytes.len() as u64;
                if size > d.size {
                    return Err("原生组件文件过大".into());
                }
                hash.update(&bytes);
                file.write_all(&bytes).map_err(|_| "组件写入失败")?;
            }
            if size != d.size || format!("{:x}", hash.finalize()) != d.sha256 {
                return Err("原生组件完整性校验失败".into());
            }
            file.sync_all().map_err(|_| "组件保存失败")?;
            drop(file);
            if path.exists() {
                if matches(&path, &d) {
                    return Ok(json!({"ready":true}));
                }
                fs::remove_file(&path).map_err(|_| "旧组件文件被占用")?;
            }
            fs::rename(&temporary, &path).map_err(|_| "组件保存失败")?;
            Ok(json!({"ready":true}))
        }
        .await;
        let _ = fs::remove_file(temporary);
        result
    }
    pub fn activate(&self, state: Arc<AppState>, d: Descriptor) -> Result<Value, String> {
        d.validate()?;
        let path = self.path(&d);
        if !matches(&path, &d) {
            return Err("原生组件未安装或文件损坏，请重新安装插件".into());
        }
        self.stop();
        let window = state
            .handle
            .get_webview_window("main")
            .ok_or("宿主窗口已关闭")?;
        let parent = window.hwnd().map_err(|_| "窗口不可用")?.0 as isize;
        let scale = window.scale_factor().unwrap_or(1.);
        let mut command = Command::new(path);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .env_clear();
        for name in [
            "SystemRoot",
            "SystemDrive",
            "WINDIR",
            "TEMP",
            "TMP",
            "LOCALAPPDATA",
            "APPDATA",
            "USERPROFILE",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let mut child = command.spawn().map_err(|_| "原生组件启动失败")?;
        let mut input = child.stdin.take().ok_or("组件输入不可用")?;
        let output = child.stdout.take().ok_or("组件输出不可用")?;
        let (tx, rx) = mpsc::sync_channel(128);
        let session = Arc::new(Session {
            id: rand_core::OsRng.next_u64().to_string(),
            child: Mutex::new(child),
            writer: tx,
            pending: Mutex::new(HashMap::new()),
            foreground: Mutex::new(None),
            exports: d.exports.clone(),
            next: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            scope: Mutex::new(Scope::default()),
            filters: Mutex::new(HashSet::new()),
        });
        let init = json!({"parent":parent as i64,"scale":scale,"directory":self.directory.join("component-data").join(&d.sha256)});
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let weak = Arc::downgrade(&state);
        let reading = session.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            let mut ready = false;
            loop {
                let mut bytes = Vec::new();
                let read = reader
                    .by_ref()
                    .take(8 * 1024 * 1024 + 1)
                    .read_until(b'\n', &mut bytes);
                if read.is_err() || bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
                    break;
                }
                let Ok(q) = serde_json::from_slice::<Value>(&bytes) else {
                    break;
                };
                if q["event"] == "ready" {
                    if q["api"] == 1 && !ready {
                        ready = true;
                        let _ = ready_tx.send(());
                    }
                    continue;
                }
                if reading.closed.load(Ordering::Acquire) {
                    break;
                }
                let Some(state) = weak.upgrade() else {
                    break;
                };
                dispatch(&state, &reading, q);
            }
            if !reading.closed.swap(true, Ordering::AcqRel) {
                for (_, reply) in reading.pending.lock().unwrap().drain() {
                    let _ = reply.send(Err("原生组件已退出".into()));
                }
                if let Some(state) = weak.upgrade() {
                    state.event(json!({"type":"nativeFailure","componentSession":reading.id,"message":"原生组件已退出，请离开后重新进入插件"}));
                }
            }
        });
        std::thread::spawn(move || {
            for q in std::iter::once(init).chain(rx) {
                if serde_json::to_writer(&mut input, &q).is_err()
                    || input.write_all(b"\n").is_err()
                    || input.flush().is_err()
                {
                    break;
                }
            }
        });
        if ready_rx.recv_timeout(Duration::from_secs(8)).is_err() {
            session.stop();
            return Err("原生组件未能就绪".into());
        }
        let id = session.id.clone();
        *self.current.lock().unwrap() = Some(session);
        Ok(json!({"ready":true,"session":id}))
    }
    pub async fn call(&self, q: Value) -> Result<Value, String> {
        let session = self
            .current
            .lock()
            .unwrap()
            .clone()
            .ok_or("原生组件尚未启动")?;
        if let Some(scope) = q.get("scope") {
            let room = scope["roomId"].as_str().unwrap_or("");
            let ids = scope["members"].as_array().ok_or("成员无效")?;
            if !room.is_empty() && !wire::valid_id(room) || ids.len() > 64 {
                return Err("房间作用域无效".into());
            }
            let mut members = HashSet::new();
            for id in ids {
                let id = id
                    .as_str()
                    .filter(|s| wire::valid_id(s))
                    .ok_or("成员标识无效")?;
                members.insert(id.to_owned());
            }
            *session.scope.lock().unwrap() = Scope {
                room: room.into(),
                members,
            };
        }
        let method = q["method"].as_str().ok_or("组件方法无效")?;
        if !session.exports.contains_key(method) {
            return Err("未公开的组件接口".into());
        }
        let id = session.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = session.pending.lock().unwrap();
            if pending.len() >= 128 {
                return Err("原生组件繁忙".into());
            }
            pending.insert(id, tx);
        }
        if !session.send(json!({"id":id,"method":method,"args":q["args"],"scope":q["scope"]})) {
            session.pending.lock().unwrap().remove(&id);
            return Err("原生组件发送失败".into());
        }
        let answer = tokio::time::timeout(Duration::from_secs(10), rx).await;
        session.pending.lock().unwrap().remove(&id);
        answer
            .map_err(|_| "原生组件响应超时")?
            .map_err(|_| "原生组件已结束")?
    }
    pub fn receive(&self, packet: &wire::Packet, peer: Option<&str>) -> bool {
        let Some(session) = self.current.lock().unwrap().clone() else {
            return false;
        };
        let Ok(fields) = packet.fields() else {
            return false;
        };
        if packet.kind != 64
            || !fields
                .get("type")
                .is_some_and(|t| session.filters.lock().unwrap().contains(*t))
        {
            return false;
        }
        let scope = session.scope.lock().unwrap();
        if fields.get("roomId") != Some(&scope.room.as_str())
            || !peer
                .or_else(|| fields.get("from").copied())
                .is_some_and(|id| scope.members.contains(id))
        {
            return true;
        }
        drop(scope);
        if let Ok(bytes) = packet.plain() {
            session.send(json!({"method":"packet","peer":peer,"packet":B64.encode(bytes)}));
        }
        true
    }
    pub fn foreground(&self, value: bool, scale: f64) {
        if let Some(session) = self.current.lock().unwrap().as_ref() {
            let key = (value, (scale * 1000.) as u32);
            let mut last = session.foreground.lock().unwrap();
            if *last != Some(key)
                && session.send(json!({"method":"foreground","value":value,"scale":scale}))
            {
                *last = Some(key);
            }
        }
    }
    pub fn network_changed(&self) {
        if let Some(session) = self.current.lock().unwrap().as_ref() {
            session.send(json!({"method":"networkChanged"}));
        }
    }
    pub fn stop(&self) {
        let session = self.current.lock().unwrap().take();
        if let Some(session) = session {
            session.stop();
        }
    }
}
fn dispatch(state: &AppState, session: &Session, q: Value) {
    if let Some(id) = q["reply"].as_u64() {
        if let Some(answer) = session.pending.lock().unwrap().remove(&id) {
            let result = if let Some(error) = q["error"].as_str() {
                Err(error.into())
            } else {
                Ok(q["value"].clone())
            };
            let _ = answer.send(result);
        }
        return;
    }
    match q["event"].as_str().unwrap_or("") {
        "native" => {
            let mut value = q["value"].clone();
            if let Some(object) = value.as_object_mut() {
                object.insert("componentSession".into(), json!(session.id));
                state.event(value);
            }
        }
        "subscribe" => {
            if let Some(types) = q["types"].as_array() {
                if types.len() <= 16 {
                    *session.filters.lock().unwrap() = types
                        .iter()
                        .filter_map(Value::as_str)
                        .filter(|s| s.len() <= 40)
                        .map(str::to_owned)
                        .collect();
                }
            }
        }
        "send" => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            if now.saturating_sub(q["at"].as_u64().unwrap_or(0)) > 200 {
                return;
            }
            let Some(bytes) = q["packet"]
                .as_str()
                .filter(|s| s.len() <= 100000)
                .and_then(|s| B64.decode(s).ok())
            else {
                return;
            };
            let Ok(packet) = wire::Packet::parse(&bytes) else {
                return;
            };
            let Ok(fields) = packet.fields() else {
                return;
            };
            let scope = session.scope.lock().unwrap();
            if scope.room.is_empty() || fields.get("roomId") != Some(&scope.room.as_str()) {
                return;
            }
            if let Some(peer) = q["peer"].as_str() {
                if !scope.members.contains(peer)
                    || packet.kind != 64
                    || fields.get("to") != Some(&peer)
                    || fields.contains_key("op")
                {
                    return;
                }
                let udp = state.udp.lock().unwrap().clone();
                if !udp.is_some_and(|u| u.send(peer, &packet)) {
                    let control = format!("op:201\n{}", String::from_utf8_lossy(&packet.control));
                    state
                        .network
                        .send(wire::Packet::new(16, control, &packet.body));
                }
            } else {
                if packet.kind != 16
                    || fields.get("op") != Some(&"201")
                    || !fields
                        .get("to")
                        .is_some_and(|to| to.split(',').all(|id| scope.members.contains(id)))
                {
                    return;
                }
                state.network.send(packet);
            }
            session.send(json!({"method":"network","queuedMs":state.network.queued_ms()}));
        }
        _ => {}
    }
}
use rand_core::RngCore;
