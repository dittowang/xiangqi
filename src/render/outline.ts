/**
 * Ink-and-gold inverted hulls.
 *
 * The vertex program and the derivation of the constant-screen-width push live
 * in shaders/outline.glsl.ts. This file is the CPU half: computing the welded
 * normals the hull is pushed along, and building the hull objects.
 *
 * WHY THE WELDED NORMAL ATTRIBUTE IS NOT OPTIONAL
 * Every mesh in this project is deliberately hard-edged — the shape language is
 * 漢畫像石, crisp planes meeting at a definite angle, not a smoothly blended
 * organic surface. Hard edges mean split vertices: a cube has 24 vertices, not
 * 8, because the three faces meeting at a corner each need their own normal.
 * Push those three copies along their own face normals and they go three
 * different ways, and the hull opens a triangular gap at every single corner of
 * the model. The gaps look like the ink line has been chipped.
 *
 * So the hull needs a SECOND normal: the average of every face touching that
 * position, shared by all the split copies. Then all three copies of the corner
 * move together and the shell stays closed. The surface keeps its faceted
 * normals for shading — we want the hard shading — and only the hull uses the
 * welded ones.
 *
 * The average is weighted by the INTERIOR ANGLE each triangle subtends at the
 * vertex, not by triangle count and not by area. All three give different
 * answers and only one of them is tessellation-independent:
 *
 *   count   — dominated by whichever face happened to be split into more
 *             triangles. A cube face is two triangles, and a corner belongs to
 *             one of them on two faces and to two on the third, so a counted
 *             average leans toward that third face.
 *   area    — same problem in a subtler form. On a unit cube the weights come
 *             out 2:1:1 and the corner normal lands at (0.816, 0.408, 0.408)
 *             instead of the body diagonal. The hull then pushes that corner
 *             sideways and the stroke is visibly heavier on one face than the
 *             other two. (This is not hypothetical; selfcheck.ts caught exactly
 *             this and it is why the weighting changed.)
 *   angle   — the sum of interior angles around a vertex is a property of the
 *             SURFACE, not of how it was cut into triangles. Re-triangulating a
 *             face cannot change it. A cube corner comes out at exactly
 *             (1,1,1)/sqrt(3), which is the answer that keeps the stroke even.
 */

import * as THREE from 'three';
import type { GongbiMaterials, MaterialRequest } from '@core/contracts.ts';
import { OUTLINES, type OutlineProfileName } from '@core/palette.ts';
import { gongbiInfo, MIN_STROKE_CSS_PX } from './gongbi.ts';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Position quantisation used to decide that two vertices are "the same point",
 * in world units. Geometry is authored in rig units around 0.01–3.0, so 1e-4 is
 * four significant figures below the smallest feature and there is no risk of
 * welding two genuinely distinct points. Too coarse and separate parts of the
 * model would be welded into each other; too fine and floating-point noise from
 * a parametric generator would fail to weld a seam it meant to close.
 */
const WELD_EPSILON = 1e-4;

/** Attribute name the hull vertex program reads. */
export const SMOOTH_NORMAL_ATTRIBUTE = 'aSmoothNormal';

/** Marker put on every hull object, read by the pipeline's frame traversal. */
export const HULL_FLAG = 'gongbiHull';

// ---------------------------------------------------------------------------
// Welded normals
// ---------------------------------------------------------------------------

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e0 = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _tri = [0, 0, 0];

