/**
 * Static exchange evaluation.
 *
 * Answers "if I capture on this square and both sides keep recapturing with
 * their cheapest available piece, what do I end up with?" — without searching.
 * Two uses, and they are the reason a xiangqi engine stops bleeding nodes on
 * recapture chains:
 *
 *   - Quiescence skips captures that SEE says lose material. A chariot taking a
 *     defended soldier is the canonical case, and without this the quiescence
 *     tree explodes on every such square.
 *   - Move ordering demotes losing captures below the killers, so the search
 *     stops trying them first just because the victim happened to be expensive.
 *
 * **The cannon is why this file exists rather than being twenty lines.** In
 * western chess the attacker set only shrinks as pieces come off, so the swap
 * can be driven by a static bitboard with x-ray updates. A xiangqi cannon needs
 * *exactly one* screen, so removing a piece can just as easily switch a cannon
 * on as off, and the attacker set is not monotone. The only honest way to
 * handle that is to re-derive the attackers from the mutated board on every
 * iteration, which is what `smallestAttacker` does. It is more expensive than
 * the bitboard trick, and it is correct.
 */

import { EMPTY, type Move, type PieceCode, PieceType, Side, moveFrom, moveTo, opposite } from '@core/types.ts';
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

/**
 * Exchange values, indexed by `PieceType`.
 *
 * These are the opening material values with one deliberate change: the general
 * is 6000 rather than 0. In the evaluation a general is worth nothing because
 * it is never captured; in an exchange it must be worth more than everything
 * else on the board, so that "recapture with the general" is only ever chosen
 * when nothing can punish it.
 */
export const SEE_VALUE = [0, 6000, 210, 220, 440, 900, 470, 100];

/**
 * Gain stack, and the undo trail for the in-place swap.
 *
 * `see()` mutates the caller's board and puts it back rather than working on a
 * copy: only the contested square and the successive attacker squares ever
 * change, and a typical exchange is two or three plies deep, so restoring three
 * squares is far cheaper than copying ninety on every call. Module level
 * because this runs inside quiescence.
 */
const gains = new Int32Array(32);
const trailSq = new Int32Array(32);
const trailCode = new Int32Array(32);

/**
 * The square of `side`'s least valuable piece that can capture on `sq`, or -1.
 *
 * Probes cheapest first and returns immediately, so the common case (a soldier
 * or advisor defends) costs almost nothing. The general is deliberately *not*
 * modelled as a vertical slider here — unlike `Position.isAttacked`, which
 * needs that trick for the flying-general rule, an exchange only cares about
 * captures a piece can actually make.
 */
export function smallestAttacker(board: Int8Array, sq: number, side: Side): number {
  const rank = (sq / 9) | 0;

  // --- soldier (100): adjacent, in a direction it can actually move
  for (let dir = 0; dir < 4; dir++) {
    if (RAY_LEN[sq * 4 + dir] === 0) continue;
    const from = RAY_SQ[(sq * 4 + dir) * RAY_STRIDE];
    const p = board[from];
    if (p === EMPTY || p >> 3 !== (side as number) || (p & 7) !== PieceType.Soldier) continue;
    if (side === Side.Red) {
      // A Red soldier advances toward rank 0, so it must be below `sq`.
      if (dir === 1) return from;
      if (dir >= 2 && rank <= 4) return from; // sideways, river crossed
    } else {
      if (dir === 0) return from;
      if (dir >= 2 && rank >= 5) return from;
    }
  }

  // --- advisor (210) and elephant (220): both only reach their own zone, so
  //     the table length is already zero everywhere else.
  const an = advisorCount(side, sq);
  for (let i = 0; i < an; i++) {
    const from = ADVISOR_TO[((side as number) * N_SQ + sq) * ADVISOR_STRIDE + i];
    const p = board[from];
    if (p !== EMPTY && p >> 3 === (side as number) && (p & 7) === PieceType.Advisor) return from;
  }
  const en = elephantCount(side, sq);
  for (let i = 0; i < en; i++) {
    const idx = ((side as number) * N_SQ + sq) * ELEPHANT_STRIDE + i;
    const from = ELEPHANT_TO[idx];
    const p = board[from];
    if (p === EMPTY || p >> 3 !== (side as number) || (p & 7) !== PieceType.Elephant) continue;
    if (board[ELEPHANT_EYE[idx]] === EMPTY) return from;
  }

  // --- horse (440)
  const hn = HORSE_ATK_N[sq];
  for (let i = 0; i < hn; i++) {
    const from = HORSE_ATK_FROM[sq * HORSE_STRIDE + i];
    const p = board[from];
    if (p === EMPTY || p >> 3 !== (side as number) || (p & 7) !== PieceType.Horse) continue;
    if (board[HORSE_ATK_LEG[sq * HORSE_STRIDE + i]] === EMPTY) return from;
  }

  // --- cannon (470) and chariot (900) share one ray walk; the general (6000)
  //     comes out of the same pass as an adjacent first blocker.
  let cannon = -1;
  let chariot = -1;
  let general = -1;
  for (let dir = 0; dir < 4; dir++) {
    const base = (sq * 4 + dir) * RAY_STRIDE;
    const len = RAY_LEN[sq * 4 + dir];
    let i = 0;
    let first = EMPTY;
    let firstSq = -1;
    for (; i < len; i++) {
      const s = RAY_SQ[base + i];
      const p = board[s];
      if (p !== EMPTY) {
        first = p;
        firstSq = s;
        i++;
        break;
      }
    }
    if (first === EMPTY) continue;
    if (first >> 3 === (side as number)) {
      const t = first & 7;
      if (t === PieceType.Chariot && chariot < 0) chariot = firstSq;
      else if (t === PieceType.General && i === 1 && general < 0) general = firstSq;
    }
    if (cannon >= 0) continue;
    for (; i < len; i++) {
      const s = RAY_SQ[base + i];
      const p = board[s];
      if (p === EMPTY) continue;
      if (p >> 3 === (side as number) && (p & 7) === PieceType.Cannon) cannon = s;
      break;
    }
  }
  if (cannon >= 0) return cannon;
  if (chariot >= 0) return chariot;
  return general;
}

