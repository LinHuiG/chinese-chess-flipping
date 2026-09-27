package com.chessflipping.client;

import android.content.Context;
import android.graphics.*;
import android.view.*;
import org.json.*;

/** A fixed 4 by 8 board with red and black casualty columns. */
public final class ChessBoardView extends View {
    public interface MoveListener { void move(int from, int to); }
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final MoveListener listener;
    private final int[] cells = new int[32];
    private final int[][] casualties = new int[2][8];
    private int selected = -1, mine = -1, turn = -1, color, lastTo = -1;
    private long move = -1;
    private boolean ended;
    private float cell, left, top, density;
    private static final String[] RED = {"", "帅", "仕", "相", "车", "马", "炮", "兵"};
    private static final String[] BLACK = {"", "将", "士", "象", "车", "马", "炮", "卒"};

    public ChessBoardView(Context context, MoveListener listener) {
        super(context); this.listener = listener; setFocusable(true); setContentDescription("四列八行翻棋棋盘");
        density = getResources().getDisplayMetrics().density;
    }
    public void setState(JSONObject state, int index) {
        mine = index;
        if (state == null || state.optJSONArray("board") == null) return;
        JSONArray board = state.optJSONArray("board");
        for (int i = 0; i < 32; i++) cells[i] = board.optInt(i);
        turn = state.optInt("turn", -1); color = state.optJSONArray("colors").optInt(mine);
        if (move != state.optLong("move")) selected = -1;
        move = state.optLong("move"); lastTo = state.optInt("lastTo", -1); ended = state.optInt("winner", -1) >= 0;
        for (int[] counts : casualties) java.util.Arrays.fill(counts, 0);
        JSONArray taken = state.optJSONArray("captured");
        if (taken != null) for (int i = 0; i < taken.length(); i++) {
            int piece = taken.optInt(i), type = Math.abs(piece);
            if (type >= 1 && type <= 7) casualties[piece > 0 ? 0 : 1][type]++;
        }
        invalidate();
    }
    private static String label(int piece) { int type = Math.abs(piece); return type <= 7 ? (piece > 0 ? RED[type] : BLACK[type]) : ""; }
    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float side = Math.min(54 * density, getWidth() * .16f);
        cell = Math.max(1, Math.min((getWidth() - 2 * side - 12 * density) / 4f, (getHeight() - 12 * density) / 8f));
        left = (getWidth() - cell * 4) / 2; top = Math.max(0, (getHeight() - cell * 8) / 2);
        paint.setStyle(Paint.Style.FILL); paint.setColor(Color.rgb(218, 230, 224));
        canvas.drawRoundRect(left, top, left + 4 * cell, top + 8 * cell, 6 * density, 6 * density, paint);
        for (int i = 0; i < 32; i++) {
            float x = left + (i % 4 + .5f) * cell, y = top + (i / 4 + .5f) * cell;
            paint.setColor(i == selected ? Color.rgb(142, 200, 174) : i == lastTo ? Color.rgb(191, 212, 198) : Color.rgb(231, 240, 235));
            canvas.drawRect(x - cell * .47f, y - cell * .47f, x + cell * .47f, y + cell * .47f, paint);
            if (cells[i] != 0) drawPiece(canvas, x, y, cell * .39f, cells[i], true);
        }
        drawCasualties(canvas, Math.max(side / 2, left - side / 2), true, side);
        drawCasualties(canvas, Math.min(getWidth() - side / 2, left + 4 * cell + side / 2), false, side);
    }
    private void drawPiece(Canvas canvas, float x, float y, float radius, int piece, boolean lit) {
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(!lit ? Color.rgb(226, 231, 228) : piece == 99 ? Color.rgb(37, 102, 91) : Color.WHITE);
        canvas.drawCircle(x, y, radius, paint);
        int ink = !lit ? Color.rgb(161, 171, 166) : piece == 99 ? Color.rgb(211, 231, 220)
                : piece > 0 ? Color.rgb(185, 49, 55) : Color.rgb(39, 48, 53);
        paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(Math.max(1, radius * .065f)); paint.setColor(ink);
        canvas.drawCircle(x, y, radius * .83f, paint); paint.setStyle(Paint.Style.FILL);
        paint.setTypeface(Typeface.create("sans-serif", Typeface.BOLD)); paint.setTextAlign(Paint.Align.CENTER);
        paint.setTextSize(radius * (piece == 99 ? .85f : 1.1f));
        Paint.FontMetrics fm = paint.getFontMetrics();
        canvas.drawText(piece == 99 ? "棋" : label(piece), x, y - (fm.ascent + fm.descent) / 2, paint);
    }
    private void drawCasualties(Canvas canvas, float x, boolean red, float side) {
        paint.setTextAlign(Paint.Align.CENTER); paint.setTypeface(Typeface.DEFAULT_BOLD);
        paint.setTextSize(12 * density); paint.setColor(red ? Color.rgb(185, 49, 55) : Color.rgb(39, 48, 53));
        canvas.drawText(red ? "红方" : "黑方", x, top + cell * .35f, paint);
        paint.setTextSize(10 * density); paint.setColor(Color.GRAY);
        canvas.drawText("已阵亡", x, top + cell * .35f + 13 * density, paint);
        float radius = Math.min(side * .32f, cell * .32f);
        for (int type = 1; type <= 7; type++) {
            float y = top + (type + .43f) * cell;
            int count = casualties[red ? 0 : 1][type];
            drawPiece(canvas, x, y, radius, red ? type : -type, count > 0);
            if (count > 0) {
                float badge = Math.max(5 * density, radius * .41f), bx = x + radius * .76f, by = y + radius * .73f;
                paint.setColor(Color.rgb(218, 48, 59)); canvas.drawCircle(bx, by, badge, paint);
                paint.setColor(Color.WHITE); paint.setTextSize(badge * 1.4f); paint.setTextAlign(Paint.Align.CENTER);
                Paint.FontMetrics fm = paint.getFontMetrics();
                canvas.drawText(Integer.toString(count), bx, by - (fm.ascent + fm.descent) / 2, paint);
            }
        }
    }
    @Override public boolean onTouchEvent(MotionEvent event) {
        if (event.getAction() == MotionEvent.ACTION_DOWN) return true;
        if (event.getAction() != MotionEvent.ACTION_UP) return true;
        performClick();
        if (mine != turn || mine < 0 || ended || cell <= 0 || event.getX() < left || event.getY() < top
                || event.getX() >= left + 4 * cell || event.getY() >= top + 8 * cell) return true;
        int index = (int)((event.getY() - top) / cell) * 4 + (int)((event.getX() - left) / cell);
        if (index == selected) selected = -1;
        else if (selected >= 0 && (cells[index] == 0 || cells[index] == 99 || Integer.signum(cells[index]) != color)) {
            listener.move(selected, index); selected = -1;
        } else if (cells[index] == 99) listener.move(-1, index);
        else if (cells[index] != 0 && Integer.signum(cells[index]) == color) selected = index;
        else selected = -1;
        invalidate(); return true;
    }
    @Override public boolean performClick() { super.performClick(); return true; }
}