function weldKey(x: number, y: number, z: number): string {
  const q = 1 / WELD_EPSILON;
  return `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
}

/**
 * Compute and attach `aSmoothNormal`. Idempotent: geometry is shared between a
 * mesh and its hull (and between the thirty-two figures that reuse a part), so
 * this must run exactly once per BufferGeometry, and the flag is what
 * guarantees it.
 */
export function ensureSmoothNormals(geometry: THREE.BufferGeometry): void {
  if (geometry.getAttribute(SMOOTH_NORMAL_ATTRIBUTE)) return;

  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return;

  const count = pos.count;
  const out = new Float32Array(count * 3);

  // Map every vertex to its weld bucket.
  const buckets = new Map<string, number>();
  const bucketOf = new Int32Array(count);
  let bucketCount = 0;
  for (let i = 0; i < count; i++) {
    const k = weldKey(pos.getX(i), pos.getY(i), pos.getZ(i));
    let b = buckets.get(k);
    if (b === undefined) {
      b = bucketCount++;
      buckets.set(k, b);
    }
    bucketOf[i] = b;
  }

  const acc = new Float32Array(bucketCount * 3);

  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : count / 3;

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

    _a.fromBufferAttribute(pos, i0);
    _b.fromBufferAttribute(pos, i1);
    _c.fromBufferAttribute(pos, i2);
    _ab.subVectors(_b, _a);
    _ac.subVectors(_c, _a);
    _n.crossVectors(_ab, _ac);
    const twiceArea = _n.length();
    if (twiceArea < 1e-12) continue; // degenerate sliver contributes nothing
    _n.multiplyScalar(1 / twiceArea);

    _tri[0] = i0;
    _tri[1] = i1;
    _tri[2] = i2;
    for (let k = 0; k < 3; k++) {
      const vi = _tri[k];
      _e0.fromBufferAttribute(pos, _tri[(k + 1) % 3]).sub(
        k === 0 ? _a : k === 1 ? _b : _c,
      );
      _e1.fromBufferAttribute(pos, _tri[(k + 2) % 3]).sub(
        k === 0 ? _a : k === 1 ? _b : _c,
      );
      const l0 = _e0.length();
      const l1 = _e1.length();
      if (l0 < 1e-12 || l1 < 1e-12) continue;
      // Interior angle at this vertex. acos is clamped because floating point
      // will hand you 1.0000001 on a degenerate triangle and NaN the normal.
      const cosA = Math.max(-1, Math.min(1, _e0.dot(_e1) / (l0 * l1)));
      const w = Math.acos(cosA);
      const b = bucketOf[vi] * 3;
      acc[b] += _n.x * w;
      acc[b + 1] += _n.y * w;
      acc[b + 2] += _n.z * w;
    }
  }

  for (let i = 0; i < count; i++) {
    const b = bucketOf[i] * 3;
    let x = acc[b];
    let y = acc[b + 1];
    let z = acc[b + 2];
    const len = Math.hypot(x, y, z);
    if (len > 1e-12) {
      x /= len;
      y /= len;
      z /= len;
    } else {
      // Degenerate bucket (all triangles at this point are slivers). Fall back
      // to the shading normal so the hull at least does not collapse to zero.
      const nrm = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
      if (nrm) {
        x = nrm.getX(i);
        y = nrm.getY(i);
        z = nrm.getZ(i);
      } else {
        x = 0;
        y = 1;
        z = 0;
      }
    }
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }

  geometry.setAttribute(SMOOTH_NORMAL_ATTRIBUTE, new THREE.BufferAttribute(out, 3));
}

// ---------------------------------------------------------------------------
// Hull objects
// ---------------------------------------------------------------------------

/**
 * Build the hull for one mesh.
 *
 * The hull is added as a CHILD of its source with an identity local transform,
 * so its `matrixWorld` is byte-identical to the source's — no drift, no
 * ordering dependency, and nothing to keep in sync. A skinned hull is bound to
 * the SAME `Skeleton` object with the SAME `bindMatrix`, so it evaluates the
 * identical skinning matrices; it is not a copy of the pose, it is the pose.
 *
 * Geometry is shared, not cloned. The hull is the same triangles; only the
 * material and the winding differ.
 */
export function buildHull(source: THREE.Mesh, material: THREE.Material): THREE.Mesh | null {
  if (!source.geometry) return null;
  ensureSmoothNormals(source.geometry);

  let hull: THREE.Mesh;

  const skinned = source as THREE.SkinnedMesh;
  const instanced = source as THREE.InstancedMesh;

  if (skinned.isSkinnedMesh === true) {
    const h = new THREE.SkinnedMesh(source.geometry, material);
    h.bindMode = skinned.bindMode;
    h.bind(skinned.skeleton, skinned.bindMatrix);
    hull = h;
  } else if (instanced.isInstancedMesh === true) {
    const h = new THREE.InstancedMesh(source.geometry, material, instanced.count);
    // Share the matrix attribute rather than copying it: the animator writes to
    // the source's, and a copy would silently stop following after the first
    // frame. Sharing means one upload for both draws too.
    h.instanceMatrix = instanced.instanceMatrix;
    h.count = instanced.count;
    hull = h;
  } else {
    hull = new THREE.Mesh(source.geometry, material);
  }

  hull.name = `${source.name || 'mesh'}#hull`;
  hull.castShadow = false;
  hull.receiveShadow = false;
  hull.frustumCulled = source.frustumCulled;
  // Draw the shell first so the surface overwrites its interior instead of the
  // other way round; less overdraw, and it keeps the depth buffer tidy.
  hull.renderOrder = source.renderOrder - 1;
  hull.matrixAutoUpdate = false;
  hull.userData[HULL_FLAG] = true;

  source.add(hull);
  return hull;
}

