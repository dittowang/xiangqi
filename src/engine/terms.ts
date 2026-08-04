/**
 * Incrementally-maintained evaluation terms.
 *
 * The material and piece-square terms used to be a loop over the piece lists at
 * every leaf. They are now four running sums that `Position` updates inside
 * make/unmake, because those two terms are the only ones that change by a
 * bounded amount when a single piece moves — and a leaf evaluation that does
 * not have to walk the board is roughly twice as fast.
 *
 * This module exists so `position.ts` can maintain the sums without importing
 * `eval.ts` (which imports `Position`). It owns the numbers; `eval.ts` owns what
 * is done with them.
 *
 * Everything here is Red-positive: a Black piece contributes a negative amount,
 * so the sums are already "Red minus Black" and the evaluation never has to
 * branch on colour.
 */

import { PieceType, Side } from '@core/types.ts';
import { N_SQ, mirrorSquare } from './tables.ts';

/**
 * Indexed by `PieceType`. The classical relative scale is 車9 馬4.5 砲4.5 仕2
 * 相2 兵1; the numbers below are that scale in centipawns with two deliberate
 * departures, both standard among strong xiangqi engines:
 *
 *   - The chariot is pushed past 9 soldiers (900 vs 100) because a xiangqi
 *     soldier is much weaker than a western pawn before it crosses — but kept
 *     just under cannon + horse together, which is the exchange the traditional
 *     scale calls level.
 *   - Cannon and horse are *not* equal. The cannon opens above the horse (470
 *     vs 440) because the board is full of screens, and ends well below it (410
 *     vs 470) because an empty board leaves it nothing to fire over. That
 *     crossover is the single most useful thing the phase taper buys.
 *
 * The general is worth zero: it is never captured, and giving it a value would
 * only pollute the material balance in bare-general endings.
 */
export const MATERIAL_OPENING = [0, 0, 210, 220, 440, 900, 470, 100];
export const MATERIAL_ENDGAME = [0, 0, 240, 230, 470, 940, 410, 100];

/** Extra value a soldier gains the moment it is over the river. */
export const SOLDIER_CROSSED = 90;
/** Extra again once it is on one of the enemy's last three ranks. */
export const SOLDIER_DEEP = 45;


/**
 * Only the three attacking types drive the phase; shells and soldiers do not.
 * These weights are deliberately *not* the material values — they are a fixed
 * yardstick for "how much is still on the board", and tying them to the tapered
 * values would make the taper depend on itself.
 */
export const PHASE_CHARIOT = 900;
export const PHASE_CANNON = 470;
export const PHASE_HORSE = 400;
export const PHASE_MAX = 2 * (2 * PHASE_CHARIOT + 2 * PHASE_CANNON + 2 * PHASE_HORSE);


/**
 * Authored as ten rows of nine, top to bottom, from Red's seat — so the first
 * row is Black's back rank (rank 0) and the last is Red's own (rank 9). Values
 * describe a RED piece; Black's are read through `mirrorSquare`.
 *
 * Every table is left-right symmetric, which is why a rank flip is a sufficient
 * mirror and no file reversal is needed.
 */
function table(rows: number[][]): Int16Array {
  const t = new Int16Array(N_SQ);
  for (let r = 0; r < 10; r++) for (let f = 0; f < 9; f++) t[r * 9 + f] = rows[r][f];
  return t;
}

const Z9 = [0, 0, 0, 0, 0, 0, 0, 0, 0];

/**
 * Soldier. Nothing before the river (the material term already pays for the
 * crossing); then a steep climb, peaking on the enemy's second rank where a
 * soldier attacks the palace. The last rank is worth *less* than the second:
 * a soldier that has run to the back can only shuffle sideways.
 */
