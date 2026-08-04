/**
 * Static exchange evaluation, and the incrementally maintained evaluation terms.
 *
 * Both are optimisations that are invisible when they work and catastrophic
 * when they do not: a wrong SEE prunes a winning capture out of quiescence, and
 * a drifting incremental term silently corrupts every evaluation from the ply
 * it went wrong. They are tested against a brute-force recomputation rather
 * than against themselves.
 */

import { describe, expect, it } from 'vitest';
import { START_FEN } from '@core/testapi.ts';
import { EMPTY, PieceType, Side, moveTo } from '@core/types.ts';
import {
  LAZY_MARGIN,
  MATERIAL_ENDGAME,
  MATERIAL_OPENING,
  MoveList,
  PHASE_MAX,
  Position,
  SEE_VALUE,
  SOLDIER_CROSSED,
  SOLDIER_DEEP,
  Searcher,
  adjudicate,
  breakdown,
  evaluate,
  evaluateRedPov,
  findBestMove,
  generateLegalMoves,
  iccsToMove,
  lazyOmittedMagnitude,
  mirrorSquare,
  see,
  smallestAttacker,
} from '@engine/index.ts';
import { positionOf } from './helpers.ts';

const KINGS = { d0: 'K', f9: 'k' } as const;

describe('smallestAttacker', () => {
  it('prefers the cheapest piece', () => {
    // A soldier, a horse and a chariot all bear on e5; the soldier wins.
    // e4 is rank 5, one step in front of e5 (rank 4) for a Red soldier.
    const pos = positionOf({ ...KINGS, e5: 'p', e4: 'P', d7: 'N', a5: 'R' }, 'w');
    const target = 4 * 9 + 4; // e5 -> (file 4, rank 4)
    const from = smallestAttacker(pos.board, target, Side.Red);
    expect(pos.board[from] & 7).toBe(PieceType.Soldier);
  });

  it('respects the horse leg', () => {
    const target = 4 * 9 + 4; // e5
    const free = positionOf({ ...KINGS, e5: 'p', d7: 'N' }, 'w');
    expect(free.board[smallestAttacker(free.board, target, Side.Red)] & 7).toBe(PieceType.Horse);
    // d6 is the leg for the d7 horse's jump to e5; blocking it removes the
    // attack entirely, leaving nothing.
    const blocked = positionOf({ ...KINGS, e5: 'p', d7: 'N', d6: 'B' }, 'w');
    expect(smallestAttacker(blocked.board, target, Side.Red)).toBe(-1);
  });

  it('respects the elephant eye', () => {
    const target = 7 * 9 + 4; // e2 -> (file 4, rank 7), an elephant point
    const free = positionOf({ ...KINGS, e2: 'p', c0: 'B' }, 'w');
    expect(free.board[smallestAttacker(free.board, target, Side.Red)] & 7).toBe(PieceType.Elephant);
    const blocked = positionOf({ ...KINGS, e2: 'p', c0: 'B', d1: 'N' }, 'w');
    expect(blocked.board[smallestAttacker(blocked.board, target, Side.Red)] & 7).not.toBe(
      PieceType.Elephant,
    );
  });

  it('needs exactly one screen for a cannon', () => {
    const target = 0 * 9 + 0; // a9
    const none = positionOf({ ...KINGS, a9: 'r', a0: 'C' }, 'w');
    expect(smallestAttacker(none.board, target, Side.Red)).toBe(-1);
    const one = positionOf({ ...KINGS, a9: 'r', a0: 'C', a4: 'P' }, 'w');
    expect(one.board[smallestAttacker(one.board, target, Side.Red)] & 7).toBe(PieceType.Cannon);
    const two = positionOf({ ...KINGS, a9: 'r', a0: 'C', a4: 'P', a3: 'P' }, 'w');
    expect(smallestAttacker(two.board, target, Side.Red)).toBe(-1);
  });

  it('only counts the general as an adjacent attacker, never down the file', () => {
    // e1 is adjacent to the Red general on e0.
    const adjacent = positionOf({ e0: 'K', a9: 'k', e1: 'p' }, 'w');
    expect(adjacent.board[smallestAttacker(adjacent.board, 8 * 9 + 4, Side.Red)] & 7).toBe(
      PieceType.General,
    );
    // e5 is four squares up the same open file: a real general cannot capture
    // there, even though `Position.isAttacked` models it as reaching that far
    // for the flying-general rule.
    const distant = positionOf({ e0: 'K', a9: 'k', e5: 'p' }, 'w');
    expect(smallestAttacker(distant.board, 4 * 9 + 4, Side.Red)).toBe(-1);
    expect(distant.isAttacked(4 * 9 + 4, Side.Red)).toBe(true); // the two differ on purpose
  });
});

