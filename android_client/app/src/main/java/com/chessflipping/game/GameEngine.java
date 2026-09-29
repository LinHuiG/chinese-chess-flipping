package com.chessflipping.game;

import java.util.*;
import org.json.*;

/** The project's custom flip-chess rules. No Android or network dependencies. */
public final class GameEngine {
    public static final int KING = 1, ADVISOR = 2, ELEPHANT = 3, ROOK = 4, HORSE = 5, CANNON = 6, PAWN = 7;
    public final int[] pieces = new int[32];
    public final boolean[] revealed = new boolean[32];
    public final int[] colors = new int[2];
    public final List<Integer> captured = new ArrayList<>();
    private final Set<String> history = new HashSet<>();
    public int turn, winner = -1, lastFrom = -1, lastTo = -1;
    public String reason = "";
    public final int seconds;
    private long deadline;
    private boolean started;

    public GameEngine(Random random, int seconds) {
        if (seconds != 0 && seconds != 30 && seconds != 60 && seconds != 90) throw new IllegalArgumentException("Invalid time limit");
        this.seconds = seconds;
        int offset = 0;
        for (int color : new int[]{1, -1}) {
            for (int type = KING; type <= PAWN; type++) {
                int count = type == KING ? 1 : type == PAWN ? 5 : 2;
                for (int i = 0; i < count; i++) pieces[offset++] = color * type;
            }
        }
        for (int i = pieces.length - 1; i > 0; i--) {
            int j = random.nextInt(i + 1), value = pieces[i];
            pieces[i] = pieces[j]; pieces[j] = value;
        }
        turn = random.nextInt(2);
        history.add(boardKey());
    }

    public GameEngine(JSONObject saved) throws JSONException {
        seconds = saved.getInt("seconds");
        if (seconds != 0 && seconds != 30 && seconds != 60 && seconds != 90) throw new JSONException("Invalid time limit");
        JSONArray board = saved.getJSONArray("pieces"), face = saved.getJSONArray("revealed"), color = saved.getJSONArray("colors");
        if (board.length() != 32 || face.length() != 32 || color.length() != 2) throw new JSONException("Invalid saved board");
        for (int i = 0; i < 32; i++) { pieces[i] = board.getInt(i); revealed[i] = face.getBoolean(i); if (Math.abs(pieces[i]) > 7) throw new JSONException("Invalid piece"); }
        for (int i = 0; i < 2; i++) colors[i] = color.getInt(i);
        JSONArray taken = saved.getJSONArray("captured"), past = saved.getJSONArray("history");
        for (int i = 0; i < taken.length(); i++) captured.add(taken.getInt(i));
        for (int i = 0; i < past.length(); i++) { String key = past.getString(i); if (key.length() != 32) throw new JSONException("Invalid history"); history.add(key); }
        turn = saved.getInt("turn"); winner = saved.getInt("winner"); reason = saved.getString("reason");
        lastFrom = saved.getInt("lastFrom"); lastTo = saved.getInt("lastTo");
        deadline = saved.getLong("deadline"); started = saved.getBoolean("started");
        if (turn < 0 || turn > 1 || winner < -1 || winner > 1 || !history.contains(boardKey())) throw new JSONException("Invalid saved game");
    }
    public JSONObject save() throws JSONException {
        return new JSONObject().put("seconds", seconds).put("pieces", new JSONArray(pieces)).put("revealed", new JSONArray(revealed))
                .put("colors", new JSONArray(colors)).put("captured", new JSONArray(captured)).put("history", new JSONArray(history))
                .put("turn", turn).put("winner", winner).put("reason", reason).put("lastFrom", lastFrom).put("lastTo", lastTo)
                .put("deadline", deadline).put("started", started);
    }

