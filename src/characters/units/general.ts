/**
 * 帥 / 將 — the general, standing on his command dais.
 *
 * SILHOUETTE CONTRACT
 * -------------------
 * Three axes, and this unit owns the extreme of one of them: he is the tallest
 * *human* on the board, and the only figure standing on something. The read is
 *
 *     PLATFORM  →  a hard horizontal step under the feet that no other unit has
 *     CROWN     →  a tall crowned helm with 步搖 strands swinging beside the jaw
 *     STANDARD  →  a pole breaking the outline above and behind the shoulders
 *
 * All three survive a pure black render. The platform is the cheapest and the
 * strongest: at board distance every other piece's outline starts at the ground
 * and his starts 0.3 world units above it, which is a difference the eye reads
 * before it reads anything else. It is built here rather than in `scene/`
 * precisely so it can never be separated from him.
 *
 * TWO ARMIES
 * ----------
 * Han 帥 and Chu 將 share the `crowned-buyao` crown *tag* — that is a frozen
 * contract in `proportions.ts` — but nothing else about them is shared:
 *
 *   |            | Han 帥                        | Chu 將                        |
 *   |------------|-------------------------------|-------------------------------|
 *   | platform   | octagonal three-tier 壇, gold  | square two-tier plinth with   |
 *   |            | rim, wide and low             | corner cleats, taller, harder |
 *   | crown      | stepped tower + tall rear     | broad flat horn-wings sweeping|
 *   |            | plume — a narrow vertical     | out past the shoulders — a    |
 *   |            | spike                         | wide W                        |
 *   | mantle     | short shoulder cape           | heavy deep-fold mantle        |
 *   | cloak      | long scalloped-hem cloak      | swallow-tail cloak, notched   |
 *   | weapon     | 節 baton raked across the body| 長劍 point-down, guard coiled |
 *   | standard   | short 旌 pennant, raked back  | tall vertical 旗, swallowtail |
 *
 * The crown difference is the one that matters: a tower against a pair of
 * wings. Reduced to black, one is a vertical stroke and the other is a bar.
 *
 * POSE
 * ----
 * Both arms are posed in the **bind pose**, through `useRig({ offsets })`,
 * rather than left in the A-pose and rotated by a clip. Two reasons: the mesh
 * is then *built* in the pose the general stands in, so linear blend skinning
 * never has to carry a 90° shoulder; and the hand's grip bore genuinely lines up
 * with the haft it holds, because the fist geometry is rotated about its own
 * grip point to match the weapon's rotation (`rotateFist` below). A weapon that
 * floats beside a wrist is the first thing a motion critic names.
 */

import * as THREE from 'three';
import type { BoneName } from '@core/contracts.ts';
import { PieceType, Side } from '@core/types.ts';
import { registerUnit, type UnitBuildContext } from '@characters/factory.ts';
import type { Rig, RigOptions } from '@characters/rig.ts';
import { pinStatic, type Part, type PartGroup, type V2, type V3 } from '@characters/parts/types.ts';

// ---------------------------------------------------------------------------
// Local helpers — deliberately duplicated rather than shared. `units/` holds
// seven independent files and no `common.ts`; anything genuinely shared belongs
// in `../parts/`, which another author owns.
// ---------------------------------------------------------------------------

const v3 = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];

function mergeInto(dst: PartGroup, src: PartGroup, parts: UnitBuildContext['parts']): void {
  const merged = parts.mergeGroups(dst, src);
  dst.parts = merged.parts;
  dst.instanced = merged.instanced;
  dst.bones = merged.bones;
  dst.attach = merged.attach;
  dst.points = merged.points;
}

/** `a + b·t`, componentwise. */
function step(a: V3, b: V3, t: number): V3 {
  return [a[0] + b[0] * t, a[1] + b[1] * t, a[2] + b[2] * t];
}

