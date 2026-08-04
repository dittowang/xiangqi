/**
 * A software 2D rasteriser and PNG writer, for offline verification only.
 *
 * The point of this file is that the glyph coverage sheet is drawn by the *same*
 * `drawGlyph` the HUD calls: this implements the `Glyph2DContext` slice of
 * CanvasRenderingContext2D, so nothing about the render path is special-cased
 * for the tool. Non-zero winding fill, matrix stack, alpha compositing — enough
 * to be a faithful stand-in and nothing more.
 *
 * Node only. Never imported by anything under `src/`.
 */

import { deflateSync } from 'node:zlib';
import type { Glyph2DContext } from '../../src/ui/seal.ts';

/** Vertical sub-samples per pixel row. 5 is visually clean for type at 48px+. */
const SUBSAMPLES = 5;

interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const identity = (): Mat => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

function mul(m: Mat, n: Mat): Mat {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

function parseHex(hex: string): [number, number, number] {
  const h = hex[0] === '#' ? hex.slice(1) : hex;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class RasterCanvas implements Glyph2DContext {
  readonly width: number;
  readonly height: number;
  /** RGB8, row major. */
  readonly pixels: Uint8ClampedArray;

  fillStyle: string | CanvasGradient | CanvasPattern = '#000000';
  globalAlpha = 1;

  private m: Mat = identity();
  private stack: { m: Mat; fill: string | CanvasGradient | CanvasPattern; alpha: number }[] = [];
  private subpaths: number[][] = [];
  private current: number[] | null = null;
  /** Per-pixel coverage scratch for one fill, reused between fills. */
  private cov: Float32Array;

  constructor(width: number, height: number, background: string) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 3);
    this.cov = new Float32Array(width);
    const [r, g, b] = parseHex(background);
    for (let i = 0; i < width * height; i++) {
      this.pixels[i * 3] = r;
      this.pixels[i * 3 + 1] = g;
      this.pixels[i * 3 + 2] = b;
    }
  }

  // -- state ---------------------------------------------------------------

  save(): void {
    this.stack.push({ m: { ...this.m }, fill: this.fillStyle, alpha: this.globalAlpha });
  }

  restore(): void {
    const s = this.stack.pop();
    if (!s) return;
    this.m = s.m;
    this.fillStyle = s.fill;
    this.globalAlpha = s.alpha;
  }

  translate(x: number, y: number): void {
    this.m = mul(this.m, { a: 1, b: 0, c: 0, d: 1, e: x, f: y });
  }

  scale(x: number, y: number): void {
    this.m = mul(this.m, { a: x, b: 0, c: 0, d: y, e: 0, f: 0 });
  }

  rotate(angle: number): void {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this.m = mul(this.m, { a: c, b: s, c: -s, d: c, e: 0, f: 0 });
  }

  // -- path ----------------------------------------------------------------

  beginPath(): void {
    this.subpaths = [];
    this.current = null;
  }

  moveTo(x: number, y: number): void {
    this.current = [];
    this.subpaths.push(this.current);
    this.lineTo(x, y);
  }

  lineTo(x: number, y: number): void {
    if (!this.current) this.moveTo(x, y);
    else this.current.push(this.m.a * x + this.m.c * y + this.m.e, this.m.b * x + this.m.d * y + this.m.f);
  }

  closePath(): void {
    this.current = null;
  }

  /** Non-zero winding scanline fill with vertical supersampling. */
  fill(): void {
    const [cr, cg, cb] = parseHex(typeof this.fillStyle === 'string' ? this.fillStyle : '#000000');
    const alpha = this.globalAlpha;
    if (alpha <= 0) return;

    // Vertical extent of the path, so we only touch the rows it covers.
    let minY = Infinity;
    let maxY = -Infinity;
    for (const sp of this.subpaths) {
      for (let i = 1; i < sp.length; i += 2) {
        if (sp[i] < minY) minY = sp[i];
        if (sp[i] > maxY) maxY = sp[i];
      }
    }
    if (!Number.isFinite(minY)) return;
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.height - 1, Math.ceil(maxY));

    const xs: number[] = [];
    const dirs: number[] = [];
    const order: number[] = [];
    const w = this.width;
    const weight = 1 / SUBSAMPLES;

    for (let py = y0; py <= y1; py++) {
      this.cov.fill(0);
      let any = false;

      for (let s = 0; s < SUBSAMPLES; s++) {
        const sy = py + (s + 0.5) / SUBSAMPLES;
        xs.length = 0;
        dirs.length = 0;

        for (const sp of this.subpaths) {
          const n = sp.length / 2;
          if (n < 2) continue;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const ay = sp[j * 2 + 1];
            const by = sp[i * 2 + 1];
            if (ay === by) continue;
            if (sy >= Math.min(ay, by) && sy < Math.max(ay, by)) {
              const t = (sy - ay) / (by - ay);
              xs.push(sp[j * 2] + t * (sp[i * 2] - sp[j * 2]));
              dirs.push(by > ay ? 1 : -1);
            }
          }
        }
        if (xs.length < 2) continue;

        order.length = xs.length;
        for (let i = 0; i < xs.length; i++) order[i] = i;
        order.sort((a, b) => xs[a] - xs[b]);

        let winding = 0;
        let spanStart = 0;
        for (let k = 0; k < order.length; k++) {
          const prev = winding;
          winding += dirs[order[k]];
          if (prev === 0 && winding !== 0) spanStart = xs[order[k]];
          else if (prev !== 0 && winding === 0) {
            // Accumulate coverage across [spanStart, xs[k]) with partial ends.
            const a = Math.max(0, spanStart);
            const b = Math.min(w, xs[order[k]]);
            if (b > a) {
              any = true;
              const ia = Math.floor(a);
              const ib = Math.floor(b);
              if (ia === ib) {
                this.cov[ia] += (b - a) * weight;
              } else {
                this.cov[ia] += (ia + 1 - a) * weight;
                for (let x = ia + 1; x < ib; x++) this.cov[x] += weight;
                if (ib < w) this.cov[ib] += (b - ib) * weight;
              }
            }
          }
        }
      }

      if (!any) continue;
      const row = py * w * 3;
      for (let x = 0; x < w; x++) {
        const c = this.cov[x];
        if (c <= 0.0005) continue;
        const a = Math.min(1, c) * alpha;
        const o = row + x * 3;
        this.pixels[o] = this.pixels[o] * (1 - a) + cr * a;
        this.pixels[o + 1] = this.pixels[o + 1] * (1 - a) + cg * a;
        this.pixels[o + 2] = this.pixels[o + 2] * (1 - a) + cb * a;
      }
    }
  }

  // -- extras the tool uses directly ---------------------------------------

  rect(x: number, y: number, w: number, h: number): void {
    this.beginPath();
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  fillRect(x: number, y: number, w: number, h: number, colour: string, alpha = 1): void {
    const prev = this.fillStyle;
    const pa = this.globalAlpha;
    this.fillStyle = colour;
    this.globalAlpha = alpha;
    this.rect(x, y, w, h);
    this.fill();
    this.fillStyle = prev;
    this.globalAlpha = pa;
  }

  /** Fraction of pixels in a region that differ from the background colour. */
  inkFraction(x: number, y: number, w: number, h: number, background: string): number {
    const [br, bg, bb] = parseHex(background);
    let hit = 0;
    let total = 0;
    for (let py = Math.max(0, y); py < Math.min(this.height, y + h); py++) {
      for (let px = Math.max(0, x); px < Math.min(this.width, x + w); px++) {
        const o = (py * this.width + px) * 3;
        total++;
        if (
          Math.abs(this.pixels[o] - br) + Math.abs(this.pixels[o + 1] - bg) + Math.abs(this.pixels[o + 2] - bb) >
          24
        ) {
          hit++;
        }
      }
    }
    return total ? hit / total : 0;
  }
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
  return out;
}

/** Encode an RGB8 buffer as a PNG. */
export function encodePng(width: number, height: number, rgb: Uint8ClampedArray): Uint8Array {
  const raw = new Uint8Array(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
