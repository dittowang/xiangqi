/**
 * The seal-script type engine: turns the hand-authored centrelines in
 * `ui/glyphs.ts` into outlines, THREE.Shapes and canvas ink.
 *
 * There is no font anywhere in this build, so this module is the entire text
 * stack. It has four jobs:
 *
 *   1. Resolve a character into flattened, weathered centrelines.
 *   2. `strokeToOutline` — expand one centreline into a closed outline with
 *      round joins and caps, for canvas fills.
 *   3. `glyphToShapes` — union all of a glyph's strokes into THREE.Shapes with
 *      holes, for the characters incised into the board and pressed into the
 *      piece bases.
 *   4. `drawGlyph` / `drawText` / `measureGlyph` — the 2D side, for the HUD's
 *      canvas textures.
 *
 * ── Two coordinate spaces, and only two ─────────────────────────────────────
 *
 * **Em space** is what everything measures in: x right, y **DOWN**, origin at
 * the em box's top-left, box normalised to 1 × 1. `measureGlyph` and
 * `drawGlyph` both speak em space, because that is what a canvas speaks.
 *
 * **Shape space** is what `glyphToShapes` emits: x right, y **UP**, because
 * that is what `THREE.ExtrudeGeometry` expects. With the default
 * `origin: 'center'` the em box is centred on (0, 0) and spans ±size/2.
 *
 * Nothing else in the project needs to know about the 0..100 authoring units;
 * they stop at this module's front door.
 *
 * ── Fill rule ───────────────────────────────────────────────────────────────
 *
 * Canvas output is a single path of overlapping stroke outlines filled
 * **non-zero**. That is deliberate: the union of the strokes is then exact, a
 * crossing never double-darkens under partial alpha, and counters (the inside
 * of 口, 目, 田) fall out for free because no stroke covers them. Never fill a
 * glyph path with `evenodd` — the round-join geometry is self-overlapping by
 * construction and evenodd would punch holes through every corner.
 */

import { Shape, Path } from 'three';
import type * as THREE from 'three';
import { band, type PigmentName } from '@core/palette.ts';
import { noise } from '@core/noise.ts';
import { seedFor } from '@core/rng.ts';
import { clamp } from '@core/types.ts';
import { GLYPHS, PARTS, SEAL_EM, SEAL_WIDTH, type GlyphTier, type RawGlyph } from '@ui/glyphs.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** `missing` is only ever produced by the tofu fallback — it is never authored. */
export type SealTier = GlyphTier | 'missing';

export interface SealStroke {
  /** Flattened centreline, `[x0, y0, x1, y1, …]`, em space (y down), 0..1. */
  readonly pts: Float32Array;
  /** Centreline width in em units (so 0.052 is the default seal weight). */
  readonly width: number;
  readonly cap: 'round' | 'flat';
}

export interface SealRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface SealGlyph {
  /** The character this glyph draws. For tofu, the character that was missing. */
  readonly char: string;
  /** Advance width in em units. 1 for every CJK glyph in the roster. */
  readonly advance: number;
  readonly tier: SealTier;
  /** Author's note on what is approximate about this form, if anything. */
  readonly note?: string;
  readonly strokes: readonly SealStroke[];
  /** Ink bounds including stroke half-width, em space (y down). */
  readonly ink: SealRect;
  /** Flattened segment count — a cheap density measure for the coverage sheet. */
  readonly segments: number;
}

export interface GlyphMetrics {
  /** Horizontal advance, in the same units as `size`. */
  advance: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  height: number;
}

/**
 * The slice of `CanvasRenderingContext2D` the glyph renderer touches. Declared
 * structurally so the coverage tool can hand in its own software rasteriser and
 * exercise exactly the code the HUD runs.
 */
export interface Glyph2DContext {
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  /** Called with no argument, i.e. always non-zero winding. See the header. */
  fill(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  rotate(angle: number): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
}

// ---------------------------------------------------------------------------
// Authoring constants
// ---------------------------------------------------------------------------

/**
 * Seeded weathering. A glyph built from perfect polylines reads as vector art;
 * a carved seal wanders. These numbers are small on purpose — the wobble should
 * be felt at piece size and invisible at HUD size.
 */
const WEATHER_AMPLITUDE = 0.62; // em units (0..100 space) of centreline drift
const WEATHER_WIDTH_JITTER = 0.045; // ±4.5% per-stroke weight variation

/** Curve flattening: one segment per this many em units of chord. */
const FLATTEN_STEP = 2.6;
const FLATTEN_MIN = 2;
const FLATTEN_MAX = 26;

/** Arc resolution for round joins and caps, radians per segment. */
const ARC_STEP = 0.32;

// ---------------------------------------------------------------------------
// Stroke-string parsing
// ---------------------------------------------------------------------------

interface ParsedStroke {
  /** Un-normalised centreline in 0..100 authoring units, y down. */
  pts: number[];
  width: number;
  cap: 'round' | 'flat';
}

function flattenQuad(out: number[], x0: number, y0: number, cx: number, cy: number, x1: number, y1: number): void {
  // Control-polygon length is a good enough proxy for arc length at this scale.
  const approx = Math.hypot(cx - x0, cy - y0) + Math.hypot(x1 - cx, y1 - cy);
  const n = clamp(Math.ceil(approx / FLATTEN_STEP), FLATTEN_MIN, FLATTEN_MAX);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1);
  }
}

