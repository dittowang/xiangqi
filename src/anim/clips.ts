/**
 * Procedural keyframe generation.
 *
 * Every animation in this project is emitted here as `THREE.KeyframeTrack` data
 * and driven by an `AnimationMixer`. Nothing is imported, nothing is hand-keyed
 * in a DCC tool, and nothing is a whole-body sine.
 *
 * ## The authoring space
 *
 * Clips are authored **normalised** and retargeted by proportion:
 *
 *   - **Rotations** are proportion-independent by construction. The rig's bind
 *     rotations are identity, so a rotation authored for `foreArmR` means the
 *     same joint angle on a 0.60-scale conscript and a 1.60-scale charioteer.
 *     These become quaternion tracks and are shared, unmodified, by all 32
 *     figures — one baked clip per (unit, state) for the whole cast.
 *   - **Root translation** is authored in *statures* (fractions of the figure's
 *     standing height) and is therefore the one thing that must be scaled per
 *     unit. It is emitted as a separate `RootCurve` rather than a track, and the
 *     animator multiplies it by the figure's height in its retarget pass. That
 *     also leaves the root free for the contact solver to correct afterwards
 *     without fighting the mixer for the same property.
 *
 * ## Sign conventions
 *
 * Rig axes: **+X is the figure's right, +Y is up, −Z is forward.** Bind
 * rotations are identity, so a bone's local axes are these axes. Everything
 * below follows from that:
 *
 *   | rotation | effect |
 *   |---|---|
 *   | `+X` on a spine bone | leans **back** |
 *   | `+X` on `thigh` | hip flexion, knee travels **forward** |
 *   | `−X` on `shin` | knee flexion, heel travels **back** |
 *   | `+X` on `foot` | dorsiflexion — toe up, **heel strike** |
 *   | `+X` on `upperArm` | arm swings **forward** |
 *   | `+X` on `foreArm` | elbow flexion, hand travels **forward** |
 *   | `+Y` anywhere | turns to the figure's **left** |
 *   | `+Z` anywhere | tips the top toward the figure's **left** |
 *
 * ## Sequencing
 *
 * The rule the whole file is built on: **joints lead and lag.** A turn starts at
 * the hips, reaches the shoulders 60–90 ms later and the head later still; a
 * strike drives from the pelvis, then the shoulder, then the elbow, and the
 * weapon tip arrives last. That is done here by giving each channel its own
 * start time inside the same normalised window, never by phase-shifting one
 * curve across the whole body.
 *
 * ## Twist
 *
 * Linear blend skinning cannot preserve volume under limb twist, so no clip in
 * this file rolls a forearm or a shin about its own axis by more than ~25°.
 * Where a real body would twist — a sword cut across the front, a spear thrust —
 * the rotation is put in the shoulder and the spine, which have the mass to
 * carry it and the skin weights to survive it.
 */

import * as THREE from 'three';
import { BONE_ORDER, type AnimState, type BoneName } from '@core/contracts.ts';
import { seedFor, type Rng } from '@core/rng.ts';
import type { UnitKey } from '@core/types.ts';
import { CLIP, EASE, GAIT, LUMBER, ROLL, type EaseName, type GaitName, type GaitPlan } from './timing.ts';

// ===========================================================================
// Bone indexing and the pose buffer
// ===========================================================================

const BONE_COUNT = BONE_ORDER.length;

const BI: Record<BoneName, number> = (() => {
  const o = {} as Record<BoneName, number>;
  BONE_ORDER.forEach((n, i) => (o[n] = i));
  return o;
})();

/**
 * One frame of authored motion: an Euler triple per bone plus a root offset.
 *
 * Euler rather than quaternion because a human authoring "the elbow bends 40°"
 * is thinking in axis angles, and the conversion to quaternions happens once at
 * bake time where gimbal order stops mattering — the *interpolation* between
 * baked frames is slerp, so the usual Euler complaints do not apply.
 */
export interface Pose {
  /** `BONE_COUNT × 3` Euler XYZ angles, radians. */
  e: Float64Array;
  /** Root offset in statures: [right, up, back]. */
  root: Float64Array;
}

export function makePose(): Pose {
  return { e: new Float64Array(BONE_COUNT * 3), root: new Float64Array(3) };
}

function clearPose(p: Pose): void {
  p.e.fill(0);
  p.root[0] = 0;
  p.root[1] = 0;
  p.root[2] = 0;
}

/** Add an Euler triple to a bone. Poses are built by accumulation, never assignment. */
function add(p: Pose, b: BoneName, x: number, y = 0, z = 0): void {
  const i = BI[b] * 3;
  p.e[i] += x;
  p.e[i + 1] += y;
  p.e[i + 2] += z;
}

/** Mirror-aware add: `side` is 'L' or 'R', and Y/Z flip on the left. */
function addSide(p: Pose, stem: string, side: 'L' | 'R', x: number, y = 0, z = 0): void {
  const s = side === 'L' ? -1 : 1;
  add(p, (stem + side) as BoneName, x, y * s, z * s);
}

// ===========================================================================
// Wave shapes
// ===========================================================================

const TAU = Math.PI * 2;

/** Wrap into [0, 1). */
function wrap01(t: number): number {
  return t - Math.floor(t);
}

/**
 * Breathing. Not a sine: an inhale is faster than an exhale, and that asymmetry
 * is most of what makes an idle read as alive rather than as an oscillator.
 * Returns −1 (fully exhaled) to +1 (fully inhaled), smooth at both joins.
 */
export function breath(phase: number, inhale = 0.42): number {
  const p = wrap01(phase);
  if (p < inhale) return -Math.cos(Math.PI * (p / inhale));
  return Math.cos(Math.PI * ((p - inhale) / (1 - inhale)));
}

/** A gaussian bump on a wrapped cycle, peaking at `at` with half-width `w`. */
function bump(p: number, at: number, w: number): number {
  let d = wrap01(p) - at;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  const u = d / w;
  return Math.exp(-u * u);
}

/** A one-sided ramp: 0 before `a`, 1 after `b`, eased between. */
function ramp(t: number, a: number, b: number, ease: EaseName = 'inOutCubic'): number {
  if (t <= a) return 0;
  if (t >= b) return 1;
  return EASE[ease]((t - a) / (b - a));
}

export type Key = [t: number, v: number, ease?: EaseName];

/**
 * Piecewise curve through control points. The ease named on a key governs the
 * segment *arriving* at it, which is how motion is described out loud ("it
 * settles into the top of the windup") and keeps the authoring readable.
 */
export function curve(t: number, keys: Key[]): number {
  const n = keys.length;
  if (n === 0) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < n; i++) {
    const [t1, v1, e1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      const span = t1 - t0;
      const u = span > 1e-9 ? (t - t0) / span : 1;
      return v0 + (v1 - v0) * EASE[e1 ?? 'inOutCubic'](u);
    }
  }
  return keys[n - 1][1];
}

// ===========================================================================
// The unit's motion identity
// ===========================================================================

/**
 * Each unit attacks as what it is. These are seven *different actions*, not one
 * swing with seven amplitude sets — the pose functions for each are written out
 * separately below.
 */
export type AttackStyle =
  | 'thrust' // 兵/卒 — a short spear driven from the hips
  | 'cutDown' // 傌/馬 — a cut from the saddle, down and across
  | 'rollThrough' // 俥/車 — it does not stop and swing; it rolls through
  | 'trunkSweep' // 相/象 — the trunk sweeps; the mahout only braces
  | 'parryRiposte' // 仕/士 — a parry that becomes a straight riposte
  | 'closeStrike' // 帥/將 — economical, at contact range, all weight
  | 'hauledShot'; // 炮/砲 — the crew hauls the ropes down and the beam whips

export interface UnitMotion {
  attack: AttackStyle;
  /** How much the right arm swings while walking. 0 = it is carrying something. */
  swingR: number;
  swingL: number;
  /** Extra forward lean carried through every clip, radians. */
  lean: number;
  /** Which hand raises on victory. */
  raise: 'R' | 'L';
}

export const UNIT_MOTION: Record<UnitKey, UnitMotion> = {
  // The 戈 is shouldered on the march, so only the left arm swings.
  soldier: { attack: 'thrust', swingR: 0.12, swingL: 1.0, lean: 0.03, raise: 'R' },
  // Robed, hands carried in front; the sleeves do the moving, not the arms.
  advisor: { attack: 'parryRiposte', swingR: 0.22, swingL: 0.26, lean: 0.0, raise: 'R' },
  // The 節 of authority is held still. A general does not swing his arms.
  general: { attack: 'closeStrike', swingR: 0.08, swingL: 0.34, lean: -0.02, raise: 'R' },
  // Both hands live on the beam.
  cannon: { attack: 'hauledShot', swingR: 0.05, swingL: 0.05, lean: 0.06, raise: 'R' },
  horse: { attack: 'cutDown', swingR: 0.0, swingL: 0.0, lean: 0.0, raise: 'R' },
  elephant: { attack: 'trunkSweep', swingR: 0.0, swingL: 0.0, lean: 0.0, raise: 'R' },
  chariot: { attack: 'rollThrough', swingR: 0.0, swingL: 0.0, lean: 0.0, raise: 'R' },
};

