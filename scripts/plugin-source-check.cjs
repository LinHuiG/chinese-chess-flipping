// Explicit credentials from environment, isolated local room, never controls another session.
const {chromium}=require('playwright');
(async()=>{
 if(!process.env.EMBY_BASE||!process.env.EMBY_USER||!process.env.EMBY_PASSWORD)throw Error('Set EMBY_BASE/EMBY_USER/EMBY_PASSWORD');
 const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']}),page=await browser.newPage();
 const diagnostics=[];let step='open lobby';
 try{
  page.setDefaultTimeout(45000);page.on('dialog',d=>d.accept());
  page.on('console',m=>{if(m.type()==='error')diagnostics.push({console:m.text().replace(/https?:\/\/[^\s'"<>]+/g,'[URL]').slice(0,600)});});
  page.on('response',r=>{const u=new URL(r.url());if(u.pathname.endsWith('PlaybackInfo')||/\.(m3u8|ts)$/.test(u.pathname))diagnostics.push({kind:u.pathname.endsWith('PlaybackInfo')?'negotiation':u.pathname.endsWith('.m3u8')?'manifest':'segment',status:r.status()});});
  page.on('response',async r=>{if(!new URL(r.url()).pathname.endsWith('PlaybackInfo'))return;try{const info=await r.json();diagnostics.push({error:info.ErrorCode,sources:info.MediaSources?.map(s=>({container:s.Container,direct:s.SupportsDirectPlay,transcode:!!s.TranscodingUrl,streams:s.MediaStreams?.map(t=>({type:t.Type,codec:t.Codec}))}))});}catch{}});
  page.on('requestfailed',r=>{if(['media','fetch'].includes(r.resourceType()))diagnostics.push({kind:r.resourceType(),error:r.failure()?.errorText});});
  await page.goto(process.env.CHESS_WEB_URL||'http://127.0.0.1:19880');await page.locator('#status').filter({hasText:'已连接'}).waitFor();await page.click('#market-open');
  const card=page.locator('#market-list .card').filter({has:page.getByRole('heading',{name:'电影厅',exact:true})});await card.getByRole('button',{name:'安装',exact:true}).click();await card.getByRole('button',{name:'已安装',exact:true}).waitFor();await page.locator('#market-dialog .dialog-close').click();
  await page.locator('#installed .card').filter({has:page.getByRole('heading',{name:'电影厅',exact:true})}).getByRole('button',{name:'创建房间'}).click();await page.fill('#room-name','独立片源检查');await page.click('#create-submit');
  step='authenticate source';const f=page.frameLocator('#plugin-frame');await f.locator('#watch-source').click();await f.locator('#emby-base').fill(process.env.EMBY_BASE);await f.locator('#emby-user').fill(process.env.EMBY_USER);await f.locator('#emby-password').fill(process.env.EMBY_PASSWORD);await f.locator('#emby-remember').uncheck();await f.locator('#emby-share').check();await f.locator('#emby-connect').click();step='wait for library';
  await f.locator('.media-card').first().waitFor();
  if(process.env.EMBY_NEGOTIATE_ONLY==='1'){console.log('PASS real source authentication/library through opaque plugin iframe; no media started');return;}
  await f.locator('.media-card').first().click();await f.locator('#watch-video').evaluate(v=>{v.muted=true;v.volume=0;});await f.locator('#library-select').click();
  const child=page.frames().find(f=>f.parentFrame());await child.waitForFunction(()=>document.querySelector('#watch-video').readyState>=2||document.querySelector('#watch-retry').hidden===false);
  console.log(JSON.stringify(await child.evaluate(()=>{const v=document.querySelector('#watch-video');return {ready:v.readyState,width:v.videoWidth,error:v.error?.code,message:document.querySelector('#watch-message').textContent};})));
  console.log(JSON.stringify({responses:diagnostics}));
  if(!await child.evaluate(()=>document.querySelector('#watch-video').readyState>=2&&document.querySelector('#watch-video').videoWidth>0))throw Error('Real source did not decode a video frame');
 }catch(e){const f=page.frames().find(f=>f.parentFrame());console.log(JSON.stringify({step,responses:diagnostics,status:f?await f.evaluate(()=>({toast:document.querySelector('#toast')?.textContent,message:document.querySelector('#watch-message')?.textContent,library:document.querySelector('#library-status')?.textContent,cards:document.querySelectorAll('#emby-items button').length})).catch(()=>({})):null}));throw e;}
 finally{await page.locator('#close-plugin').click({timeout:3000}).catch(()=>{});await browser.close();}
})().catch(e=>{console.error(e.message.split('\n')[0].replace(/https?:\/\/\S+/g,'[URL]'));process.exitCode=1;});
