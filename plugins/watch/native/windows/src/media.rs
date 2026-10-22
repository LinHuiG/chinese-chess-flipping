//! Windows libmpv viewport. URLs stay in-process; the DLL never reads user mpv
//! configuration, scripts, cookies or account headers. Only the approved Emby
//! origin may initiate a load; ordinary media redirects may reach a CDN.
use crate::AppState;
use libloading::Library;
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashMap, VecDeque},
    ffi::{c_char, c_int, c_void, CStr, CString},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicIsize, Ordering},
        mpsc, Arc, Condvar, Mutex, Weak,
    },
    time::{Duration, Instant},
};

extern "C" {
    fn cyber_media_window_create(parent: *mut c_void) -> *mut c_void;
    fn cyber_media_window_bounds(
        window: *mut c_void,
        x: c_int,
        y: c_int,
        width: c_int,
        height: c_int,
        clip_height: c_int,
        visible: c_int,
        ex: c_int, ey: c_int, ew: c_int, eh: c_int,
    );
    fn cyber_media_interaction(window: *mut c_void) -> c_int;
    fn cyber_media_window_hide(window: *mut c_void);
    fn cyber_media_window_visible(window: *mut c_void);
    fn cyber_media_window_destroy(window: *mut c_void);
    fn cyber_media_danmaku_supported(window: *mut c_void) -> c_int;
    fn cyber_media_danmaku_add(window: *mut c_void, id: *const u16, text: *const u16) -> c_int;
    fn cyber_media_danmaku_clear(window: *mut c_void);
}
enum Action {
    Command(Value),
    Foreground(bool),
    Stop,
    Shutdown,
}
// One latest control snapshot replaces a queue of stale slider positions. Stop
// and shutdown are priority flags, so a slow decoder never blocks the UI caller.
#[derive(Default)]
struct Pending {
    playback_id: Option<String>,
    command: serde_json::Map<String, Value>,
    bullets: VecDeque<Value>,
    foreground: Option<bool>,
    stop: bool,
    shutdown: bool,
}
#[derive(Default)]
struct Mailbox {
    pending: Mutex<Pending>,
    wake: Condvar,
}
impl Mailbox {
    fn push(&self, action: Action) {
        let mut pending = self.pending.lock().unwrap();
        if pending.shutdown {
            return;
        }
        match action {
            Action::Command(value) => {
                if let Some(mut fields) = value.as_object().cloned() {
                    if fields.contains_key("url") {
                        pending.command.clear();
                        pending.playback_id = fields.get("playbackId").and_then(Value::as_str).map(str::to_owned);
                    } else if fields.get("playbackId").and_then(Value::as_str).is_some_and(|id| {
                        pending.playback_id.as_deref().is_some_and(|current| id != current)
                    }) {
                        // Late subtitle/download callbacks must not overwrite a newer
                        // load's identity while the worker is still decoding.
                        return;
                    }
                    fields.retain(|key, _| {
                        matches!(
                            key.as_str(),
                            "url"
                                | "playbackId"
                                | "seekId"
                                | "positionMs"
                                | "playing"
                                | "rate"
                                | "volume"
                                | "muted"
                                | "subtitleCues"
                                | "subtitleOffsetMs"
                                | "mediaTracks"
                                | "audioStreamIndex"
                                | "subtitleStreamIndex"
                                | "danmaku"
                        )
                    });
                    if let Some(bullet) = fields.remove("danmaku") {
                        if pending.bullets.len() == 30 {
                            pending.bullets.pop_front();
                        }
                        pending.bullets.push_back(bullet);
                    }
                    pending.command.extend(fields);
                }
            }
            Action::Foreground(value) => pending.foreground = Some(value),
            Action::Stop => {
                pending.command.clear();
                pending.bullets.clear();
                pending.stop = true;
            }
            Action::Shutdown => {
                pending.command.clear();
                pending.bullets.clear();
                pending.shutdown = true;
            }
        }
        self.wake.notify_one();
    }
    fn receive(&self, timeout: Duration) -> Option<Action> {
        let pending = self.pending.lock().unwrap();
        let (mut pending, _) = self
            .wake
            .wait_timeout_while(pending, timeout, |p| {
                !p.shutdown
                    && !p.stop
                    && p.foreground.is_none()
                    && p.command.is_empty()
                    && p.bullets.is_empty()
            })
            .unwrap();
        if pending.shutdown {
            return Some(Action::Shutdown);
        }
        if pending.stop {
            pending.stop = false;
            return Some(Action::Stop);
        }
        if let Some(value) = pending.foreground.take() {
            return Some(Action::Foreground(value));
        }
        if !pending.command.is_empty() {
            return Some(Action::Command(Value::Object(std::mem::take(
                &mut pending.command,
            ))));
        }
        pending
            .bullets
            .pop_front()
            .map(|bullet| Action::Command(json!({"danmaku":bullet})))
    }
}
pub struct Media {
    state: Weak<AppState>,
    directory: PathBuf,
    sender: Mutex<Option<Arc<Mailbox>>>,
    hwnd: AtomicIsize,
    visible: AtomicBool,
    foreground: AtomicBool,
    compositor: AtomicBool,
}
impl Media {
    pub fn new(state: Weak<AppState>, directory: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            state,
            directory,
            sender: Mutex::new(None),
            hwnd: AtomicIsize::new(0),
            visible: AtomicBool::new(false),
            foreground: AtomicBool::new(true),
            compositor: AtomicBool::new(false),
        })
    }
    fn emit(&self, value: Value) {
        if let Some(s) = self.state.upgrade() {
            s.event(value)
        }
    }
    fn start(self: &Arc<Self>) -> Result<(), String> {
        let mut sender = self.sender.lock().unwrap();
        if sender.is_some() {
            return Ok(());
        }
        let s = self.state.upgrade().ok_or("窗口已经关闭")?;
        let window = s.handle.get_webview_window("main").ok_or("窗口尚未就绪")?;
        let parent = window.hwnd().map_err(|_| "无法取得播放窗口")?.0;
        let (answer, receive) = mpsc::sync_channel(1);
        window
            .run_on_main_thread(move || {
                let hwnd = unsafe { cyber_media_window_create(parent as *mut c_void) };
                let supported =
                    !hwnd.is_null() && unsafe { cyber_media_danmaku_supported(hwnd) } != 0;
                let _ = answer.send((hwnd as isize, supported));
            })
            .map_err(|_| "无法创建播放窗口")?;
        let (hwnd, compositor) = receive
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "播放窗口创建超时")?;
        if hwnd == 0 {
            return Err("无法创建播放窗口".into());
        }
        self.hwnd.store(hwnd, Ordering::Release);
        self.compositor.store(compositor, Ordering::Release);
        let mailbox = Arc::new(Mailbox::default());
        let rx = mailbox.clone();
        let owner = self.clone();
        std::thread::Builder::new().name("cyber-player".into()).spawn(move||{
            let result=Player::open(&owner.directory,hwnd,compositor).map(|mut player|{
                let mut last=Instant::now();
                loop {
                    match rx.receive(Duration::from_millis(30)) {
                        Some(Action::Command(value))=>if let Err(error)=player.command(value){player.error=error;owner.emit(player.state());},
                        Some(Action::Foreground(value))=>{player.foreground=value;if !value{let _=player.mpv.set("pause","yes");}},
                        Some(Action::Stop)=>{player.stop();},
                        Some(Action::Shutdown)=>break,
                        None=>{}
                    }
                    player.events();
                    player.overlay();
                    if unsafe { cyber_media_interaction(hwnd as *mut c_void) } != 0 {owner.emit(json!({"type":"playerInteraction"}));}
                    if last.elapsed()>=Duration::from_millis(250){owner.emit(player.state());last=Instant::now();}
                }
            });
            if let Err(error)=result{owner.emit(json!({"type":"player","error":error,"playing":false,"nativeUnavailable":true}));}
            if let Some(s)=owner.state.upgrade(){if let Some(w)=s.handle.get_webview_window("main"){let _=w.run_on_main_thread(move||unsafe{cyber_media_window_destroy(hwnd as *mut c_void)});}}
            owner.hwnd.store(0,Ordering::Release);
            owner.sender.lock().unwrap().take();
        }).map_err(|_|"无法启动播放器线程")?;
        *sender = Some(mailbox);
        Ok(())
    }
    pub fn command(self: &Arc<Self>, mut value: Value) -> Result<(), String> {
        validate_command(&value)?;
        // Empty rooms use HTML overlays. A first media URL supplies the complete
        // playback settings, so layout/volume updates must not unpack/start mpv.
        if value.get("url").and_then(Value::as_str).is_none()
            && self.sender.lock().unwrap().is_none()
        {
            return Ok(());
        }
        if let Some(raw) = value.get("url").and_then(Value::as_str) {
            let url = reqwest::Url::parse(raw).map_err(|_| "电影地址无效")?;
            let s = self.state.upgrade().ok_or("窗口已经关闭")?;
            if !crate::media_target_allowed(s.media_origin.lock().unwrap().as_ref(), &url) {
                return Err("电影必须使用已配置的片源地址".into());
            }
        }
        self.start()?;
        if let Some(visible) = value.get("visible").and_then(Value::as_bool) {
            self.visible.store(visible, Ordering::Release);
            if !visible {
                self.hide();
            } else if value.get("bounds").is_none() && self.foreground.load(Ordering::Acquire) {
                let hwnd = self.hwnd.load(Ordering::Acquire);
                if let Some(s) = self.state.upgrade() {
                    if let Some(w) = s.handle.get_webview_window("main") {
                        let _ = w.run_on_main_thread(move || unsafe {
                            if hwnd != 0 {
                                cyber_media_window_visible(hwnd as *mut c_void)
                            }
                        });
                    }
                }
            }
        }
        if let Some(bounds) = value.get("bounds") {
            self.bounds(bounds)?;
        }
        if self.compositor.load(Ordering::Acquire) {
            if let Some(bullet) = value.as_object_mut().and_then(|v| v.remove("danmaku")) {
                let clean = |key: &str, limit| {
                    bullet[key]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .filter(|c| !c.is_control())
                        .take(limit)
                        .collect::<String>()
                };
                let id: Vec<u16> = clean("id", 160).encode_utf16().chain(Some(0)).collect();
                let text: Vec<u16> = clean("text", 240).encode_utf16().chain(Some(0)).collect();
                let owner = self.clone();
                let hwnd = self.hwnd.load(Ordering::Acquire);
                if let Some(s) = self.state.upgrade() {
                    if let Some(window) = s.handle.get_webview_window("main") {
                        window
                            .run_on_main_thread(move || {
                                if unsafe {
                                    cyber_media_danmaku_add(
                                        hwnd as *mut c_void,
                                        id.as_ptr(),
                                        text.as_ptr(),
                                    )
                                } == 0
                                {
                                    // GPU/device failure keeps the bounded ASS fallback available.
                                    let _ = owner.send(Action::Command(json!({"danmaku":bullet})));
                                }
                            })
                            .map_err(|_| "弹幕显示失败")?;
                    }
                }
            }
        }
        self.send(Action::Command(value))
    }
    fn bounds(&self, bounds: &Value) -> Result<(), String> {
        let Some(s) = self.state.upgrade() else {
            return Ok(());
        };
        let Some(w) = s.handle.get_webview_window("main") else {
            return Ok(());
        };
        let scale = w.scale_factor().unwrap_or(1.);
        let physical = |key: &str, minimum: i32| {
            ((bounds[key].as_f64().unwrap_or(0.) * scale).round() as i32).clamp(minimum, 32768)
        };
        let (x, y, width, height) = (
            physical("x", -32768),
            physical("y", -32768),
            physical("width", 1),
            physical("height", 1),
        );
        let clip_height = if bounds.get("clipHeight").is_some() { physical("clipHeight", 0).min(height) } else { height };
        let exclusion = &bounds["exclusion"];
        let edge = |key: &str| ((exclusion[key].as_f64().unwrap_or(0.) * scale).round() as i32).clamp(-32768, 32768);
        let (ex, ey, ew, eh) = (edge("x"), edge("y"), edge("width").max(0), edge("height").max(0));
        let visible =
            self.visible.load(Ordering::Acquire) && self.foreground.load(Ordering::Acquire);
        let hwnd = self.hwnd.load(Ordering::Acquire);
        w.run_on_main_thread(move || unsafe {
            if hwnd != 0 {
                cyber_media_window_bounds(hwnd as *mut c_void, x, y, width, height, clip_height, visible as i32, ex, ey, ew, eh)
            }
        })
        .map_err(|_| "播放器尺寸更新失败".into())
    }
    fn send(&self, action: Action) -> Result<(), String> {
        if let Some(sender) = self.sender.lock().unwrap().as_ref() {
            sender.push(action);
        }
        Ok(())
    }
    pub fn foreground(&self, value: bool) {
        if self.foreground.swap(value, Ordering::AcqRel) == value {
            return;
        }
        let _ = self.send(Action::Foreground(value));
        if !value {
            self.hide()
        }
    }
    fn hide(&self) {
        let hwnd = self.hwnd.load(Ordering::Acquire);
        if hwnd == 0 {
            return;
        }
        if let Some(s) = self.state.upgrade() {
            if let Some(w) = s.handle.get_webview_window("main") {
                let _ = w.run_on_main_thread(move || unsafe {
                    cyber_media_window_hide(hwnd as *mut c_void)
                });
            }
        }
    }
    pub fn stop(&self) {
        self.visible.store(false, Ordering::Release);
        self.hide();
        let hwnd = self.hwnd.load(Ordering::Acquire);
        if let Some(s) = self.state.upgrade() {
            if let Some(window) = s.handle.get_webview_window("main") {
                let _ = window.run_on_main_thread(move || unsafe {
                    cyber_media_danmaku_clear(hwnd as *mut c_void);
                });
            }
        }
        // Revocation has priority and never waits for decoder/network progress.
        if let Some(sender) = self.sender.lock().unwrap().as_ref() {
            sender.push(Action::Stop);
        }
    }
    pub fn shutdown(&self) {
        self.hide();
        if let Some(sender) = self.sender.lock().unwrap().take() {
            sender.push(Action::Shutdown);
        }
    }
}

