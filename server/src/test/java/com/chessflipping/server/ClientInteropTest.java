package com.chessflipping.server;

import com.chessflipping.protocol.KeyExchange;
import com.chessflipping.protocol.WireProtocol;
import io.netty.bootstrap.ServerBootstrap;
import io.netty.buffer.ByteBuf;
import io.netty.channel.*;
import io.netty.channel.group.DefaultChannelGroup;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioServerSocketChannel;
import io.netty.util.concurrent.GlobalEventExecutor;
import org.json.JSONObject;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import javax.tools.ToolProvider;
import java.lang.reflect.Proxy;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static com.chessflipping.protocol.WireProtocol.*;
import static org.junit.jupiter.api.Assertions.*;

/** Runs the actual Android transport and its separate protocol copy on a desktop JVM.
 * Does not claim to validate Android's crypto providers, UI or device networking. */
class ClientInteropTest {
    @TempDir static Path compiled;
    private static URLClassLoader loader;
    private static Class<?> clientType, listenerType;

    @BeforeAll static void compileActualAndroidTransport() throws Exception {
        Path serverRoot = Path.of(System.getProperty("basedir", ".")).toAbsolutePath();
        Path clientRoot = serverRoot.resolve("../client/app/src/main/java").normalize();
        Assumptions.assumeTrue(Files.isDirectory(clientRoot), "Server-only Docker context: Android sources absent");
        URL jsonJar = JSONObject.class.getProtectionDomain().getCodeSource().getLocation();
        List<String> arguments = new ArrayList<>(List.of("--release", "17", "-encoding", "UTF-8",
                "-classpath", Path.of(jsonJar.toURI()).toString(), "-d", compiled.toString()));
        for (String name : List.of("WireProtocol.java", "KeyExchange.java", "SecureSession.java")) {
            Path relative = Path.of("com/chessflipping/protocol", name);
            assertEquals(Files.readString(serverRoot.resolve("src/main/java").resolve(relative)),
                    Files.readString(clientRoot.resolve(relative)), "Protocol copies drifted: " + name);
            arguments.add(clientRoot.resolve(relative).toString());
        }
        arguments.add(clientRoot.resolve("com/chessflipping/client/TcpClient.java").toString());
        arguments.add(clientRoot.resolve("com/chessflipping/game/GameEngine.java").toString());
        arguments.add(clientRoot.resolve("com/chessflipping/game/HostController.java").toString());
        assertNotNull(ToolProvider.getSystemJavaCompiler(), "Tests require a JDK");
        assertEquals(0, ToolProvider.getSystemJavaCompiler().run(null, null, null, arguments.toArray(String[]::new)));
        loader = new URLClassLoader(new URL[]{compiled.toUri().toURL(), jsonJar}, ClassLoader.getPlatformClassLoader());
        clientType = loader.loadClass("com.chessflipping.client.TcpClient");
        listenerType = loader.loadClass("com.chessflipping.client.TcpClient$Listener");
    }

    @AfterAll static void closeLoader() throws Exception { if (loader != null) loader.close(); }

