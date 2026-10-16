// Keep the screen awake only while this visible browser video is playing.
export function playerWake(video, notice, doc=document, nav=navigator) {
  let lock, pending=false, suspended=false, warned=false;
  const wanted=()=>!suspended&&!doc.hidden&&!video.paused&&!video.ended&&!!video.currentSrc;
  const warn=()=>{if(!warned){warned=true;notice('浏览器未能保持屏幕常亮；请检查系统省电设置，或使用新版 Safari。');}};
  async function sync(){
    if(!wanted()){const old=lock;lock=null;if(old)await old.release().catch(()=>{});return;}
    if(lock||pending)return;
    if(!nav.wakeLock?.request){warn();return;}
    pending=true;
    try{
      const acquired=await nav.wakeLock.request('screen');
      if(!wanted()){await acquired.release().catch(()=>{});return;}
      lock=acquired;
      acquired.addEventListener('release',()=>{if(lock===acquired)lock=null;});
    }catch{if(wanted())warn();}
    finally{pending=false;}
  }
  for(const event of ['playing','pause','ended','emptied'])video.addEventListener(event,sync);
  doc.addEventListener('visibilitychange',sync);
  // A gesture also retries after an OS-imposed release, without a retry loop.
  doc.addEventListener('pointerdown',sync);
  doc.addEventListener('keydown',sync);
  doc.defaultView?.addEventListener('pagehide',()=>{suspended=true;sync();});
  doc.defaultView?.addEventListener('pageshow',()=>{suspended=false;sync();});
  return {sync,reset(){suspended=true;sync();},resume(){suspended=false;sync();}};
}
