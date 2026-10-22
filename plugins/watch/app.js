import {$,text,element,toast,fail,confirm,mount,memberBadge} from '../../plugin_sdk/ui.js';
import {native,nativeCall,storageGet,storageSet,asset} from '../../plugin_sdk/transport.js';
import {playerUI} from './player-ui.js';
import {playerWake} from './player-wake.js';
import {rules} from './rules.js';
import {WatchRoom,episodeLabel,episodeCode} from './watch.js';
// The player dependency belongs to this plugin, never to the host page.
if(!native?.playerCommand)await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=asset('vendor/hls.min.js');script.onload=resolve;script.onerror=()=>reject(Error('电影厅播放组件加载失败'));document.head.append(script);});
let watch,embyContext='',embyRequest=0;
const game=mount(rules,{render(){if(embyContext&&(!game.current(embyContext)||!game.host)){embyContext='';embyRequest++;posterAccess=null;posterCache.clear();$('emby-dialog').close();$('library-dialog').close();$('emby-user').value='';$('emby-password').value='';$('emby-share').checked=false;$('emby-items').replaceChildren();}document.body.classList.toggle('watch-active',!!game.room);watch?.render();},event:e=>watch?.event(e)});
watch=new WatchRoom(game,toast);watch.ui=playerUI(watch,fail);
if(!native?.playerCommand)playerWake(watch.video,toast);
$('watch-join').onclick=async()=>{try{watch.unlockMedia();await watch.voice.listen();await watch.follow(true);if(!game.host)watch.requestSync();}catch(e){fail(e);}};
$('watch-mic').onclick=()=>watch.voice.microphoneToggle().catch(fail);
$('watch-play').onclick=()=>watch.control(!game.room?.playback?.playing).catch(fail);
$('watch-seek').onchange=()=>watch.control(!!game.room?.playback?.playing,+$('watch-seek').value).catch(fail);
$('watch-rate').onchange=()=>watch.control(!!game.room?.playback?.playing,watch.current(),+$('watch-rate').value).catch(fail);
$('watch-quality').onchange=()=>watch.setQuality($('watch-quality').value).catch(fail);
$('watch-audio').onchange=()=>watch.setAudio($('watch-audio').value).catch(fail);
$('watch-subtitles').onchange=()=>watch.setSubtitle($('watch-subtitles').value).catch(fail);
$('watch-mute').onclick=()=>{watch.setMuted(!watch.muted);watch.unlockMedia();};
$('watch-volume').oninput=()=>watch.setVolume($('watch-volume').value);
$('watch-volume').onchange=()=>watch.saveHost();
$('watch-retry').onclick=()=>{watch.unlockMedia();watch.reload().catch(fail);};
$('watch-back').onclick=()=>watch.skip(-10).catch(fail);
$('watch-forward').onclick=()=>watch.skip(30).catch(fail);
const diagnostics=$('watch-diagnostics-dialog');
function refreshDiagnostics(){$('watch-diagnostics-text').value=watch.diagnosticsText();}
$('watch-diagnostics').onclick=()=>{if(!watch.active)return;watch.ui.closePopup();refreshDiagnostics();if(document.fullscreenElement)document.fullscreenElement.append(diagnostics);diagnostics.showModal();watch.bounds();};
$('watch-diagnostics-refresh').onclick=refreshDiagnostics;
$('watch-diagnostics-select').onclick=()=>{$('watch-diagnostics-text').focus();$('watch-diagnostics-text').select();};
diagnostics.addEventListener('close',()=>{document.body.append(diagnostics);watch.ui.wake();watch.bounds();});
$('danmaku-form').onsubmit=e=>{e.preventDefault();watch.sendChat($('danmaku-text').value).catch(fail);$('danmaku-text').value='';};
// Source management and browsing are separate screens. Credentials stay in memory.
let libraryRequest=0,libraryType='Movie',libraryTerm='',libraryPath=[],libraryItems=[],libraryTotal=0,libraryOffset=0,libraryShown=0,libraryBusy=false,libraryRetry;
let posterAccess,posterCache=new Map(),posterQueue=[],posterActive=0;
const posterObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){posterObserver.unobserve(entry.target);posterQueue.push(entry.target);pumpPosters();}},{root:$('library-scroll'),rootMargin:'200px'});
function libraryValid(request){return request===libraryRequest&&game.current(embyContext)&&game.host&&watch.active&&$('library-dialog').open;}
function plainOverview(value){return typeof value==='string'?value.replace(/<[^>]*>/g,'').trim():'';}
function metadata(item){return [item.Type==='Episode'?episodeLabel(item):item.Type==='Series'?'电视剧':item.Type==='Season'?'分季':'电影',item.ProductionYear,Number(item.RunTimeTicks)>0?Math.round(item.RunTimeTicks/600000000)+' 分钟':'',Number.isFinite(item.CommunityRating)?'评分 '+item.CommunityRating.toFixed(1):''].filter(Boolean).join(' · ');}
function poster(item){const frame=element('div','media-poster'),fallback=element('span','poster-fallback',item.Type==='Episode'?'PLAY / EPISODE':item.Type==='Series'?'SERIES':'CINEMA');frame.append(fallback);frame.posterItem=item;frame.posterRequest=libraryRequest;posterObserver.observe(frame);return frame;}
async function pumpPosters(){
  while(posterActive<4&&posterQueue.length){const frame=posterQueue.shift();if(!frame.isConnected||!libraryValid(frame.posterRequest))continue;posterActive++;const item=frame.posterItem,key=item.ImageTags?.Primary?item.Id+':'+item.ImageTags.Primary:item.PrimaryImageTag?(item.PrimaryImageItemId||item.Id)+':'+item.PrimaryImageTag:(item.SeriesId||item.Id)+':'+(item.SeriesPrimaryImageTag||'');
    (async()=>{try{let image=posterCache.get(key);if(image===undefined){image=await watch.image(item);if(!libraryValid(frame.posterRequest))return;posterCache.set(key,image);if(posterCache.size>64)posterCache.delete(posterCache.keys().next().value);}if(image&&frame.isConnected&&libraryValid(frame.posterRequest)){const img=element('img');img.alt='';img.decoding='async';img.src=image;img.onerror=()=>img.remove();frame.append(img);}}catch{}finally{posterActive--;pumpPosters();}})();
  }
}
function sourceScreen(){
  if(!watch.active||!game.host)return;embyContext=game.context();const connected=!!watch.access?.token;
  $('emby-connected').hidden=!connected;$('emby-browse').hidden=!connected;$('emby-form').hidden=connected;
  $('emby-base').value=game.mediaAccess?.base||watch.access?.base||watch.saved?.source.base||storageGet('cyber.emby.base','');$('emby-web-base').value=game.mediaAccess?.webBase||watch.saved?.source.webBase||'';$('emby-user').value=watch.ownedSource?.username||watch.saved?.source.username||'';$('emby-remember').checked=watch.remember;
  text('emby-remember-note',native?'每 5 秒自动保存进度；授权由系统保护，不保存密码。':'每 5 秒自动保存进度；授权保存在此浏览器中，请只在自己的设备勾选。不保存密码。');
  text('emby-save-status',watch.saved?'本机已保存'+(watch.saved.playback?'：'+watch.saved.playback.title+' · '+Math.floor(watch.saved.playback.position/60)+':'+String(Math.floor(watch.saved.playback.position%60)).padStart(2,'0'):'片源'):'尚无本机观影存档');$('emby-forget').hidden=!watch.saved;
  text('emby-connected-address',connected?watch.access.base:'');text('emby-error','');$('emby-dialog').showModal();
}
$('watch-source').onclick=sourceScreen;$('watch-library').onclick=()=>watch.access?.token?openLibrary():sourceScreen();
$('emby-edit').onclick=()=>{$('emby-form').hidden=false;$('emby-browse').hidden=true;$('emby-password').focus();};
$('emby-browse').onclick=()=>{$('emby-dialog').close();openLibrary();};
$('emby-forget').onclick=async()=>{try{await watch.forgetSaved();$('emby-forget').hidden=true;$('emby-remember').checked=false;text('emby-save-status','已删除本机观影存档');}catch(e){text('emby-error',e.message);}};
$('library-source').onclick=()=>{$('library-dialog').close();sourceScreen();};
$('emby-form').onsubmit=async e=>{e.preventDefault();const context=embyContext,request=++embyRequest;if(!game.current(context)||!game.host)return;$('emby-connect').disabled=true;text('emby-error','正在连接片源…');try{await watch.login($('emby-base').value.trim(),$('emby-user').value.trim(),$('emby-password').value,$('emby-share').checked,$('emby-web-base').value.trim(),$('emby-remember').checked);if(!game.current(context)||request!==embyRequest)return;$('emby-password').value='';$('emby-dialog').close();openLibrary(true);}catch(e){if(game.current(context)&&request===embyRequest)text('emby-error',e.message);}finally{if(request===embyRequest)$('emby-connect').disabled=false;}};
$('emby-dialog').addEventListener('close',()=>{embyRequest++;watch.loginOperation=(watch.loginOperation||0)+1;$('emby-connect').disabled=false;$('emby-password').value='';});
function openLibrary(reset=false){
  if(!watch.active||!game.host)return;if(!watch.access?.token){sourceScreen();return;}embyContext=game.context();
  if(posterAccess!==watch.access){posterAccess=watch.access;posterCache.clear();reset=true;}if(reset){libraryType='Movie';libraryTerm='';}
  if(!$('library-dialog').open)$('library-dialog').showModal();browseRoot();
}
function libraryStart(path){
  const request=++libraryRequest;libraryPath=path;libraryBusy=true;posterObserver.disconnect();posterQueue=[];libraryRetry=null;$('library-retry').hidden=true;$('library-more').hidden=true;$('emby-items').replaceChildren();$('emby-items').className='emby-items'+(path.at(-1)?.item?.Type==='Season'?' episode-list':'');$('library-detail').replaceChildren();$('library-detail').hidden=true;libraryItems=[];libraryTotal=libraryOffset=libraryShown=0;text('library-count','');text('library-status','正在读取片库…');$('library-status').hidden=false;$('library-scroll').scrollTop=0;$('emby-items').setAttribute('aria-busy','true');
  $('library-tabs').hidden=path.length>0;$('emby-search-form').hidden=path.length>0;$('library-breadcrumbs').replaceChildren();
  for(let i=-1;i<path.length;i++){if(i>=0)$('library-breadcrumbs').append(element('span','breadcrumb-divider','/'));const b=element('button','text-button',i<0?(libraryType==='Movie'?'电影':'电视剧'):path[i].label);b.disabled=i===path.length-1;b.onclick=()=>i<0?browseRoot():browseItem(path[i].item,path.slice(0,i));$('library-breadcrumbs').append(b);}
  document.querySelectorAll('[data-library-type]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.libraryType===libraryType)));$('emby-search').value=libraryTerm;$('emby-search').placeholder=libraryType==='Movie'?'搜索电影名称':'搜索电视剧名称';return request;
}
function libraryDone(request,message=''){if(!libraryValid(request))return;libraryBusy=false;$('emby-items').setAttribute('aria-busy','false');text('library-status',message);$('library-status').hidden=!message;}
function libraryError(request,error,retry){if(!libraryValid(request))return;libraryDone(request,error.message||'暂时无法读取片库');libraryRetry=retry;$('library-retry').hidden=false;}
$('library-retry').onclick=()=>libraryRetry?.();
async function browseRoot(){text('library-title','今晚看什么');const request=libraryStart([]);try{const result=await watch.search(libraryTerm,libraryType,0);if(!libraryValid(request))return;libraryItems=result.Items||[];libraryOffset=libraryItems.length;libraryTotal=Number.isFinite(result.TotalRecordCount)?result.TotalRecordCount:libraryOffset+(libraryOffset===48?1:0);renderCatalog(libraryItems);libraryDone(request,libraryItems.length?'':libraryTerm?'没有找到匹配的'+(libraryType==='Movie'?'电影':'电视剧')+'，试试其他关键词。':'这个账号的片库暂时没有'+(libraryType==='Movie'?'电影':'电视剧')+'。');renderLibraryCount();}catch(e){libraryError(request,e,browseRoot);}}
function renderCatalog(items){for(const item of items){const b=element('button','media-card');b.type='button';b.dataset.itemId=item.Id;const copy=element('div','media-card-copy');copy.append(element('strong','',item.Name||'未命名影片'),element('span','',metadata(item)));b.append(poster(item),copy);b.onclick=()=>browseItem(item,[]);$('emby-items').append(b);}}
function renderLibraryCount(){const shown=libraryPath.length?libraryShown:libraryOffset;const more=shown<libraryTotal;text('library-count',libraryTotal?('已显示 '+shown+' / '+libraryTotal+(libraryPath.at(-1)?.item.Type==='Season'?' 集':' 项')):'');$('library-more').hidden=!more;$('library-more').disabled=libraryBusy;}
function detailHero(item){const hero=element('div','media-detail-hero'),copy=element('div','media-detail-copy');hero.append(poster(item));copy.append(element('p','eyebrow',item.Type==='Episode'?episodeCode(item):item.Type==='Series'?'SERIES / 电视剧':'FILM / 电影'),element('h3','',item.Name||'未命名影片'),element('p','media-metadata',metadata(item)));if(item.Type==='Episode'&&item.SeriesName)copy.append(element('p','media-series-name',item.SeriesName));if(item.Genres?.length)copy.append(element('p','media-genres',item.Genres.slice(0,5).join(' / ')));copy.append(element('p','media-overview',plainOverview(item.Overview)||'这部影片暂时没有简介。'));hero.append(copy);$('library-detail').append(hero);$('library-detail').hidden=false;return copy;}
async function browseItem(item,parents){
  const label=item.Type==='Season'?(item.IndexNumber===0?'特别篇':Number.isInteger(item.IndexNumber)?'第 '+item.IndexNumber+' 季':item.Name):item.Type==='Episode'?episodeCode(item):item.Name,path=[...parents,{label:label||'未命名',item}],request=libraryStart(path);
  try{
    if(item.Type==='Season'){const series=parents.find(p=>p.item.Type==='Series')?.item;if(!series)throw Error('找不到所属电视剧，请返回片库重试');text('library-title',series.Name);libraryItems=await watch.children(series,item,()=>libraryValid(request));if(!libraryValid(request))return;libraryTotal=libraryItems.length;appendEpisodes();libraryDone(request,libraryTotal?'':'这一季暂时没有可用剧集。');renderLibraryCount();return;}
    const full={...item,...await watch.detail(item)};if(!libraryValid(request))return;path[path.length-1].item=full;text('library-title',full.Type==='Series'?'剧集详情':'影片详情');const copy=detailHero(full);
    if(full.Type==='Series'){libraryItems=await watch.children(full,undefined,()=>libraryValid(request));if(!libraryValid(request))return;libraryTotal=libraryShown=libraryItems.length;$('emby-items').classList.add('season-list');for(const season of libraryItems){const b=element('button','season-card'),number=season.IndexNumber;b.append(element('span','season-number',number===0?'SP':Number.isInteger(number)?String(number).padStart(2,'0'):'—'),element('strong','',number===0?'特别篇':Number.isInteger(number)?'第 '+number+' 季':season.Name||'未标季'),element('small','',Number(season.ChildCount)>0?season.ChildCount+' 集':'查看剧集'));b.onclick=()=>browseItem(season,path);$('emby-items').append(b);}libraryDone(request,libraryItems.length?'':'片源暂未提供分季信息。');renderLibraryCount();}
    else{const play=element('button','primary media-select','选择这'+(full.Type==='Episode'?'一集':'部影片')+' →');play.id='library-select';play.onclick=async()=>{if(!libraryValid(request))return;play.disabled=true;posterObserver.disconnect();posterQueue=[];text('library-status','正在准备播放…');$('library-status').hidden=false;try{await watch.select(full);if(libraryValid(request))$('library-dialog').close();}catch(e){if(libraryValid(request)){text('library-status',e.message);play.disabled=false;}}};copy.append(play);libraryDone(request);}
  }catch(e){libraryError(request,e,()=>browseItem(item,parents));}
}
function appendEpisodes(){const end=Math.min(libraryItems.length,libraryShown+50);for(const item of libraryItems.slice(libraryShown,end)){const b=element('button','episode-card');b.type='button';b.dataset.itemId=item.Id;const copy=element('div','episode-copy');copy.append(element('span','episode-code',episodeCode(item)+' · '+episodeLabel(item)),element('strong','',item.Name||'未命名剧集'),element('p','',plainOverview(item.Overview)||'暂无本集简介'),element('small','',Number(item.RunTimeTicks)>0?Math.round(item.RunTimeTicks/600000000)+' 分钟':'时长未知'));b.append(poster(item),copy,element('span','episode-arrow','→'));b.onclick=()=>browseItem(item,libraryPath);$('emby-items').append(b);}libraryShown=end;}
$('library-more').onclick=async()=>{if(libraryBusy)return;if(libraryPath.length){appendEpisodes();renderLibraryCount();return;}const request=libraryRequest;libraryBusy=true;$('library-more').disabled=true;try{const result=await watch.search(libraryTerm,libraryType,libraryOffset);if(!libraryValid(request))return;const items=result.Items||[],known=new Set(libraryItems.map(p=>p.Id)),added=items.filter(p=>!known.has(p.Id));if(items.length&&!added.length)throw Error('片源返回了重复分页，请重新打开');libraryItems.push(...added);libraryOffset+=items.length;libraryTotal=Number.isFinite(result.TotalRecordCount)?result.TotalRecordCount:libraryOffset+(items.length===48?1:0);if(!items.length)libraryTotal=libraryOffset;renderCatalog(added);libraryDone(request);renderLibraryCount();}catch(e){libraryError(request,e,()=>$('library-more').click());renderLibraryCount();}};
document.querySelectorAll('[data-library-type]').forEach(b=>b.onclick=()=>{libraryType=b.dataset.libraryType;libraryTerm='';text('library-title','今晚看什么');browseRoot();});
$('emby-search-form').onsubmit=e=>{e.preventDefault();libraryTerm=$('emby-search').value.trim();browseRoot();};
$('library-dialog').addEventListener('close',()=>{libraryRequest++;posterObserver.disconnect();posterQueue=[];$('emby-items').replaceChildren();$('library-detail').replaceChildren();libraryPath=[];libraryItems=[];});
