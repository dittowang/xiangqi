/**
 * 相 / 象 — the war elephant.
 * ============================================================================
 *
 * The biggest solid mass on the board, and the one unit that has to be
 * unmistakable from a black shape alone at any camera angle. Three cues carry
 * it, and all three are deliberately over-scaled relative to a real animal:
 *
 *   TUSKS      long, low and forward, a pair of hard curved strokes leaving the
 *              mass at the front — nothing else in the cast has them;
 *   TRUNK      a segmented column dropping from between the tusks to the board,
 *              read as a vertical stroke at the leading edge of the mass;
 *   EAR PLATES two flat slabs standing off the head, which widen the front of
 *              the silhouette exactly where the chariot's is open frame.
 *
 * The elephant must never be confused with the chariot. It is a **tall solid
 * mass**: no wheels, no spokes, no floating canopy disc, no gaps under the
 * body. The chariot is a wide open frame with a disc over it. Even in shadow
 * the difference is fill versus outline.
 *
 * TWO ARMIES.
 *   Han 漢  a lacquered 象輿 howdah on the back with a low rail and a fringed
 *           valance, a square 旌 at its rear corner, and a mahout seated
 *           forward at the neck driving with a 鉤 goad. Rider low and forward,
 *           box high and behind: an L.
 *   Chu 楚  no howdah at all. A tilted war drum 鼓 cradled on the back, a
 *           drummer seated behind it mid-beat with one mallet raised and the
 *           other down across the head, and a heavy riveted headplate carrying
 *           an upright crest between the ears. Rider high and central, drum
 *           face turned to the camera: a wedge with a disc in it.
 * The two outlines are different shapes, not the same shape in two colours.
 *
 * THE TRUNK IS THE ATTACK. `elephant.trunk01`..`trunk10`, ten bones, each
 * carrying one rigid section, laid on a shallow half-radian arc so the rest
 * pose already shows the curve the silhouette is named for. `trunkTip` is
 * published as an end effector; see `buildTrunk` for why a rest curve is safe
 * here when the parts library's own trunk is built straight.
 *
 * Reference: Han bronze and lacquer elephants for the columnar leg and the low
 * heavy head; Dian and Chu bronze drums for the drum; Han 畫像石 for the
 * howdah's post-and-rail construction.
 */

import * as THREE from 'three';
import type { BoneName } from '@core/contracts.ts';
import { PieceType, Side } from '@core/types.ts';
import { registerUnit, type UnitBuildContext } from '@characters/factory.ts';
import type { InstancedPart, Part, PartGroup, PartPigment, V3 } from '@characters/parts/types.ts';
import type { Rig, RigOptions } from '@characters/rig.ts';

// ---------------------------------------------------------------------------
// Substances that are the same in both armies
// ---------------------------------------------------------------------------

/** Elephant hide. Grey in both armies — the army lives in the trappings. */
const HIDE: PartPigment = 'stone';
/** Tusk, toenail and drumhead: all the same pale keratin/rawhide bucket. */
const BONE: PartPigment = 'shellWhite';

const v3 = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];

/** Segments in the trunk. The brief's floor is eight; ten sweeps smoother. */
const TRUNK_SEGMENTS = 10;
/** Total rest-pose bend of the trunk, radians. See `buildTrunk`. */
const TRUNK_BEND = 0.5;

// ===========================================================================
// The animal's cross-section
// ===========================================================================

interface BodyStation {
  /** Longitudinal position as a fraction of body length; -0.62 is the poll. */
  t: number;
  /** Section centre height as a fraction of shoulder height. */
  y: number;
  /** Half-width across X as a fraction of the body half-width. */
  rx: number;
  /** Half-height across Y as a fraction of shoulder height. */
  ry: number;
  sq: number;
}

/**
 * Nine stations from the poll to the rump. The neck stations at the front are
 * part of the same table on purpose: the Han mahout sits astride the *neck* and
 * the Chu drummer astride the *back*, and both need their legs fitted to the
 * surface they actually straddle, from one function.
 *
 * An Asian elephant's back is highest in the middle, not at the shoulder; that
 * dome is what makes the profile read as an elephant rather than as an ox.
 */
const BODY: readonly BodyStation[] = [
  { t: -0.62, y: 0.660, rx: 0.50, ry: 0.190, sq: 0.45 }, // poll
  { t: -0.52, y: 0.648, rx: 0.63, ry: 0.235, sq: 0.48 }, // neck
  { t: -0.42, y: 0.636, rx: 0.80, ry: 0.266, sq: 0.50 }, // neck base
  { t: -0.28, y: 0.626, rx: 1.00, ry: 0.296, sq: 0.55 }, // shoulder
  { t: -0.06, y: 0.625, rx: 1.06, ry: 0.306, sq: 0.55 }, // widest, deepest
  { t: 0.16, y: 0.622, rx: 1.03, ry: 0.302, sq: 0.55 }, // domed back
  { t: 0.34, y: 0.610, rx: 0.92, ry: 0.275, sq: 0.52 },
  { t: 0.48, y: 0.575, rx: 0.60, ry: 0.195, sq: 0.48 }, // rump
];

interface Dims {
  /** Shoulder height above the ground, rig units. */
  S: number;
  /** Body length, chest to rump, rig units. */
  L: number;
  /** Body half-width at the widest station, rig units. */
  HW: number;
}

interface Section {
  y: number;
  rx: number;
  ry: number;
}

/**
 * The body's elliptical cross-section at a longitudinal station, rig units.
 * Published on `elephant.spine` so a rider's leg IK can rebuild the surface it
 * has to sit on without measuring geometry.
 */
function bodyAt(d: Dims, z: number): Section {
  const t = z / d.L;
  const n = BODY.length;
  if (t <= BODY[0].t) return scale(d, BODY[0]);
  if (t >= BODY[n - 1].t) return scale(d, BODY[n - 1]);
  for (let i = 0; i < n - 1; i++) {
    const a = BODY[i];
    const b = BODY[i + 1];
    if (t >= a.t && t <= b.t) {
      const u = (t - a.t) / (b.t - a.t);
      return {
        y: (a.y + (b.y - a.y) * u) * d.S,
        rx: (a.rx + (b.rx - a.rx) * u) * d.HW,
        ry: (a.ry + (b.ry - a.ry) * u) * d.S,
      };
    }
  }
  return scale(d, BODY[n - 1]);
}

function scale(d: Dims, s: BodyStation): Section {
  return { y: s.y * d.S, rx: s.rx * d.HW, ry: s.ry * d.S };
}

/** Top of the animal's back at a station — where anything strapped on rests. */
function backY(d: Dims, z: number): number {
  const s = bodyAt(d, z);
  return s.y + s.ry;
}

/**
 * A point on the body at station `z` and angle `theta` (0 = the flank, +π/2 =
 * the spine), pushed `off` clear of the hide along the true ellipse normal —
 * pass a limb's own radius and the result is where that limb's centre line must
 * sit for its surface to rest on the animal's.
 */
function bodySurface(d: Dims, z: number, theta: number, off: number, side: number): V3 {
  const s = bodyAt(d, z);
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  let nx = c / s.rx;
  let ny = sn / s.ry;
  const l = Math.hypot(nx, ny) || 1;
  nx /= l;
  ny /= l;
  return [side * (s.rx * c + nx * off), s.y + s.ry * sn + ny * off, z];
}

/**
 * Put a joint on the body at exactly `len` from `from`: scan the contour for
 * the closest match, then snap to the bone's true length along that direction.
 *
 * An elephant is enormously wider than a man's leg is long, so on the back the
 * knee lands high on the shoulder of the barrel and the shin splays down the
 * upper flank rather than hanging beside it — which is precisely how a rider
 * sits on an elephant with no saddle, and it comes out of the arithmetic rather
 * than being posed by hand. The bone is never stretched, so the animator's IK
 * and the rig's `bindLengths` agree with each other.
 */
