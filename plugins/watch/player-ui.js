import {playerKeys} from './player-keys.js';
// One control surface for browser video and native video overlays.
export function playerUI(watch, fail) {
  const stage=document.getElementById('watch-stage'),bar=document.querySelector('.cinema-playback'),popup=document.getElementById('watch-popup'),button=document.getElementById('watch-fullscreen');
  let timer,drag=null,popupGeneration=0,popupTrigger,disposed=false,started=false;
  const full=()=>document.fullscreenElement===stage;
  function visible(value){const changed=stage.classList.contains('controls-hidden')===value;stage.classList.toggle('controls-hidden',!value);bar.classList.toggle('controls-hidden',!value);bar.inert=!value;if(changed)watch.bounds();}
  function wake(){if(disposed||!watch.active)return;clearTimeout(timer);visible(true);timer=setTimeout(hide,5000);}
  function hide(){if(disposed||!watch.active)return;if(watch.needsAttention()||drag||popup&&!popup.hidden||bar.contains(document.activeElement)&&document.activeElement.matches('input:not([type=range]),textarea')||document.querySelector('dialog[open]')){timer=setTimeout(hide,1000);return;}visible(false);}
  function endDrag(){const previous=drag;drag=null;if(previous?.target.hasPointerCapture(previous.id))previous.target.releasePointerCapture(previous.id);}
  button.onclick=()=>{
    if(disposed||!watch.active)return;
    if(full()){document.exitFullscreen().catch(fail);return;}
    if(document.fullscreenEnabled&&stage.requestFullscreen){stage.requestFullscreen().catch(fail);return;}
    // iPhone Safari exposes video fullscreen even when element fullscreen is unavailable.
    const video=watch.video;
    if(!watch.nativePlayer&&typeof video?.webkitEnterFullscreen==='function'){
      try{if(video.readyState<1)throw Error('请等待视频载入后再全屏');video.webkitEnterFullscreen();}catch(e){fail(e);}return;
    }
    fail(Error('当前页面未获全屏权限，请在独立浏览器页面打开，或检查站点全屏权限配置'));
  };
  // System video controls on iPhone must update the same host timeline as HTML controls.
  const video=watch.video;let systemSeek=false;
  const systemControl=()=>!disposed&&watch.active&&video?.webkitDisplayingFullscreen&&watch.url&&!watch.loading&&!watch.room.background&&!watch.waiting;
  for(const event of ['play','pause'])video?.addEventListener(event,()=>{
    const state=watch.room.room?.playback;if(!systemControl()||!state||systemSeek||watch.pendingSeek)return;
    if(watch.room.host&&state.playing!==!video.paused)watch.control(!video.paused,watch.current()).catch(fail);
    else if(!watch.room.host)watch.follow(true).catch(fail);
  });
  video?.addEventListener('seeking',()=>{systemSeek=!!systemControl()&&!watch.pendingSeek;});
  video?.addEventListener('seeked',()=>{const user=systemSeek;systemSeek=false;if(!user||!systemControl())return;if(watch.room.host)watch.control(!!watch.room.room?.playback?.playing,video.currentTime+(watch.offset||0)).catch(fail);else watch.follow(true).catch(fail);});
  document.addEventListener('fullscreenchange',()=>{
    clearTimeout(timer);closePopup();endDrag();
    if(full()&&!disposed){stage.append(bar);stage.focus({preventScroll:true});screen.orientation?.lock?.('landscape').catch(()=>{});}
    else {stage.after(bar);screen.orientation?.unlock?.();}
    button.textContent=full()&&!disposed?'退出全屏':'全屏';button.setAttribute('aria-pressed',String(full()&&!disposed));if(disposed&&full())document.exitFullscreen().catch(()=>{});wake();watch.bounds();
  });
  stage.tabIndex=0;
  document.addEventListener('pointermove',e=>{if(watch.active&&e.pointerType==='mouse')wake();});
  stage.addEventListener('pointerdown',e=>{if(!bar.contains(e.target))wake();});
  bar.addEventListener('pointerdown',e=>{if(disposed)return;if(e.target.matches('input[type=range]')){endDrag();drag={target:e.target,id:e.pointerId};e.target.setPointerCapture(e.pointerId);}wake();});
  document.addEventListener('pointerup',e=>{if(drag?.id===e.pointerId)endDrag();const focused=document.activeElement;if(bar.contains(focused)&&focused.matches('button')&&!popup?.contains(focused)&&e.target.closest('button')===focused)focused.blur();wake();});
  document.addEventListener('pointercancel',e=>{if(drag?.id===e.pointerId){endDrag();wake();}});
  bar.addEventListener('lostpointercapture',e=>{if(drag?.id===e.pointerId){endDrag();wake();}});
  window.addEventListener('blur',()=>{endDrag();wake();});
  bar.addEventListener('focusin',wake);bar.addEventListener('focusout',wake);
  function closePopup(){popupGeneration++;if(popup)popup.hidden=true;popupTrigger?.setAttribute('aria-expanded','false');popupTrigger=null;watch.bounds();}
  function openPopup(trigger){closePopup();popupTrigger=trigger;trigger.setAttribute('aria-expanded','true');popup.replaceChildren();popup.hidden=false;wake();return popupGeneration;}
  function option(label,selected,action){const b=document.createElement('button');b.type='button';b.className='choice-option';b.textContent=label+(selected?' ✓':'');b.setAttribute('aria-pressed',String(selected));b.onclick=()=>{const context=watch.room.context(),current=()=>!disposed&&watch.active&&watch.room.current(context);closePopup();wake();Promise.resolve().then(()=>{if(current())return action();}).catch(e=>{if(current())fail(e);});};popup.append(b);return b;}
  const choices=[];
  for(const select of bar.querySelectorAll('select[data-player-choice]')){
    select.classList.add('native-choice');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
    const trigger=document.createElement('button');trigger.type='button';trigger.className='choice-trigger';trigger.setAttribute('aria-label',select.getAttribute('aria-label'));trigger.setAttribute('aria-expanded','false');trigger.textContent=(select.selectedOptions[0]?.textContent||'请选择')+'  ▴';trigger.disabled=select.disabled;select.after(trigger);choices.push([select,trigger]);
    trigger.onclick=()=>{if(disposed)return;if(popupTrigger===trigger){closePopup();wake();return;}openPopup(trigger);for(const item of select.options){const b=option(item.textContent,item.selected,()=>{select.value=item.value;select.dispatchEvent(new Event('change',{bubbles:true}));});b.disabled=item.disabled;}watch.bounds();popup.querySelector('button:not(:disabled)')?.focus();};
  }
  // Keep detailed track names in the choice list and title, while the bar
  // shows useful short values instead of clipping most of the label away.
  function compactChoices(){for(const [select,trigger] of choices){const label=select.selectedOptions[0]?.textContent||'请选择';let value=label;
    if(select.id==='watch-audio'){const codec=label.match(/(?:EAC3|E-AC-3|AC3|AAC|DTS|FLAC|OPUS|MP3|TRUEHD)/i)?.[0],channels=label.match(/\d+\s*声道/)?.[0];value=codec?[codec.toUpperCase(),channels].filter(Boolean).join(' '):'音轨';}
    if(select.id==='watch-subtitles')value=select.value==='-1'?'字幕关':'字幕开';
    const text=value+' ▴';if(trigger.textContent!==text)trigger.textContent=text;trigger.disabled=select.disabled;trigger.title=select.getAttribute('aria-label')+'：'+label;trigger.setAttribute('aria-label',trigger.title);
  }const join=document.getElementById('watch-join');if(join){const value=watch.room.room?.playback?'开启声音':'语音收听';if(join.textContent!==value)join.textContent=value;join.title='加入观影 / 开启声音';}}
  function update(){if(disposed||!watch.active)return;compactChoices();if(!started){started=true;wake();}else if(bar.inert&&watch.needsAttention())wake();}
  const episodes=document.getElementById('watch-episodes');
  if(episodes)episodes.onclick=async()=>{
    if(disposed)return;if(popupTrigger===episodes){closePopup();wake();return;}const generation=openPopup(episodes),context=watch.room.context();popup.textContent='正在读取剧集…';watch.bounds();
    try{const items=await watch.episodes();if(generation!==popupGeneration||!watch.room.current(context))return;popup.replaceChildren();if(!items.length)popup.textContent='没有可用剧集';for(const item of items)option((item.ParentIndexNumber===0?'特别篇':'第 '+item.ParentIndexNumber+' 季')+' · 第 '+item.IndexNumber+' 集 '+item.Name,item.Id===watch.room.room?.playback?.itemId,()=>watch.select(item,!!watch.room.room?.playback?.playing));watch.bounds();popup.querySelector('[aria-pressed=true]')?.scrollIntoView({block:'nearest'});}
    catch(e){if(!disposed&&generation===popupGeneration&&watch.room.current(context)){popup.replaceChildren();option('读取失败，点击重试',false,()=>episodes.click());fail(e);watch.bounds();}}
  };
  document.addEventListener('pointerdown',e=>{if(popup&&!popup.hidden&&!popup.contains(e.target)&&!popupTrigger?.contains(e.target)){closePopup();wake();}});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&popup&&!popup.hidden){e.preventDefault();e.stopPropagation();const trigger=popupTrigger;closePopup();wake();trigger?.focus();}},true);
  const form=document.getElementById('fullscreen-danmaku-form'),input=document.getElementById('fullscreen-danmaku-text');
  if(form)form.onsubmit=async e=>{e.preventDefault();if(disposed||!watch.active)return;const text=input.value,context=watch.room.context(),current=()=>!disposed&&watch.active&&watch.room.current(context);try{await watch.sendChat(text);if(current()&&input.value===text)input.value='';}catch(error){if(current())fail(error);}if(current())wake();};
  const stopKeys=playerKeys(watch,wake,()=>button.click(),fail);
  new ResizeObserver(()=>watch.bounds()).observe(bar);
  update();
  return {wake,update,closePopup,reset(){disposed=true;clearTimeout(timer);endDrag();closePopup();stopKeys();if(full())document.exitFullscreen().catch(()=>{});}};
}