export interface AuthorCtx {
  key: UnitKey;
  gait: GaitName;
  plan: GaitPlan;
  motion: UnitMotion;
  /** Legs are on a mount: no walk cycle, only absorption. */
  seated: boolean;
  /** Direction the hit impulse came from, radians. 0 = from directly ahead. */
  hitFrom: number;
  rng: Rng;
}

// ===========================================================================
// Shared body layers
// ===========================================================================

/**
 * The breath layer. Used by idle, by the victory hold and by every one-shot's
 * tail, so a held pose is never actually still.
 *
 * The rise runs *through* the spine with a lag per segment and is cancelled at
 * the neck, so the head does not nod with the chest — a nodding head is the tell
 * that a breath was applied to the whole body at once.
 */
function breathLayer(p: Pose, phase: number, gain = 1): void {
  const b0 = breath(phase);
  const b1 = breath(phase - 0.05);
  const b2 = breath(phase - 0.09);
  add(p, 'spine01', 0.0105 * gain * b0);
  add(p, 'spine02', 0.0158 * gain * b1);
  add(p, 'neck', -0.0092 * gain * b2);
  add(p, 'head', 0.0055 * gain * breath(phase - 0.14));
  // Clavicles lift a little on the inhale; without it the chest reads as a box.
  add(p, 'clavicleL', 0.008 * gain * b1, 0, 0.006 * gain * b1);
  add(p, 'clavicleR', 0.008 * gain * b1, 0, -0.006 * gain * b1);
  p.root[1] += 0.0031 * gain * b1;
}

/**
 * A standing weight shift. `w` is −1 (all weight on the left foot) to +1 (all on
 * the right). Pelvis, spine and head each take their share with a lag, and the
 * unloaded knee softens — which is the actual mechanism, rather than a lateral
 * translation of the whole figure.
 */
function weightShift(p: Pose, w: number, wLag: number, seated: boolean): void {
  const loadR = (w + 1) * 0.5;
  p.root[0] += 0.0141 * w;
  add(p, 'pelvis', 0, 0.010 * w, -0.030 * w);
  add(p, 'spine01', 0, -0.004 * wLag, 0.012 * wLag);
  add(p, 'spine02', 0, 0.010 * wLag, 0.017 * wLag);
  add(p, 'neck', 0, -0.005 * wLag, -0.006 * wLag);
  add(p, 'head', 0, -0.008 * wLag, -0.009 * wLag);
  if (seated) return;
  // The unloaded leg softens; the loaded one carries and straightens.
  addSide(p, 'thigh', 'R', 0.026 * (1 - loadR));
  addSide(p, 'shin', 'R', -0.058 * (1 - loadR));
  addSide(p, 'thigh', 'L', 0.026 * loadR);
  addSide(p, 'shin', 'L', -0.058 * loadR);
  add(p, 'footR', 0.012 * (1 - loadR));
  add(p, 'footL', 0.012 * loadR);
}

// ===========================================================================
// idle
// ===========================================================================

/**
 * Three rates, none of them a multiple of the others in any way the eye can
 * latch onto: two breaths, one weight shift and three head micro-settles per
 * loop, all of different shapes. The result never repeats visibly inside the
 * 7.43 s loop even though it repeats exactly.
 */
function idlePose(p: Pose, phase: number, c: AuthorCtx): void {
  breathLayer(p, phase * 2);

  const w = Math.sin(TAU * phase);
  const wLag = Math.sin(TAU * phase - 0.92);
  weightShift(p, w, wLag, c.seated);

  // The secondary head settle: a small, faster drift that trails the chest and
  // overshoots it slightly. This is the layer that stops an idle reading as a
  // statue with a chest pump.
  const m = Math.sin(TAU * phase * 3 + 1.7);
  const mLag = Math.sin(TAU * phase * 3 + 1.7 - 0.55);
  add(p, 'neck', 0.0042 * m, -0.0055 * mLag, 0);
  add(p, 'head', -0.0061 * mLag, 0.0104 * Math.sin(TAU * phase - 1.35), 0.0035 * m);

  add(p, 'spine01', c.motion.lean);

  if (c.seated) {
    // A rider's idle lives in the seat: the mount breathes under him, so his
    // pelvis rocks a little and his spine takes it out before his head.
    const rock = Math.sin(TAU * phase * 2 + 0.4);
    add(p, 'pelvis', 0.011 * rock);
    add(p, 'spine01', -0.006 * rock);
    add(p, 'neck', -0.003 * rock);
    return;
  }

  // Arms hang and drift with the sway, one frame behind the shoulders.
  for (const s of ['L', 'R'] as const) {
    addSide(p, 'upperArm', s, 0.019 * breath(phase * 2 - 0.1), 0, 0.021 * wLag);
    addSide(p, 'foreArm', s, 0.052 + 0.026 * Math.sin(TAU * phase * 3 + (s === 'L' ? 0.8 : 2.3)));
  }
}

// ===========================================================================
// move — one function per gait family
// ===========================================================================

/** Leg-cycle phase for one foot, 0 at heel strike. */
function legPhase(phase: number, contact: number): number {
  return wrap01(phase - contact);
}

interface LegShape {
  hip: number;
  hip2: number;
  kneeStance: number;
  kneeSwing: number;
  ankleStrike: number;
  ankleToeOff: number;
  ankleSwing: number;
}

/**
 * One leg through one cycle.
 *
 * The hip is near-sinusoidal with a second harmonic that sharpens the flexion
 * peak. The knee has *two* flexion events, not one: a small one absorbing the
 * heel strike and a large one clearing the ground in swing — a single-peak knee
 * is the most common reason a procedural walk reads as a puppet. The ankle
 * strikes dorsiflexed, rolls flat, pushes off plantarflexed, and lifts the toe
 * again to clear.
 */
function walkLeg(p: Pose, side: 'L' | 'R', ph: number, k: LegShape): void {
  const hip = k.hip * (Math.cos(TAU * ph) + k.hip2 * Math.cos(2 * TAU * ph));
  const knee = -(k.kneeStance * bump(ph, 0.15, 0.11) + k.kneeSwing * bump(ph, 0.73, 0.13));
  const ankle =
    k.ankleStrike * bump(ph, 0.02, 0.07) -
    k.ankleToeOff * bump(ph, 0.57, 0.1) +
    k.ankleSwing * bump(ph, 0.8, 0.12);
  addSide(p, 'thigh', side, hip);
  addSide(p, 'shin', side, knee);
  addSide(p, 'foot', side, ankle);
}

/** The pelvis and spine layer shared by every footed gait. */
function walkTorso(p: Pose, phase: number, plan: GaitPlan, amp: number): void {
  // Vertical: two rises per cycle, peaking at each mid-stance.
  p.root[1] += plan.bob * Math.cos(2 * TAU * (phase - 0.28));
  // Lateral: the pelvis travels over whichever foot is carrying.
  p.root[0] += 0.0125 * amp * Math.cos(TAU * (phase - 0.28));

  // Transverse rotation. Hips lead, shoulders counter-rotate 0.06 of a cycle
  // later, the head returns to the line of travel later still. This is the
  // "hips before shoulders before head" rule at walking speed.
  add(p, 'pelvis', 0, 0.078 * amp * Math.cos(TAU * phase), 0);
  add(p, 'spine01', 0, -0.032 * amp * Math.cos(TAU * (phase - 0.03)), 0);
  add(p, 'spine02', 0, -0.086 * amp * Math.cos(TAU * (phase - 0.06)), 0);
  add(p, 'neck', 0, 0.026 * amp * Math.cos(TAU * (phase - 0.11)), 0);
  add(p, 'head', 0, 0.030 * amp * Math.cos(TAU * (phase - 0.15)), 0);

  // Coronal: the swinging side's hip drops, the spine takes it back out so the
  // shoulders stay level, and the head levels last.
  const list = Math.cos(TAU * (phase - 0.28));
  add(p, 'pelvis', 0, 0, -0.044 * amp * list);
  add(p, 'spine01', 0, 0, 0.014 * amp * list);
  add(p, 'spine02', 0, 0, 0.028 * amp * Math.cos(TAU * (phase - 0.34)));
  add(p, 'head', 0, 0, 0.010 * amp * Math.cos(TAU * (phase - 0.42)));
}

/** Opposing arm swing, with the elbow folding more on the forward half. */
function walkArms(p: Pose, phase: number, c: AuthorCtx, amp: number): void {
  for (const s of ['L', 'R'] as const) {
    const gain = (s === 'R' ? c.motion.swingR : c.motion.swingL) * amp;
    // The right arm opposes the right leg, so it is anti-phase with the hip.
    const base = s === 'R' ? phase : phase + 0.5;
    const swing = -0.36 * gain * Math.cos(TAU * (base - 0.02));
    const forward = Math.max(0, Math.cos(TAU * (base + 0.5)));
    addSide(p, 'upperArm', s, swing, 0, 0.018 * gain * Math.cos(TAU * base));
    addSide(p, 'foreArm', s, 0.20 * gain + 0.24 * gain * forward);
    // The hand trails the forearm by a few degrees — the end of a chain always
    // arrives late.
    addSide(p, 'hand', s, 0.10 * gain * Math.cos(TAU * (base - 0.07)));
  }
}

