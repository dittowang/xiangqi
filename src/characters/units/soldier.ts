/**
 * 兵 / 卒 — the conscript.
 *
 * THE SILHOUETTE, WHICH IS THE WHOLE JOB
 * --------------------------------------
 * Five of these stand on each side of the board and they are the piece a player
 * reads most often, at the smallest size, from the furthest away. The brief
 * fixes the class: a narrow vertical column with a LOW crown. That leaves
 * exactly one thing free to carry identity, and it is the haft angle — so this
 * file commits to it hard:
 *
 *   Han 兵 rakes a short 矛 spear FORWARD, gripped in both hands, butt behind
 *           the right heel and point out past the knee-line: a tall thin column
 *           with a stroke cutting down-and-forward across it.
 *   Chu 卒 rakes a long 戈 dagger-axe BACK over the right shoulder, held in one
 *           hand with the off arm swinging free, so the same column carries the
 *           opposite diagonal, topped by the 戈's forward hook — an inverted L
 *           that nothing else in either army makes.
 *
 * Two opposite diagonals is a difference that survives being reduced to a black
 * shape at forty pixels, which colour, plate count and helmet detail do not. The
 * headgear is the second read (Han: a hard lacquered cone with a rolled brim and
 * an upright 纓 plume; Chu: a soft flat-topped 幘 wrap with a knotted band), the
 * armour the third (Han: knee-length lamellar over a tunic; Chu: a quilted
 * jerkin carrying only a short breast row of plates).
 *
 * HANDS ARE ON THE HAFT, NOT NEAR IT
 * ----------------------------------
 * The haft line is chosen *first*, in rig space. Both wrists are then solved
 * back from it, the elbows come from a two-link IK so no limb is stretched past
 * its bind length, and the whole thing is installed as a bind pose through
 * `useRig({ offsets })`. The fists are rotated about their wrists so the bore
 * `body.hand()` drills along +Y lies along the haft: the shaft genuinely passes
 * through the hole in the hand. The animator's grip IK then has almost nothing
 * left to correct, and a detached hand is impossible by construction.
 *
 * DRAW CALLS
 * ----------
 * Ten of these are on the board at once, so every material pair costs twenty
 * draw calls with the outline pass. Every lamellar band is therefore *baked*
 * into the figure's one lacquer mesh instead of shipping as its own
 * `InstancedMesh`, and all metal — brim, blade, ferrules, rivets, boss — is
 * tagged `iron` so it shares a single bucket. The result is eight meshes against
 * the generic fallback figure's sixteen.
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

/** Rig units of daylight kept under a polearm's butt, so it never spears the board. */
const BUTT_CLEARANCE = 0.05;

// ---------------------------------------------------------------------------
// The carry: one line in space that the weapon, both fists and both arms share
// ---------------------------------------------------------------------------

interface Carry {
  /** Pitch about +X applied to the weapon. Negative rakes the head forward (−Z). */
  pitch: number;
  /** Unit vector up the haft. */
  dir: THREE.Vector3;
  /** Where the right (rear, for Han) hand closes. The weapon is placed here. */
  gripR: THREE.Vector3;
  /** Where the left hand closes, further along the haft. */
  gripL: THREE.Vector3;
  /** Weapon length and the fraction of it that hangs below `gripR`. */
  length: number;
  gripAt: number;
}

/**
 * Build the carry. `spacing` is the hand separation along the haft and is
 * signed: positive puts the left hand *above* the right.
 *
 * `gripAt` is clamped so the butt clears the board — a haft driven underground
 * is invisible in a viewport, unmissable in a shadow pass, and it inflates the
 * measured silhouette height of everything that carries one.
 */
function carry(
  pitch: number,
  anchor: THREE.Vector3,
  length: number,
  wanted: number,
  spacing: number,
): Carry {
  const dir = new THREE.Vector3(0, Math.cos(pitch), Math.sin(pitch));
  const maxBelow = Math.max(length * 0.06, (anchor.y - BUTT_CLEARANCE) / Math.max(0.2, dir.y));
  const gripAt = Math.min(wanted, maxBelow / length);
  return {
    pitch,
    dir,
    gripR: anchor.clone(),
    gripL: anchor.clone().addScaledVector(dir, spacing),
    length,
    gripAt,
  };
}

/**
 * Close the hands up the haft until both are inside the arms' reach.
 *
 * Han and Chu proportions differ, and the per-variant jitter moves shoulders by
 * a few percent more; a hand grip that is exactly reachable on one figure is a
 * stretched forearm on the next. Shrinking the grip separation is the one
 * degree of freedom that costs nothing — the haft angle, which is the
 * silhouette, is untouched.
 */
function fitCarry(
  bind: Record<BoneName, THREE.Vector3>,
  m: RigMetrics,
  pitch: number,
  anchor: THREE.Vector3,
  length: number,
  wanted: number,
  spacing: number,
): Carry {
  const reach = (m.upperArmLen + m.foreArmLen) * 0.97;
  let s = spacing;
  for (let i = 0; i < 8; i++) {
    const c = carry(pitch, anchor, length, wanted, s);
    const okL = wristFor(c.gripL, pitch, m).distanceTo(bind.upperArmL) <= reach;
    const okR = wristFor(c.gripR, pitch, m).distanceTo(bind.upperArmR) <= reach;
    if (okL && okR) return c;
    s *= 0.87;
  }
  return carry(pitch, anchor, length, wanted, s);
}

// ---------------------------------------------------------------------------
// Posing
// ---------------------------------------------------------------------------

