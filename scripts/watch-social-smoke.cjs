// Requires local Rust 18880/18888 and a debug Android WebView exposed on CDP 19222.
// Exercises real audio graphs/native capture/playout, with a synthetic browser microphone.
// This is not a hardware microphone, acoustic echo, or speaker listening-quality test.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  let browser,android,app,web,success=false;const errors=[],rounds=[],out=path.resolve(__dirname,'../server/target/watch-social-checks');fs.mkdirSync(out,{recursive:true});
  try{
    const options={headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']};
    try{browser=await chromium.launch(options);}catch{browser=await chromium.launch({...options,channel:'msedge'});}
    const context=await browser.newContext({permissions:['microphone'],viewport:{width:1000,height:900}});
    await context.addInitScript(()=>{
      window.__socialAudio=[];const Original=window.AudioWorkletNode;
      window.AudioWorkletNode=class extends Original {
        constructor(...args){super(...args);const observation={node:this,frames:0,peak:0};window.__socialAudio.push(observation);const post=this.port.postMessage.bind(this.port);this.port.postMessage=(message,...rest)=>{if(message.samples){observation.frames++;for(const sample of message.samples)observation.peak=Math.max(observation.peak,Math.abs(sample));}return post(message,...rest);};}
      };
    });
    // Deliberately cold loading; do not relax browser autoplay policy.
    await context.route('**/voice-worklet.js',async route=>{await delay(600);await route.continue();});
    web=await context.newPage();await web.goto(process.env.CHESS_WEB_URL||'http://127.0.0.1:18880');
    android=await chromium.connectOverCDP(process.env.ANDROID_CDP||'http://127.0.0.1:19222');
    app=android.contexts()[0].pages()[0];
    for(const p of [app,web]){p.setDefaultTimeout(20000);p.on('pageerror',e=>errors.push(e.message));await p.locator('#lobby').waitFor({state:'visible'});}
    await app.evaluate(()=>{window.__socialEvents=[];window.__socialStatusCount=0;window.addEventListener('native-room',e=>{if(e.detail.type==='voiceStatus')window.__socialStatusCount++;if(['voiceStatus','player'].includes(e.detail.type)){window.__socialEvents.push(e.detail);if(window.__socialEvents.length>120)window.__socialEvents.shift();}});});
    const latest=()=>window.__socialEvents.filter(e=>e.type==='voiceStatus').at(-1);
    async function permission(){
      if(!process.env.ADB)return;
      const adb=process.env.ADB,serial=process.env.ANDROID_SERIAL||'emulator-5554';
      for(let attempt=0;attempt<5;attempt++){
        if(await app.locator('#watch-mic').textContent()==='关闭麦克风')return;
        execFileSync(adb,['-s',serial,'shell','uiautomator','dump','/sdcard/cyber-social-permission.xml'],{stdio:'pipe',timeout:10000});
        const xml=execFileSync(adb,['-s',serial,'exec-out','cat','/sdcard/cyber-social-permission.xml'],{encoding:'utf8',timeout:10000});
        const node=xml.match(/<node\b[^>]*resource-id="[^"]*:id\/permission_allow_foreground_only_button"[^>]*>/)?.[0];
        const bounds=node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if(bounds){execFileSync(adb,['-s',serial,'shell','input','-d','0','tap',String((+bounds[1]+ +bounds[3])>>1),String((+bounds[2]+ +bounds[4])>>1)],{stdio:'pipe'});return;}
        await delay(250);
      }
    }
    for(let round=1;round<=3;round++){
      const host=round===2?web:app,guest=round===2?app:web,name='无片源语音弹幕验收 '+round;
      await app.evaluate(()=>{window.__socialEvents=[];window.__socialStatusCount=0;});
      await host.click('[data-create=watch]');await host.fill('#room-name',name);await host.click('#create-submit');await host.locator('#watch').waitFor({state:'visible'});
      await guest.click('#refresh');await guest.locator('.room-card').filter({hasText:name}).click();await guest.locator('#watch').waitFor({state:'visible'});
      await Promise.all([app,web].map(p=>p.waitForFunction(()=>document.querySelector('#watch-count').textContent==='2/6 人')));
      assert.ok(await web.locator('#watch-join').isEnabled(),'Listening is available before a film is selected');
      assert.equal(await web.locator('#watch-join').textContent(),'开启语音收听');
      await web.click('#watch-join');await web.click('#watch-mic');
      await web.waitForFunction(()=>document.querySelector('#watch-mic').textContent==='关闭麦克风'&&window.__socialAudio.at(-1)?.node.context.state==='running');
      // Closed-mic Android actually decodes and writes nonzero synthetic speech to AudioTrack.
      await app.waitForFunction(()=>{const s=window.__socialEvents.filter(e=>e.type==='voiceStatus').at(-1);return s?.playing&&!s.microphone&&s.playedFrames>=10&&s.outputPeak>100;});
      const beforeMic=await app.evaluate(latest);
      assert.ok(beforeMic.peers.some(p=>p.received>=10));
      await web.fill('#danmaku-text','未开片源 Web 到安卓 '+round);await web.locator('#danmaku-form button').click();
      await app.locator('#danmaku').getByText('未开片源 Web 到安卓 '+round,{exact:false}).waitFor({state:'attached'});
      await delay(2200);
      if(process.env.ADB)fs.writeFileSync(path.join(out,'android-no-source-'+round+'.png'),execFileSync(process.env.ADB,['-s',process.env.ANDROID_SERIAL||'emulator-5554','exec-out','screencap','-p'],{maxBuffer:8*1024*1024}));
      await app.fill('#danmaku-text','未开片源 安卓到 Web '+round);await app.locator('#danmaku-form button').click();
      await web.locator('#danmaku').getByText('未开片源 安卓到 Web '+round,{exact:false}).waitFor({state:'visible'});
      await app.click('#watch-mic');await permission();
      await app.waitForFunction(()=>{const s=window.__socialEvents.filter(e=>e.type==='voiceStatus').at(-1);return s?.microphone&&s.capturedFrames>=10;});
      await web.waitForFunction(()=>{const a=window.__socialAudio.at(-1);return a?.node.context.state==='running'&&a.frames>=10;});
      const native=await app.evaluate(latest),decoded=await web.evaluate(()=>{const a=window.__socialAudio.at(-1);return {frames:a.frames,peak:a.peak,state:a.node.context.state};}),statusCount=await app.evaluate(()=>window.__socialStatusCount);
      assert.ok(!native.error,native.error);assert.ok(statusCount<40,'native voiceStatus/configure must not form a feedback loop');
      assert.equal(await app.evaluate(()=>window.__socialEvents.some(e=>e.type==='player')),false,'No source must not instantiate a media player');
      for(const p of [app,web])assert.equal(await p.locator('#watch-video').getAttribute('src'),null);
      rounds.push({round,androidHost:host===app,native,decoded,statusCount});
      await app.click('#watch-mic');await web.click('#watch-mic');
      await host.locator('#watch .leave').click();await host.click('#confirm-ok');
      await Promise.all([app,web].map(p=>p.locator('#lobby').waitFor({state:'visible'})));
      assert.equal(await web.evaluate(()=>window.__socialAudio.at(-1).node.context.state),'closed','Leaving closes the old audio context');
      if(round===2){await web.reload();await web.locator('#lobby').waitFor({state:'visible'});}
    }
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({rounds,pageErrors:errors},null,2));success=true;
    console.log('PASS 3 no-source rounds (first entry, reentry, reload; both host roles): Web synthetic capture → Android nonzero AudioTrack writes; Android real capture → browser CRV1 decode/running graph; live chat both ways; bounded status; room/audio cleanup. Hardware audibility/AEC are not asserted.');
  }finally{
    if(!success)for(const p of [app,web])await p?.evaluate(()=>window.cyberDisconnect?.()).catch(()=>{});
    await browser?.close();await android?.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
