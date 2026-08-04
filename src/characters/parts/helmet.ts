/**
 * Headgear — the third and strongest silhouette axis.
 *
 * Of the three separation axes in `proportions.ts` this is the one that keeps
 * working when the other two fail. Two units can end up the same height and the
 * same width from an unlucky camera angle; they cannot end up wearing the same
 * hat. So every form here is designed to be identifiable *as an outline*: the
 * 兜鍪's rolled brim reads as a step, the 幞頭's two tails read as a fork, the
 * crowned helm reads as a tower, the fan crest reads as a vertical blade, the
 * horns read as a notch. Nothing here is a smooth dome, because a smooth dome
 * is the one shape that reads as "generic helmet".
 *
 * Every helmet publishes a `crest` point at the socket, so `crest()` can be
 * attached without a unit author measuring anything, and the factory maps it to
 * the `crest` attachment socket.
 *
 * Reference: Han 兜鍪 with rolled brim and 頓項 neck lappets; Chu peaked helms
 * from Chu tomb lacquerware; 幞頭 soft caps from Han painted figurines.
 */

import * as THREE from 'three';
import type { CrestStyle, HelmetStyle } from '../proportions.ts';
import { pleatedRing } from './cloth.ts';
import { lamellarBand } from './lamellar.ts';
import {
  bevelSlab,
  extrudePlanar,
  hardLathe,
  loft,
  mirrorX,
  place,
  ring,
  shell,
  sweep,
} from './prim.ts';
import { rivetArc } from './rivets.ts';
import { beadStrand, tassel } from './trim.ts';
import {
  emptyGroup,
  mergeGroups,
  mkPart,
  type Part,
  type PartGroup,
  type PartPigment,
  type V2,
  type V3,
} from './types.ts';

export interface HelmetOpts {
  style: HelmetStyle;
  /** Base of the skull — where the helmet's rim sits. */
  baseY: number;
  /** Head length; the helmet is sized against it. */
  headLen: number;
  headWidth: number;
  headDepth: number;
  /** Forward offset of the head, copied from the head part. */
  z?: number;
  /** Cheek lappets 頓項 hanging beside the jaw. */
  cheeks?: boolean;
  /** Neck lappet at the back. */
  nape?: boolean;
  /** Rivets around the brim. */
  rivets?: boolean;
  pigment?: PartPigment;
  /** Pigment for the brim, socket and fittings. */
  metalPigment?: PartPigment;
  clothPigment?: PartPigment;
}

const SEG = 10; // facets around a helmet bowl; twelve already reads as turned

/**
 * Build one helmet. Returns the bowl, brim, lappets and fittings, plus a
 * `crest` point at the socket and a `top` point at the apex.
 */
export function helmet(o: HelmetOpts): PartGroup {
  switch (o.style) {
    case 'hanDoumou':
      return hanDoumou(o);
    case 'chuPeaked':
      return chuPeaked(o);
    case 'softCap':
      return softCap(o);
    case 'crownedHelm':
      return crownedHelm(o);
    case 'hood':
      return hood(o);
    case 'turban':
      return turban(o);
    case 'fanCrown':
      return fanCrown(o);
  }
}

// ---------------------------------------------------------------------------
// 兜鍪 — the Han iron bowl
// ---------------------------------------------------------------------------