function flattenCubic(
  out: number[],
  x0: number, y0: number,
  ax: number, ay: number,
  bx: number, by: number,
  x1: number, y1: number,
): void {
  const approx = Math.hypot(ax - x0, ay - y0) + Math.hypot(bx - ax, by - ay) + Math.hypot(x1 - bx, y1 - by);
  const n = clamp(Math.ceil(approx / FLATTEN_STEP), FLATTEN_MIN, FLATTEN_MAX);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const u2 = u * u;
    const t2 = t * t;
    out.push(
      u2 * u * x0 + 3 * u2 * t * ax + 3 * u * t2 * bx + t2 * t * x1,
      u2 * u * y0 + 3 * u2 * t * ay + 3 * u * t2 * by + t2 * t * y1,
    );
  }
}

function parseStroke(spec: string): ParsedStroke {
  const tok = spec.trim().split(/\s+/);
  const pts: number[] = [];
  let width = SEAL_WIDTH;
  let cap: 'round' | 'flat' = 'round';
  let i = 0;

  // Leading modifiers are allowed before the start point.
  while (i < tok.length && (tok[i] === 'F' || tok[i][0] === 'W')) {
    if (tok[i] === 'F') cap = 'flat';
    else width = SEAL_WIDTH * Number(tok[i].slice(1));
    i++;
  }

  const num = (): number => {
    const v = Number(tok[i++]);
    if (!Number.isFinite(v)) throw new Error(`seal: bad number "${tok[i - 1]}" in stroke "${spec}"`);
    return v;
  };

  pts.push(num(), num());

  while (i < tok.length) {
    const t = tok[i++];
    if (t === 'L') {
      pts.push(num(), num());
    } else if (t === 'Q') {
      const cx = num();
      const cy = num();
      flattenQuad(pts, pts[pts.length - 2], pts[pts.length - 1], cx, cy, num(), num());
    } else if (t === 'C') {
      const ax = num();
      const ay = num();
      const bx = num();
      const by = num();
      flattenCubic(pts, pts[pts.length - 2], pts[pts.length - 1], ax, ay, bx, by, num(), num());
    } else if (t === 'F') {
      cap = 'flat';
    } else if (t[0] === 'W') {
      width = SEAL_WIDTH * Number(t.slice(1));
    } else {
      throw new Error(`seal: unknown token "${t}" in stroke "${spec}"`);
    }
  }

  if (pts.length < 4) throw new Error(`seal: stroke needs at least two points: "${spec}"`);
  return { pts, width, cap };
}

/** `"<ref> x0 y0 x1 y1 [widthScale]"` — a component placed into a sub-box. */
function parsePart(spec: string): { ref: string; x0: number; y0: number; x1: number; y1: number; w: number } {
  const t = spec.trim().split(/\s+/);
  if (t.length < 5) throw new Error(`seal: bad part spec "${spec}"`);
  return {
    ref: t[0],
    x0: Number(t[1]),
    y0: Number(t[2]),
    x1: Number(t[3]),
    y1: Number(t[4]),
    w: t.length > 5 ? Number(t[5]) : 1,
  };
}

// ---------------------------------------------------------------------------
// Glyph assembly
// ---------------------------------------------------------------------------

function lookupRaw(ref: string): RawGlyph | undefined {
  return GLYPHS[ref] ?? PARTS[ref];
}

/**
 * Collect a raw entry's strokes in 0..100 authoring space, recursing through
 * component placements. A component's whole 0..100 box maps into the target
 * box; stroke width does not scale with it, because seal script keeps one
 * weight across a character no matter how tightly a radical is squeezed.
 */
function collect(ref: string, out: ParsedStroke[], depth: number, widthScale: number): void {
  if (depth > 6) throw new Error(`seal: component recursion too deep at "${ref}"`);
  const raw = lookupRaw(ref);
  if (!raw) throw new Error(`seal: unknown component "${ref}"`);

  if (raw.p) {
    for (const spec of raw.p) {
      const p = parsePart(spec);
      const nested: ParsedStroke[] = [];
      collect(p.ref, nested, depth + 1, widthScale * p.w);
      const sx = (p.x1 - p.x0) / SEAL_EM;
      const sy = (p.y1 - p.y0) / SEAL_EM;
      for (const s of nested) {
        const pts = new Array<number>(s.pts.length);
        for (let i = 0; i < s.pts.length; i += 2) {
          pts[i] = p.x0 + s.pts[i] * sx;
          pts[i + 1] = p.y0 + s.pts[i + 1] * sy;
        }
        out.push({ pts, width: s.width, cap: s.cap });
      }
    }
  }

  if (raw.s) {
    for (const spec of raw.s) {
      const s = parseStroke(spec);
      s.width *= widthScale;
      out.push(s);
    }
  }
}

/**
 * Push the centreline off true by a smooth, seeded, low-frequency drift so the
 * result reads as cut rather than plotted. The drift is sampled around a circle
 * in the noise field, which makes it exactly periodic in normalised arc length
 * — a closed stroke (the ring of 目, the box of 口) therefore lands back on its
 * own start point instead of opening a seam.
 */
