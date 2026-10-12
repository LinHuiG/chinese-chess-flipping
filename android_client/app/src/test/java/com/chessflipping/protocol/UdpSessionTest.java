package com.chessflipping.protocol;
import org.junit.Test;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static org.junit.Assert.*;
public class UdpSessionTest {
    private static WireProtocol.Packet packet(byte[] bytes){return new WireProtocol.Packet(64,new byte[0],bytes);}
    @Test public void replayReorderingAndTamper()throws Exception{
        byte[] key=new byte[32];Arrays.fill(key,(byte)7);String context="12345678901234567890123456789012";
        try(UdpSession a=new UdpSession(context,key,true);UdpSession b=new UdpSession(context,key,false)){
            byte[] first=a.encrypt(packet(new byte[]{1})),second=a.encrypt(packet(new byte[]{2})),forged=second.clone();forged[forged.length-1]^=1;
            assertThrows(java.security.GeneralSecurityException.class,()->b.decrypt(forged,forged.length));
            assertArrayEquals(new byte[]{2},b.decrypt(second,second.length).body);
            assertArrayEquals(new byte[]{1},b.decrypt(first,first.length).body);assertNull(b.decrypt(first,first.length));
            byte[] reply=b.encrypt(packet(new byte[]{3}));assertArrayEquals(new byte[]{3},a.decrypt(reply,reply.length).body);
            assertNull(a.decrypt(first,first.length)); // Directional nonce prefix rejects reflection.
            byte[] stale=a.encrypt(packet(new byte[]{4})),last=null;
            for(int i=0;i<70;i++)last=a.encrypt(packet(new byte[]{5}));
            assertNotNull(b.decrypt(last,last.length));assertNull(b.decrypt(stale,stale.length));
            assertEquals(1200,a.encrypt(packet(new byte[1155])).length);
            assertThrows(java.io.IOException.class,()->a.encrypt(packet(new byte[1156])));
        }
    }
    @Test public void controlAndRawBodyPreserveBytes()throws Exception{
        byte[] control="op:200\ntrace:x:y\ncustom:one\ncustom:two\n".getBytes(StandardCharsets.UTF_8),body={0,-1,12,0};
        byte[] bytes=WireProtocol.plain(new WireProtocol.Packet(16,control,body));WireProtocol.Packet p=WireProtocol.plain(WireProtocol.decode(bytes));
        assertArrayEquals(control,p.control);assertArrayEquals(body,p.body);assertEquals("200",WireProtocol.control(control).get("op"));
        assertThrows(java.io.IOException.class,()->WireProtocol.control("to:a\nto:b\n".getBytes(StandardCharsets.UTF_8)));
        bytes[14]=2;assertThrows(java.io.IOException.class,()->WireProtocol.decode(bytes));
    }
}
