// Local acceptance: actual browser UI, 3 players, host saves, reconnect and original chess.
// NODE_PATH=<Playwright package directory> CHESS_WEB_URL=http://127.0.0.1:18880 node scripts/web-smoke.cjs
const {chromium}=require('playwright'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
(async()=>{
  const url=process.env.CHESS_WEB_URL||'http://127.0.0.1:18880',out=path.resolve(__dirname,'../server/target/web-checks');fs.mkdirSync(out,{recursive:true});
  let browser;try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'msedge'});}
  const host=await browser.newPage({viewport:{width:1440,height:1100}}),a=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),b=await browser.newPage({viewport:{width:820,height:1080}});
  const pages=[host,a,b],errors=[];
  async function visible(p,id){await p.locator(id).waitFor({state:'visible'});}
  async function leave(){await host.locator('section:not([hidden]) .leave').first().click();await host.click('#confirm-ok');await Promise.all(pages.map(p=>visible(p,'#lobby')));}
  async function create(kind,load=false){
    if(load)await host.click('#continue-mine');else await host.click('[data-create='+kind+']');
    if(kind==='miner'&&!load)await host.selectOption('#capacity','3');
    await host.fill('#room-name',kind==='miner'?'一起挖金的朋友':'翻棋验收');await host.click('#create-submit');await visible(host,'#waiting');
  }
  async function join(p){const roomId=(await host.textContent('#waiting-id')).split(' ')[1];await p.click('#refresh');await p.locator('.room-card').filter({hasText:roomId}).click();await visible(p,'#waiting');}
  async function ready(list,screen){for(const p of list)await p.click('#ready');await Promise.all(list.map(p=>visible(p,screen)));}
  async function saveShot(p,name){await p.screenshot({path:path.join(out,name+'.png'),fullPage:true});}
  for(const p of pages){p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&!m.text().includes('WebSocket'))errors.push(m.text());});}
  try{
    await Promise.all(pages.map(p=>p.goto(url)));await Promise.all(pages.map(p=>visible(p,'#lobby')));
    for(let i=0;i<pages.length;i++){await pages[i].click('#settings-open');await pages[i].fill('#nickname',['林间房主','小蓝','小紫'][i]);await pages[i].click('#settings-save');}
    await saveShot(host,'desktop-lobby');await saveShot(a,'mobile-lobby');
    await a.setViewportSize({width:320,height:844});assert.ok(await a.locator('#download-app').isVisible());assert.ok(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await a.setViewportSize({width:390,height:844});
    // Reusing the same host after a two-seat room must rebuild all three seats.
    await create('chess');assert.equal(await host.locator('#players .player').count(),2);await leave();
    await create('miner');assert.equal(await host.locator('#players .player').count(),3,'Three-seat room must show three seats before anyone joins');
    await saveShot(host,'desktop-waiting');
    for(const width of [1440,1233,900,820,540,390,320]){
      await host.setViewportSize({width,height:1100});
      assert.ok(await host.evaluate(()=>{const cards=[...document.querySelectorAll('#players .player')];return document.documentElement.scrollWidth<=innerWidth+1&&cards.every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;});}),'Waiting seats fit '+width+'px');
    }
    await host.setViewportSize({width:1440,height:1100});
    await join(a);await join(b);await saveShot(a,'mobile-waiting');
    await ready(pages,'#miner');await host.click('#drop');await a.click('#drop');await b.click('#drop');
    await saveShot(host,'desktop-miner');await saveShot(a,'mobile-miner');
    assert.equal(await host.locator('.score-card').count(),3);
    await host.click('#save');const saved=await host.evaluate(()=>JSON.parse(localStorage.getItem('cyber.miner.save')));assert.equal(saved.players.length,3);assert.equal(saved.level,1);
    await leave();
    // Resume a near-end round with money, exercising the same public saved-progress entry.
    await host.evaluate(()=>{const s=JSON.parse(localStorage.getItem('cyber.miner.save'));s.time=2;for(const p of s.players)p.cash=1800;localStorage.setItem('cyber.miner.save',JSON.stringify(s));});
    await create('miner',true);await join(a);await join(b);await ready(pages,'#miner');
    await Promise.all(pages.map(p=>visible(p,'#shop')));await host.locator('[data-item=strength]').click();await a.locator('[data-item=reel]').click();
    await saveShot(host,'desktop-shop');await saveShot(a,'mobile-shop');
    for(const p of pages)await p.click('#shop-ready');await host.click('#next-level');await host.waitForFunction(()=>document.querySelector('#mine-level').textContent.includes('第 2 /'));
    await host.click('#pause');await host.reload();await visible(host,'#miner');await host.waitForFunction(()=>document.querySelector('#pause').textContent==='继续冒险');
    await host.click('#pause');await a.reload();await visible(a,'#miner');await a.waitForFunction(()=>document.querySelector('#mine-level').textContent.includes('第 2 /'));
    await leave();
    await create('chess');await join(a);await host.click('[data-seconds="0"]');await ready([host,a],'#chess');
    for(let i=0;i<4;i++){
      const actor=(await host.textContent('#turn-badge'))==='轮到你了'?host:a;await actor.locator('.piece.dark').first().click();
      await Promise.all([host,a].map(p=>p.waitForFunction(n=>document.querySelectorAll('.piece.dark').length===n,31-i)));
    }
    const board=await host.locator('.piece').allTextContents();assert.deepEqual(board,await a.locator('.piece').allTextContents());
    await saveShot(host,'desktop-chess');await saveShot(a,'mobile-chess');
    await a.context().setOffline(true);await a.context().setOffline(false);await a.reload();await visible(a,'#chess');assert.deepEqual(board,await a.locator('.piece').allTextContents());
    await host.reload();await visible(host,'#chess');assert.deepEqual(board,await host.locator('.piece').allTextContents());
    await leave();
    for(const p of pages)assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');
    assert.deepEqual(errors,[]);
    console.log('PASS browser: 3 miners, host-only save/resume, shop and next level, 2-player chess, guest/host refresh, host dissolution, desktop/mobile layouts');
  }catch(error){for(let i=0;i<pages.length;i++){await pages[i].screenshot({path:path.join(out,'failure-'+i+'.png'),fullPage:true}).catch(()=>{});console.error('PAGE',i,await pages[i].locator('#toast').textContent().catch(()=>''));}console.error('Browser errors',errors);throw error;}
  finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
