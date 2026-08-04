/**
 * The HUD, painted into the scene.
 *
 * There is no DOM here and there is never going to be. Everything the player
 * reads is a physical object lying on the terrace beside the board, made of the
 * same pigments as the board and picking up the same paper grain, mood grade and
 * vignette on its way through the post chain — because it goes through the post
 * chain, being part of the scene that `pipeline.render()` draws.
 *
 * Four objects:
 *
 *   1. THE RECORD SCROLL (棋譜)  — a long ruled sheet on the right, two columns
 *      of seal script running top to bottom, Red on the right and Black on the
 *      left the way a printed record sets them. It scrolls one row at a time as
 *      the game lengthens.
 *   2. THE TITLE SLIP            — a short sheet at the head of the scroll
 *      carrying the difficulty tier in a pressed cinnabar seal and the two army
 *      names as column heads. The army to move is the one painted at full
 *      strength; the other is faint. A 將軍 stamp lands on it during check.
 *   3. THE FALLEN                — captured pieces are the actual figures, built
 *      by the character factory at reduced scale and toppled onto the board's
 *      timber rail. Not icons. They fall when they arrive.
 *   4. THE EVAL SILK             — a strip of silk on the left, aligned with the
 *      board so its middle is the river, with ink bleeding out of the river into
 *      the losing side's half. See `ui/inkbleed.ts`.
 *
 * ── The two rules that keep this cheap ──────────────────────────────────────
 *
 * **Canvas textures are repainted on change, never per frame.** Every event sets
 * a dirty flag; `update()` flushes at most one repaint per panel per frame, so a
 * burst of bus traffic in one tick costs one repaint, not four. The paper
 * grounds are painted ONCE into offscreen canvases and blitted, so a repaint is
 * a `drawImage` plus a few dozen glyphs.
 *
 * **Nothing animated touches a canvas.** The ink bleed, the scroll's slide and
 * the fallen figures' topple are all uniforms and transforms. `update()` does
 * not allocate.
 *
 * ── Orientation, stated once ────────────────────────────────────────────────
 *
 * Every panel is a `PlaneGeometry` rotated -90° about X, so local +Y lands on
 * world -Z and local +X on world +X. With the default `flipY` on a canvas
 * texture that makes:
 *
 *     canvas TOP    = world -Z = the far end   = the top of the page
 *     canvas LEFT   = world -X = toward the board
 *
 * which is why the Red column is painted on the RIGHT of the canvas: a 棋譜 is
 * read right column first.
 */

import * as THREE from 'three';

import { bus } from '@core/bus.ts';
import type { CharacterFactory, GongbiMaterials, Hud, UnitInstance } from '@core/contracts.ts';
import { band, type PigmentName } from '@core/palette.ts';
import { seedFor } from '@core/rng.ts';
import {
  clamp,
  damp,
  DIFFICULTY,
  easeOutBack,
  easeOutCubic,
  GLYPH,
  moveCaptured,
  PieceType,
  pieceSide,
  pieceType,
  Side,
  type Difficulty,
  type Move,
  type PieceCode,
} from '@core/types.ts';
import { BOARD_HALF_Z } from '@core/coords.ts';
import { attachOutlines } from '@render/index.ts';

import { bakeBleedField, createInkBleedMaterial, reachFromCentipawns } from '@ui/inkbleed.ts';
import {
  deckle,
  inkedRun,
  makeCanvas,
  paintGround,
  pressedRule,
  sealCartouche,
} from '@ui/paper.ts';
import { drawText } from '@ui/seal.ts';

// ===========================================================================
// Layout — all of it, in world units, in one place
// ===========================================================================

/**
 * Texels per world unit on every HUD canvas.
 *
 * Chosen against the resting framing (`NAMED_POSES.default`), where a world unit
 * covers roughly 80 CSS pixels: at 150 this supersamples by about 2x, which is
 * what seal script needs to survive minification without its counters filling
 * in. Multiplied by device pixel ratio and capped, because the cost is memory.
 */
const TEXELS_PER_UNIT = 150;
const MAX_DPR = 2;

/** Height above whatever surface a panel lies on. Enough to beat z-fighting. */
const PANEL_LIFT = 0.007;

/** Visible move-pairs on the scroll, and the one extra row it scrolls into. */
const ROWS = 5;
const SLOTS = ROWS + 1;

const SCROLL_W = 1.55;
/** One move-pair's share of the scroll's length. */
const SLOT_LEN = 1.52;
const SCROLL_LEN = ROWS * SLOT_LEN; // 7.6
/** Where the scroll's centre sits along Z. */
const SCROLL_Z = 0.15;

const SLIP_W = SCROLL_W;
const SLIP_LEN = 1.9;
/** Gap between the title slip's foot and the scroll's head. */
const SLIP_GAP = 0.26;

/**
 * Nominal X of the scroll's centre, and how far in it is allowed to be pulled
 * on a narrow window. The lower bound clears the table's frame; anything closer
 * and the sheet would lie half on the stone and half on the timber.
 */
const SIDE_X_WIDE = 6.86;
const SIDE_X_MIN = 6.42;

const BAND_W = 0.82;
const BAND_LEN = 9.0;
const BAND_X_WIDE = -6.6;
const BAND_X_MIN = -6.28;

