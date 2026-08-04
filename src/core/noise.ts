/**
 * Noise fields, on the CPU for canvas texture generation and mirrored in GLSL
 * for anything that has to animate (see render/shaders/noise.glsl.ts).
 *
 * Only what the art direction actually needs: value noise for grain, simplex
 * for flow, fbm for aggregate, and a worley/cellular field for the crackle in
 * aged lacquer and the chipping in mineral pigment.
 */

import { makeRng } from './rng.ts';

// ---------------------------------------------------------------------------
// Permutation table
// ---------------------------------------------------------------------------

function buildPerm(seed: number): Uint8Array {
  const rng = makeRng(seed);
  const p = new Uint8Array(512);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = rng.int(0, i);
    const t = base[i];
    base[i] = base[j];
    base[j] = t;
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  return p;
}

export class Noise {
  private perm: Uint8Array;
  private grad2: Float32Array;

  constructor(seed = 1337) {
    this.perm = buildPerm(seed);
    // 12 gradient directions on the unit circle, precomputed.
    this.grad2 = new Float32Array(24);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      this.grad2[i * 2] = Math.cos(a);
      this.grad2[i * 2 + 1] = Math.sin(a);
    }
  }

  // -- value noise ---------------------------------------------------------

  /** Smooth value noise in [0, 1]. Cheap, slightly blocky — right for grain. */
  value2(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const h = (a: number, b: number) => this.perm[(this.perm[a & 255] + b) & 255] / 255;
    const n00 = h(xi, yi);
    const n10 = h(xi + 1, yi);
    const n01 = h(xi, yi + 1);
    const n11 = h(xi + 1, yi + 1);
    const nx0 = n00 + (n10 - n00) * u;
    const nx1 = n01 + (n11 - n01) * u;
    return nx0 + (nx1 - nx0) * v;
  }

  // -- simplex -------------------------------------------------------------

  /** 2D simplex noise in roughly [-1, 1]. */
  simplex2(xin: number, yin: number): number {
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;

    const corner = (gi: number, x: number, y: number): number => {
      let tt = 0.5 - x * x - y * y;
      if (tt < 0) return 0;
      tt *= tt;
      const g = (gi % 12) * 2;
      return tt * tt * (this.grad2[g] * x + this.grad2[g + 1] * y);
    };

    const gi0 = this.perm[ii + this.perm[jj]];
    const gi1 = this.perm[ii + i1 + this.perm[jj + j1]];
    const gi2 = this.perm[ii + 1 + this.perm[jj + 1]];
    return 70 * (corner(gi0, x0, y0) + corner(gi1, x1, y1) + corner(gi2, x2, y2));
  }

  // -- aggregates ----------------------------------------------------------

  /** Fractal Brownian motion over simplex, returned in [0, 1]. */
  fbm(x: number, y: number, octaves = 4, lacunarity = 2.0, gain = 0.5): number {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.simplex2(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return (sum / norm) * 0.5 + 0.5;
  }

  /** Ridged fbm — the vein structure inside mineral pigment. */
  ridged(x: number, y: number, octaves = 4): number {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.simplex2(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  /**
   * Cellular / worley distance field. Returns `{ f1, f2, id }`: the nearest and
   * second-nearest feature distances plus a stable per-cell id, which is what
   * lets a pigment chip take one flat colour across its whole area.
   */
  cellular(x: number, y: number, jitter = 1.0): { f1: number; f2: number; id: number } {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let f1 = 1e9;
    let f2 = 1e9;
    let id = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx;
        const cy = yi + dy;
        const h = this.perm[(this.perm[cx & 255] + cy) & 255];
        const h2 = this.perm[(this.perm[(cx + 71) & 255] + cy + 31) & 255];
        const px = cx + 0.5 + (h / 255 - 0.5) * jitter;
        const py = cy + 0.5 + (h2 / 255 - 0.5) * jitter;
        const ddx = px - x;
        const ddy = py - y;
        const d = Math.sqrt(ddx * ddx + ddy * ddy);
        if (d < f1) {
          f2 = f1;
          f1 = d;
          id = (h << 8) | h2;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    return { f1, f2, id };
  }
}

/** One shared field for anything that does not care about decorrelation. */
export const noise = new Noise(0x9527);
