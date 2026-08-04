/**
 * Evaluation sanity.
 *
 * The two properties that matter most are cheap to state and easy to break:
 * a mirrored position must evaluate to the exact negation (any asymmetry is a
 * free tempo the search will find and exploit), and the piece values must stand
 * in the traditional order.
 */

import { describe, expect, it } from 'vitest';
import { START_FEN } from '@core/testapi.ts';
import { PieceType } from '@core/types.ts';
import { PIECE_VALUE, Position, breakdown, evaluate, evaluateRedPov, weightsFor } from '@engine/index.ts';
import { mirrorFen, positionOf } from './helpers.ts';

describe('mirror symmetry', () => {
  const FIXTURES: [string, string][] = [
    ['the standard opening', START_FEN],
    [
      'an asymmetric middlegame',
      'r1bakabr1/8c/1cn3n2/p1p1p1R1p/6p2/2P6/P3P1P1P/1C2C1N2/9/RNBAKAB2 w - - 12 7',
    ],
    ['a lopsided endgame', '3ak4/4a4/9/9/9/9/4C4/9/4R4/4KAB2 w - - 0 1'],
    ['one side missing its shell', '4k4/9/9/9/6p2/9/9/1C7/4A4/3AK1B1R b - - 0 1'],
  ];

  it.each(FIXTURES)('%s evaluates to the exact negation when mirrored', (_name, fen) => {
    const pos = new Position(fen);
    const mirrored = new Position(mirrorFen(pos));
    expect(evaluateRedPov(mirrored)).toBe(-evaluateRedPov(pos));
  });

  it.each(FIXTURES)('%s: every term mirrors, not just the total', (_name, fen) => {
    const pos = new Position(fen);
    const mirrored = new Position(mirrorFen(pos));
    const a = breakdown(pos);
    const b = breakdown(mirrored);
    // `-0` is not `+0` under Object.is, so normalise the sign of zero.
    const neg = (x: number) => (x === 0 ? 0 : -x);
    expect(b.material).toBe(neg(a.material));
    expect(b.pst).toBe(neg(a.pst));
    expect(b.mobility).toBe(neg(a.mobility));
    expect(b.safety).toBe(neg(a.safety));
    expect(b.tempo).toBe(neg(a.tempo));
    expect(b.phase).toBe(a.phase);
  });

  it('the side-to-move view is the Red view with the sign of the mover', () => {
    const red = new Position(START_FEN);
    expect(evaluate(red)).toBe(evaluateRedPov(red));
    const black = new Position(START_FEN.replace(' w ', ' b '));
    expect(evaluate(black)).toBe(-evaluateRedPov(black));
  });

  it('the opening position is dead level apart from the tempo', () => {
    const b = breakdown(new Position(START_FEN));
    expect(b.material).toBe(0);
    expect(b.pst).toBe(0);
    expect(b.mobility).toBe(0);
    expect(b.safety).toBe(0);
    expect(b.total).toBe(b.tempo);
  });
});

describe('material ordering', () => {
  it('follows the traditional scale', () => {
    const v = PIECE_VALUE;
    expect(v[PieceType.Chariot]).toBeGreaterThan(v[PieceType.Cannon]);
    expect(v[PieceType.Cannon]).toBeGreaterThan(v[PieceType.Horse]);
    expect(v[PieceType.Horse]).toBeGreaterThan(v[PieceType.Elephant]);
    expect(v[PieceType.Elephant]).toBeGreaterThan(v[PieceType.Soldier]);
    expect(v[PieceType.Advisor]).toBeGreaterThan(v[PieceType.Soldier]);
    // A chariot is worth clearly more than a cannon and a horse are apart, and
    // less than the two of them together — the classic 車 vs 馬砲 trade.
    expect(v[PieceType.Chariot]).toBeLessThan(v[PieceType.Cannon] + v[PieceType.Horse]);
  });

  /**
   * A materially symmetric opening-phase board plus one extra Red piece on e4.
   * The board has to be full for this test to mean what it says: the cannon is
   * only worth more than the horse *in the opening*, and a bare board would be
   * measuring the endgame end of the taper instead.
   */
  const SYMMETRIC = {
    e0: 'K', d0: 'A', f0: 'A', a0: 'R', i0: 'R', b0: 'N', h0: 'N', b2: 'C', h2: 'C',
    e9: 'k', d9: 'a', f9: 'a', a9: 'r', i9: 'r', b9: 'n', h9: 'n', b7: 'c', h7: 'c',
  } as const;

  function extraMaterial(piece: string): number {
    return breakdown(positionOf({ ...SYMMETRIC, e4: piece }, 'w')).material;
  }

  it('an extra chariot beats an extra cannon beats an extra horse', () => {
    expect(breakdown(positionOf({ ...SYMMETRIC, e4: 'R' }, 'w')).phase).toBe(1);
    expect(extraMaterial('R')).toBeGreaterThan(extraMaterial('C'));
    expect(extraMaterial('C')).toBeGreaterThan(extraMaterial('N'));
    expect(extraMaterial('N')).toBeGreaterThan(extraMaterial('P'));
  });

  it('the horse overtakes the cannon once the board empties', () => {
    // Same two pieces, but on a bare board: the cannon has nothing to fire over.
    const withCannon = positionOf({ e0: 'K', e9: 'k', d9: 'a', e4: 'C' }, 'w');
    const withHorse = positionOf({ e0: 'K', e9: 'k', d9: 'a', e4: 'N' }, 'w');
    expect(breakdown(withCannon).phase).toBeLessThan(0.2);
    expect(breakdown(withHorse).material).toBeGreaterThan(breakdown(withCannon).material);
  });

  it('having the extra piece is better than not having it', () => {
    const bare = evaluateRedPov(positionOf({ ...SYMMETRIC }, 'w'));
    expect(evaluateRedPov(positionOf({ ...SYMMETRIC, e4: 'P' }, 'w'))).toBeGreaterThan(bare);
  });
});

