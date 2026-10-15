const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
 let desktop,browser,pc,guest;
 try{
  desktop=await chromium.connectOverCDP(process.env.PC_CDP||'http://127.0.0.1:19224');pc=desktop.contexts()[0].pages().find(p=>p.url().includes('tauri.localhost'));
  browser=await chromium.launch({channel:'msedge',headless:true});guest=await browser.newPage();await guest.goto(process.env.CHESS_WEB_URL||'http://127.0.0.1:18880');
  if(await pc.locator('#connect').isVisible())await pc.click('#connect');
  for(const game of ['miner','chess']){
   const name='PC全屏验收 '+game+Date.now();await pc.click('[data-create='+game+']');await pc.fill('#room-name',name);await pc.click('#create-submit');await guest.click('#refresh');await guest.locator('.room-card').filter({hasText:name}).click();await pc.click('#ready');await guest.click('#ready');await pc.locator('#'+game).waitFor();
   const button=game==='miner'?'#mine-fullscreen':'#chess-fullscreen';await pc.click(button);
   await pc.waitForFunction(async game=>{const s=await window.__TAURI_INTERNALS__.invoke('native_call',{method:'windowState',args:[]});return document.fullscreenElement?.id===game&&s.fullscreen&&s.size.width===s.monitor.size.width&&s.size.height===s.monitor.size.height;},game);
   assert.ok(await pc.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1&&document.documentElement.scrollWidth<=innerWidth+1));
   if(game==='miner'&&process.env.WAIT_FOR_VISUAL==='1'){console.log('PC miner true fullscreen ready for visual/physical Escape');await pc.waitForTimeout(20000);}
   if(await pc.evaluate(()=>!!document.fullscreenElement))await pc.keyboard.press('Escape');
   await pc.waitForFunction(async()=>!document.fullscreenElement&&!(await window.__TAURI_INTERNALS__.invoke('native_call',{method:'windowState',args:[]})).fullscreen);
   assert.equal(await pc.evaluate(()=>document.activeElement.id),button.slice(1));
   await pc.click(button);await pc.locator('#'+game+' .leave').first().click();await pc.click('#confirm-ok');await pc.locator('#lobby').waitFor();await guest.locator('#lobby').waitFor();
   await pc.waitForFunction(async()=>!(await window.__TAURI_INTERNALS__.invoke('native_call',{method:'windowState',args:[]})).fullscreen);
  }
  console.log('PASS PC miner/chess real monitor fullscreen, no document scroll, Escape focus restoration and leave cleanup');
 }finally{if(pc)await pc.evaluate(()=>window.cyberDisconnect?.()).catch(()=>{});if(browser)await browser.close();if(desktop)await desktop.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
