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
 *
 * ---------------------------------------------------------------------------
 * HOW main.ts DRIVES THIS
 * ---------------------------------------------------------------------------
 *
 *   const pipeline = createRenderPipeline(renderer, {
 *     width: window.innerWidth,
 *     height: window.innerHeight,
 *     dpr: Math.min(window.devicePixelRatio || 1, 2),
 *     quality: QualityGovernor.probe(renderer.getContext()),
 *     mood: 'wide',
 *   });
 *
 * Then, once:
 *   renderer.shadowMap.enabled = false;   // the CSM here replaces it entirely
 *   renderer.toneMapping = THREE.NoToneMapping;
 *   // outputColorSpace is irrelevant: the grade pass encodes sRGB itself.
 *
 * Hand `pipeline.materials` to characters/, scene/ and ui/ at construction —
 * it satisfies `GongbiMaterials` — and after building any figure or prop, call
 * `attachOutlines(root, pipeline.materials)` once to give it its line work.
 *
 * Register the pipeline with scene/lighting.ts so the rig owns the light:
 *   const lighting = new LightingRig({ consumers: [pipeline], materials: pipeline.materials });
 *   pipeline.setShadowSpec(lighting.csmSpec());   // whenever the mood changes
 *
 * Per frame, exactly one call:
 *   pipeline.render(scene, camera, dt);
 *
 * That call does everything: it pushes the per-frame uniforms (so do NOT also
 * call `materials.update()` — the mood cross-fade integrates dt and would
 * advance twice), renders the cascades, the prepass, the main pass and the two
 * post passes, and presents to the canvas. `renderer.render()` must not be
 * called anywhere else in the frame.
 *
 * On resize:  pipeline.setSize(cssWidth, cssHeight, dpr)
 * On a tier change from the governor:  pipeline.applyQualitySettings(settings)
 * On bus 'fx:flash':  pipeline.flash(strength, colour)   — decays on its own
 * On a phase change:  pipeline.setMood(key, seconds)
 *
 * ---------------------------------------------------------------------------
 * THE ATLAS PATH — one draw call per figure
 * ---------------------------------------------------------------------------
 *
 * A figure uses 8–13 (MaterialClass, PigmentName) pairs, and one material per
 * pair put a measured 32-unit board at 331 meshes and 2319 draw calls against a
 * budget of 260. `characters/factory.ts` stamps a per-vertex `aMaterial` code
 * on every merged geometry; `getAtlas()`/`outlineAtlas()` read it and resolve
 * class, pigment, rim, wash, granulation, tooth grain and the whole outline
 * profile per fragment instead of per material.
 *
 * After building a unit:
 *
 *     const collapses = collapseToAtlas(unit.root, pipeline.materials, {
 *       variation: unit.meta.variation,
 *     });
 *     // ... and on teardown, alongside unit.dispose():
 *     disposeCollapse(collapses);
 *
 * That is instead of `attachOutlines` for that unit — the collapse builds the
 * atlas hull itself. Measured on the real cast: 32 meshes + 32 hulls, 226 draw
 * calls, one material for the entire board.
 *
 * Pass `bakeInstancesBelow: 64` to the character factory as well. Instancing
 * saves vertex memory, not triangles, and below that size an InstancedMesh
 * costs a draw call the collapse could have absorbed — measured, it is the
 * difference between 100 and 32 meshes.
 * For the harness:    pipeline.setSilhouetteMode(on), pipeline.setDebug(flag, on)
 *
 * The harness's `setDebug` accepts the five flags render owns — 'rampBands',
 * 'outlineOnly', 'sobelOnly', 'normals', 'shadowCascades' — and ignores the
 * rest, so main.ts can forward every flag to every subsystem without filtering.
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
  type AtlasRequest,
  type GongbiOptions,
  type GongbiUserData,
  type NormalisedRequest,
} from './gongbi.ts';

export {
  collapseToAtlas,
  disposeCollapse,
  hasAtlasAttribute,
  type AtlasCollapse,
  type CollapseOptions,
} from './atlas.ts';

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
  ATLAS_CODE_STRIDE,
  PARAM_WIDTH,
  buildParamTable,
  codeFor,
  rowForCode,
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
  TOOTH_ARRAY_SIZE,
  TOOTH_LAYERS,
  toothLayerIndex,
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
