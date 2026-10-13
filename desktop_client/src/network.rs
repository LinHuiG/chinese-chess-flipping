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
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncWriteExt, net::TcpStream, sync::mpsc, time::timeout};
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
    if p.kind == 64 && state.voice.receive(&p, None) {
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
    let mut stream = timeout(
        Duration::from_secs(8),
        TcpStream::connect((s.host.as_str(), s.port)),
    )
    .await
    .map_err(|_| "连接超时")?
    .map_err(|_| "连接失败，请检查服务器")?;
    stream.set_nodelay(true).map_err(|_| "TCP设置失败")?;
    state.event(json!({"type":"status","message":"正在进行加密握手…"}));
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
    .map_err(|_| "握手超时")??;
    let ready = recv.decrypt(
        &timeout(Duration::from_secs(8), wire::read(&mut stream))
            .await
            .map_err(|_| "身份确认超时")??,
        false,
    )?;
    let accepted = ready.kind == 4 && ready.fields()?.get("ok") == Some(&"1");
    receive(&state, g, ready);
    if !accepted {
        return Err("身份被拒绝".into());
    }
    let (mut reader, mut writer) = stream.into_split();
    let pong = Arc::new(Mutex::new(Instant::now()));
    let rp = pong.clone();
    let read_state = state.clone();
    let reading = async move {
        loop {
            let b = wire::read(&mut reader).await?;
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
            let p = tokio::select! {p=next(&mut rx,&mut audio)=>p.ok_or("连接已关闭")?,_=interval.tick()=>{if pong.lock().unwrap().elapsed()>Duration::from_secs(15){return Err::<(),String>("心跳中断".into())}heartbeat()}};
            let b = send.encrypt(&p)?;
            timeout(Duration::from_secs(2), writer.write_all(&b))
                .await
                .map_err(|_| "发送阻塞，重新连接")?
                .map_err(|_| "发送失败")?;
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
    let host = if s.host.contains(':') {
        format!("[{}]", s.host)
    } else {
        s.host
    };
    let url = format!("{scheme}://{host}:{}/ws", s.port);
    let (mut socket, _) = timeout(
        Duration::from_secs(8),
        tokio_tungstenite::connect_async(url),
    )
    .await
    .map_err(|_| "连接超时")?
    .map_err(|_| "连接失败，请检查地址和证书")?;
    socket
        .send(tokio_tungstenite::tungstenite::Message::Binary(
            Packet::new(3, b"", identity.to_string()).plain()?.into(),
        ))
        .await
        .map_err(|_| "身份申请失败")?;
    let (mut writer, mut reader) = socket.split();
    let pong = Arc::new(Mutex::new(Instant::now()));
    let rp = pong.clone();
    let rs = state.clone();
    let reading = async move {
        while let Some(item) = reader.next().await {
            let msg = item.map_err(|_| "连接中断")?;
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
        Err::<(), String>("连接已关闭".into())
    };
    let writing = async move {
        let mut interval = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(5),
            Duration::from_secs(5),
        );
        loop {
            let p = tokio::select! {p=next(&mut rx,&mut audio)=>p.ok_or("连接已关闭")?,_=interval.tick()=>{if pong.lock().unwrap().elapsed()>Duration::from_secs(15){return Err::<(),String>("心跳中断".into())}heartbeat()}};
            timeout(
                Duration::from_secs(2),
                writer.send(tokio_tungstenite::tungstenite::Message::Binary(
                    p.plain()?.into(),
                )),
            )
            .await
            .map_err(|_| "发送阻塞")?
            .map_err(|_| "发送失败")?;
        }
    };
    tokio::select! {r=reading=>r,r=writing=>r}
}

#[cfg(test)]
mod tests {
    use super::*;
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
