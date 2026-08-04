/**
 * The silk wash — 罩染, shadow built from layered washes over a woven ground.
 *
 * The pattern itself is generated analytically in shaders/silk.glsl.ts. This
 * file owns the *parameters*: where the wash sits between "invisible" and "a
 * filter laid over the picture", and the arithmetic that keeps the weave from
 * aliasing on a retina display.
 *
 * THE CENTRAL TENSION, restated because it drives every number below.
 * The weave has to belong to the GROUND — the silk the whole image is painted
 * on — so it is screen-aligned and identical everywhere in the frame. But a
 * screen-aligned pattern applied uniformly is a post-process filter, and
 * filters look like filters. The resolution: the PATTERN is global, the
 * EXPOSURE of it is local. Each surface reveals the ground in proportion to
 * (a) how deep into its shadow bands the fragment is, and (b) its material
 * class's `RampSpec.silkWash`, which runs from 0.24 on gold — a burnished metal
 * surface shows almost no ground — to 1.0 on the silk board itself.
 *
 * ALIASING
 * The pattern is a function of `gl_FragCoord.xy`, so the sampling rate is
 * exactly one sample per device pixel across the entire frame. There is no
 * minification, therefore no moire from scale. The only way to alias is to pick
 * a period near Nyquist, so:
 *   - the period is authored in CSS pixels and converted to device pixels here,
 *     which means a retina display gets a physically identical weave rather
 *     than one at half the size;
 *   - when the perf governor moves the pixel ratio, the conversion is redone,
 *     so a tier change does not visibly change the paper;
 *   - the shader fades the weave's amplitude out below ~4 device pixels of
 *     period, and `nyquistHeadroom()` here reports how close we are, so the
 *     self-check and any future tuning pass can see it as a number instead of
 *     squinting at a frame.
 * At the default 5 CSS px and dpr 2, the device period is 10 px — two and a
 * half times the guard. There is a lot of room, and that is deliberate: it is
 * the one parameter where being wrong is unrecoverable in post.
 */

import type * as THREE from 'three';
import { RAMPS, type MaterialClass } from '@core/palette.ts';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Weave period, CSS pixels. Around five is the size at which a viewer reads
 * "woven" without being able to count threads — below three it becomes noise,
 * above eight it becomes hessian.
 */
export const SILK_PERIOD_CSS_PX = 5.0;

/**
 * 皴 stroke field scale, CSS pixels. Roughly seven times the weave, so the two
 * read as separate registers — the fine tooth of the cloth and the broad hand
 * of the brush — rather than as one noisy field.
 */
export const CUN_SCALE_CSS_PX = 34.0;

/**
 * Stroke direction, radians, in screen space. Just off vertical and leaning
 * left, which is where a right-handed brush naturally falls. Exactly vertical
 * or exactly 45 degrees both read as machine-made.
 */
export const CUN_ANGLE = -1.02;

/**
 * Global wash gain. `RampSpec.silkWash` (0.24 … 1.0) multiplies this, and the
 * fragment's own shadow depth multiplies that, so the maximum wash any pixel
 * can receive is SILK_GAIN. A third is enough to be unmistakable in the deep
 * bands and invisible in the lit ones.
 */
export const SILK_GAIN = 0.34;

/** Device-pixel period below which the shader has faded the weave to nothing. */
export const NYQUIST_FLOOR_PX = 4.0;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface SilkUniforms {
  uSilkPeriodPx: THREE.IUniform;
  uCunScalePx: THREE.IUniform;
  uCunAngle: THREE.IUniform;
  uSilkGain: THREE.IUniform;
}

/**
 * Owns the four shared uniforms the wash needs. One instance per material
 * library; every material references the same uniform objects, so a resize or a
 * quality change is four writes rather than four hundred.
 */
export class SilkWash {
  private gain = SILK_GAIN;
  private enabled = true;
  private dpr = 1;

  constructor(readonly uniforms: SilkUniforms) {}

  static createUniforms(): SilkUniforms {
    return {
      uSilkPeriodPx: { value: SILK_PERIOD_CSS_PX },
      uCunScalePx: { value: CUN_SCALE_CSS_PX },
      uCunAngle: { value: CUN_ANGLE },
      uSilkGain: { value: SILK_GAIN },
    };
  }

  /** Call whenever the drawing buffer's pixel ratio changes. */
  update(dpr: number): void {
    this.dpr = dpr > 0 ? dpr : 1;
    this.uniforms.uSilkPeriodPx.value = SILK_PERIOD_CSS_PX * this.dpr;
    this.uniforms.uCunScalePx.value = CUN_SCALE_CSS_PX * this.dpr;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.uniforms.uSilkGain.value = on ? this.gain : 0;
  }

  /** Tuning hook for a later pass driven by real captured frames. */
  setGain(g: number): void {
    this.gain = Math.max(0, g);
    if (this.enabled) this.uniforms.uSilkGain.value = this.gain;
  }

  /** The weave period actually in effect, in device pixels. */
  get devicePeriodPx(): number {
    return this.uniforms.uSilkPeriodPx.value as number;
  }

  /**
   * How much room the current period has above the shader's fade-out floor.
   * 1.0 means "exactly at the floor, the weave has just vanished"; the default
   * configuration sits at 2.5. Anything under 1.2 should be treated as a defect
   * — the weave will be present but shimmering.
   */
  nyquistHeadroom(): number {
    return this.devicePeriodPx / NYQUIST_FLOOR_PX;
  }

  /** Per-class exposure of the ground, straight from the art direction. */
  static strengthFor(cls: MaterialClass): number {
    return RAMPS[cls].silkWash;
  }
}
