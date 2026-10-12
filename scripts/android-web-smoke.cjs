// Requires two debug emulators with WebView CDP forwarded to 19222/19223, and the local server.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
(async()=>{
  const out=path.resolve(__dirname,'../server/target/web-checks');fs.mkdirSync(out,{recursive:true});
  const hostBrowser=await chromium.connectOverCDP('http://127.0.0.1:19222'),guestBrowser=await chromium.connectOverCDP('http://127.0.0.1:19223');
  const host=hostBrowser.contexts()[0].pages()[0],guest=guestBrowser.contexts()[0].pages()[0];
  let browser;try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'msedge'});}
  const web=await browser.newPage({viewport:{width:1100,height:950}}),errors=[];
  for(const p of [host,guest,web]){p.setDefaultTimeout(20000);p.on('pageerror',e=>errors.push(e.message));}
  try{
    await host.evaluate(async()=>{await window.cyberDisconnect();location.reload();});
    await guest.evaluate(()=>{window.cyberDisconnect().then(()=>{NativeRoom.configure(JSON.stringify({...JSON.parse(NativeRoom.settings()),host:'10.0.2.2',port:18880,transport:'HTTP'}));location.reload();});});
    await web.goto('http://127.0.0.1:18880');for(const p of [host,guest,web])await p.locator('#lobby').waitFor({state:'visible'});
    await host.click('[data-create=miner]');await host.selectOption('#capacity','3');await host.fill('#room-name','App TCP + App WS + Web');await host.click('#create-submit');await host.locator('#waiting').waitFor({state:'visible'});
    for(const p of [guest,web]){await p.click('#refresh');await p.locator('.room-card').filter({hasText:'App TCP + App WS + Web'}).click();await p.locator('#waiting').waitFor({state:'visible'});}
    for(const p of [host,guest,web])await p.click('#ready');
    for(const p of [host,guest,web])await p.locator('#miner').waitFor({state:'visible'});
    await guest.click('#drop');await web.click('#drop');await host.click('#drop');await host.click('#save');
    assert.equal(await host.evaluate(()=>JSON.parse(localStorage.getItem('cyber.miner.save')).players.length),3);
    await host.screenshot({path:path.join(out,'android-miner.png'),fullPage:true});
    assert.equal(await host.evaluate(()=>document.querySelector('canvas').getContext('2d').getImageData(10,10,1,1).data[3]),255);
    if(process.env.ADB)fs.writeFileSync(path.join(out,'android-device.png'),require('node:child_process').execFileSync(process.env.ADB,['-s','emulator-5554','exec-out','screencap','-p']));
    await guest.screenshot({path:path.join(out,'android-guest.png'),fullPage:true});
    // These emulators have isolated NATs; no usable direct route is expected. The game must still work.
    assert.ok((await web.textContent('#status')).includes('服务器转发'));
    await host.locator('#miner .leave').first().click();await host.click('#confirm-ok');
    for(const p of [host,guest,web])await p.locator('#lobby').waitFor({state:'visible'});
    assert.deepEqual(errors,[]);console.log('PASS Android 37: native TCP host + native WS guest + browser, three claws, save, relay fallback and host dissolution');
  }finally{await browser.close();await hostBrowser.close();await guestBrowser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
