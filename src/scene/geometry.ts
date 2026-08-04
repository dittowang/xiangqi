/**
 * Build-time geometry primitives for the board, the piece bases and the
 * backdrop.
 *
 * Everything here runs once, at construction. None of it is allowed anywhere
 * near an update path, which is why it allocates freely with plain arrays and
 * small tuples — readability is worth more than an allocation that happens once
 * per process.
 *
 * Two conventions hold throughout:
 *
 *  - Geometry is built **non-indexed**. The board is full of crisp arrises
 *    (chisel walls, chamfers, stone joints) where the two faces meeting at an
 *    edge must NOT share a normal. Non-indexed triangles make a hard edge free
 *    and a smooth edge a matter of handing in the averaged normal, instead of
 *    the other way round. The vertex counts involved are tens of thousands, not
 *    millions, so the duplication costs nothing that matters.
 *  - UVs are **world scaled**: one UV unit is one board square. Any procedural
 *    texture generated in @render therefore lands at the same physical density
 *    on the silk, the timber and the stone without per-mesh tuning.
 */

import * as THREE from 'three';

/** `[x, y, z]`. */
export type P3 = readonly [number, number, number];
/** `[u, v]`. */
export type P2 = readonly [number, number];

/**
 * One point on a swept cross-section.
 *
 * `u` is the lateral offset from the sweep's reference line (outward for the
 * table frame, sideways for a groove, radial for a lathe). `y` is height.
 * `hard` marks the point as a crease: the two segments meeting there keep their
 * own face normals instead of averaging, which is what makes a chamfer read as
 * a chamfer rather than as a soft bulge.
 */
export interface ProfilePoint {
  u: number;
  y: number;
  hard?: boolean;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Accumulates non-indexed triangles with explicit per-vertex normals and UVs.
 *
 * Build-time only. `build()` hands back a `BufferGeometry` and leaves the
 * builder reusable (it does not clear itself — call `reset()` if you want that).
 */
export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uvs: number[] = [];

  /** Triangles accumulated so far. */
  get triangles(): number {
    return this.pos.length / 9;
  }

  reset(): void {
    this.pos.length = 0;
    this.nrm.length = 0;
    this.uvs.length = 0;
  }

  vert(p: P3, n: P3, uv: P2): void {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uvs.push(uv[0], uv[1]);
  }

  tri(a: P3, b: P3, c: P3, na: P3, nb: P3, nc: P3, ua: P2, ub: P2, uc: P2): void {
    this.vert(a, na, ua);
    this.vert(b, nb, ub);
    this.vert(c, nc, uc);
  }

  /** Quad in winding order a-b-c-d, split along a-c. */
  quad(
    a: P3,
    b: P3,
    c: P3,
    d: P3,
    na: P3,
    nb: P3,
    nc: P3,
    nd: P3,
    ua: P2,
    ub: P2,
    uc: P2,
    ud: P2,
  ): void {
    this.tri(a, b, c, na, nb, nc, ua, ub, uc);
    this.tri(a, c, d, na, nc, nd, ua, uc, ud);
  }

  /** Quad with one flat normal derived from its own plane. World-scaled UVs. */
  flatQuad(a: P3, b: P3, c: P3, d: P3): void {
    const n = faceNormal(a, b, c);
    this.quad(a, b, c, d, n, n, n, n, planarUV(a), planarUV(b), planarUV(c), planarUV(d));
  }

  /** Triangle with one flat normal derived from its own plane. */
  flatTri(a: P3, b: P3, c: P3): void {
    const n = faceNormal(a, b, c);
    this.tri(a, b, c, n, n, n, planarUV(a), planarUV(b), planarUV(c));
  }

  build(name = ''): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uvs), 2));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    if (name) g.name = name;
    return g;
  }
}

/** Right-handed face normal of a-b-c. Returns a unit vector, or +Y if degenerate. */
export function faceNormal(a: P3, b: P3, c: P3): P3 {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return [0, 1, 0];
  return [nx / len, ny / len, nz / len];
}

/** Top-down world UV. One unit = one board square. */
export function planarUV(p: P3): P2 {
  return [p[0], p[2]];
}

