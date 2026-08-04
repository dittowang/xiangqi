/**
 * The inverted-hull vertex program — the ink contour.
 *
 * Two things make this a drawn line rather than a 3D outline effect:
 *
 * A. SMOOTHED NORMALS. The hull is the same geometry pushed outward along its
 *    normals with front faces culled. If it is pushed along the *shading*
 *    normals, every hard edge in the mesh — and this geometry is deliberately
 *    hard-edged, in the spirit of 漢畫像石 — has duplicated vertices with
 *    divergent normals, so the hull tears open at exactly the corners the line
 *    is supposed to wrap. The fix is a second normal attribute, `aSmoothNormal`,
 *    computed by welding vertices on position and averaging their face normals
 *    (see outline.ts). The surface keeps its faceted normals for shading; the
 *    hull uses the welded ones for the push. This is not optional and it is the
 *    first thing to check if a hull shows gaps at a corner.
 *
 * B. CONSTANT SCREEN-SPACE WEIGHT. Derivation, because it is the sort of thing
 *    that gets "fixed" wrongly later:
 *
 *      A perspective projection maps a view-space point to clip space with
 *          clip.y = P11 * view.y ,  clip.w = -view.z
 *      where P11 = projectionMatrix[1][1] = 1 / tan(fovY / 2).
 *      So      ndc.y = P11 * view.y / z ,   z = -view.z  (positive, in front).
 *
 *      A small view-space displacement dy at depth z therefore becomes
 *          d(ndc.y) = P11 * dy / z
 *      and NDC spans -1..1 across the viewport height H (device pixels), so
 *          d(pixels) = 0.5 * H * P11 * dy / z .
 *
 *      Solving for the dy that produces a target width W in pixels:
 *
 *          dy = 2 * W * z / (P11 * H)                                   (1)
 *
 *      An orthographic projection has clip.w = 1 and ndc.y = P11*view.y + c,
 *      so d(ndc.y) = P11 * dy with no depth term — which is (1) with z := 1.
 *      `isOrthographic` is a built-in three uniform, so both cases are one line.
 *
 *      Note that (1) is derived from the HEIGHT and P11 only. three's
 *      perspective matrix puts the aspect ratio in P00 = P11/aspect, so this
 *      expression is aspect-independent and a window resize needs no fixup.
 *
 *      The push is applied along the view-space normal, in three dimensions.
 *      At the silhouette — the only place the hull is actually visible — the
 *      normal is perpendicular to the view ray, so the whole of `dy` projects
 *      to screen and the ring is exactly W pixels wide. Toward the interior the
 *      normal tilts toward the camera and the projected offset shrinks, but the
 *      surface covers that region anyway. It also means the push has almost no
 *      view-space z component where it matters, so the hull does not fight the
 *      surface in depth.
 *
 * C. THE LINE IS NOT UNIFORM BLACK. `OUTLINES` in core/palette.ts defines three
 *    profiles: deep ink for silhouette contour, 泥金 dark gold for structural
 *    lines on plate and weapons, and a fine half-ink for flesh and stone. Each
 *    carries a `tint` toward the surface colour and a distance fade. The fade
 *    is done by dissolving the stroke INTO the surface colour, not by alpha —
 *    a transparent hull would need sorting, and a line that fades to nothing
 *    pops when it crosses the threshold. Dissolving is also what actually
 *    happens in a painting: at the far rank the contour is still there, it has
 *    just stopped being darker than what it encloses.
 */

