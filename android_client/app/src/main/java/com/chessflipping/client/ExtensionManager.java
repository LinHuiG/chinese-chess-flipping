package com.chessflipping.client;

import android.content.*;
import android.content.pm.*;
import android.content.res.*;
import android.net.Uri;
import android.os.*;
import android.widget.FrameLayout;
import androidx.core.content.FileProvider;
import com.chessflipping.protocol.WireProtocol;
import com.cyberroom.sdk.NativeExtension;
import dalvik.system.PathClassLoader;
import okhttp3.*;
import org.json.*;
import java.io.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.*;

/** Official signed native components are installed separately. Third-party scripts cannot load code. */
final class ExtensionManager implements AutoCloseable {
    private final Context context;private final Handler main=new Handler(Looper.getMainLooper());
    private final Supplier<GameConnection> connection;private final Supplier<UdpPeer> udp;
    private final Consumer<JSONObject> events;private final Consumer<String> permission;
    private final OkHttpClient http=new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(120,TimeUnit.SECONDS).build();
    private volatile NativeExtension active;private volatile long generation;private volatile boolean destroyed;
    private volatile String room="";private volatile Set<String> members=Collections.emptySet();
    private JSONObject exports=new JSONObject();
    private FrameLayout parent;private boolean foreground;private long permissionGeneration=-1;
    ExtensionManager(Context context,Supplier<GameConnection> connection,Supplier<UdpPeer> udp,Consumer<JSONObject> events,Consumer<String> permission){this.context=context;this.connection=connection;this.udp=udp;this.events=events;this.permission=permission;}
    private String hash(File file)throws Exception{MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] data=new byte[65536];int n;while((n=in.read(data))!=-1)digest.update(data,0,n);}StringBuilder out=new StringBuilder();for(byte b:digest.digest())out.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return out.toString();}
    private void validate(JSONObject q)throws Exception{
        if(q.optInt("api")!=1||!"apk".equals(q.optString("kind"))||!q.getString("packageName").matches("[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){2,}")||!q.getString("entry").startsWith(q.getString("packageName")+".")||!q.getString("sha256").matches("[0-9a-f]{64}")||q.getLong("size")<1||q.getLong("size")>200*1024*1024||q.getInt("versionCode")<1)throw new IOException("原生组件清单无效");
    }
    private PackageInfo installed(JSONObject q)throws Exception{
        validate(q);PackageInfo info;
        try{info=context.getPackageManager().getPackageInfo(q.getString("packageName"),0);}catch(PackageManager.NameNotFoundException e){return null;}
        if(info.versionCode!=q.getInt("versionCode"))return null;
        if(context.getPackageManager().checkSignatures(context.getPackageName(),info.packageName)!=PackageManager.SIGNATURE_MATCH)throw new IOException("原生组件签名与宿主不一致");
        File source=new File(info.applicationInfo.sourceDir);return source.length()==q.getLong("size")&&hash(source).equals(q.getString("sha256"))?info:null;
    }
    // Runs on a bounded bridge worker; never downloads or hashes on the UI thread.
    synchronized String prepare(String text)throws Exception{
        JSONObject q=new JSONObject(text);if(installed(q)!=null)return "{\"ready\":true}";
        File directory=new File(context.getCacheDir(),"updates");if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("无法创建下载目录");
        File file=new File(directory,q.getString("sha256")+".apk");
        if(!file.isFile()||file.length()!=q.getLong("size")||!hash(file).equals(q.getString("sha256"))){
            File partial=new File(directory,q.getString("sha256")+".part");HttpUrl url=HttpUrl.parse(q.getString("url"));if(url==null||!url.username().isEmpty()||!url.password().isEmpty())throw new IOException("原生组件地址无效");
            try(Response response=http.newCall(new Request.Builder().url(url).build()).execute()){
                if(!response.isSuccessful()||response.body()==null)throw new IOException("原生组件下载失败");
                try(InputStream in=response.body().byteStream();OutputStream out=new FileOutputStream(partial)){byte[] data=new byte[65536];int n;long total=0;while((n=in.read(data))!=-1){total+=n;if(destroyed||total>q.getLong("size"))throw new IOException("原生组件下载已停止");out.write(data,0,n);}}
                if(partial.length()!=q.getLong("size")||!hash(partial).equals(q.getString("sha256")))throw new IOException("原生组件文件校验失败");
                if(!partial.renameTo(file))throw new IOException("原生组件保存失败");
            }finally{partial.delete();}
        }
        main.post(()->{if(destroyed)return;if(!context.getPackageManager().canRequestPackageInstalls()){context.startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+context.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));return;}
            Uri uri=FileProvider.getUriForFile(context,context.getPackageName()+".updates",file);context.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_ACTIVITY_NEW_TASK));});
        return "{\"ready\":false}";
    }
    String activate(String text)throws Exception{
        JSONObject q=new JSONObject(text);PackageInfo info=installed(q);if(info==null)throw new IOException("请先安装所需原生组件");
        PathClassLoader loader=new PathClassLoader(info.applicationInfo.sourceDir,context.getClassLoader());
        Context resources=context.createPackageContext(info.packageName,0);Resources.Theme theme=resources.getResources().newTheme();
        Context componentContext=new ContextWrapper(context){
            @Override public Resources getResources(){return resources.getResources();}
            @Override public AssetManager getAssets(){return resources.getAssets();}
            @Override public ClassLoader getClassLoader(){return loader;}
            @Override public Context getApplicationContext(){return this;}
            @Override public Resources.Theme getTheme(){return theme;}
        };
        NativeExtension next=(NativeExtension)loader.loadClass(q.getString("entry")).getDeclaredConstructor().newInstance();
        return onMain(()->{
            stop();exports=q.getJSONObject("exports");long current=generation;
            next.initialize(componentContext,new NativeExtension.Host(){
                @Override public void event(JSONObject value){main.post(()->{if(current==generation&&active==next){try{value.put("componentSession",Long.toString(current));events.accept(value);}catch(JSONException ignored){}}});}
                @Override public boolean healthy(String peer){UdpPeer p=udp.get();return current==generation&&members.contains(peer)&&p!=null&&p.healthy(peer);}
                @Override public boolean send(String peer,NativeExtension.Packet packet){
                    if(current!=generation||active!=next||room.isEmpty())return false;
                    try{Map<String,String> fields=WireProtocol.control(packet.control);if(!room.equals(fields.get("roomId")))return false;WireProtocol.Packet value=new WireProtocol.Packet(packet.type,packet.control,packet.body);
                        if(peer!=null){UdpPeer p=udp.get();return packet.type==64&&peer.equals(fields.get("to"))&&!fields.containsKey("op")&&members.contains(peer)&&p!=null&&p.send(peer,WireProtocol.plain(value));}
                        if(packet.type!=16||!"201".equals(fields.get("op")))return false;String targets=fields.get("to");if(targets==null||!members.containsAll(Arrays.asList(targets.split(","))))return false;GameConnection c=connection.get();return c!=null&&c.send(value);
                    }catch(Exception e){return false;}
                }
                @Override public void permission(String name){main.post(()->{if(current==generation&&active==next&&foreground&&hasPermission("voice")&&android.Manifest.permission.RECORD_AUDIO.equals(name)){permissionGeneration=current;permission.accept(name);}});}
            });active=next;if(parent!=null)next.attach(parent);next.foreground(foreground);return new JSONObject().put("ready",true).put("session",Long.toString(current)).toString();
        });
    }
    private <T>T onMain(Callable<T> action)throws Exception{if(Looper.myLooper()==main.getLooper())return action.call();FutureTask<T> task=new FutureTask<>(action);main.post(()->{if(destroyed)task.cancel(false);else task.run();});try{return task.get(10,TimeUnit.SECONDS);}catch(TimeoutException e){task.cancel(false);throw e;}}
    Object call(String text)throws Exception{
        JSONObject q=new JSONObject(text);return onMain(()->{
            NativeExtension current=active;if(current==null)throw new IOException("原生组件尚未启用");JSONObject scope=q.optJSONObject("scope");
            if(scope!=null){room=scope.optString("roomId");Set<String> next=new HashSet<>();JSONArray ids=scope.optJSONArray("members");if(ids!=null)for(int i=0;i<ids.length();i++){String id=ids.getString(i);if(!id.matches("[0-9a-f]{32}"))throw new IOException("成员标识无效");next.add(id);}members=Collections.unmodifiableSet(next);}
            return current.call(exported(q.getString("method")),q.getJSONArray("args"),scope);
        });
    }
    private boolean hasPermission(String name){Iterator<String> keys=exports.keys();while(keys.hasNext())if(name.equals(exports.optString(keys.next())))return true;return false;}
    private String exported(String method)throws IOException{if(!exports.has(method))throw new IOException("组件未公开此方法");return method;}
    boolean receive(String peer,WireProtocol.Packet packet){NativeExtension extension=active;if(extension==null)return false;try{Map<String,String> fields=WireProtocol.control(packet.control);String sender=peer!=null?peer:fields.get("from");if(packet.type!=64||room.isEmpty()||!room.equals(fields.get("roomId"))||!members.contains(sender))return false;return extension.receive(peer,new NativeExtension.Packet(packet.type,packet.control,packet.body));}catch(Exception error){return false;}}

    boolean active(){return active!=null;}
    void attach(FrameLayout parent){this.parent=parent;NativeExtension extension=active;if(extension!=null)extension.attach(parent);}
    void detach(){parent=null;NativeExtension extension=active;if(extension!=null)extension.detach();}
    void foreground(boolean value){foreground=value;if(!value)permissionGeneration=-1;NativeExtension extension=active;if(extension!=null)extension.foreground(value);}
    void permission(boolean granted){long requested=permissionGeneration;permissionGeneration=-1;NativeExtension extension=active;if(requested==generation&&extension!=null)extension.permission(android.Manifest.permission.RECORD_AUDIO,granted&&foreground);}
    void stop(){generation++;permissionGeneration=-1;room="";members=Collections.emptySet();NativeExtension extension=active;active=null;if(extension!=null)extension.close();}
    void deactivate()throws Exception{onMain(()->{stop();return true;});}
    @Override public void close(){destroyed=true;http.dispatcher().cancelAll();stop();}
}
