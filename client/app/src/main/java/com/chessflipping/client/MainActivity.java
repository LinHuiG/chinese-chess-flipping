package com.chessflipping.client;

import android.app.Activity;
import android.os.Bundle;
import android.os.Build;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.text.InputType;
import android.view.View;
import android.view.WindowInsets;
import android.widget.*;

public class MainActivity extends Activity {
    private EditText host, port, message;
    private TextView status, log;
    private Button connect, send;
    private TcpClient client;
    private int generation;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int pad = (int)(20 * getResources().getDisplayMetrics().density);
        content.setPadding(pad, pad, pad, pad);
        content.setBackgroundColor(Color.rgb(245, 247, 250));
        content.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                view.setPadding(pad + bars.left, pad + bars.top, pad + bars.right, pad + bars.bottom);
            } else {
                view.setPadding(pad, pad + insets.getSystemWindowInsetTop(), pad, pad + insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true); scroll.addView(content); setContentView(scroll);
        TextView title = new TextView(this); title.setText("翻棋 · 联机连接"); title.setTextSize(26); content.addView(title);
        TextView hint = new TextView(this); hint.setText("填写服务端地址与 TCP 端口，连接后可发送消息验证通信。"); content.addView(hint);
        host = field(content, "服务器域名或 IP", "host", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        port = field(content, "TCP 端口", "port", InputType.TYPE_CLASS_NUMBER);
        host.setText(getPreferences(0).getString("host", "10.0.2.2"));
        port.setText(getPreferences(0).getString("port", "9000"));
        connect = new Button(this); connect.setText("连接服务器"); content.addView(connect);
        status = new TextView(this); status.setText("尚未连接"); content.addView(status);
        message = field(content, "测试消息", "message", InputType.TYPE_CLASS_TEXT);
        message.setText("你好，翻棋服务端！");
        send = new Button(this); send.setText("发送测试消息"); send.setEnabled(false); content.addView(send);
        log = new TextView(this); log.setTextIsSelectable(true); content.addView(log);
        connect.setOnClickListener(v -> {
            if (client != null) { disconnect(); return; }
            if (Build.VERSION.SDK_INT >= 37 && checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK") != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{"android.permission.ACCESS_LOCAL_NETWORK"}, 10);
                status.setText("连接局域网服务器需要本地网络权限，授权后请再次连接。"); return;
            }
            startConnection();
        });
        send.setOnClickListener(v -> { if (client != null) client.echo(message.getText().toString()); });
    }

    private EditText field(LinearLayout parent, String hint, String tag, int inputType) {
        EditText field = new EditText(this); field.setHint(hint); field.setTag(tag);
        field.setSingleLine(true); field.setInputType(inputType); parent.addView(field); return field;
    }

    private void startConnection() {
        String address = host.getText().toString().trim();
        int number;
        try { number = Integer.parseInt(port.getText().toString()); if (number < 1 || number > 65535 || address.isEmpty()) throw new IllegalArgumentException(); }
        catch (IllegalArgumentException ex) { status.setText("请输入服务器地址和 1–65535 的端口"); return; }
        getPreferences(0).edit().putString("host", address).putString("port", Integer.toString(number)).apply();
        final int current = ++generation;
        client = new TcpClient(new TcpClient.Listener() {
            private void update(Runnable action) { runOnUiThread(() -> { if (generation == current && !isDestroyed()) action.run(); }); }
            public void onConnected() { update(() -> { status.setText("已连接"); send.setEnabled(true); }); }
            public void onMessage(String text) { update(() -> {
                String next = log.getText() + "\n" + text;
                log.setText(next.length() > 12000 ? next.substring(next.length() - 12000) : next);
            }); }
            public void onClosed(String reason) { update(() -> { client = null; send.setEnabled(false); connect.setText("连接服务器"); status.setText(reason); }); }
        });
        status.setText("正在连接…"); connect.setText("断开连接"); client.connect(address, number);
    }
    private void disconnect() {
        generation++;
        if (client != null) client.close();
        client = null; send.setEnabled(false); connect.setText("连接服务器"); status.setText("已断开，点击连接可重连");
    }
    @Override protected void onStop() { disconnect(); super.onStop(); }
}
