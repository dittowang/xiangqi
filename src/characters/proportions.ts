/**
 * The unit table. One rig, thirty-two parameterisations.
 *
 * ART DIRECTION
 * -------------
 * A xiangqi board is read at a glance, from above, at a distance, in one
 * colour per army. The player has to name a piece from its outline before they
 * notice anything else about it — that is the entire job of this file. It fixes
 * three *orthogonal* separation axes, so that failing to read one still leaves
 * two working:
 *
 *   1. HEIGHT      — total silhouette height in world units, *including* crest
 *                    and mount and anything the figure carries. Monotone with
 *                    piece value: 0.63 for a conscript, 1.26 for a general.
 *   2. ASPECT      — the larger horizontal extent ÷ height. Foot units are
 *                    vertical strokes (0.48 .. 0.61), the beast and vehicle
 *                    units horizontal ones (1.12 .. 1.68). `widthClass` is a
 *                    coarse band on the *absolute* footprint in world units,
 *                    not on the ratio: narrow < 0.6, medium 0.6 .. 1.1,
 *                    wide > 1.1. Absolute size is what decides whether a piece
 *                    crowds its neighbours, so that is what the class tracks.
 *   3. CROWN       — the headgear tag. Every unit in an army wears a different
 *                    thing on its head, and the difference survives being
 *                    reduced to a black shape on white.
 *
 * The rule the readability critic enforces: **two units in the same army must
 * never share both aspect class and crown tag.** Here every crown tag is unique
 * within an army, so the rule holds with margin; `verify.ts` asserts it rather
 * than trusting this comment.
 *
 * The `designHeight`/`designAspect` numbers below describe what the shipped
 * builders actually measure — they are reconciled against
 * `npx tsx src/characters/verify.ts --units`, not aspirational — and the
 * factory warns when a build drifts more than 30% from them. A unit author who
 * changes a figure's proportions enough to move these numbers must move the
 * numbers too; silently drifting is how a silhouette table becomes decorative.
 *
 * Two pairs are close on one axis and must be read on another, which is exactly
 * what having three orthogonal axes is for:
 *   - advisor 0.60 and general 0.61 are the same aspect. They differ by 73% in
 *     height and by a whole width class.
 *   - horse 1.38 and chariot 1.35 are nearly the same aspect *and* nearly the
 *     same height. They differ by 70% in cross-file width (0.50 against 0.86)
 *     and by crown, and by mass distribution a bounding box cannot see.
 * `verify.ts` reports the tightest aspect pair so this cannot quietly worsen.
 *
 * Reference: Han pictorial stone relief (漢畫像石) for figures that read from
 * outline alone; Dunhuang Mogao murals for proportion and drapery; Han and Chu
 * military iconography for helmet and weapon silhouettes.
 *
 * THE BOARD READ SETS THE SCALE, AND IT IS THE BINDING CONSTRAINT
 * ---------------------------------------------------------------
 * One square is 1.0 world unit. A piece whose footprint runs past that covers
 * its neighbour's intersection, and once a back rank is a wall of overlapping
 * silhouettes you cannot read the position at all — which is the whole game.
 * The first full-board render made this unarguable: elephants and chariots
 * measured 3.0 to 3.5 units deep, three squares each, and Black's back rank was
 * almost entirely occluded.
 *
 * Two things follow, and they are the reason the numbers below look small.
 *
 * First, **footprint caps height**. Every unit builder sizes its mount as a
 * multiple of `proportions.height`, so `scale` and `height` are both uniform
 * multipliers on the finished silhouette and neither can change a unit's
 * *aspect ratio* — that is fixed by the geometry. A chariot with an aspect of
 * 1.35 that must fit 1.36 across is therefore 1.01 tall, and no choice of scale
 * makes it both compact and towering. The height ladder is what is left after
 * the footprint cap, not something chosen freely.
 *
 * Second, the cap is applied per axis, because the two axes do different
 * damage. **Cross-file width (X) is held under 1.0 for every unit**: neighbours
 * on a rank are one unit apart in X, so that is the axis that hides pieces.
 * Depth (Z) is allowed out to ~1.36 for the beast and vehicle units, which
 * leans about 0.18 into the rank in front and behind — enough to read as
 * presence, not enough to cover an intersection.
 *
 * SCALE AND HEIGHT ARE STILL NOT THE SAME KNOB
 * --------------------------------------------
 * `scale` is the root multiplier that sets the piece-value read. `height` is the
 * *human figure's* standing height in rig units, before scale. For a foot unit
 * they multiply out to the figure's world height directly. For a mounted unit
 * the mount carries the mass, so `height` is deliberately small — the horse is
 * authored in the same rig units as its rider and lifts the whole silhouette,
 * so the rider's `height` is well under the conscript's. Getting this backwards
 * produces a cavalryman twice the size of a footman, which is what a naive
 * reading of the scale range would give you.
 */

