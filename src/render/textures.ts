/**
 * Procedural textures: the tooth of every surface in the build.
 *
 * WHAT THESE ARE FOR
 * With one exception these are not colour maps. They are *tooth* — a
 * single-channel description of how the ground under the pigment varies, used
 * by gongbi.ts to perturb N·L by a hair before the ramp lookup. That makes the
 * band edge break along the grain of the material instead of running as a clean
 * vector curve, which is the difference between "laid pigment" and "filled
 * path". Amplitude is tiny (a few hundredths of N·L); the effect is entirely in
 * the shape of the boundary, not in the value of the field.
 *
 * The exception is `silkGround`, which IS a colour map — the aged silk of the
 * tabletop — and is therefore the only one tagged SRGBColorSpace.
 *
 * CHANNEL LAYOUT, uniform across every tooth texture:
 *   R — primary tooth, the fine grain
 *   G — secondary/coarse field, for anything that wants a broader modulation
 *   B — a flat per-cell id where the material has cells (crackle plates, leaf
 *       squares, pigment grains), 0 where it does not. Flat is the point: a
 *       crackle plate takes ONE value across its whole area, which is how
 *       crackle actually reads.
 *   A — 255
 *
 * WHY THE NOISE IS RE-IMPLEMENTED HERE (honest deviation, flagged not buried)
 * These textures are sampled with RepeatWrapping, so they must tile exactly.
 * `core/noise.ts` is not periodic: its lattice hash wraps at 256 cells, so a
 * field only tiles if the texture spans a multiple of 256 cells, which is far
 * finer than crackle plates or timber rings need. This file therefore carries
 * period-aware value / fbm / worley generators built on the same construction —
 * quintic interpolation, f1/f2/id worley with a flat per-cell id — differing
 * only in that the cell hash takes an explicit period. Where the lattice IS
 * fine enough for core's 256-cell wrap to tile (the sub-craze inside the
 * lacquer crackle, and the pigment granulation), `core/noise.ts` is used
 * directly, as the brief asks.
 *
 * CANVAS 2D
 * Every field is computed into an ImageData buffer by explicit pixel loops
 * rather than by canvas drawing calls. Same result, but it means the generators
 * are pure functions that the self-check can run under Node with no DOM. The
 * canvas is used purely as the transport into a CanvasTexture.
 *
 * SEEDING
 * Everything draws from seedFor(...) so a given build produces byte-identical
 * textures every run — which is what makes a captured frame a measurement.
 */

import * as THREE from 'three';
import { noise } from '@core/noise.ts';
import { seedFor } from '@core/rng.ts';
import {
  PIGMENTS,
  hexToRgb,
  mixHex,
  shiftHex,
  type MaterialClass,
} from '@core/palette.ts';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Texture edge lengths. These are tooth, not detail: the eye reads the shape of
 * a band boundary, not the field itself, so 512 is generous and 256 is enough
 * for the fields with no large-scale structure. Generation is ~50-100 ms each
 * on the target machine, which is why the pipeline prewarms them at boot behind
 * the veil rather than on first use.
 */
const SIZE = {
  silkGround: 512,
  timberGrain: 512,
  stoneGrit: 256,
  lacquerCrackle: 512,
  goldLeaf: 512,
  granulation: 256,
} as const;

/** Cells across the full texture for each cellular field. */
const CELLS = {
  /** Crackle plates. Aged lacquer breaks into plates a few millimetres across;
   *  at the scale these are sampled that is ~28 across a texture repeat. */
  crackle: 28,
  /** Sub-craze inside each plate, from core/noise.ts's cellular (256 wraps). */
  craze: 256,
  /** Gold leaf comes in squares that the gilder overlaps; the seams are the
   *  most recognisable thing about leaf, more than any surface texture. */
  leaf: 7,
  /** Grains of ground mineral pigment. Fine, and from core's cellular. */
  granule: 256,
  /** Grit in cut stone. */
  grit: 96,
} as const;

/** Timber: rings per repeat, and how hard the growth ring boundary is. */
const TIMBER_RINGS = 11;
const TIMBER_RING_SHARPNESS = 3.4;

/** Anisotropy requested on the tooth textures. Capped by the renderer. */
export const TOOTH_ANISOTROPY = 4;

// ---------------------------------------------------------------------------
// Period-aware lattice noise
// ---------------------------------------------------------------------------

