/**
 * The silk ground: weave + 皴 brush strokes.
 *
 * 罩染 is the gongbi technique of building shadow by laying transparent washes
 * one over another rather than by mixing black into the colour. The pigment
 * stays the pigment; what changes is how many veils of it you are looking
 * through. Crucially, those veils sit on a *ground* — a woven silk with a
 * visible tooth — and in the shadowed passages the tooth of the ground shows
 * through the wash. That tooth is the difference between a painting and a
 * render.
 *
 * Two decisions follow from that and they pull against each other:
 *
 * 1. The weave belongs to the GROUND, not to the object. It is a property of
 *    the silk the whole image is painted on, so it must be SCREEN-ALIGNED and
 *    identical across the frame. If it were UV-mapped or triplanar it would
 *    slide across surfaces as the camera moves and instantly read as a fabric
 *    texture on the armour, which is the opposite of the intent.
 *
 * 2. A screen-aligned pattern applied uniformly is a post-process filter, and
 *    filters read as filters. So the amplitude is modulated per surface by that
 *    surface's own shadow/band term and by its material class's `silkWash`
 *    strength. Lit passages get almost none; the deep undertone bands get the
 *    full tooth. The pattern is global, the exposure of it is local.
 *
 * ALIASING — the thing the brief specifically warns about:
 * Because the pattern is generated from `gl_FragCoord.xy`, the sampling rate is
 * exactly one sample per device pixel *everywhere in the frame*. There is no
 * minification and no magnification, so there is no moire from scale — the only
 * way to alias is to choose a period near Nyquist. The period is therefore
 * specified in CSS pixels and multiplied up by the device pixel ratio, and the
 * amplitude is faded to zero as the device-pixel period approaches four. That
 * is what "derivative-aware" reduces to for a screen-aligned field, and it is
 * exact rather than approximate: `fwidth(gl_FragCoord.x)` is identically 1.0.
 */

export const GLSL_SILK_PARS = /* glsl */ `
/** Weave period in DEVICE pixels (CSS period x dpr, computed on the CPU). */
uniform float uSilkPeriodPx;
/** 皴 stroke field scale in DEVICE pixels. */
uniform float uCunScalePx;
/** Direction of the 皴 strokes, radians, measured in screen space. */
uniform float uCunAngle;
/** The wash pigment, linear. Usually the surface pigment's own undertone band. */
uniform vec3 uSilkTint;
/** Global multiplier; the perf governor drops this to 0 on the low tier. */
uniform float uSilkGain;
/** Per-material-class strength, straight from RampSpec.silkWash. */
uniform float uSilkWash;
`;

