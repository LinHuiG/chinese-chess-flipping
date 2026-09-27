package com.chessflipping.server;

import io.netty.bootstrap.ServerBootstrap;
import io.netty.channel.*;
import io.netty.channel.group.DefaultChannelGroup;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioServerSocketChannel;
import io.netty.util.concurrent.GlobalEventExecutor;
import org.json.JSONObject;
import org.junit.jupiter.api.*;
import java.net.*;
import java.net.http.*;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;

class WebSocketTransportTest {
    static EventLoopGroup boss, workers;
    static DefaultChannelGroup channels;
    static HttpClient http;
    static int port;
    @BeforeAll static void start() throws Exception {
        boss = new NioEventLoopGroup(1); workers = new NioEventLoopGroup(1);
        channels = new DefaultChannelGroup(GlobalEventExecutor.INSTANCE);
        RoomHub rooms = new RoomHub(); HttpAssets assets = new HttpAssets();
        Channel listener = new ServerBootstrap().group(boss, workers).channel(NioServerSocketChannel.class)
                .childHandler(new ChannelInitializer<SocketChannel>() {
                    protected void initChannel(SocketChannel channel) {
                        channels.add(channel); TcpServer.configureHttpPipeline(channel.pipeline(), rooms, assets);
                    }
                }).bind("127.0.0.1", 0).sync().channel();
        channels.add(listener); port = ((InetSocketAddress)listener.localAddress()).getPort();
        http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    }
    @AfterAll static void stop() {
        channels.close().awaitUninterruptibly(); http.close();
        boss.shutdownGracefully(0, 1, TimeUnit.SECONDS).awaitUninterruptibly();
        workers.shutdownGracefully(0, 1, TimeUnit.SECONDS).awaitUninterruptibly();
    }
    static final class Peer implements WebSocket.Listener, AutoCloseable {
        final BlockingQueue<JSONObject> messages = new LinkedBlockingQueue<>();
        final CountDownLatch closed = new CountDownLatch(1);
        final StringBuilder buffer = new StringBuilder();
        WebSocket socket;
        Peer(String platform, String did) throws Exception {
            socket = http.newWebSocketBuilder().buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws"), this).get(4, TimeUnit.SECONDS);
            JSONObject hello = new JSONObject().put("type", "HELLO").put("TID", id()).put("CHL", platform)
                    .put("DID", did).put("APP", "test.web").put("VER", "1");
            String raw = hello.toString();
            socket.sendText(raw.substring(0, 20), false).join(); socket.sendText(raw.substring(20), true).join();
        }
        public void onOpen(WebSocket socket) { socket.request(1); }
        public CompletionStage<?> onText(WebSocket socket, CharSequence text, boolean last) {
            buffer.append(text);
            if (last) { messages.add(new JSONObject(buffer.toString())); buffer.setLength(0); }
            socket.request(1); return null;
        }
        public CompletionStage<?> onClose(WebSocket socket, int code, String reason) { closed.countDown(); return null; }
        public void onError(WebSocket socket, Throwable error) { closed.countDown(); }
        JSONObject next() throws Exception { JSONObject value = messages.poll(4, TimeUnit.SECONDS); assertNotNull(value); return value; }
        JSONObject body(String type) throws Exception {
            for (int i = 0; i < 8; i++) { JSONObject value = next().getJSONObject("body"); if (type.equals(value.optString("type"))) return value; }
            throw new AssertionError("Missing " + type);
        }
        void request(JSONObject body) { socket.sendText(new JSONObject().put("type", "REQUEST").put("TID", id()).put("body", body).toString(), true).join(); }
        void ready() throws Exception { assertEquals("READY", next().getString("type")); assertEquals("SESSION", next().getJSONObject("body").getString("type")); }
        public void close() { socket.abort(); }
    }
    private static String id() { return UUID.randomUUID().toString().replace("-", ""); }

    @Test void servesBrowserAssetsAndRejectsUnknownFiles() throws Exception {
        var page = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/")).build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(200, page.statusCode()); assertTrue(page.body().contains("四列八行"));
        var missing = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/application.yml")).build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(404, missing.statusCode());
    }
    @Test void allPlatformsHandshakeAndWebSocketPeersShareRooms() throws Exception {
        try (Peer host = new Peer("WEB", id()); Peer guest = new Peer("ANDROID", id()); Peer ios = new Peer("IOS", id())) {
            host.ready(); guest.ready(); ios.ready();
            host.request(new JSONObject().put("type", "CREATE").put("name", "跨端房间"));
            JSONObject room = host.body("ROOM");
            guest.request(new JSONObject().put("type", "JOIN").put("roomId", room.getLong("roomId")));
            JSONObject joined = guest.body("ROOM"); assertEquals(2, joined.getJSONArray("members").length());
            guest.request(new JSONObject().put("type", "ACTION").put("roomId", joined.getLong("roomId"))
                    .put("version", joined.getLong("version")).put("gameId", "")
                    .put("action", new JSONObject().put("type", "READY").put("ready", true)));
            assertEquals("READY", host.body("FORWARD").getJSONObject("action").getString("type"));
            ios.socket.sendText(new JSONObject().put("type", "PING").put("TID", id()).toString(), true).join();
            assertEquals("PONG", ios.next().getString("type"));
        }
    }
    @Test void rejectsUnsupportedPlatformAndReplacesOldSession() throws Exception {
        try (Peer rejected = new Peer("UNKNOWN", id())) { assertTrue(rejected.closed.await(4, TimeUnit.SECONDS)); }
        String did = id();
        try (Peer old = new Peer("WEB", did)) {
            old.ready();
            try (Peer replacement = new Peer("IOS", did)) {
                replacement.ready(); assertTrue(old.closed.await(4, TimeUnit.SECONDS));
            }
        }
    }
    @Test void blocksForeignBrowserOrigin() {
        assertThrows(ExecutionException.class, () -> http.newWebSocketBuilder().header("Origin", "https://foreign.invalid")
                .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws"), new WebSocket.Listener() {}).get(4, TimeUnit.SECONDS));
    }
}
