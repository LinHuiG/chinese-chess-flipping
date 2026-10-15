// 赛博房间公共帧与会话。普通正文 JSON；rawBody 支持任意字节。
export const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
export function id(){return Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');}
const reserved=new Set(['op','requestId','roomId','to','from','ok','error','grant']);
export function controlBytes(control={}){
  if(control instanceof Uint8Array){parseControl(control);return control;}
  if(typeof control==='string'){const bytes=encoder.encode(control);parseControl(bytes);return bytes;}
  return controlBytes(Object.entries(control).map(([k,v])=>k+':'+String(v)+'\n').join(''));
}
export function parseControl(bytes){
  const text=decoder.decode(bytes),fields=Object.create(null);
  if(bytes.length>4096 || (text && !text.endsWith('\n')))throw Error('控制头无效');
  if(text)for(const line of text.slice(0,-1).split('\n')){
    const colon=line.indexOf(':'),key=line.slice(0,colon),value=line.slice(colon+1);
    if(colon<1 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || /[\r\n\0]/.test(value) || ((reserved.has(key)||key==='discard'||key==='maxAgeMs')&&key in fields))throw Error('控制头无效');
    fields[key]=value;
  }
  return fields;
}
export function packet(kind,control={},body={}){
  const c=controlBytes(control),b=body instanceof Uint8Array?body:encoder.encode(JSON.stringify(body));
  if(c.length>4096||b.length>65536)throw Error('报文过大');
  const bytes=new Uint8Array(17+c.length+b.length),v=new DataView(bytes.buffer);
  v.setUint16(0,0xfcfc);v.setUint32(2,bytes.length);v.setUint32(6,c.length);v.setUint32(10,b.length);
  bytes[14]=3;bytes[15]=kind;bytes.set(c,17);bytes.set(b,17+c.length);return bytes;
}
export function decode(input){
  const bytes=input instanceof Uint8Array?input:new Uint8Array(input),v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length<17||v.getUint16(0)!==0xfcfc||v.getUint32(2)!==bytes.length||bytes[14]!==3||bytes[16]!==0||bytes[15]===0)throw Error('协议不兼容');
  const c=v.getUint32(6),b=v.getUint32(10);
  if(c>4096||b>65536||17+c+b!==bytes.length)throw Error('报文长度无效');
  const rawControl=bytes.subarray(17,17+c),rawBody=bytes.subarray(17+c);
  return {kind:bytes[15],control:parseControl(rawControl),rawControl,rawBody};
}
export function object(bytes){const v=JSON.parse(decoder.decode(bytes));if(!v||typeof v!=='object'||Array.isArray(v))throw Error('正文不是对象');return v;}
export function base64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
export function unbase64(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
export const native=globalThis.NativeRoom||null;
export async function nativeCall(name,...args){if(!native?.[name])return undefined;return await native[name](...args);}
export function settings(){try{return native?JSON.parse(native.settings()):{};}catch{return {};}}
export function storageGet(key,fallback=null){try{const text=localStorage.getItem(key);return text?JSON.parse(text):fallback;}catch{return fallback;}}
export function storageSet(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}}
export const errors={SESSION_EXPIRED:'连接身份已过期',ROOM_NOT_FOUND:'房间已解散',NOT_HOST:'只有房主可以操作',TARGET_UNAVAILABLE:'对方暂时不在线',TIMEOUT:'房主没有及时回应',LIMIT_EXCEEDED:'请求过多，请稍后重试',SERVER_BUSY:'服务器繁忙',INVALID_ARGUMENT:'请求参数无效'};
export class RoomClient{
  constructor(callbacks={}){
    this.callbacks=callbacks;this.pending=new Map();this.ready=false;this.enabled=false;this.generation=0;this.peerReady=new Set();this.peerLatency=new Map();this.peerQuality=new Map();
    if(native)globalThis.addEventListener('native-room',event=>this.nativeEvent(event.detail));
  }
  identityKey(){const s=settings();return 'cyber.identity.'+(native?s.transport+'://'+s.host+':'+s.port:location.host);}
  get compatibilityError(){const capabilities=this.identity?.capabilities;return Array.isArray(capabilities)&&['room-sync','room-broadcast','host-grant'].every(c=>capabilities.includes(c))?'':'服务器缺少新版房间授权与广播能力，请升级配套服务端后重连';}
  requireCompatible(){if(!this.ready)throw Error('连接正在恢复');if(this.compatibilityError)throw Object.assign(Error(this.compatibilityError),{code:'INCOMPATIBLE_SERVER'});}
  connect(){
    this.enabled=true;clearTimeout(this.retry);
    if(this.connecting||this.ready)return;
    this.connecting=true;this.identity=storageGet(this.identityKey(),{});const generation=++this.generation;
    this.callbacks.status?.('正在连接…');this.started=Date.now();
    if(native){nativeCall('connect',JSON.stringify(this.identity)).catch(()=>this.finish('连接失败，请检查服务器'));}
    else{
      const url=new URL('/ws',location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';
      const socket=this.socket=new WebSocket(url);socket.binaryType='arraybuffer';
      socket.onopen=()=>{if(generation===this.generation)this.sendPacket(3,{},this.identity);};
      socket.onmessage=e=>{if(generation===this.generation)this.receive(new Uint8Array(e.data));};
      socket.onclose=()=>{if(generation===this.generation)this.finish('连接已断开');};
      socket.onerror=()=>{if(generation===this.generation)this.finish('连接失败，请检查服务器');};
    }
    clearInterval(this.timer);this.timer=setInterval(()=>this.tick(),1000);
  }
  nativeEvent(e){
    if(e.type==='packet')this.receive(unbase64(e.data));
    else if(e.type==='closed')this.finish(e.reason||'连接已断开');
    else if(e.type==='status')this.callbacks.status?.(e.message);
    else if(e.type==='peer'){
      if(this.callbacks.peerValid&&!this.callbacks.peerValid(e.peerId,e.context))return;
      if(e.ready)this.peerReady.add(e.peerId);else this.peerReady.delete(e.peerId);
      if(e.ready&&Number.isFinite(e.latency)&&e.latency>=0)this.peerLatency.set(e.peerId,e.latency);else this.peerLatency.delete(e.peerId);
      this.peerQuality.set(e.peerId,{...e,receivedAt:performance.now()});
      this.callbacks.path?.();
    }else if(e.type==='peerPacket'){
      if(this.callbacks.peerValid&&!this.callbacks.peerValid(e.peerId,e.context))return;
      try{const m=decode(unbase64(e.data));m.control.from=e.peerId;m.path='direct';this.callbacks.message?.(m);}catch{}
    }else this.callbacks.native?.(e);
  }
  receive(bytes){
    try{
      const m=decode(bytes);m.path='relay';
      if(m.kind===4){
        if(m.control.ok!=='1'){
          if(m.control.error==='SESSION_EXPIRED')storageSet(this.identityKey(),{});
          this.finish(errors[m.control.error]||'连接被拒绝');return;
        }
        const identity=object(m.rawBody);if(!/^[0-9a-f]{32}$/.test(identity.clientId)||typeof identity.token!=='string')throw Error('身份无效');
        const resumed=identity.clientId===this.identity.clientId;this.identity=identity;storageSet(this.identityKey(),identity);
        this.ready=true;this.connecting=false;this.pongAt=this.pingAt=Date.now();this.callbacks.connected?.(identity,resumed);return;
      }
      if(!this.ready)return;
      if(m.kind===33){const b=object(m.rawBody);this.pongAt=Date.now();this.callbacks.latency?.(Math.max(0,this.pongAt-b.sentAtMs));return;}
      const pending=m.kind===18&&m.control.requestId&&this.pending.get(m.control.requestId);
      if(pending){
        this.pending.delete(m.control.requestId);clearTimeout(pending.timer);
        if(m.control.ok!=='1')pending.reject(Object.assign(Error(errors[m.control.error]||m.control.error||'请求失败'),{code:m.control.error}));
        else pending.resolve(m);
      }else this.callbacks.message?.(m);
    }catch(e){this.finish(e.message||'报文校验失败');}
  }
  sendPacket(kind,headers,body){return this.sendBytes(packet(kind,headers,body));}
  sendBytes(bytes){
    if(native){try{return nativeCall('send',base64(bytes)).catch(()=>false);}catch{return false;}}
    if(!this.socket||this.socket.readyState!==1||this.socket.bufferedAmount>1048576)return false;
    try{this.socket.send(bytes);return true;}catch{return false;}
  }
  request(op,body={},headers={}){
    if(!this.ready)return Promise.reject(Error('连接正在恢复'));
    const requestId=id();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(requestId);reject(Error('请求超时'));},op===102?32000:10000);
      this.pending.set(requestId,{resolve,reject,timer});
      Promise.resolve(this.sendPacket(16,{op,requestId,...headers},body)).then(sent=>{if(!sent)throw Error('发送失败');}).catch(e=>{clearTimeout(timer);this.pending.delete(requestId);reject(e);});
    });
  }
  async createRoom({roomType,name,locked=false}){return object((await this.request(100,{roomType,name,locked})).rawBody);}
  async roomSync(roomId,change={}){return object((await this.request(103,{roomId,...change})).rawBody);}
  async listRooms({roomType}){
    let after,rooms=[];
    do{const result=object((await this.request(101,{roomType,...(after?{after}:{})})).rawBody);rooms.push(...result.rooms);after=result.next;}while(after&&rooms.length<10000);
    return rooms;
  }
  joinRoom(roomId,body){return this.request(102,body,{roomId});}
  replyJoin(request,body){return this.sendPacket(18,{op:102,requestId:request.control.requestId,roomId:request.control.roomId,to:request.control.from,ok:1,grant:body.allowed?1:0},body);}
  leaveRoom(roomId){return this.request(104,{roomId});}
  async sendTo(roomId,to,headers,body,path='auto'){
    if(!this.ready)return false;
    if(!/^[a-f0-9]{32}$/.test(roomId)||!/^[a-f0-9]{32}$/.test(to))throw Error('路由标识无效');
    const extension=controlBytes(headers),fields=parseControl(extension);
    if([...reserved].some(key=>key in fields))throw Error('扩展控制头不能覆盖路由字段');
    const route=encoder.encode('roomId:'+roomId+'\nto:'+to+'\n'),control=new Uint8Array(route.length+extension.length);
    control.set(route);control.set(extension,route.length);
    if(path!=='relay'&&native&&this.peerReady.has(to)){
      try{const frame=packet(64,control,body);if(frame.length<=1100&&await nativeCall('sendPeer',to,base64(frame)))return true;}catch{}
    }
    if(path==='direct')return false;
    const op=encoder.encode('op:200\n'),relay=new Uint8Array(op.length+control.length);relay.set(op);relay.set(control,op.length);
    return this.sendPacket(16,relay,body);
  }
  broadcast(roomId,targets,headers,body){
    if(!this.ready||Array.isArray(targets)&&targets.length===0)return false;
    if(!/^[a-f0-9]{32}$/.test(roomId)||targets?.some(t=>!/^[a-f0-9]{32}$/.test(t)))throw Error('路由标识无效');
    const fields=parseControl(controlBytes(headers));if([...reserved].some(k=>k in fields))throw Error('扩展控制头不能覆盖路由字段');
    if(fields.discard==='1'&&this.socket?.bufferedAmount>16384)return false;
    return this.sendPacket(16,{op:201,roomId,...(targets?{to:[...new Set(targets)].join(',')}:{}),...fields},body);
  }
  tick(){
    const now=Date.now();
    if(!this.ready){if(now-this.started>15000)this.finish('连接超时');return;}
    if(native)return;
    if(now-this.pongAt>15000){this.finish('服务器响应超时');return;}
    if(now-this.pingAt>=5000){this.pingAt=now;this.sendPacket(32,{}, {pingId:id(),sentAtMs:now});}
  }
  finish(reason){
    if(!this.connecting&&!this.ready&&!this.socket)return;
    clearTimeout(this.retry);this.retry=null;
    this.ready=this.connecting=false;++this.generation;clearInterval(this.timer);clearTimeout(this.retry);
    const socket=this.socket;this.socket=null;if(socket){socket.onclose=socket.onerror=socket.onmessage=socket.onopen=null;socket.close();}
    if(native)nativeCall('disconnect').catch(()=>{});
    this.clearPeers();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error(reason));}this.pending.clear();
    this.callbacks.closed?.(reason);
    if(this.enabled){const generation=this.generation;this.retry=setTimeout(()=>{if(this.enabled&&this.generation===generation)this.connect();},3000);}
  }
  disconnect(){this.enabled=false;clearTimeout(this.retry);this.retry=null;this.finish('已断开连接');}
  clearPeers(){this.peerReady.clear();this.peerLatency.clear();this.peerQuality.clear();if(native)nativeCall('closePeers').catch(()=>{});}
}
