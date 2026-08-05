/**
 * The camera director.
 *
 * Nothing in this file ever cuts. Every value the camera has — the orbit target
 * in all three axes, the distance, the pitch, the yaw and the field of view — is
 * a spring, and every "cut" in the choreography is a spring retuned to a stiffer
 * configuration. A capture push is the same mechanism as a phase change, run at
 * three times the frequency.
 *
 * ## Integration
 *
 * The springs are integrated from the **closed-form solution** of a damped
 * harmonic oscillator over the interval, not by stepping a numerical solver. The
 * harness drives this thing at arbitrary dt — 1/60 during play, a single 0.4 s
 * jump when a critic scrubs to a beat — and a Euler or Verlet integrator would
 * give a visibly different answer for `step(0.4)` than for twenty-four steps of
 * `step(1/60)`. The analytic form gives the same answer for both, which is the
 * whole reason `__XQ.step()` produces a reproducible frame.
 *
 * ## Why the return is slower than the push
 *
 * A push in and a return out at the same rate reads as a snap — the eye reads
 * the symmetric out-motion as the camera being yanked back. The return spring
 * runs at ω = 6.0 against the push's ω = 9.59, a ratio of exactly 1.6, which is
 * the number at which the return stops calling attention to itself.
 *
 * ## Roll
 *
 * There is none, anywhere, ever. The camera is built from a yaw and a pitch with
 * world +Y as up, and the shake is a positional offset plus a few milliradians
 * of pitch and yaw. A board game whose horizon tilts stops being a board on a
 * table and becomes a shot in a film about vertigo, so the over-the-shoulder
 * capture framings clamp their pitch into a band that keeps the table's edge
 * roughly level in frame.
 */

import * as THREE from 'three';
import type { CameraDirector, CameraMode, CameraPose } from '@core/contracts.ts';
import type { MatchPhase } from '@core/bus.ts';
import type { NamedPose } from '@core/testapi.ts';
import { fileOf, rankOf, worldX, worldZ } from '@core/coords.ts';
import { clamp, damp } from '@core/types.ts';
import { noise } from '@core/noise.ts';

// ===========================================================================
// Spring configuration
// ===========================================================================

/**
 * Springs are specified as stiffness `k` and damping `c` for a unit mass, which
 * is how they are usually tuned by ear. The director converts to natural
 * frequency ω = √k and damping ratio ζ = c / (2√k).
 *
 * `ζ = 1` is critically damped: the fastest approach with no overshoot. The
 * capture push runs a shade under, at 0.92, so it lands with a few frames of
 * settle — a camera operator's arm arriving, not a value snapping.
 */
export interface SpringConfig {
  stiffness: number;
  damping: number;
}

export const SPRING: Record<'rest' | 'push' | 'return' | 'user' | 'slow', SpringConfig> = {
  /** The resting drift between phase framings. ω = 3.24, ζ = 1. */
  rest: { stiffness: 10.5, damping: 6.48 },
  /** Event pushes: capture and check. ω = 9.59, ζ = 0.92. */
  push: { stiffness: 92, damping: 17.65 },
  /** The way back out. ω = 6.0, ζ = 1 — exactly 1.6× slower than the push. */
  return: { stiffness: 36, damping: 12.0 },
  /** Under the player's hand. ω = 14, ζ = 1: immediate without being rigid. */
  user: { stiffness: 196, damping: 28.0 },
  /** The terminal arc and other long moves. ω = 1.9, ζ = 1. */
  slow: { stiffness: 3.61, damping: 3.8 },
};

/** Ratio the return spring must be slower than the push. Asserted in verify.ts. */
export const RETURN_SLOWDOWN = 1.6;

/**
 * ωt at which a critically damped spring has covered 98% of its distance. Used
 * to turn a caller's "take 2 seconds" into a stiffness.
 */
const SETTLE_WT = 5.83;

/** A push is "landed" once every channel is within this fraction of its start
 *  error. Full settling takes about 60% longer and reads as dead air. */
export const PUSH_LAND_FRACTION = 0.07;
const PUSH_MIN_SECONDS = 0.1;
const PUSH_TIMEOUT_SECONDS = 2.5;

// ===========================================================================
// Limits
// ===========================================================================

/** Soft limits push back; hard limits are the wall behind them. */
export const PITCH_SOFT_MIN = 0.16; // 9°
export const PITCH_SOFT_MAX = 1.42; // 81°
export const PITCH_HARD_MIN = 0.035;
export const PITCH_HARD_MAX = 1.53;
export const DIST_SOFT_MIN = 4.2;
export const DIST_SOFT_MAX = 22.0;
export const DIST_HARD_MIN = 2.4;
export const DIST_HARD_MAX = 30.0;
/** How far off board centre the player may drag the orbit target. */
export const TARGET_SOFT_RADIUS = 7.0;
export const TARGET_HARD_RADIUS = 11.0;

/** Gain falls off this fast once past a soft limit — the rubber band. */
const SOFT_GIVE = 0.55;
/** How quickly an out-of-range value eases back once the hand lets go. */
const SOFT_RETURN_RATE = 3.4;

