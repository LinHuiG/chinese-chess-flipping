package com.chessflipping.client;

import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;

/** One background I/O worker per connection; no network operations on the UI thread. */
public final class TcpClient implements AutoCloseable {
    public interface Listener {
        void onConnected();
        void onMessage(String message);
        void onClosed(String reason);
    }
    private final ExecutorService reader = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService writer = Executors.newSingleThreadScheduledExecutor();
    private final Listener listener;
    private final Socket socket = new Socket();
    private volatile boolean closed;
    private BufferedWriter output;

    public TcpClient(Listener listener) { this.listener = listener; }

    public void connect(String host, int port) {
        reader.execute(() -> {
            String reason = "连接已关闭";
            try {
                socket.connect(new InetSocketAddress(host, port), 8000);
                socket.setSoTimeout(70000);
                socket.setTcpNoDelay(true);
                output = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
                if (closed) return;
                listener.onConnected();
                writer.scheduleAtFixedRate(() -> write("{\"type\":\"PING\"}"), 20, 20, TimeUnit.SECONDS);
                BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                StringBuilder line = new StringBuilder();
                int c;
                while (!closed && (c = input.read()) != -1) {
                    if (c == '\n') { listener.onMessage(line.toString()); line.setLength(0); }
                    else if (c != '\r') {
                        if (line.length() >= 16384) throw new IOException("响应消息过长");
                        line.append((char)c);
                    }
                }
            } catch (Exception ex) { if (!closed) reason = "连接中断：" + ex.getMessage(); }
            finally { close(); listener.onClosed(reason); }
        });
    }

    public void echo(String message) {
        try {
            String json = new JSONObject().put("type", "ECHO").put("message", message).toString();
            if (json.getBytes(StandardCharsets.UTF_8).length > 8192) {
                listener.onMessage("消息太长，请缩短后重试"); return;
            }
            writer.execute(() -> write(json));
        } catch (RejectedExecutionException ignored) {
        } catch (org.json.JSONException ex) { listener.onMessage("消息编码失败"); }
    }

    private void write(String json) {
        if (closed || output == null) return;
        try { output.write(json); output.write('\n'); output.flush(); }
        catch (IOException ex) { close(); }
    }

    @Override public void close() {
        closed = true;
        try { socket.close(); } catch (IOException ignored) { }
        writer.shutdownNow(); reader.shutdownNow();
    }
}
