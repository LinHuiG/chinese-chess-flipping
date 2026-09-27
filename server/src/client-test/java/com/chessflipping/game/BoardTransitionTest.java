package com.chessflipping.game;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static com.chessflipping.game.BoardTransition.*;

class BoardTransitionTest {
    @Test void realMoveFlipAndHiddenCaptureAreClassified() {
        int[] before = new int[32], after;
        before[0] = 4; after = before.clone(); after[0] = 0; after[4] = 4;
        assertEquals(MOVE, classify(before, after, 1, 2, 0, 4, 0, 0));
        before[4] = 99;
        assertEquals(CAPTURE, classify(before, after, 1, 2, 0, 4, 0, 1));
        before[0] = 99; after = before.clone(); after[0] = -1;
        assertEquals(FLIP, classify(before, after, 1, 2, -1, 0, 0, 0));
    }
    @Test void refreshResumeAndSkippedSnapshotsNeverReplayEffects() {
        int[] before = new int[32], after = new int[32]; before[0] = 4; before[4] = -3; after[4] = 4;
        assertEquals(NONE, classify(before, after, -1, 2, 0, 4, 0, 1));
        assertEquals(NONE, classify(before, after, 2, 2, 0, 4, 0, 1));
        assertEquals(NONE, classify(before, after, 0, 2, 0, 4, 0, 1));
        assertEquals(NONE, classify(before, after, 3, 2, 0, 4, 0, 1));
    }
    @Test void inconsistentCapturesAndUnrelatedBoardChangesAreIgnored() {
        int[] before = new int[32], after = new int[32]; before[0] = 4; before[4] = -3; after[4] = 4;
        assertEquals(NONE, classify(before, after, 1, 2, 0, 4, 0, 0));
        after[8] = 7; assertEquals(NONE, classify(before, after, 1, 2, 0, 4, 0, 1));
        assertEquals(NONE, classify(before, after, 1, 2, 32, 4, 0, 1));
        assertEquals(NONE, classify(before, after, 1, 2, 0, -1, 0, 1));
    }
}
