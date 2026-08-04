/**
 * Evaluation.
 *
 * Four weighted terms, blended across a material-driven game phase:
 *
 *   1. Material, on the traditional scale, with the soldier's value tied to how
 *      far it has come rather than to a flat number.
 *   2. A piece-square table per unit type, authored from Red's seat and
 *      mirrored onto Black by a pure rank flip.
 *   3. Mobility, weighted per piece type.
 *   4. General safety: the 士象 shell, file exposure to chariots and cannons,
 *      horses lurking at the palace, soldiers already inside it.
 *
 * The phase taper matters more in xiangqi than in western chess because the
 * pieces change value so sharply: a cannon is a monster in a crowded opening
 * (it needs screens) and a weakling on an empty board, while a horse is the
 * reverse. Those two curves crossing is the single most important thing this
 * function knows that a material counter does not.
 *
 * Sign convention: `evaluate()` returns centipawns from the *side to move's*
 * point of view, which is what negamax wants. `evaluateRedPov()` is the same
 * number always oriented to Red, which is what the HUD's ink bar wants.
 */

import { clamp, lerp } from '@core/types.ts';
import { PieceType, Side, makePiece, opposite } from '@core/types.ts';
import { inPalace, rankOf } from '@core/coords.ts';
import { EMPTY } from '@core/types.ts';
import { weightedMobility } from './movegen.ts';
import type { Position } from './position.ts';
import {
  HORSE_ATK_FROM,
  HORSE_ATK_LEG,
  HORSE_ATK_N,
  HORSE_STRIDE,
  RAY_LEN,
  RAY_STRIDE,
  RAY_SQ,
} from './tables.ts';
import { MATERIAL_OPENING, PHASE_MAX } from './terms.ts';

// ---------------------------------------------------------------------------
// 1. Material
// ---------------------------------------------------------------------------

/** Static values used for MVV-LVA ordering and delta pruning. */
export const PIECE_VALUE = MATERIAL_OPENING;

// ---------------------------------------------------------------------------
// 2. Piece-square tables
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3. Mobility weights
// ---------------------------------------------------------------------------

/**
 * Centipawns per pseudo-legal move, by moving piece type. A chariot with
 * seventeen moves is worth about 68 here and a boxed-in one about 24 — that
 * ~45cp spread is roughly the practical difference between an open file and a
 * blocked one, which is what the term is trying to capture. Advisors and
 * elephants get 1 because their move count says almost nothing; the general
 * gets 0 because a general with more moves is usually a general in trouble.
 */
const MOBILITY_WEIGHT = [0, 0, 1, 1, 3, 4, 1, 2];

// ---------------------------------------------------------------------------
// 4. General safety weights
// ---------------------------------------------------------------------------

const SAFETY = {
  /** Base cost of a missing advisor / elephant, before the attacker scaling. */
  missingAdvisor: 12,
  missingElephant: 10,
  /** Added per enemy cannon / chariot for each missing shell piece. */
  perCannonAdvisor: 6,
  perChariotAdvisor: 4,
  perCannonElephant: 8,
  perChariotElephant: 4,
  /** An enemy chariot bearing on the general's file with nothing in between. */
  chariotOnFile: 45,
  /** 空頭炮 — an enemy cannon on the file with no screen at all. Brutal. */
  hollowCannon: 40,
  /** An enemy cannon with exactly one screen: a live threat, one tempo away. */
  loadedCannon: 32,
  /** Same two, along the general's rank, where the palace is only three wide. */
  chariotOnRank: 25,
  loadedCannonRank: 18,
  /** An enemy horse already in position to fork the palace. */
  horseAtPalace: 18,
  /** An enemy soldier standing inside our palace. */
  soldierInPalace: 25,
  /** The general has left its back rank. */
  offBackRank: 8,
  /** No advisors left and the enemy still has a chariot. */
  strippedVsChariot: 25,
};

// ---------------------------------------------------------------------------
// Phase taper
// ---------------------------------------------------------------------------

