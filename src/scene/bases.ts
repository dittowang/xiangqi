/**
 * Piece bases: the low plinth every figure stands on, with its 篆書 seal-script
 * character incised into the top face.
 *
 * Two things are going on in this file.
 *
 * **The incision.** `inciseOutline()` takes closed glyph contours and cuts them
 * *into* a flat face: it triangulates the face with the strokes removed, drops a
 * floor a millimetre or two down, and runs a vertical wall around every edge of
 * the cut. That wall is the whole point — it is what puts a shadow on one side
 * of every stroke and a lit edge on the other, which is how 陰刻 reads. A glyph
 * painted onto a texture would read as a decal; this reads as carved.
 *
 * The character is deliberately *subordinate*. It sits inside a 0.34-unit box on
 * a 0.69-unit disc, unfilled, so it identifies a piece you are unsure about and
 * otherwise stays quiet under the figure's feet. The figure is the primary
 * identifier; this is the fallback.
 *
 * **The instancing.** All thirty-two bases are drawn as fourteen
 * `InstancedMesh`es — one per (side, type) — because thirty-two individual
 * meshes would eat an eighth of the project's draw-call budget for a prop that
 * is never the subject of a shot. The board owns this manager so that
 * `Board.heightAt()` can include the bases: a figure walking onto a square with
 * a base on it genuinely steps up, and the animator's foot IK sees that.
 *
 * The glyph outlines come from `@ui/seal.ts`, which another author owns. We
 * never import it — the provider arrives by injection and the base degrades to a
 * plain unmarked plinth when it is absent.
 */

import * as THREE from 'three';
import type { GongbiMaterials } from '@core/contracts.ts';
import { PieceType, Side } from '@core/types.ts';
import { fileOf, rankOf, worldX, worldZ } from '@core/coords.ts';
import { ARMY } from '@core/palette.ts';
import {
  MeshBuilder,
  disc,
  faceNormal,
  latheProfile,
  planarUV,
  pointInContour,
  signedArea,
  toVector2s,
  type P3,
  type ProfilePoint,
} from './geometry.ts';

// ---------------------------------------------------------------------------
// Glyph outlines — the interface we code against, not the one we import
// ---------------------------------------------------------------------------

/**
 * A seal-script glyph as closed polygons.
 *
 * Coordinates are arbitrary and get normalised into the base's glyph box, so a
 * provider may hand us em-square units, unit-box units or anything else. `y` is
 * up. Contours are closed implicitly — do not repeat the first point.
 */
export interface SealOutline {
  /** Closed contours, each flat `[x0, y0, x1, y1, ...]`. */
  contours: number[][];
  /**
   * Optional explicit hole flags, parallel to `contours`. When absent, holes are
   * inferred by containment depth, which is the convention every outline format
   * in existence already follows.
   */
  holes?: boolean[];
}

export type SealProvider = (side: Side, type: PieceType) => SealOutline | null | undefined;

/**
 * Tolerantly convert whatever `@ui/seal.ts` returns from `getSealGlyph()` into a
 * `SealOutline`. The integration layer wires this in one line:
 *
 * ```ts
 * const seal: SealProvider = (s, t) => adaptGlyphPath(getSealGlyph(s, t));
 * ```
 *
 * Handles the four plausible shapes: a bare array of flat contours, a bare array
 * of `{x, y}` point arrays, `{ contours }` in either of those forms, and
 * `{ paths }` / `{ outlines }` aliases. Anything else yields `null`, which means
 * "blank base" rather than "throw during scene construction".
 */
