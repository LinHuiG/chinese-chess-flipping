// Build independently installable, signed plugin releases. Private keys never enter the repository.
import {build} from 'esbuild';
import {readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises';
import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,sign,verify} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateManifest} from '../server/src/main/resources/web/plugin-package.js';
const root=fileURLToPath(new URL('../',import.meta.url)),out=path.join(root,'server/plugin-market');
const dev=process.argv.includes('--development'),keyPath=process.env.PLUGIN_SIGNING_KEY_FILE||path.join(root,'server/target/plugin-signing-key.pem');
await mkdir(out,{recursive:true});await mkdir(path.dirname(keyPath),{recursive:true});
let key;
try{key=createPrivateKey(await readFile(keyPath));}catch(e){if(!dev)throw Error('Set PLUGIN_SIGNING_KEY_FILE, or use --development for a local signing key.');const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});key=pair.privateKey;await writeFile(keyPath,key.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});}
const publicKey=createPublicKey(key),jwk=publicKey.export({format:'jwk'}),trustPath=path.join(root,'server/src/main/resources/web/plugin-trust.json');
try{const trust=JSON.parse(await readFile(trustPath));if(!trust.keys.some(k=>k.x===jwk.x&&k.y===jwk.y))throw Error('Signing key is not in plugin-trust.json. Add the public key explicitly before building.');}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(trustPath,JSON.stringify({keys:[jwk]},null,2)+'\n');}
const hash=s=>createHash('sha256').update(s).digest('hex'),read=n=>readFile(path.join(root,n),'utf8');
let releases=[];
try{const old=JSON.parse(await readFile(path.join(out,'catalog.json'),'utf8'));if(!verify('sha256',Buffer.from(old.payload),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(old.signature,'base64')))throw Error('Previous marketplace signature is invalid');releases=JSON.parse(old.payload).releases;}catch(e){if(e.code!=='ENOENT')throw e;}
const mime={'.js':'text/javascript','.txt':'text/plain','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp'};
async function assets(dir,prefix='',result={}){for(const f of await readdir(dir,{withFileTypes:true})){const name=prefix+f.name;if(f.isDirectory()){if(prefix||['assets','vendor'].includes(f.name))await assets(path.join(dir,f.name),name+'/',result);}else if(mime[path.extname(name)]&&(name.startsWith('assets/')||name.startsWith('vendor/')||name==='voice-worklet.js'))result[name]='data:'+mime[path.extname(name)]+';base64,'+(await readFile(path.join(dir,f.name))).toString('base64');}return result;}
async function sourceFingerprint(dirs){const entries=[];async function scan(dir){for(const f of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(['build','target','.gradle'].includes(f.name))continue;const file=path.join(dir,f.name);if(f.isDirectory())await scan(file);else entries.push([path.relative(root,file).replaceAll('\\','/'),hash((await readFile(file,'utf8')).replaceAll('\r\n','\n'))]);}}for(const dir of dirs)await scan(path.join(root,dir));entries.push(['android-build',hash((await read('android_client/build.gradle.kts')).replaceAll('\r\n','\n'))]);return hash(JSON.stringify(entries));}
for(const f of await readdir(path.join(root,'plugins'),{withFileTypes:true})){
  if(!f.isDirectory())continue;const dir=path.join(root,'plugins',f.name);let manifest;try{manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}validateManifest(manifest);
  let rules='';try{rules=await readFile(path.join(dir,'rules.txt'),'utf8');}catch{}
  const html=(await read('plugin_sdk/waiting.html'))+(await readFile(path.join(dir,'view.html'),'utf8'))+(await read('plugin_sdk/dialogs.html'));
  const style=await read('plugin_sdk/style.css'),files=await assets(dir),artifacts={},licenses={project:await read('LICENSE')};
  if(f.name==='watch')licenses.hls=await readFile(path.join(dir,'vendor/hls.LICENSE'),'utf8');
  for(const [target,config] of Object.entries(manifest.targets)){
    const entry=path.resolve(dir,config.entry);if(!entry.startsWith(dir+path.sep))throw Error('Entry escapes plugin directory');
    const result=await build({entryPoints:[entry],bundle:true,write:false,format:'esm',target:'es2022',minify:false,legalComments:'inline',absWorkingDir:root,define:{'globalThis.__CYBER_TEST_BOOTSTRAP__':'undefined'}});
    const payload=JSON.stringify({manifest,html,style,script:result.outputFiles[0].text,assets:files,rules,licenses}),digest=hash(payload);
    const name=manifest.id+'/'+manifest.version+'/'+target+'-'+digest+'.json';await mkdir(path.dirname(path.join(out,name)),{recursive:true});await writeFile(path.join(out,name),payload);
    artifacts[target]={path:name,sha256:digest,size:Buffer.byteLength(payload)};
    if(config.native){
      const n=config.native;let file,extra={};
      if(target==='android'&&n.kind==='apk'){
        const variant=process.env.PLUGIN_APK_VARIANT||'debug',folder=path.join(dir,'native/android/build/outputs/apk',variant);
        const metadata=JSON.parse(await readFile(path.join(folder,'output-metadata.json'),'utf8')),item=metadata.elements[0];
        if(metadata.applicationId!==n.packageName)throw Error('Native APK package mismatch');file=path.join(folder,item.outputFile);extra.versionCode=item.versionCode;extra.sourceHash=await sourceFingerprint(['plugins/'+f.name+'/native/android','plugin_sdk/native/android']);if(!dev){const prior=releases.map(r=>r.artifacts.android?.native).find(p=>p?.packageName===n.packageName&&p.sourceHash===extra.sourceHash);if(prior){file=path.join(out,prior.path);extra.versionCode=prior.versionCode;}}
      }else if(target==='windows'&&n.kind==='exe'){file=path.join(dir,'native/windows/target/release/cyber-watch-component.exe');extra.capabilities={playerCapabilities:{engine:'mpv',embeddedTracks:true}};}
      else throw Error('Unsupported native component format');
      const raw=await readFile(file),sha256=hash(raw);if(target==='android'&&!dev){const prior=releases.map(r=>r.artifacts.android?.native).find(p=>p?.packageName===n.packageName&&p.sha256!==sha256);if(prior)throw Error('Android native package is immutable; use a new packageName for new component builds, retaining old releases.');}const nativePath=manifest.id+'/'+manifest.version+'/native-'+sha256+'.'+n.kind;
      if(path.resolve(file)!==path.resolve(out,nativePath))await copyFile(file,path.join(out,nativePath));artifacts[target].native={...n,...extra,path:nativePath,sha256,size:raw.length};
    }
  }
  const release=hash(JSON.stringify({manifest,artifacts}));releases=releases.filter(r=>r.id!==manifest.id||r.release!==release);
  releases.push({id:manifest.id,version:manifest.version,release,manifest,artifacts,revoked:false});console.log(manifest.id,manifest.version,Object.keys(artifacts).join('/'));
}
const payload=JSON.stringify({schemaVersion:1,releases}),signature=sign('sha256',Buffer.from(payload),{key,dsaEncoding:'ieee-p1363'}).toString('base64');
await writeFile(path.join(out,'catalog.json'),JSON.stringify({payload,signature}));console.log('Signed catalog written to server/plugin-market; private key retained locally.');
