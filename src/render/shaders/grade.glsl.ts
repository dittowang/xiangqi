/**
 * Mood grade, impact flash, and paper grain — the last pass, writing to the
 * canvas at native resolution.
 *
 * Order inside the pass is fixed and matters:
 *   flash lift  ->  mood grade  ->  paper grain  ->  sRGB encode
 *
 * FLASH is a *lift*, not a bloom. There is no blur anywhere in this renderer:
 * a bloom is a lens artefact, and a gongbi painting has no lens. The impact
 * flash raises the frame toward a pigment, weighted by how light each pixel
 * already is, so the lit planes bloom out and the ink contours hold. That reads
 * as the paper being struck by light rather than as a camera being dazzled.
 *
 * MOOD GRADE pulls the frame toward `LightMood.gradeTint` while PRESERVING
 * LUMINANCE. This is the whole reason it is safe to run at all: core/palette.ts
 * builds every pigment on one shared value ladder, and that ladder is what
 * keeps the cinnabar Han army and the ink-lacquer Chu army from tearing the
 * frame in half. A naive multiply-by-tint would crush that ladder differently
 * for warm and cool pigments and undo the palette's central discipline. So we
 * replace chroma at matched luma instead.
 *
 * PAPER GRAIN is applied LAST and in DEVICE PIXELS. It is the grain of the
 * sheet the image is on, so it belongs to the sheet, not to the scene: it must
 * not scale with the camera, must not scale with the render resolution, and
 * must sit at a fixed size on the physical display. When the perf governor
 * drops the pixel ratio, the grain period in device pixels is recomputed so the
 * grain stays the same physical size — otherwise a tier change would visibly
 * change the paper, which is far more noticeable than the resolution drop it
 * was hiding.
 */

export const GLSL_GRADE_PARS = /* glsl */ `
uniform sampler2D uSceneTex;
/** 1 / device-pixel resolution, for the edge-AA taps. */
uniform vec2 uTexel;
/** Edge-AA strength, 0 disables. */
uniform float uEdgeAA;
/** Impact flash strength, 0..1. Decays on the CPU. */
uniform float uFlash;
/** Flash pigment, linear. */
uniform vec3 uFlashColour;
/** LightMood.gradeTint, linear. */
uniform vec3 uGradeTint;
/** LightMood.gradeAmount, 0..1. */
uniform float uGradeAmount;
/** Edge darkening, 0 disables. */
uniform float uVignette;
/** Grain strength, 0..1. */
uniform float uGrainAmount;
/** Grain cell size in DEVICE pixels — CSS px x dpr, converted on the CPU. */
uniform float uGrainPeriodPx;
/** Device-pixel resolution of the drawing buffer. */
uniform vec2 uViewportPx;
/** Non-zero disables grade and grain so debug views stay uncontaminated. */
uniform int uDebugMode;
`;

