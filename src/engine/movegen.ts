/**
 * Move generation.
 *
 * Two layers, deliberately:
 *
 *   - `generateMoves` / `generateCaptures` produce *pseudo-legal* moves. They
 *     never test whether the mover's general ends up attacked, because inside
 *     the search most of those moves get cut off before anyone cares.
 *   - `generateLegalMoves` filters them through make/unmake. The UI calls this
 *     for hover highlights and it is what `rules.ts` adjudicates against.
 *
 * The legality filter is the *only* place legality lives. Flying general,
 * pinned pieces and check evasion are all one `Position.makeMove()` returning
 * false — there is no second implementation of the rule to drift out of sync.
 */

import {
  EMPTY,
  type Move,
  type PieceCode,
  PieceType,
  Side,
  encodeMove,
  makePiece,
  moveTo,
} from '@core/types.ts';
import type { Position } from './position.ts';
import {
  ADVISOR_STRIDE,
  ADVISOR_TO,
  ELEPHANT_EYE,
  ELEPHANT_STRIDE,
  ELEPHANT_TO,
  GENERAL_STRIDE,
  GENERAL_TO,
  HORSE_LEG,
  HORSE_N,
  HORSE_STRIDE,
  HORSE_TO,
  MAX_MOVES,
  N_SQ,
  RAY_LEN,
  RAY_STRIDE,
  RAY_SQ,
  SOLDIER_STRIDE,
  SOLDIER_TO,
  advisorCount,
  elephantCount,
  generalCount,
  soldierCount,
} from './tables.ts';

/**
 * A flat move buffer. One is allocated per search ply at startup and reused for
 * the life of the process, so the move loop never touches the heap.
 */
export class MoveList {
  readonly moves = new Int32Array(MAX_MOVES);
  /** Ordering scores, filled in by the search, not by the generator. */
  readonly scores = new Int32Array(MAX_MOVES);
  count = 0;

  clear(): void {
    this.count = 0;
  }

  add(m: Move): void {
    this.moves[this.count++] = m;
  }

  /** Copy out as a plain array — for the UI and tests, never for the search. */
  toArray(): Move[] {
    const out: Move[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) out[i] = this.moves[i];
    return out;
  }
}

function sideIdx(side: Side, s: number, stride: number, i: number): number {
  return ((side as number) * N_SQ + s) * stride + i;
}

// ---------------------------------------------------------------------------
// Pseudo-legal generation
// ---------------------------------------------------------------------------

/** All pseudo-legal moves for the side to move. */
export function generateMoves(pos: Position, list: MoveList): void {
  list.count = 0;
  const side = pos.side;
  const board = pos.board;

  genSteps(pos, list, board, makePiece(side, PieceType.General), side, GENERAL_TO, GENERAL_STRIDE, generalCount, false);
  genSteps(pos, list, board, makePiece(side, PieceType.Advisor), side, ADVISOR_TO, ADVISOR_STRIDE, advisorCount, false);
  genElephants(pos, list, board, side);
  genHorses(pos, list, board, side);
  genSliders(pos, list, board, side, PieceType.Chariot);
  genSliders(pos, list, board, side, PieceType.Cannon);
  genSteps(pos, list, board, makePiece(side, PieceType.Soldier), side, SOLDIER_TO, SOLDIER_STRIDE, soldierCount, false);
}

/** Captures only — the quiescence generator. */
export function generateCaptures(pos: Position, list: MoveList): void {
  list.count = 0;
  const side = pos.side;
  const board = pos.board;

  genSteps(pos, list, board, makePiece(side, PieceType.General), side, GENERAL_TO, GENERAL_STRIDE, generalCount, true);
  genSteps(pos, list, board, makePiece(side, PieceType.Advisor), side, ADVISOR_TO, ADVISOR_STRIDE, advisorCount, true);
  genElephantsCaptures(pos, list, board, side);
  genHorsesCaptures(pos, list, board, side);
  genSliderCaptures(pos, list, board, side, PieceType.Chariot);
  genSliderCaptures(pos, list, board, side, PieceType.Cannon);
  genSteps(pos, list, board, makePiece(side, PieceType.Soldier), side, SOLDIER_TO, SOLDIER_STRIDE, soldierCount, true);
}

type CountFn = (side: Side, s: number) => number;

/** General / advisor / soldier — one table lookup per target, no blockers. */
function genSteps(
  pos: Position,
  list: MoveList,
  board: Int8Array,
  code: PieceCode,
  side: Side,
  table: Int8Array,
  stride: number,
  count: CountFn,
  capturesOnly: boolean,
): void {
  const n = pos.countOf(code);
  const sideBits = (side as number) << 3;
  for (let p = 0; p < n; p++) {
    const from = pos.squareOf(code, p);
    const targets = count(side, from);
    for (let i = 0; i < targets; i++) {
      const to = table[sideIdx(side, from, stride, i)];
      const occupant = board[to];
      if (occupant !== EMPTY) {
        if ((occupant & 8) === sideBits) continue; // own piece
        list.add(encodeMove(from, to, occupant));
      } else if (!capturesOnly) {
        list.add(encodeMove(from, to, EMPTY));
      }
    }
  }
}

