/**
 * Hard-edge primitive construction.
 *
 * Gongbi is drawn with a brush that never lifts mid-contour, so a form either
 * has a clean boundary or it has none. Every builder in here therefore emits
 * **non-indexed, flat-shaded** triangles: each face carries its own normal, and
 * a ring-to-ring transition is a crease by construction rather than by a
 * smoothing-group flag we would have to police later. The cost is three times
 * the vertices for the same triangle count, which is the right trade when the
 * budget is stated in triangles and the look depends on the crease.
 *
 * Two conventions hold throughout:
 *   - A *ring* is a closed loop of points in the XZ plane at some Y, ordered by
 *     increasing angle. `strip()` and `loft()` assume that ordering to get the
 *     winding right; reverse a ring and you get an inside-out solid.
 *   - Everything is authored in rig space: +Y up, -Z forward, feet at y = 0.
 */

import * as THREE from 'three';
import type { V2, V3 } from './types.ts';

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const DEFAULT_UV: [V2, V2, V2] = [
  [0, 0],
  [1, 0],
  [1, 1],
];

export class MeshBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uvs: number[] = [];

  get triangles(): number {
    return this.pos.length / 9;
  }

  /**
   * One triangle with a computed flat normal. Degenerate triangles are dropped:
   * they contribute nothing to the render and they poison the smooth-normal
   * average the outline hull is pushed along.
   */
  tri(a: V3, b: V3, c: V3, ua?: V2, ub?: V2, uc?: V2): this {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(len > 1e-11)) return this;
    const inv = 1 / len;
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) this.nor.push(nx * inv, ny * inv, nz * inv);
    const [da, db, dc] = DEFAULT_UV;
    const t0 = ua ?? da;
    const t1 = ub ?? db;
    const t2 = uc ?? dc;
    this.uvs.push(t0[0], t0[1], t1[0], t1[1], t2[0], t2[1]);
    return this;
  }

  /** Planar quad, wound a-b-c-d. Split into two triangles sharing the a-c edge. */
  quad(a: V3, b: V3, c: V3, d: V3, ua?: V2, ub?: V2, uc?: V2, ud?: V2): this {
    this.tri(a, b, c, ua, ub, uc);
    this.tri(a, c, d, ua, uc, ud);
    return this;
  }

  /** Convex fan around `points[0]`. `reverse` flips the facing. */
  fan(points: V3[], reverse = false): this {
    const n = points.length;
    if (n < 3) return this;
    for (let i = 1; i < n - 1; i++) {
      if (reverse) this.tri(points[0], points[i + 1], points[i]);
      else this.tri(points[0], points[i], points[i + 1]);
    }
    return this;
  }

  /**
   * Quad band between two equal-length rings. `b` is expected to be the ring
   * further along the sweep (higher Y for a vertical loft); that is what makes
   * the emitted normals point outward.
   */
  strip(a: V3[], b: V3[], closed = true, v0 = 0, v1 = 1): this {
    const n = a.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % n;
      const u0 = i / n;
      const u1 = (i + 1) / n;
      this.quad(a[i], b[i], b[j], a[j], [u0, v0], [u0, v1], [u1, v1], [u1, v0]);
    }
    return this;
  }

  /** Triangulate an arbitrary (possibly concave) planar polygon given in XY. */
  polygonXY(poly: V2[], z: number, reverse = false): this {
    const contour = poly.map((p) => new THREE.Vector2(p[0], p[1]));
    const faces = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const f of faces) {
      const p0: V3 = [poly[f[0]][0], poly[f[0]][1], z];
      const p1: V3 = [poly[f[1]][0], poly[f[1]][1], z];
      const p2: V3 = [poly[f[2]][0], poly[f[2]][1], z];
      if (reverse) this.tri(p0, p2, p1);
      else this.tri(p0, p1, p2);
    }
    return this;
  }

  build(name = ''): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    if (name) g.name = name;
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Rings and lofts
// ---------------------------------------------------------------------------

