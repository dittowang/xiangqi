/**
 * The mineral-pigment palette. This file is the art direction.
 *
 * Every colour in the build — meshes, outlines, board, HUD, particles, the
 * evaluation bar, the boot veil — resolves to one of these pigments. Nothing
 * anywhere is allowed to invent a colour.
 *
 * Each pigment is a four-band ramp, darkest to lightest, in the order a gongbi
 * painter would lay them: the 罩染 undertone, the body colour, the lifted
 * plane, and the 提白 accent.
 *
 * The pigments sit in three value registers, not one — a painting needs range,
 * and collapsing everything onto a single ladder would flatten the frame:
 *
 *   deep    墨 and 玄漆, the contour and the Chu lacquer
 *   field   石青 石綠 朱砂 赭石 花青 銀朱 石色 — the body of the image. These
 *           genuinely do share a ladder: band 2 spans 0.092..0.149 linear luma
 *           across all seven, so no field pigment can shout down another.
 *   high    藤黃 泥金 蛤白, reserved for silk ground, metal leaf and 提白
 *
 * The load-bearing claim is narrower than "one ladder for everything", and it
 * is this: the two ARMY LACQUERS must not tear a frame in half when they meet
 * in the middle of the board. 玄漆 is authored at 0.78x 朱砂's luma at every
 * band — close enough to share the ladder, still unmistakably the darker army.
 * Black lacquer has real sheen under a key light; it is not a hole in the frame,
 * and rendering it as one is the commonest way to lose the Chu side visually.
 *
 * `luma()` is exported so this is checkable rather than aspirational; the
 * renderer's self-check prints the whole table on every run.
 *
 * Colours are authored in sRGB hex, which is how they were tuned by eye against
 * captured frames. Convert with `srgbToLinear()` before they reach a shader.
 */

// ---------------------------------------------------------------------------
// Pigment definitions
// ---------------------------------------------------------------------------

export type PigmentName =
  | 'azurite' // 石青  — mineral blue, Chu banners, deep water, night light
  | 'malachite' // 石綠  — mineral green, the 千里江山圖 field colour
  | 'cinnabar' // 朱砂  — the Han army's lacquer, seals, check pulse
  | 'ochre' // 赭石  — earth red, leather, timber shadow, tabletop
  | 'gamboge' // 藤黃  — warm transparent yellow, silk ground, lamplight
  | 'shellWhite' // 蛤白  — ground clamshell, ivory, bone, paper
  | 'ink' // 墨    — contour ink, the deepest value in the frame
  | 'inkLacquer' // 玄漆  — the Chu army's black lacquer, cool and stepped
  | 'gold' // 泥金  — leaf and paste gold, palace diagonals, structural lines
  | 'indigo' // 花青  — plant blue, cloth, distance haze
  | 'vermilionDeep' // 銀朱  — the darker cinnabar used for Han shadow accents
  | 'stone'; // 石色  — river banking, unpainted grit

export interface Pigment {
  name: PigmentName;
  /** Chinese pigment name, shown in dev overlays and used in comments. */
  hanzi: string;
  /** Four sRGB hex bands, darkest first. */
  bands: [string, string, string, string];
  /**
   * Where this pigment sits on the shared value ladder, 0 (deepest) to 1
   * (highest key). Used to sanity-check that no pigment drifts off the ladder.
   */
  key: number;
}

const P = (
  name: PigmentName,
  hanzi: string,
  bands: [string, string, string, string],
  key: number,
): Pigment => ({ name, hanzi, bands, key });

