package com.chessflipping.client;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.*;
import android.media.audiofx.AcousticEchoCanceler;
import android.os.*;
import com.cyberroom.sdk.NativeExtension;
import org.json.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.*;

/** Native audio fast path: the WebView only handles room configuration and low-rate status. */
public final class VoiceEngine implements AutoCloseable {
    private static final int RATE=16000;
    private final Context context;private final AudioManager audio;private final Consumer<JSONObject> events;
    private final NativeExtension.Host host;
    private final BooleanSupplier movieActive;private final Runnable interrupted;
    private final ScheduledExecutorService playback=Executors.newSingleThreadScheduledExecutor(r->new Thread(r,"cyber-voice-play"));
    private final ExecutorService capture=Executors.newSingleThreadExecutor(r->new Thread(r,"cyber-voice-capture"));
    private final Map<String,Stream> streams=new HashMap<>();
    private volatile Set<String> members=Collections.emptySet(),direct=Collections.emptySet();
    private volatile String room="",self="";private volatile boolean enabled,foreground=true,microphone,closed;
    private volatile AudioRecord record;private AcousticEchoCanceler aec;private AudioTrack track;
    private volatile int captureGeneration;private volatile String echo="unavailable",error="";
    private int previousMode;private boolean previousSpeaker;private long lastStatus,lastSendFailure;private volatile boolean modeChanged;
    private volatile long capturedFrames;private long playedFrames;private int outputPeak;
    private final AudioFocusRequest focus;private final AudioDeviceCallback devices;
    static final class Block {final short[] pcm;final double due;Block(short[] pcm,double due){this.pcm=pcm;this.due=due;}}
    static final class Stream {
        int generation,window;long newest=-1,played=-1,received,seen,late;double jitter,anchorAt;long arrival,clock,anchorClock;
        final TreeMap<Long,Block> blocks=new TreeMap<>();final Set<Integer> retired=new LinkedHashSet<>();
        void accept(byte[] body,long now){
            short[] pcm=VoiceCodec.decode(body);ByteBuffer in=ByteBuffer.wrap(body).order(ByteOrder.LITTLE_ENDIAN);int next=in.getInt(4);long sequence=Integer.toUnsignedLong(in.getInt(8)),sample=Integer.toUnsignedLong(in.getInt(12));
            if(generation!=next){if(retired.contains(next))return;if(newest>=0)retired.add(generation);if(retired.size()>8)retired.remove(retired.iterator().next());generation=next;blocks.clear();newest=-1;played=-1;arrival=0;window=0;seen=0;anchorAt=0;}
            boolean advancing=sequence>newest;
            if(advancing){long shift=sequence-newest;seen=shift>=64?1:(seen<<shift)|1;window=newest<0?1:(int)Math.min(64,window+shift);newest=sequence;}
            else{long age=newest-sequence;if(age>=64||(seen&(1L<<age))!=0)return;seen|=1L<<age;}
            received++;
            if(anchorAt==0){anchorAt=now;anchorClock=sample;}
            double expected=anchorAt+((int)(sample-anchorClock))/16.0;
            if(now<expected){anchorAt-=expected-now;expected=now;}
            if(arrival>0&&advancing){double deviation=Math.abs((now-arrival)-((int)(sample-clock))/16.0);jitter+=(deviation-jitter)/16;}
            if(advancing){arrival=now;clock=sample;if(Math.abs((int)(sample-anchorClock))>16000*60){anchorAt=expected;anchorClock=sample;}}
            if(sequence<=played||now>expected+200){late++;return;}
            blocks.put(sequence,new Block(pcm,expected+40));
            while(blocks.size()>6){Map.Entry<Long,Block> discarded=blocks.pollFirstEntry();played=Math.max(played,discarded.getKey());}
        }
        Block poll(long now){
            while(!blocks.isEmpty()&&now>blocks.firstEntry().getValue().due+160){Map.Entry<Long,Block> old=blocks.pollFirstEntry();played=Math.max(played,old.getKey());late++;}
            if(blocks.isEmpty()||now<blocks.firstEntry().getValue().due)return null;
            Map.Entry<Long,Block> first=blocks.pollFirstEntry();played=first.getKey();return first.getValue();
        }
    }
    public VoiceEngine(Context context,Consumer<JSONObject> events,NativeExtension.Host host,BooleanSupplier movieActive,Runnable interrupted){
        this.context=context;this.events=events;this.host=host;this.movieActive=movieActive;this.interrupted=interrupted;audio=context.getSystemService(AudioManager.class);
        focus=new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attributes()).setOnAudioFocusChangeListener(change->{
            // Starting our movie replaces the standalone microphone's focus request.
            // While the movie owns focus, its listener handles external interruptions.
            if(change<0&&!movieActive.getAsBoolean()){microphone(false);interrupted.run();}
        }).build();
        devices=new AudioDeviceCallback(){@Override public void onAudioDevicesRemoved(AudioDeviceInfo[] removed){if(removed.length>0&&microphone){microphone(false);report("音频设备已切换，请再次开麦");}}};
        audio.registerAudioDeviceCallback(devices,new Handler(Looper.getMainLooper()));
        // Schedule the next block from this run; a cached process must not replay missed ticks.
        playback.schedule(new Runnable(){public void run(){if(closed)return;long started=SystemClock.elapsedRealtime();mix();if(!closed)try{playback.schedule(this,Math.max(1,20-(SystemClock.elapsedRealtime()-started)),TimeUnit.MILLISECONDS);}catch(RejectedExecutionException ignored){}}},20,TimeUnit.MILLISECONDS);
    }
    private static AudioAttributes attributes(){return new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();}
    public synchronized void configure(JSONObject q){
        if(closed)return;
        String next=q.optString("roomId"),nextSelf=q.optString("selfId");
        if(!next.matches("[0-9a-f]{32}")||!nextSelf.matches("[0-9a-f]{32}")||!VoiceCodec.NAME.equals(q.optString("codec",VoiceCodec.NAME))){stop();return;}
        boolean changed=!room.equals(next)||!self.equals(nextSelf);if(changed)stop();room=next;self=nextSelf;
        Set<String> allowed=ids(q.optJSONArray("members"));allowed.remove(self);members=Collections.unmodifiableSet(allowed);
        Set<String> targets=ids(q.optJSONArray("directTargets"));targets.retainAll(members);direct=Collections.unmodifiableSet(targets);
        synchronized(streams){streams.keySet().retainAll(members);}
        enabled=q.optBoolean("enabled",true);if(!enabled){microphone(false);synchronized(streams){streams.clear();}releaseTrack();}report("");
    }
    public String roomId(){return room;}
    private static Set<String> ids(JSONArray values){Set<String> ids=new LinkedHashSet<>();if(values!=null)for(int i=0;i<values.length()&&ids.size()<6;i++){String id=values.optString(i);if(id.matches("[0-9a-f]{32}"))ids.add(id);}return ids;}
    public synchronized void foreground(boolean value){foreground=value;if(!value){microphone(false);synchronized(streams){streams.clear();}releaseTrack();}report("");}
    public synchronized void microphone(boolean value){
        if(!value){boolean wasMicrophone=microphone;microphone=false;captureGeneration++;AudioRecord old=record;record=null;if(old!=null){try{old.stop();}catch(Exception ignored){}}
            if(aec!=null){aec.release();aec=null;}if(old!=null)old.release();echo="off";
            if(modeChanged){audio.setMode(previousMode);audio.setSpeakerphoneOn(previousSpeaker);modeChanged=false;}if(wasMicrophone)releaseTrack();audio.abandonAudioFocusRequest(focus);report("");return;}
        if(microphone||closed)return;
        if(!enabled||!foreground){report("请先加入观影房并回到前台");return;}
        if(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){report("麦克风权限未允许，仍可观影和发弹幕");return;}
        try{
            if(!movieActive.getAsBoolean()&&audio.requestAudioFocus(focus)!=AudioManager.AUDIOFOCUS_REQUEST_GRANTED){report("其他应用正在使用音频，请稍后开麦");return;}
            previousMode=audio.getMode();previousSpeaker=audio.isSpeakerphoneOn();audio.setMode(AudioManager.MODE_IN_COMMUNICATION);modeChanged=true;
            boolean headset=false;for(AudioDeviceInfo device:audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS))if(device.getType()==AudioDeviceInfo.TYPE_WIRED_HEADSET||device.getType()==AudioDeviceInfo.TYPE_WIRED_HEADPHONES||device.getType()==AudioDeviceInfo.TYPE_BLUETOOTH_SCO||device.getType()==AudioDeviceInfo.TYPE_USB_HEADSET||device.getType()==AudioDeviceInfo.TYPE_BLUETOOTH_A2DP)headset=true;
            if(!headset)audio.setSpeakerphoneOn(true);
            int minimum=AudioRecord.getMinBufferSize(RATE,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT);
            if(minimum<=0)throw new IllegalStateException("capture unavailable");
            AudioRecord next=new AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION).setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build()).setBufferSizeInBytes(Math.max(minimum,3200)).build();
            record=next;if(next.getState()!=AudioRecord.STATE_INITIALIZED)throw new IllegalStateException("capture unavailable");
            echo="unavailable";if(AcousticEchoCanceler.isAvailable()){aec=AcousticEchoCanceler.create(next.getAudioSessionId());if(aec!=null&&aec.setEnabled(true)==0&&aec.getEnabled())echo="system-unverified";}
            if(!"system-unverified".equals(echo))echo=headset?"headphones":"unavailable";
            next.startRecording();microphone=true;releaseTrack();int generation=++captureGeneration;error="";capture.execute(()->capture(next,generation));report("");
        }catch(Exception ex){microphone(false);report("设备暂不支持语音采集，仍可观影和发弹幕");}
    }
    private void capture(AudioRecord source,int generation){
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO);
        short[] pcm=new short[VoiceCodec.SAMPLES];int stream=new SecureRandom().nextInt(),seq=0,clock=0;
        try{while(!closed&&microphone&&generation==captureGeneration){
            int offset=0;while(offset<pcm.length&&microphone&&generation==captureGeneration){int read=source.read(pcm,offset,pcm.length-offset,AudioRecord.READ_BLOCKING);if(read<=0)throw new IllegalStateException("capture stopped");offset+=read;}
            if(offset!=pcm.length||generation!=captureGeneration)break;
            capturedFrames++;send(VoiceCodec.encode(pcm,stream,seq++,clock),generation);clock+=VoiceCodec.SAMPLES;
        }}catch(Exception ex){if(generation==captureGeneration){microphone(false);report("麦克风已停止，请再次开麦");}}
    }
    private void send(byte[] body,int generation){
        final Set<String> destinations,directTargets;final String sourceRoom;
        synchronized(this){if(generation!=captureGeneration||!enabled||!foreground||!microphone||closed)return;destinations=members;directTargets=direct;sourceRoom=room;}
        // Keep one immutable room/recipient snapshot; never hold the audio lock across a WS send.
        if(destinations.isEmpty())return;
        try{
            String headers="roomId:"+sourceRoom+"\ntype:voice\ncodec:"+VoiceCodec.NAME+"\ndiscard:1\nmaxAgeMs:200\n";
            List<String> remaining=new ArrayList<>();
            boolean weak=SystemClock.elapsedRealtime()-lastSendFailure<5000;
            int sent=0;for(String id:destinations){if(!weak&&sent<5&&directTargets.contains(id)&&host.healthy(id)&&host.send(id,new NativeExtension.Packet(64,("to:"+id+"\n"+headers).getBytes(StandardCharsets.UTF_8),body)))sent++;else remaining.add(id);}
            if(!remaining.isEmpty()){
                NativeExtension.Packet packet=new NativeExtension.Packet(16,("op:201\nto:"+String.join(",",remaining)+"\n"+headers).getBytes(StandardCharsets.UTF_8),body);
                if(!host.send(null,packet))lastSendFailure=SystemClock.elapsedRealtime();
            }
        }catch(Exception ignored){lastSendFailure=SystemClock.elapsedRealtime();}
    }
    public synchronized boolean receive(String peer,NativeExtension.Packet packet){
        if(packet.type!=64)return false;
        try{
            Map<String,String> h=new HashMap<>();for(String line:new String(packet.control,StandardCharsets.UTF_8).split("\n")){int colon=line.indexOf(':');if(colon>0)h.put(line.substring(0,colon),line.substring(colon+1));}if(!"voice".equals(h.get("type")))return false;
            if(!enabled||!foreground||!room.equals(h.get("roomId"))||!VoiceCodec.NAME.equals(h.get("codec")))return true;
            String from=peer==null?h.get("from"):peer;if(!members.contains(from))return true;
            synchronized(streams){
                streams.computeIfAbsent(from,key->new Stream()).accept(packet.body,SystemClock.elapsedRealtime());
            }
            return true;
        }catch(Exception ignored){return true;}
    }
    private synchronized void mix(){
        if(closed||!enabled||!foreground)return;
        try{
            short[] mixed=new short[VoiceCodec.SAMPLES];int[] sum=new int[VoiceCodec.SAMPLES];boolean hasAudio=false;long now=SystemClock.elapsedRealtime();
            synchronized(streams){for(Stream s:streams.values()){
                Block block=s.poll(now);if(block==null)continue;hasAudio=true;for(int i=0;i<sum.length;i++)sum[i]+=block.pcm[i];
            }}
            if(hasAudio||track!=null){
                // Closed-mic listeners use the media route/volume, rather than a
                // phone-call earpiece route which may remain quiet on first entry.
                if(track==null){int minimum=AudioTrack.getMinBufferSize(RATE,AudioFormat.CHANNEL_OUT_MONO,AudioFormat.ENCODING_PCM_16BIT);if(minimum<=0)throw new IllegalStateException();AudioAttributes output=new AudioAttributes.Builder().setUsage(microphone?AudioAttributes.USAGE_VOICE_COMMUNICATION:AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();track=new AudioTrack.Builder().setAudioAttributes(output).setAudioFormat(new AudioFormat.Builder().setSampleRate(RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()).setBufferSizeInBytes(Math.max(minimum,1920)).setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY).setTransferMode(AudioTrack.MODE_STREAM).build();track.play();}
                for(int i=0;i<sum.length;i++)mixed[i]=(short)VoiceCodec.clamp(sum[i]);
                // Non-blocking writes cap native output accumulation; discarded blocks are never replayed later.
                int written=track.write(mixed,0,mixed.length,AudioTrack.WRITE_NON_BLOCKING);if(written<0)throw new IllegalStateException();if(hasAudio&&written>0){playedFrames++;for(int i=0;i<written;i++)outputPeak=Math.max(outputPeak,Math.abs((int)mixed[i]));}
            }
            if(now-lastStatus>=2000){lastStatus=now;report("");}
        }catch(Exception ex){releaseTrack();report("设备暂不支持语音播放，电影与弹幕仍可使用");}
    }
    private void releaseTrack(){if(track!=null){try{track.pause();track.flush();track.release();}catch(Exception ignored){}track=null;}}
    public synchronized void report(String message){
        if(!message.isEmpty())error=message;
        try{JSONArray peers=new JSONArray();synchronized(streams){for(Map.Entry<String,Stream> entry:streams.entrySet()){Stream s=entry.getValue();int missing=s.window-Long.bitCount(s.seen);peers.put(new JSONObject().put("peerId",entry.getKey()).put("received",s.received).put("lost",missing).put("loss",s.window==0?0:missing/(double)s.window).put("late",s.late).put("jitter",s.jitter).put("queued",s.blocks.size()));}}
            events.accept(new JSONObject().put("type","voiceStatus").put("available",true).put("capture",context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_MICROPHONE)).put("playing",track!=null).put("microphone",microphone).put("capturedFrames",capturedFrames).put("playedFrames",playedFrames).put("outputPeak",outputPeak).put("aec",echo).put("aecVerified",false).put("error",error).put("peers",peers).put("suggestedDirectLimit",SystemClock.elapsedRealtime()-lastSendFailure<5000?0:5));
        }catch(JSONException ignored){}
    }
    public synchronized void stop(){enabled=false;microphone(false);members=Collections.emptySet();direct=Collections.emptySet();room="";self="";capturedFrames=playedFrames=0;outputPeak=0;error="";synchronized(streams){streams.clear();}releaseTrack();}
    @Override public synchronized void close(){closed=true;stop();audio.unregisterAudioDeviceCallback(devices);playback.shutdownNow();capture.shutdownNow();}
}