function marchPose(p: Pose, phase: number, c: AuthorCtx): void {
  const plan = c.plan;
  walkTorso(p, phase, plan, 1);
  walkLeg(p, 'R', legPhase(phase, plan.contactR), {
    hip: 0.42,
    hip2: 0.18,
    kneeStance: 0.26,
    kneeSwing: 0.98,
    ankleStrike: 0.21,
    ankleToeOff: 0.34,
    ankleSwing: 0.13,
  });
  walkLeg(p, 'L', legPhase(phase, plan.contactL), {
    hip: 0.42,
    hip2: 0.18,
    kneeStance: 0.26,
    kneeSwing: 0.98,
    ankleStrike: 0.21,
    ankleToeOff: 0.34,
    ankleSwing: 0.13,
  });
  walkArms(p, phase, c, 1);
  add(p, 'spine01', c.motion.lean - 0.045);
  breathLayer(p, phase * 0.5, 0.5);
  // The shouldered 戈 rides on the beat: a small vertical bounce in the carrying
  // arm, half a cycle out of phase with the pelvis, so the haft does not appear
  // welded to the shoulder.
  if (c.motion.swingR < 0.4) {
    add(p, 'upperArmR', 0.9 + 0.028 * Math.cos(2 * TAU * (phase - 0.28)), 0, -0.34);
    add(p, 'foreArmR', 1.24 + 0.03 * Math.cos(2 * TAU * (phase - 0.31)));
  }
}

function stridePose(p: Pose, phase: number, c: AuthorCtx): void {
  const plan = c.plan;
  walkTorso(p, phase, plan, 0.62);
  const shape: LegShape = {
    hip: 0.30,
    hip2: 0.1,
    kneeStance: 0.16,
    kneeSwing: 0.72,
    ankleStrike: 0.13,
    ankleToeOff: 0.24,
    ankleSwing: 0.09,
  };
  walkLeg(p, 'R', legPhase(phase, plan.contactR), shape);
  walkLeg(p, 'L', legPhase(phase, plan.contactL), shape);
  walkArms(p, phase, c, 0.5);
  // Hands carried in front, inside the sleeves: the advisor's whole upper-body
  // read. The forearms stay put and the sleeves swing, so nothing twists.
  add(p, 'upperArmL', 0.20, 0, 0.10);
  add(p, 'upperArmR', 0.20, 0, -0.10);
  add(p, 'foreArmL', 0.62, -0.14, 0);
  add(p, 'foreArmR', 0.62, 0.14, 0);
  add(p, 'spine01', c.motion.lean);
  breathLayer(p, phase * 0.5, 0.7);
}

function crewPose(p: Pose, phase: number, c: AuthorCtx): void {
  const plan = c.plan;
  walkTorso(p, phase, plan, 0.44);
  const shape: LegShape = {
    hip: 0.17,
    hip2: 0.0,
    kneeStance: 0.2,
    kneeSwing: 0.34,
    ankleStrike: 0.06,
    ankleToeOff: 0.11,
    ankleSwing: 0.05,
  };
  walkLeg(p, 'R', legPhase(phase, plan.contactR), shape);
  walkLeg(p, 'L', legPhase(phase, plan.contactL), shape);
  // Both hands stay on the beam, so the arms carry the shuffle instead of
  // swinging: they push and give as the body rocks.
  const rock = Math.cos(TAU * (phase - 0.28));
  for (const s of ['L', 'R'] as const) {
    addSide(p, 'upperArm', s, 0.78 + 0.06 * rock, 0, 0.1);
    addSide(p, 'foreArm', s, 0.34 - 0.09 * rock);
  }
  add(p, 'spine01', c.motion.lean - 0.02 - 0.03 * rock);
  add(p, 'spine02', -0.04);
  add(p, 'neck', 0.09);
  add(p, 'head', 0.06);
  breathLayer(p, phase * 0.7, 1.2);
}

/**
 * The rider at the canter. The horse's three beats are driven on its own bones
 * by the controller; what is authored here is what a rider *does* about them —
 * the pelvis follows the barrel, the spine absorbs most of the pitch, and the
 * head stays level and late.
 */
function canterPose(p: Pose, phase: number, c: AuthorCtx): void {
  const rock = Math.sin(TAU * (phase + 0.12));
  const rockLag = Math.sin(TAU * (phase + 0.12) - 0.5);
  const rise = -Math.cos(2 * TAU * (phase - 0.18));

  p.root[1] += c.plan.bob * rise;
  p.root[2] += 0.010 * rock;

  // The pelvis goes with the horse; each segment up the spine keeps less of it.
  add(p, 'pelvis', 0.19 * rock);
  add(p, 'spine01', -0.11 * rockLag);
  add(p, 'spine02', -0.055 * Math.sin(TAU * (phase + 0.12) - 0.85));
  add(p, 'neck', -0.028 * Math.sin(TAU * (phase + 0.12) - 1.15));
  add(p, 'head', 0.020 * Math.sin(TAU * (phase + 0.12) - 1.55));

  // Legs grip the barrel; the ankle takes the beat.
  for (const s of ['L', 'R'] as const) {
    addSide(p, 'thigh', s, 0.03 * rock, 0, 0.02 * rock);
    addSide(p, 'shin', s, -0.05 - 0.045 * rise);
    addSide(p, 'foot', s, 0.05 * rise);
  }
  // Rein hand steady, weapon hand rising and falling with the seat.
  add(p, 'upperArmL', 0.52 - 0.03 * rockLag, 0, 0.16);
  add(p, 'foreArmL', 0.74);
  add(p, 'upperArmR', -0.12 + 0.05 * rockLag, 0, -0.22);
  add(p, 'foreArmR', 0.42 + 0.04 * rock);
  breathLayer(p, phase * 0.4, 0.6);
}

/** The mahout: a slow lateral roll with the elephant, absorbed in the spine. */
function lumberPose(p: Pose, phase: number, c: AuthorCtx): void {
  const sway = Math.sin(2 * TAU * phase);
  const swayLag = Math.sin(2 * TAU * phase - 0.7);
  const rise = -Math.cos(4 * TAU * phase);

  p.root[0] += 0.020 * sway;
  p.root[1] += c.plan.bob * rise;

  add(p, 'pelvis', 0.02 * rise, 0.02 * sway, -0.10 * sway);
  add(p, 'spine01', -0.014 * rise, 0, 0.055 * swayLag);
  add(p, 'spine02', 0, -0.02 * swayLag, 0.032 * Math.sin(2 * TAU * phase - 1.1));
  add(p, 'neck', 0, 0, -0.020 * Math.sin(2 * TAU * phase - 1.5));
  add(p, 'head', 0, 0.024 * Math.sin(2 * TAU * phase - 1.7), -0.018 * Math.sin(2 * TAU * phase - 1.9));

  for (const s of ['L', 'R'] as const) {
    addSide(p, 'thigh', s, 0.02 * rise);
    addSide(p, 'shin', s, -0.04 - 0.02 * rise);
  }
  // Goad hand high and steady; the other hand rides the rail.
  add(p, 'upperArmR', 0.28 + 0.04 * swayLag, 0, -0.3);
  add(p, 'foreArmR', 0.86);
  add(p, 'upperArmL', 0.42, 0, 0.24);
  add(p, 'foreArmL', 0.55 + 0.05 * sway);
  breathLayer(p, phase * 0.5, 0.9);
}

/**
 * The charioteer. The deck pitches over the axle and rocks on the road; his
 * knees take most of it and his head takes almost none. The deck's own motion
 * lives on `chariot.body`, driven by the controller — this is the crew's half
 * of the same event, and the two are tuned together through `ROLL`.
 */
function rollPose(p: Pose, phase: number, c: AuthorCtx): void {
  const pitch =
    ROLL.pitchA * Math.sin(2 * TAU * phase + 0.6) + ROLL.pitchB * Math.sin(3 * TAU * phase);
  const rock = ROLL.rockA * Math.sin(TAU * phase - 0.4);
  const pn = pitch / (ROLL.pitchA + ROLL.pitchB);

  p.root[1] += c.plan.bob * -Math.cos(2 * TAU * phase);

  // Knees absorb; whatever they do not absorb goes into the pelvis and dies out
  // going up the spine.
  for (const s of ['L', 'R'] as const) {
    addSide(p, 'thigh', s, 0.09 * pn * ROLL.kneeAbsorb, 0, 0.03 * rock);
    addSide(p, 'shin', s, -0.10 - 0.14 * pn * ROLL.kneeAbsorb);
    addSide(p, 'foot', s, 0.05 * pn);
  }
  add(p, 'pelvis', -0.7 * pitch, 0, -0.6 * rock);
  add(p, 'spine01', 0.32 * pitch, 0, 0.28 * rock);
  add(p, 'spine02', 0.14 * pitch, 0, 0.16 * rock);
  add(p, 'neck', -0.06 * pitch);
  add(p, 'head', -0.03 * pitch, 0, -0.05 * rock);

  // Reins in the left, bow hand low in the right, both braced against the rail.
  add(p, 'upperArmL', 0.66, 0, 0.2);
  add(p, 'foreArmL', 0.52 - 0.06 * pn);
  add(p, 'upperArmR', 0.34, 0, -0.14);
  add(p, 'foreArmR', 0.68 - 0.04 * pn);
  breathLayer(p, phase * 0.6, 0.7);
}