/** Input sensitivity, radians (or fractional zoom) per CSS pixel. */
const ORBIT_YAW_PER_PX = 0.0062;
const ORBIT_PITCH_PER_PX = 0.0047;
const ZOOM_PER_WHEEL_PX = 0.0012;
const PAN_PER_PX = 0.0042;

/** Terminal mode's slow arc around the fallen general. */
const TERMINAL_ORBIT_RATE = 0.075; // rad/s

/** Shake decays to 2% in about this long. */
const SHAKE_DECAY = 5.2;
const SHAKE_POS_SCALE = 0.13;
const SHAKE_ANGLE_SCALE = 0.012;
const SHAKE_FREQ = 17.0;

// ===========================================================================
// Spring
// ===========================================================================

class Spring1D {
  value = 0;
  target = 0;
  velocity = 0;
  private omega = 3.24;
  private zeta = 1;

  configure(cfg: SpringConfig): void {
    const k = Math.max(cfg.stiffness, 1e-6);
    this.omega = Math.sqrt(k);
    // Overdamping is never useful here and the closed form below only covers
    // ζ ≤ 1, so clamp rather than silently mis-integrate.
    this.zeta = clamp(cfg.damping / (2 * Math.sqrt(k)), 0.05, 1);
  }

  /** Retune to a given natural frequency, keeping the damping ratio. */
  configureOmega(omega: number, zeta = 1): void {
    this.omega = Math.max(omega, 1e-4);
    this.zeta = clamp(zeta, 0.05, 1);
  }

  snap(v: number): void {
    this.value = v;
    this.target = v;
    this.velocity = 0;
  }

  /** Exact solution over `dt` for a constant target. Frame-rate independent. */
  step(dt: number): void {
    if (dt <= 0) return;
    const w = this.omega;
    const z = this.zeta;
    const A = this.value - this.target;
    if (A === 0 && this.velocity === 0) return;

    if (z >= 0.999) {
      // Critically damped: x(t) = (A + Ct)e^(−ωt), C = v + ωA.
      const e = Math.exp(-w * dt);
      const C = this.velocity + w * A;
      this.value = this.target + (A + C * dt) * e;
      this.velocity = (C - w * A - w * C * dt) * e;
    } else {
      // Underdamped: x(t) = e^(−ζωt)(A cos ω_d t + B sin ω_d t).
      const wd = w * Math.sqrt(1 - z * z);
      const e = Math.exp(-z * w * dt);
      const c = Math.cos(wd * dt);
      const s = Math.sin(wd * dt);
      const B = (this.velocity + z * w * A) / wd;
      const x = A * c + B * s;
      this.value = this.target + e * x;
      this.velocity = e * (-z * w * x + wd * (-A * s + B * c));
    }
  }

  get error(): number {
    return Math.abs(this.value - this.target);
  }
}

/** Shortest signed step from `current` to `target` on the circle. */
function nearestAngle(current: number, target: number): number {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + d;
}

/** Rubber band: gain shrinks the further past a soft limit you push. */
function resist(value: number, lo: number, hi: number, hardLo: number, hardHi: number): number {
  if (value < lo) {
    const over = lo - value;
    return clamp(lo - (over * SOFT_GIVE) / (1 + over / SOFT_GIVE), hardLo, hi);
  }
  if (value > hi) {
    const over = value - hi;
    return clamp(hi + (over * SOFT_GIVE) / (1 + over / SOFT_GIVE), lo, hardHi);
  }
  return value;
}

// ===========================================================================
// Framings
// ===========================================================================

interface Framing {
  target: [number, number, number];
  distance: number;
  pitch: number;
  /** `null` keeps whatever yaw the camera already has: no free swings. */
  yaw: number | null;
  fov: number;
  seconds: number;
}

/**
 * The phase framings.
 *
 * `formation` is low and long because the armies are marching in columns and a
 * low camera puts them against the sky. `development` is the resting play
 * framing: high, wide, and the pitch the brief specifies. `wide` is the
 * middlegame — a couple of degrees lower and a metre closer than development, so
 * that when the capture cuts start firing there is somewhere to come back to
 * that already has some weight. `endgame` drops to 24° and lengthens the lens to
 * 33 mm-equivalent, which is what makes two lone generals read as far apart.
 */
export const MODE_FRAMINGS: Record<Exclude<CameraMode, 'capture' | 'check' | 'free'>, Framing> = {
  formation: { target: [0, 0.55, 0], distance: 17.4, pitch: 0.36, yaw: null, fov: 40, seconds: 2.8 },
  development: { target: [0, 0.35, 0], distance: 16.6, pitch: 0.92, yaw: null, fov: 38, seconds: 2.4 },
  wide: { target: [0, 0.4, 0], distance: 15.0, pitch: 0.83, yaw: null, fov: 38, seconds: 2.2 },
  endgame: { target: [0, 0.28, 0], distance: 12.6, pitch: 0.42, yaw: null, fov: 33, seconds: 3.4 },
  terminal: { target: [0, 0.7, 0], distance: 6.4, pitch: 0.34, yaw: null, fov: 34, seconds: 3.0 },
  // Review is a READING mode, and what is read sits on the terrace either side
  // of the table — the marked record on +X, the evaluation silk on -X. At 14.2
  // and fov 36 this framing was tighter than `development` and cropped both of
  // them out of shot, so review mode showed a board with nothing to read. It is
  // now the widest resting framing in the table, deliberately.
  review: { target: [0, 0.35, 0], distance: 17.6, pitch: 0.86, yaw: null, fov: 39, seconds: 1.8 },
};

