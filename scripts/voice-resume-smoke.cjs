// Real browser AudioWorklet + synthetic microphone; no external server/account.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'../server/src/main/resources/web');
const html=`<!doctype html><button id="start">Start</button><button id="resume">Resume</button><script type="module">
import {RoomVoice,decodeVoice} from '/voice.js';
const room={room:{game:'watch',roomId:'local-fixture'},background:false,context:()=>1,current:n=>n===1,client:{ready:true}};
window.frames=[];window.received=0;window.error='';
window.receiver=new RoomVoice(room,()=>{});window.sender=new RoomVoice({...room,client:{ready:true,broadcast:(room,to,headers,bytes)=>{const f=decodeVoice(bytes);frames.push({stream:f.stream,seq:f.seq,clock:f.clock});receiver.receive('sender',bytes);}}},()=>{});
document.querySelector('#start').onclick=async()=>{try{await Promise.all([receiver.listen(),sender.microphoneToggle()]);const post=receiver.node.port.postMessage.bind(receiver.node.port);receiver.node.port.postMessage=(m,...rest)=>{if(m.samples)received++;return post(m,...rest);};window.analyser=receiver.context.createAnalyser();receiver.node.connect(analyser);window.ready=true;}catch(e){error=String(e);}};
document.querySelector('#resume').onclick=()=>sender.listen().catch(e=>error=String(e));
</script>`;
const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
  const file=req.url?.slice(1);if(!['voice.js','voice-worklet.js','transport.js'].includes(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type','application/javascript');res.end(fs.readFileSync(path.join(root,file)));
});
(async()=>{let browser;try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
  const context=await browser.newContext({permissions:['microphone']}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.click('#start');
  await page.waitForFunction(()=>window.ready&&received>=12);
  const initial=await page.evaluate(()=>({stream:frames.at(-1).stream,received,track:sender.media.getAudioTracks()[0].id}));
  await page.evaluate(()=>sender.context.suspend());await new Promise(r=>setTimeout(r,850));
  const before=await page.evaluate(()=>received);await page.click('#resume');
  await page.waitForFunction(n=>received>=n+12,before);
  const resumed=await page.evaluate(()=>{const values=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(values);return {stream:frames.at(-1).stream,received,microphone:sender.microphone,track:sender.media.getAudioTracks()[0].id,state:sender.context.state,peak:Math.max(...values.map(Math.abs)),error};});
  assert.notEqual(resumed.stream,initial.stream);assert.equal(resumed.track,initial.track,'same microphone track survives without close/open');assert.equal(resumed.microphone,true);assert.equal(resumed.state,'running');assert.equal(resumed.error,'');
  await page.waitForFunction(()=>{const values=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(values);return values.some(v=>Math.abs(v)>.001);});
  assert.deepEqual(errors,[]);await page.evaluate(()=>{sender.stop();receiver.stop();});
  console.log(JSON.stringify({result:'PASS real AudioWorklet suspend/resume: same microphone, fresh stream, resumed decoded packets and nonzero output PCM',initial,resumed}));
}finally{await browser?.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;});
