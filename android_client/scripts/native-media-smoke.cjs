// Local-only Android bridge acceptance. Requires a debug APK and the generated
// server/target/watch-fixtures/movie.mp4 (H.264/AAC). No real Emby account is used.
// ANDROID_CDP defaults to localhost:19222; ADB must point to adb, ANDROID_SERIAL
// defaults to emulator-5554. The fixture port defaults to CHESS_EMBY_TEST_PORT=18991.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {createMockEmby}=require('../../scripts/mock-emby.cjs');
(async()=>{
  const adb=process.env.ADB,device=process.env.ANDROID_SERIAL||'emulator-5554',port=Number(process.env.CHESS_EMBY_TEST_PORT||18991);
  assert.ok(adb,'Set ADB to the Android SDK adb executable');
  const fixture=createMockEmby(),out=path.resolve(__dirname,'../app/build/native-media-checks');
  fs.mkdirSync(out,{recursive:true});await new Promise(resolve=>fixture.server.listen(port,'127.0.0.1',resolve));
  let browser,page;const snapshots=[];
  const shell=(...args)=>execFileSync(adb,['-s',device,'shell',...args],{encoding:'utf8'});
  const capture=name=>fs.writeFileSync(path.join(out,name+'.png'),execFileSync(adb,['-s',device,'exec-out','screencap','-p'],{maxBuffer:8*1024*1024}));
  try{
    execFileSync(adb,['-s',device,'reverse','tcp:'+port,'tcp:'+port]);
    browser=await chromium.connectOverCDP(process.env.ANDROID_CDP||'http://127.0.0.1:19222');
    page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(30000);
    await page.locator('#lobby').waitFor({state:'visible'});
    await page.evaluate(origin=>{
      window.__mediaQA=[];window.addEventListener('native-room',e=>{
        if(['player','audioFocusLost','voiceStatus'].includes(e.detail.type)){
          window.__mediaQA.push(e.detail);if(window.__mediaQA.length>2000)window.__mediaQA.shift();
        }
      });NativeRoom.mediaConfigure(JSON.stringify({origin}));
    },'http://127.0.0.1:'+port);
    const command=q=>page.evaluate(q=>NativeRoom.playerCommand(JSON.stringify(q)),q);
    const last=()=>page.evaluate(()=>window.__mediaQA.filter(e=>e.type==='player').at(-1));
    const load=()=>command({url:`http://127.0.0.1:${port}/Videos/${fixture.ITEM}/stream.mp4?api_key=${fixture.TOKEN}`,playing:true,rate:1,volume:1,muted:false,visible:true,bounds:{x:0,y:130,width:390,height:220}});
    await load();
    await page.waitForFunction(()=>window.__mediaQA.some(e=>e.type==='player'&&e.renderedFirstFrame&&e.audioOutputAdvancing&&e.audioPcmPeak>0&&e.audioRenderedBuffers>10&&!e.error));
    snapshots.push({step:'playing-with-audio',player:await last()});
    await command({playing:false});await page.waitForFunction(()=>window.__mediaQA.filter(e=>e.type==='player').at(-1)?.playing===false);
    const paused=(await last()).positionMs;
    await command({rate:1.5});await page.waitForFunction(()=>window.__mediaQA.filter(e=>e.type==='player').at(-1)?.rate===1.5);
    let state=await last();assert.ok(Math.abs(state.positionMs-paused)<100);assert.equal(state.playing,false);
    snapshots.push({step:'paused-rate-only',player:state});
    await command({volume:.25});await page.waitForFunction(()=>window.__mediaQA.filter(e=>e.type==='player').at(-1)?.volume===.25);
    await command({muted:true});await page.waitForFunction(()=>window.__mediaQA.filter(e=>e.type==='player').at(-1)?.muted===true);
    await command({volume:.6});await page.waitForFunction(()=>Math.abs(window.__mediaQA.filter(e=>e.type==='player').at(-1)?.volume-.6)<.001);
    assert.equal((await last()).muted,true);
    await command({muted:false,playing:true});await page.waitForFunction(()=>{const e=window.__mediaQA.filter(e=>e.type==='player').at(-1);return e?.playing&&!e.muted&&e.rate===1.5;});
    const started=await last();await page.waitForTimeout(2000);state=await last();assert.ok(state.positionMs-started.positionMs>2200);
    snapshots.push({step:'unmuted-speed-1.5',player:state});capture('native-video');
    await command({playing:false,positionMs:1000});await page.waitForFunction(()=>{const e=window.__mediaQA.filter(e=>e.type==='player').at(-1);return !e.playing&&Math.abs(e.positionMs-1000)<100;});
    await command({subtitleCues:[{start:60,end:65,text:'原生字幕 · 六十秒偏移正常'}],subtitleOffsetMs:60000});
    await page.waitForFunction(()=>window.__mediaQA.filter(e=>e.type==='player').at(-1)?.subtitleCues===1);
    snapshots.push({step:'subtitle-offset-60s',player:await last()});capture('native-subtitle');
    await command({subtitleCues:[]});await page.waitForFunction(()=>window.__mediaQA.filter(e=>e.type==='player').at(-1)?.subtitleCues===0);
    assert.ok(Math.abs((await last()).positionMs-1000)<100);assert.equal((await last()).rate,1.5);
    shell('pm','grant','com.chessflipping.client','android.permission.RECORD_AUDIO');
    await page.evaluate(()=>{
      NativeRoom.playerStop();NativeRoom.voiceConfigure(JSON.stringify({roomId:'a'.repeat(32),selfId:'b'.repeat(32),members:[],directTargets:[],enabled:true,codec:'ima-adpcm-16k-v1'}));NativeRoom.voiceMicrophone(true);
    });
    await page.waitForFunction(()=>window.__mediaQA.filter(e=>e.type==='voiceStatus').at(-1)?.microphone===true);
    await load();await page.waitForTimeout(2500);
    const voice=await page.evaluate(()=>window.__mediaQA.filter(e=>e.type==='voiceStatus').at(-1));
    const focusLost=await page.evaluate(()=>window.__mediaQA.filter(e=>e.type==='audioFocusLost').length);
    assert.equal((await last()).playing,true,'Starting a movie must not mistake its own focus request for an external interruption');
    assert.equal(voice.microphone,true);assert.equal(focusLost,0);
    snapshots.push({step:'movie-after-open-mic',player:await last(),voice,focusLost});
    // Wait for the actual background transition instead of returning during the
    // launcher's animation before Android has called onStop.
    shell('am','start','-a','android.intent.action.MAIN','-c','android.intent.category.HOME');
    await page.waitForFunction(()=>window.__mediaQA.filter(e=>e.type==='voiceStatus').at(-1)?.microphone===false,{}, {polling:100});
    shell('am','start','-n','com.chessflipping.client/.MainActivity');
    await page.waitForFunction(()=>window.__mediaQA.filter(e=>e.type==='voiceStatus').at(-1)?.microphone===false);
    await page.waitForTimeout(600);assert.equal((await last()).playing,false);
    snapshots.push({step:'background-return-stays-muted-and-paused',player:await last()});
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(snapshots,null,2));
    console.log('PASS Android native video/audio sink and nonzero PCM, standalone rate/volume/mute, subtitle offset/clear, microphone focus handoff and background lifecycle');
  }finally{
    await page?.evaluate(()=>{NativeRoom.voiceStop();NativeRoom.playerStop();}).catch(()=>{});
    await browser?.close();await new Promise(resolve=>fixture.server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
