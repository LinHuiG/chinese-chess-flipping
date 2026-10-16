package com.cyberroom.watch;
public final class ComponentActivity extends android.app.Activity {
    @Override public void onCreate(android.os.Bundle saved){super.onCreate(saved);android.widget.TextView text=new android.widget.TextView(this);text.setPadding(32,48,32,32);text.setText("电影厅原生组件已安装。请返回赛博房间，在插件市场完成安装后进入电影厅。");setContentView(text);}
}
