package com.chessflipping.protocol;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Arrays;

/** Per-connection directional keys and monotonically increasing nonces. */
public final class SecureSession implements AutoCloseable {
    private final byte[] sendKey, receiveKey, sendPrefix, receivePrefix;
    private long sendSequence, receiveSequence;
    private boolean closed;
    private static final long MAX_PACKETS = 0xffff_ffffL;

    SecureSession(boolean client, byte[] material) {
        byte[] c2s = Arrays.copyOfRange(material, 0, 32), s2c = Arrays.copyOfRange(material, 32, 64);
        byte[] cp = Arrays.copyOfRange(material, 64, 68), sp = Arrays.copyOfRange(material, 68, 72);
        sendKey = client ? c2s : s2c;
        receiveKey = client ? s2c : c2s;
        sendPrefix = client ? cp : sp;
        receivePrefix = client ? sp : cp;
    }

    public synchronized byte[] encrypt(WireProtocol.Packet packet) throws IOException, GeneralSecurityException {
        check(sendSequence);
        byte[] header = WireProtocol.header(packet, true), nonce = nonce(sendPrefix, sendSequence);
        Cipher cipher = cipher(Cipher.ENCRYPT_MODE, sendKey, nonce);
        cipher.updateAAD(Arrays.copyOf(header, WireProtocol.CRC_OFFSET));
        byte[] ciphertext = cipher.doFinal(WireProtocol.join(packet.control, packet.body));
        byte[] frame = WireProtocol.assemble(header, WireProtocol.join(nonce, ciphertext));
        sendSequence++;
        return frame;
    }

    public synchronized WireProtocol.Packet decrypt(WireProtocol.Frame frame) throws IOException, GeneralSecurityException {
        check(receiveSequence);
        if (!frame.encrypted) throw new IOException("Plaintext forbidden after key exchange");
        byte[] payload = frame.payload(), nonce = Arrays.copyOf(payload, 12);
        if (!MessageDigest.isEqual(nonce, nonce(receivePrefix, receiveSequence)))
            throw new GeneralSecurityException("Replayed or out-of-order packet");
        Cipher cipher = cipher(Cipher.DECRYPT_MODE, receiveKey, nonce);
        cipher.updateAAD(frame.aad());
        WireProtocol.Packet packet = WireProtocol.split(frame, cipher.doFinal(payload, 12, payload.length - 12));
        receiveSequence++;
        return packet;
    }

    private void check(long sequence) throws IOException {
        if (closed || sequence >= MAX_PACKETS) throw new IOException("Session expired");
    }

    private static byte[] nonce(byte[] prefix, long sequence) {
        return ByteBuffer.allocate(12).put(prefix).putLong(sequence).array();
    }

    private static Cipher cipher(int mode, byte[] key, byte[] nonce) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(mode, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        return cipher;
    }

    @Override public synchronized void close() {
        closed = true;
        Arrays.fill(sendKey, (byte)0);
        Arrays.fill(receiveKey, (byte)0);
        Arrays.fill(sendPrefix, (byte)0);
        Arrays.fill(receivePrefix, (byte)0);
    }
}
