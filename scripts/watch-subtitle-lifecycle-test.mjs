import './plugin-test-host.mjs';
import assert from 'node:assert/strict';
import {WatchRoom,matchingSubtitle} from '../plugins/watch/watch.js';
import {watchLog,diagnosticsText} from '../plugins/watch/diagnostics.js';
const room={host:true,room:{game:'watch',playback:{itemId:'episode',epoch:'one'}},context:()=>1,current:c=>c===1,publish(){},checkpoint(){},assertCurrent(){}};
const w=Object.assign(Object.create(WatchRoom.prototype),{room,generation:1,tracks:[{Index:7,Type:'Subtitle',IsExternal:true,Codec:'ass'}],subtitleIndex:7,session:{itemId:'episode',sourceId:'source'},access:{base:'https://fixture.invalid',userId:'viewer',token:'private-token'},render(){},paintSubtitle(){},saveHost:async()=>{}});
let calls=0,resolve;
globalThis.fetch=async()=>{calls++;return new Promise(r=>resolve=()=>r(new Response('WEBVTT\n\n00:01.000 --> 00:03.000\n字幕\n')));};
const stale=w.loadSubtitles();w.subtitleIndex=-1;await w.loadSubtitles();resolve();await stale;
assert.deepEqual(w.subtitleCues,[],'late response cannot reactivate disabled subtitles');
w.subtitleIndex=7;const first=w.loadSubtitles();resolve();await first;assert.equal(w.subtitleCues.length,1);
const count=calls;await w.loadSubtitles();assert.equal(calls,count,'same source/episode/track reuses parsed cues after reload');
w.access={...w.access,token:'new-private-token'};const changed=w.loadSubtitles();resolve();await changed;assert.equal(calls,count+1,'new authorization cannot reuse prior subtitles');
w.detail=async()=>({Type:'Episode',SeriesId:'series',SeriesName:'Show',ParentIndexNumber:1,IndexNumber:2});
w.children=async()=>[{Id:'episode',SeriesId:'series'}];
assert.equal((await w.episodes()).length,1);assert.equal(room.room.playback.seriesId,'series','old save recovers series metadata from item detail');
watchLog('test',{url:'https://secret.invalid/?api_key=private-token',token:'private-token',itemId:'episode'});
assert(!diagnosticsText().includes('private-token'));assert(!diagnosticsText().includes('secret.invalid'));
for(let i=0;i<400;i++)watchLog('bounded',{index:i});
const logs=diagnosticsText();assert.equal(JSON.parse(logs).entries.length,300);assert(!logs.includes('private-token'));assert(!logs.includes('secret.invalid'));


const previous={Type:'Subtitle',Index:7,Language:'chi',Codec:'ass',IsExternal:true};
assert.equal(matchingSubtitle([{...previous,Index:9},{...previous,Index:7,Language:'eng'}],previous).Index,9,'episodes match subtitle language, not stale stream index');
assert.equal(matchingSubtitle([{...previous,Language:'eng'}],previous),null);

console.log('PASS subtitle stale response, reload cache, authorization isolation, legacy episode metadata, cross-episode track matching and bounded private diagnostics');