function unit(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Rake of the Chu general's 劍 from vertical, radians. Shared between the fist
 * rotation and the sword placement — they have to agree or the blade grows out
 * of the side of the hand.
 */
const CHU_SWORD_TILT = 0.3;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function buildGeneral(ctx: UnitBuildContext): PartGroup {
  const P = ctx.parts;
  const han = ctx.side === Side.Red;
  const h = ctx.spec.proportions.height;
  const g = P.emptyGroup();

  // --- 1. the dais --------------------------------------------------------
  // Built first because its height is the rig's origin: everything else is
  // authored relative to a skeleton whose feet stand on the top step.
  //
  // NARROW AND TALL, NOT WIDE AND LOW. The dais used to be 0.74 world units
  // across — three quarters of a board square, wider than the cloak above it and
  // wider than the scene's own plinth. That made the widest thing in the whole
  // silhouette a disc lying on the floor, which is the definition of a bollard:
  // the outline is at its fattest where it meets the board and tapers upward
  // from there, so the eye reads a post with a head rather than a man in a
  // cloak. It is now a pedestal — the step under the feet is what carries the
  // read, and a step reads from its *height* above the board, not its width.
  //
  // IT IS FURNITURE, NOT ANATOMY, so every piece of it is pinned to
  // `STATIC_BONE` — the one bone that hangs off the unit root instead of off
  // the skeleton. Bound to `root` (the obvious choice, and the wrong one) it
  // followed the bone every clip writes its authored root translation to: the
  // death collapse drops that bone 238 mm, and the general died on a dais that
  // had sunk 194 mm through the board with him. A platform a man stands on does
  // not fall when he does.
  const platformTop = han ? h * 0.27 : h * 0.3;
  mergeInto(g, pinStatic(han ? hanDais(ctx, h, platformTop) : chuPlinth(ctx, h, platformTop)), P);

  // --- 2. the rig, lifted and posed ---------------------------------------
  // Two builds: the first to read the A-pose joint positions, the second with
  // the command pose baked in as bind-pose offsets. Two rig builds cost a
  // fraction of a millisecond and save hard-coding joint positions we cannot
  // know until the proportions are resolved.
  const origin: [number, number, number] = [0, platformTop, 0];
  const rig0 = ctx.useRig({ origin });
  const rig = ctx.useRig({ origin, offsets: commandPose(rig0, han) });
  const m = rig.metrics;
  const B = rig.bindWorld;

  // --- 3. the figure ------------------------------------------------------
  // No deltoid caps: the pauldrons sit exactly there and two overlapping
  // shoulder volumes read as a lump under a quantised ramp.
  const fig = P.body.figure({
    metrics: m,
    bind: B,
    torsoPigment: 'cloth',
    torsoCls: 'cloth',
    bootShaft: 0.34,
    beard: 'long',
    deltoid: false,
    handPose: 'fist',
  });

  // Rotate each fist about its own grip so the bore lines up with what it holds.
  // The bore is a cylinder and therefore bidirectional, so a point-down sword
  // wants the same fist rotation as a point-up one: `sword({ reversed })` adds
  // the half-turn itself, and adding it here too would twist the hand off the
  // hilt for no visible gain.
  // The Han 節 leans across the body (Z) but no longer forward (X). A staff
  // pitched forward puts its head half a rig unit in front of the chest at crown
  // height, which is exactly the band the taper contract measures the *narrow*
  // end of the cone in — and a cone with a wide top is not a cone.
  const rHold: V3 = han ? [0.06, 0, 0.52] : [CHU_SWORD_TILT, 0, 0.06];
  const lHold: V3 = han ? [0.3, 0, -0.2] : [0.12, 0, -0.12];
  rotateFist(fig, 'R', rHold);
  rotateFist(fig, 'L', lHold);
  mergeInto(g, fig, P);

  const gripR = fig.points.gripR ?? B.handR;
  const gripL = fig.points.gripL ?? B.handL;

  // --- 4. cloth under the harness -----------------------------------------
  // robe = 0.6: an above-the-knee under-robe, visible below the armoured skirt
  // and clear of the greaves. Three hard horizontals stack down the leg —
  // plate skirt, robe hem, cloak hem — and below the last of them the outline is
  // two greaved shins and two boots on a narrow pedestal.
  const hemY = m.hipY - m.legLen * 0.44;
  g.parts.push(
    P.cloth.skirt({
      topY: m.waistY + m.torsoLen * 0.02,
      hemY,
      rTop: m.waistWidth * 0.62,
      rHem: m.hipWidth * 1.22,
      squash: 0.84,
      folds: 11,
      foldDepth: 0.19,
    }),
  );
  mergeInto(
    g,
    P.cloth.sash({
      y: m.waistY,
      rx: m.waistWidth * 0.6,
      rz: m.waistDepth * 0.68,
      height: m.torsoLen * 0.14,
      tail: m.torsoLen * 0.72,
    }),
    P,
  );

  // The mantle 披風 over the shoulders. Han's is a short collar cape that stops
  // above the pauldrons; Chu's is heavier and reaches the top of the arm.
  //
  // Both are deliberately kept *shorter than the pauldrons are wide*. A cape
  // whose hem radius exceeds the shoulder by much drapes over the whole harness
  // and the figure turns into a bell: the lamellar disappears, the arms
  // disappear, and a general built from four hundred plates reads as a lampshade
  // with a hat on. The mantle's job is one soft horizontal at the collarbone,
  // not a garment.
  g.parts.push(
    P.cloth.shoulderCape({
      shoulderY: m.shoulderY + m.torsoLen * (han ? 0.05 : 0.07),
      r: m.shoulderWidth * (han ? 0.62 : 0.78),
      drop: m.torsoLen * (han ? 0.24 : 0.36),
      folds: han ? 9 : 6,
    }),
  );

  // The cloak. This is most of what makes the general wider than everyone else
  // without making him fat, and the two armies cut it differently.
  //
  // It is also THE cone. `proportions.ts` contracts a taper of 1.9 for this unit
  // — silhouette width at a quarter of the height against width at three
  // quarters — and the only thing on a general that can be twice as wide at the
  // knee as at the crown is the cloak. So its hem is thrown wide and stopped at
  // the knee: wide enough to be the widest thing on the piece by a clear margin,
  // high enough that the two legs and the pedestal are still visible under it.
  // Its backward sweep is deliberately restrained, because a cloak that reaches
  // further behind the figure than the hem reaches sideways moves the bounding
  // box off the man and puts the pedestal back at the edge of it.
  if (han) {
    g.parts.push(
      P.cloth.cloak({
        shoulderY: m.shoulderY + m.torsoLen * 0.06,
        hemY: m.hipY - m.legLen * 0.5,
        rTop: m.shoulderWidth * 0.62,
        rHem: m.shoulderWidth * 2.0,
        z: m.chestDepth * 0.16,
        folds: 7,
        foldDepth: 0.12,
        flare: 0.04,
      }),
    );
  } else {
    g.parts.push(swallowtailCloak(ctx, rig, platformTop));
  }

  // --- 5. lamellar --------------------------------------------------------
  dressHarness(g, ctx, rig, han);

  // --- 6. head ------------------------------------------------------------
  const helm = P.helmet.helmet({
    style: 'crownedHelm',
    baseY: B.head.y,
    headLen: m.headLen,
    headWidth: m.headWidth,
    headDepth: m.headDepth,
    z: B.head.z,
    cheeks: true,
    nape: true,
    rivets: true,
  });
  mergeInto(g, helm, P);

  const crestAt = v3(helm.points.crest);
  const anchors: [V3, V3] = [v3(helm.points.buyaoL), v3(helm.points.buyaoR)];
  mergeInto(
    g,
    P.helmet.crest({
      style: 'buyao',
      at: crestAt,
      height: m.headLen * ctx.spec.design.crown.crestScale,
      width: m.headWidth * 0.6,
      anchors,
    }),
    P,
  );
  // The per-army crown superstructure: a spike or a bar.
  mergeInto(g, han ? rearPlume(ctx, crestAt, m.headLen, m.headWidth) : hornWings(ctx, crestAt, m.headLen, m.headWidth), P);

  // --- 7. arms: what each hand actually holds -----------------------------
  armKit(g, ctx, rig, han, gripR, gripL, platformTop, rHold, lHold);

  // --- 8. the standard at the back ----------------------------------------
  backStandard(g, ctx, rig, han);

  return g;
}

// ---------------------------------------------------------------------------
// The dais
// ---------------------------------------------------------------------------

/**
 * 壇 — the Han command dais: three octagonal steps under a gold rim, wide and
 * low. Octagonal rather than round because a lathe at eight facets gives eight
 * flat planes, and a quantised ramp puts each of them in a different band; a
 * cylinder would give one band all the way round and read as a drum.
 *
 * The `'root'` bone hints below are for material grouping only: the caller runs
 * the whole group through `pinStatic`, which rebinds every piece of it to the
 * unit root so no clip can move it. See the note at the call site.
 */
function hanDais(ctx: UnitBuildContext, h: number, top: number): PartGroup {
  const P = ctx.parts;
  const g = P.emptyGroup();
  // Sized to sit *inside* the cloak's hem, not outside it. See `platformTop`.
  const r = h * 0.245;
  const phase = Math.PI / 8;

  // Bottom step in plain timber, the two above it in army lacquer: the value
  // break at the second step is what stops the dais reading as one block.
  const plinth = P.prim.hardLathe(
    [
      [r * 1.0, 0],
      [r * 1.0, top * 0.24],
      [r * 0.93, top * 0.3],
    ],
    8,
    { phase, capStart: false, name: 'daisPlinth' },
  );
  g.parts.push(P.mkPart(plinth, 'timber', 'ochre', 'root', { name: 'daisPlinth', rigid: true }));

  const body = P.prim.hardLathe(
    [
      [r * 0.93, top * 0.28],
      [r * 0.93, top * 0.56],
      [r * 0.84, top * 0.62],
      [r * 0.84, top * 0.9],
      [r * 0.78, top * 0.94],
      [r * 0.78, top],
    ],
    8,
    { phase, capStart: false, name: 'dais' },
  );
  g.parts.push(P.mkPart(body, 'lacquer', 'lacquer', 'root', { name: 'dais', rigid: true }));

  // Gold rim around the top step, and studs around the middle one.
  const rim = P.prim.ring({ rx: r * 0.795, y: top * 0.965, sides: 8, phase });
  g.parts.push(
    P.trim.piping({
      path: [...rim, rim[0]],
      r: h * 0.0095,
      boneHint: 'root',
      name: 'daisRim',
    }),
  );
  mergeInto(
    g,
    P.rivets.rivetArc({
      centre: [0, top * 0.44, 0],
      // On the face of the middle step, not proud of the plinth below it: the
      // studs must never be the widest thing on the piece.
      rx: r * 0.86,
      rz: r * 0.86,
      count: 8,
      arcCentre: -Math.PI / 2,
      boneHint: 'root',
      rivet: { r: h * 0.016, h: h * 0.011 },
      name: 'daisStuds',
    }),
    P,
  );
  return g;
}

/**
 * The Chu plinth: two square steps with four corner cleats standing proud of
 * the top. Square in plan, so from any angle its outline has corners where the
 * Han dais has facets — and the cleats put four small verticals at the base of
 * a figure whose Han counterpart has none.
 *
 * As with `hanDais`, the `'root'` bone hints are for material grouping only —
 * `pinStatic` at the call site rebinds the whole group to the unit root.
 */
function chuPlinth(ctx: UnitBuildContext, h: number, top: number): PartGroup {
  const P = ctx.parts;
  const g = P.emptyGroup();
  const hw = h * 0.235;
  const hd = hw * 0.94;

  const box = P.prim.loft(
    [
      P.prim.rectRing(hw, hd, 0),
      P.prim.rectRing(hw, hd, top * 0.26),
      P.prim.rectRing(hw * 0.9, hd * 0.9, top * 0.32),
      P.prim.rectRing(hw * 0.9, hd * 0.9, top * 0.86),
      P.prim.rectRing(hw * 0.84, hd * 0.84, top * 0.92),
      P.prim.rectRing(hw * 0.84, hd * 0.84, top),
    ],
    { capStart: false, name: 'plinth' },
  );
  g.parts.push(P.mkPart(box, 'lacquer', 'lacquer', 'root', { name: 'plinth', rigid: true }));

  const base = P.prim.loft(
    [P.prim.rectRing(hw * 1.06, hd * 1.06, 0), P.prim.rectRing(hw * 1.06, hd * 1.06, top * 0.1)],
    { capStart: false, name: 'plinthBase' },
  );
  g.parts.push(P.mkPart(base, 'timber', 'ochre', 'root', { name: 'plinthBase', rigid: true }));

  // Corner cleats: bronze angle-brackets standing above the top surface.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cleat = P.prim.bevelSlab({
        w: hw * 0.2,
        h: top * 0.42,
        d: hd * 0.2,
        bevel: top * 0.05,
        name: 'cleat',
      });
      P.prim.place(cleat, {
        pos: [sx * hw * 0.76, top * 1.02, sz * hd * 0.76],
        rot: [0, sx * sz * 0.22, 0],
      });
      g.parts.push(P.mkPart(cleat, 'gold', 'metal', 'root', { name: 'plinthCleat', rigid: true }));
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Pose
// ---------------------------------------------------------------------------

