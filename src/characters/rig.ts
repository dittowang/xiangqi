/**
 * The parametric skeleton.
 *
 * Every one of the thirty-two figures gets the *same* twenty bones in the same
 * order with the same parents — only their positions change, driven by a
 * `UnitProportions` record. That is what makes a clip authored once retarget by
 * proportion: the animator writes a rotation for `upperArmR`, and it means the
 * same thing on a 0.60-scale conscript and a 1.60-scale charioteer.
 *
 * TWO DECISIONS THE ANIMATOR NEEDS TO KNOW ABOUT
 * ----------------------------------------------
 * 1. **Bind rotations are identity.** The whole bind pose lives in bone
 *    *positions*. A bone's local axes are therefore the rig's axes — +X is the
 *    figure's right, +Y is up, -Z is forward — for every bone, on every unit.
 *    Rotating `foreArmR` about +X bends the elbow the same way on all thirty-two
 *    figures, and an IK solver never has to unwind a per-bone rest orientation.
 *    The cost is that bone axes are not aligned to their limbs; the benefit is
 *    that retargeting is exact rather than approximate, which is the trade this
 *    project wants.
 *
 * 2. **The bind pose is a relaxed A-pose with pre-broken joints.** Elbows and
 *    knees carry a few degrees of bend at rest. A perfectly straight joint gives
 *    linear blend skinning no information about which way the limb folds, and it
 *    collapses the moment it bends. Pre-breaking costs nothing and removes the
 *    single worst deformation artefact.
 *
 * All lengths are in *rig units* — the same units as `UnitProportions.height` —
 * and the root `scale` is applied by the factory on the outer group, never here.
 */

import * as THREE from 'three';
import {
  BONE_ORDER,
  BONE_PARENT,
  type BoneName,
  type UnitProportions,
} from '@core/contracts.ts';

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

/**
 * The child each bone's segment runs to. Used for bind lengths, for the skinning
 * distance field, and by the animator to normalise a clip against a proportion.
 */
export const PRIMARY_CHILD: Record<BoneName, BoneName | null> = {
  root: 'pelvis',
  pelvis: 'spine01',
  spine01: 'spine02',
  spine02: 'neck',
  neck: 'head',
  head: null,
  clavicleL: 'upperArmL',
  upperArmL: 'foreArmL',
  foreArmL: 'handL',
  handL: null,
  clavicleR: 'upperArmR',
  upperArmR: 'foreArmR',
  foreArmR: 'handR',
  handR: null,
  thighL: 'shinL',
  shinL: 'footL',
  footL: null,
  thighR: 'shinR',
  shinR: 'footR',
  footR: null,
};

/** Children of each bone, derived from `BONE_PARENT`. */
export const BONE_CHILDREN: Record<BoneName, BoneName[]> = (() => {
  const out = {} as Record<BoneName, BoneName[]>;
  for (const b of BONE_ORDER) out[b] = [];
  for (const b of BONE_ORDER) {
    const p = BONE_PARENT[b];
    if (p) out[p].push(b);
  }
  return out;
})();

/** Mirror of every bone that has one; used to build the right side from the left. */
export const BONE_MIRROR: Partial<Record<BoneName, BoneName>> = {
  clavicleL: 'clavicleR',
  upperArmL: 'upperArmR',
  foreArmL: 'foreArmR',
  handL: 'handR',
  thighL: 'thighR',
  shinL: 'shinR',
  footL: 'footR',
  clavicleR: 'clavicleL',
  upperArmR: 'upperArmL',
  foreArmR: 'foreArmL',
  handR: 'handL',
  thighR: 'thighL',
  shinR: 'shinL',
  footR: 'footL',
};

// ---------------------------------------------------------------------------
// Derived measurements
// ---------------------------------------------------------------------------

/**
 * Everything a part function needs to size itself, computed once from the
 * proportions. Parts take these as explicit arguments so they stay pure — no
 * part ever reaches into a `Rig`.
 */
export interface RigMetrics {
  height: number;
  scale: number;

