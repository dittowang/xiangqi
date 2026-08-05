/**
 * The integration surface between subsystems.
 *
 * Each subsystem is written by a different author working in parallel, so this
 * file is deliberately the *only* place they need to agree. If a subsystem
 * needs something from another one, it takes it as one of these interfaces —
 * never by importing that subsystem's internals.
 *
 * Conventions that hold everywhere:
 *   - Units are authored feet-at-origin, facing -Z, one world unit = one board
 *     square, and are scaled by `UnitMeta.scale` at the root.
 *   - All time is seconds. All angles are radians.
 *   - Nothing here allocates per frame.
 */

import type * as THREE from 'three';
import type { MaterialClass, OutlineProfileName, PigmentName } from './palette.ts';
import type { Difficulty, GameResult, Move, PieceCode, PieceType, Side, UnitKey } from './types.ts';

// ===========================================================================
// Characters
// ===========================================================================

/** The shared humanoid rig. Every unit uses exactly these bones, in this order. */
export type BoneName =
  | 'root'
  | 'pelvis'
  | 'spine01'
  | 'spine02'
  | 'neck'
  | 'head'
  | 'clavicleL'
  | 'upperArmL'
  | 'foreArmL'
  | 'handL'
  | 'clavicleR'
  | 'upperArmR'
  | 'foreArmR'
  | 'handR'
  | 'thighL'
  | 'shinL'
  | 'footL'
  | 'thighR'
  | 'shinR'
  | 'footR';

export const BONE_ORDER: readonly BoneName[] = [
  'root',
  'pelvis',
  'spine01',
  'spine02',
  'neck',
  'head',
  'clavicleL',
  'upperArmL',
  'foreArmL',
  'handL',
  'clavicleR',
  'upperArmR',
  'foreArmR',
  'handR',
  'thighL',
  'shinL',
  'footL',
  'thighR',
  'shinR',
  'footR',
];

/** Parent of each bone; `root` has none. */
export const BONE_PARENT: Record<BoneName, BoneName | null> = {
  root: null,
  pelvis: 'root',
  spine01: 'pelvis',
  spine02: 'spine01',
  neck: 'spine02',
  head: 'neck',
  clavicleL: 'spine02',
  upperArmL: 'clavicleL',
  foreArmL: 'upperArmL',
  handL: 'foreArmL',
  clavicleR: 'spine02',
  upperArmR: 'clavicleR',
  foreArmR: 'upperArmR',
  handR: 'foreArmR',
  thighL: 'pelvis',
  shinL: 'thighL',
  footL: 'shinL',
  thighR: 'pelvis',
  shinR: 'thighR',
  footR: 'shinR',
};

/**
 * The per-unit proportion table. One rig, thirty-two parameterisations. These
 * are what separate a 1.55-scale elephant handler from a 0.58-scale conscript
 * without either becoming a different skeleton.
 */
export interface UnitProportions {
  /** Root scale applied to the whole figure. Drives the piece-value read. */
  scale: number;
  /** Standing height in rig units before `scale`. */
  height: number;
  /** Head length as a fraction of height — the classical 頭身 ratio. */
  headRatio: number;
  /** Shoulder width in rig units. */
  shoulderWidth: number;
  /** Hip width in rig units. */
  hipWidth: number;
  /** Torso length fraction of height. */
  torsoRatio: number;
  /** Leg length fraction of height. */
  legRatio: number;
  /** Arm length fraction of height. */
  armRatio: number;
  /** Limb thickness multiplier — mass distribution. */
  bulk: number;
  /** Extra bulk on the upper body only; makes heavy units read top-loaded. */
  topHeaviness: number;
  /** Forward lean at rest, radians. Cavalry and crews carry different lean. */
  stance: number;
  /** Feet separation at rest, rig units. */
  stanceWidth: number;
}

/** What kind of thing the figure stands on or in, if anything. */
export type MountKind = 'none' | 'horse' | 'elephant' | 'chariot' | 'platform' | 'trebuchet';

