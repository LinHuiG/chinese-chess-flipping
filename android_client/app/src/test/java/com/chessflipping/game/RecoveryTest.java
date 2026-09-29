package com.chessflipping.game;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;

public class RecoveryTest {
    @Test public void privateBoardHistoryAndDeadlineSurviveProcessRestart() throws Exception {
        GameEngine game=new GameEngine(new Random(5),30);game.start(1000);
        assertNull(game.act(game.turn,-1,0,2000));
        JSONObject data=new JSONObject(game.save().toString());GameEngine resumed=new GameEngine(data);
        assertArrayEquals(game.pieces,resumed.pieces);assertArrayEquals(game.revealed,resumed.revealed);
        assertEquals(game.save().getJSONArray("history").toString(),resumed.save().getJSONArray("history").toString());
        assertEquals(20000,resumed.remaining(12000));assertTrue(resumed.checkTimeout(32000));assertEquals("TIMEOUT",resumed.reason);
    }
    @Test public void lostReplyAndTransportRetryDoNotRepeatMove() throws Exception {
        AtomicLong time=new AtomicLong(1000);ArrayList<JSONObject> sent=new ArrayList<>();HostController host=new HostController(sent::add,time::get);
        JSONObject room=new JSONObject().put("roomId",1).put("version",2).put("gameId","").put("hostId","host").put("members",new JSONArray(List.of("host","guest"))).put("playing",false);
        host.room(room,"host");
        for(String actor:List.of("host","guest"))host.action(new JSONObject().put("actorId",actor).put("operationId",UUID.randomUUID().toString().replace("-", "")).put("action",new JSONObject().put("type","READY").put("ready",true)));
        String start=sent.stream().filter(m->m.optString("type").equals("START")).findFirst().orElseThrow().getString("operationId");
        room=new JSONObject(room.toString()).put("version",3).put("gameId","3").put("playing",true).put("startId",start);host.room(room,"host");
        JSONObject saved=host.save();int turn=saved.getJSONObject("game").getInt("turn");
        JSONObject move=new JSONObject().put("actorId",turn==0?"host":"guest").put("operationId","12345678901234567890123456789012").put("action",new JSONObject().put("type","MOVE").put("from",-1).put("to",0).put("move",0));
        time.set(2000);host.action(move);JSONObject committed=new JSONObject(host.save().toString());
        HostController resumed=new HostController(sent::add,time::get);resumed.restore(committed);time.set(7000);resumed.room(room,"host");resumed.action(move);
        assertEquals(1,resumed.save().getLong("move"));assertEquals(committed.getJSONObject("game").getLong("deadline"),resumed.save().getJSONObject("game").getLong("deadline"));
        assertEquals(55000,sent.get(sent.size()-1).getJSONObject("state").getLong("remaining"));
        time.set(62000);resumed.tick();assertEquals("FINISH",sent.get(sent.size()-1).getString("type"));assertEquals("TIMEOUT",sent.get(sent.size()-1).getString("reason"));
    }
}
