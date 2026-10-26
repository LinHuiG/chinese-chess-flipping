// 原创多人矿工规则。房主独占模拟；关卡由种子+关卡号生成，存档不存 1,000 张地图。
export const MAX_LEVEL=1000;
export const SHOP_SECONDS=20;
export const clawSwingSpeed=level=>.60+Math.min(.25,level/3500);
export const clawRetractSpeed=(player,item)=>240*(1+player.reel*.12)*(player.effects.strength?1.5:1)/(1+(item?.mass||0)*.32);
export const SHOP=[
  {id:'dynamite',name:'随身炸药',icon:'✦',price:140,description:'炸掉爪上的重物，立即收钩',stack:true},
  {id:'strength',name:'大力汽水',icon:'ϟ',price:260,description:'下一关拉取速度提升 50%'},
  {id:'polish',name:'钻石抛光剂',icon:'◆',price:280,description:'下一关钻石价值提升 50%'},
  {id:'clover',name:'勘探校准器',icon:'♧',price:220,description:'下一关补给箱价值提升 60%'},
  {id:'rockbook',name:'岩石收藏册',icon:'▰',price:180,description:'下一关石头价值变为 3 倍'},
  {id:'shield',name:'防污手套',icon:'♜',price:150,description:'下一关免疫污染废料的扣分'},
  {id:'magnet',name:'磁力钩尖',icon:'⊕',price:230,description:'下一关抓取范围增加'},
  {id:'clock',name:'怀表',icon:'◷',price:320,description:'下一关为全队增加 12 秒'},
  {id:'reel',name:'卷扬机升级',icon:'⚙',price:420,description:'永久提升拉取速度，最多 5 级',permanent:true},
];
export const THEMES=[
  {name:'晨光矿谷',sky:'#bce6ed',earth:'#8d5838',deep:'#412b2c',accent:'#f3c75f'},
  {name:'苔光洞窟',sky:'#9bd3b4',earth:'#567454',deep:'#223d38',accent:'#b5db83'},
  {name:'琥珀荒漠',sky:'#f9d49d',earth:'#be7040',deep:'#623b35',accent:'#ffe69a'},
  {name:'蓝晶深井',sky:'#a9cbe8',earth:'#536b90',deep:'#26384f',accent:'#89e8ee'},
  {name:'紫雾遗迹',sky:'#cbb7e5',earth:'#80638f',deep:'#3d2d54',accent:'#e7b2f4'},
  {name:'落日熔岩',sky:'#f0b694',earth:'#995246',deep:'#452c38',accent:'#ffb377'},
  {name:'冰川宝库',sky:'#d3edf1',earth:'#779aaa',deep:'#33485c',accent:'#c6fbff'},
  {name:'荧光森林',sky:'#a7d9c3',earth:'#457065',deep:'#203c3d',accent:'#c2ef9b'},
  {name:'星屑矿带',sky:'#b9bbdf',earth:'#676685',deep:'#2c2b47',accent:'#ffd48c'},
  {name:'黄金之心',sky:'#f0daa4',earth:'#967548',deep:'#473b37',accent:'#ffdc74'},
];
export function rng(seed){let s=seed>>>0||1;return()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return(s>>>0)/4294967296;};}
export function levelMap(seed,level){
  const random=rng((seed^Math.imul(level,0x9e3779b9))>>>0),items=[];
  const count=24+Math.min(22,Math.floor(level/20))+Math.floor(random()*6);
  const kinds=['gold','gold','rock','diamond','hamster','bag','poop','tnt'];
  for(let i=0;i<count;i++){
    let type=i<3?'gold':kinds[Math.floor(random()*kinds.length)];
    if(level===1&&type==='tnt'&&i%2===0)type='diamond';
    const size=type==='gold'?(random()<.38?38:random()<.55?25:16):type==='rock'?20+random()*19:type==='hamster'?17:type==='tnt'?23:16;
    let x=0,y=0;
    for(let tries=0;tries<80;tries++){
      x=55+random()*850;y=195+random()*390;
      if(items.every(o=>Math.hypot(o.x-x,o.y-y)>o.r+size+9))break;
    }
    const value=type==='gold'?Math.round(size*size*.55):type==='diamond'?600:type==='bag'?100+Math.floor(random()*700):type==='hamster'?(random()<.4?800:100):type==='rock'?Math.round(size*1.7):type==='poop'?-120:0;
    items.push({id:i,type,x,y,homeX:x,r:size,value,mass:type==='gold'?size/7:type==='rock'?size/4:type==='poop'?4:1,owner:-1,phase:random()*6.28,gem:type==='hamster'&&value===800});
  }
  return items;
}
function claw(slot,count){return{x:count===2?260+slot*440:180+slot*300,y:114,angle:(slot-1)*.32,direction:slot%2?-1:1,length:24,mode:'swing',item:-1,stun:0};}
function distanceToSegment(x,y,ax,ay,bx,by){const dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy||1)));return Math.hypot(x-ax-t*dx,y-ay-t*dy);}
export class GoldMine{
  constructor(seed,players,level=1){
    this.seed=seed>>>0;this.level=level;this.players=players.map((p,slot)=>({id:p.id,name:p.name,slot,score:0,cash:0,round:0,reel:0,inventory:{dynamite:1},effects:{},purchased:{},shopReady:false,claw:claw(slot,players.length)}));
    this.phase='playing';this.paused=false;this.elapsed=0;this.events=[];this.eventId=0;this.prepare();
  }
  prepare(){
    this.items=levelMap(this.seed,this.level);this.time=110-Math.min(38,Math.floor(this.level/35));
    this.target=Math.round(this.items.filter(o=>o.value>0).reduce((s,o)=>s+o.value,0)*.48);
    this.roundBonus=false;this.elapsed=0;this.shopTime=0;this.events=[];
    for(const p of this.players){p.round=0;p.shopReady=false;p.purchased={};p.claw=claw(p.slot,this.players.length);if(p.effects.clock)this.time+=12;}
    this.phase='playing';
  }
  event(type,x,y,data={}){this.events.push({id:++this.eventId,type,x,y,...data});if(this.events.length>16)this.events.shift();}
  tip(p){const c=p.claw;return{x:c.x+Math.sin(c.angle)*c.length,y:c.y+Math.cos(c.angle)*c.length};}
  act(playerId,action){
    const p=this.players.find(p=>p.id===playerId);if(!p)return '你不在本局中';
    if(this.paused)return '等待房主继续';
    if(action.type==='BUY')return this.buy(p,action.item);
    if(action.type==='SHOP_READY'){if(this.phase!=='shop')return '商店尚未开放';p.shopReady=!!action.ready;return null;}
    if(this.phase!=='playing')return '等待房主继续';
    if(action.type==='DROP'){if(p.claw.mode!=='swing'||p.claw.stun>0)return '爪子正在工作';p.claw.mode='extend';return null;}
    if(action.type==='BOMB'){
      if(!p.inventory.dynamite)return '没有随身炸药';
      const item=this.items.find(o=>o.id===p.claw.item);
      if(!item)return '抓到东西后才能使用';
      p.inventory.dynamite--;this.items=this.items.filter(o=>o!==item);const tip=this.tip(p);this.event('blast',tip.x,tip.y,{player:p.slot});
      p.claw.item=-1;p.claw.mode='retract';return null;
    }
    return '未知操作';
  }
  buy(p,itemId){
    if(this.phase!=='shop'||p.shopReady)return '请先取消购买完成';
    const item=SHOP.find(i=>i.id===itemId);if(!item)return '道具不存在';
    if(item.permanent&&p.reel>=5)return '卷扬机已满级';
    if(!item.stack&&!item.permanent&&p.purchased[itemId])return '这一轮已经买过';
    if(item.stack&&(p.inventory.dynamite||0)>=9)return '最多携带 9 份炸药';
    const price=item.price*(item.permanent?p.reel+1:1);if(p.cash<price)return '积分余额不足';
    p.cash-=price;if(item.stack)p.inventory.dynamite=(p.inventory.dynamite||0)+1;
    else if(item.permanent)p.reel++;else{p.effects[itemId]=true;p.purchased[itemId]=true;}
    return null;
  }
  next(){
    if(this.paused)return '等待房主继续';
    if(this.phase!=='shop'||(this.shopTime>0&&!this.players.every(p=>p.shopReady)))return '请等所有人购买完成';
    if(this.level>=MAX_LEVEL){this.phase='complete';return null;}
    this.level++;this.prepare();return null;
  }
  finishRound(){
    if(this.phase!=='playing')return;
    this.roundBonus=this.players.reduce((n,p)=>n+p.round,0)>=this.target;
    for(const p of this.players){if(this.roundBonus){p.cash+=150;p.score+=150;}p.effects={};p.claw.item=-1;p.claw.mode='swing';}
    this.phase=this.level>=MAX_LEVEL?'complete':'shop';this.time=Math.max(0,this.time);this.shopTime=this.phase==='shop'?SHOP_SECONDS:0;
    this.event('finish',480,180,{bonus:this.roundBonus});
  }
  blast(item,p){
    const destroyed=new Set([item.id]),queue=[item];
    for(let i=0;i<queue.length;i++)for(const o of this.items){
      if(!destroyed.has(o.id)&&Math.hypot(o.x-queue[i].x,o.y-queue[i].y)<92+o.r){
        destroyed.add(o.id);if(o.type==='tnt')queue.push(o);
      }
    }
    for(const o of queue)this.event('blast',o.x,o.y,{player:p.slot});
    this.items=this.items.filter(o=>!destroyed.has(o.id));
    for(const other of this.players)if(destroyed.has(other.claw.item)){other.claw.item=-1;other.claw.mode='retract';}
    p.claw.mode='retract';p.claw.stun=.55;
  }
  haul(p,item){
    let value=item.value;
    if(item.type==='diamond'||item.gem){if(p.effects.polish)value=Math.round(value*1.5);}
    if(item.type==='bag'&&p.effects.clover)value=Math.round(value*1.6);
    if(item.type==='rock'&&p.effects.rockbook)value*=3;
    if(item.type==='poop'&&p.effects.shield)value=0;
    p.score+=value;p.round+=value;p.cash=Math.max(0,p.cash+value);
    this.items=this.items.filter(o=>o!==item);this.event('haul',p.claw.x,110,{value,player:p.slot,item:item.type});
  }
  step(dt){
    if(this.paused||!Number.isFinite(dt)||dt<=0)return false;
    if(this.phase==='shop'){this.shopTime=Math.max(0,this.shopTime-dt);if(this.shopTime===0)this.next();return true;}
    if(this.phase!=='playing')return false;
    // Advance the same elapsed time for motion and the round clock. Dropping
    // motion after a slow frame made claw speed depend on the host's CPU load.
    const motion=Math.min(dt,Math.max(0,this.time)),steps=Math.max(1,Math.ceil(motion/.025)),delta=motion/steps;
    this.time=Math.max(0,this.time-dt);
    for(let step=0;step<steps;step++){
      this.elapsed+=delta;
      for(const item of this.items)if(item.type==='hamster'&&item.owner<0)item.x=Math.max(30,Math.min(930,item.homeX+Math.sin(this.elapsed*1.25+item.phase)*42));
      for(const p of this.players){
        const c=p.claw;c.stun=Math.max(0,c.stun-delta);
        if(c.mode==='swing'){c.angle+=c.direction*delta*clawSwingSpeed(this.level);if(c.angle>1.25){c.angle=2.5-c.angle;c.direction=-1;}else if(c.angle< -1.25){c.angle=-2.5-c.angle;c.direction=1;}continue;}
        if(c.mode==='extend'){
          const before=this.tip(p);c.length+=delta*280;const after=this.tip(p);
          const item=this.items.find(o=>o.owner<0&&distanceToSegment(o.x,o.y,before.x,before.y,after.x,after.y)<o.r+8+(p.effects.magnet?10:0));
          if(item){
            if(item.type==='tnt'){this.blast(item,p);continue;}
            c.item=item.id;item.owner=p.slot;c.mode='retract';item.x=after.x;item.y=after.y;
          }else if(after.x<14||after.x>946||after.y>626)c.mode='retract';
        }else{
          const item=this.items.find(o=>o.id===c.item),speed=clawRetractSpeed(p,item);
          c.length=Math.max(24,c.length-delta*speed);
          if(item){const tip=this.tip(p);item.x=tip.x;item.y=tip.y;}
          if(c.length<=24){if(item)this.haul(p,item);c.item=-1;c.mode='swing';}
        }
      }
    }
    if(this.time<=0||!this.items.length)this.finishRound();return true;
  }
  snapshot(){return {seed:this.seed,level:this.level,phase:this.phase,paused:this.paused,time:this.time,shopTime:this.shopTime,elapsed:this.elapsed,target:this.target,roundBonus:this.roundBonus,players:this.players,items:this.items,events:this.events,eventId:this.eventId};}
  save(){return JSON.parse(JSON.stringify({version:1,...this.snapshot()}));}
  static restore(saved){
    if(saved.version!==1||!Number.isInteger(saved.level)||saved.level<1||saved.level>MAX_LEVEL||!Array.isArray(saved.players)||saved.players.length<2||saved.players.length>3||!Array.isArray(saved.items)||saved.items.length>96||!Number.isFinite(saved.time)||saved.time<0||saved.time>110+3*12)throw Error('矿工存档无效');
    const game=Object.assign(Object.create(GoldMine.prototype),JSON.parse(JSON.stringify(saved)));game.paused=game.phase==='playing'||game.phase==='shop';
    game.shopTime=game.phase==='shop'?Math.max(0,Math.min(SHOP_SECONDS,Number.isFinite(saved.shopTime)?saved.shopTime:SHOP_SECONDS)):0;
    return game;
  }
  rebind(members){
    // 存档按座位保留财富和装备，新房间按加入顺序认领原有座位。
    if(members.length!==this.players.length)throw Error('请凑齐存档中的 '+this.players.length+' 位玩家');
    members.forEach((m,i)=>{this.players[i].id=m.id;this.players[i].name=m.name;});this.paused=false;
  }
}
