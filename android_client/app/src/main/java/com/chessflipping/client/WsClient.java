package com.chessflipping.client;
import com.chessflipping.protocol.WireProtocol;
import okhttp3.*;
import okio.ByteString;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;

public final class WsClient extends WebSocketListener implements GameConnection {
    private static final OkHttpClient HTTP=new OkHttpClient.Builder().connectTimeout(8,TimeUnit.SECONDS).writeTimeout(5,TimeUnit.SECONDS).readTimeout(0,TimeUnit.SECONDS).build();
    private final ScheduledExecutorService timer=Executors.newSingleThreadScheduledExecutor();
    private final JSONObject identity;private final boolean secure;private final TcpClient.Listener listener;
    private WebSocket socket;private boolean closed,started,ready;private long pongAt,pingAt,startedAt;
    public WsClient(JSONObject identity,boolean secure,TcpClient.Listener listener){this.identity=identity;this.secure=secure;this.listener=listener;}
    @Override public synchronized void connect(String host,int port){
        if(closed||started)return;started=true;startedAt=System.currentTimeMillis();
        try{
            HttpUrl url=new HttpUrl.Builder().scheme(secure?"https":"http").host(host).port(port).addPathSegment("ws").build();
            socket=HTTP.newWebSocket(new Request.Builder().url(url).build(),this);timer.scheduleWithFixedDelay(this::tick,1,1,TimeUnit.SECONDS);
        }catch(Exception e){stop("服务器地址无效");}
    }
    @Override public synchronized void onOpen(WebSocket ws,Response response){
        if(closed){ws.cancel();return;}
        try{write(new WireProtocol.Packet(3,new byte[0],identity.toString().getBytes(StandardCharsets.UTF_8)));}catch(Exception e){stop("握手失败");}
    }
    @Override public synchronized void onMessage(WebSocket ws,ByteString bytes){
        if(closed)return;
        try{
            if(bytes.size()>WireProtocol.MAX_FRAME)throw new IllegalArgumentException();
            WireProtocol.Packet packet=WireProtocol.plain(WireProtocol.decode(bytes.toByteArray()));
            if(!ready){
                if(packet.type!=4)throw new IllegalArgumentException();
                ready="1".equals(WireProtocol.control(packet.control).get("ok"));pongAt=pingAt=System.currentTimeMillis();listener.onPacket(packet);
                if(ready)listener.onConnected();else stop("连接身份失效");return;
            }
            if(packet.type==33){JSONObject b=new JSONObject(new String(packet.body,StandardCharsets.UTF_8));if(b.optLong("sentAtMs")!=pingAt)return;pongAt=System.currentTimeMillis();listener.onLatency(pongAt-pingAt);}
            listener.onPacket(packet);
        }catch(Exception e){stop("协议不匹配，请升级客户端和服务器");}
    }
    @Override public void onMessage(WebSocket ws,String text){stop("协议不匹配");}
    @Override public void onClosing(WebSocket ws,int code,String reason){ws.close(code,null);stop("连接已关闭");}
    @Override public void onClosed(WebSocket ws,int code,String reason){stop("连接已关闭");}
    @Override public void onFailure(WebSocket ws,Throwable error,Response response){stop("连接失败，请检查网络或证书");}
    @Override public synchronized boolean send(WireProtocol.Packet packet){if(!ready||closed)return false;try{if("1".equals(WireProtocol.control(packet.control).get("discard"))&&socket.queueSize()>2048)return false;return write(packet);}catch(Exception e){stop("消息发送失败");return false;}}
    private boolean write(WireProtocol.Packet packet)throws Exception{return !closed&&socket!=null&&socket.queueSize()<1048576&&socket.send(ByteString.of(WireProtocol.plain(packet)));}
    private synchronized void tick(){
        if(closed)return;long now=System.currentTimeMillis();
        if(!ready){if(now-startedAt>15000)stop("连接超时");return;}
        if(now-pongAt>15000){stop("心跳中断");return;}
        if(now-pingAt>=5000)try{pingAt=now;if(!write(new WireProtocol.Packet(32,new byte[0],new JSONObject().put("pingId",Long.toString(now)).put("sentAtMs",now).toString().getBytes(StandardCharsets.UTF_8))))stop("心跳失败");}catch(Exception e){stop("心跳失败");}
    }
    private synchronized void stop(String reason){if(closed)return;closed=true;ready=false;timer.shutdownNow();if(socket!=null)socket.cancel();listener.onClosed(reason);}
    @Override public void close(){stop("连接已关闭");}
}