function weather(pts: number[], char: string, index: number): void {
  const rng = seedFor('seal', char, index);
  const px = rng.range(-500, 500);
  const py = rng.range(-500, 500);

  // Accumulated chord length, used as the noise parameter.
  const n = pts.length / 2;
  let total = 0;
  const arc = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    total += Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
    arc[i] = total;
  }
  if (total < 1e-6) return;

  // Radius controls how many wobble cycles fit along the stroke: a long stroke
  // wanders more than a short tick, which is how a chisel behaves.
  const r = clamp(total * 0.02, 0.35, 2.2);
  const amp = WEATHER_AMPLITUDE;

  for (let i = 0; i < n; i++) {
    const a = (arc[i] / total) * Math.PI * 2;
    const cx = Math.cos(a) * r;
    const cy = Math.sin(a) * r;
    pts[i * 2] += noise.simplex2(px + cx, py + cy) * amp;
    pts[i * 2 + 1] += noise.simplex2(px + 91.7 + cx, py - 43.1 + cy) * amp;
  }
}

function buildGlyph(char: string, raw: RawGlyph): SealGlyph {
  const parsed: ParsedStroke[] = [];
  collect(char, parsed, 0, raw.w ?? 1);

  const inv = 1 / SEAL_EM;
  const strokes: SealStroke[] = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let segments = 0;

  for (let si = 0; si < parsed.length; si++) {
    const p = parsed[si];
    weather(p.pts, char, si);

    // Per-stroke weight variation, seeded so it is identical every run.
    const jitter = 1 + seedFor('seal-w', char, si).gauss() * WEATHER_WIDTH_JITTER;
    const width = p.width * jitter * inv;
    const half = width * 0.5;

    const pts = new Float32Array(p.pts.length);
    for (let i = 0; i < p.pts.length; i += 2) {
      const x = p.pts[i] * inv;
      const y = p.pts[i + 1] * inv;
      pts[i] = x;
      pts[i + 1] = y;
      if (x - half < x0) x0 = x - half;
      if (y - half < y0) y0 = y - half;
      if (x + half > x1) x1 = x + half;
      if (y + half > y1) y1 = y + half;
    }
    segments += pts.length / 2 - 1;
    strokes.push({ pts, width, cap: p.cap });
  }

  if (!strokes.length) throw new Error(`seal: glyph "${char}" has no strokes`);

  return {
    char,
    advance: (raw.adv ?? SEAL_EM) * inv,
    tier: raw.tier,
    note: raw.note,
    strokes,
    ink: { x0, y0, x1, y1 },
    segments,
  };
}

// ---------------------------------------------------------------------------
// Tofu — a missing glyph is always visible, never blank
// ---------------------------------------------------------------------------

/**
 * The fallback box. A character we never authored must announce itself: a
 * hollow box with a diagonal cross, drawn at three-quarter weight so it does
 * not shout louder than real text but cannot be mistaken for a glyph.
 */
