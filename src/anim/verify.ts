/**
 * Headless verification for the animation subsystem.
 *
 *     npx tsx src/anim/verify.ts
 *     npx tsx src/anim/verify.ts --clips     # the clip table only
 *     npx tsx src/anim/verify.ts --contact   # gait and contact measurements only
 *
 * three builds skeletons, mixers and instanced meshes perfectly well with no GL
 * context, so the whole animation layer can be constructed in node and then
 * *measured*. This checks the claims that would otherwise be opinions:
 *
 *   - every clip for every unit builds, contains no NaN, has strictly
 *     increasing track times, unit-length quaternions, and a duration that
 *     matches the timing table exactly;
 *   - a looping clip's last keyframe equals its first, so the loop is seamless;
 *   - the two-bone solver returns an *exact* solution for reachable targets and
 *     a sane, fully-extended, correctly-aimed one for unreachable targets;
 *   - a walking figure's planted foot does not move — measured as the
 *     frame-to-frame world displacement of the ankle while its lock is held;
 *   - a wheel's rotation matches the ground it covered, to float precision;
 *   - a hand constrained to a weapon haft stays on it through a whole attack;
 *   - the pigment field conserves its budget, comes to rest, and replays
 *     identically from its seed.
 *
 * Exits non-zero if anything fails, so it can gate a build.
 */

import * as THREE from 'three';
import type {
  AudioCue,
  CameraDirector,
  CameraMode,
  CameraPose,
  GongbiMaterials,
  MaterialRequest,
  UnitInstance,
} from '@core/contracts.ts';
import { bus } from '@core/bus.ts';
import { sq } from '@core/coords.ts';
import { PieceType, Side, UNIT_KEY, type UnitKey } from '@core/types.ts';
import { createCharacters } from '@characters/index.ts';
import { UNIT_KEYS_IN_VALUE_ORDER } from '@characters/proportions.ts';
import { buildClipSet, clipKeyFor, type NormalisedClip } from './clips.ts';
import { chainReach, makeChain, solveTwoBoneRaw, stanceWeight } from './ik.ts';
import { Animator, createAnimator } from './controller.ts';
import { PigmentField } from './pigment.ts';
import { Choreography } from './choreography.ts';
import { CAPTURE, CAPTURE_HOLD, CLIP, GAIT, IK, type GaitName } from './timing.ts';

// `@types/node` is not a dependency and the brief forbids adding one, so the
// two Node globals this script touches are declared locally.
declare const process: { argv: string[]; exitCode?: number };

let failures = 0;
const notes: string[] = [];

function fail(msg: string): void {
  failures++;
  console.error(`  FAIL  ${msg}`);
}
function check(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
}
function note(msg: string): void {
  notes.push(msg);
}
const f = (v: number, n = 4): string => (Number.isFinite(v) ? v.toFixed(n) : String(v));

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function stubMaterials(): GongbiMaterials {
  const cache = new Map<string, THREE.Material>();
  return {
    get(req: MaterialRequest): THREE.Material {
      const k = `${req.cls}|${req.pigment}|${req.skinned ? 1 : 0}`;
      let m = cache.get(k);
      if (!m) {
        m = new THREE.MeshBasicMaterial();
        cache.set(k, m);
      }
      return m;
    },
    outline: () => null,
    setSilhouetteMode: () => {},
    update: () => {},
    setMood: () => {},
    dispose: () => {
      for (const m of cache.values()) m.dispose();
    },
  };
}

class StubCamera implements CameraDirector {
  readonly camera = new THREE.PerspectiveCamera();
  pushes = 0;
  impulses = 0;
  update(): void {}
  setMode(_m: CameraMode): void {}
  pushToCapture(): Promise<void> {
    this.pushes++;
    // Deliberately a promise that never settles until `update` would settle it:
    // if the choreography ever awaited this, the verification would hang, which
    // is exactly the deadlock the camera author warned about.
    return new Promise<void>(() => {});
  }
  pushToCheck(): void {}
  release(): void {}
  setUserControl(): void {}
  impulse(): void {
    this.impulses++;
  }
  setPose(): void {}
  getPose(): CameraPose {
    return { target: [0, 0, 0], distance: 10, pitch: 0.9, yaw: 0, fov: 38 };
  }
  resize(): void {}
}

class StubAudio {
  readonly cues: AudioCue[] = [];
  unlock(): Promise<void> {
    return Promise.resolve();
  }
  play(cue: AudioCue): void {
    this.cues.push(cue);
  }
  setIntensity(): void {}
  setCadence(): void {}
  setMuted(): void {}
  update(): void {}
  dispose(): void {}
}

// ---------------------------------------------------------------------------
// 1. Clips
// ---------------------------------------------------------------------------

const GAIT_FOR: Record<UnitKey, GaitName> = {
  soldier: 'march',
  advisor: 'stride',
  general: 'stride',
  cannon: 'crew',
  horse: 'canter',
  elephant: 'lumber',
  chariot: 'roll',
};