export const PIGMENTS: Record<PigmentName, Pigment> = {
  azurite: P('azurite', '石青', ['#101F36', '#1B3A66', '#2C5B92', '#5688BA'], 0.42),
  malachite: P('malachite', '石綠', ['#122720', '#1D4735', '#2F7053', '#61A07C'], 0.44),
  cinnabar: P('cinnabar', '朱砂', ['#43110D', '#832016', '#BC3823', '#DC6A43'], 0.46),
  ochre: P('ochre', '赭石', ['#341C11', '#65361B', '#9A5D31', '#BE8853'], 0.44),
  gamboge: P('gamboge', '藤黃', ['#523810', '#966C1A', '#CF9F30', '#E9C664'], 0.56),
  shellWhite: P('shellWhite', '蛤白', ['#6A5F4C', '#9E9179', '#D3C8AF', '#F2E9D6'], 0.78),
  ink: P('ink', '墨', ['#080706', '#141210', '#26221D', '#3E382F'], 0.10),
  // Retargeted against 朱砂 twice, on both axes.
  //
  // Value first: each band scaled uniformly in LINEAR space, which moves value
  // while leaving hue and saturation untouched. Measured luma 0.0127 / 0.0457 /
  // 0.1070 / 0.1997 against cinnabar's 0.0162 / 0.0592 / 0.1364 / 0.2593.
  //
  // Then chroma, because matching value alone was not enough and the frame
  // proved it. A capture measured the Chu army at mean saturation 0.431 against
  // the Han's 0.739: the values agreed, so neither side was darker, but one
  // army was CHROMATIC and the other was GREY. That reads as a hole just as
  // surely as a value mismatch does. Chroma is pushed away from the grey axis in
  // linear space and the luma restored exactly afterwards, so the value ladder
  // above is untouched. Saturation now runs 0.65 / 0.53 / 0.53 / 0.44 against
  // cinnabar's 0.81 / 0.83 / 0.81 / 0.70 — deliberately still below, because
  // black lacquer that matched cinnabar for chroma would stop being black, but
  // close enough that both armies live in the same picture.
  inkLacquer: P('inkLacquer', '玄漆', ['#111E31', '#2A3D5A', '#405D88', '#617CAD'], 0.34),
  gold: P('gold', '泥金', ['#432F0F', '#836318', '#BE9430', '#E4C66A'], 0.52),
  indigo: P('indigo', '花青', ['#131C2C', '#233650', '#3A587E', '#6685AA'], 0.36),
  vermilionDeep: P('vermilionDeep', '銀朱', ['#380C09', '#6C1810', '#A02A1B', '#C55337'], 0.38),
  stone: P('stone', '石色', ['#2A2823', '#494539', '#6E6857', '#968E79'], 0.40),
};

export const PIGMENT_NAMES = Object.keys(PIGMENTS) as PigmentName[];

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): RGB {
  const h = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex;
  const n = parseInt(h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function rgbToHex(c: RGB): string {
  const q = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return '#' + ((1 << 24) | (q(c.r) << 16) | (q(c.g) << 8) | q(c.b)).toString(16).slice(1);
}

/** sRGB -> linear, the exact transfer function, not the 2.2 approximation. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Perceptual luminance of an sRGB hex, used to police the value ladder. */
export function luma(hex: string): number {
  const c = hexToRgb(hex);
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

/**
 * Saturation, used to police the CHROMA ladder — the axis this palette
 * originally left unguarded.
 *
 * Two pigments can sit at identical luma and still tear a frame in half if one
 * is chromatic and the other is grey. A capture caught exactly that: the two
 * armies matched on value to within 2% and the Chu side still read as a hole,
 * because its saturation was 0.43 against the Han's 0.74. Value alone is not
 * enough, and `luma()` on its own is a half-check.
 */
export function saturation(hex: string): number {
  const c = hexToRgb(hex);
  const mx = Math.max(c.r, c.g, c.b);
  const mn = Math.min(c.r, c.g, c.b);
  return mx < 1e-6 ? 0 : (mx - mn) / mx;
}

/**
 * Move a colour toward or away from the grey axis without changing its value.
 * Chroma is scaled in LINEAR space and the luma restored exactly afterwards,
 * so a pigment can be re-saturated without disturbing the value ladder.
 */
export function scaleChroma(hex: string, k: number): string {
  const c = hexToRgb(hex);
  const lin = { r: srgbToLinear(c.r), g: srgbToLinear(c.g), b: srgbToLinear(c.b) };
  const l0 = 0.2126 * lin.r + 0.7152 * lin.g + 0.0722 * lin.b;
  const r = Math.max(0, l0 + (lin.r - l0) * k);
  const g = Math.max(0, l0 + (lin.g - l0) * k);
  const b = Math.max(0, l0 + (lin.b - l0) * k);
  const l1 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const s = l1 > 1e-9 ? l0 / l1 : 1;
  return rgbToHex({ r: linearToSrgb(r * s), g: linearToSrgb(g * s), b: linearToSrgb(b * s) });
}

export function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t,
  });
}