/**
 * The canonical framings the harness and the critics refer to by name. These
 * match the table in `main.ts` exactly — the critics quote shots by pose name,
 * so the numbers are a contract, not a preference.
 */
export const NAMED_POSES: Record<NamedPose, CameraPose> = {
  default: { target: [0, 0.35, 0], distance: 15.5, pitch: 0.873, yaw: 0, fov: 38 },
  top: { target: [0, 0, 0], distance: 14.0, pitch: 1.5533, yaw: 0, fov: 40 },
  silhouette: { target: [0, 0.9, 0], distance: 13.0, pitch: 0.12, yaw: 0, fov: 30 },
  threeQuarterRed: { target: [0, 0.7, 2.6], distance: 7.4, pitch: 0.44, yaw: 0.62, fov: 34 },
  threeQuarterBlack: {
    target: [0, 0.7, -2.6],
    distance: 7.4,
    pitch: 0.44,
    yaw: Math.PI - 0.62,
    fov: 34,
  },
  overShoulder: { target: [0, 0.8, 0], distance: 4.2, pitch: 0.3, yaw: 0.5, fov: 42 },
  portrait: { target: [0, 0.85, 0], distance: 3.1, pitch: 0.2, yaw: 0.38, fov: 30 },
  endgame: { target: [0, 0.3, 0], distance: 11.5, pitch: 0.24, yaw: -0.3, fov: 36 },
  profile: { target: [0, 0.8, 0], distance: 6.0, pitch: 0.16, yaw: Math.PI / 2, fov: 32 },
};

/** Which camera mode a match phase rests in. */
export function modeForPhase(phase: MatchPhase): CameraMode {
  switch (phase) {
    case 'formation':
      return 'formation';
    case 'boot':
    case 'development':
      return 'development';
    case 'middlegame':
      return 'wide';
    case 'endgame':
      return 'endgame';
    case 'terminal':
      return 'terminal';
    case 'review':
      return 'review';
    default:
      return 'development';
  }
}

// ===========================================================================
// Capture framing
// ===========================================================================

/**
 * How the over-the-shoulder rig is staged relative to the two combatants.
 *
 * It used to stand almost directly BEHIND the attacker: for adjacent squares
 * back = 1.7 and side = 1.09 against a look-at biased 0.62 down the gap, which
 * put the view atan(1.09 / 2.32) = 25.2° off the attack line. A thrust straight
 * down that line then projected at sin 25.2° = 42% of its true length and the
 * point of the weapon came at the lens: the flagship motion of the game, shot
 * down its own barrel.
 *
 * The rig now stands to the SIDE of the attack line and looks across it. The
 * constants below are the whole staging — nothing else about the push changed.
 */

/**
 * Angle between the view direction and the attack line, radians.
 *
 * 1.29 rad = 73.9°, so a thrust along the line projects at sin 73.9° = 96% of
 * its true length — 2.3× the old staging — while keeping enough of a
 * three-quarter angle that the shot reads as staged rather than as a flat side
 * elevation. Not pushed further: the shoulder choice below has to be able to
 * stay on the camera's current side of the axis of action, and past 90° there
 * are attack directions for which neither shoulder can.
 */
const OTS_OFF_AXIS = 1.29;

/**
 * How much of the gap the attacker has covered when the blade lands, for a
 * caller that does not say. **Only for a caller that does not say.**
 *
 * The camera frames the exchange as it will be AT CONTACT, not as it is on the
 * start line — for a chariot nine squares out those are entirely different
 * places. This number used to be the framing, mirrored by hand from
 * `CAPTURE.approachFraction` in @anim/timing.ts because the module graph runs
 * anim → scene and never the other way.
 *
 * A constant in one file that mirrors a calculation in another is not a
 * duplication *risk*, it is a duplication *certainty*: it survives exactly as
 * long as nobody changes the calculation. The choreographer stopped using a
 * fixed fraction — the attacker now stops at a standoff derived from its own
 * measured strike reach, so a 兵 closes 0.73 of its gap and a 砲 closes none of
 * it — and this constant went on framing 0.58 for all of them, which is where
 * it was left pointing at empty board for every cannon shot.
 *
 * So the fraction now travels with the request that needs it, as the third
 * argument to `pushToCapture`, and this is the fallback for the one caller that
 * has nothing better: a harness or a debug key firing a push with two squares
 * and no exchange behind them. It is deliberately the old whole-cast average
 * rather than anything cleverer, because a fallback that looks derived invites
 * the belief that it is.
 */
const OTS_CONTACT_FRACTION_FALLBACK = 0.58;

/** Half a figure's girth plus the air a frame wants around it. */
const OTS_MARGIN = 0.55;
/** Closer than this and an adjacent capture is staged inside the figures. */
const OTS_RADIUS_MIN = 2.7;
/** Further than this and a nine-square exchange stops being a close shot. */
const OTS_RADIUS_MAX = 6.6;
/** Height the rig aims at: chest, where the exchange happens. */
const OTS_LOOK_HEIGHT = 0.74;
const OTS_FOV = 42;
/** Pitch band that keeps the table's edge roughly level in frame. */
const OTS_PITCH_MIN = 0.15;
const OTS_PITCH_MAX = 0.42;
/** Pitch rises a little with separation so a long exchange stays readable. */
const OTS_PITCH_BASE = 0.24;
const OTS_PITCH_PER_UNIT = 0.013;

