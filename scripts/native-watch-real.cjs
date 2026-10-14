// Explicit real Emby PC acceptance; credentials stay in environment/page memory.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
  if(!process.env.EMBY_BASE||!process.env.EMBY_USER||!process.env.EMBY_PASSWORD||!process.env.EMBY_ITEM)throw Error('Provide EMBY_BASE / EMBY_USER / EMBY_PASSWORD / EMBY_ITEM');
  const browser=await chromium.connectOverCDP(process.env.PC_CDP||'http://127.0.0.1:19224');
  const page=browser.contexts()[0].pages()[0],out=path.resolve(__dirname,'../server/target/native-watch-real'),states=[],errors=[];
  fs.mkdirSync(out,{recursive:true});page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message.split('\n')[0]));
  const select=(id,value)=>page.locator(id).evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('change',{bubbles:true}));},value);
  const state=()=>page.evaluate(()=>({player:window.__realPlayer,message:document.querySelector('#watch-message').textContent,title:document.querySelector('#watch-title').textContent,fullscreen:document.fullscreenElement?.id||null}));
  try{
    await page.locator('#lobby').waitFor();
    await page.evaluate(async item=>{
      window.__realPlayer=null;window.__realErrors=[];
      window.addEventListener('native-room',e=>{if(e.detail.type==='player'){window.__realPlayer=e.detail;if(e.detail.error)window.__realErrors.push(e.detail.error);}});
      // Narrow only the catalog list to the requested real item. Its details,
      // artwork, playback negotiation, media, tracks and control UI stay real.
      const {WatchRoom}=await import('./watch.js');window.__realSearch=WatchRoom.prototype.search;
      WatchRoom.prototype.search=async function(){return {Items:[await this.detail({Id:item})],TotalRecordCount:1};};
    },process.env.EMBY_ITEM);
    await page.click('[data-create=watch]');await page.fill('#room-name','原生真实影片验收 '+Date.now());await page.click('#create-submit');
    await page.locator('#watch').waitFor();await page.click('#watch-source');
    await page.fill('#emby-base',process.env.EMBY_BASE);await page.fill('#emby-user',process.env.EMBY_USER);await page.fill('#emby-password',process.env.EMBY_PASSWORD);await page.check('#emby-share');await page.click('#emby-connect');
    await page.locator('.media-card').first().click();await page.click('#library-select');await page.click('#watch-join');
    if((await page.textContent('#watch-play')).trim()==='播放')await page.click('#watch-play');
    await page.waitForFunction(()=>{const p=window.__realPlayer;return p?.renderedFirstFrame&&p.positionMs>3000&&p.audioOutputAdvancing&&p.audioOutput==='wasapi'&&!p.error;});
    states.push({step:'playing',...await state()});
    if(process.env.WAIT_FOR_VISUAL==='1'){console.log('Native playback ready for bounded window capture');await page.waitForTimeout(20000);}
    assert.ok(states[0].player.audioPcmPeak>0,'Diagnostics must observe nonzero decoded PCM');
    assert.ok(states[0].player.audioPcmFrames>0);assert.equal(states[0].player.engine,'mpv');
    await page.locator('.watch-settings summary').click();await select('#watch-rate',1.5);
    await page.waitForFunction(()=>window.__realPlayer?.rate===1.5);states.push({step:'rate',...await state()});
    await page.locator('#watch-volume').evaluate(el=>{el.value='.4';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>window.__realPlayer?.volume===.4);await page.click('#watch-mute');await page.waitForFunction(()=>window.__realPlayer?.muted);await page.click('#watch-mute');
    if((await page.textContent('#watch-play')).trim()!=='播放')await page.click('#watch-play');
    await select('#watch-seek',60);await page.waitForFunction(()=>Math.abs(window.__realPlayer?.positionMs-60000)<1500&&!window.__realPlayer.playing);states.push({step:'seek-paused',...await state()});
    const subtitle=await page.locator('#watch-subtitles').evaluate(el=>[...el.options].map(o=>o.value).find(v=>Number(v)>=0));
    if(subtitle!==undefined){await select('#watch-subtitles',subtitle);await page.waitForFunction(index=>window.__realPlayer?.subtitleStreamIndex===Number(index),subtitle);states.push({step:'embedded-subtitle',...await state()});await select('#watch-subtitles',-1);await page.waitForFunction(()=>window.__realPlayer?.subtitleStreamIndex===-1);}
    await page.click('#watch-fullscreen');await page.waitForFunction(()=>document.fullscreenElement?.id==='watch-stage');
    assert.ok(await page.locator('#watch-stage #watch-play').isVisible());
    await page.locator('#watch-rate + .choice-trigger').click();await page.locator('.choice-sheet[open]').waitFor();await page.locator('.choice-sheet .text-button').click();
    await page.click('#watch-fullscreen');await page.waitForFunction(()=>!document.fullscreenElement);
    states.push({step:'controls-complete',...await state()});
    assert.deepEqual(await page.evaluate(()=>window.__realErrors),[]);assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({pass:true,states,errors},null,2));console.log(JSON.stringify({pass:true,states,errors}));
  }catch(error){states.push({step:'failure',...await state().catch(()=>({}))});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({pass:false,reason:error.message.split('\n')[0],states,errors},null,2));throw Error(error.message.split('\n')[0]);}
  finally{
    await page.evaluate(async()=>{const {WatchRoom}=await import('./watch.js');if(window.__realSearch)WatchRoom.prototype.search=window.__realSearch;await window.cyberDisconnect?.();}).catch(()=>{});
    await browser.close();
  }
})().catch(error=>{console.error(error.message.split('\n')[0]);process.exitCode=1;});
