/**
 * The animation layer's tuning block.
 *
 * Every duration, every cross-fade, every hold and every ease used anywhere in
 * `src/anim/` is named here and nowhere else. Retiming the whole combat
 * choreography off a real captured clip is then a single-file edit, which is the
 * point: the numbers below are a first pass tuned by eye and arithmetic, and the
 * next pass will be tuned by a motion critic looking at frames.
 *
 * THREE RULES THE NUMBERS FOLLOW
 * ------------------------------
 * 1. **Nothing is round.** A capture built on 0.5 / 1.0 / 2.0 reads as a
 *    metronome; the eye finds the grid and stops believing the weight. Every
 *    beat here is deliberately off the half-second.
 * 2. **Asymmetric attack and release.** A windup is always slower than the
 *    strike it releases (here 0.53 against 0.29, a ratio of 1.83), and a
 *    recovery is always slower than the hit that caused it. Symmetry reads as
 *    an interpolation, not a body.
 * 3. **The hold is in frames, not seconds.** The two-to-three frame impact hold
 *    is an anime convention with an exact length — it is 2.5 frames at 60 Hz,
 *    written as such, so it stays 2.5 frames if the target rate ever moves.
 *
 * Angles are radians, times are seconds, distances are either *statures*
 * (fractions of the figure's standing height, so they retarget across the cast)
 * or world units, and each is labelled.
 */

import { clamp, easeInOutCubic, easeOutBack, easeOutCubic, easeOutQuint } from '@core/types.ts';

// ===========================================================================
// Frame rate
// ===========================================================================

/** The rate every "N frames" duration below is expressed against. */
export const TARGET_FPS = 60;
export const FRAME = 1 / TARGET_FPS;

/** Turn a frame count into seconds. Used so holds stay readable as frames. */
export function frames(n: number): number {
  return n * FRAME;
}

// ===========================================================================
// Easing
// ===========================================================================

/**
 * The eases the clip authoring language can name. `core/types.ts` owns the
 * shared curves; the three added here are specific to body motion:
 *
 *   `settle`  — a damped oscillation, for a mass arriving somewhere and ringing
 *               down. This is what a head does at the end of a hit.
 *   `anticipate` — pulls slightly the wrong way before going the right way.
 *               Two frames of it in front of a strike is most of what sells the
 *               weight of the strike.
 *   `hold`    — steps at the end of the segment. For a pose that must not creep
 *               while the choreographer waits on it.
 */
export type EaseName =
  | 'linear'
  | 'inQuad'
  | 'outQuad'
  | 'inCubic'
  | 'outCubic'
  | 'inOutCubic'
  | 'outQuint'
  | 'outBack'
  | 'settle'
  | 'anticipate'
  | 'hold';

/** Damped ring-down, normalised so f(0) = 0 and f(1) = 1 exactly. */
const SETTLE_DECAY = 6.2;
const SETTLE_FREQ = 9.4;
const SETTLE_END = 1 - Math.exp(-SETTLE_DECAY) * Math.cos(SETTLE_FREQ);
function settle(t: number): number {
  const raw = 1 - Math.exp(-SETTLE_DECAY * t) * Math.cos(SETTLE_FREQ * t);
  return raw / SETTLE_END;
}

/** Dips to -0.14 of the way at t ≈ 0.3 before committing. */
function anticipate(t: number): number {
  return t * t * (2.9 * t - 1.9);
}

export const EASE: Record<EaseName, (t: number) => number> = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inCubic: (t) => t * t * t,
  outCubic: easeOutCubic,
  inOutCubic: easeInOutCubic,
  outQuint: easeOutQuint,
  outBack: (t) => easeOutBack(t, 1.42),
  settle,
  anticipate,
  hold: (t) => (t >= 1 ? 1 : 0),
};

// ===========================================================================
// Clip durations
// ===========================================================================

/**
 * Per-state clip lengths. `move` is not here — a locomotion cycle's length
 * belongs to the gait, below, because a canter and an elephant's walk are not
 * the same clock.
 */
