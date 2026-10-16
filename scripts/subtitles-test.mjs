import './plugin-test-host.mjs';
import assert from 'node:assert/strict';
import {parseVtt} from '../plugins/watch/subtitles.js';

const cues=parseVtt('\ufeffWEBVTT\r\n\r\nNOTE ignored\r\n00:00.000 --> 00:10.000\r\nnot a cue\r\n\r\nSTYLE\r\n::cue { color: red; }\r\n\r\nsecond\r\n01:00:02.125 --> 01:00:04.250 line:90%\r\n<v Guest><b>你好</b> &amp; <ruby>字<rt>zi</rt></ruby>\r\n下一行 &#x1f680;\r\n\r\n00:01.000 --> 00:02.000\r\n&lt;img src=x onerror=alert(1)&gt;\r\n\r\n00:01.500 --> 00:03.000\r\n重叠字幕\r\n');
assert.deepEqual(cues,[{start:1,end:2,text:'<img src=x onerror=alert(1)>'},{start:1.5,end:3,text:'重叠字幕'},{start:3602.125,end:3604.25,text:'你好 & 字\n下一行 🚀'}]);
// A transcoded video starting at 3600 seconds still uses absolute cue times.
const active=(time)=>cues.filter(c=>c.start<=time&&c.end>time).map(c=>c.text);
assert.equal(active(2).length,1);assert.equal(active(3600+2.2)[0],'你好 & 字\n下一行 🚀');assert.deepEqual(active(3604.25),[]);
assert.deepEqual(parseVtt('WEBVTT\n\n'),[]);
assert.deepEqual(parseVtt('WEBVTT\n\n00:62.000 --> 01:05.000\nbad\n\n00:05.000 --> 00:04.000\nbackwards\n\n00:06.000 --> 00:06.000\nzero'),[]);
assert.equal(parseVtt('WEBVTT\n\n00:01.000 --> 00:02.000\n&#0; &#xD800; &#x110000; &nbsp;')[0].text,'� � �');
assert.throws(()=>parseVtt('<html>unauthorized</html>'),/WebVTT/);
assert.throws(()=>parseVtt('WEBVTT\n\n'+ '中'.repeat(800000)),/过大/);
assert.throws(()=>parseVtt('WEBVTT\n\n00:01.000 --> 00:02.000\n'+'a'.repeat(8193)),/范围/);
assert.throws(()=>parseVtt('WEBVTT\n\n'+ '00:01.000 --> 00:02.000\nx\n\n'.repeat(10001)),/范围/);
console.log('PASS WebVTT timing, multiline, safe text, overlap, transcode offset, malformed cues and bounded input');
