/**
 * The render pipeline: MRT prepass, cascaded shadows, main pass, two post
 * passes. Implements `RenderPipeline` from core/contracts.ts.
 *
 * PASS ORDER — fixed by ARCHITECTURE.md, not negotiable here:
 *
 *   1. depth + normal prepass -> MRT (RGBA16F normal + hull mask, R32F depth)
 *   2. main pass
 *        a. inverted-hull outlines (BackSide, pushed along smoothed normals)
 *        b. surface pass (quantised ramp, silk wash in shadow)
 *   3. post
 *        a. Sobel over prepass normals/depth -> interior lines only, masked
 *           against the hull silhouette
 *        b. impact flash / bloomless highlight lift
 *        c. mood grade toward the current LightMood
 *        d. paper grain, last, at native resolution
 *
 * 3b/3c/3d are all pointwise operations on the same pixel, so they are one
 * shader rather than three passes. Splitting them would cost two full-screen
 * round trips at retina for no expressive gain. The ORDER inside that shader is
 * the order above and it matters — see shaders/grade.glsl.ts.
 *
 * WHY THERE IS NO EffectComposer HERE
 * three's addon composer is a ping-pong of single-texture passes. This pipeline
 * needs multiple render targets, a material swap between the prepass and the
 * main pass, a pass that samples three textures at once, and precise control of
 * what gets cleared to what. Every one of those is a fight with the addon's
 * assumptions, and what is left after winning the fight is the eighty lines
 * below. `RenderPipeline.composer` still exposes the `{ render(dt) }` shape the
 * contract asks for, so nothing downstream can tell the difference.
 *
 * PER-FRAME ALLOCATION: none. The scene traversal fills instance-level arrays
 * with `length = 0` and push, which reaches a steady size within a few frames
 * and never allocates again.
 */

import * as THREE from 'three';
import type {
  QualitySettings,
  QualityTier,
  RenderPipeline,
} from '@core/contracts.ts';
import type { DebugFlag } from '@core/testapi.ts';
import {
  OUTLINES,
  PIGMENTS,
  hexToRgb,
  srgbToLinear,
  type LightMood,
} from '@core/palette.ts';
import { CascadedShadowMaps } from './csm.ts';
import {
  DEBUG_NONE,
  DEBUG_NORMALS,
  DEBUG_OUTLINE_ONLY,
  DEBUG_RAMP_BANDS,
  DEBUG_SHADOW_CASCADES,
  DEBUG_SOBEL_ONLY,
  GongbiMaterialLibrary,
  gongbiInfo,
} from './gongbi.ts';
import { hullSuppressRadiusPx, isHull } from './outline.ts';
import { TextureLibrary } from './textures.ts';
import { GLSL_MATH } from './shaders/lib.glsl.ts';
import { GLSL_NOISE } from './shaders/noise.glsl.ts';
import { GLSL_FULLSCREEN_VERT, GLSL_SOBEL_FRAG } from './shaders/sobel.glsl.ts';
import { GLSL_GRADE_FRAG } from './shaders/grade.glsl.ts';

// ===========================================================================
// TUNING BLOCK
// ===========================================================================

/**
 * Sobel magnitude on view normals, mapped to line opacity.
 *
 * Arithmetic behind the numbers: a Sobel kernel across a step of magnitude d in
 * one component produces 4d. A crease of angle θ changes the unit normal by
 * |Δn| = 2·sin(θ/2), so the combined gradient magnitude is about 8·sin(θ/2).
 * The pair below therefore starts drawing at roughly 5.4° of crease and reaches
 * full strength at about 15°. Below 5° is tessellation noise on a curved
 * surface; above 15° is a genuine plate edge.
 */
const NORMAL_EDGE_LO = 0.75;
const NORMAL_EDGE_HI = 2.10;

/** Overall interior-line opacity. Interior lines are lighter than contours. */
const LINE_STRENGTH = 0.85;

