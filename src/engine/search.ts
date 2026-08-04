/**
 * Iterative-deepening alpha-beta search.
 *
 * Everything here exists to make the move ordering good, because ordering is
 * worth more than any other single component: a perfectly ordered tree has an
 * effective branching factor of sqrt(b), and xiangqi's b is around 40. The
 * ordering chain is TT move -> MVV-LVA captures -> two killers -> history, and
 * `SearchResultFull.effectiveBranching` reports the measured node ratio between
 * successive depths so the claim can be checked rather than believed.
 *
 * Xiangqi-specific choices worth calling out:
 *
 *   - **No legal move is a LOSS, never a draw.** The `legal === 0` return is
 *     `-MATE_VALUE + ply` whether or not the side is in check. Getting this
 *     wrong makes the engine walk into 困斃 thinking it has escaped.
 *   - **Repetition is not automatically a draw.** Perpetual check loses, so the
 *     search asks `Position.repetitionVerdict()` and can return a win or a loss
 *     from a repeated position. An engine that scores every repetition as 0
 *     will happily perpetual-check itself into a lost game.
 *   - **Null move needs a material guard.** Zugzwang is rare in xiangqi, but a
 *     bare-general ending is exactly where it is not, so null move is disabled
 *     unless the side to move still has a chariot, cannon or horse.
 */

import type { SearchResult } from '@core/contracts.ts';
import {
  DIFFICULTY,
  type Difficulty,
  type Move,
  NO_MOVE,
  isCapture,
  moveCaptured,
  moveFrom,
  moveTo,
} from '@core/types.ts';
import { seedFor } from '@core/rng.ts';
import { PIECE_VALUE, evaluate } from './eval.ts';
import { MoveList, generateCaptures, generateMoves } from './movegen.ts';
import { type Position, REP_DRAW, REP_LOSS, REP_WIN } from './position.ts';
import { HALFMOVE_DRAW_LIMIT } from './rules.ts';

/** Score of a forced mate at ply 0. Matches `game/annotate.ts`. */
export const MATE_VALUE = 30000;
/** Anything at or above this is a mate score, not an evaluation. */
export const MATE_THRESHOLD = MATE_VALUE - 1000;
const INFINITY = 32000;

/** Deepest ply the search will ever reach, extensions included. */
export const MAX_SEARCH_PLY = 96;

/**
 * Quiescence plies at which quiet checking moves are searched as well as
 * captures. Check *evasions* are always searched exhaustively (a side in check
 * never stands pat); this constant only controls giving check.
 *
 * 1 is a measured compromise: finding quiet checks costs a make/unmake per
 * quiet move at the first quiescence ply, which is about a 25% node-rate hit,
 * and it buys the tactics that end with a cannon dropping onto the back rank.
 * Beyond one ply the cost compounds and the return collapses.
 */
const Q_CHECK_PLIES = 1;

/** Quiescence delta-pruning margin: a captured piece plus this must beat alpha. */
const DELTA_MARGIN = 180;

const FLAG_EXACT = 0;
const FLAG_LOWER = 1;
const FLAG_UPPER = 2;
const FLAG_NONE = 3;

const defaultNow: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

export interface SearchProgress {
  depth: number;
  score: number;
  nodes: number;
  timeMs: number;
  pv: Move[];
}

export interface SearchOptions {
  maxDepth?: number;
  /** Wall-clock budget in milliseconds. 0 or undefined means "no time limit". */
  timeMs?: number;
  /** Hard node cap, used by tests to make a search deterministic. */
  nodeLimit?: number;
  now?: () => number;
  /**
   * Polled alongside the clock, roughly every thousand nodes. This is how a
   * worker gets interrupted mid-search: the main thread flips a shared flag and
   * the search abandons the iteration at the next poll. Without a
   * SharedArrayBuffer a worker cannot see a `stop` message until it is idle.
   */
  shouldStop?: () => boolean;
  onProgress?: (p: SearchProgress) => void;
}

export interface RootCandidate {
  move: Move;
  score: number;
}

export interface SearchResultFull extends SearchResult {
  /** Root moves with their scores from the last completed depth, best first. */
  candidates: RootCandidate[];
  /** Nodes visited at each completed depth, index 0 = depth 1. */
  depthNodes: number[];
  /**
   * Geometric mean of `nodes(d) / nodes(d-1)` over the completed iterations.
   * With no ordering at all this sits near the real branching factor (~40); a
   * well-ordered search drives it toward its square root.
   */
  effectiveBranching: number;
}

