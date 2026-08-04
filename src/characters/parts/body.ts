/**
 * The figure under the armour: torso, limbs, hands, head, boots.
 *
 * Han pictorial stone relief carves a body as a stack of *planes* — the brow is
 * one plane, the cheek another, the jaw a third, and the boundary between them
 * is a cut edge, not a gradient. Every form here is built the same way: low
 * facet counts (six and eight sides, never sixteen), superelliptical rings so a
 * chest has a flat front and a flat back, and a ring placed at every place the
 * silhouette should change direction. Nothing is a capsule.
 *
 * Everything is authored in rig space, feet at y = 0, facing -Z, in rig units.
 * Joint positions come from the caller (`rig.bindWorld`), so these stay pure
 * functions of their arguments and can be unit-tested without a skeleton.
 */

import * as THREE from 'three';
import type { BoneName } from '@core/contracts.ts';
import type { RigMetrics } from '../rig.ts';
import { MeshBuilder, bevelSlab, loft, mirrorX, place, prism, ring, sweep } from './prim.ts';
import {
  emptyGroup,
  mergeGroups,
  mkPart,
  type Part,
  type PartGroup,
  type V3,
} from './types.ts';

// Skin and hair are the same substance in both armies, so they are literal
// pigments rather than army slots. Ochre reads as painted flesh in gongbi; a
// pinker mix would fight the cinnabar army.
const FLESH = 'ochre' as const;
const HAIR = 'ink' as const;

// ---------------------------------------------------------------------------
// Torso
// ---------------------------------------------------------------------------

export interface TorsoOpts {
  hipY: number;
  waistY: number;
  chestY: number;
  shoulderY: number;
  hipWidth: number;
  waistWidth: number;
  chestWidth: number;
  shoulderWidth: number;
  hipDepth: number;
  waistDepth: number;
  chestDepth: number;
  /** Base of the neck, so the trapezius ring can taper into it. */
  neckR: number;
  sides?: number;
  /** 0 = elliptical section, 1 = nearly rectangular. 0.45 is the house value. */
  squareness?: number;
  /** Torso pigment: usually 'cloth' (an under-tunic) — armour goes on top. */
  pigment?: Part['pigment'];
  cls?: Part['cls'];
}

/**
 * Hip-to-shoulder trunk. Five rings, so the silhouette turns at the hip, the
 * waist, the ribcage and the deltoid line and nowhere else.
 */
export function torso(o: TorsoOpts): Part {
  const sides = o.sides ?? 8;
  const sq = o.squareness ?? 0.45;
  const phase = Math.PI / sides; // flat planes face ±X and ±Z, not corners
  const rings = [
    ring({
      rx: o.hipWidth * 0.56,
      rz: o.hipDepth * 0.62,
      y: o.hipY - (o.waistY - o.hipY) * 0.34,
      sides,
      phase,
      squareness: sq,
    }),
    ring({ rx: o.hipWidth * 0.54, rz: o.hipDepth * 0.6, y: o.hipY, sides, phase, squareness: sq }),
    ring({
      rx: o.waistWidth * 0.5,
      rz: o.waistDepth * 0.64,
      y: o.waistY,
      sides,
      phase,
      squareness: sq,
    }),
    ring({
      rx: o.chestWidth * 0.53,
      rz: o.chestDepth * 0.6,
      y: o.chestY,
      sides,
      phase,
      squareness: sq + 0.12,
    }),
    ring({
      rx: o.shoulderWidth * 0.52,
      rz: o.chestDepth * 0.56,
      y: o.shoulderY,
      sides,
      phase,
      squareness: sq + 0.12,
    }),
    // Trapezius: a short taper into the neck so the shoulders are not a plateau.
    ring({
      rx: o.neckR * 2.5,
      rz: o.neckR * 2.2,
      y: o.shoulderY + (o.shoulderY - o.chestY) * 0.42,
      cz: -o.neckR * 0.25,
      sides,
      phase,
      squareness: sq,
    }),
  ];
  const g = loft(rings, { name: 'torso' });
  return mkPart(g, o.cls ?? 'cloth', o.pigment ?? 'cloth', 'spine01', { name: 'torso' });
}

