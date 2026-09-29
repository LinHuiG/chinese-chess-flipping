package com.chessflipping.client;

import com.chessflipping.protocol.WireProtocol;
import okhttp3.*;
import okio.ByteString;
import org.json.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;

/** Common v2 packets over WebSocket, with optional system TLS. */
public final class WsClient extends WebSocketListener implements GameConnection {
    private static final OkHttpClient HTTP = new OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS)
            .writeTimeout(5, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).build();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private final JSONObject identity;
    private final boolean secure;
    private final TcpClient.Listener listener;
    private WebSocket socket;
    private boolean closed, started, ready;
    private long pongAt, pingAt, startedAt;
    public WsClient(JSONObject identity, boolean secure, TcpClient.Listener listener) {
        this.identity = identity; this.secure = secure; this.listener = listener;
    }
    @Override public synchronized void connect(String host, int port) {
        if (closed || started) return;
        started = true; startedAt = System.nanoTime();
        try {
            HttpUrl url = new HttpUrl.Builder().scheme(secure ? "https" : "http").host(host).port(port).addPathSegment("ws").build();
            socket = HTTP.newWebSocket(new Request.Builder().url(url).build(), this);
            timer.scheduleWithFixedDelay(this::tick, 1, 1, TimeUnit.SECONDS);
        } catch (Exception ex) { stop("服务器地址无效"); }
    }
    @Override public synchronized void onOpen(WebSocket ws, Response response) {
        if (closed) { ws.cancel(); return; }
        try {
            JSONObject meta = new JSONObject(identity.toString()).put("CHL", "ANDROID").put("protocol", 2).put("UDP", 1);
            send(new WireProtocol.Packet(5, meta.toString().getBytes(StandardCharsets.UTF_8), new byte[0]));
        } catch (Exception ex) { stop("握手失败"); }
    }
    @Override public synchronized void onMessage(WebSocket ws, ByteString bytes) {
        if (closed) return;
        try {
            if (bytes.size() > WireProtocol.MAX_FRAME) throw new IllegalArgumentException();
            WireProtocol.Packet packet = WireProtocol.plain(WireProtocol.decode(bytes.toByteArray()));
            if (!ready) {
                if (packet.type != 6) throw new IllegalArgumentException();
                ready = true; pongAt = pingAt = System.nanoTime(); listener.onConnected(); return;
            }
            if (packet.type == WireProtocol.PONG) {
                JSONObject header = new JSONObject(new String(packet.control, StandardCharsets.UTF_8));
                if (header.optLong("ping", -1) != pingAt) return;
                pongAt = System.nanoTime(); listener.onLatency(TimeUnit.NANOSECONDS.toMillis(pongAt - pingAt));
                listener.onJsonMessage(new JSONObject().put("type", "PONG"), false);
            } else if (packet.type == 51) listener.onAppChunk(new JSONObject(new String(packet.control, StandardCharsets.UTF_8)), packet.body);
            else if (packet.type == WireProtocol.BUSINESS_EVENT || packet.type == 49) listener.onJsonMessage(GameConnection.message(packet), true);
            else throw new IllegalArgumentException();
        } catch (Exception ex) { stop("协议不匹配，请升级客户端和服务器"); }
    }
    @Override public void onMessage(WebSocket ws, String text) { stop("协议不匹配，请升级客户端和服务器"); }
    @Override public void onClosing(WebSocket ws, int code, String reason) { ws.close(code, null); stop("连接已关闭"); }
    @Override public void onClosed(WebSocket ws, int code, String reason) { stop("连接已关闭"); }
    @Override public void onFailure(WebSocket ws, Throwable error, Response response) { stop("连接失败，请检查网络或证书"); }
    @Override public synchronized void request(JSONObject request) {
        if (!ready || closed) return;
        try { send(GameConnection.packet(request)); if ("LOGOUT".equals(request.optString("type"))) socket.close(1000, "logout"); } catch (Exception ex) { stop("消息发送失败"); }
    }
    private void send(WireProtocol.Packet packet) throws Exception {
        if (!closed && (socket == null || socket.queueSize() > 262144 || !socket.send(ByteString.of(WireProtocol.plain(packet))))) stop("发送队列已满或连接中断");
    }
    private synchronized void tick() {
        if (closed) return;
        long now = System.nanoTime();
        if (!ready) { if (now - startedAt >= TimeUnit.SECONDS.toNanos(18)) stop("连接超时"); return; }
        if (now - pongAt >= TimeUnit.SECONDS.toNanos(15)) { stop("心跳中断，正在重连"); return; }
        if (now - pingAt >= TimeUnit.SECONDS.toNanos(5)) {
            try {
                pingAt = now; send(new WireProtocol.Packet(32,
                        new JSONObject().put("ping", now).toString().getBytes(StandardCharsets.UTF_8), new byte[]{'{','}'}));
            } catch (Exception ex) { stop("心跳失败"); }
        }
    }
    private synchronized void stop(String reason) {
        if (closed) return;
        closed = true; ready = false; timer.shutdownNow();
        if (socket != null) socket.cancel(); listener.onClosed(reason);
    }
    @Override public void close() { stop("连接已关闭"); }
}