import type { MountKind, UnitMeta, UnitProportions } from '@core/contracts.ts';
import { ARMY, type PigmentName } from '@core/palette.ts';
import { seedFor } from '@core/rng.ts';
import { PieceType, Side, UNIT_KEY, type UnitKey } from '@core/types.ts';

// ---------------------------------------------------------------------------
// Design vocabulary
// ---------------------------------------------------------------------------

/** Headgear forms. `parts/helmet.ts` builds each of these. */
export type HelmetStyle =
  | 'hanDoumou' // 兜鍪: rolled-brim iron bowl, crest socket at the apex
  | 'chuPeaked' // Chu peaked helm: a forward-raked ridge, no brim roll
  | 'softCap' // 幞頭: wrapped soft cap with two hanging tails
  | 'crownedHelm' // the general's tall crowned helm
  | 'hood' // artillerist's wrapped 巾 hood with ear flaps
  | 'turban' // mahout's wound turban
  | 'fanCrown'; // charioteer's low crown carrying a fan crest

/** Crest features that sit in a helmet's crest socket. */
export type CrestStyle =
  | 'none'
  | 'plume' // 纓: a single upright horsehair plume
  | 'hornPair' // paired forward-swept horns
  | 'fanCrest' // a flat vertical fan, widest crown in the cast
  | 'standardSocket' // a short socket carrying a pennon
  | 'buyao'; // 步搖: dangling beaded strands, the general's mark

export type WeaponKind =
  | 'none'
  | 'ge' // 戈 dagger-axe
  | 'ji' // 戟 halberd
  | 'spear' // 矛
  | 'sword' // 劍
  | 'dao' // 刀
  | 'bow' // 弓
  | 'shield' // 盾
  | 'axe' // 鉞
  | 'baton' // 節, the general's staff of authority
  | 'reins'
  | 'goad'; // the mahout's hook

export interface CrownSpec {
  /** Reported in `UnitMeta.silhouette.crown`. Unique within an army. */
  tag: string;
  helmet: HelmetStyle;
  crest: CrestStyle;
  /** Crest height as a multiple of head length. */
  crestScale: number;
}

/**
 * Everything a unit author needs that is not a proportion: what the figure
 * wears, what it holds, and what it stands on. Fixed here rather than in the
 * seven unit files so the cast stays coherent when seven people write it.
 */
export interface UnitDesign {
  crown: CrownSpec;
  /** Right hand. */
  primary: WeaponKind;
  /** Left hand. */
  offhand: WeaponKind;
  /** Slung on the back. */
  back: 'none' | 'standard' | 'quiver';
  /** Worn at the hip. */
  hip: 'none' | 'sword' | 'dao';
  /** Lamellar coverage, 0 (none) .. 1 (full cuirass, skirt, pauldrons, greaves). */
  armour: number;
  /** Robe length, 0 (short tunic to mid-thigh) .. 1 (court robe to the ankle). */
  robe: number;
  /** Wears a cloak. Adds a large, soft counter-shape to a hard armoured figure. */
  cloak: boolean;
}