describe('see', () => {
  function seeOf(pieces: Record<string, string>, iccs: string, side: 'w' | 'b' = 'w'): number {
    const pos = positionOf(pieces, side);
    const m = iccsToMove(pos, iccs);
    expect(m, `${iccs} should be legal`).not.toBe(0);
    return see(pos, m);
  }

  it('an undefended capture is worth the victim', () => {
    expect(seeOf({ ...KINGS, e3: 'R', e5: 'p' }, 'e3e5')).toBe(SEE_VALUE[PieceType.Soldier]);
  });

  it('a defended soldier taken by a chariot loses the exchange', () => {
    // Black chariot on a5 recaptures along rank 5.
    const v = seeOf({ ...KINGS, e3: 'R', e5: 'p', a5: 'r' }, 'e3e5');
    expect(v).toBe(SEE_VALUE[PieceType.Soldier] - SEE_VALUE[PieceType.Chariot]);
    expect(v).toBeLessThan(0);
  });

  it('an even trade is even', () => {
    expect(seeOf({ ...KINGS, e3: 'R', e5: 'r', a5: 'r' }, 'e3e5')).toBe(0);
  });

  it('the cheapest recapture is the one that is used', () => {
    // Both a chariot and a soldier can retake on e5; the soldier should.
    const v = seeOf({ ...KINGS, e3: 'R', e5: 'r', a5: 'r', e6: 'p' }, 'e3e5');
    expect(v).toBe(SEE_VALUE[PieceType.Chariot] - SEE_VALUE[PieceType.Chariot]);
  });

  it('a longer exchange folds correctly', () => {
    // Red R takes p; black r retakes; red R retakes; black r retakes.
    const v = seeOf({ ...KINGS, e3: 'R', e2: 'R', e5: 'p', a5: 'r', i5: 'r' }, 'e3e5');
    // p (+100), lose R (-900), win r (+900), lose R (-900) -> the swap-off
    // stops as soon as either side would rather decline, so the value is the
    // best either side can force.
    expect(v).toBe(SEE_VALUE[PieceType.Soldier] - SEE_VALUE[PieceType.Chariot] + SEE_VALUE[PieceType.Chariot] - SEE_VALUE[PieceType.Chariot]);
  });

  it('the general may not recapture onto a square that is still attacked', () => {
    // Two Black chariots cover rank 8 (ICCS row 1), so after the first one
    // recaptures on e1 the square is still guarded and Red's general — which
    // could otherwise take back — is not a legal recapturer.
    const v = seeOf({ e0: 'K', a9: 'k', e2: 'R', e1: 'p', a1: 'r', i1: 'r' }, 'e2e1');
    expect(v).toBe(SEE_VALUE[PieceType.Soldier] - SEE_VALUE[PieceType.Chariot]);
  });

  it('a cannon that only fires because of a screen is found', () => {
    // Red cannon a0 with a screen on a4 wins the black chariot on a9,
    // and there is nothing to recapture with.
    expect(seeOf({ ...KINGS, a0: 'C', a4: 'P', a9: 'r' }, 'a0a9')).toBe(SEE_VALUE[PieceType.Chariot]);
  });

  it('leaves the board exactly as it found it', () => {
    const pos = positionOf({ ...KINGS, e3: 'R', e2: 'R', e5: 'p', a5: 'r', i5: 'r' }, 'w');
    const before = pos.toFen();
    const key = pos.keyLo;
    const list = new MoveList();
    generateLegalMoves(pos, list);
    for (const m of list.toArray()) see(pos, m);
    expect(pos.toFen()).toBe(before);
    expect(pos.keyLo).toBe(key);
  });

  it('agrees with a brute-force swap-off over a real game', async () => {
    // Play a short game and check every capture against an independent,
    // deliberately slow recomputation of the same exchange.
    const searcher = new Searcher(16);
    const pos = new Position(START_FEN);
    let checked = 0;
    for (let ply = 0; ply < 60 && adjudicate(pos).kind === 'ongoing'; ply++) {
      const list = new MoveList();
      generateLegalMoves(pos, list);
      for (const m of list.toArray()) {
        if (((m >>> 14) & 0xf) === 0) continue;
        expect(see(pos, m), `see at ${pos.toFen()}`).toBe(bruteForceSee(pos, m));
        checked++;
      }
      const r = findBestMove(searcher, pos, 'medium', {
        maxDepth: 3, timeMs: 0, nodeLimit: 2000, pickSeed: ply,
      });
      pos.makeMove(r.move);
      if (ply % 10 === 0) await new Promise((res) => setTimeout(res, 0));
    }
    expect(checked).toBeGreaterThan(100);
  }, 180_000);
});

