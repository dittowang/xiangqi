/**
 * 傌 / 馬 — the cavalryman.
 * ============================================================================
 *
 * One unit, two animals: a horse built as a real quadruped, and a man built to
 * sit on it. They are authored together because they cannot be authored apart —
 * the rider's knee has to land on the horse's barrel, and the only way to
 * guarantee that is for one file to own both surfaces.
 *
 * SILHOUETTE. A long horizontal mass with a bump on top. It is the only unit
 * apart from the chariot whose outline is wider than it is tall, and it is
 * separated from the chariot by having no wheels, no canopy disc, and a
 * recognisably *animal* topline: brisket, deep girth, pinched loin, high croup,
 * arched neck, blocky head carried out in front. The rider's paired horns are
 * the crown tag (`horned`) and are the axis that survives when height and
 * aspect collide with another unit.
 *
 * TWO ARMIES.
 *   Han 漢  rolled-brim 兜鍪 with short ox horns; a 環首刀 held up at the
 *           shoulder; a fringed saddle cloth 障泥 over the flanks; a cinnabar
 *           chest tassel on the breast collar; a square 旌 guidon raked back
 *           off the cantle.
 *   Chu 楚  forward-raked peaked helm with long swept horns; a long 戟 laid
 *           back over the croup carrying a swallow-tailed 幡; lamellar barding
 *           panels over chest and croup; bronze cheek discs on the bridle.
 * Helmet form, weapon outline and pennant shape all differ. The horse itself is
 * dun in both armies — a horse is a horse — so the army read comes entirely
 * from what is strapped to it, which is also how the archaeology reads.
 *
 * THE BARREL IS A PUBLISHED SURFACE. See `barrelAt()` and the `horse.spine`
 * bone's `userData`: the animator's leg IK gets the horse's cross-section as
 * numbers rather than having to guess it from the mesh. The bind pose already
 * puts the knees and ankles *on* that surface, so the legs do not have to be
 * animated into contact — they start in contact.
 *
 * Reference: Han pictorial stone relief (漢畫像石) cavalry — short-backed,
 * heavy-necked horses with hogged manes and knotted tails; the Xianyang and
 * Yangjiawan painted cavalry figurines for tack.
 */

import * as THREE from 'three';
import type { BoneName } from '@core/contracts.ts';
import { PieceType, Side } from '@core/types.ts';
import { registerUnit, type UnitBuildContext } from '@characters/factory.ts';
import type {
  InstancedPart,
  Part,
  PartGroup,
  PartPigment,
  V3,
} from '@characters/parts/types.ts';
import type { Rig, RigOptions } from '@characters/rig.ts';

// ---------------------------------------------------------------------------
// Substances that are the same in both armies
// ---------------------------------------------------------------------------

/** Hide. Dun in both armies; the army colour lives in the tack, not the animal. */
const HIDE: PartPigment = 'ochre';
/** Mane, tail and — it is the same keratin — hoof horn. */
const HORN: PartPigment = 'ink';

const v3 = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];

// ===========================================================================
// The horse
// ===========================================================================

/**
 * A longitudinal station through the barrel: the centre height and the two
 * half-extents of the elliptical cross-section there. `z` is in rig space.
 *
 * The barrel is authored *from this table* and published *from this table*, so
 * the surface the rider's leg is fitted to and the surface the mesh draws are
 * the same surface by construction rather than by agreement.
 */
interface BarrelStation {
  /** Longitudinal position as a fraction of body length; -0.5 is the brisket. */
  t: number;
  /** Section centre height, as a fraction of withers height. */
  y: number;
  /** Half-width across X, as a fraction of the girth half-width. */
  rx: number;
  /** Half-height across Y, as a fraction of withers height. */
  ry: number;
  /** Superellipse exponent parameter — flat flanks want 0.5, the ends less. */
  sq: number;
}

/**
 * Seven stations. The girth is the widest and deepest, the loin is pinched and
 * lifted, and the croup rises again behind it: that sequence — deep front,
 * waisted middle, high rear — is what separates a horse's topline from a
 * generic quadruped tube at silhouette size.
 */
const BARREL: readonly BarrelStation[] = [
  { t: -0.50, y: 0.665, rx: 0.42, ry: 0.135, sq: 0.42 }, // brisket
  { t: -0.34, y: 0.700, rx: 0.90, ry: 0.215, sq: 0.50 }, // chest
  { t: -0.16, y: 0.712, rx: 1.00, ry: 0.245, sq: 0.52 }, // girth: widest, deepest
  { t: 0.04, y: 0.716, rx: 0.95, ry: 0.220, sq: 0.52 }, // belly
  { t: 0.24, y: 0.752, rx: 0.80, ry: 0.184, sq: 0.50 }, // loin: pinched, lifted
  { t: 0.40, y: 0.778, rx: 0.87, ry: 0.186, sq: 0.48 }, // croup: high
  { t: 0.53, y: 0.740, rx: 0.44, ry: 0.100, sq: 0.45 }, // dock
];

interface Dims {
  /** Withers height above the ground, rig units. */
  W: number;
  /** Chest to croup, rig units. */
  L: number;
  /** Barrel half-width at the girth, rig units. */
  HW: number;
}

interface Section {
  y: number;
  rx: number;
  ry: number;
}

/**
 * The barrel's elliptical cross-section at a longitudinal station, in rig
 * units. Linear between authored stations, clamped outside them.
 *
 * This is the function the rider's leg is fitted against, and its four numbers
 * (`y`, `rx`, `ry` and the station range) are published on the `horse.spine`
 * bone so an IK solver can rebuild it without touching geometry.
 */
function barrelAt(d: Dims, z: number): Section {
  const t = z / d.L;
  const n = BARREL.length;
  if (t <= BARREL[0].t) return scale(d, BARREL[0]);
  if (t >= BARREL[n - 1].t) return scale(d, BARREL[n - 1]);
  for (let i = 0; i < n - 1; i++) {
    const a = BARREL[i];
    const b = BARREL[i + 1];
    if (t >= a.t && t <= b.t) {
      const u = (t - a.t) / (b.t - a.t);
      return {
        y: (a.y + (b.y - a.y) * u) * d.W,
        rx: (a.rx + (b.rx - a.rx) * u) * d.HW,
        ry: (a.ry + (b.ry - a.ry) * u) * d.W,
      };
    }
  }
  return scale(d, BARREL[n - 1]);
}

function scale(d: Dims, s: BarrelStation): Section {
  return { y: s.y * d.W, rx: s.rx * d.HW, ry: s.ry * d.W };
}

/**
 * A point on the barrel at station `z`, angle `theta` measured from the widest
 * point (0 = the flank, +π/2 = the spine, -π/2 = the belly), pushed `off` clear
 * of the hide along the true ellipse normal.
 *
 * `off` is how the rider's leg is made to *touch* rather than intersect: pass
 * the limb's own radius and the returned point is where that limb's centre line
 * has to be for its surface to lie on the horse's.
 */
function barrelSurface(d: Dims, z: number, theta: number, off: number, side: number): V3 {
  const s = barrelAt(d, z);
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  // Normal of x²/rx² + y²/ry² = 1 at that parameter, normalised.
  let nx = c / s.rx;
  let ny = sn / s.ry;
  const l = Math.hypot(nx, ny) || 1;
  nx /= l;
  ny /= l;
  return [side * (s.rx * c + nx * off), s.y + s.ry * sn + ny * off, z];
}

/**
 * Put a joint on the barrel at exactly `len` from `from`.
 *
 * Walks the contour at station `z` between two angles, takes the point whose
 * distance from `from` is closest to the bone's own length, then snaps the
 * result to exactly that length along the same direction. Two properties come
 * out of that, and both matter:
 *
 *   - the bone is **never stretched**, so `rig.bindLengths` stays honest and an
 *     IK solver that normalises against proportions lands where it expects to;
 *   - the joint is **on the surface** wherever the surface is reachable, so the
 *     leg grips the horse instead of hovering beside it.
 *
 * Where the two fight — a short thigh on a deep-barrelled horse — length wins
 * and the knee rides higher up the flank. That is the correct answer as well as
 * the safe one: Western Han cavalry had no stirrups, and the surviving cavalry
 * figurines all sit with the knees carried high and the thighs gripping the
 * upper flank, which is exactly what a short thigh on a deep horse produces.
 */
function fitOnBarrel(
  d: Dims,
  z: number,
  from: V3,
  len: number,
  off: number,
  side: number,
  fromTheta: number,
  toTheta: number,
): V3 {
  let best: V3 = barrelSurface(d, z, fromTheta, off, side);
  let bestErr = Infinity;
  const steps = 96;
  for (let i = 0; i <= steps; i++) {
    const th = fromTheta + ((toTheta - fromTheta) * i) / steps;
    const p = barrelSurface(d, z, th, off, side);
    const err = Math.abs(Math.hypot(p[0] - from[0], p[1] - from[1], p[2] - from[2]) - len);
    if (err < bestErr) {
      bestErr = err;
      best = p;
    }
  }
  const dx = best[0] - from[0];
  const dy = best[1] - from[1];
  const dz = best[2] - from[2];
  const l = Math.hypot(dx, dy, dz) || 1;
  return [from[0] + (dx / l) * len, from[1] + (dy / l) * len, from[2] + (dz / l) * len];
}

