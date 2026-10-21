// Local acceptance fixture only. It models a small part of Emby's HTTP API.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const TOKEN='cyber-room-local-test-token',USER='local-test-user',ITEM='local-test-movie';
function createMockEmby({file=path.resolve(__dirname,'../server/target/watch-fixtures/movie.mp4'),library=false,playback=false,nativeTracks=false,durationSeconds=120,episodeFile,episodeDurationSeconds=6,bitDepth=8,fullTimeline=false,ffmpeg=process.env.FFMPEG||'ffmpeg'}={}){
  const events=[];
  const hlsFiles=new Map();
  const movie={Id:ITEM,Name:'本地同步观影样片',Type:'Movie',RunTimeTicks:durationSeconds*1e7,MediaType:'Video',Container:'mp4',Overview:'一束灯光亮起，来自不同城市的朋友在同一间电影厅相聚。用于本地验收的同步样片。',ProductionYear:2026,Genres:['科幻','剧情'],ImageTags:{Primary:'fixture-poster'}};
  const series={Id:'series-one',Name:'深空航线',Type:'Series',Overview:'一支探测队沿着未知的引力信号，寻找消失的远航舰队。',ProductionYear:2025,Genres:['科幻'],ImageTags:{Primary:'fixture-series'}};
  const seasons=[10,2,0,1].map(n=>({Id:'season-'+n,Type:'Season',Name:n===0?'特别篇':'第 '+n+' 季',IndexNumber:n,SeriesId:series.Id}));
  const episodes=seasons.flatMap(season=>Array.from({length:season.IndexNumber===1?105:3},(_,i)=>({Id:season.Id+'-episode-'+(i+1),Name:'章节 '+(i+1),Type:'Episode',SeriesId:series.Id,SeriesName:series.Name,SeasonId:season.Id,ParentIndexNumber:season.IndexNumber,IndexNumber:i+1,RunTimeTicks:i===104?undefined:(episodeFile?episodeDurationSeconds:durationSeconds)*1e7,Overview:'航行记录 '+(i+1)+'：探测队进入新的星域，等待来自远方的信号。',SeriesPrimaryImageTag:'fixture-series'})).reverse());
  const catalog=library?[movie,...Array.from({length:54},(_,i)=>({...movie,Id:'movie-'+(i+2),Name:'星际观测 '+String(i+2).padStart(2,'0'),Overview:i===0?'':movie.Overview,ImageTags:i===0?{}:movie.ImageTags})),series,...seasons,...episodes]:[movie];
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
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
        events.push({event:'login',at:Date.now()});json(200,{AccessToken:TOKEN,User:{Id:USER,Name:'本地测试观众',Policy:{EnableMediaPlayback:true,EnableAudioPlaybackTranscoding:playback,EnableVideoPlaybackTranscoding:playback}},ServerId:'local-test-emby'});
      });return;
    }
    const authorized=req.headers['x-emby-token']===TOKEN||url.searchParams.get('api_key')===TOKEN
      ||String(req.headers['x-emby-authorization']||req.headers.authorization||'').includes(TOKEN);
    if(!authorized){json(401,{Message:'Test playback authorization required'});return;}
    if(route===`/Users/${USER}`||route==='/Users/Me'){json(200,{Id:USER,Name:'本地测试观众'});return;}
    const paged=items=>{const start=Number(url.searchParams.get('StartIndex')||0),limit=Number(url.searchParams.get('Limit')||items.length);json(200,{Items:items.slice(start,start+limit),TotalRecordCount:items.length});};
    if(route===`/Users/${USER}/Items`||route==='/Items'){
      const types=(url.searchParams.get('IncludeItemTypes')||'Movie').split(','),term=(url.searchParams.get('SearchTerm')||'').toLowerCase();
      events.push({event:'catalog',start:Number(url.searchParams.get('StartIndex')||0),at:Date.now()});paged(catalog.filter(item=>types.includes(item.Type)&&item.Name.toLowerCase().includes(term)));return;
    }
    if(route===`/Shows/${series.Id}/Seasons`){paged(seasons);return;}
    if(route===`/Shows/${series.Id}/Episodes`){events.push({event:'episodes',start:Number(url.searchParams.get('StartIndex')||0)});paged(episodes.filter(item=>!url.searchParams.get('SeasonId')||item.SeasonId===url.searchParams.get('SeasonId')));return;}
    const imageMatch=/^\/Items\/([^/]+)\/Images\/Primary$/.exec(route);
    if(imageMatch){events.push({event:'image',at:Date.now(),tokenInUrl:url.searchParams.has('api_key')});res.writeHead(200,{'Content-Type':'image/png','Content-Length':png.length});res.end(png);return;}
    const detail=/^\/(?:Users\/[^/]+\/)?Items\/([^/]+)$/.exec(route);
    if(detail){const item=catalog.find(item=>item.Id===detail[1]);json(item?200:404,item||{Message:'Item not found'});return;}
    if(/^\/Items\/[^/]+\/PlaybackInfo$/.test(route)){
      let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{try{const input=JSON.parse(body||'{}');events.push({event:'playbackInfo',at:Date.now(),request:input});
        const itemId=decodeURIComponent(route.split('/')[2]),isEpisode=itemId.includes('-episode-'),mediaFile=isEpisode&&episodeFile?episodeFile:file;const source={Id:'local-mp4',Protocol:'Http',Container:'mp4',SupportsDirectPlay:true,SupportsDirectStream:true,SupportsTranscoding:playback,RunTimeTicks:(isEpisode&&episodeFile?episodeDurationSeconds:durationSeconds)*1e7,DefaultAudioStreamIndex:input.AudioStreamIndex??1,DirectStreamUrl:`/Videos/${itemId}/stream.mp4?api_key=${TOKEN}`,MediaStreams:[{Type:'Video',Codec:'h264',Index:0,BitDepth:bitDepth,Profile:bitDepth>8?'High 10':'High'},{Type:'Audio',Codec:'aac',Index:1,Channels:1,Language:'zho',DisplayTitle:'中文 · 原声'}]};
        if(nativeTracks){source.Container='mkv';source.DirectStreamUrl=`/Videos/${itemId}/stream.mkv?api_key=${TOKEN}`;source.MediaStreams.push({Type:'Audio',Codec:'eac3',Index:2,Channels:2,Language:'eng',DisplayTitle:'English · EAC3'},{Type:'Subtitle',Codec:'subrip',Index:3,Language:'eng',DisplayTitle:'Embedded English',IsTextSubtitleStream:true,IsExternal:false});}
        if(playback){source.MediaStreams.push({Type:'Audio',Codec:'aac',Index:2,Channels:1,Language:'eng',DisplayTitle:'English · Alternate'},{Type:'Subtitle',Codec:'srt',Index:3,Language:'zho',DisplayTitle:'中文',IsTextSubtitleStream:true},{Type:'Subtitle',Codec:'pgssub',Index:4,Language:'eng',DisplayTitle:'图片字幕',IsTextSubtitleStream:false});
          if(input.EnableDirectPlay===false||bitDepth>8&&input.DeviceProfile?.CodecProfiles?.some(p=>p.Conditions?.some(c=>c.Property==='VideoBitDepth'&&c.Value==='8'))){const key='hls-'+events.length,dir=path.join(path.dirname(file),key);fs.mkdirSync(dir,{recursive:true});const start=Number(input.StartTimeTicks||0)/1e7,height=input.DeviceProfile?.TranscodingProfiles?.[0]?.MaxHeight||720;require('node:child_process').execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-ss',String(fullTimeline?0:start),'-i',mediaFile,'-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-t',String(fullTimeline?source.RunTimeTicks/1e7:24),'-map','0:v:0','-map',input.AudioStreamIndex===2?'1:a:0':'0:a:0','-vf','scale=-2:min('+height+'\\,ih)','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','30','-c:a','aac','-ac','2','-hls_time','3','-hls_list_size','0','-hls_playlist_type','vod','-hls_segment_filename',path.join(dir,'segment%03d.ts'),path.join(dir,'master.m3u8')],{stdio:'pipe',timeout:30000});if(fullTimeline){const playlist=path.join(dir,'master.m3u8');fs.writeFileSync(playlist,fs.readFileSync(playlist,'utf8').replace(/^#EXTM3U\r?\n/,'#EXTM3U\n#EXT-X-START:TIME-OFFSET='+start+'\n'));}hlsFiles.set(key,dir);source.SupportsDirectPlay=false;source.TranscodingUrl='/fixture-hls/'+key+'/master.m3u8?api_key='+TOKEN;}
        }
        json(200,{PlaySessionId:'local-session-'+events.length,MediaSources:[source]});
      }catch(e){json(500,{Message:'Unable to create playback test fixture'});}});return;
    }
    const hls=/^\/fixture-hls\/(hls-\d+)\/(master\.m3u8|segment\d+\.ts)$/.exec(route);
    if(hls&&hlsFiles.has(hls[1])){const data=fs.readFileSync(path.join(hlsFiles.get(hls[1]),hls[2]));res.writeHead(200,{'Content-Type':hls[2].endsWith('m3u8')?'application/vnd.apple.mpegurl':'video/mp2t'});res.end(hls[2].endsWith('m3u8')?data.toString().replace(/(segment\d+\.ts)/g,'$1?api_key='+TOKEN):data);return;}
    if(/^\/Videos\/[^/]+\/local-mp4\/Subtitles\/3\/Stream\.vtt$/.test(route)){events.push({event:'subtitle',at:Date.now()});res.writeHead(200,{'Content-Type':'text/vtt'});res.end('WEBVTT\n\n00:00:01.000 --> 00:00:06.000\n<b>第一条字幕</b>\n\n00:01:00.000 --> 00:01:08.000\n六十秒的字幕\n');return;}
    if(route.startsWith('/Sessions/Playing')){events.push({event:route,at:Date.now()});req.resume();res.writeHead(204);res.end();return;}
    if(/^\/Videos\/[^/]+\//.test(route)){
      const mediaFile=route.includes('-episode-')&&episodeFile?episodeFile:file;
      if(!fs.existsSync(mediaFile)){json(503,{Message:'Generate the local movie.mp4 fixture first'});return;}
      const size=fs.statSync(mediaFile).size,range=req.headers.range;let start=0,end=size-1,status=200;
      if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m){res.writeHead(416);res.end();return;}start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),end):end;if(start>end){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);}
      events.push({event:'video',at:Date.now(),start,end});
      res.writeHead(status,{'Content-Type':nativeTracks?'video/x-matroska':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1});
      if(req.method==='HEAD')res.end();else fs.createReadStream(mediaFile,{start,end}).pipe(res);return;
    }
    json(404,{Message:'Unmodeled test endpoint: '+route});
  });
  return {server,events,TOKEN,USER,ITEM};
}
module.exports={createMockEmby};
if(require.main===module){const fixture=createMockEmby();const port=Number(process.env.CHESS_EMBY_TEST_PORT||18991);fixture.server.listen(port,'127.0.0.1',()=>console.log(`Local Emby fixture: http://127.0.0.1:${port}`));}
