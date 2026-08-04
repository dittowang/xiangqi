/**
 * Static validation of the render subsystem.
 *
 *   npx tsx src/render/selfcheck.ts
 *
 * WHAT THIS CAN AND CANNOT DO — stated first, because the gap matters.
 *
 * There is no way to compile a GLSL program in node: it needs a real driver,
 * and headless Chromium is not available here. So this script cannot tell you
 * that the shaders compile. What it CAN do is catch every class of mistake that
 * a compile would have caught for free and that is otherwise invisible until
 * someone opens a browser:
 *
 *   1. unbalanced braces, parentheses and preprocessor conditionals in any
 *      composed shader — the failure mode of assembling shaders from template
 *      strings;
 *   2. a uniform used in GLSL but never declared, or declared but missing from
 *      the material's JS uniform map (three silently skips those, so the symptom
 *      is a surface shaded as if the value were zero, with no error anywhere);
 *   3. a uniform in the JS map that no shader declares — dead weight, and
 *      usually the trace of a rename that only got done on one side;
 *   4. a helper function called before it is defined, which is what happens when
 *      the order of the composed GLSL blocks is wrong. GLSL has no forward
 *      declarations, so this is a hard compile error in the browser and a silent
 *      one here without this check;
 *   5. a varying read in the fragment shader that the vertex shader does not
 *      write, or writes with a different type;
 *   6. ramp atlas dimensions, finiteness, range, band-index integrity, and that
 *      each band edge actually lands where core/palette.ts asked for it;
 *   7. procedural textures generating at the right size, with real variance,
 *      and TILING — the seam continuity test is the only way to catch a
 *      non-periodic noise field short of looking at a wrapped surface;
 *   8. the two pieces of geometry maths that are easy to get subtly wrong and
 *      impossible to eyeball: the CSM slice-sphere fit, and the constant
 *      screen-width outline push. Both are verified numerically against real
 *      three projection matrices.
 *
 * Everything that needs a GPU frame — that the bands read as pigment, that the
 * hull and the Sobel do not double, that the silk wash is the right strength —
 * is out of reach from here and is listed as such in the report.
 */

import * as THREE from 'three';
import {
  OUTLINES,
  PIGMENT_NAMES,
  RAMPS,
  type MaterialClass,
  type PigmentName,
} from '@core/palette.ts';
import { CascadedShadowMaps } from './csm.ts';
import { createGradeMaterial, createLinesMaterial } from './composer.ts';
import { GongbiMaterialLibrary, gongbiInfo } from './gongbi.ts';
import { ensureSmoothNormals, SMOOTH_NORMAL_ATTRIBUTE } from './outline.ts';
import {
  ATLAS_CODE_STRIDE,
  MATERIAL_CLASSES,
  PARAM_WIDTH,
  RAMP_ROWS,
  RAMP_WIDTH,
  bakeRampRow,
  buildRampAtlas,
  codeFor,
  rampRowIndex,
  rowForCode,
} from './ramps.ts';
import { SilkWash } from './silk.ts';
import {
  TEXTURE_KINDS,
  TOOTH_LAYERS,
  generateField,
  textureSize,
  type TextureKind,
} from './textures.ts';

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

let failures = 0;
let checks = 0;
const notes: string[] = [];

function ok(cond: boolean, label: string, detail = ''): void {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function note(s: string): void {
  notes.push(s);
}

// ---------------------------------------------------------------------------
// GLSL analysis
// ---------------------------------------------------------------------------

/** Resolve three's `#include <chunk>` the way WebGLProgram does. */
function resolveIncludes(src: string, depth = 0): string {
  if (depth > 8) return src;
  return src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (match, name: string) => {
    const chunk = (THREE.ShaderChunk as Record<string, string>)[name];
    if (chunk === undefined) {
      note(`unknown ShaderChunk <${name}> — left in place`);
      return match;
    }
    return resolveIncludes(chunk, depth + 1);
  });
}

/**
 * Evaluate the preprocessor conditionals the way the driver will.
 *
 * Without this the audit reads BOTH arms of every `#ifdef` as live code, so it
 * reports the atlas path's helpers as undefined in the per-uniform hull (where
 * the whole branch is preprocessed away) and misses anything wrong inside a
 * branch that IS taken. Since `USE_SKINNING` and `USE_INSTANCING` come from the
 * object rather than from the material, every material is audited once per
 * relevant define set — a shader can be correct on a Mesh and broken on a
 * SkinnedMesh, and the cast is entirely SkinnedMeshes.
 *
 * Only the forms this project actually uses are handled: #ifdef, #ifndef,
 * #if defined(X), #else, #endif. Anything else keeps both arms, which is the
 * conservative direction — a false pass is worse than a false failure here.
 */
