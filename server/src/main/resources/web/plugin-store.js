import {downloadPackage} from './plugin-download.js';
import {native,nativeCall,storageGet} from './transport.js';
import {validateManifest,validateRelease,incompatibility,PACKAGE_LIMIT} from './plugin-package.js';
const enc=new TextEncoder(),decode64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
export const platform=()=>native?.platform==='WINDOWS'?'windows':native?'android':'web';
export function marketURL(){const value=storageGet('cyber.market',native?'https://fqgame.tdcode.tech/plugins/':new URL('/plugins/',location.href).href),url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('插件市场地址无效');if(!url.pathname.endsWith('/'))url.pathname+='/';return url;}
function database(){return new Promise((resolve,reject)=>{const request=indexedDB.open('cyber-plugins',1);request.onupgradeneeded=()=>{request.result.createObjectStore('packages');request.result.createObjectStore('state');};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
export class PluginStore{
  async lock(id,action){if(navigator.locks)return navigator.locks.request('cyber.plugin.'+id,action);const queues=this.queues??=new Map(),old=queues.get(id)||Promise.resolve(),next=old.catch(()=>{}).then(action);queues.set(id,next);try{return await next;}finally{if(queues.get(id)===next)queues.delete(id);}}
  trusted(record){const known=this.catalog?.releases.find(r=>r.id===record.id&&r.release===record.release);if(!known||known.revoked||JSON.stringify(known)!==JSON.stringify(record))throw Error('发布记录未通过当前市场签名校验');}
  async transaction(store,mode,action){const db=await (this.db??=database());return new Promise((resolve,reject)=>{const tx=db.transaction(store,mode),request=action(tx.objectStore(store));tx.oncomplete=()=>resolve(request.result);tx.onabort=tx.onerror=()=>reject(tx.error||Error('插件存储失败'));});}
  get(store,key){return this.transaction(store,'readonly',s=>s.get(key));}
  put(store,key,value){return this.transaction(store,'readwrite',s=>s.put(value,key));}
  async select(id,release){const db=await(this.db??=database());return new Promise((resolve,reject)=>{const tx=db.transaction('state','readwrite'),s=tx.objectStore('state'),read=s.get('installed');read.onsuccess=()=>{const installed=read.result||{};if(release)installed[id]=release;else delete installed[id];s.put(installed,'installed');};tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error||Error('安装记录保存失败'));});}
  async fetch(path,limit){const url=new URL(path,marketURL());if(!url.href.startsWith(marketURL().href))throw Error('插件下载地址越界');
    if(native){const value=await nativeCall('marketFetch',url.href,limit);if(typeof value!=='string'||enc.encode(value).length>limit)throw Error('插件响应无效');return value;}
    const response=await fetch(url,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(35000)});if(!response.ok)throw Error('插件市场请求失败：'+response.status);if(Number(response.headers.get('content-length'))>limit)throw Error('插件文件过大');
    const reader=response.body.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('插件文件过大');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }
  async verify(envelope){const trust=await (this.trust??=fetch('./plugin-trust.json').then(r=>{if(!r.ok)throw Error('缺少插件信任配置');return r.json();}));
    if(typeof envelope.payload!=='string'||typeof envelope.signature!=='string')throw Error('插件市场签名缺失');let valid=false;
    for(const jwk of trust.keys){const key=await crypto.subtle.importKey('jwk',jwk,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);if(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,decode64(envelope.signature),enc.encode(envelope.payload))){valid=true;break;}}
    if(!valid)throw Error('插件市场签名无效');const catalog=JSON.parse(envelope.payload);if(catalog.schemaVersion!==1||!Array.isArray(catalog.releases)||catalog.releases.length>10000)throw Error('插件市场格式无效');catalog.releases.forEach(validateRelease);return catalog;
  }
  async refresh(){const envelope=JSON.parse(await this.fetch('catalog.json',4*1024*1024));const catalog=await this.verify(envelope);await this.put('state','catalog',envelope);this.catalog=catalog;return catalog;}
  async cached(){const envelope=await this.get('state','catalog');if(!envelope)return {releases:[]};this.catalog=await this.verify(envelope);return this.catalog;}
  latest(){const result=new Map();for(const r of this.catalog?.releases||[])if(!r.revoked)result.set(r.id,r);return [...result.values()];}
  async installed(){return (await this.get('state','installed'))||{};}
  async prepareNative(record){const component=record.artifacts[platform()]?.native;if(!component)return;const q={...component,url:new URL(component.path,marketURL()).href};const result=JSON.parse(await nativeCall('extensionPrepare',JSON.stringify(q)));if(!result.ready)throw Error('请在系统界面允许并安装原生组件，然后返回这里重试');}
  async find(id,release){const list=this.catalog?.releases||[];return release?list.find(r=>r.id===id&&r.release===release):this.latest().find(r=>r.id===id);}
  async install(record){validateRelease(record);this.trusted(record);return this.lock(record.id,async()=>{const error=incompatibility(record.manifest,platform());if(error)throw Error(error);const a=record.artifacts[platform()],key=record.id+'@'+record.release;
    const total=a.size+(a.native?.size||0);let loaded=0,phase='下载插件';
    const report=(received)=>{loaded=received;this.onProgress?.({id:record.id,name:record.manifest.name,received,total,phase});};
    const nativeProgress=e=>{const q=e.detail;if(q?.type!=='pluginDownload'||!Number.isFinite(q.received))return;if(q.sha256===a.sha256)report(Math.min(a.size,q.received));else if(q.sha256===a.native?.sha256)report(a.size+Math.min(a.native.size,q.received));};
    globalThis.addEventListener?.('native-room',nativeProgress);
    try{
      report(0);let saved=await this.get('packages',key);if(saved&&(JSON.stringify(saved.record)!==JSON.stringify(record)||await digest(saved.raw)!==a.sha256))saved=null;
      if(!saved){
        const url=new URL(a.path,marketURL());let raw;
        if(native){if(!native.marketDownload)throw Error('请更新客户端以支持插件下载进度和续传');raw=await nativeCall('marketDownload',JSON.stringify({...a,url:url.href}));}
        else raw=await downloadPackage(url,a,this,n=>report(n));
        phase='校验插件';report(a.size);
        if(typeof raw!=='string'||enc.encode(raw).length!==a.size||await digest(raw)!==a.sha256){await this.put('state','partial:'+a.sha256,null);throw Error('插件文件校验失败，请重新下载');}
        const payload=JSON.parse(raw);validateManifest(payload.manifest);if(JSON.stringify(payload.manifest)!==JSON.stringify(record.manifest)||typeof payload.script!=='string'||typeof payload.html!=='string'||typeof payload.style!=='string')throw Error('插件包与发布信息不一致');
        saved={record,raw};await this.put('packages',key,saved);await this.put('state','partial:'+a.sha256,null);
      }
      phase=a.native?'下载播放组件':'安装插件';report(a.size);
      // Publish only after the package and its native component have both passed verification.
      await this.prepareNative(record);this.trusted(record);await this.select(record.id,record.release);const result=await this.load(record.id,record.release);phase='安装完成';report(total);return result;
    }catch(error){this.onProgress?.({id:record.id,name:record.manifest.name,received:loaded,total,phase:'下载未完成',error:error.message});throw error;}
    finally{globalThis.removeEventListener?.('native-room',nativeProgress);}
    });
  }

  async load(id,release){release??=(await this.installed())[id];if(!release)return null;const saved=await this.get('packages',id+'@'+release);if(!saved)return null;validateRelease(saved.record);
    const known=this.catalog?.releases.find(r=>r.id===id&&r.release===release);if(known?.revoked)throw Error('该插件版本已停止使用');if(!known||JSON.stringify(known)!==JSON.stringify(saved.record))throw Error('缺少该插件的有效签名记录，请刷新市场');const error=incompatibility(known.manifest,platform());if(error)throw Error(error);
    if(await digest(saved.raw)!==saved.record.artifacts[platform()].sha256)throw Error('本地插件文件损坏，请重新安装');return {record:saved.record,payload:JSON.parse(saved.raw)};
  }
  async uninstall(id){return this.lock(id,async()=>{await this.select(id,null);const keys=await this.transaction('packages','readonly',s=>s.getAllKeys());for(const key of keys)if(key.startsWith(id+'@'))await this.transaction('packages','readwrite',s=>s.delete(key));});}
}
