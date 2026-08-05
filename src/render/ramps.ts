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
  OUTLINES,
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
// Band cuts — re-cut against a measured frame
// ---------------------------------------------------------------------------

/**
 * WHERE EACH CLASS'S BANDS CHANGE OVER, IN N·L.
 *
 * These replace `RAMPS[cls].thresholds`. `core/palette.ts` is frozen, so the
 * measured numbers live here; they are the same shape and the same meaning, and
 * the exact edit that would fold them back into the palette is written up in the
 * task report. `bandThresholds()` is the one accessor — nothing in this file
 * reads `spec.thresholds` any more.
 *
 * HOW THEY WERE ARRIVED AT
 * The atlas alpha channel is the band index, and it is ours at runtime, so it
 * can be re-baked into a measurement encoding: one pass per material class to
 * mask the frame by class, then a pass per texel triple to bin N·L. Fourteen
 * passes per frame recover the distribution of N·L, per class, against 24
 * quantile boundaries, over real frames at `setQuality('ultra')`. Every number
 * below is a quantile of that distribution, not an intuition.
 *
 * FOUR frames, not one: the full board at the `default` pose, and the cannon,
 * chariot and general showcases at `portrait`. One frame is not enough and the
 * reason is not statistical. The board frame is 90% ground — silk, timber and
 * stone — so a cut tuned on it alone is tuned on a flat plane; the showcases
 * are where a figure's classes have the pixels for the number to mean anything
 * (a cannon contributes 298 lacquer pixels to the board frame's 1875, but a
 * chariot contributes 8823). Each cut below is the value that maximises the
 * WORST of the four frames, searched exhaustively over the 24 boundaries.
 *
 * WHAT THE MEASUREMENT SAID, AND WHY THE OLD CUTS COULD NOT WORK
 *
 * 1. Cast shadow is not a tail of the distribution, it is a separate
 *    POPULATION. The surface shader multiplies N·L by 0.12 in shadow, so every
 *    shadowed fragment in the build lands in 0.00–0.14 regardless of how it
 *    faces. On a close showcase that is 60–75% of a figure. The first cut
 *    therefore sits just above that ceiling on every class: band 0 is "in
 *    shadow, or turned right away", and bands 1–3 divide the LIT range. Putting
 *    the first cut higher (lacquer's old 0.18, silk's old 0.36) spent two bands
 *    on a population that has no spread to divide.
 *
 * 2. Horizontal surfaces are a spike, not a spread. Under a key at elevation e
 *    every upward-facing plane in the frame lands at exactly 0.62·sin(e) + 0.38
 *    — 0.779 at the rig's `wide` mood. Measured, that spike is 87% of the board
 *    deck, 82% of the table's timber, and 43% of a chariot's lacquer, inside a
 *    SINGLE texel. A cut placed on the spike does not separate two things, it
 *    dithers one thing along the tooth, so no cut sits on one.
 *
 *    The spike also MOVES: the rig's mood ladder walks it from 0.704 (wide)
 *    through 0.665 (close) to 0.587 (endgame). Measured, not derived — the
 *    deck's silk sits 30%/53% either side of 0.70 at the wide mood, which is
 *    the formula's 0.704 with the tooth smeared across it. The board's three
 *    classes are almost entirely spike, so where their upper cut sits relative
 *    to that walk decides what the ground does across a match. It is placed
 *    deliberately BETWEEN the close and endgame positions, so the deck, the
 *    table and the piece bases hold one value through the opening and the
 *    middlegame and step down exactly one rung as the endgame light falls.
 *    That step is what makes the endgame read cold rather than merely bluer, it
 *    is what the build already did before this re-cut, and moving the cut clear
 *    of the walk to avoid it was measurably worse: the endgame board came out
 *    pale and sandy and the mood stopped reading.
 *
 *    It crosses during a 2.4 s cross-fade rather than on one frame, and the
 *    tooth spreads the crossing over roughly a third of a second along the
 *    weave, so it dissolves rather than cuts.
 *
 * 3. The old cuts put the mass in band 2. Measured before: 73–95% of every
 *    three-step class and 34% of lacquer sat in band 2, with band 1 under 8% on
 *    gold and iron. But band 1 is the BODY COLOUR and band 2 is the lifted
 *    plane; a painting whose lifted plane covers four fifths of every figure has
 *    no body colour left, which is exactly the "everything reads as one material
 *    in different colours" the critic named. The cuts below deliberately move
 *    the mass down one rung, into the body colour, and leave band 2 for the
 *    planes that genuinely turn toward the key.
 *
 * 4. WHAT NO CUT SET CAN DO, AND THE ONE FRAME THAT PROVES IT.
 *    A cannon at `portrait` shows 298 lacquer pixels — 0.08% of the frame —
 *    and 53% of them are inside the cannon's own cast shadow, which the shader
 *    crushes into 0.00–0.12 regardless of facing. What is left has almost no
 *    mass between 0.74 and 0.86, so band 2 tops out near 7% however the cuts
 *    are placed. Switching the cascade off turns the same class into
 *    0/20/44/37, which is the proof that the residue is shadow and not ramp.
 *    The elevation ladder took that lump from 99% (at the authored 49°) to 53%;
 *    getting it lower is a question for `uShadowDepth` in `render/gongbi.ts`,
 *    which is the one term that decides how deep a shadowed passage falls and
 *    is not ours to move. See the task report.
 *
 * These are all valid only for the light rig in `scene/lighting.ts`. They are
 * quantiles of a distribution that the key direction produces; move the key and
 * they want re-measuring. That coupling is the whole point of P0.1 — the ramp
 * and the rig are one tuning surface, not two. Measured: these cuts at the OLD
 * elevation leave a cannon's lacquer at 83% band 0, and the old cuts at THIS
 * elevation leave a chariot's lacquer at 10% band 1. Neither half works alone.
 */
