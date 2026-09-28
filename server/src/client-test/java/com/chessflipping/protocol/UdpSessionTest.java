package com.chessflipping.protocol;

import org.junit.jupiter.api.Test;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class UdpSessionTest {
    @Test void reorderedPacketsAuthenticateWithoutAdvancingWindowOnForgery() throws Exception {
        byte[] key=new byte[32];new SecureRandom().nextBytes(key);String id="12345678901234567890123456789012";
        try(UdpSession a=new UdpSession(id,key,"game-a",true);UdpSession b=new UdpSession(id,key,"game-a",false)){
            byte[] first=a.encrypt(3,"first".getBytes(StandardCharsets.UTF_8)),second=a.encrypt(3,"second".getBytes(StandardCharsets.UTF_8));
            byte[] forged=second.clone();forged[27]=100;
            assertThrows(java.security.GeneralSecurityException.class,()->b.decrypt(forged,forged.length));
            assertEquals("second",new String(b.decrypt(second,second.length).body,StandardCharsets.UTF_8));
            assertEquals("first",new String(b.decrypt(first,first.length).body,StandardCharsets.UTF_8));
            assertNull(b.decrypt(first,first.length));
            byte[] response=b.encrypt(4,new byte[]{1});assertNotNull(a.decrypt(response,response.length));
            assertNull(a.decrypt(first,first.length)); // Already seen sequence is dropped before crypto.
            byte[] reflected=a.encrypt(3,new byte[]{2});
            assertThrows(java.security.GeneralSecurityException.class,()->a.decrypt(reflected,reflected.length));
        }
    }
    @Test void sessionsSizeAndReplayWindowAreBounded() throws Exception {
        byte[] key=new byte[32];new SecureRandom().nextBytes(key);String id="12345678901234567890123456789012";
        try(UdpSession a=new UdpSession(id,key,"one",true);UdpSession b=new UdpSession(id,key,"one",false);UdpSession other=new UdpSession(id,key,"two",false)){
            byte[] first=a.encrypt(1,new byte[8]);assertThrows(java.security.GeneralSecurityException.class,()->other.decrypt(first,first.length));
            byte[] last=null;for(int i=0;i<70;i++)last=a.encrypt(1,new byte[8]);assertNotNull(b.decrypt(last,last.length));assertNull(b.decrypt(first,first.length));
            assertEquals(1200,a.encrypt(3,new byte[UdpSession.MAX_PAYLOAD]).length);
            assertThrows(java.security.GeneralSecurityException.class,()->a.encrypt(3,new byte[UdpSession.MAX_PAYLOAD+1]));
        }
    }
}
