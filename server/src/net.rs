//! 传输适配：TCP 负责加密握手，WS 负责二进制承载；二者共用 v2 帧和业务分发。
use crate::{
    hub::{Peer, Shared},
    json, wire,
};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use p256::SecretKey;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::AsyncWriteExt,
    net::TcpStream,
    sync::{mpsc, watch},
    time::timeout,
};
// 连接生命周期守卫：任意退出路径都解绑当前连接；代次检查防止旧连接误删新连接。
struct Registered {
    hub: Shared,
    user: String,
    generation: u64,
}
impl Drop for Registered {
    fn drop(&mut self) {
        self.hub
            .lock()
            .unwrap()
            .disconnect(&self.user, self.generation);
    }
}
// 首次接入必须声明支持的协议版本与平台；UDP 能力另由 Hub 校验。
fn metadata(v: &Value) -> Result<(), String> {
    if !matches!(v["CHL"].as_str(), Some("ANDROID" | "WEB" | "IOS")) {
        return Err("Platform".into());
    }
    if v["protocol"].as_u64() != Some(2) {
        return Err("请升级客户端至 0.6.0".into());
    }
    Ok(())
}
// 随机 TID 只用于关联握手，不再给每个业务事件生成无用请求编号。
fn tid(v: &Value) -> Result<String, String> {
    let t = json::field(v, "TID", 32)?;
    if !json::hex_id(t) {
        return Err("TID".into());
    }
    Ok(t.into())
}
// 握手响应控制头，与加密握手的 transcript 校验配套。
fn control(tid: &str, code: u16, msg: Option<&str>) -> Vec<u8> {
    serde_json::to_vec(&json!({"TID":tid,"CODE":code,"MSG":msg})).unwrap()
}
// 单次写入有超时，慢接收端不能无限占用写任务。
async fn write_tcp(s: &mut (impl tokio::io::AsyncWrite + Unpin), b: &[u8]) -> Result<(), String> {
    timeout(Duration::from_secs(5), s.write_all(b))
        .await
        .map_err(|_| "Slow peer")?
        .map_err(|_| "Write failed".into())
}
// P-256 + HKDF 派生方向密钥，transcript 绑定双方握手字节。
// 确认完成后才把身份元数据交给 Hub；这是链路保护，不是证书或账户认证。
async fn handshake(
    s: &mut TcpStream,
    key: &SecretKey,
) -> Result<(wire::Cipher, wire::Cipher, Value), String> {
    let req = wire::read(s).await?;
    let (c, b) = req.plaintext()?;
    let t = tid(&json::object(c)?)?;
    if req.kind != 1 || !b.is_empty() {
        return Err("Handshake request".into());
    }
    let hello = wire::hello(key);
    let response = wire::plain(2, &control(&t, 0, None), &hello)?;
    write_tcp(s, &response).await?;
    let k = wire::read(s).await?;
    let (c, client) = k.plaintext()?;
    if k.kind != 3 || tid(&json::object(c)?)? != t {
        return Err("Handshake key".into());
    }
    let mut hash = Sha256::new();
    hash.update(&req.bytes);
    hash.update(&response);
    hash.update(&k.bytes);
    let transcript = hash.finalize();
    let (mut send, mut receive) = wire::derive(key, &hello, client, &transcript)?;
    write_tcp(s, &send.encrypt(4, &control(&t, 0, None), &transcript)?).await?;
    let (kind, b, x) = receive.decrypt(wire::read(s).await?)?;
    let meta = json::object(&b[..x])?;
    if kind != 5 || tid(&meta)? != t || b[x..] != transcript[..] {
        return Err("Handshake confirmation".into());
    }
    metadata(&meta)?;
    write_tcp(s, &send.encrypt(6, &control(&t, 0, None), &transcript)?).await?;
    Ok((send, receive, meta))
}

