// Local render/clock benchmark: real miner UI, engine, Canvas and decoded art.
// CPU throttling is a reproducible stress condition, not an Android-device FPS claim.
const {chromium}=require('playwright'),{build}=require('esbuild'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),out=path.join(root,'server/target/miner-performance'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const baseline=path.join(root,'server/target/miner-baseline'),versions=process.argv.includes('--compare')?['baseline','current']:[process.argv.includes('--baseline')?'baseline':'current'];
const duration=Number(process.env.MINER_PERF_SECONDS||6)*1000;
const assets=Object.fromEntries(['deep-mine.png','miner-atlas.png'].map(n=>['assets/'+n,'data:image/png;base64,'+fs.readFileSync(path.join(root,'plugins/miner/assets',n)).toString('base64')]));
const fixture=`import {GoldMine} from './plugins/miner/miner.js';
export const $=id=>document.getElementById(id),text=(id,value)=>{const e=$(id);if(e&&e.textContent!==String(value))e.textContent=value;};
export function element(tag,cls='',value){const e=document.createElement(tag);e.className=cls;if(value!==undefined)e.textContent=value;return e;}
export const toast=()=>{},fail=e=>{throw e;},confirm=async()=>false,memberBadge=()=>element('small','member-path','中转 · 36 ms');
export function fullscreen(id,button){$(button).onclick=()=>document.fullscreenElement?document.exitFullscreen():$(id).requestFullscreen();}
export function mount(rules,view){const engine=window.engine=new GoldMine(42,[{id:'a',name:'玩家 A'},{id:'b',name:'玩家 B'},{id:'c',name:'玩家 C'}],1000);const game=window.fixture={engine,self:'a',host:true,client:{ready:true},stateAt:performance.now(),room:{game:'miner',status:'playing'},state:engine.snapshot(),action:async a=>engine.act('a',a),saveProgress(){}};window.renderFixture=()=>view.render();queueMicrotask(renderFixture);return game;}`;
const harness=`import {MinerView} from './plugins/miner/miner-view.js';
const metrics=window.metrics={frames:[],draw:[],simulation:[],wire:[],render:[],canvasCreates:0,canvasResizes:0,longTasks:[]};let measuring=false;
const create=document.createElement.bind(document);document.createElement=(name,...args)=>{if(measuring&&name==='canvas')metrics.canvasCreates++;return create(name,...args);};
for(const key of ['width','height']){const p=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key);Object.defineProperty(HTMLCanvasElement.prototype,key,{...p,set(v){if(measuring)metrics.canvasResizes++;p.set.call(this,v);}});}
const draw=MinerView.prototype.draw,player=MinerView.prototype.player,setState=MinerView.prototype.setState;
MinerView.prototype.setState=function(...args){window.view=this;return setState.apply(this,args);};
MinerView.prototype.draw=function(now){const at=performance.now();this._benchmarkNow=now;draw.call(this,now);if(measuring)metrics.draw.push(performance.now()-at);};
MinerView.prototype.player=function(c,p,...rest){if(measuring&&p.slot===0){const claw=p.claw;metrics.frames.push({at:this._benchmarkNow,angle:claw.angle,length:claw.length,mode:claw.mode,truthAngle:engine.players[0].claw.angle,truthLength:engine.players[0].claw.length});}return player.call(this,c,p,...rest);};
new PerformanceObserver(list=>{if(measuring)for(const e of list.getEntries())metrics.longTasks.push(e.duration);}).observe({type:'longtask'});
await import('./plugins/miner/app.js');
window.begin=async(config)=>{
 await view.prepare();await new Promise(r=>setTimeout(r,200));metrics.frames=[];metrics.draw=[];metrics.simulation=[];metrics.wire=[];metrics.render=[];metrics.canvasCreates=metrics.canvasResizes=0;metrics.longTasks=[];measuring=true;
 const started=performance.now();let last=started,packet=0,closed=false,publishTimer;window.lastPacket=0;
 // The simulation uses actual elapsed wall time, as PluginRoom.tick does.
 const simulation=setInterval(()=>{const now=performance.now(),dt=(now-last)/1000;last=now;const at=performance.now();engine.step(dt);metrics.simulation.push(performance.now()-at);},33);
 const publish=()=>{if(closed)return;const at=performance.now();const raw=JSON.stringify({state:engine.snapshot()});const bytes=new TextEncoder().encode(raw);const state=JSON.parse(new TextDecoder().decode(bytes)).state;metrics.wire.push({ms:performance.now()-at,bytes:bytes.length});fixture.state=state;fixture.stateAt=performance.now();const renderAt=performance.now();renderFixture();metrics.render.push(performance.now()-renderAt);window.lastPacket=fixture.stateAt;publishTimer=setTimeout(publish,config.intervals[packet++%config.intervals.length]);};publish();
 return await new Promise(resolve=>setTimeout(()=>{closed=true;clearInterval(simulation);clearTimeout(publishTimer);measuring=false;view.suspended=true;resolve({...metrics,elapsedMs:performance.now()-started,canvas:{width:view.canvas.width,height:view.canvas.height,clientWidth:view.canvas.clientWidth,clientHeight:view.canvas.clientHeight},spriteCount:view.sprites?.size,croppedAssets:view.artCache?.size});},config.duration));
};`;
const cases=[
 {name:'desktop-steady',viewport:{width:1280,height:720},dpr:1,cpu:1,intervals:[132]},
 {name:'phone-jitter',viewport:{width:390,height:844},dpr:3,cpu:1,intervals:[80,240,110,310,90,180,130]},
 {name:'phone-jitter-cpu6',viewport:{width:390,height:844},dpr:3,cpu:6,intervals:[80,240,110,310,90,180,130]},
];
function stats(values){const v=[...values].sort((a,b)=>a-b);return {count:v.length,mean:v.reduce((s,n)=>s+n,0)/(v.length||1),p50:v[Math.floor(v.length*.5)]||0,p95:v[Math.floor(v.length*.95)]||0,max:v.at(-1)||0};}
function summarize(raw){
 const dt=[],speeds=[];let frozen=0,slow=0,fast=0;
 for(let i=1;i<raw.frames.length;i++){const a=raw.frames[i-1],b=raw.frames[i],elapsed=(b.at-a.at)/1000;dt.push(elapsed*1000);if(elapsed<=0||a.mode!=='swing'||b.mode!=='swing'||Math.abs(a.angle)>1.05||Math.abs(b.angle)>1.05)continue;const speed=Math.abs(b.angle-a.angle)/elapsed;speeds.push(speed);if(speed<.001)frozen++;if(speed<.425)slow++;if(speed>1.275)fast++;}
 return {elapsedMs:raw.elapsedMs,frames:raw.frames.length,frameIntervalMs:stats(dt),frameIntervalsOver50ms:dt.filter(n=>n>50).length,drawCpuMs:stats(raw.draw),simulationCpuMs:stats(raw.simulation),snapshotWireCpuMs:stats(raw.wire.map(n=>n.ms)),snapshotBytes:stats(raw.wire.map(n=>n.bytes)),snapshotRenderCpuMs:stats(raw.render),swingSpeedRadSec:stats(speeds),expectedSwingSpeedRadSec:.85,frozenSwingFrames:frozen,frozenSwingPercent:100*frozen/(speeds.length||1),slowSwingPercent:100*slow/(speeds.length||1),fastSwingPercent:100*fast/(speeds.length||1),canvasCreates:raw.canvasCreates,canvasDimensionWrites:raw.canvasResizes,longTaskMs:stats(raw.longTasks),canvas:raw.canvas,spriteCount:raw.spriteCount,croppedAssets:raw.croppedAssets};
}
(async()=>{
 fs.mkdirSync(out,{recursive:true});const pages=new Map(),sourceHashes={};
 for(const version of versions){
  sourceHashes[version]={};for(const name of ['miner-view.js','miner.js','app.js',...(version==='current'?['miner-motion.js']:[])]){const file=version==='baseline'?path.join(baseline,name):path.join(root,'plugins/miner',name);sourceHashes[version][name]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
  const result=await build({stdin:{contents:harness,resolveDir:root},write:false,bundle:true,format:'esm',plugins:[{name:'benchmark-fixture',setup(b){b.onResolve({filter:/plugin_sdk\/ui\.js$/},()=>({path:'ui',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:fixture,resolveDir:root}));if(version==='baseline')b.onLoad({filter:/plugins[\\/]miner[\\/](miner-view|miner|rules|app)\.js$/},a=>({contents:fs.readFileSync(path.join(baseline,path.basename(a.path)),'utf8'),resolveDir:path.join(root,'plugins/miner')}));}}]});
  pages.set('/'+version,`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${read('plugin_sdk/style.css')}</style><main>${read('plugins/miner/view.html')}</main><script>window.__CYBER_TEST_BOOTSTRAP__={platform:'web',assets:${JSON.stringify(assets)},storage:{'cyber.sound':false}};document.getElementById('miner').hidden=false;</script><script type="module">${result.outputFiles[0].text}</script>`);
 }
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(pages.get(req.url)||'');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'msedge',headless:true}),report={recordedAt:new Date().toISOString(),sourceHashes,durationMs:duration,note:'Headless Edge on this Windows host; CDP CPU stress is not Android hardware or GPU validation.',results:[]};
 try{for(const version of versions)for(const config of cases){
  const context=await browser.newContext({viewport:config.viewport,deviceScaleFactor:config.dpr,hasTouch:config.dpr>1}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:config.cpu});await page.goto('http://127.0.0.1:'+server.address().port+'/'+version);await page.waitForFunction(()=>!!window.begin);const raw=await page.evaluate(config=>begin(config),{intervals:config.intervals,duration});assert.deepEqual(errors,[]);assert(raw.frames.length>0,'real canvas paints');assert(raw.spriteCount>0&&raw.croppedAssets>0,'real PNGs decoded and cached');const result={version,case:config.name,config,...summarize(raw)};report.results.push(result);fs.writeFileSync(path.join(out,`${version}-${config.name}-trace.json`),JSON.stringify(raw));await page.screenshot({path:path.join(out,`${version}-${config.name}.png`)});console.log(JSON.stringify(result));await context.close();
 }}finally{await browser.close();server.close();fs.writeFileSync(path.join(out,versions.join('-')+'-report.json'),JSON.stringify(report,null,2));}
 console.log('Performance observations saved to '+out+'; no physical-device FPS guarantee.');
})().catch(e=>{console.error(e);process.exitCode=1;});
