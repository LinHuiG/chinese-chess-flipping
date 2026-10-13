package com.chessflipping.client;
import android.app.*;
import android.content.*;
import android.os.*;
import android.view.*;
import android.view.accessibility.AccessibilityNodeInfo;
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
    private void select(String selector,String label)throws Exception{
        JSONArray point=(JSONArray)js("(()=>{const r=document.querySelector('"+selector+"').getBoundingClientRect();return [(r.left+r.right)/2,(r.top+r.bottom)/2,innerWidth]})()");
        int[] origin=new int[3];runOnMainSync(()->{service.web.getLocationOnScreen(origin);origin[2]=service.web.getWidth();});
        float scale=(float)(origin[2]/point.getDouble(2)),x=origin[0]+(float)point.getDouble(0)*scale,y=origin[1]+(float)point.getDouble(1)*scale;
        tap(x,y);
        long end=SystemClock.elapsedRealtime()+5000;
        while(SystemClock.elapsedRealtime()<end){
            AccessibilityNodeInfo root=getUiAutomation().getRootInActiveWindow();
            if(root!=null)for(AccessibilityNodeInfo node:root.findAccessibilityNodeInfosByText(label)){
                if(label.contentEquals(node.getText()==null?"":node.getText())&&"android.widget.CheckedTextView".contentEquals(node.getClassName())){
                    android.graphics.Rect bounds=new android.graphics.Rect();node.getBoundsInScreen(bounds);tap(bounds.centerX(),bounds.centerY());return;
                }
            }
            SystemClock.sleep(100);
        }
        throw new AssertionError("Native select popup missing: "+selector+" / "+label);
    }
    private void tap(float x,float y){
        long now=SystemClock.uptimeMillis();
        MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,x,y,0),up=MotionEvent.obtain(now,now+50,MotionEvent.ACTION_UP,x,y,0);
        down.setSource(InputDevice.SOURCE_TOUCHSCREEN);up.setSource(InputDevice.SOURCE_TOUCHSCREEN);sendPointerSync(down);sendPointerSync(up);down.recycle();up.recycle();
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
            js("document.querySelector('[data-create=chess]').click()");
            select("#create-game","黄金矿工 · 2–3 人");until("document.querySelector('#capacity-row').hidden===false");
            select("#capacity","3 人");until("document.querySelector('#capacity').value==='3'");
            ActivityMonitor monitor=addMonitor(MainActivity.class.getName(),null,false);
            runOnMainSync(activity::recreate);activity=(MainActivity)waitForMonitorWithTimeout(monitor,10000);removeMonitor(monitor);
            if(activity==null)throw new AssertionError("Activity recreation");
            waitForIdleSync();
            select("#create-game","翻棋 · 2 人");until("document.querySelector('#capacity-row').hidden===true");
            select("#create-game","黄金矿工 · 2–3 人");until("document.querySelector('#capacity-row').hidden===false");
            select("#capacity","2 人");until("document.querySelector('#capacity').value==='2'");
            select("#capacity","3 人");until("document.querySelector('#capacity').value==='3'");
            js("document.querySelector('#room-name').value='Android 矿工验收';document.querySelector('#create-submit').click()");
            until("document.querySelector('#waiting')?.hidden===false");
            if(!String.valueOf(js("document.querySelector('#waiting-id').textContent")).contains("1/3"))throw new AssertionError("capacity");
            if(!Boolean.TRUE.equals(js("typeof NativeRoom.sendPeer==='function'")))throw new AssertionError("bridge");
            runOnMainSync(()->getTargetContext().startService(new Intent(getTargetContext(),GameService.class).setAction("STOP")));
            until("document.querySelector('#offline')?.hidden===false");
            success=true;result.putString("stream","PASS: bundled WebView modules, native game/capacity select popups before and after Activity recreation, TCP handshake, 3-player room creation, leave and disconnect\n");
        }catch(Throwable e){result.putString("stream","FAIL: "+e+"\n");}
        finally{
            prefs.edit().putString("host",oldHost).putInt("port",oldPort).putString("transport",oldMode).commit();
            if(service!=null)runOnMainSync(()->getTargetContext().unbindService(binding));
            if(activity!=null)runOnMainSync(activity::finish);
            finish(success?Activity.RESULT_OK:Activity.RESULT_CANCELED,result);
        }
    }
}
