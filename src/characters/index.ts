/**
 * The characters subsystem.
 *
 * Everything another module needs is here. `main.ts` wires it in three lines:
 *
 *     import { createCharacters } from '@characters/index.ts';
 *     const characters = createCharacters({ materials: pipeline.materials });
 *     await characters.prewarm();
 *
 * and then asks for units:
 *
 *     const unit = characters.create(Side.Red, PieceType.Horse, 0);
 *     scene.add(unit.root);
 *
 * `characters` never imports `@render`. It is handed a `GongbiMaterials` and
 * asks that for materials by material class and pigment; the arrow in the module
 * graph only ever points that way.
 */

export { buildRig, computeMetrics, normalisedBindLengths, restPose, rigToBone } from './rig.ts';
export type { Rig, RigMetrics, RigOptions, BoneSegment } from './rig.ts';
export { BONE_CHILDREN, BONE_MIRROR, PRIMARY_CHILD } from './rig.ts';

export {
  bindSkin,
  boneNeighbourhood,
  measureJointCollapse,
  skinStats,
  MAX_INFLUENCES,
} from './skinning.ts';
export type { SkinOptions, SkinStats } from './skinning.ts';

export {
  proportionsFor,
  silhouetteConflicts,
  unitDesign,
  unitSpec,
  TRIANGLE_BUDGET,
  UNIT_KEYS_IN_VALUE_ORDER,
} from './proportions.ts';
export type {
  CrestStyle,
  CrownSpec,
  HelmetStyle,
  UnitDesign,
  UnitSpec,
  WeaponKind,
} from './proportions.ts';

export {
  Factory,
  createCharacterFactory,
  isUnitRegistered,
  registerUnit,
  registeredUnits,
  unregisterUnit,
} from './factory.ts';
export type { FactoryOptions, UnitBuildContext, UnitBuilder } from './factory.ts';

export { fallbackUnit } from './fallback.ts';

export * as parts from './parts/index.ts';
export type {
  AttachSpec,
  BoneSpec,
  InstancedPart,
  Part,
  PartGroup,
  PartPigment,
  PigmentSlot,
} from './parts/types.ts';

// ---------------------------------------------------------------------------
// Unit registration
// ---------------------------------------------------------------------------
//
// Each of the seven unit files registers itself at module scope, so it only has
// to be *imported* once, from here. This is the single place in the codebase
// that knows the unit files exist — `factory.ts` deliberately does not, so that
// adding a unit never touches the factory.
//
// As each unit lands, its author adds one line to this block:
//
//     import './units/soldier.ts';
//
// Types with no line here still resolve to the generic fallback figure in
// `fallback.ts`; `createCharacters()` reports which through its `onWarn` sink.

import './units/horse.ts';

import './units/general.ts';
import './units/chariot.ts';

import './units/soldier.ts';

import './units/cannon.ts';

import { createCharacterFactory, registeredUnits, type Factory, type FactoryOptions } from './factory.ts';
import { fallbackUnit } from './fallback.ts';
import { UNIT_TYPE_BY_KEY, type UnitKey } from '@core/types.ts';
import { UNIT_KEYS_IN_VALUE_ORDER } from './proportions.ts';

export interface CharactersOptions extends Omit<FactoryOptions, 'fallback'> {
  /** Override the fallback builder — tests use this to stub a unit. */
  fallback?: FactoryOptions['fallback'];
}

/** Construct the factory with the fallback builder already wired in. */
export function createCharacters(opts: CharactersOptions): Factory {
  return createCharacterFactory({
    fallback: fallbackUnit,
    ...opts,
  });
}

/** Unit keys that still resolve to the generic fallback figure. */
export function unitsStillFallingBack(): UnitKey[] {
  const done = new Set(registeredUnits());
  return UNIT_KEYS_IN_VALUE_ORDER.filter((k) => !done.has(UNIT_TYPE_BY_KEY[k]));
}
