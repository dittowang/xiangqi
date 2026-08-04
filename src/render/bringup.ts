/**
 * Shader bring-up: compile every material variant against a real WebGL2 driver.
 *
 * WHY THIS EXISTS
 * `selfcheck.ts` validates the shader source we INTEND to hand the driver. It
 * cannot validate the source three actually assembles, and it cannot validate
 * anything the GLSL compiler knows that a regex does not. The gap between those
 * two is not theoretical: the first real compile of this subsystem failed on
 * every surface and hull variant, because the outline uniforms were declared in
 * the vertex stage and used in the fragment stage — legal-looking in every
 * static check that treats a program as one text, fatal in a compiler that
 * treats the two stages as separate translation units.
 *
 * So this module runs IN THE BROWSER, against a real context, and reports
 * per-variant compile status with the driver's own info log. It is loaded by
 * `gputest.ts`, which bundles it and drives headless Chromium.
 *
 * It ships in `src/render/` rather than in `tools/` because it is testing this
 * subsystem's internals — it enumerates the private variant space of the
 * material library — and because it must move in lockstep with the shaders.
 * Nothing in the game imports it.
 */

import * as THREE from 'three';
import { PIGMENT_NAMES, type MaterialClass, type PigmentName } from '@core/palette.ts';
import { createGradeMaterial, createLinesMaterial, createRenderPipeline } from './composer.ts';
import { GongbiMaterialLibrary, gongbiInfo } from './gongbi.ts';
import { MATERIAL_CLASSES, codeFor } from './ramps.ts';
import { attachOutlines, ensureSmoothNormals } from './outline.ts';
import { collapseToAtlas } from './atlas.ts';
import { MOODS } from '@core/palette.ts';

export interface VariantResult {
  name: string;
  ok: boolean;
  /** Which object shape it was compiled against — the defines differ. */
  shape: string;
  errors: string[];
}

export interface FrameResult {
  ok: boolean;
  notes: string[];
  /** Distinct 8-bit colours in the composited frame. 1 means nothing drew. */
  distinctColours: number;
  /** Fraction of pixels that are not the background clear colour. */
  coverage: number;
  drawCalls: number;
  triangles: number;
  errors: string[];
}

export interface BringupReport {
  renderer: string;
  variants: VariantResult[];
  passed: number;
  failed: number;
  /** Distinct GL programs three ended up building. */
  programs: number;
  ms: number;
  frame: FrameResult;
}

/**
 * Object shapes, because `USE_SKINNING` and `USE_INSTANCING` are set from the
 * OBJECT, not from the material. One material therefore compiles into several
 * different programs depending on what it is drawn on, and a shader that
 * compiles on a Mesh can still fail on a SkinnedMesh. Testing only the plain
 * case would have missed the entire skinned cast.
 */
type Shape = 'mesh' | 'skinned' | 'instanced';

function makeGeometry(): THREE.BufferGeometry {
  // A box: cheap, indexed, and hard-edged, so `aSmoothNormal` has real welding
  // to do rather than trivially copying the shading normals.
  const g = new THREE.BoxGeometry(0.4, 0.4, 0.4);
  ensureSmoothNormals(g);
  return g;
}

/** Add the attributes the atlas path and the instanced path require. */
function decorate(g: THREE.BufferGeometry, code: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const mat = new Float32Array(n);
  mat.fill(code);
  g.setAttribute('aMaterial', new THREE.Float32BufferAttribute(mat, 1));
  return g;
}

function makeSkeleton(): THREE.Skeleton {
  const bone = new THREE.Bone();
  bone.updateMatrixWorld(true);
  return new THREE.Skeleton([bone]);
}