function buildTofu(char: string): SealGlyph {
  const w = SEAL_WIDTH * 0.7 / SEAL_EM;
  const mk = (nums: number[]): SealStroke => {
    const pts = new Float32Array(nums.length);
    for (let i = 0; i < nums.length; i++) pts[i] = nums[i] / SEAL_EM;
    return { pts, width: w, cap: 'flat' };
  };
  const strokes = [
    mk([18, 10, 82, 10, 82, 90, 18, 90, 18, 10]),
    mk([18, 10, 82, 90]),
    mk([82, 10, 18, 90]),
  ];
  return {
    char,
    advance: 1,
    tier: 'missing',
    note: 'not authored',
    strokes,
    ink: { x0: 0.18 - w / 2, y0: 0.1 - w / 2, x1: 0.82 + w / 2, y1: 0.9 + w / 2 },
    segments: 6,
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const glyphCache = new Map<string, SealGlyph>();
const missingSeen = new Set<string>();

/** True when the roster actually contains an authored form for `ch`. */
export function hasSealGlyph(ch: string): boolean {
  return Object.prototype.hasOwnProperty.call(GLYPHS, ch);
}

/**
 * The one lookup every consumer uses. Never returns null: an unauthored
 * character comes back as a `tier: 'missing'` tofu box that draws and extrudes
 * like any other glyph, so a gap in the roster shows up on screen instead of
 * silently swallowing text.
 */
export function getSealGlyph(ch: string): SealGlyph {
  let g = glyphCache.get(ch);
  if (g) return g;

  const raw = GLYPHS[ch];
  if (raw) {
    g = buildGlyph(ch, raw);
  } else {
    missingSeen.add(ch);
    g = buildTofu(ch);
  }
  glyphCache.set(ch, g);
  return g;
}

/** Every authored character, in authoring order. */
export function sealRoster(): readonly string[] {
  return Object.keys(GLYPHS);
}

/** Characters that were asked for and are not authored. Drives the dev overlay. */
export function missingRequests(): readonly string[] {
  return [...missingSeen];
}

/** Roster split by fidelity, for reporting. */
export function sealCoverage(): { high: string[]; legible: string[]; missing: string[] } {
  const high: string[] = [];
  const legible: string[] = [];
  for (const ch of Object.keys(GLYPHS)) (GLYPHS[ch].tier === 'high' ? high : legible).push(ch);
  return { high, legible, missing: [...missingSeen] };
}

function resolve(g: SealGlyph | string): SealGlyph {
  return typeof g === 'string' ? getSealGlyph(g) : g;
}

// ---------------------------------------------------------------------------
// Outline expansion
// ---------------------------------------------------------------------------

export interface OutlineOptions {
  /** Multiply the authored stroke weight. 1 is the authored seal weight. */
  widthScale?: number;
}

/** Append an arc of `radius` about (cx, cy) from angle a0 to a1, short way round. */
function arcTo(out: number[], cx: number, cy: number, radius: number, a0: number, a1: number): void {
  let d = a1 - a0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const steps = Math.max(1, Math.ceil(Math.abs(d) / ARC_STEP));
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (d * i) / steps;
    out.push(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
  }
}

/** Drop consecutive duplicates so zero-length segments never produce NaN normals. */
function dedupe(pts: Float32Array): number[] {
  const out: number[] = [pts[0], pts[1]];
  for (let i = 2; i < pts.length; i += 2) {
    if (Math.abs(pts[i] - out[out.length - 2]) > 1e-9 || Math.abs(pts[i + 1] - out[out.length - 1]) > 1e-9) {
      out.push(pts[i], pts[i + 1]);
    }
  }
  return out;
}

/**
 * Expand one centreline into a single closed outline ring, em space.
 *
 * The ring runs down one side of the polyline, round the far cap, back up the
 * other side and round the near cap. Round joins insert a short arc at every
 * interior vertex on both sides; on the inside of a turn that arc doubles back
 * on itself, which is harmless — and only harmless — under a non-zero fill.
 *
 * Returns a flat `[x0, y0, x1, y1, …]` ring, not explicitly closed (the last
 * point is distinct from the first; the consumer closes it).
 */
export function strokeToOutline(stroke: SealStroke, opts?: OutlineOptions): Float32Array {
  const half = (stroke.width * (opts?.widthScale ?? 1)) * 0.5;
  const p = dedupe(stroke.pts);
  const n = p.length / 2;

  if (n < 2) {
    // Degenerate: a dot. Emit a full circle.
    const out: number[] = [];
    arcTo(out, p[0], p[1], half, 0, Math.PI);
    arcTo(out, p[0], p[1], half, Math.PI, Math.PI * 2);
    return new Float32Array(out);
  }

  // Per-segment unit normal (left of travel in a y-down frame).
  const nx = new Float64Array(n - 1);
  const ny = new Float64Array(n - 1);
  const ang = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dx = p[i * 2 + 2] - p[i * 2];
    const dy = p[i * 2 + 3] - p[i * 2 + 1];
    const len = Math.hypot(dx, dy) || 1;
    nx[i] = -dy / len;
    ny[i] = dx / len;
    ang[i] = Math.atan2(ny[i], nx[i]);
  }

  const out: number[] = [];

  // Down the left side.
  out.push(p[0] + nx[0] * half, p[1] + ny[0] * half);
  for (let i = 1; i < n - 1; i++) {
    out.push(p[i * 2] + nx[i - 1] * half, p[i * 2 + 1] + ny[i - 1] * half);
    arcTo(out, p[i * 2], p[i * 2 + 1], half, ang[i - 1], ang[i]);
  }
  const last = n - 2;
  out.push(p[(n - 1) * 2] + nx[last] * half, p[(n - 1) * 2 + 1] + ny[last] * half);

  // Far cap. The left normal sits a quarter turn *behind* the direction of
  // travel (n = perp(d) with n rotated -90° giving +d), so the cap has to sweep
  // negatively to bulge forward. Sweeping the other way folds the cap back over
  // the stroke and leaves a barb at every terminal.
  if (stroke.cap === 'round') {
    arcTo(out, p[(n - 1) * 2], p[(n - 1) * 2 + 1], half, ang[last], ang[last] - Math.PI);
  } else {
    out.push(p[(n - 1) * 2] - nx[last] * half, p[(n - 1) * 2 + 1] - ny[last] * half);
  }

  // Back up the right side.
  for (let i = n - 2; i >= 1; i--) {
    out.push(p[i * 2] - nx[i] * half, p[i * 2 + 1] - ny[i] * half);
    arcTo(out, p[i * 2], p[i * 2 + 1], half, ang[i] + Math.PI, ang[i - 1] + Math.PI);
  }
  out.push(p[0] - nx[0] * half, p[1] - ny[0] * half);

  // Near cap — the mirror of the far one: sweep negatively from the right side
  // back to the left, bulging behind the start point.
  if (stroke.cap === 'round') {
    arcTo(out, p[0], p[1], half, ang[0] + Math.PI, ang[0]);
  }

  return new Float32Array(out);
}

/** Cache of expanded outlines, keyed by character and weight, so the HUD's
 *  repeated redraws never re-expand the same glyph. */
const outlineCache = new Map<string, Float32Array[]>();

function glyphOutlines(g: SealGlyph, widthScale: number): Float32Array[] {
  const key = `${g.char}|${g.tier}|${widthScale.toFixed(3)}`;
  let rings = outlineCache.get(key);
  if (rings) return rings;
  rings = g.strokes.map((s) => strokeToOutline(s, { widthScale }));
  outlineCache.set(key, rings);
  return rings;
}

// ---------------------------------------------------------------------------
// Union: the stroke field, contoured
// ---------------------------------------------------------------------------

export interface ContourOptions {
  /** Em size in output units. Default 1. */
  size?: number;
  /** Where the em box sits. `center` puts (0,0) at the box's middle. */
  origin?: 'center' | 'topLeft';
  /** Multiply the authored stroke weight. */
  widthScale?: number;
  /** Sampling grid across the longer side of the ink box. Default 224. */
  resolution?: number;
  /** Contour decimation tolerance, in grid cells. 0 disables. Default 0.35. */
  simplify?: number;
}

export interface GlyphContour {
  /** Outer boundary, counter-clockwise, closed implicitly. */
  outer: Float32Array;
  /** Counters, clockwise. */
  holes: Float32Array[];
}

const BIG = 1e6;

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dd = dx * dx + dy * dy;
  let t = dd > 1e-18 ? ((px - ax) * dx + (py - ay) * dy) / dd : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** Ramer–Douglas–Peucker on a closed ring, iterative to avoid deep recursion. */
function simplifyRing(pts: Float32Array, tol: number): Float32Array {
  const n = pts.length / 2;
  if (n < 8 || tol <= 0) return pts;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  // Split the ring at its two most distant-ish anchors so RDP has open chains.
  keep[n >> 1] = 1;
  const stack: number[] = [0, n >> 1, n >> 1, n];
  while (stack.length) {
    const end = stack.pop()!;
    const start = stack.pop()!;
    if (end - start < 2) continue;
    const ex = end === n ? pts[0] : pts[end * 2];
    const ey = end === n ? pts[1] : pts[end * 2 + 1];
    let worst = -1;
    let worstIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = distToSegment(pts[i * 2], pts[i * 2 + 1], pts[start * 2], pts[start * 2 + 1], ex, ey);
      if (d > worst) {
        worst = d;
        worstIdx = i;
      }
    }
    if (worst > tol && worstIdx > 0) {
      keep[worstIdx] = 1;
      stack.push(start, worstIdx, worstIdx, end);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out.length >= 6 ? new Float32Array(out) : pts;
}

function ringArea(p: Float32Array): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += (p[j * 2] - p[i * 2]) * (p[j * 2 + 1] + p[i * 2 + 1]);
  }
  return a * 0.5;
}

