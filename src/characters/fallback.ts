/**
 * ============================================================================
 *  TEMPORARY FALLBACK BUILDER — replaced, unit by unit, by src/characters/units/
 * ============================================================================
 *
 * This file exists so the game is runnable and reviewable before the seven unit
 * files land. It builds *every* unit from the same generic recipe, driven
 * entirely by the `UnitDesign` record in `proportions.ts`: what the figure
 * wears, what it holds, what it stands on. Nothing here is unit-specific, and
 * nothing here should be treated as the final look of anything.
 *
 * It is deliberately not a capsule. Each unit gets its own body proportions, its
 * own headgear and crest, its own armour coverage, its own robe length, its own
 * weapons, and a real mount where the design calls for one — so a silhouette
 * pass run today already separates all seven, and the unit authors are refining
 * a figure rather than starting from nothing.
 *
 * WHAT A UNIT AUTHOR SHOULD TAKE FROM IT: the shape of a builder. Compute the
 * mount first (it is pure arithmetic), lift the rig onto it, build the figure,
 * dress it, arm it. Read `units/README.md`, then read this file, then delete it
 * from your unit's path by calling `registerUnit`.
 */

import * as THREE from 'three';
import type { BoneName } from '@core/contracts.ts';
import { PieceType } from '@core/types.ts';
import type { UnitBuildContext, UnitBuilder } from './factory.ts';
import type { UnitDesign, WeaponKind } from './proportions.ts';
import type { RigOptions, RigMetrics, Rig } from './rig.ts';
import {
  emptyGroup,
  mergeGroups,
  mkPart,
  type PartGroup,
  type V3,
} from './parts/types.ts';
import * as body from './parts/body.ts';
import * as cloth from './parts/cloth.ts';
import * as helmetParts from './parts/helmet.ts';
import * as lamellar from './parts/lamellar.ts';
import * as mountParts from './parts/mount.ts';
import * as prim from './parts/prim.ts';
import * as standardParts from './parts/standard.ts';
import * as trim from './parts/trim.ts';
import * as vehicle from './parts/vehicle.ts';
import * as weapons from './parts/weapons.ts';

