/**
 * Review mode, painted into the scene.
 *
 * The same rule as `ui/hud.ts`: there is no DOM here. What the player reads
 * during a post-mortem is a second set of sheets on the terrace, made of the
 * same paper, ruled with the same 界行, inked with the same seal script and
 * dragged through the same post chain. Three objects:
 *
 *   1. THE MARKED RECORD (評點棋譜) — the whole game as a ruled two-column sheet,
 *      Red on the right, and beside each move the critic's mark in the column's
 *      own margin. The row under examination is called out by a pressed cinnabar
 *      bar in the outer margin; every other row is dried back.
 *   2. THE HEAD SLIP — a 覆盤 seal, the army that moved, and the engine's
 *      preferred line from that same position set in the two armies' lacquers at
 *      half strength, so it reads as a variation rather than as play.
 *   3. THE EVAL SILK — the same ink-in-silk bleed the HUD's own evaluation band
 *      uses, in the same slot on the far side of the board, because the HUD is
 *      down while review is up and that reading is one the player has already
 *      been taught. It shows where the engine put the position *after* the move
 *      under examination, so stepping back through the game drags the ink across
 *      the strip.
 *
 * A fourth object, the ACTION SLIP, is not part of review: it is a small square
 * of paper that surfaces beside the record's foot to acknowledge a 提示 or a
 * 悔棋 and then fades. It lives here because it is made of the same paper and
 * driven by the same repaint discipline, and it is deliberately outside the
 * group `setVisible` switches — a takeback happens during play, not review.
 *
 * ── The marks are drawn, not set ────────────────────────────────────────────
 *
 * `game/annotate.ts` names the six qualities in Chinese — 妙手 佳著 緩著 失著
 * 漏著 — and of those eleven characters the seal roster in `ui/glyphs.ts` holds
 * exactly one (手). Setting the labels would put a tofu box beside every judged
 * move, which is worse than saying nothing. So the judgement is carried the way
 * a Chinese critic has always carried it in a margin: 圈點, drawn marks.
 *
 *     妙手  密圈    two concentric brushed rings, gold
 *     佳著  單圈    one brushed ring, gold
 *     緩著  頓點    one wedge dot, ink
 *     失著  撇      one cinnabar slash
 *     漏著  雙撇    two cinnabar slashes
 *
 * The pigments are not invented here — they are `Annotation.tone` verbatim, so
 * the gold/ink/cinnabar assignment still comes from `annotate.ts`. Only the
 * glyph is substituted, and the substitution is a stronger form for a margin
 * than two characters would have been anyway.
 *
 * ── Orientation, restated ───────────────────────────────────────────────────
 *
 * Every panel is a `PlaneGeometry` rotated -90° about X, exactly as in `hud.ts`:
 *
 *     canvas TOP  = world -Z = the far end = the top of the page
 *     canvas LEFT = world -X = toward the board
 *
 * so the Red column is painted on the RIGHT of the canvas, because a 棋譜 is
 * read right column first, and a column's marginal marks sit to the RIGHT of
 * the text they judge — which is where the eye goes next.
 */

import * as THREE from 'three';

import { band, type PigmentName } from '@core/palette.ts';
import { seedFor } from '@core/rng.ts';
import { Noise } from '@core/noise.ts';
import { numeral } from '@core/coords.ts';
import { clamp, damp, easeOutCubic, Side, type MoveQuality } from '@core/types.ts';

import { bakeBleedField, createInkBleedMaterial, reachFromCentipawns } from '@ui/inkbleed.ts';
import {
  deckle,
  inkedRun,
  makeCanvas,
  paintGround,
  pressedRule,
  sealCartouche,
} from '@ui/paper.ts';
import { drawText, hasSealGlyph } from '@ui/seal.ts';

// ===========================================================================
// What the panel is told about
// ===========================================================================

/** Which pigment a mark is drawn in. Mirrors `Annotation['tone']` exactly. */
export type MarkTone = 'gold' | 'ink' | 'cinnabar';

/**
 * One judged ply. Everything here is already resolved by `game/assist.ts`; the
 * panel does no chess and no arithmetic beyond laying out what it is handed.
 */
export interface ReviewRow {
  /** 1-based ply number, as the record counts it. */
  ply: number;
  side: Side;
  /** Traditional relative notation, e.g. 炮二平五. */
  notation: string;
  /** `null` until the analysis run has reached this ply. */
  quality: MoveQuality | null;
  tone: MarkTone;
  /** The engine's preferred line from the position BEFORE this move. */
  bestNotation: readonly string[];
  /** Evaluation after this move, centipawns, Red's point of view. */
  cp: number;
  /** Set when that evaluation is a forced mate. Positive = Red mates. */
  mateIn: number | null;
}

export interface ReviewPanelOptions {
  /** Board surface height at a world point — `BoardScene.heightAt`. */
  heightAt?: (x: number, z: number) => number;
  width: number;
  height: number;
  dpr: number;
}

export interface ReviewPanel {
  /**
   * Add this to the `THREE.Scene`. It stays visible: `setVisible` controls the
   * review sheets inside it, and the action slip has to be able to surface
   * during ordinary play, when review is down.
   */
  readonly group: THREE.Group;
  /** Replace the whole record. Cheap to call repeatedly as analysis lands. */
  setRows(rows: readonly ReviewRow[]): void;
  /** Which ply is under examination, 1-based. 0 parks the cursor at the head. */
  setCursor(ply: number): void;
  readonly cursor: number;
  /** Raise a transient slip, e.g. 提示 or 悔棋. Empty text lowers it early. */
  announce(text: string, seconds?: number): void;
  setVisible(on: boolean): void;
  isVisible(): boolean;
  update(dt: number): void;
  resize(w: number, h: number, dpr: number): void;
  dispose(): void;
}