/** Elephant: two diagonal, 塞象眼 — the midpoint must be empty. */
function genElephants(pos: Position, list: MoveList, board: Int8Array, side: Side): void {
  const code = makePiece(side, PieceType.Elephant);
  const n = pos.countOf(code);
  const sideBits = (side as number) << 3;
  for (let p = 0; p < n; p++) {
    const from = pos.squareOf(code, p);
    const targets = elephantCount(side, from);
    for (let i = 0; i < targets; i++) {
      const idx = sideIdx(side, from, ELEPHANT_STRIDE, i);
      if (board[ELEPHANT_EYE[idx]] !== EMPTY) continue;
      const to = ELEPHANT_TO[idx];
      const occupant = board[to];
      if (occupant !== EMPTY && (occupant & 8) === sideBits) continue;
      list.add(encodeMove(from, to, occupant));
    }
  }
}

function genElephantsCaptures(pos: Position, list: MoveList, board: Int8Array, side: Side): void {
  const code = makePiece(side, PieceType.Elephant);
  const n = pos.countOf(code);
  const sideBits = (side as number) << 3;
  for (let p = 0; p < n; p++) {
    const from = pos.squareOf(code, p);
    const targets = elephantCount(side, from);
    for (let i = 0; i < targets; i++) {
      const idx = sideIdx(side, from, ELEPHANT_STRIDE, i);
      if (board[ELEPHANT_EYE[idx]] !== EMPTY) continue;
      const to = ELEPHANT_TO[idx];
      const occupant = board[to];
      if (occupant === EMPTY || (occupant & 8) === sideBits) continue;
      list.add(encodeMove(from, to, occupant));
    }
  }
}

/** Horse: 蹩馬腿 — the orthogonal leg square must be empty. */
function genHorses(pos: Position, list: MoveList, board: Int8Array, side: Side): void {
  const code = makePiece(side, PieceType.Horse);
  const n = pos.countOf(code);
  const sideBits = (side as number) << 3;
  for (let p = 0; p < n; p++) {
    const from = pos.squareOf(code, p);
    const targets = HORSE_N[from];
    for (let i = 0; i < targets; i++) {
      const idx = from * HORSE_STRIDE + i;
      if (board[HORSE_LEG[idx]] !== EMPTY) continue;
      const to = HORSE_TO[idx];
      const occupant = board[to];
      if (occupant !== EMPTY && (occupant & 8) === sideBits) continue;
      list.add(encodeMove(from, to, occupant));
    }
  }
}

function genHorsesCaptures(pos: Position, list: MoveList, board: Int8Array, side: Side): void {
  const code = makePiece(side, PieceType.Horse);
  const n = pos.countOf(code);
  const sideBits = (side as number) << 3;
  for (let p = 0; p < n; p++) {
    const from = pos.squareOf(code, p);
    const targets = HORSE_N[from];
    for (let i = 0; i < targets; i++) {
      const idx = from * HORSE_STRIDE + i;
      if (board[HORSE_LEG[idx]] !== EMPTY) continue;
      const to = HORSE_TO[idx];
      const occupant = board[to];
      if (occupant === EMPTY || (occupant & 8) === sideBits) continue;
      list.add(encodeMove(from, to, occupant));
    }
  }
}

/**
 * Chariot and cannon share the ray walk. The chariot captures the first piece
 * it meets if it is an enemy; the cannon slides to empty squares only, and
 * captures the first piece *beyond* exactly one screen of either colour.
 */
function genSliders(pos: Position, list: MoveList, board: Int8Array, side: Side, type: PieceType): void {
  const code = makePiece(side, type);
  const n = pos.countOf(code);
  const sideBits = (side as number) << 3;
  const isCannon = type === PieceType.Cannon;

  for (let p = 0; p < n; p++) {
    const from = pos.squareOf(code, p);
    for (let dir = 0; dir < 4; dir++) {
      const base = (from * 4 + dir) * RAY_STRIDE;
      const len = RAY_LEN[from * 4 + dir];
      let i = 0;
      // Quiet slides along the empty stretch — identical for both pieces.
      for (; i < len; i++) {
        const to = RAY_SQ[base + i];
        if (board[to] !== EMPTY) break;
        list.add(encodeMove(from, to, EMPTY));
      }
      if (i >= len) continue;

      if (!isCannon) {
        const to = RAY_SQ[base + i];
        const occupant = board[to];
        if ((occupant & 8) !== sideBits) list.add(encodeMove(from, to, occupant));
        continue;
      }

      // Cannon: the piece at `i` is the screen (any colour). Look for the next
      // occupied square beyond it — exactly one screen, no more, no fewer.
      for (i++; i < len; i++) {
        const to = RAY_SQ[base + i];
        const occupant = board[to];
        if (occupant === EMPTY) continue;
        if ((occupant & 8) !== sideBits) list.add(encodeMove(from, to, occupant));
        break;
      }
    }
  }
}

