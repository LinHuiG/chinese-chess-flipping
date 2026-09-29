package com.chessflipping.client;

import com.chessflipping.protocol.WireProtocol;
import org.json.*;
import java.nio.charset.StandardCharsets;

public interface GameConnection extends AutoCloseable {
    void connect(String host, int port);
    void request(JSONObject request);
    @Override void close();

    static WireProtocol.Packet packet(JSONObject request) throws JSONException {
        String kind = request.optString("type");
        if (kind.equals("UPDATE_CHECK") || kind.equals("APP_GET"))
            return new WireProtocol.Packet(kind.equals("UPDATE_CHECK") ? 48 : 50, request.toString().getBytes(StandardCharsets.UTF_8), new byte[0]);
        JSONObject route = new JSONObject(), body = new JSONObject();
        boolean relay = request.optString("type").matches("ACTION|HOST_REPLY|HOST_STATE");
        java.util.Iterator<String> keys = request.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (relay && (key.equals("type") || key.equals("roomId") || key.equals("version") || key.equals("operationId"))) route.put(key, request.get(key));
            else body.put(key, request.get(key));
        }
        return new WireProtocol.Packet(WireProtocol.BUSINESS_REQUEST,
                route.toString().getBytes(StandardCharsets.UTF_8), body.toString().getBytes(StandardCharsets.UTF_8));
    }
    static JSONObject message(WireProtocol.Packet packet) throws JSONException {
        JSONObject body = new JSONObject(new String(packet.body, StandardCharsets.UTF_8));
        JSONObject route = new JSONObject(new String(packet.control, StandardCharsets.UTF_8));
        java.util.Iterator<String> keys = route.keys();
        while (keys.hasNext()) { String key = keys.next(); body.put(key, route.get(key)); }
        return body;
    }
}
