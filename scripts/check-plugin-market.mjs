// Verify the exact bytes that will enter the image; no private signing key is needed.
import {readFile} from 'node:fs/promises';
import {createPublicKey,verify,createHash} from 'node:crypto';
import {validateRelease} from '../server/src/main/resources/web/plugin-package.js';
const root=new URL('../server/plugin-market/',import.meta.url),read=name=>readFile(new URL(name,root));
const trust=JSON.parse(await readFile(new URL('../server/src/main/resources/web/plugin-trust.json',import.meta.url))),envelope=JSON.parse(await read('catalog.json'));
if(!trust.keys.some(jwk=>verify('sha256',Buffer.from(envelope.payload),{key:createPublicKey({key:jwk,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(envelope.signature,'base64'))))throw Error('Marketplace signature invalid');
const records=JSON.parse(envelope.payload).releases;let files=0;
for(const record of records){validateRelease(record);for(const artifact of Object.values(record.artifacts)){for(const file of [artifact,artifact.native].filter(Boolean)){const bytes=await read(file.path);if(bytes.length!==file.size||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Marketplace artifact corrupted: '+file.path);files++;}const payload=JSON.parse(await read(artifact.path));if(JSON.stringify(payload.manifest)!==JSON.stringify(record.manifest))throw Error('Manifest mismatch');}}
console.log(`PASS marketplace signature and ${files} package/native artifacts across ${records.length} immutable releases`);
