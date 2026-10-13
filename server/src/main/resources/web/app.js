import {GameRoom,GAMES} from './room.js';
import {native,settings,storageGet,storageSet} from './transport.js';
import {SHOP,THEMES} from './miner.js';
import {MinerView,Sound} from './miner-view.js';
const $=id=>document.getElementById(id),sound=new Sound(),view=new MinerView($('mine-canvas'),sound);
const initial=settings();
if(native&&storageGet('cyber.preferences.migrated')!==true){
  storageSet('cyber.nickname',initial.nickname||'');storageSet('cyber.sound',initial.sound!==false);storageSet('cyber.motion',initial.motion!==false);storageSet('cyber.preferences.migrated',true);
}
sound.enabled=storageGet('cyber.sound',true);view.motion=storageGet('cyber.motion',!matchMedia('(prefers-reduced-motion: reduce)').matches);
let status='正在连接…',rooms=[],listing=false,selected=-1,boardKey='',lastMove=-1,lastRound='',lastRoom='',toastTimer,confirmResolve,resultSound='';
const game=new GameRoom({changed:render,lobby:refresh,notice:toast,status:s=>{status=s;render();},network:network,native:nativeEvent});
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
  const connected=game.client.ready;$('network').classList.toggle('online',connected);
  let value=status;
  if(connected){
    const peers=game.room?.members.filter(p=>p.id!==game.self)||[];
    if(peers.length){const direct=peers.filter(p=>game.client.peerReady.has(p.id));
      value=direct.length?'直连 '+direct.length+'/'+peers.length+' · '+Math.max(...direct.map(p=>game.client.peerLatency.get(p.id)||0))+' ms':'服务器转发'+(game.latency!==undefined?' · '+game.latency+' ms':'');
    }else value='已连接'+(game.latency!==undefined?' · '+game.latency+' ms':'');
  }
  text('status',value);$('network').title=value;
}
function render(){
  const r=game.room,connected=game.client.ready;
  $('offline').hidden=connected||!!r;$('lobby').hidden=!connected||!!r;
  $('waiting').hidden=!r||r.status!=='waiting';
  $('chess').hidden=!r||r.game!=='chess'||r.status==='waiting';
  $('miner').hidden=!r||r.game!=='miner'||r.status==='waiting';
  $('reconnecting').hidden=connected||!r;text('offline-message',status);network();
  $('download-app').hidden=!!native;
  if(!r){view.setState(null);text('hello',game.nickname+'，欢迎回来');renderSave();return;}
  if(lastRoom!==r.roomId){lastRoom=r.roomId;$('toast').hidden=true;}
  if(lastRound!==r.round){selected=-1;boardKey='';lastMove=-1;lastRound=r.round;}
  if(r.status==='waiting'){view.setState(null);renderWaiting();}
  else if(r.game==='chess'){view.setState(null);renderChess();}
  else renderMine();
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
      card.append(element('small',p?.ready?'ready-badge':'',p?(p.id===r.hostId?'房主 · ':'')+(p.ready?'已准备':'未准备'):'等待朋友加入'));$('players').append(card);
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
async function refresh(){
  if(!game.client.ready||game.room||listing)return;listing=true;$('refresh').disabled=true;
  try{rooms=await game.list();renderRooms();}catch(e){fail(e);}finally{listing=false;$('refresh').disabled=false;}
}
function renderRooms(){
  $('rooms').replaceChildren();const filter=$('room-filter').value,visible=rooms.filter(r=>filter==='all'||r.game===filter);
  $('empty').hidden=visible.length>0;
  for(const r of visible){
    const b=element('button','room-card'),copy=element('span');
    b.append(element('span','room-symbol '+r.game,r.game==='chess'?'棋':'◆'));
    copy.append(element('strong','',r.name),element('small','',GAMES[r.game].name+' · '+r.roomId.slice(0,8)));
    b.append(copy,element('span','arrow','→'));
    b.onclick=async()=>{b.disabled=true;try{await game.join(r);}catch(e){fail(e);}finally{b.disabled=false;}};$('rooms').append(b);
  }
}
function openCreate(type,load=false){
  $('create-game').value=type;$('load-save').checked=load;$('room-name').value=game.nickname+'的'+GAMES[type].name;
  text('create-error','');createOptions();$('create-dialog').showModal();
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
  try{await game.create($('create-game').value,name,+$('capacity').value,$('create-game').value==='miner'&&$('load-save').checked);$('create-dialog').close();}
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
  text('mine-biome',THEMES[Math.floor((s.level-1)/100)].name+' / 黄金矿工');
  text('mine-level','第 '+s.level.toLocaleString()+' / 1,000 关');
  const scoreKey=JSON.stringify(s.players.map(p=>[p.id,p.name,p.score,p.cash,p.round]));
  if($('mine-scores').dataset.key!==scoreKey){
    $('mine-scores').dataset.key=scoreKey;$('mine-scores').replaceChildren();
    for(const player of s.players){const card=element('div','score-card'+(player.id===game.self?' mine':'')),name=element('strong');
      name.append(element('i'),document.createTextNode(player.name+(player.id===game.self?' · 你':'')));
      card.append(name,element('span','score',player.score.toLocaleString()),element('small','','本关 '+player.round+' · 可用 '+player.cash));$('mine-scores').append(card);
    }
  }
  text('mine-target','团队目标 '+s.target+' · 本关已获 '+s.players.reduce((n,p)=>n+p.round,0));
  text('mine-phase',s.phase==='shop'?'补给时间':s.phase==='complete'?'千关达成':s.paused?'已暂停':'各自淘金');
  $('drop').disabled=!game.client.ready||s.paused||s.phase!=='playing'||p.claw.mode!=='swing'||p.claw.stun>0;
  $('bomb').disabled=!game.client.ready||s.paused||s.phase!=='playing'||p.claw.item<0||!p.inventory.dynamite;
  text('bomb-count','×'+(p.inventory.dynamite||0));
  $('pause').hidden=!game.host||s.phase!=='playing';text('pause',s.paused?'继续冒险':'暂停');
  $('save').hidden=!game.host;text('mine-help',game.host?'每人操作自己的爪子 · 进度每 5 秒自动保存，也可手动保存':'每人操作自己的爪子 · 爆破键 B · 进度由房主保存');
  $('shop').hidden=s.phase!=='shop';$('mine-complete').hidden=s.phase!=='complete';
  if(s.phase==='shop')renderShop(s,p);
  view.setState(s,game.self);clock();
}
function renderShop(s,p){
  text('shop-summary',s.roundBonus?'团队目标达成！每人额外获得 150 积分。':'这一关告一段落，挑些装备再出发。');
  text('shop-wallet','可用 '+p.cash+' 积分');
  const key=JSON.stringify([p.cash,p.reel,p.inventory,p.purchased,p.shopReady,game.client.ready]);
  if($('shop-items').dataset.key!==key){
    $('shop-items').dataset.key=key;$('shop-items').replaceChildren();
    for(const item of SHOP){
      const price=item.price*(item.permanent?p.reel+1:1),max=item.permanent&&p.reel>=5,bought=!item.stack&&!item.permanent&&p.purchased[item.id];
      const b=element('button','shop-item');b.dataset.item=item.id;
      b.append(element('span','shop-icon',item.icon),element('strong','',item.name+(item.permanent?' · '+p.reel+'/5':'')),element('p','',item.description),element('span','price',max?'已满级':bought?'已购入':price+' 积分'));
      b.disabled=!game.client.ready||p.shopReady||max||bought||p.cash<price||(item.stack&&p.inventory.dynamite>=9);
      b.onclick=()=>act({type:'BUY',item:item.id});$('shop-items').append(b);
    }
  }
  text('shop-ready-status',s.players.filter(p=>p.shopReady).length+'/'+s.players.length+' 人已准备出发');
  text('shop-ready',p.shopReady?'再买一点':'我买好了');$('shop-ready').disabled=!game.client.ready;
  $('next-level').hidden=!game.host;$('next-level').disabled=!s.players.every(p=>p.shopReady)||!game.client.ready;
}
function clock(){
  if(!game.state||!game.room)return;
  const s=game.state,elapsed=game.client.ready?Math.max(0,performance.now()-game.stateAt):0;
  if(game.room.game==='chess'){
    const ms=s.remaining<0?-1:Math.max(0,s.remaining-(game.room.status==='playing'?elapsed:0)),sec=Math.ceil(ms/1000);
    text('clock',ms<0?'不限时':String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0'));
  }else text('mine-clock',Math.ceil(Math.max(0,s.time-(s.phase==='playing'&&!s.paused?elapsed/1000:0))));
}
$('drop').onclick=()=>act({type:'DROP'});$('bomb').onclick=()=>act({type:'BOMB'});
$('pause').onclick=()=>act({type:'PAUSE'});$('save').onclick=()=>game.saveMine();
$('shop-ready').onclick=()=>act({type:'SHOP_READY',ready:!game.state?.players.find(p=>p.id===game.self)?.shopReady});
$('next-level').onclick=()=>act({type:'NEXT'});
document.addEventListener('keydown',e=>{
  if(e.repeat||document.querySelector('dialog[open]')||/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)||game.room?.game!=='miner')return;
  if(e.code==='Space'){e.preventDefault();if(!$('drop').disabled)$('drop').click();}
  if(e.code==='KeyB'){e.preventDefault();if(!$('bomb').disabled)$('bomb').click();}
});
const mineRules='2–3 位玩家，各自操作一只爪子。大家准备后开局。\n\n点「放下爪子」或空格键出钩，抓到物品后自动收钩。每个人抓到的东西单独计分；可用积分用于商店购买，累计分数不会因购物减少。\n\n金块越大越值钱，也越重；钻石、小仓鼠和钱袋各有惊喜。石头比较重，狗屎扣 120 分。抓到地下 TNT 会连锁爆炸，炸毁附近物品。自带炸药可以炸掉爪上重物，按 B 或点爆破按钮使用。\n\n抓完或时间结束后进入商店。团队达到本关目标，每人额外加 150 分。每人买好后点「我买好了」，房主开始下一关。增益道具持续下一关，卷扬机升级永久生效，炸药可保留。\n\n共 1,000 关、10 个主题矿区；地图由种子生成。房主每 5 秒自动保存，可手动保存。房主切到后台会暂停，退出即解散房间。继续存档需凑齐原来的人数，按加入顺序领取原座位的积分和装备。\n\nApp 之间优先 UDP 直连，不通自动由服务器转发。网页使用服务器转发，可与 App 一起玩。';
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
    if(changed)game.client.disconnect();native.configure(JSON.stringify(next));
  }
  storageSet('cyber.nickname',next.nickname);storageSet('cyber.sound',next.sound);storageSet('cyber.motion',next.motion);
  sound.enabled=next.sound;view.motion=next.motion;$('settings-dialog').close();
  if(game.host){game.room.members[0].name=game.nickname;game.publish();}
  if(changed){game.reset();game.client.connect();}render();toast('设置已保存');
};
$('check-update').onclick=()=>native?.checkUpdate();$('install-update').onclick=()=>native?.installUpdate();
function nativeEvent(e){if(e.type==='update'){text('update-status',e.status);text('version',e.version||'0.7.1');$('check-update').disabled=e.busy;$('install-update').hidden=!e.ready;}}
window.cyberBack=async()=>{
  const dialog=document.querySelector('dialog[open]');if(dialog){if(dialog.id==='confirm-dialog')finishConfirm(false);else dialog.close();return;}
  if(game.room)await leave();else if(native)native.exitApp();
};
window.cyberDisconnect=async()=>{try{if(game.room)await game.leave();}catch{game.checkpoint();}game.client.disconnect();render();};
document.addEventListener('visibilitychange',()=>{
  if(document.hidden&&game.host&&game.room?.game==='miner'&&game.engine){game.engine.paused=true;game.saveMine(false);game.publish();}
  else if(!document.hidden){render();if(game.room&&!game.host&&game.client.ready)act({type:'SYNC'});else refresh();}
});
window.addEventListener('pagehide',()=>{if(game.host&&game.room?.game==='miner')game.saveMine(false);game.checkpoint();});
document.addEventListener('pointerdown',()=>sound.unlock(),{once:true});
$('download-app').hidden=!!native;text('version',initial.version||'0.7.1');
setInterval(clock,200);setInterval(()=>{if(!document.hidden)refresh();},10000);
render();game.client.connect();
