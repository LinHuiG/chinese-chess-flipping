// Local-source EXE only, isolated CDP profile; no account or production server.
// Provides a throttled, cancellable HTTP range source and exercises sustained
// slider input, pause, stop under load, and a subsequent independent playback.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const bytes=fs.readFileSync(path.resolve(process.env.MEDIA_FIXTURE||'server/target/watch-fixtures/seek-stress.mp4'));
let requests=0,aborted=0,active=0,maxActive=0,delays=0;
const server=http.createServer((req,res)=>{
 const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
 let offset=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;
 requests++;active++;maxActive=Math.max(maxActive,active);let finished=false,timer;
 res.on('close',()=>{active--;if(!finished)aborted++;clearTimeout(timer);});
 if(offset>end){res.writeHead(416,{'Content-Range':`bytes */${bytes.length}`});res.end();return;}
 const send=()=>{
  if(res.destroyed)return;
  const next=Math.min(offset+32768,end+1);res.write(bytes.subarray(offset,next));offset=next;
  if(offset>end){finished=true;res.end();return;}
  timer=setTimeout(send,120);
 };
 timer=setTimeout(()=>{if(res.destroyed)return;
  const headers={'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-offset+1,'Access-Control-Allow-Origin':'*'};
  if(range)headers['Content-Range']=`bytes ${offset}-${end}/${bytes.length}`;
  res.writeHead(range?206:200,headers);delays++;send();
 },requests===1?0:450);
});
(async()=>{let browser,page;const samples=[];try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.connectOverCDP(process.env.CDP_URL||'http://127.0.0.1:19224');
 page=browser.contexts()[0].pages().find(p=>p.url().includes('tauri.localhost'));assert(page,'native app is required');
 await page.evaluate(()=>{window.__seekStress=[];window.__seekListener=e=>{if(e.detail.type==='player'){window.__seekStress.push({...e.detail,received:performance.now()});if(window.__seekStress.length>2000)window.__seekStress.shift();}};window.addEventListener('native-room',window.__seekListener);});
 const command=fields=>page.evaluate(v=>NativeRoom.playerCommand(JSON.stringify(v)),fields);
 const load=async id=>{await page.evaluate(o=>NativeRoom.mediaConfigure(JSON.stringify({origin:o})),origin);await command({url:origin+'/movie.mp4',playbackId:id,seekId:id+'-initial',positionMs:0,playing:true,volume:0.05,rate:1,bounds:{x:20,y:120,width:800,height:450},visible:true});
 await page.waitForFunction(id=>{const e=window.__seekStress.at(-1);return e&&e.playbackId===id&&!e.seeking&&e.playing&&!e.error;},id,{timeout:30000});};
 const check=async(id,seekId,target)=>{await page.waitForFunction(({id,seekId,target})=>{const e=window.__seekStress.at(-1);return e&&e.playbackId===id&&e.seekId===seekId&&!e.seeking&&e.playing&&!e.error&&Math.abs(e.positionMs-target)<5000;},{id,seekId,target},{timeout:20000});const a=await page.evaluate(()=>window.__seekStress.at(-1));await page.waitForTimeout(1300);const b=await page.evaluate(()=>window.__seekStress.at(-1));assert(b.positionMs>a.positionMs+400,'decoded playback must keep advancing');samples.push(b);};
 await load('slow');
 // 80 sustained changes, alternately jumping into unread distant HTTP ranges.
 const sustained=await page.evaluate(async()=>{const durations=[];for(let i=0;i<80;i++){const at=performance.now();await NativeRoom.playerCommand(JSON.stringify({playbackId:'slow',seekId:'slow-'+i,positionMs:(i%2?10:90)*1000+(i%5)*1000,playing:true}));durations.push(performance.now()-at);await new Promise(r=>setTimeout(r,160));}return durations;});
 await command({playbackId:'slow',seekId:'slow-final',positionMs:45000,playing:true});await check('slow','slow-final',45000);
 // Burst above the previous 64-slot capacity. Every promise must resolve, and
 // only the newest desired position is retained rather than replaying a queue.
 const burst=await page.evaluate(async()=>{const at=performance.now();await Promise.all(Array.from({length:240},(_,i)=>NativeRoom.playerCommand(JSON.stringify({playbackId:'slow',seekId:'burst-'+i,positionMs:(i%100)*1000,playing:true}))));return performance.now()-at;});
 await command({playbackId:'slow',seekId:'burst-final',positionMs:20000,playing:true});await check('slow','burst-final',20000);
 await command({playbackId:'slow',seekId:'paused',positionMs:60000,playing:false});await page.waitForFunction(()=>{const e=window.__seekStress.at(-1);return e?.seekId==='paused'&&!e.seeking&&!e.playing&&Math.abs(e.positionMs-60000)<1000;},null,{timeout:20000});
 // Stop must resolve while the new target is still waiting on the slow source.
 await command({playbackId:'slow',seekId:'stop-pending',positionMs:105000,playing:true});
 const stop=await page.evaluate(async()=>{const at=performance.now();await NativeRoom.playerStop();return performance.now()-at;});assert(stop<1000,`stop IPC stalled for ${stop}ms`);
 await page.waitForFunction(()=>{const e=window.__seekStress.at(-1);return e&&e.playbackId===''&&!e.playing;},null,{timeout:3000});
 await load('fresh');await command({playbackId:'fresh',seekId:'fresh-final',positionMs:15000,playing:true});await check('fresh','fresh-final',15000);
 const errors=await page.evaluate(()=>window.__seekStress.filter(e=>e.error).map(e=>({error:e.error,seekId:e.seekId})));assert.deepEqual(errors,[]);
 assert(requests>=3,'fixture must actually exercise multiple HTTP range requests');
 console.log(JSON.stringify({ok:true,requests,aborted,maxActive,delayedResponses:delays,seekCommands:325,sustainedCommands:80,burstCommands:240,maxCommandMs:Math.max(...sustained),burstMs:burst,stopMs:stop,verified:samples.map(s=>({playbackId:s.playbackId,seekId:s.seekId,positionMs:s.positionMs,seeking:s.seeking,audioOutput:s.audioOutput,audioPcmPeak:s.audioPcmPeak})),errors}));
}catch(error){console.log(JSON.stringify({ok:false,error:error.message,requests,aborted,maxActive,lastStates:page?await page.evaluate(()=>window.__seekStress.slice(-14)).catch(()=>[]):[]}));process.exitCode=1;}
finally{if(page)await page.evaluate(async()=>{await NativeRoom.playerStop();window.removeEventListener('native-room',window.__seekListener);}).catch(()=>{});if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}})();
