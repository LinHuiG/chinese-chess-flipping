// Shared App/Web rule, recovery and v3 framing checks. No external network.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {RoomVoice,encodeVoice,decodeVoice} from '../server/src/main/resources/web/voice.js';
import {WatchRoom} from '../server/src/main/resources/web/watch.js';
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
room.client.roomSync=async()=>({roomId:room.room.roomId,version:1,members:room.room.members.map(p=>({clientId:p.id}))});
await room.joinRequest({control:{roomId:room.room.roomId,from:players[2].id},rawBody:new TextEncoder().encode(JSON.stringify({feature:GAMES.chess.feature.slice(16)}))});assert.equal(decision.allowed,false);
room.reset();
console.log('PASS host framework: admission, readiness, one execution for duplicate action, private checkpoint');
clearInterval(room.timer);
for(const vector of JSON.parse(await readFile(new URL('./fixtures/voice-crv1.json',import.meta.url),'utf8')).vectors){
  const bytes=Uint8Array.from(Buffer.from(vector.packetHex,'hex')),decoded=decodeVoice(bytes);
  assert.deepEqual(Array.from(decoded.samples,s=>Math.round(s*32768)),vector.decoded,vector.name+' decode');
  assert.equal(Buffer.from(encodeVoice(Float32Array.from(vector.pcm,s=>s/32767),vector.stream,vector.sequence,vector.initialIndex,vector.sampleClock).bytes).toString('hex'),vector.packetHex,vector.name+' encode');
}
console.log('PASS voice: independent CRV1 reference vectors, endian/count/ADPCM samples');

