const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/bridge.js'),'utf8').replace('__CYBER_SETTINGS__','{}').replace('__CYBER_BRIDGE_TOKEN__','"test"'),calls=[],pending=[];
const scope={document:{addEventListener(){}},console,window:{__TAURI_INTERNALS__:{invoke:(_name,request)=>{calls.push(request);return new Promise((resolve,reject)=>pending.push({resolve,reject}));}}}};
scope.window.top=scope.window;vm.runInNewContext(source,scope);const bridge=scope.window.NativeRoom,settle=()=>new Promise(r=>setImmediate(r));
(async()=>{
  const first=bridge.secureWrite('test','{"version":1}'),deleted=bridge.secureWrite('test','null'),read=bridge.secureRead('test');
  await settle();assert.equal(calls.length,1);assert.equal(calls[0].method,'secureWrite');
  pending[0].resolve(true);await first;await settle();assert.equal(calls[1].args[1],'null');assert.equal(calls.length,2);
  pending[1].resolve(true);await deleted;await settle();assert.equal(calls[2].method,'secureRead');pending[2].resolve(null);assert.equal(await read,null);
  const failed=bridge.secureWrite('test','{"version":2}').catch(error=>error.message),retryDelete=bridge.secureWrite('test',null);
  await settle();pending[3].reject(Error('synthetic failure'));assert.equal(await failed,'synthetic failure');await settle();assert.equal(calls[4].args[1],null);pending[4].resolve(true);assert.equal(await retryDelete,true);
  console.log('PASS save bridge: write/delete/read order, no stale queued write after delete, error recovery and null deletion');
})().catch(error=>{console.error(error);process.exitCode=1;});
