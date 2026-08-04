/**
 * Search behaviour.
 *
 * Fixtures are verified before the search is asked about them: `forcedMateIn`
 * in `helpers.ts` is a full-width solver with no pruning, no table and no
 * evaluation, so "this really is a mate in three" is established independently
 * of the thing under test. The self-play run then checks the one property that
 * matters more than strength — the engine never emits an illegal move — against
 * the naive generator in `reference.ts`.
 */

import { describe, expect, it } from 'vitest';
import { START_FEN } from '@core/testapi.ts';
import { type Move, NO_MOVE, moveFrom, moveTo } from '@core/types.ts';
import {
  MATE_THRESHOLD,
  MoveList,
  Position,
  REP_DRAW,
  REP_LOSS,
  REP_NONE,
  Searcher,
  adjudicate,
  evaluate,
  findBestMove,
  generateLegalMoves,
  iccsToMove,
  moveToIccs,
} from '@engine/index.ts';
import { forcedMateIn, movesThatForceMateIn, positionOf } from './helpers.ts';
import { refLegalMoves, refMoveKeys, refParse } from './reference.ts';

const key = (m: Move) => `${moveFrom(m)}-${moveTo(m)}`;

describe('mate finding', () => {
  it('finds a mate in one', () => {
    // Two chariots on Black's first two ranks; Ra8-a9 seals the back rank.
    const pos = positionOf({ e9: 'k', a8: 'R', i8: 'R', d0: 'K' }, 'w');
    expect(forcedMateIn(pos, 1)).toBe(1); // verified without the search

    const searcher = new Searcher(16);
    const result = findBestMove(searcher, pos, 'hard', { maxDepth: 6, timeMs: 4000 });

    expect(result.mateIn).toBe(1);
    expect(result.score).toBeGreaterThanOrEqual(MATE_THRESHOLD);
    expect(moveToIccs(result.move)).toBe('a8a9');

    pos.makeMove(result.move);
    expect(adjudicate(pos).kind).toBe('checkmate');
  });

  it('finds a mate in three', () => {
    /**
     * Two chariots against a general with both advisors. There is no mate in
     * one or two: the advisors interpose, and Red has to spend a move forcing
     * one of them to commit before the back rank can be taken. Five plies.
     */
    const pos = positionOf({ e9: 'k', d9: 'a', f9: 'a', a8: 'R', i8: 'R', d0: 'K' }, 'w');
    expect(forcedMateIn(pos, 1)).toBe(Infinity);
    expect(forcedMateIn(pos, 3)).toBe(Infinity);
    expect(forcedMateIn(pos, 5)).toBe(5);

    const searcher = new Searcher(18);
    const result = findBestMove(searcher, pos, 'hard', { maxDepth: 12, timeMs: 8000 });

    expect(result.mateIn).toBe(3);
    expect(result.score).toBeGreaterThanOrEqual(MATE_THRESHOLD);
    // ...and the move it picks must itself be one the independent solver
    // agrees starts a five-ply forced mate, not merely a move that happens to
    // be scored that way by the search under test.
    const solverMoves = movesThatForceMateIn(pos, 5).map(moveToIccs);
    expect(solverMoves.length).toBeGreaterThan(0);
    expect(solverMoves).toContain(moveToIccs(result.move));
    // The independent solver is full-width with no pruning at all, so it takes
    // seconds on a contended machine — well past vitest's 5s default.
  }, 120_000);

  it('prefers the faster mate when two are available', () => {
    const pos = positionOf({ e9: 'k', a8: 'R', i8: 'R', d0: 'K', a0: 'R' }, 'w');
    const searcher = new Searcher(16);
    const result = findBestMove(searcher, pos, 'hard', { maxDepth: 8, timeMs: 4000 });
    expect(result.mateIn).toBe(1);
  });

  it('sees a mate coming against it', () => {
    // Black to move, one ply before being mated by Ra8-a9. Whatever Black
    // plays, the score must be a mate against, not a positional number.
    const pos = positionOf({ e9: 'k', a8: 'R', i8: 'R', d0: 'K' }, 'b');
    const searcher = new Searcher(16);
    const result = findBestMove(searcher, pos, 'hard', { maxDepth: 6, timeMs: 4000 });
    expect(result.score).toBeLessThanOrEqual(-MATE_THRESHOLD);
    expect(result.mateIn).toBeLessThan(0);
  });
});