// A bounded scheduler exercises public lifecycle methods without real sockets or sleeps.
async function withClock(check){
  const original={setTimeout,clearTimeout,setInterval,clearInterval},jobs=new Map();let now=0,next=1;
  const schedule=(fn,delay,repeat=0)=>{const key=next++;jobs.set(key,{fn,at:now+delay,repeat});return key;};
  globalThis.setTimeout=(fn,ms=0)=>schedule(fn,ms);globalThis.clearTimeout=key=>jobs.delete(key);
  globalThis.setInterval=(fn,ms)=>schedule(fn,ms,ms);globalThis.clearInterval=globalThis.clearTimeout;
  const advance=ms=>{const until=now+ms;let steps=0;while(true){const due=[...jobs].filter(([,j])=>j.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;assert.ok(++steps<100,'bounded fake clock');const[key,job]=due;now=job.at;if(job.repeat)job.at+=job.repeat;else jobs.delete(key);job.fn();}now=until;};
  try{await check({advance});}finally{jobs.clear();Object.assign(globalThis,original);}
}

await withClock(async({advance})=>{
  const originalSocket=globalThis.WebSocket,originalLocation=globalThis.location,sockets=[];
  class Socket{constructor(){this.readyState=0;sockets.push(this);}send(){}close(){this.readyState=3;}}
  globalThis.WebSocket=Socket;globalThis.location={host:'retry.test',href:'http://retry.test/'};
  const retryClient=new RoomClient(),identity={clientId:id(),token:'local-recovery-test'};
  const ready=socket=>{socket.readyState=1;socket.onopen();retryClient.receive(packet(4,{ok:1},identity));assert.equal(retryClient.ready,true);};
  try{
    retryClient.connect();ready(sockets[0]);sockets[0].onclose();advance(2999);
    retryClient.disconnect();advance(5000);assert.equal(sockets.length,1,'manual disconnect cancels a queued reconnect');assert.equal(retryClient.enabled,false);
    retryClient.connect();assert.equal(sockets.length,2,'explicit connect remains available');ready(sockets[1]);
    sockets[1].onclose();advance(3000);assert.equal(sockets.length,3,'automatic recovery still works when enabled');
  }finally{retryClient.disconnect();globalThis.WebSocket=originalSocket;globalThis.location=originalLocation;}
});
console.log('PASS R2: disconnect during retry wait, explicit reconnect, normal automatic recovery');

await withClock(async({advance})=>{
  const originalSocket=globalThis.WebSocket,originalLocation=globalThis.location,sockets=[];
  class Socket{constructor(){this.readyState=0;this.sent=[];sockets.push(this);}send(bytes){this.sent.push(decode(bytes));}close(){this.readyState=3;}}
  globalThis.WebSocket=Socket;globalThis.location={host:'expired.test',href:'http://expired.test/'};
  localStorage.setItem('cyber.identity.expired.test',JSON.stringify({clientId:id(),token:'expired-local-test'}));
  const recovery=new RoomClient();
  try{
    recovery.connect();sockets[0].readyState=1;sockets[0].onopen();
    recovery.receive(packet(4,{ok:0,error:'SESSION_EXPIRED'},{}));
    // Native transports report the failed READY and then one or more closed
    // callbacks. Repeated notification must preserve the pending recovery.
    recovery.nativeEvent({type:'closed',reason:'连接身份已过期'});recovery.nativeEvent({type:'closed'});
    advance(3000);assert.equal(sockets.length,2,'duplicate closed callbacks retain the automatic retry');
    sockets[1].readyState=1;sockets[1].onopen();assert.deepEqual(object(sockets[1].sent[0].rawBody),{},'the next handshake requests a fresh identity');
    recovery.receive(packet(4,{ok:1},{clientId:id(),token:'fresh-local-test'}));assert.equal(recovery.ready,true);
  }finally{recovery.disconnect();globalThis.WebSocket=originalSocket;globalThis.location=originalLocation;}
});
console.log('PASS session expiry: duplicate native closed callbacks preserve fresh-identity reconnect');

await withClock(async()=>{
  const host=new GameRoom();host.self=id();host.client.ready=true;host.client.sendTo=()=>true;
  const guestId=id(),rid=id(),hostAssociation=id(),oldAssociation=id(),newAssociation=id();
  host.room={roomId:rid,hostId:host.self,name:'recovery',game:'watch',capacity:6,members:[{id:host.self,name:'host'},{id:guestId,name:'old occupant'}],status:'watching',round:id(),seq:0};
  host.password='new password';
  const membership=(version,includeGuest,association)=>({roomId:rid,version,members:[{clientId:host.self,association:hostAssociation},...(includeGuest?[{clientId:guestId,association}]:[])]});
  const old=membership(10,true,oldAssociation);host.reconcile(old);host.reconcile(membership(11,false));
  assert.deepEqual(host.room.members.map(p=>p.id),[host.self],'authoritative snapshot removes an offline departure');
  let decision,authoritative=membership(11,false);host.client.roomSync=async()=>authoritative;host.client.replyJoin=(_,body)=>decision=body;
  const request=password=>({control:{roomId:rid,from:guestId},rawBody:new TextEncoder().encode(JSON.stringify({feature:GAMES.watch.feature.slice(16),name:'new occupant',password}))});
  // Reintroduce the stale local cache deliberately: the same ID is only pending,
  // not approved, and must not bypass the current password on a new association.
  host.room.members.push({id:guestId,name:'stale cache'});await host.joinRequest(request('old password'));
  assert.equal(decision.allowed,false);assert.match(decision.reason,/密码/);assert.equal(host.room.members.some(p=>p.id===guestId),false);
  await host.joinRequest(request('new password'));assert.equal(decision.allowed,true);
  authoritative=membership(12,true,newAssociation);host.reconcile(authoritative);
  const current=structuredClone(host.room.members);host.reconcile(old);
  assert.deepEqual(host.room.members,current,'older association snapshot cannot replace the rejoined member');assert.equal(host.membershipVersion,12);
  assert.equal(host.room.members.find(p=>p.id===guestId).name,'new occupant');
  host.reset();clearInterval(host.timer);
});
console.log('PASS R1: departed member reconciliation, same-ID fresh admission, stale association snapshot rejected');

await withClock(async({advance})=>{
  const host=new GameRoom(),guest=new GameRoom();host.self=id();guest.self=id();host.client.ready=guest.client.ready=true;
  host.room={roomId:id(),hostId:host.self,name:'ack recovery',game:'chess',capacity:2,members:[{id:host.self,name:'host',ready:false},{id:guest.self,name:'guest',ready:false}],status:'waiting',seconds:60,round:id(),seq:0,move:0};guest.room=structuredClone(host.room);
  const requests=[],replies=[];let executions=0;const perform=host.perform.bind(host);
  host.perform=(...args)=>{executions++;return perform(...args);};
  host.client.sendTo=(rid,to,headers,body,path)=>{
    if(headers.type!=='reply')return true;replies.push({rid,to,headers,body,path});
    // Simulate a lost first acknowledgement, including successful host execution.
    if(replies.length>1&&path==='relay')guest.message({kind:64,control:{...headers,roomId:rid,from:host.self},rawBody:new TextEncoder().encode(JSON.stringify(body))});
    return true;
  };
  guest.client.sendTo=(rid,to,headers,body,path)=>{requests.push({headers,body,path});host.hostAction(guest.self,headers.messageId,body);return true;};
  const done=guest.action({type:'READY',ready:true});assert.equal(executions,1);advance(400);await done;
  assert.deepEqual(requests.map(p=>p.path),['auto','relay']);assert.equal(requests[0].headers.messageId,requests[1].headers.messageId);
  assert.equal(executions,1,'relay retry must not execute the action twice');assert.equal(guest.actions.size,0);
  assert.ok(replies.length>=2&&replies.every(p=>p.path==='relay'),'all original and repeated action replies use reliable relay');
  assert.equal(guest.room.members.find(p=>p.id===guest.self).ready,true,'reliable reply repairs the guest snapshot');
  host.reset();guest.reset();clearInterval(host.timer);clearInterval(guest.timer);
});
console.log('PASS R3: lost acknowledgement, relay retry, exactly-once action and reliable snapshot reply');

const capabilities=['room-sync','room-broadcast','host-grant'];
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function settle(){for(let i=0;i<8;i++)await Promise.resolve();}
function watchHost(events={}){
  const game=new GameRoom(events);game.self=id();game.client.ready=true;game.client.identity={clientId:game.self,token:'test',capabilities};game.client.sendTo=()=>true;
  game.room={roomId:id(),hostId:game.self,name:'watch test',game:'watch',capacity:6,members:[{id:game.self,name:'host'}],status:'watching',round:id(),seq:0};
  return game;
}
await withClock(async()=>{
  const game=new GameRoom();assert.equal(game.host,false,'unconnected empty room is never a host');game.client.ready=true;game.client.identity={clientId:id(),token:'legacy',serverVersion:'99.0.0'};
  let requests=0;game.client.createRoom=game.client.joinRoom=async()=>{requests++;throw Error('must not be called');};
  await assert.rejects(game.create('watch','legacy'),{code:'INCOMPATIBLE_SERVER'});
  await assert.rejects(game.join({roomId:id(),game:'watch'}),{code:'INCOMPATIBLE_SERVER'});
  assert.equal(requests,0,'legacy connection is rejected before any room mutation');
  for(const missing of capabilities){game.client.identity.capabilities=capabilities.filter(c=>c!==missing);assert.throws(()=>game.client.requireCompatible(),{code:'INCOMPATIBLE_SERVER'});}
  game.client.identity.capabilities=capabilities;assert.doesNotThrow(()=>game.client.requireCompatible());clearInterval(game.timer);
});
console.log('PASS compatibility: capabilities required before create/join, version is not an authority, empty room not host');

await withClock(async({advance})=>{
  localStorage.values.clear();const notices=[],game=watchHost({notice:s=>notices.push(s)}),rid=game.room.roomId;
  let calls=0;game.client.roomSync=async()=>{if(++calls===1)throw Error('timeout');return {roomId:rid,hostId:game.self,version:1,members:[{clientId:game.self,association:id()}]};};
  await game.connected(game.client.identity,true);assert.equal(game.room.roomId,rid,'temporary recovery failure must retain host room');
  advance(3000);await settle();assert.equal(calls,2,'temporary failure retries recovery');assert.equal(game.room.roomId,rid);assert.equal(game.host,true);
  const old=deferred();game.client.roomSync=()=>old.promise;const recovery=game.connected(game.client.identity,true);
  game.reset();game.room={roomId:id(),hostId:game.self,game:'watch',members:[{id:game.self}],seq:0};const newer=game.room;
  old.reject(Object.assign(Error('old room disappeared'),{code:'ROOM_NOT_FOUND'}));await recovery;
  assert.equal(game.room,newer,'late recovery error cannot reset a newer room');
  const oldPassword=deferred();game.client.roomSync=()=>oldPassword.promise;const password=game.setPassword('old secret'),passwordRejected=assert.rejects(password,{code:'STALE_OPERATION'});
  game.reset();game.room={roomId:id(),hostId:game.self,game:'watch',members:[{id:game.self}],seq:0};oldPassword.resolve({});await passwordRejected;assert.equal(game.password,'');assert.equal(game.room.locked,undefined);
  game.client.roomSync=async()=>{throw Object.assign(Error('gone'),{code:'ROOM_NOT_FOUND'});};await game.connected(game.client.identity,true);assert.equal(game.room,null,'confirmed removal still exits the room');
  clearInterval(game.timer);
});
console.log('PASS recovery: timeout retains room and retries, stale recovery/password response cannot change new room, definitive removal exits');

await withClock(async()=>{
  const game=watchHost(),joinReply=deferred();game.client.leaveRoom=async()=>{};game.client.joinRoom=()=>joinReply.promise;
  const target={roomId:id(),game:'watch'},joining=game.join(target),rejected=assert.rejects(joining,{code:'STALE_OPERATION'});await settle();
  game.reset();game.room={roomId:id(),hostId:game.self,game:'watch',members:[{id:game.self}],seq:0};const current=game.room;
  const hostId=id();joinReply.resolve({control:{from:hostId},rawBody:new TextEncoder().encode(JSON.stringify({allowed:true,room:{...target,hostId,members:[{id:game.self}],seq:1}}))});await rejected;
  assert.equal(game.room,current,'late admission cannot attach to an abandoned room');game.reset();clearInterval(game.timer);
});
console.log('PASS admission lifecycle: delayed accepted JOIN cannot replace the current room');

await withClock(async()=>{
  const oldFetch=globalThis.fetch,oldDocument=globalThis.document,elements=new Map(),sent=[],game=watchHost();
  globalThis.document={getElementById(name){if(!elements.has(name))elements.set(name,{value:'secret',checked:true,open:true,close(){this.open=false;},replaceChildren(){this.cleared=true;}});return elements.get(name);}};
  const watch=Object.assign(Object.create(WatchRoom.prototype),{room:game,generation:0,voice:{stop(){}},video:{currentTime:0,pause(){},removeAttribute(){this.src='';},load(){}},render(){},current(){return 0;},follow(){}});
  game.events.module=e=>watch.event(e);game.client.broadcast=async(rid,to,headers,body)=>sent.push({rid,type:headers.type,body});
  const reply=body=>({status:200,text:async()=>JSON.stringify(body)});
  try{
    let request=deferred(),requested=0;globalThis.fetch=async()=>{requested++;return request.promise;};
    const login=watch.login('http://emby.test','viewer','password',true),cancelled=assert.rejects(login,{code:'STALE_OPERATION'});await settle();assert.equal(requested,1);
    game.reset();game.room={roomId:id(),hostId:game.self,game:'watch',members:[{id:game.self}],seq:0};
    request.resolve(reply({AccessToken:'old-room-token',User:{Id:'viewer'}}));await cancelled;
    assert.equal(watch.access,null);assert.equal(game.mediaAccess,null);assert.equal(sent.length,0,'late login token never broadcasts into another room');
    assert.equal(document.getElementById('emby-dialog').open,false);assert.equal(document.getElementById('emby-password').value,'');assert.equal(document.getElementById('emby-items').cleared,true);
    game.room.hostId=id();await assert.rejects(watch.login('http://emby.test','viewer','pw',true),/只有房主/);game.room.hostId=game.self;
    globalThis.fetch=async url=>reply(url.includes('AuthenticateByName')?{AccessToken:'current-token',User:{Id:'viewer',Policy:{IsAdministrator:false}}}:{Items:[{Id:'movie',Name:'test'}]});
    const movies=await watch.login('http://emby.test','viewer','pw',true);assert.equal(movies[0].Id,'movie');assert.equal(game.mediaAccess.token,'current-token');assert.equal(sent[0].rid,game.room.roomId);
    globalThis.fetch=async url=>reply(url.includes('PlaybackInfo')?{PlaySessionId:'session',MediaSources:[{Id:'source',SupportsDirectPlay:true}]}:{});
    await watch.select({Id:'movie',Name:'test',RunTimeTicks:120000000});assert.match(watch.video.src,/Videos\/movie\/stream/);assert.equal(watch.loading,false);assert.equal(watch.session.id,'session','valid host selection loads real playback info');
    const playback=deferred();globalThis.fetch=async url=>url.includes('PlaybackInfo')?playback.promise:reply({});
    const loading=watch.select({Id:'old-movie',Name:'old'}),stalePlayback=assert.rejects(loading,{code:'STALE_OPERATION'});await settle();game.reset();playback.resolve(reply({PlaySessionId:'old-session',MediaSources:[{Id:'source',SupportsDirectPlay:true}]}));await stalePlayback;assert.equal(watch.session,null);assert.equal(watch.video.src,'','late playback info cannot resume a departed room');
    game.room={roomId:id(),hostId:game.self,game:'watch',members:[{id:game.self}],seq:0};watch.access={base:'http://emby.test',token:'current-token',userId:'viewer'};
    request=deferred();globalThis.fetch=async()=>request.promise;const search=watch.search('test'),staleSearch=assert.rejects(search,{code:'STALE_OPERATION'});await settle();game.reset();request.resolve(reply({Items:[{Id:'stale'}]}));await staleSearch;
    assert.equal(watch.loading,false);assert.equal(game.mediaAccess,null);
  }finally{game.reset();clearInterval(game.timer);globalThis.fetch=oldFetch;globalThis.document=oldDocument;}
});
console.log('PASS Emby lifecycle: host check, successful login, delayed login/search isolation, reset closes dialog and clears authorization');

await withClock(async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator'),request=deferred(),game=watchHost();let stopped=0,created=0;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>request.promise}}});
  const voice=new RoomVoice(game,()=>{});voice.listen=async()=>{};voice.context={createMediaStreamSource(){created++;return {connect(){}};},close(){return Promise.resolve();}};voice.node={port:{postMessage(){}},disconnect(){}};
  try{const opening=voice.microphoneToggle();await settle();game.reset();voice.stop();request.resolve({getTracks:()=>[{stop(){stopped++;}}]});await opening;assert.equal(stopped,1,'late permission grant releases its microphone track');assert.equal(created,0);assert.equal(voice.microphone,false);}
  finally{voice.stop();clearInterval(game.timer);if(descriptor)Object.defineProperty(globalThis,'navigator',descriptor);else delete globalThis.navigator;}
});
console.log('PASS microphone lifecycle: permission granted after room exit cannot reopen capture and releases device');

