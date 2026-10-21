import './plugin-test-host.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mediaRequest,sourceFailure} from '../plugins/watch/watch.js';
import {PluginRoom} from '../plugin_sdk/room.js';
const server=http.createServer((req,res)=>{if(req.url.includes('PlaybackInfo'))return;res.writeHead(503).end('{}');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
try{
 await assert.rejects(mediaRequest(base+'/Items/fixture/PlaybackInfo','GET',{},undefined,150),e=>e.code==='SOURCE_TIMEOUT'&&/Emby 播放协商.*超时/.test(e.message));
 await assert.rejects(mediaRequest(base+'/Users/fixture/Items'),/Emby 片库请求.*503/);
 assert.equal(sourceFailure(Error('network error at https://fixture.invalid/path?api_key=secret'),'https://fixture.invalid/Items/id/PlaybackInfo',60000).message.includes('secret'),false);
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
await assert.rejects(mediaRequest(base+'/Users/fixture/Items','GET',{},undefined,500),e=>e.code==='SOURCE_NETWORK'&&/Emby 片库请求.*无法连接/.test(e.message));
const now=performance.now(),room=Object.assign(Object.create(PluginRoom.prototype),{self:'self',room:{members:[{id:'peer'}]},client:{ready:true,peerQuality:new Map(),peerLatency:new Map(),peerReady:new Set()},relayLatency:new Map(),relayProbes:new Map([['peer',{at:now-1000,since:now-11000}]])});
assert.equal(room.memberConnection('peer').kind,'unresponsive');room.relayLatency.set('peer',{at:now,ms:42});assert.equal(room.memberConnection('peer').kind,'relay');assert.match(room.memberConnection('peer').text,/中转可用/);room.client.ready=false;assert.equal(room.memberConnection('peer').kind,'offline');
// Exercise real browser-client phase/timeout handling without waiting 15 seconds.
const saved={WebSocket:globalThis.WebSocket,location:globalThis.location,now:Date.now};let time=1000;
globalThis.location={href:'http://fixture.invalid/',host:'fixture.invalid'};Date.now=()=>time;
class Socket{constructor(){this.readyState=0;}send(){}close(){this.readyState=3;}}
globalThis.WebSocket=Socket;
try{const {RoomClient}=await import('../server/src/main/resources/web/transport.js'),messages=[],client=new RoomClient({closed:s=>messages.push(s)});
 client.connect();client.socket.onopen();time+=16000;client.tick();assert.match(messages.at(-1),/服务器身份确认超时.*15 秒.*自动重连/);client.disconnect();
 client.connect();client.socket.onerror();assert.match(messages.at(-1),/服务器 WebSocket.*证书/);client.disconnect();
}finally{globalThis.WebSocket=saved.WebSocket;globalThis.location=saved.location;Date.now=saved.now;}
console.log('PASS actual Emby timeout/503/refused connection; source redaction; server vs member timeout vs available relay; WebSocket identity timeout and automatic reconnect');
