/**
 * Key, fill and bounce, driven entirely by the `LightMood` records in
 * `core/palette.ts`.
 *
 * There are exactly three moods and the whole match moves between them:
 *
 *   wide     — the opening. High warm key, cool open-sky fill, short shadows.
 *   close    — the middlegame. Key drops and swings round, shadows stretch,
 *              the grade warms toward 藤黃.
 *   endgame  — cold. The key falls to 19°, everything lengthens, and the frame
 *              drifts 16% toward 石青. This is the cooling that has to happen
 *              without the viewer being able to name the frame it happened on,
 *              which is why every transition is a cross-fade and never a switch.
 *
 * A mood change interpolates *every* field — both light colours, the bounce, the
 * intensities, the key's elevation and azimuth, the shadow stretch and the grade
 * — on a smoothstep. The lights physically swing; nothing cuts.
 *
 * The rig also owns the shadow spec. Until the CSM in @render exists it runs a
 * single tight orthographic cascade itself so the board has real shadows; once
 * the CSM lands it reads `csmSpec()` for the direction and the split distances,
 * which are the architecture's 6 / 14 / 34 scaled by the mood's stretch.
 */

import * as THREE from 'three';
import type { GongbiMaterials } from '@core/contracts.ts';
import type { MatchPhase } from '@core/bus.ts';
import { MOODS, type LightMood } from '@core/palette.ts';
import { smoothstep } from '@core/types.ts';

/** Cascade split distances from the architecture's perf budget, in world units. */
export const BASE_CASCADE_SPLITS: readonly number[] = [6, 14, 34];

/** How far from the board centre the key light is parked. */
const KEY_DISTANCE = 26;
const FILL_DISTANCE = 22;
/** Half-extent of the fallback shadow camera. Covers the table and its figures. */
const SHADOW_EXTENT = 9.5;

/**
 * The fill sits across from the key and well above the horizon — a broad open
 * sky, not a second sun and not a kicker.
 *
 * It used to be pinned at 0.42x the key's elevation, which was fine while the
 * key sat at 49 degrees and became a raking under-light the moment the key came
 * down to 40 (see the elevation note below). An illustration's fill is a large
 * soft source high in the room; anchoring it to a floor of its own keeps it
 * there at every mood instead of following the key into the skirting board.
 */
const FILL_AZIMUTH_OFFSET = 2.35;
const FILL_ELEVATION_FLOOR = 0.42;
const FILL_ELEVATION_SCALE = 0.30;

// ---------------------------------------------------------------------------
// The gongbi key elevation ladder — measured, not chosen
// ---------------------------------------------------------------------------

/**
 * `MOODS` places the key the way a photographer would: wide 49 degrees, close
 * 39, endgame 19. Measured over a real frame, that placement is the single
 * biggest reason the four-band ramp behaves like a two-band one, and the reason
 * is geometry rather than taste.
 *
 * The surface shader's band axis is `0.62·(N·L) + 0.38` off ONE direction —
 * this rig's key. No fill, bounce or ambient term reaches it. So for a key at
 * elevation e, every surface in the frame lands at one of these:
 *
 *   upward-facing plane          0.62·sin(e) + 0.38
 *   vertical plane facing the key 0.62·cos(e) + 0.38
 *   vertical plane side-on        0.38
 *   vertical plane turned away    0.38 − 0.62·cos(e)
 *   anything in cast shadow       ×0.12, i.e. 0.00 – 0.12
 *
 * At e = 49° the first two are 0.850 and 0.785. They are 0.065 apart, which is
 * *less* than the ±0.045 of per-unit variation the shader already adds — so the
 * top of a helmet and the front of a breastplate are the same band no matter
 * where the cuts are put, and no re-cut of `thresholds` can separate them. At
 * the same time cos(49°) = 0.66 leaves the vertical surfaces — most of a
 * standing figure — sweeping only [0.03, 0.79], piled at both ends.
 *
 * Bringing the key down to 40° pulls them apart (top 0.779, front 0.854) and
 * lets the verticals sweep the whole [0, 0.854]. Measured per material class
 * over the 32-figure board at the `default` pose, the mass of lacquer landing
 * in N·L 0.16–0.42 — which is exactly where band 1 has to live — goes from
 * 10.3% at 49° to 20.6% at 40°. Raising the key instead makes it worse (7.7% at
 * 66°), because every upward-facing plane then piles into the top band.
 *
 * So the ladder is remapped, affinely, onto a lower and shallower range. Affine
 * matters: `blend()` interpolates the authored elevation, and an affine remap
 * commutes with a lerp, so a mood cross-fade is exactly as smooth after the
 * remap as before it and still passes monotonically through every angle
 * between. Nothing cuts.
 *
 * The authored ORDER and spacing are preserved, which is what keeps the three
 * moods distinct: wide stays the highest and most frontal key, endgame stays
 * the low raking one, and every other field of the mood — both light colours,
 * the intensities, the azimuth swing, the shadow stretch and the grade — is
 * untouched.
 *
 * These numbers want to live in `MOODS`; `core/palette.ts` is frozen, so they
 * live here instead and the exact edit is written up in the task report.
 */