/** FNV-1a over two wrapped cell coordinates plus a stream seed -> [0,1). */
function cellHash(cx: number, cy: number, period: number, seed: number): number {
  const x = ((cx % period) + period) % period;
  const y = ((cy % period) + period) % period;
  let h = (0x811c9dc5 ^ seed) >>> 0;
  h = Math.imul(h ^ (x & 0xffff), 0x01000193);
  h = Math.imul(h ^ (x >>> 16), 0x01000193);
  h = Math.imul(h ^ (y & 0xffff), 0x01000193);
  h = Math.imul(h ^ (y >>> 16), 0x01000193);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Quintic value noise on a lattice of `period` cells. Matches core/noise.ts's
 *  smootherstep so a CPU-baked field and a shader-evaluated one agree in
 *  character even though they do not agree in detail. */
function pValue(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const n00 = cellHash(xi, yi, period, seed);
  const n10 = cellHash(xi + 1, yi, period, seed);
  const n01 = cellHash(xi, yi + 1, period, seed);
  const n11 = cellHash(xi + 1, yi + 1, period, seed);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return a + (b - a) * v;
}

/** fbm over pValue. Each octave doubles both frequency and lattice period, so
 *  the aggregate tiles at the base period. Returns [0,1]. */
function pFbm(x: number, y: number, period: number, octaves: number, seed: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * (pValue(x * freq, y * freq, period * freq, seed + o * 7919) * 2 - 1);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return (sum / norm) * 0.5 + 0.5;
}

interface Cellular {
  f1: number;
  f2: number;
  id: number;
}
const _cell: Cellular = { f1: 0, f2: 0, id: 0 };

/** Worley with f1, f2 and a flat per-cell id, on a lattice of `period` cells. */
function pWorley(x: number, y: number, period: number, seed: number, jitter: number): Cellular {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 1e9;
  let f2 = 1e9;
  let id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const jx = cellHash(cx, cy, period, seed);
      const jy = cellHash(cx, cy, period, seed ^ 0x5bf03635);
      const px = cx + 0.5 + (jx - 0.5) * jitter;
      const py = cy + 0.5 + (jy - 0.5) * jitter;
      const ddx = px - x;
      const ddy = py - y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = cellHash(cx, cy, period, seed ^ 0x27d4eb2f);
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  _cell.f1 = f1;
  _cell.f2 = f2;
  _cell.id = id;
  return _cell;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// Field generators — pure, DOM-free, exported so the self-check can run them
// ---------------------------------------------------------------------------

export type TextureKind =
  | 'silkGround'
  | 'timberGrain'
  | 'stoneGrit'
  | 'lacquerCrackle'
  | 'goldLeaf'
  | 'granulation';

export const TEXTURE_KINDS: readonly TextureKind[] = [
  'silkGround',
  'timberGrain',
  'stoneGrit',
  'lacquerCrackle',
  'goldLeaf',
  'granulation',
];

/** Which tooth each material class wears. A class with no cellular structure
 *  of its own borrows the field whose *shape of break* matches it. */
export const CLASS_TOOTH: Record<MaterialClass, TextureKind> = {
  lacquer: 'lacquerCrackle',
  cloth: 'silkGround',
  leather: 'granulation',
  gold: 'goldLeaf',
  ivory: 'granulation',
  timber: 'timberGrain',
  stone: 'stoneGrit',
  silk: 'silkGround',
  flesh: 'granulation',
  hair: 'timberGrain',
  iron: 'stoneGrit',
};

function writePixel(d: Uint8ClampedArray, o: number, r: number, g: number, b: number): void {
  d[o] = clamp01(r) * 255;
  d[o + 1] = clamp01(g) * 255;
  d[o + 2] = clamp01(b) * 255;
  d[o + 3] = 255;
}

/**
 * Aged silk ground — the only colour field here.
 *
 * Woven 藤黃 silk that has been on a table for a century: the weave itself, the
 * slubs where a thread ran thick, and the uneven browning where light and hands
 * reached it. The browning is what makes it read as aged rather than dyed, so
 * it is the largest-amplitude term.
 */
export function fieldSilkGround(size: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  const rng = seedFor('render', 'texture', 'silkGround');
  const seed = Math.floor(rng.next() * 0xffffffff) >>> 0;

  const body = hexToRgb(PIGMENTS.gamboge.bands[2]);
  const deep = hexToRgb(mixHex(PIGMENTS.gamboge.bands[1], PIGMENTS.ochre.bands[1], 0.35));
  const lift = hexToRgb(shiftHex(PIGMENTS.gamboge.bands[3], 0.05, -0.25));

  // 64 threads across a repeat: fine enough to read as silk, coarse enough to
  // survive mipping down to the far end of the table.
  const threads = 64;
  const tk = (Math.PI * 2 * threads) / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Threads bow. A ruled weave reads as graph paper at any density.
      const wob =
        (pValue(x * 0.02, y * 0.02, Math.ceil(size * 0.02), seed ^ 0x11) - 0.5) * 1.6;
      const warp = 0.5 - 0.5 * Math.cos((x + wob) * tk);
      const weft = 0.5 - 0.5 * Math.cos((y - wob) * tk);
      const over = (Math.floor((x / size) * threads) + Math.floor((y / size) * threads)) % 2;
      const tooth = over === 0 ? warp * 0.72 + weft * 0.28 : weft * 0.72 + warp * 0.28;

      // Slubs: rare thick threads, stretched hard along their own direction.
      const slub = pFbm(x * (threads / size) * 0.9, y * (threads / size) * 0.06, threads, 2, seed ^ 0x22);

      // Age: broad uneven browning, plus a rarer foxing speckle.
      const age = pFbm(x / size * 3.5, y / size * 3.5, 4, 4, seed ^ 0x33);
      const foxing = smooth(0.86, 1.0, pFbm(x / size * 26, y / size * 26, 26, 3, seed ^ 0x44));

      const t = clamp01(tooth * 0.72 + slub * 0.28);
      // Weave crowns catch light, valleys hold the wash.
      let r = deep.r + (lift.r - deep.r) * t;
      let g = deep.g + (lift.g - deep.g) * t;
      let b = deep.b + (lift.b - deep.b) * t;
      // Pull toward the body colour by the age field, then brown the foxing.
      const k = 0.45 + age * 0.5;
      r = r + (body.r - r) * k;
      g = g + (body.g - g) * k;
      b = b + (body.b - b) * k;
      r += foxing * 0.10;
      g += foxing * 0.05;
      b -= foxing * 0.03;

      writePixel(data, (y * size + x) * 4, r, g, b);
    }
  }
  return data;
}