function fitOnBody(
  d: Dims,
  z: number,
  from: V3,
  len: number,
  off: number,
  side: number,
  fromTheta: number,
  toTheta: number,
): V3 {
  let best: V3 = bodySurface(d, z, fromTheta, off, side);
  let bestErr = Infinity;
  const steps = 96;
  for (let i = 0; i <= steps; i++) {
    const th = fromTheta + ((toTheta - fromTheta) * i) / steps;
    const p = bodySurface(d, z, th, off, side);
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

// ===========================================================================
// The elephant
// ===========================================================================

interface Beast {
  group: PartGroup;
  dims: Dims;
  /** Rider's pelvis, rig space — the neck for Han, the back for Chu. */
  seat: V3;
  /** Longitudinal station the rider straddles; his legs fit `bodyAt(seatZ)`. */
  seatZ: number;
  /** Mount bone the seat hangs from. */
  seatBone: string;
  /** Tip of the trunk in bind pose. */
  trunkTip: V3;
  /** Base of the head dome, for headgear and goad targets. */
  headTop: V3;
}

function buildBeast(ctx: UnitBuildContext, d: Dims): Beast {
  const P = ctx.parts;
  const { prim } = P;
  const han = ctx.side === Side.Red;
  const g = P.emptyGroup();
  const { S, L, HW } = d;

  const headZ = -L * 0.58;
  const headBase = S * 0.60;
  const headTopY = S * 0.955;

  // -- skeleton ------------------------------------------------------------
  g.bones.push(
    {
      name: 'elephant.spine',
      parent: 'root',
      position: [0, bodyAt(d, L * 0.1).y, L * 0.1],
      data: {
        // The published body surface, rig units — see `bodyAt()`. The section
        // at station z is an ellipse centred (0, bodyY, z) with half-extents
        // bodyHalfWidth / bodyHalfHeight, valid across [bodyZFront, bodyZBack].
        bodyY: bodyAt(d, L * 0.05).y,
        bodyZ: L * 0.05,
        bodyHalfWidth: bodyAt(d, L * 0.05).rx,
        bodyHalfHeight: bodyAt(d, L * 0.05).ry,
        bodyZFront: -L * 0.3,
        bodyZBack: L * 0.34,
        bodySquareness: 0.55,
        backY: backY(d, L * 0.05),
        bodyLength: L,
        shoulderHeight: S,
      },
    },
    { name: 'elephant.chest', parent: 'elephant.spine', position: [0, bodyAt(d, -L * 0.28).y, -L * 0.28] },
    {
      name: 'elephant.neck',
      parent: 'elephant.chest',
      position: [0, bodyAt(d, -L * 0.46).y, -L * 0.46],
      data: {
        // The neck section, for the Han mahout's legs.
        neckY: bodyAt(d, -L * 0.46).y,
        neckHalfWidth: bodyAt(d, -L * 0.46).rx,
        neckHalfHeight: bodyAt(d, -L * 0.46).ry,
        backY: backY(d, -L * 0.46),
      },
    },
    { name: 'elephant.head', parent: 'elephant.neck', position: [0, headBase + S * 0.14, headZ] },
    { name: 'elephant.earL', parent: 'elephant.head', position: [-HW * 0.56, headBase + S * 0.24, headZ + L * 0.03] },
    { name: 'elephant.earR', parent: 'elephant.head', position: [HW * 0.56, headBase + S * 0.24, headZ + L * 0.03] },
    { name: 'elephant.tail01', parent: 'elephant.spine', position: [0, backY(d, L * 0.44) - S * 0.02, L * 0.48] },
    { name: 'elephant.tail02', parent: 'elephant.tail01', position: [0, S * 0.42, L * 0.5] },
  );

  // -- body ----------------------------------------------------------------
  // Eight facets, a crease at every station, and squareness ramped up through
  // the middle so the flanks are planes. An elephant in relief is a slab with
  // rounded ends, not a barrel.
  const body = prim.sweep(
    BODY.map((s) => ({
      p: [0, s.y * S, s.t * L] as V3,
      rx: s.rx * HW,
      rz: s.ry * S,
      squareness: s.sq,
    })),
    { sides: 8, name: 'elephantBody' },
  );
  g.parts.push(
    P.mkPart(body, 'leather', HIDE, 'root', { name: 'elephantBody', rigid: true, mountBone: 'elephant.spine' }),
  );

  // -- head ----------------------------------------------------------------
  buildHead(ctx, d, g, headZ, headBase, headTopY);
  buildEars(ctx, d, g, headZ, headBase);
  const tusk = buildTusks(ctx, d, g, headZ, headBase);
  const trunkTip = buildTrunk(ctx, d, g, headZ, headBase);

  // -- legs ----------------------------------------------------------------
  // Columnar: almost no taper and the joints nearly in line. That column is why
  // an elephant reads as heavy where a horse reads as fast — and it is also why
  // there is no daylight under the body, which is the whole separation from the
  // chariot.
  const legR = S * 0.108;
  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    for (const [tag, parent, z] of [
      ['F', 'elephant.chest', -L * 0.26],
      ['H', 'elephant.spine', L * 0.28],
    ] as const) {
      const leg = P.mount.quadrupedLeg({
        prefix: `elephant.leg${tag}${side}`,
        parent,
        joints: [
          [s * HW * 0.64, S * 0.60, z],
          [s * HW * 0.68, S * 0.375, z + (tag === 'F' ? S * 0.012 : -S * 0.012)],
          [s * HW * 0.70, S * 0.135, z],
          [s * HW * 0.70, S * 0.058, z],
        ],
        radii: [legR * 1.22, legR * 1.06, legR * 0.98, legR * 1.08],
        pigment: HIDE,
        hoofPigment: HIDE,
        sides: 7,
        flatten: 0.94,
        hoofHeight: S * 0.058,
      });
      // The foot pad is the same hide as the rest of the animal, so it goes in
      // the hide's mesh rather than opening a (stone, stone) pair of its own.
      for (const part of leg.parts) if (part.name && part.name.endsWith(':hoof')) part.cls = 'leather';
      g.parts.push(...leg.parts);
      g.bones.push(...leg.bones);
      // A lumbering walk is a lateral-sequence four-beat: left hind, left fore,
      // right hind, right fore. Published so the animator does not guess.
      const beat = (tag === 'H' ? 0 : 1) + (s < 0 ? 0 : 2);
      for (const b of leg.bones) if (b.name.endsWith('01')) b.data = { walkBeat: beat };

      // Hide creases. An elephant's leg is not a smooth column; it is a stack
      // of loose folds, and under a three-band leather ramp each crease is a
      // shadow line that reads at board distance where surface shading does
      // not. Two per segment, sitting on the bone the segment already uses, so
      // they flex with it.
      for (const [seg, hAt, rAt] of [
        [1, 0.485, 1.14],
        [1, 0.415, 1.10],
        [2, 0.275, 1.06],
        [2, 0.190, 1.03],
      ] as const) {
        const y = S * hAt;
        const crease = prim.loft(
          [
            prim.ring({ rx: legR * rAt * 0.97, rz: legR * rAt * 0.92, y: y - S * 0.012, cx: s * HW * 0.68, cz: z, sides: 7, squareness: 0.4 }),
            prim.ring({ rx: legR * rAt, rz: legR * rAt * 0.95, y, cx: s * HW * 0.68, cz: z, sides: 7, squareness: 0.4 }),
            prim.ring({ rx: legR * rAt * 0.95, rz: legR * rAt * 0.90, y: y + S * 0.016, cx: s * HW * 0.68, cz: z, sides: 7, squareness: 0.4 }),
          ],
          { capStart: false, capEnd: false, name: 'legCrease' },
        );
        g.parts.push(
          P.mkPart(crease, 'leather', HIDE, 'root', {
            name: 'legCrease',
            rigid: true,
            mountBone: `elephant.leg${tag}${side}0${seg}`,
          }),
        );
      }

      // Toenails: four flat plates round the front of each foot. Tiny, and the
      // single thing that stops a columnar leg ending in a cylinder.
      const nails: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 4; i++) {
        const a = -0.9 + (i / 3) * 1.8;
        const nail = prim.bevelSlab({
          w: legR * 0.34,
          h: legR * 0.3,
          d: legR * 0.12,
          bevel: legR * 0.06,
          name: 'toenail',
        });
        prim.place(nail, {
          pos: [
            s * HW * 0.7 + Math.sin(a) * legR * 1.02,
            S * 0.03,
            z - Math.cos(a) * legR * 1.02,
          ],
          rot: [0.3, a, 0],
        });
        nails.push(nail);
      }
      g.parts.push(
        P.mkPart(prim.mergeGeometryList(nails), 'ivory', BONE, 'root', {
          name: `toenails${tag}${side}`,
          rigid: true,
          mountBone: `elephant.leg${tag}${side}04`,
        }),
      );
    }
  }

  // -- tail ----------------------------------------------------------------
  {
    const tail = prim.sweep(
      [
        { p: [0, backY(d, L * 0.46) - S * 0.03, L * 0.48] as V3, rx: S * 0.032, squareness: 0.4 },
        { p: [0, S * 0.50, L * 0.505] as V3, rx: S * 0.026, squareness: 0.4 },
        { p: [0, S * 0.30, L * 0.50] as V3, rx: S * 0.020, squareness: 0.4 },
      ],
      { sides: 5, name: 'elephantTail' },
    );
    g.parts.push(
      P.mkPart(tail, 'leather', HIDE, 'root', { name: 'elephantTail', rigid: true, mountBone: 'elephant.tail01' }),
    );
    // The tuft — three hard strands, so the tail ends in a shape.
    for (let i = 0; i < 3; i++) {
      const x = (i - 1) * S * 0.022;
      const tuft = prim.prism({
        rx0: S * 0.014,
        rx1: S * 0.005,
        y0: 0,
        y1: -S * 0.11,
        sides: 4,
        squareness: 0.3,
        name: 'tailTuft',
      });
      prim.place(tuft, { pos: [x, S * 0.30, L * 0.5], rot: [0, 0, (i - 1) * 0.16] });
      g.parts.push(
        P.mkPart(tuft, 'hair', 'ink', 'root', { name: 'tailTuft', rigid: true, mountBone: 'elephant.tail02' }),
      );
    }
  }

  // -- army trappings ------------------------------------------------------
  let seat: V3;
  let seatZ: number;
  let seatBone: string;

  if (han) {
    // The mahout rides the neck; the howdah rides the back, empty and railed.
    seatZ = -L * 0.46;
    seat = [0, backY(d, seatZ) + S * 0.035, seatZ];
    seatBone = 'elephant.neck';
    buildHowdah(ctx, d, g);
    // A padded neck roll under the mahout, so he is not sitting on bare spine.
    const nk = bodyAt(d, seatZ);
    const pad = prim.loft(
      [
        prim.ring({ rx: nk.rx * 0.94, rz: L * 0.075, y: nk.y + nk.ry * 0.55, cz: seatZ, sides: 6, squareness: 0.5 }),
        prim.ring({ rx: nk.rx * 0.86, rz: L * 0.07, y: nk.y + nk.ry * 1.06, cz: seatZ, sides: 6, squareness: 0.55 }),
      ],
      { capStart: false, name: 'neckPad' },
    );
    g.parts.push(
      P.mkPart(pad, 'cloth', 'cloth', 'root', { name: 'neckPad', rigid: true, mountBone: 'elephant.neck' }),
    );
  } else {
    // The drummer rides the back behind the drum.
    seatZ = L * 0.23;
    seat = [0, backY(d, seatZ) + S * 0.045, seatZ];
    seatBone = 'elephant.spine';
    buildDrum(ctx, d, g);
    buildHeadplate(ctx, d, g, headZ, headBase, headTopY);
    const bk = bodyAt(d, seatZ);
    const pad = prim.loft(
      [
        prim.ring({ rx: bk.rx * 0.8, rz: L * 0.1, y: bk.y + bk.ry * 0.7, cz: seatZ, sides: 6, squareness: 0.5 }),
        prim.ring({ rx: bk.rx * 0.66, rz: L * 0.09, y: bk.y + bk.ry * 1.1, cz: seatZ, sides: 6, squareness: 0.55 }),
      ],
      { capStart: false, name: 'backPad' },
    );
    g.parts.push(
      P.mkPart(pad, 'cloth', 'cloth', 'root', { name: 'backPad', rigid: true, mountBone: 'elephant.spine' }),
    );
  }

  // Girth strap round the barrel — it holds the howdah or the drum cradle on,
  // and in both armies it is the one line that crosses the flank plane.
  {
    const gz = L * 0.02;
    const gs = bodyAt(d, gz);
    const loop: V3[] = [];
    for (let i = 0; i <= 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      loop.push([Math.cos(a) * gs.rx * 1.02, gs.y + Math.sin(a) * gs.ry * 1.02, gz]);
    }
    g.parts.push(
      P.trim.piping({
        path: loop,
        r: S * 0.022,
        boneHint: 'root',
        mountBone: 'elephant.spine',
        pigment: 'leather',
        cls: 'leather',
        sides: 4,
        name: 'girth',
      }),
    );
  }

  // -- published landmarks and sockets -------------------------------------
  g.points.seat = new THREE.Vector3(...seat);
  g.points.withers = new THREE.Vector3(0, backY(d, -L * 0.28), -L * 0.28);
  g.points.trunkTip = new THREE.Vector3(...trunkTip);
  g.points.tuskL = new THREE.Vector3(...tusk.left);
  g.points.tuskR = new THREE.Vector3(...tusk.right);
  g.attach.push(
    { name: 'mountSeat', bone: seatBone, position: seat },
    {
      name: 'trunkTip',
      bone: `elephant.trunk${String(TRUNK_SEGMENTS).padStart(2, '0')}`,
      position: trunkTip,
    },
  );

  return {
    group: g,
    dims: d,
    seat,
    seatZ,
    seatBone,
    trunkTip,
    headTop: [0, headTopY, headZ],
  };
}

