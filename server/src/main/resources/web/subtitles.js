// Full-file Emby WebVTT subtitles, normalized to safe plain text and absolute
// movie seconds. Deliberately ignores layout/style metadata; never render HTML.
const MAX_BYTES=2*1024*1024,MAX_CUES=10000,MAX_TEXT=8192;
function timestamp(value){
  const m=/^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
  if(!m||Number(m[2])>59||Number(m[3])>59)return NaN;
  return Number(m[1]||0)*3600+Number(m[2])*60+Number(m[3])+Number(m[4])/1000;
}
function plain(value){
  const entities={amp:'&',lt:'<',gt:'>',nbsp:'\u00a0',lrm:'\u200e',rlm:'\u200f',quot:'"',apos:"'"};
  return value.replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi,'').replace(/<[^>]*>/g,'')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|nbsp|lrm|rlm|quot|apos);/gi,(match,key)=>{
      if(key[0]!=='#')return entities[key.toLowerCase()]||match;
      const hex=key[1].toLowerCase()==='x',code=Number.parseInt(key.slice(hex?2:1),hex?16:10);
      return code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):'\ufffd';
    }).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim();
}
export function parseVtt(text){
  if(typeof text!=='string'||text.length>MAX_BYTES||new TextEncoder().encode(text).length>MAX_BYTES)throw Error('字幕文件过大');
  const lines=text.replace(/^\ufeff/,'').replace(/\r\n?/g,'\n').split('\n');
  if(!/^WEBVTT(?:[ \t].*)?$/.test(lines.shift()||''))throw Error('片源未返回有效的 WebVTT 字幕');
  const cues=[];
  for(let i=0;i<lines.length;){
    while(i<lines.length&&!lines[i].trim())i++;
    if(i>=lines.length)break;
    const first=lines[i++];
    if(/^(?:NOTE(?:[ \t]|$)|STYLE$|REGION$|X-TIMESTAMP-MAP=)/.test(first)){
      while(i<lines.length&&lines[i].trim())i++;
      continue;
    }
    const timing=first.includes('-->')?first:(lines[i]?.includes('-->')?lines[i++]:null);
    if(!timing)continue;
    const m=/^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(timing),body=[];
    while(i<lines.length&&lines[i].trim())body.push(lines[i++]);
    if(!m)continue;
    const start=timestamp(m[1]),end=timestamp(m[2]);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start)continue;
    const content=plain(body.join('\n'));if(!content)continue;
    if(content.length>MAX_TEXT||cues.length>=MAX_CUES)throw Error('字幕内容超出支持范围');
    cues.push({start,end,text:content});
  }
  return cues.sort((a,b)=>a.start-b.start||a.end-b.end);
}
