package com.chessflipping.client;

import android.content.Context;
import android.graphics.*;
import android.os.*;
import android.view.*;
import android.widget.FrameLayout;
import androidx.media3.common.*;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.ExoPlaybackException;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo;
import androidx.media3.exoplayer.mediacodec.MediaCodecDecoderException;
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import okhttp3.*;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.function.Consumer;

/** Only the local application bridge can configure an Emby origin; remote pages never get the bridge. */
@androidx.annotation.OptIn(markerClass=androidx.media3.common.util.UnstableApi.class)
public final class MediaController implements AutoCloseable {
    private final Context context;private final Handler main=new Handler(Looper.getMainLooper());private final Consumer<JSONObject> events;
    private final MediaRequests requests;
    private ExoPlayer player;private FrameLayout container,parent;private TextureView video;private Danmaku danmaku;
    private final android.media.AudioManager audio;private final android.media.AudioFocusRequest focus;private final Runnable interrupted;private volatile boolean hasMedia,ownsFocus;
    private String currentUrl="";private volatile boolean foreground=true;private boolean visible;private int x,y,width=1,height=1;
    private boolean softwareDecoder,fallbackTried,recovering,renderedFirstFrame;private String failedDecoder="",playbackError="",videoMime="";
    public MediaController(Context context,Consumer<JSONObject> events,Runnable interrupted){
        this.context=context;this.events=events;this.interrupted=interrupted;audio=context.getSystemService(android.media.AudioManager.class);
        focus=new android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).build()).setOnAudioFocusChangeListener(change->{ownsFocus=change>0;if(change<0){if(player!=null)player.pause();interrupted.run();}}).build();
        requests=new MediaRequests(task->main.post(task),events);
        main.post(new Runnable(){public void run(){if(closed)return;state();main.postDelayed(this,500);}});
    }
    private volatile boolean closed;
    private boolean allowed(HttpUrl url){return requests.allowed(url);}
    public void configure(JSONObject config){
        requests.configure(config.optString("origin"));stop();
    }
    public void request(JSONObject q){requests.request(q);}
    public void attach(FrameLayout parent){this.parent=parent;if(container!=null){if(container.getParent() instanceof ViewGroup)((ViewGroup)container.getParent()).removeView(container);parent.addView(container,layout());}}
    public void detach(){if(container!=null&&container.getParent() instanceof ViewGroup)((ViewGroup)container.getParent()).removeView(container);parent=null;}
    private FrameLayout.LayoutParams layout(){FrameLayout.LayoutParams p=new FrameLayout.LayoutParams(width,height);p.leftMargin=x;p.topMargin=y;return p;}
    private void ensureOverlay(){
        if(container==null){
            container=new FrameLayout(context);container.setClipChildren(true);container.setBackgroundColor(Color.BLACK);
            video=new TextureView(context);container.addView(video,new FrameLayout.LayoutParams(-1,-1));danmaku=new Danmaku(context);container.addView(danmaku,new FrameLayout.LayoutParams(-1,-1));
            if(parent!=null)parent.addView(container,layout());
        }
    }
    private void ensure(){
        if(player!=null)return;
        ensureOverlay();
        DefaultRenderersFactory renderers=new DefaultRenderersFactory(context).setEnableDecoderFallback(true);
        if(softwareDecoder){
            // Initialization fallback alone does not recover a decoder which fails after starting.
            renderers.setMediaCodecSelector((mime,secure,tunneling)->{
                List<MediaCodecInfo> available=MediaCodecSelector.DEFAULT.getDecoderInfos(mime,secure,tunneling);
                if(!MimeTypes.isVideo(mime))return available;
                List<MediaCodecInfo> software=new ArrayList<>();for(MediaCodecInfo codec:available)if(codec.softwareOnly&&!codec.name.equals(failedDecoder))software.add(codec);return software;
            }).forceDisableMediaCodecAsynchronousQueueing();
        }
        player=new ExoPlayer.Builder(context,renderers).setMediaSourceFactory(new DefaultMediaSourceFactory(new OkHttpDataSource.Factory(requests.playbackCalls()))).build();
        ExoPlayer owner=player;
        player.setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),false);
        player.addListener(new Player.Listener(){
            @Override public void onPlayerError(PlaybackException error){if(owner!=player)return;if(!recoverDecoder(owner,error))emitError("电影暂时无法播放，请检查片源授权或切换兼容画质");}
            @Override public void onPlaybackStateChanged(int value){if(owner==player)state();}
            @Override public void onPlayWhenReadyChanged(boolean ready,int reason){if(owner==player&&container!=null)container.setKeepScreenOn(ready&&foreground);}
            @Override public void onVideoSizeChanged(VideoSize size){if(owner==player)resizeVideo(size);}
            @Override public void onTracksChanged(Tracks tracks){
                if(owner!=player)return;
                for(Tracks.Group group:tracks.getGroups())if(group.getType()==C.TRACK_TYPE_VIDEO)for(int i=0;i<group.length;i++)if(group.isTrackSelected(i)){
                    String mime=group.getTrackFormat(i).sampleMimeType;if(mime!=null&&MimeTypes.isVideo(mime)){videoMime=mime;return;}
                }
            }
            @Override public void onRenderedFirstFrame(){if(owner!=player)return;renderedFirstFrame=true;recovering=false;playbackError="";state();}
        });
        // ExoPlayer owns the TextureView listener and surface. Do not install a second listener
        // or release its SurfaceTexture when Activity recreation detaches and reattaches the view.
        player.setVideoTextureView(video);
    }
    private boolean recoverDecoder(ExoPlayer owner,PlaybackException failure){
        if(fallbackTried||recovering||softwareDecoder||currentUrl.isEmpty()||!(failure instanceof ExoPlaybackException))return false;
        ExoPlaybackException playback=(ExoPlaybackException)failure;
        Format format=playback.rendererFormat!=null?playback.rendererFormat:owner.getVideoFormat();
        String mime=format==null?videoMime:format.sampleMimeType;
        boolean videoRenderer=playback.type==ExoPlaybackException.TYPE_RENDERER&&playback.rendererFormat!=null&&MimeTypes.isVideo(playback.rendererFormat.sampleMimeType);
        boolean decoderFailure=videoRenderer&&(failure.errorCode==PlaybackException.ERROR_CODE_DECODER_INIT_FAILED||failure.errorCode==PlaybackException.ERROR_CODE_DECODING_FAILED);
        boolean platformCodecFailure=false,videoCodecStack=false;
        Set<Throwable> visited=Collections.newSetFromMap(new IdentityHashMap<>());
        // Some MediaCodec.flush failures are wrapped as TYPE_UNEXPECTED and have no rendererFormat.
        // Only a real codec exception with video-renderer evidence may enter this recovery path.
        for(Throwable cause=failure;cause!=null&&visited.size()<32&&visited.add(cause);cause=cause.getCause()){
            if(cause instanceof MediaCodecDecoderException){
                MediaCodecInfo codec=((MediaCodecDecoderException)cause).codecInfo;
                if(codec!=null&&MimeTypes.isVideo(codec.mimeType)){failedDecoder=codec.name;mime=codec.mimeType;decoderFailure=true;}
            }
            if(cause instanceof android.media.MediaCodec.CodecException)platformCodecFailure=true;
            StackTraceElement[] frames=cause.getStackTrace();
            for(int i=0;i<Math.min(frames.length,96);i++)if(frames[i].getClassName().startsWith("androidx.media3.exoplayer.video.")){videoCodecStack=true;break;}
        }
        if(mime==null||!MimeTypes.isVideo(mime)||!(decoderFailure||(platformCodecFailure&&(videoRenderer||videoCodecStack))))return false;
        try{boolean available=false;for(MediaCodecInfo codec:MediaCodecSelector.DEFAULT.getDecoderInfos(mime,false,false))if(codec.softwareOnly&&!codec.name.equals(failedDecoder)){available=true;break;}if(!available)return false;}
        catch(Exception error){return false;}
        fallbackTried=true;recovering=true;renderedFirstFrame=false;playbackError="";String url=currentUrl;state();
        main.post(()->{
            if(player!=owner||!url.equals(currentUrl)||closed)return;
            long position=Math.max(0,owner.getCurrentPosition());boolean play=owner.getPlayWhenReady()&&foreground;
            float volume=owner.getVolume();PlaybackParameters speed=owner.getPlaybackParameters();AudioAttributes attributes=owner.getAudioAttributes();
            // Keep the existing view and overlay, but release the failed decoder and its surface
            // binding before creating the one permitted software retry.
            player=null;owner.clearVideoTextureView(video);owner.release();softwareDecoder=true;
            try{
                ensure();player.setAudioAttributes(attributes,false);player.setVolume(volume);player.setPlaybackParameters(speed);
                player.setMediaItem(MediaItem.fromUri(url),position);player.prepare();player.setPlayWhenReady(play);state();
            }catch(Exception error){recovering=false;emitError("软件解码也无法播放此片源，请切换兼容画质");}
        });
        return true;
    }
    private void resizeVideo(VideoSize size){if(video==null||size.width<=0||size.height<=0)return;float aspect=(size.width*size.pixelWidthHeightRatio)/size.height,box=width/(float)height;Matrix transform=new Matrix();if(box>aspect)transform.setScale(aspect/box,1,width/2f,height/2f);else transform.setScale(1,box/aspect,width/2f,height/2f);video.setTransform(transform);}
    public void command(JSONObject q){
        if(closed)return;
        try{
            // Room chat remains visible before a source or a player exists.
            JSONObject bounds=q.optJSONObject("bounds");
            if(bounds!=null){ensureOverlay();float density=context.getResources().getDisplayMetrics().density;x=Math.max(0,Math.round((float)bounds.optDouble("x")*density));y=Math.max(0,Math.round((float)bounds.optDouble("y")*density));width=Math.max(1,Math.round((float)bounds.optDouble("width",1)*density));height=Math.max(1,Math.round((float)bounds.optDouble("height",1)*density));container.setLayoutParams(layout());if(player!=null)resizeVideo(player.getVideoSize());}
            JSONObject bullet=q.optJSONObject("danmaku");if(bullet!=null&&danmaku!=null)danmaku.add(bullet.optString("id"),bullet.optString("text"));
            if(q.has("visible")){visible=q.optBoolean("visible");if(container!=null)container.setVisibility(visible&&foreground?View.VISIBLE:View.GONE);}
            boolean hasPlayback=q.has("url")||q.has("positionMs")||q.has("playing");if(!hasPlayback)return;
            if(!q.has("url")&&currentUrl.isEmpty())return;
            String url=q.optString("url",currentUrl);HttpUrl parsed=HttpUrl.parse(url);if(parsed==null||!allowed(parsed))throw new IOException("未授权的电影地址");
            ensure();if(bounds!=null)resizeVideo(player.getVideoSize());
            visible=q.optBoolean("visible",visible);container.setVisibility(visible&&foreground?View.VISIBLE:View.GONE);
            if(!url.equals(currentUrl)){currentUrl=url;hasMedia=true;renderedFirstFrame=false;recovering=false;playbackError="";videoMime="";player.setMediaItem(MediaItem.fromUri(url));player.prepare();}
            if(q.has("positionMs")){long position=Math.max(0,q.optLong("positionMs"));if(Math.abs(player.getCurrentPosition()-position)>250)player.seekTo(position);}
            if(q.has("rate"))player.setPlaybackSpeed((float)Math.max(0.5,Math.min(2,q.optDouble("rate",1))));
            if(q.has("volume"))player.setVolume((float)Math.max(0,Math.min(1,q.optDouble("volume",1))));
            if(q.has("playing")){boolean play=foreground&&q.optBoolean("playing");if(play){ownsFocus=audio.requestAudioFocus(focus)==android.media.AudioManager.AUDIOFOCUS_REQUEST_GRANTED;if(!ownsFocus){emitError("其他应用正在使用音频，请稍后继续观影");play=false;}}player.setPlayWhenReady(play);}
        }catch(Exception error){emitError("电影地址或播放参数无效，请重新选择片源");}
    }
    private void state(){if(player==null)return;try{events.accept(new JSONObject().put("type","player").put("positionMs",player.getCurrentPosition()).put("durationMs",Math.max(0,player.getDuration())).put("playing",player.isPlaying()).put("buffering",recovering||player.getPlaybackState()==Player.STATE_BUFFERING).put("ended",player.getPlaybackState()==Player.STATE_ENDED).put("renderedFirstFrame",renderedFirstFrame).put("decoderFallback",softwareDecoder).put("recovering",recovering).put("error",playbackError));}catch(JSONException ignored){}}
    private void emitError(String text){playbackError=text;recovering=false;try{events.accept(new JSONObject().put("type","player").put("error",text).put("playing",false).put("renderedFirstFrame",renderedFirstFrame).put("decoderFallback",softwareDecoder).put("recovering",false));}catch(JSONException ignored){}}
    public void foreground(boolean value){foreground=value;if(!value){if(player!=null)player.pause();ownsFocus=false;audio.abandonAudioFocusRequest(focus);}if(container!=null){container.setVisibility(value&&visible?View.VISIBLE:View.GONE);container.setKeepScreenOn(value&&player!=null&&player.getPlayWhenReady());}}
    public boolean active(){return hasMedia&&ownsFocus;}
    public void voiceMode(boolean microphone){if(player!=null)player.setAudioAttributes(new AudioAttributes.Builder().setUsage(microphone?C.USAGE_VOICE_COMMUNICATION:C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),false);}
    public void stop(){requests.invalidate();hasMedia=false;ownsFocus=false;audio.abandonAudioFocusRequest(focus);if(player!=null){ExoPlayer old=player;player=null;old.clearVideoTextureView(video);old.release();}if(container!=null&&container.getParent() instanceof ViewGroup)((ViewGroup)container.getParent()).removeView(container);container=null;video=null;danmaku=null;currentUrl="";softwareDecoder=false;fallbackTried=false;recovering=false;renderedFirstFrame=false;playbackError="";failedDecoder="";videoMime="";}
    @Override public void close(){closed=true;stop();requests.close();main.removeCallbacksAndMessages(null);}
    private static final class Danmaku extends View {
        final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);final List<Bullet> bullets=new ArrayList<>();final Set<String> ids=new LinkedHashSet<>();
        static class Bullet{String text;long start;int lane;float width;}
        Danmaku(Context context){super(context);setLayerType(View.LAYER_TYPE_SOFTWARE,null);paint.setColor(Color.WHITE);paint.setTextSize(17*getResources().getDisplayMetrics().scaledDensity);paint.setShadowLayer(3,1,1,Color.BLACK);}
        void add(String id,String text){if(text.isEmpty()||text.length()>256||ids.contains(id))return;ids.add(id);if(ids.size()>128)ids.remove(ids.iterator().next());if(bullets.size()>=12)bullets.remove(0);Bullet bullet=new Bullet();bullet.text=text;bullet.start=SystemClock.uptimeMillis();bullet.lane=bullets.size()%4;bullet.width=paint.measureText(text);bullets.add(bullet);invalidate();}
        @Override protected void onDraw(Canvas canvas){super.onDraw(canvas);long now=SystemClock.uptimeMillis();Iterator<Bullet> items=bullets.iterator();while(items.hasNext()){Bullet bullet=items.next();float progress=(now-bullet.start)/6000f;if(progress>=1){items.remove();continue;}canvas.drawText(bullet.text,getWidth()-(getWidth()+bullet.width)*progress,(bullet.lane+1)*(paint.getTextSize()+8),paint);}if(!bullets.isEmpty())postInvalidateOnAnimation();}
    }
}