const MOVE_POSE: Record<GaitName, (p: Pose, phase: number, c: AuthorCtx) => void> = {
  march: marchPose,
  stride: stridePose,
  canter: canterPose,
  lumber: lumberPose,
  roll: rollPose,
  crew: crewPose,
};

// ===========================================================================
// Attacks — one vocabulary per unit
// ===========================================================================

/**
 * Attack pose functions take a single progress value `a` spanning **both**
 * beats: `a ∈ [0, 1]` is the windup, `a ∈ [1, 2]` is the strike. Authoring the
 * two halves as one continuous function is what guarantees the 45 ms cut
 * between the two clips is seamless — there is no separate "end pose" that can
 * drift out of agreement with a "start pose".
 */
type AttackFn = (p: Pose, a: number, c: AuthorCtx) => void;

/**
 * 兵/卒 — the spear thrust.
 *
 * The coil goes into the hips and the shoulders on the way back and comes out of
 * them in that order on the way forward; the arm only extends once the shoulder
 * has already turned, and the wrist is still moving after the elbow has locked.
 * The spear tip therefore arrives last, which is the entire point.
 */
const thrustAttack: AttackFn = (p, a, c) => {
  // Hips: coil away, then drive first.
  add(p, 'pelvis', 0, curve(a, [[0, 0], [0.72, -0.17, 'outCubic'], [1, -0.19, 'outQuad'], [1.18, 0.14, 'outQuint'], [1.55, 0.21, 'outCubic'], [2, 0.13, 'inOutCubic']]), 0);
  // Chest: coils further and unwinds a beat later than the hips.
  add(p, 'spine02', curve(a, [[0, 0], [1, -0.10], [1.3, 0.13, 'outQuint'], [2, 0.04]]),
    curve(a, [[0, 0], [0.68, -0.28, 'outCubic'], [1, -0.32], [1.26, -0.05, 'outQuint'], [1.62, 0.26, 'outCubic'], [2, 0.16]]), 0);
  add(p, 'spine01', curve(a, [[0, 0.02], [1, -0.06], [1.35, -0.20, 'outQuint'], [2, -0.11]]),
    curve(a, [[0, 0], [1, -0.14], [1.5, 0.09, 'outCubic'], [2, 0.06]]), 0);
  // The head stays on the target the whole time: it counter-rotates against the
  // coil, then holds while the body arrives.
  add(p, 'neck', 0, curve(a, [[0, 0], [1, 0.14], [1.4, -0.04, 'outCubic'], [2, -0.04]]), 0);
  add(p, 'head', curve(a, [[0, 0], [1, 0.04], [1.45, -0.09, 'outCubic'], [2, -0.05]]),
    curve(a, [[0, 0], [1, 0.15], [1.45, -0.07, 'outCubic'], [2, -0.06]]), 0);

  // Right arm: draws back and folds, then extends — starting after the shoulder.
  add(p, 'upperArmR', curve(a, [[0, 0], [0.55, -0.42, 'outCubic'], [1, -0.56, 'outQuad'], [1.22, -0.44, 'inQuad'], [1.62, 0.44, 'outQuint'], [2, 0.32, 'outCubic']]), 0,
    curve(a, [[0, 0], [1, -0.18], [1.7, -0.05, 'outCubic'], [2, -0.08]]));
  add(p, 'foreArmR', curve(a, [[0, 0.1], [0.62, 0.92, 'outCubic'], [1, 1.16, 'outQuad'], [1.3, 1.02, 'inQuad'], [1.74, 0.07, 'outQuint'], [2, 0.16, 'outCubic']]));
  // The wrist is last to arrive and first thing to keep moving after contact.
  add(p, 'handR', curve(a, [[0, 0], [1, -0.12], [1.42, -0.14, 'linear'], [1.86, 0.19, 'outQuint'], [2, 0.11, 'outCubic']]));

  // Left hand runs the haft forward; it leads the right on the drive.
  add(p, 'upperArmL', curve(a, [[0, 0], [0.6, 0.5, 'outCubic'], [1, 0.62], [1.45, 0.86, 'outQuint'], [2, 0.7]]), 0,
    curve(a, [[0, 0], [1, 0.24], [1.5, 0.1, 'outCubic'], [2, 0.14]]));
  add(p, 'foreArmL', curve(a, [[0, 0.1], [1, 0.58], [1.5, 0.3, 'outQuint'], [2, 0.4]]));

  if (!c.seated) {
    // Weight sinks onto the back foot, then drives through it into a lunge.
    addSide(p, 'thigh', 'R', curve(a, [[0, 0], [1, -0.14], [1.5, 0.05, 'outQuint'], [2, 0.02]]));
    addSide(p, 'shin', 'R', curve(a, [[0, 0], [0.7, -0.32, 'outCubic'], [1, -0.42], [1.44, -0.12, 'outQuint'], [2, -0.2]]));
    addSide(p, 'thigh', 'L', curve(a, [[0, 0], [1, 0.24], [1.46, 0.52, 'outQuint'], [2, 0.42]]));
    addSide(p, 'shin', 'L', curve(a, [[0, 0], [1, -0.1], [1.5, -0.34, 'outQuint'], [2, -0.28]]));
    addSide(p, 'foot', 'L', curve(a, [[0, 0], [1, 0.12], [1.5, -0.06, 'outCubic'], [2, 0]]));
  }
  p.root[1] += curve(a, [[0, 0], [1, -0.028], [1.5, -0.012, 'outQuint'], [2, -0.02]]);
  p.root[2] += curve(a, [[0, 0], [1, 0.052], [1.58, -0.13, 'outQuint'], [2, -0.1, 'outCubic']]);
};

/**
 * 傌/馬 — the cut from the saddle.
 *
 * Down and across, not a chop: the blade starts high outside the right shoulder
 * and finishes low across the left knee, and the torso rolls with it. The rider
 * cannot brace against the ground, so the counterweight is his own spine, which
 * is why the coronal bend is much larger here than in any footed attack.
 */
const cutDownAttack: AttackFn = (p, a, c) => {
  add(p, 'pelvis', 0, curve(a, [[0, 0], [1, -0.12], [1.3, 0.1, 'outQuint'], [2, 0.06]]),
    curve(a, [[0, 0], [1, 0.06], [1.5, -0.08, 'outCubic'], [2, -0.04]]));
  add(p, 'spine01', curve(a, [[0, 0], [1, 0.12], [1.5, -0.16, 'outQuint'], [2, -0.08]]),
    curve(a, [[0, 0], [1, -0.2], [1.45, 0.16, 'outQuint'], [2, 0.1]]),
    curve(a, [[0, 0], [1, -0.16], [1.5, 0.24, 'outQuint'], [2, 0.14]]));
  add(p, 'spine02', curve(a, [[0, 0], [1, 0.16], [1.55, -0.24, 'outQuint'], [2, -0.12]]),
    curve(a, [[0, 0], [1, -0.3], [1.5, 0.28, 'outQuint'], [2, 0.16]]),
    curve(a, [[0, 0], [1, -0.24], [1.55, 0.34, 'outQuint'], [2, 0.18]]));
  add(p, 'neck', 0, curve(a, [[0, 0], [1, 0.18], [1.6, -0.1, 'outCubic'], [2, -0.05]]),
    curve(a, [[0, 0], [1, 0.12], [1.62, -0.14, 'outCubic'], [2, -0.06]]));
  add(p, 'head', curve(a, [[0, 0], [1, -0.06], [1.7, 0.12, 'outCubic'], [2, 0.05]]),
    curve(a, [[0, 0], [1, 0.16], [1.68, -0.12, 'outCubic'], [2, -0.06]]), 0);

  // The blade arm: up and back over the shoulder, then down and across.
  add(p, 'upperArmR',
    curve(a, [[0, 0], [0.58, -0.9, 'outCubic'], [1, -1.22, 'outQuad'], [1.2, -1.14, 'inQuad'], [1.66, 0.72, 'outQuint'], [2, 0.5, 'outCubic']]), 0,
    curve(a, [[0, 0], [1, -0.52], [1.7, 0.3, 'outQuint'], [2, 0.2]]));
  add(p, 'foreArmR', curve(a, [[0, 0.1], [1, 0.88, 'outCubic'], [1.32, 0.8, 'inQuad'], [1.78, 0.22, 'outQuint'], [2, 0.34]]));
  add(p, 'handR', curve(a, [[0, 0], [1, -0.16], [1.5, -0.18, 'linear'], [1.9, 0.2, 'outQuint'], [2, 0.12]]));

  // Rein hand braces low and forward against the cut.
  add(p, 'upperArmL', curve(a, [[0, 0.4], [1, 0.62], [1.6, 0.38, 'outCubic'], [2, 0.46]]), 0, 0.2);
  add(p, 'foreArmL', curve(a, [[0, 0.6], [1, 0.86], [1.6, 0.6, 'outCubic'], [2, 0.68]]));

  if (!c.seated) {
    addSide(p, 'shin', 'R', curve(a, [[0, 0], [1, -0.3], [1.5, -0.12, 'outQuint'], [2, -0.18]]));
    addSide(p, 'shin', 'L', curve(a, [[0, 0], [1, -0.12], [1.5, -0.3, 'outQuint'], [2, -0.22]]));
  } else {
    // Gripping harder through the cut: the knees close on the barrel.
    for (const s of ['L', 'R'] as const) {
      addSide(p, 'thigh', s, 0, 0, curve(a, [[0, 0], [1, 0.05], [1.5, 0.09, 'outQuint'], [2, 0.06]]));
      addSide(p, 'shin', s, curve(a, [[0, 0], [1, -0.06], [1.5, -0.11, 'outQuint'], [2, -0.08]]));
    }
  }
  p.root[1] += curve(a, [[0, 0], [1, 0.014], [1.6, -0.022, 'outQuint'], [2, -0.012]]);
};