/**
 * STAGE-SCOPED DECLARATIONS.
 *
 * A uniform declared in the vertex shader is NOT visible in the fragment
 * shader: they are separate compilation units that a link step joins, and the
 * link only matches uniforms that both stages declared for themselves. Putting
 * every outline uniform in one block and composing it into the vertex only —
 * which is what this file did until a real driver said otherwise — makes
 * `uOutlineColour`, `uOutlineTint` and `uOutlineFade` undeclared identifiers in
 * the hull fragment. GLSL then error-recovers by treating them as floats, so
 * ONE missing declaration cascades into "mix: no matching overloaded function",
 * "dimension mismatch", "cannot convert float to 3-component vector" and
 * "field selection requires a vector" on `.x`/`.y`. Twelve reported errors, one
 * cause.
 *
 * So the blocks are split by the stage that uses them and each stage composes
 * only its own. selfcheck.ts now checks declarations PER STAGE for exactly this
 * reason; checking the union of both stages, which is what it did before, is
 * blind to this entire class of bug.
 */
export const GLSL_OUTLINE_VERT_PARS = /* glsl */ `
#ifndef USE_ATLAS_MATERIAL
  /** Stroke weight in CSS pixels at the 1080-CSS-px reference viewport height.
   *  On the atlas path this comes from the parameter table instead, per vertex,
   *  so declaring it there would be a uniform no stage ever reads. */
  uniform float uOutlineWidthPx;
#endif
/** Device-pixel viewport, shared with every other material. */
uniform vec2 uViewportPx;
`;

export const GLSL_OUTLINE_FRAG_PARS = /* glsl */ `
/** Stroke pigment, linear. Deep ink, 泥金, or half-ink per OutlineProfile. */
uniform vec3 uOutlineColour;
/** 0 = pure stroke, 1 = fully tinted toward the surface it encloses. */
uniform float uOutlineTint;
/** (fadeStart, fadeEnd) in world units of camera distance. */
uniform vec2 uOutlineFade;
`;

/** Both, for callers that want the whole profile in one string. */
export const GLSL_OUTLINE_PARS =
  GLSL_OUTLINE_VERT_PARS + GLSL_OUTLINE_FRAG_PARS;

/**
 * Vertex program. Shared verbatim by the colour hull and its depth/normal
 * prepass twin, so the two can never disagree about where the hull is — which
 * would show up as the Sobel suppression mask being one pixel off the line it
 * is supposed to be suppressing against.
 */
export const GLSL_OUTLINE_VERT = /* glsl */ `
#include <skinning_pars_vertex>

${GLSL_OUTLINE_VERT_PARS}

attribute vec3 aSmoothNormal;

varying float vCamDist;

#ifdef USE_ATLAS_MATERIAL
  // The outline PROFILE becomes per-vertex too: a chariot's iron fittings take
  // the structural 泥金 line and its timber body takes the same, while the
  // driver's hands take the fine ink line — all in one hull, one draw call.
  attribute float aMaterial;
  flat out float vMatCode;
#endif

void main() {
  vec3 transformed = position;
  vec3 hullNormal = aSmoothNormal;

  #ifdef USE_SKINNING
    // Rebuilt rather than #include'd because the stock chunk only skins
    // 'objectNormal'; the hull has to skin its own welded normal attribute or
    // the shell separates from the mesh the moment a bone rotates.
    mat4 boneMatX = getBoneMatrix( skinIndex.x );
    mat4 boneMatY = getBoneMatrix( skinIndex.y );
    mat4 boneMatZ = getBoneMatrix( skinIndex.z );
    mat4 boneMatW = getBoneMatrix( skinIndex.w );

    mat4 skinMatrix = mat4( 0.0 );
    skinMatrix += skinWeight.x * boneMatX;
    skinMatrix += skinWeight.y * boneMatY;
    skinMatrix += skinWeight.z * boneMatZ;
    skinMatrix += skinWeight.w * boneMatW;
    skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;

    transformed = ( skinMatrix * vec4( transformed, 1.0 ) ).xyz;
    hullNormal = ( skinMatrix * vec4( hullNormal, 0.0 ) ).xyz;
  #endif

  vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
  vec3 viewNormal = normalize( normalMatrix * hullNormal );

  // Equation (1) above. 'isOrthographic' is injected by three.
  float depth = isOrthographic ? 1.0 : max( -mvPosition.z, 1e-4 );

  #ifdef USE_ATLAS_MATERIAL
    float authoredPx = xqAtlasParam( xqAtlasRowV( aMaterial ), 3.0 ).b;
    vMatCode = aMaterial;
  #else
    float authoredPx = uOutlineWidthPx;
  #endif

  // OutlineProfile widths are authored against a 1080-CSS-px-tall viewport and
  // scale with the viewport so the *drawing* stays composed at any window size.
  // Working in device pixels, the dpr cancels: cssW * (Hcss/1080) * dpr
  // == cssW * Hdevice / 1080.
  float widthPx = authoredPx * uViewportPx.y / 1080.0;
  float offset = 2.0 * widthPx * depth / ( projectionMatrix[1][1] * uViewportPx.y );

  mvPosition.xyz += viewNormal * offset;

  // Distance from the camera, measured AFTER the push. The push is a fraction
  // of a world unit, so it makes no difference to the fade and it saves
  // carrying a second interpolant.
  vCamDist = length( mvPosition.xyz );

  gl_Position = projectionMatrix * mvPosition;
}
`;

