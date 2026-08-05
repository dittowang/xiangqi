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
 * for a biped) as a multiple of the figure's **hip-to-ankle** length. Expressing
 * it that way is what makes the gait retarget: a 0.60-scale conscript and a
 * 1.12-scale general take the same number of steps per square only if their
 * strides scale with their legs, and they do not otherwise.
 *
 * The ceiling on `strideOverLeg` is geometry, not taste. The foot plants
 * `duty/2` of a stride ahead of the hip, and the hip has to stay within the
 * leg's reach of it; anything past about 1.1 forces a pelvis dip deep enough to
 * read as a crouch. The numbers below sit just under that, so the small dip the
 * contact solver produces at heel strike is the real one a walk has rather than
 * a symptom.
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
  /**
   * Vertical travel of the pelvis over a cycle, **peak to peak**, in statures.
   *
   * Peak to peak, not amplitude: it is what a critic measures — the difference
   * between the highest and lowest pelvis in one cycle — so it is what the
   * number has to mean, and the clip halves it to get the amplitude it writes.
   * Read as an amplitude it is exactly twice as much motion as it says, which
   * is how a 2.1% authored bob measured 5.9% of stature and read as a duck
   * walk. The contact solver's dip at heel strike sits on top of this and is
   * *not* included, so the measured figure is always a little over `bob`.
   */
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
    strideOverLeg: 1.32,
    duty: 0.62,
    contactL: 0.5,
    contactR: 0.0,
    lift: 0.052,
    seated: false,
    bob: 0.021,
  },
  /**
   * The robed walk. Longer double support, shorter steps, and a bob small
   * enough that the hem does not pump — the brief's "almost no vertical bob".
   */
  stride: {
    name: 'stride',
    cycle: 1.19,
    strideOverLeg: 1.10,
    duty: 0.66,
    contactL: 0.5,
    contactR: 0.0,
    lift: 0.031,
    seated: false,
    bob: 0.0058,
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
    strideOverLeg: 0.76,
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
  /**
   * The corpse's exit, measured from the end of the collapse rather than from
   * the pigment window — the two are different lengths and the body is the one
   * the eye is on. `CLIP.death` is 2.37 s from `knockbackEnd`, which puts the
   * body on the board at 4.10; the dispersal used to end at 3.94, so the flag
   * that hid the figure fired while it was **still falling**, and what a viewer
   * saw was a kneeling man vanishing between two frames.
   *
   * So: it lands, it lies there for `corpseLinger`, and then it goes down into
   * the silk over `corpseSink` — under the board, occluded by it, gone before
   * anything is switched off. The pigment field is not bound to any of this; its
   * chips outlive the sequence and settle on their own clock.
   */
  corpseLinger: 0.23,
  corpseSink: 0.81,
  /** Everything at rest; the promise resolves here. */
  settleEnd: 5.31,

  /** Camera push strength and the impulse fired at contact. */
  impulse: 0.86,
  /** Flash strength at contact, 0..1. */
  flash: 0.92,
  /** How long the attacker's follow-through holds before it returns to idle. */
  recover: 0.44,
  /**
   * Fallback for how far the attacker advances toward the defender, as a
   * fraction of the gap, used only for a figure with no animator to measure.
   *
   * The real fraction is derived per exchange from the attacker's **reach** —
   * `Animator.strikeReach`, measured off its own strike clip — and the two
   * figures' `meta.size`. One fraction cannot serve the cast: at 0.58 of a
   * one-square gap a 兵 stopped 416 mm short of the man he was stabbing, which
   * is 42% of a square and three quarters of his own height, and the frame that
   * fires the flash was a frame in which nothing touched.
   *
   * `OTS_CONTACT_FRACTION` in @scene/camera.ts mirrors this number to frame the
   * exchange as it will be at contact. It is a framing heuristic and it stays a
   * mirror of the fallback, not of the derived value.
   */
  approachFraction: 0.58,
  /**
   * Bounds on the derived fraction. The floor keeps a long-reaching attacker
   * (a 象 at arm's length over one square) from standing still; the ceiling
   * keeps anything from arriving on top of its victim.
   */
  approachMin: 0.12,
  approachMax: 0.92,
  /**
   * How far past the defender's torso surface the blow is driven, world units.
   *
   * Contact has to be unambiguous in the still: at exactly the surface the tip
   * and the silhouette are tangent, and a tangent reads as a near miss. 50 mm
   * of bite puts the point inside the outline, where the flash and the pigment
   * burst have something to come out of.
   */
  contactBite: 0.05,
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
  /**
   * Fallback stride, world units per cycle, for a caller that cannot name the
   * figure that is walking.
   *
   * **There is no seconds-per-unit table any more, and there must not be one.**
   * A gait's ground speed is not a free parameter: a figure that plants its
   * feet `stride` apart and cycles once every `cycle` seconds travels
   * `stride / cycle` and nothing else. Authoring the two independently is what
   * produced the defect this table replaces — 0.62 s per unit against a 0.31 m
   * stride is 1.61 u/s, which is 5.4 cycles a second where the gait says 0.97,
   * i.e. the 兵 crossed a square in six scurrying steps at 2.99 statures per
   * second. The phase came from the ground (correctly — that is what keeps the
   * foot lock exact), so the *cadence* was simply whatever the traversal speed
   * made it.
   *
   * These are the strides the shipped cast actually has, measured off the rig:
   * they exist only so `walkSeconds` has an answer when no animator is at hand.
   * Every real call passes the animator's own `stride`, which is derived from
   * that figure's leg — or, for a mount, from the animal's hip height — so the
   * retarget survives.
   */
  referenceStride: {
    march: 0.3075,
    stride: 0.2980,
    canter: 0.9428,
    lumber: 0.8345,
    roll: 1.9674,
    crew: 0.2125,
  } as Record<GaitName, number>,
  /**
   * Acceleration and deceleration ramps, as a fraction of the move.
   *
   * They are shorter than they were (0.22 / 0.31) because with a travel-driven
   * gait a speed ramp is a *cadence* ramp: the stride is fixed in the ground, so
   * a figure at 1.36× its mean speed mid-move is a figure taking 1.36× its
   * cadence there, and the cruise is where a critic counts footfalls. Halving
   * the ramps costs nothing legible — the trapezoid still starts and stops the
   * piece rather than cutting it into motion — and buys back most of the gap
   * between the mean and the peak.
   */
  rampIn: 0.12,
  rampOut: 0.16,
  /**
   * Minimum and maximum duration of any single move, whatever the distance.
   *
   * The ceiling is a *cadence* decision, not a pacing one. Inside it a piece
   * walks at its own gait's speed and its cadence is exactly the authored one;
   * past it — an 象 crossing two squares diagonally, a 俥 running the file —
   * the move is compressed and the figure picks the pace up, which is what
   * anyone with a long way to go does. 3.95 s covers a 兵's square (3.90 s at a
   * 116-per-minute quick march) with nothing to spare, so the commonest move in
   * the game is the one that lands on its authored cadence exactly.
   */
  minSeconds: 0.46,
  maxSeconds: 3.95,
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
  /**
   * Settle after arrival before the promise resolves. Long enough to contain
   * both halves of the closing step — the feet come down one at a time, and a
   * move that resolved between them would hand the next sequence a figure
   * standing on one foot.
   */
  settle: 0.36,
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
   * the root rather than by leaving the leg over-extended.
   *
   * It is 1.0 and it has to be. Anything less leaves the ankle short of its
   * plant by the uncorrected fraction, and "short of its plant" measured frame
   * to frame is exactly foot slide — at 0.82 it measured 3.3 mm a frame, which
   * is small, visible, and the defect the whole system exists to prevent. The
   * price is that the pelvis dips the full geometric amount at heel strike,
   * which is what a pelvis does.
   */
  hipGive: 1.0,
  /** Iterations of the hip solve. One is enough at walking speeds; two is safe. */
  hipIterations: 2,
  /** A foot enters stance when its stance weight rises past this. */
  plantThreshold: 0.5,
  /** Toe-off releases the lock this far before the swing formally starts. */
  releaseLead: 0.04,
  /**
   * Heel-off. Fraction of stance after which the foot begins pivoting about its
   * toe, and how far it pivots by toe-off, in radians.
   *
   * This is not a flourish. A rig whose bind pose has near-straight legs — which
   * is every standing figure, this one included — can only reach a foot planted
   * `A` in front of its hip by dropping the pelvis, and the drop needed for a
   * natural stride is a visible squat. Real walking solves it by raising the
   * *ankle* over a fixed toe at push-off, which shortens the trailing limb's
   * reach requirement without moving the contact point at all. With heel-off the
   * stride is a stride; without it, it is a shuffle or a duck walk, and there is
   * no third option.
   */
  heelOffAt: 0.62,
  heelRise: 0.46,
  /** Where along the foot the contact point sits, as a fraction of foot length. */
  toeAt: 0.86,
  /**
   * How far in front of the hip the ankle plants, as a fraction of a stride.
   * The identity `ahead + behind = duty × stride` is fixed by the kinematics;
   * this is the split, and it is asymmetric because heel-off lets the trailing
   * limb reach further back than the leading one reaches forward.
   */
  plantAhead: 0.26,
  /**
   * Hoof contact. Fraction of a quadruped's stance spent blending the contact
   * solve in at touchdown and out at toe-off.
   *
   * A hoof is not an ankle: there is no heel-off to buy reach with, and the
   * drive curve — not a predicted plant — decides where the hoof arrives. So the
   * solver takes the leg over just after the hoof is down and hands it back just
   * before it leaves, and the drive curve owns both ends. 0.22 is a shade over a
   * frame at a canter and about three at a lumber, which is short enough to read
   * as a plant and long enough not to snatch.
   */
  hoofBlend: 0.22,
  /**
   * Ceiling on the stance sweep of a mount's upper leg bone, radians. The sweep
   * is otherwise derived from the stride, and a stride long enough to need more
   * than this is a stride the leg cannot serve however hard the knee bends.
   */
  hoofSwingMax: 0.78,
  /**
   * How far the mount's barrel may drop to keep a hoof within reach, as a
   * fraction of the animal's hip height — the quadruped's half of `hipGive`.
   *
   * It is not optional. A horse's fore leg is a *column*: shoulder, carpus and
   * fetlock are within a millimetre of collinear in the bind pose, and an
   * elephant's four legs are the same by design. A column has no slack, so a
   * two-bone solve asked to hold a hoof the body has already travelled past has
   * nothing to give and the hoof drags instead. The barrel dropping is what
   * buys the reach, it is what a real animal does, and it is where the vertical
   * component of a canter comes from in the first place.
   *
   * It is 0.055 and not 0.18 because the give is paid for by every leg, not
   * only by the one that needed it. The barrel carries all four; a drop deep
   * enough to rescue the worst-placed planted hoof takes the three that were
   * fine down with it, and a hoof in swing — which the contact solver does not
   * hold, by design — has nothing to stop it going through the board. At 0.18
   * of hip height that was 100 mm of seat drop and the near fore hoof reached
   * 113 mm *below* the silk mid-canter. 0.055 is 30 mm on the 馬: still the
   * settle that keeps a stance hoof reachable, no longer a collapse. The floor
   * clamp in `resolveQuadContacts` is the belt to this brace.
   */
  mountGive: 0.055,
  /** How fast that drop follows its target, per second. */
  mountGiveRate: 26,
  /**
   * The brace. How far a figure setting itself against an incoming blow drops
   * its pelvis and shifts it back, in statures, at full brace.
   *
   * The drop is the whole mechanism: the feet are locked to the board, so
   * lowering the root bends the knees for free and the crouch comes out of the
   * contact solver rather than out of a pose. 2.2% of stature is 12 mm on a 兵
   * — a *set*, not a squat.
   */
  braceDrop: 0.022,
  braceBack: 0.016,
  /** And the trunk's share of it, radians of forward lean at full brace. */
  braceLean: 0.16,
} as const;

