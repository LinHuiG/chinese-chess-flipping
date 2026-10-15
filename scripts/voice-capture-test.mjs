import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {RoomVoice,decodeVoice} from '../server/src/main/resources/web/voice.js';

const original=Object.getOwnPropertyDescriptor(globalThis,'performance');
let now=1000;
Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>now}});
const samples=Float32Array.from({length:320},(_,i)=>Math.sin(i/10)*.25),sent=[],played=[];
const room={room:{game:'watch',roomId:'capture-test'},client:{ready:true,broadcast:(_room,_to,_headers,bytes)=>{sent.push(decodeVoice(bytes));receiver.receive('speaker',bytes);}}};
const receiver=new RoomVoice(room,()=>{}),sender=new RoomVoice(room,()=>{});
receiver.context={state:'running'};receiver.node={port:{postMessage:frame=>played.push(frame)}};
const audio=sender.context={state:'running',currentTime:.02};sender.microphone=true;sender.micGeneration=3;
const frame=at=>sender.captureFrame(audio,{samples,at,generation:3});
try{
  frame(.02);const first=sent[0].stream;
  now+=20;audio.currentTime=.04;frame(.04);
  assert.equal(sent[1].clock,320);assert.equal(played.length,2);
  // Input can stop while AudioContext keeps running (device/track interruption).
  now+=1000;audio.currentTime=1.04;frame(1.04);
  assert.equal(sent[2].stream,first);assert.equal(sent[2].clock,16320);
  assert.equal(played.length,3,'sample clock includes missing capture time, preventing permanent deadline rejection');
  // AudioContext suspension stops its clock, but receivers keep wall time.
  now+=1000;audio.currentTime=1.06;frame(1.06);
  assert.notEqual(sent[3].stream,first);assert.equal(sent[3].clock,0);
  assert.equal(played.length,4,'first resumed frame is accepted without toggling the microphone');
  now+=20;audio.currentTime=1.08;frame(1.08);assert.equal(played.length,5);
  const count=sent.length;
  sender.captureFrame(audio,{samples,at:1.08,generation:2});
  audio.currentTime=1.5;frame(1.08);
  assert.equal(sent.length,count,'old microphone generations and >200ms queued worklet frames stay discarded');
  // Replaying a retired stream must not restore its stale audio after recovery.
  assert.equal(receiver.received.get('speaker').retired.has(first),true);
}finally{Object.defineProperty(globalThis,'performance',original);}

let Processor;const output=[];
const scope=vm.createContext({Float32Array,Map,Math,sampleRate:16000,currentTime:0,
  AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>output.push(m)};}},
  registerProcessor:(_name,constructor)=>Processor=constructor});
vm.runInContext(await readFile(new URL('../server/src/main/resources/web/voice-worklet.js',import.meta.url),'utf8'),scope);
const worklet=new Processor(),input=new Float32Array(160).fill(.25),out=()=>[[new Float32Array(160)]];
worklet.port.onmessage({data:{capture:true,generation:3}});
worklet.process([[input]],out());scope.currentTime=.01;worklet.process([[input]],out());
assert.equal(output[0].generation,3);assert.equal(output[0].at,.02);
scope.currentTime=.02;worklet.process([[input]],out());worklet.process([],out());
scope.currentTime=1;worklet.process([[input]],out());
assert.equal(output.length,1,'a partial frame is discarded when microphone input disappears');
scope.currentTime=1.01;worklet.process([[input]],out());assert.equal(output[1].at,1.02);
worklet.port.onmessage({data:{from:'peer',samples}});assert.equal(worklet.peers.size,1);
worklet.port.onmessage({data:{clear:true}});assert.equal(worklet.peers.size,0);
console.log('PASS voice capture: device gap, suspended audio clock, resumed stream, retired generations, stale messages, actual frame timing, partial-frame and playback-queue reset');
