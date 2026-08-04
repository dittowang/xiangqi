/**
 * 仕 / 士 — the palace advisor.
 *
 * THE PAIR THAT GETS CONFUSED
 * ---------------------------
 * The advisor and the conscript are the two units a reader most often mixes up:
 * both are foot figures, both are narrow, both stand about a square tall. So
 * they are built as deliberate opposites, on every axis at once:
 *
 *                    soldier                     advisor
 *   outline          narrow column               wide-shouldered trapezoid,
 *                                                narrow at the hem
 *   dominant stroke  a diagonal haft             a vertical crown over a level
 *                                                blade — two horizontals
 *   top of the head  low — a cone or a wrap      tall — a cap or a winged crown
 *   waist to hem     armour plates, hard edges   one straight fall of cloth
 *
 * He is a court official, not a soldier: no lamellar anywhere on him. The
 * SLEEVES carry the silhouette — carried clear of the body on both sides so the
 * widest point of the figure is at the shoulder line — and above them a crown
 * that is the tallest headgear in the cast bar the general's.
 *
 * That is worth stating plainly, because it is the axis this unit is graded on.
 * `proportions.ts` contracts a taper of 0.78: silhouette width at a quarter of
 * the height must be about three quarters of the width at three quarters of it.
 * The general is contracted at 1.90 — the exact inverse. An advisor whose robe
 * flares to a wide hem is a general at 55% scale, and a player has no reference
 * for scale, so the two become the same piece. Everything below the sash is
 * therefore kept narrow and everything at the shoulder is thrown wide.
 *
 * TWO COURTS, NOT ONE COURT IN TWO COLOURS
 * ----------------------------------------
 *   Han 仕: a tall lacquered 官帽 with a stiff horizontal bar across it — a T
 *           against the sky — a straight court robe with its hem turned back on
 *           itself in one hard fold, and a short 劍 held LEVEL in both hands and
 *           presented forward of the chest, which puts a second horizontal
 *           directly under the first. A jade 璧 hangs at the sash.
 *   Chu 士: a taller crown that flares as it rises and throws two upswept wings
 *           past the top of it — a V — a robe cut into a swallow-tail hem that
 *           forks behind the calves, and a ritual 鉞 held vertically like a
 *           staff of office.
 *
 * A T and a V, a straight hem and a forked one, a level blade and a vertical
 * shaft. None of that is pigment, so all of it survives the silhouette pass.
 *
 * THE HEM STOPS AT THE CALF, AND THAT IS NOT A LICENCE TO SHORTEN THE ROBE
 * -----------------------------------------------------------------------
 * A robe whose hem reaches the base disc is a bollard: the figure's outline is
 * the same width at the floor as at the shoulders and there is nothing at the
 * bottom for the eye to stand it on. Han court figures are not painted that way
 * either — the 直裾 hem clears the boot, and the boot and the white 絝 above it
 * are part of the costume, not something hidden by it. So the robe still runs
 * collar to below the knee (it is a robe, not a tunic) and the last sixth of the
 * figure is leg: pale silk trouser, then a lacquered boot.
 *
 * WHAT IS NOT BUILT
 * -----------------
 * There is no torso and there are no thighs under the robe. The robe bodice runs
 * shoulder to waist and the skirt waist to hem, both closed solids, so a torso
 * inside them would be geometry nothing can ever see — 600 triangles of it, on
 * four figures. Only what shows is built: forearms out of the cuffs, hands,
 * head, and the shins and boots under the hem.
 */

import * as THREE from 'three';
import type { BoneName } from '@core/contracts.ts';
import { PieceType, Side } from '@core/types.ts';
import { registerUnit, type UnitBuildContext } from '@characters/factory.ts';
import type { Part, PartGroup, V3 } from '@characters/parts/types.ts';
import type { RigMetrics } from '@characters/rig.ts';
import type { Rng } from '@core/rng.ts';

type Lib = UnitBuildContext['parts'];

const v3 = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];
const UP = new THREE.Vector3(0, 1, 0);

/** Rig units of daylight kept under a haft butt, so it never spears the board. */
const BUTT_CLEARANCE = 0.05;

// ---------------------------------------------------------------------------
// Aiming
// ---------------------------------------------------------------------------

interface Aim {
  /** Rotation taking the authored +Y axis onto the wanted direction. */
  quat: THREE.Quaternion;
  /** The same rotation as the XYZ Euler the weapon builders take. */
  euler: V3;
}

/**
 * Every weapon in the parts library is authored haft-along-+Y with its grip at
 * the origin, and `body.hand()` bores its grip along +Y too. So both the weapon
 * and the fist that holds it want the same rotation, and the honest way to get
 * it is to name the direction the weapon should point and derive the Euler —
 * rather than hand-tuning three angles and discovering at render time that the
 * blade comes out of the wrist sideways.
 */
function aim(dir: THREE.Vector3, roll = 0): Aim {
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
  if (roll !== 0) q.multiply(new THREE.Quaternion().setFromAxisAngle(UP, roll));
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return { quat: q, euler: [e.x, e.y, e.z] };
}

/** Wrist position that puts an aimed fist's bore centre exactly on `grip`. */
function wristFor(grip: THREE.Vector3, a: Aim, m: RigMetrics): THREE.Vector3 {
  return grip.clone().sub(boreOffset(a, m));
}

/** The inverse: where the bore of a fist at `wrist` actually ends up. */
function gripOf(wrist: THREE.Vector3, a: Aim, m: RigMetrics): THREE.Vector3 {
  return wrist.clone().add(boreOffset(a, m));
}

function boreOffset(a: Aim, m: RigMetrics): THREE.Vector3 {
  return new THREE.Vector3(0, -m.handLen * 0.5, -m.handR * 0.55).applyQuaternion(a.quat);
}

