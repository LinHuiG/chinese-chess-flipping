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
    private final ExecutorService writer=Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService watchdog=Executors.newSingleThreadScheduledExecutor();
    private final Semaphore outstanding=new Semaphore(128);
    private final Semaphore disposable=new Semaphore(8);
    private final AtomicBoolean closed=new AtomicBoolean(),started=new AtomicBoolean();
    private final Listener listener;private final JSONObject identity;private final Socket socket=new Socket();
    private volatile boolean ready;private volatile SecureSession session;private OutputStream output;
    private volatile long lastPong,pingAt,writeStarted;private volatile String phase="域名解析";private String reason="服务端连接已关闭";
    public TcpClient(JSONObject identity,Listener listener){this.identity=identity;this.listener=listener;}
    @Override public void connect(String host,int port){
        if(closed.get()||!started.compareAndSet(false,true))return;
        final long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(18);
        watchdog.scheduleWithFixedDelay(()->{
            if(!ready&&System.nanoTime()>deadline){stop("服务端"+phase+"超时（连接和握手最多 18 秒），正在尝试重连");return;}
            if(ready&&System.currentTimeMillis()-lastPong>15000){stop("服务端心跳响应超时（15 秒），正在尝试重连");return;}
            if(writeStarted!=0&&System.nanoTime()-writeStarted>TimeUnit.SECONDS.toNanos(5))stop("服务端消息发送超时（5 秒），正在尝试重连");
        },1,1,TimeUnit.SECONDS);
        reader.execute(()->{
            try{
                InetSocketAddress address=new InetSocketAddress(host,port);phase="TCP 连接";
                socket.connect(address,8000);socket.setTcpNoDelay(true);socket.setSoTimeout(10000);
                output=new BufferedOutputStream(socket.getOutputStream());InputStream input=new BufferedInputStream(socket.getInputStream());
                phase="加密握手";listener.onStatus("正在进行服务端加密握手…");handshake(input);
                if(closed.get())return;
                ready=true;phase="通信读取";lastPong=System.currentTimeMillis();socket.setSoTimeout(20000);listener.onConnected();
                watchdog.scheduleWithFixedDelay(()->{
                    try{writer.execute(()->{try{pingAt=System.currentTimeMillis();writeSecure(new WireProtocol.Packet(32,new byte[0],
                        new JSONObject().put("pingId",Long.toString(pingAt)).put("sentAtMs",pingAt).toString().getBytes(StandardCharsets.UTF_8)));
                    }catch(Exception e){stop(ConnectionErrors.describe(e,"心跳发送"));}});}catch(RejectedExecutionException ignored){}
                },5,5,TimeUnit.SECONDS);
                while(!closed.get()){
                    WireProtocol.Frame frame=WireProtocol.read(input);if(frame==null)throw new EOFException();
                    receive(session.decrypt(frame));
                }
            }catch(Exception e){stop(ConnectionErrors.describe(e,phase));}
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
        phase="身份确认";WireProtocol.Packet response=session.decrypt(required(input));
        if(response.type!=4)throw new IOException("READY");
        boolean accepted="1".equals(WireProtocol.control(response.control).get("ok"));if(accepted)lastPong=System.currentTimeMillis();ready=accepted;listener.onPacket(response);
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
        final long queued=System.nanoTime();final int maxAge;
        try{java.util.Map<String,String> h=WireProtocol.control(packet.control);maxAge="1".equals(h.get("discard"))?Math.max(1,Math.min(2000,Integer.parseInt(h.getOrDefault("maxAgeMs","200")))):0;}catch(Exception e){return false;}
        if(maxAge>0&&(!ready||closed.get()||outstanding.availablePermits()<32||!disposable.tryAcquire()))return false;
        if(!ready||closed.get()||!outstanding.tryAcquire()){if(maxAge>0)disposable.release();return false;}
        try{writer.execute(()->{try{if(maxAge==0||System.nanoTime()-queued<=TimeUnit.MILLISECONDS.toNanos(maxAge))writeSecure(packet);}catch(Exception e){stop(ConnectionErrors.describe(e,"消息发送"));}finally{outstanding.release();if(maxAge>0)disposable.release();}});return true;}
        catch(RejectedExecutionException e){outstanding.release();if(maxAge>0)disposable.release();return false;}
    }
    private synchronized void writeSecure(WireProtocol.Packet packet)throws Exception{writeRaw(session.encrypt(packet));}
    private synchronized void writeRaw(byte[] bytes)throws IOException{if(closed.get())throw new IOException("Closed");writeStarted=System.nanoTime();try{output.write(bytes);output.flush();}finally{writeStarted=0;}}
    private void stop(String message){
        if(!closed.compareAndSet(false,true))return;reason=message;ready=false;
        try{socket.close();}catch(IOException ignored){}watchdog.shutdownNow();writer.shutdownNow();reader.shutdownNow();if(session!=null)session.close();
    }
    @Override public void close(){stop("连接已关闭");}
}
