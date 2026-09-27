package com.chessflipping.server;

import java.io.IOException;
import java.util.Map;
import java.util.HashMap;

/** Small immutable assets loaded once, never from disk on a network event loop. */
public final class HttpAssets {
    public record Asset(byte[] bytes, String type) { }
    private final Map<String, Asset> assets = new HashMap<>();

    public HttpAssets() {
        for (String name : new String[]{"index.html", "style.css", "app.js", "game.js", "transport.js",
                "icon.svg", "rules.txt", "capture.wav", "victory.wav", "defeat.wav"}) {
            String type = name.endsWith(".html") ? "text/html; charset=utf-8"
                    : name.endsWith(".css") ? "text/css; charset=utf-8"
                    : name.endsWith(".js") ? "text/javascript; charset=utf-8"
                    : name.endsWith(".svg") ? "image/svg+xml"
                    : name.endsWith(".wav") ? "audio/wav" : "text/plain; charset=utf-8";
            try (var input = HttpAssets.class.getResourceAsStream("/web/" + name)) {
                if (input == null) throw new IllegalStateException("Missing web asset: " + name);
                assets.put("/" + name, new Asset(input.readAllBytes(), type));
            } catch (IOException ex) { throw new IllegalStateException("Unable to load web assets", ex); }
        }
        assets.put("/", assets.get("/index.html"));
    }
    public Asset get(String path) { return assets.get(path); }
}
