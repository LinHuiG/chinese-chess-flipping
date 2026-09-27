export function id() { return [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join(''); }

export class GameSocket {
  constructor(callbacks) {
    this.callbacks = callbacks; this.did = id(); this.enabled = false; this.ready = false;
    this.socket = null; this.pending = new Map(); this.generation = 0;
  }
  connect() {
    this.enabled = true; clearTimeout(this.retry);
    if (this.socket || document.hidden) return;
    const generation = ++this.generation;
    const url = new URL('/ws', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.callbacks.status('正在连接…');
    let socket;
    try { socket = this.socket = new WebSocket(url); }
    catch { this.finish(generation, '无法连接服务器'); return; }
    this.startedAt = performance.now(); this.hello = id();
    socket.onopen = () => {
      if (generation !== this.generation) return;
      this.send({ type: 'HELLO', TID: this.hello, CHL: 'WEB', DID: this.did, APP: 'chess-flipping.web', VER: '0.4.0' });
    };
    socket.onmessage = event => {
      if (generation !== this.generation) return;
      try {
        if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > 69632) throw Error();
        const message = JSON.parse(event.data);
        if (!message || typeof message !== 'object' || typeof message.TID !== 'string' || !/^[0-9a-f]{32}$/.test(message.TID)
            || message.CODE !== 0 || !message.body || typeof message.body !== 'object' || Array.isArray(message.body)) throw Error();
        if (!this.ready) {
          if (message.type !== 'READY' || message.TID !== this.hello) throw Error();
          this.ready = true; this.pongAt = this.pingAt = performance.now(); this.callbacks.connected(); return;
        }
        if (message.type !== 'EVENT') {
          const expected = this.pending.get(message.TID);
          if (!expected || expected.type !== message.type) throw Error();
          this.pending.delete(message.TID);
          if (message.type === 'PONG') { this.pongAt = performance.now(); return; }
        }
        this.callbacks.message(message.body);
      } catch { this.finish(generation, '连接中断，请重新连接'); }
    };
    socket.onclose = () => this.finish(generation, '连接已断开');
    socket.onerror = () => this.finish(generation, '连接失败，请检查网络');
    this.timer = setInterval(() => this.tick(generation), 1000);
  }
  send(value) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 262144) {
      this.finish(this.generation, '发送失败，请重新连接'); return;
    }
    this.socket.send(JSON.stringify(value));
  }
  request(body) {
    if (!this.ready) return false;
    if (new TextEncoder().encode(JSON.stringify(body)).length > 65536) return false;
    this.queue('REQUEST', 'RESPONSE', body); return this.ready;
  }
  queue(type, expected, body = {}) {
    if (this.pending.size >= 128) { this.finish(this.generation, '服务器响应过慢'); return; }
    const tid = id(); this.pending.set(tid, { type: expected, at: performance.now() });
    this.send({ type, TID: tid, body });
  }
  tick(generation) {
    if (generation !== this.generation) return;
    const now = performance.now();
    if (!this.ready) { if (now - this.startedAt >= 18000) this.finish(generation, '连接超时'); return; }
    let expired = false;
    for (const entry of this.pending.values()) if (now - entry.at >= 15000) { expired = true; break; }
    if (now - this.pongAt >= 30000 || expired) {
      this.finish(generation, '服务器响应超时'); return;
    }
    if (now - this.pingAt >= 5000) { this.pingAt = now; this.queue('PING', 'PONG'); }
  }
  finish(generation, reason) {
    if (generation !== this.generation) return;
    ++this.generation; clearInterval(this.timer); clearTimeout(this.retry);
    const socket = this.socket; this.socket = null; this.ready = false; this.pending.clear();
    if (socket) { socket.onclose = socket.onerror = socket.onmessage = socket.onopen = null; socket.close(); }
    this.callbacks.closed(reason);
    if (this.enabled && !document.hidden) {
      this.callbacks.status(`${reason}，3 秒后重连`);
      this.retry = setTimeout(() => this.connect(), 3000);
    }
  }
  disconnect() { this.enabled = false; this.finish(this.generation, '已断开连接'); }
  resume() {
    if (!this.enabled) return;
    if (!this.socket) this.connect(); else this.tick(this.generation);
  }
}