// ---------------------------------------------------------------------------
// Head, ears, tusks, trunk
// ---------------------------------------------------------------------------

/**
 * The skull: a domed forehead in two lobes over a heavy brow, a temple hollow
 * either side, and a blunt block below carrying the trunk and the tusk sockets.
 * Built as planes meeting at edges, because a smooth dome under a quantised
 * ramp is one flat band and reads as a balloon.
 */
function buildHead(
  ctx: UnitBuildContext,
  d: Dims,
  g: PartGroup,
  headZ: number,
  base: number,
  topY: number,
): void {
  const P = ctx.parts;
  const { prim } = P;
  const { S, L, HW } = d;
  const bone = 'elephant.head';

  const skull = prim.loft(
    [
      prim.ring({ rx: HW * 0.56, rz: S * 0.16, y: base - S * 0.10, cz: headZ + L * 0.02, sides: 8, squareness: 0.55 }),
      prim.ring({ rx: HW * 0.70, rz: S * 0.20, y: base + S * 0.06, cz: headZ, sides: 8, squareness: 0.52 }),
      prim.ring({ rx: HW * 0.74, rz: S * 0.21, y: base + S * 0.20, cz: headZ - L * 0.005, sides: 8, squareness: 0.5 }),
      prim.ring({ rx: HW * 0.66, rz: S * 0.185, y: base + S * 0.30, cz: headZ - L * 0.005, sides: 8, squareness: 0.5 }),
      prim.ring({ rx: HW * 0.42, rz: S * 0.12, y: topY - S * 0.02, cz: headZ, sides: 8, squareness: 0.5 }),
    ],
    { name: 'elephantSkull' },
  );
  g.parts.push(P.mkPart(skull, 'leather', HIDE, 'root', { name: 'elephantSkull', rigid: true, mountBone: bone }));

  // The two crown lobes. An elephant's forehead is not one dome; the pair of
  // bosses with a valley between them is the shape a viewer names instantly.
  for (const s of [-1, 1]) {
    const lobe = prim.hardLathe(
      [
        [HW * 0.30, topY - S * 0.14],
        [HW * 0.29, topY - S * 0.06],
        [HW * 0.22, topY - S * 0.005],
        [HW * 0.06, topY + S * 0.028],
      ],
      6,
      { capStart: false, name: 'crownLobe' },
    );
    lobe.translate(s * HW * 0.26, 0, headZ - L * 0.005);
    g.parts.push(P.mkPart(lobe, 'leather', HIDE, 'root', { name: 'crownLobe', rigid: true, mountBone: bone }));
  }

  // Brow ridge over the eyes: a bevelled slab, raked forward.
  const brow = prim.bevelSlab({ w: HW * 1.16, h: S * 0.08, d: S * 0.10, bevel: S * 0.02, name: 'brow' });
  prim.place(brow, { pos: [0, base + S * 0.11, headZ - L * 0.10], rot: [-0.30, 0, 0] });
  g.parts.push(P.mkPart(brow, 'leather', HIDE, 'root', { name: 'brow', rigid: true, mountBone: bone }));

  // The face block between the tusks — the trunk grows out of its front.
  const face = prim.loft(
    [
      prim.ring({ rx: HW * 0.50, rz: S * 0.115, y: base + S * 0.06, cz: headZ - L * 0.075, sides: 6, squareness: 0.58 }),
      prim.ring({ rx: HW * 0.44, rz: S * 0.095, y: base - S * 0.02, cz: headZ - L * 0.09, sides: 6, squareness: 0.6 }),
      prim.ring({ rx: HW * 0.33, rz: S * 0.075, y: base - S * 0.075, cz: headZ - L * 0.095, sides: 6, squareness: 0.62 }),
    ],
    { name: 'elephantFace' },
  );
  g.parts.push(P.mkPart(face, 'leather', HIDE, 'root', { name: 'elephantFace', rigid: true, mountBone: bone }));

  // Temple hollows: a cut plane either side, so the head has an undercut and
  // the ear has something to stand off from.
  for (const s of [-1, 1]) {
    const temple = prim.bevelSlab({ w: S * 0.09, h: S * 0.24, d: S * 0.13, bevel: S * 0.025 });
    prim.place(temple, { pos: [s * HW * 0.70, base + S * 0.13, headZ - L * 0.045], rot: [0, s * 0.3, s * 0.16] });
    g.parts.push(P.mkPart(temple, 'leather', HIDE, 'root', { name: 'temple', rigid: true, mountBone: bone }));
  }

  // Eye and the crease above it. Twelve triangles each, and an elephant with no
  // eye reads as a boulder however good the trunk is.
  for (const s of [-1, 1]) {
    const eye = prim.bevelSlab({ w: S * 0.028, h: S * 0.032, d: S * 0.022, bevel: S * 0.008 });
    prim.place(eye, { pos: [s * HW * 0.60, base + S * 0.055, headZ - L * 0.085], rot: [0.15, s * 0.55, s * 0.2] });
    g.parts.push(P.mkPart(eye, 'hair', 'ink', 'root', { name: 'eye', rigid: true, mountBone: bone }));
  }

  // The lower lip below the trunk's root — closes the front of the face so the
  // trunk does not look socketed into a hole.
  const lipBlock = prim.loft(
    [
      prim.ring({ rx: HW * 0.30, rz: S * 0.06, y: base - S * 0.075, cz: headZ - L * 0.095, sides: 6, squareness: 0.6 }),
      prim.ring({ rx: HW * 0.24, rz: S * 0.045, y: base - S * 0.15, cz: headZ - L * 0.085, sides: 6, squareness: 0.6 }),
      prim.ring({ rx: HW * 0.13, rz: S * 0.025, y: base - S * 0.20, cz: headZ - L * 0.065, sides: 6, squareness: 0.6 }),
    ],
    { name: 'elephantLip' },
  );
  g.parts.push(P.mkPart(lipBlock, 'leather', HIDE, 'root', { name: 'elephantLip', rigid: true, mountBone: bone }));
}