export interface RingOpts {
  /** Radius across X. */
  rx: number;
  /** Radius across Z. Defaults to `rx`. */
  rz?: number;
  y?: number;
  /** Centre offset, for the forward lean of a chest or the set-back of a jaw. */
  cx?: number;
  cz?: number;
  /** Facets. Six and eight are the workhorses; twelve already reads as a tube. */
  sides?: number;
  /** Rotate the facet phase so a flat face, not a corner, points forward. */
  phase?: number;
  /**
   * 0 = ellipse, 1 = nearly a rectangle. A superellipse exponent in disguise —
   * this is how a torso gets a flat chest plane and a flat back without needing
   * a bespoke profile per unit.
   */
  squareness?: number;
  /** Scale applied to +Z half only, so a chest can be flatter at the back. */
  backFlatten?: number;
}

/** A closed loop of points in the XZ plane, ordered by increasing angle. */
export function ring(o: RingOpts): V3[] {
  const sides = o.sides ?? 8;
  const rx = o.rx;
  const rz = o.rz ?? rx;
  const y = o.y ?? 0;
  const cx = o.cx ?? 0;
  const cz = o.cz ?? 0;
  const phase = o.phase ?? 0;
  // Superellipse exponent: n = 2 is a true ellipse, growing n squares it off.
  const n = 2 + (o.squareness ?? 0) * 9;
  const e = 2 / n;
  const back = o.backFlatten ?? 1;
  const out: V3[] = [];
  for (let i = 0; i < sides; i++) {
    const a = phase + (i / sides) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const x = rx * Math.sign(ca) * Math.pow(Math.abs(ca), e);
    let z = rz * Math.sign(sa) * Math.pow(Math.abs(sa), e);
    if (z > 0) z *= back;
    out.push([cx + x, y, cz + z]);
  }
  return out;
}

/** Rectangular ring — four corners, for anything that is honestly a box. */
export function rectRing(hx: number, hz: number, y: number, cx = 0, cz = 0): V3[] {
  return [
    [cx + hx, y, cz + hz],
    [cx - hx, y, cz + hz],
    [cx - hx, y, cz - hz],
    [cx + hx, y, cz - hz],
  ];
}

export interface LoftOpts {
  capStart?: boolean;
  capEnd?: boolean;
  closed?: boolean;
  name?: string;
}

/**
 * Stitch a stack of rings into a solid. All rings must have the same point
 * count; the caller controls every crease by choosing where to put a ring.
 */
export function loft(rings: V3[][], o: LoftOpts = {}): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const closed = o.closed !== false;
  for (let i = 0; i < rings.length - 1; i++) {
    b.strip(rings[i], rings[i + 1], closed, i / (rings.length - 1), (i + 1) / (rings.length - 1));
  }
  if (o.capStart !== false) b.fan(rings[0], false);
  if (o.capEnd !== false) b.fan(rings[rings.length - 1], true);
  return b.build(o.name ?? '');
}

export interface PrismOpts {
  /** Bottom half-extents. */
  rx0: number;
  rz0?: number;
  /** Top half-extents. Defaults to the bottom, i.e. an untapered prism. */
  rx1?: number;
  rz1?: number;
  y0?: number;
  y1: number;
  /** Lateral offset of the top ring — a limb that is not vertical. */
  dx?: number;
  dz?: number;
  sides?: number;
  phase?: number;
  squareness?: number;
  capStart?: boolean;
  capEnd?: boolean;
  name?: string;
}

/** The single most-used form in the cast: a tapered, faceted prism. */
export function prism(o: PrismOpts): THREE.BufferGeometry {
  const rz0 = o.rz0 ?? o.rx0;
  const rx1 = o.rx1 ?? o.rx0;
  const rz1 = o.rz1 ?? rz0;
  const y0 = o.y0 ?? 0;
  const a = ring({
    rx: o.rx0,
    rz: rz0,
    y: y0,
    sides: o.sides,
    phase: o.phase,
    squareness: o.squareness,
  });
  const b = ring({
    rx: rx1,
    rz: rz1,
    y: o.y1,
    cx: o.dx ?? 0,
    cz: o.dz ?? 0,
    sides: o.sides,
    phase: o.phase,
    squareness: o.squareness,
  });
  return loft([a, b], { capStart: o.capStart, capEnd: o.capEnd, name: o.name });
}

