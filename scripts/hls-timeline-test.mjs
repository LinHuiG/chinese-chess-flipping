import assert from 'node:assert/strict';
import {playlistTimeline} from '../plugins/watch/hls-timeline.js';
const playlist=(lengths,extra='')=>'#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n'+extra+lengths.map((n,i)=>'#EXTINF:'+n+',\nsegment'+i+'.ts\n').join('')+'#EXT-X-ENDLIST\n';
const absolute={offset:0,absolute:true},relative=offset=>({offset,absolute:false});
const start=110.7206333,duration=1440;
// Real Emby shape: 481 segments, a complete film timeline, and a rounded
// absolute start hint despite a nonzero StartTimeTicks request.
const full=playlist([...Array(480).fill(2.999),.48],'#EXT-X-START:TIME-OFFSET=111,PRECISE=YES\n');
assert.deepEqual(playlistTimeline(full,start,duration),absolute);
assert.deepEqual(playlistTimeline(full.replace('#EXT-X-START:TIME-OFFSET=111,PRECISE=YES\n',''),start,duration),absolute,'complete duration is independent evidence');
assert.deepEqual(playlistTimeline('#EXTM3U\n#EXT-X-START:PRECISE=YES,TIME-OFFSET=111\n',start,undefined),absolute,'attribute ordering does not change the start hint');
assert.deepEqual(playlistTimeline(full,start,NaN),absolute,'valid absolute start does not require duration metadata');
for(const value of [.1,.2,.75])assert.deepEqual(playlistTimeline(playlist([3,3,3],'#EXT-X-START:TIME-OFFSET='+value+'\n'),value,undefined),absolute,'positive starts below one second retain their absolute evidence');
assert.deepEqual(playlistTimeline(playlist([3,3,3,3]),start,duration),relative(start),'cut playlists retain their relative offset');
for(const hint of ['0','-3','2','invalid'])assert.deepEqual(playlistTimeline(playlist([3,3,3],'#EXT-X-START:TIME-OFFSET='+hint+'\n'),start,duration),relative(start));
assert.deepEqual(playlistTimeline(playlist([1439.8]),.2,1440),relative(.2),'a short initial cut must not fit the full-duration rounding tolerance');
assert.deepEqual(playlistTimeline(playlist([720,719.8]),start,duration),absolute,'small segment/metadata rounding is accepted');
assert.deepEqual(playlistTimeline(full,0,duration),absolute,'zero start still parses the complete duration');
assert.deepEqual(playlistTimeline(playlist([720,719.8]),0,duration),absolute,'zero start permits full-duration rounding');
assert.deepEqual(playlistTimeline(playlist([3,3,3],'#EXT-X-START:TIME-OFFSET=0\n'),0,duration),relative(0),'zero start alone cannot identify a complete playlist');
assert.deepEqual(playlistTimeline(playlist([3,3,3]),0,undefined),relative(0),'zero start with missing duration is not absolute evidence');
for(const text of [undefined,null,'','not a playlist','#EXTM3U\n','#EXT-X-START:TIME-OFFSET=invalid\n','#EXTM3U\n#EXTINF:nope,\nsegment.ts\n']){
  assert.deepEqual(playlistTimeline(text,start,duration),relative(start));
  assert.deepEqual(playlistTimeline(text,0,duration),relative(0));
}
for(const value of [undefined,NaN,Infinity,0,-1])assert.deepEqual(playlistTimeline(playlist([3,3,3]),start,value),relative(start),'invalid duration does not identify a complete playlist');
assert.deepEqual(playlistTimeline('#EXTM3U\n#EXTINF:bogus,\n#EXTINF:1440,\nlast.ts\n',start,duration),relative(start),'partial sums from malformed manifests are not evidence');
for(const value of [-1,NaN,Infinity,undefined]){
  assert.deepEqual(playlistTimeline(full,value,duration),absolute,'complete duration remains evidence when start is invalid');
  assert.deepEqual(playlistTimeline(playlist([3,3,3]),value,duration),relative(0),'invalid start is normalized without inventing absolute evidence');
}
assert.deepEqual(playlistTimeline('\ufeff'+full.replaceAll('\n','\r\n'),start,duration),absolute,'BOM and CRLF are accepted');
console.log('PASS HLS timeline: single-pass absolute/relative classification, 481-segment Emby manifest, subsecond/zero starts and malformed metadata');
