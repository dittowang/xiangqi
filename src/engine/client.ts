/**
 * `EngineClient` — the main thread's facade over the search worker.
 *
 * Two implementations behind one interface:
 *
 *   - `WorkerEngineClient` owns a module worker and talks to it over
 *     `protocol.ts`. This is what the game uses: a 2.6-second hard search never
 *     costs the renderer a frame.
 *   - `LocalEngineClient` runs the same `EngineHost` on the calling thread. It
 *     exists for Node (tests, tooling) and as the fallback when a browser
 *     refuses to construct a module worker. It *will* block, and it says so.
 *
 * `createEngineClient()` picks the right one. Nothing above this file needs to
 * know which it got.
 */

import type { EngineClient, SearchResult } from '@core/contracts.ts';
import type { Difficulty, Move } from '@core/types.ts';
import { EngineHost } from './host.ts';
import type { EngineRequest, EngineResponse } from './protocol.ts';
import { STOP_FLAG_INDEX } from './protocol.ts';
import type { SearchProgress } from './search.ts';

export interface EngineClientOptions {
  /** Forwarded from the worker as the search deepens; drives the HUD. */
  onProgress?: (p: SearchProgress) => void;
  /** Force the in-thread implementation (tests, or a debugging session). */
  forceLocal?: boolean;
}

// ---------------------------------------------------------------------------

class WorkerEngineClient implements EngineClient {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    { resolve: (r: EngineResponse) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private readyPromise: Promise<void>;
  private stopFlag: Int32Array | null = null;
  private disposed = false;

  constructor(private readonly opts: EngineClientOptions) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<EngineResponse>) => this.onMessage(event.data);
    this.worker.onerror = (event) => {
      const err = new Error(`engine worker failed: ${event.message}`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    };

    // A stop that actually interrupts a running search needs shared memory; a
    // page that is not cross-origin isolated does not get one, and `stop()`
    // degrades to "the next search will not start".
    let sab: SharedArrayBuffer | undefined;
    if (typeof SharedArrayBuffer !== 'undefined') {
      try {
        sab = new SharedArrayBuffer(4);
        this.stopFlag = new Int32Array(sab);
      } catch {
        sab = undefined;
      }
    }
    this.readyPromise = this.request({ id: 0, kind: 'init', stopFlag: sab }).then(() => undefined);
  }

  private onMessage(msg: EngineResponse): void {
    if (msg.kind === 'progress') {
      this.opts.onProgress?.({
        depth: msg.depth,
        score: msg.score,
        nodes: msg.nodes,
        timeMs: 0,
        pv: msg.pv,
      });
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.kind === 'error') entry.reject(new Error(msg.message));
    else entry.resolve(msg);
  }

  private request(req: Omit<EngineRequest, 'id'> & { id?: number }): Promise<EngineResponse> {
    if (this.disposed) return Promise.reject(new Error('engine client disposed'));
    const id = req.id ?? this.nextId++;
    const full = { ...req, id } as EngineRequest;
    return new Promise<EngineResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(full);
    });
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  async newGame(): Promise<void> {
    this.clearStop();
    await this.request({ kind: 'newGame' });
  }

  async setPosition(fen: string, moves: Move[]): Promise<void> {
    await this.request({ kind: 'setPosition', fen, moves });
  }

  async search(difficulty: Difficulty, opts?: { timeMs?: number }): Promise<SearchResult> {
    this.clearStop();
    const res = await this.request({ kind: 'search', difficulty, timeMs: opts?.timeMs });
    if (res.kind !== 'result') throw new Error('unexpected engine response');
    return res.result;
  }

  async analyse(fen: string, timeMs: number): Promise<SearchResult> {
    this.clearStop();
    const res = await this.request({ kind: 'analyse', fen, timeMs });
    if (res.kind !== 'result') throw new Error('unexpected engine response');
    return res.result;
  }

  stop(): void {
    if (this.stopFlag) Atomics.store(this.stopFlag, STOP_FLAG_INDEX, 1);
    // Queued behind whatever the worker is doing; harmless either way.
    void this.request({ kind: 'stop' }).catch(() => undefined);
  }

  private clearStop(): void {
    if (this.stopFlag) Atomics.store(this.stopFlag, STOP_FLAG_INDEX, 0);
  }

  async perft(fen: string, depth: number): Promise<number> {
    const res = await this.request({ kind: 'perft', fen, depth });
    if (res.kind !== 'perft') throw new Error('unexpected engine response');
    return res.nodes;
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------

/**
 * In-thread implementation. Correct, identical results, and it blocks the
 * caller for the whole search budget — only use it where that is acceptable.
 */
export class LocalEngineClient implements EngineClient {
  private readonly host: EngineHost;
  private stopping = false;

  constructor(private readonly opts: EngineClientOptions = {}, ttBits = 18) {
    this.host = new EngineHost(ttBits);
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  async newGame(): Promise<void> {
    this.stopping = false;
    this.host.newGame();
  }

  async setPosition(fen: string, moves: Move[]): Promise<void> {
    this.host.setPosition(fen, moves);
  }

  async search(difficulty: Difficulty, opts?: { timeMs?: number }): Promise<SearchResult> {
    this.stopping = false;
    // Yield once so the caller's `await` behaves like the worker version and a
    // "thinking" indicator has a chance to paint before the thread locks up.
    await Promise.resolve();
    return this.host.search(difficulty, {
      timeMs: opts?.timeMs,
      onProgress: this.opts.onProgress,
      shouldStop: () => this.stopping,
    });
  }

  async analyse(fen: string, timeMs: number): Promise<SearchResult> {
    this.stopping = false;
    await Promise.resolve();
    return this.host.analyse(fen, timeMs, {
      onProgress: this.opts.onProgress,
      shouldStop: () => this.stopping,
    });
  }

  stop(): void {
    this.stopping = true;
    this.host.stop();
  }

  async perft(fen: string, depth: number): Promise<number> {
    return this.host.perft(fen, depth);
  }

  dispose(): void {
    // Nothing to release: no threads, no GPU resources.
  }
}

// ---------------------------------------------------------------------------

/**
 * Build the best available client. Prefers a module worker; falls back to the
 * in-thread implementation when one cannot be constructed (Node, or a browser
 * that blocked it).
 */
export function createEngineClient(opts: EngineClientOptions = {}): EngineClient {
  if (!opts.forceLocal && typeof Worker !== 'undefined') {
    try {
      return new WorkerEngineClient(opts);
    } catch (err) {
      console.warn('[engine] module worker unavailable, running in-thread', err);
    }
  }
  return new LocalEngineClient(opts);
}
