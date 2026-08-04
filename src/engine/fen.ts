/**
 * Xiangqi FEN.
 *
 * The layout is the one every Chinese-chess GUI and engine uses:
 *
 *   <board> <side> <castling> <ep> <halfmove> <fullmove>
 *
 * The two middle fields are inherited from western FEN and carry no meaning
 * here; they are parsed permissively and always written as `- -`.
 *
 * Piece letters keep the western mnemonic so a FEN can be pasted between tools:
 *   k general   a advisor   b elephant   n horse   r chariot   c cannon   p soldier
 * Uppercase is Red, lowercase is Black.
 *
 * Row order: the first board row in the string is rank 0 — Black's back rank —
 * which is exactly the project's square numbering (`rank * 9 + file`, rank 0 at
 * -Z). No flipping anywhere.
 */

import { NUM_SQUARES, fileOf, rankOf } from '@core/coords.ts';
import { EMPTY, PieceType, Side, makePiece, pieceSide, pieceType } from '@core/types.ts';

const LETTER_TO_TYPE: Record<string, PieceType> = {
  k: PieceType.General,
  a: PieceType.Advisor,
  b: PieceType.Elephant,
  e: PieceType.Elephant, // some tools write 'e' for the elephant
  n: PieceType.Horse,
  h: PieceType.Horse, // ...and 'h' for the horse
  r: PieceType.Chariot,
  c: PieceType.Cannon,
  p: PieceType.Soldier,
};

const TYPE_TO_LETTER: Record<PieceType, string> = {
  [PieceType.None]: '',
  [PieceType.General]: 'k',
  [PieceType.Advisor]: 'a',
  [PieceType.Elephant]: 'b',
  [PieceType.Horse]: 'n',
  [PieceType.Chariot]: 'r',
  [PieceType.Cannon]: 'c',
  [PieceType.Soldier]: 'p',
};

export interface ParsedFen {
  /** 90 piece codes, index `rank * 9 + file`. */
  cells: Int8Array;
  side: Side;
  /** Plies since the last capture. A xiangqi draw is 120 of these. */
  halfmove: number;
  fullmove: number;
}

export class FenError extends Error {}

export function parseFen(fen: string): ParsedFen {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 2) throw new FenError(`FEN needs at least a board and a side: "${fen}"`);

  const rows = parts[0].split('/');
  if (rows.length !== 10) throw new FenError(`FEN board must have 10 rows, got ${rows.length}`);

  const cells = new Int8Array(NUM_SQUARES);
  for (let r = 0; r < 10; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '9') {
        f += ch.charCodeAt(0) - 48;
        continue;
      }
      const lower = ch.toLowerCase();
      const type = LETTER_TO_TYPE[lower];
      if (type === undefined) throw new FenError(`unknown FEN piece "${ch}"`);
      if (f > 8) throw new FenError(`FEN row ${r} overflows the board`);
      cells[r * 9 + f] = makePiece(ch === lower ? Side.Black : Side.Red, type);
      f++;
    }
    if (f !== 9) throw new FenError(`FEN row ${r} describes ${f} files, expected 9`);
  }

  const sideToken = parts[1].toLowerCase();
  // 'w' is the conventional token for Red in xiangqi FEN; 'r' is also seen.
  const side = sideToken === 'b' ? Side.Black : Side.Red;
  if (sideToken !== 'b' && sideToken !== 'w' && sideToken !== 'r') {
    throw new FenError(`unknown side-to-move token "${parts[1]}"`);
  }

  const halfmove = parts.length >= 5 ? clampInt(parts[4], 0) : 0;
  const fullmove = parts.length >= 6 ? Math.max(1, clampInt(parts[5], 1)) : 1;

  return { cells, side, halfmove, fullmove };
}

function clampInt(token: string, fallback: number): number {
  const v = Number.parseInt(token, 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Everything `formatFen` needs, so this module never imports `Position`. */
export interface FenSource {
  readonly board: Int8Array;
  readonly side: Side;
  readonly halfmove: number;
  readonly fullmove: number;
}

export function formatFen(pos: FenSource): string {
  const rows: string[] = [];
  for (let r = 0; r < 10; r++) {
    let row = '';
    let gap = 0;
    for (let f = 0; f < 9; f++) {
      const code = pos.board[r * 9 + f];
      if (code === EMPTY) {
        gap++;
        continue;
      }
      if (gap) {
        row += String(gap);
        gap = 0;
      }
      const letter = TYPE_TO_LETTER[pieceType(code)];
      row += pieceSide(code) === Side.Red ? letter.toUpperCase() : letter;
    }
    if (gap) row += String(gap);
    rows.push(row);
  }
  return `${rows.join('/')} ${pos.side === Side.Red ? 'w' : 'b'} - - ${pos.halfmove} ${pos.fullmove}`;
}

/** Human-readable board dump; used by test failure messages, not by the game. */
export function debugBoard(pos: FenSource): string {
  const lines: string[] = [];
  for (let r = 0; r < 10; r++) {
    let line = `${r} `;
    for (let f = 0; f < 9; f++) {
      const code = pos.board[r * 9 + f];
      if (code === EMPTY) {
        line += ' .';
        continue;
      }
      const letter = TYPE_TO_LETTER[pieceType(code)];
      line += ' ' + (pieceSide(code) === Side.Red ? letter.toUpperCase() : letter);
    }
    lines.push(line);
  }
  lines.push('   a b c d e f g h i   (file 0..8)');
  lines.push(`side to move: ${pos.side === Side.Red ? 'Red' : 'Black'}`);
  return lines.join('\n');
}

/** Square index from ICCS coordinates, e.g. "h2" — file a..i, row 0..9 from Red's side. */
export function iccsToSquare(text: string): number {
  const f = text.charCodeAt(0) - 97;
  const row = text.charCodeAt(1) - 48;
  if (f < 0 || f > 8 || row < 0 || row > 9) throw new FenError(`bad ICCS square "${text}"`);
  return (9 - row) * 9 + f;
}

export function squareToIccs(s: number): string {
  return String.fromCharCode(97 + fileOf(s)) + String(9 - rankOf(s));
}
