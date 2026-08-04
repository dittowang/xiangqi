/**
 * Mounts: the horse 馬 and the war elephant 象.
 *
 * Both are built as *quadrupeds with their own bone chains*, published in
 * `PartGroup.bones` and surfaced by the factory as `UnitInstance.mountBones`.
 * The animator drives them directly — there is no attempt to retarget the
 * humanoid rig onto four legs, which never works and would put a shoulder blade
 * where a stifle belongs.
 *
 * Leg construction is shared. A real quadruped leg has four segments and the
 * joints do not line up front to back: the horse's front knee (carpus) is a
 * wrist and bends backward, the hind hock bends forward. `quadrupedLeg` takes
 * four explicit joint positions and builds whatever chain you hand it, so the
 * caller decides the anatomy and this file only decides how it is skinned. Each
 * segment is rigid on its own bone, which is right — a horse's cannon bone does
 * not deform.
 *
 * SIZING. Everything is in rig units, the same units as the rider's `height`.
 * For the 馬 unit the rider's height is about 0.97 and the horse's withers about
 * 1.08, so the horse is a little taller than the man is — which is correct, and
 * which is why the two must never be sized independently.
 *
 * Reference: Han pictorial stone relief for the compact, heavy-necked horse
 * with a short back and a hard mane crest; Han bronze and lacquer elephants for
 * the columnar leg and the low, heavy head.
 */

import * as THREE from 'three';
import { bevelSlab, hardLathe, loft, mirrorX, place, ring, shell, sweep } from './prim.ts';
import { boss, ferrule, piping } from './trim.ts';
import { rivetArc } from './rivets.ts';
import {
  emptyGroup,
  mergeGroups,
  mkPart,
  type BoneSpec,
  type Part,
  type PartGroup,
  type PartPigment,
  type V3,
} from './types.ts';

const HIDE = 'ochre' as const;
const HAIR = 'ink' as const;
const BONE_WHITE = 'shellWhite' as const;

// ---------------------------------------------------------------------------
// Shared leg
// ---------------------------------------------------------------------------

export interface QuadLegOpts {
  /** Bone-name prefix, e.g. `'horse.legFL'`. Bones become `<prefix>01..04`. */
  prefix: string;
  /** Bone the top of the leg hangs from. */
  parent: string;
  /** Four joints from body to ground: shoulder/hip, knee/hock, fetlock, hoof. */
  joints: [V3, V3, V3, V3];
  /** Radii at each joint, plus one for the hoof. */
  radii: [number, number, number, number];
  sides?: number;
  cls?: Part['cls'];
  pigment?: PartPigment;
  hoofPigment?: PartPigment;
  /** Height of the hoof block. */
  hoofHeight?: number;
  /** Flatten the leg front-to-back; a horse's cannon is not round. */
  flatten?: number;
}

export function quadrupedLeg(o: QuadLegOpts): PartGroup {
  const g = emptyGroup();
  const sides = o.sides ?? 6;
  const flat = o.flatten ?? 0.86;
  const [j0, j1, j2, j3] = o.joints;
  const [r0, r1, r2, r3] = o.radii;
  const cls = o.cls ?? 'leather';
  const pig = o.pigment ?? HIDE;

  const names = [`${o.prefix}01`, `${o.prefix}02`, `${o.prefix}03`, `${o.prefix}04`];
  g.bones.push(
    { name: names[0], parent: o.parent, position: j0 },
    { name: names[1], parent: names[0], position: j1 },
    { name: names[2], parent: names[1], position: j2 },
    { name: names[3], parent: names[2], position: j3 },
  );

  const seg = (a: V3, b: V3, ra: number, rb: number, bone: string, bulge: number, name: string) => {
    const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const rm = ((ra + rb) / 2) * bulge;
    const geo = sweep(
      [
        { p: a, rx: ra, rz: ra * flat, squareness: 0.35 },
        { p: mid, rx: rm, rz: rm * flat, squareness: 0.35 },
        { p: b, rx: rb, rz: rb * flat, squareness: 0.35 },
      ],
      { sides, name },
    );
    g.parts.push(
      mkPart(geo, cls, pig, 'root', { name, rigid: true, mountBone: bone }),
    );
  };

  seg(j0, j1, r0, r1, names[0], 1.12, `${o.prefix}:upper`);
  seg(j1, j2, r1, r2, names[1], 1.06, `${o.prefix}:lower`);
  seg(j2, j3, r2, r3, names[2], 1.0, `${o.prefix}:pastern`);

  // Hoof: a splayed block, not a cylinder — it is the ground contact and it has
  // to read as a hard edge against the board.
  const hh = o.hoofHeight ?? r3 * 2.1;
  const hoof = loft(
    [
      ring({ rx: r3 * 1.05, rz: r3 * 1.0, y: j3[1], cx: j3[0], cz: j3[2], sides, squareness: 0.5 }),
      ring({
        rx: r3 * 1.42,
        rz: r3 * 1.34,
        y: j3[1] - hh * 0.72,
        cx: j3[0],
        cz: j3[2] - r3 * 0.12,
        sides,
        squareness: 0.55,
      }),
      ring({
        rx: r3 * 1.38,
        rz: r3 * 1.3,
        y: Math.max(0, j3[1] - hh),
        cx: j3[0],
        cz: j3[2] - r3 * 0.14,
        sides,
        squareness: 0.6,
      }),
    ],
    { name: `${o.prefix}:hoof` },
  );
  g.parts.push(
    mkPart(hoof, 'stone', o.hoofPigment ?? BONE_WHITE, 'root', {
      name: `${o.prefix}:hoof`,
      rigid: true,
      mountBone: names[3],
    }),
  );
  return g;
}