/**
 * 俥/車 — the chariot rolls through and crushes.
 *
 * There is no swing anywhere in this. The driver braces on the way in, is thrown
 * back as the car accelerates, and is pitched forward over the rail at the
 * moment of impact. All the travel is the choreographer moving the whole unit
 * through the defender's square; this is only what the man on the deck does
 * about it.
 */
const rollThroughAttack: AttackFn = (p, a) => {
  // Brace: knees down, weight back, reins hauled in.
  const brace = curve(a, [[0, 0], [0.7, 0.86, 'outCubic'], [1, 1, 'outQuad'], [1.28, 0.9, 'linear'], [1.55, -0.75, 'outQuint'], [1.8, 0.3, 'outCubic'], [2, 0.12, 'settle']]);
  for (const s of ['L', 'R'] as const) {
    addSide(p, 'thigh', s, 0.16 * brace);
    addSide(p, 'shin', s, -0.34 * brace);
    addSide(p, 'foot', s, 0.1 * brace);
  }
  // Positive spine X leans back: the driver is thrown backward under
  // acceleration and forward over the rail when the car hits.
  add(p, 'pelvis', -0.12 * brace);
  add(p, 'spine01', 0.3 * brace);
  add(p, 'spine02', 0.18 * brace);
  // The head lags the torso by a real interval on the way back and overshoots
  // forward on the impact — the classic whiplash order.
  const headLag = curve(a, [[0, 0], [0.82, 0.7, 'outCubic'], [1.1, 0.95], [1.42, 0.8, 'linear'], [1.66, -1.05, 'outQuint'], [1.92, 0.25, 'outCubic'], [2, 0.1, 'settle']]);
  add(p, 'neck', 0.2 * headLag);
  add(p, 'head', 0.26 * headLag);
  // Both arms haul the reins in, then are thrown out at contact.
  for (const s of ['L', 'R'] as const) {
    addSide(p, 'upperArm', s, 0.5 + 0.22 * brace, 0, (s === 'R' ? -1 : 1) * 0.16);
    addSide(p, 'foreArm', s, 0.44 + 0.4 * brace);
  }
  p.root[1] += curve(a, [[0, 0], [1, -0.016], [1.55, 0.01, 'outQuint'], [2, -0.004]]);
  p.root[2] += 0.02 * brace;
};

/**
 * 相/象 — the trunk sweep.
 *
 * The trunk itself is nine mount bones and is driven by the controller, where a
 * per-segment phase lag makes the tip arrive last. What is authored here is the
 * mahout: he leans away as the trunk coils, then goes with the sweep and lets
 * his head catch up afterwards.
 */
const trunkSweepAttack: AttackFn = (p, a) => {
  const coil = curve(a, [[0, 0], [0.72, 0.88, 'outCubic'], [1, 1, 'outQuad'], [1.22, 0.94, 'linear'], [1.62, -0.85, 'outQuint'], [2, -0.3, 'outCubic']]);
  add(p, 'pelvis', 0, 0.06 * coil, -0.1 * coil);
  add(p, 'spine01', 0.05 * coil, 0.1 * coil, -0.2 * coil);
  add(p, 'spine02', 0.03 * coil, 0.14 * coil, -0.26 * coil);
  const headLag = curve(a, [[0, 0], [0.85, 0.8, 'outCubic'], [1.14, 1.0], [1.4, 0.9, 'linear'], [1.8, -0.7, 'outQuint'], [2, -0.24, 'settle']]);
  add(p, 'neck', 0, -0.08 * headLag, 0.12 * headLag);
  add(p, 'head', 0, -0.14 * headLag, 0.16 * headLag);
  // Goad hand raised through the coil, rail hand braced hard.
  add(p, 'upperArmR', 0.24 + 0.42 * coil, 0, -0.3 - 0.12 * coil);
  add(p, 'foreArmR', 0.84 + 0.2 * coil);
  add(p, 'upperArmL', 0.42 + 0.1 * coil, 0, 0.24);
  add(p, 'foreArmL', 0.55 + 0.3 * coil);
  for (const s of ['L', 'R'] as const) addSide(p, 'shin', s, -0.05 - 0.06 * Math.abs(coil));
  p.root[0] += 0.024 * coil;
};

/**
 * 仕/士 — parry, then riposte.
 *
 * The windup is not a windup at all: it is a *parry*, a defensive shape with the
 * blade up and across and the weight already back. The strike is the shortest in
 * the cast — a straight line from the parry to the target with a step behind it.
 * Nothing about it is a swing.
 */
const parryRiposteAttack: AttackFn = (p, a, c) => {
  const parry = curve(a, [[0, 0], [0.55, 0.94, 'outQuint'], [1, 1, 'outQuad'], [1.14, 0.92, 'linear'], [1.46, 0, 'outQuint'], [2, -0.12, 'outCubic']]);
  const thrust = curve(a, [[0, 0], [1.1, 0, 'linear'], [1.5, 0.9, 'outQuint'], [1.7, 1], [2, 0.72, 'outCubic']]);

  // Blade up across the body on the parry, then dropped onto the line.
  add(p, 'upperArmR', 0.26 * parry + 0.42 * thrust, -0.18 * parry, -0.62 * parry + 0.12 * thrust);
  add(p, 'foreArmR', 1.0 * parry + 0.16 - 0.86 * thrust, 0.2 * parry, 0);
  add(p, 'handR', curve(a, [[0, 0], [1, -0.1], [1.56, -0.12, 'linear'], [1.88, 0.16, 'outQuint'], [2, 0.09]]));
  // Off hand out for balance, palm down — a fencer's shape, not a fist.
  add(p, 'upperArmL', 0.1 - 0.34 * parry, 0, 0.44 * parry);
  add(p, 'foreArmL', 0.42 + 0.24 * parry - 0.1 * thrust);

  add(p, 'pelvis', 0, -0.1 * parry + 0.18 * thrust, 0);
  add(p, 'spine01', -0.06 * parry - 0.08 * thrust, -0.12 * parry + 0.16 * thrust, 0.06 * parry);
  add(p, 'spine02', -0.04 * parry - 0.06 * thrust, -0.18 * parry + 0.22 * thrust, 0.09 * parry);
  add(p, 'neck', 0, 0.1 * parry - 0.08 * thrust, 0);
  add(p, 'head', 0.04 * parry, 0.14 * parry - 0.1 * thrust, 0);

  if (!c.seated) {
    addSide(p, 'thigh', 'R', -0.1 * parry + 0.04 * thrust);
    addSide(p, 'shin', 'R', -0.34 * parry + 0.14 * thrust);
    addSide(p, 'thigh', 'L', 0.18 * parry + 0.3 * thrust);
    addSide(p, 'shin', 'L', -0.08 * parry - 0.22 * thrust);
    addSide(p, 'foot', 'L', 0.1 * parry - 0.08 * thrust);
  }
  p.root[1] += -0.024 * parry - 0.006 * thrust;
  p.root[2] += 0.04 * parry - 0.1 * thrust;
};

/**
 * 帥/將 — close and economical.
 *
 * A general does not lunge. The weight goes down into both knees, the hips turn
 * hard, and the 節 travels perhaps a third of the distance a spear does. The
 * whole read is mass: large hip rotation, small hand displacement, and a long
 * settle afterwards.
 */
const closeStrikeAttack: AttackFn = (p, a, c) => {
  const load = curve(a, [[0, 0], [0.68, 0.9, 'outCubic'], [1, 1, 'outQuad'], [1.2, 0.96, 'linear'], [1.62, 0.05, 'outQuint'], [2, 0.22, 'settle']]);
  const drive = curve(a, [[0, 0], [1.06, 0, 'linear'], [1.34, 0.72, 'outQuint'], [1.58, 1], [2, 0.68, 'outCubic']]);

  add(p, 'pelvis', 0, -0.19 * load + 0.34 * drive, 0);
  add(p, 'spine01', -0.05 * load, -0.1 * load + 0.2 * drive, 0);
  add(p, 'spine02', -0.08 * load, -0.16 * load + 0.28 * drive, 0);
  add(p, 'neck', 0, 0.14 * load - 0.12 * drive, 0);
  add(p, 'head', 0.03 * load, 0.16 * load - 0.14 * drive, 0);

  add(p, 'upperArmR', -0.16 * load + 0.38 * drive, 0, -0.24 * load - 0.06 * drive);
  add(p, 'foreArmR', 0.42 + 0.5 * load - 0.4 * drive);
  add(p, 'handR', curve(a, [[0, 0], [1, -0.08], [1.5, -0.1, 'linear'], [1.84, 0.14, 'outQuint'], [2, 0.08]]));
  add(p, 'upperArmL', 0.2 * load + 0.1 * drive, 0, 0.26 * load);
  add(p, 'foreArmL', 0.3 + 0.34 * load);

  if (!c.seated) {
    for (const s of ['L', 'R'] as const) {
      addSide(p, 'thigh', s, 0.14 * load + 0.06 * drive);
      addSide(p, 'shin', s, -0.3 * load - 0.05 * drive);
      addSide(p, 'foot', s, 0.11 * load);
    }
  }
  p.root[1] += -0.042 * load + 0.008 * drive;
  p.root[2] += 0.012 * load - 0.03 * drive;
};