/**
 * Ears as plates, not sheets: flat, standing well off the head, with a folded
 * upper margin and a scalloped trailing edge. They are on their own bones so
 * the animator can flap them, and they are the widest thing on the unit.
 */
function buildEars(ctx: UnitBuildContext, d: Dims, g: PartGroup, headZ: number, base: number): void {
  const P = ctx.parts;
  const { S, L, HW } = d;
  for (const s of [-1, 1]) {
    const grid: V3[][] = [];
    const rows = 5;
    const cols = 4;
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);
      const row: V3[] = [];
      for (let c = 0; c < cols; c++) {
        const u = c / (cols - 1);
        // Widest at mid-height; the top margin folds forward, the trailing edge
        // is notched. `flare` is the span from the head outward.
        // Wide at the top corner rather than tapering to it: the ear has to
        // stand ABOVE the animal's back line, so that from the front it puts
        // two hard corners either side of the head instead of blending into
        // one hexagonal blob, and from the side its top edge breaks the
        // otherwise flat topline.
        const flare = 0.55 + Math.sin(Math.min(1, t * 1.05) * Math.PI) * 0.78;
        const fold = r === 0 ? -L * 0.035 * u : 0;
        const scallop = c === cols - 1 ? Math.sin(t * 8.5) * S * 0.03 : 0;
        row.push([
          s * (HW * 0.56 + u * HW * flare),
          base + S * (0.42 - t * 0.78) - u * S * 0.06,
          headZ + L * (u * 0.26) + scallop + t * L * 0.035 + fold,
        ]);
      }
      grid.push(row);
    }
    g.parts.push(
      P.mkPart(P.prim.shell(grid, S * 0.016, { name: 'elephantEar', flip: s > 0 }), 'leather', HIDE, 'root', {
        name: `elephantEar${s < 0 ? 'L' : 'R'}`,
        rigid: true,
        mountBone: s < 0 ? 'elephant.earL' : 'elephant.earR',
      }),
    );
  }
}

/**
 * Tusks. Long, low and forward — the primary silhouette cue, and deliberately
 * larger than a real Asian elephant's, because a realistic tusk disappears at
 * board distance and the whole unit stops being nameable.
 */
function buildTusks(
  ctx: UnitBuildContext,
  d: Dims,
  g: PartGroup,
  headZ: number,
  base: number,
): { left: V3; right: V3 } {
  const P = ctx.parts;
  const { S, L, HW } = d;
  const han = ctx.side === Side.Red;
  const tips: V3[] = [];

  for (const s of [-1, 1]) {
    const stations = [];
    const n = 6;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      // Out of the socket, forward and down, then lifting at the point: the
      // shallow S is what makes it read as ivory rather than as a spike.
      stations.push({
        p: [
          s * HW * (0.30 + t * 0.30),
          base - S * (0.02 + t * 0.30) + t * t * S * 0.26,
          headZ - L * (0.09 + t * 0.40),
        ] as V3,
        rx: S * 0.056 * (1 - t * 0.82) + S * 0.006,
        squareness: 0.35,
      });
    }
    const geo = P.prim.sweep(stations, { sides: 6, name: 'tusk' });
    g.parts.push(
      P.mkPart(geo, 'ivory', BONE, 'root', {
        name: `tusk${s < 0 ? 'L' : 'R'}`,
        rigid: true,
        mountBone: 'elephant.head',
      }),
    );
    tips.push(stations[n - 1].p);

    // The socket the tusk grows out of — a short collar of hide swallowing the
    // root, so the ivory emerges from the face rather than being stuck onto it.
    const root = stations[0].p;
    const socket = P.prim.loft(
      [
        P.prim.ring({ rx: S * 0.085, rz: S * 0.075, y: root[1] + S * 0.055, cx: root[0], cz: root[2] + L * 0.03, sides: 6, squareness: 0.5 }),
        P.prim.ring({ rx: S * 0.075, rz: S * 0.065, y: root[1] - S * 0.005, cx: root[0], cz: root[2], sides: 6, squareness: 0.5 }),
        P.prim.ring({ rx: S * 0.056, rz: S * 0.05, y: root[1] - S * 0.055, cx: root[0] + s * S * 0.008, cz: root[2] - L * 0.02, sides: 6, squareness: 0.5 }),
      ],
      { capStart: false, capEnd: false, name: 'tuskSocket' },
    );
    g.parts.push(
      P.mkPart(socket, 'leather', HIDE, 'root', {
        name: 'tuskSocket',
        rigid: true,
        mountBone: 'elephant.head',
      }),
    );

    if (han) {
      // Han: two gold bands near the socket — ornament, not weaponry.
      for (let i = 0; i < 2; i++) {
        const t = 0.16 + i * 0.16;
        g.parts.push(
          P.trim.ferrule({
            at: [
              s * HW * (0.30 + t * 0.30),
              base - S * (0.02 + t * 0.30) + t * t * S * 0.26,
              headZ - L * (0.09 + t * 0.40),
            ],
            r: S * 0.056 * (1 - t * 0.82) + S * 0.006,
            height: S * 0.032,
            proud: S * 0.008,
            boneHint: 'root',
            mountBone: 'elephant.head',
            pigment: 'metal',
            rot: [1.28, 0, 0],
            sides: 6,
          }),
        );
      }
    } else {
      // Chu: a bladed sheath driven onto the point. Adds a hard spike to the
      // very front of the silhouette, which is where the eye lands first.
      const cap = P.prim.prism({
        rx0: S * 0.022,
        rz0: S * 0.016,
        rx1: S * 0.002,
        rz1: S * 0.002,
        y0: 0,
        y1: S * 0.16,
        sides: 4,
        squareness: 0.45,
        name: 'tuskBlade',
      });
      const tip = stations[n - 1].p;
      const prev = stations[n - 2].p;
      const dir = new THREE.Vector3(tip[0] - prev[0], tip[1] - prev[1], tip[2] - prev[2]).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      cap.applyMatrix4(
        new THREE.Matrix4().compose(
          new THREE.Vector3(tip[0], tip[1], tip[2]).addScaledVector(dir, -S * 0.03),
          q,
          new THREE.Vector3(1, 1, 1),
        ),
      );
      g.parts.push(
        P.mkPart(cap, 'iron', 'metal', 'root', { name: 'tuskBlade', rigid: true, mountBone: 'elephant.head' }),
      );
    }
  }
  return { left: tips[0], right: tips[1] };
}