/**
 * Gain on the normalised depth gradient used to suppress the Sobel at
 * silhouettes and overlaps.
 *
 * Sanity check at the resting framing (38° fov, 1080 CSS px tall, a figure at
 * 8 world units): one pixel covers about 0.0026 world units, so a 45° surface
 * changes depth by ~0.005 across the Roberts cross, giving a normalised
 * gradient of 0.0013. Times 40 that is a 5% suppression — nothing. An arm
 * crossing a chest 0.2 units in front of it gives 0.05, times 40 is 2.0, fully
 * suppressed. The gap between "surface" and "overlap" is three orders of
 * magnitude wide, which is why one constant covers the whole frame.
 */
const DEPTH_SUPPRESS = 40.0;

/** Paper grain. Cell size in DEVICE pixels, and strength. */
const GRAIN_PERIOD_PX = 1.6;
const GRAIN_AMOUNT = 0.055;

/** Edge darkening. See the note in grade.glsl.ts — this is mounting silk. */
const VIGNETTE = 0.10;

/** Impact-flash decay, per second, exponential. 4.2 is about a quarter second. */
const FLASH_DECAY = 4.2;

/**
 * Render-side view of the quality tiers.
 *
 * This deliberately MIRRORS `perf/governor.ts`'s QUALITY table rather than
 * importing it: the module graph in ARCHITECTURE.md has perf depending on
 * render, not the other way round, and inverting that edge to save eight lines
 * would be a bad trade. `applyQualitySettings()` is the authoritative path —
 * game/ passes the governor's real settings object through it — and this table
 * only serves `setQuality(tier)`, which the contract requires to work on its
 * own. If the two ever disagree, the governor wins.
 */
const RENDER_QUALITY: Record<QualityTier, QualitySettings> = {
  ultra: { tier: 'ultra', shadowMapSize: 2048, cascades: 3, sobel: true, silkWash: true, outlines: true, msaa: 4, maxPixelRatio: 2.0, particleBudget: 2600 },
  high: { tier: 'high', shadowMapSize: 2048, cascades: 3, sobel: true, silkWash: true, outlines: true, msaa: 2, maxPixelRatio: 1.75, particleBudget: 1800 },
  medium: { tier: 'medium', shadowMapSize: 1024, cascades: 2, sobel: true, silkWash: true, outlines: true, msaa: 0, maxPixelRatio: 1.4, particleBudget: 1100 },
  low: { tier: 'low', shadowMapSize: 1024, cascades: 1, sobel: false, silkWash: true, outlines: true, msaa: 0, maxPixelRatio: 1.0, particleBudget: 600 },
};

// ===========================================================================
// Minimal full-screen pass
// ===========================================================================

/**
 * One full-screen triangle rather than a quad. A quad splits the screen along
 * a diagonal, and every pixel on that diagonal is rasterised by two triangles
 * in different 2x2 quads, which makes `fwidth` and every derivative on that
 * line wrong. The grain and the antialiased band edges both use derivatives, so
 * this is not a micro-optimisation, it is correctness.
 */
function fullScreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  return g;
}

class ScreenPass {
  private mesh: THREE.Mesh;
  private static geometry: THREE.BufferGeometry | null = null;
  private static camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(readonly material: THREE.ShaderMaterial) {
    if (!ScreenPass.geometry) ScreenPass.geometry = fullScreenTriangle();
    this.mesh = new THREE.Mesh(ScreenPass.geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, ScreenPass.camera);
  }

  dispose(): void {
    this.material.dispose();
  }
}

function screenMaterial(
  name: string,
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name,
    uniforms,
    vertexShader: GLSL_FULLSCREEN_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    lights: false,
    fog: false,
  });
}

/**
 * The interior-line material.
 *
 * Exported and constructible with no WebGL context so `selfcheck.ts` validates
 * the EXACT material that ships rather than a hand-copied replica of it. A
 * replica is a second source of truth and it drifts.
 *
 * Its three texture uniforms are left null; the pipeline binds them once the
 * render targets exist.
 */
