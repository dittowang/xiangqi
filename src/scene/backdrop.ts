/**
 * The 千里江山 distance.
 *
 * The board is not on a table in a room. It is on a stone terrace above a lake,
 * with mineral blue-green ranges receding into a gamboge sky — Wang Ximeng's
 * *Thousand Li of Rivers and Mountains* as staging rather than as wallpaper.
 * That is what stops the board from floating in a void, and it is why this is
 * built from *layers at real depths* rather than from a skybox: when the camera
 * orbits or dollies, the near range slides against the far one, and parallax is
 * the only thing that reads as distance rather than as a painted backing.
 *
 * Structure, outward from the table:
 *
 * ```
 *   terrace    y = OFF_BOARD_Y, out to r = 13.5   lit stone; takes the table's shadow
 *   parapet    a drop from the terrace to the lake
 *   lake       y = LAKE_Y, concentric rings paling toward the horizon
 *   range 0-4  r = 26 / 42 / 64 / 96 / 138, each a silhouette with its own ridge
 *   mist       a pale band at the foot of each far range — the 留白 that separates
 *              one range from the next, and the single most recognisable move in
 *              the idiom
 *   sky        a dome graded from 藤黃 at the horizon to 蛤白 overhead
 * ```
 *
 * Everything from the lake outward is drawn **flat and unshaded**. Distance in
 * this tradition is laid as a wash of one pigment, not modelled; putting a light
 * direction on a range 138 units away would say "3D scene" in the loudest
 * possible voice. All of it lives in one vertex-coloured geometry, so the whole
 * distance costs a single draw call.
 *
 * Every ridge line comes from `seedFor()`, so the mountains are the same
 * mountains in every build.
 */

import * as THREE from 'three';
import type { GongbiMaterials } from '@core/contracts.ts';
import { MOODS, PIGMENTS, SCENE, mixHex } from '@core/palette.ts';
import { seedFor, type Rng } from '@core/rng.ts';
import { Noise } from '@core/noise.ts';
import { OFF_BOARD_Y } from './board.ts';

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/**
 * Where the terrace ends and the land drops to the water.
 *
 * At the resting `default` framing — 50° of pitch, 38° of fov — the top of the
 * frame meets the terrace plane at a radius of about 11.4 and the water plane at
 * about 14.7. A terrace any wider than this fills the whole upper field with
 * flat stone and the board reads as sitting in a quarry. At 9.8 it is a ledge
 * about a unit clear of the table's corners, and what fills the top of the
 * resting frame is water.
 */
export const TERRACE_RADIUS = 9.8;
/** Water level below the terrace. */
export const LAKE_Y = -2.6;
/** How far the lake runs before the first range. */
const LAKE_OUTER = 190;
/** Samples around the horizon for every ring. 256 puts a vertex every 1.4°. */
const AZIMUTH_SAMPLES = 256;

interface RangeSpec {
  radius: number;
  /** Ridge height above the lake, low and high. */
  low: number;
  high: number;
  /** Silhouette colour, sRGB hex out of the palette. */
  hex: string;
  /** Number of major peaks around the whole horizon. */
  peaks: number;
  /** Mist band at the foot of the range, as a fraction of `low`. */
  mist: number;
}

/**
 * Five ranges. The heights are tuned so each ridge tops out one or two degrees
 * above the one in front of it as seen from a low camera — which is what makes
 * the stack read as five distances instead of one lumpy wall — and so the whole
 * set sits within about five degrees of the horizon, where the low endgame and
 * silhouette framings put their strip of sky.
 *
 * Colour follows aerial perspective up the palette's own value ladder: deep
 * 石綠 near, 石青 in the middle distance, 花青 washed toward 蛤白 at the back.
 */