// ---------------------------------------------------------------------------
// 馬 — the horse
// ---------------------------------------------------------------------------

export interface HorseOpts {
  /** Height of the withers above the ground, rig units. */
  withers: number;
  /** Chest to croup, rig units. Han relief horses are short-backed. */
  length: number;
  /** Barrel half-width. */
  width?: number;
  /** Where the horse stands, rig space. Default: centred on the origin. */
  at?: V3;
  hidePigment?: PartPigment;
  manePigment?: PartPigment;
  /** Lamellar barding over the chest and croup. */
  barding?: boolean;
  harnessPigment?: PartPigment;
  metalPigment?: PartPigment;
  sides?: number;
}

/**
 * The horse. Built facing -Z with the withers over the origin, on the ground.
 *
 * Publishes `seat` (where the rider's pelvis goes), `reinL`/`reinR` (the bit
 * rings), `withers`, `muzzle` and `croup`. Bones: `horse.spine`, `horse.chest`,
 * `horse.neck`, `horse.head`, `horse.tail01..03`, and `horse.legFL01..04` for
 * each of FL, FR, HL, HR.
 */
export function horse(o: HorseOpts): PartGroup {
  const g = emptyGroup();
  const W = o.withers;
  const L = o.length;
  const hw = o.width ?? W * 0.26;
  const at = o.at ?? [0, 0, 0];
  const sides = o.sides ?? 8;
  const hide = o.hidePigment ?? HIDE;
  const mane = o.manePigment ?? HAIR;

  const P = (x: number, y: number, z: number): V3 => [at[0] + x, at[1] + y, at[2] + z];

  // -- bones ---------------------------------------------------------------
  const barrelY = W * 0.74;
  g.bones.push(
    { name: 'horse.spine', parent: 'root', position: P(0, barrelY, L * 0.28) },
    { name: 'horse.chest', parent: 'horse.spine', position: P(0, barrelY + W * 0.05, -L * 0.26) },
    { name: 'horse.neck', parent: 'horse.chest', position: P(0, W * 0.9, -L * 0.42) },
    { name: 'horse.head', parent: 'horse.neck', position: P(0, W * 1.16, -L * 0.66) },
    { name: 'horse.tail01', parent: 'horse.spine', position: P(0, barrelY + W * 0.06, L * 0.46) },
    { name: 'horse.tail02', parent: 'horse.tail01', position: P(0, barrelY - W * 0.1, L * 0.58) },
    { name: 'horse.tail03', parent: 'horse.tail02', position: P(0, barrelY - W * 0.34, L * 0.62) },
  );

  // -- barrel --------------------------------------------------------------
  // Seven stations: brisket, chest, girth, belly, loin, croup, dock. The girth
  // is the widest and the loin is pinched, which is what gives the Han horse
  // its heavy front and light back.
  const barrel = sweep(
    [
      { p: P(0, barrelY + W * 0.04, -L * 0.44), rx: hw * 0.52, rz: W * 0.16, squareness: 0.45 },
      { p: P(0, barrelY + W * 0.03, -L * 0.3), rx: hw * 0.88, rz: W * 0.24, squareness: 0.5 },
      { p: P(0, barrelY, -L * 0.1), rx: hw * 1.0, rz: W * 0.27, squareness: 0.5 },
      { p: P(0, barrelY - W * 0.02, L * 0.08), rx: hw * 0.96, rz: W * 0.26, squareness: 0.5 },
      { p: P(0, barrelY + W * 0.02, L * 0.26), rx: hw * 0.82, rz: W * 0.23, squareness: 0.5 },
      { p: P(0, barrelY + W * 0.05, L * 0.42), rx: hw * 0.86, rz: W * 0.22, squareness: 0.5 },
      { p: P(0, barrelY - W * 0.02, L * 0.52), rx: hw * 0.44, rz: W * 0.12, squareness: 0.5 },
    ],
    { sides, name: 'horseBarrel' },
  );
  g.parts.push(
    mkPart(barrel, 'leather', hide, 'root', { name: 'horseBarrel', rigid: true, mountBone: 'horse.spine' }),
  );

  // -- neck ----------------------------------------------------------------
  // A Han horse's neck is a wedge: deep at the shoulder, thin at the poll, with
  // a hard crest along the top. Sections are squared so the crest is an edge.
  const neck = sweep(
    [
      { p: P(0, barrelY + W * 0.12, -L * 0.36), rx: hw * 0.72, rz: W * 0.24, squareness: 0.55 },
      { p: P(0, W * 0.95, -L * 0.47), rx: hw * 0.56, rz: W * 0.2, squareness: 0.6 },
      { p: P(0, W * 1.1, -L * 0.58), rx: hw * 0.42, rz: W * 0.15, squareness: 0.6 },
      { p: P(0, W * 1.18, -L * 0.66), rx: hw * 0.34, rz: W * 0.12, squareness: 0.6 },
    ],
    { sides: 7, capStart: false, name: 'horseNeck' },
  );
  g.parts.push(
    mkPart(neck, 'leather', hide, 'root', { name: 'horseNeck', rigid: true, mountBone: 'horse.neck' }),
  );

  // -- head ----------------------------------------------------------------
  const headBase = P(0, W * 1.18, -L * 0.66);
  const head = loft(
    [
      ring({ rx: hw * 0.34, rz: W * 0.13, y: headBase[1] + W * 0.03, cz: headBase[2] + W * 0.02, sides: 6, squareness: 0.6 }),
      ring({ rx: hw * 0.36, rz: W * 0.15, y: headBase[1] - W * 0.02, cz: headBase[2] - W * 0.06, sides: 6, squareness: 0.6 }),
      ring({ rx: hw * 0.3, rz: W * 0.12, y: headBase[1] - W * 0.12, cz: headBase[2] - W * 0.2, sides: 6, squareness: 0.62 }),
      ring({ rx: hw * 0.26, rz: W * 0.09, y: headBase[1] - W * 0.2, cz: headBase[2] - W * 0.32, sides: 6, squareness: 0.66 }),
      ring({ rx: hw * 0.28, rz: W * 0.1, y: headBase[1] - W * 0.24, cz: headBase[2] - W * 0.4, sides: 6, squareness: 0.7 }),
    ],
    { name: 'horseHead' },
  );
  g.parts.push(
    mkPart(head, 'leather', hide, 'root', { name: 'horseHead', rigid: true, mountBone: 'horse.head' }),
  );

  // Jaw block: the cheek is a distinct plane in relief carving, so it is a
  // distinct piece of geometry here.
  const jaw = bevelSlab({ w: hw * 0.68, h: W * 0.16, d: W * 0.16, bevel: W * 0.035 });
  place(jaw, { pos: [headBase[0], headBase[1] - W * 0.09, headBase[2] - W * 0.12], rot: [0.3, 0, 0] });
  g.parts.push(
    mkPart(jaw, 'leather', hide, 'root', { name: 'horseJaw', rigid: true, mountBone: 'horse.head' }),
  );

  // Ears.
  for (const s of [-1, 1]) {
    const ear = hardLathe(
      [
        [hw * 0.11, headBase[1] + W * 0.02],
        [hw * 0.09, headBase[1] + W * 0.1],
        [hw * 0.005, headBase[1] + W * 0.2],
      ],
      5,
      { capStart: false, name: 'horseEar' },
    );
    ear.translate(s * hw * 0.2, 0, headBase[2] + W * 0.04);
    g.parts.push(
      mkPart(ear, 'leather', hide, 'root', { name: 'horseEar', rigid: true, mountBone: 'horse.head' }),
    );
  }

  // -- mane ----------------------------------------------------------------
  // A hogged crest, cut square — Han cavalry horses are shown with a stiff,
  // upright brush along the neck, which reads far better in silhouette than
  // flowing hair would.
  {
    const grid: V3[][] = [];
    const n = 6;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const y = barrelY + W * 0.2 + t * (W * 1.02 - barrelY - W * 0.16);
      const z = at[2] - L * (0.33 + t * 0.31);
      const h = W * (0.14 - t * 0.05);
      grid.push([
        [at[0] - hw * 0.06, y + h, z],
        [at[0], y + h * 1.25, z],
        [at[0] + hw * 0.06, y + h, z],
      ]);
    }
    g.parts.push(
      mkPart(shell(grid, hw * 0.04, { name: 'horseMane' }), 'hair', mane, 'root', {
        name: 'horseMane',
        rigid: true,
        mountBone: 'horse.neck',
      }),
    );
    // Forelock between the ears.
    const fl = bevelSlab({ w: hw * 0.2, h: W * 0.13, d: hw * 0.06, bevel: hw * 0.02 });
    place(fl, { pos: [at[0], headBase[1] + W * 0.06, headBase[2] + W * 0.03], rot: [0.5, 0, 0] });
    g.parts.push(
      mkPart(fl, 'hair', mane, 'root', { name: 'horseForelock', rigid: true, mountBone: 'horse.head' }),
    );
  }

  // -- tail ----------------------------------------------------------------
  {
    const grid: V3[][] = [];
    const n = 5;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const y = barrelY + W * 0.06 - t * W * 0.62;
      const z = at[2] + L * (0.5 + t * 0.14 - t * t * 0.06);
      const w = hw * (0.16 + Math.sin(t * 2.6) * 0.16);
      grid.push([
        [at[0] - w, y, z - w * 0.4],
        [at[0], y, z + w * 0.5],
        [at[0] + w, y, z - w * 0.4],
      ]);
    }
    g.parts.push(
      mkPart(shell(grid, hw * 0.05, { name: 'horseTail' }), 'hair', mane, 'root', {
        name: 'horseTail',
        rigid: true,
        mountBone: 'horse.tail01',
      }),
    );
  }

  // -- legs ----------------------------------------------------------------
  const legR = W * 0.052;
  for (const side of [-1, 1]) {
    // Front: the carpus is high and the cannon below it is long and straight.
    const front = quadrupedLeg({
      prefix: side < 0 ? 'horse.legFL' : 'horse.legFR',
      parent: 'horse.chest',
      joints: [
        P(side * hw * 0.66, W * 0.78, -L * 0.28),
        P(side * hw * 0.7, W * 0.46, -L * 0.3),
        P(side * hw * 0.7, W * 0.17, -L * 0.29),
        P(side * hw * 0.7, W * 0.07, -L * 0.29),
      ],
      radii: [legR * 1.9, legR * 1.15, legR * 0.82, legR * 0.9],
      pigment: hide,
      sides: 6,
    });
    // Hind: the stifle is forward and the hock is well back. That reversed
    // angle is the single most recognisable thing about a horse's outline.
    const hind = quadrupedLeg({
      prefix: side < 0 ? 'horse.legHL' : 'horse.legHR',
      parent: 'horse.spine',
      joints: [
        P(side * hw * 0.62, W * 0.76, L * 0.36),
        P(side * hw * 0.66, W * 0.5, L * 0.28),
        P(side * hw * 0.66, W * 0.2, L * 0.42),
        P(side * hw * 0.66, W * 0.07, L * 0.4),
      ],
      radii: [legR * 2.2, legR * 1.3, legR * 0.86, legR * 0.92],
      pigment: hide,
      sides: 6,
    });
    g.parts.push(...front.parts, ...hind.parts);
    g.bones.push(...front.bones, ...hind.bones);
  }

  // -- tack ----------------------------------------------------------------
  g.parts.push(...saddle({ seatY: barrelY + W * 0.28, z: at[2] - L * 0.02, hw, W, pigment: o.harnessPigment }).parts);
  g.parts.push(
    ...bridle({
      headBase,
      hw,
      W,
      L,
      at,
      pigment: o.harnessPigment ?? 'leather',
      metal: o.metalPigment ?? 'metal',
    }).parts,
  );

  if (o.barding) {
    // A chest plate and a croup plate — enough to read as armoured without
    // burying the animal's shape.
    const chestPlate = shell(
      [
        [P(-hw * 0.9, barrelY + W * 0.2, -L * 0.34), P(0, barrelY + W * 0.24, -L * 0.42), P(hw * 0.9, barrelY + W * 0.2, -L * 0.34)],
        [P(-hw * 0.95, barrelY - W * 0.14, -L * 0.3), P(0, barrelY - W * 0.1, -L * 0.4), P(hw * 0.95, barrelY - W * 0.14, -L * 0.3)],
        [P(-hw * 0.8, barrelY - W * 0.4, -L * 0.26), P(0, barrelY - W * 0.36, -L * 0.34), P(hw * 0.8, barrelY - W * 0.4, -L * 0.26)],
      ],
      W * 0.014,
      { name: 'barding', flip: true },
    );
    g.parts.push(
      mkPart(chestPlate, 'lacquer', 'lacquer', 'root', {
        name: 'barding',
        rigid: true,
        mountBone: 'horse.chest',
      }),
    );
    g.instanced.push(
      ...rivetArc({
        centre: P(0, barrelY + W * 0.02, -L * 0.34),
        rx: hw * 0.92,
        rz: W * 0.28,
        count: 8,
        arc: Math.PI,
        arcCentre: -Math.PI / 2,
        boneHint: 'root',
        mountBone: 'horse.chest',
        pigment: o.metalPigment ?? 'metal',
        rivet: { r: W * 0.02, h: W * 0.012 },
        name: 'bardingRivets',
      }).instanced,
    );
  }

  g.points.seat = new THREE.Vector3(at[0], at[1] + barrelY + W * 0.34, at[2] - L * 0.04);
  g.points.withers = new THREE.Vector3(at[0], at[1] + W, at[2] - L * 0.3);
  g.points.croup = new THREE.Vector3(at[0], at[1] + barrelY + W * 0.08, at[2] + L * 0.42);
  g.points.muzzle = new THREE.Vector3(headBase[0], headBase[1] - W * 0.24, headBase[2] - W * 0.44);
  g.points.reinL = new THREE.Vector3(headBase[0] - hw * 0.3, headBase[1] - W * 0.16, headBase[2] - W * 0.3);
  g.points.reinR = new THREE.Vector3(headBase[0] + hw * 0.3, headBase[1] - W * 0.16, headBase[2] - W * 0.3);

  g.attach.push(
    { name: 'mountSeat', bone: 'horse.spine', position: [g.points.seat.x, g.points.seat.y, g.points.seat.z] },
    { name: 'reinL', bone: 'horse.head', position: [g.points.reinL.x, g.points.reinL.y, g.points.reinL.z] },
    { name: 'reinR', bone: 'horse.head', position: [g.points.reinR.x, g.points.reinR.y, g.points.reinR.z] },
  );
  return g;
}

