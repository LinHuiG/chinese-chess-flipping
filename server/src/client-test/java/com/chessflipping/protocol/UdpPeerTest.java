package com.chessflipping.protocol;

import com.chessflipping.client.UdpPeer;
import org.json.*;
import org.junit.jupiter.api.Test;
import java.net.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.UUID;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;

class UdpPeerTest {
    private static String id() { return UUID.randomUUID().toString().replace("-", ""); }
    private static DatagramPacket receive(DatagramSocket socket) throws Exception {
        DatagramPacket packet = new DatagramPacket(new byte[1201], 1201);
        socket.receive(packet); return packet;
    }
    private static void send(DatagramSocket socket, SocketAddress to, byte[] bytes) throws Exception {
        socket.send(new DatagramPacket(bytes, bytes.length, to));
    }

    @Test void authenticatedAlternatePathCarriesProbesDataAndAcknowledgements() throws Exception {
        byte[] master = new byte[32]; new SecureRandom().nextBytes(master);
        String loopback = InetAddress.getLoopbackAddress().getHostAddress();
        String sid = id(); CountDownLatch ready = new CountDownLatch(1), failed = new CountDownLatch(1);
        BlockingQueue<JSONObject> messages = new LinkedBlockingQueue<>();
        UdpPeer.Listener listener = new UdpPeer.Listener() {
            public void local(JSONArray values) { }
            public void ready() { ready.countDown(); }
            public void message(JSONObject value) { messages.add(value); }
            public void latency(long millis) { }
            public void failed() { failed.countDown(); }
        };
        try (DatagramSocket registration = new DatagramSocket(0, InetAddress.getLoopbackAddress());
             DatagramSocket lan = new DatagramSocket(0, InetAddress.getLoopbackAddress());
             DatagramSocket nat = new DatagramSocket(0, InetAddress.getLoopbackAddress());
             UdpSession remote = new UdpSession(sid, master, "asymmetric-path", false);
             UdpPeer peer = new UdpPeer(loopback, registration.getLocalPort(), sid, id(), master, "asymmetric-path", true, listener)) {
            registration.setSoTimeout(3000); lan.setSoTimeout(3000); nat.setSoTimeout(3000);
            SocketAddress target = receive(registration).getSocketAddress();
            peer.candidates(new JSONArray().put(new JSONObject().put("host", loopback).put("port", lan.getLocalPort())));
            DatagramPacket probe = receive(lan);
            UdpSession.Packet ping = remote.decrypt(probe.getData(), probe.getLength());
            assertNotNull(ping); assertEquals(1, ping.type);
            send(lan, target, remote.encrypt(2, ping.body));
            send(lan, target, remote.encrypt(1, ByteBuffer.allocate(8).putLong(42).array()));
            assertTrue(ready.await(3, TimeUnit.SECONDS)); peer.activate();

            // The other direction arrives via NAT even though LAN won our outbound probe.
            send(nat, target, remote.encrypt(1, ByteBuffer.allocate(8).putLong(43).array()));
            DatagramPacket response = receive(nat);
            UdpSession.Packet pong = remote.decrypt(response.getData(), response.getLength());
            assertNotNull(pong); assertEquals(2, pong.type);
            byte[] operation = UdpSession.hex(id());
            byte[] json = "{\"type\":\"SYNC\"}".getBytes(StandardCharsets.UTF_8);
            byte[] body = ByteBuffer.allocate(16 + json.length).put(operation).put(json).array();
            send(nat, target, remote.encrypt(3, body));
            response = receive(nat);
            UdpSession.Packet ack = remote.decrypt(response.getData(), response.getLength());
            assertNotNull(ack); assertEquals(4, ack.type); assertArrayEquals(operation, ack.body);
            JSONObject delivered = messages.poll(3, TimeUnit.SECONDS);
            assertNotNull(delivered); assertEquals("SYNC", delivered.getString("type"));

            assertTrue(peer.send("{\"type\":\"STATE\"}".getBytes(StandardCharsets.UTF_8)));
            UdpSession.Packet data;
            do { response = receive(lan); data = remote.decrypt(response.getData(), response.getLength()); }
            while (data == null || data.type != 3);
            send(nat, target, remote.encrypt(4, java.util.Arrays.copyOf(data.body, 16)));
            assertFalse(failed.await(3500, TimeUnit.MILLISECONDS), "ACK from authenticated alternate path must prevent retry fallback");
        }
    }
}