/** Small bonus for having the move; keeps the search from shuffling. */
const TEMPO = 8;

/** The blended weights, exposed so tests and the report can read them. */
export interface EvalWeights {
  phase: number;
  pst: number;
  mobility: number;
  safety: number;
  soldierAdvance: number;
}

/**
 * Term weights at the two ends of the taper, `[endgame, opening]`.
 *
 *   pst      1.00 -> 0.80  placement matters most while the board is full
 *   mobility 0.90 -> 1.20  mobility matters most once there is room to use it
 *   safety   1.20 -> 0.70  safety matters most while there is still an attack
 *   soldier  1.00 -> 1.45  soldiers decide endgames
 *
 * `compute()` reads these directly rather than calling `weightsFor`, so that a
 * leaf evaluation never allocates the result object — the constants live here
 * so the two cannot drift apart.
 */
const W_PST = [0.8, 1.0] as const;
const W_MOBILITY = [1.2, 0.9] as const;
const W_SAFETY = [0.7, 1.2] as const;
const W_SOLDIER = [1.45, 1.0] as const;

export function weightsFor(phase: number): EvalWeights {
  return {
    phase,
    pst: lerp(W_PST[0], W_PST[1], phase),
    mobility: lerp(W_MOBILITY[0], W_MOBILITY[1], phase),
    safety: lerp(W_SAFETY[0], W_SAFETY[1], phase),
    soldierAdvance: lerp(W_SOLDIER[0], W_SOLDIER[1], phase),
  };
}

// ---------------------------------------------------------------------------
// The evaluation itself
// ---------------------------------------------------------------------------

/** Per-term breakdown, for tests and for the review-mode tooltip. */
export interface EvalBreakdown {
  material: number;
  pst: number;
  mobility: number;
  safety: number;
  tempo: number;
  total: number;
  phase: number;
}

/**
 * Scratch breakdown, filled by every evaluation. The search calls `evaluate()`
 * at every leaf, so this path must not allocate — `breakdown()` copies the
 * scratch out for the callers that actually want the detail.
 */
const scratch: EvalBreakdown = {
  material: 0,
  pst: 0,
  mobility: 0,
  safety: 0,
  tempo: 0,
  total: 0,
  phase: 1,
};

/**
 * Lazy-evaluation margin: an upper bound on the magnitude of everything the
 * cheap pass leaves out (mobility and general safety, both already weighted).
 *
 * The cheap pass — tapered material, piece-square, tempo — is three additions
 * off `Position`'s incrementally maintained sums. The expensive pass is two
 * mobility sweeps and two palace scans, and it costs about four times as much.
 * When the cheap score is already this far outside the alpha-beta window, the
 * expensive terms cannot bring it back inside, so the node returns a bound and
 * skips them.
 *
 * 340 is measured, not guessed: `eval.test.ts` walks a few thousand positions
 * from real self-play and asserts that |mobility + safety| never reaches it.
 * Setting it too low is not a slowdown, it is a *wrong evaluation*, so the test
 * matters more than the number.
 */
export const LAZY_MARGIN = 340;

const INFINITE = 1e9;

/**
 * Centipawns from the side to move's point of view.
 *
 * Passing the search window in enables the lazy exit. The returned number is
 * then a *bound* rather than an exact score whenever it lies outside that
 * window, which is all alpha-beta needs — but it means callers that want a real
 * evaluation (the HUD, review mode, tests) must not pass a window.
 */
export function evaluate(pos: Position, alpha = -INFINITE, beta = INFINITE): number {
  const red = pos.side === Side.Red;
  // Rotate the window into Red's point of view. For Black the bounds swap and
  // negate, because a Red-POV score is the negation of a Black-POV one.
  const value = compute(pos, red ? alpha : -beta, red ? beta : -alpha);
  return red ? value : -value;
}

