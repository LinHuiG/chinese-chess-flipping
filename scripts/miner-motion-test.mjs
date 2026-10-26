import assert from 'node:assert/strict';
import {GoldMine,clawSwingSpeed,clawRetractSpeed} from '../plugins/miner/miner.js';
import {MineMotion,clawTip} from '../plugins/miner/miner-motion.js';

const engine=()=>new GoldMine(42,[{id:'a',name:'A'},{id:'b',name:'B'}]),snapshot=g=>structuredClone(g.snapshot());
const game=engine(),motion=new MineMotion(),cadence=[80,240,110,310,90,180,130];
let now=0,next=80,tick=0,previous;
motion.setState(snapshot(game),now);
const speed=clawSwingSpeed(1),velocities=[];
for(now=10;now<=3000;now+=10){
 game.step(.01);
 if(now>=next){motion.setState(snapshot(game),now);next+=cadence[++tick%cadence.length];}
 const angle=motion.player(0,now).angle;
 if(now>90&&previous!==undefined&&Math.abs(angle)<1.23&&Math.abs(previous)<1.23)velocities.push(Math.abs(angle-previous)/.01);
 previous=angle;
}
assert(velocities.length>200);
assert(velocities.every(v=>Math.abs(v-speed)<.003),'jittery snapshots must not stop or accelerate a free swinging claw');
// The first zero-time frame can be shown well before simulation starts (assets,
// a fresh iframe, or resume). Separate 33 ms simulation, jittery publishing and
// fractional rAF phases must not retain that warm-up delay as a permanent lead.
for(const warmup of [50,200,337,480,900])for(const phase of [2,14,31]){
 const g=engine(),m=new MineMotion();m.setState(snapshot(g),0);m.setState(snapshot(g),warmup);
 let sim=warmup+33,publish=warmup+80,frame=warmup+phase,packet=0,lastPose;
 for(let wall=warmup;wall<=warmup+5000;wall++){
  if(wall>=sim){g.step(.033);sim+=33;}
  if(wall>=publish){m.setState(snapshot(g),wall+.4);publish+=cadence[++packet%cadence.length];}
  if(wall>=frame){const pose={angle:m.player(0,frame).angle,at:frame};if(lastPose&&wall>warmup+400&&Math.abs(pose.angle)<1.2&&Math.abs(lastPose.angle)<1.2){const velocity=Math.abs(pose.angle-lastPose.angle)/((pose.at-lastPose.at)/1000);assert(velocity>speed*.5&&velocity<speed*1.5,`warm ${warmup}, phase ${phase}: ${velocity}`);}lastPose=pose;frame+=6.25;}
 }
}
const last=motion.received,stopped={...motion.player(0,last+500)};assert.deepEqual({...motion.player(0,last+5000)},stopped,'missing snapshots stop prediction after 500 ms');assert.equal(motion.moving(last+501),false);

const free=engine();free.elapsed=1;free.items=[{id:4,type:'gold',x:930,y:500,owner:-1,r:16,mass:2}];free.players[0].claw={...free.players[0].claw,angle:0,length:24,mode:'extend'};
const extension=new MineMotion();extension.setState(snapshot(free),0);assert(Math.abs(extension.player(0,100).length-52)<1e-9);assert(Math.abs(extension.player(0,300).length-108)<1e-9);
const blocked=engine();blocked.elapsed=1;blocked.items=[{id:5,type:'gold',x:260,y:220,owner:-1,r:20,mass:3}];blocked.players[0].claw={...blocked.players[0].claw,angle:0,length:24,mode:'extend'};
const collision=new MineMotion();collision.setState(snapshot(blocked),0);assert.equal(collision.player(0,500).length,78,'prediction stops at contact without pretending to grab');assert.equal(collision.player(0,500).item,-1);assert.equal(blocked.items[0].owner,-1);
const held=engine(),p=held.players[0];held.elapsed=1;p.claw={...p.claw,angle:.65,length:240,mode:'retract',item:9};held.items=[{id:9,type:'gold',x:0,y:0,owner:0,r:32,mass:6}];p.reel=2;p.effects.strength=true;
const hauling=new MineMotion();hauling.setState(snapshot(held),0);assert(Math.abs(hauling.player(0,200).length-(240-clawRetractSpeed(p,held.items[0])*.2))<1e-9);const tip=clawTip(hauling.player(0,200));assert(Math.abs(tip.x-(260+Math.sin(.65)*hauling.player(0,200).length))<1e-9);
const once=snapshot(held);hauling.setState(once,200);const before={...hauling.player(0,250)};hauling.setState(once,250,false);assert.deepEqual({...hauling.player(0,1000)},before,'disconnect freezes the current displayed pose');hauling.setState(once,1000,true);assert.deepEqual({...hauling.player(0,1500)},before,'reconnect waits for a fresh authoritative snapshot');
held.elapsed+=1;held.players[0].claw.length=180;hauling.setState(snapshot(held),1600,true);assert.equal(hauling.player(0,1600).length,180,'fresh recovery resets stale prediction');
held.paused=true;hauling.setState(snapshot(held),1700);assert.equal(hauling.player(0,3000).length,180);held.paused=false;held.level=2;held.elapsed=0;held.players[0].claw.length=24;held.players[0].claw.mode='swing';hauling.setState(snapshot(held),3100);assert.equal(hauling.player(0,3100).length,24,'new level clears old correction');
hauling.setState(null);assert.equal(hauling.frames.size,0);
console.log('PASS miner motion: jitter-independent velocity, 500 ms bound, collision limit, shared retract speed, palm position, disconnect/reconnect, pause and new-level reset');
