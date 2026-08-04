/**
 * The board.
 *
 * This is a table, not a plane with a picture on it. It has a mitred timber
 * frame with a turned edge profile you can read from the waterline, a silk deck
 * inset into that frame with a couple of millimetres of sag in it, a river cut
 * *through* the deck to a stone-banked channel with water running in it, and
 * every line on it — the 9×10 grid, the palace diagonals, the 炮位 and 兵位
 * brackets, and 楚河漢界 itself — physically incised, with two walls that take
 * the key light differently.
 *
 * Vertical budget, all in world units where one unit is one board square:
 *
 * ```
 *   +0.086   top of the timber frame            FRAME_TOP_Y
 *   +0.014   stone banking cap, proud of the silk
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
export const RIVER_FLOOR_HALF = 0.088;
export const RIVER_CUT_HALF = 0.148;
export const BANK_CAP_HALF = 0.176;
export const BANK_HALF = 0.2;
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

/** Nominal half-width and depth of a grid incision. Varied per line. */
const GRID_HALF_WIDTH = 0.0162;
const GRID_DEPTH = 0.0118;
/** Pressed silk lifts at the edge of a stylus cut; this is that burr. */
const GRID_LIP = 0.0016;
/** Maximum lateral bow of a hand-ruled line, at mid-span. Zero at every
 *  intersection, so the grid still lands exactly on `coords.ts`. */
const GRID_BOW = 0.0055;
/** Vertices per one-square span. 3 puts a vertex exactly on each intersection. */
const SEG_PER_SPAN = 3;

/** Worst-case half-width and bow of a grid groove, for clearance arithmetic. */
export const GRID_HALF_MAX = GRID_HALF_WIDTH * 1.09;
export const GRID_BOW_MAX = GRID_BOW;

/** Palace diagonal: a flat-bottomed trench that the gold leaf is laid into. */
const PALACE_HALF_WIDTH = 0.024;
const PALACE_WALL = 0.007;
const PALACE_DEPTH = 0.0112;
/** Gold leaf is laid in squares; the joins between them are the tooth. */
const LEAF_PITCH = 0.155;
const LEAF_GAP = 0.0026;
const LEAF_RISE = 0.0011;

/** 炮位 / 兵位 brackets. */
const BRACKET_GAP = 0.088;
const BRACKET_LEN = 0.215;
const BRACKET_SCALE = 0.76;

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
const INSCRIPTION_Z1 = 0.472;
/** Ink height of the tallest of the four characters, world units. */
const INSCRIPTION_INK = 0.246;
/** Centre-to-centre spacing within a pair, and the width of one glyph's panel. */
const INSCRIPTION_PITCH = 0.5;
/**
 * Where each pair sits horizontally.
 *
 * A flat board writes 楚河 to the left and 漢界 to the right of one shared band.
 * With a channel down the middle of that band the pairs have to go on separate
 * banks, and keeping the left/right split as well puts them diagonally opposite
 * each other — which reads as an accident rather than as a decision from every
 * camera angle. Centring both pairs makes the inscription mirror-symmetric
 * across the channel, which is the only arrangement that looks deliberate no
 * matter where the camera is standing.
 */
const INSCRIPTION_PAIR_X = 0;
/** Depth of the cut. Deeper than a piece base's — it is read from further away. */
const INSCRIPTION_DEPTH = 0.0105;
/**
 * Heavier than the authored seal weight: a board inscription is cut bold.
 *
 * 2.0 is the most the forms will take. Past it the strokes of 楚 and 漢 begin to
 * flood into each other and the counters open and close unpredictably; at 2.0
 * they merge only where a bold cut genuinely would, and every counter survives.
 */
export const INSCRIPTION_WEIGHT = 2.0;

/** One character of the inscription, with the deck panel it is cut into. */
interface InscriptionChar {
  ch: string;
  outline: SealOutline;
  cx: number;
  cz: number;
  yaw: number;
  /** Em size in world units, shared by all four so they read as one line. */
  em: number;
  panel: DeckPanel;
}