// ---------------------------------------------------------------------------
// Posing
// ---------------------------------------------------------------------------

/** Elbow of a two-link chain reaching `wrist` without stretching either link. */
function elbowFor(
  shoulder: THREE.Vector3,
  wrist: THREE.Vector3,
  a: number,
  b: number,
  pole: THREE.Vector3,
): THREE.Vector3 {
  const axis = wrist.clone().sub(shoulder);
  const len = Math.min(Math.max(axis.length(), Math.abs(a - b) + 1e-3), a + b - 1e-3);
  axis.normalize();
  const along = (len * len + a * a - b * b) / (2 * len);
  const h = Math.sqrt(Math.max(0, a * a - along * along));
  const side = pole.clone().addScaledVector(axis, -pole.dot(axis));
  if (side.lengthSq() < 1e-9) side.set(0, 0, 1);
  side.normalize();
  return shoulder.clone().addScaledVector(axis, along).addScaledVector(side, h);
}

/**
 * Bind-pose offsets that put a wrist where the costume needs it. Offsets move a
 * bone *and its subtree*, so the hand's delta rides on top of the forearm's.
 * The wrist is pulled back inside the arm's reach first: a target a centimetre
 * too far would silently lengthen the forearm for every clip that plays on this
 * figure.
 */
function poseArm(
  bind: Record<BoneName, THREE.Vector3>,
  m: RigMetrics,
  side: 'L' | 'R',
  wrist: THREE.Vector3,
  pole: V3,
  out: Partial<Record<BoneName, V3>>,
): THREE.Vector3 {
  const shoulder = bind[`upperArm${side}` as BoneName];
  const reach = (m.upperArmLen + m.foreArmLen) * 0.97;
  const target = wrist.clone();
  const d = target.clone().sub(shoulder);
  if (d.length() > reach) target.copy(shoulder).addScaledVector(d.normalize(), reach);

  const elbow = elbowFor(
    shoulder,
    target,
    m.upperArmLen,
    m.foreArmLen,
    new THREE.Vector3(...pole),
  );
  const e0 = bind[`foreArm${side}` as BoneName];
  const w0 = bind[`hand${side}` as BoneName];
  const dE: V3 = [elbow.x - e0.x, elbow.y - e0.y, elbow.z - e0.z];
  out[`foreArm${side}` as BoneName] = dE;
  out[`hand${side}` as BoneName] = [
    target.x - w0.x - dE[0],
    target.y - w0.y - dE[1],
    target.z - w0.z - dE[2],
  ];
  return target;
}

/** A hand whose bore is aligned with whatever it holds. */
function posedHand(
  P: Lib,
  side: 'L' | 'R',
  wrist: THREE.Vector3,
  a: Aim,
  m: RigMetrics,
  pose: 'fist' | 'flat',
  bore: number,
): PartGroup {
  const g = P.body.hand({
    side,
    wrist: v3(wrist),
    length: m.handLen,
    r: m.handR,
    pose,
    gripR: bore,
  });
  const M = new THREE.Matrix4()
    .makeTranslation(wrist.x, wrist.y, wrist.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(a.quat))
    .multiply(new THREE.Matrix4().makeTranslation(-wrist.x, -wrist.y, -wrist.z));
  return P.transformGroup(g, M);
}

/**
 * Put every metal surface on one material class, and every haft on the leather
 * one. `gold`, `iron` and `timber` are three materials, therefore six draw
 * calls with the outline pass, for a sword's furniture and an axe's shaft. A
 * court official's fittings are gilt and his ritual haft is bound and
 * lacquered, so both collapse into buckets the figure already pays for.
 */