export const CLIP = {
  /** Two breaths and one weight shift, which is why it is not a round number. */
  idle: 7.43,
  /** Long enough to hold at the top without the pose going stale. */
  attackWindup: 0.53,
  /** 1.83× faster than the windup. The whole read of the strike is in this ratio. */
  attackStrike: 0.29,
  /** Impact, break, catch step, recover. */
  hit: 0.71,
  /** Knees, then torso, then head. Deliberately long: a collapse takes time. */
  death: 2.37,
  /** The weapon coming up. Chains straight into `victoryHold`. */
  victory: 1.53,
  /** The held pose, breathing. Loops. */
  victoryHold: 4.53,
  /** 拱手: hands together, bow, hold, straighten. */
  salute: 2.11,
} as const;

// ===========================================================================
// Gaits
// ===========================================================================

export type GaitName = 'march' | 'stride' | 'canter' | 'lumber' | 'roll' | 'crew';

/**
 * A locomotion cycle, described once for both the clip author and the contact
 * solver so the two can never disagree about when a foot is down.
 *
 * `strideOverLeg` is the ground distance covered by one *full cycle* (two steps
 * for a biped) as a multiple of the figure's leg length. Expressing it that way
 * is what makes the gait retarget: a 0.60-scale conscript and a 1.12-scale
 * general take the same number of steps per square only if their strides scale
 * with their legs, and they do not otherwise.
 *
 * `duty` is the fraction of the cycle each foot spends in stance. Above 0.5 the
 * two stance windows overlap and the walk has a real double-support phase —
 * which is the difference between a march and a glide, and it is the first thing
 * to check if a gait ever stops reading as weight.
 */
export interface GaitPlan {
  name: GaitName;
  /** Nominal seconds for one cycle, used when nothing is driving travel. */
  cycle: number;
  strideOverLeg: number;
  duty: number;
  /** Cycle phase at which each foot strikes the ground. */
  contactL: number;
  contactR: number;
  /** Peak lift of the swinging foot, in statures. */
  lift: number;
  /** Legs are on a mount, not the ground: the contact solver holds them there. */
  seated: boolean;
  /** Peak vertical travel of the pelvis over a cycle, in statures. */
  bob: number;
}

export const GAIT: Record<GaitName, GaitPlan> = {
  /**
   * Infantry march. Duty 0.62 gives two 12% double-support windows per cycle.
   * 1.03 s per cycle is 116 steps a minute, which is a real quick-march cadence.
   */
  march: {
    name: 'march',
    cycle: 1.03,
    strideOverLeg: 1.52,
    duty: 0.62,
    contactL: 0.5,
    contactR: 0.0,
    lift: 0.052,
    seated: false,
    bob: 0.0165,
  },
  /**
   * The robed walk. Longer double support, shorter steps, and a bob small
   * enough that the hem does not pump — the brief's "almost no vertical bob".
   */
  stride: {
    name: 'stride',
    cycle: 1.19,
    strideOverLeg: 1.24,
    duty: 0.66,
    contactL: 0.5,
    contactR: 0.0,
    lift: 0.031,
    seated: false,
    bob: 0.0047,
  },
  /** The rider's clock. The horse's three beats live in `CANTER` below. */
  canter: {
    name: 'canter',
    cycle: 0.83,
    strideOverLeg: 2.42,
    duty: 1.0,
    contactL: 0.0,
    contactR: 0.0,
    lift: 0,
    seated: true,
    bob: 0.026,
  },
  /** The elephant's four-beat lateral walk, seen from the mahout's seat. */
  lumber: {
    name: 'lumber',
    cycle: 2.13,
    strideOverLeg: 2.05,
    duty: 1.0,
    contactL: 0.0,
    contactR: 0.0,
    lift: 0,
    seated: true,
    bob: 0.019,
  },
  /** The charioteer's clock. Wheel phase comes from travel, never from here. */
  roll: {
    name: 'roll',
    cycle: 1.31,
    strideOverLeg: 1.0,
    duty: 1.0,
    contactL: 0.0,
    contactR: 0.0,
    lift: 0,
    seated: true,
    bob: 0.011,
  },
  /**
   * The artillery crew's shuffle. Duty 0.73 — three-quarters of the cycle with
   * both feet down is what makes a shuffle a shuffle rather than a walk.
   */
  crew: {
    name: 'crew',
    cycle: 1.47,
    strideOverLeg: 0.72,
    duty: 0.73,
    contactL: 0.5,
    contactR: 0.0,
    lift: 0.019,
    seated: false,
    bob: 0.0085,
  },
};

