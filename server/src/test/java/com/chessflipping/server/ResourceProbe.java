package com.chessflipping.server;

import com.chessflipping.protocol.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import static com.chessflipping.protocol.WireProtocol.*;

/** Manual bounded TCP resource probe; not part of the default unit-test run. */
public final class ResourceProbe {
    private static final class Connection implements AutoCloseable {
        final Socket socket = new Socket();
        final InputStream in;
        final OutputStream out;
        final SecureSession crypto;
        Connection(int port) throws Exception {
            socket.connect(new InetSocketAddress("127.0.0.1", port), 5000); socket.setSoTimeout(5000);
            in = socket.getInputStream(); out = socket.getOutputStream();
            String tid = UUID.randomUUID().toString().replace("-", "");
            byte[] control = bytes("{\"TID\":\"" + tid + "\"}");
            byte[] request = plain(new Packet(PUBLIC_KEY_REQUEST, control, new byte[0])); out.write(request);
            Frame helloFrame = read(in); Packet hello = plain(helloFrame);
            var key = KeyExchange.generateKeyPair(); byte[] local = KeyExchange.hello(key);
            byte[] exchange = plain(new Packet(CLIENT_KEY, control, local));
            byte[] transcript = KeyExchange.transcript(request, helloFrame.bytes(), exchange);
            crypto = KeyExchange.derive(true, key, hello.body, local, transcript); out.write(exchange);
            Packet finished = crypto.decrypt(read(in));
            if (!MessageDigest.isEqual(transcript, finished.body)) throw new IOException("Bad handshake");
            byte[] metadata = bytes("{\"TID\":\"" + tid + "\",\"DID\":\"" + tid + "\",\"CHL\":\"ANDROID\",\"APP\":\"probe\",\"VER\":\"1\"}");
            out.write(crypto.encrypt(new Packet(CLIENT_FINISHED, metadata, transcript)));
            if (crypto.decrypt(read(in)).type != READY || crypto.decrypt(read(in)).type != BUSINESS_EVENT) throw new IOException("Not ready");
        }
        void ping() throws Exception {
            byte[] control = bytes("{\"TID\":\"" + UUID.randomUUID().toString().replace("-", "") + "\"}");
            out.write(crypto.encrypt(new Packet(PING, control, bytes("{}"))));
            if (crypto.decrypt(read(in)).type != PONG) throw new IOException("Missing heartbeat");
        }
        public void close() throws IOException { crypto.close(); socket.close(); }
    }
    private static byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }
    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args[0]), count = Integer.parseInt(args[1]);
        List<Connection> connections = new ArrayList<>();
        try {
            for (int i = 0; i < count; i++) connections.add(new Connection(port));
            System.out.println("READY connections=" + count); System.out.flush();
            for (int cycle = 0; cycle < 8; cycle++) {
                for (Connection connection : connections) connection.ping();
                Thread.sleep(5000);
            }
            System.out.println("COMPLETE heartbeatCycles=8");
        } finally { for (Connection connection : connections) connection.close(); }
    }
}