function courtFinish(g: PartGroup): PartGroup {
  for (const p of [...g.parts, ...g.instanced]) {
    if (p.cls === 'iron') p.cls = 'gold';
    if (p.cls === 'gold' && p.pigment === 'accent') p.pigment = 'metal';
    if (p.cls === 'timber') {
      p.cls = 'leather';
      p.pigment = 'leather';
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Headgear
// ---------------------------------------------------------------------------

/**
 * The Han 官帽: a lacquered cap on a wrapped 幘 base, rising and raked back,
 * crossed near the top by a stiff horizontal bar that overhangs both sides.
 *
 * The bar is the whole design. A tall cap alone is a blob at silhouette size;
 * a tall cap with one hard horizontal stroke through it is a T, and a T is not
 * a cone, not a wrap, not a pair of wings and not a crown of beads.
 */
function hanCap(P: Lib, m: RigMetrics, headZ: number, headBaseY: number, rise: number): PartGroup {
  const g = P.emptyGroup();
  const L = m.headLen;
  const R = Math.max(m.headWidth, m.headDepth) * 0.56;
  const base = headBaseY + L * 0.42;

  // 幘 — the wrapped under-cap the 冠 is pinned to. One band, hard-edged, and
  // deliberately tight to the skull: every millimetre it adds to the head's
  // width is a millimetre off the bar's overhang.
  const wrap = P.prim.loft(
    [
      P.prim.ring({ rx: R * 1.0, rz: R * 0.98, y: base - L * 0.16, cz: headZ, sides: 8, phase: Math.PI / 8, squareness: 0.46 }),
      P.prim.ring({ rx: R * 1.04, rz: R * 1.02, y: base - L * 0.04, cz: headZ, sides: 8, phase: Math.PI / 8, squareness: 0.48 }),
      P.prim.ring({ rx: R * 0.96, rz: R * 0.94, y: base + L * 0.06, cz: headZ, sides: 8, phase: Math.PI / 8, squareness: 0.5 }),
    ],
    { capStart: false, capEnd: false, name: 'capWrap' },
  );
  g.parts.push(P.mkPart(wrap, 'cloth', 'cloth', 'head', { name: 'capWrap', rigid: true }));

  // The 冠 body: a squared box, much narrower than the head, raked back as it
  // rises. Narrow on purpose — it is the upright of the T.
  const top = base + L * rise;
  const body = P.prim.loft(
    [
      P.prim.ring({ rx: R * 0.6, rz: R * 0.74, y: base, cz: headZ + R * 0.06, sides: 8, phase: Math.PI / 8, squareness: 0.72 }),
      P.prim.ring({ rx: R * 0.54, rz: R * 0.66, y: base + L * rise * 0.55, cz: headZ + R * 0.18, sides: 8, phase: Math.PI / 8, squareness: 0.78 }),
      P.prim.ring({ rx: R * 0.5, rz: R * 0.56, y: top, cz: headZ + R * 0.3, sides: 8, phase: Math.PI / 8, squareness: 0.8 }),
    ],
    { capStart: false, capEnd: true, name: 'capBody' },
  );
  g.parts.push(P.mkPart(body, 'lacquer', 'lacquer', 'head', { name: 'capBody', rigid: true }));

  // 展筒 — the stiff bar. Half again as wide as the head and only just thick
  // enough to catch its own band of the ramp. This one horizontal is the whole
  // reason the Han advisor cannot be mistaken for anything else on the board.
  const bar = P.prim.bevelSlab({
    w: R * 3.9,
    h: L * 0.15,
    d: R * 0.6,
    bevel: L * 0.03,
    name: 'capBar',
  });
  P.prim.place(bar, { pos: [0, top - L * 0.08, headZ + R * 0.22], rot: [0.12, 0, 0] });
  g.parts.push(P.mkPart(bar, 'lacquer', 'lacquer', 'head', { name: 'capBar', rigid: true }));

  // Gilt caps on the bar ends: two hard points at the extremes of the widest
  // horizontal in the whole figure, which is where the eye lands first.
  for (const s of [-1, 1]) {
    const cap = P.prim.prism({
      rx0: L * 0.075,
      rz0: R * 0.3,
      rx1: L * 0.05,
      rz1: R * 0.22,
      y0: 0,
      y1: L * 0.16,
      sides: 6,
      phase: Math.PI / 6,
      squareness: 0.5,
    });
    P.prim.place(cap, { pos: [s * R * 1.92, top - L * 0.16, headZ + R * 0.22], rot: [0.12, 0, 0] });
    g.parts.push(P.mkPart(cap, 'gold', 'metal', 'head', { name: 'capBarEnd', rigid: true }));
  }

  // The rear projection of a 進賢冠: a plate sloping back and down off the cap,
  // which is what stops the profile reading as a plain block on a head.
  const lobe: V3[][] = [];
  for (let r = 0; r < 3; r++) {
    const t = r / 2;
    const y = top - L * (0.02 + t * 0.5);
    const z = headZ + R * (0.34 + t * 0.66);
    const hw = R * (0.46 - t * 0.12);
    lobe.push([
      [-hw, y, z],
      [0, y + L * 0.03 * (1 - t), z],
      [hw, y, z],
    ]);
  }
  g.parts.push(
    P.mkPart(P.prim.shell(lobe, R * 0.07, { name: 'capLobe' }), 'lacquer', 'lacquer', 'head', {
      name: 'capLobe',
      rigid: true,
    }),
  );

  // Chin ties, hanging from under the wrap past the jaw.
  for (const s of [-1, 1]) {
    const grid: V3[][] = [];
    for (let r = 0; r < 3; r++) {
      const t = r / 2;
      grid.push([
        [s * R * (1.0 - t * 0.18) - L * 0.03, base - L * (0.1 + t * 0.62), headZ + R * (0.1 + t * 0.24)],
        [s * R * (1.0 - t * 0.18) + L * 0.03, base - L * (0.1 + t * 0.62), headZ + R * (0.1 + t * 0.24)],
      ]);
    }
    g.parts.push(
      P.mkPart(P.prim.shell(grid, R * 0.03, { name: 'capTie', flip: s < 0 }), 'cloth', 'accent', 'head', {
        name: 'capTie',
        rigid: true,
      }),
    );
  }

  g.points.crest = new THREE.Vector3(0, top + L * 0.06, headZ + R * 0.3);
  return g;
}

/**
 * The Chu crown: a tall flared 高冠 with two upswept wings.
 *
 * The flare matters as much as the height — the crown gets *wider* as it rises,
 * which no other headgear in the cast does, so even without the wings the
 * outline above the shoulders is a wedge standing on its point. The wings then
 * carry two hard diagonals past the top of it.
 */
function chuCrown(P: Lib, m: RigMetrics, headZ: number, headBaseY: number, rise: number, spread: number): PartGroup {
  const g = P.emptyGroup();
  const L = m.headLen;
  const R = Math.max(m.headWidth, m.headDepth) * 0.56;
  const base = headBaseY + L * 0.36;
  const top = base + L * rise;

  const band = P.prim.loft(
    [
      P.prim.ring({ rx: R * 1.06, rz: R * 1.04, y: base - L * 0.14, cz: headZ, sides: 8, phase: Math.PI / 8, squareness: 0.44 }),
      P.prim.ring({ rx: R * 1.1, rz: R * 1.08, y: base - L * 0.02, cz: headZ, sides: 8, phase: Math.PI / 8, squareness: 0.46 }),
      P.prim.ring({ rx: R * 1.0, rz: R * 0.98, y: base + L * 0.08, cz: headZ, sides: 8, phase: Math.PI / 8, squareness: 0.48 }),
    ],
    { capStart: false, capEnd: false, name: 'crownBand' },
  );
  g.parts.push(P.mkPart(band, 'cloth', 'cloth', 'head', { name: 'crownBand', rigid: true }));

  // Waisted then flared: in at the throat of the crown, out again at the lip.
  const body = P.prim.loft(
    [
      P.prim.ring({ rx: R * 0.78, rz: R * 0.82, y: base, cz: headZ, sides: 8, phase: Math.PI / 8, squareness: 0.6 }),
      P.prim.ring({ rx: R * 0.62, rz: R * 0.66, y: base + L * rise * 0.42, cz: headZ + R * 0.06, sides: 8, phase: Math.PI / 8, squareness: 0.64 }),
      P.prim.ring({ rx: R * 0.78, rz: R * 0.8, y: base + L * rise * 0.82, cz: headZ + R * 0.1, sides: 8, phase: Math.PI / 8, squareness: 0.66 }),
      P.prim.ring({ rx: R * 0.94, rz: R * 0.9, y: top, cz: headZ + R * 0.12, sides: 8, phase: Math.PI / 8, squareness: 0.68 }),
    ],
    { capStart: false, capEnd: true, name: 'crownBody' },
  );
  g.parts.push(P.mkPart(body, 'lacquer', 'lacquer', 'head', { name: 'crownBody', rigid: true }));

  // The wings: flat blades sweeping up, out and back from the crown's throat.
  // They have to clear the crown by a wide margin — a wing that stays inside
  // the crown's own outline is a detail, not a silhouette, and this pair is
  // carrying the Chu advisor's identity.
  for (const s of [-1, 1]) {
    const grid: V3[][] = [];
    const rows = 4;
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);
      // UP first, out second. A wing that travels as far sideways as it does
      // upward is a horizontal bar with a kink in it — which is the Han
      // advisor's silhouette, and the one shape this crown must not make.
      const x = s * R * (0.5 + t * spread);
      const y = base + L * rise * (0.25 + t * 1.5);
      const z = headZ + R * (0.1 + t * t * 0.55);
      const w = L * (0.12 - t * 0.09);
      grid.push([
        [x, y - w, z],
        [x, y + w, z],
      ]);
    }
    g.parts.push(
      P.mkPart(P.prim.shell(grid, R * 0.055, { name: 'crownWing', flip: s < 0 }), 'lacquer', 'lacquer', 'head', {
        name: 'crownWing',
        rigid: true,
      }),
    );
  }

  // A pale bone ferrule where the wings socket into the band — the one light
  // value on an otherwise dark head, and it sits exactly at the fork.
  for (const s of [-1, 1]) {
    g.parts.push(
      P.trim.ferrule({
        at: [s * R * 0.52, base + L * rise * 0.28, headZ + R * 0.08],
        r: L * 0.075,
        height: L * 0.09,
        proud: L * 0.012,
        boneHint: 'head',
        pigment: 'shellWhite',
        rot: [0, 0, s * 0.4],
        sides: 6,
      }),
    );
  }
  for (const p of g.parts) if (p.name === 'ferrule') p.cls = 'ivory';

  // 纓 — the cord and tassel knotted at the back of the band. The animator has
  // a `crest` socket on this head; this is the thing that should swing on it.
  const knot = P.trim.tassel({
    at: [0, base + L * 0.02, headZ + R * 1.02],
    length: L * 0.66,
    r: L * 0.13,
    strands: 7,
    boneHint: 'head',
    pigment: 'accent',
  });
  g.parts.push(...knot.parts);
  g.instanced.push(...knot.instanced);

  g.points.crest = new THREE.Vector3(0, top + L * 0.04, headZ + R * 0.12);
  return g;
}

// ---------------------------------------------------------------------------
// Robe
// ---------------------------------------------------------------------------

interface SkirtOpts {
  topY: number;
  hemY: number;
  rTop: number;
  rHem: number;
  folds: number;
  squash: number;
  /** How far the two rear points hang below the rest of the hem. 0 = straight. */
  tail: number;
  pigment: 'cloth';
}

/**
 * The robe skirt, with a hem line that is a function of angle rather than a
 * constant.
 *
 * `cloth.skirt` gives a level hem, which is right for a tunic and wrong for a
 * Chu court robe: the 燕尾 cut falls into two long points behind the heels with
 * a notch between them. That is authored here by dropping each hem vertex by
 * `tail · backness · split`, where `split` peaks at the two rear quarters and
 * dies at dead centre-back — so the hem forks instead of sagging.
 */
function robeSkirt(P: Lib, o: SkirtOpts): Part {
  const rows = 7;
  const rings: V3[][] = [];
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    // Flare accelerates toward the hem: a straight cone reads as a lampshade.
    const flare = t * t * 0.72 + t * 0.28;
    const r = o.rTop + (o.rHem - o.rTop) * flare;
    const y = o.topY + (o.hemY - o.topY) * t;
    const base = P.cloth.pleatedRing(o.folds, r, r * (1 - 0.2 * t * t), y, {
      squash: o.squash,
      phase: t * 0.14,
    });
    rings.push(
      base.map((p) => {
        if (o.tail <= 0) return p;
        const a = Math.atan2(p[2], p[0]); // +Z is behind the figure
        const back = Math.max(0, Math.sin(a));
        const split = 0.28 + 0.72 * Math.abs(Math.sin(2 * a));
        return [p[0], p[1] - o.tail * back * split * t * t, p[2]] as V3;
      }),
    );
  }
  return P.mkPart(
    P.prim.loft(rings, { capStart: false, capEnd: true, name: 'robeSkirt' }),
    'cloth',
    o.pigment,
    'pelvis',
    { name: 'robeSkirt', allow: ['thighL', 'thighR', 'spine01'] },
  );
}

