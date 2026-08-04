/**
 * Rivets, studs, buckles and cord loops.
 *
 * These are the smallest things in the project and they do a disproportionate
 * amount of the work: a lacquered plate with a rivet at each corner reads as
 * *assembled*, and the same plate without reads as moulded. At board distance
 * they are two or three pixels of specular break, which under a hard four-band
 * ramp is exactly one band of lift — visible, and free of any texture.
 *
 * Everything here is instanced. A rivet is sixteen triangles; a general carries
 * about ninety of them for 1 440 triangles and one draw call.
 *
 * All studs are authored base-at-origin pointing along +Y, so placing one is a
 * rotation from +Y onto the surface normal.
 */

import * as THREE from 'three';
import type { BoneName } from '@core/contracts.ts';
import { MeshBuilder, bevelSlab, hardLathe, loft, ring } from './prim.ts';
import {
  emptyGroup,
  mkPart,
  type Part,
  type PartGroup,
  type PartPigment,
  type V3,
} from './types.ts';

const _up = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

// ---------------------------------------------------------------------------
// The stud
// ---------------------------------------------------------------------------

export interface RivetOpts {
  r: number;
  h: number;
  sides?: number;
  /** 0 gives a flat disc head, 1 a full dome. */
  dome?: number;
}

/**
 * A domed rivet head. Sixteen triangles at six sides: one band and a cap. Six
 * sides is not a compromise — a hexagonal head catches a different band of the
 * ramp on each facet, which is what makes it visible at all at this size.
 */
export function rivetGeometry(o: RivetOpts): THREE.BufferGeometry {
  const sides = o.sides ?? 6;
  const dome = o.dome ?? 0.55;
  const phase = Math.PI / sides;
  return loft(
    [
      ring({ rx: o.r, y: 0, sides, phase }),
      ring({ rx: o.r * (1 - dome * 0.45), y: o.h, sides, phase }),
    ],
    { capStart: false, capEnd: true, name: 'rivet' },
  );
}

/** A square-headed stud — Chu fittings favour these over round rivets. */
export function studGeometry(o: { w: number; h: number; bevel?: number }): THREE.BufferGeometry {
  return bevelSlab({
    w: o.w,
    h: o.w,
    d: o.h,
    bevel: o.bevel ?? o.w * 0.24,
    backFace: false,
    name: 'stud',
  });
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export interface RivetPlacementOpts {
  boneHint: BoneName;
  pigment?: PartPigment;
  cls?: Part['cls'];
  rivet?: RivetOpts;
  /** Override the geometry — a square stud, a boss, anything +Y-aligned. */
  geometry?: THREE.BufferGeometry;
  name?: string;
  mountBone?: string;
}

function makeInstanced(
  mats: THREE.Matrix4[],
  o: RivetPlacementOpts,
  fallback: THREE.BufferGeometry,
): PartGroup {
  const g = emptyGroup();
  if (mats.length === 0) return g;
  g.instanced.push({
    geometry: o.geometry ?? fallback,
    cls: o.cls ?? 'iron',
    pigment: o.pigment ?? 'metal',
    boneHint: o.boneHint,
    rigid: true,
    noSilk: true,
    transforms: mats,
    name: o.name ?? 'rivets',
    ...(o.mountBone ? { mountBone: o.mountBone } : {}),
  });
  return g;
}

export interface RivetLineOpts extends RivetPlacementOpts {
  from: V3;
  to: V3;
  count: number;
  /** Surface normal the studs stand on. Defaults to +Y. */
  normal?: V3;
}

/** Studs evenly spaced along a straight run — a strap, a plate edge, a rail. */
export function rivetLine(o: RivetLineOpts): PartGroup {
  const geo = rivetGeometry(o.rivet ?? { r: 0.01, h: 0.006 });
  _n.set(...(o.normal ?? [0, 1, 0])).normalize();
  _q.setFromUnitVectors(_up, _n);
  const mats: THREE.Matrix4[] = [];
  for (let i = 0; i < o.count; i++) {
    const t = o.count > 1 ? i / (o.count - 1) : 0.5;
    _p.set(
      o.from[0] + (o.to[0] - o.from[0]) * t,
      o.from[1] + (o.to[1] - o.from[1]) * t,
      o.from[2] + (o.to[2] - o.from[2]) * t,
    );
    mats.push(new THREE.Matrix4().compose(_p, _q, _s));
  }
  return makeInstanced(mats, o, geo);
}

export interface RivetArcOpts extends RivetPlacementOpts {
  /** Centre of the ellipse the studs sit on. */
  centre: V3;
  rx: number;
  rz?: number;
  count: number;
  arc?: number;
  arcCentre?: number;
  /** Tilt from horizontal so studs on a sloped band stand proud of it. */
  tilt?: number;
}

/** Studs around an elliptical band — a helmet brim, a collar, a wheel hub. */
export function rivetArc(o: RivetArcOpts): PartGroup {
  const geo = rivetGeometry(o.rivet ?? { r: 0.01, h: 0.006 });
  const rz = o.rz ?? o.rx;
  const arc = o.arc ?? Math.PI * 2;
  const closed = arc >= Math.PI * 2 - 1e-6;
  const centre = o.arcCentre ?? -Math.PI / 2;
  const tilt = o.tilt ?? 0;
  const mats: THREE.Matrix4[] = [];
  for (let i = 0; i < o.count; i++) {
    const f = closed ? i / o.count : o.count > 1 ? i / (o.count - 1) : 0.5;
    const th = centre - arc / 2 + f * arc;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    _p.set(o.centre[0] + o.rx * ct, o.centre[1], o.centre[2] + rz * st);
    // Outward normal of the ellipse, lifted by `tilt` toward +Y.
    _n.set(rz * ct, 0, o.rx * st).normalize();
    _n.y = Math.tan(tilt);
    _n.normalize();
    _q.setFromUnitVectors(_up, _n);
    mats.push(new THREE.Matrix4().compose(_p, _q, _s));
  }
  return makeInstanced(mats, o, geo);
}

export interface RivetGridOpts extends RivetPlacementOpts {
  /** Four corners of the patch, in order. */
  corners: [V3, V3, V3, V3];
  rows: number;
  cols: number;
  /** Inset from the border, 0..0.5. */
  inset?: number;
}

/** Studs on a quadrilateral patch — a shield face, a chariot side panel. */
export function rivetGrid(o: RivetGridOpts): PartGroup {
  const geo = rivetGeometry(o.rivet ?? { r: 0.01, h: 0.006 });
  const [a, b, c, d] = o.corners;
  const inset = o.inset ?? 0.12;
  const mats: THREE.Matrix4[] = [];
  // Patch normal from its diagonals; a quad's studs all stand the same way.
  const ux = c[0] - a[0];
  const uy = c[1] - a[1];
  const uz = c[2] - a[2];
  const vx = d[0] - b[0];
  const vy = d[1] - b[1];
  const vz = d[2] - b[2];
  _n.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).normalize();
  _q.setFromUnitVectors(_up, _n);
  for (let r = 0; r < o.rows; r++) {
    const tv = inset + (o.rows > 1 ? (r / (o.rows - 1)) * (1 - inset * 2) : 0.5 - inset);
    for (let k = 0; k < o.cols; k++) {
      const tu = inset + (o.cols > 1 ? (k / (o.cols - 1)) * (1 - inset * 2) : 0.5 - inset);
      const top: V3 = [
        a[0] + (b[0] - a[0]) * tu,
        a[1] + (b[1] - a[1]) * tu,
        a[2] + (b[2] - a[2]) * tu,
      ];
      const bot: V3 = [
        d[0] + (c[0] - d[0]) * tu,
        d[1] + (c[1] - d[1]) * tu,
        d[2] + (c[2] - d[2]) * tu,
      ];
      _p.set(
        top[0] + (bot[0] - top[0]) * tv,
        top[1] + (bot[1] - top[1]) * tv,
        top[2] + (bot[2] - top[2]) * tv,
      );
      mats.push(new THREE.Matrix4().compose(_p, _q, _s));
    }
  }
  return makeInstanced(mats, o, geo);
}

