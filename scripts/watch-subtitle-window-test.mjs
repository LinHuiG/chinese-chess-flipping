import './plugin-test-host.mjs';
import assert from 'node:assert/strict';
import {WatchRoom} from '../plugins/watch/watch.js';

const overlay={textContent:''};globalThis.document={getElementById:()=>overlay};
const text='WEBVTT\n\n03:00.000 --> 04:30.000\n字幕\n',requests=[];
let position=185,context=1;
const state={epoch:'film',itemId:'episode',position:185,duration:1708,playing:true};
const room={host:false,background:false,client:{ready:true},room:{game:'watch',playback:state},context:()=>context,current:c=>c===context};
const watch=Object.assign(Object.create(WatchRoom.prototype),{room,epoch:'film',generation:1,session:{itemId:'episode',sourceId:'source',remote:true},access:{base:'https://fixture.invalid',userId:'viewer',token:'private-fixture-token'},tracks:[{Type:'Subtitle',Index:3,Codec:'subrip',IsExternal:false}],subtitleIndex:3,current:()=>position,render(){},saveHost:async()=>{},recoverPlayback:async()=>{},send:async()=>{},checkin:async()=>{},lastHostSave:performance.now(),lastClock:performance.now(),lastHost:performance.now(),lastCheckin:performance.now()});
globalThis.fetch=async url=>new Promise(resolve=>requests.push({url:new URL(url),reply:(body=text,status=200)=>resolve(new Response(body,{status}))}));
const settle=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
async function finish(pending,body=text,status=200){await settle();requests.at(-1).reply(body,status);await pending;}

let pending=watch.loadSubtitles();await settle();
assert.equal(requests.length,1);assert.equal(requests[0].url.searchParams.get('StartPositionTicks'),'1050000000');assert.equal(requests[0].url.searchParams.get('EndPositionTicks'),'2850000000');assert.equal(requests[0].url.searchParams.get('CopyTimestamps'),'true');
await finish(pending);assert.equal(watch.subtitleCues[0].start,180,'cues retain absolute movie timestamps');assert.equal(overlay.textContent,'字幕');
await watch.loadSubtitles();assert.equal(requests.length,1,'same window reuses its cached cues');

position=255;watch.paintSubtitle();const oldCues=watch.subtitleCues;room.background=true;await watch.pulseOnce();assert.equal(requests.length,1,'background does not prefetch subtitles');room.background=false;await watch.pulseOnce();await settle();
assert.equal(requests.length,2,'prefetch starts before the window ends');assert.equal(requests[1].url.searchParams.get('StartPositionTicks'),'2250000000');assert.equal(requests[1].url.searchParams.get('EndPositionTicks'),'4050000000');assert.equal(watch.subtitleCues,oldCues,'prefetch keeps the active cues');assert.equal(overlay.textContent,'字幕');
await watch.pulseOnce();assert.equal(requests.length,2,'in-flight prefetch is not duplicated');requests[1].reply('WEBVTT\n\n04:00.000 --> 05:00.000\n续接\n');await settle();assert.equal(overlay.textContent,'续接');

position=900;await watch.pulseOnce();await settle();assert.equal(requests.length,3,'a seek outside coverage fetches the destination');assert.equal(requests[2].url.searchParams.get('StartPositionTicks'),'8250000000');
requests[2].reply('WEBVTT\n\n');await settle();assert.deepEqual(watch.subtitleCues,[],'a quiet window is valid');assert.equal(watch.subtitleError,'');await watch.pulseOnce();assert.equal(requests.length,3,'empty windows are cached instead of re-requested');

position=1100;await watch.pulseOnce();await settle();requests.at(-1).reply('',502);await settle();assert.match(watch.subtitleError,/502/);const failures=requests.length;await watch.pulseOnce();assert.equal(requests.length,failures,'failed refresh stops instead of looping once a second');
pending=watch.setSubtitle(3);await finish(pending,text);assert.equal(watch.subtitleError,'','manual retry is still available');

position=1500;await watch.pulseOnce();await settle();const stale=requests.at(-1);await watch.setSubtitle(-1);stale.reply(text);await settle();assert.deepEqual(watch.subtitleCues,[],'late window cannot restore a disabled track');const stopped=requests.length;await watch.pulseOnce();assert.equal(requests.length,stopped);

watch.tracks[0].IsExternal=true;pending=watch.setSubtitle(3);await settle();const full=requests.at(-1).url;assert.equal(full.searchParams.get('StartPositionTicks'),'0');assert.equal(full.searchParams.has('EndPositionTicks'),false,'external subtitle files keep their single full-file request');await finish(pending,text);
assert.equal(watch.subtitleCache.range,null);const externalCount=requests.length;position=1600;await watch.pulseOnce();assert.equal(requests.length,externalCount);

watch.tracks[0].IsExternal=false;watch.access={...watch.access,token:'replacement-private-fixture-token'};pending=watch.loadSubtitles();await settle();const replaced=requests.at(-1);context=2;replaced.reply(text);await pending;assert.equal(watch.subtitleCache.range,null,'stale room cannot cache a new window');
console.log('PASS remote embedded subtitle windows: absolute timestamps, cache, prefetch continuity, seeks, empty ranges, bounded failure, manual retry, stale/off isolation and unchanged external files');