export function norm3(x: number, y: number, z: number): P3 {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

// ---------------------------------------------------------------------------
// Profile sampling
// ---------------------------------------------------------------------------

/**
 * Piecewise-linear sample of a profile at lateral offset `u`. The profile must
 * be sorted ascending in `u`. Outside the range it clamps to the end values.
 *
 * This is the single source of truth for both the swept geometry and
 * `Board.heightAt()`: the height field the animator plants feet against is
 * literally the same function the mesh was lofted from, so they cannot drift.
 */
export function sampleProfile(profile: readonly ProfilePoint[], u: number): number {
  const n = profile.length;
  if (n === 0) return 0;
  if (u <= profile[0].u) return profile[0].y;
  if (u >= profile[n - 1].u) return profile[n - 1].y;
  // Linear scan: profiles here are 4..16 points, a binary search would be noise.
  for (let i = 1; i < n; i++) {
    const b = profile[i];
    if (u <= b.u) {
      const a = profile[i - 1];
      const span = b.u - a.u;
      const t = span > 1e-9 ? (u - a.u) / span : 0;
      return a.y + (b.y - a.y) * t;
    }
  }
  return profile[n - 1].y;
}

/**
 * Per-segment normals for a profile, expressed in (outward, up) 2D.
 * Segment `i` runs from point `i` to point `i+1`.
 */
function segmentNormals2D(profile: readonly ProfilePoint[]): { no: number[]; nu: number[] } {
  const no: number[] = [];
  const nu: number[] = [];
  for (let i = 0; i + 1 < profile.length; i++) {
    const du = profile[i + 1].u - profile[i].u;
    const dy = profile[i + 1].y - profile[i].y;
    // Tangent (du, dy); the normal that points up-and-outward is (-dy, du).
    const l = Math.hypot(du, dy) || 1;
    no.push(-dy / l);
    nu.push(du / l);
  }
  return { no, nu };
}

/**
 * Vertex normals for each (segment, end) pair, honouring `hard` creases.
 * Returns two parallel arrays indexed `seg * 2 + end`, where end 0 is the
 * segment's low-u vertex and end 1 its high-u vertex.
 */
function profileVertexNormals(profile: readonly ProfilePoint[]): { no: number[]; nu: number[] } {
  const seg = segmentNormals2D(profile);
  const outN: number[] = [];
  const upN: number[] = [];
  const nSeg = profile.length - 1;
  for (let s = 0; s < nSeg; s++) {
    for (let e = 0; e < 2; e++) {
      const pIdx = s + e;
      const pt = profile[pIdx];
      // A crease, the first point or the last point: keep this segment's own normal.
      const neighbour = e === 0 ? s - 1 : s + 1;
      if (pt.hard || neighbour < 0 || neighbour >= nSeg) {
        outN.push(seg.no[s]);
        upN.push(seg.nu[s]);
      } else {
        const ox = seg.no[s] + seg.no[neighbour];
        const uy = seg.nu[s] + seg.nu[neighbour];
        const l = Math.hypot(ox, uy) || 1;
        outN.push(ox / l);
        upN.push(uy / l);
      }
    }
  }
  return { no: outN, nu: upN };
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

/**
 * Sweep a cross-section along a polyline lying in the XZ plane.
 *
 * `path` is flat `[x, y, z, x, y, z, ...]`; the `y` component is the height of
 * the surface the section is cut into, so a groove incised into a silk sheet
 * that sags by a couple of millimetres follows the sag instead of floating over
 * it. The section's `u` is the lateral offset, positive to the left of the
 * travel direction.
 *
 * Normals are flat per quad. That is deliberate for the incised line work: the
 * whole point of a V-groove is that one wall takes the key and the other goes
 * to shadow, and an averaged normal across the vee would smear exactly that.
 */
export function sweepAlongPath(
  b: MeshBuilder,
  path: readonly number[],
  section: readonly ProfilePoint[],
  uvScale = 1,
): void {
  const count = path.length / 3;
  if (count < 2 || section.length < 2) return;

  // Lateral (left) direction per path point, from the local tangent.
  const lx = new Float64Array(count);
  const lz = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(count - 1, i + 1);
    const tx = path[i1 * 3] - path[i0 * 3];
    const tz = path[i1 * 3 + 2] - path[i0 * 3 + 2];
    const l = Math.hypot(tx, tz) || 1;
    // Left of travel in XZ is (tz, -tx) with +Y up.
    lx[i] = tz / l;
    lz[i] = -tx / l;
  }

  let run = 0;
  for (let i = 0; i + 1 < count; i++) {
    const ax = path[i * 3];
    const ay = path[i * 3 + 1];
    const az = path[i * 3 + 2];
    const bx = path[(i + 1) * 3];
    const by = path[(i + 1) * 3 + 1];
    const bz = path[(i + 1) * 3 + 2];
    const segLen = Math.hypot(bx - ax, bz - az);

    for (let s = 0; s + 1 < section.length; s++) {
      const s0 = section[s];
      const s1 = section[s + 1];
      const p00: P3 = [ax + lx[i] * s0.u, ay + s0.y, az + lz[i] * s0.u];
      const p01: P3 = [ax + lx[i] * s1.u, ay + s1.y, az + lz[i] * s1.u];
      const p10: P3 = [bx + lx[i + 1] * s0.u, by + s0.y, bz + lz[i + 1] * s0.u];
      const p11: P3 = [bx + lx[i + 1] * s1.u, by + s1.y, bz + lz[i + 1] * s1.u];
      const n = faceNormal(p00, p10, p11);
      const v0 = run * uvScale;
      const v1 = (run + segLen) * uvScale;
      b.quad(
        p00,
        p10,
        p11,
        p01,
        n,
        n,
        n,
        n,
        [s0.u * uvScale, v0],
        [s0.u * uvScale, v1],
        [s1.u * uvScale, v1],
        [s1.u * uvScale, v0],
      );
    }
    run += segLen;
  }
}

/**
 * Sweep a profile around a rectangle by uniform outward offset.
 *
 * Offsetting a rectangle by a constant amount moves its corners along the 45°
 * diagonal, which *is* a mitre — so building the table frame this way gives
 * genuinely mitred corners for free, and the joint line falls exactly where a
 * joiner would cut it. Each of the four rails is emitted separately and pulled
 * back by `gap` at both ends, leaving the hairline you can see in the corner of
 * any real frame.
 *
 * `sag` lets the rail's inner lip follow the silk sheet it butts against, so
 * the two surfaces stay watertight.
 */
export function mitredFrame(
  b: MeshBuilder,
  halfX: number,
  halfZ: number,
  profile: readonly ProfilePoint[],
  samplesPerUnit: number,
  gap: number,
  sag: (x: number, z: number) => number,
  sagFalloff: number,
): void {
  const vn = profileVertexNormals(profile);
  const nSeg = profile.length - 1;

  // side 0: +Z, 1: -Z, 2: +X, 3: -X
  for (let side = 0; side < 4; side++) {
    const alongX = side < 2;
    const sign = side === 0 || side === 2 ? 1 : -1;
    const halfAlong = alongX ? halfX : halfZ;
    const halfAcross = alongX ? halfZ : halfX;
    const n = Math.max(2, Math.round((halfAlong * 2 + 2) * samplesPerUnit));

    for (let s = 0; s < nSeg; s++) {
      const pa = profile[s];
      const pb = profile[s + 1];
      const na0 = vn.no[s * 2];
      const nu0 = vn.nu[s * 2];
      const na1 = vn.no[s * 2 + 1];
      const nu1 = vn.nu[s * 2 + 1];

      for (let i = 0; i < n; i++) {
        const t0 = i / n;
        const t1 = (i + 1) / n;
        // Four corners: (profile end, length position).
        const corner = (pt: ProfilePoint, t: number): P3 => {
          const outAlong = halfAlong + pt.u;
          const across = sign * (halfAcross + pt.u);
          const along = -outAlong + gap + t * (2 * outAlong - 2 * gap);
          const x = alongX ? along : across;
          const z = alongX ? across : along;
          // Blend the silk's sag out over the first few centimetres of the rebate.
          const w = 1 - Math.min(1, pt.u / sagFalloff);
          return [x, pt.y + (w > 0 ? sag(x, z) * w : 0), z];
        };
        const p00 = corner(pa, t0);
        const p01 = corner(pa, t1);
        const p10 = corner(pb, t0);
        const p11 = corner(pb, t1);

        const nA: P3 = alongX ? [0, nu0, sign * na0] : [sign * na0, nu0, 0];
        const nB: P3 = alongX ? [0, nu1, sign * na1] : [sign * na1, nu1, 0];

        // Wind so the visible face is front-facing. The four rails are mirrored
        // in both axes, so which order that is flips per side and per axis —
        // rather than enumerate the four cases (and get one of them wrong),
        // build the quad, compare its geometric normal against the one the
        // profile says it should have, and reverse if they disagree.
        const geo = faceNormal(p00, p10, p11);
        const agrees = geo[0] * nA[0] + geo[1] * nA[1] + geo[2] * nA[2] > 0;
        if (agrees) {
          b.quad(p00, p10, p11, p01, nA, nB, nB, nA, planarUV(p00), planarUV(p10), planarUV(p11), planarUV(p01));
        } else {
          b.quad(p00, p01, p11, p10, nA, nA, nB, nB, planarUV(p00), planarUV(p01), planarUV(p11), planarUV(p10));
        }
      }
    }
  }
}

/**
 * Lathe a profile about the +Y axis at (cx, cz), with `baseY` added to every
 * height. `profile.u` is the radius. Used for the piece bases and the marker
 * discs.
 */
export function latheProfile(
  b: MeshBuilder,
  profile: readonly ProfilePoint[],
  segments: number,
  cx: number,
  cz: number,
  baseY: number,
  uvScale = 1,
): void {
  const vn = profileVertexNormals(profile);
  const nSeg = profile.length - 1;
  for (let s = 0; s < nSeg; s++) {
    const pa = profile[s];
    const pb = profile[s + 1];
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      const pt = (p: ProfilePoint, c: number, sn: number): P3 => [
        cx + c * p.u,
        baseY + p.y,
        cz + sn * p.u,
      ];
      const nAt = (idx: number, c: number, sn: number): P3 =>
        norm3(c * vn.no[idx], vn.nu[idx], sn * vn.no[idx]);

      const i0 = s * 2;
      const i1 = s * 2 + 1;
      const A = pt(pa, c0, s0);
      const B = pt(pa, c1, s1);
      const C = pt(pb, c1, s1);
      const D = pt(pb, c0, s0);
      b.quad(
        A,
        B,
        C,
        D,
        nAt(i0, c0, s0),
        nAt(i0, c1, s1),
        nAt(i1, c1, s1),
        nAt(i1, c0, s0),
        [pa.u * c0 * uvScale, pa.u * s0 * uvScale],
        [pa.u * c1 * uvScale, pa.u * s1 * uvScale],
        [pb.u * c1 * uvScale, pb.u * s1 * uvScale],
        [pb.u * c0 * uvScale, pb.u * s0 * uvScale],
      );
    }
  }
}