/**
 * The Han hem: turned back on itself once, hard. One extra ring stepping out
 * and one stepping back up gives a horizontal band of a different value all the
 * way round the bottom of the figure — the detail that says *tailored* rather
 * than *draped*, and the counterpart to the Chu fork.
 */
function hemFold(P: Lib, m: RigMetrics, hemY: number, rHem: number, folds: number, squash: number): Part {
  const step = m.height * 0.026;
  const rings = [
    P.cloth.pleatedRing(folds, rHem * 1.0, rHem * 0.94, hemY + step * 1.6, { squash }),
    P.cloth.pleatedRing(folds, rHem * 1.1, rHem * 1.03, hemY + step * 0.5, { squash }),
    P.cloth.pleatedRing(folds, rHem * 1.09, rHem * 1.02, hemY, { squash }),
    P.cloth.pleatedRing(folds, rHem * 1.0, rHem * 0.95, hemY + step * 0.55, { squash }),
  ];
  return P.mkPart(
    P.prim.loft(rings, { capStart: false, capEnd: false, name: 'hemFold' }),
    'cloth',
    'cloth',
    'pelvis',
    { name: 'hemFold', allow: ['thighL', 'thighR'] },
  );
}

/**
 * The hanging half of a court sleeve.
 *
 * `cloth.sleeve` wraps the arm; it cannot know that the cloth below the forearm
 * keeps going. This is that cloth: a curtain hung along the underside of the
 * forearm, falling and bellying outward as it goes.
 *
 * "Outward" is the forearm's own horizontal normal, not a fixed +Z. That
 * distinction is the whole function: with an arm hanging at the side the two
 * directions coincide, but with the arms carried out in front — which is how the
 * Han 仕 holds his 劍 — they are ninety degrees apart, and a drape that always
 * sweeps backward stops being cloth hanging off an arm and becomes a slab
 * standing on edge beside the figure. The middle of the curtain bellies further
 * than its ends, so the section is an arc rather than a plane and the ramp puts
 * two bands across it instead of one flat value.
 */
