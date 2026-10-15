// Local mock Emby only; exercise the same host UI on Web / Windows / Android.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const {createMockEmby}=require('./mock-emby.cjs');
(async()=>{
 const fixture=createMockEmby({playback:true});await new Promise(r=>fixture.server.listen(Number(process.env.CHESS_EMBY_TEST_PORT||18991),'127.0.0.1',r));
 const url=process.env.CHESS_WEB_URL||'http://127.0.0.1:19280',errors=[];let browser,desktop,host,guest,context;
 const capture=async p=>p.evaluate(async()=>{window.__savePlayer=[];window.addEventListener('native-room',e=>{if(e.detail.type==='player'){window.__savePlayer.push(e.detail);if(window.__savePlayer.length>40)window.__savePlayer.shift();}});const {WatchRoom}=await import('./watch.js');if(!WatchRoom.prototype.__saveCapture){const render=WatchRoom.prototype.render;WatchRoom.prototype.render=function(){window.__saveWatch=this;return render.call(this);};WatchRoom.prototype.__saveCapture=true;}});
 const snapshot=p=>p.evaluate(async()=>{const {readWatchSave}=await import('./watch-save.js');const value=await readWatchSave();if(!value)return null;return {position:value.playback?.position,rate:value.playback?.rate,settings:value.settings,subtitle:value.playback?.subtitleIndex,audio:value.playback?.audioIndex,itemId:value.playback?.itemId,savedAt:value.savedAt,hasToken:!!value.source.token,noPassword:!('password' in value.source),noSession:!('session' in (value.playback||{}))};});
 const create=async(name)=>{await host.locator('#lobby').waitFor();await host.click('[data-create=watch]');await host.fill('#room-name',name);await host.click('#create-submit');await host.locator('#watch').waitFor();};
 const leave=async()=>{await host.click('#watch .leave');await host.click('#confirm-ok');await host.locator('#lobby').waitFor();};
 const choose=async(id,value)=>{await host.locator('#'+id).evaluate((e,v)=>{e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));},String(value));};
 const ready=async()=>{try{await host.waitForFunction(()=>{const w=window.__saveWatch;return w?.url&&!w.loading&&!w.pendingSeek&&!w.error&&w.duration>0;});}catch(e){console.log('playback failure',await host.evaluate(()=>{const w=window.__saveWatch;return {loading:w.loading,error:w.error,position:w.current(),epoch:w.epoch,pending:w.pendingSeek,player:window.__savePlayer.slice(-5)};}));throw e;}};
 try{
  browser=await chromium.launch({channel:'msedge',headless:true});context=await browser.newContext();
  if(process.env.CHESS_HOST_CDP){desktop=await chromium.connectOverCDP(process.env.CHESS_HOST_CDP);host=desktop.contexts()[0].pages().find(p=>/tauri.localhost|appassets.androidplatform/.test(p.url()));if(!host)throw Error('Local test host not found');if(await host.locator('#connect').isVisible())await host.click('#connect');}
  else{host=await context.newPage();await host.goto(url,{waitUntil:'domcontentloaded'});}
  host.setDefaultTimeout(45000);host.on('pageerror',e=>errors.push(e.message));await capture(host);
  // Isolated fixture profiles only; clean previous fixture authorization.
  await host.evaluate(async()=>{const {writeWatchSave}=await import('./watch-save.js');await writeWatchSave(null);});
  await host.reload({waitUntil:'domcontentloaded'});await capture(host);
  const name='本地存档验收 '+Date.now();await create(name);console.log('stage: created');
  guest=await browser.newPage();guest.setDefaultTimeout(30000);guest.on('pageerror',e=>errors.push(e.message));await guest.goto(url,{waitUntil:'domcontentloaded'});await guest.locator('#lobby').waitFor();await guest.click('#refresh');await guest.locator('.room-card').filter({hasText:name}).click();
  await host.click('#watch-source');await host.fill('#emby-base','http://127.0.0.1:'+fixture.server.address().port);await host.fill('#emby-user','viewer');await host.fill('#emby-password','local-test');await host.check('#emby-share');await host.check('#emby-remember');await host.click('#emby-connect');await host.locator('.media-card').first().click();await host.click('#library-select');await ready();console.log('stage: selected');
  await host.click('#watch-play');await guest.click('#watch-join');await host.waitForFunction(()=>window.__saveWatch.current()>6);await host.waitForFunction(async()=>{const {readWatchSave}=await import('./watch-save.js');return (await readWatchSave())?.playback?.position>3;});
  assert.equal(await snapshot(guest),null,'Guest must not persist the shared token');
  await host.click('#watch-play');await choose('watch-rate',1.5);await choose('watch-seek',63);
  await host.locator('#watch-volume').evaluate(e=>{e.value='.35';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));});await host.click('#watch-mute');
  await choose('watch-quality',720);await ready();await choose('watch-audio',2);await ready();
  await choose('watch-subtitles',3);await ready();
  await host.waitForFunction(()=>window.__saveWatch.subtitleIndex===3&&!window.__saveWatch.subtitleLoading);
  console.log('stage: settings');await leave();const saved=await snapshot(host);assert.equal(saved.rate,1.5);assert.equal(saved.settings.volume,.35);assert.equal(saved.settings.muted,true);assert.equal(saved.settings.quality,'720');assert.equal(saved.audio,2);assert.equal(saved.subtitle,3);assert.ok(Math.abs(saved.position-63)<2);assert.equal(saved.noPassword,true);assert.equal(saved.noSession,true);
  if(process.env.CHESS_RESTART_ANDROID){
   const {execFileSync}=require('node:child_process'),adb=process.env.CHESS_RESTART_ANDROID,run=(...args)=>execFileSync(adb,['-s','emulator-5554',...args],{encoding:'utf8',windowsHide:true,timeout:15000});
   await desktop.close();run('shell','am','force-stop','com.chessflipping.client');run('shell','am','start','-n','com.chessflipping.client/.MainActivity');
   for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,200));const pid=run('shell','pidof','com.chessflipping.client').trim();if(!pid||!run('shell','cat','/proc/net/unix').includes('webview_devtools_remote_'+pid))continue;run('forward','tcp:19222','localabstract:webview_devtools_remote_'+pid);try{desktop=await chromium.connectOverCDP('http://127.0.0.1:19222');host=desktop.contexts()[0].pages().find(p=>p.url().includes('appassets.androidplatform'));if(host)break;}catch{}}
   host.setDefaultTimeout(45000);host.on('pageerror',e=>errors.push(e.message));await capture(host);console.log('stage: Android process restarted');
  }
  if(process.env.CHESS_RESTART_WINDOWS){
   const {spawn}=require('node:child_process');await host.evaluate(()=>NativeRoom.exitApp()).catch(()=>{});await desktop.close().catch(()=>{});await new Promise(r=>setTimeout(r,500));
   const child=spawn(process.env.CHESS_RESTART_WINDOWS,[],{windowsHide:true,detached:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=19224',CYBER_ROOM_MEDIA_DIAGNOSTICS:'1'}});child.unref();
   for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,200));try{desktop=await chromium.connectOverCDP('http://127.0.0.1:19224');host=desktop.contexts()[0].pages().find(p=>p.url().includes('tauri.localhost'));if(host)break;}catch{}}
   host.setDefaultTimeout(45000);host.on('pageerror',e=>errors.push(e.message));await capture(host);console.log('stage: Windows process restarted, test PID '+child.pid);
  }
  const logins=fixture.events.filter(e=>e.event==='login').length;await create(name+'恢复');await ready();console.log('stage: recreated');
  let restored=await host.evaluate(()=>{const w=window.__saveWatch;return {position:w.current(),playing:w.room.room.playback.playing,epoch:w.epoch,subtitle:w.subtitleIndex,rate:w.room.room.playback.rate,volume:w.volume,muted:w.muted};});
  assert.ok(Math.abs(restored.position-63)<2);assert.equal(restored.playing,false);assert.equal(restored.subtitle,3);assert.equal(restored.rate,1.5);assert.equal(fixture.events.filter(e=>e.event==='login').length,logins,'Restored token avoids re-entering credentials');
  await host.reload({waitUntil:'domcontentloaded'});await capture(host);await host.locator('#watch').waitFor();await ready();
  assert.ok(Math.abs(await host.evaluate(()=>window.__saveWatch.current())-63)<2,'Reload restores active host room');
  await choose('watch-seek',82);await ready();await leave();await host.reload({waitUntil:'domcontentloaded'});await capture(host);await create(name+'重启');await ready();assert.ok(Math.abs(await host.evaluate(()=>window.__saveWatch.current())-82)<2);
  await host.click('#watch-source');await host.click('#emby-forget');await host.waitForFunction(()=>document.querySelector('#emby-save-status').textContent.includes('已删除'));await host.click('#emby-dialog .dialog-close');await leave();await create(name+'清空');assert.equal(await snapshot(host),null);assert.equal(await host.evaluate(()=>!!window.__saveWatch.access),false);
  await leave();assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,platform:await host.evaluate(()=>window.NativeRoom?(window.NativeRoom.platform||'ANDROID'):'WEB'),saved:{...saved,savedAt:undefined},restored,checks:'5-second autosave; guest isolation; exit/recreate; active host reload; closed-room reload; paused restoration; rate/volume/mute/subtitle; deletion not resurrected'}));
 }finally{if(host)await host.evaluate(()=>window.cyberDisconnect?.()).catch(()=>{});if(guest)await guest.evaluate(()=>window.cyberDisconnect?.()).catch(()=>{});if(desktop)await desktop.close();if(browser)await browser.close();fixture.server.closeAllConnections();await new Promise(r=>fixture.server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