/**
 * Material the side to move nets from playing `move`, in centipawns.
 *
 * Negative means the capture loses material against best play. Pins, discovered
 * attacks and the fact that a whole recapture may be illegal for reasons other
 * than the general's safety are outside what a static exchange can see — that
 * is what the search is for.
 *
 * The textbook version carries an early `break` when
 * `max(-gain[d-1], gain[d]) < 0`, on the grounds that "pruning does not
 * influence the result". It does, at d = 1: the fold that turns the gain stack
 * back into an answer never runs, and the function returns the raw victim value
 * as though the capture were free. That is exactly the case this is used to
 * detect, so the break is gone and the swap always runs to exhaustion — which
 * is two or three iterations in practice. `see.test.ts` pins the values against
 * an independent recursive swap-off over a real game.
 */
export function see(pos: Position, move: Move): number {
  const from = moveFrom(move);
  const to = moveTo(move);
  const board = pos.board;
  const victim: PieceCode = board[to];
  if (victim === EMPTY) return 0;

  let side = opposite(pos.side); // whoever recaptures first
  let attackerSq = from;
  let d = 0;
  let trail = 0;
  gains[0] = SEE_VALUE[victim & 7];

  for (;;) {
    const attacker = board[attackerSq];
    trailSq[trail] = attackerSq;
    trailCode[trail] = attacker;
    trail++;
    board[to] = attacker;
    board[attackerSq] = EMPTY;
    d++;
    gains[d] = SEE_VALUE[attacker & 7] - gains[d - 1];
    if (d >= 30) break;

    const next = smallestAttacker(board, to, side);
    if (next < 0) break;
    // A general may not capture onto a square the opponent still attacks — that
    // is not a bad exchange, it is an illegal move, so the sequence stops here.
    if ((board[next] & 7) === PieceType.General && smallestAttacker(board, to, opposite(side)) >= 0) {
      break;
    }
    attackerSq = next;
    side = opposite(side);
  }

  // Put the board back exactly as it was, newest change first.
  board[to] = victim;
  while (trail-- > 0) board[trailSq[trail]] = trailCode[trail];

  // Fold the stack back: at every level the side to move could have declined.
  while (--d > 0) gains[d - 1] = -Math.max(-gains[d - 1], gains[d]);
  return gains[0];
}

/**
 * True when `move` is a capture whose victim is cheaper than its attacker —
 * the only case where SEE can tell you anything MVV-LVA has not. Used to keep
 * SEE off the hot path for the great majority of captures.
 */
export function mayLoseMaterial(pos: Position, move: Move): boolean {
  const victim = (move >>> 14) & 0xf;
  if (victim === 0) return false;
  return SEE_VALUE[victim & 7] < SEE_VALUE[pos.board[move & 0x7f] & 7];
}
