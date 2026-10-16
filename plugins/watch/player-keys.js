// Keyboard transport controls are host-only. A hold is a temporary operation.
export function playerKeys(watch,wake,fullscreen,fail){
  let held=null;
  const hint=document.getElementById('watch-key-hint');
  const eligible=e=>watch.active&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.isComposing&&!document.querySelector('dialog[open]')&&!e.target.closest('input,textarea,select,button,summary,[contenteditable="true"]');
  function finish(short=false){
    const h=held;if(!h)return;held=null;clearTimeout(h.timer);clearInterval(h.repeat);hint.textContent='';
    if(watch.room.context()!==h.context||watch.room.room?.playback?.epoch!==h.epoch)return;
    if(h.long&&h.key==='ArrowRight')watch.control(h.playing,watch.current(),h.rate).catch(fail);
    else if(short&&!h.long)watch.skip(h.key==='ArrowLeft'?-10:30).catch(fail);
  }
  document.addEventListener('keydown',e=>{
    if(!eligible(e)||![' ','ArrowLeft','ArrowRight','f','F'].includes(e.key))return;
    e.preventDefault();wake();if(e.repeat)return;
    if(e.key.toLowerCase()==='f'){finish();fullscreen();return;}
    if(!watch.room.host||!watch.room.room?.playback||watch.loading||!watch.url)return;
    if(e.key===' '){finish();watch.control(!watch.room.room.playback.playing).catch(fail);return;}
    finish();const state=watch.room.room.playback,h=held={key:e.key,context:watch.room.context(),epoch:state.epoch,rate:state.rate||1,playing:!!state.playing,long:false};
    h.timer=setTimeout(()=>{
      if(held!==h)return;if(watch.room.context()!==h.context||watch.room.room?.playback?.epoch!==h.epoch){finish();return;}h.long=true;wake();
      if(h.key==='ArrowRight'){hint.textContent='2× 快进 · 松开恢复';watch.control(true,watch.current(),2).catch(fail);}
      else {hint.textContent='连续后退 · 松开停止';const rewind=()=>{if(held!==h||watch.room.context()!==h.context||watch.room.room?.playback?.epoch!==h.epoch){finish();return;}watch.skip(-10).catch(fail);wake();};rewind();h.repeat=setInterval(rewind,400);}
    },350);
  });
  document.addEventListener('keyup',e=>{if(held?.key===e.key){e.preventDefault();finish(true);wake();}});
  document.addEventListener('focusin',e=>{if(e.target.closest('input,textarea,select,[contenteditable="true"]'))finish();});
  window.addEventListener('blur',()=>finish());
  document.addEventListener('visibilitychange',()=>{if(document.hidden)finish();});
  return ()=>finish();
}