await withClock(async()=>{
  const host=watchHost(),guest=new GameRoom();guest.self=id();host.room={...host.room,game:'chess',status:'playing',seconds:30,move:0,members:[{id:host.self,ready:true},{id:guest.self,ready:true}]};guest.room=structuredClone(host.room);guest.client.ready=true;
  host.engine=position(5,4,6,-7);host.engine.resetClock(performance.now());
  host.client.sendTo=(rid,to,headers,body)=>{if(headers.type==='state')guest.apply(object(body));return true;};
  host.hostAction(host.self,id(),{round:host.room.round,action:{type:'MOVE',from:5,to:6,move:0}});
  assert.equal(host.room.status,'finished');assert.deepEqual(host.room.result,{winnerId:host.self,reason:'棋子全部阵亡'});assert.deepEqual(guest.room.result,host.room.result,'winner is consistent in the guest snapshot');
  guest.rematch();assert.equal(guest.room.status,'finished','guest cannot start a rematch');const round=host.room.round;
  host.rematch();assert.equal(host.room.status,'waiting');assert.equal(guest.room.status,'waiting');assert.notEqual(host.room.round,round);assert.equal(host.engine,null);assert.ok(host.room.members.every(p=>p.ready===false));assert.ok(guest.room.members.every(p=>p.ready===false));
  host.reset();guest.reset();clearInterval(host.timer);clearInterval(guest.timer);
});
console.log('PASS chess room lifecycle: final capture, shared winner, host-only rematch and readiness reset');

