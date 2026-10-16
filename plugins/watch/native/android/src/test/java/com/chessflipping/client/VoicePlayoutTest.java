package com.chessflipping.client;

import org.junit.Test;
import static org.junit.Assert.*;

public class VoicePlayoutTest {
    private static byte[] frame(int stream,int sequence,int clock){return VoiceCodec.encode(new short[320],stream,sequence,clock);}
    @Test public void delayedTcpCannotSlidePlaybackClockForward(){
        VoiceEngine.Stream s=new VoiceEngine.Stream();s.accept(frame(1,0,0),1000);assertNull(s.poll(1039));assertNotNull(s.poll(1040));
        s.accept(frame(1,1,320),2020);s.accept(frame(1,2,640),2040);assertNull(s.poll(2040));assertEquals(2,s.late);assertEquals(1000,s.anchorAt,0);
        s.accept(frame(1,53,16960),2060);assertNotNull(s.poll(2100));
    }
    @Test public void reorderFillsLossWindowAndDuplicatesAreIgnored(){
        VoiceEngine.Stream s=new VoiceEngine.Stream();s.accept(frame(1,0,0),1000);s.accept(frame(1,2,640),1040);assertEquals(1,s.window-Long.bitCount(s.seen));
        s.accept(frame(1,1,320),1045);assertEquals(0,s.window-Long.bitCount(s.seen));s.accept(frame(1,1,320),1050);assertEquals(3,s.received);assertEquals(3,s.blocks.size());
        assertNotNull(s.poll(1050));assertEquals(0,s.played);assertNotNull(s.poll(1060));assertEquals(1,s.played);
    }
    @Test public void sampleClockWrapAndStreamReplacementAreIndependent(){
        VoiceEngine.Stream s=new VoiceEngine.Stream();s.accept(frame(1,0,-320),1000);s.accept(frame(1,1,0),1020);assertNotNull(s.poll(1040));assertNotNull(s.poll(1060));assertEquals(0,s.late);
        s.accept(frame(2,0,0),9000);assertEquals(9000,s.anchorAt,0);s.accept(frame(1,2,320),9020);assertEquals(2,s.generation);assertEquals(1,s.blocks.size());
    }
    @Test public void queueRemainsBoundedAndOldFramesExpire(){
        VoiceEngine.Stream s=new VoiceEngine.Stream();for(int i=0;i<20;i++)s.accept(frame(1,i,i*320),1000+i*20);assertEquals(6,s.blocks.size());assertNull(s.poll(2000));assertTrue(s.blocks.isEmpty());
    }
}
