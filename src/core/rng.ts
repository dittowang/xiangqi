/**
 * Deterministic random. Everything procedural in this project — every mesh,
 * texture, crack, brush stroke and pigment chip — is generated from a seeded
 * stream, so a given build produces byte-identical geometry every run. That is
 * what makes the capture harness meaningful: a critic comparing two frames is
 * looking at a real change, not at noise reshuffling itself.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number;
  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number;
  /** Approximately normal, mean 0, unit sigma (sum of 3 uniforms). */
  gauss(): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform element. */
  pick<T>(items: readonly T[]): T;
  /** Fisher–Yates, in place, returns the same array. */
  shuffle<T>(items: T[]): T[];
  /** A child stream, independent but reproducible from this one. */
  fork(tag: string): Rng;
}

/** mulberry32 — small, fast, and good enough for geometry and texture work. */
export function makeRng(seed: number | string): Rng {
  let s = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
  // Avoid the degenerate zero state.
  if (s === 0) s = 0x9e3779b9;

  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    range: (lo, hi) => lo + next() * (hi - lo),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    gauss: () => (next() + next() + next() - 1.5) * 1.1547,
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = items[i];
        items[i] = items[j];
        items[j] = t;
      }
      return items;
    },
    fork: (tag) => makeRng((hashString(tag) ^ Math.floor(next() * 0xffffffff)) >>> 0),
  };
  return rng;
}

export function hashString(str: string): number {
  // FNV-1a, 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The project-wide seed. Every generator forks off this so the whole build is
 * one reproducible artefact. Bump it only when deliberately reshuffling the
 * procedural variation across the entire cast.
 */
export const MASTER_SEED = 0x5eed_9527;

export function seedFor(...parts: (string | number)[]): Rng {
  return makeRng(hashString(parts.join('/')) ^ MASTER_SEED);
}
