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
import { hasCrossedRiver, inPalace, rankOf } from '@core/coords.ts';
import { EMPTY } from '@core/types.ts';
import { MoveList, generateMoves } from './movegen.ts';
import type { Position } from './position.ts';
import {
  HORSE_ATK_FROM,
  HORSE_ATK_LEG,
  HORSE_ATK_N,
  HORSE_STRIDE,
  N_SQ,
  RAY_LEN,
  RAY_STRIDE,
  RAY_SQ,
  mirrorSquare,
} from './tables.ts';

// ---------------------------------------------------------------------------
// 1. Material
// ---------------------------------------------------------------------------

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
const MATERIAL_OPENING = [0, 0, 210, 220, 440, 900, 470, 100];
const MATERIAL_ENDGAME = [0, 0, 240, 230, 470, 940, 410, 100];

/** Extra value a soldier gains the moment it is over the river. */
const SOLDIER_CROSSED = 90;
/** Extra again once it is on one of the enemy's last three ranks. */
const SOLDIER_DEEP = 45;

/** Static values used for MVV-LVA ordering and delta pruning. */
export const PIECE_VALUE = MATERIAL_OPENING;

// ---------------------------------------------------------------------------
// 2. Piece-square tables
// ---------------------------------------------------------------------------

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

const PST: (Int16Array | null)[] = [
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

/**
 * Only the three attacking types drive the phase; shells and soldiers do not.
 * These weights are deliberately *not* the material values — they are a fixed
 * yardstick for "how much is still on the board", and tying them to the tapered
 * values would make the taper depend on itself.
 */
const PHASE_CHARIOT = 900;
const PHASE_CANNON = 470;
const PHASE_HORSE = 400;
const PHASE_MAX = 2 * (2 * PHASE_CHARIOT + 2 * PHASE_CANNON + 2 * PHASE_HORSE);

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

export function weightsFor(phase: number): EvalWeights {
  return {
    phase,
    // Placement matters most while the board is full.
    pst: lerp(0.8, 1.0, phase),
    // Mobility matters most once there is room to use it.
    mobility: lerp(1.2, 0.9, phase),
    // Safety matters most while there is something left to attack with.
    safety: lerp(0.7, 1.2, phase),
    // Soldiers decide endgames.
    soldierAdvance: lerp(1.45, 1.0, phase),
  };
}

// ---------------------------------------------------------------------------
// The evaluation itself
// ---------------------------------------------------------------------------

/** Scratch move list — module level so `evaluate` never allocates. */
const mobilityScratch = new MoveList();

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

/** Centipawns from the side to move's point of view. */
export function evaluate(pos: Position): number {
  const red = compute(pos);
  return pos.side === Side.Red ? red : -red;
}

/** Centipawns from Red's point of view, whoever is to move. */
export function evaluateRedPov(pos: Position): number {
  return compute(pos);
}

/** A copy of the per-term detail, for tests and the review-mode tooltip. */
export function breakdown(pos: Position): EvalBreakdown {
  compute(pos);
  return { ...scratch };
}

function compute(pos: Position): number {
  const phase = clamp(phaseOf(pos) / PHASE_MAX, 0, 1);
  // The weights are pure functions of the phase, and computing them inline
  // keeps this whole function allocation-free.
  const wPst = lerp(0.8, 1.0, phase);
  const wMobility = lerp(1.2, 0.9, phase);
  const wSafety = lerp(0.7, 1.2, phase);
  const wSoldier = lerp(1.45, 1.0, phase);

  let material = 0;
  let pst = 0;

  for (let s = 0; s < N_SQ; s++) {
    const code = pos.board[s];
    if (code === EMPTY) continue;
    const side: Side = (code >> 3) as Side;
    const type = (code & 7) as PieceType;
    const sign = side === Side.Red ? 1 : -1;

    let value = lerp(MATERIAL_ENDGAME[type], MATERIAL_OPENING[type], phase);
    if (type === PieceType.Soldier && hasCrossedRiver(s, side)) {
      const r = rankOf(s);
      const deep = side === Side.Red ? r <= 2 : r >= 7;
      value += (SOLDIER_CROSSED + (deep ? SOLDIER_DEEP : 0)) * wSoldier;
    }
    material += sign * value;

    const t = PST[type];
    if (t) pst += sign * t[side === Side.Red ? s : mirrorSquare(s)];
  }

  const mobility = mobilityOf(pos, Side.Red) - mobilityOf(pos, Side.Black);
  const safety = generalSafety(pos, Side.Red) - generalSafety(pos, Side.Black);
  const tempo = pos.side === Side.Red ? TEMPO : -TEMPO;

  const total = material + pst * wPst + mobility * wMobility + safety * wSafety + tempo;

  scratch.material = roundSym(material);
  scratch.pst = roundSym(pst * wPst);
  scratch.mobility = roundSym(mobility * wMobility);
  scratch.safety = roundSym(safety * wSafety);
  scratch.tempo = tempo;
  scratch.phase = phase;
  scratch.total = roundSym(total);
  return scratch.total;
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

/** Unrolled deliberately: an array literal here would allocate on every leaf. */
function phaseOf(pos: Position): number {
  return (
    (pos.countOf(makePiece(Side.Red, PieceType.Chariot)) +
      pos.countOf(makePiece(Side.Black, PieceType.Chariot))) *
      PHASE_CHARIOT +
    (pos.countOf(makePiece(Side.Red, PieceType.Cannon)) +
      pos.countOf(makePiece(Side.Black, PieceType.Cannon))) *
      PHASE_CANNON +
    (pos.countOf(makePiece(Side.Red, PieceType.Horse)) +
      pos.countOf(makePiece(Side.Black, PieceType.Horse))) *
      PHASE_HORSE
  );
}

/**
 * Weighted pseudo-legal move count.
 *
 * Pseudo-legal, not legal: filtering through make/unmake here would roughly
 * triple the cost of an evaluation, and the difference is a handful of moves by
 * pinned pieces. The bias is symmetric and tiny, and it buys about 40% more
 * nodes per second, which is worth far more than the accuracy.
 */
function mobilityOf(pos: Position, side: Side): number {
  const saved = pos.side;
  pos.side = side;
  generateMoves(pos, mobilityScratch);
  pos.side = saved;

  let total = 0;
  for (let i = 0; i < mobilityScratch.count; i++) {
    const from = mobilityScratch.moves[i] & 0x7f;
    total += MOBILITY_WEIGHT[pos.board[from] & 7];
  }
  return total;
}

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
