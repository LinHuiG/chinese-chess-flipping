import './plugin-test-host.mjs';
// Focused regressions for first-entry audio activation and native status feedback.
import assert from 'node:assert/strict';
import {RoomVoice,encodeVoice} from '../plugins/watch/voice.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
let lifecycle=0,gesture=false;
const room={room:{game:'watch'},client:{ready:true},context:()=>lifecycle,current:c=>c===lifecycle};
const contexts=[],nodes=[];
class Audio {
  constructor(){this.state='suspended';this.module=deferred();this.activation=deferred();this.resumes=[];this.audioWorklet={addModule:()=>this.module.promise};contexts.push(this);}
  resume(){this.resumes.push(gesture);if(gesture){this.state='running';this.activation.resolve();}return this.activation.promise;}
  async close(){this.state='closed';this.activation.resolve();}
}
globalThis.AudioContext=Audio;
globalThis.AudioWorkletNode=class {
  constructor(context){this.context=context;this.port={messages:[],postMessage:m=>this.port.messages.push(m)};nodes.push(this);}
  connect(){} disconnect(){this.disconnected=true;}
};
const voice=new RoomVoice(room,()=>{});
try{
  // A pre-existing suspended opening must be recoverable by the next gesture,
  // even while the worklet request remains in flight.
  const first=voice.listen(),audio=contexts[0];assert.deepEqual(audio.resumes,[false]);
  gesture=true;const repeated=voice.listen();gesture=false;
  assert.deepEqual(audio.resumes,[false,true]);audio.module.resolve();await Promise.all([first,repeated]);
  assert.equal(audio.state,'running');assert.equal(nodes.length,1);
  voice.stop();lifecycle++;
  gesture=true;const cold=voice.listen(),next=contexts[1];gesture=false;
  assert.deepEqual(next.resumes,[true],'resume runs before asynchronous module loading');
  voice.stop();lifecycle++;
  gesture=true;const replacement=voice.listen(),current=contexts[2];gesture=false;
  next.module.resolve();current.module.resolve();await Promise.all([cold,replacement]);
  assert.equal(voice.context,current,'old initialization cannot replace the new room audio graph');
  assert.equal(nodes.length,2,'a cancelled room does not create an audio node');
  current.state='suspended';voice.receive('peer',encodeVoice(new Float32Array(320),7,0).bytes);assert.equal(voice.received.size,0,'suspended audio must not anchor stale packets');
  current.state='running';voice.receive('peer',encodeVoice(new Float32Array(320),7,100).bytes);assert.equal(voice.node.port.messages.length,1);
  let configure=0;voice.configure=()=>{configure++;};
  for(let i=0;i<100;i++)voice.event({type:'voiceStatus',available:true,suggestedDirectLimit:5});
  assert.equal(configure,0,'stable status must not feed back into native configure');
  voice.event({type:'voiceStatus',available:true,suggestedDirectLimit:0});
  for(let i=0;i<100;i++)voice.event({type:'voiceStatus',available:true,suggestedDirectLimit:0});
  assert.equal(configure,1);voice.event({type:'voiceStatus',available:true,suggestedDirectLimit:5});assert.equal(configure,2);
  console.log('PASS watch voice: cold user gesture, in-flight unlock, cancelled initialization/reentry, suspended frame discard, bounded native status feedback');
}finally{voice.stop();delete globalThis.AudioContext;delete globalThis.AudioWorkletNode;}