/**
 * The horse's canter, as footfall phases within one stride. Right lead: left
 * hind first, then the diagonal pair (right hind with left fore), then the
 * leading right fore, then a moment of suspension with nothing down.
 *
 * Getting this sequence wrong is the classic tell of a procedural quadruped —
 * a four-beat canter or a diagonal-pair trot mislabelled as a canter reads as
 * wrong long before a viewer can say why.
 */
export const CANTER = {
  /** Footfall phase per leg, right lead. */
  hindL: 0.0,
  hindR: 0.3,
  foreL: 0.32,
  foreR: 0.6,
  /** Fraction of the stride each hoof stays down. */
  duty: 0.34,
  /** Suspension window: no hoof touching. */
  suspendFrom: 0.79,
  suspendTo: 1.0,
  /** Rocking-horse pitch of the barrel, radians, and where its peak sits. */
  pitchAmplitude: 0.115,
  pitchPhase: 0.12,
  /** Vertical travel of the withers over a stride, in mount units. */
  rise: 0.055,
} as const;

/**
 * The elephant's walk: a lateral-sequence four-beat, hind then fore on the same
 * side. Duty 0.68 keeps three feet on the ground at all times, which is where
 * the weight comes from — an elephant is never in suspension.
 */
export const LUMBER = {
  hindL: 0.0,
  foreL: 0.26,
  hindR: 0.5,
  foreR: 0.76,
  duty: 0.68,
  /** Lateral roll of the body, radians. Two sways per cycle. */
  sway: 0.052,
  /** Vertical travel of the shoulder over a cycle, in mount units. */
  rise: 0.028,
} as const;

/** Chariot deck motion. Two components so it never reads as a clean sine. */
export const ROLL = {
  /** Pitch over the axle, radians, at two per wheel revolution. */
  pitchA: 0.036,
  /** A second, faster component: the road, not the axle. */
  pitchB: 0.017,
  /** Lateral rock, radians. */
  rockA: 0.021,
  /** Fraction of the deck pitch the crew's knees absorb rather than pass on. */
  kneeAbsorb: 0.68,
} as const;

// ===========================================================================
// Cross-fades
// ===========================================================================

/**
 * Cross-fade lengths, per destination state. A fade is a lie the body tells to
 * get from one pose to another, and the longer it runs the more visible the lie
 * is — so the violent transitions are short enough to read as impacts, and only
 * the calm ones are allowed to breathe.
 */
export const FADE = {
  toIdle: 0.34,
  toMove: 0.22,
  toWindup: 0.17,
  /** Almost a cut. The strike must not appear to be interpolated into. */
  windupToStrike: 0.045,
  /** A hit lands. Anything slower and the impulse arrives after the impact. */
  toHit: 0.055,
  toDeath: 0.085,
  toVictory: 0.41,
  victoryToHold: 0.29,
  toSalute: 0.31,
  /** Returning to idle after a one-shot has clamped. */
  fromOneShot: 0.38,
} as const;

// ===========================================================================
// The three-beat capture
// ===========================================================================

/**
 * Absolute marks on the capture timeline, in seconds from the start of the
 * exchange. Written as absolute times rather than durations because that is how
 * they are read off a captured clip, and because the overlaps matter: the
 * dispersal starts *before* the body has finished collapsing, which is what
 * stops the third beat feeling like a separate event bolted onto the second.
 *
 *   beat 1  advance and wind up        0.000 → 1.090
 *   beat 2  contact, hold, flash       1.090 → 1.692
 *   beat 3  driven back, collapse,     1.692 → 4.184
 *           disperse into pigment
 */
export const CAPTURE = {
  /** The attacker closes on the defender. */
  approachStart: 0.0,
  approachEnd: 0.43,
  /** Beat 1: the windup. Ends at the top of the coil. */
  windupStart: 0.43,
  windupTop: 0.96,
  /** The choreographer can hold here; `seekCapture` parks inside this window. */
  windupHold: 0.13,
  /** Beat 2: release. */
  strikeStart: 1.09,
  /** Contact — 0.19 into a 0.29 s strike, so the follow-through outlives it. */
  contact: 1.28,
  /** 2.5 frames of frozen time at 60 Hz. The anime impact convention. */
  holdFrames: 2.5,
  /** Beat 3: the defender is driven back. */
  knockbackEnd: 1.692,
  /** The body reaches the board. */
  collapseEnd: 2.97,
  /** Pigment starts leaving the body before the body has finished falling. */
  disperseStart: 2.31,
  disperseEnd: 3.94,
  /** Everything at rest; the promise resolves here. */
  settleEnd: 4.184,

  /** Camera push strength and the impulse fired at contact. */
  impulse: 0.86,
  /** Flash strength at contact, 0..1. */
  flash: 0.92,
  /** How long the attacker's follow-through holds before it returns to idle. */
  recover: 0.44,
  /** How far the attacker advances toward the defender, as a fraction of the gap. */
  approachFraction: 0.58,
  /** How far the defender is driven back, in world units. */
  knockback: 0.42,
} as const;

