// Local HTTP + production WatchRoom + production libmpv Player. Never opens a window.
import './plugin-test-host.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import readline from 'node:readline';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const input=process.env.WATCH_TEST_MEDIA,ffmpeg=process.env.FFMPEG||'ffmpeg';
assert.ok(input&&process.env.MPV_DLL_DIR,'Set WATCH_TEST_MEDIA and MPV_DLL_DIR to local fixture/runtime paths');
const out=path.resolve('server/target/quality-regression');fs.mkdirSync(out,{recursive:true});
for(const start of [0,30,60,90]){
 const dir=path.join(out,String(start));fs.mkdirSync(dir,{recursive:true});
 const result=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-ss',String(start),'-i',input,'-t','15','-an','-vf','scale=320:-2','-c:v','libx264','-preset','ultrafast','-g','24','-f','hls','-hls_time','2','-hls_list_size','0',path.join(dir,'master.m3u8')],{windowsHide:true});
 assert.equal(result.status,0,result.stderr?.toString());
}
let session=0;const starts=[],sessions=new Map();
const guestBundle=(await build({stdin:{contents:`import {WatchRoom} from './plugins/watch/watch.js';window.makeGuest=(state)=>{const room={host:false,self:'browser',room:{game:'watch',hostId:'fixture',members:[],playback:state},client:{ready:true},context:()=>1,current:c=>c===1};const w=window.watch=new WatchRoom(room,console.log);clearInterval(w.timer);clearInterval(w.subtitleTimer);w.render=()=>{};w.checkin=async()=>{};w.access={base:location.origin,token:'local',userId:'fixture'};w.muted=true;return w.load(state);};`,resolveDir:process.cwd()},bundle:true,format:'esm',write:false})).outputFiles[0].text;
const server=http.createServer(async(req,res)=>{
 try{
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Emby-Token,X-Emby-Authorization');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/guest'){res.setHeader('Content-Type','text/html');res.end(fs.readFileSync('plugins/watch/view.html','utf8')+`<script>window.__CYBER_TEST_BOOTSTRAP__={platform:'web',storage:{},assets:{}};</script><script src="/hls.js"></script><script type="module" src="/guest.js"></script>`);return;}
  if(url.pathname==='/guest.js'||url.pathname==='/hls.js'){res.setHeader('Content-Type','text/javascript');res.end(url.pathname==='/guest.js'?guestBundle:fs.readFileSync('plugins/watch/vendor/hls.min.js'));return;}
  if(url.pathname.endsWith('/PlaybackInfo')){for await(const _ of req){}const id=String(++session);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({PlaySessionId:id,MediaSources:[{Id:'local',RunTimeTicks:120e7,Container:'mp4',SupportsDirectPlay:true,MediaStreams:[{Index:0,Type:'Video',Codec:'h264'}],TranscodingUrl:`/hls/${id}/master.m3u8?StartTimeTicks=0`}]}));return;}
  let file;
  if(url.pathname.startsWith('/hls/')){const [, ,id,name]=url.pathname.split('/');if(name==='master.m3u8'){const start=Number(url.searchParams.get('StartTimeTicks')||0)/1e7;starts.push(start);sessions.set(id,start);}file=path.join(out,String(sessions.get(id)||0),path.basename(name));}
  else if(url.pathname.endsWith('/stream.mp4'))file=input;
  else{res.end('{}');return;}
  const size=fs.statSync(file).size,range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
  const from=range?Number(range[1]):0,to=range&&range[2]?Math.min(size-1,Number(range[2])):size-1;
  res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Length',to-from+1);
  res.setHeader('Content-Type',file.endsWith('.m3u8')?'application/vnd.apple.mpegurl':file.endsWith('.ts')?'video/mp2t':'video/mp4');
  if(range){res.statusCode=206;res.setHeader('Content-Range',`bytes ${from}-${to}/${size}`);}fs.createReadStream(file,{start:from,end:to}).pipe(res);
 }catch(e){res.statusCode=500;res.end(String(e));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let child,watch,latest,log='',failure,browser;
const send=q=>child.stdin.write(JSON.stringify(q)+'\n');
const wait=async(test,label)=>{const end=Date.now()+30000;while(Date.now()<end){if(failure)throw failure;if(test())return;await new Promise(r=>setTimeout(r,50));}throw Error(`Timeout: ${label}\n${log.slice(-2000)}`);};
try{
 child=spawn('cargo',['test','--manifest-path','plugins/watch/native/windows/Cargo.toml','headless_quality_player','--','--ignored','--nocapture'],{windowsHide:true,env:process.env,stdio:['pipe','pipe','pipe']});
 child.on('error',e=>failure=e);child.on('exit',code=>{if(code)failure=Error(`Player exited ${code}`);});
 child.stderr.on('data',s=>log+=s);readline.createInterface({input:child.stdout}).on('line',line=>{log+=line+'\n';const at=line.indexOf('QUALITY_STATE ');if(at>=0){latest=JSON.parse(line.slice(at+14));if(watch)watch.event({type:'player',...latest}).catch(e=>failure=e);}});
 globalThis.NativeRoom={platform:'WINDOWS',playerCapabilities:{engine:'mpv',embeddedTracks:true},mediaConfigure(){},playerCommand:text=>send(JSON.parse(text))};
 const {WatchRoom}=await import('../plugins/watch/watch.js');
 const state={epoch:'fixture',itemId:'movie',position:60,duration:120,version:1,playing:false,rate:1,at:performance.now()};
 const room={host:true,self:'fixture',room:{game:'watch',playback:state},client:{ready:true},context:()=>1,current:c=>c===1,checkpoint(){}};
 watch=Object.assign(Object.create(WatchRoom.prototype),{room,generation:0,quality:'auto',epoch:'fixture',position:60,duration:120,access:{base:`http://127.0.0.1:${server.address().port}`,token:'local',userId:'fixture'},video:{seeking:false},voice:{event(){}},render(){},rectangle:()=>({x:0,y:0,width:320,height:180}),playerVisible:()=>false,send:async()=>{},saveHost:async()=>{},scheduleHostSave(){},checkin:async()=>{},loadSubtitles:async()=>{},stopMedia:async()=>{send({stop:true});watch.url='';watch.pendingSeek=null;}});
 await wait(()=>latest,'player ready');
 await watch.load(state);await wait(()=>latest.playbackId===watch.playbackId&&!latest.seeking&&Math.abs(watch.current()-60)<1,'direct seek 60');
 await watch.setQuality('1080');await wait(()=>latest.playbackId===watch.playbackId&&!latest.seeking&&latest.durationMs>0,'1080p first frame');
 assert.ok(Math.abs(starts.at(-1)-60)<1,`1080p actual stream starts at ${starts.at(-1)}, expected 60`);
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();page.on('pageerror',e=>failure=e);
 await page.goto(watch.access.base+'/guest');await page.waitForFunction(()=>!!window.makeGuest);
 await page.evaluate(state=>makeGuest(state),{...state});
 await page.waitForFunction(()=>watch.video.readyState>=2&&Math.abs(watch.current()-60)<1);
 await page.evaluate(()=>watch.setQuality('1080'));
 await page.waitForFunction(()=>watch.video.readyState>=2&&!watch.loading&&Math.abs(watch.current()-60)<1);
 for(const target of [90,30,60]){
  await watch.control(false,target);await wait(()=>latest.playbackId===watch.playbackId&&!latest.seeking&&latest.durationMs>0,`seek ${target}`);
  assert.equal(starts.at(-1),target,'HTTP stream must start at the requested movie position');assert.ok(Math.abs(watch.current()-target)<1);
  await page.evaluate(state=>watch.event({type:'watch.state',from:'fixture',body:state}),{...state});
  await page.waitForFunction(target=>!watch.loading&&watch.video.readyState>=2&&Math.abs(watch.current()-target)<1,target);
 }
 await watch.control(true);await page.evaluate(state=>watch.event({type:'watch.state',from:'fixture',body:state}),{...state});await wait(()=>watch.current()>61&&!latest.seeking,'decoded playback advances after repeated seeks');
 await page.waitForFunction(()=>!watch.video.paused&&watch.current()>61&&watch.video.videoWidth>0);
 assert.equal(state.playing,true);assert.equal(watch.error,'');
 console.log('PASS real muted/headless mpv host + browser guest: direct 60s -> 1080p -> 90s -> 30s -> 60s -> both decoders advance; actual HTTP starts verified');
}finally{
 if(browser)await browser.close();
 if(child&&!child.killed){send({quit:true});child.stdin.end();}
 server.closeAllConnections();await new Promise(r=>server.close(r));
 fs.writeFileSync(path.join(out,'player.log'),log);
}
