// Shared App/Web rule, recovery and v3 framing checks. No external network.
import assert from 'node:assert/strict';
import {GameEngine} from '../server/src/main/resources/web/game.js';
import {GoldMine,levelMap,SHOP} from '../server/src/main/resources/web/miner.js';
import {RoomClient,packet,decode,object,id} from '../server/src/main/resources/web/transport.js';
import {GameRoom,GAMES} from '../server/src/main/resources/web/room.js';
globalThis.localStorage={values:new Map(),getItem(k){return this.values.get(k)||null;},setItem(k,v){this.values.set(k,v);}};
globalThis.location={host:'test'};
function position(...pairs){
  const g=new GameEngine(30,n=>n-1);g.pieces.fill(0);g.revealed.fill(true);
  for(let i=0;i<pairs.length;i+=2)g.pieces[pairs[i]]=pairs[i+1];
  g.colors=[1,-1];g.turn=0;g.history=new Set([g.key()]);g.start(1000);return g;
}
const allowed=new Set('1:1 1:2 1:3 1:4 1:5 1:6 2:3 2:4 2:5 2:6 2:7 3:4 3:5 3:6 3:7 4:5 4:6 4:7 5:6 5:7 6:7 7:1 7:7'.split(' '));
for(const color of [1,-1])for(let a=1;a<=7;a++)for(let t=1;t<=7;t++){
  const g=position(5,color*a,6,-color*t);assert.equal(g.legalMove(5,6,color,true),allowed.has(a+':'+t));
  g.revealed[6]=false;assert.equal(g.legalMove(5,6,color,true),false);
  g.revealed[6]=true;g.pieces[6]*=-1;assert.equal(g.legalMove(5,6,color,true),false);
}
const rook=position(0,4,2,4,31,-1);rook.revealed[2]=false;assert.ok(rook.legalMove(0,2,1,true));rook.pieces[1]=7;assert.ok(!rook.legalMove(0,2,1,true));
const horse=position(5,5,6,7,9,7,10,5,31,-1);horse.revealed[10]=false;assert.ok(horse.legalMove(5,10,1,true));horse.revealed[10]=true;assert.ok(!horse.legalMove(5,10,1,true));horse.pieces[10]=-5;assert.ok(horse.legalMove(5,10,1,true));
const cannon=position(0,6,8,7,20,-6,28,-1);assert.ok(cannon.legalMove(0,4,1,true));assert.ok(!cannon.legalMove(0,12,1,true));assert.ok(cannon.legalMove(0,20,1,true));assert.ok(!cannon.legalMove(0,28,1,true));
const repeat=position(0,4,31,-4,16,7);repeat.revealed[16]=false;repeat.history=new Set([repeat.key()]);
assert.equal(repeat.act(0,0,1,1100),null);assert.equal(repeat.act(1,31,30,1200),null);assert.equal(repeat.act(0,1,0,1300),null);
assert.ok(repeat.act(1,30,31,1400));assert.equal(repeat.remaining(1400),29900);assert.equal(repeat.act(1,-1,16,1500),null);assert.ok(repeat.legalMove(30,31,-1,true));
const king=position(0,4,2,-1,31,-7);assert.equal(king.act(0,0,2,1100),null);assert.equal(king.winner,-1);
const last=position(0,4,2,-1);last.act(0,0,2,1100);assert.equal(last.reason,'NO_PIECES');
const trapped=position(0,-7,1,2,4,2,31,1);trapped.act(0,31,30,1100);assert.equal(trapped.reason,'NO_MOVES');
const g=new GameEngine(30,n=>n-1);g.start(1000);g.act(g.turn,-1,0,2000);
assert.equal(g.publicBoard().filter(p=>p===99).length,31);
const restored=GameEngine.restore(JSON.parse(JSON.stringify(g.save(3000,100000))),100,110000);
assert.deepEqual(restored.pieces,g.pieces);assert.equal(restored.remaining(100),19000);assert.ok(restored.checkTimeout(19100));
console.log('PASS chess: capture matrix, special moves, hidden identities, repetition, wins, saved deadline');
const raw=new Uint8Array([0,255,0,128]),ctrl='op:200\ntrace:x:y\nextra:one\nextra:two\n';
const decoded=decode(packet(16,ctrl,raw));assert.deepEqual(decoded.rawBody,raw);assert.equal(new TextDecoder().decode(decoded.rawControl),ctrl);
assert.throws(()=>packet(16,'to:a\nto:b\n',{}));assert.throws(()=>packet(16,'bad:value',{}));
assert.deepEqual(object(decode(packet(32,{}, {pingId:'1',sentAtMs:1})).rawBody),{pingId:'1',sentAtMs:1});
const v2=packet(3,{},{});v2[14]=2;assert.throws(()=>decode(v2));
const client=new RoomClient();client.ready=true;let forwarded;client.sendBytes=bytes=>{forwarded=decode(bytes);return true;};
const roomId=id(),target=id();assert.ok(client.sendTo(roomId,target,'trace:a:b\ntrace:c\n',raw));
assert.equal(new TextDecoder().decode(forwarded.rawControl),'op:200\nroomId:'+roomId+'\nto:'+target+'\ntrace:a:b\ntrace:c\n');assert.deepEqual(forwarded.rawBody,raw);
console.log('PASS v3: shared frame, raw bytes, extension preservation, ambiguous header rejection');
const players=[{id:id(),name:'A'},{id:id(),name:'B'},{id:id(),name:'C'}];
for(const count of [2,3]){
  const mine=new GoldMine(123,players.slice(0,count));mine.items=[{id:1,type:'gold',x:mine.players[0].claw.x,y:210,r:20,value:250,mass:1,owner:-1}];
  mine.target=100;mine.players[0].claw.angle=0;assert.equal(mine.act(players[0].id,{type:'DROP'}),null);
  for(let i=0;i<150&&mine.phase==='playing';i++)mine.step(.02);
  assert.equal(mine.players[0].round,250);assert.equal(mine.players[1].round,0);assert.equal(mine.phase,'shop');
  const cash=mine.players[0].cash;assert.equal(mine.act(players[0].id,{type:'BUY',item:'strength'}),null);assert.equal(mine.players[0].cash,cash-260);
  assert.ok(mine.act(players[0].id,{type:'BUY',item:'strength'}));assert.ok(mine.next());
  for(const p of mine.players)mine.act(p.id,{type:'SHOP_READY',ready:true});
  assert.equal(mine.next(),null);assert.equal(mine.level,2);assert.ok(mine.players[0].effects.strength);
  const save=mine.save(),copy=GoldMine.restore(save);assert.ok(copy.paused);assert.deepEqual(copy.items,mine.items);copy.rebind(players.slice(0,count));assert.ok(!copy.paused);
  assert.equal(JSON.stringify(save).length<20000,true);
  copy.players[0].inventory.dynamite=1;copy.players[0].claw.item=copy.items[0].id;copy.items[0].owner=0;
  assert.equal(copy.act(players[0].id,{type:'BOMB'}),null);assert.equal(copy.players[0].inventory.dynamite,0);assert.equal(copy.players[0].claw.item,-1);
}
const kinds=new Set();
for(let level=1;level<=1000;level++){const map=levelMap(42,level);assert.deepEqual(map,levelMap(42,level));assert.ok(map.length<=51);for(const o of map){kinds.add(o.type);assert.ok(o.x>=30&&o.x<=930&&o.y>=180&&o.y<=620);}}
assert.deepEqual([...kinds].sort(),['bag','diamond','gold','hamster','poop','rock','tnt']);
const final=new GoldMine(42,players,1000);final.step(100);assert.equal(final.phase,'complete');
assert.equal(SHOP.length,9);
console.log('PASS miner: 2/3 claws, individual score, shop, bomb, saves, 1000 deterministic levels and final completion');
const room=new GameRoom();clearInterval(room.timer);room.self=players[0].id;room.client.ready=true;room.client.sendTo=()=>true;
room.room={roomId:id(),hostId:room.self,name:'test',game:'chess',capacity:2,members:players.slice(0,2).map(p=>({...p,ready:false})),status:'waiting',seconds:60,seq:0,round:id(),move:0};
for(const p of room.room.members)assert.equal(room.perform(p.id,{round:room.room.round,action:{type:'READY',ready:true}}),null);
assert.equal(room.room.status,'playing');
const actor=room.room.members[room.engine.turn].id,actionId=id(),action={round:room.room.round,action:{type:'MOVE',from:-1,to:0,move:0}};
room.hostAction(actor,actionId,action);room.hostAction(actor,actionId,action);assert.equal(room.room.move,1);assert.equal(room.engine.publicBoard().filter(p=>p===99).length,31);
let decision;room.client.replyJoin=(request,body)=>decision=body;
room.joinRequest({control:{roomId:room.room.roomId,from:players[2].id},rawBody:new TextEncoder().encode(JSON.stringify({feature:GAMES.chess.feature.slice(16)}))});assert.equal(decision.allowed,false);
room.reset();
console.log('PASS host framework: admission, readiness, one execution for duplicate action, private checkpoint');
