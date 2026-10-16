import {object} from '../../plugin_sdk/transport.js';
export const rules={
  tickMs:1000,initialStatus:'watching',perform:()=> '观影由房主控制',
  joinData:g=>g.mediaAccess?{access:g.mediaAccess}:{},
  message(g,m){const c=m.control;if(c.type==='voice'){g.events.module?.({type:'voice',from:c.from,bytes:m.rawBody});return true;}if(c.type?.startsWith('watch.')){g.events.module?.({type:c.type,from:c.from,body:object(m.rawBody)});return true;}return false;}
};