export interface NeckOpts {
  fromY: number;
  toY: number;
  r: number;
  sides?: number;
}

export function neck(o: NeckOpts): Part {
  const sides = o.sides ?? 6;
  const g = prism({
    rx0: o.r * 1.18,
    rz0: o.r * 1.05,
    rx1: o.r * 0.92,
    rz1: o.r * 0.92,
    y0: o.fromY,
    y1: o.toY,
    sides,
    phase: Math.PI / sides,
    squareness: 0.3,
    capStart: false,
    capEnd: false,
    name: 'neck',
  });
  return mkPart(g, 'flesh', FLESH, 'neck', { name: 'neck' });
}

// ---------------------------------------------------------------------------
// Head
// ---------------------------------------------------------------------------

export interface HeadOpts {
  /** Base of the skull — the `head` bone position. */
  baseY: number;
  /** Head length, base of skull to crown. */
  length: number;
  width: number;
  depth: number;
  /** Push the whole head forward/back; the neck lean is already in `baseY`. */
  z?: number;
  beard?: 'none' | 'short' | 'long';
  ears?: boolean;
  /** Bare head: adds a topknot. Helmeted units pass false. */
  topknot?: boolean;
}

/**
 * A head built as intersecting planes rather than a sphere: a wide zygomatic
 * ring, a narrower brow above it and a narrower jaw below, plus an explicit
 * brow ridge and nose wedge. Eight sides with the facet phase rotated so that
 * one flat plane faces forward — that plane *is* the face.
 */