/** Where the fallen lie: the middle of the table's timber rail, left and right. */
const RAIL_X = 5.8;
/** Usable half-length of a rail, leaving the mitres clear. */
const RAIL_HALF_Z = BOARD_HALF_Z + 0.05;

/**
 * The 鎮紙 — the pair of stone bars holding the scroll down.
 *
 * They are here for two reasons beyond being what is actually on a scholar's
 * table. They give the sheets physical presence: paper that is weighted down
 * reads as paper, and paper that is not reads as a decal. And they are the one
 * part of the HUD that goes through the injected `GongbiMaterials`, so the HUD
 * has at least one surface quantised by the same ramp as everything else, lit by
 * the same key and casting into the same shadow cascades.
 */
const WEIGHT_LEN = SCROLL_W * 1.16;
const WEIGHT_W = 0.115;
const WEIGHT_H = 0.075;
/** Fallen figures are built at this fraction of their playing size. */
const FALLEN_SCALE = 0.5;
/** Seconds a body takes to topple once it arrives. */
const FALL_TIME = 0.55;

/** Seconds the scroll takes to slide one row. */
const SCROLL_TIME = 0.42;
/** How fast the ink front chases the evaluation, per second. */
const INK_RATE = 1.35;

// --- pigments --------------------------------------------------------------

const PAPER: PigmentName = 'shellWhite';
const PAPER_BAND = 2;
const PAPER_AGE: PigmentName = 'ochre';
const SILK: PigmentName = 'gamboge';
const SILK_BAND = 2;
const RULE: PigmentName = 'ochre';
const SEAL: PigmentName = 'cinnabar';

/** Ink each army's moves are recorded in. */
const RECORD_INK: Record<Side, { pigment: PigmentName; band: 0 | 1 | 2 | 3 }> = {
  [Side.Red]: { pigment: 'cinnabar', band: 1 },
  [Side.Black]: { pigment: 'ink', band: 1 },
};

// ===========================================================================
// Options
// ===========================================================================

export interface HudOptions {
  /** Injected, never constructed here. Reserved for future lit HUD props. */
  materials: GongbiMaterials;
  /** The fallen are real units, so the factory is not optional. */
  characters: CharacterFactory;
  /** Board surface height at a world point — `BoardScene.heightAt`. */
  heightAt?: (x: number, z: number) => number;
  /**
   * Give a freshly built figure its ink-and-gold line work. main.ts already owns
   * this call for the figures on the board; the fallen want the same treatment
   * or they arrive at the rail without a contour. Optional: without it the
   * figures still render, just unlined.
   */
  dress?: (root: THREE.Object3D) => void;
  /** Release whatever `dress` attached, before the unit is disposed. */
  undress?: (root: THREE.Object3D) => void;
  difficulty?: Difficulty;
  /** Which side moves next. Red unless a save says otherwise. */
  sideToMove?: Side;
  width: number;
  height: number;
  dpr: number;
}

/**
 * The HUD contract plus the two things the harness and main.ts drive it with.
 * `__XQ.setHudVisible()` is `setVisible`.
 */
export interface SceneHud extends Hud {
  setVisible(on: boolean): void;
  isVisible(): boolean;
  setDifficulty(d: Difficulty): void;
  /**
   * Rebuild the record from a move list. A resumed match replays its moves into
   * the model without emitting `move:end` for each one, so a HUD that only
   * listened to the bus would come back from a save with a blank 棋譜 and an
   * empty rail. Call this once after `match.begin(saved.moves)` with
   * `match.moves` and `match.notation`.
   */
  syncRecord(moves: readonly Move[], notation: readonly string[], firstSide?: Side): void;
}

// ===========================================================================
// Small shared bits
// ===========================================================================

/** sRGB hex from the palette to a linear THREE.Color, the project convention. */
function pigmentColour(name: PigmentName, i: 0 | 1 | 2 | 3): THREE.Color {
  return new THREE.Color().setStyle(band(name, i), THREE.SRGBColorSpace);
}

function makePanelTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  return tex;
}

const PANEL_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * A sheet of paper with a scrolling window and soft ends.
 *
 * The window is applied here rather than through `texture.offset`, because a raw
 * `ShaderMaterial` does not get three's uv transform injected and silently
 * ignoring it is a long afternoon.
 */
