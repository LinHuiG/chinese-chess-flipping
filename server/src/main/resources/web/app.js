import { HostController } from './game.js';
import { GameSocket } from './transport.js';

const $ = id => document.getElementById(id);
const model = { online: false, self: '', room: null, state: null, receivedAt: 0, rooms: [], pages: [], listing: false,
  selected: -1, pendingMove: false, lastResult: '', lastGame: '', suppressEffects: true };
const names = { red: ['', '帅', '仕', '相', '车', '马', '炮', '兵'], black: ['', '将', '士', '象', '车', '马', '炮', '卒'] };
const reasonText = { TIMEOUT: '每步用时已到', NO_PIECES: '一方棋子已全部被吃', NO_MOVES: '没有合法行动',
  HOST_DISSOLVED: '房主认输并解散房间', DISCONNECTED: '对局中连接断开', LEFT: '对局中退出房间' };
const preferences = { sound: true, motion: true };
try { for (const key of Object.keys(preferences)) preferences[key] = localStorage.getItem(`chess.${key}`) !== 'false'; } catch { /* Private browsing may disable storage. */ }
let hostTimer, clockTimer, toastTimer, outcomeTimer, confirmAction;
let boardEffect;
let holdFinalBoard = false;
let boardView = {};
const audio = Object.fromEntries(['capture', 'victory', 'defeat'].map(name => [name, new Audio(`/${name}.wav`)]));
for (const sound of Object.values(audio)) { sound.preload = 'none'; sound.volume = .5; }
let audioUnlocked = false;
document.addEventListener('pointerdown', () => {
  if (audioUnlocked || !preferences.sound) return;
  audioUnlocked = true;
  // Unlock each element within the user's gesture; never emit a sound here.
  for (const sound of Object.values(audio)) {
    sound.muted = true;
    sound.play().then(() => { sound.pause(); sound.currentTime = 0; sound.muted = false; }).catch(() => { sound.muted = false; });
  }
}, { passive: true });
function play(name) {
  if (!preferences.sound || document.hidden || !audioUnlocked) return;
  for (const sound of Object.values(audio)) sound.pause();
  const sound = audio[name]; sound.currentTime = 0; sound.play().catch(() => {});
}
function motion() { return preferences.motion && !matchMedia('(prefers-reduced-motion: reduce)').matches && !document.hidden; }
function stopBoardEffect() {
  const effect = boardEffect; boardEffect = null;
  if (!effect) return;
  for (const animation of effect.animations) animation.cancel();
  effect.cell.classList.remove('in-motion'); effect.ghost?.remove();
}
// Animate only a single verified board change, never a snapshot that skipped moves.
function boardTransition(before, after) {
  const from = after.lastFrom, to = after.lastTo;
  if (before?.board?.length !== 32 || after.board?.length !== 32 || after.move !== before.move + 1
      || !Number.isInteger(from) || !Number.isInteger(to) || from < -1 || from >= 32 || to < 0 || to >= 32 || from === to) return null;
  if (before.board.some((value, index) => index !== from && index !== to && value !== after.board[index])) return null;
  const captured = after.captured.length - before.captured.length;
  if (from === -1) return before.board[to] === 99 && Math.abs(after.board[to]) >= 1 && Math.abs(after.board[to]) <= 7
      && captured === 0 ? { from, to, capture: false } : null;
  if (!before.board[from] || before.board[from] === 99 || after.board[from] !== 0 || after.board[to] !== before.board[from]) return null;
  return captured === (before.board[to] ? 1 : 0) ? { from, to, capture: captured === 1 } : null;
}
function animateBoard(change) {
  if (!motion() || !change) return;
  const cell = cells[change.to], piece = cell.firstElementChild;
  if (!piece || !piece.animate) return;
  const animations = [], effect = boardEffect = { cell, animations, ghost: null };
  const duration = change.from < 0 ? 210 : change.capture ? 280 : 220;
  cell.classList.add('in-motion');
  let frames;
  if (change.from < 0) frames = [{ transform: 'scaleX(.12)', opacity: .5 }, { transform: 'scaleX(1)', opacity: 1 }];
  else {
    const start = cells[change.from].getBoundingClientRect(), end = cell.getBoundingClientRect();
    frames = [{ transform: `translate(${start.left - end.left}px, ${start.top - end.top}px)` }, { transform: 'translate(0, 0)' }];
    if (change.capture) {
      // The captured identity is public in the new state, including a previously hidden piece.
      const value = model.state.captured.at(-1), side = value > 0 ? 'red' : 'black';
      const ghost = effect.ghost = node('span', `piece ${side} capture-ghost`, names[side][Math.abs(value)]);
      ghost.setAttribute('aria-hidden', 'true'); cell.append(ghost);
      animations.push(ghost.animate([{ opacity: 1, transform: 'scale(1)' },
        { opacity: 1, transform: 'scale(1)', offset: .45 }, { opacity: 0, transform: 'scale(.65)' }],
        { duration, easing: 'ease-out', fill: 'both' }));
    }
  }
  const moving = piece.animate(frames, { duration, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'both' });
  animations.push(moving);
  moving.finished.then(() => { if (boardEffect === effect) stopBoardEffect(); }, () => {});
}
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3500); }
function node(tag, className, text) { const element = document.createElement(tag); element.className = className; if (text !== undefined) element.textContent = text; return element; }
function openDialog(id) { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); $(id).showModal(); }
for (const close of document.querySelectorAll('.dialog-close')) close.addEventListener('click', () => close.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
});
function confirm(title, message, action) { $('confirm-title').textContent = title; $('confirm-message').textContent = message; confirmAction = action; openDialog('confirm-dialog'); }
$('confirm-cancel').onclick = () => $('confirm-dialog').close();
$('confirm-ok').onclick = () => { $('confirm-dialog').close(); const action = confirmAction; confirmAction = null; action?.(); };