export function head(o: HeadOpts): PartGroup {
  const g = emptyGroup();
  const L = o.length;
  const W = o.width;
  const D = o.depth;
  const z = o.z ?? 0;
  const sides = 8;
  const phase = Math.PI / sides;

  // Stations as fractions of head length above the skull base. The widest ring
  // is the cheekbone at 0.44; the jaw below it is set *back* as well as in,
  // which is what gives the Han-relief undercut along the jawline.
  const rings = [
    ring({ rx: W * 0.30, rz: D * 0.30, y: o.baseY + L * 0.02, cz: z + D * 0.06, sides, phase, squareness: 0.62 }),
    ring({ rx: W * 0.44, rz: D * 0.44, y: o.baseY + L * 0.19, cz: z + D * 0.02, sides, phase, squareness: 0.58 }),
    ring({ rx: W * 0.52, rz: D * 0.50, y: o.baseY + L * 0.44, cz: z - D * 0.02, sides, phase, squareness: 0.5 }),
    ring({ rx: W * 0.50, rz: D * 0.49, y: o.baseY + L * 0.62, cz: z - D * 0.04, sides, phase, squareness: 0.46 }),
    ring({ rx: W * 0.45, rz: D * 0.44, y: o.baseY + L * 0.82, cz: z - D * 0.02, sides, phase, squareness: 0.42 }),
    ring({ rx: W * 0.27, rz: D * 0.27, y: o.baseY + L * 0.98, cz: z, sides, phase, squareness: 0.4 }),
  ];
  g.parts.push(
    mkPart(loft(rings, { name: 'skull' }), 'flesh', FLESH, 'head', { name: 'skull', rigid: true }),
  );

  // Brow ridge: a shallow bevelled slab across the eye line. It is the single
  // most identifiable plane on a relief face and it survives at silhouette size
  // as a shadow band.
  const brow = bevelSlab({ w: W * 0.86, h: L * 0.1, d: D * 0.13, bevel: L * 0.022 });
  place(brow, { pos: [0, o.baseY + L * 0.6, z - D * 0.44], rot: [-0.22, 0, 0] });
  g.parts.push(mkPart(brow, 'flesh', FLESH, 'head', { name: 'brow', rigid: true }));

  // Nose: a four-plane wedge, not a bump.
  const nose = bevelSlab({ w: W * 0.2, h: L * 0.24, d: D * 0.16, bevel: L * 0.05, bevelX: W * 0.06 });
  place(nose, { pos: [0, o.baseY + L * 0.44, z - D * 0.46], rot: [-0.12, 0, 0] });
  g.parts.push(mkPart(nose, 'flesh', FLESH, 'head', { name: 'nose', rigid: true }));

  if (o.ears !== false) {
    const earShape = bevelSlab({ w: D * 0.1, h: L * 0.2, d: W * 0.09, bevel: L * 0.03 });
    place(earShape, { pos: [0, 0, 0], rot: [0, Math.PI / 2, 0] });
    const earL = earShape.clone();
    place(earL, { pos: [-W * 0.5, o.baseY + L * 0.46, z + D * 0.02] });
    g.parts.push(mkPart(earL, 'flesh', FLESH, 'head', { name: 'earL', rigid: true }));
    const earR = mirrorX(earL);
    g.parts.push(mkPart(earR, 'flesh', FLESH, 'head', { name: 'earR', rigid: true }));
    earShape.dispose();
  }

  if (o.topknot) {
    const knot = prism({
      rx0: W * 0.2,
      rx1: W * 0.13,
      y0: o.baseY + L * 0.94,
      y1: o.baseY + L * 1.22,
      sides: 6,
      squareness: 0.4,
    });
    knot.translate(0, 0, z + D * 0.06);
    g.parts.push(mkPart(knot, 'hair', HAIR, 'head', { name: 'topknot', rigid: true }));
  }

  if (o.beard && o.beard !== 'none') {
    const long = o.beard === 'long';
    const bl = L * (long ? 0.72 : 0.3);
    const beard = loft(
      [
        ring({ rx: W * 0.34, rz: D * 0.3, y: o.baseY + L * 0.18, cz: z - D * 0.1, sides: 6, squareness: 0.5 }),
        ring({ rx: W * 0.3, rz: D * 0.26, y: o.baseY + L * 0.02, cz: z - D * 0.14, sides: 6, squareness: 0.5 }),
        ring({ rx: W * 0.2, rz: D * 0.16, y: o.baseY - bl * 0.6, cz: z - D * 0.2, sides: 6, squareness: 0.5 }),
        ring({ rx: W * 0.07, rz: D * 0.06, y: o.baseY - bl, cz: z - D * 0.18, sides: 6, squareness: 0.5 }),
      ],
      { name: 'beard' },
    );
    g.parts.push(mkPart(beard, 'hair', HAIR, 'head', { name: 'beard', rigid: true }));
  }

  g.points.crown = new THREE.Vector3(0, o.baseY + L, z);
  g.points.face = new THREE.Vector3(0, o.baseY + L * 0.5, z - D * 0.5);
  return g;
}

// ---------------------------------------------------------------------------
// Limbs
// ---------------------------------------------------------------------------

export interface LimbOpts {
  from: V3;
  to: V3;
  r0: number;
  r1: number;
  /** Bulge at the belly of the muscle, as a multiple of the interpolated radius. */
  bulge?: number;
  /** Where along the limb the bulge peaks, 0..1. */
  bulgeAt?: number;
  sides?: number;
  squareness?: number;
  boneHint: BoneName;
  cls?: Part['cls'];
  pigment?: Part['pigment'];
  name?: string;
  /** Flatten the section across the limb axis — a forearm is not round. */
  flatten?: number;
}

/**
 * One tapered limb segment with a muscle belly. Three stations, so the taper
 * has a crease in it and the limb does not read as a lathe-turned dowel.
 */