/**
 * Bind-pose offsets that put both arms in the command pose.
 *
 * Targets are expressed as *directions* out of the shoulder rather than as
 * absolute joint positions, and scaled by the rig's own `upperArmLen` and
 * `foreArmLen`, so the posed bones keep their bind lengths exactly. That
 * matters: the animator normalises clips against `rig.bindLengths`, and a bind
 * pose that quietly shortened an upper arm would retarget every clip wrong.
 *
 * Directions are written for the RIGHT arm with +X meaning *outward from the
 * body*; the left arm mirrors X. Offsets are deltas from the A-pose, and the
 * hand's delta has the elbow's subtracted out because `RigOptions.offsets`
 * moves a bone together with everything under it.
 */
function commandPose(rig: Rig, han: boolean): NonNullable<RigOptions['offsets']> {
  const m = rig.metrics;
  const B = rig.bindWorld;
  const out: NonNullable<RigOptions['offsets']> = {};

  // [upper-arm direction, forearm direction] per side.
  // Both elbows carry a forward component. Without it the forearm alone has to
  // cover the whole distance from a shoulder at z = 0 to a hand clear of the
  // chest, and a general in a six-row cuirass has 0.15 rig units of lamellar in
  // front of his sternum: the hand ends up *inside* his own armour and whatever
  // it holds grows out of his ribs.
  const dirs: Record<'L' | 'R', [V3, V3]> = han
    ? {
        // Right hand carries the 節 up across the chest; the left rests on the
        // sword hilt at the hip. Asymmetric on purpose — a symmetric commander
        // reads as a statue.
        R: [
          [-0.14, -0.92, -0.36],
          [-0.26, 0.3, -0.92],
        ],
        L: [
          [0.12, -0.94, -0.3],
          [-0.04, -0.6, -0.8],
        ],
      }
    : {
        // Chu: elbows pinned in at the ribs, both hands low and close. He
        // strikes at contact range, so the guard is coiled rather than extended.
        R: [
          [-0.28, -0.84, -0.36],
          [-0.24, -0.2, -0.94],
        ],
        L: [
          [-0.24, -0.9, -0.3],
          [0.14, -0.66, -0.74],
        ],
      };

  for (const S of ['L', 'R'] as const) {
    const s = S === 'L' ? -1 : 1;
    const [u0, f0] = dirs[S];
    const up = unit([u0[0] * s, u0[1], u0[2]]);
    const fw = unit([f0[0] * s, f0[1], f0[2]]);
    const shoulder = v3(B[`upperArm${S}`]);
    const elbow = step(shoulder, up, m.upperArmLen);
    const wrist = step(elbow, fw, m.foreArmLen);

    const e0 = B[`foreArm${S}`];
    const w0 = B[`hand${S}`];
    const dE: V3 = [elbow[0] - e0.x, elbow[1] - e0.y, elbow[2] - e0.z];
    out[`foreArm${S}` as BoneName] = dE;
    out[`hand${S}` as BoneName] = [
      wrist[0] - w0.x - dE[0],
      wrist[1] - w0.y - dE[1],
      wrist[2] - w0.z - dE[2],
    ];
  }
  return out;
}

