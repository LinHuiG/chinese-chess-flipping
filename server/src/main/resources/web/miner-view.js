const COLORS=['#8fddf4','#d7e3e9','#e8b65d'];
const ART={gold:[56,63,313,307],rock:[469,63,319,306],diamond:[877,92,341,264],hamster:[43,457,355,295],bag:[447,484,361,250],poop:[863,497,365,227],tnt:[82,837,255,339],miner:[440,797,374,390],claw:[880,806,335,384]};
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
  prepare(){
    if(this.ready)return this.ready;
    const load=name=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=reject;image.src=new URL('./assets/'+name,import.meta.url).href;});
    this.ready=Promise.all([load('deep-mine.png'),load('miner-atlas.png')]).then(([background,atlas])=>{this.mineImage=background;this.atlas=atlas;this.sprites.clear();this.terrainDirty=true;if(this.state)this.paintBackground(this.state.level,this.state.seed);this.wake();return true;}).catch(()=>{this.assetError=true;this.wake();return false;});
    return this.ready;
  }
  wake(){if(this.state&&!document.hidden&&!this.suspended&&!this.raf)this.raf=requestAnimationFrame(t=>this.draw(t));}
  setState(state,self){
    this.self=self;
    if(!state){this.state=this.source=null;cancelAnimationFrame(this.raf);this.raf=0;this.level=null;this.previous.clear();this.sprites.clear();return;}
    this.prepare();
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
    const c=this.background.getContext('2d');c.fillStyle='#10181f';c.fillRect(0,0,960,640);
    if(this.mineImage)c.drawImage(this.mineImage,0,26,960,640);
    // A small tint distinguishes the existing ten sectors without reducing ore contrast.
    const tints=['#123244','#173b3d','#3d3326','#132c50','#292d46','#3c2828','#28424b','#163e38','#252c43','#3a3424'];
    c.globalAlpha=.15;c.fillStyle=tints[Math.floor((level-1)/100)%10];c.fillRect(0,0,960,640);c.globalAlpha=1;
    c.fillStyle='#26343e';c.fillRect(0,114,960,9);c.fillStyle='#b5c8d0';c.fillRect(0,114,960,1.5);
    for(let x=12;x<960;x+=64){c.fillStyle='#52636d';c.fillRect(x,117,3,3);}
  }
  art(c,name,x,y,width){
    const source=ART[name];if(!this.atlas||!source)return;const height=width*source[3]/source[2];
    c.drawImage(this.atlas,...source,x-width/2,y-height/2,width,height);
  }
  item(c,o,time){
    c.save();c.translate(o.x,o.y);this.art(c,o.type,0,0,Math.max(o.r*2.2,o.type==='hamster'?44:0));
    if(o.type==='hamster'&&o.gem)this.art(c,'diamond',-6,-18,17);
    c.restore();
  }
  player(c,p,time){
    const claw=p.claw,color=COLORS[p.slot%3],x=Math.sin(claw.angle)*claw.length,y=Math.cos(claw.angle)*claw.length;
    c.save();c.translate(claw.x,claw.y);c.lineCap='round';
    c.strokeStyle='#070d12';c.lineWidth=5;c.beginPath();c.moveTo(0,0);c.lineTo(x,y);c.stroke();
    c.strokeStyle='#becbd2';c.lineWidth=2;c.stroke();
    c.save();c.translate(x,y);c.scale(this.artX,this.artY);c.rotate(-Math.atan2(Math.sin(claw.angle)/this.artX,Math.cos(claw.angle)/this.artY));this.art(c,'claw',0,1,34);c.restore();
    // The short landscape field has less space above the winch. Fit the crew
    // inside that space without changing the rope origin or collision world.
    const width=Math.min(170,(claw.y-14)/this.artY*374/390),height=width*390/374;
    c.scale(this.artX,this.artY);this.art(c,'miner',0,-height/2,width);
    // Crew identity stays readable when helmets share the same neutral material.
    c.fillStyle=color;c.fillRect(-width*.05,-height*.84,width*.1,3);c.fillRect(-width*.22,-5,width*.44,2);
    if(claw.mode!=='swing'&&this.motion){c.strokeStyle=color;c.lineWidth=2;c.beginPath();c.arc(0,-height*.2,width*.08,time*5,time*5+Math.PI*1.3);c.stroke();}
    if(p.id===this.self){c.fillStyle='#b5ebff';c.beginPath();c.moveTo(-6,-height-9);c.lineTo(6,-height-9);c.lineTo(0,-height-2);c.fill();}
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
    if(!this.atlas){c.fillStyle='#d5e6ee';c.font='24px sans-serif';c.textAlign='center';c.fillText(this.assetError?'采掘画面加载失败，请重新载入':'正在准备采掘设备…',480,320);return;}
    if(this.terrainDirty){const terrain=this.terrain.getContext('2d');terrain.clearRect(0,0,960,640);for(const o of s.items)if(o.type!=='hamster'&&o.owner<0)this.sprite(terrain,o);this.terrainDirty=false;}
    c.drawImage(this.terrain,0,0);
    const time=this.motion?s.elapsed+(s.paused?0:Math.min(.15,(now-this.received)/1000)):0;
    for(const item of s.items)if(item.type==='hamster'||item.owner>=0){const point=this.sample(this.previous.get('i'+item.id),now);this.sprite(c,item,point.x,point.y,time);}
    for(const p of s.players){const pose=this.sample(this.previous.get('p'+p.slot),now);p.claw.angle=pose.angle;p.claw.length=pose.length;this.player(c,p,time);}
    for(const p of this.particles){
      p.life-=dt;p.x+=(p.vx||0)*dt;p.y+=(p.vy||-35)*dt;if(p.vy!==undefined)p.vy+=230*dt;
      c.save();c.globalAlpha=Math.max(0,Math.min(1,p.life/p.max));c.fillStyle=p.color;
      if(p.text){c.translate(p.x,p.y);c.scale(this.artX,this.artY);c.font='bold 32px sans-serif';c.textAlign='center';c.fillText(p.text,0,0);}
      else if(p.ring){c.strokeStyle=p.color;c.lineWidth=8*p.life/p.max;c.beginPath();c.arc(p.x,p.y,100*(1-p.life/p.max),0,Math.PI*2);c.stroke();}
      else{c.translate(p.x,p.y);c.rotate(p.life*4);c.fillRect(-3,-3,6,6);}c.restore();
    }
    this.particles=this.particles.filter(p=>p.life>0);
    if(s.paused||s.phase!=='playing'){
      c.fillStyle='#070e18bb';c.fillRect(0,0,960,640);c.fillStyle='#edf7ff';c.font='bold 34px sans-serif';c.textAlign='center';
      c.save();c.translate(480,305);c.scale(this.artX,this.artY);c.fillText(s.paused?'采掘暂停 · 进度已保留':s.phase==='complete'?'第 1,000 关完成！':'这一趟，满载而归',0,0);
      c.font='18px sans-serif';c.fillText(s.paused?'等待房主继续冒险':'去商店，为下一次出发做准备',0,37);c.restore();
    }
    if((s.phase==='playing'&&!s.paused)||this.particles.length)this.raf=requestAnimationFrame(t=>this.draw(t));
  }
}