export function limb(o: LimbOpts): Part {
  const bulge = o.bulge ?? 1.12;
  const at = o.bulgeAt ?? 0.36;
  const flat = o.flatten ?? 0.86;
  const lerp3 = (t: number): V3 => [
    o.from[0] + (o.to[0] - o.from[0]) * t,
    o.from[1] + (o.to[1] - o.from[1]) * t,
    o.from[2] + (o.to[2] - o.from[2]) * t,
  ];
  const rAt = (t: number) => o.r0 + (o.r1 - o.r0) * t;
  const sq = o.squareness ?? 0.3;
  const g = sweep(
    [
      { p: o.from, rx: o.r0, rz: o.r0 * flat, squareness: sq },
      { p: lerp3(at), rx: rAt(at) * bulge, rz: rAt(at) * bulge * flat, squareness: sq },
      { p: lerp3(0.72), rx: rAt(0.72) * 1.02, rz: rAt(0.72) * 1.02 * flat, squareness: sq },
      { p: o.to, rx: o.r1, rz: o.r1 * flat, squareness: sq },
    ],
    {
      sides: o.sides ?? 6,
      name: o.name ?? 'limb',
    },
  );
  return mkPart(g, o.cls ?? 'flesh', o.pigment ?? FLESH, o.boneHint, {
    name: o.name ?? 'limb',
  });
}

export interface ArmOpts {
  side: 'L' | 'R';
  shoulder: V3;
  elbow: V3;
  wrist: V3;
  upperR: number;
  foreR: number;
  sides?: number;
  cls?: Part['cls'];
  pigment?: Part['pigment'];
  /** Deltoid cap over the shoulder joint. Off for units wearing a pauldron. */
  deltoid?: boolean;
}

export function arm(o: ArmOpts): PartGroup {
  const S = o.side;
  const g = emptyGroup();
  g.parts.push(
    limb({
      from: o.shoulder,
      to: o.elbow,
      r0: o.upperR * 1.08,
      r1: o.foreR * 1.1,
      bulge: 1.16,
      bulgeAt: 0.33,
      sides: o.sides ?? 6,
      boneHint: `upperArm${S}` as BoneName,
      cls: o.cls,
      pigment: o.pigment,
      name: `upperArm${S}`,
    }),
  );
  g.parts.push(
    limb({
      from: o.elbow,
      to: o.wrist,
      r0: o.foreR * 1.14,
      r1: o.foreR * 0.72,
      bulge: 1.2,
      bulgeAt: 0.24,
      flatten: 0.78,
      sides: o.sides ?? 6,
      boneHint: `foreArm${S}` as BoneName,
      cls: o.cls,
      pigment: o.pigment,
      name: `foreArm${S}`,
    }),
  );
  if (o.deltoid !== false) {
    const d = prism({
      rx0: o.upperR * 1.32,
      rz0: o.upperR * 1.24,
      rx1: o.upperR * 0.8,
      rz1: o.upperR * 0.8,
      y0: 0,
      y1: -o.upperR * 2.1,
      sides: 6,
      squareness: 0.35,
    });
    d.translate(o.shoulder[0], o.shoulder[1] + o.upperR * 0.5, o.shoulder[2]);
    g.parts.push(
      mkPart(d, o.cls ?? 'flesh', o.pigment ?? FLESH, `upperArm${S}` as BoneName, {
        name: `deltoid${S}`,
      }),
    );
  }
  return g;
}

export interface LegOpts {
  side: 'L' | 'R';
  hip: V3;
  knee: V3;
  ankle: V3;
  thighR: number;
  shinR: number;
  sides?: number;
  cls?: Part['cls'];
  pigment?: Part['pigment'];
}

export function leg(o: LegOpts): PartGroup {
  const S = o.side;
  const g = emptyGroup();
  g.parts.push(
    limb({
      from: o.hip,
      to: o.knee,
      r0: o.thighR * 1.16,
      r1: o.shinR * 1.16,
      bulge: 1.14,
      bulgeAt: 0.3,
      sides: o.sides ?? 6,
      boneHint: `thigh${S}` as BoneName,
      cls: o.cls,
      pigment: o.pigment,
      name: `thigh${S}`,
    }),
  );
  g.parts.push(
    limb({
      from: o.knee,
      to: o.ankle,
      r0: o.shinR * 1.1,
      r1: o.shinR * 0.62,
      bulge: 1.26,
      bulgeAt: 0.26,
      flatten: 0.88,
      sides: o.sides ?? 6,
      boneHint: `shin${S}` as BoneName,
      cls: o.cls,
      pigment: o.pigment,
      name: `shin${S}`,
    }),
  );
  return g;
}