function sleeveDrape(
  P: Lib,
  side: 'L' | 'R',
  elbow: THREE.Vector3,
  wrist: THREE.Vector3,
  width: number,
  drop: number,
): Part {
  const rows = 4;
  const cols = 4;
  const grid: V3[][] = [];
  const s = side === 'L' ? -1 : 1;

  const axis = new THREE.Vector3(wrist.x - elbow.x, 0, wrist.z - elbow.z);
  if (axis.lengthSq() < 1e-6) axis.set(0, 0, -1);
  axis.normalize();
  const out = new THREE.Vector3(-axis.z, 0, axis.x);
  // Whichever of the two normals leaves the body on this side.
  if (out.x * s < 0) out.negate();

  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const row: V3[] = [];
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      // Columns run elbow → cuff along the top edge; rows fall with `t`.
      const along = elbow.clone().lerp(wrist, 0.12 + u * 0.88);
      const w = width * (0.62 + t * 0.86);
      const belly = w * (0.1 + t * 0.46) * (1 - Math.abs(u - 0.5) * 0.8);
      row.push([
        along.x + out.x * belly,
        along.y - drop * (t * 0.72 + t * t * 0.28),
        along.z + out.z * belly,
      ]);
    }
    grid.push(row);
  }
  return P.mkPart(
    P.prim.shell(grid, width * 0.07, { name: `drape${side}`, flip: side === 'L' }),
    'cloth',
    'cloth',
    `foreArm${side}` as BoneName,
    { name: `sleeveDrape${side}`, allow: [`upperArm${side}` as BoneName] },
  );
}

/**
 * 蔽膝 — the knee-cover panel hanging down the front of a court robe.
 *
 * It follows the skirt's own elliptical section and stands a little proud of
 * it, so it catches a different band of the ramp all the way down: one hard
 * vertical stripe on what is otherwise the largest unbroken cloth surface in
 * the cast. `point` pulls the bottom edge down at the centre, which is the Chu
 * cut; the Han panel ends square.
 */
function apron(
  P: Lib,
  o: {
    topY: number;
    botY: number;
    rTop: number;
    rBot: number;
    squash: number;
    halfWidth: number;
    point: number;
  },
): Part {
  const rows = 5;
  const cols = 4;
  const grid: V3[][] = [];
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const rr = o.rTop + (o.rBot - o.rTop) * (t * t * 0.72 + t * 0.28);
    const hw = Math.min(o.halfWidth * (0.86 + t * 0.4), rr * 0.86);
    const row: V3[] = [];
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      const x = (u - 0.5) * 2 * hw;
      // Ride the skirt's ellipse rather than a flat plane, or the panel's edges
      // sink into the cloth while its centre floats.
      const z = -rr * o.squash * Math.sqrt(Math.max(0, 1 - (x / rr) * (x / rr))) * 1.04;
      const dip = o.point * (1 - Math.abs(u - 0.5) * 2) * t;
      row.push([x, o.topY + (o.botY - o.topY) * t - dip, z]);
    }
    grid.push(row);
  }
  return P.mkPart(
    P.prim.shell(grid, Math.abs(o.rTop) * 0.045, { name: 'apron' }),
    'cloth',
    'accent',
    'pelvis',
    { name: 'apron', allow: ['spine01', 'thighL', 'thighR'] },
  );
}

/**
 * A cuff band at the mouth of a sleeve: two rings swept along the forearm. The
 * cuff is where a court sleeve's silhouette ends, and an unbanded one reads as
 * a bag rather than a garment.
 */
function cuffBand(P: Lib, side: 'L' | 'R', elbow: THREE.Vector3, wrist: THREE.Vector3, r: number): Part {
  const at = elbow.clone().lerp(wrist, 0.78);
  const along = wrist.clone().sub(elbow).normalize().multiplyScalar(r * 0.34);
  return P.mkPart(
    P.prim.sweep(
      [
        { p: v3(at.clone().sub(along)), rx: r * 1.02, squareness: 0.35 },
        { p: v3(at.clone().add(along)), rx: r * 1.06, squareness: 0.35 },
      ],
      { sides: 8, name: `cuff${side}` },
    ),
    'cloth',
    'accent',
    `foreArm${side}` as BoneName,
    { name: `cuff${side}` },
  );
}

