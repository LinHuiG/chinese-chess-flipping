export function id() { return [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join(''); }
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const routed = new Set(['ACTION', 'HOST_REPLY', 'HOST_STATE']);
export function packet(kind, control, body) {
  const c = encoder.encode(JSON.stringify(control)), b = body === null ? new Uint8Array() : encoder.encode(JSON.stringify(body));
  if (c.length > 4096 || b.length > 65536) throw Error('报文过大');
  const bytes = new Uint8Array(17 + c.length + b.length), view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfcfc); view.setUint32(2, bytes.length); view.setUint32(6, c.length); view.setUint32(10, b.length);
  bytes[14] = 2; bytes[15] = kind; bytes.set(c, 17); bytes.set(b, 17 + c.length); return bytes;
}
export function decode(buffer) {
  const v = new DataView(buffer);
  if (v.byteLength < 17 || v.getUint16(0) !== 0xfcfc || v.getUint32(2) !== v.byteLength || v.getUint8(14) !== 2 || v.getUint8(16) !== 0) throw Error('协议不兼容');
  const c = v.getUint32(6), b = v.getUint32(10);
  if (c > 4096 || b > 65536 || 17 + c + b !== v.byteLength) throw Error('报文长度无效');
  const object = (offset, size) => {
    const value = JSON.parse(decoder.decode(new Uint8Array(buffer, offset, size)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('报文格式无效'); return value;
  };
  return { kind: v.getUint8(15), control: object(17, c), body: object(17 + c, b) };
}
export class GameSocket {
  constructor(callbacks) { this.callbacks = callbacks; this.enabled = this.ready = false; this.socket = null; this.generation = 0; this.identity = {}; }
  connect() {
    this.enabled = true; clearTimeout(this.retry);
    if (this.socket || document.hidden) return;
    const generation = ++this.generation, url = new URL('/ws', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; this.callbacks.status('正在连接…');
    let socket;
    try { socket = this.socket = new WebSocket(url); socket.binaryType = 'arraybuffer'; }
    catch { this.finish(generation, '无法连接服务器'); return; }
    this.startedAt = performance.now();
    socket.onopen = () => {
      if (generation !== this.generation) return;
      // CLIENT_FINISHED has an empty body; metadata and identity are in its control region.
      this.send(packet(5, { CHL: 'WEB', protocol: 2, ...this.identity }, null));
    };
    socket.onmessage = event => {
      if (generation !== this.generation) return;
      try {
        const message = decode(event.data);
        if (!this.ready) {
          if (message.kind !== 6) throw Error();
          this.ready = true; this.pongAt = this.pingAt = performance.now(); this.callbacks.connected(); return;
        }
        if (message.kind === 33) {
          if (message.control.ping === this.pingAt) { this.pongAt = performance.now(); this.callbacks.latency?.(Math.max(0, Math.round(this.pongAt - this.pingAt))); }
        } else if (message.kind === 18) this.callbacks.message({ ...message.body, ...message.control });
        else throw Error();
      } catch { this.finish(generation, '连接中断，请重新连接'); }
    };
    socket.onclose = () => this.finish(generation, '连接已断开');
    socket.onerror = () => this.finish(generation, '连接失败，请检查网络');
    this.timer = setInterval(() => this.tick(generation), 1000);
  }
  send(bytes) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 262144) { this.finish(this.generation, '发送失败，请重新连接'); return false; }
    try { this.socket.send(bytes); return true; } catch { this.finish(this.generation, '发送失败，请重新连接'); return false; }
  }
  request(value) {
    if (!this.ready) return false;
    const body = { ...value }, control = {};
    if (routed.has(body.type)) for (const key of ['type', 'roomId', 'version', 'operationId']) if (key in body) { control[key] = body[key]; delete body[key]; }
    try { return this.send(packet(16, control, body)); } catch { return false; }
  }
  tick(generation) {
    if (generation !== this.generation) return;
    const now = performance.now();
    if (!this.ready) { if (now - this.startedAt >= 15000) this.finish(generation, '连接超时'); return; }
    if (now - this.pongAt >= 15000) { this.finish(generation, '服务器响应超时'); return; }
    if (now - this.pingAt >= 5000) { this.pingAt = now; this.send(packet(32, { ping: now }, {})); }
  }
  finish(generation, reason) {
    if (generation !== this.generation) return;
    ++this.generation; clearInterval(this.timer); clearTimeout(this.retry);
    const socket = this.socket; this.socket = null; this.ready = false; this.callbacks.latency?.(null);
    if (socket) { socket.onclose = socket.onerror = socket.onmessage = socket.onopen = null; socket.close(); }
    this.callbacks.closed(reason);
    if (this.enabled && !document.hidden) { this.callbacks.status(`${reason}，3 秒后重连`); this.retry = setTimeout(() => this.connect(), 3000); }
  }
  disconnect() { this.enabled = false; this.finish(this.generation, '已断开连接'); }
  resume() { if (this.enabled) { if (!this.socket) this.connect(); else this.tick(this.generation); } }
}
