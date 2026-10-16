import './plugin-test-host.mjs';
// Exercise the real loading, state, authorization and session-cleanup methods.
// Only DOM, HLS and HTTP boundaries are fake; no server or native player is started.
import assert from 'node:assert/strict';
import {WatchRoom} from '../plugins/watch/watch.js';

const original={fetch:globalThis.fetch,performance:globalThis.performance,document:globalThis.document,Hls:globalThis.Hls,window:globalThis.window,ResizeObserver:globalThis.ResizeObserver,MutationObserver:globalThis.MutationObserver,setInterval:globalThis.setInterval};
let now=1000;
globalThis.performance={now:()=>now};
globalThis.document={getElementById:()=>({textContent:''})};
globalThis.window={addEventListener(){}};
globalThis.ResizeObserver=globalThis.MutationObserver=class {observe(){}};
globalThis.setInterval=()=>0;
class Hls {
  static Events={ERROR:'error'};
  static isSupported(){return true;}
  on(type,handler){this.handler=handler;} emit(error){this.handler?.('error',error);}
  loadSource(url){this.url=url;} attachMedia(){} stopLoad(){}
  destroy(){this.destroyed=true;}
}
globalThis.Hls=Hls;
async function settle(){for(let i=0;i<60;i++)await Promise.resolve();}
async function until(check,message){await settle();assert.ok(check(),message);}
function harness(){
  now=1000;
  const requests=[],reports=[];
  globalThis.fetch=async(url,options)=>{
    const parsed=new URL(url),body=options.body?JSON.parse(options.body):null;
    if(parsed.pathname.endsWith('/PlaybackInfo'))return new Promise(resolve=>{
      const index=requests.length+1,request={url,body,headers:options.headers,index,done:false};requests.push(request);
      request.reply=(direct=false,session='session-'+index)=>{if(request.done)return;request.done=true;resolve({status:200,text:async()=>JSON.stringify({PlaySessionId:session,MediaSources:[{Id:'source-'+index,RunTimeTicks:6000000000,LiveStreamId:'live-'+index,SupportsDirectPlay:direct,Container:'mp4',MediaStreams:[{Type:'Video',Codec:'h264'},{Type:'Audio',Codec:'aac',Index:1}],...(direct?{DirectStreamUrl:'/video.mp4'}:{TranscodingUrl:'/hls/'+session+'.m3u8?StartTimeTicks='+body.StartTimeTicks})}]})});};
    });
    reports.push({path:parsed.pathname,query:Object.fromEntries(parsed.searchParams),body,headers:options.headers});
    return {status:200,text:async()=>'{}'};
  };
  const state={epoch:'film',itemId:'film-item',position:180,duration:600,version:1,playing:false,rate:1,at:now};
  const room={self:'guest',host:false,background:false,room:{game:'watch',hostId:'host',playback:state},client:{ready:true},context:()=>1,current:c=>c===1};
  const listeners=new Map(),video={currentTime:0,readyState:2,seeking:false,pauses:0,pause(){this.pauses++;},load(){this.currentTime=0;this.error=null;},removeAttribute(){},play:async()=>{},addEventListener(type,handler){listeners.set(type,handler);},emit(type){listeners.get(type)?.();}};
  globalThis.document={getElementById:name=>name==='watch-video'?video:{textContent:''},addEventListener(){},body:{}};
  const watch=Object.assign(new WatchRoom(room,()=>{}),{access:{base:'http://fixture.invalid',token:'old-test-token',userId:'viewer'},receivedAt:now,hostOffset:0,voice:{event(){},configure(){}},render(){},send:async()=>{},loadSubtitles:async()=>{}});
  const update=async(position,extra={})=>watch.event({type:'watch.state',from:'host',body:{...room.room.playback,position,version:room.room.playback.version+1,at:now,...extra}});
  const release=async()=>{for(let i=0;i<6;i++){for(const request of requests)request.reply();await settle();}};
  return {watch,room,video,requests,reports,update,release};
}
async function startDirect({watch,room,requests}){const loading=watch.load(room.room.playback);await until(()=>requests.length===1,'initial direct negotiation');requests[0].reply(true);await loading;}
const tests=[
  ['HLS late join keeps only the latest seek and closes the discarded session',async h=>{
    const {watch,room,video,requests,reports,update}=h,loading=watch.load(room.room.playback);
    await until(()=>requests.length===1,'initial HLS negotiation');
    await update(40);await update(55);requests[0].reply();
    await until(()=>requests.length===2,'a seek received during HLS negotiation must request the latest timeline');
    assert.equal(requests[1].body.StartTimeTicks,550000000);
    assert.ok(reports.some(r=>r.path==='/Sessions/Playing/Stopped'&&r.body.PlaySessionId==='session-1'));
    assert.ok(reports.some(r=>r.path==='/LiveStreams/Close'&&r.body.LiveStreamId==='live-1'));
    assert.ok(reports.some(r=>r.path==='/Videos/ActiveEncodings'&&r.query.PlaySessionId==='session-1'));
    requests[1].reply();await loading;await settle();
    assert.equal(watch.offset,55);assert.equal(video.currentTime+watch.offset,55);assert.equal(watch.session.id,'session-2');assert.match(watch.hls.url,/session-2/);
    await update(55);assert.equal(requests.length,2);assert.ok(!reports.some(r=>r.path==='/Sessions/Playing/Stopped'&&r.body.PlaySessionId==='session-2'));
  }],
  ['ordinary one-second progress does not restart a slow HLS negotiation',async h=>{
    const {watch,room,requests,video,update}=h;room.room.playback.playing=true;
    const loading=watch.load(room.room.playback);await until(()=>requests.length===1,'initial negotiation');
    for(let i=1;i<=5;i++){now+=1000;await update(180+i);}
    requests[0].reply();await loading;await settle();
    assert.equal(requests.length,1);assert.equal(watch.offset,180);assert.equal(video.currentTime,5);
    watch.confirmSeek(185);assert.equal(watch.pendingSeek,null);
  }],
  ['direct streams apply a late seek locally without renegotiating',async h=>{
    const {watch,room,requests,video,update}=h,loading=watch.load(room.room.playback);
    await until(()=>requests.length===1,'direct negotiation');await update(40);requests[0].reply(true);await loading;await settle();
    assert.equal(requests.length,1);assert.equal(watch.session.transcoded,false);assert.equal(watch.offset,0);assert.equal(video.currentTime,40);
  }],
  ['old-epoch responses release only their own session after a new film starts',async h=>{
    const {watch,room,requests,reports,video,update}=h,oldLoad=watch.load(room.room.playback);
    await until(()=>requests.length===1,'old film negotiation');await update(10,{epoch:'new-film',itemId:'new-item',version:1});
    await until(()=>requests.length===2,'new film negotiation');requests[1].reply();await until(()=>watch.session?.id==='session-2'&&!watch.loading,'new film starts');
    const currentHls=watch.hls,pauses=video.pauses;requests[0].reply();await oldLoad;await settle();
    assert.equal(watch.session.id,'session-2');assert.equal(watch.hls,currentHls);assert.ok(!currentHls.destroyed);assert.equal(video.pauses,pauses);
    assert.ok(reports.some(r=>r.path==='/Sessions/Playing/Stopped'&&r.body.PlaySessionId==='session-1'),'discarded response closes its session');
    assert.ok(!reports.some(r=>r.path==='/Videos/ActiveEncodings'&&r.query.PlaySessionId==='session-2'));
  }],
  ['changed authorization clears a failed film once, identical authorization does not loop',async h=>{
    const {watch,room,requests}=h;watch.epoch='film';watch.failedEpoch='film';watch.fallbackEpoch='film';watch.error='expired authorization';
    const access={...watch.access,token:'fresh-test-token'},event={type:'watch.access',from:'host',body:access};
    await watch.event(event);assert.equal(watch.failedEpoch,'','new authorization permits one fresh attempt');assert.equal(watch.fallbackEpoch,'');assert.equal(watch.error,'');
    const loading=watch.load(room.room.playback);await until(()=>requests.length===1,'fresh authorization negotiates');assert.equal(requests[0].headers['X-Emby-Token'],access.token);requests[0].reply();await loading;
    watch.failPlayback('fixture playback failure');await watch.event(event);await watch.load(room.room.playback);assert.equal(watch.failedEpoch,'film');assert.equal(requests.length,1,'same watch.access cannot turn a persistent failure into a retry loop');
  }],
  ['authorization change isolates late cleanup from the new access and session',async h=>{
    const {watch,room,requests,reports}=h,oldLoad=watch.load(room.room.playback);
    await until(()=>requests.length===1,'old access negotiation');await watch.event({type:'watch.access',from:'host',body:{...watch.access,token:'fresh-test-token'}});
    const nextLoad=watch.load(room.room.playback);await until(()=>requests.length===2,'new access negotiation');requests[1].reply();await nextLoad;
    requests[0].reply();await oldLoad;await settle();assert.equal(watch.session.id,'session-2');
    const stopped=reports.find(r=>r.path==='/Sessions/Playing/Stopped'&&r.body.PlaySessionId==='session-1');assert.ok(stopped);assert.equal(stopped.headers['X-Emby-Token'],'old-test-token');
    assert.ok(!reports.some(r=>r.path==='/Sessions/Playing/Stopped'&&r.body.PlaySessionId==='session-2'));
  }],
  ['recovery JOIN with changed authorization also unlocks the film only once',async h=>{
    const {watch,room,requests}=h;watch.epoch='film';watch.failedEpoch='film';watch.error='expired authorization';
    const access={...watch.access,token:'join-test-token'};await watch.event({type:'joined',access});
    assert.equal(watch.failedEpoch,'','JOIN must not bypass authorization recovery');assert.equal(watch.error,'');
    const loading=watch.load(room.room.playback);await until(()=>requests.length===1,'JOIN authorization negotiates');requests[0].reply();await loading;
    watch.failPlayback('fixture playback failure');await watch.event({type:'watch.access',from:'host',body:access});await watch.event({type:'joined',access});
    assert.equal(watch.failedEpoch,'film');assert.equal(requests.length,1);
  }],
  ['a reused session ID and unidentified responses cannot stop the current session',async h=>{
    const {watch,room,requests,reports,update}=h,oldLoad=watch.load(room.room.playback);
    await until(()=>requests.length===1,'old negotiation');await update(10,{epoch:'new-film',itemId:'new-item',version:1});
    await until(()=>requests.length===2,'new negotiation');requests[1].reply(false,'shared-session');await until(()=>watch.session?.id==='shared-session','new player owns the ID');
    requests[0].reply(false,'shared-session');await oldLoad;assert.ok(!reports.some(r=>r.path==='/Sessions/Playing/Stopped'||r.path==='/Videos/ActiveEncodings'));
    await watch.endSession({itemId:'unidentified',transcoded:true,liveStreamId:watch.session.liveStreamId},watch.access,0);
    assert.ok(!reports.some(r=>r.path==='/Sessions/Playing/Stopped'||r.path==='/Videos/ActiveEncodings'||r.path==='/LiveStreams/Close'));
  }],
  ['a browser abort does not turn a direct stream into a codec failure',async h=>{
    const {watch,video,requests}=h;await startDirect(h);const session=watch.session;
    video.error={code:1};video.emit('error');await settle();
    assert.equal(requests.length,1);assert.equal(watch.session,session);assert.ok(!watch.failedEpoch);assert.ok(!watch.compatibility);assert.equal(watch.error,'');
  }],
  ['a browser network failure stays direct, stops automatic attempts and permits manual retry',async h=>{
    const {watch,video,requests,update}=h;await startDirect(h);
    video.error={code:2};video.emit('error');await settle();
    assert.equal(requests.length,1,'network failure must not negotiate transcoding');assert.equal(watch.failedEpoch,'film');assert.ok(!watch.compatibility);assert.match(watch.error,/网络.*重试/);
    for(let i=0;i<5;i++){now+=1000;video.emit('error');await update(180+i);await watch.load(watch.room.room.playback);}
    assert.equal(requests.length,1,'failed epoch bounds retries even with repeated error and host state events');
    const retry=watch.reload();await until(()=>requests.length===2,'explicit retry negotiates once');assert.equal(requests[1].body.EnableDirectPlay,true);assert.equal(requests[1].body.AllowVideoStreamCopy,true);
    requests[1].reply(true);await retry;assert.equal(watch.failedEpoch,'');assert.equal(watch.session.transcoded,false);assert.ok(!watch.compatibility);
  }],
  ...[3,4].map(code=>['browser codec error '+code+' falls back once and a failed HLS stream stays stopped',async h=>{
    const {watch,video,requests,update}=h;await startDirect(h);
    video.error={code};video.emit('error');await until(()=>requests.length===2,'a definite codec error requests compatibility playback');
    assert.equal(requests[1].body.EnableDirectPlay,false);requests[1].reply();await until(()=>watch.session?.transcoded&&!watch.loading,'compatibility playback started');
    watch.hls.emit({fatal:true,type:'networkError',response:{code:500}});await settle();assert.equal(watch.failedEpoch,'film');assert.match(watch.error,/HTTP 500/);
    for(let i=0;i<5;i++){video.error={code};video.emit('error');await update(180+i);}assert.equal(requests.length,2,'a fallback failure cannot recursively retry');
  }]),
  ['an unclassified browser error does not assume unsupported codecs',async h=>{
    const {watch,video,requests}=h;await startDirect(h);video.error=null;video.emit('error');await settle();
    assert.equal(requests.length,1);assert.equal(watch.failedEpoch,'film');assert.ok(!watch.compatibility);assert.match(watch.error,/重试/);
  }],
  ['a generic native read failure does not automatically force transcoding',async h=>{
    const {watch,requests}=h;await startDirect(h);await watch.event({type:'player',seekId:watch.playerSeekId,error:'network unavailable'});await settle();
    assert.equal(requests.length,1);assert.equal(watch.failedEpoch,'film');assert.ok(!watch.compatibility);
    const retry=watch.reload();await until(()=>requests.length===2,'the retry action reloads after a native failure');assert.equal(watch.error,'');assert.equal(requests[1].body.EnableDirectPlay,true);requests[1].reply(true);await retry;
    assert.equal(watch.failedEpoch,'');assert.equal(watch.error,'');assert.ok(watch.url);assert.equal(watch.session.transcoded,false);
  }],
  ['a definitely unsupported native audio track still permits one compatibility fallback',async h=>{
    const {watch,requests}=h;await startDirect(h);await watch.event({type:'player',seekId:watch.playerSeekId,audioPresent:true,audioSupported:false});
    await until(()=>requests.length===2,'known unsupported audio negotiates compatibility playback');assert.equal(requests[1].body.EnableDirectPlay,false);requests[1].reply();await settle();
    assert.ok(watch.session.transcoded);assert.equal(requests.length,2);
  }],
  ['a known native decoder failure still permits one compatibility fallback',async h=>{
    const {watch,requests}=h;await startDirect(h);await watch.event({type:'player',seekId:watch.playerSeekId,error:'decoder failure',errorCode:4003});
    await until(()=>requests.length===2,'Media3 decoding failure negotiates compatibility playback');assert.equal(requests[1].body.EnableDirectPlay,false);requests[1].reply();await settle();assert.ok(watch.session.transcoded);
  }],
];
try{
  for(const [name,run] of tests){const h=harness();try{await run(h);console.log('PASS '+name);}catch(error){process.exitCode=1;console.error('FAIL '+name+'\n'+error.stack);}finally{await h.release();}}
}finally{Object.assign(globalThis,original);}