/**
 * Tapered prism between two arbitrary points. Used for anything that runs at an
 * angle — a collarbone, a chariot's draught pole, an A-frame timber.
 */
export function strut(
  from: V3,
  to: V3,
  r0: number,
  r1 = r0,
  sides = 6,
  squareness = 0.35,
): THREE.BufferGeometry {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const g = prism({ rx0: r0, rx1: r1, y1: len, sides, squareness });
  // Build along +Y then rotate that axis onto the strut direction.
  const q = new THREE.Quaternion().setFromUnitVectors(
    UP,
    _v0.set(dx / len, dy / len, dz / len),
  );
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
  g.translate(from[0], from[1], from[2]);
  return g;
}

const UP = new THREE.Vector3(0, 1, 0);
const _v0 = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Slabs, plates and lathes
// ---------------------------------------------------------------------------

export interface SlabOpts {
  /** Width across X. */
  w: number;
  /** Height across Y. */
  h: number;
  /** Thickness along Z; the plate's outward face is at +Z. */
  d: number;
  /** How far the outer face is inset from the back face, per side. */
  bevel?: number;
  /** Bevel only the top and bottom (a plate that butts against its neighbours). */
  bevelX?: number;
  /** Emit the back face. Off saves 2 triangles but opens the outline hull. */
  backFace?: boolean;
  /** Push the outer face forward at the centre — a subtle crown on a plate. */
  crown?: number;
  name?: string;
}

/**
 * A bevelled slab: the lamellar plate, and by extension every buckle, tab,
 * ferrule and timber baulk in the project. Twelve triangles, one crisp
 * highlight band along each bevel, and it instances.
 */
export function bevelSlab(o: SlabOpts): THREE.BufferGeometry {
  const bx = o.bevelX ?? o.bevel ?? 0;
  const by = o.bevel ?? 0;
  const hw = o.w / 2;
  const hh = o.h / 2;
  const fw = Math.max(1e-4, hw - bx);
  const fh = Math.max(1e-4, hh - by);
  const zb = 0;
  const zf = o.d + (o.crown ?? 0);
  const b = new MeshBuilder();
  const B: V3[] = [
    [hw, -hh, zb],
    [-hw, -hh, zb],
    [-hw, hh, zb],
    [hw, hh, zb],
  ];
  const F: V3[] = [
    [fw, -fh, zf],
    [-fw, -fh, zf],
    [-fw, fh, zf],
    [fw, fh, zf],
  ];
  b.quad(F[0], F[1], F[2], F[3], [1, 0], [0, 0], [0, 1], [1, 1]);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    b.quad(B[i], B[j], F[j], F[i]);
  }
  if (o.backFace !== false) b.quad(B[3], B[2], B[1], B[0]);
  return b.build(o.name ?? 'slab');
}

/**
 * Surface of revolution from a `[radius, y]` profile, flat shaded. Helmet
 * bowls, canopy domes, shield bosses, drum bodies.
 */
export function hardLathe(
  profile: V2[],
  segments = 10,
  o: { capStart?: boolean; capEnd?: boolean; phase?: number; squareness?: number; name?: string } = {},
): THREE.BufferGeometry {
  const rings = profile.map((p) =>
    ring({ rx: p[0], y: p[1], sides: segments, phase: o.phase, squareness: o.squareness }),
  );
  // A zero-radius profile end collapses to a point; capping it would emit
  // degenerate triangles, so suppress the cap automatically.
  const capStart = o.capStart !== false && profile[0][0] > 1e-5;
  const capEnd = o.capEnd !== false && profile[profile.length - 1][0] > 1e-5;
  return loft(rings, { capStart, capEnd, name: o.name });
}

