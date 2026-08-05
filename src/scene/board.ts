/**
 * The board.
 *
 * This is a table, not a plane with a picture on it. It has a mitred timber
 * frame with a turned edge profile you can read from the waterline, a silk deck
 * inset into that frame with a couple of millimetres of sag in it, a river cut
 * *through* the deck to a stone-banked channel with water running in it, and
 * every line on it — the 9×10 grid, the 炮位 and 兵位 brackets, and 楚河漢界
 * itself — physically incised, with two walls that take the key light
 * differently. The palace diagonals are the one mark that is applied rather than
 * cut: they are gold leaf, and leaf is pressed onto a ground.
 *
 * **The deck is cut around every one of those incisions.** A groove under a
 * continuous sheet of silk is not a groove, it is a groove with a lid on it, and
 * that is what the first two rounds of this board shipped — see the note on
 * `GRID_HALF_WIDTH` for what it measured at DPR 2. Each line hands back the
 * rectangle it opens in the silk, and `buildDeck` leaves those rectangles empty
 * exactly as it does for the four inscription panels.
 *
 * Vertical budget, all in world units where one unit is one board square:
 *
 * ```
 *   +0.086   top of the timber frame            FRAME_TOP_Y
 *   +0.014   stone banking cap, proud of the silk
 *   +0.006   top of the palace gold leaf        LEAF_LIFT
 *    0.000   the silk deck  (± ~0.002 of sag)   <- coords.ts's y = 0
 *   −0.012   bottom of a grid incision, and of 楚河漢界
 *   −0.048   the water surface                  WATER_Y
 *   −0.120   the river bed                      RIVER_DEPTH
 *   −0.635   underside of the table             TABLE_BOTTOM_Y
 *   −0.640   the terrace the table stands on     OFF_BOARD_Y
 * ```
 *
 * `heightAt()` is the single authority on all of that, and it is evaluated from
 * *the same profile arrays the meshes were lofted from*, so the height field the
 * animator plants feet against cannot drift from the geometry it is describing.
 *
 * The board group is expected to sit at the world origin untransformed —
 * `core/coords.ts` defines world positions directly, and the water shader reads
 * world space to find the channel walls.
 */

import * as THREE from 'three';
import type { BoardScene, GongbiMaterials } from '@core/contracts.ts';
import {
  BOARD_HALF_X,
  BOARD_HALF_Z,
  FILES,
  RANKS,
  RIVER_BLACK_BANK,
  RIVER_RED_BANK,
  worldX,
  worldZ,
} from '@core/coords.ts';
import { SCENE } from '@core/palette.ts';
import { seedFor, type Rng } from '@core/rng.ts';
import {
  MeshBuilder,
  mitredFrame,
  norm3,
  orientedQuad,
  sampleProfile,
  sweepAlongPath,
  type P3,
  type ProfilePoint,
} from './geometry.ts';
import { createRiverWater, type RiverWater } from './water.ts';
import { Markers } from './markers.ts';
import { PieceBases, glyphInkBox, inciseOutline, type SealOutline, type SealSource } from './bases.ts';

// ===========================================================================
// Metrics
// ===========================================================================

/** Silk extends this far past the outermost grid line before the frame starts. */
export const SILK_MARGIN = 0.84;
export const SILK_HALF_X = BOARD_HALF_X + SILK_MARGIN; // 4.84
export const SILK_HALF_Z = BOARD_HALF_Z + SILK_MARGIN; // 5.34

/** Height of the timber frame's top face above the silk. */
export const FRAME_TOP_Y = 0.086;
/** Underside of the table. */
export const TABLE_BOTTOM_Y = -0.635;
/**
 * The stone terrace the table stands on. `heightAt` returns this off the table
 * edge, and `backdrop.ts` lays its terrace at exactly this height so the two
 * agree about where the world outside the board is.
 */
export const OFF_BOARD_Y = -0.64;
/** Hairline left at each mitre so the joint reads as four rails, not one tray. */
const MITRE_GAP = 0.007;

/**
 * Cross-section of the timber frame, as outward offset from the silk edge.
 * Points 0..8 climb monotonically out to the widest point, which is what
 * `heightAt` walks; the rest is the turned edge below the arris, which nothing
 * ever stands on but the camera sees on every low shot.
 */
export const FRAME_PROFILE: readonly ProfilePoint[] = [
  { u: 0.0, y: 0.0, hard: true }, // rebate: meets the silk exactly
  { u: 0.026, y: 0.048 },
  { u: 0.072, y: 0.078 },
  { u: 0.14, y: FRAME_TOP_Y, hard: true }, // inner arris
  { u: 0.858, y: FRAME_TOP_Y, hard: true }, // flat top face
  { u: 0.938, y: 0.07, hard: true }, // outer chamfer
  { u: 0.984, y: 0.026 },
  { u: 1.008, y: -0.026 },
  { u: 1.02, y: -0.09, hard: true }, // widest point — the bead
  { u: 0.986, y: -0.152 },
  { u: 0.958, y: -0.238 }, // the cove
  { u: 0.988, y: -0.334 },
  { u: 1.012, y: -0.43, hard: true }, // lower fascia
  { u: 0.996, y: -0.556 },
  { u: 0.948, y: -0.628, hard: true },
  { u: 0.9, y: TABLE_BOTTOM_Y, hard: true },
];

/** Index of the widest profile point; everything past it is below the deck. */
const FRAME_DECK_POINTS = 9;
export const FRAME_WIDTH = FRAME_PROFILE[FRAME_DECK_POINTS - 1].u; // 1.02
export const TABLE_HALF_X = SILK_HALF_X + FRAME_WIDTH; // 5.86
export const TABLE_HALF_Z = SILK_HALF_Z + FRAME_WIDTH; // 6.36

const FRAME_DECK: readonly ProfilePoint[] = FRAME_PROFILE.slice(0, FRAME_DECK_POINTS);
/** Distance over which the silk's sag is blended out into the frame's rebate. */
const FRAME_SAG_FALLOFF = 0.16;

// --- river -----------------------------------------------------------------

/**
 * The river's cross-section, and the one real trade in this file.
 *
 * The band between rank 4 and rank 5 is exactly one square wide, and two things
 * want it: a sunken channel, and 楚河漢界.
 *
 * The split is set by two measurements rather than by taste. The water has to be
 * wide enough that a camera at the `profile` framing — 1.75 up, 5.9 out — can
 * see over the near bank's cap and onto the far water instead of onto stone;
 * that puts the floor of the requirement at about 0.24 of water. The inscription
 * has to survive the resting `default` framing, which is governed almost
 * entirely by stroke width rather than by character height, and is bought much
 * more cheaply by cutting the strokes twice as fat than by making the characters
 * taller. So the river takes 0.4 of the band and the inscription takes the 0.3
 * that is left on each bank.
 *
 * The walls stand at 66°, steep enough to take the key on one side and go black
 * on the other from any angle the camera can reach.
 */
export const RIVER_DEPTH = 0.12;
export const RIVER_FLOOR_HALF = 0.125;
export const RIVER_CUT_HALF = 0.195;
export const BANK_CAP_HALF = 0.235;
export const BANK_HALF = 0.265;
export const BANK_RISE = 0.014;
export const WATER_Y = -0.048;

/**
 * Cross-section of the river, as |z|. Bed, cut wall, stone cap, chamfer back
 * down to the silk — and then flat silk for every |z| past the chamfer, which is
 * why this one array answers "how high is the board here?" for the entire deck.
 */