/** Everything downstream of the horse needs from it. */
interface Steed {
  group: PartGroup;
  dims: Dims;
  /** Rider's pelvis in the saddle, rig space. */
  seat: V3;
  /** Bit rings, where the reins are made fast. */
  reinL: V3;
  reinR: V3;
  /** Top of the cantle — the guidon socket and the back of the seat. */
  cantle: V3;
  /** Poll, muzzle and croup, for anyone aiming a camera or an effect. */
  poll: V3;
  muzzle: V3;
  croup: V3;
}

/**
 * The animal, its tack, and its bone chains. Pure arithmetic: nothing here
 * touches the rig, which is why it can run before the rig is lifted onto it.
 */
function buildSteed(ctx: UnitBuildContext, d: Dims): Steed {
  const P = ctx.parts;
  const { prim, trim } = P;
  const han = ctx.side === Side.Red;
  const g = P.emptyGroup();
  const { W, L, HW } = d;

  // -- skeleton ------------------------------------------------------------
  // Named for what an animator would call them. The canter is a three-beat
  // gait and the beat each leg lands on is published as `canterBeat` on the
  // chain's root bone: 0 first (the trailing hind), 1 the diagonal pair, 2 the
  // leading fore. Leading on the right, which is the board's forward diagonal.
  const loinY = barrelAt(d, L * 0.24).y;
  const croupY = barrelAt(d, L * 0.4).y;
  const chestY = barrelAt(d, -L * 0.3).y;
  const seatY = barrelAt(d, -L * 0.04).y + barrelAt(d, -L * 0.04).ry + W * 0.072;
  const pollP: V3 = [0, W * 1.175, -L * 0.615];
  const muzzleP: V3 = [0, W * 0.955, -L * 0.9];

  g.bones.push(
    {
      name: 'horse.spine',
      parent: 'root',
      position: [0, loinY, L * 0.2],
      data: {
        // ---- THE PUBLISHED BARREL, rig units (pre-scale) -----------------
        // Everything the rider's leg IK needs, as numbers, so it never has to
        // measure the mesh. The barrel's cross-section at longitudinal station
        // z is the ellipse
        //
        //     x² / barrelHalfWidth²
        //   + (y - barrelY - barrelSlope·(z - barrelZ))² / barrelHalfHeight²
        //   = 1
        //
        // valid for barrelZFront <= z <= barrelZBack; the numbers are taken at
        // barrelZ, the station the rider's knee sits on, and the section varies
        // by under 5% across the band the leg actually touches. Outside the
        // band the surface belongs to the shoulder or the quarter, and the leg
        // does not touch it. `barrelSquareness` is the superellipse exponent
        // parameter `prim.ring()` was built with — 0 is a true ellipse, 1 is
        // nearly a rectangle — for anyone who wants the exact drawn surface
        // rather than its elliptical approximation.
        //
        // The BIND POSE ALREADY SATISFIES THIS: `shinL/R` and `footL/R` sit on
        // the surface offset outward by their own limb radius, so a solver only
        // has to *maintain* contact, never establish it.
        barrelY: barrelAt(d, -L * 0.1).y,
        barrelZ: -L * 0.1,
        barrelHalfWidth: barrelAt(d, -L * 0.1).rx,
        barrelHalfHeight: barrelAt(d, -L * 0.1).ry,
        barrelZFront: -L * 0.26,
        barrelZBack: L * 0.14,
        barrelSlope: (barrelAt(d, L * 0.14).y - barrelAt(d, -L * 0.26).y) / (L * 0.4),
        barrelSquareness: 0.52,
        seatY,
        seatZ: -L * 0.04,
        withersY: W,
        bodyLength: L,
      },
    },
    { name: 'horse.croup', parent: 'horse.spine', position: [0, croupY, L * 0.4] },
    { name: 'horse.chest', parent: 'horse.spine', position: [0, chestY, -L * 0.3] },
    { name: 'horse.neck01', parent: 'horse.chest', position: [0, W * 0.845, -L * 0.375] },
    { name: 'horse.neck02', parent: 'horse.neck01', position: [0, W * 1.03, -L * 0.5] },
    { name: 'horse.head', parent: 'horse.neck02', position: pollP },
    { name: 'horse.tail01', parent: 'horse.croup', position: [0, croupY + W * 0.055, L * 0.52] },
    { name: 'horse.tail02', parent: 'horse.tail01', position: [0, croupY - W * 0.09, L * 0.6] },
    { name: 'horse.tail03', parent: 'horse.tail02', position: [0, croupY - W * 0.24, L * 0.615] },
  );

  // -- barrel --------------------------------------------------------------
  // Eight facets and a crease at every authored station. The `sq` ramp flattens
  // the flanks through the girth so the animal has planes to catch the ramp on
  // and rounds off at the ends where a plane would read as a box.
  const barrel = prim.sweep(
    BARREL.map((s) => ({
      p: [0, s.y * W, s.t * L] as V3,
      rx: s.rx * HW,
      rz: s.ry * W,
      squareness: s.sq,
    })),
    { sides: 8, name: 'horseBarrel' },
  );
  g.parts.push(
    P.mkPart(barrel, 'leather', HIDE, 'root', {
      name: 'horseBarrel',
      rigid: true,
      mountBone: 'horse.spine',
    }),
  );

  // Withers wedge: the shoulder blades stand proud of the barrel and the neck
  // rises out of them. Without it the neck reads as a pipe pushed into a tube.
  {
    const wit = prim.loft(
      [
        prim.ring({ rx: HW * 0.62, rz: W * 0.13, y: W * 0.80, cz: -L * 0.32, sides: 6, squareness: 0.5 }),
        prim.ring({ rx: HW * 0.50, rz: W * 0.115, y: W * 0.925, cz: -L * 0.325, sides: 6, squareness: 0.55 }),
        prim.ring({ rx: HW * 0.28, rz: W * 0.09, y: W * 1.0, cz: -L * 0.335, sides: 6, squareness: 0.6 }),
      ],
      { capStart: false, name: 'horseWithers' },
    );
    g.parts.push(
      P.mkPart(wit, 'leather', HIDE, 'root', {
        name: 'horseWithers',
        rigid: true,
        mountBone: 'horse.chest',
      }),
    );
  }

  // -- neck ----------------------------------------------------------------
  // A wedge, deep at the shoulder and thin at the poll, squared off so the
  // crest along the top is a hard edge rather than a highlight. Split across
  // two bones so the arch can flex at the middle, which is where a horse's
  // neck actually bends under a canter.
  const neckStations: { p: V3; rx: number; rz: number; sq: number }[] = [
    { p: [0, W * 0.80, -L * 0.30], rx: HW * 0.70, rz: W * 0.235, sq: 0.52 },
    { p: [0, W * 0.905, -L * 0.375], rx: HW * 0.60, rz: W * 0.215, sq: 0.56 },
    { p: [0, W * 1.03, -L * 0.50], rx: HW * 0.455, rz: W * 0.175, sq: 0.60 },
    { p: [0, W * 1.115, -L * 0.565], rx: HW * 0.375, rz: W * 0.145, sq: 0.62 },
    { p: [0, W * 1.175, -L * 0.615], rx: HW * 0.33, rz: W * 0.125, sq: 0.62 },
  ];
  g.parts.push(
    P.mkPart(
      prim.sweep(neckStations, { sides: 7, capStart: false, name: 'horseNeckLower' }),
      'leather',
      HIDE,
      'root',
      { name: 'horseNeckLower', rigid: true, mountBone: 'horse.neck01' },
    ),
  );
  // The upper third rides on neck02 so the poll leads the arch.
  g.parts.push(
    P.mkPart(
      prim.sweep(neckStations.slice(2), { sides: 7, capStart: false, capEnd: false, name: 'horseNeckUpper' }),
      'leather',
      HIDE,
      'root',
      { name: 'horseNeckUpper', rigid: true, mountBone: 'horse.neck02' },
    ),
  );

  // -- head ----------------------------------------------------------------
  // Blocky and faceted: a forehead plane, a nasal plane, a muzzle box, and a
  // separate jowl block either side. The jowl is the shape that says *horse* in
  // relief carving — a heavy round cheek with a hard undercut behind it.
  {
    // Long and shallow. A horse's head is about twice as long as it is deep;
    // built any squarer it reads as a brick on the end of the neck, which is
    // the commonest way a stylised horse stops being a horse.
    const head = prim.sweep(
      [
        { p: [0, W * 1.175, -L * 0.615] as V3, rx: HW * 0.30, rz: W * 0.105, squareness: 0.60 },
        { p: [0, W * 1.13, -L * 0.678] as V3, rx: HW * 0.345, rz: W * 0.128, squareness: 0.62 }, // brow
        { p: [0, W * 1.06, -L * 0.752] as V3, rx: HW * 0.285, rz: W * 0.112, squareness: 0.64 },
        { p: [0, W * 0.995, -L * 0.838] as V3, rx: HW * 0.205, rz: W * 0.085, squareness: 0.66 },
        { p: [0, W * 0.955, -L * 0.898] as V3, rx: HW * 0.225, rz: W * 0.082, squareness: 0.62 }, // muzzle
      ],
      { sides: 6, name: 'horseHead' },
    );
    g.parts.push(
      P.mkPart(head, 'leather', HIDE, 'root', { name: 'horseHead', rigid: true, mountBone: 'horse.head' }),
    );

    // Jowl / cheek: a bevelled block set behind and below the eye.
    const jowlR = prim.bevelSlab({
      w: HW * 0.19,
      h: W * 0.145,
      d: W * 0.15,
      bevel: W * 0.032,
      name: 'horseJowl',
    });
    prim.place(jowlR, { pos: [HW * 0.26, W * 1.078, -L * 0.666], rot: [0.36, -0.12, 0] });
    g.parts.push(
      P.mkPart(jowlR, 'leather', HIDE, 'root', { name: 'horseJowlR', rigid: true, mountBone: 'horse.head' }),
    );
    g.parts.push(
      P.mkPart(prim.mirrorX(jowlR), 'leather', HIDE, 'root', {
        name: 'horseJowlL',
        rigid: true,
        mountBone: 'horse.head',
      }),
    );

    // Jaw underline running from the throat to the chin — the plane that gives
    // the head its wedge from the side.
    const jaw = prim.sweep(
      [
        { p: [0, W * 1.045, -L * 0.64] as V3, rx: HW * 0.235, rz: W * 0.05, squareness: 0.6 },
        { p: [0, W * 0.975, -L * 0.742] as V3, rx: HW * 0.185, rz: W * 0.045, squareness: 0.62 },
        { p: [0, W * 0.928, -L * 0.862] as V3, rx: HW * 0.155, rz: W * 0.038, squareness: 0.64 },
      ],
      { sides: 5, name: 'horseJaw' },
    );
    g.parts.push(
      P.mkPart(jaw, 'leather', HIDE, 'root', { name: 'horseJaw', rigid: true, mountBone: 'horse.head' }),
    );

    // Eye and nostril. Twenty-four triangles between them, and they are what
    // turn a wedge with ears into a head — the eye sits in the hollow between
    // the brow and the jowl, where a relief carver cuts it.
    for (const s of [-1, 1]) {
      const eye = prim.bevelSlab({ w: HW * 0.10, h: W * 0.045, d: W * 0.03, bevel: W * 0.012 });
      prim.place(eye, { pos: [s * HW * 0.30, W * 1.108, -L * 0.682], rot: [0.1, s * 0.5, s * 0.22] });
      g.parts.push(
        P.mkPart(eye, 'hair', HORN, 'root', { name: 'horseEye', rigid: true, mountBone: 'horse.head' }),
      );
      const nostril = prim.bevelSlab({ w: HW * 0.075, h: W * 0.04, d: W * 0.028, bevel: W * 0.01 });
      prim.place(nostril, { pos: [s * HW * 0.15, W * 0.968, -L * 0.892], rot: [0.35, s * 0.34, 0] });
      g.parts.push(
        P.mkPart(nostril, 'hair', HORN, 'root', { name: 'horseNostril', rigid: true, mountBone: 'horse.head' }),
      );
    }

    // Ears: two hard wedges, pricked forward.
    for (const s of [-1, 1]) {
      const ear = prim.prism({
        rx0: HW * 0.085,
        rz0: HW * 0.055,
        rx1: HW * 0.012,
        rz1: HW * 0.01,
        y0: 0,
        y1: W * 0.115,
        sides: 4,
        squareness: 0.4,
        name: 'horseEar',
      });
      prim.place(ear, { pos: [s * HW * 0.155, W * 1.19, -L * 0.6], rot: [-0.34, 0, s * 0.2] });
      g.parts.push(
        P.mkPart(ear, 'leather', HIDE, 'root', { name: 'horseEar', rigid: true, mountBone: 'horse.head' }),
      );
    }
  }

  // -- mane, in hard strips ------------------------------------------------
  // A hogged crest cut square, authored as separate blades rather than one
  // sheet: the gaps between them are what read as hair at board distance, and
  // a single shell reads as a fin. Nine blades, each yawed a few degrees off
  // the centre line so the brush is not a comb.
  {
    const blades = 9;
    const rng = ctx.rng.fork('mane');
    for (let i = 0; i < blades; i++) {
      const t = i / (blades - 1);
      // March up the neck crest, from the withers to just behind the ears.
      const a = neckStations[0];
      const bEnd = neckStations[neckStations.length - 1];
      const py = a.p[1] + (bEnd.p[1] - a.p[1]) * t;
      const pz = a.p[2] + (bEnd.p[2] - a.p[2]) * t;
      const rz = a.rz + (bEnd.rz - a.rz) * t;
      const pitch = Math.atan2(bEnd.p[1] - a.p[1], -(bEnd.p[2] - a.p[2]));
      const hgt = W * (0.145 - t * 0.055);
      const blade = prim.bevelSlab({
        w: HW * 0.085,
        h: hgt,
        d: (L * 0.315) / blades,
        bevel: HW * 0.02,
        name: 'horseMane',
      });
      prim.place(blade, {
        pos: [rng.range(-1, 1) * HW * 0.03, py + rz * 0.86 + hgt * 0.42, pz - rz * 0.1],
        rot: [pitch - Math.PI / 2, rng.range(-0.14, 0.14), 0],
      });
      g.parts.push(
        P.mkPart(blade, 'hair', HORN, 'root', {
          name: 'horseMane',
          rigid: true,
          mountBone: t > 0.62 ? 'horse.neck02' : 'horse.neck01',
        }),
      );
    }
    // Forelock, falling forward between the ears.
    const fl = prim.bevelSlab({ w: HW * 0.17, h: W * 0.115, d: HW * 0.06, bevel: HW * 0.02 });
    prim.place(fl, { pos: [0, W * 1.205, -L * 0.632], rot: [0.62, 0, 0] });
    g.parts.push(
      P.mkPart(fl, 'hair', HORN, 'root', { name: 'horseForelock', rigid: true, mountBone: 'horse.head' }),
    );
  }

  // -- knotted tail --------------------------------------------------------
  // Han cavalry tie the tail in a knot so it cannot be grabbed or fouled. That
  // knot is a hard lump halfway down and it is the single most identifiable
  // detail on the rear of the animal.
  {
    const dock = prim.sweep(
      [
        { p: [0, croupY + W * 0.08, L * 0.5] as V3, rx: HW * 0.20, rz: HW * 0.20, squareness: 0.4 },
        { p: [0, croupY + W * 0.03, L * 0.56] as V3, rx: HW * 0.17, rz: HW * 0.17, squareness: 0.4 },
        { p: [0, croupY - W * 0.07, L * 0.595] as V3, rx: HW * 0.145, rz: HW * 0.145, squareness: 0.42 },
      ],
      { sides: 6, name: 'horseTailDock' },
    );
    g.parts.push(
      P.mkPart(dock, 'hair', HORN, 'root', { name: 'horseTailDock', rigid: true, mountBone: 'horse.tail01' }),
    );

    // The knot: a faceted torus-ish lump, deliberately over-scaled.
    const knot = prim.loft(
      [
        prim.ring({ rx: HW * 0.17, rz: HW * 0.15, y: croupY - W * 0.075, cz: L * 0.6, sides: 6, squareness: 0.5 }),
        prim.ring({ rx: HW * 0.34, rz: HW * 0.30, y: croupY - W * 0.115, cz: L * 0.612, sides: 6, squareness: 0.55 }),
        prim.ring({ rx: HW * 0.30, rz: HW * 0.27, y: croupY - W * 0.175, cz: L * 0.608, sides: 6, squareness: 0.55 }),
        prim.ring({ rx: HW * 0.16, rz: HW * 0.14, y: croupY - W * 0.215, cz: L * 0.598, sides: 6, squareness: 0.5 }),
      ],
      { name: 'horseTailKnot' },
    );
    g.parts.push(
      P.mkPart(knot, 'hair', HORN, 'root', { name: 'horseTailKnot', rigid: true, mountBone: 'horse.tail02' }),
    );

    // The switch below the knot: three hard strips, not a curtain.
    const rng = ctx.rng.fork('tail');
    for (let i = 0; i < 3; i++) {
      const s = (i - 1) * HW * 0.13;
      const sw = prim.sweep(
        [
          { p: [s, croupY - W * 0.20, L * 0.60] as V3, rx: HW * 0.10, rz: HW * 0.05, squareness: 0.4 },
          { p: [s * 1.3, croupY - W * 0.37, L * 0.60 + rng.range(-0.02, 0.02) * L] as V3, rx: HW * 0.085, rz: HW * 0.045, squareness: 0.4 },
          { p: [s * 1.5, croupY - W * 0.52, L * 0.585] as V3, rx: HW * 0.04, rz: HW * 0.025, squareness: 0.4 },
        ],
        { sides: 4, name: 'horseTailSwitch' },
      );
      g.parts.push(
        P.mkPart(sw, 'hair', HORN, 'root', { name: 'horseTailSwitch', rigid: true, mountBone: 'horse.tail03' }),
      );
    }
  }

  // -- legs ----------------------------------------------------------------
  // Four four-bone chains from `parts/mount.ts`. The joints below are real
  // horse anatomy, not a mirrored pair: the front column runs shoulder →
  // carpus → fetlock → hoof and is close to vertical, while the hind runs
  // stifle → HOCK → fetlock → hoof with the hock set well back, so the hind
  // leg makes a Z and the fore makes an I. That contrast is the most
  // recognisable thing about a horse's outline and it is worth the asymmetry.
  const legR = W * 0.05;
  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const front = P.mount.quadrupedLeg({
      prefix: `horse.legF${side}`,
      parent: 'horse.chest',
      joints: [
        [s * HW * 0.60, W * 0.755, -L * 0.315],
        [s * HW * 0.645, W * 0.335, -L * 0.325],
        [s * HW * 0.65, W * 0.115, -L * 0.315],
        [s * HW * 0.65, W * 0.048, -L * 0.31],
      ],
      radii: [legR * 1.75, legR * 1.02, legR * 0.70, legR * 0.78],
      pigment: HIDE,
      hoofPigment: HORN,
      sides: 6,
      flatten: 0.8,
      hoofHeight: W * 0.062,
    });
    const hind = P.mount.quadrupedLeg({
      prefix: `horse.legH${side}`,
      parent: 'horse.croup',
      joints: [
        [s * HW * 0.56, W * 0.715, L * 0.335],
        [s * HW * 0.615, W * 0.325, L * 0.455],
        [s * HW * 0.63, W * 0.115, L * 0.405],
        [s * HW * 0.63, W * 0.048, L * 0.40],
      ],
      radii: [legR * 2.05, legR * 1.14, legR * 0.72, legR * 0.80],
      pigment: HIDE,
      hoofPigment: HORN,
      sides: 6,
      flatten: 0.82,
      hoofHeight: W * 0.062,
    });
    // Hoof horn is the same substance as mane and tail — keratin — so it goes
    // in the hair bucket rather than opening a stone/ink pair of its own. One
    // draw call saved per horse on the board, and the hard two-step `hair` ramp
    // is a better read on a hoof than the gritty `stone` one anyway.
    retag(front, ':hoof', 'hair');
    retag(hind, ':hoof', 'hair');
    g.parts.push(...front.parts, ...hind.parts);
    g.bones.push(...front.bones, ...hind.bones);

    // The canter is three-beat. Landing order for a right-lead canter:
    //   beat 0  left hind (the trailing hind, alone)
    //   beat 1  right hind + left fore (the diagonal pair, together)
    //   beat 2  right fore (the leading fore, alone) — then the suspension
    // Published so the animator does not have to encode it per unit.
    const beatFore = s < 0 ? 1 : 2;
    const beatHind = s < 0 ? 0 : 1;
    for (const b of front.bones) if (b.name.endsWith('01')) b.data = { canterBeat: beatFore, lead: s > 0 ? 1 : 0 };
    for (const b of hind.bones) if (b.name.endsWith('01')) b.data = { canterBeat: beatHind, lead: s > 0 ? 1 : 0 };

    // Shoulder blade and hind quarter: the two big muscle masses that hide the
    // top of each leg column. Without them the legs look pinned on.
    const scap = prim.loft(
      [
        prim.ring({ rx: HW * 0.30, rz: W * 0.135, y: W * 0.86, cx: s * HW * 0.66, cz: -L * 0.345, sides: 6, squareness: 0.5 }),
        prim.ring({ rx: HW * 0.32, rz: W * 0.145, y: W * 0.70, cx: s * HW * 0.74, cz: -L * 0.325, sides: 6, squareness: 0.5 }),
        prim.ring({ rx: HW * 0.24, rz: W * 0.105, y: W * 0.56, cx: s * HW * 0.70, cz: -L * 0.315, sides: 6, squareness: 0.5 }),
      ],
      { name: 'horseShoulder' },
    );
    g.parts.push(
      P.mkPart(scap, 'leather', HIDE, 'root', {
        name: `horseShoulder${side}`,
        rigid: true,
        mountBone: 'horse.chest',
      }),
    );

    const haunch = prim.loft(
      [
        prim.ring({ rx: HW * 0.34, rz: W * 0.155, y: W * 0.79, cx: s * HW * 0.56, cz: L * 0.375, sides: 6, squareness: 0.48 }),
        prim.ring({ rx: HW * 0.40, rz: W * 0.175, y: W * 0.645, cx: s * HW * 0.62, cz: L * 0.36, sides: 6, squareness: 0.48 }),
        prim.ring({ rx: HW * 0.30, rz: W * 0.125, y: W * 0.48, cx: s * HW * 0.62, cz: L * 0.375, sides: 6, squareness: 0.5 }),
      ],
      { name: 'horseHaunch' },
    );
    g.parts.push(
      P.mkPart(haunch, 'leather', HIDE, 'root', {
        name: `horseHaunch${side}`,
        rigid: true,
        mountBone: 'horse.croup',
      }),
    );
  }

  // -- tack ----------------------------------------------------------------
  const seatZ = -L * 0.04;
  const seatSec = barrelAt(d, seatZ);
  const seat: V3 = [0, seatY, seatZ];
  const cantle: V3 = [0, seatY + W * 0.075, seatZ + L * 0.15];

  buildSaddle(ctx, d, g, seatSec, seatZ, seatY);
  buildHarness(ctx, d, g, seatZ);
  const bit = buildBridle(ctx, d, g, pollP, muzzleP);

  if (han) {
    // 障泥 — the fringed saddle cloth, hanging over both flanks. Han cavalry
    // figurines show it square-cut with a scalloped, fringed hem; it is the
    // Han army's flank signature and it lengthens the horizontal mass.
    buildSaddleCloth(ctx, d, g, seatZ);
    buildChestTassel(ctx, d, g);
  } else {
    // 馬鎧 — Chu lamellar barding: a laced panel over the chest and a second
    // over the croup. Real plates on the animal, from the same band primitive
    // the men wear, so the two armies' armour reads as one technology.
    buildBarding(ctx, d, g);
    // Bronze cheek discs on the bridle — the Chu bridle's tell.
    for (const s of [-1, 1]) {
      g.parts.push(
        trim.boss({
          at: [s * HW * 0.30, W * 1.062, -L * 0.702],
          r: W * 0.045,
          height: W * 0.022,
          boneHint: 'root',
          mountBone: 'horse.head',
          pigment: 'metal',
          cls: 'iron',
          rot: [0, 0, s * Math.PI * 0.5],
          sides: 6,
        }),
      );
    }
  }

  // -- published landmarks and sockets -------------------------------------
  g.points.seat = new THREE.Vector3(...seat);
  g.points.withers = new THREE.Vector3(0, W, -L * 0.32);
  g.points.croup = new THREE.Vector3(0, croupY + W * 0.19, L * 0.4);
  g.points.muzzle = new THREE.Vector3(...muzzleP);
  g.points.reinL = new THREE.Vector3(...bit.left);
  g.points.reinR = new THREE.Vector3(...bit.right);
  // Where the rider's calf lies against the barrel, and where his ankle hangs.
  // Published so an IK solver has a target rather than a search.
  const kneeSec = barrelAt(d, -L * 0.1);
  for (const s of [-1, 1]) {
    const k = s < 0 ? 'L' : 'R';
    g.points[`barrelContact${k}`] = new THREE.Vector3(s * kneeSec.rx, kneeSec.y, -L * 0.1);
  }

  g.attach.push(
    { name: 'mountSeat', bone: 'horse.spine', position: seat },
    { name: 'reinL', bone: 'horse.head', position: bit.left },
    { name: 'reinR', bone: 'horse.head', position: bit.right },
  );

  return {
    group: g,
    dims: d,
    seat,
    reinL: bit.left,
    reinR: bit.right,
    cantle,
    poll: pollP,
    muzzle: muzzleP,
    croup: [0, croupY + W * 0.19, L * 0.4],
  };
}