/**
 * Timber grain — 赭石 table frame, spear hafts, chariot bodies.
 *
 * Growth rings are concentric around a pith that is off the plank, so the rings
 * arrive as near-parallel arcs with a slow curve. `TIMBER_RING_SHARPNESS`
 * raises the ring profile to a power: real latewood is a thin dark line against
 * a wide pale earlywood, not a sine.
 */
export function fieldTimberGrain(size: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  const rng = seedFor('render', 'texture', 'timberGrain');
  const seed = Math.floor(rng.next() * 0xffffffff) >>> 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      // Grain runs along +Y. Warping the ring coordinate by a stretched fbm is
      // what produces the wander and the occasional knot-adjacent swirl.
      const warp = (pFbm(u * 3.0, v * 0.5, 3, 4, seed) - 0.5) * 0.42;
      const rings = (u + warp) * TIMBER_RINGS;
      const ringPhase = rings - Math.floor(rings);
      // Sharpened ring: dark thin latewood at the boundary.
      const ring = Math.pow(1 - Math.abs(ringPhase * 2 - 1), TIMBER_RING_SHARPNESS);

      // Fibre: very high frequency along the grain, almost none across it.
      const fibre = pFbm(u * 140, v * 6, 140, 2, seed ^ 0x9e);

      // Vessels / pores: short dark dashes lying along the grain.
      const pore = smooth(0.78, 0.95, pFbm(u * 70, v * 9, 70, 2, seed ^ 0x5a));

      const primary = clamp01(1 - ring * 0.72 - pore * 0.35 + (fibre - 0.5) * 0.22);
      const coarse = clamp01(0.5 + warp * 1.2);
      writePixel(data, (y * size + x) * 4, primary, coarse, ringPhase);
    }
  }
  return data;
}

/** Cut stone: worley grit with a speckle of harder inclusions. */
export function fieldStoneGrit(size: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  const rng = seedFor('render', 'texture', 'stoneGrit');
  const seed = Math.floor(rng.next() * 0xffffffff) >>> 0;
  const n = CELLS.grit;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * n;
      const v = (y / size) * n;
      const c = pWorley(u, v, n, seed, 1.0);
      // f2 - f1 peaks at the boundary between grains: the interstitial line.
      const edge = clamp01((c.f2 - c.f1) * 1.6);
      const grain = 1 - edge; // bright at the boundary, flat inside a grain
      const inclusion = smooth(0.84, 1.0, pFbm((x / size) * 40, (y / size) * 40, 40, 3, seed ^ 0x77));
      const chisel = pFbm((x / size) * 9, (y / size) * 9, 9, 3, seed ^ 0xa1);

      const primary = clamp01(0.42 + grain * 0.4 + inclusion * 0.25 + (chisel - 0.5) * 0.18);
      writePixel(data, (y * size + x) * 4, primary, chisel, c.id);
    }
  }
  return data;
}

