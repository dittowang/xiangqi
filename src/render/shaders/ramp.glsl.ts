/**
 * The mineral-pigment quantiser.
 *
 * This is the single most important twenty lines in the renderer. Everything
 * else — outlines, silk wash, grade — is dressing on top of the decision made
 * here: how a surface turns from light into shadow.
 *
 * A physically based renderer integrates a BRDF and gets a smooth falloff. A
 * gongbi painter does not have a falloff. They lay a flat field of 罩染
 * undertone, then a flat field of body colour over part of it, then a smaller
 * flat field of the lifted plane, then a stroke of 提白 at the top. Four flat
 * fields with hard edges between them. The edges are where the drawing is.
 *
 * So the quantiser is a *texture fetch*, not a formula. `ramps.ts` bakes, for
 * every (MaterialClass, PigmentName) pair, a row of the atlas in which the
 * horizontal axis IS N·L and the colour at each texel is the pigment already
 * laid. Sampling that row with NearestFilter gives a hard edge for free, at
 * exactly the N·L the art direction asked for in `RAMPS`, with no per-fragment
 * threshold comparisons at all.
 *
 * Why the lookup axis is raw N·L and not a half-lambert or a wrapped diffuse:
 * the thresholds in core/palette.ts (0.16 … 0.87) were authored against the
 * clamped dot product. Remapping the axis here would silently move every band
 * edge in the project and there would be no single place to notice.
 *
 * The three inputs that legitimately move the lookup, all documented at their
 * call site in gongbi.ts:
 *   - granulation: the tooth of the pigment. Real mineral pigment is ground
 *     rock; where the grains sit thick the band edge advances, where they sit
 *     thin it retreats. Perturbing N·L by a low-amplitude field before the
 *     fetch makes the band boundary break up along the grain instead of
 *     running as a clean vector curve. This is 顆粒 and it is what stops the
 *     bands reading as vector art.
 *   - variation: the per-unit nudge, so a rank of eight soldiers is eight
 *     figures rather than one figure printed eight times.
 *   - shadow: cascaded shadow attenuates N·L *before* the fetch, so a
 *     shadowed surface resolves to its own undertone band rather than being
 *     multiplied toward black. Multiplying a laid pigment toward black is the
 *     mistake that makes stylised renderers look like unlit 3D.
 */

/**
 * Uniforms every ramp consumer declares. Kept in one string so a material can
 * never declare half of them.
 */
export const GLSL_RAMP_PARS = /* glsl */ `
/** The (MaterialClass x PigmentName) ramp atlas. NearestFilter, no mips. */
uniform sampler2D uRampAtlas;
/** V coordinate of this material's row, already at the texel centre. */
uniform float uRampRow;
/** Number of quantisation steps in this row, 3 or 4. Debug view only. */
uniform float uRampSteps;
`;

export const GLSL_RAMP = /* glsl */ `
${GLSL_RAMP_PARS}

/**
 * Fetch the laid pigment for a given N·L.
 *
 * 'ndl' is clamped rather than wrapped: past 1.0 there is no more pigment to
 * lay, and below 0 a gongbi painter does not invent a rim of fill light, they
 * leave the undertone.
 */
vec3 xqRamp(float ndl) {
  return texture2D(uRampAtlas, vec2(clamp(ndl, 0.0, 1.0), uRampRow)).rgb;
}

/**
 * Which band a given N·L resolved to, normalised to [0,1] across the row's
 * step count. Two jobs:
 *   - the 'rampBands' debug view paints this directly, so a critic can say
 *     "band two is doing that" instead of "the shading is wrong";
 *   - the surface shader uses it as the "how lit is this" scalar for the
 *     fill/bounce tint and the silk wash, so those follow the QUANTISED light,
 *     not the continuous one. If they followed the continuous term they would
 *     smuggle a smooth gradient back in underneath the hard bands, which is
 *     exactly the tell that gives away a toon shader with a gradient map.
 *
 * The alpha channel of the atlas carries the band index, written by ramps.ts as
 * (index + 0.5) / 4. Recovering it is one multiply — cheaper and far more
 * robust than re-deriving the thresholds in the shader.
 */
float xqRampBand(float ndl) {
  float packed = texture2D(uRampAtlas, vec2(clamp(ndl, 0.0, 1.0), uRampRow)).a;
  float idx = floor(packed * 4.0);
  return idx / max(uRampSteps - 1.0, 1.0);
}

/** False-colour for the 'rampBands' debug mode: one flat hue per band. */
vec3 xqRampBandDebug(float ndl) {
  float packed = texture2D(uRampAtlas, vec2(clamp(ndl, 0.0, 1.0), uRampRow)).a;
  float idx = floor(packed * 4.0);
  if (idx < 0.5) return vec3(0.10, 0.10, 0.16);
  if (idx < 1.5) return vec3(0.15, 0.45, 0.85);
  if (idx < 2.5) return vec3(0.95, 0.62, 0.15);
  return vec3(0.98, 0.96, 0.88);
}

/**
 * 醒色 — "waking colour".
 *
 * A Western rim light is a soft Fresnel term in white or in the key's colour,
 * added on top of the shading, and it reads as a photographic bloom around the
 * subject. That is precisely what must not happen here.
 *
 * 醒色 is a *stroke*. The painter reaches the turning edge of a form, sees the
 * form going flat, and lays a short hard-edged stroke of a lifted, more
 * saturated pigment along it to wake it up. So:
 *   - the mask is hard-edged (resolved against the pixel grid, not softened);
 *   - it replaces the surface colour rather than adding to it, so it can never
 *     blow out;
 *   - it is gated by the light, because a painter wakes the lit turn, not the
 *     shadow turn — a rim running all the way round a silhouette is the tell
 *     of a shader, not a brush.
 *
 * 'ndv' is dot(N, V), 'ndl' is the unshadowed N·L.
 */
vec3 xqWakeColour(vec3 base, vec3 wake, float amount, float ndv, float ndl, float edge, float gate) {
  if (amount <= 0.0) return base;
  float turn = 1.0 - clamp(ndv, 0.0, 1.0);
  float mask = xqAAStep(edge, turn);
  // Gate on the lit side only, with a soft-ish shoulder so the stroke fades out
  // where the form rolls into shadow instead of stopping dead mid-edge.
  mask *= smoothstep(gate, gate + 0.22, ndl);
  return mix(base, wake, amount * mask);
}
`;
