/**
 * Recorded performance measurements.
 *
 * These are not strength tests — they exist so that a change which quietly
 * halves the node rate shows up as a number in the test log rather than as
 * "the engine feels weaker". The assertions are deliberately loose: they catch
 * an accidental quadratic or a per-node allocation, not a few percent.
 *
 * Every figure the report quotes comes from here.
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
    // has started allocating.
    expect(evalRate).toBeGreaterThan(20_000);
    expect(genRate).toBeGreaterThan(60_000);
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
    expect(nps).toBeGreaterThan(15_000);
  }, 30_000);
});
