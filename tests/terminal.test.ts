/**
 * Terminal-state adjudication — the rules that decide who actually won.
 *
 * Two of these are the difference between a xiangqi engine and a western chess
 * engine with a different board:
 *
 *   - a side with no legal move LOSES, in check or not;
 *   - the side delivering perpetual check LOSES.
 *
 * Both are tested here against a position, not against a mock.
 */

import { describe, expect, it } from 'vitest';
import { Side } from '@core/types.ts';
import {
  Position,
  adjudicate,
  analyseRepetition,
  iccsToMove,
  isCheckmate,
  isStalemate,
  legalMoveCount,
} from '@engine/index.ts';
import { positionOf } from './helpers.ts';

function play(pos: Position, moves: string[]): void {
  for (const t of moves) {
    const m = iccsToMove(pos, t);
    expect(m, `"${t}" should be legal in ${pos.toFen()}`).not.toBe(0);
    expect(pos.makeMove(m)).toBe(true);
  }
}

describe('checkmate', () => {
  /**
   * 雙車錯: one chariot holds Black's back rank, the other the rank above it.
   * The general has three squares and every one of them is covered.
   */
  const mate = () => positionOf({ e9: 'k', a9: 'R', a8: 'R', d0: 'K' }, 'b');

  it('is recognised as a loss for the side to move', () => {
    const pos = mate();
    expect(pos.inCheck()).toBe(true);
    expect(legalMoveCount(pos)).toBe(0);
    expect(isCheckmate(pos)).toBe(true);
    expect(isStalemate(pos)).toBe(false);

    const result = adjudicate(pos);
    expect(result.kind).toBe('checkmate');
    expect(result.winner).toBe(Side.Red);
  });

  it('one square of air is enough to make it not mate', () => {
    // Move the rank-1 chariot away and e8 opens up.
    const pos = positionOf({ e9: 'k', a9: 'R', i0: 'R', d0: 'K' }, 'b');
    expect(pos.inCheck()).toBe(true);
    expect(legalMoveCount(pos)).toBe(1);
    expect(adjudicate(pos).kind).toBe('ongoing');
  });
});

describe('stalemate is a LOSS (困斃)', () => {
  /**
   * The general is not attacked, but d8 and f8 cover its three exits — d9 down
   * file d, f9 down file f, and e8 along rank 1. Western chess calls this a
   * draw. Xiangqi calls it a loss, and this is the single rule that most often
   * gets ported wrong.
   */
  const stalemated = () => positionOf({ e9: 'k', d8: 'R', f8: 'R', d0: 'K' }, 'b');

  it('the side with no legal move loses', () => {
    const pos = stalemated();
    expect(pos.inCheck()).toBe(false);
    expect(legalMoveCount(pos)).toBe(0);
    expect(isStalemate(pos)).toBe(true);

    const result = adjudicate(pos);
    expect(result.kind).toBe('stalemate');
    expect(result.winner).toBe(Side.Red);
    expect(result.winner).not.toBeNull(); // explicitly NOT a draw
  });

  it('a Red stalemate loses for Red symmetrically', () => {
    const pos = positionOf({ e0: 'K', d1: 'r', f1: 'r', d9: 'k' }, 'w');
    expect(pos.inCheck()).toBe(false);
    expect(legalMoveCount(pos)).toBe(0);
    const result = adjudicate(pos);
    expect(result.kind).toBe('stalemate');
    expect(result.winner).toBe(Side.Black);
  });
});

describe('perpetual check (長將) loses for the checker', () => {
  /**
   * Red's chariot swaps between rank 0 and rank 1; Black's general is forced to
   * step between the two squares. Red checks on every move it makes and Black
   * on none, so after the third occurrence Red is the one who loses.
   */
  const setup = () => positionOf({ e9: 'k', a8: 'R', d0: 'K' }, 'w');
  const CYCLE = ['a8a9', 'e9e8', 'a9a8', 'e8e9'];

  it('is a loss for the side delivering the checks', () => {
    const pos = setup();
    for (let i = 0; i < 3; i++) play(pos, CYCLE);

    expect(pos.repetitionCount()).toBeGreaterThanOrEqual(3);
    const analysis = analyseRepetition(pos)!;
    expect(analysis.perpetualCheck).toEqual([true, false]);

    const result = adjudicate(pos);
    expect(result.kind).toBe('perpetual-check');
    expect(result.winner).toBe(Side.Black); // Red, the checker, loses
  });

  it('one cycle is not yet enough — the rule needs a threefold', () => {
    const pos = setup();
    play(pos, CYCLE); // back to the start position: two occurrences
    expect(pos.repetitionCount()).toBe(2);
    expect(adjudicate(pos).kind).toBe('ongoing');
    play(pos, CYCLE); // three occurrences: now it fires
    expect(pos.repetitionCount()).toBe(3);
    expect(adjudicate(pos).kind).toBe('perpetual-check');
  });

  it('every Red move in the cycle really is a check', () => {
    const pos = setup();
    play(pos, CYCLE);
    // Plies 0 and 2 are Red's; both must be marked as giving check.
    expect(pos.checkAt(0)).toBe(true);
    expect(pos.checkAt(1)).toBe(false);
    expect(pos.checkAt(2)).toBe(true);
    expect(pos.checkAt(3)).toBe(false);
  });
});

