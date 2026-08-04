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
 *   outline          narrow column               wide-based triangle
 *   dominant stroke  a diagonal haft             a vertical crown
 *   top of the head  low — a cone or a wrap      tall — a cap or a winged crown
 *   waist to hem     armour plates, hard edges   robe flare, folded cloth
 *
 * He is a court official, not a soldier: no lamellar anywhere on him. The robe
 * carries the silhouette — a flared hem, wide hanging sleeves, and above it a
 * crown that is the tallest headgear in the cast bar the general's.
 *
 * TWO COURTS, NOT ONE COURT IN TWO COLOURS
 * ----------------------------------------
 *   Han 仕: a tall lacquered 官帽 with a stiff horizontal bar across it — a T
 *           against the sky — a straight court robe whose hem is turned back on
 *           itself in one hard fold, a short 劍 held low in a parrying guard and
 *           a jade 璧 hung at the sash.
 *   Chu 士: a taller crown that flares as it rises and throws two upswept wings
 *           past the top of it — a V — a robe cut into a swallow-tail hem that
 *           falls into two points behind the heels, and a ritual 鉞 held
 *           vertically like a staff of office.
 *
 * A T and a V, a straight hem and a forked one, a low guard and a vertical
 * shaft. None of that is pigment, so all of it survives the silhouette pass.
 *
 * WHAT IS NOT BUILT
 * -----------------
 * There is no torso and there are no legs under the robe. The robe bodice runs
 * shoulder to waist and the skirt waist to hem, both closed solids, so a torso
 * inside them would be geometry nothing can ever see — 600 triangles of it, on
 * four figures. Only what shows is built: forearms out of the cuffs, hands,
 * head, and boot toes under the hem.
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
  const local = new THREE.Vector3(0, -m.handLen * 0.5, -m.handR * 0.55).applyQuaternion(a.quat);
  return grip.clone().sub(local);
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
  for (const s of [-1, 1]) {
    const grid: V3[][] = [];
    const rows = 4;
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);
      // Rises fast, leans out and back, and narrows to a point.
      const x = s * R * (0.5 + t * spread);
      const y = base + L * (rise * 0.3 + t * (rise * 0.95));
      const z = headZ + R * (0.1 + t * t * 0.7);
      const w = L * (0.11 - t * 0.075);
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
  const rows = 6;
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
 * keeps going. This is that cloth: a panel dropped from the forearm, widening
 * and swinging back as it falls. On the raised arm it is most of what makes the
 * outline a triangle rather than a column.
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
  const cols = 3;
  const grid: V3[][] = [];
  const s = side === 'L' ? -1 : 1;
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const row: V3[] = [];
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      // Runs from elbow to cuff across the panel, and falls with `t`.
      const along = elbow.clone().lerp(wrist, 0.15 + u * 0.85);
      const w = width * (0.62 + t * 0.9);
      row.push([
        along.x + s * w * 0.16,
        along.y - drop * (t * 0.72 + t * t * 0.28),
        along.z + w * (0.1 + t * 0.5),
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
  const wingSpread = 0.55 + rng.range(-0.06, 0.06);
  const folds = 9 + (ctx.variant % 2);

  // --- the weapon, and the hands that hold it -----------------------------
  // Han: 劍 low and forward in a parrying guard, point out past the left knee.
  // Chu: 鉞 vertical at the right side, butt just clear of the board.
  const swordDir = new THREE.Vector3(-0.42, -0.5, -0.76);
  const aimR = han ? aim(swordDir, 0.5) : aim(UP);
  const gripR = han
    ? new THREE.Vector3(m.hipWidth * 0.72, m.waistY - m.torsoLen * 0.02, -m.chestDepth * 1.15)
    : new THREE.Vector3(m.hipWidth * 0.86, m.waistY + m.torsoLen * 0.28, -m.chestDepth * 0.72);

  // Off hand: Han raises it, palm out, in the formal 揖 gesture that opens the
  // sleeve; Chu lets it hang, so his drape is one long vertical.
  const aimL = han
    ? aim(new THREE.Vector3(0.25, -0.42, -0.87).negate())
    : aim(new THREE.Vector3(-0.12, -0.96, -0.25));
  const wristLTarget = han
    ? new THREE.Vector3(-m.hipWidth * 0.62, m.chestY + m.torsoLen * 0.06, -m.chestDepth * 1.25)
    : new THREE.Vector3(-m.hipWidth * 0.88, m.waistY - m.torsoLen * 0.28, -m.chestDepth * 0.5);

  const offsets: Partial<Record<BoneName, V3>> = {};
  const wristR = poseArm(
    ctx.rig.bindWorld,
    m,
    'R',
    wristFor(gripR, aimR, m),
    han ? [0.85, -0.35, 0.55] : [0.9, -0.25, 0.75],
    offsets,
  );
  const wristL = poseArm(
    ctx.rig.bindWorld,
    m,
    'L',
    wristLTarget,
    han ? [-0.7, -0.95, -0.15] : [-0.8, -0.5, 0.35],
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

    // Boot toes under the hem. No legs: the robe is a closed solid and they
    // would be invisible geometry on four figures.
    g.parts.push(
      ...P.body.boot({
        side: S,
        ankle: v3(B[`foot${S}` as BoneName]),
        length: m.footLen,
        width: m.footLen * 0.42,
        shaft: 0.06,
      }).parts,
    );
  }

  // --- the robe -----------------------------------------------------------
  const hemY = m.ankleY * 1.15;
  const shoulderY = m.shoulderY + m.torsoLen * 0.04;
  const waistY = m.waistY + m.torsoLen * 0.02;
  const hemR = m.hipWidth * (han ? 1.5 : 1.42);

  const bodice = P.prim.loft(
    [
      P.cloth.pleatedRing(folds, m.shoulderWidth * 0.54, m.shoulderWidth * 0.5, shoulderY, { squash: 0.78 }),
      P.cloth.pleatedRing(folds, m.shoulderWidth * 0.52, m.shoulderWidth * 0.48, (shoulderY + waistY) / 2, { squash: 0.78 }),
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
      tail: han ? 0 : m.legLen * 0.16,
      pigment: 'cloth',
    }),
  );
  if (han) g.parts.push(hemFold(P, m, hemY, hemR, folds, 0.8));

  // Sleeves: wrapped over the arm, then dropped below it.
  g.parts.push(
    ...P.cloth.sleeves(
      { r0: m.upperArmR * 2.0, r1: m.upperArmR * (han ? 3.9 : 3.4), folds: 7, length: 0.9 },
      { shoulder: v3(B.upperArmL), elbow: v3(B.foreArmL), wrist: v3(B.handL) },
      { shoulder: v3(B.upperArmR), elbow: v3(B.foreArmR), wrist: v3(B.handR) },
    ).parts,
  );
  for (const S of ['L', 'R'] as const) {
    const raised = han && S === 'L';
    g.parts.push(
      sleeveDrape(
        P,
        S,
        B[`foreArm${S}` as BoneName],
        B[`hand${S}` as BoneName],
        m.upperArmR * (raised ? 4.2 : 3.4),
        m.torsoLen * (raised ? 0.86 : 0.6),
      ),
    );
  }

  // 交領 — the crossed collar, and the sash that cuts the robe in two values.
  g.parts.push(
    ...P.cloth.collar({
      shoulderY,
      chestY: m.chestY - m.torsoLen * 0.16,
      rx: m.shoulderWidth * 0.52,
      rz: m.chestDepth * 0.72,
      width: m.shoulderWidth * 0.16,
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
  let weapon: PartGroup;
  if (han) {
    weapon = P.weapons.sword({
      grip: v3(gripR),
      rot: aimR.euler,
      bone: 'handR',
      length: m.height * 0.4,
      halfWidth: m.height * 0.021,
      metalPigment: 'metal',
    });
  } else {
    const length = m.height * 0.84;
    // Butt clear of the board: the haft is vertical, so this is a straight
    // clamp on how far below the grip the shaft may run.
    const gripAt = Math.min(0.46, (gripR.y - BUTT_CLEARANCE) / length);
    weapon = P.weapons.axe({
      grip: v3(gripR),
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
