// Pure client checks, no browser or external network required.
import assert from 'node:assert/strict';
import { GameEngine, HostController } from '../server/src/main/resources/web/game.js';
import { packet, decode, id } from '../server/src/main/resources/web/transport.js';
const game = new GameEngine(30, n => n - 1); game.start(1000); game.act(game.turn, -1, 0, 2000);
const saved = JSON.parse(JSON.stringify(game.save(3000, 100000)));
const restored = GameEngine.restore(saved, 100, 110000);
assert.deepEqual(restored.pieces, game.pieces); assert.deepEqual([...restored.history], [...game.history]);
assert.equal(restored.remaining(100), 19000); assert.equal(restored.checkTimeout(19100), true);
let now = 1000, messages = [];
const host = new HostController(m => messages.push(m), () => now);
let room = { roomId: 1, version: 2, gameId: '', playing: false, members: ['host','guest'], hostId: 'host' };
host.setRoom(room, 'host');
for (const actorId of room.members) host.action({ actorId, operationId: id(), action: { type: 'READY', ready: true } });
room = { ...room, version: 3, gameId: '3', playing: true, startId: messages.find(m => m.type === 'START').operationId };
host.setRoom(room,'host'); now = 2000;
const move = { actorId: room.members[host.game.turn], operationId: id(), action: { type:'MOVE', from:-1, to:0, move:0 } };
host.action(move);
const completed = JSON.parse(JSON.stringify(host.save())), resumed = new HostController(m => messages.push(m), () => now);
resumed.restore(completed);resumed.setRoom(room,'host');const deadline = resumed.game.deadline;
resumed.action(move);assert.equal(resumed.move,1);assert.equal(resumed.game.deadline,deadline);
const bytes = packet(16, { type: 'ACTION', operationId: move.operationId }, { action: move.action });
assert.deepEqual(decode(bytes.buffer).body, {action: move.action}); bytes[14] = 1; assert.throws(() => decode(bytes.buffer));
console.log('PASS: private board/history, refresh deadline, operation replay, v2 framing');

// 兵卒互吃覆盖双方颜色；己方、暗棋及非相邻目标仍不可吃。
for (const color of [1, -1]) {
  const pawn = new GameEngine(0, n => n - 1);
  pawn.pieces.fill(0); pawn.revealed.fill(true); pawn.pieces[5] = color * 7;
  for (let type = 1; type <= 7; type++) {
    pawn.pieces[6] = -color * type;
    assert.equal(pawn.legalMove(5, 6, color, true), type === 1 || type === 7);
  }
  pawn.pieces[6] = color * 7; assert.equal(pawn.legalMove(5, 6, color, true), false);
  pawn.pieces[6] = -color * 7; pawn.revealed[6] = false;
  assert.equal(pawn.legalMove(5, 6, color, true), false);
  pawn.pieces[10] = -color * 7; assert.equal(pawn.legalMove(5, 10, color, true), false);
}
console.log('PASS: pawn captures for both colors and invalid target boundaries');
