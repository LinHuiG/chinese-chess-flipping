import {THEMES,rng} from './miner.js';
const COLORS=['#e9a73f','#66a7c2','#aa7fc3'];
export class Sound{
  constructor(){this.enabled=true;}
  unlock(){if(!this.enabled)return;try{this.context??=new (globalThis.AudioContext||globalThis.webkitAudioContext)();if(this.context.state==='suspended')this.context.resume();}catch{}}
  play(kind){
    if(!this.enabled)return;this.unlock();const c=this.context;if(!c||c.state!=='running')return;
    const notes=kind==='diamond'?[784,1047,1319]:kind==='gold'||kind==='bag'?[523,659,784]:kind==='finish'?[523,659,784,1047]:kind==='poop'?[180,130]:kind==='rock'?[110]:[380];
    notes.forEach((f,i)=>{const osc=c.createOscillator(),gain=c.createGain(),at=c.currentTime+i*.055;osc.type=kind==='rock'?'triangle':'sine';osc.frequency.setValueAtTime(f,at);gain.gain.setValueAtTime(.0001,at);gain.gain.exponentialRampToValueAtTime(.08,at+.012);gain.gain.exponentialRampToValueAtTime(.0001,at+.2);osc.connect(gain);gain.connect(c.destination);osc.start(at);osc.stop(at+.22);});
    if(kind==='blast'){const b=c.createBuffer(1,c.sampleRate*.25,c.sampleRate),data=b.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*(1-i/data.length);const src=c.createBufferSource(),gain=c.createGain();src.buffer=b;gain.gain.value=.12;src.connect(gain);gain.connect(c.destination);src.start();}
  }
}
export class MinerView{
  constructor(canvas,sound){
    this.canvas=canvas;this.ctx=canvas.getContext('2d',{alpha:false});this.sound=sound;this.particles=[];this.seen=0;this.motion=true;this.previous=new Map();this.sprites=new Map();this.artX=this.artY=1;
    this.sizeDirty=true;this.background=document.createElement('canvas');this.background.width=960;this.background.height=640;
    this.terrain=document.createElement('canvas');this.terrain.width=960;this.terrain.height=640;this.last=performance.now();
    this.resize=new ResizeObserver(()=>{this.sizeDirty=true;this.wake();});this.resize.observe(canvas);
  }
  wake(){if(this.state&&!document.hidden&&!this.suspended&&!this.raf)this.raf=requestAnimationFrame(t=>this.draw(t));}
  setState(state,self){
    this.self=self;
    if(!state){this.state=this.source=null;cancelAnimationFrame(this.raf);this.raf=0;this.level=null;this.previous.clear();this.sprites.clear();return;}
    if(state===this.source){this.wake();return;}
    if(this.level!==state.level||this.seed!==state.seed){this.seen=state.eventId;this.particles=[];this.level=state.level;this.seed=state.seed;this.paintBackground(state.level,state.seed);this.previous.clear();this.sprites.clear();this.terrainKey='';}
    const now=performance.now(),duration=state.paused||state.phase!=='playing'?0:Math.max(60,Math.min(160,now-(this.received||now-110)));
    this.source=state;
    // Host snapshots share mutable engine arrays. Freeze only this small render frame;
    // intermediate simulation ticks must not change the target during interpolation.
    this.state={...state,items:state.items.map(o=>({...o})),players:state.players.map(p=>({...p,claw:{...p.claw}}))};
    const live=new Set();
    const track=(key,value,fields)=>{live.add(key);let frame=this.previous.get(key);if(!frame){frame={from:{},to:{},value:{},at:now,duration:0};for(const f of fields)frame.value[f]=value[f];this.previous.set(key,frame);}else this.sample(frame,now);
      frame.at=now;frame.duration=duration;for(const f of fields){frame.from[f]=frame.value[f];frame.to[f]=value[f];}return frame;};
    for(const o of this.state.items)if(o.type==='hamster'||o.owner>=0)track('i'+o.id,o,['x','y']);
    for(const p of this.state.players)track('p'+p.slot,p.claw,['angle','length']);
    for(const key of this.previous.keys())if(!live.has(key))this.previous.delete(key);
    this.received=now;
    const terrainKey=this.state.items.filter(o=>o.type!=='hamster'&&o.owner<0).map(o=>o.id).join(',');
    if(terrainKey!==this.terrainKey){this.terrainKey=terrainKey;this.terrainDirty=true;}
    for(const e of state.events||[])if(e.id>this.seen){
        this.sound.play(e.type==='haul'?e.item:e.type);
        if(this.motion){
          if(e.type==='haul')this.particles.push({x:e.x,y:e.y-36,life:1.2,max:1.2,text:(e.value>=0?'+':'')+e.value,color:e.value<0?'#e99792':'#ffedac'});
          if(e.type==='blast')this.particles.push({x:e.x,y:e.y,life:.5,max:.5,ring:true,color:'#ffe4a5'});
          for(let i=0;i<(e.type==='blast'?30:12);i++)this.particles.push({x:e.x,y:e.y,vx:(Math.random()-.5)*220,vy:-Math.random()*180,life:.5+Math.random()*.5,max:1,color:e.type==='blast'?'#ffac60':'#ffeaa4'});
        }
      this.seen=e.id;
    }
    if(this.particles.length>150)this.particles.splice(0,this.particles.length-150);
    this.wake();
  }
  sample(frame,now){const t=frame.duration?Math.max(0,Math.min(1,(now-frame.at)/frame.duration)):1;for(const f in frame.to)frame.value[f]=frame.from[f]+(frame.to[f]-frame.from[f])*t;return frame.value;}
  sprite(c,o,x=o.x,y=o.y,time=0){
    const key=o.type+':'+o.r+':'+!!o.gem;let sprite=this.sprites.get(key);
    if(!sprite){const image=document.createElement('canvas'),size=Math.ceil(Math.max(48,o.r+12)*2);image.width=image.height=size*2;
      const ink=image.getContext('2d');ink.scale(2,2);ink.translate(size/2,size/2);
      const motion=this.motion;this.motion=false;this.item(ink,{...o,x:0,y:0,phase:0},0);this.motion=motion;sprite={image,size};this.sprites.set(key,sprite);}
    const w=sprite.size*this.artX,h=sprite.size*this.artY;
    if(o.type==='hamster'&&Math.cos(time*1.25+o.phase)<0){c.save();c.translate(x,y);c.scale(-1,1);c.drawImage(sprite.image,-w/2,-h/2,w,h);c.restore();}
    else c.drawImage(sprite.image,x-w/2,y-h/2,w,h);
  }
  paintBackground(level,seed){
    const c=this.background.getContext('2d'),theme=THEMES[Math.floor((level-1)/100)%10],random=rng(seed^level);
    const sky=c.createLinearGradient(0,0,0,180);sky.addColorStop(0,theme.sky);sky.addColorStop(1,'#f8efdb');c.fillStyle=sky;c.fillRect(0,0,960,640);
    c.fillStyle='#ffffff50';for(let i=0;i<7;i++){const x=random()*1000;c.beginPath();c.ellipse(x,25+random()*50,65,14,0,0,Math.PI*2);c.fill();}
    c.fillStyle=theme.earth+'80';c.beginPath();c.moveTo(0,140);for(let i=0;i<12;i++)c.lineTo(i*95,65+random()*70);c.lineTo(960,165);c.closePath();c.fill();
    const earth=c.createLinearGradient(0,145,0,640);earth.addColorStop(0,theme.earth);earth.addColorStop(1,theme.deep);c.fillStyle=earth;c.fillRect(0,145,960,495);
    for(let layer=0;layer<6;layer++){c.strokeStyle=layer%2?'#ffffff09':'#00000014';c.lineWidth=12+random()*20;c.beginPath();c.moveTo(-20,190+layer*90);for(let i=0;i<9;i++)c.lineTo(i*145,190+layer*90+random()*40);c.stroke();}
    for(let i=0;i<190;i++){const x=random()*960,y=170+random()*460;c.fillStyle=i%3===0?theme.accent+'50':'#ffffff0b';c.fillRect(x,y,random()*5+1,random()*3+1);}
    // 木制地表与细小草丛。
    c.fillStyle='#4e352e';c.fillRect(0,136,960,14);c.fillStyle='#b58b58';c.fillRect(0,134,960,5);
    for(let x=0;x<960;x+=48){c.strokeStyle='#735236';c.lineWidth=2;c.beginPath();c.moveTo(x,134);c.lineTo(x,149);c.stroke();c.fillStyle='#eed6a0';c.fillRect(x+7,138,3,3);}
    c.strokeStyle='#688759';c.lineWidth=3;for(let i=0;i<70;i++){const x=random()*960;if(x<100||x>850){c.beginPath();c.moveTo(x,134);c.lineTo(x-4,122-random()*12);c.moveTo(x,134);c.lineTo(x+5,123-random()*8);c.stroke();}}
  }
  polygon(c,points,fill,stroke='#00000028'){
    c.beginPath();points.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();c.fillStyle=fill;c.fill();if(stroke){c.strokeStyle=stroke;c.lineWidth=1.6;c.stroke();}
  }
  ellipse(c,x,y,rx,ry,fill){c.fillStyle=fill;c.beginPath();c.ellipse(x,y,rx,ry,0,0,Math.PI*2);c.fill();}
  item(c,o,time){
    c.save();c.translate(o.x,o.y);const r=o.r;
    c.shadowColor='#1b17263b';c.shadowBlur=5;c.shadowOffsetY=3;
    if(o.type==='gold'){
      this.polygon(c,[[-r,-r*.1],[-r*.65,-r*.7],[r*.15,-r*.84],[r*.88,-r*.3],[r,r*.52],[r*.15,r*.82],[-r*.8,r*.55]],'#e7ad35','#a97822');
      c.shadowBlur=0;this.polygon(c,[[-r*.65,-r*.7],[r*.15,-r*.84],[r*.52,-r*.1],[-r*.12,r*.12]],'#ffe49a',null);
      this.polygon(c,[[-r*.12,r*.12],[r*.52,-r*.1],[r,r*.52],[r*.15,r*.82]],'#f9ca55',null);
      c.fillStyle='#fff5cf';c.fillRect(-r*.48,-r*.34,Math.max(3,r*.13),Math.max(3,r*.13));
    }else if(o.type==='rock'){
      this.polygon(c,[[-r,-r*.1],[-r*.4,-r*.75],[r*.5,-r*.72],[r,r*.18],[r*.5,r*.75],[-r*.7,r*.65]],'#89928e','#515b5c');
      c.shadowBlur=0;this.polygon(c,[[-r*.4,-r*.75],[r*.5,-r*.72],[r*.25,-r*.1],[-r*.4,r*.08]],'#b1b8ac',null);
      c.strokeStyle='#63706a';c.lineWidth=2;c.beginPath();c.moveTo(-r*.3,r*.1);c.lineTo(r*.15,r*.28);c.lineTo(r*.3,r*.6);c.stroke();
    }else if(o.type==='diamond'){
      this.polygon(c,[[-r,0],[-r*.5,-r*.68],[r*.55,-r*.68],[r,0],[0,r]],'#a8f8f2','#4cadc1');
      this.polygon(c,[[-r,0],[0,-r*.62],[r,0],[0,r]],'#c9fff6',null);
      this.polygon(c,[[0,0],[r,0],[0,r]],'#62cddd',null);
      c.strokeStyle='#efffff';c.lineWidth=2;c.beginPath();c.moveTo(-r,0);c.lineTo(r,0);c.moveTo(0,-r*.62);c.lineTo(0,r);c.stroke();
      if(this.motion){c.globalAlpha=.45+.45*Math.sin(time*4+o.id);c.strokeStyle='#ffffff';c.beginPath();c.moveTo(r+4,-r-5);c.lineTo(r+4,-r+5);c.moveTo(r-1,-r);c.lineTo(r+9,-r);c.stroke();}
    }else if(o.type==='hamster'){
      c.scale(Math.cos(time*1.25+o.phase)>0?1:-1,1);
      this.ellipse(c,0,0,22,15,'#c5a077');this.ellipse(c,9,-8,12,11,'#debc94');this.ellipse(c,1,-18,7,8,'#cba07c');this.ellipse(c,1,-18,4,5,'#eac1b4');
      this.ellipse(c,17,-10,2.5,3,'#302b31');this.ellipse(c,18,-11,1,1,'#fff');this.ellipse(c,22,-3,3,2,'#ad7670');this.ellipse(c,-9,12,6,3,'#e9cda5');
      c.strokeStyle='#ead0b4';c.lineWidth=3;c.beginPath();c.moveTo(-19,3);c.quadraticCurveTo(-30,-3,-28,-10);c.stroke();
      if(o.gem){this.polygon(c,[[-11,-17],[-6,-24],[3,-24],[8,-17],[-2,-5]],'#9df3e4','#5ab9b6');}
    }else if(o.type==='bag'){
      this.ellipse(c,0,5,18,20,'#cb945a');c.shadowBlur=0;this.polygon(c,[[-12,-8],[-10,-20],[0,-17],[11,-21],[12,-8]],'#e2b779','#926740');c.strokeStyle='#67482f';c.lineWidth=3;c.beginPath();c.moveTo(-12,-7);c.lineTo(12,-7);c.stroke();
      c.fillStyle='#66452f';c.font='bold 20px sans-serif';c.textAlign='center';c.fillText('?',0,13);
    }else if(o.type==='poop'){
      this.ellipse(c,0,11,20,8,'#684735');this.ellipse(c,-1,2,15,9,'#80583c');this.ellipse(c,0,-7,10,8,'#916646');
      this.polygon(c,[[-8,-9],[5,-20],[8,-8]],'#916646',null);
      c.fillStyle='#e4dcc6';c.beginPath();c.arc(-5,1,2,0,Math.PI*2);c.arc(5,1,2,0,Math.PI*2);c.fill();
      if(this.motion){c.strokeStyle='#b0c26a77';c.lineWidth=2;c.beginPath();c.moveTo(-13,-20);c.quadraticCurveTo(-20,-28+Math.sin(time*3)*4,-13,-35);c.stroke();}
    }else if(o.type==='tnt'){
      for(let i=-1;i<=1;i++){c.fillStyle=i===0?'#d06647':'#b54c3b';c.fillRect(i*12-5,-20,11,38);}
      c.shadowBlur=0;c.fillStyle='#e9c99a';c.fillRect(-19,-8,38,16);c.fillStyle='#70382f';c.font='bold 11px sans-serif';c.textAlign='center';c.fillText('TNT',0,4);
      c.strokeStyle='#deb77b';c.lineWidth=3;c.beginPath();c.moveTo(0,-20);c.quadraticCurveTo(5,-36,18,-31);c.stroke();this.ellipse(c,18,-31,3+(this.motion?Math.sin(time*8):0),3,'#ffe585');
    }
    c.restore();
  }
  player(c,p,time){
    const claw=p.claw,color=COLORS[p.slot%3];
    c.save();c.translate(claw.x,claw.y);
    c.strokeStyle='#332c2c';c.lineWidth=5;c.beginPath();c.moveTo(0,-11);c.lineTo(Math.sin(claw.angle)*claw.length,Math.cos(claw.angle)*claw.length);c.stroke();
    c.strokeStyle='#d8c99a';c.lineWidth=2;c.stroke();
    c.save();c.translate(Math.sin(claw.angle)*claw.length,Math.cos(claw.angle)*claw.length);c.scale(this.artX,this.artY);c.rotate(-Math.atan2(Math.sin(claw.angle)/this.artX,Math.cos(claw.angle)/this.artY));
    c.lineCap='round';c.lineJoin='round';c.strokeStyle='#d4d9d0';c.lineWidth=5;c.beginPath();c.moveTo(-5,-6);c.lineTo(-12,8);c.lineTo(-5,16);c.moveTo(5,-6);c.lineTo(12,8);c.lineTo(5,16);c.stroke();this.ellipse(c,0,-5,5,5,'#9ca89f');c.restore();
    c.scale(this.artX,this.artY);
    c.fillStyle='#77513b';c.fillRect(-46,-9,92,25);c.fillStyle='#b88450';c.fillRect(-48,-13,96,12);
    this.ellipse(c,-31,19,9,9,'#423d3a');this.ellipse(c,31,19,9,9,'#423d3a');
    c.fillStyle=color;c.fillRect(-13,-39,27,29);this.ellipse(c,1,-48,17,17,'#eac3a0');
    this.ellipse(c,1,-57,22,11,color);c.fillStyle=color;c.fillRect(-19,-58,40,7);
    this.ellipse(c,1,-59,6,6,'#fff1c4');this.ellipse(c,-5,-48,1.5,2,'#383438');this.ellipse(c,7,-48,1.5,2,'#383438');
    c.strokeStyle='#915f51';c.lineWidth=2;c.beginPath();c.arc(1,-45,5,0,Math.PI);c.stroke();
    c.fillStyle='#354348';c.fillRect(-12,-25,7,14);c.fillRect(7,-25,7,14);
    this.ellipse(c,-24,-15,10,10,'#526462');c.strokeStyle='#c5d2c6';c.lineWidth=2;c.beginPath();c.moveTo(-24,-23);c.lineTo(-24,-7);c.moveTo(-32,-15);c.lineTo(-16,-15);c.stroke();
    if(p.id===this.self){c.fillStyle='#ffffff';c.beginPath();c.moveTo(-5,-89);c.lineTo(5,-89);c.lineTo(0,-81);c.fill();}
    c.restore();
  }
  draw(now){
    this.raf=0;if(!this.state||document.hidden||this.suspended)return;
    const dt=Math.min(.05,(now-this.last)/1000);this.last=now;
    const s=this.state,c=this.ctx;
    if(this.sizeDirty){
      this.sizeDirty=false;const width=Math.max(1,this.canvas.clientWidth),height=Math.max(1,this.canvas.clientHeight),ratio=Math.min(1.5,globalThis.devicePixelRatio||1,Math.sqrt(1500000/(width*height)));
      this.canvas.width=Math.round(width*ratio);this.canvas.height=Math.round(height*ratio);
      const scale=Math.min(width/960,height/640);this.artX=scale/(width/960);this.artY=scale/(height/640);this.terrainDirty=true;
    }
    c.setTransform(this.canvas.width/960,0,0,this.canvas.height/640,0,0);c.drawImage(this.background,0,0);
    if(this.terrainDirty){const terrain=this.terrain.getContext('2d');terrain.clearRect(0,0,960,640);for(const o of s.items)if(o.type!=='hamster'&&o.owner<0)this.sprite(terrain,o);this.terrainDirty=false;}
    c.drawImage(this.terrain,0,0);
    const time=this.motion?s.elapsed+(s.paused?0:Math.min(.15,(now-this.received)/1000)):0;
    for(const item of s.items)if(item.type==='hamster'||item.owner>=0){const point=this.sample(this.previous.get('i'+item.id),now);this.sprite(c,item,point.x,point.y,time);}
    for(const p of s.players){const pose=this.sample(this.previous.get('p'+p.slot),now);p.claw.angle=pose.angle;p.claw.length=pose.length;this.player(c,p,time);}
    for(const p of this.particles){
      p.life-=dt;p.x+=(p.vx||0)*dt;p.y+=(p.vy||-35)*dt;if(p.vy!==undefined)p.vy+=230*dt;
      c.save();c.globalAlpha=Math.max(0,Math.min(1,p.life/p.max));c.fillStyle=p.color;
      if(p.text){c.font='bold 27px sans-serif';c.textAlign='center';c.fillText(p.text,p.x,p.y);}
      else if(p.ring){c.strokeStyle=p.color;c.lineWidth=8*p.life/p.max;c.beginPath();c.arc(p.x,p.y,100*(1-p.life/p.max),0,Math.PI*2);c.stroke();}
      else{c.translate(p.x,p.y);c.rotate(p.life*4);c.fillRect(-3,-3,6,6);}c.restore();
    }
    this.particles=this.particles.filter(p=>p.life>0);
    if(s.paused||s.phase!=='playing'){
      c.fillStyle='#18252f66';c.fillRect(0,0,960,640);c.fillStyle='#fff7e6';c.font='bold 34px sans-serif';c.textAlign='center';
      c.fillText(s.paused?'矿车暂歇 · 进度已保留':s.phase==='complete'?'第 1,000 关完成！':'这一趟，满载而归',480,305);
      c.font='18px sans-serif';c.fillText(s.paused?'等待房主继续冒险':'去商店，为下一次出发做准备',480,342);
    }
    if((s.phase==='playing'&&!s.paused)||this.particles.length)this.raf=requestAnimationFrame(t=>this.draw(t));
  }
}