// ---------------------------------------------------------------------------
// Base proportions, before the army modifier
// ---------------------------------------------------------------------------

interface BaseSpec {
  proportions: UnitProportions;
  mount: MountKind;
  gait: UnitMeta['gait'];
  design: UnitDesign;
  /** Design target for total silhouette height in world units, mount included. */
  designHeight: number;
  /** Design target for width ÷ height of the profile silhouette. */
  designAspect: number;
  widthClass: 'narrow' | 'medium' | 'wide';
  /** Triangle ceiling from the performance budget. */
  budget: number;
  dispersal: PigmentName | null;
}

/**
 * `height` for the mounted units is the *rider's* height in rig units; see the
 * note at the top of the file. Every other ratio is a fraction of that height,
 * so the rig scales coherently whatever value `height` takes.
 */
const BASE: Record<UnitKey, BaseSpec> = {
  // -------------------------------------------------------------- 兵 / 卒 ---
  // The conscript. Everything else in the cast is defined against him: shortest,
  // narrowest, plainest. Short tunic, half-cuirass, dagger-axe held upright, and
  // a single plume that is the only thing breaking his outline above the helmet.
  soldier: {
    proportions: {
      scale: 0.316,
      height: 1.75,
      headRatio: 0.155, // 6.5 heads — the stumpy Han-relief proportion
      shoulderWidth: 0.42,
      hipWidth: 0.3,
      torsoRatio: 0.3,
      legRatio: 0.475,
      armRatio: 0.365,
      bulk: 1.0,
      topHeaviness: 0.1,
      stance: 0.05,
      stanceWidth: 0.24,
    },
    mount: 'none',
    gait: 'march',
    design: {
      crown: { tag: 'plumed-doumou', helmet: 'hanDoumou', crest: 'plume', crestScale: 0.62 },
      primary: 'ge',
      offhand: 'none',
      back: 'none',
      hip: 'none',
      armour: 0.45,
      robe: 0.22,
      cloak: false,
    },
    designHeight: 0.63,
    designAspect: 0.48,
    widthClass: 'narrow',
    budget: 9000,
    dispersal: null,
  },

  // -------------------------------------------------------------- 仕 / 士 ---
  // The palace guard. No armour at all — a long robe with wide sleeves, which
  // gives a soft trapezoid where the soldier gives a hard rectangle. Taller,
  // and the soft cap's two hanging tails read even at silhouette size.
  advisor: {
    proportions: {
      scale: 0.386,
      height: 1.66,
      headRatio: 0.148,
      shoulderWidth: 0.4,
      hipWidth: 0.315,
      torsoRatio: 0.305,
      legRatio: 0.462,
      armRatio: 0.37,
      bulk: 0.94,
      topHeaviness: 0.02,
      stance: 0.03,
      stanceWidth: 0.19,
    },
    mount: 'none',
    gait: 'stride',
    design: {
      crown: { tag: 'soft-cap', helmet: 'softCap', crest: 'none', crestScale: 0 },
      primary: 'sword',
      offhand: 'none',
      back: 'none',
      hip: 'sword',
      armour: 0.0,
      robe: 0.92,
      cloak: false,
    },
    designHeight: 0.69,
    designAspect: 0.60,
    widthClass: 'narrow',
    budget: 11000,
    dispersal: null,
  },

  // -------------------------------------------------------------- 帥 / 將 ---
  // The general, on a raised command platform. Tallest human in the cast, the
  // only one with a cloak, and the only crown with 步搖 strands. The platform is
  // not decoration: it lifts his head clear of everything on the board so the
  // check pulse under him is never occluded.
  general: {
    proportions: {
      scale: 0.578,
      height: 1.21,
      headRatio: 0.138, // 7.2 heads — the heroic Dunhuang proportion
      shoulderWidth: 0.315,
      hipWidth: 0.222,
      torsoRatio: 0.31,
      legRatio: 0.478,
      armRatio: 0.368,
      bulk: 1.1,
      topHeaviness: 0.34,
      stance: 0.02,
      stanceWidth: 0.27,
    },
    mount: 'platform',
    gait: 'stride',
    design: {
      crown: { tag: 'crowned-buyao', helmet: 'crownedHelm', crest: 'buyao', crestScale: 0.9 },
      primary: 'baton',
      offhand: 'none',
      back: 'standard',
      hip: 'sword',
      armour: 1.0,
      robe: 0.6,
      cloak: true,
    },
    designHeight: 1.26,
    designAspect: 0.61,
    widthClass: 'medium',
    budget: 16000,
    dispersal: 'gold', // authority leaving the board, not just an army colour
  },

  // -------------------------------------------------------------- 炮 / 砲 ---
  // The 砲 is a traction trebuchet, not a gun: a low timber A-frame, a pivoting
  // beam, a counterweight box and a sling. Widest-and-lowest thing in the cast,
  // and the only unit whose silhouette is mostly machine. The crewman is hooded
  // and hunched, hands on the beam.
  cannon: {
    proportions: {
      scale: 0.510,
      height: 1.13,
      headRatio: 0.153,
      shoulderWidth: 0.29,
      hipWidth: 0.21,
      torsoRatio: 0.298,
      legRatio: 0.468,
      armRatio: 0.378, // long reach; he is working the beam
      bulk: 1.06,
      topHeaviness: 0.18,
      stance: 0.24, // hunched forward over the machine
      stanceWidth: 0.3,
    },
    mount: 'trebuchet',
    gait: 'crew',
    design: {
      crown: { tag: 'hooded', helmet: 'hood', crest: 'none', crestScale: 0 },
      primary: 'none',
      offhand: 'none',
      back: 'none',
      hip: 'dao',
      armour: 0.25,
      robe: 0.34,
      cloak: false,
    },
    designHeight: 0.81,
    designAspect: 1.68,
    widthClass: 'wide',
    budget: 24000,
    dispersal: null,
  },

  // -------------------------------------------------------------- 傌 / 馬 ---
  // Rider and horse. Long and low in profile, with the spear raking back over
  // the croup to lengthen it further. Paired horns on the helm.
  horse: {
    proportions: {
      scale: 0.542,
      height: 0.97,
      headRatio: 0.152,
      shoulderWidth: 0.24,
      hipWidth: 0.176,
      torsoRatio: 0.3,
      legRatio: 0.47,
      armRatio: 0.362,
      bulk: 1.02,
      topHeaviness: 0.2,
      stance: 0.11, // seated forward over the withers
      stanceWidth: 0.34, // legs spread around the barrel
    },
    mount: 'horse',
    gait: 'canter',
    design: {
      crown: { tag: 'horned', helmet: 'chuPeaked', crest: 'hornPair', crestScale: 0.7 },
      primary: 'spear',
      offhand: 'reins',
      back: 'none',
      hip: 'sword',
      armour: 0.7,
      robe: 0.3,
      cloak: false,
    },
    designHeight: 0.97,
    designAspect: 1.38,
    widthClass: 'wide',
    budget: 20000,
    dispersal: null,
  },

  // -------------------------------------------------------------- 相 / 象 ---
  // War elephant with a howdah. Nearly square in profile — the one wide unit
  // that is as tall as it is long, which is what separates it from the horse
  // and the chariot at a glance. Segmented trunk, flat plate ears, tusks.
  elephant: {
    proportions: {
      scale: 0.551,
      height: 0.735,
      headRatio: 0.157,
      shoulderWidth: 0.185,
      hipWidth: 0.14,
      torsoRatio: 0.295,
      legRatio: 0.465,
      armRatio: 0.372,
      bulk: 0.98,
      topHeaviness: 0.12,
      stance: 0.08,
      stanceWidth: 0.28,
    },
    mount: 'elephant',
    gait: 'lumber',
    design: {
      crown: { tag: 'turbaned', helmet: 'turban', crest: 'none', crestScale: 0 },
      primary: 'goad',
      offhand: 'none',
      back: 'none',
      hip: 'none',
      armour: 0.15,
      robe: 0.4,
      cloak: false,
    },
    designHeight: 1.05,
    designAspect: 1.12,
    widthClass: 'wide',
    budget: 26000,
    dispersal: null,
  },

  // -------------------------------------------------------------- 俥 / 車 ---
  // The war chariot: two big spoked wheels, a box car with a rail, a 傘蓋
  // canopy on a pole, a draught pole and yoke running forward. The widest thing
  // on the board, and the only silhouette with a horizontal disc floating above
  // it. Driver wears a low crown with a flat fan crest.
  chariot: {
    proportions: {
      scale: 0.561,
      height: 0.72,
      headRatio: 0.15,
      shoulderWidth: 0.182,
      hipWidth: 0.132,
      torsoRatio: 0.302,
      legRatio: 0.472,
      armRatio: 0.366,
      bulk: 1.0,
      topHeaviness: 0.16,
      stance: 0.07,
      stanceWidth: 0.22,
    },
    mount: 'chariot',
    gait: 'roll',
    design: {
      crown: { tag: 'fan-crest', helmet: 'fanCrown', crest: 'fanCrest', crestScale: 1.05 },
      primary: 'bow',
      offhand: 'reins',
      back: 'quiver',
      hip: 'sword',
      armour: 0.55,
      robe: 0.36,
      cloak: false,
    },
    designHeight: 0.90,
    designAspect: 1.35,
    widthClass: 'wide',
    budget: 32000,
    dispersal: null,
  },
};

