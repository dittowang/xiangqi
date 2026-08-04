/**
 * Precomputed board geometry.
 *
 * Representation choice — a flat 90-square `Int8Array`, not a 16x16 mailbox.
 * The classical reason for a padded mailbox is to make off-board detection a
 * single sentinel compare inside the slider loops. Xiangqi does not need it:
 *
 *   - Every *stepping* piece (general, advisor, elephant, horse, soldier) has a
 *     tiny, position-dependent move set that is fully enumerated here at module
 *     load. The generator never computes `from + delta` at runtime, so it can
 *     never step off the edge, and the palace / river / leg / eye constraints
 *     are baked into the table rather than re-tested per node.
 *   - The two *sliding* piece types (chariot, cannon) walk `RAY_SQ`, which is
 *     already clipped to the board, so their loops are bounded by `RAY_LEN`
 *     instead of by a sentinel compare.
 *
 * The result is a 90-byte board that fits in two cache lines, no wasted index
 * space, and square indices that are identical to the ones every other
 * subsystem uses (`rank * 9 + file`, see `core/coords.ts`) — no translation
 * layer between the engine and the renderer.
 *
 * All tables are flat typed arrays with a fixed stride so the hot loops index
 * with one multiply-add and never chase a pointer into an array-of-arrays.
 */

import { NUM_SQUARES, fileOf, inPalace, isOwnHalf, onBoard, rankOf, sq as squareAt } from '@core/coords.ts';
import { Side } from '@core/types.ts';

export const N_SQ = NUM_SQUARES; // 90

/**
 * Upper bound on legal moves in one xiangqi position. The known maximum is 112;
 * 128 leaves headroom and keeps the stride a power of two.
 */
export const MAX_MOVES = 128;

// ---------------------------------------------------------------------------
// Ray directions
// ---------------------------------------------------------------------------

/** Toward rank 0 — Black's back rank. Red's soldiers advance this way. */
export const DIR_N = 0;
/** Toward rank 9 — Red's back rank. Black's soldiers advance this way. */
export const DIR_S = 1;
export const DIR_W = 2;
export const DIR_E = 3;

const DIR_DR = [-1, 1, 0, 0];
const DIR_DF = [0, 0, -1, 1];

/** Longest ray on the board: 9 steps down a file. */
export const RAY_STRIDE = 9;

/** `RAY_SQ[(sq * 4 + dir) * RAY_STRIDE + i]` — the i-th square outward. */
export const RAY_SQ = new Int8Array(N_SQ * 4 * RAY_STRIDE);
/** `RAY_LEN[sq * 4 + dir]` — how many entries of that ray are valid. */
export const RAY_LEN = new Int8Array(N_SQ * 4);

for (let s = 0; s < N_SQ; s++) {
  const f0 = fileOf(s);
  const r0 = rankOf(s);
  for (let d = 0; d < 4; d++) {
    let n = 0;
    let f = f0 + DIR_DF[d];
    let r = r0 + DIR_DR[d];
    while (onBoard(f, r)) {
      RAY_SQ[(s * 4 + d) * RAY_STRIDE + n] = squareAt(f, r);
      n++;
      f += DIR_DF[d];
      r += DIR_DR[d];
    }
    RAY_LEN[s * 4 + d] = n;
  }
}

// ---------------------------------------------------------------------------
// Stepping pieces
// ---------------------------------------------------------------------------

/**
 * Side-indexed tables are laid out as `(side * N_SQ + sq) * stride + i` so a
 * single index expression serves both armies.
 */
function sideIndex(side: Side, s: number, stride: number, i: number): number {
  return ((side as number) * N_SQ + s) * stride + i;
}

// --- general: one orthogonal step, never leaving the palace ---------------
export const GENERAL_STRIDE = 4;
export const GENERAL_TO = new Int8Array(2 * N_SQ * GENERAL_STRIDE);
export const GENERAL_N = new Int8Array(2 * N_SQ);

// --- advisor: one diagonal step, never leaving the palace -----------------
export const ADVISOR_STRIDE = 4;
export const ADVISOR_TO = new Int8Array(2 * N_SQ * ADVISOR_STRIDE);
export const ADVISOR_N = new Int8Array(2 * N_SQ);

