/**
 * The grounds every painted HUD panel is laid on.
 *
 * The HUD is not drawn over the picture, it is drawn *into* it: a 棋譜 scroll, a
 * title slip and a strip of eval silk are physical sheets lying on the terrace
 * beside the board, and they have to be made of the same stuff as everything
 * else in the frame. That means no flat fills. A sheet here is:
 *
 *   ground pigment  →  woven or fibrous tooth  →  age blotch  →  handling wear
 *   at the edges    →  a torn (deckled) silhouette
 *
 * All of it comes out of `core/noise.ts` on a `seedFor()` stream, so the same
 * build paints the same sheet every run and a captured frame is a measurement.
 *
 * ── Why the tooth is coarse ─────────────────────────────────────────────────
 *
 * These canvases are minified on screen: a scroll 1.4 world units wide occupies
 * a couple of hundred device pixels at the resting framing. A one-texel weave
 * would be eaten by the mip chain and the sheet would go dead flat — which is
 * exactly how an in-scene panel starts reading as a UI panel. So the weave
 * period is authored in TEXELS (see `WEAVE_PERIOD`), not in world units, and is
 * kept wide enough to survive one or two mip levels. The board's silk gets its
 * fine weave from a screen-space shader in @render; a texture cannot compete
 * with that and should not try.
 */

import { Noise } from '@core/noise.ts';
import { band, hexToRgb, shiftHex, type PigmentName } from '@core/palette.ts';
import { seedFor } from '@core/rng.ts';
import { clamp } from '@core/types.ts';
import { drawText, measureText, type DrawOptions } from '@ui/seal.ts';

// ---------------------------------------------------------------------------
// Authoring constants
// ---------------------------------------------------------------------------

/** Plain-weave thread pitch, in texels. See the header for why this is coarse. */
const WEAVE_PERIOD = 5.5;
/** How far a thread wanders off the loom's grid, in texels. */
const WEAVE_WANDER = 1.15;
/** Frequency of the age blotch, in cycles per 256 texels. */
const BLOTCH_FREQ = 2.4;
/** Lattice step the blotch is evaluated on before interpolation, in texels. */
const BLOTCH_STEP = 6;
/** Frequency of the paper's long fibres across the sheet. */
const FIBRE_ACROSS = 0.42;
const FIBRE_ALONG = 0.022;
/** Width of the handled, slightly darker margin, as a fraction of the short side. */
const WEAR_MARGIN = 0.16;

export type Band = 0 | 1 | 2 | 3;

export interface GroundOptions {
  /** Body pigment of the sheet. */
  ground: PigmentName;
  groundBand: Band;
  /** A second pigment mottled in — foxing, damp, age. */
  age?: PigmentName;
  ageBand?: Band;
  /** 0..1 strength of the age mottle. */
  ageAmount?: number;
  /** Plain-weave strength, 0..1. Silk wants ~0.5, paper wants 0. */
  weave?: number;
  /** Long-fibre streak strength, 0..1. Paper wants ~0.4, silk wants ~0.12. */
  fibre?: number;
  /** Fine tooth, 0..1. */
  tooth?: number;
  /** Darkening at the handled edges, 0..1. */
  wear?: number;
  /**
   * Value nudge on the ground, in `shiftHex` lightness units.
   *
   * A HUD sheet is drawn unlit, so its texel value IS its final value, while
   * everything around it has been through a key light at 2.5 and a four-band
   * ramp. Authored straight from the palette a sheet lands too high-key and
   * becomes the brightest thing in the frame. This is how it is brought back
   * down onto the picture's value ladder — through `shiftHex`, so the sheet
   * never leaves the palette.
   */
  lighten?: number;
  /** Decorrelates this sheet's grain from every other one. */
  seed: string;
}

/**
 * Paint the whole canvas as one sheet of ground.
 *
 * Written straight into an `ImageData` rather than through canvas ops: three
 * noise evaluations per texel is cheap, and it is the only way to get the weave
 * and the blotch to modulate the *same* pigment rather than stack as translucent
 * layers, which is what makes a canvas ground read as decals over a fill.
 *
 * This runs once per sheet at construction. Panels that redraw on a move (the
 * record) keep the result in an offscreen canvas and blit it — repainting a
 * ground per move would be the classic way an in-scene HUD eats a frame budget.
 */