function genSliderCaptures(pos: Position, list: MoveList, board: Int8Array, side: Side, type: PieceType): void {
  const code = makePiece(side, type);
  const n = pos.countOf(code);
  const sideBits = (side as number) << 3;
  const isCannon = type === PieceType.Cannon;

  for (let p = 0; p < n; p++) {
    const from = pos.squareOf(code, p);
    for (let dir = 0; dir < 4; dir++) {
      const base = (from * 4 + dir) * RAY_STRIDE;
      const len = RAY_LEN[from * 4 + dir];
      let i = 0;
      for (; i < len; i++) if (board[RAY_SQ[base + i]] !== EMPTY) break;
      if (i >= len) continue;

      if (!isCannon) {
        const to = RAY_SQ[base + i];
        const occupant = board[to];
        if ((occupant & 8) !== sideBits) list.add(encodeMove(from, to, occupant));
        continue;
      }
      for (i++; i < len; i++) {
        const to = RAY_SQ[base + i];
        const occupant = board[to];
        if (occupant === EMPTY) continue;
        if ((occupant & 8) !== sideBits) list.add(encodeMove(from, to, occupant));
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Legal generation
// ---------------------------------------------------------------------------

const legalScratch = new MoveList();

/** Every legal move for the side to move. Mutates and restores `pos`. */
export function generateLegalMoves(pos: Position, list: MoveList): void {
  generateMoves(pos, legalScratch);
  list.count = 0;
  for (let i = 0; i < legalScratch.count; i++) {
    const m = legalScratch.moves[i];
    const ok = pos.makeMove(m);
    pos.unmakeMove();
    if (ok) list.add(m);
  }
}

/** Convenience wrapper for the UI: a plain array of legal moves. */
export function legalMoves(pos: Position): Move[] {
  const list = new MoveList();
  generateLegalMoves(pos, list);
  return list.toArray();
}

/** Legal destination squares for the piece standing on `from`. */
export function legalTargets(pos: Position, from: number): number[] {
  generateMoves(pos, legalScratch);
  const out: number[] = [];
  for (let i = 0; i < legalScratch.count; i++) {
    const m = legalScratch.moves[i];
    if ((m & 0x7f) !== from) continue;
    const ok = pos.makeMove(m);
    pos.unmakeMove();
    if (ok) out.push(moveTo(m));
  }
  return out;
}

/** Is this exact from/to pair legal right now? Returns the encoded move or 0. */
export function findLegalMove(pos: Position, from: number, to: number): Move {
  generateMoves(pos, legalScratch);
  for (let i = 0; i < legalScratch.count; i++) {
    const m = legalScratch.moves[i];
    if ((m & 0x7f) !== from || moveTo(m) !== to) continue;
    const ok = pos.makeMove(m);
    pos.unmakeMove();
    return ok ? m : 0;
  }
  return 0;
}

/** True when `pos` has at least one legal move. Cheaper than generating all. */
export function hasLegalMove(pos: Position): boolean {
  generateMoves(pos, legalScratch);
  for (let i = 0; i < legalScratch.count; i++) {
    const ok = pos.makeMove(legalScratch.moves[i]);
    pos.unmakeMove();
    if (ok) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Perft
// ---------------------------------------------------------------------------

const perftLists: MoveList[] = [];

/**
 * Node count of the legal move tree to `depth`. Counts leaves, so `perft(1)` is
 * the number of legal moves. Bulk counting at depth 1 would be wrong here
 * because legality still has to be filtered, so every level makes and unmakes.
 */
export function perft(pos: Position, depth: number): number {
  if (depth <= 0) return 1;
  while (perftLists.length < depth + 1) perftLists.push(new MoveList());
  return perftInner(pos, depth);
}

function perftInner(pos: Position, depth: number): number {
  const list = perftLists[depth];
  generateMoves(pos, list);
  let nodes = 0;
  for (let i = 0; i < list.count; i++) {
    const m = list.moves[i];
    if (pos.makeMove(m)) nodes += depth === 1 ? 1 : perftInner(pos, depth - 1);
    pos.unmakeMove();
  }
  return nodes;
}

/** Per-root-move split, the standard tool for hunting a perft mismatch. */
export function perftDivide(pos: Position, depth: number): { move: Move; nodes: number }[] {
  const out: { move: Move; nodes: number }[] = [];
  const list = new MoveList();
  generateMoves(pos, list);
  while (perftLists.length < depth + 1) perftLists.push(new MoveList());
  for (let i = 0; i < list.count; i++) {
    const m = list.moves[i];
    if (pos.makeMove(m)) out.push({ move: m, nodes: depth <= 1 ? 1 : perftInner(pos, depth - 1) });
    pos.unmakeMove();
  }
  return out;
}
