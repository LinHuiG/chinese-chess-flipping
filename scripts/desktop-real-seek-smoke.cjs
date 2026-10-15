// Explicit real-source regression in an isolated Windows profile. The private
// JSON is supplied outside Git; neither credentials nor stream URLs are logged.
const {chromium}=require('playwright'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const input=JSON.parse(fs.readFileSync(process.env.CYBER_TEST_MEDIA_FILE,'utf8'));
 const saved={version:1,savedAt:Date.now(),source:{base:input.base,webBase:process.env.CYBER_TEST_WEB_BASE,userId:input.userId,token:input.token,canTranscode:true},settings:{quality:'auto',volume:.1,muted:true},playback:{itemId:input.itemId,title:'真实片源跳转验收',duration:2783.582,position:1306,rate:1}};
 let desktop,browser,host,guest;const samples=[],errors=[],network=[],name='跳转验收 '+Date.now();
 const snap=async()=>({host:await host.evaluate(()=>{const s=window.__seekStates.at(-1);return s?{position:s.positionMs/1000,playing:s.playing,seeking:s.seeking,ended:s.ended,error:s.error,first:s.renderedFirstFrame}:null;}),guest:await guest.evaluate(()=>{const v=document.querySelector('#watch-video');return {position:v.currentTime,ready:v.readyState,playing:!v.paused,error:document.querySelector('#watch-message').textContent};})});
 try{
  desktop=await chromium.connectOverCDP('http://127.0.0.1:19224');host=desktop.contexts()[0].pages().find(p=>p.url().includes('tauri.localhost'));host.setDefaultTimeout(65000);
  await host.evaluate(async saved=>{const {writeWatchSave}=await import('./watch-save.js');await writeWatchSave(saved);},saved);
  await host.reload({waitUntil:'domcontentloaded'});
  await host.evaluate(()=>{window.__seekStates=[];window.addEventListener('native-room',e=>{if(e.detail.type==='player'){window.__seekStates.push(e.detail);if(window.__seekStates.length>500)window.__seekStates.shift();}});});
  if(await host.locator('#connect').isVisible())await host.click('#connect');await host.locator('#lobby').waitFor();
  await host.click('[data-create=watch]');await host.fill('#room-name',name);await host.click('#create-submit');
  await host.waitForFunction(()=>{const s=window.__seekStates.at(-1);return s?.renderedFirstFrame&&!s.seeking&&!s.error;});await host.click('#watch-play');
  await host.waitForFunction(()=>{const s=window.__seekStates.at(-1);return s?.playing&&s.positionMs>1308000;});
  browser=await chromium.launch({channel:'msedge',headless:true});guest=await browser.newPage();guest.setDefaultTimeout(65000);for(const p of [host,guest])p.on('pageerror',e=>errors.push(e.message.replace(/https?:\/\/\S+/g,'[URL]')));
  guest.on('requestfailed',r=>{if(r.resourceType()==='media')network.push({kind:'failed',error:r.failure()?.errorText});});
  guest.on('response',r=>{if(r.request().resourceType()==='media'||/\.(m3u8|ts)(?:\?|$)/.test(r.url()))network.push({kind:'response',status:r.status(),type:r.headers()['content-type'],range:r.headers()['content-range']});});
  await guest.goto(process.env.CHESS_WEB_URL||'http://127.0.0.1:19280',{waitUntil:'domcontentloaded'});await guest.evaluate(()=>{window.__mediaEvents=[];const v=document.querySelector('#watch-video');for(const name of ['error','loadedmetadata','seeking','seeked','canplay','playing'])v.addEventListener(name,()=>window.__mediaEvents.push({event:name,position:v.currentTime,ready:v.readyState,error:v.error?.code,message:v.error?.message?.replace(/https?:\/\/\S+/g,'[URL]')}));});await guest.locator('#lobby').waitFor();await guest.click('#refresh');await guest.locator('.room-card').filter({hasText:name}).click();await guest.click('#watch-join');await guest.click('#watch-mute');
  await guest.waitForFunction(()=>{const v=document.querySelector('#watch-video');return v.readyState>=2&&v.currentTime>1306&&!v.paused;});samples.push(await snap());
  for(let round=0;round<2;round++){
   const bar=await host.locator('#watch-seek').boundingBox();for(const f of [.68,.11,.54,.26,.77,.47])await host.mouse.click(bar.x+bar.width*f,bar.y+bar.height/2);
   const target=Number(await host.locator('#watch-seek').inputValue());
   await host.waitForFunction(p=>{const s=window.__seekStates.at(-1);return s?.playing&&!s.seeking&&!s.error&&Math.abs(s.positionMs/1000-p)<5;},target);
   await guest.waitForFunction(p=>{const v=document.querySelector('#watch-video');return !v.paused&&v.readyState>=2&&Math.abs(v.currentTime-p)<7;},target);
   const before=await snap();await host.waitForFunction(p=>window.__seekStates.at(-1)?.positionMs>p*1000+2000,before.host.position);await guest.waitForFunction(p=>document.querySelector('#watch-video').currentTime>p+2,before.guest.position);samples.push(await snap());
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks:'PC host playing before Web joins; 12 real slider clicks; both clocks continue; same source as reported',samples}));
 }catch(e){console.log(JSON.stringify({ok:false,failure:e.message.split('\n')[0].replace(/https?:\/\/\S+/g,'[URL]'),samples,current:host&&guest?await snap().catch(()=>null):null,network,mediaEvents:guest?await guest.evaluate(()=>window.__mediaEvents).catch(()=>[]):[]}));process.exitCode=1;}
 finally{if(host)await host.evaluate(async()=>{await window.cyberDisconnect?.();const {writeWatchSave}=await import('./watch-save.js');await writeWatchSave(null);}).catch(()=>{});if(guest)await guest.evaluate(()=>window.cyberDisconnect?.()).catch(()=>{});if(browser)await browser.close();if(desktop)await desktop.close();}
})().catch(e=>{console.error(e.message.split('\n')[0].replace(/https?:\/\/\S+/g,'[URL]'));process.exitCode=1;});
