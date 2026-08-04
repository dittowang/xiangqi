/**
 * Skin weights baked from a bone distance field.
 *
 * There is no rigger on this project and there are no imported weight maps, so
 * weights are solved from geometry: for every vertex, the distance to every
 * candidate bone's line segment, converted to an influence, best four kept and
 * normalised. Done naively that produces the two classic failures, and the two
 * defences against them are the reason this file is longer than the one-liner
 * the description suggests:
 *
 *   A. **Bleed.** A pauldron sits centimetres from the forearm in an A-pose, so
 *      a pure distance field hands it to `foreArmR` and the shoulder plate
 *      swings when the elbow bends. Two mechanisms stop that. First, distance is
 *      measured in units of *the bone's own capsule radius*, so a thin forearm
 *      has a short reach and a thick thigh a long one, and anything past
 *      `cutoff` radii is excluded outright. Second — and this is the one that
 *      actually holds — a part declares a `boneHint`, and only bones within
 *      `depth` steps of it in the skeleton graph are even considered. A part
 *      hinted at `clavicleR` cannot see `foreArmR` at any distance.
 *
 *   B. **Candy-wrapper collapse.** Two bones blending across a wide band around
 *      a joint shrink the limb to a waist when it bends. The band is narrowed
 *      two ways: an *axial* penalty, so influence dies fast past the end of a
 *      bone rather than only sideways from it, and a falloff exponent that keeps
 *      the transition inside roughly a quarter of a limb radius. Combined with
 *      the rig's pre-broken elbows and knees this holds the cross-section; the
 *      measured collapse at a 90° elbow is reported by `verify.ts` and is the
 *      number to watch if these constants are ever retuned.
 *
 * Linear blend skinning still cannot preserve volume under *twist*; nothing
 * short of dual-quaternion skinning can, and that would mean forking three's
 * skinning shader. The clips this project needs do not twist limbs far enough
 * for it to show, and that is a deliberate constraint on the animator, not an
 * oversight here.
 */

import * as THREE from 'three';
import { BONE_ORDER, BONE_PARENT, type BoneName } from '@core/contracts.ts';
import { BONE_CHILDREN, type Rig } from './rig.ts';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SkinOptions {
  /**
   * How many steps through the skeleton graph from `boneHint` a bone may be and
   * still influence this part. 1 is the default and is right for anything that
   * spans one joint — a thigh, an upper arm, a torso section. Cloth that drapes
   * over two joints wants 2.
   */
  depth?: number;
  /** Extra bones allowed regardless of graph distance. */
  allow?: BoneName[];
  /** Bones explicitly forbidden, even if the neighbourhood includes them. */
  deny?: BoneName[];
  /**
   * Multiplier on the hint bone's raw influence. Above 1 this pins a part to its
   * anchor: a pauldron at 1.6 stays on the shoulder while still softening into
   * the upper arm.
   */
  hintBias?: number;
  /** Influence exponent. Higher is tighter and more rigid. */
  falloff?: number;
  /** Influence is zero past this many capsule radii. */
  cutoff?: number;
  /**
   * How much harder influence falls off *along* a bone's axis past its ends than
   * sideways from it. This is what makes a joint hand a vertex over cleanly
   * instead of both bones fighting over a wide band.
   */
  axialPenalty?: number;
  /** Scales every capsule radius before the mask test. */
  capsuleScale?: number;
  /** Bind every vertex 100% to the hint bone. */
  rigid?: boolean;
}

const DEFAULTS: Required<Omit<SkinOptions, 'allow' | 'deny' | 'rigid'>> = {
  depth: 1,
  hintBias: 1.6,
  falloff: 3.2,
  cutoff: 2.6,
  axialPenalty: 1.9,
  capsuleScale: 1.35,
};

export const MAX_INFLUENCES = 4;

// ---------------------------------------------------------------------------
// Bone neighbourhoods
// ---------------------------------------------------------------------------

const NEIGHBOURHOOD_CACHE = new Map<string, BoneName[]>();

