package com.chessflipping.client;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.*;
import android.view.*;
import android.view.animation.DecelerateInterpolator;
import com.chessflipping.game.BoardTransition;
import org.json.*;
import java.util.Arrays;

/** Fixed 4x8 board. No frame callbacks while idle; drawing reuses paints, arrays and metrics. */
public final class ChessBoardView extends View {
    public interface MoveListener { void move(int from, int to); }
    private static final int BLUE = Color.rgb(0, 112, 235), RED_INK = Color.rgb(205, 50, 63), INK = Color.rgb(39, 40, 46);
    private static final Typeface FACE = Typeface.create("sans-serif-medium", Typeface.NORMAL);
    private static final String[] RED = {"", "帅", "仕", "相", "车", "马", "炮", "兵"};
    private static final String[] BLACK = {"", "将", "士", "象", "车", "马", "炮", "卒"};
    private static final String[] COUNTS = {"0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16"};
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint.FontMetrics metrics = new Paint.FontMetrics();
    private final MoveListener listener;
    private final GameFeedback feedback;
    private final int[] cells = new int[32], incoming = new int[32];
    private final int[][] casualties = new int[2][8];
    private final float density, touchSlop;
    private int selected = -1, mine = -1, turn = -1, color, lastTo = -1, capturedCount;
    private long move = -1;
    private boolean ended, tapping;
    private float cell, left, top, side, downX, downY;
    private ValueAnimator animator;
    private float progress = 1;
    private int animationKind, from, to, movingPiece, capturedPiece;

