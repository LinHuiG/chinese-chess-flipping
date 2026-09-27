package com.chessflipping.client;

import android.app.*;
import android.content.*;
import android.content.pm.ActivityInfo;
import android.graphics.Bitmap;
import android.os.*;
import android.view.*;
import org.json.*;
import java.io.*;
import java.lang.reflect.Field;
import java.util.concurrent.*;

/** Isolated UI fixtures in the test APK only, not a production debug endpoint or network test. */
public final class PresentationChecks extends Instrumentation {
    private MainActivity activity;
    private GameService service;
    private final CountDownLatch bound = new CountDownLatch(1);
    private int assertions;
    private int idleSeconds = 8;
    private final ServiceConnection binding = new ServiceConnection() {
        public void onServiceConnected(ComponentName name, IBinder binder) { service = ((GameService.LocalBinder)binder).service(); bound.countDown(); }
        public void onServiceDisconnected(ComponentName name) { }
    };
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        if (arguments != null) idleSeconds = Math.min(30, Math.max(0, Integer.parseInt(arguments.getString("idleSeconds", "8"))));
        start();
    }
    @Override public void onStart() {
        Bundle result = new Bundle(); boolean success = false;
        var preferences = getTargetContext().getSharedPreferences("connection", 0);
        boolean sound = preferences.getBoolean("sound", true), motion = preferences.getBoolean("motion", true);
        try {
            getTargetContext().getSharedPreferences("connection", 0).edit().putBoolean("sound", true).putBoolean("motion", true).commit();
            activity = (MainActivity)startActivitySync(new Intent(getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            runOnMainSync(() -> getTargetContext().bindService(new Intent(getTargetContext(), GameService.class), binding, Context.BIND_AUTO_CREATE));
            check(bound.await(5, TimeUnit.SECONDS), "service bound"); waitForIdleSync(); SystemClock.sleep(500);
            var loaded = (android.util.SparseBooleanArray)field(field(activity, "feedback"), "loaded");
            check(loaded.size() == 3, "all three short audio cues loaded");
            runOnMainSync(() -> {
                service.disconnect(); service.connected = true; service.selfId = "a"; service.status = "界面验收";
                service.room = null; service.rooms.clear(); service.roomsRevision++; activity.changed();
            });
            screenshot("lobby");
            runOnMainSync(() -> { service.room = room(false); service.state = state(false, 0); activity.changed(); });
            screenshot("waiting");
            Object oldReady = field(activity, "readyButton");
            runOnMainSync(() -> { service.state = state(false, 1); activity.changed(); });
            check(oldReady == field(activity, "readyButton"), "waiting controls reused");
            runOnMainSync(() -> { service.room = room(true); service.state = state(true, 1); activity.changed(); });
            waitForIdleSync(); screenshot("game");
            ChessBoardView board = (ChessBoardView)field(activity, "board");
            check(!board.animating(), "initial snapshot is not animated");
            runOnMainSync(() -> { service.state = captured(2, -1); activity.changed(); });
            check(board.animating(), "capture animates");
            screenshot("capture"); SystemClock.sleep(320);
            check(!board.animating(), "capture finishes");
            runOnMainSync(activity::changed); check(!board.animating(), "duplicate snapshot does not replay");
            runOnMainSync(() -> { board.pause(); service.state = state(true, 3); activity.changed(); });
            check(!board.animating(), "resume establishes a new baseline");
            getTargetContext().getSharedPreferences("connection", 0).edit().putBoolean("motion", false).commit();
            runOnMainSync(() -> { service.state = captured(4, -1); activity.changed(); });
            check(!board.animating(), "motion switch disables capture animation");
            getTargetContext().getSharedPreferences("connection", 0).edit().putBoolean("motion", true).commit();
            runOnMainSync(() -> { board.pause(); service.state = state(true, 5); activity.changed(); service.state = captured(6, 0); activity.changed();
                setField(service, "outcome", new GameService.Outcome(true, "一方棋子已全部被吃", true)); activity.changed();
                service.room = room(false); service.state = state(false, 0); service.lastResult = "你赢了 · 一方棋子已全部被吃"; activity.changed(); });
            SystemClock.sleep(700); waitForIdleSync();
            Dialog win = (Dialog)field(activity, "resultDialog"); check(win != null && win.isShowing(), "victory shown after final capture"); screenshot("victory");
            runOnMainSync(win::dismiss);
            runOnMainSync(() -> { setField(service, "outcome", new GameService.Outcome(false, "每步用时已到", true)); activity.changed(); });
            SystemClock.sleep(400); Dialog loss = (Dialog)field(activity, "resultDialog"); check(loss != null && loss.isShowing(), "defeat shown"); screenshot("defeat");
            runOnMainSync(loss::dismiss);
            runOnMainSync(() -> { setField(activity, "settings", true); invoke(activity, "showSettings"); }); screenshot("settings");
            runOnMainSync(() -> { setField(activity, "settings", false); service.room = room(true); service.state = captured(9, -1); activity.changed(); });
            screenshot("casualties");
            // Leave a quiet unlimited board briefly so adb can sample render/CPU counters.
            Bundle progress = new Bundle(); progress.putString("stream", "UI assertions=" + assertions + "; idle sampling window " + idleSeconds + " seconds\n"); sendStatus(0, progress);
            SystemClock.sleep(idleSeconds * 1000L);
            success = true; result.putString("stream", "PASS: " + assertions + " presentation checks; screenshots in external files/ui-check\n");
        } catch (Throwable error) {
            result.putString("stream", "FAIL: " + error + "\n");
            StringWriter trace = new StringWriter(); error.printStackTrace(new PrintWriter(trace)); result.putString("stack", trace.toString());
        } finally {
            preferences.edit().putBoolean("sound", sound).putBoolean("motion", motion).commit();
            if (service != null) runOnMainSync(service::disconnect);
            if (activity != null) runOnMainSync(activity::finish);
            if (bound.getCount() == 0) getTargetContext().unbindService(binding);
        }
        finish(success ? Activity.RESULT_OK : Activity.RESULT_CANCELED, result);
    }
    private void check(boolean condition, String label) { if (!condition) throw new AssertionError(label); assertions++; }
    private static JSONObject room(boolean playing) {
        return json("{\"roomId\":101,\"name\":\"午后棋局\",\"members\":[\"a\",\"b\"],\"hostId\":\"a\",\"version\":" + (playing ? 2 : 3) + ",\"playing\":" + playing + ",\"gameId\":\"" + (playing ? "ui-check" : "") + "\"}");
    }
    private static JSONObject state(boolean playing, int move) {
        JSONObject value = json("{\"seq\":" + move + ",\"seconds\":0,\"ready\":{\"a\":true},\"move\":" + move + ",\"turn\":0,\"colors\":[1,-1],\"remaining\":-1,\"winner\":-1,\"captured\":[]}");
        if (playing) {
            int[] board = {4,0,-5,99, 0,7,99,-6, 2,99,-7,99, 99,1,99,-2, 99,-3,5,99, 7,99,99,-7, 99,6,99,3, 7,99,-1,99};
            JSONArray cells = new JSONArray(); for (int piece : board) cells.put(piece); put(value, "board", cells);
        }
        return value;
    }
    private static JSONObject captured(int move, int winner) {
        JSONObject value = state(true, move);
        try { value.getJSONArray("board").put(0, 0).put(2, 4); value.put("captured", new JSONArray(new int[]{-5}));
            value.put("lastFrom", 0).put("lastTo", 2).put("turn", 1).put("winner", winner); return value;
        } catch (JSONException ex) { throw new IllegalStateException(ex); }
    }
    private static JSONObject json(String text) { try { return new JSONObject(text); } catch (JSONException e) { throw new IllegalStateException(e); } }
    private static void put(JSONObject object, String key, Object value) { try { object.put(key, value); } catch (JSONException e) { throw new IllegalStateException(e); } }
    private static Object field(Object object, String name) {
        try { Field field = object.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(object); }
        catch (Exception ex) { throw new IllegalStateException(ex); }
    }
    private static void setField(Object object, String name, Object value) {
        try { Field field = object.getClass().getDeclaredField(name); field.setAccessible(true); field.set(object, value); }
        catch (Exception ex) { throw new IllegalStateException(ex); }
    }
    private static void invoke(Object object, String name) {
        try { var method = object.getClass().getDeclaredMethod(name); method.setAccessible(true); method.invoke(object); }
        catch (Exception ex) { throw new IllegalStateException(ex); }
    }
    private void screenshot(String name) throws IOException {
        waitForIdleSync();
        Bitmap bitmap = getUiAutomation().takeScreenshot();
        if (bitmap == null) throw new IOException("No screenshot");
        File directory = getTargetContext().getExternalFilesDir("ui-check");
        if (directory == null) throw new IOException("No output directory");
        try (OutputStream output = new FileOutputStream(new File(directory, name + ".png"))) { bitmap.compress(Bitmap.CompressFormat.PNG, 100, output); }
        finally { bitmap.recycle(); }
    }
}