function preprocess(src: string, defines: Set<string>): string {
  const out: string[] = [];
  // Each entry: [thisBranchLive, anyBranchTakenYet, understood]
  const stack: { live: boolean; taken: boolean; known: boolean }[] = [];
  const live = (): boolean => stack.every((f) => f.live);

  for (const line of src.split('\n')) {
    const t = line.trim();
    let m: RegExpMatchArray | null;

    if ((m = t.match(/^#ifdef\s+(\w+)/))) {
      const on = defines.has(m[1]);
      stack.push({ live: on, taken: on, known: true });
      continue;
    }
    if ((m = t.match(/^#ifndef\s+(\w+)/))) {
      const on = !defines.has(m[1]);
      stack.push({ live: on, taken: on, known: true });
      continue;
    }
    if ((m = t.match(/^#if\s+defined\s*\(\s*(\w+)\s*\)\s*$/))) {
      const on = defines.has(m[1]);
      stack.push({ live: on, taken: on, known: true });
      continue;
    }
    if (/^#if\b/.test(t)) {
      stack.push({ live: true, taken: true, known: false });
      continue;
    }
    if (/^#else\b/.test(t)) {
      const f = stack[stack.length - 1];
      if (f) f.live = f.known ? !f.taken : true;
      continue;
    }
    if (/^#elif\b/.test(t)) {
      const f = stack[stack.length - 1];
      if (f) f.live = !f.known;
      continue;
    }
    if (/^#endif\b/.test(t)) {
      stack.pop();
      continue;
    }
    if (live()) out.push(line);
  }
  return out.join('\n');
}

/** Strip // and block comments, and string-like content. GLSL has no strings. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

interface Balance {
  ok: boolean;
  detail: string;
}

function checkBalance(src: string): Balance {
  const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
  const stack: string[] = [];
  let line = 1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') line++;
    else if (c === '{' || c === '(' || c === '[') stack.push(c);
    else if (c === '}' || c === ')' || c === ']') {
      const want = pairs[c];
      const got = stack.pop();
      if (got !== want) {
        return { ok: false, detail: `line ${line}: '${c}' closes '${got ?? 'nothing'}'` };
      }
    }
  }
  return stack.length === 0
    ? { ok: true, detail: '' }
    : { ok: false, detail: `${stack.length} unclosed '${stack[stack.length - 1]}'` };
}

function checkPreprocessor(src: string): Balance {
  let depth = 0;
  let line = 0;
  for (const raw of src.split('\n')) {
    line++;
    const t = raw.trim();
    if (/^#if(def|ndef)?\b/.test(t)) depth++;
    else if (/^#endif\b/.test(t)) {
      depth--;
      if (depth < 0) return { ok: false, detail: `line ${line}: #endif without #if` };
    }
  }
  return depth === 0 ? { ok: true, detail: '' } : { ok: false, detail: `${depth} unclosed #if` };
}

const UNIFORM_DECL = /\buniform\s+(?:highp|mediump|lowp\s+)?(\w+)\s+(\w+)\s*(\[[^\]]*\])?\s*;/g;
/** Our convention: every uniform we own is `uXxx`. Built-ins never are. */
const OUR_UNIFORM_USE = /\bu[A-Z]\w*/g;

function declaredUniforms(src: string): Map<string, string> {
  const out = new Map<string, string>();
  UNIFORM_DECL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = UNIFORM_DECL.exec(src))) out.set(m[2], m[1]);
  return out;
}

function usedOurUniforms(src: string): Set<string> {
  const out = new Set<string>();
  // Remove the declarations themselves so a declared-but-unused uniform does
  // not count as "used" and mask a genuine typo elsewhere.
  const body = src.replace(UNIFORM_DECL, ' ');
  const m = body.match(OUR_UNIFORM_USE);
  if (m) for (const name of m) out.add(name);
  return out;
}

const FN_DEF = /^\s*(?:highp\s+|mediump\s+|lowp\s+)?(?:void|float|int|bool|vec2|vec3|vec4|mat2|mat3|mat4|ivec2|ivec3|ivec4)\s+(xq\w+)\s*\(/gm;
const FN_CALL = /\b(xq\w+)\s*\(/g;

/** Every xq* helper must be DEFINED before its first call: GLSL has no
 *  forward declarations, so a wrong compose order is a hard compile error. */
function checkFunctionOrder(src: string, label: string): void {
  const defAt = new Map<string, number>();
  FN_DEF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FN_DEF.exec(src))) {
    if (!defAt.has(m[1])) defAt.set(m[1], m.index);
  }
  FN_CALL.lastIndex = 0;
  const complained = new Set<string>();
  while ((m = FN_CALL.exec(src))) {
    const name = m[1];
    if (complained.has(name)) continue;
    const at = defAt.get(name);
    if (at === undefined) {
      complained.add(name);
      ok(false, `${label}: xq function order`, `${name}() is called but never defined`);
    } else if (m.index < at) {
      complained.add(name);
      ok(false, `${label}: xq function order`, `${name}() called before its definition`);
    }
  }
}

const VARYING_DECL = /\bvarying\s+(\w+)\s+(\w+)\s*;/g;

function varyings(src: string): Map<string, string> {
  const out = new Map<string, string>();
  VARYING_DECL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VARYING_DECL.exec(src))) out.set(m[2], m[1]);
  return out;
}

/**
 * Define sets to audit each material under. three sets `USE_SKINNING` and
 * `USE_INSTANCING` from the OBJECT, so one material compiles into several
 * programs and each one has to be checked.
 */
const SHAPE_DEFINES: readonly (readonly string[])[] = [[], ['USE_SKINNING'], ['USE_INSTANCING']];

function auditMaterial(label: string, mat: THREE.ShaderMaterial): void {
  for (const shape of SHAPE_DEFINES) {
    const defines = new Set<string>([...Object.keys(mat.defines ?? {}), ...shape]);
    auditOnce(shape.length ? `${label} <${shape.join(',')}>` : label, mat, defines);
  }
}

function auditOnce(label: string, mat: THREE.ShaderMaterial, defines: Set<string>): void {
  const vert = preprocess(stripComments(resolveIncludes(mat.vertexShader)), defines);
  const frag = preprocess(stripComments(resolveIncludes(mat.fragmentShader)), defines);

  for (const [stage, src] of [
    ['vertex', stripComments(resolveIncludes(mat.vertexShader))],
    ['fragment', stripComments(resolveIncludes(mat.fragmentShader))],
  ] as const) {
    const p = checkPreprocessor(src);
    ok(p.ok, `${label} ${stage}: balanced #if/#endif`, p.detail);
  }

  for (const [stage, src] of [
    ['vertex', vert],
    ['fragment', frag],
  ] as const) {
    const b = checkBalance(src);
    ok(b.ok, `${label} ${stage}: balanced braces`, b.detail);
    checkFunctionOrder(src, `${label} ${stage}`);
  }

  const declV = declaredUniforms(vert);
  const declF = declaredUniforms(frag);
  const provided = new Set(Object.keys(mat.uniforms ?? {}));

  // PER STAGE, not on the union of both.
  //
  // A uniform declared in the vertex shader is invisible to the fragment
  // shader: they are separate translation units and the link step only joins
  // uniforms each stage declared for itself. Checking the union passes happily
  // on a program where the outline colour is declared in the vertex and used in
  // the fragment — which is exactly the bug that made every surface and hull
  // variant fail its first real compile, and which this check was blind to.
  //
  // A duplicate declaration across stages is fine and normal, so this is a
  // one-directional test per stage.
  for (const [stage, src, decl] of [
    ['vertex', vert, declV],
    ['fragment', frag, declF],
  ] as const) {
    for (const name of usedOurUniforms(src)) {
      ok(
        decl.has(name),
        `${label} ${stage}: '${name}' used`,
        `not declared in the ${stage} stage (declared in the other stage does NOT count)`,
      );
    }
    // A uniform declared in both stages must agree on type, or the link fails.
    for (const [name, type] of decl) {
      const other = stage === 'vertex' ? declF.get(name) : declV.get(name);
      if (other !== undefined) {
        ok(other === type, `${label}: '${name}' type agrees across stages`, `${type} vs ${other}`);
      }
    }
  }

  const declared = new Map([...declV, ...declF]);
  for (const [name] of declared) {
    if (!/^u[A-Z]/.test(name)) continue; // three's own (bindMatrix, boneTexture)
    ok(provided.has(name), `${label}: '${name}' declared`, 'missing from material.uniforms');
  }
  for (const name of provided) {
    ok(declared.has(name), `${label}: uniforms['${name}']`, 'declared by no shader stage');
  }

  // Duplicate declaration WITHIN one stage is a hard compile error, and it is
  // easy to reach by composing two chunks that both declare the same uniform.
  for (const [stage, src] of [
    ['vertex', stripComments(resolveIncludes(mat.vertexShader))],
    ['fragment', stripComments(resolveIncludes(mat.fragmentShader))],
  ] as const) {
    const p = checkPreprocessor(src);
    ok(p.ok, `${label} ${stage}: balanced #if/#endif`, p.detail);
  }

  for (const [stage, src] of [
    ['vertex', vert],
    ['fragment', frag],
  ] as const) {
    const counts = new Map<string, number>();
    UNIFORM_DECL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = UNIFORM_DECL.exec(src))) counts.set(m[2], (counts.get(m[2]) ?? 0) + 1);
    for (const [name, n] of counts) {
      ok(n === 1, `${label} ${stage}: '${name}' declared once`, `declared ${n} times`);
    }
  }

  // Attributes we own must be declared in the vertex stage; three injects only
  // position/normal/uv/skinIndex/skinWeight/instanceMatrix.
  for (const name of vert.match(/\ba[A-Z]\w*/g) ?? []) {
    if (!/^a[A-Z]/.test(name)) continue;
    ok(
      new RegExp(`\\b(attribute|in)\\s+\\w+\\s+${name}\\s*;`).test(vert),
      `${label} vertex: attribute '${name}' declared`,
    );
  }

  // `flat` interpolants bypass the `varying` macro, so they need their own
  // matching check: a flat out with no flat in (or vice versa) links but reads
  // garbage.
  const flatOut = new Set([...vert.matchAll(/\bflat\s+out\s+(\w+)\s+(\w+)\s*;/g)].map((m) => m[2]));
  const flatIn = [...frag.matchAll(/\bflat\s+in\s+(\w+)\s+(\w+)\s*;/g)];
  for (const m of flatIn) {
    ok(flatOut.has(m[2]), `${label}: flat varying '${m[2]}'`, 'read in fragment, never written');
  }

  // A varying the fragment reads must be written by the vertex, with the same
  // type. three links these by name; a mismatch is a link error in the browser.
  const vv = varyings(vert);
  const fv = varyings(frag);
  for (const [name, type] of fv) {
    const src = vv.get(name);
    ok(src !== undefined, `${label}: varying ${name}`, 'read in fragment, never written');
    if (src !== undefined) {
      ok(src === type, `${label}: varying ${name} type`, `vertex ${src} vs fragment ${type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Shaders
// ---------------------------------------------------------------------------

function checkShaders(): void {
  section('shaders — every composed variant');

  const lib = new GongbiMaterialLibrary();
  const seenPrepass = new Set<string>();
  let surfaces = 0;
  let hulls = 0;

  for (const cls of MATERIAL_CLASSES) {
    for (const pigment of PIGMENT_NAMES) {
      const req = { cls, pigment, variation: 0.25, glow: 0.5 } as const;
      const surface = lib.get(req) as THREE.ShaderMaterial;
      auditMaterial(`surface:${cls}/${pigment}`, surface);
      surfaces++;

      const info = gongbiInfo(surface)!;
      if (!seenPrepass.has(info.prepass.name)) {
        seenPrepass.add(info.prepass.name);
        auditMaterial(info.prepass.name, info.prepass);
      }

      const hull = lib.outline(req) as THREE.ShaderMaterial | null;
      if (hull) {
        auditMaterial(`hull:${cls}/${pigment}`, hull);
        hulls++;
        const hi = gongbiInfo(hull)!;
        if (!seenPrepass.has(hi.prepass.name)) {
          seenPrepass.add(hi.prepass.name);
          auditMaterial(hi.prepass.name, hi.prepass);
        }
      }
    }
  }

  // The instanced and double-sided variants compile different defines.
  const variant = lib.get({
    cls: 'lacquer',
    pigment: 'cinnabar',
    instanced: true,
    doubleSided: true,
  } as never) as THREE.ShaderMaterial;
  auditMaterial('surface:instanced+doubleSided', variant);

  // The atlas path: one material for a whole figure, class and pigment
  // per-vertex.
  auditMaterial('atlas:surface', lib.getAtlas());
  auditMaterial('atlas:surface variation', lib.getAtlas({ variation: 0.3, glow: 0.5 }));
  auditMaterial('atlas:hull', lib.outlineAtlas());
  auditMaterial('atlas:hull prepass', gongbiInfo(lib.outlineAtlas())!.prepass);
  ok(
    lib.getAtlas() === lib.getAtlas(),
    'identical atlas requests share one material instance',
  );

  auditMaterial('post:lines', createLinesMaterial());
  auditMaterial(
    'post:grade',
    createGradeMaterial({
      key: 'wide',
      keyColour: '#FFF0CE',
      fillColour: '#7E9BC0',
      bounceColour: '#B98E52',
      keyIntensity: 2.55,
      fillIntensity: 0.72,
      keyElevation: 0.86,
      keyAzimuth: -0.62,
      shadowStretch: 1,
      gradeTint: '#E9C664',
      gradeAmount: 0.05,
    }),
  );

  // `silk` has outline 'none' in RAMPS, so it must produce no hull at all.
  ok(lib.outline({ cls: 'silk', pigment: 'gamboge' }) === null, 'silk class yields no hull');

  // Identical requests must share one instance — the contract's own words.
  const a = lib.get({ cls: 'gold', pigment: 'gold', variation: 0.3 });
  const b = lib.get({ cls: 'gold', pigment: 'gold', variation: 0.3 });
  ok(a === b, 'identical requests share one material instance');
  const c = lib.get({ cls: 'gold', pigment: 'gold', variation: -0.3 });
  ok(a !== c, 'differing variation yields a distinct material');

  // A continuously animated glow must not spawn a material per frame.
  const before = lib.materialCount;
  for (let i = 0; i < 500; i++) {
    lib.get({ cls: 'lacquer', pigment: 'cinnabar', glow: i / 500 });
  }
  const spawned = lib.materialCount - before;
  ok(spawned <= 17, 'animated glow is quantised in the cache key', `spawned ${spawned}`);

  // Frame-global uniforms MUST be shared by reference across every material, or
  // `update()` becomes O(materials) per frame and a resize touches hundreds of
  // objects. Identity, not equality — an accidental structuredClone or spread
  // of the VALUE would still compare equal and would silently stop propagating.
  const m1 = lib.get({ cls: 'cloth', pigment: 'indigo' }) as THREE.ShaderMaterial;
  const m2 = lib.get({ cls: 'iron', pigment: 'stone' }) as THREE.ShaderMaterial;
  for (const name of ['uViewportPx', 'uKeyDir', 'uCsmMatrix0', 'uSilhouette', 'uSilkGain']) {
    ok(
      m1.uniforms[name] === m2.uniforms[name],
      `shared uniform '${name}' is one object across materials`,
    );
  }
  // Per-material uniforms must NOT be shared, or every soldier would take the
  // last one's pigment.
  for (const name of ['uRampRow', 'uRim', 'uSilkWash']) {
    ok(m1.uniforms[name] !== m2.uniforms[name], `per-material uniform '${name}' is distinct`);
  }
  // The prepass twin is shared, not per material: it has no per-material input.
  ok(
    gongbiInfo(m1)!.prepass === gongbiInfo(m2)!.prepass,
    'surface materials share one prepass twin',
  );

  console.log(
    `  ${surfaces} surface variants, ${hulls} hull variants, ${seenPrepass.size} prepass variants audited`,
  );
  lib.dispose();
}

// ---------------------------------------------------------------------------
// 2. Ramps
// ---------------------------------------------------------------------------

function checkRamps(): void {
  section('ramps — the mineral-pigment quantiser');

  const atlas = buildRampAtlas();
  const data = atlas.image.data as Float32Array;

  ok(atlas.image.width === RAMP_WIDTH, 'atlas width', `${atlas.image.width}`);
  ok(atlas.image.height === RAMP_ROWS, 'atlas height', `${atlas.image.height}`);
  ok(RAMP_ROWS === MATERIAL_CLASSES.length * PIGMENT_NAMES.length, 'row count = classes x pigments');
  ok(data.length === RAMP_WIDTH * RAMP_ROWS * 4, 'atlas buffer length', `${data.length}`);
  ok(atlas.magFilter === THREE.NearestFilter, 'magFilter is NEAREST');
  ok(atlas.minFilter === THREE.NearestFilter, 'minFilter is NEAREST');
  ok(atlas.generateMipmaps === false, 'no mipmaps');
  ok(atlas.flipY === false, 'flipY off');

  let nonFinite = 0;
  let outOfRange = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) nonFinite++;
    else if (v < -1e-6 || v > 1 + 1e-6) outOfRange++;
  }
  ok(nonFinite === 0, 'no NaN or Inf anywhere in the atlas', `${nonFinite} bad texels`);
  ok(outOfRange === 0, 'every channel within [0,1]', `${outOfRange} out of range`);

  // Per-row structure.
  const row = new Float32Array(RAMP_WIDTH * 4);
  for (const cls of MATERIAL_CLASSES as MaterialClass[]) {
    const spec = RAMPS[cls];
    for (const pigment of PIGMENT_NAMES as PigmentName[]) {
      bakeRampRow(cls, pigment, row, 0);
      const tag = `${cls}/${pigment}`;

      // Band index must be an integer in [0, steps-1] and never decrease.
      let prev = -1;
      let transitions = 0;
      let bad = 0;
      for (let i = 0; i < RAMP_WIDTH; i++) {
        const packed = row[i * 4 + 3];
        const idx = Math.floor(packed * 4);
        if (idx < 0 || idx > spec.steps - 1) bad++;
        if (Math.abs(packed * 4 - idx - 0.5) > 1e-5) bad++;
        if (prev >= 0 && idx !== prev) {
          if (idx < prev) bad++;
          transitions++;
        }
        prev = idx;
      }
      ok(bad === 0, `${tag}: band index is a clean, monotonic integer`, `${bad} bad texels`);
      ok(
        transitions === spec.steps - 1,
        `${tag}: exactly steps-1 band transitions`,
        `${transitions} vs ${spec.steps - 1}`,
      );

      // Each transition must land within one texel of the authored threshold.
      let t = 0;
      prev = Math.floor(row[3] * 4);
      for (let i = 1; i < RAMP_WIDTH; i++) {
        const idx = Math.floor(row[i * 4 + 3] * 4);
        if (idx !== prev) {
          const ndl = (i + 0.5) / RAMP_WIDTH;
          const want = spec.thresholds[t];
          ok(
            Math.abs(ndl - want) <= 1.5 / RAMP_WIDTH,
            `${tag}: band edge ${t} lands on its threshold`,
            `at ${ndl.toFixed(4)}, wanted ${want}`,
          );
          t++;
          prev = idx;
        }
      }

      // The edge must be HARD. Measure how many texels the colour takes to
      // cross from one band's plateau to the next: the whole point of the
      // system is that this is a handful of texels, not a smooth ramp.
      const softest = spec.edgeSoftness;
      const allowedTexels = Math.ceil(softest * RAMP_WIDTH) + 2;
      let longestRun = 0;
      let run = 0;
      for (let i = 1; i < RAMP_WIDTH; i++) {
        const d =
          Math.abs(row[i * 4] - row[(i - 1) * 4]) +
          Math.abs(row[i * 4 + 1] - row[(i - 1) * 4 + 1]) +
          Math.abs(row[i * 4 + 2] - row[(i - 1) * 4 + 2]);
        if (d > 1e-6) {
          run++;
          longestRun = Math.max(longestRun, run);
        } else {
          run = 0;
        }
      }
      ok(
        longestRun <= allowedTexels,
        `${tag}: band edges stay hard`,
        `widest transition ${longestRun} texels, allowed ${allowedTexels}`,
      );

      // The row must actually be four (or three) FLAT fields, not a gradient:
      // the fraction of texels that differ from their neighbour has to be tiny.
      let changing = 0;
      for (let i = 1; i < RAMP_WIDTH; i++) {
        if (Math.abs(row[i * 4] - row[(i - 1) * 4]) > 1e-6) changing++;
      }
      ok(
        changing / RAMP_WIDTH < 0.2,
        `${tag}: the row is flat fields, not a falloff`,
        `${((changing / RAMP_WIDTH) * 100).toFixed(1)}% of texels are transitional`,
      );
    }
  }

  // The value ladder: at a given band index, every pigment should sit at a
  // similar luminance. That shared ladder is what stops the two armies tearing
  // a frame in half, and it is worth knowing the number rather than trusting it.
  for (let band = 0; band < 3; band++) {
    const lumas: number[] = [];
    for (const pigment of PIGMENT_NAMES as PigmentName[]) {
      bakeRampRow('cloth', pigment, row, 0);
      // Sample the middle of band `band` by walking to its plateau.
      let seen = -1;
      let at = 0;
      for (let i = 0; i < RAMP_WIDTH; i++) {
        const idx = Math.floor(row[i * 4 + 3] * 4);
        if (idx === band) {
          if (seen !== band) seen = band;
          at = i;
        }
      }
      if (seen !== band) continue;
      lumas.push(0.2126 * row[at * 4] + 0.7152 * row[at * 4 + 1] + 0.0722 * row[at * 4 + 2]);
    }
    if (lumas.length > 1) {
      const lo = Math.min(...lumas);
      const hi = Math.max(...lumas);
      note(
        `value ladder, cloth band ${band}: linear luma ${lo.toFixed(4)} … ${hi.toFixed(4)} ` +
          `(spread ${(hi - lo).toFixed(4)} across ${lumas.length} pigments)`,
      );
    }
  }

  atlas.dispose();
}

// ---------------------------------------------------------------------------
// 3. Procedural textures
// ---------------------------------------------------------------------------

/**
 * The parameter table, and the encoding contract with characters/.
 *
 * The contract is checked by READING characters/factory.ts as text rather than
 * importing it. ARCHITECTURE.md forbids render importing characters, and a
 * static import would also make this subsystem fail to typecheck whenever that
 * one was mid-edit — which it was, twice, while this was being written. Reading
 * the source costs nothing, creates no edge anywhere, and fails loudly the day
 * either side reorders its list. Silent drift would repaint every figure in the
 * wrong pigment, with the cause four subsystems away from the symptom.
 */
async function checkAtlas(): Promise<void> {
  section('atlas — parameter table and the characters/ encoding contract');

  const lib = new GongbiMaterialLibrary();
  const table = lib.paramTable;
  const data = table.image.data as Float32Array;

  ok(table.image.width === PARAM_WIDTH, 'param table width', `${table.image.width}`);
  ok(table.image.height === RAMP_ROWS, 'param table height', `${table.image.height}`);
  ok(table.magFilter === THREE.NearestFilter, 'param table is NEAREST');
  ok(table.generateMipmaps === false, 'param table has no mipmaps');

  let bad = 0;
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) bad++;
  ok(bad === 0, 'no NaN or Inf in the parameter table', `${bad} bad values`);

  // Every row must carry the values the art direction actually asked for.
  for (const cls of MATERIAL_CLASSES as MaterialClass[]) {
    const spec = RAMPS[cls];
    const profile = OUTLINES[spec.outline];
    for (const pigment of PIGMENT_NAMES as PigmentName[]) {
      const o = rampRowIndex(cls, pigment) * PARAM_WIDTH * 4;
      const tag = `${cls}/${pigment}`;
      ok(Math.abs(data[o + 3] - spec.rim) < 1e-6, `${tag}: rim matches RampSpec`);
      ok(Math.abs(data[o + 7] - spec.silkWash) < 1e-6, `${tag}: silkWash matches RampSpec`);
      ok(Math.abs(data[o + 11] - profile.tint) < 1e-6, `${tag}: outline tint matches profile`);
      ok(Math.abs(data[o + 14] - profile.widthPx) < 1e-6, `${tag}: outline width matches profile`);
      ok(Math.abs(data[o + 15] - spec.steps) < 1e-6, `${tag}: step count matches RampSpec`);
      ok(Math.abs(data[o + 16] - profile.fadeStart) < 1e-6, `${tag}: fadeStart matches profile`);
      ok(Math.abs(data[o + 17] - profile.fadeEnd) < 1e-6, `${tag}: fadeEnd matches profile`);
      const layer = data[o + 18];
      ok(
        Number.isInteger(layer) && layer >= 0 && layer < TOOTH_LAYERS.length,
        `${tag}: tooth layer index is in range`,
        `${layer}`,
      );
      // The row the shader computes from the code must be the row we baked.
      ok(
        rowForCode(codeFor(cls, pigment)) === rampRowIndex(cls, pigment),
        `${tag}: code round-trips to its own row`,
      );
    }
  }

  // --- the cross-subsystem contract ---------------------------------------
  const spec = (m: string): string => m;
  let source: string | null = null;
  try {
    const fs = (await import(spec('node:fs'))) as unknown as {
      readFileSync(p: string, e: string): string;
    };
    source = fs.readFileSync('src/characters/factory.ts', 'utf8');
  } catch {
    note('characters/factory.ts unreadable — encoding contract NOT verified');
  }

  if (source) {
    const grab = (name: string): string[] | null => {
      const m = source!.match(new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`));
      if (!m) return null;
      return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };
    const theirClasses = grab('MATERIAL_CLASS_ORDER');
    const theirPigments = grab('PIGMENT_ORDER');

    ok(theirClasses !== null, 'characters exports MATERIAL_CLASS_ORDER');
    ok(theirPigments !== null, 'characters exports PIGMENT_ORDER');

    if (theirClasses) {
      ok(
        theirClasses.join(',') === (MATERIAL_CLASSES as string[]).join(','),
        'class order agrees with characters/factory.ts',
        `theirs [${theirClasses.join(',')}] vs ours [${(MATERIAL_CLASSES as string[]).join(',')}]`,
      );
    }
    if (theirPigments) {
      ok(
        theirPigments.join(',') === (PIGMENT_NAMES as string[]).join(','),
        'pigment order agrees with characters/factory.ts',
        `theirs [${theirPigments.join(',')}] vs ours [${(PIGMENT_NAMES as string[]).join(',')}]`,
      );
    }

    // And the stride, which is the other half of the encoding.
    const strideMatch = source.match(/classIndex\s*\*\s*(\d+)\s*\+\s*pigmentIndex/);
    const theirStride = strideMatch ? Number(strideMatch[1]) : null;
    ok(
      theirStride === ATLAS_CODE_STRIDE,
      'aMaterial stride agrees with characters/factory.ts',
      `theirs ${theirStride} vs ours ${ATLAS_CODE_STRIDE}`,
    );
    // The stride must also leave room for every pigment, or two classes would
    // alias onto each other's rows.
    ok(
      ATLAS_CODE_STRIDE >= PIGMENT_NAMES.length,
      'stride leaves room for every pigment',
      `${ATLAS_CODE_STRIDE} vs ${PIGMENT_NAMES.length}`,
    );
  }

  lib.dispose();
}

