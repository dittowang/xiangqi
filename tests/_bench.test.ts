import { describe, it } from 'vitest';
import { START_FEN } from '@core/testapi.ts';
import { MoveList, Position, Searcher, evaluate, generateMoves, perft } from '@engine/index.ts';

const MID = 'r1bakabr1/8c/1cn3n2/p1p1p1R1p/6p2/2P6/P3P1P1P/1C2C1N2/9/RNBAKAB2 w - - 12 7';

describe('bench', () => {
  it('component costs', () => {
    const pos = new Position(MID);
    const list = new MoveList();

    // movegen alone
    let t = Date.now();
    let n = 0;
    while (Date.now() - t < 800) {
      for (let i = 0; i < 1000; i++) generateMoves(pos, list);
      n += 1000;
    }
    const genRate = n / ((Date.now() - t) / 1000);
    console.log(`[bench] generateMoves: ${Math.round(genRate)}/sec`);

    // eval alone
    t = Date.now();
    n = 0;
    while (Date.now() - t < 800) {
      for (let i = 0; i < 1000; i++) evaluate(pos);
      n += 1000;
    }
    const evalRate = n / ((Date.now() - t) / 1000);
    console.log(`[bench] evaluate:      ${Math.round(evalRate)}/sec`);

    // perft (pure make/unmake + legality)
    perft(pos, 2);
    t = Date.now();
    const nodes = perft(pos, 4);
    const ms = Date.now() - t;
    console.log(`[bench] perft d4:      ${Math.round(nodes / (ms / 1000))} nodes/sec (${nodes} in ${ms}ms)`);
  }, 60_000);

  it('search speed', () => {
    for (const fen of [START_FEN, MID]) {
      const pos = new Position(fen);
      const s = new Searcher(20);
      const r = s.search(pos, { maxDepth: 30, timeMs: 3000 });
      console.log(
        `[bench] search ${fen === START_FEN ? 'start' : 'mid  '}: depth ${r.depth}, ` +
          `${r.nodes} nodes, ${Math.round(r.nodes / (r.timeMs / 1000))} nps, EBF ${r.effectiveBranching.toFixed(2)}`,
      );
    }
  }, 60_000);
});
