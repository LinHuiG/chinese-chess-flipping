mod hub;
mod json;
mod net;
mod wire;
use std::{io, sync::Arc};
use tokio::{
    net::{TcpListener, UdpSocket},
    time::sleep_until,
};
fn config(name: &str, default: usize, max: usize) -> Result<usize, String> {
    let v = std::env::var(name)
        .unwrap_or(default.to_string())
        .parse::<usize>()
        .map_err(|_| format!("Invalid {name}"))?;
    if v == 0 || v > max {
        return Err(format!("Invalid {name}"));
    }
    Ok(v)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let threads = config("TCP_WORKER_THREADS", 4, 256)?;
    let tcp = config("TCP_PORT", 8888, 65535)? as u16;
    let http = config("HTTP_PORT", 80, 65535)? as u16;
    let udp = config("UDP_PORT", 8888, 65535)? as u16;
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(threads)
        .thread_name("chess-io")
        .enable_all()
        .build()?
        .block_on(run(tcp, http, udp))?;
    Ok(())
}
async fn run(tcp: u16, http: u16, udp: u16) -> io::Result<()> {
    let tcp_listener = TcpListener::bind(("0.0.0.0", tcp)).await?;
    let http_listener = TcpListener::bind(("0.0.0.0", http)).await?;
    let udp_socket = UdpSocket::bind(("0.0.0.0", udp)).await?;
    let hub = hub::Hub::new(udp);
    let key = Arc::new(p256::SecretKey::random(&mut rand_core::OsRng));
    let tcp_hub = hub.clone();
    let udp_hub = hub.clone();
    let expiry_hub = hub.clone();
    let tcp_task = tokio::spawn(async move {
        loop {
            let (s, _) = tcp_listener.accept().await?;
            tokio::spawn(net::tcp(s, tcp_hub.clone(), key.clone()));
        }
        #[allow(unreachable_code)]
        Ok::<(), io::Error>(())
    });
    let udp_task = tokio::spawn(async move {
        let mut b = [0u8; 1201];
        loop {
            let (n, addr) = udp_socket.recv_from(&mut b).await?;
            udp_hub.lock().unwrap().udp_register(&b[..n], addr);
        }
        #[allow(unreachable_code)]
        Ok::<(), io::Error>(())
    });
    tokio::spawn(async move {
        let notify = expiry_hub.lock().unwrap().changed.clone();
        loop {
            let changed = notify.notified();
            let deadline = expiry_hub.lock().unwrap().next_deadline();
            if let Some(d) = deadline {
                tokio::select! {_=changed=>{},_=sleep_until(d)=>{expiry_hub.lock().unwrap().expire();}}
            } else {
                changed.await
            }
        }
    });
    println!("chess-server 0.5.0 TCP={tcp} HTTP={http} UDP={udp}");
    let app = axum::Router::new()
        .route("/ws", axum::routing::get(net::ws_upgrade))
        .fallback(net::asset)
        .with_state(hub);
    tokio::select! {result=axum::serve(http_listener,app)=>result,result=tcp_task=>result.map_err(io::Error::other)?,result=udp_task=>result.map_err(io::Error::other)?,_=tokio::signal::ctrl_c()=>Ok(())}
}
