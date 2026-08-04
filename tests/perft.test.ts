/**
 * Perft — the only test that can prove a move generator correct.
 *
 * Three layers, in increasing strength:
 *
 *   1. The start position against the widely published counts
 *      (44 / 1920 / 79666 / 3290240). A single wrong rule anywhere shows up by
 *      depth three.
 *   2. Five more fixtures, each chosen to stress a different rule — a cannon
 *      endgame, a flying-general squeeze, crossed soldiers, a position where the
 *      side to move is in check — cross-checked live against the naive
 *      reference generator in `reference.ts`, which shares no code with the
 *      engine.
 *   3. A node-by-node comparison of the *move sets* themselves. A count can
 *      match by two errors cancelling; a set comparison at every node of a
 *      subtree cannot.
 *
 * Layer 3 is the one that actually finds bugs. Layers 1 and 2 tell you *that*
 * something is wrong; layer 3 hands you the position and the missing move.
 */

import { describe, expect, it } from 'vitest';
import { START_FEN } from '@core/testapi.ts';
import { moveFrom, moveTo } from '@core/types.ts';
import { Position, iccsToMove, legalMoves, perft, perftDivide } from '@engine/index.ts';
import { refLegalMoves, refMoveKeys, refParse, refPerft } from './reference.ts';
import { fenOf } from './helpers.ts';

/** Replay ICCS moves from the standard opening to build a fixture. */
function afterMoves(moves: string): string {
  const p = new Position(START_FEN);
  for (const token of moves.split(/\s+/)) {
    const m = iccsToMove(p, token);
    if (!m) throw new Error(`fixture move "${token}" is not legal`);
    p.makeMove(m);
  }
  return p.toFen();
}

