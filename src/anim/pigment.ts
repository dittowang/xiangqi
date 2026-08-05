/**
 * Pigment dispersal.
 *
 * A captured unit does not explode, bleed or burst into sparks. It comes apart
 * into **hard-edged flat chips of mineral pigment in its own colour** — the
 * physical thing a gongbi painting is made of, scattering off the silk. A Han
 * death throws 朱砂 cinnabar; a Chu death throws 石青 azurite; a general throws
 * 泥金 gold, because what leaves the board when a general falls is authority.
 * The colours are read from `UnitMeta.dispersal`, so that mapping lives in the
 * character data and not here.
 *
 * ## What makes it read as pigment rather than confetti
 *
 * Four things, all of them in the integrator:
 *
 *   1. **Hard edges, and flat.** The chip is a thin slab cut to an irregular
 *      quadrilateral, creased along its long diagonal. Flat is the load-bearing
 *      word: a chip is six per cent as thick as it is wide, it has a face and a
 *      back, and it comes to rest *lying* on the silk rather than standing on
 *      it. The crease is a straight ridge across that face, so a tumbling chip
 *      shows a hard value break instead of a smooth gradient.
 *   2. **Quadratic drag.** A flake has enormous area for its mass, so it sheds
 *      its launch speed in the first fifth of a second and then *flutters*.
 *      Ballistic confetti is the giveaway that a system integrated gravity and
 *      forgot the air.
 *   3. **Angular momentum with its own damping.** Chips spin fast at birth and
 *      slow at a different rate from their translation, so the tumble and the
 *      fall never lock into step.
 *   4. **A real settle.** One low-restitution bounce on the board, tangential
 *      friction that kills the slide, a moment lying still, and then a fade that
 *      converges on the silk ground's own colour while the chip shrinks. Nothing
 *      pops out of existence.
 *
 * ## Budget
 *
 * One `InstancedMesh`, one pool, allocated once at construction. A capture
 * spawns from the free list and returns to it; nothing is allocated per capture
 * and nothing is allocated per frame. Live chips are kept dense in the low slots
 * so `mesh.count` can be the live count and the GPU never processes a dead one.
 */

import * as THREE from 'three';
import type { UnitInstance } from '@core/contracts.ts';
import { PIGMENTS, SCENE, band, type PigmentName } from '@core/palette.ts';
import { seedFor, type Rng } from '@core/rng.ts';
import { PIGMENT, PROJECTILE } from './timing.ts';

// ===========================================================================
// Chip geometry
// ===========================================================================

/**
 * The chip's silhouette: an irregular quadrilateral, convex, wound
 * counter-clockwise in XY, normalised to roughly the unit circle.
 *
 * No two edges are the same length and no two are parallel, because a chip is a
 * flake broken off a painted surface and a flake is not a square. Vertices 0 and
 * 2 are the ends of the long diagonal — the fold runs between them — and
 * vertices 1 and 3 are the flanks that drop away from it.
 */
const CHIP_OUTLINE: readonly (readonly [number, number])[] = [
  [0.1, 1.0],
  [-0.92, -0.24],
  [0.16, -0.96],
  [1.0, -0.02],
];

/**
 * One chip: a flat, thin, hard-edged slab.
 *
 * The whole shape lives within ±`chipThickness/2 + chipFold/2` of the plane
 * z = 0, in units where the chip is one half-width wide — that is, it is *flat*,
 * and the instance transform scales z with x so it stays flat at every size. It
 * has a real facing direction: local +z is the face.
 *
 * The two triangles of the top surface meet along the long diagonal at a shallow
 * angle. That crease is a straight ridge, not a peak: it gives a tumbling chip
 * one hard value break across its face, which is what a flake of mineral does in
 * the light and what a smooth gradient never reads as. The predecessor of this
 * function lifted the *centre* vertex of a triangle fan instead, which is not a
 * fold at all — it is a pyramid, and it put a field of blue caltrops on the
 * board where the pigment should have been lying.
 *
 * Twelve triangles: two up, two down, and a rim around the four edges so the
 * chip has a visible thickness when the light rakes across it and does not wink
 * out when it turns edge-on.
 */