// ---------------------------------------------------------------------------
// Hands
// ---------------------------------------------------------------------------

export interface HandOpts {
  side: 'L' | 'R';
  /** Wrist position, rig space. */
  wrist: V3;
  /** Overall hand length. */
  length: number;
  r: number;
  /** 'fist' bores a real grip cylinder through the palm; 'open' does not. */
  pose?: 'fist' | 'open' | 'flat';
  /** Bore diameter of the grip, so a haft actually fits. */
  gripR?: number;
  cls?: Part['cls'];
  pigment?: Part['pigment'];
}

/**
 * A blocked hand: palm slab, finger block, thumb block, and — when posed as a
 * fist — a short tube standing in for the closed fingers, whose bore is the
 * grip. A haft passed through that bore genuinely intersects the geometry
 * instead of floating next to it, which is the difference between a held weapon
 * and a weapon parented to a wrist.
 *
 * Publishes `grip`: the centre of the bore, and the point weapons attach at.
 * The bore axis is +Y — every weapon in `weapons.ts` is authored haft-along-Y
 * with its grip centre at the origin, so attaching one is a bare parenting.
 */
export function hand(o: HandOpts): PartGroup {
  const S = o.side;
  const bone = `hand${S}` as BoneName;
  const g = emptyGroup();
  const L = o.length;
  const r = o.r;
  const cls = o.cls ?? 'flesh';
  const pig = o.pigment ?? FLESH;
  const dir = S === 'L' ? -1 : 1;

  const palm = bevelSlab({
    w: r * 1.9,
    h: L * 0.5,
    d: r * 1.25,
    bevel: r * 0.24,
    name: `palm${S}`,
  });
  place(palm, { pos: [o.wrist[0], o.wrist[1] - L * 0.26, o.wrist[2] - r * 0.6], rot: [Math.PI / 2, 0, 0] });
  g.parts.push(mkPart(palm, cls, pig, bone, { name: `palm${S}`, rigid: true }));

  if (o.pose === 'flat') {
    const fingers = bevelSlab({ w: r * 1.8, h: L * 0.44, d: r * 0.75, bevel: r * 0.2 });
    place(fingers, {
      pos: [o.wrist[0], o.wrist[1] - L * 0.72, o.wrist[2] - r * 0.6],
      rot: [Math.PI / 2, 0, 0],
    });
    g.parts.push(mkPart(fingers, cls, pig, bone, { name: `fingers${S}`, rigid: true }));
  } else {
    // Closed fingers as a six-sided tube whose axis is the grip. Low side count
    // keeps the knuckle line reading as facets.
    const bore = o.gripR ?? r * 0.42;
    const outer = bore + r * 0.78;
    const cy = o.wrist[1] - L * 0.5;
    const cz = o.wrist[2] - r * 0.55;
    const half = L * 0.3;
    const outerRing = (y: number) =>
      ring({ rx: outer, rz: outer * 0.86, y, cx: o.wrist[0], cz, sides: 6, phase: Math.PI / 6, squareness: 0.4 });
    const innerRing = (y: number) =>
      ring({ rx: bore, rz: bore, y, cx: o.wrist[0], cz, sides: 6, phase: Math.PI / 6 });
    const fist = loft([outerRing(cy - half), outerRing(cy + half)], {
      capStart: false,
      capEnd: false,
    });
    // Annular caps so the bore is a real hole rather than a decal.
    const capTop = annulus(innerRing(cy + half), outerRing(cy + half), false);
    const capBot = annulus(innerRing(cy - half), outerRing(cy - half), true);
    const boreWall = loft([innerRing(cy - half), innerRing(cy + half)], {
      capStart: false,
      capEnd: false,
    });
    flipWinding(boreWall);
    g.parts.push(mkPart(fist, cls, pig, bone, { name: `fingers${S}`, rigid: true }));
    g.parts.push(mkPart(capTop, cls, pig, bone, { name: `fistCapT${S}`, rigid: true }));
    g.parts.push(mkPart(capBot, cls, pig, bone, { name: `fistCapB${S}`, rigid: true }));
    g.parts.push(mkPart(boreWall, cls, pig, bone, { name: `fistBore${S}`, rigid: true }));
    g.points[`grip${S}`] = new THREE.Vector3(o.wrist[0], cy, cz);
  }

  const thumb = bevelSlab({ w: r * 0.62, h: L * 0.34, d: r * 0.62, bevel: r * 0.16 });
  place(thumb, {
    pos: [o.wrist[0] + dir * r * 0.72, o.wrist[1] - L * 0.4, o.wrist[2] - r * 1.15],
    rot: [1.15, 0, dir * 0.35],
  });
  g.parts.push(mkPart(thumb, cls, pig, bone, { name: `thumb${S}`, rigid: true }));

  if (!g.points[`grip${S}`]) {
    g.points[`grip${S}`] = new THREE.Vector3(o.wrist[0], o.wrist[1] - L * 0.5, o.wrist[2] - r * 0.55);
  }
  return g;
}

