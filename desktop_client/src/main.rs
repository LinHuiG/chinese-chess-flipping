#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod extensions;
mod lifecycle;
mod network;
mod secure_store;
mod udp;
mod wire;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures_util::StreamExt;
use rand_core::{OsRng, RngCore};
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
        }
    }
}
pub struct AppState {
    bridge_token: String,
    handle: tauri::AppHandle,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    secure_store: secure_store::SecureStore,
    pub network: Arc<network::Network>,
    pub udp: Mutex<Option<Arc<udp::Udp>>>,
    pub extensions: extensions::Manager,
    http: reqwest::Client,
    visibility: Mutex<lifecycle::Visibility>,
}
impl AppState {
    pub fn event(&self, value: Value) {
        if let Some(window) = self.handle.get_webview_window("main") {
            let _ = window.eval(format!(
                "window.dispatchEvent(new CustomEvent('native-room',{{detail:{value}}}));"
            ));
        }
    }
    fn shutdown(&self) {
        self.extensions.stop();
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
        let scale = window.scale_factor().unwrap_or(1.);
        if resumed {
            self.extensions.foreground(false, scale);
        }
        self.extensions.foreground(!background, scale);
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
#[tauri::command]
async fn native_call(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
    method: String,
    args: Vec<Value>,
    token: String,
) -> Result<Value, String> {
    if token != state.bridge_token
        || window.label() != "main"
        || !window.url().is_ok_and(|url| local_url(&url))
    {
        return Err("仅可信本地界面可调用".into());
    }
    let state = state.inner().clone();
    match method.as_str() {
        "secureRead" => Ok(json!(state.secure_store.read(string(&args, 0)?)?)),
        "secureWrite" => {
            let text = match args.get(1) {
                Some(Value::Null) => None,
                _ => Some(string(&args, 1)?),
            };
            state.secure_store.write(string(&args, 0)?, text)?;
            Ok(json!(true))
        }
        "marketFetch" => {
            let url = reqwest::Url::parse(string(&args, 0)?).map_err(|_| "插件地址无效")?;
            let limit = args
                .get(1)
                .and_then(Value::as_u64)
                .filter(|v| *v > 0 && *v <= 24 * 1024 * 1024)
                .ok_or("下载大小无效")? as usize;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("插件地址无效".into());
            }
            let response = state
                .http
                .get(url)
                .timeout(Duration::from_secs(35))
                .send()
                .await
                .map_err(|_| "插件市场连接失败")?;
            if !response.status().is_success()
                || response.content_length().is_some_and(|v| v > limit as u64)
            {
                return Err("插件市场响应无效或文件过大".into());
            }
            let mut stream = response.bytes_stream();
            let mut data = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| "插件下载中断")?;
                if data.len() + chunk.len() > limit {
                    return Err("插件文件过大".into());
                }
                data.extend_from_slice(&chunk);
            }
            Ok(json!(String::from_utf8(data).map_err(|_| "插件编码无效")?))
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
            state.extensions.foreground(false, 1.);
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
        "extensionPrepare" => {
            let descriptor = parse_arg(&args, 0)?;
            Ok(json!(state
                .extensions
                .prepare(descriptor, &state.http)
                .await?
                .to_string()))
        }
        "extensionActivate" => {
            let descriptor = parse_arg(&args, 0)?;
            let next = state.clone();
            tauri::async_runtime::spawn_blocking(move || {
                next.extensions.activate(next.clone(), descriptor)
            })
            .await
            .map_err(|_| "组件启动失败")?
        }
        "extensionCall" => state.extensions.call(parse_arg(&args, 0)?).await,
        "extensionClose" => {
            tauri::async_runtime::spawn_blocking(move || state.extensions.stop())
                .await
                .map_err(|_| "组件关闭失败")?;
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
#[cfg(test)]
mod tests {
    use super::*;
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
            let mut secret = [0u8; 32];
            OsRng.fill_bytes(&mut secret);
            let bridge_token = B64.encode(secret);
            let script = include_str!("bridge.js")
                .replace("__CYBER_SETTINGS__", &serde_json::to_string(&settings)?)
                .replace("__CYBER_BRIDGE_TOKEN__", &serde_json::to_string(&bridge_token)?);
            let handle = app.handle().clone();
            let http = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(15))
                .build()?;
            let state = Arc::new(AppState {
                bridge_token,
                handle: handle.clone(),
                settings: Mutex::new(settings),
                settings_path,
                secure_store: secure_store::SecureStore::new(path.clone()),
                network: Arc::new(network::Network::new()),
                udp: Mutex::new(None),
                extensions: extensions::Manager::new(path.clone()),
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
                    events.extensions.foreground(false,1.);
                    if let Some(window)=events.handle.get_webview_window("main"){
                        let script="Promise.race([Promise.resolve().then(()=>window.cyberDisconnect?.()),new Promise(r=>setTimeout(r,8000))]).catch(()=>{}).finally(()=>window.NativeRoom.exitApp());";
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
                            s.extensions.foreground(false,1.);
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
