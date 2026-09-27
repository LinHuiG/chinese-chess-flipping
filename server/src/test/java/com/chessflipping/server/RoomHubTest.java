package com.chessflipping.server;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;

class RoomHubTest {
    @Test void snapshotCanRecoverAfterExpiredReplyWithoutAcceptingReplay() throws Exception {
        RoomHub hub = new RoomHub(); Peer peer = new Peer(); var host = hub.register("host", peer);
        send(hub, host, request("CREATE").put("name", "恢复"));
        ObjectNode action = context("ACTION", peer); action.set("action", request("SYNC")); send(hub, host, action);
        String id = peer.last("FORWARD").path("requestId").asText();
        var expire = RoomHub.class.getDeclaredMethod("expireRequest", String.class); expire.setAccessible(true); expire.invoke(hub, id);
        ObjectNode late = context("HOST_REPLY", peer).put("requestId", id).put("ok", true);
        late.set("state", request("SNAPSHOT").put("seq", 1)); send(hub, host, late);
        assertFalse(peer.replies.getLast().path("ok").asBoolean());
        ObjectNode refresh = context("HOST_STATE", peer); refresh.set("state", request("SNAPSHOT").put("seq", 2));
        send(hub, host, refresh); assertTrue(peer.replies.getLast().path("ok").asBoolean());
        assertEquals(2, peer.last("STATE").path("state").path("seq").asLong());
        send(hub, host, refresh); assertFalse(peer.replies.getLast().path("ok").asBoolean());
        hub.disconnect(host);
    }
    @Test void oversizedStartDoesNotChangeRoomOrBroadcastState() {
        RoomHub hub = new RoomHub(); Peer hp = new Peer(), gp = new Peer();
        var h = hub.register("h", hp); var g = hub.register("g", gp);
        send(hub, h, request("CREATE").put("name", "大小限制"));
        send(hub, g, request("JOIN").put("roomId", hp.last("ROOM").path("roomId").asLong()));
        ObjectNode start = context("START", hp); start.set("state", request("SNAPSHOT").put("seq", 0).put("padding", "x".repeat(48000)));
        send(hub, h, start); assertFalse(hp.replies.getLast().path("ok").asBoolean());
        assertFalse(hp.last("ROOM").path("playing").asBoolean());
        assertTrue(gp.events.stream().noneMatch(event -> "STATE".equals(event.path("type").asText())));
        hub.disconnect(h); hub.disconnect(g);
    }
    static class Peer implements RoomHub.Peer {
        final List<ObjectNode> events = new CopyOnWriteArrayList<>(), replies = new CopyOnWriteArrayList<>();
        boolean closed;
        public void event(ObjectNode e) { events.add(e.deepCopy()); }
        public void reply(String tid, ObjectNode e) { replies.add(e.deepCopy()); }
        public void close() { closed = true; }
        ObjectNode last(String type) { return events.stream().filter(e -> type.equals(e.path("type").asText())).reduce((a,b) -> b).orElseThrow(); }
    }
    static ObjectNode request(String type) { return RoomHub.node(type); }
    static ObjectNode context(String type, Peer peer) {
        ObjectNode room = peer.last("ROOM");
        return request(type).put("roomId", room.path("roomId").asLong()).put("version", room.path("version").asLong()).put("gameId", room.path("gameId").asText());
    }
    static void send(RoomHub hub, RoomHub.Session user, ObjectNode request) { hub.handle(user, UUID.randomUUID().toString(), request); }

