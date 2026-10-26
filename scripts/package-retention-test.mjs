// Isolated packager integration checks. Fake APK/EXE bytes are never executed.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,readdir,rm,realpath,symlink,unlink} from 'node:fs/promises';
import {generateKeyPairSync,sign,verify,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),target=path.join(root,'server/target');await mkdir(target,{recursive:true});const fixture=await mkdtemp(path.join(target,'package-retention-test-')),out=path.join(fixture,'server/plugin-market'),keyPath=path.join(fixture,'signing.pem'),hash=s=>createHash('sha256').update(s).digest('hex');
const write=async(name,value)=>{const file=path.join(fixture,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,value);};
const json=(name,value)=>write(name,JSON.stringify(value));
const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),manifests={};let catalogText;
const envelope=payload=>JSON.stringify({payload:JSON.stringify(payload),signature:sign('sha256',Buffer.from(JSON.stringify(payload)),{key:key.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')});
const run=(expectedError)=>{const result=spawnSync(process.execPath,['scripts/package-plugins.mjs'],{cwd:fixture,env:{...process.env,PLUGIN_SIGNING_KEY_FILE:keyPath,PLUGIN_APK_VARIANT:'debug'},encoding:'utf8'});if(expectedError){assert.notEqual(result.status,0);assert.match(result.stderr,expectedError);}else assert.equal(result.status,0,result.stderr);return result;};
async function catalog(){catalogText=await readFile(path.join(out,'catalog.json'),'utf8');const signed=JSON.parse(catalogText);assert(verify('sha256',Buffer.from(signed.payload),{key:key.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signed.signature,'base64')));return JSON.parse(signed.payload);}
async function files(dir=out,prefix=''){const result=[];for(const f of await readdir(dir,{withFileTypes:true})){const name=prefix+f.name;if(f.isDirectory())result.push(...await files(path.join(dir,f.name),name+'/'));else result.push(name);}return result.sort();}
async function update(version,packageName='com.cyberroom.watch.v103',apk='apk-v103',source='native-v103'){
 for(const [name,m]of Object.entries(manifests)){m.version=version;if(name==='watch'){m.targets.android.native.packageName=packageName;m.targets.android.native.entry=packageName+'.WatchExtension';}await json(`plugins/${name}/manifest.json`,m);}
 await write('plugins/watch/native/android/source.java',source);await write('plugins/watch/native/android/build/outputs/apk/debug/component.apk',apk);await json('plugins/watch/native/android/build/outputs/apk/debug/output-metadata.json',{applicationId:packageName,elements:[{outputFile:'component.apk',versionCode:packageName.endsWith('v104')?104:103}]});
}
try{
 await write('package.json','{"type":"module"}');
 const esbuild=pathToFileURL(createRequire(import.meta.url).resolve('esbuild')).href;
 await write('scripts/package-plugins.mjs',(await readFile(path.join(root,'scripts/package-plugins.mjs'),'utf8')).replace("from 'esbuild'",'from '+JSON.stringify(esbuild)));
 await write('server/src/main/resources/web/plugin-package.js',await readFile(path.join(root,'server/src/main/resources/web/plugin-package.js'),'utf8'));
 await write('signing.pem',key.privateKey.export({format:'pem',type:'pkcs8'}));await json('server/src/main/resources/web/plugin-trust.json',{keys:[key.publicKey.export({format:'jwk'})]});
 for(const name of ['waiting.html','dialogs.html','style.css'])await write('plugin_sdk/'+name,'/* fixture */');await write('plugin_sdk/native/android/source.java','sdk-v1');await write('android_client/build.gradle.kts','build-v1');await write('LICENSE','Local fixture');await write('plugins/watch/vendor/hls.LICENSE','Local fixture');await write('plugins/watch/native/windows/target/release/cyber-watch-component.exe','exe-v1');
 for(const name of ['chess','miner','watch']){const m=JSON.parse(await readFile(path.join(root,'plugins',name,'manifest.json'),'utf8'));delete m.cover;manifests[name]=m;await write(`plugins/${name}/app.js`,'export const fixture=1;');await write(`plugins/${name}/view.html`,'<p>Local fixture</p>');}
 await update('1.0.1');run();const first=await catalog();assert.equal(first.releases.length,3);const originalNative=first.releases.find(r=>r.id==='official.watch').artifacts.android.native;
 // Migrate the previous format, which only recorded package identities in releases.
 delete first.androidPackages;await write('server/plugin-market/catalog.json',envelope(first));
 await write('server/plugin-market/retired.plugin/0.0.1/web-'+ '0'.repeat(64)+'.json','orphan');await write('server/plugin-market/official.chess/1.0.0/native-'+ '1'.repeat(64)+'.exe','orphan');await write('server/plugin-market/keep.txt','outside artifact namespace');
 // A rebuilt unsigned APK differs, but an unchanged native source must reuse signed bytes.
 await update('1.0.2','com.cyberroom.watch.v103','different-local-rebuild');run();let current=await catalog();assert.equal(current.releases.length,3);assert(current.releases.every(r=>r.version==='1.0.2'));
 const reused=current.releases.find(r=>r.id==='official.watch').artifacts.android.native;assert.equal(reused.sha256,originalNative.sha256);assert.equal(reused.versionCode,103);assert.equal(await readFile(path.join(out,reused.path),'utf8'),'apk-v103');assert.equal(current.androidPackages[reused.packageName],originalNative.sha256);
 const artifactPaths=current.releases.flatMap(r=>Object.values(r.artifacts).flatMap(a=>[a.path,...(a.native?[a.native.path]:[])])).sort();assert.deepEqual(await files(),['catalog.json','keep.txt',...artifactPaths].sort());
 assert(!(await readdir(out)).includes('retired.plugin'));assert.deepEqual(await readdir(path.join(out,'official.chess')),['1.0.2']);
 // Retire v103, then ensure its immutable package-name identity still cannot be reused.
 await update('1.0.3','com.cyberroom.watch.v104','apk-v104','native-v104');run();current=await catalog();assert.equal(Object.keys(current.androidPackages).length,2);assert(current.releases.every(r=>r.version==='1.0.3'));const committed=catalogText;
 await update('1.0.4','com.cyberroom.watch.v103','replacement-for-retired-v103','native-changed');run(/Android native package is immutable/);assert.equal(await readFile(path.join(out,'catalog.json'),'utf8'),committed);assert(await readFile(path.join(out,current.releases[0].artifacts.web.path)));
 await update('1.0.3','com.cyberroom.watch.v104','apk-v104','native-v104');run();const stable=await catalog(),stableFiles=await files(),stablePayload=JSON.stringify(stable);run();assert.equal(JSON.stringify(await catalog()),stablePayload);assert.deepEqual(await files(),stableFiles,'repeated builds never accumulate releases or orphan artifacts');
 const good=catalogText;
 // Tampered signatures and signed path traversal are rejected before cleanup.
 const invalid=JSON.parse(good);invalid.signature=Buffer.alloc(64).toString('base64');await write('server/plugin-market/catalog.json',JSON.stringify(invalid));run(/Previous marketplace signature is invalid/);assert.deepEqual(await files(),stableFiles);await write('server/plugin-market/catalog.json',good);
 const traversing=structuredClone(stable);traversing.releases.find(r=>r.id==='official.watch').artifacts.android.native.path='../../outside.apk';await write('server/plugin-market/catalog.json',envelope(traversing));run(/原生组件发布无效/);await write('server/plugin-market/catalog.json',good);
 // Never follow a junction/symlink out of the output directory while pruning.
 await write('outside/0.0.1/web-'+ '2'.repeat(64)+'.json','keep outside');const link=path.join(out,'linked.plugin');await symlink(path.join(fixture,'outside'),link,'junction');try{run(/Marketplace directory must not be a link/);assert.equal(await readFile(path.join(fixture,'outside/0.0.1/web-'+ '2'.repeat(64)+'.json'),'utf8'),'keep outside');assert.equal(await readFile(path.join(out,'catalog.json'),'utf8'),good);}finally{await unlink(link);}
 // A build failure cannot publish a partial catalog or remove the previous artifacts.
 await write('plugins/chess/app.js','export const broken = ;');run(/Build failed/);assert.equal(await readFile(path.join(out,'catalog.json'),'utf8'),good);assert.deepEqual(await files(),stableFiles);
 console.log('PASS marketplace retention: latest-only records/files, legacy signature migration, sourceHash APK reuse, retired package immutability, repeat-build cleanup, signature/path/link rejection and failed-build preservation');
}finally{
 // The one recursively removed directory was created by this test under server/target.
 const actual=await realpath(fixture),parent=await realpath(target);assert.equal(path.dirname(actual),parent);assert(path.basename(actual).startsWith('package-retention-test-'));await rm(actual,{recursive:true,force:true});
}