const connection = new GameSocket({
  status: text => { $('status').textContent = text; },
  connected: () => { model.online = true; $('status').textContent = '已连接'; $('status').classList.add('online'); render(); },
  message: receive,
  closed: reason => {
    model.online = false; model.self = ''; model.rooms = []; model.pages = []; model.listing = false;
    clearRoom(); clearTimeout(outcomeTimer); $('status').textContent = reason; $('status').classList.remove('online');
    $('offline-message').textContent = reason; renderRooms(); render();
  }
});
const referee = new HostController(send);
function send(body) { if (!connection.request(body)) toast('连接尚未建立，请稍候'); }
function context(type) { return { type, roomId: model.room?.roomId, version: model.room?.version, gameId: model.room?.gameId || '' }; }
function action(value) { if (model.room) send({ ...context('ACTION'), action: value }); }
function isHost() { return model.room?.hostId === model.self; }
function myIndex() { return model.room?.members.indexOf(model.self) ?? -1; }
function matches(message) { return model.room && message.roomId === model.room.roomId && message.version === model.room.version && message.gameId === model.room.gameId; }
function clearRoom() {
  holdFinalBoard = false;
  boardView = {};
  stopBoardEffect();
  model.room = model.state = null; model.selected = -1; model.pendingMove = false; model.lastResult = ''; model.suppressEffects = true;
  referee.clear(); clearTimeout(hostTimer); clearTimeout(clockTimer);
}
function listRooms() {
  if (!model.online || model.room || model.listing) return;
  model.pages = []; model.listing = true; renderRooms(); send({ type: 'LIST' });
}
function sync() { if (model.room) action({ type: 'SYNC' }); else listRooms(); }
function scheduleHost() { clearTimeout(hostTimer); const delay = referee.nextTickDelay(); if (delay >= 0) hostTimer = setTimeout(() => { referee.tick(); scheduleHost(); }, delay); }

