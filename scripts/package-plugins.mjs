// Build independently installable, signed plugin releases. Private keys never enter the repository.
import {build} from 'esbuild';
import {readFile,writeFile,mkdir,readdir,copyFile,realpath,lstat,unlink,rmdir,rename} from 'node:fs/promises';
import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,sign,verify,randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateManifest,validateRelease} from '../server/src/main/resources/web/plugin-package.js';
const root=fileURLToPath(new URL('../',import.meta.url)),argument=name=>{const i=process.argv.indexOf(name);if(i<0)return null;if(!process.argv[i+1]||process.argv[i+1].startsWith('--'))throw Error('Missing value: '+name);return path.resolve(process.argv[i+1]);},out=argument('--output')||path.join(root,'server/plugin-market');
const dev=process.argv.includes('--development'),keyPath=process.env.PLUGIN_SIGNING_KEY_FILE||path.join(root,'server/target/plugin-signing-key.pem');
if(!dev&&(argument('--output')||argument('--trust-output')))throw Error('Local output/trust overrides require --development');
await mkdir(out,{recursive:true});await mkdir(path.dirname(keyPath),{recursive:true});
const outRoot=await realpath(out),pluginName=/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/,versionName=/^\d+\.\d+\.\d+$/,artifactName=/^(?:(?:web|android|windows)-[a-f0-9]{64}\.json|native-[a-f0-9]{64}\.(?:apk|exe))$/;
function withinOut(file){const relative=path.relative(outRoot,path.resolve(file));if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Marketplace path escapes output directory');return path.resolve(file);}
async function outputFile(name,create=false){
  const file=withinOut(path.resolve(outRoot,name)),parts=path.relative(outRoot,file).split(path.sep);let parent=outRoot;
  for(const part of parts.slice(0,-1)){parent=withinOut(path.join(parent,part));if(create)await mkdir(parent).catch(e=>{if(e.code!=='EEXIST')throw e;});const info=await lstat(parent);if(info.isSymbolicLink()||!info.isDirectory())throw Error('Marketplace directory must not be a link');withinOut(await realpath(parent));}
  try{const info=await lstat(file);if(info.isSymbolicLink()||!info.isFile())throw Error('Marketplace artifact must be a regular file');}catch(e){if(e.code!=='ENOENT')throw e;}
  return file;
}
let key;
try{key=createPrivateKey(await readFile(keyPath));}catch(e){if(!dev)throw Error('Set PLUGIN_SIGNING_KEY_FILE, or use --development for a local signing key.');const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});key=pair.privateKey;await writeFile(keyPath,key.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});}
const publicKey=createPublicKey(key),jwk=publicKey.export({format:'jwk'}),trustPath=argument('--trust-output')||path.join(root,'server/src/main/resources/web/plugin-trust.json');
try{const trust=JSON.parse(await readFile(trustPath));if(!trust.keys.some(k=>k.x===jwk.x&&k.y===jwk.y))throw Error('Signing key is not in plugin-trust.json. Add the public key explicitly before building.');}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(trustPath,JSON.stringify({keys:[jwk]},null,2)+'\n');}
const hash=s=>createHash('sha256').update(s).digest('hex'),read=n=>readFile(path.join(root,n),'utf8');
const releases=[],androidPackages=Object.create(null);let previous=[];
try{
  const old=JSON.parse(await readFile(await outputFile('catalog.json'),'utf8'));if(!verify('sha256',Buffer.from(old.payload),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(old.signature,'base64')))throw Error('Previous marketplace signature is invalid');
  const catalog=JSON.parse(old.payload);if(catalog.schemaVersion!==1||!Array.isArray(catalog.releases))throw Error('Previous marketplace format is invalid');previous=catalog.releases;previous.forEach(validateRelease);
  if(catalog.androidPackages!==undefined&&(!catalog.androidPackages||typeof catalog.androidPackages!=='object'||Array.isArray(catalog.androidPackages)))throw Error('Android package identities are invalid');
  for(const [name,sha]of Object.entries(catalog.androidPackages||{})){if(!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(name)||!/^[a-f0-9]{64}$/.test(sha))throw Error('Android package identity is invalid');androidPackages[name]=sha;}
  for(const r of previous){const n=r.artifacts.android?.native;if(n){if(!dev&&androidPackages[n.packageName]&&androidPackages[n.packageName]!==n.sha256)throw Error('Conflicting Android package identities');androidPackages[n.packageName]=n.sha256;}}
}catch(e){if(e.code!=='ENOENT')throw e;}
async function obsoleteArtifacts(){
  const keep=new Set(releases.flatMap(r=>Object.values(r.artifacts).flatMap(a=>[a.path,...(a.native?[a.native.path]:[])]))),files=[],dirs=[];
  for(const plugin of await readdir(outRoot,{withFileTypes:true})){
    if(!pluginName.test(plugin.name))continue;const p=withinOut(path.join(outRoot,plugin.name));if(plugin.isSymbolicLink())throw Error('Marketplace directory must not be a link');if(!plugin.isDirectory())continue;withinOut(await realpath(p));
    for(const version of await readdir(p,{withFileTypes:true})){
      if(!versionName.test(version.name))continue;const d=withinOut(path.join(p,version.name));if(version.isSymbolicLink())throw Error('Marketplace directory must not be a link');if(!version.isDirectory())continue;withinOut(await realpath(d));
      for(const item of await readdir(d,{withFileTypes:true})){if(!artifactName.test(item.name))continue;const relative=[plugin.name,version.name,item.name].join('/');await outputFile(relative);if(!keep.has(relative))files.push(relative);}
      dirs.push(d);
    }dirs.push(p);
  }return {files,dirs};
}
const mime={'.js':'text/javascript','.txt':'text/plain','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp'};
async function assets(dir,prefix='',result={}){for(const f of await readdir(dir,{withFileTypes:true})){const name=prefix+f.name;if(f.isDirectory()){if(prefix||['assets','vendor'].includes(f.name))await assets(path.join(dir,f.name),name+'/',result);}else if(mime[path.extname(name)]&&(name.startsWith('assets/')||name.startsWith('vendor/')||name==='voice-worklet.js'))result[name]='data:'+mime[path.extname(name)]+';base64,'+(await readFile(path.join(dir,f.name))).toString('base64');}return result;}
async function sourceFingerprint(dirs){const entries=[];async function scan(dir){for(const f of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(['build','target','.gradle'].includes(f.name))continue;const file=path.join(dir,f.name);if(f.isDirectory())await scan(file);else entries.push([path.relative(root,file).replaceAll('\\','/'),hash((await readFile(file,'utf8')).replaceAll('\r\n','\n'))]);}}for(const dir of dirs)await scan(path.join(root,dir));entries.push(['android-build',hash((await read('android_client/build.gradle.kts')).replaceAll('\r\n','\n'))]);return hash(JSON.stringify(entries));}
for(const f of await readdir(path.join(root,'plugins'),{withFileTypes:true})){
  if(!f.isDirectory())continue;const dir=path.join(root,'plugins',f.name);let manifest;try{manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}validateManifest(manifest);if(releases.some(r=>r.id===manifest.id))throw Error('Duplicate plugin ID: '+manifest.id);
  let rules='';try{rules=await readFile(path.join(dir,'rules.txt'),'utf8');}catch{}
  const html=(await read('plugin_sdk/waiting.html'))+(await readFile(path.join(dir,'view.html'),'utf8'))+(await read('plugin_sdk/dialogs.html'));
  const style=await read('plugin_sdk/style.css'),files=await assets(dir),artifacts={},licenses={project:await read('LICENSE')};
  if(manifest.cover&&(!files[manifest.cover]||files[manifest.cover].length>65536))throw Error('Plugin cover missing or larger than 64 KiB');
  if(f.name==='watch')licenses.hls=await readFile(path.join(dir,'vendor/hls.LICENSE'),'utf8');
  for(const [target,config] of Object.entries(manifest.targets)){
    const entry=path.resolve(dir,config.entry);if(!entry.startsWith(dir+path.sep))throw Error('Entry escapes plugin directory');
    const result=await build({entryPoints:[entry],bundle:true,write:false,format:'esm',target:'es2022',minify:false,legalComments:'inline',absWorkingDir:root,define:{'globalThis.__CYBER_TEST_BOOTSTRAP__':'undefined'}});
    const payload=JSON.stringify({manifest,html,style,script:result.outputFiles[0].text,assets:files,rules,licenses}),digest=hash(payload);
    const name=manifest.id+'/'+manifest.version+'/'+target+'-'+digest+'.json';await writeFile(await outputFile(name,true),payload);
    artifacts[target]={path:name,sha256:digest,size:Buffer.byteLength(payload)};
    if(config.native){
      const n=config.native;let file,extra={};
      if(target==='android'&&n.kind==='apk'){
        const variant=process.env.PLUGIN_APK_VARIANT||'debug',folder=path.join(dir,'native/android/build/outputs/apk',variant);
        const metadata=JSON.parse(await readFile(path.join(folder,'output-metadata.json'),'utf8')),item=metadata.elements[0];
        if(metadata.applicationId!==n.packageName)throw Error('Native APK package mismatch');file=path.join(folder,item.outputFile);extra.versionCode=item.versionCode;extra.sourceHash=await sourceFingerprint(['plugins/'+f.name+'/native/android','plugin_sdk/native/android']);if(!dev){const prior=previous.map(r=>r.artifacts.android?.native).find(p=>p?.packageName===n.packageName&&p.sourceHash===extra.sourceHash);if(prior){file=await outputFile(prior.path);extra.versionCode=prior.versionCode;}}
      }else if(target==='windows'&&n.kind==='exe'){file=path.join(dir,'native/windows/target/release/cyber-watch-component.exe');extra.capabilities={playerCapabilities:{engine:'mpv',embeddedTracks:true}};}
      else throw Error('Unsupported native component format');
      const raw=await readFile(file),sha256=hash(raw);if(target==='android'){if(!dev&&androidPackages[n.packageName]&&androidPackages[n.packageName]!==sha256)throw Error('Android native package is immutable; use a new packageName for different APK bytes.');androidPackages[n.packageName]=sha256;}const nativePath=manifest.id+'/'+manifest.version+'/native-'+sha256+'.'+n.kind,nativeFile=await outputFile(nativePath,true);
      if(path.resolve(file)!==nativeFile)await copyFile(file,nativeFile);artifacts[target].native={...n,...extra,path:nativePath,sha256,size:raw.length};
    }
  }
  const release=hash(JSON.stringify({manifest,artifacts}));
  releases.push(validateRelease({id:manifest.id,version:manifest.version,release,manifest,artifacts,...(manifest.cover?{cover:files[manifest.cover]}:{}),revoked:false}));console.log(manifest.id,manifest.version,Object.keys(artifacts).join('/'));
}
if(!releases.length)throw Error('No plugin releases were built');
// Retain signed package-name digests, not retired releases or their downloadable files.
const cleanup=await obsoleteArtifacts(),payload=JSON.stringify({schemaVersion:1,releases,androidPackages}),signature=sign('sha256',Buffer.from(payload),{key,dsaEncoding:'ieee-p1363'}).toString('base64');
const catalogFile=await outputFile('catalog.json'),temporary=await outputFile('catalog-'+randomBytes(8).toString('hex')+'.tmp');
try{await writeFile(temporary,JSON.stringify({payload,signature}),{flag:'wx'});await rename(temporary,catalogFile);}finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
for(const relative of cleanup.files)await unlink(await outputFile(relative));
for(const dir of cleanup.dirs){withinOut(await realpath(dir));await rmdir(dir).catch(e=>{if(e.code!=='ENOTEMPTY'&&e.code!=='EEXIST')throw e;});}
console.log('Signed latest-only catalog written to '+out+'; removed '+cleanup.files.length+' obsolete artifacts; private key retained locally.');
