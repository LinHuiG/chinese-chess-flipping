import {id,native,nativeCall,storageGet,storageSet} from './transport.js';
import {RoomVoice} from './voice.js';
const $=name=>document.getElementById(name),tick=10000000;
const pending=new Map();
globalThis.addEventListener?.('native-room',e=>{if(e.detail.type!=='mediaResponse')return;const p=pending.get(e.detail.id);if(!p)return;pending.delete(e.detail.id);clearTimeout(p.timer);e.detail.error?p.reject(Error(e.detail.error)):p.resolve(e.detail);});
export async function mediaRequest(url,method='GET',headers={},body,timeoutMs=20000){
  const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw Error('片源地址无效');
  let status,text;
  if(native?.mediaRequest){const requestId=id(),response=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('片源请求超时'));},timeoutMs);pending.set(requestId,{resolve,reject,timer});nativeCall('mediaRequest',JSON.stringify({id:requestId,url,method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})})).catch(e=>{pending.delete(requestId);clearTimeout(timer);reject(e);});});status=response.status;text=response.body||'';}
  else{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);try{const response=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,credentials:'omit',redirect:'error'});status=response.status;text=await response.text();if(text.length>2097152)throw Error('片源响应过大');}finally{clearTimeout(timer);}}
  if(status<200||status>=300)throw Error(status===401?'Emby 授权已失效，请房主重新登录':status===403?'Emby 不允许此次播放，请检查账号权限和并发限制':'Emby 请求失败（'+status+'）');
  return text?JSON.parse(text):{};
}
export class WatchRoom {
  constructor(room,notice){
    this.room=room;this.notice=notice;this.video=$('watch-video');this.voice=new RoomVoice(room,()=>this.render());this.epoch='';this.lastHost=performance.now();this.version=-1;this.generation=0;this.position=0;this.duration=0;this.micReady=false;
    this.video.addEventListener('loadedmetadata',()=>this.follow(true));this.video.addEventListener('ended',()=>{if(room.host)this.control(false,this.duration);});
    this.video.addEventListener('error',()=>this.showError('当前视频无法播放，请检查 Emby 格式、转码权限和跨域配置'));
    const playable=()=>{if(this.video.readyState>=2&&!this.video.seeking){this.buffering=false;this.render();}};
    for(const event of ['playing','canplay','seeked'])this.video.addEventListener(event,playable);
    this.video.addEventListener('waiting',()=>{this.buffering=true;this.render();});
    this.timer=setInterval(()=>this.pulse(),1000);this.resize=new ResizeObserver(()=>this.bounds());this.resize.observe($('watch-stage'));
    window.addEventListener('scroll',()=>this.bounds(),{passive:true});document.addEventListener('fullscreenchange',()=>this.bounds());
    new MutationObserver(()=>this.bounds()).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
  }
  get active(){return this.room.room?.game==='watch';}
  get nativePlayer(){return !!native?.playerCommand;}
  endpoint(path,query={},access=this.access){const url=new URL(access.base.replace(/\/$/,'')+'/'+path.replace(/^\//,''));for(const [k,v] of Object.entries(query))if(v!==undefined&&v!==null)url.searchParams.set(k,String(v));return url.toString();}
  headers(access=this.access){return {'Content-Type':'application/json','X-Emby-Token':access?.token||'','X-Emby-Authorization':`MediaBrowser Client="CyberRoom", Device="${native?'Native':'Web'}", DeviceId="${this.room.self}", Version="0.8.1"`};}
  validContext(context,generation){return this.active&&this.room.current(context)&&(generation===undefined||generation===this.generation);}
  async login(base,username,password,share){
    if(!this.active||!this.room.host)throw Error('只有房主可以配置片源');if(!share)throw Error('请确认将专用账号的播放权限共享给房间成员');
    this.room.client.requireCompatible();
    const context=this.room.context(),operation=this.loginOperation=(this.loginOperation||0)+1;
    const validate=()=>{this.room.assertCurrent(context);if(operation!==this.loginOperation||!this.active||!this.room.host)throw Object.assign(Error('片源操作已取消，请重新连接'),{code:'STALE_OPERATION'});};
    const url=new URL(base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('请输入有效的 Emby 服务地址');
    const access={base:url.href.replace(/\/$/,''),token:'',userId:''};
    await this.stopMedia();validate();this.room.room.playback=null;this.room.mediaAccess=null;this.access=null;this.loading=false;this.room.publish();await nativeCall('mediaConfigure',JSON.stringify({origin:url.origin}));validate();
    const auth=await mediaRequest(this.endpoint('Users/AuthenticateByName',{},access),'POST',this.headers(access),{Username:username,Pw:password});validate();
    if(!auth.AccessToken||!auth.User?.Id)throw Error('Emby 登录返回无效');
    if(auth.User.Policy?.IsAdministrator)throw Error('请使用非管理员观影账号，避免向房间共享管理权限');
    access.token=auth.AccessToken;access.userId=auth.User.Id;this.access=access;this.room.mediaAccess={...access};storageSet('cyber.emby.base',access.base);
    await this.send('watch.access',this.room.mediaAccess);validate();return this.search('');
  }
  async search(term){if(!this.active||!this.room.host)throw Error('只有房主可以选择片源');if(!this.access?.token)throw Error('先连接 Emby 片源');const context=this.room.context(),access=this.access,items=await mediaRequest(this.endpoint('Users/'+encodeURIComponent(access.userId)+'/Items',{Recursive:true,IncludeItemTypes:'Movie,Episode',SearchTerm:term,Limit:40,Fields:'RunTimeTicks,MediaSources',SortBy:'SortName'},access),'GET',this.headers(access));this.room.assertCurrent(context);if(this.access!==access)throw Object.assign(Error('片源已变化，请重新搜索'),{code:'STALE_OPERATION'});return items.Items||[];}
  async select(item){if(!this.active||!this.room.host)throw Error('只有房主可以选择片源');const context=this.room.context();this.room.room.playback={epoch:id(),itemId:item.Id,title:item.Name,duration:Number(item.RunTimeTicks||0)/tick,position:0,playing:false,version:0,at:performance.now()};this.room.publish();this.room.checkpoint();await this.load(this.room.room.playback);this.room.assertCurrent(context);this.render();}
  async send(type,body,to){if(!this.active)return;return to?this.room.client.sendTo(this.room.room.roomId,to,{type},body,'relay'):this.room.client.broadcast(this.room.room.roomId,undefined,{type},body);}
  async load(state){
    if(!state?.itemId||!this.access?.token||this.room.background)return;
    const generation=++this.generation,context=this.room.context(),access=this.access;this.loading=true;this.error='';
    try{
      await this.stopMedia(false);if(!this.validContext(context,generation))return;this.epoch=state.epoch;this.version=state.version;this.position=state.position;this.duration=state.duration||0;
      await nativeCall('mediaConfigure',JSON.stringify({origin:new URL(access.base).origin}));if(!this.validContext(context,generation))return;
      const start=this.target(state),profile={Name:'CyberRoom',MaxStreamingBitrate:12000000,DirectPlayProfiles:[{Container:'mp4,m4v',Type:'Video',VideoCodec:'h264',AudioCodec:'aac,mp3'}],TranscodingProfiles:[{Container:'ts',Type:'Video',VideoCodec:'h264',AudioCodec:'aac',Protocol:'hls',Context:'Streaming',MaxAudioChannels:'2',MinSegments:2,SegmentLength:3}],SubtitleProfiles:[{Format:'vtt',Method:'External'}]};
      const info=await mediaRequest(this.endpoint('Items/'+encodeURIComponent(state.itemId)+'/PlaybackInfo',{UserId:access.userId,DeviceId:this.room.self},access),'POST',this.headers(access),{UserId:access.userId,StartTimeTicks:Math.round(start*tick),MaxStreamingBitrate:12000000,EnableDirectPlay:true,EnableDirectStream:true,EnableTranscoding:true,IsPlayback:true,AutoOpenLiveStream:true,DeviceProfile:profile});
      if(!this.validContext(context,generation))return;
      const source=info.MediaSources?.[0];if(!source||info.ErrorCode)throw Error('Emby 没有提供可用播放源，请检查转码或并发权限');
      let stream=source.SupportsDirectPlay||source.SupportsDirectStream?source.DirectStreamUrl:null,transcoded=false;
      if(!stream&&source.TranscodingUrl){stream=source.TranscodingUrl;transcoded=true;}
      if(!stream&&source.SupportsDirectPlay)stream=this.endpoint('Videos/'+encodeURIComponent(state.itemId)+'/stream',{Static:true,MediaSourceId:source.Id},access);
      if(!stream)throw Error('片源格式不兼容，且 Emby 未提供可用转码');
      const url=new URL(stream,access.base.replace(/\/$/,'')+'/');if(url.origin!==new URL(access.base).origin)throw Error('片源返回了其他站点地址，无法安全共享授权');
      if(!url.searchParams.has('api_key'))url.searchParams.set('api_key',access.token);url.searchParams.set('DeviceId',this.room.self);
      this.session={itemId:state.itemId,id:info.PlaySessionId,sourceId:source.Id,liveStreamId:source.LiveStreamId,transcoded};this.offset=transcoded?start:0;this.url=url.href;
      if(this.nativePlayer){await nativeCall('playerCommand',JSON.stringify({url:this.url,positionMs:Math.max(0,start-this.offset)*1000,playing:false,rate:1,visible:true,bounds:this.rectangle()}));}
      else{if(/\.m3u8(?:\?|$)/i.test(url.href)&&!this.video.canPlayType('application/vnd.apple.mpegurl')){if(!globalThis.Hls?.isSupported())throw Error('此浏览器不支持当前 HLS 视频');this.hls=new Hls({maxBufferLength:15,backBufferLength:10});this.hls.on(Hls.Events.ERROR,(_,e)=>{if(e.fatal)this.showError('视频分片加载失败，请检查片源跨域或网络');});this.hls.loadSource(url.href);this.hls.attachMedia(this.video);}else this.video.src=url.href;}
      if(!this.validContext(context,generation))return;await this.checkin('Playing');if(!this.validContext(context,generation))return;this.loading=false;this.follow(true);this.render();
    }catch(e){if(this.validContext(context,generation)){this.loading=false;this.showError(e.message||'无法加载片源');}}
  }
  target(state=this.room.room?.playback){if(!state)return 0;const now=performance.now(),elapsed=state.playing&&!this.waiting&&!this.room.background?Math.max(0,(Number.isFinite(this.hostOffset)&&Number.isFinite(state.at)?now+this.hostOffset-state.at:now-(this.receivedAt||now))/1000):0;return Math.min(state.duration||Infinity,Math.max(0,state.position+elapsed));}
  async follow(force=false){
    const state=this.room.room?.playback;if(!state||this.loading||!this.url)return;
    const play=state.playing&&!this.waiting&&!this.room.background&&this.room.client.ready,target=this.target(state),current=this.current();
    if(this.nativePlayer){const change={playing:play,rate:1};if(force||Math.abs(current-target)>1.5)change.positionMs=Math.max(0,target-this.offset)*1000;await nativeCall('playerCommand',JSON.stringify(change));}
    else{if((force||Math.abs(current-target)>1.5)&&this.video.readyState)this.video.currentTime=Math.max(0,target-this.offset);this.video.playbackRate=!force&&play&&Math.abs(current-target)>.2?(current<target?1.03:.97):1;if(play)try{await this.video.play();this.autoplay=false;}catch{this.autoplay=true;}else this.video.pause();}
    this.render();
  }
  current(){return this.nativePlayer?this.position:(this.video.currentTime||0)+(this.offset||0);}
  async control(playing,position=this.current()){
    if(!this.room.host||!this.room.room.playback)return;
    const state=this.room.room.playback,context=this.room.context();state.position=Math.max(0,Math.min(state.duration||Infinity,Number(position)||0));state.playing=playing;state.version++;state.at=performance.now();this.receivedAt=performance.now();this.waiting=false;
    if(this.session?.transcoded&&Math.abs(this.current()-position)>2)await this.load(state);
    if(!this.validContext(context)||this.room.room.playback!==state)return;await this.send('watch.state',state);if(!this.validContext(context))return;this.room.checkpoint();this.follow(true);
  }
  async event(e){
    if(e.type==='reset'){this.loginOperation=(this.loginOperation||0)+1;this.voice.stop();const stopping=this.stopMedia();this.access=null;this.room.mediaAccess=null;this.epoch='';this.error='';this.loading=false;this.waiting=false;this.hostOffset=this.bestRtt=undefined;this.chatSeen?.clear();$('danmaku').replaceChildren();$('emby-dialog').close();$('emby-user').value='';$('emby-password').value='';$('emby-share').checked=false;$('emby-items').replaceChildren();await stopping;return;}
    if(!this.active)return;
    const context=this.room.context();
    this.voice.event(e);
    if(e.type==='voice'){this.voice.receive(e.from,e.bytes);return;}
    if(e.type==='joined'){this.lastHost=performance.now();this.waiting=false;this.hostOffset=this.bestRtt=undefined;if(e.access){this.access=e.access;await nativeCall('mediaConfigure',JSON.stringify({origin:new URL(e.access.base).origin}));if(!this.validContext(context))return;this.epoch='';this.render();}}
    if(e.type==='watch.access'&&e.from===this.room.room.hostId&&e.body?.base&&e.body?.token){if(this.access?.base===e.body.base&&this.access?.token===e.body.token)return;const stopping=this.stopMedia();this.access=e.body;this.loading=false;this.epoch='';await stopping;if(!this.validContext(context))return;this.render();}
    if(e.type==='watch.state'&&e.from===this.room.room.hostId){const s=e.body,old=this.room.room.playback;if(!s?.epoch||!Number.isFinite(s.position)||!Number.isInteger(s.version)||old?.epoch===s.epoch&&s.version<=old.version)return;this.lastHost=performance.now();this.waiting=false;this.room.room.playback=s;this.receivedAt=performance.now();if(this.epoch!==s.epoch)this.load(s);else this.follow();}
    if(e.type==='watch.sync'&&this.room.host){if(this.room.mediaAccess)await this.send('watch.access',this.room.mediaAccess,e.from);if(!this.validContext(context))return;if(this.room.room.playback)await this.send('watch.state',{...this.room.room.playback,position:this.current(),at:performance.now(),version:++this.room.room.playback.version},e.from);}
    if(e.type==='watch.clock'&&this.room.host&&Number.isFinite(e.body.sent))await this.send('watch.clockReply',{sent:e.body.sent,host:performance.now()},e.from);
    if(e.type==='watch.clockReply'&&e.from===this.room.room.hostId&&e.body.sent===this.clockSent){const rtt=performance.now()-e.body.sent;if(rtt>=0&&rtt<2000&&Number.isFinite(e.body.host)&&(this.bestRtt===undefined||rtt<=this.bestRtt*1.5)){this.bestRtt=rtt;this.hostOffset=e.body.host-(e.body.sent+rtt/2);}}
    if(e.type==='watch.chat'&&typeof e.body.text==='string'&&e.body.text.length<=200){this.chat(e.body.id,e.body.text,e.from);}
    if(e.type==='player'){this.position=(Number(e.positionMs)||0)/1000+(this.offset||0);if(e.durationMs>0)this.duration=Number(e.durationMs)/1000+(this.offset||0);this.buffering=!!e.buffering;if(e.error)this.showError('播放器无法读取当前片源');if(e.ended&&this.room.host)this.control(false,this.duration);}
    if(e.type==='background'||e.type==='disconnected'||e.type==='audioFocusLost'){this.voice.mute();if(this.room.host){if(this.room.room.playback)this.control(false);}else this.waiting=true;this.follow(true);}
    if(e.type==='foreground'||e.type==='networkChanged'){this.voice.mute();this.hostOffset=this.bestRtt=undefined;if(!this.room.host)this.send('watch.sync',{},this.room.room.hostId);else if(this.room.room.playback)this.control(false);this.voice.configure();}
  }
  chat(messageId,text,from){
    if(!/^[a-f0-9]{32}$/.test(messageId))return;this.chatRate??=new Map();const now=performance.now();if(now-(this.chatRate.get(from)||-1000)<400)return;this.chatRate.set(from,now);
    this.chatSeen??=new Set();if(this.chatSeen.has(messageId))return;this.chatSeen.add(messageId);if(this.chatSeen.size>128)this.chatSeen.delete(this.chatSeen.values().next().value);
    const name=this.room.room.members.find(p=>p.id===from)?.name||'朋友',span=document.createElement('span');span.textContent=name+'：'+text;span.style.top=(10+(this.chatLane=(this.chatLane||0)+1)%5*15)+'%';while($('danmaku').childElementCount>=30)$('danmaku').firstElementChild.remove();$('danmaku').append(span);setTimeout(()=>span.remove(),8000);
    if(this.nativePlayer)nativeCall('playerCommand',JSON.stringify({danmaku:{id:messageId,text:name+'：'+text}}));
  }
  async sendChat(text){text=text.trim().slice(0,200);if(!text||performance.now()-(this.lastChat||-1000)<500)return;this.lastChat=performance.now();const message={id:id(),text};this.chat(message.id,text,this.room.self);await this.send('watch.chat',message);}
  async pulse(){
    if(!this.active)return;const context=this.room.context();this.voice.configure();this.render();if(!this.room.client.ready)return;
    if(!this.room.host&&performance.now()-(this.lastClock||0)>5000){this.lastClock=this.clockSent=performance.now();this.send('watch.clock',{sent:this.clockSent},this.room.room.hostId);}
    const state=this.room.room.playback;if(!state)return;
    if(this.room.host&&!this.room.background&&this.url&&!this.loading){state.position=this.current();state.version++;state.at=performance.now();this.receivedAt=performance.now();this.send('watch.state',state);}
    else if(!this.room.host&&performance.now()-this.lastHost>5000){this.waiting=true;this.follow();if(performance.now()-this.lastHost>60000){try{await this.room.client.roomSync(this.room.room.roomId);}catch(e){if(this.validContext(context)&&e.code==='ROOM_NOT_FOUND'){this.room.reset();this.room.events.changed?.();}}}}
    if(!this.validContext(context))return;
    if(this.session&&performance.now()-(this.lastCheckin||0)>10000){this.lastCheckin=performance.now();this.checkin('Playing/Progress').catch(()=>{});}
  }
  async checkin(path){if(!this.session||!this.access)return;const s=this.session;await mediaRequest(this.endpoint('Sessions/'+path),'POST',this.headers(),{ItemId:s.itemId,MediaSourceId:s.sourceId,PlaySessionId:s.id,PositionTicks:Math.round(this.current()*tick),IsPaused:!this.room.room?.playback?.playing,CanSeek:true,PlayMethod:s.transcoded?'Transcode':'DirectPlay'});}
  async stopMedia(invalidate=true){
    if(invalidate)++this.generation;const session=this.session,position=this.current(),access=this.access,headers=this.headers(access);
    this.session=null;this.url='';this.buffering=false;this.hls?.destroy();this.hls=null;this.video.pause();this.video.removeAttribute('src');this.video.load();
    if(this.stopping&&!session)return this.stopping;
    const previous=this.stopping,stopping=(async()=>{
      if(previous)await previous;
      // Android playerStop cancels pending media calls. Send terminal reports
      // afterwards, and let the next load wait before it changes the origin.
      if(this.nativePlayer)await nativeCall('playerStop');
      if(session&&access){const reports=[mediaRequest(this.endpoint('Sessions/Playing/Stopped',{},access),'POST',headers,{ItemId:session.itemId,MediaSourceId:session.sourceId,PlaySessionId:session.id,PositionTicks:Math.round(position*tick)},2000)];if(session.liveStreamId)reports.push(mediaRequest(this.endpoint('LiveStreams/Close',{},access),'POST',headers,{LiveStreamId:session.liveStreamId},2000));await Promise.allSettled(reports);}
    })();
    this.stopping=stopping;try{await stopping;}finally{if(this.stopping===stopping)this.stopping=null;}
  }
  rectangle(){const r=$('watch-stage').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}
  bounds(){if(this.active&&this.nativePlayer&&this.url)nativeCall('playerCommand',JSON.stringify({visible:!document.querySelector('dialog[open]')&&!this.room.background,bounds:this.rectangle()}));}
  showError(message){this.error=message;this.render();}
  render(){
    const r=this.room.room;if(r?.game!=='watch')return;
    if(!r.playback&&this.url)this.stopMedia().catch(()=>{});
    $('watch-name').textContent=r.name;$('watch-title').textContent=r.playback?.title||'挑一部电影，朋友随时入座';$('watch-count').textContent=r.members.length+'/6 人';
    $('watch-source').hidden=!this.room.host;$('watch-play').hidden=!this.room.host;$('watch-seek').disabled=!this.room.host||!r.playback;
    $('watch-play').textContent=r.playback?.playing?'暂停':'播放';$('watch-play').disabled=!r.playback||this.loading||!this.url;
    $('watch-seek').max=String(r.playback?.duration||this.duration||1);if(document.activeElement!==$('watch-seek'))$('watch-seek').value=String(this.current());
    const seconds=Math.floor(this.current());$('watch-time').textContent=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
    $('watch-message').textContent=this.error||(!this.access&&r.playback?'等待房主提供片源授权':this.waiting?'房主暂时不可用，暂停等待恢复':this.loading?'正在连接片源…':this.autoplay?'点击「加入观影」开启声音':this.buffering?'正在缓冲，仅影响当前设备':'只有房主控制电影，弹幕实时展示');
    $('watch-mic').textContent=this.voice.microphone?'关闭麦克风':'开启麦克风';$('watch-mic').classList.toggle('recording',this.voice.microphone);$('voice-status').textContent=this.voice.status;
    $('watch-members').replaceChildren(...r.members.map(p=>{const b=document.createElement('button');b.className='secondary';b.textContent=p.name+(p.id===r.hostId?' · 房主':'');b.disabled=!this.room.host||p.id===this.room.self;b.onclick=()=>this.room.events.kick?.(p);return b;}));
    if(r.playback&&this.access&&this.epoch!==r.playback.epoch&&!this.loading){this.receivedAt=performance.now();this.load(r.playback);}
    this.video.hidden=this.nativePlayer;this.bounds();
  }
}
