/**
 * Terminal-state adjudication.
 *
 * Xiangqi differs from western chess in the two places that decide games:
 *
 *   1. **Stalemate is a loss.** A side with no legal move is 困斃 and loses.
 *      There is no draw-by-no-moves in xiangqi and getting it wrong changes the
 *      result of a large fraction of simple endings.
 *   2. **Perpetual check loses.** 長將 is a foul: the side that keeps checking
 *      forfeits. If both sides are perpetually checking, the game is drawn.
 *
 * Repetition is therefore not a draw condition on its own — it is a *trigger*
 * for a classification, and the classification has to look at what happened
 * inside the repeating cycle.
 */

import {
  EMPTY,
  type GameResult,
  type Move,
  ONGOING,
  PieceType,
  Side,
  moveFrom,
  moveTo,
  opposite,
} from '@core/types.ts';
import { MoveList, generateLegalMoves, hasLegalMove } from './movegen.ts';
import type { Position } from './position.ts';
import {
  ADVISOR_STRIDE,
  ADVISOR_TO,
  ELEPHANT_EYE,
  ELEPHANT_STRIDE,
  ELEPHANT_TO,
  HORSE_ATK_FROM,
  HORSE_ATK_LEG,
  HORSE_ATK_N,
  HORSE_STRIDE,
  N_SQ,
  RAY_LEN,
  RAY_STRIDE,
  RAY_SQ,
  advisorCount,
  elephantCount,
} from './tables.ts';

/** 120 plies — sixty full moves — without a capture is a draw. */
export const HALFMOVE_DRAW_LIMIT = 120;

/** How many occurrences of a position trigger adjudication. */
export const REPETITION_LIMIT = 3;

function result(kind: GameResult['kind'], winner: Side | null, reason: string): GameResult {
  return { kind, winner, reason };
}

/**
 * The full adjudication, in the order the rules apply it.
 *
 * Called by the game layer after every move. It is not cheap (it generates
 * legal moves and may replay a repetition cycle), and it is not called from
 * inside the search — the search uses `Position.repetitionVerdict()`.
 */
export function adjudicate(pos: Position): GameResult {
  // 1. No legal move: mated or stalemated, and both are a loss.
  if (!hasLegalMove(pos)) {
    const winner = opposite(pos.side);
    return pos.inCheck()
      ? result('checkmate', winner, '將死')
      : result('stalemate', winner, '困斃');
  }

  // 2. Bare general against bare general — nothing can ever happen.
  if (pos.bareGenerals()) {
    return result('insufficient', null, '雙方只餘將帥，和棋');
  }

  // 3. Repetition. Classified, not assumed drawn.
  if (pos.repetitionCount() >= REPETITION_LIMIT) {
    return classifyRepetition(pos);
  }

  // 4. Sixty full moves with nothing captured.
  if (pos.halfmove >= HALFMOVE_DRAW_LIMIT) {
    return result('sixty-move', null, '六十回合無吃子，和棋');
  }

  return ONGOING;
}

/** Convenience: is the side to move checkmated (in check, no legal move)? */
export function isCheckmate(pos: Position): boolean {
  return pos.inCheck() && !hasLegalMove(pos);
}

/** Convenience: is the side to move stalemated (not in check, no legal move)? */
export function isStalemate(pos: Position): boolean {
  return !pos.inCheck() && !hasLegalMove(pos);
}

export function legalMoveCount(pos: Position): number {
  const list = new MoveList();
  generateLegalMoves(pos, list);
  return list.count;
}

// ===========================================================================
// Repetition classification
// ===========================================================================

export interface RepetitionAnalysis {
  /** First ply of the repeating cycle. */
  start: number;
  perpetualCheck: [boolean, boolean];
  perpetualChase: [boolean, boolean];
}

/**
 * Classify a repetition into 長將 (perpetual check), 長捉 (perpetual chase) or
 * an ordinary draw.
 *
 * Precedence follows the rulebook: a side that is perpetually checking is
 * penalised ahead of one that is merely chasing, and mutual fouls of the same
 * kind cancel into a draw.
 */