const PST_SOLDIER = table([
  [0, 3, 6, 9, 12, 9, 6, 3, 0],
  [16, 32, 52, 74, 84, 74, 52, 32, 16],
  [14, 26, 42, 60, 68, 60, 42, 26, 14],
  [10, 18, 28, 38, 46, 38, 28, 18, 10],
  [6, 10, 16, 22, 28, 22, 16, 10, 6],
  [2, 2, 8, 8, 12, 8, 8, 2, 2],
  [0, 0, 4, 4, 6, 4, 4, 0, 0],
  Z9,
  Z9,
  Z9,
]);

/**
 * Horse. Centralisation and a hatred of the rim — a horse on file 0 or 8 has
 * half its moves cut off before the leg is even considered. The gradient also
 * pushes it forward: a horse that never crosses the river never attacks
 * anything. The back-rank negatives are what make 馬八進七 look attractive.
 */
const PST_HORSE = table([
  [0, 4, 8, 12, 14, 12, 8, 4, 0],
  [4, 10, 18, 24, 26, 24, 18, 10, 4],
  [8, 16, 26, 32, 34, 32, 26, 16, 8],
  [10, 20, 30, 36, 38, 36, 30, 20, 10],
  [10, 20, 30, 36, 38, 36, 30, 20, 10],
  [8, 18, 26, 32, 34, 32, 26, 18, 8],
  [6, 14, 22, 26, 28, 26, 22, 14, 6],
  [2, 8, 14, 18, 20, 18, 14, 8, 2],
  [-4, 2, 6, 10, 12, 10, 6, 2, -4],
  [-10, -4, 0, 4, 6, 4, 0, -4, -10],
]);

/**
 * Chariot. Wants the centre files (they are the ones that open first) and the
 * enemy's second rank, the classic 車 infiltration square. The gradient is
 * gentle everywhere else because a chariot's real value is mobility, and the
 * mobility term already measures that directly.
 */
const PST_CHARIOT = table([
  [12, 16, 18, 22, 24, 22, 18, 16, 12],
  [16, 22, 24, 30, 34, 30, 24, 22, 16],
  [12, 16, 18, 24, 26, 24, 18, 16, 12],
  [10, 14, 16, 20, 22, 20, 16, 14, 10],
  [8, 12, 14, 18, 20, 18, 14, 12, 8],
  [8, 12, 14, 18, 20, 18, 14, 12, 8],
  [6, 10, 12, 14, 16, 14, 12, 10, 6],
  [4, 8, 10, 12, 14, 12, 10, 8, 4],
  [0, 4, 6, 8, 10, 8, 6, 4, 0],
  [-2, 2, 4, 8, 10, 8, 4, 2, -2],
]);

/**
 * Cannon. The one spike is rank 7, file 4 — the 炮二平五 central-cannon square,
 * where the piece sits on its own third rank behind a friendly soldier screen
 * and stares straight down the enemy's general file. Beyond that it prefers the
 * centre files and the enemy's back two ranks (the 沉底炮 squares).
 */
const PST_CANNON = table([
  [4, 6, 10, 14, 16, 14, 10, 6, 4],
  [4, 6, 10, 14, 16, 14, 10, 6, 4],
  [2, 4, 8, 12, 14, 12, 8, 4, 2],
  [2, 4, 6, 10, 12, 10, 6, 4, 2],
  [0, 2, 4, 8, 10, 8, 4, 2, 0],
  [0, 2, 4, 8, 10, 8, 4, 2, 0],
  [0, 2, 4, 8, 12, 8, 4, 2, 0],
  [2, 4, 6, 10, 18, 10, 6, 4, 2],
  [2, 4, 6, 8, 12, 8, 6, 4, 2],
  [0, 2, 4, 6, 8, 6, 4, 2, 0],
]);

/** Elephant. Seven legal squares; the central 相三進五 point is worth double. */
const PST_ELEPHANT = table([
  Z9,
  Z9,
  Z9,
  Z9,
  Z9,
  [0, 0, 6, 0, 0, 0, 6, 0, 0],
  Z9,
  [2, 0, 0, 0, 12, 0, 0, 0, 2],
  Z9,
  [0, 0, 4, 0, 0, 0, 4, 0, 0],
]);

