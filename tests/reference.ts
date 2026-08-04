/**
 * A second, deliberately naive move generator.
 *
 * This exists to catch bugs in `src/engine/movegen.ts`, so it shares *nothing*
 * with it: its own FEN parser, its own board (a plain `number[]`), its own
 * geometry written straight from the rules text with no lookup tables, and
 * brute-force iteration over all 90x90 from/to pairs. It is roughly two orders
 * of magnitude slower and that is fine — a test that agrees with the code under
 * test because it *is* the code under test proves nothing.
 *
 * Two independent details matter most:
 *
 *   - Flying general is checked here as an explicit "same file, nothing in
 *     between" scan (`refGeneralsFace`), not by folding the general into the
 *     attack generator the way the engine does. If the engine's trick is wrong,
 *     the two disagree.
 *   - The horse's leg and the elephant's eye are recomputed from the move delta
 *     every time rather than read from a precomputed table, so a table build
 *     error cannot hide.
 *
 * Piece encoding matches `core/types.ts` (`side << 3 | type`) because the perft
 * comparison has to line up move-for-move, but nothing else is shared.
 */

export const RED = 0;
export const BLACK = 1;

export const T_GENERAL = 1;
export const T_ADVISOR = 2;
export const T_ELEPHANT = 3;
export const T_HORSE = 4;
export const T_CHARIOT = 5;
export const T_CANNON = 6;
export const T_SOLDIER = 7;

const LETTERS: Record<string, number> = {
  k: T_GENERAL,
  a: T_ADVISOR,
  b: T_ELEPHANT,
  n: T_HORSE,
  r: T_CHARIOT,
  c: T_CANNON,
  p: T_SOLDIER,
};

export interface RefPosition {
  cells: number[];
  side: number;
}

/** Independent FEN parse — no import from the engine. */
export function refParse(fen: string): RefPosition {
  const [boardPart, sidePart] = fen.trim().split(/\s+/);
  const rows = boardPart.split('/');
  if (rows.length !== 10) throw new Error(`reference: FEN needs 10 rows, got ${rows.length}`);
  const cells = new Array<number>(90).fill(0);
  for (let r = 0; r < 10; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '9') {
        f += ch.charCodeAt(0) - 48;
        continue;
      }
      const lower = ch.toLowerCase();
      const type = LETTERS[lower];
      if (type === undefined) throw new Error(`reference: unknown piece "${ch}"`);
      const side = ch === lower ? BLACK : RED;
      cells[r * 9 + f] = (side << 3) | type;
      f++;
    }
    if (f !== 9) throw new Error(`reference: row ${r} has ${f} files`);
  }
  return { cells, side: (sidePart ?? 'w') === 'b' ? BLACK : RED };
}

const file = (s: number) => s % 9;
const rank = (s: number) => Math.floor(s / 9);
const sideOf = (code: number) => code >> 3;
const typeOf = (code: number) => code & 7;

function inPalace(s: number, side: number): boolean {
  const f = file(s);
  const r = rank(s);
  if (f < 3 || f > 5) return false;
  return side === RED ? r >= 7 : r <= 2;
}

function onOwnHalf(s: number, side: number): boolean {
  const r = rank(s);
  return side === RED ? r >= 5 : r <= 4;
}

/** Occupied squares strictly between two squares on the same rank or file. */
function between(cells: number[], from: number, to: number): number {
  const df = file(to) - file(from);
  const dr = rank(to) - rank(from);
  if (df !== 0 && dr !== 0) return -1;
  const step = df !== 0 ? Math.sign(df) : Math.sign(dr) * 9;
  let n = 0;
  for (let s = from + step; s !== to; s += step) if (cells[s] !== 0) n++;
  return n;
}

/**
 * Pure geometry: could the piece on `from` reach `to`, ignoring whether `to`
 * holds a friendly piece? The cannon's answer depends on whether `to` is
 * occupied, which is exactly right for both movement and attack detection.
 */