function hanDoumou(o: HelmetOpts): PartGroup {
  const g = emptyGroup();
  const L = o.headLen;
  const R = Math.max(o.headWidth, o.headDepth) * 0.58;
  const z = o.z ?? 0;
  const base = o.baseY + L * 0.34;
  const pig = o.pigment ?? 'lacquer';

  // Bowl: five profile stations, so the dome has three distinct planes rather
  // than one arc. The apex is flattened to carry the crest socket.
  const bowl = hardLathe(
    [
      [R * 1.0, base],
      [R * 1.02, base + L * 0.14],
      [R * 0.92, base + L * 0.44],
      [R * 0.66, base + L * 0.66],
      [R * 0.3, base + L * 0.78],
      [R * 0.16, base + L * 0.82],
    ],
    SEG,
    { phase: Math.PI / SEG, capEnd: true, capStart: false, name: 'doumouBowl' },
  );
  bowl.translate(0, 0, z);
  g.parts.push(mkPart(bowl, 'lacquer', pig, 'head', { name: 'helmetBowl', rigid: true }));

  // Rolled brim: an outward-then-under lip. This is the shape the whole helmet
  // is recognised by, so it is deliberately over-scaled relative to a real one.
  const brim = hardLathe(
    [
      [R * 1.0, base + L * 0.1],
      [R * 1.24, base + L * 0.04],
      [R * 1.3, base - L * 0.03],
      [R * 1.18, base - L * 0.07],
      [R * 1.02, base - L * 0.04],
    ],
    SEG,
    { phase: Math.PI / SEG, capStart: false, capEnd: false, name: 'doumouBrim' },
  );
  brim.translate(0, 0, z);
  g.parts.push(
    mkPart(brim, 'iron', o.metalPigment ?? 'metal', 'head', { name: 'helmetBrim', rigid: true }),
  );

  // Crest socket.
  const socket = hardLathe(
    [
      [R * 0.19, base + L * 0.78],
      [R * 0.2, base + L * 0.92],
      [R * 0.13, base + L * 0.95],
    ],
    6,
    { capStart: false, name: 'crestSocket' },
  );
  socket.translate(0, 0, z);
  g.parts.push(
    mkPart(socket, 'gold', o.metalPigment ?? 'metal', 'head', { name: 'crestSocket', rigid: true }),
  );

  if (o.cheeks !== false) g.parts.push(...cheekLappets(o, R, base).parts);
  if (o.nape !== false) g.parts.push(...napeLappet(o, R, base).parts);
  if (o.rivets !== false) {
    g.instanced.push(
      ...rivetArc({
        centre: [0, base + L * 0.12, z],
        rx: R * 1.06,
        rz: R * 1.06,
        count: 8,
        tilt: 0.35,
        boneHint: 'head',
        pigment: o.metalPigment ?? 'metal',
        rivet: { r: R * 0.075, h: R * 0.05 },
        name: 'helmetRivets',
      }).instanced,
    );
  }

  g.points.crest = new THREE.Vector3(0, base + L * 0.9, z);
  g.points.top = new THREE.Vector3(0, base + L * 0.95, z);
  return g;
}

// ---------------------------------------------------------------------------
// Chu peaked helm
// ---------------------------------------------------------------------------

function chuPeaked(o: HelmetOpts): PartGroup {
  const g = emptyGroup();
  const L = o.headLen;
  const R = Math.max(o.headWidth, o.headDepth) * 0.58;
  const z = o.z ?? 0;
  const base = o.baseY + L * 0.32;
  const pig = o.pigment ?? 'lacquer';

  // A bowl squared off in plan, so the silhouette from the front is a taper
  // with two hard corners rather than an arc.
  const bowl = loft(
    [
      ring({ rx: R * 1.02, rz: R * 1.06, y: base, cz: z, sides: 8, phase: Math.PI / 8, squareness: 0.5 }),
      ring({ rx: R * 1.0, rz: R * 1.04, y: base + L * 0.3, cz: z, sides: 8, phase: Math.PI / 8, squareness: 0.55 }),
      ring({ rx: R * 0.78, rz: R * 0.86, y: base + L * 0.62, cz: z - R * 0.05, sides: 8, phase: Math.PI / 8, squareness: 0.6 }),
      ring({ rx: R * 0.34, rz: R * 0.42, y: base + L * 0.82, cz: z - R * 0.1, sides: 8, phase: Math.PI / 8, squareness: 0.6 }),
    ],
    { capStart: false, name: 'chuBowl' },
  );
  g.parts.push(mkPart(bowl, 'lacquer', pig, 'head', { name: 'helmetBowl', rigid: true }));

  // Forward-raked ridge along the crown — the Chu signature.
  const ridge: V3[][] = [];
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const y = base + L * (0.3 + t * 0.56);
    const zz = z - R * (0.15 + t * 0.55) + R * t * t * 0.3;
    ridge.push([
      [-R * 0.11 * (1 - t * 0.5), y, zz],
      [R * 0.11 * (1 - t * 0.5), y, zz],
    ]);
  }
  g.parts.push(
    mkPart(shell(ridge, R * 0.05, { name: 'chuRidge' }), 'iron', o.metalPigment ?? 'metal', 'head', {
      name: 'helmetRidge',
      rigid: true,
    }),
  );

  const rim = hardLathe(
    [
      [R * 1.04, base + L * 0.06],
      [R * 1.16, base],
      [R * 1.1, base - L * 0.05],
      [R * 1.0, base - L * 0.04],
    ],
    8,
    { phase: Math.PI / 8, capStart: false, capEnd: false, name: 'chuRim' },
  );
  rim.translate(0, 0, z);
  g.parts.push(mkPart(rim, 'iron', o.metalPigment ?? 'metal', 'head', { name: 'helmetRim', rigid: true }));

  if (o.cheeks !== false) g.parts.push(...cheekLappets(o, R, base).parts);
  if (o.nape !== false) g.parts.push(...napeLappet(o, R, base).parts);

  g.points.crest = new THREE.Vector3(0, base + L * 0.7, z - R * 0.2);
  g.points.top = new THREE.Vector3(0, base + L * 0.84, z - R * 0.3);
  return g;
}

