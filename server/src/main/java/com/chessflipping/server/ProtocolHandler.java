package com.chessflipping.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.SimpleChannelInboundHandler;
import io.netty.handler.timeout.IdleStateEvent;

/** UTF-8 JSON lines; max frame size enforced by the channel pipeline. */
public final class ProtocolHandler extends SimpleChannelInboundHandler<String> {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Override public void channelActive(ChannelHandlerContext ctx) {
        ctx.writeAndFlush("{\"type\":\"WELCOME\",\"protocolVersion\":1}\n");
    }

    @Override protected void channelRead0(ChannelHandlerContext ctx, String message) throws Exception {
        JsonNode request;
        try {
            request = JSON.reader().with(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(message);
            if (request == null || !request.isObject() || !request.path("type").isTextual()) {
                error(ctx, "INVALID_MESSAGE"); return;
            }
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            error(ctx, "INVALID_JSON"); return;
        }
        ObjectNode response = JSON.createObjectNode();
        switch (request.path("type").asText()) {
            case "PING" -> response.put("type", "PONG");
            case "ECHO" -> {
                if (!request.path("message").isTextual()) { error(ctx, "INVALID_MESSAGE"); return; }
                response.put("type", "ECHO").put("message", request.path("message").asText());
            }
            default -> { error(ctx, "UNKNOWN_TYPE"); return; }
        }
        if (request.has("requestId") && request.get("requestId").isTextual()) response.set("requestId", request.get("requestId"));
        ctx.writeAndFlush(JSON.writeValueAsString(response) + "\n");
    }

    private void error(ChannelHandlerContext ctx, String code) {
        ctx.writeAndFlush("{\"type\":\"ERROR\",\"code\":\"" + code + "\"}\n");
    }

    @Override public void userEventTriggered(ChannelHandlerContext ctx, Object event) throws Exception {
        if (event instanceof IdleStateEvent) ctx.close();
        else super.userEventTriggered(ctx, event);
    }

    @Override public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) { ctx.close(); }
}