describe('soldiers and the river', () => {
  /** One Red soldier on the named square, everything else identical. */
  function soldierAt(square: string): number {
    return evaluateRedPov(
      positionOf(
        { e0: 'K', d0: 'A', f0: 'A', e9: 'k', d9: 'a', f9: 'a', [square]: 'P' },
        'w',
      ),
    );
  }

  it('a soldier that has crossed the river is worth more than one that has not', () => {
    // e3 is rank 6 (Red's own half); e5 is rank 4 (across the river).
    expect(soldierAt('e5')).toBeGreaterThan(soldierAt('e3'));
    expect(soldierAt('e5') - soldierAt('e3')).toBeGreaterThan(80);
  });

  it('and more again once it reaches the enemy back ranks', () => {
    // e7 is rank 2 — inside Black's last three ranks.
    expect(soldierAt('e7')).toBeGreaterThan(soldierAt('e5'));
  });

  it('advancing on its own half is worth almost nothing', () => {
    // e3 (rank 6) and e2 (rank 7) are both behind the river.
    expect(Math.abs(soldierAt('e3') - soldierAt('e2'))).toBeLessThan(30);
  });

  it('the crossing bonus grows as the board empties', () => {
    const opening = weightsFor(1);
    const endgame = weightsFor(0);
    expect(endgame.soldierAdvance).toBeGreaterThan(opening.soldierAdvance);
  });
});

describe('phase taper', () => {
  it('the opening is phase 1 and a bare endgame is phase 0', () => {
    expect(breakdown(new Position(START_FEN)).phase).toBe(1);
    const bare = positionOf({ e0: 'K', d0: 'A', e9: 'k', d9: 'a', a4: 'P' }, 'w');
    expect(breakdown(bare).phase).toBe(0);
  });

  it('mobility matters more, and safety less, as the board empties', () => {
    const opening = weightsFor(1);
    const endgame = weightsFor(0);
    expect(endgame.mobility).toBeGreaterThan(opening.mobility);
    expect(endgame.safety).toBeLessThan(opening.safety);
    expect(endgame.pst).toBeLessThan(opening.pst);
  });

  /**
   * `compute()` inlines the weights to stay allocation-free, so this checks
   * that the inlined copy still agrees with the published `weightsFor` — the
   * one place the two could silently drift apart.
   */
  it('the published weights are the ones the evaluation actually applies', () => {
    const pos = positionOf({ e0: 'K', d9: 'k', a4: 'R' }, 'w');
    const b = breakdown(pos);
    const w = weightsFor(b.phase);
    // Three pieces contribute to the PST term, all read straight off the
    // authored tables: the Red chariot on (file 0, rank 5) is +8, the Red
    // general on its home point is +6, and Black's general on the mirrored
    // d-point is -2.
    expect(b.pst).toBe(Math.round((8 + 6 - 2) * w.pst));
  });
});

describe('general safety', () => {
  it('a stripped shell is worse than an intact one', () => {
    const intact = positionOf(
      { e0: 'K', d0: 'A', f0: 'A', c0: 'B', g0: 'B', e9: 'k', d9: 'a', f9: 'a', c9: 'b', g9: 'b', a4: 'r', i4: 'c' },
      'w',
    );
    const stripped = positionOf(
      { e0: 'K', e9: 'k', d9: 'a', f9: 'a', c9: 'b', g9: 'b', a4: 'r', i4: 'c' },
      'w',
    );
    // Material dominates, so compare the safety term specifically.
    expect(breakdown(stripped).safety).toBeLessThan(breakdown(intact).safety);
  });

  it('an enemy cannon staring down the general’s file is punished', () => {
    const safe = positionOf({ e0: 'K', d0: 'A', f0: 'A', e9: 'k', a5: 'c' }, 'w');
    const hollow = positionOf({ e0: 'K', d0: 'A', f0: 'A', e9: 'k', e5: 'c' }, 'w');
    expect(breakdown(hollow).safety).toBeLessThan(breakdown(safe).safety);
  });

  it('an enemy soldier inside the palace is punished', () => {
    const outside = positionOf({ e0: 'K', d0: 'A', f0: 'A', d9: 'k', a3: 'p' }, 'w');
    const inside = positionOf({ e0: 'K', d0: 'A', f0: 'A', d9: 'k', e1: 'p' }, 'w');
    expect(breakdown(inside).safety).toBeLessThan(breakdown(outside).safety);
  });
});

describe('mobility', () => {
  it('an open chariot is worth more than a boxed-in one', () => {
    const open = positionOf({ e0: 'K', d9: 'k', e4: 'R' }, 'w');
    const boxed = positionOf({ e0: 'K', d9: 'k', e4: 'R', e3: 'P', e5: 'P', d4: 'P', f4: 'P' }, 'w');
    // Compare only the mobility term: the boxed version has extra material.
    expect(breakdown(boxed).mobility).toBeLessThan(breakdown(open).mobility);
  });

  it('a centralised horse is worth more than one on the rim', () => {
    const centre = evaluateRedPov(positionOf({ e0: 'K', d9: 'k', e4: 'N' }, 'w'));
    const rim = evaluateRedPov(positionOf({ e0: 'K', d9: 'k', a4: 'N' }, 'w'));
    expect(centre).toBeGreaterThan(rim);
  });
});
