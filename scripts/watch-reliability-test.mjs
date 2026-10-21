import './plugin-test-host.mjs';
import assert from 'node:assert/strict';
import {WatchRoom,directCompatible,playbackRequest} from '../plugins/watch/watch.js';
import {cleanWatchSave} from '../plugins/watch/watch-save.js';
const source={SupportsDirectPlay:true,Container:'mkv',MediaStreams:[{Type:'Video',Codec:'h264',BitDepth:10,Profile:'High 10'},{Type:'Audio',Codec:'aac'}]};
assert.equal(directCompatible(source,false),false);assert.equal(directCompatible(source,true),true);
for(const metadata of [{BitDepth:8,PixelFormat:'yuv444p'},{Profile:'High 4:2:2'},{PixelFormat:'yuv420p10le'}])assert.equal(directCompatible({...source,MediaStreams:[{Type:'Video',Codec:'h264',...metadata}]},false),false);
assert.equal(directCompatible({...source,MediaStreams:[{Type:'Video',Codec:'h264',BitDepth:8,Profile:'High',PixelFormat:'yuv420p'}]},false),true);
assert.ok(playbackRequest().DeviceProfile.CodecProfiles.find(p=>p.Type==='Video').Conditions.some(c=>c.Property==='VideoBitDepth'&&c.Value==='8'));
const state={epoch:'first',seriesId:'series',itemId:'one',position:10,duration:100,playing:true,rate:1,version:1,at:performance.now()-20000,buffering:true};
const room={host:true,room:{game:'watch',playback:state},client:{ready:true},context:()=>1,current:c=>c===1,assertCurrent:c=>assert.equal(c,1),publish(){},checkpoint(){}};
const w=Object.assign(Object.create(WatchRoom.prototype),{room,epoch:'first',generation:0,access:{},video:{seeking:false,currentTime:100},url:'fixture',duration:100,position:100,current:()=>100,saveHost:async()=>{},render(){},control:async()=>{}});
assert.equal(w.target(),10,'Buffering freezes extrapolation');
let release,listCalls=0,selected=[];
w.episodes=()=>{listCalls++;return new Promise(r=>release=r);};w.select=async(item,play)=>selected.push([item.Id,play]);
const next=w.nextEpisode('first');await w.nextEpisode('first');assert.equal(listCalls,1,'Duplicate EOF cannot advance twice');
release([{Id:'one'},{Id:'two'}]);await next;assert.deepEqual(selected,[['two',true]]);
selected=[];const stale=w.nextEpisode('first');room.room.playback={...state,epoch:'manual',itemId:'other'};release([{Id:'one'},{Id:'two'}]);await stale;assert.deepEqual(selected,[],'Late next-episode result cannot replace a manually selected film');
room.room.playback={...state,itemId:'last'};const last=w.nextEpisode('first');release([{Id:'one'},{Id:'last'}]);await last;assert.deepEqual(selected,[],'Last episode must not loop');
// Latest selection wins even when saving yields before either load begins.
delete w.select;const saves=[];w.saveHost=()=>new Promise(r=>saves.push(r));const loads=[];w.load=async s=>loads.push(s.itemId);
const a=w.select({Id:'A',Name:'A',Type:'Movie'}),b=w.select({Id:'B',Name:'B',Type:'Movie'});
saves.shift()();await a;saves.shift()();await Promise.resolve();await Promise.resolve();saves.shift()();await Promise.resolve();await Promise.resolve();saves.shift()();await b;
assert.deepEqual(loads,['B']);assert.equal(room.room.playback.itemId,'B');
// A finite HLS stream cannot be repaired by seeking past the playlist end.
room.host=false;room.room.playback={...state,epoch:'hls',position:80,playing:false,buffering:false};Object.assign(w,{session:{transcoded:true},offset:60,loading:false,failedEpoch:'',video:{duration:10,currentTime:1,readyState:2},current:()=>61});
await w.follow(true);assert.equal(loads.at(-1),'one');
// The clock and browser/native boundaries are fake; playback decisions, failure
// handling, saving and epoch loading below exercise the production methods.
let now=1000;
const original={performance:globalThis.performance,fetch:globalThis.fetch,localStorage:globalThis.localStorage};
const stored=new Map();
globalThis.performance={now:()=>now};
globalThis.localStorage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)};
function playbackFixture({host=false,nativePlayer=false}={}){
  now=1000;
  const playback={epoch:'edge',itemId:'movie',position:60,duration:600,playing:true,buffering:false,version:1,rate:1,at:now};
  const room={host,self:host?'host':'guest',background:false,room:{game:'watch',hostId:'host',playback},client:{ready:true},context:()=>1,current:context=>context===1};
  const video={readyState:2,currentTime:60,duration:600,paused:false,seeking:false,pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();}};
  const reloads=[],watch=Object.assign(Object.create(WatchRoom.prototype),{room,video,url:'http://fixture.invalid/old.mp4',epoch:'edge',generation:1,offset:0,position:60,duration:600,loading:false,error:'',failedEpoch:'',autoplay:false,buffering:false,playbackStarted:true,frameStartedAt:now,progressAt:now,progressPosition:60,progressSamples:0,recoveryAttempts:0,recoverAt:0,receivedAt:now,lastHost:now,lastHostSave:now,lastCheckin:now,lastClock:now,access:{base:'http://fixture.invalid',token:'test-only',userId:'viewer'},render(){},showError(message){this.error=message;},send:async()=>{},reload:async()=>{reloads.push({position:room.room.playback.position,automatic:true});watch.recoverAt=0;}});
  Object.defineProperty(watch,'nativePlayer',{value:nativePlayer});
  return {watch,room,video,reloads};
}
const edges=[
  ['a paused direct stream with metadata is legal without a first-frame request',async()=>{
    const {watch,room,video,reloads}=playbackFixture();room.room.playback.playing=false;video.paused=true;video.readyState=1;watch.playbackStarted=false;
    await watch.follow();now+=180000;await watch.recoverPlayback();
    assert.equal(watch.initialMediaPending(),false);assert.equal(watch.needsAttention(),false);assert.equal(reloads.length,0);assert.equal(watch.recoveryAttempts,0);
    video.readyState=0;watch.autoplay=true;assert.equal(watch.initialMediaPending(),true,'missing metadata still has a deadline even when playback is paused or blocked');
  }],
  ['missing metadata and explicitly requested frames each get a full 60-second deadline',async()=>{
    for(const mode of ['metadata','explicit','native']){
      const {watch,room,video,reloads}=playbackFixture({host:true,nativePlayer:mode==='native'});room.room.playback.playing=false;video.paused=true;video.readyState=mode==='metadata'?0:1;watch.playbackStarted=false;
      if(mode!=='metadata')watch.beginSeek(60);
      now+=31000;await watch.pulse();assert.equal(reloads.length,0,mode+': initial seek must not use the 30-second post-frame deadline');
      now=61000;await watch.recoverPlayback();assert.equal(reloads.length,0,mode+': the full 60 seconds is allowed');
      now++;await watch.recoverPlayback();assert.equal(reloads.length,1,mode+': an unrendered initial frame has a finite deadline');
    }
  }],
  ['waiting for host buffering never consumes a member recovery budget',async()=>{
    const {watch,room,video,reloads}=playbackFixture();room.room.playback.buffering=true;watch.recoveryAttempts=1;await watch.follow();assert.equal(video.paused,true);
    for(let i=0;i<4;i++){now+=20000;await watch.recoverPlayback();}
    assert.equal(reloads.length,0);assert.equal(watch.recoveryAttempts,1);assert.equal(watch.error,'');
    room.room.playback.buffering=false;room.room.playback.at=now;await watch.follow();await watch.recoverPlayback();assert.equal(reloads.length,0,'resuming after a long host buffer gets a fresh progress window');
  }],
  ['resuming after a long pause does not inherit an expired stall clock',async()=>{
    const {watch,room,video,reloads}=playbackFixture({host:true});await watch.follow();room.room.playback.playing=false;await watch.follow();now+=90000;
    room.room.playback.playing=true;room.room.playback.at=now;video.play=()=>Promise.resolve();await watch.follow();await watch.recoverPlayback();assert.equal(reloads.length,0);
    now+=12001;await watch.recoverPlayback();assert.equal(reloads.length,1,'the resume grace must not disable genuine stall recovery');
  }],
  ['seek timeouts preserve the host target in state, save and retry',async()=>{
    for(const nativePlayer of [false,true]){
      const {watch,room,video,reloads}=playbackFixture({host:true,nativePlayer});room.room.playback.playing=false;video.paused=true;watch.beginSeek(90);
      now+=(nativePlayer?30000:60000)+1;await watch.pulse();
      assert.equal(watch.pendingSeek,null);assert.equal(room.room.playback.position,90);assert.equal(watch.current(),90,'failed playback cannot expose its old decoder position');assert.match(watch.error,/跳转加载超时/);assert.equal(watch.canSample(),false);
      watch.remember=true;watch.ownedSource={...watch.access};await watch.saveHost();assert.equal(watch.saved.playback.position,90);
      now+=3001;await watch.recoverPlayback();assert.equal(reloads.length,1);assert.equal(reloads[0].position,90);
    }
  }],
  ['late play promises cannot alter autoplay for a replacement generation',async()=>{
    for(const method of ['follow','unlockMedia'])for(const reject of [false,true]){
      const {watch,video}=playbackFixture();video.paused=true;let resolvePlay,rejectPlay;video.play=()=>new Promise((resolve,reject)=>{resolvePlay=resolve;rejectPlay=reject;});
      const pending=watch[method]();watch.generation++;watch.url='http://fixture.invalid/replacement.mp4';watch.autoplay=!reject;
      if(reject)rejectPlay(Object.assign(Error('blocked old request'),{name:'NotAllowedError'}));else resolvePlay();
      await pending;await Promise.resolve();await Promise.resolve();assert.equal(watch.autoplay,!reject,method+': the old promise must not update the new source');
    }
  }],
  ['recovery remains bounded and rearms only after three consecutive healthy advances',async()=>{
    const {watch,video,reloads}=playbackFixture();watch.error='network';watch.recoverAt=now;
    await watch.recoverPlayback();watch.recoverAt=now;await watch.recoverPlayback();watch.recoverAt=now;await watch.recoverPlayback();assert.equal(reloads.length,2);assert.equal(watch.recoveryAttempts,2);
    watch.error='';watch.recoverAt=0;
    const sample=async advance=>{now+=1000;video.currentTime+=advance;await watch.recoverPlayback();};
    await sample(1);await sample(1);assert.equal(watch.recoveryAttempts,2,'two samples are insufficient');
    await sample(0);assert.equal(watch.progressSamples,0,'a non-advancing sample breaks the streak');
    await sample(1);watch.buffering=true;await sample(1);watch.buffering=false;assert.equal(watch.progressSamples,0,'buffering also breaks the streak');
    await sample(1);await sample(1);assert.equal(watch.recoveryAttempts,2);await sample(1);assert.equal(watch.recoveryAttempts,0);
  }],
  ['a new epoch resets recovery while a same-epoch reload keeps its budget',async()=>{
    const {watch,room}=playbackFixture();delete watch.reload;Object.assign(watch,{stopMedia:async()=>{},checkin:async()=>{},loadSubtitles:async()=>{},follow:async()=>{},recoveryAttempts:2});
    globalThis.fetch=async()=>new Response(JSON.stringify({PlaySessionId:'fixture',MediaSources:[{Id:'source',Container:'mp4',SupportsDirectPlay:true,DirectStreamUrl:'/video.mp4',MediaStreams:[{Type:'Video',Codec:'h264'},{Type:'Audio',Codec:'aac'}]}]}));
    room.room.playback={...room.room.playback,epoch:'next'};await watch.load(room.room.playback);assert.equal(watch.epoch,'next');assert.equal(watch.recoveryAttempts,0);assert.equal(watch.error,'');
    watch.recoveryAttempts=2;await watch.load(room.room.playback);assert.equal(watch.recoveryAttempts,2,'automatic same-epoch reload must not create an unlimited budget');
  }]
];
try{for(const [name,test] of edges){await test();console.log('PASS '+name);}}
finally{globalThis.performance=original.performance;globalThis.fetch=original.fetch;if(original.localStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=original.localStorage;}
const saved=cleanWatchSave({version:1,source:{base:'https://fixture.invalid',userId:'user',token:'test-only'},playback:{itemId:'episode',seriesId:'series',seriesName:'series',season:2,episode:3}});
assert.equal(saved.playback.seriesId,'series');assert.equal(saved.playback.episode,3);
// Network reconnection rearms one playback attempt only after a fresh host
// snapshot. The member never publishes its stalled local position as authority.
const resumed=[],member={host:false,self:'guest',room:{game:'watch',hostId:'host',playback:{epoch:'same',position:10,version:1}},client:{ready:true,generation:1},context:()=>1,current:()=>true};
const recovering=Object.assign(Object.create(WatchRoom.prototype),{room:member,epoch:'same',voice:{event(){}},requestSync(){},load:async s=>resumed.push({...s}),render(){},failedEpoch:'same',recoveryAttempts:2});
await recovering.event({type:'joined'});member.client.generation=2;await recovering.event({type:'joined'});
assert.equal(resumed.length,0,'wait for the host before resuming');
await recovering.event({type:'watch.state',from:'host',body:{epoch:'same',itemId:'film',position:85,duration:100,playing:true,version:2,rate:1,at:performance.now()}});
assert.equal(resumed.length,1);assert.equal(resumed[0].position,85);assert.equal(recovering.failedEpoch,'');
await recovering.control(true,3);assert.equal(member.room.playback.position,85,'member cannot overwrite the host clock');
await recovering.event({type:'watch.state',from:'host',body:{epoch:'same',position:12,version:1}});assert.equal(member.room.playback.position,85,'stale same-epoch state is ignored');
console.log('PASS browser H.264 depth/profile; buffering clock; exactly-once next episode, last/stale episode, concurrent selection; HLS bounds; episode save; fresh-host reconnection; '+edges.length+' recovery boundary cases');