fn validate_command(value: &Value) -> Result<(), String> {
    if !value.is_object() || value.to_string().len() > 4_194_304 {
        return Err("播放参数过大".into());
    }
    for key in ["playbackId", "seekId"] {
        if value
            .get(key)
            .is_some_and(|v| !v.as_str().is_some_and(|s| s.len() <= 160))
        {
            return Err("播放代次无效".into());
        }
    }
    for key in ["rate", "volume", "positionMs", "subtitleOffsetMs"] {
        if let Some(v) = value.get(key) {
            if !v.as_f64().is_some_and(f64::is_finite) {
                return Err("播放参数无效".into());
            }
        }
    }
    if let Some(b) = value.get("bounds") {
        for key in ["x", "y", "width", "height"] {
            if !b[key]
                .as_f64()
                .is_some_and(|x| x.is_finite() && x.abs() <= 32768.)
            {
                return Err("播放区域无效".into());
            }
        }
    }
    if let Some(cues) = value.get("subtitleCues") {
        let cues = cues.as_array().ok_or("字幕格式无效")?;
        if cues.len() > 10_000 {
            return Err("字幕条目过多".into());
        }
        for c in cues {
            if !c["start"]
                .as_f64()
                .is_some_and(|x| x.is_finite() && x >= 0.)
                || !c["end"]
                    .as_f64()
                    .is_some_and(|x| x.is_finite() && x > c["start"].as_f64().unwrap_or(0.))
                || !c["text"]
                    .as_str()
                    .is_some_and(|s| s.encode_utf16().count() <= 8192)
            {
                return Err("字幕格式无效".into());
            }
        }
    }
    Ok(())
}
use crate::media_runtime::library_path;