/**
 * The trunk: ten bones and ten tapered sections, straight down in bind pose.
 *
 * Straight is a decision, not laziness. Skin weights are baked against the bind
 * pose, so a trunk curled at bind time is stiff against any sweep that curls it
 * the other way; a straight chain sweeps equally well in both directions, which
 * is what the attack beat needs. Each section overlaps the next slightly so a
 * hard curl never opens a gap at a joint.
 */
function buildTrunk(
  ctx: UnitBuildContext,
  d: Dims,
  g: PartGroup,
  headZ: number,
  base: number,
): V3 {
  const P = ctx.parts;
  const { S, L } = d;
  const top: V3 = [0, base - S * 0.055, headZ - L * 0.125];
  const len = S * 0.51;
  const segs = TRUNK_SEGMENTS;
  let parent = 'elephant.head';

  // The rest curve. A circular arc of TRUNK_BEND radians total: the trunk drops
  // from between the tusks and swings back under the chin, ending with its
  // tangent about 29 degrees off vertical.
  //
  // The parts library builds its trunk dead straight, on the grounds that a
  // bind-pose curl biases the skin weights against a sweep going the other way.
  // That reasoning does not apply here: every segment is `rigid` on its own
  // bone, so there is no weight blending across a joint to bias — the curl
  // lives entirely in the bones' rest offsets, and a rotation applied to any
  // bone still carries its whole subtree cleanly in either direction. What the
  // curve buys is the silhouette cue the brief names: a straight vertical trunk
  // reads as a post, and it is the *curve* between the tusks that says elephant.
  // It is kept shallow so a rearward sweep is not fighting a deep rest shape.
  const K = TRUNK_BEND / len;
  const at = (s: number): V3 => [
    top[0],
    top[1] - Math.sin(K * s) / K,
    top[2] + (1 - Math.cos(K * s)) / K,
  ];

  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const name = `elephant.trunk${String(i + 1).padStart(2, '0')}`;
    const p0 = at(len * t0);
    const p1 = at(len * t1);
    g.bones.push({ name, parent, position: p0, data: { segment: i, of: segs } });
    parent = name;

    const r0 = S * 0.09 * (1 - t0 * 0.66);
    const r1 = S * 0.09 * (1 - t1 * 0.66);
    const seg = P.prim.sweep(
      [
        { p: p0, rx: r0, rz: r0 * 0.9, squareness: 0.42 },
        // Overlap the next segment by 6% so a curl cannot open a seam.
        {
          p: [p1[0], p1[1] + (p0[1] - p1[1]) * 0.06, p1[2] + (p0[2] - p1[2]) * 0.06],
          rx: r1 * 1.03,
          rz: r1 * 0.93,
          squareness: 0.42,
        },
      ],
      { sides: 7, name },
    );
    g.parts.push(P.mkPart(seg, 'leather', HIDE, 'root', { name, rigid: true, mountBone: name }));
  }

  const tip = at(len);
  // The prehensile finger at the lip — small, but it is the difference between
  // a trunk and a hose, and the animator's `trunkTip` sits on it.
  const lip = P.prim.bevelSlab({
    w: S * 0.036,
    h: S * 0.05,
    d: S * 0.026,
    bevel: S * 0.008,
    name: 'trunkLip',
  });
  P.prim.place(lip, { pos: [tip[0], tip[1] + S * 0.012, tip[2] - S * 0.024], rot: [0.7 + TRUNK_BEND, 0, 0] });
  g.parts.push(
    P.mkPart(lip, 'leather', HIDE, 'root', {
      name: 'trunkLip',
      rigid: true,
      mountBone: `elephant.trunk${String(segs).padStart(2, '0')}`,
    }),
  );
  return tip;
}

// ---------------------------------------------------------------------------
// Han: the 象輿 howdah
// ---------------------------------------------------------------------------

/**
 * A lacquered box on the back with four corner posts, a rail open at the front,
 * a fringed valance over the flanks and a row of hanging tassels along the rail.
 *
 * Deliberately NOT a canopy: a dome or disc above the elephant would collide
 * with the chariot's 傘蓋 in silhouette, and separating those two units matters
 * more than a roof does.
 */
function buildHowdah(ctx: UnitBuildContext, d: Dims, g: PartGroup): void {
  const P = ctx.parts;
  const { prim } = P;
  const { S, L, HW } = d;
  const bone = 'elephant.spine';
  const z = L * 0.10;
  const floorY = backY(d, z) - S * 0.01;
  const hw = HW * 0.82;
  const depth = L * 0.42;
  const postH = S * 0.235;

  const floor = prim.bevelSlab({
    w: hw * 2,
    h: depth,
    d: S * 0.055,
    bevel: S * 0.014,
    name: 'howdahFloor',
  });
  prim.place(floor, { pos: [0, floorY, z], rot: [Math.PI / 2, 0, 0] });
  g.parts.push(P.mkPart(floor, 'lacquer', 'lacquer', 'root', { name: 'howdahFloor', rigid: true, mountBone: bone }));

  // Corner posts and a low rail on three sides — open at the front so the
  // mahout on the neck is not fenced off from the box.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = prim.bevelSlab({
        w: S * 0.038,
        h: postH,
        d: S * 0.038,
        bevel: S * 0.009,
        name: 'howdahPost',
      });
      prim.place(post, { pos: [sx * hw, floorY + postH * 0.5, z + sz * depth * 0.5] });
      g.parts.push(P.mkPart(post, 'lacquer', 'lacquer', 'root', { name: 'howdahPost', rigid: true, mountBone: bone }));
    }
  }
  const railY = floorY + postH * 0.86;
  const rails: [V3, V3][] = [
    [[-hw, railY, z + depth * 0.5], [hw, railY, z + depth * 0.5]],
    [[-hw, railY, z - depth * 0.5], [-hw, railY, z + depth * 0.5]],
    [[hw, railY, z - depth * 0.5], [hw, railY, z + depth * 0.5]],
  ];
  for (const [a, b] of rails) {
    g.parts.push(
      P.trim.piping({
        path: [a, [(a[0] + b[0]) / 2, railY, (a[2] + b[2]) / 2], b],
        r: S * 0.019,
        boneHint: 'root',
        mountBone: bone,
        pigment: 'leather',
        cls: 'timber',
        sides: 5,
        name: 'howdahRail',
      }),
    );
  }

  // Valance over both flanks with a scalloped hem.
  for (const s of [-1, 1]) {
    const grid: V3[][] = [];
    for (let r = 0; r < 3; r++) {
      const t = r / 2;
      const row: V3[] = [];
      for (let c = 0; c < 5; c++) {
        const u = c / 4;
        const zz = z + (u - 0.5) * depth * 0.98;
        const sec = bodyAt(d, zz);
        const scallop = r === 2 ? Math.sin(u * 11) * S * 0.03 : 0;
        row.push([
          s * (hw * (1.0 - t * 0.02) + sec.rx * t * 0.06),
          floorY - t * S * 0.24 + scallop,
          zz,
        ]);
      }
      grid.push(row);
    }
    g.parts.push(
      P.mkPart(prim.shell(grid, S * 0.012, { name: 'valance', flip: s > 0 }), 'cloth', 'cloth', 'root', {
        name: 'howdahValance',
        rigid: true,
        mountBone: bone,
      }),
    );
  }

  // The canopy fringe the brief asks for, read as a line of short tassels hung
  // from the rail rather than as a roof. Instanced and kept under the factory's
  // bake threshold, so it costs triangles and no draw call.
  {
    const strand = prim.prism({
      rx0: S * 0.010,
      rx1: S * 0.004,
      y0: 0,
      y1: -S * 0.055,
      sides: 4,
      squareness: 0.2,
      name: 'fringe',
    });
    const mats: THREE.Matrix4[] = [];
    for (const s of [-1, 1]) {
      for (let i = 0; i < 8; i++) {
        const u = (i + 0.5) / 8;
        mats.push(prim.matrix([s * hw * 1.01, railY - S * 0.012, z + (u - 0.5) * depth * 0.96], [0, 0, s * 0.1]));
      }
    }
    for (let i = 0; i < 5; i++) {
      const u = (i + 0.5) / 5;
      mats.push(prim.matrix([(u - 0.5) * hw * 1.9, railY - S * 0.012, z + depth * 0.51]));
    }
    const fringe: InstancedPart = {
      geometry: strand,
      cls: 'cloth',
      pigment: 'accent',
      boneHint: 'root',
      mountBone: bone,
      rigid: true,
      noSilk: true,
      transforms: mats,
      name: 'howdahFringe',
    };
    g.instanced.push(fringe);
  }

  // 旌 — the Han square standard at the rear corner of the box. Square pennant,
  // straight lower edge, streamer fringe: the Han shape, and the army axis the
  // brief asks for on top of helmet and weapon.
  const std = P.standard.standard({
    shape: 'hanSquare',
    base: [hw * 0.82, floorY + S * 0.02, z + depth * 0.42],
    poleLength: S * 0.34,
    poleR: S * 0.012,
    bannerHeight: S * 0.19,
    bannerWidth: S * 0.23,
    lean: 0.22,
    fly: -0.5,
    boneHint: 'root',
    mountBone: bone,
    clothPigment: 'accent',
    polePigment: 'leather',
    // metalPigment left default: passing it also recolours the pole's cloth
    // knot tassel and opens a (cloth, metal) bucket for one ornament.
    streamerCount: 4,
    phase: ctx.rng.range(0, 6.28),
  });
  g.parts.push(...std.parts);
  g.instanced.push(...std.instanced);
}

