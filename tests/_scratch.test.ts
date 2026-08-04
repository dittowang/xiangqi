import { describe, it } from 'vitest';
import { adjudicate, analyseRepetition, iccsToMove, moveToIccs } from '@engine/index.ts';
import { positionOf } from './helpers.ts';

function play(pos: ReturnType<typeof positionOf>, moves: string[]) {
  for (const t of moves) {
    const m = iccsToMove(pos, t);
    if (!m) throw new Error(`illegal ${t} in ${pos.toFen()}`);
    pos.makeMove(m);
  }
}

describe('repetition fixtures', () => {
  it('perpetual check', () => {
    const p = positionOf({ e9: 'k', a8: 'R', d0: 'K' }, 'w');
    const cycle = ['a8a9', 'e9e8', 'a9a8', 'e8e9'];
    for (let i = 0; i < 3; i++) play(p, cycle);
    console.log('reps', p.repetitionCount(), 'analysis', JSON.stringify(analyseRepetition(p)));
    console.log('adjudicate', JSON.stringify(adjudicate(p)));
  });

  it('perpetual chase', () => {
    const p = positionOf({ f9: 'k', e6: 'n', a4: 'R', e0: 'K' }, 'w');
    console.log('start fen', p.toFen());
    const cycle = ['a4a6', 'e6d4', 'a6a4', 'd4e6'];
    try {
      for (let i = 0; i < 3; i++) play(p, cycle);
      console.log('reps', p.repetitionCount(), 'analysis', JSON.stringify(analyseRepetition(p)));
      console.log('adjudicate', JSON.stringify(adjudicate(p)));
    } catch (e) {
      console.log('ERR', (e as Error).message);
    }
  });

  it('quiet repetition draw', () => {
    const p = positionOf({ f9: 'k', c9: 'b', d0: 'K', g0: 'B' }, 'w');
    const cycle = ['d0d1', 'f9f8', 'd1d0', 'f8f9'];
    for (let i = 0; i < 3; i++) play(p, cycle);
    console.log('reps', p.repetitionCount(), 'analysis', JSON.stringify(analyseRepetition(p)));
    console.log('adjudicate', JSON.stringify(adjudicate(p)));
  });
});
