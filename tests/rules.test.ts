/**
 * Piece-movement rules, one case per thing people get wrong.
 *
 * Positions are built from ICCS coordinate maps (`{ e0: 'K' }`) rather than
 * hand-written FEN rows, because a mistyped FEN row produces a *different* test
 * rather than a failing one.
 *
 * Note the recurring `{ d0: 'K', f9: 'k' }` pair: the two generals are put on
 * different files on purpose, so that a test about the horse's leg is not
 * secretly also a test about the flying general. The flying-general cases below
 * put them back on the same file deliberately.
 */

import { describe, expect, it } from 'vitest';
import { Side } from '@core/types.ts';
import { Position, findLegalMove, legalTargets } from '@engine/index.ts';
import { allLegal, positionOf, sqOf, targetsIccs } from './helpers.ts';

/** Two generals that can never see each other, for the non-flying-general tests. */
const KINGS = { d0: 'K', f9: 'k' } as const;

describe('flying general (對面笑)', () => {
  /**
   * Both generals on file e, with a single Red cannon between them. A cannon
   * with no screen does not attack the general it faces, so the position is
   * quiet — and every cannon move that stays on file e is legal while every
   * move that leaves it is illegal. Same piece, same board; the only difference
   * is the flying-general rule.
   */
  const facing = () => positionOf({ e0: 'K', e5: 'C', e9: 'k' }, 'w');

  it('a move is illegal only because it uncovers the generals', () => {
    const pos = facing();
    // Along the file: still blocking, still legal.
    expect(findLegalMove(pos, sqOf('e5'), sqOf('e6'))).not.toBe(0);
    expect(findLegalMove(pos, sqOf('e5'), sqOf('e4'))).not.toBe(0);
    expect(findLegalMove(pos, sqOf('e5'), sqOf('e1'))).not.toBe(0);
    // Off the file: an ordinary cannon slide onto an empty square, illegal
    // purely because it lets the generals see each other.
    expect(findLegalMove(pos, sqOf('e5'), sqOf('d5'))).toBe(0);
    expect(findLegalMove(pos, sqOf('e5'), sqOf('a5'))).toBe(0);
    expect(findLegalMove(pos, sqOf('e5'), sqOf('i5'))).toBe(0);
  });

  it('every legal move of the blocking piece keeps the file blocked', () => {
    const pos = facing();
    const targets = targetsIccs(pos, 'e5');
    expect(targets.length).toBeGreaterThan(4);
    for (const t of targets) expect(t[0]).toBe('e');
  });

  it('a soldier on the file is pinned to it in the same way', () => {
    // Red soldier on e6 has crossed the river, so it normally has three moves.
    const pos = positionOf({ e0: 'K', e6: 'P', e9: 'k' }, 'w');
    expect(targetsIccs(pos, 'e6')).toEqual(['e7']);
  });

  it('the generals themselves may not step onto a shared open file', () => {
    const pos = positionOf({ e0: 'K', d9: 'k', a0: 'R' }, 'w');
    expect(findLegalMove(pos, sqOf('e0'), sqOf('d0'))).toBe(0);
    expect(findLegalMove(pos, sqOf('e0'), sqOf('f0'))).not.toBe(0);
  });

  it('a blocked file is not a facing file', () => {
    const pos = positionOf({ e0: 'K', d9: 'k', d5: 'p', a0: 'R' }, 'w');
    expect(findLegalMove(pos, sqOf('e0'), sqOf('d0'))).not.toBe(0);
  });

  it('an advisor that is the only blocker cannot move at all', () => {
    const pos = positionOf({ e0: 'K', e1: 'A', e9: 'k' }, 'w');
    expect(legalTargets(pos, sqOf('e1'))).toEqual([]);
  });
});