export function paintGround(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  opts: GroundOptions,
): void {
  const rng = seedFor('hud', 'ground', opts.seed);
  const n = new Noise(rng.int(1, 0x7fffffff));
  const nWander = new Noise(rng.int(1, 0x7fffffff));

  const lighten = opts.lighten ?? 0;
  const base = hexToRgb(shiftHex(band(opts.ground, opts.groundBand), lighten));
  const aged = hexToRgb(
    shiftHex(band(opts.age ?? opts.ground, opts.ageBand ?? opts.groundBand), lighten),
  );

  const weave = opts.weave ?? 0;
  const fibre = opts.fibre ?? 0;
  const tooth = opts.tooth ?? 0.5;
  const wear = opts.wear ?? 0.35;
  const ageAmount = opts.ageAmount ?? 0;

  const img = ctx.createImageData(w, h);
  const px = img.data;
  const short = Math.min(w, h);
  const wearBand = short * WEAR_MARGIN;

  // Four-octave fbm is by far the most expensive term here and the only one
  // that is genuinely low-frequency — one blotch spans a hundred texels. It is
  // therefore evaluated on a coarse lattice and interpolated, which takes the
  // ground for a whole HUD from about half a second to about fifty
  // milliseconds. The other three terms are per-texel by nature and stay so.
  const gw = Math.ceil(w / BLOTCH_STEP) + 1;
  const gh = Math.ceil(h / BLOTCH_STEP) + 1;
  const blotGrid = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      blotGrid[j * gw + i] = n.fbm(
        ((i * BLOTCH_STEP) / 256) * BLOTCH_FREQ,
        ((j * BLOTCH_STEP) / 256) * BLOTCH_FREQ,
        4,
      );
    }
  }

  for (let y = 0; y < h; y++) {
    const gy = y / BLOTCH_STEP;
    const j0 = Math.floor(gy);
    const fy = gy - j0;
    for (let x = 0; x < w; x++) {
      // -- age blotch: which pigment this patch of sheet is made of ---------
      const gx = x / BLOTCH_STEP;
      const i0 = Math.floor(gx);
      const fx = gx - i0;
      const b00 = blotGrid[j0 * gw + i0];
      const b10 = blotGrid[j0 * gw + i0 + 1];
      const b01 = blotGrid[(j0 + 1) * gw + i0];
      const b11 = blotGrid[(j0 + 1) * gw + i0 + 1];
      const bTop = b00 + (b10 - b00) * fx;
      const bBot = b01 + (b11 - b01) * fx;
      const blot = bTop + (bBot - bTop) * fy;
      const mix = clamp((blot - 0.32) * 1.9, 0, 1) * ageAmount;
      let r = base.r + (aged.r - base.r) * mix;
      let g = base.g + (aged.g - base.g) * mix;
      let b = base.b + (aged.b - base.b) * mix;

      // -- value modulation, all multiplicative so hue never drifts ---------
      let v = 1;

      if (weave > 0) {
        // Plain weave: warp and weft alternate over and under in a chequer.
        // The thread that is ON TOP in a cell catches the light along its own
        // length, so the highlight runs ACROSS the other axis. Wander the grid
        // with noise or the loom reads as a printed grid, which is worse than
        // no weave at all.
        const wx = x + (nWander.value2(x * 0.04, y * 0.3) - 0.5) * 2 * WEAVE_WANDER;
        const wy = y + (nWander.value2(x * 0.3 + 31, y * 0.04) - 0.5) * 2 * WEAVE_WANDER;
        const cx = Math.floor(wx / WEAVE_PERIOD);
        const cy = Math.floor(wy / WEAVE_PERIOD);
        const warpOnTop = ((cx + cy) & 1) === 0;
        const t = warpOnTop
          ? (wx / WEAVE_PERIOD - cx)
          : (wy / WEAVE_PERIOD - cy);
        // |sin| across the thread: a rounded filament, not a square rib.
        const ridge = Math.sin(t * Math.PI);
        v *= 1 + weave * 0.19 * (ridge - 0.62);
      }

      if (fibre > 0) {
        // Long fibres lie ALONG the sheet, so the field is stretched hard in y.
        const f = n.value2(x * FIBRE_ACROSS, y * FIBRE_ALONG);
        v *= 1 + fibre * 0.16 * (f - 0.5) * 2;
      }

      if (tooth > 0) {
        const t = n.value2(x * 0.87 + 11, y * 0.87 + 7);
        v *= 1 + tooth * 0.085 * (t - 0.5) * 2;
      }

      if (wear > 0) {
        // Handled margins: a sheet is darkest and dirtiest where fingers go.
        const dx = Math.min(x, w - 1 - x);
        const dy = Math.min(y, h - 1 - y);
        const d = Math.min(dx, dy) / wearBand;
        if (d < 1) v *= 1 - wear * 0.3 * (1 - d) * (1 - d);
      }

      const i = (y * w + x) << 2;
      px[i] = clamp(r * v, 0, 1) * 255;
      px[i + 1] = clamp(g * v, 0, 1) * 255;
      px[i + 2] = clamp(b * v, 0, 1) * 255;
      px[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export interface DeckleOptions {
  /** Ragged bite depth on the long sides, in texels. */
  sides: number;
  /** Ragged bite depth on the short ends, in texels. 0 leaves them square. */
  ends?: number;
  seed: string;
}

/**
 * Tear the sheet out of the canvas.
 *
 * A rectangle with four straight alpha edges is a widget; a deckled edge is a
 * piece of paper. Done as one `destination-in` pass over a noise-perturbed
 * outline, so the result is a genuine silhouette rather than a painted border.
 */
export function deckle(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  opts: DeckleOptions,
): void {
  const rng = seedFor('hud', 'deckle', opts.seed);
  const n = new Noise(rng.int(1, 0x7fffffff));
  const ends = opts.ends ?? opts.sides;

  // Two octaves: a slow undulation of the whole edge plus a fine fibre bite.
  const bite = (t: number, lane: number): number => {
    const a = n.value2(t * 0.11, lane * 7.3) - 0.5;
    const b = n.value2(t * 0.62 + 53, lane * 7.3) - 0.5;
    return a * 1.4 + b * 0.6;
  };

  ctx.save();
  ctx.beginPath();
  const step = 3;
  // top edge, left to right
  for (let x = 0; x <= w; x += step) {
    const y = ends * bite(x, 0);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  // right edge, top to bottom
  for (let y = 0; y <= h; y += step) ctx.lineTo(w - opts.sides * bite(y, 1), y);
  // bottom edge, right to left
  for (let x = w; x >= 0; x -= step) ctx.lineTo(x, h - ends * bite(x, 2));
  // left edge, bottom to top
  for (let y = h; y >= 0; y -= step) ctx.lineTo(opts.sides * bite(y, 3), y);
  ctx.closePath();

  ctx.globalCompositeOperation = 'destination-in';
  // Only this fill's ALPHA reaches the result — `destination-in` keeps the
  // sheet where the path covers and erases it everywhere else. It still comes
  // out of the palette, because nothing in this project invents a colour and a
  // grep for a hex literal should come back empty from every file but one.
  ctx.fillStyle = band('shellWhite', 3);
  ctx.fill();
  ctx.restore();
}

export interface RuleOptions {
  pigment: PigmentName;
  band: Band;
  /** Line weight in texels. */
  width: number;
  alpha?: number;
  /** How much the rule wobbles off true, in texels. A ruled line is hand-ruled. */
  wobble?: number;
  seed: string;
}

/**
 * A ruled line — the 界行 that divide a 棋譜's columns.
 *
 * Drawn as a filled ribbon rather than a stroke so the weight can vary along
 * its length: a hand-drawn rule loads and starves, and a perfectly even 1px
 * stroke is the single most recognisable "this was drawn by a browser" tell in
 * the whole HUD.
 */
export function pressedRule(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  opts: RuleOptions,
): void {
  const rng = seedFor('hud', 'rule', opts.seed);
  const n = new Noise(rng.int(1, 0x7fffffff));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return;
  const nx = -dy / len;
  const ny = dx / len;
  const wobble = opts.wobble ?? opts.width * 0.55;
  const steps = Math.max(8, Math.ceil(len / 6));

  ctx.save();
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.fillStyle = band(opts.pigment, opts.band);
  ctx.beginPath();
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i <= steps; i++) {
      // Walk out along one side and back along the other, so the ribbon closes.
      const k = side === 0 ? i : steps - i;
      const t = k / steps;
      const off = (n.value2(t * 9, side * 4.5) - 0.5) * 2 * wobble;
      // Weight swells in the middle of the stroke and starves at the ends.
      const swell = 0.55 + 0.45 * Math.sin(Math.PI * clamp(t, 0, 1));
      const half = opts.width * 0.5 * swell * (side === 0 ? 1 : -1);
      const px = x0 + dx * t + nx * (off + half);
      const py = y0 + dy * t + ny * (off + half);
      if (side === 0 && i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export interface CartoucheOptions {
  /** Characters inside the seal, set as one vertical column. */
  text: string;
  /** Seal pigment. A seal is 朱砂 unless it has a very good reason not to be. */
  pigment?: PigmentName;
  pigmentBand?: Band;
  /** Colour the characters are reserved in — normally the sheet's own ground. */
  reserve: string;
  /** Fraction of the box the characters fill. */
  fill?: number;
  seed: string;
}

/**
 * A pressed seal (陽文/朱文): a solid cinnabar block with the characters
 * reserved out of it in the paper's own colour.
 *
 * The block is deliberately imperfect — no seal ever prints evenly, and the
 * unpressed flecks are the whole reason it reads as pressed rather than as a
 * filled rectangle with a label in it.
 */
export function sealCartouche(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: CartoucheOptions,
): void {
  const rng = seedFor('hud', 'seal', opts.seed);
  const n = new Noise(rng.int(1, 0x7fffffff));
  const pigment = opts.pigment ?? 'cinnabar';
  const pBand = opts.pigmentBand ?? 1;

  ctx.save();

  // --- the block, with a bitten edge ---------------------------------------
  ctx.beginPath();
  const per = 2 * (w + h);
  const steps = Math.max(24, Math.round(per / 4));
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * per;
    let px: number;
    let py: number;
    let ox: number;
    let oy: number;
    if (t < w) {
      px = x + t;
      py = y;
      ox = 0;
      oy = -1;
    } else if (t < w + h) {
      px = x + w;
      py = y + (t - w);
      ox = 1;
      oy = 0;
    } else if (t < 2 * w + h) {
      px = x + w - (t - w - h);
      py = y + h;
      ox = 0;
      oy = 1;
    } else {
      px = x;
      py = y + h - (t - 2 * w - h);
      ox = -1;
      oy = 0;
    }
    const bite = (n.value2(t * 0.5, 3.1) - 0.35) * Math.min(w, h) * 0.045;
    if (i === 0) ctx.moveTo(px + ox * bite, py + oy * bite);
    else ctx.lineTo(px + ox * bite, py + oy * bite);
  }
  ctx.closePath();
  ctx.fillStyle = band(pigment, pBand);
  ctx.fill();

  // --- unpressed flecks: the ground showing through the pigment -------------
  ctx.fillStyle = opts.reserve;
  for (let i = 0; i < 90; i++) {
    const fx = x + rng.next() * w;
    const fy = y + rng.next() * h;
    const d = n.fbm(fx * 0.06, fy * 0.06, 3);
    if (d > 0.47) continue;
    const r = rng.range(0.4, 1.9) * (Math.min(w, h) / 60);
    ctx.globalAlpha = rng.range(0.25, 0.8);
    ctx.beginPath();
    ctx.moveTo(fx + r, fy);
    for (let a = 1; a <= 6; a++) {
      const ang = (a / 6) * Math.PI * 2;
      const rr = r * (0.6 + n.value2(fx + a, fy) * 0.8);
      ctx.lineTo(fx + Math.cos(ang) * rr, fy + Math.sin(ang) * rr);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // --- the characters, reserved out of the block ---------------------------
  const fill = opts.fill ?? 0.78;
  const chars = [...opts.text];
  const size = Math.min((h * fill) / Math.max(chars.length, 1), w * fill);
  const m = measureText(opts.text, size, { vertical: true });
  drawText(ctx, opts.text, x + w * 0.5, y + (h - m.advance) * 0.5, size, {
    vertical: true,
    align: 'center',
    colour: opts.reserve,
    // The reserve is cut, not laid, so it gets no bleed: bleed would fatten the
    // strokes and close the counters.
    bleed: 0,
    widthScale: 1.12,
  });

  ctx.restore();
}

/**
 * Lay one run of seal script with a wet, uneven load.
 *
 * `drawText` already lays a bleed pass under the body. This adds the second
 * thing brushed ink does that vector text never does: the load varies down the
 * run, so the first character of a column is heavy and the last is dry.
 */
export function inkedRun(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  opts: DrawOptions & { vertical?: boolean; loadFrom?: number; loadTo?: number },
): void {
  const chars = [...text];
  const from = opts.loadFrom ?? 1;
  const to = opts.loadTo ?? 0.86;
  const vertical = opts.vertical ?? false;
  const m = measureText(text, size, { vertical });
  const baseAlpha = opts.alpha ?? 1;
  for (let i = 0; i < chars.length; i++) {
    const t = chars.length > 1 ? i / (chars.length - 1) : 0;
    const load = from + (to - from) * t;
    const gx = vertical ? x : x + m.offsets[i];
    const gy = vertical ? y + m.offsets[i] : y;
    drawText(ctx, chars[i], gx, gy, size, {
      ...opts,
      vertical,
      alpha: baseAlpha * clamp(load, 0, 1),
      widthScale: (opts.widthScale ?? 1) * (0.94 + 0.1 * load),
    });
  }
}

/** A canvas sized in device texels, with its 2D context. Never null in a browser. */
export function makeCanvas(w: number, h: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) throw new Error('[ui/paper] no 2D context — the HUD cannot be painted');
  return { canvas, ctx };
}
