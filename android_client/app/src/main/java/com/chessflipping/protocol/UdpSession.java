package com.chessflipping.protocol;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.io.IOException;
import java.util.Arrays;

/** v3 datagram = the TCP frame layout; receive permits authenticated reordering. */
public final class UdpSession implements AutoCloseable {
    public static final int MAX_PACKET=1200;
    private final byte[] sendKey,receiveKey,sendPrefix,receivePrefix;
    private long outgoing,highest=-1,seen;private boolean closed;
    public UdpSession(String context,byte[] master,boolean initiator)throws GeneralSecurityException{
        if(master.length!=32||!context.matches("[0-9a-f]{32}"))throw new GeneralSecurityException("UDP key");
        byte[] material=KeyExchange.hkdf(master,MessageDigest.getInstance("SHA-256").digest(context.getBytes(StandardCharsets.UTF_8)),
            "cyber-room/udp/v3".getBytes(StandardCharsets.UTF_8),72);
        sendKey=Arrays.copyOfRange(material,initiator?0:32,initiator?32:64);receiveKey=Arrays.copyOfRange(material,initiator?32:0,initiator?64:32);
        sendPrefix=Arrays.copyOfRange(material,initiator?64:68,initiator?68:72);receivePrefix=Arrays.copyOfRange(material,initiator?68:64,initiator?72:68);
        Arrays.fill(material,(byte)0);
    }
    public synchronized byte[] encrypt(WireProtocol.Packet packet)throws GeneralSecurityException,IOException{
        if(closed||outgoing>=0xffff_ffffL)throw new GeneralSecurityException("UDP expired");
        byte[] header=WireProtocol.header(packet,true);if(ByteBuffer.wrap(header).getInt(2)>MAX_PACKET)throw new IOException("Datagram too large");
        byte[] nonce=ByteBuffer.allocate(12).put(sendPrefix).putLong(outgoing++).array();
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(sendKey,"AES"),new GCMParameterSpec(128,nonce));
        cipher.updateAAD(header);return WireProtocol.join(header,nonce,cipher.doFinal(WireProtocol.join(packet.control,packet.body)));
    }
    public synchronized WireProtocol.Packet decrypt(byte[] packet,int length)throws GeneralSecurityException,IOException{
        if(closed||length<45||length>MAX_PACKET)return null;
        // Reject another peer's nonce prefix before allocating and parsing its entire frame.
        for(int i=0;i<4;i++)if(packet[WireProtocol.HEADER_SIZE+i]!=receivePrefix[i])return null;
        WireProtocol.Frame frame=WireProtocol.decode(Arrays.copyOf(packet,length));if(!frame.encrypted)return null;
        byte[] payload=frame.payload(),nonce=Arrays.copyOf(payload,12);
        if(!MessageDigest.isEqual(Arrays.copyOf(nonce,4),receivePrefix))return null;
        long sequence=ByteBuffer.wrap(nonce).getLong(4),age=highest-sequence;
        if(sequence<0||sequence>=0xffff_ffffL||age>=64||(age>=0&&(seen&(1L<<age))!=0))return null;
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,new SecretKeySpec(receiveKey,"AES"),new GCMParameterSpec(128,nonce));cipher.updateAAD(frame.aad());
        byte[] plain=cipher.doFinal(payload,12,payload.length-12);
        if(sequence>highest){long shift=sequence-highest;seen=shift>=64?1:(seen<<shift)|1;highest=sequence;}else seen|=1L<<age;
        return WireProtocol.split(frame,plain);
    }
    @Override public synchronized void close(){closed=true;for(byte[] b:new byte[][]{sendKey,receiveKey,sendPrefix,receivePrefix})Arrays.fill(b,(byte)0);}
}