// ---------------------------------------------------------------------------
// 幞頭 — the soft cap
// ---------------------------------------------------------------------------

function softCap(o: HelmetOpts): PartGroup {
  const g = emptyGroup();
  const L = o.headLen;
  const R = Math.max(o.headWidth, o.headDepth) * 0.56;
  const z = o.z ?? 0;
  const base = o.baseY + L * 0.44;
  const pig = o.clothPigment ?? o.pigment ?? 'cloth';

  // Two-stage cap: a wrapped band, then a taller rear lobe. Soft cloth, so the
  // sections are pleated rather than turned.
  const cap = loft(
    [
      pleatedRing(7, R * 1.06, R * 1.0, base, { squash: 0.98, cz: z }),
      pleatedRing(7, R * 1.1, R * 1.02, base + L * 0.2, { squash: 0.98, cz: z }),
      pleatedRing(7, R * 0.98, R * 0.9, base + L * 0.46, { squash: 0.96, cz: z - R * 0.12 }),
      pleatedRing(7, R * 0.6, R * 0.54, base + L * 0.62, { squash: 0.94, cz: z - R * 0.2 }),
    ],
    { capStart: false, name: 'softCap' },
  );
  g.parts.push(mkPart(cap, 'cloth', pig, 'head', { name: 'cap', rigid: true }));

  // Wrapped band around the brow.
  const band = loft(
    [
      ring({ rx: R * 1.09, rz: R * 1.09, y: base - L * 0.02, cz: z, sides: 10, squareness: 0.35 }),
      ring({ rx: R * 1.14, rz: R * 1.14, y: base + L * 0.07, cz: z, sides: 10, squareness: 0.35 }),
      ring({ rx: R * 1.08, rz: R * 1.08, y: base + L * 0.15, cz: z, sides: 10, squareness: 0.35 }),
    ],
    { capStart: false, capEnd: false, name: 'capBand' },
  );
  g.parts.push(
    mkPart(band, 'cloth', o.metalPigment ?? 'accent', 'head', { name: 'capBand', rigid: true }),
  );

  // The two hanging tails 腳. These are the whole silhouette: a fork at the back
  // of the head that no other unit has.
  for (const s of [-1, 1]) {
    const grid: V3[][] = [];
    for (let r = 0; r < 4; r++) {
      const t = r / 3;
      const y = base + L * 0.36 - L * 0.62 * t + Math.sin(t * 2.4) * L * 0.05;
      const zz = z + R * (0.62 + t * 0.9);
      const w = R * (0.3 - t * 0.12);
      grid.push([
        [s * (R * 0.34 + t * R * 0.22) - w, y, zz],
        [s * (R * 0.34 + t * R * 0.22) + w, y, zz],
      ]);
    }
    g.parts.push(
      mkPart(shell(grid, R * 0.045, { name: 'capTail', flip: s < 0 }), 'cloth', pig, 'head', {
        name: 'capTail',
        rigid: true,
      }),
    );
  }

  g.points.crest = new THREE.Vector3(0, base + L * 0.6, z - R * 0.1);
  g.points.top = new THREE.Vector3(0, base + L * 0.64, z - R * 0.2);
  return g;
}