/** Centipawns from Red's point of view, whoever is to move. Never lazy. */
export function evaluateRedPov(pos: Position): number {
  return compute(pos, -INFINITE, INFINITE);
}

/** A copy of the per-term detail, for tests and the review-mode tooltip. */
export function breakdown(pos: Position): EvalBreakdown {
  compute(pos, -INFINITE, INFINITE);
  return { ...scratch };
}

/** `redLow` / `redHigh` are the alpha-beta window rotated into Red's view. */
function compute(pos: Position, redLow: number, redHigh: number): number {
  const phase = clamp(pos.termPhase / PHASE_MAX, 0, 1);
  // Same numbers `weightsFor` returns, read straight out of the shared
  // constants so a leaf evaluation never allocates the result object.
  const wPst = lerp(W_PST[0], W_PST[1], phase);
  const wMobility = lerp(W_MOBILITY[0], W_MOBILITY[1], phase);
  const wSafety = lerp(W_SAFETY[0], W_SAFETY[1], phase);
  const wSoldier = lerp(W_SOLDIER[0], W_SOLDIER[1], phase);

  // --- the cheap pass: three incrementally maintained sums, no board walk
  const material = lerp(pos.termMaterialEg, pos.termMaterialMg, phase) + pos.termSoldier * wSoldier;
  const pstTerm = pos.termPst * wPst;
  const tempo = pos.side === Side.Red ? TEMPO : -TEMPO;
  const lazy = material + pstTerm + tempo;

  // --- lazy exit: even the largest possible mobility + safety swing cannot
  //     drag the score back inside the window, so stop here and return a bound.
  if (lazy - LAZY_MARGIN > redHigh || lazy + LAZY_MARGIN < redLow) {
    const bound = lazy - LAZY_MARGIN > redHigh ? lazy - LAZY_MARGIN : lazy + LAZY_MARGIN;
    scratch.material = roundSym(material);
    scratch.pst = roundSym(pstTerm);
    scratch.mobility = 0;
    scratch.safety = 0;
    scratch.tempo = tempo;
    scratch.phase = phase;
    scratch.total = roundSym(bound);
    lazyExits++;
    return scratch.total;
  }

  const mobility =
    weightedMobility(pos, Side.Red, MOBILITY_WEIGHT) -
    weightedMobility(pos, Side.Black, MOBILITY_WEIGHT);
  const safety = generalSafety(pos, Side.Red) - generalSafety(pos, Side.Black);

  const total = lazy + mobility * wMobility + safety * wSafety;

  scratch.material = roundSym(material);
  scratch.pst = roundSym(pstTerm);
  scratch.mobility = roundSym(mobility * wMobility);
  scratch.safety = roundSym(safety * wSafety);
  scratch.tempo = tempo;
  scratch.phase = phase;
  scratch.total = roundSym(total);
  return scratch.total;
}

/** Diagnostics: how often the lazy exit fired. Read by the benchmark. */
let lazyExits = 0;
export function lazyExitCount(): number {
  return lazyExits;
}
export function resetLazyExitCount(): void {
  lazyExits = 0;
}

/**
 * The two terms the lazy exit skips, weighted exactly as `compute` weights
 * them. Only used by the test that validates `LAZY_MARGIN`; the search never
 * calls it.
 */
export function lazyOmittedMagnitude(pos: Position): number {
  const phase = clamp(pos.termPhase / PHASE_MAX, 0, 1);
  const wMobility = lerp(W_MOBILITY[0], W_MOBILITY[1], phase);
  const wSafety = lerp(W_SAFETY[0], W_SAFETY[1], phase);
  const mobility =
    weightedMobility(pos, Side.Red, MOBILITY_WEIGHT) -
    weightedMobility(pos, Side.Black, MOBILITY_WEIGHT);
  const safety = generalSafety(pos, Side.Red) - generalSafety(pos, Side.Black);
  return Math.abs(mobility * wMobility + safety * wSafety);
}