  /** Vertical stations, rig units above the ground plane. */
  ankleY: number;
  kneeY: number;
  hipY: number;
  waistY: number;
  chestY: number;
  shoulderY: number;
  neckY: number;
  headY: number;
  headTopY: number;

  /** Segment lengths. */
  headLen: number;
  neckLen: number;
  torsoLen: number;
  legLen: number;
  thighLen: number;
  shinLen: number;
  footLen: number;
  upperArmLen: number;
  foreArmLen: number;
  handLen: number;
  armLen: number;

  /** Widths and depths. */
  shoulderWidth: number;
  hipWidth: number;
  waistWidth: number;
  chestWidth: number;
  stanceWidth: number;
  chestDepth: number;
  waistDepth: number;
  hipDepth: number;
  headWidth: number;
  headDepth: number;

  /** Limb radii, already carrying `bulk`. */
  upperArmR: number;
  foreArmR: number;
  thighR: number;
  shinR: number;
  neckR: number;
  handR: number;

  bulk: number;
  topHeaviness: number;
  stance: number;
}

/**
 * `originY` lifts every vertical station — a rider's rig sits at his seat
 * height, not on the ground, so that parts authored from these metrics land on
 * the mount instead of beside it.
 */
export function computeMetrics(p: UnitProportions, originY = 0): RigMetrics {
  const h = p.height;
  const headLen = h * p.headRatio;
  const legLen = h * p.legRatio;
  const torsoLen = h * p.torsoRatio;
  // Whatever stature is left after legs, torso and head belongs to the neck.
  // Clamped so an extreme proportion cannot produce a zero-length neck bone.
  const neckLen = Math.max(h * 0.035, h * (1 - p.legRatio - p.torsoRatio - p.headRatio));

  const ankleY = h * 0.038;
  const thighLen = (legLen - ankleY) * 0.52;
  const shinLen = legLen - ankleY - thighLen;
  const bulk = p.bulk;
  const top = 1 + p.topHeaviness;

  return {
    height: h,
    scale: p.scale,

    ankleY: originY + ankleY,
    kneeY: originY + ankleY + shinLen,
    hipY: originY + legLen,
    waistY: originY + legLen + torsoLen * 0.3,
    chestY: originY + legLen + torsoLen * 0.72,
    shoulderY: originY + legLen + torsoLen,
    neckY: originY + legLen + torsoLen + neckLen * 0.32,
    headY: originY + legLen + torsoLen + neckLen,
    headTopY: originY + legLen + torsoLen + neckLen + headLen,

    headLen,
    neckLen,
    torsoLen,
    legLen,
    thighLen,
    shinLen,
    footLen: h * 0.145,
    upperArmLen: h * p.armRatio * 0.52,
    foreArmLen: h * p.armRatio * 0.48,
    handLen: h * 0.105,
    armLen: h * p.armRatio,

    shoulderWidth: p.shoulderWidth,
    hipWidth: p.hipWidth,
    waistWidth: p.hipWidth * 0.86,
    chestWidth: p.shoulderWidth * 0.78 * top,
    stanceWidth: p.stanceWidth,
    chestDepth: p.shoulderWidth * 0.46 * top,
    waistDepth: p.hipWidth * 0.62,
    hipDepth: p.hipWidth * 0.72,
    headWidth: headLen * 0.66,
    headDepth: headLen * 0.78,

    upperArmR: h * 0.030 * bulk * (1 + p.topHeaviness * 0.5),
    foreArmR: h * 0.0255 * bulk,
    thighR: h * 0.0435 * bulk,
    shinR: h * 0.0315 * bulk,
    neckR: headLen * 0.27 * bulk,
    handR: h * 0.026 * bulk,
    bulk,
    topHeaviness: p.topHeaviness,
    stance: p.stance,
  };
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

export interface BoneSegment {
  /** Bind-pose start of the bone, rig space. */
  a: THREE.Vector3;
  /** Bind-pose end — the primary child, or a synthetic tip for a leaf. */
  b: THREE.Vector3;
  /** Capsule radius used by the skinner's influence mask and by IK collision. */
  r: number;
}

export interface Rig {
  /** The `root` bone. Not yet parented; the factory adds it to the unit group. */
  rootBone: THREE.Bone;
  bones: Record<BoneName, THREE.Bone>;
  /** In `BONE_ORDER`, which is the order `skeleton.bones` uses. */
  boneList: THREE.Bone[];
  skeleton: THREE.Skeleton;
  /** Bind-pose world position of every bone, rig space. */
  bindWorld: Record<BoneName, THREE.Vector3>;
  /** Bind-pose world matrix of every bone (rotation is identity by design). */
  bindMatrix: Record<BoneName, THREE.Matrix4>;
  /** Distance from each bone to its primary child, or to its synthetic tip. */
  bindLengths: Record<BoneName, number>;
  segments: Record<BoneName, BoneSegment>;
  proportions: UnitProportions;
  metrics: RigMetrics;
}

/** Left-arm A-pose angles, radians. Mirrored for the right. */
const UPPER_ARM_OUT = 0.30; // from vertical, in the coronal plane
const FORE_ARM_OUT = 0.20;
const ELBOW_BREAK = 0.14; // forward pre-bend so LBS knows which way it folds
const KNEE_BREAK = 0.10;

export interface RigOptions {
  /**
   * Translate the whole skeleton. A rider's rig is lifted to his seat height so
   * that parts authored from `bindWorld` land on the mount rather than beside
   * it; the humanoid convention of "feet at y = 0" only holds for foot units.
   */
  origin?: [number, number, number];
  /**
   * Extra rig-space offsets applied to a bone *and everything under it*, before
   * parent-local offsets are computed. This is how a seated bind pose is
   * authored: push `thighL`/`thighR` out and forward and the rider's legs
   * straddle the barrel in bind pose, so the mesh is built correctly rather
   * than being deformed into position by a clip.
   */
  offsets?: Partial<Record<BoneName, [number, number, number]>>;
}

/**
 * Build the skeleton for one proportion record.
 *
 * The bind pose is assembled in world (rig) space first — that is the only way
 * to think about a figure — and converted to parent-local offsets at the end.
 */
export function buildRig(p: UnitProportions, opts: RigOptions = {}): Rig {
  const origin = opts.origin ?? [0, 0, 0];
  // Vertical origin is folded into the metrics so every station is an absolute
  // rig-space height; the horizontal offset is applied at the end, after the
  // left/right mirroring, which is symmetric about x = 0.
  const m = computeMetrics(p, origin[1]);
  const W = {} as Record<BoneName, THREE.Vector3>;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // --- spine ---------------------------------------------------------------
  W.root = V(0, origin[1], 0);
  W.pelvis = V(0, m.hipY, 0);
  W.spine01 = V(0, m.hipY + m.torsoLen * 0.34, m.torsoLen * 0.012);
  W.spine02 = V(0, m.shoulderY, -m.torsoLen * 0.01);
  W.neck = V(0, m.neckY, -m.neckLen * 0.12);
  W.head = V(0, m.headY, -m.neckLen * 0.16);

  // --- arms (left, then mirrored) ------------------------------------------
  const clavY = m.shoulderY + m.torsoLen * 0.055;
  W.clavicleL = V(-m.shoulderWidth * 0.2, clavY, m.chestDepth * 0.06);
  const shoulder = V(-m.shoulderWidth * 0.5, clavY - m.torsoLen * 0.05, 0);
  W.upperArmL = shoulder.clone();
  W.foreArmL = shoulder
    .clone()
    .add(
      V(
        -Math.sin(UPPER_ARM_OUT) * m.upperArmLen,
        -Math.cos(UPPER_ARM_OUT) * m.upperArmLen,
        -Math.sin(ELBOW_BREAK) * m.upperArmLen,
      ),
    );
  W.handL = W.foreArmL.clone().add(
    V(
      -Math.sin(FORE_ARM_OUT) * m.foreArmLen,
      -Math.cos(FORE_ARM_OUT) * m.foreArmLen,
      Math.sin(ELBOW_BREAK * 0.4) * m.foreArmLen,
    ),
  );
  W.clavicleR = mirror(W.clavicleL);
  W.upperArmR = mirror(W.upperArmL);
  W.foreArmR = mirror(W.foreArmL);
  W.handR = mirror(W.handL);

  // --- legs ----------------------------------------------------------------
  const hipX = -m.hipWidth * 0.5;
  const footX = -m.stanceWidth * 0.5;
  W.thighL = V(hipX, m.hipY, 0);
  // The knee sits on the hip→ankle line, pushed forward (-Z) by the pre-break.
  const ankle = V(footX, m.ankleY, 0);
  const kneeT = m.thighLen / (m.thighLen + m.shinLen);
  W.shinL = V(
    hipX + (ankle.x - hipX) * kneeT,
    m.hipY + (m.ankleY - m.hipY) * kneeT,
    -Math.sin(KNEE_BREAK) * m.thighLen,
  );
  W.footL = ankle.clone();
  W.thighR = mirror(W.thighL);
  W.shinR = mirror(W.shinL);
  W.footR = mirror(W.footL);

  // --- resting lean --------------------------------------------------------
  // `stance` tilts everything above the pelvis forward about the hip joints. A
  // crew figure at 0.24 rad is visibly hunched over his machine; a general at
  // 0.02 is upright. Applied here rather than as an animation offset so the
  // bind pose the skinner sees is the pose the figure actually stands in.
  if (Math.abs(p.stance) > 1e-4) {
    const pivot = W.pelvis;
    const lean = new THREE.Matrix4().makeRotationX(-p.stance);
    for (const b of BONE_ORDER) {
      if (b === 'root' || b === 'pelvis') continue;
      if (b.startsWith('thigh') || b.startsWith('shin') || b.startsWith('foot')) continue;
      W[b].sub(pivot).applyMatrix4(lean).add(pivot);
    }
  }

  // --- authored bind-pose offsets ------------------------------------------
  // Applied to a bone and its whole subtree, so pushing `thighL` outward takes
  // the shin, foot and everything parented below it along.
  if (opts.offsets) {
    for (const name of BONE_ORDER) {
      const off = opts.offsets[name];
      if (!off) continue;
      const d = new THREE.Vector3(off[0], off[1], off[2]);
      for (const sub of subtree(name)) W[sub].add(d);
    }
  }

  // --- horizontal origin ---------------------------------------------------
  if (origin[0] !== 0 || origin[2] !== 0) {
    for (const name of BONE_ORDER) {
      W[name].x += origin[0];
      W[name].z += origin[2];
    }
  }

  // --- synthetic tips for leaf bones ---------------------------------------
  const tips: Partial<Record<BoneName, THREE.Vector3>> = {
    head: W.head.clone().add(V(0, m.headLen, 0)),
    handL: W.handL.clone().add(dirTo(W.foreArmL, W.handL).multiplyScalar(m.handLen)),
    handR: W.handR.clone().add(dirTo(W.foreArmR, W.handR).multiplyScalar(m.handLen)),
    footL: W.footL.clone().add(V(0, -m.ankleY * 0.5, -m.footLen)),
    footR: W.footR.clone().add(V(0, -m.ankleY * 0.5, -m.footLen)),
  };

  // --- capsule radii -------------------------------------------------------
  const R: Record<BoneName, number> = {
    // `root` is a transform handle, never an influence. Radius 0 excludes it.
    root: 0,
    pelvis: Math.max(m.hipWidth, m.hipDepth) * 0.62,
    spine01: Math.max(m.waistWidth, m.waistDepth) * 0.68,
    spine02: Math.max(m.chestWidth, m.chestDepth) * 0.72,
    neck: m.neckR * 2.1,
    head: m.headLen * 0.56,
    clavicleL: m.shoulderWidth * 0.2,
    clavicleR: m.shoulderWidth * 0.2,
    upperArmL: m.upperArmR * 2.4,
    upperArmR: m.upperArmR * 2.4,
    foreArmL: m.foreArmR * 2.4,
    foreArmR: m.foreArmR * 2.4,
    handL: m.handR * 2.6,
    handR: m.handR * 2.6,
    thighL: m.thighR * 2.3,
    thighR: m.thighR * 2.3,
    shinL: m.shinR * 2.5,
    shinR: m.shinR * 2.5,
    footL: m.footLen * 0.85,
    footR: m.footLen * 0.85,
  };

  // --- build the THREE hierarchy -------------------------------------------
  const bones = {} as Record<BoneName, THREE.Bone>;
  for (const name of BONE_ORDER) {
    const b = new THREE.Bone();
    b.name = name;
    bones[name] = b;
  }
  for (const name of BONE_ORDER) {
    const parent = BONE_PARENT[name];
    const local = parent ? W[name].clone().sub(W[parent]) : W[name].clone();
    bones[name].position.copy(local);
    if (parent) bones[parent].add(bones[name]);
  }
  const rootBone = bones.root;
  // Inverses must be taken with the rig at unit scale and unparented; the outer
  // group's `scale` is applied afterwards and must NOT be baked in here.
  rootBone.updateMatrixWorld(true);

  const boneList = BONE_ORDER.map((n) => bones[n]);
  const skeleton = new THREE.Skeleton(boneList);

  const bindMatrix = {} as Record<BoneName, THREE.Matrix4>;
  const segments = {} as Record<BoneName, BoneSegment>;
  const bindLengths = {} as Record<BoneName, number>;
  for (const name of BONE_ORDER) {
    bindMatrix[name] = bones[name].matrixWorld.clone();
    const child = PRIMARY_CHILD[name];
    const end = child ? W[child].clone() : (tips[name] ?? W[name].clone().add(V(0, 0.01, 0)));
    segments[name] = { a: W[name].clone(), b: end, r: R[name] };
    bindLengths[name] = W[name].distanceTo(end);
  }

  return {
    rootBone,
    bones,
    boneList,
    skeleton,
    bindWorld: W,
    bindMatrix,
    bindLengths,
    segments,
    proportions: p,
    metrics: m,
  };
}

function mirror(v: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(-v.x, v.y, v.z);
}

/** A bone and every bone beneath it, in `BONE_ORDER` sequence. */
function subtree(root: BoneName): BoneName[] {
  const out: BoneName[] = [];
  const stack: BoneName[] = [root];
  while (stack.length) {
    const b = stack.pop()!;
    out.push(b);
    stack.push(...BONE_CHILDREN[b]);
  }
  return out;
}

function dirTo(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 {
  const d = to.clone().sub(from);
  const l = d.length();
  return l > 1e-9 ? d.divideScalar(l) : new THREE.Vector3(0, -1, 0);
}

/**
 * Bind-pose lengths normalised against stature, so the animator can express a
 * clip in proportion-independent terms ("the hand travels 0.42 statures") and
 * have it land identically on every unit.
 */
export function normalisedBindLengths(rig: Rig): Record<BoneName, number> {
  const out = {} as Record<BoneName, number>;
  const h = rig.metrics.height || 1;
  for (const n of BONE_ORDER) out[n] = rig.bindLengths[n] / h;
  return out;
}

/** Reset every bone to its bind pose. Cheap; safe to call between captures. */
export function restPose(rig: Rig): void {
  for (const n of BONE_ORDER) {
    const b = rig.bones[n];
    b.quaternion.identity();
    b.scale.set(1, 1, 1);
  }
  rig.rootBone.updateMatrixWorld(true);
  rig.skeleton.update();
}

/** Inverse of a bone's bind matrix — rig space into that bone's local space. */
export function rigToBone(rig: Rig, name: BoneName): THREE.Matrix4 {
  return rig.bindMatrix[name].clone().invert();
}