function buildObject(
  shape: Shape,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
): THREE.Object3D {
  if (shape === 'skinned') {
    const g = geometry.clone();
    const n = g.getAttribute('position').count;
    const idx = new Uint16Array(n * 4);
    const wgt = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) wgt[i * 4] = 1;
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wgt, 4));
    const m = new THREE.SkinnedMesh(g, material);
    const skeleton = makeSkeleton();
    m.add(skeleton.bones[0]);
    m.bind(skeleton, new THREE.Matrix4());
    return m;
  }
  if (shape === 'instanced') {
    const m = new THREE.InstancedMesh(geometry, material, 2);
    m.setMatrixAt(0, new THREE.Matrix4());
    m.setMatrixAt(1, new THREE.Matrix4().makeTranslation(1, 0, 0));
    m.instanceMatrix.needsUpdate = true;
    const n = geometry.getAttribute('position').count;
    void n;
    return m;
  }
  return new THREE.Mesh(geometry, material);
}

/**
 * Compile one material against one object shape and report what the driver
 * said.
 *
 * three logs shader errors through `console.error` with the full source and the
 * info log, and `renderer.debug.checkShaderErrors` (on by default) is what
 * produces them. Intercepting console for the duration of one compile is the
 * only way to attribute an error to a variant — `renderer.compile()` itself
 * returns nothing and throws nothing.
 */
function compileOne(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  object: THREE.Object3D,
): string[] {
  const captured: string[] = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (/shader|program|glsl/i.test(text)) captured.push(text);
  };
  try {
    scene.add(object);
    renderer.compile(scene, camera);
    // A real draw as well: `compile()` builds the program, but only a draw
    // exercises attribute binding, and a missing vertex attribute shows up
    // there rather than at compile time.
    renderer.render(scene, camera);
  } catch (err) {
    captured.push(`THREW: ${String(err)}`);
  } finally {
    scene.remove(object);
    console.error = realError;
    console.warn = realWarn;
  }
  return captured;
}

/** Trim three's enormous shader dump down to the lines a human needs. */
function distil(messages: string[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const lines = m.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      // The driver's own diagnostics, and three's header.
      if (/^(ERROR|WARNING):/i.test(t) || /Shader Error|THREW:|INVALID_/.test(t)) {
        if (!out.includes(t)) out.push(t);
      }
    }
    if (out.length === 0 && m.trim()) out.push(m.split('\n')[0].slice(0, 300));
  }
  return out;
}

