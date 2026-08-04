/**
 * The engine's request handler, independent of where it runs.
 *
 * The worker owns one of these; so does the main-thread fallback used when
 * `Worker` is unavailable (Node, tests, or a browser that refused the module
 * worker). Keeping the logic here rather than in `worker.ts` is what makes the
 * engine genuinely isomorphic: exactly the same code path answers a search
 * whether or not a thread boundary was crossed.
 */

import type { SearchResult } from '@core/contracts.ts';
import { START_FEN } from '@core/testapi.ts';
import { type Difficulty, type Move, NO_MOVE } from '@core/types.ts';
import { bookEntries } from './book.ts';
import { perft } from './movegen.ts';
import { Position } from './position.ts';
import { type SearchProgress, Searcher, findBestMove } from './search.ts';

export interface HostSearchOptions {
  timeMs?: number;
  maxDepth?: number;
  onProgress?: (p: SearchProgress) => void;
  shouldStop?: () => boolean;
}

export class EngineHost {
  /** The authoritative position, including the history repetition rules need. */
  readonly position = new Position(START_FEN);
  private readonly searcher: Searcher;
  private readonly analysisPosition = new Position(START_FEN);
  private readonly analysisSearcher: Searcher;

  constructor(ttBits = 20) {
    this.searcher = new Searcher(ttBits);
    // A smaller, separate table for hints and review so an analysis probe never
    // evicts the entries the game search is relying on.
    this.analysisSearcher = new Searcher(Math.max(12, ttBits - 4));
  }

  newGame(): void {
    this.position.setFen(START_FEN);
    this.searcher.newGame();
    this.analysisSearcher.newGame();
  }

  /**
   * Replace the position. `moves` are applied on top of `fen` through the real
   * move generator, which is what gives the search a repetition history — a
   * bare FEN cannot express "this position has occurred twice already".
   */
  setPosition(fen: string, moves: readonly Move[]): void {
    this.position.setFen(fen);
    for (const m of moves) {
      if (m === NO_MOVE) continue;
      if (!this.position.makeMove(m)) {
        this.position.unmakeMove();
        throw new Error(`illegal move ${m} while replaying the position`);
      }
    }
  }

  search(difficulty: Difficulty, opts: HostSearchOptions = {}): SearchResult {
    const full = findBestMove(this.searcher, this.position, difficulty, {
      timeMs: opts.timeMs,
      maxDepth: opts.maxDepth,
      onProgress: opts.onProgress,
      shouldStop: opts.shouldStop,
      // Seeding from the ply keeps a replayed game byte-identical while still
      // giving different games different personalities.
      pickSeed: this.position.ply,
      bookLookup: bookEntries,
    });
    return stripInternals(full);
  }

  /** Full-strength fixed-time analysis: no book, no noise, no slip. */
  analyse(fen: string, timeMs: number, opts: HostSearchOptions = {}): SearchResult {
    this.analysisPosition.setFen(fen);
    const full = findBestMove(this.analysisSearcher, this.analysisPosition, 'hard', {
      timeMs,
      useBook: false,
      onProgress: opts.onProgress,
      shouldStop: opts.shouldStop,
    });
    return stripInternals(full);
  }

  perft(fen: string, depth: number): number {
    const p = new Position(fen);
    return perft(p, depth);
  }

  stop(): void {
    this.searcher.stop();
    this.analysisSearcher.stop();
  }
}

function stripInternals(full: SearchResult & Record<string, unknown>): SearchResult {
  return {
    move: full.move,
    score: full.score,
    depth: full.depth,
    nodes: full.nodes,
    timeMs: full.timeMs,
    pv: full.pv,
    mateIn: full.mateIn,
    fromBook: full.fromBook,
  };
}
