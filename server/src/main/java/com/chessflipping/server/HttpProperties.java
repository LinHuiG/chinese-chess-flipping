package com.chessflipping.server;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("chess.http")
public record HttpProperties(int port) {
    public HttpProperties {
        if (port < 1 || port > 65535) throw new IllegalArgumentException("HTTP_PORT must be 1..65535");
    }
}
