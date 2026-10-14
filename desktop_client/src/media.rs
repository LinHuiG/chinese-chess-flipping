//! Windows libmpv viewport. URLs stay in-process; the DLL never reads user mpv
//! configuration, scripts, cookies or account headers. Only the approved Emby
//! origin may initiate a load; ordinary media redirects may reach a CDN.
use crate::AppState;
use libloading::Library;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    ffi::{c_char, c_int, c_void, CStr, CString},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicIsize, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

extern "C" {
    fn cyber_media_window_create(parent: *mut c_void) -> *mut c_void;
    fn cyber_media_window_bounds(
        window: *mut c_void,
        x: c_int,
        y: c_int,
        width: c_int,
        height: c_int,
        visible: c_int,
    );
    fn cyber_media_window_hide(window: *mut c_void);
    fn cyber_media_window_visible(window: *mut c_void);
    fn cyber_media_window_destroy(window: *mut c_void);
}
enum Action {
    Command(Value),
    Foreground(bool),
    Stop,
    Shutdown,
}
pub struct Media {
    state: Weak<AppState>,
    directory: PathBuf,
    sender: Mutex<Option<SyncSender<Action>>>,
    hwnd: AtomicIsize,
    visible: AtomicBool,
    foreground: AtomicBool,
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
        let parent = window.hwnd().map_err(|_| "无法取得播放窗口")?.0 as isize;
        let (answer, receive) = mpsc::sync_channel(1);
        window
            .run_on_main_thread(move || {
                let hwnd = unsafe { cyber_media_window_create(parent as *mut c_void) };
                let _ = answer.send(hwnd as isize);
            })
            .map_err(|_| "无法创建播放窗口")?;
        let hwnd = receive
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "播放窗口创建超时")?;
        if hwnd == 0 {
            return Err("无法创建播放窗口".into());
        }
        self.hwnd.store(hwnd, Ordering::Release);
        let (tx, rx) = mpsc::sync_channel(64);
        let owner = self.clone();
        std::thread::Builder::new().name("cyber-player".into()).spawn(move||{
            let result=Player::open(&owner.directory,hwnd).and_then(|mut player|{
                let mut last=Instant::now();
                loop {
                    match rx.recv_timeout(Duration::from_millis(30)) {
                        Ok(Action::Command(value))=>if let Err(error)=player.command(value){owner.emit(json!({"type":"player","error":error,"playing":false}));},
                        Ok(Action::Foreground(value))=>{player.foreground=value;if !value{let _=player.mpv.set("pause","yes");}},
                        Ok(Action::Stop)=>{player.stop();},
                        Ok(Action::Shutdown)|Err(mpsc::RecvTimeoutError::Disconnected)=>break,
                        Err(mpsc::RecvTimeoutError::Timeout)=>{}
                    }
                    player.events(&owner);
                    player.overlay();
                    if last.elapsed()>=Duration::from_millis(250){owner.emit(player.state());last=Instant::now();}
                } Ok(())
            });
            if let Err(error)=result{owner.emit(json!({"type":"player","error":error,"playing":false,"nativeUnavailable":true}));}
            if let Some(s)=owner.state.upgrade(){if let Some(w)=s.handle.get_webview_window("main"){let _=w.run_on_main_thread(move||unsafe{cyber_media_window_destroy(hwnd as *mut c_void)});}}
            owner.hwnd.store(0,Ordering::Release);
            owner.sender.lock().unwrap().take();
        }).map_err(|_|"无法启动播放器线程")?;
        *sender = Some(tx);
        Ok(())
    }
    pub fn command(self: &Arc<Self>, value: Value) -> Result<(), String> {
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
        let visible =
            self.visible.load(Ordering::Acquire) && self.foreground.load(Ordering::Acquire);
        let hwnd = self.hwnd.load(Ordering::Acquire);
        w.run_on_main_thread(move || unsafe {
            if hwnd != 0 {
                cyber_media_window_bounds(hwnd as *mut c_void, x, y, width, height, visible as i32)
            }
        })
        .map_err(|_| "播放器尺寸更新失败".into())
    }
    fn send(&self, action: Action) -> Result<(), String> {
        if let Some(sender) = self.sender.lock().unwrap().as_ref() {
            sender
                .try_send(action)
                .map_err(|_| "播放器忙碌，请重试".into())
        } else {
            Ok(())
        }
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
        // Stop/permission revocation must not be dropped when geometry updates
        // have temporarily filled the bounded command queue.
        if let Some(sender) = self.sender.lock().unwrap().as_ref() {
            let _ = sender.send(Action::Stop);
        }
    }
    pub fn shutdown(&self) {
        self.hide();
        if let Some(sender) = self.sender.lock().unwrap().take() {
            let _ = sender.send(Action::Shutdown);
        }
    }
}