/**
 * Inset a closed polygon by `d` along each vertex's angle bisector. Exact for
 * convex corners and stable enough for the mild concavity of a 戈 blade.
 */
export function insetPolygon(poly: V2[], d: number): V2[] {
  const n = poly.length;
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const prev = poly[(i - 1 + n) % n];
    const next = poly[(i + 1) % n];
    const n0 = edgeNormal(prev, p);
    const n1 = edgeNormal(p, next);
    let bx = n0[0] + n1[0];
    let bz = n0[1] + n1[1];
    const l = Math.hypot(bx, bz);
    if (l < 1e-6) {
      out.push([p[0], p[1]]);
      continue;
    }
    bx /= l;
    bz /= l;
    // Compensate for the corner angle so the offset distance is uniform along
    // the edges rather than along the bisector.
    const cosHalf = Math.max(0.25, bx * n0[0] + bz * n0[1]);
    out.push([p[0] - (bx * d) / cosHalf, p[1] - (bz * d) / cosHalf]);
  }
  return out;
}

/** Outward normal of the edge a→b for a counter-clockwise polygon in XY. */
function edgeNormal(a: V2, b: V2): V2 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dy / l, -dx / l];
}

export interface ExtrudeOpts {
  /** Total thickness along Z, centred on z = 0. */
  depth: number;
  /** Chamfer on both rims. 0 gives a plain prism; a blade wants a real one. */
  chamfer?: number;
  /** Chamfer inset in the plane of the polygon. Defaults to `chamfer`. */
  chamferIn?: number;
  capFront?: boolean;
  capBack?: boolean;
  name?: string;
}

/**
 * Extrude a 2D polygon (XY, counter-clockwise) along Z with a hard chamfer on
 * both rims. Concave outlines are triangulated properly, which is the whole
 * reason this exists rather than a `ShapeGeometry`: a dagger-axe silhouette is
 * concave at the throat and a fan cap would tear it.
 */
export function extrudePlanar(poly: V2[], o: ExtrudeOpts): THREE.BufferGeometry {
  const c = o.chamfer ?? 0;
  const ci = o.chamferIn ?? c;
  const hz = o.depth / 2;
  const b = new MeshBuilder();
  const full = poly;
  const inner = ci > 0 ? insetPolygon(poly, ci) : poly;

  const at = (p: V2[], z: number): V3[] => p.map((q) => [q[0], q[1], z] as V3);

  if (c > 0) {
    const r0 = at(inner, -hz);
    const r1 = at(full, -hz + c);
    const r2 = at(full, hz - c);
    const r3 = at(inner, hz);
    // Rings run counter-clockwise in XY; walking -Z to +Z, `strip(a, b)` with b
    // the further ring gives outward normals, same rule as a vertical loft.
    b.strip(r0, r1, true);
    b.strip(r1, r2, true);
    b.strip(r2, r3, true);
    if (o.capBack !== false) b.polygonXY(inner, -hz, true);
    if (o.capFront !== false) b.polygonXY(inner, hz, false);
  } else {
    const r0 = at(full, -hz);
    const r1 = at(full, hz);
    b.strip(r0, r1, true);
    if (o.capBack !== false) b.polygonXY(full, -hz, true);
    if (o.capFront !== false) b.polygonXY(full, hz, false);
  }
  return b.build(o.name ?? 'extrude');
}

/**
 * A blade: an extruded outline with a raised spine and a ground fuller. Built
 * as an explicit five-ring cross-section sweep rather than an extrusion, so the
 * fuller is a real groove that catches its own highlight band instead of a
 * texture pretending to be one.
 *
 * `outline` is the blade's half-profile as `[halfWidth, y]` from ricasso to
 * point; the blade is symmetric about x = 0 and lies in the XY plane.
 */
