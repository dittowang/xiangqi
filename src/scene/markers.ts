/**
 * Interaction marks.
 *
 * Every one of these is a *physical* mark on the table, not an overlay: the
 * legal-destination marks are pressed into the silk and filled with 泥金, the
 * last-move marks are the hollow-and-solid pair a 棋譜 uses to record a move, and
 * the check mark is a 朱砂 ring laid round the threatened general's plinth. The
 * only thing that floats is the hover ring, and it floats by six millimetres,
 * which is the amount a finger hovering over a board casts.
 *
 * Marks that sit at board level all carry a hair of proud rim (`MARK_LIP`) the
 * way pressed silk lifts at the edge of a stamp. That is both the truth of the
 * material and what keeps them out of a z-fight with the deck they are pressed
 * into.
 *
 * All animation is driven from accumulated `dt`. Nothing here reads a wall clock,
 * so `__XQ.step()` produces the same frame every run.
 */

import * as THREE from 'three';
import type { GongbiMaterials } from '@core/contracts.ts';
import { fileOf, rankOf, worldX, worldZ } from '@core/coords.ts';
import { SCENE } from '@core/palette.ts';
import { clamp, easeOutCubic, easeOutBack } from '@core/types.ts';
import { MeshBuilder, disc, latheProfile, type ProfilePoint } from './geometry.ts';

// --- proportions -----------------------------------------------------------

/** Proud rim on every pressed mark. */
const MARK_LIP = 0.0016;

/** Legal-destination mark: a small pressed pan filled with gold. */
const LEGAL_RIM_R = 0.118;
const LEGAL_FLOOR_R = 0.086;
const LEGAL_FLOOR_Y = -0.0062;
/** Most legal moves one xiangqi piece can have is 17; the pool has headroom. */
const LEGAL_CAPACITY = 34;
/** Seconds between successive marks appearing — reads as a hand laying them. */
const LEGAL_STAGGER = 0.022;
/** Seconds for one mark to press in. */
const LEGAL_RISE = 0.19;

/** Hover ring. */
const HOVER_INNER = 0.3;
const HOVER_OUTER = 0.398;
const HOVER_LIFT = 0.006;
const HOVER_BOB = 0.0035;
const HOVER_BOB_RATE = 1.9; // rad/s
const HOVER_SPIN_RATE = 0.28; // rad/s
const HOVER_FOLLOW = 16.0; // exponential approach rate, per second
const HOVER_FADE = 7.0;

/** Check ring, sized to clear a piece base (radius 0.345). */
const CHECK_INNER = 0.358;
const CHECK_OUTER = 0.492;
const CHECK_PULSE_RATE = 3.35; // rad/s
const CHECK_PULSE_DEPTH = 0.085; // fraction of scale

/** Last-move marks: hollow at the origin, solid at the destination. */
const LAST_RING_INNER = 0.152;
const LAST_RING_OUTER = 0.206;
const LAST_DOT_R = 0.072;

// Module-level scratch. Everything below runs per frame.
const _mat = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _identityQuat = new THREE.Quaternion();
/** Snapshot buffers for `showLegal`'s carry-over pass. */
const _prevSq = new Int32Array(LEGAL_CAPACITY);
const _prevT = new Float32Array(LEGAL_CAPACITY);

// --- geometry --------------------------------------------------------------

/** A pressed pan: proud rim, sloped wall, flat floor. Origin at board level. */
function pressedPan(rimR: number, floorR: number, floorY: number, segments: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const profile: ProfilePoint[] = [
    { u: floorR, y: floorY, hard: true },
    { u: rimR, y: MARK_LIP, hard: true },
  ];
  // Wall, walked outward from the floor so the lit side faces the key.
  latheProfile(b, profile, segments, 0, 0, 0);
  disc(b, floorR, floorY, segments);
  return b.build('scene/mark/pan');
}

/** A pressed ring: proud rim, sunken channel, proud inner rim. */
function pressedRing(inner: number, outer: number, segments: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const mid = (inner + outer) * 0.5;
  const profile: ProfilePoint[] = [
    { u: inner, y: MARK_LIP, hard: true },
    { u: inner + (mid - inner) * 0.42, y: -0.0052, hard: true },
    { u: outer - (outer - mid) * 0.42, y: -0.0052, hard: true },
    { u: outer, y: MARK_LIP, hard: true },
  ];
  latheProfile(b, profile, segments, 0, 0, 0);
  return b.build('scene/mark/ring');
}

