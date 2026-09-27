package com.chessflipping.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.*;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import io.netty.util.concurrent.GlobalEventExecutor;

/** In-memory room authority. All mutations and output enqueueing share this monitor. */
public final class RoomHub {
    public interface Peer {
        void event(ObjectNode message);
        void reply(String tid, ObjectNode message);
        void close();
    }
    public static final class Session {
        final String id = UUID.randomUUID().toString();
        final String did;
        final Peer peer;
        Room room;
        boolean active = true;
        final Set<String> pending = new HashSet<>();
        Session(String did, Peer peer) { this.did = did; this.peer = peer; }
    }
    private static final class Room {
        final long id;
        final String name;
        final List<Session> members = new ArrayList<>();
        long version = 1, sequence;
        String gameId = "";
        final Set<String> pending = new HashSet<>();
        Room(long id, String name) { this.id = id; this.name = name; }
        Session host() { return members.get(0); }
        boolean playing() { return !gameId.isEmpty(); }
    }
    private static final class Forward {
        final Session sender;
        final String tid, gameId;
        final Room room;
        final long version;
        ScheduledFuture<?> timeout;
        Forward(Session sender, String tid, Room room) {
            this.sender = sender; this.tid = tid; this.room = room;
            this.version = room.version; this.gameId = room.gameId;
        }
    }
    private final Map<String, Session> online = new HashMap<>();
    private final NavigableMap<Long, Room> rooms = new TreeMap<>();
    private final Map<String, Forward> forwards = new HashMap<>();
    private long nextRoom = 1;

    public synchronized Session register(String did, Peer peer) {
        Session old = online.get(did);
        if (old != null) { disconnect(old); old.peer.close(); }
        Session session = new Session(did, peer);
        online.put(did, session);
        peer.event(node("SESSION").put("selfId", session.id));
        return session;
    }

    public synchronized void disconnect(Session session) {
        if (session == null || !session.active) return;
        session.active = false;
        if (session.room != null) leave(session, "DISCONNECTED");
        for (String id : List.copyOf(session.pending)) removeForward(id);
        online.remove(session.did, session);
    }

    public synchronized boolean active(Session session) {
        return session != null && session.active && online.get(session.did) == session;
    }

    private synchronized void expireRequest(String id) {
        Forward request = removeForward(id);
        if (request != null) failure(request.sender, request.tid, "ACTION", "房主响应超时，请刷新状态或退出房间");
    }

    private Forward removeForward(String id) {
        Forward request = forwards.remove(id);
        if (request != null) {
            request.sender.pending.remove(id); request.room.pending.remove(id);
            if (request.timeout != null) request.timeout.cancel(false);
        }
        return request;
    }

    public synchronized void handle(Session user, String tid, JsonNode request) {
        if (!active(user)) { user.peer.close(); return; }
        String command = request.path("type").asText();
        try {
            switch (command) {
                case "LIST" -> {
                    require(user.room == null, "请先退出当前房间");
                    long after = request.path("after").asLong(0);
                    ObjectNode response = node("ROOMS");
                    ArrayNode list = response.putArray("rooms");
                    long cursor = 0;
                    for (Room room : rooms.tailMap(after, false).values()) {
                        if (list.size() == 64) { cursor = list.get(63).path("id").asLong(); break; }
                        list.add(node("ROOM_ENTRY").put("id", room.id).put("name", room.name)
                                .put("count", room.members.size()).put("playing", room.playing()));
                    }
                    user.peer.reply(tid, response.put("next", cursor));
                    return;
                }
                case "CREATE" -> {
                    require(user.room == null, "你已在房间中");
                    String name = request.path("name").asText("").strip();
                    int length = name.codePointCount(0, name.length());
                    require(length >= 1 && length <= 32 && name.codePoints().noneMatch(Character::isISOControl), "房间名须为 1 至 32 个字符，不能含控制字符");
                    Room room = new Room(nextRoom++, name);
                    rooms.put(room.id, room);
                    room.members.add(user);
                    user.room = room;
                    broadcastRoom(room);
                }
                case "JOIN" -> {
                    require(user.room == null, "你已在房间中");
                    Room room = rooms.get(request.path("roomId").asLong());
                    require(room != null, "房间已不存在，请刷新列表");
                    require(!room.playing() && room.members.size() < 2, "房间已满或正在游戏");
                    invalidate(room);
                    room.members.add(user);
                    user.room = room;
                    room.version++;
                    room.sequence = 0;
                    broadcastRoom(room);
                }
                case "LEAVE" -> {
                    require(user.room != null, "你已不在房间中");
                    leave(user, "LEFT");
                    user.peer.event(node("ROOM_CLOSED").put("reason", "LEFT"));
                }
                case "DISSOLVE" -> {
                    Room room = checked(user, request);
                    require(room.host() == user, "只有房主可以解散房间");
                    if (room.playing()) end(room, other(room, user), "HOST_DISSOLVED");
                    invalidate(room);
                    for (Session member : room.members) {
                        member.room = null;
                        member.peer.event(node("ROOM_CLOSED").put("reason", "DISSOLVED"));
                    }
                    rooms.remove(room.id);
                }
                case "ACTION" -> {
                    Room room = checked(user, request);
                    require(user.pending.size() < 8, "操作处理中，请稍候");
                    require(request.path("action").isObject(), "缺少操作内容");
                    String id = UUID.randomUUID().toString();
                    Forward forward = new Forward(user, tid, room);
                    forwards.put(id, forward); user.pending.add(id); room.pending.add(id);
                    forward.timeout = GlobalEventExecutor.INSTANCE.schedule(() -> expireRequest(id), 8, TimeUnit.SECONDS);
                    ObjectNode event = envelope("FORWARD", room).put("requestId", id).put("actorId", user.id);
                    event.set("action", request.path("action").deepCopy());
                    room.host().peer.event(event);
                    return;
                }
                case "HOST_REPLY" -> {
                    Room room = checkedHost(user, request);
                    String id = request.path("requestId").asText();
                    Forward forward = forwards.get(id);
                    require(forward != null && forward.room == room && forward.version == room.version
                            && forward.gameId.equals(room.gameId), "操作已失效，请刷新状态");
                    if (request.path("ok").asBoolean()) publish(room, request.path("state"));
                    removeForward(id);
                    if (request.path("ok").asBoolean()) success(forward.sender, forward.tid, "ACTION");
                    else failure(forward.sender, forward.tid, "ACTION", request.path("error").asText("操作无效"));
                }
                case "HOST_STATE" -> {
                    Room room = checkedHost(user, request);
                    publish(room, request.path("state"));
                }
                case "START" -> {
                    Room room = checkedHost(user, request);
                    require(!room.playing() && room.members.size() == 2, "开局条件已变化");
                    JsonNode state = request.path("state");
                    require(state.isObject() && state.path("seq").asLong(-1) == 0, "开局状态无效");
                    invalidate(room);
                    room.gameId = UUID.randomUUID().toString();
                    room.version++;
                    room.sequence = 0;
                    broadcastRoom(room);
                    ObjectNode event = envelope("STATE", room);
                    event.set("state", state.deepCopy());
                    broadcast(room, event);
                }
                case "FINISH" -> {
                    Room room = checkedHost(user, request);
                    require(room.playing(), "对局已经结束");
                    String winner = request.path("winnerId").asText();
                    require(room.members.stream().anyMatch(m -> m.id.equals(winner)), "胜方不是当前成员");
                    String reason = request.path("reason").asText();
                    require(Set.of("TIMEOUT", "NO_PIECES", "NO_MOVES").contains(reason), "结束原因无效");
                    end(room, winner, reason);
                    broadcastRoom(room);
                }
                default -> throw new IllegalArgumentException("未知房间操作");
            }
            success(user, tid, command);
        } catch (IllegalArgumentException ex) {
            failure(user, tid, command, ex.getMessage());
        }
    }

