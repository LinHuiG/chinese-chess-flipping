use crate::{
    wire::{self, Packet},
    AppState, Settings,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures_util::{SinkExt, StreamExt};
use p256::SecretKey;
use rand_core::OsRng;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt},
    net::{lookup_host, TcpStream},
    sync::mpsc,
    time::timeout,
};

fn socket_error(error: &io::Error) -> String {
    use io::ErrorKind::*;
    match error.kind() {
        ConnectionRefused => "服务端 TCP 连接被拒绝，请检查服务是否启动、端口和防火墙".into(),
        TimedOut => "服务端 TCP 连接超时，请检查网络、端口和防火墙".into(),
        PermissionDenied => "系统拒绝连接服务端，请检查本机网络权限或防火墙".into(),
        ConnectionReset | ConnectionAborted | BrokenPipe | UnexpectedEof => {
            "服务端 TCP 连接已中断，正在重新连接".into()
        }
        _ => "无法连接服务端 TCP 端口，请检查网络、服务器地址和端口".into(),
    }
}
// Resolve separately so DNS failure is not confused with a refused TCP port.
// Both TCP and WS use the same bounded connection stage; WSS still verifies TLS
// against the original hostname, never the resolved address.
async fn server_socket(host: &str, port: u16) -> Result<TcpStream, String> {
    let addresses: Vec<_> = timeout(Duration::from_secs(5), lookup_host((host, port)))
        .await
        .map_err(|_| "服务端地址解析超时（5 秒），请检查 DNS 或服务器地址")?
        .map_err(|_| "服务端地址解析失败，请检查 DNS 或服务器地址")?
        .collect();
    if addresses.is_empty() {
        return Err("服务端地址解析未返回可用地址".into());
    }
    let stream = timeout(
        Duration::from_secs(8),
        TcpStream::connect(addresses.as_slice()),
    )
    .await
    .map_err(|_| "服务端 TCP 连接超时（8 秒），请检查网络、端口和防火墙")?
    .map_err(|error| socket_error(&error))?;
    stream
        .set_nodelay(true)
        .map_err(|_| "服务端 TCP 连接初始化失败")?;
    Ok(stream)
}
fn websocket_error(error: &tokio_tungstenite::tungstenite::Error) -> String {
    use tokio_tungstenite::tungstenite::Error;
    match error {
        Error::Tls(_) => "服务端 TLS 握手失败，请检查 HTTPS 证书、系统时间和网络".into(),
        Error::Http(response) => format!(
            "服务端 WebSocket 接入被拒绝（HTTP {}），请检查反向代理和 /ws 地址",
            response.status().as_u16()
        ),
        Error::Io(error) => socket_error(error),
        Error::Url(_) => "服务端 WebSocket 地址无效，请检查服务器设置".into(),
        Error::ConnectionClosed | Error::AlreadyClosed => {
            "服务端 WebSocket 已关闭，正在重新连接".into()
        }
        _ => "服务端 WebSocket 握手或协议异常，请检查服务器版本和反向代理".into(),
    }
}
async fn websocket_ready<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
) -> Result<Packet, String> {
    timeout(Duration::from_secs(8), async {
        loop {
            let message = socket
                .next()
                .await
                .ok_or("服务端在身份确认前关闭连接")?
                .map_err(|_| "服务端身份确认响应中断")?;
            match message {
                tokio_tungstenite::tungstenite::Message::Binary(bytes) => {
                    return Packet::parse(&bytes)
                        .map_err(|_| "服务端身份确认报文无效，请检查服务器版本".to_string())
                }
                tokio_tungstenite::tungstenite::Message::Close(_) => {
                    return Err("服务端在身份确认前关闭连接".into())
                }
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| "服务端身份确认超时（8 秒），请检查服务器和反向代理".to_string())?
}
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
struct Pending {
    packet: Packet,
    queued: Instant,
    age: Option<Duration>,
}
pub struct Network {
    generation: AtomicU64,
    queue: Mutex<Option<(mpsc::Sender<Pending>, mpsc::Sender<Pending>)>>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}
impl Network {
    pub fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            queue: Mutex::new(None),
            task: Mutex::new(None),
        }
    }
    pub fn disconnect(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        *self.queue.lock().unwrap() = None;
        if let Some(t) = self.task.lock().unwrap().take() {
            t.abort()
        }
    }
    pub fn send(&self, p: Packet) -> bool {
        let age = p.fields().ok().and_then(|h| {
            if h.get("discard") == Some(&"1") {
                Some(Duration::from_millis(
                    h.get("maxAgeMs")
                        .and_then(|s| s.parse::<u64>().ok())
                        .unwrap_or(200)
                        .clamp(1, 1000),
                ))
            } else {
                None
            }
        });
        let q = self.queue.lock().unwrap();
        let Some((reliable, discard)) = q.as_ref() else {
            return false;
        };
        let tx = if age.is_some() { discard } else { reliable };
        tx.try_send(Pending {
            packet: p,
            queued: Instant::now(),
            age,
        })
        .is_ok()
    }
    pub fn queued_ms(&self) -> usize {
        self.queue
            .lock()
            .unwrap()
            .as_ref()
            .map(|(_, q)| (q.max_capacity() - q.capacity()) * 20)
            .unwrap_or(0)
    }
    pub fn connect(self: &Arc<Self>, state: Arc<AppState>, settings: Settings, identity: Value) {
        self.disconnect();
        let generation = self.generation.load(Ordering::SeqCst);
        let this = self.clone();
        let (tx, rx) = mpsc::channel(64);
        let (audio_tx, audio_rx) = mpsc::channel(8);
        *self.queue.lock().unwrap() = Some((tx, audio_tx));
        *self.task.lock().unwrap() = Some(tauri::async_runtime::spawn(async move {
            let result = if settings.transport == "TCP" {
                tcp(state.clone(), generation, settings, identity, rx, audio_rx).await
            } else {
                ws(state.clone(), generation, settings, identity, rx, audio_rx).await
            };
            if this.generation.load(Ordering::SeqCst) == generation {
                *this.queue.lock().unwrap() = None;
                state.event(json!({"type":"closed","reason":result.err().unwrap_or_else(||"连接已关闭".into())}));
            }
        }));
    }
    fn current(&self, g: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == g
    }
}
fn receive(state: &AppState, g: u64, p: Packet) {
    if !state.network.current(g) {
        return;
    }
    if p.kind == 64 && state.extensions.receive(&p, None) {
        return;
    }
    if let Ok(b) = p.plain() {
        state.event(json!({"type":"packet","data":B64.encode(b)}));
    }
}
async fn next(
    rx: &mut mpsc::Receiver<Pending>,
    audio: &mut mpsc::Receiver<Pending>,
) -> Option<Packet> {
    loop {
        let pending = tokio::select! {biased;p=rx.recv()=>p,p=audio.recv()=>p}?;
        if !pending
            .age
            .is_some_and(|age| pending.queued.elapsed() > age)
        {
            return Some(pending.packet);
        }
    }
}
fn heartbeat() -> Packet {
    Packet::new(
        32,
        b"",
        json!({"pingId":wire::random_id(),"sentAtMs":now_ms()}).to_string(),
    )
}
async fn tcp(
    state: Arc<AppState>,
    g: u64,
    s: Settings,
    identity: Value,
    mut rx: mpsc::Receiver<Pending>,
    mut audio: mpsc::Receiver<Pending>,
) -> Result<(), String> {
    state.event(json!({"type":"status","message":"正在解析并连接服务端…"}));
    let mut stream = server_socket(&s.host, s.port).await?;
    state.event(json!({"type":"status","message":"正在与服务端进行加密握手…"}));
    let (mut send, mut recv) = timeout(Duration::from_secs(8), async {
        let request = Packet::new(1, b"", b"").plain()?;
        stream
            .write_all(&request)
            .await
            .map_err(|_| "握手发送失败")?;
        let hello_bytes = wire::read(&mut stream).await?;
        let hello = Packet::parse(&hello_bytes)?;
        if hello.kind != 2 || !hello.control.is_empty() {
            return Err("SERVER_HELLO无效".into());
        }
        let secret = SecretKey::random(&mut OsRng);
        let local = wire::hello(&secret);
        let metadata = identity.to_string().into_bytes();
        let mut body = (local.len() as u16).to_be_bytes().to_vec();
        body.extend_from_slice(&local);
        body.resize(body.len() + 28 + metadata.len(), 0);
        let connect = Packet::new(3, b"", body).plain()?;
        let prefix = &connect[..19 + local.len()];
        let mut hash = Sha256::new();
        hash.update(&request);
        hash.update(&hello_bytes);
        hash.update(prefix);
        let (mut send, recv) = wire::tcp_keys(&secret, &hello.body, &local, &hash.finalize())?;
        let mut connect = prefix.to_vec();
        connect.extend(send.seal(prefix, &metadata)?);
        stream
            .write_all(&connect)
            .await
            .map_err(|_| "CONNECT发送失败")?;
        Ok::<_, String>((send, recv))
    })
    .await
    .map_err(|_| "服务端加密握手超时（8 秒），请检查网络和服务器版本")?
    .map_err(|error| format!("服务端加密握手失败：{error}"))?;
    let ready = recv.decrypt(
        &timeout(Duration::from_secs(8), wire::read(&mut stream))
            .await
            .map_err(|_| "服务端身份确认超时（8 秒），请检查服务端响应")?
            .map_err(|error| format!("服务端身份确认中断：{error}"))?,
        false,
    )?;
    let accepted = ready.kind == 4 && ready.fields()?.get("ok") == Some(&"1");
    receive(&state, g, ready);
    if !accepted {
        return Err("服务端拒绝身份确认，请重新连接".into());
    }
    let (mut reader, mut writer) = stream.into_split();
    let pong = Arc::new(Mutex::new(Instant::now()));
    let rp = pong.clone();
    let read_state = state.clone();
    let reading = async move {
        loop {
            let b = wire::read(&mut reader)
                .await
                .map_err(|_| "服务端 TCP 接收中断，正在重新连接")?;
            let p = recv.decrypt(&b, false)?;
            if p.kind == 33 {
                *rp.lock().unwrap() = Instant::now()
            }
            receive(&read_state, g, p);
        }
    };
    let writing = async move {
        let mut interval = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(5),
            Duration::from_secs(5),
        );
        loop {
            let p = tokio::select! {p=next(&mut rx,&mut audio)=>p.ok_or("连接已关闭")?,_=interval.tick()=>{if pong.lock().unwrap().elapsed()>Duration::from_secs(15){return Err::<(),String>("服务端心跳响应超时，正在重新连接".into())}heartbeat()}};
            let b = send.encrypt(&p)?;
            timeout(Duration::from_secs(2), writer.write_all(&b))
                .await
                .map_err(|_| "向服务端发送超时（2 秒），正在重新连接")?
                .map_err(|_| "向服务端发送失败，正在重新连接")?;
        }
    };
    tokio::select! {r=reading=>r,r=writing=>r}
}
async fn ws(
    state: Arc<AppState>,
    g: u64,
    s: Settings,
    identity: Value,
    mut rx: mpsc::Receiver<Pending>,
    mut audio: mpsc::Receiver<Pending>,
) -> Result<(), String> {
    let scheme = if s.transport == "HTTPS" { "wss" } else { "ws" };
    state.event(json!({"type":"status","message":"正在解析并连接服务端…"}));
    let stream = server_socket(&s.host, s.port).await?;
    let host = if s.host.contains(':') {
        format!("[{}]", s.host)
    } else {
        s.host
    };
    let url = format!("{scheme}://{host}:{}/ws", s.port);
    state.event(json!({"type":"status","message":"正在建立服务端 WebSocket 通道…"}));
    let (mut socket, _) = timeout(
        Duration::from_secs(8),
        tokio_tungstenite::client_async_tls_with_config(url, stream, None, None),
    )
    .await
    .map_err(|_| "服务端 TLS / WebSocket 握手超时（8 秒），请检查证书、反向代理和网络")?
    .map_err(|error| websocket_error(&error))?;
    timeout(
        Duration::from_secs(2),
        socket.send(tokio_tungstenite::tungstenite::Message::Binary(
            Packet::new(3, b"", identity.to_string()).plain()?.into(),
        )),
    )
    .await
    .map_err(|_| "向服务端发送身份申请超时（2 秒）")?
    .map_err(|_| "向服务端发送身份申请失败")?;
    // READY has its own deadline, before the normal heartbeat begins. A proxy
    // accepting the WebSocket upgrade but never forwarding application traffic
    // must be reported as identity confirmation, not a heartbeat failure.
    let ready = websocket_ready(&mut socket).await?;
    if ready.kind != 4 {
        return Err("服务端未返回身份确认，请检查服务器版本".into());
    }
    let accepted = ready.fields()?.get("ok") == Some(&"1");
    receive(&state, g, ready);
    if !accepted {
        return Err("服务端拒绝身份确认，请重新连接".into());
    }
    let (mut writer, mut reader) = socket.split();
    let pong = Arc::new(Mutex::new(Instant::now()));
    let rp = pong.clone();
    let rs = state.clone();
    let reading = async move {
        while let Some(item) = reader.next().await {
            let msg = item.map_err(|_| "服务端 WebSocket 接收中断，正在重新连接")?;
            if let tokio_tungstenite::tungstenite::Message::Binary(b) = msg {
                let p = Packet::parse(&b)?;
                if p.kind == 33 || p.kind == 4 {
                    *rp.lock().unwrap() = Instant::now()
                }
                receive(&rs, g, p);
            } else if msg.is_close() {
                break;
            }
        }
        Err::<(), String>("服务端 WebSocket 已关闭，正在重新连接".into())
    };
    let writing = async move {
        let mut interval = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(5),
            Duration::from_secs(5),
        );
        loop {
            let p = tokio::select! {p=next(&mut rx,&mut audio)=>p.ok_or("连接已关闭")?,_=interval.tick()=>{if pong.lock().unwrap().elapsed()>Duration::from_secs(15){return Err::<(),String>("服务端心跳响应超时，正在重新连接".into())}heartbeat()}};
            timeout(
                Duration::from_secs(2),
                writer.send(tokio_tungstenite::tungstenite::Message::Binary(
                    p.plain()?.into(),
                )),
            )
            .await
            .map_err(|_| "向服务端发送超时（2 秒），正在重新连接")?
            .map_err(|_| "向服务端发送失败，正在重新连接")?;
        }
    };
    tokio::select! {r=reading=>r,r=writing=>r}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn service_socket_connects_and_refused_port_names_the_server_stage() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let socket = server_socket("127.0.0.1", address.port()).await.unwrap();
        assert_eq!(socket.peer_addr().unwrap(), address);
        drop(socket);
        drop(listener);
        let error = server_socket("127.0.0.1", address.port())
            .await
            .unwrap_err();
        assert!(error.contains("服务端 TCP") && error.contains("拒绝"));
    }
    #[tokio::test]
    async fn websocket_proxy_denial_is_reported_without_its_url_or_body() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 2048];
            stream.read(&mut request).await.unwrap();
            stream
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 11\r\n\r\nprivate-log")
                .await
                .unwrap();
        });
        let socket = server_socket("127.0.0.1", address.port()).await.unwrap();
        let error = tokio_tungstenite::client_async_tls_with_config(
            format!("ws://{address}/ws?token=never-log-this"),
            socket,
            None,
            None,
        )
        .await
        .unwrap_err();
        let message = websocket_error(&error);
        assert!(message.contains("服务端 WebSocket") && message.contains("HTTP 502"));
        assert!(
            !message.contains("private-log")
                && !message.contains("token=")
                && !message.contains("never-log-this")
        );
        server.await.unwrap();
    }
    #[tokio::test]
    async fn websocket_without_ready_times_out_in_identity_stage() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            // A proxy can accept the upgrade while the upstream never responds.
            let _ = socket.next().await;
            tokio::time::sleep(Duration::from_secs(20)).await;
        });
        let stream = server_socket("127.0.0.1", address.port()).await.unwrap();
        let (mut socket, _) = tokio_tungstenite::client_async_tls_with_config(
            format!("ws://{address}/ws"),
            stream,
            None,
            None,
        )
        .await
        .unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Binary(
                Packet::new(3, b"", b"{}").plain().unwrap().into(),
            ))
            .await
            .unwrap();
        let error = websocket_ready(&mut socket)
            .await
            .err()
            .expect("identity stage must time out");
        assert!(error.contains("身份确认超时") && !error.contains("心跳"));
        server.abort();
    }
    #[test]
    fn queue_budget_keeps_reliable_capacity_when_voice_is_full() {
        let network = Network::new();
        let (tx, _rx) = mpsc::channel(2);
        let (audio, _audio_rx) = mpsc::channel(2);
        *network.queue.lock().unwrap() = Some((tx, audio));
        let voice = Packet::new(16, "discard:1\nmaxAgeMs:200\n", b"voice");
        assert!(network.send(voice.clone()));
        assert!(network.send(voice.clone()));
        assert!(!network.send(voice));
        assert_eq!(network.queued_ms(), 40);
        assert!(network.send(Packet::new(16, "op:104\n", b"{}")));
        network.disconnect();
        assert!(!network.send(Packet::new(16, b"", b"closed")));
    }
    #[tokio::test]
    async fn expired_voice_is_dropped_and_control_has_priority() {
        let (tx, mut rx) = mpsc::channel(2);
        let (audio, mut audio_rx) = mpsc::channel(3);
        audio
            .send(Pending {
                packet: Packet::new(16, b"", b"expired"),
                queued: Instant::now() - Duration::from_secs(1),
                age: Some(Duration::from_millis(200)),
            })
            .await
            .unwrap();
        audio
            .send(Pending {
                packet: Packet::new(16, b"", b"fresh"),
                queued: Instant::now(),
                age: Some(Duration::from_millis(200)),
            })
            .await
            .unwrap();
        tx.send(Pending {
            packet: Packet::new(16, b"", b"control"),
            queued: Instant::now() - Duration::from_secs(1),
            age: None,
        })
        .await
        .unwrap();
        assert_eq!(next(&mut rx, &mut audio_rx).await.unwrap().body, b"control");
        assert_eq!(next(&mut rx, &mut audio_rx).await.unwrap().body, b"fresh");
        assert!(audio_rx.try_recv().is_err());
    }
}
