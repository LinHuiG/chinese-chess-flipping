import {RoomClient,id,object,native,nativeCall,base64,encoder,storageGet,storageSet,sameBinding} from './transport.js';
export class PluginRoom{
  constructor(plugin,rules,events={}){
    this.plugin=plugin;this.rules=rules;
    this.events=events;this.room=null;this.engine=null;this.state=null;this.seq=-1;this.lifecycle=0;this.operation=0;this.recovery=0;this.actions=new Map();this.completed=new Map();this.candidates=[];this.offers=new Map();this.relayProbes=new Map();this.relayLatency=new Map();
    this.client=new RoomClient({
      connected:(identity,resumed)=>this.connected(identity,resumed),
      status:s=>events.status?.(s),closed:s=>{this.connectedNow=false;this.latency=undefined;this.clearMemberNetwork();this.checkpoint();events.module?.({type:'disconnected'});events.status?.(s);events.changed?.();},
      latency:ms=>{this.latency=ms;events.network?.();},path:()=>events.network?.(),
      peerValid:(who,context)=>typeof context==='string'&&this.room?.members.some(p=>p.id===who&&p.udp)&&this.offers.get(who)?.context===context,
      message:m=>this.message(m),native:e=>this.nativeEvent(e)
    });
    this.lastTick=performance.now();this.lastPublish=this.lastSave=this.lastPresence=0;
    this.updateTimer();
  }
  get host(){return !!this.room&&!!this.self&&this.room.hostId===this.self;}
  get game(){return this.room?this.plugin:null;}
  get nickname(){return (storageGet('cyber.nickname','')||'旅人'+(this.self||'').slice(0,4)).slice(0,24);}
  activeKey(){return 'cyber.active.'+this.client.identityKey();}
  context(){return [this.room?.roomId||'',this.self,this.client.generation,this.lifecycle].join(':');}
  current(context){return context===this.context();}
  assertCurrent(context){if(!this.current(context))throw Object.assign(Error('房间已变化，请重新操作'),{code:'STALE_OPERATION'});}
  clearMemberNetwork(){this.relayProbes.clear();this.relayLatency.clear();this.lastSeen?.clear();}
  memberConnection(who){
    if(!this.room?.members.some(p=>p.id===who))return {kind:'',text:'',title:''};
    if(who===this.self)return {kind:'self',text:'我',title:'当前设备'};
    if(!this.client.ready)return {kind:'offline',text:'连接恢复中',title:'本机与服务器连接中断，等待恢复'};
    const now=performance.now(),quality=this.client.peerQuality.get(who),direct=this.client.peerLatency.get(who),relay=this.relayLatency.get(who),ms=value=>(Math.round(value*10)/10)+' ms';
    if(this.client.peerReady.has(who)&&quality?.ready&&now-quality.receivedAt<6000&&Number.isFinite(direct))return {kind:'direct',text:'P2P 可用 · '+ms(direct),title:'本机与此成员的认证 UDP 往返延迟；控制消息仍走服务器，语音按质量选路'};
    if(relay&&now-relay.at<10000)return {kind:'relay',text:'中转 · '+ms(relay.ms),title:'本机经服务器到此成员再返回的往返延迟，包含对方处理时间'};
    return {kind:'relay',text:'中转 · 待测',title:'等待此成员回复测量；不使用本机到服务器的延迟代替'};
  }
  presence(){
    const context=this.context(),now=performance.now();
    for(const p of this.room.members)if(p.id!==this.self){const probe=id();this.relayProbes.set(p.id,{probe,at:now,context});this.client.sendTo(this.room.roomId,p.id,{type:'presence'},{name:this.nickname,probe},'relay');}
    this.events.network?.();
  }
  async connected(identity,resumed){
    const recovery=++this.recovery;clearTimeout(this.rejoinTimer);
    if(this.self&&this.self!==identity.clientId)this.reset();
    this.self=identity.clientId;this.connectedNow=true;this.clearMemberNetwork();this.client.clearPeers();this.candidates=[];this.offers.clear();
    if(this.client.compatibilityError){if(this.room)this.reset();this.events.notice?.(this.client.compatibilityError);this.events.status?.(this.client.compatibilityError);this.events.changed?.();this.events.lobby?.();return;}
    const saved=storageGet(this.activeKey());
    if(!this.room&&saved?.self===this.self&&sameBinding(saved.room?.plugin,this.plugin.binding)){
      try{this.room=saved.room;this.password=saved.password||'';this.restoreSave=saved.restoreSave;this.seq=-1;if(saved.engine)this.engine=this.rules.restore(saved.engine);}
      catch{this.room=null;this.engine=null;}
    }
    const context=this.context();
    if(this.room){
      try{
        const membership=await this.client.roomSync(this.room.roomId);
        if(!this.current(context)||recovery!==this.recovery)return;
        if(membership.hostId!==this.room.hostId)throw Object.assign(Error('原房间已结束，存档仍保留'),{code:'ROOM_NOT_FOUND'});
        if(this.host){this.reconcile(membership);this.publish();this.discover();await this.events.module?.({type:'hostReady'});}
        else await this.resumeGuest();
      }catch(e){
        if(!this.current(context)||recovery!==this.recovery)return;
        if(['ROOM_NOT_FOUND','NOT_MEMBER','SESSION_EXPIRED'].includes(e.code)){this.reset();this.events.notice?.(e.message);}
        else{this.events.notice?.('正在恢复房间连接，请稍候');this.rejoinTimer=setTimeout(()=>{if(this.current(context)&&this.client.ready)this.connected(this.client.identity,true);},3000);}
      }
    }
    if(!resumed&&saved?.self&&saved.self!==this.self){this.reset();this.events.notice?.('原连接已过期，请重新建房；本地存档仍保留');}
    this.events.status?.('已连接');this.events.changed?.();this.events.lobby?.();
  }
  async list(){return this.client.listRooms({roomType:this.plugin.feature.slice(0,16)});}
  async create(gameId,name,capacity=2,continueSave=false,password=''){
    this.client.requireCompatible();
    if(this.room)throw Error('请先退出当前房间；更换插件必须重新建房');
    if(gameId!==this.plugin.key)throw Error('插件不匹配');
    const context=this.context(),operation=++this.operation;
    const saved=continueSave?this.rules.loadSave?.():null;
    if(continueSave&&!saved)throw Error('没有可继续的存档');
    const result=await this.client.createRoom({roomType:this.plugin.feature.slice(0,16),name,locked:!!password});
    this.assertCurrent(context);if(operation!==this.operation)throw Error('建房操作已取消');this.lifecycle++;
    this.password=password;this.room={roomId:result.roomId,hostId:this.self,name,game:gameId,plugin:this.plugin.binding,capacity:Math.max(this.plugin.min,Math.min(this.plugin.max,saved?.players?.length||capacity)),locked:!!password,
      members:[{id:this.self,name:this.nickname,ready:false,udp:!!native}],status:this.rules.initialStatus||'waiting',seconds:60,round:id(),seq:0,move:0};
    this.restoreSave=saved;this.engine=null;this.seq=-1;this.publish();this.checkpoint();this.discover();this.events.changed?.();
    await this.events.module?.({type:'hostReady'});
  }
  async resumeGuest(){
    clearTimeout(this.rejoinTimer);
    if(!this.room||this.host||!this.client.ready)return;
    const context=this.context();
    try{await this.join(this.room,this.room.game,true);}
    catch(e){
      if(!this.current(context))return;
      if(e.code==='DENIED'||e.code==='ROOM_NOT_FOUND'){this.reset();this.events.notice?.(e.message);this.events.changed?.();return;}
      this.events.notice?.('等待房主恢复连接…');this.rejoinTimer=setTimeout(()=>{if(this.current(context))this.resumeGuest();},3000);
    }
  }
  async join(selected,gameId=selected.game,recover=false,password=''){
    this.client.requireCompatible();
    if(this.room&&!recover)throw Error('请先退出当前房间');
    const context=this.context(),operation=++this.operation;
    const game=this.plugin;if(gameId!==game.key)throw Error('插件不匹配');
    let result;
    try{result=await this.client.joinRoom(selected.roomId,{feature:game.feature.slice(16),name:this.nickname,udp:!!native,password,plugin:this.plugin.binding,platform:this.plugin.platform});}
    catch(e){if(this.current(context)&&operation===this.operation&&!recover)await this.client.leaveRoom(selected.roomId).catch(()=>{});throw e;}
    this.assertCurrent(context);if(operation!==this.operation)throw Object.assign(Error('入房操作已取消'),{code:'STALE_OPERATION'});
    const decision=object(result.rawBody);
    if(!decision.allowed){await this.client.leaveRoom(selected.roomId).catch(()=>{});throw Object.assign(Error(decision.reason||'房主拒绝了申请'),{code:'DENIED'});}
    if(result.control.from!==decision.room?.hostId||decision.room?.game!==gameId||decision.room?.roomId!==selected.roomId)throw Error('房主回复无效');
    if(!recover)this.lifecycle++;this.room=decision.room;this.engine=null;this.seq=-1;this.apply(decision);this.checkpoint();this.discover();this.events.changed?.();this.events.module?.({type:'joined',access:decision.access});
  }
  async leave(){
    if(!this.room)return;
    const rid=this.room.roomId,context=this.context();if(this.host)await this.saveProgress(false);
    await this.events.module?.({type:'leaving'});if(!this.current(context))return;
    await this.client.leaveRoom(rid);if(!this.current(context))return;this.reset();this.events.changed?.();this.events.lobby?.();
  }
  reset(){
    this.events.module?.({type:'leaving'});
    this.lifecycle++;this.operation++;this.recovery++;clearTimeout(this.rejoinTimer);this.clearMemberNetwork();
    this.room=this.engine=this.state=this.restoreSave=this.mediaAccess=null;this.seq=-1;this.completed.clear();this.client.clearPeers();this.offers.clear();this.candidates=[];
    for(const a of this.actions.values()){clearTimeout(a.retry);clearTimeout(a.timeout);a.reject(Error('房间已结束'));}this.actions.clear();
    this.password='';this.membershipVersion=0;this.approved=null;this.pendingAdmissions?.clear();this.updateTimer();storageSet(this.activeKey(),null);if(native)nativeCall('roomActive','');this.events.module?.({type:'reset'});
  }
  message(m){
    try{
      const c=m.control;
      if(m.kind===16&&c.op==='102'){this.joinRequest(m);return;}
      if(m.kind===18&&c.op==='210'){const p=object(m.rawBody);this.candidates.push(p);this.setupPeers();return;}
      if(m.kind===18&&(c.op==='104'||c.op==='105')){
        const b=object(m.rawBody);if(!this.room||b.roomId!==this.room.roomId)return;
        if(c.op==='105'){if(this.host)this.saveProgress(false);this.reset();this.events.notice?.('房主退出，房间已解散');this.events.changed?.();this.events.lobby?.();}
        else if(b.clientId===this.self&&b.revoked){this.reset();this.events.changed?.();this.events.notice?.('已被移出房间');}
        else if(this.host)this.memberLeft(b.clientId);
        return;
      }
      if(m.kind!==64||!this.room||c.roomId!==this.room.roomId)return;
      if(!this.room.members.some(p=>p.id===c.from))return;
      if(this.rules.message?.(this,m))return;
      const b=object(m.rawBody);
      if(c.type==='state'&&c.from===this.room.hostId)this.apply(b);
      else if(c.type==='action'&&this.host)this.hostAction(c.from,c.messageId,b);
      else if(c.type==='reply'&&c.from===this.room.hostId){
        const pending=this.actions.get(c.messageId);if(!pending)return;
        this.actions.delete(c.messageId);clearTimeout(pending.retry);clearTimeout(pending.timeout);
        if(b.snapshot)this.apply(b.snapshot);if(b.ok)pending.resolve();else pending.reject(Error(b.error||'操作失败'));
      }else if(c.type==='presence'){
        this.lastSeen??=new Map();this.lastSeen.set(c.from,Date.now());
        if(m.path==='relay'&&/^[a-f0-9]{32}$/.test(b.probe))this.client.sendTo(this.room.roomId,c.from,{type:'presence.reply'},{probe:b.probe},'relay');
        if(this.host&&b.name){const p=this.room.members.find(p=>p.id===c.from);if(p.name!==b.name){p.name=String(b.name).slice(0,24);this.publish();}}
      }else if(c.type==='presence.reply'){
        const probe=this.relayProbes.get(c.from),now=performance.now();
        if(m.path==='relay'&&probe&&probe.probe===b.probe&&this.current(probe.context)&&now-probe.at>=0&&now-probe.at<10000){this.relayProbes.delete(c.from);this.relayLatency.set(c.from,{ms:now-probe.at,at:now});this.events.network?.();}
      }else if(c.type==='peer.offer'||c.type==='peer.answer')this.peerSignal(c.from,c.type,b);
    }catch(e){this.events.notice?.('收到无法识别的客户端消息');}
  }
  joinRequest(m){
    const context=this.context();this.joinChain=(this.joinChain||Promise.resolve()).then(async()=>{if(!this.host||!this.current(context)||m.control.roomId!==this.room.roomId)return;const membership=await this.client.roomSync(this.room.roomId);if(!this.current(context))return;this.reconcile(membership);return this.decideJoin(m);}).catch(()=>{if(this.current(context))this.client.replyJoin(m,{allowed:false,reason:'房主正在恢复成员信息，请稍后重试'}).catch(()=>{});});
    return this.joinChain;
  }
  async decideJoin(m){
    if(!this.host||m.control.roomId!==this.room.roomId)return;
    const b=object(m.rawBody),from=m.control.from,existing=this.approved?.has(from)?this.room.members.find(p=>p.id===from):null;
    let reason='';
    if(b.feature!==this.game.feature.slice(16)||!sameBinding(b.plugin,this.plugin.binding)||!this.plugin.targets[b.platform])reason='插件版本或平台不匹配';
    else if(!existing&&this.room.members.length>=this.room.capacity)reason='房间已满';
    else if(!existing&&this.rules.canJoin?.(this)===false)reason='本局进行中，请等房主回到等候室';
    else if(!existing&&this.password&&b.password!==this.password)reason='房间密码不正确';
    this.joinAttempts??=new Map();let attempt=this.joinAttempts.get(from);if(attempt&&Date.now()-attempt.at>=30000){this.joinAttempts.delete(from);attempt=null;}if(attempt&&attempt.count>=5)reason='尝试过多，请30秒后重试';
    if(reason){this.joinAttempts.set(from,{at:attempt?.at||Date.now(),count:(attempt?.count||0)+1});if(this.joinAttempts.size>128)this.joinAttempts.delete(this.joinAttempts.keys().next().value);}
    if(reason){this.client.replyJoin(m,{allowed:false,reason});return;}
    if(!existing){this.room.members=this.room.members.filter(p=>p.id!==from);this.room.members.push({id:from,name:String(b.name||'旅人').slice(0,24),ready:false,udp:!!b.udp});this.room.members.forEach(p=>p.ready=false);}
    else{existing.name=String(b.name||existing.name).slice(0,24);existing.udp=!!b.udp;}
    this.joinAttempts.delete(from);this.pendingAdmissions??=new Map();this.pendingAdmissions.set(from,Date.now()+5000);this.room.seq++;const snapshot=this.snapshot(),context=this.context();await this.client.replyJoin(m,{allowed:true,...snapshot,...(this.rules.joinData?.(this)||{})});if(!this.current(context))return;
    this.publish();this.checkpoint();this.setupPeers();
  }
  memberLeft(who){
    if(!this.room.members.some(p=>p.id===who))return;
    this.clearMemberNetwork();this.rules.memberLeft?.(this,who);
    this.room.members=this.room.members.filter(p=>p.id!==who);
    this.client.clearPeers();this.offers.clear();this.publish();this.checkpoint();this.setupPeers();
  }
  snapshot(){
    const state=this.engine?(this.rules.snapshot?.(this)||this.engine.snapshot()):null;
    return {room:this.room,state};
  }
  publish(exclude){
    if(!this.host)return;
    this.room.seq++;const snapshot=this.snapshot();this.state=snapshot.state;this.stateAt=performance.now();this.seq=this.room.seq;
    const bytes=encoder.encode(JSON.stringify(snapshot));
    for(const p of this.room.members)if(p.id!==this.self&&p.id!==exclude)this.client.sendTo(this.room.roomId,p.id,{type:'state'},bytes,'relay');
    this.updateTimer();this.events.changed?.();if(native)nativeCall('roomActive',this.room.name).catch(()=>{});
  }
  apply(snapshot){
    if(!snapshot.room||snapshot.room.roomId!==this.room?.roomId||snapshot.room.hostId!==this.room.hostId||!sameBinding(snapshot.room.plugin,this.room.plugin)||snapshot.room.game!==this.room.game||snapshot.room.seq<=this.seq)return;
    const changed=JSON.stringify(this.room.members)!==JSON.stringify(snapshot.room.members);
    if(changed){this.clearMemberNetwork();this.client.clearPeers();this.offers.clear();}
    this.room=snapshot.room;this.seq=this.room.seq;this.state=snapshot.state;this.stateAt=performance.now();this.events.changed?.();if(changed||performance.now()-(this.lastCheckpoint||0)>3000)this.checkpoint();
    this.updateTimer();if(native)nativeCall('roomActive',this.room.name).catch(()=>{});this.setupPeers();
  }
  action(action){
    if(!this.room)return Promise.reject(Error('尚未加入房间'));
    const messageId=id(),payload={round:this.room.round,action,...this.rules.actionData?.(this)};
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
      const error=this.perform(who,payload);this.publish(who);this.checkpoint();result={ok:!error,...(error?{error}:{})};
      this.completed.set(key,result);if(this.completed.size>128)this.completed.delete(this.completed.keys().next().value);
    }
    this.client.sendTo(this.room.roomId,who,{type:'reply',messageId},{...result,snapshot:this.snapshot()},'relay');
  }
  perform(who,payload){
    if(!this.host||!this.room.members.some(p=>p.id===who))return '不在房间中';
    if(payload.round!==this.room.round)return '对局已经更新，请重试';
    const a=payload.action||{},p=this.room.members.find(p=>p.id===who);
    if(a.type==='SYNC')return null;
    return this.rules.perform(this,who,a,p,payload);
  }
  start(){
    this.room.round=id();this.room.result=null;this.room.status='playing';this.room.move=0;this.completed.clear();
    const error=this.rules.start?.(this);this.lastTick=performance.now();return error||null;
  }
  rematch(){if(!this.host)return;this.room.status='waiting';this.engine=null;this.room.round=id();this.room.members.forEach(p=>p.ready=false);this.publish();this.checkpoint();}
  checkpoint(engineSave){
    if(!this.room)return;
    this.lastCheckpoint=performance.now();storageSet(this.activeKey(),{self:this.self,room:this.room,password:this.host?this.password:undefined,restoreSave:this.host?this.restoreSave:null,engine:this.host&&this.engine?(engineSave||this.engine.save(performance.now())):null});
  }
  saveProgress(notify=true){return this.rules.save?.(this,notify)||false;}
  tick(){
    const now=performance.now(),dt=(now-this.lastTick)/1000;this.lastTick=now;
    if(!this.room||!this.client.ready)return;
    if(this.host&&this.engine&&!this.background)this.rules.tick?.(this,now,dt);
    if(now-this.lastPresence>3000){
      this.lastPresence=now;
      this.presence();
      this.setupPeers();
      if(this.host&&!this.syncing){const context=this.context();this.syncing=true;this.client.roomSync(this.room.roomId).then(m=>{if(this.current(context))this.reconcile(m);}).catch(()=>{}).finally(()=>this.syncing=false);}
    }
  }
  updateTimer(){const ms=!this.room||this.background?1000:this.rules.tickMs||250;if(this.tickMs===ms)return;this.tickMs=ms;clearInterval(this.timer);this.timer=setInterval(()=>this.tick(),ms);}
  async discover(){
    if(!native||!this.room)return;
    const context=this.context();try{const b=object((await this.client.request(210,{})).rawBody);if(this.current(context))await nativeCall('udpRegister',this.self,b.ticket,b.port);}catch{}
  }
  nativeEvent(e){
    if(e.type==='udpLocal'){this.candidates.push(...e.candidates);this.setupPeers();}
    else if(e.type==='networkChanged'){this.clearMemberNetwork();this.events.network?.();this.client.clearPeers();this.offers.clear();this.candidates=[];this.discover();this.events.module?.(e);}
    else if(e.type==='foreground'||e.type==='background'){this.background=e.type==='background';if(this.background&&this.host)this.rules.background?.(this);this.updateTimer();this.events.module?.(e);if(!this.background){if(this.client.ready)this.connected(this.client.identity,true);else if(this.client.enabled)this.client.connect();}}
    else {this.events.module?.(e);this.events.native?.(e);}
  }
  reconcile(membership){
    if(!this.host||membership.roomId!==this.room.roomId||membership.version<(this.membershipVersion||0))return;
    this.membershipVersion=membership.version;const approved=this.approved=new Set(membership.members.map(p=>p.clientId));
    for(const p of [...this.room.members]){if(approved.has(p.id))this.pendingAdmissions?.delete(p.id);else if((this.pendingAdmissions?.get(p.id)||0)<Date.now())this.memberLeft(p.id);}
  }
  async setPassword(password){if(!this.host)throw Error('只有房主可以修改密码');if(password.length>64)throw Error('密码最多64个字符');const context=this.context();await this.client.roomSync(this.room.roomId,{locked:!!password});this.assertCurrent(context);this.password=password;this.room.locked=!!password;this.checkpoint();this.publish();}
  async kick(who){if(!this.host||who===this.self)return;const context=this.context();await this.client.roomSync(this.room.roomId,{revoke:[who]});this.assertCurrent(context);this.memberLeft(who);}
  setupPeers(){
    if(!native||!this.room||!this.candidates.length)return;
    for(const p of this.room.members){
      if(p.id===this.self||!p.udp)continue;
      let offer=this.offers.get(p.id);
      if(offer?.initiator&&!this.client.peerReady.has(p.id)&&Date.now()-offer.created>10000){this.offers.delete(p.id);offer=null;}
      if(!offer&&this.self<p.id){offer={context:id(),master:base64(crypto.getRandomValues(new Uint8Array(32))),initiator:true,created:Date.now()};this.offers.set(p.id,offer);
        this.client.sendTo(this.room.roomId,p.id,{type:'peer.offer'},{context:offer.context,master:offer.master,candidates:this.candidates},'relay');
      }else if(offer&&!offer.initiator&&!offer.opened){
        nativeCall('openPeer',JSON.stringify({...offer,peerId:p.id})).catch(()=>offer.opened=false);offer.opened=true;
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
      nativeCall('openPeer',JSON.stringify({...offer,peerId:from,candidates:b.candidates})).catch(()=>offer.opened=false);offer.opened=true;
    }
  }
}
