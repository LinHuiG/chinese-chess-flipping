package com.chessflipping.protocol;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.zip.CRC32;

/** Protocol v1. Keep this platform-independent source identical in server and client. */
public final class WireProtocol {
    public static final int HEADER_SIZE = 21, VERSION = 1, ENCRYPTED = 1;
    public static final int MAGIC = 0xFCFC, TOTAL_OFFSET = 2, CRC_OFFSET = 17;
    public static final int MAX_CONTROL = 4096, MAX_BODY = 65536;
    public static final int CRYPTO_OVERHEAD = 28;
    public static final int MAX_FRAME = HEADER_SIZE + MAX_CONTROL + MAX_BODY + CRYPTO_OVERHEAD;
    public static final int PUBLIC_KEY_REQUEST = 1, SERVER_HELLO = 2, CLIENT_KEY = 3,
            SERVER_FINISHED = 4, CLIENT_FINISHED = 5, READY = 6,
            BUSINESS_REQUEST = 16, BUSINESS_RESPONSE = 17, BUSINESS_EVENT = 18, PING = 32, PONG = 33, ERROR = 127;

    private WireProtocol() {}

    public static final class Frame {
        public final int type;
        public final boolean encrypted;
        public final int controlLength, bodyLength;
        private final byte[] bytes;

        private Frame(byte[] bytes) throws IOException {
            validateHeader(bytes);
            if (bytes.length != ByteBuffer.wrap(bytes).getInt(TOTAL_OFFSET)) throw new IOException("Frame length mismatch");
            if (ByteBuffer.wrap(bytes, CRC_OFFSET, 4).getInt() != crc(bytes)) throw new IOException("CRC32 mismatch");
            this.bytes = bytes;
            ByteBuffer header = ByteBuffer.wrap(bytes);
            header.position(TOTAL_OFFSET + 4);
            controlLength = header.getInt();
            bodyLength = header.getInt();
            type = bytes[15] & 255;
            encrypted = bytes[16] == ENCRYPTED;
        }
        public byte[] bytes() { return bytes.clone(); }
        public byte[] aad() { return Arrays.copyOf(bytes, CRC_OFFSET); }
        public byte[] payload() { return Arrays.copyOfRange(bytes, HEADER_SIZE, bytes.length); }
    }

    public static final class Packet {
        public final int type;
        public final byte[] control, body;
        public Packet(int type, byte[] control, byte[] body) {
            this.type = type;
            this.control = control.clone();
            this.body = body.clone();
        }
    }

    public static void validateHeader(byte[] header) throws IOException {
        if (header.length < HEADER_SIZE) throw new IOException("Short header");
        ByteBuffer in = ByteBuffer.wrap(header);
        if ((in.getShort() & 0xFFFF) != MAGIC) throw new IOException("Invalid frame magic");
        int total = in.getInt(), x = in.getInt(), y = in.getInt();
        int version = in.get() & 255, type = in.get() & 255, flags = in.get() & 255;
        if (version != VERSION) throw new IOException("Unsupported protocol version");
        if (flags != 0 && flags != ENCRYPTED) throw new IOException("Unsupported flags/compression");
        if (type == 0 || x < 2 || x > MAX_CONTROL || y < 0 || y > MAX_BODY)
            throw new IOException("Invalid type or lengths");
        long expected = HEADER_SIZE + (long)x + y + (flags == ENCRYPTED ? CRYPTO_OVERHEAD : 0);
        if (total != expected || total > MAX_FRAME) throw new IOException("Invalid total length");
    }

    public static Frame decode(byte[] bytes) throws IOException { return new Frame(bytes.clone()); }

    /** Returns null only on clean EOF between complete frames. */
    public static Frame read(InputStream input) throws IOException {
        byte[] header = new byte[HEADER_SIZE];
        int first = input.read();
        if (first < 0) return null;
        header[0] = (byte)first;
        readFully(input, header, 1, HEADER_SIZE - 1);
        validateHeader(header); // Validate before allocating any peer-controlled size.
        byte[] frame = Arrays.copyOf(header, ByteBuffer.wrap(header).getInt(TOTAL_OFFSET));
        readFully(input, frame, HEADER_SIZE, frame.length - HEADER_SIZE);
        return decode(frame);
    }

    private static void readFully(InputStream in, byte[] bytes, int offset, int length) throws IOException {
        while (length > 0) {
            int count = in.read(bytes, offset, length);
            if (count < 0) throw new EOFException("Truncated frame");
            if (count == 0) continue;
            offset += count;
            length -= count;
        }
    }

    public static byte[] plain(Packet packet) throws IOException {
        byte[] header = header(packet, false);
        return assemble(header, join(packet.control, packet.body));
    }

    public static Packet plain(Frame frame) throws IOException {
        if (frame.encrypted) throw new IOException("Expected plaintext handshake frame");
        return split(frame, frame.payload());
    }

    static byte[] header(Packet packet, boolean encrypted) throws IOException {
        if (packet.type < 1 || packet.type > 255) throw new IOException("Invalid packet type");
        int total = HEADER_SIZE + packet.control.length + packet.body.length + (encrypted ? CRYPTO_OVERHEAD : 0);
        byte[] header = ByteBuffer.allocate(HEADER_SIZE).putShort((short)MAGIC).putInt(total).putInt(packet.control.length)
                .putInt(packet.body.length).put((byte)VERSION).put((byte)packet.type)
                .put((byte)(encrypted ? ENCRYPTED : 0)).putInt(0).array();
        validateHeader(header);
        return header;
    }

    static byte[] assemble(byte[] header, byte[] payload) throws IOException {
        byte[] frame = join(header, payload);
        if (frame.length != ByteBuffer.wrap(header).getInt(TOTAL_OFFSET)) throw new IOException("Payload length mismatch");
        ByteBuffer.wrap(frame).putInt(CRC_OFFSET, crc(frame));
        return frame;
    }

    static Packet split(Frame frame, byte[] plaintext) throws IOException {
        if (plaintext.length != frame.controlLength + frame.bodyLength) throw new IOException("Plaintext length mismatch");
        return new Packet(frame.type, Arrays.copyOf(plaintext, frame.controlLength),
                Arrays.copyOfRange(plaintext, frame.controlLength, plaintext.length));
    }

    public static int crc(byte[] frame) {
        CRC32 crc = new CRC32();
        crc.update(frame, 0, CRC_OFFSET);
        crc.update(frame, HEADER_SIZE, frame.length - HEADER_SIZE);
        return (int)crc.getValue();
    }

    public static byte[] join(byte[]... arrays) {
        int length = 0;
        for (byte[] array : arrays) length = Math.addExact(length, array.length);
        ByteBuffer out = ByteBuffer.allocate(length);
        for (byte[] array : arrays) out.put(array);
        return out.array();
    }
}
