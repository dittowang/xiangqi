/**
 * Combat choreography.
 *
 * A capture in this game is a **three-beat exchange**, not a cross-fade:
 *
 *   **Beat 1** the attacker closes on its target and winds up. The camera pushes
 *   over its shoulder while it does, so by the time the coil is at the top the
 *   frame is already tight.
 *
 *   **Beat 2** contact. A single high-contrast flash, a camera impulse, and
 *   **two and a half frames of frozen time** — the anime impact convention,
 *   where the bodies stop and the effects do not. It is 42 ms and it is the most
 *   load-bearing 42 ms in the project.
 *
 *   **Beat 3** the defender is driven back, collapses under its own weight, and
 *   disperses into mineral pigment chips in its own army's colour.
 *
 * Every duration lives in `timing.ts` and every one of them is off a round
 * number, so a later pass driven by real captured clips can retime the whole
 * exchange from one file.
 *
 * ## Scheduling
 *
 * Everything here is a `Sequence`: a duration, a list of marks at absolute
 * times, and a continuous tick. Sequences are advanced by `update(dt)` from the
 * game's frame loop and never by a timer, which is what lets the capture harness
 * step them at an arbitrary dt and get the same frame every time.
 *
 * That structure is also why nothing in this file ever `await`s the camera. The
 * director resolves `pushToCapture` from inside its own `update()`, so awaiting
 * one while the clock is stalled — which is exactly what a harness does between
 * `step()` calls — would deadlock. The push is fired and the choreography times
 * the impact off its own clock instead.
 */

import * as THREE from 'three';
import { bus, type CaptureContext } from '@core/bus.ts';
import type {
  AudioCue,
  AudioEngine,
  CameraDirector,
  CaptureBeatContext,
  Choreographer,
  UnitInstance,
} from '@core/contracts.ts';
import { band } from '@core/palette.ts';
import { fileOf, rankOf, worldX, worldZ } from '@core/coords.ts';
import { PieceType, Side, clamp, makePiece, type GameResult, type UnitKey } from '@core/types.ts';
import type { Animator } from './controller.ts';
import type { PigmentField } from './pigment.ts';
import {
  CAPTURE,
  CAPTURE_HOLD,
  FINALE,
  FORMATION,
  FORMATION_ORDER,
  FRAME,
  PIGMENT,
  PROJECTILE,
  RANGED,
  WALK,
  walkSeconds,
  type GaitName,
} from './timing.ts';

// ===========================================================================
// Scheduling
// ===========================================================================

interface Mark {
  at: number;
  fn: () => void;
  fired: boolean;
}

/**
 * One scheduled piece of choreography.
 *
 * `finish` is called whenever the sequence stops for any reason — normal end,
 * skip, or abort — and it is written to be idempotent: it snaps everything the
 * sequence touched to the state it would have had at the end. That is what makes
 * `abort()` safe — a takeback can never leave a unit halfway through a collapse.
 *
 * There are two ways to stop early, and the difference between them is the
 * difference between a skip and a cancel:
 *
 *   `complete()` **fires** every unfired mark. It means "this sequence happened,
 *   get me to the end of it now" — the player skipped the march-in, and the
 *   arrivals and the drum beat are events they asked to fast-forward through,
 *   not events they asked to delete.
 *
 *   `cancel()` **drops** every unfired mark. It means "this sequence did not
 *   happen" — a takeback, a reset, a scrub to a different time. Firing them
 *   instead detonates the whole exchange in one frame: the flash at full
 *   strength, the camera impulse, the blade and the body-fall together, and a
 *   pigment burst around a figure that was never struck.
 */
class Sequence {
  time = 0;
  done = false;
  constructor(
    readonly name: string,
    readonly duration: number,
    readonly marks: Mark[],
    readonly tick: ((t: number, dt: number) => void) | null,
    readonly finish: () => void,
    readonly resolve: () => void,
  ) {}

  advance(dt: number): void {
    if (this.done) return;
    const next = Math.min(this.time + dt, this.duration);
    for (const m of this.marks) {
      if (!m.fired && m.at <= next) {
        m.fired = true;
        m.fn();
      }
    }
    this.time = next;
    if (this.tick) this.tick(this.time, dt);
    if (this.time >= this.duration) this.complete();
  }

  /**
   * Fire every unfired mark, run the tick at the end, and settle.
   *
   * `done` is set *first*, before anything is run. A tick is allowed to end its
   * own sequence — that is how a skip works — and it will be called once more
   * from here; without the flag already set, that call re-enters `complete` and
   * the stack unwinds itself into the ground.
   */
  complete(): void {
    if (this.done) return;
    this.done = true;
    for (const m of this.marks) {
      if (!m.fired) {
        m.fired = true;
        m.fn();
      }
    }
    this.time = this.duration;
    if (this.tick) this.tick(this.duration, 0);
    this.finish();
    this.resolve();
  }

  /**
   * Stop without firing anything that has not already fired.
   *
   * The marks are stamped `fired` rather than left alone so that a sequence
   * which somehow survives in another list can never fire them later, and
   * `finish()` still runs: cancelling an exchange must still unfreeze the
   * bodies, drop the look targets and put the attacker on its square. The tick
   * is deliberately *not* run — `finish()` is the authority on the end state,
   * and a tick evaluated at `duration` would re-derive a position for a
   * sequence that is being thrown away.
   */
  cancel(): void {
    if (this.done) return;
    this.done = true;
    for (const m of this.marks) m.fired = true;
    this.time = this.duration;
    this.finish();
    this.resolve();
  }
}

const mark = (at: number, fn: () => void): Mark => ({ at, fn, fired: false });

/**
 * How far a figure has to be put from where it already is before the placement
 * counts as a **teleport** rather than one more frame of a tween, in world
 * units.
 *
 * An eighth of a square. Comfortably above anything a legitimate step covers —
 * the quickest gait in the game crosses about 0.03 of a square in a frame, and
 * even a harness stepping a quarter second at a time stays under a tenth — and
 * comfortably below anything that is actually a jump: a cancelled move has at
 * least a fraction of a square left in it, and the march-in snap is four and a
 * half squares.
 */
const TELEPORT_MIN = 0.12;

// ===========================================================================
// Options
// ===========================================================================