#[repr(C)]
struct Event {
    id: c_int,
    error: c_int,
    userdata: u64,
    data: *mut c_void,
}
#[repr(C)]
struct Node {
    value: NodeValue,
    format: c_int,
}
#[repr(C)]
union NodeValue {
    string: *mut c_char,
    flag: c_int,
    integer: i64,
    double: f64,
    list: *mut NodeList,
}
#[repr(C)]
struct NodeList {
    num: c_int,
    values: *mut Node,
    keys: *mut *mut c_char,
}
struct Mpv {
    _library: Library,
    handle: *mut c_void,
    terminate: unsafe extern "C" fn(*mut c_void),
    option: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int,
    observe: unsafe extern "C" fn(*mut c_void, u64, *const c_char, c_int) -> c_int,
    query: unsafe extern "C" fn(*mut c_void, u64, *const c_char, c_int) -> c_int,
    properties: RefCell<HashMap<String, Value>>,
    updates: RefCell<BTreeMap<String, String>>,
    setting: Cell<bool>,
    command_async: unsafe extern "C" fn(*mut c_void, u64, *const *const c_char) -> c_int,
    wait_event: unsafe extern "C" fn(*mut c_void, f64) -> *mut Event,
}
impl Mpv {
    fn open(path: &Path, hwnd: isize) -> Result<Self, String> {
        unsafe {
            use libloading::os::windows::Library as WindowsLibrary;
            // std canonicalization supplies the extended Windows path prefix.
            // Plugin/cache directories can exceed MAX_PATH even in a normal user profile.
            let absolute = std::fs::canonicalize(path).map_err(|_| "播放器运行库路径不可用")?;
            let library: Library =
                WindowsLibrary::load_with_flags(absolute, 0x00000100 | 0x00000800)
                    .map_err(|_| "无法载入原生播放器运行库")?
                    .into();
            macro_rules! symbol {
                ($name:literal) => {
                    *library
                        .get(concat!($name, "\0").as_bytes())
                        .map_err(|_| "播放器接口版本不匹配")?
                };
            }
            let create: unsafe extern "C" fn() -> *mut c_void = symbol!("mpv_create");
            let initialize: unsafe extern "C" fn(*mut c_void) -> c_int = symbol!("mpv_initialize");
            let handle = create();
            if handle.is_null() {
                return Err("原生播放器初始化失败".into());
            }
            let api = Self {
                terminate: symbol!("mpv_terminate_destroy"),
                option: symbol!("mpv_set_option_string"),
                observe: symbol!("mpv_observe_property"),
                query: symbol!("mpv_get_property_async"),
                properties: RefCell::default(),
                updates: RefCell::default(),
                setting: Cell::new(false),
                command_async: symbol!("mpv_command_async"),
                wait_event: symbol!("mpv_wait_event"),
                handle,
                _library: library,
            };
            for (key, value) in [
                ("config", "no"),
                ("terminal", "no"),
                ("msg-level", "all=no"),
                ("title", "赛博房间播放器"),
                ("load-scripts", "no"),
                ("ytdl", "no"),
                ("osc", "no"),
                ("input-default-bindings", "no"),
                ("input-vo-keyboard", "no"),
                ("input-media-keys", "no"),
                ("input-terminal", "no"),
                ("cursor-autohide", "no"),
                ("idle", "yes"),
                ("keep-open", "yes"),
                ("audio-display", "no"),
                ("vo", "gpu-next"),
                ("gpu-api", "d3d11"),
                ("gpu-context", "d3d11"),
                ("hwdec", "auto-safe"),
                ("ao", "wasapi"),
                ("audio-channels", "stereo"),
                ("sid", "no"),
                ("cache-on-disk", "no"),
                ("network-timeout", "20"),
                ("cookies", "no"),
                ("load-unsafe-playlists", "no"),
                ("access-references", "no"),
                ("demuxer-max-bytes", "32MiB"),
                ("demuxer-max-back-bytes", "8MiB"),
                ("save-position-on-quit", "no"),
                ("stop-screensaver", "yes"),
            ] {
                api.opt(key, value)?;
            }
            api.opt("wid", &(hwnd as u32).to_string())?;
            api.opt("force-window", "yes")?;
            #[cfg(test)]
            if hwnd == 0 {
                // The ignored integration test runs this Player without opening
                // an application or touching the user's audio/video devices.
                api.opt("vo", "null")?;
                api.opt("ao", "null")?;
                api.opt("force-window", "no")?;
            }
            api.opt(
                "demuxer-lavf-o",
                "protocol_whitelist=[http,https,tcp,tls,crypto,data]",
            )?;
            if std::env::var("CYBER_ROOM_MEDIA_DIAGNOSTICS").as_deref() == Ok("1") {
                api.opt("af", "@diagnostics:lavfi=[astats=metadata=1:reset=0]")?;
            }
            if initialize(handle) < 0 {
                return Err("原生音视频设备初始化失败".into());
            }
            for name in [
                "duration",
                "time-pos",
                "seeking",
                "pause",
                "paused-for-cache",
                "eof-reached",
                "audio-codec-name",
                "aid",
                "sid",
                "track-list",
                "audio-out-params/channel-count",
                "audio-out-params/samplerate",
                "current-ao",
                "current-vo",
                "af-metadata/diagnostics/lavfi.astats.Overall.Peak_level",
                "af-metadata/diagnostics/lavfi.astats.Overall.Number_of_samples",
            ] {
                let name = CString::new(name).unwrap();
                if (api.observe)(handle, 0, name.as_ptr(), 6) < 0 {
                    return Err("无法订阅播放状态".into());
                }
            }
            Ok(api)
        }
    }
    fn opt(&self, key: &str, value: &str) -> Result<(), String> {
        self.string_call(self.option, key, value)
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        if key.contains('\0') || value.contains('\0') {
            return Err("播放参数无效".into());
        }
        self.updates.borrow_mut().insert(key.into(), value.into());
        Ok(())
    }
    fn string_call(
        &self,
        f: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        let (key, value) = (
            CString::new(key).map_err(|_| "播放参数无效")?,
            CString::new(value).map_err(|_| "播放参数无效")?,
        );
        if unsafe { f(self.handle, key.as_ptr(), value.as_ptr()) } < 0 {
            Err("播放器无法应用此参数".into())
        } else {
            Ok(())
        }
    }
    fn command(&self, args: &[&str]) -> Result<(), String> {
        self.dispatch(args, 0)
    }
    fn dispatch(&self, args: &[&str], tag: u64) -> Result<(), String> {
        let values: Vec<CString> = args
            .iter()
            .map(|s| CString::new(*s))
            .collect::<Result<_, _>>()
            .map_err(|_| "播放参数无效")?;
        let mut pointers: Vec<*const c_char> = values.iter().map(|v| v.as_ptr()).collect();
        pointers.push(std::ptr::null());
        let result = unsafe { (self.command_async)(self.handle, tag, pointers.as_ptr()) };
        if result < 0 {
            Err("播放器命令失败".into())
        } else {
            Ok(())
        }
    }
    fn get(&self, key: &str) -> Value {
        self.properties
            .borrow()
            .get(key)
            .cloned()
            .unwrap_or(Value::Null)
    }
    fn flush(&self) -> Result<(), String> {
        if self.setting.get() {
            return Ok(());
        }
        let next = {
            let mut updates = self.updates.borrow_mut();
            // Pause/foreground controls take priority over track/volume changes.
            updates
                .remove("pause")
                .map(|v| ("pause".to_string(), v))
                .or_else(|| updates.pop_first())
        };
        if let Some((key, value)) = next {
            self.dispatch(&["set", &key, &value], u64::MAX)?;
            self.setting.set(true);
        }
        Ok(())
    }
    fn query_seek(&self, tag: u64) -> Result<(), String> {
        for name in ["time-pos", "seeking"] {
            let name = CString::new(name).unwrap();
            if unsafe { (self.query)(self.handle, tag, name.as_ptr(), 6) } < 0 {
                return Err("无法确认跳转状态，请重试".into());
            }
        }
        Ok(())
    }
    fn property_event(&self, data: *mut c_void) -> Option<(String, Value)> {
        #[repr(C)]
        struct Property {
            name: *const c_char,
            format: c_int,
            data: *mut c_void,
        }
        if data.is_null() {
            return None;
        }
        unsafe {
            let property = &*(data as *const Property);
            if property.name.is_null() {
                return None;
            }
            let value = if property.format == 6 && !property.data.is_null() {
                node_value(&*(property.data as *const Node), 0)
            } else {
                Value::Null
            };
            let name = CStr::from_ptr(property.name).to_string_lossy().into_owned();
            self.properties
                .borrow_mut()
                .insert(name.clone(), value.clone());
            Some((name, value))
        }
    }
}
impl Drop for Mpv {
    fn drop(&mut self) {
        unsafe { (self.terminate)(self.handle) }
    }
}
unsafe fn node_value(node: &Node, depth: usize) -> Value {
    if depth > 8 {
        return Value::Null;
    }
    match node.format {
        1 => {
            if node.value.string.is_null() {
                Value::Null
            } else {
                json!(CStr::from_ptr(node.value.string).to_string_lossy())
            }
        }
        3 => json!(node.value.flag != 0),
        4 => json!(node.value.integer),
        5 => json!(node.value.double),
        7 | 8 => {
            if node.value.list.is_null() {
                return Value::Null;
            }
            let list = &*node.value.list;
            if list.num < 0 || list.num > 4096 {
                return Value::Null;
            }
            if node.format == 7 {
                Value::Array(
                    (0..list.num as usize)
                        .map(|i| node_value(&*list.values.add(i), depth + 1))
                        .collect(),
                )
            } else {
                let mut map = serde_json::Map::new();
                for i in 0..list.num as usize {
                    let key = *list.keys.add(i);
                    if !key.is_null() {
                        map.insert(
                            CStr::from_ptr(key).to_string_lossy().into_owned(),
                            node_value(&*list.values.add(i), depth + 1),
                        );
                    }
                }
                Value::Object(map)
            }
        }
        _ => Value::Null,
    }
}