export function bladeGeometry(o: {
  outline: V2[];
  /** Peak thickness at the spine, at the widest station. */
  thickness: number;
  /** Fuller depth as a fraction of half-thickness. 0 disables the fuller. */
  fuller?: number;
  /** Fuller width as a fraction of the blade half-width. */
  fullerWidth?: number;
  /** Where the cutting bevel starts, as a fraction of half-width from the edge. */
  edgeBevel?: number;
  /**
   * Per-station lateral shift of the blade's centre line, same length as
   * `outline`. This is what turns a symmetric double-edged 劍 into a
   * single-edged, back-heavy 刀: shift the centre toward the spine and the
   * cutting edge does all the tapering.
   */
  offset?: number[];
  name?: string;
}): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const fd = o.fuller ?? 0;
  const fw = o.fullerWidth ?? 0.42;
  const eb = o.edgeBevel ?? 0.3;
  const n = o.outline.length;

  // Cross-section stations across the blade, as fractions of half-width, from
  // the left edge to the right edge. The fuller is the dip at ±fw.
  const xs = [-1, -1 + eb, -fw, 0, fw, 1 - eb, 1];
  const zs = [0, 1, 1 - fd, 1, 1 - fd, 1, 0];

  const station = (i: number): { front: V3[]; back: V3[] } => {
    const [hw, y] = o.outline[i];
    const cx = o.offset ? o.offset[i] : 0;
    // Thickness tapers with width so the point is thin and the ricasso is stout.
    const t = (o.thickness / 2) * Math.min(1, Math.max(0.12, hw / o.outline[0][0]));
    const front: V3[] = [];
    const back: V3[] = [];
    for (let k = 0; k < xs.length; k++) {
      front.push([cx + xs[k] * hw, y, zs[k] * t]);
      back.push([cx + xs[k] * hw, y, -zs[k] * t]);
    }
    return { front, back };
  };

  let prev = station(0);
  for (let i = 1; i < n; i++) {
    const cur = station(i);
    for (let k = 0; k < xs.length - 1; k++) {
      b.quad(prev.front[k], prev.front[k + 1], cur.front[k + 1], cur.front[k]);
      b.quad(prev.back[k + 1], prev.back[k], cur.back[k], cur.back[k + 1]);
    }
    prev = cur;
  }
  // Close the ricasso end; the point closes itself because half-width goes to 0.
  const s0 = station(0);
  for (let k = 0; k < xs.length - 1; k++) {
    b.quad(s0.back[k], s0.back[k + 1], s0.front[k + 1], s0.front[k]);
  }
  return b.build(o.name ?? 'blade');
}

// ---------------------------------------------------------------------------
// Swept chains
// ---------------------------------------------------------------------------

export interface SweepStation {
  /** Centre of this cross-section, rig space. */
  p: V3;
  /** Half-extent across the local right axis. */
  rx: number;
  /** Half-extent across the local up axis. Defaults to `rx`. */
  rz?: number;
  phase?: number;
  squareness?: number;
  /**
   * Explicit cross-section in the local (right, up) plane, overriding the
   * elliptical default. This is how a pleated sleeve gets hard creases: the
   * section is a star of alternating radii, not an ellipse. Every station must
   * supply the same number of points.
   */
  section?: V2[];
}

/**
 * Sweep a cross-section along a polyline: limbs, elephant trunks, tails, cords,
 * draught poles — anything whose axis is not a straight vertical.
 *
 * Frames are parallel-transported rather than rebuilt from a fixed up vector.
 * A fixed up flips the section by 180° the moment the tangent passes vertical,
 * which on a trunk that curls from horizontal to vertical would put a visible
 * twist right where the eye is; parallel transport costs one extra rotation per
 * station and removes the failure entirely.
 */