function receive(message) {
  switch (message.type) {
    case 'SESSION':
      model.self = message.selfId; clearRoom(); model.listing = false; listRooms(); break;
    case 'ROOMS':
      if (model.room) break;
      model.pages.push(...message.rooms);
      if (message.next > 0) send({ type: 'LIST', after: message.next });
      else { model.rooms = model.pages; model.pages = []; model.listing = false; renderRooms(); }
      break;
    case 'ROOM':
      if (model.room?.roomId === message.roomId && message.version <= model.room.version) break;
      if (!holdFinalBoard || message.playing) stopBoardEffect();
      model.room = message; model.state = null; model.selected = -1; model.pendingMove = false; model.listing = false;
      model.pages = []; model.suppressEffects = true;
      if (message.playing) { holdFinalBoard = false; model.lastResult = ''; clearTimeout(outcomeTimer); }
      referee.setRoom(message, model.self); break;
    case 'ROOM_CLOSED': clearRoom(); model.listing = false; listRooms(); break;
    case 'STATE':
      if (matches(message) && (!model.state || message.state.seq > model.state.seq)) {
        const previous = model.state;
        const transition = !model.suppressEffects && !document.hidden ? boardTransition(previous, message.state) : null;
        if (!(holdFinalBoard && !model.room.playing) && (!previous || previous.move !== message.state.move)) stopBoardEffect();
        model.state = message.state; model.receivedAt = performance.now();
        if (!previous || previous.move !== model.state.move) { model.selected = -1; model.pendingMove = false; }
        render();
        if (transition) {
          animateBoard(transition);
          if (transition.capture) play('capture');
        }
        model.suppressEffects = document.hidden;
      }
      scheduleHost(); return; // The accepted snapshot already rendered before its animation.
    case 'FORWARD': if (matches(message) && isHost()) referee.action(message); break;
    case 'GAME_OVER':
      if (matches(message) && message.gameId !== model.lastGame) {
        model.lastGame = message.gameId;
        const won = message.winnerId === model.self, reason = reasonText[message.reason] || '对局结束';
        model.lastResult = `${won ? '你赢了' : '本局落败'} · ${reason}`;
        model.pendingMove = true;
        if (!document.hidden) {
          clearTimeout(outcomeTimer);
          holdFinalBoard = !!boardEffect;
          outcomeTimer = setTimeout(() => {
            holdFinalBoard = false; stopBoardEffect(); render();
            $('outcome-symbol').textContent = won ? '胜' : '负'; $('outcome-symbol').classList.toggle('lost', !won);
            $('outcome-title').textContent = won ? '你赢了' : '本局落败'; $('outcome-reason').textContent = reason;
            openDialog('outcome-dialog'); play(won ? 'victory' : 'defeat');
          }, holdFinalBoard ? 300 : motion() ? 260 : 0);
        }
      }
      break;
    case 'RESULT':
      if (message.request === 'ACTION') model.pendingMove = false;
      if (!message.ok) {
        if (message.request === 'LIST') { model.listing = false; model.pages = []; renderRooms(); }
        toast(message.error || '操作失败'); referee.failed(message.request);
      }
      break;
  }
  scheduleHost(); render();
}