function pointInRing(px: number, py: number, p: Float32Array): boolean {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = p[i * 2 + 1];
    const yj = p[j * 2 + 1];
    if (yi > py !== yj > py) {
      const x = p[i * 2] + ((py - yi) / (yj - yi)) * (p[j * 2] - p[i * 2]);
      if (px < x) inside = !inside;
    }
  }
  return inside;
}

function reverseRing(p: Float32Array): Float32Array {
  const n = p.length / 2;
  const out = new Float32Array(p.length);
  for (let i = 0; i < n; i++) {
    out[i * 2] = p[(n - 1 - i) * 2];
    out[i * 2 + 1] = p[(n - 1 - i) * 2 + 1];
  }
  return out;
}

/**
 * Contour a glyph's stroke field.
 *
 * Every stroke is a Minkowski sum of its centreline with a disc, so the union
 * of the whole glyph is exactly the zero level set of
 *   `f(p) = min over strokes of (distance(p, centreline) − halfWidth)`.
 * That is a signed distance field, and marching squares over it gives one
 * closed contour per connected region with counters falling out as separate
 * rings — which is what `ExtrudeGeometry` wants and what the per-stroke outlines
 * cannot give, because overlapping extrusions leave coplanar faces that z-fight
 * along every crossing of an incised character.
 *
 * The grid is only visited inside each segment's expanded bounding box, so cost
 * scales with the ink, not with the em box.
 */
