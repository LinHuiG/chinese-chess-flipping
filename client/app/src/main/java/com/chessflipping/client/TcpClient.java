package com.chessflipping.client;

import com.chessflipping.protocol.KeyExchange;
import com.chessflipping.protocol.SecureSession;
import com.chessflipping.protocol.WireProtocol;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.*;
import java.net.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.MessageDigest;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import static com.chessflipping.protocol.WireProtocol.*;

/** Pure Java transport. All socket I/O is off the UI thread; one client per connection. */
public final class TcpClient implements AutoCloseable {
    public interface Listener {
        void onStatus(String status);
        void onConnected();
        void onMessage(String message);
        void onClosed(String reason);
        default void onEvent(String message) { }
    }

    private final ExecutorService reader = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService writer = Executors.newSingleThreadScheduledExecutor();
    private final ConcurrentMap<String, Integer> pending = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, Long> sentAt = new ConcurrentHashMap<>();
    private final Semaphore outstanding = new Semaphore(128);
    private final AtomicBoolean closed = new AtomicBoolean(), started = new AtomicBoolean();
    private final Object closeLock = new Object();
    private final Listener listener;
    private final String deviceId, app, version;
    private final Socket socket = new Socket();
    private volatile boolean ready;
    private volatile String closeReason = "连接已关闭";
    private volatile SecureSession session;
    private OutputStream output;
    private volatile long lastPong;

    public TcpClient(String deviceId, String app, String version, Listener listener) {
        this.deviceId = deviceId;
        this.app = app;
        this.version = version;
        this.listener = listener;
    }

    public void connect(String host, int port) {
        if (closed.get() || !started.compareAndSet(false, true)) return;
        try { reader.execute(() -> runConnection(host, port)); }
        catch (RejectedExecutionException ignored) { }
    }

    private void runConnection(String host, int port) {
        try {
            socket.connect(new InetSocketAddress(host, port), 8000);
            socket.setTcpNoDelay(true);
            socket.setSoTimeout(10000);
            output = new BufferedOutputStream(socket.getOutputStream());
            InputStream input = new BufferedInputStream(socket.getInputStream());
            if (closed.get()) return;
            listener.onStatus("正在进行加密握手…");
            ScheduledFuture<?> deadline = writer.schedule(() -> stop("加密握手超时"), 10, TimeUnit.SECONDS);
            try { handshake(input); }
            finally { deadline.cancel(false); }
            if (closed.get()) return;
            socket.setSoTimeout(35000);
            ready = true;
            lastPong = System.nanoTime();
            listener.onConnected();
            writer.scheduleWithFixedDelay(() -> queueRequest(PING, new byte[]{'{', '}'}), 5, 5, TimeUnit.SECONDS);
            writer.scheduleWithFixedDelay(() -> {
                long now = System.nanoTime();
                if (now - lastPong >= TimeUnit.SECONDS.toNanos(30)
                        || sentAt.values().stream().anyMatch(time -> now - time >= TimeUnit.SECONDS.toNanos(15)))
                    stop("服务端响应超时");
            }, 1, 1, TimeUnit.SECONDS);
            while (!closed.get()) {
                WireProtocol.Frame frame = WireProtocol.read(input);
                if (frame == null) throw new EOFException("服务端关闭了连接");
                receive(session.decrypt(frame));
            }
        } catch (SocketTimeoutException ex) {
            stop(ready ? "等待服务端响应超时" : "连接或加密握手超时");
        } catch (Exception ex) {
            stop(ready ? "通信中断或报文校验失败，请重新连接" : "连接或加密握手失败，请检查服务器地址及协议版本");
        } finally {
            stop(closeReason);
            // Also dispose a session that finished deriving concurrently with a timeout/close.
            SecureSession current = session;
            if (current != null) current.close();
            pending.clear();
            sentAt.clear();
            listener.onClosed(closeReason);
        }
    }

    private void handshake(InputStream input) throws Exception {
        String tid = newTid();
        byte[] request = WireProtocol.plain(new WireProtocol.Packet(PUBLIC_KEY_REQUEST, control(tid), new byte[0]));
        writeRaw(request);
        WireProtocol.Frame helloFrame = requiredFrame(input);
        WireProtocol.Packet hello = WireProtocol.plain(helloFrame);
        validateResponse(hello, SERVER_HELLO, tid);
        KeyExchange.publicKey(hello.body);
        KeyPair local = KeyExchange.generateKeyPair();
        byte[] clientHello = KeyExchange.hello(local);
        byte[] keyFrame = WireProtocol.plain(new WireProtocol.Packet(CLIENT_KEY, control(tid), clientHello));
        byte[] transcript = KeyExchange.transcript(request, helloFrame.bytes(), keyFrame);
        session = KeyExchange.derive(true, local, hello.body, clientHello, transcript);
        writeRaw(keyFrame);

        WireProtocol.Packet finished = session.decrypt(requiredFrame(input));
        validateResponse(finished, SERVER_FINISHED, tid);
        if (!MessageDigest.isEqual(transcript, finished.body)) throw new IOException("Handshake transcript mismatch");
        byte[] metadata = new JSONObject().put("TID", tid).put("CHL", "ANDROID").put("DID", deviceId)
                .put("APP", app).put("VER", version).toString().getBytes(StandardCharsets.UTF_8);
        writeSecure(new WireProtocol.Packet(CLIENT_FINISHED, metadata, transcript));
        WireProtocol.Packet acknowledgement = session.decrypt(requiredFrame(input));
        validateResponse(acknowledgement, READY, tid);
        if (!MessageDigest.isEqual(transcript, acknowledgement.body)) throw new IOException("Handshake confirmation mismatch");
    }

