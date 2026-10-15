use crate::{
    wire::{self, Cipher, Packet},
    AppState,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr, ToSocketAddrs, UdpSocket},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    thread,
    time::{Duration, Instant},
};
#[derive(Deserialize, Clone)]
pub struct Candidate {
    ip: String,
    port: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    peer_id: String,
    context: String,
    master: String,
    initiator: bool,
    candidates: Vec<Candidate>,
}
struct Assembly {
    parts: Vec<Option<Vec<u8>>>,
    created: Instant,
    bytes: usize,
}
struct Peer {
    id: String,
    context: String,
    send: Cipher,
    recv: Cipher,
    candidates: Vec<SocketAddr>,
    remote: Option<SocketAddr>,
    pong: Option<Instant>,
    ready: bool,
    latency: f64,
    jitter: f64,
    loss: f64,
    probe_count: u32,
    probe_acked: u32,
    probes: VecDeque<(SocketAddr, [u8; 8], Instant, bool)>,
    fragments: HashMap<String, Assembly>,
    budget: usize,
    budget_at: Instant,
}
pub struct Udp {
    socket: UdpSocket,
    peers: Mutex<HashMap<String, Peer>>,
    closed: AtomicBool,
    state: Weak<AppState>,
    started: Instant,
}
impl Udp {
    pub fn start(state: Weak<AppState>) -> Result<Arc<Self>, String> {
        let socket = UdpSocket::bind("0.0.0.0:0").map_err(|_| "UDP端口不可用")?;
        socket.set_nonblocking(true).map_err(|_| "UDP设置失败")?;
        let this = Arc::new(Self {
            socket,
            peers: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            state,
            started: Instant::now(),
        });
        let worker = this.clone();
        thread::Builder::new()
            .name("cyber-udp".into())
            .spawn(move || worker.run())
            .map_err(|_| "UDP线程失败")?;
        Ok(this)
    }
    pub fn clear(&self) {
        self.peers.lock().unwrap().clear()
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.clear()
    }
    pub fn open(&self, c: Config) -> Result<(), String> {
        if !wire::valid_id(&c.peer_id) || c.candidates.len() > 24 {
            return Err("Invalid peer".into());
        }
        let mut peers = self.peers.lock().unwrap();
        if !peers.contains_key(&c.peer_id) && peers.len() >= 16 {
            return Err("Too many peers".into());
        }
        if peers
            .get(&c.peer_id)
            .is_some_and(|p| p.context == c.context)
        {
            return Ok(());
        }
        let master = zeroize::Zeroizing::new(B64.decode(c.master).map_err(|_| "Invalid key")?);
        let (send, recv) = wire::udp_keys(&c.context, &master, c.initiator)?;
        let candidates = c
            .candidates
            .iter()
            .filter_map(|v| {
                v.ip.parse::<IpAddr>()
                    .ok()
                    .filter(|ip| ip.is_ipv4() && !ip.is_multicast() && !ip.is_unspecified())
                    .filter(|_| v.port > 0)
                    .map(|ip| SocketAddr::new(ip, v.port))
            })
            .collect();
        peers.insert(
            c.peer_id.clone(),
            Peer {
                id: c.peer_id,
                context: c.context,
                send,
                recv,
                candidates,
                remote: None,
                pong: None,
                ready: false,
                latency: 0.,
                jitter: 0.,
                loss: 0.,
                probe_count: 0,
                probe_acked: 0,
                probes: VecDeque::new(),
                fragments: HashMap::new(),
                budget: 0,
                budget_at: Instant::now(),
            },
        );
        Ok(())
    }
    pub fn register(&self, host: &str, port: u16, id: &str, ticket: &str) -> Result<(), String> {
        if !wire::valid_id(id) || ticket.len() > 256 {
            return Err("Invalid registration".into());
        }
        let target = (host, port)
            .to_socket_addrs()
            .map_err(|_| "地址解析失败")?
            .find(SocketAddr::is_ipv4)
            .ok_or("无IPv4地址")?;
        let p = Packet::new(
            16,
            "op:210\n",
            json!({"clientId":id,"ticket":ticket}).to_string(),
        );
        self.socket
            .send_to(&p.plain()?, target)
            .map_err(|_| "UDP登记失败")?;
        if let Some(s) = self.state.upgrade() {
            let port = self.socket.local_addr().map_err(|_| "UDP关闭")?.port();
            let candidates = if_addrs::get_if_addrs()
                .unwrap_or_default()
                .into_iter()
                .filter(|i| !i.is_loopback() && i.ip().is_ipv4())
                .take(16)
                .map(|i| json!({"ip":i.ip().to_string(),"port":port}))
                .collect::<Vec<_>>();
            s.event(json!({"type":"udpLocal","candidates":candidates}));
        }
        Ok(())
    }
    fn write(&self, peer: &mut Peer, p: &Packet, address: SocketAddr) -> Result<(), String> {
        let b = peer.send.encrypt(p)?;
        if b.len() > 1200 {
            return Err("UDP too large".into());
        }
        self.socket
            .send_to(&b, address)
            .map_err(|_| "UDP发送失败")?;
        Ok(())
    }
    pub fn send(&self, id: &str, p: &Packet) -> bool {
        // The socket is nonblocking. Do not let receive/reassembly lock contention
        // stall the capture thread either: this target can immediately use relay.
        let Ok(mut peers) = self.peers.try_lock() else {
            return false;
        };
        let Some(peer) = peers.get_mut(id) else {
            return false;
        };
        let Some(remote) = peer.remote.filter(|_| {
            peer.ready
                && peer
                    .pong
                    .is_some_and(|t| t.elapsed() < Duration::from_secs(4))
        }) else {
            return false;
        };
        let Ok(frame) = p.plain() else { return false };
        if p.kind != 64 || frame.len() > 900 * 32 {
            return false;
        }
        if peer.budget_at.elapsed() > Duration::from_secs(1) {
            peer.budget_at = Instant::now();
            peer.budget = 0
        }
        if peer.budget + frame.len() > 256000 {
            return false;
        }
        peer.budget += frame.len();
        if frame.len() + 28 <= 1200 {
            return self.write(peer, p, remote).is_ok();
        }
        let message = wire::random_id();
        let count = frame.len().div_ceil(900);
        for (part, chunk) in frame.chunks(900).enumerate() {
            if self
                .write(
                    peer,
                    &Packet::new(
                        64,
                        format!("transport:chunk\nmessage:{message}\npart:{part}\ncount:{count}\n"),
                        chunk,
                    ),
                    remote,
                )
                .is_err()
            {
                return false;
            }
        }
        true
    }
    fn probe(&self, p: &mut Peer, address: SocketAddr) {
        let token = (self.started.elapsed().as_nanos() as u64).to_be_bytes();
        if self
            .write(p, &Packet::new(64, "transport:ping\n", token), address)
            .is_ok()
        {
            p.probes.push_back((
                address,
                token,
                Instant::now(),
                p.ready && p.remote == Some(address),
            ));
            while p.probes.len() > 96 {
                p.probes.pop_front();
            }
        }
    }
    fn run(&self) {
        let mut buffer = [0; 1201];
        let mut tick = Instant::now();
        let mut report = Instant::now();
        let mut network_at = Instant::now();
        let mut interfaces = Self::interfaces();
        while !self.closed.load(Ordering::Relaxed) {
            while let Ok((n, address)) = self.socket.recv_from(&mut buffer) {
                if n <= 1200 {
                    self.receive(&buffer[..n], address)
                }
            }
            if tick.elapsed() >= Duration::from_millis(600) {
                tick = Instant::now();
                let report_now = report.elapsed() >= Duration::from_secs(2);
                let mut events = Vec::new();
                let mut peers = self.peers.lock().unwrap();
                for p in peers.values_mut() {
                    let mut expired = 0;
                    p.probes.retain(|(_, _, at, measured)| {
                        let keep = at.elapsed() < Duration::from_millis(1500);
                        if !keep && *measured {
                            expired += 1
                        }
                        keep
                    });
                    p.probe_count += expired;
                    let ready = p
                        .pong
                        .is_some_and(|at| at.elapsed() < Duration::from_secs(4));
                    if p.ready != ready || report_now {
                        p.ready = ready;
                        let mut event = json!({"type":"peer","peerId":p.id,"context":p.context,"ready":ready,"latency":p.latency,"queuedMs":0});
                        if p.probe_count >= 5 {
                            p.loss =
                                (1. - p.probe_acked as f64 / p.probe_count as f64).clamp(0., 1.);
                            event["loss"] = json!(p.loss);
                            event["jitter"] = json!(p.jitter);
                        }
                        events.push(event)
                    }
                    if p.probe_count > 100 {
                        p.probe_count /= 2;
                        p.probe_acked /= 2;
                    }
                    let addresses = if ready {
                        p.remote.into_iter().collect()
                    } else {
                        p.candidates.clone()
                    };
                    for address in addresses {
                        self.probe(p, address)
                    }
                    p.fragments
                        .retain(|_, a| a.created.elapsed() < Duration::from_secs(2));
                }
                drop(peers);
                if report_now {
                    report = Instant::now()
                }
                if let Some(s) = self.state.upgrade() {
                    for e in events {
                        s.event(e)
                    }
                }
            }
            if network_at.elapsed() > Duration::from_secs(3) {
                network_at = Instant::now();
                let fresh = Self::interfaces();
                if fresh != interfaces {
                    interfaces = fresh;
                    self.clear();
                    if let Some(s) = self.state.upgrade() {
                        s.voice.mute();
                        s.event(json!({"type":"networkChanged"}));
                    }
                }
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
    fn interfaces() -> Vec<String> {
        let mut addresses = if_addrs::get_if_addrs()
            .unwrap_or_default()
            .into_iter()
            .filter(|i| !i.is_loopback())
            .map(|i| i.ip().to_string())
            .collect::<Vec<_>>();
        addresses.sort();
        addresses
    }
    fn receive(&self, b: &[u8], address: SocketAddr) {
        let mut delivered = None;
        let mut peers = self.peers.lock().unwrap();
        for p in peers.values_mut() {
            let Ok(packet) = p.recv.decrypt(b, true) else {
                continue;
            };
            if packet.kind != 64 {
                break;
            }
            let Ok(h) = packet.fields() else { break };
            match h.get("transport").copied() {
                Some("ping") => {
                    if packet.body.len() == 8 {
                        let _ = self.write(
                            p,
                            &Packet::new(64, "transport:pong\n", &packet.body),
                            address,
                        );
                        if p.remote != Some(address)
                            && !p.probes.iter().any(|(a, _, t, _)| {
                                *a == address && t.elapsed() < Duration::from_millis(500)
                            })
                        {
                            self.probe(p, address)
                        }
                    }
                }
                Some("pong") => {
                    if let Some(i) = p.probes.iter().position(|(a, token, t, _)| {
                        *a == address
                            && token.as_slice() == packet.body
                            && t.elapsed() < Duration::from_secs(8)
                    }) {
                        let (_, _, at, measured) = p.probes.remove(i).unwrap();
                        if measured {
                            p.probe_count += 1;
                            p.probe_acked += 1;
                        }
                        let latency = at.elapsed().as_secs_f64() * 1000.;
                        p.jitter = p.jitter * 0.8 + (p.latency - latency).abs() * 0.2;
                        p.latency = latency;
                        if p.remote == Some(address) || !p.ready {
                            p.remote = Some(address);
                            p.pong = Some(Instant::now());
                        }
                    }
                }
                Some("chunk") => {
                    let frame = Self::fragment(p, &h, &packet.body);
                    if let Some(frame) = frame {
                        if let Ok(packet) = Packet::parse(&frame) {
                            if packet.kind == 64 {
                                delivered = Some((p.id.clone(), p.context.clone(), packet));
                            }
                        }
                    }
                }
                None => delivered = Some((p.id.clone(), p.context.clone(), packet)),
                _ => {}
            }
            break;
        }
        drop(peers);
        if let (Some((id, context, p)), Some(s)) = (delivered, self.state.upgrade()) {
            if !s.voice.receive(&p, Some(&id)) {
                if let Ok(bytes) = p.plain() {
                    s.event(json!({"type":"peerPacket","peerId":id,"context":context,"data":B64.encode(bytes)}));
                }
            }
        }
    }
    fn fragment(
        p: &mut Peer,
        h: &std::collections::BTreeMap<&str, &str>,
        body: &[u8],
    ) -> Option<Vec<u8>> {
        let id = *h.get("message")?;
        let part = h.get("part")?.parse::<usize>().ok()?;
        let count = h.get("count")?.parse::<usize>().ok()?;
        if !wire::valid_id(id) || count == 0 || count > 32 || part >= count || body.len() > 900 {
            return None;
        }
        if !p.fragments.contains_key(id) && p.fragments.len() >= 8 {
            return None;
        }
        let a = p.fragments.entry(id.into()).or_insert_with(|| Assembly {
            parts: vec![None; count],
            created: Instant::now(),
            bytes: 0,
        });
        if a.parts.len() != count
            || a.parts[part].is_some()
            || a.created.elapsed() > Duration::from_secs(2)
        {
            return None;
        }
        a.bytes += body.len();
        if a.bytes > 69649 {
            p.fragments.remove(id);
            return None;
        }
        a.parts[part] = Some(body.to_vec());
        if a.parts.iter().all(Option::is_some) {
            let a = p.fragments.remove(id)?;
            Some(a.parts.into_iter().flatten().flatten().collect())
        } else {
            None
        }
    }
}
