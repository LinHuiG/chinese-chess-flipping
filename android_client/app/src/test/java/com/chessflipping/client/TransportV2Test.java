package com.chessflipping.client;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.junit.Assume.*;
import java.util.concurrent.*;
import java.security.MessageDigest;
import java.util.Locale;
import okhttp3.*;

/** Runs only against the explicitly configured loopback test server. */
public class TransportV2Test {
    static class Peer implements TcpClient.Listener, AutoCloseable {
        final BlockingQueue<JSONObject> messages=new LinkedBlockingQueue<>();
        final BlockingQueue<byte[]> chunks=new LinkedBlockingQueue<>();
        final CountDownLatch closed=new CountDownLatch(1);
        final GameConnection connection;
        Peer(boolean tcp, JSONObject identity) {
            connection=tcp?new TcpClient(identity,this):new WsClient(identity,false,this);
            connection.connect("127.0.0.1",Integer.parseInt(System.getenv(tcp?"CHESS_TEST_TCP_PORT":"CHESS_TEST_HTTP_PORT")));
        }
        public void onStatus(String text) {} public void onConnected() {} public void onMessage(String text) {}
        public void onClosed(String reason) { closed.countDown(); }
        public void onJsonMessage(JSONObject value,boolean event) { messages.add(value); }
        public void onAppChunk(JSONObject header,byte[] body) { messages.add(header);chunks.add(body); }
        JSONObject next(String type) throws Exception {
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
            while(System.nanoTime()<deadline) { JSONObject value=messages.poll(1,TimeUnit.SECONDS); if(value!=null&&type.equals(value.optString("type")))return value; }
            throw new AssertionError("Missing "+type+", closed="+(closed.getCount()==0));
        }
        public void close() {connection.close();}
    }
    @Test public void encryptedTcpAndBinaryWsShareRoutesAndResume() throws Exception {
        assumeNotNull(System.getenv("CHESS_TEST_TCP_PORT"),System.getenv("CHESS_TEST_HTTP_PORT"));
        try(Peer host=new Peer(true,new JSONObject());Peer guest=new Peer(false,new JSONObject())) {
            JSONObject identity=host.next("SESSION"), guestId=guest.next("SESSION");
            host.connection.request(new JSONObject().put("type","CREATE").put("name","interop"));JSONObject room=host.next("ROOM");
            guest.connection.request(new JSONObject().put("type","JOIN").put("roomId",room.getLong("roomId")));room=guest.next("ROOM");host.next("ROOM");
            String op="0123456789abcdef0123456789abcdef";
            guest.connection.request(new JSONObject().put("type","ACTION").put("roomId",room.getLong("roomId")).put("version",room.getLong("version")).put("gameId","")
              .put("actorId","forged").put("operationId",op).put("action",new JSONObject().put("type","SYNC")));
            JSONObject request=host.next("ACTION");assertEquals(guestId.getString("selfId"),request.getString("actorId"));assertEquals(op,request.getString("operationId"));
            host.connection.request(new JSONObject(request.toString()).put("type","HOST_REPLY").put("ok",true).put("state",new JSONObject().put("seq",1)));
            assertEquals(identity.getString("selfId"),guest.next("HOST_REPLY").getString("actorId"));
            // A second connection takes over the same user while the old one is still open.
            JSONObject credentials=new JSONObject().put("userId",identity.getString("selfId")).put("token",identity.getString("token"));
            try(Peer resumed=new Peer(true,credentials)) {
                assertTrue(resumed.next("SESSION").getBoolean("resumed"));assertEquals(room.getLong("version"),resumed.next("ROOM").getLong("version"));
                assertTrue(host.closed.await(3,TimeUnit.SECONDS));
                resumed.connection.request(new JSONObject().put("type","LOGOUT"));
            }
            guest.connection.request(new JSONObject().put("type","LOGOUT"));
        }
    }
    @Test public void updateVersionGateAndCompleteTcpHttpDownloads() throws Exception {
        assumeNotNull(System.getenv("CHESS_TEST_TCP_PORT"),System.getenv("CHESS_TEST_HTTP_PORT"));
        try(Peer peer=new Peer(true,new JSONObject())) {
            peer.next("SESSION");
            peer.connection.request(new JSONObject().put("type","UPDATE_CHECK").put("versionCode",0));
            JSONObject info=peer.next("APP_VERSION");assertTrue(info.getBoolean("available"));
            long version=info.getLong("versionCode"),size=info.getLong("size"),offset=0;
            MessageDigest hash=MessageDigest.getInstance("SHA-256");
            while(offset<size) {
                peer.connection.request(new JSONObject().put("type","APP_GET").put("versionCode",version).put("currentVersion",0).put("offset",offset));
                JSONObject header=peer.next("APP_CHUNK");byte[] bytes=peer.chunks.poll(3,TimeUnit.SECONDS);
                assertNotNull(bytes);assertEquals(offset,header.getLong("offset"));assertTrue(bytes.length>0&&bytes.length<=32768);
                hash.update(bytes);offset+=bytes.length;assertEquals(offset==size,header.getBoolean("done"));
            }
            assertEquals(size,offset);assertEquals(info.getString("sha256"),hex(hash.digest()));
            peer.connection.request(new JSONObject().put("type","UPDATE_CHECK").put("versionCode",version));
            assertFalse(peer.next("APP_VERSION").getBoolean("available"));
            OkHttpClient http=new OkHttpClient();String base="http://127.0.0.1:"+System.getenv("CHESS_TEST_HTTP_PORT")+"/api/app/";
            try(Response response=http.newCall(new Request.Builder().url(base+"version?versionCode="+version).build()).execute()) {
                assertEquals(200,response.code());assertFalse(new JSONObject(response.body().string()).getBoolean("available"));
            }
            try(Response response=http.newCall(new Request.Builder().url(base+"latest.apk?versionCode=0").build()).execute()) {
                assertEquals(200,response.code());byte[] apk=response.body().bytes();assertEquals(size,apk.length);
                assertEquals(info.getString("sha256"),hex(hash.digest(apk)));
            }
            try(Response response=http.newCall(new Request.Builder().url(base+"latest.apk?versionCode="+version).build()).execute()) {
                assertEquals(204,response.code());assertEquals(0,response.body().bytes().length);
            }
            peer.connection.request(new JSONObject().put("type","LOGOUT"));
        }
    }
    private static String hex(byte[] bytes) {
        StringBuilder text=new StringBuilder();for(byte b:bytes)text.append(String.format(Locale.ROOT,"%02x",b&255));return text.toString();
    }
}
