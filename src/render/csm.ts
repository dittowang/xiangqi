/**
 * Cascaded shadow maps, written from scratch.
 *
 * Three cascades at 6 / 14 / 34 world units, per ARCHITECTURE.md's budget. The
 * board is 8 x 9 units and the resting camera sits 15.5 units out, so cascade 0
 * covers the near rank at roughly 6 mm per texel, cascade 1 the middle game,
 * and cascade 2 everything to the far edge of the table.
 *
 * THE TWO THINGS THAT MAKE A CSM SHIMMER, AND WHAT IS DONE ABOUT THEM
 *
 * 1. The cascade's world footprint changing size as the camera rotates. Fitting
 *    an axis-aligned box to the frustum corners does exactly that: rotate the
 *    camera 45 degrees and the box grows by up to sqrt(2), so the texel density
 *    changes and every shadow edge crawls. The fix is to fit a SPHERE, whose
 *    radius depends only on the slice's near and far planes and the field of
 *    view — not on orientation at all. The closed form is below; it is exact,
 *    it allocates nothing, and it needs no frustum-corner loop.
 *
 * 2. The footprint sliding by sub-texel amounts as the camera translates. Even
 *    with a constant radius, a half-texel shift re-rasterises every edge. The
 *    fix is to snap the sphere centre to the light-space texel grid before
 *    building the light camera, so the shadow map's contents translate in whole
 *    texels or not at all.
 *
 * BIAS is normal-offset, not depth-offset. See the note in shaders/lib.glsl.ts;
 * the short version is that a depth bias large enough to survive the worst
 * slope in the frame detaches every figure's shadow from its feet, and on a
 * board where thirty-two figures stand on one flat plane that is the most
 * visible shadow defect available.
 *
 * NO THIRD-PARTY CSM. This is about 200 lines and it needs to cooperate with a
 * hand-written surface shader; wrapping an addon would cost more than it saved.
 */

import * as THREE from 'three';
import type { LightMood } from '@core/palette.ts';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Cascade far planes in world units, before the mood's shadowStretch. */
export const CASCADE_SPLITS: readonly [number, number, number] = [6, 14, 34];

/**
 * `LightMood.shadowStretch` is documented as "multiplier on shadow length,
 * applied via the CSM split ratio". The endgame mood asks for 1.85, which is a
 * low sun throwing long shadows. Applying it uniformly would blow the near
 * cascade out to 11 units and halve its texel density for no gain — the near
 * rank has not moved. So it is ramped across the cascades: the near cascade
 * keeps its tight fit, and the far cascade grows to cover the long shadows that
 * are actually the reason for the setting.
 */
function stretchedSplits(stretch: number, out: number[]): number[] {
  const n: number = CASCADE_SPLITS.length;
  for (let i = 0; i < n; i++) {
    const k = n <= 1 ? 1 : i / (n - 1);
    out[i] = CASCADE_SPLITS[i] * (1 + (stretch - 1) * k);
  }
  return out;
}

/**
 * How far behind the cascade sphere the light camera's near plane sits, in
 * world units. Anything taller than this standing just outside the slice will
 * fail to cast into it. The tallest unit is the elephant at roughly 2.7 world
 * units, and a low endgame sun rakes its shadow a long way, so 14 is generous
 * rather than tight — the cost is only depth precision, and RGBA-packed depth
 * has 24 bits to spend.
 */
const CASTER_HEADROOM = 14;

/** Constant depth bias, expressed in shadow texels of world size. */
const BIAS_TEXELS = 1.1;
/** Floor on the constant bias, world units — kills acne on near-parallel faces. */
const BIAS_FLOOR = 0.004;

/** Fraction of a cascade's depth range used to cross-fade into the next one. */
export const CASCADE_BLEND = 0.08;

// ---------------------------------------------------------------------------
// Scratch — module level, never allocated in a frame
// ---------------------------------------------------------------------------

const _forward = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _lightSpace = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _up = new THREE.Vector3();
const _snapView = new THREE.Matrix4();
const _snapViewInv = new THREE.Matrix4();
const _splits: number[] = [0, 0, 0];
const _prevClear = new THREE.Color();

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_FWD = new THREE.Vector3(0, 0, 1);
const ZERO = new THREE.Vector3(0, 0, 0);

export interface Cascade {
  readonly target: THREE.WebGLRenderTarget;
  readonly camera: THREE.OrthographicCamera;
  /** world -> light clip, fed straight to the shader. */
  readonly matrix: THREE.Matrix4;
  /** Far view-depth this cascade covers. */
  far: number;
  /** World size of one shadow texel. Drives the normal offset. */
  texelWorld: number;
  /** Constant bias in normalised light-depth units. */
  bias: number;
}

export interface CascadedShadowOptions {
  mapSize?: number;
  cascades?: number;
}

export class CascadedShadowMaps {
  readonly cascades: Cascade[] = [];
  /** Direction FROM the scene TO the light, normalised. */
  readonly direction = new THREE.Vector3(0.45, 0.78, 0.44).normalize();