export const AUTHORED_ELEVATION = { low: 0.34, high: 0.86 } as const;
export const GONGBI_ELEVATION = { low: 0.4, high: 0.7 } as const;

/** The authored key elevation, remapped onto the gongbi ladder. Affine. */
export function gongbiElevation(authored: number): number {
  const a = AUTHORED_ELEVATION;
  const g = GONGBI_ELEVATION;
  const t = (authored - a.low) / (a.high - a.low);
  return g.low + (g.high - g.low) * t;
}

export interface MoodState {
  key: LightMood['key'];
  keyColour: THREE.Color;
  fillColour: THREE.Color;
  bounceColour: THREE.Color;
  keyIntensity: number;
  fillIntensity: number;
  keyElevation: number;
  keyAzimuth: number;
  shadowStretch: number;
  gradeTint: THREE.Color;
  gradeAmount: number;
}

function srgb(hex: string): THREE.Color {
  return new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);
}

function snapshotOf(m: LightMood): MoodState {
  return {
    key: m.key,
    keyColour: srgb(m.keyColour),
    fillColour: srgb(m.fillColour),
    bounceColour: srgb(m.bounceColour),
    keyIntensity: m.keyIntensity,
    fillIntensity: m.fillIntensity,
    // The live state carries the elevation the lights actually use, not the
    // authored one — anything reading `state` is reading the real rig.
    keyElevation: gongbiElevation(m.keyElevation),
    keyAzimuth: m.keyAzimuth,
    shadowStretch: m.shadowStretch,
    gradeTint: srgb(m.gradeTint),
    gradeAmount: m.gradeAmount,
  };
}

/** Which mood a match phase rests in. */
export function moodForPhase(phase: MatchPhase): LightMood['key'] {
  switch (phase) {
    case 'boot':
    case 'formation':
    case 'development':
    case 'review':
      return 'wide';
    case 'middlegame':
      return 'close';
    case 'endgame':
    case 'terminal':
      return 'endgame';
    default:
      return 'wide';
  }
}

export interface LightingOptions {
  /** Kept in step so the grade and the lights never disagree about the mood. */
  materials?: GongbiMaterials;
  /** Anything that wants the interpolated light pushed at it every frame. */
  consumers?: LightConsumer[];
  shadowMapSize?: number;
  /** Start in this mood. Default `wide`. */
  initial?: LightMood['key'];
}

export interface LightConsumer {
  setLight(spec: {
    dir: THREE.Vector3;
    keyColour: THREE.Color;
    fillColour: THREE.Color;
    keyIntensity: number;
    fillIntensity: number;
    /**
     * Light coming back off the tabletop. This used to be missing from the
     * push, and the consequence was not cosmetic: the surface shader takes
     * ownership of its light uniforms the first time a consumer is fed, after
     * which it stops driving `uBounceColour` from the mood itself. With the
     * bounce absent from the push it stayed frozen at the boot mood's warm
     * 赭石 for the whole match — so every downward-facing plane in the endgame
     * was still catching summer light off a table that had gone cold.
     *
     * It is the one term in the shader that reaches surfaces the key cannot,
     * which is exactly the broad low term an evenly lit illustration needs.
     */
    bounceColour: THREE.Color;
    gradeTint: THREE.Color;
    gradeAmount: number;
  }): void;
}

/** What the CSM in @render needs from us. */
export interface CsmSpec {
  /** Unit vector pointing from the scene toward the key light. */
  direction: THREE.Vector3;
  /** Cascade split distances, already scaled by the mood's shadow stretch. */
  splits: number[];
  mapSize: number;
  cascades: number;
  colour: THREE.Color;
  intensity: number;
}

// Module-level scratch — `update` runs every frame.
const _dir = new THREE.Vector3();
const _fillDir = new THREE.Vector3();

export class LightingRig {
  readonly group = new THREE.Group();
  readonly key: THREE.DirectionalLight;
  readonly fill: THREE.DirectionalLight;
  readonly bounce: THREE.HemisphereLight;

  /** Live interpolated state. Read it; do not write it. */
  readonly state: MoodState;