export const RIVER_SECTION: readonly ProfilePoint[] = [
  { u: 0.0, y: -RIVER_DEPTH },
  { u: RIVER_FLOOR_HALF, y: -RIVER_DEPTH, hard: true },
  { u: RIVER_CUT_HALF, y: BANK_RISE, hard: true },
  { u: BANK_CAP_HALF, y: BANK_RISE, hard: true },
  { u: BANK_HALF, y: 0, hard: true },
];
/** Which profile points ride up and down with a stone course's own thickness. */
const BANK_LIFT_WEIGHT = [0, 0, 1, 1, 0];

/** Nominal length of one banking stone along the river, before jitter. */
const STONE_LENGTH = 0.44;
const STONE_JOINT = 0.012;
const STONE_JOINT_DROP = 0.0036;
const STONE_LIFT = 0.003;

/** Half-width of the water plane: where the water line meets the cut wall. */
export const WATER_HALF = (() => {
  const t = (WATER_Y + RIVER_DEPTH) / (BANK_RISE + RIVER_DEPTH);
  return RIVER_FLOOR_HALF + t * (RIVER_CUT_HALF - RIVER_FLOOR_HALF) + 0.0036;
})();

// --- incised line work -----------------------------------------------------

/**
 * Nominal half-width and depth of a grid incision. Varied per line.
 *
 * These were 0.0162 and they did not render. A V-groove that narrow is about two
 * device pixels at the resting framing, split between a wall that takes the key
 * and a wall that goes to shadow — one lighter than the silk, one darker. With
 * no coverage-based AA the two rasterise stochastically and *cancel*, and the
 * lattice comes out as a 30–50% duty-cycle dotted trace that goes solid only
 * where a cast shadow removes the lit wall from the competition. A player who
 * cannot see the lattice cannot read the board, so the section is now a flat-
 * bottomed U: the floor is the widest part of it, it is cut in 墨, and its
 * darkness does not depend on the shading of either wall.
 *
 * That was necessary and it was not sufficient, because the silk deck was still
 * ONE CONTINUOUS SHEET laid over the top of every groove. A cut under a sheet is
 * not a cut: measured at DPR 2 from the `top` framing, a rank line came out as a
 * single device pixel at #AD873E against #C59946 silk — 11% contrast — and a
 * file line as two one-pixel marks six pixels apart with full-brightness silk
 * between them, which is the two lips of the incision and nothing else. The
 * whole flat 墨 floor, the widest part of the section and the entire point of
 * it, was underneath the deck and contributed nothing at any camera angle.
 *
 * So the deck is now cut around every incision: `buildGrid` and
 * `buildPositionMarkers` hand back the rectangle each line opens in the silk,
 * and `buildDeck` leaves those rectangles empty exactly as it already did for
 * the four inscription panels. The mouth of the cut is the groove's own width
 * plus `GRID_SKIRT`, and the section carries a matching skirt that comes back
 * down to the deck plane, so the silk and the burr meet along a shared edge
 * with no void and no coplanar z-fight.
 */
const GRID_HALF_WIDTH = 0.028;
const GRID_DEPTH = 0.0132;
/** Width of the wall on each side; the rest of the section is flat floor. */
const GRID_WALL = 0.01;
/** Pressed silk lifts at the edge of a stylus cut; this is that burr. */
const GRID_LIP = 0.0016;
/**
 * How far past the burr the cut's outer skirt runs before it meets the silk
 * again. This is the seam: the deck's hole ends here and the skirt starts here,
 * both at deck height, so the two surfaces share an edge instead of leaving a
 * 1.6 mm crack down each side of every line on the board.
 */
const GRID_SKIRT = 0.004;
/** Vertices per one-square span. 3 puts a vertex exactly on each intersection. */
const SEG_PER_SPAN = 3;

/** Worst-case half-width of a grid groove, for clearance arithmetic. */
export const GRID_HALF_MAX = GRID_HALF_WIDTH * 1.09;
/** Worst-case width of the hole a grid groove opens in the silk. */
export const GRID_MOUTH_MAX = GRID_HALF_MAX + GRID_SKIRT;
/**
 * Lateral bow of a hand-ruled line. Zero, and that is now structural rather
 * than a matter of taste: the silk's hole is a rectangle, so a groove that
 * wanders 2 mm out of it either opens a slit through the tabletop on one side
 * or is covered by the deck on the other. At the `top` framing 2 mm is a
 * quarter of a device pixel — it was never visible — while the seam it breaks
 * is. The hand of the ruler now lives where it can be seen instead: every line
 * carries its own width, its own depth and the silk's own sag under it.
 */
export const GRID_BOW_MAX = 0;

/**
 * Pressed gold leaf on the palace diagonals.
 *
 * The leaf used to be laid into a trench, 5 mm down, and the trench was under
 * the deck — so the gold was not merely dark, it was not on screen at all, and
 * what read as a "dark dashed diagonal" was the pair of trench lips poking a
 * millimetre and a half through the silk. Leaf is not a cut. It is beaten metal
 * pressed ONTO a ground, so it sits on the silk and stands its own thickness
 * proud of it, where the key can reach it.
 *
 * The thickness is the whole trick, and the arithmetic is worth writing down.
 * One board square is one world unit and a piece is 0.69 across, so a unit is
 * about 4 cm: `LEAF_LIFT` is 0.22 mm of built-up gold and `LEAF_EDGE` is a half
 * millimetre of chamfer around it. That chamfer stands at 23°, and 23° is not a
 * decorative number — the gongbi rig's key sits at 0.55 rad, so a horizontal
 * plane lands at N·L 0.704, which is 泥金 band 2 (#BE9430, luma 150) and a hair
 * DARKER than the silk it lies on (luma 165). Nothing flat on this board can
 * reach `BAND_CUTS.gold[2]` = 0.86; the normal has to turn at least 19.2° into
 * the key. The chamfer turns 23°, so an edge that faces the key takes the
 * accent, the edge opposite it drops to band 1, and the flat top holds band 2
 * between them. That is a raised metal inlay lit from one side, and it is the
 * only geometry a level board can offer.
 *
 * Measured at DPR 2 from `top`: the two diagonals whose chamfers face the key's
 * azimuth run 8% and 13% of their area in the band 3 accent, brightest #E9D381
 * at luma 210 against silk at 165; the two that run along the key hold band 2
 * and band 1 and reach luma 197. One arm of each palace's cross catching and
 * the other not is what a single directional key does to a raised line, and it
 * is the read that says metal.
 *
 * `LEAF_FACET` is the smaller half: leaf is beaten, and every square of it lies
 * at its own slight angle, so each carries its own normal rather than sharing
 * the ribbon's. Geometrically they stay flat — a leaf square is microns thick —
 * and the tilt is small enough to stay inside band 2 on the top face.
 */
const LEAF_HALF_WIDTH = 0.029;
/** How far the leaf stands proud of the silk: 0.22 mm of gold. */
const LEAF_LIFT = 0.0055;
/** Width of the chamfer around a square, from the silk up to the flat top. */
const LEAF_EDGE = 0.013;
/** Length of one square of leaf along the diagonal, before jitter. */
const LEAF_PITCH = 0.28;
/** The join between two squares. A hairline: at `top` this is 0.14 device px,
 *  so it is a join seen up close and not a dash seen from the ceiling. */
const LEAF_GAP = 0.0012;
/** Largest tilt of a square's own normal, radians. */
const LEAF_FACET = 0.09;

/** 炮位 / 兵位 brackets. */
const BRACKET_GAP = 0.088;
const BRACKET_LEN = 0.24;
const BRACKET_SCALE = 0.92;

