/**
 * The river's water.
 *
 * This is the one surface on the board that cannot be a static mesh: 楚河漢界 is
 * a channel of moving water and it has to move. It is also the one surface that
 * does not go through `GongbiMaterials`, because none of the material classes in
 * the palette describes "flowing water seen from above" — so it carries its own
 * shader, written to the same rules the ramp materials follow:
 *
 *   - N·L is quantised into hard bands. No smooth falloff anywhere.
 *   - Every colour comes out of `core/palette.ts`; the shader receives them as
 *     linear-space uniforms and never invents one.
 *   - The surface is drawn the way a 工筆 painter draws water: a flat wash of
 *     石青 over a 石綠 bed, with *contour lines* (水紋) laid on top. The lines are
 *     the reading, not the specular. A photoreal normal-mapped water surface
 *     would tear this board in half.
 *
 * The animation is entirely a function of `uTime`, which the board feeds from
 * the accumulated clock delta — never from `performance.now()` — so a frame
 * captured after `__XQ.step(dt)` is reproducible.
 *
 * The hash constants are baked at build time from `seedFor()`, so the ripple
 * field is part of the same reproducible artefact as the rest of the geometry.
 */

import * as THREE from 'three';
import { MOODS, PIGMENTS, hexToRgb, srgbToLinear, type PigmentName } from '@core/palette.ts';
import { seedFor } from '@core/rng.ts';

