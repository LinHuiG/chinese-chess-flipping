import {GameRoom,GAMES} from './room.js';
import {native,nativeCall,settings,storageGet,storageSet} from './transport.js';
import {WatchRoom,episodeLabel,episodeCode} from './watch.js';
import {installChoices} from './choices.js';
import {SHOP,THEMES} from './miner.js';
import {MinerView,Sound} from './miner-view.js';
const $=id=>document.getElementById(id),sound=new Sound(),view=new MinerView($('mine-canvas'),sound);
const initial=settings();
if(native&&storageGet('cyber.preferences.migrated')!==true){
  storageSet('cyber.nickname',initial.nickname||'');storageSet('cyber.sound',initial.sound!==false);storageSet('cyber.motion',initial.motion!==false);storageSet('cyber.preferences.migrated',true);
}
sound.enabled=storageGet('cyber.sound',true);view.motion=storageGet('cyber.motion',!matchMedia('(prefers-reduced-motion: reduce)').matches);
let status='正在连接…',rooms=[],listing=false,lobbyVersion=0,selected=-1,boardKey='',lastMove=-1,lastRound='',lastRoom='',toastTimer,confirmResolve,resultSound='';
let watch,embyContext='',embyRequest=0,passwordContext='';
const game=new GameRoom({changed:render,lobby:refresh,notice:toast,status:s=>{status=s;render();},network:network,native:nativeEvent,module:e=>watch?.event(e).catch(fail),kick:async p=>{if(await confirm('移出成员？','将 '+p.name+' 移出房间。','移出'))game.kick(p.id).catch(fail);}});
watch=new WatchRoom(game,toast);
const pieceNames={1:['','帅','仕','相','车','马','炮','兵'],'-1':['','将','士','象','车','马','炮','卒']};
function label(value){return value===99?'✦':value?pieceNames[Math.sign(value)][Math.abs(value)]:'';}
function element(tag,className,text){const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;}
function text(id,value){if($(id).textContent!==String(value))$(id).textContent=value;}
function toast(message){text('toast',message);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3500);}
function fail(error){toast(error.message||'操作未完成，请重试');}
async function act(action){sound.unlock();try{await game.action(action);}catch(e){fail(e);}}
function confirm(title,message,button='确认'){
  if(confirmResolve)confirmResolve(false);
  text('confirm-title',title);text('confirm-message',message);text('confirm-ok',button);
  if(!$('confirm-dialog').open)$('confirm-dialog').showModal();
  return new Promise(resolve=>confirmResolve=resolve);
}
function finishConfirm(value){$('confirm-dialog').close();const resolve=confirmResolve;confirmResolve=null;resolve?.(value);}
$('confirm-ok').onclick=()=>finishConfirm(true);$('confirm-cancel').onclick=()=>finishConfirm(false);
$('confirm-dialog').addEventListener('cancel',e=>{e.preventDefault();finishConfirm(false);});
document.querySelectorAll('.dialog-close').forEach(b=>b.onclick=()=>b.closest('dialog').close());
function network(){
  const milliseconds=value=>Math.round(Number(value||0)*10)/10;
  const connected=game.client.ready;$('network').classList.toggle('online',connected);
  let value=status;
  if(connected){
    const peers=game.room?.members.filter(p=>p.id!==game.self)||[];
    const direct=peers.filter(p=>game.memberConnection(p.id).kind==='direct');
    value=(direct.length?'P2P 可用 '+direct.length+'/'+peers.length+' · ':'')+'服务器'+(game.latency!==undefined?' '+milliseconds(game.latency)+' ms':'已连接');
  }
  if(connected&&game.client.compatibilityError)value=game.client.compatibilityError;
  text('status',value);$('network').title=value+'；成员行显示本机到各成员的往返延迟';renderMemberConnections();
}
function memberBadge(who){const badge=element('small','member-path');badge.dataset.memberPath=who;return badge;}
function renderMemberConnections(){for(const badge of document.querySelectorAll('[data-member-path]')){const value=game.memberConnection(badge.dataset.memberPath);if(badge.textContent!==value.text)badge.textContent=value.text;badge.dataset.path=value.kind;badge.title=value.title;}}
function render(){
  const r=game.room,connected=game.client.ready;
  if(passwordContext&&!game.current(passwordContext)){$('password-dialog').close();passwordContext='';}
  if(embyContext&&(!game.current(embyContext)||!game.host||r?.game!=='watch')){embyContext='';embyRequest++;posterAccess=null;posterCache.clear();$('emby-dialog').close();$('library-dialog').close();$('emby-user').value='';$('emby-password').value='';$('emby-share').checked=false;$('emby-items').replaceChildren();}
  if(r||!connected)lobbyVersion++;
  $('offline').hidden=connected||!!r;$('lobby').hidden=!connected||!!r;
  $('waiting').hidden=!r||r.status!=='waiting';
  $('chess').hidden=!r||r.game!=='chess'||r.status==='waiting';
  $('miner').hidden=!r||r.game!=='miner'||r.status==='waiting';
  document.body.classList.toggle('mine-active',!$('miner').hidden);
  $('watch').hidden=!r||r.game!=='watch';document.body.classList.toggle('watch-active',!$('watch').hidden);
  if(['miner','chess'].some(id=>$(id).hidden&&document.fullscreenElement===$(id))||($('watch').hidden&&document.fullscreenElement===$('watch-stage')))document.exitFullscreen().catch(()=>{});
  document.querySelectorAll('.room-password').forEach(b=>b.hidden=!game.host);
  $('reconnecting').hidden=connected||!r;text('offline-message',status);network();
  $('download-app').hidden=!!native;
  if(!r){view.setState(null);text('hello',game.nickname+'，欢迎回来');renderSave();return;}
  if(r.game==='miner')view.prepare();
  if(lastRoom!==r.roomId){lastRoom=r.roomId;$('toast').hidden=true;}
  if(lastRound!==r.round){selected=-1;boardKey='';lastMove=-1;lastRound=r.round;}
  if(r.status==='waiting'){view.setState(null);renderWaiting();}
  else if(r.game==='chess'){view.setState(null);renderChess();}
  else if(r.game==='miner')renderMine();else{view.setState(null);watch?.render();}
  renderMemberConnections();
}
function renderSave(){
  const save=storageGet('cyber.miner.save');$('continue-mine').hidden=!save||save.phase==='complete';
  if(save)text('save-summary','第 '+save.level+' / 1,000 关 · '+save.players.length+' 人冒险 · 积分 '+save.players.reduce((n,p)=>n+p.score,0));
}
function renderWaiting(){
  const r=game.room,me=r.members.find(p=>p.id===game.self);
  text('waiting-game',GAMES[r.game].name+' / 等候室');text('waiting-name',r.name);
  text('waiting-id','房间 '+r.roomId.slice(0,8)+' · '+r.members.length+'/'+r.capacity+' 人');
  const key=JSON.stringify([r.roomId,r.capacity,r.hostId,r.members,game.self]);
  if($('players').dataset.key!==key){
    $('players').dataset.key=key;$('players').replaceChildren();
    for(let i=0;i<r.capacity;i++){
      const p=r.members[i],card=element('div','player'+(!p?' vacant':''));
      card.append(element('span','avatar',p?(p.name||'友').slice(0,1):'+'),element('strong','',p?p.name+(p.id===game.self?'（你）':''):'空位'));
      card.append(element('small',p?.ready?'ready-badge':'',p?(p.id===r.hostId?'房主 · ':'')+(p.ready?'已准备':'未准备'):'等待朋友加入'));if(p)card.append(memberBadge(p.id));$('players').append(card);
    }
  }
  text('waiting-note',r.members.length<r.capacity?'还差 '+(r.capacity-r.members.length)+' 位朋友。大家准备后自动开始。':'人到齐啦，大家准备后自动开始。');
  $('ready').disabled=!game.client.ready;text('ready',me?.ready?'取消准备':'准备好了');
  $('time-settings').hidden=r.game!=='chess';
  document.querySelectorAll('[data-seconds]').forEach(b=>{b.classList.toggle('selected',+b.dataset.seconds===r.seconds);b.disabled=!game.host||!game.client.ready;});
  text('waiting-symbol',r.game==='chess'?'棋':'◆');
  text('waiting-guide-title',r.game==='chess'?'一翻一落，皆有机会':'各自淘金，一起冒险');
  text('waiting-guide',r.game==='chess'?'翻开暗棋决定阵营，移动明棋与对手过招。每一步，都有新的可能。':'每人操作一只爪子，抓到的宝物分别计分。每关结束用积分添置装备，共闯 1,000 关。');
}
function lobbyVisible(){return game.client.ready&&!game.room&&!game.background&&!document.hidden&&!$('lobby').hidden;}
async function refresh(){
  if(!lobbyVisible()||listing)return;listing=true;$('refresh').disabled=true;
  const version=lobbyVersion,generation=game.client.generation;
  try{const next=await game.list();if(lobbyVisible()&&version===lobbyVersion&&generation===game.client.generation){rooms=next;renderRooms();}}
  catch(e){if(lobbyVisible()&&version===lobbyVersion&&generation===game.client.generation)fail(e);}
  finally{listing=false;$('refresh').disabled=false;}
}
function renderRooms(){
  $('rooms').replaceChildren();const filter=$('room-filter').value,visible=rooms.filter(r=>filter==='all'||r.game===filter);
  $('empty').hidden=visible.length>0;
  for(const r of visible){
    const b=element('button','room-card'),copy=element('span');
    b.append(element('span','room-symbol '+r.game,r.game==='chess'?'棋':r.game==='watch'?'▶':'◆'));
    copy.append(element('strong','',(r.locked?'🔒 ':'')+r.name),element('small','',GAMES[r.game].name+' · '+r.roomId.slice(0,8)));
    b.append(copy,element('span','arrow','→'));
    b.onclick=async()=>{b.disabled=true;try{const password=r.locked?await passwordPrompt(false):'';if(password!==null)await game.join(r,r.game,false,password);}catch(e){fail(e);}finally{b.disabled=false;}};$('rooms').append(b);
  }
}
function openCreate(type,load=false){
  try{game.client.requireCompatible();}catch(e){fail(e);return;}
  $('create-game').value=type;$('load-save').checked=load;$('room-name').value=game.nickname+'的'+GAMES[type].name;
  $('create-password').value='';text('create-error','');createOptions();$('create-dialog').showModal();
}
function createOptions(){
  const mine=$('create-game').value==='miner',save=storageGet('cyber.miner.save');
  $('capacity-row').hidden=!mine;$('load-row').hidden=!mine||!save||save.phase==='complete';
  $('capacity').disabled=mine&&!!save&&$('load-save').checked;
  if($('capacity').disabled)$('capacity').value=String(save.players.length);
}
document.querySelectorAll('[data-create]').forEach(b=>b.onclick=()=>openCreate(b.dataset.create));
$('continue-mine').onclick=()=>openCreate('miner',true);
$('create-game').onchange=()=>{createOptions();$('room-name').value=game.nickname+'的'+GAMES[$('create-game').value].name;};
$('load-save').onchange=createOptions;
$('create-form').onsubmit=async e=>{
  e.preventDefault();const name=$('room-name').value.trim();if(!name){text('create-error','给房间起个名字吧');return;}
  $('create-submit').disabled=true;
  try{await game.create($('create-game').value,name,+$('capacity').value,$('create-game').value==='miner'&&$('load-save').checked,$('create-password').value);$('create-dialog').close();}
  catch(e){text('create-error',e.message);}finally{$('create-submit').disabled=false;}
};
$('refresh').onclick=refresh;$('room-filter').onchange=renderRooms;$('connect').onclick=()=>game.client.connect();
$('ready').onclick=()=>act({type:'READY',ready:!game.room?.members.find(p=>p.id===game.self)?.ready});
document.querySelectorAll('[data-seconds]').forEach(b=>b.onclick=()=>act({type:'TIME',seconds:+b.dataset.seconds}));
async function leave(){
  if(!game.room)return;
  const mine=game.room.game==='miner';
  if(!await confirm(game.host?'解散这个房间？':'离开房间？',game.host?(mine?'矿工进度会保存在你的设备。所有成员将返回大厅，下次可继续存档。':'房主退出后，房间立即解散。'):(mine?'游戏将暂停，进度由房主保留。':'进行中的对局会结束。'),'退出房间'))return;
  try{await game.leave();}catch(e){fail(e);}
}
document.querySelectorAll('.leave').forEach(b=>b.onclick=leave);
for(let i=0;i<32;i++){const b=element('button','piece');b.dataset.index=i;b.onclick=()=>chessClick(i);$('board').append(b);}
function renderChess(){
  const r=game.room,s=game.state;if(!s)return;
  const members=$('chess-members'),membersKey=JSON.stringify([r.hostId,r.members.map(p=>[p.id,p.name])]);if(members.dataset.key!==membersKey){members.dataset.key=membersKey;members.replaceChildren(...r.members.map(p=>{const card=element('div','member-connection');card.append(element('span','',p.name+(p.id===r.hostId?' · 房主':'')),memberBadge(p.id));return card;}));}
  const slot=r.members.findIndex(p=>p.id===game.self),color=s.colors[slot],myTurn=r.status==='playing'&&s.turn===slot;
  text('chess-title',r.name);text('turn-badge',r.status==='finished'?'本局结束':myTurn?'轮到你了':'对方回合');
  text('turn',r.status==='finished'?(r.result?.winnerId===game.self?'你赢了':'对方获胜'):(r.members[s.turn]?.name||'朋友')+'的回合');
  text('my-color',color===1?'你执红棋':color===-1?'你执黑棋':'首次翻棋决定红黑阵营');
  text('chess-hint',r.status==='finished'?r.result?.reason||'对局结束':myTurn?'点暗棋翻开，或选择己方明棋走子。':'耐心等一等，看看对手怎么走。');
  $('rematch').hidden=r.status!=='finished'||!game.host;
  if(r.status==='finished'&&resultSound!==r.round){resultSound=r.round;sound.play(r.result?.winnerId===game.self?'finish':'poop');}
  if(r.move!==lastMove){selected=-1;if(lastMove>=0&&r.move>lastMove)sound.play('rock');lastMove=r.move;}
  const key=JSON.stringify([s.board,s.lastFrom,s.lastTo,selected,myTurn,game.client.ready]);
  if(key!==boardKey){
    boardKey=key;[...$('board').children].forEach((b,i)=>{
      const p=s.board[i],was=b.dataset.value;b.textContent=label(p);b.dataset.value=p;
      b.className='piece '+(p===99?'dark':p===0?'empty':p>0?'red':'black')+(selected===i?' selected':'')+(s.lastTo===i?' last':'');
      b.disabled=!myTurn||!game.client.ready;b.setAttribute('aria-label','第 '+(i+1)+' 格，'+(p===99?'暗棋':p===0?'空格':(p>0?'红':'黑')+label(p)));
      if(view.motion&&was!==undefined&&was!==String(p)&&p!==0)b.animate([{transform:'scale(.75) rotateY(75deg)'},{transform:'scale(1) rotateY(0)'}],{duration:240,easing:'ease-out'});
    });
    for(const color of [1,-1]){
      const target=$(color===1?'red-captured':'black-captured');target.replaceChildren();
      for(let type=1;type<=7;type++){const n=s.captured.filter(p=>p===type*color).length,e=element('span',n?'lost':'',label(type*color));e.title=label(type*color)+'阵亡 '+n+' 枚';if(n)e.append(element('b','',n));target.append(e);}
    }
  }
  clock();
}
function chessClick(to){
  const r=game.room,s=game.state;if(!s||r.status!=='playing')return;sound.unlock();
  const p=s.board[to],slot=r.members.findIndex(p=>p.id===game.self),color=s.colors[slot];
  if(selected===to){selected=-1;renderChess();return;}
  if(p&&p!==99&&Math.sign(p)===color){selected=to;renderChess();return;}
  if(selected<0&&p!==99)return;
  const from=selected;selected=-1;act({type:'MOVE',from,to,move:r.move});renderChess();
}
$('rematch').onclick=()=>game.rematch();
function renderMine(){
  const r=game.room,s=game.state;if(!s)return;
  const p=s.players.find(p=>p.id===game.self);if(!p)return;
  $('miner').dataset.phase=s.phase;
  text('mine-biome',THEMES[Math.floor((s.level-1)/100)].name+' / 黄金矿工');
  text('mine-level','第 '+s.level.toLocaleString()+' / 1,000 关');
  const scoreKey=JSON.stringify(s.players.map(p=>[p.id,p.name,p.score,p.cash,p.round]));
  if($('mine-scores').dataset.key!==scoreKey){
    $('mine-scores').dataset.key=scoreKey;$('mine-scores').replaceChildren();
    for(const player of s.players){const card=element('div','score-card'+(player.id===game.self?' mine':'')),name=element('strong');
      name.append(element('i'),document.createTextNode(player.name+(player.id===game.self?' · 你':'')));
      card.append(name,element('span','score',player.score.toLocaleString()),element('small','','本关 '+player.round+' · 可用 '+player.cash),memberBadge(player.id));$('mine-scores').append(card);
    }
  }
  text('mine-target','团队目标 '+s.target+' · 本关已获 '+s.players.reduce((n,p)=>n+p.round,0));
  text('mine-phase',s.paused?'已暂停':s.phase==='shop'?'倒计时结束自动出发':s.phase==='complete'?'千关达成':'各自淘金');
  text('mine-clock-label',s.phase==='shop'?'补给倒计时':'剩余时间');
  $('drop').disabled=!game.client.ready||s.paused||s.phase!=='playing'||p.claw.mode!=='swing'||p.claw.stun>0;
  $('mine-canvas').setAttribute('aria-disabled',String($('drop').disabled));
  $('bomb').disabled=!game.client.ready||s.paused||s.phase!=='playing'||p.claw.item<0||!p.inventory.dynamite;
  text('bomb-count','×'+(p.inventory.dynamite||0));
  $('pause').hidden=!game.host||s.phase==='complete';text('pause',s.paused?'继续冒险':'暂停');
  $('save').hidden=!game.host;text('mine-help','点击矿场或按空格放爪 · '+(game.host?'进度自动保存':'进度由房主保存')+' · 爆破键 B');
  $('shop').hidden=s.phase!=='shop';$('mine-complete').hidden=s.phase!=='complete';
  if(s.phase==='shop')renderShop(s,p);
  view.setState(s,game.self);clock();
}
function renderShop(s,p){
  text('shop-summary',s.paused?'补给已暂停，等待房主继续':s.roundBonus?'目标达成，每人 +150 积分':'20 秒补给后自动出发');
  text('shop-wallet','可用 '+p.cash+' 积分');
  const key=JSON.stringify([p.cash,p.reel,p.inventory,p.purchased,p.shopReady,s.paused,game.client.ready]);
  if($('shop-items').dataset.key!==key){
    $('shop-items').dataset.key=key;$('shop-items').replaceChildren();
    for(const item of SHOP){
      const price=item.price*(item.permanent?p.reel+1:1),max=item.permanent&&p.reel>=5,bought=!item.stack&&!item.permanent&&p.purchased[item.id];
      const b=element('button','shop-item');b.dataset.item=item.id;b.title=item.name+'：'+item.description;
      b.append(element('span','shop-icon',item.icon),element('strong','',item.name),element('p','',item.description),element('span','price',max?'已满级':bought?'已购入':price+' 积分'+(item.permanent?' · '+p.reel+'/5':'')));
      b.disabled=!game.client.ready||s.paused||p.shopReady||max||bought||p.cash<price||(item.stack&&p.inventory.dynamite>=9);
      b.onclick=()=>act({type:'BUY',item:item.id});$('shop-items').append(b);
    }
  }
  text('shop-ready-status',s.players.filter(p=>p.shopReady).length+'/'+s.players.length+' 人已就绪');
  text('shop-ready',p.shopReady?'再买一点':'我买好了');$('shop-ready').disabled=!game.client.ready||s.paused;
  $('next-level').hidden=!game.host;$('next-level').disabled=!s.players.every(p=>p.shopReady)||!game.client.ready||s.paused;
}
function clock(){
  if(!game.state||!game.room)return;
  const s=game.state,elapsed=game.client.ready?Math.max(0,performance.now()-game.stateAt):0;
  if(game.room.game==='chess'){
    const ms=s.remaining<0?-1:Math.max(0,s.remaining-(game.room.status==='playing'?elapsed:0)),sec=Math.ceil(ms/1000);
    text('clock',ms<0?'不限时':String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0'));
  }else if(game.room.game==='miner')text('mine-clock',Math.ceil(Math.max(0,(s.phase==='shop'?(s.shopTime??20):s.time)-(['playing','shop'].includes(s.phase)&&!s.paused?elapsed/1000:0))));
}
$('drop').onclick=()=>act({type:'DROP'});$('bomb').onclick=()=>act({type:'BOMB'});
let dropping=false;
async function dropFromStage(){
  if(dropping||$('miner').hidden||$('drop').disabled||document.querySelector('dialog[open]'))return;
  dropping=true;try{await act({type:'DROP'});}finally{dropping=false;}
}
// Only the play surface releases a claw: buttons, scrolling and cancelled touches do not.
let minePointer;
$('mine-canvas').addEventListener('pointerdown',e=>{if(e.isPrimary&&e.button===0)minePointer={id:e.pointerId,x:e.clientX,y:e.clientY};});
$('mine-canvas').addEventListener('pointercancel',()=>minePointer=null);
$('mine-canvas').addEventListener('pointerup',e=>{const p=minePointer;minePointer=null;if(p?.id===e.pointerId&&Math.hypot(e.clientX-p.x,e.clientY-p.y)<12){e.preventDefault();dropFromStage();}});
$('mine-canvas').addEventListener('keydown',e=>{if(e.code==='Enter'){e.preventDefault();if(!e.repeat)dropFromStage();}});
$('mine-canvas').addEventListener('click',e=>{if(e.detail===0)dropFromStage();});
const gameFullscreen={miner:'mine-fullscreen',chess:'chess-fullscreen'};let previousFullscreen;
for(const [stage,button] of Object.entries(gameFullscreen))$(button).onclick=()=>{if(document.fullscreenElement===$(stage))document.exitFullscreen().catch(fail);else if($(stage).requestFullscreen)$(stage).requestFullscreen().catch(fail);else toast('此浏览器暂不支持全屏');};
document.addEventListener('fullscreenchange',()=>{const active=document.fullscreenElement?.id;for(const [stage,button] of Object.entries(gameFullscreen)){const full=active===stage;text(button,full?'退出全屏':'全屏');$(button).setAttribute('aria-pressed',String(full));}if(previousFullscreen&&!active){const stage=previousFullscreen;requestAnimationFrame(()=>{const target=$(stage).hidden?document.querySelector('[data-create="'+stage+'"]'):$(gameFullscreen[stage]);target?.focus({preventScroll:true});});}previousFullscreen=gameFullscreen[active]?active:null;});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&gameFullscreen[document.fullscreenElement?.id]&&!document.querySelector('dialog[open]')){e.preventDefault();document.exitFullscreen().catch(fail);}});
$('pause').onclick=()=>act({type:'PAUSE'});$('save').onclick=()=>game.saveMine();
$('shop-ready').onclick=()=>act({type:'SHOP_READY',ready:!game.state?.players.find(p=>p.id===game.self)?.shopReady});
$('next-level').onclick=()=>act({type:'NEXT'});
document.addEventListener('keydown',e=>{
  if(e.repeat||document.querySelector('dialog[open]')||/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)||game.room?.game!=='miner')return;
  if(e.code==='Space'){e.preventDefault();if(!$('drop').disabled)$('drop').click();}
  if(e.code==='KeyB'){e.preventDefault();if(!$('bomb').disabled)$('bomb').click();}
});
const mineRules='2–3 位玩家，各自操作一只爪子。大家准备后开局。\n\n点击矿场、点「放下爪子」或空格键出钩，抓到物品后自动收钩。每个人抓到的东西单独计分；可用积分用于商店购买，累计分数不会因购物减少。\n\n金块越大越值钱，也越重；钻石、小仓鼠和补给箱各有惊喜。石头比较重，污染废料扣 120 分。抓到爆破装置会连锁爆炸，炸毁附近物品。自带炸药可以炸掉爪上重物，按 B 或点爆破按钮使用。\n\n抓完或时间结束后进入商店。团队达到本关目标，每人额外加 150 分。商店在矿场内开放 20 秒，到期自动进入下一关。每人买好后点「我买好了」，房主也可提前出发；暂停会冻结倒计时。增益道具持续下一关，卷扬机升级永久生效，炸药可保留。\n\n共 1,000 关、10 个主题矿区；地图由种子生成。房主每 5 秒自动保存，可手动保存。房主切到后台会暂停，退出即解散房间。继续存档需凑齐原来的人数，按加入顺序领取原座位的积分和装备。\n\nApp 之间优先 UDP 直连，不通自动由服务器转发。网页使用服务器转发，可与 App 一起玩。';
async function rules(){
  const mine=game.room?.game==='miner';text('rules-title',mine?'黄金矿工 · 怎么玩':'翻棋 · 已确认规则');
  text('rules-body',mine?mineRules:'正在加载…');$('rules-dialog').showModal();
  if(!mine)try{const r=await fetch('./rules.txt');text('rules-body',await r.text());}catch{text('rules-body','规则加载失败，请稍后重试。');}
}
$('rules-open').onclick=rules;document.querySelectorAll('.rules-link').forEach(b=>b.onclick=rules);
$('settings-open').onclick=()=>{
  const s=settings();$('nickname').value=storageGet('cyber.nickname','');$('sound').checked=sound.enabled;$('motion').checked=view.motion;
  $('native-settings').hidden=!native;text('server-address',native?'默认 TCP / fqgame.tdcode.tech / 8888':location.origin);
  if(native){$('server-mode').value=s.transport;$('server-host').value=s.host;$('server-port').value=s.port;}
  $('settings-dialog').showModal();
};
$('restore-default').onclick=()=>{$('server-mode').value='TCP';$('server-host').value='fqgame.tdcode.tech';$('server-port').value=8888;};
$('settings-save').onclick=async()=>{
  const next={nickname:$('nickname').value.trim().slice(0,24),sound:$('sound').checked,motion:$('motion').checked};
  let changed=false;
  if(native){
    Object.assign(next,{transport:$('server-mode').value,host:$('server-host').value.trim(),port:+$('server-port').value});
    if(!next.host||next.host.length>253||/[\/\\\s?#]/.test(next.host)||!Number.isInteger(next.port)||next.port<1||next.port>65535){toast('请填写有效地址和端口');return;}
    const old=settings();changed=next.host!==old.host||next.port!==old.port||next.transport!==old.transport;
    if(changed&&game.room){if(!await confirm('切换服务器？','当前房间将退出；房主退出会解散房间，矿工进度会保存。','保存并切换'))return;try{await game.leave();}catch(e){fail(e);return;}}
    if(changed)game.client.disconnect();await nativeCall('configure',JSON.stringify(next));
  }
  storageSet('cyber.nickname',next.nickname);storageSet('cyber.sound',next.sound);storageSet('cyber.motion',next.motion);
  sound.enabled=next.sound;view.motion=next.motion;$('settings-dialog').close();
  if(game.host){game.room.members[0].name=game.nickname;game.publish();}
  if(changed){game.reset();game.client.connect();}render();toast('设置已保存');
};
$('check-update').onclick=()=>native?.checkUpdate();$('install-update').onclick=()=>native?.installUpdate();
function nativeEvent(e){if(e.type==='update'){text('update-status',e.status);text('version',e.version||initial.version||$('version').textContent);$('check-update').disabled=e.busy;$('install-update').hidden=!e.ready;}}
window.cyberBack=async()=>{
  const dialog=document.querySelector('dialog[open]');if(dialog){if(dialog.id==='confirm-dialog')finishConfirm(false);else dialog.close();return;}
  if(game.room)await leave();else if(native)native.exitApp();
};
window.cyberDisconnect=async()=>{try{if(game.room)await game.leave();}catch{game.checkpoint();}game.client.disconnect();render();};
document.addEventListener('visibilitychange',()=>{
  if(document.hidden)lobbyVersion++;
  game.background=document.hidden;watch.event({type:document.hidden?'background':'foreground'}).catch(fail);
  if(document.hidden&&game.host&&game.room?.game==='miner'&&game.engine){game.engine.paused=true;game.saveMine(false);game.publish();}
  else if(!document.hidden){render();if(game.room&&!game.host&&game.client.ready)act({type:'SYNC'});else refresh();}
});
window.addEventListener('pagehide',()=>{watch.saveHost();if(game.host&&game.room?.game==='miner')game.saveMine(false);game.checkpoint();});
document.addEventListener('pointerdown',()=>sound.unlock(),{once:true});
$('download-app').hidden=!!native;text('version',initial.version||$('version').textContent);
window.addEventListener('native-room',event=>{const type=event.detail.type;if(type==='background'){lobbyVersion++;view.suspended=true;}else if(type==='foreground'){view.suspended=false;view.wake();}});
setInterval(clock,200);setInterval(refresh,5000);
let passwordResolve;
function passwordPrompt(edit){
  passwordContext=edit?game.context():'';
  if(passwordResolve)passwordResolve(null);text('password-title',edit?'设置房间密码':'输入房间密码');text('password-hint',edit?'留空取消密码，修改不影响现有成员。':'房主确认密码后即可加入。');$('password-value').value='';$('password-dialog').showModal();return new Promise(resolve=>passwordResolve=resolve);
}
$('password-form').onsubmit=e=>{e.preventDefault();const resolve=passwordResolve;passwordResolve=null;const value=$('password-value').value;$('password-dialog').close();resolve?.(value);};
$('password-dialog').addEventListener('close',()=>{passwordResolve?.(null);passwordResolve=null;passwordContext='';$('password-value').value='';});
document.querySelectorAll('.room-password').forEach(b=>b.onclick=async()=>{const context=game.context(),password=await passwordPrompt(true);if(password!==null&&game.current(context))game.setPassword(password).catch(fail);});
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
$('watch-fullscreen').onclick=()=>{const stage=$('watch-stage');if(document.fullscreenElement)document.exitFullscreen?.();else stage.requestFullscreen?.().catch(fail);};
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

if(!native)fetch('/api/desktop/version').then(r=>r.json()).then(v=>{$('download-desktop').hidden=!v.available;}).catch(()=>{});
installChoices();render();game.client.connect();