// ===========================================================================
// Layout — world units, all of it here
// ===========================================================================

/**
 * Texels per world unit. Matched to `hud.ts`: the two sets of sheets share a
 * terrace and must not differ in grain, and seal script needs roughly 2x
 * supersampling at the resting framing to keep its counters open.
 */
const TEXELS_PER_UNIT = 150;
const MAX_DPR = 2;
const PANEL_LIFT = 0.007;

/**
 * Visible move-pairs, and the slots the canvas actually holds.
 *
 * TWO spare slots, not one. The HUD's record only ever scrolls forward, so one
 * spare above the window is enough for it. Review is read backwards — stepping
 * back a ply is the whole gesture — and the window therefore has to be able to
 * start its slide from EITHER side of its resting place. With the window
 * resting one slot down the canvas, a forward step starts at 2/SLOTS and a
 * backward step at 0, and neither ever samples off the sheet.
 */
const ROWS = 4;
const SLOTS = ROWS + 2;
/** Where the window sits between slides, in v units. */
const REST_OFFSET = 1 / SLOTS;

const REC_W = 1.42;
const SLOT_LEN = 1.75;
const REC_LEN = ROWS * SLOT_LEN; // 7.0
const REC_Z = 0.1;

const SLIP_W = REC_W;
const SLIP_LEN = 2.9;
const SLIP_GAP = 0.16;

/**
 * X of the sheets' centre, and how far in they may be pulled on a narrow frame.
 *
 * Deliberately the same window `hud.ts` measured: the review sheets take the
 * record scroll's slot on the terrace (the HUD is hidden while review is up),
 * so they inherit its clearances — outside the fallen bodies' screen-space
 * projection at about x = 6.3, inside the terrace's near-edge limit at 8.1.
 */
const SIDE_X_WIDE = 7.5;
const SIDE_X_MIN = 6.8;

/**
 * The eval silk takes the HUD's own band slot on the far side of the board —
 * same width, same length, same X window — because the HUD is down while review
 * is up and that strip is the reading the player has already been taught. A
 * second, differently shaped evaluation strip would be a second grammar for one
 * fact.
 */
const EVAL_W = 0.86;
const EVAL_LEN = 9.0;
const EVAL_X_WIDE = -7.0;
const EVAL_X_MIN = -6.6;

/** The transient 提示 / 悔棋 slip, beyond the record's foot. */
const ACT_SIZE = 0.92;
const ACT_Z = REC_Z + REC_LEN / 2 + 0.26 + ACT_SIZE / 2;

/** Seconds the sheet takes to slide one row, and how fast the ink chases. */
const SCROLL_TIME = 0.42;
const INK_RATE = 1.35;
/** Seconds the action slip takes to rise and to fade once its hold is over. */
const ACT_RISE = 0.18;
const ACT_FADE = 0.55;

// --- pigments --------------------------------------------------------------

const PAPER: PigmentName = 'shellWhite';
const PAPER_BAND = 2;
const PAPER_AGE: PigmentName = 'ochre';
/** See `hud.ts`: an unlit sheet has to be authored below the picture's key. */
const PAPER_LIGHTEN = -0.15;
const SILK: PigmentName = 'gamboge';
const RULE: PigmentName = 'ochre';
const SEAL: PigmentName = 'cinnabar';

/** Ink each army's moves are recorded in. Identical to the HUD's record. */
const RECORD_INK: Record<Side, { pigment: PigmentName; band: 0 | 1 | 2 | 3 }> = {
  [Side.Red]: { pigment: 'cinnabar', band: 1 },
  [Side.Black]: { pigment: 'ink', band: 1 },
};

/** Pigment and band for each mark tone. `tone` comes straight from annotate.ts. */
const TONE_INK: Record<MarkTone, { pigment: PigmentName; band: 0 | 1 | 2 | 3 }> = {
  gold: { pigment: 'gold', band: 1 },
  ink: { pigment: 'ink', band: 1 },
  cinnabar: { pigment: 'cinnabar', band: 1 },
};

// --- canvas-normalised column geometry -------------------------------------
// Canvas right is world +X, i.e. away from the board, so Red — read first —
// takes the right half and each column's marks sit to the right of its text.

const RULE_X = [0.072, 0.5, 0.948];
/**
 * [Red, Black] text centres and mark centres, as fractions of the width.
 *
 * A glyph is 0.19 of a slot, i.e. 0.33 world, and a mark spans about 0.30, so
 * each pair has to sit inside its own 0.455-wide column without the mark
 * touching either the centre rule or the sheet's torn edge. These are the
 * numbers that hold with a little air on both sides.
 */
const TEXT_X = [0.63, 0.185];
const MARK_X = [0.865, 0.385];
/** The cursor bar, in the outer margin past the last rule. */
const CURSOR_X = 0.032;

// ===========================================================================
// Shared bits — same construction as the HUD's panels
// ===========================================================================

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
 * A sheet with a scrolling window and soft ends. Same shader as the HUD's — the
 * uv window is applied in the fragment stage because a raw `ShaderMaterial`
 * never receives three's uv transform.
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
  float ends = 1.0;
  // smoothstep with edge0 == edge1 divides by zero, and a sheet whose ends are
  // cut rather than faded is a legitimate ask.
  if (uEndFade > 0.0) {
    ends = smoothstep(0.0, uEndFade, vUv.y) * smoothstep(1.0, 1.0 - uEndFade, vUv.y);
  }
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

