package com.chessflipping.game;

import org.json.*;
import java.security.SecureRandom;
import java.util.*;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/** Host authority, shared by the Android service and desktop end-to-end validation. */
public final class HostController {
    private final Consumer<JSONObject> send;
    private final LongSupplier clock;
    private final Set<String> ready = new HashSet<>();
    private JSONObject room;
    private String self = "";
    private GameEngine game;
    private int seconds = 60;
    private long sequence, move;
    private boolean starting, finishing;
    private String startId = "";
    // Results are tiny and scoped to one room generation; snapshots are produced only when needed.
    private final LinkedHashMap<String, String> completed = new LinkedHashMap<>();

    public HostController(Consumer<JSONObject> send, LongSupplier clock) { this.send = send; this.clock = clock; }
    public void clear() { room = null; game = null; ready.clear(); completed.clear(); starting = finishing = false; startId = ""; sequence = move = 0; }
    public void room(JSONObject next, String self) throws JSONException {
        boolean same = room != null && room.optLong("roomId") == next.optLong("roomId") && room.optLong("version") == next.optLong("version");
        boolean startedHere = starting && startId.equals(next.optString("startId")) && game != null;
        this.room = next; this.self = self; finishing = false;
        if (!same) { sequence = 0; completed.clear(); }
        if (!next.optBoolean("playing")) {
            game = null; starting = false; startId = "";
            if (!same) { ready.clear(); move = 0; }
            if (host()) publish();
        } else if (host()) {
            if ((!same && !startedHere) || game == null) {
                game = null;
                send.accept(context("FINISH").put("winnerId", next.getJSONArray("members").getString(1)).put("reason", "RESTORE_FAILED"));
                return;
            }
            starting = false; game.checkTimeout(clock.getAsLong());
            if (game.winner >= 0) finish(); else publish();
        }
    }
    public JSONObject save() throws JSONException {
        return new JSONObject().put("room", room).put("self", self).put("seconds", seconds).put("ready", new JSONArray(ready))
                .put("sequence", sequence).put("move", move).put("starting", starting).put("startId", startId)
                .put("completed", new JSONObject(completed)).put("game", game == null ? JSONObject.NULL : game.save());
    }
    public void restore(JSONObject saved) throws JSONException {
        clear(); room = saved.optJSONObject("room"); self = saved.optString("self"); seconds = saved.getInt("seconds");
        sequence = saved.getLong("sequence"); move = saved.getLong("move"); starting = saved.getBoolean("starting"); startId = saved.optString("startId");
        JSONArray names = saved.getJSONArray("ready"); for (int i = 0; i < names.length(); i++) ready.add(names.getString(i));
        JSONObject done = saved.getJSONObject("completed"); Iterator<String> keys = done.keys();
        while (keys.hasNext()) { String key = keys.next(); completed.put(key, done.getString(key)); }
        if (saved.optJSONObject("game") != null) game = new GameEngine(saved.getJSONObject("game"));
    }
    public boolean needsTick() {
        return host() && room.optBoolean("playing") && game != null && game.seconds > 0 && !finishing;
    }
    public long nextTickDelay() { return needsTick() ? Math.max(1, game.remaining(clock.getAsLong())) : -1; }
    public void tick() throws JSONException { if (needsTick() && game.checkTimeout(clock.getAsLong())) finish(); }
    public void failed(String command) { if ("START".equals(command)) { starting = false; game = null; } }
    private boolean host() { return room != null && self.equals(room.optString("hostId")); }

