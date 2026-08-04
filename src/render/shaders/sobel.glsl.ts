/**
 * The screen-space interior-line filter.
 *
 * DIVISION OF LABOUR — this is the part that goes wrong first, so it is stated
 * before any code:
 *
 *   The inverted hull owns the OUTER SILHOUETTE. Nothing else may draw there.
 *   The Sobel owns INTERIOR NORMAL BREAKS — the fold of a sleeve, the seam
 *   between two lamellar plates, the step where a pauldron meets an arm.
 *   Where the two meet, the Sobel yields.
 *
 * If they are allowed to overlap, every lamellar seam near the edge of a figure
 * gets a hull stroke and a Sobel stroke one pixel apart and the two merge into
 * a black smear. On a figure wearing two hundred plates that is not a subtle
 * defect; it is the first thing a stills critic names.
 *
 * The suppression is therefore built in from the start, with TWO independent
 * mechanisms, because either one alone has a failure case:
 *
 *   1. DEPTH DISCONTINUITY. A silhouette — of the figure against the board, or
 *      of an arm against its own torso — is always a large jump in view depth.
 *      A Roberts cross on linear view depth, normalised by the depth itself so
 *      it is scale invariant, detects it in four taps. This catches overlaps
 *      the hull mask cannot: an arm crossing a chest has no hull between them
 *      if both belong to the same mesh, yet the normal Sobel will happily draw
 *      a line there that competes with the hull one plate away.
 *
 *   2. HULL MASK DILATION. The prepass writes 1.0 into the alpha of the normal
 *      target wherever a hull fragment landed. Sampling that alpha on a ring of
 *      radius `uHullSuppressPx` and taking the maximum gives "is there a hull
 *      stroke within N pixels of me". Set to hullWidth + 1 px, exactly as
 *      ARCHITECTURE.md specifies, and exposed as a uniform so a later pass over
 *      real captured frames can widen or narrow it without touching code.
 *
 * Both are additive suppressors — a pixel is silenced if either fires. Belt and
 * braces on purpose.
 *
 * Cost: 9 normal taps (full Sobel — a Roberts cross on normals is noticeably
 * noisier on the low-curvature surfaces that make up most of a figure), 4 depth
 * taps (Roberts is fine here because we only need "big jump nearby"), and
 * HULL_TAPS ring taps. Around 21 fetches per pixel at the default.
 */

export const GLSL_SOBEL_PARS = /* glsl */ `
uniform sampler2D uSceneTex;
/** RGB = view-space normal, A = hull silhouette mask. RGBA16F. */
uniform sampler2D uNormalTex;
/** R = positive view depth in world units. R32F (RG16F on fallback paths). */
uniform sampler2D uDepthTex;
/** 1 / device-pixel resolution. */
uniform vec2 uTexel;
/** Overall line opacity, 0..1. */
uniform float uLineStrength;
/** Sobel magnitude on normals below which nothing is drawn / above which it is full. */
uniform vec2 uNormalEdge;
/** Gain on the normalised depth gradient used as suppressor 1. */
uniform float uDepthSuppress;
/** Radius of the hull-mask dilation ring, DEVICE pixels. hullWidth + 1. */
uniform float uHullSuppressPx;
/** Interior line pigment, linear. */
uniform vec3 uLineColour;
/** 0 = pure ink, 1 = the line is only a darker version of what it crosses. */
uniform float uLineTint;
/** Paper ground for the 'sobelOnly' debug view, linear. 蛤白 accent band. */
uniform vec3 uPaperColour;
/** 0 disables the whole pass (low quality tier). */
uniform float uSobelEnabled;
/** Debug selector; see DEBUG_* in composer.ts. */
uniform int uDebugMode;
`;