describe('horse — blocked leg (蹩馬腿)', () => {
  const HORSE = 'e4'; // (file 4, rank 5): all eight moves available
  const LEGS: Record<string, string[]> = {
    e5: ['d6', 'f6'], // leg toward Black
    e3: ['d2', 'f2'], // leg toward Red
    d4: ['c5', 'c3'], // leg toward file 0
    f4: ['g5', 'g3'], // leg toward file 8
  };

  it('an unobstructed horse has all eight moves', () => {
    const pos = positionOf({ ...KINGS, [HORSE]: 'N' }, 'w');
    expect(targetsIccs(pos, HORSE)).toEqual(
      ['c3', 'c5', 'd2', 'd6', 'f2', 'f6', 'g3', 'g5'].sort(),
    );
  });

  it.each(Object.entries(LEGS))('a piece on %s blocks exactly its two targets', (leg, blocked) => {
    // A friendly blocker, so the only thing being tested is the leg rule and
    // not "you cannot capture your own piece".
    const pos = positionOf({ ...KINGS, [HORSE]: 'N', [leg]: 'P' }, 'w');
    const targets = targetsIccs(pos, HORSE);
    for (const b of blocked) expect(targets).not.toContain(b);
    expect(targets).toHaveLength(6);
  });

  it('an enemy blocker blocks the leg just the same', () => {
    const pos = positionOf({ ...KINGS, [HORSE]: 'N', d4: 'p' }, 'w');
    const targets = targetsIccs(pos, HORSE);
    expect(targets).not.toContain('c5');
    expect(targets).not.toContain('c3');
    expect(targets).toHaveLength(6);
  });

  it('the leg is measured from the horse, not from the target', () => {
    // A piece on c5 itself does not block the c5 jump — only d4 does.
    const pos = positionOf({ ...KINGS, [HORSE]: 'N', c5: 'p' }, 'w');
    expect(targetsIccs(pos, HORSE)).toContain('c5');
  });
});

describe('elephant — blocked eye (塞象眼) and the river', () => {
  it('a free elephant on the back rank has two moves', () => {
    const pos = positionOf({ ...KINGS, c0: 'B' }, 'w');
    expect(targetsIccs(pos, 'c0')).toEqual(['a2', 'e2']);
  });

  it('a piece on the eye removes exactly that diagonal', () => {
    expect(targetsIccs(positionOf({ ...KINGS, c0: 'B', d1: 'P' }, 'w'), 'c0')).toEqual(['a2']);
    expect(targetsIccs(positionOf({ ...KINGS, c0: 'B', b1: 'P' }, 'w'), 'c0')).toEqual(['e2']);
  });

  it('an elephant on the river bank may not cross it', () => {
    // c4 is (file 2, rank 5) — Red's bank. Its forward diagonals land on rank 3,
    // which is Black's half, so only the two backward ones survive.
    const pos = positionOf({ ...KINGS, c4: 'B' }, 'w');
    expect(targetsIccs(pos, 'c4')).toEqual(['a2', 'e2']);
  });

  it('a Black elephant is confined to Black’s half symmetrically', () => {
    const pos = positionOf({ ...KINGS, c5: 'b' }, 'b');
    expect(targetsIccs(pos, 'c5')).toEqual(['a7', 'e7']);
  });

  it('the seven elephant points are the only squares it ever reaches', () => {
    const reachable = new Set<string>();
    for (const home of ['a2', 'c0', 'c4', 'e2', 'g0', 'g4', 'i2']) {
      const pos = positionOf({ ...KINGS, [home]: 'B' }, 'w');
      for (const t of targetsIccs(pos, home)) reachable.add(t);
    }
    expect([...reachable].sort()).toEqual(['a2', 'c0', 'c4', 'e2', 'g0', 'g4', 'i2']);
  });
});

describe('cannon — exactly one screen', () => {
  const cannonAt = (extra: Record<string, string>) =>
    positionOf({ ...KINGS, a0: 'C', a4: 'r', ...extra }, 'w');

  it('with zero screens it may slide but not capture', () => {
    const targets = targetsIccs(cannonAt({}), 'a0');
    expect(targets).toContain('a1');
    expect(targets).toContain('a3');
    expect(targets).not.toContain('a4'); // the enemy chariot, unreachable
  });

  it('with exactly one screen it captures over it', () => {
    const targets = targetsIccs(cannonAt({ a2: 'P' }), 'a0');
    expect(targets).toContain('a4');
    // ...and can no longer slide past its own screen.
    expect(targets).not.toContain('a3');
  });

  it('an enemy piece screens just as well as a friendly one', () => {
    expect(targetsIccs(cannonAt({ a2: 'p' }), 'a0')).toContain('a4');
  });

  it('with two screens the capture is gone again', () => {
    expect(targetsIccs(cannonAt({ a2: 'P', a3: 'P' }), 'a0')).not.toContain('a4');
  });

  it('the screen may sit anywhere between origin and target', () => {
    expect(targetsIccs(cannonAt({ a1: 'P' }), 'a0')).toContain('a4');
    expect(targetsIccs(cannonAt({ a3: 'P' }), 'a0')).toContain('a4');
  });

  it('a cannon may not capture the piece it is using as a screen', () => {
    expect(targetsIccs(cannonAt({ a2: 'p' }), 'a0')).not.toContain('a2');
  });
});

