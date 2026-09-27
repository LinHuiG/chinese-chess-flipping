package com.chessflipping.server;

import com.chessflipping.protocol.KeyExchange;
import com.chessflipping.protocol.SecureSession;
import com.chessflipping.protocol.WireProtocol;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.netty.buffer.Unpooled;
import io.netty.channel.*;
import io.netty.handler.timeout.IdleStateEvent;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.MessageDigest;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import static com.chessflipping.protocol.WireProtocol.*;

/** One handler per connection. Business messages require mutual key confirmation. */
public final class ProtocolHandler extends SimpleChannelInboundHandler<WireProtocol.Frame> {
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION);
    private enum State { EXPECT_REQUEST, EXPECT_KEY, EXPECT_FINISHED, ESTABLISHED }
    private final KeyPair serverKey;
    private State state = State.EXPECT_REQUEST;
    private String handshakeTid;
    private byte[] requestBytes, helloBytes, helloBody, transcript;
    private SecureSession session;
    private ScheduledFuture<?> handshakeTimeout;
    private ScheduledFuture<?> heartbeatTimeout;
    private long lastHeartbeat;
    private final RoomHub rooms;
    private final java.util.function.LongSupplier nanoTime;
    private RoomHub.Session user;
    private final java.util.concurrent.atomic.AtomicInteger queuedOutputs = new java.util.concurrent.atomic.AtomicInteger();

    public ProtocolHandler(KeyPair serverKey) { this(serverKey, new RoomHub()); }
    public ProtocolHandler(KeyPair serverKey, RoomHub rooms) { this(serverKey, rooms, System::nanoTime); }
    ProtocolHandler(KeyPair serverKey, RoomHub rooms, java.util.function.LongSupplier nanoTime) {
        this.serverKey = serverKey; this.rooms = rooms; this.nanoTime = nanoTime;
    }

    @Override public void channelActive(ChannelHandlerContext ctx) {
        handshakeTimeout = ctx.executor().schedule(() -> {
            if (state != State.ESTABLISHED) ctx.close();
        }, 10, TimeUnit.SECONDS);
        ctx.fireChannelActive();
    }

    @Override protected void channelRead0(ChannelHandlerContext ctx, WireProtocol.Frame frame) throws Exception {
        WireProtocol.Packet packet = session == null ? WireProtocol.plain(frame) : session.decrypt(frame);
        JsonNode control = object(packet.control);
        String tid = tid(control);
        switch (state) {
            case EXPECT_REQUEST -> {
                require(packet.type == PUBLIC_KEY_REQUEST && packet.body.length == 0);
                handshakeTid = tid;
                requestBytes = frame.bytes();
                helloBody = KeyExchange.hello(serverKey);
                helloBytes = WireProtocol.plain(new WireProtocol.Packet(SERVER_HELLO, responseControl(tid, 0, null), helloBody));
                state = State.EXPECT_KEY;
                write(ctx, helloBytes);
            }
            case EXPECT_KEY -> {
                require(packet.type == CLIENT_KEY && handshakeTid.equals(tid));
                transcript = KeyExchange.transcript(requestBytes, helloBytes, frame.bytes());
                session = KeyExchange.derive(false, serverKey, helloBody, packet.body, transcript);
                state = State.EXPECT_FINISHED;
                secure(ctx, SERVER_FINISHED, tid, 0, null, transcript);
                requestBytes = helloBytes = helloBody = null;
            }
            case EXPECT_FINISHED -> {
                require(packet.type == CLIENT_FINISHED && handshakeTid.equals(tid)
                        && MessageDigest.isEqual(transcript, packet.body));
                require("ANDROID".equals(control.path("CHL").asText())
                        && control.path("DID").asText().matches("[0-9a-f]{32}"));
                requiredText(control, "APP", 256);
                requiredText(control, "VER", 64);
                state = State.ESTABLISHED;
                handshakeTimeout.cancel(false);
                user = rooms.register(control.path("DID").asText(), new RoomHub.Peer() {
                    public void event(ObjectNode message) { enqueue(ctx, BUSINESS_EVENT, java.util.UUID.randomUUID().toString().replace("-", ""), message); }
                    public void reply(String id, ObjectNode message) { enqueue(ctx, BUSINESS_RESPONSE, id, message); }
                    public void close() { ctx.close(); }
                });
                secure(ctx, READY, tid, 0, null, transcript);
                transcript = null;
                lastHeartbeat = nanoTime.getAsLong();
                heartbeatTimeout = ctx.executor().schedule(() -> checkHeartbeat(ctx), 30, TimeUnit.SECONDS);
            }
            case ESTABLISHED -> business(ctx, packet, tid);
        }
    }

    private void business(ChannelHandlerContext ctx, WireProtocol.Packet packet, String tid) throws Exception {
        if (!rooms.active(user)) { ctx.close(); return; }
        if (packet.type != PING && packet.type != BUSINESS_REQUEST) {
            secure(ctx, ERROR, tid, 400, "UNEXPECTED_PACKET_TYPE", new byte[]{'{', '}'});
            return;
        }
        JsonNode body;
        try { body = object(packet.body); }
        catch (IOException ex) {
            secure(ctx, ERROR, tid, 400, "INVALID_JSON", new byte[]{'{', '}'});
            return;
        }
        if (packet.type == PING) {
            lastHeartbeat = nanoTime.getAsLong();
            secure(ctx, PONG, tid, 0, null, JSON.writeValueAsBytes(JSON.createObjectNode().put("type", "PONG")));
        } else if ("ECHO".equals(body.path("type").asText()) && body.path("message").isTextual()) {
            ObjectNode response = JSON.createObjectNode().put("type", "ECHO").put("message", body.path("message").asText());
            byte[] encoded = JSON.writeValueAsBytes(response);
            if (encoded.length > MAX_BODY) secure(ctx, ERROR, tid, 413, "RESPONSE_TOO_LARGE", new byte[]{'{', '}'});
            else secure(ctx, BUSINESS_RESPONSE, tid, 0, null, encoded);
        } else {
            rooms.handle(user, tid, body);
        }
    }

    private void enqueue(ChannelHandlerContext ctx, int type, String tid, ObjectNode message) {
        if (!ctx.channel().isWritable()) { ctx.close(); return; }
        if (queuedOutputs.incrementAndGet() > 32) { queuedOutputs.decrementAndGet(); ctx.close(); return; }
        ctx.executor().execute(() -> {
            try { if (ctx.channel().isActive()) secure(ctx, type, tid, 0, null, JSON.writeValueAsBytes(message)); }
            catch (Exception ex) { ctx.close(); }
            finally { queuedOutputs.decrementAndGet(); }
        });
    }

    private void checkHeartbeat(ChannelHandlerContext ctx) {
        if (!ctx.channel().isActive()) return;
        long remaining = TimeUnit.SECONDS.toNanos(30) - (nanoTime.getAsLong() - lastHeartbeat);
        if (remaining <= 0) ctx.close();
        else heartbeatTimeout = ctx.executor().schedule(() -> checkHeartbeat(ctx), remaining, TimeUnit.NANOSECONDS);
    }

    private static JsonNode object(byte[] bytes) throws IOException {
        JsonNode value = JSON.readTree(StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString());
        if (value == null || !value.isObject()) throw new IOException("Expected JSON object");
        return value;
    }

    private static String tid(JsonNode control) throws IOException {
        String tid = requiredText(control, "TID", 32);
        require(tid.matches("[0-9a-f]{32}"));
        return tid;
    }

    private static String requiredText(JsonNode object, String name, int max) throws IOException {
        JsonNode value = object.path(name);
        require(value.isTextual() && !value.asText().isBlank() && value.asText().length() <= max);
        return value.asText();
    }

    private static void require(boolean condition) throws IOException {
        if (!condition) throw new IOException("Invalid handshake or control header");
    }

    private static byte[] responseControl(String tid, int code, String message) throws IOException {
        ObjectNode control = JSON.createObjectNode().put("TID", tid).put("CODE", code);
        if (message != null) control.put("MSG", message);
        return JSON.writeValueAsBytes(control);
    }

    private void secure(ChannelHandlerContext ctx, int type, String tid, int code, String message, byte[] body) throws Exception {
        write(ctx, session.encrypt(new WireProtocol.Packet(type, responseControl(tid, code, message), body)));
    }

    private static void write(ChannelHandlerContext ctx, byte[] bytes) {
        if (!ctx.channel().isWritable()) { ctx.close(); return; }
        ctx.writeAndFlush(Unpooled.wrappedBuffer(bytes)).addListener(ChannelFutureListener.CLOSE_ON_FAILURE);
    }

    @Override public void channelInactive(ChannelHandlerContext ctx) {
        if (handshakeTimeout != null) handshakeTimeout.cancel(false);
        if (heartbeatTimeout != null) heartbeatTimeout.cancel(false);
        rooms.disconnect(user);
        if (session != null) session.close();
        requestBytes = helloBytes = helloBody = transcript = null;
        ctx.fireChannelInactive();
    }

    @Override public void userEventTriggered(ChannelHandlerContext ctx, Object event) throws Exception {
        if (event instanceof IdleStateEvent) ctx.close();
        else super.userEventTriggered(ctx, event);
    }

    @Override public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) { ctx.close(); }
}
