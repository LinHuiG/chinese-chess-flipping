package com.chessflipping.client;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.*;
import android.text.InputType;
import android.view.*;
import android.widget.*;
import org.json.*;
import java.util.ArrayList;

public final class MainActivity extends Activity implements GameService.Observer {
    private static final int INK = Color.rgb(28, 28, 30), BLUE = Color.rgb(0, 112, 235), MUTED = Color.rgb(110, 110, 119);
    private static final int BACKGROUND = Color.rgb(242, 242, 247), LINE = Color.rgb(225, 226, 232);
    private static final android.graphics.Typeface MEDIUM = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private GameService service;
    private LinearLayout root, content;
    private TextView connection, clock, turnLabel, colorLabel, resultLabel, lobbyCount, lobbyEmpty;
    private TextView serverMetric, routeMetric, directMetric;
    private LinearLayout networkMetrics;
    private Boolean renderedDirect;
    private final TextView[] memberLabels = new TextView[2], memberStatus = new TextView[2];
    private LinearLayout lobbyList;
    private Button readyButton;
    private RadioGroup timeChoices;
    private boolean updatingChoices;
    private long renderedRooms = -1;
    private GameFeedback feedback;
    private GameService.Outcome pendingOutcome;
    private Dialog resultDialog;
    private ChessBoardView board;
    private boolean bound, visible, settings, autoConnect = true;
    private String renderedKey = "";
    private final Runnable clockTick = this::updateClock;
    private final Runnable presentOutcome = () -> {
        GameService.Outcome value = pendingOutcome; pendingOutcome = null;
        if (!visible || value == null) return;
        renderedKey = ""; changed(); showOutcome(value);
    };
    private final ServiceConnection binding = new ServiceConnection() {
        public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((GameService.LocalBinder)binder).service();
            service.foreground(visible); service.observe(visible ? MainActivity.this : null);
            if (autoConnect && !service.connected) { autoConnect = false; connect(); }
        }
        public void onServiceDisconnected(ComponentName name) { service = null; renderedKey = ""; }
    };

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        feedback = new GameFeedback(this);
        if (saved != null) autoConnect = saved.getBoolean("autoConnect", false);
        root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(BACKGROUND);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else view.setPadding(0, insets.getSystemWindowInsetTop(), 0, insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) root.post(() -> {
            android.view.WindowInsetsController controller = getWindow().getInsetsController();
            int appearance = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            if (controller != null) controller.setSystemBarsAppearance(appearance, appearance);
        });
        else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        LinearLayout toolbar = row(root);
        toolbar.setPadding(dp(12), dp(6), dp(4), dp(6)); toolbar.setBackgroundColor(Color.WHITE);
        ImageView mark = new ImageView(this); mark.setImageResource(R.drawable.ic_launcher_foreground);
        toolbar.addView(mark, new LinearLayout.LayoutParams(dp(44), dp(44)));
        TextView title = text("翻棋", 22); title.setTypeface(MEDIUM);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
        title.setGravity(Gravity.CENTER_VERTICAL);
        icon(toolbar, R.drawable.ic_refresh, "刷新状态", () -> {
            if (service != null) { if (service.room == null) service.listRooms(); else service.sync(); }
        });
        icon(toolbar, R.drawable.ic_settings, "服务器设置", () -> { settings = true; showSettings(); });
        Button rules = button(toolbar, "规则", this::showRules); rules.setMinWidth(0); rules.setMinimumWidth(0);
        connection = text("正在初始化", 13); connection.setPadding(dp(16), dp(8), dp(16), dp(8)); root.addView(connection);
        connection.setLines(landscape() ? 1 : 2); connection.setEllipsize(android.text.TextUtils.TruncateAt.END);
        connection.setBackgroundColor(Color.WHITE); divider(root);
        networkMetrics = row(root); networkMetrics.setBackgroundColor(Color.WHITE);
        networkMetrics.setPadding(dp(16), dp(2), dp(16), dp(7));
        serverMetric = networkChip(networkMetrics); routeMetric = networkChip(networkMetrics); directMetric = networkChip(networkMetrics);
        networkMetrics.setVisibility(View.GONE); directMetric.setVisibility(View.GONE);
        content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL);
        root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
        bound = bindService(new Intent(this, GameService.class), binding, BIND_AUTO_CREATE);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
    }
    @Override protected void onStart() {
        super.onStart(); visible = true;
        feedback.start();
        if (service != null) {
            service.foreground(true); service.observe(this);
            if (service.connected && service.room != null) service.sync();
        }
        updateClock();
    }
    @Override protected void onStop() {
        visible = false; handler.removeCallbacks(clockTick);
        handler.removeCallbacks(presentOutcome); pendingOutcome = null;
        if (board != null) board.pause();
        if (resultDialog != null) { resultDialog.dismiss(); resultDialog = null; }
        feedback.stop();
        if (service != null) { service.foreground(false); service.observe(null); }
        super.onStop();
    }
    @Override protected void onDestroy() {
        if (service != null) service.observe(null);
        if (bound) unbindService(binding);
        super.onDestroy();
    }
    @Override protected void onSaveInstanceState(Bundle out) {
        out.putBoolean("autoConnect", autoConnect); super.onSaveInstanceState(out);
    }

    private void connect() {
        if (service == null) return;
        ArrayList<String> permissions = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && !service.preferences().getBoolean("notificationAsked", false)) permissions.add(Manifest.permission.POST_NOTIFICATIONS);
        if (Build.VERSION.SDK_INT >= 37 && checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK") != PackageManager.PERMISSION_GRANTED
                && !service.preferences().getBoolean("localNetworkAsked", false)) permissions.add("android.permission.ACCESS_LOCAL_NETWORK");
        if (!permissions.isEmpty()) {
            service.preferences().edit().putBoolean("notificationAsked", true).putBoolean("localNetworkAsked", true).apply();
            requestPermissions(permissions.toArray(new String[0]), 10); return;
        }
        startConnection();
    }
    private void startConnection() {
        if (!visible || service == null) return;
        service.foreground(true);
        startForegroundService(new Intent(this, GameService.class));
    }
    @Override public void onRequestPermissionsResult(int code, String[] names, int[] grants) {
        super.onRequestPermissionsResult(code, names, grants);
        if (code == 10) {
            if (Build.VERSION.SDK_INT >= 37 && checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK") != PackageManager.PERMISSION_GRANTED)
                notice("本地网络权限未授予，连接局域网服务器可能失败");
            startConnection();
        }
    }
    @Override public void changed() {
        if (service == null || !visible) return;
        networkChanged();
        setText(connection, service.status + "  ·  " + service.endpoint());
        connection.setTextColor(service.connected ? Color.rgb(36, 129, 70) : MUTED);
        GameService.Outcome outcome = service.takeOutcome();
        if (outcome != null) {
            pendingOutcome = outcome;
            if (board != null) board.setEnabled(false);
            handler.removeCallbacks(presentOutcome);
            handler.postDelayed(presentOutcome, board != null && board.animating() ? 280 : 0);
        }
        if (pendingOutcome != null) return;
        if (settings) return;
        String key = !service.connected ? "offline" : service.room == null ? "lobby"
                : "room:" + service.room.optLong("roomId") + ":" + service.room.optLong("version");
        if (!key.equals(renderedKey)) {
            renderedKey = key; clearContent();
            if (!service.connected) showOffline();
            else if (service.room == null) showLobby();
            else if (service.playing()) showGame();
            else showWaiting();
        }
        if (lobbyList != null) updateLobby();
        if (readyButton != null) updateWaiting();
        if (board != null) board.setState(service.state, service.myIndex());
        updateClock();
    }
    private TextView networkChip(LinearLayout parent) {
        TextView value = text("", 11); value.setSingleLine(); value.setTypeface(MEDIUM);
        value.setTextColor(MUTED); value.setPadding(dp(8), dp(3), dp(8), dp(3)); value.setBackground(surface(BACKGROUND, 12));
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-2, -2); layout.setMarginEnd(dp(6)); parent.addView(value, layout); return value;
    }
    @Override public void networkChanged() {
        if (!visible || service == null || networkMetrics == null) return;
        networkMetrics.setVisibility(service.connected ? View.VISIBLE : View.GONE);
        if (!service.connected) return;
        setText(serverMetric, "服务器 " + (service.serverLatency < 0 ? "—" : service.serverLatency + " ms"));
        setText(routeMetric, service.direct ? "直连" : "中转");
        if (renderedDirect == null || renderedDirect != service.direct) {
            renderedDirect = service.direct;
            routeMetric.setTextColor(service.direct ? Color.rgb(36,129,70) : MUTED);
            routeMetric.setBackground(surface(service.direct ? Color.rgb(232,247,237) : BACKGROUND, 12));
        }
        directMetric.setVisibility(service.direct && service.directLatency >= 0 ? View.VISIBLE : View.GONE);
        if (service.direct && service.directLatency >= 0) setText(directMetric, "直连 " + service.directLatency + " ms");
    }
    private void clearContent() {
        handler.removeCallbacks(clockTick);
        if (board != null) board.pause();
        content.removeAllViews(); content.setOrientation(LinearLayout.VERTICAL);
        clock = turnLabel = colorLabel = resultLabel = null; board = null; readyButton = null;
        timeChoices = null; lobbyList = null; renderedRooms = -1;
    }
    @Override public void notice(String text) { Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
    private LinearLayout scrollContent() {
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        LinearLayout inner = new LinearLayout(this); inner.setOrientation(LinearLayout.VERTICAL);
        inner.setPadding(dp(16), dp(12), dp(16), dp(16));
        scroll.addView(inner); content.addView(scroll, new LinearLayout.LayoutParams(-1, -1)); return inner;
    }
    private void showOffline() {
        LinearLayout inner = scrollContent();
        heading(inner, "联机翻棋"); mark(inner);
        button(inner, "连接服务器", this::connect);
        button(inner, "服务器设置", () -> { settings = true; showSettings(); });
    }
    private void showLobby() {
        LinearLayout inner = scrollContent();
        heading(inner, "房间大厅");
        lobbyCount = text("", 13); lobbyCount.setTextColor(MUTED); inner.addView(lobbyCount);
        button(inner, "创建房间", this::createDialog);
        lobbyList = new LinearLayout(this); lobbyList.setOrientation(LinearLayout.VERTICAL); inner.addView(lobbyList);
        lobbyEmpty = text("暂无房间", 17); lobbyEmpty.setGravity(Gravity.CENTER); lobbyEmpty.setTextColor(MUTED);
        inner.addView(lobbyEmpty, new LinearLayout.LayoutParams(-1, dp(160)));
        button(inner, "断开连接", () -> service.disconnect());
    }
    private void updateLobby() {
        setText(lobbyCount, service.listingRooms ? "正在刷新" : service.rooms.size() + " 个房间");
        lobbyEmpty.setVisibility(service.rooms.isEmpty() ? View.VISIBLE : View.GONE);
        setText(lobbyEmpty, service.listingRooms ? "正在获取房间…" : "暂无房间");
        if (renderedRooms == service.roomsRevision) return;
        renderedRooms = service.roomsRevision; lobbyList.removeAllViews();
        for (JSONObject entry : service.rooms) {
            LinearLayout item = row(lobbyList); item.setPadding(dp(14), dp(10), dp(6), dp(10)); item.setBackgroundColor(Color.WHITE);
            LinearLayout labels = new LinearLayout(this); labels.setOrientation(LinearLayout.VERTICAL);
            item.addView(labels, new LinearLayout.LayoutParams(0, -2, 1));
            addText(labels, "#" + entry.optLong("id") + " " + entry.optString("name"), 17);
            addText(labels, entry.optInt("count") + "/2  ·  " + (entry.optBoolean("playing") ? "游戏中" : "等待中"), 13);
            Button join = button(item, "加入", () -> service.join(entry.optLong("id")));
            join.setEnabled(!entry.optBoolean("playing") && entry.optInt("count") < 2);
            divider(lobbyList);
        }
    }
    private void createDialog() {
        EditText name = new EditText(this); name.setHint("房间名称"); name.setSingleLine(true);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("创建房间").setView(name)
                .setNegativeButton("取消", null).setPositiveButton("创建", null).create();
        dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String value = name.getText().toString().trim();
            if (value.codePointCount(0, value.length()) < 1 || value.codePointCount(0, value.length()) > 32
                    || value.codePoints().anyMatch(Character::isISOControl)) {
                name.setError("请输入 1 至 32 个字符，不含控制字符"); return;
            }
            service.createRoom(value); dialog.dismiss();
        }));
        dialog.show();
    }
    private void showWaiting() {
        LinearLayout inner = scrollContent(); JSONObject room = service.room;
        addText(inner, "房间 #" + room.optLong("roomId"), 13);
        heading(inner, room.optString("name"));
        resultLabel = text("", 15); resultLabel.setTextColor(BLUE); resultLabel.setPadding(0, dp(8), 0, dp(12)); inner.addView(resultLabel);
        JSONArray members = room.optJSONArray("members");
        for (int i = 0; i < 2; i++) {
            LinearLayout player = row(inner); player.setPadding(dp(14), dp(16), dp(14), dp(16)); player.setBackgroundColor(Color.WHITE);
            TextView avatar = text(i < members.length() && members.optString(i).equals(service.selfId) ? "我" : "客", 16);
            avatar.setGravity(Gravity.CENTER); avatar.setTextColor(i == 0 ? BLUE : MUTED); avatar.setBackground(surface(Color.rgb(236, 240, 248), 22));
            player.addView(avatar, new LinearLayout.LayoutParams(dp(40), dp(40)));
            memberLabels[i] = text("", 17); memberLabels[i].setPadding(dp(12), 0, dp(8), 0);
            player.addView(memberLabels[i], new LinearLayout.LayoutParams(0, -2, 1));
            memberStatus[i] = text("", 13); player.addView(memberStatus[i]); divider(inner);
        }
        addText(inner, "每步时间", 14);
        RadioGroup choices = new RadioGroup(this); choices.setOrientation(LinearLayout.HORIZONTAL);
        timeChoices = choices; choices.setPadding(dp(3), dp(3), dp(3), dp(3)); choices.setBackground(surface(Color.rgb(227, 228, 235), 8));
        int[] values = {30, 60, 90, 0}; String[] labels = {"30秒", "60秒", "90秒", "无限"};
        for (int i = 0; i < values.length; i++) {
            RadioButton choice = new RadioButton(this); choice.setText(labels[i]); choice.setTextSize(14); choice.setId(100 + i);
            choice.setButtonDrawable(null); choice.setGravity(Gravity.CENTER); choice.setMinWidth(0); choice.setPadding(0, 0, 0, 0);
            android.graphics.drawable.GradientDrawable background = surface(Color.TRANSPARENT, 6);
            background.setColor(new android.content.res.ColorStateList(new int[][]{new int[]{android.R.attr.state_checked},new int[0]}, new int[]{Color.WHITE,Color.TRANSPARENT}));
            choice.setBackground(background); choices.addView(choice, new RadioGroup.LayoutParams(0, dp(40), 1));
        }
        choices.setOnCheckedChangeListener((group, id) -> { if (!updatingChoices && id >= 100 && id < 104) service.timeLimit(values[id - 100]); });
        inner.addView(choices);
        readyButton = button(inner, "准备", () -> service.ready(!service.isReady(service.selfId)));
        button(inner, "退出房间", this::confirmLeave);
        if (service.isHost()) button(inner, "解散房间", this::confirmDissolve);
    }
    private void updateWaiting() {
        JSONArray members = service.room.optJSONArray("members");
        for (int i = 0; i < 2; i++) {
            boolean present = i < members.length(); String id = members.optString(i);
            setText(memberLabels[i], present ? (id.equals(service.selfId) ? "你" : "对方") + (i == 0 ? " · 房主" : "") : "等待加入");
            boolean ready = service.isReady(id);
            setText(memberStatus[i], present ? (ready ? "已准备" : "未准备") : "空位");
            memberStatus[i].setTextColor(ready ? Color.rgb(36, 129, 70) : MUTED);
        }
        resultLabel.setVisibility(service.lastResult.isEmpty() ? View.GONE : View.VISIBLE); setText(resultLabel, service.lastResult);
        readyButton.setEnabled(service.state != null); setText(readyButton, service.isReady(service.selfId) ? "取消准备" : "准备");
        int seconds = service.state == null ? 60 : service.state.optInt("seconds", 60);
        updatingChoices = true; timeChoices.check(seconds == 30 ? 100 : seconds == 60 ? 101 : seconds == 90 ? 102 : 103); updatingChoices = false;
        for (int i = 0; i < 4; i++) timeChoices.getChildAt(i).setEnabled(service.isHost() && service.state != null);
    }
    private void showGame() {
        LinearLayout details = content;
        if (landscape()) {
            content.setOrientation(LinearLayout.HORIZONTAL);
            ScrollView scroll = new ScrollView(this);
            details = new LinearLayout(this); details.setOrientation(LinearLayout.VERTICAL);
            details.setPadding(dp(12), dp(8), dp(12), dp(8));
            scroll.addView(details);
            content.addView(scroll, new LinearLayout.LayoutParams(dp(190), -1));
        }
        TextView roomTitle = text("#" + service.room.optLong("roomId") + " " + service.room.optString("name"), 16);
        roomTitle.setPadding(dp(16), 0, dp(16), dp(4)); details.addView(roomTitle);
        LinearLayout turnRow = row(details); turnRow.setPadding(dp(16), dp(4), dp(16), dp(4));
        if (landscape()) turnRow.setOrientation(LinearLayout.VERTICAL);
        LinearLayout player = new LinearLayout(this); player.setOrientation(LinearLayout.VERTICAL);
        turnRow.addView(player, new LinearLayout.LayoutParams(landscape() ? -1 : 0, -2, landscape() ? 0 : 1));
        turnLabel = text("正在同步", 18); player.addView(turnLabel);
        colorLabel = text("尚未定色", 13); colorLabel.setTextColor(MUTED); player.addView(colorLabel);
        clock = text("--:--", 28); clock.setGravity(Gravity.CENTER); clock.setTypeface(MEDIUM);
        clock.setFontFeatureSettings("tnum"); turnRow.addView(clock, new LinearLayout.LayoutParams(dp(96), dp(52)));
        board = new ChessBoardView(this, (from, to) -> service.move(from, to), feedback);
        content.addView(board, landscape() ? new LinearLayout.LayoutParams(0, -1, 1) : new LinearLayout.LayoutParams(-1, 0, 1));
        LinearLayout actions = row(details); actions.setGravity(Gravity.CENTER);
        if (landscape()) actions.setOrientation(LinearLayout.VERTICAL);
        button(actions, "退出本局", this::confirmLeave);
        if (service.isHost()) button(actions, "解散房间", this::confirmDissolve);
    }
    private void updateClock() {
        handler.removeCallbacks(clockTick);
        if (!visible || clock == null || service == null || service.state == null) return;
        JSONObject state = service.state;
        int mine = service.myIndex(), turn = state.optInt("turn", -1);
        JSONArray colors = state.optJSONArray("colors"); int color = colors == null ? 0 : colors.optInt(mine);
        long remaining = service.displayedRemaining();
        setText(colorLabel, color == 0 ? "尚未定色" : color > 0 ? "你执红棋" : "你执黑棋");
        setText(turnLabel, turn == mine ? "你的回合" : "对方回合"); turnLabel.setTextColor(turn == mine ? BLUE : INK);
        long seconds = (remaining + 999) / 1000;
        setText(clock, remaining < 0 ? "不限时" : String.format(java.util.Locale.ROOT, "%02d:%02d", seconds / 60, seconds % 60));
        clock.setTextColor(remaining >= 0 && remaining <= 10000 ? Color.rgb(205, 50, 63) : INK);
        if (remaining > 0 && state.optInt("winner", -1) < 0) handler.postDelayed(clockTick, (remaining % 1000 == 0 ? 1000 : remaining % 1000) + 8);
    }
    private void confirmLeave() {
        if (service.playing()) new AlertDialog.Builder(this).setTitle("退出本局？").setMessage("退出将判负，随后返回大厅。")
                .setNegativeButton("取消", null).setPositiveButton("退出", (d, w) -> service.leave()).show();
        else service.leave();
    }
    private void confirmDissolve() {
        new AlertDialog.Builder(this).setTitle("解散房间？").setMessage(service.playing() ? "本局按房主认输处理，双方返回大厅。" : "房间内的玩家将返回大厅。")
                .setNegativeButton("取消", null).setPositiveButton("解散", (d, w) -> service.dissolve()).show();
    }
    private void showSettings() {
        renderedKey = ""; clearContent();
        LinearLayout inner = scrollContent(); heading(inner, "设置");
        addText(inner, "游戏反馈", 14);
        toggle(inner, "音效", "sound"); toggle(inner, "动画", "motion");
        addText(inner, "服务器", 14);
        Switch tcp = new Switch(this); tcp.setText("使用 TCP 连接"); tcp.setTextSize(17); tcp.setTextColor(INK);
        tcp.setPadding(dp(14), dp(12), dp(14), dp(12)); tcp.setBackground(surface(Color.WHITE, 12));
        tcp.setChecked(service != null && service.transport().equals("TCP"));
        tcp.setThumbTintList(new android.content.res.ColorStateList(new int[][]{new int[]{android.R.attr.state_checked}, new int[0]}, new int[]{Color.WHITE, Color.WHITE}));
        tcp.setTrackTintList(new android.content.res.ColorStateList(new int[][]{new int[]{android.R.attr.state_checked}, new int[0]}, new int[]{Color.rgb(52, 199, 89), LINE}));
        inner.addView(tcp, new LinearLayout.LayoutParams(-1, dp(58)));
        RadioGroup protocol = new RadioGroup(this); protocol.setOrientation(LinearLayout.HORIZONTAL);
        final int httpId = View.generateViewId(), httpsId = View.generateViewId();
        protocol.setPadding(dp(3), dp(3), dp(3), dp(3)); protocol.setBackground(surface(LINE, 10));
        for (int i = 0; i < 2; i++) {
            RadioButton option = new RadioButton(this); option.setId(i == 0 ? httpId : httpsId); option.setText(i == 0 ? "HTTP" : "HTTPS");
            option.setButtonDrawable(null); option.setGravity(Gravity.CENTER); option.setTextSize(15); option.setTextColor(INK);
            android.graphics.drawable.GradientDrawable bg = surface(Color.TRANSPARENT, 8);
            bg.setColor(new android.content.res.ColorStateList(new int[][]{new int[]{android.R.attr.state_checked}, new int[0]}, new int[]{Color.WHITE, Color.TRANSPARENT}));
            option.setBackground(bg); protocol.addView(option, new RadioGroup.LayoutParams(0, dp(40), 1));
        }
        protocol.check(service != null && service.transport().equals("HTTPS") ? httpsId : httpId);
        LinearLayout.LayoutParams protocolLayout = new LinearLayout.LayoutParams(-1, -2); protocolLayout.topMargin = dp(10);
        inner.addView(protocol, protocolLayout); protocol.setVisibility(tcp.isChecked() ? View.GONE : View.VISIBLE);
        TextView transportNote = text("", 13); transportNote.setTextColor(MUTED); transportNote.setPadding(0, dp(8), 0, dp(10)); inner.addView(transportNote);
        addText(inner, "服务器地址", 15);
        EditText host = new EditText(this); host.setSingleLine(true);
        host.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        host.setText(service == null ? GameService.DEFAULT_HOST : service.host()); inputStyle(host); inner.addView(host);
        addText(inner, "端口", 15);
        EditText port = new EditText(this); port.setSingleLine(true); port.setInputType(InputType.TYPE_CLASS_NUMBER);
        port.setText(Integer.toString(service == null ? GameService.DEFAULT_PORT : service.port())); inputStyle(port); inner.addView(port);
        Runnable updateTransport = () -> {
            protocol.setVisibility(tcp.isChecked() ? View.GONE : View.VISIBLE);
            transportNote.setText(tcp.isChecked() ? "使用原有加密 TCP 通道，默认端口 8888。"
                    : protocol.getCheckedRadioButtonId() == httpsId ? "通过 HTTPS 安全连接，默认端口 443。" : "通过 HTTP 连接，默认端口 80。");
        };
        Runnable updatePort = () -> {
            String old = port.getText().toString();
            if (old.equals("80") || old.equals("443") || old.equals("8888"))
                port.setText(tcp.isChecked() ? "8888" : protocol.getCheckedRadioButtonId() == httpsId ? "443" : "80");
            updateTransport.run();
        };
        tcp.setOnCheckedChangeListener((v, value) -> updatePort.run());
        protocol.setOnCheckedChangeListener((v, id) -> updatePort.run()); updateTransport.run();
        button(inner, "保存并连接", () -> {
            if (service == null) return;
            String address = host.getText().toString().trim();
            if (address.isEmpty() || address.contains("/") || address.codePoints().anyMatch(Character::isWhitespace)) {
                host.setError("请输入域名或 IP，不包含协议前缀或路径"); return;
            }
            int number;
            try { number = Integer.parseInt(port.getText().toString()); if (number < 1 || number > 65535) throw new NumberFormatException(); }
            catch (NumberFormatException ex) { port.setError("端口范围为 1 至 65535"); return; }
            String mode = tcp.isChecked() ? "TCP" : protocol.getCheckedRadioButtonId() == httpsId ? "HTTPS" : "HTTP";
            Runnable save = () -> { service.saveServer(address, number, mode); settings = false; changed(); connect(); };
            if (service.room != null) new AlertDialog.Builder(this).setTitle("更换服务器？")
                    .setMessage(service.playing() ? "当前对局将按退出判负。" : "将退出当前房间并重新连接。")
                    .setNegativeButton("取消", null).setPositiveButton("保存并连接", (d, w) -> save.run()).show();
            else save.run();
        });
        button(inner, "恢复默认值", () -> { host.setText(GameService.DEFAULT_HOST); tcp.setChecked(false); protocol.check(httpId); port.setText(Integer.toString(GameService.DEFAULT_PORT)); });
        button(inner, "返回", () -> { settings = false; changed(); });
        button(inner, "开源许可", () -> {
            try (java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(getResources().openRawResource(R.raw.third_party_notices), java.nio.charset.StandardCharsets.UTF_8))) {
                String text = reader.lines().collect(java.util.stream.Collectors.joining("\n"));
                TextView notice = text(text, 13); notice.setPadding(dp(20), dp(12), dp(20), dp(12));
                ScrollView scroll = new ScrollView(this); scroll.addView(notice);
                new AlertDialog.Builder(this).setTitle("开源许可").setView(scroll).setPositiveButton("关闭", null).show();
            } catch (java.io.IOException ex) { notice("无法读取许可信息"); }
        });
    }
    private void showRules() {
        TextView rules = text(getString(R.string.game_rules), 16);
        rules.setPadding(dp(20), dp(12), dp(20), dp(20)); rules.setLineSpacing(dp(4), 1);
        ScrollView scroll = new ScrollView(this); scroll.addView(rules);
        new AlertDialog.Builder(this).setTitle("翻棋规则").setView(scroll).setPositiveButton("关闭", null).show();
    }
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() { handleBack(); }
    private void handleBack() {
        if (settings) { settings = false; changed(); }
        else if (service != null && service.room != null) confirmLeave();
        else new AlertDialog.Builder(this).setTitle("退出翻棋？").setNegativeButton("取消", null)
                .setPositiveButton("退出", (d, w) -> { if (service != null) service.disconnect(); finish(); }).show();
    }
    private TextView text(String value, int size) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(INK); view.setLetterSpacing(0); return view;
    }
    private void addText(LinearLayout parent, String value, int size) {
        TextView view = text(value, size); view.setPadding(0, dp(8), 0, dp(8)); parent.addView(view);
    }
    private void heading(LinearLayout parent, String value) {
        TextView title = text(value, 27); title.setTypeface(MEDIUM);
        title.setPadding(0, dp(8), 0, dp(16)); parent.addView(title);
    }
    private LinearLayout row(LinearLayout parent) {
        LinearLayout row = new LinearLayout(this); row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL); parent.addView(row, new LinearLayout.LayoutParams(-1, -2)); return row;
    }
    private Button button(LinearLayout parent, String label, Runnable action) {
        Button button = new Button(this); button.setText(label); button.setAllCaps(false); button.setTextSize(15);
        button.setLetterSpacing(0); button.setElevation(0); button.setStateListAnimator(null);
        boolean primary = switch (label) { case "创建房间", "准备", "连接服务器", "保存并连接", "加入", "继续" -> true; default -> false; };
        int ink = label.contains("退出") || label.contains("解散") || label.contains("断开") ? Color.rgb(205, 50, 63) : BLUE;
        int[][] states = {new int[]{-android.R.attr.state_enabled}, new int[0]};
        button.setTextColor(new android.content.res.ColorStateList(states, new int[]{Color.GRAY, primary ? Color.WHITE : ink}));
        android.graphics.drawable.GradientDrawable surface = new android.graphics.drawable.GradientDrawable();
        surface.setColor(new android.content.res.ColorStateList(states, new int[]{primary ? LINE : Color.TRANSPARENT, primary ? BLUE : Color.TRANSPARENT}));
        surface.setCornerRadius(dp(12));
        button.setBackground(new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(Color.rgb(195, 216, 249)), surface, null));
        button.setPadding(dp(14), 0, dp(14), 0); button.setMinHeight(dp(46)); button.setMinimumHeight(dp(46));
        button.setOnClickListener(v -> action.run());
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(parent.getOrientation() == LinearLayout.VERTICAL ? -1 : -2, dp(48));
        if (parent.getOrientation() == LinearLayout.VERTICAL) { layout.topMargin = dp(6); layout.bottomMargin = dp(6); }
        parent.addView(button, layout); return button;
    }
    private void icon(LinearLayout parent, int resource, String label, Runnable action) {
        ImageButton button = new ImageButton(this); button.setImageResource(resource);
        button.setContentDescription(label); button.setTooltipText(label);
        button.setImageTintList(android.content.res.ColorStateList.valueOf(BLUE));
        button.setScaleType(ImageView.ScaleType.CENTER_INSIDE); button.setPadding(dp(10), dp(10), dp(10), dp(10));
        button.setBackgroundColor(Color.TRANSPARENT); button.setOnClickListener(v -> action.run());
        parent.addView(button, new LinearLayout.LayoutParams(dp(44), dp(48)));
    }
    private void divider(LinearLayout parent) {
        View line = new View(this); line.setBackgroundColor(LINE);
        parent.addView(line, new LinearLayout.LayoutParams(-1, dp(1)));
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private static void setText(TextView view, String value) { if (view != null && !value.contentEquals(view.getText())) view.setText(value); }
    private android.graphics.drawable.GradientDrawable surface(int color, int radius) {
        android.graphics.drawable.GradientDrawable value = new android.graphics.drawable.GradientDrawable(); value.setColor(color); value.setCornerRadius(dp(radius)); return value;
    }
    private void inputStyle(EditText input) { input.setTextSize(17); input.setPadding(dp(14), dp(12), dp(14), dp(12)); input.setBackground(surface(Color.WHITE, 12)); }
    private void mark(LinearLayout parent) {
        ImageView art = new ImageView(this); art.setImageResource(R.drawable.ic_launcher_foreground);
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(dp(132), dp(132)); layout.gravity = Gravity.CENTER; parent.addView(art, layout);
    }
    private void toggle(LinearLayout parent, String title, String key) {
        Switch toggle = new Switch(this); toggle.setText(title); toggle.setTextSize(17); toggle.setTextColor(INK);
        toggle.setPadding(dp(14), dp(12), dp(14), dp(12)); toggle.setBackgroundColor(Color.WHITE);
        toggle.setChecked(getSharedPreferences("connection", MODE_PRIVATE).getBoolean(key, true));
        toggle.setOnCheckedChangeListener((v, checked) -> getSharedPreferences("connection", MODE_PRIVATE).edit().putBoolean(key, checked).apply());
        parent.addView(toggle, new LinearLayout.LayoutParams(-1, dp(54))); divider(parent);
    }
    private void showOutcome(GameService.Outcome outcome) {
        if (resultDialog != null) resultDialog.dismiss();
        Dialog dialog = new Dialog(this); resultDialog = dialog; dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL); body.setGravity(Gravity.CENTER_HORIZONTAL);
        body.setPadding(dp(24), dp(24), dp(24), dp(18)); body.setBackground(surface(Color.WHITE, 8));
        TextView symbol = text(outcome.won ? "胜" : "负", 36); symbol.setGravity(Gravity.CENTER);
        symbol.setTextColor(outcome.won ? BLUE : MUTED); symbol.setBackground(surface(outcome.won ? Color.rgb(233, 242, 255) : BACKGROUND, 40));
        body.addView(symbol, new LinearLayout.LayoutParams(dp(80), dp(80)));
        TextView title = text(outcome.won ? "你赢了" : "本局落败", 25); title.setGravity(Gravity.CENTER); title.setPadding(0, dp(18), 0, dp(8)); body.addView(title);
        TextView reason = text(outcome.reason, 15); reason.setTextColor(MUTED); reason.setGravity(Gravity.CENTER); reason.setPadding(0, 0, 0, dp(18)); body.addView(reason);
        button(body, "继续", dialog::dismiss); dialog.setContentView(body); dialog.setOnDismissListener(d -> { body.animate().cancel(); if (resultDialog == dialog) resultDialog = null; });
        dialog.show(); Window window = dialog.getWindow();
        if (window != null) { window.setBackgroundDrawableResource(android.R.color.transparent); window.setWindowAnimations(0); window.setLayout(Math.min(dp(340), getResources().getDisplayMetrics().widthPixels - dp(40)), -2); }
        if (outcome.live && SystemClock.elapsedRealtime() - outcome.at < 2000) {
            feedback.result(outcome.won);
            if (feedback.motion()) { body.setAlpha(0); body.setScaleX(.94f); body.setScaleY(.94f); body.animate().alpha(1).scaleX(1).scaleY(1).setDuration(260).setInterpolator(new android.view.animation.DecelerateInterpolator()).start(); }
        }
    }
    private boolean landscape() { return getResources().getConfiguration().orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE; }
}
