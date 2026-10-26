// Real lobby and signed PluginStore; room transport/runtime are local launch-recording fixtures.
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),web=path.join(root,'server/src/main/resources/web'),read=name=>fs.readFileSync(path.join(root,name),'utf8');
const keys=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),files=new Map(),base=JSON.parse(read('plugins/chess/manifest.json'));
const cover='data:image/svg+xml;base64,'+Buffer.from(read('plugins/chess/assets/cover.svg')).toString('base64');
const records=['1.0.3','1.0.4','1.0.5','1.0.6'].map(version=>{
 const manifest={...base,version,targets:{web:{entry:'app.js'}}},raw=JSON.stringify({manifest,script:'export {};',html:'<p>Fixture</p>',style:'',assets:{[manifest.cover]:cover}});
 const sha256=crypto.createHash('sha256').update(raw).digest('hex'),artifacts={web:{path:`${manifest.id}/${version}/web-${sha256}.json`,sha256,size:Buffer.byteLength(raw)}},release=crypto.createHash('sha256').update(JSON.stringify({manifest,artifacts})).digest('hex');
 files.set('/plugins/'+artifacts.web.path,raw);return {id:manifest.id,version,release,manifest,artifacts,cover};
});
files.set('/plugin-trust.json',JSON.stringify({keys:[keys.publicKey.export({format:'jwk'})]}));
let transport=read('server/src/main/resources/web/transport.js').replace('export class RoomClient','class RealRoomClient');
transport+=`\nexport class RoomClient{constructor(callbacks){this.callbacks=callbacks;this.ready=true;this.generation=1;this.identity={clientId:'fixture',capabilities:['room-descriptors']};}connect(){this.callbacks.connected(this.identity,false);}listRooms(){return fetch('/fixture-rooms').then(r=>r.json());}disconnect(){this.ready=false;this.generation++;}clearPeers(){}}`;
files.set('/transport.js',transport);
files.set('/plugin-runtime.js',`window.opened=[];export class PluginRuntime{constructor(client,container,events){this.events=events;}connection(){return {ready:true};}emit(){}async setModal(){}async open(value,command){window.opened.push({release:value.record.release,command});this.active=value;this.events.open(value.record.manifest);}async close(){this.active=null;this.events.close();}}`);
let current=records[0],catalogFailure=false,roomRecord=records[0],locked=false,catalogWait;
const envelope=()=>{const payload=JSON.stringify({schemaVersion:1,releases:[current]});return JSON.stringify({payload,signature:crypto.sign('sha256',Buffer.from(payload),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')});};
const server=http.createServer(async(req,res)=>{
 const name=new URL(req.url,'http://local').pathname;let body=files.get(name);
 if(name==='/plugins/catalog.json'){if(catalogWait)await catalogWait;if(catalogFailure){res.writeHead(503).end('fixture unavailable');return;}body=envelope();}
 if(name==='/fixture-rooms')body=JSON.stringify([{roomId:'1'.repeat(32),name:'版本核对房间',metadata:JSON.stringify({id:roomRecord.id,release:roomRecord.release}),locked}]);
 if(body===undefined){const file=path.join(web,name==='/'?'index.html':name);if(!file.startsWith(web+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}body=fs.readFileSync(file);}
 res.writeHead(200,{'Content-Type':name==='/'?'text/html':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'application/json','Cache-Control':'no-store'});res.end(body);
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));const url='http://127.0.0.1:'+server.address().port,installedCard=page.locator('#installed .card').filter({has:page.getByRole('heading',{name:'翻棋',exact:true})});
 const button=name=>installedCard.getByRole('button',{name,exact:true});
 const openCount=()=>page.evaluate(()=>opened.length);
 const clearToast=()=>page.evaluate(()=>{document.querySelector('#toast').hidden=true;document.querySelector('#toast').textContent='';});
 const toast=async pattern=>{await page.locator('#toast').filter({hasText:pattern}).waitFor();};
 const fresh=()=>page.waitForFunction(()=>document.querySelector('#market-status').textContent.startsWith('仅支持最新版本'));
 const selected=()=>page.evaluate(async()=>{const {PluginStore}=await import('/plugin-store.js');return (await new PluginStore().installed())['official.chess'];});
 const update=async()=>{await button('更新插件').click();await button('创建房间').waitFor();assert.equal(await selected(),current.release);};
 const leave=async()=>{await page.click('#close-plugin');await page.click('#leave-confirm');await page.locator('#home').waitFor();};
 try{
  await page.goto(url);await fresh();await page.click('#market-open');await page.locator('#market-list .card .primary').click();await page.getByRole('button',{name:'已安装',exact:true}).waitFor();await page.locator('#market-dialog .dialog-close').click();await button('创建房间').waitFor();assert.equal(await selected(),records[0].release);
  await page.evaluate(record=>{localStorage.setItem('cyber.activePlugin',JSON.stringify({id:record.id,release:record.release}));localStorage.setItem('cyber.plugin.data.'+record.id,JSON.stringify({save:'preserve-fixture'}));},records[0]);
  catalogFailure=true;await page.reload();await page.waitForFunction(()=>document.querySelector('#market-status').textContent.includes('无法核对最新版'));assert.equal(await openCount(),0,'failed refresh must block cached recovery');await clearToast();await button('创建房间').click();await toast('插件市场请求失败');assert.equal(await page.locator('#create-dialog').isVisible(),false,'failed refresh must block create');
  current=records[1];catalogFailure=false;await page.reload();await fresh();await button('更新插件').waitFor();await toast('上次房间使用旧版插件');assert.equal(await openCount(),0);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('cyber.activePlugin'))),null);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('cyber.plugin.data.official.chess')).save),'preserve-fixture');assert.equal(await installedCard.getByRole('heading').textContent(),'翻棋');assert.equal(await page.getByRole('button',{name:'移除不可用版本'}).count(),0);
  await clearToast();await page.locator('.room-card').click();await toast('请房主升级插件并重新创建房间');assert.equal(await openCount(),0,'old room must never run latest code under an old binding');
  await update();
  catalogFailure=true;await clearToast();await button('创建房间').click();await toast('插件市场请求失败');assert.equal(await page.locator('#create-dialog').isVisible(),false);await clearToast();await page.locator('.room-card').click();await toast('插件市场请求失败');assert.equal(await openCount(),0,'failed refresh must also block joining');catalogFailure=false;
  await button('创建房间').click();await page.locator('#create-dialog').waitFor();current=records[2];await clearToast();await page.click('#create-submit');await toast('插件已更新');assert.equal(await openCount(),0,'a release change while editing create settings must reject submission');await page.locator('#create-dialog .dialog-close').click();await update();
  // Two rapid launches share no ownership: only the first may show a create dialog.
  let resume;catalogWait=new Promise(resolve=>resume=resolve);await page.evaluate(()=>{const button=document.querySelector('#installed .primary');button.click();button.click();});await toast('正在核对插件版本');resume();catalogWait=null;await page.locator('#create-dialog').waitFor();assert.equal(await openCount(),0);await page.click('#create-submit');await page.locator('#close-plugin').waitFor();assert.equal(await openCount(),1);assert.deepEqual(await page.evaluate(()=>opened[0].command.mode),'create');assert.equal(await page.evaluate(()=>opened[0].release),records[2].release);await leave();
  roomRecord=records[2];locked=true;await page.click('#refresh');await page.locator('.room-card').filter({hasText:'密码房间'}).waitFor();await page.locator('.room-card').click();await page.locator('#password-dialog').waitFor();current=records[3];await clearToast();await page.fill('#password-value','fixture');await page.locator('#password-form button[type=submit]').click();await toast('请房主升级插件并重新创建房间');assert.equal(await openCount(),1,'password wait must not retain permission to enter an obsolete release');
  await update();roomRecord=records[3];locked=false;await page.click('#refresh');await page.locator('.room-card').filter({hasText:'欢迎加入'}).waitFor();await page.locator('.room-card').click();await page.locator('#close-plugin').waitFor();assert.equal(await openCount(),2);assert.equal(await page.evaluate(()=>opened[1].release),records[3].release);assert.equal(await page.evaluate(()=>JSON.parse(opened[1].command.room.metadata).release),records[3].release);assert.equal(await page.evaluate(()=>opened[1].command.mode),'join');
  await leave();await page.evaluate(record=>localStorage.setItem('cyber.activePlugin',JSON.stringify({id:record.id,release:record.release})),records[3]);catalogWait=new Promise(resolve=>resume=resolve);await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('#market-status').textContent.startsWith('正在核对'));assert.equal(await openCount(),0,'cached recovery must wait for fresh market verification');resume();catalogWait=null;await page.locator('#close-plugin').waitFor();assert.equal(await page.evaluate(()=>opened[0].command.mode),'recover');assert.equal(await page.evaluate(()=>opened[0].release),records[3].release);
  assert.deepEqual(errors,[]);console.log('PASS latest-only lobby: named update cards, failed-market recovery/create/join blocking, personal-save preservation, old-room rejection, create/password release-change gates, concurrent-launch ownership and freshly verified create/join/recover bindings');
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