function saddle(o: {
  seatY: number;
  z: number;
  hw: number;
  W: number;
  pigment?: PartPigment;
}): PartGroup {
  const g = emptyGroup();
  const { hw, W } = o;
  // Han saddles have a high pommel and cantle — the two humps either side of
  // the seat are a strong profile detail at board distance.
  const pad = loft(
    [
      ring({ rx: hw * 1.02, rz: W * 0.2, y: o.seatY - W * 0.22, cz: o.z, sides: 8, squareness: 0.55 }),
      ring({ rx: hw * 1.06, rz: W * 0.22, y: o.seatY - W * 0.08, cz: o.z, sides: 8, squareness: 0.55 }),
      ring({ rx: hw * 0.82, rz: W * 0.2, y: o.seatY, cz: o.z, sides: 8, squareness: 0.55 }),
    ],
    { capStart: false, name: 'saddle' },
  );
  g.parts.push(
    mkPart(pad, 'leather', o.pigment ?? 'leather', 'root', {
      name: 'saddle',
      rigid: true,
      mountBone: 'horse.spine',
    }),
  );
  for (const s of [-1, 1]) {
    const horn = bevelSlab({ w: hw * 1.5, h: W * 0.16, d: W * 0.07, bevel: W * 0.03 });
    place(horn, { pos: [0, o.seatY + W * 0.06, o.z + s * W * 0.2], rot: [s * 0.35, 0, 0] });
    g.parts.push(
      mkPart(horn, 'leather', o.pigment ?? 'leather', 'root', {
        name: 'saddleHorn',
        rigid: true,
        mountBone: 'horse.spine',
      }),
    );
  }
  return g;
}

