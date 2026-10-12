package com.chessflipping.client;
import com.chessflipping.protocol.*;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.Arrays;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Native TCP transport; the shared client receives decrypted v3 frames only. */
public final class TcpClient implements GameConnection {
    public interface Listener {
        default void onStatus(String status){}
        default void onConnected(){}
        default void onPacket(WireProtocol.Packet packet){}
        default void onLatency(long millis){}
        void onClosed(String reason);
    }
    private final ExecutorService reader=Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService writer=Executors.newSingleThreadScheduledExecutor();
    private final Semaphore outstanding=new Semaphore(128);
    private final AtomicBoolean closed=new AtomicBoolean(),started=new AtomicBoolean();
    private final Listener listener;private final JSONObject identity;private final Socket socket=new Socket();
    private volatile boolean ready;private volatile SecureSession session;private OutputStream output;
    private volatile long lastPong,pingAt;private String reason="连接已关闭";
    public TcpClient(JSONObject identity,Listener listener){this.identity=identity;this.listener=listener;}
    @Override public void connect(String host,int port){
        if(closed.get()||!started.compareAndSet(false,true))return;
        reader.execute(()->{
            try{
                socket.connect(new InetSocketAddress(host,port),8000);socket.setTcpNoDelay(true);socket.setSoTimeout(10000);
                output=new BufferedOutputStream(socket.getOutputStream());InputStream input=new BufferedInputStream(socket.getInputStream());
                listener.onStatus("正在进行加密握手…");handshake(input);
                if(closed.get())return;
                ready=true;lastPong=System.currentTimeMillis();socket.setSoTimeout(20000);listener.onConnected();
                writer.scheduleWithFixedDelay(()->{
                    if(System.currentTimeMillis()-lastPong>15000){stop("心跳中断");return;}
                    try{pingAt=System.currentTimeMillis();writeSecure(new WireProtocol.Packet(32,new byte[0],
                        new JSONObject().put("pingId",Long.toString(pingAt)).put("sentAtMs",pingAt).toString().getBytes(StandardCharsets.UTF_8)));
                    }catch(Exception e){stop("心跳发送失败");}
                },5,5,TimeUnit.SECONDS);
                while(!closed.get()){
                    WireProtocol.Frame frame=WireProtocol.read(input);if(frame==null)throw new EOFException();
                    receive(session.decrypt(frame));
                }
            }catch(Exception e){stop(ready?"连接中断，请重连":"连接或握手失败，请检查服务器");}
            finally{stop(reason);listener.onClosed(reason);}
        });
    }
    private void handshake(InputStream input)throws Exception{
        byte[] request=WireProtocol.plain(new WireProtocol.Packet(1,new byte[0],new byte[0]));writeRaw(request);
        WireProtocol.Frame helloFrame=required(input);WireProtocol.Packet hello=WireProtocol.plain(helloFrame);
        if(hello.type!=2||hello.control.length!=0)throw new IOException("SERVER_HELLO");
        KeyPair local=KeyExchange.generateKeyPair();byte[] clientHello=KeyExchange.hello(local);
        byte[] metadata=identity.toString().getBytes(StandardCharsets.UTF_8);
        byte[] body=new byte[2+clientHello.length+28+metadata.length];
        ByteBuffer.wrap(body).putShort((short)clientHello.length).put(clientHello);
        byte[] frame=WireProtocol.plain(new WireProtocol.Packet(3,new byte[0],body));
        byte[] prefix=Arrays.copyOf(frame,17+2+clientHello.length);
        byte[] transcript=KeyExchange.transcript(request,helloFrame.bytes(),prefix);
        session=KeyExchange.derive(true,local,hello.body,clientHello,transcript);
        writeRaw(WireProtocol.join(prefix,session.sealConnect(prefix,metadata)));
        WireProtocol.Packet response=session.decrypt(required(input));
        if(response.type!=4)throw new IOException("READY");
        ready="1".equals(WireProtocol.control(response.control).get("ok"));listener.onPacket(response);
        if(!ready)throw new IOException("Session rejected");
    }
    private static WireProtocol.Frame required(InputStream input)throws IOException{
        WireProtocol.Frame frame=WireProtocol.read(input);if(frame==null)throw new EOFException();return frame;
    }
    private void receive(WireProtocol.Packet packet)throws Exception{
        if(packet.type==33){
            JSONObject b=new JSONObject(new String(packet.body,StandardCharsets.UTF_8));
            if(b.optLong("sentAtMs")!=pingAt)return;lastPong=System.currentTimeMillis();listener.onLatency(lastPong-pingAt);
        }
        listener.onPacket(packet);
    }
    @Override public boolean send(WireProtocol.Packet packet){
        if(!ready||closed.get()||!outstanding.tryAcquire())return false;
        try{writer.execute(()->{try{writeSecure(packet);}catch(Exception e){stop("消息发送失败");}finally{outstanding.release();}});return true;}
        catch(RejectedExecutionException e){outstanding.release();return false;}
    }
    private synchronized void writeSecure(WireProtocol.Packet packet)throws Exception{writeRaw(session.encrypt(packet));}
    private synchronized void writeRaw(byte[] bytes)throws IOException{if(closed.get())throw new IOException("Closed");output.write(bytes);output.flush();}
    private void stop(String message){
        if(!closed.compareAndSet(false,true))return;reason=message;ready=false;
        try{socket.close();}catch(IOException ignored){}writer.shutdownNow();reader.shutdownNow();if(session!=null)session.close();
    }
    @Override public void close(){stop("连接已关闭");}
}