const players = Array.from({ length: 2 }, () => {
  const row = node('div', 'player-row'), avatar = node('span', 'avatar'), name = node('span', 'player-name'), status = node('span', 'player-status');
  row.append(avatar, name, status); $('players').append(row); return { avatar, name, status };
});
const cells = Array.from({ length: 32 }, (_, index) => {
  const button = node('button', 'cell'); button.type = 'button'; button.addEventListener('click', () => select(index));
  $('board').append(button); return button;
});
const captureViews = {};
for (const side of ['red', 'black']) {
  const parent = $(`${side}-captured`); parent.append(node('small', '', side === 'red' ? '红方' : '黑方'));
  captureViews[side] = Array.from({ length: 7 }, (_, i) => {
    const piece = node('span', 'captured-piece', names[side][i + 1]), count = node('b', '', '0'); count.hidden = true;
    piece.append(count); parent.append(piece); return { piece, count };
  });
}
function select(index) {
  const state = model.state, me = myIndex();
  if (!model.online || !model.room?.playing || !state?.board || state.winner >= 0 || model.pendingMove) return;
  if (state.turn !== me) { toast('请等待对方行动'); return; }
  const value = state.board[index], color = state.colors[me];
  if (model.selected === index) model.selected = -1;
  else if (model.selected >= 0) {
    if (value !== 99 && value !== 0 && Math.sign(value) === color) model.selected = index;
    else { model.pendingMove = true; action({ type: 'MOVE', from: model.selected, to: index, move: state.move }); model.selected = -1; }
  } else if (value === 99) { model.pendingMove = true; action({ type: 'MOVE', from: -1, to: index, move: state.move }); }
  else if (value && Math.sign(value) === color) model.selected = index;
  renderBoard();
}
function renderBoard() {
  const state = model.state, me = myIndex(), board = state?.board || Array(32).fill(0);
  const canPlay = !!state?.board && me >= 0 && state.turn === me && state.winner < 0 && !model.pendingMove;
  if (boardView.state === state && boardView.selected === model.selected && boardView.canPlay === canPlay) return;
  boardView = { state, selected: model.selected, canPlay };
  cells.forEach((cell, index) => {
    const value = board[index], side = value > 0 ? 'red' : 'black';
    if (cell.dataset.value !== String(value)) {
      cell.dataset.value = String(value); cell.replaceChildren();
      if (value) cell.append(node('span', `piece ${value === 99 ? 'covered' : side}`, value === 99 ? '' : names[side][Math.abs(value)]));
    }
    cell.classList.toggle('selected', model.selected === index); cell.classList.toggle('last', state?.lastTo === index);
    cell.setAttribute('aria-pressed', String(model.selected === index)); cell.setAttribute('aria-disabled', String(!canPlay));
    cell.setAttribute('aria-label', `第${Math.floor(index / 4) + 1}行第${index % 4 + 1}列，${!value ? '空格' : value === 99 ? '暗棋' : `${side === 'red' ? '红' : '黑'}${names[side][Math.abs(value)]}`}`);
  });
  for (const side of ['red', 'black']) captureViews[side].forEach(({ piece, count }, i) => {
    const value = (side === 'red' ? 1 : -1) * (i + 1), total = (state?.captured || []).filter(p => p === value).length;
    piece.classList.toggle('taken', total > 0); count.hidden = total === 0; count.textContent = total;
    piece.setAttribute('aria-label', `${side === 'red' ? '红' : '黑'}${names[side][i + 1]}，阵亡 ${total} 枚`);
  });
}
function renderRooms() {
  $('room-count').textContent = model.listing ? '正在刷新' : `${model.rooms.length} 个房间`;
  $('lobby-refresh').disabled = model.listing;
  $('rooms').replaceChildren(); $('empty').hidden = model.rooms.length > 0;
  for (const room of model.rooms) {
    const row = node('div', 'room-item card'), labels = node('div', 'room-labels');
    labels.append(node('div', 'room-title', `#${room.id} ${room.name}`), node('div', 'room-meta', `${room.count}/2 人 · ${room.playing ? '游戏中' : '等待中'}`));
    const join = node('button', '', '加入'); join.disabled = room.playing || room.count >= 2;
    join.onclick = () => { join.disabled = true; send({ type: 'JOIN', roomId: room.id }); setTimeout(() => { if (join.isConnected) join.disabled = room.playing || room.count >= 2; }, 1200); };
    row.append(labels, join); $('rooms').append(row);
  }
}
function render() {
  const view = !model.online ? 'offline' : !model.room ? 'lobby' : model.room.playing ? 'game' : 'waiting';
  // Room state changes immediately; only the final visible board waits for its short animation.
  if (holdFinalBoard && view === 'waiting') return;
  document.body.classList.toggle('playing', view === 'game');
  for (const name of ['offline', 'lobby', 'waiting', 'game']) $(name).hidden = name !== view;
  $('disconnect').hidden = !model.online;
  $('refresh').disabled = !model.online;
  for (const button of document.querySelectorAll('.dissolve')) button.hidden = !isHost();
  if (view === 'waiting') {
    $('waiting-id').textContent = `房间 #${model.room.roomId}`; $('waiting-name').textContent = model.room.name;
    players.forEach((player, i) => {
      const id = model.room.members[i], me = id === model.self, ready = !!model.state?.ready?.[id];
      player.avatar.textContent = id ? me ? '我' : '客' : '＋'; player.avatar.classList.toggle('empty-avatar', !id);
      player.name.textContent = id ? `${me ? '你' : '对方'}${i === 0 ? ' · 房主' : ''}` : '等待朋友加入';
      player.status.textContent = id ? ready ? '已准备' : '未准备' : '空位'; player.status.classList.toggle('prepared', ready);
    });
    for (const button of $('time-choices').children) {
      button.classList.toggle('active', Number(button.dataset.seconds) === (model.state?.seconds ?? 60));
      button.disabled = !isHost() || !model.state; button.setAttribute('aria-pressed', String(button.classList.contains('active')));
    }
    $('ready').disabled = !model.state; $('ready').textContent = model.state?.ready?.[model.self] ? '取消准备' : '准备';
    $('last-result').hidden = !model.lastResult; $('last-result').textContent = model.lastResult;
  }
  if (view === 'game') {
    $('game-room').textContent = `#${model.room.roomId} ${model.room.name}`;
    const state = model.state, me = myIndex(), myTurn = state?.turn === me;
    $('turn-badge').textContent = state ? `第 ${(state.move || 0) + 1} 回合` : '正在同步';
    $('turn').textContent = !state ? '等待棋面' : state.winner >= 0 ? '对局结束' : myTurn ? '轮到你了' : '对方思考中';
    $('my-color').textContent = !state?.colors?.[me] ? '首次翻棋决定颜色' : state.colors[me] > 0 ? '你执红方' : '你执黑方';
    renderBoard();
  }
  renderClock();
}
function renderClock() {
  clearTimeout(clockTimer);
  const remaining = model.state?.remaining;
  if (!model.room?.playing || remaining == null) { $('clock').textContent = '--:--'; return; }
  const left = remaining < 0 ? -1 : Math.max(0, remaining - (performance.now() - model.receivedAt));
  const seconds = Math.ceil(left / 1000);
  $('clock').textContent = left < 0 ? '无限' : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('clock').classList.toggle('urgent', left >= 0 && left <= 10000);
  if (left > 0 && !document.hidden) clockTimer = setTimeout(renderClock, Math.max(50, left % 1000 || 1000));
}

