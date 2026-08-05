/**
 * The per-unit animator.
 *
 * One of these drives one figure. It owns the mixer, the retarget pass, the IK
 * solves and the contact resolution, and it enforces the order they run in:
 *
 *   1. `mixer.update(dt)`    — the authored clips write bone rotations
 *   2. **retarget**          — the normalised root curve is scaled by the
 *                              figure's stature, the turn lag is applied, and
 *                              the mount (hooves, wheels, trunk, beam) is driven
 *   3. **IK**                — hands onto hafts, reins and haul ropes; look-at
 *   4. **contact**           — feet planted, hips solved against them, soles
 *                              levelled on the board
 *
 * The order is not a preference. Contact resolution is last because it is
 * *authoritative*: it is allowed to move the root to keep a planted foot where
 * it is, and anything that ran after it could undo that. IK is before it because
 * a hand target is a request, and a foot plant is a fact.
 *
 * ## Gait phase comes from ground truth
 *
 * `reportTravel(distance)` is the only thing that advances a locomotion cycle.
 * Phase advances by `distance / stride`, wheels by `Δs / (radius · scale)` —
 * never by time. A wheel driven by a clock and a chariot driven by a tween
 * disagree the moment either one is retimed, and the disagreement is a skid.
 * Driving both from the same distance makes the skid unrepresentable.
 */

import * as THREE from 'three';
import {
  BONE_ORDER,
  type AnimState,
  type AttachName,
  type AudioEngine,
  type BoneName,
  type UnitAnimator,
  type UnitInstance,
} from '@core/contracts.ts';
import { clamp, damp } from '@core/types.ts';
import type { UnitKey } from '@core/types.ts';
import {
  buildClipSet,
  clipKeyFor,
  sampleRoot,
  trunkBend,
  trunkIdle,
  wrap01,
  type ClipSet,
  type HitDirection,
  type NormalisedClip,
} from './clips.ts';
import {
  chainReach,
  heelOffAmount,
  makeAimChain,
  makeChain,
  makeFootLock,
  makeIkContext,
  rigPosition,
  solveAim,
  solveTwoBone,
  stanceWeight,
  swingLift,
  toRig,
  updateIkContext,
  type AimChain,
  type FootLock,
  type IkContext,
  type TwoBoneChain,
} from './ik.ts';
import { CANTER, CLIP, FADE, GAIT, IK, LUMBER, ROLL, WALK, type GaitName } from './timing.ts';

// ===========================================================================
// Module-level scratch. Nothing in `update()` allocates.
// ===========================================================================

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _q4 = new THREE.Quaternion();
const _qIdentity = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _root3 = new Float64Array(3);
const _rootAcc = new Float64Array(3);
const _trunk = { curl: 0, sweep: 0 };
/** Hoisted: an array literal inside a per-frame loop is a per-frame allocation. */
const SIDES = ['L', 'R'] as const;

// ===========================================================================
// Hand constraints
// ===========================================================================

/**
 * How one hand finds its target. Each unit's hands are constrained the way that
 * unit's hands actually work, which is why this is a small table and not a
 * single "put the left hand on the weapon" rule.
 */
type HandSource =
  /** A point along the polearm haft, between the grip and the far tip. */
  | { kind: 'haft'; at: number }
  /** Toward a named socket on the mount, blended from the bind hand position. */
  | { kind: 'socket'; socket: AttachName; blend: number }
  /** Onto a named mount bone — the trebuchet's haul ropes follow the beam. */
  | { kind: 'mountBone'; bone: string; blend: number; lift: number }
  /** Held at its bind position in rig space: a rail, a pommel, a brace. */
  | { kind: 'bind' };

interface HandPlan {
  L?: HandSource;
  R?: HandSource;
}

const HAND_PLAN: Record<UnitKey, HandPlan> = {
  // Both hands on the 戈: the left runs the haft a third of the way to the head.
  soldier: { L: { kind: 'haft', at: 0.34 } },
  // The 劍 is a one-handed weapon; the off hand is free and the clips pose it.
  advisor: {},
  // The 節 is carried, not fought with; the off hand stays at the belt.
  general: { L: { kind: 'bind' } },
  // Both hands live on the haul ropes and are dragged when the beam whips.
  cannon: {
    L: { kind: 'mountBone', bone: 'treb.weight', blend: 1, lift: 0.06 },
    R: { kind: 'mountBone', bone: 'treb.weight', blend: 1, lift: 0.06 },
  },
  // Rein hand forward and low, following the horse's head a quarter of the way.
  horse: { L: { kind: 'socket', socket: 'reinL', blend: 0.24 } },
  // One hand on the howdah rail, the goad in the other.
  elephant: { L: { kind: 'bind' } },
  // Both hands on the reins, braced against the front rail.
  chariot: {
    L: { kind: 'socket', socket: 'reinL', blend: 0.18 },
    R: { kind: 'socket', socket: 'reinR', blend: 0.14 },
  },
};

// ===========================================================================
// Options
// ===========================================================================

export interface AnimatorOptions {
  /** Board height under a world point. Feet are planted against it. */
  ground?: ((x: number, z: number) => number) | null;
  /** Optional: footfalls and hoofbeats are played from the contact solver. */
  audio?: AudioEngine | null;
  /**
   * Deterministic phase offset so a rank of five soldiers does not breathe and
   * step in lockstep. Comes from the unit's variant, never from a clock.
   */
  variant?: number;
  /** Master gain on footfall audio. 0 disables it. */
  footstepGain?: number;
}

interface LegRig {
  chain: TwoBoneChain;
  foot: THREE.Object3D;
  lock: FootLock;
  contact: number;
  /** Signed lateral offset of the ankle from its own hip at bind, rig units. */
  lateral: number;
}

/** How long a closing step takes when a walk stops mid-swing. */
const CLOSE_STEP_SECONDS = 0.21;

/**
 * Contact authority for one hoof, given its progress `p` through the cycle since
 * its own footfall: zero through swing, a full 1 through the middle of stance,
 * and a short smoothstep at each end.
 *
 * The full 1 matters. A partial-authority solve leaves the hoof part-way between
 * the drive curve's guess and the plant, and that gap, differenced frame to
 * frame, *is* the skate — the same argument the biped's foot solve makes, and
 * the same answer.
 */
