package com.chessflipping.game;

import org.json.*;
import org.junit.jupiter.api.Test;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.jupiter.api.Assertions.*;

class HostControllerTest {
    @Test void retryAfterRouteChangeDoesNotExecuteMoveTwice() throws Exception {
        List<JSONObject> sent=new ArrayList<>();HostController host=new HostController(sent::add,()->1000L);
        host.room(room(false),"a");host.action(action("a",new JSONObject().put("type","READY").put("ready",true)));
        host.action(action("b",new JSONObject().put("type","READY").put("ready",true)));host.room(room(true),"a");
        int turn=sent.getLast().getJSONObject("state").getInt("turn");
        JSONObject move=action(turn==0?"a":"b",new JSONObject().put("type","MOVE").put("move",0).put("from",-1).put("to",0)).put("operationId","01234567890123456789012345678901");
        host.action(move);String board=sent.getLast().getJSONObject("state").getJSONArray("board").toString();
        move.put("requestId","new-server-forward-id");host.action(move);
        JSONObject reply=sent.getLast();assertTrue(reply.getBoolean("ok"));assertEquals("new-server-forward-id",reply.getString("requestId"));
        assertEquals(1,reply.getJSONObject("state").getLong("move"));assertEquals(board,reply.getJSONObject("state").getJSONArray("board").toString());
    }
    private static JSONObject room(boolean playing) {
        return new JSONObject().put("roomId", 1).put("version", playing ? 2 : 1).put("gameId", playing ? "game" : "")
                .put("playing", playing).put("hostId", "a").put("members", new JSONArray(List.of("a", "b")));
    }
    private static JSONObject action(String actor, JSONObject action) {
        return new JSONObject().put("requestId", UUID.randomUUID().toString()).put("actorId", actor).put("action", action);
    }
    @Test void deadlineOnlyRunsForActiveFiniteHostAndMovesRescheduleIt() throws Exception {
        List<JSONObject> sent = new ArrayList<>(); AtomicLong now = new AtomicLong(1000);
        HostController host = new HostController(sent::add, now::get);
        host.room(room(false), "a"); assertEquals(-1, host.nextTickDelay());
        host.action(action("a", new JSONObject().put("type", "READY").put("ready", true)));
        host.action(action("b", new JSONObject().put("type", "READY").put("ready", true)));
        assertEquals(-1, host.nextTickDelay());
        host.room(room(true), "a"); assertEquals(60000, host.nextTickDelay());
        now.set(10000); assertEquals(51000, host.nextTickDelay());
        host.action(action("a", new JSONObject().put("type", "SYNC"))); assertEquals(51000, host.nextTickDelay());
        int turn = sent.getLast().getJSONObject("state").getInt("turn");
        host.action(action(turn == 0 ? "a" : "b", new JSONObject().put("type", "MOVE").put("move", 0).put("from", -1).put("to", 0)));
        assertEquals(60000, host.nextTickDelay());
        now.set(70000); host.tick(); assertEquals("FINISH", sent.getLast().getString("type"));
        assertEquals(-1, host.nextTickDelay()); host.clear(); assertEquals(-1, host.nextTickDelay());
    }
    @Test void unlimitedGamesAndGuestsDoNotScheduleDeadlineCallbacks() throws Exception {
        HostController host = new HostController(value -> {}, () -> 1000L);
        host.room(room(false), "a"); host.action(action("a", new JSONObject().put("type", "TIME").put("seconds", 0)));
        host.action(action("a", new JSONObject().put("type", "READY").put("ready", true)));
        host.action(action("b", new JSONObject().put("type", "READY").put("ready", true)));
        host.room(room(true), "a"); assertEquals(-1, host.nextTickDelay());
        host.room(room(true), "b"); assertEquals(-1, host.nextTickDelay());
    }
}