/**
 * How long `release()` holds the capture framing before starting the return.
 *
 * The choreographer calls `release()` at `CAPTURE.disperseStart` — the moment
 * the pigment starts leaving the body, not the moment it finishes. Coming out
 * there meant the camera was already wide 0.32 s later and had travelled the
 * full ~11.6 units back by 3.04 s, so the dispersal, which is the payoff of the
 * entire set piece, played out at about thirty pixels across.
 *
 * The dispersal runs disperseStart 2.31 → disperseEnd 3.94, so the close
 * framing is held for that 1.63 s and the camera comes out after it. A check
 * push still releases immediately: nothing is happening in it that the camera
 * would be walking out on.
 */
const CAPTURE_RELEASE_HOLD = 1.63;

const CHECK_DISTANCE = 5.6;
const CHECK_PITCH = 0.4;
const CHECK_HEIGHT = 0.78;
const CHECK_FOV = 34;

// Module-level scratch. `update()` runs every frame and allocates nothing.
const _camPos = new THREE.Vector3();
const _look = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _shakeBias = new THREE.Vector3(0, 0, 0);

// ===========================================================================
// Director
// ===========================================================================

export interface CameraDirectorOptions {
  aspect?: number;
  /** Start here rather than at the development framing. */
  initialPose?: CameraPose;
  near?: number;
  far?: number;
}

export class Director implements CameraDirector {
  readonly camera: THREE.PerspectiveCamera;

  private readonly tx = new Spring1D();
  private readonly ty = new Spring1D();
  private readonly tz = new Spring1D();
  private readonly dist = new Spring1D();
  private readonly pitch = new Spring1D();
  private readonly yaw = new Spring1D();
  private readonly fov = new Spring1D();
  private readonly all: Spring1D[];

  private mode: CameraMode = 'development';
  /** The mode to fall back to once an event push releases. Never `capture`/`check`. */
  private phaseMode: CameraMode = 'development';
  /** Where the camera comes back to. Phase framings and the player both edit it. */
  private readonly rest: CameraPose = {
    target: [0, 0.35, 0],
    distance: 16.6,
    pitch: 0.92,
    yaw: 0,
    fov: 38,
  };
  private readonly poseOut: CameraPose = {
    target: [0, 0, 0],
    distance: 0,
    pitch: 0,
    yaw: 0,
    fov: 38,
  };

  private userControl = true;
  private userDriving = false;
  private pushActive = false;
  private pushElapsed = 0;
  private pushInitial = new Float64Array(7);
  private pushResolve: (() => void) | null = null;

  /** Seconds of close framing still owed after a capture `release()`. */
  private releaseHold = 0;
  /** The `seconds` that release was asked for, or -1 for the default spring. */
  private releaseSeconds = -1;

  private shake = 0;
  private shakeTime = 0;

  private terminalFocus: [number, number] = [0, 0];

  private el: HTMLElement | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchDistance = 0;

  constructor(opts: CameraDirectorOptions = {}) {
    this.camera = new THREE.PerspectiveCamera(
      38,
      opts.aspect ?? 16 / 9,
      opts.near ?? 0.1,
      opts.far ?? 400,
    );
    this.camera.name = 'scene/camera';
    this.all = [this.tx, this.ty, this.tz, this.dist, this.pitch, this.yaw, this.fov];

    const start = opts.initialPose ?? MODE_FRAMINGS.development;
    this.rest.target[0] = start.target[0];
    this.rest.target[1] = start.target[1];
    this.rest.target[2] = start.target[2];
    this.rest.distance = start.distance;
    this.rest.pitch = start.pitch;
    this.rest.yaw = 'yaw' in start && typeof start.yaw === 'number' ? start.yaw : 0;
    this.rest.fov = start.fov;

    this.configure(SPRING.rest);
    this.snapToRest();
    this.applyToCamera();
  }

  // -- configuration ---------------------------------------------------------

  private configure(cfg: SpringConfig): void {
    for (const s of this.all) s.configure(cfg);
  }

  private configureSeconds(seconds: number, zeta = 1): void {
    const omega = SETTLE_WT / Math.max(seconds, 0.02);
    for (const s of this.all) s.configureOmega(omega, zeta);
  }

  private snapToRest(): void {
    this.tx.snap(this.rest.target[0]);
    this.ty.snap(this.rest.target[1]);
    this.tz.snap(this.rest.target[2]);
    this.dist.snap(this.rest.distance);
    this.pitch.snap(this.rest.pitch);
    this.yaw.snap(this.rest.yaw);
    this.fov.snap(this.rest.fov);
  }

  /** Point the springs at the resting pose without touching their tuning. */
  private aimAtRest(): void {
    this.tx.target = this.rest.target[0];
    this.ty.target = this.rest.target[1];
    this.tz.target = this.rest.target[2];
    this.dist.target = this.rest.distance;
    this.pitch.target = this.rest.pitch;
    this.yaw.target = nearestAngle(this.yaw.value, this.rest.yaw);
    this.fov.target = this.rest.fov;
  }