/**
 * A second, obviously-correct swap-off. It copies the board, walks the
 * exchange with plain recursion and takes the max at every level, which is the
 * textbook definition; `see()` does the same thing with an unrolled gain stack
 * and an in-place undo trail, which is fast and easy to get subtly wrong.
 */
function bruteForceSee(pos: Position, move: number): number {
  const board = Array.from(pos.board);
  const to = moveTo(move);
  const from = move & 0x7f;
  const victim = board[to];
  board[to] = board[from];
  board[from] = EMPTY;
  return SEE_VALUE[victim & 7] - swap(board, to, pos.side === Side.Red ? Side.Black : Side.Red);
}

function swap(board: number[], sq: number, side: Side): number {
  const scratch = new Int8Array(board);
  const from = smallestAttacker(scratch, sq, side);
  if (from < 0) return 0;
  if ((board[from] & 7) === PieceType.General) {
    const other = side === Side.Red ? Side.Black : Side.Red;
    if (smallestAttacker(scratch, sq, other) >= 0) return 0;
  }
  const victim = board[sq];
  board[sq] = board[from];
  board[from] = EMPTY;
  const value = SEE_VALUE[victim & 7] - swap(board, sq, side === Side.Red ? Side.Black : Side.Red);
  board[from] = board[sq];
  board[sq] = victim;
  return Math.max(0, value); // a side may always decline the recapture
}

describe('incremental evaluation terms', () => {
  /** Recompute the four running sums from scratch, the slow obvious way. */
  function recompute(pos: Position) {
    let mg = 0;
    let eg = 0;
    let pst = 0;
    let soldier = 0;
    let phase = 0;
    for (let sq = 0; sq < 90; sq++) {
      const code = pos.board[sq];
      if (code === EMPTY) continue;
      const type = code & 7;
      const red = code >> 3 === (Side.Red as number);
      const sign = red ? 1 : -1;
      mg += sign * MATERIAL_OPENING[type];
      eg += sign * MATERIAL_ENDGAME[type];
      if (type === PieceType.Chariot) phase += 900;
      else if (type === PieceType.Cannon) phase += 470;
      else if (type === PieceType.Horse) phase += 400;
      if (type === PieceType.Soldier) {
        const rank = (sq / 9) | 0;
        const crossed = red ? rank <= 4 : rank >= 5;
        const deep = red ? rank <= 2 : rank >= 7;
        if (crossed) soldier += sign * (SOLDIER_CROSSED + (deep ? SOLDIER_DEEP : 0));
      }
    }
    void pst;
    void mirrorSquare;
    return { mg, eg, soldier, phase };
  }

  it('stay exact across a two-ply exhaustive make/unmake walk', async () => {
    const pos = new Position(START_FEN);
    const check = () => {
      const want = recompute(pos);
      expect(pos.termMaterialMg).toBe(want.mg);
      expect(pos.termMaterialEg).toBe(want.eg);
      expect(pos.termSoldier).toBe(want.soldier);
      expect(pos.termPhase).toBe(want.phase);
    };
    const walk = (depth: number) => {
      const list = new MoveList();
      generateLegalMoves(pos, list);
      for (const m of list.toArray()) {
        pos.makeMove(m);
        check();
        if (depth > 1) walk(depth - 1);
        pos.unmakeMove();
        check();
      }
    };
    check();
    // One root move at a time, yielding in between so the runner's progress
    // channel does not time out on a single long synchronous block.
    const roots = new MoveList();
    generateLegalMoves(pos, roots);
    for (const m of roots.toArray()) {
      pos.makeMove(m);
      check();
      walk(1);
      pos.unmakeMove();
      check();
      await new Promise((r) => setTimeout(r, 0));
    }
  }, 180_000);

  it('the PST sum matches a full re-parse of the same position', () => {
    // Replaying the FEN rebuilds every term from scratch, so an incremental
    // drift shows up as a mismatch against a freshly parsed twin.
    const searcher = new Searcher(16);
    const pos = new Position(START_FEN);
    for (let ply = 0; ply < 50 && adjudicate(pos).kind === 'ongoing'; ply++) {
      const fresh = new Position(pos.toFen());
      expect(fresh.termPst).toBe(pos.termPst);
      expect(fresh.termMaterialMg).toBe(pos.termMaterialMg);
      expect(fresh.termMaterialEg).toBe(pos.termMaterialEg);
      expect(fresh.termSoldier).toBe(pos.termSoldier);
      expect(fresh.termPhase).toBe(pos.termPhase);
      expect(evaluateRedPov(fresh)).toBe(evaluateRedPov(pos));
      const r = findBestMove(searcher, pos, 'medium', {
        maxDepth: 3, timeMs: 0, nodeLimit: 2000, pickSeed: ply,
      });
      pos.makeMove(r.move);
    }
  }, 120_000);
});