// ---------------------------------------------------------------------------

export class Searcher {
  private readonly ttSize: number;
  private readonly ttMask: number;
  private readonly ttKey: Int32Array;
  private readonly ttMove: Int32Array;
  private readonly ttScore: Int32Array;
  /** depth in bits 0..7, flag in 8..9, generation in 10..17. */
  private readonly ttData: Int32Array;
  private generation = 0;

  private readonly killers = new Int32Array(MAX_SEARCH_PLY * 2);
  private readonly history = new Int32Array(16 * 90);
  private readonly lists: MoveList[] = [];
  private readonly qlists: MoveList[] = [];

  private readonly pvTable = new Int32Array(MAX_SEARCH_PLY * MAX_SEARCH_PLY);
  private readonly pvLength = new Int32Array(MAX_SEARCH_PLY);

  private pos!: Position;
  private nodes = 0;
  private deadline = 0;
  private nodeLimit = 0;
  private now: () => number = defaultNow;
  private shouldStop: (() => boolean) | null = null;
  private stopped = false;
  private stopRequested = false;
  private rootDepth = 1;

  private rootMoves = new Int32Array(128);
  private rootScores = new Int32Array(128);
  private rootCount = 0;

  constructor(ttBits = 20) {
    this.ttSize = 1 << ttBits;
    this.ttMask = this.ttSize - 1;
    this.ttKey = new Int32Array(this.ttSize);
    this.ttMove = new Int32Array(this.ttSize);
    this.ttScore = new Int32Array(this.ttSize);
    this.ttData = new Int32Array(this.ttSize).fill(FLAG_NONE << 8);
    for (let i = 0; i < MAX_SEARCH_PLY; i++) {
      this.lists.push(new MoveList());
      this.qlists.push(new MoveList());
    }
  }

  /** Wipe everything that is position-specific. Called between games. */
  newGame(): void {
    this.ttData.fill(FLAG_NONE << 8);
    this.ttKey.fill(0);
    this.ttMove.fill(0);
    this.history.fill(0);
    this.killers.fill(0);
    this.generation = 0;
  }

  /** Ask the running search to abandon the current iteration. */
  stop(): void {
    this.stopRequested = true;
    this.stopped = true;
  }

