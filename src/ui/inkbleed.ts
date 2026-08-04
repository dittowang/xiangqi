/**
 * The evaluation bar: ink bleeding across silk toward the losing side.
 *
 * ── What is being drawn, and why it is not a bar ────────────────────────────
 *
 * A strip of silk lies alongside the board, aligned with it, so its middle is
 * the river. When the engine's evaluation moves, ink is loaded onto the silk AT
 * THE RIVER and creeps into the losing side's half. Dead level means no ink at
 * all — clean silk. A three-pawn edge means a stain reaching a third of the way
 * into the loser's territory. The stain is laid in the *winning* army's lacquer,
 * so the strip answers "who" and "by how much" in one read, and it does it by
 * covering ground on the board's own axis rather than by filling a rectangle.
 *
 * Two things make it read as ink rather than as a fill:
 *
 *   1. The front is ragged, and its raggedness FOLLOWS THE FIBRE. Silk wicks
 *      along its threads far more readily than across them, so the perturbation
 *      field is authored with high frequency ACROSS the strip and low frequency
 *      ALONG it: the front breaks into fingers that run with the weave. That is
 *      the whole difference between "irregular edge" and "ink in cloth".
 *   2. Pigment piles up at the front. A wetted front carries its solids to the
 *      edge of the wet area and drops them there, which is why a real ink blot
 *      is darkest at its rim and lighter behind. There is also a faint halo of
 *      wicked-ahead moisture past the rim.
 *
 * ── Why it is a shader and not a redrawn canvas ─────────────────────────────
 *
 * The stain animates every frame while the evaluation is settling. Repainting a
 * canvas per frame is exactly how an in-scene HUD destroys a frame budget, so
 * the *shape* of the stain is baked once into a field texture and the frame only
 * moves one float. The bake is the part that needs `core/noise.ts`; the runtime
 * is a threshold against it.
 */

import * as THREE from 'three';

import { Noise } from '@core/noise.ts';
import { seedFor } from '@core/rng.ts';
import { clamp } from '@core/types.ts';

// ---------------------------------------------------------------------------
// The field bake
// ---------------------------------------------------------------------------

/**
 * How far the front can be displaced from its nominal position, in units of the
 * strip's half-length. Large enough that fingers of ink run visibly ahead of the
 * body; small enough that the reading stays honest.
 */
const RAGGED = 0.17;

/** Frequency of the front's fingers ACROSS the strip. High: fibres are fine. */
const FINGER_ACROSS = 11.0;
/** Frequency ALONG the strip. Low: a finger runs a long way once it starts. */
const FINGER_ALONG = 1.6;

/**
 * Bake the bleed field.
 *
 *   R — front displacement, 0.5 = no displacement. The fibre-following term.
 *   G — soak density: how much pigment this patch of silk holds once wetted.
 *   B — fine fibre, used to break the stain's body up at texel scale.
 */
