// Local-only acceptance: isolated Windows WebView2 and a debug Android emulator.
// CDP ports: Windows 19224, Android 19222. adb reverse tcp:18991 tcp:18991 for Emby.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createMockEmby}=require('./mock-emby.cjs');
(async()=>{
  const nativeTracks=!!process.env.FFMPEG;let file;
  if(nativeTracks){const dir=path.resolve(__dirname,'../server/target/watch-fixtures');file=path.join(dir,'native-tracks.mkv');const subtitle=path.join(dir,'native-tracks.srt');fs.writeFileSync(subtitle,'1\n00:00:00,000 --> 00:01:59,000\nNative embedded subtitle\n');require('node:child_process').execFileSync(process.env.FFMPEG,['-hide_banner','-loglevel','error','-y','-i',path.join(dir,'movie.mp4'),'-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-i',subtitle,'-t','120','-map','0:v:0','-map','0:a:0','-map','1:a:0','-map','2:s:0','-c:v','copy','-c:a:0','copy','-c:a:1','eac3','-ac:a:1','2','-b:a:1','192k','-c:s','srt','-disposition:a:0','default','-disposition:a:1','0','-disposition:s:0','0','-metadata:s:a:0','language=zho','-metadata:s:a:1','language=eng','-metadata:s:s:0','language=eng',file],{stdio:'pipe',timeout:30000});}
  const fixture=createMockEmby({...(file?{file}:{}),nativeTracks});await new Promise(resolve=>fixture.server.listen(18991,'127.0.0.1',resolve));
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
    await host.locator('#emby-items button').filter({hasText:'本地同步观影样片'}).click();await host.click('#library-select');await host.waitForFunction(()=>NativeRoom.playerCommand?window.__qaEvents.some(e=>e.type==='player'&&e.renderedFirstFrame&&!e.error):document.querySelector('#watch-video').readyState>=2);
    await host.click('#watch-join');if((await host.textContent('#watch-play')).trim()==='播放')await host.click('#watch-play');
    for(const p of [guest,web]){await p.click('#refresh');await p.locator('.room-card').filter({hasText:'Windows + Android + Web'}).click();await p.locator('#watch').waitFor({state:'visible'});await p.click('#watch-join');}
    await guest.waitForFunction(()=>window.__qaEvents.some(e=>e.type==='player'&&e.durationMs>=110000&&e.renderedFirstFrame&&!e.buffering&&!e.recovering&&!e.error));
    await web.waitForFunction(()=>document.querySelector('#watch-video').readyState>=2);
    for(const p of [host,guest]){await p.click('#watch-fullscreen');await p.waitForFunction(()=>document.fullscreenElement?.id==='watch-stage');await p.locator('#watch-stage #watch-play').waitFor({state:p===host?'visible':'attached'});assert.ok(await p.locator('#watch-screen').evaluate(e=>e.getBoundingClientRect().bottom<=document.querySelector('.cinema-playback').getBoundingClientRect().top+1));if(p===host&&process.env.WAIT_FOR_VISUAL==='1'){console.log('Native fullscreen ready for bounded window capture');await p.waitForTimeout(20000);}await p.locator('.watch-settings summary').click();await p.locator('#watch-quality + .choice-trigger').click();await p.locator('.choice-sheet[open]').waitFor();await p.locator('.choice-sheet .text-button').click();await p.evaluate(()=>document.exitFullscreen());}
    if(process.env.ADB){
      await guest.click('#watch-fullscreen');await guest.waitForFunction(()=>document.fullscreenElement?.id==='watch-stage');
      require('node:child_process').execFileSync(process.env.ADB,['-s','emulator-5554','shell','input','-d','0','keyevent','KEYCODE_BACK']);
      await guest.waitForFunction(()=>!document.fullscreenElement);assert.ok(await guest.locator('#watch').isVisible(),'Back exits fullscreen without leaving the room');
    }
    if((await host.textContent('#watch-play')).trim()!=='播放')await host.click('#watch-play');
    await host.locator('#watch-seek').evaluate(el=>{el.value='30';el.dispatchEvent(new Event('change',{bubbles:true}));});
    await guest.waitForFunction(()=>{const p=window.__qaEvents.filter(e=>e.type==='player').at(-1);return p&&!p.playing&&Math.abs(p.positionMs-30000)<2000;});
    await web.waitForFunction(()=>Math.abs(document.querySelector('#watch-video').currentTime-30)<2&&document.querySelector('#watch-video').paused);
    if(nativeTracks&&await host.evaluate(()=>NativeRoom.playerCapabilities?.engine==='mpv')){
      const sessions=fixture.events.filter(e=>e.event==='playbackInfo').length,select=(id,value)=>host.locator(id).evaluate((e,value)=>{e.value=String(value);e.dispatchEvent(new Event('change',{bubbles:true}));},value);
      await select('#watch-audio',2);await host.waitForFunction(()=>window.__qaEvents.filter(e=>e.type==='player').at(-1)?.audioStreamIndex===2);await select('#watch-subtitles',3);await host.waitForFunction(()=>window.__qaEvents.filter(e=>e.type==='player').at(-1)?.subtitleStreamIndex===3);await host.waitForTimeout(2500);
      let current=await host.evaluate(()=>window.__qaEvents.filter(e=>e.type==='player').at(-1));assert.equal(current.audioStreamIndex,2);assert.equal(current.subtitleStreamIndex,3);assert.ok(Math.abs(current.positionMs-30000)<2000);assert.match(await host.textContent('#watch-track-status'),/本机解码/);
      await select('#watch-subtitles',-1);await host.waitForFunction(()=>window.__qaEvents.filter(e=>e.type==='player').at(-1)?.subtitleStreamIndex===-1);await host.waitForTimeout(1500);current=await host.evaluate(()=>window.__qaEvents.filter(e=>e.type==='player').at(-1));assert.equal(current.subtitleStreamIndex,-1);assert.equal(current.audioStreamIndex,2);assert.equal(fixture.events.filter(e=>e.event==='playbackInfo').length,sessions,'Native track selection does not re-negotiate with Emby');
    }
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