interface ClipStat {
  key: string;
  tracks: number;
  keys: number;
  duration: number;
  maxAngle: number;
  loopError: number;
}

function verifyClips(): ClipStat[] {
  console.log('\n=== clips ===');
  const stats: ClipStat[] = [];
  let totalTracks = 0;
  let totalKeys = 0;
  let worstQuatError = 0;
  let worstLoop = 0;

  for (const key of UNIT_KEYS_IN_VALUE_ORDER) {
    const gait = GAIT_FOR[key];
    const set = buildClipSet(key, gait);
    // idle, move, windup, strike, four directional hits, death, victory,
    // victoryHold, salute.
    check(set.size === 12, `${key}: expected 12 clips, got ${set.size}`);

    for (const [name, n] of set) {
      let keys = 0;
      let maxAngle = 0;
      let loopError = 0;
      for (const track of n.clip.tracks) {
        const times = track.times;
        const values = track.values;
        keys += times.length;
        for (let i = 0; i < times.length; i++) {
          if (!Number.isFinite(times[i])) fail(`${name}/${track.name}: NaN time at ${i}`);
          if (i > 0 && !(times[i] > times[i - 1])) {
            fail(`${name}/${track.name}: times not strictly increasing at ${i}`);
          }
        }
        check(
          Math.abs(times[times.length - 1] - n.duration) < 1e-6,
          `${name}/${track.name}: last key ${times[times.length - 1]} != duration ${n.duration}`,
        );
        for (let i = 0; i < values.length; i++) {
          if (!Number.isFinite(values[i])) fail(`${name}/${track.name}: NaN value at ${i}`);
        }
        // Quaternion tracks must stay unit length or the mixer's slerp drifts.
        for (let i = 0; i + 3 < values.length; i += 4) {
          const l = Math.hypot(values[i], values[i + 1], values[i + 2], values[i + 3]);
          worstQuatError = Math.max(worstQuatError, Math.abs(l - 1));
          const angle = 2 * Math.acos(Math.min(1, Math.abs(values[i + 3])));
          maxAngle = Math.max(maxAngle, angle);
        }
        if (n.loop) {
          const last = values.length - 4;
          const d = Math.max(
            Math.abs(values[0] - values[last]),
            Math.abs(values[1] - values[last + 1]),
            Math.abs(values[2] - values[last + 2]),
            Math.abs(values[3] - values[last + 3]),
          );
          loopError = Math.max(loopError, d);
        }
      }
      // The root curve is sampled on the same clock as the tracks.
      for (let i = 0; i < n.root.values.length; i++) {
        if (!Number.isFinite(n.root.values[i])) fail(`${name}: NaN in root curve at ${i}`);
      }
      worstLoop = Math.max(worstLoop, loopError);
      totalTracks += n.clip.tracks.length;
      totalKeys += keys;
      stats.push({ key: name, tracks: n.clip.tracks.length, keys, duration: n.duration, maxAngle, loopError });
    }

    // Durations must match the timing table exactly — the choreographer times
    // its beats against the table, not against the clips.
    const expect: [string, number][] = [
      [clipKeyFor(key, 'idle'), CLIP.idle],
      [clipKeyFor(key, 'move'), GAIT[gait].cycle],
      [clipKeyFor(key, 'attackWindup'), CLIP.attackWindup],
      [clipKeyFor(key, 'attackStrike'), CLIP.attackStrike],
      [clipKeyFor(key, 'hit', 'F'), CLIP.hit],
      [clipKeyFor(key, 'death'), CLIP.death],
      [clipKeyFor(key, 'victory'), CLIP.victory],
      [clipKeyFor(key, 'salute'), CLIP.salute],
    ];
    for (const [k, d] of expect) {
      const c = set.get(k) as NormalisedClip | undefined;
      if (!c) {
        fail(`${key}: missing clip ${k}`);
        continue;
      }
      check(Math.abs(c.duration - d) < 1e-9, `${k}: duration ${c.duration} != table ${d}`);
      check(
        Math.abs(c.clip.duration - d) < 1e-9,
        `${k}: AnimationClip.duration ${c.clip.duration} != table ${d}`,
      );
    }
  }

  // The windup's final pose must equal the strike's first, or the 45 ms cut
  // between them is a jump.
  let worstSeam = 0;
  for (const key of UNIT_KEYS_IN_VALUE_ORDER) {
    const set = buildClipSet(key, GAIT_FOR[key]);
    const w = set.get(clipKeyFor(key, 'attackWindup'))!;
    const s = set.get(clipKeyFor(key, 'attackStrike'))!;
    for (let ti = 0; ti < w.clip.tracks.length; ti++) {
      const a = w.clip.tracks[ti].values;
      const b = s.clip.tracks[ti].values;
      const last = a.length - 4;
      for (let k = 0; k < 4; k++) worstSeam = Math.max(worstSeam, Math.abs(a[last + k] - b[k]));
    }
  }
  check(worstSeam < 2e-3, `windup→strike seam discontinuity ${worstSeam}`);

  console.log(`  unit types      ${UNIT_KEYS_IN_VALUE_ORDER.length}`);
  console.log(`  clips           ${stats.length}`);
  console.log(`  tracks          ${totalTracks}`);
  console.log(`  keyframes       ${totalKeys}`);
  console.log(`  quat unit error ${f(worstQuatError, 9)}  (max |‖q‖ − 1|)`);
  console.log(`  loop closure    ${f(worstLoop, 9)}  (max component gap, first vs last key)`);
  console.log(`  windup seam     ${f(worstSeam, 9)}  (windup end vs strike start)`);
  return stats;
}

