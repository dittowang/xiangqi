/**
 * GLSL mirror of `core/noise.ts`.
 *
 * Everything the renderer animates — the granulation that breaks a band edge,
 * the crackle in aged lacquer, the tooth of the paper — is the same family of
 * fields the CPU texture generator uses, so that a shader-evaluated surface and
 * a canvas-baked one look like they came out of the same pot of pigment.
 *
 * HONEST DEVIATION, stated once here rather than buried:
 * `core/noise.ts` selects gradients through a 256-entry permutation table built
 * from the seeded RNG. Uploading that table to every material would cost a
 * sampler slot on every draw for no visual gain, so the GPU side selects from
 * the SAME twelve unit-circle directions using an arithmetic hash instead.
 * The construction, the frequency content and the value range all match; the
 * per-lattice-cell gradient choice does not. Nothing in the project ever
 * reconstructs one field from the other, so the two never need to agree
 * bit-for-bit — but they must never be *assumed* to, and now they aren't.
 */

/**
 * Hash primitives.
 *
 * These are deliberately sin()-free. `fract(sin(x) * 43758.5453)` differs
 * between GPU vendors (sin is only accurate to a few ULP over a small range and
 * the argument here is enormous), which would make the "deterministic frame"
 * promise in ARCHITECTURE.md a lie the moment the capture harness ran on a
 * different machine than the reviewer. The fract/dot construction below is
 * exact float arithmetic and reproduces everywhere.
 *
 * The multipliers are irrational-ish decimals with no small common factors, so
 * the three components decorrelate quickly; this is the standard formulation
 * for integer-free GPU hashing.
 */
export const GLSL_HASH = /* glsl */ `
float xqHash11(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float xqHash21(vec2 p) {
  vec3 p3 = fract(p.xyx * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 xqHash22(vec2 p) {
  vec3 p3 = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float xqHash31(vec3 p) {
  vec3 p3 = fract(p * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/**
 * Value noise, simplex, fbm, ridged and cellular.
 *
 * `xqValue2`  — smooth value noise in [0,1]. Quintic ("smootherstep")
 *               interpolation, matching core/noise.ts exactly: t^3(t(6t-15)+10)
 *               has zero first AND second derivative at the lattice, so a value
 *               field used as a displacement never shows lattice creases.
 *
 * `xqSimplex2`— 2D simplex in roughly [-1,1]. The skew F2 = (sqrt(3)-1)/2 maps
 *               the equilateral simplex grid onto the integer lattice so the
 *               "which of the two triangles am I in" test collapses to one
 *               comparison (x0.x > x0.y). The 0.5 - |x|^2 kernel raised to the
 *               fourth power is the standard C2-continuous falloff; 70.0 is the
 *               scale that brings the sum back to about unit range.
 *
 * `xqFbm2`    — the aggregate, normalised to [0,1] like the CPU version.
 * `xqRidged2` — 1-|n| squared per octave: the vein structure inside a mineral
 *               pigment, where the pigment has been ground rather than dyed.
 * `xqCellular2` — Worley f1/f2 plus a stable per-cell id. The id is what lets a
 *               lacquer crackle plate take ONE flat value across its whole area,
 *               which is how real crackle reads: flat islands, not a gradient.
 */
export const GLSL_NOISE = /* glsl */ `
${GLSL_HASH}

// One of twelve directions on the unit circle — the same twelve core/noise.ts
// precomputes into its grad2 table.
vec2 xqGrad2(vec2 cell) {
  float k = floor(xqHash21(cell) * 12.0);
  float a = k * 0.5235987755982988; // 2*pi / 12
  return vec2(cos(a), sin(a));
}

float xqValue2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n00 = xqHash21(i);
  float n10 = xqHash21(i + vec2(1.0, 0.0));
  float n01 = xqHash21(i + vec2(0.0, 1.0));
  float n11 = xqHash21(i + vec2(1.0, 1.0));
  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}

float xqSimplex2(vec2 p) {
  const float F2 = 0.36602540378443865; // (sqrt(3) - 1) / 2
  const float G2 = 0.21132486540518713; // (3 - sqrt(3)) / 6

  float s = (p.x + p.y) * F2;
  vec2 i = floor(p + s);
  float t = (i.x + i.y) * G2;
  vec2 x0 = p - (i - t);

  // Which half of the rhombus: the lower triangle steps in +x first.
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 x1 = x0 - i1 + G2;
  vec2 x2 = x0 - 1.0 + 2.0 * G2;

  vec3 w = max(0.5 - vec3(dot(x0, x0), dot(x1, x1), dot(x2, x2)), 0.0);
  w = w * w;
  w = w * w; // w^4

  vec3 g = vec3(
    dot(xqGrad2(i), x0),
    dot(xqGrad2(i + i1), x1),
    dot(xqGrad2(i + 1.0), x2)
  );
  return 70.0 * dot(w, g);
}

float xqFbm2(vec2 p, int octaves) {
  float amp = 0.5;
  float freq = 1.0;
  float sum = 0.0;
  float norm = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= octaves) break;
    sum += amp * xqSimplex2(p * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return (sum / norm) * 0.5 + 0.5;
}

float xqRidged2(vec2 p, int octaves) {
  float amp = 0.5;
  float freq = 1.0;
  float sum = 0.0;
  float norm = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= octaves) break;
    float n = 1.0 - abs(xqSimplex2(p * freq));
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return sum / norm;
}

// Returns (f1, f2, id). id is in [0,1) and constant across one cell.
vec3 xqCellular2(vec2 p, float jitter) {
  vec2 ip = floor(p);
  float f1 = 1e9;
  float f2 = 1e9;
  float id = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 cell = ip + vec2(float(dx), float(dy));
      vec2 j = xqHash22(cell);
      vec2 feature = cell + 0.5 + (j - 0.5) * jitter;
      float d = length(feature - p);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = xqHash21(cell + 17.0);
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return vec3(f1, f2, id);
}
`;
