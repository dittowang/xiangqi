/**
 * Frame instrumentation. Cheap enough to leave on in the shipping build,
 * because the thing we are defending against — a spike on the one moment the
 * player is watching — only shows up in a percentile, never in an average.
 */

import type * as THREE from 'three';

const HISTORY = 180; // three seconds at 60fps

export class FrameMonitor {
  /** Ring buffer of CPU frame times in milliseconds. */
  private times = new Float32Array(HISTORY);
  private head = 0;
  private filled = 0;

  /** Exponentially smoothed frame time, for display. */
  smoothedMs = 16.67;
  /** Exponentially smoothed frames per second. */
  fps = 60;
  /** Worst frame since the last reset, ignoring the warm-up. */
  worstMs = 0;
  /** Frames whose cost exceeded the 20 ms spike threshold. */
  spikes = 0;

  private frames = 0;
  private t0 = 0;

  /** Frames to ignore after a reset, while shaders compile and caches warm. */
  private static readonly WARMUP = 40;
  static readonly SPIKE_MS = 20;

  begin(nowMs: number): void {
    this.t0 = nowMs;
  }

  /** Call at the end of the frame. `nowMs` from the same source as `begin`. */
  end(nowMs: number, dt: number): void {
    const ms = nowMs - this.t0;
    this.times[this.head] = ms;
    this.head = (this.head + 1) % HISTORY;
    if (this.filled < HISTORY) this.filled++;
    this.frames++;

    // A single-pole filter; 0.08 settles in about a third of a second.
    this.smoothedMs += (ms - this.smoothedMs) * 0.08;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.08;

    if (this.frames > FrameMonitor.WARMUP) {
      if (ms > this.worstMs) this.worstMs = ms;
      if (ms > FrameMonitor.SPIKE_MS) this.spikes++;
    }
  }

  /** Percentile of the recent window. p is 0..1; p95 is the number that matters. */
  percentile(p: number): number {
    const n = this.filled;
    if (n === 0) return 0;
    // Copy-and-sort of at most 180 floats, only called by the HUD and the
    // governor — well under any per-frame budget, and it avoids keeping a
    // second sorted structure in sync.
    const buf = scratch.subarray(0, n);
    buf.set(this.times.subarray(0, n));
    buf.sort();
    const i = Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))));
    return buf[i];
  }

  reset(): void {
    this.head = 0;
    this.filled = 0;
    this.frames = 0;
    this.worstMs = 0;
    this.spikes = 0;
  }
}

const scratch = new Float32Array(HISTORY);

/** Renderer counters, snapshotted so the HUD reads a stable value per frame. */
export interface RenderCounters {
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
}

export function readCounters(renderer: THREE.WebGLRenderer): RenderCounters {
  const info = renderer.info;
  return {
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    programs: info.programs?.length ?? 0,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
  };
}