  search(pos: Position, opts: SearchOptions = {}): SearchResultFull {
    this.pos = pos;
    this.now = opts.now ?? defaultNow;
    this.shouldStop = opts.shouldStop ?? null;
    this.nodes = 0;
    this.stopped = false;
    this.stopRequested = false;
    this.nodeLimit = opts.nodeLimit ?? 0;
    this.generation = (this.generation + 1) & 0xff;

    const start = this.now();
    this.deadline = opts.timeMs && opts.timeMs > 0 ? start + opts.timeMs : 0;
    const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? 24, MAX_SEARCH_PLY - 4));

    // Ageing rather than clearing: the history from the previous move is still
    // largely valid, and halving keeps it from saturating over a long game.
    for (let i = 0; i < this.history.length; i++) this.history[i] >>= 1;
    this.killers.fill(0);

    // Root move list: legal moves only, so the caller never has to re-filter.
    const rootList = this.lists[0];
    generateMoves(pos, rootList);
    this.rootCount = 0;
    for (let i = 0; i < rootList.count; i++) {
      const m = rootList.moves[i];
      const ok = pos.makeMove(m);
      pos.unmakeMove();
      if (ok) {
        this.rootMoves[this.rootCount] = m;
        this.rootScores[this.rootCount] = -INFINITY;
        this.rootCount++;
      }
    }

    if (this.rootCount === 0) {
      return {
        move: NO_MOVE,
        score: -MATE_VALUE,
        depth: 0,
        nodes: 0,
        timeMs: 0,
        pv: [],
        mateIn: -1,
        fromBook: false,
        candidates: [],
        depthNodes: [],
        effectiveBranching: 0,
      };
    }

    let bestMove = this.rootMoves[0];
    let bestScore = 0;
    let completedDepth = 0;
    let pv: Move[] = [bestMove];
    let committed: RootCandidate[] = [{ move: bestMove, score: 0 }];
    const depthNodes: number[] = [];
    let previousNodes = 0;

    for (let depth = 1; depth <= maxDepth; depth++) {
      this.rootDepth = depth;
      let alpha = -INFINITY;
      let beta = INFINITY;

      // Aspiration window once the score has settled. Two widenings, then a
      // full re-search; anything more elaborate is noise at these depths.
      if (depth >= 4 && Math.abs(bestScore) < MATE_THRESHOLD) {
        alpha = bestScore - 45;
        beta = bestScore + 45;
      }

      let score = 0;
      for (let attempt = 0; ; attempt++) {
        score = this.searchRoot(depth, alpha, beta);
        if (this.stopped) break;
        if (score <= alpha) {
          alpha = attempt >= 1 ? -INFINITY : alpha - 160;
          if (attempt >= 1) beta = INFINITY;
          continue;
        }
        if (score >= beta) {
          beta = attempt >= 1 ? INFINITY : beta + 160;
          if (attempt >= 1) alpha = -INFINITY;
          continue;
        }
        break;
      }

      if (this.stopped) break;

      // The iteration finished: this depth's numbers are the ones we keep.
      completedDepth = depth;
      bestScore = score;
      committed = this.snapshotCandidates();
      bestMove = committed[0].move;
      pv = this.extractPv();
      const spent = this.nodes - previousNodes;
      depthNodes.push(spent);
      previousNodes = this.nodes;

      opts.onProgress?.({
        depth,
        score: bestScore,
        nodes: this.nodes,
        timeMs: this.now() - start,
        pv,
      });

      // A forced mate is found; deepening cannot improve on it.
      if (Math.abs(bestScore) >= MATE_THRESHOLD) break;
      // Do not start an iteration there is obviously no time to finish. The
      // node count roughly triples per ply once ordering is working.
      if (this.deadline > 0 && this.now() + (this.now() - start) * 0.45 > this.deadline) break;
    }

    const timeMs = this.now() - start;
    return {
      move: bestMove,
      score: bestScore,
      depth: completedDepth,
      nodes: this.nodes,
      timeMs,
      pv,
      mateIn: mateInFrom(bestScore),
      fromBook: false,
      candidates: committed,
      depthNodes,
      effectiveBranching: branchingFactor(depthNodes),
    };
  }

  // -----------------------------------------------------------------------

  private snapshotCandidates(): RootCandidate[] {
    const out: RootCandidate[] = [];
    for (let i = 0; i < this.rootCount; i++) {
      out.push({ move: this.rootMoves[i], score: this.rootScores[i] });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  private extractPv(): Move[] {
    const out: Move[] = [];
    const n = this.pvLength[0];
    for (let i = 0; i < n; i++) out.push(this.pvTable[i]);
    return out;
  }

  private searchRoot(depth: number, alpha: number, beta: number): number {
    const pos = this.pos;
    this.pvLength[0] = 0;
    let best = -INFINITY;
    let bestIndex = -1;

    // Order the root by the previous iteration's scores; the first move gets a
    // full window and everything after it a null window.
    if (depth > 1) this.sortRootByScore();

    for (let i = 0; i < this.rootCount; i++) {
      const m = this.rootMoves[i];
      if (!pos.makeMove(m)) {
        pos.unmakeMove();
        continue;
      }
      let score: number;
      if (i === 0) {
        score = -this.negamax(depth - 1, -beta, -alpha, 1, true);
      } else {
        score = -this.negamax(depth - 1, -alpha - 1, -alpha, 1, true);
        if (!this.stopped && score > alpha && score < beta) {
          score = -this.negamax(depth - 1, -beta, -alpha, 1, true);
        }
      }
      pos.unmakeMove();
      if (this.stopped) return best;

      this.rootScores[i] = score;
      if (score > best) {
        best = score;
        bestIndex = i;
        this.updatePv(0, m);
        if (score > alpha) alpha = score;
      }
    }

    // Everything that did not beat the window is only a bound; nudge them below
    // the best so the next iteration's ordering stays sane.
    if (bestIndex >= 0) {
      for (let i = 0; i < this.rootCount; i++) {
        if (i !== bestIndex && this.rootScores[i] >= best) this.rootScores[i] = best - 1;
      }
    }
    return best;
  }

  private sortRootByScore(): void {
    // Insertion sort: the list is short and almost always nearly sorted.
    for (let i = 1; i < this.rootCount; i++) {
      const m = this.rootMoves[i];
      const s = this.rootScores[i];
      let j = i - 1;
      while (j >= 0 && this.rootScores[j] < s) {
        this.rootMoves[j + 1] = this.rootMoves[j];
        this.rootScores[j + 1] = this.rootScores[j];
        j--;
      }
      this.rootMoves[j + 1] = m;
      this.rootScores[j + 1] = s;
    }
  }

  // -----------------------------------------------------------------------

  private negamax(depth: number, alpha: number, beta: number, ply: number, allowNull: boolean): number {
    if (this.stopped) return 0;
    const pos = this.pos;
    this.pvLength[ply] = 0;

    // --- draws and repetition. Xiangqi repetition is a *classification*, not
    //     an automatic draw, so a repeated position can be a win or a loss.
    if (pos.halfmove >= HALFMOVE_DRAW_LIMIT) return 0;
    if (pos.bareGenerals()) return 0;
    const rep = pos.repetitionVerdict(2);
    if (rep === REP_DRAW) return 0;
    if (rep === REP_WIN) return MATE_VALUE - ply;
    if (rep === REP_LOSS) return -MATE_VALUE + ply;

    if (depth <= 0) return this.quiesce(alpha, beta, ply, 0);

    this.nodes++;
    if ((this.nodes & 1023) === 0) this.checkTime();
    if (this.stopped) return 0;

    if (ply >= MAX_SEARCH_PLY - 4) return evaluate(pos);

    // --- mate-distance pruning: never look for a mate longer than one already
    //     proven on this path.
    const mateAlpha = alpha > -MATE_VALUE + ply ? alpha : -MATE_VALUE + ply;
    const mateBeta = beta < MATE_VALUE - ply - 1 ? beta : MATE_VALUE - ply - 1;
    if (mateAlpha >= mateBeta) return mateAlpha;
    alpha = mateAlpha;
    beta = mateBeta;

    // --- transposition table
    const index = (pos.keyLo >>> 0) & this.ttMask;
    let ttMove: Move = NO_MOVE;
    if (this.ttKey[index] === pos.keyHi) {
      const data = this.ttData[index];
      const flag = (data >> 8) & 3;
      if (flag !== FLAG_NONE) {
        ttMove = this.ttMove[index];
        const entryDepth = data & 0xff;
        if (entryDepth >= depth) {
          const s = scoreFromTt(this.ttScore[index], ply);
          if (flag === FLAG_EXACT) return s;
          if (flag === FLAG_LOWER && s >= beta) return s;
          if (flag === FLAG_UPPER && s <= alpha) return s;
        }
      }
    }

    const inCheck = pos.checkNow;

    // --- null-move pruning. Guarded by real material because a bare-general
    //     ending is the one place a xiangqi side can genuinely be in zugzwang.
    if (
      allowNull &&
      !inCheck &&
      depth >= 3 &&
      beta < MATE_THRESHOLD &&
      pos.majorCount(pos.side) > 0
    ) {
      const R = depth > 6 ? 3 : 2;
      pos.makeNull();
      const v = -this.negamax(depth - 1 - R, -beta, -beta + 1, ply + 1, false);
      pos.unmakeNull();
      if (this.stopped) return 0;
      if (v >= beta) return beta;
    }

    // --- check extension, capped so a perpetual cannot extend forever.
    const extension = inCheck && ply < this.rootDepth * 2 ? 1 : 0;

    const list = this.lists[ply];
    generateMoves(pos, list);
    this.scoreMoves(list, ttMove, ply);

    let bestScore = -INFINITY;
    let bestMove: Move = NO_MOVE;
    let legal = 0;
    let flag = FLAG_UPPER;

    for (let i = 0; i < list.count; i++) {
      pickBest(list, i);
      const m = list.moves[i];
      if (!pos.makeMove(m)) {
        pos.unmakeMove();
        continue;
      }
      legal++;
      const givesCheck = pos.checkNow;
      const newDepth = depth - 1 + extension;

      let score: number;
      if (legal === 1) {
        score = -this.negamax(newDepth, -beta, -alpha, ply + 1, true);
      } else {
        // --- late move reductions. Only quiet, late, non-checking moves in a
        //     position that is not itself a check; xiangqi tactics are sharp
        //     enough that reducing anything else costs more than it saves.
        let reduction = 0;
        if (depth >= 3 && legal > 3 && !inCheck && !givesCheck && !isCapture(m)) {
          reduction = legal > 6 ? 2 : 1;
          if (reduction >= newDepth) reduction = newDepth - 1;
          if (reduction < 0) reduction = 0;
        }
        score = -this.negamax(newDepth - reduction, -alpha - 1, -alpha, ply + 1, true);
        if (!this.stopped && reduction > 0 && score > alpha) {
          score = -this.negamax(newDepth, -alpha - 1, -alpha, ply + 1, true);
        }
        if (!this.stopped && score > alpha && score < beta) {
          score = -this.negamax(newDepth, -beta, -alpha, ply + 1, true);
        }
      }
      pos.unmakeMove();
      if (this.stopped) return 0;

      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
        if (score > alpha) {
          alpha = score;
          flag = FLAG_EXACT;
          this.updatePv(ply, m);
          if (score >= beta) {
            flag = FLAG_LOWER;
            if (!isCapture(m)) {
              this.storeKiller(ply, m);
              this.history[pos.board[moveFrom(m)] * 90 + moveTo(m)] += depth * depth;
            }
            break;
          }
        }
      }
    }

    // --- no legal move. In xiangqi this is a LOSS whether or not the side is
    //     in check: 將死 and 困斃 score identically.
    if (legal === 0) return -MATE_VALUE + ply;

    this.ttStore(index, pos.keyHi, depth, bestScore, flag, bestMove, ply);
    return bestScore;
  }

  // -----------------------------------------------------------------------

  private quiesce(alpha: number, beta: number, ply: number, qply: number): number {
    const pos = this.pos;
    this.nodes++;
    if ((this.nodes & 1023) === 0) this.checkTime();
    if (this.stopped) return 0;
    if (ply >= MAX_SEARCH_PLY - 4) return evaluate(pos);

    const inCheck = pos.checkNow;
    let best = -INFINITY;

    if (!inCheck) {
      // Stand pat: the side to move is never forced to capture, so the static
      // score is a lower bound on what it can achieve.
      const standPat = evaluate(pos);
      if (standPat >= beta) return standPat;
      if (standPat > alpha) alpha = standPat;
      best = standPat;
    }

    const list = this.qlists[ply];
    const wantQuietChecks = !inCheck && qply < Q_CHECK_PLIES;
    if (inCheck || wantQuietChecks) generateMoves(pos, list);
    else generateCaptures(pos, list);
    this.scoreMoves(list, NO_MOVE, ply);

    let legal = 0;
    for (let i = 0; i < list.count; i++) {
      pickBest(list, i);
      const m = list.moves[i];
      const captured = moveCaptured(m);

      // --- delta pruning: if winning this piece outright still leaves us short
      //     of alpha, the line is not worth a node.
      if (!inCheck && captured !== 0 && best > -INFINITY) {
        if (best + PIECE_VALUE[captured & 7] + DELTA_MARGIN < alpha) continue;
      }

      if (!pos.makeMove(m)) {
        pos.unmakeMove();
        continue;
      }
      legal++;
      if (!inCheck && captured === 0 && !pos.checkNow) {
        // A quiet move that turned out not to give check: not a quiescence move.
        pos.unmakeMove();
        continue;
      }
      const score = -this.quiesce(-beta, -alpha, ply + 1, qply + 1);
      pos.unmakeMove();
      if (this.stopped) return 0;

      if (score > best) {
        best = score;
        if (score > alpha) {
          alpha = score;
          if (score >= beta) break;
        }
      }
    }

    // Mated while in check inside quiescence.
    if (inCheck && legal === 0) return -MATE_VALUE + ply;
    return best;
  }

  // -----------------------------------------------------------------------

  private checkTime(): void {
    if (this.stopRequested || (this.shouldStop !== null && this.shouldStop())) {
      this.stopped = true;
      return;
    }
    if (this.nodeLimit > 0 && this.nodes >= this.nodeLimit) {
      this.stopped = true;
      return;
    }
    if (this.deadline > 0 && this.now() >= this.deadline) this.stopped = true;
  }

  private scoreMoves(list: MoveList, ttMove: Move, ply: number): void {
    const k1 = this.killers[ply * 2];
    const k2 = this.killers[ply * 2 + 1];
    const board = this.pos.board;
    for (let i = 0; i < list.count; i++) {
      const m = list.moves[i];
      let s: number;
      if (m === ttMove && ttMove !== NO_MOVE) {
        s = 2_000_000;
      } else {
        const captured = moveCaptured(m);
        if (captured !== 0) {
          // MVV-LVA: the victim dominates, the attacker breaks ties, so a
          // soldier taking a chariot is always tried before a chariot taking a
          // soldier.
          const attacker = board[moveFrom(m)] & 7;
          s = 1_000_000 + PIECE_VALUE[captured & 7] * 16 - PIECE_VALUE[attacker];
        } else if (m === k1) {
          s = 900_000;
        } else if (m === k2) {
          s = 800_000;
        } else {
          const h = this.history[board[moveFrom(m)] * 90 + moveTo(m)];
          s = h > 700_000 ? 700_000 : h;
        }
      }
      list.scores[i] = s;
    }
  }

  private storeKiller(ply: number, m: Move): void {
    const slot = ply * 2;
    if (this.killers[slot] === m) return;
    this.killers[slot + 1] = this.killers[slot];
    this.killers[slot] = m;
  }

  private updatePv(ply: number, m: Move): void {
    const base = ply * MAX_SEARCH_PLY;
    this.pvTable[base] = m;
    const childBase = (ply + 1) * MAX_SEARCH_PLY;
    const childLen = ply + 1 < MAX_SEARCH_PLY ? this.pvLength[ply + 1] : 0;
    for (let i = 0; i < childLen; i++) this.pvTable[base + 1 + i] = this.pvTable[childBase + i];
    this.pvLength[ply] = childLen + 1;
  }

  /**
   * Depth-preferred replacement with generation ageing: an entry from an older
   * search is always replaceable, one from this search only by a deeper probe.
   */
  private ttStore(
    index: number,
    keyHi: number,
    depth: number,
    score: number,
    flag: number,
    move: Move,
    ply: number,
  ): void {
    const data = this.ttData[index];
    const entryGen = (data >> 10) & 0xff;
    const entryDepth = data & 0xff;
    const entryFlag = (data >> 8) & 3;
    if (entryFlag !== FLAG_NONE && entryGen === this.generation && entryDepth > depth) return;

    this.ttKey[index] = keyHi;
    this.ttMove[index] = move;
    this.ttScore[index] = scoreToTt(score, ply);
    this.ttData[index] = (depth & 0xff) | (flag << 8) | (this.generation << 10);
  }
}