/**
 * Colour fragment. `xqRamp` and `uSilhouette` come from the surface shader's
 * shared blocks, which the hull material composes in ahead of this — the hull
 * samples the SAME ramp row as the surface it encloses so its `tint` is exact
 * rather than a guessed grey.
 */
export const GLSL_OUTLINE_FRAG = /* glsl */ `
${GLSL_OUTLINE_FRAG_PARS}

varying float vCamDist;

void main() {
  // Mid-band of the enclosed pigment: the colour the eye reads the form as.
  // 0.55 sits just above the body-colour threshold for every class in RAMPS,
  // so this is the body colour, not the undertone and not the accent.
  vec3 surface = xqRamp( 0.55 );

  vec3 stroke = mix( uOutlineColour, surface, uOutlineTint );

  // Dissolve into the form with distance instead of fading to transparent.
  float dissolve = smoothstep( uOutlineFade.x, uOutlineFade.y, vCamDist );
  stroke = mix( stroke, surface, dissolve * 0.85 );

  // Silhouette critic mode: flat black units, no line work of any kind. The
  // hull still draws — it just draws the same black as the surface, so the
  // silhouette measured is the hull's, which is the silhouette a viewer
  // actually sees.
  stroke = mix( stroke, vec3( 0.0 ), uSilhouette );

  gl_FragColor = vec4( stroke, 1.0 );
}
`;

/**
 * The atlas hull fragment: colour, tint and distance fade all come out of the
 * parameter table row the per-vertex code selected, so one material draws the
 * deep-ink contour on cloth, the 泥金 structural line on plate, and the fine
 * half-ink line on flesh, in a single pass over a single merged geometry.
 *
 * A class whose OutlineProfile is 'none' (the silk board) has width 0, so its
 * hull collapses exactly onto the surface and is hidden behind it. It costs a
 * little overdraw and no correctness.
 */
export const GLSL_ATLAS_OUTLINE_FRAG = /* glsl */ `
varying float vCamDist;
flat in float vMatCode;

void main() {
  float rowV = xqAtlasRowV( vMatCode );
  vec4 p2 = xqAtlasParam( rowV, 2.0 );  // outline colour, tint
  vec4 p4 = xqAtlasParam( rowV, 4.0 );  // fadeStart, fadeEnd

  vec3 surface = xqRampRow( rowV, 0.55 );
  vec3 stroke = mix( p2.rgb, surface, p2.a );

  float dissolve = smoothstep( p4.r, p4.g, vCamDist );
  stroke = mix( stroke, surface, dissolve * 0.85 );

  stroke = mix( stroke, vec3( 0.0 ), uSilhouette );
  gl_FragColor = vec4( stroke, 1.0 );
}
`;
