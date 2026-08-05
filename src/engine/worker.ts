/**
 * Worker entry point.
 *
 * Loaded as `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`,
 * so Vite bundles it as a separate module chunk and the search never touches
 * the main thread's frame budget.
 *
 * The only thing this file does is translate messages into `EngineHost` calls.
 * Everything the engine knows lives in modules that also import cleanly on the
 * main thread, which is what lets the UI compute legal-move highlights without
 * a round trip.
 */

import type { EngineRequest, EngineResponse } from './protocol.ts';
import { STOP_FLAG_INDEX } from './protocol.ts';
import { EngineHost } from './host.ts';

const host = new EngineHost();

/**
 * A worker cannot read its message queue while it is inside a search, so a
 * plain `stop` message is only seen once the search has already finished. When
 * the page is cross-origin isolated the client hands us a SharedArrayBuffer
 * instead and the search polls it directly.
 */
let stopFlag: Int32Array | null = null;
const shouldStop = () => stopFlag !== null && Atomics.load(stopFlag, STOP_FLAG_INDEX) !== 0;

function post(msg: EngineResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = (event: MessageEvent<EngineRequest>) => {
  const req = event.data;
  try {
    switch (req.kind) {
      case 'init':
        if (req.stopFlag) stopFlag = new Int32Array(req.stopFlag);
        post({ id: req.id, kind: 'ready' });
        break;

      case 'newGame':
        host.newGame();
        post({ id: req.id, kind: 'ok' });
        break;

      case 'setPosition':
        host.setPosition(req.fen, req.moves);
        post({ id: req.id, kind: 'ok' });
        break;

      case 'search': {
        const result = host.search(req.difficulty, {
          timeMs: req.timeMs,
          maxDepth: req.maxDepth,
          shouldStop,
          onProgress: (p) =>
            post({ id: req.id, kind: 'progress', depth: p.depth, score: p.score, nodes: p.nodes, pv: p.pv }),
        });
        post({ id: req.id, kind: 'result', result });
        break;
      }

      case 'analyse': {
        const result = host.analyse(req.fen, req.timeMs, {
          // Depth-bounded when the caller asks for it, so a review annotates the
          // same game the same way on every run.
          ...(req.depth ? { maxDepth: req.depth } : {}),
          shouldStop,
          onProgress: (p) =>
            post({ id: req.id, kind: 'progress', depth: p.depth, score: p.score, nodes: p.nodes, pv: p.pv }),
        });
        post({ id: req.id, kind: 'result', result });
        break;
      }

      case 'perft':
        post({ id: req.id, kind: 'perft', nodes: host.perft(req.fen, req.depth) });
        break;

      case 'stop':
        host.stop();
        post({ id: req.id, kind: 'ok' });
        break;
    }
  } catch (err) {
    post({ id: req.id, kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
