// Requires the local server and scripts/mock-emby.cjs fixture; never uses a real account.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
(async()=>{
  const browser=await chromium.connectOverCDP(process.env.ANDROID_CDP||'http://127.0.0.1:19222');
  const page=browser.contexts()[0].pages()[0],adb=process.env.ADB,device=process.env.ANDROID_SERIAL||'emulator-5554';
  const out=path.resolve(__dirname,'../app/build/fullscreen-checks');fs.mkdirSync(out,{recursive:true});page.setDefaultTimeout(20000);
  const capture=name=>{if(adb)fs.writeFileSync(path.join(out,name+'.png'),execFileSync(adb,['-s',device,'exec-out','screencap','-p']));};
  const reports=[];
  try{
    await page.locator('#lobby').waitFor({state:'visible'});
    await page.evaluate(()=>{window.__fullscreenPlayers=[];window.addEventListener('native-room',e=>{if(e.detail.type==='player'){window.__fullscreenPlayers.push(e.detail);if(window.__fullscreenPlayers.length>200)window.__fullscreenPlayers.shift();}});});
    await page.click('[data-create=watch]');await page.fill('#room-name','Android full-screen acceptance');await page.click('#create-submit');await page.locator('#watch').waitFor({state:'visible'});
    await page.click('#watch-source');await page.fill('#emby-base','http://127.0.0.1:18991');await page.fill('#emby-user','viewer');await page.fill('#emby-password','local-test');await page.check('#emby-share');await page.click('#emby-connect');
    await page.locator('#emby-items button').filter({hasText:'本地同步观影样片'}).click();await page.click('#watch-join');
    await page.waitForFunction(()=>window.__fullscreenPlayers.some(e=>e.renderedFirstFrame&&!e.error));
    if((await page.textContent('#watch-play')).trim()==='播放')await page.click('#watch-play');
    await page.waitForFunction(()=>window.__fullscreenPlayers.at(-1)?.playing);
    for(const exit of ['javascript','back','button']){
      await page.click('#watch-fullscreen');await page.waitForFunction(()=>document.fullscreenElement?.id==='watch-stage');
      await page.waitForFunction(()=>{const r=document.querySelector('#watch-stage').getBoundingClientRect();return Math.abs(r.width-innerWidth)<2&&Math.abs(r.height-innerHeight)<2;});
      await page.waitForTimeout(500);capture('fullscreen-'+exit);
      reports.push(await page.evaluate(()=>({fullscreen:document.fullscreenElement?.id,width:innerWidth,height:innerHeight,player:window.__fullscreenPlayers.at(-1)})));
      if(exit==='javascript')await page.evaluate(()=>document.exitFullscreen());else{
        assert.ok(adb,'ADB is required to verify native full-screen controls');
        if(exit==='back')execFileSync(adb,['-s',device,'shell','input','-d','0','keyevent','KEYCODE_BACK']);
        else{
          execFileSync(adb,['-s',device,'shell','uiautomator','dump','/sdcard/cyber-fullscreen.xml']);
          const hierarchy=execFileSync(adb,['-s',device,'shell','cat','/sdcard/cyber-fullscreen.xml'],{encoding:'utf8'}),button=hierarchy.match(/<node\b[^>]*text="退出全屏"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
          assert.ok(button,'Native exit-full-screen button is visible');execFileSync(adb,['-s',device,'shell','input','-d','0','tap',String(Math.round((+button[1]+ +button[3])/2)),String(Math.round((+button[2]+ +button[4])/2))]);
        }
      }
      await page.waitForFunction(()=>document.fullscreenElement===null);
      await page.locator('#watch-fullscreen').waitFor({state:'visible'});await page.waitForTimeout(500);capture('restored-'+exit);
      assert.equal(await page.locator('#watch').isVisible(),true,'Back must exit full screen without leaving the room');
      await page.waitForFunction(()=>window.__fullscreenPlayers.at(-1)?.playing);
    }
    assert.equal(await page.evaluate(()=>window.__fullscreenPlayers.some(e=>e.error)),false);
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(reports,null,2));
    console.log('PASS Android native video: JavaScript fullscreen enter/exit, hardware Back, visible native exit button, native playback continues and room remains active');
  }finally{
    await page.evaluate(()=>document.fullscreenElement&&document.exitFullscreen()).catch(()=>{});
    if(await page.locator('#watch').isVisible().catch(()=>false)){await page.locator('#watch .leave').click().catch(()=>{});await page.locator('#confirm-ok').click().catch(()=>{});await page.locator('#lobby').waitFor({state:'visible'}).catch(()=>{});}
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