export function glyphToContours(glyph: SealGlyph | string, opts?: ContourOptions): GlyphContour[] {
  const g = resolve(glyph);
  const size = opts?.size ?? 1;
  const widthScale = opts?.widthScale ?? 1;
  const res = Math.max(48, Math.floor(opts?.resolution ?? 224));
  const simplifyTol = opts?.simplify ?? 0.35;

  // --- grid -----------------------------------------------------------------
  const pad = 0.02 * widthScale;
  const bx0 = g.ink.x0 - pad;
  const by0 = g.ink.y0 - pad;
  const bw = g.ink.x1 - g.ink.x0 + pad * 2;
  const bh = g.ink.y1 - g.ink.y0 + pad * 2;
  const cell = Math.max(bw, bh) / res;
  const W = Math.ceil(bw / cell) + 3;
  const H = Math.ceil(bh / cell) + 3;
  const ox = bx0 - cell * 1.5;
  const oy = by0 - cell * 1.5;

  const field = new Float32Array(W * H).fill(BIG);

  for (const s of g.strokes) {
    const half = s.width * widthScale * 0.5;
    const p = s.pts;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k];
      const ay = p[k + 1];
      const bxp = p[k + 2];
      const byp = p[k + 3];
      const lo = half + cell;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bxp) - lo - ox) / cell));
      const i1 = Math.min(W - 1, Math.ceil((Math.max(ax, bxp) + lo - ox) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(ay, byp) - lo - oy) / cell));
      const j1 = Math.min(H - 1, Math.ceil((Math.max(ay, byp) + lo - oy) / cell));
      for (let j = j0; j <= j1; j++) {
        const gy = oy + j * cell;
        const row = j * W;
        for (let i = i0; i <= i1; i++) {
          const d = distToSegment(ox + i * cell, gy, ax, ay, bxp, byp) - half;
          if (d < field[row + i]) field[row + i] = d;
        }
      }
    }
  }

  // --- edge crossings -------------------------------------------------------
  const px: number[] = [];
  const py: number[] = [];
  const he = new Int32Array((W - 1) * H).fill(-1); // between (i,j) and (i+1,j)
  const ve = new Int32Array(W * (H - 1)).fill(-1); // between (i,j) and (i,j+1)

  const cross = (fa: number, fb: number): number => fa / (fa - fb);

  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = field[j * W + i];
      const b = field[j * W + i + 1];
      if (a < 0 !== b < 0) {
        he[j * (W - 1) + i] = px.length;
        px.push(ox + (i + cross(a, b)) * cell);
        py.push(oy + j * cell);
      }
    }
  }
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W; i++) {
      const a = field[j * W + i];
      const b = field[(j + 1) * W + i];
      if (a < 0 !== b < 0) {
        ve[j * W + i] = px.length;
        px.push(ox + i * cell);
        py.push(oy + (j + cross(a, b)) * cell);
      }
    }
  }

  if (!px.length) return [];

  // --- link crossings into loops -------------------------------------------
  const link0 = new Int32Array(px.length).fill(-1);
  const link1 = new Int32Array(px.length).fill(-1);
  const join = (a: number, b: number): void => {
    if (a < 0 || b < 0) return;
    if (link0[a] < 0) link0[a] = b;
    else if (link1[a] < 0) link1[a] = b;
    if (link0[b] < 0) link0[b] = a;
    else if (link1[b] < 0) link1[b] = a;
  };

  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const fa = field[j * W + i];
      const fb = field[j * W + i + 1];
      const fc = field[(j + 1) * W + i + 1];
      const fd = field[(j + 1) * W + i];
      const code = (fa < 0 ? 1 : 0) | (fb < 0 ? 2 : 0) | (fc < 0 ? 4 : 0) | (fd < 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const e0 = he[j * (W - 1) + i]; // bottom, a–b
      const e1 = ve[j * W + i + 1]; // right,  b–c
      const e2 = he[(j + 1) * (W - 1) + i]; // top,    d–c
      const e3 = ve[j * W + i]; // left,   a–d
      switch (code) {
        case 1: case 14: join(e0, e3); break;
        case 2: case 13: join(e0, e1); break;
        case 3: case 12: join(e1, e3); break;
        case 4: case 11: join(e1, e2); break;
        case 6: case 9: join(e0, e2); break;
        case 7: case 8: join(e2, e3); break;
        // Saddles: the diagonal pair is only connected if the cell centre is.
        case 5:
          if ((fa + fb + fc + fd) * 0.25 < 0) {
            join(e0, e1);
            join(e2, e3);
          } else {
            join(e0, e3);
            join(e1, e2);
          }
          break;
        case 10:
          if ((fa + fb + fc + fd) * 0.25 < 0) {
            join(e0, e3);
            join(e1, e2);
          } else {
            join(e0, e1);
            join(e2, e3);
          }
          break;
        default: break;
      }
    }
  }

  // --- walk the loops -------------------------------------------------------
  const seen = new Uint8Array(px.length);
  const rings: Float32Array[] = [];
  for (let start = 0; start < px.length; start++) {
    if (seen[start] || link0[start] < 0) continue;
    const ring: number[] = [];
    let prev = -1;
    let cur = start;
    while (cur >= 0 && !seen[cur]) {
      seen[cur] = 1;
      ring.push(px[cur], py[cur]);
      const a = link0[cur];
      const b = link1[cur];
      const next = a !== prev && a >= 0 && !seen[a] ? a : b !== prev && b >= 0 && !seen[b] ? b : -1;
      prev = cur;
      cur = next;
    }
    if (ring.length >= 8) rings.push(simplifyRing(new Float32Array(ring), simplifyTol * cell));
  }

  // --- em space -> output space --------------------------------------------
  // Em space is y-down with the box at [0,1]; output is y-up, optionally centred.
  const sx = size;
  const sy = -size;
  const tx = opts?.origin === 'topLeft' ? 0 : -size * 0.5;
  const ty = opts?.origin === 'topLeft' ? 0 : size * 0.5;
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      r[i] = r[i] * sx + tx;
      r[i + 1] = r[i + 1] * sy + ty;
    }
  }

  // --- outer / hole classification -----------------------------------------
  // Nesting depth by point-in-ring counting: even depth is solid, odd is a
  // counter. A glyph never nests deeper than one level, but counting is as
  // cheap as assuming and it will not break if one ever does.
  const depth = new Int32Array(rings.length);
  for (let i = 0; i < rings.length; i++) {
    for (let k = 0; k < rings.length; k++) {
      if (k !== i && pointInRing(rings[i][0], rings[i][1], rings[k])) depth[i]++;
    }
  }

  const contours: GlyphContour[] = [];
  const outerIndex: number[] = [];
  for (let i = 0; i < rings.length; i++) {
    if (depth[i] % 2 === 0) {
      const r = ringArea(rings[i]) < 0 ? reverseRing(rings[i]) : rings[i];
      outerIndex.push(i);
      contours.push({ outer: r, holes: [] });
    }
  }
  for (let i = 0; i < rings.length; i++) {
    if (depth[i] % 2 === 1) {
      const r = ringArea(rings[i]) > 0 ? reverseRing(rings[i]) : rings[i];
      // Attach to the smallest enclosing outer ring.
      let best = -1;
      let bestArea = Infinity;
      for (let c = 0; c < contours.length; c++) {
        if (pointInRing(r[0], r[1], contours[c].outer)) {
          const a = Math.abs(ringArea(contours[c].outer));
          if (a < bestArea) {
            bestArea = a;
            best = c;
          }
        }
      }
      if (best >= 0) contours[best].holes.push(r);
    }
  }
  void outerIndex;

  return contours;
}

