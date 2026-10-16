// Local visual/interaction fixtures: real lobby renderer/store and player UI, no external rooms/media.
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),web=path.join(root,'server/src/main/resources/web'),out=path.join(root,'server/target/ui-review');fs.mkdirSync(out,{recursive:true});
const read=p=>fs.readFileSync(path.join(root,p),'utf8'),key=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),files=new Map(),records=[];
for(const name of ['chess','miner','watch']){
 const manifest=JSON.parse(read(`plugins/${name}/manifest.json`));manifest.targets={web:{entry:'app.js'}};
 const cover='data:image/svg+xml;base64,'+Buffer.from(read(`plugins/${name}/assets/cover.svg`)).toString('base64');
 const raw=JSON.stringify({manifest,script:'export {};',html:'<p>Local fixture</p>',style:'',assets:{[manifest.cover]:cover}}),sha=crypto.createHash('sha256').update(raw).digest('hex'),artifact={path:`${manifest.id}/${manifest.version}/web-${sha}.json`,sha256:sha,size:Buffer.byteLength(raw)},artifacts={web:artifact},release=crypto.createHash('sha256').update(JSON.stringify({manifest,artifacts})).digest('hex');
 files.set('/plugins/'+artifact.path,raw);records.push({id:manifest.id,version:manifest.version,release,manifest,artifacts,cover});
}
const payload=JSON.stringify({schemaVersion:1,releases:records}),envelope={payload,signature:crypto.sign('sha256',Buffer.from(payload),{key:key.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')};
files.set('/plugin-trust.json',JSON.stringify({keys:[key.publicKey.export({format:'jwk'})]}));files.set('/plugins/catalog.json',JSON.stringify(envelope));
let transport=fs.readFileSync(path.join(web,'transport.js'),'utf8').replace('export class RoomClient','class RealRoomClient');
transport+=`\nexport class RoomClient{constructor(callbacks){this.callbacks=callbacks;this.peerReady=new Set();this.peerLatency=new Map();this.peerQuality=new Map();this.ready=true;this.identity={clientId:'fixture',capabilities:['room-sync','room-broadcast','host-grant','room-descriptors']};this.generation=1;}identityKey(){return 'ui-fixture';}connect(){this.callbacks.connected(this.identity,false);}listRooms(){return Promise.resolve(${JSON.stringify(records.map((r,i)=>({roomId:String(i+1).repeat(32),name:['来一局，等一个对手','周五一起淘金','今晚看点什么'][i],metadata:JSON.stringify({id:r.id,release:r.release}),locked:i===2})))});}clearPeers(){}}
`;
files.set('/transport.js',transport);
const movie=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${read('plugin_sdk/style.css')}</style><body class="watch-active"><main>${read('plugins/watch/view.html')}</main><script type="module">
import {playerUI} from '/plugins-source/watch/player-ui.js';
const $=id=>document.getElementById(id);$('watch').hidden=false;$('watch-name').textContent='今晚的电影';$('watch-title').textContent='星际旅行 · 本地界面预览';$('watch-time').textContent='12:30 / 1:48:00';$('watch-key-hint').textContent='';
const state={epoch:'fixture',playing:true,rate:1.25,duration:6480,position:750};window.watch={active:true,url:'fixture',loading:false,room:{host:true,room:{playback:state},context:()=> 'fixture-room'},current:()=>state.position,bounds(){},async skip(n){state.position=Math.max(0,Math.min(state.duration,state.position+n));},async control(playing,position=state.position,rate=state.rate){Object.assign(state,{playing,position,rate});}};
window.ui=playerUI(watch,e=>{throw e;});$('watch-back').onclick=()=>watch.skip(-10);$('watch-forward').onclick=()=>watch.skip(30);$('watch-play').onclick=()=>watch.control(!state.playing);
</script>`;
files.set('/movie',movie);
const server=http.createServer((req,res)=>{
 const name=new URL(req.url,'http://local').pathname;let body=files.get(name),file;
 if(body===undefined){file=name.startsWith('/plugins-source/')?path.join(root,'plugins',name.slice(16)):path.join(web,name==='/'?'index.html':name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}body=fs.readFileSync(file);}
 const type=name==='/movie'||name==='/'?'text/html':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'application/json';res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body);
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(url);await page.click('#market-open');await page.locator('#market-list .card').first().waitFor();
  for(const name of ['翻棋','黄金矿工','电影厅']){const card=page.locator('#market-list .card').filter({has:page.getByRole('heading',{name,exact:true})});await card.getByRole('button',{name:'安装',exact:true}).click();await card.getByRole('button',{name:'已安装',exact:true}).waitFor();}
  await page.screenshot({path:path.join(out,'market-desktop.png')});await page.locator('#market-dialog .dialog-close').click();await page.click('#download-dismiss');await page.evaluate(()=>document.querySelector('#toast').hidden=true);await page.locator('.room-card').first().waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('#installed .plugin-cover img')].length===3&&[...document.querySelectorAll('#installed .plugin-cover img')].every(i=>i.complete&&i.naturalWidth));
  await page.waitForFunction(()=>document.querySelectorAll('.room-art img').length===3);
  await page.screenshot({path:path.join(out,'lobby-desktop.png'),fullPage:true});
  for(const [width,height]of [[390,844],[844,390]]){await page.setViewportSize({width,height});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,`lobby-${width}.png`),fullPage:true});}
  await page.setViewportSize({width:1280,height:720});await page.goto(url+'/movie');await page.waitForFunction(()=>!!window.ui);await page.locator('body').click({position:{x:10,y:10}});
  await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>watch.room.room.playback.playing),false);
  await page.keyboard.press('ArrowLeft');assert.equal(await page.evaluate(()=>watch.current()),740);await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>watch.current()),770);
  await page.keyboard.down('ArrowRight');await page.waitForTimeout(450);assert.equal(await page.evaluate(()=>watch.room.room.playback.rate),2);await page.keyboard.up('ArrowRight');assert.equal(await page.evaluate(()=>watch.room.room.playback.rate),1.25);assert.equal(await page.evaluate(()=>watch.room.room.playback.playing),false);
  await page.keyboard.down('ArrowLeft');await page.waitForTimeout(850);await page.keyboard.up('ArrowLeft');const rewound=await page.evaluate(()=>watch.current());assert(rewound<=750);await page.waitForTimeout(450);assert.equal(await page.evaluate(()=>watch.current()),rewound);
  await page.focus('#danmaku-text');await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>watch.room.room.playback.playing),false);await page.evaluate(()=>{document.activeElement.blur();watch.room.host=false;});await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>watch.current()),rewound);await page.evaluate(()=>watch.room.host=true);
  await page.click('#watch-fullscreen');await page.waitForFunction(()=>!!document.fullscreenElement);await page.mouse.move(500,180);await page.screenshot({path:path.join(out,'player-fullscreen.png')});
  assert.deepEqual(await page.locator('#watch-screen').evaluate(e=>({w:e.clientWidth,h:e.clientHeight})),{w:1280,h:720});await page.waitForTimeout(3200);assert(await page.locator('#watch-stage').evaluate(e=>e.classList.contains('controls-hidden')));
  await page.mouse.move(600,190);assert.equal(await page.locator('.cinema-playback').evaluate(e=>e.inert),false);await page.click('.watch-settings summary');await page.mouse.move(400,100);await page.waitForTimeout(3100);assert.equal(await page.locator('.cinema-playback').evaluate(e=>e.inert),false);
  await page.evaluate(()=>document.exitFullscreen());await page.setViewportSize({width:844,height:390});await page.click('#watch-fullscreen');await page.screenshot({path:path.join(out,'player-landscape.png')});assert(await page.locator('#watch-forward').isVisible());
  await page.evaluate(()=>document.exitFullscreen());
  await page.evaluate(()=>{window.iosFullCalls=0;watch.video={readyState:1,webkitEnterFullscreen(){iosFullCalls++;}};Object.defineProperty(document,'fullscreenEnabled',{configurable:true,value:false});});
  await page.click('#watch-fullscreen');assert.equal(await page.evaluate(()=>iosFullCalls),1,'iOS video API bypasses unavailable element fullscreen');
  await page.goto(url);await page.waitForFunction(()=>document.querySelector('#status').textContent==='已连接');await page.evaluate(async record=>{
   const {PluginRuntime}=await import('/plugin-runtime.js');
   const client={peerReady:[],peerLatency:[],peerQuality:[],identityKey:()=> 'permission-fixture'};
   window.permissionRuntime=new PluginRuntime(client,document.getElementById('plugin-container'));
   await permissionRuntime.open({record,payload:{html:'<button id="full">Full</button><button id="awake">Awake</button>',style:'',assets:{},script:`parent.postMessage({type:'cyber:ready'},'*');document.getElementById('full').onclick=()=>document.documentElement.requestFullscreen();document.getElementById('awake').onclick=async()=>{try{window.lock=await navigator.wakeLock.request('screen');window.wakeResult='acquired';}catch(e){window.wakeResult=e.name+':'+e.message;}};`}},{mode:'create'});
   document.getElementById('plugin-container').hidden=false;
   document.getElementById('home').hidden=true;
  },records[2]);
  const frame=page.frameLocator('#plugin-frame');await frame.locator('#full').click();await page.waitForFunction(()=>!!document.fullscreenElement);await page.evaluate(()=>document.exitFullscreen());
  await frame.locator('#awake').click();const child=page.frames().find(f=>f.parentFrame());await child.waitForFunction(()=>!!window.wakeResult);assert.equal(await child.evaluate(()=>wakeResult),'acquired');await child.evaluate(()=>lock.release());
  assert.deepEqual(errors,[]);console.log('PASS lobby covers, install progress, responsive layouts; host-only keyboard, hold/restore, typing isolation, fullscreen size, idle/wake, settings persistence; real opaque plugin iframe fullscreen and screen wake lock. Screenshots: '+out);
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
