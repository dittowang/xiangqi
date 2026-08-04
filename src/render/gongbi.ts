/**
 * The gongbi surface material — `MaterialRequest` in, `THREE.Material` out.
 *
 * ZERO PBR. There is no BRDF here, no roughness, no metalness, no specular
 * lobe, no energy conservation and no environment. A gongbi painter does not
 * simulate light transport; they decide how many flat fields of pigment a form
 * needs and where the boundaries between them fall. So:
 *
 *   - Colour comes from a baked ramp indexed on N·L (see ramps.ts). One fetch.
 *   - The key, fill and bounce are TINTS APPLIED MULTIPLICATIVELY to the laid
 *     pigment, never additive contributions accumulated into a radiance. Adding
 *     light to pigment is what makes a stylised renderer look like unlit 3D
 *     with a gradient map bolted on: the pigment stops being a substance and
 *     starts being an albedo.
 *   - Everything that follows the light — the fill tint, the bounce, the silk
 *     wash — is driven by the QUANTISED band index, not by the continuous N·L.
 *     If they used the continuous term they would smuggle a smooth gradient
 *     back in underneath the hard bands, and the bands would read as posterised
 *     shading rather than as laid fields.
 *   - The rim is 醒色, a hard-edged stroke of a lifted pigment on the lit turn,
 *     not a Fresnel glow round the silhouette. See xqWakeColour in ramp.glsl.ts.
 *
 * THREE VARIANTS PER REQUEST
 *   surface  — the main pass
 *   hull     — the BackSide inverted-hull stroke (see outline.ts)
 *   prepass  — an MRT twin of either, writing view normal + view depth for the
 *              Sobel. The prepass MUST skin identically to its source or the
 *              interior lines detach from the figure the moment it moves, which
 *              is why the skinning is written once and shared verbatim rather
 *              than reimplemented per variant.
 *
 * SKINNING NOTE
 * `MaterialRequest.skinned` is accepted and honoured, but it is deliberately
 * NOT part of the cache key. three sets `USE_SKINNING` from
 * `object.isSkinnedMesh` when it builds the program, and the program cache key
 * includes it — so one material used on both a Mesh and a SkinnedMesh compiles
 * two programs automatically and correctly. Keying materials on it as well
 * would double the material count for no benefit and split draw-call batches
 * that could have shared state.
 */

import * as THREE from 'three';
import type { GongbiMaterials, MaterialRequest, QualitySettings } from '@core/contracts.ts';
import {
  MOODS,
  OUTLINES,
  PIGMENTS,
  PIGMENT_NAMES,
  RAMPS,
  hexToRgb,
  srgbToLinear,
  type LightMood,
  type MaterialClass,
  type OutlineProfileName,
  type PigmentName,
} from '@core/palette.ts';
import { seedFor } from '@core/rng.ts';
import type { CascadedShadowMaps } from './csm.ts';
import { CASCADE_BLEND } from './csm.ts';
import {
  ATLAS_CODE_STRIDE,
  PARAM_WIDTH,
  RAMP_ROWS,
  buildParamTable,
  buildRampAtlas,
  rampRowV,
  wakeColour,
  washColour,
} from './ramps.ts';
import { CLASS_TOOTH, TextureLibrary, toothLayerIndex } from './textures.ts';
import { SilkWash } from './silk.ts';
import { GLSL_CSM, GLSL_MATH } from './shaders/lib.glsl.ts';
import { GLSL_NOISE } from './shaders/noise.glsl.ts';
import {
  GLSL_RAMP,
  GLSL_RAMP_CORE,
  GLSL_TOOTH_ARRAY,
  glslAtlasDecode,
} from './shaders/ramp.glsl.ts';
import { GLSL_SILK, GLSL_SILK_UNIFORM } from './shaders/silk.glsl.ts';
import {
  GLSL_ATLAS_OUTLINE_FRAG,
  GLSL_OUTLINE_FRAG,
  GLSL_OUTLINE_PARS,
  GLSL_OUTLINE_VERT,
} from './shaders/outline.glsl.ts';

// ===========================================================================
// TUNING BLOCK — every threshold, width and strength in this file
// ===========================================================================

/**
 * How far the lit bands take the key light's colour, and the shadow bands the
 * fill's. These are chroma pulls, not exposures: at 1.0 the pigment would be
 * fully replaced by the light's colour, which is why they sit well under half.
 */
const KEY_TINT = 0.42;
const FILL_TINT = 0.34;
/** Bounce off the table, reaching only downward-facing shadowed planes. */
const BOUNCE_TINT = 0.30;

/**
 * Reference key intensity. MOODS runs 2.10 – 2.85, so dividing by this keeps
 * the tint gain near 1 for every mood and makes the endgame's dimmer key read
 * as *less warm* rather than as *darker* — which is what a cooling mood
 * actually looks like on laid pigment.
 */
const KEY_REFERENCE = 2.5;

/**
 * What a fully shadowed surface's N·L is multiplied by before the ramp lookup.
 * 0.12 puts everything in shadow into the pigment's own 罩染 undertone band
 * rather than multiplying it toward black. Raising it lifts shadows into the
 * body colour and the frame goes flat; lowering it makes shadow read as an
 * absence of pigment.
 */
const SHADOW_DEPTH = 0.12;

/** Per-unit variation: how far the band edges move, and the value nudge. */
const VARIATION_BAND = 0.045;
const VARIATION_VALUE = 0.06;

/**
 * 醒色 stroke. `RIM_EDGE` is the (1 - N·V) at which the stroke starts — 0.62 is
 * about 39 degrees off the silhouette, a believable width for a brush stroke on
 * a turning form. `RIM_GATE` is the N·L below which no stroke is laid at all.
 */
const RIM_EDGE = 0.62;
const RIM_GATE = 0.06;

/* The silk wash's own tuning lives in silk.ts, next to the aliasing analysis
 * that justifies it; the library only wires its uniforms in. */

/**
 * Object-space tooth: how many texture repeats per world unit, and how far the
 * tooth is allowed to move N·L. The tooth's whole job is to break the band
 * boundary along the grain, so the amplitude is small — a few hundredths — and
 * the scale is what actually reads.
 */
const TOOTH_SCALE: Record<MaterialClass, number> = {
  lacquer: 2.2,
  cloth: 3.0,
  leather: 3.4,
  gold: 1.6,
  ivory: 2.6,
  timber: 1.1,
  stone: 2.0,
  silk: 1.4,
  flesh: 2.8,
  hair: 4.0,
  iron: 2.4,
};

/**
 * How far the tooth modulates VALUE directly, on top of moving the band edge.
 *
 * Perturbing the ramp lookup makes a band boundary break along the grain, which
 * is the right effect and the important one — but it does nothing at all where
 * there is no boundary. A large flat-lit plane resolves to one band across its
 * whole area, so the board came out as a single flat field of saturated 藤黃
 * with no material read whatsoever: the "plastic, not aged silk" in the review.
 *
 * So the tooth also lifts and drops the value slightly, everywhere. This is
 * what actually makes a flat field read as a woven ground rather than as fill.
 * Kept small — it is the tooth of the ground showing through the pigment, not a
 * texture map.
 */
const TOOTH_VALUE = 0.13;

/**
 * How far an aged pigment's chroma falls toward its own luminance, modulated by
 * the tooth so the ageing is uneven the way real ageing is.
 *
 * 千里江山圖's mineral blue-greens are saturated but not *bright*: ground rock
 * bound in glue, a thousand years old. A pigment straight out of the palette at
 * full chroma reads as plastic, which is the word the review used. This pulls
 * it back without leaving the palette — it is a desaturation of an existing
 * colour, the same operation `shiftHex` performs in core/palette.ts, not an
 * invented one.
 */
