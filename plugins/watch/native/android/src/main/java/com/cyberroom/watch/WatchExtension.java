package com.cyberroom.watch.v102;

import android.content.Context;
import android.content.pm.PackageManager;
import android.os.*;
import android.widget.FrameLayout;
import com.cyberroom.sdk.NativeExtension;
import com.chessflipping.client.MediaController;
import com.chessflipping.client.VoiceEngine;
import org.json.*;

public final class WatchExtension implements NativeExtension {
    private Host host;private Context context;private VoiceEngine voice;private MediaController media;
    private boolean foreground,pendingMicrophone;private volatile boolean closed;
    @Override public void initialize(Context context,Host host){
        this.host=host;this.context=context;
        media=new MediaController(context,this::event,()->{if(voice!=null)voice.microphone(false);event(value("audioFocusLost"));});
        voice=new VoiceEngine(context,this::event,host,media::active,()->{new Handler(Looper.getMainLooper()).post(()->{if(!closed){media.foreground(false);media.foreground(foreground);}});event(value("audioFocusLost"));});
    }
    private static JSONObject value(String type){try{return new JSONObject().put("type",type);}catch(JSONException e){throw new IllegalStateException(e);}}
    private void event(JSONObject event){if(closed)return;if("voiceStatus".equals(event.optString("type")))new Handler(Looper.getMainLooper()).post(()->{if(!closed)media.voiceMode(event.optBoolean("microphone"));});host.event(event);}
    @Override public void attach(FrameLayout parent){media.attach(parent);}
    @Override public void detach(){media.detach();}
    @Override public void foreground(boolean value){foreground=value;if(!value)pendingMicrophone=false;voice.foreground(value);media.foreground(value);}
    @Override public void permission(String name,boolean granted){boolean requested=pendingMicrophone;pendingMicrophone=false;if(!closed&&granted&&requested&&foreground)voice.microphone(true);else if(!granted&&requested)voice.report("麦克风权限未允许，仍可观看和发弹幕");}
    @Override public Object call(String method,JSONArray args,JSONObject scope)throws Exception{
        if(closed)throw new IllegalStateException("组件已关闭");
        switch(method){
            case "voiceConfigure": {JSONObject q=new JSONObject(args.getString(0));if(!voice.roomId().equals(q.optString("roomId")))pendingMicrophone=false;voice.configure(q);break;}
            case "voiceMicrophone": {
                boolean open=args.getBoolean(0);pendingMicrophone=false;
                if(!open)voice.microphone(false);
                else if(foreground){if(context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED)voice.microphone(true);else{pendingMicrophone=true;host.permission(android.Manifest.permission.RECORD_AUDIO);}}break;
            }
            case "voiceStop": pendingMicrophone=false;voice.stop();break;
            case "mediaConfigure": media.configure(new JSONObject(args.getString(0)));break;
            case "mediaRequest": media.request(new JSONObject(args.getString(0)));break;
            case "playerCommand": {JSONObject command=new JSONObject(args.getString(0)),bounds=command.optJSONObject("bounds"),viewport=scope==null?null:scope.optJSONObject("viewport");if(bounds!=null&&viewport!=null){bounds.put("x",bounds.optDouble("x")+viewport.optDouble("x"));bounds.put("y",bounds.optDouble("y")+viewport.optDouble("y"));}media.command(command);break;}
            case "playerStop": media.stop();break;
            default: throw new IllegalArgumentException("组件没有此接口");
        }
        return true;
    }
    @Override public boolean receive(String peer,Packet packet){return !closed&&voice.receive(peer,packet);}
    @Override public void close(){closed=true;pendingMicrophone=false;voice.close();media.close();}
}
