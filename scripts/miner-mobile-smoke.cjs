// Real room flow, phone layouts, canvas input and a repeatable renderer CPU benchmark.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
  const browser=await chromium.launch({headless:true,channel:'msedge'}),url=process.env.CHESS_WEB_URL||'http://127.0.0.1:18880';
  const host=await browser.newPage({viewport:{width:390,height:844},hasTouch:true}),guests=await Promise.all([1,2].map(()=>browser.newPage()));
  const run=String(Date.now()),pages=[host,...guests],errors=[],out=path.resolve(__dirname,'../server/target/miner-mobile-checks');fs.mkdirSync(out,{recursive:true});
  for(const p of pages){p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));}
  // Development servers snapshot assets at startup; opt in to local resources without restarting one.
  if(process.env.MINER_LIVE_ASSETS==='1')for(const p of pages)for(const file of ['style.css','app.js','miner.js','room.js'])await p.route('**/'+file,route=>route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(path.resolve(__dirname,'../server/src/main/resources/web/'+file),'utf8')}));
  const leave=async()=>{await host.locator('#miner .leave').first().click();await host.click('#confirm-ok');await Promise.all(pages.map(p=>p.locator('#lobby').waitFor({state:'visible'})));};
  try{
    await Promise.all(pages.map(p=>p.goto(url)));await Promise.all(pages.map(p=>p.locator('#lobby').waitFor({state:'visible'})));
    await host.click('[data-create=miner]');await host.selectOption('#capacity','3');await host.fill('#room-name','长屏与触控验收'+run);await host.click('#create-submit');
    for(const p of guests){await p.click('#refresh');await p.locator('.room-card').filter({hasText:'长屏与触控验收'+run}).click();await p.locator('#waiting').waitFor({state:'visible'});}
    for(const p of pages)await p.click('#ready');await Promise.all(pages.map(p=>p.locator('#miner').waitFor({state:'visible'})));
    const layouts=[];
    for(const [width,height] of [[1440,900],[1024,768],[320,568],[360,800],[390,844],[412,915],[568,320],[844,390],[915,412]]){
      await host.setViewportSize({width,height});await host.waitForTimeout(150);
      const report=await host.evaluate(()=>({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,rects:Object.fromEntries(['miner','mine-canvas','drop','bomb','pause','save','mine-fullscreen'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return[id,{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}];}))}));
      assert.equal(report.overflow,false);assert.equal(await host.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),true);for(const [id,r] of Object.entries(report.rects)){assert.ok(r.width>0&&r.height>0&&r.x>=-1&&r.y>=-1&&r.right<=width+1&&r.bottom<=height+1,`${width}x${height} ${id}: ${JSON.stringify(r)}`);}
      if(height>width)assert.ok(report.rects['mine-canvas'].height>height*.52,'Portrait field fills the available long screen');
      layouts.push(report);await host.screenshot({path:path.join(out,`mine-${width}x${height}.png`)});
    }
    await host.setViewportSize({width:390,height:844});await host.waitForFunction(()=>!document.querySelector('#drop').disabled);
    await host.locator('#mine-canvas').tap({position:{x:100,y:200}});await host.waitForFunction(()=>document.querySelector('#drop').disabled);
    await host.click('#save');const save=await host.evaluate(()=>JSON.parse(localStorage.getItem('cyber.miner.save')));
    assert.notEqual(save.players[0].claw.mode,'swing','Canvas tap releases only the local claw');assert.ok(save.players.slice(1).every(p=>p.claw.mode==='swing'));
    await host.click('#pause');const pausedCanvas=await host.locator('#mine-canvas').boundingBox();await host.touchscreen.tap(pausedCanvas.x+100,pausedCanvas.y+200);assert.equal(await host.textContent('#pause'),'继续冒险');
    await host.click('#mine-fullscreen');await host.waitForFunction(()=>document.fullscreenElement?.id==='miner');
    await host.setViewportSize({width:844,height:390});await host.waitForTimeout(150);assert.equal(await host.evaluate(()=>document.fullscreenElement?.id),'miner');
    await host.click('#mine-fullscreen');await host.waitForFunction(()=>!document.fullscreenElement);assert.equal(await host.locator('#miner').isVisible(),true);
    await leave();
    // Use the public save/resume entry to reach the shop without waiting a full round.
    await host.evaluate(()=>{const s=JSON.parse(localStorage.getItem('cyber.miner.save'));s.time=.3;for(const p of s.players)p.cash=2000;localStorage.setItem('cyber.miner.save',JSON.stringify(s));});
    await host.click('#continue-mine');await host.fill('#room-name','补给布局验收'+run);await host.click('#create-submit');
    for(const p of guests){await p.click('#refresh');await p.locator('.room-card').filter({hasText:'补给布局验收'+run}).click();await p.locator('#waiting').waitFor({state:'visible'});}
    for(const p of pages)await p.click('#ready');await host.locator('#shop').waitFor({state:'visible'});
    await host.click('#pause');const pausedShopTime=await host.textContent('#mine-clock');await host.waitForTimeout(1100);assert.equal(await host.textContent('#mine-clock'),pausedShopTime,'Shop timer pauses with the game');
    await guests[1].reload();await guests[1].locator('#shop').waitFor({state:'visible'});assert.equal(await guests[1].textContent('#mine-clock'),pausedShopTime,'Rejoining guest receives the same paused supply remainder');
    for(const [width,height] of [[1440,900],[1024,768],[320,568],[360,800],[390,844],[412,915],[568,320],[844,390],[915,412]]){
      await host.setViewportSize({width,height});await host.waitForTimeout(100);
      const report=await host.evaluate(()=>({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollHeight>innerHeight+1||document.documentElement.scrollWidth>innerWidth+1,items:[...document.querySelectorAll('#shop,#shop-items,#shop .shop-item,#shop-ready,#next-level,#pause,#save')].map(e=>{const r=e.getBoundingClientRect();return {id:e.id||e.dataset.item,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,overflow:e.scrollHeight>e.clientHeight+1||e.scrollWidth>e.clientWidth+1,reachable:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})}));
      assert.equal(report.scroll,false,JSON.stringify(report));for(const item of report.items){assert.ok(item.width>0&&item.height>0&&item.x>=0&&item.y>=0&&item.right<=width+1&&item.bottom<=height+1&&!item.overflow&&item.reachable,`${width}x${height} ${JSON.stringify(item)}`);}
      layouts.push(report);await host.screenshot({path:path.join(out,`shop-${width}x${height}.png`)});
    }
    await host.click('#pause');
    for(const [width,height,item] of [[320,568,'strength'],[844,390,'reel']]){await host.setViewportSize({width,height});await host.locator(`[data-item=${item}]`).click();await host.screenshot({path:path.join(out,`shop-${width}x${height}.png`)});}
    for(const p of pages)await p.click('#shop-ready');await host.click('#next-level');await host.waitForFunction(()=>document.querySelector('#mine-level').textContent.includes('第 2 /'));
    await leave();
    // Restore another nearly-finished round, then let the full twenty-second supply window expire.
    await host.evaluate(()=>{const s=JSON.parse(localStorage.getItem('cyber.miner.save'));s.time=.2;localStorage.setItem('cyber.miner.save',JSON.stringify(s));});
    await host.click('#continue-mine');await host.fill('#room-name','自动补给验收'+run);await host.click('#create-submit');
    for(const p of guests){await p.click('#refresh');await p.locator('.room-card').filter({hasText:'自动补给验收'+run}).click();await p.locator('#waiting').waitFor({state:'visible'});}
    for(const p of pages)await p.click('#ready');await host.locator('#shop').waitFor({state:'visible'});const shopStarted=Date.now();
    await host.locator('#shop').waitFor({state:'hidden',timeout:23000});const supplyDuration=Date.now()-shopStarted;assert.ok(supplyDuration>=19000&&supplyDuration<22000,'Actual supply duration '+supplyDuration);
    for(const p of pages)await p.waitForFunction(()=>document.querySelector('#mine-level').textContent.includes('第 3 /'));
    await host.click('#mine-fullscreen');await host.waitForFunction(()=>document.fullscreenElement?.id==='miner');await leave();assert.equal(await host.evaluate(()=>document.fullscreenElement),null);
    // Shared fullscreen also covers chess, keeps all 32 squares visible, and restores focus on exit.
    await host.click('[data-create=chess]');await host.fill('#room-name','棋盘全屏验收'+run);await host.click('#create-submit');
    await guests[0].click('#refresh');await guests[0].locator('.room-card').filter({hasText:'棋盘全屏验收'+run}).click();await guests[0].locator('#waiting').waitFor({state:'visible'});
    await host.click('#ready');await guests[0].click('#ready');await host.locator('#chess').waitFor({state:'visible'});
    await host.click('#chess-fullscreen');await host.waitForFunction(()=>document.fullscreenElement?.id==='chess');
    for(const [width,height] of [[1440,900],[320,568],[390,844],[568,320],[844,390]]){
      await host.setViewportSize({width,height});await host.waitForTimeout(100);
      const squares=await host.locator('#board .piece').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};}));assert.equal(squares.length,32);
      for(const square of squares)assert.ok(square.width>10&&square.height>10&&square.x>=0&&square.y>=0&&square.right<=width+1&&square.bottom<=height+1,JSON.stringify({width,height,square}));
      for(const selector of ['#chess-fullscreen','#chess .leave','#clock','#chess-members']){const r=await host.locator(selector).boundingBox();assert.ok(r&&r.x>=0&&r.y>=0&&r.x+r.width<=width+1&&r.y+r.height<=height+1,selector+' '+JSON.stringify(r));}
      await host.screenshot({path:path.join(out,`chess-full-${width}x${height}.png`)});
    }
    await host.click('#chess-fullscreen');await host.waitForFunction(()=>!document.fullscreenElement);assert.equal(await host.evaluate(()=>document.activeElement.id),'chess-fullscreen');
    await host.click('#chess-fullscreen');await host.waitForFunction(()=>document.fullscreenElement?.id==='chess');await host.keyboard.press('Escape');await host.waitForFunction(()=>!document.fullscreenElement);assert.equal(await host.evaluate(()=>document.activeElement.id),'chess-fullscreen');
    await host.click('#chess-fullscreen');await host.waitForFunction(()=>document.fullscreenElement?.id==='chess');await host.locator('#chess .leave').click();await host.click('#confirm-ok');await host.locator('#lobby').waitFor({state:'visible'});assert.equal(await host.evaluate(()=>document.fullscreenElement),null);
    assert.deepEqual(errors,[]);
    const before=process.env.MINER_BASELINE?fs.readFileSync(process.env.MINER_BASELINE,'utf8'):null;
    if(before)await host.route('**/miner-baseline.js',route=>route.fulfill({contentType:'text/javascript',body:before}));
    const benchmark=await host.evaluate(async before=>{
      const {MinerView}=await import('./miner-view.js'),{GoldMine,THEMES,rng}=await import('./miner.js');
      const canvas=document.createElement('canvas');canvas.style.cssText='position:fixed;left:0;top:0;width:390px;height:600px';document.body.append(canvas);
      const state=new GoldMine(42,[{id:'a'},{id:'b'},{id:'c'}],999).snapshot(),results={};
      const types=[['current',MinerView]];
      if(before)types.unshift(['before',(await import('./miner-baseline.js')).MinerView]);
      for(const [name,Type] of types){const view=new Type(canvas,{play(){}});view.prepare?.();if(view.ready&&!await view.ready)throw Error('Miner artwork failed to load');view.setState(state,'a');view.sizeDirty=true;
        for(let i=0;i<20;i++){view.draw(performance.now());cancelAnimationFrame(view.raf);view.raf=0;}
        const start=performance.now();for(let i=0;i<240;i++){view.draw(start+i*16.67);cancelAnimationFrame(view.raf);view.raf=0;}
        results[name]={meanDrawMs:(performance.now()-start)/240,items:state.items.length};view.setState(null);view.resize?.disconnect();}
      canvas.remove();return results;
    },before);
    if(benchmark.before)assert.ok(benchmark.current.meanDrawMs<benchmark.before.meanDrawMs,'Cached renderer should reduce CPU work on the same scene');
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({layouts,benchmark,supplyDuration},null,2));console.log('PASS 3-player PC/phone single-screen field and 9-item shop, canvas tap, pause, 20-second expiry, early next, miner/chess fullscreen and leave cleanup',JSON.stringify({benchmark,supplyDuration}));
  }finally{for(const p of pages)await p.evaluate(()=>window.cyberDisconnect?.()).catch(()=>{});await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