// ---------------------------------------------------------------------------
// The general's crowned helm
// ---------------------------------------------------------------------------

function crownedHelm(o: HelmetOpts): PartGroup {
  const g = mergeGroups(hanDoumou({ ...o, rivets: false }));
  const L = o.headLen;
  const R = Math.max(o.headWidth, o.headDepth) * 0.58;
  const z = o.z ?? 0;
  const base = o.baseY + L * 0.34;

  // The tower: a stepped crown rising off the bowl. Three steps, each catching
  // its own band of the ramp, so the crown reads as gold even in shadow.
  const crown = hardLathe(
    [
      [R * 0.34, base + L * 0.76],
      [R * 0.42, base + L * 0.84],
      [R * 0.34, base + L * 0.92],
      [R * 0.36, base + L * 1.06],
      [R * 0.5, base + L * 1.14],
      [R * 0.44, base + L * 1.22],
      [R * 0.14, base + L * 1.3],
    ],
    SEG,
    { phase: Math.PI / SEG, capStart: false, name: 'crown' },
  );
  crown.translate(0, 0, z);
  g.parts.push(
    mkPart(crown, 'gold', o.metalPigment ?? 'metal', 'head', { name: 'crown', rigid: true }),
  );

  // A coronet of small standing plates around the brow — reuses the lamellar
  // band, which is exactly the sort of thing that band primitive is for.
  const coronet = lamellarBand({
    rows: [{ y: base + L * 0.2, rx: R * 1.04, rz: R * 1.04, cz: z, count: 12, tilt: 0.32, bone: 'head' }],
    plate: { w: (Math.PI * 2 * R * 1.04) / 12 * 1.05, h: L * 0.2, d: R * 0.05, bevel: R * 0.05 },
    boneHint: 'head',
    pigment: o.metalPigment ?? 'metal',
    cls: 'gold',
    cord: false,
    name: 'coronet',
  });
  g.instanced.push(...coronet.instanced);

  g.points.crest = new THREE.Vector3(0, base + L * 1.3, z);
  g.points.top = new THREE.Vector3(0, base + L * 1.34, z);
  g.points.buyaoL = new THREE.Vector3(-R * 0.95, base + L * 0.26, z);
  g.points.buyaoR = new THREE.Vector3(R * 0.95, base + L * 0.26, z);
  return g;
}

// ---------------------------------------------------------------------------
// The artillerist's hood
// ---------------------------------------------------------------------------