/** The six geometries `body.hand()` emits, in build order. */
const FIST_PIECES = ['palm', 'fingers', 'fistCapT', 'fistCapB', 'fistBore', 'thumb'] as const;

/**
 * Rotate one fist about its own published grip point.
 *
 * `body.hand({ pose: 'fist' })` bores a grip cylinder along +Y, and every
 * weapon in `parts/weapons.ts` is authored haft-along-+Y through its grip. A
 * weapon placed at the grip and then rotated no longer runs down that bore —
 * unless the fist is rotated with it, which is what this does. The pivot is the
 * grip itself, so the published point does not move and the weapon still
 * attaches at exactly the same place.
 */
function rotateFist(fig: PartGroup, side: 'L' | 'R', rot: V3): void {
  const grip = fig.points[`grip${side}`];
  if (!grip) return;
  const m = new THREE.Matrix4()
    .makeTranslation(grip.x, grip.y, grip.z)
    .multiply(
      new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ')),
    )
    .multiply(new THREE.Matrix4().makeTranslation(-grip.x, -grip.y, -grip.z));
  const wanted = new Set(FIST_PIECES.map((n) => `${n}${side}`));
  for (const p of fig.parts) {
    if (p.name && wanted.has(p.name)) p.geometry.applyMatrix4(m);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * armour = 1.0 — the full harness: cuirass, armoured skirt, pauldrons, bracers,
 * greaves and a standing plate collar. Rows are split across two spine bones so
 * the harness creases where the torso does.
 */
function dressHarness(g: PartGroup, ctx: UnitBuildContext, rig: Rig, han: boolean): void {
  const P = ctx.parts;
  const m = rig.metrics;
  const B = rig.bindWorld;

  // Both armies' lacing runs through one `leather|accent` bucket — the cord is
  // shared with the armoured skirt, so it costs one draw call for the whole
  // harness rather than one per band.
  mergeInto(
    g,
    P.lamellar.cuirass({
      fromY: m.waistY - m.torsoLen * 0.16,
      toY: m.shoulderY + m.torsoLen * 0.03,
      rx0: m.waistWidth * 0.6,
      rx1: m.chestWidth * 0.62,
      depthRatio: 0.74,
      rows: han ? 6 : 7,
      perRow: han ? 15 : 13,
      cord: true,
      thickness: 0.1,
    }),
    P,
  );

  mergeInto(
    g,
    P.lamellar.skirtArmour({
      topY: m.waistY - m.torsoLen * 0.12,
      bottomY: m.hipY - m.legLen * 0.34,
      rxTop: m.hipWidth * 0.66,
      rxBottom: m.hipWidth * 0.94,
      depthRatio: 0.82,
      rows: 3,
      perRow: 17,
      frontGap: 0.52,
      cord: true,
    }),
    P,
  );

  for (const S of ['L', 'R'] as const) {
    mergeInto(
      g,
      // Twenty plates, not twenty-four: the factory bakes an instance set below
      // twenty-four into the mesh it shares a material with, and an InstancedMesh
      // at that size costs a draw call to save nothing.
      P.lamellar.pauldron({
        side: S,
        shoulder: v3(B[`upperArm${S}`]),
        r: m.upperArmR * (han ? 3.0 : 2.7),
        rows: 4,
        perRow: 5,
      }),
      P,
    );
    mergeInto(
      g,
      P.lamellar.tubeArmour({
        bone: `foreArm${S}` as BoneName,
        from: v3(B[`foreArm${S}`]),
        to: v3(B[`hand${S}`]),
        r: m.foreArmR * 1.6,
        rows: 2,
        perRow: 7,
        arc: Math.PI * 1.45,
        facing: S === 'L' ? -1 : 1,
      }),
      P,
    );
    mergeInto(
      g,
      P.lamellar.tubeArmour({
        bone: `shin${S}` as BoneName,
        from: v3(B[`shin${S}`]),
        to: v3(B[`foot${S}`]),
        r: m.shinR * 1.75,
        rows: 3,
        perRow: 7,
        arc: Math.PI * 1.2,
        facing: S === 'L' ? -1 : 1,
      }),
      P,
    );
  }

  mergeInto(
    g,
    P.lamellar.neckGuard({
      y: m.shoulderY + m.torsoLen * 0.03,
      r: m.neckR * 2.7,
      height: m.neckLen * 0.66,
      count: 12,
    }),
    P,
  );

  // Piping down the front edge of the cuirass and a rank plaque on the belt.
  // Eighty triangles, and it stops the largest flat run on the figure from
  // sitting in a single band of the ramp.
  const zf = -m.chestDepth * 0.5;
  g.parts.push(
    P.trim.piping({
      path: [
        [0, m.shoulderY + m.torsoLen * 0.02, zf * 0.86],
        [0, m.chestY, zf * 1.02],
        [0, m.waistY - m.torsoLen * 0.1, zf * 0.94],
      ],
      r: m.chestWidth * 0.022,
      boneHint: 'spine01',
      name: 'cuirassPiping',
    }),
  );
  g.parts.push(
    P.trim.plaque({
      at: [0, m.waistY, -m.waistDepth * 0.76],
      w: m.waistWidth * 0.34,
      h: m.torsoLen * 0.13,
      d: m.waistDepth * 0.06,
      boneHint: 'pelvis',
      rot: [0.08, 0, 0],
    }),
  );
}

// ---------------------------------------------------------------------------
// Crown superstructure
// ---------------------------------------------------------------------------

/**
 * The Han 帥's rear plume: a tall horsehair blade rising off the crown and
 * raking backward. It is the piece that turns the crowned helm from a tower
 * into a *spike with a tail*, and it is the top of his silhouette.
 */
function rearPlume(ctx: UnitBuildContext, at: V3, headLen: number, headWidth: number): PartGroup {
  const P = ctx.parts;
  const g = P.emptyGroup();
  // Sized against the head, not against the helmet: a crest that is merely
  // "taller than the bowl" vanishes at board distance, and this one has to be
  // the top of the tallest human silhouette on the board.
  const H = headLen * 1.95;
  const W = headWidth * 0.66;
  const rows = 6;
  const grid: V3[][] = [];
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    // Widens through the middle then tapers; rakes backward (+Z) quadratically.
    const w = W * (0.3 + Math.sin(t * Math.PI) * 0.78) * (1 - t * 0.42);
    const y = at[1] + H * (t * 0.98 - t * t * 0.12);
    const z = at[2] + H * t * t * 0.46;
    grid.push([
      [at[0] - w, y, z - w * 0.34],
      [at[0], y, z + w * 0.16],
      [at[0] + w, y, z - w * 0.34],
    ]);
  }
  g.parts.push(
    P.mkPart(P.prim.shell(grid, W * 0.17, { name: 'plume' }), 'hair', 'ink', 'head', {
      name: 'rearPlume',
      rigid: true,
      noSilk: true,
    }),
  );
  // Gilt collar at the socket, so the plume is seated rather than growing.
  const collar = P.prim.hardLathe(
    [
      [W * 0.44, at[1] - H * 0.03],
      [W * 0.58, at[1] + H * 0.05],
      [W * 0.38, at[1] + H * 0.11],
    ],
    6,
    { capStart: false, capEnd: false, name: 'plumeCollar' },
  );
  collar.translate(at[0], 0, at[2]);
  g.parts.push(P.mkPart(collar, 'gold', 'metal', 'head', { name: 'plumeCollar', rigid: true }));
  return g;
}

/**
 * The Chu 將's horned crown: two broad flat wings sweeping out and up past the
 * temples, after the antlered 鎮墓獸 tomb guardians of the Chu state.
 *
 * They are *flat blades*, not round horns, and they are wide — together they
 * span more than the shoulders. That is the entire point: reduced to black, the
 * Han general is a vertical stroke and the Chu general is a bar. Two units
 * wearing the same crown tag can still be told apart at a glance, which is what
 * "two armies, not one army in two colours" has to mean at silhouette size.
 */
function hornWings(ctx: UnitBuildContext, at: V3, headLen: number, headWidth: number): PartGroup {
  const P = ctx.parts;
  const g = P.emptyGroup();
  const H = headLen * 1.7;
  // Wide enough to reach past the pauldrons. This number *is* the silhouette:
  // half of headWidth would give a pair of bumps that read as noise on the
  // helmet, and the Chu general would collapse into the Han one.
  const W = headWidth * 3.0;
  // Sprung from the coronet line, not the apex of the tower, so the wings frame
  // the crown instead of balancing on it.
  const base: V3 = [at[0], at[1] - headLen * 0.92, at[2]];

  // Outline in XY: a swept blade with two forward-hooking tines off the top
  // edge, so the wing has notches in it rather than a clean arc.
  const poly: V2[] = [
    [0, -H * 0.14],
    [W * 0.3, -H * 0.02],
    [W * 0.52, H * 0.2],
    [W * 0.6, H * 0.5],
    [W * 0.46, H * 0.42],
    [W * 0.55, H * 0.78],
    [W * 0.38, H * 0.62],
    [W * 0.34, H * 0.9],
    [W * 0.22, H * 0.48],
    [W * 0.07, H * 0.18],
    [0, H * 0.1],
  ];
  const right = P.prim.extrudePlanar(poly, {
    depth: headWidth * 0.1,
    chamfer: headWidth * 0.024,
    name: 'hornWing',
  });
  // Stand it up across the head and rake it back a little.
  P.prim.place(right, { pos: base, rot: [0.24, 0, 0] });
  g.parts.push(P.mkPart(right, 'gold', 'metal', 'head', { name: 'hornWingR', rigid: true }));
  g.parts.push(
    P.mkPart(P.prim.mirrorX(right), 'gold', 'metal', 'head', { name: 'hornWingL', rigid: true }),
  );

  // A lacquered crown board between the wings, tying them to the helm.
  const board = P.prim.bevelSlab({
    w: headWidth * 0.62,
    h: headLen * 0.42,
    d: headWidth * 0.38,
    bevel: headWidth * 0.06,
    name: 'crownBoard',
  });
  P.prim.place(board, { pos: [base[0], base[1] + headLen * 0.3, base[2]], rot: [0.16, 0, 0] });
  g.parts.push(P.mkPart(board, 'lacquer', 'lacquer', 'head', { name: 'crownBoard', rigid: true }));
  return g;
}

// ---------------------------------------------------------------------------
// Cloak
// ---------------------------------------------------------------------------

/**
 * 燕尾 — the Chu swallow-tail cloak. Same construction as `cloth.cloak` (hard
 * authored fold planes, no smooth sheet) with one change that is worth its own
 * function: the hem is notched, so the centre-back rises and the two outer
 * corners fall into points. Han flies square pennants and wears a straight hem;
 * Chu notches both. Behind the figure, where the Han cloak gives a flat bar the
 * Chu cloak gives a V, and that reads in a shadow pass as well as a lit one.
 */
function swallowtailCloak(ctx: UnitBuildContext, rig: Rig, platformTop: number): Part {
  const P = ctx.parts;
  const m = rig.metrics;
  const shoulderY = m.shoulderY + m.torsoLen * 0.08;
  // The centre-back of the notch, not the lowest point: the two corners hang a
  // quarter of the drop below this. Both stay clear of the knee, so the greaves
  // and boots are still the bottom of the silhouette.
  const hemY = m.hipY - m.legLen * 0.42;
  const drop = shoulderY - hemY;
  const rTop = m.shoulderWidth * 0.64;
  const rHem = m.shoulderWidth * 2.05;
  const z0 = m.chestDepth * 0.2;

  const rows = 5;
  const folds = 6;
  const cols = folds * 2 + 1;
  const grid: V3[][] = [];
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const rr = rTop + (rHem - rTop) * t;
    const row: V3[] = [];
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      const a = (u - 0.5) * Math.PI * 0.98;
      const fold = (c % 2 === 0 ? 1 : -1) * 0.24 * rr * t;
      // Swallowtail: |u-0.5| drives the hem DOWN, so the centre back lifts into
      // a notch and the outer corners hang into two points. Those two corners
      // are also the widest pair of vertices on the whole figure, so where they
      // land vertically is what the taper measurement reads as the bottom of the
      // cone — they are deliberately dropped into the lower quarter of the
      // silhouette rather than left level with the notch.
      const tail = (1 - Math.pow(1 - Math.abs(u - 0.5) * 2, 1.6)) * drop * 0.24;
      const y = shoulderY - drop * t - tail * t * t;
      row.push([Math.sin(a) * rr, y, z0 + Math.cos(a) * rr * 0.44 + fold + t * t * drop * 0.08]);
    }
    grid.push(row);
  }
  const geo = P.prim.shell(grid, rTop * 0.032, { name: 'swallowtailCloak' });
  return P.mkPart(geo, 'cloth', 'cloth', 'spine02', {
    name: 'cloak',
    allow: ['spine01', 'pelvis', 'clavicleL', 'clavicleR'],
  });
}

