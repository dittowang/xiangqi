import { describe, it } from 'vitest';
import { START_FEN } from '@core/testapi.ts';
import { Position, Searcher } from '@engine/index.ts';

const MID = 'r1bakabr1/8c/1cn3n2/p1p1p1R1p/6p2/2P6/P3P1P1P/1C2C1N2/9/RNBAKAB2 w - - 12 7';
const END = '2bak4/9/9/4c4/9/R3P4/4C4/9/9/4KAB2 w - - 0 1';

function fixedDepth(fen: string, depth: number, qCheck?: number) {
  const pos = new Position(fen);
  const s = new Searcher(20);
  const t0 = Date.now();
  const r = s.search(pos, { maxDepth: depth, timeMs: 0, ...(qCheck !== undefined ? { qCheckPlies: qCheck } : {}) });
  return { nodes: r.nodes, ms: Date.now() - t0 };
}

describe('tune', () => {
  it('depths', () => {
    for (const [name, fen] of [['open', START_FEN], ['mid', MID], ['end', END]] as [string, string][]) {
      const rows: string[] = [];
      let prev = 0;
      for (let d = 4; d <= 9; d++) {
        const r = fixedDepth(fen, d);
        rows.push(`d${d}=${r.nodes}n/${r.ms}ms${prev ? ` x${(r.nodes / prev).toFixed(2)}` : ''}`);
        prev = r.nodes;
        if (r.ms > 15000) break;
      }
      console.log(`[tune] ${name}: ${rows.join('  ')}`);
    }
  }, 400_000);
});