function hood(o: HelmetOpts): PartGroup {
  const g = emptyGroup();
  const L = o.headLen;
  const R = Math.max(o.headWidth, o.headDepth) * 0.6;
  const z = o.z ?? 0;
  const base = o.baseY + L * 0.06;
  const pig = o.clothPigment ?? o.pigment ?? 'cloth';

  // The hood covers the whole skull and drops onto the shoulders. Deep pleats,
  // because it is the only soft-cloth head in the cast and it needs to read as
  // fabric against six hard ones.
  const shellRings = [
    pleatedRing(8, R * 1.16, R * 1.0, base - L * 0.16, { squash: 0.96, cz: z }),
    pleatedRing(8, R * 1.12, R * 0.98, base + L * 0.28, { squash: 0.96, cz: z }),
    pleatedRing(8, R * 1.0, R * 0.88, base + L * 0.66, { squash: 0.94, cz: z - R * 0.06 }),
    pleatedRing(8, R * 0.62, R * 0.54, base + L * 0.92, { squash: 0.92, cz: z - R * 0.14 }),
    pleatedRing(8, R * 0.2, R * 0.18, base + L * 1.02, { squash: 0.9, cz: z - R * 0.2 }),
  ];
  g.parts.push(
    mkPart(loft(shellRings, { capStart: false, name: 'hood' }), 'cloth', pig, 'head', {
      name: 'hood',
      rigid: true,
    }),
  );

  // Ear flaps, tied up rather than hanging — he is working.
  for (const s of [-1, 1]) {
    const flap = bevelSlab({ w: R * 0.36, h: L * 0.42, d: R * 0.12, bevel: R * 0.05 });
    place(flap, {
      pos: [s * R * 1.0, base + L * 0.34, z + R * 0.06],
      rot: [0.1, s * 0.42, s * -0.3],
    });
    g.parts.push(mkPart(flap, 'cloth', pig, 'head', { name: 'hoodFlap', rigid: true }));
  }

  // Brow band, so the hood has a hard edge somewhere.
  const band = loft(
    [
      ring({ rx: R * 1.13, rz: R * 1.11, y: base - L * 0.06, cz: z, sides: 10, squareness: 0.4 }),
      ring({ rx: R * 1.18, rz: R * 1.16, y: base + L * 0.04, cz: z, sides: 10, squareness: 0.4 }),
      ring({ rx: R * 1.12, rz: R * 1.1, y: base + L * 0.12, cz: z, sides: 10, squareness: 0.4 }),
    ],
    { capStart: false, capEnd: false, name: 'hoodBand' },
  );
  g.parts.push(
    mkPart(band, 'leather', o.metalPigment ?? 'leather', 'head', { name: 'hoodBand', rigid: true }),
  );

  g.points.crest = new THREE.Vector3(0, base + L * 1.0, z - R * 0.2);
  g.points.top = new THREE.Vector3(0, base + L * 1.04, z - R * 0.2);
  return g;
}

// ---------------------------------------------------------------------------
// The mahout's turban
// ---------------------------------------------------------------------------

function turban(o: HelmetOpts): PartGroup {
  const g = emptyGroup();
  const L = o.headLen;
  const R = Math.max(o.headWidth, o.headDepth) * 0.56;
  const z = o.z ?? 0;
  const base = o.baseY + L * 0.4;
  const pig = o.clothPigment ?? o.pigment ?? 'cloth';

  // Four windings, each a torus of decreasing radius, offset sideways so the
  // wrap spirals. Toroidal profiles are cheap and the stepped stack is exactly
  // what a wound cloth looks like in relief carving.
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const rr = R * (1.08 - t * 0.26);
    const tube = R * (0.22 - t * 0.045);
    const y = base + L * (0.04 + t * 0.42);
    const off = (i % 2 === 0 ? 1 : -1) * R * 0.07 * (1 - t);
    const profile: V2[] = [];
    for (let k = 0; k <= 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      profile.push([rr + Math.cos(a) * tube, Math.sin(a) * tube]);
    }
    const w = hardLathe(profile, 9, { capStart: false, capEnd: false, name: `turban${i}` });
    w.translate(off, y, z);
    g.parts.push(mkPart(w, 'cloth', pig, 'head', { name: `turban${i}`, rigid: true }));
  }

  // Loose end hanging over one shoulder.
  const grid: V3[][] = [];
  for (let r = 0; r < 4; r++) {
    const t = r / 3;
    grid.push([
      [R * (0.86 + t * 0.2), base + L * 0.36 - L * 0.9 * t, z + R * (0.3 + t * 0.4) - R * 0.16],
      [R * (0.86 + t * 0.2), base + L * 0.36 - L * 0.9 * t, z + R * (0.3 + t * 0.4) + R * 0.16],
    ]);
  }
  g.parts.push(
    mkPart(shell(grid, R * 0.04, { name: 'turbanTail' }), 'cloth', pig, 'head', {
      name: 'turbanTail',
      rigid: true,
    }),
  );

  g.points.crest = new THREE.Vector3(0, base + L * 0.52, z);
  g.points.top = new THREE.Vector3(0, base + L * 0.56, z);
  return g;
}

// ---------------------------------------------------------------------------
// The charioteer's fan crown
// ---------------------------------------------------------------------------