    public ChessBoardView(Context context, MoveListener listener, GameFeedback feedback) {
        super(context); this.listener = listener; this.feedback = feedback;
        setFocusable(true); setContentDescription("四列八行翻棋棋盘，左红方、右黑方阵亡统计");
        density = getResources().getDisplayMetrics().density;
        touchSlop = ViewConfiguration.get(context).getScaledTouchSlop();
        paint.setTypeface(FACE);
    }
    public void setState(JSONObject state, int index) {
        mine = index;
        JSONArray board = state == null ? null : state.optJSONArray("board");
        if (board == null || board.length() != 32) return;
        int oldTurn = turn; boolean oldEnded = ended;
        turn = state.optInt("turn", -1);
        JSONArray colors = state.optJSONArray("colors"); color = colors == null || mine < 0 ? 0 : colors.optInt(mine);
        ended = state.optInt("winner", -1) >= 0;
        long nextMove = state.optLong("move", -1);
        if (nextMove == move && move >= 0) {
            if (turn != oldTurn || ended != oldEnded) invalidate();
            return;
        }
        for (int i = 0; i < 32; i++) {
            incoming[i] = board.optInt(i);
            if (incoming[i] != 99 && (incoming[i] < -7 || incoming[i] > 7)) return;
        }
        JSONArray taken = state.optJSONArray("captured");
        int nextCount = taken == null ? 0 : taken.length();
        int nextFrom = state.optInt("lastFrom", -1), nextTo = state.optInt("lastTo", -1);
        int kind = BoardTransition.classify(cells, incoming, move, nextMove, nextFrom, nextTo, capturedCount, nextCount);
        cancelAnimation(); from = nextFrom; to = nextTo;
        movingPiece = to >= 0 && to < 32 ? incoming[to] : 0;
        capturedPiece = kind == BoardTransition.CAPTURE ? taken.optInt(nextCount - 1) : 0;
        if (capturedPiece < -7 || capturedPiece > 7) capturedPiece = 0;
        System.arraycopy(incoming, 0, cells, 0, 32);
        selected = -1; move = nextMove; lastTo = nextTo; capturedCount = nextCount;
        for (int[] counts : casualties) Arrays.fill(counts, 0);
        if (taken != null) for (int i = 0; i < nextCount; i++) {
            int piece = taken.optInt(i), type = Math.abs(piece);
            if (type >= 1 && type <= 7) casualties[piece > 0 ? 0 : 1][type]++;
        }
        if (kind == BoardTransition.CAPTURE && isShown()) feedback.capture();
        if (kind != BoardTransition.NONE && isShown() && feedback.motion()) {
            animationKind = kind; progress = 0; animator = ValueAnimator.ofFloat(0, 1);
            animator.setDuration(kind == BoardTransition.CAPTURE ? 260 : 210);
            animator.setInterpolator(new DecelerateInterpolator(1.25f));
            animator.addUpdateListener(value -> { progress = (float)value.getAnimatedValue(); invalidate(); });
            animator.start();
        }
        invalidate();
    }
    public boolean animating() { return animator != null && animator.isRunning(); }
    public void pause() { cancelAnimation(); move = -1; selected = -1; }
    private void cancelAnimation() {
        if (animator != null) { animator.removeAllUpdateListeners(); animator.cancel(); animator = null; }
        progress = 1; animationKind = BoardTransition.NONE;
    }
    @Override protected void onDetachedFromWindow() { cancelAnimation(); super.onDetachedFromWindow(); }
    @Override protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        side = Math.min(52 * density, w * .16f);
        cell = Math.max(1, Math.min((w - 2 * side - 16 * density) / 4f, (h - 16 * density) / 8f));
        left = (w - cell * 4) / 2; top = Math.max(0, (h - cell * 8) / 2);
    }
    private float x(int i) { return left + (i % 4 + .5f) * cell; }
    private float y(int i) { return top + (i / 4 + .5f) * cell; }
    private float sideX(boolean red) { return red ? left - side / 2 : left + 4 * cell + side / 2; }
    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        fill(Color.rgb(223, 226, 234), 255);
        canvas.drawRoundRect(left - 3 * density, top - 3 * density, left + 4 * cell + 3 * density, top + 8 * cell + 3 * density, 8 * density, 8 * density, paint);
        for (int i = 0; i < 32; i++) {
            float x = x(i), y = y(i);
            int tile = i == selected ? Color.rgb(208, 228, 255) : i == lastTo ? Color.rgb(225, 234, 250) : Color.rgb(243, 244, 248);
            fill(tile, 255);
            canvas.drawRoundRect(x - cell * .48f, y - cell * .48f, x + cell * .48f, y + cell * .48f, 3 * density, 3 * density, paint);
            if (progress < 1 && i == to) continue;
            if (cells[i] != 0) drawPiece(canvas, x, y, cell * .39f, cells[i], true, 255);
            if (i == selected) {
                paint.setColor(BLUE); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(2 * density);
                canvas.drawCircle(x, y, cell * .43f, paint); paint.setStyle(Paint.Style.FILL);
            }
        }
        drawCasualties(canvas, true); drawCasualties(canvas, false);
        if (progress < 1) drawTransition(canvas);
    }
    private void drawTransition(Canvas canvas) {
        float tx = x(to), ty = y(to), radius = cell * .39f;
        if (animationKind == BoardTransition.FLIP) {
            canvas.save(); canvas.scale(Math.max(.035f, Math.abs(1 - progress * 2)), 1, tx, ty);
            drawPiece(canvas, tx, ty, radius, progress < .5f ? 99 : movingPiece, true, 255);
            canvas.restore(); return;
        }
        if (animationKind == BoardTransition.CAPTURE && capturedPiece != 0) {
            float drift = Math.max(0, (progress - .35f) / .65f);
            float sx = sideX(capturedPiece > 0), sy = top + (Math.abs(capturedPiece) + .43f) * cell;
            float targetRadius = Math.min(side * .30f, cell * .30f);
            drawPiece(canvas, tx + (sx - tx) * drift, ty + (sy - ty) * drift - (float)Math.sin(drift * Math.PI) * cell * .35f,
                    radius + (targetRadius - radius) * drift, capturedPiece, true, (int)(255 * (1 - drift)));
        }
        float movement = Math.min(1, progress / .78f);
        drawPiece(canvas, x(from) + (tx - x(from)) * movement, y(from) + (ty - y(from)) * movement,
                radius * (1 + .06f * (float)Math.sin(movement * Math.PI)), movingPiece, true, 255);
    }
    private void fill(int color, int alpha) { paint.setStyle(Paint.Style.FILL); paint.setColor(color); paint.setAlpha(alpha); }
    private void centered(Canvas canvas, String text, float x, float y, float size) {
        paint.setTextAlign(Paint.Align.CENTER); paint.setTextSize(size); paint.getFontMetrics(metrics);
        canvas.drawText(text, x, y - (metrics.ascent + metrics.descent) / 2, paint);
    }
    private void drawPiece(Canvas canvas, float x, float y, float radius, int piece, boolean lit, int alpha) {
        fill(lit ? Color.rgb(203, 207, 217) : Color.rgb(228, 230, 237), alpha);
        canvas.drawCircle(x, y + density, radius, paint);
        fill(!lit ? Color.rgb(236, 237, 242) : piece == 99 ? Color.rgb(239, 242, 249) : Color.WHITE, alpha);
        canvas.drawCircle(x, y, radius, paint);
        int ink = !lit ? Color.rgb(168, 173, 184) : piece == 99 ? Color.rgb(110, 126, 154) : piece > 0 ? RED_INK : INK;
        paint.setColor(ink); paint.setAlpha(alpha); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(Math.max(1, radius * .048f));
        canvas.drawCircle(x, y, radius * .82f, paint); paint.setStyle(Paint.Style.FILL);
        int type = Math.abs(piece);
        centered(canvas, piece == 99 ? "棋" : type >= 1 && type <= 7 ? (piece > 0 ? RED[type] : BLACK[type]) : "", x, y, radius * 1.05f);
        paint.setAlpha(255);
    }
    private void drawCasualties(Canvas canvas, boolean red) {
        float x = sideX(red);
        fill(red ? RED_INK : INK, 255);
        centered(canvas, red ? "红方" : "黑方", x, top + cell * .38f, Math.min(12 * density, cell * .28f));
        if (cell > 40 * density) {
            fill(Color.rgb(142, 142, 147), 255);
            centered(canvas, "已阵亡", x, top + cell * .72f, 10 * density);
        }
        float radius = Math.min(side * .30f, cell * .30f);
        for (int type = 1; type <= 7; type++) {
            float y = top + (type + .43f) * cell;
            int count = casualties[red ? 0 : 1][type];
            float scale = progress < 1 && animationKind == BoardTransition.CAPTURE && capturedPiece == (red ? type : -type)
                    ? 1 + .13f * (float)Math.sin(progress * Math.PI) : 1;
            drawPiece(canvas, x, y, radius * scale, red ? type : -type, count > 0, 255);
            if (count > 0) {
                float badge = Math.max(5 * density, radius * .4f), bx = x + radius * .76f, by = y + radius * .73f;
                fill(Color.rgb(229, 58, 66), 255); canvas.drawCircle(bx, by, badge, paint);
                fill(Color.WHITE, 255); centered(canvas, COUNTS[Math.min(16, count)], bx, by, badge * 1.35f);
            }
        }
    }
    @Override public boolean onTouchEvent(MotionEvent event) {
        if (event.getAction() == MotionEvent.ACTION_DOWN) { downX = event.getX(); downY = event.getY(); tapping = true; return true; }
        if (event.getAction() == MotionEvent.ACTION_CANCEL) { tapping = false; return true; }
        if (event.getAction() == MotionEvent.ACTION_MOVE && (Math.abs(event.getX() - downX) > touchSlop || Math.abs(event.getY() - downY) > touchSlop)) tapping = false;
        if (event.getAction() != MotionEvent.ACTION_UP || !tapping) return true;
        performClick();
        if (!isEnabled() || mine != turn || mine < 0 || ended || animating() || cell <= 0 || event.getX() < left || event.getY() < top
                || event.getX() >= left + 4 * cell || event.getY() >= top + 8 * cell) return true;
        int index = (int)((event.getY() - top) / cell) * 4 + (int)((event.getX() - left) / cell);
        if (index == selected) selected = -1;
        else if (selected >= 0 && (cells[index] == 0 || cells[index] == 99 || Integer.signum(cells[index]) != color)) { listener.move(selected, index); selected = -1; }
        else if (cells[index] == 99) listener.move(-1, index);
        else if (cells[index] != 0 && Integer.signum(cells[index]) == color) selected = index;
        else selected = -1;
        invalidate(); return true;
    }
    @Override public boolean performClick() { super.performClick(); return true; }
}
