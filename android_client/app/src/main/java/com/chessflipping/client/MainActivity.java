package com.chessflipping.client;
import android.app.Activity;
import android.content.*;
import android.os.*;
import android.view.*;
import android.widget.FrameLayout;

public final class MainActivity extends Activity {
    private GameService service;private FrameLayout content;private boolean resumed,fullscreen;private int previousBarsBehavior,previousOrientation;
    private android.window.OnBackInvokedCallback fullscreenBack;
    private final ServiceConnection binding=new ServiceConnection(){
        @Override public void onServiceConnected(ComponentName name,IBinder binder){
            service=((GameService.LocalBinder)binder).service();
            service.attachWeb(MainActivity.this,content);
            if(resumed)service.foreground();
        }
        @Override public void onServiceDisconnected(ComponentName name){service=null;}
    };
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        content=new FrameLayout(this);setContentView(content);
        content.setOnApplyWindowInsetsListener((view,insets)->{
            if(Build.VERSION.SDK_INT>=30){android.graphics.Insets bar=insets.getInsets((fullscreen?0:WindowInsets.Type.systemBars())|WindowInsets.Type.displayCutout());view.setPadding(bar.left,bar.top,bar.right,bar.bottom);}
            else if(fullscreen)view.setPadding(0,0,0,0);else view.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());
            return insets;
        });
        Intent intent=new Intent(this,GameService.class);startService(intent);bindService(intent,binding,BIND_AUTO_CREATE);
        if(Build.VERSION.SDK_INT>=37)requestPermissions(new String[]{"android.permission.ACCESS_LOCAL_NETWORK"},1);
        if(Build.VERSION.SDK_INT>=33){fullscreenBack=()->{if(service!=null)service.back();};getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0,fullscreenBack);}
    }
    void fullscreen(boolean value){fullscreen(value,false);}
    void fullscreen(boolean value,boolean landscape){
        if(value&&!fullscreen){previousOrientation=getRequestedOrientation();if(landscape)setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);}
        if(!value&&fullscreen)setRequestedOrientation(previousOrientation);
        fullscreen=value;
        if(Build.VERSION.SDK_INT>=33){getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(fullscreenBack);getOnBackInvokedDispatcher().registerOnBackInvokedCallback(value?android.window.OnBackInvokedDispatcher.PRIORITY_OVERLAY:android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,fullscreenBack);}
        if(value)getSystemService(android.view.inputmethod.InputMethodManager.class).hideSoftInputFromWindow(content.getWindowToken(),0);
        if(Build.VERSION.SDK_INT>=30){WindowInsetsController bars=getWindow().getInsetsController();if(bars!=null){if(value){previousBarsBehavior=bars.getSystemBarsBehavior();bars.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);bars.hide(WindowInsets.Type.systemBars()|WindowInsets.Type.ime());}else{bars.setSystemBarsBehavior(previousBarsBehavior);bars.show(WindowInsets.Type.systemBars());}}}
        else getWindow().getDecorView().setSystemUiVisibility(value?View.SYSTEM_UI_FLAG_FULLSCREEN|View.SYSTEM_UI_FLAG_HIDE_NAVIGATION|View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY:View.SYSTEM_UI_FLAG_VISIBLE);
        content.requestApplyInsets();
    }
    @Override protected void onResume(){super.onResume();resumed=true;if(service!=null){service.foreground();if(service.updater.installPending&&getPackageManager().canRequestPackageInstalls())service.install();}}
    @Override public void onConfigurationChanged(android.content.res.Configuration configuration){super.onConfigurationChanged(configuration);content.requestApplyInsets();}
    @Override protected void onStop(){resumed=false;if(service!=null&&!isChangingConfigurations())service.background();super.onStop();}
    @Override public boolean dispatchKeyEvent(KeyEvent event){
        if(event.getKeyCode()==KeyEvent.KEYCODE_BACK&&service!=null&&service.isFullscreen()){if(event.getAction()==KeyEvent.ACTION_UP)service.back();return true;}
        return super.dispatchKeyEvent(event);
    }
    public void requestMicrophone(){requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO},2);}
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){super.onRequestPermissionsResult(request,permissions,results);if(request==2&&service!=null)service.microphonePermission(results.length>0&&results[0]==android.content.pm.PackageManager.PERMISSION_GRANTED);}
    // API 33+ uses OnBackInvokedCallback above; this override is only the older-system fallback.
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed(){if(service!=null)service.back();else super.onBackPressed();}
    @Override protected void onDestroy(){if(service!=null)service.detachWeb(this);unbindService(binding);super.onDestroy();}
}