/** True when this object is one of our hull shells. */
export function isHull(o: THREE.Object3D): boolean {
  return o.userData[HULL_FLAG] === true;
}

/**
 * Give every gongbi-material mesh under `root` its hull.
 *
 * This is the call characters/ and scene/ make: build the figure, hand the
 * root here, and the line work appears. It reads the request back off the
 * material's userData, so the caller does not have to keep a parallel record of
 * which mesh asked for what.
 *
 * Safe to call twice — meshes that already have a hull are skipped.
 */
export function attachOutlines(root: THREE.Object3D, materials: GongbiMaterials): THREE.Mesh[] {
  const built: THREE.Mesh[] = [];
  const pending: THREE.Mesh[] = [];

  // Collect first: buildHull() adds children, and mutating the tree during a
  // traverse() is how you end up processing a hull as if it were a surface.
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || isHull(mesh)) return;
    if (mesh.children.some(isHull)) return;
    if (Array.isArray(mesh.material)) return; // multi-material meshes: see note below
    pending.push(mesh);
  });

  for (const mesh of pending) {
    const info = gongbiInfo(mesh.material as THREE.Material);
    if (!info || info.kind !== 'surface') continue;
    const hullMat = materials.outline(info.req as MaterialRequest);
    if (!hullMat) continue;
    const hull = buildHull(mesh, hullMat);
    if (hull) built.push(hull);
  }

  return built;
}

/**
 * Multi-material meshes are skipped rather than half-handled. A hull is one
 * shell around one silhouette; a mesh split into groups with different outline
 * profiles has no single answer, and quietly picking group 0 would give a
 * chariot a fine flesh line round its wheels. Build such a part as separate
 * meshes and each gets its own correct stroke.
 */
export function removeOutlines(root: THREE.Object3D): void {
  const doomed: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (isHull(o)) doomed.push(o as THREE.Mesh);
  });
  for (const h of doomed) {
    h.removeFromParent();
    // Geometry and material are shared with the source and with the library's
    // cache respectively, so neither is disposed here.
  }
}

// ---------------------------------------------------------------------------
// Sobel hand-off
// ---------------------------------------------------------------------------

/**
 * The radius, in DEVICE pixels, within which the Sobel pass must yield to the
 * hull. ARCHITECTURE.md fixes this at `hullWidth + 1px`.
 *
 * The width used is the widest live profile — `contour`, at 2.35 — because
 * that is the profile that owns the outer silhouette, which is the boundary the
 * two systems actually contest. A narrower structural line on an interior plate
 * is not competing with anything the Sobel wants to draw.
 *
 * `viewportHeightPx` is the device-pixel height, matching the same conversion
 * the hull vertex program does: widths are authored against 1080 CSS px and
 * scale with the viewport.
 */
export function hullSuppressRadiusPx(
  viewportHeightPx: number,
  profile: OutlineProfileName = 'contour',
  dpr = 1,
): number {
  // Identical expression to the hull vertex program, floor included. If the two
  // ever disagree the Sobel yields over the wrong width and the seam smear the
  // whole suppression system exists to prevent comes back.
  const scaled = (OUTLINES[profile].widthPx * viewportHeightPx) / 1080;
  return Math.max(scaled, MIN_STROKE_CSS_PX * dpr) + 1;
}
