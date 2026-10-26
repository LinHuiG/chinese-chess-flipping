import './plugin-test-host.mjs';
import assert from 'node:assert/strict';
import {GoldMine,clawSwingSpeed,clawRetractSpeed} from '../plugins/miner/miner.js';
import {rules} from '../plugins/miner/rules.js';

const players=[{id:'one',name:'一'},{id:'two',name:'二'},{id:'three',name:'三'}];
const mine=()=>new GoldMine(42,players,1000),near=(a,b,message)=>assert(Math.abs(a-b)<1e-8,message+`: ${a} / ${b}`);
// An 800 ms busy frame used to advance the round clock by 800 ms but the
// mechanics by only 400 ms. Both now consume the same bounded round duration.
for(const mode of ['swing','extend','retract']){
 const a=mine(),b=mine();
 for(const g of [a,b]){const p=g.players[0];Object.assign(p.claw,{mode,angle:mode==='swing'?1.2:0,direction:1,length:mode==='retract'?500:24,item:mode==='retract'?1:-1});g.items=[{id:1,type:'gold',x:800,y:600,r:30,mass:5,value:500,owner:mode==='retract'?0:-1}];}
 a.step(.8);for(let i=0;i<40;i++)b.step(.02);
 near(a.elapsed,b.elapsed,mode+' elapsed');near(a.time,b.time,mode+' countdown');near(a.players[0].claw.angle,b.players[0].claw.angle,mode+' angle');near(a.players[0].claw.length,b.players[0].claw.length,mode+' rope');
 assert.equal(a.players[0].claw.direction,b.players[0].claw.direction,'swing reflection retains the remainder');
}
const clock=mine();clock.time=.07;clock.step(3600);near(clock.elapsed,.07,'no simulation beyond the remaining round');assert.equal(clock.time,0);assert.equal(clock.phase,'complete');
const supply=new GoldMine(42,players);supply.finishRound();supply.step(3600);assert.equal(supply.level,2);assert.equal(supply.phase,'playing');assert.equal(supply.elapsed,0,'shop overshoot does not simulate an unattended next round');
console.log('PASS miner elapsed time: CPU stalls, swing boundary, extension/retraction speed and bounded stage overshoot');

const hamster=mine(),hunter=hamster.players[0];hunter.claw.angle=0;
hamster.items=[{id:1,type:'hamster',homeX:hunter.claw.x+17,x:hunter.claw.x+17,y:150,r:17,mass:1,value:500,owner:-1,phase:0},{id:2,type:'rock',x:930,y:600,r:10,mass:2,value:20,owner:-1}];
hamster.act(hunter.id,{type:'DROP'});hamster.step(.3);assert.equal(hunter.score,500,'moving target collision uses each substep time, not its final future position');

const grabbed=mine(),p=grabbed.players[0];p.claw.angle=.45;const distance=240;
grabbed.items=[{id:1,type:'gold',x:p.claw.x+Math.sin(p.claw.angle)*distance,y:p.claw.y+Math.cos(p.claw.angle)*distance,r:30,mass:5,value:500,owner:-1},{id:2,type:'rock',x:930,y:600,r:10,mass:2,value:20,owner:-1}];
grabbed.act(p.id,{type:'DROP'});let steps=0;
while(p.claw.mode==='extend'){grabbed.step(.01);assert(++steps<200);}
assert.equal(p.claw.item,1,'swept collision catches the intended object');
while(p.claw.item>=0){const item=grabbed.items.find(o=>o.id===p.claw.item),tip=grabbed.tip(p);near(item.x,tip.x,'grip x');near(item.y,tip.y,'grip y');grabbed.step(.033);assert(++steps<500);}
assert.equal(p.score,500);assert.equal(p.cash,500);assert.equal(p.round,500);assert.equal(grabbed.items.length,1,'haul settles once');
assert(clawRetractSpeed({...p,reel:5,effects:{strength:true}},{mass:5})>clawRetractSpeed(p,{mass:5}));assert.equal(clawSwingSpeed(1000),.85);
grabbed.paused=true;const frozen=grabbed.save();assert.equal(grabbed.step(.8),false);assert.deepEqual(grabbed.save(),frozen);
const restored=GoldMine.restore(frozen);restored.rebind(players);assert.equal(restored.paused,false);assert.equal(restored.players[0].cash,500);assert.equal(restored.level,1000);
assert.throws(()=>GoldMine.restore({...frozen,time:1e12}),/存档无效/,'a corrupted saved clock cannot create unbounded catch-up work');
console.log('PASS miner grip: immediate attachment, common anchor throughout hauling, one settlement, upgrades, pause and saved state');

const updates=[],saved=[];const g={engine:new GoldMine(42,players),lastPublish:0,lastSave:0,publish(){updates.push(this.now);},saveProgress(){saved.push(this.now);}};
for(let now=33;now<=3300;now+=33){g.now=now;rules.tick(g,now,.033);}
assert.equal(updates.length,33,'33 ms simulation ticks retain a 10 Hz publish schedule');
assert(updates.slice(1).every((t,i)=>t-updates[i]<=132));
let before=updates.length;g.now=4400;rules.tick(g,4400,1.1);assert.equal(updates.length-before,1,'a stalled callback sends one latest state');
g.engine.phase='playing';g.engine.time=.001;before=updates.length;g.now=4433;rules.tick(g,4433,.033);assert.equal(updates.length-before,1,'phase transition publishes once');assert.equal(saved.length,1,'phase transition saves once');
g.now=9433;rules.tick(g,9433,5);assert.equal(saved.length,2,'periodic save remains five seconds after transition');
console.log('PASS miner snapshot schedule: uniform 100 ms cadence, no delayed backlog, one transition publish/save and periodic persistence');
