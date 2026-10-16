export class Microphone {
  constructor(deliver){this.deliver=deliver;this.generation=0;}
  async start(token=0){
    this.stop();const generation=this.generation;
    if(document.hidden||!navigator.mediaDevices?.getUserMedia)throw Error('开麦需要 HTTPS、麦克风权限及前台页面');
    const audio=this.audio=new AudioContext();audio.resume().catch(()=>{});
    let media;
    try{
      media=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1},video:false});
      if(generation!==this.generation){media.getTracks().forEach(t=>t.stop());return false;}
      this.media=media;await audio.audioWorklet.addModule('./microphone-worklet.js');
      if(generation!==this.generation)return false;
      this.node=new AudioWorkletNode(audio,'microphone-input');this.source=audio.createMediaStreamSource(media);this.source.connect(this.node);this.node.connect(audio.destination);
      this.node.port.onmessage=e=>{const age=audio.currentTime-e.data.at;if(generation===this.generation&&audio.state==='running'&&age<.2&&age>-.1)this.deliver({...e.data,generation:token,capturedAt:performance.timeOrigin+performance.now()-Math.max(0,age)*1000},[e.data.samples.buffer]);};
      for(const track of media.getTracks())track.onended=()=>{if(generation===this.generation){this.stop();this.deliver({stopped:true});}};
      await audio.resume();return generation===this.generation;
    }catch(e){if(generation===this.generation)this.stop();else media?.getTracks().forEach(t=>t.stop());throw e;}
  }
  stop(){this.generation++;this.media?.getTracks().forEach(t=>t.stop());this.source?.disconnect();this.node?.disconnect();this.audio?.close().catch(()=>{});this.media=this.source=this.node=this.audio=null;}
}
