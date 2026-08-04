/**
 * Hand-authored 篆書 (small-seal) outline data.
 *
 * There are no fonts in this project, so every Chinese character on screen is
 * drawn from the centrelines in this file. Seal script is the right hand for a
 * Han-dynasty board: even-width strokes, rounded turns, plumb verticals, level
 * horizontals, diagonals resolved into arcs, and a vertically elongated frame.
 * Everything here is authored to those rules — no flares, no 頓筆, no tapers.
 *
 * ── Authoring space ──────────────────────────────────────────────────────────
 * A glyph lives in a 0..100 em box (`SEAL_EM`) with **y pointing DOWN**, which
 * is how a character is written and how a canvas addresses pixels. `seal.ts`
 * normalises to 0..1 on load and flips to y-up only when it emits THREE.Shapes.
 *
 * The ink frame is x ∈ [12, 88], y ∈ [6, 94]: 76 wide by 88 tall, roughly
 * 1 : 1.16, and most glyphs sit narrower than that again. That vertical
 * elongation is the single most recognisable property of seal script, so it is
 * baked into the frame rather than left to each glyph to remember.
 *
 * ── Stroke syntax ────────────────────────────────────────────────────────────
 * A stroke is one whitespace-separated token list describing a *centreline*:
 *
 *     "<x> <y> [ L <x> <y> | Q <cx> <cy> <x> <y> | C <c1x> <c1y> <c2x> <c2y> <x> <y> ]*"
 *
 * plus two modifier tokens that may appear anywhere in the list:
 *
 *     W<n>   multiply this stroke's width by n   (e.g. W0.8 for a hairline mark)
 *     F      flat caps instead of round          (used for strokes that butt
 *            into another stroke and would otherwise bulge past it)
 *
 * A closed form (the box of 口, the ring of 目) is authored as a single stroke
 * whose last point returns to its first. Round caps then close it invisibly.
 *
 * ── Components ───────────────────────────────────────────────────────────────
 * Radicals shared by several characters are authored once in `PARTS` and placed
 * with a `p` entry:
 *
 *     "<ref> <x0> <y0> <x1> <y1> [widthScale]"
 *
 * The component's whole 0..100 box is mapped into the target box, so components
 * are authored edge to edge. Stroke *width is not scaled* by the mapping — seal
 * script strokes are even-width across the whole character, and a squeezed
 * radical keeps the same weight as the rest of the glyph. The optional sixth
 * number trims that weight where a heavily squeezed radical would otherwise
 * clot (0.85 is the usual value).
 *
 * ── Honesty ──────────────────────────────────────────────────────────────────
 * `tier` records how far each form was taken. `high` means it is meant to
 * survive a Chinese-reading player looking straight at it at piece size;
 * `legible` means the structure and stroke count are right and it reads at HUD
 * size, but a calligrapher would redraw it. `note` says what is approximate.
 * `ui/tools` renders the whole set to a sheet so the gap is visible.
 */

/** Side of the authoring box. All coordinates below are in these units. */
export const SEAL_EM = 100;

/** Default centreline width, em units. 5.2% of the em is the seal-script weight. */
export const SEAL_WIDTH = 5.2;

export type GlyphTier = 'high' | 'legible';

export interface RawGlyph {
  tier: GlyphTier;
  /** Advance width in em units. CJK is monospaced, so this is almost always 100. */
  adv?: number;
  /**
   * Whole-glyph weight multiplier. Seal script wants one weight across the set,
   * but a nineteen-stroke character in the same em as a one-stroke character
   * will clot unless it is drawn a little finer — the same concession CJK type
   * designers make. Only ever used to *reduce*, and never below about 0.8.
   */
  w?: number;
  /** What is approximate about this form. Surfaced by the coverage sheet. */
  note?: string;
  /** Centreline strokes. */
  s?: string[];
  /** Component placements, `"<ref> x0 y0 x1 y1 [widthScale]"`. */
  p?: string[];
}

// ===========================================================================
// Shared components
// ===========================================================================

/**
 * Radicals, authored edge to edge in their own 0..100 box. Not part of the
 * public roster — `getSealGlyph('@water')` is not a thing a consumer does.
 */
