import {GameEngine} from './game.js';
export const rules={
  tickMs:250,restore:s=>GameEngine.restore(s,performance.now()),canJoin:g=>g.room.status!=='playing',
  snapshot({engine:g}){return {board:g.publicBoard(),colors:g.colors,turn:g.turn,remaining:g.remaining(performance.now()),captured:g.captured,lastFrom:g.lastFrom,lastTo:g.lastTo,winner:g.winner};},
  start(g){g.engine=new GameEngine(g.room.seconds);g.engine.start(performance.now());},
  perform(g,who,a,p){
    if(a.type==='TIME'){if(who!==g.self||g.room.status!=='waiting'||![0,30,60,90].includes(a.seconds))return '现在不能设置时间';g.room.seconds=a.seconds;g.room.members.forEach(m=>m.ready=false);return null;}
    if(a.type==='READY'){if(g.room.status!=='waiting')return '已经开始';p.ready=!!a.ready;if(g.room.members.length===g.room.capacity&&g.room.members.every(m=>m.ready))return g.start();return null;}
    if(a.type!=='MOVE'||g.room.status!=='playing'||!g.engine)return '当前不能走棋';if(a.move!==g.room.move)return '棋面已更新，请重新选择';
    const error=g.engine.act(g.room.members.findIndex(m=>m.id===who),a.from,a.to,performance.now());if(!error)g.room.move++;if(g.engine.winner>=0)finish(g);return error;
  },
  tick(g,now){if(g.room.status==='playing'&&g.engine.checkTimeout(now)){finish(g);g.publish();g.checkpoint();}},
  memberLeft(g){if(g.room.status==='playing')g.room.result={winnerId:g.self,reason:'对手退出'};g.room.status='waiting';g.room.members.forEach(p=>p.ready=false);}
};
function finish(g){if(g.room.status!=='playing')return;const reasons={TIMEOUT:'回合超时',NO_PIECES:'棋子全部阵亡',NO_MOVES:'无合法走法'};g.room.result={winnerId:g.room.members[g.engine.winner]?.id,reason:reasons[g.engine.reason]||'对局结束'};g.room.status='finished';g.room.members.forEach(p=>p.ready=false);}