/** Flat ring between two coplanar rings — used for the fist's annular caps. */
function annulus(inner: V3[], outer: V3[], reverse: boolean): THREE.BufferGeometry {
  const b = new MeshBuilder();
  for (let i = 0; i < inner.length; i++) {
    const j = (i + 1) % inner.length;
    if (reverse) b.quad(inner[i], outer[i], outer[j], inner[j]);
    else b.quad(inner[i], inner[j], outer[j], outer[i]);
  }
  return b.build('annulus');
}

/** Reverse triangle winding in place — used to turn a tube inside out. */
function flipWinding(g: THREE.BufferGeometry): void {
  for (const key of Object.keys(g.attributes)) {
    const a = g.getAttribute(key) as THREE.BufferAttribute;
    const arr = a.array as Float32Array;
    const s = a.itemSize;
    for (let t = 0; t < a.count; t += 3) {
      for (let c = 0; c < s; c++) {
        const i1 = (t + 1) * s + c;
        const i2 = (t + 2) * s + c;
        const tmp = arr[i1];
        arr[i1] = arr[i2];
        arr[i2] = tmp;
      }
    }
    if (key === 'normal') for (let i = 0; i < arr.length; i++) arr[i] = -arr[i];
    a.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Feet
// ---------------------------------------------------------------------------

export interface BootOpts {
  side: 'L' | 'R';
  ankle: V3;
  length: number;
  width: number;
  /** Shaft height above the ankle. 0 gives a shoe, 1 a knee boot. */
  shaft?: number;
  cls?: Part['cls'];
  pigment?: Part['pigment'];
}

/**
 * A boot as three stacked blocks: sole, upper, shaft. The toe is a separate
 * plane raked upward — Han boots turn up at the toe, and that upturn is a
 * readable silhouette detail even at board scale.
 */
export function boot(o: BootOpts): PartGroup {
  const S = o.side;
  const bone = `foot${S}` as BoneName;
  const g = emptyGroup();
  const cls = o.cls ?? 'leather';
  const pig = o.pigment ?? 'leather';
  const L = o.length;
  const W = o.width;
  const [ax, ay, az] = o.ankle;
  const sole = ay * 0.32;

  const rect = (hx: number, hz: number, y: number, cz: number): V3[] => [
    [ax + hx, y, az + cz + hz],
    [ax - hx, y, az + cz + hz],
    [ax - hx, y, az + cz - hz],
    [ax + hx, y, az + cz - hz],
  ];

  const body = loft(
    [
      rect(W * 0.46, L * 0.44, 0, -L * 0.16),
      rect(W * 0.5, L * 0.46, sole, -L * 0.16),
      rect(W * 0.48, L * 0.4, ay * 0.85, -L * 0.1),
      rect(W * 0.4, L * 0.3, ay * 1.25, 0),
    ],
    { name: `boot${S}` },
  );
  g.parts.push(mkPart(body, cls, pig, bone, { name: `boot${S}`, rigid: true }));

  // Upturned toe.
  const toe = loft(
    [
      rect(W * 0.44, L * 0.06, sole * 0.6, -L * 0.56),
      rect(W * 0.34, L * 0.05, sole * 1.5, -L * 0.68),
      rect(W * 0.2, L * 0.04, sole * 2.6, -L * 0.72),
    ],
    { name: `toe${S}` },
  );
  g.parts.push(mkPart(toe, cls, pig, bone, { name: `toe${S}`, rigid: true }));

  const shaft = o.shaft ?? 0;
  if (shaft > 0.01) {
    const top = ay * 1.25 + shaft * L * 1.6;
    const sh = loft(
      [
        rect(W * 0.4, L * 0.3, ay * 1.2, 0),
        rect(W * 0.42, L * 0.32, ay * 1.2 + shaft * L * 0.5, L * 0.01),
        rect(W * 0.38, L * 0.3, top, L * 0.02),
      ],
      { name: `shaft${S}` },
    );
    g.parts.push(mkPart(sh, cls, pig, bone, { name: `shaft${S}`, rigid: true, allow: ['shinL', 'shinR'] }));
  }
  return g;
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

export interface FigureOpts {
  metrics: RigMetrics;
  bind: Record<BoneName, THREE.Vector3>;
  /** Cover the torso with a tunic (cloth) or leave it bare (flesh). */
  torsoPigment?: Part['pigment'];
  torsoCls?: Part['cls'];
  bootShaft?: number;
  beard?: HeadOpts['beard'];
  topknot?: boolean;
  handPose?: HandOpts['pose'];
  deltoid?: boolean;
}

/**
 * The whole naked figure in one call — torso, neck, head, both arms, both legs,
 * both hands, both boots — sized from a rig's metrics and bind positions. Every
 * unit builder starts here and then dresses the result.
 */
export function figure(o: FigureOpts): PartGroup {
  const m = o.metrics;
  const B = o.bind;
  const v = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];

  const g = mergeGroups(
    torso({
      hipY: m.hipY,
      waistY: m.waistY,
      chestY: m.chestY,
      shoulderY: m.shoulderY,
      hipWidth: m.hipWidth,
      waistWidth: m.waistWidth,
      chestWidth: m.chestWidth,
      shoulderWidth: m.shoulderWidth,
      hipDepth: m.hipDepth,
      waistDepth: m.waistDepth,
      chestDepth: m.chestDepth,
      neckR: m.neckR,
      pigment: o.torsoPigment,
      cls: o.torsoCls,
    }),
    neck({ fromY: m.shoulderY, toY: B.head.y + m.headLen * 0.08, r: m.neckR }),
    head({
      baseY: B.head.y,
      length: m.headLen,
      width: m.headWidth,
      depth: m.headDepth,
      z: B.head.z,
      beard: o.beard ?? 'none',
      topknot: o.topknot ?? false,
    }),
  );

  for (const S of ['L', 'R'] as const) {
    g.parts.push(
      ...arm({
        side: S,
        shoulder: v(B[`upperArm${S}`]),
        elbow: v(B[`foreArm${S}`]),
        wrist: v(B[`hand${S}`]),
        upperR: m.upperArmR,
        foreR: m.foreArmR,
        deltoid: o.deltoid,
      }).parts,
    );
    g.parts.push(
      ...leg({
        side: S,
        hip: v(B[`thigh${S}`]),
        knee: v(B[`shin${S}`]),
        ankle: v(B[`foot${S}`]),
        thighR: m.thighR,
        shinR: m.shinR,
      }).parts,
    );
    const h = hand({
      side: S,
      wrist: v(B[`hand${S}`]),
      length: m.handLen,
      r: m.handR,
      pose: o.handPose ?? 'fist',
    });
    g.parts.push(...h.parts);
    for (const k of Object.keys(h.points)) g.points[k] = h.points[k];
    const bt = boot({
      side: S,
      ankle: v(B[`foot${S}`]),
      length: m.footLen,
      width: m.footLen * 0.42,
      shaft: o.bootShaft ?? 0.25,
    });
    g.parts.push(...bt.parts);
  }
  return g;
}