  private from: MoodState;
  private to: LightMood;
  private t = 1;
  private duration = 0;
  private readonly consumers: LightConsumer[];
  private readonly materials?: GongbiMaterials;
  private readonly splits: number[] = BASE_CASCADE_SPLITS.slice();
  private readonly spec: CsmSpec;
  private readonly lightSpec: Parameters<LightConsumer['setLight']>[0];

  constructor(opts: LightingOptions = {}) {
    this.group.name = 'scene/lighting';
    this.consumers = opts.consumers ? opts.consumers.slice() : [];
    this.materials = opts.materials;

    const initial = MOODS[opts.initial ?? 'wide'];
    this.state = snapshotOf(initial);
    this.from = snapshotOf(initial);
    this.to = initial;

    this.key = new THREE.DirectionalLight(this.state.keyColour.clone(), this.state.keyIntensity);
    this.key.name = 'scene/key';
    this.key.castShadow = true;
    const map = opts.shadowMapSize ?? 2048;
    this.key.shadow.mapSize.set(map, map);
    this.key.shadow.camera.near = 1;
    this.key.shadow.camera.far = KEY_DISTANCE * 2.4;
    this.key.shadow.camera.left = -SHADOW_EXTENT;
    this.key.shadow.camera.right = SHADOW_EXTENT;
    this.key.shadow.camera.top = SHADOW_EXTENT;
    this.key.shadow.camera.bottom = -SHADOW_EXTENT;
    // Incised line work is 12 thousandths deep. A normal bias larger than that
    // pushes the shadow lookup clean through the far wall of every groove, and
    // the grid then self-shadows in patches — it renders as a dotted line rather
    // than a drawn one. Both biases have to stay well under the depth of the
    // shallowest thing on the board.
    this.key.shadow.bias = -0.00012;
    this.key.shadow.normalBias = 0.004;
    this.group.add(this.key);
    this.group.add(this.key.target);

    this.fill = new THREE.DirectionalLight(this.state.fillColour.clone(), this.state.fillIntensity);
    this.fill.name = 'scene/fill';
    this.fill.castShadow = false;
    this.group.add(this.fill);
    this.group.add(this.fill.target);

    // Bounce: cool open sky above, warm light coming back off the tabletop.
    this.bounce = new THREE.HemisphereLight(
      this.state.fillColour.clone(),
      this.state.bounceColour.clone(),
      this.state.fillIntensity * 0.85,
    );
    this.bounce.name = 'scene/bounce';
    this.group.add(this.bounce);

    this.spec = {
      direction: new THREE.Vector3(),
      splits: this.splits,
      mapSize: map,
      cascades: 3,
      colour: this.state.keyColour.clone(),
      intensity: this.state.keyIntensity,
    };
    this.lightSpec = {
      dir: new THREE.Vector3(),
      keyColour: new THREE.Color(),
      fillColour: new THREE.Color(),
      keyIntensity: 0,
      fillIntensity: 0,
      bounceColour: new THREE.Color(),
      gradeTint: new THREE.Color(),
      gradeAmount: 0,
    };

    this.apply();
  }

  addConsumer(c: LightConsumer): void {
    this.consumers.push(c);
    this.pushToConsumers();
  }

  /**
   * Cross-fade into a mood. `seconds` of 0 snaps, which the harness uses to get
   * a deterministic frame without waiting for a fade.
   */
  setMood(key: LightMood['key'], seconds = 2.4): void {
    if (this.to.key === key && this.t >= 1) return;
    this.from = {
      ...this.state,
      keyColour: this.state.keyColour.clone(),
      fillColour: this.state.fillColour.clone(),
      bounceColour: this.state.bounceColour.clone(),
      gradeTint: this.state.gradeTint.clone(),
    };
    this.to = MOODS[key];
    this.duration = Math.max(0, seconds);
    this.t = this.duration <= 0 ? 1 : 0;
    this.materials?.setMood(key, seconds);
    if (this.t >= 1) this.blend(1);
    this.apply();
  }

  /** Convenience for the match state machine. */
  setPhase(phase: MatchPhase, seconds = 2.4): void {
    this.setMood(moodForPhase(phase), seconds);
  }

  update(dt: number): void {
    if (this.t < 1) {
      this.t = this.duration <= 0 ? 1 : Math.min(1, this.t + dt / this.duration);
      this.blend(smoothstep(0, 1, this.t));
      this.apply();
    }
  }

