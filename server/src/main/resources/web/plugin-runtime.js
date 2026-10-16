import {native,nativeCall,settings,storageGet,storageSet,object,base64} from './transport.js';
import {binding,sameBinding} from './plugin-package.js';
import {platform} from './plugin-store.js';
import {Microphone} from './microphone.js';
import {migrateLegacyData} from './legacy-data.js';
export class PluginRuntime{
  constructor(client,container,events={}){this.client=client;this.container=container;this.events=events;}
  connection(){const c=this.client;return {ready:c.ready,generation:c.generation,identity:c.identity?{clientId:c.identity.clientId,capabilities:c.identity.capabilities,serverVersion:c.identity.serverVersion}:null,peers:[...c.peerReady],latencies:[...c.peerLatency],quality:[...c.peerQuality]};}
  emit(event,value){if(event==='native'&&value?.componentSession&&value.componentSession!==this.active?.componentSession)return;if(event==='native'&&value?.type==='nativeFailure'){this.events.error?.(value.message||'原生组件已停止');this.close();return;}if(event==='native'&&value?.type==='background')this.active?.microphone.stop();if(event==='connection'&&!value?.ready)this.active?.microphone.stop();this.active?.port?.postMessage({event,value});}
  current(a){if(this.active!==a||a.closed)throw Error('插件实例已结束');}
  async open(installed,command){if(this.active||this.opening)throw Error('请先退出当前插件');const opening=this.opening={};opening.done=new Promise(resolve=>opening.resolve=resolve);try{const {record,payload}=installed,m=record.manifest,frame=document.createElement('iframe');
    const component=record.artifacts[platform()]?.native;
    let activation;if(component){activation=await nativeCall('extensionActivate',JSON.stringify(component));if(typeof activation==='string')activation=JSON.parse(activation);}if(opening.cancelled){if(component)await nativeCall('extensionClose');throw Error('插件启动已取消');}
    frame.id='plugin-frame';frame.title=m.name;frame.sandbox='allow-scripts allow-forms';frame.allow='fullscreen; autoplay';frame.allowFullscreen=true;
    const a=this.active={componentSession:activation?.session,record,binding:binding(record),frame,roomId:null,authorized:new Set(),peers:new Map(),pending:new Map(),closed:false,inflight:0,storageKey:'cyber.plugin.data.'+record.id,command};
    a.microphone=new Microphone((value,transfer=[])=>{if(this.active===a)a.port.postMessage({event:'audio-input',value},transfer);});
    const savedValues=storageGet(a.storageKey,{}),values=savedValues&&typeof savedValues==='object'&&!Array.isArray(savedValues)?savedValues:{};if(migrateLegacyData(record.id,values))storageSet(a.storageKey,values);
    for(const key of ['cyber.nickname','cyber.sound','cyber.motion'])values[key]=storageGet(key,settings()[key.slice(6)]??(key==='cyber.nickname'?'':true));a.values=values;
    if(command.mode!=='recover'){for(const key of Object.keys(values))if(key.startsWith('cyber.active.'))delete values[key];}
    else {const saved=values['cyber.active.'+this.client.identityKey()];if(sameBinding(saved?.room?.plugin,a.binding)){a.roomId=saved.room.roomId;a.hostId=saved.room.hostId;}}
    const channel=new MessageChannel();a.port=channel.port1;a.port.onmessage=e=>this.dispatch(a,e.data);a.port.start();
    const init=e=>{if(e.source!==frame.contentWindow||e.data?.type!=='cyber:ready'||this.active!==a)return;removeEventListener('message',init);clearTimeout(a.loadTimer);
      frame.contentWindow.postMessage({type:'cyber:init',bootstrap:{manifest:m,binding:a.binding,platform:platform(),hostProtocol:location.protocol,assets:payload.assets,rules:payload.rules,storage:values,connection:this.connection(),connectionKey:this.client.identityKey(),command,settings:{nickname:values['cyber.nickname'],sound:values['cyber.sound'],motion:values['cyber.motion']},nativeComponent:component?{exports:component.exports,capabilities:component.capabilities}:null}},'*',[channel.port2]);};
    a.init=init;addEventListener('message',init);a.loadTimer=setTimeout(()=>{if(this.active===a){this.events.error?.('插件启动超时');this.close();}},15000);
    // Opaque origin: no parent DOM, cookies, storage or native host object. All calls use the bound port.
    const script='data:text/javascript;base64,'+base64(new TextEncoder().encode(payload.script));
    const network=m.permissions.includes('network')?'https: http:':'';
    frame.srcdoc='<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src data: blob:; style-src \'unsafe-inline\'; img-src data: blob: '+network+'; media-src blob: data: '+network+'; connect-src '+(m.permissions.includes('network')?'https: http:':'\'none\'')+'; worker-src blob: data:; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'"><style>'+payload.style.replace(/<\/style/gi,'')+'</style><body><main>'+payload.html+'</main><script type="module" src="'+script+'"></script></body></html>';
    this.container.replaceChildren(frame);this.events.open?.(m);storageSet('cyber.activePlugin',{id:record.id,release:record.release});
    }finally{this.opening=null;opening.resolve();}
  }
  async dispatch(a,m){if(!m||!Number.isSafeInteger(m.request)||typeof m.method!=='string'||!Array.isArray(m.args))return;
    a.inflight++;try{this.current(a);if(a.inflight>128)throw Error('插件请求过多');const value=await this.invoke(a,m.method,m.args);if(this.active===a)a.port.postMessage({reply:m.request,value});}
    catch(e){if(this.active===a)a.port.postMessage({reply:m.request,error:{message:e.message,code:e.code}});}finally{a.inflight--;}
  }
  requireRoom(a,id){this.current(a);if(!a.roomId||id!==a.roomId)throw Error('插件无权访问该房间');}
  async invoke(a,method,args){const c=this.client,m=a.record.manifest;this.current(a);
    if(method==='connect'){c.connect();return true;}
    if(method==='storage.set'){const [key,value]=args;if(!m.permissions.includes('storage.private')||typeof key!=='string'||key.length>200||['__proto__','constructor','prototype'].includes(key))throw Error('存储键无效');const next={...a.values,[key]:value};if(JSON.stringify(next).length>524288||!storageSet(a.storageKey,next))throw Error('插件存储空间不足');a.values=next;return true;}
    if(method==='storage.secureRead'||method==='storage.secureWrite'){if(!m.permissions.includes('storage.private'))throw Error('插件没有存储接口');if(!native)throw Error('此平台使用插件私有浏览器存储');if(method==='storage.secureRead')return nativeCall('secureRead',m.id);const value=args[0];if(typeof value!=='string'||new TextEncoder().encode(value).length>262144)throw Error('安全存档过大或格式无效');return nativeCall('secureWrite',m.id,value);}
    if(method==='plugin.state'){if(args[0]?.roomId!==a.roomId)throw Error('房间状态不匹配');this.events.state?.(args[0]);return true;}
    if(method==='plugin.error'){this.events.error?.(String(args[0]).slice(0,300));await this.close();return true;}
    if(method==='plugin.close'){await this.close();return true;}
    if(method==='plugin.disposed'){a.disposed?.();return true;}
    if(method==='microphone.start'||method==='microphone.stop'){if(!m.permissions.includes('voice'))throw Error('插件没有麦克风权限');if(method==='microphone.stop'){a.microphone.stop();return true;}this.requireRoom(a,a.roomId);if(a.closePromise)throw Error('插件正在退出');return a.microphone.start(args[0]);}
    if(method==='native')return this.native(a,...args);
    if(!m.permissions.includes('room.messaging'))throw Error('插件没有通信接口');
    if(method==='room.create'){if(a.roomId||a.creating)throw Error('房间已绑定插件，更换必须重建');a.creating=true;try{const q=args[0];const result=await c.createRoom({name:q.name,roomType:m.roomFeature.slice(0,16),locked:!!q.locked,metadata:JSON.stringify({...a.binding,targets:Object.keys(m.targets)})});if(this.active!==a){await c.leaveRoom(result.roomId);throw Error('插件已退出');}a.roomId=result.roomId;a.hostId=c.identity.clientId;a.authorized.add(a.hostId);return result;}finally{a.creating=false;}}
    if(method==='room.join'){if(a.roomId&&a.roomId!==args[0])throw Error('不能在房间内更换插件');if(a.joining)throw Error('正在加入');a.joining=true;a.roomId=args[0];try{const result=await c.joinRoom(a.roomId,{...args[1],plugin:a.binding,platform:platform(),feature:m.roomFeature.slice(16)});this.current(a);const decision=object(result.rawBody);if(decision.allowed){if(!sameBinding(decision.room?.plugin,a.binding))throw Error('房主插件版本不一致');const membership=await c.roomSync(a.roomId);this.current(a);a.hostId=membership.hostId;a.authorized=new Set(membership.members.map(p=>p.clientId));}else a.roomId=null;return result;}catch(e){await c.leaveRoom(args[0]).catch(()=>{});a.roomId=null;throw e;}finally{a.joining=false;}}
    if(method==='room.list')return c.listRooms({roomType:m.roomFeature.slice(0,16)});
    if(method==='room.reply'){const request=a.pending.get(args[0]);if(!request)throw Error('入房申请已失效');a.pending.delete(args[0]);const body=args[1];if(body.allowed&&!sameBinding(body.room?.plugin,a.binding))throw Error('插件不能改变房间绑定');const result=await c.replyJoin(request,body);this.current(a);if(result===false)throw Error('入房回复未发送');if(body.allowed){a.authRevision=(a.authRevision||0)+1;a.authorized.add(request.control.from);}return result;}
    if(method==='room.request'){if(args[0]!==210||!a.roomId)throw Error('不支持的服务操作');const result=await c.request(210,{});this.current(a);a.discovery=object(result.rawBody);return result;}
    this.requireRoom(a,args[0]);
    if(method==='room.sync'){const revision=a.authRevision||0,result=await c.roomSync(args[0],args[1]);this.current(a);if(revision===(a.authRevision||0)&&result.version>=(a.membershipVersion||0)){a.membershipVersion=result.version;a.hostId=result.hostId;a.authorized=new Set(result.members.map(p=>p.clientId));for(const id of a.peers.keys())if(!a.authorized.has(id))a.peers.delete(id);}return result;}
    if(method==='room.leave'){const result=await c.leaveRoom(args[0]);this.current(a);a.roomId=null;a.authorized.clear();a.peers.clear();a.microphone.stop();this.client.clearPeers();return result;}
    if(method==='room.send'){if(!a.authorized.has(args[1])&&args[1]!==a.hostId)throw Error('接收者尚未获准');return c.sendTo(...args);}
    if(method==='room.broadcast'){if(args[1]?.some(id=>!a.authorized.has(id)))throw Error('接收者尚未获准');return c.broadcast(...args);}
    throw Error('未公开的插件接口');
  }
  async native(a,method,...args){if(!native)throw Error('当前平台没有原生接口');
    const component=a.record.artifacts[platform()]?.native,permission=component?.exports?.[method];
    if(permission){if(!a.record.manifest.permissions.includes(permission))throw Error('插件未声明此组件权限');const viewport=a.frame.getBoundingClientRect();return nativeCall('extensionCall',JSON.stringify({method,args,scope:{roomId:a.roomId||'',selfId:this.client.identity?.clientId,members:[...a.authorized],viewport:{x:viewport.x,y:viewport.y,width:viewport.width,height:viewport.height}}}));}
    if(!['udpRegister','openPeer','closePeers','roomActive'].includes(method))throw Error('未公开的原生接口');
    if(method==='roomActive')return true;
    if(method==='udpRegister'){if(!a.discovery||!a.roomId)throw Error('没有直连登记');args=[this.client.identity.clientId,a.discovery.ticket,a.discovery.port];}
    if(method==='openPeer'){const q=JSON.parse(args[0]);if(!a.authorized.has(q.peerId)||!/^[a-f0-9]{32}$/.test(q.context)||typeof q.master!=='string'||q.master.length!==44)throw Error('对端或直连上下文无效');a.peers.set(q.peerId,q.context);}
    if(method==='closePeers')a.peers.clear();
    return nativeCall(method,...args);
  }
  message(message){const a=this.active;if(!a)return;const c=message.control;
    if(message.kind===16&&c.op==='102'){let application;try{application=object(message.rawBody);}catch{this.client.replyJoin(message,{allowed:false,reason:'插件申请格式无效'});return;}
      if(c.roomId!==a.roomId||!sameBinding(application.plugin,a.binding)||!a.record.manifest.targets[application.platform]){this.client.replyJoin(message,{allowed:false,reason:'插件版本或平台不匹配'});return;}
      a.pending.set(c.requestId,message);if(a.pending.size>128)a.pending.delete(a.pending.keys().next().value);
    }
    if(message.kind===64&&c.roomId!==a.roomId)return;this.emit('message',message);
  }
  async close(){if(this.opening){this.opening.cancelled=true;await this.opening.done;}const a=this.active;if(!a)return;if(a.closePromise)return a.closePromise;
    a.closePromise=(async()=>{a.microphone.stop();const saved=new Promise(resolve=>a.disposed=resolve);this.emit('dispose');let timer;await Promise.race([saved,new Promise(resolve=>timer=setTimeout(resolve,5000))]);clearTimeout(timer);
      try{if(a.roomId)await this.client.leaveRoom(a.roomId);}catch{}finally{if(this.active!==a)return;a.closed=true;removeEventListener('message',a.init);clearTimeout(a.loadTimer);a.port.close();a.frame.remove();this.client.clearPeers();if(native)await nativeCall('extensionClose').catch(()=>{});this.active=null;storageSet('cyber.activePlugin',null);this.events.close?.();}})();return a.closePromise;
  }
}
