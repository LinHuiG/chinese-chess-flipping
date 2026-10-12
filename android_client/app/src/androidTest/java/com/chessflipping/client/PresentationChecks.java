package com.chessflipping.client;
import android.app.*;
import android.content.*;
import android.os.*;
import org.json.*;
import java.util.concurrent.*;
/** Debug APK check: loads bundled modules, native bridge, and host room lifecycle on a loopback server. */
public final class PresentationChecks extends Instrumentation{
    private GameService service;private MainActivity activity;private String host="10.0.2.2";private int port=18888;
    private final CountDownLatch bound=new CountDownLatch(1);
    private final ServiceConnection binding=new ServiceConnection(){
        public void onServiceConnected(ComponentName n,IBinder b){service=((GameService.LocalBinder)b).service();bound.countDown();}
        public void onServiceDisconnected(ComponentName n){}
    };
    @Override public void onCreate(Bundle args){super.onCreate(args);if(args!=null){host=args.getString("host",host);port=Integer.parseInt(args.getString("port","18888"));}start();}
    private Object js(String script)throws Exception{
        CompletableFuture<String> result=new CompletableFuture<>();runOnMainSync(()->service.web.evaluateJavascript(script,result::complete));
        return new JSONArray("["+result.get(5,TimeUnit.SECONDS)+"]").get(0);
    }
    private void until(String condition)throws Exception{
        long end=SystemClock.elapsedRealtime()+15000;
        while(SystemClock.elapsedRealtime()<end){if(Boolean.TRUE.equals(js(condition)))return;SystemClock.sleep(150);}
        throw new AssertionError(condition+"; "+js("document.querySelector('#offline-message')?.textContent"));
    }
    @Override public void onStart(){
        Bundle result=new Bundle();boolean success=false;var prefs=getTargetContext().getSharedPreferences("connection",0);
        String oldHost=prefs.getString("host",GameService.DEFAULT_HOST),oldMode=prefs.getString("transport","TCP");int oldPort=prefs.getInt("port",8888);
        try{
            prefs.edit().putString("host",host).putInt("port",port).putString("transport","TCP").commit();
            activity=(MainActivity)startActivitySync(new Intent(getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            runOnMainSync(()->getTargetContext().bindService(new Intent(getTargetContext(),GameService.class),binding,Context.BIND_AUTO_CREATE));
            if(!bound.await(10,TimeUnit.SECONDS))throw new AssertionError("service");
            until("document.querySelector('#lobby')?.hidden===false");
            if(!"赛博房间 · 和朋友一起玩".equals(js("document.title")))throw new AssertionError("title");
            js("document.querySelector('[data-create=miner]').click();document.querySelector('#room-name').value='Android 矿工验收';document.querySelector('#capacity').value='3';document.querySelector('#create-submit').click()");
            until("document.querySelector('#waiting')?.hidden===false");
            if(!String.valueOf(js("document.querySelector('#waiting-id').textContent")).contains("1/3"))throw new AssertionError("capacity");
            if(!Boolean.TRUE.equals(js("typeof NativeRoom.sendPeer==='function'")))throw new AssertionError("bridge");
            runOnMainSync(()->getTargetContext().startService(new Intent(getTargetContext(),GameService.class).setAction("STOP")));
            until("document.querySelector('#offline')?.hidden===false");
            success=true;result.putString("stream","PASS: bundled WebView modules, native TCP handshake, 3-player room creation, leave and disconnect\n");
        }catch(Throwable e){result.putString("stream","FAIL: "+e+"\n");}
        finally{
            prefs.edit().putString("host",oldHost).putInt("port",oldPort).putString("transport",oldMode).commit();
            if(service!=null)runOnMainSync(()->getTargetContext().unbindService(binding));
            if(activity!=null)runOnMainSync(activity::finish);
            finish(success?Activity.RESULT_OK:Activity.RESULT_CANCELED,result);
        }
    }
}
