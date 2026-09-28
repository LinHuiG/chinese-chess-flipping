use crate::{
    hub::{self, Output, Peer, Shared},
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
    time::{sleep_until, timeout, Instant},
};

struct Registered {
    hub: Shared,
    user: String,
}
impl Drop for Registered {
    fn drop(&mut self) {
        self.hub.lock().unwrap().disconnect(&self.user)
    }
}
fn metadata(v: &Value) -> Result<(String, bool), String> {
    let platform = json::field(v, "CHL", 16)?;
    if !matches!(platform, "ANDROID" | "IOS" | "WEB") {
        return Err("Platform".into());
    }
    let did = json::field(v, "DID", 32)?;
    if !json::hex_id(did) {
        return Err("DID".into());
    }
    json::field(v, "APP", 256)?;
    json::field(v, "VER", 64)?;
    Ok((
        did.into(),
        platform == "ANDROID" && v["UDP"].as_u64() == Some(1),
    ))
}
fn tid(v: &Value) -> Result<String, String> {
    let t = json::field(v, "TID", 32)?;
    if !json::hex_id(t) {
        return Err("TID".into());
    }
    Ok(t.into())
}
fn control(tid: &str, code: u16, msg: Option<&str>) -> Vec<u8> {
    let mut v = json!({"TID":tid,"CODE":code});
    if let Some(s) = msg {
        v["MSG"] = s.into()
    }
    serde_json::to_vec(&v).unwrap()
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
) -> Result<(wire::Cipher, wire::Cipher, String, bool), String> {
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
    let (did, udp) = metadata(&meta)?;
    write_tcp(s, &send.encrypt(6, &control(&t, 0, None), &transcript)?).await?;
    Ok((send, receive, did, udp))
}
pub async fn tcp(mut stream: TcpStream, hub: Shared, key: Arc<SecretKey>) {
    let _ = stream.set_nodelay(true);
    let Ok(Ok((mut send, mut receive, did, udp))) =
        timeout(Duration::from_secs(10), handshake(&mut stream, &key)).await
    else {
        return;
    };
    let (tx, mut out) = mpsc::channel(32);
    let (close, mut closed) = watch::channel(false);
    let user = hub.lock().unwrap().register(did, udp, Peer { tx, close });
    let _guard = Registered {
        hub: hub.clone(),
        user: user.clone(),
    };
    let (mut reader, mut writer) = stream.into_split();
    let (in_tx, mut input) = mpsc::channel(8);
    // A separate reader owns its partial frame. Selecting outbound traffic cannot cancel a half-read frame.
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
    let mut heartbeat = Instant::now() + Duration::from_secs(30);
    loop {
        tokio::select! {
            _=closed.changed()=>break,
            _=sleep_until(heartbeat)=>break,
            value=input.recv()=>{
                let Some(Ok((kind,b,x)))=value else{break};let Ok(c)=json::object(&b[..x])else{break};let Ok(t)=tid(&c)else{break};
                if !hub.lock().unwrap().active(&user){break}
                let response=if kind!=32&&kind!=16{Some((127,400,Some("UNEXPECTED_PACKET_TYPE"),bytes::Bytes::from_static(b"{}")))}
                    else{match json::object(&b[x..]){
                        Err(_)=>Some((127,400,Some("INVALID_JSON"),bytes::Bytes::from_static(b"{}"))),
                        Ok(body)=>if kind==32{heartbeat=Instant::now()+Duration::from_secs(30);Some((33,0,None,bytes::Bytes::from_static(b"{\"type\":\"PONG\"}")))}
                        else if body["type"]=="ECHO"&&body["message"].is_string(){Some((17,0,None,hub::encoded(&json!({"type":"ECHO","message":body["message"]}))))}
                        else{hub.lock().unwrap().handle(&user,&t,body);None}
                    }};
                if let Some((kind,code,msg,body))=response{let b=if body.len()>65536{send.encrypt(127,&control(&t,413,Some("RESPONSE_TOO_LARGE")),b"{}")}else{send.encrypt(kind,&control(&t,code,msg),&body)};let Ok(b)=b else{break};if write_tcp(&mut writer,&b).await.is_err(){break}}
            }
            value=out.recv()=>{let Some(o)=value else{break};let Ok(b)=send.encrypt(o.kind,&control(&o.tid,0,None),&o.body)else{break};if write_tcp(&mut writer,&b).await.is_err(){break}}
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
        .max_message_size(69632)
        .max_frame_size(69632)
        .on_upgrade(move |socket| ws(socket, hub))
}
fn ws_bytes(kind: &str, tid: &str, body: &[u8]) -> Vec<u8> {
    // body is already serialized once by RoomHub; do not parse/re-encode it per recipient.
    let mut b = Vec::with_capacity(body.len() + 100);
    b.extend_from_slice(
        format!("{{\"type\":\"{kind}\",\"TID\":\"{tid}\",\"CODE\":0,\"body\":").as_bytes(),
    );
    b.extend_from_slice(body);
    b.push(b'}');
    b
}
async fn ws_send(socket: &mut WebSocket, kind: &str, tid: &str, body: &[u8]) -> Result<(), String> {
    let bytes = ws_bytes(kind, tid, body);
    if bytes.len() > 69632 {
        return Err("Message too large".into());
    }
    // serde_json and fixed ASCII envelope guarantee UTF-8, conversion reuses the allocation.
    let text = String::from_utf8(bytes).map_err(|_| "UTF-8")?;
    timeout(
        Duration::from_secs(5),
        socket.send(Message::Text(text.into())),
    )
    .await
    .map_err(|_| "Slow peer")?
    .map_err(|_| "Write failed".into())
}
async fn ws(mut socket: WebSocket, hub: Shared) {
    let Ok(Some(Ok(Message::Text(text)))) = timeout(Duration::from_secs(10), socket.recv()).await
    else {
        return;
    };
    let Ok(hello) = json::object(text.as_bytes()) else {
        return;
    };
    let Ok(t) = tid(&hello) else { return };
    let Ok((did, udp)) = metadata(&hello) else {
        return;
    };
    if hello["type"] != "HELLO" {
        return;
    }
    if ws_send(&mut socket, "READY", &t, b"{}").await.is_err() {
        return;
    }
    let (tx, mut out) = mpsc::channel::<Output>(32);
    let (close, mut closed) = watch::channel(false);
    let user = hub.lock().unwrap().register(did, udp, Peer { tx, close });
    let _guard = Registered {
        hub: hub.clone(),
        user: user.clone(),
    };
    let mut heartbeat = Instant::now() + Duration::from_secs(30);
    loop {
        tokio::select! {
            _=closed.changed()=>break,
            _=sleep_until(heartbeat)=>break,
            value=socket.recv()=>{
                let text=match value{Some(Ok(Message::Text(t)))=>t,Some(Ok(Message::Ping(_)|Message::Pong(_)))=>continue,_=>break};
                let Ok(v)=json::object(text.as_bytes())else{break};let Ok(t)=tid(&v)else{break};if !hub.lock().unwrap().active(&user){break}
                match v["type"].as_str(){
                    Some("PING")=>{heartbeat=Instant::now()+Duration::from_secs(30);if ws_send(&mut socket,"PONG",&t,b"{\"type\":\"PONG\"}").await.is_err(){break}},
                    Some("REQUEST")=>{let mut v=v;let body=v["body"].take();if !body.is_object()||(text.len()>65536&&serde_json::to_vec(&body).unwrap().len()>65536){break}
                        if body["type"]=="ECHO"{let response=hub::encoded(&json!({"type":"ECHO","message":body["message"].as_str().unwrap_or("")}));if ws_send(&mut socket,"RESPONSE",&t,&response).await.is_err(){break}}
                        else{hub.lock().unwrap().handle(&user,&t,body)}
                    },_=>break
                }
            }
            value=out.recv()=>{let Some(o)=value else{break};if ws_send(&mut socket,if o.kind==18{"EVENT"}else{"RESPONSE"},&o.tid,&o.body).await.is_err(){break}}
        }
    }
}
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
