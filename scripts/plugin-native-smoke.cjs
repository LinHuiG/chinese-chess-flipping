// Isolated local profiles and a local Emby fixture. No real account or media credentials.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const {createMockEmby}=require('./mock-emby.cjs');
const url=process.env.CHESS_WEB_URL||'http://127.0.0.1:18880';
(async()=>{
 const endpoint=process.env.CHESS_HOST_CDP||'http://127.0.0.1:19223';for(let i=0;i<40;i++){try{await fetch(endpoint+'/json/version',{signal:AbortSignal.timeout(1000)});break;}catch{if(i===39)throw Error('测试宿主未就绪');await new Promise(r=>setTimeout(r,250));}}
 const fixture=createMockEmby();await new Promise(r=>fixture.server.listen(18991,'127.0.0.1',r));
 const native=await chromium.connectOverCDP(endpoint),host=native.contexts()[0].pages()[0],errors=[];
 const browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']}),guest=await browser.newPage();
 console.log('Native check: attached host and browser');
 const frame=p=>p.frames().find(f=>f.parentFrame()===p.mainFrame());
 try{
  for(const p of [host,guest]){p.setDefaultTimeout(30000);p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());}
  await host.evaluate(async market=>{await window.cyberDisconnect?.();await NativeRoom.configure(JSON.stringify({...JSON.parse(NativeRoom.settings()),host:'127.0.0.1',port:18888,transport:'TCP'}));localStorage.setItem('cyber.market',JSON.stringify(market));},url+'/plugins/');console.log('Native check: configured');await host.reload({waitUntil:'domcontentloaded'});
  await host.locator('#status').filter({hasText:'已连接'}).waitFor();
  console.log('Native check: connected');
  await host.evaluate(()=>{window.__players=[];window.__nativeErrors=[];new MutationObserver(()=>{const t=document.querySelector('#toast');if(!t.hidden)window.__nativeErrors.push(t.textContent);}).observe(document.querySelector('#toast'),{childList:true,subtree:true});addEventListener('native-room',e=>{if(e.detail.type==='player'){window.__players.push(e.detail);if(window.__players.length>30)window.__players.shift();}if(e.detail.type==='nativeFailure')window.__nativeErrors.push(e.detail.message);});});
  await host.click('#market-open');const card=host.locator('#market-list .card').filter({has:host.getByRole('heading',{name:'电影厅',exact:true})});
  const install=card.getByRole('button',{name:/^(安装|更新)$/});if(await install.count())await install.click();await card.getByRole('button',{name:'已安装',exact:true}).waitFor();await host.locator('#market-dialog .dialog-close').click();
  await host.locator('#installed .card').filter({has:host.getByRole('heading',{name:'电影厅',exact:true})}).getByRole('button',{name:'创建房间'}).click();
  const name='原生插件验收'+Date.now();await host.fill('#room-name',name);await host.click('#create-submit');await host.frameLocator('#plugin-frame').locator('#watch').waitFor();const h=frame(host);
  assert.equal(await h.evaluate(()=>typeof NativeRoom),'undefined');
  await guest.goto(url);await guest.locator('#status').filter({hasText:'已连接'}).waitFor();await guest.click('#refresh');await guest.locator('.room-card').filter({hasText:name}).click();await guest.frameLocator('#plugin-frame').locator('#watch').waitFor();const g=frame(guest);
  await h.locator('#watch-count').filter({hasText:'2/6'}).waitFor();
  await h.fill('#danmaku-text','没有片源也能收到');await h.locator('#danmaku-form button').click();console.log('chat sent',await h.evaluate(()=>({text:document.querySelector('#danmaku').textContent,input:document.querySelector('#danmaku-text').value,handler:!!document.querySelector('#danmaku-form').onsubmit})));await g.waitForFunction(()=>document.querySelector('#danmaku').textContent.includes('没有片源也能收到'));
  await h.click('#watch-source');await h.fill('#emby-base','http://127.0.0.1:18991');await h.fill('#emby-user','viewer');await h.fill('#emby-password','local-test');await h.locator('#emby-password').press('Tab');await h.check('#emby-share');await h.check('#emby-remember');await h.click('#emby-connect');
  await h.locator('#emby-items button').filter({hasText:'本地同步观影样片'}).click();await h.click('#library-select');
  await host.waitForFunction(()=>window.__players.some(s=>s.renderedFirstFrame&&!s.error));
  await h.click('#watch-play');await g.click('#watch-join');await g.waitForFunction(()=>document.querySelector('#watch-video').currentTime>1);
  await h.locator('#watch-seek').evaluate(e=>{e.value='30';e.dispatchEvent(new Event('change',{bubbles:true}));});
  await host.waitForFunction(()=>{const s=window.__players.at(-1);return s&&s.positionMs>=29500&&!s.seeking&&!s.error;});await g.waitForFunction(()=>document.querySelector('#watch-video').currentTime>=28);
  await h.click('#watch-fullscreen');await h.waitForFunction(()=>!!document.fullscreenElement);await h.evaluate(()=>document.exitFullscreen());
  assert.equal((await host.evaluate(()=>window.__nativeErrors)).some(e=>/退出|失败|无效|超时/.test(e)),false);
  await host.click('#close-plugin');await host.locator('#home').waitFor();await guest.locator('#home').waitFor();
  const saved=await host.evaluate(async()=>{const raw=await NativeRoom.secureRead('official.watch'),s=typeof raw==='string'?JSON.parse(raw):raw;return {item:s?.playback?.itemId,position:s?.playback?.position};});assert.equal(saved.item,'local-test-movie');assert(saved.position>=28);
  await host.locator('#installed .card').filter({has:host.getByRole('heading',{name:'电影厅',exact:true})}).getByRole('button',{name:'创建房间'}).click();await host.fill('#room-name','原生存档恢复');await host.click('#create-submit');await host.frameLocator('#plugin-frame').locator('#watch-title').filter({hasText:'本地同步观影样片'}).waitFor();await frame(host).click('#watch-source');await frame(host).click('#emby-forget');await host.click('#close-plugin');await host.locator('#home').waitFor();assert.equal(await host.evaluate(()=>NativeRoom.secureRead('official.watch')),null);assert.deepEqual(errors,[]);
  console.log('PASS native plugin: signed install/activation, isolated frame, cross-platform room, empty-room chat, native first frame, playing/seek sync, fullscreen, encrypted save/restore/delete and teardown');
 }catch(e){console.error('FAIL',e.message);console.error('host',await host.locator('body').innerText().catch(()=>''));const f=frame(host);if(f)console.error('plugin',await f.locator('body').innerText().catch(()=>''));console.error('native',await host.evaluate(()=>({players:window.__players?.slice(-2),errors:window.__nativeErrors})).catch(()=>null));if(frame(guest))console.error('guest',await frame(guest).locator('body').innerText().catch(()=>''));console.error('page errors',errors);throw e;}
 finally{await host.evaluate(()=>window.cyberDisconnect?.()).catch(()=>{});await guest.evaluate(()=>window.cyberDisconnect?.()).catch(()=>{});await browser.close();await native.close();await new Promise(r=>fixture.server.close(r));}
})().catch(e=>{console.error(e.message.split('\n')[0]);process.exit(1);});
