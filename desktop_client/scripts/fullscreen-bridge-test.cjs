const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const calls=[],listeners={};let complete;
const document={fullscreenElement:null,addEventListener:(name,fn)=>listeners[name]=fn,exitFullscreen:async()=>{document.fullscreenElement=null;listeners.fullscreenchange();}};
const window={__TAURI_INTERNALS__:{invoke:async(_,request)=>{calls.push(request);if(calls.length===1)await new Promise(r=>complete=r);}}};
vm.runInNewContext(fs.readFileSync(__dirname+'/../src/bridge.js','utf8'),{window,document,console,__CYBER_SETTINGS__:{}});
(async()=>{
 document.fullscreenElement={};listeners.fullscreenchange();await Promise.resolve();
 document.fullscreenElement=null;listeners.fullscreenchange();await Promise.resolve();
 assert.equal(calls.length,1,'Native fullscreen requests must be serialized');complete();
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(calls.map(c=>[c.method,Boolean(c.args[0])]),[['windowFullscreen',true],['windowFullscreen',false]]);
 console.log('PASS native fullscreen bridge preserves enter/exit ordering');
})().catch(e=>{console.error(e);process.exitCode=1;});