/** Nudge a pigment band without leaving the palette — used sparingly, for
 *  per-unit variation so thirty-two figures are not thirty-two clones. */
export function shiftHex(hex: string, dLightness: number, dSat = 0): string {
  const c = hexToRgb(hex);
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const l = (max + min) / 2;
  const nl = Math.max(0, Math.min(1, l + dLightness));
  const scale = l > 0.0001 ? nl / l : 1;
  const mid = (c.r + c.g + c.b) / 3;
  const sat = 1 + dSat;
  return rgbToHex({
    r: (mid + (c.r - mid) * sat) * scale,
    g: (mid + (c.g - mid) * sat) * scale,
    b: (mid + (c.b - mid) * sat) * scale,
  });
}

export function bands(name: PigmentName): [string, string, string, string] {
  return PIGMENTS[name].bands;
}
export function band(name: PigmentName, i: 0 | 1 | 2 | 3): string {
  return PIGMENTS[name].bands[i];
}

// ---------------------------------------------------------------------------
// Material classes: how each substance quantises light
// ---------------------------------------------------------------------------

/**
 * A gongbi painter does not shade lacquer, cloth and gold the same way, so
 * neither do we. Each class carries its own band count and its own thresholds
 * along N·L, which is the single most important tuning surface in the renderer.
 * `thresholds[i]` is where band i+1 takes over.
 */
export type MaterialClass =
  | 'lacquer' // hard, wet, four crisp bands with a tight top glint
  | 'cloth' // matte, three bands, generous mid
  | 'leather' // matte and dark, three bands, low contrast
  | 'gold' // metal leaf: four bands, a razor-thin top band
  | 'ivory' // bone, tusk, high key, soft steps
  | 'timber' // dry wood, three warm bands
  | 'stone' // river banking, gritty, three bands
  | 'silk' // the board ground, nearly flat
  | 'flesh' // hands and faces, three bands, warm shadow
  | 'hair' // beards, horse manes, hard two-step
  | 'iron'; // blades and fittings: cool, four bands, very tight highlight

export interface RampSpec {
  /** How many quantisation steps. Three or four; never a smooth falloff. */
  steps: 3 | 4;
  /** N·L cut points, ascending, length = steps - 1. */
  thresholds: number[];
  /**
   * Width of the smoothstep across each cut, in N·L units. Kept near zero:
   * this is a hard band edge, and any softening past ~0.02 starts to read as a
   * generic toon shader instead of laid pigment.
   */
  edgeSoftness: number;
  /** Rim contribution, 0 disables. Gongbi uses this as 醒色, not as a rim light. */
  rim: number;
  /** How far the top band is pushed toward the accent band, 0..1. */
  accent: number;
  /** Strength of the silk-weave wash blended into the shadow bands. */
  silkWash: number;
  /** Outline profile this class defaults to. */
  outline: OutlineProfileName;
}

export type OutlineProfileName = 'contour' | 'structure' | 'fine' | 'none';