    public void start(long now) { if (!started) { started = true; resetClock(now); } }
    public long remaining(long now) { return seconds == 0 ? -1 : Math.max(0, started ? deadline - now : seconds * 1000L); }
    public boolean checkTimeout(long now) {
        if (winner < 0 && started && seconds > 0 && now >= deadline) {
            winner = 1 - turn; reason = "TIMEOUT"; return true;
        }
        return false;
    }
    public String act(int player, int from, int to, long now) {
        if (!started) return "正在开始对局";
        if (checkTimeout(now) || winner >= 0) return "对局已经结束";
        if (player != turn) return "请等待对方行动";
        if (to < 0 || to >= 32) return "目标超出棋盘";
        boolean flip = from == -1;
        if (flip) {
            if (pieces[to] == 0 || revealed[to]) return "请选择一枚暗棋";
            revealed[to] = true;
            if (colors[player] == 0) {
                colors[player] = Integer.signum(pieces[to]);
                colors[1 - player] = -colors[player];
            }
            history.clear();
        } else {
            if (colors[player] == 0 || !legalMove(from, to, colors[player], true)) return "走法无效或会形成重复棋面";
            if (pieces[to] != 0) { captured.add(pieces[to]); history.clear(); }
            pieces[to] = pieces[from]; revealed[to] = true;
            pieces[from] = 0; revealed[from] = false;
        }
        lastFrom = from; lastTo = to;
        history.add(boardKey());
        for (int i = 0; i < 2; i++) {
            if (colors[i] != 0 && remainingPieces(colors[i]) == 0) {
                winner = 1 - i; reason = "NO_PIECES"; return null;
            }
        }
        turn = 1 - turn;
        if (!hasAction(colors[turn])) { winner = 1 - turn; reason = "NO_MOVES"; }
        if (winner < 0) resetClock(now);
        return null;
    }

    public int remainingPieces(int color) {
        int count = 0;
        for (int piece : pieces) if (Integer.signum(piece) == color) count++;
        return count;
    }
    public int[] publicBoard() {
        int[] board = new int[32];
        for (int i = 0; i < 32; i++) board[i] = pieces[i] == 0 ? 0 : revealed[i] ? pieces[i] : 99;
        return board;
    }
    public boolean hasAction(int color) {
        for (int i = 0; i < 32; i++) if (pieces[i] != 0 && !revealed[i]) return true;
        for (int from = 0; from < 32; from++) for (int to = 0; to < 32; to++)
            if (legalMove(from, to, color, true)) return true;
        return false;
    }

    public boolean legalMove(int from, int to, int color, boolean checkHistory) {
        if (from < 0 || from >= 32 || to < 0 || to >= 32 || from == to || color == 0
                || pieces[from] == 0 || !revealed[from] || Integer.signum(pieces[from]) != color) return false;
        int target = pieces[to], type = Math.abs(pieces[from]);
        if (target != 0 && revealed[to] && Integer.signum(target) == color) return false;
        int dx = Math.abs(from % 4 - to % 4), dy = Math.abs(from / 4 - to / 4);
        boolean adjacent = dx + dy == 1, straight = dx == 0 || dy == 0;
        boolean valid = false;
        if (type == HORSE && dx == 1 && dy == 1) valid = true;
        else if (type == ROOK && straight && dx + dy >= 2) valid = obstacles(from, to) == 0;
        else if (type == CANNON && straight) {
            int between = obstacles(from, to);
            if (target == 0) valid = between == 0;
            else if (between == 1) valid = true;
            else valid = adjacent && revealed[to] && Math.abs(target) == PAWN;
        } else if (adjacent) {
            if (target == 0) valid = true;
            else if (revealed[to]) {
                int other = Math.abs(target);
                valid = switch (type) {
                    case KING -> other != PAWN;
                    case ADVISOR, ELEPHANT, ROOK, HORSE -> other > type;
                    case PAWN -> other == KING || other == PAWN;
                    default -> false;
                };
            }
        }
        if (!valid || !checkHistory || target != 0) return valid;
        int original = pieces[from];
        pieces[to] = original; revealed[to] = true;
        pieces[from] = 0; revealed[from] = false;
        boolean repeated = history.contains(boardKey());
        pieces[from] = original; revealed[from] = true;
        pieces[to] = 0; revealed[to] = false;
        return !repeated;
    }

    private int obstacles(int from, int to) {
        int step = from / 4 == to / 4 ? Integer.signum(to - from) : 4 * Integer.signum(to - from);
        int count = 0;
        for (int i = from + step; i != to; i += step) if (pieces[i] != 0) count++;
        return count;
    }
    private String boardKey() {
        char[] key = new char[32];
        for (int i = 0; i < 32; i++) key[i] = (char)(pieces[i] == 0 ? 0 : !revealed[i] ? 1 : pieces[i] + 9);
        return new String(key);
    }
    private void resetClock(long now) { deadline = now + seconds * 1000L; }
}
