/**
 * Analytic inverse kinematics.
 *
 * Two bones, one closed-form solution, no iteration. A CCD or FABRIK solver
 * would need a loop budget, would give a slightly different answer at different
 * frame rates, and would put the elbow wherever the last iteration left it. The
 * law of cosines gives the exact answer in constant time, and a pole vector puts
 * the elbow in a plane the animator chose — both of which matter more here than
 * generality, because every chain in this project is exactly two bones.
 *
 * ## The space everything is solved in
 *
 * All solving happens in **rig space**: the local space of the unit's root
 * `Group`. That group carries the unit's `proportions.scale` and its facing, so
 * inside it the figure is at unit scale, facing −Z, with the same numbers the
 * rig was authored in. Bind lengths from `rig.bindLengths` are directly usable,
 * the target of a hand does not have to be divided by a scale, and a Black unit
 * rotated by π solves identically to a Red one. Callers hand in world-space
 * targets and an `IkContext` holding the inverse of the root's world matrix;
 * conversion happens once per unit per frame.
 *
 * ## Why there is no rest orientation to unwind
 *
 * The rig's bind rotations are identity, so a bone's local axes *are* rig axes,
 * and the bind direction from a bone to its child is simply the child's local
 * position. Aiming a bone at a direction is therefore the shortest arc from that
 * offset to the target direction, taken in the parent's frame. That choice is
 * also the minimum-twist one, which matters: the skinning is linear blend, it
 * cannot preserve volume under twist, and an IK solver that introduced twist to
 * satisfy an arbitrary roll convention would candy-wrapper every forearm on the
 * board.
 *
 * ## What is solved
 *
 *   - hands to weapon hafts, reins and haul ropes — they never detach;
 *   - feet to their planted world positions, with the hips solved against them;
 *   - the cavalryman's legs against the horse's barrel;
 *   - and a separate small aim chain for heads and the elephant's trunk, which
 *     is *not* a two-bone problem and is not pretended to be one.
 */

import * as THREE from 'three';
import { IK } from './timing.ts';

// ===========================================================================
// Per-unit frame context
// ===========================================================================

/**
 * Everything a solve needs about the unit it is solving on, computed once per
 * unit per frame. Holding it explicitly is what keeps the solver allocation-free
 * and keeps the world/rig conversion in exactly one place.
 */
