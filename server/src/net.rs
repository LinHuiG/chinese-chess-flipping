//! TCP 密钥协商与 WS 承载；业务只进入通用 Hub。
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
async fn write_tcp(s: &mut (impl tokio::io::AsyncWrite + Unpin), b: &[u8]) -> Result<(), String> {
    timeout(Duration::from_secs(5), s.write_all(b))
        .await
        .map_err(|_| "Slow peer")?
        .map_err(|_| "Write failed".into())
}
async fn handshake(
    s: &mut TcpStream,
    key: &SecretKey,
) -> Result<(wire::Cipher, wire::Cipher, Value), String> {
    let req = wire::read(s).await?;
    let (c, b) = req.plaintext()?;
    if req.kind != 1 || !c.is_empty() || !b.is_empty() {
        return Err("KEY_REQUEST".into());
    }
    let hello = wire::hello(key);
    let response = wire::plain(2, b"", &hello)?;
    write_tcp(s, &response).await?;
    let connect = wire::read(s).await?;
    let (c, b) = connect.plaintext()?;
    if connect.kind != 3 || !c.is_empty() || b.len() < 2 {
        return Err("CONNECT".into());
    }
    let n = u16::from_be_bytes(b[..2].try_into().unwrap()) as usize;
    if !(33..=256).contains(&n) || b.len() < 2 + n + 28 {
        return Err("CONNECT length".into());
    }
    let prefix = &connect.bytes[..17 + 2 + n];
    let mut hash = Sha256::new();
    hash.update(&req.bytes);
    hash.update(&response);
    hash.update(prefix);
    let (send, mut receive) = wire::derive(key, &hello, &b[2..2 + n], &hash.finalize())?;
    let meta = json::object(&receive.open_connect(&b[2 + n..], prefix)?)?;
    Ok((send, receive, meta))
}
fn process(
    hub: &Shared,
    user: &str,
    generation: u64,
    kind: u8,
    c: &[u8],
    body: bytes::Bytes,
) -> Result<Option<(u8, Vec<u8>, bytes::Bytes)>, String> {
    let mut h = hub.lock().unwrap();
    if !h.active(user, generation) {
        return Err("Replaced connection".into());
    }
    if kind == 32 {
        if !c.is_empty() || body.len() > 256 {
            return Err("PING".into());
        }
        json::object(&body)?;
        h.ping(user, generation);
        return Ok(Some((33, vec![], body)));
    }
    // 安装包更新属于已有部署接口，正文和文件块也沿用统一帧。
    if kind == 48 || kind == 50 {
        if !c.is_empty() {
            return Err("Update control".into());
        }
        let q = json::object(&body)?;
        if kind == 48 {
            return Ok(Some((
                49,
                vec![],
                crate::hub::encoded(&crate::update::version(
                    q["versionCode"].as_u64().ok_or("versionCode")?,
                )),
            )));
        }
        return Ok(Some(match crate::update::chunk(&q) {
            Ok((control, bytes)) => {
                let object: Value =
                    serde_json::from_slice(&control).map_err(|_| "Update header")?;
                let mut lines = String::new();
                for (k, v) in object.as_object().unwrap() {
                    lines.push_str(k);
                    lines.push(':');
                    lines.push_str(
                        &v.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| v.to_string()),
                    );
                    lines.push('\n');
                }
                (51, lines.into_bytes(), bytes)
            }
            Err(error) => (
                49,
                vec![],
                crate::hub::encoded(&json!({"type":"APP_VERSION","error":error})),
            ),
        }));
    }
    h.handle(user, kind, c, body)?;
    Ok(None)
}
pub async fn tcp(mut stream: TcpStream, hub: Shared, key: Arc<SecretKey>) {
    let _ = stream.set_nodelay(true);
    let Ok(Ok((mut send, mut receive, meta))) =
        timeout(Duration::from_secs(10), handshake(&mut stream, &key)).await
    else {
        return;
    };
    let (tx, mut out) = mpsc::channel(32);
    let (close, mut closed) = watch::channel(false);
    let registration = hub.lock().unwrap().register(&meta, Peer { tx, close });
    let (user, generation, identity) = match registration {
        Ok(r) => r,
        Err(error) => {
            if let Ok(frame) = send.encrypt(4, format!("ok:0\nerror:{error}\n").as_bytes(), b"{}") {
                let _ = write_tcp(&mut stream, &frame).await;
            }
            return;
        }
    };
    let _guard = Registered {
        hub: hub.clone(),
        user: user.clone(),
        generation,
    };
    let Ok(ready) = send.encrypt(4, b"ok:1\n", &crate::hub::encoded(&identity)) else {
        return;
    };
    if write_tcp(&mut stream, &ready).await.is_err() {
        return;
    }
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
            _=closed.changed()=>break,
            value=input.recv()=>{
                let Some(Ok((kind,bytes,x)))=value else{break};
                match process(&hub,&user,generation,kind,&bytes[..x],bytes.slice(x..)){
                    Err(_)=>break,
                    Ok(Some((kind,c,b)))=>{let Ok(frame)=send.encrypt(kind,&c,&b)else{break};if write_tcp(&mut writer,&frame).await.is_err(){break;}},
                    Ok(None)=>{}
                }
            },
            value=out.recv()=>{
                let Some(output)=value else{break};
                if !hub.lock().unwrap().active(&user,generation){break;}
                let Ok(frame)=send.encrypt(output.kind,&output.header,&output.body)else{break};
                if write_tcp(&mut writer,&frame).await.is_err(){break;}
            }
        }
    }
    read_task.abort();
}
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
async fn ws(mut socket: WebSocket, hub: Shared) {
    let Ok(Some(Ok(Message::Binary(bytes)))) =
        timeout(Duration::from_secs(10), socket.recv()).await
    else {
        return;
    };
    let Ok((3, c, b)) = wire::plaintext(&bytes) else {
        return;
    };
    if !c.is_empty() {
        return;
    }
    let Ok(meta) = json::object(b) else { return };
    let (tx, mut out) = mpsc::channel(32);
    let (close, mut closed) = watch::channel(false);
    let registration = hub.lock().unwrap().register(&meta, Peer { tx, close });
    let (user, generation, identity) = match registration {
        Ok(r) => r,
        Err(error) => {
            let _ = ws_send(
                &mut socket,
                4,
                format!("ok:0\nerror:{error}\n").as_bytes(),
                b"{}",
            )
            .await;
            return;
        }
    };
    let _guard = Registered {
        hub: hub.clone(),
        user: user.clone(),
        generation,
    };
    if ws_send(&mut socket, 4, b"ok:1\n", &crate::hub::encoded(&identity))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            biased;
            _=closed.changed()=>break,
            value=socket.recv()=>{
                let bytes=match value{Some(Ok(Message::Binary(bytes)))=>bytes,Some(Ok(Message::Ping(_)|Message::Pong(_)))=>continue,_=>break};
                let Ok((kind,c,b))=wire::plaintext(&bytes)else{break};
                let body=bytes.slice(bytes.len()-b.len()..);
                match process(&hub,&user,generation,kind,c,body){
                    Err(_)=>break,Ok(Some((kind,c,b)))=>{if ws_send(&mut socket,kind,&c,&b).await.is_err(){break;}},Ok(None)=>{}
                }
            },
            value=out.recv()=>{
                let Some(output)=value else{break};
                if !hub.lock().unwrap().active(&user,generation){break;}
                if ws_send(&mut socket,output.kind,&output.header,&output.body).await.is_err(){break;}
            }
        }
    }
}
// 通用静态资源目录，不把游戏文件名编译进 Rust；拒绝目录穿越及根目录之外的链接。
pub fn init_assets() -> std::io::Result<()> {
    std::fs::metadata(crate::resource_root().join("src/main/resources/web/index.html")).map(|_| ())
}
pub async fn asset(uri: Uri, method: Method) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let name = if uri.path() == "/" {
        "index.html"
    } else {
        uri.path().trim_start_matches('/')
    };
    if name.split('/').any(|p| p.is_empty() || p.starts_with('.')) || name.contains(['\\', '%']) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let root = crate::resource_root().join("src/main/resources/web");
    let root = match tokio::fs::canonicalize(root).await {
        Ok(p) => p,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let path = match tokio::fs::canonicalize(root.join(name)).await {
        Ok(p) if p.starts_with(&root) => p,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let mime = match path.extension().and_then(|x| x.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "json" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        "woff2" => "font/woff2",
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let bytes = match tokio::fs::read(path).await {
        Ok(b) => b,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    Response::builder().header("content-type",mime).header("content-length",bytes.len()).header("cache-control","no-cache")
        .header("x-content-type-options","nosniff").header("referrer-policy","same-origin")
        .header("content-security-policy","default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        .body(if method==Method::HEAD{Body::empty()}else{Body::from(bytes)}).unwrap()
}