const v3 = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const fallbackUnit: UnitBuilder = (ctx) => {
  const g = emptyGroup();
  const mount = buildMount(ctx, g);
  const rig = mount.rig;
  const m = rig.metrics;
  const B = rig.bindWorld;
  const d = ctx.spec.design;

  // --- the body -----------------------------------------------------------
  const wearsRobe = d.robe > 0.5;
  const fig = body.figure({
    metrics: m,
    bind: B,
    torsoPigment: 'cloth',
    torsoCls: 'cloth',
    bootShaft: d.robe > 0.7 ? 0.1 : 0.35,
    beard: ctx.spec.key === 'general' ? 'long' : ctx.spec.key === 'advisor' ? 'short' : 'none',
    deltoid: d.armour < 0.5,
  });
  mergeInto(g, fig);

  // --- cloth --------------------------------------------------------------
  const hemY = Math.max(
    m.ankleY * 0.6 + (B.root?.y ?? 0),
    m.hipY - (0.2 + d.robe * 0.9) * m.legLen,
  );
  if (wearsRobe) {
    mergeInto(
      g,
      cloth.robe({
        shoulderY: m.shoulderY + m.torsoLen * 0.04,
        waistY: m.waistY,
        hemY,
        shoulderR: m.shoulderWidth * 0.56,
        waistR: m.waistWidth * 0.62,
        hemR: m.hipWidth * 1.05,
        squash: 0.8,
        folds: 10,
      }),
    );
    // Court sleeves: the flare is the advisor's whole silhouette above the waist.
    mergeInto(
      g,
      cloth.sleeves(
        { r0: m.upperArmR * 1.9, r1: m.upperArmR * 4.4, folds: 7, length: 0.92 },
        { shoulder: v3(B.upperArmL), elbow: v3(B.foreArmL), wrist: v3(B.handL) },
        { shoulder: v3(B.upperArmR), elbow: v3(B.foreArmR), wrist: v3(B.handR) },
      ),
    );
    mergeInto(
      g,
      cloth.collar({
        shoulderY: m.shoulderY + m.torsoLen * 0.04,
        chestY: m.chestY - m.torsoLen * 0.12,
        rx: m.chestWidth * 0.55,
        rz: m.chestDepth * 0.6,
      }),
    );
  } else {
    g.parts.push(
      cloth.skirt({
        topY: m.waistY + m.torsoLen * 0.04,
        hemY,
        rTop: m.waistWidth * 0.6,
        rHem: m.hipWidth * 0.86,
        squash: 0.82,
        folds: 8,
        foldDepth: 0.16,
      }),
    );
    // Puttees under the tunic hem, for anyone who marches.
    if (ctx.spec.mount === 'none' || ctx.spec.mount === 'trebuchet') {
      for (const S of ['L', 'R'] as const) {
        g.parts.push(
          cloth.legWrap({
            side: S,
            knee: v3(B[`shin${S}`]),
            ankle: v3(B[`foot${S}`]),
            r: m.shinR,
            turns: 4,
          }),
        );
      }
    }
  }

  mergeInto(
    g,
    cloth.sash({
      y: m.waistY,
      rx: m.waistWidth * 0.58,
      rz: m.waistDepth * 0.66,
      height: m.torsoLen * 0.13,
      tail: m.torsoLen * (wearsRobe ? 0.85 : 0.4),
    }),
  );

  if (d.cloak) {
    g.parts.push(
      cloth.cloak({
        shoulderY: m.shoulderY + m.torsoLen * 0.08,
        hemY: Math.max(m.ankleY + (B.root?.y ?? 0), m.hipY - m.legLen * 0.86),
        rTop: m.shoulderWidth * 0.62,
        rHem: m.shoulderWidth * 1.05,
        z: m.chestDepth * 0.42,
        folds: 7,
        foldDepth: 0.2,
      }),
    );
  }

  if (ctx.spec.key === 'cannon') {
    g.parts.push(
      cloth.shoulderCape({
        shoulderY: m.shoulderY + m.torsoLen * 0.06,
        r: m.shoulderWidth * 0.78,
        drop: m.torsoLen * 0.5,
        folds: 8,
      }),
    );
  }

  // --- armour -------------------------------------------------------------
  dressArmour(g, d, m, B);

  // --- head ---------------------------------------------------------------
  const helm = helmetParts.helmet({
    style: d.crown.helmet,
    baseY: B.head.y,
    headLen: m.headLen,
    headWidth: m.headWidth,
    headDepth: m.headDepth,
    z: B.head.z,
    cheeks: d.armour > 0.3,
    nape: d.armour > 0.3,
    rivets: d.armour > 0.3,
  });
  mergeInto(g, helm);
  if (d.crown.crest !== 'none') {
    const anchors: [V3, V3] | undefined =
      helm.points.buyaoL && helm.points.buyaoR
        ? [v3(helm.points.buyaoL), v3(helm.points.buyaoR)]
        : undefined;
    mergeInto(
      g,
      helmetParts.crest({
        style: d.crown.crest,
        at: v3(helm.points.crest),
        height: m.headLen * d.crown.crestScale,
        width: m.headWidth * 0.62,
        ...(anchors ? { anchors } : {}),
      }),
    );
  }

  // --- arms and kit -------------------------------------------------------
  armFigure(g, ctx, d, m, B);
  return g;
};

// ---------------------------------------------------------------------------
// Mounts
// ---------------------------------------------------------------------------

interface MountResult {
  rig: Rig;
}

/**
 * Build whatever the unit stands on or rides, then lift the rig onto it. The
 * rig is built twice on purpose: once to read the default joint positions, and
 * again with the seated offsets computed from them. Two rig builds cost about
 * a tenth of a millisecond and save every mounted unit from hard-coding joint
 * positions it cannot know.
 */
