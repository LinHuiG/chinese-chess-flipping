// Local-only acceptance: isolated Windows WebView2 and a debug Android emulator.
// CDP ports: Windows 19224, Android 19222. adb reverse tcp:18991 tcp:18991 for Emby.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createMockEmby}=require('./mock-emby.cjs');
(async()=>{
  const fixture=createMockEmby();await new Promise(resolve=>fixture.server.listen(18991,'127.0.0.1',resolve));
  const out=path.resolve(__dirname,'../server/target/native-watch-checks');fs.mkdirSync(out,{recursive:true});
  let desktop,android,browser;const errors=[],nativeEvents=[];
  try{
    desktop=await chromium.connectOverCDP('http://127.0.0.1:19224');android=await chromium.connectOverCDP('http://127.0.0.1:19222');
    try{browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});}catch{browser=await chromium.launch({headless:true,channel:'msedge',args:['--autoplay-policy=no-user-gesture-required']});}
    const host=desktop.contexts()[0].pages()[0],guest=android.contexts()[0].pages()[0],web=await browser.newPage({viewport:{width:900,height:1000}}),pages=[host,guest,web];
    for(const p of pages){p.setDefaultTimeout(25000);p.on('pageerror',e=>errors.push(e.message));}
    await web.goto('http://127.0.0.1:18880');
    for(const p of [host,guest]){
      await p.evaluate(()=>{window.__qaEvents=[];window.addEventListener('native-room',e=>{const v=e.detail;if(['player','peer','peerPacket','voiceStatus'].includes(v.type)){window.__qaEvents.push(v);if(window.__qaEvents.length>1000)window.__qaEvents.shift();}});});
    }
    await Promise.all(pages.map(p=>p.locator('#lobby').waitFor({state:'visible'})));
    assert.equal(await host.evaluate(()=>JSON.parse(NativeRoom.settings()).platform),'WINDOWS');
    assert.equal(await guest.evaluate(()=>!!NativeRoom.playerCommand),true);
    await host.click('[data-create=watch]');await host.fill('#room-name','Windows + Android + Web');await host.click('#create-submit');await host.locator('#watch').waitFor({state:'visible'});
    await host.click('#watch-source');await host.fill('#emby-base','http://127.0.0.1:18991');await host.fill('#emby-user','viewer');await host.fill('#emby-password','local-test');await host.check('#emby-share');await host.click('#emby-connect');
    await host.locator('#emby-items button').filter({hasText:'本地同步观影样片'}).click();await host.waitForFunction(()=>document.querySelector('#watch-video').readyState>=2);
    await host.click('#watch-join');if((await host.textContent('#watch-play')).trim()==='播放')await host.click('#watch-play');
    for(const p of [guest,web]){await p.click('#refresh');await p.locator('.room-card').filter({hasText:'Windows + Android + Web'}).click();await p.locator('#watch').waitFor({state:'visible'});await p.click('#watch-join');}
    await guest.waitForFunction(()=>window.__qaEvents.some(e=>e.type==='player'&&e.durationMs>=110000&&e.renderedFirstFrame&&!e.buffering&&!e.recovering&&!e.error));
    await web.waitForFunction(()=>document.querySelector('#watch-video').readyState>=2);
    for(const p of [host,guest]){await p.click('#watch-fullscreen');await p.waitForFunction(()=>document.fullscreenElement?.id==='watch-stage');await p.evaluate(()=>document.exitFullscreen());}
    if(process.env.ADB){
      await guest.click('#watch-fullscreen');await guest.waitForFunction(()=>document.fullscreenElement?.id==='watch-stage');
      require('node:child_process').execFileSync(process.env.ADB,['-s','emulator-5554','shell','input','-d','0','keyevent','KEYCODE_BACK']);
      await guest.waitForFunction(()=>!document.fullscreenElement);assert.ok(await guest.locator('#watch').isVisible(),'Back exits fullscreen without leaving the room');
    }
    if((await host.textContent('#watch-play')).trim()!=='播放')await host.click('#watch-play');
    await host.locator('#watch-seek').evaluate(el=>{el.value='30';el.dispatchEvent(new Event('change',{bubbles:true}));});
    await guest.waitForFunction(()=>{const p=window.__qaEvents.filter(e=>e.type==='player').at(-1);return p&&!p.playing&&Math.abs(p.positionMs-30000)<2000;});
    await web.waitForFunction(()=>Math.abs(document.querySelector('#watch-video').currentTime-30)<2&&document.querySelector('#watch-video').paused);
    // Exchange real authenticated UDP frames in both directions, without using a microphone.
    for(const p of [host,guest])await p.waitForFunction(()=>window.__qaEvents.some(e=>e.type==='peer'&&e.ready));
    for(const [sender,receiver] of [[host,guest],[guest,host]]){
      assert.ok(await sender.evaluate(async()=>{const {packet,base64,nativeCall}=await import('./transport.js');const peer=window.__qaEvents.filter(e=>e.type==='peer'&&e.ready).at(-1).peerId;return await nativeCall('sendPeer',peer,base64(packet(64,{type:'qa.interop'},new Uint8Array([0,42,255]))));}));
      await receiver.waitForFunction(()=>window.__qaEvents.some(e=>e.type==='peerPacket'));
      assert.equal(await receiver.evaluate(async()=>{const {decode,unbase64}=await import('./transport.js');return window.__qaEvents.filter(e=>e.type==='peerPacket').some(e=>{const p=decode(unbase64(e.data));return p.control.type==='qa.interop'&&Array.from(p.rawBody).join(',')==='0,42,255';});}),true);
    }
    await guest.fill('#danmaku-text','安卓原生播放器已同步');await guest.locator('#danmaku-form button').click();await host.locator('#danmaku').getByText('安卓原生播放器已同步',{exact:false}).waitFor();
    await host.screenshot({path:path.join(out,'windows-watch.png'),fullPage:true});await guest.screenshot({path:path.join(out,'android-web-layer.png'),fullPage:true});
    if(process.env.ADB)fs.writeFileSync(path.join(out,'android-watch.png'),require('node:child_process').execFileSync(process.env.ADB,['-s','emulator-5554','exec-out','screencap','-p'],{maxBuffer:8*1024*1024}));
    for(const p of [host,guest])nativeEvents.push(await p.evaluate(()=>window.__qaEvents));
    assert.equal(nativeEvents[1].filter(e=>e.type==='player'&&e.error).length,0,'Android must render video without a terminal playback error');
    assert.ok(!(await guest.textContent('#watch-message')).includes('无法读取'),'Native playback must not merely report a timeline while showing an error');
    assert.ok(fixture.events.filter(e=>e.event==='playbackInfo').length>=3);assert.ok(fixture.events.filter(e=>e.event==='video').length>=3);
    await host.locator('#watch .leave').click();await host.click('#confirm-ok');await Promise.all(pages.map(p=>p.locator('#lobby').waitFor({state:'visible'})));
    const stopDeadline=Date.now()+2500;while(Date.now()<stopDeadline&&fixture.events.filter(e=>e.event==='/Sessions/Playing/Stopped').length<3)await new Promise(r=>setTimeout(r,100));
    assert.ok(fixture.events.filter(e=>e.event==='/Sessions/Playing/Stopped').length>=3,'All native/browser sessions report Stopped on exit');
    assert.deepEqual(errors,[]);
    const report={nativeEvents,pageErrors:errors,playbackSessions:fixture.events.filter(e=>e.event==='playbackInfo').length};fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));
    console.log('PASS Windows TCP + Android TCP + browser: native bridge, independent media requests, native Android playback, fullscreen, pause/seek, danmaku, two-way authenticated UDP, host dissolution and terminal media reports');
  }catch(e){for(const [name,b] of [['windows',desktop],['android',android]])await b?.contexts()[0].pages()[0]?.screenshot({path:path.join(out,name+'-failure.png'),fullPage:true}).catch(()=>{});throw e;}
  finally{await browser?.close();await desktop?.close();await android?.close();await new Promise(resolve=>fixture.server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