const RANGES: readonly RangeSpec[] = [
  { radius: 26, low: 3.2, high: 6.0, hex: PIGMENTS.malachite.bands[1], peaks: 11, mist: 0 },
  { radius: 42, low: 4.5, high: 8.0, hex: PIGMENTS.malachite.bands[2], peaks: 9, mist: 0.34 },
  { radius: 64, low: 6.0, high: 10.5, hex: PIGMENTS.azurite.bands[2], peaks: 8, mist: 0.32 },
  { radius: 96, low: 8.0, high: 14.0, hex: PIGMENTS.indigo.bands[3], peaks: 7, mist: 0.3 },
  {
    radius: 138,
    low: 11.0,
    high: 19.0,
    hex: mixHex(PIGMENTS.indigo.bands[3], PIGMENTS.shellWhite.bands[3], 0.5),
    peaks: 6,
    mist: 0.28,
  },
];

/** Sky stops, horizon first. */
const SKY_HORIZON = PIGMENTS.gamboge.bands[2];
const SKY_MID = PIGMENTS.gamboge.bands[3];
const SKY_HIGH = PIGMENTS.shellWhite.bands[3];
const SKY_RADIUS = 300;

// ---------------------------------------------------------------------------
// Ridge lines
// ---------------------------------------------------------------------------

interface Peak {
  theta: number;
  amp: number;
  width: number;
  sharp: number;
}

/**
 * A ridge as a sum of conical peaks plus a low ripple.
 *
 * The exponent on each cone is a shade above 1, which makes the flanks very
 * slightly convex. That is the whole shape language of the 青綠山水 mountain:
 * steep, almost sugar-loaf sides that flare at the base. Rolling fbm hills look
 * like terrain; this looks like the painting.
 */
function makeRidge(spec: RangeSpec, rng: Rng, noise: Noise): (theta: number) => number {
  const peaks: Peak[] = [];
  for (let i = 0; i < spec.peaks; i++) {
    // Even spacing with jitter: a real range has rhythm, not randomness.
    const theta = ((i + rng.range(-0.34, 0.34)) / spec.peaks) * Math.PI * 2;
    peaks.push({
      theta,
      amp: rng.range(0.55, 1.0),
      width: (Math.PI / spec.peaks) * rng.range(0.72, 1.35),
      sharp: rng.range(1.1, 1.55),
    });
  }
  // A couple of subsidiary summits hanging off the main ones.
  const minor = Math.max(2, Math.round(spec.peaks * 0.8));
  for (let i = 0; i < minor; i++) {
    peaks.push({
      theta: rng.range(0, Math.PI * 2),
      amp: rng.range(0.16, 0.42),
      width: (Math.PI / spec.peaks) * rng.range(0.28, 0.6),
      sharp: rng.range(1.0, 1.4),
    });
  }
  const rippleFreq = rng.range(2.4, 4.1);
  const ripplePhase = rng.range(0, 10);

  return (theta: number) => {
    let h = 0;
    for (let i = 0; i < peaks.length; i++) {
      const p = peaks[i];
      let d = Math.abs(theta - p.theta);
      if (d > Math.PI) d = Math.PI * 2 - d; // the horizon wraps
      if (d >= p.width) continue;
      h += p.amp * Math.pow(1 - d / p.width, p.sharp);
    }
    // Evaluating the noise on the circle keeps it periodic for free.
    const r = noise.fbm(
      Math.cos(theta) * rippleFreq + ripplePhase,
      Math.sin(theta) * rippleFreq - ripplePhase,
      3,
    );
    const t = Math.min(1, h) * 0.86 + r * 0.14;
    return spec.low + (spec.high - spec.low) * t;
  };
}

// ---------------------------------------------------------------------------
// A small vertex-coloured builder, local to the backdrop
// ---------------------------------------------------------------------------

class FlatBuilder {
  readonly pos: number[] = [];
  readonly col: number[] = [];

  get triangles(): number {
    return this.pos.length / 9;
  }

  private v(x: number, y: number, z: number, c: THREE.Color): void {
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
  }

  tri(
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    ca: THREE.Color,
    cb: THREE.Color,
    cc: THREE.Color,
  ): void {
    this.v(a[0], a[1], a[2], ca);
    this.v(b[0], b[1], b[2], cb);
    this.v(c[0], c[1], c[2], cc);
  }