/** A flat quad in the XZ plane, textured, long axis along Z. */
function makePanel(worldW: number, worldL: number, material: THREE.Material): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(worldW, worldL, 1, 1);
  const mesh = new THREE.Mesh(geo, material);
  // YXZ so X lays the sheet flat first and Y then spins it on the table.
  mesh.rotation.order = 'YXZ';
  mesh.rotation.x = -Math.PI / 2;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // Flat sheets on a flat terrace never occlude each other; keeping them off
  // the depth buffer keeps them out of the opaque sort entirely.
  mesh.renderOrder = 5;
  return mesh;
}

// ===========================================================================
// The marks
// ===========================================================================

/**
 * A brushed ring — 圈.
 *
 * Drawn out along the outer edge and back along the inner one so the ring is a
 * closed ribbon whose weight can vary the way a brushed circle's does. A
 * constant-width `arc()` stroke is the single most recognisable "a browser drew
 * this" tell available, and this mark sits next to hand-cut seal script.
 */
function brushRing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  weight: number,
  colour: string,
  alpha: number,
  phase: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  ctx.beginPath();
  const steps = 40;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i <= steps; i++) {
      const k = pass === 0 ? i : steps - i;
      const a = (k / steps) * Math.PI * 2 - 0.6 + phase;
      const wobble = 1 + 0.05 * Math.sin(a * 3.1 + phase) + 0.032 * Math.sin(a * 5.7 - phase);
      // The brush is loaded where it lands and starves as it comes round.
      const w = weight * (0.62 + 0.38 * Math.sin(a * 2.0 + 0.5 + phase));
      const rad = r * wobble + (pass === 0 ? w : -w);
      const px = cx + Math.cos(a) * rad;
      const py = cy + Math.sin(a) * rad * 1.05;
      if (pass === 0 && i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * One tapered stroke — the 撇 of a critic's slash and the 點 of a dot are the
 * same gesture at different lengths. Heavy where the brush lands, starving to a
 * point where it lifts, with a small seeded bow so no two are identical.
 */
function brushStroke(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  weight: number,
  colour: string,
  alpha: number,
  bow: number,
  n: Noise,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return;
  const nx = -dy / len;
  const ny = dx / len;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  ctx.beginPath();
  const steps = 22;
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i <= steps; i++) {
      const k = side === 0 ? i : steps - i;
      const t = k / steps;
      // Pressure: full at the landing, gone at the lift. `1 - t^1.6` starves
      // late rather than linearly, which is what a lifting brush does.
      const press = Math.pow(1 - t, 1.6) * 0.82 + 0.18 * (1 - t);
      const half = weight * 0.5 * press * (side === 0 ? 1 : -1);
      // A drawn slash bows; a ruled one is a UI rule.
      const arc = Math.sin(Math.PI * t) * bow + (n.value2(t * 7, side * 3.3) - 0.5) * weight * 0.4;
      const px = x0 + dx * t + nx * (half + arc);
      const py = y0 + dy * t + ny * (half + arc);
      if (side === 0 && i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * The critic's mark for one quality, centred on (cx, cy) in a box of radius `r`.
 *
 * `ok` draws nothing at all: a record that marks every ordinary move has no
 * marks, only decoration, and the eye stops seeing the ones that matter.
 */
function paintMark(
  ctx: CanvasRenderingContext2D,
  quality: MoveQuality,
  tone: MarkTone,
  cx: number,
  cy: number,
  r: number,
  seed: string,
): void {
  if (quality === 'ok') return;
  const { pigment, band: b } = TONE_INK[tone];
  const colour = band(pigment, b);
  const rng = seedFor('review', 'mark', seed);
  const n = new Noise(rng.int(1, 0x7fffffff));
  const phase = rng.range(-0.5, 0.5);

  switch (quality) {
    case 'brilliant':
      // 密圈: two rings. The inner one is lighter, so the pair reads as one
      // emphatic mark rather than as two separate judgements.
      brushRing(ctx, cx, cy, r * 0.95, r * 0.15, colour, 0.95, phase);
      brushRing(ctx, cx, cy, r * 0.52, r * 0.14, colour, 0.7, phase + 1.9);
      break;
    case 'strong':
      brushRing(ctx, cx, cy, r * 0.88, r * 0.17, colour, 0.9, phase);
      break;
    case 'inaccuracy': {
      // 頓點: the brush lands, presses and lifts on the spot. Punctuation
      // scale, deliberately — 緩著 is the mildest thing the record can say and
      // a mark the size of a slash would shout it.
      const d = r * 0.42;
      brushStroke(ctx, cx - d * 0.4, cy - d, cx + d * 0.55, cy + d, r * 0.66, colour, 0.85, r * 0.06, n);
      break;
    }
    case 'mistake':
      // 撇: one slash, top-right to bottom-left, taken right across the margin
      // so it cannot be mistaken for punctuation.
      brushStroke(ctx, cx + r * 0.72, cy - r * 1.15, cx - r * 0.72, cy + r * 1.15, r * 0.4, colour, 0.95, r * 0.18, n);
      break;
    case 'blunder':
      // 雙撇: struck twice. Worse is more strokes, not a different symbol — an
      // ordinal read needs no legend.
      brushStroke(ctx, cx + r * 0.95, cy - r * 1.2, cx - r * 0.5, cy + r * 1.1, r * 0.42, colour, 0.97, r * 0.18, n);
      brushStroke(ctx, cx + r * 0.42, cy - r * 1.05, cx - r * 1.05, cy + r * 1.25, r * 0.38, colour, 0.88, r * 0.16, n);
      break;
    default:
      break;
  }
}

// ===========================================================================
// Notation the roster can actually set
// ===========================================================================

/**
 * Substitute the one character ordinary play produces that the seal roster does
 * not hold.
 *
 * `moveToNotation` writes 中 for the middle of three like pieces on a file, and
 * 中 is not authored — it would come out as a tofu box in the middle of the
 * record. For four or five on a file the same function already numbers them
 * from the front with the side's own numerals, so numbering the middle of three
 * the same way is not an invention: it is the convention that file already uses
 * one rank up, and both numerals are in the roster.
 *
 * Anything else missing is left alone deliberately. Tofu is how a roster gap
 * announces itself, and silently swallowing an unknown character would hide the
 * next gap instead of reporting it.
 */
function settable(text: string, side: Side): string {
  if (!text.includes('中')) return text;
  return text.replace('中', numeral(2, side));
}

// ===========================================================================
// The panel
// ===========================================================================

class ScenePanel implements ReviewPanel {
  readonly group = new THREE.Group();
  /**
   * The three review sheets. Held apart from `group` so the action slip — which
   * acknowledges a 提示 or a 悔棋 during ordinary play — is not switched off
   * along with them.
   */
  private readonly sheets = new THREE.Group();

  private readonly opts: ReviewPanelOptions;
  private readonly heightAt: (x: number, z: number) => number;

  // --- record ---------------------------------------------------------------
  private rec!: THREE.Mesh;
  private recMat!: THREE.ShaderMaterial;
  private recTex!: THREE.CanvasTexture;
  private recCtx!: CanvasRenderingContext2D;
  private recGround!: HTMLCanvasElement;

  // --- head slip ------------------------------------------------------------
  private slip!: THREE.Mesh;
  private slipMat!: THREE.ShaderMaterial;
  private slipTex!: THREE.CanvasTexture;
  private slipCtx!: CanvasRenderingContext2D;
  private slipGround!: HTMLCanvasElement;

  // --- eval silk ------------------------------------------------------------
  private evalMesh!: THREE.Mesh;
  private evalMat!: THREE.ShaderMaterial;
  private evalTex!: THREE.CanvasTexture;
  private evalCtx!: CanvasRenderingContext2D;
  private evalGround!: HTMLCanvasElement;
  private evalField!: THREE.DataTexture;

  // --- action slip ----------------------------------------------------------
  private act!: THREE.Mesh;
  private actMat!: THREE.ShaderMaterial;
  private actTex!: THREE.CanvasTexture;
  private actCtx!: CanvasRenderingContext2D;
  private actGround!: HTMLCanvasElement;

  // --- model ----------------------------------------------------------------
  private rows: ReviewRow[] = [];
  private cursorPly = 0;
  private actText = '';
  private actHold = 0;
  private actAmount = 0;

  // --- animated state (allocation-free past construction) -------------------
  private reach = 0;
  private reachTarget = 0;
  private inkSide: Side = Side.Red;
  private slide = REST_OFFSET;
  private slideFrom = REST_OFFSET;
  private slideT = 1;
  /** How many pairs the top of the visible window has advanced by. */
  private topPair = 0;

  // --- dirty flags ----------------------------------------------------------
  private recDirty = true;
  private slipDirty = true;
  private evalDirty = true;
  private actDirty = true;

  private texelScale = TEXELS_PER_UNIT;
  private aspect = 16 / 9;

  constructor(opts: ReviewPanelOptions) {
    this.opts = opts;
    this.heightAt = opts.heightAt ?? (() => 0);
    this.group.name = 'review';
    this.sheets.name = 'review/sheets';
    // Review is a mode, not a fixture. The sheets arrive with the mode.
    this.sheets.visible = false;
    this.group.add(this.sheets);

    this.texelScale = TEXELS_PER_UNIT * clamp(opts.dpr, 1, MAX_DPR);
    this.aspect = opts.width / Math.max(opts.height, 1);

    this.buildRecord();
    this.buildSlip();
    this.buildEval();
    this.buildAction();
    this.place();
    this.pushInkColour();
  }

  get cursor(): number {
    return this.cursorPly;
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private buildRecord(): void {
    const w = Math.round(REC_W * this.texelScale);
    const h = Math.round(SLOTS * SLOT_LEN * this.texelScale);

    const ground = makeCanvas(w, h);
    paintGround(ground.ctx, w, h, {
      ground: PAPER,
      groundBand: PAPER_BAND,
      age: PAPER_AGE,
      ageBand: 1,
      // A sheet that has been taken out and gone over is handled more than the
      // one that was being written on, so this one is aged a little harder than
      // the HUD's record.
      ageAmount: 0.5,
      weave: 0.16,
      fibre: 0.46,
      tooth: 0.55,
      wear: 0.44,
      lighten: PAPER_LIGHTEN,
      seed: 'review-record',
    });
    // Sides only: the ends run off the visible window, and a torn end that
    // scrolled past would give the illusion away.
    deckle(ground.ctx, w, h, { sides: w * 0.014, ends: 0, seed: 'review-record' });
    this.drawRules(ground.ctx, w, h);
    this.recGround = ground.canvas;

    const face = makeCanvas(w, h);
    this.recCtx = face.ctx;
    this.recTex = makePanelTexture(face.canvas);
    this.recMat = createPanelMaterial(this.recTex, 0.022);
    (this.recMat.uniforms.uWindow.value as THREE.Vector2).set(REST_OFFSET, ROWS / SLOTS);
    this.rec = makePanel(REC_W, REC_LEN, this.recMat);
    this.sheets.add(this.rec);
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
      ageAmount: 0.46,
      weave: 0.16,
      fibre: 0.4,
      tooth: 0.55,
      wear: 0.5,
      lighten: PAPER_LIGHTEN,
      seed: 'review-slip',
    });
    deckle(ground.ctx, w, h, { sides: w * 0.016, ends: w * 0.016, seed: 'review-slip' });
    this.slipGround = ground.canvas;

    const face = makeCanvas(w, h);
    this.slipCtx = face.ctx;
    this.slipTex = makePanelTexture(face.canvas);
    // A whole sheet: its own torn edge is the silhouette, so nothing is faded.
    this.slipMat = createPanelMaterial(this.slipTex, 0);
    this.slip = makePanel(SLIP_W, SLIP_LEN, this.slipMat);
    this.sheets.add(this.slip);
  }

  private buildEval(): void {
    const w = Math.round(EVAL_W * this.texelScale);
    const h = Math.round(EVAL_LEN * this.texelScale);

    const ground = makeCanvas(w, h);
    paintGround(ground.ctx, w, h, {
      ground: SILK,
      groundBand: 2,
      age: 'ochre',
      ageBand: 1,
      ageAmount: 0.22,
      // Silk: the weave leads, the fibre is only what shows between threads.
      weave: 0.62,
      fibre: 0.14,
      tooth: 0.4,
      wear: 0.3,
      lighten: PAPER_LIGHTEN * 0.8,
      seed: 'review-eval',
    });
    deckle(ground.ctx, w, h, { sides: w * 0.05, ends: 0, seed: 'review-eval' });
    this.evalGround = ground.canvas;

    const face = makeCanvas(w, h);
    this.evalCtx = face.ctx;
    this.evalTex = makePanelTexture(face.canvas);
    // The field is smooth by construction, so it does not need the base's
    // resolution — a fraction of the bake cost, and no visible difference.
    this.evalField = bakeBleedField(Math.round(w * 0.6), Math.round(h * 0.6), 'review-eval');
    this.evalMat = createInkBleedMaterial(this.evalTex, this.evalField, 0.05);
    this.evalMesh = makePanel(EVAL_W, EVAL_LEN, this.evalMat);
    this.sheets.add(this.evalMesh);
  }

  private buildAction(): void {
    const s = Math.round(ACT_SIZE * this.texelScale);

    const ground = makeCanvas(s, s);
    paintGround(ground.ctx, s, s, {
      ground: PAPER,
      groundBand: PAPER_BAND,
      age: PAPER_AGE,
      ageBand: 1,
      ageAmount: 0.3,
      weave: 0.14,
      fibre: 0.4,
      tooth: 0.55,
      wear: 0.55,
      lighten: PAPER_LIGHTEN,
      seed: 'review-act',
    });
    deckle(ground.ctx, s, s, { sides: s * 0.03, ends: s * 0.03, seed: 'review-act' });
    this.actGround = ground.canvas;

    const face = makeCanvas(s, s);
    this.actCtx = face.ctx;
    this.actTex = makePanelTexture(face.canvas);
    this.actMat = createPanelMaterial(this.actTex, 0);
    this.actMat.uniforms.uOpacity.value = 0;
    this.act = makePanel(ACT_SIZE, ACT_SIZE, this.actMat);
    this.act.renderOrder = 6;
    // Laid by hand, so it is never square to the sheet beside it.
    this.act.rotation.y = 0.06;
    this.act.visible = false;
    this.group.add(this.act);
  }

  /**
   * The 界行. Painted into the GROUND rather than the face: they never change,
   * and a repaint should not have to re-rule the page. They run past both ends
   * so the scrolling window can never catch a rule terminating.
   */
  private drawRules(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const weight = w * 0.011;
    for (let i = 0; i < RULE_X.length; i++) {
      const x = w * RULE_X[i];
      const middle = i === 1;
      pressedRule(ctx, x, -h * 0.01, x, h * 1.01, {
        pigment: RULE,
        band: 1,
        width: middle ? weight * 0.8 : weight,
        alpha: middle ? 0.5 : 0.66,
        wobble: weight * 1.4,
        seed: `review-rule${i}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Placement
  // -------------------------------------------------------------------------

  /**
   * Slide the sheets in toward the table as the frame narrows, stopping at the
   * timber. The bounds are `hud.ts`'s, measured: past `SIDE_X_MIN` a sheet is
   * lying on the table rather than on the terrace, which is a different object.
   */
  private place(): void {
    const t = clamp((this.aspect - 1.15) / (1.7 - 1.15), 0, 1);
    const x = SIDE_X_MIN + (SIDE_X_WIDE - SIDE_X_MIN) * t;
    const ex = EVAL_X_MIN + (EVAL_X_WIDE - EVAL_X_MIN) * t;

    this.rec.position.set(x, this.heightAt(x, REC_Z) + PANEL_LIFT, REC_Z);

    const slipZ = REC_Z - REC_LEN / 2 - SLIP_GAP - SLIP_LEN / 2;
    this.slip.position.set(x, this.heightAt(x, slipZ) + PANEL_LIFT * 1.6, slipZ);
    this.slip.rotation.y = -0.03;

    this.evalMesh.position.set(ex, this.heightAt(ex, 0) + PANEL_LIFT, 0);

    this.act.position.set(x, this.heightAt(x, ACT_Z) + PANEL_LIFT * 2, ACT_Z);
  }

  // -------------------------------------------------------------------------
  // Model
  // -------------------------------------------------------------------------

  setRows(rows: readonly ReviewRow[]): void {
    this.rows.length = 0;
    for (let i = 0; i < rows.length; i++) this.rows.push(rows[i]);
    this.recDirty = true;
    this.slipDirty = true;
    this.applyCursor(false);
  }

  setCursor(ply: number): void {
    const next = clamp(Math.round(ply), 0, this.rows.length);
    if (next === this.cursorPly) return;
    this.cursorPly = next;
    this.recDirty = true;
    this.slipDirty = true;
    this.applyCursor(true);
  }

  /**
   * Bring the window and the ink into line with the cursor.
   *
   * `animated` is false when the rows themselves changed under a cursor that
   * did not move — an analysis result landing — because a sheet that re-slid
   * every time a ply came back from the engine would never sit still.
   */
  private applyCursor(animated: boolean): void {
    const row = this.cursorPly > 0 ? this.rows[this.cursorPly - 1] : null;
    this.reachTarget = row ? reachFromCentipawns(row.cp, row.mateIn) : 0;
    if (!animated) {
      // Snapped, so `update` will never see a difference to chase — which means
      // this is the only place the uniform and the lacquer can be written.
      this.reach = this.reachTarget;
      const side: Side = this.reach >= 0 ? Side.Red : Side.Black;
      if (side !== this.inkSide) {
        this.inkSide = side;
        this.pushInkColour();
      }
      this.evalMat.uniforms.uReach.value = this.reach;
    }

    // The cursor's pair, and the window that keeps it on the sheet. Red opens a
    // pair and Black closes it, so pair index is (ply - 1) >> 1 whenever Red
    // moved first — which `pairIndexOf` resolves properly from the sides.
    const pair = this.cursorPly > 0 ? this.pairIndexOf(this.cursorPly - 1) : 0;
    const pairs = this.pairCount();
    // Keep the cursor one row clear of the sheet's foot where it can.
    const wanted = clamp(pair - (ROWS - 2), 0, Math.max(0, pairs - ROWS));
    if (wanted !== this.topPair) {
      const dir = wanted > this.topPair ? 1 : -1;
      const jump = Math.abs(wanted - this.topPair);
      this.topPair = wanted;
      this.recDirty = true;
      // Only a single-row step is worth sliding; a jump is a cut. The window
      // starts where the OLD rows still are and eases back to rest — which is
      // one slot further down for a step forward, one slot up for a step back.
      if (animated && jump === 1) {
        this.slideFrom = REST_OFFSET + dir / SLOTS;
        this.slide = this.slideFrom;
        this.slideT = 0;
      } else {
        this.slide = REST_OFFSET;
        this.slideT = 1;
      }
      (this.recMat.uniforms.uWindow.value as THREE.Vector2).x = this.slide;
    }
  }

  announce(text: string, seconds = 1.6): void {
    // An empty text lowers the slip without repainting it: the sheet has to
    // stay legible all the way down, and a blank one fading out reads as a
    // rendering fault rather than as paper being taken away.
    if (!text) {
      this.actHold = 0;
      return;
    }
    if (text !== this.actText) {
      this.actText = text;
      this.actDirty = true;
    }
    this.actHold = seconds;
    this.act.visible = true;
  }

  /**
   * Fold the plies into printed rows.
   *
   * Red normally opens a row, but a position loaded from a FEN can put Black on
   * move, and a record whose columns had silently swapped would be worse than
   * one with a gap in it. A row closes when the column it would need is taken.
   *
   * Allocates, and is called only from a repaint or a cursor move — never from
   * the frame path.
   */
  private buildPairs(): (ReviewRow | null)[][] {
    const out: (ReviewRow | null)[][] = [];
    let row: (ReviewRow | null)[] | null = null;
    for (const e of this.rows) {
      const col = e.side === Side.Red ? 0 : 1;
      if (!row || row[col] !== null) {
        row = [null, null];
        out.push(row);
      }
      row[col] = e;
    }
    return out;
  }

  private pairCount(): number {
    return this.buildPairs().length;
  }

  /** Which printed row a ply index (0-based) lands in. */
  private pairIndexOf(index: number): number {
    const pairs = this.buildPairs();
    for (let r = 0; r < pairs.length; r++) {
      for (let c = 0; c < 2; c++) {
        const e = pairs[r][c];
        if (e && e.ply === index + 1) return r;
      }
    }
    return Math.max(0, pairs.length - 1);
  }

  // -------------------------------------------------------------------------
  // The record
  // -------------------------------------------------------------------------

  private repaintRecord(): void {
    const ctx = this.recCtx;
    const w = this.recGround.width;
    const h = this.recGround.height;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.recGround, 0, 0);

    const slotH = h / SLOTS;
    // Four glyphs plus a breath: 4 x 0.19 = 0.76 of the slot, laid from 0.135,
    // which keeps the first and last rows clear of the sheet's end fade.
    const size = slotH * 0.19;
    const markR = slotH * 0.105;
    const pairs = this.buildPairs();

    for (let i = 0; i < SLOTS; i++) {
      const r = this.topPair - 1 + i;
      if (r < 0 || r >= pairs.length) continue;
      const y0 = i * slotH + slotH * 0.135;

      for (let col = 0; col < 2; col++) {
        const entry = pairs[r][col];
        if (!entry) continue;
        const current = entry.ply === this.cursorPly;
        const ink = RECORD_INK[entry.side];

        inkedRun(ctx, settable(entry.notation, entry.side), w * TEXT_X[col], y0, size, {
          vertical: true,
          align: 'center',
          pigment: ink.pigment,
          band: ink.band,
          bleed: current ? 0.26 : 0.18,
          // The ply under examination is wet; the rest of the record has dried
          // back. This is the whole cursor read at a glance, before the bar.
          alpha: current ? 1 : 0.62,
          widthScale: current ? 1.05 : 0.97,
          loadFrom: 1.0,
          loadTo: 0.84,
        });

        if (entry.quality) {
          // Beside the second and third characters, which is where a critic's
          // brush lands: level with the body of the phrase, not its head.
          paintMark(
            ctx,
            entry.quality,
            entry.tone,
            w * MARK_X[col],
            y0 + size * 1.7,
            markR,
            `${entry.ply}:${entry.quality}`,
          );
        }
      }

      // The marginal bar calling out the row under examination.
      const cursorHere =
        (pairs[r][0] && pairs[r][0]!.ply === this.cursorPly) ||
        (pairs[r][1] && pairs[r][1]!.ply === this.cursorPly);
      if (cursorHere) {
        pressedRule(ctx, w * CURSOR_X, y0, w * CURSOR_X, y0 + size * 3.4, {
          pigment: SEAL,
          band: 1,
          width: w * 0.022,
          alpha: 0.9,
          wobble: w * 0.006,
          seed: `review-cursor${r}`,
        });
      }
    }

    this.recTex.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // The head slip
  // -------------------------------------------------------------------------

  private repaintSlip(): void {
    const ctx = this.slipCtx;
    const w = this.slipGround.width;
    const h = this.slipGround.height;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.slipGround, 0, 0);

    const reserve = band(PAPER, PAPER_BAND);
    const row = this.cursorPly > 0 ? this.rows[this.cursorPly - 1] : null;

    // --- 覆盤, pressed at the head ------------------------------------------
    const sealW = w * 0.3;
    const sealH = h * 0.185;
    sealCartouche(ctx, w * 0.63, h * 0.035, sealW, sealH, {
      text: '覆盤',
      pigment: SEAL,
      pigmentBand: 1,
      reserve,
      fill: 0.82,
      seed: 'review-seal',
    });

    // --- whose move is under examination -------------------------------------
    // The army's own name, in its own lacquer, opposite the seal. Nothing else
    // in the roster says "this ply belongs to Red" as directly as 漢 does.
    if (row) {
      const nameSize = sealH * 0.78;
      drawText(ctx, row.side === Side.Red ? '漢' : '楚', w * 0.28, h * 0.035 + sealH * 0.11, nameSize, {
        vertical: true,
        align: 'center',
        pigment: row.side === Side.Red ? 'cinnabar' : 'ink',
        band: 1,
        alpha: 0.95,
        widthScale: 1.04,
        bleed: 0.24,
      });
    }

    // --- the rule that separates the head from the variation ------------------
    const ruleY = h * 0.265;
    pressedRule(ctx, w * 0.08, ruleY, w * 0.92, ruleY, {
      pigment: RULE,
      band: 1,
      width: w * 0.013,
      alpha: 0.62,
      seed: 'review-slip-rule',
    });

    // --- the engine's preferred line -----------------------------------------
    // Two plies, at the size a four-character phrase can carry across the
    // slip's width — and two plies is also the useful answer: what the engine
    // would have played, and what it expected back.
    if (row && row.bestNotation.length) {
      const size = h * 0.105;
      const y0 = h * 0.33;
      const n = Math.min(2, row.bestNotation.length);
      for (let i = 0; i < n; i++) {
        // The line starts with the side that was to move, then alternates.
        const side = ((row.side ^ (i & 1)) as Side);
        const ink = RECORD_INK[side];
        // Right column first, same as the record: the engine's own move is the
        // one the eye should reach first.
        const x = n === 1 ? w * 0.5 : i === 0 ? w * 0.7 : w * 0.28;
        inkedRun(ctx, settable(row.bestNotation[i], side), x, y0, size, {
          vertical: true,
          align: 'center',
          pigment: ink.pigment,
          band: ink.band,
          // Held back from the record's strength: this is a variation, not
          // play, and a line inked as heavily as the record would read as
          // having been played.
          alpha: 0.66,
          bleed: 0.16,
          widthScale: 0.94,
          loadFrom: 0.95,
          loadTo: 0.8,
        });
      }
    }

    this.slipTex.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // The eval silk
  // -------------------------------------------------------------------------

  private repaintEval(): void {
    const ctx = this.evalCtx;
    const w = this.evalGround.width;
    const h = this.evalGround.height;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.evalGround, 0, 0);

    // The river, at the strip's middle: the mark that makes "level" read as a
    // position rather than as an absence of ink.
    pressedRule(ctx, w * 0.1, h * 0.5, w * 0.9, h * 0.5, {
      pigment: 'ink',
      band: 1,
      width: w * 0.035,
      alpha: 0.5,
      seed: 'review-river',
    });

    // Canvas top is world -Z, which is Black's end. Same convention as the HUD.
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

    this.evalTex.needsUpdate = true;
  }

  /** The stain's colour: the leader's lacquer, laid on the loser's half. */
  private pushInkColour(): void {
    const lacquer: PigmentName = this.inkSide === Side.Red ? 'cinnabar' : 'inkLacquer';
    (this.evalMat.uniforms.uInk.value as THREE.Color).setStyle(band(lacquer, 1), THREE.SRGBColorSpace);
    (this.evalMat.uniforms.uInkFront.value as THREE.Color).setStyle(
      band(lacquer, 0),
      THREE.SRGBColorSpace,
    );
  }

  // -------------------------------------------------------------------------
  // The action slip
  // -------------------------------------------------------------------------

  private repaintAction(): void {
    const ctx = this.actCtx;
    const s = this.actGround.width;
    ctx.clearRect(0, 0, s, s);
    ctx.drawImage(this.actGround, 0, 0);
    if (this.actText) {
      const chars = [...this.actText].filter((c) => hasSealGlyph(c)).join('');
      if (chars) {
        sealCartouche(ctx, s * 0.2, s * 0.14, s * 0.6, s * 0.72, {
          text: chars,
          pigment: SEAL,
          pigmentBand: 1,
          reserve: band(PAPER, PAPER_BAND),
          fill: 0.8,
          seed: `review-act:${chars}`,
        });
      }
    }
    this.actTex.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number): void {
    // At most one repaint per surface per frame, whatever happened this tick.
    if (this.recDirty) {
      this.repaintRecord();
      this.recDirty = false;
    }
    if (this.slipDirty) {
      this.repaintSlip();
      this.slipDirty = false;
    }
    if (this.evalDirty) {
      this.repaintEval();
      this.evalDirty = false;
    }
    if (this.actDirty) {
      this.repaintAction();
      this.actDirty = false;
    }

    // --- the stain -----------------------------------------------------------
    if (this.reach !== this.reachTarget) {
      const next = damp(this.reach, this.reachTarget, INK_RATE, dt);
      this.reach = Math.abs(next - this.reachTarget) < 1e-4 ? this.reachTarget : next;
      // The lead changing hands changes which lacquer is on the silk, and it
      // has to happen on the frame the stain crosses the river.
      const side: Side = this.reach >= 0 ? Side.Red : Side.Black;
      if (side !== this.inkSide) {
        this.inkSide = side;
        this.pushInkColour();
      }
      this.evalMat.uniforms.uReach.value = this.reach;
    }

    // --- the sheet -----------------------------------------------------------
    if (this.slideT < 1) {
      this.slideT = Math.min(1, this.slideT + dt / SCROLL_TIME);
      this.slide = REST_OFFSET + (this.slideFrom - REST_OFFSET) * (1 - easeOutCubic(this.slideT));
      (this.recMat.uniforms.uWindow.value as THREE.Vector2).x = this.slide;
    }

    // --- the action slip -----------------------------------------------------
    if (this.act.visible) {
      if (this.actHold > 0) {
        this.actHold = Math.max(0, this.actHold - dt);
        this.actAmount = Math.min(1, this.actAmount + dt / ACT_RISE);
      } else {
        this.actAmount = Math.max(0, this.actAmount - dt / ACT_FADE);
        if (this.actAmount <= 0) this.act.visible = false;
      }
      this.actMat.uniforms.uOpacity.value = this.actAmount;
      // It settles onto the terrace as it comes up rather than simply fading:
      // a sheet that appears at rest reads as a decal.
      this.act.position.y =
        this.heightAt(this.act.position.x, ACT_Z) + PANEL_LIFT * 2 + (1 - this.actAmount) * 0.06;
    }
  }

  resize(w: number, h: number, dpr: number): void {
    this.aspect = w / Math.max(h, 1);
    this.place();

    // Repainting four grounds is tens of milliseconds, so only when the pixel
    // budget really moved — a window dragged between monitors, not a handle.
    const wanted = TEXELS_PER_UNIT * clamp(dpr, 1, MAX_DPR);
    if (Math.abs(wanted - this.texelScale) / this.texelScale > 0.25) {
      this.texelScale = wanted;
      this.rebuild();
    }
  }

  private rebuild(): void {
    this.rec.removeFromParent();
    this.slip.removeFromParent();
    this.evalMesh.removeFromParent();
    this.act.removeFromParent();
    this.disposePanels();
    this.buildRecord();
    this.buildSlip();
    this.buildEval();
    this.buildAction();
    this.place();
    this.pushInkColour();
    this.evalMat.uniforms.uReach.value = this.reach;
    (this.recMat.uniforms.uWindow.value as THREE.Vector2).x = this.slide;
    this.act.visible = this.actAmount > 0;
    this.actMat.uniforms.uOpacity.value = this.actAmount;
    this.recDirty = true;
    this.slipDirty = true;
    this.evalDirty = true;
    this.actDirty = true;
  }

  setVisible(on: boolean): void {
    this.sheets.visible = on;
  }
  isVisible(): boolean {
    return this.sheets.visible;
  }

  private disposePanels(): void {
    this.rec.geometry.dispose();
    this.slip.geometry.dispose();
    this.evalMesh.geometry.dispose();
    this.act.geometry.dispose();
    this.recMat.dispose();
    this.slipMat.dispose();
    this.evalMat.dispose();
    this.actMat.dispose();
    this.recTex.dispose();
    this.slipTex.dispose();
    this.evalTex.dispose();
    this.actTex.dispose();
    this.evalField.dispose();
  }

  dispose(): void {
    this.disposePanels();
    this.group.removeFromParent();
  }
}

/**
 * Build the review surface.
 *
 * ```ts
 * const review = createReviewPanel({
 *   heightAt: rig.heightAt,
 *   width: window.innerWidth, height: window.innerHeight, dpr: startDpr,
 * });
 * scene.add(review.group);
 * ```
 *
 * Then `review.update(dt)` once per frame, in the same place as `hud.update`,
 * and `review.resize(w, h, dpr)` from the resize handler. It starts hidden;
 * `game/assist.ts` raises it when review mode is entered.
 */
export function createReviewPanel(opts: ReviewPanelOptions): ReviewPanel {
  return new ScenePanel(opts);
}