/** Files that carry a soldier point, at ranks 3 and 6. */
const SOLDIER_FILES = [0, 2, 4, 6, 8];
/** Files that carry a cannon point, at ranks 2 and 7. */
const CANNON_FILES = [1, 7];

// --- 楚河漢界 ---------------------------------------------------------------

/**
 * The inscription band on each bank: from just clear of the stone banking out to
 * just clear of the rank line. The rank line's groove is 0.018 wide at its widest
 * and bows by up to 0.0055, so the far limit stops short of 0.5 by both.
 */
const INSCRIPTION_Z0 = BANK_HALF + 0.006;
const INSCRIPTION_Z1 = 0.462;
/** Ink height of the tallest of the four characters, world units. */
const INSCRIPTION_INK = 0.185;
/** Centre-to-centre spacing within a pair, and the width of one glyph's panel. */
const INSCRIPTION_PITCH = 0.34;
/**
 * Where each pair sits horizontally: the centre of its own half of the board.
 *
 * This was 0, which centred BOTH pairs on the middle file. The argument for it
 * was that two pairs placed left and right on opposite banks sit diagonally
 * opposite each other and read as an accident, and that mirroring them across
 * the channel is the only arrangement that looks deliberate from every camera.
 * That argument is wrong about the thing that actually matters. A xiangqi player
 * knows where 楚河漢界 goes; four characters stacked in two rows over the centre
 * file are not a composition, they are an error, and no amount of symmetry
 * reads as intentional when the intention it signals is the wrong one.
 *
 * So: 楚河 takes the left half of the board and 漢界 the right, as every board
 * ever printed does, each pair centred on the middle of its own half. Each is
 * still carved into its own player's bank and still reads toward that player's
 * seat, which is what a carved set does and why the label looks upside-down from
 * the wrong side of the table.
 */
const INSCRIPTION_PAIR_X = 2.0;
/** Depth of the cut. Deeper than a piece base's — it is read from further away. */
const INSCRIPTION_DEPTH = 0.0105;
/**
 * Stroke weight for the inscription, as a multiple of the authored seal weight.
 *
 * This was 2.0, chosen to buy legibility at the resting camera, and it was the
 * wrong trade. At 2.0 the three strokes of 漢's 氵 flood into one another and
 * come out as a single connected spine with two branches — the pen is never
 * lifted — so the radical reads as 扌 and the label stops being a word. 楚 loses
 * the separation between 林 and 疋 the same way.
 *
 * Then it was 1.0, which is correct and is a hair too fine: the river band is
 * 0.19 of a square deep, so the characters ink 0.185 across whatever else
 * happens, and at the authored weight that is a 0.9 device-pixel stroke from the
 * `top` framing. A stroke below one pixel does not alias into a tangle because
 * it is wrong, it aliases because it is not there.
 *
 * 1.5 is the measured ceiling: every one of 楚河漢界 keeps its authored region
 * and counter count up to 1.6, where 界's 田 closes a fifth counter, so this
 * takes the last clean step below it. It buys +47% of stroke — 0.9 device px to
 * 1.32 — for no change in the character's height, because the em shrinks to keep
 * the ink inside the band. The check that gates it is in `verify.ts` and it
 * compares topology at the weight each character is actually cut with, not at a
 * single weight for all of them: the piece bases still cut at 1.0, where 馬 and
 * 砲 need every micron of separation they have.
 */
export const INSCRIPTION_WEIGHT = 1.5;

/** One character of the inscription, with the deck panel it is cut into. */
interface InscriptionChar {
  ch: string;
  outline: SealOutline;
  cx: number;
  cz: number;
  yaw: number;
  /** Em size in world units, shared by all four so they read as one line. */
  em: number;
  panel: DeckHole;
}

/**
 * A rectangle the silk deck leaves empty.
 *
 * Two things ask for one: an inscription panel, which is filled by an incised
 * panel of the same silk instead, and the mouth of an incised line, which is
 * filled by the groove itself. Both are holes in the same sheet and the deck
 * treats them identically.
 */
interface DeckHole {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/**
 * Plan 楚河漢界.
 *
 * 楚 is Chu, which is Black, at −Z; 漢 is Han, which is Red, at +Z. Each pair is
 * carved into its own player's bank and reads toward that player's seat, which
 * is how a real set does it and why the board looks upside-down to whoever is
 * sitting on the wrong side of it.
 *
 * All four share one em size, computed so the *tallest* of them inks
 * `INSCRIPTION_INK`. Sizing each glyph to its own ink box instead would inflate
 * the narrow 界 to match the wide 漢 and the line would stop reading as type.
 */
function planInscription(seal: SealSource | undefined): InscriptionChar[] {
  if (!seal) return [];
  // [character, bank sign, distance from the pair's centre]. Within a pair the
  // first character sits nearer the middle of the board, so each reads
  // left-to-right from its own seat.
  const layout: [string, number, number][] = [
    ['楚', -1, -0.5],
    ['河', -1, +0.5],
    ['漢', +1, -0.5],
    ['界', +1, +0.5],
  ];

  const fetched: { ch: string; bank: number; slot: number; outline: SealOutline }[] = [];
  for (const [ch, bank, slot] of layout) {
    const outline = seal(ch, { weight: INSCRIPTION_WEIGHT });
    if (outline && outline.contours.length > 0) fetched.push({ ch, bank, slot, outline });
  }
  if (fetched.length === 0) return [];

  // One em size for the whole line, set by whichever character inks tallest.
  let tallest = 0;
  for (const f of fetched) {
    const box = glyphInkBox(f.outline);
    const em = f.outline.em ?? Math.max(box.x1 - box.x0, box.y1 - box.y0);
    tallest = Math.max(tallest, (box.y1 - box.y0) / Math.max(em, 1e-6));
  }
  const em = INSCRIPTION_INK / Math.max(tallest, 1e-6);

  const cz = (INSCRIPTION_Z0 + INSCRIPTION_Z1) * 0.5;
  const halfPanelZ = (INSCRIPTION_Z1 - INSCRIPTION_Z0) * 0.5;

  return fetched.map((f) => {
    // Black's bank mirrors in x as well as reading direction, so both pairs put
    // their first character nearer the centre line.
    const cx = f.bank * (INSCRIPTION_PAIR_X + f.slot * INSCRIPTION_PITCH);
    return {
      ch: f.ch,
      outline: f.outline,
      cx,
      cz: f.bank * cz,
      // yaw 0 reads from +Z (Red); π reads from −Z (Black).
      yaw: f.bank < 0 ? Math.PI : 0,
      em,
      panel: {
        x0: cx - INSCRIPTION_PITCH * 0.5,
        x1: cx + INSCRIPTION_PITCH * 0.5,
        z0: f.bank * cz - halfPanelZ,
        z1: f.bank * cz + halfPanelZ,
      },
    };
  });
}

// ===========================================================================
// The silk's sag
// ===========================================================================

/**
 * Aged silk stretched over a panel is never flat. Two low-frequency terms, peak
 * amplitude 1.8 mm at board scale — far too small to see head-on and exactly
 * enough to make a grazing key light travel across the deck instead of hitting
 * it uniformly. Both the mesh and `heightAt` call this, so they agree by
 * construction.
 */
export function silkSag(x: number, z: number): number {
  return (
    0.0012 * Math.sin(x * 0.83 + 0.41) * Math.cos(z * 0.61 - 0.92) +
    0.0006 * Math.sin(x * 2.13 - z * 1.71)
  );
}

function silkNormal(x: number, z: number): P3 {
  const dx =
    0.0012 * 0.83 * Math.cos(x * 0.83 + 0.41) * Math.cos(z * 0.61 - 0.92) +
    0.0006 * 2.13 * Math.cos(x * 2.13 - z * 1.71);
  const dz =
    -0.0012 * 0.61 * Math.sin(x * 0.83 + 0.41) * Math.sin(z * 0.61 - 0.92) -
    0.0006 * 1.71 * Math.cos(x * 2.13 - z * 1.71);
  const l = Math.hypot(dx, 1, dz);
  return [-dx / l, 1 / l, -dz / l];
}

// ===========================================================================
// Builders
// ===========================================================================

type Detail = 'low' | 'medium' | 'high';
const DETAIL_SCALE: Record<Detail, number> = { low: 0.45, medium: 0.72, high: 1 };

/**
 * Cell edges from `lo` to `hi` that pass exactly through every anchor, with the
 * gaps between anchors subdivided into pieces close to `step`.
 *
 * This is what lets the deck leave an exactly-shaped hole for an inscription
 * panel: the panel's edges become anchors, so the deck's own grid lands on them
 * and the panel tiles the hole seamlessly instead of overlapping it.
 */
function gridEdges(lo: number, hi: number, step: number, anchors: readonly number[]): number[] {
  const inner = anchors
    .filter((a) => a > lo + 1e-6 && a < hi - 1e-6)
    .sort((a, b) => a - b)
    .filter((a, i, arr) => i === 0 || a - arr[i - 1] > 1e-6);
  const stops = [lo, ...inner, hi];
  const out: number[] = [lo];
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i];
    const c = stops[i + 1];
    const n = Math.max(1, Math.round((c - a) / step));
    for (let k = 1; k <= n; k++) out.push(a + ((c - a) * k) / n);
  }
  return out;
}