/**
 * Elbow position for a two-link chain that must reach `wrist` from `shoulder`
 * without either segment changing length. Standard planar solve: walk `along`
 * down the shoulder→wrist axis, then `h` sideways along the pole vector.
 *
 * Solving it rather than eyeballing an offset matters because the bind lengths
 * the animator retargets against are measured off these positions — an elbow
 * placed by hand quietly rescales the arm for every clip that plays on it.
 */
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
 * Bind-pose offsets that put both wrists on the haft. Offsets move a bone *and
 * its subtree*, so the hand's delta is expressed on top of the forearm's — the
 * same arithmetic `fallback.ts` uses to fold a rider's legs.
 */
function armOffsets(
  bind: Record<BoneName, THREE.Vector3>,
  metrics: RigMetrics,
  targets: { L: THREE.Vector3; R: THREE.Vector3 },
  poles: { L: V3; R: V3 },
): Partial<Record<BoneName, V3>> {
  const out: Partial<Record<BoneName, V3>> = {};
  for (const S of ['L', 'R'] as const) {
    const shoulder = bind[`upperArm${S}` as BoneName];
    const wrist = targets[S];
    // The pole vector decides which way a folded arm breaks. It is per-hand,
    // not per-side: the hand that leads on the haft breaks its elbow forward
    // and low across the belly, the trailing hand breaks its elbow back past
    // the hip. Get this wrong and the elbow ends up inside the ribcage.
    const pole = new THREE.Vector3(...poles[S]);
    const elbow = elbowFor(shoulder, wrist, metrics.upperArmLen, metrics.foreArmLen, pole);
    const e0 = bind[`foreArm${S}` as BoneName];
    const w0 = bind[`hand${S}` as BoneName];
    const dE: V3 = [elbow.x - e0.x, elbow.y - e0.y, elbow.z - e0.z];
    out[`foreArm${S}` as BoneName] = dE;
    out[`hand${S}` as BoneName] = [
      wrist.x - w0.x - dE[0],
      wrist.y - w0.y - dE[1],
      wrist.z - w0.z - dE[2],
    ];
  }
  return out;
}

/**
 * A fist whose bore is aligned with the haft. `body.hand()` drills the grip
 * along +Y, so the whole hand group — geometry and its published grip point —
 * is rotated about the wrist by the haft's pitch.
 */
function posedHand(
  P: Lib,
  side: 'L' | 'R',
  wrist: THREE.Vector3,
  pitch: number,
  m: RigMetrics,
  bore: number,
): PartGroup {
  const g = P.body.hand({
    side,
    wrist: v3(wrist),
    length: m.handLen,
    r: m.handR,
    pose: 'fist',
    gripR: bore,
  });
  const M = new THREE.Matrix4()
    .makeTranslation(wrist.x, wrist.y, wrist.z)
    .multiply(new THREE.Matrix4().makeRotationX(pitch))
    .multiply(new THREE.Matrix4().makeTranslation(-wrist.x, -wrist.y, -wrist.z));
  return P.transformGroup(g, M);
}

/** Wrist position that puts a pitched fist's bore centre exactly on `grip`. */
function wristFor(grip: THREE.Vector3, pitch: number, m: RigMetrics): THREE.Vector3 {
  const local = new THREE.Vector3(0, -m.handLen * 0.5, -m.handR * 0.55).applyAxisAngle(
    new THREE.Vector3(1, 0, 0),
    pitch,
  );
  return grip.clone().sub(local);
}

// ---------------------------------------------------------------------------
// Material housekeeping
// ---------------------------------------------------------------------------

/**
 * Force every metal surface onto one material class and one pigment.
 *
 * `gold` and `iron` are two different materials in `palette.ts`, and a lashing
 * ring in the army accent is a third — three buckets, therefore six draw calls
 * once the outline pass doubles them, for perhaps two hundred triangles of
 * ferrule. A conscript's fittings are iron; the tassel caps and lashing rings
 * the parts library tags otherwise are retagged rather than shipping a whole
 * material for themselves.
 */
function unifyMetal(g: PartGroup): PartGroup {
  for (const p of [...g.parts, ...g.instanced]) {
    if (p.cls === 'gold') p.cls = 'iron';
    if (p.cls === 'iron' && p.pigment === 'accent') p.pigment = 'metal';
  }
  return g;
}

/**
 * Collapse an instanced band into one merged geometry per bone.
 *
 * The factory ships any instance set of 24 or more as its own `InstancedMesh`,
 * which is the right default: it costs one draw call and saves the vertex
 * memory of every duplicate plate. For this unit it is the wrong trade. A
 * conscript's harness is three bands, ten conscripts stand on the board, and the
 * outline pass doubles everything — sixty draw calls to save perhaps 120 kB of
 * vertices. Baked into the figure's existing lacquer mesh the plates cost the
 * same triangles, keep their rigid per-bone weights (skin indices are per
 * vertex, so plates on `spine01` and `spine02` still crease at the waist), and
 * cost nothing at all in draw calls.
 *
 * `drop` removes plates from the largest band — battered kit, and the only
 * per-variant difference that shows through the armour rather than beside it.
 */