// ---------------------------------------------------------------------------
// Army modifiers
// ---------------------------------------------------------------------------

/**
 * Han and Chu are two armies, not one army tinted twice — and the difference
 * has to survive the silhouette pass, where colour is gone. Han figures are
 * shorter, thicker and squarer in the shoulder; Chu figures are taller, leaner
 * and lean further forward. Small numbers, but applied to every unit they read
 * as two different castings rather than a palette swap.
 */
interface ArmyMod {
  height: number;
  bulk: number;
  shoulder: number;
  hip: number;
  headRatio: number;
  stanceAdd: number;
  stanceWidth: number;
  topHeaviness: number;
}

const ARMY_MOD: Record<0 | 1, ArmyMod> = {
  // Han (Red)
  0: {
    height: 0.985,
    bulk: 1.07,
    shoulder: 1.05,
    hip: 1.04,
    headRatio: 1.02,
    stanceAdd: -0.012,
    stanceWidth: 1.06,
    topHeaviness: 1.12,
  },
  // Chu (Black)
  1: {
    height: 1.015,
    bulk: 0.95,
    shoulder: 0.97,
    hip: 0.98,
    headRatio: 0.98,
    stanceAdd: 0.018,
    stanceWidth: 0.96,
    topHeaviness: 0.92,
  },
};