    private static WireProtocol.Frame requiredFrame(InputStream input) throws IOException {
        WireProtocol.Frame frame = WireProtocol.read(input);
        if (frame == null) throw new EOFException("Handshake connection closed");
        return frame;
    }

    private static void validateResponse(WireProtocol.Packet packet, int type, String tid) throws Exception {
        JSONObject header = object(packet.control);
        if (packet.type != type || !tid.equals(header.get("TID")) || !success(header))
            throw new IOException("Unexpected handshake response");
    }

    private static boolean success(JSONObject control) throws Exception {
        Object code = control.get("CODE");
        return (code instanceof Integer || code instanceof Long) && ((Number)code).longValue() == 0;
    }

    private void receive(WireProtocol.Packet packet) throws Exception {
        JSONObject header = object(packet.control);
        Object id = header.get("TID");
        if (!(id instanceof String) || !((String)id).matches("[0-9a-f]{32}")) throw new IOException("Invalid TID");
        if (packet.type == BUSINESS_EVENT) {
            if (!success(header)) throw new IOException("Invalid event status");
            listener.onEvent(object(packet.body).toString());
            return;
        }
        Integer expected = pending.remove((String)id);
        sentAt.remove((String)id);
        if (expected == null || (packet.type != expected && packet.type != ERROR))
            throw new IOException("Unmatched response");
        outstanding.release();
        JSONObject body = object(packet.body);
        if (packet.type == ERROR) {
            if (success(header)) throw new IOException("Invalid error status");
            listener.onMessage("服务端错误：" + header.optString("MSG", "请求失败"));
        } else {
            if (!success(header)) throw new IOException("Invalid response status");
            if (packet.type == PONG) lastPong = System.nanoTime();
            listener.onMessage(body.toString());
        }
    }

    public void echo(String message) {
        try { request(new JSONObject().put("type", "ECHO").put("message", message)); }
        catch (org.json.JSONException ex) { listener.onMessage("消息编码失败"); }
    }

    public void request(JSONObject request) {
        if (!ready || closed.get()) { listener.onMessage("请等待加密连接建立"); return; }
            byte[] body = request.toString().getBytes(StandardCharsets.UTF_8);
            if (body.length > MAX_BODY) { listener.onMessage("消息太长，请缩短后重试"); return; }
            if (!outstanding.tryAcquire()) { listener.onMessage("等待中的请求过多，请稍后重试"); return; }
            try { writer.execute(() -> sendRequest(BUSINESS_REQUEST, body)); }
            catch (RejectedExecutionException ex) { outstanding.release(); }
    }

    private void queueRequest(int type, byte[] body) {
        if (!ready || closed.get()) return;
        if (!outstanding.tryAcquire()) { stop("服务端未及时响应，请重新连接"); return; }
        sendRequest(type, body);
    }

    /** Called only by the single writer executor, preserving nonce/write ordering. */
    private void sendRequest(int type, byte[] body) {
        if (closed.get()) { outstanding.release(); return; }
        String tid = newTid();
        pending.put(tid, type == PING ? PONG : BUSINESS_RESPONSE);
        sentAt.put(tid, System.nanoTime());
        try { writeSecure(new WireProtocol.Packet(type, control(tid), body)); }
        catch (Exception ex) { stop("消息发送失败，请重新连接"); }
    }

    private synchronized void writeSecure(WireProtocol.Packet packet) throws Exception {
        if (closed.get()) throw new IOException("Connection closed");
        writeRaw(session.encrypt(packet));
    }

    private synchronized void writeRaw(byte[] bytes) throws IOException {
        if (closed.get()) throw new IOException("Connection closed");
        output.write(bytes);
        output.flush();
    }

    private static byte[] control(String tid) throws org.json.JSONException {
        return new JSONObject().put("TID", tid).toString().getBytes(StandardCharsets.UTF_8);
    }

    private static String newTid() { return UUID.randomUUID().toString().replace("-", ""); }

    private static JSONObject object(byte[] bytes) throws Exception {
        String text = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
        JSONTokener parser = new JSONTokener(text);
        Object value = parser.nextValue();
        if (!(value instanceof JSONObject) || parser.nextClean() != 0) throw new IOException("Expected JSON object");
        return (JSONObject)value;
    }

    private void stop(String reason) {
        synchronized (closeLock) {
            if (closed.get()) return;
            closeReason = reason;
            ready = false;
            closed.set(true);
        }
        try { socket.close(); } catch (IOException ignored) { }
        writer.shutdownNow();
        reader.shutdownNow();
        SecureSession current = session;
        if (current != null) current.close();
    }

    @Override public void close() { stop("连接已关闭"); }
}
