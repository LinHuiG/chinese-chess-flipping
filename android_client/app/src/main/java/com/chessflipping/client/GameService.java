package com.chessflipping.client;
import android.app.*;
import android.content.*;
import android.os.*;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.Network;
import android.content.pm.PackageManager;
import android.webkit.*;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import com.chessflipping.protocol.WireProtocol;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import androidx.core.content.FileProvider;

/** Owns the local shared client and native transports across Activity recreation. */
public final class GameService extends Service {
    public static final String DEFAULT_HOST="fqgame.tdcode.tech";public static final int DEFAULT_PORT=8888;
    public final class LocalBinder extends Binder{public GameService service(){return GameService.this;}}
    private final Handler main=new Handler(Looper.getMainLooper());private final IBinder binder=new LocalBinder();
    private final ArrayList<JSONObject> pendingEvents=new ArrayList<>();
    private volatile GameConnection connection;private volatile UdpPeer udp;private volatile int generation;private boolean pageLoaded;private String activeRoom="";
    public Runnable exitActivity;
    public WebView web;public AppUpdater updater;private ExtensionManager extension;private boolean inForeground;
    private ConnectivityManager connectivity;private ConnectivityManager.NetworkCallback networkCallback;
    private MutableContextWrapper webContext;private volatile boolean destroyed;private NativeBridge nativeBridge;
    private final java.util.Map<String,SecureStore> secureStores=new java.util.HashMap<>();
    private synchronized SecureStore secureStore(String namespace){return secureStores.computeIfAbsent(namespace,key->new SecureStore(this,key));}
    private MainActivity webActivity;private FrameLayout webParent;private View fullscreenView;private WebChromeClient.CustomViewCallback fullscreenCallback;
    private static final String ORIGIN="appassets.androidplatform.net";
    @Override public void onCreate(){
        super.onCreate();
        updater=new AppUpdater(this,q->{if(connection!=null)connection.request(q);},this::updateEvent);
        try{udp=new UdpPeer(this::event);}catch(Exception ignored){}
        extension=new ExtensionManager(this,()->connection,()->udp,this::event,name->{if(webActivity!=null)webActivity.requestMicrophone();});
        if(udp!=null)udp.packetHandler(extension::receive);
        connectivity=getSystemService(ConnectivityManager.class);
        networkCallback=new ConnectivityManager.NetworkCallback(){private Network last;
            @Override public void onAvailable(Network network){if(network.equals(last))return;last=network;main.post(()->{if(udp!=null)udp.clear();extension.foreground(false);extension.foreground(inForeground);event(message("networkChanged"));});}
            @Override public void onLost(Network network){if(network.equals(last))main.post(()->{extension.foreground(false);extension.foreground(inForeground);event(message("networkChanged"));});}
        };
        connectivity.registerDefaultNetworkCallback(networkCallback);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags&android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)!=0);
        webContext=new MutableContextWrapper(getApplicationContext());
        web=new WebView(webContext);WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);s.setAllowContentAccess(false);s.setAllowFileAccessFromFileURLs(false);s.setAllowUniversalAccessFromFileURLs(false);
        s.setMediaPlaybackRequiresUserGesture(true);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setBackgroundColor(0xff080d16);nativeBridge=new NativeBridge(web,new Bridge(),"https://"+ORIGIN);
        web.setWebChromeClient(new WebChromeClient(){
            @Override public void onShowCustomView(View view,CustomViewCallback callback){
                if(webActivity==null||webParent==null||fullscreenView!=null){callback.onCustomViewHidden();return;}
                fullscreenView=view;fullscreenCallback=callback;web.setVisibility(View.INVISIBLE);
                web.clearFocus();webParent.addView(view,new FrameLayout.LayoutParams(-1,-1));view.setFocusableInTouchMode(true);view.requestFocus();webActivity.fullscreen(true,extension.active());
                // The video is rendered by Media3, so keep its texture and danmaku above
                // Chromium's full-screen view; shared fullscreenchange supplies new bounds.
                extension.attach(webParent);

            }
            @Override public void onHideCustomView(){leaveFullscreen();}
        });
        web.setWebViewClient(new WebViewClient(){
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
                Uri uri=request.getUrl();String path=uri.getPath();
                if(!"https".equals(uri.getScheme())||!ORIGIN.equals(uri.getHost())||path==null||!path.startsWith("/web/")||path.contains("..")||path.contains("\\"))
                    return new WebResourceResponse("text/plain","UTF-8",403,"Forbidden",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));
                String name=path.substring(1);String mime=name.endsWith(".js")?"text/javascript":name.endsWith(".json")?"application/json":name.endsWith(".css")?"text/css":name.endsWith(".svg")?"image/svg+xml":name.endsWith(".wav")?"audio/wav":name.endsWith(".txt")?"text/plain":"text/html";
                Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-cache");
                headers.put("Content-Security-Policy","default-src 'self'; script-src 'self' 'unsafe-inline' data: blob:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob: data:; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-src 'self' blob:; base-uri 'none'");
                try{return new WebResourceResponse(mime,"UTF-8",200,"OK",headers,getAssets().open(name));}
                catch(IOException e){return new WebResourceResponse("text/plain","UTF-8",404,"Not Found",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
                Uri uri=request.getUrl();
                if(ORIGIN.equals(uri.getHost())&&"https".equals(uri.getScheme()))return false;
                if(request.hasGesture()&&request.isForMainFrame()&&("https".equals(uri.getScheme())||"http".equals(uri.getScheme())))
                    try{startActivity(new Intent(Intent.ACTION_VIEW,uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));}catch(Exception ignored){}
                return true;
            }
            @Override public void onPageFinished(WebView view,String url){
                if(!url.startsWith("https://"+ORIGIN+"/web/"))return;pageLoaded=true;
                for(JSONObject e:new ArrayList<>(pendingEvents))dispatch(e);pendingEvents.clear();updateEvent();
            }
        });
        web.loadUrl("https://"+ORIGIN+"/web/index.html");
    }
    public void attachWeb(Activity activity,ViewGroup parent){
        // Select popups need the current Activity; the service keeps the page across recreation.
        webContext.setBaseContext(activity);
        webActivity=(MainActivity)activity;webParent=parent instanceof FrameLayout?(FrameLayout)parent:null;
        if(web.getParent() instanceof ViewGroup)((ViewGroup)web.getParent()).removeView(web);
        parent.addView(web,new ViewGroup.LayoutParams(-1,-1));exitActivity=()->activity.moveTaskToBack(true);
        if(parent instanceof android.widget.FrameLayout)extension.attach((android.widget.FrameLayout)parent);
    }
    public void detachWeb(Activity activity){
        if(webContext.getBaseContext()!=activity)return;
        leaveFullscreen();webActivity=null;webParent=null;
        if(web.getParent() instanceof ViewGroup)((ViewGroup)web.getParent()).removeView(web);
        extension.detach();
        exitActivity=null;webContext.setBaseContext(getApplicationContext());
    }
    private void leaveFullscreen(){
        if(fullscreenView==null)return;
        View view=fullscreenView;WebChromeClient.CustomViewCallback callback=fullscreenCallback;fullscreenView=null;fullscreenCallback=null;
        if(view.getParent() instanceof ViewGroup)((ViewGroup)view.getParent()).removeView(view);
        web.setVisibility(View.VISIBLE);if(webActivity!=null)webActivity.fullscreen(false);
        if(callback!=null)callback.onCustomViewHidden();
    }
    public boolean isFullscreen(){return fullscreenView!=null;}
    public void back(){if(isFullscreen())web.evaluateJavascript("(()=>{if(document.fullscreenElement){document.exitFullscreen();return true;}return false;})()",value->{if(!"true".equals(value))leaveFullscreen();});else web.evaluateJavascript("window.cyberBack && window.cyberBack()",null);}
    public android.content.SharedPreferences preferences(){return getSharedPreferences("connection",MODE_PRIVATE);}
    private String host(){return preferences().getString("host",DEFAULT_HOST);}
    private int port(){return preferences().getInt("port",DEFAULT_PORT);}
    private String transport(){return preferences().getString("transport","TCP");}
    @Override public IBinder onBind(Intent intent){return binder;}
    @Override public int onStartCommand(Intent intent,int flags,int startId){return START_NOT_STICKY;}
    private static JSONObject message(String type){try{return new JSONObject().put("type",type);}catch(JSONException e){throw new IllegalStateException(e);}}
    private void dispatch(JSONObject value){web.evaluateJavascript("window.dispatchEvent(new CustomEvent('native-room',{detail:"+value.toString()+"}))",null);}
    private void event(JSONObject value){Runnable deliver=()->{if(destroyed||web==null)return;if(pageLoaded)dispatch(value);else if(pendingEvents.size()<128)pendingEvents.add(value);};if(Looper.myLooper()==main.getLooper())deliver.run();else main.post(deliver);}
    private void onMain(Runnable action){main.post(()->{if(!destroyed)action.run();});}
    private void updateEvent(){
        if(updater==null)return;
        try{event(message("update").put("status",updater.status).put("busy",updater.busy).put("ready",updater.readyFile!=null).put("version",updater.installedName));}catch(JSONException ignored){}
    }
    private void open(JSONObject identity){
        disconnect();int current=++generation;
        TcpClient.Listener listener=new TcpClient.Listener(){
            @Override public void onStatus(String value){main.post(()->{if(current==generation)try{event(message("status").put("message",value));}catch(JSONException ignored){}});}
            @Override public void onPacket(WireProtocol.Packet packet){
                if(current!=generation)return;
                if(extension.receive(null,packet))return;
                main.post(()->{
                    if(current!=generation)return;
                    try{
                        if(packet.type==49){updater.info(new JSONObject(new String(packet.body,StandardCharsets.UTF_8)));return;}
                        if(packet.type==51){updater.chunk(new JSONObject(WireProtocol.control(packet.control)),packet.body);return;}
                        event(message("packet").put("data",Base64.getEncoder().encodeToString(WireProtocol.plain(packet))));
                    }catch(Exception ignored){}
                });
            }
            @Override public void onClosed(String reason){
                main.post(()->{if(current==generation){updater.connectionLost();try{event(message("closed").put("reason",reason));}catch(JSONException ignored){}}});
            }
        };
        connection=transport().equals("TCP")?new TcpClient(identity,listener):new WsClient(identity,transport().equals("HTTPS"),listener);
        connection.connect(host(),port());
    }
    private void disconnect(){++generation;if(updater!=null)updater.connectionLost();if(connection!=null){connection.close();connection=null;}if(udp!=null)udp.clear();if(extension!=null){extension.foreground(false);extension.foreground(inForeground);}}
    public void background(){inForeground=false;extension.foreground(false);event(message("background"));}
    public void foreground(){boolean changed=!inForeground;inForeground=true;extension.foreground(true);if(changed)event(message("foreground"));}
    public void microphonePermission(boolean granted){extension.permission(granted);}
    public void install(){
        if(updater.readyFile==null)return;
        if(!getPackageManager().canRequestPackageInstalls()){
            updater.installPending=true;startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));return;
        }
        updater.installPending=false;
        Uri uri=FileProvider.getUriForFile(this,getPackageName()+".updates",updater.readyFile);
        startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_ACTIVITY_NEW_TASK));
    }
    public final class Bridge {
        @JavascriptInterface public String secureRead(String namespace){try{return secureStore(namespace).read();}catch(IOException error){throw new IllegalStateException(error.getMessage());}}
        @JavascriptInterface public boolean secureWrite(String namespace,String text){try{return secureStore(namespace).write(text);}catch(IOException error){throw new IllegalStateException(error.getMessage());}}
        @JavascriptInterface public String settings(){
            try{return new JSONObject().put("host",host()).put("port",port()).put("transport",transport()).put("nickname",preferences().getString("nickname",""))
                .put("sound",preferences().getBoolean("sound",true)).put("motion",preferences().getBoolean("motion",true)).put("version",updater.installedName).put("nativeExtensions",true).toString();}
            catch(JSONException e){return "{}";}
        }
        @JavascriptInterface public void configure(String text){
            try{JSONObject q=new JSONObject(text);String h=q.getString("host").trim(),t=q.getString("transport");int p=q.getInt("port");
                if(h.isEmpty()||h.length()>253||p<1||p>65535||!t.matches("TCP|HTTP|HTTPS"))return;
                preferences().edit().putString("host",h).putInt("port",p).putString("transport",t).putString("nickname",q.optString("nickname",""))
                    .putBoolean("sound",q.optBoolean("sound",true)).putBoolean("motion",q.optBoolean("motion",true)).apply();
            }catch(Exception ignored){}
        }
        @JavascriptInterface public void connect(String identity){try{JSONObject meta=new JSONObject(identity);onMain(()->open(meta));}catch(JSONException ignored){}}
        @JavascriptInterface public void disconnect(){onMain(()->{GameService.this.disconnect();extension.stop();activeRoom="";});}
        @JavascriptInterface public boolean send(String encoded){
            if(encoded.length()>100000)return false;
            try{GameConnection c=connection;return c!=null&&c.send(WireProtocol.plain(WireProtocol.decode(Base64.getDecoder().decode(encoded))));}catch(Exception e){return false;}
        }
        @JavascriptInterface public void udpRegister(String id,String ticket,int port){if(udp!=null)udp.register(host(),port,id,ticket);}
        @JavascriptInterface public void openPeer(String config){try{if(udp!=null&&config.length()<8192)udp.open(new JSONObject(config));}catch(JSONException ignored){}}
        @JavascriptInterface public boolean sendPeer(String id,String encoded){try{return udp!=null&&encoded.length()<=100000&&udp.send(id,Base64.getDecoder().decode(encoded));}catch(Exception e){return false;}}
        @JavascriptInterface public void closePeers(){if(udp!=null)udp.clear();}
        @JavascriptInterface public void roomActive(String name){onMain(()->activeRoom=name);}
        @JavascriptInterface public String marketDownload(String text)throws Exception{return extension.downloadPackage(text);}
        @JavascriptInterface public String extensionPrepare(String text)throws Exception{return extension.prepare(text);}
        @JavascriptInterface public String extensionActivate(String text)throws Exception{return extension.activate(text);}
        @JavascriptInterface public Object extensionCall(String text)throws Exception{return extension.call(text);}
        @JavascriptInterface public void extensionClose()throws Exception{extension.deactivate();}
        @JavascriptInterface public void checkUpdate(){onMain(()->updater.check(host(),port(),transport()));}
        @JavascriptInterface public void installUpdate(){onMain(GameService.this::install);}
        @JavascriptInterface public void exitApp(){onMain(()->{if(exitActivity!=null)exitActivity.run();});}
    }
    @Override public void onDestroy(){
        destroyed=true;if(nativeBridge!=null)nativeBridge.close();leaveFullscreen();disconnect();if(udp!=null)udp.close();updater.close();extension.close();connectivity.unregisterNetworkCallback(networkCallback);
        if(web!=null){if(web.getParent() instanceof ViewGroup)((ViewGroup)web.getParent()).removeView(web);webContext.setBaseContext(getApplicationContext());web.removeJavascriptInterface("NativeRoom");web.destroy();web=null;}
        super.onDestroy();
    }
}