// ---------------------------------------------------------------------------
// The public table
// ---------------------------------------------------------------------------

export interface UnitSpec {
  key: UnitKey;
  side: Side;
  type: PieceType;
  proportions: UnitProportions;
  mount: MountKind;
  gait: UnitMeta['gait'];
  design: UnitDesign;
  dispersal: PigmentName;
  /** Triangle ceiling. The factory warns when a build exceeds it. */
  budget: number;
  /**
   * The silhouette contract. `aspect` and `crown` land in `UnitMeta.silhouette`
   * verbatim; `height` is the design target the factory compares the measured
   * bounding box against.
   */
  silhouette: {
    height: number;
    aspect: number;
    crown: string;
    widthClass: 'narrow' | 'medium' | 'wide';
  };
}

/**
 * Per-unit proportions with the army modifier and a small deterministic
 * per-variant jitter applied. The jitter is what stops five soldiers on a rank
 * from being five copies of one mesh; it is drawn from `seedFor` so the same
 * variant is the same figure in every run, on every machine.
 */
export function proportionsFor(side: Side, type: PieceType, variant = 0): UnitProportions {
  const key = UNIT_KEY[type];
  if (!key) throw new Error(`proportionsFor: no unit for piece type ${type}`);
  const base = BASE[key].proportions;
  const m = ARMY_MOD[side as 0 | 1];
  const rng = seedFor('proportions', key, side, variant);

  // Jitter budget: ±2.5% stature, ±5% mass, ±0.025 rad of lean. Anything larger
  // and a rank stops reading as one formation.
  const jHeight = 1 + rng.gauss() * 0.025;
  const jBulk = 1 + rng.gauss() * 0.05;
  const jStance = rng.gauss() * 0.025;
  const jShoulder = 1 + rng.gauss() * 0.03;

  return {
    scale: base.scale,
    height: base.height * m.height * jHeight,
    headRatio: base.headRatio * m.headRatio,
    shoulderWidth: base.shoulderWidth * m.shoulder * jShoulder,
    hipWidth: base.hipWidth * m.hip,
    torsoRatio: base.torsoRatio,
    legRatio: base.legRatio,
    armRatio: base.armRatio,
    bulk: base.bulk * m.bulk * jBulk,
    topHeaviness: base.topHeaviness * m.topHeaviness,
    stance: base.stance + m.stanceAdd + jStance,
    stanceWidth: base.stanceWidth * m.stanceWidth,
  };
}

