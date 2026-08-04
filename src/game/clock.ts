/**
 * The one clock. Nothing in the project may call `performance.now()` inside an
 * update path — everything reads `clock.time` and is handed a `dt`. That is
 * what lets the capture harness pause the game, step it by an exact number of
 * seconds, and get a byte-identical frame every run.
 */

export class Clock {
  /** Accumulated simulation time, seconds. */
  time = 0;
  /** Last delta handed to update(), seconds. */
  dt = 0;
  /** Frame counter since boot. */
  frame = 0;
  /** When paused, the rAF loop still runs but `tick()` returns 0. */
  paused = false;

  private last = 0;
  private started = false;
  /** Seconds queued by `step()` while paused, consumed on the next tick. */
  private stepQueue = 0;
  /** Global time scale — the capture animation's hit-hold drops this to 0.06. */
  scale = 1;

  /** Advance from the wall clock, or from the queued step budget when paused. */
  tick(nowMs: number): number {
    if (!this.started) {
      this.started = true;
      this.last = nowMs;
    }

    let dt: number;
    if (this.stepQueue > 0) {
      dt = this.stepQueue;
      this.stepQueue = 0;
      this.last = nowMs;
    } else if (this.paused) {
      this.last = nowMs;
      dt = 0;
    } else {
      dt = (nowMs - this.last) / 1000;
      this.last = nowMs;
      // Clamp so a background tab or a long GC never teleports the simulation.
      if (dt > 0.1) dt = 0.1;
      dt *= this.scale;
    }

    this.dt = dt;
    this.time += dt;
    this.frame++;
    return dt;
  }

  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  /** Queue exactly `seconds` for the next tick. Used only by the harness. */
  queueStep(seconds: number): void {
    this.stepQueue += seconds;
  }
  hasQueuedStep(): boolean {
    return this.stepQueue > 0;
  }
  reset(): void {
    this.time = 0;
    this.frame = 0;
    this.dt = 0;
    this.stepQueue = 0;
    this.started = false;
    this.scale = 1;
  }
}

export const clock = new Clock();
