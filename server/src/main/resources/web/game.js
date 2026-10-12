// App 与 Web 共用的翻棋规则；暗棋身份只留在房主设备。
export function randomInt(bound) {
  const bytes = new Uint32Array(1), limit = Math.floor(0x100000000 / bound) * bound;
  do { crypto.getRandomValues(bytes); } while (bytes[0] >= limit);
  return bytes[0] % bound;
}

export class GameEngine {
  constructor(seconds, random = randomInt) {
    if (![0, 30, 60, 90].includes(seconds)) throw new Error('时间选项无效');
    this.seconds = seconds;
    this.pieces = [];
    for (const color of [1, -1]) for (let type = 1; type <= 7; type++)
      for (let i = 0; i < (type === 1 ? 1 : type === 7 ? 5 : 2); i++) this.pieces.push(color * type);
    for (let i = 31; i > 0; i--) { const j = random(i + 1); [this.pieces[i], this.pieces[j]] = [this.pieces[j], this.pieces[i]]; }
    this.revealed = Array(32).fill(false); this.colors = [0, 0]; this.captured = [];
    this.turn = random(2); this.winner = -1; this.reason = ''; this.lastFrom = this.lastTo = -1;
    this.started = false; this.deadline = 0; this.history = new Set([this.key()]);
  }
  save(now, wall = Date.now()) { return { ...this, history: [...this.history], deadline: wall + this.deadline - now }; }
  static restore(saved, now, wall = Date.now()) {
    if (![0,30,60,90].includes(saved.seconds) || saved.pieces?.length !== 32 || saved.revealed?.length !== 32 || saved.colors?.length !== 2
        || ![0,1].includes(saved.turn) || !Array.isArray(saved.history) || !Array.isArray(saved.captured) || !Number.isFinite(saved.deadline)
        || saved.pieces.some(p => !Number.isInteger(p) || Math.abs(p) > 7) || saved.revealed.some(v => typeof v !== 'boolean')) throw Error('棋局存档无效');
    const game = Object.assign(Object.create(GameEngine.prototype), saved, { history: new Set(saved.history), deadline: now + saved.deadline - wall });
    if (!game.history.has(game.key())) throw Error('棋局历史无效'); return game;
  }
  start(now) { if (!this.started) { this.started = true; this.resetClock(now); } }
  resetClock(now) { this.deadline = now + this.seconds * 1000; }
  remaining(now) { return this.seconds === 0 ? -1 : Math.max(0, this.started ? this.deadline - now : this.seconds * 1000); }
  checkTimeout(now) {
    if (this.winner < 0 && this.started && this.seconds > 0 && now >= this.deadline) {
      this.winner = 1 - this.turn; this.reason = 'TIMEOUT'; return true;
    }
    return false;
  }
  act(player, from, to, now) {
    if (!this.started) return '正在开始对局';
    if (this.checkTimeout(now) || this.winner >= 0) return '对局已经结束';
    if (player !== this.turn) return '请等待对方行动';
    if (!Number.isInteger(to) || to < 0 || to >= 32) return '目标超出棋盘';
    if (from === -1) {
      if (!this.pieces[to] || this.revealed[to]) return '请选择一枚暗棋';
      this.revealed[to] = true;
      if (this.colors[player] === 0) { this.colors[player] = Math.sign(this.pieces[to]); this.colors[1 - player] = -this.colors[player]; }
      this.history.clear();
    } else {
      if (!this.colors[player] || !this.legalMove(from, to, this.colors[player], true)) return '走法无效或会形成重复棋面';
      if (this.pieces[to]) { this.captured.push(this.pieces[to]); this.history.clear(); }
      this.pieces[to] = this.pieces[from]; this.revealed[to] = true;
      this.pieces[from] = 0; this.revealed[from] = false;
    }
    this.lastFrom = from; this.lastTo = to; this.history.add(this.key());
    for (let i = 0; i < 2; i++) {
      if (this.colors[i] && !this.pieces.some(p => Math.sign(p) === this.colors[i])) {
        this.winner = 1 - i; this.reason = 'NO_PIECES'; return null;
      }
    }
    this.turn = 1 - this.turn;
    if (!this.hasAction(this.colors[this.turn])) { this.winner = 1 - this.turn; this.reason = 'NO_MOVES'; }
    if (this.winner < 0) this.resetClock(now);
    return null;
  }
  publicBoard() { return this.pieces.map((p, i) => !p ? 0 : this.revealed[i] ? p : 99); }
  key() { return this.publicBoard().join(','); }
  hasAction(color) {
    if (this.pieces.some((p, i) => p && !this.revealed[i])) return true;
    for (let from = 0; from < 32; from++) for (let to = 0; to < 32; to++) if (this.legalMove(from, to, color, true)) return true;
    return false;
  }
  obstacles(from, to) {
    const step = Math.floor(from / 4) === Math.floor(to / 4) ? Math.sign(to - from) : 4 * Math.sign(to - from);
    let count = 0;
    for (let i = from + step; i !== to; i += step) if (this.pieces[i]) count++;
    return count;
  }
  legalMove(from, to, color, checkHistory) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= 32 || to < 0 || to >= 32
        || from === to || !color || !this.pieces[from] || !this.revealed[from] || Math.sign(this.pieces[from]) !== color) return false;
    const target = this.pieces[to], type = Math.abs(this.pieces[from]);
    if (target && this.revealed[to] && Math.sign(target) === color) return false;
    const dx = Math.abs(from % 4 - to % 4), dy = Math.abs(Math.floor(from / 4) - Math.floor(to / 4));
    const adjacent = dx + dy === 1, straight = dx === 0 || dy === 0;
    let valid = false;
    if (type === 5 && dx === 1 && dy === 1) valid = true;
    else if (type === 4 && straight && dx + dy >= 2) valid = this.obstacles(from, to) === 0;
    else if (type === 6 && straight) {
      const between = this.obstacles(from, to);
      if (!target) valid = between === 0;
      else if (between === 1) valid = true;
      else valid = adjacent && this.revealed[to] && Math.abs(target) === 7;
    } else if (adjacent) {
      if (!target) valid = true;
      else if (this.revealed[to]) {
        const other = Math.abs(target);
        valid = type === 1 ? other !== 7 : type === 7 ? (other === 1 || other === 7) : type >= 2 && type <= 5 && other > type;
      }
    }
    if (!valid || !checkHistory || target) return valid;
    const original = this.pieces[from];
    this.pieces[to] = original; this.revealed[to] = true; this.pieces[from] = 0; this.revealed[from] = false;
    const repeated = this.history.has(this.key());
    this.pieces[from] = original; this.revealed[from] = true; this.pieces[to] = 0; this.revealed[to] = false;
    return !repeated;
  }
}