// ---------------------------------------------------------------------------
// Tack
// ---------------------------------------------------------------------------

/** High-pommel, high-cantle Han saddle: two hard humps either side of the seat. */
function buildSaddle(
  ctx: UnitBuildContext,
  d: Dims,
  g: PartGroup,
  sec: Section,
  seatZ: number,
  seatY: number,
): void {
  const P = ctx.parts;
  const { prim } = P;
  const { W, L, HW } = d;

  const pad = prim.loft(
    [
      prim.ring({ rx: sec.rx * 1.03, rz: L * 0.20, y: sec.y + sec.ry * 0.42, cz: seatZ, sides: 8, squareness: 0.56 }),
      prim.ring({ rx: sec.rx * 1.02, rz: L * 0.185, y: sec.y + sec.ry * 0.92, cz: seatZ, sides: 8, squareness: 0.56 }),
      prim.ring({ rx: sec.rx * 0.70, rz: L * 0.15, y: seatY - W * 0.012, cz: seatZ, sides: 8, squareness: 0.6 }),
    ],
    { capStart: false, name: 'saddlePad' },
  );
  g.parts.push(
    P.mkPart(pad, 'leather', 'leather', 'root', { name: 'saddlePad', rigid: true, mountBone: 'horse.spine' }),
  );

  // Pommel (front) and cantle (back). Both rake outward from the seat, which is
  // what makes the saddle read as a saddle and not a cushion.
  for (const s of [-1, 1]) {
    const arch = prim.loft(
      [
        prim.ring({ rx: sec.rx * 0.70, rz: L * 0.022, y: seatY - W * 0.02, cz: seatZ + s * L * 0.135, sides: 6, squareness: 0.55 }),
        prim.ring({ rx: sec.rx * 0.62, rz: L * 0.028, y: seatY + W * 0.048, cz: seatZ + s * L * 0.155, sides: 6, squareness: 0.6 }),
        prim.ring({ rx: sec.rx * 0.40, rz: L * 0.022, y: seatY + W * 0.082, cz: seatZ + s * L * 0.168, sides: 6, squareness: 0.6 }),
      ],
      { capStart: false, name: 'saddleArch' },
    );
    g.parts.push(
      P.mkPart(arch, 'leather', 'leather', 'root', {
        name: s < 0 ? 'saddlePommel' : 'saddleCantle',
        rigid: true,
        mountBone: 'horse.spine',
      }),
    );
  }

  // Girth: a strap right round the barrel just behind the elbow.
  const girthZ = -L * 0.22;
  const gs = barrelAt(d, girthZ);
  const loop: V3[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    loop.push([Math.cos(a) * gs.rx * 1.03, gs.y + Math.sin(a) * gs.ry * 1.03, girthZ]);
  }
  g.parts.push(
    P.trim.piping({
      path: loop,
      r: HW * 0.055,
      boneHint: 'root',
      mountBone: 'horse.spine',
      pigment: 'leather',
      cls: 'leather',
      sides: 4,
      name: 'girth',
    }),
  );
}