function bridle(o: {
  headBase: V3;
  hw: number;
  W: number;
  L: number;
  at: V3;
  pigment: PartPigment;
  metal: PartPigment;
}): PartGroup {
  const g = emptyGroup();
  const { headBase, hw, W } = o;
  // Cheek strap and noseband as thin swept cords — cheap, and they turn a bare
  // head into a bridled one.
  g.parts.push(
    piping({
      path: [
        [headBase[0] - hw * 0.34, headBase[1] + W * 0.01, headBase[2] + W * 0.01],
        [headBase[0] - hw * 0.32, headBase[1] - W * 0.1, headBase[2] - W * 0.16],
        [headBase[0] - hw * 0.28, headBase[1] - W * 0.18, headBase[2] - W * 0.3],
      ],
      r: W * 0.014,
      boneHint: 'root',
      mountBone: 'horse.head',
      pigment: o.pigment,
      cls: 'leather',
      name: 'bridleL',
    }),
  );
  g.parts.push(
    piping({
      path: [
        [headBase[0] + hw * 0.34, headBase[1] + W * 0.01, headBase[2] + W * 0.01],
        [headBase[0] + hw * 0.32, headBase[1] - W * 0.1, headBase[2] - W * 0.16],
        [headBase[0] + hw * 0.28, headBase[1] - W * 0.18, headBase[2] - W * 0.3],
      ],
      r: W * 0.014,
      boneHint: 'root',
      mountBone: 'horse.head',
      pigment: o.pigment,
      cls: 'leather',
      name: 'bridleR',
    }),
  );
  g.parts.push(
    ferrule({
      at: [headBase[0], headBase[1] - W * 0.2, headBase[2] - W * 0.32],
      r: hw * 0.3,
      height: W * 0.03,
      proud: W * 0.008,
      boneHint: 'root',
      mountBone: 'horse.head',
      pigment: o.pigment,
      rot: [Math.PI / 2, 0, 0],
      sides: 6,
    }),
  );
  for (const s of [-1, 1]) {
    g.parts.push(
      boss({
        at: [headBase[0] + s * hw * 0.32, headBase[1] - W * 0.14, headBase[2] - W * 0.24],
        r: W * 0.03,
        height: W * 0.016,
        boneHint: 'root',
        mountBone: 'horse.head',
        pigment: o.metal,
        rot: [0, 0, s * Math.PI * 0.5],
        sides: 6,
      }),
    );
  }
  return g;
}

