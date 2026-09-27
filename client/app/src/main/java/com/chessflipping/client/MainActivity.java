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
    private static final int INK = Color.rgb(29, 40, 41), GREEN = Color.rgb(20, 112, 90);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private GameService service;
    private LinearLayout root, content;
    private TextView connection, clock;
    private ChessBoardView board;
    private boolean bound, visible, settings, autoConnect = true;
    private String renderedKey = "";
    private final Runnable clockTick = new Runnable() {
        public void run() { updateClock(); handler.postDelayed(this, 250); }
    };
    private final ServiceConnection binding = new ServiceConnection() {
        public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((GameService.LocalBinder)binder).service();
            service.foreground(visible); service.observe(MainActivity.this);
            if (autoConnect && !service.connected) { autoConnect = false; connect(); }
        }
        public void onServiceDisconnected(ComponentName name) { service = null; renderedKey = ""; }
    };

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (saved != null) autoConnect = saved.getBoolean("autoConnect", false);
        root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(245, 248, 247));
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
        TextView title = text("翻棋", 24); title.setTypeface(null, android.graphics.Typeface.BOLD);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
        title.setGravity(Gravity.CENTER_VERTICAL);
        icon(toolbar, android.R.drawable.ic_menu_rotate, "刷新状态", () -> {
            if (service != null) { if (service.room == null) service.listRooms(); else service.sync(); }
        });
        icon(toolbar, android.R.drawable.ic_menu_preferences, "服务器设置", () -> { settings = true; showSettings(); });
        Button rules = button(toolbar, "规则", this::showRules); rules.setMinWidth(0); rules.setMinimumWidth(0);
        connection = text("正在初始化", 13); connection.setPadding(dp(16), dp(8), dp(16), dp(8)); root.addView(connection);
        connection.setLines(landscape() ? 1 : 2); connection.setEllipsize(android.text.TextUtils.TruncateAt.END);
        content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL);
        root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
        bound = bindService(new Intent(this, GameService.class), binding, BIND_AUTO_CREATE);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
    }
    @Override protected void onStart() {
        super.onStart(); visible = true;
        if (service != null) {
            service.foreground(true); service.observe(this);
            if (service.connected && service.room != null) service.sync();
        }
        handler.post(clockTick);
    }
    @Override protected void onStop() {
        visible = false; handler.removeCallbacks(clockTick);
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
        if (service == null) return;
        connection.setText(service.status + "  ·  " + service.host() + ":" + service.port());
        connection.setTextColor(service.connected ? GREEN : Color.DKGRAY);
        if (settings) return;
        String key = !service.connected ? "offline" : service.room == null ? "lobby:" + service.listingRooms + ":" + service.rooms.toString()
                : "room:" + service.room.toString() + ":" + (service.playing() ? "playing" : String.valueOf(service.state));
        if (!key.equals(renderedKey)) {
            renderedKey = key; content.removeAllViews(); content.setOrientation(LinearLayout.VERTICAL); clock = null; board = null;
            if (!service.connected) showOffline();
            else if (service.room == null) showLobby();
            else if (service.playing()) showGame();
            else showWaiting();
        }
        if (board != null) board.setState(service.state, service.myIndex());
        updateClock();
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
        heading(inner, "联机翻棋");
        button(inner, "连接服务器", this::connect);
        button(inner, "服务器设置", () -> { settings = true; showSettings(); });
    }
    private void showLobby() {
        LinearLayout inner = scrollContent();
        heading(inner, "房间大厅");
        button(inner, "创建房间", this::createDialog);
        if (service.listingRooms) addText(inner, "正在获取房间…", 15);
        else if (service.rooms.isEmpty()) addText(inner, "暂无房间", 16);
        for (JSONObject entry : service.rooms) {
            LinearLayout item = row(inner); item.setPadding(0, dp(12), 0, dp(12));
            LinearLayout labels = new LinearLayout(this); labels.setOrientation(LinearLayout.VERTICAL);
            item.addView(labels, new LinearLayout.LayoutParams(0, -2, 1));
            addText(labels, "#" + entry.optLong("id") + " " + entry.optString("name"), 18);
            addText(labels, entry.optInt("count") + "/2  ·  " + (entry.optBoolean("playing") ? "游戏中" : "等待中"), 13);
            Button join = button(item, "加入", () -> service.join(entry.optLong("id")));
            join.setEnabled(!entry.optBoolean("playing") && entry.optInt("count") < 2 && !service.listingRooms);
            divider(inner);
        }
        button(inner, "断开连接", () -> service.disconnect());
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
        heading(inner, "#" + room.optLong("roomId") + " " + room.optString("name"));
        if (!service.lastResult.isEmpty()) addText(inner, service.lastResult, 17);
        JSONArray members = room.optJSONArray("members");
        for (int i = 0; i < members.length(); i++) {
            String id = members.optString(i);
            addText(inner, (id.equals(service.selfId) ? "你" : "对方") + (i == 0 ? " · 房主" : "")
                    + "    " + (service.isReady(id) ? "已准备" : "未准备"), 20);
        }
        if (members.length() < 2) addText(inner, "等待另一位玩家加入", 16);
        divider(inner); addText(inner, "每步时间", 16);
        int selected = service.state == null ? 60 : service.state.optInt("seconds", 60);
        RadioGroup choices = new RadioGroup(this); choices.setOrientation(LinearLayout.HORIZONTAL);
        int[] values = {30, 60, 90, 0}; String[] labels = {"30秒", "60秒", "90秒", "无限"};
        for (int i = 0; i < values.length; i++) {
            RadioButton choice = new RadioButton(this); choice.setText(labels[i]); choice.setTextSize(13); choice.setId(100 + i);
            choice.setMinWidth(0); choice.setPadding(0, dp(8), 0, dp(8));
            choices.addView(choice, new RadioGroup.LayoutParams(0, -2, 1));
            choice.setEnabled(service.isHost() && service.state != null);
            if (values[i] == selected) choices.check(choice.getId());
        }
        choices.setOnCheckedChangeListener((group, id) -> { if (id >= 100 && id < 104) service.timeLimit(values[id - 100]); });
        inner.addView(choices);
        Button ready = button(inner, service.isReady(service.selfId) ? "取消准备" : "准备", () -> service.ready(!service.isReady(service.selfId)));
        ready.setEnabled(service.state != null);
        button(inner, "退出房间", this::confirmLeave);
        if (service.isHost()) button(inner, "解散房间", this::confirmDissolve);
    }
    private void showGame() {
        LinearLayout details = content;
        if (landscape()) {
            content.setOrientation(LinearLayout.HORIZONTAL);
            ScrollView scroll = new ScrollView(this);
            details = new LinearLayout(this); details.setOrientation(LinearLayout.VERTICAL);
            details.setPadding(dp(12), dp(8), dp(12), dp(8));
            scroll.addView(details);
            content.addView(scroll, new LinearLayout.LayoutParams(dp(220), -1));
        }
        TextView roomTitle = text("#" + service.room.optLong("roomId") + " " + service.room.optString("name"), 16);
        roomTitle.setPadding(dp(16), 0, dp(16), dp(4)); details.addView(roomTitle);
        clock = text("正在同步棋局", 16); clock.setGravity(Gravity.CENTER);
        clock.setPadding(dp(8), dp(6), dp(8), dp(6)); details.addView(clock);
        board = new ChessBoardView(this, (from, to) -> service.move(from, to));
        content.addView(board, landscape() ? new LinearLayout.LayoutParams(0, -1, 1) : new LinearLayout.LayoutParams(-1, 0, 1));
        LinearLayout actions = row(details); actions.setGravity(Gravity.CENTER);
        if (landscape()) actions.setOrientation(LinearLayout.VERTICAL);
        button(actions, "退出本局", this::confirmLeave);
        if (service.isHost()) button(actions, "解散房间", this::confirmDissolve);
    }
    private void updateClock() {
        if (clock == null || service == null || service.state == null) return;
        JSONObject state = service.state;
        int mine = service.myIndex(), turn = state.optInt("turn", -1);
        JSONArray colors = state.optJSONArray("colors"); int color = colors == null ? 0 : colors.optInt(mine);
        long remaining = service.displayedRemaining();
        String separator = landscape() ? "\n" : "  ·  ";
        clock.setText((color == 0 ? "尚未定色" : color > 0 ? "你执红棋" : "你执黑棋") + separator
                + (turn == mine ? "你的回合" : "对方回合") + separator + (remaining < 0 ? "无限" : ((remaining + 999) / 1000) + " 秒"));
        clock.setTextColor(turn == mine ? GREEN : INK);
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
        renderedKey = ""; content.removeAllViews(); content.setOrientation(LinearLayout.VERTICAL); board = null; clock = null;
        LinearLayout inner = scrollContent(); heading(inner, "服务器设置");
        addText(inner, "服务器地址", 15);
        EditText host = new EditText(this); host.setSingleLine(true);
        host.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        host.setText(service == null ? GameService.DEFAULT_HOST : service.host()); inner.addView(host);
        addText(inner, "TCP 端口", 15);
        EditText port = new EditText(this); port.setSingleLine(true); port.setInputType(InputType.TYPE_CLASS_NUMBER);
        port.setText(Integer.toString(service == null ? GameService.DEFAULT_PORT : service.port())); inner.addView(port);
        button(inner, "保存并连接", () -> {
            if (service == null) return;
            String address = host.getText().toString().trim();
            if (address.isEmpty() || address.contains("/") || address.codePoints().anyMatch(Character::isWhitespace)) {
                host.setError("请输入域名或 IP，不包含协议前缀或路径"); return;
            }
            int number;
            try { number = Integer.parseInt(port.getText().toString()); if (number < 1 || number > 65535) throw new NumberFormatException(); }
            catch (NumberFormatException ex) { port.setError("端口范围为 1 至 65535"); return; }
            Runnable save = () -> { service.saveServer(address, number); settings = false; changed(); connect(); };
            if (service.room != null) new AlertDialog.Builder(this).setTitle("更换服务器？")
                    .setMessage(service.playing() ? "当前对局将按退出判负。" : "将退出当前房间并重新连接。")
                    .setNegativeButton("取消", null).setPositiveButton("保存并连接", (d, w) -> save.run()).show();
            else save.run();
        });
        button(inner, "恢复默认值", () -> { host.setText(GameService.DEFAULT_HOST); port.setText(Integer.toString(GameService.DEFAULT_PORT)); });
        button(inner, "返回", () -> { settings = false; changed(); });
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
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(INK); return view;
    }
    private void addText(LinearLayout parent, String value, int size) {
        TextView view = text(value, size); view.setPadding(0, dp(8), 0, dp(8)); parent.addView(view);
    }
    private void heading(LinearLayout parent, String value) { addText(parent, value, 22); }
    private LinearLayout row(LinearLayout parent) {
        LinearLayout row = new LinearLayout(this); row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL); parent.addView(row, new LinearLayout.LayoutParams(-1, -2)); return row;
    }
    private Button button(LinearLayout parent, String label, Runnable action) {
        Button button = new Button(this); button.setText(label); button.setAllCaps(false); button.setTextSize(15);
        button.setLetterSpacing(0); button.setElevation(0); button.setStateListAnimator(null);
        boolean primary = switch (label) { case "创建房间", "准备", "连接服务器", "保存并连接", "加入" -> true; default -> false; };
        int ink = label.contains("退出") || label.contains("解散") || label.contains("断开") ? Color.rgb(159, 56, 62) : GREEN;
        int[][] states = {new int[]{-android.R.attr.state_enabled}, new int[0]};
        button.setTextColor(new android.content.res.ColorStateList(states, new int[]{Color.GRAY, primary ? Color.WHITE : ink}));
        android.graphics.drawable.GradientDrawable surface = new android.graphics.drawable.GradientDrawable();
        surface.setColor(new android.content.res.ColorStateList(states, new int[]{primary ? Color.rgb(222, 229, 225) : Color.TRANSPARENT, primary ? GREEN : Color.TRANSPARENT}));
        surface.setCornerRadius(dp(6));
        button.setBackground(new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(Color.rgb(195, 220, 207)), surface, null));
        button.setPadding(dp(14), 0, dp(14), 0); button.setMinHeight(dp(46)); button.setMinimumHeight(dp(46));
        button.setOnClickListener(v -> action.run());
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(parent.getOrientation() == LinearLayout.VERTICAL ? -1 : -2, dp(48));
        if (parent.getOrientation() == LinearLayout.VERTICAL) { layout.topMargin = dp(6); layout.bottomMargin = dp(6); }
        parent.addView(button, layout); return button;
    }
    private void icon(LinearLayout parent, int resource, String label, Runnable action) {
        ImageButton button = new ImageButton(this); button.setImageResource(resource);
        button.setContentDescription(label); button.setTooltipText(label);
        button.setImageTintList(android.content.res.ColorStateList.valueOf(GREEN));
        button.setScaleType(ImageView.ScaleType.CENTER_INSIDE); button.setPadding(dp(10), dp(10), dp(10), dp(10));
        button.setBackgroundColor(Color.TRANSPARENT); button.setOnClickListener(v -> action.run());
        parent.addView(button, new LinearLayout.LayoutParams(dp(44), dp(48)));
    }
    private void divider(LinearLayout parent) {
        View line = new View(this); line.setBackgroundColor(Color.rgb(217, 225, 222));
        parent.addView(line, new LinearLayout.LayoutParams(-1, dp(1)));
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private boolean landscape() { return getResources().getConfiguration().orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE; }
}
