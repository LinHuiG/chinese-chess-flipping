import './plugin-test-host.mjs';
import assert from 'node:assert/strict';
import {WatchRoom,mediaRequest,browserSourceError,playbackRequest,directCompatible} from '../plugins/watch/watch.js';
const savedFetch=globalThis.fetch,savedLocation=globalThis.location;
const calls=[],sent=[],room={self:'test-device',host:true,background:false,room:{game:'watch'},client:{requireCompatible(){}},context:()=> 'room',current:c=>c==='room',assertCurrent:c=>assert.equal(c,'room'),publish(){}};
const watch=Object.assign(Object.create(WatchRoom.prototype),{room,stopMedia:async()=>{},render(){},send:async(type,body)=>sent.push({type,body})});
const policy={EnableMediaPlayback:true,EnableAudioPlaybackTranscoding:true,EnableVideoPlaybackTranscoding:true};
let mismatch=false;
globalThis.fetch=async(url,options={})=>{calls.push({url,headers:options.headers});const value=url.includes('AuthenticateByName')?{AccessToken:'mock-private-token',ServerId:'same-server',User:{Id:'viewer',Policy:policy}}:{Id:mismatch?'other-server':'same-server'};return {status:200,text:async()=>JSON.stringify(value)};};
try{
  await watch.login('http://media.test','viewer','test-password',true,'https://media-web.test');
  assert.equal(room.mediaAccess.base,'http://media.test');assert.equal(watch.access.base,'https://media-web.test');assert.equal(room.mediaAccess.canTranscode,true);assert.equal(sent.length,1);
  const publicCalls=calls.filter(c=>new URL(c.url).hostname==='media-web.test');assert.equal(publicCalls.length,1);assert.equal(publicCalls[0].headers['X-Emby-Token'],undefined,'Never send the token before server identity verification');
  mismatch=true;await assert.rejects(watch.login('http://media.test','viewer','test-password',true,'https://unrelated.test'),/服务器标识不同/);assert.equal(watch.access,null);assert.equal(sent.length,1,'Rejected alias is never shared');
  globalThis.location={protocol:'https:'};assert.match(browserSourceError('http://media.test'),/HTTPS/);const before=calls.length;await assert.rejects(mediaRequest('http://media.test/System/Info/Public'),/HTTPS/);assert.equal(calls.length,before,'Mixed content is diagnosed before fetch');
  for(const container of ['mp4','mkv'])assert.equal(directCompatible({Container:container,SupportsDirectPlay:true,MediaStreams:[{Type:'Video',Codec:'h264'},{Type:'Audio',Codec:'aac'}]}),true);
  for(const codec of ['ac3','eac3','dts'])assert.equal(directCompatible({Container:'mkv',SupportsDirectPlay:true,MediaStreams:[{Type:'Video',Codec:'h264'},{Type:'Audio',Codec:codec}]}),false);
  const request=playbackRequest('720');assert.equal(request.EnableDirectPlay,false);assert.equal(request.EnableDirectStream,false);assert.equal(request.AllowAudioStreamCopy,false);assert.equal(request.DeviceProfile.TranscodingProfiles[0].MaxHeight,720);
  assert.equal(watch.target({position:60,playing:false,rate:2,duration:120}),60);
  globalThis.location={protocol:'http:'};globalThis.fetch=async url=>new URL(url).pathname.endsWith('.m3u8')?new Response('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:3,\n0.ts\n#EXT-X-ENDLIST\n'):({status:200,text:async()=>JSON.stringify(url.includes('PlaybackInfo')?{PlaySessionId:'mock-session',MediaSources:[{Id:'eac3-source',Container:'mkv',SupportsDirectPlay:true,SupportsTranscoding:false,MediaStreams:[{Type:'Video',Codec:'h264'},{Type:'Audio',Codec:'eac3',Index:1}]}]}:{})});
  Object.assign(watch,{generation:0,quality:'720',access:{base:'http://media.test',token:'mock-private-token',userId:'viewer',canTranscode:true},video:{currentTime:0},follow(){},current:()=>60});room.room.playback={epoch:'new',itemId:'movie',position:60,duration:120,version:0,playing:false};await watch.load(room.room.playback);
  const stream=new URL(watch.url);assert.equal(stream.pathname,'/Videos/movie/master.m3u8');assert.equal(stream.searchParams.get('AudioCodec'),'aac');assert.equal(stream.searchParams.get('AllowAudioStreamCopy'),'false');assert.equal(stream.searchParams.get('MaxHeight'),'720');assert.equal(stream.searchParams.get('StartTimeTicks'),'600000000');assert.equal(watch.session.transcoded,true);
  assert.equal(stream.searchParams.get('SubtitleMethod'),'External','Fallback HLS must prevent the server from burning the default subtitle');assert.equal(stream.searchParams.get('SubtitleStreamIndex'),'-1');
  watch.access.canTranscode=false;await watch.load(room.room.playback);assert.match(watch.error,/未提供/,'No direct EAC3 escape when explicit transcoding permission is missing');
  console.log('PASS source safety: same-server HTTPS alias, no token before identity match, mismatch rejection, explicit mixed-content diagnosis, codec verification and real quality request');
}finally{globalThis.fetch=savedFetch;if(savedLocation===undefined)delete globalThis.location;else globalThis.location=savedLocation;}