/**
 * The silk deck: two sheets either side of the river channel, with a rectangle
 * left empty for every inscription panel and for the mouth of every incised
 * line on the board.
 *
 * The holes are what make the line work exist. A groove under an unbroken sheet
 * shows nothing but its own two lips, which is what the first two rounds of this
 * board shipped. Each row of the deck pays only for the cuts of the holes that
 * actually cross it, so the ninety-odd bracket arms cost their own two rows and
 * nothing anywhere else.
 */
function buildDeck(b: MeshBuilder, detail: number, holes: readonly DeckHole[]): void {
  const step = 0.26 / Math.max(detail, 0.2);
  const bands: [number, number][] = [
    [BANK_HALF, SILK_HALF_Z],
    [-SILK_HALF_Z, -BANK_HALF],
  ];

  for (const [z0, z1] of bands) {
    const zAnchors: number[] = [];
    for (const h of holes) {
      if (h.z1 > z0 && h.z0 < z1) zAnchors.push(h.z0, h.z1);
    }
    const zEdges = gridEdges(z0, z1, step, zAnchors);
    for (let j = 0; j + 1 < zEdges.length; j++) {
      const za = zEdges[j];
      const zb = zEdges[j + 1];
      const zMid = (za + zb) * 0.5;
      // Only the holes this row actually crosses put cuts into it.
      const rowHoles = holes.filter((h) => zMid > h.z0 && zMid < h.z1);
      const xAnchors: number[] = [];
      for (const h of rowHoles) xAnchors.push(h.x0, h.x1);
      const xEdges = gridEdges(-SILK_HALF_X, SILK_HALF_X, step, xAnchors);
      for (let i = 0; i + 1 < xEdges.length; i++) {
        const xa = xEdges[i];
        const xb = xEdges[i + 1];
        const xMid = (xa + xb) * 0.5;
        if (rowHoles.some((h) => xMid > h.x0 && xMid < h.x1)) continue; // the hole
        const A: P3 = [xa, silkSag(xa, za), za];
        const B: P3 = [xa, silkSag(xa, zb), zb];
        const C: P3 = [xb, silkSag(xb, zb), zb];
        const D: P3 = [xb, silkSag(xb, za), za];
        b.quad(
          A,
          B,
          C,
          D,
          silkNormal(xa, za),
          silkNormal(xa, zb),
          silkNormal(xb, zb),
          silkNormal(xb, za),
          [xa, za],
          [xa, zb],
          [xb, zb],
          [xb, za],
        );
      }
    }
  }
}

/**
 * One incised line, pinned to its endpoints, with both ends closed.
 *
 * The path carries a vertex every third of a square so the groove follows the
 * silk's sag, and one exactly on every marked point — the grid lands on
 * `coords.ts` to the last decimal, which is the property the verification script
 * asserts. It runs dead straight: see `GRID_BOW_MAX`.
 */
function incisedLine(
  b: MeshBuilder,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  spans: number,
  section: readonly ProfilePoint[],
): void {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  const px = uz; // left of travel in XZ
  const pz = -ux;

  const path: number[] = [];
  const n = spans * SEG_PER_SPAN;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const x = ax + dx * t;
    const z = az + dz * t;
    path.push(x, silkSag(x, z), z);
  }
  // Every incised line on this board is a straight run between two marked
  // points, so the groove walls get one normal each along their whole length.
  sweepAlongPath(b, path, section, 1, true);
  capIncision(b, section, ax, silkSag(ax, az), az, px, pz, [-ux, 0, -uz]);
  capIncision(b, section, bx, silkSag(bx, bz), bz, px, pz, [ux, 0, uz]);
}

/**
 * Close the end of a swept incision against the silk.
 *
 * Without this the groove is an open-ended trough and a grazing camera looks
 * straight down it and out through the tabletop. The subtlety is the same one
 * the river's end walls have: the section crosses the deck plane twice, because
 * the burr stands proud of the silk and the floor is below it, so ribboning the
 * section against the deck naively folds the crossing segment into a bowtie. A
 * vertex is inserted at each crossing first and every strip then sits wholly on
 * one side.
 */
function capIncision(
  b: MeshBuilder,
  section: readonly ProfilePoint[],
  x: number,
  y: number,
  z: number,
  lx: number,
  lz: number,
  n: P3,
): void {
  const pts: [number, number][] = [];
  for (let s = 0; s + 1 < section.length; s++) {
    const p0 = section[s];
    const p1 = section[s + 1];
    pts.push([p0.u, p0.y]);
    if (p0.y < 0 !== p1.y < 0 && p0.y !== 0 && p1.y !== 0) {
      const t = -p0.y / (p1.y - p0.y);
      pts.push([p0.u + t * (p1.u - p0.u), 0]);
    }
  }
  const last = section[section.length - 1];
  pts.push([last.u, last.y]);
  for (let i = 0; i + 1 < pts.length; i++) {
    if (Math.abs(pts[i][1]) < 1e-9 && Math.abs(pts[i + 1][1]) < 1e-9) continue;
    const lo0: P3 = [x + lx * pts[i][0], y + pts[i][1], z + lz * pts[i][0]];
    const lo1: P3 = [x + lx * pts[i + 1][0], y + pts[i + 1][1], z + lz * pts[i + 1][0]];
    const hi0: P3 = [x + lx * pts[i][0], y, z + lz * pts[i][0]];
    const hi1: P3 = [x + lx * pts[i + 1][0], y, z + lz * pts[i + 1][0]];
    orientedQuad(b, lo0, lo1, hi1, hi0, n);
  }
}

/**
 * Chisel cross-section: an outer skirt back down to the silk, a proud burr, a
 * steep wall each side and a flat floor between them. The floor is what the eye
 * reads at distance, the walls are what give the cut its edge up close, and the
 * skirt is what the deck's hole butts against.
 */
