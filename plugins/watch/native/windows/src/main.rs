//! Official movie native component. Private stdin/stdout IPC; no listener or shell interface.
mod audio;
mod media;
mod media_http;
mod media_runtime;
mod window;
mod wire;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};

#[derive(Clone)]
pub struct Output(mpsc::SyncSender<Value>);
impl Output {
    fn event(&self, value: Value) {
        let _ = self.0.send(value);
    }
    fn packet(&self, peer: Option<&str>, packet: wire::Packet) -> bool {
        self.0.try_send(json!({"event":"send","peer":peer,"packet":B64.encode(packet.plain()),"at":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64})).is_ok()
    }
}
pub struct Network {
    output: Output,
    queued: AtomicU64,
}
impl Network {
    pub fn queued_ms(&self) -> u64 {
        self.queued.load(Ordering::Relaxed)
    }
    pub fn send(&self, packet: wire::Packet) -> bool {
        self.output.packet(None, packet)
    }
}
pub struct Udp {
    output: Output,
}
impl Udp {
    pub fn send(&self, id: &str, packet: &wire::Packet) -> bool {
        self.output.packet(Some(id), packet.clone())
    }
}
pub struct AppState {
    output: Output,
    handle: window::Window,
    pub network: Network,
    pub udp: Mutex<Option<Udp>>,
    voice: Arc<audio::Voice>,
    player: Arc<media::Media>,
    media_origin: Mutex<Option<reqwest::Url>>,
    http: reqwest::Client,
}
impl AppState {
    pub fn event(&self, value: Value) {
        self.output.event(json!({"event":"native","value":value}));
    }
}
fn media_target_allowed(origin: Option<&reqwest::Url>, url: &reqwest::Url) -> bool {
    origin.is_some_and(|a| a.origin() == url.origin())
        && url.username().is_empty()
        && url.password().is_none()
}
async fn call(
    state: Arc<AppState>,
    method: &str,
    args: &[Value],
    scope: &Value,
) -> Result<Value, String> {
    let parse = || -> Result<Value, String> {
        serde_json::from_str(args.first().and_then(Value::as_str).ok_or("参数无效")?)
            .map_err(|_| "参数格式无效".into())
    };
    match method {
        "voiceConfigure" => {
            state
                .voice
                .configure(serde_json::from_value(parse()?).map_err(|_| "音频参数无效")?)?;
            state
                .output
                .event(json!({"event":"subscribe","types":["voice"]}));
        }
        "voiceMicrophone" => {
            return Ok(json!(state.voice.microphone(
                args.first().and_then(Value::as_bool).unwrap_or(false)
            )));
        }
        "voiceStop" => state.voice.stop(),
        "playerCommand" => {
            let mut command = parse()?;
            if let Some(bounds) = command.get_mut("bounds") {
                for axis in ["x", "y"] {
                    bounds[axis] = json!(
                        bounds[axis].as_f64().unwrap_or(0.)
                            + scope["viewport"][axis].as_f64().unwrap_or(0.)
                    );
                }
            }
            state.player.command(command)?;
        }
        "playerStop" => state.player.stop(),
        "mediaConfigure" => {
            let config = parse()?;
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
        }
        "mediaRequest" => {
            let q = parse()?;
            let id = q.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
            tokio::spawn(async move {
                let event = match media_http::media_request(&state, q).await {
                    Ok((status, body, image)) => {
                        if image {
                            json!({"type":"mediaResponse","id":id,"status":status,"dataUrl":body})
                        } else {
                            json!({"type":"mediaResponse","id":id,"status":status,"body":body})
                        }
                    }
                    Err(error) => json!({"type":"mediaResponse","id":id,"status":0,"error":error}),
                };
                state.event(event);
            });
        }
        _ => return Err("组件没有此接口".into()),
    }
    Ok(json!(true))
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut lines = std::io::stdin().lock().lines();
    let first = lines.next().ok_or("Missing initialization")??;
    if first.len() > 8192 {
        return Err("Initialization too large".into());
    }
    let init: Value = serde_json::from_str(&first)?;
    let parent = init["parent"].as_i64().ok_or("Missing parent")? as isize;
    let directory = PathBuf::from(init["directory"].as_str().ok_or("Missing directory")?);
    let (tx, rx) = mpsc::sync_channel(128);
    std::thread::spawn(move || {
        let stdout = std::io::stdout();
        let mut stream = std::io::BufWriter::new(stdout.lock());
        for value in rx {
            if serde_json::to_writer(&mut stream, &value).is_err()
                || stream.write_all(b"\n").is_err()
                || stream.flush().is_err()
            {
                break;
            }
        }
    });
    let output = Output(tx);
    let state = Arc::new_cyclic(|weak| AppState {
        output: output.clone(),
        handle: window::Window::new(parent, init["scale"].as_f64().unwrap_or(1.)),
        network: Network {
            output: output.clone(),
            queued: AtomicU64::new(0),
        },
        udp: Mutex::new(Some(Udp {
            output: output.clone(),
        })),
        voice: audio::Voice::new(weak.clone()),
        player: media::Media::new(weak.clone(), directory.clone()),
        media_origin: Mutex::new(None),
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap(),
    });
    output.event(json!({"event":"ready","api":1}));
    // Reading commands on this dedicated entry thread leaves audio, IO and window work independent.
    for line in lines {
        let line = line?;
        if line.len() > 6 * 1024 * 1024 {
            break;
        }
        let Ok(q) = serde_json::from_str::<Value>(&line) else {
            break;
        };
        match q["method"].as_str().unwrap_or("") {
            "shutdown" => break,
            "foreground" => {
                let value = q["value"].as_bool().unwrap_or(false);
                state.player.foreground(value);
                if !value {
                    state.voice.mute();
                }
                if let Some(scale) = q["scale"].as_f64() {
                    state.handle.set_scale(scale);
                }
            }
            "packet" => {
                if let Some(bytes) = q["packet"].as_str().and_then(|s| B64.decode(s).ok()) {
                    if let Ok(packet) = wire::Packet::parse(&bytes) {
                        state.voice.receive(&packet, q["peer"].as_str());
                    }
                }
            }
            "networkChanged" => state.voice.mute(),
            "network" => state
                .network
                .queued
                .store(q["queuedMs"].as_u64().unwrap_or(0), Ordering::Relaxed),
            method => {
                let id = q["id"].clone();
                let result = call(
                    state.clone(),
                    method,
                    q["args"].as_array().map(Vec::as_slice).unwrap_or(&[]),
                    &q["scope"],
                )
                .await;
                output.event(match result {
                    Ok(value) => json!({"reply":id,"value":value}),
                    Err(error) => json!({"reply":id,"error":error}),
                });
            }
        }
    }
    state.voice.shutdown();
    state.player.shutdown();
    // Process lifetime owns all media threads and handles; no native code is loaded into the host.
    std::process::exit(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_http::media_image_data_url;
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
}
