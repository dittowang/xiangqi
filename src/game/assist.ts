/**
 * The three things a player can ask of the engine outside its own turn:
 * a hint, a takeback, and a post-mortem.
 *
 * All three are the same shape — interrupt whatever is in flight, put the
 * board somewhere the model did not ask for, and put it back — so they live
 * together and share one interruption discipline instead of three.
 *
 * ── The interruption discipline ─────────────────────────────────────────────
 *
 * A move in this game is a chain: `Match.apply` → the choreographer's promise →
 * `Match.settle` → `Match.think` → the reply's chain. `Choreography.abort()`
 * *cancels* rather than completes, so the awaited promise still resolves and
 * the chain carries on running — into a `settle()` for a move that has just
 * been taken back, and then into an engine reply to a position that no longer
 * exists.
 *
 * The fix is a generation counter, not a flag. Anything that interrupts bumps
 * it; a move flow captures it at the top and checks it after every await. Two
 * lines in `main.ts` (see `beginFlow` / `flowValid`) and the race is closed for
 * takeback, review and reset alike, without this module having to know anything
 * about how the flow is written.
 *
 * ── Why review drives `Match.pos` directly ──────────────────────────────────
 *
 * `Match` owns exactly one `Position` and reconciles the figures against it in
 * `sync()`. Review needs the board at an arbitrary earlier ply while KEEPING the
 * move list intact, which `Match.takeback()` cannot do — it pops the list. So
 * review unwinds and rewinds `match.pos` through its own history and leaves
 * `match.moves` untouched, then restores the position on the way out. Nothing
 * else may write the position while review is up, which is guaranteed by the
 * mode: `Match.humanToMove` is false for a finished game, and `enterReview`
 * refuses to start while a search or an animation is running.
 */

import type { BoardScene, Choreographer, EngineClient, SearchResult } from '@core/contracts.ts';
import { bus } from '@core/bus.ts';
import {
  clamp,
  moveFrom,
  moveTo,
  Side,
  type Move,
  type MoveQuality,
} from '@core/types.ts';
import { START_FEN } from '@core/testapi.ts';
import { Position, legalMoveCount, lineToNotation, moveToNotation } from '@engine/index.ts';
import { annotate, type Annotation } from '@game/annotate.ts';
import type { Match } from '@game/match.ts';
import type { ReviewPanel, ReviewRow } from '@ui/review.ts';

// ===========================================================================
// Tuning
// ===========================================================================

/** Analysis budget per position during a review sweep, milliseconds. */
const REVIEW_MS = 320;
/** Analysis budget for a hint. The brief's number, and it is the right one. */
const HINT_MS = 800;
/** Seconds a hint's marks stay on the board before they lift on their own. */
const HINT_LINGER = 6;

// ===========================================================================
// Public shape
// ===========================================================================

/** One judged ply, in full. The panel gets a projection of this. */
export interface AnalysedPly {
  /** 1-based ply number. */
  ply: number;
  move: Move;
  side: Side;
  notation: string;
  /** Evaluation before and after the move, centipawns, RED's point of view. */
  evalBefore: number;
  evalAfter: number;
  /** Centipawns the mover gave up, never negative. */
  loss: number;
  quality: MoveQuality;
  tone: Annotation['tone'];
  /** The label `annotate.ts` chose. See `ui/review.ts` for why it is not set. */
  label: string;
  /** The engine's preferred continuation from before this move. */
  bestLine: Move[];
  bestNotation: string[];
  /** Set when the evaluation after this move is a forced mate, Red-positive. */
  mateIn: number | null;
  /**
   * False until the sweep has both evaluations this ply needs. An unjudged ply
   * carries no mark at all — `ok` would be a claim the engine has not made yet.
   */
  judged: boolean;
}

export interface AssistOptions {
  match: Match;
  engine: EngineClient;
  /** For the hint's marks and for restoring the last-move marks after a seek. */
  board: BoardScene;
  /** Aborted before anything unwinds the board. */
  choreography: Choreographer;
  /** Optional: without it, review still runs and simply has nothing to show. */
  panel?: ReviewPanel;
  /**
   * Called after any reconciliation this module forces on `Match` — a takeback
   * or a review seek. `Match.sync()` retires and rebuilds figures, so whatever
   * `main.ts` does to a fresh figure (line work, an animator) has to happen
   * again here or the new figures arrive undressed and unanimated. This is the
   * same callback `__XQ.setPosition` already runs inline.
   */
  onSync?: () => void;
  /** Position the move list is applied on top of. Defaults to the standard one. */
  startFen?: string;
  /** Per-position analysis budget for a review sweep. */
  reviewMs?: number;
}