export const GLSL_SILK = /* glsl */ `
${GLSL_SILK_PARS}

/**
 * Plain-weave tooth in [0,1].
 *
 * A plain weave alternates which thread is on top in a checkerboard, so the
 * highlight runs along the warp in one cell and along the weft in the next.
 * Modelling that literally — rather than just crossing two sine grids — is what
 * makes it read as woven rather than as graph paper.
 *
 * The threads are also given a slow phase wobble. Hand-loomed silk is not
 * ruled; perfectly straight threads read as a digital pattern at any density.
 */
float xqSilkWeave(vec2 px, float periodPx) {
  float k = 6.283185307 / max(periodPx, 1.0);

  // Slow, low-amplitude drift so the threads bow the way a real warp does.
  // Amplitude is a fraction of the period, so it scales with thread size.
  vec2 wob = vec2(
    xqSimplex2(px * (0.35 / periodPx) + 11.7),
    xqSimplex2(px * (0.35 / periodPx) + 41.3)
  ) * periodPx * 0.13;

  vec2 q = px + wob.yx;

  // Ridge along each thread direction, in [0,1], peaked at the thread's crown.
  float warp = 0.5 - 0.5 * cos(q.x * k);
  float weft = 0.5 - 0.5 * cos(q.y * k);

  // Which thread is on top in this cell of the weave. Halving the frequency
  // gives one alternation per thread pair, which is what "plain weave" means.
  float cellX = floor(q.x * k * 0.15915494); // q.x / periodPx
  float cellY = floor(q.y * k * 0.15915494);
  float over = mod(cellX + cellY, 2.0);

  // Where the warp is on top, the warp's crown is bright and the weft is
  // pushed under it, and vice versa. 0.72/0.28 rather than 1/0 because silk is
  // fine enough that the buried thread is still faintly visible.
  float tooth = mix(warp * 0.72 + weft * 0.28, weft * 0.72 + warp * 0.28, over);

  // Slubs: the occasional thicker thread. Sparse, low contrast, but they are
  // what makes a large flat area of silk look like material rather than a tile.
  float slub = xqSimplex2(vec2(q.x * (0.9 / periodPx), q.y * (0.06 / periodPx)));
  tooth += slub * 0.11;

  return clamp(tooth, 0.0, 1.0);
}

/**
 * 皴 (cun) — the "wrinkle/texture stroke".
 *
 * In landscape painting 皴 is the family of repeated directional strokes that
 * describe the surface of rock and the fall of a slope. Here it does the same
 * job for the shadowed passages: it gives the wash a direction and a hand.
 *
 * Built by sampling fbm through an anisotropic frame — compressed hard across
 * the stroke, stretched along it — so the field naturally elongates into
 * streaks. Then a soft threshold picks out the ridges rather than using the
 * whole field, because a stroke has an edge and a wash does not.
 */
float xqCunStrokes(vec2 px, float scalePx, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  mat2 rot = mat2(c, -s, s, c);
  vec2 q = rot * px / max(scalePx, 1.0);

  // 1 : 5.5 anisotropy. Shorter than this reads as noise; longer reads as
  // brushed metal.
  q.y *= 0.18;

  float f = xqFbm2(q, 3);

  // Two passes at different scales: the long sweep of the brush and the split
  // of the bristles inside it.
  float g = xqFbm2(q * 2.7 + 19.0, 2);

  float stroke = smoothstep(0.44, 0.78, f) * (0.65 + 0.35 * g);
  return clamp(stroke, 0.0, 1.0);
}

/**
 * The full ground tooth for one fragment, in [0,1].
 *
 * 'px' is gl_FragCoord.xy (device pixels). 'dpr' scales nothing here — the
 * periods arrive already in device pixels — but the Nyquist guard needs the
 * period, so it is applied inside.
 */
float xqSilkGround(vec2 px) {
  // Nyquist guard. Below ~4 device pixels of period the weave starts to beat
  // against the pixel grid; fade it out rather than let it shimmer.
  float legible = smoothstep(2.5, 5.0, uSilkPeriodPx);

  float weave = xqSilkWeave(px, uSilkPeriodPx) * legible;
  float cun = xqCunStrokes(px, uCunScalePx, uCunAngle);

  // The weave is the fine tooth, the 皴 is the coarse hand. Weighted toward
  // the weave: the strokes should be felt, not read.
  return clamp(weave * 0.62 + cun * 0.38, 0.0, 1.0);
}

/**
 * Lay the wash into a surface colour.
 *
 * 'shadowness' is 1 in the deepest band and 0 in the top band — it comes from
 * the QUANTISED band index, not from a continuous light term, so the wash steps
 * with the pigment instead of smuggling a gradient in underneath it.
 *
 * The wash darkens toward 'uSilkTint' (normally the pigment's own undertone)
 * where the ground's tooth is LOW — i.e. the wash pools in the valleys of the
 * weave, which is what a transparent wash physically does on real silk.
 */
vec3 xqSilkWash(vec3 base, vec2 px, float shadowness, float enabled) {
  float amt = uSilkGain * uSilkWash * shadowness * enabled;
  if (amt <= 0.0) return base;
  float tooth = xqSilkGround(px);
  // 1 - tooth: pigment settles where the ground dips.
  return mix(base, uSilkTint, amt * (1.0 - tooth));
}
`;