/** A raised band that hovers clear of the board. */
function liftedBand(inner: number, outer: number, height: number, segments: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const profile: ProfilePoint[] = [
    { u: inner, y: 0, hard: true },
    { u: inner + 0.012, y: height, hard: true },
    { u: outer - 0.012, y: height, hard: true },
    { u: outer, y: 0, hard: true },
  ];
  latheProfile(b, profile, segments, 0, 0, 0);
  return b.build('scene/mark/band');
}

// --- the manager -----------------------------------------------------------

export interface MarkersOptions {
  materials: GongbiMaterials;
  /** Bare board surface height — marks press into the board, not into a base. */
  surfaceAt: (x: number, z: number) => number;
}

export class Markers {
  readonly group = new THREE.Group();
  triangles = 0;

  private readonly legal: THREE.InstancedMesh;
  private readonly legalSq = new Int32Array(LEGAL_CAPACITY);
  private readonly legalT = new Float32Array(LEGAL_CAPACITY);
  private readonly legalDelay = new Float32Array(LEGAL_CAPACITY);
  private legalCount = 0;
  private legalRetiring = false;

  private readonly hover: THREE.Mesh;
  private hoverSquare = -1;
  private hoverX = 0;
  private hoverZ = 0;
  private hoverAmount = 0;
  private hoverPhase = 0;

  private readonly check: THREE.Mesh;
  private checkSquare = -1;
  private checkAmount = 0;
  private checkPhase = 0;

  private readonly lastRings: THREE.InstancedMesh;
  private readonly lastDot: THREE.Mesh;
  private lastFrom = -1;
  private lastTo = -1;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly surfaceAt: (x: number, z: number) => number;

  constructor(opts: MarkersOptions) {
    this.group.name = 'scene/markers';
    this.surfaceAt = opts.surfaceAt;
    const M = opts.materials;

    const track = <T extends THREE.BufferGeometry>(g: T): T => {
      this.geometries.push(g);
      this.triangles += (g.getAttribute('position')?.count ?? 0) / 3;
      return g;
    };

    // Legal destinations — pressed gold.
    const panGeo = track(pressedPan(LEGAL_RIM_R, LEGAL_FLOOR_R, LEGAL_FLOOR_Y, 20));
    this.legal = new THREE.InstancedMesh(
      panGeo,
      M.get({ cls: 'gold', pigment: SCENE.legalMark }),
      LEGAL_CAPACITY,
    );
    this.legal.name = 'scene/markers/legal';
    this.legal.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.legal.frustumCulled = false;
    this.legal.receiveShadow = true;
    this.legal.count = 0;
    this.group.add(this.legal);

    // Hover — a lifted ring in shell white, the quietest pigment on the board.
    const hoverGeo = track(liftedBand(HOVER_INNER, HOVER_OUTER, 0.0105, 44));
    this.hover = new THREE.Mesh(hoverGeo, M.get({ cls: 'ivory', pigment: 'shellWhite', variation: -0.1 }));
    this.hover.name = 'scene/markers/hover';
    this.hover.visible = false;
    this.hover.frustumCulled = false;
    this.group.add(this.hover);

    // Check — cinnabar, with an emissive lift requested so the ramp can bloom it.
    const checkGeo = track(liftedBand(CHECK_INNER, CHECK_OUTER, 0.0072, 52));
    this.check = new THREE.Mesh(
      checkGeo,
      M.get({ cls: 'lacquer', pigment: SCENE.checkPulse, glow: 0.55 }),
    );
    this.check.name = 'scene/markers/check';
    this.check.visible = false;
    this.check.frustumCulled = false;
    this.group.add(this.check);

    // Last move — dark gold, deliberately faint.
    const lastMat = M.get({ cls: 'gold', pigment: SCENE.legalMark, variation: -0.42 });
    const ringGeo = track(pressedRing(LAST_RING_INNER, LAST_RING_OUTER, 24));
    this.lastRings = new THREE.InstancedMesh(ringGeo, lastMat, 2);
    this.lastRings.name = 'scene/markers/lastMove';
    this.lastRings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lastRings.frustumCulled = false;
    this.lastRings.count = 0;
    this.group.add(this.lastRings);

    const dotGeo = track(pressedPan(LAST_DOT_R, LAST_DOT_R * 0.62, -0.0045, 18));
    this.lastDot = new THREE.Mesh(dotGeo, lastMat);
    this.lastDot.name = 'scene/markers/lastMoveDot';
    this.lastDot.visible = false;
    this.lastDot.frustumCulled = false;
    this.group.add(this.lastDot);
  }