/**
 * Lacquer crackle — 玄漆 and 朱砂 both craze as they age.
 *
 * Two scales. The plate network is a period-aware worley so it tiles; the fine
 * craze inside each plate comes from `core/noise.ts`'s cellular sampled at 256
 * cells across the repeat, which is exactly where its own lattice wraps, so it
 * tiles too and the brief's "use core/noise.ts cellular" is honoured literally.
 *
 * The plate id in B is flat across each plate on purpose: the shader uses it to
 * give each plate a hair of its own value, and crackle only reads as crackle if
 * the plates are flat and the cracks are thin.
 */
export function fieldLacquerCrackle(size: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  const rng = seedFor('render', 'texture', 'lacquerCrackle');
  const seed = Math.floor(rng.next() * 0xffffffff) >>> 0;
  const n = CELLS.crackle;
  const m = CELLS.craze;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * n;
      const v = (y / size) * n;
      // Warping the domain before the worley makes the cracks wander instead of
      // meeting at clean Voronoi vertices. Straight Voronoi reads as a diagram.
      const wx = (pFbm((x / size) * 6, (y / size) * 6, 6, 3, seed ^ 0xb1) - 0.5) * 0.9;
      const wy = (pFbm((x / size) * 6 + 5.5, (y / size) * 6 + 5.5, 6, 3, seed ^ 0xb2) - 0.5) * 0.9;
      const c = pWorley(u + wx, v + wy, n, seed, 0.85);

      // Crack = the thin ridge where f2 - f1 goes to zero.
      const crack = 1 - smooth(0.0, 0.09, c.f2 - c.f1);

      // Sub-craze from core/noise.ts, tiling because 256 is its wrap.
      const fine = noise.cellular((x / size) * m, (y / size) * m, 0.9);
      const craze = 1 - smooth(0.0, 0.16, fine.f2 - fine.f1);

      // Plates are flat; the cracks cut them. Fine craze at a third weight so
      // it reads as a sheen of age rather than as a second crack network.
      const primary = clamp01(1 - crack * 0.85 - craze * 0.3);
      writePixel(data, (y * size + x) * 4, primary, 1 - craze, c.id);
    }
  }
  return data;
}

/**
 * Gold leaf tooth — 泥金.
 *
 * Leaf is laid in overlapping squares. The seams between sheets, and the very
 * slight difference in value from sheet to sheet, are what identify leaf; the
 * surface texture is secondary. Pinholes where the leaf failed to take show the
 * bole underneath and are the detail that stops it reading as a gold shader.
 */
export function fieldGoldLeaf(size: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  const rng = seedFor('render', 'texture', 'goldLeaf');
  const seed = Math.floor(rng.next() * 0xffffffff) >>> 0;
  const n = CELLS.leaf;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * n;
      const v = (y / size) * n;
      // Sheets are square-ish and slightly rotated relative to each other, so a
      // small jitter on an axis-aligned grid is closer than a worley.
      const sx = Math.floor(u);
      const sy = Math.floor(v);
      const jx = (cellHash(sx, sy, n, seed) - 0.5) * 0.16;
      const jy = (cellHash(sx, sy, n, seed ^ 0x1234) - 0.5) * 0.16;
      const fu = u - sx - 0.5 + jx;
      const fv = v - sy - 0.5 + jy;
      // Distance to the nearest sheet edge, in cell units.
      const edge = 0.5 - Math.max(Math.abs(fu), Math.abs(fv));
      const seam = 1 - smooth(0.0, 0.03, edge);
      const sheetValue = cellHash(sx, sy, n, seed ^ 0xabcd);

      // Hammered tooth: the burnisher's marks, fine and directional.
      const burnish = pFbm((x / size) * 190, (y / size) * 150, 190, 2, seed ^ 0xc3);
      // Pinholes: rare, small, hard-edged.
      const pin = smooth(0.93, 0.985, pFbm((x / size) * 55, (y / size) * 55, 55, 3, seed ^ 0xd4));

      const primary = clamp01(
        0.62 + (burnish - 0.5) * 0.3 + (sheetValue - 0.5) * 0.14 - seam * 0.3 - pin * 0.55,
      );
      writePixel(data, (y * size + x) * 4, primary, burnish, sheetValue);
    }
  }
  return data;
}

