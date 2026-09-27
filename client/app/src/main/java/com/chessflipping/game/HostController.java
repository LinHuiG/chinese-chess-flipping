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

    public HostController(Consumer<JSONObject> send, LongSupplier clock) { this.send = send; this.clock = clock; }
    public void clear() { room = null; game = null; ready.clear(); starting = finishing = false; sequence = move = 0; }
    public void room(JSONObject room, String self) throws JSONException {
        this.room = room; this.self = self; sequence = 0; finishing = false;
        if (!room.optBoolean("playing")) {
            game = null; starting = false; ready.clear(); move = 0;
            if (host()) publish();
        } else if (host() && game != null) {
            starting = false; game.start(clock.getAsLong()); publish();
        }
    }
    public boolean needsTick() {
        return host() && room.optBoolean("playing") && game != null && game.seconds > 0 && !finishing;
    }
    public void tick() throws JSONException { if (needsTick() && game.checkTimeout(clock.getAsLong())) finish(); }
    public void failed(String command) { if ("START".equals(command)) { starting = false; game = null; } }
    private boolean host() { return room != null && self.equals(room.optString("hostId")); }

    public void action(JSONObject message) throws JSONException {
        if (!host()) return;
        JSONObject action = message.getJSONObject("action");
        String actor = message.getString("actorId"), kind = action.optString("type"), error = null;
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
        JSONObject reply = context("HOST_REPLY").put("requestId", message.getString("requestId")).put("ok", error == null);
        if (error == null) reply.put("state", snapshot(++sequence)); else reply.put("error", error);
        send.accept(reply);
        if (room.optBoolean("playing") && game != null && game.winner >= 0) finish();
        else if (!room.optBoolean("playing") && !starting && members.length() == 2
                && ready.contains(members.getString(0)) && ready.contains(members.getString(1))) {
            starting = true; move = 0; game = new GameEngine(new SecureRandom(), seconds);
            send.accept(context("START").put("state", snapshot(0)));
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
    private void finish() throws JSONException {
        if (finishing || game == null || game.winner < 0 || !room.optBoolean("playing")) return;
        finishing = true;
        send.accept(context("FINISH").put("winnerId", room.getJSONArray("members").getString(game.winner)).put("reason", game.reason));
    }
}
