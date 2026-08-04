import { describe, it } from 'vitest';
import { START_FEN } from '@core/testapi.ts';
import { Side } from '@core/types.ts';
import { Position, Searcher, adjudicate, iccsToMove } from '@engine/index.ts';

/** Distinct book openings, replayed to give each game a different character. */
const OPENINGS = [
  'h2e2 h9g7 h0g2 i9h9',
  'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7',
  'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 g6g5',
  'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 h0h4 c6c5',
  'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 b2d2 c6c5',
  'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 b2c2 c6c5',
  'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 e3e4 c6c5',
  'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 a0a1 c6c5',
  'h2e2 b9c7 h0g2 h7f7 i0h0 h9g7',
  'h2e2 h9g7 h0g2 b9a7 i0h0 i9h9',
  'h2e2 h7e7 h0g2 h9g7',
  'h2e2 h7e7 h0g2 h9g7 i0h0 i9h9 h0h6 b9c7',
  'h2e2 h7e7 h0g2 h9g7 a0a1 i9h9 a1d1 b9c7',
  'h2e2 b7e7 h0g2 h9g7 i0h0 i9h9',
  'c3c4 b7g7 h2e2 b9c7',
  'c3c4 h7e7 h0g2 h9g7 i0h0 i9h9',
  'c3c4 g6g5 h2e2 h9g7 h0g2 i9h9',
  'c3c4 c6c5 h2e2 b9c7 h0g2 h9g7',
  'g0e2 h7e7 b0c2 h9g7 a0b0 i9h9',
  'g0e2 b7e7 b0c2 b9c7 a0b0 a9b9',
  'g0e2 g6g5 h0g2 h9g7 i0h0 i9h9',
  'g0e2 h7f7 b0c2 b9c7 a0b0 a9b9',
  'b0c2 c6c5 c3c4 b9c7 h2e2 h9g7',
  'b0c2 h7e7 h2e2 h9g7 h0g2 i9h9',
  'h0g2 h7e7 b2e2 h9g7 b0c2 i9h9',
  'h0g2 c6c5 b2e2 b9c7 b0c2 h9g7',
  'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 f9e8',
  'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 i3i4 g6g5',
  'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 a3a4 c6c5',
  'c3c4 c9e7 h2e2 h9g7 h0g2 i9h9',
];

const MOVE_MS = 80;
const MAX_PLIES = 100;

interface Engine {
  name: string;
  q: number;
  searcher: Searcher;
}

/** Returns 1 if `red` won, 0 if `black` won, 0.5 for a draw. */
function playGame(opening: string, red: Engine, black: Engine): { score: number; plies: number; how: string } {
  const pos = new Position(START_FEN);
  for (const t of opening.split(' ')) pos.makeMove(iccsToMove(pos, t));
  red.searcher.newGame();
  black.searcher.newGame();

  for (let ply = 0; ply < MAX_PLIES; ply++) {
    const state = adjudicate(pos);
    if (state.kind !== 'ongoing') {
      if (state.winner === null) return { score: 0.5, plies: ply, how: state.kind };
      return { score: state.winner === Side.Red ? 1 : 0, plies: ply, how: state.kind };
    }
    const engine = pos.side === Side.Red ? red : black;
    const r = engine.searcher.search(pos, { maxDepth: 40, timeMs: MOVE_MS, qCheckPlies: engine.q });
    if (r.move === 0) return { score: pos.side === Side.Red ? 0 : 1, plies: ply, how: 'nomove' };
    pos.makeMove(r.move);
  }
  return { score: 0.5, plies: MAX_PLIES, how: 'ply-cap' };
}

describe('qCheckPlies head-to-head', () => {
  it('runs the match', () => {
    const a: Engine = { name: 'q1', q: 1, searcher: new Searcher(20) };
    const b: Engine = { name: 'q0', q: 0, searcher: new Searcher(20) };

    let aScore = 0;
    let games = 0;
    const how = new Map<string, number>();
    const t0 = Date.now();

    for (const opening of OPENINGS) {
      // Game 1: A is Red. Game 2: colours swapped.
      for (const aIsRed of [true, false]) {
        const g = aIsRed ? playGame(opening, a, b) : playGame(opening, b, a);
        aScore += aIsRed ? g.score : 1 - g.score;
        games++;
        how.set(g.how, (how.get(g.how) ?? 0) + 1);
      }
    }

    const pct = (aScore / games) * 100;
    // Standard error of a score in [0,1] over n games, worst case sigma = 0.5.
    const se = (0.5 / Math.sqrt(games)) * 100;
    console.log(
      `[match] qCheckPlies=1 scored ${aScore.toFixed(1)}/${games} = ${pct.toFixed(1)}% ` +
        `(+/- ~${se.toFixed(1)}% 1SD) against qCheckPlies=0 at ${MOVE_MS}ms/move`,
    );
    console.log(`[match] endings: ${JSON.stringify(Object.fromEntries(how))}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }, 3_600_000);
});