export const PARTS: Record<string, RawGlyph> = {
  // 亻 — 人 compressed to the left. Seal 人 is two strokes from one origin: a
  // long curve falling away to the left and a shorter one dropping straight.
  // The two must splay hard, because as a left radical this whole box is
  // squeezed to about a third of its width and a narrow V closes into one blob.
  '@person': {
    tier: 'high',
    s: ['88 4 Q 52 26 28 56 Q 8 84 10 98', '54 40 Q 62 68 68 98'],
  },

  // 氵 — 水 as a left radical. Seal 水 is a wavering central current with short
  // eddies flung off each side; compressed it keeps the wave and two per side.
  '@water': {
    tier: 'high',
    s: [
      '58 4 Q 34 26 44 52 Q 54 76 34 96',
      '52 22 Q 30 26 14 20',
      '48 46 Q 24 52 8 46',
      '52 34 Q 74 32 88 24',
      '46 64 Q 70 66 86 60',
    ],
  },

  // 木 — trunk with two arms lifting and two roots falling. Seal 木 has no
  // horizontal bar; the modern 一 is these two upper arms fused.
  '@tree': {
    tier: 'high',
    s: [
      '50 4 L 50 96',
      '50 34 Q 32 22 8 12',
      '50 34 Q 68 22 92 12',
      '50 56 Q 32 72 8 92',
      '50 56 Q 68 72 92 92',
    ],
  },

  // 口 — a rounded box. Authored as one closed centreline.
  '@mouth': {
    tier: 'high',
    s: ['16 22 Q 10 22 10 32 L 10 76 Q 10 88 22 88 L 84 88 Q 92 88 92 78 L 92 32 Q 92 22 82 22 L 16 22'],
  },

  // 囗 — the full enclosure, taller and squarer than 口.
  '@box': {
    tier: 'high',
    s: ['16 6 Q 8 6 8 16 L 8 84 Q 8 94 18 94 L 84 94 Q 92 94 92 84 L 92 16 Q 92 6 82 6 L 16 6'],
  },

  // 田 — enclosure plus the cross of the field paths.
  '@field': {
    tier: 'high',
    p: ['@box 0 0 100 100'],
    s: ['50 8 L 50 92', '8 50 L 92 50'],
  },

  // 日 — narrower than 田, one bar.
  '@sun': {
    tier: 'high',
    s: ['24 6 Q 16 6 16 16 L 16 84 Q 16 94 26 94 L 76 94 Q 84 94 84 84 L 84 16 Q 84 6 74 6 L 24 6', '16 50 L 84 50'],
  },

  // 月 — the crescent: a bowed left wall, a plumb right wall, two inner bars.
  '@moon': {
    tier: 'high',
    s: [
      '58 8 Q 24 14 20 50 Q 16 84 34 96',
      '78 10 L 78 92',
      '58 8 Q 70 8 78 12',
      '34 96 Q 60 98 78 92',
      '22 40 L 78 40',
      '19 66 L 78 66',
    ],
  },

  // 貝 — shell: a barred box on two legs.
  '@shell': {
    tier: 'high',
    s: [
      '22 6 L 22 62',
      '22 6 L 70 6 Q 78 6 78 16 L 78 62',
      '22 62 L 78 62',
      '22 24 L 78 24',
      '22 43 L 78 43',
      '38 62 Q 30 80 16 96',
      '62 62 Q 70 80 84 96',
    ],
  },

  // 禾 — grain: a drooping head, a stem, one bar, two falling leaves.
  '@grain': {
    tier: 'high',
    s: [
      '18 12 Q 38 2 60 14',
      '48 10 L 48 96',
      '6 38 Q 48 30 92 38',
      '48 54 Q 30 72 8 92',
      '48 54 Q 66 72 88 92',
    ],
  },

  // 火 — a standing flame with two licks flung outward.
  '@fire': {
    tier: 'high',
    s: [
      '50 4 L 50 58',
      '50 32 Q 30 48 16 68 Q 6 82 10 96',
      '50 32 Q 70 48 84 68 Q 94 82 90 96',
      '24 16 Q 18 28 20 40',
      '76 16 Q 82 28 80 40',
    ],
  },

  // 石 as a left radical: the 厂 cliff over a small 口.
  '@stoneRad': {
    tier: 'high',
    s: [
      '10 14 L 90 14',
      '20 14 Q 12 48 6 94',
      '30 48 L 88 48 W0.95',
      '30 48 L 30 84 W0.95',
      '88 48 L 88 84 W0.95',
      '30 84 L 88 84 W0.95',
    ],
  },

  // 包 — the 勹 wrap closing over a curled 巳. The inner box is held well clear
  // of the wrap's right wall: this component is placed at about half width in
  // 炮 and 砲, which halves every horizontal gap while the stroke weight stays
  // put, so the counters have to be authored generously.
  '@bao': {
    tier: 'high',
    s: [
      '6 36 Q 26 4 60 6 Q 92 8 92 40 L 92 74 Q 92 96 64 98',
      '20 38 L 64 38 L 64 62 L 20 62 L 20 38',
      '42 62 Q 42 82 54 88 Q 70 94 84 86',
    ],
  },

  // 彳 — the step radical: two short falls off a plumb stem.
  '@step': {
    tier: 'legible',
    s: ['64 10 L 52 96', '64 10 Q 34 18 26 32', '58 42 Q 30 50 22 64'],
  },

  // 忄 — the standing heart: a stem with a bead each side.
  '@heart': {
    tier: 'high',
    s: ['52 10 L 48 96', '18 26 Q 12 40 14 54', '84 26 Q 90 40 88 54'],
  },

  // 扌 — the hand radical: bar, hooked stem, rising flick.
  '@hand': {
    tier: 'high',
    s: ['8 34 L 88 34', '52 8 L 52 78 Q 52 94 30 92', '14 62 Q 32 56 48 48'],
  },

  // 辶 — the walking radical: a bead, a fold, and the long level sweep.
  '@walk': {
    tier: 'legible',
    note: 'The 平捺 sweep is a single arc; a brush would swell and release along it.',
    s: ['30 8 Q 24 16 24 24', '8 34 Q 24 44 20 58 Q 16 72 26 80', '10 64 Q 16 90 42 94 L 84 92 Q 96 92 98 82'],
  },

  // 隹 — the short-tailed bird: crest, plumb spine, four wing bars.
  '@bird': {
    tier: 'legible',
    s: [
      '40 6 Q 26 14 20 26',
      '38 20 L 38 96',
      '14 30 L 92 30',
      '14 50 L 92 50',
      '14 70 L 92 70',
      '20 90 L 92 90',
      '80 20 L 80 88',
    ],
  },

  // 𦰩 — the right half of 漢 and the left of 難.
  '@han': {
    tier: 'high',
    s: [
      '8 18 L 92 18',
      '26 4 L 26 34',
      '74 4 L 74 34',
      '10 34 L 90 34',
      '24 44 L 76 44',
      '24 44 L 24 62',
      '76 44 L 76 62',
      '24 62 L 76 62',
      '4 74 L 96 74',
      '50 34 L 50 74',
      '50 74 Q 36 84 18 98',
      '50 74 Q 64 84 82 98',
    ],
  },

  // 可 — bar, the 丂 falling hook, and 口 tucked beneath.
  '@ke': {
    tier: 'high',
    s: [
      '6 20 L 94 20',
      '78 20 L 78 66 Q 78 92 48 92',
      '10 38 L 62 38',
      '10 38 L 10 74',
      '62 38 L 62 74',
      '10 74 L 62 74',
    ],
  },

  // 疋 — the 乛 knee over 止.
  '@shu': {
    tier: 'legible',
    s: ['22 10 Q 50 2 76 12', '50 12 L 50 96', '18 44 L 50 44', '76 34 L 76 96', '8 96 L 94 96'],
  },

  // 广 — the lean-to: a bead, a bar, and the long left fall.
  '@shelter': {
    tier: 'legible',
    s: ['52 2 L 52 12', '12 20 L 92 20', '20 20 Q 12 56 4 96'],
  },

  // 皿 — the vessel: a barred box on a wide foot.
  '@vessel': {
    tier: 'high',
    s: ['14 14 L 86 14', '22 14 L 22 76', '78 14 L 78 76', '42 14 L 42 76', '58 14 L 58 76', '22 76 L 78 76', '4 92 L 96 92'],
  },

  // 衤 — the clothing radical.
  '@clothRad': {
    tier: 'legible',
    s: ['60 4 Q 48 10 44 20', '14 26 L 90 26', '52 20 L 52 96', '24 50 Q 14 62 12 76', '80 50 Q 90 62 92 76'],
  },
};

