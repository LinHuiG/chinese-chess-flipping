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
        JSONArray point=(JSONArray)js("(()=>{const s=document.querySelector('"+selector+"'),r=(s.nextElementSibling?.matches('.choice-trigger')?s.nextElementSibling:s).getBoundingClientRect();return [(r.left+r.right)/2,(r.top+r.bottom)/2,innerWidth]})()");
        int[] origin=new int[3];runOnMainSync(()->{service.web.getLocationOnScreen(origin);origin[2]=service.web.getWidth();});
        float scale=(float)(origin[2]/point.getDouble(2)),x=origin[0]+(float)point.getDouble(0)*scale,y=origin[1]+(float)point.getDouble(1)*scale;
        tap(x,y);
        long end=SystemClock.elapsedRealtime()+5000;
        while(SystemClock.elapsedRealtime()<end){
            // Input injection can return before WebView dispatches the click. Recheck both
            // presentation types on every pass instead of committing to the first snapshot.
            Object option=js("(()=>{const b=[...document.querySelectorAll('dialog.choice-sheet[open] button.choice-option')].find(x=>!x.disabled&&x.textContent.replace(/\\s*✓\\s*$/,'').trim()==="+JSONObject.quote(label)+");if(!b)return null;const r=b.getBoundingClientRect(),s=getComputedStyle(b);if(r.width<=0||r.height<=0||s.visibility!=='visible')return null;return [(r.left+r.right)/2,(r.top+r.bottom)/2]})()");
            if(option instanceof JSONArray){
                JSONArray bounds=(JSONArray)option;
                tap(origin[0]+(float)bounds.getDouble(0)*scale,origin[1]+(float)bounds.getDouble(1)*scale);return;
            }
            AccessibilityNodeInfo root=getUiAutomation().getRootInActiveWindow();
            if(root!=null)for(AccessibilityNodeInfo node:root.findAccessibilityNodeInfosByText(label)){
                if(node.isVisibleToUser()&&node.isEnabled()&&label.contentEquals(node.getText()==null?"":node.getText())&&"android.widget.CheckedTextView".contentEquals(node.getClassName())){
                    android.graphics.Rect bounds=new android.graphics.Rect();node.getBoundsInScreen(bounds);tap(bounds.centerX(),bounds.centerY());return;
                }
            }
            SystemClock.sleep(100);
        }
        throw new AssertionError("Selection popup missing (custom/native): "+selector+" / "+label);
    }
    private void tap(float x,float y){
        long now=SystemClock.uptimeMillis();
        MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,x,y,0),up=MotionEvent.obtain(now,now+50,MotionEvent.ACTION_UP,x,y,0);
        down.setSource(InputDevice.SOURCE_TOUCHSCREEN);up.setSource(InputDevice.SOURCE_TOUCHSCREEN);sendPointerSync(down);sendPointerSync(up);down.recycle();up.recycle();
    }
    private void fullscreenRotation()throws Exception{
        int orientation=activity.getRequestedOrientation();MainActivity owner=activity;
        try{
            js("(()=>{const b=document.createElement('button');b.id='qa-fullscreen';b.textContent='测试全屏';b.style='position:fixed;left:0;top:0;width:120px;height:60px;z-index:2147483647';b.onclick=()=>document.querySelector('#waiting').requestFullscreen();document.querySelector('#waiting').append(b);})()");
            int[] origin=new int[3];runOnMainSync(()->{service.web.getLocationOnScreen(origin);origin[2]=service.web.getWidth();});float scale=origin[2]/((Number)js("innerWidth")).floatValue();tap(origin[0]+60*scale,origin[1]+30*scale);
            until("document.fullscreenElement?.id==='waiting'");
            AccessibilityNodeInfo root=getUiAutomation().getRootInActiveWindow();
            if(root!=null)for(AccessibilityNodeInfo node:root.findAccessibilityNodeInfosByText("退出全屏"))if("android.widget.Button".contentEquals(node.getClassName()))throw new AssertionError("Native movie exit button covers DOM controls");
            runOnMainSync(()->owner.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));until("innerWidth>innerHeight");
            if(owner.isDestroyed()||!Boolean.TRUE.equals(js("document.fullscreenElement?.id==='waiting'")))throw new AssertionError("Rotation recreated the Activity or lost full screen");
            if(!getUiAutomation().performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK))throw new AssertionError("Back injection");until("document.fullscreenElement===null");
            until("document.querySelector('#waiting')?.hidden===false");
            if(!String.valueOf(js("document.querySelector('#waiting-id').textContent")).contains("1/3"))throw new AssertionError("Rotation or full-screen Back left the room");
        }finally{js("document.querySelector('#qa-fullscreen')?.remove();if(document.fullscreenElement)document.exitFullscreen()");runOnMainSync(()->owner.setRequestedOrientation(orientation));}
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
            fullscreenRotation();
            js("window.cyberDisconnect()");
            until("document.querySelector('#offline')?.hidden===false");
            success=true;result.putString("stream","PASS: bundled WebView modules, shared choice sheets before and after Activity recreation, TCP handshake, 3-player room creation, DOM fullscreen/rotation/Back without leaving the room, leave and disconnect\n");
        }catch(Throwable e){result.putString("stream","FAIL: "+e+"\n");}
        finally{
            prefs.edit().putString("host",oldHost).putInt("port",oldPort).putString("transport",oldMode).commit();
            if(service!=null)runOnMainSync(()->getTargetContext().unbindService(binding));
            if(activity!=null)runOnMainSync(activity::finish);
            finish(success?Activity.RESULT_OK:Activity.RESULT_CANCELED,result);
        }
    }
}