function checkTextures(): void {
  section('textures — procedural fields');

  for (const kind of TEXTURE_KINDS as TextureKind[]) {
    const size = textureSize(kind);
    const t0 = Date.now();
    const data = generateField(kind, size);
    const ms = Date.now() - t0;

    ok(data.length === size * size * 4, `${kind}: buffer length`, `${data.length}`);

    // Statistics on the primary channel.
    let min = 255;
    let max = 0;
    let sum = 0;
    let nonFinite = 0;
    for (let i = 0; i < data.length; i += 4) {
      const v = data[i];
      if (!Number.isFinite(v)) nonFinite++;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    const mean = sum / (size * size);
    ok(nonFinite === 0, `${kind}: no NaN in the primary channel`);
    ok(max - min > 24, `${kind}: field has real variance`, `range ${min}..${max}`);
    ok(mean > 8 && mean < 248, `${kind}: field is not clipped flat`, `mean ${mean.toFixed(1)}`);
    ok(data[3] === 255, `${kind}: alpha is opaque`);

    // TILING, on BOTH axes. Compare the discontinuity across each wrap seam
    // against the typical neighbour-to-neighbour difference inside the field.
    // A non-periodic generator shows up here as a seam several times sharper
    // than the interior, and nowhere else until someone wraps it on a mesh.
    //
    // Testing X alone is not enough: an anisotropic field (timber fibre, cloth
    // slubs) can tile perfectly across the grain and fail along it, because the
    // two axes run at different frequencies and it is easy to give them the
    // same lattice period by accident.
    for (const axis of ['x', 'y'] as const) {
      let seam = 0;
      let interior = 0;
      for (let i = 0; i < size; i++) {
        if (axis === 'x') {
          seam += Math.abs(data[(i * size + size - 1) * 4] - data[i * size * 4]);
          const j = (i * 7919) % (size - 1);
          interior += Math.abs(data[(i * size + j) * 4] - data[(i * size + j + 1) * 4]);
        } else {
          seam += Math.abs(data[((size - 1) * size + i) * 4] - data[i * 4]);
          const j = (i * 7919) % (size - 1);
          interior += Math.abs(data[(j * size + i) * 4] - data[((j + 1) * size + i) * 4]);
        }
      }
      seam /= size;
      interior /= size;
      const ratio = interior > 0.01 ? seam / interior : seam;
      ok(
        ratio < 3.0,
        `${kind}: tiles across the ${axis} wrap seam`,
        `seam step ${seam.toFixed(2)} vs interior ${interior.toFixed(2)} (ratio ${ratio.toFixed(2)})`,
      );
    }

    note(`${kind}: ${size}x${size} generated in ${ms} ms, mean ${mean.toFixed(1)}, range ${min}..${max}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Outline maths
// ---------------------------------------------------------------------------

function checkOutlineMaths(): void {
  section('outline — welded normals and the constant-width push');

  // A box is the worst case for the hull: 24 vertices, three normals per
  // corner, and a shell that tears at every one of them if the weld is wrong.
  const box = new THREE.BoxGeometry(1, 1, 1);
  ensureSmoothNormals(box);
  const attr = box.getAttribute(SMOOTH_NORMAL_ATTRIBUTE) as THREE.BufferAttribute;
  ok(!!attr, 'aSmoothNormal attribute created');
  ok(attr.count === box.getAttribute('position').count, 'one smoothed normal per vertex');

  const pos = box.getAttribute('position') as THREE.BufferAttribute;
  const byCorner = new Map<string, THREE.Vector3[]>();
  let unit = true;
  for (let i = 0; i < attr.count; i++) {
    const n = new THREE.Vector3(attr.getX(i), attr.getY(i), attr.getZ(i));
    if (Math.abs(n.length() - 1) > 1e-4) unit = false;
    const k = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    const list = byCorner.get(k) ?? [];
    list.push(n);
    byCorner.set(k, list);
  }
  ok(unit, 'every smoothed normal is unit length');

  let welded = true;
  let corners = 0;
  for (const list of byCorner.values()) {
    if (list.length < 2) continue;
    corners++;
    for (let i = 1; i < list.length; i++) {
      if (list[0].distanceTo(list[i]) > 1e-5) welded = false;
    }
  }
  ok(corners === 8, 'a box welds to 8 distinct corner positions', `${corners}`);
  ok(welded, 'split vertices at a corner share one smoothed normal');

  // Tessellation independence, the whole reason for angle weighting: every
  // corner of a cube must come out at exactly the body diagonal, whichever way
  // each face happened to be split into triangles. Area weighting gives
  // (0.816, 0.408, 0.408) here and pushes the hull sideways.
  for (const list of byCorner.values()) {
    const n = list[0];
    ok(
      Math.abs(Math.abs(n.x) - 0.5773503) < 1e-5 &&
        Math.abs(Math.abs(n.y) - 0.5773503) < 1e-5 &&
        Math.abs(Math.abs(n.z) - 0.5773503) < 1e-5,
      'cube corner normal is the body diagonal',
      `(${n.x.toFixed(5)}, ${n.y.toFixed(5)}, ${n.z.toFixed(5)})`,
    );
  }

  // The screen-width derivation, checked against a real projection matrix:
  // push a point by the offset the shader computes and confirm it lands the
  // requested number of pixels away in NDC.
  for (const [fov, aspect, height, depth, widthPx] of [
    [38, 16 / 9, 1080, 8, 2.35],
    [38, 16 / 9, 2160, 15.5, 2.35],
    [30, 4 / 3, 1440, 3.1, 1.15],
    [42, 21 / 9, 900, 4.2, 1.6],
  ] as const) {
    const cam = new THREE.PerspectiveCamera(fov, aspect, 0.1, 400);
    cam.updateProjectionMatrix();
    const p11 = cam.projectionMatrix.elements[5]; // column 1, row 1
    // The shader scales the authored CSS width by viewportHeight / 1080.
    const scaledPx = (widthPx * height) / 1080;
    const offset = (2 * scaledPx * depth) / (p11 * height);

    const base = new THREE.Vector4(0, 0, -depth, 1);
    const moved = new THREE.Vector4(0, offset, -depth, 1);
    base.applyMatrix4(cam.projectionMatrix);
    moved.applyMatrix4(cam.projectionMatrix);
    const dNdc = moved.y / moved.w - base.y / base.w;
    const dPx = dNdc * 0.5 * height;
    ok(
      Math.abs(dPx - scaledPx) < 1e-3,
      `hull push is ${scaledPx.toFixed(2)} px at fov ${fov}, depth ${depth}`,
      `got ${dPx.toFixed(4)} px`,
    );
  }

  box.dispose();
}

// ---------------------------------------------------------------------------
// 5. CSM maths
// ---------------------------------------------------------------------------

function checkCsm(): void {
  section('csm — slice sphere fit and texel stability');

  const csm = new CascadedShadowMaps({ mapSize: 2048, cascades: 3 });

  // The claim being tested: the fitted sphere contains the whole frustum slice,
  // and its radius does not change when the camera rotates. Both are what stop
  // the shadow edges crawling, and both are invisible in a still frame.
  const radii: number[][] = [];
  for (const yaw of [0, 0.7, 1.6, 2.9, -1.1]) {
    const cam = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 400);
    cam.position.set(Math.sin(yaw) * 15.5, 9, Math.cos(yaw) * 15.5);
    cam.lookAt(0, 0.35, 0);
    cam.updateMatrixWorld(true);
    csm.update(cam);

    const r: number[] = [];
    let near = cam.near;
    for (let i = 0; i < 3; i++) {
      const c = csm.cascades[i];
      const radius = c.camera.right;
      r.push(radius);

      // Every corner of the slice must fall inside the light camera's box.
      const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
      let contained = true;
      for (const z of [near, c.far]) {
        for (const sy of [-1, 1]) {
          for (const sx of [-1, 1]) {
            const corner = new THREE.Vector3(
              sx * z * tanV * cam.aspect,
              sy * z * tanV,
              -z,
            ).applyMatrix4(cam.matrixWorld);
            const clip = corner.clone().applyMatrix4(c.matrix);
            if (Math.abs(clip.x) > 1.0001 || Math.abs(clip.y) > 1.0001 || clip.z > 1.0001) {
              contained = false;
            }
          }
        }
      }
      ok(contained, `cascade ${i} contains its frustum slice at yaw ${yaw.toFixed(1)}`);
      ok(c.texelWorld > 0 && Number.isFinite(c.texelWorld), `cascade ${i} texel size is sane`);
      ok(c.bias > 0 && c.bias < 0.1, `cascade ${i} bias is in range`, `${c.bias}`);
      near = c.far;
    }
    radii.push(r);
  }

  for (let i = 0; i < 3; i++) {
    const rs = radii.map((r) => r[i]);
    const spread = Math.max(...rs) - Math.min(...rs);
    ok(
      spread < 1e-6,
      `cascade ${i} radius is rotation-invariant`,
      `spread ${spread.toExponential(2)} across five yaws`,
    );
  }

  // Texel snapping: translating the camera by a fraction of a texel must move
  // the cascade centre in WHOLE texels along the light's own X and Y axes, or
  // not at all. The light-space Z is deliberately NOT snapped — it is the ortho
  // depth axis and quantising it would only cost precision — so the test has to
  // be done in the light basis, not on the raw world displacement.
  const cam = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 400);
  cam.position.set(0, 9, 15.5);
  cam.lookAt(0, 0.35, 0);
  cam.updateMatrixWorld(true);
  csm.update(cam);

  const up = Math.abs(csm.direction.y) > 0.98 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const toLight = new THREE.Matrix4()
    .lookAt(csm.direction, new THREE.Vector3(), up)
    .invert();

  const first = csm.cascades[0].camera.position.clone().applyMatrix4(toLight);
  const texel = csm.cascades[0].texelWorld;

  let fractional = 0;
  for (let k = 1; k <= 12; k++) {
    cam.position.x = (k * texel) / 5;
    cam.updateMatrixWorld(true);
    csm.update(cam);
    const d = csm.cascades[0].camera.position.clone().applyMatrix4(toLight).sub(first);
    const sx = d.x / texel;
    const sy = d.y / texel;
    if (Math.abs(sx - Math.round(sx)) > 1e-3 || Math.abs(sy - Math.round(sy)) > 1e-3) fractional++;
  }
  ok(
    fractional === 0,
    'cascade centre moves in whole texels only',
    `${fractional} of 12 sub-pixel steps leaked through`,
  );

  csm.dispose();
}

// ---------------------------------------------------------------------------
// 6. Silk aliasing headroom
// ---------------------------------------------------------------------------

function checkSilk(): void {
  section('silk — screen-aligned wash');

  const wash = new SilkWash(SilkWash.createUniforms());
  for (const dpr of [1, 1.4, 1.75, 2, 3]) {
    wash.update(dpr);
    const h = wash.nyquistHeadroom();
    ok(h >= 1.2, `weave has Nyquist headroom at dpr ${dpr}`, `headroom ${h.toFixed(2)}x`);
    note(`dpr ${dpr}: weave period ${wash.devicePeriodPx.toFixed(1)} device px, headroom ${h.toFixed(2)}x`);
  }

  wash.setEnabled(false);
  ok(wash.uniforms.uSilkGain.value === 0, 'disabling the wash zeroes the gain');
  wash.setEnabled(true);
  ok((wash.uniforms.uSilkGain.value as number) > 0, 're-enabling restores it');

  for (const cls of MATERIAL_CLASSES as MaterialClass[]) {
    const s = SilkWash.strengthFor(cls);
    ok(s >= 0 && s <= 1, `${cls}: silkWash strength in range`, `${s}`);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('render/selfcheck — static validation (no GPU required)');

checkShaders();
await checkAtlas();
checkRamps();
checkTextures();
checkOutlineMaths();
checkCsm();
checkSilk();

console.log('\nnotes');
for (const n of notes) console.log(`  ${n}`);

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(
  '\nNOT COVERED HERE (needs a real GPU frame):\n' +
    '  - that the shaders actually compile and link on a driver\n' +
    '  - that the hull and the Sobel do not double at a lamellar seam\n' +
    '  - whether the band edges read as laid pigment or as posterisation\n' +
    '  - silk wash strength, grain amount, rim width — all tuned by eye\n' +
    '  - shadow acne, peter-panning, and cascade seam visibility',
);

const proc = (globalThis as unknown as { process?: { exitCode?: number } }).process;
if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  if (proc) proc.exitCode = 1;
}
