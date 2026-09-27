package com.chessflipping.server;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("chess.tcp")
public record TcpProperties(int port, int workerThreads) {
    public TcpProperties {
        if (port < 1 || port > 65535) throw new IllegalArgumentException("TCP_PORT must be 1..65535");
        if (workerThreads < 1 || workerThreads > 256) throw new IllegalArgumentException("TCP_WORKER_THREADS must be 1..256");
    }
}