export function sweep(
  stations: SweepStation[],
  o: { sides?: number; capStart?: boolean; capEnd?: boolean; up?: V3; name?: string } = {},
): THREE.BufferGeometry {
  const n = stations.length;
  if (n < 2) throw new Error('sweep: need at least two stations');
  const sides = o.sides ?? 8;

  const P = stations.map((s) => new THREE.Vector3(s.p[0], s.p[1], s.p[2]));
  const T: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)];
    const b = P[Math.min(n - 1, i + 1)];
    const t = b.clone().sub(a);
    if (t.lengthSq() < 1e-14) t.set(0, 1, 0);
    T.push(t.normalize());
  }

  // Seed the frame with whichever axis is least parallel to the first tangent.
  const seed = new THREE.Vector3(...(o.up ?? [0, 1, 0]));
  if (Math.abs(seed.dot(T[0])) > 0.94) seed.set(0, 0, 1);
  let right = seed.clone().cross(T[0]).normalize();

  const rings: V3[][] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      // Rotate the previous frame by the minimal rotation taking T[i-1] to T[i].
      const q = new THREE.Quaternion().setFromUnitVectors(T[i - 1], T[i]);
      right.applyQuaternion(q).normalize();
    }
    const upv = T[i].clone().cross(right).normalize();
    const s = stations[i];
    const rz = s.rz ?? s.rx;
    const template: V2[] = s.section
      ? s.section
      : ring({
          rx: s.rx,
          rz,
          sides,
          phase: s.phase,
          squareness: s.squareness,
        }).map((q) => [q[0], q[2]] as V2);
    rings.push(
      template.map((q) => {
        const x = q[0];
        const z = q[1];
        return [
          P[i].x + right.x * x + upv.x * z,
          P[i].y + right.y * x + upv.y * z,
          P[i].z + right.z * x + upv.z * z,
        ] as V3;
      }),
    );
  }
  return loft(rings, { capStart: o.capStart, capEnd: o.capEnd, name: o.name });
}

/**
 * Give an open surface real thickness.
 *
 * `grid[row][col]` is a quadrilateral patch — a cloak's back, a banner, an
 * elephant's ear, a canopy panel. The patch is duplicated along its own surface
 * normal, the two sheets are joined around all four borders, and the result is
 * a closed solid. Closed matters more than it sounds: the renderer's outline
 * pass draws back faces, and an open sheet's outline turns inside out.
 */