// ---------------------------------------------------------------------------
// Fittings
// ---------------------------------------------------------------------------

export interface BuckleOpts {
  /** Centre of the buckle, rig space. */
  at: V3;
  w: number;
  h: number;
  thickness: number;
  boneHint: BoneName;
  pigment?: PartPigment;
  /** Rotation, XYZ Euler radians. */
  rot?: V3;
}

/** A rectangular frame buckle: four bars around a hole. */
export function buckle(o: BuckleOpts): Part {
  const b = new MeshBuilder();
  const t = o.thickness;
  const hw = o.w / 2;
  const hh = o.h / 2;
  const bar = (cx: number, cy: number, w: number, h: number) => {
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const y0 = cy - h / 2;
    const y1 = cy + h / 2;
    const z0 = -t / 2;
    const z1 = t / 2;
    const corners: V3[][] = [
      [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      [
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y0, z0],
        [x0, y0, z0],
      ],
    ];
    b.quad(corners[0][0], corners[0][1], corners[0][2], corners[0][3]);
    b.quad(corners[1][0], corners[1][1], corners[1][2], corners[1][3]);
    b.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    b.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
    b.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    b.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
  };
  const rail = Math.min(o.w, o.h) * 0.22;
  bar(0, hh - rail / 2, o.w, rail);
  bar(0, -hh + rail / 2, o.w, rail);
  bar(-hw + rail / 2, 0, rail, o.h - rail * 2);
  bar(hw - rail / 2, 0, rail, o.h - rail * 2);
  const g = b.build('buckle');
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...o.at),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0]), 'XYZ')),
    new THREE.Vector3(1, 1, 1),
  );
  g.applyMatrix4(m);
  return mkPart(g, 'iron', o.pigment ?? 'metal', o.boneHint, {
    name: 'buckle',
    rigid: true,
    noSilk: true,
  });
}

export interface CordLoopOpts {
  at: V3;
  /** Loop radius. */
  r: number;
  /** Cord thickness. */
  thickness: number;
  boneHint: BoneName;
  pigment?: PartPigment;
  rot?: V3;
  segments?: number;
}

/**
 * A cord loop — the tie-down on a lamellar row, the rein anchor on a yoke, the
 * hanger a scabbard swings from. A torus built as a lathe of a small polygon.
 */
export function cordLoop(o: CordLoopOpts): Part {
  const seg = o.segments ?? 8;
  const sec = 4;
  const profile: [number, number][] = [];
  for (let i = 0; i <= sec; i++) {
    const a = (i / sec) * Math.PI * 2;
    profile.push([o.r + Math.cos(a) * o.thickness, Math.sin(a) * o.thickness]);
  }
  const g = hardLathe(profile, seg, { capStart: false, capEnd: false, name: 'cordLoop' });
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...o.at),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0]), 'XYZ')),
    new THREE.Vector3(1, 1, 1),
  );
  g.applyMatrix4(m);
  return mkPart(g, 'leather', o.pigment ?? 'accent', o.boneHint, {
    name: 'cordLoop',
    rigid: true,
    noSilk: true,
  });
}
