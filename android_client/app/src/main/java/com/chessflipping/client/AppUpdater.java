package com.chessflipping.client;

import android.content.Context;
import android.content.pm.*;
import android.os.*;
import okhttp3.*;
import org.json.*;
import java.io.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

/** One update at a time. Download I/O never blocks the host referee's checkpoint executor. */
public final class AppUpdater implements AutoCloseable {
    private static final OkHttpClient HTTP = new OkHttpClient.Builder().connectTimeout(8,TimeUnit.SECONDS)
            .readTimeout(15,TimeUnit.SECONDS).callTimeout(120,TimeUnit.SECONDS).build();
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Consumer<JSONObject> send;
    private final Runnable changed;
    private final long installed;
    private final File partial, complete;
    private volatile int epoch;
    private volatile Call call;
    private boolean tcp;
    private String host, mode;
    private int port;
    private JSONObject release;
    private FileOutputStream output;
    private MessageDigest digest;
    private long received;
    public boolean busy, installPending;
    public File readyFile;
    public String status = "检查更新后自动下载，安装需系统确认";
    public final String installedName;
    private final Runnable timeout = () -> cancel("更新响应超时，请重新检查");

    public AppUpdater(Context context, Consumer<JSONObject> send, Runnable changed) {
        this.context=context;this.send=send;this.changed=changed;
        try { PackageInfo p=context.getPackageManager().getPackageInfo(context.getPackageName(),0);installed=code(p);installedName=p.versionName; }
        catch(PackageManager.NameNotFoundException ex){throw new IllegalStateException(ex);}
        File dir=new File(context.getCacheDir(),"updates");partial=new File(dir,"download.part");complete=new File(dir,"latest.apk");
    }
    private static long code(PackageInfo p) { return Build.VERSION.SDK_INT>=28?p.getLongVersionCode():p.versionCode; }
    public void check(String host,int port,String mode) {
        if(busy)return;
        this.host=host;this.port=port;this.mode=mode;tcp=mode.equals("TCP");release=null;readyFile=null;installPending=false;
        busy=true;int current=++epoch;status="正在检查新版本…";changed.run();arm();
        if(tcp)send.accept(json("UPDATE_CHECK", "versionCode",installed));
        else io.execute(()->{
            try(Response response=request("version").execute()) {
                if(!response.isSuccessful()||response.body()==null)throw new IOException();
                ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] buffer=new byte[1024];int n;
                InputStream input=response.body().byteStream();
                while((n=input.read(buffer))!=-1){if(bytes.size()+n>8192)throw new IOException();bytes.write(buffer,0,n);}
                JSONObject info=new JSONObject(bytes.toString("UTF-8"));main.post(()->{if(current==epoch)info(info);});
            }catch(Exception ex){failed(current,"检查更新失败，请检查服务器地址");}
        });
    }
    private Call request(String action) {
        HttpUrl url=new HttpUrl.Builder().scheme(mode.equals("HTTPS")?"https":"http").host(host).port(port)
                .addPathSegments("api/app/"+action).addQueryParameter("versionCode",Long.toString(installed)).build();
        return call=HTTP.newCall(new Request.Builder().url(url).build());
    }
    public void info(JSONObject value) {
        if(!busy)return;
        main.removeCallbacks(timeout);
        if(value.has("error")){cancel("服务器更新包已变化，请重新检查");return;}
        if(!value.optBoolean("available")||value.optLong("versionCode")<=installed){busy=false;status="已经是最新版本 "+installedName;changed.run();return;}
        if(release!=null)return;
        if(value.optLong("size")<=0||value.optLong("size")>64*1024*1024||!value.optString("sha256").matches("[0-9a-f]{64}")
                ||!context.getPackageName().equals(value.optString("packageName"))){cancel("更新信息无效");return;}
        release=value;status="下载 "+value.optString("versionName")+" · 0%";changed.run();int current=epoch;
        if(tcp)arm();
        io.execute(()->{
            try {
                if(current!=epoch)return;
                if(!partial.getParentFile().isDirectory()&&!partial.getParentFile().mkdirs())throw new IOException();
                output=new FileOutputStream(partial);digest=MessageDigest.getInstance("SHA-256");received=0;
                if(tcp){main.post(()->{if(current==epoch)next();});return;}
                try(Response response=request("latest.apk").execute()){
                    if(!response.isSuccessful()||response.code()==204||response.body()==null)throw new IOException();
                    byte[] buffer=new byte[32768];InputStream input=response.body().byteStream();int n,last=-1;
                    while((n=input.read(buffer))!=-1){
                        if(current!=epoch)return;write(buffer,n);
                        int percent=(int)(received*100/release.optLong("size"));
                        if(percent!=last){last=percent;progress(current,percent);}
                    }
                    verify(current);
                }
            }catch(Exception ex){failed(current,ex instanceof SecurityException?ex.getMessage():"下载或校验失败，请重试");}
            finally{if(!tcp||current!=epoch)closeOutput();}
        });
    }
    private void next() {
        JSONObject q=json("APP_GET","versionCode",release.optLong("versionCode"));
        try{q.put("currentVersion",installed).put("offset",received);}catch(JSONException ex){throw new IllegalStateException(ex);}
        send.accept(q);arm();
    }
    public void chunk(JSONObject header,byte[] bytes) {
        if(!busy||!tcp||release==null)return;int current=epoch;
        main.removeCallbacks(timeout);
        io.execute(()->{
            if(current!=epoch)return;
            try {
                if(header.optLong("offset",-1)!=received||header.optLong("versionCode")!=release.optLong("versionCode")||bytes.length==0)throw new IOException();
                write(bytes,bytes.length);progress(current,(int)(received*100/release.optLong("size")));
                if(header.optBoolean("done"))verify(current);else main.post(()->{if(current==epoch)next();});
            }catch(Exception ex){failed(current,ex instanceof SecurityException?ex.getMessage():"下载或校验失败，请重试");}
        });
    }
    private void write(byte[] bytes,int n)throws IOException {
        if(received+n>release.optLong("size"))throw new IOException();
        output.write(bytes,0,n);digest.update(bytes,0,n);received+=n;
    }
    private void progress(int current,int percent) { main.post(()->{if(current==epoch){status="下载 "+release.optString("versionName")+" · "+percent+"%";changed.run();}}); }
    private void verify(int current)throws Exception {
        output.getFD().sync();closeOutput();
        StringBuilder hash=new StringBuilder();for(byte b:digest.digest())hash.append(String.format(Locale.ROOT,"%02x",b&255));
        if(received!=release.optLong("size")||!hash.toString().equals(release.optString("sha256")))throw new IOException();
        PackageManager pm=context.getPackageManager();int flags=Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;
        PackageInfo apk=pm.getPackageArchiveInfo(partial.getPath(),flags),own=pm.getPackageInfo(context.getPackageName(),flags);
        if(apk==null||!context.getPackageName().equals(apk.packageName)||code(apk)!=release.optLong("versionCode")||code(apk)<=installed)
            throw new SecurityException("安装包版本或应用标识不匹配");
        Signature[] actual=Build.VERSION.SDK_INT>=28?(apk.signingInfo==null?null:apk.signingInfo.getApkContentsSigners()):apk.signatures;
        Signature[] expected=Build.VERSION.SDK_INT>=28?own.signingInfo.getApkContentsSigners():own.signatures;
        if(actual==null||!Arrays.equals(actual,expected))throw new SecurityException("安装包签名不同，无法覆盖更新");
        if(current!=epoch)return;
        if(complete.exists()&&!complete.delete())throw new IOException();if(!partial.renameTo(complete))throw new IOException();
        main.post(()->{if(current==epoch){busy=false;readyFile=complete;installPending=true;status="校验通过，等待安装 "+release.optString("versionName");main.removeCallbacks(timeout);changed.run();}});
    }
    private void arm(){main.removeCallbacks(timeout);main.postDelayed(timeout,20000);}
    private void failed(int current,String reason){closeOutput();main.post(()->{if(current==epoch)cancel(reason);});}
    private void closeOutput(){if(output!=null){try{output.close();}catch(IOException ignored){}output=null;}}
    public void connectionLost(){if(busy&&tcp)cancel("更新连接中断，请重新检查");}
    public void cancel(String reason){++epoch;if(call!=null)call.cancel();main.removeCallbacks(timeout);busy=false;release=null;status=reason;io.execute(this::closeOutput);changed.run();}
    private static JSONObject json(String type,String key,long value){try{return new JSONObject().put("type",type).put(key,value);}catch(JSONException ex){throw new IllegalStateException(ex);}}
    @Override public void close(){++epoch;if(call!=null)call.cancel();main.removeCallbacks(timeout);io.execute(this::closeOutput);io.shutdown();}
}