function veeSection(halfWidth: number, depth: number): ProfilePoint[] {
  const wall = Math.min(GRID_WALL, halfWidth * 0.42);
  return [
    { u: -halfWidth - GRID_SKIRT, y: 0, hard: true },
    { u: -halfWidth, y: GRID_LIP, hard: true },
    { u: -halfWidth + wall, y: -depth, hard: true },
    // The floor is split on the centreline so that every path point — and so
    // every one of the ninety intersections — still owns a vertex exactly on
    // the line. Losing that is how a widened section quietly stops landing on
    // `coords.ts`.
    { u: 0, y: -depth, hard: false },
    { u: halfWidth - wall, y: -depth, hard: true },
    { u: halfWidth, y: GRID_LIP, hard: true },
    { u: halfWidth + GRID_SKIRT, y: 0, hard: true },
  ];
}

/**
 * The rectangle a straight, axis-aligned incision opens in the silk: its full
 * length by the full width of its skirt.
 */
function lineHole(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  halfWidth: number,
): DeckHole {
  const alongX = az === bz;
  const mouth = halfWidth + GRID_SKIRT;
  return {
    x0: Math.min(ax, bx) - (alongX ? 0 : mouth),
    x1: Math.max(ax, bx) + (alongX ? 0 : mouth),
    z0: Math.min(az, bz) - (alongX ? mouth : 0),
    z1: Math.max(az, bz) + (alongX ? mouth : 0),
  };
}

/** The 9×10 grid, broken at the river on every file but the two outer ones. */
function buildGrid(b: MeshBuilder, rng: Rng, holes: DeckHole[]): void {
  const line = (ax: number, az: number, bx: number, bz: number, spans: number, half: number) => {
    incisedLine(b, ax, az, bx, bz, spans, veeSection(half, GRID_DEPTH * rng.range(0.9, 1.12)));
    holes.push(lineHole(ax, az, bx, bz, half));
  };

  for (let r = 0; r < RANKS; r++) {
    const z = worldZ(r);
    line(worldX(0), z, worldX(FILES - 1), z, FILES - 1, GRID_HALF_WIDTH * rng.range(0.92, 1.09));
  }

  for (let f = 0; f < FILES; f++) {
    const x = worldX(f);
    const half = GRID_HALF_WIDTH * rng.range(0.92, 1.09);
    if (f === 0 || f === FILES - 1) {
      // The two outer files run the full length: they are the board's border.
      line(x, worldZ(0), x, worldZ(RANKS - 1), RANKS - 1, half);
    } else {
      // Everything between stops at the river, which is what makes a xiangqi
      // board a xiangqi board.
      line(x, worldZ(0), x, worldZ(RIVER_BLACK_BANK), RIVER_BLACK_BANK, half);
      line(x, worldZ(RIVER_RED_BANK), x, worldZ(RANKS - 1), RANKS - 1 - RIVER_RED_BANK, half);
    }
  }
}

/** `[ax, az, bx, bz]` for each of the four palace diagonals. */
export function palaceDiagonals(): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const r0 of [0, RANKS - 3]) {
    out.push([worldX(3), worldZ(r0), worldX(5), worldZ(r0 + 2)]);
    out.push([worldX(5), worldZ(r0), worldX(3), worldZ(r0 + 2)]);
  }
  return out;
}

/**
 * Gold leaf pressed onto the palace diagonals.
 *
 * Leaf is applied as discrete squares, and the join between two squares always
 * shows — that join is the "tooth" of leaf, and it is the difference between
 * reading as beaten metal and reading as yellow paint. Each square gets its own
 * width, its own build of gold, its own facet normal and a hairline gap to its
 * neighbour, so the line breaks up under a raking key exactly the way real leaf
 * does. Each is a flat top with a chamfer all the way round it down to the silk
 * — see `LEAF_LIFT` for why the chamfer is the part that reads as metal. The
 * first and last squares run right onto the palace corners: the diagonal is a
 * line between two marked points and it has to arrive at them.
 */
function buildPalaceLeaf(b: MeshBuilder, rng: Rng): void {
  for (const [ax, az, bx, bz] of palaceDiagonals()) {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const ux = dx / len;
    const uz = dz / len;
    const px = uz;
    const pz = -ux;
    /** World point at (distance along, offset across, height). */
    const at = (t: number, s: number, y: number): P3 => {
      const x = ax + ux * t + px * s;
      const z = az + uz * t + pz * s;
      return [x, silkSag(x, z) + y, z];
    };
    let t = 0;
    while (t < len - 1e-4) {
      const patch = Math.min(LEAF_PITCH * rng.range(0.78, 1.24), len - t);
      const t0 = t <= 0 ? 0 : t + LEAF_GAP * 0.5;
      const t1 = t + patch >= len - 1e-9 ? len : t + patch - LEAF_GAP * 0.5;
      if (t1 > t0) {
        const w = LEAF_HALF_WIDTH * rng.range(0.94, 1.0);
        const lift = LEAF_LIFT * rng.range(0.85, 1.2);
        // Never let a short square's chamfers meet and invert it.
        const edge = Math.min(LEAF_EDGE, (t1 - t0) * 0.35, w * 0.6);
        // The square's own facet: leaf is beaten, and no two squares of it lie
        // at quite the same angle.
        const a = rng.range(0, Math.PI * 2);
        const tilt = LEAF_FACET * rng.range(0.25, 1);
        const up = norm3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));

        const ti0 = t0 + edge;
        const ti1 = t1 - edge;
        const wi = w - edge;
        // The flat top.
        b.quad(
          at(ti0, -wi, lift),
          at(ti1, -wi, lift),
          at(ti1, wi, lift),
          at(ti0, wi, lift),
          up,
          up,
          up,
          up,
          [0, 0],
          [ti1 - ti0, 0],
          [ti1 - ti0, 2 * wi],
          [0, 2 * wi],
        );
        // The chamfer, one side at a time. Its normal is the one number on this
        // board that can reach the top band of 泥金 — see `LEAF_LIFT`.
        const skirt = (
          o0: [number, number],
          o1: [number, number],
          i1: [number, number],
          i0: [number, number],
          nx: number,
          nz: number,
        ) => {
          const n = norm3(nx * lift, edge, nz * lift);
          orientedQuad(
            b,
            at(o0[0], o0[1], 0),
            at(o1[0], o1[1], 0),
            at(i1[0], i1[1], lift),
            at(i0[0], i0[1], lift),
            n,
          );
        };
        // Four trapezoids. Each slanted side runs from an outer corner to the
        // inner corner it shares with its neighbour, so the frame closes.
        skirt([t0, w], [t1, w], [ti1, wi], [ti0, wi], px, pz);
        skirt([t1, -w], [t0, -w], [ti0, -wi], [ti1, -wi], -px, -pz);
        skirt([t1, w], [t1, -w], [ti1, -wi], [ti1, wi], ux, uz);
        skirt([t0, -w], [t0, w], [ti0, wi], [ti0, -wi], -ux, -uz);
      }
      t += patch;
    }
  }
}

