// No media, no credentials: PC must retain HTML danmaku without starting mpv.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
  const desktop=await chromium.connectOverCDP(process.env.PC_CDP||'http://127.0.0.1:19224');
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const pc=desktop.contexts()[0].pages()[0],web=await browser.newPage(),name='PC空房弹幕 '+Date.now();
  try{
    await web.goto(process.env.CHESS_WEB_URL||'http://127.0.0.1:18880');
    for(const p of [pc,web]){p.setDefaultTimeout(20000);await p.locator('#lobby').waitFor();}
    await pc.evaluate(()=>{
      window.__emptyPlayerEvents=[];window.__emptyBounds=[];
      window.addEventListener('native-room',e=>{if(e.detail.type==='player')window.__emptyPlayerEvents.push(e.detail);});
      window.__emptyOriginalPlayer=NativeRoom.playerCommand;
      NativeRoom.playerCommand=command=>{const c=JSON.parse(command);if(c.bounds)window.__emptyBounds.push({visible:c.visible,url:!!c.url});return window.__emptyOriginalPlayer(command);};
    });
    await pc.click('[data-create=watch]');await pc.fill('#room-name',name);await pc.click('#create-submit');await pc.locator('#watch').waitFor();
    await web.click('#refresh');await web.locator('.room-card').filter({hasText:name}).click();await web.locator('#watch').waitFor();
    for(let i=0;i<(process.env.WAIT_FOR_VISUAL==='1'?4:1);i++){
      await web.fill('#danmaku-text','未选片也能看到弹幕 '+i);await web.locator('#danmaku-form button').click();await pc.locator('#danmaku').getByText('未选片也能看到弹幕 '+i,{exact:false}).waitFor();
      if(process.env.WAIT_FOR_VISUAL==='1'){console.log('Empty-room danmaku ready for bounded capture');await pc.waitForTimeout(4000);}
    }
    await pc.fill('#danmaku-text','PC 回复');await pc.locator('#danmaku-form button').click();await web.locator('#danmaku').getByText('PC 回复',{exact:false}).waitFor();
    const evidence=await pc.evaluate(()=>({bounds:window.__emptyBounds,players:window.__emptyPlayerEvents}));
    assert.ok(evidence.bounds.length);assert.ok(evidence.bounds.every(c=>c.visible===false&&!c.url));assert.deepEqual(evidence.players,[]);
    await pc.locator('#watch .leave').click();await pc.click('#confirm-ok');for(const p of [pc,web])await p.locator('#lobby').waitFor();
    console.log('PASS PC/Web no-source danmaku both directions; native container hidden; no mpv start or player events; host dissolution');
  }finally{
    await pc.evaluate(()=>{if(window.__emptyOriginalPlayer)NativeRoom.playerCommand=window.__emptyOriginalPlayer;}).catch(()=>{});
    await web.evaluate(()=>window.cyberDisconnect?.()).catch(()=>{});await browser.close();await desktop.close();
  }
})().catch(e=>{console.error(e.message.split('\n')[0]);process.exitCode=1;});