// ---------------------------------------------------------------------------
// Weapons and kit
// ---------------------------------------------------------------------------

function armKit(
  g: PartGroup,
  ctx: UnitBuildContext,
  rig: Rig,
  han: boolean,
  gripR: THREE.Vector3,
  gripL: THREE.Vector3,
  platformTop: number,
  rHold: V3,
  lHold: V3,
): void {
  const P = ctx.parts;
  const m = rig.metrics;
  const B = rig.bindWorld;
  const h = m.height;

  if (han) {
    // 節 — the staff of authority, raked across the body so it crosses the
    // cuirass diagonally. Length is chosen so the butt clears the dais.
    const L = h * 0.86;
    const gripAt = 0.32;
    const w = P.weapons.baton({
      grip: v3(gripR),
      rot: rHold,
      bone: 'handR',
      length: L,
      gripAt,
      shaftR: h * 0.017,
      tiers: 3,
    });
    const tip = w.points.tip.clone();
    mergeInto(g, w, P);
    g.attach.push({ name: 'haftTip', bone: 'handR', position: [tip.x, tip.y, tip.z] });
  } else {
    // 長劍 held point-down and raked forward. The blade length is *solved* from
    // the drop available above the plinth rather than fixed, so the point rests
    // just clear of the top step whatever the per-variant proportion jitter
    // does — a sword whose point disappears into the plinth on one of the two
    // generals is exactly the kind of thing a fixed length produces.
    const clearance = h * 0.045;
    const reach = 1.144; // grip centre → point, in blade lengths (see weapons.sword)
    const drop = Math.max(h * 0.2, gripR.y - platformTop - clearance);
    const L = Math.min(h * 0.5, drop / (reach * Math.cos(CHU_SWORD_TILT)));
    const w = P.weapons.sword({
      grip: v3(gripR),
      rot: [CHU_SWORD_TILT, 0, rHold[2]],
      bone: 'handR',
      length: L,
      halfWidth: h * 0.028,
      reversed: true,
    });
    const tip = w.points.tip.clone();
    mergeInto(g, w, P);
    g.attach.push({ name: 'haftTip', bone: 'handR', position: [tip.x, tip.y, tip.z] });
  }

  // 劍 at the left hip. Han's hand rests on it; Chu's is the empty scabbard the
  // sword in his hand came out of, so it hangs further back and steeper.
  const hipAt: V3 = han
    ? [gripL.x + m.handR * 0.2, gripL.y + m.handLen * 0.42, gripL.z + m.handR * 0.9]
    : [B.pelvis.x - m.hipWidth * 0.72, B.pelvis.y + m.torsoLen * 0.04, B.pelvis.z + m.hipDepth * 0.34];
  mergeInto(
    g,
    P.weapons.scabbard({
      grip: hipAt,
      // Han's hangs on the axis his left fist is turned to, so the hilt runs
      // through the bore and the hand is genuinely resting on it.
      rot: han ? [lHold[0], 0, lHold[2]] : [0.34, 0, 0.42],
      bone: 'pelvis',
      length: h * (han ? 0.3 : 0.28),
      width: h * 0.034,
    }),
    P,
  );
  g.attach.push({ name: 'hip', bone: 'pelvis', position: hipAt });

  if (han) {
    // Han's left hand closes on the hilt: give it a real grip to close on.
    const hilt = P.prim.prism({
      rx0: h * 0.017,
      rz0: h * 0.013,
      y0: 0,
      y1: h * 0.11,
      sides: 8,
      phase: Math.PI / 8,
      squareness: 0.4,
      name: 'hipHilt',
    });
    P.prim.place(hilt, { pos: hipAt, rot: [lHold[0], 0, lHold[2]] });
    g.parts.push(
      P.mkPart(hilt, 'leather', 'leather', 'pelvis', { name: 'hipHilt', rigid: true }),
    );
  }
}