export function shell(
  grid: V3[][],
  thickness: number,
  o: { name?: string; flip?: boolean } = {},
): THREE.BufferGeometry {
  const R = grid.length;
  const C = grid[0].length;
  const sign = o.flip ? -1 : 1;

  // Vertex normals from the patch's own tangents, averaged across the shared
  // edges so the offset sheet does not self-intersect at a crease.
  const nrm: V3[][] = [];
  for (let r = 0; r < R; r++) {
    nrm.push([]);
    for (let c = 0; c < C; c++) {
      const a = grid[Math.min(R - 1, r + 1)][c];
      const b = grid[Math.max(0, r - 1)][c];
      const d = grid[r][Math.min(C - 1, c + 1)];
      const e = grid[r][Math.max(0, c - 1)];
      const ux = a[0] - b[0];
      const uy = a[1] - b[1];
      const uz = a[2] - b[2];
      const vx = d[0] - e[0];
      const vy = d[1] - e[1];
      const vz = d[2] - e[2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx = (nx / l) * sign;
      ny = (ny / l) * sign;
      nz = (nz / l) * sign;
      nrm[r].push([nx, ny, nz]);
    }
  }

  const inner: V3[][] = grid.map((row, r) =>
    row.map((p, c): V3 => [
      p[0] - nrm[r][c][0] * thickness,
      p[1] - nrm[r][c][1] * thickness,
      p[2] - nrm[r][c][2] * thickness,
    ]),
  );

  const b = new MeshBuilder();
  for (let r = 0; r < R - 1; r++) {
    for (let c = 0; c < C - 1; c++) {
      b.quad(grid[r][c], grid[r + 1][c], grid[r + 1][c + 1], grid[r][c + 1]);
      b.quad(inner[r][c], inner[r][c + 1], inner[r + 1][c + 1], inner[r + 1][c]);
    }
  }
  for (let c = 0; c < C - 1; c++) {
    b.quad(grid[0][c], grid[0][c + 1], inner[0][c + 1], inner[0][c]);
    b.quad(grid[R - 1][c + 1], grid[R - 1][c], inner[R - 1][c], inner[R - 1][c + 1]);
  }
  for (let r = 0; r < R - 1; r++) {
    b.quad(grid[r][C - 1], grid[r + 1][C - 1], inner[r + 1][C - 1], inner[r][C - 1]);
    b.quad(grid[r + 1][0], grid[r][0], inner[r][0], inner[r + 1][0]);
  }
  return b.build(o.name ?? 'shell');
}

// ---------------------------------------------------------------------------
// Geometry utilities
// ---------------------------------------------------------------------------

/**
 * Mirror across X. `applyMatrix4` alone would leave the winding reversed and
 * every face culled, so the triangles are re-ordered too.
 */
export function mirrorX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.clone();
  const pos = out.getAttribute('position') as THREE.BufferAttribute;
  const nor = out.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const pa = pos.array as Float32Array;
  for (let i = 0; i < pa.length; i += 3) pa[i] = -pa[i];
  if (nor) {
    const na = nor.array as Float32Array;
    for (let i = 0; i < na.length; i += 3) na[i] = -na[i];
  }
  // Non-indexed: swap the 2nd and 3rd vertex of every triangle.
  const attrs = Object.keys(out.attributes);
  for (let t = 0; t < pos.count; t += 3) {
    for (const key of attrs) {
      const a = out.getAttribute(key) as THREE.BufferAttribute;
      const s = a.itemSize;
      const arr = a.array as Float32Array;
      for (let c = 0; c < s; c++) {
        const i1 = (t + 1) * s + c;
        const i2 = (t + 2) * s + c;
        const tmp = arr[i1];
        arr[i1] = arr[i2];
        arr[i2] = tmp;
      }
    }
  }
  pos.needsUpdate = true;
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** Triangle count of any geometry, indexed or not. */
export function triangleCount(g: THREE.BufferGeometry): number {
  const idx = g.getIndex();
  if (idx) return idx.count / 3;
  const p = g.getAttribute('position');
  return p ? p.count / 3 : 0;
}

/**
 * Concatenate non-indexed geometries that share an attribute set. Written here
 * rather than pulled from `examples/jsm` so the merge understands the extra
 * attributes this project carries (`aSmoothNormal`, `skinIndex`, `skinWeight`)
 * and so a mismatch fails loudly instead of silently dropping data.
 */
export function mergeGeometryList(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (list.length === 0) return new THREE.BufferGeometry();
  if (list.length === 1) return list[0];
  const names = Object.keys(list[0].attributes);
  for (const g of list) {
    if (g.getIndex()) throw new Error('mergeGeometryList: indexed geometry is not supported');
    const k = Object.keys(g.attributes);
    if (k.length !== names.length || !names.every((n) => k.includes(n))) {
      throw new Error(
        `mergeGeometryList: attribute mismatch [${names.join(',')}] vs [${k.join(',')}]`,
      );
    }
  }
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const first = list[0].getAttribute(name) as THREE.BufferAttribute;
    const size = first.itemSize;
    let total = 0;
    for (const g of list) total += (g.getAttribute(name) as THREE.BufferAttribute).count;
    const isInt = first.array instanceof Uint16Array || first.array instanceof Uint8Array;
    const dst = isInt ? new Uint16Array(total * size) : new Float32Array(total * size);
    let off = 0;
    for (const g of list) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      dst.set(a.array as ArrayLike<number> as never, off);
      off += a.count * size;
    }
    out.setAttribute(
      name,
      isInt
        ? new THREE.Uint16BufferAttribute(dst as Uint16Array, size)
        : new THREE.Float32BufferAttribute(dst as Float32Array, size),
    );
  }
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/**
 * Add an `aSmoothNormal` attribute: the area-weighted average of the face
 * normals meeting at each welded position.
 *
 * The renderer's inverted-hull outline pushes vertices along a normal. Pushing
 * along the *flat* normal of a hard-edge mesh tears the hull open at every
 * crease — you get a shell of disconnected shards instead of a contour. This
 * attribute is the seam-free direction the hull pass needs, and it is written
 * once at build time so the outline shader costs nothing extra at runtime.
 */
