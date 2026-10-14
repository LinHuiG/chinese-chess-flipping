// Android native host + two real browser members; local test server only.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
(async()=>{
  const adb=process.env.ADB,serial=process.env.ANDROID_SERIAL||'emulator-5554';assert.ok(adb,'Set ADB to the SDK adb executable');
  const shell=(...args)=>execFileSync(adb,['-s',serial,'shell',...args],{encoding:'utf8'}).trim();
  const rotation={accelerometer_rotation:shell('settings','get','system','accelerometer_rotation'),user_rotation:shell('settings','get','system','user_rotation')};
  const native=await chromium.connectOverCDP(process.env.ANDROID_CDP||'http://127.0.0.1:19222'),browser=await chromium.launch({headless:true,channel:'msedge'});
  const host=native.contexts()[0].pages()[0],guests=await Promise.all([1,2].map(()=>browser.newPage())),pages=[host,...guests],errors=[],layouts=[];
  const out=path.resolve(__dirname,'../app/build/miner-mobile-checks');fs.mkdirSync(out,{recursive:true});
  const capture=name=>fs.writeFileSync(path.join(out,name+'.png'),execFileSync(adb,['-s',serial,'exec-out','screencap','-p'],{maxBuffer:8*1024*1024}));
  const rotate=async value=>{shell('settings','put','system','accelerometer_rotation','0');shell('settings','put','system','user_rotation',String(value));await host.waitForFunction(landscape=>landscape?innerWidth>innerHeight:innerWidth<innerHeight,!!value);};
  const layout=async name=>{
    await host.waitForTimeout(250);const report=await host.evaluate(()=>({width:innerWidth,height:innerHeight,fullscreen:document.fullscreenElement?.id,overflow:document.documentElement.scrollWidth>innerWidth+1,rects:Object.fromEntries(['mine-canvas','drop','bomb','pause','save','mine-fullscreen'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return[id,{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}];}))}));
    assert.equal(report.overflow,false);for(const [id,r]of Object.entries(report.rects))assert.ok(r.width>0&&r.height>0&&r.x>=-1&&r.y>=-1&&r.right<=report.width+1&&r.bottom<=report.height+1,`${name} ${id}: ${JSON.stringify(r)}`);
    layouts.push({name,...report});capture(name);
  };
  for(const p of pages){p.setDefaultTimeout(20000);p.on('pageerror',e=>errors.push(e.message));}
  try{
    await rotate(0);await host.locator('#lobby').waitFor({state:'visible'});await Promise.all(guests.map(p=>p.goto(process.env.CHESS_WEB_URL||'http://127.0.0.1:18880')));await Promise.all(guests.map(p=>p.locator('#lobby').waitFor({state:'visible'})));
    const name='Android矿工原生验收'+Date.now();await host.click('[data-create=miner]');await host.selectOption('#capacity','3');await host.fill('#room-name',name);await host.click('#create-submit');
    for(const p of guests){await p.click('#refresh');await p.locator('.room-card').filter({hasText:name}).click();await p.locator('#waiting').waitFor({state:'visible'});}
    for(const p of pages)await p.click('#ready');await Promise.all(pages.map(p=>p.locator('#miner').waitFor({state:'visible'})));
    await layout('portrait');await host.waitForFunction(()=>!document.querySelector('#drop').disabled);await host.locator('#mine-canvas').click({position:{x:100,y:200}});await host.waitForFunction(()=>document.querySelector('#drop').disabled);
    await host.click('#save');const save=await host.evaluate(()=>JSON.parse(localStorage.getItem('cyber.miner.save')));assert.notEqual(save.players[0].claw.mode,'swing');assert.ok(save.players.slice(1).every(p=>p.claw.mode==='swing'));
    await host.click('#pause');await host.locator('#mine-canvas').click({position:{x:100,y:200}});assert.equal(await host.textContent('#pause'),'继续冒险');
    await rotate(1);await layout('landscape');await host.click('#mine-fullscreen');await host.waitForFunction(()=>document.fullscreenElement?.id==='miner');await layout('fullscreen-landscape');
    await rotate(0);await host.waitForFunction(()=>document.fullscreenElement?.id==='miner');await layout('fullscreen-portrait');
    shell('input','-d','0','keyevent','KEYCODE_BACK');await host.waitForFunction(()=>!document.fullscreenElement);assert.equal(await host.locator('#miner').isVisible(),true);assert.equal(await host.evaluate(()=>document.querySelector('#confirm-ok').closest('dialog').open),false);
    await host.click('#mine-fullscreen');await host.waitForFunction(()=>document.fullscreenElement?.id==='miner');await host.click('#mine-fullscreen');await host.waitForFunction(()=>!document.fullscreenElement);
    await host.locator('#miner .leave').first().click();await host.click('#confirm-ok');await Promise.all(pages.map(p=>p.locator('#lobby').waitFor({state:'visible'})));assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({layouts,errors,clawMode:save.players[0].claw.mode},null,2));console.log('PASS Android 3-player miner: portrait/landscape layout, canvas releases only own claw, pause guard, fullscreen rotation, Back and page button exit without leaving room');
  }finally{
    await host.evaluate(()=>document.fullscreenElement&&document.exitFullscreen()).catch(()=>{});
    const leave=host.locator('#miner .leave:visible, #waiting .leave:visible').first();if(await leave.isVisible().catch(()=>false)){await leave.click().catch(()=>{});await host.locator('#confirm-ok').click().catch(()=>{});await host.locator('#lobby').waitFor({state:'visible'}).catch(()=>{});}
    for(const [key,value]of Object.entries(rotation))shell('settings',value==='null'?'delete':'put','system',key,...(value==='null'?[]:[value]));
    await browser.close();await native.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