/** Breast collar and crupper — the two straps that stop a saddle sliding. */
function buildHarness(ctx: UnitBuildContext, d: Dims, g: PartGroup, seatZ: number): void {
  const P = ctx.parts;
  const { W, L, HW } = d;
  const front = barrelAt(d, -L * 0.42);
  const flank = barrelAt(d, -L * 0.26);

  for (const s of [-1, 1]) {
    g.parts.push(
      P.trim.piping({
        path: [
          [s * flank.rx * 0.92, flank.y + flank.ry * 0.85, -L * 0.24],
          [s * front.rx * 1.02, front.y + front.ry * 0.2, -L * 0.4],
          [s * front.rx * 0.5, front.y - front.ry * 0.35, -L * 0.47],
          [0, front.y - front.ry * 0.42, -L * 0.475],
        ],
        r: HW * 0.06,
        boneHint: 'root',
        mountBone: 'horse.chest',
        pigment: 'leather',
        cls: 'leather',
        sides: 4,
        name: 'breastCollar',
      }),
    );
  }

  // 杏葉 — the bronze phalerae strung along the breast collar. A Han cavalry
  // horse's harness is hung with them, and they are the one thing that breaks
  // the long unmodulated run of the chest at board distance.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const t = 0.32 + i * 0.34;
      const at: V3 = [
        s * (flank.rx * 0.92 + (front.rx * 1.02 - flank.rx * 0.92) * t),
        flank.y + flank.ry * 0.85 + (front.y + front.ry * 0.2 - (flank.y + flank.ry * 0.85)) * t,
        -L * (0.24 + 0.16 * t),
      ];
      g.parts.push(
        P.trim.boss({
          at,
          r: HW * 0.15,
          height: HW * 0.07,
          boneHint: 'root',
          mountBone: 'horse.chest',
          pigment: 'metal',
          cls: 'iron',
          rot: [0, 0, s * Math.PI * 0.42],
          sides: 6,
        }),
      );
    }
  }

  // Crupper: over the croup, round the dock.
  const croup = barrelAt(d, L * 0.4);
  g.parts.push(
    P.trim.piping({
      path: [
        [0, croup.y + croup.ry * 0.98, seatZ + L * 0.19],
        [0, croup.y + croup.ry * 1.03, L * 0.34],
        [0, croup.y + croup.ry * 0.9, L * 0.5],
      ],
      r: HW * 0.055,
      boneHint: 'root',
      mountBone: 'horse.spine',
      pigment: 'leather',
      cls: 'leather',
      sides: 4,
      name: 'crupper',
    }),
  );
  void W;
}