    private static final class Client implements AutoCloseable {
        final Object instance;
        final LinkedBlockingQueue<String> messages = new LinkedBlockingQueue<>();
        final CountDownLatch connected = new CountDownLatch(1), closed = new CountDownLatch(1);
        final AtomicInteger connections = new AtomicInteger();
        final LinkedBlockingQueue<JSONObject> events = new LinkedBlockingQueue<>();
        final ExecutorService refereeQueue = Executors.newSingleThreadExecutor();
        final java.util.concurrent.atomic.AtomicLong now = new java.util.concurrent.atomic.AtomicLong(1000);
        volatile JSONObject room, state;
        volatile String self;
        final Object referee;
        volatile String reason;
        Client(int port) throws Exception {
            this(port, UUID.randomUUID().toString().replace("-", ""));
        }
        Client(int port, String did) throws Exception {
            Class<?> refereeType = loader.loadClass("com.chessflipping.game.HostController");
            referee = refereeType.getConstructor(java.util.function.Consumer.class, java.util.function.LongSupplier.class)
                    .newInstance((java.util.function.Consumer<Object>)this::requestObject, (java.util.function.LongSupplier)now::get);
            Object listener = Proxy.newProxyInstance(loader, new Class<?>[]{listenerType}, (proxy, method, args) -> {
                switch (method.getName()) {
                    case "onConnected" -> { connections.incrementAndGet(); connected.countDown(); }
                    case "onMessage" -> messages.add((String)args[0]);
                    case "onClosed" -> { reason = (String)args[0]; closed.countDown(); }
                    case "onEvent" -> {
                        String raw = (String)args[0];
                        refereeQueue.execute(() -> event(raw));
                    }
                    case "toString" -> { return "TestListener"; }
                    case "hashCode" -> { return System.identityHashCode(proxy); }
                    case "equals" -> { return proxy == args[0]; }
                }
                return null;
            });
            instance = clientType.getConstructor(String.class, String.class, String.class, listenerType)
                    .newInstance(did, "test.android", "0.2.0", listener);
            clientType.getMethod("connect", String.class, int.class).invoke(instance, "127.0.0.1", port);
        }
        void connected() throws Exception { assertTrue(connected.await(5, TimeUnit.SECONDS), "Connection failed: " + reason); }
        void echo(String message) throws Exception { clientType.getMethod("echo", String.class).invoke(instance, message); }
        void requestObject(Object value) {
            try { clientType.getMethod("request", loader.loadClass("org.json.JSONObject")).invoke(instance, value); }
            catch (Exception ex) { throw new RuntimeException(ex); }
        }
        void request(JSONObject value) throws Exception {
            requestObject(loader.loadClass("org.json.JSONObject").getConstructor(String.class).newInstance(value.toString()));
        }
        void event(String raw) {
            try {
                JSONObject event = new JSONObject(raw);
                Object internal = loader.loadClass("org.json.JSONObject").getConstructor(String.class).newInstance(raw);
                switch (event.getString("type")) {
                    case "SESSION" -> self = event.getString("selfId");
                    case "ROOM" -> {
                        room = event; state = null;
                        referee.getClass().getMethod("room", internal.getClass(), String.class).invoke(referee, internal, self);
                    }
                    case "FORWARD" -> referee.getClass().getMethod("action", internal.getClass()).invoke(referee, internal);
                    case "STATE" -> state = event.getJSONObject("state");
                    case "ROOM_CLOSED" -> room = null;
                }
                events.add(event);
            } catch (Exception ex) { messages.add("REFEREE_FAILURE: " + ex); }
        }
        JSONObject waitEvent(String type, java.util.function.Predicate<JSONObject> predicate) throws Exception {
            long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (System.nanoTime() < end) {
                JSONObject event = events.poll(100, TimeUnit.MILLISECONDS);
                if (event != null && type.equals(event.optString("type")) && predicate.test(event)) return event;
            }
            fail("Missing " + type + "; messages=" + messages + "; closed=" + reason); return null;
        }
        JSONObject context(String type) {
            return new JSONObject().put("type", type).put("roomId", room.getLong("roomId"))
                    .put("version", room.getLong("version")).put("gameId", room.optString("gameId"));
        }
        void action(JSONObject action) throws Exception { request(context("ACTION").put("action", action)); }
        String next(int seconds) throws Exception {
            String message = messages.poll(seconds, TimeUnit.SECONDS);
            assertNotNull(message, "No message received; close reason: " + reason);
            return message;
        }
        @Override public void close() throws Exception { clientType.getMethod("close").invoke(instance); refereeQueue.shutdown(); }
    }