/** The complete design record for one (side, type, variant). */
export function unitSpec(side: Side, type: PieceType, variant = 0): UnitSpec {
  const key = UNIT_KEY[type];
  if (!key) throw new Error(`unitSpec: no unit for piece type ${type}`);
  const b = BASE[key];
  return {
    key,
    side,
    type,
    proportions: proportionsFor(side, type, variant),
    mount: b.mount,
    gait: b.gait,
    design: b.design,
    dispersal: b.dispersal ?? ARMY[side as 0 | 1].dispersal,
    budget: b.budget,
    silhouette: {
      height: b.designHeight,
      aspect: b.designAspect,
      crown: b.design.crown.tag,
      widthClass: b.widthClass,
    },
  };
}

/** All fourteen (side, type) combinations, in board-value order. */
export const UNIT_KEYS_IN_VALUE_ORDER: readonly UnitKey[] = [
  'soldier',
  'advisor',
  'general',
  'cannon',
  'horse',
  'elephant',
  'chariot',
];

export const TRIANGLE_BUDGET: Record<UnitKey, number> = {
  soldier: BASE.soldier.budget,
  advisor: BASE.advisor.budget,
  general: BASE.general.budget,
  cannon: BASE.cannon.budget,
  horse: BASE.horse.budget,
  elephant: BASE.elephant.budget,
  chariot: BASE.chariot.budget,
};

/** Design record only, without the per-side proportion maths. */
export function unitDesign(key: UnitKey): UnitDesign {
  return BASE[key].design;
}

/**
 * Cheap self-check on the silhouette contract, callable from tests and from
 * `verify.ts`. Returns the offending pairs; empty means the cast is separable.
 */
export function silhouetteConflicts(side: Side): string[] {
  const seen = new Map<string, UnitKey>();
  const bad: string[] = [];
  for (const key of UNIT_KEYS_IN_VALUE_ORDER) {
    const b = BASE[key];
    const sig = `${b.widthClass}|${b.design.crown.tag}`;
    const prev = seen.get(sig);
    if (prev) bad.push(`${prev} and ${key} share (${sig}) in ${ARMY[side as 0 | 1].hanzi}`);
    seen.set(sig, key);
  }
  return bad;
}