  private mapSize: number;
  private activeCount: number;
  private stretch = 1;
  private depthMaterial: THREE.MeshDepthMaterial;

  constructor(opts: CascadedShadowOptions = {}) {
    this.mapSize = opts.mapSize ?? 2048;
    this.activeCount = Math.max(1, Math.min(3, opts.cascades ?? 3));

    // DoubleSide: several parts of the cast (banners, cloth, the elephant's
    // ear) are single-sided sheets, and front-face-only shadow rendering makes
    // them cast nothing at all. Normal-offset bias makes the resulting
    // self-shadowing harmless.
    this.depthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      side: THREE.DoubleSide,
    });

    for (let i = 0; i < 3; i++) {
      const target = new THREE.WebGLRenderTarget(this.mapSize, this.mapSize, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      target.texture.name = `gongbi.csm${i}`;
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
      this.cascades.push({
        target,
        camera,
        matrix: new THREE.Matrix4(),
        far: CASCADE_SPLITS[i],
        texelWorld: 1,
        bias: 0.001,
      });
    }
  }

  get count(): number {
    return this.activeCount;
  }

  setCascadeCount(n: number): void {
    this.activeCount = Math.max(1, Math.min(3, Math.floor(n)));
  }

  setMapSize(size: number): void {
    if (size === this.mapSize) return;
    this.mapSize = size;
    for (const c of this.cascades) c.target.setSize(size, size);
  }

  get texelStep(): number {
    return 1 / this.mapSize;
  }

  /** Direction the key light comes FROM, in the same convention scene/ uses. */
  setDirection(x: number, y: number, z: number): void {
    this.direction.set(x, y, z);
    if (this.direction.lengthSq() < 1e-8) this.direction.set(0.45, 0.78, 0.44);
    this.direction.normalize();
  }

  /** Derive the light direction from a mood's elevation/azimuth. */
  setFromMood(mood: LightMood): void {
    const ce = Math.cos(mood.keyElevation);
    this.setDirection(
      Math.sin(mood.keyAzimuth) * ce,
      Math.sin(mood.keyElevation),
      Math.cos(mood.keyAzimuth) * ce,
    );
    this.stretch = mood.shadowStretch;
  }

  setStretch(s: number): void {
    this.stretch = s;
  }

  /**
   * Override the split distances outright.
   *
   * `scene/lighting.ts` publishes already-stretched splits through its
   * `csmSpec()`, and when it does, its numbers win: the rig owns the mood and
   * therefore owns the shadow length. Passing null hands the decision back to
   * this file's own `stretchedSplits`.
   */
  setSplits(splits: readonly number[] | null): void {
    this.override = splits ? [splits[0] ?? CASCADE_SPLITS[0], splits[1] ?? CASCADE_SPLITS[1], splits[2] ?? CASCADE_SPLITS[2]] : null;
  }

  private override: number[] | null = null;

  /**
   * Exact bounding sphere of a symmetric perspective frustum slice.
   *
   * With `k = tan(fovY/2) * sqrt(1 + aspect^2)` — the tangent of the half-angle
   * to a frustum CORNER, not to an edge — the slice from `a` to `b` along the
   * view axis has its minimal enclosing sphere either centred at the far plane
   * (when the slice is short and wide) or on the axis between the two planes.
   * Both cases fall out of requiring the near and far corner rings to be
   * equidistant from the centre.
   *
   * Writes the centre's axial distance into `out[0]` and the radius into
   * `out[1]`. Depends only on a, b and k — never on camera orientation, which
   * is the entire point.
   */
  private static sliceSphere(a: number, b: number, k: number, out: [number, number]): void {
    const k2 = k * k;
    if (k2 >= (b - a) / (b + a)) {
      // Wide slice: the far ring encloses everything.
      out[0] = b;
      out[1] = b * k;
    } else {
      const c = 0.5 * (a + b) * (1 + k2);
      const r = 0.5 * Math.sqrt(
        (b - a) * (b - a) + 2 * (b * b + a * a) * k2 + (a + b) * (a + b) * k2 * k2,
      );
      out[0] = c;
      out[1] = r;
    }
  }

  private static _sphere: [number, number] = [0, 0];

  /**
   * Fit every cascade to the current camera. Call once per frame before
   * rendering; `render()` does it for you.
   */
  update(camera: THREE.Camera): void {
    const persp = camera as THREE.PerspectiveCamera;
    const isPersp = persp.isPerspectiveCamera === true;

    // Corner half-angle tangent. For an orthographic camera the frustum is a
    // box and the "sphere" is just its bounding sphere; we approximate with a
    // fixed radius derived from the ortho extent.
    const tanHalfV = isPersp ? Math.tan(THREE.MathUtils.degToRad(persp.fov * 0.5)) : 0;
    const aspect = isPersp ? persp.aspect : 1;
    const k = tanHalfV * Math.sqrt(1 + aspect * aspect);

    if (this.override) {
      _splits[0] = this.override[0];
      _splits[1] = this.override[1];
      _splits[2] = this.override[2];
    } else {
      stretchedSplits(this.stretch, _splits);
    }

    camera.updateMatrixWorld();
    camera.getWorldDirection(_forward);

    // The light's basis, built from a fixed world reference so the texel grid
    // is anchored to the world and not to the camera. Anchoring it to the
    // camera would defeat the snap entirely.
    // A light straight overhead makes world-up degenerate as a reference; fall
    // back to world-forward, which can never be parallel to a Y-dominant light.
    _up.copy(Math.abs(this.direction.y) > 0.98 ? WORLD_FWD : WORLD_UP);
    _snapViewInv.identity();
    _snapViewInv.lookAt(this.direction, ZERO, _up); // light basis -> world
    _snapView.copy(_snapViewInv).invert(); // world -> light basis

    let near = isPersp ? persp.near : 0;
    const lastActive = this.activeCount - 1;
    const fullRange = _splits[CASCADE_SPLITS.length - 1];

    for (let i = 0; i < this.activeCount; i++) {
      const c = this.cascades[i];
      // The LAST ACTIVE cascade always reaches the full shadow distance.
      //
      // Without this, dropping to one or two cascades does not reduce shadow
      // QUALITY, it deletes the shadows: every fragment past the last split
      // falls outside that cascade's footprint, and `xqCsmFetch` correctly —
      // and unhelpfully — reports "lit" there rather than painting a black
      // rectangle. At the resting framing the camera is 15.5 units out, so with
      // one cascade covering 6 units the entire board would be unshadowed.
      //
      // Caught by an A/B of two real frames where a soldier's cast shadow
      // simply disappeared between the two; nothing static could have found it,
      // because in isolation each cascade was behaving exactly as designed.
      const far = i === lastActive ? fullRange : _splits[i];
      c.far = far;

      let axial: number;
      let radius: number;
      if (isPersp) {
        CascadedShadowMaps.sliceSphere(near, far, k, CascadedShadowMaps._sphere);
        axial = CascadedShadowMaps._sphere[0];
        radius = CascadedShadowMaps._sphere[1];
      } else {
        axial = (near + far) * 0.5;
        radius = (far - near) * 0.5 + 8;
      }

      _centre.copy(camera.position).addScaledVector(_forward, axial);

      // Snap to the light-space texel grid. Round, not floor: floor biases the
      // whole map by half a texel in one direction.
      const texel = (2 * radius) / this.mapSize;
      _lightSpace.copy(_centre).applyMatrix4(_snapView);
      _lightSpace.x = Math.round(_lightSpace.x / texel) * texel;
      _lightSpace.y = Math.round(_lightSpace.y / texel) * texel;
      _centre.copy(_lightSpace).applyMatrix4(_snapViewInv);

      const depthRange = 2 * radius + CASTER_HEADROOM;
      _eye.copy(_centre).addScaledVector(this.direction, radius + CASTER_HEADROOM);

      const cam = c.camera;
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = 0;
      cam.far = depthRange;
      cam.position.copy(_eye);
      cam.up.copy(_up);
      cam.lookAt(_centre);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();

      c.matrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      c.texelWorld = texel;
      c.bias = (texel * BIAS_TEXELS + BIAS_FLOOR) / depthRange;

      near = far;
    }
  }

  /**
   * Render the cascades.
   *
   * `hidden` is the list of objects that must not cast — hull shells, in
   * particular, because they are the mesh pushed outward and would fatten every
   * shadow by the stroke width. The caller collects it during the one scene
   * traversal it already does, so this costs nothing extra.
   *
   * The scene's background is detached for the duration. Left attached, three
   * would clear the shadow target to the background COLOUR, and unpacking that
   * colour as a depth yields a value near zero — i.e. "there is an occluder
   * immediately in front of the light, everywhere". The whole frame would go
   * black and the cause would be extremely hard to find, so it is worth the
   * three lines.
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    hidden: THREE.Object3D[],
  ): void {
    this.update(camera);

    const prevBackground = scene.background;
    const prevOverride = scene.overrideMaterial;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.getClearColor(_prevClear);
    const prevAlpha = renderer.getClearAlpha();

    scene.background = null;
    scene.overrideMaterial = this.depthMaterial;
    // White clears to packed depth 1.0 — "nothing between here and the light".
    renderer.setClearColor(0xffffff, 1);
    renderer.autoClear = true;

    for (let i = 0; i < hidden.length; i++) hidden[i].visible = false;

    for (let i = 0; i < this.activeCount; i++) {
      const c = this.cascades[i];
      renderer.setRenderTarget(c.target);
      renderer.render(scene, c.camera);
    }

    for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;

    scene.background = prevBackground;
    scene.overrideMaterial = prevOverride;
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(_prevClear, prevAlpha);
    renderer.setRenderTarget(prevTarget);
  }

  dispose(): void {
    for (const c of this.cascades) c.target.dispose();
    this.depthMaterial.dispose();
  }
}
