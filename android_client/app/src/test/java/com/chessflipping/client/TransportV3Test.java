package com.chessflipping.client;
import com.chessflipping.protocol.WireProtocol;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.junit.Assume.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.security.MessageDigest;
import okhttp3.*;

/** Runs only against an explicitly configured loopback server. Tests the real native transports. */
public class TransportV3Test {
    static String id(){return UUID.randomUUID().toString().replace("-","");}
    static byte[] bytes(String text){return text.getBytes(StandardCharsets.UTF_8);}
    static JSONObject json(WireProtocol.Packet p)throws Exception{return new JSONObject(new String(p.body,StandardCharsets.UTF_8));}
    static Map<String,String> headers(WireProtocol.Packet p)throws Exception{return WireProtocol.control(p.control);}
    static class Peer implements TcpClient.Listener,AutoCloseable{
        final BlockingQueue<WireProtocol.Packet> packets=new LinkedBlockingQueue<>();
        final CountDownLatch closed=new CountDownLatch(1);final GameConnection connection;String clientId;
        Peer(boolean tcp,JSONObject identity){connection=tcp?new TcpClient(identity,this):new WsClient(identity,false,this);connection.connect("127.0.0.1",Integer.parseInt(System.getenv(tcp?"CHESS_TEST_TCP_PORT":"CHESS_TEST_HTTP_PORT")));}
        public void onPacket(WireProtocol.Packet p){packets.add(p);}
        public void onClosed(String reason){closed.countDown();}
        WireProtocol.Packet next(int kind,String op)throws Exception{
            long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);
            while(System.nanoTime()<end){WireProtocol.Packet p=packets.poll(1,TimeUnit.SECONDS);if(p!=null&&p.type==kind&&(op==null||op.equals(headers(p).get("op"))))return p;}
            throw new AssertionError("Missing kind="+kind+" op="+op+" closed="+(closed.getCount()==0));
        }
        JSONObject ready()throws Exception{WireProtocol.Packet p=next(4,null);assertEquals("1",headers(p).get("ok"));JSONObject identity=json(p);clientId=identity.getString("clientId");return identity;}
        void send(int kind,String control,byte[] body){assertTrue(connection.send(new WireProtocol.Packet(kind,bytes(control),body)));}
        void request(int op,JSONObject body){send(16,"op:"+op+"\nrequestId:"+id()+"\n",bytes(body.toString()));}
        public void close(){connection.close();}
    }
    static JSONObject object(String key,Object value)throws Exception{return new JSONObject().put(key,value);}
    @Test public void tcpWsMultiPartyOpaqueRelayHostDecisionAndRecovery()throws Exception{
        assumeNotNull(System.getenv("CHESS_TEST_TCP_PORT"),System.getenv("CHESS_TEST_HTTP_PORT"));
        try(Peer host=new Peer(true,new JSONObject());Peer a=new Peer(false,new JSONObject());Peer b=new Peer(true,new JSONObject());Peer outsider=new Peer(false,new JSONObject())){
            JSONObject identity=host.ready();a.ready();b.ready();outsider.ready();
            String feature=id(),createId=id(),create="op:100\nrequestId:"+createId+"\n";
            byte[] createBody=bytes(new JSONObject().put("roomType",feature.substring(0,16)).put("name","通用互通").toString());
            host.send(16,create,createBody);String rid=json(host.next(18,"100")).getString("roomId");
            host.send(16,create,createBody);assertEquals(rid,json(host.next(18,"100")).getString("roomId"));
            a.request(101,object("roomType",feature.substring(0,16)));assertEquals(rid,json(a.next(18,"101")).getJSONArray("rooms").getJSONObject(0).getString("roomId"));
            for(Peer guest:new Peer[]{a,b}){
                String req=id(),ctrl="op:102\nrequestId:"+req+"\nroomId:"+rid+"\nmodule:x:y\n";byte[] proof={0,42,-1};
                guest.send(16,ctrl,proof);WireProtocol.Packet join=host.next(16,"102");assertArrayEquals(proof,join.body);assertEquals(guest.clientId,headers(join).get("from"));
                assertEquals(ctrl+"from:"+guest.clientId+"\n",new String(join.control,StandardCharsets.UTF_8));
                // The generic grant flag is separate from the deliberately opaque decision body.
                byte[] decision={7,0,-1,12};
                host.send(18,"op:102\nrequestId:"+req+"\nroomId:"+rid+"\nto:"+guest.clientId+"\nok:1\ngrant:1\n",decision);
                WireProtocol.Packet reply=guest.next(18,"102");assertArrayEquals(decision,reply.body);assertEquals(host.clientId,headers(reply).get("from"));
            }
            byte[] payload=new byte[64000];new Random(1).nextBytes(payload);
            String ctrl="op:200\nroomId:"+rid+"\nto:"+b.clientId+"\ncodec:raw:x\ncustom:first\ncustom:second\n";
            a.send(16,ctrl,payload);WireProtocol.Packet delivery=b.next(64,"200");assertArrayEquals(payload,delivery.body);
            assertEquals(ctrl+"from:"+a.clientId+"\n",new String(delivery.control,StandardCharsets.UTF_8));
            outsider.send(16,"op:200\nrequestId:"+id()+"\nroomId:"+rid+"\nto:"+b.clientId+"\n",new byte[0]);
            assertEquals("TARGET_UNAVAILABLE",headers(outsider.next(18,"200")).get("error"));
            try(Peer resumed=new Peer(true,identity)){
                assertEquals(host.clientId,resumed.ready().getString("clientId"));assertTrue(host.closed.await(3,TimeUnit.SECONDS));
                resumed.request(104,object("roomId",rid));
                assertEquals(rid,json(a.next(18,"105")).getString("roomId"));assertEquals(rid,json(b.next(18,"105")).getString("roomId"));
                a.request(101,object("roomType",feature.substring(0,16)));assertEquals(0,json(a.next(18,"101")).getJSONArray("rooms").length());
            }
        }
    }
    @Test public void updateCompleteTcpHttpDownloads()throws Exception{
        assumeNotNull(System.getenv("CHESS_TEST_TCP_PORT"),System.getenv("CHESS_TEST_HTTP_PORT"));
        try(Peer peer=new Peer(true,new JSONObject())){
            peer.ready();peer.connection.request(new JSONObject().put("type","UPDATE_CHECK").put("versionCode",0));
            JSONObject info=json(peer.next(49,null));assertTrue(info.getBoolean("available"));long version=info.getLong("versionCode"),size=info.getLong("size"),offset=0;
            MessageDigest hash=MessageDigest.getInstance("SHA-256");
            while(offset<size){
                peer.connection.request(new JSONObject().put("type","APP_GET").put("versionCode",version).put("currentVersion",0).put("offset",offset));
                WireProtocol.Packet chunk=peer.next(51,null);Map<String,String> h=headers(chunk);
                assertEquals(offset,Long.parseLong(h.get("offset")));assertTrue(chunk.body.length>0&&chunk.body.length<=32768);
                hash.update(chunk.body);offset+=chunk.body.length;assertEquals(offset==size,Boolean.parseBoolean(h.get("done")));
            }
            assertEquals(size,offset);assertEquals(info.getString("sha256"),hex(hash.digest()));
            OkHttpClient http=new OkHttpClient();String base="http://127.0.0.1:"+System.getenv("CHESS_TEST_HTTP_PORT")+"/api/app/";
            try(Response r=http.newCall(new Request.Builder().url(base+"latest.apk?versionCode=0").build()).execute()){
                assertEquals(200,r.code());assertEquals(info.getString("sha256"),hex(hash.digest(r.body().bytes())));
            }
            try(Response r=http.newCall(new Request.Builder().url(base+"latest.apk?versionCode="+version).build()).execute()){assertEquals(204,r.code());}
            peer.connection.request(new JSONObject().put("type","UPDATE_CHECK").put("versionCode",version));assertFalse(json(peer.next(49,null)).getBoolean("available"));
        }
    }
    static String hex(byte[] b){StringBuilder s=new StringBuilder();for(byte n:b)s.append(String.format(Locale.ROOT,"%02x",n&255));return s.toString();}
}
