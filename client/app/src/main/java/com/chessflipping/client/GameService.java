package com.chessflipping.client;

import android.app.*;
import android.content.*;
import android.os.*;
import com.chessflipping.game.HostController;
import org.json.*;
import java.util.*;

/** Owns the connection and host referee independently of Activity/lock-screen lifetime. */
public final class GameService extends Service {
    public static final String DEFAULT_HOST = "hgame.tudoucoding.tech";
    public static final int DEFAULT_PORT = 8888;
    public interface Observer { void changed(); void notice(String text); }
    public final class LocalBinder extends Binder { public GameService service() { return GameService.this; } }
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final IBinder binder = new LocalBinder();
    private final ArrayList<JSONObject> listing = new ArrayList<>();
    public final ArrayList<JSONObject> rooms = new ArrayList<>();
    public JSONObject room, state;
    public String selfId = "", status = "尚未连接", lastResult = "";
    public boolean connected, listingRooms;
    public long stateReceivedAt;
    public long roomsRevision;
    public static final class Outcome {
        public final boolean won, live;
        public final String reason;
        public final long at = SystemClock.elapsedRealtime();
        Outcome(boolean won, String reason, boolean live) { this.won = won; this.reason = reason; this.live = live; }
    }
    private Outcome outcome;
    private String resultGameId = "";
    private Observer observer;
    private TcpClient client;
    private boolean foreground, enabled;
    private int generation;
    private final HostController referee = new HostController(this::send, SystemClock::elapsedRealtime);
    private PowerManager.WakeLock wakeLock;
    private final Runnable retry = this::connect;
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            try { referee.tick(); }
            catch (JSONException ex) { notice("棋局计时处理失败"); }
            scheduleTick();
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("game", "联机游戏连接", NotificationManager.IMPORTANCE_LOW));
        wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "chessflipping:connection");
        wakeLock.setReferenceCounted(false);
    }
    @Override public IBinder onBind(Intent intent) { return binder; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "STOP".equals(intent.getAction())) { disconnect(); return START_NOT_STICKY; }
        showNotification();
        enabled = true;
        connect();
        return START_NOT_STICKY;
    }
    private void showNotification() {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, GameService.class).setAction("STOP"), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new Notification.Builder(this, "game").setSmallIcon(R.drawable.ic_chess)
                .setContentTitle("翻棋联机").setContentText("游戏连接正在运行").setContentIntent(open)
                .setOngoing(true).addAction(new Notification.Action.Builder(null, "断开连接", stop).build()).build();
        startForeground(1, notification);
    }
    public SharedPreferences preferences() { return getSharedPreferences("connection", MODE_PRIVATE); }
    public Outcome takeOutcome() { Outcome value = outcome; outcome = null; return value; }
    private void scheduleTick() {
        handler.removeCallbacks(tick);
        long delay = referee.nextTickDelay();
        if (delay >= 0) handler.postDelayed(tick, delay);
    }
    public String host() { return preferences().getString("host", DEFAULT_HOST); }
    public int port() { return preferences().getInt("port", DEFAULT_PORT); }
    public void observe(Observer value) { observer = value; if (value != null) value.changed(); }
    public void foreground(boolean value) {
        foreground = value;
        if (!value) handler.removeCallbacks(retry);
        else if (enabled && client == null) connect();
    }
    private void connect() {
        handler.removeCallbacks(retry);
        if (!enabled || !foreground || client != null) return;
        final int current = ++generation;
        String did = preferences().getString("did", null);
        if (did == null) {
            did = getSharedPreferences("MainActivity", MODE_PRIVATE).getString("device_id", UUID.randomUUID().toString().replace("-", ""));
            preferences().edit().putString("did", did).apply();
        }
        status = "正在连接 " + host() + ":" + port();
        changed();
        client = new TcpClient(did, getPackageName(), "0.3.0", new TcpClient.Listener() {
            private void dispatch(Runnable action) { handler.post(() -> { if (generation == current) action.run(); }); }
            public void onStatus(String text) { dispatch(() -> { status = text; changed(); }); }
            public void onConnected() { dispatch(() -> {
                connected = true; status = "已连接";
                wakeLock.acquire(45000);
                changed();
            }); }
            public void onMessage(String text) { dispatch(() -> receive(text)); }
            public void onEvent(String text) { dispatch(() -> receive(text)); }
            public void onClosed(String reason) { dispatch(() -> {
                client = null; connected = false; clearRoom(); selfId = ""; rooms.clear(); listing.clear(); listingRooms = false;
                outcome = null; roomsRevision++;
                if (wakeLock.isHeld()) wakeLock.release();
                status = reason + (foreground && enabled ? "，3 秒后重连" : "");
                changed();
                if (foreground && enabled) handler.postDelayed(retry, 3000);
            }); }
        });
        client.connect(host(), port());
    }
    public void disconnect() {
        enabled = false; generation++;
        handler.removeCallbacks(retry);
        if (client != null) client.close();
        client = null; connected = false; clearRoom(); selfId = ""; rooms.clear(); listing.clear(); listingRooms = false;
        outcome = null; roomsRevision++;
        status = "已断开连接";
        if (wakeLock.isHeld()) wakeLock.release();
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); changed();
    }
    public void saveServer(String host, int port) {
        disconnect();
        preferences().edit().putString("host", host).putInt("port", port).apply();
    }
    private void clearRoom() {
        room = state = null; lastResult = ""; referee.clear(); handler.removeCallbacks(tick);
    }
    public boolean isHost() { return room != null && selfId.equals(room.optString("hostId")); }
    public boolean playing() { return room != null && room.optBoolean("playing"); }
    public boolean isReady(String id) { return state != null && state.optJSONObject("ready") != null && state.optJSONObject("ready").optBoolean(id); }
    public int myIndex() {
        if (room == null) return -1;
        JSONArray members = room.optJSONArray("members");
        for (int i = 0; i < members.length(); i++) if (selfId.equals(members.optString(i))) return i;
        return -1;
    }
    public long displayedRemaining() {
        if (state == null) return -1;
        long remaining = state.optLong("remaining", -1);
        return remaining < 0 ? -1 : Math.max(0, remaining - (SystemClock.elapsedRealtime() - stateReceivedAt));
    }
    public void listRooms() {
        if (!connected || room != null || listingRooms) return;
        listing.clear(); listingRooms = true; send(json("LIST")); changed();
    }
    public void createRoom(String name) { send(put(json("CREATE"), "name", name)); }
    public void join(long id) { send(put(json("JOIN"), "roomId", id)); }
    public void leave() { send(json("LEAVE")); }
    public void dissolve() { send(context("DISSOLVE")); }
    public void sync() { action(put(json("SYNC"), "seq", state == null ? 0 : state.optLong("move"))); }
    public void ready(boolean value) { action(put(json("READY"), "ready", value)); }
    public void timeLimit(int value) { action(put(json("TIME"), "seconds", value)); }
    public void move(int from, int to) {
        JSONObject action = put(put(json("MOVE"), "from", from), "to", to);
        put(action, "move", state == null ? -1 : state.optLong("move"));
        action(action);
    }
    private void action(JSONObject action) { send(put(context("ACTION"), "action", action)); }
    private JSONObject context(String type) {
        JSONObject request = json(type);
        if (room != null) {
            put(request, "roomId", room.optLong("roomId")); put(request, "version", room.optLong("version"));
            put(request, "gameId", room.optString("gameId"));
        }
        return request;
    }
    private void send(JSONObject request) { if (connected && client != null) client.request(request); else notice("连接尚未建立"); }

    private void receive(String text) {
        try {
            JSONObject message = new JSONObject(text);
            switch (message.optString("type")) {
                case "SESSION":
                    selfId = message.getString("selfId"); clearRoom(); listingRooms = false; listRooms(); break;
                case "ROOMS":
                    if (room != null) break;
                    JSONArray page = message.getJSONArray("rooms");
                    for (int i = 0; i < page.length(); i++) listing.add(page.getJSONObject(i));
                    long next = message.optLong("next");
                    if (next > 0) send(put(json("LIST"), "after", next));
                    else { rooms.clear(); rooms.addAll(listing); listing.clear(); listingRooms = false; roomsRevision++; }
                    break;
                case "ROOM":
                    acceptRoom(message); break;
                case "ROOM_CLOSED":
                    clearRoom(); listingRooms = false; listRooms(); break;
                case "STATE":
                    if (matches(message)) {
                        JSONObject update = message.getJSONObject("state");
                        if (state == null || update.optLong("seq") > state.optLong("seq")) {
                            state = update; stateReceivedAt = SystemClock.elapsedRealtime();
                        }
                    }
                    break;
                case "FORWARD":
                    if (matches(message) && isHost()) referee.action(message); break;
                case "GAME_OVER":
                    if (matches(message) && !resultGameId.equals(message.optString("gameId"))) {
                        resultGameId = message.optString("gameId");
                        boolean won = selfId.equals(message.optString("winnerId"));
                        String reason = reason(message.optString("reason"));
                        lastResult = (won ? "你赢了" : "本局落败") + " · " + reason;
                        outcome = new Outcome(won, reason, foreground && observer != null);
                    }
                    break;
                case "RESULT":
                    if (!message.optBoolean("ok")) {
                        if ("LIST".equals(message.optString("request"))) { listing.clear(); listingRooms = false; roomsRevision++; }
                        notice(message.optString("error", "请求失败"));
                        referee.failed(message.optString("request"));
                    }
                    break;
                case "PONG": wakeLock.acquire(45000); return;
                default: break;
            }
            scheduleTick();
            changed();
        } catch (JSONException ex) { notice(text.startsWith("{") ? "服务器状态格式异常" : text); }
    }
    private boolean matches(JSONObject message) {
        return room != null && room.optLong("roomId") == message.optLong("roomId")
                && room.optLong("version") == message.optLong("version")
                && room.optString("gameId").equals(message.optString("gameId"));
    }
    private void acceptRoom(JSONObject message) throws JSONException {
        if (room != null && room.optLong("roomId") == message.optLong("roomId")
                && message.optLong("version") <= room.optLong("version")) return;
        room = message; state = null; listingRooms = false;
        if (message.optBoolean("playing")) { lastResult = ""; outcome = null; }
        referee.room(message, selfId);
    }
    private static JSONObject json(String type) { return put(new JSONObject(), "type", type); }
    private static JSONObject put(JSONObject object, String key, Object value) {
        try { object.put(key, value); return object; }
        catch (JSONException ex) { throw new IllegalArgumentException(ex); }
    }
    private void changed() { if (observer != null) observer.changed(); }
    private void notice(String text) { if (observer != null) observer.notice(text); }
    public static String reason(String value) {
        return switch (value) {
            case "TIMEOUT" -> "每步用时已到";
            case "NO_PIECES" -> "一方棋子已全部被吃";
            case "NO_MOVES" -> "没有合法行动";
            case "HOST_DISSOLVED" -> "房主认输并解散房间";
            case "DISCONNECTED" -> "对局中连接断开";
            default -> "对局中退出房间";
        };
    }
    @Override public void onTaskRemoved(Intent rootIntent) { disconnect(); super.onTaskRemoved(rootIntent); }
    @Override public void onDestroy() { observer = null; disconnect(); handler.removeCallbacksAndMessages(null); super.onDestroy(); }
}