// An isolated module graph enables the real native branch without changing the
// browser tests' cached transport singleton. No sockets or real native devices.
execFileSync(process.execPath,['--input-type=module','-e',`
import assert from 'node:assert/strict';
const events=new Map(),order=[],held=[],timers=new Map();let timerId=0;
globalThis.addEventListener=(name,fn)=>events.set(name,fn);
globalThis.setTimeout=(fn,ms)=>{const key=++timerId;timers.set(key,{fn,ms});return key;};globalThis.clearTimeout=key=>timers.delete(key);
const respond=(q,body={})=>events.get('native-room')({detail:{type:'mediaResponse',id:q.id,status:200,body:JSON.stringify(body)}});
globalThis.NativeRoom={
  settings:()=> '{}',
  playerStop:()=>{assert.equal(held.length,0,'playerStop must not cancel queued terminal reports');order.push('stop');},
  mediaConfigure:()=>{assert.equal(held.length,0,'origin cannot change before terminal reports complete');order.push('configure');},
  playerCommand:()=>{order.push('play');},
  mediaRequest:text=>{const q=JSON.parse(text),path=new URL(q.url).pathname;order.push(path);
    if(path.endsWith('Stopped')||path.endsWith('/Close')){held.push(q);return;}
    queueMicrotask(()=>respond(q,path.endsWith('PlaybackInfo')?{PlaySessionId:'new-session',MediaSources:[{Id:'source',SupportsDirectPlay:true}]}:{}));
  }
};
const {WatchRoom}=await import(${JSON.stringify(new URL('../server/src/main/resources/web/watch.js',import.meta.url).href)});
const state={epoch:'new',itemId:'new-movie',position:0,duration:60,version:0,playing:false};
const room={self:'native-test',room:{game:'watch',playback:state},context:()=> 'room-context',current:c=>c==='room-context',client:{ready:true}};
const watch=Object.assign(Object.create(WatchRoom.prototype),{room,generation:0,access:{base:'http://emby.test',token:'fixture',userId:'viewer'},session:{id:'old-session',itemId:'old',sourceId:'old-source',liveStreamId:'old-live'},video:{pause(){},removeAttribute(){},load(){}},current:()=>12,rectangle:()=>({}),follow(){},render(){}});
const stopped=watch.stopMedia();for(let i=0;i<8;i++)await Promise.resolve();assert.equal(order[0],'stop');assert.equal(held.length,2);assert.ok([...timers.values()].every(t=>t.ms===2000),'terminal reports have a two-second deadline');
const repeated=watch.stopMedia(),loaded=watch.load(state);for(let i=0;i<8;i++)await Promise.resolve();assert.equal(order.includes('configure'),false);
const reports=held.splice(0);for(const q of reports){assert.match(q.headers['X-Emby-Token'],/^fixture$/);respond(q);}
await Promise.all([stopped,repeated,loaded]);assert.equal(watch.session.id,'new-session');assert.equal(watch.loading,false);assert.ok(order.indexOf('configure')>order.indexOf('/LiveStreams/Close'));
const timedOut=watch.stopMedia();for(let i=0;i<8;i++)await Promise.resolve();assert.equal(held.length,1);
for(const [key,timer] of [...timers]){timers.delete(key);timer.fn();}await timedOut;assert.equal(watch.stopping,null,'offline Emby cannot block cleanup indefinitely');
`],{stdio:'pipe',timeout:5000});
console.log('PASS native media cleanup: stop before terminal reports, repeated stop shares cleanup, next origin waits, bounded timeout');