// ---------------------------------------------------------------------------
// Chu: the war drum and the headplate
// ---------------------------------------------------------------------------

/**
 * A big barrel drum cradled on the back and tilted back toward the drummer, so
 * its head faces up and rearward. Tilting is what makes it readable: axis-along
 * -X would show the camera a cylinder from the front, and axis-vertical would
 * show a rectangle from the side. Tilted, the head is a broad ellipse from
 * almost anywhere, which is the shape that says *drum*.
 */
function buildDrum(ctx: UnitBuildContext, d: Dims, g: PartGroup): void {
  const P = ctx.parts;
  const { prim } = P;
  const { S, L } = d;
  const bone = 'elephant.spine';
  const z = -L * 0.06;
  // Sized off the height budget, not off taste: the elephant's back is already
  // 0.93 of shoulder height, and everything strapped above it eats the margin
  // the declared 2.76-unit silhouette allows. `cy` is derived from the drum's
  // own vertical half-extent so the shell rests on the cradle rather than
  // sinking through the hide, whatever R, `half` and `tilt` are set to.
  const R = S * 0.175;
  const half = S * 0.155;
  const tilt = 1.05; // radians, rotating +Y back toward the drummer
  const halfExtentY = half * Math.cos(tilt) + R * Math.abs(Math.sin(tilt));
  const cy = backY(d, z) + halfExtentY + S * 0.02;

  const axis = new THREE.Vector3(0, Math.cos(tilt), Math.sin(tilt));
  const centre = new THREE.Vector3(0, cy, z);
  const place = (geo: THREE.BufferGeometry) => {
    geo.applyMatrix4(
      new THREE.Matrix4().compose(
        centre,
        new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, 0, 0, 'XYZ')),
        new THREE.Vector3(1, 1, 1),
      ),
    );
    return geo;
  };

  // Shell: a staved barrel, widest at the waist. Nine facets so each stave
  // catches its own band of the ramp.
  const shellGeo = prim.hardLathe(
    [
      [R * 0.86, -half],
      [R * 0.98, -half * 0.45],
      [R * 1.0, 0],
      [R * 0.98, half * 0.45],
      [R * 0.86, half],
    ],
    9,
    { capStart: false, capEnd: false, name: 'drumShell' },
  );
  g.parts.push(
    P.mkPart(place(shellGeo), 'lacquer', 'lacquer', 'root', { name: 'drumShell', rigid: true, mountBone: bone }),
  );

  // Two rawhide heads, slightly domed, lashed over hoops.
  for (const s of [-1, 1]) {
    const head = prim.hardLathe(
      [
        [R * 0.87, s * half],
        [R * 0.7, s * (half + R * 0.045)],
        [R * 0.36, s * (half + R * 0.07)],
        [0.001, s * (half + R * 0.08)],
      ],
      9,
      { capStart: false, capEnd: false, name: 'drumHead' },
    );
    g.parts.push(
      P.mkPart(place(head), 'ivory', BONE, 'root', { name: 'drumHead', rigid: true, mountBone: bone }),
    );
    const hoop = prim.hardLathe(
      [
        [R * 0.9, s * (half - R * 0.03)],
        [R * 1.02, s * (half - R * 0.01)],
        [R * 1.0, s * (half + R * 0.03)],
        [R * 0.88, s * (half + R * 0.02)],
      ],
      9,
      { capStart: false, capEnd: false, name: 'drumHoop' },
    );
    g.parts.push(
      P.mkPart(place(hoop), 'iron', 'metal', 'root', { name: 'drumHoop', rigid: true, mountBone: bone }),
    );
  }

  // Lacing studs round the near hoop.
  const studs = P.rivets.rivetArc({
    centre: [0, 0, 0],
    rx: R * 0.97,
    rz: R * 0.97,
    count: 12,
    boneHint: 'root',
    pigment: 'metal',
    rivet: { r: R * 0.075, h: R * 0.05 },
    name: 'drumStuds',
  });
  for (const inst of studs.instanced) {
    inst.mountBone = bone;
    for (const m of inst.transforms) {
      m.premultiply(
        new THREE.Matrix4().compose(
          centre,
          new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, 0, 0, 'XYZ')),
          new THREE.Vector3(1, 1, 1),
        ),
      );
      m.premultiply(new THREE.Matrix4().makeTranslation(0, 0, 0));
    }
    // Lift the ring of studs onto the rear head plane.
    for (const m of inst.transforms) {
      m.premultiply(
        new THREE.Matrix4().makeTranslation(
          axis.x * half * 0.98,
          axis.y * half * 0.98,
          axis.z * half * 0.98,
        ),
      );
    }
  }
  g.instanced.push(...studs.instanced);

  // Timber cradle: two A-frames straddling the back, with a lashing over each.
  for (const sz of [-1, 1]) {
    const zz = z + sz * half * 0.72;
    const sec = bodyAt(d, zz);
    for (const sx of [-1, 1]) {
      const leg = prim.strut(
        [sx * sec.rx * 0.7, sec.y + sec.ry * 0.94, zz],
        [sx * R * 0.34, cy - R * 0.55, zz],
        S * 0.026,
        S * 0.018,
        5,
        0.4,
      );
      g.parts.push(
        P.mkPart(leg, 'timber', 'leather', 'root', { name: 'drumCradle', rigid: true, mountBone: bone }),
      );
    }
  }
}

/**
 * Chu's heavy headplate: a riveted lacquer plate over the forehead, and an
 * upright crest standing between the ears. Three blades, tallest in the middle,
 * so the top of the head is a notched comb rather than a dome — the Chu head
 * has to be nameable at the same distance the Han turban is.
 */
