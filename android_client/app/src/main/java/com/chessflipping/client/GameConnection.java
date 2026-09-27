package com.chessflipping.client;

import org.json.JSONObject;

public interface GameConnection extends AutoCloseable {
    void connect(String host, int port);
    void request(JSONObject request);
    @Override void close();
}
