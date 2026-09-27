package com.chessflipping.server;

import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import io.netty.channel.embedded.EmbeddedChannel;
import io.netty.util.CharsetUtil;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ProtocolTest {
    private EmbeddedChannel channel() {
        EmbeddedChannel ch = new EmbeddedChannel();
        TcpServer.configurePipeline(ch.pipeline());
        ch.pipeline().fireChannelActive();
        read(ch);
        return ch;
    }
    private String read(EmbeddedChannel ch) {
        ByteBuf buffer = ch.readOutbound();
        if (buffer == null) return null;
        try { return buffer.toString(CharsetUtil.UTF_8); } finally { buffer.release(); }
    }
    private void send(EmbeddedChannel ch, String text) { ch.writeInbound(Unpooled.copiedBuffer(text, CharsetUtil.UTF_8)); }
    @Test void supportsFragmentedAndCoalescedFrames() {
        EmbeddedChannel ch = channel();
        try {
            send(ch, "{\"type\":\"PI"); assertNull(read(ch));
            send(ch, "NG\",\"requestId\":\"1\"}\n{\"type\":\"ECHO\",\"message\":\"你好\"}\n");
            assertEquals("{\"type\":\"PONG\",\"requestId\":\"1\"}\n", read(ch));
            assertEquals("{\"type\":\"ECHO\",\"message\":\"你好\"}\n", read(ch));
        } finally { ch.finishAndReleaseAll(); }
    }
    @Test void rejectsMalformedMessagesAndRemainsUsable() {
        EmbeddedChannel ch = channel();
        try {
            send(ch, "oops\n{\"type\":\"NOPE\"}\n{\"type\":\"PING\"}\n");
            assertTrue(read(ch).contains("INVALID_JSON"));
            assertTrue(read(ch).contains("UNKNOWN_TYPE"));
            assertTrue(read(ch).contains("PONG"));
        } finally { ch.finishAndReleaseAll(); }
    }
    @Test void closesOversizedFrames() {
        EmbeddedChannel ch = channel();
        try { send(ch, "x".repeat(8193)); assertFalse(ch.isActive()); }
        finally { ch.finishAndReleaseAll(); }
    }
    @Test void validatesConfig() {
        assertThrows(IllegalArgumentException.class, () -> new TcpProperties(0, 4));
        assertThrows(IllegalArgumentException.class, () -> new TcpProperties(9000, 0));
    }
}