  private blend(k: number): void {
    const a = this.from;
    const b = this.to;
    const s = this.state;
    s.key = k >= 0.5 ? b.key : a.key;
    s.keyColour.copy(a.keyColour).lerp(srgb(b.keyColour), k);
    s.fillColour.copy(a.fillColour).lerp(srgb(b.fillColour), k);
    s.bounceColour.copy(a.bounceColour).lerp(srgb(b.bounceColour), k);
    s.gradeTint.copy(a.gradeTint).lerp(srgb(b.gradeTint), k);
    s.keyIntensity = a.keyIntensity + (b.keyIntensity - a.keyIntensity) * k;
    s.fillIntensity = a.fillIntensity + (b.fillIntensity - a.fillIntensity) * k;
    // `a` is already on the gongbi ladder (snapshotOf mapped it); `b` is a raw
    // authored mood, so it is mapped here. The map is affine, so this is the
    // same curve as interpolating the authored angles and mapping afterwards.
    const bElevation = gongbiElevation(b.keyElevation);
    s.keyElevation = a.keyElevation + (bElevation - a.keyElevation) * k;
    s.keyAzimuth = a.keyAzimuth + (b.keyAzimuth - a.keyAzimuth) * k;
    s.shadowStretch = a.shadowStretch + (b.shadowStretch - a.shadowStretch) * k;
    s.gradeAmount = a.gradeAmount + (b.gradeAmount - a.gradeAmount) * k;
  }

  /** Push the interpolated state onto the actual lights and every consumer. */
  private apply(): void {
    const s = this.state;
    const ce = Math.cos(s.keyElevation);
    const se = Math.sin(s.keyElevation);
    _dir.set(ce * Math.sin(s.keyAzimuth), se, ce * Math.cos(s.keyAzimuth));

    this.key.position.copy(_dir).multiplyScalar(KEY_DISTANCE);
    this.key.target.position.set(0, 0, 0);
    this.key.target.updateMatrixWorld();
    this.key.color.copy(s.keyColour);
    this.key.intensity = s.keyIntensity;
    // A longer shadow needs a longer box or the far figures fall out of it.
    const extent = SHADOW_EXTENT * (0.86 + 0.24 * s.shadowStretch);
    const cam = this.key.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.updateProjectionMatrix();

    const fe = FILL_ELEVATION_FLOOR + s.keyElevation * FILL_ELEVATION_SCALE;
    const fa = s.keyAzimuth + FILL_AZIMUTH_OFFSET;
    _fillDir.set(Math.cos(fe) * Math.sin(fa), Math.sin(fe), Math.cos(fe) * Math.cos(fa));
    this.fill.position.copy(_fillDir).multiplyScalar(FILL_DISTANCE);
    this.fill.target.position.set(0, 0, 0);
    this.fill.target.updateMatrixWorld();
    this.fill.color.copy(s.fillColour);
    this.fill.intensity = s.fillIntensity;

    this.bounce.color.copy(s.fillColour);
    this.bounce.groundColor.copy(s.bounceColour);
    this.bounce.intensity = s.fillIntensity * 0.85;

    this.spec.direction.copy(_dir);
    for (let i = 0; i < BASE_CASCADE_SPLITS.length; i++) {
      this.splits[i] = BASE_CASCADE_SPLITS[i] * s.shadowStretch;
    }
    this.spec.colour.copy(s.keyColour);
    this.spec.intensity = s.keyIntensity;

    this.pushToConsumers();
  }

  private pushToConsumers(): void {
    if (this.consumers.length === 0) return;
    const l = this.lightSpec;
    l.dir.copy(this.spec.direction);
    l.keyColour.copy(this.state.keyColour);
    l.fillColour.copy(this.state.fillColour);
    l.keyIntensity = this.state.keyIntensity;
    l.fillIntensity = this.state.fillIntensity;
    l.bounceColour.copy(this.state.bounceColour);
    l.gradeTint.copy(this.state.gradeTint);
    l.gradeAmount = this.state.gradeAmount;
    for (let i = 0; i < this.consumers.length; i++) this.consumers[i].setLight(l);
  }

  /** Everything the CSM in @render needs. The returned object is reused. */
  csmSpec(): CsmSpec {
    return this.spec;
  }

  /** Resize the shadow map when the perf governor changes quality tier. */
  setShadowMapSize(size: number): void {
    if (this.spec.mapSize === size) return;
    this.spec.mapSize = size;
    this.key.shadow.mapSize.set(size, size);
    this.key.shadow.map?.dispose();
    this.key.shadow.map = null;
  }

  setShadowsEnabled(on: boolean): void {
    this.key.castShadow = on;
  }

  dispose(): void {
    this.key.shadow.map?.dispose();
    this.key.dispose();
    this.fill.dispose();
    this.bounce.dispose();
    this.group.clear();
    this.consumers.length = 0;
  }
}