function buildMount(ctx: UnitBuildContext, g: PartGroup): MountResult {
  const p = ctx.spec.proportions;
  const h = p.height;

  switch (ctx.spec.mount) {
    case 'platform': {
      // The general's command dais: two lacquered octagonal steps with a gold
      // rim. It lifts his head clear of every other piece on the board, which
      // is the point — the check pulse under him must never be occluded.
      const top = h * 0.24;
      const r = h * 0.42;
      const dais = prim.hardLathe(
        [
          [r * 1.16, 0],
          [r * 1.16, top * 0.3],
          [r * 1.0, top * 0.36],
          [r * 1.0, top * 0.74],
          [r * 0.86, top * 0.8],
          [r * 0.86, top],
        ],
        8,
        { phase: Math.PI / 8, capStart: false, name: 'dais' },
      );
      g.parts.push(mkPart(dais, 'lacquer', 'lacquer', 'root', { name: 'dais', rigid: true }));
      g.parts.push(
        trim.piping({
          path: prim
            .ring({ rx: r * 1.01, y: top * 0.78, sides: 8, phase: Math.PI / 8 })
            .concat([prim.ring({ rx: r * 1.01, y: top * 0.78, sides: 8, phase: Math.PI / 8 })[0]]),
          r: h * 0.008,
          boneHint: 'root',
          pigment: 'metal',
          name: 'daisRim',
        }),
      );
      return { rig: ctx.useRig({ origin: [0, top, 0] }) };
    }

    case 'horse': {
      const withers = h * 1.11;
      const length = h * 1.5;
      const horse = mountParts.horse({
        withers,
        length,
        width: withers * 0.26,
        barding: true,
        hidePigment: 'leather',
        harnessPigment: 'leather',
        metalPigment: 'metal',
      });
      mergeInto(g, horse);
      const seat = horse.points.seat;
      const rig0 = ctx.useRig({ origin: [0, seat.y - ctx.rig.metrics.legLen, seat.z] });
      const offsets = strideOffsets(rig0, {
        kneeOut: 1.55,
        kneeUp: 0.8,
        kneeFwd: 0.42,
        ankleOut: 1.9,
        ankleUp: 0.18,
        ankleFwd: 0.3,
      });
      return {
        rig: ctx.useRig({ origin: [0, seat.y - rig0.metrics.legLen, seat.z], offsets }),
      };
    }

    case 'elephant': {
      const shoulder = h * 1.78;
      const length = h * 2.12;
      const eleph = mountParts.elephant({
        shoulder,
        length,
        width: shoulder * 0.31,
        howdah: true,
        hidePigment: 'stone',
        howdahPigment: 'lacquer',
        clothPigment: 'cloth',
        metalPigment: 'metal',
        trunkSegments: 9,
      });
      mergeInto(g, eleph);
      const seat = eleph.points.seat;
      // He sits on the howdah bench: hips at the seat, feet on the floor.
      const floorDrop = h * 0.36;
      const rig0 = ctx.useRig({ origin: [0, seat.y - ctx.rig.metrics.legLen, seat.z] });
      const offsets = strideOffsets(rig0, {
        kneeOut: 1.0,
        kneeUp: 0.92,
        kneeFwd: 0.6,
        ankleOut: 1.05,
        ankleUp: 0.12,
        ankleFwd: 0.5,
      });
      void floorDrop;
      return {
        rig: ctx.useRig({ origin: [0, seat.y - rig0.metrics.legLen, seat.z], offsets }),
      };
    }

    case 'chariot': {
      const car = vehicle.chariot({
        wheelRadius: h * 0.78,
        track: h * 0.72,
        carWidth: h * 0.92,
        carDepth: h * 0.66,
        railHeight: h * 0.5,
        poleLength: h * 1.5,
        canopyRadius: h * 0.82,
        canopyHeight: h * 1.42,
        spokes: 26,
        timberPigment: 'leather',
        lacquerPigment: 'lacquer',
        metalPigment: 'metal',
        clothPigment: 'cloth',
      });
      mergeInto(g, car);
      // A Han charioteer stands; no seated offsets.
      return { rig: ctx.useRig({ origin: [0, car.points.seat.y, car.points.seat.z] }) };
    }

    case 'trebuchet': {
      const treb = vehicle.trebuchet({
        pivotHeight: h * 0.88,
        armLength: h * 1.16,
        buttLength: h * 0.44,
        spread: h * 0.5,
        sledLength: h * 1.42,
        armAngle: 0.66,
        timberPigment: 'leather',
        metalPigment: 'metal',
        clothPigment: 'accent',
        lacquerPigment: 'lacquer',
      });
      mergeInto(g, treb);
      // The crew stands at the counterweight end, hauling on the ropes; the
      // `stance` in his proportions already has him hunched forward.
      return { rig: ctx.useRig({ origin: [h * 0.34, 0, h * 0.62] }) };
    }

    case 'none':
    default:
      return { rig: ctx.rig };
  }
}

/**
 * Bind-pose offsets that fold the legs. Targets are expressed as multiples of
 * hip width and leg length so they are proportion-independent, and are computed
 * as *deltas* from the rig's own default joint positions — which is why the
 * caller has to hand in an already-built rig.
 */
