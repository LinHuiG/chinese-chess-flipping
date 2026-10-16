package com.chessflipping.client;

import android.net.Uri;
import android.os.Handler;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.webkit.*;
import org.json.*;
import java.io.*;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import okhttp3.*;

/** Only the exact local top-level document receives native authority. */
final class NativeBridge implements AutoCloseable {
    private final Handler main=new Handler(android.os.Looper.getMainLooper());
    private final ThreadPoolExecutor workers=new ThreadPoolExecutor(1,1,20,TimeUnit.SECONDS,new ArrayBlockingQueue<>(128));
    private final ThreadPoolExecutor downloads=new ThreadPoolExecutor(2,2,20,TimeUnit.SECONDS,new ArrayBlockingQueue<>(4));
    private final OkHttpClient http=new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(35,TimeUnit.SECONDS).build();
    private final Set<Call> calls=ConcurrentHashMap.newKeySet();
    private volatile boolean closed;
    NativeBridge(WebView web,Object target,String origin){
        if(!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))throw new IllegalStateException("请更新 Android System WebView 后重试");
        Map<String,Method> methods=new HashMap<>();
        for(Method method:target.getClass().getDeclaredMethods())if(method.isAnnotationPresent(JavascriptInterface.class))methods.put(method.getName(),method);
        WebViewCompat.addWebMessageListener(web,"CyberBridge",Collections.singleton(origin),(view,message,source,isMainFrame,reply)->{
            if(closed||!isMainFrame||!origin.equals(source.toString()))return;
            try{
                String raw=message.getData();if(raw==null||raw.length()>5*1024*1024)return;
                JSONObject q=new JSONObject(raw);long id=q.getLong("id");String name=q.getString("method");JSONArray args=q.getJSONArray("args");
                try{(name.equals("marketFetch")||name.equals("extensionPrepare")?downloads:workers).execute(()->{
                    Object result=null;String error=null;
                    try{
                        if(name.equals("marketFetch"))result=fetch(args.getString(0),args.getInt(1));
                        else {
                            Method method=methods.get(name);if(method==null)throw new IllegalArgumentException("未公开的原生接口");
                            Class<?>[] types=method.getParameterTypes();if(args.length()!=types.length)throw new IllegalArgumentException("参数数量无效");Object[] values=new Object[types.length];
                            for(int i=0;i<types.length;i++)values[i]=types[i]==String.class?args.getString(i):types[i]==int.class?args.getInt(i):args.getBoolean(i);
                            result=method.invoke(target,values);
                        }
                    }catch(Exception e){error=e.getCause()!=null?e.getCause().getMessage():e.getMessage();if(error==null)error="原生接口失败";}
                    respond(reply,id,result,error);
                });}catch(RejectedExecutionException e){respond(reply,id,null,"原生请求过多，请稍后重试");}
            }catch(Exception ignored){}
        });
    }
    private void respond(JavaScriptReplyProxy reply,long id,Object value,String error){
        try{String result=new JSONObject().put("id",id).put("value",value==null?JSONObject.NULL:value).put("error",error==null?JSONObject.NULL:error).toString();main.post(()->{if(!closed)reply.postMessage(result);});}catch(JSONException ignored){}
    }
    private String fetch(String address,int limit)throws IOException{
        HttpUrl url=HttpUrl.parse(address);
        if(url==null||!url.username().isEmpty()||!url.password().isEmpty()||limit<1||limit>24*1024*1024)throw new IOException("插件下载参数无效");
        Call call=http.newCall(new Request.Builder().url(url).header("Accept","application/json").build());calls.add(call);
        try(Response response=call.execute()){
            ResponseBody body=response.body();if(!response.isSuccessful()||body==null)throw new IOException("插件下载失败："+response.code());
            if(body.contentLength()>limit)throw new IOException("插件文件过大");
            try(InputStream input=body.byteStream();ByteArrayOutputStream output=new ByteArrayOutputStream(Math.min(limit,65536))){byte[] bytes=new byte[16384];int n,total=0;while((n=input.read(bytes))!=-1){total+=n;if(total>limit)throw new IOException("插件文件过大");output.write(bytes,0,n);}return output.toString(StandardCharsets.UTF_8.name());}
        }finally{calls.remove(call);}
    }
    @Override public void close(){closed=true;for(Call call:calls)call.cancel();workers.shutdownNow();downloads.shutdownNow();http.connectionPool().evictAll();}
}