/**
 * The standard socketed at the back. Han's is a short 旌 raked back over the
 * right shoulder; Chu's is a tall vertical 旗 with a swallow-tailed fly. Both
 * break the outline above the shoulder line, which is the third silhouette cue
 * after the platform and the crown.
 */
function backStandard(g: PartGroup, ctx: UnitBuildContext, rig: Rig, han: boolean): void {
  const P = ctx.parts;
  const m = rig.metrics;
  const B = rig.bindWorld;
  const h = m.height;

  const at: V3 = [
    B.spine02.x + (han ? m.chestWidth * 0.4 : 0),
    B.spine02.y - m.torsoLen * (han ? 0.2 : 0.3),
    B.spine02.z + m.chestDepth * (han ? 0.58 : 0.7),
  ];
  g.attach.push({ name: 'back', bone: 'spine02', position: at });

  mergeInto(
    g,
    P.standard.standard({
      shape: han ? 'hanSquare' : 'chuSwallowtail',
      base: at,
      // Han's 旌 is deliberately the smaller of the two: his silhouette already
      // spends its height on the plume, and a banner big enough to compete with
      // the crown turns the commander into a standard-bearer.
      poleLength: h * (han ? 0.72 : 0.78),
      // A SHAFT HAS TO SURVIVE THE RASTERISER. At h*0.014 the pole was about
      // 0.010 world units thick — one pixel and a bit at the default camera —
      // while the shadow it casts is a solid dark line two or three pixels wide,
      // so on a captured still the banner floated over its own shadow with
      // nothing holding it up. This is the width at which the lit shaft is
      // wider than the shadow under it and reads as a pole. It is also why the
      // pole is hexagonal rather than round: at this size the facet break down
      // its length is what tells the eye it is a solid object and not a line.
      poleR: h * 0.03,
      bannerHeight: h * (han ? 0.21 : 0.31),
      bannerWidth: h * (han ? 0.2 : 0.3),
      lean: han ? 0.18 : 0.1,
      fly: han ? -0.55 : 0.45,
      boneHint: 'spine02',
      clothPigment: 'accent',
      polePigment: 'ochre',
      metalPigment: 'metal',
      streamerCount: han ? 4 : 6,
      phase: ctx.rng.range(0, Math.PI * 2),
    }),
    P,
  );
}

// ---------------------------------------------------------------------------

registerUnit(PieceType.General, buildGeneral);
