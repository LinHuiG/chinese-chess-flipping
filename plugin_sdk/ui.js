import {PluginRoom} from './room.js';
import {bootstrap,call,onHostEvent,storageGet,storageFlush} from './transport.js';
import {installChoices} from './choices.js';
export const $=id=>document.getElementById(id);
export function text(id,value){const e=$(id);if(e&&e.textContent!==String(value))e.textContent=value;}
export function element(tag,className='',value){const e=document.createElement(tag);e.className=className;if(value!==undefined)e.textContent=value;return e;}
let toastTimer,confirmResolve;
export function toast(message){text('toast',message);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4000);}
export const fail=e=>toast(e.message||'操作未完成');
export function confirm(title,message,button='确认'){confirmResolve?.(false);text('confirm-title',title);text('confirm-message',message);text('confirm-ok',button);if(!$('confirm-dialog').open)$('confirm-dialog').showModal();return new Promise(resolve=>confirmResolve=resolve);}
export function mount(rules,view){
  const m=bootstrap.manifest,plugin={...m,feature:m.roomFeature,min:m.room.minMembers,max:m.room.maxMembers,platform:bootstrap.platform,binding:bootstrap.binding};
  const g=new PluginRoom(plugin,rules,{notice:toast,status:s=>{text('connection-status',s);render();},changed:render,network:connections,module:e=>Promise.resolve(view.event?.(e)).catch(fail),native:e=>view.native?.(e),lobby:()=>{if(!g.room&&started)call('plugin.close').catch(fail);},kick:async p=>{if(await confirm('移出成员？','将 '+p.name+' 移出房间。','移出'))g.kick(p.id).catch(fail);}});
  let started=false,lastRound='',lastHostState='';
  function render(){if(!g)return;const r=g.room;$('waiting').hidden=!r||r.status!=='waiting';$(m.key).hidden=!r||r.status==='waiting';
    if(!r)return;started=true;if(lastRound!==r.round){lastRound=r.round;view.round?.();}
    if(r.status==='waiting')waiting();view.render?.();connections();const state={name:r.name,roomId:r.roomId,host:g.host},key=JSON.stringify(state);if(key!==lastHostState){lastHostState=key;call('plugin.state',state).catch(()=>{});}
  }
  function waiting(){const r=g.room,me=r.members.find(p=>p.id===g.self);text('waiting-game',m.name+' / 等候室');text('waiting-name',r.name);text('waiting-id','房间 '+r.roomId.slice(0,8)+' · '+r.members.length+'/'+r.capacity+' 人');
    const key=JSON.stringify([r.members,r.capacity]);if($('players').dataset.key!==key){$('players').dataset.key=key;$('players').replaceChildren();for(let i=0;i<r.capacity;i++){const p=r.members[i],card=element('div','player'+(!p?' vacant':''));card.append(element('span','avatar',p?p.name.slice(0,1):'+'),element('strong','',p?p.name+(p.id===g.self?'（你）':''):'空位'),element('small',p?.ready?'ready-badge':'',p?(p.id===r.hostId?'房主 · ':'')+(p.ready?'已准备':'未准备'):'等待朋友加入'));if(p)card.append(memberBadge(p.id));$('players').append(card);}}
    text('waiting-note','大家准备后自动开始。');text('ready',me?.ready?'取消准备':'准备好了');$('ready').disabled=!g.client.ready;
    $('time-settings').hidden=!view.timeSettings;document.querySelectorAll('[data-seconds]').forEach(b=>{b.disabled=!g.host;b.classList.toggle('selected',+b.dataset.seconds===r.seconds);});
    text('waiting-symbol',m.name.slice(0,1));text('waiting-guide-title',m.name);text('waiting-guide',m.description);document.querySelectorAll('.room-password').forEach(b=>b.hidden=!g.host);
  }
  function connections(){for(const badge of document.querySelectorAll('[data-member-path]')){const value=g.memberConnection(badge.dataset.memberPath);if(badge.textContent!==value.text)badge.textContent=value.text;badge.dataset.path=value.kind;badge.title=value.title;}}
  const action=a=>g.action(a).catch(fail);
  $('ready').onclick=()=>action({type:'READY',ready:!g.room?.members.find(p=>p.id===g.self)?.ready});
  document.querySelectorAll('[data-seconds]').forEach(b=>b.onclick=()=>action({type:'TIME',seconds:+b.dataset.seconds}));
  async function leave(){if(!g.room){await call('plugin.close');return;}if(await confirm(g.host?'解散这个房间？':'离开房间？',g.host?'房主退出后房间立即解散。已保存的进度保留在本机。':'退出后可以从大厅重新加入。','退出房间')){await g.leave();await call('plugin.close');}}
  document.querySelectorAll('.leave').forEach(b=>b.onclick=()=>leave().catch(fail));
  const finish=value=>{$('confirm-dialog').close();const resolve=confirmResolve;confirmResolve=null;resolve?.(value);};$('confirm-ok').onclick=()=>finish(true);$('confirm-cancel').onclick=()=>finish(false);$('confirm-dialog').addEventListener('cancel',e=>{e.preventDefault();finish(false);});
  document.querySelectorAll('.dialog-close').forEach(b=>b.onclick=()=>b.closest('dialog').close());
  document.querySelectorAll('.rules-link').forEach(b=>b.onclick=()=>{text('rules-title',m.name+' · 规则');text('rules-body',bootstrap.rules||m.description);$('rules-dialog').showModal();});
  let passwordContext='';document.querySelectorAll('.room-password').forEach(b=>b.onclick=()=>{passwordContext=g.context();text('password-title','设置房间密码');text('password-hint','留空取消密码，修改不影响现有成员。');$('password-value').value='';$('password-dialog').showModal();});
  $('password-form').onsubmit=e=>{e.preventDefault();if(g.current(passwordContext))g.setPassword($('password-value').value).catch(fail);$('password-value').value='';$('password-dialog').close();};
  onHostEvent(async(name,value)=>{if(name==='back'){const d=document.activeElement?.closest('dialog[open]')||[...document.querySelectorAll('dialog[open]')].at(-1);if(d){if(d.dispatchEvent(new Event('cancel',{cancelable:true}))&&d.open)d.close();}else leave().catch(fail);}if(name==='dispose'){try{await view.event?.({type:'leaving'});await g.saveProgress(false);g.checkpoint();await storageFlush();}catch(e){fail(e);}finally{call('plugin.disposed').catch(()=>{});}}});
  addEventListener('plugin-storage-error',e=>toast(e.detail));
  addEventListener('pagehide',()=>{g.saveProgress(false);g.checkpoint();});
  document.addEventListener('visibilitychange',()=>g.nativeEvent({type:document.hidden?'background':'foreground'}));
  installChoices();queueMicrotask(async()=>{try{await g.client.connect();const c=bootstrap.command;if(c?.mode==='create')await g.create(m.key,c.name,c.capacity,c.continueSave,c.password);else if(c?.mode==='join')await g.join(c.room,m.key,false,c.password);else if(!g.room)await call('plugin.close');render();}catch(e){fail(e);await call('plugin.error',e.message);}});
  return g;
}

export function memberBadge(who){const badge=element('small','member-path');badge.dataset.memberPath=who;return badge;}
export function fullscreen(stage,button){const target=$(stage),toggle=$(button);toggle.onclick=()=>{if(document.fullscreenElement===target)document.exitFullscreen().catch(fail);else if(target.requestFullscreen)target.requestFullscreen().catch(fail);else toast('此浏览器暂不支持全屏');};document.addEventListener('fullscreenchange',()=>{const full=document.fullscreenElement===target;text(button,full?'退出全屏':'全屏');toggle.setAttribute('aria-pressed',String(full));});}