const PIGMENT_AGE = 0.12;

/**
 * How far into its own undertone band a fully shadowed surface is allowed to
 * fall, as a fraction of that band's luminance. 1.0 pins shadow exactly at the
 * undertone; below 1 leaves room for contact shadow to read as deeper without
 * leaving the pigment.
 */
const SHADOW_FLOOR = 0.86;

/**
 * Fraction of the silk wash a fully LIT passage still receives. The ground is
 * not a shadow effect — it is the material the picture is painted on, and it
 * shows everywhere, just far more in the washes.
 */
const SILK_LIT_FLOOR = 0.34;

/**
 * N·L wrap. 1.0 is a raw clamped Lambert; 0.5 is full half-Lambert. Tuned
 * against the measured band histogram — see the long note in the shade
 * function. Runtime-tunable through `pipeline.tune({ ndlWrap })`.
 */
const NDL_WRAP = 0.62;

/**
 * Minimum stroke width in CSS pixels, converted to device pixels every frame.
 * Below about this the contour stops reading as a drawn line at all.
 */
export const MIN_STROKE_CSS_PX = 1.35;

const GRANULATION: Record<MaterialClass, number> = {
  // Lacquer and gold are laid wet and burnished: almost no tooth shows.
  lacquer: 0.030,
  gold: 0.022,
  iron: 0.020,
  // Woven and fibrous surfaces carry the most.
  cloth: 0.055,
  timber: 0.055,
  stone: 0.065,
  leather: 0.050,
  silk: 0.045,
  ivory: 0.038,
  hair: 0.040,
  flesh: 0.032,
};

/** Cache-key quantisation. See the note on `glow` in `get()`. */
const VARIATION_STEPS = 64;
const GLOW_STEPS = 16;

/**
 * The decode block, generated from the real table dimensions so a change to
 * PARAM_WIDTH or the class/pigment counts cannot leave a stale literal in the
 * shader. selfcheck.ts re-derives the same arithmetic on the CPU and compares.
 */
const GLSL_ATLAS_DECODE = glslAtlasDecode({
  rows: RAMP_ROWS,
  paramWidth: PARAM_WIDTH,
  stride: ATLAS_CODE_STRIDE,
  pigments: PIGMENT_NAMES.length,
});

// ===========================================================================
// Debug modes — shared with composer.ts and the shaders
// ===========================================================================

export const DEBUG_NONE = 0;
export const DEBUG_RAMP_BANDS = 1;
export const DEBUG_OUTLINE_ONLY = 2;
export const DEBUG_SOBEL_ONLY = 3;
export const DEBUG_NORMALS = 4;
export const DEBUG_SHADOW_CASCADES = 5;

// ===========================================================================
// Public request extension
// ===========================================================================

/**
 * `MaterialRequest` plus the two things the contract has no field for. Callers
 * that need them declare their request as this type; everything else keeps
 * using the contract type unchanged.
 */
export interface GongbiMaterialRequest extends MaterialRequest {
  /** Banners, cloth sheets, leaves — anything with no back face of its own. */
  doubleSided?: boolean;
  /** Compile the per-instance variation attribute path (see instanceAttribute). */
  instanced?: boolean;
}

/** Lighting, fed by scene/lighting.ts. Colours are palette sRGB hex. */
export interface GongbiLighting {
  /** Direction FROM the scene TO the key light. Normalised internally. */
  keyDirection: { x: number; y: number; z: number };
  keyColour: string;
  keyIntensity: number;
  fillColour: string;
  fillIntensity: number;
  bounceColour: string;
  /** Global multiplier on the finished pigment. 1 is neutral. */
  exposure?: number;
}

// ===========================================================================
// Shader assembly
// ===========================================================================

/** Uniforms every frame shares. One object per name, referenced by every material. */
const GLSL_FRAME_PARS = /* glsl */ `
uniform vec2 uViewportPx;
uniform float uSilhouette;
uniform int uDebugMode;
`;

const GLSL_LIGHT_PARS = /* glsl */ `
uniform float uNdlWrap;
uniform float uSilkLitFloor;
uniform vec3 uKeyDir;
uniform vec3 uKeyColour;
uniform float uKeyIntensity;
uniform vec3 uFillColour;
uniform float uFillIntensity;
uniform vec3 uBounceColour;
uniform float uExposure;
uniform float uShadowDepth;
uniform float uCsmBlend;
`;

const GLSL_SURFACE_PARS = /* glsl */ `
uniform vec3 uRimColour;
uniform float uRim;
uniform float uGranulation;
uniform float uVariation;
uniform float uGlow;
uniform vec3 uGlowColour;
uniform float uNoSilk;
uniform sampler2D uToothMap;
uniform float uToothScale;
`;

const GLSL_SKIN_BLOCK = /* glsl */ `
  #ifdef USE_SKINNING
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
    objectNormal = ( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;
  #endif
`;

/**
 * Instancing is applied by hand because we do not use three's `<project_vertex>`
 * chunk. The normal's instance transform divides out the per-axis scale exactly
 * the way `<defaultnormal_vertex>` does, so a non-uniformly scaled instance —
 * a flattened rivet, a stretched spoke — still shades correctly.
 */
const GLSL_INSTANCE_BLOCK = /* glsl */ `
  #ifdef USE_INSTANCING
    mat3 im = mat3( instanceMatrix );
    objectNormal /= vec3( dot( im[0], im[0] ), dot( im[1], im[1] ), dot( im[2], im[2] ) );
    objectNormal = im * objectNormal;
    transformed = ( instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
  #endif
`;

const GLSL_INSTANCE_VARIATION_PARS = /* glsl */ `
#ifdef USE_INSTANCE_VARIATION
  attribute float aVariation;
#endif
`;

const GLSL_SURFACE_VERT = /* glsl */ `
#include <skinning_pars_vertex>

uniform mat3 uViewToWorld;

${GLSL_INSTANCE_VARIATION_PARS}

varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying vec3 vViewPos;
varying vec3 vObjPos;
varying vec3 vObjNormal;
varying float vInstanceVariation;

#ifdef USE_ATLAS_MATERIAL
  // characters/factory.ts stamps this on every merged geometry:
  // classIndex * 16 + pigmentIndex. Carried FLAT — see glslAtlasDecode().
  attribute float aMaterial;
  flat out float vMatCode;
#endif

void main() {
  vec3 transformed = position;
  vec3 objectNormal = normal;

  // The tooth is anchored to the REST pose, before skinning and before
  // instancing. A tooth that follows the skinned surface would swim across the
  // figure as it moves; a tooth anchored to rest sits still on the cloth the
  // way a weave does.
  vObjPos = position;
  vObjNormal = normal;

  ${GLSL_SKIN_BLOCK}
  ${GLSL_INSTANCE_BLOCK}

  vec4 worldPos = modelMatrix * vec4( transformed, 1.0 );
  vec4 mvPosition = viewMatrix * worldPos;

  vec3 viewNormal = normalize( normalMatrix * objectNormal );

  vWorldPos = worldPos.xyz;
  vViewPos = mvPosition.xyz;
  vWorldNormal = normalize( uViewToWorld * viewNormal );

  #ifdef USE_INSTANCE_VARIATION
    vInstanceVariation = aVariation;
  #else
    vInstanceVariation = 0.0;
  #endif

  #ifdef USE_ATLAS_MATERIAL
    vMatCode = aMaterial;
  #endif

  gl_Position = projectionMatrix * mvPosition;
}
`;

/**
 * The shading itself, written ONCE and shared by both material paths.
 *
 * Every input that used to be a per-material uniform arrives as an argument
 * instead. The per-uniform path passes its uniforms; the atlas path passes
 * values it decoded from a per-vertex material code and read out of the
 * parameter table. Having one body is not tidiness — it is the only way the two
 * paths cannot drift, and a drift here would mean the figures and the board
 * were shaded by two subtly different renderers.
 */
