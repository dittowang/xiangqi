/**
 * Small shared GLSL the other shader modules build on: clamping, colour
 * transfer, view-space reconstruction, and the cascaded shadow lookup.
 *
 * Nothing here includes three's `<common>` chunk. `<common>` defines
 * `saturate`, `PI`, `pow2` and friends, and every one of those is a name we
 * would then be forbidden to reuse; keeping our own `xq`-prefixed vocabulary
 * means a chunk three adds in a future release can never silently collide with
 * ours. The one chunk we do pull in is `<packing>`, for `unpackRGBAToDepth`,
 * because the shadow maps are written by three's own MeshDepthMaterial and it
 * would be reckless to re-derive its packing by hand.
 */

/** Clamp / transfer helpers. */
export const GLSL_MATH = /* glsl */ `
float xqSat(float x) { return clamp(x, 0.0, 1.0); }
vec3  xqSat3(vec3 v) { return clamp(v, 0.0, 1.0); }

float xqLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// The exact sRGB transfer functions, matching core/palette.ts. We never use the
// 2.2 approximation: the palette's four-band value ladder was tuned by eye
// against captured frames, and a 2.2 gamma shifts the darkest band of 墨 by
// enough to break the ladder the two armies share.
float xqLinearToSrgb1(float c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
vec3 xqLinearToSrgb(vec3 c) {
  return vec3(xqLinearToSrgb1(c.r), xqLinearToSrgb1(c.g), xqLinearToSrgb1(c.b));
}
float xqSrgbToLinear1(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}
vec3 xqSrgbToLinear(vec3 c) {
  return vec3(xqSrgbToLinear1(c.r), xqSrgbToLinear1(c.g), xqSrgbToLinear1(c.b));
}

/**
 * Screen-space antialiased step. 'edge' is compared against 'x', and the
 * transition is exactly as wide as 'x' changes over one pixel. This is how
 * every hard edge in this renderer stays hard: we are not softening the band,
 * we are resolving it against the pixel grid. Softening a band edge past a
 * pixel or two is what turns laid pigment into a generic toon shader.
 */
float xqAAStep(float edge, float x) {
  float w = max(fwidth(x), 1e-5);
  return smoothstep(edge - w, edge + w, x);
}
`;

/**
 * The cascaded shadow lookup.
 *
 * Cascades are selected on positive view depth. Sampler arrays cannot be
 * indexed with a non-constant expression in GLSL ES, so the three maps are
 * three separate uniforms behind an if-chain rather than an array — ugly, but
 * it is the only form that compiles everywhere.
 *
 * Bias strategy: normal-offset, not depth-offset. We push the sample position
 * along the surface normal by roughly one shadow texel's worth of world space
 * before projecting into light space. Depth bias alone has to be large enough
 * to survive the worst slope in the frame, and at that size it detaches contact
 * shadows from feet — "peter-panning" — which on a board where every figure is
 * standing on a flat plane is the single most obvious shadow defect. A small
 * constant depth bias is kept on top purely to kill self-shadow acne on
 * surfaces almost parallel to the light.
 */
export const GLSL_CSM = /* glsl */ `
#include <packing>

uniform sampler2D uCsmMap0;
uniform sampler2D uCsmMap1;
uniform sampler2D uCsmMap2;
uniform mat4 uCsmMatrix0;
uniform mat4 uCsmMatrix1;
uniform mat4 uCsmMatrix2;
/** Far view-depth of each cascade, world units. */
uniform vec3 uCsmSplit;
/** World size of one shadow texel in each cascade — drives the normal offset. */
uniform vec3 uCsmTexelWorld;
/** Constant depth bias per cascade, in normalised light-depth units. */
uniform vec3 uCsmBias;
/** 1 / shadowMapSize. */
uniform float uCsmTexel;
/** How many cascades are live (quality tier can drop this to 2 or 1). */
uniform float uCsmCount;
/** Global on/off; 0 makes everything fully lit. */
uniform float uCsmEnabled;

float xqCsmFetch(sampler2D map, mat4 mtx, vec3 wp, float bias) {
  vec4 lp = mtx * vec4(wp, 1.0);
  // The cascade cameras are orthographic, so w is exactly 1 and the divide is
  // a formality — but keeping it means a future perspective spot light needs
  // no change here.
  vec3 uvz = lp.xyz / lp.w * 0.5 + 0.5;

  // Outside the cascade's footprint we must report "lit", never "shadowed",
  // or the frame gets a hard black rectangle at the cascade border.
  if (uvz.x < 0.0 || uvz.x > 1.0 || uvz.y < 0.0 || uvz.y > 1.0 || uvz.z > 1.0) return 1.0;

  float d = uvz.z - bias;
  float sum = 0.0;
  // 3x3 PCF. Nine taps is enough here because the band quantiser downstream
  // collapses the penumbra into discrete steps anyway — spending 16 or 25 taps
  // buys a smoothness the ramp immediately throws away.
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uCsmTexel;
      float sd = unpackRGBAToDepth(texture2D(map, uvz.xy + o));
      sum += step(d, sd);
    }
  }
  return sum * 0.11111111;
}

float xqCsmCascade(int idx, vec3 worldPos, vec3 n) {
  if (idx == 0) {
    return xqCsmFetch(uCsmMap0, uCsmMatrix0, worldPos + n * uCsmTexelWorld.x * 1.5, uCsmBias.x);
  } else if (idx == 1) {
    return xqCsmFetch(uCsmMap1, uCsmMatrix1, worldPos + n * uCsmTexelWorld.y * 1.5, uCsmBias.y);
  }
  return xqCsmFetch(uCsmMap2, uCsmMatrix2, worldPos + n * uCsmTexelWorld.z * 1.5, uCsmBias.z);
}

/**
 * 'viewDepth' is positive distance in front of the camera.
 * Returns 1 = fully lit, 0 = fully shadowed.
 *
 * The blend band at the end of each cascade costs a second lookup for the few
 * per cent of pixels that straddle a split. Without it the split shows as a
 * straight line across the board where the shadow softness changes, which on a
 * flat tabletop is unmissable.
 */
float xqCsmShadow(vec3 worldPos, vec3 n, float viewDepth, float blendFrac) {
  if (uCsmEnabled < 0.5) return 1.0;

  int idx = 0;
  float lo = 0.0;
  float hi = uCsmSplit.x;
  if (viewDepth > uCsmSplit.x && uCsmCount > 1.5) { idx = 1; lo = uCsmSplit.x; hi = uCsmSplit.y; }
  if (viewDepth > uCsmSplit.y && uCsmCount > 2.5) { idx = 2; lo = uCsmSplit.y; hi = uCsmSplit.z; }

  float s = xqCsmCascade(idx, worldPos, n);

  float band = (hi - lo) * blendFrac;
  if (band > 0.0 && viewDepth > hi - band && float(idx) < uCsmCount - 1.5) {
    float t = xqSat((viewDepth - (hi - band)) / band);
    s = mix(s, xqCsmCascade(idx + 1, worldPos, n), t);
  }
  return s;
}

/** Debug: false-colour the cascade a pixel resolved to. */
vec3 xqCsmDebugTint(float viewDepth) {
  if (viewDepth <= uCsmSplit.x) return vec3(1.0, 0.35, 0.30);
  if (viewDepth <= uCsmSplit.y) return vec3(0.35, 1.0, 0.45);
  return vec3(0.35, 0.55, 1.0);
}
`;