/**
 * 玉璧 — the jade disc at the sash, on its cord. Pale stone against a lacquered
 * figure: the only high-key value below the collar, and the reason the advisor
 * has an `ivory` bucket at all.
 */
function jadePendant(P: Lib, at: V3, r: number): PartGroup {
  const g = P.emptyGroup();
  const section: [number, number][] = [];
  const sec = 4;
  for (let i = 0; i <= sec; i++) {
    const a = (i / sec) * Math.PI * 2;
    section.push([r + Math.cos(a) * r * 0.34, Math.sin(a) * r * 0.2]);
  }
  const disc = P.prim.hardLathe(section, 9, { capStart: false, capEnd: false, name: 'jadeDisc' });
  P.prim.place(disc, { pos: at, rot: [Math.PI / 2, 0, 0.2] });
  g.parts.push(P.mkPart(disc, 'ivory', 'shellWhite', 'pelvis', { name: 'jadeDisc', rigid: true }));

  g.parts.push(
    P.trim.piping({
      path: [
        [at[0] - r * 0.2, at[1] + r * 2.4, at[2] + r * 0.1],
        [at[0] + r * 0.1, at[1] + r * 1.2, at[2] - r * 0.05],
        [at[0], at[1] + r * 0.2, at[2]],
      ],
      r: r * 0.12,
      boneHint: 'pelvis',
      pigment: 'accent',
      cls: 'cloth',
      name: 'jadeCord',
    }),
  );
  return g;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

function buildAdvisor(ctx: UnitBuildContext): PartGroup {
  const P = ctx.parts;
  const rng: Rng = ctx.rng;
  const han = ctx.side === Side.Red;
  const m = ctx.rig.metrics;
  const g = P.emptyGroup();

  // --- per-variant knobs --------------------------------------------------
  // Two of these stand either side of a general, close together, so they need
  // to differ from each other as well as from the other army.
  const beard: 'short' | 'long' = ctx.variant % 2 === 0 ? 'short' : 'long';
  const capRise = (han ? 0.62 : 0.94) * (1 + rng.range(-0.05, 0.05));
  const wingSpread = 1.35 + rng.range(-0.12, 0.12);
  const folds = 12 + (ctx.variant % 2);

  // --- the weapon, and the hands that hold it -----------------------------
  // Han 奉劍: the 劍 held level in BOTH hands and presented forward of the chest,
  // hilt at the right, point past the left shoulder. Chu: 鉞 vertical at the
  // right side, butt just clear of the board.
  //
  // The Han carry is what makes this unit an inverted trapezoid instead of a
  // small general. Two hands out in front at chest height throw both elbows wide
  // — and a court sleeve hangs from the elbow, so the widest point of the whole
  // figure lands at the shoulder line and nothing below the sash comes near it.
  // The old low parrying guard did the exact opposite: it put the point and the
  // guard down beside the knee, which is where the general's cloak hem is, and
  // the two silhouettes measured 4% apart. It is also the second horizontal on
  // the figure, directly under the 官帽's bar — a double-barred T that no other
  // piece in either army makes.
  const swordDir = new THREE.Vector3(-1, 0.12, -0.26).normalize();
  // The 鉞 stays unrolled, so its crescent lies in the sagittal plane: broadside
  // from the side, a bare vertical shaft from the front. That split is
  // deliberate — the front view already carries the winged crown, and two big
  // shapes at the same height in the same view merge into one blob.
  const aimR = han ? aim(swordDir, 0.4) : aim(UP);
  const gripR = han
    ? new THREE.Vector3(m.hipWidth * 0.82, m.chestY + m.torsoLen * 0.22, -m.chestDepth * 1.72)
    : new THREE.Vector3(m.hipWidth * 1.0, m.waistY + m.torsoLen * 0.28, -m.chestDepth * 0.72);

  // Off hand: Han's flat palm supports the blade two thirds of the way along, so
  // both sleeves open at the same height; Chu lets it hang, so his drape is one
  // long vertical.
  const aimL = han ? aimR : aim(new THREE.Vector3(-0.12, -0.96, -0.25));
  const wristLTarget = han
    ? wristFor(
        gripR.clone().addScaledVector(swordDir, m.height * 0.27).add(new THREE.Vector3(0, -m.handR * 1.2, 0)),
        aimL,
        m,
      )
    : new THREE.Vector3(-m.hipWidth * 0.88, m.waistY - m.torsoLen * 0.28, -m.chestDepth * 0.5);

  const offsets: Partial<Record<BoneName, V3>> = {};
  const wristR = poseArm(
    ctx.rig.bindWorld,
    m,
    'R',
    wristFor(gripR, aimR, m),
    // Poles chosen to break both elbows OUTWARD. That is the whole silhouette:
    // an elbow tucked at the ribs puts the sleeve inside the robe's own outline
    // and the figure goes back to being a column.
    han ? [1, -0.3, 0.42] : [0.9, -0.25, 0.75],
    offsets,
  );
  const wristL = poseArm(
    ctx.rig.bindWorld,
    m,
    'L',
    wristLTarget,
    han ? [-1, -0.3, 0.42] : [-0.8, -0.5, 0.35],
    offsets,
  );
  const rig = ctx.useRig({ offsets });
  const B = rig.bindWorld;

  // --- head, neck, forearms, hands ---------------------------------------
  g.parts.push(P.body.neck({ fromY: m.shoulderY - m.torsoLen * 0.04, toY: B.head.y + m.headLen * 0.08, r: m.neckR }));
  const head = P.body.head({
    baseY: B.head.y,
    length: m.headLen,
    width: m.headWidth,
    depth: m.headDepth,
    z: B.head.z,
    beard,
    topknot: false,
  });
  g.parts.push(...head.parts);

  const bore = m.height * 0.019;
  for (const S of ['L', 'R'] as const) {
    // Only the forearm is built: the upper arm is inside the sleeve for its
    // whole length and nothing that is never seen is worth 110 triangles.
    g.parts.push(
      P.body.limb({
        from: v3(B[`foreArm${S}` as BoneName]),
        to: v3(B[`hand${S}` as BoneName]),
        r0: m.foreArmR * 1.1,
        r1: m.foreArmR * 0.72,
        bulge: 1.14,
        bulgeAt: 0.26,
        flatten: 0.8,
        sides: 6,
        boneHint: `foreArm${S}` as BoneName,
        name: `foreArm${S}`,
      }),
    );
    const hand = posedHand(
      P,
      S,
      S === 'R' ? wristR : wristL,
      S === 'R' ? aimR : aimL,
      m,
      S === 'R' || !han ? 'fist' : 'flat',
      bore,
    );
    g.parts.push(...hand.parts);
    for (const k of Object.keys(hand.points)) g.points[k] = hand.points[k];

    // Shin and boot under the hem. This is the only part of the figure below
    // the sash that is *narrower* than the figure above it, so it is what stops
    // the outline being a post: a pale silk 絝 over the calf, a dark boot under
    // it, and daylight between the two legs.
    g.parts.push(
      P.body.limb({
        from: v3(B[`shin${S}` as BoneName]),
        to: v3(B[`foot${S}` as BoneName]),
        r0: m.shinR * 1.3,
        r1: m.shinR * 0.88,
        sides: 6,
        squareness: 0.35,
        boneHint: `shin${S}` as BoneName,
        // Undyed silk. It shares the jade 璧's bucket, so the one high-key
        // value on the figure below the collar costs no extra material pair.
        cls: 'ivory',
        pigment: 'shellWhite',
        name: `shin${S}`,
      }),
      ...P.body.boot({
        side: S,
        ankle: v3(B[`foot${S}` as BoneName]),
        length: m.footLen * 0.92,
        width: m.footLen * 0.4,
        shaft: 0.34,
      }).parts,
    );
  }

  // --- the robe -----------------------------------------------------------
  // The hem clears the boot by most of the calf. Below it the silhouette is two
  // legs; above it the robe is deliberately NARROW — a Han court robe falls
  // straight from the sash, it does not flare, and the flare is what a general's
  // cloak does. Between the straight hem and the sleeves carried out at the
  // shoulder the figure is an inverted trapezoid, which is the one thing it has
  // to be that a scaled-down general is not.
  const hemY = m.ankleY + m.shinLen * (han ? 0.88 : 0.98);
  const shoulderY = m.shoulderY + m.torsoLen * 0.04;
  const waistY = m.waistY + m.torsoLen * 0.02;
  const hemR = m.hipWidth * (han ? 0.94 : 1.24);
  // The two rear points of the Chu 燕尾 hem fall a quarter of a shin below the
  // rest of it — enough to fork, not so far that the fork lands back in the
  // lowest sixth of the figure and undoes the raised hem. `robeSkirt` drops a
  // vertex by at most 0.71 of `tail`.
  const tail = han ? 0 : m.shinLen * 0.24;

  const bodice = P.prim.loft(
    [
      P.cloth.pleatedRing(folds, m.shoulderWidth * 0.54, m.shoulderWidth * 0.5, shoulderY, { squash: 0.78 }),
      P.cloth.pleatedRing(folds, m.shoulderWidth * 0.53, m.shoulderWidth * 0.49, m.chestY + m.torsoLen * 0.06, { squash: 0.78 }),
      P.cloth.pleatedRing(folds, m.shoulderWidth * 0.5, m.shoulderWidth * 0.45, (shoulderY + waistY) / 2, { squash: 0.78 }),
      P.cloth.pleatedRing(folds, m.waistWidth * 0.68, m.waistWidth * 0.63, waistY, { squash: 0.8 }),
    ],
    { capStart: true, capEnd: false, name: 'robeBodice' },
  );
  g.parts.push(
    P.mkPart(bodice, 'cloth', 'cloth', 'spine01', { name: 'robeBodice', allow: ['spine02', 'pelvis'] }),
  );

  g.parts.push(
    robeSkirt(P, {
      topY: waistY,
      hemY,
      rTop: m.waistWidth * 0.68,
      rHem: hemR,
      folds,
      squash: 0.8,
      tail,
      pigment: 'cloth',
    }),
  );
  if (han) g.parts.push(hemFold(P, m, hemY, hemR, folds, 0.8));

  // Sleeves: wrapped over the arm, then dropped below it. Han's are the wider
  // pair — his are the only sleeves in the cast carried out clear of the body on
  // both sides at once, and they have to out-measure his own hem by a quarter or
  // the inverted trapezoid is not there to read.
  const cuffR = m.upperArmR * (han ? 4.4 : 3.4);
  g.parts.push(
    ...P.cloth.sleeves(
      { r0: m.upperArmR * (han ? 2.2 : 2.0), r1: cuffR, folds: 8, length: 0.92 },
      { shoulder: v3(B.upperArmL), elbow: v3(B.foreArmL), wrist: v3(B.handL) },
      { shoulder: v3(B.upperArmR), elbow: v3(B.foreArmR), wrist: v3(B.handR) },
    ).parts,
  );
  for (const S of ['L', 'R'] as const) {
    // Han's carry is symmetric — both hands are on the 劍 — so both sleeves
    // drop the same. Chu's off arm hangs, so only its drape is the long one.
    const long = han || S === 'L';
    g.parts.push(
      sleeveDrape(
        P,
        S,
        B[`foreArm${S}` as BoneName],
        B[`hand${S}` as BoneName],
        m.upperArmR * (han ? 2.9 : 3.4),
        m.torsoLen * (long ? 0.68 : 0.6),
      ),
    );
  }

  // 交領 — the crossed collar, twice: a court robe is worn over a 中衣 and the
  // two collars step at the throat. Two lapped bands is the detail that dates
  // the costume, and it survives at silhouette size as a notch at the neck.
  g.parts.push(
    ...P.cloth.collar({
      shoulderY,
      chestY: m.chestY - m.torsoLen * 0.16,
      rx: m.shoulderWidth * 0.52,
      rz: m.chestDepth * 0.72,
      width: m.shoulderWidth * 0.16,
    }).parts,
    ...P.cloth.collar({
      shoulderY: shoulderY - m.torsoLen * 0.06,
      chestY: m.chestY - m.torsoLen * 0.26,
      rx: m.shoulderWidth * 0.46,
      rz: m.chestDepth * 0.66,
      width: m.shoulderWidth * 0.12,
      pigment: 'cloth',
    }).parts,
  );
  g.parts.push(
    ...P.cloth.sash({
      y: waistY,
      rx: m.waistWidth * 0.68,
      rz: m.waistWidth * 0.68 * 0.8,
      height: m.torsoLen * 0.15,
      tail: m.torsoLen * (han ? 1.0 : 1.3),
      knot: true,
    }).parts,
  );

  // The wrapped front edge of a 交領 robe, running collar to hip.
  g.parts.push(
    P.trim.piping({
      path: [
        [-m.shoulderWidth * 0.26, shoulderY - m.torsoLen * 0.06, -m.chestDepth * 0.78],
        [-m.waistWidth * 0.1, m.chestY - m.torsoLen * 0.18, -m.chestDepth * 1.0],
        [m.waistWidth * 0.42, waistY + m.torsoLen * 0.04, -m.chestDepth * 0.86],
        [m.waistWidth * 0.6, waistY - m.torsoLen * 0.18, -m.chestDepth * 0.6],
      ],
      r: m.height * 0.008,
      boneHint: 'spine01',
      pigment: 'accent',
      cls: 'cloth',
      name: 'robeEdge',
    }),
  );

  g.parts.push(
    apron(P, {
      topY: waistY - m.torsoLen * 0.06,
      botY: hemY + m.legLen * (han ? 0.1 : 0.06),
      rTop: m.waistWidth * 0.68,
      rBot: hemR,
      squash: 0.8,
      halfWidth: m.hipWidth * 0.44,
      point: han ? 0 : m.legLen * 0.12,
    }),
  );
  for (const S of ['L', 'R'] as const) {
    g.parts.push(
      cuffBand(P, S, B[`foreArm${S}` as BoneName], B[`hand${S}` as BoneName], cuffR),
    );
  }

  g.parts.push(
    ...jadePendant(
      P,
      [
        han ? -m.hipWidth * 0.66 : m.hipWidth * 0.62,
        waistY - m.torsoLen * 0.52,
        -m.waistWidth * 0.52,
      ],
      m.height * 0.032,
    ).parts,
  );

  // --- crown --------------------------------------------------------------
  const crown = han
    ? hanCap(P, m, B.head.z, B.head.y, capRise)
    : chuCrown(P, m, B.head.z, B.head.y, capRise, wingSpread);
  g.parts.push(...crown.parts);
  g.attach.push({ name: 'crest', bone: 'head', position: v3(crown.points.crest) });

  // --- weapon and scabbard ------------------------------------------------
  // The design record asks for a 劍 in both hands' worth of both armies; the
  // Chu 士 carries a ritual 鉞 instead, which is the unit brief's call and the
  // reason his outline is a vertical shaft rather than a low diagonal.
  // Placed at where the fist's bore actually ended up, not at the point that was
  // asked for: `poseArm` pulls an over-long reach back inside the arm, and a
  // weapon left at the original point would hang in mid-air beside the hand.
  const heldAt = gripOf(wristR, aimR, m);
  let weapon: PartGroup;
  if (han) {
    weapon = P.weapons.sword({
      grip: v3(heldAt),
      rot: aimR.euler,
      bone: 'handR',
      length: m.height * 0.36,
      halfWidth: m.height * 0.021,
      metalPigment: 'metal',
    });
  } else {
    const length = m.height * 0.84;
    // Butt clear of the board: the haft is vertical, so this is a straight
    // clamp on how far below the grip the shaft may run.
    const gripAt = Math.min(0.46, (heldAt.y - BUTT_CLEARANCE) / length);
    weapon = P.weapons.axe({
      grip: v3(heldAt),
      rot: aimR.euler,
      bone: 'handR',
      length,
      gripAt,
      headWidth: m.height * 0.17,
      shaftR: bore * 0.92,
      metalPigment: 'metal',
    });
  }
  courtFinish(weapon);
  g.parts.push(...weapon.parts);
  g.instanced.push(...weapon.instanced);
  g.attach.push({ name: 'haftTip', bone: 'handR', position: v3(weapon.points.tip) });

  // An empty scabbard at the left hip — his sword is in his hand.
  const hipAt: V3 = [
    -m.hipWidth * 0.72,
    m.hipY + m.torsoLen * 0.06,
    m.hipDepth * 0.18,
  ];
  const scabbard = courtFinish(
    P.weapons.scabbard({
      grip: hipAt,
      rot: [0.2, 0, 0.3],
      bone: 'pelvis',
      length: m.height * (han ? 0.3 : 0.26),
      width: m.height * 0.034,
      metalPigment: 'metal',
    }),
  );
  g.parts.push(...scabbard.parts);
  g.attach.push({ name: 'hip', bone: 'pelvis', position: hipAt });

  return g;
}

registerUnit(PieceType.Advisor, buildAdvisor);