export function adaptGlyphPath(raw: unknown): SealOutline | null {
  if (!raw) return null;
  const holder = raw as Record<string, unknown>;
  const listLike =
    (Array.isArray(raw) && raw) ||
    (Array.isArray(holder.contours) && holder.contours) ||
    (Array.isArray(holder.paths) && holder.paths) ||
    (Array.isArray(holder.outlines) && holder.outlines) ||
    null;
  if (!listLike) return null;

  const contours: number[][] = [];
  for (const entry of listLike as unknown[]) {
    if (!Array.isArray(entry) || entry.length === 0) continue;
    if (typeof entry[0] === 'number') {
      const flat = entry as number[];
      if (flat.length >= 6) contours.push(flat.slice());
    } else if (typeof entry[0] === 'object' && entry[0] !== null) {
      const pts = entry as { x?: number; y?: number }[];
      const flat: number[] = [];
      for (const p of pts) {
        if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
        flat.push(p.x, p.y);
      }
      if (flat.length >= 6) contours.push(flat);
    }
  }
  if (contours.length === 0) return null;
  const holes = Array.isArray(holder.holes) ? (holder.holes as boolean[]).slice() : undefined;
  return holes ? { contours, holes } : { contours };
}

// ---------------------------------------------------------------------------
// Incision
// ---------------------------------------------------------------------------

/** How the glyph plane is laid onto world XZ. */
export interface GlyphPlacement {
  /** Centre of the glyph box, world. */
  cx: number;
  cz: number;
  /** Height of the face being cut into. */
  y: number;
  /** Depth of the cut, world units. */
  depth: number;
  /** Fit the glyph's larger dimension into this many world units. */
  fit: number;
  /**
   * Yaw of the glyph's "up" direction, radians. 0 puts glyph-up along world −Z,
   * i.e. the character reads from a camera sitting over +Z (Red's seat).
   */
  yaw: number;
}

interface PreparedContour {
  /** Flat glyph-space points, already normalised and oriented. */
  flat: number[];
  hole: boolean;
  /** Index of the solid this counter sits inside, or −1. */
  parent: number;
}

/** Normalise: fit to the glyph box, classify holes, fix orientations. */
function prepare(outline: SealOutline, fit: number): PreparedContour[] {
  const raw = outline.contours.filter((c) => c.length >= 6);
  if (raw.length === 0) return [];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of raw) {
    for (let i = 0; i < c.length; i += 2) {
      if (c[i] < minX) minX = c[i];
      if (c[i] > maxX) maxX = c[i];
      if (c[i + 1] < minY) minY = c[i + 1];
      if (c[i + 1] > maxY) maxY = c[i + 1];
    }
  }
  const w = Math.max(maxX - minX, 1e-6);
  const h = Math.max(maxY - minY, 1e-6);
  const s = fit / Math.max(w, h);
  const ox = (minX + maxX) * 0.5;
  const oy = (minY + maxY) * 0.5;

  const scaled = raw.map((c) => {
    const out = new Array<number>(c.length);
    for (let i = 0; i < c.length; i += 2) {
      out[i] = (c[i] - ox) * s;
      out[i + 1] = (c[i + 1] - oy) * s;
    }
    return out;
  });

  // Hole classification. Explicit flags win; otherwise a contour is a hole when
  // it is enclosed by an odd number of the others.
  const explicit = outline.holes;
  const prepared: PreparedContour[] = scaled.map((flat, i) => {
    let hole: boolean;
    if (explicit && typeof explicit[i] === 'boolean') {
      hole = explicit[i];
    } else {
      let depth = 0;
      for (let j = 0; j < scaled.length; j++) {
        if (j === i) continue;
        if (pointInContour(scaled[j], flat[0], flat[1])) depth++;
      }
      hole = depth % 2 === 1;
    }
    return { flat, hole, parent: -1 };
  });

  // Solids run CCW, counters run CW. One inward-normal formula then serves both.
  for (const p of prepared) {
    const a = signedArea(p.flat);
    const wantPositive = !p.hole;
    if (a < 0 === wantPositive) reverseContour(p.flat);
  }

  // Attach each counter to its innermost enclosing solid.
  for (let i = 0; i < prepared.length; i++) {
    if (!prepared[i].hole) continue;
    let best = -1;
    let bestArea = Infinity;
    for (let j = 0; j < prepared.length; j++) {
      if (j === i || prepared[j].hole) continue;
      if (!pointInContour(prepared[j].flat, prepared[i].flat[0], prepared[i].flat[1])) continue;
      const a = Math.abs(signedArea(prepared[j].flat));
      if (a < bestArea) {
        bestArea = a;
        best = j;
      }
    }
    prepared[i].parent = best;
  }
  return prepared;
}

