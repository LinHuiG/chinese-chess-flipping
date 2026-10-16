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
import androidx.media3.exoplayer.DecoderCounters;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.exoplayer.audio.TeeAudioProcessor;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.text.Cue;
import androidx.media3.ui.SubtitleView;
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo;
import androidx.media3.exoplayer.mediacodec.MediaCodecDecoderException;
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import okhttp3.*;
import org.json.*;
import java.io.*;
import java.nio.*;
import java.util.*;
import java.util.function.Consumer;

/** Only the local application bridge can configure an Emby origin; remote pages never get the bridge. */
@androidx.annotation.OptIn(markerClass=androidx.media3.common.util.UnstableApi.class)
public final class MediaController implements AutoCloseable {
    private final Context context;private final Handler main=new Handler(Looper.getMainLooper());private final Consumer<JSONObject> events;
    private final MediaRequests requests;
    private ExoPlayer player;private FrameLayout container,parent;private TextureView video;private Danmaku danmaku;private SubtitleView subtitleView;
    private SubtitleTimeline subtitleTimeline=SubtitleTimeline.EMPTY;private double subtitleOffsetMs;private List<String> shownSubtitles=Collections.emptyList();
    private final android.media.AudioManager audio;private final android.media.AudioFocusRequest focus;private final Runnable interrupted;private volatile boolean hasMedia,ownsFocus;
    private String currentUrl="";private volatile boolean foreground=true;private boolean visible;private int x,y,width=1,height=1;
    private boolean softwareDecoder,fallbackTried,recovering,renderedFirstFrame;private String failedDecoder="",playbackError="",videoMime="";
    private float volume=1,rate=1;private boolean muted,communicationAudio,audioOutputAdvancing;private int playbackErrorCode;
    private AudioProbe audioProbe;
    private String playbackId="",seekId="";private boolean applyingCommand;
    public MediaController(Context context,Consumer<JSONObject> events,Runnable interrupted){
        this.context=context;this.events=events;this.interrupted=interrupted;audio=context.getSystemService(android.media.AudioManager.class);
        focus=new android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).build()).setOnAudioFocusChangeListener(change->{ownsFocus=change>0;if(change<0){if(player!=null)player.pause();interrupted.run();}}).build();
        requests=new MediaRequests(task->main.post(task),events);
        main.post(new Runnable(){long reported;public void run(){if(closed)return;updateSubtitles();long now=SystemClock.elapsedRealtime();if(now-reported>=500){reported=now;state();}main.postDelayed(this,100);}});
    }
    private volatile boolean closed;
    private boolean allowed(HttpUrl url){return requests.allowed(url);}
    public void configure(JSONObject config){
        requests.configure(config.optString("origin"));stop();
    }
    public void request(JSONObject q){requests.request(q);}
    public void attach(FrameLayout parent){this.parent=parent;parent.setClipChildren(true);parent.setClipToPadding(true);if(container!=null){if(container.getParent() instanceof ViewGroup)((ViewGroup)container.getParent()).removeView(container);parent.addView(container,layout());}}
    public void detach(){if(container!=null&&container.getParent() instanceof ViewGroup)((ViewGroup)container.getParent()).removeView(container);parent=null;}
    private FrameLayout.LayoutParams layout(){FrameLayout.LayoutParams p=new FrameLayout.LayoutParams(width,height);p.leftMargin=x;p.topMargin=y;return p;}
    private void ensureOverlay(){
        if(container==null){
            container=new FrameLayout(context){@Override public boolean dispatchTouchEvent(android.view.MotionEvent e){android.graphics.Rect clip=getClipBounds();if(clip!=null&&!clip.contains((int)e.getX(),(int)e.getY()))return false;return super.dispatchTouchEvent(e);}};container.setClipChildren(true);
            container.setOnTouchListener((v,e)->{if(e.getActionMasked()==android.view.MotionEvent.ACTION_UP){try{events.accept(new JSONObject().put("type","playerInteraction"));}catch(JSONException ignored){}}return true;});container.setBackgroundColor(Color.BLACK);
            video=new TextureView(context);container.addView(video,new FrameLayout.LayoutParams(-1,-1));subtitleView=new SubtitleView(context);subtitleView.setFractionalTextSize(.05f);container.addView(subtitleView,new FrameLayout.LayoutParams(-1,-1));danmaku=new Danmaku(context);container.addView(danmaku,new FrameLayout.LayoutParams(-1,-1));
            if(parent!=null)parent.addView(container,layout());
        }
    }
    private void ensure(){
        if(player!=null)return;
        ensureOverlay();
        // Debug acceptance can verify non-silent decoded samples. Release builds retain
        // the ordinary sink and do not copy PCM merely for diagnostics.
        AudioProbe probe=(context.getApplicationInfo().flags&android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)!=0?new AudioProbe():null;audioProbe=probe;
        DefaultRenderersFactory renderers=new DefaultRenderersFactory(context){
            @Override protected AudioSink buildAudioSink(Context context,boolean floating,boolean parameters){
                if(probe==null)return super.buildAudioSink(context,floating,parameters);
                return new DefaultAudioSink.Builder(context).setEnableFloatOutput(floating).setEnableAudioTrackPlaybackParams(parameters).setAudioProcessors(new AudioProcessor[]{new TeeAudioProcessor(probe)}).build();
            }
        }.setEnableDecoderFallback(true);
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
        player.setAudioAttributes(movieAttributes(),false);player.setVolume(muted?0:volume);player.setPlaybackSpeed(rate);
        player.addAnalyticsListener(new AnalyticsListener(){
            @Override public void onAudioPositionAdvancing(EventTime time,long started){if(owner==player){audioOutputAdvancing=true;state();}}
            @Override public void onAudioDisabled(EventTime time,DecoderCounters counters){if(owner==player)audioOutputAdvancing=false;}
        });
        player.addListener(new Player.Listener(){
            @Override public void onPlayerError(PlaybackException error){if(owner!=player)return;if(!recoverDecoder(owner,error)){playbackErrorCode=error.errorCode;emitError("电影暂时无法播放，请检查片源授权或切换兼容画质");}}
            @Override public void onPlaybackStateChanged(int value){if(owner==player)state();}
            @Override public void onPlayWhenReadyChanged(boolean ready,int reason){if(owner==player&&container!=null)container.setKeepScreenOn(ready&&foreground);}
            @Override public void onVideoSizeChanged(VideoSize size){if(owner==player)resizeVideo(size);}
            @Override public void onTracksChanged(Tracks tracks){
                if(owner!=player)return;
                for(Tracks.Group group:tracks.getGroups())if(group.getType()==C.TRACK_TYPE_VIDEO)for(int i=0;i<group.length;i++)if(group.isTrackSelected(i)){
                    String mime=group.getTrackFormat(i).sampleMimeType;if(mime!=null&&MimeTypes.isVideo(mime)){videoMime=mime;return;}
                }
            }
            @Override public void onRenderedFirstFrame(){if(owner!=player)return;renderedFirstFrame=true;recovering=false;playbackError="";playbackErrorCode=0;state();}
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
        applyingCommand=true;
        try{
            // Room chat remains visible before a source or a player exists.
            JSONObject bounds=q.optJSONObject("bounds");
            // DOM viewport coordinates become negative while scrolling. Preserve them:
            // the host clips the offscreen portion instead of pinning the video to its top.
            if(bounds!=null){ensureOverlay();float density=context.getResources().getDisplayMetrics().density;x=Math.round((float)bounds.optDouble("x")*density);y=Math.round((float)bounds.optDouble("y")*density);width=Math.max(1,Math.round((float)bounds.optDouble("width",1)*density));height=Math.max(1,Math.round((float)bounds.optDouble("height",1)*density));container.setLayoutParams(layout());int clip=Math.max(0,Math.min(height,Math.round((float)bounds.optDouble("clipHeight",bounds.optDouble("height",1))*density)));container.setClipBounds(new android.graphics.Rect(0,0,width,clip));if(player!=null)resizeVideo(player.getVideoSize());}
            JSONObject bullet=q.optJSONObject("danmaku");if(bullet!=null&&danmaku!=null)danmaku.add(bullet.optString("id"),bullet.optString("text"));
            if(q.has("subtitleCues")){subtitleTimeline=SubtitleTimeline.parse(q.getJSONArray("subtitleCues"));}
            if(q.has("subtitleOffsetMs")){double offset=q.getDouble("subtitleOffsetMs");if(!Double.isFinite(offset)||offset<0)throw new IllegalArgumentException("Invalid subtitle offset");subtitleOffsetMs=offset;}
            if(q.has("subtitleCues")||q.has("subtitleOffsetMs"))updateSubtitles();
            if(q.has("visible")){visible=q.optBoolean("visible");if(container!=null)container.setVisibility(visible&&foreground?View.VISIBLE:View.GONE);}
            if(q.has("rate"))rate=(float)Math.max(0.5,Math.min(2,q.optDouble("rate",1)));
            if(q.has("volume"))volume=(float)Math.max(0,Math.min(1,q.optDouble("volume",1)));
            if(q.has("muted"))muted=q.optBoolean("muted");
            boolean hasPlayback=q.has("url")||q.has("positionMs")||q.has("playing")||q.has("rate")||q.has("volume")||q.has("muted");if(!hasPlayback)return;
            if(!q.has("url")&&currentUrl.isEmpty())return;
            String url=q.optString("url",currentUrl);HttpUrl parsed=HttpUrl.parse(url);if(parsed==null||!allowed(parsed))throw new IOException("未授权的电影地址");
            if(q.has("url")){playbackId=q.optString("playbackId");seekId="";}
            if(q.has("positionMs"))seekId=q.optString("seekId");
            ensure();if(bounds!=null)resizeVideo(player.getVideoSize());
            visible=q.optBoolean("visible",visible);container.setVisibility(visible&&foreground?View.VISIBLE:View.GONE);
            if(!url.equals(currentUrl)){currentUrl=url;hasMedia=true;renderedFirstFrame=false;audioOutputAdvancing=false;recovering=false;playbackError="";playbackErrorCode=0;videoMime="";player.setMediaItem(MediaItem.fromUri(url));player.prepare();}
            if(q.has("positionMs")){long position=Math.max(0,q.optLong("positionMs"));if(Math.abs(player.getCurrentPosition()-position)>250)player.seekTo(position);}
            if(q.has("rate"))player.setPlaybackSpeed(rate);
            if(q.has("volume")||q.has("muted"))player.setVolume(muted?0:volume);
            if(q.has("playing")){boolean play=foreground&&q.optBoolean("playing");if(play&&!ownsFocus){ownsFocus=audio.requestAudioFocus(focus)==android.media.AudioManager.AUDIOFOCUS_REQUEST_GRANTED;if(!ownsFocus){emitError("其他应用正在使用音频，请稍后继续观影");play=false;}}player.setPlayWhenReady(play);}
        }catch(Exception error){emitError("电影地址或播放参数无效，请重新选择片源");}
        finally{applyingCommand=false;}
    }
    private void state(){if(player==null||applyingCommand)return;try{
        boolean audioPresent=false,audioSupported=false,audioSelected=false;for(Tracks.Group group:player.getCurrentTracks().getGroups())if(group.getType()==C.TRACK_TYPE_AUDIO){audioPresent=true;for(int i=0;i<group.length;i++){audioSupported|=group.isTrackSupported(i);audioSelected|=group.isTrackSelected(i);}}
        Format format=player.getAudioFormat();DecoderCounters counters=player.getAudioDecoderCounters();if(counters!=null)counters.ensureUpdated();
        JSONObject event=new JSONObject().put("type","player").put("positionMs",player.getCurrentPosition()).put("durationMs",Math.max(0,player.getDuration())).put("playing",player.isPlaying()).put("buffering",recovering||player.getPlaybackState()==Player.STATE_BUFFERING).put("ended",player.getPlaybackState()==Player.STATE_ENDED).put("renderedFirstFrame",renderedFirstFrame).put("decoderFallback",softwareDecoder).put("recovering",recovering).put("error",playbackError).put("errorCode",playbackErrorCode)
            .put("rate",player.getPlaybackParameters().speed).put("volume",volume).put("muted",muted).put("subtitleCues",shownSubtitles.size()).put("audioPresent",audioPresent).put("audioSupported",audioSupported).put("audioSelected",audioSelected).put("audioMime",format==null?"":format.sampleMimeType).put("audioChannels",format==null?0:Math.max(0,format.channelCount)).put("audioSampleRate",format==null?0:Math.max(0,format.sampleRate)).put("audioOutputAdvancing",audioOutputAdvancing&&player.isPlaying()).put("audioRenderedBuffers",counters==null?0:counters.renderedOutputBufferCount);
        event.put("playbackId",playbackId).put("seekId",seekId).put("seeking",player.getPlaybackState()==Player.STATE_BUFFERING||player.getPlaybackState()==Player.STATE_IDLE);
        if(audioProbe!=null)event.put("audioPcmFrames",audioProbe.frames).put("audioPcmPeak",audioProbe.peak);events.accept(event);
    }catch(JSONException ignored){}}
    private void emitError(String text){playbackError=text;recovering=false;try{events.accept(new JSONObject().put("type","player").put("playbackId",playbackId).put("seekId",seekId).put("error",text).put("errorCode",playbackErrorCode).put("playing",false).put("renderedFirstFrame",renderedFirstFrame).put("decoderFallback",softwareDecoder).put("recovering",false));}catch(JSONException ignored){}}
    public void foreground(boolean value){foreground=value;if(!value){if(player!=null)player.pause();ownsFocus=false;audio.abandonAudioFocusRequest(focus);}if(container!=null){container.setVisibility(value&&visible?View.VISIBLE:View.GONE);container.setKeepScreenOn(value&&player!=null&&player.getPlayWhenReady());}}
    public boolean active(){return hasMedia&&ownsFocus;}
    private void updateSubtitles(){
        List<String> active=player==null?Collections.emptyList():subtitleTimeline.active((player.getCurrentPosition()+subtitleOffsetMs)/1000.0);if(active.equals(shownSubtitles))return;shownSubtitles=active;
        if(subtitleView!=null){List<Cue> cues=new ArrayList<>();if(!active.isEmpty())cues.add(new Cue.Builder().setText(String.join("\n",active)).build());subtitleView.setCues(cues);}
    }
    private AudioAttributes movieAttributes(){return new AudioAttributes.Builder().setUsage(communicationAudio?C.USAGE_VOICE_COMMUNICATION:C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build();}
    public void voiceMode(boolean microphone){if(communicationAudio==microphone)return;communicationAudio=microphone;if(player!=null)player.setAudioAttributes(movieAttributes(),false);}
    public void stop(){requests.invalidate();hasMedia=false;ownsFocus=false;audio.abandonAudioFocusRequest(focus);if(player!=null){ExoPlayer old=player;player=null;old.clearVideoTextureView(video);old.release();}if(container!=null&&container.getParent() instanceof ViewGroup)((ViewGroup)container.getParent()).removeView(container);container=null;video=null;danmaku=null;subtitleView=null;subtitleTimeline=SubtitleTimeline.EMPTY;shownSubtitles=Collections.emptyList();subtitleOffsetMs=0;currentUrl="";softwareDecoder=false;fallbackTried=false;recovering=false;renderedFirstFrame=false;audioOutputAdvancing=false;playbackError="";playbackErrorCode=0;failedDecoder="";videoMime="";}
    @Override public void close(){closed=true;stop();requests.close();main.removeCallbacksAndMessages(null);}
    private static final class AudioProbe implements TeeAudioProcessor.AudioBufferSink {
        volatile long frames;volatile int peak;private int channels,encoding;
        @Override public void flush(int sampleRate,int channels,int encoding){this.channels=channels;this.encoding=encoding;}
        @Override public void handleBuffer(ByteBuffer source){
            if(encoding!=C.ENCODING_PCM_16BIT||channels<=0)return;ByteBuffer buffer=source.asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN);frames+=buffer.remaining()/(channels*2);int maximum=peak;
            for(int at=buffer.position();at+1<buffer.limit();at+=64)maximum=Math.max(maximum,Math.abs((int)buffer.getShort(at)));peak=maximum;
        }
    }
    private static final class Danmaku extends View {
        final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);final List<Bullet> bullets=new ArrayList<>();final Set<String> ids=new LinkedHashSet<>();
        static class Bullet{String text;long start;int lane;float width;}
        Danmaku(Context context){super(context);setLayerType(View.LAYER_TYPE_SOFTWARE,null);paint.setColor(Color.WHITE);paint.setTextSize(17*getResources().getDisplayMetrics().scaledDensity);paint.setShadowLayer(3,1,1,Color.BLACK);}
        void add(String id,String text){if(text.isEmpty()||text.length()>256||ids.contains(id))return;ids.add(id);if(ids.size()>128)ids.remove(ids.iterator().next());if(bullets.size()>=12)bullets.remove(0);Bullet bullet=new Bullet();bullet.text=text;bullet.start=SystemClock.uptimeMillis();bullet.lane=bullets.size()%4;bullet.width=paint.measureText(text);bullets.add(bullet);invalidate();}
        @Override protected void onDraw(Canvas canvas){super.onDraw(canvas);long now=SystemClock.uptimeMillis();Iterator<Bullet> items=bullets.iterator();while(items.hasNext()){Bullet bullet=items.next();float progress=(now-bullet.start)/6000f;if(progress>=1){items.remove();continue;}canvas.drawText(bullet.text,getWidth()-(getWidth()+bullet.width)*progress,(bullet.lane+1)*(paint.getTextSize()+8),paint);}if(!bullets.isEmpty())postInvalidateOnAnimation();}
    }
}