describe('quiescence prevents a horizon blunder', () => {
  /**
   * Red's chariot on e3 can take an undefended-looking soldier on e5 — except
   * the Black chariot on a5 recaptures along rank 5 and Red is a whole chariot
   * down. A fixed-depth search with no quiescence takes the soldier at depth 1
   * because the capture is the last thing it sees.
   */
  const blunderPosition = () =>
    positionOf(
      {
        e0: 'K', d0: 'A', f0: 'A', c0: 'B', g0: 'B', e3: 'R',
        e9: 'k', d9: 'a', f9: 'a', c9: 'b', g9: 'b', e5: 'p', a5: 'r',
      },
      'w',
    );

  it('a purely static one-ply search would take the poisoned soldier', () => {
    // Establishes that the trap is real: the greedy move IS the capture.
    const pos = blunderPosition();
    const list = new MoveList();
    generateLegalMoves(pos, list);
    let bestMove = NO_MOVE;
    let bestScore = -Infinity;
    for (const m of list.toArray()) {
      pos.makeMove(m);
      const score = -evaluate(pos); // static, from Red's point of view
      pos.unmakeMove();
      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
    }
    expect(moveToIccs(bestMove)).toBe('e3e5');
    expect(bestScore).toBeGreaterThan(0); // it looks like Red is winning
  });

  it('the real search declines it even at depth one', () => {
    const pos = blunderPosition();
    const searcher = new Searcher(16);
    const result = findBestMove(searcher, pos, 'hard', { maxDepth: 1, timeMs: 4000 });
    expect(moveToIccs(result.move)).not.toBe('e3e5');
    // And it knows Red is the side that is worse, rather than believing the
    // static +53 the capture advertises.
    expect(result.score).toBeLessThan(0);
  });

  it('and still declines it at a normal depth', () => {
    const pos = blunderPosition();
    const searcher = new Searcher(18);
    const result = findBestMove(searcher, pos, 'hard', { maxDepth: 6, timeMs: 4000 });
    expect(moveToIccs(result.move)).not.toBe('e3e5');
  });
});

describe('repetition scoring inside the search', () => {
  it('a perpetual checker is scored as losing, not drawing', () => {
    const pos = positionOf({ e9: 'k', a8: 'R', d0: 'K' }, 'w');
    const cycle = ['a8a9', 'e9e8', 'a9a8', 'e8e9'];
    for (const t of cycle) pos.makeMove(iccsToMove(pos, t));
    expect(pos.repetitionVerdict(2)).not.toBe(REP_NONE);

    // Red repeated while checking on every one of its moves, so from Red's
    // point of view (Red is to move again here) the repetition is a LOSS.
    expect(pos.repetitionVerdict(2)).toBe(REP_LOSS);
  });

  it('a quiet repetition is scored as a draw', () => {
    const pos = positionOf({ f9: 'k', c9: 'b', d0: 'K', g0: 'B' }, 'w');
    for (const t of ['d0d1', 'f9f8', 'd1d0', 'f8f9']) pos.makeMove(iccsToMove(pos, t));
    expect(pos.repetitionVerdict(2)).toBe(REP_DRAW);
  });
});

describe('move ordering', () => {
  /**
   * The effective branching factor is the geometric mean of `nodes(d) /
   * nodes(d-1)`. Xiangqi's raw branching factor is around 40; perfect ordering
   * would drive this toward its square root, about 6.3. Anything under about 12
   * means the TT move, MVV-LVA, killers and history are all actually firing —
   * if any of them regresses, this number climbs immediately.
   */
  it('drives the effective branching factor far below the raw one', () => {
    const pos = new Position(START_FEN);
    const searcher = new Searcher(20);
    const result = searcher.search(pos, { maxDepth: 8, timeMs: 20_000 });

    console.log(
      `[ordering] depth ${result.depth}, nodes ${result.nodes}, ` +
        `EBF ${result.effectiveBranching.toFixed(2)}, per-depth ${JSON.stringify(result.depthNodes)}`,
    );
    expect(result.depth).toBeGreaterThanOrEqual(6);
    expect(result.effectiveBranching).toBeGreaterThan(1);
    expect(result.effectiveBranching).toBeLessThan(12);
  }, 60_000);

  it('reports a node rate', () => {
    const pos = new Position(
      'r1bakabr1/8c/1cn3n2/p1p1p1R1p/6p2/2P6/P3P1P1P/1C2C1N2/9/RNBAKAB2 w - - 12 7',
    );
    const searcher = new Searcher(20);
    const result = searcher.search(pos, { maxDepth: 30, timeMs: 3000 });
    const nps = Math.round(result.nodes / (result.timeMs / 1000));
    console.log(
      `[speed] depth ${result.depth} in ${result.timeMs.toFixed(0)}ms, ` +
        `${result.nodes} nodes, ${nps} nps`,
    );
    // Floor set for the contended in-suite case; measured alone this position
    // runs at roughly 100k nodes a second. See `bench.test.ts`.
    expect(result.depth).toBeGreaterThanOrEqual(5);
    expect(nps).toBeGreaterThan(15_000);
  }, 30_000);
});

