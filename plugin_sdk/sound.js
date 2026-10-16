export class Sound{
  constructor(){this.enabled=true;}
  unlock(){if(!this.enabled)return;try{this.context??=new (globalThis.AudioContext||globalThis.webkitAudioContext)();if(this.context.state==='suspended')this.context.resume();}catch{}}
  play(kind){
    if(!this.enabled)return;this.unlock();const c=this.context;if(!c||c.state!=='running')return;
    const notes=kind==='diamond'?[784,1047,1319]:kind==='gold'||kind==='bag'?[523,659,784]:kind==='finish'?[523,659,784,1047]:kind==='poop'?[180,130]:kind==='rock'?[110]:[380];
    notes.forEach((f,i)=>{const osc=c.createOscillator(),gain=c.createGain(),at=c.currentTime+i*.055;osc.type=kind==='rock'?'triangle':'sine';osc.frequency.setValueAtTime(f,at);gain.gain.setValueAtTime(.0001,at);gain.gain.exponentialRampToValueAtTime(.08,at+.012);gain.gain.exponentialRampToValueAtTime(.0001,at+.2);osc.connect(gain);gain.connect(c.destination);osc.start(at);osc.stop(at+.22);});
    if(kind==='blast'){const b=c.createBuffer(1,c.sampleRate*.25,c.sampleRate),data=b.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*(1-i/data.length);const src=c.createBufferSource(),gain=c.createGain();src.buffer=b;gain.gain.value=.12;src.connect(gain);gain.connect(c.destination);src.start();}
  }
}
