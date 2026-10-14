// Bounded local-only player regression. Run against an isolated EXE with
// CYBER_ROOM_MEDIA_DIAGNOSTICS=1 and CDP19224. No account credentials needed.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const fixture=path.resolve(process.env.MEDIA_FIXTURE||'server/target/watch-fixtures/eac3.mkv');
const buffer=fs.readFileSync(fixture);
const server=http.createServer((request,response)=>{
 const match=/^bytes=(\d+)-(\d*)$/.exec(request.headers.range||'');let start=match?Number(match[1]):0,end=match&&match[2]?Math.min(Number(match[2]),buffer.length-1):buffer.length-1;
 response.setHeader('Accept-Ranges','bytes');response.setHeader('Content-Type','video/x-matroska');response.setHeader('Access-Control-Allow-Origin','*');
 if(start>=buffer.length){response.writeHead(416,{'Content-Range':`bytes */${buffer.length}`});response.end();return;}
 if(match)response.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${buffer.length}`,'Content-Length':end-start+1});else response.setHeader('Content-Length',buffer.length);
 response.end(buffer.subarray(start,end+1));
});
(async()=>{let browser,page;try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.connectOverCDP(process.env.CDP_URL||'http://127.0.0.1:19224');page=browser.contexts()[0].pages().find(p=>p.url().includes('tauri.localhost'))||browser.contexts()[0].pages()[0];
 await page.evaluate(()=>{window.__nativePlayerStates=[];window.__nativePlayerListener=e=>{if(e.detail.type==='player')window.__nativePlayerStates.push(e.detail);};window.addEventListener('native-room',window.__nativePlayerListener);});
 await page.evaluate(async origin=>{await NativeRoom.mediaConfigure(JSON.stringify({origin}));await NativeRoom.playerCommand(JSON.stringify({url:origin+'/movie.mkv',bounds:{x:30,y:140,width:800,height:450},visible:true,playing:true,rate:1,volume:0.2,muted:false,audioStreamIndex:1,subtitleStreamIndex:-1,mediaTracks:[{Index:0,Type:'Video',Codec:'h264'},{Index:1,Type:'Audio',Codec:'eac3'}]}));},origin);
 await page.waitForFunction(()=>window.__nativePlayerStates.some(s=>s.renderedFirstFrame&&s.playing&&s.audioPcmPeak>0),null,{timeout:25000});
 const initial=await page.evaluate(()=>window.__nativePlayerStates.findLast(s=>s.renderedFirstFrame&&s.playing&&s.audioPcmPeak>0));
 await page.evaluate(()=>NativeRoom.playerCommand(JSON.stringify({rate:1.25,volume:0.35,playing:false,positionMs:1000,subtitleCues:[{start:0,end:6,text:'原生字幕 · EAC3 验证'}],subtitleOffsetMs:0,danmaku:{id:'local-probe',text:'原生弹幕验证'}})));
 await page.waitForFunction(()=>window.__nativePlayerStates.some(s=>s.rate===1.25&&s.volume===0.35&&!s.playing&&s.subtitleCues===1),null,{timeout:5000});
 const controlled=await page.evaluate(()=>window.__nativePlayerStates.at(-1));
 await page.evaluate(()=>NativeRoom.playerCommand(JSON.stringify({visible:false})));
 await page.evaluate(()=>NativeRoom.playerCommand(JSON.stringify({visible:true,bounds:{x:30,y:-20,width:800,height:450},playing:true})));
 await page.waitForFunction(()=>window.__nativePlayerStates.some(s=>s.rate===1.25&&s.playing&&s.positionMs>1600),null,{timeout:5000});
 console.log(JSON.stringify({ok:true,fixture:path.basename(fixture),initial,controlled,errors:await page.evaluate(()=>window.__nativePlayerStates.filter(s=>s.error).map(s=>s.error))},null,2));
}catch(error){console.log(JSON.stringify({ok:false,errorType:error.name,states:page?await page.evaluate(()=>window.__nativePlayerStates).catch(()=>[]):[]}));process.exitCode=1;}
finally{if(page){await page.evaluate(async()=>{await NativeRoom.playerStop();window.removeEventListener('native-room',window.__nativePlayerListener);}).catch(()=>{});}if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}})();
