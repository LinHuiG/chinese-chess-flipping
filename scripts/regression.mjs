// Run the complete deterministic client suite and preserve each check's output.
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const checks=['plugin-modal-test.mjs','hls-timeline-test.mjs','plugin-test.mjs','plugin-download-test.mjs','player-wake-test.mjs','client-test.mjs','watch-voice-test.mjs','subtitles-test.mjs','watch-subtitle-lifecycle-test.mjs','watch-subtitle-transition-test.mjs','watch-player-test.mjs','watch-native-player-test.mjs','watch-seek-test.mjs','watch-load-race-test.mjs','watch-save-test.mjs','voice-capture-test.mjs','watch-reliability-test.mjs','network-diagnostics-test.mjs'].map(name=>'scripts/'+name);
checks.push('desktop_client/scripts/fullscreen-bridge-test.cjs','desktop_client/scripts/watch-save-bridge-test.cjs');
if(process.argv.includes('--ui'))checks.push('scripts/watch-episode-ui-test.cjs','scripts/ui-player-smoke.cjs','plugins/chess/ui-smoke.cjs','scripts/miner-render-smoke.cjs');
const out=path.resolve('server/target/regression-0.9.3');mkdirSync(out,{recursive:true});const results=[];
for(const file of checks){const start=Date.now(),r=spawnSync(process.execPath,[file],{encoding:'utf8',windowsHide:true,timeout:180000});const ok=r.status===0;results.push({file,ok,seconds:(Date.now()-start)/1000});writeFileSync(path.join(out,path.basename(file)+'.log'),(r.stdout||'')+(r.stderr||'')+(r.error?.message||''));console.log((ok?'PASS ':'FAIL ')+file);if(!ok)console.error((r.stderr||r.stdout||r.error?.message||'').slice(-1800));}
writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2)+'\n');if(results.some(r=>!r.ok))process.exitCode=1;