export function addSmoothNormals(g: THREE.BufferGeometry, weld = 1e-4): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const count = pos.count;
  const acc = new Map<string, [number, number, number]>();
  const keys: string[] = new Array(count);
  const inv = 1 / weld;
  for (let i = 0; i < count; i++) {
    const kx = Math.round(pos.getX(i) * inv);
    const ky = Math.round(pos.getY(i) * inv);
    const kz = Math.round(pos.getZ(i) * inv);
    const key = `${kx},${ky},${kz}`;
    keys[i] = key;
    let e = acc.get(key);
    if (!e) {
      e = [0, 0, 0];
      acc.set(key, e);
    }
    e[0] += nor.getX(i);
    e[1] += nor.getY(i);
    e[2] += nor.getZ(i);
  }
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const e = acc.get(keys[i])!;
    const l = Math.hypot(e[0], e[1], e[2]);
    if (l > 1e-9) {
      out[i * 3] = e[0] / l;
      out[i * 3 + 1] = e[1] / l;
      out[i * 3 + 2] = e[2] / l;
    } else {
      // Two exactly opposed faces meeting at a point: fall back to the flat
      // normal, which at least keeps the hull vertex on the surface.
      out[i * 3] = nor.getX(i);
      out[i * 3 + 1] = nor.getY(i);
      out[i * 3 + 2] = nor.getZ(i);
    }
  }
  g.setAttribute('aSmoothNormal', new THREE.Float32BufferAttribute(out, 3));
  return g;
}

/** Throw on any NaN/Infinity in any attribute. Used by the verification pass. */
export function assertFinite(g: THREE.BufferGeometry, label: string): void {
  for (const name of Object.keys(g.attributes)) {
    const a = g.getAttribute(name) as THREE.BufferAttribute;
    const arr = a.array as ArrayLike<number>;
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) {
        throw new Error(`${label}: non-finite value in "${name}" at ${i}`);
      }
    }
  }
  const pos = g.getAttribute('position');
  if (!pos || pos.count === 0) throw new Error(`${label}: geometry has no vertices`);
  if (pos.count % 3 !== 0) throw new Error(`${label}: vertex count ${pos.count} is not a multiple of 3`);
}

/** Translate/rotate/scale in one call, returning the same geometry. */
export function place(
  g: THREE.BufferGeometry,
  o: { pos?: V3; rot?: V3; scale?: V3 | number } = {},
): THREE.BufferGeometry {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  if (o.rot) q.setFromEuler(new THREE.Euler(o.rot[0], o.rot[1], o.rot[2], 'XYZ'));
  const s =
    typeof o.scale === 'number'
      ? new THREE.Vector3(o.scale, o.scale, o.scale)
      : new THREE.Vector3(...(o.scale ?? [1, 1, 1]));
  m.compose(new THREE.Vector3(...(o.pos ?? [0, 0, 0])), q, s);
  g.applyMatrix4(m);
  return g;
}

/** Matrix helper for instance transforms. */
export function matrix(pos: V3, rot: V3 = [0, 0, 0], scale: V3 | number = 1): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
  const s =
    typeof scale === 'number'
      ? new THREE.Vector3(scale, scale, scale)
      : new THREE.Vector3(...scale);
  return new THREE.Matrix4().compose(new THREE.Vector3(...pos), q, s);
}

/** Bounding box of a geometry as a plain tuple pair, in its own space. */
export function bounds(g: THREE.BufferGeometry): { min: V3; max: V3 } {
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  return { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] };
}