// --- elephant: exactly two diagonal, blocked by the eye, never crosses ----
export const ELEPHANT_STRIDE = 4;
export const ELEPHANT_TO = new Int8Array(2 * N_SQ * ELEPHANT_STRIDE);
export const ELEPHANT_EYE = new Int8Array(2 * N_SQ * ELEPHANT_STRIDE);
export const ELEPHANT_N = new Int8Array(2 * N_SQ);

// --- soldier: forward always, sideways only after the river ---------------
export const SOLDIER_STRIDE = 3;
export const SOLDIER_TO = new Int8Array(2 * N_SQ * SOLDIER_STRIDE);
export const SOLDIER_N = new Int8Array(2 * N_SQ);

// --- horse: one orthogonal then one diagonal outward, leg must be empty ---
export const HORSE_STRIDE = 8;
export const HORSE_TO = new Int8Array(N_SQ * HORSE_STRIDE);
export const HORSE_LEG = new Int8Array(N_SQ * HORSE_STRIDE);
export const HORSE_N = new Int8Array(N_SQ);

/**
 * Reverse horse table: which squares a horse could sit on to attack `sq`, and
 * which leg square would have to be empty for that attack to be real. The horse
 * is the only piece whose attack relation is *not* symmetric — the leg is
 * measured from the horse, not from the target — so the forward table cannot be
 * reused for check detection.
 */
export const HORSE_ATK_FROM = new Int8Array(N_SQ * HORSE_STRIDE);
export const HORSE_ATK_LEG = new Int8Array(N_SQ * HORSE_STRIDE);
export const HORSE_ATK_N = new Int8Array(N_SQ);

const HORSE_OFFSETS: readonly [number, number][] = [
  [-2, -1],
  [-2, 1],
  [2, -1],
  [2, 1],
  [-1, -2],
  [1, -2],
  [-1, 2],
  [1, 2],
];

for (const side of [Side.Red, Side.Black]) {
  const forward = side === Side.Red ? -1 : 1; // Red advances toward rank 0.
  for (let s = 0; s < N_SQ; s++) {
    const f = fileOf(s);
    const r = rankOf(s);

    // General.
    if (inPalace(s, side)) {
      let n = 0;
      for (let d = 0; d < 4; d++) {
        const nf = f + DIR_DF[d];
        const nr = r + DIR_DR[d];
        if (!onBoard(nf, nr)) continue;
        const t = squareAt(nf, nr);
        if (!inPalace(t, side)) continue;
        GENERAL_TO[sideIndex(side, s, GENERAL_STRIDE, n)] = t;
        n++;
      }
      GENERAL_N[(side as number) * N_SQ + s] = n;
    }

    // Advisor.
    if (inPalace(s, side)) {
      let n = 0;
      for (const [dr, df] of [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ]) {
        const nf = f + df;
        const nr = r + dr;
        if (!onBoard(nf, nr)) continue;
        const t = squareAt(nf, nr);
        if (!inPalace(t, side)) continue;
        ADVISOR_TO[sideIndex(side, s, ADVISOR_STRIDE, n)] = t;
        n++;
      }
      ADVISOR_N[(side as number) * N_SQ + s] = n;
    }

    // Elephant. Only meaningful on its own half; the target must also be on it,
    // which is the 塞象眼-independent half of the river confinement rule.
    if (isOwnHalf(s, side)) {
      let n = 0;
      for (const [dr, df] of [
        [-2, -2],
        [-2, 2],
        [2, -2],
        [2, 2],
      ]) {
        const nf = f + df;
        const nr = r + dr;
        if (!onBoard(nf, nr)) continue;
        const t = squareAt(nf, nr);
        if (!isOwnHalf(t, side)) continue;
        ELEPHANT_TO[sideIndex(side, s, ELEPHANT_STRIDE, n)] = t;
        ELEPHANT_EYE[sideIndex(side, s, ELEPHANT_STRIDE, n)] = squareAt(f + df / 2, r + dr / 2);
        n++;
      }
      ELEPHANT_N[(side as number) * N_SQ + s] = n;
    }

    // Soldier.
    {
      let n = 0;
      const fr = r + forward;
      if (onBoard(f, fr)) {
        SOLDIER_TO[sideIndex(side, s, SOLDIER_STRIDE, n)] = squareAt(f, fr);
        n++;
      }
      // Sideways only once the river is behind it.
      if (!isOwnHalf(s, side)) {
        for (const df of [-1, 1]) {
          if (!onBoard(f + df, r)) continue;
          SOLDIER_TO[sideIndex(side, s, SOLDIER_STRIDE, n)] = squareAt(f + df, r);
          n++;
        }
      }
      SOLDIER_N[(side as number) * N_SQ + s] = n;
    }
  }
}

