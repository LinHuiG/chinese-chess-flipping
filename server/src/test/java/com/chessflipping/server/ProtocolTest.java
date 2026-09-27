package com.chessflipping.server;

import com.chessflipping.protocol.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import io.netty.channel.embedded.EmbeddedChannel;
import io.netty.handler.timeout.IdleStateEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.Arrays;
import java.util.concurrent.TimeUnit;
import static com.chessflipping.protocol.WireProtocol.*;
import static org.junit.jupiter.api.Assertions.*;

class ProtocolTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TID = "0123456789abcdef0123456789abcdef";
    private static final byte[] CONTROL = bytes("{\"TID\":\"" + TID + "\"}");
    private static final byte[] METADATA = bytes("{\"TID\":\"" + TID
            + "\",\"DID\":\"" + TID + "\",\"CHL\":\"ANDROID\",\"APP\":\"test.app\",\"VER\":\"1.0\"}");

    private static byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }
    private static WireProtocol.Packet packet(int type, String body) { return new WireProtocol.Packet(type, CONTROL, bytes(body)); }
    private static void send(EmbeddedChannel channel, byte[] bytes) { channel.writeInbound(Unpooled.wrappedBuffer(bytes)); }
    private static byte[] read(EmbeddedChannel channel) {
        ByteBuf buffer = channel.readOutbound();
        assertNotNull(buffer, "Expected server response");
        try { byte[] bytes = new byte[buffer.readableBytes()]; buffer.readBytes(bytes); return bytes; }
        finally { buffer.release(); }
    }
    private static EmbeddedChannel channel(KeyPair server) {
        EmbeddedChannel channel = new EmbeddedChannel();
        TcpServer.configurePipeline(channel.pipeline(), server);
        channel.pipeline().fireChannelActive();
        return channel;
    }

    private static final class Peer implements AutoCloseable {
        final EmbeddedChannel channel;
        final SecureSession client;
        final byte[] transcript;
        Peer(KeyPair server, boolean complete, boolean fragment) throws Exception {
            this(server, complete, fragment, System::nanoTime);
        }
        Peer(KeyPair server, boolean complete, boolean fragment, java.util.function.LongSupplier clock) throws Exception {
            channel = new EmbeddedChannel();
            channel.pipeline().addLast(new BinaryFrameDecoder(), new ProtocolHandler(server, new RoomHub(), clock));
            channel.pipeline().fireChannelActive();
            byte[] request = WireProtocol.plain(packet(PUBLIC_KEY_REQUEST, ""));
            if (fragment) {
                for (int i = 0; i < request.length - 1; i++) {
                    send(channel, new byte[]{request[i]});
                    assertNull(channel.readOutbound());
                }
                send(channel, new byte[]{request[request.length - 1]});
            } else send(channel, request);
            byte[] serverHello = read(channel);
            WireProtocol.Packet hello = WireProtocol.plain(WireProtocol.decode(serverHello));
            assertEquals(SERVER_HELLO, hello.type);
            KeyPair local = KeyExchange.generateKeyPair();
            byte[] body = KeyExchange.hello(local);
            byte[] key = WireProtocol.plain(new WireProtocol.Packet(CLIENT_KEY, CONTROL, body));
            transcript = KeyExchange.transcript(request, serverHello, key);
            client = KeyExchange.derive(true, local, hello.body, body, transcript);
            send(channel, key);
            WireProtocol.Packet finished = client.decrypt(WireProtocol.decode(read(channel)));
            assertEquals(SERVER_FINISHED, finished.type);
            assertArrayEquals(transcript, finished.body);
            if (complete) {
                send(channel, client.encrypt(new WireProtocol.Packet(CLIENT_FINISHED, METADATA, transcript)));
                WireProtocol.Packet ready = response();
                assertEquals(READY, ready.type);
                assertArrayEquals(transcript, ready.body);
                channel.runPendingTasks();
                assertEquals(BUSINESS_EVENT, response().type);
            }
        }
        WireProtocol.Packet response() throws Exception { return client.decrypt(WireProtocol.decode(read(channel))); }
        @Override public void close() { client.close(); channel.finishAndReleaseAll(); }
    }

    @Test void handshakeAndEncryptedChineseMessagesHandleFragmentationAndCoalescing() throws Exception {
        try (Peer peer = new Peer(KeyExchange.generateKeyPair(), true, true)) {
            byte[] echo = peer.client.encrypt(packet(BUSINESS_REQUEST, "{\"type\":\"ECHO\",\"message\":\"你好，翻棋！\\n第二行\"}"));
            String wire = new String(echo, StandardCharsets.ISO_8859_1);
            assertFalse(wire.contains("TID"));
            assertFalse(wire.contains(TID));
            assertFalse(wire.contains("ECHO"));
            assertEquals(echo.length, ByteBuffer.wrap(echo).getInt(TOTAL_OFFSET));
            send(peer.channel, Arrays.copyOf(echo, 13));
            assertNull(peer.channel.readOutbound());
            byte[] ping = peer.client.encrypt(packet(PING, "{}"));
            send(peer.channel, WireProtocol.join(Arrays.copyOfRange(echo, 13, echo.length), ping));
            WireProtocol.Packet response = peer.response();
            assertEquals(BUSINESS_RESPONSE, response.type);
            assertEquals("你好，翻棋！\n第二行", JSON.readTree(response.body).path("message").asText());
            assertEquals(TID, JSON.readTree(response.control).path("TID").asText());
            assertEquals(PONG, peer.response().type);
        }
    }

    @ParameterizedTest @ValueSource(strings = {"ANDROID", "IOS", "WEB"})
    void acceptsAllSupportedClientChannels(String platform) throws Exception {
        try (Peer peer = new Peer(KeyExchange.generateKeyPair(), false, false)) {
            byte[] metadata = bytes(new String(METADATA, StandardCharsets.UTF_8).replace("ANDROID", platform));
            send(peer.channel, peer.client.encrypt(new WireProtocol.Packet(CLIENT_FINISHED, metadata, peer.transcript)));
            assertEquals(READY, peer.response().type);
            assertTrue(peer.channel.isActive());
        }
    }

    @Test void invalidBusinessJsonReturnsEncryptedErrorAndConnectionRemainsUsable() throws Exception {
        try (Peer peer = new Peer(KeyExchange.generateKeyPair(), true, false)) {
            for (String body : new String[]{"oops", "[]", "{} {}", "{\"type\":\"ECHO\",\"type\":\"ECHO\"}"}) {
                send(peer.channel, peer.client.encrypt(packet(BUSINESS_REQUEST, body)));
                assertEquals(ERROR, peer.response().type);
                assertTrue(peer.channel.isActive());
            }
            send(peer.channel, peer.client.encrypt(packet(PING, "{}")));
            assertEquals(PONG, peer.response().type);
        }
    }

    @Test void maximumBodyAndNonAsciiControlUseByteLengths() throws Exception {
        try (Peer peer = new Peer(KeyExchange.generateKeyPair(), true, false)) {
            String prefix = "{\"type\":\"ECHO\",\"message\":\"";
            String body = prefix + "x".repeat(MAX_BODY - bytes(prefix).length - 2) + "\"}";
            assertEquals(MAX_BODY, bytes(body).length);
            byte[] control = bytes("{\"TID\":\"" + TID + "\",\"备注\":\"中文\"}");
            send(peer.channel, peer.client.encrypt(new WireProtocol.Packet(BUSINESS_REQUEST, control, bytes(body))));
            assertEquals(MAX_BODY, peer.response().body.length);
        }
    }

    @ParameterizedTest @ValueSource(ints = {0, 1, 2, 3, 4, 5})
    void invalidHeaderIsRejectedWithoutWaitingForPayload(int variant) throws Exception {
        EmbeddedChannel channel = channel(KeyExchange.generateKeyPair());
        try {
            byte[] frame = WireProtocol.plain(packet(PUBLIC_KEY_REQUEST, ""));
            ByteBuffer buffer = ByteBuffer.wrap(frame);
            switch (variant) {
                case 0 -> buffer.putInt(TOTAL_OFFSET, Integer.MAX_VALUE);
                case 1 -> buffer.putInt(6, -1);
                case 2 -> buffer.putInt(10, MAX_BODY + 1);
                case 3 -> frame[14] = 2;
                case 4 -> frame[16] = 2;
                case 5 -> buffer.putInt(TOTAL_OFFSET, HEADER_SIZE - 1);
            }
            send(channel, Arrays.copyOf(frame, HEADER_SIZE));
            assertFalse(channel.isActive());
        } finally { channel.finishAndReleaseAll(); }
    }

    @ParameterizedTest @ValueSource(ints = {0, 1, 2, 3})
    void tamperingWithRecomputedCrcStillFailsAuthentication(int variant) throws Exception {
        try (Peer peer = new Peer(KeyExchange.generateKeyPair(), true, false)) {
            byte[] frame = peer.client.encrypt(packet(BUSINESS_REQUEST, "{\"type\":\"ECHO\",\"message\":\"secret\"}"));
            switch (variant) {
                case 0 -> frame[frame.length - 1] ^= 1; // GCM tag.
                case 1 -> frame[HEADER_SIZE + 13] ^= 1; // Ciphertext.
                case 2 -> frame[15] = PING; // Authenticated clear packet type.
                case 3 -> {
                    ByteBuffer b = ByteBuffer.wrap(frame);
                    b.putInt(6, b.getInt(6) + 1);
                    b.putInt(10, b.getInt(10) - 1);
                }
            }
            ByteBuffer.wrap(frame).putInt(CRC_OFFSET, WireProtocol.crc(frame));
            send(peer.channel, frame);
            assertFalse(peer.channel.isActive());
        }
    }

    @Test void rejectsBadCrc() throws Exception {
        EmbeddedChannel channel = channel(KeyExchange.generateKeyPair());
        try {
            byte[] frame = WireProtocol.plain(packet(PUBLIC_KEY_REQUEST, ""));
            frame[CRC_OFFSET] ^= 1;
            send(channel, frame);
            assertFalse(channel.isActive());
        } finally { channel.finishAndReleaseAll(); }
    }

    @Test void rejectsReplayAndSequenceGaps() throws Exception {
        KeyPair server = KeyExchange.generateKeyPair();
        try (Peer peer = new Peer(server, true, false)) {
            byte[] frame = peer.client.encrypt(packet(PING, "{}"));
            send(peer.channel, frame);
            assertEquals(PONG, peer.response().type);
            send(peer.channel, frame);
            assertFalse(peer.channel.isActive());
        }
        try (Peer peer = new Peer(server, true, false)) {
            peer.client.encrypt(packet(PING, "{}")); // Deliberately drop a sequence number.
            send(peer.channel, peer.client.encrypt(packet(PING, "{}")));
            assertFalse(peer.channel.isActive());
        }
    }

    @Test void sessionsAreIsolatedEvenWithTheSameServerKey() throws Exception {
        KeyPair server = KeyExchange.generateKeyPair();
        try (Peer first = new Peer(server, true, false); Peer second = new Peer(server, true, false)) {
            send(second.channel, first.client.encrypt(packet(PING, "{}")));
            assertFalse(second.channel.isActive());
            send(first.channel, first.client.encrypt(packet(PING, "{}")));
            // First packet was sent to another connection, so first server correctly detects the gap too.
            assertFalse(first.channel.isActive());
        }
    }

    @Test void rejectsPlaintextBusinessAndBusinessBeforeHandshakeConfirmation() throws Exception {
        EmbeddedChannel fresh = channel(KeyExchange.generateKeyPair());
        try { send(fresh, WireProtocol.plain(packet(PING, "{}"))); assertFalse(fresh.isActive()); }
        finally { fresh.finishAndReleaseAll(); }
        try (Peer peer = new Peer(KeyExchange.generateKeyPair(), false, false)) {
            send(peer.channel, peer.client.encrypt(packet(PING, "{}")));
            assertFalse(peer.channel.isActive());
        }
        try (Peer peer = new Peer(KeyExchange.generateKeyPair(), true, false)) {
            send(peer.channel, WireProtocol.plain(packet(PING, "{}")));
            assertFalse(peer.channel.isActive());
        }
    }

    @Test void rejectsWrongHandshakeTranscriptAndMissingMetadata() throws Exception {
        try (Peer peer = new Peer(KeyExchange.generateKeyPair(), false, false)) {
            send(peer.channel, peer.client.encrypt(new WireProtocol.Packet(CLIENT_FINISHED, METADATA, new byte[32])));
            assertFalse(peer.channel.isActive());
        }
        try (Peer peer = new Peer(KeyExchange.generateKeyPair(), false, false)) {
            send(peer.channel, peer.client.encrypt(new WireProtocol.Packet(CLIENT_FINISHED, CONTROL, peer.transcript)));
            assertFalse(peer.channel.isActive());
        }
    }

    @Test void closesOnAbsoluteHandshakeDeadlineAndReadIdle() throws Exception {
        EmbeddedChannel channel = channel(KeyExchange.generateKeyPair());
        try {
            send(channel, new byte[]{0}); // Incomplete input cannot prolong the handshake.
            channel.advanceTimeBy(11, TimeUnit.SECONDS);
            channel.runScheduledPendingTasks();
            assertFalse(channel.isActive());
        } finally { channel.finishAndReleaseAll(); }
        try (Peer peer = new Peer(KeyExchange.generateKeyPair(), true, false)) {
            peer.channel.advanceTimeBy(11, TimeUnit.SECONDS);
            peer.channel.runScheduledPendingTasks();
            assertTrue(peer.channel.isActive());
            peer.channel.pipeline().fireUserEventTriggered(IdleStateEvent.READER_IDLE_STATE_EVENT);
            assertFalse(peer.channel.isActive());
        }
    }

    @Test void validatesConfig() {
        assertThrows(IllegalArgumentException.class, () -> new TcpProperties(0, 4));
        assertThrows(IllegalArgumentException.class, () -> new TcpProperties(9000, 0));
    }

    @Test void businessTrafficDoesNotExtendHeartbeatDeadlineButValidPingDoes() throws Exception {
        var now = new java.util.concurrent.atomic.AtomicLong();
        try (Peer peer = new Peer(KeyExchange.generateKeyPair(), true, false, now::get)) {
            now.set(TimeUnit.SECONDS.toNanos(29));
            send(peer.channel, peer.client.encrypt(packet(BUSINESS_REQUEST, "{\"type\":\"ECHO\",\"message\":\"active\"}")));
            assertEquals(BUSINESS_RESPONSE, peer.response().type);
            now.set(TimeUnit.SECONDS.toNanos(30)); peer.channel.advanceTimeBy(30, TimeUnit.SECONDS); peer.channel.runScheduledPendingTasks();
            assertFalse(peer.channel.isActive());
        }
        now.set(0);
        try (Peer peer = new Peer(KeyExchange.generateKeyPair(), true, false, now::get)) {
            now.set(TimeUnit.SECONDS.toNanos(25)); send(peer.channel, peer.client.encrypt(packet(PING, "{}")));
            assertEquals(PONG, peer.response().type);
            now.set(TimeUnit.SECONDS.toNanos(30)); peer.channel.advanceTimeBy(30, TimeUnit.SECONDS); peer.channel.runScheduledPendingTasks();
            assertTrue(peer.channel.isActive());
            now.set(TimeUnit.SECONDS.toNanos(55)); peer.channel.advanceTimeBy(25, TimeUnit.SECONDS); peer.channel.runScheduledPendingTasks();
            assertFalse(peer.channel.isActive());
        }
    }
}