function hoofAuthority(p: number, duty: number): number {
  if (!(duty > 0) || p >= duty) return 0;
  const u = p / duty;
  const b = IK.hoofBlend;
  const t = u < b ? u / b : u > 1 - b ? (1 - u) / b : 1;
  return t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/** One resolved quadruped leg chain, with its place in the footfall order. */
interface QuadLeg {
  upper: THREE.Object3D;
  mid: THREE.Object3D | null;
  lower: THREE.Object3D | null;
  contact: number;
  duty: number;
  /** A fore leg's knee is a wrist and folds backward; a hind hock folds forward. */
  fore: boolean;
  /**
   * The two-bone solve used to hold the hoof still through stance. `null` when
   * the mount's leg is a single segment and there is nothing to solve.
   */
  chain: TwoBoneChain | null;
  /** The node that actually touches the board — the hoof, below the chain's tip. */
  contactNode: THREE.Object3D;
  /** Rig-space height of that node at bind, i.e. its clearance over the board. */
  bindY: number;
  /** Signed lateral offset of the hoof at bind, so a footfall can be panned. */
  lateral: number;
  /** Hip height above the hoof at bind, rig units. Sets the stride and the sweep. */
  hipHeight: number;
  /**
   * Half the stance sweep of the upper bone, radians, derived from the stride.
   * Seeded from the old fixed value and overwritten once the stride is known.
   */
  stanceSwing: number;
  lock: FootLock;
}

// ===========================================================================
// Animator
// ===========================================================================

export class Animator implements UnitAnimator {
  readonly unit: UnitInstance;

  private readonly mixer: THREE.AnimationMixer;
  private readonly clips: ClipSet;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  /** The same actions as a flat array, so the per-frame blend never iterates a Map. */
  private readonly layers: { action: THREE.AnimationAction; clip: NormalisedClip }[] = [];
  /** Wheel bones, resolved once. `Object.keys` in an update path is a per-frame array. */
  private readonly wheels: THREE.Object3D[] = [];
  private wheelRadius = 0;
  private readonly ikCtx: IkContext;

  private readonly key: UnitKey;
  private readonly gait: GaitName;
  private readonly plan = GAIT.march;
  private readonly height: number;
  private readonly scale: number;

  /** Bind-pose rig-space positions, captured before anything animates. */
  private readonly bind = new Map<string, THREE.Vector3>();
  private readonly bindRoot = new THREE.Vector3();
  private readonly bindHandL = new THREE.Vector3();
  private readonly bindHandR = new THREE.Vector3();

  private readonly legs: { L: LegRig; R: LegRig };
  private readonly arms: { L: TwoBoneChain; R: TwoBoneChain };
  private readonly gazeChain: AimChain;
  private readonly gazeTip: THREE.Object3D;
  private trunkChain: AimChain | null = null;
  private trunkBones: THREE.Object3D[] = [];
  /**
   * The mount's bones, resolved once. Every one of these used to be a template
   * literal built inside `update()`; a string per bone per frame per unit is
   * exactly the sort of garbage the frame budget cannot afford.
   */
  private readonly quadLegs: QuadLeg[] = [];
  private mountSpine: THREE.Object3D | null = null;
  private mountNeck: THREE.Object3D | null = null;
  private mountHead: THREE.Object3D | null = null;
  private mountBody: THREE.Object3D | null = null;
  private mountBeam: THREE.Object3D | null = null;
  private readonly mountTail: THREE.Object3D[] = [];
  private readonly mountEars: THREE.Object3D[] = [];
  private mountSpineBaseY = 0;
  /** Contact-driven drop of the mount's barrel, rig units. Re-derived per frame. */
  private mountGive = 0;

  private state: AnimState = 'idle';
  private stateKey: string;
  private hitDir: HitDirection = 'F';

  private travel = 0;
  private gaitPhase = 0;
  private wheelAngle = 0;
  private strideWorld = 1;
  private ankleHeight = 0;
  private floorLocal = 0;
  private legLength = 1;
  private footLength = 0.1;

  /** Attack progress, 0..2, mirrored from the live windup/strike actions. */
  private attackProgress = 0;

  private ground: ((x: number, z: number) => number) | null = null;
  private readonly handTarget: { L: THREE.Vector3 | null; R: THREE.Vector3 | null } = {
    L: null,
    R: null,
  };
  private lookTarget: THREE.Vector3 | null = null;
  private lookWeight = 0;
  private trunkTarget: THREE.Vector3 | null = null;

  private yaw = 0;
  private yawTarget = 0;
  private chestYaw = 0;
  private headYaw = 0;

  private audio: AudioEngine | null;
  private footstepGain: number;
  private frozen = false;
  private idleOffset = 0;
  private phaseOffset = 0;
  private gaitSource: 'travel' | 'time' = 'travel';

  /** Contact-solver correction: persists between frames and decays. */
  private readonly rootCorrection = new THREE.Vector3();
  /** Deck follow for a crew standing on a vehicle. Absolute, rewritten every frame. */
  private readonly deckOffset = new THREE.Vector3();
  /** The mount bone the seated legs are held against, and its bind position. */
  private mountAnchor: THREE.Object3D | null = null;
  private readonly mountAnchorBind = new THREE.Vector3();
  private readonly mountDelta = new THREE.Vector3();

  constructor(unit: UnitInstance, opts: AnimatorOptions = {}) {
    this.unit = unit;
    this.key = unit.meta.key;
    this.gait = unit.meta.gait as GaitName;
    this.plan = GAIT[this.gait] ?? GAIT.march;
    this.height = unit.meta.proportions.height;
    this.scale = unit.root.scale.x || unit.meta.proportions.scale || 1;
    this.audio = opts.audio ?? null;
    this.footstepGain = opts.footstepGain ?? 0.34;
    this.ground = opts.ground ?? null;

    this.clips = buildClipSet(this.key, this.gait);
    this.mixer = new THREE.AnimationMixer(unit.root);
    this.ikCtx = makeIkContext(unit.root);

    const b = unit.bones;
    this.bindRoot.copy(b.root.position);

    // Capture the bind pose in rig space before a single clip has run. Every
    // neutral position the solver ever needs is measured here rather than
    // recomputed from a rig object this class deliberately does not hold.
    unit.root.updateMatrixWorld(true);
    updateIkContext(this.ikCtx, unit.root);
    for (const name of BONE_ORDER) {
      this.bind.set(name, rigPosition(this.ikCtx, b[name], new THREE.Vector3()));
    }
    this.bindHandL.copy(this.bind.get('handL')!);
    this.bindHandR.copy(this.bind.get('handR')!);

    this.legLength = b.shinL.position.length() + b.footL.position.length();
    // Foot length in world units, from the proportion table's own ratio.
    this.footLength = this.height * 0.145 * this.scale;
    this.ankleHeight = this.bind.get('footL')!.y - this.bindRoot.y;
    this.floorLocal = this.bindRoot.y;
    // Provisional: the biped's own stride. A mounted figure overrides it in
    // `deriveMountStride()` once the mount's bones have been resolved, because
    // the leg that sets the stride is the leg that is on the ground.
    this.strideWorld = Math.max(0.05, this.plan.strideOverLeg * this.legLength * this.scale);

    // --- chains -------------------------------------------------------------
    // Knees keep their bend plane in rig space: a knee points forward whatever
    // the pelvis is doing. Elbows carry theirs with the clavicle, so the bend
    // plane swings with the shoulder instead of sticking to the world.
    const mkLeg = (side: 'L' | 'R'): LegRig => ({
      chain: makeChain(
        b[`thigh${side}` as BoneName],
        b[`shin${side}` as BoneName],
        b[`foot${side}` as BoneName],
        { poleSpace: 'rig' },
      ),
      foot: b[`foot${side}` as BoneName],
      lock: makeFootLock(),
      contact: side === 'L' ? this.plan.contactL : this.plan.contactR,
      lateral: this.bind.get(`foot${side}`)!.x - this.bind.get(`thigh${side}`)!.x,
    });
    this.legs = { L: mkLeg('L'), R: mkLeg('R') };
    this.arms = {
      L: makeChain(b.upperArmL, b.foreArmL, b.handL, { poleSpace: 'parent' }),
      R: makeChain(b.upperArmR, b.foreArmR, b.handR, { poleSpace: 'parent' }),
    };

    // --- gaze ---------------------------------------------------------------
    // The head needs a forward reference to aim; the rig has no such bone, so
    // one is parented under `head`. It is a transform, not geometry.
    const headLen = this.height * unit.meta.proportions.headRatio;
    this.gazeTip = new THREE.Object3D();
    this.gazeTip.name = 'anim:gaze';
    this.gazeTip.position.set(0, headLen * 0.42, -headLen * 0.75);
    b.head.add(this.gazeTip);
    this.gazeChain = makeAimChain(
      [b.neck, b.head],
      this.gazeTip,
      [IK.neckShare * IK.aimShare, IK.headShare],
      [IK.aimClamp * 0.6, IK.aimClamp],
    );

    this.setupTrunk();
    this.setupMount();

    // The bone a seated rider's legs are held against.
    const anchorName =
      unit.meta.mount === 'horse'
        ? 'horse.spine'
        : unit.meta.mount === 'elephant'
          ? 'elephant.spine'
          : unit.meta.mount === 'chariot'
            ? 'chariot.body'
            : null;
    if (anchorName && unit.mountBones[anchorName]) {
      this.mountAnchor = unit.mountBones[anchorName];
      rigPosition(this.ikCtx, this.mountAnchor, this.mountAnchorBind);
    }

    // --- actions ------------------------------------------------------------
    for (const [k, n] of this.clips) {
      const action = this.mixer.clipAction(n.clip);
      action.setLoop(n.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      action.clampWhenFinished = !n.loop;
      action.enabled = true;
      action.setEffectiveWeight(0);
      this.actions.set(k, action);
      this.layers.push({ action, clip: n });
    }

    for (const name of Object.keys(unit.mountBones)) {
      if (!name.includes('wheel')) continue;
      const bone = unit.mountBones[name];
      this.wheels.push(bone);
      const r = (bone.userData?.radius as number | undefined) ?? 0;
      if (r > this.wheelRadius) this.wheelRadius = r;
    }
    this.deriveMountStride();

    // Deterministic phase offsets, drawn from the unit's variant rather than a
    // clock, so five soldiers in a rank are out of step with each other and are
    // still byte-identical between runs. The two multipliers are the golden
    // ratio and its conjugate: successive variants land as far apart on the
    // cycle as it is possible for them to land.
    const variant = opts.variant ?? 0;
    this.idleOffset = ((((variant * 0.3819660112) % 1) + 1) % 1) * CLIP.idle;
    this.phaseOffset = (((variant * 0.6180339887) % 1) + 1) % 1;

    this.stateKey = clipKeyFor(this.key, 'idle');
    const idle = this.actions.get(this.stateKey)!;
    idle.setEffectiveWeight(1);
    idle.time = this.idleOffset;
    idle.play();
    this.gaitPhase = this.phaseOffset;
  }

  /**
   * Return the figure to a clean rest: bind pose, idle at its own phase offset,
   * every damped follower and every foot lock discharged.
   *
   * The harness contract is that a frame captured after `step()` is
   * *deterministic*, and an animator carries a lot of state that is a function
   * of history rather than of the clock — root corrections, foot locks, the
   * turn lag, the look-at weight. Scrubbing a capture to the same `t` twice has
   * to give the same frame, so a scrub resets through here first.
   */
  reset(): void {
    for (const a of this.actions.values()) {
      a.stop();
      a.paused = false;
      a.setEffectiveWeight(0);
      a.setEffectiveTimeScale(1);
      a.time = 0;
    }
    for (const name of BONE_ORDER) {
      this.unit.bones[name].quaternion.identity();
    }
    this.unit.bones.root.position.copy(this.bindRoot);
    this.rootCorrection.set(0, 0, 0);
    this.deckOffset.set(0, 0, 0);
    this.travel = 0;
    this.gaitPhase = this.phaseOffset;
    this.wheelAngle = 0;
    this.attackProgress = 0;
    this.frozen = false;
    this.handTarget.L = null;
    this.handTarget.R = null;
    this.lookTarget = null;
    this.lookWeight = 0;
    this.trunkTarget = null;
    this.chestYaw = this.yaw;
    this.headYaw = this.yaw;
    this.yawTarget = this.yaw;
    for (const side of SIDES) {
      const lock = this.legs[side].lock;
      lock.locked = false;
      lock.primed = false;
      lock.weight = 0;
      lock.closing = 1;
      lock.heelOff = 0;
      lock.world.set(0, 0, 0);
      lock.from.set(0, 0, 0);
      lock.to.set(0, 0, 0);
    }
    for (let i = 0; i < this.quadLegs.length; i++) {
      const lock = this.quadLegs[i].lock;
      lock.locked = false;
      lock.primed = false;
      lock.weight = 0;
      lock.world.set(0, 0, 0);
    }
    this.mountGive = 0;
    if (this.mountSpine) this.mountSpine.position.y = this.mountSpineBaseY;
    this.state = 'idle';
    this.stateKey = clipKeyFor(this.key, 'idle');
    const idle = this.actions.get(this.stateKey)!;
    idle.enabled = true;
    idle.setEffectiveWeight(1);
    idle.time = this.idleOffset;
    idle.play();
    this.unit.root.updateMatrixWorld(true);
    updateIkContext(this.ikCtx, this.unit.root);
    this.unit.skeleton.update();
  }

  // -------------------------------------------------------------------------
  // Mount wiring
  // -------------------------------------------------------------------------

  /** Resolve every mount bone the frame loop touches, once. */
  private setupMount(): void {
    const mb = this.unit.mountBones;
    const quad = (prefix: string, contact: number, duty: number, fore: boolean): void => {
      const b1 = mb[`${prefix}01`];
      if (!b1) return;
      const mid = mb[`${prefix}02`] ?? null;
      const lower = mb[`${prefix}03`] ?? null;
      // `04` is the hoof: the segment that is actually on the board. The drive
      // curve never writes it — it hangs off the pastern — which is exactly why
      // it is the right thing to lock, and the wrong thing to solve *to*.
      const hoof = mb[`${prefix}04`] ?? lower ?? mid ?? b1;
      const chain = mid && lower ? makeChain(b1, mid, lower, { poleSpace: 'rig' }) : null;
      rigPosition(this.ikCtx, hoof, _v);
      rigPosition(this.ikCtx, b1, _v2);
      this.quadLegs.push({
        upper: b1,
        mid,
        lower,
        contact,
        duty,
        fore,
        chain,
        contactNode: hoof,
        bindY: _v.y,
        lateral: _v.x,
        hipHeight: Math.max(1e-3, _v2.y - _v.y),
        stanceSwing: 0.34,
        lock: makeFootLock(),
      });
    };
    switch (this.unit.meta.mount) {
      case 'horse':
        // Right lead: left hind, then the diagonal pair, then the leading right
        // fore, then suspension. That order is what makes it a canter and not a
        // trot, and it is the first thing anyone who rides will check.
        quad('horse.legHL', CANTER.hindL, CANTER.duty, false);
        quad('horse.legHR', CANTER.hindR, CANTER.duty, false);
        quad('horse.legFL', CANTER.foreL, CANTER.duty, true);
        quad('horse.legFR', CANTER.foreR, CANTER.duty, true);
        this.mountSpine = mb['horse.spine'] ?? null;
        this.mountNeck = mb['horse.neck'] ?? null;
        this.mountHead = mb['horse.head'] ?? null;
        for (const n of ['horse.tail01', 'horse.tail02', 'horse.tail03']) {
          if (mb[n]) this.mountTail.push(mb[n]);
        }
        break;
      case 'elephant':
        // Lateral sequence: hind then fore on the same side, never in
        // suspension. Three feet are on the ground at every instant.
        quad('elephant.legHL', LUMBER.hindL, LUMBER.duty, false);
        quad('elephant.legFL', LUMBER.foreL, LUMBER.duty, true);
        quad('elephant.legHR', LUMBER.hindR, LUMBER.duty, false);
        quad('elephant.legFR', LUMBER.foreR, LUMBER.duty, true);
        this.mountSpine = mb['elephant.spine'] ?? null;
        this.mountNeck = mb['elephant.neck'] ?? null;
        this.mountHead = mb['elephant.head'] ?? null;
        for (const n of ['elephant.earL', 'elephant.earR']) {
          if (mb[n]) this.mountEars.push(mb[n]);
        }
        break;
      case 'chariot':
        this.mountBody = mb['chariot.body'] ?? null;
        break;
      case 'trebuchet':
        this.mountBeam = mb['treb.beam'] ?? null;
        break;
      default:
        break;
    }
    if (this.mountSpine) this.mountSpineBaseY = this.mountSpine.position.y;
  }

  /**
   * A mount's stride belongs to the mount.
   *
   * `strideOverLeg` is a multiple of *the leg of the thing that is walking*, and
   * for a cavalryman the thing that is walking is the horse. `legLength` above is
   * measured off the biped rig — the rider's thigh and shin — so a mounted unit
   * used to derive its hoof rate from the man sitting on it. It is not a rounding
   * error: the 馬's rider is 0.42 rig units of leg against the horse's 0.72 of
   * hip height, so every hoof cycled 1.7× too fast for the ground it covered, the
   * 象 2.4× too fast, and the 俥's deck — whose "leg" is a *wheel* — pitched and
   * rocked eleven times per revolution instead of once.
   *
   * Hip height, not the summed segment lengths: it is the ground clearance of the
   * shoulder that sets how far a leg can swing, and it is the measure every
   * dimensionless gait number in the literature is expressed against.
   */
  private deriveMountStride(): void {
    if (!this.plan.seated) return;
    let hipHeight = 0;
    for (const leg of this.quadLegs) hipHeight = Math.max(hipHeight, leg.hipHeight);
    if (hipHeight > 1e-4) {
      this.strideWorld = Math.max(0.05, this.plan.strideOverLeg * hipHeight * this.scale);
      // And now the sweep, from the stride: over its stance a hoof must travel
      // `duty × stride` backward relative to the body, so the upper bone sweeps
      // the angle that carries a leg of this length exactly that far. Deriving
      // it rather than authoring it is what makes the same curve serve a canter
      // and a lumber, and what stops a retimed gait from becoming a skate.
      const strideRig = this.strideWorld / this.scale;
      for (const leg of this.quadLegs) {
        const chord = 0.5 * leg.duty * strideRig;
        leg.stanceSwing = Math.min(IK.hoofSwingMax, Math.asin(clamp(chord / leg.hipHeight, -1, 1)));
      }
      return;
    }
    if (this.wheelRadius > 0) {
      // A wheeled mount has no leg and needs none: one revolution of its own
      // wheel is exactly the ground one cycle of the deck covers, so the pitch
      // and the rock are phased on the axle that produces them.
      this.strideWorld = Math.max(
        0.05,
        this.plan.strideOverLeg * 2 * Math.PI * this.wheelRadius * this.scale,
      );
    }
  }

  private setupTrunk(): void {
    const bones: THREE.Object3D[] = [];
    for (let i = 1; i <= 24; i++) {
      const n = `elephant.trunk${String(i).padStart(2, '0')}`;
      const o = this.unit.mountBones[n];
      if (!o) break;
      bones.push(o);
    }
    if (bones.length === 0) return;
    this.trunkBones = bones;
    const tip = this.unit.attach.trunkTip ?? bones[bones.length - 1];
    // Shares ramp toward the tip: the base of a trunk is a heavy muscle and the
    // last three segments do most of the pointing.
    const shares = bones.map((_, i) => 0.12 + 0.5 * ((i + 1) / bones.length) ** 2);
    const clamps = bones.map(() => 0.42);
    this.trunkChain = makeAimChain(bones, tip, shares, clamps);
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  play(state: AnimState, fade?: number, opts?: { speed?: number; loop?: boolean }): void {
    const key = clipKeyFor(this.key, state, this.hitDir);
    const next = this.actions.get(key);
    if (!next) return;
    const clip = this.clips.get(key)!;
    const prevKey = this.stateKey;
    const prev = this.actions.get(prevKey);

    const f = fade ?? this.defaultFade(state);
    const speed = opts?.speed ?? 1;

    if (key === prevKey) {
      // Re-triggering the same state restarts a one-shot and leaves a loop alone.
      if (!clip.loop) {
        next.reset();
        next.setEffectiveWeight(1);
        next.setEffectiveTimeScale(speed);
        next.play();
      }
      this.state = state;
      return;
    }

    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(this.travelDriven(state) ? 0 : speed);
    next.setEffectiveWeight(1);
    if (opts?.loop === false) {
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
    }
    next.play();
    if (prev && prev !== next && f > 0) {
      // `warp` is off deliberately: a travel-driven gait owns its own time scale
      // and a warp would fight it for control of the same value.
      next.crossFadeFrom(prev, f, false);
    } else if (prev && prev !== next) {
      prev.setEffectiveWeight(0);
      prev.stop();
    }

    // Entering `move` from rest starts on the phase we already hold, so a unit
    // that stops and starts does not teleport its feet.
    if (state === 'move') next.time = this.gaitPhase * clip.duration;
    if (this.state === 'move' && state !== 'move' && !this.plan.seated) this.beginClosingStep();
    if (state === 'death') this.releaseFeet();

    this.state = state;
    this.stateKey = key;
  }

  private defaultFade(state: AnimState): number {
    switch (state) {
      case 'idle':
        return FADE.toIdle;
      case 'move':
        return FADE.toMove;
      case 'attackWindup':
        return FADE.toWindup;
      case 'attackStrike':
        return FADE.windupToStrike;
      case 'hit':
        return FADE.toHit;
      case 'death':
        return FADE.toDeath;
      case 'victory':
        return FADE.toVictory;
      case 'salute':
        return FADE.toSalute;
      default:
        return FADE.toIdle;
    }
  }

  /** Locomotion is travel-driven; everything else runs on the mixer's clock. */
  private travelDriven(state: AnimState): boolean {
    return state === 'move';
  }

  duration(state: AnimState): number {
    const c = this.clips.get(clipKeyFor(this.key, state, this.hitDir));
    return c ? c.duration : 0;
  }

  /** Progress through the current one-shot, 0..1. Loops report their phase. */
  progress(): number {
    const a = this.actions.get(this.stateKey);
    const c = this.clips.get(this.stateKey);
    if (!a || !c || c.duration <= 0) return 1;
    return clamp(a.time / c.duration, 0, 1);
  }

  /** True once the current one-shot has clamped at its end. */
  finished(): boolean {
    const c = this.clips.get(this.stateKey);
    if (!c || c.loop) return false;
    return this.progress() >= 1 - 1e-6;
  }

  /**
   * Park a one-shot at a normalised time and stop its clock. This is how the
   * choreographer holds at the top of a windup, and how `__XQ.seekUnitState`
   * gets an exact frame out of the middle of a strike.
   */
  hold(state: AnimState, t: number): void {
    const key = clipKeyFor(this.key, state, this.hitDir);
    const a = this.actions.get(key);
    const c = this.clips.get(key);
    if (!a || !c) return;
    for (const [k, other] of this.actions) {
      if (k !== key) other.setEffectiveWeight(0);
    }
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.setEffectiveTimeScale(0);
    a.time = clamp(t, 0, 1) * c.duration;
    a.play();
    this.state = state;
    this.stateKey = key;
    if (state === 'move') this.gaitPhase = wrap01(t);
  }

  /** Resume normal playback after a `hold`. */
  release(speed = 1): void {
    const a = this.actions.get(this.stateKey);
    if (a) a.setEffectiveTimeScale(this.travelDriven(this.state) ? 0 : speed);
  }

  /**
   * Stop or restart this figure's clock without touching its pose.
   *
   * This is the frozen-time hold at the moment of impact: the bodies stop dead
   * for two and a half frames while the flash and the camera keep running.
   * Pausing the actions rather than zeroing dt keeps cross-fade weights alive,
   * so a fade that was in flight when the world stopped resumes correctly.
   */
  freeze(on: boolean): void {
    for (const a of this.actions.values()) a.paused = on;
    this.frozen = on;
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  /**
   * Choose the directional hit variant from a world-space impulse.
   *
   * `worldDir` is the direction the blow **travels** — attacker toward defender,
   * the same vector the camera impulse and the knockback take, and the same one
   * both call sites in the choreographer already pass.
   *
   * The variant is named for where the blow came *from*, which is the opposite,
   * and that negation is the whole of this function. It was missing, and the
   * sign error was worth naming: a soldier struck in the chest selected the
   * struck-from-behind clip, so the clip arched his torso and pushed his root
   * *toward* the spear while the choreographer's knockback dragged his square
   * away from it. The two cancel to within a few millimetres, and what is left
   * on screen is a figure sliding backward with a vertical torso and an arm
   * coming up — the exact shape of "the hit is a translation, not a reaction".
   */
  setHitDirection(worldDir: THREE.Vector3): void {
    _v.copy(worldDir).applyQuaternion(this.ikCtx.rootQuatInv).negate();
    // Rig forward is −Z. A blow that came from straight ahead therefore has a
    // rig-space source direction of −Z, and `atan2(x, z)` puts that at ±π.
    const angle = Math.atan2(_v.x, _v.z);
    const a = ((angle + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (a > -Math.PI / 4 && a <= Math.PI / 4) this.hitDir = 'B';
    else if (a > Math.PI / 4 && a <= (3 * Math.PI) / 4) this.hitDir = 'R';
    else if (a <= -Math.PI / 4 && a > (-3 * Math.PI) / 4) this.hitDir = 'L';
    else this.hitDir = 'F';
  }

  // -------------------------------------------------------------------------
  // External drivers
  // -------------------------------------------------------------------------

  reportTravel(distance: number): void {
    this.travel += distance;
  }

  /**
   * Where a locomotion cycle's phase comes from.
   *
   * `'travel'` is the shipping mode and the only one the game uses: phase
   * advances by distance covered, so a hoof or a wheel can never disagree with
   * the ground. `'time'` exists for the capture harness, which needs to watch a
   * unit walk on the spot in a showcase where nothing is moving it.
   */
  setGaitSource(source: 'travel' | 'time'): void {
    this.gaitSource = source;
  }

  setGroundHeight(fn: ((x: number, z: number) => number) | null): void {
    this.ground = fn;
  }

  setHandTarget(side: 'L' | 'R', target: THREE.Vector3 | null): void {
    if (!target) {
      this.handTarget[side] = null;
      return;
    }
    if (!this.handTarget[side]) this.handTarget[side] = new THREE.Vector3();
    this.handTarget[side]!.copy(target);
  }

  /** Aim the head at a world point. `null` releases it. */
  setLookTarget(target: THREE.Vector3 | null): void {
    if (!target) {
      this.lookTarget = null;
      return;
    }
    if (!this.lookTarget) this.lookTarget = new THREE.Vector3();
    this.lookTarget.copy(target);
  }

  /** Aim the elephant's trunk at a world point. Ignored by everything else. */
  setTrunkTarget(target: THREE.Vector3 | null): void {
    if (!target) {
      this.trunkTarget = null;
      return;
    }
    if (!this.trunkTarget) this.trunkTarget = new THREE.Vector3();
    this.trunkTarget.copy(target);
  }

  /**
   * Turn the figure. The root yaw is rate-limited and the spine and head follow
   * it with their own lags, so a turn starts at the hips, reaches the shoulders
   * ~75 ms later and the head ~135 ms after that. Snapping the root's rotation
   * from outside skips all of that, which is why nothing else may write it.
   */
  setFacing(yaw: number, immediate = false): void {
    this.yawTarget = yaw;
    if (immediate) {
      this.yaw = yaw;
      this.chestYaw = yaw;
      this.headYaw = yaw;
      this.unit.root.rotation.y = yaw;
    }
  }

  get facing(): number {
    return this.yaw;
  }

  /** Total wheel rotation so far, radians. Exposed for verification. */
  get wheelRotation(): number {
    return this.wheelAngle;
  }

  get phase(): number {
    return this.gaitPhase;
  }

  // -------------------------------------------------------------------------
  // The frame
  // -------------------------------------------------------------------------

  update(dt: number): void {
    if (!(dt >= 0)) dt = 0;

    // --- 0. gait phase, from ground truth ----------------------------------
    if (this.travel !== 0) {
      this.gaitPhase = wrap01(this.gaitPhase + this.travel / this.strideWorld);
      this.spinWheels(this.travel);
      this.travel = 0;
    } else if (this.gaitSource === 'time' && this.state === 'move') {
      const d = (dt / this.plan.cycle) * this.strideWorld;
      this.gaitPhase = wrap01(this.gaitPhase + dt / this.plan.cycle);
      this.spinWheels(d);
    }
    if (this.state === 'move') {
      const c = this.clips.get(this.stateKey);
      const a = this.actions.get(this.stateKey);
      if (c && a) a.time = this.gaitPhase * c.duration;
    }

    // --- 1. mixer -----------------------------------------------------------
    this.mixer.update(dt);

    // --- 2. retarget --------------------------------------------------------
    this.retarget(dt);
    this.unit.root.updateMatrixWorld(true);
    updateIkContext(this.ikCtx, this.unit.root);

    // --- 3. IK --------------------------------------------------------------
    this.solveHands();
    this.solveGaze(dt);

    // --- 4. contact ---------------------------------------------------------
    this.resolveContacts(dt);

    this.autoChain();

    this.unit.bones.root.updateMatrixWorld(true);
    this.unit.skeleton.update();
  }

  // -------------------------------------------------------------------------
  // 2. Retarget
  // -------------------------------------------------------------------------

  /**
   * Turn normalised authored motion into this figure's motion.
   *
   * Clip rotations need nothing: they are proportion-free by construction. The
   * root curve is in statures and is multiplied by this figure's height here —
   * that single multiply is the whole retarget, and it is why one authored clip
   * serves a 0.60-scale conscript and a 1.60-scale chariot.
   */
  private retarget(dt: number): void {
    // The trunk and the trebuchet beam are driven from attack progress, so it
    // has to be current before the mount drive runs at the end of this pass.
    this.updateAttackProgress();

    // Root offset, blended across every live action exactly the way the mixer
    // blends the rotations: weighted, then normalised by the total weight.
    //
    // "Exactly the way the mixer does" is the whole contract, and the predicate
    // is where it was broken. `AnimationAction.isRunning()` is not the test for
    // whether an action is *contributing* — it is `enabled && !paused &&
    // timeScale !== 0 && …`, and the mixer accumulates on `enabled && weight`
    // alone. Every one of those extra terms is a state this animator puts actions
    // into deliberately:
    //
    //   `timeScale === 0`  every travel-driven `move`, so the gait is advanced by
    //                      distance instead of by the clock. The walk's root
    //                      curve — the whole vertical bob — never reached a
    //                      single figure on the board.
    //   `paused`           the frozen-time hold at contact, and every one-shot
    //                      that has clamped: `clampWhenFinished` pauses the
    //                      action at its last frame. So a corpse held its folded
    //                      *rotations* while its root sprang back to the standing
    //                      bind height, and the dead soldier stood up.
    //   `timeScale === 0`  again, in `hold()`, which is how the choreographer
    //                      parks at the top of a windup.
    //
    // In every one of those cases the rotations kept arriving and the root
    // offset silently stopped, which is the most confusing failure this class
    // can have: the pose is right and the figure is at the wrong height.
    _rootAcc[0] = 0;
    _rootAcc[1] = 0;
    _rootAcc[2] = 0;
    let total = 0;
    for (let i = 0; i < this.layers.length; i++) {
      const { action, clip: c } = this.layers[i];
      const w = action.getEffectiveWeight();
      if (w <= 1e-4 || !action.enabled) continue;
      sampleRoot(c.root, action.time, _root3);
      _rootAcc[0] += _root3[0] * w;
      _rootAcc[1] += _root3[1] * w;
      _rootAcc[2] += _root3[2] * w;
      total += w;
    }
    if (total > 1e-4) {
      const inv = 1 / total;
      _rootAcc[0] *= inv;
      _rootAcc[1] *= inv;
      _rootAcc[2] *= inv;
    }
    const b = this.unit.bones;
    b.root.position.set(
      this.bindRoot.x + _rootAcc[0] * this.height + this.rootCorrection.x + this.deckOffset.x,
      this.bindRoot.y + _rootAcc[1] * this.height + this.rootCorrection.y + this.deckOffset.y,
      this.bindRoot.z + _rootAcc[2] * this.height + this.rootCorrection.z + this.deckOffset.z,
    );
    // The correction is re-derived from the plants every frame; decaying what
    // is left keeps a stale dip from persisting after the feet let go.
    this.rootCorrection.multiplyScalar(Math.exp(-9 * dt));

    // Turn lag: hips lead, chest follows, head follows the chest. The rates are
    // the reciprocals of the lags in the timing table, so a lag of 75 ms is
    // literally 75 ms of following.
    this.yaw = damp(this.yaw, this.yawTarget, WALK.turnRate * 2.6, dt);
    if (Math.abs(this.yawTarget - this.yaw) > 1e-5) {
      this.unit.root.rotation.y = this.yaw;
    }
    this.chestYaw = damp(this.chestYaw, this.yaw, 1 / WALK.turnSpineLag, dt);
    this.headYaw = damp(this.headYaw, this.chestYaw, 1 / WALK.turnHeadLag, dt);
    const chestLag = clamp(this.chestYaw - this.yaw, -0.42, 0.42);
    const headLag = clamp(this.headYaw - this.chestYaw, -0.3, 0.3);
    if (Math.abs(chestLag) > 1e-4) {
      _q.setFromAxisAngle(_up, chestLag);
      b.spine01.quaternion.multiply(_q2.setFromAxisAngle(_up, chestLag * 0.4));
      b.spine02.quaternion.multiply(_q);
    }
    if (Math.abs(headLag) > 1e-4) {
      _q.setFromAxisAngle(_up, headLag);
      b.head.quaternion.multiply(_q);
    }

    this.driveMount(dt);
  }

  // -------------------------------------------------------------------------
  // Mounts
  // -------------------------------------------------------------------------

  /**
   * Δθ = Δs / (radius · scale) — the contract the parts library publishes with
   * every wheel. The angle is accumulated *once* per frame and then written to
   * every wheel: accumulating inside the loop would advance a two-wheeled
   * chariot at twice the ground speed, which is a skid that grows without bound.
   */
  private spinWheels(distance: number): void {
    if (!(this.wheelRadius > 0)) return;
    // Rolling forward is −Z, so the wheel's top goes forward: a negative
    // rotation about the axle, which lies along X.
    this.wheelAngle -= distance / (this.wheelRadius * this.scale);
    for (let i = 0; i < this.wheels.length; i++) this.wheels[i].rotation.x = this.wheelAngle;
  }

  private driveMount(dt: number): void {
    switch (this.unit.meta.mount) {
      case 'horse':
        this.driveHorse();
        break;
      case 'elephant':
        this.driveElephant();
        break;
      case 'chariot':
        this.driveChariot();
        break;
      case 'trebuchet':
        this.driveTrebuchet();
        break;
      default:
        break;
    }
    void dt;
  }

  /**
   * One quadruped leg. Three angles about X: the upper segment protracts and
   * retracts, the middle folds, the pastern trails.
   *
   * `fore` inverts the middle joint, because a horse's carpus is a wrist and
   * folds backward while the hind hock folds forward. Getting that one sign
   * wrong is what makes a procedural horse look like a dog walking backward.
   *
   * Two properties this curve now has that it did not:
   *
   * **It closes.** Every joint ends its swing on the value it starts its stance
   * with. The old protraction curve reached +0.64 rad at the end of swing and
   * stance began at +0.34, so the leg snapped back 17° on the frame of every
   * single footfall — a tick, in the frame the eye is most likely to be on.
   *
   * **It is matched to the ground.** `leg.stanceSwing` is derived from the
   * stride and the animal's own hip height, so the hoof travels backward through
   * stance at the rate the body travels forward. A fixed ±0.34 rad swept a fixed
   * arc whatever the stride, and the difference between that arc and the ground
   * is, by definition, skate.
   */
  private driveQuadLeg(leg: QuadLeg, phase: number, amp: number): void {
    const { upper: b1, mid: b2, lower: b3, contact, duty, fore } = leg;
    let p = phase - contact;
    p -= Math.floor(p);
    const stance = p < duty;
    const swingU = stance ? 0 : (p - duty) / (1 - duty);
    const stanceU = stance ? p / duty : 0;
    // Protraction/retraction: driving back through stance at ground rate,
    // reaching forward again through swing, front-loaded so the hoof is placed
    // early and hangs there rather than arriving late.
    const A = leg.stanceSwing;
    const upper = stance
      ? amp * A * (1 - 2 * stanceU)
      : amp * A * (-1 + 2 * Math.pow(swingU, 0.78));
    // The fold is what lifts the hoof clear; it is at its lightest at both
    // contacts, which is where the two halves of the curve meet.
    const fold = stance
      ? amp * (0.1 + 0.16 * Math.sin(Math.PI * stanceU))
      : amp * (0.1 + 1.05 * Math.sin(Math.PI * Math.pow(swingU, 0.65)));
    b1.rotation.x = upper;
    if (b2) b2.rotation.x = fore ? -fold : fold * 0.82;
    // The pastern trails through stance and extends under the leg mid-swing,
    // returning to exactly the angle stance begins at.
    if (b3) {
      b3.rotation.x = stance
        ? amp * (-0.1 + 0.34 * stanceU)
        : amp * (0.24 - 0.34 * swingU - 0.3 * Math.sin(Math.PI * swingU));
    }
  }

  private driveHorse(): void {
    const moving = this.state === 'move';
    const amp = moving ? 1 : 0.06;
    const phase = moving ? this.gaitPhase : 0.5;
    for (let i = 0; i < this.quadLegs.length; i++) {
      this.driveQuadLeg(this.quadLegs[i], phase, amp);
    }

    const rock = Math.sin(Math.PI * 2 * (phase + CANTER.pitchPhase));
    if (this.mountSpine) {
      // The rocking-horse pitch, and the rise that goes with it.
      this.mountSpine.rotation.x = CANTER.pitchAmplitude * amp * rock;
      this.mountSpine.position.y =
        this.mountSpineBaseY +
        CANTER.rise * amp * -Math.cos(Math.PI * 2 * (phase - 0.2)) * this.height * 0.4;
    }
    if (this.mountNeck) {
      this.mountNeck.rotation.x = -0.42 * CANTER.pitchAmplitude * amp * rock - 0.05 * amp;
    }
    // The head is the last link and swings against the neck: a cantering horse
    // nods, and the nod lags the barrel by a quarter of a stride.
    if (this.mountHead) {
      this.mountHead.rotation.x =
        0.5 * CANTER.pitchAmplitude * amp * Math.sin(Math.PI * 2 * (phase + CANTER.pitchPhase - 0.25));
    }
    for (let i = 0; i < this.mountTail.length; i++) {
      const t = this.mountTail[i];
      const k = i + 1;
      t.rotation.x = 0.1 * amp * Math.sin(Math.PI * 2 * (phase - 0.1 * k)) + 0.05;
      t.rotation.z = 0.07 * amp * Math.sin(Math.PI * 2 * (phase - 0.14 * k) * 0.5);
    }
  }

  private driveElephant(): void {
    const moving = this.state === 'move';
    const amp = moving ? 1 : 0.05;
    const phase = moving ? this.gaitPhase : 0.25;
    for (let i = 0; i < this.quadLegs.length; i++) {
      this.driveQuadLeg(this.quadLegs[i], phase, amp * 0.55);
    }

    const sway = Math.sin(Math.PI * 4 * phase);
    if (this.mountSpine) {
      // Re-established every frame so the contact give below can subtract from
      // it without ever accumulating.
      this.mountSpine.position.y = this.mountSpineBaseY;
      this.mountSpine.rotation.z = LUMBER.sway * amp * sway;
      this.mountSpine.rotation.x = 0.018 * amp * Math.sin(Math.PI * 8 * phase);
    }
    // The roll runs up the animal with a lag at every joint, so the head is
    // still going one way as the shoulder starts back the other.
    if (this.mountNeck) {
      this.mountNeck.rotation.z = -0.5 * LUMBER.sway * amp * Math.sin(Math.PI * 4 * phase - 0.5);
    }
    if (this.mountHead) {
      this.mountHead.rotation.z = -0.35 * LUMBER.sway * amp * Math.sin(Math.PI * 4 * phase - 0.9);
      this.mountHead.rotation.x = 0.02 * amp * Math.sin(Math.PI * 4 * phase - 1.2);
    }
    for (let i = 0; i < this.mountEars.length; i++) {
      // Ears trail the head and are never quite still.
      this.mountEars[i].rotation.y =
        (i === 0 ? 1 : -1) * (0.09 + 0.13 * amp * Math.sin(Math.PI * 4 * phase - 1.3));
    }

    this.driveTrunk();
  }

  private driveTrunk(): void {
    const bones = this.trunkBones;
    if (bones.length === 0) return;
    const n = bones.length;
    if (this.state === 'attackWindup' || this.state === 'attackStrike') {
      // The sweep, with a per-segment lag so the tip cracks last.
      const a = this.attackProgress;
      for (let i = 0; i < n; i++) {
        trunkBend(a, i, n, _trunk);
        bones[i].rotation.set(_trunk.curl, _trunk.sweep, 0);
      }
      return;
    }
    const ph = this.state === 'move' ? this.gaitPhase : this.mixer.time / CLIP.idle;
    for (let i = 0; i < n; i++) {
      trunkIdle(ph, i, n, _trunk);
      bones[i].rotation.set(_trunk.curl, _trunk.sweep, 0);
    }
  }

  private driveChariot(): void {
    const body = this.mountBody;
    if (!body) return;
    const moving = this.state === 'move';
    const ph = this.gaitPhase;
    const amp = moving ? 1 : 0.14;
    const pitch =
      ROLL.pitchA * Math.sin(Math.PI * 4 * ph + 0.6) + ROLL.pitchB * Math.sin(Math.PI * 6 * ph);
    const rock = ROLL.rockA * Math.sin(Math.PI * 2 * ph - 0.4);
    body.rotation.x = pitch * amp;
    body.rotation.z = rock * amp;
    // The deck the crew stands on moves, so the crew moves with it. Written
    // absolutely rather than accumulated: an accumulating offset would build to
    // several times the deck's actual travel within a second.
    const deck = (1 - ROLL.kneeAbsorb) * amp;
    this.deckOffset.set(0, -Math.abs(pitch) * deck * this.height * 0.18, pitch * deck * this.height * 0.4);
  }

  private driveTrebuchet(): void {
    const beam = this.mountBeam;
    if (!beam) return;
    // The beam is driven straight off attack progress: the crew's haul and the
    // beam's whip are the same event and must not be able to drift apart.
    const a = this.attackProgress;
    const t = clamp((a - 1.05) / 0.55, 0, 1);
    const swing = t * t * (3 - 2 * t);
    beam.rotation.x = -2.05 * swing;
  }

  // -------------------------------------------------------------------------
  // 3. IK — hands and gaze
  // -------------------------------------------------------------------------

  private solveHands(): void {
    for (const side of SIDES) {
      const explicit = this.handTarget[side];
      if (explicit) {
        toRig(this.ikCtx, explicit, _v);
        solveTwoBone(this.arms[side], this.ikCtx, _v);
        continue;
      }
      const src = HAND_PLAN[this.key]?.[side];
      if (!src) continue;
      if (!this.handSourcePoint(side, src, _v)) continue;
      solveTwoBone(this.arms[side], this.ikCtx, _v);
    }
  }

  /** Resolve a hand plan to a rig-space point. Returns false if unavailable. */
  private handSourcePoint(side: 'L' | 'R', src: HandSource, out: THREE.Vector3): boolean {
    const at = this.unit.attach;
    switch (src.kind) {
      case 'haft': {
        const grip = at.gripR ?? at.gripL;
        const tip = at.haftTip;
        if (!grip || !tip) return false;
        rigPosition(this.ikCtx, grip, _v2);
        rigPosition(this.ikCtx, tip, _v3);
        out.copy(_v2).lerp(_v3, src.at);
        return true;
      }
      case 'socket': {
        const sock = at[src.socket];
        if (!sock) return false;
        rigPosition(this.ikCtx, sock, _v3);
        out.copy(side === 'L' ? this.bindHandL : this.bindHandR).lerp(_v3, src.blend);
        return true;
      }
      case 'mountBone': {
        const bone = this.unit.mountBones[src.bone];
        if (!bone) return false;
        rigPosition(this.ikCtx, bone, _v3);
        _v3.y += src.lift * this.height;
        _v3.x += (side === 'L' ? -1 : 1) * this.height * 0.055;
        out.copy(side === 'L' ? this.bindHandL : this.bindHandR).lerp(_v3, src.blend);
        return true;
      }
      case 'bind':
        out.copy(side === 'L' ? this.bindHandL : this.bindHandR);
        return true;
      default:
        return false;
    }
  }

  private solveGaze(dt: number): void {
    const want = this.lookTarget ? 1 : 0;
    this.lookWeight = damp(this.lookWeight, want, IK.aimRate, dt);
    if (this.lookWeight > 0.01 && this.lookTarget) {
      toRig(this.ikCtx, this.lookTarget, _v);
      solveAim(this.gazeChain, this.ikCtx, _v, this.lookWeight);
    }
    if (this.trunkChain && this.trunkTarget) {
      toRig(this.ikCtx, this.trunkTarget, _v);
      solveAim(this.trunkChain, this.ikCtx, _v, 0.85);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Contact resolution
  // -------------------------------------------------------------------------

  private releaseFeet(): void {
    for (const side of SIDES) {
      const lock = this.legs[side].lock;
      lock.locked = false;
      lock.weight = 0;
      lock.primed = false;
      lock.closing = 1;
    }
  }

  /**
   * Close up. Both feet come under their own hips when the walk stops.
   *
   * A gait that simply switches off leaves one foot hanging where the swing
   * happened to be, and the next state's IK either snaps it down or, worse,
   * locks it there. The closing step brings it under its own hip on the same
   * arc a normal swing would have used.
   *
   * **Both** feet, not only the swinging one. The trailing foot is still planted
   * a third of a stride behind the hip at the moment a walk ends, and leaving it
   * there is not a neutral choice: the figure is then standing in a split stance
   * it never leaves, the hip solve drops the pelvis far enough to reach both
   * plants, and it *stays* dropped — a soldier who has just walked one square
   * stands eight per cent shorter than one who has not, for the rest of the
   * match. After a capture, where the last plant is further back still, it is
   * twenty per cent and reads as a permanent crouch. The standing foot's close
   * is a weight shift rather than a step, and the arc it rides is short enough
   * that it looks like one.
   */
  private beginClosingStep(): void {
    for (const side of SIDES) {
      const leg = this.legs[side];
      const lock = leg.lock;
      if (!lock.primed) continue;
      // It is moving now, so it does not own its world position any more; the
      // close re-plants it at the end.
      lock.locked = false;
      lock.from.copy(lock.world);
      this.neutralStance(side, lock.to);
      lock.closing = 0;
    }
  }

  /**
   * Where this foot stands when the figure is standing still.
   *
   * Read off the *bind* pose and carried into world space by the root's current
   * transform — not off the live hip, which is the distinction that decides
   * whether a figure that has just walked ends up standing or squatting.
   *
   * At the instant a walk stops, the pelvis is mid-stride: rotated, swayed, and
   * displaced fore-and-aft by very nearly the width of the figure's own stance.
   * Aiming the closing step at `chain.a.matrixWorld` freezes all of that into
   * the plant. The crossfade to idle then unwinds the pelvis back to neutral,
   * the plants do not follow, and the figure is left standing with both feet
   * behind its hips — measured on the 兵 exchange, 0.071 world units of it
   * against a stance 0.080 wide, worth a permanent eight per cent of stature
   * once the hip solve has dropped the pelvis to reach them. That is a second,
   * independent cause of the same crouch the closing step was added to cure, and
   * it is why the close appeared to do nothing.
   *
   * The bind stance has neither problem: it is the pose the rig was authored in,
   * it is captured before a single clip has run, and it is the exact stance the
   * figure will be holding once `idle` has faded up. `unit.root` carries the
   * facing, the square and the scale, so one matrix multiply puts it in the
   * world. Only the height comes from elsewhere — the board under the foot,
   * because the bind pose knows nothing about the terrain it landed on.
   */
  private neutralStance(side: 'L' | 'R', out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.bind.get(`foot${side}` as BoneName)!);
    out.applyMatrix4(this.unit.root.matrixWorld);
    out.y = this.groundY(out.x, out.z) + this.ankleWorldHeight();
    return out;
  }

  /**
   * Plant the feet, then solve the hips against them.
   *
   * The contract this enforces: **while a foot is in stance its world position
   * does not change.** Not "changes slowly", not "is damped toward a target" —
   * it is frozen at the value captured on the plant, projected onto the board's
   * height field, and the legs and the root are whatever they have to be to
   * satisfy it. Everything else in this method is bookkeeping around that one
   * sentence.
   */
  private resolveContacts(dt: number): void {
    if (this.plan.seated) {
      // The mount's feet first: it is on the board and the rider is on *it*, so
      // the barrel has to be where the hooves put it before the rider's legs are
      // pinned to the barrel.
      this.resolveQuadContacts(dt);
      this.holdSeatedLegs();
      return;
    }
    const dying = this.state === 'death';
    if (dying) {
      // A collapse is the one time the feet are allowed to leave their plants.
      this.legs.L.lock.weight = damp(this.legs.L.lock.weight, 0, 6, dt);
      this.legs.R.lock.weight = damp(this.legs.R.lock.weight, 0, 6, dt);
      if (this.legs.L.lock.weight < 0.02 && this.legs.R.lock.weight < 0.02) return;
    }

    const moving = this.state === 'move';
    const grounded = this.state !== 'hit' && !dying;

    for (const side of SIDES) {
      const leg = this.legs[side];
      const w = moving
        ? stanceWeight(this.gaitPhase, leg.contact, this.plan.duty)
        : grounded
          ? 1
          : 0.35;
      this.updateFoot(leg, side, w, moving, dt);
    }

    // Two passes: the first correction changes the hip positions, so the second
    // sees the real remaining deficit. Two is enough at any speed a piece moves.
    for (let it = 0; it < IK.hipIterations; it++) {
      if (!this.solveHips()) break;
      this.unit.bones.root.updateMatrixWorld(true);
    }

    for (const side of SIDES) {
      const leg = this.legs[side];
      if (leg.lock.weight <= 0.001) continue;
      toRig(this.ikCtx, leg.lock.world, _v);
      // Full authority, in stance *and* in swing. Solving a planted foot at
      // partial weight is the subtle version of foot slide: the ankle lands
      // part-way between the clip's guess and the plant, and the gap between
      // them shows up as a shuffle at every heel strike. The clip still owns
      // the ankle's roll and the pole still owns the knee's plane; only the
      // ankle's *position* belongs to the contact solver, and it owns it
      // outright.
      solveTwoBone(leg.chain, this.ikCtx, _v, 1);
    }
    this.unit.bones.root.updateMatrixWorld(true);
    for (const side of SIDES) {
      const leg = this.legs[side];
      if (leg.lock.weight <= 0.001) continue;
      this.levelFoot(leg.foot, leg.lock.weight);
    }
  }

  /**
   * Advance one foot's lock state and compute where its ankle should be, in
   * world space.
   *
   * Stance: frozen. Swing: interpolated from where it released to where it is
   * predicted to plant, on a front-loaded arc, so that when the lock is taken
   * again the foot is *already* exactly at the plant point and the transition
   * costs nothing. A swing that ends anywhere else is a pop, and a lock that
   * chases rather than freezes is a slide.
   */
  private updateFoot(leg: LegRig, side: 'L' | 'R', w: number, moving: boolean, dt: number): void {
    const lock = leg.lock;
    if (!lock.primed) {
      // Seed from forward kinematics. Until this has run the lock holds the
      // world origin, and solving a leg toward the world origin tears the
      // figure apart — so nothing may read a lock before it is primed.
      this.worldFootPosition(leg, lock.world);
      lock.world.y = this.groundY(lock.world.x, lock.world.z) + this.ankleWorldHeight();
      lock.from.copy(lock.world);
      lock.plant.copy(lock.world);
      this.toeOf(lock.world, lock.toe);
      this.predictPlant(leg, lock.to);
      lock.primed = true;
    }

    // A closing step: the figure stopped mid-swing, so the foot is brought down
    // into its own standing stance instead of being abandoned in the air.
    if (lock.closing < 1) {
      lock.closing = Math.min(1, lock.closing + dt / CLOSE_STEP_SECONDS);
      // Re-aimed every frame, not once at the start. A close that begins while
      // the body is still covering the last of its travel — which is exactly
      // when it begins, because the walk state ends at the end of the walk —
      // would otherwise plant the feet short by however far the root moved
      // after the aim was taken, and the whole point of the close is that the
      // feet finish underneath the body rather than behind it.
      this.neutralStance(side, lock.to);
      const u = lock.closing;
      const eased = u * u * (3 - 2 * u);
      lock.world.lerpVectors(lock.from, lock.to, eased);
      lock.world.y =
        this.groundY(lock.world.x, lock.world.z) +
        this.ankleWorldHeight() +
        swingLift(u, this.plan.lift * this.height * this.scale * 0.5);
      lock.weight = 0.9;
      if (lock.closing >= 1) {
        lock.locked = true;
        // Take the *plant* as well as the lock. `plant` is what the stance
        // branch below copies back into `world` every frame once heel-off is
        // done, so a close that moves `world` and leaves `plant` behind is
        // undone on the very next frame: the foot walks to its closing position,
        // re-locks, and then snaps back to where it was standing before. That
        // snap is why the closing step has never done anything.
        lock.plant.copy(lock.world);
        this.toeOf(lock.world, lock.toe);
        lock.yaw = this.yaw;
        lock.heelOff = 0;
        this.onFootfall(side, lock.world);
      }
      return;
    }

    const wasLocked = lock.locked;
    const nowLocked = w >= IK.plantThreshold;

    if (nowLocked && !wasLocked) {
      // Take the plant. If we were swinging, the predicted plant point is where
      // the foot already is, so this is continuous by construction.
      if (lock.to.lengthSq() > 0 && moving) lock.world.copy(lock.to);
      else this.worldFootPosition(leg, lock.world);
      lock.world.y = this.groundY(lock.world.x, lock.world.z) + this.ankleWorldHeight();
      lock.plant.copy(lock.world);
      this.toeOf(lock.world, lock.toe);
      lock.yaw = this.yaw;
      lock.locked = true;
      lock.heelOff = 0;
      this.onFootfall(side, lock.world);
    } else if (!nowLocked && wasLocked) {
      lock.locked = false;
      lock.from.copy(lock.world);
      this.predictPlant(leg, lock.to);
    }

    lock.weight = w;

    if (!lock.locked && moving) {
      // Swing: ride the arc between release and the predicted plant.
      let p = this.gaitPhase - leg.contact;
      p -= Math.floor(p);
      const u = clamp((p - this.plan.duty) / Math.max(1e-4, 1 - this.plan.duty), 0, 1);
      const eased = u * u * (3 - 2 * u);
      lock.world.lerpVectors(lock.from, lock.to, eased);
      const ground = this.groundY(lock.world.x, lock.world.z) + this.ankleWorldHeight();
      lock.world.y = ground + swingLift(u, this.plan.lift * this.height * this.scale);
      // A swinging foot is solved for too, so it rides the arc instead of being
      // left wherever forward kinematics put it — and, critically, so that it
      // arrives at exactly the point the next lock will freeze. `weight` is not
      // the IK authority here (that is always 1); it is how hard this foot pulls
      // on the hip solve and how flat the sole is held, both of which should be
      // lower in the air than on the board.
      lock.weight = 0.85;
    } else if (lock.locked) {
      lock.plant.y = this.groundY(lock.plant.x, lock.plant.z) + this.ankleWorldHeight();
      lock.heelOff = moving ? heelOffAmount(this.gaitPhase, leg.contact, this.plan.duty) : 0;
      this.applyHeelOff(lock);
    } else if (!moving) {
      // Standing but not locked (a hit, a recovery): follow the FK foot loosely
      // so the solver has something continuous to hand back to the next plant.
      this.worldFootPosition(leg, _v4);
      lock.world.lerp(_v4, 0.5);
    }
  }

  private worldFootPosition(leg: LegRig, out: THREE.Vector3): THREE.Vector3 {
    return out.setFromMatrixPosition(leg.foot.matrixWorld);
  }

  /** The ball of the foot, in front of an ankle at `ankle`, at the current yaw. */
  private toeOf(ankle: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const reach = this.footLength * IK.toeAt;
    out.set(ankle.x - Math.sin(this.yaw) * reach, ankle.y, ankle.z - Math.cos(this.yaw) * reach);
    return out;
  }

  /**
   * Push-off. The ankle rotates *about the frozen toe*, so the contact point
   * does not move a millimetre while the heel comes up.
   *
   * This is what buys the stride. A near-straight standing leg cannot reach a
   * foot planted far behind the hip without the pelvis dropping into a squat;
   * lifting the ankle over the toe shortens the required reach at exactly the
   * moment it is longest, which is the same trick a real ankle plays and for the
   * same reason.
   */
  private applyHeelOff(lock: FootLock): void {
    if (lock.heelOff <= 1e-4) {
      lock.world.copy(lock.plant);
      return;
    }
    _v2.copy(lock.plant).sub(lock.toe);
    _v2.y = 0;
    const len = _v2.length();
    if (len < 1e-6) {
      lock.world.copy(lock.plant);
      return;
    }
    _v2.multiplyScalar(1 / len);
    const theta = IK.heelRise * lock.heelOff;
    lock.world.set(
      lock.toe.x + _v2.x * len * Math.cos(theta),
      lock.toe.y + len * Math.sin(theta),
      lock.toe.z + _v2.z * len * Math.cos(theta),
    );
  }

  /**
   * The contact state of one foot: where the lock says it is, and where it
   * actually ended up. Those two agreeing is the definition of "no foot slide",
   * so both are exposed — for the `contactPoints` debug overlay and for the
   * verification script, which measures the gap rather than trusting it.
   */
  footState(
    side: 'L' | 'R',
    outTarget: THREE.Vector3,
    outActual: THREE.Vector3,
    outToe?: THREE.Vector3,
  ): { locked: boolean; weight: number; heelOff: number } {
    const leg = this.legs[side];
    outTarget.copy(leg.lock.world);
    this.worldFootPosition(leg, outActual);
    if (outToe) outToe.copy(leg.lock.toe);
    return { locked: leg.lock.locked, weight: leg.lock.weight, heelOff: leg.lock.heelOff };
  }

  /** How many legs this figure's mount walks on. Zero for a biped. */
  get hoofCount(): number {
    return this.quadLegs.length;
  }

  /**
   * The contact state of one hoof, in the same shape and for the same reason as
   * `footState`: the gap between where the lock says the hoof is and where it
   * actually ended up is the definition of hoof slide, so both are exposed and
   * the verification script measures the gap rather than believing it.
   */
  hoofState(
    i: number,
    outTarget: THREE.Vector3,
    outActual: THREE.Vector3,
  ): { locked: boolean; weight: number } {
    const leg = this.quadLegs[i];
    outTarget.copy(leg.lock.world);
    outActual.setFromMatrixPosition(leg.contactNode.matrixWorld);
    return { locked: leg.lock.locked, weight: leg.lock.weight };
  }

  /** Ground distance one full locomotion cycle covers, world units. */
  get stride(): number {
    return this.strideWorld;
  }

  /** Height of the ankle above the local floor, in world units. */
  private ankleWorldHeight(): number {
    return this.ankleHeight * this.scale;
  }

  /** Board height under a world point, plus the unit's own local floor. */
  private groundY(x: number, z: number): number {
    const base = this.ground ? this.ground(x, z) : 0;
    return base + this.floorLocal * this.scale;
  }

  /**
   * Where this foot will next touch down.
   *
   * Three-quarters of a stride ahead of the hip at the moment of release: the
   * body covers 0.38 of a stride during the swing, and the foot has to land
   * about 0.35 of a stride in front of where the hip will then be. Both numbers
   * fall out of the gait's duty factor, so a retimed gait retimes this too.
   */
  private predictPlant(leg: LegRig, out: THREE.Vector3): void {
    const hip = leg.chain.a;
    out.setFromMatrixPosition(hip.matrixWorld);
    // Over one cycle the foot is fixed for `duty` of it while the hip covers
    // `duty × stride`, so the ankle spans `duty × stride` relative to the hip:
    // `plantAhead` in front at the plant, the rest behind at toe-off. Add the
    // `(1 − duty)` of a stride the hip covers during the swing and the plant
    // lands `1 − duty + plantAhead` ahead of the hip *now*. Every term comes
    // from the gait plan, so retiming a gait retimes this with it.
    const ahead = this.strideWorld * (1 - this.plan.duty + IK.plantAhead);
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    out.x -= s * ahead;
    out.z -= c * ahead;
    // Keep the foot under its own hip laterally. The rig's stance is narrower
    // than its hips, so without this the figure walks with its feet outside its
    // pelvis — a catwalk, not a march.
    out.x += c * leg.lateral;
    out.z -= s * leg.lateral;
    out.y = this.groundY(out.x, out.z) + this.ankleWorldHeight();
  }

  /**
   * Pull the root toward any planted foot the legs cannot reach.
   *
   * This is the half of foot locking that people leave out. Freezing the foot
   * is easy; what makes it *look* right is that the pelvis dips and shifts to
   * stay within reach of the plant, exactly as a real stride does at full
   * extension. Without it the leg silently over-extends, the IK clamps, and the
   * foot slides after all.
   */
  private solveHips(): boolean {
    let moved = false;
    _v4.set(0, 0, 0);
    let totalW = 0;
    for (const side of SIDES) {
      const leg = this.legs[side];
      if (leg.lock.weight <= 0.02) continue;
      rigPosition(this.ikCtx, leg.chain.a, _v2);
      toRig(this.ikCtx, leg.lock.world, _v3);
      const need = _v2.distanceTo(_v3);
      const reach = chainReach(leg.chain) * IK.maxExtension;
      if (need <= reach) continue;
      const deficit = need - reach;
      _v.copy(_v3).sub(_v2).normalize().multiplyScalar(deficit * leg.lock.weight);
      _v4.add(_v);
      totalW += leg.lock.weight;
      moved = true;
    }
    if (!moved || totalW <= 1e-4) return false;
    _v4.multiplyScalar(IK.hipGive / totalW);
    this.rootCorrection.add(_v4);
    this.unit.bones.root.position.add(_v4);
    return true;
  }

  /**
   * Keep the sole flat on the board.
   *
   * After the leg solve the foot carries whatever orientation the chain handed
   * it, which routinely points the toe into the board. This rotates the foot's
   * local up back toward world up by the stance weight, so a planted foot is
   * flat, a swinging foot keeps the clip's heel-strike and toe-off angles, and
   * the two blend across the plant.
   */
  private levelFoot(foot: THREE.Object3D, weight: number): void {
    if (weight <= 0.01) return;
    foot.matrixWorld.decompose(_v, _q, _v2);
    _v3.set(0, 1, 0).applyQuaternion(_q);
    _q2.setFromUnitVectors(_v3, _up);
    if (weight < 0.999) _q2.slerp(_qIdentity, 1 - weight);
    // The correction is a world-space rotation; conjugating it by the parent's
    // world rotation turns it into the local pre-rotation that produces it.
    const parent = foot.parent;
    if (parent) {
      parent.matrixWorld.decompose(_v, _q, _v2);
      _q3.copy(_q).invert();
      _q4.copy(_q3).multiply(_q2).multiply(_q);
      foot.quaternion.premultiply(_q4);
    } else {
      foot.quaternion.premultiply(_q2);
    }
    foot.quaternion.normalize();
  }

  /**
   * A rider's legs are held against the barrel rather than planted on the board.
   * The target is the bind-pose ankle in rig space, which is where the unit
   * author put it when they authored the seated bind pose — so the legs stay
   * exactly where the mesh was built to have them however much the seat moves.
   */
  private holdSeatedLegs(): void {
    // The legs are pinned to the *mount*, not to the rider. When the barrel
    // pitches, the ankles go with it; when the rider's own root moves against
    // it — which is what the absorb curves in the clip do — the knees take the
    // difference. Pinning them to the root instead would make the whole lower
    // body rigid and turn the rider into part of the saddle.
    if (this.mountAnchor) {
      rigPosition(this.ikCtx, this.mountAnchor, _v3);
      this.mountDelta.copy(_v3).sub(this.mountAnchorBind);
    } else {
      this.mountDelta.set(0, 0, 0);
    }
    for (const side of SIDES) {
      const leg = this.legs[side];
      _v.copy(this.bind.get(`foot${side}`)!).add(this.mountDelta);
      solveTwoBone(leg.chain, this.ikCtx, _v, 1);
    }
  }

  /**
   * Hoof contact.
   *
   * `driveQuadLeg` writes three joint angles straight out of the phase, which is
   * open loop: it produces a leg cycle that *looks* like a canter and has no
   * relationship whatever to the ground. Whether a hoof is skating is decided by
   * the ratio between the stride the phase advances on and the arc the joint
   * curve happens to sweep, and nothing was holding the two together.
   *
   * So the same contract the biped feet get, applied to the mount: **while a
   * hoof is in stance its world position does not change.** The drive curve
   * still authors the swing, the lift and the fold — it is a better shape than a
   * solver would invent — and it still authors stance as the first guess. The
   * solve then takes the guess and pins it to the board.
   *
   * The chain is solved to the *pastern* (`03`) rather than to the hoof (`04`),
   * with the hoof's current offset subtracted off the target: the hoof hangs off
   * the pastern by a rotation the drive curve owns, and a solver that tried to
   * own it too would fight the curve for the same degree of freedom every frame.
   */
  private resolveQuadContacts(dt: number): void {
    if (this.quadLegs.length === 0) return;
    const moving = this.state === 'move';

    // --- 1. plants ----------------------------------------------------------
    for (let i = 0; i < this.quadLegs.length; i++) {
      const leg = this.quadLegs[i];
      if (!leg.chain) continue;
      const lock = leg.lock;

      // Where the drive curve just put this hoof, in the world.
      _v4.setFromMatrixPosition(leg.contactNode.matrixWorld);
      if (!lock.primed) {
        lock.world.copy(_v4);
        lock.world.y = this.hoofY(leg, _v4);
        lock.primed = true;
      }

      let p = this.gaitPhase - leg.contact;
      p -= Math.floor(p);
      const planted = moving && p < leg.duty;
      if (planted && !lock.locked) {
        // Take the plant where the swing left the hoof, projected onto the
        // board. The swing is authored, so this is continuous by construction.
        lock.world.copy(_v4);
        lock.world.y = this.hoofY(leg, _v4);
        lock.locked = true;
        this.onFootfall(leg.lateral < 0 ? 'L' : 'R', lock.world);
      } else if (!planted && lock.locked) {
        lock.locked = false;
      }
      lock.weight = planted ? hoofAuthority(p, leg.duty) : 0;
      if (!moving) lock.primed = false;
    }

    // --- 2. barrel give -----------------------------------------------------
    // The mount's hip solve. Measured before any leg is solved, applied to the
    // spine, and the mount's matrices refreshed — so the legs below solve from
    // shoulders that are already where the contact says they have to be.
    this.applyMountGive(dt);

    // --- 3. legs ------------------------------------------------------------
    for (let i = 0; i < this.quadLegs.length; i++) {
      const leg = this.quadLegs[i];
      if (!leg.chain || leg.lock.weight <= 0.01) continue;
      this.hoofTarget(leg, _v);
      solveTwoBone(leg.chain, this.ikCtx, _v, leg.lock.weight);
    }
  }

  /**
   * Where this leg's chain tip has to be for its hoof to sit on its lock, in rig
   * space.
   *
   * The chain is solved to the pastern and the hoof hangs off it by whatever
   * rotation the drive curve is holding, so the offset is *measured* each frame
   * rather than assumed: a solver and a curve that both believe they own the
   * pastern will argue about it every frame for as long as the program runs.
   */
  private hoofTarget(leg: QuadLeg, out: THREE.Vector3): THREE.Vector3 {
    toRig(this.ikCtx, leg.lock.world, out);
    rigPosition(this.ikCtx, leg.chain!.tip, _v2);
    rigPosition(this.ikCtx, leg.contactNode, _v3);
    return out.add(_v2).sub(_v3);
  }

  /**
   * Drop the barrel until the worst-off planted leg can reach its hoof.
   *
   * Exactly `solveHips`, one level up: freezing a contact is easy, and what makes
   * it *read* is that the body settles to stay within reach of it. The rider goes
   * down with the barrel — through `deckOffset`, the same channel the chariot's
   * crew uses — because a rider who stays at a fixed height while the horse under
   * him drops is a rider floating over his saddle.
   */
  private applyMountGive(dt: number): void {
    const spine = this.mountSpine;
    let want = 0;
    let hip = 0;
    for (let i = 0; i < this.quadLegs.length; i++) {
      const leg = this.quadLegs[i];
      if (!leg.chain || leg.lock.weight <= 0.02) continue;
      hip = Math.max(hip, leg.hipHeight);
      rigPosition(this.ikCtx, leg.chain.a, _v2);
      this.hoofTarget(leg, _v3);
      const need = _v2.distanceTo(_v3);
      const reach = chainReach(leg.chain) * IK.maxExtension;
      if (need > reach) want = Math.max(want, (need - reach) * leg.lock.weight);
    }
    if (hip > 0) want = Math.min(want, hip * IK.mountGive);
    this.mountGive = damp(this.mountGive, want, IK.mountGiveRate, dt);
    if (this.mountGive < 1e-5 && want <= 0) this.mountGive = 0;
    // Written every frame from the drive curve's value, never accumulated: the
    // mount drive has already re-established `position.y` this frame.
    if (spine && this.mountGive > 0) {
      spine.position.y -= this.mountGive;
      spine.updateMatrixWorld(true);
    }
    // The rider follows next frame's retarget. One frame of lag on a value that
    // moves a couple of millimetres is not visible; writing the root here, after
    // the root curve has already been composed, would be.
    this.deckOffset.y = -this.mountGive;
  }

  /** Board height under a hoof, plus that hoof's own bind clearance. */
  private hoofY(leg: QuadLeg, at: THREE.Vector3): number {
    const base = this.ground ? this.ground(at.x, at.z) : 0;
    return base + leg.bindY * this.scale;
  }

  private onFootfall(side: 'L' | 'R', world: THREE.Vector3): void {
    if (!this.audio || this.footstepGain <= 0 || this.state !== 'move') return;
    const cue = this.unit.meta.mount === 'horse' ? 'hoofbeat' : 'armourShift';
    this.audio.play(cue, {
      gain: this.footstepGain * (side === 'L' ? 0.94 : 1),
      pan: clamp(world.x / 6, -1, 1),
      detune: side === 'L' ? -40 : 30,
    });
  }

  /**
   * What happens when a one-shot runs out.
   *
   * `victory` is authored as a raise that ends exactly on the pose the hold
   * loop breathes around, so it chains into it and the figure keeps living
   * instead of freezing with its weapon in the air. `hit` and `salute` return to
   * idle on their own — a unit struck in passing is not the choreographer's
   * problem to clean up. `death` clamps and stays clamped, which is the point.
   */
  private autoChain(): void {
    if (!this.finished()) return;
    if (this.state === 'victory' && this.stateKey.endsWith(':victory')) {
      const key = `${this.key}:victoryHold`;
      const next = this.actions.get(key);
      const prev = this.actions.get(this.stateKey);
      if (!next) return;
      next.reset();
      next.enabled = true;
      next.setEffectiveTimeScale(1);
      next.setEffectiveWeight(1);
      next.play();
      if (prev) next.crossFadeFrom(prev, FADE.victoryToHold, false);
      this.stateKey = key;
      return;
    }
    if (this.state === 'hit' || this.state === 'salute') this.play('idle', FADE.fromOneShot);
  }

  // -------------------------------------------------------------------------
  // Attack progress mirror
  // -------------------------------------------------------------------------

  /**
   * The trunk and the trebuchet beam are driven from the same 0..2 attack
   * progress the attack clips are authored against, so they can never drift out
   * of phase with the body that is supposed to be doing the work.
   *
   * `enabled`, not `isRunning()`, for the same reason the root blend uses it:
   * `hold('attackWindup', 1)` — which is precisely how the choreographer parks
   * at the top of the coil — sets the action's time scale to zero, and a windup
   * held at the top is exactly when the trunk must stay coiled rather than
   * quietly reverting to its idle sway.
   */
  private updateAttackProgress(): void {
    const w = this.actions.get(clipKeyFor(this.key, 'attackWindup'));
    const s = this.actions.get(clipKeyFor(this.key, 'attackStrike'));
    let a = 0;
    let total = 0;
    if (w && w.enabled && w.getEffectiveWeight() > 1e-3) {
      const weight = w.getEffectiveWeight();
      a += (w.time / CLIP.attackWindup) * weight;
      total += weight;
    }
    if (s && s.enabled && s.getEffectiveWeight() > 1e-3) {
      const weight = s.getEffectiveWeight();
      a += (1 + s.time / CLIP.attackStrike) * weight;
      total += weight;
    }
    this.attackProgress = total > 1e-4 ? a / total : this.state === 'idle' ? 0 : this.attackProgress;
  }

  // -------------------------------------------------------------------------

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.unit.root);
    this.gazeTip.removeFromParent();
    this.actions.clear();
  }
}

/** Construct an animator for one unit. */
export function createAnimator(unit: UnitInstance, opts: AnimatorOptions = {}): Animator {
  return new Animator(unit, opts);
}