export function classifyRepetition(pos: Position): GameResult {
  const a = analyseRepetition(pos);
  if (!a) return result('repetition-draw', null, '重複局面，和棋');

  const [redCheck, blackCheck] = a.perpetualCheck;
  if (redCheck !== blackCheck) {
    const loser = redCheck ? Side.Red : Side.Black;
    return result('perpetual-check', opposite(loser), '長將判負');
  }
  if (redCheck && blackCheck) {
    return result('repetition-draw', null, '雙方長將，和棋');
  }

  const [redChase, blackChase] = a.perpetualChase;
  if (redChase !== blackChase) {
    const loser = redChase ? Side.Red : Side.Black;
    return result('perpetual-chase', opposite(loser), '長捉判負');
  }

  return result('repetition-draw', null, '重複局面，和棋');
}

/** Null when the current position is not a repetition. */
export function analyseRepetition(pos: Position): RepetitionAnalysis | null {
  const start = pos.firstRepetitionPly();
  if (start < 0) return null;

  // --- perpetual check: every move a side made inside the cycle gave check.
  let redMoves = 0;
  let blackMoves = 0;
  let redChecks = 0;
  let blackChecks = 0;
  for (let i = start; i < pos.ply; i++) {
    const mover = ((pos.side as number) + (pos.ply - i)) & 1;
    if (mover === (Side.Red as number)) {
      redMoves++;
      if (pos.checkAt(i)) redChecks++;
    } else {
      blackMoves++;
      if (pos.checkAt(i)) blackChecks++;
    }
  }

  const perpetualCheck: [boolean, boolean] = [
    redMoves > 0 && redChecks === redMoves,
    blackMoves > 0 && blackChecks === blackMoves,
  ];

  return {
    start,
    perpetualCheck,
    perpetualChase: analyseChase(pos, start),
  };
}

// ---------------------------------------------------------------------------
// Perpetual chase (長捉)
// ---------------------------------------------------------------------------

/**
 * Chase detection — an explicit approximation. What it does:
 *
 *   Replay the repeating cycle move by move, tracking every piece by identity
 *   (the cycle can contain no captures — material would differ and the position
 *   could not repeat — so identities only ever move). After each move by side S
 *   we compute the set of enemy pieces that S is *threatening*: attacked by a
 *   non-exempt attacker, not defended by their own side. S is judged a
 *   perpetual chaser when the intersection of those sets across every one of
 *   its moves in the cycle is non-empty — i.e. one specific enemy piece was
 *   hounded from the first move of the cycle to the last.
 *
 *   Exemptions follow the rulebook's easy half: the general and the soldiers
 *   may chase freely, and a soldier may be chased freely.
 *
 * What it deliberately does NOT do, so nobody mistakes it for the full 中國象棋
 * 競賽規則 arbitration:
 *
 *   - "Adequately protected" is approximated as "defended by anything at all".
 *     The real rule is an exchange evaluation, so chasing a chariot defended
 *     only by another chariot's worth of counterplay is scored as legal here
 *     when a referee would call it a foul, and vice versa.
 *   - It does not distinguish 捉 from 兌 (offering an exchange), 邀 (invitation)
 *     or 献 (sacrifice). A "chase" of a piece that is itself attacking the
 *     chaser is still counted as a chase.
 *   - 長攔 (perpetual blocking), 長跟 (perpetual following) and 長獻 are not
 *     detected at all.
 *   - A chase that only becomes real because the target is pinned or otherwise
 *     immobile is not recognised; conversely a target that can simply step away
 *     with tempo is still counted.
 *   - It fires only once a position has occurred three times, whereas a referee
 *     may intervene earlier.
 *
 * In practice this catches the common repetitive chariot- and cannon-chases
 * that a search would otherwise happily shuffle into, and it never fires on an
 * ordinary quiet repetition.
 */
