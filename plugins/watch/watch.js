import {asset,id,native,nativeCall,storageSet,base64,bootstrap} from '../../plugin_sdk/transport.js';
import {RoomVoice} from './voice.js';
import {parseVtt} from './subtitles.js';
import {cleanWatchSave,readWatchSave,writeWatchSave} from './watch-save.js';
const $=name=>document.getElementById(name),tick=10000000;
export const PLAYBACK_RATES=[.5,.75,1,1.25,1.5,2],QUALITIES={auto:{label:'自动',bitrate:12000000},1080:{label:'1080p',height:1080,bitrate:8000000},720:{label:'720p',height:720,bitrate:4000000},480:{label:'480p',height:480,bitrate:1600000}};
const playbackRate=state=>PLAYBACK_RATES.includes(Number(state?.rate))?Number(state.rate):1;
export const desktopPlayback=()=>!!native?.playerCommand&&native.platform==='WINDOWS'&&native.playerCapabilities?.engine==='mpv';
const desktopCodecs={video:'h264,avc,hevc,h265,mpeg2video,mpeg4,vp8,vp9,av1',audio:'aac,mp3,ac3,eac3,dts,dca,truehd,flac,opus,vorbis,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le',container:'mp4,m4v,mkv,matroska,ts,mpegts,mov,avi,webm,mpeg'};
export function browserSourceError(base){return !native&&(bootstrap.hostProtocol||globalThis.location?.protocol)==='https:'&&new URL(base).protocol==='http:'?'此 HTTPS 网页不能读取 HTTP 片源。请使用 Windows 客户端，或由房主填写可用的「网页 HTTPS 入口」。':'';}
export function directCompatible(source,desktop=desktopPlayback()){const streams=source.MediaStreams||[],video=streams.find(s=>s.Type==='Video'),audios=streams.filter(s=>s.Type==='Audio'),audio=audios.find(s=>s.Index===source.DefaultAudioStreamIndex)||audios[0],allows=(list,value)=>list.split(',').includes(String(value||'').toLowerCase());return !!source.SupportsDirectPlay&&(!video||allows(desktop?desktopCodecs.video:'h264,avc',video.Codec))&&(!audio||allows(desktop?desktopCodecs.audio:'aac,mp3',audio.Codec))&&(!source.Container||allows(desktop?desktopCodecs.container:'mp4,m4v,mkv,matroska',source.Container));}
export function playbackRequest(quality='auto',compatibility=false,desktop=desktopPlayback()){const q=QUALITIES[quality]||QUALITIES.auto,force=quality!=='auto'||compatibility;return {MaxStreamingBitrate:q.bitrate,MaxAudioChannels:desktop&&!force?8:2,EnableDirectPlay:!force,EnableDirectStream:false,EnableTranscoding:true,AllowAudioStreamCopy:false,AllowVideoStreamCopy:!force,DeviceProfile:{Name:'CyberRoom',MaxStreamingBitrate:q.bitrate,DirectPlayProfiles:force?[]:[{Container:desktop?desktopCodecs.container:'mp4,m4v,mkv',Type:'Video',VideoCodec:desktop?desktopCodecs.video:'h264',AudioCodec:desktop?desktopCodecs.audio:'aac,mp3'}],TranscodingProfiles:[{Container:'ts',Type:'Video',VideoCodec:'h264',AudioCodec:'aac',Protocol:'hls',Context:'Streaming',MaxAudioChannels:'2',MinSegments:2,SegmentLength:3,...(q.height?{MaxHeight:q.height,MaxWidth:Math.round(q.height*16/9)}:{})}],CodecProfiles:desktop?[]:[{Type:'VideoAudio',Codec:'aac,mp3',Conditions:[{Condition:'LessThanEqual',Property:'AudioChannels',Value:'2',IsRequired:true}]}],SubtitleProfiles:[{Format:'vtt',Method:'External'}]}};}
const pending=new Map(),imageRequests=new Set();
function cancelImages(){for(const controller of imageRequests)controller.abort();for(const [key,p] of pending)if(p.responseType==='image'){pending.delete(key);clearTimeout(p.timer);p.reject(Object.assign(Error('海报请求已取消'),{code:'STALE_OPERATION'}));}}
globalThis.addEventListener?.('native-room',e=>{if(e.detail.type!=='mediaResponse')return;const p=pending.get(e.detail.id);if(!p)return;pending.delete(e.detail.id);clearTimeout(p.timer);e.detail.error?p.reject(Error(e.detail.error)):p.resolve(e.detail);});
export async function mediaRequest(url,method='GET',headers={},body,timeoutMs=20000,responseType='json'){
  const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw Error('片源地址无效');
  const blocked=browserSourceError(url);if(blocked)throw Error(blocked);
  let status,text,dataUrl;
  if(native?.mediaRequest){const requestId=id(),response=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('片源请求超时'));},timeoutMs);pending.set(requestId,{resolve,reject,timer,responseType});nativeCall('mediaRequest',JSON.stringify({id:requestId,url,method,headers,responseType,timeoutMs,...(body===undefined?{}:{body:JSON.stringify(body)})})).catch(e=>{pending.delete(requestId);clearTimeout(timer);reject(e);});});status=response.status;text=response.body||'';dataUrl=response.dataUrl;}
  else{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);if(responseType==='image')imageRequests.add(controller);try{const response=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,credentials:'omit',redirect:'error'});status=response.status;if(responseType==='image'&&response.ok){const mime=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();if(!/^image\/(jpeg|png|webp|gif)$/.test(mime))throw Error('不支持的海报格式');const reader=response.body.getReader(),chunks=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2097152){await reader.cancel();throw Error('海报过大');}chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}dataUrl='data:'+mime+';base64,'+base64(bytes);}else{const reader=response.body?.getReader(),chunks=[];let size=0;if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2097152)throw Error('片源响应过大');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}text=new TextDecoder().decode(bytes);}}finally{clearTimeout(timer);imageRequests.delete(controller);}}
  if(status<200||status>=300)throw Error(status===401?'Emby 授权已失效，请房主重新登录':status===403?'Emby 账号拒绝此次请求，请检查片源账号的播放权限和并发限制':'Emby 请求失败（'+status+'）');
  if(responseType==='image'){if(!/^data:image\/(jpeg|png|webp|gif);base64,/.test(dataUrl||''))throw Error('海报暂时不可用');return dataUrl;}
  return responseType==='text'?text:text?JSON.parse(text):{};
}
const numberIndex=value=>Number.isInteger(value)&&value>=0?value:Number.MAX_SAFE_INTEGER;
export function episodeLabel(item){const season=numberIndex(item.ParentIndexNumber),episode=numberIndex(item.IndexNumber);return (season===0?'特别篇':season<Number.MAX_SAFE_INTEGER?'第 '+season+' 季':'季数未知')+' · '+(episode<Number.MAX_SAFE_INTEGER?'第 '+episode+(item.IndexNumberEnd>episode?'–'+item.IndexNumberEnd:'')+' 集':'集数未知');}
export function episodeCode(item){return 'S'+(Number.isInteger(item.ParentIndexNumber)?String(item.ParentIndexNumber).padStart(2,'0'):'?')+'E'+(Number.isInteger(item.IndexNumber)?String(item.IndexNumber).padStart(2,'0'):'?');}
export function itemTitle(item){return item.Type==='Episode'?[item.SeriesName,episodeCode(item),item.Name].filter(Boolean).join(' · '):item.Name||'未命名影片';}
export function sortEpisodes(items){return items.sort((a,b)=>numberIndex(a.ParentIndexNumber)-numberIndex(b.ParentIndexNumber)||numberIndex(a.IndexNumber)-numberIndex(b.IndexNumber)||String(a.Name||'').localeCompare(String(b.Name||''),'zh-CN',{numeric:true}));}
export class WatchRoom {
  constructor(room,notice){
    this.room=room;this.notice=notice;this.video=$('watch-video');this.voice=new RoomVoice(room,()=>this.render());this.epoch='';this.lastHost=performance.now();this.version=-1;this.generation=0;this.position=0;this.duration=0;this.micReady=false;this.quality='auto';this.volume=1;this.muted=false;this.subtitleIndex=-1;this.tracks=[];
    this.remember=true;this.savedReady=readWatchSave().then(value=>{this.saved=value;}).catch(()=>{this.saveError='本机观影存档无法读取，请重新连接片源';});
    this.video.addEventListener('loadedmetadata',()=>{if(!this.session?.transcoded||!this.duration)this.updateDuration(this.video.duration+(this.offset||0));this.follow(true);});this.video.addEventListener('ended',()=>this.finishPlayback());
    this.video.addEventListener('error',()=>{
      const code=this.video.error?.code;if(!this.url||code===1)return; // Changing/stopping a source is not a decoder failure.
      const codecFailure=code===3||code===4;
      this.mediaFailure(code===2?'视频网络连接中断，请检查网络后重试；将保持当前播放方式':codecFailure?'视频无法解码或格式不支持，请重试兼容转码或选择兼容影片':'视频播放失败，请重试；将保持当前播放方式',codecFailure);
    });
    const playable=()=>{if(this.video.readyState>=2&&!this.video.seeking){this.confirmSeek(this.video.currentTime+(this.offset||0));this.buffering=false;this.render();}};
    for(const event of ['playing','canplay','seeked'])this.video.addEventListener(event,playable);
    this.video.addEventListener('waiting',()=>{this.buffering=true;this.render();});
    this.timer=setInterval(()=>this.pulse(),1000);this.resize=new ResizeObserver(()=>this.bounds());this.resize.observe($('watch-stage'));this.resize.observe($('watch-screen'));
    this.subtitleTimer=setInterval(()=>this.paintSubtitle(),100);
    window.addEventListener('scroll',()=>this.bounds(),{passive:true});
    new MutationObserver(()=>this.bounds()).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
    // Listening is a room action, independent of starting a film or opening the mic.
    // A later gesture also recovers an AudioContext suspended by the browser.
    for(const event of ['pointerdown','keydown'])document.addEventListener(event,()=>{if(this.active&&!native&&this.voice.context?.state!=='running')this.voice.listen().catch(e=>{this.voice.status=e.message;this.render();});},{capture:true});
  }
  get active(){return this.room.room?.game==='watch';}
  get nativePlayer(){return !!native?.playerCommand;}
  get nativeTracks(){return desktopPlayback()&&native.playerCapabilities.embeddedTracks===true;}
  get directTracks(){return this.nativeTracks&&!!this.session&&!this.session.transcoded;}
  mediaTracks(){return this.tracks.map(({Index,Type,Codec,Language,DisplayTitle,IsExternal})=>({Index,Type,Codec,Language,DisplayTitle,IsExternal:!!IsExternal}));}
  embeddedSubtitle(stream){return this.directTracks&&stream&&!stream.IsExternal;}
  endpoint(path,query={},access=this.access){const url=new URL(access.base.replace(/\/$/,'')+'/'+path.replace(/^\//,''));for(const [k,v] of Object.entries(query))if(v!==undefined&&v!==null)url.searchParams.set(k,String(v));return url.toString();}
  headers(access=this.access,deviceId=this.room.self){return {'Content-Type':'application/json','X-Emby-Token':access?.token||'','X-Emby-Authorization':`MediaBrowser Client="CyberRoom", Device="${native?'Native':'Web'}", DeviceId="${deviceId}", Version="0.8.4"`};}
  validContext(context,generation){return this.active&&this.room.current(context)&&(generation===undefined||generation===this.generation);}
  scheduleHostSave(){clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>this.saveHost(),300);}
  saveHost(){
    clearTimeout(this.saveTimer);
    if(!this.active||!this.room.host||!this.remember||!this.ownedSource||this.restoring)return Promise.resolve();
    const state=this.room.room.playback,same=this.epoch===state?.epoch;
    const position=state?(same&&this.url&&!this.loading&&(this.nativePlayer||this.video.readyState>=1)?this.current():state.position):0;
    const saved=cleanWatchSave({version:1,savedAt:Date.now(),source:this.ownedSource,settings:{quality:this.quality,volume:this.volume,muted:this.muted},playback:state?{...state,position,...(same?{audioIndex:this.audioIndex,audioExplicit:this.audioExplicit,subtitleIndex:this.subtitleIndex,burnSubtitle:this.burnSubtitle,compatibility:this.compatibility}:this.restoreTracks||{})}:null});
    if(!saved)return Promise.resolve();this.saved=saved;this.lastHostSave=performance.now();
    return writeWatchSave(saved).then(()=>{this.saveError='';}).catch(()=>{if(!this.saveError)this.notice?.('观影存档失败，请检查本机存储空间');this.saveError='观影存档失败';});
  }
  async forgetSaved(){
    this.loginOperation=(this.loginOperation||0)+1;this.remember=false;this.ownedSource=null;this.saved=null;this.restoreTracks=null;this.restoring=false;
    await this.savedReady;this.saved=null;await writeWatchSave(null);storageSet('cyber.emby.base',null);this.saveError='';this.notice?.('已删除本机片源与观看记录，当前房间可以继续观看');
  }
  async restoreHost(){
    if(!this.active||!this.room.host||this.access||this.restoring)return;
    const context=this.room.context(),operation=this.loginOperation=(this.loginOperation||0)+1;this.restoring=operation;
    const valid=()=>this.validContext(context)&&operation===this.loginOperation&&this.room.host;
    try{
      await this.savedReady;if(!valid())return;const saved=this.saved;
      if(!saved){if(this.saveError)this.notice?.(this.saveError);return;}
      const access=this.clientAccess(saved.source);await nativeCall('mediaConfigure',JSON.stringify({origin:new URL(access.base).origin}));if(!valid())return;
      const user=await mediaRequest(this.endpoint('Users/'+encodeURIComponent(access.userId),{},access),'GET',this.headers(access));if(!valid())return;
      if(user.Id!==access.userId||user.Policy?.IsAdministrator)throw Error('已保存的片源授权需要重新登录');
      this.access=access;this.room.mediaAccess={...saved.source};this.ownedSource={...saved.source};this.remember=true;
      Object.assign(this,saved.settings);this.video.volume=this.volume;this.video.muted=this.muted;
      // An existing room keeps its selected film. A new room gets a fresh epoch.
      const old=this.room.room.playback,record=saved.playback;
      if(!old&&record){this.room.room.playback={epoch:id(),itemId:record.itemId,title:record.title,duration:record.duration,position:record.position,rate:record.rate,playing:false,version:0,at:performance.now()};}
      else if(old&&!this.url){old.position=record?.itemId===old.itemId?record.position:old.position;old.playing=false;old.at=performance.now();old.version++;}
      const state=this.room.room.playback;
      if(record?.itemId===state?.itemId)this.restoreTracks={audioIndex:record.audioIndex??undefined,audioExplicit:record.audioExplicit,subtitleIndex:record.subtitleIndex,burnSubtitle:record.burnSubtitle,compatibility:record.compatibility};
      await this.send('watch.access',this.room.mediaAccess);if(!valid())return;
      if(state)this.loading=true;this.room.publish();this.room.checkpoint();
      if(state){await this.load(state);if(!valid())return;this.notice?.(this.error?'已恢复存档；片源暂时无法播放，可重试或重新选片':'已恢复上次片源和进度，点击播放继续');}
      else this.notice?.('已恢复上次片源，可以直接选片');
      this.render();
    }catch(e){if(valid())this.showError('恢复片源失败：'+e.message+'。观看记录仍保留，可在片源设置重新连接。');}
    finally{if(this.restoring===operation)this.restoring=false;}
  }
  clientAccess(access){return {...access,base:!native&&access.webBase?access.webBase:access.base};}
  requestSync(){if(!this.active||this.room.host||!this.room.client.ready||performance.now()-(this.lastSync??-5000)<5000)return;this.lastSync=performance.now();this.send('watch.sync',{},this.room.room.hostId).catch(()=>{});}
  unlockMedia(){if(this.nativePlayer)return;this.video.volume=this.volume;this.video.muted=this.muted;if(this.url)this.video.play().then(()=>{if(!this.room.room?.playback?.playing)this.video.pause();this.autoplay=false;this.render();}).catch(()=>{this.autoplay=true;this.render();});}
  setVolume(value){this.volume=Math.max(0,Math.min(1,Number(value)||0));this.video.volume=this.volume;if(this.nativePlayer)nativeCall('playerCommand',JSON.stringify({volume:this.volume,muted:this.muted}));this.render();}
  setMuted(value){this.muted=!!value;this.video.muted=this.muted;if(this.nativePlayer)nativeCall('playerCommand',JSON.stringify({volume:this.volume,muted:this.muted}));this.render();this.saveHost();}
  async reload(automatic=false){const state=this.room.room?.playback;if(!state)return;if(!this.access){this.requestSync();return;}if(!automatic){this.failedEpoch='';this.fallbackEpoch='';}if(this.room.host&&this.url&&!this.loading&&!this.error){state.position=this.current();state.at=performance.now();}await this.load(state);}
  async setQuality(value){if(!QUALITIES[value])return;this.quality=value;this.compatibility=false;if(value==='auto'&&this.nativeTracks&&!this.tracks.find(s=>s.Type==='Subtitle'&&s.Index===this.subtitleIndex)?.IsExternal)this.burnSubtitle=false;await this.reload();await this.saveHost();}
  async setAudio(value){const index=Number(value);if(!this.tracks.some(s=>s.Type==='Audio'&&s.Index===index))return;const previous=this.audioIndex;this.audioIndex=index;this.audioExplicit=true;if(this.directTracks){try{await nativeCall('playerCommand',JSON.stringify({audioStreamIndex:index,mediaTracks:this.mediaTracks()}));}catch(e){this.audioIndex=previous;throw e;}finally{this.render();}await this.saveHost();return;}this.compatibility=true;await this.reload();await this.saveHost();}
  async setSubtitle(value){const index=Number(value),stream=this.tracks.find(s=>s.Type==='Subtitle'&&s.Index===index);if(index!==-1&&!stream)return;const wasBurned=this.burnSubtitle;this.subtitleIndex=index;this.burnSubtitle=!!stream&&!this.textSubtitle(stream)&&!this.embeddedSubtitle(stream);this.subtitleError='';this.clearSubtitles();if(wasBurned||this.burnSubtitle)await this.reload();else await this.loadSubtitles();this.render();await this.saveHost();}
  textSubtitle(stream){return stream.IsTextSubtitleStream===true||/^(subrip|srt|vtt|webvtt|ass|ssa|mov_text|text)$/i.test(stream.Codec||'');}
  clearSubtitles(){const hadCues=this.subtitleCues?.length;this.subtitleLoading=false;this.subtitleGeneration=(this.subtitleGeneration||0)+1;this.subtitleCues=[];const overlay=globalThis.document?.getElementById('watch-subtitle');if(overlay)overlay.textContent='';if(this.nativePlayer&&hadCues)nativeCall('playerCommand',JSON.stringify({subtitleCues:[],subtitleOffsetMs:0}));}
  async loadSubtitles(){this.subtitleError='';this.clearSubtitles();const stream=this.tracks.find(s=>s.Type==='Subtitle'&&s.Index===this.subtitleIndex);if(this.directTracks){await nativeCall('playerCommand',JSON.stringify({subtitleStreamIndex:this.embeddedSubtitle(stream)?stream.Index:-1,mediaTracks:this.mediaTracks()}));if(!stream||this.embeddedSubtitle(stream))return;}if(!this.session||!stream||this.burnSubtitle)return;const context=this.room.context(),generation=this.generation,operation=this.subtitleGeneration,session=this.session,access=this.access;this.subtitleLoading=true;try{const text=await mediaRequest(this.endpoint('Videos/'+encodeURIComponent(session.itemId)+'/'+encodeURIComponent(session.sourceId)+'/Subtitles/'+stream.Index+'/Stream.vtt',{StartPositionTicks:0},access),'GET',this.headers(access),undefined,60000,'text');if(!this.validContext(context,generation)||operation!==this.subtitleGeneration)return;this.subtitleCues=parseVtt(text);if(!this.subtitleCues.length)throw Error('此字幕没有可显示的文本');if(this.nativePlayer)await nativeCall('playerCommand',JSON.stringify({subtitleCues:this.subtitleCues,subtitleOffsetMs:(this.offset||0)*1000}));this.paintSubtitle();}catch(e){if(this.validContext(context,generation)&&operation===this.subtitleGeneration)this.subtitleError='字幕加载失败，请重选字幕或关闭字幕';}if(operation===this.subtitleGeneration)this.subtitleLoading=false;this.render();}
  paintSubtitle(){if(!this.active||this.nativePlayer||!this.subtitleCues?.length)return;const now=this.current(),text=this.subtitleCues.filter(c=>now>=c.start&&now<c.end).map(c=>c.text).join('\n');if($('watch-subtitle').textContent!==text)$('watch-subtitle').textContent=text;}
  mediaFailure(message,codecFailure=false){if(!this.active||this.loading||!this.url||this.failedEpoch===this.epoch)return;if(codecFailure&&!desktopPlayback()&&!this.session?.transcoded&&!this.compatibility&&this.fallbackEpoch!==this.epoch){this.fallbackEpoch=this.epoch;this.compatibility=true;this.reload(true).catch(()=>{});return;}this.failPlayback(message);}
  failPlayback(message){this.failedEpoch=this.room.room?.playback?.epoch||this.epoch;this.hls?.stopLoad();this.video.pause?.();if(this.nativePlayer)nativeCall('playerCommand',JSON.stringify({playing:false}));this.showError(message);}
  async login(base,username,password,share,webBase='',remember=true){
    if(!this.active||!this.room.host)throw Error('只有房主可以配置片源');if(!share)throw Error('请确认将专用账号的播放权限共享给房间成员');
    this.room.client.requireCompatible();
    const context=this.room.context(),operation=this.loginOperation=(this.loginOperation||0)+1;this.restoring=false;
    const validate=()=>{this.room.assertCurrent(context);if(operation!==this.loginOperation||!this.active||!this.room.host)throw Object.assign(Error('片源操作已取消，请重新连接'),{code:'STALE_OPERATION'});};
    await this.saveHost();validate();await this.savedReady;validate();
    const url=new URL(base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('请输入有效的 Emby 服务地址');
    const access={base:url.href.replace(/\/$/,''),token:'',userId:''};
    await this.stopMedia();validate();this.room.room.playback=null;this.room.mediaAccess=null;this.access=null;this.ownedSource=null;this.loading=false;this.room.publish();await nativeCall('mediaConfigure',JSON.stringify({origin:url.origin}));validate();
    const auth=await mediaRequest(this.endpoint('Users/AuthenticateByName',{},access),'POST',this.headers(access),{Username:username,Pw:password});validate();
    if(!auth.AccessToken||!auth.User?.Id)throw Error('Emby 登录返回无效');
    if(auth.User.Policy?.IsAdministrator)throw Error('请使用非管理员观影账号，避免向房间共享管理权限');
    if(webBase.trim()){
      const web=new URL(webBase.trim());if(web.protocol!=='https:'||web.username||web.password||web.search||web.hash)throw Error('网页入口必须是有效的 HTTPS 地址');
      const publicId=auth.ServerId||(await mediaRequest(this.endpoint('System/Info/Public',{},access))).Id;validate();
      try{await nativeCall('mediaConfigure',JSON.stringify({origin:web.origin}));validate();const info=await mediaRequest(web.href.replace(/\/$/,'')+'/System/Info/Public');validate();if(!publicId||!info.Id||String(publicId).toLowerCase()!==String(info.Id).toLowerCase())throw Error('两个入口的 Emby 服务器标识不同，未向网页入口发送账号授权');access.webBase=web.href.replace(/\/$/,'');}
      finally{if(this.validContext(context)&&operation===this.loginOperation)await nativeCall('mediaConfigure',JSON.stringify({origin:url.origin}));}
    }
    validate();
    access.token=auth.AccessToken;access.userId=auth.User.Id;access.canTranscode=['EnableMediaPlayback','EnableAudioPlaybackTranscoding','EnableVideoPlaybackTranscoding'].every(key=>auth.User.Policy?.[key]===true);this.access=this.clientAccess(access);this.room.mediaAccess={...access};storageSet('cyber.emby.base',access.base);
    this.remember=remember;this.ownedSource={...access,username,serverId:auth.ServerId||''};
    const previous=this.saved;if(previous?.source.base===access.base&&previous.source.userId===access.userId&&previous.playback){const p=previous.playback;Object.assign(this,previous.settings);this.room.room.playback={epoch:id(),itemId:p.itemId,title:p.title,duration:p.duration,position:p.position,rate:p.rate,playing:false,version:0,at:performance.now()};this.restoreTracks={audioIndex:p.audioIndex??undefined,audioExplicit:p.audioExplicit,subtitleIndex:p.subtitleIndex,burnSubtitle:p.burnSubtitle,compatibility:p.compatibility};}
    if(!remember){this.saved=null;await writeWatchSave(null);validate();}else await this.saveHost();
    await this.send('watch.access',this.room.mediaAccess);validate();this.room.publish();this.render();
  }
  async catalog(path,query={},responseType='json'){
    if(!this.active||!this.room.host)throw Error('只有房主可以选择片源');if(!this.access?.token)throw Error('先连接 Emby 片源');
    const context=this.room.context(),access=this.access,result=await mediaRequest(this.endpoint(path,query,access),'GET',this.headers(access),undefined,20000,responseType);this.room.assertCurrent(context);if(this.access!==access)throw Object.assign(Error('片源已变化，请重新打开片库'),{code:'STALE_OPERATION'});return result;
  }
  async search(term,type='Movie',start=0){return this.catalog('Users/'+encodeURIComponent(this.access?.userId||'')+'/Items',{Recursive:true,IncludeItemTypes:type,SearchTerm:term||undefined,StartIndex:start,Limit:48,Fields:'Overview,Genres,RunTimeTicks,PrimaryImageAspectRatio',EnableImages:true,ImageTypeLimit:1,SortBy:'SortName',SortOrder:'Ascending'});}
  async detail(item){return this.catalog('Users/'+encodeURIComponent(this.access?.userId||'')+'/Items/'+encodeURIComponent(item.Id),{Fields:'Overview,Genres,RunTimeTicks'});}
  async children(series,season,current=()=>true){
    const path='Shows/'+encodeURIComponent(series.Id)+(season?'/Episodes':'/Seasons'),items=[],seen=new Set(),context=this.room.context(),access=this.access;
    // Gather one show's seasons / one season's episodes in bounded HTTP pages,
    // then sort numerically across the entire result, even if a server ignores SortBy.
    for(let start=0;;){if(!current())throw Object.assign(Error('片库操作已取消'),{code:'STALE_OPERATION'});const result=await this.catalog(path,{UserId:access?.userId,SeasonId:season?.Id,StartIndex:start,Limit:100,Fields:'Overview,Genres,RunTimeTicks',EnableImages:true,ImageTypeLimit:1,SortBy:season?'ParentIndexNumber,IndexNumber':'IndexNumber',SortOrder:'Ascending'});this.room.assertCurrent(context);if(this.access!==access)throw Error('片源已变化');const page=result.Items||[];if(!page.length)break;for(const item of page){if(seen.has(item.Id))throw Error('片源返回了重复分页，请重新打开');seen.add(item.Id);items.push(item);}start+=page.length;if(Number.isFinite(result.TotalRecordCount)?start>=result.TotalRecordCount:page.length<100)break;}
    return season?sortEpisodes(items.map(item=>({...item,ParentIndexNumber:Number.isInteger(item.ParentIndexNumber)?item.ParentIndexNumber:season.IndexNumber,SeriesName:item.SeriesName||series.Name,SeriesId:item.SeriesId||series.Id}))):items.sort((a,b)=>numberIndex(a.IndexNumber)-numberIndex(b.IndexNumber)||String(a.Name||'').localeCompare(String(b.Name||''),'zh-CN',{numeric:true}));
  }
  async image(item){let itemId=item.Id,tag=item.ImageTags?.Primary;if(!tag&&item.PrimaryImageTag){tag=item.PrimaryImageTag;itemId=item.PrimaryImageItemId||item.Id;}if(!tag&&item.SeriesPrimaryImageTag&&item.SeriesId){itemId=item.SeriesId;tag=item.SeriesPrimaryImageTag;}if(!tag)return null;return this.catalog('Items/'+encodeURIComponent(itemId)+'/Images/Primary',{MaxWidth:480,Quality:85,Format:'jpg',Tag:tag},'image');}
  async select(item){if(!this.active||!this.room.host)throw Error('只有房主可以选择片源');if(!['Movie','Episode'].includes(item.Type))throw Error('请先选择一部电影或一集节目');const context=this.room.context();await this.saveHost();this.room.assertCurrent(context);this.compatibility=false;this.restoreTracks=null;this.room.room.playback={epoch:id(),itemId:item.Id,title:itemTitle(item),duration:Number(item.RunTimeTicks||0)/tick,position:0,playing:false,rate:playbackRate(this.room.room.playback),version:0,at:performance.now()};this.loading=true;this.room.publish();this.room.checkpoint();await this.saveHost();this.room.assertCurrent(context);await this.load(this.room.room.playback);this.room.assertCurrent(context);await this.saveHost();this.render();}
  async send(type,body,to){if(!this.active)return;return to?this.room.client.sendTo(this.room.room.roomId,to,{type},body,'relay'):this.room.client.broadcast(this.room.room.roomId,undefined,{type},body);}
  async load(state){
    if(!state?.itemId||!this.access?.token||this.room.background||this.failedEpoch===state.epoch)return;
    const generation=++this.generation,context=this.room.context(),access=this.access,deviceId=this.room.self,loading=this.loadingRequest={generation,epoch:state.epoch,seeked:false};let openedSession,start=state.position;this.loading=true;this.error='';
    try{
      const changed=this.epoch!==state.epoch;await this.stopMedia(false);if(!this.validContext(context,generation))return;if(changed){this.audioIndex=undefined;this.audioExplicit=false;this.subtitleIndex=-1;this.burnSubtitle=false;this.compatibility=false;this.tracks=[];if(this.restoreTracks){Object.assign(this,this.restoreTracks);this.restoreTracks=null;}}this.epoch=state.epoch;this.version=state.version;this.position=state.position;this.duration=state.duration||0;
      await nativeCall('mediaConfigure',JSON.stringify({origin:new URL(access.base).origin}));if(!this.validContext(context,generation))return;
      // Coalesce changes received while the previous session was stopping. Once
      // HTTP starts, only a real timeline discontinuity invalidates an HLS start.
      if(this.room.room.playback?.epoch===state.epoch)state={...this.room.room.playback};loading.seeked=false;start=this.target(state);
      const force=(this.quality||'auto')!=='auto'||this.compatibility||this.burnSubtitle||this.audioExplicit&&!this.nativeTracks,request={UserId:access.userId,StartTimeTicks:Math.round(start*tick),IsPlayback:true,AutoOpenLiveStream:true,AudioStreamIndex:this.audioIndex,SubtitleStreamIndex:this.burnSubtitle?this.subtitleIndex:-1,...playbackRequest(this.quality,force)};if(this.burnSubtitle)request.DeviceProfile.SubtitleProfiles=[{Format:'pgssub',Method:'Encode'},{Format:'dvdsub',Method:'Encode'},{Format:'dvbsub',Method:'Encode'}];
      const info=await mediaRequest(this.endpoint('Items/'+encodeURIComponent(state.itemId)+'/PlaybackInfo',{UserId:access.userId,DeviceId:deviceId},access),'POST',this.headers(access,deviceId),request,60000);
      const sources=info.MediaSources||[],source=(!force&&sources.find(s=>directCompatible(s)))||sources.find(s=>s.TranscodingUrl)||(access.canTranscode===true&&info.PlaySessionId?sources.find(s=>s.Id):null);
      openedSession={itemId:state.itemId,id:info.PlaySessionId,sourceId:source?.Id,liveStreamId:source?.LiveStreamId,transcoded:!!source?.TranscodingUrl||force,deviceId};
      if(!this.validContext(context,generation)){await this.endSession(openedSession,access,start);openedSession=null;return;}
      this.tracks=(source||sources[0])?.MediaStreams||[];if(!source||info.ErrorCode)throw Error(this.burnSubtitle?'Emby 未提供图片字幕烧录，请检查视频转码权限，或关闭此字幕':force?'Emby 未提供所选画质或音轨的兼容转码；请改用自动画质、兼容音轨，或检查片源转码服务':'此影片无法直接播放，Emby 未提供 H.264 / AAC 兼容转码；请换兼容音轨或影片，或检查片源转码服务');
      if(!this.tracks.some(s=>s.Type==='Audio'&&s.Index===this.audioIndex))this.audioIndex=undefined;
      this.audioIndex=Number.isInteger(source.DefaultAudioStreamIndex)&&this.audioIndex===undefined?source.DefaultAudioStreamIndex:this.audioIndex??this.tracks.find(s=>s.Type==='Audio')?.Index;
      if(!this.tracks.some(s=>s.Type==='Subtitle'&&s.Index===this.subtitleIndex)){this.subtitleIndex=-1;this.burnSubtitle=false;}
      const container=source.Container==='matroska'?'mkv':source.Container==='mpegts'?'ts':source.Container||'mp4',original=this.endpoint('Videos/'+encodeURIComponent(state.itemId)+'/stream.'+container,{Static:true,MediaSourceId:source.Id,PlaySessionId:info.PlaySessionId},access);
      let stream=!force&&directCompatible(source)?this.nativeTracks?original:source.DirectStreamUrl:null,transcoded=false;
      if(!stream&&source.TranscodingUrl){stream=source.TranscodingUrl;transcoded=true;}
      if(!stream&&!force&&directCompatible(source))stream=original;
      // Some Emby gateways omit TranscodingUrl despite explicitly permitted
      // playback/transcoding. Use the documented HLS endpoint for that case.
      if(!stream&&access.canTranscode===true&&info.PlaySessionId){const q=QUALITIES[this.quality]||QUALITIES.auto;stream=this.endpoint('Videos/'+encodeURIComponent(state.itemId)+'/master.m3u8',{MediaSourceId:source.Id,DeviceId:this.room.self,PlaySessionId:info.PlaySessionId,Container:'ts',AudioCodec:'aac',AudioBitRate:128000,AudioChannels:2,MaxAudioChannels:2,AudioSampleRate:48000,VideoCodec:'h264',VideoBitRate:q.bitrate-128000,MaxWidth:q.height?Math.round(q.height*16/9):undefined,MaxHeight:q.height,AudioStreamIndex:this.audioIndex,SubtitleStreamIndex:this.burnSubtitle?this.subtitleIndex:-1,SubtitleMethod:this.burnSubtitle?'Encode':undefined,Static:false,EnableAutoStreamCopy:false,AllowAudioStreamCopy:false,AllowVideoStreamCopy:false,StartTimeTicks:Math.round(start*tick)},access);transcoded=true;}
      if(!stream)throw Error('片源格式不兼容，且 Emby 未提供可用转码');
      openedSession.transcoded=transcoded;
      if(transcoded&&loading.seeked){await this.endSession(openedSession,access,start);openedSession=null;if(this.validContext(context,generation))return this.load(this.room.room.playback);return;}
      const url=new URL(stream,access.base.replace(/\/$/,'')+'/');if(url.origin!==new URL(access.base).origin)throw Error('片源返回了其他站点地址，无法安全共享授权');
      // PlaybackInfo may return a zero-based URL. The actual stream request must
      // match our timeline offset, including after every transcoded seek.
      if(transcoded){for(const key of [...url.searchParams.keys()])if(key.toLowerCase()==='starttimeticks')url.searchParams.delete(key);url.searchParams.set('StartTimeTicks',Math.round(start*tick));}
      if(!url.searchParams.has('api_key'))url.searchParams.set('api_key',access.token);url.searchParams.set('DeviceId',this.room.self);
      this.session=openedSession;openedSession=null;this.offset=transcoded?start:0;this.url=url.href;this.updateDuration(Number(source.RunTimeTicks||0)/tick);
      if(this.nativePlayer){this.playbackId=id();const seek=this.beginSeek(start);await nativeCall('playerCommand',JSON.stringify({url:this.url,playbackId:this.playbackId,seekId:seek.id,positionMs:Math.max(0,start-this.offset)*1000,playing:false,rate:playbackRate(state),volume:this.volume,muted:this.muted,visible:this.playerVisible(),bounds:this.rectangle(),...(this.directTracks?{audioStreamIndex:this.audioIndex,subtitleStreamIndex:-1,mediaTracks:this.mediaTracks()}:this.nativeTracks?{subtitleStreamIndex:-1}:{})}));}
      else{this.video.volume=this.volume;this.video.muted=this.muted;if(/\.m3u8(?:\?|$)/i.test(url.href)&&globalThis.Hls?.isSupported()){const hls=this.hls=new Hls({maxBufferLength:15,backBufferLength:10,manifestLoadingMaxRetry:2,levelLoadingMaxRetry:2,fragLoadingMaxRetry:2,fragLoadingTimeOut:20000});hls.on(Hls.Events.ERROR,(_,e)=>{if(e.fatal&&this.validContext(context,generation))this.mediaFailure(e.type==='networkError'?(e.response?.code>=400?'Emby 兼容转码分片不可用（HTTP '+e.response.code+'）。请换兼容音轨或影片，或检查片源转码服务':'兼容转码清单或分片无法读取；请检查片源网络、HTTPS 入口和转码服务，或换兼容音轨或影片'):'视频或音轨解码失败，请重试兼容转码');});hls.loadSource(url.href);hls.attachMedia(this.video);}else this.video.src=url.href;}
      if(!this.validContext(context,generation))return;this.checkin('Playing').catch(()=>{});this.loading=false;this.follow(true);this.loadSubtitles().catch(()=>{});this.render();
    }catch(e){if(openedSession)await this.endSession(openedSession,access,start);if(this.validContext(context,generation)){this.loading=false;this.failPlayback(e.name==='AbortError'?'片源响应超时，请检查服务状态后重试':e.message==='Failed to fetch'?'无法连接片源：请检查 HTTPS 入口、Emby 跨域设置和网络，再重试':e.message||'无法加载片源');}}
    finally{if(this.loadingRequest===loading)this.loadingRequest=null;}
  }
  target(state=this.room.room?.playback){if(!state)return 0;const now=performance.now(),elapsed=state.playing&&!this.waiting&&!this.room.background?Math.max(0,(this.room.host?now-state.at:Number.isFinite(this.hostOffset)&&Number.isFinite(state.at)?now+this.hostOffset-state.at:now-(this.receivedAt||now))/1000)*playbackRate(state):0;return Math.min(state.duration||Infinity,Math.max(0,state.position+elapsed));}
  async follow(force=false){
    const state=this.room.room?.playback;if(!state||this.loading||!this.url||this.failedEpoch===state.epoch)return;
    const play=state.playing&&!this.waiting&&!this.room.background&&this.room.client.ready,target=this.target(state),current=this.current(),rate=playbackRate(state);
    const seek=Math.abs(current-target)>(force?.05:1.5)&&(!this.pendingSeek||force);
    if(this.nativePlayer){const change={playing:play,rate,volume:this.volume,muted:this.muted};if(seek){change.seekId=this.beginSeek(target).id;change.positionMs=Math.max(0,target-this.offset)*1000;}await nativeCall('playerCommand',JSON.stringify(change));}
    else{if(seek&&this.video.readyState){this.beginSeek(target);this.video.currentTime=Math.max(0,target-this.offset);}this.video.playbackRate=rate*(!force&&play&&!this.pendingSeek&&Math.abs(current-target)>.2?(current<target?1.03:.97):1);if(play)try{await this.video.play();this.autoplay=false;}catch{this.autoplay=true;}else this.video.pause();}
    this.render();
  }
  beginSeek(position){this.playerSeekId=id();return this.pendingSeek={id:this.playerSeekId,position,since:performance.now()};}
  confirmSeek(position){if(this.pendingSeek&&Math.abs(position-this.pendingSeek.position)<2)this.pendingSeek=null;}
  current(){return this.pendingSeek?.position??(this.nativePlayer?this.position:(this.video.currentTime||0)+(this.offset||0));}
  finishPlayback(){if(this.room.host&&this.url&&!this.loading&&!this.buffering&&!this.pendingSeek&&!this.video.seeking&&this.duration>0&&this.current()>=this.duration-1)this.control(false,this.duration);}
  updateDuration(value){if(this.url&&Number.isFinite(value)&&value>0){this.duration=value;const state=this.room.room?.playback;if(this.room.host&&state?.epoch===this.epoch)state.duration=value;}}
  async control(playing,position=this.current(),rate=playbackRate(this.room.room?.playback)){
    if(!this.room.host||!this.room.room.playback)return;
    if(playing&&arguments.length===1&&this.duration>0&&position>=this.duration-.25)position=0;
    if(!PLAYBACK_RATES.includes(Number(rate)))throw Error('不支持的播放倍速');if(playing)this.unlockMedia();
    const state=this.room.room.playback,context=this.room.context();state.position=Math.max(0,Math.min(state.duration||Infinity,Number(position)||0));state.playing=playing;state.rate=Number(rate);state.version++;state.at=performance.now();this.receivedAt=performance.now();this.waiting=false;
    if(this.loadingRequest&&this.loadingRequest.generation===this.generation&&this.loadingRequest.epoch===state.epoch){if(Math.abs(this.current()-position)>2)this.loadingRequest.seeked=true;}
    else if(this.session?.transcoded&&Math.abs(this.current()-position)>2)await this.load(state);
    if(!this.validContext(context)||this.room.room.playback!==state)return;await this.follow(true);if(!this.validContext(context))return;this.scheduleHostSave();await this.send('watch.state',state);if(!this.validContext(context))return;this.room.checkpoint();
  }
  async event(e){
    if(e.type==='playerInteraction'){this.ui?.wake();return;}
    if(e.type==='reset')this.ui?.reset();
    if(e.type==='leaving'){await this.saveHost();return;}
    if(e.type==='reset'){this.loginOperation=(this.loginOperation||0)+1;this.ownedSource=null;this.restoring=false;this.restoreTracks=null;this.voice.stop();const stopping=this.stopMedia();this.access=null;this.room.mediaAccess=null;this.epoch='';this.error='';this.subtitleError='';this.tracks=[];this.loading=false;this.waiting=false;this.lastSync=undefined;this.hostOffset=this.bestRtt=undefined;this.chatSeen?.clear();$('danmaku').replaceChildren();$('emby-dialog').close();$('library-dialog').close();$('emby-user').value='';$('emby-password').value='';$('emby-share').checked=false;$('emby-items').replaceChildren();await stopping;return;}
    if(!this.active)return;
    if(e.type==='hostReady'){await this.restoreHost();return;}
    const context=this.room.context();
    this.voice.event(e);
    if(e.type==='voice'){this.voice.receive(e.from,e.bytes);return;}
    if(e.type==='joined'){
      this.lastHost=performance.now();this.waiting=false;this.hostOffset=this.bestRtt=undefined;
      if(e.access){const access=this.clientAccess(e.access),changed=!['base','token','userId','canTranscode'].every(key=>this.access?.[key]===access[key]),stopping=changed?this.stopMedia():null;this.access=access;this.epoch='';if(changed){this.loading=false;this.failedEpoch=this.fallbackEpoch=this.error='';await stopping;if(!this.validContext(context))return;}this.render();}
      this.requestSync();
    }
    if(e.type==='watch.access'&&e.from===this.room.room.hostId&&e.body?.base&&e.body?.token){const access=this.clientAccess(e.body);if(['base','token','userId','canTranscode'].every(key=>this.access?.[key]===access[key]))return;const stopping=this.stopMedia();this.access=access;this.loading=false;this.epoch='';this.failedEpoch=this.fallbackEpoch=this.error='';await stopping;if(!this.validContext(context))return;this.render();}
    if(e.type==='watch.state'&&e.from===this.room.room.hostId){const s=e.body,old=this.room.room.playback;if(!s?.epoch||!Number.isFinite(s.position)||!Number.isInteger(s.version)||old?.epoch===s.epoch&&s.version<=old.version)return;const seeked=old?.epoch===s.epoch&&Math.abs(s.position-this.target(old))>2;this.lastHost=performance.now();this.waiting=false;this.room.room.playback=s;this.receivedAt=performance.now();if(this.failedEpoch===s.epoch)return;if(this.loadingRequest&&this.loadingRequest.generation===this.generation&&this.loadingRequest.epoch===s.epoch){if(seeked)this.loadingRequest.seeked=true;return;}if(this.epoch!==s.epoch||this.session?.transcoded&&seeked)this.load(s);else this.follow(seeked);}
    if(e.type==='watch.sync'&&this.room.host){if(this.room.mediaAccess)await this.send('watch.access',this.room.mediaAccess,e.from);if(!this.validContext(context))return;if(this.room.room.playback)await this.send('watch.state',{...this.room.room.playback,position:this.url&&!this.loading&&this.failedEpoch!==this.epoch?this.current():this.target(),at:performance.now(),version:++this.room.room.playback.version},e.from);}
    if(e.type==='watch.clock'&&this.room.host&&Number.isFinite(e.body.sent))await this.send('watch.clockReply',{sent:e.body.sent,host:performance.now()},e.from);
    if(e.type==='watch.clockReply'&&e.from===this.room.room.hostId&&e.body.sent===this.clockSent){const rtt=performance.now()-e.body.sent;if(rtt>=0&&rtt<2000&&Number.isFinite(e.body.host)&&(this.bestRtt===undefined||rtt<=this.bestRtt*1.5)){this.bestRtt=rtt;this.hostOffset=e.body.host-(e.body.sent+rtt/2);}}
    if(e.type==='watch.chat'&&typeof e.body.text==='string'&&e.body.text.length<=200){this.chat(e.body.id,e.body.text,e.from);}
    if(e.type==='player'){
      if(e.nativeUnavailable&&this.url){++this.generation;this.loading=false;this.failPlayback('电影厅原生组件启动失败，请重新安装电影厅插件后重试');return;}
      if(!this.url||this.playbackId&&e.playbackId!==this.playbackId||this.playerSeekId&&e.seekId!==this.playerSeekId)return;
      this.buffering=!!e.buffering||!!e.seeking;
      if(!e.seeking&&Number.isFinite(e.positionMs)){const position=e.positionMs/1000+(this.offset||0);this.pendingSeek=null;this.position=position;}
      if(e.durationMs>0&&(!this.session?.transcoded||!this.duration))this.updateDuration(Number(e.durationMs)/1000+(this.offset||0));
      if(e.error||e.audioPresent&&e.audioSupported===false){
        // Media3 reports unsupported container/manifest and decoder failures as
        // these codes. Network, authorization, output and unknown errors retry
        // the same playback mode instead of assuming a codec incompatibility.
        const audioUnsupported=e.audioPresent&&e.audioSupported===false,codecFailure=audioUnsupported||[3003,3004,4001,4003,4004,4005].includes(e.errorCode);
        this.mediaFailure(audioUnsupported?'播放器不支持此音轨，请切换兼容音轨或重试转码':codecFailure?'播放器无法解码此片源，请重试兼容转码或选择兼容影片':'播放器无法读取当前片源，请检查网络后重试；将保持当前播放方式',codecFailure);
      }
      if(e.ended&&!e.seeking)this.finishPlayback();
    }
    if(e.type==='background'||e.type==='disconnected'||e.type==='audioFocusLost'){this.saveHost();this.voice.mute();if(this.room.host){if(this.room.room.playback)this.control(false);}else this.waiting=true;this.follow(true);}
    if(e.type==='foreground'||e.type==='networkChanged'){this.voice.mute();this.hostOffset=this.bestRtt=undefined;if(!this.room.host)this.send('watch.sync',{},this.room.room.hostId);else if(this.room.room.playback)this.control(false);this.voice.configure();}
  }
  chat(messageId,text,from){
    if(!/^[a-f0-9]{32}$/.test(messageId))return;this.chatRate??=new Map();const now=performance.now();if(now-(this.chatRate.get(from)||-1000)<400)return;this.chatRate.set(from,now);
    this.chatSeen??=new Set();if(this.chatSeen.has(messageId))return;this.chatSeen.add(messageId);if(this.chatSeen.size>128)this.chatSeen.delete(this.chatSeen.values().next().value);
    const name=this.room.room.members.find(p=>p.id===from)?.name||'朋友',span=document.createElement('span');span.textContent=name+'：'+text;span.style.top=(10+(this.chatLane=(this.chatLane||0)+1)%5*15)+'%';while($('danmaku').childElementCount>=30)$('danmaku').firstElementChild.remove();$('danmaku').append(span);setTimeout(()=>span.remove(),8000);
    if(this.nativePlayer)nativeCall('playerCommand',JSON.stringify({visible:this.playerVisible(),bounds:this.rectangle(),danmaku:{id:messageId,text:name+'：'+text}}));
  }
  async sendChat(text){text=text.trim().slice(0,200);if(!text||performance.now()-(this.lastChat||-1000)<500)return;this.lastChat=performance.now();const message={id:id(),text};this.chat(message.id,text,this.room.self);await this.send('watch.chat',message);}
  async pulse(){
    if(!this.active)return;const context=this.room.context();if(performance.now()-(this.lastHostSave||0)>=5000)this.saveHost();this.voice.configure();this.render();if(!this.room.client.ready)return;if(!this.room.host&&!this.access)this.requestSync();
    if(this.pendingSeek&&performance.now()-this.pendingSeek.since>30000){this.pendingSeek=null;this.failPlayback('跳转未完成，请重试播放或切换画质');}
    if(!this.room.host&&performance.now()-(this.lastClock||0)>5000){this.lastClock=this.clockSent=performance.now();this.send('watch.clock',{sent:this.clockSent},this.room.room.hostId);}
    const state=this.room.room.playback;if(!state)return;
    if(this.room.host&&!this.room.background){state.position=this.url&&!this.loading&&(this.nativePlayer||this.video.readyState>=1)?this.current():state.position;if(state.duration>0&&state.position>=state.duration)state.playing=false;state.version++;state.at=performance.now();this.receivedAt=performance.now();this.send('watch.state',state);}
    else if(!this.room.host&&performance.now()-this.lastHost>5000){this.waiting=true;this.follow();if(performance.now()-this.lastHost>60000){try{await this.room.client.roomSync(this.room.room.roomId);}catch(e){if(this.validContext(context)&&e.code==='ROOM_NOT_FOUND'){this.room.reset();this.room.events.changed?.();}}}}
    if(!this.validContext(context))return;
    if(this.session&&performance.now()-(this.lastCheckin||0)>10000){this.lastCheckin=performance.now();this.checkin('Playing/Progress').catch(()=>{});}
  }
  async checkin(path){if(!this.session||!this.access)return;const s=this.session;await mediaRequest(this.endpoint('Sessions/'+path),'POST',this.headers(),{ItemId:s.itemId,MediaSourceId:s.sourceId,PlaySessionId:s.id,PositionTicks:Math.round(this.current()*tick),IsPaused:!this.room.room?.playback?.playing,CanSeek:true,PlayMethod:s.transcoded?'Transcode':'DirectPlay'});}
  async endSession(session,access,position){
    if(!session||!access||session.id&&session.id===this.session?.id&&access.base===this.access?.base)return;
    // A late PlaybackInfo response owns only its Emby session, never the current
    // local player. Do not send a device-wide stop when the response has no ID.
    const headers=this.headers(access,session.deviceId),reports=[];
    if(session.id){reports.push(mediaRequest(this.endpoint('Sessions/Playing/Stopped',{},access),'POST',headers,{ItemId:session.itemId,MediaSourceId:session.sourceId,PlaySessionId:session.id,PositionTicks:Math.round(position*tick)},2000));if(session.transcoded)reports.push(mediaRequest(this.endpoint('Videos/ActiveEncodings',{DeviceId:session.deviceId||this.room.self,PlaySessionId:session.id},access),'DELETE',headers,undefined,2000));}
    if(session.liveStreamId&&!(session.liveStreamId===this.session?.liveStreamId&&access.base===this.access?.base))reports.push(mediaRequest(this.endpoint('LiveStreams/Close',{},access),'POST',headers,{LiveStreamId:session.liveStreamId},2000));
    await Promise.allSettled(reports);
  }
  async stopMedia(invalidate=true){
    if(invalidate)++this.generation;cancelImages();this.clearSubtitles();const session=this.session,position=this.current(),access=this.access;
    this.session=null;this.url='';this.playbackId='';this.playerSeekId='';this.pendingSeek=null;this.buffering=false;this.hls?.destroy();this.hls=null;this.video.pause();this.video.removeAttribute('src');this.video.load();
    if(this.stopping&&!session)return this.stopping;
    const previous=this.stopping,stopping=(async()=>{
      if(previous)await previous;
      // Android playerStop cancels pending media calls. Send terminal reports
      // afterwards, and let the next load wait before it changes the origin.
      if(this.nativePlayer)await nativeCall('playerStop');
      await this.endSession(session,access,position);
    })();
    this.stopping=stopping;try{await stopping;}finally{if(this.stopping===stopping)this.stopping=null;}
  }
  rectangle(){const r=$('watch-screen').getBoundingClientRect(),stage=$('watch-stage'),bar=document.querySelector('.cinema-playback');const clipHeight=document.fullscreenElement===stage&&!stage.classList.contains('controls-hidden')?Math.max(0,Math.min(bar.getBoundingClientRect().top,...(bar.querySelector('details').open?[bar.querySelector('.watch-settings-panel').getBoundingClientRect().top]:[]))-r.top):r.height;return {x:r.x,y:r.y,width:r.width,height:r.height,clipHeight};}
  async skip(seconds){const state=this.room.room?.playback;if(!this.room.host||!state||this.loading||!this.url)return;const end=state.duration||this.duration||Infinity;await this.control(!!state.playing,Math.max(0,Math.min(end,this.current()+seconds)));}
  playerVisible(){if(!this.active||this.room.background||desktopPlayback()&&!this.session||globalThis.document?.querySelector('dialog[open]')||globalThis.document?.querySelector('.watch-settings[open]')&&globalThis.document?.fullscreenElement!==$('watch-stage'))return false;const r=this.rectangle();return r.width>0&&r.height>0&&r.x+r.width>0&&r.y+r.height>0&&r.x<(globalThis.innerWidth||Infinity)&&r.y<(globalThis.innerHeight||Infinity);}
  bounds(){if(this.active&&this.nativePlayer)nativeCall('playerCommand',JSON.stringify({visible:this.playerVisible(),bounds:this.rectangle()}));}
  showError(message){this.error=message;this.render();}
  render(){
    const r=this.room.room;if(r?.game!=='watch')return;
    if(!r.playback&&this.url)this.stopMedia().catch(()=>{});
    $('watch-name').textContent=r.name;$('watch-title').textContent=r.playback?.title||'挑一部电影，朋友随时入座';$('watch-count').textContent=r.members.length+'/6 人';
    $('watch-source').hidden=!this.room.host;$('watch-library').hidden=!this.room.host;$('watch-library').textContent=this.access?.token?(r.playback?'更换影片':'浏览片库'):'连接片源';$('watch-play').hidden=!this.room.host;$('watch-seek').disabled=!this.room.host||!r.playback||this.loading;$('watch-empty').hidden=!!r.playback;
    for(const id of ['watch-back','watch-forward']){const b=$(id);if(b){b.hidden=!this.room.host;b.disabled=!r.playback||this.loading||!this.url;}}
    $('watch-play').textContent=r.playback?.playing?'暂停':'播放';$('watch-play').disabled=!r.playback||this.loading||!this.url;
    $('watch-join').textContent=r.playback?'加入观影 / 开启声音':'开启语音收听';$('danmaku-text').placeholder=r.playback?'说说这个镜头…':'发条弹幕，和朋友聊聊…';
    $('watch-seek').max=String(r.playback?.duration||this.duration||1);if(document.activeElement!==$('watch-seek'))$('watch-seek').value=String(this.current());
    const clock=value=>{const seconds=Math.max(0,Math.floor(value||0));return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');};$('watch-time').textContent=clock(r.playback?this.current():0)+' / '+clock(r.playback?(r.playback.duration||this.duration):0);
    $('watch-message').textContent=this.error||(!this.access&&r.playback?'正在向房主获取片源授权…':this.waiting?'房主暂时不可用，暂停等待恢复':this.loading?'正在连接片源…':this.autoplay?'点击「加入观影 / 开启声音」允许电影发声':this.buffering?'正在缓冲，仅影响当前设备':!r.playback?'等待房主选片，现在可以语音聊天和发弹幕':this.room.host&&native&&this.room.mediaAccess?.base.startsWith('http:')&&!this.room.mediaAccess.webBase?'当前为 HTTP 片源；HTTPS 网页观众需要在片源设置填写网页 HTTPS 入口':'只有房主控制电影；音量、画质、音轨和字幕只影响本机');
    $('watch-retry').hidden=!this.error||!r.playback;$('watch-retry').disabled=this.loading;$('watch-mute').textContent=this.muted?'取消静音':'静音';$('watch-mute').setAttribute('aria-pressed',String(this.muted));if(document.activeElement!==$('watch-volume'))$('watch-volume').value=String(this.volume);
    const select=(name,value,disabled,options)=>{const element=$(name);if(options){const key=JSON.stringify(options);if(element.dataset.options!==key){element.dataset.options=key;element.replaceChildren(...options.map(([value,label])=>{const option=document.createElement('option');option.value=value;option.textContent=label;return option;}));}}element.value=String(value);element.disabled=disabled;const trigger=element.nextElementSibling;if(trigger?.classList.contains('choice-trigger')){trigger.textContent=(element.selectedOptions[0]?.textContent||'请选择')+'  ⌄';trigger.disabled=disabled;}};
    const audio=this.tracks.filter(s=>s.Type==='Audio'),subtitles=this.tracks.filter(s=>s.Type==='Subtitle'),trackLabel=s=>[s.DisplayTitle||s.Title||s.Language||'未标注语言',s.Codec?.toUpperCase(),s.Channels?s.Channels+' 声道':s.IsForced?'强制字幕':''].filter(Boolean).join(' · ');
    select('watch-rate',playbackRate(r.playback),!this.room.host||!r.playback||this.loading);select('watch-quality',this.quality,!r.playback||this.loading);
    select('watch-audio',this.audioIndex??'',!audio.length||this.loading,audio.length?audio.map(s=>[s.Index,trackLabel(s)]):[['','暂无音轨信息']]);select('watch-subtitles',this.subtitleIndex,!subtitles.length||this.loading,[[-1,'关闭字幕'],...subtitles.map(s=>[s.Index,trackLabel(s)+(this.embeddedSubtitle(s)?' · 本机字幕':this.textSubtitle(s)?'':' · 需转码烧录')])]);
    const method=this.session?(this.session.transcoded?'Emby 转码 · H.264 / AAC':desktopPlayback()?'本机解码 · 原画':this.nativePlayer?'设备解码 · 原画':'浏览器解码 · 原画'):'',trackStatus=this.subtitleError||(this.subtitleLoading?'正在加载字幕…':'')||(this.burnSubtitle?'图片字幕正在随视频烧录；切换字幕会重新协商转码。':this.directTracks?'内嵌音轨与字幕在本机切换；降低清晰度需要 Emby 转码。':r.playback&&!subtitles.length?'片源未提供字幕。画质、音轨切换需 Emby 支持转码。':'文本字幕独立加载；图片字幕需要 Emby 转码烧录。');
    $('watch-track-status').textContent=(method?'播放方式：'+method+'。':'')+trackStatus;
    $('watch-mic').textContent=this.voice.microphone?'关闭麦克风':'开启麦克风';$('watch-mic').classList.toggle('recording',this.voice.microphone);$('voice-status').textContent=this.voice.status;
    const memberKey=JSON.stringify([r.hostId,this.room.self,this.room.host,r.members.map(p=>[p.id,p.name])]);if($('watch-members').dataset.key!==memberKey){$('watch-members').dataset.key=memberKey;$('watch-members').replaceChildren(...r.members.map(p=>{const b=document.createElement('button'),label=document.createElement('span'),path=document.createElement('small');b.className='secondary';label.textContent=p.name+(p.id===r.hostId?' · 房主':'');path.className='member-path';path.dataset.memberPath=p.id;b.append(label,path);b.disabled=!this.room.host||p.id===this.room.self;b.onclick=()=>this.room.events.kick?.(p);return b;}));this.room.events.network?.();}
    if(r.playback&&this.access&&this.epoch!==r.playback.epoch&&!this.loading&&this.failedEpoch!==r.playback.epoch){this.receivedAt=performance.now();this.load(r.playback);}
    this.voice.configure().catch(e=>{this.voice.status=e.message;});
    this.video.hidden=this.nativePlayer;this.bounds();
  }
}