// ---------------------------------------------------------------------------
// 象 — the war elephant
// ---------------------------------------------------------------------------

export interface ElephantOpts {
  /** Shoulder height, rig units. */
  shoulder: number;
  /** Body length, chest to rump. */
  length: number;
  width?: number;
  at?: V3;
  hidePigment?: PartPigment;
  tuskPigment?: PartPigment;
  /** Segments in the trunk. The brief's floor is 8; more is smoother to sweep. */
  trunkSegments?: number;
  /** Build the howdah platform on the back. */
  howdah?: boolean;
  howdahPigment?: PartPigment;
  metalPigment?: PartPigment;
  clothPigment?: PartPigment;
}

/**
 * The war elephant. Heavy body, columnar legs, flat plate ears, tusks, a
 * **segmented trunk** exposed as a chain of bones so the animator can sweep it,
 * and a howdah platform for the mahout.
 *
 * Bones: `elephant.spine`, `elephant.chest`, `elephant.neck`, `elephant.head`,
 * `elephant.trunk01..NN`, `elephant.earL/R`, `elephant.tail`, and
 * `elephant.legFL01..04` for each of FL, FR, HL, HR.
 *
 * The trunk chain is straight in bind pose and curls only under animation. That
 * is deliberate: a bind-pose curl bakes a direction into the skinning and the
 * trunk then fights any sweep that goes the other way.
 */