// ===========================================================================
// Pigment dispersal
// ===========================================================================

export const PIGMENT = {
  /** Hard ceiling on live chips. The pool is allocated once at this size. */
  budget: 900,
  /**
   * Chips per unit, scaled by the unit's bounding volume.
   *
   * A 兵 throws about 200 of them. Sixty-eight was a *scatter* — the eye counted
   * the pieces, and a body that comes apart into sixty-eight countable objects
   * reads as a broken pot rather than as pigment leaving silk. Tripling the
   * count and halving the chip is the same volume of mineral and a different
   * event.
   */
  chipsBase: 132,
  chipsPerVolume: 210,
  chipsMax: 320,
  /**
   * Chip size in world units, before per-chip variation.
   *
   * 0.021 against a 0.54-unit figure is 3.9% of stature — a flake, at the scale
   * ground mineral actually comes in. At 0.052 it was a tenth of the figure's
   * height, which is a *tile*: the burst read as a statue shattering, and the
   * individual chips were large enough to hold their own silhouettes on the
   * board afterwards instead of settling into a wash.
   */
  chipSize: 0.021,
  chipSizeJitter: 0.62,
  /**
   * Chip thickness, as a fraction of its own half-width. A flake of ground
   * mineral is *thin* — this is what stops the chip reading as a solid — but
   * not infinitely thin: a zero-thickness quad vanishes edge-on mid-tumble and
   * z-fights the silk once it is lying on it. Six or seven per cent of the
   * chip's width is the width of a fingernail paring at this scale.
   */
  chipThickness: 0.13,
  /**
   * Depth of the fold along the chip's long diagonal, as a fraction of its
   * half-width. The fold is a *crease* — a straight ridge across a flat flake,
   * each of its two facets lying about eight degrees off the other's plane —
   * and it is what gives a tumbling
   * chip a hard value break instead of a smooth gradient. It is emphatically
   * not a lift of the centre: doing that to a fan of triangles builds a cone,
   * and a field of cones standing point-up on the board reads as caltrops.
   */
  chipFold: 0.15,
  /**
   * How far a chip lying at rest may tip out of the board's plane, radians,
   * about each of the two horizontal axes. A field at exactly zero reads as a
   * decal; four degrees is enough to break that and small enough that the chip
   * can still be laid nearly flush against the silk rather than propped clear of
   * it on a raised corner.
   */
  chipRestTilt: 0.07,
  /** Initial burst speed, world units per second. */
  speed: 1.62,
  speedJitter: 0.62,
  /** Extra speed along the impact direction. */
  impulseGain: 1.02,
  /**
   * Upward bias at birth, as a fraction of `speed`. A body coming apart throws
   * pigment *outward*; this is only the small share of it that goes up. It used
   * to be 0.35, which — on top of the blow's own vertical component — launched
   * the whole burst as a fountain, and a fountain has to come down before it can
   * land. Everything the eye reads as pigment happens on the board.
   */
  loft: 0.14,
  /**
   * Gravity, world units per second squared.
   *
   * Below real, because a chip is powder and the drag term below is what carries
   * the flutter — but not *far* below. At 4.6 against a drag of 1.42 the terminal
   * velocity was 1.8 u/s, and a burst thrown 0.9 units into the air took a second
   * and a half to come back: the dispersal window closed with the cluster still
   * hanging over the corpse. The chips have to be down, bounced and at rest well
   * inside `CAPTURE.disperseEnd`, and this is the number that decides it.
   */
  gravity: 9.4,
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
  /** Restitution on the board. Mineral powder barely bounces — but it does. */
  bounce: 0.3,
  /** Tangential friction on a bounce. */
  friction: 0.52,
  /**
   * Tangential friction per second while a chip is sliding along the board
   * between bounces. Without it a chip that lands almost flat keeps its whole
   * horizontal speed and skates until it happens to bounce again, which reads as
   * a chip on ice rather than a chip on silk.
   */
  slide: 5.2,
  /** Below this speed a chip is considered at rest and stops integrating. */
  restSpeed: 0.085,
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
  /**
   * Apex height as a multiple of a third of the shot's length. A 砲 is a
   * traction trebuchet, not a mortar: the arc has to clear the pieces between
   * without leaving frame, and this is the number that decides that.
   */
  arcScale: 1.0,
  /** Chips thrown by the burst on impact. Same cloud as a body's, smaller. */
  burstChips: 168,
  burstSpeed: 3.1,
  /** Spin of the stone in flight, rad/s. */
  spin: 5.2,
} as const;

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Ground speed of a gait, world units per second, for a figure whose cycle
 * covers `stride` world units.
 *
 * One line, and it is the whole contract between the gait plan and the
 * choreographer: **a cycle covers a stride, and a cycle takes `cycle` seconds.**
 * Nothing else is allowed to set how fast a piece crosses the board.
 */
