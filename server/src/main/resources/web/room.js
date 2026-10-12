import {RoomClient,id,object,native,base64,storageGet,storageSet} from './transport.js';
import {GameEngine} from './game.js';
import {GoldMine} from './miner.js';
export const GAMES={
  chess:{id:'chess',name:'翻棋',feature:'f937bda248ce4fab9c710a18bdffb2d3',min:2,max:2},
  miner:{id:'miner',name:'黄金矿工',feature:'847f9bdc31ee4ca895d42d673b6a02ae',min:2,max:3}
};
export class GameRoom{
  constructor(events={}){
    this.events=events;this.room=null;this.engine=null;this.state=null;this.seq=-1;this.actions=new Map();this.completed=new Map();this.candidates=[];this.offers=new Map();
    this.client=new RoomClient({
      connected:(identity,resumed)=>this.connected(identity,resumed),
      status:s=>events.status?.(s),closed:s=>{this.connectedNow=false;this.checkpoint();events.status?.(s);events.changed?.();},
      latency:ms=>{this.latency=ms;events.network?.();},path:()=>events.network?.(),
      message:m=>this.message(m),native:e=>this.nativeEvent(e)
    });
    this.lastTick=performance.now();this.lastPublish=this.lastSave=this.lastPresence=0;
    this.timer=setInterval(()=>this.tick(),33);
  }
  get host(){return this.room?.hostId===this.self;}
  get game(){return this.room?GAMES[this.room.game]:null;}
  get nickname(){return (storageGet('cyber.nickname','')||'旅人'+(this.self||'').slice(0,4)).slice(0,24);}
  activeKey(){return 'cyber.active.'+this.client.identityKey();}
  async connected(identity,resumed){
    this.self=identity.clientId;this.connectedNow=true;this.client.clearPeers();this.candidates=[];this.offers.clear();
    const saved=storageGet(this.activeKey());
    if(!this.room&&saved?.self===this.self){
      try{this.room=saved.room;this.restoreSave=saved.restoreSave;this.seq=-1;if(saved.engine)this.engine=this.room.game==='chess'?GameEngine.restore(saved.engine,performance.now()):GoldMine.restore(saved.engine);}
      catch{this.room=null;this.engine=null;}
    }
    if(this.room){
      try{
        const rooms=await this.client.listRooms({roomType:GAMES[this.room.game].feature.slice(0,16)});
        if(!rooms.some(r=>r.roomId===this.room.roomId&&r.hostId===this.room.hostId))throw Error('原房间已结束，存档仍保留');
        if(this.host){this.room.members[0].id=this.self;this.publish();this.discover();}
        else await this.resumeGuest();
      }catch(e){this.reset();this.events.notice?.(e.message);}
    }
    if(!resumed&&saved?.self&&saved.self!==this.self){this.reset();this.events.notice?.('原连接已过期，可以重新建房继续矿工存档');}
    this.events.status?.('已连接');this.events.changed?.();this.events.lobby?.();
  }
  async list(){
    const lists=await Promise.all(Object.values(GAMES).map(async game=>(await this.client.listRooms({roomType:game.feature.slice(0,16)})).map(r=>({...r,game:game.id}))));
    return lists.flat();
  }
  async create(gameId,name,capacity=2,continueSave=false){
    if(this.room)await this.leave();
    const game=GAMES[gameId];if(!game)throw Error('游戏不存在');
    const saved=continueSave?storageGet('cyber.miner.save'):null;
    if(continueSave&&!saved)throw Error('没有可继续的矿工存档');
    const result=await this.client.createRoom({roomType:game.feature.slice(0,16),name});
    this.room={roomId:result.roomId,hostId:this.self,name,game:gameId,capacity:gameId==='chess'?2:saved?saved.players.length:Math.max(2,Math.min(3,capacity)),
      members:[{id:this.self,name:this.nickname,ready:false,udp:!!native}],status:'waiting',seconds:60,round:id(),seq:0,move:0};
    this.restoreSave=saved;this.engine=null;this.seq=-1;this.publish();this.checkpoint();this.discover();this.events.changed?.();
  }
  async resumeGuest(){
    clearTimeout(this.rejoinTimer);
    if(!this.room||this.host||!this.client.ready)return;
    try{await this.join(this.room,this.room.game,true);}
    catch(e){
      if(e.code==='DENIED'||e.code==='ROOM_NOT_FOUND'){this.reset();this.events.notice?.(e.message);this.events.changed?.();return;}
      this.events.notice?.('等待房主恢复连接…');this.rejoinTimer=setTimeout(()=>this.resumeGuest(),3000);
    }
  }
  async join(selected,gameId=selected.game,recover=false){
    const game=GAMES[gameId];if(!game)throw Error('游戏不存在');
    let result;
    try{result=await this.client.joinRoom(selected.roomId,{feature:game.feature.slice(16),name:this.nickname,udp:!!native});}
    catch(e){if(!recover)await this.client.leaveRoom(selected.roomId).catch(()=>{});throw e;}
    const decision=object(result.rawBody);
    if(!decision.allowed){await this.client.leaveRoom(selected.roomId).catch(()=>{});throw Object.assign(Error(decision.reason||'房主拒绝了申请'),{code:'DENIED'});}
    if(result.control.from!==decision.room?.hostId||decision.room?.game!==gameId||decision.room?.roomId!==selected.roomId)throw Error('房主回复无效');
    this.room=decision.room;this.engine=null;this.seq=-1;this.apply(decision);this.checkpoint();this.discover();this.events.changed?.();
  }
  async leave(){
    if(!this.room)return;
    const rid=this.room.roomId;if(this.host&&this.room.game==='miner')this.saveMine(false);
    await this.client.leaveRoom(rid);this.reset();this.events.changed?.();this.events.lobby?.();
  }
  reset(){
    clearTimeout(this.rejoinTimer);
    this.room=this.engine=this.state=this.restoreSave=null;this.seq=-1;this.completed.clear();this.client.clearPeers();this.offers.clear();this.candidates=[];
    for(const a of this.actions.values()){clearTimeout(a.retry);clearTimeout(a.timeout);a.reject(Error('房间已结束'));}this.actions.clear();
    storageSet(this.activeKey(),null);if(native)native.roomActive('');
  }
  message(m){
    try{
      const c=m.control;
      if(m.kind===16&&c.op==='102'){this.joinRequest(m);return;}
      if(m.kind===18&&c.op==='210'){const p=object(m.rawBody);this.candidates.push(p);this.setupPeers();return;}
      if(m.kind===18&&(c.op==='104'||c.op==='105')){
        const b=object(m.rawBody);if(!this.room||b.roomId!==this.room.roomId)return;
        if(c.op==='105'){if(this.host&&this.room.game==='miner')this.saveMine(false);this.reset();this.events.notice?.('房主退出，房间已解散');this.events.changed?.();this.events.lobby?.();}
        else if(this.host)this.memberLeft(b.clientId);
        return;
      }
      if(m.kind!==64||!this.room||c.roomId!==this.room.roomId)return;
      if(!this.room.members.some(p=>p.id===c.from))return;
      const b=object(m.rawBody);
      if(c.type==='state'&&c.from===this.room.hostId)this.apply(b);
      else if(c.type==='action'&&this.host)this.hostAction(c.from,c.messageId,b);
      else if(c.type==='reply'&&c.from===this.room.hostId){
        const pending=this.actions.get(c.messageId);if(!pending)return;
        this.actions.delete(c.messageId);clearTimeout(pending.retry);clearTimeout(pending.timeout);
        if(b.snapshot)this.apply(b.snapshot);if(b.ok)pending.resolve();else pending.reject(Error(b.error||'操作失败'));
      }else if(c.type==='presence'){
        this.lastSeen??=new Map();this.lastSeen.set(c.from,Date.now());
        if(this.host&&b.name){const p=this.room.members.find(p=>p.id===c.from);if(p.name!==b.name){p.name=String(b.name).slice(0,24);this.publish();}}
      }else if(c.type==='peer.offer'||c.type==='peer.answer')this.peerSignal(c.from,c.type,b);
    }catch(e){this.events.notice?.('收到无法识别的客户端消息');}
  }
  joinRequest(m){
    if(!this.host||m.control.roomId!==this.room.roomId)return;
    const b=object(m.rawBody),from=m.control.from,existing=this.room.members.find(p=>p.id===from);
    let reason='';
    if(b.feature!==this.game.feature.slice(16))reason='功能版本不匹配';
    else if(!existing&&this.room.members.length>=this.room.capacity)reason='房间已满';
    else if(!existing&&this.room.status==='playing')reason='本局进行中，请等房主回到等候室';
    if(reason){this.client.replyJoin(m,{allowed:false,reason});return;}
    if(!existing){this.room.members.push({id:from,name:String(b.name||'旅人').slice(0,24),ready:false,udp:!!b.udp});this.room.members.forEach(p=>p.ready=false);}
    else{existing.name=String(b.name||existing.name).slice(0,24);existing.udp=!!b.udp;}
    this.room.seq++;const snapshot=this.snapshot();this.client.replyJoin(m,{allowed:true,...snapshot});
    this.publish();this.checkpoint();this.setupPeers();
  }
  memberLeft(who){
    if(!this.room.members.some(p=>p.id===who))return;
    if(this.room.game==='miner'&&this.engine){this.engine.paused=true;this.restoreSave=this.engine.save();this.saveMine(false);}
    if(this.room.game==='chess'&&this.room.status==='playing')this.room.result={winnerId:this.self,reason:'对手退出'};
    this.room.members=this.room.members.filter(p=>p.id!==who);this.room.members.forEach(p=>p.ready=false);this.room.status='waiting';
    this.client.clearPeers();this.offers.clear();this.publish();this.checkpoint();this.setupPeers();
  }
  snapshot(){
    let state=null;
    if(this.engine&&this.room.game==='chess'){const g=this.engine;state={board:g.publicBoard(),colors:g.colors,turn:g.turn,remaining:g.remaining(performance.now()),captured:g.captured,lastFrom:g.lastFrom,lastTo:g.lastTo,winner:g.winner};}
    else if(this.engine)state=this.engine.snapshot();
    return {room:this.room,state};
  }
  publish(){
    if(!this.host)return;
    this.room.seq++;const snapshot=this.snapshot();this.state=snapshot.state;this.stateAt=performance.now();this.seq=this.room.seq;
    for(const p of this.room.members)if(p.id!==this.self)this.client.sendTo(this.room.roomId,p.id,{type:'state'},snapshot);
    this.events.changed?.();if(native)native.roomActive(this.room.name);
  }
  apply(snapshot){
    if(!snapshot.room||snapshot.room.roomId!==this.room?.roomId||snapshot.room.hostId!==this.room.hostId||snapshot.room.seq<=this.seq)return;
    this.room=snapshot.room;this.seq=this.room.seq;this.state=snapshot.state;this.stateAt=performance.now();this.events.changed?.();this.checkpoint();
    if(native)native.roomActive(this.room.name);this.setupPeers();
  }
  action(action){
    if(!this.room)return Promise.reject(Error('尚未加入房间'));
    const messageId=id(),payload={round:this.room.round,action};
    if(this.host){const error=this.perform(this.self,payload);this.publish();this.checkpoint();return error?Promise.reject(Error(error)):Promise.resolve();}
    return new Promise((resolve,reject)=>{
      const send=path=>this.client.sendTo(this.room.roomId,this.room.hostId,{type:'action',messageId},payload,path);
      const retry=setTimeout(()=>send('relay'),400);
      const timeout=setTimeout(()=>{this.actions.delete(messageId);reject(Error('房主暂时没有回应，请重试'));},5000);
      this.actions.set(messageId,{resolve,reject,retry,timeout});send('auto');
    });
  }
  hostAction(who,messageId,payload){
    if(!/^[a-f0-9]{32}$/.test(messageId))return;
    const key=who+':'+messageId;
    let result=this.completed.get(key);
    if(!result){
      const error=this.perform(who,payload);this.publish();this.checkpoint();result={ok:!error,...(error?{error}:{})};
      this.completed.set(key,result);if(this.completed.size>128)this.completed.delete(this.completed.keys().next().value);
    }
    this.client.sendTo(this.room.roomId,who,{type:'reply',messageId},{...result,snapshot:this.snapshot()});
  }
  perform(who,payload){
    if(!this.host||!this.room.members.some(p=>p.id===who))return '不在房间中';
    if(payload.round!==this.room.round)return '对局已经更新，请重试';
    const a=payload.action||{},p=this.room.members.find(p=>p.id===who);
    if(a.type==='SYNC')return null;
    if(a.type==='TIME'){
      if(who!==this.self||this.room.status!=='waiting'||![0,30,60,90].includes(a.seconds))return '现在不能设置时间';
      this.room.seconds=a.seconds;this.room.members.forEach(m=>m.ready=false);return null;
    }
    if(a.type==='READY'){
      if(this.room.status!=='waiting')return '已经开始';p.ready=!!a.ready;
      if(this.room.members.length===this.room.capacity&&this.room.members.every(m=>m.ready))return this.start();
      return null;
    }
    if(this.room.game==='chess'){
      if(a.type!=='MOVE'||this.room.status!=='playing'||!this.engine)return '当前不能走棋';
      if(a.move!==this.room.move)return '棋面已更新，请重新选择';
      const error=this.engine.act(this.room.members.findIndex(p=>p.id===who),a.from,a.to,performance.now());if(!error)this.room.move++;
      if(this.engine.winner>=0)this.finishChess();return error;
    }
    if(!this.engine)return '尚未开局';
    if(a.type==='PAUSE'){if(who!==this.self)return '只有房主可以暂停';this.engine.paused=!this.engine.paused;this.saveMine(false);return null;}
    if(a.type==='NEXT'){if(who!==this.self)return '等待房主开始下一关';const error=this.engine.next();if(!error)this.saveMine(false);return error;}
    return this.engine.act(who,a);
  }
  start(){
    this.room.round=id();this.room.result=null;this.room.status='playing';this.room.move=0;this.completed.clear();
    if(this.room.game==='chess'){this.engine=new GameEngine(this.room.seconds);this.engine.start(performance.now());}
    else if(this.restoreSave){try{this.engine=GoldMine.restore(this.restoreSave);this.engine.rebind(this.room.members);this.restoreSave=null;}catch(e){this.room.status='waiting';return e.message;}}
    else this.engine=new GoldMine(crypto.getRandomValues(new Uint32Array(1))[0],this.room.members);
    this.lastTick=performance.now();return null;
  }
  finishChess(){
    if(this.room.status!=='playing')return;
    const reasons={TIMEOUT:'回合超时',NO_PIECES:'棋子全部阵亡',NO_MOVES:'无合法走法'};
    this.room.result={winnerId:this.room.members[this.engine.winner]?.id,reason:reasons[this.engine.reason]||'对局结束'};
    this.room.status='finished';this.room.members.forEach(p=>p.ready=false);
  }
  rematch(){
    if(!this.host)return;this.room.status='waiting';this.engine=null;this.room.round=id();this.room.members.forEach(p=>p.ready=false);this.publish();this.checkpoint();
  }
  checkpoint(){
    if(!this.room)return;
    storageSet(this.activeKey(),{self:this.self,room:this.room,restoreSave:this.host?this.restoreSave:null,engine:this.host&&this.engine?(this.room.game==='chess'?this.engine.save(performance.now()):this.engine.save()):null});
  }
  saveMine(notify=true){
    if(!this.host||!this.engine||this.room.game!=='miner')return false;
    const ok=storageSet('cyber.miner.save',this.engine.save());this.checkpoint();
    if(notify||(!ok&&!this.saveFailed))this.events.notice?.(ok?'进度已保存在房主设备':'保存失败：设备存储空间不足');this.saveFailed=!ok;return ok;
  }
  tick(){
    const now=performance.now(),dt=(now-this.lastTick)/1000;this.lastTick=now;
    if(!this.room||!this.client.ready)return;
    if(this.host&&this.engine){
      if(this.room.game==='chess'&&this.room.status==='playing'&&this.engine.checkTimeout(now)){this.finishChess();this.publish();this.checkpoint();}
      if(this.room.game==='miner'){
        const phase=this.engine.phase;
        if(this.engine.step(dt)&&now-this.lastPublish>100){this.lastPublish=now;this.publish();}
        if(phase!==this.engine.phase){this.saveMine(false);this.publish();}
        if(now-this.lastSave>5000){this.lastSave=now;this.saveMine(false);}
      }
    }
    if(now-this.lastPresence>3000){
      this.lastPresence=now;
      for(const p of this.room.members)if(p.id!==this.self)this.client.sendTo(this.room.roomId,p.id,{type:'presence'},{name:this.nickname},'relay');
      this.setupPeers();
    }
  }
  async discover(){
    if(!native||!this.room)return;
    try{const b=object((await this.client.request(210,{})).rawBody);native.udpRegister(this.self,b.ticket,b.port);}catch{}
  }
  nativeEvent(e){
    if(e.type==='udpLocal'){this.candidates.push(...e.candidates);this.setupPeers();}
    else if(e.type==='background'&&this.host&&this.room?.game==='miner'&&this.engine){this.engine.paused=true;this.saveMine(false);this.publish();}
    else this.events.native?.(e);
  }
  setupPeers(){
    if(!native||!this.room||!this.candidates.length)return;
    for(const p of this.room.members){
      if(p.id===this.self||!p.udp)continue;
      let offer=this.offers.get(p.id);
      if(offer?.initiator&&!this.client.peerReady.has(p.id)&&Date.now()-offer.created>10000){this.offers.delete(p.id);offer=null;}
      if(!offer&&this.self<p.id){offer={context:id(),master:base64(crypto.getRandomValues(new Uint8Array(32))),initiator:true,created:Date.now()};this.offers.set(p.id,offer);
        this.client.sendTo(this.room.roomId,p.id,{type:'peer.offer'},{context:offer.context,master:offer.master,candidates:this.candidates},'relay');
      }else if(offer&&!offer.initiator&&!offer.opened){
        native.openPeer(JSON.stringify({...offer,peerId:p.id}));offer.opened=true;
        this.client.sendTo(this.room.roomId,p.id,{type:'peer.answer'},{context:offer.context,candidates:this.candidates},'relay');
      }
    }
  }
  peerSignal(from,type,b){
    if(!native||!Array.isArray(b.candidates)||b.candidates.length>24)return;
    if(type==='peer.offer'&&from<this.self&&/^[a-f0-9]{32}$/.test(b.context)&&typeof b.master==='string'){
      if(this.offers.get(from)?.context===b.context)return;
      this.offers.set(from,{context:b.context,master:b.master,candidates:b.candidates,initiator:false});this.setupPeers();
    }else if(type==='peer.answer'){
      const offer=this.offers.get(from);if(!offer||!offer.initiator||offer.context!==b.context||offer.opened)return;
      native.openPeer(JSON.stringify({...offer,peerId:from,candidates:b.candidates}));offer.opened=true;
    }
  }
}