function fanCrown(o: HelmetOpts): PartGroup {
  const g = emptyGroup();
  const L = o.headLen;
  const R = Math.max(o.headWidth, o.headDepth) * 0.57;
  const z = o.z ?? 0;
  const base = o.baseY + L * 0.36;
  const pig = o.pigment ?? 'lacquer';

  // A low, wide crown — deliberately squat, so all the vertical interest comes
  // from the fan crest that sits on it.
  const bowl = hardLathe(
    [
      [R * 1.06, base],
      [R * 1.1, base + L * 0.12],
      [R * 0.98, base + L * 0.3],
      [R * 0.72, base + L * 0.42],
      [R * 0.5, base + L * 0.46],
    ],
    SEG,
    { phase: Math.PI / SEG, capStart: false, name: 'fanCrownBowl' },
  );
  bowl.translate(0, 0, z);
  g.parts.push(mkPart(bowl, 'lacquer', pig, 'head', { name: 'helmetBowl', rigid: true }));

  const rim = hardLathe(
    [
      [R * 1.08, base + L * 0.1],
      [R * 1.3, base + L * 0.03],
      [R * 1.28, base - L * 0.04],
      [R * 1.04, base - L * 0.02],
    ],
    SEG,
    { phase: Math.PI / SEG, capStart: false, capEnd: false, name: 'fanCrownRim' },
  );
  rim.translate(0, 0, z);
  g.parts.push(
    mkPart(rim, 'gold', o.metalPigment ?? 'metal', 'head', { name: 'helmetRim', rigid: true }),
  );

  // Socket the fan sits in — a slot across the crown, not a round hole.
  const slot = bevelSlab({ w: R * 0.24, h: L * 0.14, d: R * 0.5, bevel: R * 0.04 });
  place(slot, { pos: [0, base + L * 0.46, z], rot: [Math.PI / 2, 0, 0] });
  g.parts.push(
    mkPart(slot, 'gold', o.metalPigment ?? 'metal', 'head', { name: 'crestSocket', rigid: true }),
  );

  if (o.cheeks) g.parts.push(...cheekLappets(o, R, base).parts);

  g.points.crest = new THREE.Vector3(0, base + L * 0.5, z);
  g.points.top = new THREE.Vector3(0, base + L * 0.52, z);
  return g;
}

// ---------------------------------------------------------------------------
// Lappets
// ---------------------------------------------------------------------------

/** 頓項 — the hinged cheek plates. Two shells, hanging beside the jaw. */
function cheekLappets(o: HelmetOpts, R: number, base: number): PartGroup {
  const g = emptyGroup();
  const L = o.headLen;
  const z = o.z ?? 0;
  for (const s of [-1, 1]) {
    const grid: V3[][] = [];
    for (let r = 0; r < 3; r++) {
      const t = r / 2;
      const y = base - L * (0.04 + t * 0.42);
      const w = R * (1.0 - t * 0.18);
      grid.push([
        [s * w, y, z + R * (0.52 - t * 0.1)],
        [s * w * 1.03, y, z + R * 0.05],
        [s * w * 0.96, y, z - R * (0.44 + t * 0.05)],
      ]);
    }
    g.parts.push(
      mkPart(shell(grid, R * 0.05, { name: 'cheekLappet', flip: s > 0 }), 'lacquer', o.pigment ?? 'lacquer', 'head', {
        name: 'cheekLappet',
        rigid: true,
      }),
    );
  }
  return g;
}

/** The neck lappet at the back of a helmet — stops the head reading as a ball. */
function napeLappet(o: HelmetOpts, R: number, base: number): PartGroup {
  const g = emptyGroup();
  const L = o.headLen;
  const z = o.z ?? 0;
  const grid: V3[][] = [];
  for (let r = 0; r < 3; r++) {
    const t = r / 2;
    const y = base - L * (0.02 + t * 0.36);
    const row: V3[] = [];
    for (let c = 0; c < 5; c++) {
      const u = (c / 4) * 2 - 1;
      const a = u * 1.15;
      row.push([
        Math.sin(a) * R * (1.02 + t * 0.12),
        y,
        z + Math.cos(a) * R * (1.02 + t * 0.16),
      ]);
    }
    grid.push(row);
  }
  g.parts.push(
    mkPart(shell(grid, R * 0.05, { name: 'napeLappet' }), 'lacquer', o.pigment ?? 'lacquer', 'head', {
      name: 'napeLappet',
      rigid: true,
      allow: ['neck'],
    }),
  );
  return g;
}

