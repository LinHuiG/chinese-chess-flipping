package com.chessflipping.client;

import android.app.*;
import android.content.*;
import android.os.*;
import android.net.*;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import com.chessflipping.game.HostController;
import org.json.*;
import java.util.*;

/** Owns the connection and host referee independently of Activity/lock-screen lifetime. */
public final class GameService extends Service {
    public static final String DEFAULT_HOST = "fqgame.tdcode.tech";
    public static final int DEFAULT_PORT = 8888;
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
    public AppUpdater updater;
    private boolean updateChecked;
    private UdpPeer udp;
    private String p2pId = "";
    private int p2pGeneration;
    private boolean p2pRequested;
    private JSONObject pendingAction;
    private int actionAttempts, p2pAttempts;
    private boolean synced, loaded, storageFailed;
    private String token = "", bootId = "";
    private final Map<String,String> names = new HashMap<>();
    private final ArrayDeque<String> diagnostics = new ArrayDeque<>();
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    private ConnectivityManager connectivity;
    private String network = "";
    private final Runnable punchRetry = this::tryP2p;
    private final Runnable actionDeadline = () -> {
        if (pendingAction == null || !connected) return;
        if (direct) fallback();
        else if (++actionAttempts <= 3) { sendServer(pendingAction); handler.postDelayed(this.actionDeadline, 5000); }
        else notice("操作尚未确认，请刷新同步或退出房间");
    };
    private final ConnectivityManager.NetworkCallback networks = new ConnectivityManager.NetworkCallback() {
        @Override public void onLinkPropertiesChanged(Network n, LinkProperties properties) {
            String value = n.toString() + properties.getLinkAddresses().toString();
            handler.post(() -> {
                boolean changed = !network.isEmpty() && !network.equals(value); network = value;
                if (changed) {
                    p2pAttempts = 0; fallback();
                    if (client != null) client.close();
                    handler.removeCallbacks(retry); if (foreground && enabled) handler.postDelayed(retry, 1500);
                }
            });
        }
    };
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
        updater = new AppUpdater(this, this::sendServer, this::changed);
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("game", "联机游戏连接", NotificationManager.IMPORTANCE_LOW));
        wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "chessflipping:connection");
        wakeLock.setReferenceCounted(false);
        connectivity = getSystemService(ConnectivityManager.class);
        connectivity.registerDefaultNetworkCallback(networks);
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
        long delay = connected && synced ? referee.nextTickDelay() : -1;
        if (delay >= 0) handler.postDelayed(tick, delay);
    }
    public String host() { return preferences().getString("host", DEFAULT_HOST); }
    public int port() { return preferences().getInt("port", DEFAULT_PORT); }
    public String transport() { return preferences().getString("transport", "TCP"); }
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
        if (!loaded) { loadSaved(); loaded = true; }
        JSONObject identity = put(put(json("IDENTITY"), "userId", selfId), "token", token);
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
            public void onAppChunk(JSONObject header, byte[] bytes) { dispatch(() -> updater.chunk(header, bytes)); }
            public void onClosed(String reason) { dispatch(() -> {
                updater.connectionLost();
                client = null; connected = false; synced = false; serverLatency = -1; closeDirect(); rooms.clear(); listing.clear(); listingRooms = false;
                handler.removeCallbacks(tick); handler.removeCallbacks(actionDeadline); roomsRevision++;
                if (wakeLock.isHeld()) wakeLock.release();
                status = reason + (foreground && enabled ? "，3 秒后重连" : "");
                changed();
                if (foreground && enabled) handler.postDelayed(retry, 3000);
            }); }
        };
        client = transport().equals("TCP") ? new TcpClient(identity, listener)
                : new WsClient(identity, transport().equals("HTTPS"), listener);
        client.connect(host(), port());
    }
    public void disconnect() {
        if (updater.busy) updater.cancel("已取消更新");
        enabled = false; generation++; handler.removeCallbacks(retry);
        if (client != null) { if (connected) client.request(json("LOGOUT")); else client.close(); }
        client = null; connected = false; synced = false; serverLatency = -1;
        clearRoom(); selfId = token = bootId = ""; rooms.clear(); listing.clear(); listingRooms = false;
        save(null); outcome = null; roomsRevision++; status = "已断开连接";
        if (wakeLock.isHeld()) wakeLock.release();
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); changed();
    }
    public void saveServer(String host, int port) {
        saveServer(host, port, "TCP");
    }
    public void saveServer(String host, int port, String transport) {
        String previous = endpoint();
        disconnect();
        preferences().edit().putString("host", host).putInt("port", port).putString("transport", transport).apply();
        loaded = previous.equals(endpoint());
    }
    private void clearRoom() {
        closeDirect(); p2pId = ""; p2pRequested = false; p2pAttempts = 0; pendingAction = null; handler.removeCallbacks(actionDeadline); handler.removeCallbacks(punchRetry);
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
    public void checkUpdate() {
        if (transport().equals("TCP") && !connected) { notice("请先连接 TCP 服务器"); return; }
        updater.check(host(), port(), transport());
    }
    public void listRooms() {
        if (!connected || room != null || listingRooms) return;
        listing.clear(); listingRooms = true; send(json("LIST")); changed();
    }
    public void createRoom(String name) { send(put(json("CREATE"), "name", name)); }
    public void join(long id) { send(put(json("JOIN"), "roomId", id)); }
    public void leave() { send(json("LEAVE")); }
    public void dissolve() { send(context("DISSOLVE")); }
    public void sync() {
        if (!connected || room == null) return;
        if (pendingAction != null) { actionAttempts = 0; sendServer(pendingAction); handler.removeCallbacks(actionDeadline); handler.postDelayed(actionDeadline, 5000); }
        else if (isHost()) { try { referee.syncState(); } catch (JSONException ex) { notice("状态同步失败"); } }
        else action(json("SYNC"));
    }
    public void ready(boolean value) { action(put(json("READY"), "ready", value)); }
    public void timeLimit(int value) { action(put(json("TIME"), "seconds", value)); }
    public void move(int from, int to) {
        JSONObject action = put(put(json("MOVE"), "from", from), "to", to);
        put(action, "move", state == null ? -1 : state.optLong("move"));
        action(action);
    }
    private void action(JSONObject action) {
        if (!connected || room == null || storageFailed) { notice("连接正在恢复"); return; }
        if (!"SYNC".equals(action.optString("type")) && !canAct()) { notice("等待双方完成重连同步"); return; }
        if (pendingAction != null) { notice("上一步正在确认，请稍候"); return; }
        JSONObject request = put(put(context("ACTION"), "action", action), "operationId", UUID.randomUUID().toString().replace("-", ""));
        pendingAction = request; actionAttempts = 0;
        save(() -> deliverAction(request));
    }
    private void deliverAction(JSONObject request) {
        if (!connected || request != pendingAction) return;
        if (isHost()) {
            try { referee.action(put(request, "actorId", selfId)); scheduleTick(); }
            catch (JSONException ex) { notice("操作处理失败"); }
        } else if (!sendDirect(request)) sendServer(request);
        handler.removeCallbacks(actionDeadline); if (pendingAction != null) handler.postDelayed(actionDeadline, direct ? 3500 : 5000);
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
        String kind = request.optString("type");
        if (!kind.equals("HOST_REPLY") && !kind.equals("HOST_STATE") && !kind.equals("START") && !kind.equals("FINISH")) {
            sendServer(request); return;
        }
        // Save the referee and operation result before exposing a committed move to either peer.
        save(() -> {
            if (!connected || (request.has("roomId") && !matches(request))) return;
            String type = request.optString("type");
            if ("HOST_REPLY".equals(type) || "HOST_STATE".equals(type)) {
                if ("HOST_REPLY".equals(type)) acceptReply(request); else applyState(request);
                if (!request.optBoolean("ok", true) && selfId.equals(request.optString("targetId"))) return;
                if (room.optJSONArray("members").length() == 2) {
                    if (request.optBoolean("finalState") || !sendDirect(request)) sendServer(request);
                }
            } else sendServer(request);
            scheduleTick(); changed();
        });
    }
    private boolean sendDirect(JSONObject value) {
        if (!connected || !direct || udp == null) return false;
        try { return udp.send(com.chessflipping.protocol.WireProtocol.plain(GameConnection.packet(value))); }
        catch (Exception ex) { return false; }
    }
    private void applyState(JSONObject message) {
        if (!matches(message)) return;
        JSONObject next = message.optJSONObject("state"); if (next == null) return;
        if (state == null || next.optLong("seq") > state.optLong("seq") || !synced) {
            state = next; stateReceivedAt = SystemClock.elapsedRealtime();
            if (!synced) { synced = true; sendServer(json("AVAILABLE")); }
        }
    }
    private void acceptReply(JSONObject message) {
        if (message.optBoolean("ok")) applyState(message);
        String operation = message.optString("operationId");
        if (pendingAction != null && operation.equals(pendingAction.optString("operationId"))) {
            pendingAction = null; handler.removeCallbacks(actionDeadline);
            if (!message.optBoolean("ok")) notice(message.optString("error", "操作无效"));
        }
    }
    private void peerMessage(JSONObject message) throws JSONException {
        if (!matches(message) || room == null) return;
        JSONArray members = room.getJSONArray("members");
        message.put("actorId", members.getString(isHost() ? 1 : 0)); receive(message);
    }
    private void closeDirect() {
        p2pGeneration++; if (udp != null) udp.close(); udp = null; direct = false; directLatency = -1;
        networkChanged();
    }
    private void fallback() { fallback(true); }
    private void fallback(boolean signal) {
        String previous = p2pId; boolean existed = udp != null || direct;
        closeDirect(); p2pId = ""; p2pRequested = false;
        if (connected && room != null && signal && !previous.isEmpty()) sendServer(put(context("P2P_STOP"), "p2pId", previous));
        if (connected && room != null) {
            if (pendingAction != null) sendServer(pendingAction);
            if (existed && isHost()) try { referee.syncState(); } catch (JSONException ignored) { }
            handler.removeCallbacks(punchRetry); if (p2pAttempts < 2) handler.postDelayed(punchRetry, 3000);
        }
    }
    private void tryP2p() {
        if (connected && synced && playing() && canAct() && room.optBoolean("p2pAvailable") && !p2pRequested && udp == null && p2pAttempts < 2) {
            p2pAttempts++; p2pRequested = true; sendServer(context("P2P_REQUEST"));
        }
    }
    private void p2pMessage(JSONObject message) throws JSONException {
        if (!matches(message)) return;
        String type = message.optString("type"), sid = message.optString("p2pId");
        if (!sid.matches("[0-9a-f]{32}")) return;
        if ("P2P_OFFER".equals(type) && isHost()) {
            if (!p2pRequested) p2pAttempts++; p2pId = sid; p2pRequested = true; byte[] master = new byte[32]; new java.security.SecureRandom().nextBytes(master);
            sendServer(put(put(context("P2P_KEY"), "p2pId", sid), "key", Base64.getEncoder().encodeToString(master)));
            Arrays.fill(master, (byte) 0); return;
        }
        if ("P2P_CONFIG".equals(type)) {
            if (udp != null && sid.equals(p2pId)) return;
            if (!p2pRequested) p2pAttempts++; p2pRequested = true; closeDirect(); p2pId = sid; final int epoch = p2pGeneration;
            byte[] master = Base64.getDecoder().decode(message.getString("key"));
            String binding = sid + "|" + room.optLong("roomId") + "|" + room.optLong("version") + "|" + room.optString("gameId")
                    + "|" + room.optJSONArray("members").optString(0) + "|" + room.optJSONArray("members").optString(1);
            try {
                udp = new UdpPeer(host(), message.getInt("udpPort"), sid, message.getString("token"), master, binding, isHost(), new UdpPeer.Listener() {
                    private void dispatch(Runnable task) { handler.post(() -> { if (epoch == p2pGeneration && sid.equals(p2pId)) task.run(); }); }
                    public void local(JSONArray values) { dispatch(() -> sendServer(put(put(context("P2P_LOCAL"), "p2pId", sid), "candidates", values))); }
                    public void ready() { dispatch(() -> sendServer(put(context("P2P_READY"), "p2pId", sid))); }
                    public void message(JSONObject value) { dispatch(() -> { try { peerMessage(value); } catch (JSONException ex) { fallback(); } }); }
                    public void latency(long value) { dispatch(() -> { directLatency = value; networkChanged(); }); }
                    public void failed(String reason) { dispatch(() -> { diagnostic(reason); fallback(); }); }
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
                    if (!message.optBoolean("resumed") || !bootId.equals(message.optString("bootId"))) { clearRoom(); resultGameId = ""; }
                    selfId = message.getString("selfId"); token = message.getString("token"); bootId = message.getString("bootId");
                    listingRooms = false; p2pAttempts = 0; profile(); save(null);
                    if (!message.optBoolean("inRoom")) {
                        clearRoom(); sendServer(json("AVAILABLE")); listRooms();
                        if (!updateChecked && preferences().getBoolean("autoUpdate", true)) { updateChecked = true; checkUpdate(); }
                    }
                    break;
                case "APP_VERSION": updater.info(message); break;
                case "PROFILE_REQUEST": profile(); break;
                case "PROFILE": names.put(message.getString("userId"), message.getString("name")); break;
                case "PRESENCE":
                    if (matches(message)) { room.put("presence", message.getJSONObject("presence")); tryP2p(); }
                    break;
                case "ACTION":
                    if (matches(message) && isHost() && synced) referee.action(message);
                    break;
                case "HOST_REPLY": if (matches(message) && room.optString("hostId").equals(message.optString("actorId"))) { acceptReply(message); save(null); } break;
                case "HOST_STATE": if (matches(message) && room.optString("hostId").equals(message.optString("actorId"))) { applyState(message); save(null); } break;
                case "ECHO": if (message.has("message")) notice(message.optString("message")); break;
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
                    clearRoom(); save(null); listingRooms = false; sendServer(json("AVAILABLE")); listRooms(); break;
                case "GAME_OVER": finishResult(message); break;
                case "RESULT":
                    if (message.optString("request").startsWith("P2P_")) { if (!message.optBoolean("ok")) { diagnostic("SIGNAL_REJECTED"); fallback(); } return; }
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
        if (room != null && room.optLong("roomId") == message.optLong("roomId") && message.optLong("version") < room.optLong("version")) return;
        boolean same = matches(message);
        closeDirect(); p2pId = ""; p2pRequested = false;
        if (!same) { pendingAction = null; state = null; p2pAttempts = 0; handler.removeCallbacks(actionDeadline); }
        room = message; synced = false; listingRooms = false;
        if (message.optJSONObject("lastResult") != null) finishResult(message.getJSONObject("lastResult"));
        else if (message.optBoolean("playing")) lastResult = "";
        referee.room(message, selfId);
        JSONArray members = message.getJSONArray("members");
        names.keySet().removeIf(id -> !id.equals(members.optString(0)) && !id.equals(members.optString(1)));
        if (pendingAction != null) { actionAttempts = 0; JSONObject retryAction = pendingAction; save(() -> deliverAction(retryAction)); }
        else if (!isHost()) action(json("SYNC"));
        save(null);
    }
    private void finishResult(JSONObject message) {
        String key = message.optLong("roomId") + ":" + message.optString("gameId");
        if (key.equals(resultGameId)) return;
        resultGameId = key;
        boolean won = selfId.equals(message.optString("winnerId")); String why = reason(message.optString("reason"));
        lastResult = (won ? "你赢了" : "本局落败") + " · " + why;
        outcome = new Outcome(won, why, foreground && connected); save(null);
    }
    public String nickname() {
        String value = preferences().getString("nickname", "");
        return value.isEmpty() ? "玩家" + (selfId.length() >= 4 ? selfId.substring(0,4) : "") : value;
    }
    public void nickname(String value) { preferences().edit().putString("nickname", value.trim()).apply(); profile(); changed(); }
    private void profile() { names.put(selfId, nickname()); if (connected) sendServer(put(json("PROFILE"), "name", nickname())); }
    public String memberName(String id) { return id.equals(selfId) ? nickname() : names.getOrDefault(id, "玩家" + id.substring(0, Math.min(4, id.length()))); }
    public String memberStatus(String id) {
        if (!connected) return id.equals(selfId) ? "重连中" : "状态待确认";
        String value = room == null || room.optJSONObject("presence") == null ? "syncing" : room.optJSONObject("presence").optString(id, "offline");
        return switch (value) { case "online" -> "在线"; case "suspect" -> "连接异常"; case "syncing" -> "同步中"; default -> "重连中"; };
    }
    public boolean canAct() {
        if (!connected || !synced || room == null || storageFailed) return false;
        JSONArray members = room.optJSONArray("members");
        for (int i=0; i<members.length(); i++) if (!"在线".equals(memberStatus(members.optString(i)))) return false;
        return true;
    }
    private AtomicFile saveFile() { return new AtomicFile(new File(getFilesDir(), "session-" + Integer.toHexString(endpoint().hashCode()) + ".json")); }
    private void save(Runnable after) {
        if (storageFailed) return;
        try {
            JSONObject value = new JSONObject().put("endpoint", endpoint()).put("self", selfId).put("token", token).put("boot", bootId)
                    .put("room", room).put("state", state).put("referee", referee.save()).put("pending", pendingAction)
                    .put("stateAt", stateReceivedAt).put("diagnostics", new JSONArray(diagnostics)).put("resultGame", resultGameId).put("names", new JSONObject(names)).put("elapsed", SystemClock.elapsedRealtime());
            byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
            AtomicFile file = saveFile(); int current = generation;
            storage.execute(() -> {
                FileOutputStream stream = null;
                try { stream = file.startWrite(); stream.write(bytes); file.finishWrite(stream); }
                catch (Exception ex) { if (stream != null) file.failWrite(stream); handler.post(() -> { storageFailed = true; notice("本地存档失败，已停止提交新操作"); changed(); }); return; }
                if (after != null) handler.post(() -> { if (current == generation && !storageFailed) after.run(); });
            });
        } catch (Exception ex) { storageFailed = true; notice("本地存档失败，已停止提交新操作"); }
    }
    private void loadSaved() {
        try {
            AtomicFile file = saveFile(); if (!file.getBaseFile().exists()) return;
            JSONObject value = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
            if (!endpoint().equals(value.optString("endpoint"))) return;
            selfId = value.optString("self"); token = value.optString("token"); bootId = value.optString("boot");
            room = value.optJSONObject("room"); state = value.optJSONObject("state"); pendingAction = value.optJSONObject("pending");
            resultGameId = value.optString("resultGame"); stateReceivedAt = value.optLong("stateAt");
            JSONArray logs=value.optJSONArray("diagnostics"); if(logs!=null) for(int i=0;i<Math.min(20,logs.length());i++) diagnostics.addLast(logs.getString(i));
            // A device reboot invalidates the monotonic deadline; do not grant a fresh turn.
            if (SystemClock.elapsedRealtime() < value.optLong("elapsed")) { clearRoom(); notice("设备已重启，原棋局无法恢复"); return; }
            referee.restore(value.getJSONObject("referee"));
            JSONObject n = value.optJSONObject("names"); if (n != null) { Iterator<String> keys = n.keys(); while (keys.hasNext()) { String key = keys.next(); names.put(key,n.getString(key)); } }
        } catch (Exception ex) { clearRoom(); notice("本地棋局存档无法读取"); }
    }
    private void diagnostic(String reason) {
        if (diagnostics.size() >= 20) diagnostics.removeFirst(); diagnostics.addLast(reason); save(null);
    }
    public String diagnostics() { return diagnostics.isEmpty() ? "尚无直连失败记录" : String.join("\n", diagnostics); }
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
            case "RESTORE_FAILED" -> "房主棋局存档无法恢复";
            case "NO_PIECES" -> "一方棋子已全部被吃";
            case "NO_MOVES" -> "没有合法行动";
            case "HOST_DISSOLVED" -> "房主认输并解散房间";
            case "DISCONNECTED" -> "断线超过 60 秒";
            default -> "对局中退出房间";
        };
    }
    @Override public void onDestroy() {
        observer = null; enabled = false; generation++;
        if (client != null) client.close(); client = null; closeDirect();
        if (wakeLock.isHeld()) wakeLock.release();
        connectivity.unregisterNetworkCallback(networks); storage.shutdown(); updater.close();
        handler.removeCallbacksAndMessages(null); super.onDestroy();
    }
}