/**
 * Pigment granulation — the default tooth.
 *
 * Ground mineral settles into visible grains, and where the grains sit thick
 * the colour is denser. This is the field that does the most work in the build,
 * because it is what breaks every band edge on cloth, flesh, ivory and leather.
 * Straight from core/noise.ts's cellular at its own 256-cell wrap, plus a
 * broader settling field for where the wash pooled.
 */
export function fieldGranulation(size: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  const rng = seedFor('render', 'texture', 'granulation');
  const seed = Math.floor(rng.next() * 0xffffffff) >>> 0;
  const m = CELLS.granule;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const g = noise.cellular((x / size) * m, (y / size) * m, 1.0);
      // Each grain takes one flat value — that is what granulation is.
      const grainValue = (g.id & 0xff) / 255;
      const packed = clamp01(1 - g.f1 * 1.1);
      // Where the wash pooled and dried: broad, low contrast.
      const pool = pFbm((x / size) * 7, (y / size) * 7, 7, 4, seed ^ 0xe5);

      const primary = clamp01(0.34 + packed * 0.32 + grainValue * 0.16 + (pool - 0.5) * 0.36);
      writePixel(data, (y * size + x) * 4, primary, pool, grainValue);
    }
  }
  return data;
}

const GENERATORS: Record<TextureKind, (size: number) => Uint8ClampedArray> = {
  silkGround: fieldSilkGround,
  timberGrain: fieldTimberGrain,
  stoneGrit: fieldStoneGrit,
  lacquerCrackle: fieldLacquerCrackle,
  goldLeaf: fieldGoldLeaf,
  granulation: fieldGranulation,
};

export function textureSize(kind: TextureKind): number {
  return SIZE[kind];
}

/** Generate a kind's raw pixels. DOM-free; this is what the self-check runs. */
export function generateField(kind: TextureKind, size = SIZE[kind]): Uint8ClampedArray {
  return GENERATORS[kind](size);
}

// ---------------------------------------------------------------------------
// Canvas transport
// ---------------------------------------------------------------------------

/**
 * Cache of built textures. Keyed on kind alone — every field is fully
 * determined by its seed and its size, so two requests for the same kind are
 * the same texture and must share one GPU upload.
 */
export class TextureLibrary {
  private cache = new Map<TextureKind, THREE.Texture>();
  private anisotropy = TOOTH_ANISOTROPY;

  /** Clamp the requested anisotropy to what the renderer actually supports. */
  setMaxAnisotropy(max: number): void {
    this.anisotropy = Math.max(1, Math.min(TOOTH_ANISOTROPY, Math.floor(max)));
    for (const t of this.cache.values()) t.anisotropy = this.anisotropy;
  }

  get(kind: TextureKind): THREE.Texture {
    let t = this.cache.get(kind);
    if (t) return t;

    const size = SIZE[kind];
    const data = generateField(kind, size);

    if (typeof document === 'undefined') {
      // Headless (tests, tooling). Fall back to a DataTexture, which is
      // functionally identical for our purposes — the canvas is only ever a
      // transport — so nothing downstream needs to know which path it took.
      const dt = new THREE.DataTexture(
        new Uint8Array(data.buffer.slice(0)),
        size,
        size,
        THREE.RGBAFormat,
        THREE.UnsignedByteType,
      );
      this.configure(dt, kind);
      dt.needsUpdate = true;
      this.cache.set(kind, dt);
      return dt;
    }

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    img.data.set(data);
    ctx.putImageData(img, 0, 0);

    t = new THREE.CanvasTexture(canvas);
    this.configure(t, kind);
    this.cache.set(kind, t);
    return t;
  }

  private configure(t: THREE.Texture, kind: TextureKind): void {
    t.name = `gongbi.tex.${kind}`;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    // Mipping is not optional for the tooth: it is sampled in object space and
    // a figure at the far rank minifies it hard. Unmipped it would shimmer, and
    // because the tooth perturbs a band edge the shimmer would show up as the
    // band edge itself crawling — far more visible than texture noise.
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = this.anisotropy;
    // silkGround is the only colour field; the rest are data and must not be
    // put through an sRGB decode.
    t.colorSpace = kind === 'silkGround' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
  }

  /** Build everything now, so the first move never pays for a texture. */
  prewarm(): void {
    for (const k of TEXTURE_KINDS) this.get(k);
  }

  dispose(): void {
    for (const t of this.cache.values()) t.dispose();
    this.cache.clear();
  }
}
