/**
 * Traditional relative notation (棋譜記法), both directions.
 *
 * The form is four characters: piece, which piece, how it moves, where to.
 *
 *   炮二平五   the cannon on Red's file 2 moves sideways to file 5
 *   馬８進７   the horse on Black's file 8 advances to file 7
 *   前車進一   the front one of two chariots on the same file advances one rank
 *
 * Two conventions do the work and both come from `core/coords.ts`:
 *   - Red names files right-to-left with Chinese numerals (九 八 七 … 一), and
 *     Black names them left-to-right with full-width digits (１ … ９). Each side
 *     counts from its own right, which is why they run in opposite directions.
 *   - 進 is always "toward the enemy" and 退 "toward home", so the same word
 *     means opposite board directions for the two armies.
 *
 * The diagonal movers (馬 相/象 仕/士) can never move along a rank, so their
 * last character is the destination *file*, not a distance. The straight movers
 * (車 炮 兵/卒 帥/將) use a distance for 進/退 and a destination file for 平.
 */

import { BLACK_FILE_NAMES, RED_FILE_NAMES, fileOf, numeral, rankOf } from '@core/coords.ts';
import { GLYPH, type Move, PieceType, Side, moveFrom, moveTo } from '@core/types.ts';
import { squareToIccs, iccsToSquare } from './fen.ts';
import { MoveList, generateLegalMoves } from './movegen.ts';
import type { Position } from './position.ts';

const ADVANCE = '進';
const RETREAT = '退';
const TRAVERSE = '平';

/** Front-to-back markers when several identical pieces share a file. */
const FRONT = '前';
const MIDDLE = '中';
const REAR = '後';

function fileNameFor(file: number, side: Side): string {
  return side === Side.Red ? RED_FILE_NAMES[file] : BLACK_FILE_NAMES[file];
}

/** True when moving from `a` to `b` goes toward the enemy for `side`. */
function isAdvance(side: Side, fromRank: number, toRank: number): boolean {
  return side === Side.Red ? toRank < fromRank : toRank > fromRank;
}

/**
 * Order the friendly pieces of the same code standing on one file, front first.
 * "Front" means nearest the enemy, which is the lower rank for Red and the
 * higher rank for Black.
 */
function stackOnFile(pos: Position, code: number, file: number, side: Side): number[] {
  const out: number[] = [];
  const n = pos.countOf(code);
  for (let i = 0; i < n; i++) {
    const s = pos.squareOf(code, i);
    if (fileOf(s) === file) out.push(s);
  }
  out.sort((a, b) => (side === Side.Red ? rankOf(a) - rankOf(b) : rankOf(b) - rankOf(a)));
  return out;
}

export function moveToNotation(pos: Position, m: Move): string {
  const from = moveFrom(m);
  const to = moveTo(m);
  const code = pos.board[from];
  if (code === 0) return moveToIccs(m);

  const side: Side = (code >> 3) as Side;
  const type = (code & 7) as PieceType;
  const glyph = GLYPH[side][type];

  const fromFile = fileOf(from);
  const fromRank = rankOf(from);
  const toFile = fileOf(to);
  const toRank = rankOf(to);

  // --- which piece
  const stack = stackOnFile(pos, code, fromFile, side);
  let subject: string;
  if (stack.length <= 1) {
    subject = glyph + fileNameFor(fromFile, side);
  } else {
    const idx = stack.indexOf(from);
    if (stack.length === 2) {
      subject = (idx === 0 ? FRONT : REAR) + glyph;
    } else if (stack.length === 3) {
      subject = (idx === 0 ? FRONT : idx === 1 ? MIDDLE : REAR) + glyph;
    } else {
      // Four or five soldiers on one file. Modern practice numbers them from
      // the front; we keep 前/後 for the extremes so the common cases read the
      // way a printed 棋譜 does.
      subject =
        (idx === 0 ? FRONT : idx === stack.length - 1 ? REAR : numeral(idx + 1, side)) + glyph;
    }
  }

  // --- how it moves and where to
  const diagonal =
    type === PieceType.Horse || type === PieceType.Elephant || type === PieceType.Advisor;

  if (diagonal) {
    const dir = isAdvance(side, fromRank, toRank) ? ADVANCE : RETREAT;
    return subject + dir + fileNameFor(toFile, side);
  }

  if (fromRank === toRank) return subject + TRAVERSE + fileNameFor(toFile, side);

  const dir = isAdvance(side, fromRank, toRank) ? ADVANCE : RETREAT;
  return subject + dir + numeral(Math.abs(toRank - fromRank), side);
}

/**
 * Parse notation back into a move by formatting every legal move and matching.
 *
 * That sounds lazy and is in fact the robust choice: a hand-written parser has
 * to re-derive the disambiguation rules (前/後/中, the diagonal movers' file
 * suffix, both file-naming directions) and any disagreement with the formatter
 * shows up as a move that round-trips wrong. Generating and comparing makes the
 * two directions provably consistent, and the cost — one legal move generation
 * per parse — is irrelevant outside the search.
 *
 * Returns 0 when nothing matches. ICCS ("h2e2") is accepted too.
 */
export function parseNotation(pos: Position, text: string): Move {
  const trimmed = text.trim();
  if (/^[a-i][0-9][a-i][0-9]$/.test(trimmed)) {
    return iccsToMove(pos, trimmed);
  }
  const list = new MoveList();
  generateLegalMoves(pos, list);
  for (let i = 0; i < list.count; i++) {
    if (moveToNotation(pos, list.moves[i]) === trimmed) return list.moves[i];
  }
  return 0;
}

/** Format a whole line, applying each move as it goes. Restores the position. */
export function lineToNotation(pos: Position, moves: readonly Move[]): string[] {
  const out: string[] = [];
  let applied = 0;
  for (const m of moves) {
    if (pos.board[moveFrom(m)] === 0) break;
    out.push(moveToNotation(pos, m));
    if (!pos.makeMove(m)) {
      pos.unmakeMove();
      break;
    }
    applied++;
  }
  for (let i = 0; i < applied; i++) pos.unmakeMove();
  return out;
}

// ---------------------------------------------------------------------------
// ICCS coordinate notation — used by the opening book and by tests
// ---------------------------------------------------------------------------

export function moveToIccs(m: Move): string {
  return squareToIccs(moveFrom(m)) + squareToIccs(moveTo(m));
}

/** Resolve "h2e2" against the current position. Returns 0 if it is not legal. */
export function iccsToMove(pos: Position, text: string): Move {
  const from = iccsToSquare(text.slice(0, 2));
  const to = iccsToSquare(text.slice(2, 4));
  const list = new MoveList();
  generateLegalMoves(pos, list);
  for (let i = 0; i < list.count; i++) {
    const m = list.moves[i];
    if (moveFrom(m) === from && moveTo(m) === to) return m;
  }
  return 0;
}

export { squareToIccs, iccsToSquare };
