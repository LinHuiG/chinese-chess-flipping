// Installed only in Android's trusted top-level origin. Sandboxed plugins never receive this object.
if(globalThis.CyberBridge){
  const pending=new Map();let next=0,settings={};
  CyberBridge.onmessage=e=>{let m;try{m=JSON.parse(e.data);}catch{return;}const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error)):p.resolve(m.value);};
  const call=(method,...args)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('原生接口超时'));},['extensionPrepare','marketDownload'].includes(method)?180000:65000);pending.set(id,{resolve,reject,timer});CyberBridge.postMessage(JSON.stringify({id,method,args}));});
  const api=globalThis.NativeRoom={platform:'ANDROID',settings:()=>JSON.stringify(settings),configure:async value=>{await call('configure',value);settings=JSON.parse(await call('settings'));},ready:call('settings').then(value=>{settings=JSON.parse(value);})};
  for(const method of ['connect','disconnect','send','udpRegister','openPeer','sendPeer','closePeers','roomActive','extensionPrepare','extensionActivate','extensionCall','extensionClose','checkUpdate','installUpdate','exitApp','marketFetch','marketDownload','secureRead','secureWrite'])api[method]=(...args)=>call(method,...args);
}
