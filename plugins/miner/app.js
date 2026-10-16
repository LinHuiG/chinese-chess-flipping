import {$,text,element,toast,fail,confirm,mount,memberBadge,fullscreen} from '../../plugin_sdk/ui.js';
import {native,nativeCall,storageGet,storageSet} from '../../plugin_sdk/transport.js';
import {rules} from './rules.js';
import {SHOP,THEMES} from './miner.js';
import {MinerView} from './miner-view.js';
import {Sound} from '../../plugin_sdk/sound.js';
const sound=new Sound(),view=new MinerView($('mine-canvas'),sound);sound.enabled=storageGet('cyber.sound',true);view.motion=storageGet('cyber.motion',true);
const game=mount(rules,{render(){const active=game.room?.status!=='waiting';document.body.classList.toggle('mine-active',active);if(active)renderMine();else view.setState(null);},native(e){view.suspended=e.type==='background';if(e.type==='foreground')view.wake();}});
async function act(a){sound.unlock();try{await game.action(a);}catch(e){fail(e);}}
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
function clock(){if(!game.state||!game.room)return;const s=game.state,elapsed=game.client.ready?Math.max(0,performance.now()-game.stateAt):0;text('mine-clock',Math.ceil(Math.max(0,(s.phase==='shop'?(s.shopTime??20):s.time)-(['playing','shop'].includes(s.phase)&&!s.paused?elapsed/1000:0))));}
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
fullscreen('miner','mine-fullscreen');
$('pause').onclick=()=>act({type:'PAUSE'});$('save').onclick=()=>game.saveProgress();
$('shop-ready').onclick=()=>act({type:'SHOP_READY',ready:!game.state?.players.find(p=>p.id===game.self)?.shopReady});
$('next-level').onclick=()=>act({type:'NEXT'});
document.addEventListener('keydown',e=>{
  if(e.repeat||document.querySelector('dialog[open]')||/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)||game.room?.game!=='miner')return;
  if(e.code==='Space'){e.preventDefault();if(!$('drop').disabled)$('drop').click();}
  if(e.code==='KeyB'){e.preventDefault();if(!$('bomb').disabled)$('bomb').click();}
});

setInterval(clock,200);
