package com.chessflipping.server;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.netty.buffer.Unpooled;
import io.netty.channel.*;
import io.netty.handler.codec.http.websocketx.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

/** JSON transport over WS/WSS. TLS is terminated by the deployment's reverse proxy. */
public final class WebSocketHandler extends SimpleChannelInboundHandler<WebSocketFrame> {
    private static final Pattern HEX_ID = Pattern.compile("[0-9a-f]{32}");
    private static final Set<String> PLATFORMS = Set.of("ANDROID", "IOS", "WEB");
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION);
    private final RoomHub rooms;
    private final AtomicInteger queued = new AtomicInteger();
    private RoomHub.Session user;
    private ScheduledFuture<?> deadline;
    private long heartbeat;
    private boolean upgraded;

    public WebSocketHandler(RoomHub rooms) { this.rooms = rooms; }
    @Override public void channelActive(ChannelHandlerContext ctx) {
        deadline = ctx.executor().schedule(() -> ctx.close(), 10, TimeUnit.SECONDS);
        ctx.fireChannelActive();
    }
    @Override public void userEventTriggered(ChannelHandlerContext ctx, Object event) throws Exception {
        if (event instanceof WebSocketServerProtocolHandler.HandshakeComplete) upgraded = true;
        super.userEventTriggered(ctx, event);
    }
    @Override protected void channelRead0(ChannelHandlerContext ctx, WebSocketFrame frame) throws Exception {
        if (!upgraded || !(frame instanceof TextWebSocketFrame)) throw new IOException("Expected text message");
        String text = StandardCharsets.UTF_8.newDecoder().decode(frame.content().nioBuffer()).toString();
        JsonNode message = JSON.readTree(text);
        require(message != null && message.isObject());
        String tid = field(message, "TID", 32);
        require(HEX_ID.matcher(tid).matches());
        String type = field(message, "type", 24);
        if (user == null) {
            require(type.equals("HELLO"));
            require(PLATFORMS.contains(field(message, "CHL", 16)));
            String did = field(message, "DID", 32);
            require(HEX_ID.matcher(did).matches());
            field(message, "APP", 256); field(message, "VER", 64);
            deadline.cancel(false);
            // READY must precede SESSION and any business event on the wire.
            write(ctx, "READY", tid, JSON.createObjectNode());
            user = rooms.register(did, new RoomHub.Peer() {
                public void event(ObjectNode body) { enqueue(ctx, "EVENT", UUID.randomUUID().toString().replace("-", ""), body); }
                public void reply(String id, ObjectNode body) { enqueue(ctx, "RESPONSE", id, body); }
                public void close() { ctx.close(); }
            });
            heartbeat = System.nanoTime();
            deadline = ctx.executor().schedule(() -> checkHeartbeat(ctx), 30, TimeUnit.SECONDS);
            return;
        }
        require(rooms.active(user));
        if (type.equals("PING")) {
            heartbeat = System.nanoTime();
            write(ctx, "PONG", tid, RoomHub.node("PONG"));
        } else if (type.equals("REQUEST")) {
            JsonNode body = message.path("body");
            require(body.isObject() && JSON.writeValueAsBytes(body).length <= 65536);
            if ("ECHO".equals(body.path("type").asText()))
                write(ctx, "RESPONSE", tid, RoomHub.node("ECHO").put("message", body.path("message").asText()));
            else rooms.handle(user, tid, body);
        } else throw new IOException("Unexpected message type");
    }
    private void enqueue(ChannelHandlerContext ctx, String type, String tid, ObjectNode body) {
        if (!ctx.channel().isWritable()) { ctx.close(); return; }
        if (queued.incrementAndGet() > 32) { queued.decrementAndGet(); ctx.close(); return; }
        ctx.executor().execute(() -> {
            try { if (ctx.channel().isActive()) write(ctx, type, tid, body); }
            catch (Exception ex) { ctx.close(); }
            finally { queued.decrementAndGet(); }
        });
    }
    private void write(ChannelHandlerContext ctx, String type, String tid, ObjectNode body) throws IOException {
        if (!ctx.channel().isWritable()) { ctx.close(); return; }
        ObjectNode envelope = JSON.createObjectNode().put("type", type).put("TID", tid).put("CODE", 0);
        envelope.set("body", body);
        byte[] bytes = JSON.writeValueAsBytes(envelope);
        if (bytes.length > 69632) { ctx.close(); return; }
        ctx.writeAndFlush(new TextWebSocketFrame(Unpooled.wrappedBuffer(bytes)))
                .addListener(ChannelFutureListener.CLOSE_ON_FAILURE);
    }
    private void checkHeartbeat(ChannelHandlerContext ctx) {
        long remaining = TimeUnit.SECONDS.toNanos(30) - (System.nanoTime() - heartbeat);
        if (remaining <= 0) ctx.close();
        else deadline = ctx.executor().schedule(() -> checkHeartbeat(ctx), remaining, TimeUnit.NANOSECONDS);
    }
    private static String field(JsonNode node, String name, int max) throws IOException {
        JsonNode value = node.path(name);
        require(value.isTextual() && !value.asText().isBlank() && value.asText().length() <= max);
        return value.asText();
    }
    private static void require(boolean valid) throws IOException { if (!valid) throw new IOException("Invalid WebSocket message"); }
    @Override public void channelInactive(ChannelHandlerContext ctx) {
        if (deadline != null) deadline.cancel(false);
        rooms.disconnect(user); ctx.fireChannelInactive();
    }
    @Override public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) { ctx.close(); }
}
