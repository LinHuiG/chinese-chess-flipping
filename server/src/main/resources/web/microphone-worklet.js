// Raw PCM capture is a host device capability. Encoding and routing belong to plugins.
class MicrophoneInput extends AudioWorkletProcessor {
  constructor(){super();this.frame=new Float32Array(320);this.offset=0;this.phase=0;}
  process(inputs){const input=inputs[0]?.[0];if(input)for(let i=0;i<input.length;i++){this.phase+=16000;if(this.phase>=sampleRate){this.phase-=sampleRate;this.frame[this.offset++]=input[i];if(this.offset===320){this.port.postMessage({samples:this.frame,at:currentTime+(i+1)/sampleRate},[this.frame.buffer]);this.frame=new Float32Array(320);this.offset=0;}}}else this.offset=this.phase=0;return true;}
}
registerProcessor('microphone-input',MicrophoneInput);