/** How far a review sweep has got, for a caller that wants to show progress. */
export interface ReviewProgress {
  done: number;
  total: number;
}

// ===========================================================================
// Assist
// ===========================================================================

export class Assist {
  private readonly opts: AssistOptions;
  private readonly match: Match;
  private readonly startFen: string;

  /**
   * Bumped by everything that invalidates work in flight. A move flow captures
   * it and re-checks it after every await; see the module header.
   */
  private generation = 0;

  // --- hint -----------------------------------------------------------------
  private hintMove: Move = 0;
  private hintTimer = 0;
  private hinting = false;

  // --- review ---------------------------------------------------------------
  private reviewing = false;
  private analysing = false;
  private plies: AnalysedPly[] = [];
  private rows: ReviewRow[] = [];
  private cursorPly = 0;
  /** Where `match.pos` was when review started, so exit can put it back. */
  private restorePly = 0;
  /** Whether a seek has reconciled the view at least once this session. */
  private syncedOnce = false;
  private progress: ReviewProgress = { done: 0, total: 0 };

  private readonly unsubs: (() => void)[] = [];

  constructor(opts: AssistOptions) {
    this.opts = opts;
    this.match = opts.match;
    this.startFen = opts.startFen ?? START_FEN;

    this.unsubs.push(
      // Selecting a piece repaints the legal-mark layer with that piece's own
      // targets, so the hint is over — but the marks are no longer ours to lift.
      bus.on('select', () => this.retireHint(false)),
      // A move answers the hint whether or not it was the move suggested.
      bus.on('move:begin', () => this.retireHint(true)),
    );
  }

  // -------------------------------------------------------------------------
  // The interruption token
  // -------------------------------------------------------------------------

  /**
   * Take a token at the top of a move flow. Re-check it with `flowValid` after
   * every `await`; a false answer means a takeback, a review or a reset has
   * happened underneath and the rest of the flow must not run.
   */
  beginFlow(): number {
    return this.generation;
  }

  flowValid(token: number): boolean {
    return token === this.generation;
  }

  /** Invalidate every flow in flight and stop the engine. */
  private interrupt(): void {
    this.generation++;
    this.opts.engine.stop();
    this.opts.choreography.abort();
    this.clearHint();
  }

  /** True while the player should not be able to move a piece. */
  get busy(): boolean {
    return this.reviewing || this.hinting;
  }

  get inReview(): boolean {
    return this.reviewing;
  }

  get reviewProgress(): ReviewProgress {
    return this.progress;
  }

  /** True while the backward sweep is still asking the engine for positions. */
  get sweeping(): boolean {
    return this.analysing;
  }

  get analysed(): readonly AnalysedPly[] {
    return this.plies;
  }

  // =========================================================================
  // Hint
  // =========================================================================

  /**
   * The engine's preferred move from the position on the board, shown as a
   * pressed gold mark on both of its squares.
   *
   * The marks are the board's own legal-move vocabulary rather than a new one:
   * a hint IS a legal move, the player is about to be looking for it among the
   * marks anyway, and inventing a second kind of board mark for it would put
   * two grammars on one surface.
   */
  async hint(): Promise<Move | null> {
    if (this.reviewing || this.hinting) return null;
    if (!this.match.humanToMove) return null;

    const token = this.beginFlow();
    this.hinting = true;
    try {
      // The analysis position is a bare FEN — no repetition history — which is
      // right for a hint: the answer must not depend on how we arrived.
      const r: SearchResult = await this.opts.engine.analyse(this.match.pos.toFen(), HINT_MS);
      if (!this.flowValid(token) || !this.match.humanToMove) return null;
      const move = r.move || 0;
      if (!move) return null;

      this.hintMove = move;
      this.hintTimer = HINT_LINGER;
      this.opts.board.showLegalMarks([moveFrom(move), moveTo(move)]);
      this.opts.board.setHover(moveTo(move));
      this.opts.panel?.announce('提示');
      bus.emit('hint', { move });
      return move;
    } catch (err) {
      console.warn('[assist] hint failed', err);
      return null;
    } finally {
      this.hinting = false;
    }
  }

