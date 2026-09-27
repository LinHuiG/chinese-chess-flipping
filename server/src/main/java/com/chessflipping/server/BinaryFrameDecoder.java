package com.chessflipping.server;

import com.chessflipping.protocol.WireProtocol;
import io.netty.buffer.ByteBuf;
import io.netty.channel.ChannelHandlerContext;
import io.netty.handler.codec.ByteToMessageDecoder;
import java.nio.ByteBuffer;
import java.util.List;

/** Handles TCP fragmentation/coalescing and rejects invalid headers before allocation. */
public final class BinaryFrameDecoder extends ByteToMessageDecoder {
    @Override protected void decode(ChannelHandlerContext ctx, ByteBuf in, List<Object> out) throws Exception {
        if (in.readableBytes() < WireProtocol.HEADER_SIZE) return;
        byte[] header = new byte[WireProtocol.HEADER_SIZE];
        in.getBytes(in.readerIndex(), header);
        WireProtocol.validateHeader(header);
        int length = ByteBuffer.wrap(header).getInt(WireProtocol.TOTAL_OFFSET);
        if (in.readableBytes() < length) return;
        byte[] bytes = new byte[length];
        in.readBytes(bytes);
        out.add(WireProtocol.decode(bytes));
    }
}