    private static final class Server implements AutoCloseable {
        final EventLoopGroup boss = new NioEventLoopGroup(1), workers = new NioEventLoopGroup(2);
        final DefaultChannelGroup channels = new DefaultChannelGroup(GlobalEventExecutor.INSTANCE);
        final Queue<WireProtocol.Frame> received = new ConcurrentLinkedQueue<>();
        final int port;
        Server(boolean tamper, boolean stall) throws Exception {
            var key = KeyExchange.generateKeyPair();
            RoomHub rooms = new RoomHub();
            Channel listener = new ServerBootstrap().group(boss, workers).channel(NioServerSocketChannel.class)
                    .childHandler(new ChannelInitializer<SocketChannel>() {
                        @Override protected void initChannel(SocketChannel channel) {
                            channels.add(channel);
                            if (stall) {
                                channel.pipeline().addLast(new SimpleChannelInboundHandler<ByteBuf>() {
                                    @Override protected void channelRead0(ChannelHandlerContext ctx, ByteBuf bytes) { }
                                });
                                return;
                            }
                            TcpServer.configurePipeline(channel.pipeline(), key, rooms);
                            String decoder = channel.pipeline().context(BinaryFrameDecoder.class).name();
                            channel.pipeline().addAfter(decoder, "capture", new ChannelInboundHandlerAdapter() {
                                @Override public void channelRead(ChannelHandlerContext ctx, Object message) {
                                    received.add((WireProtocol.Frame)message);
                                    ctx.fireChannelRead(message);
                                }
                            });
                            if (tamper) channel.pipeline().addFirst("tamper", new ChannelOutboundHandlerAdapter() {
                                @Override public void write(ChannelHandlerContext ctx, Object message, ChannelPromise promise) {
                                    ByteBuf buffer = (ByteBuf)message;
                                    if ((buffer.getByte(buffer.readerIndex() + 15) & 255) == SERVER_FINISHED) {
                                        int last = buffer.writerIndex() - 1;
                                        buffer.setByte(last, buffer.getByte(last) ^ 1);
                                        byte[] bytes = new byte[buffer.readableBytes()];
                                        buffer.getBytes(buffer.readerIndex(), bytes);
                                        buffer.setInt(buffer.readerIndex() + WireProtocol.CRC_OFFSET, WireProtocol.crc(bytes));
                                    }
                                    ctx.write(message, promise);
                                }
                            });
                        }
                    }).bind("127.0.0.1", 0).sync().channel();
            channels.add(listener);
            port = ((InetSocketAddress)listener.localAddress()).getPort();
        }
        @Override public void close() {
            channels.close().awaitUninterruptibly();
            boss.shutdownGracefully(0, 2, TimeUnit.SECONDS).awaitUninterruptibly();
            workers.shutdownGracefully(0, 2, TimeUnit.SECONDS).awaitUninterruptibly();
        }
    }

    @Test @Timeout(40) void actualClientSupportsConcurrentSessionsChineseEchoHeartbeatAndReconnect() throws Exception {
        try (Server server = new Server(false, false);
             Client first = new Client(server.port); Client second = new Client(server.port)) {
            first.connected(); second.connected();
            first.echo("客户端一：中文与换行\n第二行");
            second.echo("客户端二：互不影响");
            assertEquals("客户端一：中文与换行\n第二行", new JSONObject(first.next(5)).getString("message"));
            assertEquals("客户端二：互不影响", new JSONObject(second.next(5)).getString("message"));
            assertEquals("PONG", new JSONObject(first.next(25)).getString("type"));
            assertEquals("PONG", new JSONObject(second.next(5)).getString("type"));
            first.close();
            assertTrue(first.closed.await(5, TimeUnit.SECONDS));
            second.echo("另一连接仍然有效");
            assertEquals("另一连接仍然有效", new JSONObject(second.next(5)).getString("message"));
            try (Client reconnect = new Client(server.port)) {
                reconnect.connected();
                reconnect.echo("重新握手成功");
                assertEquals("重新握手成功", new JSONObject(reconnect.next(5)).getString("message"));
            }
            assertEquals(3, server.received.stream().filter(f -> f.type == PUBLIC_KEY_REQUEST).count());
            for (WireProtocol.Frame frame : server.received) {
                if (frame.type == PUBLIC_KEY_REQUEST || frame.type == CLIENT_KEY) {
                    assertFalse(frame.encrypted);
                    assertFalse(new String(WireProtocol.plain(frame).control, StandardCharsets.UTF_8).contains("DID"));
                } else {
                    assertTrue(frame.encrypted, "Post-exchange frame must be encrypted");
                    assertFalse(new String(frame.bytes(), StandardCharsets.ISO_8859_1).contains("TID"));
                }
            }
        }
    }

