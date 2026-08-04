/**
 * A minimal PNG reader, and the frame statistics the harness judges captures by.
 *
 * Why this exists at all: the single most common way a capture harness lies is
 * to write a perfectly valid PNG of a black screen and report success. Reading
 * the bytes that actually landed on disk — not the canvas we *think* we drew —
 * is the only honest check. `sharp`, `pngjs` and node-canvas are all off limits
 * (three is the only dependency this project is allowed), so the decoder is
 * ~120 lines against `node:zlib`, which ships with node.
 *
 * Scope is deliberately narrow: non-interlaced, 8- or 16-bit, greyscale / RGB /
 * greyscale+alpha / RGBA. That is exactly what Chromium's screenshot encoder
 * emits. Anything else throws a named error and the caller degrades to
 * "statistics unavailable" rather than failing a run for the wrong reason.
 */

import { inflateSync } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Samples per pixel for each PNG colour type. Type 3 (palette) is unsupported. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export class PngFormatError extends Error {
  override name = 'PngFormatError';
}

export interface DecodedPng {
  width: number;
  height: number;
  /** 1 = grey, 2 = grey+alpha, 3 = RGB, 4 = RGBA. */
  channels: number;
  /** Row-major 8-bit samples, `channels` per pixel. 16-bit input is truncated. */
  data: Uint8Array;
}

export function decodePng(buf: Buffer): DecodedPng {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new PngFormatError('not a PNG (bad signature)');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const body = p + 8;
    if (type === 'IHDR') {
      width = buf.readUInt32BE(body);
      height = buf.readUInt32BE(body + 4);
      bitDepth = buf[body + 8]!;
      colourType = buf[body + 9]!;
      interlace = buf[body + 12]!;
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(body, body + len));
    } else if (type === 'IEND') {
      break;
    }
    p = body + len + 4; // skip payload + CRC
  }

  if (!width || !height) throw new PngFormatError('missing IHDR');
  if (interlace !== 0) throw new PngFormatError('interlaced PNG is unsupported');
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new PngFormatError(`bit depth ${bitDepth} is unsupported (need 8 or 16)`);
  }
  const channels = CHANNELS[colourType];
  if (!channels) throw new PngFormatError(`colour type ${colourType} is unsupported`);

  const raw = inflateSync(Buffer.concat(idat));

  // Bytes per pixel, in the *filtered* stream. Filters work on bytes, so at bit
  // depth 16 the filter distance is two bytes per sample.
  const bpp = channels * (bitDepth >> 3);
  const stride = width * bpp;
  const expected = height * (stride + 1);
  if (raw.length < expected) {
    throw new PngFormatError(`truncated image data (${raw.length} < ${expected})`);
  }

  const out = Buffer.allocUnsafe(height * stride);
  let src = 0;
  let dst = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]!;
    const rowStart = dst;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[src + x]!;
      // a = left, b = above, c = above-left — all in reconstructed space.
      const a = x >= bpp ? out[rowStart + x - bpp]! : 0;
      const b = y > 0 ? out[prevStart + x]! : 0;
      const c = y > 0 && x >= bpp ? out[prevStart + x - bpp]! : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = cur;
          break;
        case 1:
          v = cur + a;
          break;
        case 2:
          v = cur + b;
          break;
        case 3:
          v = cur + ((a + b) >> 1);
          break;
        case 4:
          v = cur + paeth(a, b, c);
          break;
        default:
          throw new PngFormatError(`unknown row filter ${filter} on row ${y}`);
      }
      out[rowStart + x] = v & 0xff;
    }
    src += stride;
    dst += stride;
  }

  if (bitDepth === 8) return { width, height, channels, data: out };

  // 16-bit: keep the high byte of every sample. Precision beyond 8 bits is
  // irrelevant to every judgement this file makes.
  const eight = new Uint8Array(width * height * channels);
  for (let i = 0, j = 0; i < eight.length; i++, j += 2) eight[i] = out[j]!;
  return { width, height, channels, data: eight };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// ---------------------------------------------------------------------------
// Frame statistics
// ---------------------------------------------------------------------------

export interface FrameStats {
  width: number;
  height: number;
  pixels: number;
  /** Most common colour, exact, as sRGB hex. */
  dominantHex: string;
  /**
   * Fraction of pixels sharing the dominant colour, measured after quantising
   * to 5 bits per channel. Near-identical colours count together on purpose —
   * a frame that is 99% #000000 and 1% #010101 is still a black frame.
   */
  dominantFraction: number;
  /** Distinct 15-bit colour buckets present. A flat fill scores 1. */
  uniqueBuckets: number;
  /** Mean display-referred luma, 0..1. This is the exposure reading. */
  meanLuma: number;
  /** Standard deviation of luma. Flat frames score ~0. */
  stdLuma: number;
  /** Fraction of pixels below luma 0.06 — ink, and the black-frame tell. */
  darkFraction: number;
  /** Fraction above luma 0.90 — paper, and the blown-out tell. */
  lightFraction: number;
}

const QUANT_BUCKETS = 1 << 15; // 5 bits per channel
const histogram = new Int32Array(QUANT_BUCKETS); // module-level scratch, reused

/**
 * Luma weights are applied to the *encoded* sRGB values rather than linearised
 * ones. That is deliberate: these numbers exist to answer "does this read as
 * black / blown out to a human looking at the PNG", which is a display-referred
 * question. `core/palette.ts:luma()` linearises because it is policing a
 * pigment value ladder, which is a different question.
 */