const GLSL_SURFACE_SHADE = /* glsl */ `
vec3 xqGongbiShade(
  float rowV, float steps,
  vec3 wake, float rim,
  vec3 silkTint, float silkWash,
  float tooth, float granulation,
  float variation, float glow, vec3 glowColour, float noSilk,
  vec3 N, vec3 V, vec3 worldPos, float viewDepth
) {
  // --- where on the ramp -------------------------------------------------
  //
  // WRAPPED N·L, and the reason is measured, not stylistic.
  //
  // With a raw clamped Lambert term the distribution is BIMODAL: a surface is
  // either roughly facing the single key (dot ~= 0.75, because the key sits at
  // 49 degrees and most surfaces in this scene are up-facing or vertical) or it
  // is turned away and clamps to 0. Counting band occupancy off the rampBands
  // debug view across a real frame gave band0 17.3%, band1 4.2%, band2 78.4%,
  // band3 0.2% — 95.7% of the frame in two bands. A four-band ramp using two
  // bands is a two-tone shader, and it is why every per-class RampSpec setting
  // looked ignored: 'accent' only touches the top band, and the top band was
  // never selected.
  //
  // The wrap remaps dot from [-1,1] into [1-2w, 1] so a form turning away from
  // the light passes through the mid bands instead of falling off a cliff into
  // band 0. This is the one place the ramp's input axis is allowed to be
  // rescaled, it is a named uniform rather than a buried constant, and the
  // histogram it produces is measured — see the note in ramp.glsl.ts about why
  // silently remapping this axis would otherwise be unforgivable.
  float ndlDot = dot( N, uKeyDir );
  float ndlRaw = clamp( ndlDot * uNdlWrap + ( 1.0 - uNdlWrap ), 0.0, 1.0 );
  float shadow = xqCsmShadow( worldPos, N, viewDepth, uCsmBlend );

  float ndl = ndlRaw * mix( uShadowDepth, 1.0, shadow );
  ndl += ( tooth - 0.5 ) * granulation;   // 顆粒: break the edge on the grain
  ndl += variation * ${VARIATION_BAND.toFixed(4)};

  if ( uDebugMode == ${DEBUG_RAMP_BANDS} ) return xqRampBandDebugRow( rowV, ndl );
  if ( uDebugMode == ${DEBUG_SHADOW_CASCADES} ) {
    return xqCsmDebugTint( viewDepth ) * mix( 0.30, 1.0, shadow );
  }

  // The band edge resolved against the PIXEL GRID, not left one texel wide.
  //
  // A NEAREST fetch puts the whole transition inside a single texel of N·L,
  // which on screen is a one-pixel step that crawls and shimmers the moment the
  // camera moves — 'edgeSoftness' is authored in N·L units and has no idea how
  // many pixels that is. Averaging three taps across one pixel's worth of N·L
  // makes the edge exactly one pixel wide wherever it lands, at any distance
  // and any angle, while leaving a band's interior bit-identical: on a flat
  // field fwidth is zero and all three taps agree.
  float ndlW = fwidth( ndl ) * 0.5;
  vec3 col = ( xqRampRow( rowV, ndl - ndlW )
             + xqRampRow( rowV, ndl )
             + xqRampRow( rowV, ndl + ndlW ) ) / 3.0;
  float band = xqRampBandRow( rowV, ndl, steps );  // 0 = deepest, 1 = top band
  float shade = 1.0 - band;

  // The ground showing through the pigment. Moving the band edge (above) does
  // nothing on a surface that resolves to a single band, and most of the board
  // is exactly that, so the tooth also carries value directly.
  float toothSigned = tooth - 0.5;
  col *= 1.0 + toothSigned * ${TOOTH_VALUE.toFixed(3)};

  // 陳色: pigment ages into muted saturation, unevenly, following the grain.
  col = mix( col, vec3( xqLuma( col ) ),
             ${PIGMENT_AGE.toFixed(3)} * ( 0.55 + 0.9 * ( 0.5 - toothSigned ) ) );

  // --- light as tint, never as accumulated radiance ----------------------
  float keyGain = uKeyIntensity / ${KEY_REFERENCE.toFixed(2)};
  col *= mix( vec3( 1.0 ), uKeyColour, ${KEY_TINT.toFixed(3)} * band * keyGain );
  col *= mix( vec3( 1.0 ), uFillColour, ${FILL_TINT.toFixed(3)} * shade * uFillIntensity );

  // Bounce is light off the tabletop, so it reaches downward-facing planes and
  // only matters where the key does not.
  float down = max( -N.y, 0.0 );
  col *= mix( vec3( 1.0 ), uBounceColour, ${BOUNCE_TINT.toFixed(3)} * down * shade );

  // Per-unit value nudge, so a rank of soldiers is not a xerox.
  col *= 1.0 + variation * ${VARIATION_VALUE.toFixed(4)};

  // --- 醒色 ---------------------------------------------------------------
  col = xqWakeColour( col, wake, rim, dot( N, V ), ndlRaw,
                      ${RIM_EDGE.toFixed(3)}, ${RIM_GATE.toFixed(3)} );

  // --- 罩染: the ground shows through --------------------------------------
  //
  // Driving the wash by 'shade' alone meant a LIT surface received none at all,
  // and the board is lit almost everywhere: a 30-pixel scan across empty silk
  // measured #D19F32 +/- 1, i.e. the ground was mathematically absent. But the
  // silk is the ground the whole image is painted on — it is not a shadow
  // effect, it is what the picture is ON. So lit passages keep a floor of it
  // and the shadows still take the full wash.
  col = xqSilkWashAt( col, gl_FragCoord.xy, mix( uSilkLitFloor, 1.0, shade ),
                      1.0 - noSilk, silkTint, silkWash );

  // --- check pulse / impact flash only -----------------------------------
  col += glowColour * glow;

  // A gongbi shadow is a 罩染 wash toward the pigment's OWN darkest band, never
  // a multiply toward black. The key/fill/bounce tints are multiplicative, so
  // stacked in deep shadow they were driving the board below its own undertone:
  // lit silk measured #D19F32 (gamboge band 2) against shadowed #46310F, which
  // is darker than gamboge band 0 (#523810) and lands on a different pigment
  // entirely. Flooring on luminance rather than per-channel keeps the hue.
  vec3 undertone = xqRampRow( rowV, 0.0 );
  float floorY = xqLuma( undertone ) * ${SHADOW_FLOOR.toFixed(3)};
  float y = xqLuma( col );
  if ( y < floorY ) col *= floorY / max( y, 1e-4 );

  col *= uExposure;
  return mix( col, vec3( 0.0 ), uSilhouette );
}
`;

/** Varyings both surface mains share. */
const GLSL_SURFACE_VARYINGS = /* glsl */ `
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying vec3 vViewPos;
varying vec3 vObjPos;
varying vec3 vObjNormal;
varying float vInstanceVariation;
`;

