import {storageGet} from './transport.js';
// Fixed upgrade map only. A plugin manifest cannot request another plugin's or the host's keys.
export function migrateLegacyData(id,values){
  const keys={'official.miner':['cyber.miner.save'],'official.watch':['cyber.watch.host.v1','cyber.emby.base']}[id]||[];
  let changed=false;for(const key of keys)if(!(key in values)){const old=storageGet(key);if(old!==null){values[key]=old;changed=true;}}
  return changed;
}