function buildHeadplate(
  ctx: UnitBuildContext,
  d: Dims,
  g: PartGroup,
  headZ: number,
  base: number,
  topY: number,
): void {
  const P = ctx.parts;
  const { prim } = P;
  const { S, L, HW } = d;
  const bone = 'elephant.head';

  const plate = prim.shell(
    [
      [
        [-HW * 0.44, topY - S * 0.045, headZ - L * 0.01],
        [0, topY + S * 0.005, headZ - L * 0.02],
        [HW * 0.44, topY - S * 0.045, headZ - L * 0.01],
      ],
      [
        [-HW * 0.66, base + S * 0.22, headZ - L * 0.075],
        [0, base + S * 0.27, headZ - L * 0.095],
        [HW * 0.66, base + S * 0.22, headZ - L * 0.075],
      ],
      [
        [-HW * 0.60, base + S * 0.055, headZ - L * 0.115],
        [0, base + S * 0.08, headZ - L * 0.14],
        [HW * 0.60, base + S * 0.055, headZ - L * 0.115],
      ],
    ],
    S * 0.017,
    { name: 'headplate', flip: true },
  );
  g.parts.push(P.mkPart(plate, 'lacquer', 'lacquer', 'root', { name: 'headplate', rigid: true, mountBone: bone }));

  const studs = P.rivets.rivetArc({
    centre: [0, base + S * 0.20, headZ - L * 0.075],
    rx: HW * 0.6,
    rz: S * 0.16,
    count: 9,
    arc: Math.PI,
    arcCentre: -Math.PI / 2,
    tilt: 0.4,
    boneHint: 'root',
    pigment: 'metal',
    rivet: { r: S * 0.018, h: S * 0.012 },
    name: 'headplateStuds',
  });
  for (const inst of studs.instanced) inst.mountBone = bone;
  g.instanced.push(...studs.instanced);

  // The crest between the ears.
  for (let i = 0; i < 3; i++) {
    const k = i - 1;
    const hgt = S * (0.20 - Math.abs(k) * 0.06);
    const blade = prim.bevelSlab({
      w: S * 0.026,
      h: hgt,
      d: S * 0.085,
      bevel: S * 0.01,
      name: 'headCrest',
    });
    prim.place(blade, {
      pos: [k * HW * 0.20, topY + hgt * 0.42, headZ - L * 0.01 + Math.abs(k) * L * 0.008],
      rot: [0.12, 0, k * 0.12],
    });
    g.parts.push(
      P.mkPart(blade, 'lacquer', 'lacquer', 'root', { name: 'headCrest', rigid: true, mountBone: bone }),
    );
  }
}

// ===========================================================================
// The rider
// ===========================================================================

/**
 * Fold the rider's legs onto whatever he straddles.
 *
 * Same principle as the horse's: the knee goes on the *surface*, offset outward
 * by the thigh's own radius, and the ankle tucks back in below it — so the shin
 * wraps the animal rather than dangling beside it. The Han mahout straddles the
 * neck (narrow, so his knees come well up) and the Chu drummer straddles the
 * back (wide, so his knees splay). One function, two very different poses,
 * because both come out of `bodyAt` at the station each man sits on.
 */
function seatOffsets(
  rig: Rig,
  d: Dims,
  kneeZ: number,
  ankleZ: number,
): NonNullable<RigOptions['offsets']> {
  const m = rig.metrics;
  const B = rig.bindWorld;
  const out: NonNullable<RigOptions['offsets']> = {};

  for (const S of ['L', 'R'] as const) {
    const s = S === 'L' ? -1 : 1;
    const knee = B[`shin${S}`];
    const ankle = B[`foot${S}`];
    const hip = v3(B[`thigh${S}`]);

    // The search starts just off the spine and runs down the flank. On the neck
    // (Han) it settles about halfway down; on the back (Chu) the animal is so
    // much broader than the man's leg is long that it settles high on the
    // shoulder of the barrel, legs splayed — which is what riding an elephant
    // bareback looks like.
    const kneeTarget = fitOnBody(d, kneeZ, hip, m.thighLen, m.thighR * 0.88, s, 1.45, -0.2);
    const ankleTarget = fitOnBody(d, ankleZ, kneeTarget, m.shinLen, m.shinR * 0.88, s, 1.2, -0.6);

    const dKnee: V3 = [kneeTarget[0] - knee.x, kneeTarget[1] - knee.y, kneeTarget[2] - knee.z];
    out[`shin${S}` as BoneName] = dKnee;
    out[`foot${S}` as BoneName] = [
      ankleTarget[0] - ankle.x - dKnee[0],
      ankleTarget[1] - ankle.y - dKnee[1],
      ankleTarget[2] - ankle.z - dKnee[2],
    ];
  }
  return out;
}

/**
 * Pose an arm by *direction* instead of by angle: `upper` runs shoulder to
 * elbow and `fore` elbow to wrist, each normalised and multiplied by the arm's
 * own measured bind length, so a pose can be written as "forward and down"
 * without stretching a bone. The shoulder does not move.
 *
 * Crew figures need this more than line soldiers do. A mahout with his arms in
 * the rig's bind A-pose reads as a post with a turban on it; the same man with
 * the goad held out level over the animal's crown ties his mass to the head's
 * and turns two blobs into one silhouette.
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
  const elbow: V3 = [shoulder.x + u[0] * lenU, shoulder.y + u[1] * lenU, shoulder.z + u[2] * lenU];
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
 * Turn the fist so its bore lines up with what it is holding. `body.hand()`
 * bores a grip cylinder along +Y and every weapon is authored haft-along-+Y at
 * the origin, so the two only interpenetrate while they share an axis; rotating
 * the weapon without rotating the fist sends the haft out through the knuckles.
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

/**
 * 鉤 — the mahout's goad: a short bound haft with an iron hook and a forward
 * spike at the head. Built here rather than borrowed from `weapons.axe`,
 * because a crescent axe head reads as an axe and this has to read as a tool.
 */
function goad(
  ctx: UnitBuildContext,
  grip: V3,
  rot: V3,
  length: number,
  bone: BoneName,
): PartGroup {
  const P = ctx.parts;
  const r = length * 0.028;
  const above = length * 0.66;
  const g = P.mergeGroups(
    P.weapons.haft({
      below: length * 0.34,
      above,
      r,
      rings: 2,
      pigment: 'leather',
      metalPigment: 'metal',
      boneHint: bone,
    }),
  );

  // The hook: a quarter-turn spike curling back and down off the head.
  const hook = P.prim.sweep(
    [
      { p: [0, above - r * 0.6, 0] as V3, rx: r * 0.85, squareness: 0.4 },
      { p: [0, above + r * 1.9, -r * 1.4] as V3, rx: r * 0.7, squareness: 0.4 },
      { p: [0, above + r * 2.1, -r * 4.0] as V3, rx: r * 0.5, squareness: 0.4 },
      { p: [0, above + r * 0.4, -r * 5.4] as V3, rx: r * 0.12, squareness: 0.4 },
    ],
    { sides: 5, name: 'goadHook' },
  );
  g.parts.push(P.mkPart(hook, 'iron', 'metal', bone, { name: 'goadHook', rigid: true }));

  // The forward spike above the hook.
  const spike = P.prim.prism({
    rx0: r * 0.8,
    rx1: r * 0.06,
    y0: above + r * 1.0,
    y1: above + r * 5.2,
    sides: 4,
    squareness: 0.4,
    name: 'goadSpike',
  });
  g.parts.push(P.mkPart(spike, 'iron', 'metal', bone, { name: 'goadSpike', rigid: true }));

  g.points.tip = new THREE.Vector3(0, above + r * 5.2, 0);
  const mm = new THREE.Matrix4().compose(
    new THREE.Vector3(...grip),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ')),
    new THREE.Vector3(1, 1, 1),
  );
  for (const p of g.parts) {
    p.boneHint = bone;
    p.rigid = true;
  }
  return P.transformGroup(g, mm);
}

