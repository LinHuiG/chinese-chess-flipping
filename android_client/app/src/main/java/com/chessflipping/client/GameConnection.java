package com.chessflipping.client;
import com.chessflipping.protocol.WireProtocol;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;

public interface GameConnection extends AutoCloseable {
    void connect(String host,int port);
    boolean send(WireProtocol.Packet packet);
    @Override void close();
    default void request(JSONObject request){
        String type=request.optString("type");
        if(type.equals("UPDATE_CHECK")||type.equals("APP_GET"))
            send(new WireProtocol.Packet(type.equals("UPDATE_CHECK")?48:50,new byte[0],request.toString().getBytes(StandardCharsets.UTF_8)));
    }
}