  // -- board scene surface ---------------------------------------------------

  showLegal(targets: readonly number[]): void {
    const n = Math.min(targets.length, LEGAL_CAPACITY);
    this.legalRetiring = false;
    // Snapshot before writing: the loop below overwrites slots the carry-over
    // search still needs to read, and reading a slot it has already clobbered
    // would hand a mark somebody else's animation progress.
    const prevCount = this.legalCount;
    for (let i = 0; i < prevCount; i++) {
      _prevSq[i] = this.legalSq[i];
      _prevT[i] = this.legalT[i];
    }
    for (let i = 0; i < n; i++) {
      const sq = targets[i];
      // Keep a mark that is already up: re-selecting a piece whose move set
      // overlaps the last one should not restage the whole board.
      let carried = -1;
      for (let j = 0; j < prevCount; j++) {
        if (_prevSq[j] === sq) {
          carried = _prevT[j];
          break;
        }
      }
      this.legalSq[i] = sq;
      this.legalT[i] = carried >= 0 ? carried : 0;
      this.legalDelay[i] = carried >= 0 ? 0 : i * LEGAL_STAGGER;
    }
    this.legalCount = n;
    this.legal.count = n;
    this.writeLegal();
  }

  clearLegal(): void {
    // Retire rather than vanish: the marks lift back out of the silk.
    this.legalRetiring = true;
  }

  setHover(square: number | null): void {
    const sq = square == null ? -1 : square;
    if (sq === this.hoverSquare) return;
    this.hoverSquare = sq;
    if (sq >= 0 && this.hoverAmount <= 0.001) {
      // Appearing fresh: start under the square rather than sliding in from
      // wherever the last hover died.
      this.hoverX = worldX(fileOf(sq));
      this.hoverZ = worldZ(rankOf(sq));
    }
  }

  setCheck(square: number | null): void {
    this.checkSquare = square == null ? -1 : square;
    if (this.checkSquare >= 0 && this.checkAmount <= 0.001) this.checkPhase = 0;
  }

  setLastMove(from: number, to: number): void {
    this.lastFrom = from;
    this.lastTo = to;
    if (from < 0 || to < 0) {
      this.lastRings.count = 0;
      this.lastDot.visible = false;
      return;
    }
    this.lastRings.count = 2;
    this.place(this.lastRings, 0, worldX(fileOf(from)), worldZ(rankOf(from)), 1);
    this.place(this.lastRings, 1, worldX(fileOf(to)), worldZ(rankOf(to)), 1);
    this.lastRings.instanceMatrix.needsUpdate = true;
    const tx = worldX(fileOf(to));
    const tz = worldZ(rankOf(to));
    this.lastDot.visible = true;
    this.lastDot.position.set(tx, this.surfaceAt(tx, tz), tz);
  }

  setSilhouetteMode(on: boolean): void {
    // Marks are the interface, not the scene. The silhouette critic judges the
    // board and the figures, so the marks step out of the frame entirely.
    this.group.visible = !on;
  }

  // -- per frame -------------------------------------------------------------

  update(dt: number): void {
    this.updateLegal(dt);
    this.updateHover(dt);
    this.updateCheck(dt);
  }

  /**
   * Put the free-running pulses back to their origin. Same reason as
   * `RiverWater.resetPhase`: they accumulate from page load, and the harness
   * takes the clock a wall-clock-dependent number of frames later.
   */
  resetPhase(): void {
    this.hoverPhase = 0;
    this.checkPhase = 0;
  }

