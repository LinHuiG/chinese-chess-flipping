package com.chessflipping.client;

import org.json.*;
import org.junit.Test;
import okhttp3.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

public class MediaRequestsTest {
    private interface Reply {String respond(String path)throws Exception;}
    private interface RequestReply {String respond(String path,String headers)throws Exception;}
    private static final class Server implements AutoCloseable {
        final ServerSocket socket=new ServerSocket(0,16,InetAddress.getByName("127.0.0.1"));final ExecutorService io=Executors.newCachedThreadPool();
        Server(Reply reply)throws Exception{this((path,headers)->reply.respond(path));}
        Server(RequestReply reply)throws Exception{io.execute(()->{while(!socket.isClosed())try{Socket client=socket.accept();io.execute(()->{try(client){client.setSoTimeout(5000);BufferedReader input=new BufferedReader(new InputStreamReader(client.getInputStream(),StandardCharsets.UTF_8));String line=input.readLine();if(line==null)return;String path=line.split(" ")[1];StringBuilder headers=new StringBuilder();while((line=input.readLine())!=null&&!line.isEmpty())headers.append(line).append('\n');client.getOutputStream().write(reply.respond(path,headers.toString()).getBytes(StandardCharsets.ISO_8859_1));}catch(Exception ignored){}});}catch(IOException closed){return;}});}
        String base(){return "http://127.0.0.1:"+socket.getLocalPort();}
        public void close()throws Exception{socket.close();io.shutdownNow();}
    }
    private static String ok(){return "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";}
    private static JSONObject request(String id,String url)throws Exception{return new JSONObject().put("id",id).put("url",url);}
    private static Request stream(String url){return new Request.Builder().url(url).header("Authorization","Bearer account-secret").header("X-Emby-Token","account-secret").header("X-Emby-Authorization","MediaBrowser account-secret").header("X-MediaBrowser-Token","account-secret").header("Cookie","account=secret").header("Range","bytes=0-").build();}
    @Test public void requestDeadlineCanAllowSlowPlaybackNegotiation()throws Exception{
        BlockingQueue<JSONObject> events=new LinkedBlockingQueue<>();
        try(Server server=new Server(path->{Thread.sleep(1500);return ok();});MediaRequests media=new MediaRequests(Runnable::run,events::add)){
            media.configure(server.base());media.request(request("short",server.base()).put("timeoutMs",1000));JSONObject event=events.poll(5,TimeUnit.SECONDS);assertNotNull(event);assertEquals(0,event.getInt("status"));assertTrue(event.getString("error").contains("Emby 片库请求超时"));
            media.request(request("patient",server.base()).put("timeoutMs",4000));event=events.poll(5,TimeUnit.SECONDS);assertNotNull(event);assertEquals("patient",event.getString("id"));assertEquals(200,event.getInt("status"));
        }
    }
    @Test public void errorsIdentifyEmbyStageWithoutCredentials()throws Exception{
        String secret="https://account:password@private.example/?api_key=private-token";
        assertTrue(MediaRequests.failureMessage(new UnknownHostException(secret),"Emby 登录").contains("域名无法解析"));
        assertTrue(MediaRequests.failureMessage(new javax.net.ssl.SSLHandshakeException(secret),"Emby 登录").contains("证书"));
        assertTrue(MediaRequests.failureMessage(new SocketTimeoutException(secret),"Emby 播放协商").contains("播放协商超时"));
        assertTrue(MediaRequests.failureMessage(new ConnectException(secret),"Emby 片库请求").contains("地址、端口"));
        assertFalse(MediaRequests.failureMessage(new IOException(secret),"Emby 请求").contains(secret));
        assertEquals("Emby 播放协商",MediaRequests.requestStage(HttpUrl.get("https://fixture.invalid/Items/1/PlaybackInfo?api_key=test"),false));
    }
    @Test public void queueWaitingCountsTowardsTheRequestDeadline()throws Exception{
        CountDownLatch started=new CountDownLatch(2),release=new CountDownLatch(1);AtomicInteger stale=new AtomicInteger();BlockingQueue<JSONObject> events=new LinkedBlockingQueue<>();
        try(Server server=new Server(path->{if(path.equals("/hold")){started.countDown();release.await(5,TimeUnit.SECONDS);}if(path.equals("/expired"))stale.incrementAndGet();return ok();});MediaRequests media=new MediaRequests(Runnable::run,events::add)){
            media.configure(server.base());media.request(request("hold-1",server.base()+"/hold"));media.request(request("hold-2",server.base()+"/hold"));assertTrue(started.await(5,TimeUnit.SECONDS));
            media.request(request("expired",server.base()+"/expired").put("timeoutMs",1000));Thread.sleep(1100);release.countDown();JSONObject rejected=null;for(int i=0;i<3;i++){JSONObject event=events.poll(5,TimeUnit.SECONDS);assertNotNull(event);if(event.getString("id").equals("expired"))rejected=event;}
            assertNotNull(rejected);assertEquals(0,rejected.getInt("status"));assertTrue(rejected.getString("error").contains("超时"));assertEquals(0,stale.get());
        }finally{release.countDown();}
    }
    @Test public void postersPreserveBinaryAndRefuseSvgRedirectAndPost()throws Exception{
        byte[] png=java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ24AAAAASUVORK5CYII=");
        BlockingQueue<JSONObject> events=new LinkedBlockingQueue<>();AtomicInteger unexpected=new AtomicInteger();
        try(Server server=new Server(path->{
            if(path.equals("/redirect"))return "HTTP/1.1 302 Found\r\nLocation: /unexpected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            if(path.equals("/unexpected"))unexpected.incrementAndGet();
            String mime=path.equals("/svg")?"image/svg+xml":"image/png; charset=binary";
            return "HTTP/1.1 200 OK\r\nContent-Type: "+mime+"\r\nContent-Length: "+png.length+"\r\nConnection: close\r\n\r\n"+new String(png,StandardCharsets.ISO_8859_1);
        });MediaRequests media=new MediaRequests(Runnable::run,events::add)){
            media.configure(server.base());media.request(request("poster",server.base()+"/png").put("responseType","image"));
            JSONObject event=events.poll(5,TimeUnit.SECONDS);assertNotNull(event);assertEquals(200,event.getInt("status"));assertEquals("",event.getString("body"));
            assertEquals("data:image/png;base64,"+java.util.Base64.getEncoder().encodeToString(png),event.getString("dataUrl"));
            media.request(request("svg",server.base()+"/svg").put("responseType","image"));event=events.poll(5,TimeUnit.SECONDS);assertNotNull(event);assertEquals(0,event.getInt("status"));assertEquals("",event.getString("dataUrl"));
            media.request(request("redirect",server.base()+"/redirect").put("responseType","image"));event=events.poll(5,TimeUnit.SECONDS);assertNotNull(event);assertEquals(302,event.getInt("status"));assertEquals("",event.getString("dataUrl"));
            media.request(request("post",server.base()+"/unexpected").put("responseType","image").put("method","POST"));event=events.poll(5,TimeUnit.SECONDS);assertNotNull(event);assertEquals(0,event.getInt("status"));assertEquals(0,unexpected.get());
        }
    }
    @Test public void playbackFollowsCdnForMp4AndHlsWithoutLeakingAccount()throws Exception{
        BlockingQueue<String> received=new LinkedBlockingQueue<>();
        try(Server cdn=new Server((path,headers)->{received.add(path+"\n"+headers);return ok();});Server emby=new Server(path->"HTTP/1.1 302 Found\r\nLocation: "+cdn.base()+path.split("\\?")[0]+"?signed=cdn-signature&api_key=account-secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");MediaRequests media=new MediaRequests(Runnable::run,event->{})){
            media.configure(emby.base());Call.Factory player=media.playbackCalls();
            for(String path:new String[]{"/movie.mp4","/master.m3u8"}){
                try(Response response=player.newCall(stream(emby.base()+path+"?api_key=account-secret")).execute()){
                    assertEquals(200,response.code());assertEquals("ok",response.body().string());assertEquals(cdn.socket.getLocalPort(),response.request().url().port());assertNull(response.request().url().queryParameter("api_key"));
                }
                String target=received.poll(5,TimeUnit.SECONDS);assertNotNull(target);assertTrue(target.contains("signed=cdn-signature"));assertTrue(target.contains("Range: bytes=0-"));assertFalse(target.contains("account-secret"));assertFalse(target.contains("Cookie:"));assertFalse(target.contains("Authorization:"));
            }
            // Media3 resolves later playlist resources against the redirected manifest URL.
            try(Response response=player.newCall(stream(cdn.base()+"/segment.ts?api_key=account-secret&signed=segment")).execute()){assertEquals(200,response.code());}
            String segment=received.poll(5,TimeUnit.SECONDS);assertNotNull(segment);assertTrue(segment.startsWith("/segment.ts?signed=segment"));assertFalse(segment.contains("account-secret"));assertFalse(segment.contains("Cookie:"));
            try(Response ignored=player.newCall(new Request.Builder().url(cdn.base().replace("http://","http://user:secret@")+"/segment.ts").build()).execute()){fail("userinfo must be refused");}catch(IOException expected){}
            assertNull(received.poll());
        }
    }
    @Test public void reconfigureCancelsPlaybackAndRejectsOldFactoryEvenAtSameOrigin()throws Exception{
        CountDownLatch started=new CountDownLatch(1),release=new CountDownLatch(1),finished=new CountDownLatch(1);AtomicInteger reached=new AtomicInteger();
        try(Server server=new Server(path->{reached.incrementAndGet();if(path.equals("/hold")){started.countDown();release.await(5,TimeUnit.SECONDS);}return ok();});MediaRequests media=new MediaRequests(Runnable::run,event->{})){
            media.configure(server.base());Call.Factory old=media.playbackCalls();Call active=old.newCall(new Request.Builder().url(server.base()+"/hold").build());
            active.enqueue(new Callback(){public void onFailure(Call call,IOException error){finished.countDown();}public void onResponse(Call call,Response response){response.close();finished.countDown();}});
            assertTrue(started.await(5,TimeUnit.SECONDS));media.configure(server.base());assertTrue(active.isCanceled());assertTrue(finished.await(5,TimeUnit.SECONDS));release.countDown();
            try(Response ignored=old.newCall(new Request.Builder().url(server.base()+"/obsolete.m3u8").build()).execute()){fail("old player factory must expire");}catch(IOException expected){}
            assertEquals(1,reached.get());
            try(Response response=media.playbackCalls().newCall(new Request.Builder().url(server.base()+"/fresh.mp4").build()).execute()){assertEquals(200,response.code());}
            assertEquals(2,reached.get());
            Call.Factory stopped=media.playbackCalls();media.invalidate();
            try(Response ignored=stopped.newCall(new Request.Builder().url(server.base()+"/stopped.ts").build()).execute()){fail("stopped player factory must expire");}catch(IOException expected){}
            assertEquals(2,reached.get());
        }finally{release.countDown();}
    }
    @Test public void reconfigureCancelsQueuedWorkEvenForSameOrigin()throws Exception{
        CountDownLatch started=new CountDownLatch(2),release=new CountDownLatch(1);AtomicInteger stale=new AtomicInteger();
        BlockingQueue<JSONObject> events=new LinkedBlockingQueue<>();
        try(Server server=new Server(path->{if(path.equals("/hold")){started.countDown();release.await(5,TimeUnit.SECONDS);}if(path.equals("/stale"))stale.incrementAndGet();return ok();});MediaRequests media=new MediaRequests(Runnable::run,events::add)){
            String base=server.base();
            media.configure(base);media.request(request("hold-1",base+"/hold"));media.request(request("hold-2",base+"/hold"));assertTrue(started.await(5,TimeUnit.SECONDS));
            media.request(request("old",base+"/stale"));media.configure(base);release.countDown();media.request(request("new",base+"/new"));
            JSONObject event=events.poll(5,TimeUnit.SECONDS);assertNotNull(event);assertEquals("new",event.getString("id"));assertEquals(200,event.getInt("status"));assertEquals(0,stale.get());assertNull(events.poll());
        }finally{release.countDown();}
    }
    @Test public void queuedResponseIsRecheckedWhenUiActuallyDispatches()throws Exception{
        BlockingQueue<Runnable> ui=new LinkedBlockingQueue<>();BlockingQueue<JSONObject> events=new LinkedBlockingQueue<>();
        try(Server server=new Server(path->ok());MediaRequests media=new MediaRequests(ui::add,events::add)){
            String base=server.base();
            media.configure(base);media.request(request("old",base));Runnable callback=ui.poll(5,TimeUnit.SECONDS);assertNotNull(callback);media.invalidate();callback.run();assertNull(events.poll());
            media.request(request("new",base));callback=ui.poll(5,TimeUnit.SECONDS);assertNotNull(callback);callback.run();assertEquals("new",events.take().getString("id"));
        }
    }
    @Test public void refusesCredentialsAndCrossOriginRedirects()throws Exception{
        AtomicInteger reached=new AtomicInteger();BlockingQueue<JSONObject> events=new LinkedBlockingQueue<>();
        try(Server destination=new Server(path->{reached.incrementAndGet();return ok();});Server source=new Server(path->"HTTP/1.1 302 Found\r\nLocation: "+destination.base()+"/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");MediaRequests media=new MediaRequests(Runnable::run,events::add)){
            String base=source.base();
            try{media.configure("http://user:secret@127.0.0.1");fail();}catch(IllegalArgumentException expected){}
            media.configure(base);media.request(request("redirect",base));JSONObject event=events.poll(5,TimeUnit.SECONDS);assertNotNull(event);assertEquals(0,event.getInt("status"));assertEquals(0,reached.get());
        }
    }
    @Test public void requestQueueAndResponseBodyAreBounded()throws Exception{
        CountDownLatch started=new CountDownLatch(2),release=new CountDownLatch(1);BlockingQueue<JSONObject> events=new LinkedBlockingQueue<>();
        try(Server server=new Server(path->{started.countDown();release.await(5,TimeUnit.SECONDS);return ok();});MediaRequests media=new MediaRequests(Runnable::run,events::add)){
            String base=server.base();media.configure(base);media.request(request("hold-1",base));media.request(request("hold-2",base));assertTrue(started.await(5,TimeUnit.SECONDS));
            for(int i=0;i<16;i++)media.request(request("queued-"+i,base));media.request(request("overflow",base));JSONObject rejected=events.poll(5,TimeUnit.SECONDS);assertNotNull(rejected);assertEquals("overflow",rejected.getString("id"));assertEquals(0,rejected.getInt("status"));media.invalidate();release.countDown();
        }finally{release.countDown();}
        try(Server server=new Server(path->{String body="x".repeat(2097153);return "HTTP/1.1 200 OK\r\nContent-Length: "+body.length()+"\r\nConnection: close\r\n\r\n"+body;});MediaRequests media=new MediaRequests(Runnable::run,events::add)){
            media.configure(server.base());media.request(request("oversize",server.base()));JSONObject rejected=events.poll(5,TimeUnit.SECONDS);assertNotNull(rejected);assertEquals("oversize",rejected.getString("id"));assertEquals(0,rejected.getInt("status"));assertEquals("",rejected.getString("body"));
        }
    }
}