export function refCanReach(cells: number[], from: number, to: number): boolean {
  if (from === to) return false;
  const piece = cells[from];
  if (piece === 0) return false;
  const side = sideOf(piece);
  const df = file(to) - file(from);
  const dr = rank(to) - rank(from);
  const adf = Math.abs(df);
  const adr = Math.abs(dr);

  switch (typeOf(piece)) {
    case T_GENERAL:
      // One orthogonal step, never leaving the palace.
      return inPalace(to, side) && adf + adr === 1;

    case T_ADVISOR:
      // One diagonal step, never leaving the palace.
      return inPalace(to, side) && adf === 1 && adr === 1;

    case T_ELEPHANT: {
      // Exactly two diagonal; the midpoint (象眼) must be empty; never crosses.
      if (adf !== 2 || adr !== 2) return false;
      if (!onOwnHalf(to, side)) return false;
      const eye = (rank(from) + dr / 2) * 9 + (file(from) + df / 2);
      return cells[eye] === 0;
    }

    case T_HORSE: {
      // One orthogonal then one diagonal outward; the orthogonal step (馬腿)
      // must be empty. The leg lies along whichever axis moves by two.
      if (!((adf === 1 && adr === 2) || (adf === 2 && adr === 1))) return false;
      const leg =
        adr === 2
          ? (rank(from) + dr / 2) * 9 + file(from)
          : rank(from) * 9 + (file(from) + df / 2);
      return cells[leg] === 0;
    }

    case T_CHARIOT:
      if (df !== 0 && dr !== 0) return false;
      return between(cells, from, to) === 0;

    case T_CANNON: {
      if (df !== 0 && dr !== 0) return false;
      const screens = between(cells, from, to);
      // Quiet moves need a clear line; a capture needs exactly one screen.
      return cells[to] === 0 ? screens === 0 : screens === 1;
    }

    case T_SOLDIER: {
      const forward = side === RED ? -1 : 1;
      if (df === 0 && dr === forward) return true;
      if (dr === 0 && adf === 1) return !onOwnHalf(from, side);
      return false;
    }

    default:
      return false;
  }
}

/** Geometry plus "the target is not one of my own pieces". */
export function refPseudoLegal(cells: number[], from: number, to: number): boolean {
  const piece = cells[from];
  if (piece === 0) return false;
  const target = cells[to];
  if (target !== 0 && sideOf(target) === sideOf(piece)) return false;
  return refCanReach(cells, from, to);
}

export function refGeneralSquare(cells: number[], side: number): number {
  for (let s = 0; s < 90; s++) {
    if (cells[s] !== 0 && typeOf(cells[s]) === T_GENERAL && sideOf(cells[s]) === side) return s;
  }
  return -1;
}

/** The two generals staring at each other down an open file — 對面笑. */
export function refGeneralsFace(cells: number[]): boolean {
  const r = refGeneralSquare(cells, RED);
  const b = refGeneralSquare(cells, BLACK);
  if (r < 0 || b < 0) return false;
  if (file(r) !== file(b)) return false;
  const lo = Math.min(r, b);
  const hi = Math.max(r, b);
  for (let s = lo + 9; s < hi; s += 9) if (cells[s] !== 0) return false;
  return true;
}

export function refInCheck(cells: number[], side: number): boolean {
  const g = refGeneralSquare(cells, side);
  if (g < 0) return false;
  for (let s = 0; s < 90; s++) {
    const p = cells[s];
    if (p === 0 || sideOf(p) === side) continue;
    if (refCanReach(cells, s, g)) return true;
  }
  return false;
}

/** A position is illegal if the mover's general is attacked or the two face. */
export function refIllegalFor(cells: number[], side: number): boolean {
  return refInCheck(cells, side) || refGeneralsFace(cells);
}

export interface RefMove {
  from: number;
  to: number;
}

/** Brute force over every from/to pair, then simulate for legality. */
export function refLegalMoves(cells: number[], side: number): RefMove[] {
  const out: RefMove[] = [];
  for (let from = 0; from < 90; from++) {
    const p = cells[from];
    if (p === 0 || sideOf(p) !== side) continue;
    for (let to = 0; to < 90; to++) {
      if (!refPseudoLegal(cells, from, to)) continue;
      const next = cells.slice();
      next[to] = next[from];
      next[from] = 0;
      if (refIllegalFor(next, side)) continue;
      out.push({ from, to });
    }
  }
  return out;
}

export function refPerft(cells: number[], side: number, depth: number): number {
  if (depth <= 0) return 1;
  const moves = refLegalMoves(cells, side);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) {
    const next = cells.slice();
    next[m.to] = next[m.from];
    next[m.from] = 0;
    n += refPerft(next, side ^ 1, depth - 1);
  }
  return n;
}

/** "from-to" keys, sorted — the canonical form for comparing two move sets. */
export function refMoveKeys(moves: RefMove[]): string[] {
  return moves.map((m) => `${m.from}-${m.to}`).sort();
}
