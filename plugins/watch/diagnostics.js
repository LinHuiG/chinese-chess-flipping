// Allowlisted fields only: never record URLs, credentials, subtitle text or headers.
const fields=new Set(['sessionId','platform','itemId','epoch','playbackId','generation','index','cues','offset','elapsedMs','status','code','stage','mode']);
const entries=[];
export function watchLog(event,details={}){
  const row={time:new Date().toISOString(),event};
  for(const [key,value] of Object.entries(details))if(fields.has(key)&&(typeof value==='number'||typeof value==='boolean'||typeof value==='string'&&/^[\w .:-]{0,160}$/.test(value)))row[key]=value;
  entries.push(row);if(entries.length>300)entries.shift();
}
export function diagnosticsText(){return JSON.stringify({format:1,component:'watch',entries},null,2);}
