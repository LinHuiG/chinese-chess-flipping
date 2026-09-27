package com.chessflipping.protocol;

import org.junit.jupiter.api.Test;
import java.io.*;
import java.nio.ByteBuffer;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.util.Arrays;
import java.util.HexFormat;
import static org.junit.jupiter.api.Assertions.*;

class KeyExchangeTest {
    @Test void hkdfMatchesRfc5869TestCaseOne() throws Exception {
        HexFormat hex = HexFormat.of();
        byte[] ikm = new byte[22];
        Arrays.fill(ikm, (byte)0x0b);
        byte[] result = KeyExchange.hkdf(ikm, hex.parseHex("000102030405060708090a0b0c"),
                hex.parseHex("f0f1f2f3f4f5f6f7f8f9"), 42);
        assertEquals("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865", hex.formatHex(result));
    }

    @Test void rejectsOtherCurvesAndMalformedPublicKeys() throws Exception {
        var generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp384r1"));
        assertThrows(Exception.class, () -> KeyExchange.publicKey(KeyExchange.hello(generator.generateKeyPair())));
        assertThrows(Exception.class, () -> KeyExchange.publicKey(new byte[64]));
        assertThrows(Exception.class, () -> KeyExchange.publicKey(new byte[32]));
    }

    @Test void streamReaderDistinguishesCleanEofFromTruncatedFrameAndBoundsAllocation() throws Exception {
        byte[] valid = WireProtocol.plain(new WireProtocol.Packet(1, new byte[]{'{', '}'}, new byte[0]));
        assertNull(WireProtocol.read(new ByteArrayInputStream(new byte[0])));
        for (int length = 1; length < valid.length; length++) {
            byte[] truncated = Arrays.copyOf(valid, length);
            assertThrows(EOFException.class, () -> WireProtocol.read(new ByteArrayInputStream(truncated)));
        }
        assertEquals(1, WireProtocol.read(new ByteArrayInputStream(valid)).type);
        byte[] excessive = valid.clone();
        ByteBuffer.wrap(excessive).putInt(WireProtocol.TOTAL_OFFSET, Integer.MAX_VALUE);
        assertThrows(IOException.class, () -> WireProtocol.read(new ByteArrayInputStream(excessive)));
    }

    @Test void closedSessionsCannotBeUsedAndDirectionsCannotBeReflected() throws Exception {
        var server = KeyExchange.generateKeyPair();
        var client = KeyExchange.generateKeyPair();
        byte[] serverHello = KeyExchange.hello(server), clientHello = KeyExchange.hello(client);
        try (SecureSession session = KeyExchange.derive(true, client, serverHello, clientHello, new byte[32])) {
            byte[] frame = session.encrypt(new WireProtocol.Packet(32, new byte[]{'{', '}'}, new byte[]{'{', '}'}));
            assertThrows(Exception.class, () -> session.decrypt(WireProtocol.decode(frame)));
            session.close();
            assertThrows(IOException.class, () -> session.encrypt(new WireProtocol.Packet(32, new byte[]{'{', '}'}, new byte[0])));
        }
    }
}