/** The classical 炮位 / 兵位 corner brackets, incised like everything else. */
function buildPositionMarkers(b: MeshBuilder, holes: DeckHole[]): void {
  const half = GRID_HALF_WIDTH * BRACKET_SCALE;
  const sec = veeSection(half, GRID_DEPTH * BRACKET_SCALE);
  const arm = (ax: number, az: number, bx: number, bz: number) => {
    incisedLine(b, ax, az, bx, bz, 1, sec);
    holes.push(lineHole(ax, az, bx, bz, half));
  };
  const bracket = (f: number, r: number, sx: number, sz: number) => {
    const x = worldX(f);
    const z = worldZ(r);
    const cx = x + sx * BRACKET_GAP;
    const cz = z + sz * BRACKET_GAP;
    // Two short arms meeting at the corner, held clear of the intersection.
    arm(cx, cz, cx + sx * BRACKET_LEN, cz);
    arm(cx, cz, cx, cz + sz * BRACKET_LEN);
  };
  const point = (f: number, r: number) => {
    // A point on the edge of the board only carries its inward brackets.
    const xs = f === 0 ? [1] : f === FILES - 1 ? [-1] : [-1, 1];
    for (const sx of xs) for (const sz of [-1, 1]) bracket(f, r, sx, sz);
  };
  for (const r of [2, RANKS - 3]) for (const f of CANNON_FILES) point(f, r);
  for (const r of [3, RANKS - 4]) for (const f of SOLDIER_FILES) point(f, r);
}

interface RiverBuild {
  banking: THREE.BufferGeometry;
  bed: THREE.BufferGeometry;
  water: THREE.BufferGeometry;
}

/**
 * The river channel.
 *
 * Swept along X from one silk edge to the other. The banking cap is broken into
 * discrete stone courses — each course carries its own thickness and there is a
 * dropped joint between neighbours — so the top of the bank is a line of cut
 * stones rather than an extruded ribbon. That is what you actually see from a
 * low camera, and it is the cheapest possible way to buy it.
 */
function buildRiver(rng: Rng, detail: number): RiverBuild {
  const bankB = new MeshBuilder();
  const bedB = new MeshBuilder();

  // Sample list along X, with a per-sample cap lift and joints between courses.
  const xs: number[] = [];
  const lifts: number[] = [];
  const sub = Math.max(1, Math.round(3 * detail));
  // The sample list must stay strictly increasing: a course short enough for its
  // joint to overrun its own start would fold the sweep back on itself and
  // invert a strip of the bank.
  const push = (px: number, lift: number) => {
    if (xs.length > 0 && px <= xs[xs.length - 1] + 1e-7) return;
    xs.push(px);
    lifts.push(lift);
  };
  /** Never cut a course shorter than a few joint widths. */
  const MIN_COURSE = STONE_JOINT * 4;
  let x = -SILK_HALF_X;
  let courseLift = rng.range(-STONE_LIFT, STONE_LIFT);
  xs.push(x);
  lifts.push(courseLift);
  while (x < SILK_HALF_X - 1e-6) {
    let stone = STONE_LENGTH * rng.range(0.72, 1.3);
    // Absorb the remainder rather than leaving a sliver against the frame.
    if (SILK_HALF_X - (x + stone) < MIN_COURSE) stone = SILK_HALF_X - x;
    const end = x + stone;
    const jStart = end - STONE_JOINT;
    for (let k = 1; k < sub; k++) push(x + ((jStart - x) * k) / sub, courseLift);
    push(jStart, courseLift);
    // The joint itself: a dropped sample, so the seam is a real notch that
    // catches shadow instead of a texture line.
    push((jStart + end) * 0.5, courseLift - STONE_JOINT_DROP);
    courseLift = rng.range(-STONE_LIFT, STONE_LIFT);
    push(end, courseLift);
    x = end;
  }

  const yAt = (i: number, s: number, zSign: number): P3 => {
    const p = RIVER_SECTION[s];
    const a = zSign * p.u;
    const y = p.y + lifts[i] * BANK_LIFT_WEIGHT[s] + silkSag(xs[i], a);
    return [xs[i], y, a];
  };

  for (let i = 0; i + 1 < xs.length; i++) {
    if (Math.abs(xs[i + 1] - xs[i]) < 1e-7) continue;
    for (let s = 0; s + 1 < RIVER_SECTION.length; s++) {
      const target = s === 0 ? bedB : bankB;
      for (const zSign of [1, -1]) {
        const A = yAt(i, s, zSign);
        const B = yAt(i, s + 1, zSign);
        const C = yAt(i + 1, s + 1, zSign);
        const D = yAt(i + 1, s, zSign);
        // Winding flips with the side of the channel so both faces point up and
        // out of the cut.
        if (zSign > 0) target.flatQuad(A, B, C, D);
        else target.flatQuad(A, D, C, B);
      }
    }
  }

  // End walls: the channel is cut into the tabletop and stops at the frame, so
  // the frame plane shows the cut's whole cross-section.
  //
  // The subtlety is that the banking cap stands *proud* of the silk. So the
  // profile is below the deck across the bed and the cut wall, and above it
  // across the cap — and the wall segment crosses the deck plane partway along.
  // Ribboning naively between the profile and the deck would fold that segment
  // into a bowtie, so the profile is resampled with a vertex inserted at every
  // crossing first, and each resulting strip then sits wholly on one side.
  {
    const capPts: [number, number][] = [];
    for (let s = 0; s + 1 < RIVER_SECTION.length; s++) {
      const p0 = RIVER_SECTION[s];
      const p1 = RIVER_SECTION[s + 1];
      capPts.push([p0.u, p0.y]);
      if (p0.y < 0 !== p1.y < 0 && p0.y !== 0 && p1.y !== 0) {
        const t = -p0.y / (p1.y - p0.y);
        capPts.push([p0.u + t * (p1.u - p0.u), 0]);
      }
    }
    const last = RIVER_SECTION[RIVER_SECTION.length - 1];
    capPts.push([last.u, last.y]);

    for (const endSign of [1, -1]) {
      const ex = endSign * SILK_HALF_X;
      const n: P3 = [-endSign, 0, 0];
      for (let i = 0; i + 1 < capPts.length; i++) {
        for (const zSign of [1, -1]) {
          const a0 = zSign * capPts[i][0];
          const a1 = zSign * capPts[i + 1][0];
          const sag0 = silkSag(ex, a0);
          const sag1 = silkSag(ex, a1);
          const lo0: P3 = [ex, capPts[i][1] + sag0, a0];
          const lo1: P3 = [ex, capPts[i + 1][1] + sag1, a1];
          const hi0: P3 = [ex, sag0, a0];
          const hi1: P3 = [ex, sag1, a1];
          if (Math.abs(capPts[i][1]) < 1e-9 && Math.abs(capPts[i + 1][1]) < 1e-9) continue;
          // Walk the profile, then back along the deck: a proper ribbon.
          orientedQuad(bankB, lo0, lo1, hi1, hi0, n);
        }
      }
    }
  }

  // The water plane. Low-poly is fine — the ripple is a shader, and the vertex
  // displacement it adds is a five-millimetre affair.
  const waterNX = Math.max(24, Math.round(120 * detail));
  const waterNZ = Math.max(4, Math.round(10 * detail));
  const waterB = new MeshBuilder();
  const up: P3 = [0, 1, 0];
  const wx0 = -SILK_HALF_X + 0.006;
  const wx1 = SILK_HALF_X - 0.006;
  for (let i = 0; i < waterNX; i++) {
    const xa = wx0 + ((wx1 - wx0) * i) / waterNX;
    const xb = wx0 + ((wx1 - wx0) * (i + 1)) / waterNX;
    for (let j = 0; j < waterNZ; j++) {
      const za = -WATER_HALF + ((2 * WATER_HALF) * j) / waterNZ;
      const zb = -WATER_HALF + ((2 * WATER_HALF) * (j + 1)) / waterNZ;
      const A: P3 = [xa, WATER_Y, za];
      const B: P3 = [xa, WATER_Y, zb];
      const C: P3 = [xb, WATER_Y, zb];
      const D: P3 = [xb, WATER_Y, za];
      waterB.quad(A, B, C, D, up, up, up, up, [xa, za], [xa, zb], [xb, zb], [xb, za]);
    }
  }

  return {
    banking: bankB.build('scene/river/banking'),
    bed: bedB.build('scene/river/bed'),
    water: waterB.build('scene/river/water'),
  };
}

