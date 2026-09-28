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
    public static final int DEFAULT_PORT = 80;
    public interface Observer { void changed(); void notice(String text); default void networkChanged() { } }
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
    public long serverLatency = -1, directLatency = -1;
    public boolean direct;
    private UdpPeer udp;
    private String p2pId = "";
    private int p2pGeneration;
    private boolean p2pRequested;
    private final Set<String> directRequests = new HashSet<>();
    private final LinkedHashMap<String, JSONObject> directActions = new LinkedHashMap<>();
    private final Runnable actionDeadline = this::fallback;
    public static final class Outcome {
        public final boolean won, live;
        public final String reason;
        public final long at = SystemClock.elapsedRealtime();
        Outcome(boolean won, String reason, boolean live) { this.won = won; this.reason = reason; this.live = live; }
    }
    private Outcome outcome;
    private String resultGameId = "";
    private Observer observer;
    private GameConnection client;
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
    public String transport() { return preferences().getString("transport", preferences().contains("port") ? "TCP" : "HTTP"); }
    public String endpoint() { return transport().toLowerCase(java.util.Locale.ROOT) + "://" + host() + ":" + port(); }
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
        status = "正在连接 " + endpoint();
        changed();
        TcpClient.Listener listener = new TcpClient.Listener() {
            private void dispatch(Runnable action) { handler.post(() -> { if (generation == current) action.run(); }); }
            public void onStatus(String text) { dispatch(() -> { status = text; changed(); }); }
            public void onConnected() { dispatch(() -> {
                connected = true; status = "已连接";
                wakeLock.acquire(45000);
                changed();
            }); }
            public void onMessage(String text) { dispatch(() -> receive(text)); }
            public void onEvent(String text) { dispatch(() -> receive(text)); }
            public void onJsonMessage(JSONObject value, boolean event) { dispatch(() -> receive(value)); }
            public void onLatency(long millis) { dispatch(() -> { serverLatency = millis; networkChanged(); }); }
            public void onClosed(String reason) { dispatch(() -> {
                client = null; connected = false; serverLatency = -1; clearRoom(); selfId = ""; rooms.clear(); listing.clear(); listingRooms = false;
                outcome = null; roomsRevision++;
                if (wakeLock.isHeld()) wakeLock.release();
                status = reason + (foreground && enabled ? "，3 秒后重连" : "");
                changed();
                if (foreground && enabled) handler.postDelayed(retry, 3000);
            }); }
        };
        client = transport().equals("TCP") ? new TcpClient(did, getPackageName(), "0.5.0", listener)
                : new WsClient(did, getPackageName(), "0.5.0", transport().equals("HTTPS"), listener);
        client.connect(host(), port());
    }
    public void disconnect() {
        enabled = false; generation++;
        handler.removeCallbacks(retry);
        if (client != null) client.close();
        client = null; connected = false; serverLatency = -1; clearRoom(); selfId = ""; rooms.clear(); listing.clear(); listingRooms = false;
        outcome = null; roomsRevision++;
        status = "已断开连接";
        if (wakeLock.isHeld()) wakeLock.release();
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); changed();
    }
    public void saveServer(String host, int port) {
        saveServer(host, port, "TCP");
    }
    public void saveServer(String host, int port, String transport) {
        disconnect();
        preferences().edit().putString("host", host).putInt("port", port).putString("transport", transport).apply();
    }
    private void clearRoom() {
        closeDirect(); p2pId = ""; p2pRequested = false; directActions.clear(); directRequests.clear();
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
    private void action(JSONObject action) {
        JSONObject request = put(put(context("ACTION"), "action", action), "operationId", UUID.randomUUID().toString().replace("-", ""));
        if (direct && playing()) {
            if (isHost()) { directAction(request, selfId); return; }
            if (!directActions.isEmpty()) { notice("上一步正在确认，请稍候"); return; }
            directActions.put(request.optString("operationId"), request);
            if (sendDirect(request)) { handler.postDelayed(actionDeadline, 3500); return; }
            fallback(); return;
        }
        sendServer(request);
    }
    private JSONObject context(String type) {
        JSONObject request = json(type);
        if (room != null) {
            put(request, "roomId", room.optLong("roomId")); put(request, "version", room.optLong("version"));
            put(request, "gameId", room.optString("gameId"));
        }
        return request;
    }
    private void sendServer(JSONObject request) { if (connected && client != null) client.request(request); else notice("连接尚未建立"); }
    private void send(JSONObject request) {
        String type = request.optString("type");
        if ("HOST_REPLY".equals(type) && directRequests.remove(request.optString("requestId"))) {
            JSONObject reply = put(put(context("DIRECT_REPLY"), "operationId", request.optString("operationId")), "ok", request.optBoolean("ok"));
            if (request.optBoolean("ok")) { put(reply, "state", request.optJSONObject("state")); applyState(reply); }
            else put(reply, "error", request.optString("error"));
            if (!sendDirect(reply)) { fallback(); if (request.optBoolean("ok")) sendServer(put(context("HOST_STATE"), "state", request.optJSONObject("state"))); }
            return;
        }
        if ("HOST_STATE".equals(type) && direct && !request.optBoolean("finalState")) {
            JSONObject update = put(context("DIRECT_STATE"), "state", request.optJSONObject("state")); applyState(update);
            if (!sendDirect(update)) fallback();
            return;
        }
        sendServer(request);
    }

    private boolean sendDirect(JSONObject value) {
        return direct && udp != null && udp.send(value.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
    private void directAction(JSONObject message, String actor) {
        String operation = message.optString("operationId");
        if (!operation.matches("[0-9a-f]{32}") || !matches(message)) return;
        JSONObject forward = put(put(put(put(context("FORWARD"), "requestId", operation), "operationId", operation), "actorId", actor), "action", message.optJSONObject("action"));
        directRequests.add(operation);
        try { referee.action(forward); scheduleTick(); }
        catch (JSONException ex) { directRequests.remove(operation); fallback(); }
        changed();
    }
    private void applyState(JSONObject message) {
        if (!matches(message)) return;
        JSONObject update = message.optJSONObject("state");
        if (update != null && (state == null || update.optLong("seq") > state.optLong("seq"))) {
            state = update; stateReceivedAt = SystemClock.elapsedRealtime();
        }
    }
    private void peerMessage(JSONObject message) {
        if (!direct || !matches(message)) return;
        String type = message.optString("type");
        if (isHost()) {
            if ("ACTION".equals(type)) directAction(message, room.optJSONArray("members").optString(1));
            return;
        }
        if ("DIRECT_STATE".equals(type)) applyState(message);
        else if ("DIRECT_REPLY".equals(type)) {
            directActions.remove(message.optString("operationId"));
            if (directActions.isEmpty()) handler.removeCallbacks(actionDeadline);
            if (message.optBoolean("ok")) applyState(message); else notice(message.optString("error", "操作无效"));
        } else return;
        changed();
    }
    private void closeDirect() {
        p2pGeneration++; if (udp != null) udp.close(); udp = null; direct = false; directLatency = -1;
        handler.removeCallbacks(actionDeadline); networkChanged();
    }
    private void fallback() { fallback(true); }
    private void fallback(boolean signal) {
        String previous = p2pId; boolean existed = udp != null || direct;
        closeDirect(); p2pId = "";
        if (connected && room != null && !previous.isEmpty() && signal) sendServer(put(context("P2P_STOP"), "p2pId", previous));
        if (connected && room != null) {
            for (JSONObject request : directActions.values()) sendServer(request);
            if (existed && isHost()) try { referee.syncState(); } catch (JSONException ignored) { }
        }
        directActions.clear();
    }
    private void p2pMessage(JSONObject message) throws JSONException {
        if (!matches(message)) return;
        String type = message.optString("type"), sid = message.optString("p2pId");
        if (!sid.matches("[0-9a-f]{32}")) return;
        if ("P2P_OFFER".equals(type) && isHost()) {
            p2pId = sid; byte[] master = new byte[32]; new java.security.SecureRandom().nextBytes(master);
            sendServer(put(put(context("P2P_KEY"), "p2pId", sid), "key", Base64.getEncoder().encodeToString(master)));
            Arrays.fill(master, (byte) 0); return;
        }
        if ("P2P_CONFIG".equals(type)) {
            if (udp != null && sid.equals(p2pId)) return;
            closeDirect(); p2pId = sid; final int epoch = p2pGeneration;
            byte[] master = Base64.getDecoder().decode(message.getString("key"));
            String binding = sid + "|" + room.optLong("roomId") + "|" + room.optLong("version") + "|" + room.optString("gameId")
                    + "|" + room.optJSONArray("members").optString(0) + "|" + room.optJSONArray("members").optString(1);
            try {
                udp = new UdpPeer(host(), message.getInt("udpPort"), sid, message.getString("token"), master, binding, isHost(), new UdpPeer.Listener() {
                    private void dispatch(Runnable task) { handler.post(() -> { if (epoch == p2pGeneration && sid.equals(p2pId)) task.run(); }); }
                    public void local(JSONArray values) { dispatch(() -> sendServer(put(put(context("P2P_LOCAL"), "p2pId", sid), "candidates", values))); }
                    public void ready() { dispatch(() -> sendServer(put(context("P2P_READY"), "p2pId", sid))); }
                    public void message(JSONObject value) { dispatch(() -> peerMessage(value)); }
                    public void latency(long value) { dispatch(() -> { directLatency = value; networkChanged(); }); }
                    public void failed() { dispatch(GameService.this::fallback); }
                });
            } catch (Exception ex) { fallback(); }
            finally { Arrays.fill(master, (byte) 0); message.remove("key"); }
            return;
        }
        if (!sid.equals(p2pId)) return;
        if ("P2P_PEER".equals(type) && udp != null) udp.candidates(message.getJSONArray("candidates"));
        else if ("P2P_ACTIVE".equals(type) && udp != null) {
            direct = true; udp.activate(); networkChanged();
            if (isHost()) referee.syncState(); else sync();
        } else if ("P2P_RELAY".equals(type)) fallback(false);
    }

    private void receive(String text) {
        try { receive(new JSONObject(text)); }
        catch (JSONException ex) { notice(text.startsWith("{") ? "服务器状态格式异常" : text); }
    }
    private void receive(JSONObject message) {
        try {
            if (message.optString("type").startsWith("P2P_")) { p2pMessage(message); return; }
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
                    applyState(message);
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
                    if (message.optString("request").startsWith("P2P_")) { if (!message.optBoolean("ok")) fallback(); return; }
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
        } catch (JSONException | IllegalArgumentException ex) { notice("服务器状态格式异常"); }
    }
    private boolean matches(JSONObject message) {
        return room != null && room.optLong("roomId") == message.optLong("roomId")
                && room.optLong("version") == message.optLong("version")
                && room.optString("gameId").equals(message.optString("gameId"));
    }
    private void acceptRoom(JSONObject message) throws JSONException {
        if (room != null && room.optLong("roomId") == message.optLong("roomId")
                && message.optLong("version") <= room.optLong("version")) return;
        closeDirect(); p2pId = ""; p2pRequested = false; directActions.clear(); directRequests.clear();
        room = message; state = null; listingRooms = false;
        if (message.optBoolean("playing")) { lastResult = ""; outcome = null; }
        referee.room(message, selfId);
        if (playing() && !isHost() && room.optBoolean("p2pAvailable") && !p2pRequested) {
            p2pRequested = true; sendServer(context("P2P_REQUEST"));
        }
    }
    private static JSONObject json(String type) { return put(new JSONObject(), "type", type); }
    private static JSONObject put(JSONObject object, String key, Object value) {
        try { object.put(key, value); return object; }
        catch (JSONException ex) { throw new IllegalArgumentException(ex); }
    }
    private void changed() { if (observer != null) observer.changed(); }
    private void networkChanged() { if (observer != null) observer.networkChanged(); }
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
