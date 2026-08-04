/**
 * Trim: piping, tassels 流蘇, bead strands 步搖, bosses, ferrules, plaques.
 *
 * Everything in here exists to break a large flat run into two values. A
 * quantised four-band ramp is merciless about big unmodulated areas — a
 * lacquered cuirass with nothing on it is a single flat shape however carefully
 * it is lit — and a line of piping along its edge costs eighty triangles and
 * fixes it. Gongbi painters do the same thing with 泥金 structural lines, which
 * is why most of this defaults to the army's metal pigment.
 */

import * as THREE from 'three';
import type { BoneName } from '@core/contracts.ts';
import { bevelSlab, hardLathe, prism, sweep } from './prim.ts';
import {
  emptyGroup,
  mkPart,
  type Part,
  type PartGroup,
  type PartPigment,
  type V3,
} from './types.ts';

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);

// ---------------------------------------------------------------------------
// Piping
// ---------------------------------------------------------------------------

export interface PipingOpts {
  /** Path in rig space. Three or more points. */
  path: V3[];
  r: number;
  boneHint: BoneName;
  pigment?: PartPigment;
  cls?: Part['cls'];
  sides?: number;
  name?: string;
  mountBone?: string;
}

/**
 * A raised cord run along a path — the edge of a cuirass, the seam of a robe,
 * the rim of a shield. Four sides by default: at this thickness a rounder
 * section gains nothing and costs twice as much.
 */
export function piping(o: PipingOpts): Part {
  const g = sweep(
    o.path.map((p) => ({ p, rx: o.r, squareness: 0.3 })),
    { sides: o.sides ?? 4, name: o.name ?? 'piping' },
  );
  return mkPart(g, o.cls ?? 'gold', o.pigment ?? 'metal', o.boneHint, {
    name: o.name ?? 'piping',
    noSilk: true,
    ...(o.mountBone ? { mountBone: o.mountBone } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tassels and strands
// ---------------------------------------------------------------------------

export interface TasselOpts {
  /** Where the tassel hangs from. */
  at: V3;
  /** Total length below `at`. */
  length: number;
  /** Radius of the strand bundle. */
  r: number;
  strands?: number;
  boneHint: BoneName;
  pigment?: PartPigment;
  mountBone?: string;
  /** Cap the top with a bound collar. */
  cap?: boolean;
}

/**
 * 流蘇 — a tassel: a bound collar and a splayed bundle of strands, instanced.
 * Hangs from helmet crests, sword pommels, chariot rails and the general's
 * standard. Strand directions are fixed rather than random so the same tassel
 * builds identically every run.
 */
export function tassel(o: TasselOpts): PartGroup {
  const g = emptyGroup();
  const n = o.strands ?? 7;

  if (o.cap !== false) {
    const cap = hardLathe(
      [
        [o.r * 0.5, 0],
        [o.r * 1.1, -o.length * 0.06],
        [o.r * 0.95, -o.length * 0.16],
        [o.r * 0.55, -o.length * 0.2],
      ],
      6,
      { name: 'tasselCap' },
    );
    cap.translate(o.at[0], o.at[1], o.at[2]);
    g.parts.push(
      mkPart(cap, 'gold', 'metal', o.boneHint, {
        name: 'tasselCap',
        rigid: true,
        noSilk: true,
        ...(o.mountBone ? { mountBone: o.mountBone } : {}),
      }),
    );
  }

  // One strand geometry, tapered, authored hanging from the origin along -Y.
  const strand = prism({
    rx0: o.r * 0.16,
    rx1: o.r * 0.07,
    y0: 0,
    y1: -o.length * 0.82,
    sides: 4,
    squareness: 0.2,
  });
  const mats: THREE.Matrix4[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // Splay: outer strands lean further out, in a fixed alternating pattern so
    // the bundle is not a perfect cone.
    const splay = 0.16 + (i % 3) * 0.05;
    _p.set(
      o.at[0] + Math.cos(a) * o.r * 0.42,
      o.at[1] - o.length * 0.18,
      o.at[2] + Math.sin(a) * o.r * 0.42,
    );
    _q.setFromEuler(new THREE.Euler(Math.sin(a) * splay, 0, -Math.cos(a) * splay, 'XYZ'));
    mats.push(new THREE.Matrix4().compose(_p, _q, _s));
  }
  g.instanced.push({
    geometry: strand,
    cls: 'cloth',
    pigment: o.pigment ?? 'accent',
    boneHint: o.boneHint,
    rigid: true,
    noSilk: true,
    transforms: mats,
    name: 'tasselStrands',
    ...(o.mountBone ? { mountBone: o.mountBone } : {}),
  });
  return g;
}

export interface BeadStrandOpts {
  /** Anchor point. */
  at: V3;
  /** Length of the strand. */
  length: number;
  beads: number;
  /** Bead radius. */
  r: number;
  boneHint: BoneName;
  pigment?: PartPigment;
  /** Sideways drift of the strand's bottom, for a hanging curve. */
  drift?: V3;
  mountBone?: string;
}

/**
 * 步搖 — the dangling bead strand on a general's crown, named for the way it
 * sways as its wearer walks. Instanced faceted beads on a fixed catenary-ish
 * curve. Two of these either side of the crown are what make the general's
 * headgear unmistakable at silhouette size.
 */
export function beadStrand(o: BeadStrandOpts): PartGroup {
  const g = emptyGroup();
  const bead = hardLathe(
    [
      [0.001, -o.r],
      [o.r * 0.85, -o.r * 0.35],
      [o.r, 0],
      [o.r * 0.85, o.r * 0.35],
      [0.001, o.r],
    ],
    6,
    { name: 'bead' },
  );
  const drift = o.drift ?? [0, 0, 0];
  const mats: THREE.Matrix4[] = [];
  for (let i = 0; i < o.beads; i++) {
    const t = (i + 0.5) / o.beads;
    _p.set(
      o.at[0] + drift[0] * t * t,
      o.at[1] - o.length * t + drift[1] * t * t,
      o.at[2] + drift[2] * t * t,
    );
    _q.identity();
    mats.push(new THREE.Matrix4().compose(_p, _q, _s));
  }
  g.instanced.push({
    geometry: bead,
    cls: 'gold',
    pigment: o.pigment ?? 'metal',
    boneHint: o.boneHint,
    rigid: true,
    noSilk: true,
    transforms: mats,
    name: 'beadStrand',
    ...(o.mountBone ? { mountBone: o.mountBone } : {}),
  });
  return g;
}

// ---------------------------------------------------------------------------
// Discs and rings
// ---------------------------------------------------------------------------

export interface BossOpts {
  at: V3;
  r: number;
  height: number;
  boneHint: BoneName;
  pigment?: PartPigment;
  cls?: Part['cls'];
  /** XYZ Euler, radians. The boss is authored facing +Y. */
  rot?: V3;
  sides?: number;
  mountBone?: string;
}

/**
 * A domed boss with a stepped rim — a shield's centre, a chariot's hub cap, a
 * belt plaque. Stepped rather than smooth so the ramp gives it two rings of
 * value rather than one gradient.
 */
export function boss(o: BossOpts): Part {
  const g = hardLathe(
    [
      [o.r, 0],
      [o.r * 0.96, o.height * 0.18],
      [o.r * 0.78, o.height * 0.24],
      [o.r * 0.72, o.height * 0.5],
      [o.r * 0.4, o.height * 0.82],
      [0.001, o.height],
    ],
    o.sides ?? 10,
    { name: 'boss' },
  );
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...o.at),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0]), 'XYZ')),
    new THREE.Vector3(1, 1, 1),
  );
  g.applyMatrix4(m);
  return mkPart(g, o.cls ?? 'gold', o.pigment ?? 'metal', o.boneHint, {
    name: 'boss',
    rigid: true,
    ...(o.mountBone ? { mountBone: o.mountBone } : {}),
  });
}

