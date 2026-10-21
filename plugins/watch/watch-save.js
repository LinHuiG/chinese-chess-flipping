import {native,storageGet,storageSet,storageFlush,secureRead,secureWrite} from '../../plugin_sdk/transport.js';

const key='cyber.watch.host.v1';
const text=(value,max=512)=>typeof value==='string'?value.slice(0,max):'';
const number=(value,fallback=0)=>Number.isFinite(value)&&value>=0?value:fallback;
function base(value){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash?url.href.replace(/\/$/,''):'';}catch{return '';}}
// Persist only stable identifiers and preferences, never a stream URL, password,
// room membership, microphone state, or an Emby playback session.
export function cleanWatchSave(value){
  if(value?.version!==1)return null;
  const source=value.source||{},address=base(source.base),userId=text(source.userId),token=text(source.token,8192);
  if(!address||!userId||!token)return null;
  const settings=value.settings||{},play=value.playback;
  const playback=play&&text(play.itemId)?{itemId:text(play.itemId),title:text(play.title),...(text(play.seriesId)?{seriesId:text(play.seriesId),seriesName:text(play.seriesName),season:Number.isInteger(play.season)?play.season:null,episode:Number.isInteger(play.episode)?play.episode:null}:{}),duration:number(play.duration),position:number(play.position),rate:[.5,.75,1,1.25,1.5,2].includes(play.rate)?play.rate:1,audioIndex:Number.isInteger(play.audioIndex)&&play.audioIndex>=0?play.audioIndex:null,subtitleIndex:Number.isInteger(play.subtitleIndex)&&play.subtitleIndex>=0?play.subtitleIndex:-1,audioExplicit:play.audioExplicit===true,burnSubtitle:play.burnSubtitle===true,compatibility:play.compatibility===true}:null;
  if(playback?.duration>0)playback.position=Math.min(playback.duration,playback.position);
  return {version:1,savedAt:number(value.savedAt),source:{base:address,...(base(source.webBase)?{webBase:base(source.webBase)}:{}),userId,token,username:text(source.username),serverId:text(source.serverId),canTranscode:source.canTranscode===true},settings:{quality:['auto','1080','720','480'].includes(settings.quality)?settings.quality:'auto',volume:Math.min(1,number(settings.volume,1)),muted:settings.muted===true},playback};
}
let writes=Promise.resolve();
export async function readWatchSave(){
  await writes;
  if(!native)return cleanWatchSave(storageGet(key));
  const value=await secureRead();return cleanWatchSave(typeof value==='string'?JSON.parse(value):value);
}
export function writeWatchSave(value){
  const saved=cleanWatchSave(value);
  if(!native){if(!storageSet(key,saved))return Promise.reject(Error('本机存档失败，请检查浏览器存储空间'));return storageFlush();}
  const serialized=JSON.stringify(saved),next=writes.catch(()=>{}).then(()=>secureWrite(serialized));writes=next.catch(()=>{});return next;
}