/** 桴 — the drum mallet: a short shaft and a bound, bulbous head. */
function mallet(ctx: UnitBuildContext, grip: V3, rot: V3, length: number, bone: BoneName): PartGroup {
  const P = ctx.parts;
  const g = P.emptyGroup();
  const r = length * 0.05;
  const shaft = P.prim.prism({
    rx0: r * 1.05,
    rx1: r * 0.82,
    y0: -length * 0.3,
    y1: length * 0.62,
    sides: 6,
    phase: Math.PI / 6,
    squareness: 0.34,
    name: 'malletShaft',
  });
  g.parts.push(P.mkPart(shaft, 'timber', 'leather', bone, { name: 'malletShaft', rigid: true }));
  const head = P.prim.hardLathe(
    [
      [r * 0.9, length * 0.6],
      [r * 2.3, length * 0.7],
      [r * 2.5, length * 0.86],
      [r * 1.6, length * 0.99],
      [r * 0.2, length * 1.03],
    ],
    7,
    { capStart: false, name: 'malletHead' },
  );
  g.parts.push(P.mkPart(head, 'cloth', 'accent', bone, { name: 'malletHead', rigid: true }));
  g.points.tip = new THREE.Vector3(0, length * 1.03, 0);
  const mm = new THREE.Matrix4().compose(
    new THREE.Vector3(...grip),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ')),
    new THREE.Vector3(1, 1, 1),
  );
  return P.transformGroup(g, mm);
}

// ===========================================================================
// Builder
// ===========================================================================

function buildElephant(ctx: UnitBuildContext): PartGroup {
  const P = ctx.parts;
  const han = ctx.side === Side.Red;
  const h = ctx.spec.proportions.height;

  // The elephant is nearly as tall as it is long — that near-square profile is
  // what separates it from the horse and the chariot before any detail is read,
  // so the body is deliberately short for its height.
  const S = h * 1.88;
  const d: Dims = { S, L: h * 1.72, HW: S * 0.31 };

  const beast = buildBeast(ctx, d);
  const g = beast.group;

  // --- seat the rider -----------------------------------------------------
  const origin: [number, number, number] = [0, beast.seat[1] - ctx.rig.metrics.legLen, beast.seat[2]];
  const rig0 = ctx.useRig({ origin });
  // The mahout tucks his knees close behind the ears; the drummer, sitting on
  // a far broader surface, carries his further forward of the seat.
  const offsets = seatOffsets(
    rig0,
    d,
    beast.seatZ - d.L * (han ? 0.055 : 0.10),
    beast.seatZ - d.L * (han ? 0.015 : 0.04),
  );

  // Working poses, and the two armies' crews work at different things.
  // For Chu, `goadRot` is the off-hand mallet's angle: down and forward across
  // the drum head, opposing the raised one.
  const goadRot: V3 = han ? [-1.5, 0, -0.12] : [-1.15, 0, 0.22];
  const malletRot: V3 = [0.75, 0, -0.3];
  if (han) {
    armOffsets(rig0, 'R', [0.42, -0.5, -0.76], [0.05, -0.15, -0.99], offsets);
    armOffsets(rig0, 'L', [-0.42, -0.62, -0.66], [-0.08, -0.42, -0.9], offsets);
  } else {
    armOffsets(rig0, 'R', [0.55, 0.3, 0.42], [0.12, 0.86, 0.5], offsets);
    armOffsets(rig0, 'L', [-0.52, -0.3, -0.6], [-0.16, -0.42, -0.89], offsets);
  }

  const rig = ctx.useRig({
    origin: [0, beast.seat[1] - rig0.metrics.legLen, beast.seat[2]],
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
      bootShaft: 0.12, // he goes nearly barefoot; a mahout is not a cavalryman
      beard: 'short',
      deltoid: true,
      handPose: 'fist',
    }),
  );

  // --- clothing and light armour -----------------------------------------
  // `design.armour` is 0.15: this man is crew, not a line soldier. He gets a
  // three-row half-cuirass and nothing else, and the difference in coverage
  // from the horse's rider is a silhouette separation in its own right.
  g.parts.push(
    P.cloth.skirt({
      topY: m.waistY + m.torsoLen * 0.04,
      hemY: m.hipY - m.legLen * 0.30,
      rTop: m.waistWidth * 0.62,
      rHem: m.hipWidth * 0.9,
      squash: 0.84,
      folds: 8,
      foldDepth: 0.16,
    }),
  );
  merge(
    g,
    P.cloth.sash({
      y: m.waistY,
      rx: m.waistWidth * 0.58,
      rz: m.waistDepth * 0.66,
      height: m.torsoLen * 0.13,
      tail: m.torsoLen * 0.42,
    }),
  );
  merge(
    g,
    P.lamellar.cuirass({
      fromY: m.waistY - m.torsoLen * 0.02,
      toY: m.shoulderY + m.torsoLen * 0.02,
      rx0: m.waistWidth * 0.6,
      rx1: m.chestWidth * 0.6,
      depthRatio: 0.74,
      rows: 3,
      perRow: 13,
      cord: true,
      thickness: 0.1,
    }),
  );
  merge(
    g,
    P.cloth.collar({
      shoulderY: m.shoulderY + m.torsoLen * 0.04,
      chestY: m.chestY - m.torsoLen * 0.1,
      rx: m.chestWidth * 0.55,
      rz: m.chestDepth * 0.6,
    }),
  );

  // --- head ---------------------------------------------------------------
  // Crown tag `turbaned` in both armies. Han leaves the wound cloth as it is;
  // Chu binds a lacquered knot plate over the crown and a longer tail, so the
  // two turbans are different profiles under the same tag.
  const helm = P.helmet.helmet({
    style: 'turban',
    baseY: B.head.y,
    headLen: m.headLen,
    headWidth: m.headWidth,
    headDepth: m.headDepth,
    z: B.head.z,
    clothPigment: 'cloth',
  });
  merge(g, helm);
  if (!han) {
    const knot = P.prim.hardLathe(
      [
        [m.headWidth * 0.3, helm.points.top.y - m.headLen * 0.1],
        [m.headWidth * 0.34, helm.points.top.y],
        [m.headWidth * 0.2, helm.points.top.y + m.headLen * 0.18],
        [m.headWidth * 0.05, helm.points.top.y + m.headLen * 0.26],
      ],
      6,
      { capStart: false, name: 'turbanKnot' },
    );
    knot.translate(0, 0, helm.points.top.z);
    g.parts.push(
      P.mkPart(knot, 'lacquer', 'lacquer', 'head', { name: 'turbanKnot', rigid: true }),
    );
  }

  // --- what he carries ----------------------------------------------------
  // Align each fist to its haft before reading the grip point back out.
  rotateHand(g, 'R', B.handR, han ? goadRot : malletRot);
  rotateHand(g, 'L', B.handL, han ? [0, 0, 0] : goadRot);
  const gripR = g.points.gripR ?? B.handR;
  const gripL = g.points.gripL ?? B.handL;
  let tip: THREE.Vector3;

  if (han) {
    // The mahout drives with the goad held forward and down over the animal's
    // crown — the working pose, which also puts a diagonal across the gap
    // between his body and the head and ties the two masses together.
    const gd = goad(ctx, v3(gripR), goadRot, h * 0.72, 'handR');
    merge(g, gd);
    tip = gd.points.tip;
    // Left hand rests on the neck rope.
    g.parts.push(
      P.trim.piping({
        path: [
          [gripL.x, gripL.y, gripL.z],
          [gripL.x * 0.4, gripL.y - m.height * 0.1, gripL.z - d.L * 0.06],
          [0, bodyAt(d, beast.seatZ - d.L * 0.1).y + bodyAt(d, beast.seatZ - d.L * 0.1).ry, beast.seatZ - d.L * 0.1],
        ],
        r: m.height * 0.011,
        boneHint: 'handL',
        pigment: 'accent',
        cls: 'leather',
        sides: 4,
        name: 'neckRope',
      }),
    );
  } else {
    // The drummer, caught between beats: one mallet up and back over his
    // shoulder, the other down across the drum head. Two mallets rather than a
    // mallet and a goad — a goad long enough to reach this elephant's crown
    // from a seat behind the drum would be a pike, and a short one reads as a
    // stick pointing at nothing.
    const ml = mallet(ctx, v3(gripR), malletRot, h * 0.5, 'handR');
    merge(g, ml);
    tip = ml.points.tip;
    merge(g, mallet(ctx, v3(gripL), goadRot, h * 0.46, 'handL'));
  }
  g.attach.push({ name: 'haftTip', bone: 'handR', position: [tip.x, tip.y, tip.z] });

  return g;
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

void (null as unknown as Part);

registerUnit(PieceType.Elephant, buildElephant);