/**
 * 炮/砲 — the traction trebuchet's crew.
 *
 * He does not attack anything. He reaches high, takes the ropes, and drops his
 * whole body weight onto them; the beam does the rest. The strike is therefore a
 * *fall*, and it is authored as one — the hands lead, the body follows them
 * down, and the knees arrive last and absorb.
 */
const hauledShotAttack: AttackFn = (p, a, c) => {
  const reach = curve(a, [[0, 0], [0.62, 0.92, 'outCubic'], [1, 1, 'outQuad'], [1.16, 0.94, 'linear'], [1.5, 0, 'inCubic'], [2, -0.15, 'outCubic']]);
  const haul = curve(a, [[0, 0], [1.08, 0, 'linear'], [1.44, 0.86, 'inCubic'], [1.66, 1], [2, 0.78, 'settle']]);

  for (const s of ['L', 'R'] as const) {
    addSide(p, 'upperArm', s, 0.6 + 0.68 * reach - 1.32 * haul, 0, (s === 'R' ? -1 : 1) * 0.12);
    addSide(p, 'foreArm', s, 0.34 - 0.24 * reach + 0.5 * haul);
    addSide(p, 'hand', s, curve(a, [[0, 0], [1, 0.12], [1.5, -0.1, 'inCubic'], [2, -0.06]]));
  }
  add(p, 'spine01', 0.16 * reach - 0.34 * haul);
  add(p, 'spine02', 0.1 * reach - 0.2 * haul);
  add(p, 'neck', -0.08 * reach + 0.16 * haul);
  add(p, 'head', -0.1 * reach + 0.2 * haul);
  if (!c.seated) {
    for (const s of ['L', 'R'] as const) {
      addSide(p, 'thigh', s, -0.1 * reach + 0.3 * haul);
      addSide(p, 'shin', s, 0.06 * reach - 0.62 * haul);
      addSide(p, 'foot', s, -0.05 * reach + 0.2 * haul);
    }
  }
  p.root[1] += 0.026 * reach - 0.088 * haul;
  p.root[2] += -0.02 * reach + 0.03 * haul;
};

const ATTACK: Record<AttackStyle, AttackFn> = {
  thrust: thrustAttack,
  cutDown: cutDownAttack,
  rollThrough: rollThroughAttack,
  trunkSweep: trunkSweepAttack,
  parryRiposte: parryRiposteAttack,
  closeStrike: closeStrikeAttack,
  hauledShot: hauledShotAttack,
};

// ===========================================================================
// hit — directional
// ===========================================================================

/**
 * A directional impact reaction.
 *
 * `hitFrom` is the direction the impulse arrived from, in rig space: 0 is from
 * dead ahead, +π/2 from the figure's right. It is decomposed into a sagittal
 * component `f` and a coronal component `s`, and each drives its own break.
 *
 * The ordering is the whole clip: the pelvis is displaced first, the waist folds
 * about 40 ms later, and the head does not start moving until the chest has
 * nearly finished — then it overshoots and rings down. Bodies do this; rigid
 * mannequins do not, and this is the single cheapest place to show the
 * difference.
 */
function hitPose(p: Pose, t: number, c: AuthorCtx): void {
  const f = Math.cos(c.hitFrom);
  const s = Math.sin(c.hitFrom);

  const pelvis = curve(t, [[0, 0], [0.14, 1, 'outQuint'], [0.42, 0.55, 'outCubic'], [0.72, 0.14], [1, 0, 'settle']]);
  const waist = curve(t, [[0, 0], [0.06, 0, 'linear'], [0.24, 1, 'outQuint'], [0.52, 0.42, 'outCubic'], [1, 0, 'settle']]);
  const head = curve(t, [[0, 0], [0.13, 0, 'linear'], [0.34, 1.14, 'outQuint'], [0.55, 0.6], [0.78, -0.16, 'outCubic'], [1, 0, 'settle']]);

  p.root[0] += -0.088 * s * pelvis;
  p.root[2] += 0.10 * f * pelvis;
  p.root[1] += -0.03 * pelvis;

  add(p, 'pelvis', 0.12 * f * pelvis, -0.1 * s * pelvis, -0.14 * s * pelvis);
  add(p, 'spine01', 0.34 * f * waist, -0.14 * s * waist, -0.26 * s * waist);
  add(p, 'spine02', 0.28 * f * waist, -0.18 * s * waist, -0.22 * s * waist);
  add(p, 'neck', 0.2 * f * head, 0.1 * s * head, 0.16 * s * head);
  add(p, 'head', 0.3 * f * head, 0.14 * s * head, 0.2 * s * head);

  // Arms trail: they are the last things to know the body has been hit, and
  // they fly opposite to the impulse.
  const arms = curve(t, [[0, 0], [0.2, 0, 'linear'], [0.4, 1, 'outQuint'], [0.68, 0.36], [1, 0, 'settle']]);
  for (const sd of ['L', 'R'] as const) {
    const out = sd === 'R' ? 1 : -1;
    addSide(p, 'upperArm', sd, -0.42 * f * arms, 0, -0.3 * arms * out);
    addSide(p, 'foreArm', sd, 0.36 * arms);
    addSide(p, 'hand', sd, 0.2 * arms);
  }

  if (!c.seated) {
    // A catch step: the leg on the side being pushed toward takes the weight.
    const step = curve(t, [[0, 0], [0.18, 0, 'linear'], [0.44, 1, 'outQuint'], [0.78, 0.5, 'outCubic'], [1, 0, 'settle']]);
    const back = f >= 0 ? 'R' : 'L';
    const front = f >= 0 ? 'L' : 'R';
    addSide(p, 'thigh', back, -0.36 * step * Math.abs(f) - 0.1 * step);
    addSide(p, 'shin', back, -0.44 * step);
    addSide(p, 'foot', back, -0.16 * step);
    addSide(p, 'thigh', front, 0.22 * step * Math.abs(f));
    addSide(p, 'shin', front, -0.2 * step);
    addSide(p, 'thigh', 'R', 0, 0, 0.16 * s * step);
    addSide(p, 'thigh', 'L', 0, 0, 0.16 * s * step);
  } else {
    const grip = curve(t, [[0, 0], [0.3, 1, 'outQuint'], [1, 0.2, 'outCubic']]);
    for (const sd of ['L', 'R'] as const) {
      addSide(p, 'thigh', sd, 0, 0, 0.07 * grip);
      addSide(p, 'shin', sd, -0.1 * grip);
    }
  }
}

// ===========================================================================
// death
// ===========================================================================

/**
 * A collapse, not a fall-over.
 *
 * The order is the point and it is strictly enforced by the timings below:
 *
 *   0.00 – 0.13   one knee gives; the body is still upright and does not know
 *   0.13 – 0.36   both knees fold, the pelvis drops, the torso stays vertical
 *                 on inertia — this window is where the weight lives
 *   0.30 – 0.62   the torso finally follows the hips down and folds forward
 *   0.55 – 0.84   the body topples off the knees onto its side
 *   0.70 – 1.00   the head arrives last and rings down against the board
 *
 * The arms are never posed directly: they are driven from lagged copies of the
 * torso curves, so they always trail whatever the body is doing.
 */