function strideOffsets(
  rig: Rig,
  t: {
    kneeOut: number;
    kneeUp: number;
    kneeFwd: number;
    ankleOut: number;
    ankleUp: number;
    ankleFwd: number;
  },
): NonNullable<RigOptions['offsets']> {
  const m = rig.metrics;
  const B = rig.bindWorld;
  const y0 = B.root.y;
  const out: NonNullable<RigOptions['offsets']> = {};
  for (const S of ['L', 'R'] as const) {
    const s = S === 'L' ? -1 : 1;
    const knee = B[`shin${S}`];
    const ankle = B[`foot${S}`];
    const kneeTarget: V3 = [
      s * m.hipWidth * 0.5 * t.kneeOut,
      y0 + m.legLen * t.kneeUp,
      -m.legLen * t.kneeFwd,
    ];
    const ankleTarget: V3 = [
      s * m.hipWidth * 0.5 * t.ankleOut,
      y0 + m.legLen * t.ankleUp,
      -m.legLen * t.ankleFwd,
    ];
    const dKnee: V3 = [kneeTarget[0] - knee.x, kneeTarget[1] - knee.y, kneeTarget[2] - knee.z];
    out[`shin${S}` as BoneName] = dKnee;
    // The foot offset is applied on top of the knee's, so subtract it out.
    out[`foot${S}` as BoneName] = [
      ankleTarget[0] - ankle.x - dKnee[0],
      ankleTarget[1] - ankle.y - dKnee[1],
      ankleTarget[2] - ankle.z - dKnee[2],
    ];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Armour
// ---------------------------------------------------------------------------

function dressArmour(
  g: PartGroup,
  d: UnitDesign,
  m: RigMetrics,
  B: Record<BoneName, THREE.Vector3>,
): void {
  const a = d.armour;
  if (a < 0.05) return;

  const rows = 3 + Math.round(a * 3);
  mergeInto(
    g,
    lamellar.cuirass({
      fromY: m.waistY - m.torsoLen * 0.1,
      toY: m.shoulderY + m.torsoLen * 0.02,
      rx0: m.waistWidth * 0.58,
      rx1: m.chestWidth * 0.6,
      depthRatio: 0.74,
      rows,
      perRow: 14,
      cord: true,
      thickness: 0.1,
    }),
  );

  if (a >= 0.3) {
    mergeInto(
      g,
      lamellar.skirtArmour({
        topY: m.waistY - m.torsoLen * 0.08,
        bottomY: m.hipY - m.legLen * (0.18 + a * 0.2),
        rxTop: m.hipWidth * 0.62,
        rxBottom: m.hipWidth * 0.82,
        depthRatio: 0.82,
        rows: 1 + Math.round(a * 2),
        perRow: 16,
        frontGap: 0.55,
        cord: true,
      }),
    );
  }

  if (a >= 0.45) {
    for (const S of ['L', 'R'] as const) {
      mergeInto(
        g,
        lamellar.pauldron({
          side: S,
          shoulder: v3(B[`upperArm${S}`]),
          r: m.upperArmR * 2.5,
          rows: 3,
          perRow: 5,
        }),
      );
    }
  }

  if (a >= 0.75) {
    for (const S of ['L', 'R'] as const) {
      mergeInto(
        g,
        lamellar.tubeArmour({
          bone: `foreArm${S}` as BoneName,
          from: v3(B[`foreArm${S}`]),
          to: v3(B[`hand${S}`]),
          r: m.foreArmR * 1.55,
          rows: 2,
          perRow: 7,
          arc: Math.PI * 1.5,
          facing: S === 'L' ? -1 : 1,
        }),
      );
      mergeInto(
        g,
        lamellar.tubeArmour({
          bone: `shin${S}` as BoneName,
          from: v3(B[`shin${S}`]),
          to: v3(B[`foot${S}`]),
          r: m.shinR * 1.7,
          rows: 3,
          perRow: 7,
          arc: Math.PI * 1.2,
          facing: S === 'L' ? -1 : 1,
        }),
      );
    }
    mergeInto(
      g,
      lamellar.neckGuard({
        y: m.shoulderY + m.torsoLen * 0.02,
        r: m.neckR * 2.6,
        height: m.neckLen * 0.62,
        count: 12,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Weapons and kit
// ---------------------------------------------------------------------------

function armFigure(
  g: PartGroup,
  ctx: UnitBuildContext,
  d: UnitDesign,
  m: RigMetrics,
  B: Record<BoneName, THREE.Vector3>,
): void {
  const h = m.height;
  const gripR = g.points.gripR ?? B.handR;
  const gripL = g.points.gripL ?? B.handL;

  putWeapon(g, d.primary, v3(gripR), 'handR', h, m);
  putWeapon(g, d.offhand, v3(gripL), 'handL', h, m);

  if (d.hip !== 'none') {
    mergeInto(
      g,
      weapons.scabbard({
        grip: [
          B.pelvis.x - m.hipWidth * 0.62,
          B.pelvis.y + m.torsoLen * 0.02,
          B.pelvis.z + m.hipDepth * 0.1,
        ],
        rot: [0.24, 0, 0.34],
        bone: 'pelvis',
        length: h * (d.hip === 'sword' ? 0.34 : 0.28),
        width: h * 0.035,
      }),
    );
  }

  if (d.back === 'quiver') {
    mergeInto(
      g,
      weapons.quiver({
        grip: [
          B.spine02.x + m.chestWidth * 0.34,
          B.spine02.y - m.torsoLen * 0.34,
          B.spine02.z + m.chestDepth * 0.62,
        ],
        rot: [-0.3, 0, -0.26],
        bone: 'spine02',
        length: h * 0.3,
        r: h * 0.036,
        arrows: 6,
      }),
    );
  }

  if (d.back === 'standard') {
    mergeInto(
      g,
      standardParts.standard({
        shape: ctx.side === 0 ? 'hanSquare' : 'chuSwallowtail',
        base: [
          B.spine02.x - m.chestWidth * 0.42,
          B.spine02.y - m.torsoLen * 0.2,
          B.spine02.z + m.chestDepth * 0.7,
        ],
        poleLength: h * 0.72,
        poleR: h * 0.014,
        bannerHeight: h * 0.3,
        bannerWidth: h * 0.36,
        lean: 0.24,
        fly: ctx.side === 0 ? -0.4 : 0.4,
        boneHint: 'spine02',
        clothPigment: 'accent',
        polePigment: 'leather',
        metalPigment: 'metal',
        streamerCount: 5,
        phase: ctx.rng.range(0, 6.28),
      }),
    );
  }
}

function putWeapon(
  g: PartGroup,
  kind: WeaponKind,
  grip: V3,
  bone: BoneName,
  h: number,
  m: RigMetrics,
): void {
  const metal: 'metal' = 'metal';
  switch (kind) {
    case 'none':
    case 'reins':
      return;
    case 'ge':
      mergeInto(g, weapons.ge({ grip, bone, length: h * 1.24, gripAt: 0.42, shaftR: h * 0.014, metalPigment: metal }));
      return;
    case 'ji':
      mergeInto(g, weapons.ji({ grip, bone, length: h * 1.32, gripAt: 0.42, shaftR: h * 0.014, metalPigment: metal }));
      return;
    case 'spear':
      mergeInto(
        g,
        weapons.spear({
          grip,
          bone,
          rot: [0.42, 0, 0],
          length: h * 1.9,
          gripAt: 0.36,
          shaftR: h * 0.017,
          metalPigment: metal,
        }),
      );
      return;
    case 'sword':
      mergeInto(g, weapons.sword({ grip, bone, length: h * 0.46, halfWidth: h * 0.021, metalPigment: metal }));
      return;
    case 'dao':
      mergeInto(g, weapons.dao({ grip, bone, length: h * 0.4, halfWidth: h * 0.019, metalPigment: metal }));
      return;
    case 'bow':
      mergeInto(g, weapons.bow({ grip, bone, length: h * 0.86, depth: h * 0.15, metalPigment: metal }));
      return;
    case 'shield':
      mergeInto(g, weapons.shield({ grip, bone, height: h * 0.52, width: h * 0.28, metalPigment: metal }));
      return;
    case 'axe':
      mergeInto(g, weapons.axe({ grip, bone, length: h * 0.94, headWidth: h * 0.2, shaftR: h * 0.016, metalPigment: metal }));
      return;
    case 'goad':
      // The mahout's hook: a short axe with a small head.
      mergeInto(
        g,
        weapons.axe({
          grip,
          bone,
          rot: [0.5, 0, 0],
          length: h * 0.62,
          headWidth: h * 0.1,
          shaftR: h * 0.013,
          metalPigment: metal,
        }),
      );
      return;
    case 'baton':
      mergeInto(g, weapons.baton({ grip, bone, length: h * 1.05, gripAt: 0.34, shaftR: h * 0.018, metalPigment: metal }));
      return;
  }
  void m;
}

// ---------------------------------------------------------------------------

function mergeInto(dst: PartGroup, src: PartGroup): void {
  const merged = mergeGroups(dst, src);
  dst.parts = merged.parts;
  dst.instanced = merged.instanced;
  dst.bones = merged.bones;
  dst.attach = merged.attach;
  dst.points = merged.points;
}