export const RAMPS: Record<MaterialClass, RampSpec> = {
  lacquer: {
    steps: 4,
    thresholds: [0.18, 0.47, 0.79],
    edgeSoftness: 0.012,
    rim: 0.22,
    accent: 0.55,
    silkWash: 0.5,
    outline: 'contour',
  },
  cloth: {
    steps: 3,
    thresholds: [0.3, 0.66],
    edgeSoftness: 0.02,
    rim: 0.08,
    accent: 0.18,
    silkWash: 0.82,
    outline: 'contour',
  },
  leather: {
    steps: 3,
    thresholds: [0.26, 0.62],
    edgeSoftness: 0.016,
    rim: 0.1,
    accent: 0.22,
    silkWash: 0.6,
    outline: 'structure',
  },
  gold: {
    steps: 4,
    thresholds: [0.2, 0.5, 0.87],
    edgeSoftness: 0.008,
    rim: 0.42,
    accent: 0.85,
    silkWash: 0.24,
    outline: 'structure',
  },
  ivory: {
    steps: 3,
    thresholds: [0.24, 0.58],
    edgeSoftness: 0.022,
    rim: 0.14,
    accent: 0.3,
    silkWash: 0.68,
    outline: 'fine',
  },
  timber: {
    steps: 3,
    thresholds: [0.28, 0.64],
    edgeSoftness: 0.018,
    rim: 0.06,
    accent: 0.16,
    silkWash: 0.7,
    outline: 'structure',
  },
  stone: {
    steps: 3,
    thresholds: [0.31, 0.68],
    edgeSoftness: 0.024,
    rim: 0.05,
    accent: 0.12,
    silkWash: 0.75,
    outline: 'fine',
  },
  silk: {
    steps: 3,
    thresholds: [0.36, 0.74],
    edgeSoftness: 0.03,
    rim: 0.0,
    accent: 0.1,
    silkWash: 1.0,
    outline: 'none',
  },
  flesh: {
    steps: 3,
    thresholds: [0.27, 0.61],
    edgeSoftness: 0.02,
    rim: 0.12,
    accent: 0.26,
    silkWash: 0.55,
    outline: 'fine',
  },
  hair: {
    steps: 3,
    thresholds: [0.22, 0.66],
    edgeSoftness: 0.01,
    rim: 0.3,
    accent: 0.4,
    silkWash: 0.35,
    outline: 'contour',
  },
  iron: {
    steps: 4,
    thresholds: [0.16, 0.44, 0.84],
    edgeSoftness: 0.009,
    rim: 0.38,
    accent: 0.7,
    silkWash: 0.3,
    outline: 'structure',
  },
};

// ---------------------------------------------------------------------------
// Line work
// ---------------------------------------------------------------------------

export interface OutlineProfile {
  name: OutlineProfileName;
  /** Stroke weight in *screen* pixels at the reference height (1080 CSS px). */
  widthPx: number;
  /** Pigment the stroke is drawn in. */
  colour: PigmentName;
  /** Which band of that pigment. */
  colourBand: 0 | 1 | 2 | 3;
  /** Blend toward the surface colour, 0 = pure stroke, 1 = fully tinted. */
  tint: number;
  /** Fade the stroke past this world distance so far ranks do not crust over. */
  fadeStart: number;
  fadeEnd: number;
}

export const OUTLINES: Record<OutlineProfileName, OutlineProfile> = {
  /** Silhouette contour: deep ink, the heaviest line in the frame. */
  contour: {
    name: 'contour',
    widthPx: 2.35,
    colour: 'ink',
    colourBand: 0,
    tint: 0.12,
    fadeStart: 14,
    fadeEnd: 30,
  },
  /** Structural lines on plate and weapons: 泥金, dark gold, never black. */
  structure: {
    name: 'structure',
    widthPx: 1.6,
    colour: 'gold',
    colourBand: 0,
    tint: 0.3,
    fadeStart: 11,
    fadeEnd: 24,
  },
  /** Fine interior line for flesh, ivory and stone. */
  fine: {
    name: 'fine',
    widthPx: 1.15,
    colour: 'ink',
    colourBand: 1,
    tint: 0.42,
    fadeStart: 9,
    fadeEnd: 20,
  },
  none: {
    name: 'none',
    widthPx: 0,
    colour: 'ink',
    colourBand: 0,
    tint: 0,
    fadeStart: 0,
    fadeEnd: 0,
  },
};

// ---------------------------------------------------------------------------
// Army identity
// ---------------------------------------------------------------------------

/**
 * Han (Red) and Chu (Black) are two armies, not one army tinted twice. Their
 * primary lacquers sit at the same rung of the value ladder; their secondaries
 * pull in opposite directions on the colour wheel so a mixed frame stays legible.
 */
