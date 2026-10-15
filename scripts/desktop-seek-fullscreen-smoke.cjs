// Test a locally built Windows app with an isolated profile and diagnostics enabled.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const {createMockEmby}=require('./mock-emby.cjs');
(async()=>{
 const fixture=createMockEmby();await new Promise(r=>fixture.server.listen(0,'127.0.0.1',r));
 let desktop,browser,host,guest;const errors=[],name='本地播放回归 '+Date.now();
 const state=p=>p.evaluate(()=>window.__qaPlayer.at(-1));
 const windowState=()=>host.evaluate(()=>window.__TAURI_INTERNALS__.invoke('native_call',{method:'windowState',args:[]}));
 try{
  desktop=await chromium.connectOverCDP('http://127.0.0.1:19224');host=desktop.contexts()[0].pages().find(p=>p.url().includes('tauri.localhost'));
  if(await host.locator('#connect').isVisible())await host.click('#connect');
  browser=await chromium.launch({channel:'msedge',headless:true});guest=await browser.newPage();
  for(const p of [host,guest]){p.setDefaultTimeout(25000);p.on('pageerror',e=>errors.push(e.message));}
  await guest.goto(process.env.CHESS_WEB_URL||'http://127.0.0.1:18880',{waitUntil:'domcontentloaded'});
  await host.evaluate(()=>{window.__qaPlayer=[];window.addEventListener('native-room',e=>{if(e.detail.type==='player'){window.__qaPlayer.push(e.detail);if(window.__qaPlayer.length>1000)window.__qaPlayer.shift();}});});
  await host.locator('#lobby').waitFor();await host.click('[data-create=watch]');await host.fill('#room-name',name);await host.click('#create-submit');
  await host.click('#watch-source');await host.fill('#emby-base','http://127.0.0.1:'+fixture.server.address().port);await host.fill('#emby-user','viewer');await host.fill('#emby-password','local-test');await host.check('#emby-share');await host.click('#emby-connect');await host.locator('.media-card').first().click();await host.click('#library-select');
  await host.waitForFunction(()=>window.__qaPlayer.some(e=>e.renderedFirstFrame&&!e.seeking&&!e.error));
  await host.click('#watch-play');
  await host.waitForFunction(()=>{const e=window.__qaPlayer.at(-1);return e?.playing&&e.positionMs>3000;});
  // Reproduce the reported order: native host is already playing when Web joins.
  await guest.locator('#lobby').waitFor();await guest.click('#refresh');await guest.locator('.room-card').filter({hasText:name}).click();await guest.click('#watch-join');
  await guest.waitForFunction(()=>document.querySelector('#watch-video').currentTime>0);
  await host.waitForFunction(()=>[...document.querySelectorAll('#watch-members [data-member-path]')].some(e=>/中转.*\d.*ms/.test(e.textContent)));
  const before=await windowState();await host.click('#watch-fullscreen');
  await host.waitForFunction(async()=>{const s=await window.__TAURI_INTERNALS__.invoke('native_call',{method:'windowState',args:[]});return s.fullscreen&&s.size.width===s.monitor.size.width&&s.size.height===s.monitor.size.height&&s.position.x===s.monitor.position.x&&s.position.y===s.monitor.position.y;});
  const full=await windowState();
  await guest.fill('#danmaku-text','全屏独立动画验证');await guest.locator('#danmaku-form button').click();
  await host.click('#watch-fullscreen');await host.waitForFunction(async()=>!(await window.__TAURI_INTERNALS__.invoke('native_call',{method:'windowState',args:[]})).fullscreen);
  const restored=await windowState();assert.deepEqual(restored.size,before.size);assert.deepEqual(restored.position,before.position);
  // Both forward/backward seek, near EOF, and restarting from a completed film.
  for(const position of [60,5,100,15]){
   await host.locator('#watch-seek').evaluate((e,p)=>{e.value=p;e.dispatchEvent(new Event('change',{bubbles:true}));},position);
   await host.waitForFunction(p=>{const e=window.__qaPlayer.at(-1);return e&&!e.seeking&&e.playing&&!e.error&&Math.abs(e.positionMs/1000-p)<3;},position);
   await guest.waitForFunction(p=>{const v=document.querySelector('#watch-video');return !v.paused&&Math.abs(v.currentTime-p)<3;},position);
   assert.notEqual((await host.textContent('#watch-play')).trim(),'播放');
  }
  // Real pointer clicks issue distinct input/change events while native seeks overlap.
  for(let round=0;round<3;round++){
   const bar=await host.locator('#watch-seek').boundingBox();
   for(const fraction of [.73,.12,.63,.24,.81,.40])await host.mouse.click(bar.x+bar.width*fraction,bar.y+bar.height/2);
   const target=Number(await host.locator('#watch-seek').inputValue());
   await host.waitForFunction(p=>{const e=window.__qaPlayer.at(-1);return e&&!e.seeking&&e.playing&&!e.error&&Math.abs(e.positionMs/1000-p)<4;},target);
   await guest.waitForFunction(p=>{const v=document.querySelector('#watch-video');return !v.paused&&Math.abs(v.currentTime-p)<4;},target);
   const start=(await state(host)).positionMs;await host.waitForFunction(p=>window.__qaPlayer.at(-1)?.positionMs>p+1000,start);
  }
  await host.locator('#watch-seek').evaluate(e=>{e.value=118;e.dispatchEvent(new Event('change',{bubbles:true}));});
  await host.waitForFunction(()=>document.querySelector('#watch-play').textContent.trim()==='播放');
  await host.click('#watch-play');
  await host.waitForFunction(()=>{const e=window.__qaPlayer.at(-1);return e&&!e.seeking&&e.playing&&e.positionMs<3000;});
  await guest.waitForFunction(()=>{const v=document.querySelector('#watch-video');return !v.paused&&v.currentTime<3;});
  await host.locator('#watch-seek').evaluate(e=>{for(const p of [80,10,50]){e.value=p;e.dispatchEvent(new Event('change',{bubbles:true}));}});
  await host.waitForFunction(()=>{const e=window.__qaPlayer.at(-1);return e&&!e.seeking&&e.playing&&Math.abs(e.positionMs/1000-50)<3;});
  await guest.waitForFunction(()=>Math.abs(document.querySelector('#watch-video').currentTime-50)<3);
  assert.deepEqual(errors,[]);assert.deepEqual(await host.evaluate(()=>window.__qaPlayer.filter(e=>e.error).map(e=>e.error)),[]);
  assert.equal((await state(host)).danmakuRenderer,'directcomposition');
  console.log(JSON.stringify({ok:true,before,full,restored,last:await state(host),checks:'real OS fullscreen + exact restore; per-member relay RTT; forward/backward + rapid overlapping seeks; EOF replay; Web guest stays playing; DirectComposition active'}));
 }finally{if(host)await host.evaluate(()=>window.cyberDisconnect?.()).catch(()=>{});if(guest)await guest.evaluate(()=>window.cyberDisconnect?.()).catch(()=>{});if(browser)await browser.close();if(desktop)await desktop.close();fixture.server.closeAllConnections();await new Promise(r=>fixture.server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
