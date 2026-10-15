// Local Rust 18880/18888 + isolated source-built PC CDP19224.
// PC must set CYBER_ROOM_MEDIA_DIAGNOSTICS=1. Only the web synthetic microphone opens.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{let browser,desktop,pc,web,created=false;const errors=[];try{
  desktop=await chromium.connectOverCDP(process.env.PC_CDP||'http://127.0.0.1:19224');
  pc=desktop.contexts()[0].pages().find(p=>p.url().includes('tauri.localhost'));assert.ok(pc,'isolated PC WebView required');
  if(await pc.locator('#connect').isVisible())await pc.click('#connect');
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
  const context=await browser.newContext({permissions:['microphone']});
  await context.addInitScript(()=>{
    window.__voiceNodes=[];const Node=AudioWorkletNode;window.AudioWorkletNode=class extends Node{constructor(...args){super(...args);window.__voiceNodes.push(this);}};
    const acquire=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async options=>window.__micMedia=await acquire(options);
  });
  web=await context.newPage();await web.goto(process.env.CHESS_WEB_URL||'http://127.0.0.1:18880');
  for(const page of [pc,web]){page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.locator('#lobby').waitFor({state:'visible'});}
  await pc.evaluate(()=>{window.__voiceStatus=[];window.__voiceListener=e=>{if(e.detail.type==='voiceStatus'){window.__voiceStatus.push(e.detail);if(window.__voiceStatus.length>60)window.__voiceStatus.shift();}};window.addEventListener('native-room',window.__voiceListener);});
  const name='语音暂停恢复验收 '+Date.now();await pc.click('[data-create=watch]');await pc.fill('#room-name',name);await pc.click('#create-submit');created=true;await pc.locator('#watch').waitFor({state:'visible'});
  await web.click('#refresh');await web.locator('.room-card').filter({hasText:name}).click();await web.locator('#watch').waitFor({state:'visible'});
  await web.click('#watch-mic');await web.waitForFunction(()=>document.querySelector('#watch-mic').textContent==='关闭麦克风'&&window.__voiceNodes.at(-1)?.context.state==='running');
  await pc.waitForFunction(()=>{const s=window.__voiceStatus.at(-1);return s?.playing&&!s.microphone&&s.playedFrames>=10&&s.outputPeak>.001&&s.peers?.some(p=>p.received>=10);});
  const before=await pc.evaluate(()=>window.__voiceStatus.at(-1)),track=await web.evaluate(()=>window.__micMedia.getAudioTracks()[0].id);
  await web.evaluate(()=>window.__voiceNodes.at(-1).context.suspend());await delay(850);
  await web.click('#watch-join');
  await pc.waitForFunction(before=>{const s=window.__voiceStatus.at(-1);return s?.playing&&!s.microphone&&s.playedFrames>=before.playedFrames+12&&s.peers?.some(p=>p.stream!==before.peers[0].stream&&p.received>=before.peers[0].received+12);},before);
  const after=await pc.evaluate(()=>window.__voiceStatus.at(-1));
  assert.equal(await web.evaluate(()=>window.__micMedia.getAudioTracks()[0].id),track,'no microphone close/open');assert.equal(await web.locator('#watch-mic').textContent(),'关闭麦克风');assert.deepEqual(errors,[]);
  const result={result:'PASS Web synthetic capture → PC native output before/after AudioContext suspension; same microphone track; new CRV1 stream, continued native playout; no PC microphone opened',before,after,pageErrors:errors};
  const output=path.resolve(__dirname,'../server/target/voice-pc-resume');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
  if(created&&pc){await pc.evaluate(()=>window.cyberDisconnect?.()).catch(()=>{});}
  await pc?.evaluate(()=>{window.removeEventListener('native-room',window.__voiceListener);delete window.__voiceListener;}).catch(()=>{});
  await browser?.close();await desktop?.close();
}})().catch(e=>{console.error(e);process.exitCode=1;});