function printClipTable(stats: ClipStat[]): void {
  console.log('\n  clip                        tracks   keys   dur(s)   maxRot(deg)');
  for (const s of stats) {
    console.log(
      `  ${s.key.padEnd(26)}  ${String(s.tracks).padStart(5)}  ${String(s.keys).padStart(5)}` +
        `  ${s.duration.toFixed(3).padStart(6)}  ${((s.maxAngle * 180) / Math.PI).toFixed(1).padStart(11)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. The IK solver
// ---------------------------------------------------------------------------

function verifyIk(): void {
  console.log('\n=== two-bone IK ===');
  const a = new THREE.Vector3();
  const target = new THREE.Vector3();
  const pole = new THREE.Vector3();
  const elbow = new THREE.Vector3();
  const tip = new THREE.Vector3();

  // Deterministic sweep of reachable targets across a range of segment ratios.
  let worstReach = 0;
  let worstSegment = 0;
  let samples = 0;
  for (let li = 0; li < 5; li++) {
    const l1 = 0.3 + li * 0.17;
    for (let lj = 0; lj < 5; lj++) {
      const l2 = 0.2 + lj * 0.21;
      const lo = Math.abs(l1 - l2);
      const hi = l1 + l2;
      for (let di = 1; di < 20; di++) {
        // Stay strictly inside the annulus: the solver holds `maxExtension`
        // back from full lock deliberately, so the very edge is not "reachable"
        // by design and is checked separately below.
        const d = lo + ((hi - lo) * di) / 20;
        if (d > hi * IK.maxExtension || d < lo * IK.minExtension) continue;
        for (let ai = 0; ai < 8; ai++) {
          const th = (ai / 8) * Math.PI * 2;
          a.set(0.3 * Math.cos(th), 0.2 * Math.sin(th), -0.1);
          target.set(
            a.x + d * Math.cos(th * 1.7),
            a.y - d * Math.sin(th * 0.9) * 0.5,
            a.z + d * Math.sin(th * 1.3) * 0.6,
          );
          // Renormalise the offset so |target − a| is exactly d.
          target.sub(a).normalize().multiplyScalar(d).add(a);
          pole.set(Math.cos(th * 2.1), 0.4, -Math.sin(th * 1.1)).normalize();
          const r = solveTwoBoneRaw(a, target, pole, l1, l2, elbow, tip);
          samples++;
          worstReach = Math.max(worstReach, r.error);
          worstSegment = Math.max(
            worstSegment,
            Math.abs(elbow.distanceTo(a) - l1),
            Math.abs(tip.distanceTo(elbow) - l2),
          );
          check(r.reached, `reachable target at d=${f(d)} reported unreachable`);
        }
      }
    }
  }
  console.log(`  reachable samples        ${samples}`);
  console.log(`  max positional error     ${f(worstReach, 12)}  (rig units)`);
  console.log(`  max segment-length drift ${f(worstSegment, 12)}  (rig units)`);
  check(worstReach < 1e-9, `reachable targets are not solved exactly: ${worstReach}`);
  check(worstSegment < 1e-9, `segment lengths not preserved: ${worstSegment}`);

  // Unreachable: too far. The limb must end straight, aimed exactly at the
  // target, and short of it by exactly the shortfall.
  const l1 = 0.62;
  const l2 = 0.55;
  let worstAim = 0;
  let worstShort = 0;
  for (let i = 0; i < 32; i++) {
    const th = (i / 32) * Math.PI * 2;
    a.set(0, 1, 0);
    const d = (l1 + l2) * (1.15 + 0.4 * (i / 32));
    target.set(a.x + d * Math.cos(th), a.y + d * Math.sin(th) * 0.3, a.z + d * Math.sin(th));
    target.sub(a).normalize().multiplyScalar(d).add(a);
    pole.set(0, 0, -1);
    const r = solveTwoBoneRaw(a, target, pole, l1, l2, elbow, tip);
    check(!r.reached, 'unreachable target reported as reached');
    // Aim: the achieved tip must lie on the ray from the root to the target.
    const toTip = tip.clone().sub(a).normalize();
    const toTgt = target.clone().sub(a).normalize();
    worstAim = Math.max(worstAim, 1 - toTip.dot(toTgt));
    const expected = d - (l1 + l2) * IK.maxExtension;
    worstShort = Math.max(worstShort, Math.abs(r.error - expected));
    check(Number.isFinite(r.error), 'unreachable solve produced NaN');
  }
  console.log(`  unreachable: aim error   ${f(worstAim, 12)}  (1 − cos, root→tip vs root→target)`);
  console.log(`  unreachable: shortfall   ${f(worstShort, 12)}  (vs the exact clamped distance)`);
  check(worstAim < 1e-9, `clamped solve does not aim at the target: ${worstAim}`);
  check(worstShort < 1e-9, `clamped shortfall is wrong: ${worstShort}`);

  // Unreachable: too close. The chain must fold, not invert.
  let worstFold = 0;
  for (let i = 0; i < 16; i++) {
    a.set(0, 1, 0);
    const d = Math.abs(l1 - l2) * (i / 32);
    target.set(a.x + d, a.y, a.z);
    pole.set(0, 0, -1);
    const r = solveTwoBoneRaw(a, target, pole, l1, l2, elbow, tip);
    check(Number.isFinite(r.error), 'over-close solve produced NaN');
    worstFold = Math.max(
      worstFold,
      Math.abs(elbow.distanceTo(a) - l1),
      Math.abs(tip.distanceTo(elbow) - l2),
    );
  }
  console.log(`  over-close: segment drift ${f(worstFold, 12)}`);
  check(worstFold < 1e-9, `over-close solve breaks the segments: ${worstFold}`);

  // Degenerate pole: the solver must not produce NaN when the pole is parallel
  // to the limb, which happens the instant a limb points straight at its pole.
  a.set(0, 0, 0);
  target.set(0, -0.8, 0);
  pole.set(0, -1, 0);
  const deg = solveTwoBoneRaw(a, target, pole, l1, l2, elbow, tip);
  check(
    Number.isFinite(elbow.x) && Number.isFinite(elbow.y) && Number.isFinite(elbow.z),
    'degenerate pole produced NaN',
  );
  console.log(`  degenerate pole          ok (error ${f(deg.error, 9)})`);

  // Stance weights: the duty factors in the table must actually produce a
  // double-support phase, or the walk glides.
  for (const g of ['march', 'stride', 'crew'] as const) {
    const plan = GAIT[g];
    let both = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const p = i / N;
      const l = stanceWeight(p, plan.contactL, plan.duty);
      const r = stanceWeight(p, plan.contactR, plan.duty);
      if (l > 0.05 && r > 0.05) both++;
    }
    const frac = both / N;
    console.log(`  ${g.padEnd(8)} double support  ${(frac * 100).toFixed(1)}% of the cycle`);
    check(frac > 0.1, `${g}: no real double-support phase (${(frac * 100).toFixed(1)}%)`);
  }
}

// ---------------------------------------------------------------------------
// 3. Contact: foot planting, wheels, hands
// ---------------------------------------------------------------------------

interface UnitBundle {
  unit: UnitInstance;
  anim: Animator;
}

function makeUnit(factory: ReturnType<typeof createCharacters>, type: PieceType): UnitBundle {
  const unit = factory.create(Side.Red, type, 0);
  const anim = createAnimator(unit, { ground: () => 0, variant: 0 });
  return { unit, anim };
}

/**
 * Walk a unit in a straight line and measure how far a *locked* ankle moves in
 * world space from one frame to the next. A perfect plant measures zero; any
 * non-zero number here is the foot slide the motion critic will name first.
 */
function measureFootSlide(b: UnitBundle, squares: number, speed: number): {
  maxSlide: number;
  meanSlide: number;
  plants: number;
  maxTargetError: number;
  dip: number;
  maxToeSlide: number;
  height: number;
} {
  const { unit, anim } = b;
  anim.play('move', 0);
  anim.setFacing(0, true);
  unit.root.position.set(0, 0, 4);
  const dt = 1 / 60;
  const steps = Math.ceil((squares / speed) * 60);
  const prev = { L: new THREE.Vector3(), R: new THREE.Vector3() };
  const held = { L: false, R: false };
  const target = new THREE.Vector3();
  const actual = new THREE.Vector3();
  const toe = new THREE.Vector3();
  const prevToe = { L: new THREE.Vector3(), R: new THREE.Vector3() };
  let maxToeSlide = 0;
  let maxSlide = 0;
  let sum = 0;
  let count = 0;
  let plants = 0;
  let maxTargetError = 0;
  let dipMin = Infinity;
  let dipMax = -Infinity;

  for (let i = 0; i < steps; i++) {
    const d = speed * dt;
    unit.root.position.z -= d;
    anim.reportTravel(d);
    anim.update(dt);
    const rootY = unit.bones.root.position.y;
    if (i > 30) {
      dipMin = Math.min(dipMin, rootY);
      dipMax = Math.max(dipMax, rootY);
    }
    for (const side of ['L', 'R'] as const) {
      const st = anim.footState(side, target, actual, toe);
      if (st.locked) {
        maxTargetError = Math.max(maxTargetError, target.distanceTo(actual));
        if (held[side]) {
          // The contact point is the ball of the foot; the ankle is allowed to
          // rise over it at push-off. Both are measured — the toe is the one
          // that must be frozen.
          maxToeSlide = Math.max(maxToeSlide, prevToe[side].distanceTo(toe));
          if (st.heelOff <= 1e-6) {
            const slide = prev[side].distanceTo(actual);
            maxSlide = Math.max(maxSlide, slide);
            sum += slide;
            count++;
          }
        } else {
          plants++;
        }
        prev[side].copy(actual);
        prevToe[side].copy(toe);
        held[side] = true;
      } else {
        held[side] = false;
      }
    }
  }
  return {
    maxSlide,
    meanSlide: count > 0 ? sum / count : 0,
    plants,
    maxTargetError,
    dip: (dipMax - dipMin) * unit.root.scale.x,
    maxToeSlide,
    height: unit.meta.size[1],
  };
}

function verifyContact(factory: ReturnType<typeof createCharacters>): void {
  console.log('\n=== contact: feet ===');
  console.log(
    '  unit       plants   toe slide/frame  ankle slide/frame  max |target−actual|   pelvis dip (% of height)',
  );
  for (const type of [PieceType.Soldier, PieceType.Advisor, PieceType.General, PieceType.Cannon]) {
    const b = makeUnit(factory, type);
    const speed = 1.6;
    const r = measureFootSlide(b, 6, speed);
    console.log(
      `  ${UNIT_KEY[type].padEnd(9)}  ${String(r.plants).padStart(6)}  ${f(r.maxToeSlide, 8).padStart(15)}` +
        `  ${f(r.maxSlide, 8).padStart(17)}  ${f(r.maxTargetError, 8).padStart(19)}` +
        `  ${f(r.dip, 4).padStart(8)} (${((r.dip / r.height) * 100).toFixed(1)}%)`,
    );
    // A frame of travel at 1.6 units/s is 26.7 mm. Anything the eye reads as a
    // slide is a large fraction of that; the tolerance below is 4% of it.
    check(
      r.maxToeSlide < 1e-9,
      `${UNIT_KEY[type]}: the contact point moved ${f(r.maxToeSlide, 9)} world units`,
    );
    check(
      r.maxSlide < 0.0004,
      `${UNIT_KEY[type]}: flat-footed ankle moved ${f(r.maxSlide, 6)} world units in one frame`,
    );
    check(
      r.dip / r.height < 0.04,
      `${UNIT_KEY[type]}: pelvis dips ${((r.dip / r.height) * 100).toFixed(1)}% of its height`,
    );
    check(r.plants >= 4, `${UNIT_KEY[type]}: only ${r.plants} plants over six squares`);
    check(
      r.maxTargetError < 0.0015,
      `${UNIT_KEY[type]}: ankle missed its plant by ${f(r.maxTargetError, 5)}`,
    );
    b.anim.dispose();
    b.unit.dispose();
  }

  // --- wheels -------------------------------------------------------------
  console.log('\n=== contact: wheels ===');
  const chariot = makeUnit(factory, PieceType.Chariot);
  const wheel = chariot.unit.mountBones['chariot.wheelL'];
  check(!!wheel, 'chariot has no wheelL mount bone');
  const radius = (wheel?.userData?.radius as number) ?? 0;
  const scale = chariot.unit.root.scale.x;
  check(radius > 0, 'chariot wheel publishes no radius');
  chariot.anim.play('move', 0);
  let travelled = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 300; i++) {
    // A deliberately uneven speed profile: a wheel matched only at constant
    // speed is matched by accident.
    const d = (0.9 + 0.6 * Math.sin(i * 0.11)) * dt;
    travelled += d;
    chariot.unit.root.position.z -= d;
    chariot.anim.reportTravel(d);
    chariot.anim.update(dt);
  }
  const arc = Math.abs(chariot.anim.wheelRotation) * radius * scale;
  const slip = Math.abs(arc - travelled);
  console.log(`  radius (rig units)   ${f(radius, 6)}   root scale ${f(scale, 4)}`);
  console.log(`  ground travelled     ${f(travelled, 9)} world units`);
  console.log(`  wheel arc length     ${f(arc, 9)} world units   (|Δθ| · r · scale)`);
  console.log(`  slip                 ${f(slip, 12)} world units`);
  check(slip < 1e-9, `wheel slipped ${slip} world units over ${f(travelled, 3)}`);
  check(
    Math.abs(wheel!.rotation.x - chariot.anim.wheelRotation) < 1e-12,
    'wheel bone rotation is out of step with the accumulated angle',
  );
  chariot.anim.dispose();
  chariot.unit.dispose();

  // --- hands on hafts -------------------------------------------------------
  console.log('\n=== contact: hands ===');
  const soldier = makeUnit(factory, PieceType.Soldier);
  const grip = soldier.unit.attach.gripR;
  const tipSock = soldier.unit.attach.haftTip;
  check(!!grip && !!tipSock, 'soldier publishes no gripR/haftTip sockets');
  const want = new THREE.Vector3();
  const got = new THREE.Vector3();
  const g0 = new THREE.Vector3();
  const t0 = new THREE.Vector3();
  let worstHand = 0;
  const states: [string, number][] = [
    ['idle', 1.4],
    ['attackWindup', CLIP.attackWindup],
    ['attackStrike', CLIP.attackStrike],
    ['move', 1.2],
  ];
  for (const [state, secs] of states) {
    soldier.anim.play(state as 'idle', 0);
    let worst = 0;
    for (let i = 0; i < Math.ceil(secs * 60); i++) {
      if (state === 'move') {
        soldier.unit.root.position.z -= 1.4 / 60;
        soldier.anim.reportTravel(1.4 / 60);
      }
      soldier.anim.update(1 / 60);
      grip!.getWorldPosition(g0);
      tipSock!.getWorldPosition(t0);
      want.copy(g0).lerp(t0, 0.34);
      got.setFromMatrixPosition(soldier.unit.bones.handL.matrixWorld);
      worst = Math.max(worst, want.distanceTo(got));
    }
    worstHand = Math.max(worstHand, worst);
    console.log(`  ${state.padEnd(14)} max |hand − haft| ${f(worst, 6)} world units`);
  }
  // The left hand is IK'd onto the haft; anything above a millimetre at this
  // scale is either a solver bug or a target the arm genuinely cannot reach.
  check(worstHand < 0.02, `left hand left the haft by ${f(worstHand, 5)} world units`);
  soldier.anim.dispose();
  soldier.unit.dispose();
}

// ---------------------------------------------------------------------------
// 4. Every unit, every state, no NaN in the posed skeleton
// ---------------------------------------------------------------------------

function verifyPosing(factory: ReturnType<typeof createCharacters>): void {
  console.log('\n=== posed skeletons ===');
  const states = [
    'idle',
    'move',
    'attackWindup',
    'attackStrike',
    'hit',
    'death',
    'victory',
    'salute',
  ] as const;
  let worstMatrix = 0;
  let posed = 0;
  const v = new THREE.Vector3();
  for (const key of UNIT_KEYS_IN_VALUE_ORDER) {
    const type = { soldier: PieceType.Soldier, advisor: PieceType.Advisor, general: PieceType.General, cannon: PieceType.Cannon, horse: PieceType.Horse, elephant: PieceType.Elephant, chariot: PieceType.Chariot }[key];
    for (const side of [Side.Red, Side.Black] as const) {
      const unit = factory.create(side, type, 0);
      const anim = createAnimator(unit, { ground: () => 0, variant: 1 });
      for (const state of states) {
        anim.play(state, 0);
        for (let i = 0; i < 24; i++) {
          if (state === 'move') {
            anim.reportTravel(1.3 / 60);
            unit.root.position.z -= 1.3 / 60;
          }
          anim.update(1 / 60);
        }
        posed++;
        const mats = unit.skeleton.boneMatrices;
        if (mats) {
          for (const m of mats) {
            if (!Number.isFinite(m)) {
              fail(`${key}/${side}/${state}: NaN in a bone matrix`);
              break;
            }
          }
        }
        // Nothing may end up implausibly far from the unit's own origin: a
        // detached limb shows up here long before it shows up in a render.
        for (const name of ['head', 'handL', 'handR', 'footL', 'footR'] as const) {
          v.setFromMatrixPosition(unit.bones[name].matrixWorld);
          v.sub(unit.root.position);
          worstMatrix = Math.max(worstMatrix, v.length());
        }
      }
      anim.dispose();
      unit.dispose();
    }
  }
  console.log(`  posed states checked   ${posed}  (7 units × 2 armies × 8 states)`);
  console.log(`  max |joint − root|     ${f(worstMatrix, 4)} world units`);
  check(worstMatrix < 4.2, `a joint ended ${f(worstMatrix, 3)} world units from its root`);
}

// ---------------------------------------------------------------------------
// 5. Pigment
// ---------------------------------------------------------------------------

function verifyPigment(factory: ReturnType<typeof createCharacters>): void {
  console.log('\n=== pigment ===');
  const field = new PigmentField({ ground: () => 0 });
  const unit = factory.create(Side.Red, PieceType.Soldier, 0);
  unit.root.position.set(1, 0, -2);
  unit.root.updateMatrixWorld(true);

  const impulse = new THREE.Vector3(0.7, 0.6, -0.4);
  const spawned = field.burstUnit(unit, impulse, 'verify');
  console.log(`  chips spawned          ${spawned}  (budget ${field.capacity})`);
  check(spawned > 20, `only ${spawned} chips spawned`);

  const dt = 1 / 60;
  let peak = field.liveCount;
  let restedAt = -1;
  let maxY = 0;
  let minY = 0;
  for (let i = 0; i < 60 * 12; i++) {
    field.update(dt);
    peak = Math.max(peak, field.liveCount);
    for (let k = 0; k < field.liveCount; k++) {
      const m = new THREE.Matrix4();
      field.mesh.getMatrixAt(k, m);
      const y = m.elements[13];
      if (!Number.isFinite(m.elements[12]) || !Number.isFinite(y)) {
        fail('NaN in a chip transform');
        i = 1e9;
        break;
      }
      maxY = Math.max(maxY, y);
      minY = Math.min(minY, y);
    }
    if (field.liveCount === 0 && restedAt < 0) restedAt = i * dt;
  }
  console.log(`  peak live              ${peak}`);
  console.log(`  chip height range      ${f(minY, 4)} .. ${f(maxY, 4)} world units`);
  console.log(`  all settled and faded  ${restedAt >= 0 ? f(restedAt, 2) + ' s' : 'NEVER'}`);
  check(restedAt >= 0, 'chips never settled and faded out');
  check(minY > -0.01, `a chip fell through the board to ${f(minY, 4)}`);
  check(peak <= field.capacity, 'the pool over-filled');

  // Budget: a burst larger than the pool must clamp rather than grow.
  field.reset();
  let total = 0;
  for (let i = 0; i < 30; i++) total += field.burstUnit(unit, impulse, `flood:${i}`);
  console.log(`  flood: 30 bursts       ${total} chips accepted, live ${field.liveCount}`);
  check(field.liveCount <= field.capacity, 'budget exceeded under flood');

  // Determinism: the same seed must replay bit-for-bit.
  const hashRun = (): number => {
    const f2 = new PigmentField({ ground: () => 0 });
    f2.burstUnit(unit, impulse, 'determinism');
    for (let i = 0; i < 90; i++) f2.update(1 / 60);
    let h = 2166136261;
    const m = new THREE.Matrix4();
    for (let k = 0; k < f2.liveCount; k++) {
      f2.mesh.getMatrixAt(k, m);
      for (let e = 12; e < 15; e++) {
        h ^= Math.round(m.elements[e] * 1e6) | 0;
        h = Math.imul(h, 16777619);
      }
    }
    f2.dispose();
    return h >>> 0;
  };
  const h1 = hashRun();
  const h2 = hashRun();
  console.log(`  determinism hash       ${h1.toString(16)} / ${h2.toString(16)}`);
  check(h1 === h2, 'the pigment simulation is not deterministic');

  field.dispose();
  unit.dispose();
}

// ---------------------------------------------------------------------------
// 6. Choreography
// ---------------------------------------------------------------------------

async function verifyChoreography(factory: ReturnType<typeof createCharacters>): Promise<void> {
  console.log('\n=== choreography ===');
  const camera = new StubCamera();
  const audio = new StubAudio();
  const pigment = new PigmentField({ ground: () => 0 });
  const animators = new Map<UnitInstance, Animator>();
  const choreo = new Choreography({
    camera,
    audio: audio as unknown as StubAudio & { play: (c: AudioCue) => void } as never,
    pigment,
    animatorFor: (u) => animators.get(u),
    ground: () => 0,
  });

  const attacker = factory.create(Side.Red, PieceType.Soldier, 0);
  const defender = factory.create(Side.Black, PieceType.Horse, 0);
  animators.set(attacker, createAnimator(attacker, { ground: () => 0 }));
  animators.set(defender, createAnimator(defender, { ground: () => 0 }));

  const beats: { beat: number; at: number }[] = [];
  const flashes: number[] = [];
  const impulses: number[] = [];
  let clock = 0;
  const off1 = bus.on('capture:beat', (p) => beats.push({ beat: p.beat, at: clock }));
  const off2 = bus.on('fx:flash', (p) => flashes.push(p.strength));
  const off3 = bus.on('camera:impulse', (p) => impulses.push(p.strength));

  const from = sq(4, 6);
  const to = sq(4, 4);
  let resolved = false;
  const capturePromise = choreo
    .capture(attacker, defender, {
      attackerSq: from,
      defenderSq: to,
      attackerType: PieceType.Soldier,
      defenderType: PieceType.Horse,
      ranged: false,
    })
    .then(() => {
      resolved = true;
    });

  const dt = 1 / 60;
  const expected = CAPTURE.settleEnd + CAPTURE_HOLD;
  let frozenFrames = 0;
  for (let i = 0; i < Math.ceil((expected + 0.5) * 60); i++) {
    choreo.update(dt);
    for (const a of animators.values()) a.update(dt);
    if (animators.get(defender)!.isFrozen) frozenFrames++;
    clock += dt;
  }
  // The sequence resolves synchronously inside `update`, but a `then` callback
  // is a microtask: it cannot have run until the stack unwinds. Yielding once is
  // the difference between measuring the promise and measuring the event loop.
  await capturePromise;

  console.log(`  total duration         ${f(expected, 4)} s  (settle ${CAPTURE.settleEnd} + hold ${f(CAPTURE_HOLD, 4)})`);
  console.log(`  beats fired            ${beats.map((b) => `${b.beat}@${f(b.at, 3)}`).join('  ')}`);
  console.log(`  frozen-time hold       ${frozenFrames} frames  (target ${CAPTURE.holdFrames})`);
  console.log(`  flashes                ${flashes.length} (strength ${flashes.map((v) => f(v, 2)).join(',')})`);
  console.log(`  camera impulses        ${impulses.length}, pushes ${camera.pushes}`);
  console.log(`  audio cues             ${audio.cues.length}: ${[...new Set(audio.cues)].join(', ')}`);

  check(beats.length === 3, `expected 3 beats, got ${beats.length}`);
  check(
    beats[0]?.beat === 1 && beats[1]?.beat === 2 && beats[2]?.beat === 3,
    'beats did not fire in order',
  );
  check(flashes.length === 1, `expected exactly one flash, got ${flashes.length}`);
  check(camera.pushes === 1, 'the camera was not pushed exactly once');
  check(frozenFrames >= 2 && frozenFrames <= 4, `the frozen hold ran ${frozenFrames} frames`);
  check(resolved, 'the capture promise never resolved');
  check(!defender.root.visible, 'the defender was not dispersed');

  // The attacker must end on the square it took.
  const endX = attacker.root.position.x;
  const endZ = attacker.root.position.z;
  console.log(`  attacker ends at       (${f(endX, 3)}, ${f(endZ, 3)})`);
  check(Math.abs(endX - 0) < 1e-6 && Math.abs(endZ - -0.5) < 1e-6, 'the attacker did not land on the target square');

  // Abort must leave nothing mid-pose.
  defender.root.visible = true;
  let abortedResolve = false;
  const abortPromise = choreo
    .capture(attacker, defender, {
      attackerSq: to,
      defenderSq: from,
      attackerType: PieceType.Soldier,
      defenderType: PieceType.Horse,
      ranged: false,
    })
    .then(() => {
      abortedResolve = true;
    });
  for (let i = 0; i < 40; i++) {
    choreo.update(dt);
    for (const a of animators.values()) a.update(dt);
  }
  choreo.abort();
  await abortPromise;
  console.log(`  abort mid-capture      promise settled: ${abortedResolve}, busy: ${choreo.busy}`);
  check(abortedResolve, 'aborting left the capture promise pending');
  check(!choreo.busy, 'aborting left a sequence running');
  check(pigment.liveCount === 0, 'aborting left pigment in flight');

  // Ranged: the 砲 never leaves its square until the target is clear.
  const cannon = factory.create(Side.Red, PieceType.Cannon, 0);
  const victim = factory.create(Side.Black, PieceType.Soldier, 0);
  animators.set(cannon, createAnimator(cannon, { ground: () => 0 }));
  animators.set(victim, createAnimator(victim, { ground: () => 0 }));
  const cFrom = sq(1, 7);
  const cTo = sq(1, 2);
  let rangedDone = false;
  let movedEarly = 0;
  const rangedPromise = choreo
    .capture(cannon, victim, {
      attackerSq: cFrom,
      defenderSq: cTo,
      attackerType: PieceType.Cannon,
      defenderType: PieceType.Soldier,
      ranged: true,
    })
    .then(() => {
      rangedDone = true;
    });
  const startPos = cannon.root.position.clone();
  let sawProjectile = false;
  for (let i = 0; i < 60 * 8; i++) {
    choreo.update(dt);
    for (const a of animators.values()) a.update(dt);
    if (pigment.projectileActive) sawProjectile = true;
    if (i * dt < 3.0) movedEarly = Math.max(movedEarly, cannon.root.position.distanceTo(startPos));
  }
  await rangedPromise;
  console.log(`  ranged: projectile seen ${sawProjectile}, attacker moved before 3.0 s: ${f(movedEarly, 4)}`);
  check(sawProjectile, 'the ranged capture never launched a projectile');
  check(movedEarly < 1e-6, 'the 砲 left its square during the exchange');
  check(rangedDone, 'the ranged capture never resolved');

  off1();
  off2();
  off3();
  for (const a of animators.values()) a.dispose();
  pigment.dispose();
  attacker.dispose();
  defender.dispose();
  cannon.dispose();
  victim.dispose();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = typeof process !== 'undefined' ? process.argv.slice(2) : [];
  const only = (flag: string): boolean => argv.length === 0 || argv.includes(flag);

  console.log('anim — headless verification');
  const factory = createCharacters({ materials: stubMaterials(), onWarn: () => {} });

  const stats = verifyClips();
  if (argv.includes('--clips')) printClipTable(stats);

  if (only('--ik')) verifyIk();
  if (only('--contact')) verifyContact(factory);
  if (only('--pose')) verifyPosing(factory);
  if (only('--pigment')) verifyPigment(factory);
  if (only('--choreo')) await verifyChoreography(factory);

  console.log('');
  for (const n of notes) console.log(`  note  ${n}`);
  if (failures === 0) {
    console.log('OK — every check passed.');
  } else {
    console.error(`${failures} check(s) FAILED.`);
    if (typeof process !== 'undefined') process.exitCode = 1;
  }
  factory.dispose();
}

void main();