// ---------------------------------------------------------------------------
// Mate score bookkeeping
// ---------------------------------------------------------------------------

/**
 * Mate scores are stored relative to the *entry*, not to the root, so the same
 * entry stays correct when it is reached at a different distance. Depth
 * adjustment is also what makes the engine prefer a mate in one to a mate in
 * five: `MATE_VALUE - ply` shrinks with distance.
 */
function scoreToTt(score: number, ply: number): number {
  if (score >= MATE_THRESHOLD) return score + ply;
  if (score <= -MATE_THRESHOLD) return score - ply;
  return score;
}
function scoreFromTt(score: number, ply: number): number {
  if (score >= MATE_THRESHOLD) return score - ply;
  if (score <= -MATE_THRESHOLD) return score + ply;
  return score;
}

function mateInFrom(score: number): number | null {
  if (Math.abs(score) < MATE_THRESHOLD) return null;
  const plies = MATE_VALUE - Math.abs(score);
  const moves = Math.max(1, Math.ceil(plies / 2));
  return score > 0 ? moves : -moves;
}

/** Selection sort step: pull the highest-scoring remaining move to slot `i`. */
function pickBest(list: MoveList, i: number): void {
  let bestIndex = i;
  let bestScore = list.scores[i];
  for (let j = i + 1; j < list.count; j++) {
    if (list.scores[j] > bestScore) {
      bestScore = list.scores[j];
      bestIndex = j;
    }
  }
  if (bestIndex === i) return;
  const m = list.moves[i];
  list.moves[i] = list.moves[bestIndex];
  list.moves[bestIndex] = m;
  list.scores[bestIndex] = list.scores[i];
  list.scores[i] = bestScore;
}

