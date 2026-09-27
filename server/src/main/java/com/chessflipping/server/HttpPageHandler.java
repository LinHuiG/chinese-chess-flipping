package com.chessflipping.server;

import io.netty.buffer.Unpooled;
import io.netty.channel.*;
import io.netty.handler.codec.http.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;

final class HttpPageHandler extends SimpleChannelInboundHandler<FullHttpRequest> {
    private final HttpAssets assets;
    HttpPageHandler(HttpAssets assets) { this.assets = assets; }

    @Override protected void channelRead0(ChannelHandlerContext ctx, FullHttpRequest request) {
        if (!request.decoderResult().isSuccess()) { error(ctx, HttpResponseStatus.BAD_REQUEST); return; }
        String path = new QueryStringDecoder(request.uri()).path();
        if (path.equals("/ws")) {
            // Browsers must connect from the same host. Native clients have no Origin header.
            String origin = request.headers().get(HttpHeaderNames.ORIGIN);
            if (origin != null) {
                try {
                    URI uri = URI.create(origin);
                    if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme()))
                            || !uri.getRawAuthority().equalsIgnoreCase(request.headers().get(HttpHeaderNames.HOST, ""))) {
                        error(ctx, HttpResponseStatus.FORBIDDEN); return;
                    }
                } catch (RuntimeException ex) { error(ctx, HttpResponseStatus.FORBIDDEN); return; }
            }
            ctx.fireChannelRead(request.retain()); return;
        }
        if (!request.method().equals(HttpMethod.GET) && !request.method().equals(HttpMethod.HEAD)) {
            error(ctx, HttpResponseStatus.METHOD_NOT_ALLOWED); return;
        }
        HttpAssets.Asset asset = assets.get(path);
        if (asset == null) { error(ctx, HttpResponseStatus.NOT_FOUND); return; }
        FullHttpResponse response = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.OK,
                request.method().equals(HttpMethod.HEAD) ? Unpooled.EMPTY_BUFFER : Unpooled.wrappedBuffer(asset.bytes()));
        response.headers().set(HttpHeaderNames.CONTENT_TYPE, asset.type());
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, asset.bytes().length);
        response.headers().set(HttpHeaderNames.CACHE_CONTROL, "no-cache");
        response.headers().set("X-Content-Type-Options", "nosniff");
        response.headers().set("Referrer-Policy", "same-origin");
        response.headers().set("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        response.headers().set(HttpHeaderNames.CONNECTION, HttpHeaderValues.CLOSE);
        ctx.writeAndFlush(response).addListener(ChannelFutureListener.CLOSE);
    }
    private void error(ChannelHandlerContext ctx, HttpResponseStatus status) {
        byte[] body = status.toString().getBytes(StandardCharsets.UTF_8);
        FullHttpResponse response = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status, Unpooled.wrappedBuffer(body));
        response.headers().set(HttpHeaderNames.CONTENT_TYPE, "text/plain; charset=utf-8");
        response.headers().setInt(HttpHeaderNames.CONTENT_LENGTH, body.length);
        ctx.writeAndFlush(response).addListener(ChannelFutureListener.CLOSE);
    }
    @Override public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) { ctx.close(); }
}
