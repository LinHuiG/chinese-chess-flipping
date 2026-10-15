#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod audio;
mod lifecycle;
mod media;
mod media_runtime;
mod network;
mod udp;
mod watch_save;
mod wire;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
#[derive(Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Settings {
    host: String,
    port: u16,
    transport: String,
    nickname: String,
    sound: bool,
    motion: bool,
    version: String,
    platform: String,
    #[serde(rename = "nativeMedia")]
    native_media: bool,
    #[serde(rename = "nativeVoice")]
    native_voice: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            host: "fqgame.tdcode.tech".into(),
            port: 8888,
            transport: "TCP".into(),
            nickname: "".into(),
            sound: true,
            motion: true,
            version: env!("CARGO_PKG_VERSION").into(),
            platform: "WINDOWS".into(),
            native_media: true,
            native_voice: true,
        }
    }
}
pub struct AppState {
    handle: tauri::AppHandle,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    watch_save: watch_save::WatchSave,
    pub network: Arc<network::Network>,
    pub udp: Mutex<Option<Arc<udp::Udp>>>,
    pub voice: Arc<audio::Voice>,
    player: Arc<media::Media>,
    media_origin: Mutex<Option<reqwest::Url>>,
    http: reqwest::Client,
    visibility: Mutex<lifecycle::Visibility>,
}
impl AppState {
    pub fn event(&self, value: Value) {
        if let Some(window) = self.handle.get_webview_window("main") {
            let _ = window.eval(&format!(
                "window.dispatchEvent(new CustomEvent('native-room',{{detail:{value}}}));"
            ));
        }
    }
    fn shutdown(&self) {
        self.player.shutdown();
        self.voice.shutdown();
        self.network.disconnect();
        if let Some(u) = self.udp.lock().unwrap().as_ref() {
            u.close()
        }
    }
    fn refresh_visibility(&self, resumed: bool) {
        let Some(window) = self.handle.get_webview_window("main") else {
            return;
        };
        let (Ok(minimized), Ok(visible)) = (window.is_minimized(), window.is_visible()) else {
            return;
        };
        let mut state = self.visibility.lock().unwrap();
        let change = state.update(minimized, visible, lifecycle::session_locked());
        let background = state.background();
        drop(state);
        self.player.foreground(!background);
        if background || resumed {
            self.voice.mute();
        }
        if let Some(background) = change {
            self.event(json!({"type":if background{"background"}else{"foreground"}}));
        } else if resumed && !background {
            self.event(json!({"type":"foreground"}));
        }
    }
}
fn string(args: &[Value], i: usize) -> Result<&str, String> {
    args.get(i)
        .and_then(Value::as_str)
        .ok_or_else(|| "参数无效".into())
}
fn parse_arg<T: serde::de::DeserializeOwned>(args: &[Value], i: usize) -> Result<T, String> {
    serde_json::from_str(string(args, i)?).map_err(|_| "参数格式无效".into())
}
fn local_url(url: &reqwest::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none())
}
fn media_target_allowed(origin: Option<&reqwest::Url>, url: &reqwest::Url) -> bool {
    origin.is_some_and(|a| a.origin() == url.origin())
        && url.username().is_empty()
        && url.password().is_none()
}
#[tauri::command]
async fn native_call(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
    method: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    if window.label() != "main" || !window.url().is_ok_and(|url| local_url(&url)) {
        return Err("仅可信本地界面可调用".into());
    }
    let state = state.inner().clone();
    match method.as_str() {
        "watchSaveRead" => Ok(json!(state.watch_save.read()?)),
        "watchSaveWrite" => {
            let text = match args.first() {
                Some(Value::Null) => None,
                _ => Some(string(&args, 0)?),
            };
            state.watch_save.write(text)?;
            Ok(json!(true))
        }
        "configure" => {
            let mut s: Settings = parse_arg(&args, 0)?;
            s.host = s.host.trim().into();
            if s.host.is_empty()
                || s.host.len() > 253
                || s.host
                    .chars()
                    .any(|c| c.is_whitespace() || matches!(c, '/' | '\\' | '@' | '?' | '#'))
                || s.port == 0
                || !matches!(s.transport.as_str(), "TCP" | "HTTP" | "HTTPS")
            {
                return Err("服务器设置无效".into());
            }
            s.version = env!("CARGO_PKG_VERSION").into();
            s.platform = "WINDOWS".into();
            s.native_media = true;
            s.native_voice = true;
            s.nickname = s.nickname.chars().take(32).collect();
            let text = serde_json::to_string(&s).map_err(|_| "保存失败")?;
            std::fs::write(&state.settings_path, &text).map_err(|_| "设置保存失败")?;
            *state.settings.lock().unwrap() = s;
            Ok(json!(text))
        }
        "connect" => {
            let identity: Value = parse_arg(&args, 0)?;
            if !identity.is_object() {
                return Err("身份无效".into());
            }
            state.network.connect(
                state.clone(),
                state.settings.lock().unwrap().clone(),
                identity,
            );
            Ok(json!(true))
        }
        "disconnect" => {
            state.network.disconnect();
            state.voice.mute();
            if let Some(u) = state.udp.lock().unwrap().as_ref() {
                u.clear()
            }
            Ok(json!(true))
        }
        "send" => {
            let data = string(&args, 0)?;
            if data.len() > 100000 {
                return Ok(json!(false));
            }
            let b = B64.decode(data).map_err(|_| "报文无效")?;
            Ok(json!(state.network.send(wire::Packet::parse(&b)?)))
        }
        "udpRegister" => {
            let id = string(&args, 0)?.to_owned();
            let ticket = string(&args, 1)?.to_owned();
            let port = args
                .get(2)
                .and_then(Value::as_u64)
                .filter(|p| *p > 0 && *p <= 65535)
                .ok_or("UDP端口无效")? as u16;
            let host = state.settings.lock().unwrap().host.clone();
            let udp = state.udp.lock().unwrap().clone();
            if let Some(udp) = udp {
                tauri::async_runtime::spawn_blocking(move || {
                    udp.register(&host, port, &id, &ticket)
                })
                .await
                .map_err(|_| "UDP登记失败")??;
            }
            Ok(json!(true))
        }
        "openPeer" => {
            if string(&args, 0)?.len() > 8192 {
                return Err("Peer过大".into());
            }
            let config = parse_arg(&args, 0)?;
            if let Some(udp) = state.udp.lock().unwrap().as_ref() {
                udp.open(config)?;
            }
            Ok(json!(true))
        }
        "sendPeer" => {
            let id = string(&args, 0)?;
            let data = string(&args, 1)?;
            if data.len() > 100000 {
                return Ok(json!(false));
            }
            let p = wire::Packet::parse(&B64.decode(data).map_err(|_| "报文无效")?)?;
            Ok(json!(state
                .udp
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|u| u.send(id, &p))))
        }
        "closePeers" => {
            if let Some(udp) = state.udp.lock().unwrap().as_ref() {
                udp.clear()
            }
            Ok(json!(true))
        }
        "roomActive" => Ok(json!(true)),
        "voiceConfigure" => {
            state.voice.configure(parse_arg(&args, 0)?)?;
            Ok(json!(true))
        }
        "voiceMicrophone" => Ok(json!(state
            .voice
            .microphone(args.first().and_then(Value::as_bool).unwrap_or(false)))),
        "voiceStop" => {
            state.voice.stop();
            Ok(json!(true))
        }
        "mediaConfigure" => {
            let config: Value = parse_arg(&args, 0)?;
            let raw = config.get("origin").and_then(Value::as_str).unwrap_or("");
            let origin = if raw.is_empty() {
                None
            } else {
                let url = reqwest::Url::parse(raw).map_err(|_| "片源地址无效")?;
                if !matches!(url.scheme(), "http" | "https")
                    || url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    return Err("片源地址无效".into());
                }
                Some(url)
            };
            let mut current = state.media_origin.lock().unwrap();
            if current.as_ref().map(|u| u.origin()) != origin.as_ref().map(|u| u.origin()) {
                state.player.stop();
            }
            *current = origin;
            Ok(json!(true))
        }
        "playerCommand" => {
            state.player.command(parse_arg(&args, 0)?)?;
            Ok(json!(true))
        }
        "playerStop" => {
            state.player.stop();
            Ok(json!(true))
        }
        "windowFullscreen" => {
            let enabled = args
                .first()
                .and_then(Value::as_bool)
                .ok_or("全屏参数无效")?;
            window
                .set_fullscreen(enabled)
                .map_err(|e| format!("切换全屏失败：{e}"))?;
            Ok(json!(true))
        }
        "windowState" if std::env::var("CYBER_ROOM_MEDIA_DIAGNOSTICS").as_deref() == Ok("1") => {
            let monitor = window.current_monitor().map_err(|e| e.to_string())?;
            Ok(
                json!({"fullscreen":window.is_fullscreen().map_err(|e| e.to_string())?,
                "position":window.outer_position().map_err(|e| e.to_string())?,
                "size":window.outer_size().map_err(|e| e.to_string())?,
                "monitor":monitor.map(|m| json!({"position":m.position(),"size":m.size()}))}),
            )
        }
        "mediaRequest" => {
            let request: Value = parse_arg(&args, 0)?;
            let id = request.get("id").cloned().unwrap_or(Value::Null);
            let result = media_request(&state, request).await;
            let event = match result {
                Ok((status, body, image)) => {
                    if image {
                        json!({"type":"mediaResponse","id":id,"status":status,"body":"","dataUrl":body})
                    } else {
                        json!({"type":"mediaResponse","id":id,"status":status,"body":body})
                    }
                }
                Err(error) => json!({"type":"mediaResponse","id":id,"status":0,"error":error}),
            };
            state.event(event.clone());
            Ok(event)
        }
        "checkUpdate" => {
            state.event(json!({"type":"update","status":"Windows更新请从服务器网页下载最新运行包，关闭本程序后替换。","version":env!("CARGO_PKG_VERSION"),"busy":false,"ready":false}));
            Ok(json!(true))
        }
        "exitApp" => {
            state.shutdown();
            state.handle.exit(0);
            Ok(json!(true))
        }
        _ => Err("未知本地接口".into()),
    }
}
fn media_image_data_url(content_type: &str, bytes: &[u8]) -> Result<String, String> {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        mime.as_str(),
        "image/jpeg" | "image/png" | "image/webp" | "image/gif"
    ) {
        return Err("片源未返回支持的图片格式".into());
    }
    Ok(format!("data:{mime};base64,{}", B64.encode(bytes)))
}
async fn media_request(state: &AppState, value: Value) -> Result<(u16, String, bool), String> {
    let url = reqwest::Url::parse(
        value
            .get("url")
            .and_then(Value::as_str)
            .ok_or("媒体URL无效")?,
    )
    .map_err(|_| "媒体URL无效")?;
    let allowed = state.media_origin.lock().unwrap().clone();
    if !media_target_allowed(allowed.as_ref(), &url) {
        return Err("媒体请求必须使用已配置的片源地址".into());
    }
    let method = value.get("method").and_then(Value::as_str).unwrap_or("GET");
    if !matches!(method, "GET" | "POST" | "DELETE") {
        return Err("媒体请求方式不支持".into());
    }
    let image = value.get("responseType").and_then(Value::as_str) == Some("image");
    if image && method != "GET" {
        return Err("图片请求必须使用 GET".into());
    }
    let mut request = state
        .http
        .request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), url)
        .timeout(Duration::from_millis(
            value
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(20000)
                .clamp(1000, if image { 20000 } else { 60000 }),
        ));
    if let Some(headers) = value.get("headers").and_then(Value::as_object) {
        if headers.len() > 16 {
            return Err("媒体请求头过大".into());
        }
        for (k, v) in headers {
            if matches!(
                k.to_ascii_lowercase().as_str(),
                "host" | "connection" | "content-length" | "cookie"
            ) {
                return Err("不允许的请求头".into());
            }
            let v = v.as_str().filter(|v| v.len() <= 8192).ok_or("请求头无效")?;
            request = request.header(k, v);
        }
    }
    if let Some(body) = value.get("body") {
        let body = if let Some(s) = body.as_str() {
            s.to_string()
        } else {
            body.to_string()
        };
        if body.len() > 262144 {
            return Err("媒体请求过大".into());
        }
        request = request.body(body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "无法连接片源，请检查地址、网络或证书")?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if response.content_length().is_some_and(|n| n > 2097152) {
        return Err("片源响应过大".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "片源响应中断")?;
        if bytes.len() + chunk.len() > 2097152 {
            return Err("片源响应过大".into());
        }
        bytes.extend(chunk);
    }
    let body = if image {
        if (200..300).contains(&status) {
            media_image_data_url(&content_type, &bytes)?
        } else {
            String::new()
        }
    } else {
        String::from_utf8(bytes).map_err(|_| "片源应返回文本信息".to_string())?
    };
    Ok((status, body, image))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn poster_response_keeps_binary_bytes_and_rejects_html_svg() {
        let bytes = b"\x89PNG\r\n\x1a\n\xff\0";
        let encoded = media_image_data_url("IMAGE/PNG; charset=binary", bytes).unwrap();
        assert_eq!(
            B64.decode(encoded.split_once(',').unwrap().1).unwrap(),
            bytes
        );
        for mime in ["text/html", "image/svg+xml", "application/json", ""] {
            assert!(media_image_data_url(mime, bytes).is_err());
        }
    }
    #[test]
    fn native_bridge_is_restricted_to_embedded_origin() {
        for s in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
        ] {
            assert!(local_url(&reqwest::Url::parse(s).unwrap()));
        }
        for s in [
            "https://example.com/",
            "http://localhost:8095/",
            "http://tauri.localhost:8095/",
            "https://tauri.localhost.example.com/",
        ] {
            assert!(!local_url(&reqwest::Url::parse(s).unwrap()));
        }
    }
    #[test]
    fn emby_scope_includes_scheme_port_and_no_url_credentials() {
        let origin = reqwest::Url::parse("http://emby.example:8095/").unwrap();
        assert!(media_target_allowed(
            Some(&origin),
            &origin.join("Items?api_key=test").unwrap()
        ));
        for s in [
            "https://emby.example:8095/Items",
            "http://emby.example/Items",
            "http://other.example:8095/Items",
            "http://user:password@emby.example:8095/Items",
        ] {
            assert!(!media_target_allowed(
                Some(&origin),
                &reqwest::Url::parse(s).unwrap()
            ));
        }
        assert!(!media_target_allowed(None, &origin));
    }
    #[test]
    fn saved_settings_preserve_connection_and_default_missing_fields() {
        let defaults = Settings::default();
        assert_eq!(
            (
                defaults.host.as_str(),
                defaults.port,
                defaults.transport.as_str()
            ),
            ("fqgame.tdcode.tech", 8888, "TCP")
        );
        let saved: Settings = serde_json::from_str(
            r#"{"host":"127.0.0.1","port":18880,"transport":"HTTP","nickname":"测试用户"}"#,
        )
        .unwrap();
        let restored: Settings =
            serde_json::from_str(&serde_json::to_string(&saved).unwrap()).unwrap();
        assert_eq!(
            (
                restored.host.as_str(),
                restored.port,
                restored.transport.as_str()
            ),
            ("127.0.0.1", 18880, "HTTP")
        );
        assert_eq!(restored.nickname, "测试用户");
        assert!(restored.sound);
        assert!(restored.motion);
        assert_eq!(restored.version, env!("CARGO_PKG_VERSION"));
    }
}
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![native_call])
        .setup(|app| {
            let path = std::env::var_os("CYBER_ROOM_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_config_dir()?);
            std::fs::create_dir_all(&path)?;
            let settings_path = path.join("settings.json");
            let mut settings: Settings = std::fs::read(&settings_path)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_default();
            settings.version = env!("CARGO_PKG_VERSION").into();
            settings.platform = "WINDOWS".into();
            settings.native_media = true;
            settings.native_voice = true;
            let script = include_str!("bridge.js")
                .replace("__CYBER_SETTINGS__", &serde_json::to_string(&settings)?);
            let handle = app.handle().clone();
            let http = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(15))
                .build()?;
            let state = Arc::new_cyclic(|weak| AppState {
                handle: handle.clone(),
                settings: Mutex::new(settings),
                settings_path,
                watch_save: watch_save::WatchSave::new(path.clone()),
                network: Arc::new(network::Network::new()),
                udp: Mutex::new(None),
                voice: audio::Voice::new(weak.clone()),
                player: media::Media::new(weak.clone(), path.clone()),
                media_origin: Mutex::new(None),
                http,
                visibility: Mutex::new(lifecycle::Visibility::default()),
            });
            *state.udp.lock().unwrap() = udp::Udp::start(Arc::downgrade(&state)).ok();
            app.manage(state.clone());
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("赛博房间")
                    .inner_size(1120., 800.)
                    .min_inner_size(420., 620.)
                    .data_directory(path.join("webview"))
                    .initialization_script(script)
                    .on_navigation(local_url)
                    .build()?;
            let events = state.clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::Focused(_) | tauri::WindowEvent::Resized(_) => events.refresh_visibility(false),
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    events.voice.mute();
                    if let Some(window)=events.handle.get_webview_window("main"){
                        let script="Promise.race([Promise.resolve().then(()=>window.cyberDisconnect?.()),new Promise(r=>setTimeout(r,1500))]).catch(()=>{}).finally(()=>window.NativeRoom.exitApp());";
                        if window.eval(script).is_err(){events.shutdown();events.handle.exit(0);}
                    }
                },
                _ => {}
            });
            // A delayed tick indicates sleep/hibernate. Fresh foreground synchronization
            // and UDP discovery are handled by the same shared room lifecycle as Android.
            let sleeper = Arc::downgrade(&state);
            std::thread::Builder::new()
                .name("cyber-resume".into())
                .spawn(move || {
                    let mut last = Instant::now();
                    loop {
                        std::thread::sleep(Duration::from_millis(500));
                        let Some(s) = sleeper.upgrade() else { break };
                        let resumed=last.elapsed() > Duration::from_secs(6);
                        if resumed {
                            s.voice.mute();
                            if let Some(u) = s.udp.lock().unwrap().as_ref() {
                                u.clear()
                            }
                            s.event(json!({"type":"networkChanged"}));
                        }
                        s.refresh_visibility(resumed);
                        last = Instant::now();
                    }
                })?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("无法启动赛博房间，请检查 Windows WebView2 运行时");
}