function deathPose(p: Pose, t: number, c: AuthorCtx): void {
  const side = c.rng.chance(0.5) ? 1 : -1;

  const buckle = curve(t, [[0, 0], [0.13, 0.28, 'outQuint'], [0.36, 1, 'inCubic'], [1, 1, 'linear']]);
  const sink = curve(t, [[0, 0], [0.13, 0.06, 'outCubic'], [0.36, 0.42, 'inCubic'], [0.62, 0.82, 'inQuad'], [0.84, 0.98, 'outCubic'], [1, 1, 'settle']]);
  const fold = curve(t, [[0, 0], [0.3, 0, 'linear'], [0.62, 0.86, 'inCubic'], [0.84, 1, 'outCubic'], [1, 0.96, 'settle']]);
  const topple = curve(t, [[0, 0], [0.55, 0, 'linear'], [0.84, 0.92, 'inQuad'], [1, 1, 'settle']]);
  const headArrive = curve(t, [[0, 0], [0.7, 0.12, 'linear'], [0.92, 1.06, 'inQuad'], [1, 1, 'settle']]);

  if (!c.seated) {
    // The knee that gives first goes further, and the ankles collapse with it.
    addSide(p, 'thigh', 'R', 0.42 * buckle + 0.5 * sink);
    addSide(p, 'shin', 'R', -0.9 * buckle - 0.85 * sink);
    addSide(p, 'foot', 'R', -0.35 * sink);
    addSide(p, 'thigh', 'L', 0.24 * buckle + 0.62 * sink);
    addSide(p, 'shin', 'L', -0.55 * buckle - 1.05 * sink);
    addSide(p, 'foot', 'L', -0.28 * sink);
    addSide(p, 'thigh', 'R', 0, 0, 0.14 * side * topple);
    addSide(p, 'thigh', 'L', 0, 0, 0.14 * side * topple);
  } else {
    // Slumping out of a seat: the legs let go of the barrel rather than fold.
    for (const s of ['L', 'R'] as const) {
      addSide(p, 'thigh', s, 0.2 * sink, 0, -0.1 * sink);
      addSide(p, 'shin', s, -0.2 * sink);
    }
  }

  add(p, 'pelvis', 0.14 * sink - 0.3 * fold, 0.1 * side * topple, -0.26 * side * topple);
  add(p, 'spine01', -0.52 * fold, 0.14 * side * topple, -0.34 * side * topple);
  add(p, 'spine02', -0.4 * fold, 0.1 * side * topple, -0.22 * side * topple);
  add(p, 'neck', -0.2 * headArrive + 0.24 * fold, -0.08 * side * headArrive, 0.1 * side * headArrive);
  add(p, 'head', -0.34 * headArrive + 0.3 * fold, -0.12 * side * headArrive, 0.16 * side * headArrive);

  // Arms are dead weight from the moment the knees go: lagged, unresisting.
  const limp = curve(t, [[0, 0], [0.2, 0.2, 'outCubic'], [0.5, 0.7, 'inCubic'], [0.8, 1, 'outCubic'], [1, 0.94, 'settle']]);
  for (const s of ['L', 'R'] as const) {
    const out = s === 'R' ? 1 : -1;
    addSide(p, 'upperArm', s, -0.3 * limp + 0.4 * fold, 0, -0.24 * limp * out);
    addSide(p, 'foreArm', s, 0.5 * limp);
    addSide(p, 'hand', s, 0.3 * limp);
  }

  p.root[1] += (c.seated ? -0.11 : -0.385) * sink;
  p.root[2] += (c.seated ? 0.06 : 0.19) * sink;
  p.root[0] += (c.seated ? 0.05 : 0.13) * side * topple;
}

// ===========================================================================
// victory and salute
// ===========================================================================

/** The raise. Ends exactly on the pose `victoryHold` loops around. */
function victoryPose(p: Pose, t: number, c: AuthorCtx): void {
  const raise = curve(t, [[0, 0], [0.18, -0.12, 'outCubic'], [0.62, 1.06, 'outQuint'], [0.82, 0.98], [1, 1, 'settle']]);
  victoryHeld(p, raise, c);
  // A small drop and drive through the legs under the raise: the arm does not
  // levitate, the body pushes it up.
  if (!c.seated) {
    const push = curve(t, [[0, 0], [0.2, 1, 'outCubic'], [0.62, 0, 'outQuint'], [1, 0.1, 'settle']]);
    for (const s of ['L', 'R'] as const) {
      addSide(p, 'thigh', s, 0.14 * push);
      addSide(p, 'shin', s, -0.3 * push);
    }
    p.root[1] += -0.03 * push;
  }
}

/** The held shape, scaled by `k`. Shared by the raise and the hold loop. */
function victoryHeld(p: Pose, k: number, c: AuthorCtx): void {
  const r = c.motion.raise;
  const o = r === 'R' ? 1 : -1;
  addSide(p, 'upperArm', r, 0.34 * k, 0, 1.52 * k * o);
  addSide(p, 'foreArm', r, 0.28 * k, 0, 0.3 * k * o);
  addSide(p, 'hand', r, 0.12 * k);
  const other = r === 'R' ? 'L' : 'R';
  addSide(p, 'upperArm', other, -0.14 * k, 0, -0.42 * k * o);
  addSide(p, 'foreArm', other, 0.34 * k);
  // Chest open, chin up, weight back: an assertion, not a shrug.
  add(p, 'pelvis', 0.05 * k, -0.05 * k * o, 0);
  add(p, 'spine01', 0.13 * k, -0.06 * k * o, -0.04 * k * o);
  add(p, 'spine02', 0.11 * k, -0.08 * k * o, -0.05 * k * o);
  add(p, 'neck', 0.06 * k, 0.05 * k * o, 0);
  add(p, 'head', 0.11 * k, 0.07 * k * o, 0);
  if (!c.seated) {
    addSide(p, 'thigh', 'R', -0.06 * k);
    addSide(p, 'thigh', 'L', 0.09 * k);
    addSide(p, 'shin', 'L', -0.14 * k);
  }
  p.root[1] += 0.012 * k;
}

function victoryHoldPose(p: Pose, phase: number, c: AuthorCtx): void {
  victoryHeld(p, 1, c);
  breathLayer(p, phase * 2, 1.5);
  const w = Math.sin(TAU * phase);
  const wLag = Math.sin(TAU * phase - 0.85);
  weightShift(p, 0.55 * w, 0.55 * wLag, c.seated);
  // The raised arm drifts and recovers — nobody holds a weapon overhead still.
  const r = c.motion.raise;
  addSide(p, 'upperArm', r, 0.03 * breath(phase * 2 - 0.2), 0, 0.05 * wLag);
  addSide(p, 'foreArm', r, 0.04 * Math.sin(TAU * phase * 3 + 0.6));
}

/**
 * 拱手. The right fist goes into the left palm at chest height and the bow comes
 * from the waist, not the neck. A mounted figure does not bow — he inclines his
 * head and raises the weapon a hand's width, which is what a rider does.
 */
function salutePose(p: Pose, t: number, c: AuthorCtx): void {
  const bring = curve(t, [[0, 0], [0.26, 1, 'outCubic'], [0.74, 1, 'linear'], [1, 0, 'inOutCubic']]);
  const bow = curve(t, [[0, 0], [0.2, 0, 'linear'], [0.42, 1, 'outCubic'], [0.68, 1, 'linear'], [0.92, 0, 'inOutCubic'], [1, 0, 'linear']]);

  add(p, 'upperArmR', 0.66 * bring, 0, -0.42 * bring);
  add(p, 'foreArmR', 1.15 * bring, 0.34 * bring, 0);
  add(p, 'upperArmL', 0.6 * bring, 0, 0.46 * bring);
  add(p, 'foreArmL', 1.1 * bring, -0.3 * bring, 0);

  if (c.seated) {
    add(p, 'neck', -0.14 * bow);
    add(p, 'head', -0.2 * bow);
    add(p, 'spine01', -0.05 * bow);
    return;
  }
  add(p, 'spine01', -0.3 * bow);
  add(p, 'spine02', -0.19 * bow);
  add(p, 'neck', -0.06 * bow);
  // The head keeps its own timing inside the bow: it goes down a shade late and
  // comes up a shade early, which is what makes a bow read as courtesy rather
  // than as a hinge.
  add(p, 'head', -0.1 * curve(t, [[0, 0], [0.26, 0, 'linear'], [0.48, 1, 'outCubic'], [0.64, 1, 'linear'], [0.86, 0, 'inOutCubic'], [1, 0, 'linear']]));
  addSide(p, 'thigh', 'R', 0.06 * bow);
  addSide(p, 'thigh', 'L', 0.06 * bow);
  addSide(p, 'shin', 'R', -0.1 * bow);
  addSide(p, 'shin', 'L', -0.1 * bow);
  p.root[1] += -0.01 * bow;
  p.root[2] += 0.014 * bow;
  breathLayer(p, t * 1.5, 0.6);
}

// ===========================================================================
// Baking
// ===========================================================================

/** Root translation over a clip, in statures. Retargeted by the animator. */
export interface RootCurve {
  times: Float32Array;
  /** xyz triples, statures. */
  values: Float32Array;
}

export interface NormalisedClip {
  /** Internal state key, e.g. `soldier:hit:L`. */
  key: string;
  state: AnimState;
  duration: number;
  loop: boolean;
  /** Quaternion tracks for the nineteen non-root bones. Shared across the cast. */
  clip: THREE.AnimationClip;
  root: RootCurve;
}

const _e = new THREE.Euler(0, 0, 0, 'XYZ');
const _q = new THREE.Quaternion();

/**
 * Sample a pose function into keyframe tracks.
 *
 * Every clip emits a track for all nineteen non-root bones whether they move or
 * not. That is deliberate: the mixer restores a property to its pre-animation
 * value the instant the last action referencing it stops, and a restore is an
 * instantaneous pop. Giving every clip the same binding set means a cross-fade
 * is always a blend of two live values and never a blend against a restore.
 */
