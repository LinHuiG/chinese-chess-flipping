package com.chessflipping.client;

import android.animation.ValueAnimator;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.SoundPool;
import android.util.SparseBooleanArray;

/** Small predecoded cues; never play queued sounds after loading or after leaving the foreground. */
final class GameFeedback {
    private final Context context;
    private final AudioManager audio;
    private final SparseBooleanArray loaded = new SparseBooleanArray();
    private SoundPool pool;
    private int capture, victory, defeat;

    GameFeedback(Context context) { this.context = context.getApplicationContext(); audio = context.getSystemService(AudioManager.class); }
    void start() {
        if (pool != null) return;
        try {
            pool = new SoundPool.Builder().setMaxStreams(2).setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()).build();
            pool.setOnLoadCompleteListener((source, id, status) -> { if (source == pool && status == 0) loaded.put(id, true); });
            capture = pool.load(context, R.raw.capture, 1);
            victory = pool.load(context, R.raw.victory, 1);
            defeat = pool.load(context, R.raw.defeat, 1);
        } catch (RuntimeException ex) { stop(); }
    }
    void capture() { play(capture, .65f); }
    void result(boolean won) { play(won ? victory : defeat, .7f); }
    boolean motion() { return context.getSharedPreferences("connection", Context.MODE_PRIVATE).getBoolean("motion", true) && ValueAnimator.areAnimatorsEnabled(); }
    private void play(int id, float volume) {
        if (pool == null || !loaded.get(id) || !context.getSharedPreferences("connection", Context.MODE_PRIVATE).getBoolean("sound", true)
                || audio == null || audio.getRingerMode() != AudioManager.RINGER_MODE_NORMAL
                || audio.getStreamVolume(AudioManager.STREAM_MUSIC) == 0) return;
        pool.play(id, volume, volume, 1, 0, 1);
    }
    void stop() {
        if (pool != null) { pool.setOnLoadCompleteListener(null); pool.release(); pool = null; }
        loaded.clear();
    }
}