describe('perft from the standard opening', () => {
  const pos = new Position(START_FEN);

  it('depth 1 = 44', () => expect(perft(pos, 1)).toBe(44));
  it('depth 2 = 1920', () => expect(perft(pos, 2)).toBe(1920));
  it('depth 3 = 79666', () => expect(perft(pos, 3)).toBe(79666));
  /**
   * Split by root move and yielded between them. A single 3.3-million-node call
   * blocks the event loop for long enough that the test runner's own progress
   * channel times out and reports a spurious unhandled error; summing the
   * divide is the same tree, one root move at a time.
   */
  it('depth 4 = 3290240', { timeout: 180_000 }, async () => {
    const p = new Position(START_FEN);
    let total = 0;
    for (const { move } of perftDivide(p, 1)) {
      p.makeMove(move);
      total += perft(p, 3);
      p.unmakeMove();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(total).toBe(3290240);
  });

  it('the position is unchanged after a deep perft', () => {
    const p = new Position(START_FEN);
    perft(p, 3);
    expect(p.toFen()).toBe(START_FEN);
    expect(p.ply).toBe(0);
  });

  /**
   * Not an assertion about speed so much as a recorded measurement: perft is
   * pure make/unmake plus legality, so its node rate is the floor the search's
   * own rate is built on. The threshold is deliberately loose — it exists to
   * catch an accidental quadratic, not to police a few percent.
   */
  it('records the make/unmake node rate', { timeout: 120_000 }, () => {
    const p = new Position(START_FEN);
    perft(p, 2); // warm the JIT
    const t0 = Date.now();
    const nodes = perft(p, 4);
    const ms = Date.now() - t0;
    const nps = Math.round(nodes / (ms / 1000));
    console.log(`[perft] depth 4: ${nodes} nodes in ${ms}ms = ${nps} nodes/sec`);
    expect(nps).toBeGreaterThan(50_000);
  });

  it('divide sums to the total', () => {
    const p = new Position(START_FEN);
    const divide = perftDivide(p, 3);
    expect(divide).toHaveLength(44);
    expect(divide.reduce((n, d) => n + d.nodes, 0)).toBe(79666);
  });
});

/**
 * Fixtures beyond the start position. Every expected number below was produced
 * by the naive reference generator, not by the engine, and the tests recompute
 * the reference live so the two can never drift apart silently.
 */
const FIXTURES: { name: string; fen: string; expect: number[] }[] = [
  {
    name: 'opening, six plies of 中炮對屏風馬',
    fen: afterMoves('h2e2 h9g7 h0g2 i9h9 i0h0 b9c7'),
    expect: [37, 1292, 49161, 1790186],
  },
  {
    name: 'midgame after the chariot has crossed',
    fen: afterMoves('h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 g6g5 h0h6 h7i7 h6g6 i7i8'),
    expect: [36, 1641, 61616, 2745879],
  },
  {
    name: 'cannon endgame — screens, no screens, two screens',
    fen: fenOf(
      { e9: 'k', d9: 'a', c9: 'b', e6: 'c', e0: 'K', f0: 'A', g0: 'B', e3: 'C', a4: 'R', e4: 'P' },
      'w',
    ),
    expect: [21, 181, 4109, 47957],
  },
  {
    name: 'flying-general squeeze — a chariot pinned to an open file',
    fen: fenOf({ e9: 'k', e4: 'R', e6: 'p', e0: 'K', d0: 'A', a0: 'R', i9: 'r' }, 'w'),
    expect: [27, 395, 10836, 178809],
  },
  {
    name: 'crossed soldiers on both sides of the river',
    fen: fenOf(
      {
        e9: 'k', d9: 'a', f9: 'a', c9: 'b', g9: 'b',
        a4: 'P', c4: 'P', e5: 'P',
        e0: 'K', d0: 'A', f0: 'A', h0: 'N', b0: 'N',
        a5: 'p', c5: 'p', g5: 'p',
      },
      'w',
    ),
    expect: [12, 118, 1711, 16751],
  },
  {
    name: 'side to move is in check — evasions only',
    fen: fenOf({ e9: 'k', d9: 'a', f9: 'a', e5: 'R', e0: 'K', d0: 'A', b7: 'c', a0: 'R' }, 'b'),
    expect: [3, 69, 1058, 29788],
  },
];

describe('perft on five more fixtures', () => {
  it.each(FIXTURES)(
    '$name — engine matches its recorded counts',
    { timeout: 120_000 },
    ({ fen, expect: want }) => {
      const pos = new Position(fen);
      for (let d = 1; d <= want.length; d++) expect(perft(pos, d)).toBe(want[d - 1]);
    },
  );

  it.each(FIXTURES)(
    '$name — the naive reference agrees to depth 3',
    { timeout: 120_000 },
    ({ fen, expect: want }) => {
      const ref = refParse(fen);
      for (let d = 1; d <= 3; d++) {
        expect(refPerft(ref.cells, ref.side, d), `reference perft(${d}) for ${fen}`).toBe(want[d - 1]);
      }
    },
  );
});

/**
 * Walk the tree with the engine's generator and, at every single node, compare
 * the full set of legal moves against the reference's. This catches the class
 * of bug perft counts hide: a move wrongly generated in one branch and a move
 * wrongly suppressed in another, summing to the right total.
 */
function crossCheck(fen: string, depth: number): number {
  const pos = new Position(fen);
  const ref = refParse(fen);
  let nodes = 0;

  const walk = (cells: number[], side: number, d: number): void => {
    nodes++;
    const engineKeys = legalMoves(pos)
      .map((m) => `${moveFrom(m)}-${moveTo(m)}`)
      .sort();
    const referenceKeys = refMoveKeys(refLegalMoves(cells, side));
    expect(engineKeys, `move sets differ at ${pos.toFen()}`).toEqual(referenceKeys);
    if (d <= 1) return;

    for (const m of legalMoves(pos)) {
      const next = cells.slice();
      next[moveTo(m)] = next[moveFrom(m)];
      next[moveFrom(m)] = 0;
      pos.makeMove(m);
      walk(next, side ^ 1, d - 1);
      pos.unmakeMove();
    }
  };

  walk(ref.cells, ref.side, depth);
  return nodes;
}

describe('move-set cross-check against the naive generator', () => {
  it('the standard opening, every node to depth 2', { timeout: 180_000 }, () => {
    // 1 + 44 + 1920 = 1965 nodes, each compared move for move.
    expect(crossCheck(START_FEN, 3)).toBe(1 + 44 + 1920);
  });

  it.each(FIXTURES.filter((f) => f.expect[1] < 500))(
    '$name, every node to depth 3',
    { timeout: 180_000 },
    ({ fen, expect: want }) => {
      expect(crossCheck(fen, 4)).toBe(1 + want[0] + want[1] + want[2]);
    },
  );

  it('the check fixture, every node to depth 3', { timeout: 180_000 }, () => {
    const f = FIXTURES[5];
    expect(crossCheck(f.fen, 4)).toBe(1 + f.expect[0] + f.expect[1] + f.expect[2]);
  });
});