/** Bridle: browband, cheek straps, noseband and bit. Returns the bit rings. */
function buildBridle(
  ctx: UnitBuildContext,
  d: Dims,
  g: PartGroup,
  poll: V3,
  muzzle: V3,
): { left: V3; right: V3 } {
  const P = ctx.parts;
  const { W, L, HW } = d;
  const r = HW * 0.045;

  for (const s of [-1, 1]) {
    // Cheek strap, poll to bit.
    g.parts.push(
      P.trim.piping({
        path: [
          [s * HW * 0.20, poll[1] - W * 0.005, poll[2] - L * 0.005],
          [s * HW * 0.30, W * 1.062, -L * 0.702],
          [s * HW * 0.245, W * 1.0, -L * 0.792],
          [s * HW * 0.215, W * 0.968, -L * 0.862],
        ],
        r,
        boneHint: 'root',
        mountBone: 'horse.head',
        pigment: 'leather',
        cls: 'leather',
        sides: 4,
        name: 'cheekStrap',
      }),
    );
    // Throatlatch.
    g.parts.push(
      P.trim.piping({
        path: [
          [s * HW * 0.22, poll[1] - W * 0.02, poll[2] + L * 0.005],
          [s * HW * 0.24, W * 1.02, -L * 0.625],
          [s * HW * 0.13, W * 0.985, -L * 0.6],
        ],
        r: r * 0.85,
        boneHint: 'root',
        mountBone: 'horse.head',
        pigment: 'leather',
        cls: 'leather',
        sides: 4,
        name: 'throatlatch',
      }),
    );
  }

  // Browband, across the forehead.
  g.parts.push(
    P.trim.piping({
      path: [
        [-HW * 0.30, W * 1.148, -L * 0.658],
        [0, W * 1.162, -L * 0.672],
        [HW * 0.30, W * 1.148, -L * 0.658],
      ],
      r,
      boneHint: 'root',
      mountBone: 'horse.head',
      pigment: 'leather',
      cls: 'leather',
      sides: 4,
      name: 'browband',
    }),
  );

  // Noseband — a closed loop around the muzzle.
  const nb: V3[] = [];
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    nb.push([Math.cos(a) * HW * 0.225, W * 0.99 + Math.sin(a) * W * 0.062, -L * 0.845 - Math.sin(a) * L * 0.012]);
  }
  g.parts.push(
    P.trim.piping({
      path: nb,
      r: r * 0.9,
      boneHint: 'root',
      mountBone: 'horse.head',
      pigment: 'leather',
      cls: 'leather',
      sides: 4,
      name: 'noseband',
    }),
  );

  // The bit: a bar through the mouth with a ring either side. The rings are the
  // rein anchors and the sockets the animator drives the hands to.
  const bitY = W * 0.968;
  const bitZ = -L * 0.868;
  const bar = P.prim.prism({
    rx0: HW * 0.035,
    y0: -HW * 0.26,
    y1: HW * 0.26,
    sides: 5,
    squareness: 0.3,
    name: 'bit',
  });
  P.prim.place(bar, { pos: [0, bitY, bitZ], rot: [0, 0, Math.PI / 2] });
  g.parts.push(
    P.mkPart(bar, 'iron', 'metal', 'root', { name: 'bit', rigid: true, mountBone: 'horse.head' }),
  );
  const left: V3 = [-HW * 0.27, bitY, bitZ];
  const right: V3 = [HW * 0.27, bitY, bitZ];
  for (const at of [left, right]) {
    const loop = P.rivets.cordLoop({
      at,
      r: HW * 0.085,
      thickness: HW * 0.028,
      boneHint: 'root',
      pigment: 'metal',
      rot: [0, Math.PI / 2, 0],
      segments: 8,
    });
    // `cordLoop` has no mount-bone option and classes itself as leather; both
    // are one field each on the returned part. Re-classing to iron folds the
    // rings into the unit's existing metal mesh instead of opening a bucket for
    // two thirty-triangle loops.
    loop.mountBone = 'horse.head';
    loop.cls = 'iron';
    g.parts.push(loop);
  }
  return { left, right };
}

