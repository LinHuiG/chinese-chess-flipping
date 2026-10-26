import {$,text,element,toast,fail,confirm,mount,memberBadge,fullscreen} from '../../plugin_sdk/ui.js';
import {storageGet} from '../../plugin_sdk/transport.js';
import {rules} from './rules.js';
import {Sound} from '../../plugin_sdk/sound.js';
const sound=new Sound(),view={motion:storageGet('cyber.motion',true)};sound.enabled=storageGet('cyber.sound',true);
let selected=-1,boardKey='',lastMove=-1,resultSound='';
const game=mount(rules,{timeSettings:true,round(){selected=-1;boardKey='';lastMove=-1;},render(){const active=!!game.room&&game.room.status!=='waiting';document.body.classList.toggle('chess-active',active);syncControls();if(active)renderChess();}});
async function act(a){const round=game.room?.round;sound.unlock();try{await game.action(a);return game.room?.round===round;}catch(e){if(game.room?.round===round)fail(e);return false;}}
const pieceNames={1:['','帅','仕','相','車','马','炮','兵'],'-1':['','将','士','象','車','马','炮','卒']};
function label(value){return value===99?'✦':value?pieceNames[Math.sign(value)][Math.abs(value)]:'';}
for(let i=0;i<32;i++){const b=element('button','piece');b.type='button';b.dataset.index=i;b.append(element('span','piece-face'));b.onclick=()=>chessClick(i);$('board').append(b);}
// The frame uses 24px, with two 24px capture rails and two 8px gaps.
new ResizeObserver(()=>{const wrap=$('board').parentElement,cell=Math.max(0,Math.min(84,(wrap.clientWidth-88)/4,(wrap.clientHeight-24)/8));$('chess').style.setProperty('--chess-cell',cell+'px');}).observe($('board').parentElement);
function renderChess(){
  const r=game.room,s=game.state;if(!s)return;
  const members=$('chess-members'),membersKey=JSON.stringify([r.hostId,r.members.map(p=>[p.id,p.name])]);if(members.dataset.key!==membersKey){members.dataset.key=membersKey;members.replaceChildren(...r.members.map(p=>{const card=element('div','member-connection'),name=element('span','',p.name+(p.id===game.self?' · 你':''));name.title=p.name+(p.id===r.hostId?' · 房主':'');card.append(name,memberBadge(p.id));return card;}));}
  const slot=r.members.findIndex(p=>p.id===game.self),color=s.colors[slot],myTurn=r.status==='playing'&&s.turn===slot;
  text('chess-title',r.name);$('chess-title').title=r.name;
  text('turn',r.status==='finished'?(r.result?.draw?'和棋':r.result?.winnerId===game.self?'你赢了':'对方获胜'):myTurn?'轮到你':'对方回合');
  $('turn').title=r.status==='finished'?r.result?.reason||'对局结束':(r.members[s.turn]?.name||'朋友')+'的回合';
  text('my-color',color===1?'你执红棋':color===-1?'你执黑棋':'翻棋定色');
  $('my-color').dataset.color=color===1?'red':color===-1?'black':'';
  $('rematch').hidden=r.status!=='finished'||!game.host;
  if(r.status==='finished'&&resultSound!==r.round){resultSound=r.round;sound.play(r.result?.draw||r.result?.winnerId===game.self?'finish':'poop');}
  const nextMove=r.move===lastMove+1&&lastMove>=0,motion=view.motion&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(r.move!==lastMove){selected=-1;if(lastMove>=0&&r.move>lastMove)sound.play('rock');lastMove=r.move;}
  const key=JSON.stringify([s.board,s.lastFrom,s.lastTo,selected,myTurn,game.client.ready]);
  if(key!==boardKey){
    boardKey=key;const cells=[...$('board').children],source=cells[s.lastFrom],target=cells[s.lastTo],moving=motion&&nextMove&&source&&target&&s.board[s.lastTo]!==0&&source.dataset.value===String(s.board[s.lastTo])&&source.dataset.value!=='99',origin=moving?source.firstElementChild.getBoundingClientRect():null;
    cells.forEach((b,i)=>{
      const p=s.board[i],was=b.dataset.value;b.firstElementChild.textContent=label(p);b.dataset.value=p;
      b.firstElementChild.getAnimations().forEach(a=>a.cancel());
      b.className='piece '+(p===99?'dark':p===0?'empty':p>0?'red':'black')+(selected===i?' selected':'')+(s.lastTo===i?' last':'')+(s.lastFrom===i?' from':'');
      b.setAttribute('aria-pressed',String(selected===i));
      b.disabled=!myTurn||!game.client.ready;b.setAttribute('aria-label','第 '+(i+1)+' 格，'+(p===99?'暗棋':p===0?'空格':(p>0?'红':'黑')+label(p)));
      if(motion&&nextMove&&was==='99'&&p!==99&&p!==0&&!(moving&&i===s.lastTo))b.firstElementChild.animate([{transform:'scale(.75) rotateY(75deg)'},{transform:'scale(1) rotateY(0)'}],{duration:240,easing:'ease-out'});
    });
    if(moving){const face=target.firstElementChild,dest=face.getBoundingClientRect();target.classList.add('moving');const animation=face.animate([{transform:`translate(${origin.left-dest.left}px,${origin.top-dest.top}px)`},{transform:'translate(0,0)'}],{duration:280,easing:'cubic-bezier(.22,.61,.36,1)'});animation.onfinish=()=>target.classList.remove('moving');}
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
const menu=$('chess-menu-dialog'),drawDialog=$('chess-draw-dialog');let replyingTo=null,ownOffer=null;
function syncControls(){
  const r=game.room,playing=r?.status==='playing',offer=r?.drawOffer,slot=r?.members.findIndex(p=>p.id===game.self);
  if(!offer&&ownOffer&&playing&&r.round===ownOffer.round&&r.move===ownOffer.move)toast('对方选择继续对局');
  ownOffer=offer?.from===game.self?{round:r.round,move:r.move}:null;
  $('chess-surrender').disabled=!playing||!game.client.ready;
  $('chess-offer-draw').disabled=!playing||!game.client.ready||!!offer||r?.drawOfferedAt?.[slot]===r?.move;
  text('chess-offer-draw',offer?.from===game.self?'已请求，等待对方':r?.drawOfferedAt?.[slot]===r?.move?'本步已请求和棋':'请求和棋');
  if(!playing){menu.close();drawDialog.close();return;}
  if(offer&&offer.from!==game.self&&game.client.ready){if(!drawDialog.open&&!$('confirm-dialog').open){menu.close();drawDialog.showModal();}}else drawDialog.close();
  $('chess-accept-draw').disabled=$('chess-decline-draw').disabled=!game.client.ready||(replyingTo?.round===r.round&&replyingTo?.id===offer?.id);
}
$('chess-menu').onclick=()=>menu.showModal();
menu.addEventListener('click',e=>{if(e.target.closest('.rules-link'))menu.close();},true);
$('chess-offer-draw').onclick=async()=>{menu.close();if(await act({type:'DRAW_OFFER'})&&game.room?.status==='playing')toast('已发出和棋请求');};
$('chess-surrender').onclick=async()=>{const round=game.room?.round;menu.close();if(await confirm('确认投降？','投降后本局判负，双方仍留在房间。','投降'))if(game.room?.round===round&&game.room.status==='playing')act({type:'SURRENDER'});};
async function replyDraw(accept){const r=game.room,offer=r?.drawOffer;if(!game.client.ready||!offer||offer.from===game.self||(replyingTo?.round===r.round&&replyingTo?.id===offer.id))return;const reply=replyingTo={round:r.round,id:offer.id};syncControls();await act({type:'DRAW_REPLY',offer:offer.id,accept});if(replyingTo===reply)replyingTo=null;syncControls();}
$('chess-accept-draw').onclick=()=>replyDraw(true);$('chess-decline-draw').onclick=()=>replyDraw(false);
drawDialog.addEventListener('cancel',e=>{e.preventDefault();replyDraw(false);});
$('confirm-dialog').addEventListener('close',()=>syncControls());
function clock(){if(!game.state||!game.room)return;if(game.room.status==='finished'){text('clock','已结束');return;}const s=game.state,elapsed=game.client.ready?Math.max(0,performance.now()-game.stateAt):0,ms=s.remaining<0?-1:Math.max(0,s.remaining-elapsed),sec=Math.ceil(ms/1000);text('clock',ms<0?'不限时':String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0'));}
setInterval(clock,200);

fullscreen('chess','chess-fullscreen');