// TCP/WS 共用入口：先验证连接代次，再处理心跳、路由头或服务器控制命令。
// 棋局包体保持 Bytes；只有控制命令包体会进入 JSON 解析器。
fn process(
    hub: &Shared,
    user: &str,
    generation: u64,
    kind: u8,
    c: &[u8],
    body: bytes::Bytes,
) -> Result<Option<(u8, Vec<u8>, bytes::Bytes)>, String> {
    let header = json::object(c)?;
    if !hub.lock().unwrap().active(user, generation) {
        return Err("Replaced connection".into());
    }
    if kind == 32 {
        hub.lock().unwrap().ping(user, generation);
        return Ok(Some((33, c.to_vec(), bytes::Bytes::from_static(b"{}"))));
    }
    // 更新功能号独立于棋局，不占房间状态；每个分块回复都走原连接的有界写通道。
    if kind == 48 {
        let current = header["versionCode"]
            .as_u64()
            .ok_or("Missing installed version")?;
        return Ok(Some((
            49,
            b"{}".to_vec(),
            crate::hub::encoded(&crate::update::version(current)),
        )));
    }
    if kind == 50 {
        return Ok(Some(match crate::update::chunk(&header) {
            Ok((control, body)) => (51, control, body),
            Err(error) => (
                49,
                b"{}".to_vec(),
                crate::hub::encoded(&json!({"type":"APP_VERSION","error":error})),
            ),
        }));
    }
    if kind != 16 {
        return Err("Unexpected packet".into());
    }
    if matches!(
        header["type"].as_str(),
        Some("ACTION" | "HOST_REPLY" | "HOST_STATE")
    ) {
        let mut h = hub.lock().unwrap();
        if !h.active(user, generation) {
            return Err("Replaced connection".into());
        }
        if let Err(error) = h.relay(user, header.clone(), body) {
            h.handle(
                user,
                json!({"type":"ECHO","message":error,"failedOperation":header["operationId"]}),
            );
        }
    } else {
        let q = json::object(&body)?;
        let mut h = hub.lock().unwrap();
        if h.active(user, generation) {
            h.handle(user, q);
        }
    }
    Ok(None)
}
// 每个连接一个读取任务和一个有界发送循环；读到的密文就地解密，队列满时产生背压。
// 关闭发送循环会取消读取任务，并通过守卫解绑用户。
pub async fn tcp(mut stream: TcpStream, hub: Shared, key: Arc<SecretKey>) {
    let _ = stream.set_nodelay(true);
    let Ok(Ok((mut send, mut receive, meta))) =
        timeout(Duration::from_secs(10), handshake(&mut stream, &key)).await
    else {
        return;
    };
    let (tx, mut out) = mpsc::channel(32);
    let (close, mut closed) = watch::channel(false);
    let Ok((user, generation)) = hub.lock().unwrap().register(&meta, Peer { tx, close }) else {
        return;
    };
    let _guard = Registered {
        hub: hub.clone(),
        user: user.clone(),
        generation,
    };
    let (mut reader, mut writer) = stream.into_split();
    let (in_tx, mut input) = mpsc::channel(8);
    let read_task = tokio::spawn(async move {
        loop {
            let value = match wire::read(&mut reader).await {
                Ok(f) => receive.decrypt(f),
                Err(e) => Err(e),
            };
            let stop = value.is_err();
            if in_tx.send(value).await.is_err() || stop {
                break;
            }
        }
    });
    loop {
        tokio::select! {
            biased;
            // 关闭信号优先，接管连接后不要继续处理旧队列。
            _ = closed.changed() => break,
            value = input.recv() => {
                let Some(Ok((kind, bytes, x))) = value else { break; };
                match process(&hub, &user, generation, kind, &bytes[..x], bytes.slice(x..)) {
                    Err(_) => break,
                    Ok(Some((kind, control, body))) => {
                        let Ok(frame) = send.encrypt(kind, &control, &body) else { break; };
                        if write_tcp(&mut writer, &frame).await.is_err() { break; }
                    }
                    Ok(None) => {}
                }
            }
            value = out.recv() => {
                let Some(output) = value else { break; };
                if !hub.lock().unwrap().active(&user, generation) { break; }
                let Ok(frame) = send.encrypt(18, &output.header, &output.body) else { break; };
                if write_tcp(&mut writer, &frame).await.is_err() { break; }
            }
        }
    }
    read_task.abort();
}
// 浏览器 Origin 必须匹配 Host，避免任意外站借用用户浏览器连接本服务；原生 App 可不带 Origin。
pub async fn ws_upgrade(
    State(hub): State<Shared>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if let Some(origin) = headers.get("origin") {
        let valid = origin
            .to_str()
            .ok()
            .and_then(|s| s.parse::<Uri>().ok())
            .is_some_and(|u| {
                matches!(u.scheme_str(), Some("http" | "https"))
                    && u.authority().is_some_and(|a| {
                        headers
                            .get("host")
                            .and_then(|h| h.to_str().ok())
                            .is_some_and(|h| h.eq_ignore_ascii_case(a.as_str()))
                    })
            });
        if !valid {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    upgrade
        .max_message_size(69649)
        .max_frame_size(69649)
        .on_upgrade(move |socket| ws(socket, hub))
}

// WS 发送与 TCP 使用同一帧布局；外层掩码/TLS 由 WebSocket 栈及反向代理处理。
async fn ws_send(socket: &mut WebSocket, kind: u8, c: &[u8], b: &[u8]) -> Result<(), String> {
    let bytes = wire::plain(kind, c, b)?;
    timeout(
        Duration::from_secs(5),
        socket.send(Message::Binary(bytes.into())),
    )
    .await
    .map_err(|_| "Slow peer")?
    .map_err(|_| "Write failed".into())
}
// 首次二进制帧携带身份，随后接收业务与应用心跳。WS 自带 Ping/Pong 不延长用户存活期限。
async fn ws(mut socket: WebSocket, hub: Shared) {
    let Ok(Some(Ok(Message::Binary(bytes)))) =
        timeout(Duration::from_secs(10), socket.recv()).await
    else {
        let _ = socket
            .send(Message::Text("请升级客户端至 0.6.0".into()))
            .await;
        return;
    };
    let Ok((kind, c, b)) = wire::plaintext(&bytes) else {
        return;
    };
    let Ok(meta) = json::object(c) else {
        return;
    };
    if kind != 5 || !b.is_empty() || metadata(&meta).is_err() {
        return;
    }
    if ws_send(&mut socket, 6, b"{}", b"{}").await.is_err() {
        return;
    }
    let (tx, mut out) = mpsc::channel(32);
    let (close, mut closed) = watch::channel(false);
    let Ok((user, generation)) = hub.lock().unwrap().register(&meta, Peer { tx, close }) else {
        return;
    };
    let _guard = Registered {
        hub: hub.clone(),
        user: user.clone(),
        generation,
    };
    loop {
        tokio::select! {
            biased;
            _ = closed.changed() => break,
            value = socket.recv() => {
                let bytes = match value {
                    Some(Ok(Message::Binary(bytes))) => bytes,
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                    _ => break,
                };
                let Ok((kind, control, body)) = wire::plaintext(&bytes) else { break; };
                let body = bytes.slice(bytes.len() - body.len()..);
                match process(&hub, &user, generation, kind, control, body) {
                    Err(_) => break,
                    Ok(Some((kind, control, body))) => {
                        if ws_send(&mut socket, kind, &control, &body).await.is_err() { break; }
                    }
                    Ok(None) => {}
                }
            }
            value = out.recv() => {
                let Some(output) = value else { break; };
                if !hub.lock().unwrap().active(&user, generation) { break; }
                if ws_send(&mut socket, 18, &output.header, &output.body).await.is_err() { break; }
            }
        }
    }
}
// 网页资源编译进程序；固定路径白名单，无磁盘目录穿越。HEAD 不发送正文，并设置基本浏览器安全头。
pub async fn asset(uri: Uri, method: Method) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    macro_rules! item {
        ($name:literal,$mime:literal) => {
            (
                include_bytes!(concat!("main/resources/web/", $name)).as_slice(),
                $mime,
            )
        };
    }
    let (bytes, mime) = match uri.path() {
        "/" | "/index.html" => item!("index.html", "text/html; charset=utf-8"),
        "/style.css" => item!("style.css", "text/css; charset=utf-8"),
        "/app.js" => item!("app.js", "text/javascript; charset=utf-8"),
        "/game.js" => item!("game.js", "text/javascript; charset=utf-8"),
        "/transport.js" => item!("transport.js", "text/javascript; charset=utf-8"),
        "/icon.svg" => item!("icon.svg", "image/svg+xml"),
        "/rules.txt" => item!("rules.txt", "text/plain; charset=utf-8"),
        "/capture.wav" => item!("capture.wav", "audio/wav"),
        "/victory.wav" => item!("victory.wav", "audio/wav"),
        "/defeat.wav" => item!("defeat.wav", "audio/wav"),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    Response::builder().header("content-type",mime).header("content-length",bytes.len()).header("cache-control","no-cache").header("x-content-type-options","nosniff").header("referrer-policy","same-origin")
        .header("content-security-policy","default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        .body(if method==Method::HEAD{Body::empty()}else{Body::from(bytes)}).unwrap()
}