function chipGeometry(): THREE.BufferGeometry {
  const t = PIGMENT.chipThickness * 0.5; // half the slab's thickness
  const f = PIGMENT.chipFold * 0.5; // the ridge is +f, the flanks −f
  const n = CHIP_OUTLINE.length;

  const verts: number[] = [];
  const norms: number[] = [];
  const cols: number[] = [];

  /** Mid-surface height of corner `i`: on the ridge, or down on a flank. */
  const mid = (i: number): number => (i % 2 === 0 ? f : -f);

  /**
   * Push one triangle, with the plane's own normal on all three vertices and a
   * flat value multiplier. Faceted by construction: no vertex is ever shared
   * between two facets, so no normal is ever averaged across the crease.
   */
  const tri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    value: number,
  ): void => {
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    verts.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let k = 0; k < 3; k++) {
      norms.push(nx, ny, nz);
      // The value break is baked into the vertex colour rather than left to a
      // light. The chips are drawn with a flat unlit material — laid pigment is
      // not a shiny surface — so a normal alone would produce no break at all,
      // and the two facets of the fold would be one flat patch. The instance
      // colour multiplies into this, so a chip keeps its own pigment band.
      cols.push(value, value, value);
    }
  };

  const px = (i: number): number => CHIP_OUTLINE[i][0];
  const py = (i: number): number => CHIP_OUTLINE[i][1];

  // --- the face: two facets meeting along the 0–2 diagonal -----------------
  const FACE_A = 1.0;
  const FACE_B = 0.87;
  const BACK = 0.78;
  const RIM = 0.62;
  tri(
    px(0), py(0), mid(0) + t,
    px(1), py(1), mid(1) + t,
    px(2), py(2), mid(2) + t,
    FACE_A,
  );
  tri(
    px(0), py(0), mid(0) + t,
    px(2), py(2), mid(2) + t,
    px(3), py(3), mid(3) + t,
    FACE_B,
  );

  // --- the back, the same crease, wound the other way ----------------------
  tri(
    px(0), py(0), mid(0) - t,
    px(2), py(2), mid(2) - t,
    px(1), py(1), mid(1) - t,
    BACK,
  );
  tri(
    px(0), py(0), mid(0) - t,
    px(3), py(3), mid(3) - t,
    px(2), py(2), mid(2) - t,
    BACK,
  );

  // --- the rim: the broken edge, and the darkest value on the chip ---------
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(
      px(i), py(i), mid(i) + t,
      px(i), py(i), mid(i) - t,
      px(j), py(j), mid(j) - t,
      RIM,
    );
    tri(
      px(i), py(i), mid(i) + t,
      px(j), py(j), mid(j) - t,
      px(j), py(j), mid(j) + t,
      RIM,
    );
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.computeBoundingSphere();
  return g;
}

// ===========================================================================
// Options
// ===========================================================================

export interface PigmentFieldOptions {
  /** Hard ceiling on live chips. The pool is this size and never grows. */
  budget?: number;
  /** Board height under a world point — chips bounce on it. */
  ground?: ((x: number, z: number) => number) | null;
  /**
   * Material for the chips. Injected so the renderer can hand over a gongbi
   * material; the default is a flat unlit surface, which is what laid pigment
   * looks like and is deliberately not a lit one.
   */
  material?: THREE.Material;
  /** Material for the 砲's stone. Same reasoning. */
  projectileMaterial?: THREE.Material;
}

const STATE_FREE = 0;
const STATE_FLYING = 1;
const STATE_RESTING = 2;

// Module scratch — `update()` allocates nothing.
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qd = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _v = new THREE.Vector3();
const _roll = new THREE.Matrix4();

/** Cached palette colours, in the renderer's working colour space. */
const COLOUR_CACHE = new Map<string, THREE.Color>();
function pigmentColour(name: PigmentName, i: 0 | 1 | 2 | 3): THREE.Color {
  const k = `${name}:${i}`;
  let c = COLOUR_CACHE.get(k);
  if (!c) {
    c = new THREE.Color().setStyle(band(name, i));
    COLOUR_CACHE.set(k, c);
  }
  return c;
}

// ===========================================================================
// The field
// ===========================================================================