/** 障泥 — Han: a square saddle cloth over both flanks with a fringed hem. */
function buildSaddleCloth(ctx: UnitBuildContext, d: Dims, g: PartGroup, seatZ: number): void {
  const P = ctx.parts;
  const { W, L, HW } = d;
  const z0 = seatZ - L * 0.20;
  const z1 = seatZ + L * 0.22;

  for (const s of [-1, 1]) {
    const grid: V3[][] = [];
    for (let r = 0; r < 4; r++) {
      const t = r / 3;
      const row: V3[] = [];
      for (let c = 0; c < 5; c++) {
        const u = c / 4;
        const z = z0 + (z1 - z0) * u;
        const sec = barrelAt(d, z);
        // Hugs the flank at the top, then hangs free below the belly line, with
        // a scalloped lower edge.
        const drop = t * t * W * 0.30;
        const scallop = r === 3 ? Math.sin(u * 10) * W * 0.022 : 0;
        const x = s * (sec.rx * (1.04 + t * 0.1));
        const y = sec.y + sec.ry * (0.62 - t * 1.35) - drop + scallop;
        row.push([x, y, z]);
      }
      grid.push(row);
    }
    g.parts.push(
      P.mkPart(P.prim.shell(grid, W * 0.011, { name: 'saddleCloth', flip: s > 0 }), 'cloth', 'cloth', 'root', {
        name: 'saddleCloth',
        rigid: true,
        mountBone: 'horse.spine',
      }),
    );
  }

  // Fringe along the hem: eleven short tapered strands a side, instanced. Kept
  // under the factory's bake threshold on purpose so it costs no draw call.
  const strand = P.prim.prism({
    rx0: HW * 0.028,
    rx1: HW * 0.012,
    y0: 0,
    y1: -W * 0.06,
    sides: 4,
    squareness: 0.2,
    name: 'fringe',
  });
  const mats: THREE.Matrix4[] = [];
  for (const s of [-1, 1]) {
    for (let i = 0; i < 11; i++) {
      const u = (i + 0.5) / 11;
      const z = z0 + (z1 - z0) * u;
      const sec = barrelAt(d, z);
      mats.push(
        P.prim.matrix(
          [s * sec.rx * 1.14, sec.y - sec.ry * 0.73 - W * 0.30 + Math.sin(u * 10) * W * 0.022, z],
          [0, 0, s * 0.12],
        ),
      );
    }
  }
  const fringe: InstancedPart = {
    geometry: strand,
    cls: 'cloth',
    pigment: 'accent',
    boneHint: 'root',
    mountBone: 'horse.spine',
    rigid: true,
    noSilk: true,
    transforms: mats,
    name: 'saddleClothFringe',
  };
  g.instanced.push(fringe);
}

/**
 * The Han chest tassel 纓: a bound collar on the breast collar and a bundle of
 * lacquered cords below it.
 *
 * Built here rather than with `trim.tassel` for one reason: that function
 * classes its strands as `cloth`, and a cinnabar cloth tassel would open a
 * whole (cloth, cinnabar) material bucket — a draw call — for forty triangles
 * of ornament. Classed as `lacquer` it merges into the mesh the rider's
 * cuirass and helmet already occupy, and lacquered silk cord is what the thing
 * actually is.
 */
function buildChestTassel(ctx: UnitBuildContext, d: Dims, g: PartGroup): void {
  const P = ctx.parts;
  const { W, L, HW } = d;
  const sec = barrelAt(d, -L * 0.42);
  const at: V3 = [0, sec.y - sec.ry * 0.22, -L * 0.475];

  const collar = P.prim.hardLathe(
    [
      [HW * 0.10, at[1] + W * 0.03],
      [HW * 0.22, at[1] - W * 0.01],
      [HW * 0.19, at[1] - W * 0.05],
      [HW * 0.11, at[1] - W * 0.065],
    ],
    6,
    { name: 'chestTasselCap' },
  );
  collar.translate(at[0], 0, at[2]);
  g.parts.push(
    P.mkPart(collar, 'lacquer', 'lacquer', 'root', {
      name: 'chestTasselCap',
      rigid: true,
      mountBone: 'horse.chest',
    }),
  );

  const strand = P.prim.prism({
    rx0: HW * 0.035,
    rx1: HW * 0.014,
    y0: 0,
    y1: -W * 0.18,
    sides: 4,
    squareness: 0.25,
    name: 'chestTasselStrand',
  });
  const mats: THREE.Matrix4[] = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const splay = 0.16 + (i % 3) * 0.05;
    mats.push(
      P.prim.matrix(
        [at[0] + Math.cos(a) * HW * 0.1, at[1] - W * 0.05, at[2] + Math.sin(a) * HW * 0.06],
        [Math.sin(a) * splay, 0, -Math.cos(a) * splay],
      ),
    );
  }
  g.instanced.push({
    geometry: strand,
    cls: 'lacquer',
    pigment: 'lacquer',
    boneHint: 'root',
    mountBone: 'horse.chest',
    rigid: true,
    noSilk: true,
    transforms: mats,
    name: 'chestTasselStrands',
  });
}

/** 馬鎧 — Chu: laced lamellar panels over the chest and the croup. */
function buildBarding(ctx: UnitBuildContext, d: Dims, g: PartGroup): void {
  const P = ctx.parts;
  const { W, L, HW } = d;

  // Both panels are deliberately kept to 22 plates each. The factory bakes an
  // instance set of fewer than twenty-four into the mesh it shares a material
  // with; at 24 or more it becomes its own `InstancedMesh` and costs a draw
  // call, and two panels plus their lacing would be four of them on every Chu
  // horse. Twenty-two plates in two deep rows covers the same area with the
  // same silhouette, for free.
  const panel = (
    label: string,
    stations: number[],
    count: number,
    arc: number,
    arcCentre: number,
    tilt: number,
    lift: (i: number) => number,
    bone: string,
  ) => {
    const rows = stations.map((z, i) => {
      const sec = barrelAt(d, z);
      return {
        y: sec.y + sec.ry * lift(i),
        rx: sec.rx * 1.05,
        rz: sec.ry * 1.14,
        cz: z,
        count,
        arc,
        arcCentre,
        tilt,
      };
    });
    const mid = barrelAt(d, stations[0]);
    const plateW = ((arc * (mid.rx + mid.ry) * 0.5) / count) * 1.1;
    const band = P.lamellar.lamellarBand({
      rows,
      plate: { w: plateW, h: W * 0.125, d: plateW * 0.11, bevel: plateW * 0.16, crown: plateW * 0.04 },
      boneHint: 'root',
      pigment: 'lacquer',
      cord: true,
      name: label,
    });
    stampMount(band, bone);
    g.instanced.push(...band.instanced);
  };

  panel(
    'bardingChest',
    [-L * 0.27, -L * 0.35],
    11,
    Math.PI * 1.1,
    -Math.PI / 2,
    -0.12,
    (i) => 0.42 - i * 0.62,
    'horse.chest',
  );
  panel(
    'bardingCroup',
    [L * 0.3, L * 0.38],
    11,
    Math.PI * 1.0,
    Math.PI / 2,
    0.12,
    (i) => 0.55 - i * 0.62,
    'horse.croup',
  );

  // A chamfron plate down the horse's face — cheap, and it turns the head from
  // an animal's into an armoured one at silhouette size.
  const cham = P.prim.shell(
    [
      [
        [-HW * 0.24, W * 1.16, -L * 0.652],
        [0, W * 1.182, -L * 0.668],
        [HW * 0.24, W * 1.16, -L * 0.652],
      ],
      [
        [-HW * 0.22, W * 1.062, -L * 0.755],
        [0, W * 1.086, -L * 0.77],
        [HW * 0.22, W * 1.062, -L * 0.755],
      ],
      [
        [-HW * 0.17, W * 1.0, -L * 0.845],
        [0, W * 1.018, -L * 0.855],
        [HW * 0.17, W * 1.0, -L * 0.845],
      ],
    ],
    W * 0.012,
    { name: 'chamfron', flip: true },
  );
  g.parts.push(
    P.mkPart(cham, 'lacquer', 'lacquer', 'root', { name: 'chamfron', rigid: true, mountBone: 'horse.head' }),
  );
}

// ===========================================================================
// The rider
// ===========================================================================

/**
 * Fold the rider's legs onto the barrel.
 *
 * The knee is fitted to the barrel's surface a little ahead of the girth and
 * the ankle to the surface below and behind it, both by `fitOnBarrel`, so the
 * leg's own thickness is accounted for and neither bone is stretched. Both come
 * out of `barrelAt`, so they cannot drift when the horse's proportions change —
 * change the barrel table and the rider's legs follow it.
 *
 * Offsets are deltas from the rig's own bind positions and are applied to a
 * bone *and its subtree*, so `footL`'s delta has `shinL`'s subtracted out.
 */
function seatOffsets(rig: Rig, d: Dims): NonNullable<RigOptions['offsets']> {
  const m = rig.metrics;
  const B = rig.bindWorld;
  const out: NonNullable<RigOptions['offsets']> = {};

  const kneeZ = -d.L * 0.10;
  const ankleZ = -d.L * 0.015;

  for (const S of ['L', 'R'] as const) {
    const s = S === 'L' ? -1 : 1;
    const knee = B[`shin${S}`];
    const ankle = B[`foot${S}`];
    const hip = v3(B[`thigh${S}`]);

    // Search from high on the shoulder down past the flank. The thigh grips
    // where its length puts it; on a deep-chested horse that is above the
    // widest point, which is the stirrupless Han seat.
    const kneeTarget = fitOnBarrel(d, kneeZ, hip, m.thighLen, m.thighR * 0.86, s, 1.3, -0.35);
    // The calf continues down and back around the flank from wherever the knee
    // landed, ending at the ankle: the shin wraps the barrel instead of hanging
    // off the side of it.
    const ankleTarget = fitOnBarrel(d, ankleZ, kneeTarget, m.shinLen, m.shinR * 0.86, s, 0.25, -1.35);

    const dKnee: V3 = [kneeTarget[0] - knee.x, kneeTarget[1] - knee.y, kneeTarget[2] - knee.z];
    out[`shin${S}` as BoneName] = dKnee;
    out[`foot${S}` as BoneName] = [
      ankleTarget[0] - ankle.x - dKnee[0],
      ankleTarget[1] - ankle.y - dKnee[1],
      ankleTarget[2] - ankle.z - dKnee[2],
    ];
  }

  // Lean into the canter. `proportions.stance` already pitches the whole upper
  // body forward about the hips; this pushes the shoulders a little further
  // ahead of them, which is the shape of a rider driving a horse forward rather
  // than one sitting on a parked one. Small: past about 8% of torso length it
  // stops reading as lean and starts reading as a hunchback.
  out.spine02 = [0, 0, -m.torsoLen * 0.07];
  return out;
}