function branchingFactor(depthNodes: number[]): number {
  const ratios: number[] = [];
  for (let i = 1; i < depthNodes.length; i++) {
    if (depthNodes[i - 1] > 0 && depthNodes[i] > 0) ratios.push(depthNodes[i] / depthNodes[i - 1]);
  }
  if (ratios.length === 0) return 0;
  let logSum = 0;
  for (const r of ratios) logSum += Math.log(r);
  return Math.exp(logSum / ratios.length);
}

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

/**
 * How far below the best move a candidate may sit and still be considered.
 *
 * This is the single most important number in the whole difficulty system. The
 * naive way to make an engine weak is to add unbounded noise, which produces a
 * player that makes three good moves and then hangs a chariot for nothing —
 * insulting to play against, and nothing like a weak human. Capping the loss
 * means "easy" plays a *plausible* move that happens to be the third best:
 * it misses combinations, mishandles the opening, and lets you win material
 * slowly, which is exactly what a weak club player does.
 *
 * 220cp is about half a horse: the engine will drop a soldier or misjudge an
 * exchange, and will never give away a chariot.
 */
const MAX_ACCEPTABLE_LOSS: Record<Difficulty, number> = {
  easy: 220,
  medium: 110,
  hard: 0,
};

export interface FindMoveOptions extends SearchOptions {
  /** Overrides the profile's own budget; used by hint and review analysis. */
  timeMs?: number;
  /** Deterministic stream selector, so a replayed game picks the same moves. */
  pickSeed?: number | string;
  /** Set false to skip the opening book even on a profile that uses it. */
  useBook?: boolean;
  /** Injected so tests can drive the book without importing it. */
  bookLookup?: (pos: Position) => { move: Move; weight: number }[] | null;
}