struct Bullet {
    id: String,
    text: String,
    start: Instant,
    lane: usize,
}
#[derive(Default)]
struct Subtitles {
    cues: Vec<(f64, f64, String)>,
    active: Vec<usize>,
    cursor: usize,
    time: Option<f64>,
    dirty: bool,
}
impl Subtitles {
    fn apply_command(&mut self, command: &Value, replacing: bool) {
        // Mailbox may merge a load and its completed subtitle request. Clear
        // the old movie first, then install cues from the same command.
        if replacing {
            self.clear();
        }
        if let Some(cues) = command.get("subtitleCues").and_then(Value::as_array) {
            self.replace(cues);
        }
        if command.get("subtitleStreamIndex").and_then(Value::as_i64).is_some_and(|index| index >= 0) {
            self.clear();
        }
    }
    fn replace(&mut self, values: &[Value]) {
        self.clear();
        self.cues = values
            .iter()
            .map(|c| {
                (
                    c["start"].as_f64().unwrap_or(0.),
                    c["end"].as_f64().unwrap_or(0.),
                    c["text"].as_str().unwrap_or("").to_string(),
                )
            })
            .collect();
        self.cues.sort_by(|a, b| a.0.total_cmp(&b.0));
    }
    fn clear(&mut self) {
        *self = Self {
            dirty: true,
            ..Self::default()
        };
    }
    fn len(&self) -> usize {
        self.cues.len()
    }
    fn is_empty(&self) -> bool {
        self.cues.is_empty()
    }
    fn update(&mut self, time: f64) -> Option<String> {
        let previous = self.active.clone();
        if self.time.is_none_or(|old| time < old) {
            self.active.clear();
            self.cursor = 0;
        }
        self.active.retain(|i| self.cues[*i].1 > time);
        while self.cursor < self.cues.len() && self.cues[self.cursor].0 <= time {
            if self.cues[self.cursor].1 > time {
                self.active.push(self.cursor);
            }
            self.cursor += 1;
        }
        self.time = Some(time);
        let changed = self.dirty || self.active != previous;
        self.dirty = false;
        changed.then(|| {
            self.active
                .iter()
                .take(4)
                .map(|i| self.cues[*i].2.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
    }
}
struct SeekTarget {
    position: f64,
    id: String,
}
struct SeekOperation {
    tag: u64,
    target: f64,
    started: Instant,
    acknowledged: bool,
    seek_event: bool,
    restarted: bool,
    restarted_at: Option<Instant>,
    query_tag: Option<u64>,
    position_reply: Option<Value>,
    seeking_reply: Option<Value>,
}
impl SeekOperation {
    fn acknowledge(&mut self) {
        self.acknowledged = true;
        // mpv's event queue can still contain the preceding seek's SEEK and
        // PLAYBACK_RESTART when a newer command is submitted. Its command reply
        // filters that queued prefix. Lifecycle events have no command ID, so
        // their fresh position must still be checked against this seek's target.
        self.seek_event = false;
        self.restarted = false;
        self.restarted_at = None;
    }
    fn progress(&mut self, event: c_int) {
        if !self.acknowledged {
            return;
        }
        if event == 20 {
            self.seek_event = true;
            self.restarted = false;
            self.restarted_at = None;
            self.query_tag = None;
            self.position_reply = None;
            self.seeking_reply = None;
        }
        if event == 21 && self.seek_event {
            self.restarted = true;
            self.restarted_at = Some(Instant::now());
        }
    }
    fn complete(&self, seeking: bool, position: Option<f64>) -> bool {
        self.ready(seeking) && position.is_some_and(|position| self.accepts_position(position))
    }
    fn ready(&self, seeking: bool) -> bool {
        self.acknowledged && self.seek_event && self.restarted && !seeking
    }
    fn accepts_position(&self, position: f64) -> bool {
        reachable_position(
            self.target,
            position,
            self.restarted_at
                .map(|time| time.elapsed())
                .unwrap_or_default(),
        )
    }
}
struct Player {
    mpv: Mpv,
    loaded: bool,
    foreground: bool,
    playing: bool,
    url: String,
    error: String,
    first_frame: bool,
    rate: f64,
    volume: f64,
    muted: bool,
    cues: Subtitles,
    subtitle_offset: f64,
    bullets: VecDeque<Bullet>,
    audio_index: Option<i64>,
    subtitle_index: Option<i64>,
    media_tracks: Vec<Value>,
    last_overlay: String,
    overlay_pending: bool,
    tracks_pending: bool,
    subtitle_text: String,
    compositor: bool,
    playback_id: String,
    seek_id: String,
    next_command: u64,
    load_tag: Option<u64>,
    entry_id: Option<i64>,
    event_entry: Option<i64>,
    loaded_entry: Option<i64>,
    restarted_entry: Option<i64>,
    position: f64,
    position_checked_at: Instant,
    seek: Option<SeekOperation>,
    queued_seek: Option<SeekTarget>,
    eof_since: Option<Instant>,
}
impl Player {
    fn open(directory: &Path, hwnd: isize, compositor: bool) -> Result<Self, String> {
        Ok(Self::with_mpv(
            Mpv::open(&library_path(directory)?, hwnd)?,
            compositor,
        ))
    }
    fn with_mpv(mpv: Mpv, compositor: bool) -> Self {
        Self {
            mpv,
            loaded: false,
            foreground: true,
            playing: false,
            url: String::new(),
            error: String::new(),
            first_frame: false,
            rate: 1.,
            volume: 1.,
            muted: false,
            cues: Subtitles::default(),
            subtitle_offset: 0.,
            bullets: VecDeque::new(),
            audio_index: None,
            subtitle_index: Some(-1),
            media_tracks: Vec::new(),
            last_overlay: String::new(),
            overlay_pending: false,
            tracks_pending: false,
            subtitle_text: String::new(),
            compositor,
            playback_id: String::new(),
            seek_id: String::new(),
            next_command: 1,
            load_tag: None,
            entry_id: None,
            event_entry: None,
            loaded_entry: None,
            restarted_entry: None,
            position: 0.,
            position_checked_at: Instant::now(),
            seek: None,
            queued_seek: None,
            eof_since: None,
        }
    }
    fn command(&mut self, q: Value) -> Result<(), String> {
        let new_playback = q
            .get("playbackId")
            .and_then(Value::as_str)
            .is_some_and(|id| id != self.playback_id);
        if new_playback && q.get("url").is_none() {
            return Ok(());
        }
        let replacing = q.get("url")
            .and_then(Value::as_str)
            .is_some_and(|url| new_playback || url != self.url || !self.error.is_empty());
        if replacing {
            self.audio_index = None;
            self.subtitle_index = Some(-1);
            self.media_tracks.clear();
            self.subtitle_offset = 0.;
        }
        self.cues.apply_command(&q, replacing);
        if let Some(v) = q.get("rate").and_then(Value::as_f64) {
            self.rate = v.clamp(0.5, 2.);
            self.mpv.set("speed", &self.rate.to_string())?;
        }
        if let Some(v) = q.get("volume").and_then(Value::as_f64) {
            self.volume = v.clamp(0., 1.);
            self.mpv.set("volume", &(self.volume * 100.).to_string())?;
        }
        if let Some(v) = q.get("muted").and_then(Value::as_bool) {
            self.muted = v;
            self.mpv.set("mute", if v { "yes" } else { "no" })?;
        }
        if let Some(v) = q.get("subtitleOffsetMs").and_then(Value::as_f64) {
            self.subtitle_offset = v.max(0.) / 1000.;
        }
        if let Some(v) = q.get("mediaTracks").and_then(Value::as_array) {
            self.media_tracks = v.iter().take(256).cloned().collect();
        }
        if let Some(v) = q.get("audioStreamIndex").and_then(Value::as_i64) {
            self.audio_index = Some(v);
        }
        if let Some(v) = q.get("subtitleStreamIndex").and_then(Value::as_i64) {
            self.subtitle_index = Some(v);
        }
        if let Some(b) = q.get("danmaku") {
            let id = b["id"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(160)
                .collect::<String>();
            let text = b["text"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(240)
                .collect::<String>();
            if !text.is_empty() && !self.bullets.iter().any(|b| b.id == id) {
                if self.bullets.len() >= 30 {
                    self.bullets.pop_front();
                }
                let lane = self.bullets.len() % 5;
                self.bullets.push_back(Bullet {
                    id,
                    text,
                    start: Instant::now(),
                    lane,
                });
            }
        }
        let mut changed = false;
        if let Some(url) = q.get("url").and_then(Value::as_str) {
            if new_playback || url != self.url || !self.error.is_empty() {
                self.playback_id = q["playbackId"].as_str().unwrap_or("").into();
                self.seek_id = q["seekId"].as_str().unwrap_or("").into();
                self.seek = None;
                self.queued_seek = None;
                self.entry_id = None;
                self.loaded_entry = None;
                self.restarted_entry = None;
                self.eof_since = None;
                self.url = url.into();
                self.loaded = false;
                self.first_frame = false;
                self.error.clear();
                self.mpv.set("sid", "no")?;
                self.mpv.set("aid", "auto")?;
                let start = q["positionMs"].as_f64().unwrap_or(0.).max(0.) / 1000.;
                self.position = start;
                self.position_checked_at = Instant::now();

                let tag = self.command_tag();
                self.load_tag = Some(tag);
                self.mpv.dispatch(
                    &["loadfile", url, "replace", "-1", &load_options(url, start)],
                    tag,
                )?;
                changed = true;
            }
        }
        if !changed {
            if let Some(position) = q.get("positionMs").and_then(Value::as_f64) {
                self.error.clear();
                self.seek_id = q["seekId"].as_str().unwrap_or("").into();
                self.position = position.max(0.) / 1000.;
                self.position_checked_at = Instant::now();
                self.eof_since = None;
                self.queued_seek = Some(SeekTarget {
                    position: self.position,
                    id: self.seek_id.clone(),
                });
                self.start_queued_seek()?;
            }
            if self.loaded
                && (q.get("audioStreamIndex").is_some() || q.get("subtitleStreamIndex").is_some())
            {
                self.tracks_pending = true;
            }
        }
        if let Some(playing) = q.get("playing").and_then(Value::as_bool) {
            self.playing = playing;
            self.mpv.set(
                "pause",
                if playing && self.foreground {
                    "no"
                } else {
                    "yes"
                },
            )?;
        }
        Ok(())
    }
    fn command_tag(&mut self) -> u64 {
        let tag = self.next_command;
        self.next_command = self.next_command.wrapping_add(1).max(1);
        tag
    }
    fn start_queued_seek(&mut self) -> Result<(), String> {
        if !self.loaded || !self.first_frame {
            return Ok(());
        }
        // A newer slider position supersedes a slow seek once its command was
        // accepted; do not wait for network decode completion of an obsolete target.
        if self
            .seek
            .as_ref()
            .is_some_and(|s| !s.acknowledged || s.started.elapsed() < Duration::from_millis(180))
        {
            return Ok(());
        }
        let Some(request) = self.queued_seek.take() else {
            return Ok(());
        };
        let duration = self.mpv.get("duration").as_f64().unwrap_or(0.);
        let position = seek_position(request.position, duration);
        self.position = position;
        self.position_checked_at = Instant::now();
        self.seek_id = request.id;
        if self.seek.is_none()
            && self.mpv.get("seeking").as_bool() != Some(true)
            && self
                .mpv
                .get("time-pos")
                .as_f64()
                .is_some_and(|time| (time - position).abs() < 0.05)
        {
            return self.mpv.set(
                "pause",
                if self.playing && self.foreground {
                    "no"
                } else {
                    "yes"
                },
            );
        }
        let tag = self.command_tag();
        self.seek = Some(SeekOperation {
            tag,
            target: position,
            started: Instant::now(),
            acknowledged: false,
            seek_event: false,
            restarted: false,
            restarted_at: None,
            query_tag: None,
            position_reply: None,
            seeking_reply: None,
        });
        if let Err(error) = self
            .mpv
            .dispatch(&["seek", &position.to_string(), "absolute+exact"], tag)
        {
            self.seek = None;
            return Err(error);
        }
        // keep-open pauses at EOF. Seeking away from it must restore the latest
        // room intent, including an explicit pause while the request was pending.
        self.mpv.set(
            "pause",
            if self.playing && self.foreground {
                "no"
            } else {
                "yes"
            },
        )
    }
    fn apply_tracks(&self) -> Result<(), String> {
        let tracks = self.mpv.get("track-list");
        for (kind, index, property) in [
            ("audio", self.audio_index, "aid"),
            ("sub", self.subtitle_index, "sid"),
        ] {
            if let Some(index) = index {
                if index < 0 {
                    self.mpv.set(property, "no")?;
                    continue;
                }
                let metadata_kind = if kind == "audio" { "Audio" } else { "Subtitle" };
                if !self.media_tracks.iter().any(|t| {
                    t["Index"].as_i64() == Some(index)
                        && t["Type"].as_str() == Some(metadata_kind)
                        && t["IsExternal"] != true
                }) {
                    return Err("所选音轨或字幕不属于当前媒体".into());
                }
                let id = track_id(&tracks, kind, index).ok_or("原生播放器找不到所选音轨或字幕")?;
                self.mpv.set(property, &id.to_string())?;
            }
        }
        Ok(())
    }
    fn events(&mut self) {
        loop {
            let event = unsafe { &*(self.mpv.wait_event)(self.mpv.handle, 0.) };
            if event.id == 0 {
                break;
            }
            #[cfg(test)]
            if std::env::var_os("MEDIA_PLAYER_TRACE").is_some()
                && matches!(event.id, 3 | 5 | 6 | 7 | 8 | 20 | 21)
            {
                let end = if event.id == 7 && !event.data.is_null() {
                    unsafe {
                        Some([
                            *(event.data as *const c_int),
                            *((event.data as *const c_int).add(1)),
                        ])
                    }
                } else {
                    None
                };
                eprintln!(
                    "player-event {}",
                    json!({"event":event.id,"tag":event.userdata,"error":event.error,"end":end,"seekId":self.seek_id,"time":self.mpv.get("time-pos"),"eof":self.mpv.get("eof-reached")})
                );
            }
            match event.id {
                5 => {
                    if event.userdata == u64::MAX {
                        self.mpv.setting.set(false);
                    }
                    if event.userdata == u64::MAX - 1 {
                        self.overlay_pending = false;
                    }
                    if self.load_tag == Some(event.userdata) {
                        self.load_tag = None;
                        if event.error < 0 {
                            self.error = "原生播放器无法打开此片源，请重试".into();
                            self.playing = false;
                        } else if !event.data.is_null() {
                            // loadfile returns the new playlist entry ID. Lifecycle
                            // events from a replaced load cannot commit its successor.
                            let result = unsafe { node_value(&*(event.data as *const Node), 0) };
                            self.entry_id = result["playlist_entry_id"].as_i64();
                        }
                    } else if self
                        .seek
                        .as_ref()
                        .is_some_and(|seek| seek.tag == event.userdata)
                    {
                        if event.error < 0 {
                            self.seek = None;
                            if self.queued_seek.is_none() {
                                self.error = "此片源无法跳转到指定位置，请重试".into();
                                self.playing = false;
                            }
                        } else if let Some(seek) = self.seek.as_mut() {
                            seek.acknowledge();
                        }
                    }
                }
                22 => {
                    self.mpv.property_event(event.data);
                }
                3 => {
                    if let Some(seek) = self
                        .seek
                        .as_mut()
                        .filter(|s| s.query_tag == Some(event.userdata))
                    {
                        if let Some((name, value)) = self.mpv.property_event(event.data) {
                            match name.as_str() {
                                "time-pos" => seek.position_reply = Some(value),
                                "seeking" => seek.seeking_reply = Some(value),
                                _ => {}
                            }
                        }
                    }
                }
                6 => {
                    if !event.data.is_null() {
                        self.event_entry = Some(unsafe { *(event.data as *const i64) });
                    }
                }
                8 => {
                    self.loaded_entry = self.event_entry;
                }
                7 => {
                    #[repr(C)]
                    struct End {
                        reason: c_int,
                        error: c_int,
                        entry: i64,
                    }
                    if !event.data.is_null() {
                        let end = unsafe { &*(event.data as *const End) };
                        if self.entry_id == Some(end.entry) && (end.reason == 4 || end.error < 0) {
                            self.error = "原生播放器无法读取或解码此片源，请重试或切换画质".into();
                            self.playing = false;
                            self.seek = None;
                            self.queued_seek = None;
                        }
                    }
                }
                20 => {
                    if self.entry_id.is_some() && self.entry_id == self.event_entry {
                        if let Some(seek) = self.seek.as_mut() {
                            seek.progress(20);
                        }
                    }
                }
                21 => {
                    self.restarted_entry = self.event_entry;
                    if self.entry_id.is_some() && self.entry_id == self.event_entry {
                        if let Some(seek) = self.seek.as_mut() {
                            seek.progress(21);
                        }
                    }
                }
                _ => {}
            }
        }
        if self.entry_id.is_some() && self.entry_id == self.loaded_entry && !self.loaded {
            self.loaded = true;
            self.tracks_pending = true;
        }
        if self.loaded
            && self.tracks_pending
            && self
                .mpv
                .get("track-list")
                .as_array()
                .is_some_and(|v| !v.is_empty())
        {
            self.tracks_pending = false;
            if let Err(error) = self.apply_tracks() {
                self.error = error;
            }
        }
        if self.loaded && !self.first_frame && self.entry_id == self.restarted_entry {
            self.first_frame = true;
            // Per-file pause=yes keeps a replacement load safe until its first
            // frame. Apply the latest intent after that option has taken effect.
            let _ = self.mpv.set(
                "pause",
                if self.playing && self.foreground {
                    "no"
                } else {
                    "yes"
                },
            );
        }
        if self
            .seek
            .as_ref()
            .is_some_and(|s| s.acknowledged && s.seek_event && s.restarted && s.query_tag.is_none())
        {
            // Observed property notifications are coalesced independently of
            // lifecycle events. Query a fresh snapshot after RESTART; cached
            // time-pos/false seeking must not commit a newer seek.
            let tag = self.command_tag();
            if let Err(error) = self.mpv.query_seek(tag) {
                self.error = error;
            }
            if let Some(seek) = self.seek.as_mut() {
                seek.query_tag = Some(tag);
            }
        }
        if let Some(seek) = self.seek.as_mut() {
            if seek.started.elapsed() > Duration::from_secs(25) {
                self.seek = None;
                // The timeout belongs to the obsolete operation, not to a
                // newer target submitted while the core was unresponsive.
                if self.queued_seek.is_none() {
                    self.error = "跳转后未能恢复播放，请重试或切换画质".into();
                    self.playing = false;
                    let _ = self.mpv.set("pause", "yes");
                }
            } else if seek
                .ready(seek.seeking_reply.as_ref().and_then(Value::as_bool) != Some(false))
                && seek
                    .position_reply
                    .as_ref()
                    .and_then(Value::as_f64)
                    .is_some_and(|position| !seek.accepts_position(position))
                && self.mpv.get("eof-reached") == true
            {
                // A failed HTTP range read can trigger mpv keep-open's internal
                // seek-to-last-frame. It reports successful RESTART, no error,
                // and time-pos=duration. This is not our requested seek or EOF.
                self.position = seek.target;
                self.position_checked_at = Instant::now();
                self.seek = None;
                if self.queued_seek.is_none() {
                    self.fail_unexpected_eof();
                }
            } else if seek.complete(
                seek.seeking_reply.as_ref().and_then(Value::as_bool) != Some(false),
                seek.position_reply.as_ref().and_then(Value::as_f64),
            ) {
                let position = seek
                    .position_reply
                    .as_ref()
                    .and_then(Value::as_f64)
                    .unwrap();
                self.position = position;
                self.position_checked_at = Instant::now();
                self.mpv
                    .properties
                    .borrow_mut()
                    .insert("time-pos".into(), json!(position));
                self.seek = None;
                let _ = self.mpv.set(
                    "pause",
                    if self.playing && self.foreground {
                        "no"
                    } else {
                        "yes"
                    },
                );
            } else if seek.position_reply.is_some() && seek.seeking_reply.is_some() {
                // A new reconfiguration may have begun while these asynchronous
                // reads ran. Wait for its RESTART, or retry missing values.
                seek.query_tag = None;
                seek.position_reply = None;
                seek.seeking_reply = None;
            }
        }
        if let Err(error) = self.start_queued_seek().and_then(|_| self.mpv.flush()) {
            self.error = error;
        }
    }
    fn state(&mut self) -> Value {
        let seeking = !self.url.is_empty()
            && self.error.is_empty()
            && (!self.loaded
                || !self.first_frame
                || self.seek.is_some()
                || self.queued_seek.is_some()
                || self.mpv.get("seeking").as_bool() == Some(true));
        if !seeking && self.loaded && self.error.is_empty() {
            if let Some(time) = self.mpv.get("time-pos").as_f64() {
                if self.mpv.get("eof-reached") == true
                    && !reachable_position(self.position, time, self.position_checked_at.elapsed())
                {
                    self.fail_unexpected_eof();
                } else {
                    self.position = time;
                    self.position_checked_at = Instant::now();
                }
            }
        }
        let time = self.position;
        let duration = self.mpv.get("duration").as_f64().unwrap_or(0.);
        let paused = self.mpv.get("pause").as_bool().unwrap_or(true);
        let buffering = self.mpv.get("paused-for-cache").as_bool().unwrap_or(false);
        let stable_eof = stable_eof(
            self.loaded && self.first_frame,
            seeking,
            !self.error.is_empty(),
            self.mpv.get("eof-reached").as_bool().unwrap_or(false),
            time,
            duration,
        );
        if !stable_eof {
            self.eof_since = None;
        }
        let ended = stable_eof
            && self.eof_since.get_or_insert_with(Instant::now).elapsed()
                >= Duration::from_millis(200);
        let audio = self.mpv.get("audio-codec-name");
        let selected = self.mpv.get("aid");
        let tracks = self.mpv.get("track-list");
        let index = |kind: &str, id: &Value| {
            tracks
                .as_array()
                .and_then(|ts| {
                    ts.iter()
                        .find(|t| t["type"].as_str() == Some(kind) && t["id"] == *id)
                })
                .and_then(|t| t["ff-index"].as_i64())
        };
        let audio_index = index("audio", &selected);
        let subtitle_index = index("sub", &self.mpv.get("sid")).unwrap_or(-1);
        let audio_present = tracks
            .as_array()
            .is_some_and(|ts| ts.iter().any(|t| t["type"] == "audio"));
        let number = |key: &str| {
            let value = self.mpv.get(key);
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|v| v.parse::<f64>().ok()))
                .filter(|v| v.is_finite())
        };
        let peak = number("af-metadata/diagnostics/lavfi.astats.Overall.Peak_level")
            .map(|db| 10f64.powf(db / 20.));
        json!({"type":"player","playbackId":self.playback_id,"seekId":self.seek_id,"seeking":seeking,"positionMs":time*1000.,"durationMs":duration*1000.,"playing":self.loaded&&!seeking&&!paused&&!buffering,"buffering":!self.url.is_empty()&&(seeking||buffering)&&self.error.is_empty(),"ended":ended,"renderedFirstFrame":self.first_frame,"error":self.error,"rate":self.rate,"volume":self.volume,"muted":self.muted,"audioPresent":audio_present,"audioSupported":if self.loaded&&audio_present{json!(!audio.is_null())}else{Value::Null},"audioSelected":selected.is_number(),"audioMime":audio,"audioChannels":self.mpv.get("audio-out-params/channel-count"),"audioSampleRate":self.mpv.get("audio-out-params/samplerate"),"audioOutputAdvancing":self.loaded&&!seeking&&!paused&&!buffering&&selected.is_number(),"audioStreamIndex":audio_index,"subtitleStreamIndex":subtitle_index,"audioPcmPeak":peak,"audioPcmFrames":number("af-metadata/diagnostics/lavfi.astats.Overall.Number_of_samples"),"subtitleCues":self.cues.len(),"subtitleOffsetMs":self.subtitle_offset*1000.,"subtitleRequestedIndex":self.subtitle_index,"subtitleVisible":!self.subtitle_text.is_empty(),"audioOutput":self.mpv.get("current-ao"),"videoOutput":self.mpv.get("current-vo"),"engine":"mpv","danmakuRenderer":if self.compositor{"directcomposition"}else{"ass-fallback"}})
    }
    fn overlay(&mut self) {
        self.bullets
            .retain(|b| b.start.elapsed() < Duration::from_secs(8));
        if self.cues.is_empty() && self.bullets.is_empty() && self.last_overlay.is_empty() {
            return;
        }
        let time = if self.cues.is_empty() {
            0.
        } else {
            self.mpv.get("time-pos").as_f64().unwrap_or(0.) + self.subtitle_offset
        };
        if let Some(subtitle) = self.cues.update(time) {
            self.subtitle_text = subtitle;
        }
        let mut text = String::new();
        if !self.subtitle_text.is_empty() {
            text.push_str(&format!(
                "{{\\an2\\pos(640,674)\\fs32\\bord2\\shad1\\c&HFFFFFF&}}{}",
                ass_text(&self.subtitle_text)
            ));
        }
        // The bounded ASS fallback is used only if DirectComposition fails.
        // It remains tied to video redraws; normal DWM animation is independent.
        for bullet in &self.bullets {
            let progress = bullet.start.elapsed().as_secs_f64() / 8.;
            let width = (bullet.text.chars().count() as f64 * 28.).min(6720.);
            let x = 1280. - progress * (1280. + width);
            text.push_str(&format!(
                "\n{{\\an7\\pos({x:.2},{})\\fs27\\bord1.5\\shad0\\c&HFFFFFF&}}{}",
                35 + bullet.lane * 42,
                ass_text(&bullet.text)
            ));
        }
        if !self.overlay_pending
            && text != self.last_overlay
            && self
                .mpv
                .dispatch(
                    &["osd-overlay", "1", "ass-events", &text, "1280", "720", "10"],
                    u64::MAX - 1,
                )
                .is_ok()
        {
            self.last_overlay = text;
            self.overlay_pending = true;
        }
    }
    fn stop(&mut self) {
        let _ = self.mpv.command(&["stop"]);
        self.loaded = false;
        self.playing = false;
        self.url.clear();
        self.error.clear();
        self.first_frame = false;
        self.playback_id.clear();
        self.seek_id.clear();
        self.load_tag = None;
        self.entry_id = None;
        self.event_entry = None;
        self.loaded_entry = None;
        self.restarted_entry = None;
        self.seek = None;
        self.queued_seek = None;
        self.eof_since = None;
        self.position = 0.;
        self.position_checked_at = Instant::now();
        self.mpv.updates.borrow_mut().clear();
        self.tracks_pending = false;
        self.cues.clear();
        self.bullets.clear();
        self.audio_index = None;
        self.subtitle_index = Some(-1);
        self.media_tracks.clear();
        self.overlay();
    }
    fn fail_unexpected_eof(&mut self) {
        self.error = "片源跳转读取失败，请重试或切换画质".into();
        self.playing = false;
        self.eof_since = None;
        let _ = self.mpv.set("pause", "yes");
    }
}
fn reachable_position(target: f64, position: f64, elapsed: Duration) -> bool {
    // Exact seeking has a small timestamp tolerance. A playing decoder can
    // advance while completion is delivered; allow the maximum supported 2x
    // rate over that entire interval, rather than the old fixed 1-second test.
    position.is_finite()
        && position >= target - 2.
        && position <= target + elapsed.as_secs_f64() * 2. + 2.
}
fn load_options(url: &str, start: f64) -> String {
    let mut options = format!("start={start},pause=yes");
    if reqwest::Url::parse(url).is_ok_and(|url| url.path().to_ascii_lowercase().ends_with(".m3u8"))
    {
        // HLS needs nested HTTP reads, which access-references=no blocks before
        // decoding. Restrict this exception to FFmpeg's HLS demuxer; its existing
        // protocol whitelist still rejects local files and arbitrary protocols.
        options.push_str(",access-references=yes,demuxer=lavf,demuxer-lavf-format=hls");
    }
    options
}
fn seek_position(position: f64, duration: f64) -> f64 {
    if duration.is_finite() && duration > 0. {
        position.max(0.).min((duration - 0.05).max(0.))
    } else {
        position.max(0.)
    }
}
fn stable_eof(
    ready: bool,
    seeking: bool,
    failed: bool,
    eof: bool,
    time: f64,
    duration: f64,
) -> bool {
    ready && !seeking && !failed && eof && duration > 0. && time >= (duration - 0.5).max(0.)
}
fn track_id(tracks: &Value, kind: &str, index: i64) -> Option<i64> {
    tracks
        .as_array()?
        .iter()
        .find(|t| {
            t["type"].as_str() == Some(kind)
                && t["ff-index"].as_i64() == Some(index)
                && t["external"] != true
        })?
        .get("id")?
        .as_i64()
}
fn ass_text(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .map(|c| match c {
            '\\' => "\\\u{feff}".into(),
            '{' => "\\{".into(),
            '}' => "\\}".into(),
            '\n' => "\\N".into(),
            _ => c.to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    // Drives the production Player from a local test harness. Muted, no native window.
    #[test]
    #[ignore = "requires MPV_DLL_DIR and explicit local stdin commands"]
    fn headless_quality_player() {
        use std::io::BufRead;
        let directory=PathBuf::from(std::env::var_os("MPV_DLL_DIR").expect("MPV_DLL_DIR"));
        let mut player=Player::with_mpv(Mpv::open(&directory.join("libmpv-2.dll"),0).unwrap(),false);
        let (tx,rx)=std::sync::mpsc::channel();
        std::thread::spawn(move||{for line in std::io::stdin().lock().lines(){if let Ok(line)=line{if let Ok(value)=serde_json::from_str::<Value>(&line){if tx.send(value).is_err(){break;}}}}});
        let deadline=Instant::now()+Duration::from_secs(180);let mut last=Instant::now();
        while Instant::now()<deadline {
            match rx.recv_timeout(Duration::from_millis(10)){
                Ok(mut q)=>{if q["quit"]==true{return;}if q["stop"]==true{player.stop();}else{if let Some(url)=q["url"].as_str(){assert!(url.starts_with("http://127.0.0.1:"),"local fixture only");}q["muted"]=json!(true);player.command(q).unwrap();}},
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected)=>return,
                Err(_)=>{}
            }
            player.events();if last.elapsed()>Duration::from_millis(100){println!("QUALITY_STATE {}",player.state());last=Instant::now();}
        }
        panic!("headless quality test timed out");
    }

    #[test]
    #[ignore = "requires MPV_DLL_DIR and MEDIA_PLAYER_INPUT; no application/window is started"]
    fn actual_player_network_seek_diagnostics() {
        let path = PathBuf::from(std::env::var_os("MPV_DLL_DIR").expect("MPV_DLL_DIR required"));
        let input = std::fs::read(
            std::env::var_os("MEDIA_PLAYER_INPUT").expect("MEDIA_PLAYER_INPUT required"),
        )
        .unwrap();
        let input: Value = serde_json::from_slice(&input).expect("invalid private input JSON");
        let mut player = Player::with_mpv(Mpv::open(&path.join("libmpv-2.dll"), 0).unwrap(), false);
        let playing = input["playing"].as_bool().unwrap_or(true);
        let rate = input["rate"].as_f64().unwrap_or(1.);
        player.command(json!({"url":input["url"],"playbackId":"actual-player-test","seekId":"load","positionMs":0,"playing":playing,"rate":rate,"volume":0.35,"muted":true})).unwrap();
        let started = Instant::now();
        let mut ready_at = None;
        let mut commands = 0;
        let mut next_status = Duration::ZERO;
        let mut final_position = None;
        let mut finished = false;
        let mut recovered_failure = false;
        let targets: Vec<f64> = input["targets"]
            .as_array()
            .map(|v| v.iter().map(|n| n.as_f64().unwrap()).collect())
            .unwrap_or_else(|| vec![1306., 2500., 300.]);
        let interval = input["intervalMs"].as_u64().unwrap_or(400);
        while started.elapsed() < Duration::from_secs(100) {
            player.events();
            let state = player.state();
            if state["renderedFirstFrame"] == true && ready_at.is_none() {
                ready_at = Some(Instant::now());
            }
            if let Some(ready) = ready_at {
                if commands < targets.len()
                    && ready.elapsed() >= Duration::from_millis(1500 + commands as u64 * interval)
                {
                    let target = targets[commands];
                    commands += 1;
                    eprintln!(
                        "player-request {}",
                        json!({"at":started.elapsed().as_secs_f64(),"target":target,"id":commands})
                    );
                    player.command(json!({"positionMs":target*1000.,"seekId":commands.to_string(),"playing":playing,"rate":rate,"volume":0.35,"muted":true})).unwrap();
                }
            }
            if started.elapsed() >= next_status {
                eprintln!(
                    "player-state {}",
                    json!({"at":started.elapsed().as_secs_f64(),"state":state,"intentPlaying":player.playing,"pause":player.mpv.get("pause"),"eof":player.mpv.get("eof-reached"),"cachedTime":player.mpv.get("time-pos"),"pendingProperties":player.mpv.updates.borrow().keys().cloned().collect::<Vec<_>>(),"setting":player.mpv.setting.get(),"seek":player.seek.as_ref().map(|s| json!({"ack":s.acknowledged,"seek":s.seek_event,"restart":s.restarted,"age":s.started.elapsed().as_secs_f64(),"query":s.query_tag,"positionReply":s.position_reply,"seekingReply":s.seeking_reply}))})
                );
                next_status = started.elapsed() + Duration::from_secs(2);
            }
            if input["expectReadFailure"] == true && !player.error.is_empty() && !recovered_failure
            {
                assert_eq!(state["ended"], false, "network EOF is not a completed film");
                assert_eq!(state["positionMs"], targets.last().unwrap() * 1000.);
                assert!(player.error.contains("读取失败"));
                eprintln!("player-recover {}", state);
                recovered_failure = true;
                final_position = None;
                player.command(json!({"url":input["url"],"playbackId":"actual-player-recovery","seekId":commands.to_string(),"positionMs":targets.last().unwrap()*1000.,"playing":true})).unwrap();
                continue;
            }
            if state["ended"] == true && input["expectEnded"] == true {
                finished = commands == targets.len() && player.error.is_empty();
                break;
            }
            if state["ended"] == true || !player.error.is_empty() {
                break;
            }
            if commands == targets.len()
                && state["seeking"] == false
                && state["seekId"] == commands.to_string()
            {
                let position = state["positionMs"].as_f64().unwrap_or(0.) / 1000.;
                let (first, at) = *final_position.get_or_insert((position, Instant::now()));
                if at.elapsed() > Duration::from_secs(3) {
                    eprintln!(
                        "player-result {}",
                        json!({"requested":targets.last(),"first":first,"position":position,"advanced":position-first,"error":player.error,"ended":state["ended"]})
                    );
                    finished = (position - targets.last().unwrap()).abs() < 10.
                        && if playing {
                            position - first > 1.
                        } else {
                            (position - first).abs() < 0.1
                        };
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        let state = player.state();
        eprintln!("player-final {}", state);
        if input["expectEnded"] == true {
            assert_eq!(
                state["ended"], true,
                "normal EOF must still finish playback"
            );
        }
        player.stop();
        assert!(
            finished,
            "actual Player did not resume near the last requested target; see sanitized states"
        );
        if input["expectReadFailure"] == true {
            assert!(
                recovered_failure,
                "fault injection did not exercise a failed range read"
            );
        }
    }
    #[test]
    fn hls_nested_reads_are_limited_to_hls_loads() {
        assert_eq!(
            load_options("https://example.test/master.m3u8?key=local", 0.),
            "start=0,pause=yes,access-references=yes,demuxer=lavf,demuxer-lavf-format=hls"
        );
        assert_eq!(
            load_options("https://example.test/movie.mkv", 63.),
            "start=63,pause=yes"
        );
        assert_eq!(
            load_options("https://example.test/movie.mkv?name=master.m3u8", 0.),
            "start=0,pause=yes"
        );
    }
    #[test]
    fn completed_seek_does_not_expire_when_playback_has_advanced() {
        let seek = SeekOperation {
            tag: 1,
            target: 10.,
            started: Instant::now() - Duration::from_secs(2),
            acknowledged: true,
            seek_event: true,
            restarted: true,
            restarted_at: Some(Instant::now() - Duration::from_secs(2)),
            query_tag: None,
            position_reply: None,
            seeking_reply: None,
        };
        assert!(
            seek.complete(false, Some(12.5)),
            "a completed seek must not wait 25 seconds after playback advances"
        );
    }
    #[test]
    fn preceding_seek_events_cannot_confirm_the_next_target() {
        let mut seek = SeekOperation {
            tag: 2,
            target: 15.,
            started: Instant::now(),
            acknowledged: false,
            seek_event: false,
            restarted: false,
            restarted_at: None,
            query_tag: None,
            position_reply: None,
            seeking_reply: None,
        };
        // The measured libmpv sequence: old SEEK/RESTART, new ACK, then the
        // coalesced old time-pos=80 and seeking=false. New target is 15 seconds.
        seek.progress(20);
        seek.progress(21);
        seek.acknowledge();
        assert!(!seek.complete(false, Some(80.)));
        seek.progress(21); // a RESTART without the new SEEK is still not enough
        assert!(!seek.complete(false, Some(80.)));
        seek.progress(20);
        seek.progress(21);
        assert!(!seek.complete(false, None));
        assert!(seek.complete(false, Some(15.)));
        seek.query_tag = Some(3);
        seek.position_reply = Some(json!(15.));
        seek.seeking_reply = Some(json!(false));
        seek.progress(20); // decoder reconfiguration invalidates that snapshot
        assert!(seek.query_tag.is_none());
        assert!(seek.position_reply.is_none());
        assert!(!seek.complete(false, Some(15.)));
    }
    #[test]
    fn failed_range_cannot_confirm_mpv_internal_seek_to_last_frame() {
        assert!(!reachable_position(80., 120., Duration::from_millis(100)));
        assert!(!reachable_position(1306., 2783., Duration::from_secs(25)));
        assert!(!reachable_position(1306., 300., Duration::from_secs(25)));
        assert!(reachable_position(80., 84.5, Duration::from_secs(2)));
        assert!(reachable_position(119.95, 120., Duration::from_millis(100)));
        let seek = SeekOperation {
            tag: 1,
            target: 80.,
            started: Instant::now() - Duration::from_secs(20),
            acknowledged: true,
            seek_event: true,
            restarted: true,
            restarted_at: Some(Instant::now()),
            query_tag: None,
            position_reply: None,
            seeking_reply: None,
        };
        assert!(
            !seek.complete(false, Some(120.)),
            "network wait is not playback time"
        );
    }
    #[test]
    fn repeated_controls_are_coalesced_and_stop_has_priority() {
        let mailbox = Mailbox::default();
        mailbox.push(Action::Command(
            json!({"url":"http://localhost/test", "playbackId":"one", "volume":0.4}),
        ));
        for n in 0..500 {
            mailbox.push(Action::Command(
                json!({"positionMs": n*1000, "seekId": n.to_string(), "playing":true}),
            ));
        }
        match mailbox.receive(Duration::ZERO).unwrap() {
            Action::Command(v) => {
                assert_eq!(v["seekId"], "499");
                assert_eq!(v["positionMs"], 499000);
                assert_eq!(v["volume"], 0.4);
                assert!(v.get("url").is_some());
            }
            _ => panic!("expected one merged command"),
        }
        assert!(mailbox.receive(Duration::ZERO).is_none());
        for n in 0..500 {
            mailbox.push(Action::Command(json!({"positionMs": n})));
        }
        mailbox.push(Action::Stop);
        assert!(matches!(
            mailbox.receive(Duration::ZERO),
            Some(Action::Stop)
        ));
        assert!(mailbox.receive(Duration::ZERO).is_none());
        mailbox.push(Action::Command(
            json!({"url":"http://localhost/next", "playbackId":"two"}),
        ));
        mailbox.push(Action::Shutdown);
        assert!(matches!(
            mailbox.receive(Duration::ZERO),
            Some(Action::Shutdown)
        ));
    }
    #[test]
    fn replacement_load_discards_previous_seek_and_subtitles() {
        let mailbox = Mailbox::default();
        mailbox.push(Action::Command(
            json!({"positionMs":99000,"seekId":"old","subtitleCues":[{"text":"old"}]}),
        ));
        mailbox.push(Action::Command(
            json!({"url":"http://localhost/new", "playbackId":"new"}),
        ));
        match mailbox.receive(Duration::ZERO).unwrap() {
            Action::Command(v) => {
                assert_eq!(v["playbackId"], "new");
                assert!(v.get("positionMs").is_none());
                assert!(v.get("subtitleCues").is_none());
            }
            _ => panic!("expected new load"),
        }
    }
    #[test]
    fn coalesced_load_keeps_its_subtitles_and_rejects_previous_playback() {
        let mailbox = Mailbox::default();
        mailbox.push(Action::Command(json!({"url":"http://localhost/new", "playbackId":"new"})));
        mailbox.push(Action::Command(json!({"playbackId":"new", "subtitleStreamIndex":-1,
            "subtitleCues":[{"start":1,"end":10,"text":"new subtitles"}]})));
        mailbox.push(Action::Command(json!({"playbackId":"old", "subtitleCues":[]})));
        let Some(Action::Command(command)) = mailbox.receive(Duration::ZERO) else {
            panic!("expected merged load");
        };
        assert_eq!(command["playbackId"], "new");
        let mut subtitles = Subtitles::default();
        subtitles.replace(&[json!({"start":0,"end":10,"text":"old subtitles"})]);
        subtitles.apply_command(&command, true);
        assert_eq!(subtitles.update(2.).as_deref(), Some("new subtitles"));
        // Identity survives dequeue: a late callback cannot enter an empty queue.
        mailbox.push(Action::Command(json!({"playbackId":"old", "subtitleCues":[]})));
        assert!(mailbox.receive(Duration::ZERO).is_none());
        subtitles.apply_command(&json!({"url":"http://localhost/third"}), true);
        assert_eq!(subtitles.update(2.).as_deref(), Some(""));
    }
    #[test]
    fn embedded_subtitle_selection_clears_external_cues() {
        let mut subtitles = Subtitles::default();
        subtitles.apply_command(&json!({"subtitleCues":[{"start":0,"end":5,"text":"external"}]}), false);
        assert_eq!(subtitles.update(1.).as_deref(), Some("external"));
        subtitles.apply_command(&json!({"subtitleStreamIndex":2}), false);
        assert_eq!(subtitles.update(1.).as_deref(), Some(""));
    }
    #[test]
    fn transient_seek_eof_never_finishes_the_room() {
        assert!(!stable_eof(true, true, false, true, 120., 120.));
        assert!(!stable_eof(false, false, false, true, 120., 120.));
        assert!(!stable_eof(true, false, true, true, 120., 120.));
        assert!(!stable_eof(true, false, false, true, 40., 120.));
        assert!(stable_eof(true, false, false, true, 119.9, 120.));
        assert_eq!(seek_position(120., 120.), 119.95);
        assert_eq!(seek_position(-1., 120.), 0.);
    }
    #[test]
    fn subtitle_cursor_handles_overlap_seek_and_replacement() {
        let mut subtitles = Subtitles::default();
        subtitles.replace(&[
            json!({"start":3,"end":6,"text":"second"}),
            json!({"start":1,"end":4,"text":"first"}),
        ]);
        assert_eq!(subtitles.update(1.5).as_deref(), Some("first"));
        assert_eq!(subtitles.update(1.6), None);
        assert_eq!(subtitles.update(3.5).as_deref(), Some("first\nsecond"));
        assert_eq!(subtitles.update(4.5).as_deref(), Some("second"));
        assert_eq!(subtitles.update(1.5).as_deref(), Some("first"));
        assert_eq!(subtitles.update(7.).as_deref(), Some(""));
        subtitles.replace(&[json!({"start":1,"end":8,"text":"new"})]);
        assert_eq!(subtitles.update(7.).as_deref(), Some("new"));
        subtitles.clear();
        assert_eq!(subtitles.update(7.).as_deref(), Some(""));
    }
    #[test]
    fn empty_room_updates_do_not_start_player() {
        let player = Media::new(Weak::new(), PathBuf::from("unused-empty-room-cache"));
        assert!(player.command(json!({"bounds":{"x":0,"y":0,"width":640,"height":360},"visible":false,"volume":0.4})).is_ok());
        assert!(player.sender.lock().unwrap().is_none());
        assert_eq!(player.hwnd.load(Ordering::Acquire), 0);
    }
    #[test]
    fn tracks_use_ffmpeg_index_and_type() {
        let tracks = json!([{"id":1,"type":"video","ff-index":0},{"id":1,"type":"audio","ff-index":1},{"id":2,"type":"audio","ff-index":3},{"id":1,"type":"sub","ff-index":2}]);
        assert_eq!(track_id(&tracks, "audio", 3), Some(2));
        assert_eq!(track_id(&tracks, "sub", 2), Some(1));
        assert_eq!(track_id(&tracks, "audio", 2), None);
    }
    #[test]
    fn rejects_bad_geometry_and_subtitles() {
        assert!(
            validate_command(&json!({"bounds":{"x":0,"y":0,"width":640,"height":360}})).is_ok()
        );
        assert!(
            validate_command(&json!({"bounds":{"x":"bad","y":0,"width":640,"height":360}}))
                .is_err()
        );
        assert!(
            validate_command(&json!({"subtitleCues":[{"start":2,"end":1,"text":"bad"}]})).is_err()
        );
    }
    #[test]
    fn subtitle_text_cannot_inject_ass_tags() {
        let text = ass_text("{\\p1}m 0 0\nnext");
        assert!(!text.contains("{\\p1}"));
        assert!(text.contains("\\Nnext"));
    }
}
