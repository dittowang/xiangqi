/**
 * Worker message types.
 *
 * Every request carries an `id` and every response echoes it, so the client can
 * keep several requests in flight and resolve the right promise. Moves cross
 * the boundary as plain numbers (they already are — see `core/types.ts`), so
 * nothing here needs structured cloning beyond arrays of integers.
 */

import type { SearchResult } from '@core/contracts.ts';
import type { Difficulty, Move } from '@core/types.ts';

export type EngineRequest =
  | { id: number; kind: 'init'; stopFlag?: SharedArrayBuffer }
  | { id: number; kind: 'newGame' }
  | { id: number; kind: 'setPosition'; fen: string; moves: Move[] }
  | { id: number; kind: 'search'; difficulty: Difficulty; timeMs?: number; maxDepth?: number }
  | { id: number; kind: 'analyse'; fen: string; timeMs: number }
  | { id: number; kind: 'perft'; fen: string; depth: number }
  | { id: number; kind: 'stop' };

export type EngineResponse =
  | { id: number; kind: 'ready' }
  | { id: number; kind: 'ok' }
  | { id: number; kind: 'result'; result: SearchResult }
  | { id: number; kind: 'perft'; nodes: number }
  | { id: number; kind: 'error'; message: string }
  /** Unsolicited: emitted during a search, `id` matches the search request. */
  | { id: number; kind: 'progress'; depth: number; score: number; nodes: number; pv: Move[] };

/** Index into the shared stop flag, when one is available. */
export const STOP_FLAG_INDEX = 0;
