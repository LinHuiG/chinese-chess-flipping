import {GoldMine} from './miner.js';
import {storageGet,storageSet,storageFlush} from '../../plugin_sdk/transport.js';
export const rules={
  tickMs:33,restore:s=>GoldMine.restore(s),loadSave:()=>storageGet('cyber.miner.save'),canJoin:g=>g.room.status!=='playing',
  start(g){if(g.restoreSave){try{g.engine=GoldMine.restore(g.restoreSave);g.engine.rebind(g.room.members);g.restoreSave=null;}catch(e){g.room.status='waiting';return e.message;}}else g.engine=new GoldMine(crypto.getRandomValues(new Uint32Array(1))[0],g.room.members);},
  actionData:g=>({level:g.state?.level}),
  perform(g,who,a,p,payload){
    if(a.type==='READY'){if(g.room.status!=='waiting')return '已经开始';p.ready=!!a.ready;if(g.room.members.length===g.room.capacity&&g.room.members.every(m=>m.ready))return g.start();return null;}
    if(!g.engine)return '尚未开局';if(payload.level!==undefined&&payload.level!==g.engine.level)return '关卡已经更新，请重试';if(a.type==='PAUSE'){if(who!==g.self)return '只有房主可以暂停';if(g.engine.phase==='complete')return '已经完成全部关卡';g.engine.paused=!g.engine.paused;g.saveProgress(false);return null;}
    if(a.type==='NEXT'){if(who!==g.self)return '等待房主开始下一关';const error=g.engine.next();if(!error)g.saveProgress(false);return error;}return g.engine.act(who,a);
  },
  async save(g,notify){if(!g.host||!g.engine)return false;const saved=g.engine.save();let ok=storageSet('cyber.miner.save',saved);g.checkpoint(saved);try{await storageFlush();}catch{ok=false;}if(notify||(!ok&&!g.saveFailed))g.events.notice?.(ok?'进度已保存在房主设备':'保存失败：设备存储空间不足');g.saveFailed=!ok;return ok;},
  memberLeft(g){if(g.engine){g.engine.paused=true;g.restoreSave=g.engine.save();g.saveProgress(false);}g.room.members.forEach(p=>p.ready=false);g.room.status='waiting';},
  background(g){if(g.engine){g.engine.paused=true;g.saveProgress(false);g.publish();}},
  tick(g,now,dt){const phase=g.engine.phase;if(g.engine.step(dt)&&now-g.lastPublish>100){g.lastPublish=now;g.publish();}if(phase!==g.engine.phase){g.saveProgress(false);g.publish();}if(now-g.lastSave>5000){g.lastSave=now;g.saveProgress(false);}}
};
