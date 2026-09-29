package com.chessflipping.client;

import com.chessflipping.protocol.UdpSession;
import com.chessflipping.protocol.WireProtocol;
import org.json.*;
import java.net.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Two bounded I/O workers per attempted direct link; timers sleep until the next actual deadline. */
public final class UdpPeer implements AutoCloseable {
    public interface Listener {
        void local(JSONArray candidates);
        void ready();
        void message(JSONObject message);
        void latency(long millis);
        void failed(String reason);
    }
    private static final int PING=1, PONG=2, DATA=3, ACK=4;
    private final ScheduledExecutorService io = Executors.newSingleThreadScheduledExecutor();
    private final ExecutorService reader = Executors.newSingleThreadExecutor();
    private final Semaphore queued = new Semaphore(32);
    private final AtomicBoolean closed = new AtomicBoolean();
    private final Listener listener;
    private final UdpSession crypto;
    private final String sid, serverHost, token;
    private final int serverPort;
    private final Map<String, Pending> pending = new LinkedHashMap<>();
    private final LinkedHashMap<String, Boolean> received = new LinkedHashMap<>();
    private volatile DatagramSocket socket;
    private InetSocketAddress server, peer;
    private final ArrayList<InetSocketAddress> candidates = new ArrayList<>();
    private ScheduledFuture<?> alarm;
    private long started, lastPing, pingValue, lastReceived, lastRegister;
    private final LinkedHashMap<Long, Long> pings = new LinkedHashMap<>();
    private boolean active, readySent, probeReceived, pongReceived;
    private volatile int probes, inbound, rejected, sendErrors;
    private static final class Pending {
        final byte[] body; final long started; long sent; int tries;
        Pending(byte[] body,long now){this.body=body;started=now;}
    }
    public UdpPeer(String serverHost,int serverPort,String sid,String token,byte[] master,String context,boolean host,Listener listener) throws Exception {
        this.serverHost=serverHost;this.serverPort=serverPort;this.sid=sid;this.token=token;this.listener=listener;
        crypto=new UdpSession(sid,master,context,host);dispatch(this::start);
    }
    private static long now(){return TimeUnit.NANOSECONDS.toMillis(System.nanoTime());}
    private void dispatch(Runnable task){
        if(closed.get())return;
        if(!queued.tryAcquire()){fail();return;}
        try{io.execute(()->{try{if(!closed.get())task.run();}catch(Exception ex){fail();}finally{queued.release();}});}
        catch(RejectedExecutionException ex){queued.release();}
    }
    private void start(){try{
        InetAddress[] resolved=InetAddress.getAllByName(serverHost); InetAddress address=resolved[0];for(InetAddress a:resolved)if(a instanceof Inet4Address){address=a;break;}
        if(address==null){fail();return;}server=new InetSocketAddress(address,serverPort);
        socket=new DatagramSocket(new InetSocketAddress(0));socket.setReceiveBufferSize(16384);socket.setSendBufferSize(16384);
        if(closed.get()){socket.close();return;}
        started=lastReceived=now();JSONArray locals=new JSONArray();
        Enumeration<NetworkInterface> interfaces=NetworkInterface.getNetworkInterfaces();
        while(interfaces.hasMoreElements()&&locals.length()<8){NetworkInterface iface=interfaces.nextElement();if(!iface.isUp()||iface.isLoopback())continue;
            Enumeration<InetAddress> addresses=iface.getInetAddresses();while(addresses.hasMoreElements()&&locals.length()<8){InetAddress a=addresses.nextElement();if(!a.isAnyLocalAddress()&&!a.isLoopbackAddress()&&!a.isLinkLocalAddress()&&!a.isMulticastAddress()&&(!(a instanceof Inet6Address)||(!a.isSiteLocalAddress()&&(a.getAddress()[0]&0xfe)!=0xfc)))locals.put(new JSONObject().put("host",a.getHostAddress()).put("port",socket.getLocalPort()));}}
        listener.local(locals);reader.execute(this::receive);tick();
    }catch(Exception ex){fail();}}
    public void candidates(JSONArray values){
        // Resolve only literal server-validated IPs, on the network worker.
        dispatch(()->{
            for(int i=0;i<values.length()&&candidates.size()<12;i++) {
                try {
                    JSONObject v=values.getJSONObject(i);String ip=v.getString("host");
                    if(!ip.matches("[0-9a-fA-F:.]+"))continue;
                    InetSocketAddress candidate=new InetSocketAddress(InetAddress.getByName(ip),v.getInt("port"));
                    if(!candidates.contains(candidate))candidates.add(candidate);
                } catch(Exception ex) { sendErrors++; }
            }
            lastPing=0;schedule(1);
        });
    }
    public void activate(){dispatch(()->{if(!readySent){fail();return;}active=true;listener.latency(-1);lastPing=0;schedule(1);});}
    /** Serialization belongs to the caller and happens once; retransmissions reuse these plaintext bytes. */
    public boolean send(byte[] message){
        if(closed.get()||message.length+16>UdpSession.MAX_PAYLOAD)return false;
        UUID messageId=UUID.randomUUID();byte[] id=new byte[16];ByteBuffer.wrap(id).putLong(messageId.getMostSignificantBits()).putLong(messageId.getLeastSignificantBits());
        byte[] body=new byte[16+message.length];System.arraycopy(id,0,body,0,16);System.arraycopy(message,0,body,16,message.length);
        dispatch(()->{if(!active||peer==null||pending.size()>=16){fail();return;}Pending p=new Pending(body,now());pending.put(key(id),p);transmit(p);schedule(250);});return true;
    }
    private static String key(byte[] b){return Base64.getEncoder().encodeToString(b);}
    private void transmit(Pending p){sendPacket(DATA,p.body,peer);p.sent=now();p.tries++;}
    private void sendPacket(int type,byte[] body,InetSocketAddress to){
        if(to==null||closed.get())return;
        try{byte[] bytes=crypto.encrypt(type,body);socket.send(new DatagramPacket(bytes,bytes.length,to));if(type==PING)probes++;}
        catch(java.io.IOException ex){sendErrors++;candidates.remove(to);if(active&&to.equals(peer))fail("PATH_SEND");}
        catch(java.security.GeneralSecurityException ex){fail("CRYPTO_SEND");}
    }
    private void receive(){byte[] bytes=new byte[UdpSession.MAX_PACKET+1];DatagramPacket packet=new DatagramPacket(bytes,bytes.length);
        while(!closed.get()){try{packet.setLength(bytes.length);socket.receive(packet);inbound++;UdpSession.Packet message;
            try{message=crypto.decrypt(bytes,packet.getLength());}catch(java.security.GeneralSecurityException invalid){rejected++;continue;}
            if(message==null)continue;InetSocketAddress from=(InetSocketAddress)packet.getSocketAddress();dispatch(()->accept(message,from));
        }catch(Exception ex){if(!closed.get())fail();break;}}
    }
    private void accept(UdpSession.Packet packet,InetSocketAddress from){
        // Authentication and replay checks already ran in receive(). LAN and NAT paths can
        // expose different source addresses for the same peer; do not discard that traffic.
        long time=now();byte[] body=packet.body;
        if(packet.type==PING&&body.length==8){probeReceived=true;sendPacket(PONG,body,from);}
        else if(packet.type==PONG&&body.length==8){
            Long sent = pings.remove(ByteBuffer.wrap(body).getLong()); if (sent == null) return;
            if(peer==null)peer=from;pongReceived=true;lastReceived=time;if(active)listener.latency(Math.max(0,time-sent));
        }else if(active&&peer!=null&&packet.type==ACK&&body.length==16){pending.remove(key(body));lastReceived=time;}
        else if(active&&peer!=null&&packet.type==DATA&&body.length>16){
            byte[] id=Arrays.copyOf(body,16);String idText=key(id);sendPacket(ACK,id,from);lastReceived=time;
            if(received.containsKey(idText))return;received.put(idText,true);if(received.size()>128)received.remove(received.keySet().iterator().next());
            try{listener.message(GameConnection.message(WireProtocol.plain(WireProtocol.decode(Arrays.copyOfRange(body,16,body.length)))));}
            catch(Exception ex){fail("INVALID_DATA");}
        }
        if(!readySent&&peer!=null&&probeReceived&&pongReceived){readySent=true;listener.ready();}
    }
    private void tick(){if(closed.get()||socket==null)return;long time=now();
        if(!active&&time-started>=10000){fail(candidates.isEmpty()?"NO_CANDIDATE":inbound==0?"NO_INBOUND":"PROBE_TIMEOUT");return;}
        if(active&&time-lastReceived>=12000){fail("HEARTBEAT_TIMEOUT");return;}
        if(!active&&time-lastRegister>=1000){try{byte[] b=ByteBuffer.allocate(36).putInt(0x43465531).put(UdpSession.hex(sid)).put(UdpSession.hex(token)).array();socket.send(new DatagramPacket(b,b.length,server));lastRegister=time;}catch(Exception ex){lastRegister=time;sendErrors++;}}
        long pingInterval=active?5000:500;
        if(time-lastPing>=pingInterval&&(peer!=null||!candidates.isEmpty())){lastPing=time;pingValue=System.nanoTime();pings.put(pingValue,time);if(pings.size()>16)pings.remove(pings.keySet().iterator().next());byte[] probe=ByteBuffer.allocate(8).putLong(pingValue).array();
            if(peer!=null)sendPacket(PING,probe,peer);else for(InetSocketAddress candidate:new ArrayList<>(candidates))sendPacket(PING,probe,candidate);}
        long delay=active?Math.max(1,Math.min(5000-(time-lastPing),12000-(time-lastReceived))):250;
        for(Pending p:pending.values()){
            if(time-p.started>=3000){fail("ACK_TIMEOUT");return;}long retry=Math.min(1000,300L<<Math.min(2,p.tries-1));
            if(time-p.sent>=retry)transmit(p);delay=Math.min(delay,Math.max(1,retry-(time-p.sent)));
        }schedule(delay);
    }
    private void schedule(long delay){if(closed.get())return;if(alarm!=null)alarm.cancel(false);try{alarm=io.schedule(this::tick,Math.max(1,delay),TimeUnit.MILLISECONDS);}catch(RejectedExecutionException ignored){}}
    private void fail(){fail("IO");}
    private void fail(String reason){if(shutdown())listener.failed(reason+" tx="+probes+" rx="+inbound+" auth="+rejected+" send="+sendErrors);}
    private boolean shutdown(){if(!closed.compareAndSet(false,true))return false;DatagramSocket s=socket;if(s!=null)s.close();io.shutdownNow();reader.shutdownNow();crypto.close();return true;}
    @Override public void close(){shutdown();}
}