/** Derived: the frozen-time hold, in seconds. */
export const CAPTURE_HOLD = frames(CAPTURE.holdFrames);

/**
 * The ranged variant. The 砲 never leaves its square: the crew hauls, the beam
 * whips, a stone flies on a visible arc, and the impact is where beats two and
 * three happen. Times are absolute, on the same clock as `CAPTURE`.
 */
export const RANGED = {
  haulStart: 0.0,
  /** The beam lets go. */
  release: 0.61,
  /** Flight time of the stone. Long enough that the arc is legible. */
  flight: 0.74,
  impact: 1.35,
  /** Apex of the arc above the straight line between muzzle and target. */
  arcHeight: 1.65,
  /** Beam swing, radians, and how long the whip takes. */
  beamSwing: 2.05,
  beamTime: 0.21,
  /** The crew's recovery after the shot. */
  recover: 0.52,
} as const;

// ===========================================================================
// Ordinary moves
// ===========================================================================

export const WALK = {
  /** Seconds per world unit travelled, per gait. */
  secondsPerUnit: {
    march: 0.62,
    stride: 0.68,
    canter: 0.37,
    lumber: 0.79,
    roll: 0.41,
    crew: 0.86,
  } as Record<GaitName, number>,
  /** Acceleration and deceleration ramps, as a fraction of the move. */
  rampIn: 0.22,
  rampOut: 0.31,
  /** Minimum and maximum duration of any single move, whatever the distance. */
  minSeconds: 0.46,
  maxSeconds: 2.9,
  /**
   * How far ahead of the body the facing turns, in seconds. Hips before
   * shoulders before head: the root yaw leads, the spine follows it by
   * `turnSpineLag`, the head by `turnHeadLag`.
   */
  turnLead: 0.14,
  turnSpineLag: 0.075,
  turnHeadLag: 0.135,
  /** Yaw rate ceiling, rad/s, so a knight's turn is a turn and not a snap. */
  turnRate: 4.6,
  /** Settle after arrival before the promise resolves. */
  settle: 0.27,
} as const;

// ===========================================================================
// Formation march-in
// ===========================================================================

export const FORMATION = {
  /** Total wall time for the whole march-in when nothing is skipped. */
  total: 9.74,
  /** Gap between successive units entering. */
  stagger: 0.163,
  /** How long one unit takes to walk from off-board to its square. */
  perUnit: 3.42,
  /** How far off-board a unit starts, in world units beyond its own back rank. */
  offBoard: 4.6,
  /** Salute once arrived; the whole army holds it briefly before the game starts. */
  saluteAt: 8.31,
  /** A skip snaps everything to its final pose over this long. */
  skipSnap: 0.24,
} as const;

/**
 * Formation order. Units arrive rank by rank rather than all at once, and the
 * general arrives last so the eye finishes on him. Front rank first is not
 * decorative: it is how a marching column arrives, nearest file leading.
 */
export const FORMATION_ORDER: readonly string[] = [
  'soldier',
  'cannon',
  'chariot',
  'horse',
  'elephant',
  'advisor',
  'general',
];

// ===========================================================================
// The terminal set piece
// ===========================================================================

export const FINALE = {
  /** The losing general's collapse begins after the camera has settled. */
  generalFallAt: 0.68,
  /** The winning army raises weapons in a ripple, this far apart. */
  raiseStagger: 0.117,
  raiseFrom: 1.94,
  /** The gong. */
  gongAt: 2.31,
  total: 6.83,
} as const;

// ===========================================================================
// Inverse kinematics
// ===========================================================================

