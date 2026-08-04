/**
 * Shared test scaffolding: building positions by ICCS coordinate, mirroring a
 * position, and a full-width mate solver used to verify the *positions* the
 * search tests use before the search is asked about them.
 */

import { EMPTY, type Move, PieceType, Side, moveTo, opposite, pieceSide, pieceType } from '@core/types.ts';
import { MoveList, Position, generateLegalMoves, mirrorSquare } from '@engine/index.ts';

/** ICCS square ("e0" is Red's general point) to the project's square index. */
export function sqOf(iccs: string): number {
  const f = iccs.charCodeAt(0) - 97;
  const row = Number(iccs[1]);
  if (f < 0 || f > 8 || !(row >= 0 && row <= 9)) throw new Error(`bad ICCS square "${iccs}"`);
  return (9 - row) * 9 + f;
}

/**
 * Build a FEN from an ICCS-keyed map, e.g. `{ e0: 'K', e9: 'k', a0: 'R' }`.
 * Far less error-prone than hand-writing a ten-row FEN for a test fixture.
 */
export function fenOf(
  pieces: Record<string, string>,
  side: 'w' | 'b' = 'w',
  halfmove = 0,
  fullmove = 1,
): string {
  const cells = new Array<string>(90).fill('');
  for (const [iccs, ch] of Object.entries(pieces)) cells[sqOf(iccs)] = ch;
  const rows: string[] = [];
  for (let r = 0; r < 10; r++) {
    let row = '';
    let gap = 0;
    for (let f = 0; f < 9; f++) {
      const ch = cells[r * 9 + f];
      if (!ch) {
        gap++;
        continue;
      }
      if (gap) {
        row += String(gap);
        gap = 0;
      }
      row += ch;
    }
    if (gap) row += String(gap);
    rows.push(row);
  }
  return `${rows.join('/')} ${side} - - ${halfmove} ${fullmove}`;
}

export function positionOf(
  pieces: Record<string, string>,
  side: 'w' | 'b' = 'w',
  halfmove = 0,
): Position {
  return new Position(fenOf(pieces, side, halfmove));
}

/** Legal destination squares for the piece on `from`, sorted. */
export function targetsFrom(pos: Position, from: number): number[] {
  const list = new MoveList();
  generateLegalMoves(pos, list);
  const out: number[] = [];
  for (let i = 0; i < list.count; i++) {
    if ((list.moves[i] & 0x7f) === from) out.push(moveTo(list.moves[i]));
  }
  return out.sort((a, b) => a - b);
}

export function targetsIccs(pos: Position, from: string): string[] {
  return targetsFrom(pos, sqOf(from))
    .map((s) => String.fromCharCode(97 + (s % 9)) + String(9 - Math.floor(s / 9)))
    .sort();
}

export function allLegal(pos: Position): Move[] {
  const list = new MoveList();
  generateLegalMoves(pos, list);
  return list.toArray();
}

/**
 * Mirror a position: flip it about the river and swap the armies. A correct
 * evaluation must return exactly the negation for the mirrored board.
 */
export function mirrorFen(pos: Position): string {
  const cells = new Array<string>(90).fill('');
  const LETTER: Record<number, string> = {
    [PieceType.General]: 'k',
    [PieceType.Advisor]: 'a',
    [PieceType.Elephant]: 'b',
    [PieceType.Horse]: 'n',
    [PieceType.Chariot]: 'r',
    [PieceType.Cannon]: 'c',
    [PieceType.Soldier]: 'p',
  };
  for (let s = 0; s < 90; s++) {
    const code = pos.board[s];
    if (code === EMPTY) continue;
    const flippedSide = opposite(pieceSide(code));
    const letter = LETTER[pieceType(code)];
    cells[mirrorSquare(s)] = flippedSide === Side.Red ? letter.toUpperCase() : letter;
  }
  const rows: string[] = [];
  for (let r = 0; r < 10; r++) {
    let row = '';
    let gap = 0;
    for (let f = 0; f < 9; f++) {
      const ch = cells[r * 9 + f];
      if (!ch) {
        gap++;
        continue;
      }
      if (gap) {
        row += String(gap);
        gap = 0;
      }
      row += ch;
    }
    if (gap) row += String(gap);
    rows.push(row);
  }
  const side = pos.side === Side.Red ? 'b' : 'w';
  return `${rows.join('/')} ${side} - - ${pos.halfmove} ${pos.fullmove}`;
}

/**
 * Full-width forced-mate solver, used to *verify the fixture* before the search
 * is asked about it. It shares the move generator (which perft has already
 * validated against the independent reference) but shares nothing at all with
 * `search.ts` — no transposition table, no pruning, no evaluation, no ordering.
 *
 * Returns the number of plies in which the side to move can force a win, or
 * Infinity. Xiangqi's "no legal move is a loss" rule applies: a side with no
 * move has lost whether or not it is in check, so the terminal test is simply
 * "the opponent has run out of moves".
 */
export function forcedMateIn(pos: Position, maxPlies: number): number {
  return mateForMover(pos, maxPlies);
}

function mateForMover(pos: Position, plies: number): number {
  if (plies <= 0) return Infinity;
  const list = new MoveList();
  generateLegalMoves(pos, list);
  const moves = list.toArray();

  let best = Infinity;
  for (const m of moves) {
    if (!pos.makeMove(m)) {
      pos.unmakeMove();
      continue;
    }

    const replyList = new MoveList();
    generateLegalMoves(pos, replyList);
    let value: number;
    if (replyList.count === 0) {
      value = 1; // the opponent has no legal move: mated or stalemated, both losses
    } else {
      // The defender picks whichever reply drags the mate out longest.
      let worst = -Infinity;
      const replies = replyList.toArray();
      for (const r of replies) {
        if (!pos.makeMove(r)) {
          pos.unmakeMove();
          continue;
        }
        const sub = mateForMover(pos, plies - 2);
        pos.unmakeMove();
        const v = sub === Infinity ? Infinity : sub + 2;
        if (v > worst) worst = v;
        if (worst === Infinity) break;
      }
      value = worst;
    }

    pos.unmakeMove();
    if (value < best) best = value;
  }
  return best;
}

/**
 * Every move that starts a forced mate in exactly `plies`. Used to check that
 * the search picked *a* correct mating move, not merely that it reported the
 * right distance — several moves can share the same distance and only some of
 * them are the ones a solver would accept.
 */
export function movesThatForceMateIn(pos: Position, plies: number): Move[] {
  const list = new MoveList();
  generateLegalMoves(pos, list);
  const out: Move[] = [];
  for (const m of list.toArray()) {
    if (!pos.makeMove(m)) {
      pos.unmakeMove();
      continue;
    }
    const replies = new MoveList();
    generateLegalMoves(pos, replies);
    let worst: number;
    if (replies.count === 0) {
      worst = 1;
    } else {
      worst = -Infinity;
      for (const r of replies.toArray()) {
        if (!pos.makeMove(r)) {
          pos.unmakeMove();
          continue;
        }
        const sub = forcedMateIn(pos, plies - 2);
        pos.unmakeMove();
        const v = sub === Infinity ? Infinity : sub + 2;
        if (v > worst) worst = v;
        if (worst === Infinity) break;
      }
    }
    pos.unmakeMove();
    if (worst === plies) out.push(m);
  }
  return out;
}

/** Number of legal moves — a cheap fixture sanity check. */
export function countLegal(pos: Position): number {
  const list = new MoveList();
  generateLegalMoves(pos, list);
  return list.count;
}