$('connect').onclick = () => connection.connect();
$('refresh').onclick = sync; $('lobby-refresh').onclick = listRooms;
$('create-open').onclick = () => { $('create-error').textContent = ''; openDialog('create-dialog'); $('room-name').focus(); };
$('create-form').onsubmit = event => {
  event.preventDefault(); const name = $('room-name').value.trim();
  if ([...name].length < 1 || [...name].length > 32 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    $('create-error').textContent = '请输入 1 至 32 个字符，不含控制字符。'; return;
  }
  send({ type: 'CREATE', name }); $('create-dialog').close();
};
$('ready').onclick = () => action({ type: 'READY', ready: !model.state?.ready?.[model.self] });
for (const choice of $('time-choices').children) choice.onclick = () => action({ type: 'TIME', seconds: Number(choice.dataset.seconds) });
for (const button of document.querySelectorAll('.leave')) button.onclick = () => confirm('退出房间？', model.room?.playing ? '当前对局将按退出判负。' : '退出后回到房间大厅。', () => send({ type: 'LEAVE' }));
for (const button of document.querySelectorAll('.dissolve')) button.onclick = () => confirm('解散房间？', model.room?.playing ? '你将认输，房间内的玩家会回到大厅。' : '房间内的玩家会回到大厅。', () => send(context('DISSOLVE')));
$('disconnect').onclick = () => confirm('断开连接？', model.room?.playing ? '当前对局将按退出判负。' : '再次连接后会回到大厅。', () => connection.disconnect());
let rulesLoaded = false;
async function showRules() {
  openDialog('rules-dialog');
  if (!rulesLoaded) try { const response = await fetch('/rules.txt'); if (!response.ok) throw Error(); $('rules-body').textContent = await response.text(); rulesLoaded = true; }
  catch { $('rules-body').textContent = '规则加载失败，请关闭后重试。'; }
}
$('rules-open').onclick = showRules; for (const button of document.querySelectorAll('.rules-link')) button.onclick = showRules;
$('settings-open').onclick = () => {
  $('server-address').textContent = location.host;
  $('connection-kind').textContent = location.protocol === 'https:' ? 'HTTPS · 安全连接' : 'HTTP · 普通连接';
  openDialog('settings-dialog');
};
for (const key of ['sound', 'motion']) {
  $(key).checked = preferences[key];
  $(key).onchange = () => {
    preferences[key] = $(key).checked; try { localStorage.setItem(`chess.${key}`, preferences[key]); } catch {}
    document.body.classList.toggle('no-motion', !preferences.motion);
    if (!preferences.motion) { holdFinalBoard = false; stopBoardEffect(); render(); }
    if (!preferences.sound) for (const sound of Object.values(audio)) sound.pause();
  };
}
document.body.classList.toggle('no-motion', !preferences.motion);
document.addEventListener('visibilitychange', () => {
  model.suppressEffects = true;
  if (document.hidden) {
    holdFinalBoard = false; stopBoardEffect(); render();
    clearTimeout(clockTimer); clearTimeout(outcomeTimer); for (const sound of Object.values(audio)) sound.pause();
  } else {
    connection.resume();
    if (connection.ready) { referee.tick(); scheduleHost(); sync(); }
    renderClock();
  }
});
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', event => { if (event.matches) stopBoardEffect(); });
window.addEventListener('resize', stopBoardEffect);
window.addEventListener('pagehide', () => connection.disconnect());
window.addEventListener('pageshow', event => { if (event.persisted) connection.connect(); });
window.addEventListener('online', () => connection.resume());
renderRooms(); render(); connection.connect();