export interface IkContext {
  /** Inverse of the unit root's world matrix: world space → rig space. */
  rootInv: THREE.Matrix4;
  /** Inverse of the unit root's world rotation. */
  rootQuatInv: THREE.Quaternion;
  /** The unit's uniform root scale, for converting lengths. */
  scale: number;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scaleV = new THREE.Vector3();

export function makeIkContext(root: THREE.Object3D): IkContext {
  const ctx: IkContext = {
    rootInv: new THREE.Matrix4(),
    rootQuatInv: new THREE.Quaternion(),
    scale: 1,
  };
  updateIkContext(ctx, root);
  return ctx;
}

/** Refresh the context from the root's current world matrix. Allocation-free. */
export function updateIkContext(ctx: IkContext, root: THREE.Object3D): void {
  ctx.rootInv.copy(root.matrixWorld).invert();
  root.matrixWorld.decompose(_pos, _quat, _scaleV);
  ctx.rootQuatInv.copy(_quat).invert();
  ctx.scale = _scaleV.x !== 0 ? _scaleV.x : 1;
}

/** World point → rig space. */
export function toRig(ctx: IkContext, world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(world).applyMatrix4(ctx.rootInv);
}

/** An object's position in rig space. */
export function rigPosition(
  ctx: IkContext,
  obj: THREE.Object3D,
  out: THREE.Vector3,
): THREE.Vector3 {
  out.setFromMatrixPosition(obj.matrixWorld);
  return out.applyMatrix4(ctx.rootInv);
}

/** An object's rotation in rig space. */
export function rigQuaternion(
  ctx: IkContext,
  obj: THREE.Object3D,
  out: THREE.Quaternion,
): THREE.Quaternion {
  obj.matrixWorld.decompose(_pos, _quat, _scaleV);
  return out.copy(ctx.rootQuatInv).multiply(_quat);
}

// ===========================================================================
// The raw solve
// ===========================================================================

export interface SolveResult {
  /** True when the target was inside the chain's reachable annulus. */
  reached: boolean;
  /** Distance from the achieved tip to the requested target, rig units. */
  error: number;
  /** Distance from the chain root to the target before clamping. */
  distance: number;
  /** The interior angle at the mid joint, radians. π is straight. */
  jointAngle: number;
}

const _u = new THREE.Vector3();
const _p = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _goal = new THREE.Vector3();
const _fallback = new THREE.Vector3();

/**
 * The geometric core, with no scene graph in it at all: given a chain root, a
 * target, a pole and two segment lengths, place the mid joint.
 *
 * Kept separate from the scene-graph wrapper so it can be tested directly — the
 * verification script asserts an exact solution for reachable targets and a sane
 * clamped one for unreachable targets against this function, with no rig, no
 * bones and no matrices in the way.
 *
 * Unreachable targets are handled by clamping the *distance*, not the angles:
 * the limb ends up straight (to `IK.maxExtension` of full, never quite locked)
 * and pointing exactly at the target, which is what a body does when it reaches
 * for something too far away. Targets closer than `|l1 − l2|` clamp the other
 * way, so the chain folds as tightly as it can without inverting.
 *
 * @param out   receives the mid-joint position
 * @returns the solve report; `outTip` receives the achieved tip position
 */
export function solveTwoBoneRaw(
  a: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  l1: number,
  l2: number,
  out: THREE.Vector3,
  outTip: THREE.Vector3,
): SolveResult {
  _u.copy(target).sub(a);
  const distance = _u.length();

  const reachMax = (l1 + l2) * IK.maxExtension;
  const reachMin = Math.abs(l1 - l2) * IK.minExtension;
  const reached = distance <= (l1 + l2) + 1e-9 && distance >= Math.abs(l1 - l2) - 1e-9;
  let d = distance;
  if (d > reachMax) d = reachMax;
  else if (d < reachMin) d = reachMin;
  if (distance < 1e-9) {
    // Degenerate: the target is on top of the chain root. Point the limb along
    // the pole so the next frame has something continuous to work from.
    _u.copy(pole).normalize();
    if (_u.lengthSq() < 0.5) _u.set(0, -1, 0);
    d = reachMin > 1e-9 ? reachMin : l1;
  } else {
    _u.multiplyScalar(1 / distance);
  }
  // The solve runs against the *clamped* point, not the raw target. That is
  // what makes an out-of-reach solve exact rather than approximate: the limb
  // ends up fully extended along the ray to the target and short of it by
  // precisely the shortfall, instead of bending off the line to reach a point
  // it was never going to touch.
  _goal.copy(a).addScaledVector(_u, d);

  // Law of cosines at the chain root.
  let cosAlpha = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  cosAlpha = cosAlpha < -1 ? -1 : cosAlpha > 1 ? 1 : cosAlpha;
  const alpha = Math.acos(cosAlpha);

  // ...and at the mid joint, reported so a caller can see how folded it is.
  let cosJoint = (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2);
  cosJoint = cosJoint < -1 ? -1 : cosJoint > 1 ? 1 : cosJoint;
  const jointAngle = Math.acos(cosJoint);

  // Bend plane: the component of the pole perpendicular to the limb axis.
  _p.copy(pole).addScaledVector(_u, -pole.dot(_u));
  if (_p.lengthSq() < 1e-12) {
    // Pole parallel to the limb — pick any perpendicular rather than produce a
    // NaN. Which one does not matter: this only happens when the caller's pole
    // is degenerate, and any plane is as good as another.
    _fallback.set(0, 0, -1);
    if (Math.abs(_u.z) > 0.9) _fallback.set(1, 0, 0);
    _p.crossVectors(_u, _fallback);
    if (_p.lengthSq() < 1e-12) _p.set(0, 1, 0);
  }
  _p.normalize();

  // Rotating the limb axis toward the pole by `alpha` puts the mid joint on the
  // pole side of the axis, which is the whole job of the pole vector.
  _axis.crossVectors(_u, _p).normalize();
  _d1.copy(_u).applyAxisAngle(_axis, alpha);

  out.copy(a).addScaledVector(_d1, l1);
  _d2.copy(_goal).sub(out);
  const tipDist = _d2.length();
  if (tipDist > 1e-9) _d2.multiplyScalar(1 / tipDist);
  else _d2.copy(_d1);
  outTip.copy(out).addScaledVector(_d2, l2);

  return { reached, error: outTip.distanceTo(target), distance, jointAngle };
}

// ===========================================================================
// Scene-graph chains
// ===========================================================================

export interface TwoBoneChain {
  /** Upper bone: shoulder or hip. */
  a: THREE.Object3D;
  /** Lower bone: elbow or knee. */
  b: THREE.Object3D;
  /** The effector — the child whose *origin* is placed on the target. */
  tip: THREE.Object3D;
  /** Bind length a→b, rig units. */
  l1: number;
  /** Bind length b→tip, rig units. */
  l2: number;
  /** Bind direction a→b in a's local frame (unit length). */
  dirA: THREE.Vector3;
  /** Bind direction b→tip in b's local frame (unit length). */
  dirB: THREE.Vector3;
  /** Pole direction, in the space named by `poleSpace`. */
  pole: THREE.Vector3;
  /**
   * `'rig'` pins the bend plane to the figure — right for knees, which point
   * forward whatever the pelvis is doing. `'parent'` carries the plane with the
   * chain's parent bone — right for elbows, whose bend plane follows the
   * shoulder as it swings.
   */
  poleSpace: 'rig' | 'parent';
  /** Scratch, owned by the chain so a solve allocates nothing. */
  readonly _scratch: {
    aPos: THREE.Vector3;
    elbow: THREE.Vector3;
    tipPos: THREE.Vector3;
    pole: THREE.Vector3;
    dir: THREE.Vector3;
    qParent: THREE.Quaternion;
    qA: THREE.Quaternion;
    qTmp: THREE.Quaternion;
  };
}

/**
 * Build a chain from three scene-graph nodes.
 *
 * The pole is derived from the *bind pose itself*: the mid joint's offset from
 * the straight line between the ends is exactly the direction that joint already
 * bends. Since the rig ships with pre-broken elbows and knees, every chain in
 * the cast gets a correct pole for free, and none of them has to be authored by
 * hand or guessed at from a bone name.
 */
export function makeChain(
  a: THREE.Object3D,
  b: THREE.Object3D,
  tip: THREE.Object3D,
  opts: { poleSpace?: 'rig' | 'parent'; pole?: THREE.Vector3 } = {},
): TwoBoneChain {
  const l1 = b.position.length();
  const l2 = tip.position.length();
  const dirA = b.position.clone().normalize();
  const dirB = tip.position.clone().normalize();

  // Bind positions relative to `a`. Bind rotations are identity everywhere, so
  // local offsets compose by addition.
  const bRel = b.position.clone();
  const tRel = bRel.clone().add(tip.position);
  let pole: THREE.Vector3;
  if (opts.pole) {
    pole = opts.pole.clone().normalize();
  } else {
    const axis = tRel.clone();
    const len = axis.length();
    if (len > 1e-9) axis.multiplyScalar(1 / len);
    pole = bRel.clone().addScaledVector(axis, -bRel.dot(axis));
    if (pole.lengthSq() < 1e-12) pole.set(0, 0, -1); // dead straight: bend forward
    pole.normalize();
  }

  return {
    a,
    b,
    tip,
    l1,
    l2,
    dirA,
    dirB,
    pole,
    poleSpace: opts.poleSpace ?? 'rig',
    _scratch: {
      aPos: new THREE.Vector3(),
      elbow: new THREE.Vector3(),
      tipPos: new THREE.Vector3(),
      pole: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      qParent: new THREE.Quaternion(),
      qA: new THREE.Quaternion(),
      qTmp: new THREE.Quaternion(),
    },
  };
}

/** Full extension of a chain, rig units. */
export function chainReach(c: TwoBoneChain): number {
  return c.l1 + c.l2;
}

const _dirLocal = new THREE.Vector3();

/**
 * Solve a chain onto a rig-space target and write the result into the bones'
 * local quaternions.
 *
 * The caller is responsible for the world matrices being current when this is
 * called, and for updating them afterwards if a later chain depends on this
 * one — the solver does not call `updateMatrixWorld` itself, because doing so
 * per chain is the difference between one matrix walk per unit per frame and six.
 */
export function solveTwoBone(
  chain: TwoBoneChain,
  ctx: IkContext,
  targetRig: THREE.Vector3,
  weight = 1,
): SolveResult {
  const s = chain._scratch;
  rigPosition(ctx, chain.a, s.aPos);

  const parent = chain.a.parent;
  if (parent) rigQuaternion(ctx, parent, s.qParent);
  else s.qParent.identity();

  s.pole.copy(chain.pole);
  if (chain.poleSpace === 'parent') s.pole.applyQuaternion(s.qParent);

  const res = solveTwoBoneRaw(s.aPos, targetRig, s.pole, chain.l1, chain.l2, s.elbow, s.tipPos);

  // a: aim its bind direction at the elbow, in the parent's frame.
  s.dir.copy(s.elbow).sub(s.aPos).normalize();
  _dirLocal.copy(s.dir).applyQuaternion(s.qTmp.copy(s.qParent).invert());
  s.qTmp.setFromUnitVectors(chain.dirA, _dirLocal);
  if (weight >= 1) chain.a.quaternion.copy(s.qTmp);
  else chain.a.quaternion.slerp(s.qTmp, weight);

  // b: aim its bind direction at the target, in a's (now solved) frame.
  s.qA.copy(s.qParent).multiply(chain.a.quaternion);
  s.dir.copy(s.tipPos).sub(s.elbow).normalize();
  _dirLocal.copy(s.dir).applyQuaternion(s.qTmp.copy(s.qA).invert());
  s.qTmp.setFromUnitVectors(chain.dirB, _dirLocal);
  if (weight >= 1) chain.b.quaternion.copy(s.qTmp);
  else chain.b.quaternion.slerp(s.qTmp, weight);

  return res;
}

// ===========================================================================
// Aim / look-at chains
// ===========================================================================

/**
 * A look-at distributed down a chain of bones — a neck and a head, or the nine
 * segments of an elephant's trunk.
 *
 * This is *not* a two-bone problem and is not solved as one. Each bone takes a
 * share of the remaining angular error, clamped, working from the base outward,
 * so the motion distributes the way a neck does: the base contributes a little,
 * the last bone contributes most, and no single joint ever exceeds its clamp.
 * One pass is enough because the shares are chosen to converge in one pass; a
 * second would only chase floating-point residue.
 */
export interface AimChain {
  bones: THREE.Object3D[];
  /** The object whose position is aimed at the target. */
  tip: THREE.Object3D;
  /** Per-bone share of the remaining error, 0..1. */
  shares: number[];
  /** Per-bone clamp, radians. */
  clamps: number[];
  readonly _scratch: {
    bonePos: THREE.Vector3;
    tipPos: THREE.Vector3;
    from: THREE.Vector3;
    to: THREE.Vector3;
    qDelta: THREE.Quaternion;
    qParent: THREE.Quaternion;
    qBone: THREE.Quaternion;
  };
}

export function makeAimChain(
  bones: THREE.Object3D[],
  tip: THREE.Object3D,
  shares?: number[],
  clamps?: number[],
): AimChain {
  const n = bones.length;
  return {
    bones,
    tip,
    shares: shares ?? new Array(n).fill(IK.aimShare),
    clamps: clamps ?? new Array(n).fill(IK.aimClamp),
    _scratch: {
      bonePos: new THREE.Vector3(),
      tipPos: new THREE.Vector3(),
      from: new THREE.Vector3(),
      to: new THREE.Vector3(),
      qDelta: new THREE.Quaternion(),
      qParent: new THREE.Quaternion(),
      qBone: new THREE.Quaternion(),
    },
  };
}

const _identity = new THREE.Quaternion();

/** Limit a rotation to `maxAngle` radians, keeping its axis. */
export function clampRotation(q: THREE.Quaternion, maxAngle: number): void {
  const w = q.w < -1 ? -1 : q.w > 1 ? 1 : q.w;
  const angle = 2 * Math.acos(Math.abs(w));
  if (angle <= maxAngle || angle < 1e-9) return;
  q.slerp(_identity, 1 - maxAngle / angle);
  // Slerping *toward* identity by (1 - k) leaves k of the rotation, which is
  // what we want, but renormalise: repeated clamping accumulates error.
  q.normalize();
}

/**
 * Run one aim pass. `weight` scales the whole correction so a look-at can be
 * faded in and out rather than snapping on.
 *
 * Updates world matrices bone by bone, because each bone's contribution changes
 * where the tip is for the next one — that is the entire mechanism.
 */
export function solveAim(
  chain: AimChain,
  ctx: IkContext,
  targetRig: THREE.Vector3,
  weight = 1,
): number {
  const s = chain._scratch;
  let residual = 0;
  for (let i = 0; i < chain.bones.length; i++) {
    const bone = chain.bones[i];
    rigPosition(ctx, bone, s.bonePos);
    rigPosition(ctx, chain.tip, s.tipPos);
    s.from.copy(s.tipPos).sub(s.bonePos);
    s.to.copy(targetRig).sub(s.bonePos);
    const lf = s.from.length();
    const lt = s.to.length();
    if (lf < 1e-7 || lt < 1e-7) continue;
    s.from.multiplyScalar(1 / lf);
    s.to.multiplyScalar(1 / lt);

    s.qDelta.setFromUnitVectors(s.from, s.to);
    const share = chain.shares[i] * weight;
    if (share < 0.999) s.qDelta.slerp(_identity, 1 - share);
    clampRotation(s.qDelta, chain.clamps[i]);

    // The delta is a rig-space rotation; convert it to a local pre-rotation.
    const parent = bone.parent;
    if (parent) rigQuaternion(ctx, parent, s.qParent);
    else s.qParent.identity();
    s.qBone.copy(s.qParent).invert().multiply(s.qDelta).multiply(s.qParent);
    bone.quaternion.premultiply(s.qBone).normalize();
    bone.updateMatrixWorld(true);

    residual = 2 * Math.acos(Math.min(1, Math.abs(s.qDelta.w)));
  }
  return residual;
}

// ===========================================================================
// Foot locks
// ===========================================================================

/**
 * The state of one foot.
 *
 * A locked foot's world position is *frozen*. Not damped toward a target, not
 * blended: frozen, and the hips are solved against it. This is the single
 * most-cited defect in procedural animation — the sliding foot — and the only
 * way to not have it is to make the plant authoritative and let everything else
 * give way.
 */
export interface FootLock {
  /** True while this foot owns its world position. */
  locked: boolean;
  /**
   * False until the foot has been seeded from forward kinematics. An unseeded
   * lock holds the world origin, and a leg solved toward the world origin is
   * the most spectacular failure mode this system has; the flag exists so it
   * cannot happen even on the first frame of the first move.
   */
  primed: boolean;
  /** The live ankle target — the frozen plant, plus any heel-off pivot. */
  world: THREE.Vector3;
  /** The ankle position captured at the plant. Frozen for the whole stance. */
  plant: THREE.Vector3;
  /**
   * The contact point: the ball of the foot, world space, frozen at the plant.
   * This is the point that must not move. The ankle is allowed to rise over it
   * at push-off, because that is what an ankle does.
   */
  toe: THREE.Vector3;
  /** Heel-off progress, 0 (flat) .. 1 (fully up on the toe). */
  heelOff: number;
  /** Where the foot last released from, for the swing arc. */
  from: THREE.Vector3;
  /** Where the foot is predicted to plant next. */
  to: THREE.Vector3;
  /** Facing the foot was planted at, radians. */
  yaw: number;
  /** 0..1 blend of the lock's authority, so a plant is not a snap. */
  weight: number;
  /**
   * Progress of the closing step, 0..1. Coming to a halt mid-swing would leave
   * a foot locked in mid-air, so the last step is finished under the hip rather
   * than abandoned. ≥ 1 means there is no closing step in flight.
   */
  closing: number;
}

export function makeFootLock(): FootLock {
  return {
    locked: false,
    primed: false,
    world: new THREE.Vector3(),
    plant: new THREE.Vector3(),
    toe: new THREE.Vector3(),
    heelOff: 0,
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
    yaw: 0,
    weight: 0,
    closing: 1,
  };
}

/**
 * Stance weight for one foot at a cycle phase, given the gait's duty factor.
 *
 * Full authority from the instant of the plant — a plant is not something a
 * foot eases into — and a short ramp down at toe-off so the release is not a
 * switch. Both feet can be above zero at once: that overlap *is* the
 * double-support phase, and a gait whose duty is 0.5 or below has none, which
 * is exactly why it glides.
 */
export function stanceWeight(phase: number, contact: number, duty: number): number {
  let p = phase - contact;
  p -= Math.floor(p);
  if (p >= duty) return 0;
  const release = duty - IK.releaseLead;
  if (p > release) {
    const u = (p - release) / Math.max(1e-6, duty - release);
    return Math.max(0, 1 - u);
  }
  return 1;
}

/** Heel-off progress at a stance phase: 0 while the foot is flat, 1 at toe-off. */
export function heelOffAmount(phase: number, contact: number, duty: number): number {
  let p = phase - contact;
  p -= Math.floor(p);
  if (p >= duty || p < 0) return 0;
  const u = (p / duty - IK.heelOffAt) / Math.max(1e-6, 1 - IK.heelOffAt);
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u * u * (3 - 2 * u);
}

/**
 * Height of a swinging foot above its own straight-line path, in statures.
 *
 * A single hump, biased early: a foot leaves the ground quickly at toe-off and
 * approaches the next plant almost flat, so a symmetric arc reads as a marionette
 * lifting its knee to step down.
 */
export function swingLift(u: number, lift: number): number {
  if (u <= 0 || u >= 1) return 0;
  const shaped = Math.pow(u, 0.72);
  return lift * Math.sin(Math.PI * shaped);
}
