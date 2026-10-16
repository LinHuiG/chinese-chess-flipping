export const PLUGIN_API=1,PLATFORMS=['web','android','windows'],PACKAGE_LIMIT=24*1024*1024;
export function validateManifest(m){
  const check=(condition,message)=>{if(!condition)throw Error('插件清单无效：'+message);};
  check(m&&m.schemaVersion===1,'格式版本');check(typeof m.id==='string'&&/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(m.id)&&m.id.length<=100,'插件 ID');
  check(typeof m.key==='string'&&/^[a-z][a-z0-9-]{0,39}$/.test(m.key),'界面标识');check(typeof m.name==='string'&&m.name.length>0&&m.name.length<=60,'名称');
  check(/^\d+\.\d+\.\d+$/.test(m.version),'版本');check(Number.isInteger(m.hostApi)&&m.hostApi>0,'SDK 版本');check(typeof m.protocol==='string'&&m.protocol.length>0&&m.protocol.length<80,'业务协议');
  check(/^[a-f0-9]{32}$/.test(m.roomFeature),'功能标识');check(Number.isInteger(m.room?.minMembers)&&Number.isInteger(m.room?.maxMembers)&&m.room.minMembers>=1&&m.room.maxMembers>=m.room.minMembers&&m.room.maxMembers<=16,'人数范围');
  check(m.targets&&typeof m.targets==='object'&&!Array.isArray(m.targets)&&Object.keys(m.targets).length>0,'支持平台');
  check(Array.isArray(m.permissions)&&new Set(m.permissions).size===m.permissions.length&&m.permissions.every(p=>['room.messaging','storage.private','network','media','voice'].includes(p)),'接口范围');
  for(const [target,c]of Object.entries(m.targets)){check(PLATFORMS.includes(target),'未知平台');check(typeof c?.entry==='string'&&/^[a-zA-Z0-9_./-]+\.js$/.test(c.entry)&&!c.entry.startsWith('/')&&!c.entry.split('/').some(p=>p==='..'||p==='.'||!p),'入口');const n=c.native;if(n){check(n.api===1&&n.kind===(target==='android'?'apk':target==='windows'?'exe':null),'原生组件格式');check(n.exports&&typeof n.exports==='object'&&!Array.isArray(n.exports)&&Object.keys(n.exports).length<=32&&Object.entries(n.exports).every(([method,permission])=>/^[a-z][a-zA-Z0-9]{0,39}$/.test(method)&&!['constructor','prototype','platform','udpRegister','openPeer','closePeers','roomActive'].includes(method)&&m.permissions.includes(permission)),'组件接口声明');if(target==='android')check(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(n.packageName)&&typeof n.entry==='string'&&n.entry.startsWith(n.packageName+'.'),'Android 组件入口');}}
  if(m.cover!==undefined)check(/^assets\/[a-zA-Z0-9_-]+\.(svg|png|webp)$/.test(m.cover),'封面路径');
  check(typeof m.description==='string'&&m.description.length<=1000,'简介');return m;
}
export function incompatibility(m,platform){if(!m.targets[platform])return '此插件不支持当前平台，支持：'+Object.keys(m.targets).join(' / ');if(m.hostApi!==PLUGIN_API)return '请更新赛博房间后使用此插件';return '';}
export const binding=r=>({id:r.id,version:r.version,release:r.release,protocol:r.manifest.protocol});
export const sameBinding=(a,b)=>!!a&&!!b&&['id','version','release','protocol'].every(k=>typeof a[k]==='string'&&a[k]===b[k]);
export function validateRelease(r){validateManifest(r?.manifest);if(r.id!==r.manifest.id||r.version!==r.manifest.version||!/^[a-f0-9]{64}$/.test(r.release))throw Error('插件发布身份无效');
  for(const p of Object.keys(r.manifest.targets)){const a=r.artifacts?.[p];if(!a||!/^[a-f0-9]{64}$/.test(a.sha256)||!Number.isSafeInteger(a.size)||a.size<1||a.size>PACKAGE_LIMIT||a.path!==`${r.id}/${r.version}/${p}-${a.sha256}.json`)throw Error('插件发布文件无效');
    const n=a.native,c=r.manifest.targets[p].native;if(!!n!==!!c)throw Error('缺少声明的原生组件');if(n){if(n.api!==1||!['apk','exe'].includes(n.kind)||n.kind!==(p==='android'?'apk':p==='windows'?'exe':'')||n.kind!==c.kind||n.entry!==c.entry||n.packageName!==c.packageName||JSON.stringify(n.exports)!==JSON.stringify(c.exports)||!/^[a-f0-9]{64}$/.test(n.sha256)||!Number.isSafeInteger(n.size)||n.size<1||n.size>200*1024*1024||(p==='android'&&(!Number.isSafeInteger(n.versionCode)||n.versionCode<1))||n.path!==`${r.id}/${r.version}/native-${n.sha256}.${n.kind}`)throw Error('原生组件发布无效');}
  }return r;
}