/** The table's underside. Never the subject of a shot, but it closes the solid. */
function buildUnderside(b: MeshBuilder): void {
  const hx = SILK_HALF_X + FRAME_PROFILE[FRAME_PROFILE.length - 1].u;
  const hz = SILK_HALF_Z + FRAME_PROFILE[FRAME_PROFILE.length - 1].u;
  const y = TABLE_BOTTOM_Y;
  const dn: P3 = [0, -1, 0];
  const A: P3 = [-hx, y, -hz];
  const B: P3 = [hx, y, -hz];
  const C: P3 = [hx, y, hz];
  const D: P3 = [-hx, y, hz];
  b.quad(A, B, C, D, dn, dn, dn, dn, [-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]);
}

// ===========================================================================
// Board
// ===========================================================================

export interface BoardOptions {
  /** Ramp materials, injected. The scene never reaches into @render. */
  materials: GongbiMaterials;
  /**
   * Seal-script outlines, keyed by character. Feeds both the piece bases and
   * 楚河漢界. Absent means blank plinths and a bare river band.
   */
  seal?: SealSource;
  detail?: Detail;
  /** Orient each army's base glyphs toward its own seat. Default true. */
  ownerFacingGlyphs?: boolean;
}

export interface BoardLightSpec {
  dir: THREE.Vector3;
  keyColour: THREE.Color;
  fillColour: THREE.Color;
  keyIntensity: number;
  fillIntensity: number;
  gradeTint: THREE.Color;
  gradeAmount: number;
}

export class Board implements BoardScene {
  readonly group = new THREE.Group();
  readonly bases: PieceBases;
  readonly markers: Markers;
  /** Named parts, for debug overlays and the verification script. */
  readonly parts: Record<string, THREE.Mesh> = {};

  /** Where each character of 楚河漢界 ended up, for the verification script. */
  readonly inscription: {
    ch: string;
    cx: number;
    cz: number;
    em: number;
    panel: { x0: number; x1: number; z0: number; z1: number };
  }[] = [];
  /**
   * The mouth every incised line opened in the silk, for the verification
   * script: the deck is asserted to be exactly the sheet minus the river band
   * minus these minus the ink of 楚河漢界. Inscription panels are not in here —
   * they are in `inscription`, and the deck fills them back in with the panel's
   * own face.
   */
  readonly deckHoles: { x0: number; x1: number; z0: number; z1: number }[] = [];
  /** Triangles the inscription contributed to the incision geometry. */
  inscriptionTriangles = 0;

  private readonly water: RiverWater;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly boundSurfaceAt: (x: number, z: number) => number;
  private inscriptionCut = new MeshBuilder();

  constructor(opts: BoardOptions) {
    this.group.name = 'scene/board';
    const M = opts.materials;
    const detail = DETAIL_SCALE[opts.detail ?? 'high'];
    this.boundSurfaceAt = (x, z) => this.surfaceAt(x, z);

    const add = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      name: string,
      cast: boolean,
      receive: boolean,
    ): THREE.Mesh => {
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      this.group.add(mesh);
      this.parts[name] = mesh;
      return mesh;
    };

    // 楚河漢界 is planned first: the deck has to leave a hole for each character
    // so the incised panel can tile into it seamlessly.
    const inscription = planInscription(opts.seal);
    for (const c of inscription) {
      this.inscription.push({ ch: c.ch, cx: c.cx, cz: c.cz, em: c.em, panel: { ...c.panel } });
    }

    // --- every incised line, in one geometry and therefore one draw call ---
    // The grid, the 炮位/兵位 brackets and the sunken part of 楚河漢界 are all
    // the same thing — silk cut with a stylus — so they are the same geometry
    // and the same material. This runs BEFORE the deck because each line hands
    // back the hole it needs left in the silk.
    const lines = new MeshBuilder();
    buildGrid(lines, seedFor('scene', 'board', 'grid'), this.deckHoles);
    buildPositionMarkers(lines, this.deckHoles);

    // --- deck and frame ---------------------------------------------------
    // The deck geometry carries the inscription's *face* — the silk left behind
    // once the strokes are cut out of it — because it is the same silk and the
    // same material, and merging it costs no draw call.
    {
      const b = new MeshBuilder();
      buildDeck(b, detail, [...this.deckHoles, ...inscription.map((c) => c.panel)]);
      this.inscriptionCut = new MeshBuilder();
      for (const c of inscription) {
        const w = c.panel.x1 - c.panel.x0;
        const h = c.panel.z1 - c.panel.z0;
        inciseOutline(
          { face: b, cut: this.inscriptionCut },
          c.outline,
          // The panel exactly fills the hole the deck left, in glyph-local space.
          [-w / 2, -h / 2, w / 2, -h / 2, w / 2, h / 2, -w / 2, h / 2],
          {
            cx: c.cx,
            cz: c.cz,
            y: 0,
            depth: INSCRIPTION_DEPTH,
            fit: c.em,
            yaw: c.yaw,
            fitMode: 'em',
            // Follow the silk's sag, so the panel welds to the deck around it.
            heightAt: silkSag,
          },
        );
      }
      add(b.build('deck'), M.get({ cls: 'silk', pigment: SCENE.silkGround }), 'deck', false, true);
    }
    {
      const b = new MeshBuilder();
      mitredFrame(
        b,
        SILK_HALF_X,
        SILK_HALF_Z,
        FRAME_PROFILE,
        2.6 * detail,
        MITRE_GAP,
        silkSag,
        FRAME_SAG_FALLOFF,
      );
      buildUnderside(b);
      add(b.build('frame'), M.get({ cls: 'timber', pigment: SCENE.timber }), 'frame', true, true);
    }

    {
      this.inscriptionTriangles = this.inscriptionCut.triangles;
      lines.append(this.inscriptionCut);
      add(
        lines.build('incisions'),
        M.get({ cls: 'silk', pigment: SCENE.gridLine }),
        'incisions',
        false,
        // Deliberately NOT a shadow receiver. The line work is a 13-thousandth
        // deep cut, which is roughly one texel of a 2048 cascade covering ±10
        // world units, so the depth comparison inside the groove flickers from
        // texel to texel and the lattice renders as a dotted trace. Widening the
        // cut does not help — the artefact is the sampling rate, not the size.
        // The deck around the grooves still receives, so a piece's shadow still
        // crosses the lines; the lines themselves are simply shaded by N·L, and
        // lit 墨 (luma 36) is still well under shadowed 藤黃 (59), so the lattice
        // stays the darkest thing in the frame even where a shadow crosses it.
        false,
      );
    }
    {
      const b = new MeshBuilder();
      buildPalaceLeaf(b, seedFor('scene', 'board', 'leaf'));
      add(
        b.build('palaceLeaf'),
        M.get({ cls: 'gold', pigment: SCENE.palaceLeaf }),
        'palaceLeaf',
        false,
        true,
      );
    }