export const GLSL_GRADE_FRAG = /* glsl */ `
${GLSL_GRADE_PARS}

varying vec2 vUv;

/**
 * Edge-directed antialiasing.
 *
 * WHY THIS EXISTS AT ALL, given that MSAA is configured on the scene target:
 * MSAA is a per-tier setting, and the floor sets it to zero. A stills critic
 * measured 2 375 single-pixel jumps above 120 L1 along one 220x450 strip of a
 * board edge — every silhouette a raw staircase. For a look whose premise is
 * the crispness of 漢畫像石 boundaries that is fatal, because an unfiltered
 * polygon edge is not crisp, it is aliased, and the two are opposites.
 *
 * So AA is no longer conditional on the quality tier. MSAA still does the work
 * where it is available; this runs underneath it at every tier and catches what
 * MSAA cannot — the interior lines the Sobel composites in post, which are
 * drawn after the multisample resolve and are therefore never covered by it.
 *
 * The luma-range gate matters as much as the blend: a flat band interior must
 * come out bit-identical, or this would undo the quantiser it exists to
 * protect. Only pixels that sit on a genuine luminance discontinuity are
 * touched, and then only along the edge, never across it.
 */
vec3 xqEdgeAA(vec2 uv) {
  vec3 c = texture2D(uSceneTex, uv).rgb;
  if (uEdgeAA <= 0.0) return c;

  float lM = xqLuma(c);
  float lN = xqLuma(texture2D(uSceneTex, uv + vec2(0.0, -uTexel.y)).rgb);
  float lS = xqLuma(texture2D(uSceneTex, uv + vec2(0.0,  uTexel.y)).rgb);
  float lW = xqLuma(texture2D(uSceneTex, uv + vec2(-uTexel.x, 0.0)).rgb);
  float lE = xqLuma(texture2D(uSceneTex, uv + vec2( uTexel.x, 0.0)).rgb);

  float lo = min(lM, min(min(lN, lS), min(lW, lE)));
  float hi = max(lM, max(max(lN, lS), max(lW, lE)));
  float range = hi - lo;

  // Relative AND absolute floor: relative alone chases noise in the darks,
  // absolute alone misses edges between two bright bands.
  if (range < max(0.030, hi * 0.125)) return c;

  // Gradient of luminance; the edge runs perpendicular to it.
  vec2 dir = vec2(-((lN + lE) - (lS + lW)), (lN + lW) - (lS + lE));
  float len = length(dir);
  if (len < 1e-5) return c;
  dir /= len;
  vec2 off = clamp(dir, vec2(-1.0), vec2(1.0)) * uTexel;

  vec3 a = texture2D(uSceneTex, uv - off * 0.5).rgb;
  vec3 b = texture2D(uSceneTex, uv + off * 0.5).rgb;
  vec3 blended = (a + b) * 0.5;
  return mix(c, blended, uEdgeAA * clamp(range * 3.0, 0.0, 1.0));
}

void main() {
  vec3 c = xqEdgeAA(vUv);

  if (uDebugMode != 0) {
    // Debug views are measurements. Grading them would make a critic chase a
    // defect that the grade introduced.
    gl_FragColor = vec4(xqLinearToSrgb(xqSat3(c)), 1.0);
    return;
  }

  // ---- impact flash: bloomless highlight lift ---------------------------
  if (uFlash > 0.0) {
    float y = xqLuma(c);
    // y^0.6 weights mid-tones and highlights while leaving the ink contours
    // essentially untouched, so the drawing survives the flash.
    float w = pow(clamp(y, 0.0, 1.0), 0.6);
    c = mix(c, uFlashColour, uFlash * w);
    // A small uniform lift on top, so even the deepest ink registers the hit.
    c += uFlashColour * uFlash * 0.06;
  }

  // ---- mood grade: chroma pull at matched luminance ----------------------
  if (uGradeAmount > 0.0) {
    float y = xqLuma(c);
    float ty = max(xqLuma(uGradeTint), 1e-4);
    vec3 tinted = uGradeTint * (y / ty);
    c = mix(c, tinted, uGradeAmount);
  }

  // ---- vignette ----------------------------------------------------------
  // Not a lens vignette: the edge of a hanging scroll sits slightly deeper than
  // its centre because that is where the mounting silk shades it. Very small.
  if (uVignette > 0.0) {
    vec2 d = vUv - 0.5;
    float r = dot(d, d) * 4.0;
    c *= 1.0 - uVignette * r * r;
  }

  // ---- paper grain, native resolution ------------------------------------
  if (uGrainAmount > 0.0) {
    vec2 px = vUv * uViewportPx;
    vec2 cell = px / max(uGrainPeriodPx, 1.0);

    // Fine tooth: one value-noise cell per grain period.
    float fine = xqValue2(cell) - 0.5;
    // Laid lines: the widely spaced chain lines of a laid sheet, very faint,
    // running one way only. Without them the grain reads as film noise.
    float laid = sin(px.y / max(uGrainPeriodPx * 9.0, 1.0) * 6.283185307) * 0.5;
    // Broad mottle: the thickness variation of a hand-made sheet.
    float mottle = xqFbm2(px / max(uGrainPeriodPx * 60.0, 1.0), 3) - 0.5;

    float g = fine * 0.62 + laid * 0.10 + mottle * 0.28;

    // Grain is a property of the sheet, and the sheet shows through the paint
    // most where the paint is thin. Weight by (1 - luma) so it stays out of the
    // 提白 accents, and taper it in the deepest ink where nothing shows.
    float y = clamp(xqLuma(c), 0.0, 1.0);
    float w = smoothstep(0.0, 0.08, y) * (1.0 - 0.55 * y);

    c *= 1.0 + g * uGrainAmount * w;
  }

  gl_FragColor = vec4(xqLinearToSrgb(xqSat3(c)), 1.0);
}
`;