fn validate_command(value: &Value) -> Result<(), String> {
    if !value.is_object() || value.to_string().len() > 4_194_304 {
        return Err("播放参数过大".into());
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
    set_property: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int,
    get_property: unsafe extern "C" fn(*mut c_void, *const c_char, c_int, *mut c_void) -> c_int,
    free_node: unsafe extern "C" fn(*mut Node),
    command_async: unsafe extern "C" fn(*mut c_void, u64, *const *const c_char) -> c_int,
    wait_event: unsafe extern "C" fn(*mut c_void, f64) -> *mut Event,
}
impl Mpv {
    fn open(path: &Path, hwnd: isize) -> Result<Self, String> {
        unsafe {
            use libloading::os::windows::Library as WindowsLibrary;
            let library: Library = WindowsLibrary::load_with_flags(path, 0x00000100 | 0x00000800)
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
                set_property: symbol!("mpv_set_property_string"),
                get_property: symbol!("mpv_get_property"),
                free_node: symbol!("mpv_free_node_contents"),
                command_async: symbol!("mpv_command_async"),
                wait_event: symbol!("mpv_wait_event"),
                handle,
                _library: library,
            };
            for (key, value) in [
                ("config", "no"),
                ("terminal", "no"),
                ("msg-level", "all=no"),
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
            Ok(api)
        }
    }
    fn opt(&self, key: &str, value: &str) -> Result<(), String> {
        self.string_call(self.option, key, value)
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.string_call(self.set_property, key, value)
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
        let values: Vec<CString> = args
            .iter()
            .map(|s| CString::new(*s))
            .collect::<Result<_, _>>()
            .map_err(|_| "播放参数无效")?;
        let mut pointers: Vec<*const c_char> = values.iter().map(|v| v.as_ptr()).collect();
        pointers.push(std::ptr::null());
        if unsafe { (self.command_async)(self.handle, 0, pointers.as_ptr()) } < 0 {
            Err("播放器命令失败".into())
        } else {
            Ok(())
        }
    }
    fn get(&self, key: &str) -> Value {
        let Ok(key) = CString::new(key) else {
            return Value::Null;
        };
        let mut node = Node {
            format: 0,
            value: NodeValue { integer: 0 },
        };
        unsafe {
            if (self.get_property)(
                self.handle,
                key.as_ptr(),
                6,
                &mut node as *mut _ as *mut c_void,
            ) < 0
            {
                return Value::Null;
            }
            let value = node_value(&node, 0);
            (self.free_node)(&mut node);
            value
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
    cues: Vec<Value>,
    subtitle_offset: f64,
    bullets: VecDeque<Bullet>,
    audio_index: Option<i64>,
    subtitle_index: Option<i64>,
    media_tracks: Vec<Value>,
    last_overlay: String,
}
impl Player {
    fn open(directory: &Path, hwnd: isize) -> Result<Self, String> {
        Ok(Self {
            mpv: Mpv::open(&library_path(directory)?, hwnd)?,
            loaded: false,
            foreground: true,
            playing: false,
            url: String::new(),
            error: String::new(),
            first_frame: false,
            rate: 1.,
            volume: 1.,
            muted: false,
            cues: Vec::new(),
            subtitle_offset: 0.,
            bullets: VecDeque::new(),
            audio_index: None,
            subtitle_index: Some(-1),
            media_tracks: Vec::new(),
            last_overlay: String::new(),
        })
    }
    fn command(&mut self, q: Value) -> Result<(), String> {
        if q.get("url")
            .and_then(Value::as_str)
            .is_some_and(|url| url != self.url || !self.error.is_empty())
        {
            self.audio_index = None;
            self.subtitle_index = Some(-1);
            self.media_tracks.clear();
        }
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
        if let Some(v) = q.get("subtitleCues").and_then(Value::as_array) {
            self.cues = v.clone();
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
            if v >= 0 {
                self.cues.clear();
            }
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
            if url != self.url || !self.error.is_empty() {
                self.url = url.into();
                self.loaded = false;
                self.first_frame = false;
                self.error.clear();
                self.cues.clear();
                self.mpv.set("pause", "yes")?;
                self.mpv.set("sid", "no")?;
                self.mpv.set("aid", "auto")?;
                let start = q["positionMs"].as_f64().unwrap_or(0.).max(0.) / 1000.;
                self.mpv.set("start", &start.to_string())?;
                self.mpv.command(&["loadfile", url, "replace"])?;
                changed = true;
            }
        }
        if !changed && self.loaded {
            if let Some(position) = q.get("positionMs").and_then(Value::as_f64) {
                self.mpv.command(&[
                    "seek",
                    &(position.max(0.) / 1000.).to_string(),
                    "absolute+exact",
                ])?;
            }
            if q.get("audioStreamIndex").is_some() || q.get("subtitleStreamIndex").is_some() {
                self.apply_tracks()?;
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
    fn events(&mut self, owner: &Media) {
        loop {
            let event = unsafe { &*(self.mpv.wait_event)(self.mpv.handle, 0.) };
            if event.id == 0 {
                break;
            }
            match event.id {
                8 => {
                    self.loaded = true;
                    self.error.clear();
                    if let Err(error) = self.apply_tracks() {
                        self.error = error;
                        owner.emit(json!({"type":"player","error":self.error}));
                    }
                }
                7 => {
                    if !event.data.is_null() {
                        #[repr(C)]
                        struct End {
                            reason: c_int,
                            error: c_int,
                        }
                        let end = unsafe { &*(event.data as *const End) };
                        if end.reason == 4 || end.error < 0 {
                            self.error = "原生播放器无法读取或解码此片源，请重试或切换画质".into();
                            self.playing = false;
                        }
                    }
                }
                17 => {
                    if self.loaded {
                        self.first_frame = true;
                    }
                }
                _ => {}
            }
        }
    }
    fn state(&mut self) -> Value {
        let time = self.mpv.get("time-pos").as_f64().unwrap_or(0.);
        let duration = self.mpv.get("duration").as_f64().unwrap_or(0.);
        let paused = self.mpv.get("pause").as_bool().unwrap_or(true);
        let buffering = self.mpv.get("paused-for-cache").as_bool().unwrap_or(false);
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
        json!({"type":"player","positionMs":time*1000.,"durationMs":duration*1000.,"playing":self.loaded&&!paused&&!buffering,"buffering":!self.url.is_empty()&&(!self.loaded||buffering)&&self.error.is_empty(),"ended":self.mpv.get("eof-reached").as_bool().unwrap_or(false),"renderedFirstFrame":self.first_frame,"error":self.error,"rate":self.rate,"volume":self.volume,"muted":self.muted,"audioPresent":audio_present,"audioSupported":if self.loaded&&audio_present{json!(!audio.is_null())}else{Value::Null},"audioSelected":selected.is_number(),"audioMime":audio,"audioChannels":self.mpv.get("audio-out-params/channel-count"),"audioSampleRate":self.mpv.get("audio-out-params/samplerate"),"audioOutputAdvancing":self.loaded&&!paused&&!buffering&&selected.is_number(),"audioStreamIndex":audio_index,"subtitleStreamIndex":subtitle_index,"audioPcmPeak":peak,"audioPcmFrames":number("af-metadata/diagnostics/lavfi.astats.Overall.Number_of_samples"),"subtitleCues":self.cues.len(),"audioOutput":self.mpv.get("current-ao"),"videoOutput":self.mpv.get("current-vo"),"engine":"mpv"})
    }
    fn overlay(&mut self) {
        self.bullets
            .retain(|b| b.start.elapsed() < Duration::from_secs(8));
        let time = self.mpv.get("time-pos").as_f64().unwrap_or(0.) + self.subtitle_offset;
        let mut text = String::new();
        let subtitle = self
            .cues
            .iter()
            .filter(|c| {
                time >= c["start"].as_f64().unwrap_or(0.) && time < c["end"].as_f64().unwrap_or(0.)
            })
            .take(4)
            .filter_map(|c| c["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if !subtitle.is_empty() {
            text.push_str(&format!(
                "{{\\an2\\pos(640,674)\\fs32\\bord2\\shad1\\c&HFFFFFF&}}{}",
                ass_text(&subtitle)
            ));
        }
        for bullet in &self.bullets {
            let progress = bullet.start.elapsed().as_secs_f64() / 8.;
            let width = (bullet.text.chars().count() as f64 * 28.).min(6720.);
            let x = 1280. - progress * (1280. + width);
            text.push_str(&format!(
                "\n{{\\an7\\pos({x:.0},{})\\fs27\\bord1.5\\shad0\\c&HFFFFFF&}}{}",
                35 + bullet.lane * 42,
                ass_text(&bullet.text)
            ));
        }
        if text != self.last_overlay {
            let _ =
                self.mpv
                    .command(&["osd-overlay", "1", "ass-events", &text, "1280", "720", "10"]);
            self.last_overlay = text;
        }
    }
    fn stop(&mut self) {
        let _ = self.mpv.command(&["stop"]);
        self.loaded = false;
        self.playing = false;
        self.url.clear();
        self.error.clear();
        self.first_frame = false;
        self.cues.clear();
        self.bullets.clear();
        self.audio_index = None;
        self.subtitle_index = Some(-1);
        self.media_tracks.clear();
        self.overlay();
    }
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
