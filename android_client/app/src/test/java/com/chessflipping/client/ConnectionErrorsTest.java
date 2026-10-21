package com.chessflipping.client;

import java.io.*;
import java.net.*;
import java.util.concurrent.*;
import javax.net.ssl.SSLHandshakeException;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class ConnectionErrorsTest {
    @Test public void networkErrorsIdentifySourceAndNeverRepeatRemoteSecrets(){
        String secret="https://account:password@private.example/?api_key=private-token";
        assertTrue(ConnectionErrors.describe(new UnknownHostException(secret),"连接").contains("域名解析"));
        assertTrue(ConnectionErrors.describe(new SSLHandshakeException(secret),"连接").contains("证书"));
        assertTrue(ConnectionErrors.describe(new SocketTimeoutException(secret),"身份确认").contains("身份确认超时"));
        assertTrue(ConnectionErrors.describe(new ConnectException(secret),"连接").contains("地址、端口"));
        assertTrue(ConnectionErrors.describe(new EOFException(secret),"加密握手").contains("加密握手"));
        assertFalse(ConnectionErrors.describe(new IOException(secret),"通信").contains(secret));
    }
    @Test public void refusedTcpReportsServerConnectionInsteadOfHandshake()throws Exception{
        int port;try(ServerSocket reservation=new ServerSocket(0)){port=reservation.getLocalPort();}
        BlockingQueue<String> reasons=new LinkedBlockingQueue<>();try(TcpClient client=new TcpClient(new JSONObject(),reasons::add)){
            client.connect("127.0.0.1",port);String reason=reasons.poll(4,TimeUnit.SECONDS);assertNotNull(reason);assertTrue(reason.contains("服务端连接失败"));
        }
    }
    @Test public void closedHandshakeIdentifiesTheHandshakeStage()throws Exception{
        BlockingQueue<String> reasons=new LinkedBlockingQueue<>();ExecutorService server=Executors.newSingleThreadExecutor();
        try(ServerSocket socket=new ServerSocket(0);TcpClient client=new TcpClient(new JSONObject(),reasons::add)){
            server.execute(()->{try(Socket accepted=socket.accept()){accepted.getInputStream().read(new byte[17]);}catch(IOException ignored){}});
            client.connect("127.0.0.1",socket.getLocalPort());String reason=reasons.poll(4,TimeUnit.SECONDS);assertNotNull(reason);assertTrue(reason,reason.contains("加密握手期间关闭连接"));
        }finally{server.shutdownNow();}
    }
    @Test public void tricklingHandshakeCannotResetTheOverallDeadline()throws Exception{
        BlockingQueue<String> reasons=new LinkedBlockingQueue<>();ExecutorService server=Executors.newSingleThreadExecutor();
        try(ServerSocket socket=new ServerSocket(0);TcpClient client=new TcpClient(new JSONObject(),reasons::add)){
            server.execute(()->{try(Socket accepted=socket.accept()){accepted.getInputStream().read(new byte[17]);for(int i=0;i<30;i++){accepted.getOutputStream().write(i==0?0xfc:0);accepted.getOutputStream().flush();Thread.sleep(1200);}}catch(Exception ignored){}});
            long started=System.nanoTime();client.connect("127.0.0.1",socket.getLocalPort());String reason=reasons.poll(22,TimeUnit.SECONDS);assertNotNull(reason);assertTrue(reason,reason.contains("连接和握手最多 18 秒"));assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)<21000);
        }finally{server.shutdownNow();}
    }
    @Test public void webSocketGatewayFailureReportsStatusWithoutRemoteBody()throws Exception{
        BlockingQueue<String> reasons=new LinkedBlockingQueue<>();ExecutorService server=Executors.newSingleThreadExecutor();
        try(ServerSocket socket=new ServerSocket(0);WsClient client=new WsClient(new JSONObject(),false,reasons::add)){
            server.execute(()->{try(Socket accepted=socket.accept()){BufferedReader input=new BufferedReader(new InputStreamReader(accepted.getInputStream()));for(String line;(line=input.readLine())!=null&&!line.isEmpty();){}accepted.getOutputStream().write("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 13\r\nConnection: close\r\n\r\nprivate-token".getBytes(java.nio.charset.StandardCharsets.US_ASCII));}catch(IOException ignored){}});
            client.connect("127.0.0.1",socket.getLocalPort());String reason=reasons.poll(4,TimeUnit.SECONDS);assertNotNull(reason);assertTrue(reason,reason.contains("WebSocket 接入失败（HTTP 503）"));assertFalse(reason.contains("private-token"));
        }finally{server.shutdownNow();}
    }
}
