package com.chessflipping.protocol;
import com.chessflipping.client.UdpPeer;
import org.json.*;
import org.junit.Test;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.Assert.*;
public class UdpPeerTest{
    static String id(){return UUID.randomUUID().toString().replace("-","");}
    static JSONObject next(BlockingQueue<JSONObject> events,String type)throws Exception{
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
        while(System.nanoTime()<end){JSONObject e=events.poll(500,TimeUnit.MILLISECONDS);if(e!=null&&e.optString("type").equals(type)&&(!type.equals("peer")||e.optBoolean("ready")))return e;}
        throw new AssertionError("Missing "+type);
    }
    @Test public void twoPeersDiscoverAndReassembleOpaqueData()throws Exception{
        BlockingQueue<JSONObject> ea=new LinkedBlockingQueue<>(),eb=new LinkedBlockingQueue<>();String aId=id(),bId=id(),context=id();
        try(DatagramSocket registration=new DatagramSocket(0,InetAddress.getLoopbackAddress());UdpPeer a=new UdpPeer(ea::add);UdpPeer b=new UdpPeer(eb::add)){
            registration.setSoTimeout(5000);a.register("127.0.0.1",registration.getLocalPort(),aId,id());b.register("127.0.0.1",registration.getLocalPort(),bId,id());
            Map<String,Integer> ports=new HashMap<>();
            for(int i=0;i<2;i++){DatagramPacket d=new DatagramPacket(new byte[1200],1200);registration.receive(d);WireProtocol.Packet p=WireProtocol.plain(WireProtocol.decode(Arrays.copyOf(d.getData(),d.getLength())));assertEquals("210",WireProtocol.control(p.control).get("op"));ports.put(new JSONObject(new String(p.body,StandardCharsets.UTF_8)).getString("clientId"),d.getPort());}
            String key=Base64.getEncoder().encodeToString(new byte[32]);
            a.open(new JSONObject().put("peerId",bId).put("master",key).put("context",context).put("initiator",true).put("candidates",new JSONArray().put(new JSONObject().put("ip","127.0.0.1").put("port",ports.get(bId)))));
            b.open(new JSONObject().put("peerId",aId).put("master",key).put("context",context).put("initiator",false).put("candidates",new JSONArray().put(new JSONObject().put("ip","127.0.0.1").put("port",ports.get(aId)))));
            assertEquals(bId,next(ea,"peer").getString("peerId"));assertEquals(aId,next(eb,"peer").getString("peerId"));
            byte[] body=new byte[20000];new Random(1).nextBytes(body);
            byte[] frame=WireProtocol.plain(new WireProtocol.Packet(64,"format:raw\nextra:a:b\n".getBytes(StandardCharsets.UTF_8),body));
            assertTrue(a.send(bId,frame));JSONObject delivered=next(eb,"peerPacket");assertEquals(aId,delivered.getString("peerId"));assertArrayEquals(frame,Base64.getDecoder().decode(delivered.getString("data")));
            assertTrue(b.send(aId,WireProtocol.plain(new WireProtocol.Packet(64,new byte[0],new byte[]{5}))));
            assertArrayEquals(new byte[]{5},WireProtocol.plain(WireProtocol.decode(Base64.getDecoder().decode(next(ea,"peerPacket").getString("data")))).body);
            assertFalse(a.send(bId,WireProtocol.plain(new WireProtocol.Packet(64,new byte[0],new byte[28800]))));
            a.clear();assertFalse(a.send(bId,frame));
        }
    }
    @Test public void clearInvalidatesQueuedPeerOpen()throws Exception{
        try(UdpPeer peer=new UdpPeer(event->{})){
            java.lang.reflect.Field field=UdpPeer.class.getDeclaredField("sender");field.setAccessible(true);ThreadPoolExecutor sender=(ThreadPoolExecutor)field.get(peer);
            CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);sender.execute(()->{entered.countDown();try{release.await(5,TimeUnit.SECONDS);}catch(InterruptedException ignored){}});assertTrue(entered.await(5,TimeUnit.SECONDS));
            JSONObject config=new JSONObject().put("peerId",id()).put("context",id()).put("master",Base64.getEncoder().encodeToString(new byte[32])).put("initiator",true).put("candidates",new JSONArray());
            peer.open(config);peer.clear();release.countDown();sender.submit(()->{}).get(5,TimeUnit.SECONDS);
            field=UdpPeer.class.getDeclaredField("peers");field.setAccessible(true);Map<?,?> peers=(Map<?,?>)field.get(peer);assertTrue(peers.isEmpty());
            peer.open(config);sender.submit(()->{}).get(5,TimeUnit.SECONDS);assertEquals(1,peers.size());
        }
    }
    @Test public void authenticatedPingAndUnsolicitedPongCannotPromoteAddress()throws Exception{
        BlockingQueue<JSONObject> events=new LinkedBlockingQueue<>();String peerId=id(),context=id();byte[] master=new byte[32];
        try(UdpPeer receiver=new UdpPeer(events::add);DatagramSocket candidate=new DatagramSocket(0,InetAddress.getLoopbackAddress());UdpSession remote=new UdpSession(context,master,false)){
            candidate.setSoTimeout(5000);receiver.open(new JSONObject().put("peerId",peerId).put("context",context).put("master",Base64.getEncoder().encodeToString(master)).put("initiator",true).put("candidates",new JSONArray()));
            java.lang.reflect.Field senderField=UdpPeer.class.getDeclaredField("sender");senderField.setAccessible(true);((ThreadPoolExecutor)senderField.get(receiver)).submit(()->{}).get(5,TimeUnit.SECONDS);
            java.lang.reflect.Field socketField=UdpPeer.class.getDeclaredField("socket");socketField.setAccessible(true);int port=((DatagramSocket)socketField.get(receiver)).getLocalPort();
            java.lang.reflect.Field peersField=UdpPeer.class.getDeclaredField("peers");peersField.setAccessible(true);Object state=((Map<?,?>)peersField.get(receiver)).get(peerId);java.lang.reflect.Field addressField=state.getClass().getDeclaredField("remote");addressField.setAccessible(true);
            for(String type:new String[]{"pong","ping"}){byte[] packet=remote.encrypt(new WireProtocol.Packet(64,("transport:"+type+"\n").getBytes(StandardCharsets.UTF_8),ByteBuffer.allocate(8).putLong(12345).array()));candidate.send(new DatagramPacket(packet,packet.length,InetAddress.getLoopbackAddress(),port));}
            byte[] challenge=null;for(int i=0;i<2;i++){DatagramPacket datagram=new DatagramPacket(new byte[1200],1200);candidate.receive(datagram);WireProtocol.Packet packet=remote.decrypt(datagram.getData(),datagram.getLength());if("ping".equals(WireProtocol.control(packet.control).get("transport")))challenge=packet.body;}
            assertNotNull(challenge);assertNull(addressField.get(state));
            byte[] answer=remote.encrypt(new WireProtocol.Packet(64,"transport:pong\n".getBytes(StandardCharsets.UTF_8),challenge));candidate.send(new DatagramPacket(answer,answer.length,InetAddress.getLoopbackAddress(),port));
            assertEquals(peerId,next(events,"peer").getString("peerId"));assertEquals(candidate.getLocalPort(),((InetSocketAddress)addressField.get(state)).getPort());
        }
    }
}