export interface FerruleOpts {
  /** Centre of the ring. */
  at: V3;
  /** Radius of the shaft it binds. */
  r: number;
  /** Ring height along the shaft axis. */
  height: number;
  /** How far the ring stands proud of the shaft. */
  proud?: number;
  boneHint: BoneName;
  pigment?: PartPigment;
  rot?: V3;
  sides?: number;
  mountBone?: string;
}

/**
 * A binding ring on a haft. Hafts in this project are tapered prisms, and the
 * rings are what tell you they are *bound* timber rather than turned dowel;
 * three or four up a spear shaft is the whole difference.
 */
export function ferrule(o: FerruleOpts): Part {
  const sides = o.sides ?? 6;
  const R = o.r + (o.proud ?? o.r * 0.14);
  const g = prism({
    rx0: R,
    rx1: R,
    y0: -o.height / 2,
    y1: o.height / 2,
    sides,
    phase: Math.PI / sides,
    squareness: 0.25,
    capStart: false,
    capEnd: false,
    name: 'ferrule',
  });
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...o.at),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0]), 'XYZ')),
    new THREE.Vector3(1, 1, 1),
  );
  g.applyMatrix4(m);
  return mkPart(g, 'iron', o.pigment ?? 'metal', o.boneHint, {
    name: 'ferrule',
    rigid: true,
    noSilk: true,
    ...(o.mountBone ? { mountBone: o.mountBone } : {}),
  });
}

export interface PlaqueOpts {
  at: V3;
  w: number;
  h: number;
  d: number;
  boneHint: BoneName;
  pigment?: PartPigment;
  cls?: Part['cls'];
  rot?: V3;
  mountBone?: string;
}

/**
 * A rank plaque — the bevelled rectangle on a belt or a chariot rail that the
 * HUD's seal-script glyph is stamped into. Deliberately blank: the glyph
 * outlines are `ui/seal.ts`'s job, and nothing in this subsystem draws letters.
 */
export function plaque(o: PlaqueOpts): Part {
  const g = bevelSlab({
    w: o.w,
    h: o.h,
    d: o.d,
    bevel: Math.min(o.w, o.h) * 0.14,
    name: 'plaque',
  });
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...o.at),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0]), 'XYZ')),
    new THREE.Vector3(1, 1, 1),
  );
  g.applyMatrix4(m);
  return mkPart(g, o.cls ?? 'gold', o.pigment ?? 'metal', o.boneHint, {
    name: 'plaque',
    rigid: true,
    ...(o.mountBone ? { mountBone: o.mountBone } : {}),
  });
}