export interface ChoreographyOptions {
  /** The camera director, by interface. Never awaited from inside a sequence. */
  camera: CameraDirector;
  /** The audio engine, by interface. */
  audio: AudioEngine;
  /** The pigment field. The choreographer advances it from `update`. */
  pigment: PigmentField;
  /** How to find the animator driving a unit. */
  animatorFor: (unit: UnitInstance) => Animator | undefined;
  /** Board height under a world point, so units walk on the board's surface. */
  ground?: ((x: number, z: number) => number) | null;
}

// Scratch for values consumed inside the frame they are written in. Anything a
// *mark* reads seconds later must be owned by that sequence instead — module
// scratch would have been overwritten by whatever ran in between.
const _a = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _look = new THREE.Vector3();

/** Attack sound per unit. Each unit's weapon has its own voice. */
const ATTACK_CUE: Record<UnitKey, AudioCue> = {
  soldier: 'spearThrust',
  advisor: 'bladeStrike',
  general: 'bladeStrike',
  cannon: 'trebuchetRelease',
  horse: 'bladeStrike',
  elephant: 'trunkSweep',
  chariot: 'chariotRumble',
};

// ===========================================================================
// Choreographer
// ===========================================================================

export class Choreography implements Choreographer {
  private readonly camera: CameraDirector;
  private readonly audio: AudioEngine;
  private readonly pigment: PigmentField;
  private readonly animatorFor: (unit: UnitInstance) => Animator | undefined;
  private ground: ((x: number, z: number) => number) | null;

  private readonly running: Sequence[] = [];
  /** Set while a sequence is being torn down, so `finish` cannot recurse. */
  private aborting = false;
  /** Figures already reported as having no animator. Complain once each. */
  private readonly unanimated = new WeakSet<THREE.Object3D>();

  constructor(opts: ChoreographyOptions) {
    this.camera = opts.camera;
    this.audio = opts.audio;
    this.pigment = opts.pigment;
    this.animatorFor = opts.animatorFor;
    this.ground = opts.ground ?? null;
  }

  setGroundHeight(fn: ((x: number, z: number) => number) | null): void {
    this.ground = fn;
    this.pigment.setGroundHeight(fn);
  }

  get busy(): boolean {
    return this.running.length > 0;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number): void {
    if (this.running.length > 0) {
      // Copy the length up front: a mark may start another sequence.
      const n = this.running.length;
      // A mark may start another sequence (fine — it runs next frame) or abort
      // everything (which empties the list under us), so the index is checked.
      for (let i = 0; i < n && i < this.running.length; i++) this.running[i].advance(dt);
      for (let i = this.running.length - 1; i >= 0; i--) {
        if (this.running[i].done) this.running.splice(i, 1);
      }
    }
    this.pigment.update(dt);
  }

  /**
   * Throw away everything in flight.
   *
   * `cancel()`, never `complete()`. An abort is the statement that the exchange
   * did not happen — a takeback, a new position, a scrub to another time — and
   * a mark that has not fired yet is an event the player never reached. Firing
   * them on the way out puts the flash, the camera impulse, the blade strike,
   * the body fall and the pigment burst on a single frame, for a capture that
   * was cancelled. It is also why `seekCapture` used to blow the next seek
   * white: the leaked flash from the previous seek was still decaying.
   *
   * Each sequence's `finish()` still runs, so nothing is left mid-pose.
   */
  abort(): void {
    if (this.aborting) return;
    this.aborting = true;
    const list = [...this.running];
    this.running.length = 0;
    for (const s of list) s.cancel();
    this.pigment.reset();
    this.camera.release();
    this.aborting = false;
  }

  private start(seq: Sequence): void {
    this.running.push(seq);
  }

  /**
   * The animator driving a figure, or `undefined` — and a named complaint the
   * first time a given figure turns out not to have one.
   *
   * Every clip this file plays goes through an optional call (`anim?.play(...)`)
   * because a figure with no animator is legitimate during teardown. The failure
   * that costs a day is the other one: a figure that *should* have an animator
   * and does not still walks to its square and still dies on schedule, because
   * the root position, the facing and the visibility are written from here and
   * not by the animator. What is missing is every pose — so a capture with no
   * animator is pixel-for-pixel indistinguishable from a capture whose clips
   * never reach the skeleton, and the eye goes looking in the mixer. Say it once,
   * by name, instead of playing into the void.
   */
  private animator(unit: UnitInstance): Animator | undefined {
    const a = this.animatorFor(unit);
    if (!a && !this.unanimated.has(unit.root)) {
      this.unanimated.add(unit.root);
      console.warn(
        `[anim] no animator registered for "${unit.root.name || unit.meta.key}". It will ` +
          `slide to its square with its pose frozen at bind: no walk cycle, no strike, ` +
          `no collapse. Whoever owns the animator map has to register one for every ` +
          `figure on the board, including figures rebuilt by a position change.`,
      );
    }
    return a;
  }