export interface ArmyPalette {
  hanzi: string;
  /** Lacquered lamellar plate. */
  lacquer: PigmentName;
  /** Cloth: robes, sleeves, banners. */
  cloth: PigmentName;
  /** Leather straps, boots, harness. */
  leather: PigmentName;
  /** Metal fittings, blade furniture, crest ornament. */
  metal: PigmentName;
  /** Accent used for cords, tassels, plumes and the army's standard. */
  accent: PigmentName;
  /** Dominant pigment the unit disperses into when it is captured. */
  dispersal: PigmentName;
}

export const ARMY: Record<0 | 1, ArmyPalette> = {
  // Side.Red — Han: cinnabar lacquer over ochre leather, gold fittings.
  0: {
    hanzi: '漢',
    lacquer: 'cinnabar',
    cloth: 'vermilionDeep',
    leather: 'ochre',
    metal: 'gold',
    accent: 'gamboge',
    dispersal: 'cinnabar',
  },
  // Side.Black — Chu: black lacquer over indigo cloth, iron and azurite.
  1: {
    hanzi: '楚',
    lacquer: 'inkLacquer',
    cloth: 'indigo',
    leather: 'ink',
    metal: 'stone',
    accent: 'azurite',
    dispersal: 'azurite',
  },
};

// ---------------------------------------------------------------------------
// Scene palette: everything that is not a soldier
// ---------------------------------------------------------------------------

export const SCENE = {
  /** The tabletop's aged silk ground. */
  silkGround: 'gamboge' as PigmentName,
  /** Timber frame of the table. */
  timber: 'ochre' as PigmentName,
  /** Incised grid lines. */
  gridLine: 'ink' as PigmentName,
  /** Palace diagonals, pressed gold leaf. */
  palaceLeaf: 'gold' as PigmentName,
  /** River water. */
  river: 'azurite' as PigmentName,
  /** River bed, seen through the water. */
  riverBed: 'malachite' as PigmentName,
  /** Cut stone banking the channel. */
  banking: 'stone' as PigmentName,
  /** Legal-move marks pressed into the board. */
  legalMark: 'gold' as PigmentName,
  /** The pulsing base beneath a general in check. */
  checkPulse: 'cinnabar' as PigmentName,
  /** Distant field beyond the table — the 千里江山 backdrop. */
  distantHills: 'malachite' as PigmentName,
  distantWater: 'azurite' as PigmentName,
  sky: 'gamboge' as PigmentName,
} as const;

/** Three light moods the director moves between across a match. */
export interface LightMood {
  key: 'wide' | 'close' | 'endgame';
  keyColour: string;
  fillColour: string;
  bounceColour: string;
  keyIntensity: number;
  fillIntensity: number;
  /** Elevation and azimuth of the key light, radians. */
  keyElevation: number;
  keyAzimuth: number;
  /** Multiplier on shadow length, applied via the CSM split ratio. */
  shadowStretch: number;
  /** Tint the whole frame drifts toward — the endgame's cooling. */
  gradeTint: string;
  gradeAmount: number;
}

export const MOODS: Record<LightMood['key'], LightMood> = {
  wide: {
    key: 'wide',
    keyColour: '#FFF0CE',
    fillColour: '#7E9BC0',
    bounceColour: '#B98E52',
    keyIntensity: 2.55,
    fillIntensity: 0.72,
    keyElevation: 0.86,
    keyAzimuth: -0.62,
    shadowStretch: 1.0,
    gradeTint: '#E9C664',
    gradeAmount: 0.05,
  },
  close: {
    key: 'close',
    keyColour: '#FFE8BC',
    fillColour: '#6C87AE',
    bounceColour: '#C08B53',
    keyIntensity: 2.85,
    fillIntensity: 0.6,
    keyElevation: 0.68,
    keyAzimuth: -0.9,
    shadowStretch: 1.22,
    gradeTint: '#CF9F30',
    gradeAmount: 0.08,
  },
  endgame: {
    key: 'endgame',
    keyColour: '#D9DEEA',
    fillColour: '#3E5578',
    bounceColour: '#5E6B86',
    keyIntensity: 2.1,
    fillIntensity: 0.5,
    keyElevation: 0.34,
    keyAzimuth: -1.35,
    shadowStretch: 1.85,
    gradeTint: '#2C5B92',
    gradeAmount: 0.16,
  },
};
