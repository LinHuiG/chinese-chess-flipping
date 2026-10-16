import './plugin-test-host.mjs';
import assert from 'node:assert/strict';
globalThis.localStorage={values:new Map(),getItem(k){return this.values.get(k)||null;},setItem(k,v){this.values.set(k,v);}};
const {cleanWatchSave,readWatchSave,writeWatchSave}=await import('../plugins/watch/watch-save.js');
const {WatchRoom}=await import('../plugins/watch/watch.js');
const source={base:'http://localhost:18991',token:'test-only-token',userId:'test-user',username:'viewer',password:'MUST_NOT_SAVE',serverId:'fixture'};
const record={version:1,source,settings:{quality:'720',volume:.35,muted:true},playback:{itemId:'episode-2',title:'剧集 S01E02',position:63,duration:120,rate:1.5,audioIndex:2,audioExplicit:true,subtitleIndex:3,playing:true,epoch:'old',url:'MUST_NOT_SAVE',session:'MUST_NOT_SAVE'}};
await writeWatchSave(record);const clean=await readWatchSave();
assert.equal(clean.playback.position,63);assert.equal(clean.settings.volume,.35);assert.ok(!JSON.stringify(clean).includes('MUST_NOT_SAVE'));assert.ok(!('playing' in clean.playback));assert.ok(!('epoch' in clean.playback));
assert.equal(cleanWatchSave({...record,source:{...source,base:'http://user:pass@localhost'}}),null);
assert.equal(cleanWatchSave({...record,source:{...source,base:'http://localhost/?token=secret'}}),null);
assert.equal(cleanWatchSave({...record,playback:{...record.playback,position:1000}}).playback.position,120);
const state={epoch:'old',itemId:'episode-2',title:'剧集 S01E02',duration:120,position:63,rate:1.5,playing:true};
const room={host:true,self:'host',room:{game:'watch',playback:state},client:{ready:false},context:()=>1,current:c=>c===1,checkpoint(){},publish(){}};
const watch=Object.assign(Object.create(WatchRoom.prototype),{room,remember:true,ownedSource:source,saved:clean,savedReady:Promise.resolve(),epoch:'old',url:'fixture',video:{readyState:4,currentTime:5,volume:1,muted:false},offset:60,quality:'720',volume:.35,muted:true,audioIndex:2,audioExplicit:true,subtitleIndex:3,render(){},notice(){},send:async()=>{},voice:{configure(){}}});
await watch.saveHost();assert.equal((await readWatchSave()).playback.position,65,'HLS position includes nonzero offset');
watch.beginSeek(90);await watch.saveHost();assert.equal((await readWatchSave()).playback.position,90,'An explicitly committed seek persists');watch.pendingSeek=null;
room.host=false;watch.video.currentTime=45;await watch.saveHost();assert.equal((await readWatchSave()).playback.position,90,'Guest cannot overwrite host save');room.host=true;
watch.ownedSource=null;await watch.saveHost();assert.equal((await readWatchSave()).playback.position,90,'Received room access is never a personally saved source');watch.ownedSource=source;
watch.loading=true;state.position=80;await watch.saveHost();assert.equal((await readWatchSave()).playback.position,80,'Loading cannot replace restored time with video zero');watch.loading=false;
watch.video.readyState=0;await watch.saveHost();assert.equal((await readWatchSave()).playback.position,80,'Waiting for metadata retains requested position');watch.video.readyState=4;
await watch.event({type:'leaving'});assert.equal((await readWatchSave()).playback.position,105,'Exit captures the latest actual time');
room.client.ready=true;watch.error='synthetic playback failure';watch.failedEpoch=state.epoch;state.playing=true;state.position=105;state.at=performance.now()-10000;
await watch.pulse();await watch.saveHost();assert.equal(state.position,105,'Playback failure cannot advance room time while the video is stopped');assert.equal((await readWatchSave()).playback.position,105,'Failed playback saves actual media time, not elapsed wall time');
watch.loading=true;watch.video.readyState=0;state.position=90;state.at=performance.now()-10000;
await watch.pulse();await watch.saveHost();assert.equal(state.position,90);assert.equal((await readWatchSave()).playback.position,90,'Loading preserves the requested position until media has a real time');
watch.loading=false;watch.video.readyState=4;watch.error='';watch.failedEpoch='';room.client.ready=false;
await watch.forgetSaved();await watch.saveHost();assert.equal(await readWatchSave(),null,'Autosave cannot resurrect a deleted credential');

