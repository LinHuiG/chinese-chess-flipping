// Public plugin SDK. The host owns connections and credentials; plugins receive a scoped MessagePort.
export const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
export const id=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
export const object=bytes=>{const v=JSON.parse(decoder.decode(bytes));if(!v||typeof v!=='object'||Array.isArray(v))throw Error('正文不是对象');return v;};
export const sameBinding=(a,b)=>!!a&&!!b&&['id','version','release','protocol'].every(key=>a[key]===b[key]);
export function base64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
let port,sequence=0;const pending=new Map(),clients=new Set(),events=new Set();
export const bootstrap=globalThis.__CYBER_TEST_BOOTSTRAP__||await new Promise(resolve=>{
  const receive=e=>{if(e.source!==parent||e.data?.type!=='cyber:init'||!e.ports[0]||port)return;
    port=e.ports[0];port.onmessage=message;removeEventListener('message',receive);resolve(e.data.bootstrap);};
  addEventListener('message',receive);parent.postMessage({type:'cyber:ready'},'*');
});
function message(e){const m=e.data;if(!m||typeof m!=='object')return;
  if(m.reply){const p=pending.get(m.reply);if(!p)return;pending.delete(m.reply);clearTimeout(p.timer);m.error?p.reject(Object.assign(Error(m.error.message),{code:m.error.code})):p.resolve(m.value);return;}
  if(m.event==='native'){dispatchEvent(new CustomEvent('native-room',{detail:m.value}));}
  for(const c of clients)c.event(m.event,m.value);
  for(const cb of events)cb(m.event,m.value);
}
export function call(method,...args){if(bootstrap.invoke)return Promise.resolve().then(()=>bootstrap.invoke(method,...args));if(!port)return Promise.reject(Error('插件未连接宿主'));if(pending.size>=128)return Promise.reject(Error('插件请求过多'));
  return new Promise((resolve,reject)=>{const request=++sequence,timer=setTimeout(()=>{pending.delete(request);reject(Error('宿主请求超时'));},40000);pending.set(request,{resolve,reject,timer});port.postMessage({request,method,args});});}
export const onHostEvent=cb=>{events.add(cb);return()=>events.delete(cb);};
export function asset(name){const url=bootstrap.assets?.[name];if(!url)throw Error('插件资源不存在：'+name);return url;}
const values=bootstrap.storage||{};
const pendingWrites=new Set();
export const storageFlush=()=>Promise.all([...pendingWrites]);
export function storageGet(key,fallback=null){return key in values?values[key]:fallback;}
export function storageSet(key,value){try{const next=JSON.stringify({...values,[key]:value});if(next.length>524288)return false;values[key]=value;const write=call('storage.set',key,value);pendingWrites.add(write);write.catch(e=>dispatchEvent(new CustomEvent('plugin-storage-error',{detail:e.message}))).finally(()=>pendingWrites.delete(write));return true;}catch{return false;}}
export const settings=()=>bootstrap.settings||{};
export const native=bootstrap.native||(bootstrap.platform==='web'?null:{platform:bootstrap.platform.toUpperCase(),...(bootstrap.nativeComponent?.capabilities||{})});
const nativeMethods=['udpRegister','openPeer','closePeers','roomActive',...Object.keys(bootstrap.nativeComponent?.exports||{})];
if(native&&!bootstrap.native)for(const method of nativeMethods)native[method]=(...args)=>call('native',method,...args);
export async function nativeCall(method,...args){return native?.[method]?.(...args);}
export class RoomClient{
  constructor(callbacks={}){this.callbacks=callbacks;this.peerReady=new Set();this.peerLatency=new Map();this.peerQuality=new Map();this.generation=0;this.enabled=false;clients.add(this);this.update(bootstrap.connection);}
  update(s){if(!s)return;Object.assign(this,{ready:!!s.ready,identity:s.identity,generation:s.generation||0});this.peerReady=new Set(s.peers||[]);this.peerLatency=new Map(s.latencies||[]);this.peerQuality=new Map(s.quality||[]);}
  identityKey(){return bootstrap.connectionKey;}
  get compatibilityError(){return ['room-sync','room-broadcast','host-grant','room-descriptors'].every(value=>this.identity?.capabilities?.includes(value))?'':'服务器缺少插件房间能力，请升级服务端';}
  requireCompatible(){if(!this.ready)throw Error('连接正在恢复');if(this.compatibilityError)throw Object.assign(Error(this.compatibilityError),{code:'INCOMPATIBLE_SERVER'});}
  async connect(){this.enabled=true;if(this.ready){await this.callbacks.connected?.(this.identity,true);return;}if(this.connecting)return this.connecting;
    this.connecting=new Promise((resolve,reject)=>{this.connectedResolve=resolve;this.connectedReject=reject;this.connectTimer=setTimeout(()=>{this.connectedReject?.(Error('服务器连接超时'));this.clearConnecting();},35000);});
    call('connect').catch(e=>{this.connectedReject?.(e);this.clearConnecting();});return this.connecting;}
  clearConnecting(){clearTimeout(this.connectTimer);this.connecting=this.connectedResolve=this.connectedReject=null;}
  event(name,value){if(name==='connection'){const was=this.ready;this.update(value);if(value.ready)Promise.resolve(this.callbacks.connected?.(this.identity,!!value.resumed)).then(()=>{this.connectedResolve?.();this.clearConnecting();}).catch(e=>{this.connectedReject?.(e);this.clearConnecting();});else if(was)this.callbacks.closed?.(value.status||'连接已断开');}
    else if(name==='message')this.callbacks.message?.(value);else if(name==='native')this.callbacks.native?.(value);else if(name==='network'){this.update(value);this.callbacks.path?.();}else if(name==='status')this.callbacks.status?.(value);}
  createRoom(q){return call('room.create',q);}
  joinRoom(roomId,body){return call('room.join',roomId,body);}
  roomSync(roomId,change={}){return call('room.sync',roomId,change);}
  listRooms(q){return call('room.list',q);}
  leaveRoom(roomId){return call('room.leave',roomId);}
  replyJoin(request,body){return call('room.reply',request.control.requestId,body);}
  sendTo(roomId,to,headers,body,path='auto'){return call('room.send',roomId,to,headers,body,path);}
  broadcast(roomId,targets,headers,body){return call('room.broadcast',roomId,targets,headers,body);}
  request(op,body={},headers={}){return call('room.request',op,body,headers);}
  clearPeers(){this.peerReady.clear();this.peerLatency.clear();this.peerQuality.clear();if(native)nativeCall('closePeers').catch(()=>{});}
  disconnect(){this.enabled=false;}
}

// One bounded encrypted JSON document per plugin, on native platforms.
export const secureRead=()=>call('storage.secureRead');
export const secureWrite=value=>call('storage.secureWrite',value);
