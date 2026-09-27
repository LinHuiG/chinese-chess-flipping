// Targeted browser presentation and WebSocket envelope regression checks.
// Requires Node and Playwright; no running game server or player connection is used.

const {chromium}=require('playwright'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
(async()=>{
 const {GameSocket}=await import(require('node:url').pathToFileURL(path.resolve(__dirname,'../server/src/main/resources/web/transport.js')));
 global.document={hidden:false};global.location={href:'http://transport.test/',protocol:'http:'};
 global.WebSocket=class{static OPEN=1;constructor(){this.readyState=1;this.bufferedAmount=0;}send(raw){this.last=JSON.parse(raw);}close(){this.readyState=3;}};
 const callbacks={status(){},connected(){},message(){},closed(){}};
 for(const body of ['invalid',3,[],null]){
  const client=new GameSocket(callbacks);client.connect();const socket=client.socket;socket.onopen();
  socket.onmessage({data:JSON.stringify({type:'READY',TID:client.hello,CODE:0,body})});
  assert.equal(client.ready,false);assert.equal(client.socket,null);client.disconnect();
 }
 const client=new GameSocket(callbacks);client.connect();const socket=client.socket;socket.onopen();
 socket.onmessage({data:JSON.stringify({type:'READY',TID:client.hello,CODE:0,body:{}})});
 assert.equal(client.ready,true);socket.bufferedAmount=262145;
 assert.equal(client.request({type:'LIST'}),false,'Failed send must not report request accepted');client.disconnect();
 console.log(JSON.stringify({result:'PASS',checks:['invalid envelope body rejected','valid handshake','failed send reported']}));

 const root=path.resolve(__dirname,'..'),web=path.join(root,'server/src/main/resources/web');
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try {
  const page=await browser.newPage({viewport:{width:1100,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://motion.test/**',async route=>{
   const name=new URL(route.request().url()).pathname.slice(1)||'index.html';
   const body=name==='transport.js' ? `export class GameSocket {
    constructor(callbacks){this.callbacks=callbacks;window.fixture=body=>callbacks.message(body);}
    connect(){this.ready=true;this.callbacks.connected();} request(){return true;} resume(){} disconnect(){}
   }` : fs.readFileSync(path.join(web,name));
   await route.fulfill({body,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':name.endsWith('.svg')?'image/svg+xml':'application/octet-stream'});
  });
  await page.goto('http://motion.test/');await page.waitForFunction(()=>!!window.fixture);
  const result=await page.evaluate(async()=>{
   const cells=[...document.querySelectorAll('.cell')],board=Array(32).fill(0);
   board[0]=4;board[8]=-7;board[12]=99;board[31]=-1;
   const room={roomId:1,version:1,gameId:'motion',hostId:'host',members:['host','me'],name:'动画检查',playing:true};
   const state={seq:1,move:0,board,captured:[],colors:[-1,1],turn:1,remaining:-1,seconds:0,ready:{},winner:-1,lastFrom:-1,lastTo:-1};
   const emit=()=>fixture({type:'STATE',...room,state:structuredClone(state)});
   const animations=()=>document.querySelector('#board').getAnimations({subtree:true});
   fixture({type:'SESSION',selfId:'me'});fixture({type:'ROOM',...room});emit();
   const initial=animations().length,originalTop=cells[0].firstElementChild.getBoundingClientRect().top;
   state.board[0]=0;state.board[4]=4;state.seq++;state.move++;state.lastFrom=0;state.lastTo=4;emit();
   let moving=animations()[0];moving.pause();moving.currentTime=0;
   const start=cells[4].firstElementChild.getBoundingClientRect().top;
   moving.currentTime=110;const mid=cells[4].firstElementChild.getBoundingClientRect().top;
   moving.currentTime=220;const end=cells[4].firstElementChild.getBoundingClientRect().top;
   moving.finish();await Promise.resolve();await Promise.resolve();
   const complete=animations().length;state.seq++;emit();const repeated=animations().length;
   state.board[4]=0;state.board[8]=4;state.seq++;state.move++;state.lastFrom=4;state.lastTo=8;state.captured=[-7];emit();
   for(const a of animations()){a.pause();a.currentTime=140;}
   const capture={animations:animations().length,ghost:document.querySelector('.capture-ghost')?.textContent};
   window.motionState=state;window.motionRoom=room;
   return {initial,originalTop,start,mid,end,complete,repeated,capture};
  });
  assert.equal(result.initial,0);assert(Math.abs(result.start-result.originalTop)<1);assert(result.start<result.mid&&result.mid<result.end);
  assert.equal(result.complete,0);assert.equal(result.repeated,0);assert.equal(result.capture.animations,2);assert.equal(result.capture.ghost,'卒');
  fs.mkdirSync(path.join(root,'server/target/web-checks'),{recursive:true});
  await page.screenshot({path:path.join(root,'server/target/web-checks/move-animation.png')});
  await page.evaluate(()=>{document.querySelector('#motion').checked=false;document.querySelector('#motion').dispatchEvent(new Event('change'));});
  assert.equal(await page.locator('.capture-ghost').count(),0);assert.equal(await page.evaluate(()=>document.querySelector('#board').getAnimations({subtree:true}).length),0);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>{
   document.querySelector('#motion').checked=true;document.querySelector('#motion').dispatchEvent(new Event('change'));
   const s=window.motionState;s.board[8]=0;s.board[9]=4;s.move++;s.seq++;s.lastFrom=8;s.lastTo=9;
   fixture({type:'STATE',...window.motionRoom,state:structuredClone(s)});
  });
  assert.equal(await page.evaluate(()=>document.querySelector('#board').getAnimations({subtree:true}).length),0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',geometry:result,checks:['source-to-target movement','midpoint','capture fade','duplicate snapshot','motion toggle','reduced motion','cleanup']}));

  const redundantWrites=await page.evaluate(async()=>{
   let count=0;const observer=new MutationObserver(records=>count+=records.length);
   observer.observe(document.querySelector('#board'),{subtree:true,childList:true,attributes:true});
   fixture({type:'RESULT',request:'HOST_REPLY',ok:true});await Promise.resolve();observer.disconnect();return count;
  });
  assert.equal(redundantWrites,0,'Unchanged acknowledgements must not rewrite the board');
  await page.emulateMedia({reducedMotion:'no-preference'});
  const finalMove=await page.evaluate(()=>{
   const room={...window.motionRoom,version:2,gameId:'final'};
   const board=Array(32).fill(0);board[0]=4;board[8]=-7;
   const state={...window.motionState,seq:1,move:0,board,captured:[],winner:-1,lastFrom:-1,lastTo:-1};
   fixture({type:'ROOM',...room});fixture({type:'STATE',...room,state:structuredClone(state)});
   state.board[0]=0;state.board[8]=4;state.captured=[-7];state.winner=1;state.lastFrom=0;state.lastTo=8;state.move=1;state.seq=2;
   fixture({type:'STATE',...room,state:structuredClone(state)});
   fixture({type:'GAME_OVER',...room,winnerId:'me',reason:'NO_PIECES'});
   const waiting={...room,version:3,gameId:'',playing:false};
   fixture({type:'ROOM',...waiting});
   fixture({type:'STATE',...waiting,state:{seq:1,seconds:0,ready:{}}});
   return {gameVisible:!document.querySelector('#game').hidden,animations:document.querySelector('#board').getAnimations({subtree:true}).length};
  });
  assert.equal(finalMove.gameVisible,true,'Winning capture must stay visible during transition to waiting');
  assert.equal(finalMove.animations,2,'Waiting snapshot must not cancel the winning capture');
  await page.locator('#outcome-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#waiting').isVisible(),true);
  assert.equal(await page.locator('.capture-ghost').count(),0);
  assert.equal(await page.evaluate(()=>document.querySelector('#board').getAnimations({subtree:true}).length),0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',checks:['no board writes for unchanged acknowledgement','winning capture survives ROOM and waiting STATE','settlement releases final board']}));

 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