export function gaitSpeed(gait: GaitName, stride?: number): number {
  const s = stride && stride > 1e-4 ? stride : WALK.referenceStride[gait];
  return s / GAIT[gait].cycle;
}

/**
 * Mean fraction of the cruise speed a whole move averages, given its ramps.
 *
 * `travelEase` is a trapezoid: the piece accelerates over `rampIn`, holds, and
 * decelerates over `rampOut`, and the area under that profile is
 * `1 − (rampIn + rampOut)/2` of a constant-speed move. A move sized on its mean
 * speed therefore *cruises* faster than the gait says — 1.36× with the old
 * ramps — and since the phase comes from the ground, cruising fast is cadence
 * fast. Sizing the move on the cruise instead puts the authored cadence in the
 * middle of the move, where it is seen and where it is measured.
 */
export const RAMP_MEAN = 1 - (WALK.rampIn + WALK.rampOut) / 2;

/**
 * Seconds a move of `distance` world units should take at this gait.
 *
 * Pass the walking figure's own `stride` — `Animator.stride` — whenever there
 * is one. Without it the gait's reference stride is used, which is right for
 * the cast that shipped and wrong for anything reproportioned.
 */
export function walkSeconds(gait: GaitName, distance: number, stride?: number): number {
  const raw = distance / (gaitSpeed(gait, stride) * RAMP_MEAN);
  return clamp(raw, WALK.minSeconds, WALK.maxSeconds);
}

/**
 * Length of the melee capture *after* the attacker has arrived, including the
 * frozen-time hold.
 *
 * A floor, not a total: beat 1 is a real walk at the attacker's own gait, so a
 * 兵 taking the man in front of it and a 俥 charging four squares to do the same
 * thing are not the same length of exchange, and neither of them is this number.
 * `Choreography.capture` adds the walk-in on top; `Sequence.duration` is the
 * only authority on how long one particular exchange runs.
 */
export const CAPTURE_TOTAL = CAPTURE.settleEnd + CAPTURE_HOLD;

/** Total length of the ranged capture. */
export const RANGED_TOTAL = RANGED.impact + (CAPTURE.settleEnd - CAPTURE.contact) + CAPTURE_HOLD;
