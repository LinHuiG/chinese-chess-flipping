package com.chessflipping.protocol;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.Arrays;

/** Datagram v1: bounded packets, directional keys and an authenticated 64-packet replay window. */
public final class UdpSession implements AutoCloseable {
    public static final int MAX_PACKET = 1200, HEADER = 31, MAX_PAYLOAD = MAX_PACKET - HEADER - 16;
    private final byte[] sessionId, sendKey, receiveKey, sendPrefix, receivePrefix;
    private final Cipher sender, receiver;
    private long outgoing, highest = -1, seen;
    private boolean closed;
    public static final class Packet {
        public final int type; public final byte[] body;
        Packet(int type, byte[] body) { this.type = type; this.body = body; }
    }
    public UdpSession(String id, byte[] master, String context, boolean host) throws GeneralSecurityException {
        if (master.length != 32) throw new GeneralSecurityException("Invalid master key");
        sessionId = hex(id);
        byte[] material = KeyExchange.hkdf(master, MessageDigest.getInstance("SHA-256").digest(sessionId),
                ("chess-flipping/udp/v1|" + context).getBytes(StandardCharsets.UTF_8), 72);
        sendKey = Arrays.copyOfRange(material, host ? 0 : 32, host ? 32 : 64);
        receiveKey = Arrays.copyOfRange(material, host ? 32 : 0, host ? 64 : 32);
        sendPrefix = Arrays.copyOfRange(material, host ? 64 : 68, host ? 68 : 72);
        receivePrefix = Arrays.copyOfRange(material, host ? 68 : 64, host ? 72 : 68);
        Arrays.fill(material, (byte) 0);
        sender = Cipher.getInstance("AES/GCM/NoPadding"); receiver = Cipher.getInstance("AES/GCM/NoPadding");
    }
    public synchronized byte[] encrypt(int type, byte[] body) throws GeneralSecurityException {
        if (closed || outgoing >= 0xffff_ffffL || body.length > MAX_PAYLOAD || type < 1 || type > 4)
            throw new GeneralSecurityException("UDP session or packet limit");
        long sequence = outgoing++;
        byte[] packet = new byte[HEADER + body.length + 16];
        ByteBuffer.wrap(packet).putInt(0x43465031).put(sessionId).putLong(sequence).put((byte) type).putShort((short) body.length);
        sender.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(sendKey, "AES"), new GCMParameterSpec(128, nonce(sendPrefix, sequence)));
        sender.updateAAD(packet, 0, HEADER); sender.doFinal(body, 0, body.length, packet, HEADER);
        return packet;
    }
    public synchronized Packet decrypt(byte[] packet, int length) throws GeneralSecurityException {
        if (closed || length < HEADER + 16 || length > MAX_PACKET) return null;
        ByteBuffer in = ByteBuffer.wrap(packet, 0, length);
        if (in.getInt() != 0x43465031) return null;
        for (byte b : sessionId) if (in.get() != b) return null;
        long sequence = in.getLong(); int type = in.get() & 255, size = in.getShort() & 65535;
        if (sequence < 0 || sequence >= 0xffff_ffffL || type < 1 || type > 4 || size + HEADER + 16 != length) return null;
        long age = highest - sequence;
        if (age >= 64 || (age >= 0 && (seen & (1L << age)) != 0)) return null;
        receiver.init(Cipher.DECRYPT_MODE, new SecretKeySpec(receiveKey, "AES"), new GCMParameterSpec(128, nonce(receivePrefix, sequence)));
        receiver.updateAAD(packet, 0, HEADER);
        byte[] body = receiver.doFinal(packet, HEADER, size + 16);
        // Never move the replay window until the authentication tag has been verified.
        if (sequence > highest) { long shift = sequence - highest; seen = shift >= 64 ? 1 : (seen << shift) | 1; highest = sequence; }
        else seen |= 1L << age;
        return new Packet(type, body);
    }
    private static byte[] nonce(byte[] prefix, long sequence) { return ByteBuffer.allocate(12).put(prefix).putLong(sequence).array(); }
    public static byte[] hex(String value) {
        if (value.length() != 32) throw new IllegalArgumentException("Invalid identifier");
        byte[] out = new byte[16];
        for (int i = 0; i < 16; i++) { int a = Character.digit(value.charAt(i * 2), 16), b = Character.digit(value.charAt(i * 2 + 1), 16);
            if (a < 0 || b < 0) throw new IllegalArgumentException("Invalid identifier"); out[i] = (byte) (a * 16 + b); }
        return out;
    }
    @Override public synchronized void close() { closed = true; for (byte[] b : new byte[][]{sendKey,receiveKey,sendPrefix,receivePrefix}) Arrays.fill(b, (byte) 0); }
}
