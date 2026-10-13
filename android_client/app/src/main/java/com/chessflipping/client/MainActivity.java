package com.chessflipping.client;
import android.app.Activity;
import android.content.*;
import android.os.*;
import android.view.*;
import android.widget.FrameLayout;
import androidx.core.content.ContextCompat;

public final class MainActivity extends Activity {
    private GameService service;private FrameLayout content;
    private final ServiceConnection binding=new ServiceConnection(){
        @Override public void onServiceConnected(ComponentName name,IBinder binder){
            service=((GameService.LocalBinder)binder).service();
            service.attachWeb(MainActivity.this,content);
        }
        @Override public void onServiceDisconnected(ComponentName name){service=null;}
    };
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        content=new FrameLayout(this);setContentView(content);
        content.setOnApplyWindowInsetsListener((view,insets)->{
            if(Build.VERSION.SDK_INT>=30){android.graphics.Insets bar=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout());view.setPadding(bar.left,bar.top,bar.right,bar.bottom);}
            else view.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());
            return insets;
        });
        Intent intent=new Intent(this,GameService.class);ContextCompat.startForegroundService(this,intent);bindService(intent,binding,BIND_AUTO_CREATE);
        if(Build.VERSION.SDK_INT>=33){
            java.util.ArrayList<String> permissions=new java.util.ArrayList<>();permissions.add(android.Manifest.permission.POST_NOTIFICATIONS);
            if(Build.VERSION.SDK_INT>=37)permissions.add("android.permission.ACCESS_LOCAL_NETWORK");
            requestPermissions(permissions.toArray(new String[0]),1);
        }
        if(Build.VERSION.SDK_INT>=33)getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0,()->{if(service!=null)service.web.evaluateJavascript("window.cyberBack && window.cyberBack()",null);});
    }
    @Override protected void onResume(){super.onResume();if(service!=null&&service.updater.installPending&&getPackageManager().canRequestPackageInstalls())service.install();}
    @Override protected void onStop(){if(service!=null)service.background();super.onStop();}
    // API 33+ uses OnBackInvokedCallback above; this override is only the older-system fallback.
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed(){if(service!=null)service.web.evaluateJavascript("window.cyberBack && window.cyberBack()",null);else super.onBackPressed();}
    @Override protected void onDestroy(){if(service!=null)service.detachWeb(this);unbindService(binding);super.onDestroy();}
}