    @Test void concurrentJoinOnlyOneSucceedsAndEmptyRoomIsDeleted() throws Exception {
        RoomHub hub = new RoomHub(); Peer host = new Peer(); var owner = hub.register("host", host);
        send(hub, owner, request("CREATE").put("name", "  房间  "));
        long id = host.last("ROOM").path("roomId").asLong();
        assertEquals("房间", host.last("ROOM").path("name").asText());
        List<RoomHub.Session> users = new ArrayList<>(); List<Peer> peers = new ArrayList<>();
        try (ExecutorService pool = Executors.newFixedThreadPool(4)) {
            List<Future<?>> work = new ArrayList<>();
            for (int i = 0; i < 20; i++) {
                Peer peer = new Peer(); var user = hub.register("u" + i, peer); users.add(user); peers.add(peer);
                work.add(pool.submit(() -> send(hub, user, request("JOIN").put("roomId", id))));
            }
            for (Future<?> future : work) future.get();
        }
        assertEquals(1, peers.stream().filter(p -> p.replies.get(0).path("ok").asBoolean()).count());
        hub.disconnect(owner); for (var user : users) hub.disconnect(user);
        Peer observer = new Peer(); var online = hub.register("observe", observer); send(hub, online, request("LIST"));
        assertEquals(0, observer.replies.get(0).path("rooms").size());
    }
    @Test void replacementCleansOldSessionAndLateCloseCannotDeleteNewOne() {
        RoomHub hub = new RoomHub(); Peer old = new Peer(), replacement = new Peer();
        var one = hub.register("same", old); send(hub, one, request("CREATE").put("name", "替换"));
        var two = hub.register("same", replacement);
        assertTrue(old.closed); assertFalse(hub.active(one)); assertTrue(hub.active(two));
        hub.disconnect(one); assertTrue(hub.active(two)); send(hub, two, request("LIST"));
        assertEquals(0, replacement.replies.get(0).path("rooms").size());
    }
    @Test void forwardPermissionsStaleMessagesAndPlayingDisconnectAreHandled() {
        RoomHub hub = new RoomHub(); Peer host = new Peer(), guest = new Peer();
        var h = hub.register("h", host); var g = hub.register("g", guest);
        send(hub, h, request("CREATE").put("name", "对局"));
        send(hub, g, request("JOIN").put("roomId", host.last("ROOM").path("roomId").asLong()));
        ObjectNode action = context("ACTION", guest); action.set("action", request("READY").put("ready", true)); send(hub, g, action);
        ObjectNode forward = host.last("FORWARD");
        ObjectNode response = context("HOST_REPLY", guest).put("requestId", forward.path("requestId").asText()).put("ok", false);
        send(hub, g, response); assertFalse(guest.replies.getLast().path("ok").asBoolean());
        ObjectNode start = context("START", host); start.set("state", request("SNAPSHOT").put("seq", 0)); send(hub, h, start);
        assertTrue(host.last("ROOM").path("playing").asBoolean());
        send(hub, g, action); assertFalse(guest.replies.getLast().path("ok").asBoolean());
        hub.disconnect(h);
        assertEquals(g.id, guest.last("GAME_OVER").path("winnerId").asText());
        assertEquals(g.id, guest.last("ROOM").path("hostId").asText());
        assertFalse(guest.last("ROOM").path("playing").asBoolean());
        long endings = guest.events.stream().filter(e -> "GAME_OVER".equals(e.path("type").asText())).count();
        hub.disconnect(h); assertEquals(endings, guest.events.stream().filter(e -> "GAME_OVER".equals(e.path("type").asText())).count());
        hub.disconnect(g);
    }
    @Test void listPaginationAndUnicodeRoomNames() {
        RoomHub hub = new RoomHub(); List<RoomHub.Session> owners = new ArrayList<>();
        for (int i = 0; i < 70; i++) {
            Peer peer = new Peer(); var user = hub.register("u" + i, peer); owners.add(user);
            send(hub, user, request("CREATE").put("name", "棋".repeat(32))); assertTrue(peer.replies.getLast().path("ok").asBoolean());
        }
        Peer peer = new Peer(); var user = hub.register("list", peer);
        send(hub, user, request("LIST")); var first = peer.replies.getLast(); assertEquals(64, first.path("rooms").size());
        send(hub, user, request("LIST").put("after", first.path("next").asLong()));
        assertEquals(6, peer.replies.getLast().path("rooms").size()); assertEquals(0, peer.replies.getLast().path("next").asLong());
        send(hub, user, request("CREATE").put("name", "棋".repeat(33))); assertFalse(peer.replies.getLast().path("ok").asBoolean());
        for (var owner : owners) hub.disconnect(owner); hub.disconnect(user);
    }
    @Test void hostDissolveEndsBeforeClosingBothRooms() {
        RoomHub hub = new RoomHub(); Peer host = new Peer(), guest = new Peer();
        var h = hub.register("h", host); var g = hub.register("g", guest);
        send(hub, h, request("CREATE").put("name", "解散"));
        send(hub, g, request("JOIN").put("roomId", host.last("ROOM").path("roomId").asLong()));
        ObjectNode start = context("START", host); start.set("state", request("SNAPSHOT").put("seq", 0)); send(hub, h, start);
        send(hub, h, context("DISSOLVE", host));
        assertEquals(g.id, guest.last("GAME_OVER").path("winnerId").asText());
        assertEquals("ROOM_CLOSED", guest.events.getLast().path("type").asText());
        assertTrue(guest.events.indexOf(guest.last("GAME_OVER")) < guest.events.indexOf(guest.last("ROOM_CLOSED")));
    }
}
