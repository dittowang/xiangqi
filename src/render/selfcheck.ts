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
import { PIGMENT_NAMES, RAMPS, type MaterialClass, type PigmentName } from '@core/palette.ts';
import { CascadedShadowMaps } from './csm.ts';
import { createGradeMaterial, createLinesMaterial } from './composer.ts';
import { GongbiMaterialLibrary, gongbiInfo } from './gongbi.ts';
import { ensureSmoothNormals, SMOOTH_NORMAL_ATTRIBUTE } from './outline.ts';
import {
  MATERIAL_CLASSES,
  RAMP_ROWS,
  RAMP_WIDTH,
  bakeRampRow,
  buildRampAtlas,
} from './ramps.ts';
import { SilkWash } from './silk.ts';
import { TEXTURE_KINDS, generateField, textureSize, type TextureKind } from './textures.ts';

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

function auditMaterial(label: string, mat: THREE.ShaderMaterial): void {
  const vert = stripComments(resolveIncludes(mat.vertexShader));
  const frag = stripComments(resolveIncludes(mat.fragmentShader));

  for (const [stage, src] of [
    ['vertex', vert],
    ['fragment', frag],
  ] as const) {
    const b = checkBalance(src);
    ok(b.ok, `${label} ${stage}: balanced braces`, b.detail);
    const p = checkPreprocessor(src);
    ok(p.ok, `${label} ${stage}: balanced #if/#endif`, p.detail);
    checkFunctionOrder(src, `${label} ${stage}`);
  }

  const declV = declaredUniforms(vert);
  const declF = declaredUniforms(frag);
  const declared = new Map([...declV, ...declF]);
  const used = new Set([...usedOurUniforms(vert), ...usedOurUniforms(frag)]);
  const provided = new Set(Object.keys(mat.uniforms ?? {}));

  for (const name of used) {
    ok(declared.has(name), `${label}: '${name}' used`, 'not declared in any stage');
  }
  for (const [name] of declared) {
    if (!/^u[A-Z]/.test(name)) continue; // three's own (bindMatrix, boneTexture)
    ok(provided.has(name), `${label}: '${name}' declared`, 'missing from material.uniforms');
  }
  for (const name of provided) {
    ok(declared.has(name), `${label}: uniforms['${name}']`, 'declared by no shader stage');
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

    // TILING. Compare the discontinuity across the wrap seam against the
    // typical neighbour-to-neighbour difference inside the field. A
    // non-periodic generator shows up here as a seam several times sharper
    // than the interior, and nowhere else until someone wraps it on a mesh.
    let seam = 0;
    let interior = 0;
    for (let y = 0; y < size; y++) {
      seam += Math.abs(data[(y * size + size - 1) * 4] - data[y * size * 4]);
      const x = (y * 7919) % (size - 1);
      interior += Math.abs(data[(y * size + x) * 4] - data[(y * size + x + 1) * 4]);
    }
    seam /= size;
    interior /= size;
    const ratio = interior > 0.01 ? seam / interior : seam;
    ok(
      ratio < 3.0,
      `${kind}: tiles across the wrap seam`,
      `seam step ${seam.toFixed(2)} vs interior ${interior.toFixed(2)} (ratio ${ratio.toFixed(2)})`,
    );

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
  // On a cube each corner normal must be the (1,1,1)/sqrt(3) diagonal.
  const anyCorner = [...byCorner.values()][0][0];
  ok(
    Math.abs(Math.abs(anyCorner.x) - 0.5773502) < 1e-4,
    'cube corner normal is the body diagonal',
    `${anyCorner.x.toFixed(5)}`,
  );

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
  // the cascade centre by either zero or a whole texel, never a fraction.
  const cam = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 400);
  cam.position.set(0, 9, 15.5);
  cam.lookAt(0, 0.35, 0);
  cam.updateMatrixWorld(true);
  csm.update(cam);
  const first = csm.cascades[0].camera.position.clone();
  const texel = csm.cascades[0].texelWorld;

  let fractional = 0;
  for (let k = 1; k <= 12; k++) {
    cam.position.x = (k * texel) / 5;
    cam.updateMatrixWorld(true);
    csm.update(cam);
    const d = csm.cascades[0].camera.position.clone().sub(first);
    // Project the movement onto the light's own texel grid axes; any component
    // should be a whole number of texels.
    const stepsX = d.length() / texel;
    if (Math.abs(stepsX - Math.round(stepsX)) > 1e-3) fractional++;
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