// Restore is host-only, validates access, renews the playback epoch, and never
// counts time while the application was closed as playback.
await writeWatchSave(record);watch.saved=await readWatchSave();watch.access=null;watch.remember=true;room.room.playback=null;
globalThis.fetch=async()=>({status:200,text:async()=>JSON.stringify({Id:'test-user'})});
watch.load=async s=>{watch.loaded={...s};};await watch.restoreHost();
assert.equal(watch.loaded.position,63);assert.equal(watch.loaded.playing,false);assert.notEqual(watch.loaded.epoch,'old');assert.equal(watch.restoreTracks.subtitleIndex,3);assert.equal(watch.quality,'720');assert.equal(room.mediaAccess.token,source.token);
watch.access=null;watch.ownedSource=null;room.room.playback=null;watch.showError=m=>watch.error=m;
globalThis.fetch=async()=>({status:401,text:async()=>''});await watch.restoreHost();assert.match(watch.error,/重新登录/);assert.equal((await readWatchSave()).playback.position,63);
let release;globalThis.fetch=()=>new Promise(r=>release=r);const restoring=watch.restoreHost();await new Promise(r=>setTimeout(r,0));await watch.forgetSaved();release({status:200,text:async()=>JSON.stringify({Id:'test-user'})});await restoring;assert.equal(watch.access,null);assert.equal(await readWatchSave(),null,'Late restore cannot undo deletion');
watch.saved=clean;watch.access=null;watch.ownedSource=null;room.room.playback=null;
globalThis.fetch=()=>new Promise(r=>release=r);const cancelledRestore=watch.restoreHost();await new Promise(r=>setTimeout(r,0));
watch.loginOperation++; // Closing the source dialog cancels its current operation.
release({status:200,text:async()=>JSON.stringify({Id:'test-user'})});await cancelledRestore;
assert.equal(watch.restoring,false,'Cancelling restore must release its autosave/restore guard');assert.equal(watch.access,null,'Cancelled restore cannot install source authorization');
globalThis.fetch=async()=>({status:200,text:async()=>JSON.stringify({Id:'test-user'})});await watch.restoreHost();assert.equal(watch.loaded.position,63,'A later restore can run after cancellation');await watch.forgetSaved();
// Deletion also cancels a login that has not begun its network request because
// it is waiting for the previous native save; its generation starts at entry.
room.client.requireCompatible=()=>{};room.assertCurrent=c=>assert.equal(c,1);
let releaseSave,authCalls=0;const originalSave=watch.saveHost;
watch.saveHost=()=>new Promise(resolve=>releaseSave=resolve);
globalThis.fetch=async()=>{authCalls++;return {status:200,text:async()=>JSON.stringify({AccessToken:'synthetic',User:{Id:'test-user',Policy:{}}})};};
const login=watch.login(source.base,'viewer','test-only-password',true,'',true);
const cancelled=assert.rejects(login,error=>error.code==='STALE_OPERATION');
await watch.forgetSaved();releaseSave();await cancelled;watch.saveHost=originalSave;
assert.equal(authCalls,0,'Cancelled login never sends credentials after waiting');assert.equal(await readWatchSave(),null,'Pending login cannot resurrect a deleted save');
console.log('PASS host save: stable fields, no password/session, actual/HLS/seek position, guest isolation, exit, restore paused, expired authorization and delete race');