  // -- modes -----------------------------------------------------------------

  setMode(mode: CameraMode, seconds?: number): void {
    // A mode change is an explicit instruction and outranks a pending release
    // hold; without this the hold would drag the camera back after the change.
    this.releaseHold = 0;
    this.releaseSeconds = -1;
    this.mode = mode;
    if (mode === 'free') {
      this.userDriving = true;
      this.resolvePush();
      return;
    }
    if (mode === 'capture' || mode === 'check') {
      // Those two are entered through their push methods, which carry the
      // framing they need. Entering them by name just arms the push spring.
      this.configure(SPRING.push);
      return;
    }
    this.phaseMode = mode;
    const f = MODE_FRAMINGS[mode];
    this.rest.target[0] = f.target[0];
    this.rest.target[1] = f.target[1];
    this.rest.target[2] = f.target[2];
    if (mode === 'terminal') {
      this.rest.target[0] = this.terminalFocus[0];
      this.rest.target[2] = this.terminalFocus[1];
    }
    this.rest.distance = f.distance;
    this.rest.pitch = f.pitch;
    if (f.yaw !== null) this.rest.yaw = f.yaw;
    this.rest.fov = f.fov;
    this.userDriving = false;
    this.resolvePush();
    this.configureSeconds(seconds ?? f.seconds);
    this.aimAtRest();
  }

  setPhase(phase: MatchPhase, seconds?: number): void {
    this.setMode(modeForPhase(phase), seconds);
  }

  /** The square the terminal arc circles. Call before `setMode('terminal')`. */
  setTerminalFocus(square: number): void {
    this.terminalFocus = [worldX(fileOf(square)), worldZ(rankOf(square))];
    if (this.mode === 'terminal') {
      this.rest.target[0] = this.terminalFocus[0];
      this.rest.target[2] = this.terminalFocus[1];
      this.aimAtRest();
    }
  }

  /** Slide the resting target, e.g. to track a marching column in formation. */
  setTrackTarget(x: number, z: number, seconds = 1.2): void {
    this.rest.target[0] = x;
    this.rest.target[2] = z;
    if (!this.pushActive) {
      this.configureSeconds(seconds);
      this.aimAtRest();
    }
  }

  // -- event pushes ----------------------------------------------------------

  /**
   * Capture push: the two combatants seen ACROSS the axis of the attack.
   *
   * The framing is *computed from the two world positions*, so it works for a
   * chariot taking a soldier nine squares away and for an advisor taking a
   * cannon one square away, with no per-pair authoring anywhere. The rig stands
   * off to one side of the attack line and looks across it, so the thrust that
   * beat 2 is built around travels across the frame at very nearly its true
   * length instead of coming at the lens. See `OTS_OFF_AXIS`.
   *
   * The shoulder is chosen to stay on the same side of the axis of action as the
   * camera already is, which is the 180° rule; crossing it on a cut this fast
   * reads as the board flipping over.
   *
   * `contactFraction` is how far down the gap the blow actually lands, and it
   * comes from the choreographer because only the choreographer knows it: the
   * attacker's standoff is derived from its own measured strike reach and the
   * two figures' sizes. See `OTS_CONTACT_FRACTION_FALLBACK` for what happens
   * without it, and for why this is a parameter rather than a constant.
   *
   * Resolves when the push has *landed* — which is 93% of the way there, not
   * fully settled — so the choreographer can time the impact against it.
   */
  pushToCapture(attackerSq: number, defenderSq: number, contactFraction?: number): Promise<void> {
    this.resolvePush();
    this.releaseHold = 0;

    const ax = worldX(fileOf(attackerSq));
    const az = worldZ(rankOf(attackerSq));
    const dx = worldX(fileOf(defenderSq));
    const dz = worldZ(rankOf(defenderSq));
    const vx = dx - ax;
    const vz = dz - az;
    const sep = Math.max(Math.hypot(vx, vz), 0.001);
    const ux = vx / sep;
    const uz = vz / sep;
    // Left of the axis of action, in XZ.
    const px = uz;
    const pz = -ux;

    // Aim at the middle of the exchange as it stands AT CONTACT: the attacker
    // has closed `contactFraction` of the gap by then, so for a long capture the
    // event happens nowhere near the halfway line — and for a 砲, which closes
    // none of it, the exchange is the whole gap and the near end is the gun.
    // Clamped rather than trusted: this crosses a subsystem boundary, and a
    // fraction outside [0, 1] would put the near end off the attack line
    // entirely and take `halfSpan` negative with it. A non-finite one would take
    // the whole framing to NaN and strand the camera, which is a bug that costs
    // an afternoon to trace back to one division; it falls back instead.
    const frac =
      typeof contactFraction === 'number' && Number.isFinite(contactFraction)
        ? clamp(contactFraction, 0, 1)
        : OTS_CONTACT_FRACTION_FALLBACK;
    const nearEnd = sep * frac;
    const lookAlong = (nearEnd + sep) * 0.5;
    const lookX = ax + ux * lookAlong;
    const lookZ = az + uz * lookAlong;

    // The attack line now runs across the frame, so it is the HORIZONTAL field
    // that has to hold it. Solve for the radius that does, from the real aspect
    // rather than an assumed one, and floor it so a one-square capture does not
    // stage the camera inside the combatants.
    const halfSpan = (sep - nearEnd) * 0.5 + OTS_MARGIN;
    const tanHalfH =
      Math.tan((OTS_FOV * Math.PI) / 360) * Math.max(this.camera.aspect || 1, 0.5);
    const radius = clamp(
      (halfSpan * Math.sin(OTS_OFF_AXIS)) / Math.max(tanHalfH, 0.2),
      OTS_RADIUS_MIN,
      OTS_RADIUS_MAX,
    );
    const pitch = clamp(
      OTS_PITCH_BASE + sep * OTS_PITCH_PER_UNIT,
      OTS_PITCH_MIN,
      OTS_PITCH_MAX,
    );

    // Try both shoulders, keep the one nearer the yaw we already have. Only the
    // yaw differs between them — radius and pitch are symmetric about the line.
    const along = Math.cos(OTS_OFF_AXIS);
    const across = Math.sin(OTS_OFF_AXIS);
    let bestYaw = this.yaw.value;
    let bestDelta = Infinity;
    for (const sign of [1, -1]) {
      // Look point -> camera, in XZ. At OTS_OFF_AXIS = 0 this is the old shot:
      // straight back down the attack line.
      const ox = -ux * along + px * sign * across;
      const oz = -uz * along + pz * sign * across;
      const wrapped = nearestAngle(this.yaw.value, Math.atan2(ox, oz));
      const delta = Math.abs(wrapped - this.yaw.value);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestYaw = wrapped;
      }
    }

