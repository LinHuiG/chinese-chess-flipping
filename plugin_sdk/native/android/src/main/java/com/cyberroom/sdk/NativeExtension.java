package com.cyberroom.sdk;

import android.content.Context;
import android.widget.FrameLayout;
import org.json.*;

/** API 1 for reviewed, separately installed native components. All UI calls are on main. */
public interface NativeExtension extends AutoCloseable {
    interface Host {
        void event(JSONObject event);
        boolean send(String peer,Packet packet);
        boolean healthy(String peer);
        void permission(String permission);
    }
    final class Packet {
        public final int type;public final byte[] control,body;
        public Packet(int type,byte[] control,byte[] body){this.type=type;this.control=control;this.body=body;}
    }
    void initialize(Context context,Host host);
    void attach(FrameLayout parent);
    void detach();
    void foreground(boolean value);
    void permission(String name,boolean granted);
    Object call(String method,JSONArray args,JSONObject scope)throws Exception;
    // May arrive on a network thread, concurrently with close and UI calls.
    boolean receive(String peer,Packet packet);
    @Override void close();
}