describe('difficulty profiles', () => {
  it('hard always plays its own first choice', () => {
    const pos = new Position(START_FEN);
    const searcher = new Searcher(18);
    const a = findBestMove(searcher, pos, 'hard', { maxDepth: 5, timeMs: 3000 });
    const b = findBestMove(searcher, pos, 'hard', { maxDepth: 5, timeMs: 3000 });
    expect(a.move).toBe(b.move);
    expect(a.move).toBe(a.candidates[0].move);
  }, 30_000);

  it('easy varies but never throws away material', () => {
    const pos = new Position(START_FEN);
    const searcher = new Searcher(18);
    const seen = new Set<string>();
    let worstLoss = 0;
    for (let i = 0; i < 24; i++) {
      const r = findBestMove(searcher, pos, 'easy', { maxDepth: 3, nodeLimit: 40_000, pickSeed: i });
      seen.add(moveToIccs(r.move));
      const best = r.candidates[0].score;
      const chosen = r.candidates.find((c) => c.move === r.move)!.score;
      worstLoss = Math.max(worstLoss, best - chosen);
    }
    // It is not deterministic...
    expect(seen.size).toBeGreaterThan(1);
    // ...but it never picks a move that is a piece worse than the best one.
    expect(worstLoss).toBeLessThanOrEqual(220);
    console.log(`[easy] ${seen.size} distinct choices, worst loss ${worstLoss}cp: ${[...seen].join(' ')}`);
  }, 60_000);

  it('easy never takes a move that drops a whole chariot', () => {
    // The horizon-blunder position: taking the soldier on e5 loses a chariot,
    // roughly 800cp below the best move. The loss cap must exclude it every
    // single time, no matter how the noise falls.
    const pos = positionOf(
      {
        e0: 'K', d0: 'A', f0: 'A', c0: 'B', g0: 'B', e3: 'R',
        e9: 'k', d9: 'a', f9: 'a', c9: 'b', g9: 'b', e5: 'p', a5: 'r',
      },
      'w',
    );
    const searcher = new Searcher(16);
    for (let i = 0; i < 40; i++) {
      const r = findBestMove(searcher, pos, 'easy', { maxDepth: 3, pickSeed: i });
      expect(moveToIccs(r.move), `slip ${i}`).not.toBe('e3e5');
    }
  }, 60_000);

  it('easy still finds a mate in one rather than slipping', () => {
    const pos = positionOf({ e9: 'k', a8: 'R', i8: 'R', d0: 'K' }, 'w');
    const searcher = new Searcher(16);
    for (let i = 0; i < 12; i++) {
      const r = findBestMove(searcher, pos, 'easy', { maxDepth: 3, pickSeed: i });
      expect(moveToIccs(r.move)).toBe('a8a9');
    }
  }, 30_000);
});

describe('randomised self-play never produces an illegal move', () => {
  /**
   * 200 games, both sides driven by the engine at low strength with the
   * difficulty layer's randomisation supplying the variety. Every single move
   * the engine returns is checked against the naive generator's legal list —
   * not against the engine's own, which would prove nothing.
   */
  it('200 games, every move validated against the reference generator', async () => {
    const searcher = new Searcher(16);
    let moveCount = 0;
    let finished = 0;
    const endings = new Map<string, number>();

    for (let game = 0; game < 200; game++) {
      // Hand the event loop back periodically: the whole run is synchronous
      // otherwise, and the test runner's progress channel times out.
      if (game % 10 === 0) await new Promise((r) => setTimeout(r, 0));
      const pos = new Position(START_FEN);
      searcher.newGame();
      for (let ply = 0; ply < 26; ply++) {
        const state = adjudicate(pos);
        if (state.kind !== 'ongoing') {
          finished++;
          endings.set(state.kind, (endings.get(state.kind) ?? 0) + 1);
          break;
        }

        const result = findBestMove(searcher, pos, ply % 2 === 0 ? 'easy' : 'medium', {
          maxDepth: 2,
          timeMs: 0,
          nodeLimit: 1500,
          pickSeed: game * 1000 + ply,
        });
        expect(result.move, `game ${game} ply ${ply}: engine returned no move`).not.toBe(NO_MOVE);

        const ref = refParse(pos.toFen());
        const legal = new Set(refMoveKeys(refLegalMoves(ref.cells, ref.side)));
        expect(
          legal.has(key(result.move)),
          `game ${game} ply ${ply}: ${moveToIccs(result.move)} is not legal in ${pos.toFen()}`,
        ).toBe(true);

        expect(pos.makeMove(result.move)).toBe(true);
        moveCount++;
      }
    }

    console.log(
      `[self-play] 200 games, ${moveCount} engine moves all legal; ` +
        `${finished} reached a terminal state: ${JSON.stringify(Object.fromEntries(endings))}`,
    );
    expect(moveCount).toBeGreaterThan(4800);
  }, 600_000);
});
