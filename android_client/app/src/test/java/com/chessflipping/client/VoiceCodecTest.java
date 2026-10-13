package com.chessflipping.client;

import org.json.*;
import org.junit.Test;
import java.nio.file.*;
import static org.junit.Assert.*;

public class VoiceCodecTest {
    @Test public void matchesSharedIndependentVectors()throws Exception{
        Path fixture=Paths.get("../../scripts/fixtures/voice-crv1.json");
        if(!Files.exists(fixture))fixture=Paths.get("../scripts/fixtures/voice-crv1.json");
        JSONArray vectors=new JSONObject(Files.readString(fixture)).getJSONArray("vectors");
        for(int i=0;i<vectors.length();i++){
            JSONObject vector=vectors.getJSONObject(i);JSONArray raw=vector.getJSONArray("pcm"),expected=vector.getJSONArray("decoded");short[] pcm=new short[raw.length()],decoded=new short[expected.length()];
            for(int n=0;n<pcm.length;n++){pcm[n]=(short)raw.getInt(n);decoded[n]=(short)expected.getInt(n);}
            byte[] bytes=hex(vector.getString("packetHex"));assertArrayEquals(vector.getString("name"),decoded,VoiceCodec.decode(bytes));
            if(vector.getInt("initialIndex")==0)assertArrayEquals(vector.getString("name"),bytes,VoiceCodec.encode(pcm,vector.getInt("stream"),vector.getInt("sequence"),(int)vector.getLong("sampleClock")));
        }
    }
    @Test public void rejectsMalformedFrame(){for(byte[] frame:new byte[][]{new byte[179],new byte[180]})try{VoiceCodec.decode(frame);fail();}catch(IllegalArgumentException expected){}}
    private static byte[] hex(String s){byte[] result=new byte[s.length()/2];for(int i=0;i<result.length;i++)result[i]=(byte)Integer.parseInt(s.substring(i*2,i*2+2),16);return result;}
}