// ---------------------------------------------------------------------------
// Crests
// ---------------------------------------------------------------------------

export interface CrestOpts {
  style: CrestStyle;
  /** Socket position, rig space — take it from `helmet().points.crest`. */
  at: V3;
  /** Overall height of the crest. */
  height: number;
  /** Overall width. */
  width: number;
  pigment?: PartPigment;
  metalPigment?: PartPigment;
  /** For 'buyao': the two anchor points from `helmet().points.buyaoL/R`. */
  anchors?: [V3, V3];
}

/**
 * The thing standing on top of the helmet. Each style is a different *kind* of
 * shape — a spike, a notch, a blade, a socket, a fringe — chosen so that a
 * viewer separating two units by their crowns is separating shapes and not
 * sizes.
 */
export function crest(o: CrestOpts): PartGroup {
  switch (o.style) {
    case 'none':
      return emptyGroup();
    case 'plume':
      return plume(o);
    case 'hornPair':
      return hornPair(o);
    case 'fanCrest':
      return fanCrest(o);
    case 'standardSocket':
      return standardSocket(o);
    case 'buyao':
      return buyao(o);
  }
}

/** 纓 — a single upright horsehair plume, raked slightly back. */
function plume(o: CrestOpts): PartGroup {
  const g = emptyGroup();
  const H = o.height;
  const W = o.width;
  const grid: V3[][] = [];
  const rows = 5;
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    // Widens then tapers; rakes backward (+Z) as it rises.
    const w = W * (0.28 + Math.sin(t * Math.PI) * 0.72) * (1 - t * 0.4);
    const y = o.at[1] + H * t;
    const z = o.at[2] + H * t * t * 0.34;
    grid.push([
      [o.at[0] - w, y, z - w * 0.35],
      [o.at[0], y, z + w * 0.15],
      [o.at[0] + w, y, z - w * 0.35],
    ]);
  }
  g.parts.push(
    mkPart(shell(grid, W * 0.16, { name: 'plume' }), 'hair', o.pigment ?? 'accent', 'head', {
      name: 'plume',
      rigid: true,
      noSilk: true,
    }),
  );
  const collar = hardLathe(
    [
      [W * 0.28, o.at[1] - H * 0.02],
      [W * 0.36, o.at[1] + H * 0.06],
      [W * 0.24, o.at[1] + H * 0.12],
    ],
    6,
    { capStart: false, capEnd: false, name: 'plumeCollar' },
  );
  collar.translate(o.at[0], 0, o.at[2]);
  g.parts.push(
    mkPart(collar, 'gold', o.metalPigment ?? 'metal', 'head', { name: 'plumeCollar', rigid: true }),
  );
  return g;
}

/** Paired forward-swept horns. Reads as a notch — unmistakable in silhouette. */
function hornPair(o: CrestOpts): PartGroup {
  const g = emptyGroup();
  const right = horn(o, 1);
  g.parts.push(
    mkPart(right, 'ivory', o.pigment ?? 'shellWhite', 'head', { name: 'hornR', rigid: true }),
  );
  g.parts.push(
    mkPart(mirrorX(right), 'ivory', o.pigment ?? 'shellWhite', 'head', {
      name: 'hornL',
      rigid: true,
    }),
  );
  return g;
}

/** One horn: a taper swept along an up-and-forward curve. `s` selects the side. */
function horn(o: CrestOpts, s: number): THREE.BufferGeometry {
  const H = o.height;
  const W = o.width;
  const n = 5;
  const stations = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    stations.push({
      p: [
        o.at[0] + s * W * (0.24 + t * 0.72),
        o.at[1] + H * (t * 0.9 - t * t * 0.32),
        o.at[2] - H * t * t * 0.5,
      ] as V3,
      rx: W * 0.2 * (1 - t * 0.86) + W * 0.02,
      squareness: 0.4,
    });
  }
  return sweep(stations, { sides: 5, name: 'horn' });
}