export async function runBringup(): Promise<BringupReport> {
  const t0 = Date.now();
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setSize(64, 64, false);
  renderer.debug.checkShaderErrors = true;

  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererName = dbg
    ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
    : 'unknown';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 2);
  camera.updateMatrixWorld(true);

  const lib = new GongbiMaterialLibrary();
  const variants: VariantResult[] = [];

  const record = (name: string, shape: Shape, obj: THREE.Object3D): void => {
    const errors = distil(compileOne(renderer, scene, camera, obj));
    variants.push({ name, shape, ok: errors.length === 0, errors });
  };

  // ---- every (class, pigment) surface and hull, on every object shape -----
  const base = makeGeometry();
  for (const cls of MATERIAL_CLASSES as MaterialClass[]) {
    for (const pigment of PIGMENT_NAMES as PigmentName[]) {
      const req = { cls, pigment };
      const surface = lib.get(req);
      const hull = lib.outline(req);
      // The full cross-product would be 132 x 3 compiles on a software
      // rasteriser. The defines only depend on the shape, not on the pigment,
      // so every pigment is tested as a plain mesh and one pigment per class
      // additionally as skinned and instanced — which covers every distinct
      // program the cast will actually build.
      const shapes: Shape[] = pigment === 'cinnabar' ? ['mesh', 'skinned', 'instanced'] : ['mesh'];
      for (const shape of shapes) {
        record(`surface ${cls}/${pigment}`, shape, buildObject(shape, base, surface));
        if (hull) record(`hull ${cls}/${pigment}`, shape, buildObject(shape, base, hull));
      }
    }
  }

  // ---- prepass twins ------------------------------------------------------
  const seen = new Set<string>();
  for (const cls of MATERIAL_CLASSES as MaterialClass[]) {
    for (const source of [lib.get({ cls, pigment: 'ink' }), lib.outline({ cls, pigment: 'ink' })]) {
      const info = gongbiInfo(source);
      if (!info || seen.has(info.prepass.name)) continue;
      seen.add(info.prepass.name);
      for (const shape of ['mesh', 'skinned'] as Shape[]) {
        record(info.prepass.name, shape, buildObject(shape, base, info.prepass));
      }
    }
  }

  // ---- the atlas (per-vertex class + pigment) path ------------------------
  const atlasGeom = decorate(makeGeometry(), codeFor('lacquer', 'cinnabar'));
  for (const shape of ['mesh', 'skinned', 'instanced'] as Shape[]) {
    record('atlas surface', shape, buildObject(shape, atlasGeom, lib.getAtlas()));
    record('atlas hull', shape, buildObject(shape, atlasGeom, lib.outlineAtlas()));
    const info = gongbiInfo(lib.outlineAtlas());
    if (info) record('atlas hull prepass', shape, buildObject(shape, atlasGeom, info.prepass));
  }

  // ---- post passes --------------------------------------------------------
  {
    const quad = new THREE.BufferGeometry();
    quad.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    record('post lines', 'mesh', new THREE.Mesh(quad, createLinesMaterial()));
    record('post grade', 'mesh', new THREE.Mesh(quad, createGradeMaterial(MOODS.wide)));
  }

  const failed = variants.filter((v) => !v.ok).length;
  const frame = renderFrame();

  return {
    renderer: rendererName,
    variants,
    passed: variants.length - failed,
    failed,
    programs: renderer.info.programs?.length ?? 0,
    ms: Date.now() - t0,
    frame,
  };
}

/**
 * The end-to-end test that "it compiles" cannot give you: build the whole
 * pipeline — cascades, MRT prepass, hulls, surface, Sobel, grade — render one
 * frame into a fresh context, and read the pixels back.
 *
 * What it asserts is deliberately weak and structural rather than aesthetic: a
 * frame that is one flat colour means nothing drew, and a frame with only two
 * colours means the surface drew but nothing shaded it. Judging whether the
 * bands read as laid pigment still needs a human and a real screen. Judging
 * whether ANYTHING reached the canvas does not, and that is the failure mode
 * that has actually bitten.
 */