/**
 * Round half *away from zero*, not half up. `Math.round(-0.5)` is `-0` while
 * `Math.round(0.5)` is `1`, which would make a mirrored position evaluate to
 * one centipawn off its own negation — a real asymmetry, and one that the
 * search would happily exploit by preferring whichever colour rounds its way.
 */
function roundSym(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * Mobility is measured on *pseudo-legal* moves, not legal ones. Filtering
 * through make/unmake here would roughly triple the cost of an evaluation, and
 * the difference is a handful of moves by pinned pieces. The bias is symmetric
 * and tiny; the speed is not.
 */

/** Negative numbers only: how exposed `side`'s general is. */
function generalSafety(pos: Position, side: Side): number {
  const g = pos.general(side);
  if (g < 0) return 0;
  const enemy = opposite(side);
  const enemyBits = enemy as number;
  const board = pos.board;

  const advisors = pos.countOf(makePiece(side, PieceType.Advisor));
  const elephants = pos.countOf(makePiece(side, PieceType.Elephant));
  const eCannons = pos.countOf(makePiece(enemy, PieceType.Cannon));
  const eChariots = pos.countOf(makePiece(enemy, PieceType.Chariot));

  let penalty = 0;

  // The 士象 shell. A missing advisor costs more when the enemy still has the
  // cannons to exploit the hole — this is why 缺士怕炮 is the first thing every
  // beginner is taught.
  penalty +=
    (2 - advisors) *
    (SAFETY.missingAdvisor + SAFETY.perCannonAdvisor * eCannons + SAFETY.perChariotAdvisor * eChariots);
  penalty +=
    (2 - elephants) *
    (SAFETY.missingElephant + SAFETY.perCannonElephant * eCannons + SAFETY.perChariotElephant * eChariots);

  // File and rank exposure. Directions 0/1 are vertical (the dangerous ones,
  // because that is where the general lives and where cannons stack).
  for (let dir = 0; dir < 4; dir++) {
    const vertical = dir < 2;
    const base = (g * 4 + dir) * RAY_STRIDE;
    const len = RAY_LEN[g * 4 + dir];
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

    if (first >> 3 === enemyBits) {
      const t = first & 7;
      if (t === PieceType.Chariot) penalty += vertical ? SAFETY.chariotOnFile : SAFETY.chariotOnRank;
      else if (t === PieceType.Cannon && vertical) penalty += SAFETY.hollowCannon;
    }
    // One screen of any colour, then an enemy cannon: a real threat.
    for (; i < len; i++) {
      const p = board[RAY_SQ[base + i]];
      if (p === EMPTY) continue;
      if (p >> 3 === enemyBits && (p & 7) === PieceType.Cannon) {
        penalty += vertical ? SAFETY.loadedCannon : SAFETY.loadedCannonRank;
      }
      break;
    }
  }

  // Horses already in range of the palace: the classic mating partner.
  const hn = HORSE_ATK_N[g];
  for (let i = 0; i < hn; i++) {
    const h = HORSE_ATK_FROM[g * HORSE_STRIDE + i];
    const p = board[h];
    if (p === EMPTY || p >> 3 !== enemyBits || (p & 7) !== PieceType.Horse) continue;
    if (board[HORSE_ATK_LEG[g * HORSE_STRIDE + i]] === EMPTY) penalty += SAFETY.horseAtPalace;
  }

  // Enemy soldiers that have walked into the palace.
  const soldierCode = makePiece(enemy, PieceType.Soldier);
  const sn = pos.countOf(soldierCode);
  for (let i = 0; i < sn; i++) {
    if (inPalace(pos.squareOf(soldierCode, i), side)) penalty += SAFETY.soldierInPalace;
  }

  // Palace holes.
  const backRank = side === Side.Red ? 9 : 0;
  if (rankOf(g) !== backRank) penalty += SAFETY.offBackRank;
  if (advisors === 0 && eChariots > 0) penalty += SAFETY.strippedVsChariot;

  return -penalty;
}