function analyseChase(pos: Position, start: number): [boolean, boolean] {
  const span = pos.ply - start;
  if (span <= 0) return [false, false];

  // Snapshot the cycle's moves, rewind, then walk forward tracking identities.
  const moves: Move[] = new Array(span);
  for (let i = 0; i < span; i++) moves[i] = pos.moveAt(start + i);
  for (let i = 0; i < span; i++) pos.unmakeMove();

  // Identity map: id per occupied square, stable as pieces slide around.
  const idAt = new Int8Array(N_SQ).fill(-1);
  let nextId = 0;
  for (let s = 0; s < N_SQ; s++) if (pos.board[s] !== EMPTY) idAt[s] = nextId++;

  // Running intersection of threatened ids, per side. `null` = not yet seeded.
  let redSet: Set<number> | null = null;
  let blackSet: Set<number> | null = null;
  let redMoves = 0;
  let blackMoves = 0;

  const scratch = new Set<number>();

  for (let i = 0; i < span; i++) {
    const m = moves[i];
    const mover = pos.side;
    const from = moveFrom(m);
    const to = moveTo(m);
    pos.makeMove(m);
    // No captures inside a repetition cycle, so `to` was empty.
    idAt[to] = idAt[from];
    idAt[from] = -1;

    collectThreats(pos, mover, idAt, scratch);
    if (mover === Side.Red) {
      redMoves++;
      redSet = intersect(redSet, scratch);
    } else {
      blackMoves++;
      blackSet = intersect(blackSet, scratch);
    }
  }

  // Rewind and replay so the caller's position is byte-identical to before.
  for (let i = 0; i < span; i++) pos.unmakeMove();
  for (let i = 0; i < span; i++) pos.makeMove(moves[i]);

  return [
    redMoves > 0 && redSet !== null && redSet.size > 0,
    blackMoves > 0 && blackSet !== null && blackSet.size > 0,
  ];
}

function intersect(acc: Set<number> | null, next: Set<number>): Set<number> {
  if (acc === null) return new Set(next);
  for (const id of [...acc]) if (!next.has(id)) acc.delete(id);
  return acc;
}

/** Enemy pieces that `by` currently threatens in the 捉 sense. */
function collectThreats(pos: Position, by: Side, idAt: Int8Array, out: Set<number>): void {
  out.clear();
  const enemy = opposite(by);
  for (let s = 0; s < N_SQ; s++) {
    const code = pos.board[s];
    if (code === EMPTY || code >> 3 !== (enemy as number)) continue;
    const type = code & 7;
    // The general is handled by the perpetual-*check* rule; soldiers may be
    // chased freely.
    if (type === PieceType.General || type === PieceType.Soldier) continue;
    if (!chaseAttacks(pos, s, by)) continue;
    // Adequately protected is approximated as "defended at all".
    if (pos.isAttacked(s, enemy)) continue;
    out.add(idAt[s]);
  }
}

/**
 * Like `Position.isAttacked` but ignoring the pieces that the rules allow to
 * chase freely: the general and the soldiers. Adjudication-only, so clarity
 * beats speed here.
 */
function chaseAttacks(pos: Position, sq: number, by: Side): boolean {
  const board = pos.board;
  const bySide = by as number;

  for (let dir = 0; dir < 4; dir++) {
    const base = (sq * 4 + dir) * RAY_STRIDE;
    const len = RAY_LEN[sq * 4 + dir];
    let i = 0;
    let first = EMPTY;
    for (; i < len; i++) {
      const p = board[RAY_SQ[base + i]];
      if (p !== EMPTY) {
        first = p;
        i++;
        break;
      }
    }
    if (first === EMPTY) continue;
    if (first >> 3 === bySide && (first & 7) === PieceType.Chariot) return true;
    for (; i < len; i++) {
      const p = board[RAY_SQ[base + i]];
      if (p === EMPTY) continue;
      if (p >> 3 === bySide && (p & 7) === PieceType.Cannon) return true;
      break;
    }
  }

  const hn = HORSE_ATK_N[sq];
  for (let i = 0; i < hn; i++) {
    const h = HORSE_ATK_FROM[sq * HORSE_STRIDE + i];
    const p = board[h];
    if (p === EMPTY || p >> 3 !== bySide || (p & 7) !== PieceType.Horse) continue;
    if (board[HORSE_ATK_LEG[sq * HORSE_STRIDE + i]] === EMPTY) return true;
  }

  const an = advisorCount(by, sq);
  for (let i = 0; i < an; i++) {
    const p = board[ADVISOR_TO[(bySide * N_SQ + sq) * ADVISOR_STRIDE + i]];
    if (p !== EMPTY && p >> 3 === bySide && (p & 7) === PieceType.Advisor) return true;
  }

  const en = elephantCount(by, sq);
  for (let i = 0; i < en; i++) {
    const idx = (bySide * N_SQ + sq) * ELEPHANT_STRIDE + i;
    const p = board[ELEPHANT_TO[idx]];
    if (p === EMPTY || p >> 3 !== bySide || (p & 7) !== PieceType.Elephant) continue;
    if (board[ELEPHANT_EYE[idx]] === EMPTY) return true;
  }

  return false;
}