function reverseContour(flat: number[]): void {
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < j; i++, j--) {
    const xi = flat[i * 2];
    const yi = flat[i * 2 + 1];
    flat[i * 2] = flat[j * 2];
    flat[i * 2 + 1] = flat[j * 2 + 1];
    flat[j * 2] = xi;
    flat[j * 2 + 1] = yi;
  }
}

/**
 * Cut `outline` into the horizontal face described by `place`, emitting the
 * remaining face, the sunken floor and the walls between them.
 *
 * `faceContour` bounds the face being cut (the base's top disc, or a rectangular
 * panel on the river banking). It is given in the same glyph-local space the
 * outline is normalised into, so pass it *after* deciding `fit`.
 */
export function inciseOutline(
  b: MeshBuilder,
  outline: SealOutline | null,
  faceContour: readonly number[],
  place: GlyphPlacement,
): void {
  // Glyph-local (gx, gy) -> world (x, z). `up` is glyph +y, `right` is glyph +x.
  const ux = Math.sin(place.yaw);
  const uz = -Math.cos(place.yaw);
  const rx = Math.cos(place.yaw);
  const rz = Math.sin(place.yaw);
  const toWorld = (gx: number, gy: number, y: number): P3 => [
    place.cx + gx * rx + gy * ux,
    y,
    place.cz + gx * rz + gy * uz,
  ];

  const prepared = outline ? prepare(outline, place.fit) : [];
  const solids = prepared.filter((p) => !p.hole);
  const face = Array.from(faceContour);
  if (signedArea(face) < 0) reverseContour(face);

  const up: P3 = [0, 1, 0];
  const yTop = place.y;
  const yFloor = place.y - place.depth;

  /** Triangulate one shape and emit it flat at `y`, forced to face +Y. */
  const emitFlat = (contour: number[], holes: number[][], y: number) => {
    const c2 = toVector2s(contour);
    const h2 = holes.map(toVector2s);
    let tris: number[][];
    try {
      tris = THREE.ShapeUtils.triangulateShape(c2, h2);
    } catch {
      return; // A malformed outline must not take the whole scene down.
    }
    const all = c2.concat(...h2);
    for (const t of tris) {
      const a = all[t[0]];
      const bb = all[t[1]];
      const cc = all[t[2]];
      let A = toWorld(a.x, a.y, y);
      let B = toWorld(bb.x, bb.y, y);
      const C = toWorld(cc.x, cc.y, y);
      // The glyph->world map is a reflection, so triangle orientation can land
      // either way. Normalise to up-facing rather than trusting the triangulator.
      if (faceNormal(A, B, C)[1] < 0) {
        const t0 = A;
        A = B;
        B = t0;
      }
      b.tri(A, B, C, up, up, up, planarUV(A), planarUV(B), planarUV(C));
    }
  };

  // 1. The face itself, with every stroke removed.
  emitFlat(
    face,
    solids.map((s) => s.flat),
    yTop,
  );

  // 2. Counters stay at face level — the enclosed island inside a 口 is material,
  //    not void.
  for (const p of prepared) {
    if (!p.hole) continue;
    const island = p.flat.slice();
    if (signedArea(island) < 0) reverseContour(island);
    emitFlat(island, [], yTop);
  }

  // 3. The floor of the cut, one shape per stroke with its counters punched out.
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    if (p.hole) continue;
    const counters = prepared
      .filter((q) => q.hole && q.parent === i)
      .map((q) => {
        const c = q.flat.slice();
        if (signedArea(c) < 0) reverseContour(c); // triangulateShape wants CCW holes
        return c;
      });
    emitFlat(p.flat, counters, yFloor);
  }

  // 4. Walls. Solids run CCW and counters CW, so "left of travel" is the wall's
  //    facing direction in both cases.
  for (const p of prepared) {
    const n = p.flat.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const gx0 = p.flat[i * 2];
      const gy0 = p.flat[i * 2 + 1];
      const gx1 = p.flat[j * 2];
      const gy1 = p.flat[j * 2 + 1];
      const dx = gx1 - gx0;
      const dy = gy1 - gy0;
      const dl = Math.hypot(dx, dy);
      if (dl < 1e-9) continue;
      // Interior of a CCW contour lies to the left of travel.
      const inGx = -dy / dl;
      const inGy = dx / dl;
      const nWorld: P3 = [inGx * rx + inGy * ux, 0, inGx * rz + inGy * uz];

      const A = toWorld(gx0, gy0, yTop);
      const B = toWorld(gx1, gy1, yTop);
      const A2 = toWorld(gx0, gy0, yFloor);
      const B2 = toWorld(gx1, gy1, yFloor);
      const test = faceNormal(A, A2, B2);
      const aligned = test[0] * nWorld[0] + test[2] * nWorld[2] > 0;
      if (aligned) {
        b.quad(A, A2, B2, B, nWorld, nWorld, nWorld, nWorld, planarUV(A), planarUV(A2), planarUV(B2), planarUV(B));
      } else {
        b.quad(A, B, B2, A2, nWorld, nWorld, nWorld, nWorld, planarUV(A), planarUV(B), planarUV(B2), planarUV(A2));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The plinth
// ---------------------------------------------------------------------------

/** Radius of the flat top face the glyph is cut into. */
export const BASE_FACE_RADIUS = 0.26;
/** Outer radius where the base meets the board. */
export const BASE_RADIUS = 0.345;
/** Height of the top face above the board surface. */
export const BASE_TOP_Y = 0.046;
/** Depth of the glyph incision. */
export const BASE_GLYPH_DEPTH = 0.0085;
/** Glyph box: the character fits inside this square, centred on the base. */
export const BASE_GLYPH_FIT = 0.34;

/**
 * Side wall of the plinth, from the edge of the top face down to the board.
 * A quick arris, a near-vertical face and a splayed foot: the profile of a
 * turned wooden disc, not a cylinder.
 */
const BASE_SIDE_PROFILE: readonly ProfilePoint[] = [
  { u: BASE_FACE_RADIUS, y: BASE_TOP_Y, hard: true },
  { u: 0.3, y: 0.04, hard: true },
  { u: 0.316, y: 0.014, hard: true },
  { u: BASE_RADIUS, y: 0.0, hard: true },
];

const BASE_RADIAL_SEGMENTS = 48;

/** Height of the plinth's surface at radial distance `r` from its centre. */
export function baseProfileAt(r: number): number {
  if (r <= BASE_FACE_RADIUS) return BASE_TOP_Y;
  if (r >= BASE_RADIUS) return 0;
  for (let i = 1; i < BASE_SIDE_PROFILE.length; i++) {
    const b = BASE_SIDE_PROFILE[i];
    if (r <= b.u) {
      const a = BASE_SIDE_PROFILE[i - 1];
      const t = (r - a.u) / Math.max(b.u - a.u, 1e-9);
      return a.y + (b.y - a.y) * t;
    }
  }
  return 0;
}

function faceDisc(radius: number, segments: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push(Math.cos(a) * radius, Math.sin(a) * radius);
  }
  return out;
}

/** Build one plinth geometry, origin at the base's centre, board surface at y=0. */
export function buildBaseGeometry(
  side: Side,
  type: PieceType,
  seal: SealProvider | undefined,
  ownerFacing: boolean,
): THREE.BufferGeometry {
  const b = new MeshBuilder();
  latheProfile(b, BASE_SIDE_PROFILE, BASE_RADIAL_SEGMENTS, 0, 0, 0);

  const outline = seal ? (seal(side, type) ?? null) : null;
  // A traditional set orients each army's characters toward its own player.
  // Red sits at +Z, Black at −Z.
  const yaw = ownerFacing && side === Side.Black ? Math.PI : 0;

  if (outline) {
    inciseOutline(b, outline, faceDisc(BASE_FACE_RADIUS, BASE_RADIAL_SEGMENTS), {
      cx: 0,
      cz: 0,
      y: BASE_TOP_Y,
      depth: BASE_GLYPH_DEPTH,
      fit: BASE_GLYPH_FIT,
      yaw,
    });
  } else {
    // No glyph provider yet: a plain unmarked plinth, as instructed.
    disc(b, BASE_FACE_RADIUS, BASE_TOP_Y, BASE_RADIAL_SEGMENTS);
  }

  return b.build(`scene/base/${side}/${type}`);
}

// ---------------------------------------------------------------------------
// Instanced manager
// ---------------------------------------------------------------------------

/** How many of each type one side fields at the start of a game. */
const PIECE_COUNT: Record<PieceType, number> = {
  [PieceType.None]: 0,
  [PieceType.General]: 1,
  [PieceType.Advisor]: 2,
  [PieceType.Elephant]: 2,
  [PieceType.Horse]: 2,
  [PieceType.Chariot]: 2,
  [PieceType.Cannon]: 2,
  [PieceType.Soldier]: 5,
};

interface BaseSlot {
  key: number;
  slot: number;
  x: number;
  z: number;
  yaw: number;
  scale: number;
  live: boolean;
}

interface BaseBucket {
  mesh: THREE.InstancedMesh;
  used: boolean[];
}

// Module-level scratch: `setPosition` runs on every frame of every slide.
const _mat = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _axisY = new THREE.Vector3(0, 1, 0);

export interface PieceBasesOptions {
  materials: GongbiMaterials;
  /** Seal-script outlines. Absent means every base is blank. */
  seal?: SealProvider;
  /** Board surface height, so bases follow the silk's sag. */
  groundAt: (x: number, z: number) => number;
  /** Orient each army's glyphs toward its own seat. Default true. */
  ownerFacing?: boolean;
}

export class PieceBases {
  readonly group = new THREE.Group();
  /** Total triangles across all base geometries (not multiplied by instances). */
  triangles = 0;

  private readonly buckets = new Map<number, BaseBucket>();
  private readonly entries = new Map<number, BaseSlot>();
  private readonly geometries: THREE.BufferGeometry[] = [];
  /** Compact list of live entries, so `topAt` is a short linear scan. */
  private readonly live: BaseSlot[] = [];
  private readonly opts: PieceBasesOptions;

  constructor(opts: PieceBasesOptions) {
    this.opts = opts;
    this.group.name = 'scene/bases';
  }

  private bucketFor(side: Side, type: PieceType): BaseBucket {
    const key = (side << 3) | type;
    const hit = this.buckets.get(key);
    if (hit) return hit;

    const geo = buildBaseGeometry(side, type, this.opts.seal, this.opts.ownerFacing !== false);
    this.geometries.push(geo);
    this.triangles += (geo.getAttribute('position')?.count ?? 0) / 3;

    // Han bases are ochre timber, Chu bases black lacquer: the same read as the
    // armies, one rung quieter so the figures stay the subject.
    const mat =
      side === Side.Red
        ? this.opts.materials.get({ cls: 'timber', pigment: ARMY[0].leather })
        : this.opts.materials.get({ cls: 'lacquer', pigment: ARMY[1].lacquer });

    const capacity = Math.max(1, PIECE_COUNT[type]);
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.name = `scene/bases/${side}/${type}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = capacity;
    // Park every slot out of sight until it is claimed.
    for (let i = 0; i < capacity; i++) {
      _mat.makeScale(0, 0, 0);
      mesh.setMatrixAt(i, _mat);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);

    const bucket: BaseBucket = { mesh, used: new Array(capacity).fill(false) };
    this.buckets.set(key, bucket);
    return bucket;
  }

  /** Claim a base for piece `id`. Re-adding an id moves it to the new type. */
  add(id: number, side: Side, type: PieceType): void {
    this.remove(id);
    const key = (side << 3) | type;
    const bucket = this.bucketFor(side, type);
    let slot = bucket.used.indexOf(false);
    if (slot < 0) {
      // More of a type than a standard game fields (a test position, or a
      // future promotion rule). Grow rather than silently dropping the base.
      slot = this.grow(bucket);
    }
    bucket.used[slot] = true;
    const entry: BaseSlot = { key, slot, x: 0, z: 0, yaw: 0, scale: 1, live: true };
    this.entries.set(id, entry);
    this.live.push(entry);
    this.write(entry);
  }

  private grow(bucket: BaseBucket): number {
    const old = bucket.mesh;
    const capacity = old.count + 2;
    const next = new THREE.InstancedMesh(old.geometry, old.material, capacity);
    next.name = old.name;
    next.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    next.castShadow = true;
    next.receiveShadow = true;
    next.frustumCulled = false;
    next.count = capacity;
    for (let i = 0; i < capacity; i++) {
      if (i < old.count) old.getMatrixAt(i, _mat);
      else _mat.makeScale(0, 0, 0);
      next.setMatrixAt(i, _mat);
    }
    next.instanceMatrix.needsUpdate = true;
    this.group.remove(old);
    old.dispose();
    this.group.add(next);
    bucket.mesh = next;
    const slot = bucket.used.length;
    while (bucket.used.length < capacity) bucket.used.push(false);
    return slot;
  }

  remove(id: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const bucket = this.buckets.get(entry.key);
    if (bucket) {
      bucket.used[entry.slot] = false;
      _mat.makeScale(0, 0, 0);
      bucket.mesh.setMatrixAt(entry.slot, _mat);
      bucket.mesh.instanceMatrix.needsUpdate = true;
    }
    entry.live = false;
    const i = this.live.indexOf(entry);
    if (i >= 0) this.live.splice(i, 1);
    this.entries.delete(id);
  }

  setPosition(id: number, x: number, z: number, yaw = 0): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.x = x;
    e.z = z;
    e.yaw = yaw;
    this.write(e);
  }

  setSquare(id: number, square: number): void {
    this.setPosition(id, worldX(fileOf(square)), worldZ(rankOf(square)));
  }

  /** 0 hides the base; the capture choreography scales it out rather than popping. */
  setScale(id: number, s: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.scale = s;
    this.write(e);
  }

  private write(e: BaseSlot): void {
    const bucket = this.buckets.get(e.key);
    if (!bucket) return;
    _pos.set(e.x, this.opts.groundAt(e.x, e.z), e.z);
    _quat.setFromAxisAngle(_axisY, e.yaw);
    _scale.set(e.scale, e.scale, e.scale);
    _mat.compose(_pos, _quat, _scale);
    bucket.mesh.setMatrixAt(e.slot, _mat);
    bucket.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Height of the tallest base surface over (x, z), or `-Infinity` when no base
   * covers the point. Linear over at most thirty-two entries with a cheap
   * rejection test — this is called per foot per frame and allocates nothing.
   */
  topAt(x: number, z: number): number {
    let best = -Infinity;
    for (let i = 0; i < this.live.length; i++) {
      const e = this.live[i];
      if (e.scale <= 0.001) continue;
      const dx = x - e.x;
      if (dx > BASE_RADIUS || dx < -BASE_RADIUS) continue;
      const dz = z - e.z;
      if (dz > BASE_RADIUS || dz < -BASE_RADIUS) continue;
      const r = Math.hypot(dx, dz);
      if (r > BASE_RADIUS) continue;
      const h = this.opts.groundAt(e.x, e.z) + baseProfileAt(r) * e.scale;
      if (h > best) best = h;
    }
    return best;
  }

  /** Top height of the plinth under piece `id`, for placing a figure's feet. */
  topOf(id: number): number {
    const e = this.entries.get(id);
    if (!e) return 0;
    return this.opts.groundAt(e.x, e.z) + BASE_TOP_Y * e.scale;
  }

  clear(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }

  dispose(): void {
    for (const bucket of this.buckets.values()) {
      this.group.remove(bucket.mesh);
      bucket.mesh.dispose();
    }
    for (const g of this.geometries) g.dispose();
    this.buckets.clear();
    this.entries.clear();
    this.geometries.length = 0;
    this.live.length = 0;
  }
}