export function analysePng(buf: Buffer): FrameStats {
  const img = decodePng(buf);
  const { width, height, channels, data } = img;
  const pixels = width * height;

  histogram.fill(0);
  let sum = 0;
  let sumSq = 0;
  let dark = 0;
  let light = 0;

  const step = channels;
  const grey = channels < 3;
  for (let i = 0, o = 0; i < pixels; i++, o += step) {
    const r = data[o]!;
    const g = grey ? r : data[o + 1]!;
    const b = grey ? r : data[o + 2]!;
    histogram[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)]!++;
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sum += l;
    sumSq += l * l;
    if (l < 0.06) dark++;
    else if (l > 0.9) light++;
  }

  let best = 0;
  let bestCount = 0;
  let unique = 0;
  for (let k = 0; k < QUANT_BUCKETS; k++) {
    const c = histogram[k]!;
    if (c === 0) continue;
    unique++;
    if (c > bestCount) {
      bestCount = c;
      best = k;
    }
  }

  const mean = sum / pixels;
  const variance = Math.max(0, sumSq / pixels - mean * mean);

  return {
    width,
    height,
    pixels,
    dominantHex: exactDominant(img, best),
    dominantFraction: bestCount / pixels,
    uniqueBuckets: unique,
    meanLuma: mean,
    stdLuma: Math.sqrt(variance),
    darkFraction: dark / pixels,
    lightFraction: light / pixels,
  };
}

/**
 * Second pass over just the winning bucket, so the report names the real colour
 * (`#0b0a08`) rather than the bucket centre (`#0c0c04`). Cheap: for a flat frame
 * the map holds one key, and for a busy frame the bucket holds few pixels.
 */
function exactDominant(img: DecodedPng, bucket: number): string {
  const { width, height, channels, data } = img;
  const counts = new Map<number, number>();
  const grey = channels < 3;
  for (let i = 0, o = 0; i < width * height; i++, o += channels) {
    const r = data[o]!;
    const g = grey ? r : data[o + 1]!;
    const b = grey ? r : data[o + 2]!;
    if ((((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)) !== bucket) continue;
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.size > 4096) break; // already provably not a flat frame
  }
  let bestKey = 0;
  let bestCount = -1;
  for (const [k, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      bestKey = k;
    }
  }
  return '#' + bestKey.toString(16).padStart(6, '0');
}

// ---------------------------------------------------------------------------
// The blank-frame verdict
// ---------------------------------------------------------------------------

export interface FramePolicy {
  /** Reject when one colour covers more than this. Default 0.99. */
  maxDominantFraction?: number;
  /**
   * Reject when fewer distinct colour buckets than this are present. Default 3,
   * which only catches degenerate frames — a solid fill, or a two-tone split
   * that `maxDominantFraction` would wave through. It is deliberately *not* a
   * measure of scene richness: a flat-shaded bootstrap board legitimately
   * resolves to four or five buckets, and the real work of proving a frame has
   * content is done by `maxDominantFraction` and `minStdLuma`.
   */
  minUniqueBuckets?: number;
  /** Require at least this much ink — how a silhouette shot proves it has units. */
  minDarkFraction?: number;
  /** Require at least this much paper — how a silhouette proves it has a ground. */
  minLightFraction?: number;
  /** Require this much tonal spread; catches a flat gradient masquerading as a scene. */
  minStdLuma?: number;
  /** Exposure guard rails, [min, max] mean luma. */
  meanLumaRange?: [number, number];
}

export const DEFAULT_POLICY: Required<Pick<FramePolicy, 'maxDominantFraction' | 'minUniqueBuckets'>> =
  {
    maxDominantFraction: 0.99,
    minUniqueBuckets: 3,
  };

export interface FrameVerdict {
  ok: boolean;
  failures: string[];
}

export function judgeFrame(s: FrameStats, policy: FramePolicy = {}): FrameVerdict {
  const maxDom = policy.maxDominantFraction ?? DEFAULT_POLICY.maxDominantFraction;
  const minBuckets = policy.minUniqueBuckets ?? DEFAULT_POLICY.minUniqueBuckets;
  const failures: string[] = [];

  if (s.dominantFraction > maxDom) {
    failures.push(
      `blank frame: ${pct(s.dominantFraction)} of pixels are ${s.dominantHex} ` +
        `(limit ${pct(maxDom)})`,
    );
  }
  if (s.uniqueBuckets < minBuckets) {
    failures.push(`only ${s.uniqueBuckets} distinct colours (need ${minBuckets})`);
  }
  if (policy.minDarkFraction != null && s.darkFraction < policy.minDarkFraction) {
    failures.push(
      `too little ink: ${pct(s.darkFraction)} below luma 0.06 (need ${pct(policy.minDarkFraction)})`,
    );
  }
  if (policy.minLightFraction != null && s.lightFraction < policy.minLightFraction) {
    failures.push(
      `too little ground: ${pct(s.lightFraction)} above luma 0.90 ` +
        `(need ${pct(policy.minLightFraction)})`,
    );
  }
  if (policy.minStdLuma != null && s.stdLuma < policy.minStdLuma) {
    failures.push(`flat tone: luma sigma ${s.stdLuma.toFixed(4)} (need ${policy.minStdLuma})`);
  }
  if (policy.meanLumaRange) {
    const [lo, hi] = policy.meanLumaRange;
    if (s.meanLuma < lo || s.meanLuma > hi) {
      failures.push(`exposure ${s.meanLuma.toFixed(3)} outside [${lo}, ${hi}]`);
    }
  }
  return { ok: failures.length === 0, failures };
}

export function pct(v: number): string {
  return (v * 100).toFixed(2) + '%';
}

/** One-line human summary used in the console table and in index.md. */
export function describeStats(s: FrameStats): string {
  return (
    `${s.width}x${s.height} · dom ${pct(s.dominantFraction)} ${s.dominantHex} · ` +
    `${s.uniqueBuckets} colours · luma ${s.meanLuma.toFixed(3)}±${s.stdLuma.toFixed(3)}`
  );
}