  private make(
    name: string,
    duration: number,
    marks: Mark[],
    tick: ((t: number, dt: number) => void) | null,
    finish: () => void,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      this.start(new Sequence(name, duration, marks, tick, finish, resolve));
    });
  }

  // -------------------------------------------------------------------------
  // Geometry helpers
  // -------------------------------------------------------------------------

  private squareWorld(square: number, out: THREE.Vector3): THREE.Vector3 {
    const x = worldX(fileOf(square));
    const z = worldZ(rankOf(square));
    return out.set(x, this.ground ? this.ground(x, z) : 0, z);
  }

  private place(unit: UnitInstance, x: number, z: number): void {
    unit.root.position.set(x, this.ground ? this.ground(x, z) : 0, z);
  }

  /**
   * Put a figure on a square it did not walk to, and say so.
   *
   * Every `finish()` in this file runs on two paths: the sequence ended
   * normally, in which case the tick has already carried the figure to exactly
   * this point and this is a no-op; or the sequence was skipped or cancelled, in
   * which case this is a **teleport** — a takeback, a position load, a player's
   * key during the march, `__XQ.pause()` taking the clock. A foot lock is a
   * world position, so a teleport falsifies it, and the contact solver's job is
   * then to drag the drawn figure back to plants that are no longer anywhere
   * near it. `TELEPORT_MIN` is what separates the two paths.
   *
   * Safe to call from a tick as well as from a `finish()`: a figure that is
   * being walked moves a fraction of the threshold per frame and is never
   * re-primed, and the one call that does cross it is the snap `complete()`
   * makes when a sequence is skipped. That matters because `complete()` runs
   * the tick at `duration` *before* it runs `finish()` — the march-in's snap
   * happens in the tick, and a `finish()` that only looked at its own placement
   * would find the figure already moved and conclude nothing had happened.
   */
  private teleport(unit: UnitInstance, x: number, z: number): void {
    const jumped = Math.hypot(x - unit.root.position.x, z - unit.root.position.z) > TELEPORT_MIN;
    this.place(unit, x, z);
    if (jumped) this.animator(unit)?.teleported();
  }

  /**
   * How much of the gap the attacker closes before it strikes, from its own
   * reach rather than from one number for the whole cast.
   *
   * The attacker stops where **either its weapon or its own body** is against
   * the defender, whichever happens first:
   *
   *     standoff = max(reach, own half-depth) + defender's torso radius − bite
   *
   * `reach` is measured off the figure's own strike clip at the contact frame
   * (`Animator.strikeReach`), so a 兵's short spear (176 mm past its root), a
   * 士's sword (234 mm) and a 象 rider's goad (593 mm) each get their own
   * answer, and a 將 — whose blade has swept past by the contact frame — gets
   * its fist (174 mm), which is what actually lands. The half-depth term is
   * what keeps a mounted attacker from putting its horse's head through the man
   * it is killing; for a 兵 it is smaller than the reach and never binds.
   *
   * The result is a fraction because the gap varies as much as the reach does:
   * one square for a 兵, 1.41 for a 士, 2.24 for a 馬, 2.83 for a 象.
   */
  private approachFraction(
    attacker: UnitInstance,
    atk: Animator | undefined,
    defender: UnitInstance,
    gap: number,
  ): number {
    if (!atk) return CAPTURE.approachFraction;
    const halfDepth = attacker.meta.size[2] * 0.5;
    const torso = Math.min(defender.meta.size[0], defender.meta.size[2]) * 0.5;
    const standoff = Math.max(atk.strikeReach, halfDepth) + torso - CAPTURE.contactBite;
    return clamp((gap - standoff) / gap, CAPTURE.approachMin, CAPTURE.approachMax);
  }

  /** Yaw that points a unit's −Z forward axis along a world direction. */
  private yawTo(dx: number, dz: number): number {
    if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return 0;
    return Math.atan2(-dx, -dz);
  }

  /**
   * The path a piece takes between two squares.
   *
   * A 馬 does not slide diagonally: it steps one square orthogonally and then
   * one diagonally, and the turn between the two legs is where the hips-lead
   * rule becomes visible. Everything else travels in a straight line, which for
   * the 象 is a genuine diagonal and for the 俥 is a rank or a file.
   */
  private buildPath(unit: UnitInstance, from: number, to: number, out: THREE.Vector3[]): number {
    const f0 = fileOf(from);
    const r0 = rankOf(from);
    const f1 = fileOf(to);
    const r1 = rankOf(to);
    out.length = 0;
    out.push(new THREE.Vector3(worldX(f0), 0, worldZ(r0)));
    if (unit.meta.type === PieceType.Horse) {
      const df = f1 - f0;
      const dr = r1 - r0;
      // The orthogonal leg runs along whichever axis moves two squares.
      const stepF = Math.abs(df) === 2 ? Math.sign(df) : 0;
      const stepR = Math.abs(dr) === 2 ? Math.sign(dr) : 0;
      out.push(new THREE.Vector3(worldX(f0 + stepF), 0, worldZ(r0 + stepR)));
    }
    out.push(new THREE.Vector3(worldX(f1), 0, worldZ(r1)));
    let len = 0;
    for (let i = 1; i < out.length; i++) len += out[i].distanceTo(out[i - 1]);
    return len;
  }

  /** Position at arc-length `s` along a polyline, plus the segment direction. */
  private samplePath(path: THREE.Vector3[], s: number, out: THREE.Vector3, dir: THREE.Vector3): void {
    let remaining = s;
    for (let i = 1; i < path.length; i++) {
      const seg = path[i].distanceTo(path[i - 1]);
      if (remaining <= seg || i === path.length - 1) {
        const u = seg > 1e-9 ? clamp(remaining / seg, 0, 1) : 1;
        out.lerpVectors(path[i - 1], path[i], u);
        dir.copy(path[i]).sub(path[i - 1]);
        const l = dir.length();
        if (l > 1e-9) dir.multiplyScalar(1 / l);
        return;
      }
      remaining -= seg;
    }
    out.copy(path[path.length - 1]);
  }

  /** Eased travel with an acceleration ramp in and a longer one out. */
  private travelEase(u: number): number {
    const a = WALK.rampIn;
    const b = 1 - WALK.rampOut;
    // Trapezoidal speed profile, integrated: smooth acceleration, cruise,
    // smooth deceleration. Constant-speed pieces read as tokens on a tween.
    const area = 0.5 * a + (b - a) + 0.5 * (1 - b);
    if (u <= a) return (0.5 * u * u) / (a * area);
    if (u <= b) return (0.5 * a + (u - a)) / area;
    const t = (u - b) / (1 - b);
    return (0.5 * a + (b - a) + (1 - b) * (t - 0.5 * t * t)) / area;
  }

  // -------------------------------------------------------------------------
  // walk
  // -------------------------------------------------------------------------

  walk(unit: UnitInstance, fromSq: number, toSq: number): Promise<void> {
    const anim = this.animator(unit);
    const path: THREE.Vector3[] = [];
    const length = this.buildPath(unit, fromSq, toSq, path);
    const gait = unit.meta.gait as GaitName;
    // The figure's own stride, so the time it takes to cross the ground and the
    // rate its legs cycle at are the same statement. `walkSeconds` divides one
    // by the other; handing it the animator's stride is what keeps a 0.60-scale
    // conscript and a 1.12-scale general both marching at their own cadence.
    const travelTime = walkSeconds(gait, length, anim?.stride);
    const total = travelTime + WALK.settle;

    this.place(unit, path[0].x, path[0].z);
    let lastS = 0;

    const marks: Mark[] = [
      mark(0, () => {
        anim?.play('move', WALK.turnLead);
        this.audio.play('pieceLift', { gain: 0.4, pan: clamp(path[0].x / 6, -1, 1) });
      }),
      mark(travelTime, () => {
        anim?.play('idle');
        this.audio.play('pieceLand', {
          gain: 0.62,
          pan: clamp(path[path.length - 1].x / 6, -1, 1),
        });
      }),
    ];

    const tick = (t: number): void => {
      if (t >= travelTime) return;
      const u = travelTime > 0 ? t / travelTime : 1;
      const s = this.travelEase(u) * length;
      this.samplePath(path, s, _a, _dir);
      this.place(unit, _a.x, _a.z);
      // Travel is reported from the *actual* frame-to-frame distance, which is
      // what keeps a wheel or a hoof matched to the ground under every retime.
      const moved = Math.max(0, s - lastS);
      lastS = s;
      anim?.reportTravel(moved);
      if (moved > 1e-6) anim?.setFacing(this.yawTo(_dir.x, _dir.z));
    };

    const finish = (): void => {
      this.samplePath(path, length, _a, _dir);
      // `teleport`, not `place`: a walk that was cancelled mid-stride — a
      // takeback, a position load — jumps the figure to its destination, and
      // the feet it left behind have to be told. A walk that ended normally
      // lands here to float precision and nothing is dropped, which matters:
      // the closing step `play('idle')` is about to start is what stops the
      // figure standing in the split stance the walk left it in.
      this.teleport(unit, _a.x, _a.z);
      anim?.play('idle', FADE_SNAP);
    };

    return this.make(`walk:${fromSq}->${toSq}`, total, marks, tick, finish);
  }

  // -------------------------------------------------------------------------
  // capture
  // -------------------------------------------------------------------------

  capture(
    attacker: UnitInstance,
    defender: UnitInstance,
    ctx: CaptureBeatContext,
  ): Promise<void> {
    return ctx.ranged
      ? this.rangedCapture(attacker, defender, ctx)
      : this.meleeCapture(attacker, defender, ctx);
  }

  private busContext(
    attacker: UnitInstance,
    defender: UnitInstance,
    ctx: CaptureBeatContext,
  ): CaptureContext {
    return {
      attackerSq: ctx.attackerSq,
      defenderSq: ctx.defenderSq,
      attacker: makePiece(attacker.meta.side, attacker.meta.type),
      defender: makePiece(defender.meta.side, defender.meta.type),
      ranged: ctx.ranged,
    };
  }

  /**
   * The melee exchange. Marks are absolute times on the capture clock, with the
   * frozen-time hold folded into every mark after contact — so retiming the hold
   * in `timing.ts` moves the whole tail with it rather than desynchronising it.
   */
  private meleeCapture(
    attacker: UnitInstance,
    defender: UnitInstance,
    ctx: CaptureBeatContext,
  ): Promise<void> {
    const atk = this.animator(attacker);
    const def = this.animator(defender);
    const cc = this.busContext(attacker, defender, ctx);

    // Owned by this sequence: its marks read these long after other work has
    // run through the module scratch.
    const A = this.squareWorld(ctx.attackerSq, new THREE.Vector3());
    const B = this.squareWorld(ctx.defenderSq, new THREE.Vector3());
    const D = B.clone().sub(A);
    const gap = Math.max(1e-4, D.length());
    D.multiplyScalar(1 / gap);
    const yaw = this.yawTo(D.x, D.z);
    const H = CAPTURE_HOLD;

    // A chariot does not stop in front of what it kills, so it covers almost
    // the whole gap before contact and finishes the move through the wreck.
    const rollingThrough = attacker.meta.type === PieceType.Chariot;
    const approachFrac = rollingThrough
      ? 0.86
      : this.approachFraction(attacker, atk, defender, gap);

    // The approach is a WALK, and it ends before the coil starts.
    //
    // It used to run until contact while `attackWindup` played from 0.43 s, and
    // that overlap is the whole of the crouch the critic measured: outside the
    // `move` state both feet lock at weight 1, the tick goes on sliding the root
    // toward the defender, and `solveHips` buys the missing reach the only way
    // it can — it drops the pelvis and drags the skeleton root back toward the
    // plants. 127 mm of pelvis, 96 mm of trail, a figure 27% shorter than it
    // stands, held for half a second with the camera pushed in on it. It is the
    // same failure the note at `tAdvance` says was cured for the tail; it was
    // still here, on camera, and lasting three times as long.
    //
    // So the translation and the `move` state have the same extent, and the
    // exchange waits for the walk rather than the walk racing the exchange:
    // beat 1 is now "the attacker walks up to its victim" at the figure's own
    // authored cadence, and every mark after it slides by however long that
    // took. A 兵 closing three quarters of a square spends 2.8 s doing it, the
    // same 116-per-minute quick march it uses to cross an empty square; a 俥
    // charging down a file takes as long as a 俥 takes. Cramming either into
    // the 0.43 s the beat originally allowed would put the gait back where
    // `WALK.referenceStride` says it must never go — six scurrying steps to a
    // square, because the phase comes from the ground and the ground was being
    // covered six times too fast.
    const closeDist = gap * approachFrac;
    const gait = attacker.meta.gait as GaitName;
    const approachTime = Math.max(1e-4, walkSeconds(gait, closeDist, atk?.stride));
    const lead = Math.max(0, approachTime - CAPTURE.windupStart);

    const tWindup = CAPTURE.windupStart + lead;
    const tWindupTop = CAPTURE.windupTop + lead;
    const tStrike = CAPTURE.strikeStart + lead;
    const tContact = CAPTURE.contact + lead;
    const tHoldEnd = tContact + H;
    const tKnockEnd = CAPTURE.knockbackEnd + lead + H;
    const tCollapseEnd = CAPTURE.collapseEnd + lead + H;
    const tDisperse = CAPTURE.disperseStart + lead + H;
    const tDisperseEnd = CAPTURE.disperseEnd + lead + H;
    const tEnd = CAPTURE.settleEnd + lead + H;

    // The finishing step: the attacker leaves the follow-through and walks the
    // rest of the gap. It is a real walk with a real duration, taken from the
    // same table every other walk in the game is taken from.
    const tAdvance = tContact + CAPTURE.recover + H;
    const advanceTime = Math.max(
      1e-4,
      walkSeconds(gait, gap * (1 - approachFrac), atk?.stride),
    );
    const tAdvanceEnd = tAdvance + advanceTime;

    let lastApproach = 0;
    let lastFinish = 0;
    const knock = new THREE.Vector3();

    // The defender's brace, as a function of capture time. Two stages, each with
    // its own cause: the weight settles once the attacker is committed and
    // moving, and it tightens over the coil, taking the last of it in the frames
    // before the blade lands. Released the instant the hit clip takes over —
    // after that the body is not bracing, it is being moved.
    const braceAt = (t: number): number => {
      if (t >= tHoldEnd) return 0;
      const settle = clamp((t - CAPTURE.approachStart) / 0.62, 0, 1);
      const set = clamp((t - tWindupTop) / Math.max(1e-4, tContact - tWindupTop), 0, 1);
      return clamp(0.46 * (settle * settle * (3 - 2 * settle)) + 0.54 * set * set, 0, 1);
    };

    // The corpse's exit, anchored to the end of the collapse — the body lands
    // when the death clip says it lands, whatever the pigment is doing. Two
    // thirds of the figure's own height of sink clears anything the collapse
    // leaves proud of the surface at any angle that can see the board at all.
    const defenderY = defender.root.position.y;
    const sinkDepth = defender.meta.size[1] * 0.66;
    const tCollapsed = tKnockEnd + (def?.duration('death') ?? 0);
    const tSinkFrom = tCollapsed + CAPTURE.corpseLinger;
    const tGone = tSinkFrom + CAPTURE.corpseSink;

    atk?.setFacing(yaw, true);
    def?.setFacing(this.yawTo(-D.x, -D.z), true);

    const marks: Mark[] = [
      mark(CAPTURE.approachStart, () => {
        bus.emit('capture:beat', { ...cc, beat: 1 });
        // Fired, never awaited: the director resolves this from inside its own
        // update, and awaiting it with the clock stalled would deadlock.
        void this.camera.pushToCapture(ctx.attackerSq, ctx.defenderSq);
        atk?.play('move', 0.18);
        _look.copy(B);
        _look.y += defender.meta.size[1] * 0.62;
        atk?.setLookTarget(_look);
        if (attacker.meta.type === PieceType.Elephant) atk?.setTrunkTarget(_look);
        _look.copy(A);
        _look.y += attacker.meta.size[1] * 0.62;
        def?.setLookTarget(_look);
        this.audio.play('armourShift', { gain: 0.4, pan: clamp(A.x / 6, -1, 1) });
      }),
      mark(tWindup, () => {
        // The walk is over and the figure is standing on its own two feet. Both
        // facts matter: leaving `move` is what triggers the closing step that
        // brings the feet under the hips, and the root stops moving here so
        // there is nothing left for the hip solve to compensate for.
        atk?.play('attackWindup');
      }),
      mark(tWindupTop, () => {
        // Hold at the top of the coil. This is the pose the harness parks on.
        atk?.hold('attackWindup', 1);
      }),
      mark(tStrike, () => {
        atk?.release();
        atk?.play('attackStrike');
        this.audio.play(ATTACK_CUE[attacker.meta.key], {
          gain: 0.78,
          pan: clamp(A.x / 6, -1, 1),
        });
      }),
      mark(tContact, () => {
        bus.emit('capture:beat', { ...cc, beat: 2 });
        // One flash, high contrast, in the defender's own pigment: the frame
        // goes white-hot for two frames and comes back.
        bus.emit('fx:flash', { strength: CAPTURE.flash, colour: band('shellWhite', 3) });
        bus.emit('camera:impulse', {
          strength: CAPTURE.impulse,
          direction: [D.x, 0.35, D.z],
        });
        this.camera.impulse(CAPTURE.impulse, D);
        this.audio.play('bladeStrike', { gain: 0.95, pan: clamp(B.x / 6, -1, 1) });
        // Frozen time. The bodies stop; the flash and the camera do not.
        atk?.freeze(true);
        def?.freeze(true);
      }),
      mark(tHoldEnd, () => {
        atk?.freeze(false);
        def?.freeze(false);
        def?.setHitDirection(D);
        def?.play('hit');
        knock.copy(D).multiplyScalar(CAPTURE.knockback);
        this.audio.play('armourShift', { gain: 0.7, pan: clamp(B.x / 6, -1, 1), delay: 0.03 });
      }),
      mark(tKnockEnd, () => {
        def?.play('death');
        def?.setLookTarget(null);
        this.audio.play('bodyFall', { gain: 0.8, pan: clamp(B.x / 6, -1, 1), delay: 0.09 });
      }),
      mark(tAdvance, () => {
        // Out of the follow-through and *walking*, because the next thing the
        // attacker does is cover the rest of the gap onto the square it just
        // cleared. Returning to `idle` here and translating the root anyway is
        // what put it in a crouch: `idle` locks both feet where they stand, the
        // choreographer then slides the root a third of a square past them, and
        // the hip solve does the only thing it can — it drops the pelvis until
        // the legs can still reach the plants. The figure arrives on its square
        // squatting, and stays that way until its next move.
        atk?.play('move', 0.3);
        atk?.setLookTarget(null);
        atk?.setTrunkTarget(null);
      }),
      mark(tAdvanceEnd, () => {
        atk?.play('idle');
        this.audio.play('pieceLand', { gain: 0.5, pan: clamp(B.x / 6, -1, 1) });
      }),
      mark(tDisperse, () => {
        bus.emit('capture:beat', { ...cc, beat: 3 });
        _look.copy(D).multiplyScalar(0.8);
        _look.y = 0.7;
        this.pigment.burstUnit(defender, _look, `${ctx.attackerSq}:${ctx.defenderSq}`);
        this.camera.release();
      }),
      mark(tGone, () => {
        // Already below the board by the time this fires; the flag only stops
        // it being drawn.
        defender.root.visible = false;
      }),
    ];

    const tick = (t: number): void => {
      // Beat 1: the attacker closes, and it is *finished* closing before the
      // coil starts. Between `approachTime` and `tAdvance` the root is not
      // written at all — the figure stands, winds up, strikes and follows
      // through from one place, which is the only way the feet it planted on
      // arrival can still be under it when the blow lands.
      //
      // Beat 3 tail: it finishes the move onto the square it just cleared,
      // which is where the rules say it ends up.
      if (t <= approachTime) {
        const u = clamp(t / approachTime, 0, 1);
        const s = this.travelEase(u) * closeDist;
        this.place(attacker, A.x + D.x * s, A.z + D.z * s);
        const moved = Math.max(0, s - lastApproach);
        lastApproach = s;
        atk?.reportTravel(moved);
      } else if (t >= tAdvance) {
        // The finishing step, over its own walk-shaped window rather than
        // smeared across the whole tail. A third of a square taken at a fifth of
        // marching pace is a figure being dragged, not a figure stepping.
        const u = clamp((t - tAdvance) / advanceTime, 0, 1);
        const s = closeDist + (gap - closeDist) * this.travelEase(u);
        this.place(attacker, A.x + D.x * s, A.z + D.z * s);
        const moved = Math.max(0, s - lastFinish - closeDist);
        lastFinish = s - closeDist;
        atk?.reportTravel(moved);
      }

      // The defender is driven back and stays where it was driven.
      if (t > tHoldEnd && t < tCollapseEnd) {
        const u = clamp((t - tHoldEnd) / Math.max(1e-4, tKnockEnd - tHoldEnd), 0, 1);
        const e = 1 - (1 - u) * (1 - u) * (1 - u);
        // Height held, not re-sampled: the sink below continues from `defenderY`
        // and a mid-knockback step down off its own plinth would pop the moment
        // the sink took over.
        defender.root.position.set(B.x + knock.x * e, defenderY, B.z + knock.z * e);
      }

      // The defender braces. It measured constant to the millimetre through the
      // whole of the approach and the coil — a man watched another man close on
      // him with a spear and did not move a hair — and the head-look was the
      // only thing on that side of the exchange that was alive. It sets its
      // weight as the attacker arrives, holds through the windup, and takes the
      // last of it in the fifth of a second before contact.
      def?.setBrace(braceAt(t));

      // The body leaves under its own weight rather than switching off.
      //
      // `visible = false` on a standing-height corpse is a single frame in which
      // a body is there and then is not, and the eye catches it every time. It
      // lands, it lies on the silk for a moment, and then it goes down into it —
      // under the board, occluded by it — and the flag fires on a figure that is
      // already out of sight. Nothing pops because by then there is nothing left
      // to hide.
      if (t > tSinkFrom) {
        const u = clamp((t - tSinkFrom) / Math.max(1e-4, tGone - tSinkFrom), 0, 1);
        // Slow, then away: the body lies still while most of the pigment leaves.
        const e = u * u * u;
        defender.root.position.y = defenderY - sinkDepth * e;
      }
    };

    const finish = (): void => {
      atk?.freeze(false);
      def?.freeze(false);
      atk?.setLookTarget(null);
      atk?.setTrunkTarget(null);
      def?.setLookTarget(null);
      // The brace goes with the look: a cancelled exchange leaves nobody to
      // brace against, and a figure that survives a takeback must not keep the
      // crouch it took for a blow that never landed.
      def?.setBrace(0);
      defender.root.position.y = defenderY;
      // A cancelled exchange snaps the attacker across the rest of the gap from
      // wherever the coil had it; its feet are still planted on the start side.
      this.teleport(attacker, B.x, B.z);
      atk?.setFacing(yaw, true);
      atk?.play('idle', FADE_SNAP);
      defender.root.visible = false;
    };

    return this.make(`capture:${ctx.attackerSq}->${ctx.defenderSq}`, tEnd, marks, tick, finish);
  }

  /**
   * The 砲's ranged capture.
   *
   * The crew hauls, the beam whips, a stone leaves on a visible arc and bursts
   * where it lands. The attacker does not leave its square for the whole
   * exchange — it only travels afterwards, once the target square is clear,
   * because the rules put it there and the drama does not.
   */
  private rangedCapture(
    attacker: UnitInstance,
    defender: UnitInstance,
    ctx: CaptureBeatContext,
  ): Promise<void> {
    const atk = this.animator(attacker);
    const def = this.animator(defender);
    const cc = this.busContext(attacker, defender, ctx);

    const A = this.squareWorld(ctx.attackerSq, new THREE.Vector3());
    const B = this.squareWorld(ctx.defenderSq, new THREE.Vector3());
    const D = B.clone().sub(A);
    const gap = Math.max(1e-4, D.length());
    D.multiplyScalar(1 / gap);
    const yaw = this.yawTo(D.x, D.z);
    atk?.setFacing(yaw, true);
    def?.setFacing(this.yawTo(-D.x, -D.z), true);

    const H = CAPTURE_HOLD;
    // Everything after impact runs on the melee clock, shifted so that the
    // stone landing and a blade landing are the same event to the rest of the
    // system — the bus payload and the beats are identical.
    const shift = RANGED.impact - CAPTURE.contact;
    const tHoldEnd = RANGED.impact + H;
    const tKnockEnd = CAPTURE.knockbackEnd + shift + H;
    const tDisperse = CAPTURE.disperseStart + shift + H;
    const tDisperseEnd = CAPTURE.disperseEnd + shift + H;
    // The corpse leaves the same way it does in a melee: it lands, it lies
    // there, it sinks. Anchored to the collapse, not to the pigment.
    const defenderY = defender.root.position.y;
    const sinkDepth = defender.meta.size[1] * 0.66;
    const tSinkFrom = tKnockEnd + (def?.duration('death') ?? 0) + CAPTURE.corpseLinger;
    const tGone = tSinkFrom + CAPTURE.corpseSink;
    const travelTime = walkSeconds(attacker.meta.gait as GaitName, gap, atk?.stride);
    const tTravel = Math.max(tDisperseEnd, tGone) + 0.18;
    const tEnd = tTravel + travelTime + WALK.settle;

    const muzzle = new THREE.Vector3();
    const impactPoint = new THREE.Vector3();
    const knock = new THREE.Vector3();
    let lastS = 0;

    const marks: Mark[] = [
      mark(RANGED.haulStart, () => {
        bus.emit('capture:beat', { ...cc, beat: 1 });
        void this.camera.pushToCapture(ctx.attackerSq, ctx.defenderSq);
        atk?.play('attackWindup');
        _look.copy(B);
        _look.y += defender.meta.size[1] * 0.6;
        atk?.setLookTarget(_look);
      }),
      mark(RANGED.release - 0.12, () => {
        atk?.play('attackStrike');
      }),
      mark(RANGED.release, () => {
        // Launch from the machine's own muzzle socket if it has one, so the
        // stone leaves the sling and not the middle of the square.
        const socket = attacker.attach.muzzle;
        if (socket) socket.getWorldPosition(muzzle);
        else muzzle.set(A.x, A.y + attacker.meta.size[1] * 0.8, A.z);
        impactPoint.set(B.x, B.y + defender.meta.size[1] * 0.45, B.z);
        this.pigment.launch(muzzle, impactPoint, RANGED.flight, () => {});
        this.audio.play('trebuchetRelease', { gain: 0.85, pan: clamp(A.x / 6, -1, 1) });
      }),
      mark(RANGED.impact, () => {
        bus.emit('capture:beat', { ...cc, beat: 2 });
        bus.emit('fx:flash', { strength: CAPTURE.flash * 0.86, colour: band('shellWhite', 3) });
        bus.emit('camera:impulse', {
          strength: CAPTURE.impulse,
          direction: [D.x, 0.42, D.z],
        });
        this.camera.impulse(CAPTURE.impulse, D);
        this.audio.play('trebuchetImpact', { gain: 0.95, pan: clamp(B.x / 6, -1, 1) });
        // The stone bursts into pigment where it lands, before the body does.
        _look.copy(D).multiplyScalar(1.1);
        _look.y = 0.9;
        this.pigment.burst({
          origin: impactPoint,
          extent: new THREE.Vector3(0.12, 0.12, 0.12),
          pigment: 'stone',
          count: PROJECTILE.burstChips,
          impulse: _look,
          force: PROJECTILE.burstSpeed / PIGMENT.speed,
          seed: `stone:${ctx.attackerSq}:${ctx.defenderSq}`,
        });
        atk?.freeze(true);
        def?.freeze(true);
      }),
      mark(tHoldEnd, () => {
        atk?.freeze(false);
        def?.freeze(false);
        def?.setHitDirection(D);
        def?.play('hit');
        knock.copy(D).multiplyScalar(CAPTURE.knockback * 1.2);
      }),
      mark(tKnockEnd, () => {
        def?.play('death');
        this.audio.play('bodyFall', { gain: 0.8, pan: clamp(B.x / 6, -1, 1), delay: 0.07 });
        atk?.play('idle', 0.36);
        atk?.setLookTarget(null);
      }),
      mark(tDisperse, () => {
        bus.emit('capture:beat', { ...cc, beat: 3 });
        _look.copy(D).multiplyScalar(0.7);
        _look.y = 0.75;
        this.pigment.burstUnit(defender, _look, `${ctx.attackerSq}:${ctx.defenderSq}`);
        this.camera.release();
      }),
      mark(tGone, () => {
        defender.root.visible = false;
      }),
      mark(tTravel, () => {
        atk?.play('move', 0.2);
      }),
      mark(tTravel + travelTime, () => {
        atk?.play('idle');
        this.audio.play('pieceLand', { gain: 0.6, pan: clamp(B.x / 6, -1, 1) });
      }),
    ];

    const tick = (t: number): void => {
      if (t > tHoldEnd && t < tKnockEnd + 0.9) {
        const u = clamp((t - tHoldEnd) / Math.max(1e-4, tKnockEnd - tHoldEnd), 0, 1);
        const e = 1 - (1 - u) * (1 - u) * (1 - u);
        defender.root.position.set(B.x + knock.x * e, defender.root.position.y, B.z + knock.z * e);
      }
      if (t > tSinkFrom) {
        const u = clamp((t - tSinkFrom) / Math.max(1e-4, tGone - tSinkFrom), 0, 1);
        defender.root.position.y = defenderY - sinkDepth * u * u * u;
      }
      if (t >= tTravel) {
        const u = clamp((t - tTravel) / Math.max(1e-4, travelTime), 0, 1);
        const s = this.travelEase(u) * gap;
        this.place(attacker, A.x + D.x * s, A.z + D.z * s);
        atk?.reportTravel(Math.max(0, s - lastS));
        lastS = s;
      }
    };

    const finish = (): void => {
      atk?.freeze(false);
      def?.freeze(false);
      atk?.setLookTarget(null);
      def?.setLookTarget(null);
      defender.root.position.y = defenderY;
      // The 砲 crosses the whole gap at the end of the exchange, so a cancel
      // anywhere before that is a full-square jump.
      this.teleport(attacker, B.x, B.z);
      atk?.play('idle', FADE_SNAP);
      defender.root.visible = false;
    };

    return this.make(`capture:ranged:${ctx.attackerSq}->${ctx.defenderSq}`, tEnd, marks, tick, finish);
  }

  // -------------------------------------------------------------------------
  // formation
  // -------------------------------------------------------------------------

  /**
   * The opening march-in.
   *
   * Units are already standing on their squares when this is called; the march
   * takes their current positions as destinations, sends them back off the board
   * behind their own back rank, and walks them in. They arrive in formation
   * order — conscripts first, the general last — one every 163 ms, so the board
   * fills the way a column arrives rather than the way a checkbox is ticked.
   *
   * `skip()` is polled every frame. A skip snaps every unit to its square and
   * resolves, leaving nothing mid-stride.
   */
  formation(units: UnitInstance[], skip: () => boolean): Promise<void> {
    interface Marcher {
      unit: UnitInstance;
      anim: Animator | undefined;
      start: THREE.Vector3;
      end: THREE.Vector3;
      yaw: number;
      begin: number;
      length: number;
      last: number;
    }

    const order = (u: UnitInstance): number => {
      const i = FORMATION_ORDER.indexOf(u.meta.key);
      return i < 0 ? FORMATION_ORDER.length : i;
    };
    const sorted = [...units].sort((p, q) => {
      const d = order(p) - order(q);
      if (d !== 0) return d;
      // Within a rank, nearest file leads, so a column enters from one side.
      return p.root.position.x - q.root.position.x;
    });

    const marchers: Marcher[] = sorted.map((unit, i) => {
      const end = unit.root.position.clone();
      const side = unit.meta.side;
      // Behind its own back rank: Red enters from +Z, Chu from −Z.
      const back = side === Side.Red ? 1 : -1;
      const start = end.clone();
      start.z += back * FORMATION.offBoard;
      start.y = this.ground ? this.ground(start.x, start.z) : 0;
      const anim = this.animator(unit);
      const yaw = this.yawTo(end.x - start.x, end.z - start.z);
      anim?.setFacing(yaw, true);
      // Off the board in one frame, from a square it has been standing on since
      // it was built: a teleport, and the far end of the march-in is the second
      // one. Both have to drop the plants or the figure is drawn at the other
      // end of the journey from the one it is on.
      unit.root.position.copy(start);
      anim?.teleported();
      return {
        unit,
        anim,
        start,
        end,
        yaw,
        begin: i * FORMATION.stagger,
        length: start.distanceTo(end),
        last: 0,
      };
    });

    const total = Math.max(
      FORMATION.total,
      marchers.length * FORMATION.stagger + FORMATION.perUnit + 1.2,
    );
    const saluteAt = Math.max(0, total - 1.43);

    const marks: Mark[] = marchers.map((m) =>
      mark(m.begin, () => {
        m.anim?.play('move', 0.2);
      }),
    );
    for (const m of marchers) {
      marks.push(
        mark(m.begin + FORMATION.perUnit, () => {
          m.anim?.play('idle');
          this.audio.play('pieceLand', { gain: 0.34, pan: clamp(m.end.x / 6, -1, 1) });
        }),
      );
    }
    marks.push(
      mark(saluteAt, () => {
        for (const m of marchers) m.anim?.play('salute');
        this.audio.play('drumBeat', { gain: 0.7 });
      }),
    );
    marks.sort((p, q) => p.at - q.at);

    // The sequence has to be able to end itself from inside its own tick when
    // the player skips, so it is held by reference rather than built inline.
    let self: Sequence | null = null;
    const tick = (t: number): void => {
      if (skip()) {
        // `complete()` fires every remaining mark and runs `finish`, which snaps
        // the whole army onto its squares. A skip is never a half-step.
        self?.complete();
        return;
      }
      for (const m of marchers) {
        const u = clamp((t - m.begin) / FORMATION.perUnit, 0, 1);
        if (u <= 0) continue;
        const s = this.travelEase(u) * m.length;
        _a.lerpVectors(m.start, m.end, m.length > 1e-9 ? s / m.length : 1);
        // Through `teleport`, because this is where the skip actually lands:
        // `complete()` runs the tick at `duration` before it runs `finish()`,
        // so the four-and-a-half-square jump onto the square happens here.
        this.teleport(m.unit, _a.x, _a.z);
        m.anim?.reportTravel(Math.max(0, s - m.last));
        m.last = s;
      }
    };

    const finish = (): void => {
      for (const m of marchers) {
        // The skip. Thirty-two figures cross up to 4.6 units in one frame, and
        // every one of them is standing on feet locked somewhere out beyond the
        // table edge — which is where the contact solve dutifully dragged the
        // drawn figures back to, for a quarter of a second, on the first frame
        // the harness or a player ever saw.
        this.teleport(m.unit, m.end.x, m.end.z);
        m.anim?.setFacing(m.yaw, true);
        m.anim?.play('idle', FADE_SNAP);
      }
    };

    return new Promise<void>((resolve) => {
      self = new Sequence('formation', total, marks, tick, finish, resolve);
      this.start(self);
    });
  }

  // -------------------------------------------------------------------------
  // finale
  // -------------------------------------------------------------------------

  /**
   * The terminal set piece. The beaten general goes down; his army holds; the
   * winning army raises weapons in a ripple that starts at the front rank and
   * runs back, so the eye is carried across the board rather than hit with
   * thirty-two simultaneous poses.
   */
  finale(result: GameResult, units: UnitInstance[]): Promise<void> {
    const winner = result.winner;
    const losers = units.filter((u) => winner !== null && u.meta.side !== winner);
    const winners = units.filter((u) => winner !== null && u.meta.side === winner);
    const general = losers.find((u) => u.meta.type === PieceType.General);

    const marks: Mark[] = [
      mark(0, () => {
        this.camera.setMode('terminal', 2.4);
        this.audio.setIntensity(0.35);
      }),
    ];
    if (general) {
      marks.push(
        mark(FINALE.generalFallAt, () => {
          const a = this.animator(general);
          a?.play('death');
          this.audio.play('bodyFall', { gain: 0.9 });
        }),
      );
    }
    for (const u of losers) {
      if (u === general) continue;
      const a = this.animator(u);
      marks.push(mark(FINALE.generalFallAt + 0.35, () => a?.play('salute')));
    }
    const ordered = [...winners].sort((p, q) => p.root.position.z - q.root.position.z);
    ordered.forEach((u, i) => {
      const a = this.animator(u);
      marks.push(mark(FINALE.raiseFrom + i * FINALE.raiseStagger, () => a?.play('victory')));
    });
    marks.push(
      mark(FINALE.gongAt, () => {
        this.audio.play('gong', { gain: 1 });
      }),
    );
    marks.sort((p, q) => p.at - q.at);

    const finish = (): void => {
      for (const u of winners) this.animator(u)?.play('victory', FADE_SNAP);
      if (general) this.animator(general)?.play('death', FADE_SNAP);
    };

    return this.make('finale', FINALE.total, marks, null, finish);
  }

  // -------------------------------------------------------------------------
  // Harness support
  // -------------------------------------------------------------------------

  /**
   * Drive a capture to an exact normalised time and hold there.
   *
   * The sequence is re-run from zero in fixed 1/60 steps, advancing the
   * animators and the pigment field alongside it, so the frame the harness
   * captures at `t` is the frame the game would have produced at `t` — including
   * the particle simulation, which is seeded and therefore replays identically.
   */
  seekCapture(
    attacker: UnitInstance,
    defender: UnitInstance,
    ctx: CaptureBeatContext,
    t: number,
  ): void {
    this.abort();
    defender.root.visible = true;
    const atk = this.animator(attacker);
    const def = this.animator(defender);
    // A scrub must not inherit anything from whatever ran before it — root
    // corrections, foot locks and damped followers are all functions of history.
    atk?.reset();
    def?.reset();
    // Nor may it inherit a *position*. `reset()` clears the animators and the
    // exchange rewrites the attacker's root from its first tick, but nothing
    // rewrites the defender's until it is struck: a seek taken after one that
    // ran past the knockback therefore started with the body already driven
    // back and sinking, and the same `t` gave two different frames depending on
    // what had been scrubbed before it. Both figures go back on their squares.
    this.squareWorld(ctx.attackerSq, _a);
    this.place(attacker, _a.x, _a.z);
    this.squareWorld(ctx.defenderSq, _a);
    this.place(defender, _a.x, _a.z);
    void this.capture(attacker, defender, ctx);
    const seq = this.running[this.running.length - 1];
    if (!seq) return;
    const target = clamp(t, 0, 1) * seq.duration;
    let elapsed = 0;
    while (elapsed < target - 1e-6) {
      const dt = Math.min(FRAME, target - elapsed);
      seq.advance(dt);
      atk?.update(dt);
      def?.update(dt);
      this.pigment.update(dt);
      elapsed += dt;
      if (seq.done) break;
    }
  }
}

/** A fade of zero: used only by `finish()` paths, which must not interpolate. */
const FADE_SNAP = 0;


export function createChoreographer(opts: ChoreographyOptions): Choreography {
  return new Choreography(opts);
}
