/**
 * The render subsystem's public surface.
 *
 * Everything another subsystem needs is here. Nothing outside `src/render/`
 * should import a file from inside it — the internals move around as the look
 * is tuned, and this barrel is the promise that does not.
 *
 * WHO USES WHAT
 *   characters/ — `GongbiMaterials.get()` for surfaces, `attachOutlines()` for
 *                 line work. It receives the materials object by injection and
 *                 never constructs one.
 *   scene/      — the same, plus `GongbiMaterialLibrary.setLighting()` from
 *                 lighting.ts, which render/ deliberately does not own.
 *   ui/         — `GongbiMaterials.get()` with `noSilk: true` for HUD elements
 *                 painted into the scene.
 *   perf/       — `RenderPipeline.setQuality()` / `applyQualitySettings()`.
 *   game/       — `createRenderPipeline()` and the frame call.
 */

export {
  createRenderPipeline,
  GongbiPipeline,
  type RenderPipelineOptions,
} from './composer.ts';

export {
  GongbiMaterialLibrary,
  gongbiInfo,
  DEBUG_NONE,
  DEBUG_RAMP_BANDS,
  DEBUG_OUTLINE_ONLY,
  DEBUG_SOBEL_ONLY,
  DEBUG_NORMALS,
  DEBUG_SHADOW_CASCADES,
  type GongbiLighting,
  type GongbiMaterialRequest,
  type GongbiOptions,
  type GongbiUserData,
  type NormalisedRequest,
} from './gongbi.ts';

export {
  attachOutlines,
  buildHull,
  ensureSmoothNormals,
  hullSuppressRadiusPx,
  isHull,
  removeOutlines,
  HULL_FLAG,
  SMOOTH_NORMAL_ATTRIBUTE,
} from './outline.ts';

export {
  CascadedShadowMaps,
  CASCADE_BLEND,
  CASCADE_SPLITS,
  type Cascade,
  type CascadedShadowOptions,
} from './csm.ts';

export {
  bakeRampRow,
  bandHexes,
  buildRampAtlas,
  buildRampRow,
  buildRampTexture,
  rampRowIndex,
  rampRowV,
  wakeColour,
  washColour,
  MATERIAL_CLASSES,
  RAMP_ROWS,
  RAMP_WIDTH,
} from './ramps.ts';

export {
  generateField,
  textureSize,
  TextureLibrary,
  CLASS_TOOTH,
  TEXTURE_KINDS,
  TOOTH_ANISOTROPY,
  type TextureKind,
} from './textures.ts';

export {
  SilkWash,
  CUN_ANGLE,
  CUN_SCALE_CSS_PX,
  NYQUIST_FLOOR_PX,
  SILK_GAIN,
  SILK_PERIOD_CSS_PX,
  type SilkUniforms,
} from './silk.ts';

// Shader sources, exported so the self-check and any future hot-reload tooling
// can inspect exactly what the GPU is being handed.
export { GLSL_HASH, GLSL_NOISE } from './shaders/noise.glsl.ts';
export { GLSL_CSM, GLSL_MATH } from './shaders/lib.glsl.ts';
export { GLSL_RAMP, GLSL_RAMP_PARS } from './shaders/ramp.glsl.ts';
export { GLSL_SILK, GLSL_SILK_PARS } from './shaders/silk.glsl.ts';
export {
  GLSL_OUTLINE_FRAG,
  GLSL_OUTLINE_PARS,
  GLSL_OUTLINE_VERT,
} from './shaders/outline.glsl.ts';
export {
  GLSL_FULLSCREEN_VERT,
  GLSL_SOBEL_FRAG,
  GLSL_SOBEL_PARS,
} from './shaders/sobel.glsl.ts';
export { GLSL_GRADE_FRAG, GLSL_GRADE_PARS } from './shaders/grade.glsl.ts';