  /** Lift the hint's marks. Called by the linger timer and by any interruption. */
  clearHint(): void {
    this.retireHint(true);
  }

  /**
   * Forget the hint.
   *
   * `clearBoard` is false when something else has already taken the legal-mark
   * surface over — selecting a piece calls `showLegalMarks` with its own
   * targets, and clearing them afterwards would wipe the marks the player is
   * currently reading. The board has one mark layer and the last writer owns it.
   */
  private retireHint(clearBoard: boolean): void {
    if (!this.hintMove) return;
    this.hintMove = 0;
    this.hintTimer = 0;
    if (clearBoard) {
      this.opts.board.clearLegalMarks();
      this.opts.board.setHover(null);
    }
    bus.emit('hint', { move: null });
  }

  /** The move currently being suggested, or 0. */
  get suggested(): Move {
    return this.hintMove;
  }

  // =========================================================================
  // Takeback
  // =========================================================================

  /**
   * Unwind the engine's reply and the human's move, and put the board back.
   *
   * Everything in flight is thrown away first: the search is stopped and the
   * choreography is CANCELLED, not completed, so a capture that was halfway
   * through never fires its remaining beats. `Match.takeback` then unwinds up
   * to two plies — one if it was the human's move that hung, two for a full
   * exchange — and reconciles the figures.
   *
   * Returns false when there was nothing to unwind.
   */
  takeback(): boolean {
    if (this.reviewing) return false;
    if (!this.match.moves.length) return false;

    this.interrupt();
    // `Match.takeback` refuses while the flags are up, and after an abort they
    // are stale rather than true: the sequence is gone and the search has been
    // told to stop. Clearing them here is the statement that this module has
    // taken responsibility for both.
    this.match.animating = false;
    this.match.thinking = false;

    if (!this.match.takeback()) return false;

    // `sync()` rebuilds every figure it could not relocate, so whatever main.ts
    // dresses a figure with has to be reapplied.
    this.opts.onSync?.();

    // The board's last-move marks still point at the move that was just undone.
    const last = this.match.moves.length
      ? this.match.moves[this.match.moves.length - 1]
      : 0;
    if (last) this.opts.board.setLastMove(moveFrom(last), moveTo(last));
    else this.opts.board.setLastMove(-1, -1);

    this.opts.panel?.announce('悔棋');
    return true;
  }

  // =========================================================================
  // Review
  // =========================================================================

  /**
   * Enter review and sweep the game BACKWARD, judging every ply.
   *
   * Backward for two reasons. It is what the brief asks for, and it is what a
   * post-mortem actually is: the interesting position is the one the game ended
   * in, and the question is which move before it lost the thread. Sweeping
   * backward means the rows nearest the end — the ones the player is looking at
   * — are marked first, and the opening fills in behind them while they read.
   *
   * The sweep costs `moves.length + 1` analyses, not twice that: the evaluation
   * after ply *i* is the evaluation before ply *i+1* seen from the other side,
   * so each position is analysed exactly once and shared by the two plies that
   * touch it.
   */
  async enterReview(): Promise<boolean> {
    if (this.reviewing) return true;
    if (this.match.animating || this.match.thinking) return false;
    if (!this.match.moves.length) return false;

    this.interrupt();
    const token = this.beginFlow();

    this.reviewing = true;
    this.syncedOnce = false;
    this.restorePly = this.match.moves.length;
    this.plies.length = 0;
    this.rows.length = 0;
    this.cursorPly = this.match.moves.length;
    this.progress = { done: 0, total: this.match.moves.length + 1 };

    bus.emit('review:enter', {});
    this.opts.panel?.setVisible(true);
    this.opts.panel?.announce('覆盤', 2.2);

    // Lay the record out unjudged straight away, so the sheet is populated the
    // instant review opens rather than filling in from nothing.
    this.seedRows();
    this.pushRows();
    this.seek(this.cursorPly);

    void this.sweep(token);
    return true;
  }

  exitReview(): void {
    if (!this.reviewing) return;
    // The sweep is killed first, so nothing lands on a record that is closing.
    this.analysing = false;
    this.generation++;
    this.opts.engine.stop();

    // Put the model back where review found it, while still in the mode: the
    // seek is part of leaving, and a listener on `review:seek` should see the
    // last one arrive before `review:exit`, not after.
    this.seek(this.restorePly);

    this.reviewing = false;
    this.opts.panel?.setVisible(false);
    bus.emit('review:exit', {});
  }