    this.mode = 'capture';
    this.userDriving = false;
    this.configure(SPRING.push);
    this.tx.target = lookX;
    this.ty.target = OTS_LOOK_HEIGHT;
    this.tz.target = lookZ;
    // `radius` is the horizontal reach; the orbit distance is the hypotenuse.
    this.dist.target = radius / Math.cos(pitch);
    this.pitch.target = pitch;
    this.yaw.target = bestYaw;
    this.fov.target = OTS_FOV;
    return this.beginPush();
  }

  /** Fast dolly onto a general under check. Keeps the yaw: a push, not a swing. */
  pushToCheck(square: number): void {
    this.resolvePush();
    this.releaseHold = 0;
    this.mode = 'check';
    this.userDriving = false;
    this.configure(SPRING.push);
    this.tx.target = worldX(fileOf(square));
    this.ty.target = CHECK_HEIGHT;
    this.tz.target = worldZ(rankOf(square));
    this.dist.target = CHECK_DISTANCE;
    this.pitch.target = CHECK_PITCH;
    // Pin the yaw where it stands rather than leaving it aimed wherever the
    // last release pointed it. Without this the dolly inherits the tail of a
    // return spring and drifts a fraction of a degree while it pushes, which is
    // a swing — small, but the one thing this framing promises not to do.
    this.yaw.target = this.yaw.value;
    this.fov.target = CHECK_FOV;
    void this.beginPush();
  }

  private beginPush(): Promise<void> {
    this.pushActive = true;
    this.pushElapsed = 0;
    for (let i = 0; i < this.all.length; i++) {
      // Floor the reference error so a channel that barely moves does not gate
      // the landing on a value that is already effectively zero.
      this.pushInitial[i] = Math.max(this.all[i].error, 1e-3);
    }
    return new Promise<void>((res) => {
      this.pushResolve = res;
    });
  }

  private resolvePush(): void {
    this.pushActive = false;
    if (this.pushResolve) {
      const r = this.pushResolve;
      this.pushResolve = null;
      r();
    }
  }

  /**
   * Come back out of a push. Slower than the push went in, by design.
   *
   * The mode returns to whatever phase framing was in force before the event, so
   * a capture that fires during the terminal set piece hands the slow arc back
   * rather than leaving the camera parked in `capture` forever.
   *
   * A capture release does not start there and then: it holds the close framing
   * for `CAPTURE_RELEASE_HOLD` first. The choreographer fires this at the START
   * of the pigment dispersal, and a camera that leaves on that cue is halfway
   * to the wide framing before the thing it was called in to watch has
   * happened. Call `release()` a second time during the hold to leave at once —
   * which is what an abort wants.
   */
  release(seconds?: number): void {
    this.resolvePush();
    if (this.mode === 'capture' && this.releaseHold <= 0) {
      // Stay in `capture`: the mode is what keeps the springs on the close
      // framing and keeps the terminal arc from starting to swing under us.
      this.releaseHold = CAPTURE_RELEASE_HOLD;
      this.releaseSeconds = seconds ?? -1;
      return;
    }
    this.finishRelease(seconds);
  }

  /** The actual return, once any hold has run out. */
  private finishRelease(seconds?: number): void {
    this.releaseHold = 0;
    this.releaseSeconds = -1;
    if (this.mode === 'capture' || this.mode === 'check') {
      this.mode = this.userDriving ? 'free' : this.phaseMode;
    }
    if (seconds !== undefined) this.configureSeconds(seconds);
    else this.configure(SPRING.return);
    this.aimAtRest();
  }

  impulse(strength: number, dir?: THREE.Vector3): void {
    this.shake = Math.min(1.6, this.shake + Math.abs(strength));
    if (dir) _shakeBias.copy(dir).normalize();
    else _shakeBias.set(0, 0, 0);
  }

  // -- pose ------------------------------------------------------------------

  setPose(pose: CameraPose, immediate = false): void {
    this.resolvePush();
    this.releaseHold = 0;
    this.releaseSeconds = -1;
    this.rest.target[0] = pose.target[0];
    this.rest.target[1] = pose.target[1];
    this.rest.target[2] = pose.target[2];
    this.rest.distance = pose.distance;
    this.rest.pitch = pose.pitch;
    this.rest.yaw = pose.yaw;
    this.rest.fov = pose.fov;
    // A pose set by the harness is authoritative: it is allowed outside the
    // player's soft limits, and it does not get rubber-banded back.
    this.userDriving = false;
    if (immediate) {
      this.snapToRest();
      this.applyToCamera();
    } else {
      this.aimAtRest();
    }
  }

  /** Partial poses, which is what the test API hands over. */
  setPosePartial(pose: Partial<CameraPose>, immediate = false): void {
    this.setPose(
      {
        target: pose.target ?? [this.rest.target[0], this.rest.target[1], this.rest.target[2]],
        distance: pose.distance ?? this.rest.distance,
        pitch: pose.pitch ?? this.rest.pitch,
        yaw: pose.yaw ?? this.rest.yaw,
        fov: pose.fov ?? this.rest.fov,
      },
      immediate,
    );
  }

  getPose(): CameraPose {
    this.poseOut.target[0] = this.tx.value;
    this.poseOut.target[1] = this.ty.value;
    this.poseOut.target[2] = this.tz.value;
    this.poseOut.distance = this.dist.value;
    this.poseOut.pitch = this.pitch.value;
    this.poseOut.yaw = this.yaw.value;
    this.poseOut.fov = this.fov.value;
    // A fresh object: `getPose` is a harness call, never a frame call, and a
    // caller holding a live reference to our internals would be a trap.
    return {
      target: [this.poseOut.target[0], this.poseOut.target[1], this.poseOut.target[2]],
      distance: this.poseOut.distance,
      pitch: this.poseOut.pitch,
      yaw: this.poseOut.yaw,
      fov: this.poseOut.fov,
    };
  }

  setNamedPose(name: NamedPose, immediate = false): void {
    this.setPose(NAMED_POSES[name], immediate);
  }

  /** True once the springs have effectively stopped. `__XQ.settle()` waits on it. */
  settled(): boolean {
    if (this.pushActive) return false;
    // A held capture framing is motionless but not finished — the return has
    // not started yet, and calling it settled would let the harness photograph
    // a shot that is about to move.
    if (this.releaseHold > 0) return false;
    for (const s of this.all) {
      if (s.error > 0.002 || Math.abs(s.velocity) > 0.004) return false;
    }
    return this.shake < 0.01;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  // -- per frame -------------------------------------------------------------

  update(dt: number): void {
    if (this.releaseHold > 0) {
      this.releaseHold -= dt;
      // Before the springs step, so the return begins on the frame the hold
      // ends rather than one frame later.
      if (this.releaseHold <= 0) {
        this.finishRelease(this.releaseSeconds >= 0 ? this.releaseSeconds : undefined);
      }
    }

    if (this.mode === 'terminal' && !this.pushActive) {
      // The slow arc. Driven from accumulated dt, so a stepped frame is exact.
      this.rest.yaw += TERMINAL_ORBIT_RATE * dt;
      this.yaw.target = this.rest.yaw;
    }

    if (this.userDriving && !this.pushActive) this.easeBackInsideLimits(dt);

    for (const s of this.all) s.step(dt);

    if (this.pushActive) {
      this.pushElapsed += dt;
      let landed = this.pushElapsed >= PUSH_MIN_SECONDS;
      if (landed) {
        for (let i = 0; i < this.all.length; i++) {
          if (this.all[i].error / this.pushInitial[i] > PUSH_LAND_FRACTION) {
            landed = false;
            break;
          }
        }
      }
      if (landed || this.pushElapsed > PUSH_TIMEOUT_SECONDS) this.resolvePush();
    }

    if (this.shake > 0.0005) {
      this.shake *= Math.exp(-SHAKE_DECAY * dt);
      this.shakeTime += dt;
    } else {
      this.shake = 0;
    }

    this.applyToCamera();
  }

  /** The other half of the rubber band: ease an over-pushed value back in. */
  private easeBackInsideLimits(dt: number): void {
    const p = this.rest.pitch;
    if (p < PITCH_SOFT_MIN) this.rest.pitch = damp(p, PITCH_SOFT_MIN, SOFT_RETURN_RATE, dt);
    else if (p > PITCH_SOFT_MAX) this.rest.pitch = damp(p, PITCH_SOFT_MAX, SOFT_RETURN_RATE, dt);

    const d = this.rest.distance;
    if (d < DIST_SOFT_MIN) this.rest.distance = damp(d, DIST_SOFT_MIN, SOFT_RETURN_RATE, dt);
    else if (d > DIST_SOFT_MAX) this.rest.distance = damp(d, DIST_SOFT_MAX, SOFT_RETURN_RATE, dt);

    const r = Math.hypot(this.rest.target[0], this.rest.target[2]);
    if (r > TARGET_SOFT_RADIUS) {
      const want = damp(r, TARGET_SOFT_RADIUS, SOFT_RETURN_RATE, dt) / r;
      this.rest.target[0] *= want;
      this.rest.target[2] *= want;
    }
    this.aimAtRest();
  }

  private applyToCamera(): void {
    const cam = this.camera;
    if (Math.abs(cam.fov - this.fov.value) > 1e-4) {
      cam.fov = this.fov.value;
      cam.updateProjectionMatrix();
    }
    const cp = Math.cos(this.pitch.value);
    const sp = Math.sin(this.pitch.value);
    _look.set(this.tx.value, this.ty.value, this.tz.value);
    _camPos.set(
      _look.x + Math.sin(this.yaw.value) * cp * this.dist.value,
      _look.y + sp * this.dist.value,
      _look.z + Math.cos(this.yaw.value) * cp * this.dist.value,
    );

    if (this.shake > 0.0005) {
      // Positional jitter in camera-local right/up, plus a couple of
      // milliradians of aim wobble. No roll, ever.
      const t = this.shakeTime * SHAKE_FREQ;
      const nx = noise.simplex2(t, 11.7);
      const ny = noise.simplex2(t + 37.4, 3.1);
      const s = this.shake * this.shake; // decay reads better squared
      _tmp.copy(_camPos).sub(_look).normalize();
      _right.set(_tmp.z, 0, -_tmp.x).normalize();
      _up.crossVectors(_tmp, _right).normalize();
      const amp = s * SHAKE_POS_SCALE;
      _camPos.addScaledVector(_right, (nx + _shakeBias.x * 0.4) * amp);
      _camPos.addScaledVector(_up, (ny + _shakeBias.y * 0.4) * amp);
      _look.addScaledVector(_right, nx * s * SHAKE_ANGLE_SCALE);
      _look.addScaledVector(_up, ny * s * SHAKE_ANGLE_SCALE);
    }

    cam.position.copy(_camPos);
    cam.up.set(0, 1, 0);
    cam.lookAt(_look);
  }

  // -- player input ----------------------------------------------------------

  setUserControl(on: boolean): void {
    this.userControl = on;
    if (!on) {
      this.pointers.clear();
      this.userDriving = false;
    }
  }

  /**
   * Attach pointer, wheel and pinch handling. Every handler reads only the event
   * — no clock, no `Math.random()` — so replaying a recorded input trace through
   * `step()` produces the same camera.
   */
  attachInput(el: HTMLElement): void {
    this.detachInput();
    this.el = el;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
  }

  detachInput(): void {
    const el = this.el;
    if (!el) return;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerUp);
    el.removeEventListener('wheel', this.onWheel);
    this.el = null;
    this.pointers.clear();
  }

  private beginUserEdit(): boolean {
    if (!this.userControl || this.pushActive) return false;
    if (!this.userDriving) {
      this.userDriving = true;
      this.configure(SPRING.user);
    }
    return true;
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.userControl) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) this.pinchDistance = this.currentPinch();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDistance = 0;
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;
    if (!this.beginUserEdit()) return;

    if (this.pointers.size >= 2) {
      const d = this.currentPinch();
      if (this.pinchDistance > 1 && d > 1) {
        this.applyZoom(Math.log(this.pinchDistance / d) * 1.35);
      }
      this.pinchDistance = d;
      return;
    }

    if (e.shiftKey || e.button === 1) {
      // Shift-drag pans the orbit target across the board plane.
      const c = Math.cos(this.yaw.value);
      const s = Math.sin(this.yaw.value);
      const scale = PAN_PER_PX * this.dist.value * 0.1;
      this.rest.target[0] += (-dx * c + dy * s) * scale;
      this.rest.target[2] += (dx * s + dy * c) * scale;
      const r = Math.hypot(this.rest.target[0], this.rest.target[2]);
      if (r > TARGET_HARD_RADIUS) {
        this.rest.target[0] *= TARGET_HARD_RADIUS / r;
        this.rest.target[2] *= TARGET_HARD_RADIUS / r;
      }
    } else {
      this.rest.yaw -= dx * ORBIT_YAW_PER_PX;
      this.rest.pitch = resist(
        this.rest.pitch + dy * ORBIT_PITCH_PER_PX,
        PITCH_SOFT_MIN,
        PITCH_SOFT_MAX,
        PITCH_HARD_MIN,
        PITCH_HARD_MAX,
      );
    }
    this.aimAtRest();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.userControl) return;
    e.preventDefault();
    if (!this.beginUserEdit()) return;
    this.applyZoom(e.deltaY * ZOOM_PER_WHEEL_PX);
    this.aimAtRest();
  };

  private applyZoom(logDelta: number): void {
    this.rest.distance = resist(
      this.rest.distance * Math.exp(logDelta),
      DIST_SOFT_MIN,
      DIST_SOFT_MAX,
      DIST_HARD_MIN,
      DIST_HARD_MAX,
    );
  }

  private currentPinch(): number {
    const it = this.pointers.values();
    const a = it.next().value;
    const b = it.next().value;
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  dispose(): void {
    this.detachInput();
    this.resolvePush();
  }
}