export function elephant(o: ElephantOpts): PartGroup {
  const g = emptyGroup();
  const S = o.shoulder;
  const L = o.length;
  const hw = o.width ?? S * 0.31;
  const at = o.at ?? [0, 0, 0];
  const hide = o.hidePigment ?? 'stone';
  const segs = Math.max(8, o.trunkSegments ?? 8);
  const P = (x: number, y: number, z: number): V3 => [at[0] + x, at[1] + y, at[2] + z];

  const backY = S * 0.9;

  g.bones.push(
    { name: 'elephant.spine', parent: 'root', position: P(0, backY * 0.82, L * 0.16) },
    { name: 'elephant.chest', parent: 'elephant.spine', position: P(0, backY * 0.84, -L * 0.24) },
    { name: 'elephant.neck', parent: 'elephant.chest', position: P(0, backY * 0.86, -L * 0.42) },
    { name: 'elephant.head', parent: 'elephant.neck', position: P(0, backY * 0.82, -L * 0.56) },
    { name: 'elephant.tail', parent: 'elephant.spine', position: P(0, backY * 0.8, L * 0.44) },
    { name: 'elephant.earL', parent: 'elephant.head', position: P(-hw * 0.62, backY * 0.84, -L * 0.52) },
    { name: 'elephant.earR', parent: 'elephant.head', position: P(hw * 0.62, backY * 0.84, -L * 0.52) },
  );

  // -- body ----------------------------------------------------------------
  const body = sweep(
    [
      { p: P(0, backY * 0.78, -L * 0.46), rx: hw * 0.72, rz: S * 0.24, squareness: 0.55 },
      { p: P(0, backY * 0.8, -L * 0.3), rx: hw * 0.98, rz: S * 0.32, squareness: 0.55 },
      { p: P(0, backY * 0.82, -L * 0.08), rx: hw * 1.04, rz: S * 0.34, squareness: 0.5 },
      { p: P(0, backY * 0.82, L * 0.14), rx: hw * 1.02, rz: S * 0.335, squareness: 0.5 },
      { p: P(0, backY * 0.8, L * 0.34), rx: hw * 0.9, rz: S * 0.3, squareness: 0.55 },
      { p: P(0, backY * 0.76, L * 0.46), rx: hw * 0.6, rz: S * 0.2, squareness: 0.6 },
    ],
    { sides: 8, name: 'elephantBody' },
  );
  g.parts.push(
    mkPart(body, 'leather', hide, 'root', {
      name: 'elephantBody',
      rigid: true,
      mountBone: 'elephant.spine',
    }),
  );

  // -- head ----------------------------------------------------------------
  // Domed skull with two lobes — the shape that says elephant before the trunk
  // or the ears do.
  const headY = backY * 0.84;
  const head = loft(
    [
      ring({ rx: hw * 0.62, rz: S * 0.16, y: headY - S * 0.26, cz: at[2] - L * 0.5, sides: 8, squareness: 0.55 }),
      ring({ rx: hw * 0.72, rz: S * 0.2, y: headY - S * 0.06, cz: at[2] - L * 0.53, sides: 8, squareness: 0.5 }),
      ring({ rx: hw * 0.68, rz: S * 0.18, y: headY + S * 0.1, cz: at[2] - L * 0.53, sides: 8, squareness: 0.5 }),
      ring({ rx: hw * 0.42, rz: S * 0.12, y: headY + S * 0.2, cz: at[2] - L * 0.51, sides: 8, squareness: 0.5 }),
    ],
    { name: 'elephantHead' },
  );
  g.parts.push(
    mkPart(head, 'leather', hide, 'root', {
      name: 'elephantHead',
      rigid: true,
      mountBone: 'elephant.head',
    }),
  );

  // -- ears ----------------------------------------------------------------
  // Flat plates, as the brief asks and as Han bronzes show them: a single big
  // shape with a scalloped trailing edge, not a modelled sheet.
  for (const s of [-1, 1]) {
    const grid: V3[][] = [];
    for (let r = 0; r < 4; r++) {
      const t = r / 3;
      const row: V3[] = [];
      for (let c = 0; c < 3; c++) {
        const u = c / 2;
        const flare = 0.35 + Math.sin(t * Math.PI) * 0.75;
        const scallop = c === 2 ? Math.sin(t * 7) * S * 0.02 : 0;
        row.push(
          P(
            s * (hw * 0.6 + u * hw * flare),
            headY + S * 0.16 - t * S * 0.5,
            -L * 0.5 + u * L * 0.2 + scallop + t * L * 0.04,
          ),
        );
      }
      grid.push(row);
    }
    g.parts.push(
      mkPart(shell(grid, S * 0.012, { name: 'elephantEar', flip: s > 0 }), 'leather', hide, 'root', {
        name: `elephantEar${s < 0 ? 'L' : 'R'}`,
        rigid: true,
        mountBone: s < 0 ? 'elephant.earL' : 'elephant.earR',
      }),
    );
  }

  // -- tusks ---------------------------------------------------------------
  for (const s of [-1, 1]) {
    const stations = [];
    const n = 5;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      stations.push({
        p: P(
          s * hw * (0.3 + t * 0.16),
          headY - S * 0.24 - t * S * 0.18 + t * t * S * 0.14,
          -L * (0.56 + t * 0.28),
        ),
        rx: S * 0.045 * (1 - t * 0.85) + S * 0.005,
        squareness: 0.35,
      });
    }
    g.parts.push(
      mkPart(sweep(stations, { sides: 6, name: 'tusk' }), 'ivory', o.tuskPigment ?? BONE_WHITE, 'root', {
        name: `tusk${s < 0 ? 'L' : 'R'}`,
        rigid: true,
        mountBone: 'elephant.head',
      }),
    );
  }

  // -- trunk ---------------------------------------------------------------
  // One bone and one tapered section per segment. Straight in bind pose; the
  // animator curls it. Each segment overlaps the next slightly so a sweep never
  // opens a gap at a joint.
  const trunkTop: V3 = P(0, headY - S * 0.26, -L * 0.6);
  const trunkLen = S * 0.62;
  let prevBone = 'elephant.head';
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const name = `elephant.trunk${String(i + 1).padStart(2, '0')}`;
    const p0: V3 = [
      trunkTop[0],
      trunkTop[1] - trunkLen * t0,
      trunkTop[2] - S * 0.06 * t0,
    ];
    const p1: V3 = [
      trunkTop[0],
      trunkTop[1] - trunkLen * t1,
      trunkTop[2] - S * 0.06 * t1,
    ];
    g.bones.push({ name, parent: prevBone, position: p0 });
    prevBone = name;
    const r0 = S * 0.085 * (1 - t0 * 0.62);
    const r1 = S * 0.085 * (1 - t1 * 0.62);
    const seg = sweep(
      [
        { p: p0, rx: r0, rz: r0 * 0.92, squareness: 0.42 },
        { p: [p1[0], p1[1] + (p0[1] - p1[1]) * 0.06, p1[2]], rx: r1 * 1.02, rz: r1 * 0.94, squareness: 0.42 },
      ],
      { sides: 7, name },
    );
    g.parts.push(
      mkPart(seg, 'leather', hide, 'root', { name, rigid: true, mountBone: name }),
    );
  }
  const trunkTip: V3 = [trunkTop[0], trunkTop[1] - trunkLen, trunkTop[2] - S * 0.06];
  g.points.trunkTip = new THREE.Vector3(...trunkTip);
  g.attach.push({ name: 'trunkTip', bone: `elephant.trunk${String(segs).padStart(2, '0')}`, position: trunkTip });

  // -- legs ----------------------------------------------------------------
  // Columnar: barely any taper, and the joints are close to vertical. That
  // column is why an elephant reads as heavy where a horse reads as fast.
  const legR = S * 0.1;
  const legDefs: { prefix: string; parent: string; x: number; z: number }[] = [];
  for (const s of [-1, 1]) {
    legDefs.push({
      prefix: s < 0 ? 'elephant.legFL' : 'elephant.legFR',
      parent: 'elephant.chest',
      x: s * hw * 0.66,
      z: -L * 0.28,
    });
    legDefs.push({
      prefix: s < 0 ? 'elephant.legHL' : 'elephant.legHR',
      parent: 'elephant.spine',
      x: s * hw * 0.62,
      z: L * 0.3,
    });
  }
  for (const d of legDefs) {
    const grp = quadrupedLeg({
      prefix: d.prefix,
      parent: d.parent,
      joints: [
        P(d.x, backY * 0.72, d.z),
        P(d.x, backY * 0.46, d.z + S * 0.015),
        P(d.x, backY * 0.16, d.z),
        P(d.x, backY * 0.055, d.z),
      ],
      radii: [legR * 1.25, legR * 1.08, legR * 0.98, legR * 1.02],
      pigment: hide,
      hoofPigment: hide,
      sides: 7,
      flatten: 0.95,
      hoofHeight: backY * 0.055,
    });
    g.parts.push(...grp.parts);
    g.bones.push(...grp.bones);
  }

  // -- tail ----------------------------------------------------------------
  {
    const stations = [];
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      stations.push({
        p: P(0, backY * 0.8 - t * S * 0.42, L * (0.47 + t * 0.03)),
        rx: S * 0.028 * (1 - t * 0.5),
        squareness: 0.4,
      });
    }
    g.parts.push(
      mkPart(sweep(stations, { sides: 5, name: 'elephantTail' }), 'leather', hide, 'root', {
        name: 'elephantTail',
        rigid: true,
        mountBone: 'elephant.tail',
      }),
    );
  }

  if (o.howdah !== false) {
    const h = howdah({
      y: backY * 0.82 + S * 0.3,
      z: at[2] + L * 0.02,
      hw: hw * 0.92,
      depth: L * 0.3,
      height: S * 0.34,
      pigment: o.howdahPigment ?? 'lacquer',
      metal: o.metalPigment ?? 'metal',
      cloth: o.clothPigment ?? 'cloth',
    });
    g.parts.push(...h.parts);
    g.instanced.push(...h.instanced);
    g.points.seat = h.points.seat;
    g.attach.push({
      name: 'mountSeat',
      bone: 'elephant.spine',
      position: [h.points.seat.x, h.points.seat.y, h.points.seat.z],
    });
  } else {
    g.points.seat = new THREE.Vector3(at[0], at[1] + backY * 0.82 + S * 0.28, at[2] - L * 0.34);
    g.attach.push({
      name: 'mountSeat',
      bone: 'elephant.neck',
      position: [g.points.seat.x, g.points.seat.y, g.points.seat.z],
    });
  }

  g.points.withers = new THREE.Vector3(at[0], at[1] + backY * 0.82 + S * 0.3, at[2] - L * 0.2);
  return g;
}