describe('lazy evaluation', () => {
  it('never returns a bound on the wrong side of the true score', () => {
    // Windows chosen to straddle, sit above and sit below the real score.
    const searcher = new Searcher(16);
    const pos = new Position(START_FEN);
    for (let ply = 0; ply < 40 && adjudicate(pos).kind === 'ongoing'; ply++) {
      const exact = evaluate(pos);
      for (const [alpha, beta] of [
        [exact - 1000, exact + 1000],
        [exact + 500, exact + 600],
        [exact - 600, exact - 500],
        [exact - 20, exact + 20],
      ]) {
        const lazy = evaluate(pos, alpha, beta);
        if (lazy >= beta) expect(exact).toBeGreaterThanOrEqual(lazy - LAZY_MARGIN);
        else if (lazy <= alpha) expect(exact).toBeLessThanOrEqual(lazy + LAZY_MARGIN);
        else expect(lazy).toBe(exact);
      }
      const r = findBestMove(searcher, pos, 'medium', {
        maxDepth: 3, timeMs: 0, nodeLimit: 2000, pickSeed: ply,
      });
      pos.makeMove(r.move);
    }
  }, 120_000);

  /**
   * The margin has to bound everything the cheap pass leaves out. This walks a
   * few thousand real positions — every reply to every position of several
   * self-play games — and checks that it does. Measured maximum when this was
   * tuned: 281.8 over 85,373 positions, against a margin of 340.
   */
  it('the margin bounds the omitted terms over thousands of real positions', () => {
    const searcher = new Searcher(16);
    let worst = 0;
    let sampled = 0;
    for (let game = 0; game < 6; game++) {
      const pos = new Position(START_FEN);
      searcher.newGame();
      for (let ply = 0; ply < 40 && adjudicate(pos).kind === 'ongoing'; ply++) {
        const list = new MoveList();
        generateLegalMoves(pos, list);
        for (const m of list.toArray()) {
          pos.makeMove(m);
          worst = Math.max(worst, lazyOmittedMagnitude(pos));
          sampled++;
          pos.unmakeMove();
        }
        const r = findBestMove(searcher, pos, ply % 2 ? 'easy' : 'medium', {
          maxDepth: 3, timeMs: 0, nodeLimit: 2000, pickSeed: game * 100 + ply,
        });
        pos.makeMove(r.move);
      }
    }
    console.log(`[lazy] worst omitted magnitude ${worst.toFixed(1)}cp over ${sampled} positions (margin ${LAZY_MARGIN})`);
    expect(sampled).toBeGreaterThan(3000);
    expect(worst).toBeLessThan(LAZY_MARGIN);
  }, 300_000);

  it('breakdown and evaluateRedPov never take the lazy path', () => {
    const pos = new Position(START_FEN);
    const b = breakdown(pos);
    expect(b.mobility + b.safety).toBe(b.total - b.material - b.pst - b.tempo);
    expect(evaluateRedPov(pos)).toBe(b.total);
    expect(b.phase).toBe(pos.termPhase / PHASE_MAX);
  });
});
