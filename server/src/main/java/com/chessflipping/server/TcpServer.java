package com.chessflipping.server;

import io.netty.bootstrap.ServerBootstrap;
import io.netty.channel.*;
import io.netty.channel.group.DefaultChannelGroup;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioServerSocketChannel;
import io.netty.handler.codec.LineBasedFrameDecoder;
import io.netty.handler.codec.string.StringDecoder;
import io.netty.handler.codec.string.StringEncoder;
import io.netty.handler.timeout.IdleStateHandler;
import io.netty.util.CharsetUtil;
import io.netty.util.concurrent.GlobalEventExecutor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

@Component
public class TcpServer implements SmartLifecycle {
    private static final Logger LOG = LoggerFactory.getLogger(TcpServer.class);
    private final TcpProperties config;
    private final DefaultChannelGroup channels = new DefaultChannelGroup(GlobalEventExecutor.INSTANCE);
    private EventLoopGroup acceptor;
    private EventLoopGroup workers;
    private volatile boolean running;

    public TcpServer(TcpProperties config) { this.config = config; }

    public static void configurePipeline(ChannelPipeline pipeline) {
        pipeline.addLast(new IdleStateHandler(90, 0, 0),
                new LineBasedFrameDecoder(8192, true, true),
                new StringDecoder(CharsetUtil.UTF_8), new StringEncoder(CharsetUtil.UTF_8),
                new ProtocolHandler());
    }

    @Override public synchronized void start() {
        if (running) return;
        acceptor = new NioEventLoopGroup(1);
        workers = new NioEventLoopGroup(config.workerThreads());
        try {
            Channel listener = new ServerBootstrap().group(acceptor, workers)
                    .channel(NioServerSocketChannel.class)
                    .option(ChannelOption.SO_BACKLOG, 128)
                    .childOption(ChannelOption.TCP_NODELAY, true)
                    .childOption(ChannelOption.SO_KEEPALIVE, true)
                    .childHandler(new ChannelInitializer<SocketChannel>() {
                        @Override protected void initChannel(SocketChannel channel) {
                            channels.add(channel);
                            configurePipeline(channel.pipeline());
                        }
                    }).bind("0.0.0.0", config.port()).sync().channel();
            channels.add(listener);
            running = true;
            LOG.info("TCP server listening on 0.0.0.0:{}, worker threads={}", config.port(), config.workerThreads());
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt(); stop(); throw new IllegalStateException("TCP startup interrupted", ex);
        } catch (RuntimeException ex) { stop(); throw ex; }
    }

    @Override public synchronized void stop() {
        channels.close().awaitUninterruptibly();
        if (acceptor != null) acceptor.shutdownGracefully(0, 5, java.util.concurrent.TimeUnit.SECONDS).awaitUninterruptibly();
        if (workers != null) workers.shutdownGracefully(0, 5, java.util.concurrent.TimeUnit.SECONDS).awaitUninterruptibly();
        running = false;
    }
    @Override public boolean isRunning() { return running; }
}
