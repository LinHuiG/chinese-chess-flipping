package com.chessflipping.client;
import com.chessflipping.protocol.*;
import org.json.*;
import java.net.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

/** A socket shared by all peers. Fragmentation and probes stay entirely on the client. */
public final class UdpPeer implements AutoCloseable {
    private final DatagramSocket socket;
    private final ScheduledExecutorService timer=Executors.newSingleThreadScheduledExecutor();
    private final ThreadPoolExecutor sender=new ThreadPoolExecutor(1,1,0,TimeUnit.SECONDS,new ArrayBlockingQueue<>(64));
    private final Map<String,Peer> peers=new ConcurrentHashMap<>();
    private final Consumer<JSONObject> events;private volatile boolean closed;
    private static class Assembly {
        final byte[][] parts;final long created=System.currentTimeMillis();int received,bytes;
        Assembly(int count){parts=new byte[count][];}
    }
    private static class Peer {
        final String id,context;final UdpSession session;final List<InetSocketAddress> candidates;
        final Map<String,Assembly> fragments=new HashMap<>();
        volatile InetSocketAddress remote;volatile long pongAt,latency;volatile boolean ready;
        long budgetAt=System.currentTimeMillis();int sent;long reportAt;
        Peer(String id,String context,UdpSession session,List<InetSocketAddress> candidates){this.id=id;this.context=context;this.session=session;this.candidates=candidates;}
    }
    public UdpPeer(Consumer<JSONObject> events)throws SocketException{
        this.events=events;socket=new DatagramSocket();socket.setSoTimeout(1000);
        Thread reader=new Thread(this::receive,"cyber-udp");reader.setDaemon(true);reader.start();
        timer.scheduleWithFixedDelay(this::tick,200,600,TimeUnit.MILLISECONDS);
    }
    private static JSONObject event(String type){try{return new JSONObject().put("type",type);}catch(JSONException e){throw new IllegalStateException(e);}}
    private void emit(JSONObject value){if(!closed)events.accept(value);}
    public void register(String server,int port,String clientId,String ticket){
        execute(()->{
            try{
                byte[] bytes=WireProtocol.plain(new WireProtocol.Packet(16,"op:210\n".getBytes(StandardCharsets.UTF_8),
                    new JSONObject().put("clientId",clientId).put("ticket",ticket).toString().getBytes(StandardCharsets.UTF_8)));
                InetAddress address=InetAddress.getByName(server);socket.send(new DatagramPacket(bytes,bytes.length,address,port));
                JSONArray candidates=new JSONArray();Enumeration<NetworkInterface> interfaces=NetworkInterface.getNetworkInterfaces();
                while(interfaces.hasMoreElements()){
                    NetworkInterface network=interfaces.nextElement();if(!network.isUp()||network.isLoopback())continue;
                    Enumeration<InetAddress> addresses=network.getInetAddresses();
                    while(addresses.hasMoreElements()){
                        InetAddress ip=addresses.nextElement();if(!(ip instanceof Inet4Address)||ip.isLoopbackAddress())continue;
                        if(candidates.length()<16)candidates.put(new JSONObject().put("ip",ip.getHostAddress()).put("port",socket.getLocalPort()));
                    }
                }
                emit(event("udpLocal").put("candidates",candidates));
            }catch(Exception ignored){}
        });
    }
    public void open(JSONObject config){
        execute(()->{
            try{
                String id=config.getString("peerId");if(!id.matches("[0-9a-f]{32}")||(!peers.containsKey(id)&&peers.size()>=16))return;
                String context=config.getString("context");Peer existing=peers.get(id);if(existing!=null&&existing.context.equals(context))return;
                JSONArray input=config.getJSONArray("candidates");List<InetSocketAddress> addresses=new ArrayList<>();
                for(int i=0;i<Math.min(24,input.length());i++){
                    JSONObject c=input.getJSONObject(i);String ip=c.getString("ip");int port=c.getInt("port");
                    if(!ip.matches("[0-9a-fA-F:.]+")||port<1||port>65535)continue;
                    InetSocketAddress candidate=new InetSocketAddress(InetAddress.getByName(ip),port);if(!addresses.contains(candidate))addresses.add(candidate);
                }
                byte[] master=Base64.getDecoder().decode(config.getString("master"));
                Peer peer=new Peer(id,context,new UdpSession(context,master,config.getBoolean("initiator")),addresses);Arrays.fill(master,(byte)0);
                Peer previous=peers.put(id,peer);if(previous!=null)previous.session.close();
            }catch(Exception ignored){}
        });
    }
    public boolean send(String id,byte[] frame){
        Peer peer=peers.get(id);if(peer==null||!peer.ready||peer.remote==null||frame.length>WireProtocol.MAX_FRAME)return false;
        synchronized(peer){
            long now=System.currentTimeMillis();if(now-peer.budgetAt>=1000){peer.budgetAt=now;peer.sent=0;}
            if(peer.sent+frame.length>256000)return false;peer.sent+=frame.length;
        }
        return execute(()->{
            try{
                WireProtocol.Packet packet=WireProtocol.plain(WireProtocol.decode(frame));if(packet.type!=64)return;
                if(frame.length+28<=1200){sendPacket(peer,packet,peer.remote);return;}
                String message=UUID.randomUUID().toString().replace("-","");int count=(frame.length+899)/900;
                for(int part=0;part<count;part++){
                    byte[] headers=("transport:chunk\nmessage:"+message+"\npart:"+part+"\ncount:"+count+"\n").getBytes(StandardCharsets.UTF_8);
                    sendPacket(peer,new WireProtocol.Packet(64,headers,Arrays.copyOfRange(frame,part*900,Math.min(frame.length,(part+1)*900))),peer.remote);
                }
            }catch(Exception ignored){peer.ready=false;}
        });
    }
    private boolean execute(Runnable task){if(closed)return false;try{sender.execute(task);return true;}catch(RejectedExecutionException e){return false;}}
    private void sendPacket(Peer peer,WireProtocol.Packet packet,InetSocketAddress address)throws Exception{
        if(address==null||closed)return;byte[] bytes=peer.session.encrypt(packet);socket.send(new DatagramPacket(bytes,bytes.length,address));
    }
    private void tick(){
        if(closed)return;long now=System.currentTimeMillis();
        for(Peer peer:peers.values()){
            boolean ready=now-peer.pongAt<4000;
            if(peer.ready!=ready||now-peer.reportAt>2000){
                peer.ready=ready;peer.reportAt=now;
                try{emit(event("peer").put("peerId",peer.id).put("ready",ready).put("latency",peer.latency));}catch(JSONException ignored){}
            }
            execute(()->{
                try{
                    WireProtocol.Packet ping=new WireProtocol.Packet(64,"transport:ping\n".getBytes(StandardCharsets.UTF_8),ByteBuffer.allocate(8).putLong(System.nanoTime()).array());
                    if(peer.ready&&peer.remote!=null)sendPacket(peer,ping,peer.remote);
                    else for(InetSocketAddress address:peer.candidates)sendPacket(peer,ping,address);
                }catch(Exception ignored){}
            });
        }
    }
    private void receive(){
        byte[] buffer=new byte[1201];
        while(!closed){
            try{
                DatagramPacket datagram=new DatagramPacket(buffer,buffer.length);socket.receive(datagram);
                if(datagram.getLength()>1200)continue;
                InetSocketAddress address=new InetSocketAddress(datagram.getAddress(),datagram.getPort());
                for(Peer peer:peers.values()){
                    try{
                        WireProtocol.Packet packet=peer.session.decrypt(buffer,datagram.getLength());if(packet==null)continue;
                        if(packet.type!=64)break;
                        Map<String,String> headers=WireProtocol.control(packet.control);String kind=headers.get("transport");
                        peer.remote=address;
                        if("ping".equals(kind)){
                            if(packet.body.length==8)execute(()->{try{sendPacket(peer,new WireProtocol.Packet(64,"transport:pong\n".getBytes(StandardCharsets.UTF_8),packet.body),address);}catch(Exception ignored){}});
                        }else if("pong".equals(kind)){
                            if(packet.body.length==8){
                                long elapsed=System.nanoTime()-ByteBuffer.wrap(packet.body).getLong();
                                if(elapsed>=0&&elapsed<TimeUnit.SECONDS.toNanos(10)){peer.pongAt=System.currentTimeMillis();peer.latency=TimeUnit.NANOSECONDS.toMillis(elapsed);}
                            }
                        }else if("chunk".equals(kind))fragment(peer,headers,packet.body);
                        else deliver(peer,WireProtocol.plain(packet));
                        break;
                    }catch(Exception ignored){}
                }
            }catch(SocketTimeoutException ignored){}catch(Exception ignored){if(closed)return;}
        }
    }
    private void fragment(Peer peer,Map<String,String> h,byte[] bytes)throws Exception{
        String id=h.get("message");int part=Integer.parseInt(h.get("part")),count=Integer.parseInt(h.get("count"));
        if(id==null||!id.matches("[0-9a-f]{32}")||count<1||count>80||part<0||part>=count||bytes.length>900)return;
        long now=System.currentTimeMillis();peer.fragments.entrySet().removeIf(e->now-e.getValue().created>2000);
        Assembly assembly=peer.fragments.get(id);
        if(assembly==null){if(peer.fragments.size()>=8)return;assembly=new Assembly(count);peer.fragments.put(id,assembly);}
        if(assembly.parts.length!=count||assembly.parts[part]!=null)return;
        assembly.parts[part]=bytes;assembly.received++;assembly.bytes+=bytes.length;
        if(assembly.bytes>WireProtocol.MAX_FRAME){peer.fragments.remove(id);return;}
        if(assembly.received==count){
            byte[] frame=new byte[assembly.bytes];int offset=0;for(byte[] data:assembly.parts){System.arraycopy(data,0,frame,offset,data.length);offset+=data.length;}
            peer.fragments.remove(id);WireProtocol.Packet packet=WireProtocol.plain(WireProtocol.decode(frame));if(packet.type==64)deliver(peer,frame);
        }
    }
    private void deliver(Peer peer,byte[] frame)throws JSONException{emit(event("peerPacket").put("peerId",peer.id).put("data",Base64.getEncoder().encodeToString(frame)));}
    public void clear(){for(Peer peer:peers.values())peer.session.close();peers.clear();}
    @Override public void close(){closed=true;socket.close();timer.shutdownNow();sender.shutdownNow();clear();}
}
