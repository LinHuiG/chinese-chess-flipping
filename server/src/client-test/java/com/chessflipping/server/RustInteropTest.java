package com.chessflipping.server;

import com.chessflipping.client.*;
import org.json.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;

/** Black-box checks against the production Rust executable and actual Android transports. */
class RustInteropTest {
    static Process server; static int tcp,http,udp;
    static int port() throws Exception {try(ServerSocket socket=new ServerSocket(0)){return socket.getLocalPort();}}
    @BeforeAll static void start() throws Exception {
        String configured=System.getenv("CHESS_RUST_BINARY");
        Path binary=configured==null?Path.of("target/release/chess-server"+(System.getProperty("os.name").startsWith("Windows")?".exe":"")).toAbsolutePath():Path.of(configured);
        if(configured==null)Assumptions.assumeTrue(Files.isRegularFile(binary),"Build the Rust release executable before migration verification");
        assertTrue(Files.isRegularFile(binary));tcp=port();do{http=port();}while(http==tcp);
        try(DatagramSocket s=new DatagramSocket(0)){udp=s.getLocalPort();}
        ProcessBuilder builder=new ProcessBuilder(binary.toString()).redirectErrorStream(true).redirectOutput(Path.of("target/rust-interop.log").toFile());
        builder.environment().putAll(Map.of("TCP_PORT",""+tcp,"HTTP_PORT",""+http,"UDP_PORT",""+udp,"TCP_WORKER_THREADS","2"));server=builder.start();
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);while(System.nanoTime()<deadline){assertTrue(server.isAlive(),"Rust startup failed; see target/rust-interop.log");try(Socket s=new Socket("127.0.0.1",tcp)){return;}catch(Exception ex){Thread.sleep(50);}}
        fail("Rust startup timed out");
    }
    @AfterAll static void stop() throws Exception {if(server!=null){server.destroy();if(!server.waitFor(3,TimeUnit.SECONDS))server.destroyForcibly();}}
    static JSONObject json(String type){return new JSONObject().put("type",type);}
    static String id(){return UUID.randomUUID().toString().replace("-","");}
    static final class Client implements TcpClient.Listener,AutoCloseable {
        final BlockingQueue<JSONObject> messages=new LinkedBlockingQueue<>();final CountDownLatch connected=new CountDownLatch(1),closed=new CountDownLatch(1);
        final GameConnection transport;volatile String reason;volatile long rtt=-1;String self;
        Client(boolean ws,String did)throws Exception{transport=ws?new WsClient(did,"interop.android","0.5.0",false,this):new TcpClient(did,"interop.android","0.5.0",this);transport.connect("127.0.0.1",ws?http:tcp);assertTrue(connected.await(5,TimeUnit.SECONDS),"connect: "+reason);self=await("SESSION").getString("selfId");}
        Client(boolean ws)throws Exception{this(ws,id());}
        public void onStatus(String s){}public void onConnected(){connected.countDown();}public void onMessage(String s){reason=s;}public void onClosed(String s){reason=s;closed.countDown();}
        public void onJsonMessage(JSONObject value,boolean event){messages.add(value);}public void onLatency(long ms){rtt=ms;}
        JSONObject await(String type)throws Exception{long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(6);while(System.nanoTime()<end){JSONObject v=messages.poll(Math.max(1,end-System.nanoTime()),TimeUnit.NANOSECONDS);assertNotNull(v,"Missing "+type+", "+reason);if(v.optString("type").equals(type))return v;}throw new AssertionError(type);}
        void send(JSONObject value){transport.request(value);}
        public void close(){transport.close();}
    }
    static JSONObject context(JSONObject room,String type){return json(type).put("roomId",room.getLong("roomId")).put("version",room.getLong("version")).put("gameId",room.getString("gameId"));}
    static JSONObject room(Client host,Client guest)throws Exception{
        host.send(json("CREATE").put("name","Rust 安卓互通"));JSONObject created=host.await("ROOM");guest.send(json("JOIN").put("roomId",created.getLong("roomId")));
        JSONObject joined=guest.await("ROOM");assertEquals(joined.getLong("version"),host.await("ROOM").getLong("version"));return joined;
    }
    @ParameterizedTest @ValueSource(booleans={true,false}) void tcpWsMixedRoomsAndHeartbeat(boolean hostWs)throws Exception{
        try(Client host=new Client(hostWs);Client guest=new Client(!hostWs)){
            JSONObject r=room(host,guest);String op=id();guest.send(context(r,"ACTION").put("operationId",op).put("action",json("SYNC")));
            JSONObject forward=host.await("FORWARD");assertEquals(op,forward.getString("operationId"));assertEquals(guest.self,forward.getString("actorId"));
            host.send(context(r,"HOST_REPLY").put("requestId",forward.getString("requestId")).put("ok",true).put("state",new JSONObject().put("seq",1).put("seconds",60)));
            assertEquals(1,guest.await("STATE").getJSONObject("state").getInt("seq"));
            assertEquals("PONG",guest.await("PONG").getString("type"));assertTrue(guest.rtt>=0);assertEquals("PONG",host.await("PONG").getString("type"));assertTrue(host.rtt>=0);
        }
    }
    @Test void encryptedUdpThroughPlainWsAndFallbackToRelay()throws Exception{
        try(Client host=new Client(true);Client guest=new Client(true)){
            JSONObject waiting=room(host,guest);host.send(context(waiting,"START").put("state",new JSONObject().put("seq",0)));
            JSONObject r=guest.await("ROOM");host.await("ROOM");assertTrue(r.getBoolean("p2pAvailable"));
            guest.send(context(r,"P2P_REQUEST"));JSONObject offer=host.await("P2P_OFFER");String sid=offer.getString("p2pId");byte[] master=new byte[32];new SecureRandom().nextBytes(master);
            host.send(context(r,"P2P_KEY").put("p2pId",sid).put("key",Base64.getEncoder().encodeToString(master)));
            JSONObject hc=host.await("P2P_CONFIG"),gc=guest.await("P2P_CONFIG");assertEquals(hc.getString("key"),gc.getString("key"));
            String binding=sid+"|"+r.getLong("roomId")+"|"+r.getLong("version")+"|"+r.getString("gameId")+"|"+host.self+"|"+guest.self;
            class Listener implements UdpPeer.Listener{
                final Client client;final BlockingQueue<JSONObject> data=new LinkedBlockingQueue<>();final CountDownLatch failed=new CountDownLatch(1);
                Listener(Client c){client=c;}public void local(JSONArray values){client.send(context(r,"P2P_LOCAL").put("p2pId",sid).put("candidates",values));}
                public void ready(){client.send(context(r,"P2P_READY").put("p2pId",sid));}public void message(JSONObject v){data.add(v);}public void latency(long ms){}public void failed(){failed.countDown();}
            }
            Listener hl=new Listener(host),gl=new Listener(guest);
            try(UdpPeer hp=new UdpPeer("127.0.0.1",udp,sid,hc.getString("token"),master,binding,true,hl);UdpPeer gp=new UdpPeer("127.0.0.1",udp,sid,gc.getString("token"),master,binding,false,gl)){
                hp.candidates(host.await("P2P_PEER").getJSONArray("candidates"));gp.candidates(guest.await("P2P_PEER").getJSONArray("candidates"));
                assertEquals(sid,host.await("P2P_ACTIVE").getString("p2pId"));guest.await("P2P_ACTIVE");hp.activate();gp.activate();
                JSONObject action=context(r,"ACTION").put("operationId",id()).put("action",json("MOVE").put("from",-1).put("to",0));
                assertTrue(gp.send(action.toString().getBytes(StandardCharsets.UTF_8)));JSONObject direct=hl.data.poll(5,TimeUnit.SECONDS);assertNotNull(direct);assertEquals(action.getString("operationId"),direct.getString("operationId"));
                assertFalse(gp.send(new byte[1200]),"Oversize uses relay without fragmentation");
                hp.close();assertTrue(gp.send(action.toString().getBytes(StandardCharsets.UTF_8)));assertTrue(gl.failed.await(5,TimeUnit.SECONDS),"Unacknowledged data must trigger bounded fallback");
                guest.send(context(r,"P2P_STOP").put("p2pId",sid));assertEquals(sid,host.await("P2P_RELAY").getString("p2pId"));guest.await("P2P_RELAY");
                guest.send(action);assertEquals(action.getString("operationId"),host.await("FORWARD").getString("operationId"));
            }finally{Arrays.fill(master,(byte)0);}
            guest.send(json("LEAVE"));assertEquals(host.self,host.await("GAME_OVER").getString("winnerId"));
        }
    }
    @Test void assetsAndConnectionReplacement()throws Exception{
        try(HttpClient client=HttpClient.newHttpClient()){
            var result=client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+http+"/")).build(),HttpResponse.BodyHandlers.ofString());assertEquals(200,result.statusCode());assertTrue(result.body().contains("server-latency"));
            assertEquals(404,client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+http+"/Cargo.toml")).build(),HttpResponse.BodyHandlers.discarding()).statusCode());
        }
        String did=id();try(Client old=new Client(false,did);Client replacement=new Client(true,did)){assertTrue(old.closed.await(5,TimeUnit.SECONDS));assertNotEquals(old.self,replacement.self);}
    }
}
