import {$,text,element,toast,fail,confirm,mount,memberBadge,fullscreen} from '../../plugin_sdk/ui.js';
import {native,nativeCall,storageGet,storageSet} from '../../plugin_sdk/transport.js';
import {rules} from './rules.js';
import {Sound} from '../../plugin_sdk/sound.js';
const sound=new Sound(),view={motion:storageGet('cyber.motion',true)};sound.enabled=storageGet('cyber.sound',true);
let selected=-1,boardKey='',lastMove=-1,resultSound='';
const game=mount(rules,{timeSettings:true,round(){selected=-1;boardKey='';lastMove=-1;},render(){if(game.room?.status!=='waiting')renderChess();}});
async function act(a){sound.unlock();try{await game.action(a);}catch(e){fail(e);}}
const pieceNames={1:['','帅','仕','相','車','马','炮','兵'],'-1':['','将','士','象','車','马','炮','卒']};
function label(value){return value===99?'✦':value?pieceNames[Math.sign(value)][Math.abs(value)]:'';}
for(let i=0;i<32;i++){const b=element('button','piece');b.type='button';b.dataset.index=i;b.append(element('span','piece-face'));b.onclick=()=>chessClick(i);$('board').append(b);}
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
      const p=s.board[i],was=b.dataset.value;b.firstElementChild.textContent=label(p);b.dataset.value=p;
      b.className='piece '+(p===99?'dark':p===0?'empty':p>0?'red':'black')+(selected===i?' selected':'')+(s.lastTo===i?' last':'')+(s.lastFrom===i?' from':'');
      b.setAttribute('aria-pressed',String(selected===i));
      b.disabled=!myTurn||!game.client.ready;b.setAttribute('aria-label','第 '+(i+1)+' 格，'+(p===99?'暗棋':p===0?'空格':(p>0?'红':'黑')+label(p)));
      if(view.motion&&was!==undefined&&was!==String(p)&&p!==0)b.firstElementChild.animate([{transform:'scale(.75) rotateY(75deg)'},{transform:'scale(1) rotateY(0)'}],{duration:240,easing:'ease-out'});
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
function clock(){if(!game.state||!game.room)return;const s=game.state,elapsed=game.client.ready?Math.max(0,performance.now()-game.stateAt):0,ms=s.remaining<0?-1:Math.max(0,s.remaining-(game.room.status==='playing'?elapsed:0)),sec=Math.ceil(ms/1000);text('clock',ms<0?'不限时':String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0'));}
setInterval(clock,200);

fullscreen('chess','chess-fullscreen');
