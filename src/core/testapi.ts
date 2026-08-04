/**
 * The capture harness's control surface.
 *
 * Everything the Playwright harness can do to the running game goes through
 * `window.__XQ`. It exists in every build (it is a few kilobytes and lets the
 * critics inspect a shipped bundle rather than a special one), but it never
 * drives anything the player can reach.
 *
 * The contract that matters for judging visuals: when the harness pauses the
 * game and steps it by an exact dt, the frame it captures is *deterministic*.
 * No `Math.random()`, no `performance.now()` reads inside update paths — every
 * animated value is a pure function of the accumulated clock the harness owns.
 */

import type { CameraPose, QualityTier } from './contracts.ts';
import type { Difficulty, Move, Side } from './types.ts';

export interface XqFrameStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  /** Worst frame time seen since the last `resetStats()`, milliseconds. */
  worstMs: number;
  quality: QualityTier;
  pixelRatio: number;
}

export interface XqTestApi {
  /** Resolves once the first real frame has been composited. */
  ready(): Promise<void>;

  // --- deterministic clock -------------------------------------------------
  /** Stop the rAF-driven clock. The scene stays live but frozen. */
  pause(): void;
  resume(): void;
  /** Advance exactly `seconds` of simulation and render one frame. */
  step(seconds: number): Promise<void>;
  /** Advance `frames` steps of `seconds` each, rendering each one. */
  stepFrames(frames: number, seconds?: number): Promise<void>;
  /** Wait until nothing is animating and the camera spring has settled. */
  settle(maxSeconds?: number): Promise<void>;

  // --- position control ----------------------------------------------------
  /** Load a FEN. Skips the formation march and lands in `development`. */
  setPosition(fen: string): Promise<void>;
  getPosition(): string;
  /** Apply a move by square indices, running its full animation. */
  playMove(from: number, to: number): Promise<void>;
  /** Apply a move with no animation at all — for setting up a shot fast. */
  forceMove(from: number, to: number): void;
  legalMoves(from?: number): Move[];
  setDifficulty(d: Difficulty): void;
  setHumanSide(s: Side): void;

  // --- choreography scrubbing ---------------------------------------------
  /**
   * Drive a capture to an exact normalised time and hold there. `t` spans the
   * whole three-beat exchange: 0 = windup start, 1 = dispersal settled. This is
   * how the motion critic gets a frame from precisely inside the impact hold.
   */
  seekCapture(from: number, to: number, t: number): Promise<void>;
  /** Same, for the formation march. */
  seekFormation(t: number): Promise<void>;
  /** Play a single unit's animation state in isolation, at normalised time t. */
  seekUnitState(
    side: Side,
    unit: string,
    state: string,
    t: number,
    opts?: { isolate?: boolean },
  ): Promise<void>;

  // --- presentation --------------------------------------------------------
  setPose(pose: Partial<CameraPose>, immediate?: boolean): void;
  getPose(): CameraPose;
  /** Named canonical framings the harness and critics both refer to by name. */
  setNamedPose(name: NamedPose, immediate?: boolean): void;
  /** Strip all materials to flat black on a white ground. */
  setSilhouette(on: boolean): void;
  /** Hide the HUD so a still is judged on the scene alone. */
  setHudVisible(on: boolean): void;
  /** Force a quality tier, defeating the adaptive governor. */
  setQuality(tier: QualityTier | 'auto'): void;
  /** Isolate one unit on an empty board, centred, for character review. */
  showcase(side: Side, unit: string, opts?: { state?: string; turntable?: number }): Promise<void>;
  /** Restore normal play after `showcase`. */
  exitShowcase(): Promise<void>;
  /** Debug overlays: wireframe, normals, bone axes, IK targets, ramp bands. */
  setDebug(flag: DebugFlag, on: boolean): void;

  // --- measurement ---------------------------------------------------------
  stats(): XqFrameStats;
  resetStats(): void;
  /** Everything the harness needs to label a shot. */
  describe(): {
    phase: string;
    ply: number;
    sideToMove: Side;
    inCheck: boolean;
    result: string;
    pieces: { square: number; code: number }[];
  };
}

export type NamedPose =
  /** The resting play framing: high, wide, 50° pitch. */
  | 'default'
  /** Straight down, for board and grid inspection. */
  | 'top'
  /** Low and level with the board, for silhouette reads. */
  | 'silhouette'
  /** Three-quarter close on Red's back rank. */
  | 'threeQuarterRed'
  /** Three-quarter close on Black's back rank. */
  | 'threeQuarterBlack'
  /** Tight over-the-shoulder, the capture framing. */
  | 'overShoulder'
  /** Very close on a single unit at board centre, eye level. */
  | 'portrait'
  /** Low, long, cool — the endgame framing. */
  | 'endgame'
  /** Profile view from Red's right, for gait and contact checks. */
  | 'profile';

export type DebugFlag =
  | 'wireframe'
  | 'normals'
  | 'bones'
  | 'ikTargets'
  | 'contactPoints'
  | 'rampBands'
  | 'outlineOnly'
  | 'sobelOnly'
  | 'shadowCascades'
  | 'boundingBoxes';

declare global {
  interface Window {
    __XQ?: XqTestApi;
  }
}

/** Standard opening position, used as the harness default. */
export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