const PANEL_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform vec2 uWindow;   // (offset, repeat) along v
uniform float uEndFade;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec2 uv = vec2(vUv.x, vUv.y * uWindow.y + uWindow.x);
  vec4 c = texture2D(uMap, uv);
  float ends = smoothstep(0.0, uEndFade, vUv.y) * smoothstep(1.0, 1.0 - uEndFade, vUv.y);
  gl_FragColor = vec4(c.rgb, c.a * ends * uOpacity);
}
`;

function createPanelMaterial(map: THREE.Texture, endFade: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uWindow: { value: new THREE.Vector2(0, 1) },
      uEndFade: { value: endFade },
      uOpacity: { value: 1 },
    },
    vertexShader: PANEL_VERT,
    fragmentShader: PANEL_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

/** A flat quad in the XZ plane, textured, with its long axis along Z. */
function makePanel(worldW: number, worldL: number, material: THREE.Material): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(worldW, worldL, 1, 1);
  const mesh = new THREE.Mesh(geo, material);
  // YXZ, so X lays the sheet flat FIRST and Y then spins it on the table. With
  // the default XYZ order a Y term would tilt the sheet out of the terrace
  // instead of turning it on it.
  mesh.rotation.order = 'YXZ';
  mesh.rotation.x = -Math.PI / 2;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // Flat sheets on a flat terrace never occlude each other, and not sorting
  // them against the opaque pass keeps them off the depth buffer entirely.
  mesh.renderOrder = 4;
  return mesh;
}

// ===========================================================================
// Record entries
// ===========================================================================

interface RecordEntry {
  ply: number;
  side: Side;
  notation: string;
  /** The piece this move took, 0 for a quiet move. Drives takeback of a body. */
  captured: PieceCode;
}

interface Fallen {
  unit: UnitInstance;
  /** Outer group: position and yaw along the rail. */
  pivot: THREE.Group;
  /** Inner group: the topple. Separated so yaw and topple do not fight. */
  body: THREE.Group;
  side: Side;
  type: PieceType;
  /** Length this body occupies along the rail. */
  extent: number;
  /** 0..1 topple progress. */
  t: number;
  /** Final topple angle, jittered so a rank of bodies is not a rank of clones. */
  topple: number;
  yaw: number;
  /**
   * A figure pivots about its own feet, so once it is down its body lies on the
   * rail's surface rather than on top of it — half of it below the timber. This
   * is how far it has to come back up, and it comes up as the body goes over.
   */
  lift: number;
  baseY: number;
}

// ===========================================================================
// The HUD
// ===========================================================================

class InSceneHud implements SceneHud {
  readonly group = new THREE.Group();

  private readonly opts: HudOptions;
  private readonly heightAt: (x: number, z: number) => number;

  // --- panels ---------------------------------------------------------------
  private scroll!: THREE.Mesh;
  private scrollMat!: THREE.ShaderMaterial;
  private scrollTex!: THREE.CanvasTexture;
  private scrollCtx!: CanvasRenderingContext2D;
  private scrollGround!: HTMLCanvasElement;

  private slip!: THREE.Mesh;
  private slipMat!: THREE.ShaderMaterial;
  private slipTex!: THREE.CanvasTexture;
  private slipCtx!: CanvasRenderingContext2D;
  private slipGround!: HTMLCanvasElement;

  private bandMesh!: THREE.Mesh;
  private bandMat!: THREE.ShaderMaterial;
  private bandTex!: THREE.CanvasTexture;
  private bandCtx!: CanvasRenderingContext2D;
  private bandGround!: HTMLCanvasElement;
  private bandField!: THREE.DataTexture;

  private weights: THREE.Mesh[] = [];

  private readonly fallenGroup = new THREE.Group();

  // --- model ----------------------------------------------------------------
  private entries: RecordEntry[] = [];
  private fallen: Fallen[] = [];
  private difficulty: Difficulty;
  private sideToMove: Side;
  private inCheck = false;

  // --- animated state (no allocation past construction) ---------------------
  private reach = 0;
  private reachTarget = 0;
  /** Which army's lacquer is currently on the silk. */
  private inkSide: Side = Side.Red;
  private scrollSlide = 0;
  private scrollSlideFrom = 0;
  private scrollSlideT = 1;
  /** How many pairs the top of the visible window has already advanced by. */
  private topPair = 0;

  // --- dirty flags ----------------------------------------------------------
  private recordDirty = true;
  private slipDirty = true;
  private bandDirty = true;
  private railDirty = false;

  // --- layout ---------------------------------------------------------------
  private texelScale = TEXELS_PER_UNIT;
  private aspect = 16 / 9;

  private readonly unsubs: (() => void)[] = [];

  constructor(opts: HudOptions) {
    this.opts = opts;
    this.heightAt = opts.heightAt ?? (() => 0);
    this.difficulty = opts.difficulty ?? 'medium';
    this.sideToMove = opts.sideToMove ?? Side.Red;
    this.group.name = 'hud';
    this.group.add(this.fallenGroup);

    this.texelScale = TEXELS_PER_UNIT * clamp(opts.dpr, 1, MAX_DPR);
    this.aspect = opts.width / Math.max(opts.height, 1);

    this.buildScroll();
    this.buildSlip();
    this.buildBand();
    this.buildWeights();
    this.placePanels();
    this.pushInkColour();
    this.subscribe();
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private buildScroll(): void {
    // The canvas covers SLOTS rows; the quad shows ROWS of them.
    const w = Math.round(SCROLL_W * this.texelScale);
    const h = Math.round(SLOTS * SLOT_LEN * this.texelScale);

    const ground = makeCanvas(w, h);
    paintGround(ground.ctx, w, h, {
      ground: PAPER,
      groundBand: PAPER_BAND,
      age: PAPER_AGE,
      ageBand: 1,
      ageAmount: 0.3,
      weave: 0.16,
      fibre: 0.46,
      tooth: 0.55,
      wear: 0.4,
      seed: 'scroll',
    });
    // Only the long sides are torn: the ends run off the visible window, and a
    // torn end that scrolled past would give the illusion away.
    deckle(ground.ctx, w, h, { sides: w * 0.014, ends: 0, seed: 'scroll' });
    this.drawRules(ground.ctx, w, h);
    this.scrollGround = ground.canvas;

    const face = makeCanvas(w, h);
    this.scrollCtx = face.ctx;
    this.scrollTex = makePanelTexture(face.canvas);
    this.scrollMat = createPanelMaterial(this.scrollTex, 0.045);
    (this.scrollMat.uniforms.uWindow.value as THREE.Vector2).set(0, ROWS / SLOTS);
    this.scroll = makePanel(SCROLL_W, SCROLL_LEN, this.scrollMat);
    this.group.add(this.scroll);
  }

  private buildSlip(): void {
    const w = Math.round(SLIP_W * this.texelScale);
    const h = Math.round(SLIP_LEN * this.texelScale);

    const ground = makeCanvas(w, h);
    paintGround(ground.ctx, w, h, {
      ground: PAPER,
      groundBand: PAPER_BAND,
      age: PAPER_AGE,
      ageBand: 1,
      ageAmount: 0.36,
      weave: 0.16,
      fibre: 0.4,
      tooth: 0.55,
      wear: 0.5,
      seed: 'slip',
    });
    deckle(ground.ctx, w, h, { sides: w * 0.016, ends: w * 0.016, seed: 'slip' });
    this.slipGround = ground.canvas;

    const face = makeCanvas(w, h);
    this.slipCtx = face.ctx;
    this.slipTex = makePanelTexture(face.canvas);
    this.slipMat = createPanelMaterial(this.slipTex, 0.0);
    this.slip = makePanel(SLIP_W, SLIP_LEN, this.slipMat);
    this.group.add(this.slip);
  }

  private buildBand(): void {
    const w = Math.round(BAND_W * this.texelScale);
    const h = Math.round(BAND_LEN * this.texelScale);

    const ground = makeCanvas(w, h);
    paintGround(ground.ctx, w, h, {
      ground: SILK,
      groundBand: SILK_BAND,
      age: 'ochre',
      ageBand: 1,
      ageAmount: 0.22,
      // Silk, so the weave leads and the fibre is only what shows between the
      // threads.
      weave: 0.62,
      fibre: 0.14,
      tooth: 0.4,
      wear: 0.3,
      seed: 'band',
    });
    deckle(ground.ctx, w, h, { sides: w * 0.05, ends: 0, seed: 'band' });
    this.bandGround = ground.canvas;

    const face = makeCanvas(w, h);
    this.bandCtx = face.ctx;
    this.bandTex = makePanelTexture(face.canvas);
    // The field is smooth by construction, so it does not need the base's
    // resolution — a quarter of it is invisible in the result and a quarter of
    // the bake cost.
    this.bandField = bakeBleedField(Math.round(w * 0.6), Math.round(h * 0.6), 'band');
    this.bandMat = createInkBleedMaterial(this.bandTex, this.bandField, 0.05);
    this.bandMesh = makePanel(BAND_W, BAND_LEN, this.bandMat);
    this.group.add(this.bandMesh);
  }

  /** The two stone bars across the scroll. See `WEIGHT_LEN` for why they exist. */
  private buildWeights(): void {
    const geo = new THREE.BoxGeometry(WEIGHT_LEN, WEIGHT_H, WEIGHT_W, 1, 1, 1);
    const mat = this.opts.materials.get({
      cls: 'stone',
      pigment: 'stone',
      // A bar this small never reads its silk wash; asking for it only costs a
      // second material in the cache.
      noSilk: true,
      outline: 'fine',
    });
    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.weights.push(mesh);
    }
    // One hull per bar, from the same library the rest of the frame uses.
    for (const m of this.weights) attachOutlines(m, this.opts.materials);
  }

  /**
   * The 界行 — the column rules of a ruled record page.
   *
   * Painted into the GROUND, not the face, because they never change and a
   * repaint should not have to re-rule the page. They run the whole canvas, so
   * the scrolling window can never catch a rule ending.
   */
  private drawRules(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const weight = w * 0.011;
    for (const [i, x] of [w * 0.055, w * 0.5, w * 0.945].entries()) {
      pressedRule(ctx, x, -h * 0.01, x, h * 1.01, {
        pigment: RULE,
        band: 1,
        width: i === 1 ? weight * 0.8 : weight,
        alpha: i === 1 ? 0.5 : 0.66,
        wobble: weight * 1.4,
        seed: `rule${i}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Placement
  // -------------------------------------------------------------------------

  /**
   * Put the panels where the resting framing can see them.
   *
   * The only thing `resize` really changes about a scene-space HUD is whether it
   * is still in shot: at 16:9 the terrace is wide open beside the table, and at
   * 4:3 it is not. The panels slide in toward the table as the frame narrows,
   * stopping at the edge of the timber — past that they would be lying on the
   * table, which is a different object.
   */
  private placePanels(): void {
    const t = clamp((this.aspect - 1.15) / (1.7 - 1.15), 0, 1);
    const sideX = SIDE_X_MIN + (SIDE_X_WIDE - SIDE_X_MIN) * t;
    const bandX = BAND_X_MIN + (BAND_X_WIDE - BAND_X_MIN) * t;

    const scrollZ = SCROLL_Z;
    this.scroll.position.set(sideX, this.heightAt(sideX, scrollZ) + PANEL_LIFT, scrollZ);

    const slipZ = scrollZ - SCROLL_LEN / 2 - SLIP_GAP - SLIP_LEN / 2;
    this.slip.position.set(sideX, this.heightAt(sideX, slipZ) + PANEL_LIFT * 1.6, slipZ);
    // A slip of paper laid by hand is never square to the sheet below it.
    this.slip.rotation.y = -0.035;

    this.bandMesh.position.set(bandX, this.heightAt(bandX, 0) + PANEL_LIFT, 0);

    // The bars sit just inside the scroll's two ends, across it.
    const inset = SCROLL_LEN * 0.5 - 0.34;
    for (let i = 0; i < this.weights.length; i++) {
      const z = scrollZ + (i === 0 ? -inset : inset);
      const y = this.heightAt(sideX, z) + PANEL_LIFT * 2 + WEIGHT_H * 0.5;
      this.weights[i].position.set(sideX, y, z);
      this.weights[i].rotation.y = i === 0 ? 0.022 : -0.016;
    }
  }

  // -------------------------------------------------------------------------
  // Bus
  // -------------------------------------------------------------------------

  private subscribe(): void {
    this.unsubs.push(
      bus.on('move:end', ({ move, side, ply, notation }) => this.onMove(move, side, ply, notation)),
      bus.on('move:takeback', () => this.onTakeback()),
      bus.on('eval', ({ cp, mateIn }) => {
        this.reachTarget = reachFromCentipawns(cp, mateIn);
      }),
      bus.on('match:start', ({ difficulty }) => {
        this.difficulty = difficulty;
        this.reset();
      }),
      bus.on('match:reset', () => this.reset()),
      bus.on('check', () => {
        this.inCheck = true;
        this.slipDirty = true;
      }),
      bus.on('check:clear', () => {
        this.inCheck = false;
        this.slipDirty = true;
      }),
    );
  }

  private onMove(move: Move, side: Side, ply: number, notation: string): void {
    const captured = moveCaptured(move);
    this.entries.push({ ply, side, notation, captured });
    this.sideToMove = (side ^ 1) as Side;
    this.recordDirty = true;
    this.slipDirty = true;

    // The window only starts moving once the page is full; before that the new
    // row simply lands in an empty slot.
    const pairs = this.pairCount();
    const nextTop = Math.max(0, pairs - ROWS);
    if (nextTop > this.topPair) {
      this.topPair = nextTop;
      this.scrollSlideFrom = 1 / SLOTS;
      this.scrollSlide = this.scrollSlideFrom;
      this.scrollSlideT = 0;
    }

    if (captured) this.addFallen(captured);
  }

  private onTakeback(): void {
    const last = this.entries.pop();
    if (!last) return;
    this.sideToMove = last.side;
    this.recordDirty = true;
    this.slipDirty = true;
    this.topPair = Math.max(0, this.pairCount() - ROWS);
    this.scrollSlideT = 1;
    this.scrollSlide = 0;
    if (last.captured) this.removeLastFallen(pieceSide(last.captured));
  }

  private reset(): void {
    this.entries.length = 0;
    for (const f of this.fallen) this.disposeFallen(f);
    this.fallen.length = 0;
    this.topPair = 0;
    this.scrollSlide = 0;
    this.scrollSlideT = 1;
    this.sideToMove = Side.Red;
    this.inCheck = false;
    this.reach = 0;
    this.reachTarget = 0;
    this.recordDirty = true;
    this.slipDirty = true;
    this.bandDirty = true;
  }

  /**
   * Fold the ply list into printed rows.
   *
   * Red normally moves first, so this is usually just pairing off the list —
   * but a position loaded from a FEN can put Black on move, and a record whose
   * columns had silently swapped would be worse than one with a gap in it. A
   * row is closed when the side that would come next is already taken.
   *
   * Allocates, and is called only from a repaint and from a move landing —
   * never from the frame path.
   */
  private buildRows(): (RecordEntry | null)[][] {
    const rows: (RecordEntry | null)[][] = [];
    let row: (RecordEntry | null)[] | null = null;
    for (const e of this.entries) {
      const col = e.side === Side.Red ? 0 : 1;
      if (!row || row[col] !== null) {
        row = [null, null];
        rows.push(row);
      }
      row[col] = e;
    }
    return rows;
  }

  private pairCount(): number {
    return this.buildRows().length;
  }

  // -------------------------------------------------------------------------
  // The record
  // -------------------------------------------------------------------------

  private repaintRecord(): void {
    const ctx = this.scrollCtx;
    const w = this.scrollGround.width;
    const h = this.scrollGround.height;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.scrollGround, 0, 0);

    const slotH = h / SLOTS;
    const size = slotH * 0.208;
    const colX = [w * 0.725, w * 0.275]; // [Red, Black] — Red column read first

    const rows = this.buildRows();
    // `slot i` holds row topPair-1+i, so slot 0 is the row that has just
    // scrolled off the top and slot SLOTS-1 is the newest.
    for (let i = 0; i < SLOTS; i++) {
      const r = this.topPair - 1 + i;
      if (r < 0 || r >= rows.length) continue;
      const y0 = i * slotH + slotH * 0.09;
      for (let col = 0; col < 2; col++) {
        const entry = rows[r][col];
        if (!entry) continue;
        const ink = RECORD_INK[entry.side];
        inkedRun(ctx, entry.notation, colX[col], y0, size, {
          vertical: true,
          align: 'center',
          pigment: ink.pigment,
          band: ink.band,
          bleed: 0.2,
          // The freshest move is still wet; older ones have dried back a little.
          alpha: r === rows.length - 1 ? 1 : 0.9,
          loadFrom: 1.0,
          loadTo: 0.84,
        });
      }
    }

    this.scrollTex.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // The title slip
  // -------------------------------------------------------------------------

  private repaintSlip(): void {
    const ctx = this.slipCtx;
    const w = this.slipGround.width;
    const h = this.slipGround.height;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.slipGround, 0, 0);

    const reserve = band(PAPER, PAPER_BAND);

    // --- 難度 and the tier, at the head -------------------------------------
    const sealW = w * 0.3;
    const sealH = h * 0.4;
    const sealX = w * 0.63;
    const sealY = h * 0.075;
    sealCartouche(ctx, sealX, sealY, sealW, sealH, {
      text: DIFFICULTY[this.difficulty].label,
      pigment: SEAL,
      pigmentBand: 1,
      reserve,
      fill: 0.82,
      seed: `tier:${this.difficulty}`,
    });
    const labelSize = sealH * 0.28;
    inkedRun(ctx, '難度', w * 0.34, sealY + sealH * 0.5 - labelSize, labelSize, {
      vertical: true,
      align: 'center',
      pigment: 'ink',
      band: 1,
      alpha: 0.72,
      bleed: 0.18,
    });

    // --- the two armies, as column heads ------------------------------------
    const headSize = h * 0.2;
    const headY = h * 0.6;
    for (const side of [Side.Red, Side.Black] as const) {
      const x = side === Side.Red ? w * 0.725 : w * 0.275;
      const active = this.sideToMove === side;
      const lacquer: PigmentName = side === Side.Red ? 'cinnabar' : 'ink';
      drawText(ctx, side === Side.Red ? '漢' : '楚', x, headY, headSize, {
        vertical: true,
        align: 'center',
        pigment: lacquer,
        band: active ? 1 : 2,
        alpha: active ? 1 : 0.36,
        widthScale: active ? 1.06 : 0.92,
        bleed: active ? 0.24 : 0.12,
      });
      if (!active) continue;
      // The army to move is the one the scorer has marked. A pressed ring, not
      // a highlight: this is a record, and a record gets annotated in cinnabar.
      this.drawTurnRing(ctx, x, headY + headSize * 0.5, headSize * 0.82);
    }

    // --- 將軍 -----------------------------------------------------------------
    if (this.inCheck) {
      const s = h * 0.12;
      inkedRun(ctx, '將軍', w * 0.5, h * 0.845 - s, s, {
        vertical: false,
        align: 'center',
        pigment: SEAL,
        band: 1,
        widthScale: 1.15,
        bleed: 0.3,
      });
    }

    this.slipTex.needsUpdate = true;
  }

  /** A hand-drawn cinnabar ring, the way a move is marked on a paper record. */
  private drawTurnRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = band(SEAL, 2);
    ctx.beginPath();
    const steps = 48;
    // Out along the outer edge and back along the inner one: a closed ribbon,
    // so the ring can vary in weight the way a brushed circle does.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i <= steps; i++) {
        const k = pass === 0 ? i : steps - i;
        const a = (k / steps) * Math.PI * 2 - 0.5;
        const wobble = 1 + 0.045 * Math.sin(a * 3.1 + 1.2) + 0.03 * Math.sin(a * 5.7);
        const weight = r * (0.052 + 0.03 * Math.sin(a * 2.2 + 0.4));
        const rad = r * wobble + (pass === 0 ? weight : -weight);
        const px = cx + Math.cos(a) * rad;
        const py = cy + Math.sin(a) * rad * 1.06;
        if (pass === 0 && i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // The eval silk
  // -------------------------------------------------------------------------

  private repaintBand(): void {
    const ctx = this.bandCtx;
    const w = this.bandGround.width;
    const h = this.bandGround.height;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.bandGround, 0, 0);

    // The river, drawn where the board's river is: this strip is aligned with
    // the board, and the mark is what makes "even" readable as a position
    // rather than as an absence.
    pressedRule(ctx, w * 0.1, h * 0.5, w * 0.9, h * 0.5, {
      pigment: 'ink',
      band: 1,
      width: w * 0.035,
      alpha: 0.5,
      seed: 'river',
    });

    // Army names at their own ends. Canvas top is world -Z, which is Black's.
    const size = w * 0.6;
    drawText(ctx, '楚', w * 0.5, h * 0.022, size, {
      align: 'center',
      pigment: 'ink',
      band: 1,
      alpha: 0.8,
      bleed: 0.22,
    });
    drawText(ctx, '漢', w * 0.5, h - h * 0.022 - size, size, {
      align: 'center',
      pigment: 'cinnabar',
      band: 1,
      alpha: 0.8,
      bleed: 0.22,
    });

    this.bandTex.needsUpdate = true;
  }

  /** Push the stain's colour: the leader's lacquer, laid on the loser's half. */
  private pushInkColour(): void {
    const lacquer: PigmentName = this.inkSide === Side.Red ? 'cinnabar' : 'inkLacquer';
    (this.bandMat.uniforms.uInk.value as THREE.Color).setStyle(
      band(lacquer, 1),
      THREE.SRGBColorSpace,
    );
    (this.bandMat.uniforms.uInkFront.value as THREE.Color).setStyle(
      band(lacquer, 0),
      THREE.SRGBColorSpace,
    );
  }

  // -------------------------------------------------------------------------
  // The fallen
  // -------------------------------------------------------------------------

  private addFallen(code: PieceCode): void {
    const side = pieceSide(code);
    const type = pieceType(code);
    if (type === PieceType.None) return;

    let variant = 0;
    for (const f of this.fallen) if (f.side === side && f.type === type) variant++;

    let unit: UnitInstance;
    try {
      unit = this.opts.characters.create(side, type, variant);
    } catch (err) {
      console.warn('[hud] could not build a fallen figure', GLYPH[side][type], err);
      return;
    }

    unit.root.scale.multiplyScalar(FALLEN_SCALE);

    const body = new THREE.Group();
    body.add(unit.root);
    const pivot = new THREE.Group();
    pivot.add(body);
    this.fallenGroup.add(pivot);
    if (this.opts.dress) this.opts.dress(unit.root);

    // Deterministic per-body jitter: the same capture always falls the same way.
    const rng = seedFor('hud', 'fallen', side, type, variant);
    const extent = Math.max(unit.meta.size[1], unit.meta.size[2]) * FALLEN_SCALE * 1.22 + 0.1;

    this.fallen.push({
      unit,
      pivot,
      body,
      side,
      type,
      extent,
      t: 0,
      // The topple lays the figure down; the yaw then turns it along its army's
      // rail. Together they put every body head-toward-home and face-toward-the
      // -board — Red on the +X rail looking back at the position it died in,
      // Black mirrored on -X. Work the two rotations through in that order
      // before changing either sign; they are not independent.
      topple: Math.PI / 2 + rng.range(-0.13, 0.13),
      yaw: (side === Side.Red ? 1 : -1) * (Math.PI / 2) + rng.range(-0.2, 0.2),
      lift: unit.meta.size[0] * FALLEN_SCALE * 0.24,
      baseY: 0,
    });
    this.railDirty = true;
  }

  private removeLastFallen(side: Side): void {
    for (let i = this.fallen.length - 1; i >= 0; i--) {
      if (this.fallen[i].side !== side) continue;
      this.disposeFallen(this.fallen[i]);
      this.fallen.splice(i, 1);
      this.railDirty = true;
      return;
    }
  }

  private disposeFallen(f: Fallen): void {
    if (this.opts.undress) this.opts.undress(f.unit.root);
    f.pivot.removeFromParent();
    f.unit.dispose();
  }

  /**
   * Lay the bodies out along their army's rail.
   *
   * Called only when the set changes, never per frame. Spacing comes from each
   * unit's own size, so an elephant handler takes the room an elephant handler
   * takes; if the rail runs out the whole row is compressed rather than letting
   * the last body walk off the table.
   */
  private layoutRail(): void {
    for (const side of [Side.Red, Side.Black] as const) {
      let total = 0;
      for (const f of this.fallen) if (f.side === side) total += f.extent;
      const available = RAIL_HALF_Z * 2;
      const squeeze = total > available ? available / total : 1;

      // Red's rail fills from Red's end (+Z) back toward the river; Black's
      // mirrors it. The dead lie nearest their own house.
      const dir = side === Side.Red ? -1 : 1;
      const start = side === Side.Red ? RAIL_HALF_Z : -RAIL_HALF_Z;
      const x = side === Side.Red ? RAIL_X : -RAIL_X;
      let run = 0;
      for (const f of this.fallen) {
        if (f.side !== side) continue;
        const step = f.extent * squeeze;
        const z = start + dir * (run + step * 0.5);
        run += step;
        f.baseY = this.heightAt(x, z);
        f.pivot.position.set(x, f.baseY + f.lift * Math.sin(f.body.rotation.z), z);
        f.pivot.rotation.y = f.yaw;
      }
    }
    this.railDirty = false;
  }

  // -------------------------------------------------------------------------
  // Hud
  // -------------------------------------------------------------------------

  update(dt: number): void {
    // One repaint per panel per frame at most, whatever the bus did this tick.
    if (this.recordDirty) {
      this.repaintRecord();
      this.recordDirty = false;
    }
    if (this.slipDirty) {
      this.repaintSlip();
      this.slipDirty = false;
    }
    if (this.bandDirty) {
      this.repaintBand();
      this.bandDirty = false;
    }
    if (this.railDirty) this.layoutRail();

    // --- the stain -----------------------------------------------------------
    if (this.reach !== this.reachTarget) {
      const next = damp(this.reach, this.reachTarget, INK_RATE, dt);
      this.reach = Math.abs(next - this.reachTarget) < 1e-4 ? this.reachTarget : next;
      // The lead changing hands changes which lacquer is on the silk. Nothing
      // repaints — it is one uniform — but it has to happen on the frame the
      // stain passes the river, not the next time the evaluation lands.
      const side: Side = this.reach >= 0 ? Side.Red : Side.Black;
      if (side !== this.inkSide) {
        this.inkSide = side;
        this.pushInkColour();
      }
      this.bandMat.uniforms.uReach.value = this.reach;
    }

    // --- the scroll ----------------------------------------------------------
    if (this.scrollSlideT < 1) {
      this.scrollSlideT = Math.min(1, this.scrollSlideT + dt / SCROLL_TIME);
      this.scrollSlide = this.scrollSlideFrom * (1 - easeOutCubic(this.scrollSlideT));
      (this.scrollMat.uniforms.uWindow.value as THREE.Vector2).x = this.scrollSlide;
    }

    // --- the fallen ----------------------------------------------------------
    for (let i = 0; i < this.fallen.length; i++) {
      const f = this.fallen[i];
      if (f.t >= 1) continue;
      f.t = Math.min(1, f.t + dt / FALL_TIME);
      // easeOutBack so the body lands with weight and rocks once, rather than
      // easing gracefully onto the timber like a placed object.
      const a = f.topple * easeOutBack(f.t, 1.35);
      f.body.rotation.z = a;
      f.pivot.position.y = f.baseY + f.lift * Math.sin(a);
    }
  }

  resize(w: number, h: number, dpr: number): void {
    this.aspect = w / Math.max(h, 1);
    this.placePanels();

    // Repainting three grounds is tens of milliseconds, so only do it when the
    // pixel budget really moved — a window drag across two monitors, not a
    // resize handle.
    const wanted = TEXELS_PER_UNIT * clamp(dpr, 1, MAX_DPR);
    if (Math.abs(wanted - this.texelScale) / this.texelScale > 0.25) {
      this.texelScale = wanted;
      this.rebuildCanvases();
    }
  }

  private rebuildCanvases(): void {
    this.scroll.removeFromParent();
    this.slip.removeFromParent();
    this.bandMesh.removeFromParent();
    this.disposePanels();
    this.buildScroll();
    this.buildSlip();
    this.buildBand();
    this.placePanels();
    // The stone bars are geometry, not canvas, so they survive the rebuild.
    this.pushInkColour();
    this.bandMat.uniforms.uReach.value = this.reach;
    (this.scrollMat.uniforms.uWindow.value as THREE.Vector2).x = this.scrollSlide;
    this.recordDirty = true;
    this.slipDirty = true;
    this.bandDirty = true;
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }
  isVisible(): boolean {
    return this.group.visible;
  }

  setDifficulty(d: Difficulty): void {
    if (d === this.difficulty) return;
    this.difficulty = d;
    this.slipDirty = true;
  }

  syncRecord(moves: readonly Move[], notation: readonly string[], firstSide = Side.Red): void {
    this.reset();
    for (let i = 0; i < moves.length; i++) {
      const side = ((firstSide ^ (i & 1)) as Side);
      this.entries.push({
        ply: i + 1,
        side,
        notation: notation[i] ?? '',
        captured: moveCaptured(moves[i]),
      });
      const captured = moveCaptured(moves[i]);
      if (captured) this.addFallen(captured);
    }
    this.sideToMove = ((firstSide ^ (moves.length & 1)) as Side);
    this.topPair = Math.max(0, this.pairCount() - ROWS);
    // A resumed game did not just play its last move, so nothing slides and
    // nothing topples: the bodies are already on the rail.
    this.scrollSlideT = 1;
    this.scrollSlide = 0;
    for (const f of this.fallen) {
      f.t = 1;
      f.body.rotation.z = f.topple;
    }
    this.recordDirty = true;
    this.slipDirty = true;
  }

  private disposePanels(): void {
    this.scroll.geometry.dispose();
    this.slip.geometry.dispose();
    this.bandMesh.geometry.dispose();
    this.scrollMat.dispose();
    this.slipMat.dispose();
    this.bandMat.dispose();
    this.scrollTex.dispose();
    this.slipTex.dispose();
    this.bandTex.dispose();
    this.bandField.dispose();
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    for (const f of this.fallen) this.disposeFallen(f);
    this.fallen.length = 0;
    this.disposePanels();
    // The bars share one geometry and a cached library material; only the
    // geometry and the hulls are ours to release.
    if (this.weights.length) this.weights[0].geometry.dispose();
    for (const m of this.weights) {
      for (const child of [...m.children]) {
        const hull = child as THREE.Mesh;
        if (hull.isMesh) hull.geometry.dispose();
        child.removeFromParent();
      }
      m.removeFromParent();
    }
    this.weights.length = 0;
    this.group.removeFromParent();
  }
}

/**
 * Build the HUD.
 *
 * ```ts
 * const hud = createHud({
 *   materials: pipeline.materials,
 *   characters,
 *   heightAt: rig.heightAt,
 *   dress: (root) => hudCollapses.set(root, collapseToAtlas(root, pipeline.materials, {})),
 *   undress: (root) => { const c = hudCollapses.get(root); if (c) disposeCollapse(c); },
 *   difficulty: match.difficulty,
 *   width: window.innerWidth, height: window.innerHeight, dpr: startDpr,
 * });
 * scene.add(hud.group);
 * ```
 *
 * Then `hud.update(dt)` once per frame, after `rig.update(dt)` and before
 * `pipeline.render()`, and `hud.resize(w, h, dpr)` from the resize handler.
 */
export function createHud(opts: HudOptions): SceneHud {
  return new InSceneHud(opts);
}
