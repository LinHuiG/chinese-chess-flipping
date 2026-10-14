package com.chessflipping.client;

import org.json.*;
import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;

public class SubtitleTimelineTest {
    private JSONObject cue(double start,double end,String text)throws Exception{return new JSONObject().put("start",start).put("end",end).put("text",text);}
    @Test public void absoluteTimeKeepsOverlapAcrossSeekAndTranscodeOffset()throws Exception{
        SubtitleTimeline timeline=SubtitleTimeline.parse(new JSONArray().put(cue(61,62,"second")).put(cue(0,120,"long")).put(cue(60,61,"first")));
        assertEquals(List.of("long","first"),timeline.active((500+60000)/1000.0));
        assertEquals(List.of("long","second"),timeline.active(61));
        assertEquals(List.of("long"),timeline.active(62));assertEquals(List.of("long"),timeline.active(1));
        assertTrue(timeline.active(120).isEmpty());assertTrue(SubtitleTimeline.parse(new JSONArray()).active(60.5).isEmpty());
    }
    @Test public void rejectsUnboundedInvalidCuesAndLeavesPlainTextUntouched()throws Exception{
        assertEquals(List.of("<script>literal</script>\n第二行"),SubtitleTimeline.parse(new JSONArray().put(cue(0,1,"<script>literal</script>\n第二行"))).active(.5));
        for(JSONArray invalid:List.of(new JSONArray().put(cue(-1,1,"bad")),new JSONArray().put(cue(1,1,"bad")),new JSONArray().put(cue(0,1,"x".repeat(8193))))){try{SubtitleTimeline.parse(invalid);fail();}catch(IllegalArgumentException expected){}}
        JSONArray tooMany=new JSONArray();for(int i=0;i<10001;i++)tooMany.put(cue(i,i+1,"line"));try{SubtitleTimeline.parse(tooMany);fail();}catch(IllegalArgumentException expected){}
        JSONArray tooLarge=new JSONArray();for(int i=0;i<257;i++)tooLarge.put(cue(i,i+1,"x".repeat(8192)));try{SubtitleTimeline.parse(tooLarge);fail();}catch(IllegalArgumentException expected){}
    }
}