/**
 * Pose an arm by *direction* instead of by angle.
 *
 * `upper` points from the shoulder to the elbow and `fore` from the elbow to
 * the wrist; both are normalised here and multiplied by the arm's own measured
 * bind lengths, so the pose can be authored as "out, back and up" without ever
 * stretching a bone. The shoulder itself does not move, which is what keeps the
 * pauldron sitting on it.
 *
 * The A-pose the rig hands out is a *bind* pose, not a stance. Left alone on a
 * mounted figure it reads as a man asleep in the saddle, and it hides the one
 * thing that separates the two armies' cavalry above the waist — the weapon.
 */
function armOffsets(
  rig: Rig,
  side: 'L' | 'R',
  upper: V3,
  fore: V3,
  out: NonNullable<RigOptions['offsets']>,
): void {
  const B = rig.bindWorld;
  const shoulder = B[`upperArm${side}`];
  const elbowBind = B[`foreArm${side}`];
  const wristBind = B[`hand${side}`];
  const lenU = shoulder.distanceTo(elbowBind);
  const lenF = elbowBind.distanceTo(wristBind);

  const u = unit(upper);
  const f = unit(fore);
  const elbow: V3 = [
    shoulder.x + u[0] * lenU,
    shoulder.y + u[1] * lenU,
    shoulder.z + u[2] * lenU,
  ];
  const wrist: V3 = [elbow[0] + f[0] * lenF, elbow[1] + f[1] * lenF, elbow[2] + f[2] * lenF];

  const dElbow: V3 = [elbow[0] - elbowBind.x, elbow[1] - elbowBind.y, elbow[2] - elbowBind.z];
  out[`foreArm${side}` as BoneName] = dElbow;
  out[`hand${side}` as BoneName] = [
    wrist[0] - wristBind.x - dElbow[0],
    wrist[1] - wristBind.y - dElbow[1],
    wrist[2] - wristBind.z - dElbow[2],
  ];
}