/** A flat vertical fan — the widest crown in the cast. */
function fanCrest(o: CrestOpts): PartGroup {
  const g = emptyGroup();
  const H = o.height;
  const W = o.width;
  // Outline in XY, extruded thin along Z, then stood upright across the head.
  const poly: V2[] = [];
  const ribs = 7;
  for (let i = 0; i <= ribs; i++) {
    const t = i / ribs;
    const a = (t - 0.5) * 2.0;
    // Scalloped upper edge: every rib tip is a point, every valley a notch.
    const rr = H * (0.92 + (i % 2 === 0 ? 0.08 : -0.06));
    poly.push([Math.sin(a) * W * 0.5 * (rr / H), Math.cos(a) * rr * 0.72]);
  }
  poly.push([W * 0.22, -H * 0.06]);
  poly.push([-W * 0.22, -H * 0.06]);
  const fan = extrudePlanar(poly.reverse(), {
    depth: W * 0.07,
    chamfer: W * 0.02,
    name: 'fanCrest',
  });
  place(fan, { pos: [o.at[0], o.at[1], o.at[2]], rot: [0, 0, 0] });
  g.parts.push(mkPart(fan, 'lacquer', o.pigment ?? 'lacquer', 'head', { name: 'fanCrest', rigid: true }));

  // Gold spine along the fan's base so it does not float.
  const spine = bevelSlab({ w: W * 0.9, h: H * 0.1, d: W * 0.1, bevel: W * 0.02 });
  place(spine, { pos: [o.at[0], o.at[1] + H * 0.02, o.at[2]] });
  g.parts.push(
    mkPart(spine, 'gold', o.metalPigment ?? 'metal', 'head', { name: 'fanSpine', rigid: true }),
  );
  return g;
}

/** A short socket carrying a small pennon — for units that fly a mark. */
function standardSocket(o: CrestOpts): PartGroup {
  const g = emptyGroup();
  const H = o.height;
  const W = o.width;
  const tube = hardLathe(
    [
      [W * 0.16, o.at[1]],
      [W * 0.18, o.at[1] + H * 0.5],
      [W * 0.12, o.at[1] + H * 0.62],
    ],
    6,
    { capStart: false, name: 'socket' },
  );
  tube.translate(o.at[0], 0, o.at[2]);
  g.parts.push(
    mkPart(tube, 'iron', o.metalPigment ?? 'metal', 'head', { name: 'crestSocket', rigid: true }),
  );
  const grid: V3[][] = [];
  for (let r = 0; r < 3; r++) {
    const t = r / 2;
    grid.push([
      [o.at[0], o.at[1] + H * (0.6 - t * 0.34), o.at[2] + W * (0.1 + t * 0.2)],
      [o.at[0], o.at[1] + H * (0.6 - t * 0.34), o.at[2] + W * (0.9 + t * 0.5)],
    ]);
  }
  g.parts.push(
    mkPart(shell(grid, W * 0.03, { name: 'pennon' }), 'cloth', o.pigment ?? 'accent', 'head', {
      name: 'pennon',
      rigid: true,
    }),
  );
  return g;
}

/** 步搖 — the general's dangling bead strands, plus a tassel at the apex. */
function buyao(o: CrestOpts): PartGroup {
  const H = o.height;
  const W = o.width;
  const anchors = o.anchors ?? [
    [o.at[0] - W * 0.5, o.at[1] - H * 0.2, o.at[2]],
    [o.at[0] + W * 0.5, o.at[1] - H * 0.2, o.at[2]],
  ];
  const g = mergeGroups(
    tassel({
      at: [o.at[0], o.at[1] + H * 0.06, o.at[2]],
      length: H * 0.5,
      r: W * 0.24,
      strands: 8,
      boneHint: 'head',
      pigment: o.pigment ?? 'accent',
    }),
  );
  for (const a of anchors) {
    g.instanced.push(
      ...beadStrand({
        at: a,
        length: H * 0.72,
        beads: 6,
        r: W * 0.075,
        boneHint: 'head',
        pigment: o.metalPigment ?? 'metal',
        drift: [Math.sign(a[0] - o.at[0]) * W * 0.1, 0, W * 0.06],
      }).instanced,
    );
  }
  return g;
}