    private void publish(Room room, JsonNode state) {
        require(state.isObject() && state.path("seq").isIntegralNumber()
                && state.path("seq").asLong() == room.sequence + 1, "状态版本不一致，请刷新");
        require(state.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length < 48000, "房间状态过大");
        room.sequence++;
        ObjectNode event = envelope("STATE", room);
        event.set("state", state.deepCopy());
        broadcast(room, event);
    }

    private Room checked(Session user, JsonNode request) {
        Room room = user.room;
        require(room != null && room.id == request.path("roomId").asLong(-1), "房间已变化");
        require(room.version == request.path("version").asLong(-1)
                && room.gameId.equals(request.path("gameId").asText("")), "房间或对局状态已变化，请刷新");
        return room;
    }
    private Room checkedHost(Session user, JsonNode request) {
        Room room = checked(user, request);
        require(room.host() == user, "房主已经变化");
        return room;
    }

    private void leave(Session user, String reason) {
        Room room = user.room;
        if (room.playing()) end(room, other(room, user), reason);
        invalidate(room);
        room.members.remove(user);
        user.room = null;
        room.version++;
        room.sequence = 0;
        if (room.members.isEmpty()) rooms.remove(room.id);
        else broadcastRoom(room);
    }
    private String other(Room room, Session user) {
        return room.members.stream().filter(m -> m != user).map(m -> m.id).findFirst().orElse("");
    }
    private void end(Room room, String winner, String reason) {
        broadcast(room, envelope("GAME_OVER", room).put("winnerId", winner).put("reason", reason));
        invalidate(room);
        room.gameId = "";
        room.version++;
        room.sequence = 0;
    }
    private void invalidate(Room room) {
        for (String id : List.copyOf(room.pending)) {
            Forward forward = removeForward(id);
            failure(forward.sender, forward.tid, "ACTION", "房间状态已变化，旧操作已取消");
        }
    }
    private void broadcastRoom(Room room) {
        ObjectNode event = envelope("ROOM", room).put("name", room.name).put("hostId", room.host().id)
                .put("playing", room.playing());
        ArrayNode members = event.putArray("members");
        for (Session member : room.members) members.add(member.id);
        broadcast(room, event);
    }
    private void broadcast(Room room, ObjectNode event) {
        for (Session member : room.members) member.peer.event(event);
    }
    private static ObjectNode envelope(String type, Room room) {
        return node(type).put("roomId", room.id).put("version", room.version).put("gameId", room.gameId);
    }
    public static ObjectNode node(String type) { return JsonNodeFactory.instance.objectNode().put("type", type); }
    private static void success(Session session, String tid, String command) {
        session.peer.reply(tid, node("RESULT").put("request", command).put("ok", true));
    }
    private static void failure(Session session, String tid, String command, String error) {
        if (session.active) session.peer.reply(tid, node("RESULT").put("request", command).put("ok", false).put("error", error));
    }
    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalArgumentException(message);
    }
}
