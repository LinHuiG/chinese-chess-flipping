// Test-only CDP inspection of the module closure. No production debug globals,
// account fields, media URLs, session IDs or tokens are recorded.
module.exports=async function playbackDiagnostics(page){
 let cdp;const child=page.frames().find(f=>f.parentFrame());
 // The plugin's HTML becomes visible before its module binds this closure.
 // Wait for the handler itself; otherwise a healthy OOPIF reports false merely
 // because the diagnostic raced the module download/initialization.
 try{await (child||page).waitForFunction(()=>typeof document.querySelector('#watch-seek')?.onchange==='function',null,{timeout:10000});}catch{return false;}
 try{cdp=await page.context().newCDPSession(child||page);}catch{cdp=await page.context().newCDPSession(page);}
 const contexts=[];
 cdp.on('Runtime.executionContextCreated',e=>contexts.push(e.context));
 try{
  await cdp.send('Runtime.enable');
  for(const context of contexts.filter(c=>c.auxData?.isDefault)){
   const handle=await cdp.send('Runtime.evaluate',{expression:"document.querySelector('#watch-seek')?.onchange",contextId:context.id});
   if(handle.result.type!=='function')continue;
   const properties=await cdp.send('Runtime.getProperties',{objectId:handle.result.objectId});
   const scopes=properties.internalProperties?.find(p=>p.name==='[[Scopes]]')?.value?.objectId;
   if(!scopes)continue;
   const list=await cdp.send('Runtime.getProperties',{objectId:scopes,ownProperties:true});
   for(const scope of list.result.filter(p=>/^\d+$/.test(p.name)&&p.value?.objectId)){
    const values=await cdp.send('Runtime.getProperties',{objectId:scope.value.objectId,ownProperties:true});
    const watch=values.result.find(p=>p.name==='watch'&&p.value?.objectId)?.value;
    if(!watch)continue;
    const result=await cdp.send('Runtime.callFunctionOn',{objectId:watch.objectId,returnByValue:true,functionDeclaration:String.raw`function(){
     if(window.__playbackTrace)return true;
     const w=this,mask=s=>String(s||'').replace(/https?:\/\/[^\s"'<>]+/g,'[URL]');
     window.__playbackTrace=[];
     const state=()=>({host:w.room.host,ready:w.room.client.ready,loading:w.loading,failed:w.failedEpoch===w.epoch,error:mask(w.error),generation:w.generation,epochMatch:w.epoch===w.room.room?.playback?.epoch,offset:w.offset,absolute:w.session?.absoluteTimeline,intent:w.room.room?.playback?.playing,hostBuffer:w.room.room?.playback?.buffering,localBuffer:w.buffering,pending:w.pendingSeek?.position,pendingMs:w.pendingSeek?Math.round(performance.now()-w.pendingSeek.since):undefined,desired:w.target(),current:w.current(),actual:w.nativePlayer?w.position:w.video.currentTime,first:w.playbackStarted,requested:w.frameRequested,playerPlaying:w.playerPlaying,paused:w.video.paused,seeking:w.video.seeking,rate:w.video.playbackRate,ranges:Array.from({length:w.video.buffered?.length||0},(_,i)=>[w.video.buffered.start(i),w.video.buffered.end(i)]),autoplay:w.autoplay,attempts:w.recoveryAttempts,waiting:w.waiting,resumePending:w.resumePending});
     const trace=(event,extra={})=>{window.__playbackTrace.push({at:Math.round(performance.now()),event,...extra,state:state()});if(window.__playbackTrace.length>240)window.__playbackTrace.shift();};
     for(const name of ['load','failPlayback','control']){const original=w[name];w[name]=function(...args){trace(name,name==='load'?{target:args[0]?.position}:name==='control'?{playing:args[0],target:args[1]}:{reason:mask(args[0]),retry:args[1]});return Reflect.apply(original,this,args);};}
     const event=w.event;w.event=function(e){if(e.type==='player'&&(e.playbackId!==w.playbackId||e.seekId!==w.playerSeekId||e.error))trace('native-event',{playbackMatch:e.playbackId===w.playbackId,seekMatch:e.seekId===w.playerSeekId,position:e.positionMs/1000,playing:e.playing,seeking:e.seeking,error:!!e.error});return Reflect.apply(event,this,[e]);};
     window.__playbackDiagnosticTimer=setInterval(()=>trace('sample'),1000);trace('attached');return true;
    }`});
    if(result.exceptionDetails)throw Error('Playback diagnostic closure evaluation failed');
    return result.result.value===true;
   }
  }
  return false;
 }finally{await cdp.detach();}
};
