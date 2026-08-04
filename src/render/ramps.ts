/**
 * Ramp textures — the baked mineral-pigment quantiser.
 *
 * For every (MaterialClass, PigmentName) pair this bakes one row of a shared
 * atlas. The horizontal axis of the row IS N·L, from 0 at the left to 1 at the
 * right, and the texel at each position is the pigment already laid: the 罩染
 * undertone, then the body colour, then the lifted plane, then the 提白 accent,
 * with the cut points taken verbatim from `RAMPS` in core/palette.ts.
 *
 * WHY A TEXTURE AND NOT A FORMULA
 * A formula in the shader would need the thresholds, the step count and the
 * edge softness as uniforms and would spend three or four comparisons per
 * fragment to arrive at the same answer. The texture arrives at it in one fetch
 * — and, more importantly, the fetch is NEAREST, so the band edge is *exactly*
 * as hard as the data, with no chance of a well-meaning later edit sneaking a
 * `mix()` into the interpolation path. Hard bands are the single detail that
 * separates laid pigment from a generic toon shader, and this makes them
 * structural rather than a matter of discipline.
 *
 * WHY FLOAT32 AND NOT sRGB BYTES
 * The pigments are authored in sRGB and converted to linear here. In 8 bits,
 * linear-light 墨 band 0 (#080706, linear 0.0027) quantises to byte 1, a 44%
 * error, and 墨 is the deepest value in the frame and the reference the whole
 * ladder hangs off. Storing sRGB bytes and letting the hardware decode would
 * fix the precision but would put the ramp in a different colour space from
 * everything else the shader touches. Float32 costs 264 KB for the whole atlas
 * and removes the question entirely.
 *
 * TUNING BLOCK — everything adjustable in this file lives here.
 */

import * as THREE from 'three';
import {
  PIGMENTS,
  PIGMENT_NAMES,
  RAMPS,
  hexToRgb,
  shiftHex,
  srgbToLinear,
  type MaterialClass,
  type PigmentName,
  type RGB,
} from '@core/palette.ts';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Texels per ramp row. One texel is 1/128 = 0.0078 in N·L, which is finer than
 * the tightest edge softness in RAMPS (gold, 0.008) — so every band edge the
 * art direction asks for is representable, and the hardest of them lands inside
 * a single texel. Doubling this buys nothing; halving it would quantise gold's
 * and iron's razor edges into something softer than authored.
 */
export const RAMP_WIDTH = 128;

/**
 * How far past the pigment's own accent band the 提白 lift goes, for the
 * four-step classes whose top band IS bands[3] and therefore have nowhere else
 * to go. 提白 is literally "lifting with white": brighter, and slightly less
 * saturated, because it is a white-loaded pigment rather than a purer one.
 */
const TIBAI_LIGHTNESS = 0.16;
const TIBAI_SATURATION = -0.18;

/**
 * The silk wash tint is the pigment's own undertone pushed a little deeper and
 * cooler. Deeper because a wash over a wash is darker than either; cooler
 * because the shadow side of a gongbi figure takes the sky's colour, and every
 * fill in MOODS is cool.
 */
const WASH_LIGHTNESS = -0.045;
const WASH_SATURATION = -0.12;

// ---------------------------------------------------------------------------
// Row indexing
// ---------------------------------------------------------------------------

/**
 * Fixed class order. This is the atlas's row-major key and must never be
 * reordered without rebuilding — a material caches only its row's V coordinate.
 */
export const MATERIAL_CLASSES: readonly MaterialClass[] = [
  'lacquer',
  'cloth',
  'leather',
  'gold',
  'ivory',
  'timber',
  'stone',
  'silk',
  'flesh',
  'hair',
  'iron',
];

export const RAMP_ROWS = MATERIAL_CLASSES.length * PIGMENT_NAMES.length; // 11 * 12 = 132

export function rampRowIndex(cls: MaterialClass, pigment: PigmentName): number {
  const c = MATERIAL_CLASSES.indexOf(cls);
  const p = PIGMENT_NAMES.indexOf(pigment);
  if (c < 0) throw new Error(`unknown MaterialClass "${cls}"`);
  if (p < 0) throw new Error(`unknown PigmentName "${pigment}"`);
  return c * PIGMENT_NAMES.length + p;
}

/** V coordinate at the exact centre of a row — required, because NEAREST. */
export function rampRowV(cls: MaterialClass, pigment: PigmentName): number {
  return (rampRowIndex(cls, pigment) + 0.5) / RAMP_ROWS;
}

// ---------------------------------------------------------------------------
// Band construction
// ---------------------------------------------------------------------------

function toLinear(hex: string): RGB {
  const c = hexToRgb(hex);
  return { r: srgbToLinear(c.r), g: srgbToLinear(c.g), b: srgbToLinear(c.b) };
}

/**
 * The sRGB hex of the colour a class/pigment pair lays in each of its bands,
 * darkest first. Length is `spec.steps`.
 *
 * The top band is pushed toward the next colour up the ladder by `spec.accent`:
 *   - a three-step class has band 3 of the pigment left over, so the accent
 *     pulls its top band toward that — a cloth at accent 0.18 barely lifts, a
 *     hair at 0.4 lifts visibly.
 *   - a four-step class is already using band 3 on top, so there is nothing
 *     left on the ladder and the accent pulls toward a synthesised 提白 lift.
 *     This is why lacquer (0.55), iron (0.7) and gold (0.85) carry such large
 *     accent values: they are asking for the white-loaded stroke a painter puts
 *     on a wet lacquer surface or a gold fitting, not for a bigger step.
 */
