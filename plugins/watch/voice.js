import {asset,native,nativeCall,call,onHostEvent} from '../../plugin_sdk/transport.js';
export const VOICE_CODEC='ima-adpcm-16k-v1';
const STEPS=[7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767], INDEX=[-1,-1,-1,-1,2,4,6,8];
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export function encodeVoice(samples,stream,seq,index=0,clock=(seq*320)>>>0){
  if(samples.length!==320)throw Error('语音帧长度无效');
  const bytes=new Uint8Array(180),v=new DataView(bytes.buffer);bytes.set([67,82,86,49]);
  v.setUint32(4,stream,true);v.setUint32(8,seq,true);v.setUint32(12,clock,true);
  let predictor=clamp(Math.round(samples[0]*32767),-32768,32767);v.setInt16(16,predictor,true);bytes[18]=index;
  for(let i=1;i<320;i++){
    const sample=clamp(Math.round(samples[i]*32767),-32768,32767),step=STEPS[index];let diff=sample-predictor,code=diff<0?8:0;diff=Math.abs(diff);let delta=step>>3;
    if(diff>=step){code|=4;diff-=step;delta+=step;}if(diff>=step>>1){code|=2;diff-=step>>1;delta+=step>>1;}if(diff>=step>>2){code|=1;delta+=step>>2;}
    predictor=clamp(predictor+(code&8?-delta:delta),-32768,32767);index=clamp(index+INDEX[code&7],0,88);
    bytes[20+((i-1)>>1)]|=code<<(((i-1)&1)*4);
  }
  return {bytes,index};
}
export function decodeVoice(bytes){
  if(bytes.length!==180||bytes[0]!==67||bytes[1]!==82||bytes[2]!==86||bytes[3]!==49||bytes[18]>88||bytes[19])throw Error('语音格式不支持');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),samples=new Float32Array(320);let predictor=v.getInt16(16,true),index=bytes[18];samples[0]=predictor/32768;
  for(let i=1;i<320;i++){const code=bytes[20+((i-1)>>1)]>>(((i-1)&1)*4)&15,step=STEPS[index];let delta=step>>3;if(code&4)delta+=step;if(code&2)delta+=step>>1;if(code&1)delta+=step>>2;predictor=clamp(predictor+(code&8?-delta:delta),-32768,32767);index=clamp(index+INDEX[code&7],0,88);samples[i]=predictor/32768;}
  return {samples,stream:v.getUint32(4,true),seq:v.getUint32(8,true),clock:v.getUint32(12,true)};
}
export class RoomVoice{
  constructor(room,changed){this.room=room;this.changed=changed;this.microphone=false;this.micGeneration=0;this.status='点击开启语音收听';this.received=new Map();this.directLimit=5;this.badUntil=new Map();onHostEvent((name,value)=>{if(name==='audio-input'){if(value.stopped){this.microphone=false;this.changed();}else this.capture(value);}});}
  capture(frame){const age=performance.timeOrigin+performance.now()-frame.capturedAt;if(!Number.isFinite(age)||age< -100||age>200)return;this.encodeCapture(frame,frame.capturedAt-performance.timeOrigin);}
  async configure(){
    const r=this.room.room;if(!r||r.game!=='watch'){this.stop();return;}
    const now=performance.now(),targets=r.members.filter(p=>p.id!==this.room.self).map(p=>p.id);
    const direct=targets.filter(id=>{const q=this.room.client.peerQuality.get(id);if(!q?.ready||q.loss>0.15||q.jitter>80||q.queuedMs>120){this.badUntil.set(id,now+5000);return false;}return (this.badUntil.get(id)||0)<now;}).slice(0,this.directLimit);
    const config={roomId:r.roomId,selfId:this.room.self,members:targets,directTargets:direct,enabled:!this.room.background,codec:VOICE_CODEC};
    const key=JSON.stringify(config);if(key===this.key)return;this.key=key;
    if(native?.voiceConfigure)await nativeCall('voiceConfigure',key);
  }
  async listen(){
    if(this.room.room?.game!=='watch'||this.room.background)return;
    if(native?.voiceConfigure){await this.configure();return;}
    // Resume in the gesture's stack, including when the worklet is still loading.
    // Awaiting addModule first can lose browser activation on a cold first visit.
    if(this.context)this.context.resume().catch(()=>{});
    if(this.listening)return this.listening;
    const opening=this.openAudio();this.listening=opening;try{await opening;}finally{if(this.listening===opening)this.listening=null;}
  }
  async openAudio(){
    if(this.context){await this.context.resume();return;}
    const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Audio)throw Error('此设备暂不支持语音，仍可观看和发弹幕');
    const context=this.room.context(),audio=this.context=new Audio();
    audio.onstatechange=()=>{if(this.context!==audio)return;this.captureTiming=null;this.node?.port.postMessage({clear:true});this.status=audio.state==='running'?'语音已开启 · 外放开麦建议佩戴耳机':'语音已暂停，点击页面恢复收听';this.changed();};
    const resumed=audio.resume();resumed.catch(()=>{});
    try{await audio.audioWorklet.addModule(asset('voice-worklet.js'));
      if(this.context!==audio||!this.room.current(context)){if(this.context===audio)this.context=null;await audio.close();return;}
      this.node=new AudioWorkletNode(audio,'room-voice');this.node.connect(audio.destination);
      await resumed;if(this.context!==audio)return;this.status='语音已开启 · 外放开麦建议佩戴耳机';this.changed();
    }catch(e){if(this.context===audio){this.node?.disconnect();this.node=this.context=null;}await audio.close().catch(()=>{});throw e;}
  }
  encodeCapture(frame,at){
    if(!this.microphone||frame.generation!==this.micGeneration||!this.room.client.ready||this.room.room?.game!=='watch'||!Number.isFinite(frame.at))return;
    const timing=this.captureTiming;
    if(!timing||frame.at<timing.audio||Math.abs((at-timing.wall)-(frame.at-timing.audio)*1000)>120){
      this.captureTiming={audio:frame.at,wall:at};this.stream=crypto.getRandomValues(new Uint32Array(1))[0];this.sequence=0;this.index=0;
    }
    const clock=Math.round((frame.at-this.captureTiming.audio)*16000)>>>0,result=encodeVoice(frame.samples,this.stream,this.sequence++,this.index,clock);this.index=result.index;
    Promise.resolve(this.room.client.broadcast(this.room.room.roomId,undefined,{type:'voice',codec:VOICE_CODEC,discard:1,maxAgeMs:200},result.bytes)).catch(()=>{});
  }
  async microphoneToggle(){
    if(this.microphone||this.openingMic){await this.mute();return;}
    if(this.room.room?.game!=='watch'||this.room.background||!this.room.client.ready)return;
    const context=this.room.context(),generation=++this.micGeneration,valid=()=>generation===this.micGeneration&&this.room.current(context)&&!this.room.background&&this.room.client.ready;this.openingMic=true;
    try{
      if(native?.voiceMicrophone){await this.configure();if(valid())await nativeCall('voiceMicrophone',true);return;}
      await this.listen();if(!valid()||!this.context||!this.node)return;
      const started=await call('microphone.start',generation);
      if(!valid()||!started){await call('microphone.stop');return;}
      this.captureTiming=null;this.microphone=true;this.changed();
    }finally{if(generation===this.micGeneration)this.openingMic=false;}
  }
  async mute(){this.micGeneration++;this.openingMic=false;this.microphone=false;if(native)await nativeCall('voiceMicrophone',false);else await call('microphone.stop').catch(()=>{});this.changed();}
  receive(from,bytes){
    if(native||!this.node||this.context?.state!=='running'||this.room.background)return;
    try{const frame=decodeVoice(bytes),now=performance.now();let old=this.received.get(from);
      if(!old||old.stream!==frame.stream){if(old?.retired.has(frame.stream))return;const retired=old?.retired||new Set();if(old)retired.add(old.stream);if(retired.size>8)retired.delete(retired.values().next().value);old={stream:frame.stream,seq:(frame.seq-1)>>>0,anchorClock:frame.clock,anchorAt:now,retired};this.received.set(from,old);}
      const delta=(frame.seq-old.seq)>>>0;if(!delta||delta>0x7fffffff)return;old.seq=frame.seq;
      const sampleDelta=(frame.clock-old.anchorClock)>>>0;if(sampleDelta>0x7fffffff||now>old.anchorAt+sampleDelta/16+200)return;
      // Refresh the anchor without changing its time mapping, keeping u32 wrap safe.
      if(sampleDelta>16000*60){old.anchorClock=frame.clock;old.anchorAt+=sampleDelta/16;}
      this.node.port.postMessage({from,samples:frame.samples},[frame.samples.buffer]);
    }catch{}
  }
  event(e){if(e.type!=='voiceStatus')return;if(typeof e.microphone==='boolean')this.microphone=e.microphone;if(Number.isInteger(e.suggestedDirectLimit)&&clamp(e.suggestedDirectLimit,0,5)!==this.directLimit){this.directLimit=clamp(e.suggestedDirectLimit,0,5);this.key='';this.configure();}this.status=e.error||(!e.available?'此设备语音不可用，仍可观看和发弹幕':e.aec==='headphones'?'耳机语音':e.aec===true||e.aec==='system-unverified'?'系统回声处理已开启，外放效果取决于设备':'未提供回声处理，外放开麦建议佩戴耳机');this.changed();}
  stop(){this.mute();nativeCall('voiceStop').catch(()=>{});this.node?.disconnect();this.context?.close().catch(()=>{});this.node=this.context=null;this.listening=null;this.key='';this.received.clear();this.status='点击开启语音收听';}
}
