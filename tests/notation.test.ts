/**
 * Traditional relative notation, and the opening book that is written in it.
 *
 * The round-trip property is the important one: `parseNotation` is implemented
 * by formatting every legal move and comparing, so if the two directions ever
 * disagree the parse simply fails to find a move — which this suite turns into
 * a loud failure rather than a silent one.
 */

import { describe, expect, it } from 'vitest';
import { START_FEN } from '@core/testapi.ts';
import {
  MoveList,
  Position,
  bookEntries,
  bookStats,
  generateLegalMoves,
  iccsToMove,
  lineToNotation,
  moveToIccs,
  moveToNotation,
  parseNotation,
} from '@engine/index.ts';
import { positionOf } from './helpers.ts';

const FIXTURES = [
  START_FEN,
  'r1bakabr1/9/1cn3nc1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C1N2/9/RNBAKABR1 w - - 6 4',
  'r1bakabr1/8c/1cn3n2/p1p1p1R1p/6p2/2P6/P3P1P1P/1C2C1N2/9/RNBAKAB2 b - - 12 7',
  '2bak4/9/9/4c4/9/R3P4/4C4/9/9/4KAB2 w - - 0 1',
];

describe('notation round-trips', () => {
  it.each(FIXTURES)('every legal move in %s parses back to itself', (fen) => {
    const pos = new Position(fen);
    const list = new MoveList();
    generateLegalMoves(pos, list);
    expect(list.count).toBeGreaterThan(0);
    for (const m of list.toArray()) {
      const text = moveToNotation(pos, m);
      expect(text.length).toBeGreaterThanOrEqual(3);
      expect(parseNotation(pos, text), `"${text}" for ${moveToIccs(m)}`).toBe(m);
    }
  });

  it('produces the canonical names for the standard first moves', () => {
    const pos = new Position(START_FEN);
    const name = (iccs: string) => moveToNotation(pos, iccsToMove(pos, iccs));
    expect(name('h2e2')).toBe('炮二平五'); // central cannon
    expect(name('b2e2')).toBe('炮八平五');
    expect(name('h0g2')).toBe('傌二進三'); // Red's horse glyph is 傌
    expect(name('b0c2')).toBe('傌八進七');
    expect(name('g0e2')).toBe('相三進五');
    expect(name('c0e2')).toBe('相七進五');
    expect(name('c3c4')).toBe('兵七進一');
    expect(name('a0a1')).toBe('俥九進一'); // Red's chariot glyph is 俥
    expect(name('e0e1')).toBe('帥五進一');
    expect(name('d0e1')).toBe('仕六進五');
  });

  it('names Black’s moves with digits and Black’s glyphs', () => {
    const pos = new Position(START_FEN.replace(' w ', ' b '));
    const name = (iccs: string) => moveToNotation(pos, iccsToMove(pos, iccs));
    expect(name('h9g7')).toBe('馬８進７');
    expect(name('b9c7')).toBe('馬２進３');
    expect(name('h7e7')).toBe('砲８平５');
    expect(name('i9i8')).toBe('車９進１');
    expect(name('g6g5')).toBe('卒７進１');
    expect(name('c9e7')).toBe('象３進５');
  });

  it('disambiguates two pieces on one file with 前 and 後', () => {
    // Two Red chariots on file e; e2 (rank 7) is the one nearer Black.
    const pos = positionOf({ d0: 'K', a9: 'k', e2: 'R', e1: 'R' }, 'w');
    expect(moveToNotation(pos, iccsToMove(pos, 'e2e3'))).toBe('前俥進一');
    expect(moveToNotation(pos, iccsToMove(pos, 'e1e0'))).toBe('後俥退一');
  });

  it('disambiguates three soldiers on one file with 前 中 後', () => {
    // Ranks 3, 5 and 7 of file e, so each has an empty square in front of it.
    const pos = positionOf({ d0: 'K', a9: 'k', e6: 'P', e4: 'P', e2: 'P' }, 'w');
    expect(moveToNotation(pos, iccsToMove(pos, 'e6e7'))).toBe('前兵進一');
    expect(moveToNotation(pos, iccsToMove(pos, 'e4e5'))).toBe('中兵進一');
    expect(moveToNotation(pos, iccsToMove(pos, 'e2e3'))).toBe('後兵進一');
  });

  it('formats a whole line and leaves the position untouched', () => {
    const pos = new Position(START_FEN);
    const moves = ['h2e2', 'h9g7', 'h0g2'].map((t) => {
      const m = iccsToMove(pos, t);
      pos.makeMove(m);
      return m;
    });
    for (let i = 0; i < moves.length; i++) pos.unmakeMove();

    expect(lineToNotation(pos, moves)).toEqual(['炮二平五', '馬８進７', '傌二進三']);
    expect(pos.toFen()).toBe(START_FEN);
  });

  it('accepts ICCS as an alternative input form', () => {
    const pos = new Position(START_FEN);
    expect(parseNotation(pos, 'h2e2')).toBe(iccsToMove(pos, 'h2e2'));
    expect(parseNotation(pos, 'h2h2')).toBe(0);
    expect(parseNotation(pos, '車前進三')).toBe(0);
  });
});

describe('opening book', () => {
  const stats = bookStats();

  it('every authored line is legal from the standard opening', () => {
    expect(stats.rejected).toEqual([]);
  });

  it('expands to a few hundred positions', () => {
    console.log(
      `[book] ${stats.lines} lines -> ${stats.positions} positions, ` +
        `${stats.entries} weighted replies, max depth ${stats.maxPly} plies`,
    );
    expect(stats.positions).toBeGreaterThan(200);
    expect(stats.entries).toBeGreaterThanOrEqual(stats.positions);
  });

  it('offers several replies to the opening position', () => {
    const entries = bookEntries(new Position(START_FEN))!;
    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (const e of entries) expect(e.weight).toBeGreaterThan(0);
    const names = entries.map((e) => moveToNotation(new Position(START_FEN), e.move));
    expect(names).toContain('炮二平五');
    console.log(`[book] first moves: ${names.join(' ')}`);
  });

  it('every stored move is legal in its own position', () => {
    // Walk the book by replaying from the start: any stored move that is not
    // legal would have to have come from a hash collision.
    const pos = new Position(START_FEN);
    let checked = 0;
    const walk = (depth: number) => {
      if (depth === 0) return;
      const entries = bookEntries(pos);
      if (!entries) return;
      for (const e of entries) {
        const list = new MoveList();
        generateLegalMoves(pos, list);
        expect(list.toArray()).toContain(e.move);
        checked++;
        pos.makeMove(e.move);
        walk(depth - 1);
        pos.unmakeMove();
      }
    };
    walk(14);
    expect(checked).toBeGreaterThan(200);
    expect(pos.toFen()).toBe(START_FEN);
  });

  it('leaves the book after its deepest line', () => {
    const pos = new Position(START_FEN);
    for (const t of 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 g6g5 b0c2 c9e7 a0b0 a9b9'.split(' ')) {
      expect(bookEntries(pos)).not.toBeNull();
      pos.makeMove(iccsToMove(pos, t));
    }
    // Two plies past the end of every line through this position.
    pos.makeMove(iccsToMove(pos, 'g3g4'));
    expect(bookEntries(pos)).toBeNull();
  });
});