export const GLSL_SOBEL_FRAG = /* glsl */ `
${GLSL_SOBEL_PARS}

varying vec2 vUv;

/** Number of taps on the hull-mask dilation ring. 8 is smooth; 4 is the
 *  medium-tier setting and shows faint corner leakage on diagonal edges. */
#ifndef HULL_TAPS
  #define HULL_TAPS 8
#endif

vec3 xqNormalAt(vec2 uv) { return texture2D(uNormalTex, uv).rgb; }
float xqMaskAt(vec2 uv)  { return texture2D(uNormalTex, uv).a; }
float xqDepthAt(vec2 uv) { return texture2D(uDepthTex, uv).r; }

void main() {
  vec3 scene = texture2D(uSceneTex, vUv).rgb;

  float centreDepth = xqDepthAt(vUv);

  if (uDebugMode == 4) {
    // 'normals' — the prepass normal buffer, straight out, remapped to [0,1].
    // Background stays black so the figure's coverage is readable too.
    vec3 n = xqNormalAt(vUv);
    gl_FragColor = vec4(centreDepth > 0.0 ? n * 0.5 + 0.5 : vec3(0.0), 1.0);
    return;
  }

  // Background (nothing was drawn into the prepass here) never takes a line.
  if (uSobelEnabled < 0.5 || centreDepth <= 0.0) {
    gl_FragColor = vec4(uDebugMode == 3 ? uPaperColour : scene, 1.0);
    return;
  }

  vec2 t = uTexel;

  // ---- Sobel on view normals -------------------------------------------
  // Standard 3x3 kernels. Applied per component and combined by length, which
  // responds to a change of normal DIRECTION rather than to any one axis — a
  // seam that rotates the normal purely in Y must read as strongly as one that
  // rotates it in X.
  vec3 n00 = xqNormalAt(vUv + vec2(-t.x, -t.y));
  vec3 n10 = xqNormalAt(vUv + vec2( 0.0, -t.y));
  vec3 n20 = xqNormalAt(vUv + vec2( t.x, -t.y));
  vec3 n01 = xqNormalAt(vUv + vec2(-t.x,  0.0));
  vec3 n21 = xqNormalAt(vUv + vec2( t.x,  0.0));
  vec3 n02 = xqNormalAt(vUv + vec2(-t.x,  t.y));
  vec3 n12 = xqNormalAt(vUv + vec2( 0.0,  t.y));
  vec3 n22 = xqNormalAt(vUv + vec2( t.x,  t.y));

  vec3 gx = (n00 + 2.0 * n01 + n02) - (n20 + 2.0 * n21 + n22);
  vec3 gy = (n00 + 2.0 * n10 + n20) - (n02 + 2.0 * n12 + n22);
  float normalEdge = sqrt(dot(gx, gx) + dot(gy, gy));

  // ---- Suppressor 1: depth discontinuity --------------------------------
  float d00 = xqDepthAt(vUv + vec2(-t.x, -t.y));
  float d22 = xqDepthAt(vUv + vec2( t.x,  t.y));
  float d20 = xqDepthAt(vUv + vec2( t.x, -t.y));
  float d02 = xqDepthAt(vUv + vec2(-t.x,  t.y));
  // Normalising by the centre depth makes the measure "fraction of my own
  // distance", so a 2cm step at the near rank and at the far rank read the
  // same. Without it every line vanishes as the camera pulls back.
  float depthEdge = (abs(d00 - d22) + abs(d20 - d02)) / max(centreDepth, 1e-3);
  float depthMask = 1.0 - clamp(depthEdge * uDepthSuppress, 0.0, 1.0);

  // ---- Suppressor 2: dilated hull silhouette mask ------------------------
  float hull = xqMaskAt(vUv);
  for (int i = 0; i < HULL_TAPS; i++) {
    float a = (float(i) / float(HULL_TAPS)) * 6.283185307;
    vec2 o = vec2(cos(a), sin(a)) * uHullSuppressPx * t;
    hull = max(hull, xqMaskAt(vUv + o));
  }
  float hullMask = 1.0 - clamp(hull, 0.0, 1.0);

  // ---- Compose -----------------------------------------------------------
  float line = smoothstep(uNormalEdge.x, uNormalEdge.y, normalEdge);
  line *= depthMask * hullMask * uLineStrength;

  if (uDebugMode == 3) {
    // 'sobelOnly' — the interior line field alone on paper white, so a critic
    // can see exactly which lines this system claims and which it yielded.
    gl_FragColor = vec4(mix(uPaperColour, uLineColour, line), 1.0);
    return;
  }

  // 墨 laid over pigment, not black composited on top: tinting the stroke
  // toward what it crosses is what keeps an interior line reading as ink on a
  // coloured ground rather than as a wireframe.
  vec3 ink = mix(uLineColour, scene, uLineTint);
  gl_FragColor = vec4(mix(scene, ink, line), 1.0);
}
`;

/** Shared vertex program for every full-screen pass. */
export const GLSL_FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