export interface HowdahOpts {
  /** Floor height. */
  y: number;
  z: number;
  hw: number;
  depth: number;
  height: number;
  pigment?: PartPigment;
  metal?: PartPigment;
  cloth?: PartPigment;
}

/**
 * The howdah: a lacquered box platform with a railed back and corner posts.
 * Bound to `elephant.spine`, so it moves with the animal's back and not with
 * the world.
 */
export function howdah(o: HowdahOpts): PartGroup {
  const g = emptyGroup();
  const pig = o.pigment ?? 'lacquer';
  const bone = 'elephant.spine';

  const floor = bevelSlab({
    w: o.hw * 2,
    h: o.depth,
    d: o.height * 0.22,
    bevel: o.height * 0.05,
    name: 'howdahFloor',
  });
  place(floor, { pos: [0, o.y, o.z], rot: [Math.PI / 2, 0, 0] });
  g.parts.push(mkPart(floor, 'timber', pig, 'root', { name: 'howdahFloor', rigid: true, mountBone: bone }));

  // Three-sided rail: open at the front so the mahout is not caged.
  const railY = o.y + o.height * 0.7;
  const rails: [V3, V3][] = [
    [
      [-o.hw, railY, o.z + o.depth * 0.5],
      [o.hw, railY, o.z + o.depth * 0.5],
    ],
    [
      [-o.hw, railY, o.z - o.depth * 0.5],
      [-o.hw, railY, o.z + o.depth * 0.5],
    ],
    [
      [o.hw, railY, o.z - o.depth * 0.5],
      [o.hw, railY, o.z + o.depth * 0.5],
    ],
  ];
  for (const [a, b] of rails) {
    g.parts.push(
      piping({
        path: [a, [(a[0] + b[0]) / 2, railY, (a[2] + b[2]) / 2], b],
        r: o.height * 0.07,
        boneHint: 'root',
        mountBone: bone,
        pigment: o.metal ?? 'metal',
        cls: 'timber',
        sides: 5,
        name: 'howdahRail',
      }),
    );
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = bevelSlab({
        w: o.height * 0.14,
        h: o.height * 0.7,
        d: o.height * 0.14,
        bevel: o.height * 0.03,
      });
      place(post, { pos: [sx * o.hw, o.y + o.height * 0.35, o.z + sz * o.depth * 0.5] });
      g.parts.push(
        mkPart(post, 'timber', pig, 'root', { name: 'howdahPost', rigid: true, mountBone: bone }),
      );
    }
  }

  // Cloth valance hanging over the elephant's flanks.
  for (const s of [-1, 1]) {
    const grid: V3[][] = [];
    for (let r = 0; r < 3; r++) {
      const t = r / 2;
      const row: V3[] = [];
      for (let c = 0; c < 4; c++) {
        const u = c / 3;
        const scallop = r === 2 ? Math.sin(u * 9) * o.height * 0.06 : 0;
        row.push([
          s * o.hw * (1.02 + t * 0.06),
          o.y - t * o.height * 0.55 + scallop,
          o.z + (u - 0.5) * o.depth * 0.98,
        ]);
      }
      grid.push(row);
    }
    g.parts.push(
      mkPart(shell(grid, o.height * 0.012, { name: 'valance', flip: s > 0 }), 'cloth', o.cloth ?? 'cloth', 'root', {
        name: 'howdahValance',
        rigid: true,
        mountBone: bone,
      }),
    );
  }

  g.points.seat = new THREE.Vector3(0, o.y + o.height * 0.16, o.z + o.depth * 0.06);
  return g;
}

/** Mirror any mount group across X — for building a left-facing variant. */
export function mirrorMount(g: PartGroup): PartGroup {
  for (const p of g.parts) p.geometry = mirrorX(p.geometry);
  for (const b of g.bones) b.position = [-b.position[0], b.position[1], b.position[2]];
  for (const k of Object.keys(g.points)) g.points[k].x *= -1;
  for (const a of g.attach) a.position = [-a.position[0], a.position[1], a.position[2]];
  return g;
}