/**
 * Bones within `depth` steps of `hint` in the skeleton graph, `root` excluded —
 * it is a transform handle with no volume and would otherwise capture the whole
 * lower body.
 */
export function boneNeighbourhood(hint: BoneName, depth: number): BoneName[] {
  const key = `${hint}:${depth}`;
  const hit = NEIGHBOURHOOD_CACHE.get(key);
  if (hit) return hit;

  const dist = new Map<BoneName, number>([[hint, 0]]);
  let frontier: BoneName[] = [hint];
  for (let d = 1; d <= depth; d++) {
    const next: BoneName[] = [];
    for (const b of frontier) {
      const adj: BoneName[] = [];
      const p = BONE_PARENT[b];
      if (p) adj.push(p);
      adj.push(...BONE_CHILDREN[b]);
      for (const n of adj) {
        if (dist.has(n)) continue;
        dist.set(n, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  const out: BoneName[] = [...dist.keys()].filter((b): boolean => b !== 'root');
  if (out.length === 0) out.push(hint);
  NEIGHBOURHOOD_CACHE.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Distance field
// ---------------------------------------------------------------------------

interface Candidate {
  index: number;
  name: BoneName;
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  /** 1 / |b-a|², precomputed. */
  invLen2: number;
  len: number;
  radius: number;
  isHint: boolean;
}

const BONE_INDEX: Record<BoneName, number> = (() => {
  const o = {} as Record<BoneName, number>;
  BONE_ORDER.forEach((n, i) => (o[n] = i));
  return o;
})();

function buildCandidates(rig: Rig, hint: BoneName, o: SkinOptions): Candidate[] {
  const depth = o.depth ?? DEFAULTS.depth;
  const names = new Set<BoneName>(boneNeighbourhood(hint, depth));
  for (const a of o.allow ?? []) names.add(a);
  for (const d of o.deny ?? []) names.delete(d);
  names.add(hint); // the hint is never removable: it is the fallback anchor
  names.delete('root');

  const out: Candidate[] = [];
  for (const name of names) {
    const seg = rig.segments[name];
    if (!seg) continue;
    const dx = seg.b.x - seg.a.x;
    const dy = seg.b.y - seg.a.y;
    const dz = seg.b.z - seg.a.z;
    const len2 = dx * dx + dy * dy + dz * dz;
    out.push({
      index: BONE_INDEX[name],
      name,
      ax: seg.a.x,
      ay: seg.a.y,
      az: seg.a.z,
      bx: seg.b.x,
      by: seg.b.y,
      bz: seg.b.z,
      invLen2: len2 > 1e-12 ? 1 / len2 : 0,
      len: Math.sqrt(len2),
      radius: Math.max(seg.r, 1e-4),
      isHint: name === hint,
    });
  }
  return out;
}

// Scratch arrays for the per-vertex top-4 selection. Skinning happens at build
// time, but this runs once per vertex of every unit in the cast and there is no
// reason to allocate eight objects each time round.
const _idx = new Int32Array(MAX_INFLUENCES);
const _wgt = new Float64Array(MAX_INFLUENCES);

// ---------------------------------------------------------------------------
// The bake
// ---------------------------------------------------------------------------

/**
 * Add `skinIndex` and `skinWeight` attributes to a geometry authored in rig
 * space. Mutates and returns the geometry.
 */
export function bindSkin(
  geometry: THREE.BufferGeometry,
  rig: Rig,
  hint: BoneName,
  opts: SkinOptions = {},
): THREE.BufferGeometry {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const si = new Uint16Array(n * MAX_INFLUENCES);
  const sw = new Float32Array(n * MAX_INFLUENCES);
  const hintIndex = BONE_INDEX[hint];

  if (opts.rigid) {
    for (let v = 0; v < n; v++) {
      si[v * 4] = hintIndex;
      sw[v * 4] = 1;
    }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    return geometry;
  }

  const cands = buildCandidates(rig, hint, opts);
  const falloff = opts.falloff ?? DEFAULTS.falloff;
  const cutoff = opts.cutoff ?? DEFAULTS.cutoff;
  const axial = opts.axialPenalty ?? DEFAULTS.axialPenalty;
  const capsule = opts.capsuleScale ?? DEFAULTS.capsuleScale;
  const hintBias = opts.hintBias ?? DEFAULTS.hintBias;
  const parr = pos.array as ArrayLike<number>;

  for (let v = 0; v < n; v++) {
    const px = parr[v * 3];
    const py = parr[v * 3 + 1];
    const pz = parr[v * 3 + 2];

    for (let k = 0; k < MAX_INFLUENCES; k++) {
      _idx[k] = -1;
      _wgt[k] = 0;
    }

    for (let c = 0; c < cands.length; c++) {
      const b = cands[c];
      const vx = px - b.ax;
      const vy = py - b.ay;
      const vz = pz - b.az;
      const ex = b.bx - b.ax;
      const ey = b.by - b.ay;
      const ez = b.bz - b.az;
      const tRaw = (vx * ex + vy * ey + vz * ez) * b.invLen2;
      const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
      const cx = b.ax + ex * t;
      const cy = b.ay + ey * t;
      const cz = b.az + ez * t;
      const dx = px - cx;
      const dy = py - cy;
      const dz = pz - cz;
      const dFull2 = dx * dx + dy * dy + dz * dz;

      // Split the distance into the part perpendicular to the bone and the part
      // that overhangs its ends, so the two can be penalised differently.
      const over = (tRaw < 0 ? -tRaw : tRaw > 1 ? tRaw - 1 : 0) * b.len;
      const perp2 = Math.max(0, dFull2 - over * over);
      const perp = Math.sqrt(perp2);

      // Capsule mask. A bone whose capsule the vertex is well outside of has no
      // business claiming it, whatever the raw distance says.
      if (!b.isHint && perp > b.radius * capsule) continue;

      const dEff = Math.sqrt(perp2 + over * over * axial * axial);
      const s = dEff / b.radius;
      if (!b.isHint && s > cutoff) continue;

      let w = 1 / (Math.pow(s, falloff) + 1e-3);
      // Taper to exactly zero at the cutoff so a bone never contributes a
      // hairline weight that steals one of the four slots from a real one.
      if (s < cutoff) {
        const edge = 1 - s / cutoff;
        w *= edge * edge;
      } else {
        w = b.isHint ? w * 1e-3 : 0;
      }
      if (b.isHint) w *= hintBias;
      if (w <= 0) continue;

      // Insertion sort into the top-4.
      for (let k = 0; k < MAX_INFLUENCES; k++) {
        if (w > _wgt[k]) {
          for (let j = MAX_INFLUENCES - 1; j > k; j--) {
            _wgt[j] = _wgt[j - 1];
            _idx[j] = _idx[j - 1];
          }
          _wgt[k] = w;
          _idx[k] = b.index;
          break;
        }
      }
    }

    let sum = 0;
    for (let k = 0; k < MAX_INFLUENCES; k++) if (_idx[k] >= 0) sum += _wgt[k];
    if (sum <= 0) {
      // Nothing reached this vertex — pin it to the hint. Silent unweighted
      // vertices collapse to the origin at render time, which is the single
      // most alarming-looking bug in a character pipeline.
      si[v * 4] = hintIndex;
      sw[v * 4] = 1;
      continue;
    }
    const inv = 1 / sum;
    for (let k = 0; k < MAX_INFLUENCES; k++) {
      if (_idx[k] < 0) continue;
      si[v * 4 + k] = _idx[k];
      sw[v * 4 + k] = _wgt[k] * inv;
    }
  }

  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  return geometry;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface SkinStats {
  vertices: number;
  /** Largest deviation of a weight sum from 1. Must be ~0. */
  worstNormError: number;
  /** Vertices whose dominant weight is below 0.5 — the blend-heavy band. */
  blendHeavy: number;
  /** Vertices bound to exactly one bone. */
  rigidVerts: number;
  /** Mean number of non-zero influences. */
  meanInfluences: number;
  /** Bone indices actually referenced. */
  bonesUsed: number[];
}

export function skinStats(geometry: THREE.BufferGeometry): SkinStats {
  const si = geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
  const sw = geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
  if (!si || !sw) throw new Error('skinStats: geometry is not skinned');
  const n = sw.count;
  let worst = 0;
  let blend = 0;
  let rigid = 0;
  let infl = 0;
  const used = new Set<number>();
  for (let v = 0; v < n; v++) {
    let sum = 0;
    let top = 0;
    let count = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(v, k);
      sum += w;
      if (w > 1e-5) {
        count++;
        used.add(si.getComponent(v, k));
      }
      if (w > top) top = w;
    }
    worst = Math.max(worst, Math.abs(sum - 1));
    if (top < 0.5) blend++;
    if (count <= 1) rigid++;
    infl += count;
  }
  return {
    vertices: n,
    worstNormError: worst,
    blendHeavy: blend,
    rigidVerts: rigid,
    meanInfluences: n > 0 ? infl / n : 0,
    bonesUsed: [...used].sort((a, b) => a - b),
  };
}

/**
 * Measure how much a skinned cross-section collapses when a joint is bent —
 * the candy-wrapper number. Poses `child` by `angle` about +X, runs three's own
 * skinning path (`applyBoneTransform`, the same maths the vertex shader does),
 * and compares the widest cross-section within `band` of the joint against its
 * bind-pose width.
 *
 * Returns the retained fraction: 1.0 is perfect, 0.7 means the limb lost 30% of
 * its width at the joint.
 */
export function measureJointCollapse(
  geometry: THREE.BufferGeometry,
  rig: Rig,
  joint: BoneName,
  child: BoneName,
  angle: number,
  band = 0.25,
): { retained: number; bindWidth: number; posedWidth: number; samples: number } {
  const mesh = new THREE.SkinnedMesh(geometry, undefined);
  mesh.bind(rig.skeleton, new THREE.Matrix4());

  const jointPos = rig.bindWorld[joint];
  const seg = rig.segments[joint];
  const axis = seg.b.clone().sub(seg.a).normalize();
  const radius = seg.r;

  // Vertices whose projection onto the bone axis lands within `band` radii of
  // the joint — the ring that pinches.
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const picks: number[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const along = p.clone().sub(jointPos).dot(axis);
    if (Math.abs(along) <= band * radius) picks.push(i);
  }
  if (picks.length < 6) {
    return { retained: 1, bindWidth: 0, posedWidth: 0, samples: picks.length };
  }

  const spread = (transform: (i: number, out: THREE.Vector3) => void): number => {
    // Widest chord of the ring, measured perpendicular to the bone axis.
    const pts: THREE.Vector3[] = [];
    const v = new THREE.Vector3();
    for (const i of picks) {
      transform(i, v);
      const along = v.clone().sub(jointPos).dot(axis);
      pts.push(v.clone().sub(axis.clone().multiplyScalar(along)));
    }
    let max = 0;
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const d = pts[a].distanceTo(pts[b]);
        if (d > max) max = d;
      }
    }
    return max;
  };

  const bindWidth = spread((i, out) => out.fromBufferAttribute(pos, i));

  rig.bones[child].rotation.set(angle, 0, 0);
  rig.rootBone.updateMatrixWorld(true);
  rig.skeleton.update();
  mesh.updateMatrixWorld(true);
  const posedWidth = spread((i, out) => {
    out.fromBufferAttribute(pos, i);
    mesh.applyBoneTransform(i, out);
  });

  rig.bones[child].rotation.set(0, 0, 0);
  rig.rootBone.updateMatrixWorld(true);
  rig.skeleton.update();

  return {
    retained: bindWidth > 1e-9 ? posedWidth / bindWidth : 1,
    bindWidth,
    posedWidth,
    samples: picks.length,
  };
}