export const BAND_CUTS: Record<MaterialClass, number[]> = {
  // Four-step. The middle cut sits just ABOVE the horizontal-plane spike at
  // 0.704 and the top one above the plane that faces the key square-on, so the
  // 提白 accent lands on the facets that genuinely turn into the light rather
  // than flooding every shoulder and helmet crown in the frame. Measured over
  // the four frames, band-1/band-2/band-3 occupancy is
  //   board   19/43/23/15    chariot 17/17/62/ 3    general 19/43/18/20
  // and the cannon is the one frame it cannot reach — see note 4.
  lacquer: [0.15, 0.74, 0.86],
  // 泥金 keeps its razor, but 0.93 was past the end of the distribution: only
  // 4-9% of any frame's gold ever got there, so the leaf never appeared. At
  // 0.86 it is 9% on a chariot and 27% on a general, which is a top band a
  // painter would recognise as laid rather than as an accident.
  gold: [0.15, 0.62, 0.86],
  iron: [0.16, 0.7, 0.86],

  // Three-step. Band 1 is the body colour and carries the mass.
  cloth: [0.16, 0.7],
  // 0.78, not 0.70: a chariot's leather is 56% cast shadow and what is left
  // is nearly all above 0.70, so the lower cut put the whole lit remainder in
  // one band. This is the cut that takes a general's leather from 76/15/9 to
  // 45/19/36.
  leather: [0.15, 0.78],
  ivory: [0.16, 0.62],
  flesh: [0.15, 0.74],
  hair: [0.16, 0.66],

  // The board's three classes: deck, table frame, piece bases. Their upper cut
  // sits between the close mood's spike (0.665) and the endgame's (0.587) — see
  // note 2 — so the ground holds one value until the endgame and then steps
  // down a rung. All three take the same cut because the gap is only 0.078
  // wide and the middle of it is the only place clear of both spikes by more
  // than the tooth; 石色 carries the heaviest granulation in the build (0.065)
  // and is the one with the least margin, which is the constraint that fixes
  // the value rather than each class choosing its own.
  silk: [0.11, 0.62],
  timber: [0.17, 0.62],
  stone: [0.15, 0.62],
};

/**
 * The cut points a class's ramp is actually baked with, validated against the
 * step count the palette authored. A mismatch here would bake a band the shader
 * can never select, and the failure is silent, so it throws.
 */
