import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {downloadPackage} from '../server/src/main/resources/web/plugin-download.js';
const bytes=Buffer.from(JSON.stringify({data:'电影插件'.repeat(120000)})),artifact={size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
const values=new Map(),store={get:async(_,key)=>values.get(key),put:async(_,key,value)=>values.set(key,value)},key='partial:'+artifact.sha256;
let mode='interrupt',ranges=[];
const server=http.createServer((req,res)=>{
 const start=Number(/^bytes=(\d+)-$/.exec(req.headers.range||'')?.[1]||0);ranges.push(start);
 if(mode==='bad-range'){res.writeHead(206,{'Content-Range':`bytes 0-${bytes.length-1}/${bytes.length}`});res.end(bytes);return;}
 const from=mode==='ignore-range'?0:start;
 res.writeHead(from?206:200,{'Content-Length':bytes.length-from,...(from?{'Content-Range':`bytes ${from}-${bytes.length-1}/${bytes.length}`}:{})});
 if(mode==='interrupt'){res.write(bytes.subarray(0,600000));setTimeout(()=>res.destroy(),70);}else res.end(bytes.subarray(from));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port+'/artifact.json';
try{
 const progress=[];await assert.rejects(downloadPackage(url,artifact,store,n=>progress.push(n)));const saved=values.get(key);assert(saved.size>0&&saved.size<bytes.length,'Retain complete received bytes on connection loss');
 mode='resume';const raw=await downloadPackage(url,artifact,store);assert.equal(ranges.at(-1),saved.size);assert.equal(raw,bytes.toString());assert(progress.at(-1)>0);
 values.set(key,new Blob([bytes.subarray(0,333333)]));mode='ignore-range';assert.equal(await downloadPackage(url,artifact,store),bytes.toString(),'A 200 response restarts rather than appending duplicates');
 values.set(key,new Blob([bytes.subarray(0,12345)]));mode='bad-range';await assert.rejects(downloadPackage(url,artifact,store),/续传范围/);assert.equal(values.get(key),null);
 console.log('PASS plugin HTTP download: interrupted prefix persists, exact Range resume, progress bytes, 200 fallback, invalid Content-Range rejection');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