// ===========================================================================
// The public roster
// ===========================================================================

export const GLYPHS: Record<string, RawGlyph> = {
  // -------------------------------------------------------------------------
  // Piece faces — the fourteen that are largest on screen
  // -------------------------------------------------------------------------

  // 帥 — 𠂤 (stacked curls) + 巾. The right half is the reliable half: 冂 with a
  // descender through it. The left is the seal 𠂤, two curls off a plumb spine.
  '帥': {
    tier: 'high',
    note: '𠂤 on the left is read as three hooks off one spine. Closed curls are '
      + 'closer to some Qin rubbings but they fill in at piece size.',
    s: [
      '38 8 L 38 94',
      '38 14 L 22 14 Q 16 14 16 22 L 16 33',
      '38 44 L 22 44 Q 16 44 16 52 L 16 63',
      '38 74 L 22 74 Q 16 74 16 82 L 16 93',
      '50 26 L 92 26',
      '56 26 L 56 70 Q 56 80 64 82',
      '88 26 L 88 70 Q 88 80 80 82',
      '72 26 L 72 94',
    ],
  },

  // 將 — 爿 + 夕 over 寸.
  '將': {
    tier: 'high',
    note: '夕 is drawn as a single crescent with one inner bar; seal forms vary here.',
    s: [
      '34 8 L 34 94',
      '14 18 L 14 42',
      '14 18 L 34 18',
      '14 42 L 34 42',
      '12 72 L 34 72',
      '48 12 Q 74 8 84 24 Q 92 38 78 46',
      '58 26 Q 68 30 76 38',
      '42 64 L 92 64',
      '70 52 L 70 84 Q 70 94 58 92',
      '54 74 Q 60 76 64 79',
    ],
  },

  // 仕 — 亻 + 士.
  '仕': {
    tier: 'high',
    p: ['@person 4 8 34 94'],
    s: ['40 26 L 96 26', '68 26 L 68 74', '50 74 L 88 74'],
  },

  // 士 — 一 over 十. Top bar long, foot bar short; that ratio is the whole glyph.
  '士': {
    tier: 'high',
    s: ['10 22 L 90 22', '50 22 L 50 78', '32 78 L 68 78'],
  },

  // 相 — 木 + 目.
  '相': {
    tier: 'high',
    p: ['@tree 2 6 46 94', '目 50 6 98 94 0.95'],
  },

  // 象 — the pictograph: crown, curled trunk, barrelled body, legs and tail.
  // The trunk curl is what makes it read; everything else supports it.
  '象': {
    tier: 'high',
    note: 'Structure is the clerical/regular 象 (彑 + 豕) drawn at seal weight and '
      + 'proportion, not the Qin pictograph — the Qin form keeps the trunk hanging '
      + 'clear of the body, and every version of that I drew read as a different '
      + 'animal at piece size. The stroke quality is piece-grade; the form is a '
      + 'compromise, and it is the one glyph here a calligrapher would reject.',
    s: [
      '58 6 Q 46 10 38 20',
      '40 18 L 68 18',
      '34 30 L 74 30',
      '34 30 L 34 52',
      '74 30 L 74 52',
      '34 52 L 74 52',
      '12 62 L 88 62',
      '50 52 L 50 74',
      '32 74 L 72 74',
      '42 74 Q 33 86 20 98',
      '62 74 Q 71 86 84 98',
      '53 74 Q 53 88 51 98',
    ],
  },

  // 傌 — 亻 + 馬.
  '傌': {
    tier: 'high',
    p: ['@person 2 8 30 94', '馬 30 8 100 94 0.92'],
  },

  // 馬 — mane bars inside the body enclosure, four legs beneath.
  '馬': {
    tier: 'high',
    note: 'The Qin 馬 keeps a visible eye and a longer mane; this reads the mane as '
      + 'three bars, which is the Han seal simplification.',
    s: [
      '20 14 L 78 14',
      '78 14 Q 86 14 86 24 L 86 62 Q 86 70 76 70',
      '34 8 L 34 70',
      '20 32 L 86 32',
      '20 50 L 86 50',
      '20 70 L 78 70',
      '24 76 Q 21 84 18 94',
      '42 76 Q 40 84 39 94',
      '60 76 Q 60 84 60 94',
      '78 76 Q 81 84 84 94',
    ],
  },

  // 俥 — 亻 + 車.
  '俥': {
    tier: 'high',
    p: ['@person 2 8 32 94', '車 32 6 100 94 0.92'],
  },

  // 車 — the axle running the full height, the carriage boxed at the middle,
  // the two axle-ends barred. The cleanest of the fourteen.
  '車': {
    tier: 'high',
    s: [
      '50 6 L 50 94',
      '18 22 L 82 22',
      '18 80 L 82 80',
      '28 36 L 72 36',
      '28 36 L 28 66',
      '72 36 L 72 66',
      '28 66 L 72 66',
      '28 51 L 72 51',
    ],
  },

  // 炮 — 火 + 包.
  '炮': {
    tier: 'high',
    p: ['@fire 2 8 46 94 0.95', '@bao 48 6 98 94 0.95'],
  },

  // 砲 — 石 + 包.
  '砲': {
    tier: 'high',
    p: ['@stoneRad 2 8 46 94 0.95', '@bao 48 6 98 94 0.95'],
  },

  // 兵 — 斤 over 廾: an axe held in two hands.
  '兵': {
    tier: 'high',
    s: [
      '38 8 Q 24 18 15 34',
      '18 30 L 80 30',
      '60 30 L 60 56',
      '12 56 L 88 56',
      '30 67 L 70 67',
      '36 67 Q 30 80 22 94',
      '64 67 Q 70 80 78 94',
    ],
  },

  // 卒 — 衣 with the conscript's mark struck through it.
  '卒': {
    tier: 'high',
    s: [
      '50 2 L 50 12',
      '12 22 L 88 22',
      '50 22 L 50 96',
      '34 27 Q 22 50 12 74',
      '66 27 Q 78 50 88 74',
      '44 27 Q 40 50 36 74',
      '56 27 Q 60 50 64 74',
      '20 80 L 80 80',
    ],
  },

  // -------------------------------------------------------------------------
  // The river inscription — 楚 河 漢 界, incised into the board
  // -------------------------------------------------------------------------

  // 楚 — 林 over 疋.
  '楚': {
    w: 0.95,
    tier: 'high',
    p: ['@tree 4 0 48 46 0.88', '@tree 52 0 96 46 0.88', '@shu 16 48 84 98 0.9'],
  },

  // 河 — 氵 + 可.
  '河': {
    tier: 'high',
    p: ['@water 2 8 32 92', '@ke 34 8 98 92'],
  },

  // 漢 — 氵 + 𦰩.
  '漢': {
    w: 0.95,
    tier: 'high',
    p: ['@water 2 8 30 92', '@han 32 6 98 94'],
  },

  // 界 — 田 over 介.
  '界': {
    tier: 'high',
    p: ['@field 20 6 80 48 0.9'],
    s: ['50 50 Q 38 62 28 80', '50 50 Q 62 62 72 80', '38 68 L 34 94', '62 68 L 66 94'],
  },

  // -------------------------------------------------------------------------
  // HUD — legible standard
  // -------------------------------------------------------------------------

  // 先 — 𠂒 over 儿.
  '先': {
    tier: 'legible',
    s: [
      '26 26 L 72 26',
      '46 10 L 46 50',
      '16 50 L 84 50',
      '36 50 Q 30 72 22 92',
      '62 50 Q 66 74 68 84 Q 70 94 82 90',
    ],
  },

  // 手 — the arm with three fingers laid across it.
  '手': {
    tier: 'legible',
    s: [
      '50 12 L 50 82 Q 50 92 38 92',
      '30 24 Q 50 16 70 24',
      '22 46 Q 50 40 78 46',
      '16 68 Q 50 63 84 68',
    ],
  },

  // 後 — 彳 + 幺 + 夂.
  '後': {
    tier: 'legible',
    note: '幺 is reduced to a single coil; the Qin form doubles it.',
    p: ['@step 4 10 32 94'],
    s: [
      '54 14 Q 76 14 72 32 Q 68 46 52 42',
      '44 50 Q 62 46 80 52',
      '44 58 Q 62 56 82 60',
      '58 50 Q 52 72 42 94',
      '64 66 Q 74 80 86 94',
    ],
  },

  // 軍 — 冖 over 車.
  '軍': {
    tier: 'legible',
    p: ['車 12 28 88 96 0.92'],
    s: ['20 26 Q 20 14 34 13 L 66 13 Q 80 14 80 26'],
  },

  // 和 — 禾 + 口.
  '和': {
    tier: 'legible',
    p: ['@grain 2 6 46 94 0.95', '@mouth 52 34 98 84 0.95'],
  },

  // 局 — 尸 over 勹 and 口. The 勹 has to stay clear of the 尸's middle bar or
  // the whole thing collapses into 后, which matters: 和局 is a drawn game.
  '局': {
    tier: 'legible',
    s: [
      '20 6 L 86 6',
      '20 6 L 20 40',
      '20 38 L 66 38',
      '20 38 Q 14 66 4 96',
      '34 52 L 74 52 Q 82 52 82 62 L 82 84 Q 82 93 71 91',
      '34 64 L 62 64',
      '34 64 L 34 86',
      '62 64 L 62 86',
      '34 86 L 62 86',
    ],
  },

  // 勝 — 月 + 龹 over 力.
  '勝': {
    w: 0.9,
    tier: 'legible',
    note: 'The 龹 upper right is compressed hard; stroke count is right, spacing is not.',
    p: ['@moon 2 8 42 94 0.9'],
    s: [
      '56 12 Q 54 18 53 24',
      '82 12 Q 84 18 85 24',
      '48 30 L 92 30',
      '52 44 L 88 44',
      '70 24 L 70 52',
      '52 58 L 82 58 Q 90 58 90 68 L 90 80 Q 90 92 78 92',
      '68 58 Q 62 76 52 94',
    ],
  },

  // 負 — the bending figure over 貝.
  '負': {
    tier: 'legible',
    p: ['@shell 12 28 88 96 0.95'],
    s: ['58 8 Q 46 14 38 24', '42 20 L 68 20'],
  },

  // 悔 — 忄 + 每.
  '悔': {
    tier: 'legible',
    note: '母 inside 每 is reduced to two walls, a through-bar and two beads.',
    p: ['@heart 2 8 34 94 0.95'],
    s: [
      '64 8 Q 52 12 46 20',
      '42 24 L 96 24',
      '52 34 L 52 72',
      '86 34 L 86 68 Q 86 78 74 76',
      '52 34 L 86 34',
      '42 52 L 96 52',
      '61 42 Q 63 43 65 45',
      '73 60 Q 75 61 77 63',
    ],
  },

  // 棋 — 木 + 其.
  '棋': {
    w: 0.94,
    tier: 'legible',
    p: ['@tree 0 6 44 94 0.95'],
    s: [
      '56 18 L 56 30',
      '84 18 L 84 30',
      '48 30 L 92 30',
      '52 46 L 88 46',
      '48 62 L 92 62',
      '58 30 L 58 62',
      '82 30 L 82 62',
      '46 72 L 94 72',
      '58 72 Q 55 84 52 94',
      '82 72 Q 85 84 88 94',
    ],
  },

  // 提 — 扌 + 是.
  '提': {
    tier: 'legible',
    p: ['@hand 2 8 42 94 0.95', '@sun 52 6 94 42 0.85'],
    s: ['50 52 L 96 52', '66 44 L 66 68', '48 68 L 92 68', '62 68 Q 58 82 50 96', '76 70 Q 84 84 94 96'],
  },

  // 示 — 二 over the three falling marks of an altar.
  '示': {
    tier: 'legible',
    s: ['32 16 L 68 16', '12 36 L 88 36', '50 36 L 50 92', '34 48 Q 29 68 25 88', '66 48 Q 71 68 75 88'],
  },

  // 覆 — 覀 over 復. The densest glyph in the roster.
  '覆': {
    w: 0.82,
    tier: 'legible',
    note: 'Weakest glyph in the file. Eighteen strokes in one em; the 覀 lid and the '
      + '复 stack are both compressed past what seal proportion wants.',
    p: ['@step 2 44 26 96 0.85'],
    s: [
      '10 12 L 90 12',
      '24 12 L 24 32',
      '50 12 L 50 32',
      '76 12 L 76 32',
      '16 32 L 84 32',
      '34 42 L 92 42',
      '44 50 L 84 50',
      '44 50 L 44 70',
      '84 50 L 84 70',
      '44 70 L 84 70',
      '44 60 L 84 60',
      '34 78 L 92 78',
      '58 70 Q 52 84 42 96',
      '68 80 Q 78 88 90 96',
    ],
  },

  // 盤 — 般 over 皿.
  '盤': {
    w: 0.82,
    tier: 'legible',
    p: ['@vessel 10 54 90 96 0.9'],
    s: [
      '18 10 L 18 46',
      '18 10 L 44 10 L 44 46',
      '12 24 L 50 24',
      '12 35 L 50 35',
      '18 46 L 44 46',
      '58 10 L 88 10',
      '58 10 L 58 26',
      '88 10 L 88 26',
      '58 26 L 88 26',
      '62 32 Q 72 42 86 48',
      '88 32 Q 74 42 60 50',
    ],
  },

  // 難 — 𦰩 + 隹.
  '難': {
    w: 0.85,
    tier: 'legible',
    p: ['@han 2 6 48 94 0.85', '@bird 52 6 98 94 0.85'],
  },

  // 度 — 广 over 廿 over 又.
  '度': {
    tier: 'legible',
    p: ['@shelter 2 2 98 96 0.95'],
    s: [
      '28 34 L 80 34',
      '42 26 L 42 46',
      '64 26 L 64 46',
      '32 46 L 76 46',
      '30 58 Q 56 56 64 68 Q 70 80 58 92',
      '46 64 Q 60 78 78 94',
    ],
  },

  // 初 — 衤 + 刀.
  '初': {
    tier: 'legible',
    p: ['@clothRad 2 6 46 94 0.95'],
    s: ['54 22 Q 76 20 84 32 L 84 66 Q 84 86 66 90', '72 28 Q 62 58 50 92'],
  },

  // 學 — 𦥑 over 爻 under 冖 over 子.
  '學': {
    w: 0.88,
    tier: 'legible',
    note: 'Sixteen strokes compressed into one em. The paired hands at the top are '
      + 'reduced to two brackets; the 爻 keeps its four strokes.',
    s: [
      '8 12 L 8 34',
      '8 12 L 24 12',
      '8 26 L 22 26',
      '92 12 L 92 34',
      '76 12 L 92 12',
      '78 26 L 92 26',
      '34 12 Q 42 20 48 28',
      '62 12 Q 54 20 48 28',
      '34 32 Q 42 40 48 48',
      '62 32 Q 54 40 48 48',
      '14 56 Q 50 50 86 56',
      '32 64 Q 52 62 64 68 Q 70 74 60 78',
      '52 68 L 52 88 Q 52 96 40 94',
      '32 78 L 72 78',
    ],
  },

  // 國 — 囗 enclosing 或.
  '國': {
    w: 0.92,
    tier: 'legible',
    p: ['@box 6 6 94 94 0.95'],
    s: [
      '30 26 L 70 26',
      '50 20 L 50 44',
      '36 32 L 64 32',
      '36 32 L 36 48',
      '64 32 L 64 48',
      '36 48 L 64 48',
      '26 58 L 74 58',
      '58 22 Q 70 42 72 62 Q 73 74 62 74',
      '62 30 Q 68 25 74 20',
    ],
  },

  // 目 — the upright eye. Simple, symmetric, and one of the cleanest here.
  '目': {
    tier: 'high',
    s: [
      '38 12 Q 32 12 32 20 L 32 80 Q 32 90 40 90 L 62 90 Q 68 90 68 82 L 68 20 Q 68 12 60 12 L 38 12',
      '32 38 L 68 38',
      '32 64 L 68 64',
    ],
  },

  // 前 — 丷 over 一 over 月 and 刂.
  '前': {
    tier: 'legible',
    p: ['@moon 26 36 62 96 0.9'],
    s: [
      '34 10 Q 32 16 30 22',
      '66 10 Q 68 16 70 22',
      '12 30 L 88 30',
      '70 40 L 70 76',
      '86 38 L 86 84 Q 86 94 74 92',
    ],
  },

  // -------------------------------------------------------------------------
  // Move notation
  // -------------------------------------------------------------------------

  // 進 — 辶 + 隹.
  '進': {
    tier: 'legible',
    p: ['@walk 2 8 98 96 0.9', '@bird 36 8 94 74 0.85'],
  },

  // 退 — 辶 + 艮.
  '退': {
    tier: 'legible',
    p: ['@walk 2 8 98 96 0.9'],
    s: ['40 12 L 88 12', '40 12 L 40 52', '40 32 L 86 32', '40 52 L 88 52', '56 52 Q 50 64 40 76', '58 58 Q 70 68 86 78'],
  },

  // 平 — 干 with a mark each side of the stem.
  '平': {
    tier: 'legible',
    // The 丷 has to stay short and near-plumb: drawn as long diagonals it reads
    // as the arms of 本 at HUD size, and 平 is half the move record.
    s: ['12 32 L 88 32', '38 40 L 32 58', '62 40 L 68 58', '12 68 L 88 68', '50 10 L 50 92'],
  },

  // -------------------------------------------------------------------------
  // Chinese numerals — Red's files and move counts
  // -------------------------------------------------------------------------

  '一': { tier: 'high', s: ['14 52 Q 50 47 86 52'] },
  '二': { tier: 'high', s: ['22 34 Q 50 30 78 34', '14 68 Q 50 64 86 68'] },
  '三': { tier: 'high', s: ['22 26 Q 50 22 78 26', '28 51 Q 50 48 72 51', '14 76 Q 50 72 86 76'] },

  '四': {
    tier: 'legible',
    s: [
      '24 20 L 24 80',
      '24 20 L 68 20 Q 76 20 76 28 L 76 80',
      '24 80 L 76 80',
      '39 30 L 39 58 Q 39 68 48 68',
      '61 30 L 61 58 Q 61 68 52 68',
    ],
  },

  '五': {
    tier: 'legible',
    s: ['20 22 L 80 22', '16 80 L 84 80', '34 22 Q 50 51 66 80', '66 22 Q 50 51 34 80'],
  },

  '六': {
    tier: 'legible',
    s: ['50 10 L 50 20', '26 32 Q 50 26 74 32', '36 32 Q 30 58 22 84', '64 32 Q 70 58 78 84'],
  },

  '七': {
    tier: 'legible',
    s: ['18 40 L 82 40', '48 16 L 48 62 Q 48 80 74 78'],
  },

  '八': {
    tier: 'high',
    s: ['42 22 Q 34 52 24 84', '58 22 Q 66 52 76 84'],
  },

  '九': {
    tier: 'legible',
    note: 'Freest form in the roster; the seal 九 is a single elbow and this splits it '
      + 'into the modern 丿 plus 横折彎鉤 to keep it readable at HUD size.',
    s: ['46 14 Q 34 44 24 68 Q 17 84 22 92', '22 22 L 62 22 Q 74 22 74 34 L 74 62 Q 74 84 90 86'],
  },

  // -------------------------------------------------------------------------
  // Full-width digits — Black's files, per 棋譜 convention.
  //
  // These are NOT Chinese characters and seal script has nothing to say about
  // them, so they are drawn as monoline geometric digits at the same weight as
  // the seal strokes. They sit beside the seal glyphs without pretending to be
  // one, which is what a printed 棋譜 does with Arabic numerals too.
  // -------------------------------------------------------------------------

  '１': { tier: 'legible', s: ['34 28 L 50 14 L 50 86'] },
  '２': { tier: 'legible', s: ['30 30 Q 32 14 50 14 Q 68 14 68 32 Q 68 48 30 86 L 72 86'] },
  '３': {
    tier: 'legible',
    s: ['30 24 Q 40 14 54 14 Q 70 14 70 30 Q 70 45 52 47', '52 47 Q 72 49 72 66 Q 72 86 50 86 Q 32 86 28 74'],
  },
  '４': { tier: 'legible', s: ['60 14 L 26 62 L 74 62', '60 14 L 60 88'] },
  '５': { tier: 'legible', s: ['68 14 L 34 14 L 30 46 Q 44 39 55 44 Q 72 50 72 66 Q 72 86 50 86 Q 32 86 28 74'] },
  '６': { tier: 'legible', s: ['66 18 Q 48 12 39 28 Q 30 44 30 62 Q 30 86 50 86 Q 70 86 70 66 Q 70 48 50 48 Q 34 48 30 62'] },
  '７': { tier: 'legible', s: ['28 14 L 72 14 L 44 88'] },
  '８': {
    tier: 'legible',
    s: ['50 14 Q 33 14 33 29 Q 33 44 50 48 Q 69 53 69 68 Q 69 86 50 86 Q 31 86 31 68 Q 31 53 50 48 Q 67 44 67 29 Q 67 14 50 14'],
  },
  '９': { tier: 'legible', s: ['34 84 Q 52 90 61 74 Q 70 58 70 40 Q 70 16 50 16 Q 30 16 30 36 Q 30 54 50 54 Q 66 54 70 40'] },
};

/** Every character the roster covers, in authoring order. */
export const SEAL_ROSTER: readonly string[] = Object.keys(GLYPHS);