export function bandHexes(cls: MaterialClass, pigment: PigmentName): string[] {
  const spec = RAMPS[cls];
  const src = PIGMENTS[pigment].bands;
  const out: string[] = [];
  for (let i = 0; i < spec.steps; i++) out.push(src[i]);

  const topIndex = spec.steps - 1;
  const beyond =
    spec.steps === 3 ? src[3] : shiftHex(src[3], TIBAI_LIGHTNESS, TIBAI_SATURATION);
  out[topIndex] = mixHexLocal(out[topIndex], beyond, spec.accent);
  return out;
}

/** Local hex mix; palette.ts exports one but re-deriving here keeps the band
 *  construction readable in one place. Behaviour is identical. */
function mixHexLocal(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const q = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  const r = q(ca.r + (cb.r - ca.r) * t);
  const g = q(ca.g + (cb.g - ca.g) * t);
  const bl = q(ca.b + (cb.b - ca.b) * t);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
}

/**
 * 醒色 for a class/pigment pair, linear — the "waking colour" the rim stroke
 * is laid in. It is the pigment's accent band lifted once more, so it sits one
 * rung above anything the ramp itself can produce and therefore always reads as
 * a deliberate stroke rather than as the top band bleeding round the edge.
 */
export function wakeColour(cls: MaterialClass, pigment: PigmentName): RGB {
  const src = PIGMENTS[pigment].bands;
  const lift = RAMPS[cls].steps === 4 ? TIBAI_LIGHTNESS * 1.35 : TIBAI_LIGHTNESS;
  return toLinear(shiftHex(src[3], lift, TIBAI_SATURATION * 0.5));
}

/** The pigment the silk wash pools in, linear. */
export function washColour(pigment: PigmentName): RGB {
  return toLinear(shiftHex(PIGMENTS[pigment].bands[0], WASH_LIGHTNESS, WASH_SATURATION));
}

// ---------------------------------------------------------------------------
// Baking
// ---------------------------------------------------------------------------

function smoothstep01(e0: number, e1: number, x: number): number {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Bake one row into `out` at `offset`, as RGBA float:
 *   RGB — the laid pigment, linear
 *   A   — (bandIndex + 0.5) / 4, so the shader recovers the integer band with
 *         one multiply and a floor. The band index is what drives the silk
 *         wash and the fill/bounce tint, so those follow the QUANTISED light
 *         rather than the continuous one; if they followed the continuous term
 *         they would smuggle a smooth gradient back in under the hard bands.
 */
export function bakeRampRow(
  cls: MaterialClass,
  pigment: PigmentName,
  out: Float32Array,
  offset = 0,
): void {
  const spec = RAMPS[cls];
  const hexes = bandHexes(cls, pigment);
  const cols = hexes.map(toLinear);
  // `edgeSoftness` is the full width of the cut, so the smoothstep runs from
  // threshold - soft/2 to threshold + soft/2.
  const half = spec.edgeSoftness * 0.5;

  for (let i = 0; i < RAMP_WIDTH; i++) {
    const ndl = (i + 0.5) / RAMP_WIDTH;

    // Continuous band position in [0, steps-1].
    let b = 0;
    for (let k = 0; k < spec.thresholds.length; k++) {
      const t = spec.thresholds[k];
      b += smoothstep01(t - half, t + half, ndl);
    }

    const lo = Math.min(Math.floor(b), spec.steps - 1);
    const hi = Math.min(lo + 1, spec.steps - 1);
    const f = b - lo;
    const a = cols[lo];
    const c = cols[hi];

    const o = offset + i * 4;
    out[o] = a.r + (c.r - a.r) * f;
    out[o + 1] = a.g + (c.g - a.g) * f;
    out[o + 2] = a.b + (c.b - a.b) * f;
    // Nearest band, not the fractional one: this is an index, not a blend.
    const idx = Math.max(0, Math.min(spec.steps - 1, Math.round(b)));
    out[o + 3] = (idx + 0.5) / 4;
  }
}

/** Raw row data, for the self-check and for anything that wants the numbers. */
export function buildRampRow(cls: MaterialClass, pigment: PigmentName): Float32Array {
  const data = new Float32Array(RAMP_WIDTH * 4);
  bakeRampRow(cls, pigment, data, 0);
  return data;
}

/**
 * The whole atlas: RAMP_WIDTH x RAMP_ROWS, RGBA float, NEAREST in both
 * directions and no mipmaps.
 *
 * NEAREST on V matters as much as on U: a bilinear fetch would blend a
 * lacquer's ramp into the cloth ramp beneath it and every material in the build
 * would be quietly contaminated by its neighbour in the class list.
 */
export function buildRampAtlas(): THREE.DataTexture {
  const data = new Float32Array(RAMP_WIDTH * RAMP_ROWS * 4);
  for (const cls of MATERIAL_CLASSES) {
    for (const pigment of PIGMENT_NAMES) {
      const row = rampRowIndex(cls, pigment);
      bakeRampRow(cls, pigment, data, row * RAMP_WIDTH * 4);
    }
  }
  const tex = new THREE.DataTexture(
    data,
    RAMP_WIDTH,
    RAMP_ROWS,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.needsUpdate = true;
  tex.name = 'gongbi.rampAtlas';
  return tex;
}

/**
 * A single ramp as its own 1-row texture. Not used by the shipped pipeline —
 * the atlas is — but it is what the self-check inspects and what a debug
 * overlay would draw if someone wanted to see one ramp full width.
 */
export function buildRampTexture(cls: MaterialClass, pigment: PigmentName): THREE.DataTexture {
  const tex = new THREE.DataTexture(
    buildRampRow(cls, pigment),
    RAMP_WIDTH,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.needsUpdate = true;
  tex.name = `gongbi.ramp.${cls}.${pigment}`;
  return tex;
}