    public void action(JSONObject message) throws JSONException {
        if (!host() || !message.optString("operationId").matches("[0-9a-f]{32}")) return;
        JSONObject action = message.getJSONObject("action");
        String actor = message.getString("actorId"), kind = action.optString("type"), error = null;
        String operation = message.optString("operationId"), identity = actor + ":" + operation;
        if (!operation.isEmpty() && completed.containsKey(identity)) {
            String previous = completed.get(identity);
            JSONObject reply = context("HOST_REPLY").put("targetId", actor).put("operationId", operation).put("ok", previous.isEmpty());
            if (previous.isEmpty()) reply.put("state", snapshot(++sequence)); else reply.put("error", previous);
            send.accept(reply); return;
        }
        JSONArray members = room.getJSONArray("members");
        int player = -1;
        for (int i = 0; i < members.length(); i++) if (members.getString(i).equals(actor)) player = i;
        if (player < 0) error = "你已不在该房间";
        else if ("SYNC".equals(kind)) { /* Snapshot refresh never resets the turn clock. */ }
        else if (room.optBoolean("playing")) {
            if (!"MOVE".equals(kind) || game == null) error = "当前操作不可用";
            else if (action.optLong("move", -1) != move) error = "棋面已更新，请重新选择";
            else {
                error = game.act(player, action.optInt("from", -2), action.optInt("to", -1), clock.getAsLong());
                if (error == null) move++;
            }
        } else if (starting) error = "正在开始对局";
        else if ("READY".equals(kind)) {
            if (action.optBoolean("ready")) ready.add(actor); else ready.remove(actor);
        } else if ("TIME".equals(kind)) {
            int choice = action.optInt("seconds", -1);
            if (!actor.equals(room.getString("hostId"))) error = "只有房主可设置时间";
            else if (choice != 0 && choice != 30 && choice != 60 && choice != 90) error = "时间选项无效";
            else { seconds = choice; ready.clear(); }
        } else error = "未知操作";
        JSONObject reply = context("HOST_REPLY").put("targetId", actor).put("ok", error == null);
        if (!operation.isEmpty()) {
            reply.put("operationId", operation); completed.put(identity, error == null ? "" : error);
            if (completed.size() > 128) completed.remove(completed.keySet().iterator().next());
        }
        if (error == null) reply.put("state", snapshot(++sequence)); else reply.put("error", error);
        send.accept(reply);
        if (room.optBoolean("playing") && game != null && game.winner >= 0) finish();
        else if (!room.optBoolean("playing") && !starting && members.length() == 2
                && ready.contains(members.getString(0)) && ready.contains(members.getString(1))) {
            starting = true; move = 0; startId = UUID.randomUUID().toString().replace("-", "");
            game = new GameEngine(new SecureRandom(), seconds); game.start(clock.getAsLong());
            send.accept(context("START").put("operationId", startId));
        }
    }
    private JSONObject snapshot(long seq) throws JSONException {
        JSONObject result = new JSONObject().put("seq", seq).put("seconds", seconds);
        JSONObject readiness = new JSONObject();
        for (String id : ready) readiness.put(id, true);
        result.put("ready", readiness);
        if (game != null) {
            result.put("board", new JSONArray(game.publicBoard())).put("colors", new JSONArray(game.colors))
                    .put("turn", game.turn).put("remaining", game.remaining(clock.getAsLong()))
                    .put("move", move).put("captured", new JSONArray(game.captured))
                    .put("lastFrom", game.lastFrom).put("lastTo", game.lastTo).put("winner", game.winner);
        }
        return result;
    }
    private JSONObject context(String type) throws JSONException {
        return new JSONObject().put("type", type).put("roomId", room.getLong("roomId"))
                .put("version", room.getLong("version")).put("gameId", room.optString("gameId"));
    }
    private void publish() throws JSONException { send.accept(context("HOST_STATE").put("state", snapshot(++sequence))); }
    public void syncState() throws JSONException { if (host()) publish(); }
    private void finish() throws JSONException {
        if (finishing || game == null || game.winner < 0 || !room.optBoolean("playing")) return;
        finishing = true;
        // Finish travels through the server: publish the final public snapshot on that same ordered path.
        send.accept(context("HOST_STATE").put("finalState", true).put("state", snapshot(++sequence)));
        send.accept(context("FINISH").put("winnerId", room.getJSONArray("members").getString(game.winner)).put("reason", game.reason));
    }
}