export const IK = {
  /** A target within this many rig units counts as reached exactly. */
  tolerance: 1e-6,
  /**
   * Fraction of full extension the solver will not exceed. A limb locked dead
   * straight has no silhouette and no bend plane, and the next frame's solve
   * flips it; holding a couple of degrees back costs nothing.
   */
  maxExtension: 0.995,
  /** And the other end: never fold tighter than this fraction of full fold. */
  minExtension: 1.02,
  /** Look-at chains: how much of the remaining error each bone takes. */
  aimShare: 0.55,
  /** Per-bone clamp on a look-at, radians. */
  aimClamp: 0.62,
  /** Neck and head shares of a head turn. The head does most of it, late. */
  neckShare: 0.38,
  headShare: 0.72,
  /** How fast a look-at target is chased, per second. */
  aimRate: 7.4,
  /**
   * Contact solve: how much of a locked foot's over-extension is taken out of
   * the root rather than by stretching the leg. 1.0 is physically correct and
   * makes the hips dip hard on a long stride; 0.82 keeps the dip readable
   * without the figure squatting.
   */
  hipGive: 0.82,
  /** Iterations of the hip solve. One is enough at walking speeds; two is safe. */
  hipIterations: 2,
  /** A foot enters stance when its stance weight rises past this. */
  plantThreshold: 0.5,
  /** Blend in and out of a lock, in cycle phase, so a plant is not a snap. */
  plantBlend: 0.08,
  /** Toe-off releases the lock this far before the swing formally starts. */
  releaseLead: 0.04,
} as const;

// ===========================================================================
// Pigment dispersal
// ===========================================================================

export const PIGMENT = {
  /** Hard ceiling on live chips. The pool is allocated once at this size. */
  budget: 900,
  /** Chips per unit, scaled by the unit's bounding volume. */
  chipsBase: 46,
  chipsPerVolume: 58,
  chipsMax: 190,
  /** Chip size in world units, before per-chip variation. */
  chipSize: 0.052,
  chipSizeJitter: 0.55,
  /** Initial burst speed, world units per second. */
  speed: 1.85,
  speedJitter: 0.62,
  /** Extra speed along the impact direction. */
  impulseGain: 1.35,
  /** Gravity, world units per second squared. Lighter than real: this is powder. */
  gravity: 4.6,
  /**
   * Quadratic drag coefficient. A flat chip has a lot of area for its mass, so
   * it decelerates fast and then flutters down rather than falling ballistically
   * — that flutter is the whole difference between pigment and confetti.
   */
  drag: 1.42,
  /** Angular speed at birth, rad/s. */
  spin: 7.3,
  spinJitter: 0.8,
  /** Angular drag, per second. */
  spinDamp: 1.35,
  /** Restitution on the board. Mineral powder barely bounces. */
  bounce: 0.22,
  /** Tangential friction on a bounce. */
  friction: 0.62,
  /** Below this speed a chip is considered at rest and stops integrating. */
  restSpeed: 0.055,
  /** How long a resting chip takes to sink into the silk. */
  fade: 1.35,
  /** How long the chip lies at rest before the fade starts. */
  linger: 0.72,
  /** Maximum life, a backstop so nothing can leak. */
  maxLife: 7.5,
  /** Weight of each pigment band in the chip colour draw, darkest first. */
  bandWeights: [0.34, 0.38, 0.2, 0.08] as readonly number[],
} as const;

/** The cannon's stone: a projectile and its burst. */
export const PROJECTILE = {
  radius: 0.085,
  /** Chips thrown by the burst on impact. */
  burstChips: 74,
  burstSpeed: 3.1,
  /** Spin of the stone in flight, rad/s. */
  spin: 5.2,
} as const;

// ===========================================================================
// Helpers
// ===========================================================================

/** Seconds a move of `distance` world units should take at this gait. */
export function walkSeconds(gait: GaitName, distance: number): number {
  const raw = WALK.secondsPerUnit[gait] * distance;
  return clamp(raw, WALK.minSeconds, WALK.maxSeconds);
}

/** Total length of the melee capture, including the frozen-time hold. */
export const CAPTURE_TOTAL = CAPTURE.settleEnd + CAPTURE_HOLD;

/** Total length of the ranged capture. */
export const RANGED_TOTAL = RANGED.impact + (CAPTURE.settleEnd - CAPTURE.contact) + CAPTURE_HOLD;