describe('soldier', () => {
  it('before the river it may only step forward', () => {
    // e3 is (file 4, rank 6) — Red's own half.
    expect(targetsIccs(positionOf({ ...KINGS, e3: 'P' }, 'w'), 'e3')).toEqual(['e4']);
  });

  it('after the river it gains the two sideways steps', () => {
    // e5 is (file 4, rank 4) — across the river.
    expect(targetsIccs(positionOf({ ...KINGS, e5: 'P' }, 'w'), 'e5')).toEqual(['d5', 'e6', 'f5']);
  });

  it('never moves backward, on either side of the river', () => {
    expect(targetsIccs(positionOf({ ...KINGS, e3: 'P' }, 'w'), 'e3')).not.toContain('e2');
    expect(targetsIccs(positionOf({ ...KINGS, e5: 'P' }, 'w'), 'e5')).not.toContain('e4');
  });

  it('on the enemy back rank it may only move sideways', () => {
    const pos = positionOf({ d0: 'K', a9: 'k', e9: 'P' }, 'w');
    expect(targetsIccs(pos, 'e9')).toEqual(['d9', 'f9']);
  });

  it('a Black soldier mirrors all of it', () => {
    expect(targetsIccs(positionOf({ ...KINGS, e6: 'p' }, 'b'), 'e6')).toEqual(['e5']);
    expect(targetsIccs(positionOf({ ...KINGS, e4: 'p' }, 'b'), 'e4')).toEqual(['d4', 'e3', 'f4']);
  });
});

describe('palace confinement', () => {
  it('the general steps one orthogonal and never leaves the palace', () => {
    const centre = positionOf({ e1: 'K', a9: 'k' }, 'w');
    expect(targetsIccs(centre, 'e1')).toEqual(['d1', 'e0', 'e2', 'f1']);

    const corner = positionOf({ d0: 'K', a9: 'k' }, 'w');
    expect(targetsIccs(corner, 'd0')).toEqual(['d1', 'e0']);
    expect(targetsIccs(corner, 'd0')).not.toContain('c0');
  });

  it('the general may not step out of the palace forward', () => {
    const pos = positionOf({ e2: 'K', a9: 'k' }, 'w');
    expect(targetsIccs(pos, 'e2')).not.toContain('e3');
    expect(targetsIccs(pos, 'e2')).toEqual(['d2', 'e1', 'f2']);
  });

  it('the advisor moves one diagonal inside the palace only', () => {
    const centre = positionOf({ e0: 'K', a9: 'k', e1: 'A' }, 'w');
    expect(targetsIccs(centre, 'e1')).toEqual(['d0', 'd2', 'f0', 'f2']);

    const corner = positionOf({ e0: 'K', a9: 'k', d0: 'A' }, 'w');
    expect(targetsIccs(corner, 'd0')).toEqual(['e1']);
  });

  it('an advisor on a palace corner has exactly one move', () => {
    const pos = positionOf({ e0: 'K', a9: 'k', d2: 'A' }, 'w');
    expect(targetsIccs(pos, 'd2')).toEqual(['e1']);
  });

  it('the Black palace is the mirror of the Red one', () => {
    // Red soldier on e5 blocks file e so the two generals are not facing.
    const general = positionOf({ e0: 'K', e8: 'k', e5: 'P' }, 'b');
    expect(targetsIccs(general, 'e8')).toEqual(['d8', 'e7', 'e9', 'f8']);

    const advisor = positionOf({ f0: 'K', d8: 'k', e8: 'a' }, 'b');
    expect(targetsIccs(advisor, 'e8')).toEqual(['d7', 'd9', 'f7', 'f9']);
  });
});