describe('perpetual chase (長捉) loses for the chaser', () => {
  /**
   * Red's chariot hounds an undefended Black horse between two squares, never
   * checking. See `rules.ts` for exactly how much of the real 長捉 rule this
   * approximates — in particular "undefended" stands in for the rulebook's
   * exchange evaluation.
   */
  it('is a loss for the side doing the chasing', () => {
    const pos = positionOf({ f9: 'k', e6: 'n', a4: 'R', e0: 'K' }, 'w');
    for (let i = 0; i < 3; i++) play(pos, ['a4a6', 'e6d4', 'a6a4', 'd4e6']);

    const analysis = analyseRepetition(pos)!;
    expect(analysis.perpetualCheck).toEqual([false, false]);
    expect(analysis.perpetualChase).toEqual([true, false]);

    const result = adjudicate(pos);
    expect(result.kind).toBe('perpetual-chase');
    expect(result.winner).toBe(Side.Black);
  });

  it('a defended target is not a chase', () => {
    // The same dance, but a Black chariot on i6 defends the horse along rank 3.
    const pos = positionOf({ f9: 'k', e6: 'n', i6: 'r', a4: 'R', e0: 'K' }, 'w');
    for (let i = 0; i < 3; i++) play(pos, ['a4a6', 'e6d4', 'a6a4', 'd4e6']);
    const analysis = analyseRepetition(pos)!;
    expect(analysis.perpetualChase[0]).toBe(false);
    expect(adjudicate(pos).kind).toBe('repetition-draw');
  });

  it('the analysis leaves the position exactly as it found it', () => {
    const pos = positionOf({ f9: 'k', e6: 'n', a4: 'R', e0: 'K' }, 'w');
    for (let i = 0; i < 3; i++) play(pos, ['a4a6', 'e6d4', 'a6a4', 'd4e6']);
    const fen = pos.toFen();
    const ply = pos.ply;
    const keyLo = pos.keyLo;
    analyseRepetition(pos);
    expect(pos.toFen()).toBe(fen);
    expect(pos.ply).toBe(ply);
    expect(pos.keyLo).toBe(keyLo);
  });
});

describe('ordinary repetition is a draw', () => {
  it('two generals shuffling with elephants on the board', () => {
    const pos = positionOf({ f9: 'k', c9: 'b', d0: 'K', g0: 'B' }, 'w');
    for (let i = 0; i < 3; i++) play(pos, ['d0d1', 'f9f8', 'd1d0', 'f8f9']);

    const analysis = analyseRepetition(pos)!;
    expect(analysis.perpetualCheck).toEqual([false, false]);
    expect(analysis.perpetualChase).toEqual([false, false]);

    const result = adjudicate(pos);
    expect(result.kind).toBe('repetition-draw');
    expect(result.winner).toBeNull();
  });

  /**
   * When both sides commit the same foul the rulebook cancels them out. Here
   * each chariot shuffles between two squares that both bear on the enemy's
   * undefended horse, so both sides are perpetual chasers and neither wins.
   */
  it('a foul committed by both sides cancels into a draw', () => {
    const pos = positionOf(
      { d0: 'K', f9: 'k', e6: 'n', e3: 'N', a6: 'R', i3: 'r' },
      'w',
    );
    for (let i = 0; i < 3; i++) play(pos, ['a6b6', 'i3h3', 'b6a6', 'h3i3']);
    const analysis = analyseRepetition(pos)!;
    expect(analysis.perpetualCheck).toEqual([false, false]);
    expect(analysis.perpetualChase).toEqual([true, true]);
    const result = adjudicate(pos);
    expect(result.kind).toBe('repetition-draw');
    expect(result.winner).toBeNull();
  });
});

describe('sixty-move rule', () => {
  it('120 plies without a capture is a draw', () => {
    // The FEN's halfmove field is the plies-since-capture counter.
    const pos = positionOf({ e9: 'k', a4: 'r', d0: 'K', i5: 'R' }, 'w', 119);
    expect(adjudicate(pos).kind).toBe('ongoing');
    play(pos, ['i5i6']);
    expect(pos.halfmove).toBe(120);
    const result = adjudicate(pos);
    expect(result.kind).toBe('sixty-move');
    expect(result.winner).toBeNull();
  });

  it('a capture resets the counter', () => {
    const pos = positionOf({ e9: 'k', a4: 'r', d0: 'K', a5: 'R' }, 'w', 119);
    play(pos, ['a5a4']); // chariot takes chariot
    expect(pos.halfmove).toBe(0);
    expect(adjudicate(pos).kind).toBe('ongoing');
  });

  it('the counter survives a make/unmake round trip', () => {
    const pos = positionOf({ e9: 'k', a4: 'r', d0: 'K', a5: 'R' }, 'w', 50);
    play(pos, ['a5a4']);
    expect(pos.halfmove).toBe(0);
    pos.unmakeMove();
    expect(pos.halfmove).toBe(50);
  });
});

describe('insufficient material', () => {
  it('bare general against bare general is a draw', () => {
    const pos = positionOf({ e9: 'k', d0: 'K' }, 'w');
    const result = adjudicate(pos);
    expect(result.kind).toBe('insufficient');
    expect(result.winner).toBeNull();
  });

  it('one soldier is still material', () => {
    const pos = positionOf({ e9: 'k', d0: 'K', a3: 'P' }, 'w');
    expect(adjudicate(pos).kind).toBe('ongoing');
  });

  it('advisors alone are still material for the purposes of this rule', () => {
    // Deliberately conservative: this rule only fires on truly bare generals.
    const pos = positionOf({ e9: 'k', d0: 'K', d1: 'A' }, 'w');
    expect(adjudicate(pos).kind).toBe('ongoing');
  });
});
