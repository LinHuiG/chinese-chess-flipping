package com.chessflipping.server;

import com.chessflipping.protocol.KeyExchange;
import io.netty.bootstrap.ServerBootstrap;
import io.netty.buffer.PooledByteBufAllocator;
import io.netty.channel.*;
import io.netty.channel.group.DefaultChannelGroup;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioServerSocketChannel;
import io.netty.util.concurrent.GlobalEventExecutor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;
import java.security.GeneralSecurityException;
import java.security.KeyPair;

@Component
public class TcpServer implements SmartLifecycle {
    private static final Logger LOG = LoggerFactory.getLogger(TcpServer.class);
    private final TcpProperties config;
    private final DefaultChannelGroup channels = new DefaultChannelGroup(GlobalEventExecutor.INSTANCE);
    private EventLoopGroup acceptor;
    private EventLoopGroup workers;
    private volatile boolean running;
    private RoomHub rooms;

    public TcpServer(TcpProperties config) { this.config = config; }

    public static void configurePipeline(ChannelPipeline pipeline, KeyPair serverKey) {
        configurePipeline(pipeline, serverKey, new RoomHub());
    }

    public static void configurePipeline(ChannelPipeline pipeline, KeyPair serverKey, RoomHub rooms) {
        pipeline.addLast(new BinaryFrameDecoder(), new ProtocolHandler(serverKey, rooms));
    }

    @Override public synchronized void start() {
        if (running) return;
        final KeyPair serverKey;
        try { serverKey = KeyExchange.generateKeyPair(); }
        catch (GeneralSecurityException ex) { throw new IllegalStateException("Unable to initialize session encryption", ex); }
        acceptor = new NioEventLoopGroup(1);
        workers = new NioEventLoopGroup(config.workerThreads());
        rooms = new RoomHub();
        // Small heap arenas and no per-thread caches avoid CPU-count-sized direct-memory pools.
        PooledByteBufAllocator allocator = new PooledByteBufAllocator(false,
                Math.min(config.workerThreads(), 2), 0, 8192, 4, 0, 0, false);
        try {
            Channel listener = new ServerBootstrap().group(acceptor, workers)
                    .channel(NioServerSocketChannel.class)
                    .option(ChannelOption.SO_BACKLOG, 128)
                    .childOption(ChannelOption.TCP_NODELAY, true)
                    .childOption(ChannelOption.SO_KEEPALIVE, true)
                    .childOption(ChannelOption.ALLOCATOR, allocator)
                    .childOption(ChannelOption.WRITE_BUFFER_WATER_MARK, new WriteBufferWaterMark(32768, 65536))
                    .childOption(ChannelOption.RCVBUF_ALLOCATOR, new AdaptiveRecvByteBufAllocator(256, 1024, 16384))
                    .childHandler(new ChannelInitializer<SocketChannel>() {
                        @Override protected void initChannel(SocketChannel channel) {
                            channels.add(channel);
                            configurePipeline(channel.pipeline(), serverKey, rooms);
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
