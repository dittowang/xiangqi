/**
 * The adaptive quality governor.
 *
 * Target hardware is an M-series MacBook in Chrome, where the ultra tier should
 * simply hold. The governor exists for everything else, and for the two moments
 * that can spike even on target hardware: the first capture animation (shader
 * variants compiling) and a window resize to a large retina viewport.
 *
 * Design rules learned the hard way:
 *   - React to a PERCENTILE, never to a single frame. One slow frame is a GC
 *     pause; ten slow frames is a workload problem.
 *   - Drop fast, recover slowly, and require a much better number to climb than
 *     to fall. Otherwise the governor oscillates and the oscillation is more
 *     visible than the quality difference.
 *   - Never change tier during a capture animation. The player is watching that
 *     exact moment; a pixel-ratio change mid-impact is worse than a dropped frame.
 */

import type { QualitySettings, QualityTier } from '@core/contracts.ts';

export const QUALITY: Record<QualityTier, QualitySettings> = {
  ultra: {
    tier: 'ultra',
    maxPixelRatio: 2.0,
    shadowMapSize: 2048,
    cascades: 3,
    sobel: true,
    silkWash: true,
    outlines: true,
    particleBudget: 2600,
    msaa: 4,
  },
  high: {
    tier: 'high',
    maxPixelRatio: 1.75,
    shadowMapSize: 2048,
    cascades: 3,
    sobel: true,
    silkWash: true,
    outlines: true,
    particleBudget: 1800,
    msaa: 2,
  },
  medium: {
    tier: 'medium',
    maxPixelRatio: 1.4,
    shadowMapSize: 1024,
    cascades: 2,
    sobel: true,
    silkWash: true,
    outlines: true,
    particleBudget: 1100,
    msaa: 0,
  },
  // The floor still keeps outlines, the silk wash AND the Sobel interior lines:
  // they ARE the art direction. Resolution and shadow fidelity go first; line
  // work goes last, and that has to include Sobel.
  //
  // This shipped as `sobel: false`, which contradicted the comment directly
  // above it and had a consequence nobody noticed for a long time: the capture
  // harness runs on SwiftShader, `probe()` maps SwiftShader to `low`, and so
  // EVERY frame reviewed by every critic was captured with half the line work
  // switched off. A quality tier that silently removes the thing being judged is
  // worse than a slow one.
  low: {
    tier: 'low',
    maxPixelRatio: 1.0,
    shadowMapSize: 1024,
    cascades: 1,
    sobel: true,
    silkWash: true,
    outlines: true,
    particleBudget: 600,
    msaa: 0,
  },
};

const ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

/** Frame time above which we drop a tier, in milliseconds (p95). */
const DROP_MS = 19.0;
/** Frame time below which we may climb a tier (p95). The gap is the hysteresis. */
const CLIMB_MS = 12.5;
/** Seconds of sustained pressure before dropping. */
const DROP_HOLD = 0.75;
/** Seconds of sustained headroom before climbing. Deliberately much longer. */
const CLIMB_HOLD = 6.0;
/** Settling time after any tier change, during which the governor is deaf. */
const COOLDOWN = 2.5;

export class QualityGovernor {
  private tierIndex: number;
  private dropTimer = 0;
  private climbTimer = 0;
  private cooldown = 0;
  private lockCount = 0;
  private forced: QualityTier | null = null;

  constructor(
    start: QualityTier = 'ultra',
    private readonly onChange: (settings: QualitySettings) => void,
  ) {
    this.tierIndex = ORDER.indexOf(start);
  }

  get tier(): QualityTier {
    return this.forced ?? ORDER[this.tierIndex];
  }
  get settings(): QualitySettings {
    return QUALITY[this.tier];
  }

  /**
   * Pin the tier for the duration of a moment the player is watching.
   * Balanced with `unlock()`; nested locks are counted, so a capture inside a
   * formation march does not accidentally re-arm the governor early.
   */
  lock(): void {
    this.lockCount++;
  }
  unlock(): void {
    if (this.lockCount > 0) this.lockCount--;
    // Give the frame time a moment to recover before judging it again.
    if (this.lockCount === 0) this.cooldown = Math.max(this.cooldown, 1.0);
  }

  /** Harness / settings override. Pass null to hand control back. */
  force(tier: QualityTier | null): void {
    this.forced = tier;
    if (tier) this.tierIndex = ORDER.indexOf(tier);
    this.onChange(this.settings);
  }

  /** Feed the p95 frame time in milliseconds once per frame. */
  update(dt: number, p95Ms: number): void {
    if (this.forced || this.lockCount > 0) return;

    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return;
    }

    if (p95Ms > DROP_MS && this.tierIndex > 0) {
      this.dropTimer += dt;
      this.climbTimer = 0;
      if (this.dropTimer >= DROP_HOLD) {
        this.tierIndex--;
        this.dropTimer = 0;
        this.cooldown = COOLDOWN;
        this.onChange(this.settings);
      }
    } else if (p95Ms < CLIMB_MS && this.tierIndex < ORDER.length - 1) {
      this.climbTimer += dt;
      this.dropTimer = 0;
      if (this.climbTimer >= CLIMB_HOLD) {
        this.tierIndex++;
        this.climbTimer = 0;
        this.cooldown = COOLDOWN;
        this.onChange(this.settings);
      }
    } else {
      this.dropTimer = 0;
      this.climbTimer = 0;
    }
  }

  /**
   * Initial tier guess from what the GPU reports, so a weak machine does not
   * have to visibly fall three tiers over its first ten seconds.
   */
  static probe(gl: WebGL2RenderingContext): QualityTier {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    const lower = name.toLowerCase();
    // Apple silicon is the target and handles ultra; software rasterisers
    // (SwiftShader, llvmpipe — which is what the capture harness runs on) must
    // start at the floor or the harness spends its life waiting on frames.
    if (/swiftshader|llvmpipe|software|angle \(google/.test(lower)) return 'low';
    if (/apple m\d/.test(lower)) return 'ultra';
    if (/intel.*(hd|uhd) graphics/.test(lower)) return 'medium';
    return 'high';
  }
}