export interface BurstOptions {
  /** Centre of the volume chips are born in, world space. */
  origin: THREE.Vector3;
  /** Half-extents of that volume, world space. */
  extent: THREE.Vector3;
  pigment: PigmentName;
  count: number;
  /** Direction of the blow, world space. Chips favour it. */
  impulse?: THREE.Vector3;
  /** Overall speed multiplier. */
  force?: number;
  /** Deterministic seed tag. Same tag, same scatter, every run. */
  seed: string | number;
}

export class PigmentField {
  readonly group = new THREE.Group();
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;

  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly quat: Float32Array;
  private readonly spin: Float32Array;
  private readonly size: Float32Array; // half-width, half-height
  /**
   * Per-chip roll about the chip's own face normal, applied *before* the
   * anisotropic size scale. One geometry serves every chip, so without this a
   * settled field is the same quadrilateral repeated; rolling the outline and
   * then squashing it along the instance's own axes turns that one quad into a
   * family of quads at no vertex cost. It goes here rather than in the
   * orientation quaternion because `Matrix4.compose` applies scale first, which
   * would make a roll baked into the quaternion no roll at all.
   */
  private readonly roll: Float32Array;
  private readonly col: Float32Array;
  private readonly age: Float32Array;
  private readonly restAt: Float32Array;
  private readonly state: Uint8Array;

  private live = 0;
  private ground: ((x: number, z: number) => number) | null;

  // --- the 砲's stone -------------------------------------------------------
  private readonly stone: THREE.Mesh;
  private stoneActive = false;
  private stoneT = 0;
  private stoneDuration = 0;
  private stoneArc = 0;
  private readonly stoneFrom = new THREE.Vector3();
  private readonly stoneTo = new THREE.Vector3();
  private stoneSpin = 0;
  private onImpact: ((at: THREE.Vector3) => void) | null = null;

  constructor(opts: PigmentFieldOptions = {}) {
    this.capacity = opts.budget ?? PIGMENT.budget;
    this.ground = opts.ground ?? null;
    this.group.name = 'anim/pigment';

    const geo = chipGeometry();
    const mat =
      opts.material ??
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.capacity);
    this.mesh.name = 'anim/pigmentChips';
    this.mesh.frustumCulled = false; // instances move; a static sphere would lie
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;
    // Force the instance colour buffer into existence up front rather than on
    // the first burst, so a capture never allocates.
    _c.setStyle(band('shellWhite', 2));
    for (let i = 0; i < this.capacity; i++) this.mesh.setColorAt(i, _c);
    this.group.add(this.mesh);

    const n = this.capacity;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.quat = new Float32Array(n * 4);
    this.spin = new Float32Array(n * 3);
    this.size = new Float32Array(n * 2);
    this.roll = new Float32Array(n);
    this.col = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.restAt = new Float32Array(n);
    this.state = new Uint8Array(n);