// ---------------------------------------------------------------------------
// THREE.Shape output
// ---------------------------------------------------------------------------

export interface ShapeOptions extends ContourOptions {
  /**
   * `union` (default) merges the strokes into one boundary per region — the
   * only correct input for `ExtrudeGeometry`. `perStroke` returns one Shape per
   * centreline, which is cheaper and fine for a flat unlit inlay where the
   * overlap never shows.
   */
  mode?: 'union' | 'perStroke';
}

function ringToShape(ring: Float32Array): Shape {
  const s = new Shape();
  s.moveTo(ring[0], ring[1]);
  for (let i = 2; i < ring.length; i += 2) s.lineTo(ring[i], ring[i + 1]);
  s.closePath();
  return s;
}

/**
 * Glyph -> `THREE.Shape[]`, ready for `ExtrudeGeometry` or `ShapeGeometry`.
 *
 * Output is in the XY plane, **y up**, and with the default
 * `origin: 'center'` the em box is centred on the origin and spans
 * `[-size/2, +size/2]` on both axes. Extrude along +Z and push the mesh into
 * the board to get an incised character; extrude a shallow depth and lift it to
 * get a pressed one.
 */
export function glyphToShapes(glyph: SealGlyph | string, opts?: ShapeOptions): THREE.Shape[] {
  const g = resolve(glyph);

  if (opts?.mode === 'perStroke') {
    const size = opts.size ?? 1;
    const tx = opts.origin === 'topLeft' ? 0 : -size * 0.5;
    const ty = opts.origin === 'topLeft' ? 0 : size * 0.5;
    return glyphOutlines(g, opts.widthScale ?? 1).map((ring) => {
      const s = new Shape();
      s.moveTo(ring[0] * size + tx, -ring[1] * size + ty);
      for (let i = 2; i < ring.length; i += 2) s.lineTo(ring[i] * size + tx, -ring[i + 1] * size + ty);
      s.closePath();
      return s;
    });
  }

  return glyphToContours(g, opts).map((c) => {
    const shape = ringToShape(c.outer);
    for (const h of c.holes) {
      const hole = new Path();
      hole.moveTo(h[0], h[1]);
      for (let i = 2; i < h.length; i += 2) hole.lineTo(h[i], h[i + 1]);
      hole.closePath();
      shape.holes.push(hole);
    }
    return shape;
  });
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Advance width and ink bounds, in em space (y down, origin at the em box's
 * top-left) scaled by `size`. `size` defaults to 1, i.e. em-normalised.
 */
export function measureGlyph(glyph: SealGlyph | string, size = 1): GlyphMetrics {
  const g = resolve(glyph);
  return {
    advance: g.advance * size,
    x0: g.ink.x0 * size,
    y0: g.ink.y0 * size,
    x1: g.ink.x1 * size,
    y1: g.ink.y1 * size,
    width: (g.ink.x1 - g.ink.x0) * size,
    height: (g.ink.y1 - g.ink.y0) * size,
  };
}

export interface TextOptions {
  /** Extra space between glyphs, in em units. Negative tightens. */
  tracking?: number;
  /** Lay the run top-to-bottom, the way a 棋譜 column runs. */
  vertical?: boolean;
}

export interface TextMetrics {
  /** Total advance along the run direction, in `size` units. */
  advance: number;
  width: number;
  height: number;
  /** Per-glyph offsets along the run, in `size` units. */
  offsets: number[];
}

export function measureText(text: string, size = 1, opts?: TextOptions): TextMetrics {
  const chars = [...text];
  const tracking = (opts?.tracking ?? 0) * size;
  const vertical = opts?.vertical ?? false;
  const offsets: number[] = [];
  let run = 0;
  let cross = 0;
  for (const ch of chars) {
    offsets.push(run);
    const m = measureGlyph(ch, size);
    const step = vertical ? size : m.advance;
    cross = Math.max(cross, vertical ? m.advance : size);
    run += step + tracking;
  }
  if (chars.length) run -= tracking;
  return {
    advance: run,
    width: vertical ? cross : run,
    height: vertical ? run : cross,
    offsets,
  };
}

// ---------------------------------------------------------------------------
// Canvas rendering
// ---------------------------------------------------------------------------

export interface DrawOptions {
  /** Pigment to ink with. Everything resolves through `core/palette.ts`. */
  pigment?: PigmentName;
  /** Which band of that pigment. 0 is the deepest. */
  band?: 0 | 1 | 2 | 3;
  /** Pre-resolved colour, when the caller already picked one from the palette. */
  colour?: string;
  alpha?: number;
  /** Multiply the authored stroke weight. */
  widthScale?: number;
  /**
   * Ink bleed: a wider, fainter pass laid down first, the way pigment creeps
   * into silk. 0 turns it off; the default is enough to kill the vector look
   * without softening the form.
   */
  bleed?: number;
  align?: 'left' | 'center' | 'right';
  baseline?: 'top' | 'middle' | 'bottom';
  /** Rotation about the placement point, radians. */
  rotate?: number;
}

const DEFAULT_BLEED = 0.16;

function inkColour(opts?: DrawOptions): string {
  if (opts?.colour) return opts.colour;
  return band(opts?.pigment ?? 'ink', opts?.band ?? 0);
}

function tracePath(ctx: Glyph2DContext, rings: Float32Array[], size: number, dx: number, dy: number): void {
  ctx.beginPath();
  for (const r of rings) {
    ctx.moveTo(dx + r[0] * size, dy + r[1] * size);
    for (let i = 2; i < r.length; i += 2) ctx.lineTo(dx + r[i] * size, dy + r[i + 1] * size);
    ctx.closePath();
  }
}

/**
 * Paint one glyph. `(x, y)` places the em box according to `align`/`baseline`
 * (default: top-left corner). `size` is the em box side in pixels. Returns the
 * advance width in pixels so a caller can lay a run out by hand.
 *
 * All the stroke outlines go into one path and are filled once, non-zero. See
 * this file's header for why that matters.
 */
export function drawGlyph(
  ctx: Glyph2DContext,
  glyph: SealGlyph | string,
  x: number,
  y: number,
  size: number,
  opts?: DrawOptions,
): number {
  const g = resolve(glyph);
  const widthScale = opts?.widthScale ?? 1;
  const advance = g.advance * size;

  let dx = x;
  let dy = y;
  if (opts?.align === 'center') dx -= advance * 0.5;
  else if (opts?.align === 'right') dx -= advance;
  if (opts?.baseline === 'middle') dy -= size * 0.5;
  else if (opts?.baseline === 'bottom') dy -= size;

  const colour = inkColour(opts);
  const alpha = opts?.alpha ?? 1;
  const bleed = opts?.bleed ?? DEFAULT_BLEED;

  ctx.save();
  if (opts?.rotate) {
    ctx.translate(x, y);
    ctx.rotate(opts.rotate);
    ctx.translate(-x, -y);
  }
  ctx.fillStyle = colour;

  if (bleed > 0) {
    // The bleed pass is deliberately drawn first and wider: laid under the
    // body, it reads as pigment wicking into the ground rather than as a glow.
    ctx.globalAlpha = alpha * 0.3;
    tracePath(ctx, glyphOutlines(g, widthScale * (1 + bleed)), size, dx, dy);
    ctx.fill();
  }

  ctx.globalAlpha = alpha;
  tracePath(ctx, glyphOutlines(g, widthScale), size, dx, dy);
  ctx.fill();
  ctx.restore();

  return advance;
}

/**
 * Paint a run. Horizontal by default; `vertical: true` runs top-to-bottom for
 * the move record. Returns the total advance in pixels.
 */
export function drawText(
  ctx: Glyph2DContext,
  text: string,
  x: number,
  y: number,
  size: number,
  opts?: DrawOptions & TextOptions,
): number {
  const chars = [...text];
  const vertical = opts?.vertical ?? false;
  const m = measureText(text, size, opts);

  let ox = x;
  let oy = y;
  if (!vertical) {
    if (opts?.align === 'center') ox -= m.advance * 0.5;
    else if (opts?.align === 'right') ox -= m.advance;
  } else {
    if (opts?.align === 'center') ox -= size * 0.5;
    else if (opts?.align === 'right') ox -= size;
    if (opts?.baseline === 'middle') oy -= m.advance * 0.5;
    else if (opts?.baseline === 'bottom') oy -= m.advance;
  }

  // Per-glyph placement is already resolved by `measureText`, so suppress the
  // per-glyph alignment pass and drive it from the run offsets instead.
  const perGlyph: DrawOptions = { ...opts, align: 'left', baseline: vertical ? 'top' : opts?.baseline };

  for (let i = 0; i < chars.length; i++) {
    if (vertical) drawGlyph(ctx, chars[i], ox, oy + m.offsets[i], size, perGlyph);
    else drawGlyph(ctx, chars[i], ox + m.offsets[i], oy, size, perGlyph);
  }
  return m.advance;
}
