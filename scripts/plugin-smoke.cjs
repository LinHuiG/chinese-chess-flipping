const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const url=process.env.CHESS_WEB_URL||'http://127.0.0.1:18880';
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
  const errors=[];
  try{
    const host=await browser.newPage(),guest=await browser.newPage();
    for(const p of [host,guest]){p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());p.setDefaultTimeout(12000);await p.goto(url);await p.locator('#status').filter({hasText:'已连接'}).waitFor();}
    await host.locator('#installed-empty').waitFor();
    await host.click('#market-open');
    for(const name of ['翻棋','黄金矿工','电影厅']){const card=host.locator('#market-list .card').filter({has:host.getByRole('heading',{name,exact:true})});await card.getByRole('button',{name:'安装',exact:true}).click();await card.getByRole('button',{name:'已安装',exact:true}).waitFor();}
    await host.locator('#market-dialog .dialog-close').click();
    await host.locator('#installed .card').filter({has:host.getByRole('heading',{name:'翻棋',exact:true})}).getByRole('button',{name:'创建房间'}).click();
    const name='插件翻棋'+Date.now().toString(36);await host.fill('#room-name',name);await host.click('#create-submit');
    const h=host.frameLocator('#plugin-frame');await h.locator('#waiting').waitFor();
    const frame=host.frames().find(f=>f.parentFrame());
    assert.equal(await frame.evaluate(()=>{try{parent.localStorage.getItem('cyber.nickname');return false;}catch{return true;}}),true,'Plugin cannot access parent storage');
    assert.equal(await frame.evaluate(()=>typeof NativeRoom),'undefined','Native host object is not exposed');
    await guest.click('#refresh');await guest.locator('.room-card').filter({hasText:name}).click();
    const g=guest.frameLocator('#plugin-frame');await g.locator('#waiting').waitFor();
    await h.locator('#waiting-id').filter({hasText:'2/2'}).waitFor();
    await h.locator('#ready').click();await g.locator('#ready').click();await h.locator('#chess').waitFor();await g.locator('#chess').waitFor();
    await host.reload();await host.frameLocator('#plugin-frame').locator('#chess').waitFor();
    await host.click('#close-plugin');await host.click('#leave-confirm');await host.locator('#home').waitFor();await guest.locator('#home').waitFor();
    assert.deepEqual(errors,[]);console.log('PASS plugin browser: signed installation, empty host, sandbox, install on join, game start, reload recovery and host close');
  }catch(e){for(const [i,p] of browser.contexts().flatMap(c=>c.pages()).entries()){fs.mkdirSync('server/target/plugin-checks',{recursive:true});await p.screenshot({path:`server/target/plugin-checks/failure-${i}.png`}).catch(()=>{});console.error('page',i,await p.locator('body').innerText().catch(()=>''));for(const f of p.frames().slice(1))console.error('frame',await f.locator('body').innerText().catch(()=>''));}console.error('errors',errors);throw e;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
