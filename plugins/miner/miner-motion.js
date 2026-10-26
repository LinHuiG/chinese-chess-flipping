import {clawSwingSpeed,clawRetractSpeed} from './miner.js';

const HORIZON=500,CORRECTION=100,LIMIT=1.25;
export const clawTip=c=>({x:c.x+Math.sin(c.angle)*c.length,y:c.y+Math.cos(c.angle)*c.length});

// Rendering follows the simulation clock, not packet arrival intervals. Only poses
// are predicted: catching, releasing, scoring and changing phases stay authoritative.
export class MineMotion{
  constructor(){this.frames=new Map();this.connected=true;}
  time(now){if(!this.source)return 0;return this.clock+(this.running&&this.connected&&!this.awaiting?Math.max(0,Math.min(now,this.received+HORIZON)-this.clockAt)/1000:0);}
  setState(state,now,connected=true){
    if(!state){this.source=null;this.frames.clear();return;}
    if(state===this.source){
      if(connected!==this.connected){this.clock=this.time(now);this.clockAt=now;this.connected=connected;this.awaiting=connected;}
      return;
    }
    // A new world's elapsed=0 frame may wait for assets, admission or the first
    // host tick. Do not start a speculative clock before its first real tick.
    const running=state.phase==='playing'&&!state.paused&&state.elapsed>0;
    const previous=this.source,reset=!previous||state.level!==previous.level||state.seed!==previous.seed||state.elapsed<previous.elapsed||state.paused!==previous.paused||state.phase!==previous.phase||running!==this.running||this.awaiting||now-this.received>HORIZON;
    const before=new Map();if(!reset)for(const [slot] of this.frames)before.set(slot,{...this.player(slot,now)});
    const clock=reset?state.elapsed:Math.max(this.time(now),state.elapsed);
    this.source=state;this.running=running;this.connected=connected;this.awaiting=false;
    this.clock=this.running?clock:state.elapsed;this.clockAt=this.received=now;
    const live=new Set();
    for(const player of state.players){
      const c=player.claw,item=state.items.find(o=>o.id===c.item),slot=player.slot;
      live.add(slot);const frame={claw:{...c},pose:{...c},speed:clawRetractSpeed(player,item),limit:extensionLimit(player,state.items),at:now,angleError:0,lengthError:0};
      this.frames.set(slot,frame);const target=this.player(slot,now),old=before.get(slot);
      if(this.running&&old&&Math.abs(old.angle-target.angle)<.6&&Math.abs(old.length-target.length)<100){frame.angleError=old.angle-target.angle;frame.lengthError=old.length-target.length;}
    }
    for(const slot of this.frames.keys())if(!live.has(slot))this.frames.delete(slot);
  }
  player(slot,now){
    const frame=this.frames.get(slot);if(!frame)return null;
    const {claw:c,pose}=frame,t=this.running?Math.min(HORIZON/1000,Math.max(0,this.time(now)-this.source.elapsed)):0;
    let angle=c.angle,length=c.length;
    if(c.mode==='swing'){
      angle+=c.direction*clawSwingSpeed(this.source.level)*t;
      if(angle>LIMIT)angle=2*LIMIT-angle;else if(angle<-LIMIT)angle=-2*LIMIT-angle;
    }else if(c.mode==='extend')length=Math.min(frame.limit,c.length+280*t);
    else length=Math.max(24,c.length-frame.speed*t);
    const sampleNow=this.connected&&!this.awaiting?Math.min(now,this.received+HORIZON):this.clockAt,blend=Math.max(0,1-Math.max(0,sampleNow-frame.at)/CORRECTION);
    pose.angle=Math.max(-LIMIT,Math.min(LIMIT,angle+frame.angleError*blend));pose.length=Math.max(24,Math.min(c.mode==='extend'?frame.limit:Infinity,length+frame.lengthError*blend));return pose;
  }
  moving(now){return this.running&&this.connected&&!this.awaiting&&now<this.received+HORIZON;}
}

function extensionLimit(player,items){
  const c=player.claw,x=Math.sin(c.angle),y=Math.cos(c.angle);
  let limit=(626-c.y)/y;
  if(x>0)limit=Math.min(limit,(946-c.x)/x);else if(x<0)limit=Math.min(limit,(14-c.x)/x);
  for(const item of items){
    if(item.owner>=0)continue;
    const dx=item.x-c.x,dy=item.y-c.y,along=dx*x+dy*y,r=item.r+8+(player.effects.magnet?10:0),cross=dx*dx+dy*dy-along*along;
    if(cross>r*r||along+r<c.length)continue;
    limit=Math.min(limit,Math.max(c.length,along-Math.sqrt(Math.max(0,r*r-cross))));
  }
  return Math.max(c.length,limit);
}