/** Flat disc facing +Y. */
export function disc(
  b: MeshBuilder,
  radius: number,
  y: number,
  segments: number,
  cx = 0,
  cz = 0,
): void {
  const up: P3 = [0, 1, 0];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0: P3 = [cx + Math.cos(a0) * radius, y, cz + Math.sin(a0) * radius];
    const p1: P3 = [cx + Math.cos(a1) * radius, y, cz + Math.sin(a1) * radius];
    const c: P3 = [cx, y, cz];
    b.tri(c, p0, p1, up, up, up, planarUV(c), planarUV(p0), planarUV(p1));
  }
}

/** Flat annulus facing +Y. */
export function annulus(
  b: MeshBuilder,
  inner: number,
  outer: number,
  y: number,
  segments: number,
  cx = 0,
  cz = 0,
): void {
  const up: P3 = [0, 1, 0];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a1);
    const s1 = Math.sin(a1);
    const A: P3 = [cx + c0 * inner, y, cz + s0 * inner];
    const B: P3 = [cx + c1 * inner, y, cz + s1 * inner];
    const C: P3 = [cx + c1 * outer, y, cz + s1 * outer];
    const D: P3 = [cx + c0 * outer, y, cz + s0 * outer];
    b.quad(A, B, C, D, up, up, up, up, planarUV(A), planarUV(B), planarUV(C), planarUV(D));
  }
}

// ---------------------------------------------------------------------------
// Polygon helpers, used by the incised seal glyphs
// ---------------------------------------------------------------------------

/** Signed area of a flat `[x0,y0,x1,y1,...]` contour. Positive = CCW. */
export function signedArea(flat: readonly number[]): number {
  let a = 0;
  const n = flat.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += flat[i * 2] * flat[j * 2 + 1] - flat[j * 2] * flat[i * 2 + 1];
  }
  return a * 0.5;
}

/** Even-odd point-in-polygon on a flat contour. */
export function pointInContour(flat: readonly number[], px: number, py: number): boolean {
  let inside = false;
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = flat[i * 2];
    const yi = flat[i * 2 + 1];
    const xj = flat[j * 2];
    const yj = flat[j * 2 + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Convert a flat contour to the `Vector2[]` that `ShapeUtils` expects. */
export function toVector2s(flat: readonly number[]): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push(new THREE.Vector2(flat[i], flat[i + 1]));
  return out;
}
