package com.chessflipping.client;

import okhttp3.*;
import org.json.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** Browser-compatible JSON transport, with system TLS certificate validation. */
public final class WsClient extends WebSocketListener implements GameConnection {
    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS).writeTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS).build();
    private record Pending(String type, long sent) { }
    private final Map<String, Pending> pending = new HashMap<>();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private final String did, app, version;
    private final boolean secure;
    private final TcpClient.Listener listener;
    private WebSocket socket;
    private boolean closed, started, ready;
    private String hello;
    private long pongAt, pingAt, startedAt;

    public WsClient(String did, String app, String version, boolean secure, TcpClient.Listener listener) {
        this.did = did; this.app = app; this.version = version; this.secure = secure; this.listener = listener;
    }
    @Override public synchronized void connect(String host, int port) {
        if (closed || started) return;
        started = true; startedAt = System.nanoTime();
        try {
            HttpUrl url = new HttpUrl.Builder().scheme(secure ? "https" : "http").host(host).port(port).addPathSegment("ws").build();
            listener.onStatus(secure ? "正在建立 HTTPS 连接…" : "正在建立 HTTP 连接…");
            socket = HTTP.newWebSocket(new Request.Builder().url(url).build(), this);
            timer.scheduleWithFixedDelay(this::tick, 1, 1, TimeUnit.SECONDS);
        } catch (Exception ex) { stop("服务器地址无效"); }
    }
    @Override public synchronized void onOpen(WebSocket ws, Response response) {
        if (closed) { ws.cancel(); return; }
        try {
            hello = id();
            send(new JSONObject().put("type", "HELLO").put("TID", hello).put("CHL", "ANDROID")
                    .put("DID", did).put("APP", app).put("VER", version).put("UDP", 1));
        } catch (JSONException ex) { stop("握手编码失败"); }
    }
    @Override public synchronized void onMessage(WebSocket ws, String text) {
        if (closed) return;
        try {
            if (tooLarge(text, 69632)) throw new IllegalArgumentException();
            JSONTokener parser = new JSONTokener(text);
            Object value = parser.nextValue();
            if (!(value instanceof JSONObject envelope) || parser.nextClean() != 0) throw new IllegalArgumentException();
            String tid = envelope.getString("TID"), type = envelope.getString("type");
            Object code = envelope.get("CODE");
            if (!tid.matches("[0-9a-f]{32}") || !(code instanceof Number) || ((Number)code).doubleValue() != 0)
                throw new IllegalArgumentException();
            JSONObject body = envelope.getJSONObject("body");
            if (!ready) {
                if (!type.equals("READY") || !tid.equals(hello)) throw new IllegalArgumentException();
                ready = true; pongAt = pingAt = System.nanoTime(); listener.onConnected(); return;
            }
            if (type.equals("EVENT")) { listener.onJsonMessage(body, true); return; }
            Pending expected = pending.remove(tid);
            if (expected == null || !expected.type().equals(type)) throw new IllegalArgumentException();
            if (type.equals("PONG")) { pongAt = System.nanoTime(); listener.onLatency(TimeUnit.NANOSECONDS.toMillis(pongAt - expected.sent())); }
            listener.onJsonMessage(body, false);
        } catch (Exception ex) { stop("服务器消息格式异常，请重新连接"); }
    }
    @Override public void onMessage(WebSocket ws, okio.ByteString bytes) { stop("服务器协议不匹配"); }
    @Override public void onClosing(WebSocket ws, int code, String reason) { ws.close(code, null); stop("服务器关闭了连接"); }
    @Override public void onClosed(WebSocket ws, int code, String reason) { stop("连接已关闭"); }
    @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
        stop(secure ? "HTTPS 连接失败，请检查地址、证书或网络" : "HTTP 连接失败，请检查地址、端口或网络");
    }
    @Override public synchronized void request(JSONObject request) {
        if (!ready || closed) { listener.onMessage("请等待连接建立"); return; }
        String body = request.toString();
        if (tooLarge(body, 65536)) { listener.onMessage("消息太长"); return; }
        queue("REQUEST", "RESPONSE", body);
    }
    private void queue(String type, String expected, String body) {
        if (pending.size() >= 128) { stop("等待中的请求过多，请重新连接"); return; }
        String tid = id();
        pending.put(tid, new Pending(expected, System.nanoTime()));
        send("{\"type\":\"" + type + "\",\"TID\":\"" + tid + "\",\"body\":" + body + "}");
    }
    private void send(JSONObject value) {
        send(value.toString());
    }
    private static boolean tooLarge(String value, int max) { return value.length() > max || (value.length() > max / 3 && value.getBytes(StandardCharsets.UTF_8).length > max); }
    private void send(String text) {
        if (closed) return;
        if (tooLarge(text, 69632)) { stop("消息太长"); return; }
        if (socket == null || socket.queueSize() > 262144 || !socket.send(text)) stop("消息发送失败");
    }
    private synchronized void tick() {
        if (closed) return;
        long now = System.nanoTime();
        if (!ready) { if (now - startedAt >= TimeUnit.SECONDS.toNanos(18)) stop("连接或握手超时"); return; }
        if (now - pongAt >= TimeUnit.SECONDS.toNanos(30)
                || pending.values().stream().anyMatch(p -> now - p.sent() >= TimeUnit.SECONDS.toNanos(15))) {
            stop("服务器响应超时"); return;
        }
        if (now - pingAt >= TimeUnit.SECONDS.toNanos(5)) { pingAt = now; queue("PING", "PONG", "{}"); }
    }
    private synchronized void stop(String reason) {
        if (closed) return;
        closed = true; ready = false; pending.clear(); timer.shutdownNow();
        if (socket != null) socket.cancel();
        listener.onClosed(reason);
    }
    @Override public void close() { stop("连接已关闭"); }
    private static String id() { return UUID.randomUUID().toString().replace("-", ""); }
}
