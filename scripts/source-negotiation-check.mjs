// Explicit read/negotiation diagnostic; never reads video bytes or stops other sessions.
import './plugin-test-host.mjs';
import {playbackRequest} from '../plugins/watch/watch.js';
const base=process.env.EMBY_BASE,user=process.env.EMBY_USER,password=process.env.EMBY_PASSWORD;
if(!base||!user||!password)throw Error('Set source credentials in environment');
const device=crypto.randomUUID(),headers={'Content-Type':'application/json',Origin:'null','X-Emby-Authorization':`MediaBrowser Client="CyberRoom", Device="Diagnostic", DeviceId="${device}", Version="0.9.1"`};
const auth=await (await fetch(base+'/Users/AuthenticateByName',{method:'POST',headers,body:JSON.stringify({Username:user,Pw:password}),signal:AbortSignal.timeout(30000)})).json();headers['X-Emby-Token']=auth.AccessToken;
const items=await (await fetch(base+'/Users/'+auth.User.Id+'/Items?Recursive=true&IncludeItemTypes=Movie&Limit=2',{headers,signal:AbortSignal.timeout(30000)})).json();
for(const [index,item] of items.Items.entries()){
 const start=Date.now();
 try{
  const r=await fetch(base+'/Items/'+item.Id+'/PlaybackInfo?UserId='+auth.User.Id+'&DeviceId='+device,{method:'POST',headers,body:JSON.stringify({UserId:auth.User.Id,StartTimeTicks:0,IsPlayback:true,AutoOpenLiveStream:true,SubtitleStreamIndex:-1,...playbackRequest('auto',false,process.env.EMBY_DESKTOP==='1')}),signal:AbortSignal.timeout(90000)});
  const text=await r.text();let data;try{data=JSON.parse(text);}catch{}
  console.log(JSON.stringify({item:index,status:r.status,elapsed:Date.now()-start,cors:r.headers.get('access-control-allow-origin'),server:r.headers.get('server'),contentType:r.headers.get('content-type'),error:data?.ErrorCode,sources:data?.MediaSources?.map(s=>({direct:s.SupportsDirectPlay,transcode:!!s.TranscodingUrl,container:s.Container,streams:s.MediaStreams?.map(t=>({type:t.Type,codec:t.Codec})),live:!!s.LiveStreamId})),htmlTitle:text.match(/<title>([^<]*)<\/title>/i)?.[1]}));
  for(const s of data?.MediaSources||[])if(s.LiveStreamId)await fetch(base+'/LiveStreams/Close',{method:'POST',headers,body:JSON.stringify({LiveStreamId:s.LiveStreamId}),signal:AbortSignal.timeout(10000)}).catch(()=>{});
 }catch(e){console.log(JSON.stringify({item:index,error:e.name,elapsed:Date.now()-start}));}
}