export function bakeBleedField(w: number, h: number, seed: string): THREE.DataTexture {
  const rng = seedFor('hud', 'bleed', seed);
  const nFinger = new Noise(rng.int(1, 0x7fffffff));
  const nSoak = new Noise(rng.int(1, 0x7fffffff));
  const nFibre = new Noise(rng.int(1, 0x7fffffff));

  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);

      // Two octaves of the same anisotropy, so the fingers have fingers.
      const f1 = nFinger.fbm(u * FINGER_ACROSS, v * FINGER_ALONG, 3) - 0.5;
      const f2 = nFinger.fbm(u * FINGER_ACROSS * 3.1 + 17, v * FINGER_ALONG * 3.1, 2) - 0.5;
      const finger = clamp(0.5 + (f1 * 1.35 + f2 * 0.45), 0, 1);

      const soak = clamp(nSoak.fbm(u * 3.2 + 41, v * 5.5, 4) * 1.25 - 0.12, 0, 1);
      const fibre = nFibre.value2(u * w * 0.55, v * h * 0.02 + 7);

      const i = (y * w + x) << 2;
      data[i] = finger * 255;
      data[i + 1] = soak * 255;
      data[i + 2] = fibre * 255;
      data[i + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  // Field data, not colour: it must not be sRGB-decoded on sample.
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// The material
// ---------------------------------------------------------------------------

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * `uReach` is signed: positive means Red leads and the stain grows toward
 * Black's end (v = 0). `vUv.y` runs 0 at Black's end to 1 at Red's end because
 * the quad is laid with its +Y toward -Z and the canvas is flipped on upload —
 * see `hud.ts`, which owns that convention for every panel.
 */
const FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uBase;
uniform sampler2D uField;
uniform vec3 uInk;        // body of the stain, linear
uniform vec3 uInkFront;   // the rim where solids pile up, linear
uniform float uReach;     // signed, -1..1
uniform float uRagged;
uniform float uEndFade;   // softening of the strip's two ends, in v units
uniform float uOpacity;

varying vec2 vUv;

void main() {
  vec4 base = texture2D(uBase, vUv);
  vec3 field = texture2D(uField, vUv).rgb;

  float reach = abs(uReach);
  // Below this the position is meaningless and the strip must be clean silk,
  // not a hairline of ink pinned to the river.
  // Named "wetted" and not the obvious word, which GLSL reserves.
  float wetted = smoothstep(0.004, 0.03, reach);

  // Distance from the river toward the LOSING end, 0 at the river, 1 at the end.
  float c = (vUv.y - 0.5) * 2.0;
  float d = -c * sign(uReach);

  // The front wanders, and it wanders more the further it has travelled: a
  // stain an inch across is nearly round, a stain a foot across is all fingers.
  float wander = (field.r - 0.5) * uRagged * (0.22 + 0.78 * d);
  float t = d + wander;

  // Body, rim and the moisture wicked ahead of the rim.
  float body = smoothstep(reach + 0.012, reach - 0.045, t);
  float halo = smoothstep(reach + 0.13, reach - 0.01, t) - body;
  float rim = smoothstep(0.085, 0.0, abs(t - reach));

  // Nothing on the winning side of the river, and the source edge is soft
  // because ink is loaded onto a wet line, not stamped.
  float half_ = smoothstep(-0.03, 0.035, d);

  float density = 0.62 + 0.38 * field.g;
  float a = (body * 0.95 + max(halo, 0.0) * 0.26) * density * half_ * wetted;
  // Fine fibre breaks the body up so the stain is never a flat swatch.
  a *= 0.86 + 0.14 * field.b;

  vec3 ink = mix(uInk, uInkFront, clamp(rim * 0.85 + (1.0 - density) * 0.3, 0.0, 1.0));
  vec3 rgb = mix(base.rgb, ink, clamp(a, 0.0, 1.0));

  // Ends fade rather than cut, so the strip does not read as a bounded gauge.
  float ends = smoothstep(0.0, uEndFade, vUv.y) * smoothstep(1.0, 1.0 - uEndFade, vUv.y);
  gl_FragColor = vec4(rgb, base.a * ends * uOpacity);
}
`;

export interface InkBleedUniforms {
  uBase: { value: THREE.Texture };
  uField: { value: THREE.Texture };
  uInk: { value: THREE.Color };
  uInkFront: { value: THREE.Color };
  uReach: { value: number };
  uRagged: { value: number };
  uEndFade: { value: number };
  uOpacity: { value: number };
  [k: string]: THREE.IUniform;
}

export function createInkBleedMaterial(
  base: THREE.Texture,
  field: THREE.Texture,
  endFade = 0.06,
): THREE.ShaderMaterial {
  const uniforms: InkBleedUniforms = {
    uBase: { value: base },
    uField: { value: field },
    uInk: { value: new THREE.Color(0, 0, 0) },
    uInkFront: { value: new THREE.Color(0, 0, 0) },
    uReach: { value: 0 },
    uRagged: { value: RAGGED },
    uEndFade: { value: endFade },
    uOpacity: { value: 1 },
  };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    // The strip lies flat on the terrace a few millimetres above it. Writing
    // depth would make it fight the stone; not writing it costs nothing,
    // because nothing is ever drawn between the two.
    depthWrite: false,
    side: THREE.FrontSide,
    toneMapped: false,
  });
}

/**
 * Centipawns to reach.
 *
 * `tanh` rather than a clamp: a two-pawn edge has to be plainly visible while a
 * won position still has somewhere to go, and a linear map spends all its range
 * on evaluations nobody needs to distinguish. 420cp puts a rook-for-nothing at
 * about 0.83 of the strip.
 */
export function reachFromCentipawns(cp: number, mateIn: number | null): number {
  if (mateIn !== null && mateIn !== 0) return mateIn > 0 ? 1 : -1;
  return Math.tanh(cp / 420);
}
