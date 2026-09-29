package com.chessflipping.game;

import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;
import static com.chessflipping.game.GameEngine.*;

public class GameEngineTest {
    private GameEngine position(int... squaresAndPieces) throws Exception {
        GameEngine game = new GameEngine(new Random(1), 30);
        Arrays.fill(game.pieces, 0); Arrays.fill(game.revealed, true);
        for (int i = 0; i < squaresAndPieces.length; i += 2) game.pieces[squaresAndPieces[i]] = squaresAndPieces[i + 1];
        game.colors[0] = 1; game.colors[1] = -1; game.turn = 0;
        recordPosition(game); game.start(1000); return game;
    }
    @SuppressWarnings("unchecked") private void recordPosition(GameEngine game) throws Exception {
        var field = GameEngine.class.getDeclaredField("history"); field.setAccessible(true);
        Set<String> history = (Set<String>)field.get(game); history.clear();
        var key = GameEngine.class.getDeclaredMethod("boardKey"); key.setAccessible(true);
        history.add((String)key.invoke(game));
    }
    @Test public void initialInventoryFirstFlipColorAndClock() {
        for (int seed = 0; seed < 20; seed++) {
            GameEngine game = new GameEngine(new Random(seed), 60);
            assertEquals(16, game.remainingPieces(1)); assertEquals(16, game.remainingPieces(-1));
            assertTrue(Arrays.stream(game.publicBoard()).allMatch(p -> p == 99));
            for (int color : new int[]{1, -1}) for (int type = 1; type <= 7; type++) {
                int expected = type == KING ? 1 : type == PAWN ? 5 : 2, piece = color * type;
                assertEquals(expected, Arrays.stream(game.pieces).filter(p -> p == piece).count());
            }
            int first = game.turn; game.start(1000);
            assertNull(game.act(first, -1, 0, 2000));
            assertEquals(Integer.signum(game.pieces[0]), game.colors[first]);
            assertEquals(1 - first, game.turn); assertEquals(60000, game.remaining(2000));
        }
    }
    @Test public void ordinaryCaptureMatrixAndHiddenTargets() throws Exception {
        Set<String> allowed = Set.of("1:1", "1:2", "1:3", "1:4", "1:5", "1:6", "2:3", "2:4", "2:5", "2:6", "2:7",
                "3:4", "3:5", "3:6", "3:7", "4:5", "4:6", "4:7", "5:6", "5:7", "6:7", "7:1");
        for (int attacker = 1; attacker <= 7; attacker++) for (int target = 1; target <= 7; target++) {
            GameEngine game = position(5, attacker, 6, -target);
            assertEquals(attacker + ":" + target, allowed.contains(attacker + ":" + target), game.legalMove(5, 6, 1, true));
            game.revealed[6] = false; assertFalse(game.legalMove(5, 6, 1, true));
            game.pieces[6] = target; game.revealed[6] = true; assertFalse(game.legalMove(5, 6, 1, true));
        }
    }
    @Test public void rookLongRangeAndHorseDiagonalSpecialCaptures() throws Exception {
        GameEngine rook = position(0, ROOK, 2, ROOK, 31, -KING);
        rook.revealed[2] = false; assertTrue(rook.legalMove(0, 2, 1, true));
        rook.pieces[1] = PAWN; assertFalse(rook.legalMove(0, 2, 1, true));
        GameEngine horse = position(5, HORSE, 6, PAWN, 9, PAWN, 10, HORSE, 31, -KING);
        horse.revealed[10] = false; assertTrue(horse.legalMove(5, 10, 1, true));
        horse.revealed[10] = true; assertFalse(horse.legalMove(5, 10, 1, true));
        horse.pieces[10] = -HORSE; assertTrue(horse.legalMove(5, 10, 1, true));
    }
    @Test public void cannonUsesExactlyOneScreenAndCannotJumpIntoEmptySpace() throws Exception {
        GameEngine game = position(0, CANNON, 8, PAWN, 20, -CANNON, 28, -KING);
        assertTrue(game.legalMove(0, 4, 1, true)); assertFalse(game.legalMove(0, 12, 1, true));
        assertTrue(game.legalMove(0, 20, 1, true)); assertFalse(game.legalMove(0, 28, 1, true));
        game.pieces[20] = KING; assertFalse(game.legalMove(0, 20, 1, true));
        game.revealed[20] = false; assertTrue(game.legalMove(0, 20, 1, true));
    }
    @Test public void repeatIgnoresTurnAndHistoryResetsAfterFlipOrCapture() throws Exception {
        GameEngine game = position(0, ROOK, 31, -ROOK, 16, PAWN);
        game.revealed[16] = false; recordPosition(game);
        assertNull(game.act(0, 0, 1, 1100)); assertNull(game.act(1, 31, 30, 1200));
        assertNull(game.act(0, 1, 0, 1300)); assertNotNull(game.act(1, 30, 31, 1400));
        assertEquals(1, game.turn); assertEquals(29900, game.remaining(1400));
        assertNull(game.act(1, -1, 16, 1500));
        assertTrue(game.legalMove(30, 31, -1, true));
        var key = GameEngine.class.getDeclaredMethod("boardKey"); key.setAccessible(true);
        String before = (String)key.invoke(game); game.turn = 1 - game.turn;
        assertEquals(before, key.invoke(game));
    }
    @Test public void hiddenSelfCaptureCountsAndKingCaptureAloneDoesNotEndGame() throws Exception {
        GameEngine game = position(0, ROOK, 2, KING, 31, -PAWN);
        game.revealed[2] = false;
        assertNull(game.act(0, 0, 2, 1100)); assertEquals(List.of(KING), game.captured);
        assertEquals(1, game.remainingPieces(1)); assertEquals(-1, game.winner);
        GameEngine opponent = position(0, ROOK, 2, -KING, 31, -PAWN);
        assertNull(opponent.act(0, 0, 2, 1100)); assertEquals(-1, opponent.winner);
        GameEngine last = position(0, ROOK, 2, -KING);
        assertNull(last.act(0, 0, 2, 1100)); assertEquals(0, last.winner); assertEquals("NO_PIECES", last.reason);
    }
    @Test public void noMovesAndTimeoutLoseWithoutDrawOrClockReset() throws Exception {
        GameEngine game = position(0, PAWN, 1, -PAWN, 4, -PAWN, 31, KING);
        assertFalse(game.legalMove(0, 1, 1, true));
        assertNotNull(game.act(0, 0, 1, 2000)); assertEquals(29000, game.remaining(2000));
        assertTrue(game.checkTimeout(31000)); assertEquals(1, game.winner); assertEquals("TIMEOUT", game.reason);
        GameEngine unlimited = new GameEngine(new Random(0), 0); unlimited.start(0);
        assertFalse(unlimited.checkTimeout(Long.MAX_VALUE)); assertEquals(-1, unlimited.remaining(Long.MAX_VALUE));
        GameEngine trapped = position(0, -PAWN, 1, PAWN, 4, PAWN, 31, KING);
        assertNull(trapped.act(0, 31, 30, 1100)); assertEquals(0, trapped.winner); assertEquals("NO_MOVES", trapped.reason);
    }
    @Test public void completeRandomGamesPreservePieceCountsAndPublicHiddenIdentity() {
        for (int seed = 0; seed < 8; seed++) {
            Random random = new Random(seed); GameEngine game = new GameEngine(random, 0); game.start(0);
            for (int step = 1; step <= 1000 && game.winner < 0; step++) {
                List<int[]> actions = new ArrayList<>();
                for (int to = 0; to < 32; to++) {
                    if (game.pieces[to] != 0 && !game.revealed[to]) actions.add(new int[]{-1, to});
                    for (int from = 0; from < 32; from++)
                        if (game.legalMove(from, to, game.colors[game.turn], true)) actions.add(new int[]{from, to});
                }
                assertFalse(actions.isEmpty()); int[] action = actions.get(random.nextInt(actions.size()));
                assertNull(game.act(game.turn, action[0], action[1], step));
                assertEquals(32, game.captured.size() + game.remainingPieces(1) + game.remainingPieces(-1));
                for (int i = 0; i < 32; i++) if (game.pieces[i] != 0 && !game.revealed[i]) assertEquals(99, game.publicBoard()[i]);
            }
        }
    }
}
