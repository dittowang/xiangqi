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
import { type Difficulty, type Move, NO_MOVE, moveFrom, moveTo } from '@core/types.ts';
import { bookEntries } from './book.ts';
import { findLegalMove, perft } from './movegen.ts';
import { Position } from './position.ts';
import { type SearchProgress, type SearchResultFull, Searcher, findBestMove } from './search.ts';

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
   *
   * Every move is validated against the legal move list rather than simply made,
   * because this is the path a saved game is restored through: a save written by
   * an older build with a different move encoding must fail loudly here so the
   * game layer can discard it, not silently produce a corrupt board.
   */
  setPosition(fen: string, moves: readonly Move[]): void {
    this.position.setFen(fen);
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      if (m === NO_MOVE) continue;
      const legal = findLegalMove(this.position, moveFrom(m), moveTo(m));
      if (legal === 0) {
        throw new Error(
          `move ${i + 1} (${moveFrom(m)}->${moveTo(m)}) is not legal in ${this.position.toFen()}`,
        );
      }
      this.position.makeMove(legal);
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

  /**
   * Full-strength analysis: no book, no noise, no slip.
   *
   * With `opts.maxDepth` set the search is bounded by DEPTH and `timeMs` is only
   * a safety cap, so the same position always returns the same answer. Without
   * it the wall clock decides how deep the search got, and a review of the same
   * game annotates differently on every run.
   */
  analyse(fen: string, timeMs: number, opts: HostSearchOptions = {}): SearchResult {
    this.analysisPosition.setFen(fen);
    const full = findBestMove(this.analysisSearcher, this.analysisPosition, 'hard', {
      timeMs,
      ...(opts.maxDepth ? { maxDepth: opts.maxDepth } : {}),
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

/** Drop the search's internal diagnostics; the contract's shape is the wire format. */
function stripInternals(full: SearchResultFull): SearchResult {
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
