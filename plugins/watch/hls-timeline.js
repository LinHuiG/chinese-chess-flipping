// Emby can return either a full-film playlist with an absolute EXT-X-START,
// or a newly cut playlist whose local clock begins at zero. Only add the
// requested start to the latter. Absolute describes the timeline, not whether
// the server has already generated every segment or can reuse its encoder.
export function playlistTimeline(text,start,duration){
  const offset=Number.isFinite(start)&&start>0?start:0;
  const relative={offset,absolute:false};
  if(typeof text!=='string'||!/^#EXTM3U(?:\r?\n|$)/.test(text.trimStart()))return relative;
  let total=0,segments=0,invalid=false,absoluteStart=false;
  for(const raw of text.split('\n')){
    const line=raw.trim();
    if(line.startsWith('#EXT-X-START:')){
      const match=/(?:^|,)\s*TIME-OFFSET\s*=\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(?=,|$)/.exec(line.slice(13));
      const hint=match?Number(match[1]):NaN;
      // The server may round the start hint to an integer second. A zero or
      // negative hint is not evidence of an absolute positive movie position.
      if(offset>0&&hint>0&&Number.isFinite(hint)&&Math.abs(hint-offset)<=Math.min(.5,offset/2)+1e-6)absoluteStart=true;
    }
    if(line.startsWith('#EXTINF:')){
      const match=/^#EXTINF:\s*(\d+(?:\.\d*)?|\.\d+)\s*(?:,.*)?$/.exec(line);
      const length=match?Number(match[1]):NaN;
      if(!Number.isFinite(length)||length<=0)invalid=true;
      else{total+=length;segments++;}
    }
  }
  // Allow manifest/metadata rounding, but do not mistake a short cut near the
  // beginning of a film for a complete playlist merely because it is close.
  const tolerance=offset>0?Math.min(1,offset/2):1;
  const fullDuration=!invalid&&segments>0&&Number.isFinite(total)&&Number.isFinite(duration)&&duration>0&&Math.abs(total-duration)<=tolerance+1e-6;
  return absoluteStart||fullDuration?{offset:0,absolute:true}:relative;
}
