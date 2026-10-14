// Public UI regression with deliberately delayed replies; local Rust + mock Emby only.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createMockEmby}=require('./mock-emby.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function frame(message){const b=Buffer.from(message),n=b.readUInt32BE(6);return {kind:b[15],control:Object.fromEntries(b.subarray(17,17+n).toString().trim().split('\n').filter(Boolean).map(line=>{const i=line.indexOf(':');return[line.slice(0,i),line.slice(i+1)];})),body:JSON.parse(b.subarray(17+n).toString()||'{}')};}
(async()=>{
 const fixture=createMockEmby();await new Promise(r=>fixture.server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+fixture.server.address().port,url=process.env.CHESS_WEB_URL||'http://127.0.0.1:18880';
 const out=path.resolve(__dirname,'../server/target/app-regression');fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({headless:true,channel:'msedge',args:['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
 const host=await browser.newPage(),guest=await browser.newPage(),outsider=await browser.newPage(),pages=[host,guest,outsider],passed=[],errors=[];
 let authMode='',heldAuth,releaseSync,holdSync=false,dropHost;const listCounts=[0,0,0];
 async function visible(p,id){await p.locator(id).waitFor({state:'visible'});}
 async function create(name){await host.click('[data-create=watch]');await host.fill('#room-name',name);await host.click('#create-submit');await visible(host,'#watch');}
 async function leave(p=host){await p.locator('#watch .leave').click();await p.click('#confirm-ok');await visible(p,'#lobby');}
 async function connectSource(password='local-test'){await host.fill('#emby-base',origin);await host.fill('#emby-user','viewer');await host.fill('#emby-password',password);await host.check('#emby-share');await host.click('#emby-connect');}
 const pass=name=>{passed.push(name);console.log('PASS '+name);};
 try{
  for(const [i,p] of pages.entries()){
   p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));
   await p.routeWebSocket('**/ws',ws=>{const server=ws.connectToServer(),sync=new Set();if(i===0)dropHost=async()=>{await ws.close();await server.close();};ws.onMessage(message=>{const m=frame(message);if(m.kind===16&&m.control.op==='101')listCounts[i]++;if(i===0&&holdSync&&m.kind===16&&m.control.op==='103')sync.add(m.control.requestId);server.send(message);});server.onMessage(message=>{const m=frame(message);if(sync.delete(m.control.requestId)){releaseSync=()=>ws.send(message);}else ws.send(message);});});
  }
  await host.route(origin+'/Users/AuthenticateByName',async route=>{
   if(authMode==='hold'){heldAuth=()=>route.continue();return;}
   if(authMode==='admin'){await route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({AccessToken:'local-admin-only',User:{Id:'local-admin',Policy:{IsAdministrator:true}}})});return;}
   await route.continue();
  });
  await Promise.all(pages.map(p=>p.goto(url)));await Promise.all(pages.map(p=>visible(p,'#lobby')));
  await host.click('#settings-open');await host.fill('#nickname','权限回归房主');await host.uncheck('#sound');await host.uncheck('#motion');await host.click('#settings-save');await host.reload();await visible(host,'#lobby');
  await host.click('#settings-open');assert.equal(await host.inputValue('#nickname'),'权限回归房主');assert.equal(await host.isChecked('#sound'),false);assert.equal(await host.isChecked('#motion'),false);await host.locator('#settings-dialog .dialog-close').click();
  await host.click('#rules-open');await host.locator('#rules-body').getByText('禁止重复棋面',{exact:false}).waitFor();await host.locator('#rules-dialog .dialog-close').click();pass('settings persisted and rules loaded');
  await create('自动刷新与权限');await guest.locator('.room-card').filter({hasText:'自动刷新与权限'}).waitFor({timeout:7000});assert.ok(listCounts[1]>=6);await guest.locator('.room-card').filter({hasText:'自动刷新与权限'}).click();await visible(guest,'#watch');
  const listed=listCounts[1];await wait(5500);assert.equal(listCounts[1],listed);assert.ok(await guest.locator('#watch-source').isHidden());assert.ok(await guest.locator('#watch-play').isHidden());assert.equal(await guest.locator('#watch-seek').isDisabled(),true);
  await guest.locator('#watch-source').evaluate(b=>b.click());assert.equal(await guest.locator('#emby-dialog').isVisible(),false);pass('5-second lobby refresh stops in room; guest cannot open source controls');
  await host.click('#watch-source');await connectSource('wrong');await host.waitForFunction(()=>!document.querySelector('#emby-connect').disabled);assert.match(await host.textContent('#emby-error'),/Emby|账号|授权/);
  authMode='admin';await connectSource();await host.waitForFunction(()=>!document.querySelector('#emby-connect').disabled);assert.match(await host.textContent('#emby-error'),/非管理员/);
  authMode='';await connectSource();await host.locator('#emby-items button').filter({hasText:'本地同步观影样片'}).waitFor();
  await host.locator('#emby-items button').first().click();await host.click('#library-select');await host.waitForFunction(()=>document.querySelector('#watch-video').readyState>=2);await guest.click('#watch-join');await guest.waitForFunction(()=>document.querySelector('#watch-video').readyState>=2);pass('bad login and administrator rejection recover to authorized playback');
  await guest.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Test microphone denial','NotAllowedError');};});await guest.click('#watch-mic');await guest.waitForFunction(()=>document.querySelector('#watch-mic').textContent==='开启麦克风');
  await guest.fill('#danmaku-text','拒绝开麦仍能观影');await guest.locator('#danmaku-form button').click();await host.locator('#danmaku').getByText('拒绝开麦仍能观影',{exact:false}).waitFor();assert.ok(await guest.evaluate(()=>document.querySelector('#watch-video').readyState>=2));pass('microphone denial preserves playback and danmaku');
  await host.locator('#watch-members button:enabled').click();await host.click('#confirm-ok');await visible(guest,'#lobby');assert.equal(await guest.locator('#emby-dialog').isVisible(),false);pass('host kick revokes member and closes member room');
  holdSync=true;await dropHost();for(let n=0;!releaseSync&&n<100;n++)await wait(100);assert.ok(releaseSync,'hold a real ROOM_SYNC response after reconnect');
  await leave();await create('新房间不能被旧响应清理');holdSync=false;releaseSync();await wait(300);assert.equal(await host.textContent('#watch-name'),'新房间不能被旧响应清理');assert.ok(await host.locator('#watch-source').isVisible());pass('late room recovery response does not clear a new room');
  await host.click('#watch-source');authMode='hold';await connectSource();for(let n=0;!heldAuth&&n<30;n++)await wait(100);assert.ok(heldAuth);
  await host.evaluate(()=>window.cyberDisconnect());await visible(host,'#offline');assert.equal(await host.locator('#emby-dialog').isVisible(),false);await host.click('#connect');await visible(host,'#lobby');await create('登录迟到不能污染新房');authMode='';await heldAuth();await wait(500);
  await guest.click('#refresh');await guest.locator('.room-card').filter({hasText:'登录迟到不能污染新房'}).click();await visible(guest,'#watch');assert.ok(await guest.locator('#watch-source').isHidden());assert.equal(await host.locator('#emby-dialog').isVisible(),false);assert.equal(await host.locator('#emby-items button').count(),0);pass('leaving closes source dialog and discards a late login reply');
  await leave();await visible(guest,'#lobby');await guest.evaluate(()=>window.cyberDisconnect());await visible(guest,'#offline');const stopped=listCounts[1];await wait(5500);assert.equal(listCounts[1],stopped);pass('explicit disconnect cancels reconnection and lobby polling');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed,pageErrors:errors},null,2));
 }catch(e){for(const [i,p] of pages.entries())await p.screenshot({path:path.join(out,'failure-'+i+'.png')}).catch(()=>{});throw e;}
 finally{for(const p of pages)await p.evaluate(()=>window.cyberDisconnect?.()).catch(()=>{});await browser.close();await new Promise(r=>fixture.server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
