package com.chessflipping.game;

/** Only animate a verified adjacent snapshot, never a sync, resume or missed move. */
public final class BoardTransition {
    public static final int NONE = 0, FLIP = 1, MOVE = 2, CAPTURE = 3;
    private BoardTransition() { }

    public static int classify(int[] before, int[] after, long previousMove, long move,
                               int from, int to, int previousCaptured, int captured) {
        if (before.length != 32 || after.length != 32 || previousMove < 0 || move != previousMove + 1
                || to < 0 || to >= 32 || from < -1 || from >= 32 || from == to) return NONE;
        for (int i = 0; i < 32; i++) if (i != from && i != to && before[i] != after[i]) return NONE;
        if (from == -1) return before[to] == 99 && Math.abs(after[to]) >= 1 && Math.abs(after[to]) <= 7
                && captured == previousCaptured ? FLIP : NONE;
        if (before[from] == 0 || before[from] == 99 || after[from] != 0 || after[to] != before[from]) return NONE;
        if (before[to] == 0 && captured == previousCaptured) return MOVE;
        return before[to] != 0 && captured == previousCaptured + 1 ? CAPTURE : NONE;
    }
}