function bake(
  key: string,
  state: AnimState,
  fn: (p: Pose, t: number, c: AuthorCtx) => void,
  opts: { duration: number; samples: number; loop: boolean; domain?: [number, number] },
  c: AuthorCtx,
): NormalisedClip {
  const { duration, samples, loop } = opts;
  const [d0, d1] = opts.domain ?? [0, 1];
  const n = samples + 1; // inclusive of the endpoint, so a loop closes exactly
  const times = new Float32Array(n);
  const quats: Float32Array[] = [];
  for (let b = 0; b < BONE_COUNT; b++) quats.push(new Float32Array(n * 4));
  const rootVals = new Float32Array(n * 3);

  const pose = makePose();
  for (let i = 0; i < n; i++) {
    const u = i / samples;
    times[i] = u * duration;
    clearPose(pose);
    fn(pose, d0 + (d1 - d0) * u, c);
    for (let b = 0; b < BONE_COUNT; b++) {
      _e.set(pose.e[b * 3], pose.e[b * 3 + 1], pose.e[b * 3 + 2], 'XYZ');
      _q.setFromEuler(_e);
      const arr = quats[b];
      // Hemisphere continuity. `slerpFlat` handles this itself, but a track
      // whose samples flip sign is unreadable in a debugger and optimises badly.
      if (i > 0) {
        const j = (i - 1) * 4;
        const dot = _q.x * arr[j] + _q.y * arr[j + 1] + _q.z * arr[j + 2] + _q.w * arr[j + 3];
        if (dot < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
      }
      arr[i * 4] = _q.x;
      arr[i * 4 + 1] = _q.y;
      arr[i * 4 + 2] = _q.z;
      arr[i * 4 + 3] = _q.w;
    }
    rootVals[i * 3] = pose.root[0];
    rootVals[i * 3 + 1] = pose.root[1];
    rootVals[i * 3 + 2] = pose.root[2];
  }

  const tracks: THREE.KeyframeTrack[] = [];
  for (let b = 0; b < BONE_COUNT; b++) {
    const name = BONE_ORDER[b];
    if (name === 'root') continue; // the root's rotation would carry the mount
    tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, quats[b]));
  }

  const clip = new THREE.AnimationClip(key, duration, tracks);
  return { key, state, duration, loop, clip, root: { times, values: rootVals } };
}

/** Evaluate a root curve at time `t`, writing statures into `out`. */
export function sampleRoot(curveData: RootCurve, t: number, out: Float64Array): void {
  const { times, values } = curveData;
  const n = times.length;
  if (n === 0) {
    out[0] = out[1] = out[2] = 0;
    return;
  }
  const end = times[n - 1];
  let x = t;
  if (x <= times[0]) x = times[0];
  else if (x >= end) x = end;
  // Uniform sampling, so the index is arithmetic rather than a search.
  const step = n > 1 ? end / (n - 1) : 1;
  let i = step > 0 ? Math.floor(x / step) : 0;
  if (i >= n - 1) i = n - 2;
  if (i < 0) i = 0;
  const u = step > 0 ? (x - times[i]) / step : 0;
  const a = i * 3;
  const b = (i + 1) * 3;
  out[0] = values[a] + (values[b] - values[a]) * u;
  out[1] = values[a + 1] + (values[b + 1] - values[a + 1]) * u;
  out[2] = values[a + 2] + (values[b + 2] - values[a + 2]) * u;
}

// ===========================================================================
// The clip set
// ===========================================================================

/** Every internal clip a unit owns, keyed by internal state key. */
export type ClipSet = Map<string, NormalisedClip>;

/** Directional hit variants. The controller picks one from the impulse. */
export const HIT_DIRECTIONS = ['F', 'R', 'B', 'L'] as const;
export type HitDirection = (typeof HIT_DIRECTIONS)[number];
const HIT_ANGLE: Record<HitDirection, number> = {
  F: 0,
  R: Math.PI / 2,
  B: Math.PI,
  L: -Math.PI / 2,
};

/** Sample counts. Fast clips need more resolution than slow ones, not less. */
const SAMPLES = {
  idle: 56,
  move: 40,
  windup: 20,
  strike: 24,
  hit: 26,
  death: 44,
  victory: 22,
  victoryHold: 40,
  salute: 30,
} as const;

const CACHE = new Map<string, ClipSet>();

/**
 * Build (or fetch) every clip for one unit type.
 *
 * Clips are cached per `(key, gait)` and shared by all figures of that type in
 * both armies: they contain rotations only, and rotations are proportion-free.
 * Thirty-two figures on the board therefore cost seven clip sets, not
 * thirty-two.
 */
export function buildClipSet(key: UnitKey, gait: GaitName): ClipSet {
  const cacheKey = `${key}/${gait}`;
  const hit0 = CACHE.get(cacheKey);
  if (hit0) return hit0;

  const plan = GAIT[gait];
  const motion = UNIT_MOTION[key];
  const c: AuthorCtx = {
    key,
    gait,
    plan,
    motion,
    seated: plan.seated,
    hitFrom: 0,
    rng: seedFor('anim', 'clip', key, gait),
  };

  const set: ClipSet = new Map();
  const put = (n: NormalisedClip) => set.set(n.key, n);

  put(bake(`${key}:idle`, 'idle', idlePose, { duration: CLIP.idle, samples: SAMPLES.idle, loop: true }, c));
  put(bake(`${key}:move`, 'move', MOVE_POSE[gait], { duration: plan.cycle, samples: SAMPLES.move, loop: true }, c));

  const attack = ATTACK[motion.attack];
  put(bake(`${key}:attackWindup`, 'attackWindup', attack, {
    duration: CLIP.attackWindup,
    samples: SAMPLES.windup,
    loop: false,
    domain: [0, 1],
  }, c));
  put(bake(`${key}:attackStrike`, 'attackStrike', attack, {
    duration: CLIP.attackStrike,
    samples: SAMPLES.strike,
    loop: false,
    domain: [1, 2],
  }, c));

  for (const d of HIT_DIRECTIONS) {
    const dc: AuthorCtx = { ...c, hitFrom: HIT_ANGLE[d] };
    put(bake(`${key}:hit:${d}`, 'hit', hitPose, { duration: CLIP.hit, samples: SAMPLES.hit, loop: false }, dc));
  }

  put(bake(`${key}:death`, 'death', deathPose, {
    duration: CLIP.death,
    samples: SAMPLES.death,
    loop: false,
  }, { ...c, rng: seedFor('anim', 'death', key) }));
  put(bake(`${key}:victory`, 'victory', victoryPose, { duration: CLIP.victory, samples: SAMPLES.victory, loop: false }, c));
  put(bake(`${key}:victoryHold`, 'victory', victoryHoldPose, { duration: CLIP.victoryHold, samples: SAMPLES.victoryHold, loop: true }, c));
  put(bake(`${key}:salute`, 'salute', salutePose, { duration: CLIP.salute, samples: SAMPLES.salute, loop: false }, c));

  CACHE.set(cacheKey, set);
  return set;
}

/** Internal clip key for a public `AnimState`. */
export function clipKeyFor(key: UnitKey, state: AnimState, hit: HitDirection = 'F'): string {
  if (state === 'hit') return `${key}:hit:${hit}`;
  return `${key}:${state}`;
}

/** Drop every cached clip. Only useful in tests and hot-reload. */
export function clearClipCache(): void {
  CACHE.clear();
}

/**
 * The elephant's trunk sweep, as a function of attack progress. Lives here with
 * the rest of the authored motion rather than in the controller, because it is
 * the same kind of thing: a curve with a per-segment lag so the tip arrives last.
 *
 * Returns the bend for segment `i` of `n`, in radians about Y (the sweep) and X
 * (the curl).
 */
export function trunkBend(a: number, i: number, n: number, out: { curl: number; sweep: number }): void {
  const u = (i + 1) / n; // 0 at the base, 1 at the tip
  // Each segment lags the one above it by 4% of the action. Over nine segments
  // that is a third of the strike, which is what makes the tip crack.
  const lag = u * 0.34;
  const t = Math.max(0, Math.min(2, a - lag));
  const coil = curve(t, [[0, 0], [0.7, 0.9, 'outCubic'], [1, 1, 'outQuad'], [1.2, 0.95, 'linear'], [1.58, -1, 'outQuint'], [2, -0.35, 'settle']]);
  // The curl is strongest in the middle of the trunk; the tip stays looser.
  out.curl = 0.30 * coil * Math.sin(Math.PI * Math.min(1, u * 1.25));
  out.sweep = 0.26 * coil * (0.35 + u * 0.9);
}

/** Idle motion for the trunk: slow, heavy, never still. */
export function trunkIdle(phase: number, i: number, n: number, out: { curl: number; sweep: number }): void {
  const u = (i + 1) / n;
  const lag = u * 0.22;
  out.curl = 0.055 * Math.sin(TAU * (phase - lag)) * (0.4 + u);
  out.sweep = 0.042 * Math.sin(TAU * (phase - lag) * 0.5 + 1.1) * (0.3 + u);
}

/** Elephant foot-fall phase table, exported so the controller and clips agree. */
export const LUMBER_FEET: readonly [string, number][] = [
  ['legHL', LUMBER.hindL],
  ['legFL', LUMBER.foreL],
  ['legHR', LUMBER.hindR],
  ['legFR', LUMBER.foreR],
];

export { bump as gaitBump, ramp as gaitRamp, wrap01 };
