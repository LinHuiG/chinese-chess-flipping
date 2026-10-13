// Local acceptance fixture only. It models a small part of Emby's HTTP API.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const TOKEN='cyber-room-local-test-token',USER='local-test-user',ITEM='local-test-movie';
function createMockEmby({file=path.resolve(__dirname,'../server/target/watch-fixtures/movie.mp4')}={}){
  const events=[];
  const server=http.createServer((req,res)=>{
    const base='http://'+req.headers.host,url=new URL(req.url,base),route=url.pathname.replace(/^\/emby\b/i,'');
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,X-Emby-Authorization,X-Emby-Token');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,HEAD,OPTIONS');
    const json=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(route==='/System/Info/Public'){json(200,{Id:'local-test-emby',ServerName:'本地观影验收',Version:'4.9.0.0'});return;}
    if(route==='/__test/state'){json(200,{events});return;}
    if(route==='/Users/AuthenticateByName'&&req.method==='POST'){
      let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
        try{const input=JSON.parse(body);if(input.Username!=='viewer'||input.Pw!=='local-test'){json(401,{Message:'测试账号不匹配'});return;}}
        catch{json(400,{Message:'JSON required'});return;}
        json(200,{AccessToken:TOKEN,User:{Id:USER,Name:'本地测试观众'},ServerId:'local-test-emby'});
      });return;
    }
    const authorized=req.headers['x-emby-token']===TOKEN||url.searchParams.get('api_key')===TOKEN
      ||String(req.headers['x-emby-authorization']||req.headers.authorization||'').includes(TOKEN);
    if(!authorized){json(401,{Message:'Test playback authorization required'});return;}
    if(route===`/Users/${USER}`||route==='/Users/Me'){json(200,{Id:USER,Name:'本地测试观众'});return;}
    if(route===`/Users/${USER}/Items`||route==='/Items'){
      json(200,{Items:[{Id:ITEM,Name:'本地同步观影样片',Type:'Movie',RunTimeTicks:1200000000,MediaType:'Video',Container:'mp4'}],TotalRecordCount:1});return;
    }
    if(route===`/Users/${USER}/Items/${ITEM}`||route===`/Items/${ITEM}`){json(200,{Id:ITEM,Name:'本地同步观影样片',Type:'Movie',RunTimeTicks:1200000000});return;}
    if(route===`/Items/${ITEM}/PlaybackInfo`){
      events.push({event:'playbackInfo',at:Date.now()});
      json(200,{PlaySessionId:'local-session-'+events.length,MediaSources:[{Id:'local-mp4',Protocol:'Http',Container:'mp4',SupportsDirectPlay:true,SupportsDirectStream:true,SupportsTranscoding:false,RunTimeTicks:1200000000,DirectStreamUrl:`/Videos/${ITEM}/stream.mp4?api_key=${TOKEN}`,MediaStreams:[{Type:'Video',Codec:'h264',Index:0},{Type:'Audio',Codec:'aac',Index:1,Channels:1}]}]});return;
    }
    if(route.startsWith('/Sessions/Playing')){events.push({event:route,at:Date.now()});req.resume();res.writeHead(204);res.end();return;}
    if(route.startsWith(`/Videos/${ITEM}/`)){
      if(!fs.existsSync(file)){json(503,{Message:'Generate the local movie.mp4 fixture first'});return;}
      const size=fs.statSync(file).size,range=req.headers.range;let start=0,end=size-1,status=200;
      if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m){res.writeHead(416);res.end();return;}start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),end):end;if(start>end){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);}
      events.push({event:'video',at:Date.now(),start,end});
      res.writeHead(status,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1});
      if(req.method==='HEAD')res.end();else fs.createReadStream(file,{start,end}).pipe(res);return;
    }
    json(404,{Message:'Unmodeled test endpoint: '+route});
  });
  return {server,events,TOKEN,USER,ITEM};
}
module.exports={createMockEmby};
if(require.main===module){const fixture=createMockEmby();const port=Number(process.env.CHESS_EMBY_TEST_PORT||18991);fixture.server.listen(port,'127.0.0.1',()=>console.log(`Local Emby fixture: http://127.0.0.1:${port}`));}