  /** Step one ply back through the game. Returns the new cursor. */
  stepBack(): number {
    return this.seek(this.cursorPly - 1);
  }

  stepForward(): number {
    return this.seek(this.cursorPly + 1);
  }

  get cursor(): number {
    return this.cursorPly;
  }

  /**
   * Put the board at the position AFTER `ply` plies and move the cursor there.
   *
   * The move list is deliberately not touched: `match.moves` is the record
   * being reviewed and must survive the whole mode. Only `match.pos` walks, and
   * it walks through its own history so the repetition state stays coherent.
   */
  seek(ply: number): number {
    const target = clamp(Math.round(ply), 0, this.match.moves.length);
    const pos = this.match.pos;

    // Unwind first, then rewind. `unmakeMove` pops the position's own history,
    // which is what makes this safe to run in either direction.
    let guard = this.match.moves.length + 2;
    while (this.playedPlies() > target && guard-- > 0) pos.unmakeMove();
    while (this.playedPlies() < target && guard-- > 0) {
      const m = this.match.moves[this.playedPlies()];
      if (!m || !pos.makeMove(m)) {
        // An illegal replay can only mean the move list and the position have
        // diverged, which is a bug elsewhere; unwind the half-made move and
        // stop rather than corrupting the board.
        pos.unmakeMove();
        break;
      }
    }

    const moved = this.playedPlies() !== this.cursorPly;
    this.cursorPly = this.playedPlies();
    // Only reconcile when the board really changed. `onSync` re-dresses every
    // figure main.ts owns, and re-collapsing thirty-two units to answer a seek
    // that did not move anything is the most expensive no-op in the module.
    if (moved || !this.syncedOnce) {
      this.syncedOnce = true;
      this.match.sync();
      this.opts.onSync?.();
    }

    if (this.cursorPly > 0) {
      const m = this.match.moves[this.cursorPly - 1];
      this.opts.board.setLastMove(moveFrom(m), moveTo(m));
    } else {
      this.opts.board.setLastMove(-1, -1);
    }
    this.opts.board.setCheck(pos.checkNow ? this.match.generalSquare(pos.side) : null);

    this.opts.panel?.setCursor(this.cursorPly);
    bus.emit('review:seek', { ply: this.cursorPly });

    // Feed the HUD's own eval silk too, so a caller that keeps the HUD up
    // during review gets the same reading on both surfaces.
    const row = this.plies[this.cursorPly - 1];
    if (row) bus.emit('eval', { cp: row.evalAfter, mateIn: row.mateIn });

    return this.cursorPly;
  }