  quad(
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    d: readonly number[],
    ca: THREE.Color,
    cb: THREE.Color,
    cc: THREE.Color,
    cd: THREE.Color,
  ): void {
    this.tri(a, b, c, ca, cb, cc);
    this.tri(a, c, d, ca, cc, cd);
  }

  build(name: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.name = name;
    return g;
  }
}

function srgb(hex: string): THREE.Color {
  return new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);
}

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

const SKY_VERT = /* glsl */ `
varying float vH;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  // Normalised height on the dome, 0 at the horizon, 1 overhead.
  vH = clamp(normalize(position).y, 0.0, 1.0);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const SKY_FRAG = /* glsl */ `
precision mediump float;
// Only the *_fragment chunks: three injects the *_pars_* ones into every
// ShaderMaterial prefix already. See the note in water.ts.
uniform vec3 uHorizon;
uniform vec3 uMid;
uniform vec3 uHigh;
uniform vec3 uGradeTint;
uniform float uGradeAmount;
uniform float uSilhouette;
varying float vH;

void main() {
  // Three stops with generous overlaps. A gongbi sky is a laid wash: it has a
  // direction and a couple of soft transitions, not a linear ramp and not bands.
  vec3 c = mix(uHorizon, uMid, smoothstep(0.0, 0.16, vH));
  c = mix(c, uHigh, smoothstep(0.10, 0.62, vH));
  c = mix(c, uGradeTint, uGradeAmount * 0.6);
  c = mix(c, vec3(1.0), uSilhouette);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function buildSkyDome(radius: number, azimuth: number, rings: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const push = (theta: number, phi: number) => {
    const cp = Math.cos(phi);
    pos.push(radius * cp * Math.sin(theta), radius * Math.sin(phi), radius * cp * Math.cos(theta));
  };
  // Elevation runs a little below the horizon so the dome never shows a seam
  // under a camera that dips below level.
  const phiLo = -0.35;
  const phiHi = Math.PI / 2;
  for (let i = 0; i < azimuth; i++) {
    const t0 = (i / azimuth) * Math.PI * 2;
    const t1 = ((i + 1) / azimuth) * Math.PI * 2;
    for (let j = 0; j < rings; j++) {
      // Bias the ring distribution toward the horizon, where the gradient lives.
      const f0 = Math.pow(j / rings, 1.7);
      const f1 = Math.pow((j + 1) / rings, 1.7);
      const p0 = phiLo + (phiHi - phiLo) * f0;
      const p1 = phiLo + (phiHi - phiLo) * f1;
      // Wound for BackSide: we are inside the dome.
      push(t0, p0);
      push(t1, p0);
      push(t1, p1);
      push(t0, p0);
      push(t1, p1);
      push(t0, p1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeBoundingSphere();
  g.name = 'scene/sky';
  return g;
}

// ---------------------------------------------------------------------------
// Backdrop
// ---------------------------------------------------------------------------

export interface BackdropOptions {
  materials: GongbiMaterials;
  detail?: 'low' | 'medium' | 'high';
}

export class Backdrop {
  readonly group = new THREE.Group();
  triangles = 0;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly distance: THREE.Mesh;
  private readonly ground: THREE.Mesh;
  private readonly sky: THREE.Mesh;

  constructor(opts: BackdropOptions) {
    this.group.name = 'scene/backdrop';
    const detail = opts.detail === 'low' ? 0.5 : opts.detail === 'medium' ? 0.75 : 1;
    const az = Math.max(64, Math.round(AZIMUTH_SAMPLES * detail));
    const noise = new Noise(0x71a5);

    // --- the lit near ground ---------------------------------------------
    {
      const g = new FlatBuilder();
      const stone = srgb(PIGMENTS.stone.bands[1]);
      const terraceRings = 6;
      for (let i = 0; i < terraceRings; i++) {
        const r0 = (TERRACE_RADIUS * i) / terraceRings;
        const r1 = (TERRACE_RADIUS * (i + 1)) / terraceRings;
        for (let a = 0; a < az; a++) {
          const t0 = (a / az) * Math.PI * 2;
          const t1 = ((a + 1) / az) * Math.PI * 2;
          const p = (r: number, t: number) => [r * Math.sin(t), OFF_BOARD_Y, r * Math.cos(t)];
          // r0,t0 -> r1,t0 -> r1,t1 -> r0,t1 winds the ring to a +Y face. The
          // other order faces the terrace at the floor, and a stone surface lit
          // from underneath renders as a black arc across the top of every
          // resting shot — which is exactly what it did.
          if (r0 <= 0) {
            // The innermost ring closes on the axis: a fan, not a quad, or every
            // one of its triangles is a zero-area sliver with no normal.
            g.tri(p(0, 0), p(r1, t0), p(r1, t1), stone, stone, stone);
          } else {
            g.quad(p(r0, t0), p(r1, t0), p(r1, t1), p(r0, t1), stone, stone, stone, stone);
          }
        }
      }
      // The parapet: the terrace's edge, dropping to the water.
      for (let a = 0; a < az; a++) {
        const t0 = (a / az) * Math.PI * 2;
        const t1 = ((a + 1) / az) * Math.PI * 2;
        const p = (t: number, y: number) => [
          TERRACE_RADIUS * Math.sin(t),
          y,
          TERRACE_RADIUS * Math.cos(t),
        ];
        // Wound to face away from the axis: you look down past the terrace's
        // edge at the outside of the retaining wall, never at its back.
        g.quad(
          p(t0, OFF_BOARD_Y),
          p(t0, LAKE_Y),
          p(t1, LAKE_Y),
          p(t1, OFF_BOARD_Y),
          stone,
          stone,
          stone,
          stone,
        );
      }
      const geo = g.build('scene/backdrop/ground');
      this.geometries.push(geo);
      this.triangles += g.triangles;
      this.ground = new THREE.Mesh(
        geo,
        opts.materials.get({ cls: 'stone', pigment: SCENE.banking, variation: -0.18 }),
      );
      this.ground.name = 'ground';
      this.ground.receiveShadow = true;
      this.ground.castShadow = false;
      this.group.add(this.ground);
    }

    // --- lake, ranges and mist, all flat, all one draw --------------------
    {
      const g = new FlatBuilder();

      // Water, paling toward the horizon.
      const nearWater = srgb(PIGMENTS.azurite.bands[1]);
      const farWater = srgb(mixHex(PIGMENTS.azurite.bands[3], PIGMENTS.shellWhite.bands[3], 0.42));
      const lakeRings = 10;
      const ringColour: THREE.Color[] = [];
      for (let i = 0; i <= lakeRings; i++) {
        ringColour.push(nearWater.clone().lerp(farWater, Math.pow(i / lakeRings, 0.65)));
      }
      for (let i = 0; i < lakeRings; i++) {
        // Geometric growth: the near water gets the detail, the far water is a
        // couple of huge quads, which is where it belongs.
        const r0 = TERRACE_RADIUS * Math.pow(LAKE_OUTER / TERRACE_RADIUS, i / lakeRings);
        const r1 = TERRACE_RADIUS * Math.pow(LAKE_OUTER / TERRACE_RADIUS, (i + 1) / lakeRings);
        for (let a = 0; a < az; a++) {
          const t0 = (a / az) * Math.PI * 2;
          const t1 = ((a + 1) / az) * Math.PI * 2;
          const p = (r: number, t: number) => [r * Math.sin(t), LAKE_Y, r * Math.cos(t)];
          g.quad(
            p(r0, t0),
            p(r0, t1),
            p(r1, t1),
            p(r1, t0),
            ringColour[i],
            ringColour[i],
            ringColour[i + 1],
            ringColour[i + 1],
          );
        }
      }

      // Ranges, far to near, so the painter's order is the draw order too.
      for (let li = RANGES.length - 1; li >= 0; li--) {
        const spec = RANGES[li];
        const ridge = makeRidge(spec, seedFor('scene', 'backdrop', 'range', li), noise);
        const colour = srgb(spec.hex);
        const base = LAKE_Y - 1.0; // sink the feet below the waterline
        for (let a = 0; a < az; a++) {
          const t0 = (a / az) * Math.PI * 2;
          const t1 = ((a + 1) / az) * Math.PI * 2;
          const h0 = LAKE_Y + ridge(t0);
          const h1 = LAKE_Y + ridge(t1);
          const p = (t: number, y: number) => [
            spec.radius * Math.sin(t),
            y,
            spec.radius * Math.cos(t),
          ];
          // Wound so the strip faces the axis — the camera is always inside.
          g.quad(
            p(t0, base),
            p(t1, base),
            p(t1, h1),
            p(t0, h0),
            colour,
            colour,
            colour,
            colour,
          );
        }

        // 留白: a pale band standing just in front of the range's feet. It is
        // what makes one range legible as a separate distance from the next.
        if (spec.mist > 0) {
          const prev = RANGES[li - 1];
          const mistR = spec.radius - (spec.radius - (prev ? prev.radius : 0)) * 0.22;
          const mistTop = LAKE_Y + spec.low * spec.mist;
          const mistColour = srgb(mixHex(spec.hex, PIGMENTS.shellWhite.bands[3], 0.62));
          for (let a = 0; a < az; a++) {
            const t0 = (a / az) * Math.PI * 2;
            const t1 = ((a + 1) / az) * Math.PI * 2;
            const p = (t: number, y: number) => [mistR * Math.sin(t), y, mistR * Math.cos(t)];
            g.quad(
              p(t0, LAKE_Y - 0.2),
              p(t1, LAKE_Y - 0.2),
              p(t1, mistTop),
              p(t0, mistTop),
              mistColour,
              mistColour,
              mistColour,
              mistColour,
            );
          }
        }
      }

      const geo = g.build('scene/backdrop/distance');
      this.geometries.push(geo);
      this.triangles += g.triangles;
      this.distance = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          name: 'scene/distance',
          vertexColors: true,
          side: THREE.DoubleSide,
          toneMapped: false,
        }),
      );
      this.distance.name = 'distance';
      this.distance.castShadow = false;
      this.distance.receiveShadow = false;
      this.distance.frustumCulled = false;
      this.group.add(this.distance);
    }

    // --- sky ---------------------------------------------------------------
    {
      const geo = buildSkyDome(SKY_RADIUS, Math.max(24, Math.round(48 * detail)), 20);
      this.geometries.push(geo);
      this.triangles += (geo.getAttribute('position')?.count ?? 0) / 3;
      this.skyMat = new THREE.ShaderMaterial({
        name: 'scene/sky',
        uniforms: {
          uHorizon: { value: srgb(SKY_HORIZON) },
          uMid: { value: srgb(SKY_MID) },
          uHigh: { value: srgb(SKY_HIGH) },
          // Seeded from the opening mood; the lighting rig overwrites both on
          // its first update. Nothing in this file invents a colour.
          uGradeTint: { value: srgb(MOODS.wide.gradeTint) },
          uGradeAmount: { value: MOODS.wide.gradeAmount },
          uSilhouette: { value: 0 },
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
      });
      this.sky = new THREE.Mesh(geo, this.skyMat);
      this.sky.name = 'sky';
      this.sky.frustumCulled = false;
      // Always painted first, behind everything, like the silk ground it is.
      this.sky.renderOrder = -1000;
      this.group.add(this.sky);
    }
  }

  /** Keep the sky in step with the light mood. Called by the lighting rig. */
  setLight(spec: { gradeTint: THREE.Color; gradeAmount: number }): void {
    (this.skyMat.uniforms.uGradeTint.value as THREE.Color).copy(spec.gradeTint);
    this.skyMat.uniforms.uGradeAmount.value = spec.gradeAmount;
  }

  setSilhouetteMode(on: boolean): void {
    // The silhouette critic wants flat black on white: the distance steps out
    // and the sky becomes the white ground.
    this.distance.visible = !on;
    this.ground.visible = !on;
    this.skyMat.uniforms.uSilhouette.value = on ? 1 : 0;
  }

  /** Hide everything — used by `showcase()`, which isolates one figure. */
  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    this.skyMat.dispose();
    (this.distance.material as THREE.Material).dispose();
    this.group.clear();
  }
}