function unit(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Turn the fist so its bore lines up with what it is holding.
 *
 * `body.hand()` bores a real grip cylinder along +Y through the closed fingers,
 * and every weapon is authored haft-along-+Y at the origin — so a weapon placed
 * at the published grip passes *through* the hand only while the two share an
 * axis. Rotating a weapon without rotating the fist makes the haft leave
 * through the side of the knuckles, which is exactly the "detached hand" the
 * animator's contract forbids. Rotating the fist by the same Euler the weapon
 * gets keeps them locked.
 */
function rotateHand(g: PartGroup, side: 'L' | 'R', wrist: THREE.Vector3, rot: V3): void {
  const m = new THREE.Matrix4()
    .makeTranslation(wrist.x, wrist.y, wrist.z)
    .multiply(
      new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ')),
    )
    .multiply(new THREE.Matrix4().makeTranslation(-wrist.x, -wrist.y, -wrist.z));
  const names = new Set([
    `palm${side}`,
    `fingers${side}`,
    `fistCapT${side}`,
    `fistCapB${side}`,
    `fistBore${side}`,
    `thumb${side}`,
  ]);
  for (const p of g.parts) if (p.name && names.has(p.name)) p.geometry.applyMatrix4(m);
  const grip = g.points[`grip${side}`];
  if (grip) grip.applyMatrix4(m);
}

// ===========================================================================
// Builder
// ===========================================================================

function buildHorse(ctx: UnitBuildContext): PartGroup {
  const P = ctx.parts;
  const han = ctx.side === Side.Red;
  const h = ctx.spec.proportions.height;

  // The horse is sized against the rider, never independently: withers a touch
  // above his standing height, back short as Han relief horses are.
  const d: Dims = { W: h * 1.055, L: h * 1.6, HW: h * 1.055 * 0.245 };

  const steed = buildSteed(ctx, d);
  const g = steed.group;

  // --- seat the rider -----------------------------------------------------
  // Two rig builds: one to read where the default joints land, one to place
  // them on the barrel. The origin puts the pelvis exactly at the saddle seat.
  const origin: [number, number, number] = [0, steed.seat[1] - ctx.rig.metrics.legLen, steed.seat[2]];
  const rig0 = ctx.useRig({ origin });
  const offsets = seatOffsets(rig0, d);

  // Arm pose. Both riders carry the reins low and forward in the left hand; the
  // right differs by army, and that difference is most of what separates the
  // two cavalry silhouettes above the saddle.
  //   Han  the 環首刀 up at the shoulder, elbow out and back — a compact,
  //        vertical accent standing clear of the helmet.
  //   Chu  the 戟 carried forward and low, so the haft rakes back over the
  //        croup and lengthens the horizontal mass instead.
  // The yaw is not decoration: a blade is a thin plate, and one held in the
  // XY plane vanishes to a needle from the side. Turning it 50 degrees keeps
  // some blade width visible from every azimuth the camera director uses.
  // Raked back about 63 degrees from vertical — the cavalry shoulder carry, and
  // the steepest angle that keeps the point inside the unit's height budget.
  // Held upright the blade stands a fifth of a horse above the helmet and the
  // piece out-tops the general; height is monotone with piece value across this
  // cast, and a sabre is not worth breaking that ladder for. The 50-degree yaw
  // keeps the blade's flat visible from every azimuth the director uses.
  const daoRot: V3 = [1.1, 0.88, -0.3];
  const jiRot: V3 = [1.38, 0, -0.05];
  armOffsets(
    rig0,
    'R',
    han ? [0.62, 0.1, 0.44] : [0.55, -0.62, -0.5],
    han ? [0.2, 0.86, -0.2] : [0.18, -0.5, -0.85],
    offsets,
  );
  armOffsets(rig0, 'L', [-0.46, -0.62, -0.64], [-0.06, -0.26, -0.96], offsets);

  const rig = ctx.useRig({
    origin: [0, steed.seat[1] - rig0.metrics.legLen, steed.seat[2]],
    offsets,
  });
  const m = rig.metrics;
  const B = rig.bindWorld;

  // --- body ---------------------------------------------------------------
  merge(
    g,
    P.body.figure({
      metrics: m,
      bind: B,
      torsoPigment: 'cloth',
      torsoCls: 'cloth',
      bootShaft: 0.55, // riding boots, laced high
      deltoid: false, // pauldrons go over the shoulder instead
      handPose: 'fist',
    }),
  );

  // --- armour -------------------------------------------------------------
  // A cavalryman's harness: full cuirass, a short split skirt that clears the
  // saddle, pauldrons, bracers and greaves.
  merge(
    g,
    P.lamellar.cuirass({
      fromY: m.waistY - m.torsoLen * 0.12,
      toY: m.shoulderY + m.torsoLen * 0.03,
      rx0: m.waistWidth * 0.6,
      rx1: m.chestWidth * 0.6,
      depthRatio: 0.74,
      rows: 5,
      perRow: 14,
      cord: true,
      thickness: 0.1,
    }),
  );
  merge(
    g,
    P.lamellar.skirtArmour({
      topY: m.waistY - m.torsoLen * 0.1,
      bottomY: m.hipY - m.legLen * 0.14,
      rxTop: m.hipWidth * 0.62,
      rxBottom: m.hipWidth * 0.94,
      depthRatio: 0.84,
      rows: 2,
      perRow: 14,
      // A wide front gap: the thighs are spread round the barrel and a closed
      // skirt would shear straight through them.
      frontGap: 1.5,
      cord: true,
    }),
  );
  for (const S of ['L', 'R'] as const) {
    merge(
      g,
      P.lamellar.pauldron({
        side: S,
        shoulder: v3(B[`upperArm${S}`]),
        r: m.upperArmR * 2.6,
        rows: 3,
        perRow: 5,
      }),
    );
    merge(
      g,
      P.lamellar.tubeArmour({
        bone: `foreArm${S}` as BoneName,
        from: v3(B[`foreArm${S}`]),
        to: v3(B[`hand${S}`]),
        r: m.foreArmR * 1.6,
        rows: 2,
        perRow: 7,
        arc: Math.PI * 1.4,
        facing: S === 'L' ? -1 : 1,
      }),
    );
    merge(
      g,
      P.lamellar.tubeArmour({
        bone: `shin${S}` as BoneName,
        from: v3(B[`shin${S}`]),
        to: v3(B[`foot${S}`]),
        r: m.shinR * 1.75,
        rows: 3,
        perRow: 7,
        arc: Math.PI * 1.15,
        facing: S === 'L' ? -1 : 1,
      }),
    );
  }
  merge(
    g,
    P.lamellar.neckGuard({
      y: m.shoulderY + m.torsoLen * 0.02,
      r: m.neckR * 2.7,
      height: m.neckLen * 0.6,
      count: 12,
    }),
  );
  g.parts.push(
    P.cloth.sash({
      y: m.waistY,
      rx: m.waistWidth * 0.58,
      rz: m.waistDepth * 0.66,
      height: m.torsoLen * 0.12,
      tail: m.torsoLen * 0.3,
    }).parts[0],
  );

  // --- head ---------------------------------------------------------------
  // The crown tag is `horned` in both armies — that contract is fixed — but the
  // helmet *under* the horns is not. Han wears the rolled-brim 兜鍪 and short,
  // heavy ox horns; Chu wears the forward-raked peaked helm and long swept
  // horns. Same tag, two unmistakably different heads.
  const helm = P.helmet.helmet({
    style: han ? 'hanDoumou' : 'chuPeaked',
    baseY: B.head.y,
    headLen: m.headLen,
    headWidth: m.headWidth,
    headDepth: m.headDepth,
    z: B.head.z,
    cheeks: true,
    nape: true,
    rivets: han,
  });
  merge(g, helm);
  merge(
    g,
    P.helmet.crest({
      style: 'hornPair',
      at: v3(helm.points.crest),
      height: m.headLen * (han ? 0.58 : 0.86),
      width: m.headWidth * (han ? 0.78 : 0.56),
    }),
  );

  // --- weapons ------------------------------------------------------------
  // Turn each fist to match what it holds, *then* read the grip: the published
  // point moves with the hand, so the haft still runs through the bore.
  rotateHand(g, 'R', B.handR, han ? daoRot : jiRot);
  const gripR = g.points.gripR ?? B.handR;
  const gripL = g.points.gripL ?? B.handL;
  let tip: THREE.Vector3;

  if (han) {
    // 環首刀 — the ring-pommel sabre, carried up at the shoulder ready to cut
    // down across the horse's off side. Short and vertical: the Han rider's
    // outline is compact above the saddle, and the horizontal length comes
    // from the animal and the guidon instead.
    const before = g.points.tip;
    merge(
      g,
      P.weapons.dao({
        grip: v3(gripR),
        bone: 'handR',
        rot: daoRot,
        length: h * 0.52,
        halfWidth: h * 0.021,
        metalPigment: 'metal',
      }),
    );
    tip = g.points.tip !== before && g.points.tip ? g.points.tip : new THREE.Vector3(...v3(gripR));
  } else {
    // 戟 — a long halberd laid back over the croup. It is the single biggest
    // contributor to the Chu horse's horizontal read, and raking it back rather
    // than up keeps it out of the height budget.
    const before = g.points.tip;
    const halberd = P.weapons.ji({
      grip: v3(gripR),
      bone: 'handR',
      rot: jiRot,
      length: h * 1.86,
      gripAt: 0.34,
      shaftR: h * 0.014,
      metalPigment: 'metal',
    });
    // 戈 lashes its three haft ferrules in the accent pigment, which on an
    // otherwise all-iron weapon opens an (iron, accent) bucket for thirty
    // triangles. They are lacquered iron bands either way; retag them.
    for (const p of halberd.parts) if (p.pigment === 'accent') p.pigment = 'metal';
    merge(g, halberd);
    tip = g.points.tip !== before && g.points.tip ? g.points.tip : new THREE.Vector3(...v3(gripR));
  }
  g.attach.push({ name: 'haftTip', bone: 'handR', position: [tip.x, tip.y, tip.z] });

  // Scabbard at the hip, hung on the off side clear of the saddle.
  const hipAt: V3 = [
    B.pelvis.x - m.hipWidth * 0.72,
    B.pelvis.y + m.torsoLen * 0.02,
    B.pelvis.z + m.hipDepth * 0.3,
  ];
  merge(
    g,
    P.weapons.scabbard({
      grip: hipAt,
      rot: [0.5, 0, 0.42],
      bone: 'pelvis',
      length: h * 0.3,
      width: h * 0.034,
    }),
  );
  g.attach.push({ name: 'hip', bone: 'pelvis', position: hipAt });

  // --- reins --------------------------------------------------------------
  buildReins(ctx, g, steed, v3(gripL));

  // --- the army's pennant -------------------------------------------------
  if (han) {
    // 旌 — a stiff square guidon on a short staff socketed at the cantle,
    // raked back so it lengthens the mass instead of raising it.
    merge(
      g,
      P.standard.standard({
        shape: 'hanSquare',
        base: [d.HW * 0.42, steed.cantle[1] - d.W * 0.02, steed.cantle[2]],
        poleLength: h * 0.52,
        poleR: h * 0.012,
        bannerHeight: h * 0.26,
        bannerWidth: h * 0.3,
        lean: 1.02,
        fly: -0.5,
        boneHint: 'root',
        mountBone: 'horse.spine',
        clothPigment: 'accent',
        polePigment: 'leather',
        // `metalPigment` is left at its default on purpose: passing it also
        // recolours the pole's knot tassel, whose strands are cloth, and that
        // would open a (cloth, metal) bucket for one tassel. The ferrules and
        // finial resolve to the army's metal either way.
        streamerCount: 4,
        phase: ctx.rng.range(0, 6.28),
      }),
    );
  } else {
    // 幡 — a swallow-tailed pennon lashed below the 戟's head. Same job as the
    // Han guidon, hung off the weapon instead of the saddle, and notched.
    const along = tip.clone().sub(gripR);
    const at = tip.clone().addScaledVector(along, -0.24);
    merge(
      g,
      P.standard.banner({
        shape: 'chuSwallowtail',
        at: [at.x, at.y, at.z],
        height: h * 0.2,
        width: h * 0.3,
        fly: 0.35,
        wave: 0.16,
        phase: ctx.rng.range(0, 6.28),
        boneHint: 'handR',
        pigment: 'accent',
      }),
    );
  }

  return g;
}

/**
 * Two reins, each built in two halves.
 *
 * A rein spans a mount bone (the horse's head) and a humanoid bone (the rider's
 * hand), and no single rigid part can follow both. Splitting it at the neck
 * crest — the point on the run where *both* ends move least — and binding the
 * front half to `horse.head` and the rear half to `handL` gives a rein that
 * bends in the middle when either end moves instead of one that detaches at an
 * end. It is the same trick a hand-animated rein uses, and it is invisible at
 * the scale a rein is seen at.
 */
function buildReins(ctx: UnitBuildContext, g: PartGroup, steed: Steed, hand: V3): void {
  const P = ctx.parts;
  const r = steed.dims.HW * 0.035;
  for (const S of ['L', 'R'] as const) {
    const bit = S === 'L' ? steed.reinL : steed.reinR;
    const hx = hand[0] + (S === 'L' ? -1 : 1) * steed.dims.HW * 0.14;
    const mid: V3 = [
      (bit[0] + hx) * 0.5,
      (bit[1] + hand[1]) * 0.5 + steed.dims.W * 0.06,
      (bit[2] + hand[2]) * 0.5,
    ];
    g.parts.push(
      P.trim.piping({
        path: [bit, [(bit[0] + mid[0]) * 0.5, (bit[1] + mid[1]) * 0.5 + steed.dims.W * 0.015, (bit[2] + mid[2]) * 0.5], mid],
        r,
        boneHint: 'root',
        mountBone: 'horse.head',
        pigment: 'leather',
        cls: 'leather',
        sides: 4,
        name: `rein${S}Front`,
      }),
    );
    g.parts.push(
      P.trim.piping({
        path: [mid, [(mid[0] + hx) * 0.5, (mid[1] + hand[1]) * 0.5 + steed.dims.W * 0.01, (mid[2] + hand[2]) * 0.5], [hx, hand[1], hand[2]]],
        r,
        boneHint: 'handL',
        pigment: 'leather',
        cls: 'leather',
        sides: 4,
        name: `rein${S}Rear`,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Fold `src` into `dst` in place, keeping `dst`'s identity. */
function merge(dst: PartGroup, src: PartGroup): void {
  dst.parts.push(...src.parts);
  dst.instanced.push(...src.instanced);
  dst.bones.push(...src.bones);
  dst.attach.push(...src.attach);
  for (const k of Object.keys(src.points)) dst.points[k] = src.points[k];
}

/** Re-class every part whose name ends with `suffix`. */
function retag(g: PartGroup, suffix: string, cls: Part['cls']): void {
  for (const p of g.parts) if (p.name && p.name.endsWith(suffix)) p.cls = cls;
}

/**
 * Re-home a group onto a mount bone.
 *
 * `parts/lamellar.ts` binds its plates to humanoid bones because that is what
 * armour on a man needs; armour on a *horse* needs the same plates on a horse
 * bone. Stamping `mountBone` afterwards is all that takes — the factory hosts
 * an instanced part on `mountBone ?? boneHint` — and it keeps the barding
 * inside this file instead of forcing a change to the shared parts library.
 */
function stampMount(g: PartGroup, bone: string): void {
  for (const p of g.parts as Part[]) p.mountBone = bone;
  for (const p of g.instanced) p.mountBone = bone;
}

registerUnit(PieceType.Horse, buildHorse);