function renderFrame(): FrameResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };

  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 120;
  document.body.appendChild(canvas);

  let distinct = 0;
  let coverage = 0;
  let drawCalls = 0;
  let triangles = 0;

  try {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.debug.checkShaderErrors = true;

    const pipeline = createRenderPipeline(renderer, {
      width: 160,
      height: 120,
      dpr: 1,
      quality: 'high',
      mood: 'wide',
    });

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0.02, 0.02, 0.03);

    const camera = new THREE.PerspectiveCamera(45, 160 / 120, 0.1, 100);
    camera.position.set(1.6, 1.4, 2.6);
    camera.lookAt(0, 0, 0);

    // One skinned figure-ish mesh with a hull, one rigid prop, one ground plane
    // — enough for the cascades to have something to cast onto and for the
    // Sobel to have an interior edge to find.
    const geom = makeGeometry();
    const n = geom.getAttribute('position').count;
    const idx = new Uint16Array(n * 4);
    const wgt = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) wgt[i * 4] = 1;
    geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
    geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wgt, 4));

    const figure = new THREE.SkinnedMesh(geom, pipeline.materials.get({
      cls: 'lacquer',
      pigment: 'cinnabar',
    }));
    const skel = makeSkeleton();
    figure.add(skel.bones[0]);
    figure.bind(skel, new THREE.Matrix4());
    figure.position.y = 0.25;
    figure.castShadow = true;
    scene.add(figure);

    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(4, 0.1, 4),
      pipeline.materials.get({ cls: 'silk', pigment: 'gamboge' }),
    );
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    scene.add(ground);

    attachOutlines(scene, pipeline.materials);

    // A three-part "figure" carrying per-vertex material codes, collapsed to a
    // single atlas draw call and its single atlas hull. This exercises the
    // whole path end to end — merge, skinning through the merged geometry, the
    // parameter table read in both the vertex and fragment stages, and the
    // layered tooth array — inside the real pipeline rather than in isolation.
    const figureRoot = new THREE.Group();
    figureRoot.position.x = -0.9;
    const skel2 = makeSkeleton();
    figureRoot.add(skel2.bones[0]);
    for (const [i, code] of [
      codeFor('lacquer', 'cinnabar'),
      codeFor('gold', 'gold'),
      codeFor('cloth', 'indigo'),
    ].entries()) {
      const g = decorate(makeGeometry(), code);
      const vn = g.getAttribute('position').count;
      const si = new Uint16Array(vn * 4);
      const sw = new Float32Array(vn * 4);
      for (let k = 0; k < vn; k++) sw[k * 4] = 1;
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      g.translate(0, i * 0.45, 0);
      const part = new THREE.SkinnedMesh(
        g,
        pipeline.materials.get({ cls: 'lacquer', pigment: 'cinnabar' }),
      );
      part.bind(skel2, new THREE.Matrix4());
      part.castShadow = true;
      figureRoot.add(part);
    }
    scene.add(figureRoot);
    const collapses = collapseToAtlas(figureRoot, pipeline.materials, { variation: 0.2 });
    notes.push(
      `atlas collapse: ${collapses.length} group(s), ` +
        `${collapses.reduce((a, c) => a + c.replaced, 0)} meshes folded, ` +
        `hull ${collapses[0]?.hull ? 'built' : 'MISSING'}`,
    );

    // Two frames: the first builds render targets and compiles, the second is
    // the one measured, which is also how the capture harness works.
    pipeline.render(scene, camera, 1 / 60);
    renderer.info.reset();
    pipeline.render(scene, camera, 1 / 60);

    drawCalls = pipeline.stats.total;
    triangles = pipeline.stats.triangles;
    notes.push(
      `passes: shadow ${pipeline.stats.shadow}, prepass ${pipeline.stats.prepass}, ` +
        `main ${pipeline.stats.main}, post ${pipeline.stats.post}`,
    );

    const gl2 = renderer.getContext();
    const px = new Uint8Array(160 * 120 * 4);
    gl2.readPixels(0, 0, 160, 120, gl2.RGBA, gl2.UNSIGNED_BYTE, px);

    const seen = new Set<number>();
    let bgLike = 0;
    for (let i = 0; i < px.length; i += 4) {
      seen.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
      if (px[i] < 24 && px[i + 1] < 24 && px[i + 2] < 24) bgLike++;
    }
    distinct = seen.size;
    coverage = 1 - bgLike / (160 * 120);


    pipeline.dispose();
  } catch (e) {
    errors.push(`THREW: ${String((e as Error)?.stack ?? e)}`);
  } finally {
    console.error = realError;
  }

  const shaderErrors = distil(errors);
  return {
    // A frame with fewer than eight distinct colours is a frame where the
    // quantiser produced nothing: four bands x a couple of surfaces plus the
    // paper grain should always beat that comfortably.
    ok: shaderErrors.length === 0 && distinct >= 8 && coverage > 0.05,
    notes,
    distinctColours: distinct,
    coverage,
    drawCalls,
    triangles,
    errors: shaderErrors,
  };
}

declare global {
  interface Window {
    __RENDER_BRINGUP?: BringupReport | { error: string };
  }
}

runBringup()
  .then((r) => {
    window.__RENDER_BRINGUP = r;
  })
  .catch((e: unknown) => {
    window.__RENDER_BRINGUP = { error: String((e as Error)?.stack ?? e) };
  });
