/**
 * The animation subsystem.
 *
 * Three things another module ever needs from here:
 *
 *     import { createAnimator, createChoreographer, createPigmentField } from '@anim/index.ts';
 *
 *     const pigment = createPigmentField({ ground: (x, z) => board.heightAt(x, z) });
 *     scene.add(pigment.group);
 *
 *     const animators = new Map<UnitInstance, Animator>();
 *     for (const unit of units) {
 *       animators.set(unit, createAnimator(unit, { ground, audio, variant }));
 *     }
 *
 *     const choreo = createChoreographer({
 *       camera, audio, pigment,
 *       animatorFor: (u) => animators.get(u),
 *       ground: (x, z) => board.heightAt(x, z),
 *     });
 *
 * Then, every frame, in this order:
 *
 *     choreo.update(dt);                 // moves units, fires beats, runs pigment
 *     for (const a of animators.values()) a.update(dt);
 *
 * `anim` imports `three` and `@core` and nothing else. The camera director, the
 * audio engine and the character units all arrive by injection through their
 * contract interfaces, so this subsystem can be built, verified and stepped with
 * no renderer, no scene and no DOM — which is what `verify.ts` does.
 */

// --- tuning ----------------------------------------------------------------
export {
  CANTER,
  CAPTURE,
  CAPTURE_HOLD,
  CAPTURE_TOTAL,
  CLIP,
  EASE,
  FADE,
  FINALE,
  FORMATION,
  FORMATION_ORDER,
  FRAME,
  GAIT,
  IK,
  LUMBER,
  PIGMENT,
  PROJECTILE,
  RANGED,
  RANGED_TOTAL,
  ROLL,
  TARGET_FPS,
  WALK,
  frames,
  walkSeconds,
} from './timing.ts';
export type { EaseName, GaitName, GaitPlan } from './timing.ts';

// --- clips -----------------------------------------------------------------
export {
  HIT_DIRECTIONS,
  UNIT_MOTION,
  breath,
  buildClipSet,
  clearClipCache,
  clipKeyFor,
  curve,
  makePose,
  sampleRoot,
  trunkBend,
  trunkIdle,
} from './clips.ts';
export type {
  AttackStyle,
  AuthorCtx,
  ClipSet,
  HitDirection,
  Key,
  NormalisedClip,
  Pose,
  RootCurve,
  UnitMotion,
} from './clips.ts';

// --- inverse kinematics ----------------------------------------------------
export {
  chainReach,
  clampRotation,
  makeAimChain,
  makeChain,
  makeFootLock,
  makeIkContext,
  rigPosition,
  rigQuaternion,
  solveAim,
  solveTwoBone,
  solveTwoBoneRaw,
  stanceWeight,
  swingLift,
  toRig,
  updateIkContext,
} from './ik.ts';
export type { AimChain, FootLock, IkContext, SolveResult, TwoBoneChain } from './ik.ts';

// --- per-unit animator -----------------------------------------------------
export { Animator, createAnimator } from './controller.ts';
export type { AnimatorOptions } from './controller.ts';

// --- pigment ---------------------------------------------------------------
export { PigmentField, createPigmentField } from './pigment.ts';
export type { BurstOptions, PigmentFieldOptions } from './pigment.ts';

// --- choreography ----------------------------------------------------------
export { Choreography, createChoreographer } from './choreography.ts';
export type { ChoreographyOptions } from './choreography.ts';