const GLSL_SURFACE_FRAG = /* glsl */ `
${GLSL_SURFACE_VARYINGS}

/**
 * Triplanar tooth in rest-pose object space. The blend weights are raised to
 * the fourth power so the three projections barely overlap: a soft triplanar
 * blend cross-fades two rotated copies of the same grain over each other and
 * the result reads as a smear rather than as a grain.
 */
float xqTooth() {
#ifdef USE_TOOTH
  vec3 b = abs( normalize( vObjNormal ) );
  b = b * b;
  b = b * b;
  b /= max( b.x + b.y + b.z, 1e-4 );
  vec3 p = vObjPos * uToothScale;
  return texture2D( uToothMap, p.zy ).r * b.x
       + texture2D( uToothMap, p.xz ).r * b.y
       + texture2D( uToothMap, p.xy ).r * b.z;
#else
  return 0.5;
#endif
}

void main() {
  if ( uDebugMode == ${DEBUG_OUTLINE_ONLY} ) discard;

  vec3 N = normalize( vWorldNormal );
  vec3 V = normalize( cameraPosition - vWorldPos );

  gl_FragColor = vec4( xqGongbiShade(
    uRampRow, uRampSteps,
    uRimColour, uRim,
    uSilkTint, uSilkWash,
    xqTooth(), uGranulation,
    uVariation + vInstanceVariation, uGlow, uGlowColour, uNoSilk,
    N, V, vWorldPos, -vViewPos.z
  ), 1.0 );
}
`;

/**
 * The atlas surface fragment.
 *
 * One material for a whole figure. The class and pigment come from the
 * per-vertex code, and everything that was a uniform comes out of the parameter
 * table — including which of the six tooth grains this fragment wears, which is
 * why the tooth is an array texture rather than seven bound samplers.
 */
const GLSL_ATLAS_SURFACE_FRAG = /* glsl */ `
${GLSL_SURFACE_VARYINGS}

/**
 * What is still per-MATERIAL on the atlas path. Everything else — pigment,
 * class, rim, wash, granulation, tooth, outline profile — has moved to the
 * per-vertex code and the parameter table. These three stay because they are
 * per-UNIT, not per-vertex: one soldier's value nudge, one general's check
 * pulse.
 */
uniform float uVariation;
uniform float uGlow;
uniform float uNoSilk;

flat in float vMatCode;

void main() {
  if ( uDebugMode == ${DEBUG_OUTLINE_ONLY} ) discard;

  vec3 N = normalize( vWorldNormal );
  vec3 V = normalize( cameraPosition - vWorldPos );

  float rowV = xqAtlasRowV( vMatCode );
  vec4 p0 = xqAtlasParam( rowV, 0.0 );  // wake.rgb, rim
  vec4 p1 = xqAtlasParam( rowV, 1.0 );  // washTint.rgb, silkWash
  vec4 p3 = xqAtlasParam( rowV, 3.0 );  // granulation, toothScale, widthPx, steps
  vec4 p4 = xqAtlasParam( rowV, 4.0 );  // fadeStart, fadeEnd, toothLayer, classIdx

#ifdef USE_TOOTH
  float tooth = xqToothLayered( vObjPos, vObjNormal, p3.g, p4.b );
#else
  float tooth = 0.5;
#endif

  // The glow pigment is the row's own accent band rather than a uniform: the
  // check pulse should flare in the piece's own colour, and asking the ramp for
  // N·L = 1 is exactly "the brightest this pigment gets".
  vec3 glowColour = xqRampRow( rowV, 1.0 );

  gl_FragColor = vec4( xqGongbiShade(
    rowV, p3.a,
    p0.rgb, p0.a,
    p1.rgb, p1.a,
    tooth, p3.r,
    uVariation + vInstanceVariation, uGlow, glowColour, uNoSilk,
    N, V, vWorldPos, -vViewPos.z
  ), 1.0 );
}
`;

/**
 * Depth + normal prepass, GLSL ES 3.00 with two colour attachments.
 *   location 0 : RGBA16F — view-space normal in RGB, hull silhouette mask in A
 *   location 1 : R32F    — positive view depth in world units
 *
 * The mask in A is what the Sobel pass dilates to decide where to yield to the
 * hull. Putting it here rather than in a separate pass costs one channel of a
 * buffer we were writing anyway.
 */
const GLSL_PREPASS_VERT = /* glsl */ `
#include <skinning_pars_vertex>

varying vec3 vViewNormal;
varying float vViewDepth;

void main() {
  vec3 transformed = position;
  vec3 objectNormal = normal;

  ${GLSL_SKIN_BLOCK}
  ${GLSL_INSTANCE_BLOCK}

  vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
  vViewNormal = normalize( normalMatrix * objectNormal );
  vViewDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}
`;

/** Hull prepass: the same push as the colour hull, writing mask = 1. */
const GLSL_PREPASS_HULL_VERT = /* glsl */ `
#include <skinning_pars_vertex>

#ifdef USE_ATLAS_MATERIAL
  attribute float aMaterial;
#else
  uniform float uOutlineWidthPx;
#endif

uniform vec2 uViewportPx;
uniform float uMinStrokePx;

attribute vec3 aSmoothNormal;

varying vec3 vViewNormal;
varying float vViewDepth;

void main() {
  vec3 transformed = position;
  vec3 hullNormal = aSmoothNormal;

  #ifdef USE_SKINNING
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

  float depth = isOrthographic ? 1.0 : max( -mvPosition.z, 1e-4 );
  #ifdef USE_ATLAS_MATERIAL
    float authoredPx = xqAtlasParam( xqAtlasRowV( aMaterial ), 3.0 ).b;
  #else
    float authoredPx = uOutlineWidthPx;
  #endif
  float widthPx = max( authoredPx * uViewportPx.y / 1080.0, uMinStrokePx );
  float offset = 2.0 * widthPx * depth / ( projectionMatrix[1][1] * uViewportPx.y );
  mvPosition.xyz += viewNormal * offset;

  vViewNormal = viewNormal;
  vViewDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const GLSL_PREPASS_FRAG = /* glsl */ `
uniform float uHullMask;

varying vec3 vViewNormal;
varying float vViewDepth;

layout(location = 0) out vec4 gNormal;
layout(location = 1) out vec4 gDepth;