for (let s = 0; s < N_SQ; s++) {
  const f = fileOf(s);
  const r = rankOf(s);

  // Forward horse moves.
  let n = 0;
  for (const [dr, df] of HORSE_OFFSETS) {
    const nf = f + df;
    const nr = r + dr;
    if (!onBoard(nf, nr)) continue;
    // The leg is the single orthogonal step along whichever axis moves by two.
    const legF = Math.abs(df) === 2 ? f + df / 2 : f;
    const legR = Math.abs(dr) === 2 ? r + dr / 2 : r;
    HORSE_TO[s * HORSE_STRIDE + n] = squareAt(nf, nr);
    HORSE_LEG[s * HORSE_STRIDE + n] = squareAt(legF, legR);
    n++;
  }
  HORSE_N[s] = n;

  // Reverse horse attacks: a horse standing at (r+dr, f+df) reaches `s`, and
  // its leg is the orthogonal step it takes *away from itself* toward `s`.
  let m = 0;
  for (const [dr, df] of HORSE_OFFSETS) {
    const hf = f + df;
    const hr = r + dr;
    if (!onBoard(hf, hr)) continue;
    // Move from the horse to `s` has components (-dr, -df).
    const legF = Math.abs(df) === 2 ? hf - df / 2 : hf;
    const legR = Math.abs(dr) === 2 ? hr - dr / 2 : hr;
    HORSE_ATK_FROM[s * HORSE_STRIDE + m] = squareAt(hf, hr);
    HORSE_ATK_LEG[s * HORSE_STRIDE + m] = squareAt(legF, legR);
    m++;
  }
  HORSE_ATK_N[s] = m;
}

// ---------------------------------------------------------------------------
// Accessors — the hot loops call these; they are trivially inlinable.
// ---------------------------------------------------------------------------

export function generalCount(side: Side, s: number): number {
  return GENERAL_N[(side as number) * N_SQ + s];
}
export function generalTarget(side: Side, s: number, i: number): number {
  return GENERAL_TO[sideIndex(side, s, GENERAL_STRIDE, i)];
}
export function advisorCount(side: Side, s: number): number {
  return ADVISOR_N[(side as number) * N_SQ + s];
}
export function advisorTarget(side: Side, s: number, i: number): number {
  return ADVISOR_TO[sideIndex(side, s, ADVISOR_STRIDE, i)];
}
export function elephantCount(side: Side, s: number): number {
  return ELEPHANT_N[(side as number) * N_SQ + s];
}
export function elephantTarget(side: Side, s: number, i: number): number {
  return ELEPHANT_TO[sideIndex(side, s, ELEPHANT_STRIDE, i)];
}
export function elephantEye(side: Side, s: number, i: number): number {
  return ELEPHANT_EYE[sideIndex(side, s, ELEPHANT_STRIDE, i)];
}
export function soldierCount(side: Side, s: number): number {
  return SOLDIER_N[(side as number) * N_SQ + s];
}
export function soldierTarget(side: Side, s: number, i: number): number {
  return SOLDIER_TO[sideIndex(side, s, SOLDIER_STRIDE, i)];
}

/** Vertical flip used to mirror piece-square tables onto Black. */
export function mirrorSquare(s: number): number {
  return (9 - rankOf(s)) * 9 + fileOf(s);
}
