import './plugin-test-host.mjs';
import assert from 'node:assert/strict';
import {WatchRoom} from '../plugins/watch/watch.js';
globalThis.document={getElementById:()=>({textContent:''})};
const subtitle=(index,codec='ass')=>({Type:'Subtitle',Index:index,Language:'chi',Codec:codec,IsExternal:true});
function harness(previous=subtitle(7)){
 const state={epoch:'new',itemId:'episode-2',position:0,duration:600,playing:false,version:0,rate:1,at:performance.now()};
 const room={self:'web',host:true,room:{game:'watch',playback:state},context:()=>1,current:c=>c===1,assertCurrent(){},publish(){},checkpoint(){}};
 const watch=Object.assign(Object.create(WatchRoom.prototype),{room,epoch:'old',generation:0,tracks:previous?[previous]:[],subtitleIndex:previous?.Index??-1,access:{base:'https://fixture.invalid',token:'fixture',userId:'viewer',canTranscode:true},quality:'auto',video:{pause(){},removeAttribute(){},load(){},currentTime:0,readyState:2},render(){},saveHost:async()=>{},follow:async()=>{},checkin:async()=>{},updateDuration(){},paintSubtitle(){},endSession:async()=>{}});
 return {watch,room};
}
function source(track,body){return {Id:'source',Container:'mp4',SupportsDirectPlay:true,DirectStreamUrl:'/stream.mp4',...(body.SubtitleStreamIndex>=0?{TranscodingUrl:'/burn.mp4'}:{}),MediaStreams:[{Type:'Video',Codec:'h264'}, {Type:'Audio',Codec:'aac',Index:1},track]};}
async function transition(previous,next){
 const h=harness(previous),requests=[];let subtitleRequests=0;
 globalThis.fetch=async(url,options)=>{if(url.includes('/PlaybackInfo')){const body=JSON.parse(options.body);requests.push(body);return Response.json({PlaySessionId:'session-'+requests.length,MediaSources:[source(next,body)]});}if(url.includes('/Subtitles/')){subtitleRequests++;return new Response('WEBVTT\n\n00:01.000 --> 00:02.000\nfixture\n');}return Response.json({});};
 await h.watch.load(h.room.room.playback);for(let i=0;i<30;i++)await Promise.resolve();return {...h,requests,subtitleRequests};
}
let h=await transition(subtitle(7),subtitle(9));assert.equal(h.watch.subtitleIndex,9);assert.equal(h.requests.length,1);assert.equal(h.subtitleRequests,1);assert.equal(h.watch.subtitleCues.length,1,'carried text track actually loads cues');
h=await transition(subtitle(7,'pgssub'),subtitle(9,'pgssub'));assert.equal(h.watch.subtitleIndex,9);assert.equal(h.requests.length,2,'bitmap carry negotiates exactly once more');assert.equal(h.requests[0].SubtitleStreamIndex,-1);assert.equal(h.requests[1].SubtitleStreamIndex,9);assert.equal(h.watch.burnSubtitle,true);assert.equal(h.watch.loading,false);assert.equal(h.subtitleRequests,0);
h=await transition(null,subtitle(9));assert.equal(h.watch.subtitleIndex,-1);assert.equal(h.requests.length,1);assert.equal(h.subtitleRequests,0,'explicitly disabled subtitles stay disabled');
{
 const {watch,room}=harness(subtitle(7));let request=0;watch.failPlayback=message=>{watch.error=message;};
 globalThis.fetch=async(url,options)=>{if(url.includes('/PlaybackInfo')){if(++request===1)return new Response('',{status:500});return Response.json({PlaySessionId:'retry',MediaSources:[source(subtitle(9),JSON.parse(options.body))]});}if(url.includes('/Subtitles/'))return new Response('WEBVTT\n\n00:01.000 --> 00:02.000\nfixture\n');return Response.json({});};
 await watch.load(room.room.playback);assert(watch.error,'first new-episode negotiation fails');await watch.load(room.room.playback);assert.equal(watch.subtitleIndex,9,'cross-episode subtitle preference survives an initial failed negotiation');
 await watch.setSubtitle('-1');assert.equal(watch.subtitlePreference,null,'explicit off clears retained preference');room.room.playback={...room.room.playback,itemId:'episode-3',epoch:'third'};await watch.load(room.room.playback);assert.equal(watch.subtitleIndex,-1,'explicit off cannot be revived by a subsequent episode');
}
{
 const {watch,room}=harness();room.room.playback={epoch:'legacy',itemId:'legacy'};let reply;watch.detail=()=>new Promise(r=>reply=r);watch.children=()=>{throw Error('stale metadata must not read episodes');};const pending=watch.episodes();room.room.playback={epoch:'replacement',itemId:'replacement'};reply({Type:'Episode',SeriesId:'old-series'});assert.deepEqual(await pending,[]);assert.equal(room.room.playback.seriesId,undefined);
}
{
 const {watch,room}=harness(subtitle(7));watch.subtitlePreference=subtitle(7);watch.restoreTracks={subtitleIndex:-1,burnSubtitle:false};
 globalThis.fetch=async(url,options)=>Response.json({PlaySessionId:'restored',MediaSources:[source(subtitle(9),JSON.parse(options.body))]});
 await watch.load(room.room.playback);assert.equal(watch.subtitleIndex,-1,'saved subtitle-off overrides old playing track');assert.equal(watch.subtitlePreference,null);assert.equal(watch.restoreTracks,null);
}
console.log('PASS: actual load carries changed text index, negotiates bitmap once, preserves off, rejects stale episode metadata');