/** Named sockets other systems attach to. All are `Object3D`s under the rig. */
export type AttachName =
  | 'gripR' // primary weapon hand
  | 'gripL' // off hand / shield
  | 'haftTip' // far end of a polearm, for IK targets
  | 'crest' // helmet ornament
  | 'back' // standard pole, quiver
  | 'hip' // scabbard
  | 'mountSeat' // where the rider's pelvis sits
  | 'reinL'
  | 'reinR' // rein anchors on the mount
  | 'muzzle' // projectile origin for the 砲
  | 'trunkTip'; // elephant trunk end effector

export interface UnitMeta {
  key: UnitKey;
  side: Side;
  type: PieceType;
  proportions: UnitProportions;
  mount: MountKind;
  /** Overall bounding size in world units after scaling: [width, height, depth]. */
  size: [number, number, number];
  /**
   * Silhouette signature, used by the readability critic and the silhouette
   * render mode: a coarse aspect ratio and a headgear tag. Two units in the
   * same army must never share both.
   */
  silhouette: { aspect: number; crown: string; widthClass: 'narrow' | 'medium' | 'wide' };
  /** Pigment this unit disperses into when captured. */
  dispersal: PigmentName;
  /** Locomotion the animator should use. */
  gait: 'march' | 'stride' | 'canter' | 'lumber' | 'roll' | 'crew';
  /** Triangle count after build, filled in by the factory. Perf budget tracking. */
  triangles: number;
}

/** A built, ready-to-place unit. */
export interface UnitInstance {
  /** Scene root. Feet at y = 0, facing -Z, already scaled. */
  root: THREE.Group;
  /** Every skinned mesh in the figure; all share `skeleton`. */
  skinned: THREE.SkinnedMesh[];
  /** Rigid props (weapon blades, wheels, canopies) parented into the rig. */
  props: THREE.Object3D[];
  skeleton: THREE.Skeleton;
  bones: Record<BoneName, THREE.Bone>;
  /** Extra bones for the mount, if any: wheels, trunk segments, horse legs. */
  mountBones: Record<string, THREE.Object3D>;
  attach: Partial<Record<AttachName, THREE.Object3D>>;
  meta: UnitMeta;
  /** Releases GPU resources unique to this instance. */
  dispose(): void;
}

export interface CharacterFactory {
  /** Build one unit. Deterministic for a given (side, type, variant). */
  create(side: Side, type: PieceType, variant?: number): UnitInstance;
  /** Warm shared geometry/material caches so the first move never hitches. */
  prewarm(): Promise<void>;
  /** Triangle and draw-call totals for the perf HUD. */
  stats(): { geometries: number; triangles: number; materials: number };
  dispose(): void;
}

// ===========================================================================
// Rendering
// ===========================================================================

export interface MaterialRequest {
  cls: MaterialClass;
  pigment: PigmentName;
  /** Per-instance value nudge so a rank of soldiers is not a xerox. */
  variation?: number;
  /** Override the class's default outline profile. */
  outline?: OutlineProfileName;
  /** Skinned materials need the skinning chunk compiled in. */
  skinned?: boolean;
  /** Opt out of receiving the silk-weave shadow wash (used for tiny props). */
  noSilk?: boolean;
  /** Emissive lift, used only for the check pulse and the impact flash. */
  glow?: number;
}

export interface GongbiMaterials {
  /** Returns a cached material; identical requests share one instance. */
  get(req: MaterialRequest): THREE.Material;
  /** The BackSide hull material paired with a given surface material. */
  outline(req: MaterialRequest): THREE.Material | null;
  /** Strip everything to flat black for the silhouette critic pass. */
  setSilhouetteMode(on: boolean): void;
  /** Per-frame uniform push: time, camera, screen size, mood grade. */
  update(dt: number, camera: THREE.Camera, size: { w: number; h: number; dpr: number }): void;
  /** Cross-fade the global light mood over `seconds`. */
  setMood(key: 'wide' | 'close' | 'endgame', seconds: number): void;
  dispose(): void;
}