  private updateLegal(dt: number): void {
    if (this.legalCount === 0) return;
    let anyVisible = false;
    for (let i = 0; i < this.legalCount; i++) {
      if (this.legalRetiring) {
        this.legalT[i] = Math.max(0, this.legalT[i] - dt / (LEGAL_RISE * 0.7));
      } else if (this.legalDelay[i] > 0) {
        this.legalDelay[i] -= dt;
      } else {
        this.legalT[i] = Math.min(1, this.legalT[i] + dt / LEGAL_RISE);
      }
      if (this.legalT[i] > 0.001) anyVisible = true;
    }
    if (this.legalRetiring && !anyVisible) {
      this.legalCount = 0;
      this.legal.count = 0;
      this.legalRetiring = false;
      return;
    }
    this.writeLegal();
  }

  private writeLegal(): void {
    for (let i = 0; i < this.legalCount; i++) {
      const sq = this.legalSq[i];
      const x = worldX(fileOf(sq));
      const z = worldZ(rankOf(sq));
      // easeOutBack gives the mark a hair of overshoot, so it lands like a stamp
      // rather than growing like a UI element.
      const t = clamp(this.legalT[i], 0, 1);
      const s = t <= 0 ? 0 : easeOutBack(t, 1.15);
      this.place(this.legal, i, x, z, s);
    }
    this.legal.instanceMatrix.needsUpdate = true;
  }

  private updateHover(dt: number): void {
    const want = this.hoverSquare >= 0 ? 1 : 0;
    const k = want > this.hoverAmount ? HOVER_FADE : HOVER_FADE * 1.4;
    this.hoverAmount += (want - this.hoverAmount) * (1 - Math.exp(-k * dt));
    if (this.hoverAmount < 0.002 && want === 0) {
      this.hover.visible = false;
      return;
    }
    this.hover.visible = true;

    if (this.hoverSquare >= 0) {
      const tx = worldX(fileOf(this.hoverSquare));
      const tz = worldZ(rankOf(this.hoverSquare));
      const a = 1 - Math.exp(-HOVER_FOLLOW * dt);
      this.hoverX += (tx - this.hoverX) * a;
      this.hoverZ += (tz - this.hoverZ) * a;
    }
    this.hoverPhase += dt;

    const bob = Math.sin(this.hoverPhase * HOVER_BOB_RATE) * HOVER_BOB;
    const s = easeOutCubic(clamp(this.hoverAmount, 0, 1));
    this.hover.position.set(
      this.hoverX,
      this.surfaceAt(this.hoverX, this.hoverZ) + HOVER_LIFT + bob,
      this.hoverZ,
    );
    this.hover.rotation.y = this.hoverPhase * HOVER_SPIN_RATE;
    this.hover.scale.setScalar(0.82 + 0.18 * s);
  }

  private updateCheck(dt: number): void {
    const want = this.checkSquare >= 0 ? 1 : 0;
    this.checkAmount += (want - this.checkAmount) * (1 - Math.exp(-9 * dt));
    if (this.checkAmount < 0.002 && want === 0) {
      this.check.visible = false;
      return;
    }
    this.check.visible = true;
    this.checkPhase += dt;

    const x = this.checkSquare >= 0 ? worldX(fileOf(this.checkSquare)) : this.check.position.x;
    const z = this.checkSquare >= 0 ? worldZ(rankOf(this.checkSquare)) : this.check.position.z;
    // Asymmetric pulse: a fast swell and a slower ebb, like a struck drum.
    const raw = Math.sin(this.checkPhase * CHECK_PULSE_RATE);
    const beat = raw > 0 ? Math.pow(raw, 0.55) : -Math.pow(-raw, 1.6);
    const s = (1 + beat * CHECK_PULSE_DEPTH) * easeOutCubic(clamp(this.checkAmount, 0, 1));
    this.check.position.set(x, this.surfaceAt(x, z) + 0.0018, z);
    this.check.scale.set(s, 1, s);
  }

  private place(mesh: THREE.InstancedMesh, i: number, x: number, z: number, scale: number): void {
    _pos.set(x, this.surfaceAt(x, z), z);
    _quat.copy(_identityQuat);
    _scl.set(scale, scale, scale);
    _mat.compose(_pos, _quat, _scl);
    mesh.setMatrixAt(i, _mat);
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    this.legal.dispose();
    this.lastRings.dispose();
    this.group.clear();
  }
}
