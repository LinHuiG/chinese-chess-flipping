// Real browser acceptance against the local Rust service and a local Emby fixture.
// NODE_PATH=<Playwright packages> CHESS_WEB_URL=http://127.0.0.1:18880 node scripts/watch-room-smoke.cjs
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createMockEmby}=require('./mock-emby.cjs');
(async()=>{
  const fixture=createMockEmby(),url=process.env.CHESS_WEB_URL||'http://127.0.0.1:18880';
  await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));
  const emby='http://127.0.0.1:'+fixture.server.address().port,out=path.resolve(__dirname,'../server/target/watch-checks');fs.mkdirSync(out,{recursive:true});
  let browser;const options={headless:true,args:['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']};
  try{browser=await chromium.launch(options);}catch{browser=await chromium.launch({...options,channel:'msedge'});}
  const pages=[],errors=[],voiceReceived=Array(7).fill(0);let voiceSent=0;
  function isVoice(payload){try{const b=Buffer.from(payload);return b.length>=17&&b.readUInt16BE(0)===0xfcfc&&b.subarray(17,17+b.readUInt32BE(6)).toString().includes('type:voice\n');}catch{return false;}}
  async function visible(p,selector){await p.locator(selector).waitFor({state:'visible'});}
  async function join(p,password='watch-test'){
    await p.click('#refresh');await p.locator('.room-card').filter({hasText:'六人观影验收'}).click();
    await visible(p,'#password-dialog');await p.fill('#password-value',password);await p.locator('#password-form button[type=submit]').click();
  }
  async function chat(p,text){await p.fill('#danmaku-text',text);await p.locator('#danmaku-form button').click();}
  async function seek(host,seconds){await host.locator('#watch-seek').evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('change',{bubbles:true}));},seconds);}
  try{
    for(let i=0;i<7;i++){
      const p=await browser.newPage({viewport:i===0?{width:1440,height:1000}:{width:390,height:844}});p.setDefaultTimeout(20000);pages.push(p);
      p.on('pageerror',e=>errors.push(e.message));p.on('websocket',ws=>{ws.on('framereceived',f=>{if(isVoice(f.payload))voiceReceived[i]++;});ws.on('framesent',f=>{if(isVoice(f.payload))voiceSent++;});});
    }
    await Promise.all(pages.map(p=>p.goto(url)));await Promise.all(pages.map(p=>visible(p,'#lobby')));
    const host=pages[0];await host.click('[data-create=watch]');await host.fill('#room-name','六人观影验收');await host.fill('#create-password','watch-test');await host.click('#create-submit');await visible(host,'#watch');
    assert.match(await host.textContent('#watch-count'),/1\/6/);
    await host.click('#watch-source');await host.fill('#emby-base',emby);await host.fill('#emby-user','viewer');await host.fill('#emby-password','local-test');await host.click('#emby-connect');
    assert.equal(await host.locator('#emby-items button').count(),0,'Explicit sharing confirmation is required');await host.check('#emby-share');await host.click('#emby-connect');
    await host.locator('#emby-items button').first().waitFor();await host.fill('#emby-search','同步');await host.locator('#emby-search-form button').click();
    await host.locator('#emby-items button').filter({hasText:'本地同步观影样片'}).click();
    await host.waitForFunction(()=>document.querySelector('#watch-video').readyState>=2);await host.click('#watch-join');
    await host.click('#watch-fullscreen');await host.waitForFunction(()=>document.fullscreenElement?.id==='watch-stage');await host.evaluate(()=>document.exitFullscreen());
    if((await host.textContent('#watch-play')).trim()==='播放')await host.click('#watch-play');
    await seek(host,15);await host.waitForFunction(()=>document.querySelector('#watch-video').currentTime>=14);
    await chat(host,'加入前的弹幕不补发');
    await pages[6].click('#refresh');await pages[6].selectOption('#room-filter','chess');assert.equal(await pages[6].locator('.room-card').filter({hasText:'六人观影验收'}).count(),0);await pages[6].selectOption('#room-filter','watch');await pages[6].locator('.room-card').filter({hasText:'六人观影验收'}).waitFor();
    await join(pages[6],'wrong');await pages[6].waitForFunction(()=>/密码/.test(document.querySelector('#toast').textContent)&&!document.querySelector('#toast').hidden);assert.ok(await pages[6].locator('#lobby').isVisible());
    for(const guest of pages.slice(1,6)){await join(guest);await visible(guest,'#watch');await guest.click('#watch-join');}
    await host.waitForFunction(()=>document.querySelector('#watch-count').textContent==='6/6 人');
    await Promise.all(pages.slice(1,6).map(p=>p.waitForFunction(()=>document.querySelector('#watch-video').currentTime>=14)));
    for(const p of pages.slice(1,6)){assert.ok(await p.locator('#watch-source').isHidden());assert.ok(await p.locator('#watch-play').isHidden());assert.equal(await p.locator('#danmaku').getByText('加入前的弹幕不补发',{exact:false}).count(),0);}
    await join(pages[6]);await pages[6].waitForFunction(()=>/满/.test(document.querySelector('#toast').textContent)&&!document.querySelector('#toast').hidden);assert.ok(await pages[6].locator('#lobby').isVisible());
    await host.click('#watch-play');await seek(host,30);
    await Promise.all(pages.slice(0,6).map(p=>p.waitForFunction(()=>{const v=document.querySelector('#watch-video');return v.paused&&Math.abs(v.currentTime-30)<2;})));
    await chat(pages[1],'暂停也可以发弹幕');await Promise.all(pages.slice(0,6).map(p=>p.locator('#danmaku').getByText('暂停也可以发弹幕',{exact:false}).waitFor()));
    await host.locator('#watch .room-password').click();await host.fill('#password-value','new-password');await host.locator('#password-form button[type=submit]').click();
    await pages[2].reload();await visible(pages[2],'#watch');assert.ok(await pages[2].locator('#password-dialog').isHidden());await pages[2].click('#watch-join');
    await host.click('#watch-mic');await host.waitForFunction(()=>document.querySelector('#watch-mic').textContent==='关闭麦克风');
    const voiceDeadline=Date.now()+8000;while(Date.now()<voiceDeadline&&!voiceReceived.slice(1,6).every(n=>n>=3))await new Promise(r=>setTimeout(r,100));
    assert.ok(voiceSent>=3,'Microphone sends CRV1 over room broadcast');assert.ok(voiceReceived.slice(1,6).every(n=>n>=3),'Every approved receiver gets voice');assert.equal(voiceReceived[6],0,'Rejected/capacity-limited peer gets no audio');
    await host.click('#watch-mic');
    const sessionsBefore=fixture.events.filter(e=>e.event==='playbackInfo').length;
    await host.click('#watch-source');await host.locator('#emby-items button').first().click();await host.waitForFunction(()=>document.querySelector('#watch-video').readyState>=2);
    const reloadDeadline=Date.now()+5000;while(Date.now()<reloadDeadline&&fixture.events.filter(e=>e.event==='playbackInfo').length<sessionsBefore+6)await new Promise(r=>setTimeout(r,100));
    assert.ok(fixture.events.filter(e=>e.event==='playbackInfo').length>=sessionsBefore+6,'Reselecting a movie starts a fresh session for each member');
    assert.ok(fixture.events.filter(e=>e.event==='/Sessions/Playing/Stopped').length>=6,'Each old session reports Stopped before replacement');
    assert.ok(fixture.events.filter(e=>e.event==='playbackInfo').length>=6,'Independent Emby playback sessions');assert.ok(fixture.events.filter(e=>e.event==='video').length>=6,'Members fetch video directly');
    await host.screenshot({path:path.join(out,'desktop-watch.png'),fullPage:true});await pages[1].screenshot({path:path.join(out,'mobile-watch.png'),fullPage:true});
    await host.locator('#watch .leave').click();await host.click('#confirm-ok');await Promise.all(pages.slice(0,6).map(p=>visible(p,'#lobby')));
    assert.deepEqual(errors,[]);console.log('PASS watch UI: sharing confirmation, search, fullscreen, lobby filter, solo playback, password rejection, late join, six seats, no history, pause/seek, password-change recovery, live binary voice, movie reselection/Stopped, direct Emby and host dissolution');
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({voiceSent,voiceReceived,playbackSessions:fixture.events.filter(e=>e.event==='playbackInfo').length,pageErrors:errors},null,2));
  }catch(e){for(let i=0;i<pages.length;i++)await pages[i].screenshot({path:path.join(out,'failure-'+i+'.png'),fullPage:true}).catch(()=>{});throw e;}
  finally{await browser.close();await new Promise(resolve=>fixture.server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