    @Test @Timeout(10) void actualClientRejectsTamperedHandshakeWithoutReportingConnected() throws Exception {
        try (Server server = new Server(true, false); Client client = new Client(server.port)) {
            assertTrue(client.closed.await(5, TimeUnit.SECONDS));
            assertEquals(0, client.connections.get());
            assertTrue(client.reason.contains("握手失败"));
        }
    }

    @Test @Timeout(20) void actualClientHasAnAbsoluteHandshakeTimeout() throws Exception {
        try (Server server = new Server(false, true); Client client = new Client(server.port)) {
            assertTrue(client.closed.await(15, TimeUnit.SECONDS));
            assertEquals(0, client.connections.get());
            assertTrue(client.reason.contains("超时"));
        }
    }

    @Test @Timeout(30) void completeRoomGameClockReplacementAndHostMigrationUseActualClientReferee() throws Exception {
        String did = UUID.randomUUID().toString().replace("-", "");
        try (Server server = new Server(false, false); Client host = new Client(server.port, did); Client guest = new Client(server.port)) {
            host.connected(); guest.connected();
            host.waitEvent("SESSION", e -> true); guest.waitEvent("SESSION", e -> true);
            host.request(new JSONObject().put("type", "CREATE").put("name", "联机验收"));
            JSONObject created = host.waitEvent("ROOM", e -> true);
            guest.request(new JSONObject().put("type", "JOIN").put("roomId", created.getLong("roomId")));
            host.waitEvent("ROOM", e -> e.getJSONArray("members").length() == 2);
            guest.waitEvent("ROOM", e -> true);
            guest.waitEvent("STATE", e -> true);
            host.action(new JSONObject().put("type", "READY").put("ready", true));
            guest.action(new JSONObject().put("type", "READY").put("ready", true));
            host.waitEvent("ROOM", e -> e.getBoolean("playing"));
            guest.waitEvent("ROOM", e -> e.getBoolean("playing"));
            JSONObject initial = guest.waitEvent("STATE", e -> e.getJSONObject("state").has("board")).getJSONObject("state");
            assertEquals(32, initial.getJSONArray("board").length());
            for (int i = 0; i < 32; i++) assertEquals(99, initial.getJSONArray("board").getInt(i));
            Client first = initial.getInt("turn") == 0 ? host : guest;
            first.action(new JSONObject().put("type", "MOVE").put("from", -1).put("to", 0).put("move", 0));
            JSONObject moved = guest.waitEvent("STATE", e -> e.getJSONObject("state").optLong("move") == 1).getJSONObject("state");
            assertNotEquals(99, moved.getJSONArray("board").getInt(0));
            assertEquals(-moved.getJSONArray("colors").getInt(0), moved.getJSONArray("colors").getInt(1));
            host.now.set(62000);
            host.refereeQueue.submit(() -> {
                try { host.referee.getClass().getMethod("tick").invoke(host.referee); }
                catch (Exception ex) { throw new RuntimeException(ex); }
            }).get(5, TimeUnit.SECONDS);
            assertEquals("TIMEOUT", guest.waitEvent("GAME_OVER", e -> true).getString("reason"));
            guest.waitEvent("ROOM", e -> !e.getBoolean("playing"));
            host.waitEvent("ROOM", e -> !e.getBoolean("playing"));
            try (Client replacement = new Client(server.port, did)) {
                replacement.connected(); replacement.waitEvent("SESSION", e -> true);
                assertTrue(host.closed.await(5, TimeUnit.SECONDS));
                JSONObject migrated = guest.waitEvent("ROOM", e -> e.getJSONArray("members").length() == 1);
                assertEquals(guest.self, migrated.getString("hostId"));
                guest.request(new JSONObject().put("type", "LEAVE"));
                guest.waitEvent("ROOM_CLOSED", e -> true);
                replacement.request(new JSONObject().put("type", "LIST"));
                long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
                JSONObject list = null;
                while (System.nanoTime() < end) {
                    JSONObject candidate = new JSONObject(replacement.next(5));
                    if ("ROOMS".equals(candidate.optString("type"))) { list = candidate; break; }
                }
                assertNotNull(list); assertEquals(0, list.getJSONArray("rooms").length());
            }
        }
    }
}