export function bandThresholds(cls: MaterialClass): number[] {
  const cuts = BAND_CUTS[cls];
  const want = RAMPS[cls].steps - 1;
  if (!cuts || cuts.length !== want) {
    throw new Error(`BAND_CUTS.${cls}: ${cuts?.length ?? 0} cuts for a ${RAMPS[cls].steps}-step ramp`);
  }
  for (let i = 0; i < cuts.length; i++) {
    if (!(cuts[i] > 0 && cuts[i] < 1)) throw new Error(`BAND_CUTS.${cls}[${i}] out of (0,1)`);
    if (i > 0 && cuts[i] <= cuts[i - 1]) throw new Error(`BAND_CUTS.${cls} is not ascending`);
  }
  return cuts;
}

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
  const cuts = bandThresholds(cls);
  const hexes = bandHexes(cls, pigment);
  const cols = hexes.map(toLinear);
  // `edgeSoftness` is the full width of the cut, so the smoothstep runs from
  // threshold - soft/2 to threshold + soft/2.
  const half = spec.edgeSoftness * 0.5;

  for (let i = 0; i < RAMP_WIDTH; i++) {
    const ndl = (i + 0.5) / RAMP_WIDTH;

    // Continuous band position in [0, steps-1].
    let b = 0;
    for (let k = 0; k < cuts.length; k++) {
      const t = cuts[k];
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

// ---------------------------------------------------------------------------
// The parameter table — everything the atlas (per-vertex) material needs
// ---------------------------------------------------------------------------

/**
 * THE ENCODING CONTRACT WITH characters/.
 *
 * `characters/factory.ts` stamps a per-vertex float attribute `aMaterial` on
 * every merged geometry, encoded as `classIndex * 16 + pigmentIndex` against
 * its own `MATERIAL_CLASS_ORDER` and `PIGMENT_ORDER`. Those two arrays are
 * element-for-element identical to `MATERIAL_CLASSES` here and to
 * `PIGMENT_NAMES` in core/palette.ts — which is not a coincidence but IS a
 * coupling, and render must not import characters to check it.
 *
 * So the check is done in selfcheck.ts, which reads characters/factory.ts as
 * TEXT and compares the two arrays. That creates no module edge, no typecheck
 * dependency and no bundle edge, and it fails loudly the day either side is
 * reordered. Silent drift here would repaint every figure in the wrong pigment
 * and the cause would be four subsystems away from the symptom.
 */
export const ATLAS_CODE_STRIDE = 16;

/**
 * Columns of the parameter table. One row per (class, pigment) — the SAME row
 * index as the ramp atlas, so one computed V coordinate serves both.
 *
 * Why a texture and not uniform arrays: the wake colour depends on class AND
 * pigment, so a uniform array would need 11 x 12 vec3s just for that, before
 * the wash tint, the outline colour and eight scalars. That is most of the
 * guaranteed fragment uniform budget spent on a lookup table. As a 5 x 132
 * float texture it is 10.5 KB, permanently resident in cache, and three fetches
 * per fragment that never miss.
 *
 *   texel 0 : rgb = 醒色 wake colour (linear)     a = RampSpec.rim
 *   texel 1 : rgb = silk wash tint (linear)      a = RampSpec.silkWash
 *   texel 2 : rgb = outline colour (linear)      a = OutlineProfile.tint
 *   texel 3 : r = granulation  g = toothScale  b = outline widthPx  a = steps
 *   texel 4 : r = fadeStart    g = fadeEnd     b = tooth layer      a = class index
 */
export const PARAM_WIDTH = 5;

/** Filled in by gongbi.ts, which owns the per-class tooth and granulation
 *  tuning; ramps.ts only knows how to lay them out. */
export interface AtlasClassTuning {
  granulation(cls: MaterialClass): number;
  toothScale(cls: MaterialClass): number;
  toothLayer(cls: MaterialClass): number;
}

export function buildParamTable(tuning: AtlasClassTuning): THREE.DataTexture {
  const data = new Float32Array(PARAM_WIDTH * RAMP_ROWS * 4);

  for (const cls of MATERIAL_CLASSES) {
    const spec = RAMPS[cls];
    const ci = MATERIAL_CLASSES.indexOf(cls);
    const profile = OUTLINES[spec.outline];
    const outline = toLinear(PIGMENTS[profile.colour].bands[profile.colourBand]);

    for (const pigment of PIGMENT_NAMES) {
      const row = rampRowIndex(cls, pigment);
      const o = row * PARAM_WIDTH * 4;
      const wake = wakeColour(cls, pigment);
      const wash = washColour(pigment);

      data[o + 0] = wake.r;
      data[o + 1] = wake.g;
      data[o + 2] = wake.b;
      data[o + 3] = spec.rim;

      data[o + 4] = wash.r;
      data[o + 5] = wash.g;
      data[o + 6] = wash.b;
      data[o + 7] = spec.silkWash;

      data[o + 8] = outline.r;
      data[o + 9] = outline.g;
      data[o + 10] = outline.b;
      data[o + 11] = profile.tint;

      data[o + 12] = tuning.granulation(cls);
      data[o + 13] = tuning.toothScale(cls);
      data[o + 14] = profile.widthPx;
      data[o + 15] = spec.steps;

      data[o + 16] = profile.fadeStart;
      data[o + 17] = profile.fadeEnd;
      data[o + 18] = tuning.toothLayer(cls);
      data[o + 19] = ci;
    }
  }

  const tex = new THREE.DataTexture(
    data,
    PARAM_WIDTH,
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
  tex.name = 'gongbi.paramTable';
  return tex;
}

/** The row a given `aMaterial` code resolves to. Mirrors the shader exactly;
 *  exported so the self-check can compare the two. */
export function rowForCode(code: number): number {
  const ci = Math.floor(code / ATLAS_CODE_STRIDE);
  const pi = code - ci * ATLAS_CODE_STRIDE;
  return ci * PIGMENT_NAMES.length + pi;
}

/** The `aMaterial` code for a (class, pigment) pair. */
export function codeFor(cls: MaterialClass, pigment: PigmentName): number {
  return MATERIAL_CLASSES.indexOf(cls) * ATLAS_CODE_STRIDE + PIGMENT_NAMES.indexOf(pigment);
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