function bakeBand(P: Lib, band: PartGroup, name: string, rng: Rng, drop = 0): Part[] {
  const out: Part[] = [];
  let worn = drop;
  // Wear the biggest band first: that is the cuirass, where a gap reads.
  const order = [...band.instanced].sort((a, b) => b.transforms.length - a.transforms.length);
  for (const inst of order) {
    const mats = [...inst.transforms];
    while (worn > 0 && mats.length > 6) {
      mats.splice(rng.int(0, mats.length - 1), 1);
      worn--;
    }
    if (mats.length === 0) continue;
    const geoms = mats.map((t) => inst.geometry.clone().applyMatrix4(t));
    out.push(
      P.mkPart(P.prim.mergeGeometryList(geoms), inst.cls, inst.pigment, inst.boneHint, {
        name: `${name}:${inst.boneHint}`,
        rigid: true,
        ...(inst.noSilk ? { noSilk: true } : {}),
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Headgear
// ---------------------------------------------------------------------------

/**
 * The Han 兜鍪 as a lacquered leather cone: a hard eight-sided taper with two
 * creases in its profile, a rolled iron brim, a socket and an upright 纓 plume.
 * A cone, not a dome — a dome is the one helmet shape that reads as "generic
 * helmet" at silhouette size, and the brim step under a straight taper is what
 * makes this one legible at forty pixels.
 */
function hanCone(P: Lib, m: RigMetrics, headZ: number, headBaseY: number, taper: number, rng: Rng): PartGroup {
  const g = P.emptyGroup();
  const L = m.headLen;
  const R = Math.max(m.headWidth, m.headDepth) * 0.6;
  const base = headBaseY + L * 0.3;
  const apex = base + L * (0.92 * taper);

  const bowl = P.prim.hardLathe(
    [
      [R * 1.04, base],
      [R * 1.0, base + L * 0.12],
      [R * 0.8, base + L * 0.42 * taper],
      [R * 0.5, base + L * 0.68 * taper],
      [R * 0.22, base + L * 0.86 * taper],
      [R * 0.1, apex],
    ],
    8,
    { phase: Math.PI / 8, capStart: false, name: 'coneBowl' },
  );
  bowl.translate(0, 0, headZ);
  g.parts.push(P.mkPart(bowl, 'lacquer', 'lacquer', 'head', { name: 'helmBowl', rigid: true }));

  // Rolled brim: out, then under. Deliberately over-scaled — it is the step
  // that separates the cone from the head in a flat black render.
  const brim = P.prim.hardLathe(
    [
      [R * 1.02, base + L * 0.1],
      [R * 1.3, base + L * 0.02],
      [R * 1.34, base - L * 0.06],
      [R * 1.18, base - L * 0.1],
      [R * 1.02, base - L * 0.05],
    ],
    8,
    { phase: Math.PI / 8, capStart: false, capEnd: false, name: 'coneBrim' },
  );
  brim.translate(0, 0, headZ);
  g.parts.push(P.mkPart(brim, 'iron', 'metal', 'head', { name: 'helmBrim', rigid: true }));

  // 頓項 — a cheek lappet each side, hung off the brim beside the jaw.
  for (const s of [-1, 1]) {
    const grid: V3[][] = [];
    for (let r = 0; r < 3; r++) {
      const t = r / 2;
      const y = base - L * (0.06 + t * 0.4);
      const w = R * (1.0 - t * 0.22);
      grid.push([
        [s * w, y, headZ + R * (0.5 - t * 0.12)],
        [s * w * 1.04, y, headZ + R * 0.04],
        [s * w * 0.94, y, headZ - R * (0.42 + t * 0.06)],
      ]);
    }
    g.parts.push(
      P.mkPart(
        P.prim.shell(grid, R * 0.05, { name: 'cheekLappet', flip: s > 0 }),
        'lacquer',
        'lacquer',
        'head',
        { name: 'cheekLappet', rigid: true },
      ),
    );
  }

  // Rivets around the brim line. Eight of them: below the factory's instancing
  // threshold, so they are baked into the iron mesh for free.
  g.instanced.push(
    ...P.rivets.rivetArc({
      centre: [0, base + L * 0.1, headZ],
      rx: R * 1.08,
      rz: R * 1.08,
      count: 8,
      tilt: 0.4,
      boneHint: 'head',
      pigment: 'metal',
      rivet: { r: R * 0.08, h: R * 0.05 },
      name: 'helmRivets',
    }).instanced,
  );

  const crestAt: V3 = [0, apex - L * 0.04, headZ];
  const plume = P.helmet.crest({
    style: 'plume',
    at: crestAt,
    height: L * (0.58 + rng.range(0, 0.1)),
    width: m.headWidth * 0.5,
    pigment: 'accent',
  });
  // The plume is horsehair, but it is the only 'accent' surface on the figure
  // apart from the sash, and one shared cloth bucket is worth more than the
  // hair ramp's harder two-step on 120 triangles.
  for (const p of plume.parts) if (p.cls === 'hair') p.cls = 'cloth';
  g.parts.push(...unifyMetal(plume).parts);
  g.instanced.push(...plume.instanced);

  g.points.crest = new THREE.Vector3(crestAt[0], crestAt[1], crestAt[2]);
  return g;
}

/**
 * The Chu 幘: a cloth head-wrap with a knotted band. Two builds, chosen per
 * variant — closed (a flat-topped cap over the whole skull) and open (a brow
 * band with the topknot standing clear of it). Both are low, both are soft, and
 * neither can be mistaken for the Han cone.
 */
function chuWrap(
  P: Lib,
  m: RigMetrics,
  headZ: number,
  headBaseY: number,
  open: boolean,
  rng: Rng,
): PartGroup {
  const g = P.emptyGroup();
  const L = m.headLen;
  const R = Math.max(m.headWidth, m.headDepth) * 0.58;
  const base = headBaseY + L * 0.34;

  // The wound band. Two courses, offset sideways so the wrap spirals rather
  // than stacking — a stack of rings reads as a barrel, a spiral as cloth.
  for (let i = 0; i < 2; i++) {
    const t = i;
    const band = P.prim.loft(
      [
        P.prim.ring({ rx: R * 1.06, rz: R * 1.04, y: base + L * (0.02 + t * 0.17), cz: headZ, sides: 8, phase: Math.PI / 8, squareness: 0.5 }),
        P.prim.ring({ rx: R * 1.14, rz: R * 1.1, y: base + L * (0.1 + t * 0.17), cx: (i === 0 ? 1 : -1) * R * 0.03, cz: headZ, sides: 8, phase: Math.PI / 8, squareness: 0.52 }),
        P.prim.ring({ rx: R * 1.05, rz: R * 1.02, y: base + L * (0.19 + t * 0.17), cz: headZ, sides: 8, phase: Math.PI / 8, squareness: 0.5 }),
      ],
      { capStart: false, capEnd: false, name: `wrapBand${i}` },
    );
    g.parts.push(P.mkPart(band, 'cloth', 'cloth', 'head', { name: 'headWrap', rigid: true }));
  }

  let topY = base + L * 0.38;
  if (!open) {
    // Flat-topped crown: a squared-off plan and a hard horizontal cap. The flat
    // top is the whole point — every other head in the cast turns over.
    topY = base + L * 0.56;
    const cap = P.prim.loft(
      [
        P.prim.ring({ rx: R * 1.02, rz: R * 1.0, y: base + L * 0.34, cz: headZ, sides: 8, phase: Math.PI / 8, squareness: 0.58 }),
        P.prim.ring({ rx: R * 0.98, rz: R * 0.96, y: base + L * 0.48, cz: headZ - R * 0.03, sides: 8, phase: Math.PI / 8, squareness: 0.66 }),
        P.prim.ring({ rx: R * 0.9, rz: R * 0.88, y: topY, cz: headZ - R * 0.05, sides: 8, phase: Math.PI / 8, squareness: 0.72 }),
      ],
      { capStart: false, capEnd: true, name: 'wrapCrown' },
    );
    g.parts.push(P.mkPart(cap, 'cloth', 'cloth', 'head', { name: 'headWrapCrown', rigid: true }));
  }

  // The knot, at the back of the head, with its two ends standing up and back.
  const knot = P.prim.bevelSlab({
    w: R * 0.5,
    h: L * 0.2,
    d: R * 0.34,
    bevel: R * 0.07,
    name: 'wrapKnot',
  });
  P.prim.place(knot, { pos: [0, base + L * 0.16, headZ + R * 1.02], rot: [0.2, 0, 0.3] });
  g.parts.push(P.mkPart(knot, 'cloth', 'accent', 'head', { name: 'wrapKnot', rigid: true }));

  for (const s of [-1, 1]) {
    const grid: V3[][] = [];
    for (let r = 0; r < 3; r++) {
      const t = r / 2;
      const y = base + L * (0.2 + t * (0.44 + rng.range(0, 0.1)));
      const z = headZ + R * (1.02 + t * 0.5);
      const w = R * (0.18 - t * 0.07);
      grid.push([
        [s * R * (0.16 + t * 0.16) - w, y, z],
        [s * R * (0.16 + t * 0.16) + w, y, z],
      ]);
    }
    g.parts.push(
      P.mkPart(P.prim.shell(grid, R * 0.035, { name: 'knotEnd', flip: s < 0 }), 'cloth', 'accent', 'head', {
        name: 'knotEnd',
        rigid: true,
      }),
    );
  }

  g.points.crest = new THREE.Vector3(0, topY, headZ);
  return g;
}

// ---------------------------------------------------------------------------
// Kit
// ---------------------------------------------------------------------------

/**
 * The Han conscript's small square 盾: a dished board strapped to the outside of
 * the left upper arm, with a raised rib and a boss.
 *
 * Strapped, not held — both his hands are on the spear — and on the *upper* arm
 * rather than the forearm for a silhouette reason. A two-handed grip brings the
 * left forearm across the body, so a shield on it would sit over the belly and
 * disappear into the figure's own outline. On the upper arm it stays outboard
 * of the shoulder, and it is the only thing making the Han conscript
 * asymmetrical from the front.
 */
function squareShield(P: Lib, m: RigMetrics, shoulder: THREE.Vector3, elbow: THREE.Vector3, scale: number): PartGroup {
  const g = P.emptyGroup();
  const H = m.height * 0.21 * scale;
  const W = m.height * 0.16 * scale;
  const dish = W * 0.16;

  const rows = 4;
  const cols = 4;
  const grid: V3[][] = [];
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const row: V3[] = [];
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      // Slightly waisted: full width at the middle, drawn in at top and bottom.
      const waist = 1 - Math.abs(t - 0.5) * 0.24;
      const bulge = 1 - Math.pow((u - 0.5) * 2, 2);
      row.push([(u - 0.5) * W * waist, (0.5 - t) * H, -dish * bulge]);
    }
    grid.push(row);
  }
  g.parts.push(
    P.mkPart(P.prim.shell(grid, W * 0.045, { name: 'shieldFace' }), 'lacquer', 'lacquer', 'upperArmL', {
      name: 'shieldFace',
      rigid: true,
    }),
  );

  const rib = P.prim.bevelSlab({ w: W * 0.12, h: H * 0.9, d: W * 0.05, bevel: W * 0.02 });
  rib.translate(0, 0, -dish - W * 0.03);
  g.parts.push(P.mkPart(rib, 'iron', 'metal', 'upperArmL', { name: 'shieldRib', rigid: true }));

  g.parts.push(
    P.trim.boss({
      at: [0, 0, -dish - W * 0.05],
      r: W * 0.16,
      height: W * 0.1,
      boneHint: 'upperArmL',
      pigment: 'metal',
      cls: 'iron',
      rot: [-Math.PI / 2, 0, 0],
      sides: 6,
    }),
  );

  // Two straps across the back, where the arm goes through.
  for (const s of [-1, 1]) {
    const strap = P.prim.bevelSlab({ w: W * 0.9, h: H * 0.1, d: W * 0.04, bevel: W * 0.015 });
    strap.translate(0, s * H * 0.17, dish * 0.4);
    g.parts.push(P.mkPart(strap, 'leather', 'leather', 'upperArmL', { name: 'shieldStrap', rigid: true }));
  }

  // Sit it outboard of the upper arm, face turned forward and out.
  const mid = shoulder.clone().lerp(elbow, 0.5);
  const M = new THREE.Matrix4().compose(
    new THREE.Vector3(mid.x - m.upperArmR * 2.5, mid.y - H * 0.06, mid.z - m.upperArmR * 0.4),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.14, -0.5, 0.26, 'XYZ')),
    new THREE.Vector3(1, 1, 1),
  );
  return P.transformGroup(g, M);
}

/**
 * What hangs off the belt. Three kits, chosen by variant, because a rank of
 * five identical conscripts is the failure this unit is most likely to make and
 * the belt is where a real rank differs most: one man carries a ration pouch,
 * the next a sheathed knife, the third both.
 */
function beltKit(P: Lib, m: RigMetrics, variant: number): PartGroup {
  const g = P.emptyGroup();
  const kit = variant % 3;
  const y = m.waistY - m.torsoLen * 0.16;

  if (kit === 0 || kit === 2) {
    // Ration pouch on the left hip: a soft bag with a stiff flap over it.
    const bag = P.prim.loft(
      [
        P.prim.ring({ rx: m.hipWidth * 0.2, rz: m.hipWidth * 0.11, y, sides: 6, phase: Math.PI / 6, squareness: 0.5 }),
        P.prim.ring({ rx: m.hipWidth * 0.23, rz: m.hipWidth * 0.13, y: y - m.torsoLen * 0.1, sides: 6, phase: Math.PI / 6, squareness: 0.5 }),
        P.prim.ring({ rx: m.hipWidth * 0.18, rz: m.hipWidth * 0.1, y: y - m.torsoLen * 0.2, sides: 6, phase: Math.PI / 6, squareness: 0.5 }),
      ],
      { name: 'pouch' },
    );
    bag.translate(-m.hipWidth * 0.66, 0, m.hipDepth * 0.28);
    g.parts.push(P.mkPart(bag, 'leather', 'leather', 'pelvis', { name: 'pouch', rigid: true }));

    const flap = P.prim.bevelSlab({
      w: m.hipWidth * 0.42,
      h: m.torsoLen * 0.13,
      d: m.hipWidth * 0.06,
      bevel: m.hipWidth * 0.03,
    });
    P.prim.place(flap, {
      pos: [-m.hipWidth * 0.66, y - m.torsoLen * 0.04, m.hipDepth * 0.28 - m.hipWidth * 0.1],
      rot: [0.2, 0, 0],
    });
    g.parts.push(P.mkPart(flap, 'leather', 'leather', 'pelvis', { name: 'pouchFlap', rigid: true }));
  }

  if (kit === 1 || kit === 2) {
    // A short knife, sheathed, tucked behind the right hip out of the weapon's
    // way. Small — it must never compete with the haft for the outline.
    const sheath = P.weapons.scabbard({
      grip: [m.hipWidth * 0.6, y + m.torsoLen * 0.06, m.hipDepth * 0.5],
      rot: [0.5, 0, -0.3],
      bone: 'pelvis',
      length: m.height * 0.15,
      width: m.height * 0.026,
      metalPigment: 'metal',
    });
    g.parts.push(...unifyMetal(sheath).parts);
  }

  return g;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

function buildSoldier(ctx: UnitBuildContext): PartGroup {
  const P = ctx.parts;
  const rng = ctx.rng;
  const han = ctx.side === Side.Red;
  const variant = ctx.variant;
  const m = ctx.rig.metrics;
  const g = P.emptyGroup();

  // --- per-variant knobs -------------------------------------------------
  // Five conscripts a side must not be five copies, and the differences have to
  // survive at the size the piece is actually seen: head, belt, plate wear.
  const beard: 'none' | 'short' = rng.chance(0.42) ? 'short' : 'none';
  const wrapOpen = variant % 2 === 1;
  const plateWear = variant % 3;
  const sashTail = m.torsoLen * (0.26 + 0.14 * (variant % 3));
  const helmTaper = 1 + rng.range(-0.06, 0.08);
  const shieldScale = 1 + rng.range(-0.08, 0.08);
  // 31° forward for the Han thrust, 32° back for the Chu shoulder carry. Both
  // are past the angle at which the haft stops reading as "vertical, roughly" —
  // that is the point of them.
  const rake = (han ? -0.55 : 0.56) + rng.range(-0.05, 0.05);

  // --- the carry, before any geometry exists -----------------------------
  // TWO HANDS OR ONE. The Han 兵 grips his 矛 with both, out and forward of the
  // right hip so the shaft clears the ribs in profile and the leading forearm
  // passes *in front of* the belly rather than through it. The Chu 卒 carries
  // his longer 戈 one-handed at the shoulder with the off arm swinging free:
  // that is how a 戈 is actually marched with, it separates the two armies by
  // arm silhouette as well as by haft angle, and it keeps a left elbow out of
  // the stomach — which is where a two-handed grip on a back-raked haft puts
  // it, whatever pole vector the IK is given.
  //
  // THE GRIP SITS WHERE IT BALANCES THE HAFT ABOUT THE FIGURE, not where the
  // hand looks most comfortable in isolation. A raked polearm is the longest
  // thing on a conscript by a wide margin, so it — not the body — decides where
  // the unit's bounding box is centred, and a box centred half a foot behind the
  // heels makes a figure standing squarely on its own intersection *measure* as
  // if it were leaning off it. Han's rear hand therefore closes just behind the
  // hip so the point runs forward and the butt trails back by the same amount;
  // Chu's closes in front of the hip so the 戈 head rides back over the shoulder
  // with the butt swung forward. Both keep the diagonal — it is the same angle —
  // and both put the figure in the middle of its own square.
  const twoHanded = han;
  const anchor = han
    ? new THREE.Vector3(m.hipWidth * 0.8, m.waistY - m.torsoLen * 0.24, m.hipDepth * 0.18)
    : new THREE.Vector3(m.hipWidth * 0.86, m.waistY + m.torsoLen * 0.16, -m.hipDepth * 0.34);
  const weaponLen = m.height * (han ? 0.86 : 0.95);
  const c = fitCarry(
    ctx.rig.bindWorld,
    m,
    rake,
    anchor,
    weaponLen,
    han ? 0.33 : 0.42,
    twoHanded ? m.armLen * 0.42 : 0,
  );
  const poles: { L: V3; R: V3 } = han
    ? { L: [-0.55, -0.5, -1.0], R: [0.45, -0.1, 1.0] }
    : { L: [-0.9, -0.6, -0.4], R: [0.5, -0.1, 1.0] };

  // --- install the pose ---------------------------------------------------
  const bore = m.height * (han ? 0.018 : 0.0155);
  const wristR = wristFor(c.gripR, c.pitch, m);
  const wristL = twoHanded
    ? wristFor(c.gripL, c.pitch, m)
    : // Free arm: a loose fist swinging just clear of the hip.
      new THREE.Vector3(-m.hipWidth * 0.62, m.hipY + m.torsoLen * 0.16, -m.hipDepth * 0.35);
  const rig = ctx.useRig({
    offsets: armOffsets(ctx.rig.bindWorld, m, { L: wristL, R: wristR }, poles),
  });
  const B = rig.bindWorld;

  // --- the figure ---------------------------------------------------------
  g.parts.push(
    P.body.torso({
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
      squareness: 0.5,
    }),
    P.body.neck({ fromY: m.shoulderY, toY: B.head.y + m.headLen * 0.08, r: m.neckR }),
  );
  const head = P.body.head({
    baseY: B.head.y,
    length: m.headLen,
    width: m.headWidth,
    depth: m.headDepth,
    z: B.head.z,
    beard,
    topknot: !han && wrapOpen,
  });
  g.parts.push(...head.parts);

  for (const S of ['L', 'R'] as const) {
    g.parts.push(
      ...P.body.arm({
        side: S,
        shoulder: v3(B[`upperArm${S}` as BoneName]),
        elbow: v3(B[`foreArm${S}` as BoneName]),
        wrist: v3(B[`hand${S}` as BoneName]),
        upperR: m.upperArmR,
        foreR: m.foreArmR,
        // The tunic sleeve ends above the elbow; forearms are bare.
        deltoid: true,
      }).parts,
      ...P.body.leg({
        side: S,
        hip: v3(B[`thigh${S}` as BoneName]),
        knee: v3(B[`shin${S}` as BoneName]),
        ankle: v3(B[`foot${S}` as BoneName]),
        thighR: m.thighR,
        shinR: m.shinR,
        ...(han ? {} : { cls: 'cloth' as const, pigment: 'cloth' as const }),
      }).parts,
      ...P.body.boot({
        side: S,
        ankle: v3(B[`foot${S}` as BoneName]),
        length: m.footLen,
        width: m.footLen * 0.42,
        shaft: han ? 0.16 : 0.52,
      }).parts,
    );
    const hand = posedHand(
      P,
      S,
      B[`hand${S}` as BoneName],
      S === 'R' || twoHanded ? c.pitch : 0.18,
      m,
      bore,
    );
    g.parts.push(...hand.parts);
    for (const k of Object.keys(hand.points)) g.points[k] = hand.points[k];
  }

  // --- what he wears ------------------------------------------------------
  // THE TUNIC STOPS ABOVE THE KNEE. A conscript's whole lower silhouette is two
  // legs, and legs are the only thing in this cast that make a base narrower
  // than the body above it — a hem that falls past the calf turns him into a
  // post whatever is modelled underneath. Everything below `hemY` is shin,
  // puttee and boot, and it is deliberately more than a third of his height.
  const hemY = m.hipY - m.legLen * (han ? 0.4 : 0.38);
  g.parts.push(
    P.cloth.skirt({
      topY: m.waistY + m.torsoLen * 0.04,
      hemY,
      rTop: m.waistWidth * 0.6,
      rHem: m.hipWidth * (han ? 0.84 : 0.9),
      squash: 0.82,
      folds: 8,
      foldDepth: 0.18,
      name: 'tunicSkirt',
    }),
  );

  if (han) {
    // 行縢 — puttees over bare shins, the marching conscript's leg. Wound
    // cloth, so they share the tunic's bucket rather than the boots'.
    for (const S of ['L', 'R'] as const) {
      g.parts.push(
        P.cloth.legWrap({
          side: S,
          knee: v3(B[`shin${S}` as BoneName]),
          ankle: v3(B[`foot${S}` as BoneName]),
          r: m.shinR,
          turns: 4,
          pigment: 'cloth',
        }),
      );
    }
  }

  const sash = P.cloth.sash({
    y: m.waistY,
    rx: m.waistWidth * 0.6,
    rz: m.waistDepth * 0.68,
    height: m.torsoLen * 0.12,
    tail: sashTail,
    knot: variant % 2 === 0,
  });
  g.parts.push(...sash.parts);
  g.parts.push(...beltKit(P, m, variant).parts);

  // --- armour -------------------------------------------------------------
  if (han) {
    // 札甲 — a knee-length lamellar vest. Torso rows split across the two spine
    // bones so the harness creases at the waist; the skirt rows ride the pelvis
    // and are cut away at the front so a stride goes through them.
    const rows = 4 - (variant % 2);
    const cuirass = P.lamellar.cuirass({
      fromY: m.waistY - m.torsoLen * 0.16,
      toY: m.shoulderY + m.torsoLen * 0.03,
      rx0: m.waistWidth * 0.62,
      rx1: m.chestWidth * 0.62,
      depthRatio: 0.76,
      rows,
      perRow: 13,
      cord: true,
      thickness: 0.11,
    });
    // The lacing cord defaults to the army accent, which would open a whole
    // material bucket for a few hundred triangles of cord; on a conscript it is
    // plain rawhide, so it joins the boots and straps instead.
    for (const inst of cuirass.instanced) if (inst.cls === 'leather') inst.pigment = 'leather';
    g.parts.push(...bakeBand(P, cuirass, 'cuirass', rng, plateWear));

    // The skirt flares hard: it is what turns the lower half from a slab into a
    // bell standing on two legs, and the flare is the difference between an
    // armoured man and a box with a head. It also ends *above* the tunic hem,
    // so the eye reads plate → cloth → bare shin → boot as three separate
    // horizontal breaks on the way down instead of one lacquered tube.
    const skirt = P.lamellar.skirtArmour({
      topY: m.waistY - m.torsoLen * 0.14,
      bottomY: m.hipY - m.legLen * 0.34,
      rxTop: m.hipWidth * 0.64,
      rxBottom: m.hipWidth * 1.26,
      depthRatio: 0.84,
      rows: 3,
      perRow: 14,
      frontGap: 0.62,
      cord: true,
    });
    for (const inst of skirt.instanced) if (inst.cls === 'leather') inst.pigment = 'leather';
    g.parts.push(...bakeBand(P, skirt, 'skirtArmour', rng, 0));

    // A shoulder strap over the cuirass, so the plates read as *worn* rather
    // than moulded, and one raised line breaks the flat chest under the ramp.
    g.parts.push(
      P.trim.piping({
        path: [
          [-m.chestWidth * 0.36, m.shoulderY + m.torsoLen * 0.02, -m.chestDepth * 0.2],
          [-m.chestWidth * 0.1, m.chestY - m.torsoLen * 0.06, -m.chestDepth * 0.62],
          [m.chestWidth * 0.22, m.waistY + m.torsoLen * 0.04, -m.chestDepth * 0.5],
        ],
        r: m.height * 0.009,
        boneHint: 'spine02',
        pigment: 'leather',
        cls: 'leather',
        name: 'harnessStrap',
      }),
    );
  } else {
    // 卒 — a quilted jerkin. The horizontal quilting is authored as alternating
    // ring radii: under a three-band cloth ramp each rib picks up its own band,
    // which is what makes padding read as padding instead of as a smooth tube.
    const rings: V3[][] = [];
    const steps = 8;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const y = m.hipY - m.legLen * 0.06 + (m.shoulderY + m.torsoLen * 0.05 - (m.hipY - m.legLen * 0.06)) * t;
      const rib = i % 2 === 0 ? 1.0 : 1.06;
      const rx = (m.hipWidth * 0.62 + (m.chestWidth * 0.64 - m.hipWidth * 0.62) * t) * rib;
      rings.push(
        P.prim.ring({ rx, rz: rx * 0.74, y, sides: 8, phase: Math.PI / 8, squareness: 0.5 }),
      );
    }
    g.parts.push(
      P.mkPart(P.prim.loft(rings, { capStart: false, capEnd: false, name: 'jerkin' }), 'cloth', 'cloth', 'spine01', {
        name: 'jerkin',
        allow: ['spine02', 'pelvis'],
      }),
    );

    // Two short rows of plates laced across the breast only — "fewer plates".
    const breast = P.lamellar.lamellarBand({
      rows: [0, 1].map((i) => ({
        y: m.chestY + m.torsoLen * (0.1 - i * 0.16),
        rx: m.chestWidth * 0.63,
        rz: m.chestWidth * 0.63 * 0.72,
        count: 7,
        arc: 2.0,
        tilt: -0.1,
        bone: (i === 0 ? 'spine02' : 'spine01') as BoneName,
      })),
      plate: {
        w: m.chestWidth * 0.2,
        h: m.torsoLen * 0.2,
        d: m.chestWidth * 0.02,
        bevel: m.chestWidth * 0.03,
        crown: m.chestWidth * 0.01,
      },
      boneHint: 'spine02',
      pigment: 'lacquer',
      cord: false,
      name: 'breastRow',
    });
    g.parts.push(...bakeBand(P, breast, 'breastRow', rng, plateWear));

    // A padded yoke over the shoulders — the jerkin's thickest section, and the
    // only place a 卒 carries any bulk at all. It squares off shoulders that
    // would otherwise slope straight into the neck.
    g.parts.push(
      P.mkPart(
        P.prim.loft(
          [
            P.prim.ring({ rx: m.neckR * 2.3, rz: m.neckR * 2.1, y: m.shoulderY + m.torsoLen * 0.1, sides: 8, phase: Math.PI / 8, squareness: 0.5 }),
            P.prim.ring({ rx: m.shoulderWidth * 0.5, rz: m.chestDepth * 0.62, y: m.shoulderY + m.torsoLen * 0.02, sides: 8, phase: Math.PI / 8, squareness: 0.56 }),
            P.prim.ring({ rx: m.shoulderWidth * 0.54, rz: m.chestDepth * 0.66, y: m.shoulderY - m.torsoLen * 0.1, sides: 8, phase: Math.PI / 8, squareness: 0.58 }),
            P.prim.ring({ rx: m.chestWidth * 0.66, rz: m.chestDepth * 0.7, y: m.shoulderY - m.torsoLen * 0.2, sides: 8, phase: Math.PI / 8, squareness: 0.54 }),
          ],
          { capStart: false, capEnd: false, name: 'jerkinYoke' },
        ),
        'cloth',
        'cloth',
        'spine02',
        { name: 'jerkinYoke', allow: ['clavicleL', 'clavicleR', 'neck'] },
      ),
    );

    // Padded flaps hanging from the belt, front and back: a 卒's whole lower
    // defence, and a hard horizontal break where the Han conscript has plates.
    for (const s of [-1, 1]) {
      const grid: V3[][] = [];
      for (let r = 0; r < 3; r++) {
        const t = r / 2;
        const y = m.waistY - m.torsoLen * 0.12 - m.legLen * 0.3 * t;
        const hw = m.hipWidth * (0.5 + t * 0.18);
        const z = s * m.hipDepth * (0.66 + t * 0.16);
        grid.push([
          [-hw, y, z],
          [-hw * 0.34, y - m.legLen * 0.02 * t, z * 1.04],
          [hw * 0.34, y - m.legLen * 0.02 * t, z * 1.04],
          [hw, y, z],
        ]);
      }
      g.parts.push(
        P.mkPart(P.prim.shell(grid, m.height * 0.008, { name: 'jerkinFlap', flip: s > 0 }), 'cloth', 'cloth', 'pelvis', {
          name: 'jerkinFlap',
          allow: ['spine01', 'thighL', 'thighR'],
        }),
      );
    }

    // Wound cloth on the forearms — a conscript's substitute for a bracer.
    for (const S of ['L', 'R'] as const) {
      g.parts.push(
        P.cloth.legWrap({
          side: S,
          knee: v3(B[`foreArm${S}` as BoneName]),
          ankle: v3(B[`hand${S}` as BoneName]),
          r: m.foreArmR * 1.06,
          turns: 3,
          pigment: 'cloth',
        }),
      );
      // legWrap() hints at the shin; these are on the arm.
      const wrap = g.parts[g.parts.length - 1];
      wrap.boneHint = `foreArm${S}` as BoneName;
      wrap.name = `armWrap${S}`;
    }

    // A crossed cord over the jerkin, tied at the sash.
    g.parts.push(
      P.trim.piping({
        path: [
          [-m.chestWidth * 0.4, m.shoulderY - m.torsoLen * 0.06, m.chestDepth * 0.1],
          [0, m.chestY - m.torsoLen * 0.1, -m.chestDepth * 0.66],
          [m.chestWidth * 0.4, m.shoulderY - m.torsoLen * 0.06, m.chestDepth * 0.1],
        ],
        r: m.height * 0.007,
        boneHint: 'spine02',
        pigment: 'accent',
        cls: 'cloth',
        name: 'jerkinCord',
      }),
    );
  }

  // --- head-dress ---------------------------------------------------------
  const crown = han
    ? hanCone(P, m, B.head.z, B.head.y, helmTaper, rng)
    : chuWrap(P, m, B.head.z, B.head.y, wrapOpen, rng);
  g.parts.push(...crown.parts);
  g.instanced.push(...crown.instanced);
  const crestPt = crown.points.crest;
  g.attach.push({ name: 'crest', bone: 'head', position: v3(crestPt) });

  // --- the weapon ---------------------------------------------------------
  const weapon = han
    ? P.weapons.spear({
        grip: v3(c.gripR),
        rot: [c.pitch, 0, 0],
        bone: 'handR',
        length: c.length,
        gripAt: c.gripAt,
        headLength: c.length * 0.19,
        shaftR: bore * 0.95,
        metalPigment: 'metal',
      })
    : P.weapons.ge({
        grip: v3(c.gripR),
        rot: [c.pitch, 0, 0],
        bone: 'handR',
        length: c.length,
        gripAt: c.gripAt,
        shaftR: bore * 0.95,
        // A long 援: the horizontal hook at the top of the shaft is the whole
        // reason a 戈 is recognisable, so it is cut generously.
        bladeLength: c.length * 0.3,
      });
  unifyMetal(weapon);
  g.parts.push(...weapon.parts);
  g.instanced.push(...weapon.instanced);
  const tip = weapon.points.tip;
  g.attach.push({ name: 'haftTip', bone: 'handR', position: v3(tip) });

  if (han) {
    const shield = squareShield(P, m, B.upperArmL, B.foreArmL, shieldScale);
    g.parts.push(...shield.parts);
  }

  return g;
}

registerUnit(PieceType.Soldier, buildSoldier);