export function createLinesMaterial(): THREE.ShaderMaterial {
  const ink = hexToRgb(PIGMENTS.ink.bands[0]);
  const paper = hexToRgb(PIGMENTS.shellWhite.bands[3]);
  return screenMaterial('gongbi.lines', GLSL_SOBEL_FRAG, {
    uSceneTex: { value: null },
    uNormalTex: { value: null },
    uDepthTex: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uLineStrength: { value: LINE_STRENGTH },
    uNormalEdge: { value: new THREE.Vector2(NORMAL_EDGE_LO, NORMAL_EDGE_HI) },
    uDepthSuppress: { value: DEPTH_SUPPRESS },
    uHullSuppressPx: { value: hullSuppressRadiusPx(1080) },
    uLineColour: {
      value: new THREE.Color(srgbToLinear(ink.r), srgbToLinear(ink.g), srgbToLinear(ink.b)),
    },
    uLineTint: { value: OUTLINES.fine.tint },
    uPaperColour: {
      value: new THREE.Color(srgbToLinear(paper.r), srgbToLinear(paper.g), srgbToLinear(paper.b)),
    },
    uSobelEnabled: { value: 1 },
    uDebugMode: { value: DEBUG_NONE },
  });
}

/** The flash + grade + grain material. Same reasoning as above. */
export function createGradeMaterial(mood: LightMood): THREE.ShaderMaterial {
  const tint = hexToRgb(mood.gradeTint);
  return screenMaterial('gongbi.grade', [GLSL_MATH, GLSL_NOISE, GLSL_GRADE_FRAG].join('\n'), {
    uSceneTex: { value: null },
    uFlash: { value: 0 },
    uFlashColour: { value: new THREE.Color(1, 1, 1) },
    uGradeTint: {
      value: new THREE.Color(srgbToLinear(tint.r), srgbToLinear(tint.g), srgbToLinear(tint.b)),
    },
    uGradeAmount: { value: mood.gradeAmount },
    uVignette: { value: VIGNETTE },
    uGrainAmount: { value: GRAIN_AMOUNT },
    uGrainPeriodPx: { value: GRAIN_PERIOD_PX },
    uViewportPx: { value: new THREE.Vector2(1920, 1080) },
    uDebugMode: { value: DEBUG_NONE },
  });
}

// ===========================================================================
// Options
// ===========================================================================

export interface RenderPipelineOptions {
  width?: number;
  height?: number;
  /** Device pixel ratio the renderer is already using. */
  dpr?: number;
  quality?: QualityTier;
  /** Starting light mood; the composer's grade follows it. */
  mood?: 'wide' | 'close' | 'endgame';
  /** Turn shadows off entirely, e.g. for a silhouette-only harness run. */
  shadows?: boolean;
}

// ===========================================================================
// Pipeline
// ===========================================================================

const _size = new THREE.Vector2();