export interface RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: { render(dt: number): void };
  readonly materials: GongbiMaterials;
  setSize(w: number, h: number, dpr: number): void;
  render(scene: THREE.Scene, camera: THREE.Camera, dt: number): void;
  /** Global impact flash, 0..1, decays on its own. */
  flash(strength: number, colour: string): void;
  /** Silhouette-only mode for the readability critic. */
  setSilhouetteMode(on: boolean): void;
  /** Quality tier, driven by the adaptive perf governor. */
  setQuality(tier: QualityTier): void;
  dispose(): void;
}

export type QualityTier = 'ultra' | 'high' | 'medium' | 'low';

export interface QualitySettings {
  tier: QualityTier;
  maxPixelRatio: number;
  shadowMapSize: number;
  cascades: number;
  sobel: boolean;
  silkWash: boolean;
  outlines: boolean;
  particleBudget: number;
  msaa: number;
}

// ===========================================================================
// Animation
// ===========================================================================

export type AnimState =
  | 'idle'
  | 'move' // locomotion, gait chosen by UnitMeta.gait
  | 'attackWindup'
  | 'attackStrike'
  | 'hit'
  | 'death'
  | 'victory'
  | 'salute'; // used by the formation march and the terminal set piece

export interface UnitAnimator {
  readonly unit: UnitInstance;
  /** Cross-fade into a state. `fade` in seconds. */
  play(state: AnimState, fade?: number, opts?: { speed?: number; loop?: boolean }): void;
  /** Advance the mixer, then run IK. Order matters and is enforced here. */
  update(dt: number): void;
  /** Duration of a state's clip, seconds. */
  duration(state: AnimState): number;
  /** Lock a hand to a world-space point until released (weapon hafts, reins). */
  setHandTarget(side: 'L' | 'R', target: THREE.Vector3 | null): void;
  /** Ground the feet against this height field. Called every frame. */
  setGroundHeight(fn: ((x: number, z: number) => number) | null): void;
  /** Distance travelled this frame, so wheel and hoof phase match ground truth. */
  reportTravel(distance: number): void;
  dispose(): void;
}

export interface Choreographer {
  /** Slide a unit from square to square; resolves when it settles. */
  walk(unit: UnitInstance, fromSq: number, toSq: number): Promise<void>;
  /** The full three-beat capture. Resolves after beat three has dispersed. */
  capture(attacker: UnitInstance, defender: UnitInstance, ctx: CaptureBeatContext): Promise<void>;
  /** Armies marching in from off-board, in formation order. */
  formation(units: UnitInstance[], skip: () => boolean): Promise<void>;
  /** Terminal set piece: general falls, winning army raises weapons. */
  finale(result: GameResult, units: UnitInstance[]): Promise<void>;
  update(dt: number): void;
  /** Cancel everything in flight, e.g. on takeback or reset. */
  abort(): void;
}

export interface CaptureBeatContext {
  attackerSq: number;
  defenderSq: number;
  attackerType: PieceType;
  defenderType: PieceType;
  ranged: boolean;
}

// ===========================================================================
// Scene, board and camera
// ===========================================================================

export interface BoardScene {
  readonly group: THREE.Group;
  /** Board surface height at a world point — the feet-planting reference. */
  heightAt(x: number, z: number): number;
  /** Light every square in `targets` as a pressed gold legal-move mark. */
  showLegalMarks(targets: number[]): void;
  clearLegalMarks(): void;
  /** Soft hover ring under one square. */
  setHover(square: number | null): void;
  /** Pulsing cinnabar base under a general in check. */
  setCheck(square: number | null): void;
  /** The last move's from/to, marked faintly the way a 棋譜 marks it. */
  setLastMove(from: number, to: number): void;
  update(dt: number): void;
  dispose(): void;
}

export type CameraMode = 'formation' | 'wide' | 'development' | 'capture' | 'check' | 'endgame' | 'terminal' | 'review' | 'free';