    // --- river ------------------------------------------------------------
    {
      const river = buildRiver(seedFor('scene', 'board', 'river'), detail);
      add(
        river.banking,
        M.get({ cls: 'stone', pigment: SCENE.banking }),
        'banking',
        true,
        true,
      );
      add(river.bed, M.get({ cls: 'stone', pigment: SCENE.riverBed }), 'riverBed', false, true);

      this.water = createRiverWater({
        floorHalf: RIVER_FLOOR_HALF,
        riverHalf: RIVER_CUT_HALF,
        bankRise: BANK_RISE,
        depth: RIVER_DEPTH,
        waterY: WATER_Y,
      });
      this.geometries.push(river.water);
      const waterMesh = new THREE.Mesh(river.water, this.water.material);
      waterMesh.name = 'water';
      waterMesh.receiveShadow = false;
      waterMesh.castShadow = false;
      this.group.add(waterMesh);
      this.parts.water = waterMesh;
    }

    // --- marks and bases --------------------------------------------------
    this.markers = new Markers({ materials: M, surfaceAt: this.boundSurfaceAt });
    this.group.add(this.markers.group);

    this.bases = new PieceBases({
      materials: M,
      seal: opts.seal,
      groundAt: this.boundSurfaceAt,
      ownerFacing: opts.ownerFacingGlyphs !== false,
    });
    this.group.add(this.bases.group);
  }

  // -- height field ----------------------------------------------------------

  /**
   * Height of the bare board at a world point: silk, incision-free, plus the
   * timber frame outside the silk and the river's water surface inside the
   * channel. This is the board **as built** — what a mark presses against and
   * what a dropped thing would come to rest on.
   *
   * It is NOT where a foot can be planted. Nothing can stand on a water film,
   * and `heightAt` is the query that knows it.
   */
  surfaceAt(x: number, z: number): number {
    const ax = Math.abs(x);
    const az = Math.abs(z);
    if (ax > TABLE_HALF_X || az > TABLE_HALF_Z) return OFF_BOARD_Y;

    const u = Math.max(ax - SILK_HALF_X, az - SILK_HALF_Z);
    if (u > 0) {
      if (u > FRAME_WIDTH) return OFF_BOARD_Y; // past the widest point, over the edge
      // Blend the silk's sag out through the rebate so the two surfaces agree.
      const w = 1 - Math.min(1, u / FRAME_SAG_FALLOFF);
      return sampleProfile(FRAME_DECK, u) + (w > 0 ? silkSag(x, z) * w : 0);
    }

    const solid = sampleProfile(RIVER_SECTION, az) + silkSag(x, z);
    // Inside the channel the walkable surface is the water film, not the bed —
    // a figure crossing the river wades, it does not sink to the stones.
    return az < BANK_HALF ? Math.max(solid, WATER_Y) : solid;
  }

  /**
   * What the animator plants feet against: the board with the river channel
   * spanned, plus any piece base standing at this point. A figure stepping onto
   * an occupied square genuinely steps up 46 mm, and the foot IK sees it.
   *
   * **The channel is not a floor.** `surfaceAt` reports the water film inside it
   * — correctly, that is the top surface there — and handing that to the foot
   * solver put a TROUGH in the walkable surface: 62 mm below the stone cap and
   * 0.33 wide. Not a cliff — the descent is the cut wall at 1.9:1, inside the
   * gradient any check here allows — which is why gradient never caught it. The
   * trap is the *scale*: 0.33 of trough against a 兵's 0.307 stride is too wide
   * to step over, and the 0.032 of cut wall leading down into it is far too
   * narrow to walk down, so one stride spans the entire descent. Every crossing
   * move landed one foot on the bank and one in the water, `solveHips` split the
   * difference, and the pelvis dropped 70 mm on a 兵 — 12% of its stature — and
   * 84 mm on a 俥, against the 21 mm of bob a level walk carries. Every piece
   * that crosses the river did this, on every crossing, which is most of a game.
   *
   * Two ways out, and the one not taken first: make the film standable and let
   * the figure genuinely wade. It cannot work here. The film is not the bottom
   * of anything — under it is 120 mm of channel with 66° walls — so a foot
   * planted on it is not wading, it is standing on the surface of the water, and
   * the water is a live ripple shader with no contact response to give it. To
   * wade honestly the foot would have to reach the bed, which is a 134 mm step
   * down: twice the drop we are trying to remove.
   *
   * So the channel is spanned: the banking cap is carried straight across it.
   * The 馬 and the 俥 genuinely do stride clear of it — 0.943 and 1.967 of stride
   * against 0.53 of channel — but a 兵's stride is 0.307 and it plants once or
   * twice inside, so this is not "everything steps over it". It is that a
   * planting surface has to be CONTINUOUS. A hole in it narrower than the figure
   * crossing it is not terrain, it is a crouch: the solver has to put a foot
   * somewhere, and 62 mm down is the one place that is guaranteed to be wrong.
   * What is left is the 14 mm rise onto the stone and 14 mm down the far side, a
   * kerb rather than a hole, and a crossing now costs the gait nothing it does
   * not pay on open board — measured 26 mm of pelvis against a 21 mm control on
   * a 兵, and 44 against 44 on a 馬.
   *
   * The price is paid by the 兵: for the one or two plants it makes over open
   * water it has up to 62 mm of daylight under the foot — 3.4 device px at the
   * resting framing. That is the trade, taken deliberately, and it is the better
   * side of it: a small static gap under a small foot against the whole
   * silhouette dropping an eighth of its height. The camera never comes close to
   * a figure standing in the river because no figure ever stands in the river —
   * there are no intersections in the band, only passage through it.
   */
  heightAt(x: number, z: number): number {
    let board = this.surfaceAt(x, z);
    // Inside the stone banking, the walkable height is the top of the banking.
    // Guarded by the silk's extent because past it this band is the timber
    // frame, which stands 72 mm higher than the cap and must keep its own top.
    if (Math.abs(z) < BANK_CAP_HALF && Math.abs(x) <= SILK_HALF_X) {
      board = BANK_RISE + silkSag(x, z);
    }
    const base = this.bases.topAt(x, z);
    return base > board ? base : board;
  }

  // -- BoardScene marker surface --------------------------------------------

  showLegalMarks(targets: number[]): void {
    this.markers.showLegal(targets);
  }
  clearLegalMarks(): void {
    this.markers.clearLegal();
  }
  setHover(square: number | null): void {
    this.markers.setHover(square);
  }
  setCheck(square: number | null): void {
    this.markers.setCheck(square);
  }
  setLastMove(from: number, to: number): void {
    this.markers.setLastMove(from, to);
  }

  // -- per frame -------------------------------------------------------------

  update(dt: number): void {
    this.water.update(dt);
    this.markers.update(dt);
  }

  /**
   * Put everything that free-runs on the board back to phase zero: the river's
   * flow and the marker pulses. Called by `__XQ.pause()` — see the note on
   * `RiverWater.resetPhase`.
   */
  resetAnimationPhase(): void {
    this.water.resetPhase();
    this.markers.resetPhase();
  }

  /** Push the current interpolated mood into the water shader. */
  setLight(spec: BoardLightSpec): void {
    this.water.setLight(spec);
  }

  setSilhouetteMode(on: boolean): void {
    this.water.setSilhouetteMode(on);
    this.markers.setSilhouetteMode(on);
  }

  stats(): { triangles: number; meshes: number } {
    let triangles = 0;
    let meshes = 0;
    this.group.traverse((o) => {
      const m = o as THREE.Mesh & { count?: number };
      if (!m.isMesh || !m.geometry) return;
      const pos = m.geometry.getAttribute('position');
      if (!pos) return;
      const instances = (o as THREE.InstancedMesh).isInstancedMesh ? (m.count ?? 1) : 1;
      triangles += (pos.count / 3) * instances;
      meshes++;
    });
    return { triangles, meshes };
  }

  dispose(): void {
    this.markers.dispose();
    this.bases.dispose();
    this.water.dispose();
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    this.group.clear();
  }
}

