package com.chessflipping.protocol;
import com.chessflipping.client.UdpPeer;
import org.json.*;
import org.junit.Test;
import java.net.*;
import java.nio.charset.StandardCharsets;
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
            a.clear();assertFalse(a.send(bId,frame));
        }
    }
}