export interface CameraDirector {
  readonly camera: THREE.PerspectiveCamera;
  update(dt: number): void;
  setMode(mode: CameraMode, seconds?: number): void;
  /** Over-the-shoulder push for a capture; resolves when the push has landed. */
  pushToCapture(attackerSq: number, defenderSq: number): Promise<void>;
  /** Snap attention to a general under check. */
  pushToCheck(square: number): void;
  /** Return to whatever the phase's resting framing is. */
  release(seconds?: number): void;
  /** Hand control to the player's orbit input. */
  setUserControl(on: boolean): void;
  /** Additive shake, decays on its own. */
  impulse(strength: number, dir?: THREE.Vector3): void;
  /** Frame the whole board — used by the capture harness for canonical shots. */
  setPose(pose: CameraPose, immediate?: boolean): void;
  getPose(): CameraPose;
  resize(aspect: number): void;
}

export interface CameraPose {
  /** Orbit target, world space. */
  target: [number, number, number];
  /** Distance from target. */
  distance: number;
  /** Pitch above the board plane, radians. 45–55° is the resting range. */
  pitch: number;
  /** Azimuth around +Y, radians. 0 looks from Red's seat. */
  yaw: number;
  /** Vertical FOV, degrees. */
  fov: number;
}

// ===========================================================================
// HUD, review and audio
// ===========================================================================

export interface Hud {
  /** The HUD is painted into the 3D scene, never into the DOM. */
  readonly group: THREE.Group;
  update(dt: number): void;
  resize(w: number, h: number, dpr: number): void;
  dispose(): void;
}

export type AudioCue =
  | 'pieceLand' // wood on stone
  | 'pieceLift'
  | 'armourShift'
  | 'hoofbeat'
  | 'chariotRumble'
  | 'trebuchetRelease'
  | 'trebuchetImpact'
  | 'bladeStrike'
  | 'spearThrust'
  | 'trunkSweep'
  | 'bodyFall'
  | 'drumCheck'
  | 'drumBeat'
  | 'gong'
  | 'uiTap'
  | 'uiSweep'
  | 'illegal';

export interface AudioEngine {
  /** Web Audio needs a user gesture; this is called from the first click. */
  unlock(): Promise<void>;
  play(cue: AudioCue, opts?: { gain?: number; pan?: number; detune?: number; delay?: number }): void;
  /** Underscore density follows material left on the board, 0..1. */
  setIntensity(v: number): void;
  /** Tighten the drum cadence as the endgame closes in. */
  setCadence(bpm: number): void;
  setMuted(m: boolean): void;
  update(dt: number): void;
  dispose(): void;
}

// ===========================================================================
// Engine client (main-thread facade over the Web Worker)
// ===========================================================================

export interface SearchResult {
  move: Move;
  /** Centipawns from the side-to-move's point of view. */
  score: number;
  depth: number;
  nodes: number;
  timeMs: number;
  pv: Move[];
  /** Set when the score is a forced mate; positive = mating. */
  mateIn: number | null;
  /** True when the move came straight out of the opening book. */
  fromBook: boolean;
}

export interface EngineClient {
  ready(): Promise<void>;
  newGame(): Promise<void>;
  /** Push the authoritative position. `moves` are applied on top of `fen`. */
  setPosition(fen: string, moves: Move[]): Promise<void>;
  search(difficulty: Difficulty, opts?: { timeMs?: number }): Promise<SearchResult>;
  /**
   * Fixed-strength analysis for hints and post-game review.
   *
   * `timeMs` alone bounds the search by WALL CLOCK, which is right for a hint —
   * the player is waiting — and wrong for a review, because the same game
   * analysed twice then annotates differently depending on machine load. Passing
   * `depth` bounds it by search depth instead and makes the result reproducible;
   * `timeMs` becomes a safety cap rather than the thing that decides the answer.
   */
  analyse(fen: string, timeMs: number, depth?: number): Promise<SearchResult>;
  stop(): void;
  perft(fen: string, depth: number): Promise<number>;
  dispose(): void;
}

// ===========================================================================
// Persistence
// ===========================================================================

export interface SavedMatch {
  version: number;
  difficulty: Difficulty;
  /** Start position; the standard opening unless a test harness set otherwise. */
  fen: string;
  moves: Move[];
  /** Which side the human plays. */
  humanSide: Side;
  result: GameResult;
  savedAt: number;
}
