// Local UI preview against the existing room service; no second room server.
// Usage: node scripts/preview-web.cjs [web-root] [port]
const http=require('node:http'),https=require('node:https'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.argv[2]||'server/src/main/resources/web'),port=Number(process.argv[3]||10805);
const upstreamHost='fqgame.tdcode.tech',sockets=new Set();
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.txt':'text/plain; charset=utf-8','.woff2':'font/woff2','.json':'application/json'};
const server=http.createServer((req,res)=>{
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405).end();return;}
  let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
  if(pathname==='/api/desktop/version'){
    const proxy=https.get({hostname:upstreamHost,path:pathname,timeout:10000},response=>{res.writeHead(response.statusCode,{'Content-Type':'application/json','Cache-Control':'no-store'});response.pipe(res);});
    proxy.on('timeout',()=>proxy.destroy());proxy.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});return;
  }
  const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.stat(file,(error,stat)=>{
    if(error||!stat.isFile()){res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    if(req.method==='HEAD'){res.end();return;}const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  });
});
server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
server.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/ws'||!['http://127.0.0.1:'+port,'http://localhost:'+port].includes(req.headers.origin)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  // Validate the browser origin above, then translate it for this fixed-target
  // reverse proxy. The upstream independently enforces its own same-origin rule.
  const headers={Host:upstreamHost,Connection:'Upgrade',Upgrade:'websocket',Origin:'https://'+upstreamHost,'Sec-WebSocket-Key':req.headers['sec-websocket-key'],'Sec-WebSocket-Version':req.headers['sec-websocket-version']};
  const proxy=https.request({hostname:upstreamHost,path:'/ws',headers,timeout:10000});
  proxy.on('upgrade',(response,remote,remoteHead)=>{
    proxy.setTimeout(0);socket.setTimeout(0);remote.setTimeout(0);
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).map(([key,value])=>key+': '+value).join('\r\n')+'\r\n\r\n');
    if(head.length)remote.write(head);if(remoteHead.length)socket.write(remoteHead);
    socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());socket.on('close',()=>remote.destroy());remote.on('close',()=>socket.destroy());socket.pipe(remote).pipe(socket);
  });
  proxy.on('response',()=>socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
  proxy.on('timeout',()=>proxy.destroy());proxy.on('error',()=>socket.destroy());socket.on('close',()=>proxy.destroy());proxy.end();
});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({preview:'http://127.0.0.1:'+port,roomService:'wss://'+upstreamHost+'/ws',root})));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{for(const socket of sockets)socket.destroy();server.close(()=>process.exit());});