export class GongbiPipeline implements RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly materials: GongbiMaterialLibrary;
  readonly shadows: CascadedShadowMaps;
  readonly textures: TextureLibrary;

  readonly composer: { render(dt: number): void };

  private mrt: THREE.WebGLRenderTarget;
  private sceneRT: THREE.WebGLRenderTarget;
  private postRT: THREE.WebGLRenderTarget;

  private linesPass: ScreenPass;
  private gradePass: ScreenPass;

  private width = 1;
  private height = 1;
  private dpr = 1;

  private tier: QualityTier;
  private settings = RENDER_QUALITY.ultra;
  private floatTargets: boolean;

  private silhouette = false;
  private outlinesEnabled = true;
  private debugMode = DEBUG_NONE;
  private flashStrength = 0;

  /** Set by `render()`, consumed by `composer.render()`. */
  private currentScene: THREE.Scene | null = null;
  private currentCamera: THREE.Camera | null = null;
  private currentDt = 0;

  // Frame scratch — filled by one traversal, reused forever.
  private meshes: THREE.Mesh[] = [];
  private origMaterials: (THREE.Material | THREE.Material[])[] = [];
  private hulls: THREE.Object3D[] = [];

  private silhouetteBackground: THREE.Color;
  private prevClear = new THREE.Color();

  constructor(renderer: THREE.WebGLRenderer, opts: RenderPipelineOptions = {}) {
    this.renderer = renderer;
    this.tier = opts.quality ?? 'ultra';
    this.settings = RENDER_QUALITY[this.tier];

    // Rendering to float or half-float colour attachments is an extension even
    // in WebGL2. It is present on every machine this project targets, but if it
    // is missing we degrade to 8-bit intermediates and disable the Sobel rather
    // than crash — a build with no interior lines is still a build.
    this.floatTargets = renderer.extensions.has('EXT_color_buffer_float');
    if (!this.floatTargets) {
      console.warn(
        '[render] EXT_color_buffer_float unavailable: interior lines disabled and ' +
          'the scene buffer drops to 8 bit. Expect banding in the deep bands.',
      );
    }

    this.textures = new TextureLibrary();
    this.textures.setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());

    this.materials = new GongbiMaterialLibrary({
      mood: opts.mood ?? 'wide',
      textures: this.textures,
    });

    this.shadows = new CascadedShadowMaps({
      mapSize: this.settings.shadowMapSize,
      cascades: this.settings.cascades,
    });
    this.materials.attachShadows(this.shadows);
    this.materials.setShadowsEnabled(opts.shadows !== false);

    // Textures are ~0.4 s of pixel loops in total. Doing it now, behind the
    // boot veil, is the difference between a clean first move and a hitch.
    this.textures.prewarm();

    const white = hexToRgb(PIGMENTS.shellWhite.bands[3]);
    this.silhouetteBackground = new THREE.Color(
      srgbToLinear(white.r),
      srgbToLinear(white.g),
      srgbToLinear(white.b),
    );

    const colourType = this.floatTargets ? THREE.HalfFloatType : THREE.UnsignedByteType;

    this.mrt = new THREE.WebGLRenderTarget(1, 1, {
      count: 2,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.mrt.textures[0].name = 'gongbi.prepass.normal';
    this.mrt.textures[1].name = 'gongbi.prepass.depth';
    if (this.floatTargets) {
      // Attachment 1 is view depth in world units. R32F, per ARCHITECTURE.md:
      // half float has a 10-bit mantissa, which at 30 world units resolves to
      // 0.03 — coarse enough that the Sobel's depth suppressor would start
      // firing on quantisation steps at the far rank.
      this.mrt.textures[1].format = THREE.RedFormat;
      this.mrt.textures[1].type = THREE.FloatType;
    }

    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: colourType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: this.settings.msaa,
    });
    this.sceneRT.texture.name = 'gongbi.scene';
    this.sceneRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    this.postRT = new THREE.WebGLRenderTarget(1, 1, {
      type: colourType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.postRT.texture.name = 'gongbi.post';
    this.postRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    this.linesPass = new ScreenPass(createLinesMaterial());
    this.linesPass.material.uniforms.uSceneTex.value = this.sceneRT.texture;
    this.linesPass.material.uniforms.uNormalTex.value = this.mrt.textures[0];
    this.linesPass.material.uniforms.uDepthTex.value = this.mrt.textures[1];
    this.linesPass.material.uniforms.uSobelEnabled.value =
      this.settings.sobel && this.floatTargets ? 1 : 0;

    this.gradePass = new ScreenPass(createGradeMaterial(this.materials.currentMood()));
    this.gradePass.material.uniforms.uSceneTex.value = this.postRT.texture;

    this.composer = { render: (dt: number) => this.renderCurrent(dt) };

    const w = opts.width ?? 1;
    const h = opts.height ?? 1;
    this.setSize(w, h, opts.dpr ?? renderer.getPixelRatio());
  }

  // -- sizing ---------------------------------------------------------------

  /** `w`/`h` are CSS pixels; targets are allocated at the drawing-buffer size. */
  setSize(w: number, h: number, dpr: number): void {
    this.dpr = dpr;
    // `maxPixelRatio` is deliberately NOT clamped here. perf/'s governor owns
    // the pixel ratio; clamping it a second time in render/ would mean two
    // owners for one number, and the resulting disagreement would present as
    // "the resolution does not respond to the quality setting".
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    this.renderer.getDrawingBufferSize(_size);
    this.width = Math.max(1, Math.floor(_size.x));
    this.height = Math.max(1, Math.floor(_size.y));

    this.mrt.setSize(this.width, this.height);
    this.sceneRT.setSize(this.width, this.height);
    this.postRT.setSize(this.width, this.height);

    (this.linesPass.material.uniforms.uTexel.value as THREE.Vector2).set(
      1 / this.width,
      1 / this.height,
    );
    // The hull's own width scales with the viewport (see outline.glsl.ts), so
    // the radius the Sobel yields inside must scale with it too or the two
    // systems drift apart on a window resize.
    this.linesPass.material.uniforms.uHullSuppressPx.value = hullSuppressRadiusPx(this.height);
    (this.gradePass.material.uniforms.uViewportPx.value as THREE.Vector2).set(
      this.width,
      this.height,
    );
  }

  // -- quality --------------------------------------------------------------

  setQuality(tier: QualityTier): void {
    this.tier = tier;
    this.applyQualitySettings(RENDER_QUALITY[tier]);
  }

  /** The authoritative path: perf/'s governor hands its real settings through. */
  applyQualitySettings(q: QualitySettings): void {
    this.tier = q.tier;
    this.settings = q;
    this.shadows.setMapSize(q.shadowMapSize);
    this.shadows.setCascadeCount(q.cascades);
    this.materials.setQuality(q);
    this.outlinesEnabled = q.outlines;
    this.linesPass.material.uniforms.uSobelEnabled.value =
      q.sobel && this.floatTargets && this.debugMode !== DEBUG_OUTLINE_ONLY ? 1 : 0;
    // MSAA lives in the framebuffer, not in a uniform: three reads `samples`
    // when it builds the target, so the sample count only takes effect after
    // the GL objects are torn down. `dispose()` does that and the next render
    // rebuilds at the new count. This is why the governor is written to change
    // tier rarely and never during a capture — it is a reallocation, not a knob.
    if (this.sceneRT.samples !== q.msaa) {
      this.sceneRT.dispose();
      this.sceneRT.samples = q.msaa;
    }
  }

  get quality(): QualityTier {
    return this.tier;
  }

  // -- presentation ---------------------------------------------------------

  setSilhouetteMode(on: boolean): void {
    this.silhouette = on;
    this.materials.setSilhouetteMode(on);
  }

  /**
   * Impact flash. `colour` is a palette sRGB hex; the decay is exponential and
   * owned here, so callers fire and forget.
   */
  flash(strength: number, colour: string): void {
    this.flashStrength = Math.max(this.flashStrength, Math.max(0, Math.min(1, strength)));
    const c = hexToRgb(colour);
    (this.gradePass.material.uniforms.uFlashColour.value as THREE.Color).setRGB(
      srgbToLinear(c.r),
      srgbToLinear(c.g),
      srgbToLinear(c.b),
    );
  }

  /** Cross-fade the light mood. Drives the grade, the shadow stretch and, until
   *  scene/lighting.ts takes over, the light uniforms too. */
  setMood(key: 'wide' | 'close' | 'endgame', seconds: number): void {
    this.materials.setMood(key, seconds);
  }

  /**
   * `LightConsumer` from scene/lighting.ts. Register the pipeline as a consumer
   * and the rig drives the surface uniforms, the shadow direction AND the mood
   * grade, all from one interpolation — so the lights and the grade can never
   * disagree about which mood the match is in. Structural typing keeps the
   * dependency pointing the right way (scene -> render, never the reverse).
   */
  setLight(spec: {
    dir: THREE.Vector3;
    keyColour: THREE.Color;
    fillColour: THREE.Color;
    keyIntensity: number;
    fillIntensity: number;
    bounceColour?: THREE.Color;
    gradeTint: THREE.Color;
    gradeAmount: number;
  }): void {
    this.materials.setLight(spec);
    this.externalGrade = true;
    (this.gradePass.material.uniforms.uGradeTint.value as THREE.Color).copy(spec.gradeTint);
    this.gradeAmount = spec.gradeAmount;
  }

  /**
   * Everything `scene/lighting.ts`'s `csmSpec()` carries. Its splits are already
   * scaled by the mood's shadow stretch, so they replace ours outright.
   */
  setShadowSpec(spec: {
    direction: THREE.Vector3;
    splits: number[];
    mapSize: number;
    cascades: number;
  }): void {
    this.shadows.setDirection(spec.direction.x, spec.direction.y, spec.direction.z);
    this.shadows.setSplits(spec.splits);
    this.shadows.setMapSize(spec.mapSize);
    this.shadows.setCascadeCount(spec.cascades);
  }

  private externalGrade = false;
  private gradeAmount = 0;

  /**
   * The four render-owned DebugFlags from core/testapi.ts, plus
   * `shadowCascades`. Anything else is ignored — it belongs to another
   * subsystem and silently swallowing it here is better than throwing at a
   * harness that legitimately sets flags for several systems at once.
   */
  setDebug(flag: DebugFlag, on: boolean): void {
    const mode = ((): number => {
      switch (flag) {
        case 'rampBands':
          return DEBUG_RAMP_BANDS;
        case 'outlineOnly':
          return DEBUG_OUTLINE_ONLY;
        case 'sobelOnly':
          return DEBUG_SOBEL_ONLY;
        case 'normals':
          return DEBUG_NORMALS;
        case 'shadowCascades':
          return DEBUG_SHADOW_CASCADES;
        default:
          return -1;
      }
    })();
    if (mode < 0) return;

    this.debugMode = on ? mode : DEBUG_NONE;
    this.materials.setDebug(this.debugMode);
    this.linesPass.material.uniforms.uDebugMode.value = this.debugMode;
    this.gradePass.material.uniforms.uDebugMode.value = this.debugMode;
    this.linesPass.material.uniforms.uSobelEnabled.value =
      this.settings.sobel && this.floatTargets && this.debugMode !== DEBUG_OUTLINE_ONLY ? 1 : 0;
  }

  get debug(): number {
    return this.debugMode;
  }

  // -- frame ----------------------------------------------------------------

  render(scene: THREE.Scene, camera: THREE.Camera, dt: number): void {
    this.currentScene = scene;
    this.currentCamera = camera;
    this.renderCurrent(dt);
  }

  private renderCurrent(dt: number): void {
    const scene = this.currentScene;
    const camera = this.currentCamera;
    if (!scene || !camera) return;
    this.currentDt = dt;

    const renderer = this.renderer;

    // --- per-frame uniform push -------------------------------------------
    // The pipeline owns this call. Do NOT also call materials.update() from
    // main.ts: the mood cross-fade integrates dt and would advance twice.
    this.materials.update(dt, camera, { w: this.width, h: this.height, dpr: this.dpr });
    this.shadows.setStretch(this.materials.currentMood().shadowStretch);
    this.pushGrade();

    this.flashStrength *= Math.exp(-FLASH_DECAY * dt);
    if (this.flashStrength < 1e-3) this.flashStrength = 0;
    this.gradePass.material.uniforms.uFlash.value = this.flashStrength;

    // --- one traversal, reused by every pass -------------------------------
    this.collect(scene);

    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();
    const prevBackground = scene.background;
    renderer.getClearColor(this.prevClear);
    const prevAlpha = renderer.getClearAlpha();
    renderer.autoClear = true;

    // --- 1. shadows --------------------------------------------------------
    const wantShadows =
      this.settings.cascades > 0 && !this.silhouette && this.debugMode !== DEBUG_OUTLINE_ONLY;
    this.materials.setShadowsEnabled(wantShadows);
    if (wantShadows) {
      this.shadows.render(renderer, scene, camera, this.hulls);
      // Immediately after the fit, never before it — see syncShadows()'s note.
      this.materials.syncShadows();
    }

    // --- 2. depth + normal prepass ----------------------------------------
    const wantSobel = this.linesPass.material.uniforms.uSobelEnabled.value === 1 && !this.silhouette;
    if (wantSobel) {
      // Clearing to zero makes background depth 0, which the Sobel shader reads
      // as "nothing here" and refuses to draw a line on. It is a sentinel, not
      // a distance, and it must stay 0.
      renderer.setClearColor(0x000000, 0);
      scene.background = null;
      this.swapToPrepass();
      renderer.setRenderTarget(this.mrt);
      renderer.render(scene, camera);
      this.restoreMaterials();
      scene.background = prevBackground;
      renderer.setClearColor(this.prevClear, prevAlpha);
    }

    // --- 3. main pass ------------------------------------------------------
    if (this.silhouette) {
      // Flat black units on a white ground, per core/testapi.ts. The scene's
      // own background is borrowed for one frame and handed straight back;
      // owning it would mean render/ deciding what colour the sky is, which is
      // scene/'s job.
      scene.background = this.silhouetteBackground;
    }
    // `QualitySettings.outlines` is the floor's last resort and is expected to
    // stay true at every tier — the line work IS the art direction. Honouring
    // it costs one loop over an array we already have.
    if (!this.outlinesEnabled) {
      for (let i = 0; i < this.hulls.length; i++) this.hulls[i].visible = false;
    }
    renderer.setRenderTarget(this.sceneRT);
    renderer.render(scene, camera);
    if (!this.outlinesEnabled) {
      for (let i = 0; i < this.hulls.length; i++) this.hulls[i].visible = true;
    }
    scene.background = prevBackground;

    // --- 4. post -----------------------------------------------------------
    this.linesPass.render(renderer, this.postRT);
    this.gradePass.render(renderer, null);

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(this.prevClear, prevAlpha);
    renderer.autoClear = prevAutoClear;
  }

  private pushGrade(): void {
    if (!this.externalGrade) {
      const mood = this.materials.currentMood();
      const c = hexToRgb(mood.gradeTint);
      (this.gradePass.material.uniforms.uGradeTint.value as THREE.Color).setRGB(
        srgbToLinear(c.r),
        srgbToLinear(c.g),
        srgbToLinear(c.b),
      );
      this.gradeAmount = mood.gradeAmount;
    }
    this.gradePass.material.uniforms.uGradeAmount.value = this.silhouette ? 0 : this.gradeAmount;
    this.gradePass.material.uniforms.uVignette.value = this.silhouette ? 0 : VIGNETTE;
    this.gradePass.material.uniforms.uGrainAmount.value = this.silhouette ? 0 : GRAIN_AMOUNT;
  }

  /**
   * The single scene traversal.
   *
   * Collects every visible mesh (so the prepass can swap its material) and
   * every hull shell (so the shadow pass can hide it — a hull is the mesh grown
   * outward, and letting it cast would fatten every shadow by the stroke
   * width). `traverseVisible` skips invisible subtrees, which is what we want:
   * a hidden figure costs nothing here.
   */
  private collect(scene: THREE.Scene): void {
    this.meshes.length = 0;
    this.hulls.length = 0;
    scene.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh !== true) return;
      this.meshes.push(m);
      if (isHull(m)) this.hulls.push(m);
    });
  }

  private swapToPrepass(): void {
    const n = this.meshes.length;
    this.origMaterials.length = n;
    for (let i = 0; i < n; i++) {
      const mesh = this.meshes[i];
      const original = mesh.material;
      this.origMaterials[i] = original;
      const single = Array.isArray(original) ? original[0] : original;
      const info = gongbiInfo(single);
      // Foreign materials get the generic prepass so they still contribute
      // depth and normals; without it the Sobel would run interior lines
      // straight across anything another subsystem drew with a stock material.
      mesh.material = info ? info.prepass : this.materials.genericPrepass;
    }
  }

  private restoreMaterials(): void {
    for (let i = 0; i < this.meshes.length; i++) {
      this.meshes[i].material = this.origMaterials[i];
    }
  }

  // -- misc ------------------------------------------------------------------

  /**
   * Force every program in the scene to compile now. Shader compilation is the
   * one thing that reliably blows the 20 ms spike budget, and it happens on the
   * first frame a material is seen — which is usually the first capture, i.e.
   * exactly the moment the player is watching most closely.
   */
  prewarm(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.compile(scene, camera);
  }

  dispose(): void {
    this.mrt.dispose();
    this.sceneRT.dispose();
    this.postRT.dispose();
    this.linesPass.dispose();
    this.gradePass.dispose();
    this.shadows.dispose();
    this.materials.dispose();
  }
}

/**
 * The factory the rest of the project uses. `renderer` stays owned by main.ts —
 * the pipeline configures its size and pixel ratio but never creates it, so a
 * harness that needs a specific context can make its own.
 */
export function createRenderPipeline(
  renderer: THREE.WebGLRenderer,
  opts: RenderPipelineOptions = {},
): GongbiPipeline {
  return new GongbiPipeline(renderer, opts);
}