/**
 * The full move-selection pipeline the game layer calls: book, then search,
 * then the difficulty-shaped choice among the root candidates.
 */
export function findBestMove(
  searcher: Searcher,
  pos: Position,
  difficulty: Difficulty,
  opts: FindMoveOptions = {},
): SearchResultFull {
  const profile = DIFFICULTY[difficulty];
  const rng = seedFor('engine', 'pick', difficulty, String(opts.pickSeed ?? 0), pos.keyLo >>> 0);

  if ((opts.useBook ?? profile.useBook) && opts.bookLookup) {
    const entries = opts.bookLookup(pos);
    if (entries && entries.length > 0) {
      const move = weightedPick(entries, rng.next());
      return {
        move,
        score: 0,
        depth: 0,
        nodes: 0,
        timeMs: 0,
        pv: [move],
        mateIn: null,
        fromBook: true,
        candidates: entries.map((e) => ({ move: e.move, score: 0 })),
        depthNodes: [],
        effectiveBranching: 0,
      };
    }
  }

  const result = searcher.search(pos, {
    ...opts,
    maxDepth: opts.maxDepth ?? profile.maxDepth,
    timeMs: opts.timeMs ?? profile.timeMs,
  });

  if (result.candidates.length <= 1 || profile.candidatePool <= 1 || profile.slipChance <= 0) {
    return result;
  }

  // Never slip out of a forced win, and never slip *into* a forced loss.
  const bestScore = result.candidates[0].score;
  if (Math.abs(bestScore) >= MATE_THRESHOLD) return result;

  const budget = MAX_ACCEPTABLE_LOSS[difficulty];
  const pool = result.candidates
    .filter((c) => bestScore - c.score <= budget && Math.abs(c.score) < MATE_THRESHOLD)
    .slice(0, profile.candidatePool);
  if (pool.length <= 1) return result;

  if (!rng.chance(profile.slipChance)) return result;

  // Soft-max over noisy scores. The noise is what turns "third best" into
  // something that varies between games instead of being a fixed personality.
  const scale = Math.max(40, profile.noiseCp);
  const noisy = pool.map((c) => ({ move: c.move, v: c.score + rng.gauss() * profile.noiseCp }));
  let top = -Infinity;
  for (const n of noisy) if (n.v > top) top = n.v;
  const weights = noisy.map((n) => ({ move: n.move, weight: Math.exp((n.v - top) / scale) }));
  const chosen = weightedPick(weights, rng.next());

  const chosenScore = result.candidates.find((c) => c.move === chosen)?.score ?? bestScore;
  return { ...result, move: chosen, score: chosenScore, pv: [chosen], mateIn: mateInFrom(chosenScore) };
}

function weightedPick(entries: { move: Move; weight: number }[], r: number): Move {
  let total = 0;
  for (const e of entries) total += e.weight;
  if (total <= 0) return entries[0].move;
  let x = r * total;
  for (const e of entries) {
    x -= e.weight;
    if (x <= 0) return e.move;
  }
  return entries[entries.length - 1].move;
}
