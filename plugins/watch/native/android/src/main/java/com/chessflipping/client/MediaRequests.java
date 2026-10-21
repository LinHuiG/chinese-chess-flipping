package com.chessflipping.client;

import okhttp3.*;
import org.json.*;
import java.io.*;
import java.net.*;
import javax.net.ssl.SSLException;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/** Bounded Emby requests. Origin changes and stop invalidate queued work as well as active calls. */
final class MediaRequests implements AutoCloseable {
    private final OkHttpClient client,playbackClient,imageClient;
    private final ThreadPoolExecutor workers=new ThreadPoolExecutor(2,2,0,TimeUnit.SECONDS,new ArrayBlockingQueue<>(16));
    private final AtomicInteger generation=new AtomicInteger();
    private final Consumer<Runnable> dispatch;private final Consumer<JSONObject> events;
    private volatile HttpUrl origin;private volatile boolean closed;
    MediaRequests(Consumer<Runnable> dispatch,Consumer<JSONObject> events){
        this.dispatch=dispatch;this.events=events;
        client=new OkHttpClient.Builder().connectTimeout(10,TimeUnit.SECONDS).readTimeout(60,TimeUnit.SECONDS).writeTimeout(15,TimeUnit.SECONDS)
            .addNetworkInterceptor(chain->{Integer ticket=chain.request().tag(Integer.class);if(!allowed(chain.request().url())||(ticket!=null&&ticket!=generation.get()))throw new IOException("Media request expired or origin is not authorized");return chain.proceed(chain.request());}).build();
        imageClient=client.newBuilder().followRedirects(false).followSslRedirects(false).build();
        // Media3 may follow an Emby redirect to a CDN, then load HLS segments there.
        // Its client shares cancellation with API calls but never the API origin guard.
        OkHttpClient.Builder playback=client.newBuilder();playback.networkInterceptors().clear();
        playbackClient=playback.readTimeout(20,TimeUnit.SECONDS).addInterceptor(chain->{Response response=chain.proceed(playbackRequest(chain.request()));try{return response.newBuilder().request(playbackRequest(response.request())).build();}catch(IOException expired){response.close();throw expired;}})
            .addNetworkInterceptor(chain->chain.proceed(playbackRequest(chain.request()))).build();
    }
    private static boolean sameOrigin(HttpUrl a,HttpUrl b){return b!=null&&a.scheme().equals(b.scheme())&&a.host().equals(b.host())&&a.port()==b.port();}
    boolean allowed(HttpUrl url){return !closed&&url.username().isEmpty()&&url.password().isEmpty()&&sameOrigin(url,origin);}
    private static final class PlaybackSession {final int generation;final HttpUrl origin;PlaybackSession(int generation,HttpUrl origin){this.generation=generation;this.origin=origin;}}
    /** Only MediaController uses this after validating the initial player URL against allowed(). */
    Call.Factory playbackCalls(){
        PlaybackSession session=new PlaybackSession(generation.get(),origin);
        return request->playbackClient.newCall(request.newBuilder().tag(PlaybackSession.class,session).build());
    }
    private Request playbackRequest(Request request)throws IOException{
        PlaybackSession session=request.tag(PlaybackSession.class);HttpUrl url=request.url();
        if(closed||session==null||session.origin==null||session.generation!=generation.get()||!url.username().isEmpty()||!url.password().isEmpty())throw new IOException("Playback request expired or URL is not authorized");
        // HttpUrl accepts only HTTP(S). OkHttp resolves Location without manually carrying
        // the previous query string; sanitize every hop and every later HLS resource as well.
        if(sameOrigin(url,session.origin))return request;
        Request.Builder clean=request.newBuilder();
        for(String header:request.headers().names())if(header.equalsIgnoreCase("Authorization")||header.equalsIgnoreCase("Proxy-Authorization")||header.equalsIgnoreCase("Cookie")||header.regionMatches(true,0,"X-Emby-",0,7)||header.regionMatches(true,0,"X-MediaBrowser-",0,15))clean.removeHeader(header);
        HttpUrl.Builder target=url.newBuilder();for(String key:url.queryParameterNames())if(key.equalsIgnoreCase("api_key"))target.removeAllQueryParameters(key);
        return clean.url(target.build()).build();
    }
    void configure(String value){
        HttpUrl next=HttpUrl.parse(value);if(closed||next==null||!next.username().isEmpty()||!next.password().isEmpty())throw new IllegalArgumentException("Emby 地址无效");
        invalidate();origin=next;
    }
    void invalidate(){generation.incrementAndGet();workers.getQueue().clear();client.dispatcher().cancelAll();}
    void request(JSONObject q){
        String id=q.optString("id");int current=generation.get();if(closed||id.isEmpty()||id.length()>128)return;
        boolean image=q.optString("responseType").equals("image");long timeout=Math.max(1000,Math.min(image?20000:60000,q.optLong("timeoutMs",20000))),deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(timeout);
        try{workers.execute(()->{
            if(closed||current!=generation.get())return;
            String stage="Emby 请求";
            try{
                HttpUrl url=HttpUrl.parse(q.getString("url"));if(url==null||!allowed(url))throw new IOException("Media origin is not authorized");
                stage=requestStage(url,image);long remaining=TimeUnit.NANOSECONDS.toMillis(deadline-System.nanoTime());if(remaining<=0)throw new SocketTimeoutException();
                String method=q.optString("method","GET").toUpperCase(Locale.ROOT);if(!method.matches("GET|POST|DELETE"))throw new IOException("Unsupported method");
                if(image&&!method.equals("GET"))throw new IOException("Images require GET");
                String body=q.optString("body","");if(body.length()>1048576)throw new IOException("Request too large");
                Request.Builder builder=new Request.Builder().url(url).tag(Integer.class,current);JSONObject headers=q.optJSONObject("headers");
                if(headers!=null){Iterator<String> keys=headers.keys();while(keys.hasNext()){String key=keys.next();if(key.matches("(?i)Accept|Content-Type|X-Emby-Token|X-Emby-Authorization|Authorization"))builder.header(key,headers.getString(key));}}
                builder.method(method,method.equals("GET")?null:RequestBody.create(body,MediaType.parse("application/json; charset=utf-8")));
                if(current!=generation.get())return;
                Call call=(image?imageClient:client).newCall(builder.build());call.timeout().timeout(remaining,TimeUnit.MILLISECONDS);
                try(Response response=call.execute()){
                    ByteArrayOutputStream bytes=new ByteArrayOutputStream();ResponseBody responseBody=response.body();
                    String mime="";if(image&&response.isSuccessful()){
                        mime=response.header("Content-Type","").split(";",2)[0].trim().toLowerCase(Locale.ROOT);
                        if(!mime.matches("image/(jpeg|png|webp|gif)"))throw new IOException("Unsupported image type");
                    }
                    if(responseBody!=null){byte[] buffer=new byte[8192];int count;try(InputStream input=responseBody.byteStream()){while((count=input.read(buffer))!=-1){if(closed||current!=generation.get())return;if(bytes.size()+count>2097152)throw new IOException("Response too large");bytes.write(buffer,0,count);}}}
                    String dataUrl=image&&response.isSuccessful()?"data:"+mime+";base64,"+Base64.getEncoder().encodeToString(bytes.toByteArray()):"";
                    reply(id,response.code(),image?"":bytes.toString("UTF-8"),dataUrl,"",current);
                }
            }catch(Exception error){reply(id,0,"","",failureMessage(error,stage),current);}
        });}catch(RejectedExecutionException full){reply(id,0,"","","Emby 请求排队已满，请稍后重试",current);}
    }
    static String requestStage(HttpUrl url,boolean image){String path=url.encodedPath();return image?"Emby 海报读取":path.endsWith("/PlaybackInfo")?"Emby 播放协商":path.endsWith("/AuthenticateByName")?"Emby 登录":path.contains("/Subtitles/")?"Emby 字幕读取":path.startsWith("/Sessions/")||path.contains("/ActiveEncodings")||path.startsWith("/LiveStreams/")?"Emby 播放状态上报":"Emby 片库请求";}
    static String failureMessage(Throwable error,String stage){
        for(Throwable cause=error;cause!=null;cause=cause.getCause()){
            if(cause instanceof UnknownHostException)return stage+"失败：片源域名无法解析，请检查 Emby 地址和 DNS";
            if(cause instanceof SSLException)return stage+"失败：片源 HTTPS 证书或安全连接异常，请检查证书及 HTTPS 入口";
            if(cause instanceof InterruptedIOException)return stage+"超时，请检查片源网络或转码服务后重试";
            if(cause instanceof ConnectException)return stage+"连接失败，请检查 Emby 地址、端口和服务状态";
            if(cause instanceof SocketException||cause instanceof EOFException)return stage+"连接中断，请检查片源网络后重试";
            if(cause.getCause()==cause)break;
        }
        return stage+"失败，请检查片源地址、授权、响应格式及网络";
    }
    private void reply(String id,int status,String body,String dataUrl,String error,int current){
        dispatch.accept(()->{if(closed||current!=generation.get())return;try{events.accept(new JSONObject().put("type","mediaResponse").put("id",id).put("status",status).put("body",body).put("dataUrl",dataUrl).put("error",error));}catch(JSONException ignored){}});
    }
    @Override public void close(){closed=true;invalidate();workers.shutdownNow();}
}
