/**
 * Recorded performance measurements.
 *
 * These are not strength tests — they exist so that a change which quietly
 * halves the node rate shows up as a number in the test log rather than as
 * "the engine feels weaker".
 *
 * The assertions are deliberately very loose, for one specific reason: the
 * suite runs its files in parallel, so every rate measured during a full
 * `vitest run` is taken on a contended machine and reads three to four times
 * lower than the same code measured alone. The thresholds have to survive the
 * contended case, which means they can only catch a real collapse — an
 * accidental quadratic, or an allocation that reappears in the node loop.
 *
 * For a figure worth quoting, run this file on its own:
 *     npx vitest run tests/bench.test.ts
 */

import { describe, expect, it } from 'vitest';
import { START_FEN } from '@core/testapi.ts';
import { MoveList, Position, Searcher, evaluate, generateMoves, perft } from '@engine/index.ts';

/** A busy middlegame: two chariots active, cannons on the board, soldiers past the river. */
const MIDGAME = 'r1bakabr1/8c/1cn3n2/p1p1p1R1p/6p2/2P6/P3P1P1P/1C2C1N2/9/RNBAKAB2 w - - 12 7';

function rate(ms: number, work: () => void): number {
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < ms) {
    for (let i = 0; i < 500; i++) work();
    n += 500;
  }
  return n / ((Date.now() - t0) / 1000);
}

describe('component throughput', () => {
  it('movegen and evaluation', () => {
    const pos = new Position(MIDGAME);
    const list = new MoveList();

    const genRate = rate(600, () => generateMoves(pos, list));
    const evalRate = rate(600, () => evaluate(pos));
    console.log(
      `[bench] generateMoves ${Math.round(genRate).toLocaleString()}/s, ` +
        `evaluate ${Math.round(evalRate).toLocaleString()}/s`,
    );

    // The evaluation runs two weighted-mobility passes, so it can never be much
    // faster than half a movegen; if it drops far below that, something in it
    // has started allocating. Floors set for the contended in-suite case.
    expect(evalRate).toBeGreaterThan(8_000);
    expect(genRate).toBeGreaterThan(20_000);
  }, 30_000);

  it('make/unmake, through perft', () => {
    const pos = new Position(START_FEN);
    perft(pos, 2); // warm the JIT
    const t0 = Date.now();
    const nodes = perft(pos, 4);
    const ms = Date.now() - t0;
    console.log(`[bench] perft d4 ${nodes.toLocaleString()} nodes in ${ms}ms = ${Math.round(nodes / (ms / 1000)).toLocaleString()} n/s`);
    expect(nodes).toBe(3290240);
    expect(nodes / (ms / 1000)).toBeGreaterThan(50_000);
  }, 120_000);
});

describe('search shape', () => {
  /**
   * The honest effective branching factor.
   *
   * Reading it off one iterative-deepening run flatters the ordering badly: the
   * transposition table carries between iterations, so a deeper pass can visit
   * *fewer* nodes than a shallower one and the geometric mean collapses. This
   * runs each depth as its own search with a fresh table, which is the number
   * that can be compared against the theoretical floor — xiangqi's raw
   * branching factor is around 40, so perfect ordering would sit near 6.3.
   */
  it('effective branching factor, fresh table per depth', () => {
    for (const [name, fen] of [
      ['opening', START_FEN],
      ['midgame', MIDGAME],
    ] as [string, string][]) {
      const nodes: number[] = [];
      for (let d = 4; d <= 8; d++) {
        const searcher = new Searcher(20); // fresh table, no carry-over
        const r = searcher.search(new Position(fen), { maxDepth: d, timeMs: 0 });
        nodes.push(r.nodes);
      }
      const ratios: number[] = [];
      for (let i = 1; i < nodes.length; i++) ratios.push(nodes[i] / nodes[i - 1]);
      const ebf = Math.exp(ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length);
      console.log(
        `[bench] EBF ${name}: ${ebf.toFixed(2)} from depth 4..8 nodes ${JSON.stringify(nodes)} ` +
          `(ratios ${ratios.map((r) => r.toFixed(2)).join(', ')})`,
      );
      // Well under the raw branching factor of ~40; if any ordering component
      // regresses this climbs immediately.
      expect(ebf).toBeGreaterThan(1.5);
      expect(ebf).toBeLessThan(10);
    }
  }, 180_000);
});

describe('search throughput', () => {
  it.each([
    ['opening', START_FEN],
    ['midgame', MIDGAME],
  ])('%s: three seconds of hard search', (name, fen) => {
    const pos = new Position(fen);
    const searcher = new Searcher(20);
    const result = searcher.search(pos, { maxDepth: 40, timeMs: 3000 });
    const nps = result.nodes / (result.timeMs / 1000);
    console.log(
      `[bench] search ${name}: depth ${result.depth}, ${result.nodes.toLocaleString()} nodes, ` +
        `${Math.round(nps).toLocaleString()} n/s, EBF ${result.effectiveBranching.toFixed(2)}, ` +
        `per-depth ${JSON.stringify(result.depthNodes)}`,
    );
    expect(result.depth).toBeGreaterThanOrEqual(5);
    expect(nps).toBeGreaterThan(10_000);
  }, 30_000);
});