/** Linear-space `THREE.Vector3` for one band of a pigment. */
export function pigmentBandVec(name: PigmentName, i: 0 | 1 | 2 | 3): THREE.Vector3 {
  const c = hexToRgb(PIGMENTS[name].bands[i]);
  return new THREE.Vector3(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
}

export interface WaterChannelSpec {
  /** Half-width of the flat bed, world units. */
  floorHalf: number;
  /** Half-width at the top of the cut wall. */
  riverHalf: number;
  /** Height of the stone banking cap above the silk. */
  bankRise: number;
  /** Depth of the bed below the silk (positive). */
  depth: number;
  /** Height of the water plane (negative, below the silk). */
  waterY: number;
}

/** Ripple wavelengths, in world units. Tuned against a 0.5-wide channel. */
const WAVE_A_LEN = 0.62;
const WAVE_B_LEN = 0.24;
/** Peak vertical displacement of the surface, world units. Deliberately tiny —
 *  this is a painted river, not an ocean; it exists to break the mirror plane
 *  at a grazing camera, nothing more. */
const WAVE_AMPLITUDE = 0.0055;
/** How fast the current runs, world units per second, along +X. */
const FLOW_SPEED = 0.085;
/** Spacing of the drawn 水紋 contour lines through the noise field. */
const LINE_DENSITY = 4.5;

function buildHashConstants(): { a: string; b: string; c: string } {
  const rng = seedFor('scene', 'river', 'water', 'hash');
  // Large irrational-looking constants; the exact values only need to be stable.
  const pick = () => (rng.range(20, 120) + rng.next()).toFixed(4);
  return { a: pick(), b: pick(), c: (rng.range(4000, 60000) + rng.next()).toFixed(3) };
}

const H = buildHashConstants();

const VERT = /* glsl */ `
uniform float uTime;
uniform vec2  uWaveDir;      // unit flow direction in XZ
uniform float uAmplitude;
uniform vec4  uChannel;      // floorHalf, riverHalf, bankRise, depth
uniform float uWaterY;

varying vec3 vWorld;
varying vec2 vWave;          // phase of the two wave trains, reused in the fragment
varying float vTaper;        // 0 at the bank, 1 in open water

const float TWO_PI = 6.28318530718;

/** Bed height under this point — the same piecewise profile the CPU builds. */
float bedHeight(float az) {
  if (az <= uChannel.x) return -uChannel.w;
  float t = clamp((az - uChannel.x) / max(uChannel.y - uChannel.x, 1e-4), 0.0, 1.0);
  return mix(-uChannel.w, uChannel.z, t);
}

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);

  // Waves die out where the water runs onto the bank. Without this a crest at
  // the channel edge lifts above the cut stone it is supposed to be lapping
  // against, and the river reads as a decal floating over the groove.
  vTaper = smoothstep(0.0, 0.022, uWaterY - bedHeight(abs(world.z)));

  // Two crossing trains: a long one along the current and a short one raked
  // across it. Sum of sines is enough here because the amplitude is ~5 mm.
  float pa = dot(world.xz, uWaveDir) * (TWO_PI / ${WAVE_A_LEN.toFixed(4)}) - uTime * 2.1;
  float pb = dot(world.xz, vec2(uWaveDir.y, -uWaveDir.x) * 0.82 + uWaveDir * 0.55)
             * (TWO_PI / ${WAVE_B_LEN.toFixed(4)}) - uTime * 3.4;

  world.y += (sin(pa) * 0.62 + sin(pb) * 0.38) * uAmplitude * vTaper;

  vWorld = world.xyz;
  vWave = vec2(pa, pb);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAG = /* glsl */ `
precision highp float;

// NOTE on the two #includes at the bottom of main(): three's WebGLProgram
// already injects colorspace_pars_fragment + linearToOutputTexel() (and
// tonemapping_pars_fragment + toneMapping(), when tone mapping is on) into the
// prefix of every non-raw ShaderMaterial. So the *_fragment chunks are all this
// shader needs — pulling the *_pars_* chunks in as well would redefine those
// functions and fail to compile. Colour is therefore worked in linear space here
// and transformed on the way out, exactly like a built-in material.

uniform float uTime;
uniform vec3  uKeyDir;       // unit vector, surface -> key light
uniform vec3  uKeyColour;    // linear
uniform vec3  uFillColour;   // linear
uniform float uKeyIntensity;
uniform float uFillIntensity;
uniform vec3  uWater[4];     // 石青 bands, dark -> light, linear
uniform vec3  uBed[4];       // 石綠 bands, linear
uniform vec3  uLine;         // 水紋 contour line colour, linear
uniform vec3  uGradeTint;    // linear
uniform float uGradeAmount;
uniform float uSilhouette;
uniform vec2  uWaveDir;
uniform float uAmplitude;
uniform vec4  uChannel;      // floorHalf, riverHalf, bankRise, depth
uniform float uWaterY;

varying vec3 vWorld;
varying vec2 vWave;
varying float vTaper;

const float TWO_PI = 6.28318530718;

// -- seeded value noise -----------------------------------------------------
// Constants baked from seedFor('scene/river/water/hash') so the field is part
// of the same reproducible build as the geometry.
float hash21(vec2 p) {
  p = fract(p * vec2(${H.a}, ${H.b}));
  p += dot(p, p + 34.71);
  return fract(p.x * p.y * ${H.c});
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s / 0.9375;
}

/** Bed height under this point — the same piecewise profile the CPU builds. */
float bedHeight(float az) {
  if (az <= uChannel.x) return -uChannel.w;
  float t = clamp((az - uChannel.x) / max(uChannel.y - uChannel.x, 1e-4), 0.0, 1.0);
  return mix(-uChannel.w, uChannel.z, t);
}

/** Three hard bands along N·L, gongbi-style: no smooth ramp, ever. */
float quantise(float ndl) {
  float b = 0.0;
  b += smoothstep(0.30, 0.325, ndl);
  b += smoothstep(0.62, 0.645, ndl);
  return b; // 0, 1 or 2
}

void main() {
  // ---- surface normal ----------------------------------------------------
  // Analytic derivative of the two wave trains, plus a scrolling noise field
  // that supplies the fine perturbation. Cheaper and steadier than a normal map
  // and it stays coherent when the camera drops to the waterline.
  vec2 flow = uWaveDir * uTime * ${FLOW_SPEED.toFixed(4)};
  vec2 np = vWorld.xz * 5.5 - flow * 6.0;
  float n0 = fbm(np);
  float e = 0.06;
  float nx = fbm(np + vec2(e, 0.0)) - n0;
  float nz = fbm(np + vec2(0.0, e)) - n0;

  // The same taper the vertex stage applied, so the shading normal agrees with
  // the surface that was actually displaced.
  float dA = cos(vWave.x) * (TWO_PI / ${WAVE_A_LEN.toFixed(4)}) * 0.62 * uAmplitude * vTaper;
  float dB = cos(vWave.y) * (TWO_PI / ${WAVE_B_LEN.toFixed(4)}) * 0.38 * uAmplitude * vTaper;
  vec2 slope = uWaveDir * dA + vec2(uWaveDir.y, -uWaveDir.x) * dB;
  slope += vec2(nx, nz) * 0.55 * mix(0.35, 1.0, vTaper);

  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

  // ---- depth-driven body colour -----------------------------------------
  float depth = max(uWaterY - bedHeight(abs(vWorld.z)), 0.0);
  float shallow = 1.0 - smoothstep(0.012, 0.058, depth);

  float ndl = max(dot(N, uKeyDir), 0.0);
  float step3 = quantise(ndl);

  vec3 waterCol = step3 < 0.5 ? uWater[0] : (step3 < 1.5 ? uWater[1] : uWater[2]);
  vec3 bedCol   = step3 < 0.5 ? uBed[0]   : (step3 < 1.5 ? uBed[1]   : uBed[2]);
  // Blending most of the way to the 石綠 bed over the shallows desaturated the
  // whole surface toward a grey-blue that measured closer to 玄漆 — the Chu
  // army's own lacquer — than to 石青. The terrain and one of the two sides
  // sharing a colour is an identity collision, so the bed now tints the
  // shallows rather than replacing them.
  vec3 col = mix(waterCol, bedCol, shallow * 0.34);

  // Fill light: a flat lift on the shadow band only, the way a wash is laid in.
  col += uFillColour * uFillIntensity * 0.10 * (1.0 - step3 * 0.5);
  col *= mix(0.9, 1.0, uKeyIntensity * 0.35);
  // Tint by the key rather than multiplying by it: a warm key multiplied
  // straight into 石青 pulls the blue toward neutral and costs the pigment the
  // saturation it is chosen for.
  col *= mix(vec3(1.0), uKeyColour * 0.5 + 0.5, 0.45);

  // ---- 水紋: drawn contour lines -----------------------------------------
  // Contours of the drifting noise field. This is the detail that makes the
  // river read as painted rather than shaded: nested lines that travel with the
  // current, thinning where the water runs deep.
  float field = n0 * ${LINE_DENSITY.toFixed(2)} + vWave.x * 0.06;
  float c = abs(fract(field) - 0.5) * 2.0;
  float line = 1.0 - smoothstep(0.82, 0.98, c);
  line *= 0.55 + 0.45 * smoothstep(0.0, 0.35, ndl);   // lines fade in shadow
  line *= 1.0 - shallow * 0.5;                        // and over the shallows
  col = mix(col, uLine, line * 0.38);

  // ---- 提白: one razor-thin lifted band along the crests ------------------
  float crest = smoothstep(0.86, 0.90, ndl);
  col = mix(col, uWater[3], crest * 0.55);

  // ---- mood grade --------------------------------------------------------
  col = mix(col, uGradeTint, uGradeAmount);

  // Silhouette pass: flat black, no line work, no bands.
  col = mix(col, vec3(0.0), uSilhouette);

  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface RiverWater {
  material: THREE.ShaderMaterial;
  /** Advance the flow. `dt` in seconds; never reads a wall clock. */
  update(dt: number): void;
  /** Push the current interpolated light mood. */
  setLight(spec: {
    dir: THREE.Vector3;
    keyColour: THREE.Color;
    fillColour: THREE.Color;
    keyIntensity: number;
    fillIntensity: number;
    gradeTint: THREE.Color;
    gradeAmount: number;
  }): void;
  setSilhouetteMode(on: boolean): void;
  dispose(): void;
}

/** Linear-space vector for a mood colour, so nothing here invents a value. */
function moodColourVec(hex: string): THREE.Vector3 {
  const c = hexToRgb(hex);
  return new THREE.Vector3(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
}

export function createRiverWater(channel: WaterChannelSpec): RiverWater {
  // Seeded from the `wide` mood so the first frame is already correct even if
  // the lighting rig has not pushed anything yet. Every one of these is
  // overwritten by `setLight` on the rig's first update.
  const wide = MOODS.wide;
  const ce = Math.cos(wide.keyElevation);
  const uniforms = {
    uTime: { value: 0 },
    uKeyDir: {
      value: new THREE.Vector3(
        ce * Math.sin(wide.keyAzimuth),
        Math.sin(wide.keyElevation),
        ce * Math.cos(wide.keyAzimuth),
      ),
    },
    uKeyColour: { value: moodColourVec(wide.keyColour) },
    uFillColour: { value: moodColourVec(wide.fillColour) },
    uKeyIntensity: { value: wide.keyIntensity },
    uFillIntensity: { value: wide.fillIntensity },
    uWater: {
      value: [
        pigmentBandVec('azurite', 0),
        pigmentBandVec('azurite', 1),
        pigmentBandVec('azurite', 2),
        pigmentBandVec('azurite', 3),
      ],
    },
    uBed: {
      value: [
        pigmentBandVec('malachite', 0),
        pigmentBandVec('malachite', 1),
        pigmentBandVec('malachite', 2),
        pigmentBandVec('malachite', 3),
      ],
    },
    uLine: { value: pigmentBandVec('ink', 1) },
    uGradeTint: { value: moodColourVec(wide.gradeTint) },
    uGradeAmount: { value: wide.gradeAmount },
    uSilhouette: { value: 0 },
    // The river runs across the board, so the current follows +X.
    uWaveDir: { value: new THREE.Vector2(1, 0) },
    uAmplitude: { value: WAVE_AMPLITUDE },
    uChannel: {
      value: new THREE.Vector4(channel.floorHalf, channel.riverHalf, channel.bankRise, channel.depth),
    },
    uWaterY: { value: channel.waterY },
  };

  const material = new THREE.ShaderMaterial({
    name: 'scene/riverWater',
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.FrontSide,
    transparent: false,
  });

  // Module-level scratch would be pointless here: setLight writes straight into
  // the uniform vectors, so update() and setLight() allocate nothing.
  return {
    material,
    update(dt: number) {
      uniforms.uTime.value += dt;
    },
    setLight(spec) {
      uniforms.uKeyDir.value.copy(spec.dir);
      uniforms.uKeyColour.value.set(spec.keyColour.r, spec.keyColour.g, spec.keyColour.b);
      uniforms.uFillColour.value.set(spec.fillColour.r, spec.fillColour.g, spec.fillColour.b);
      uniforms.uKeyIntensity.value = spec.keyIntensity;
      uniforms.uFillIntensity.value = spec.fillIntensity;
      uniforms.uGradeTint.value.set(spec.gradeTint.r, spec.gradeTint.g, spec.gradeTint.b);
      uniforms.uGradeAmount.value = spec.gradeAmount;
    },
    setSilhouetteMode(on: boolean) {
      uniforms.uSilhouette.value = on ? 1 : 0;
    },
    dispose() {
      material.dispose();
    },
  };
}