void main() {
  gNormal = vec4( normalize( vViewNormal ), uHullMask );
  gDepth = vec4( vViewDepth, 0.0, 0.0, 1.0 );
}
`;

// ===========================================================================
// Helpers
// ===========================================================================

function linearColour(hex: string): THREE.Color {
  const c = hexToRgb(hex);
  return new THREE.Color(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
}

function setLinear(target: THREE.Color, hex: string): void {
  const c = hexToRgb(hex);
  target.setRGB(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
}

function quantise(v: number, steps: number): number {
  return Math.round(v * steps) / steps;
}

export interface NormalisedRequest {
  cls: MaterialClass;
  pigment: PigmentName;
  variation: number;
  outline: OutlineProfileName;
  noSilk: boolean;
  glow: number;
  doubleSided: boolean;
  instanced: boolean;
}

function normalise(req: MaterialRequest): NormalisedRequest {
  const ext = req as GongbiMaterialRequest;
  const spec = RAMPS[req.cls];
  return {
    cls: req.cls,
    pigment: req.pigment,
    // Quantised so a continuously animated value cannot spawn a material per
    // frame. 1/64 of the variation range is far below the visible threshold.
    variation: quantise(Math.max(-1, Math.min(1, req.variation ?? 0)), VARIATION_STEPS),
    outline: req.outline ?? spec.outline,
    noSilk: req.noSilk === true,
    // Same reasoning, and see setGlow() for the smooth path the check pulse
    // and the impact flash actually use.
    glow: quantise(Math.max(0, Math.min(1, req.glow ?? 0)), GLOW_STEPS),
    doubleSided: ext.doubleSided === true,
    instanced: ext.instanced === true,
  };
}

/**
 * What is still per-MATERIAL on the atlas path. Class, pigment, outline profile
 * and every per-class parameter have moved into the per-vertex code and the
 * parameter table; what is left is genuinely per-unit.
 */
export interface AtlasRequest {
  /** Per-unit value nudge, so a rank of soldiers is not a xerox. */
  variation?: number;
  /** Emissive lift for the check pulse and the impact flash. */
  glow?: number;
  /** Opt out of the silk wash entirely. */
  noSilk?: boolean;
  doubleSided?: boolean;
  instanced?: boolean;
}

interface NormalisedAtlasRequest {
  variation: number;
  glow: number;
  noSilk: boolean;
  doubleSided: boolean;
  instanced: boolean;
}

function normaliseAtlas(req: AtlasRequest): NormalisedAtlasRequest {
  return {
    variation: quantise(Math.max(-1, Math.min(1, req.variation ?? 0)), VARIATION_STEPS),
    glow: quantise(Math.max(0, Math.min(1, req.glow ?? 0)), GLOW_STEPS),
    noSilk: req.noSilk === true,
    doubleSided: req.doubleSided === true,
    instanced: req.instanced === true,
  };
}

function atlasKey(n: NormalisedAtlasRequest, kind: string): string {
  return `${kind}|${n.variation}|${n.glow}|${n.noSilk ? 1 : 0}|${n.doubleSided ? 1 : 0}|${n.instanced ? 1 : 0}`;
}

function cacheKey(n: NormalisedRequest, kind: string): string {
  return `${kind}|${n.cls}|${n.pigment}|${n.variation}|${n.outline}|${n.noSilk ? 1 : 0}|${n.glow}|${n.doubleSided ? 1 : 0}|${n.instanced ? 1 : 0}`;
}

/** What kind of gongbi material this is, stashed on `Material.userData`. */
export interface GongbiUserData {
  gongbi: {
    kind: 'surface' | 'hull' | 'atlasSurface' | 'atlasHull';
    key: string;
    /** The request this material was built from, so outline.ts can ask for the
     *  matching hull without the caller having to keep the request around.
     *  Null on the atlas path, where class and pigment are per-vertex. */
    req: NormalisedRequest | null;
    /** The MRT twin used by the depth/normal prepass. */
    prepass: THREE.ShaderMaterial;
  };
}

export function gongbiInfo(m: THREE.Material | null | undefined): GongbiUserData['gongbi'] | null {
  if (!m) return null;
  const d = (m.userData as Partial<GongbiUserData>).gongbi;
  return d ?? null;
}

// ===========================================================================
// The library
// ===========================================================================

export interface GongbiOptions {
  /** Starting light mood. */
  mood?: LightMood['key'];
  /** Object-space tooth costs three texture fetches; off on the low tier. */
  tooth?: boolean;
  /** Shared texture library, so scene/ and render/ do not each build one. */
  textures?: TextureLibrary;
}

export class GongbiMaterialLibrary implements GongbiMaterials {
  readonly rampAtlas: THREE.DataTexture;
  /** Per-(class, pigment) lookup row for the atlas path. See ramps.ts. */
  readonly paramTable: THREE.DataTexture;
  readonly textures: TextureLibrary;

  /** Uniform objects shared BY REFERENCE across every material. */
  readonly shared: Record<string, THREE.IUniform>;

  private cache = new Map<string, THREE.ShaderMaterial>();
  private tooth: boolean;
  private csm: CascadedShadowMaps | null = null;

  private moodFrom: LightMood;
  private moodTo: LightMood;
  private moodT = 1;
  private moodDuration = 0;
  /** Once scene/lighting.ts speaks, the mood stops writing the light uniforms. */
  private externalLighting = false;

  private dpr = 1;

  /** Screen-aligned 罩染 wash parameters; see silk.ts. */
  readonly silk: SilkWash;

  /**
   * The stroke-width floor, shared by every hull material and by nothing else.
   *
   * Deliberately NOT in `shared`: that record is spread wholesale into every
   * surface material, and a uniform no surface shader declares is dead weight
   * uploaded per draw. selfcheck.ts fails on exactly that, which is how this
   * ended up scoped correctly rather than conveniently.
   */
  readonly strokeFloor: THREE.IUniform = { value: MIN_STROKE_CSS_PX };

  constructor(opts: GongbiOptions = {}) {
    this.rampAtlas = buildRampAtlas();
    this.paramTable = buildParamTable({
      granulation: (cls) => (opts.tooth === false ? 0 : GRANULATION[cls]),
      toothScale: (cls) => TOOTH_SCALE[cls],
      toothLayer: (cls) => toothLayerIndex(CLASS_TOOTH[cls]),
    });
    this.textures = opts.textures ?? new TextureLibrary();
    this.tooth = opts.tooth !== false;

    const mood = MOODS[opts.mood ?? 'wide'];
    this.moodFrom = mood;
    this.moodTo = mood;

    const silkUniforms = SilkWash.createUniforms();

    this.shared = {
      uRampAtlas: { value: this.rampAtlas },
      uViewportPx: { value: new THREE.Vector2(1920, 1080) },
      uViewToWorld: { value: new THREE.Matrix3() },
      uSilhouette: { value: 0 },
      uDebugMode: { value: DEBUG_NONE },

      uKeyDir: { value: new THREE.Vector3(0.45, 0.78, 0.44).normalize() },
      uKeyColour: { value: linearColour(mood.keyColour) },
      uKeyIntensity: { value: mood.keyIntensity },
      uFillColour: { value: linearColour(mood.fillColour) },
      uFillIntensity: { value: mood.fillIntensity },
      uBounceColour: { value: linearColour(mood.bounceColour) },
      uExposure: { value: 1 },
      uShadowDepth: { value: SHADOW_DEPTH },
      uNdlWrap: { value: NDL_WRAP },
      uSilkLitFloor: { value: SILK_LIT_FLOOR },
      uCsmBlend: { value: CASCADE_BLEND },

      uCsmMap0: { value: null },
      uCsmMap1: { value: null },
      uCsmMap2: { value: null },
      uCsmMatrix0: { value: new THREE.Matrix4() },
      uCsmMatrix1: { value: new THREE.Matrix4() },
      uCsmMatrix2: { value: new THREE.Matrix4() },
      uCsmSplit: { value: new THREE.Vector3(6, 14, 34) },
      uCsmTexelWorld: { value: new THREE.Vector3(0.01, 0.02, 0.05) },
      uCsmBias: { value: new THREE.Vector3(0.001, 0.001, 0.001) },
      uCsmTexel: { value: 1 / 2048 },
      uCsmCount: { value: 3 },
      uCsmEnabled: { value: 0 },

      ...silkUniforms,
    };

    this.silk = new SilkWash(silkUniforms);
  }

  // -- construction --------------------------------------------------------

  private surfaceUniforms(n: NormalisedRequest): Record<string, THREE.IUniform> {
    const spec = RAMPS[n.cls];
    const wake = wakeColour(n.cls, n.pigment);
    const wash = washColour(n.pigment);
    return {
      ...this.shared,
      uRampRow: { value: rampRowV(n.cls, n.pigment) },
      uRampSteps: { value: spec.steps },
      uRimColour: { value: new THREE.Color(wake.r, wake.g, wake.b) },
      uRim: { value: spec.rim },
      uGranulation: { value: this.tooth ? GRANULATION[n.cls] : 0 },
      uVariation: { value: n.variation },
      uGlow: { value: n.glow },
      uGlowColour: { value: linearColour(PIGMENTS[n.pigment].bands[3]) },
      uNoSilk: { value: n.noSilk ? 1 : 0 },
      uSilkWash: { value: spec.silkWash },
      uSilkTint: { value: new THREE.Color(wash.r, wash.g, wash.b) },
      uToothMap: { value: this.textures.get(CLASS_TOOTH[n.cls]) },
      uToothScale: { value: TOOTH_SCALE[n.cls] },
    };
  }

  private buildSurface(n: NormalisedRequest, key: string): THREE.ShaderMaterial {
    const uniforms = this.surfaceUniforms(n);

    const frag = [
      GLSL_MATH,
      GLSL_NOISE,
      GLSL_FRAME_PARS,
      GLSL_LIGHT_PARS,
      GLSL_CSM,
      GLSL_RAMP,
      GLSL_SILK,
      GLSL_SILK_UNIFORM,
      GLSL_SURFACE_SHADE,
      GLSL_SURFACE_PARS,
      GLSL_SURFACE_FRAG,
    ].join('\n');

    const defines: Record<string, string> = {};
    if (this.tooth) defines.USE_TOOTH = '1';
    if (n.instanced) defines.USE_INSTANCE_VARIATION = '1';

    const mat = new THREE.ShaderMaterial({
      name: key,
      uniforms,
      defines,
      vertexShader: GLSL_SURFACE_VERT,
      fragmentShader: frag,
      lights: false,
      fog: false,
      side: n.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });

    // The prepass twin is SHARED across every surface material of the same
    // sidedness. Its shader has no per-material inputs at all — it writes the
    // skinned view normal and the view depth and nothing else — so giving every
    // material its own copy would mean a hundred identical objects, a hundred
    // redundant uniform uploads per frame, and a hundred draw-call state
    // changes for a buffer that does not care which pigment it came from.
    (mat.userData as GongbiUserData).gongbi = {
      kind: 'surface',
      key,
      req: n,
      prepass: this.surfacePrepass(n.doubleSided),
    };
    return mat;
  }

  private prepassCache = new Map<string, THREE.ShaderMaterial>();

  private surfacePrepass(doubleSided: boolean): THREE.ShaderMaterial {
    const key = doubleSided ? 'prepass.surface.double' : 'prepass.surface.front';
    let m = this.prepassCache.get(key);
    if (!m) {
      m = this.buildPrepass(GLSL_PREPASS_VERT, 0, {}, key);
      m.side = doubleSided ? THREE.DoubleSide : THREE.FrontSide;
      this.prepassCache.set(key, m);
    }
    return m;
  }

  /**
   * Hull prepass twins are shared per outline PROFILE, because the only thing
   * that varies between them is the stroke width — and getting that wrong by
   * even a fraction would put the Sobel's suppression mask off the line it is
   * suppressing against.
   */
  private hullPrepass(profileName: OutlineProfileName, widthUniform: THREE.IUniform): THREE.ShaderMaterial {
    const key = `prepass.hull.${profileName}`;
    let m = this.prepassCache.get(key);
    if (!m) {
      // Only the width: the prepass hull writes a mask and a depth, and has no
      // use for the stroke's colour, tint or fade. Carrying them would be three
      // uniforms uploaded per draw that no shader stage declares.
      m = this.buildPrepass(GLSL_PREPASS_HULL_VERT, 1, {}, key, {
        uViewportPx: this.shared.uViewportPx,
        uMinStrokePx: this.strokeFloor,
        uOutlineWidthPx: widthUniform,
      });
      m.side = THREE.BackSide;
      this.prepassCache.set(key, m);
    }
    return m;
  }

  private buildHull(n: NormalisedRequest, key: string): THREE.ShaderMaterial | null {
    if (n.outline === 'none') return null;
    const profile = OUTLINES[n.outline];
    if (profile.widthPx <= 0) return null;

    const spec = RAMPS[n.cls];
    const uniforms: Record<string, THREE.IUniform> = {
      uViewportPx: this.shared.uViewportPx,
      uMinStrokePx: this.strokeFloor,
      uSilhouette: this.shared.uSilhouette,
      uRampAtlas: this.shared.uRampAtlas,
      uRampRow: { value: rampRowV(n.cls, n.pigment) },
      uRampSteps: { value: spec.steps },
      uOutlineWidthPx: { value: profile.widthPx },
      uOutlineColour: { value: linearColour(PIGMENTS[profile.colour].bands[profile.colourBand]) },
      uOutlineTint: { value: profile.tint },
      uOutlineFade: { value: new THREE.Vector2(profile.fadeStart, profile.fadeEnd) },
    };

    const frag = [GLSL_MATH, GLSL_RAMP, `uniform float uSilhouette;`, GLSL_OUTLINE_FRAG].join('\n');

    const mat = new THREE.ShaderMaterial({
      name: key,
      uniforms,
      vertexShader: GLSL_OUTLINE_VERT,
      fragmentShader: frag,
      lights: false,
      fog: false,
      // The hull is the mesh grown outward with its front faces removed, so
      // what is left visible is the inside of the far shell — a ring exactly
      // `widthPx` wide around the silhouette.
      side: THREE.BackSide,
    });

    (mat.userData as GongbiUserData).gongbi = {
      kind: 'hull',
      key,
      req: n,
      prepass: this.hullPrepass(n.outline, uniforms.uOutlineWidthPx),
    };
    return mat;
  }

  // -- the atlas (per-vertex class + pigment) path --------------------------

  /**
   * One material for a whole figure.
   *
   * The per-uniform path above is the simpler default and stays the right
   * choice for scene/ and ui/, where an object legitimately is one pigment.
   * This path exists for characters/, where it is not: a figure uses eight to
   * thirteen (class, pigment) pairs, and one material per pair put a 32-unit
   * board at 475 meshes and 950 draw calls against a budget of 260.
   *
   * Requirements on the caller:
   *   - every geometry drawn with it MUST carry the `aMaterial` attribute
   *     (`hasAtlasAttribute()` checks); without it the attribute reads as zero
   *     and the whole figure comes out as lacquered azurite;
   *   - the geometries of one figure should be merged into one, which is what
   *     `collapseToAtlas()` in outline.ts does to an already-built unit.
   *
   * `variation` and `glow` remain per-material because they are per-UNIT, not
   * per-vertex. That costs one material object per distinct value but not one
   * draw call — a draw call is per mesh, and all of these share one program.
   */
  getAtlas(req: AtlasRequest = {}): THREE.ShaderMaterial {
    const n = normaliseAtlas(req);
    const key = atlasKey(n, 'as');
    let m = this.cache.get(key);
    if (m) return m;

    const uniforms: Record<string, THREE.IUniform> = {
      ...this.shared,
      uParamTable: { value: this.paramTable },
      uToothArray: { value: this.textures.toothArray() },
      uVariation: { value: n.variation },
      uGlow: { value: n.glow },
      uNoSilk: { value: n.noSilk ? 1 : 0 },
    };

    const frag = [
      GLSL_MATH,
      GLSL_NOISE,
      GLSL_FRAME_PARS,
      GLSL_LIGHT_PARS,
      GLSL_CSM,
      GLSL_RAMP_CORE,
      GLSL_ATLAS_DECODE,
      GLSL_TOOTH_ARRAY,
      GLSL_SILK,
      GLSL_SURFACE_SHADE,
      GLSL_ATLAS_SURFACE_FRAG,
    ].join('\n');

    const defines: Record<string, string> = { USE_ATLAS_MATERIAL: '1' };
    if (this.tooth) defines.USE_TOOTH = '1';
    if (n.instanced) defines.USE_INSTANCE_VARIATION = '1';

    m = new THREE.ShaderMaterial({
      name: key,
      uniforms,
      defines,
      vertexShader: GLSL_SURFACE_VERT,
      fragmentShader: frag,
      lights: false,
      fog: false,
      side: n.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });
    (m.userData as GongbiUserData).gongbi = {
      kind: 'atlasSurface',
      key,
      req: null,
      prepass: this.surfacePrepass(n.doubleSided),
    };
    this.cache.set(key, m);
    return m;
  }

  /**
   * The hull twin of `getAtlas()`. The outline PROFILE is per-vertex here too —
   * stroke width, pigment, tint and distance fade all come out of the parameter
   * table row the vertex code selects — so one hull draws deep-ink contour on
   * cloth and 泥金 structural line on plate in the same pass.
   *
   * There is exactly one of these per (doubleSided is irrelevant — a hull is
   * always BackSide), so the whole cast's line work is one material.
   */
  outlineAtlas(req: AtlasRequest = {}): THREE.ShaderMaterial {
    const n = normaliseAtlas(req);
    const key = atlasKey(n, 'ah');
    let m = this.cache.get(key);
    if (m) return m;

    const uniforms: Record<string, THREE.IUniform> = {
      uViewportPx: this.shared.uViewportPx,
      uMinStrokePx: this.strokeFloor,
      uSilhouette: this.shared.uSilhouette,
      uRampAtlas: this.shared.uRampAtlas,
      uParamTable: { value: this.paramTable },
    };

    const vert = [GLSL_ATLAS_DECODE, GLSL_OUTLINE_VERT].join('\n');
    const frag = [
      GLSL_MATH,
      GLSL_RAMP_CORE,
      GLSL_ATLAS_DECODE,
      'uniform float uSilhouette;',
      GLSL_ATLAS_OUTLINE_FRAG,
    ].join('\n');

    m = new THREE.ShaderMaterial({
      name: key,
      uniforms,
      defines: { USE_ATLAS_MATERIAL: '1' },
      vertexShader: vert,
      fragmentShader: frag,
      lights: false,
      fog: false,
      side: THREE.BackSide,
    });
    (m.userData as GongbiUserData).gongbi = {
      kind: 'atlasHull',
      key,
      req: null,
      prepass: this.atlasHullPrepass(),
    };
    this.cache.set(key, m);
    return m;
  }

  /**
   * The atlas hull's MRT twin. Its width must come from the same parameter
   * table read as the colour hull's, or the Sobel's suppression mask would sit
   * a fraction of a pixel off the line it exists to suppress.
   */
  private atlasHullPrepass(): THREE.ShaderMaterial {
    const key = 'prepass.hull.atlas';
    let m = this.prepassCache.get(key);
    if (!m) {
      m = new THREE.ShaderMaterial({
        name: key,
        uniforms: {
          uHullMask: { value: 1 },
          uViewportPx: this.shared.uViewportPx,
          uMinStrokePx: this.strokeFloor,
          uParamTable: { value: this.paramTable },
        },
        defines: { USE_ATLAS_MATERIAL: '1' },
        vertexShader: [GLSL_ATLAS_DECODE, GLSL_PREPASS_HULL_VERT].join('\n'),
        fragmentShader: GLSL_PREPASS_FRAG,
        glslVersion: THREE.GLSL3,
        lights: false,
        fog: false,
        side: THREE.BackSide,
      });
      this.prepassCache.set(key, m);
    }
    return m;
  }

  private buildPrepass(
    vert: string,
    hullMask: number,
    defines: Record<string, string>,
    name: string,
    extra: Record<string, THREE.IUniform> = {},
  ): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      name,
      uniforms: { uHullMask: { value: hullMask }, ...extra },
      defines: { ...defines },
      vertexShader: vert,
      fragmentShader: GLSL_PREPASS_FRAG,
      glslVersion: THREE.GLSL3,
      lights: false,
      fog: false,
    });
  }

  // -- GongbiMaterials -----------------------------------------------------

  get(req: MaterialRequest): THREE.Material {
    const n = normalise(req);
    const key = cacheKey(n, 's');
    let m = this.cache.get(key);
    if (!m) {
      m = this.buildSurface(n, key);
      this.cache.set(key, m);
    }
    return m;
  }

  outline(req: MaterialRequest): THREE.Material | null {
    const n = normalise(req);
    if (n.outline === 'none') return null;
    const key = cacheKey(n, 'h');
    let m = this.cache.get(key);
    if (!m) {
      const built = this.buildHull(n, key);
      if (!built) return null;
      m = built;
      this.cache.set(key, m);
    }
    return m;
  }

  /**
   * The MRT twin of a material, or null if this is not one of ours. Foreign
   * materials (a plain MeshBasicMaterial from another subsystem) fall back to
   * the shared generic prepass so they still contribute depth and normals —
   * otherwise the Sobel would draw interior lines straight across them.
   */
  prepassFor(m: THREE.Material | null | undefined): THREE.Material | null {
    const info = gongbiInfo(m);
    if (info) return info.prepass;
    return this.genericPrepass;
  }

  get genericPrepass(): THREE.ShaderMaterial {
    // Double-sided, because we know nothing about a foreign mesh's winding and
    // a missing back face would punch a hole in the depth buffer that the Sobel
    // would read as a silhouette.
    return this.surfacePrepass(true);
  }

  setSilhouetteMode(on: boolean): void {
    this.shared.uSilhouette.value = on ? 1 : 0;
  }

  setMood(key: LightMood['key'], seconds: number): void {
    const target = MOODS[key];
    if (target === this.moodTo && this.moodT >= 1) return;
    this.moodFrom = this.currentMood();
    this.moodTo = target;
    this.moodDuration = Math.max(0, seconds);
    this.moodT = this.moodDuration > 0 ? 0 : 1;
  }

  /** The interpolated mood, for the composer's grade and for the CSM stretch. */
  currentMood(): LightMood {
    if (this.moodT >= 1) return this.moodTo;
    const t = this.moodT;
    const a = this.moodFrom;
    const b = this.moodTo;
    const L = (x: number, y: number) => x + (y - x) * t;
    return {
      key: b.key,
      keyColour: b.keyColour,
      fillColour: b.fillColour,
      bounceColour: b.bounceColour,
      keyIntensity: L(a.keyIntensity, b.keyIntensity),
      fillIntensity: L(a.fillIntensity, b.fillIntensity),
      keyElevation: L(a.keyElevation, b.keyElevation),
      keyAzimuth: L(a.keyAzimuth, b.keyAzimuth),
      shadowStretch: L(a.shadowStretch, b.shadowStretch),
      gradeTint: b.gradeTint,
      gradeAmount: L(a.gradeAmount, b.gradeAmount),
    };
  }

  /** Blend factor 0..1 through the current mood transition, for the composer. */
  get moodBlend(): number {
    return this.moodT;
  }
  get moodSource(): LightMood {
    return this.moodFrom;
  }
  get moodTarget(): LightMood {
    return this.moodTo;
  }

  update(dt: number, camera: THREE.Camera, size: { w: number; h: number; dpr: number }): void {
    if (this.moodT < 1) {
      this.moodT = this.moodDuration > 0 ? Math.min(1, this.moodT + dt / this.moodDuration) : 1;
    }

    this.dpr = size.dpr;
    const vp = this.shared.uViewportPx.value as THREE.Vector2;
    vp.set(size.w, size.h);

    // Screen-aligned patterns are authored in CSS pixels and converted here, so
    // they keep a constant physical size when the governor moves the ratio.
    this.silk.update(size.dpr);
    // The stroke floor is a physical width on the display, so it converts with
    // the pixel ratio exactly as the silk weave and the paper grain do.
    this.strokeFloor.value = MIN_STROKE_CSS_PX * size.dpr;

    camera.updateMatrixWorld();
    (this.shared.uViewToWorld.value as THREE.Matrix3).setFromMatrix4(camera.matrixWorld);

    if (!this.externalLighting) {
      const mood = this.currentMood();
      this.applyMoodLighting(mood);
    }
    // NOTE: the shadow uniforms are deliberately NOT pushed here. See
    // syncShadows().
  }

  private applyMoodLighting(mood: LightMood): void {
    const ce = Math.cos(mood.keyElevation);
    (this.shared.uKeyDir.value as THREE.Vector3)
      .set(Math.sin(mood.keyAzimuth) * ce, Math.sin(mood.keyElevation), Math.cos(mood.keyAzimuth) * ce)
      .normalize();
    setLinear(this.shared.uKeyColour.value as THREE.Color, mood.keyColour);
    setLinear(this.shared.uFillColour.value as THREE.Color, mood.fillColour);
    setLinear(this.shared.uBounceColour.value as THREE.Color, mood.bounceColour);
    this.shared.uKeyIntensity.value = mood.keyIntensity;
    this.shared.uFillIntensity.value = mood.fillIntensity;
  }

  // -- scene/lighting.ts facing --------------------------------------------

  /**
   * The uniform-feeding API `scene/lighting.ts` owns.
   *
   * Calling this ONCE hands the light uniforms to scene/ permanently: the mood
   * cross-fade will keep driving the grade, the shadow stretch and the camera
   * work, but it will stop writing the key/fill/bounce. Two owners writing the
   * same uniform every frame is a bug that looks like a flicker and takes a day
   * to find, so ownership transfers exactly once and never transfers back.
   */
  setLighting(l: GongbiLighting): void {
    this.externalLighting = true;
    const d = this.shared.uKeyDir.value as THREE.Vector3;
    d.set(l.keyDirection.x, l.keyDirection.y, l.keyDirection.z);
    if (d.lengthSq() < 1e-8) d.set(0, 1, 0);
    d.normalize();
    setLinear(this.shared.uKeyColour.value as THREE.Color, l.keyColour);
    setLinear(this.shared.uFillColour.value as THREE.Color, l.fillColour);
    setLinear(this.shared.uBounceColour.value as THREE.Color, l.bounceColour);
    this.shared.uKeyIntensity.value = l.keyIntensity;
    this.shared.uFillIntensity.value = l.fillIntensity;
    this.shared.uExposure.value = l.exposure ?? 1;
    if (this.csm) this.csm.setDirection(d.x, d.y, d.z);
  }

  /**
   * The `LightConsumer` shape `scene/lighting.ts` pushes at its consumers every
   * frame. Structural, not imported: render must not depend on scene.
   *
   * The colours arrive as THREE.Color already in the renderer's linear working
   * space (the rig builds them with `setStyle(hex, SRGBColorSpace)`, which
   * converts on the way in), so they are copied straight across with no second
   * transfer applied. Applying one would darken every light in the build by the
   * sRGB curve and the bug would look like "the renderer is too dark", which is
   * the vaguest possible symptom.
   */
  setLight(spec: {
    dir: THREE.Vector3;
    keyColour: THREE.Color;
    fillColour: THREE.Color;
    keyIntensity: number;
    fillIntensity: number;
    bounceColour?: THREE.Color;
    gradeTint?: THREE.Color;
    gradeAmount?: number;
  }): void {
    this.externalLighting = true;
    const d = this.shared.uKeyDir.value as THREE.Vector3;
    d.copy(spec.dir);
    if (d.lengthSq() < 1e-8) d.set(0, 1, 0);
    d.normalize();
    (this.shared.uKeyColour.value as THREE.Color).copy(spec.keyColour);
    (this.shared.uFillColour.value as THREE.Color).copy(spec.fillColour);
    if (spec.bounceColour) (this.shared.uBounceColour.value as THREE.Color).copy(spec.bounceColour);
    this.shared.uKeyIntensity.value = spec.keyIntensity;
    this.shared.uFillIntensity.value = spec.fillIntensity;
    if (this.csm) this.csm.setDirection(d.x, d.y, d.z);
  }

  /** True once scene/ has taken ownership of the light uniforms. */
  get lightingIsExternal(): boolean {
    return this.externalLighting;
  }

  /** Read-only view of the key direction, for scene/ to place its own light. */
  get keyDirection(): THREE.Vector3 {
    return this.shared.uKeyDir.value as THREE.Vector3;
  }

  // -- pipeline facing ------------------------------------------------------

  attachShadows(csm: CascadedShadowMaps): void {
    this.csm = csm;
    this.shared.uCsmEnabled.value = 1;
  }

  setShadowsEnabled(on: boolean): void {
    this.shared.uCsmEnabled.value = on && this.csm ? 1 : 0;
  }

  /**
   * Copy the cascade matrices, splits, texel sizes and biases into the shared
   * uniforms.
   *
   * This MUST be called after `CascadedShadowMaps.render()` and before the main
   * pass, never from `update()`. The cascades are refitted to the camera inside
   * `render()`, so pushing from `update()` — which runs first — would hand the
   * surface shader the PREVIOUS frame's light matrices. The symptom is shadows
   * that lag the camera by one frame: invisible when still, and a distinct
   * swimming of every shadow edge whenever the camera moves, which is exactly
   * the artefact the texel snapping in csm.ts exists to prevent. The pipeline
   * calls this in the right place; anyone driving the library by hand must too.
   */
  syncShadows(): void {
    if (this.csm) this.pushCsm(this.csm);
  }

  private pushCsm(csm: CascadedShadowMaps): void {
    const s = this.shared;
    s.uCsmMap0.value = csm.cascades[0].target.texture;
    s.uCsmMap1.value = csm.cascades[1].target.texture;
    s.uCsmMap2.value = csm.cascades[2].target.texture;
    (s.uCsmMatrix0.value as THREE.Matrix4).copy(csm.cascades[0].matrix);
    (s.uCsmMatrix1.value as THREE.Matrix4).copy(csm.cascades[1].matrix);
    (s.uCsmMatrix2.value as THREE.Matrix4).copy(csm.cascades[2].matrix);
    (s.uCsmSplit.value as THREE.Vector3).set(
      csm.cascades[0].far,
      csm.cascades[1].far,
      csm.cascades[2].far,
    );
    (s.uCsmTexelWorld.value as THREE.Vector3).set(
      csm.cascades[0].texelWorld,
      csm.cascades[1].texelWorld,
      csm.cascades[2].texelWorld,
    );
    (s.uCsmBias.value as THREE.Vector3).set(
      csm.cascades[0].bias,
      csm.cascades[1].bias,
      csm.cascades[2].bias,
    );
    s.uCsmTexel.value = csm.texelStep;
    s.uCsmCount.value = csm.count;
  }

  setDebug(mode: number): void {
    this.shared.uDebugMode.value = mode;
  }

  setQuality(q: QualitySettings): void {
    this.silk.setEnabled(q.silkWash);
  }

  /**
   * Smooth glow for the check pulse and the impact flash.
   *
   * `MaterialRequest.glow` is quantised into the cache key so an animated value
   * cannot spawn a material per frame; this is the path an animated value is
   * meant to take instead. Ask for the material once with the glow you want at
   * its peak, then drive it here.
   */
  setGlow(material: THREE.Material, v: number): void {
    const m = material as THREE.ShaderMaterial;
    if (m.uniforms && m.uniforms.uGlow) m.uniforms.uGlow.value = Math.max(0, v);
  }

  /**
   * Build the per-instance variation attribute for an InstancedMesh.
   *
   * Deterministic from `tag`, so a rank of soldiers gets the same eight nudges
   * every run — which is what makes a captured frame a measurement rather than
   * a sample. Request the material with `instanced: true` to compile the path
   * that reads it.
   */
  static instanceAttribute(count: number, tag: string, spread = 1): THREE.InstancedBufferAttribute {
    const rng = seedFor('render', 'instanceVariation', tag);
    const data = new Float32Array(count);
    for (let i = 0; i < count; i++) data[i] = rng.gauss() * 0.42 * spread;
    return new THREE.InstancedBufferAttribute(data, 1);
  }

  /** Every material this library has handed out, for the pipeline's bookkeeping. */
  get materialCount(): number {
    return this.cache.size;
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
    for (const m of this.prepassCache.values()) m.dispose();
    this.prepassCache.clear();
    this.rampAtlas.dispose();
    this.paramTable.dispose();
    this.textures.dispose();
  }
}