/** A rectangle the silk deck leaves empty, filled by an incised panel instead. */
interface DeckPanel {
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
 * left empty under each character of 楚河漢界.
 */
function buildDeck(b: MeshBuilder, detail: number, panels: readonly DeckPanel[]): void {
  const step = 0.26 / Math.max(detail, 0.2);
  const bands: [number, number][] = [
    [BANK_HALF, SILK_HALF_Z],
    [-SILK_HALF_Z, -BANK_HALF],
  ];

  const zAnchors: number[] = [];
  const xAnchors: number[] = [];
  for (const p of panels) {
    zAnchors.push(p.z0, p.z1);
    xAnchors.push(p.x0, p.x1);
  }

  for (const [z0, z1] of bands) {
    const zEdges = gridEdges(z0, z1, step, zAnchors);
    for (let j = 0; j + 1 < zEdges.length; j++) {
      const za = zEdges[j];
      const zb = zEdges[j + 1];
      const zMid = (za + zb) * 0.5;
      // Only the row that actually contains panels pays for the extra x cuts.
      const rowPanels = panels.filter((p) => zMid > p.z0 && zMid < p.z1);
      const xEdges = gridEdges(
        -SILK_HALF_X,
        SILK_HALF_X,
        step,
        rowPanels.length ? xAnchors : [],
      );
      for (let i = 0; i + 1 < xEdges.length; i++) {
        const xa = xEdges[i];
        const xb = xEdges[i + 1];
        const xMid = (xa + xb) * 0.5;
        if (rowPanels.some((p) => xMid > p.x0 && xMid < p.x1)) continue; // the hole
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
 * One incised line, pinned to its endpoints.
 *
 * The bow is applied per one-square span as `A·sin(πs)`, which is exactly zero
 * at both ends of every span. The line therefore wanders like a hand-ruled line
 * between the marked points but passes precisely through each one — the grid
 * still lands on `coords.ts` to the last decimal, which is the property the
 * verification script asserts.
 */
function incisedLine(
  b: MeshBuilder,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  spans: number,
  section: readonly ProfilePoint[],
  rng: Rng,
  bow: number,
): void {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  const px = uz; // left of travel in XZ
  const pz = -ux;

  const path: number[] = [];
  for (let s = 0; s < spans; s++) {
    const amp = bow > 0 ? rng.range(-bow, bow) : 0;
    for (let k = 0; k < SEG_PER_SPAN; k++) {
      const local = k / SEG_PER_SPAN;
      const t = (s + local) / spans;
      const off = amp * Math.sin(Math.PI * local);
      const x = ax + dx * t + px * off;
      const z = az + dz * t + pz * off;
      path.push(x, silkSag(x, z), z);
    }
  }
  path.push(bx, silkSag(bx, bz), bz);
  // Every incised line on this board is a straight run between two marked
  // points, so the groove walls get one normal each along their whole length.
  sweepAlongPath(b, path, section, 1, true);
}

/** V-groove cross-section at a given half-width and depth. */
function veeSection(halfWidth: number, depth: number): ProfilePoint[] {
  return [
    { u: -halfWidth, y: GRID_LIP, hard: true },
    { u: 0, y: -depth, hard: true },
    { u: halfWidth, y: GRID_LIP, hard: true },
  ];
}

/** The 9×10 grid, broken at the river on every file but the two outer ones. */
function buildGrid(b: MeshBuilder, rng: Rng): void {
  for (let r = 0; r < RANKS; r++) {
    const z = worldZ(r);
    const sec = veeSection(
      GRID_HALF_WIDTH * rng.range(0.92, 1.09),
      GRID_DEPTH * rng.range(0.9, 1.12),
    );
    incisedLine(b, worldX(0), z, worldX(FILES - 1), z, FILES - 1, sec, rng, GRID_BOW);
  }

  for (let f = 0; f < FILES; f++) {
    const x = worldX(f);
    const sec = veeSection(
      GRID_HALF_WIDTH * rng.range(0.92, 1.09),
      GRID_DEPTH * rng.range(0.9, 1.12),
    );
    if (f === 0 || f === FILES - 1) {
      // The two outer files run the full length: they are the board's border.
      incisedLine(b, x, worldZ(0), x, worldZ(RANKS - 1), RANKS - 1, sec, rng, GRID_BOW);
    } else {
      // Everything between stops at the river, which is what makes a xiangqi
      // board a xiangqi board.
      incisedLine(b, x, worldZ(0), x, worldZ(RIVER_BLACK_BANK), RIVER_BLACK_BANK, sec, rng, GRID_BOW);
      incisedLine(
        b,
        x,
        worldZ(RIVER_RED_BANK),
        x,
        worldZ(RANKS - 1),
        RANKS - 1 - RIVER_RED_BANK,
        sec,
        rng,
        GRID_BOW,
      );
    }
  }
}

/** The palace trenches. The gold that fills them is built separately. */
function buildPalaceTrenches(b: MeshBuilder, rng: Rng): void {
  const sec: ProfilePoint[] = [
    { u: -PALACE_HALF_WIDTH, y: GRID_LIP, hard: true },
    { u: -PALACE_HALF_WIDTH + PALACE_WALL, y: -PALACE_DEPTH, hard: true },
    { u: PALACE_HALF_WIDTH - PALACE_WALL, y: -PALACE_DEPTH, hard: true },
    { u: PALACE_HALF_WIDTH, y: GRID_LIP, hard: true },
  ];
  for (const d of palaceDiagonals()) {
    incisedLine(b, d[0], d[1], d[2], d[3], 2, sec, rng, GRID_BOW * 0.5);
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
 * Gold leaf laid into the palace trenches.
 *
 * Leaf is applied as discrete squares, and the join between two squares always
 * shows — that join is the "tooth" of leaf, and it is the difference between
 * reading as beaten metal and reading as yellow paint. Each patch gets its own
 * width, its own height within the trench and a hairline gap to its neighbour,
 * so the line breaks up under a raking key exactly the way real leaf does.
 */
function buildPalaceLeaf(b: MeshBuilder, rng: Rng): void {
  const inner = PALACE_HALF_WIDTH - PALACE_WALL;
  const up: P3 = [0, 1, 0];
  for (const [ax, az, bx, bz] of palaceDiagonals()) {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const ux = dx / len;
    const uz = dz / len;
    const px = uz;
    const pz = -ux;
    let t = 0;
    while (t < len - 1e-4) {
      const patch = Math.min(LEAF_PITCH * rng.range(0.78, 1.24), len - t);
      const t0 = t + LEAF_GAP * 0.5;
      const t1 = t + patch - LEAF_GAP * 0.5;
      if (t1 > t0) {
        const w = inner * rng.range(0.84, 1.0);
        const y = -PALACE_DEPTH + LEAF_RISE * rng.range(0.35, 1.0);
        const x0 = ax + ux * t0;
        const z0 = az + uz * t0;
        const x1 = ax + ux * t1;
        const z1 = az + uz * t1;
        const A: P3 = [x0 - px * w, silkSag(x0, z0) + y, z0 - pz * w];
        const B: P3 = [x0 + px * w, silkSag(x0, z0) + y, z0 + pz * w];
        const C: P3 = [x1 + px * w, silkSag(x1, z1) + y, z1 + pz * w];
        const D: P3 = [x1 - px * w, silkSag(x1, z1) + y, z1 - pz * w];
        // A -> D -> C -> B: the leaf faces up out of the trench.
        b.quad(A, D, C, B, up, up, up, up, [A[0], A[2]], [D[0], D[2]], [C[0], C[2]], [B[0], B[2]]);
      }
      t += patch;
    }
  }
}

/** The classical 炮位 / 兵位 corner brackets, incised like everything else. */
function buildPositionMarkers(b: MeshBuilder, rng: Rng): void {
  const sec = veeSection(GRID_HALF_WIDTH * BRACKET_SCALE, GRID_DEPTH * BRACKET_SCALE);
  const bracket = (f: number, r: number, sx: number, sz: number) => {
    const x = worldX(f);
    const z = worldZ(r);
    const cx = x + sx * BRACKET_GAP;
    const cz = z + sz * BRACKET_GAP;
    // Two short arms meeting at the corner, held clear of the intersection.
    incisedLine(b, cx, cz, cx + sx * BRACKET_LEN, cz, 1, sec, rng, 0);
    incisedLine(b, cx, cz, cx, cz + sz * BRACKET_LEN, 1, sec, rng, 0);
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

    // --- deck and frame ---------------------------------------------------
    // The deck geometry carries the inscription's *face* — the silk left behind
    // once the strokes are cut out of it — because it is the same silk and the
    // same material, and merging it costs no draw call.
    {
      const b = new MeshBuilder();
      buildDeck(
        b,
        detail,
        inscription.map((c) => c.panel),
      );
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

    // --- every incised line, in one geometry and therefore one draw call ---
    // The grid, the palace trenches, the 炮位/兵位 brackets and the sunken part
    // of 楚河漢界 are all the same thing — silk cut with a stylus — so they are
    // the same geometry and the same material.
    {
      const b = new MeshBuilder();
      buildGrid(b, seedFor('scene', 'board', 'grid'));
      buildPalaceTrenches(b, seedFor('scene', 'board', 'palace'));
      buildPositionMarkers(b, seedFor('scene', 'board', 'brackets'));
      this.inscriptionTriangles = this.inscriptionCut.triangles;
      b.append(this.inscriptionCut);
      add(
        b.build('incisions'),
        M.get({ cls: 'silk', pigment: SCENE.gridLine }),
        'incisions',
        false,
        true,
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
   * channel. Marks press against this; feet plant against `heightAt`.
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
   * What the animator plants feet against: the board, plus any piece base
   * standing at this point. A figure stepping onto an occupied square genuinely
   * steps up 46 mm, and the foot IK sees it.
   */
  heightAt(x: number, z: number): number {
    const board = this.surfaceAt(x, z);
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

