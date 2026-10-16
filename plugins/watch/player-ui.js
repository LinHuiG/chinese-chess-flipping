import {playerKeys} from './player-keys.js';
// One control surface for browser video and native video overlays.
export function playerUI(watch, fail) {
  const stage=document.getElementById('watch-stage'),bar=document.querySelector('.cinema-playback'),settings=bar.querySelector('details'),button=document.getElementById('watch-fullscreen');
  let timer,hover=false,drag=false;
  const full=()=>document.fullscreenElement===stage;
  function visible(value){const changed=stage.classList.contains('controls-hidden')===value;stage.classList.toggle('controls-hidden',!value);bar.inert=!value;if(changed)watch.bounds();}
  function wake(){clearTimeout(timer);visible(true);if(full())timer=setTimeout(hide,2800);}
  function hide(){if(!full())return;if(hover||drag||settings.open||bar.matches(':focus-within')||document.querySelector('dialog[open]')){timer=setTimeout(hide,1000);return;}visible(false);}
  button.onclick=()=>{
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
  const systemControl=()=>video?.webkitDisplayingFullscreen&&watch.url&&!watch.loading&&!watch.room.background&&!watch.waiting;
  for(const event of ['play','pause'])video?.addEventListener(event,()=>{
    const state=watch.room.room?.playback;if(!systemControl()||!state||systemSeek||watch.pendingSeek)return;
    if(watch.room.host&&state.playing!==!video.paused)watch.control(!video.paused,watch.current()).catch(fail);
    else if(!watch.room.host)watch.follow(true).catch(fail);
  });
  video?.addEventListener('seeking',()=>{systemSeek=!!systemControl()&&!watch.pendingSeek;});
  video?.addEventListener('seeked',()=>{const user=systemSeek;systemSeek=false;if(!user||!systemControl())return;if(watch.room.host)watch.control(!!watch.room.room?.playback?.playing,video.currentTime+(watch.offset||0)).catch(fail);else watch.follow(true).catch(fail);});
  document.addEventListener('fullscreenchange',()=>{
    clearTimeout(timer);settings.open=false;hover=drag=false;
    if(full()){stage.append(bar);stage.focus({preventScroll:true});screen.orientation?.lock?.('landscape').catch(()=>{});}
    else {stage.after(bar);screen.orientation?.unlock?.();}
    button.textContent=full()?'退出全屏':'全屏';button.setAttribute('aria-pressed',String(full()));wake();watch.bounds();
  });
  stage.tabIndex=0;
  stage.addEventListener('pointermove',e=>{if(e.pointerType==='mouse')wake();});
  stage.addEventListener('pointerdown',e=>{if(!bar.contains(e.target))wake();});
  bar.addEventListener('pointerenter',e=>{hover=e.pointerType==='mouse';wake();});
  bar.addEventListener('pointerleave',()=>{hover=false;wake();});
  bar.addEventListener('pointerdown',()=>{drag=true;wake();});
  document.addEventListener('pointerup',()=>{if(!drag)return;drag=false;if(bar.contains(document.activeElement)&&!document.activeElement.matches('select,summary'))document.activeElement.blur();wake();});
  document.addEventListener('pointercancel',()=>{drag=false;wake();});
  bar.addEventListener('focusin',wake);bar.addEventListener('focusout',wake);settings.addEventListener('toggle',wake);
  const stopKeys=playerKeys(watch,wake,()=>button.click(),fail);
  new ResizeObserver(()=>watch.bounds()).observe(bar);
  return {wake,reset(){stopKeys();clearTimeout(timer);if(full())document.exitFullscreen().catch(()=>{});}};
}