/** Advisor. Five squares; the palace centre is the only one that guards both. */
const PST_ADVISOR = table([
  Z9,
  Z9,
  Z9,
  Z9,
  Z9,
  Z9,
  Z9,
  [0, 0, 0, 2, 0, 2, 0, 0, 0],
  [0, 0, 0, 0, 8, 0, 0, 0, 0],
  [0, 0, 0, 4, 0, 4, 0, 0, 0],
]);

/** General. Home is safest; stepping up the palace exposes it to a chariot. */
const PST_GENERAL = table([
  Z9,
  Z9,
  Z9,
  Z9,
  Z9,
  Z9,
  Z9,
  [0, 0, 0, -6, -8, -6, 0, 0, 0],
  [0, 0, 0, -2, -4, -2, 0, 0, 0],
  [0, 0, 0, 2, 6, 2, 0, 0, 0],
]);

export const PST: (Int16Array | null)[] = [
  null,
  PST_GENERAL,
  PST_ADVISOR,
  PST_ELEPHANT,
  PST_HORSE,
  PST_CHARIOT,
  PST_CANNON,
  PST_SOLDIER,
];


// ---------------------------------------------------------------------------
// Flat per-(piece code, square) delta tables
// ---------------------------------------------------------------------------

/**
 * One entry per (piece code, square). `Position` adds these on placement and
 * subtracts them on removal, so a move costs four subtractions and four
 * additions instead of a thirty-piece loop with a lerp per piece.
 *
 * The two material tables are kept separate rather than pre-blended because the
 * phase is not known until evaluation time — that is the whole point of the
 * taper. Blending two scalars once per leaf is free; blending them per piece
 * was not.
 */
export const T_MATERIAL_MG = new Int32Array(16 * N_SQ);
export const T_MATERIAL_EG = new Int32Array(16 * N_SQ);
export const T_PST = new Int32Array(16 * N_SQ);
/** The soldier's river bonus, kept apart because its weight tapers separately. */
export const T_SOLDIER = new Int32Array(16 * N_SQ);
/** Unsigned: both armies add to the phase. */
export const T_PHASE = new Int32Array(16 * N_SQ);

for (let code = 1; code < 16; code++) {
  const type = code & 7;
  if (type === PieceType.None) continue;
  const red = code >> 3 === (Side.Red as number);
  const sign = red ? 1 : -1;
  const table = PST[type];

  let phaseWeight = 0;
  if (type === PieceType.Chariot) phaseWeight = PHASE_CHARIOT;
  else if (type === PieceType.Cannon) phaseWeight = PHASE_CANNON;
  else if (type === PieceType.Horse) phaseWeight = PHASE_HORSE;

  for (let sq = 0; sq < N_SQ; sq++) {
    const i = code * N_SQ + sq;
    T_MATERIAL_MG[i] = sign * MATERIAL_OPENING[type];
    T_MATERIAL_EG[i] = sign * MATERIAL_ENDGAME[type];
    T_PST[i] = table ? sign * table[red ? sq : mirrorSquare(sq)] : 0;
    T_PHASE[i] = phaseWeight;

    if (type === PieceType.Soldier) {
      const rank = (sq / 9) | 0;
      // Red advances toward rank 0, Black toward rank 9.
      const crossed = red ? rank <= 4 : rank >= 5;
      const deep = red ? rank <= 2 : rank >= 7;
      T_SOLDIER[i] = crossed ? sign * (SOLDIER_CROSSED + (deep ? SOLDIER_DEEP : 0)) : 0;
    }
  }
}

/**
 * The largest absolute value the material + PST sums can reach, used to size
 * the lazy-evaluation margin sanity check in the tests.
 */
export const MAX_TERM_MAGNITUDE = (() => {
  let m = 0;
  for (let i = 0; i < T_MATERIAL_MG.length; i++) {
    m = Math.max(m, Math.abs(T_MATERIAL_MG[i]), Math.abs(T_MATERIAL_EG[i]));
  }
  return m;
})();
