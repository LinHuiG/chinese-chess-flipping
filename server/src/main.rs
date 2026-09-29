//! 运行入口：读取配置，启动 TCP / HTTP / UDP，共用一份内存状态。退出后所有用户、房间和棋局关联失效。
mod hub;
mod json;
mod net;
mod update;
mod wire;
use std::{io, sync::Arc};
use tokio::{
    net::{TcpListener, UdpSocket},
    time::sleep_until,
};
// 本地默认从工程目录读取；镜像指定 /app，资源无需编译进可执行程序。
fn resource_root() -> std::path::PathBuf {
    std::env::var_os("CHESS_RESOURCE_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}
// 读取正整数环境变量并检查范围；端口或线程数错误直接终止启动，避免默默使用错误配置。
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
// 一个 Tokio 运行时承载全部连接；工作线程数可配，不为每个用户创建运行时或线程。
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
// 先完成三个端口的绑定，再启动任务。UDP 仅用于登记；棋局中转沿用 TCP/WS。
// 当前服务端监听 IPv4，但可以通过控制链路交换客户端的全局 IPv6 候选。
async fn run(tcp: u16, http: u16, udp: u16) -> io::Result<()> {
    update::init().map_err(io::Error::other)?;
    net::init_assets()?;
    let tcp_listener = TcpListener::bind(("0.0.0.0", tcp)).await?;
    let http_listener = TcpListener::bind(("0.0.0.0", http)).await?;
    let udp_socket = UdpSocket::bind(("0.0.0.0", udp)).await?;
    let hub = hub::Hub::new(udp);
    // 本次进程的 TCP 握手密钥；不落盘，也不作为可跨服务端重启使用的身份凭据。
    let key = Arc::new(p256::SecretKey::random(&mut rand_core::OsRng));
    let tcp_hub = hub.clone();
    let udp_hub = hub.clone();
    let expiry_hub = hub.clone();
    // TCP 接入循环只接受连接，握手、限时写入和用户解绑交给 net 模块。
    let tcp_task = tokio::spawn(async move {
        loop {
            let (s, _) = tcp_listener.accept().await?;
            tokio::spawn(net::tcp(s, tcp_hub.clone(), key.clone()));
        }
        #[allow(unreachable_code)]
        Ok::<(), io::Error>(())
    });
    // UDP 登记只接收固定格式的小报文；源地址作为反射候选，不能据此断言 NAT 类型。
    let udp_task = tokio::spawn(async move {
        let mut b = [0u8; 1201];
        loop {
            let (n, addr) = udp_socket.recv_from(&mut b).await?;
            udp_hub.lock().unwrap().udp_register(&b[..n], addr);
        }
        #[allow(unreachable_code)]
        Ok::<(), io::Error>(())
    });
    // 全局只有一个到期调度任务。状态变化唤醒并重算最近期限，不给每个用户创建定时器。
    tokio::spawn(async move {
        let notify = expiry_hub.lock().unwrap().changed.clone();
        loop {
            let changed = notify.notified();
            let deadline = expiry_hub.lock().unwrap().next_deadline();
            if let Some(d) = deadline {
                // 新状态提前唤醒，否则只等到最近期限再扫描；普通心跳不用重复唤醒。
                tokio::select! {_=changed=>{},_=sleep_until(d)=>{expiry_hub.lock().unwrap().expire();}}
            } else {
                changed.await
            }
        }
    });
    println!("chess-server 0.6.0 TCP={tcp} HTTP={http} UDP={udp}");
    // HTTP 提供镜像内的网页、App 更新和 /ws 升级入口；外部反向代理负责 HTTPS/WSS。
    let app = axum::Router::new()
        .route("/api/app/version", axum::routing::get(update::http_version))
        .route(
            "/api/app/latest.apk",
            axum::routing::get(update::http_download),
        )
        .route("/ws", axum::routing::get(net::ws_upgrade))
        .fallback(net::asset)
        .with_state(hub);
    // 任一监听循环异常或收到退出信号即结束进程；不持久化或恢复运行中的房间。
    tokio::select! {result=axum::serve(http_listener,app)=>result,result=tcp_task=>result.map_err(io::Error::other)?,result=udp_task=>result.map_err(io::Error::other)?,_=tokio::signal::ctrl_c()=>Ok(())}
}