    const stoneGeo = new THREE.IcosahedronGeometry(PROJECTILE.radius, 0);
    const stoneMat =
      opts.projectileMaterial ??
      new THREE.MeshBasicMaterial({ color: pigmentColour('stone', 1), toneMapped: false });
    this.stone = new THREE.Mesh(stoneGeo, stoneMat);
    this.stone.name = 'anim/projectile';
    this.stone.visible = false;
    this.stone.frustumCulled = false;
    this.group.add(this.stone);
  }

  get liveCount(): number {
    return this.live;
  }

  setGroundHeight(fn: ((x: number, z: number) => number) | null): void {
    this.ground = fn;
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /**
   * Throw `count` chips out of a volume.
   *
   * Speed is biased along the impulse and away from the volume's centre, so a
   * unit struck from the left throws pigment to the right and a unit crushed
   * from above throws it outward in a ring. Everything is drawn from a seeded
   * stream keyed on the caller's tag: the same capture scatters identically in
   * every run, on every machine, which is what makes a captured frame a
   * measurement rather than a sample.
   */
  burst(o: BurstOptions): number {
    const rng: Rng = seedFor('anim', 'pigment', String(o.seed));
    const pig = PIGMENTS[o.pigment] ? o.pigment : 'stone';
    const force = o.force ?? 1;
    let spawned = 0;
    for (let i = 0; i < o.count; i++) {
      const slot = this.alloc();
      if (slot < 0) break;
      spawned++;

      // Birth position: uniform in the box, pulled toward the vertical middle
      // so the scatter reads as a body coming apart rather than a shell.
      const bx = (rng.next() * 2 - 1) * o.extent.x;
      const by = ((rng.next() + rng.next()) - 1) * o.extent.y;
      const bz = (rng.next() * 2 - 1) * o.extent.z;
      const p3 = slot * 3;
      this.pos[p3] = o.origin.x + bx;
      this.pos[p3 + 1] = o.origin.y + by;
      this.pos[p3 + 2] = o.origin.z + bz;

      // Velocity: outward from the centre, plus the blow.
      _v.set(bx, by * 0.6 + o.extent.y * 0.22, bz);
      if (_v.lengthSq() < 1e-8) _v.set(rng.range(-1, 1), 1, rng.range(-1, 1));
      _v.normalize();
      const speed = PIGMENT.speed * force * (1 + rng.gauss() * PIGMENT.speedJitter);
      this.vel[p3] = _v.x * speed;
      this.vel[p3 + 1] = _v.y * speed + PIGMENT.speed * PIGMENT.loft * force;
      this.vel[p3 + 2] = _v.z * speed;
      if (o.impulse) {
        const g = PIGMENT.impulseGain * force * (0.4 + rng.next());
        this.vel[p3] += o.impulse.x * g;
        this.vel[p3 + 1] += o.impulse.y * g;
        this.vel[p3 + 2] += o.impulse.z * g;
      }

      // Orientation and tumble.
      _q.set(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize();
      const q4 = slot * 4;
      this.quat[q4] = _q.x;
      this.quat[q4 + 1] = _q.y;
      this.quat[q4 + 2] = _q.z;
      this.quat[q4 + 3] = _q.w;
      const sp = PIGMENT.spin * (1 + rng.gauss() * PIGMENT.spinJitter);
      this.spin[p3] = rng.range(-1, 1) * sp;
      this.spin[p3 + 1] = rng.range(-1, 1) * sp;
      this.spin[p3 + 2] = rng.range(-1, 1) * sp;

      // Size and silhouette: chips are not all one chip. The aspect ratio and
      // the in-plane roll together mean no two chips in a burst are the same
      // quadrilateral.
      const base = PIGMENT.chipSize * (1 + rng.gauss() * PIGMENT.chipSizeJitter);
      const s2 = slot * 2;
      this.size[s2] = Math.max(0.008, base);
      this.size[s2 + 1] = Math.max(0.008, base * (0.55 + rng.next() * 0.7));
      this.roll[slot] = rng.next() * Math.PI * 2;

      // Colour: a weighted draw across the pigment's four bands, so a scatter
      // has the same internal value range the painted surface does.
      const bandIndex = this.pickBand(rng);
      const c = pigmentColour(pig, bandIndex);
      this.col[p3] = c.r;
      this.col[p3 + 1] = c.g;
      this.col[p3 + 2] = c.b;

      this.age[slot] = 0;
      this.restAt[slot] = 0;
      this.state[slot] = STATE_FLYING;
    }
    return spawned;
  }

  private pickBand(rng: Rng): 0 | 1 | 2 | 3 {
    const w = PIGMENT.bandWeights;
    let r = rng.next() * (w[0] + w[1] + w[2] + w[3]);
    for (let i = 0; i < 4; i++) {
      r -= w[i];
      if (r <= 0) return i as 0 | 1 | 2 | 3;
    }
    return 1;
  }

  /**
   * Throw a whole unit's worth of pigment, sized from its bounding box and
   * coloured from its own dispersal pigment.
   */
  burstUnit(unit: UnitInstance, impulse: THREE.Vector3 | null, seed: string | number): number {
    const size = unit.meta.size;
    const volume = size[0] * size[1] * size[2];
    const count = Math.min(
      PIGMENT.chipsMax,
      Math.round(PIGMENT.chipsBase + PIGMENT.chipsPerVolume * Math.cbrt(Math.max(volume, 1e-4))),
    );
    _p.setFromMatrixPosition(unit.root.matrixWorld);
    _p.y += size[1] * 0.42;
    _s.set(size[0] * 0.34, size[1] * 0.36, size[2] * 0.34);
    return this.burst({
      origin: _p,
      extent: _s,
      pigment: unit.meta.dispersal,
      count,
      impulse: impulse ?? undefined,
      seed,
    });
  }

  private alloc(): number {
    if (this.live >= this.capacity) return -1;
    const slot = this.live++;
    return slot;
  }

  /** Swap-remove: live chips stay dense in the low slots. */
  private free(slot: number): void {
    const last = this.live - 1;
    if (slot !== last) {
      this.copySlot(last, slot);
    }
    this.state[last] = STATE_FREE;
    this.live = last;
  }

  private copySlot(from: number, to: number): void {
    const f3 = from * 3;
    const t3 = to * 3;
    for (let i = 0; i < 3; i++) {
      this.pos[t3 + i] = this.pos[f3 + i];
      this.vel[t3 + i] = this.vel[f3 + i];
      this.spin[t3 + i] = this.spin[f3 + i];
      this.col[t3 + i] = this.col[f3 + i];
    }
    const f4 = from * 4;
    const t4 = to * 4;
    for (let i = 0; i < 4; i++) this.quat[t4 + i] = this.quat[f4 + i];
    this.size[to * 2] = this.size[from * 2];
    this.size[to * 2 + 1] = this.size[from * 2 + 1];
    this.roll[to] = this.roll[from];
    this.age[to] = this.age[from];
    this.restAt[to] = this.restAt[from];
    this.state[to] = this.state[from];
  }

  // -------------------------------------------------------------------------
  // The 砲's stone
  // -------------------------------------------------------------------------

  /**
   * Launch a stone from `from` to `to` on a visible arc. The apex is a fixed
   * multiple of the straight-line distance's height, so a long shot arcs higher
   * than a short one and both stay legible against the board.
   */
  launch(
    from: THREE.Vector3,
    to: THREE.Vector3,
    seconds: number,
    onImpact: (at: THREE.Vector3) => void,
  ): void {
    this.stoneFrom.copy(from);
    this.stoneTo.copy(to);
    this.stoneDuration = Math.max(0.05, seconds);
    this.stoneT = 0;
    this.stoneArc = Math.max(0.4, from.distanceTo(to) * 0.34) * PROJECTILE.arcScale;
    this.stoneActive = true;
    this.stoneSpin = 0;
    this.stone.visible = true;
    this.stone.position.copy(from);
    this.onImpact = onImpact;
  }

  get projectileActive(): boolean {
    return this.stoneActive;
  }

  /** Where the stone is right now. Used by the choreographer for the burst. */
  projectilePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.stone.position);
  }

  private updateProjectile(dt: number): void {
    if (!this.stoneActive) return;
    this.stoneT += dt;
    const u = Math.min(1, this.stoneT / this.stoneDuration);
    this.stone.position.lerpVectors(this.stoneFrom, this.stoneTo, u);
    // A parabola over the chord: zero at both ends, apex at the middle.
    this.stone.position.y += this.stoneArc * 4 * u * (1 - u);
    this.stoneSpin += PROJECTILE.spin * dt;
    this.stone.rotation.set(this.stoneSpin, this.stoneSpin * 0.61, this.stoneSpin * 0.37);
    if (u >= 1) {
      this.stoneActive = false;
      this.stone.visible = false;
      const cb = this.onImpact;
      this.onImpact = null;
      if (cb) cb(this.stone.position);
    }
  }

  // -------------------------------------------------------------------------
  // Integration
  // -------------------------------------------------------------------------

  update(dt: number): void {
    this.updateProjectile(dt);
    if (this.live === 0) {
      if (this.mesh.count !== 0) this.mesh.count = 0;
      return;
    }
    const silk = pigmentColour(SCENE.silkGround, 1);

    for (let i = this.live - 1; i >= 0; i--) {
      const p3 = i * 3;
      const q4 = i * 4;
      this.age[i] += dt;

      if (this.state[i] === STATE_FLYING) {
        // Quadratic drag: a flake sheds its launch speed almost at once and
        // then falls slowly, which is the flutter that separates pigment from
        // confetti.
        const vx = this.vel[p3];
        const vy = this.vel[p3 + 1];
        const vz = this.vel[p3 + 2];
        const speed = Math.hypot(vx, vy, vz);
        const k = PIGMENT.drag * speed;
        this.vel[p3] = vx - vx * k * dt;
        this.vel[p3 + 1] = vy - vy * k * dt - PIGMENT.gravity * dt;
        this.vel[p3 + 2] = vz - vz * k * dt;

        this.pos[p3] += this.vel[p3] * dt;
        this.pos[p3 + 1] += this.vel[p3 + 1] * dt;
        this.pos[p3 + 2] += this.vel[p3 + 2] * dt;

        // Tumble: quaternion integrated from angular velocity, renormalised.
        _q.set(this.quat[q4], this.quat[q4 + 1], this.quat[q4 + 2], this.quat[q4 + 3]);
        _qd.set(this.spin[p3] * dt * 0.5, this.spin[p3 + 1] * dt * 0.5, this.spin[p3 + 2] * dt * 0.5, 0);
        _qd.multiply(_q);
        _q.set(_q.x + _qd.x, _q.y + _qd.y, _q.z + _qd.z, _q.w + _qd.w).normalize();
        this.quat[q4] = _q.x;
        this.quat[q4 + 1] = _q.y;
        this.quat[q4 + 2] = _q.z;
        this.quat[q4 + 3] = _q.w;
        const damp = Math.exp(-PIGMENT.spinDamp * dt);
        this.spin[p3] *= damp;
        this.spin[p3 + 1] *= damp;
        this.spin[p3 + 2] *= damp;

        // The board. A chip does not stop the instant it touches it: it takes a
        // low bounce, skids, takes a smaller one, and lies down. Each of those
        // three is a separate line here and the eye reads all three.
        const floor = (this.ground ? this.ground(this.pos[p3], this.pos[p3 + 2]) : 0) + this.size[i * 2 + 1] * 0.22;
        if (this.pos[p3 + 1] <= floor) {
          this.pos[p3 + 1] = floor;
          const impact = -this.vel[p3 + 1];
          if (impact > 0) this.vel[p3 + 1] = impact * PIGMENT.bounce;
          // Tangential loss scales with how hard it came down: a chip dropping
          // almost vertically loses nearly all of its slide, one arriving flat
          // keeps most of it and skids.
          const bite = PIGMENT.friction + (1 - PIGMENT.friction) * Math.exp(-4 * Math.max(0, impact));
          this.vel[p3] *= bite;
          this.vel[p3 + 2] *= bite;
          this.spin[p3] *= 0.5;
          this.spin[p3 + 1] *= 0.5;
          this.spin[p3 + 2] *= 0.5;
          // Sliding along the board between bounces: friction that acts over
          // time, not only on the instant of contact.
          const skid = Math.exp(-PIGMENT.slide * dt);
          this.vel[p3] *= skid;
          this.vel[p3 + 2] *= skid;
          const rest = Math.hypot(this.vel[p3], this.vel[p3 + 1], this.vel[p3 + 2]);
          if (rest < PIGMENT.restSpeed) {
            // Settle flat: a chip at rest lies on the silk, it does not stand
            // on edge. Its face turns to the sky and it keeps a compass bearing
            // and a degree or two of tip, both taken from the residual spin, so
            // a drift of laid chips is not a drift of aligned chips.
            //
            // The bearing is a yaw about world **up**. It used to be a rotation
            // about world Z, which is horizontal: every chip in the field was
            // tipped up out of the board's plane by whatever its leftover
            // angular velocity happened to be, and a good half of them stood on
            // edge. A chip at rest is very nearly coplanar with the silk.
            this.state[i] = STATE_RESTING;
            this.restAt[i] = this.age[i];
            this.vel[p3] = 0;
            this.vel[p3 + 1] = 0;
            this.vel[p3 + 2] = 0;
            // Half of them land face down, which is the honest outcome of a
            // tumble and gives the settled field its second value. Drawn from
            // the roll rather than from the spin, so which way up a chip lands
            // is independent of which way it came to rest leaning.
            const faceUp = this.roll[i] < Math.PI;
            _q.setFromAxisAngle(_v.set(1, 0, 0), faceUp ? -Math.PI / 2 : Math.PI / 2);
            _qd.setFromAxisAngle(_v.set(0, 1, 0), this.spin[p3 + 1] * 3.1);
            _q.premultiply(_qd);
            // The tip, one small angle about each horizontal axis. Folded
            // through a sine rather than clamped: the residual spins are large
            // compared with a four-degree tilt, so a clamp would have pinned
            // almost every chip to the limit and left the field with four
            // discrete attitudes instead of a spread of them.
            const tilt = PIGMENT.chipRestTilt;
            _qd.setFromAxisAngle(_v.set(1, 0, 0), tilt * Math.sin(this.spin[p3] * 7.3));
            _q.premultiply(_qd);
            _qd.setFromAxisAngle(_v.set(0, 0, 1), tilt * Math.sin(this.spin[p3 + 2] * 5.9));
            _q.premultiply(_qd);
            this.quat[q4] = _q.x;
            this.quat[q4 + 1] = _q.y;
            this.quat[q4 + 2] = _q.z;
            this.quat[q4 + 3] = _q.w;
            // Lie *on* the silk. The collision height used while a chip is
            // tumbling is a tumbling chip's radius; one that has stopped only
            // needs its own half-thickness, plus enough to keep the corner the
            // tilt raised from doing all the work of holding it up. Two-thirds
            // of the worst corner is deliberate: the average chip is dead flush,
            // a few stand a hair proud, and a few bed a hair into the weave —
            // which is what a flake of pigment on silk actually does. Anything
            // more and the whole field hovers over the board.
            const reach = Math.max(this.size[i * 2], this.size[i * 2 + 1]);
            this.pos[p3 + 1] =
              (this.ground ? this.ground(this.pos[p3], this.pos[p3 + 2]) : 0) +
              this.size[i * 2] * PIGMENT.chipThickness * 0.5 +
              reach * Math.sin(tilt) * 0.7;
          }
        }
      }

      // Fade: the chip converges on the silk's own colour and shrinks into it.
      let fade = 1;
      if (this.state[i] === STATE_RESTING) {
        const since = this.age[i] - this.restAt[i] - PIGMENT.linger;
        if (since > 0) fade = 1 - Math.min(1, since / PIGMENT.fade);
      }
      if (fade <= 0.001 || this.age[i] > PIGMENT.maxLife) {
        this.free(i);
        continue;
      }

      // --- write the instance ---------------------------------------------
      _p.set(this.pos[p3], this.pos[p3 + 1], this.pos[p3 + 2]);
      _q.set(this.quat[q4], this.quat[q4 + 1], this.quat[q4 + 2], this.quat[q4 + 3]);
      const shrink = 0.35 + 0.65 * fade;
      // Z scales with the chip's *width*, not with 1: the geometry carries its
      // thickness and its fold as fractions of a half-width, and leaving z at
      // unit scale is what inflated a flake three millimetres thick into a
      // spike three times its own width tall.
      _s.set(this.size[i * 2] * shrink, this.size[i * 2 + 1] * shrink, this.size[i * 2] * shrink);
      _m.compose(_p, _q, _s);
      // …and the in-plane roll goes on the right, so the anisotropic scale
      // above acts on an already-rotated outline. The chip stays flat: z is the
      // axis it turns about.
      _m.multiply(_roll.makeRotationZ(this.roll[i]));
      this.mesh.setMatrixAt(i, _m);
      _c.setRGB(this.col[p3], this.col[p3 + 1], this.col[p3 + 2]);
      if (fade < 1) {
        _c2.copy(silk);
        _c.lerp(_c2, 1 - fade);
      }
      this.mesh.setColorAt(i, _c);
    }

    this.mesh.count = this.live;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Drop everything immediately. Used by `abort()` and by match reset. */
  reset(): void {
    this.live = 0;
    this.mesh.count = 0;
    this.stoneActive = false;
    this.stone.visible = false;
    this.onImpact = null;
  }

  dispose(): void {
    this.reset();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.stone.geometry.dispose();
    (this.stone.material as THREE.Material).dispose();
    this.group.removeFromParent();
  }
}

export function createPigmentField(opts: PigmentFieldOptions = {}): PigmentField {
  return new PigmentField(opts);
}