describe('check detection', () => {
  it('a chariot down an open file gives check', () => {
    const pos = positionOf({ e0: 'K', e9: 'k', e5: 'r' }, 'w');
    expect(pos.inCheck()).toBe(true);
    expect(pos.inCheck(Side.Red)).toBe(true);
    expect(pos.inCheck(Side.Black)).toBe(false);
  });

  it('a cannon needs exactly its screen to check', () => {
    expect(positionOf({ e0: 'K', e9: 'k', e5: 'c' }, 'w').inCheck()).toBe(false);
    expect(positionOf({ e0: 'K', e9: 'k', e5: 'c', e3: 'P' }, 'w').inCheck()).toBe(true);
    expect(positionOf({ e0: 'K', e9: 'k', e5: 'c', e3: 'P', e4: 'P' }, 'w').inCheck()).toBe(false);
  });

  it('a horse with a blocked leg does not check', () => {
    expect(positionOf({ e0: 'K', a9: 'k', d2: 'n' }, 'w').inCheck()).toBe(true);
    expect(positionOf({ e0: 'K', a9: 'k', d2: 'n', d1: 'P' }, 'w').inCheck()).toBe(false);
  });

  it('a crossed soldier checks sideways', () => {
    // d2 is (file 3, rank 7): a Black soldier there is deep in Red's half.
    expect(positionOf({ e2: 'K', a9: 'k', d2: 'p' }, 'w').inCheck()).toBe(true);
    // Directly in front of the general (e3 is rank 6, the general rank 7) it
    // checks by stepping forward.
    expect(positionOf({ e2: 'K', a9: 'k', e3: 'p' }, 'w').inCheck()).toBe(true);
    // Behind it (e1 is rank 8) it cannot: soldiers never move backward.
    expect(positionOf({ e2: 'K', a9: 'k', e1: 'p' }, 'w').inCheck()).toBe(false);
  });

  it('an advisor or elephant can never reach the enemy general', () => {
    expect(positionOf({ e2: 'K', a9: 'k', d1: 'a' }, 'w').inCheck()).toBe(false);
    expect(positionOf({ e2: 'K', a9: 'k', c0: 'b' }, 'w').inCheck()).toBe(false);
  });
});

describe('FEN', () => {
  it('round-trips the standard opening', () => {
    const fen = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
    expect(new Position(fen).toFen()).toBe(fen);
  });

  it('round-trips a sparse endgame with a halfmove clock', () => {
    const pos = positionOf({ e0: 'K', e9: 'k', a4: 'R', i5: 'c' }, 'b', 37);
    const fen = pos.toFen();
    expect(new Position(fen).toFen()).toBe(fen);
    expect(new Position(fen).halfmove).toBe(37);
    expect(new Position(fen).side).toBe(Side.Black);
  });

  it('rejects a malformed board', () => {
    expect(() => new Position('rnbakabnr/9/1c5c1 w')).toThrow();
    expect(() => new Position('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNX w')).toThrow();
  });

  /**
   * The incremental Zobrist key is the one piece of state that make/unmake can
   * corrupt silently — a wrong key does not break a move, it breaks the
   * transposition table three plies later. Recursing two full plies over every
   * legal move and checking the key on the way back out is the cheapest way to
   * prove the increments and their inverses agree.
   */
  it('make/unmake restores board, key and FEN exactly, two plies deep', () => {
    const fen = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
    const pos = new Position(fen);
    const check = (depth: number) => {
      const lo = pos.keyLo;
      const hi = pos.keyHi;
      const snapshot = pos.toFen();
      for (const m of allLegal(pos)) {
        pos.makeMove(m);
        if (depth > 1) check(depth - 1);
        pos.unmakeMove();
        expect(pos.keyLo).toBe(lo);
        expect(pos.keyHi).toBe(hi);
        expect(pos.toFen()).toBe(snapshot);
      }
    };
    check(2);
    expect(pos.toFen()).toBe(fen);
  });
});
