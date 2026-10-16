// Browser-only sample transfer. Native clients keep capture, codec and packets off the JS bridge.
class RoomVoiceProcessor extends AudioWorkletProcessor {
  constructor(){super();this.peers=new Map();this.port.onmessage=e=>{const m=e.data;if(m.clear){this.peers.clear();}if(m.samples){let p=this.peers.get(m.from);if(!p){p={queue:[],frame:null,offset:0,phase:0};this.peers.set(m.from,p);}if(p.queue.length>=6)p.queue.splice(0,p.queue.length-2);p.queue.push(m.samples);}};}
  process(inputs,outputs){
    const output=outputs[0]?.[0];if(!output)return true;
    for(const p of this.peers.values())for(let i=0;i<output.length;i++){
      if(!p.frame){p.frame=p.queue.shift();p.offset=0;if(!p.frame)break;}
      output[i]+=p.frame[p.offset];p.phase+=16000;while(p.phase>=sampleRate){p.phase-=sampleRate;p.offset++;if(p.offset>=p.frame.length){p.frame=p.queue.shift();p.offset=0;if(!p.frame)break;}}
    }
    for(let i=0;i<output.length;i++)output[i]=Math.max(-1,Math.min(1,output[i]));return true;
  }
}
registerProcessor('room-voice',RoomVoiceProcessor);
