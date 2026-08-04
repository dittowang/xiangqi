/**
 * The engine's public surface.
 *
 * Two audiences:
 *
 *   - `main.ts` / `game/` want `createEngineClient()` for the searching side
 *     and the synchronous rule functions for everything the UI must answer
 *     instantly — legal-move highlights on hover, check state, adjudication,
 *     notation for the 棋譜.
 *   - The test suite wants the internals: `Position`, `perft`, `Searcher`,
 *     `evaluate`.
 *
 * Everything below runs unchanged on the main thread and inside the worker.
 */

export { Position, REP_DRAW, REP_LOSS, REP_NONE, REP_WIN, MAX_HISTORY } from './position.ts';
export {
  MoveList,
  generateCaptures,
  generateLegalMoves,
  generateMoves,
  findLegalMove,
  hasLegalMove,
  legalMoves,
  legalTargets,
  perft,
  perftDivide,
} from './movegen.ts';
export {
  FenError,
  debugBoard,
  formatFen,
  iccsToSquare,
  parseFen,
  squareToIccs,
  type ParsedFen,
} from './fen.ts';
export {
  HALFMOVE_DRAW_LIMIT,
  REPETITION_LIMIT,
  adjudicate,
  analyseRepetition,
  classifyRepetition,
  isCheckmate,
  isStalemate,
  legalMoveCount,
  type RepetitionAnalysis,
} from './rules.ts';
export {
  iccsToMove,
  lineToNotation,
  moveToIccs,
  moveToNotation,
  parseNotation,
} from './notation.ts';
export {
  LAZY_MARGIN,
  PIECE_VALUE,
  breakdown,
  evaluate,
  evaluateRedPov,
  lazyExitCount,
  lazyOmittedMagnitude,
  resetLazyExitCount,
  weightsFor,
  type EvalBreakdown,
  type EvalWeights,
} from './eval.ts';
export { SEE_VALUE, mayLoseMaterial, see, smallestAttacker } from './see.ts';
export {
  MATERIAL_ENDGAME,
  MATERIAL_OPENING,
  PHASE_MAX,
  SOLDIER_CROSSED,
  SOLDIER_DEEP,
} from './terms.ts';
export {
  MATE_THRESHOLD,
  MATE_VALUE,
  MAX_SEARCH_PLY,
  Searcher,
  findBestMove,
  type FindMoveOptions,
  type RootCandidate,
  type SearchOptions,
  type SearchProgress,
  type SearchResultFull,
} from './search.ts';
export { bookEntries, bookLineNames, bookStats, type BookEntry, type BookStats } from './book.ts';
export { EngineHost, type HostSearchOptions } from './host.ts';
export { LocalEngineClient, createEngineClient, type EngineClientOptions } from './client.ts';
export type { EngineRequest, EngineResponse } from './protocol.ts';
export { keyString } from './zobrist.ts';
export { mirrorSquare } from './tables.ts';