  /** How many of `match.moves` are currently applied to `match.pos`. */
  private playedPlies(): number {
    // `Position.ply` counts from the FEN the match started at, and the match
    // always starts from the same FEN it replays its move list on top of.
    return this.match.pos.ply;
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /** Fill the record with unjudged rows so the sheet is never empty. */
  private seedRows(): void {
    const pos = new Position(this.startFen);
    for (let i = 0; i < this.match.moves.length; i++) {
      const m = this.match.moves[i];
      const side = pos.side;
      const notation = this.match.notation[i] ?? moveToNotation(pos, m);
      this.plies.push({
        ply: i + 1,
        move: m,
        side,
        notation,
        evalBefore: 0,
        evalAfter: 0,
        loss: 0,
        quality: 'ok',
        tone: 'ink',
        label: '',
        bestLine: [],
        bestNotation: [],
        mateIn: null,
        judged: false,
      });
      if (!pos.makeMove(m)) {
        pos.unmakeMove();
        break;
      }
    }
  }

  /**
   * Analyse every position in the game, from the end backward, and judge the
   * ply that led into each one as soon as both of its evaluations are known.
   */
  private async sweep(token: number): Promise<void> {
    this.analysing = true;
    const n = this.match.moves.length;
    const budget = this.opts.reviewMs ?? REVIEW_MS;

    // Positions, indexed by how many plies have been played into them. `fen[i]`
    // is the position BEFORE ply i+1. Built once by replaying the list.
    const fens: string[] = [];
    const sides: Side[] = [];
    const counts: number[] = [];
    {
      const pos = new Position(this.startFen);
      for (let i = 0; i <= n; i++) {
        fens.push(pos.toFen());
        sides.push(pos.side);
        counts.push(legalMoveCount(pos));
        if (i === n) break;
        if (!pos.makeMove(this.match.moves[i])) {
          pos.unmakeMove();
          break;
        }
      }
    }

    /** Analysis of position `i`, once it has come back. */
    const seen: (SearchResult | null)[] = new Array(fens.length).fill(null);

    for (let i = fens.length - 1; i >= 0; i--) {
      let r: SearchResult;
      try {
        r = await this.opts.engine.analyse(fens[i], budget);
      } catch (err) {
        console.warn('[assist] review analysis failed at ply', i, err);
        break;
      }
      if (!this.flowValid(token) || !this.reviewing) {
        this.analysing = false;
        return;
      }
      seen[i] = r;
      this.progress = { done: fens.length - i, total: fens.length };

      // Judging ply `i` (0-based) needs the evaluation of position i and of
      // position i+1. Sweeping backward means i+1 has always already landed,
      // except on the very first iteration where there is no ply to judge.
      if (i < n && seen[i + 1]) this.judge(i, fens, sides, counts, seen);
      this.pushRows();
    }

    this.analysing = false;
  }

  /**
   * Fold one ply's two evaluations into an annotation.
   *
   * `SearchResult.score` is from the SIDE TO MOVE's point of view, so the score
   * at position i is already the mover's view of "before" and the score at
   * position i+1 — where the opponent is to move — has to be negated to become
   * the mover's view of "after". Getting that sign wrong turns every good move
   * into a blunder, which is at least loud.
   */
  private judge(
    i: number,
    fens: string[],
    sides: Side[],
    counts: number[],
    seen: (SearchResult | null)[],
  ): void {
    const entry = this.plies[i];
    if (!entry) return;
    const a = seen[i]!;
    const b = seen[i + 1]!;

    const before = a.score;
    const after = -b.score;
    const played = this.match.moves[i];
    const wasBest =
      !!a.move && moveFrom(a.move) === moveFrom(played) && moveTo(a.move) === moveTo(played);

    const ann = annotate({ before, after, wasBest, legalCount: counts[i] });

    const mover = sides[i];
    const sign = mover === Side.Red ? 1 : -1;
    entry.evalBefore = before * sign;
    entry.evalAfter = after * sign;
    entry.loss = ann.loss;
    entry.quality = ann.quality;
    entry.tone = ann.tone;
    entry.label = ann.label;
    entry.bestLine = a.pv.slice();
    entry.bestNotation = formatLine(fens[i], a.pv);
    // `mateIn` is positive when the SIDE TO MOVE is mating, and the side to
    // move at position i+1 is the mover's opponent. One flip, into Red's view.
    entry.mateIn = b.mateIn === null ? null : sides[i + 1] === Side.Red ? b.mateIn : -b.mateIn;
    entry.judged = true;
  }

  /** Project the analysed plies onto the panel's row shape. */
  private pushRows(): void {
    const panel = this.opts.panel;
    if (!panel) return;
    this.rows.length = 0;
    for (const p of this.plies) {
      this.rows.push({
        ply: p.ply,
        side: p.side,
        notation: p.notation,
        quality: p.judged ? p.quality : null,
        tone: p.tone,
        bestNotation: p.bestNotation,
        cp: p.evalAfter,
        mateIn: p.mateIn,
      });
    }
    panel.setRows(this.rows);
    panel.setCursor(this.cursorPly);
  }

  // =========================================================================
  // Frame
  // =========================================================================

  /** Drives the hint's linger. Takes dt; never reads a clock. */
  update(dt: number): void {
    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.clearHint();
    }
  }

  dispose(): void {
    this.generation++;
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.clearHint();
    this.plies.length = 0;
    this.rows.length = 0;
  }
}

/**
 * Format a principal variation from a FEN.
 *
 * `lineToNotation` applies each move as it goes and restores the position, so
 * the disambiguation (前/後, and the file a diagonal mover lands on) is read
 * from the board each move actually left behind rather than from the root.
 */
function formatLine(fen: string, pv: readonly Move[]): string[] {
  if (!pv.length) return [];
  try {
    return lineToNotation(new Position(fen), pv);
  } catch (err) {
    console.warn('[assist] could not format a variation', err);
    return [];
  }
}

export function createAssist(opts: AssistOptions): Assist {
  return new Assist(opts);
}
