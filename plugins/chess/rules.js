import {GameEngine} from './game.js';
export const rules={
  tickMs:250,restore:s=>GameEngine.restore(s,performance.now()),canJoin:g=>g.room.status!=='playing',
  snapshot({engine:g}){return {board:g.publicBoard(),colors:g.colors,turn:g.turn,remaining:g.remaining(performance.now()),captured:g.captured,lastFrom:g.lastFrom,lastTo:g.lastTo,winner:g.winner};},
  start(g){g.room.drawOffer=null;g.room.drawOfferSeq=0;g.room.drawOfferedAt=[-1,-1];g.engine=new GameEngine(g.room.seconds);g.engine.start(performance.now());},
  perform(g,who,a,p){
    if(a.type==='TIME'){if(who!==g.self||g.room.status!=='waiting'||![0,30,60,90].includes(a.seconds))return '现在不能设置时间';g.room.seconds=a.seconds;g.room.members.forEach(m=>m.ready=false);return null;}
    if(a.type==='READY'){if(g.room.status!=='waiting')return '已经开始';p.ready=!!a.ready;if(g.room.members.length===g.room.capacity&&g.room.members.every(m=>m.ready))return g.start();return null;}
    if(g.room.status!=='playing'||!g.engine)return '对局已经结束';
    const now=performance.now(),slot=g.room.members.findIndex(m=>m.id===who);
    if(g.engine.checkTimeout(now)){finish(g);return '回合已超时';}
    if(a.type==='SURRENDER'){g.engine.winner=1-slot;g.engine.reason='SURRENDER';finish(g);return null;}
    if(a.type==='DRAW_OFFER'){
      if(g.room.drawOffer)return '已有和棋请求等待答复';
      if(g.room.drawOfferedAt?.[slot]===g.room.move)return '本步已请求过和棋，请走棋后再试';
      g.room.drawOfferedAt??=[-1,-1];g.room.drawOfferedAt[slot]=g.room.move;
      g.room.drawOfferSeq=(g.room.drawOfferSeq||0)+1;g.room.drawOffer={id:g.room.drawOfferSeq,from:who};return null;
    }
    if(a.type==='DRAW_REPLY'){
      const offer=g.room.drawOffer;if(!offer||offer.id!==a.offer||offer.from===who||typeof a.accept!=='boolean')return '和棋请求已失效';
      g.room.drawOffer=null;if(a.accept)finish(g,{winnerId:null,draw:true,reason:'双方同意和棋'});return null;
    }
    if(a.type!=='MOVE')return '不支持的对局操作';if(a.move!==g.room.move)return '棋面已更新，请重新选择';
    const error=g.engine.act(slot,a.from,a.to,now);if(!error){g.room.move++;g.room.drawOffer=null;}if(g.engine.winner>=0)finish(g);return error;
  },
  tick(g,now){if(g.room.status==='playing'&&g.engine.checkTimeout(now)){finish(g);g.publish();g.checkpoint();}},
  memberLeft(g){if(g.room.status==='playing')g.room.result={winnerId:g.self,reason:'对手退出'};g.room.drawOffer=null;g.room.status='waiting';g.room.members.forEach(p=>p.ready=false);}
};
function finish(g,result){if(g.room.status!=='playing')return;const reasons={TIMEOUT:'回合超时',NO_PIECES:'棋子全部阵亡',NO_MOVES:'无合法走法',SURRENDER:'投降认输'};g.room.result=result||{winnerId:g.room.members[g.engine.winner]?.id,reason:reasons[g.engine.reason]||'对局结束'};g.room.drawOffer=null;g.room.status='finished';g.room.members.forEach(p=>p.ready=false);}
