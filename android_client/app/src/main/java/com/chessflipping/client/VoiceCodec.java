package com.chessflipping.client;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Independent IMA ADPCM blocks; CRV1 is identical on Android, Windows and Web. */
public final class VoiceCodec {
    public static final String NAME="ima-adpcm-16k-v1";
    public static final int SAMPLES=320,BYTES=180;
    private static final int[] INDEX={-1,-1,-1,-1,2,4,6,8};
    private static final int[] STEP={7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767};
    private VoiceCodec(){}
    public static byte[] encode(short[] pcm,int stream,int seq,int clock){
        if(pcm.length!=SAMPLES)throw new IllegalArgumentException("samples");
        byte[] out=new byte[BYTES];ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN).put(new byte[]{'C','R','V','1'}).putInt(stream).putInt(seq).putInt(clock).putShort(pcm[0]).put((byte)0).put((byte)0);
        int predictor=pcm[0],index=0;
        for(int i=1;i<SAMPLES;i++){
            int step=STEP[index],difference=pcm[i]-predictor,code=difference<0?8:0,diff=step>>3;
            difference=Math.abs(difference);
            if(difference>=step){code|=4;difference-=step;diff+=step;}
            if(difference>=step/2){code|=2;difference-=step/2;diff+=step/2;}
            if(difference>=step/4){code|=1;diff+=step/4;}
            predictor=clamp(predictor+((code&8)!=0?-diff:diff));index=Math.max(0,Math.min(88,index+INDEX[code&7]));
            int offset=20+(i-1)/2;out[offset]|=(byte)(code<<(((i-1)&1)*4));
        }
        return out;
    }
    public static short[] decode(byte[] frame){
        if(frame.length!=BYTES||frame[0]!='C'||frame[1]!='R'||frame[2]!='V'||frame[3]!='1'||frame[19]!=0||(frame[18]&255)>88)throw new IllegalArgumentException("voice frame");
        short[] out=new short[SAMPLES];int predictor=ByteBuffer.wrap(frame).order(ByteOrder.LITTLE_ENDIAN).getShort(16),index=frame[18]&255;out[0]=(short)predictor;
        for(int i=1;i<SAMPLES;i++){
            int code=(frame[20+(i-1)/2]>>(((i-1)&1)*4))&15,step=STEP[index],diff=step>>3;
            if((code&4)!=0)diff+=step;if((code&2)!=0)diff+=step>>1;if((code&1)!=0)diff+=step>>2;
            predictor=clamp(predictor+((code&8)!=0?-diff:diff));index=Math.max(0,Math.min(88,index+INDEX[code&7]));out[i]=(short)predictor;
        }
        return out;
    }
    static int clamp(int value){return Math.max(-32768,Math.min(32767,value));}
}
