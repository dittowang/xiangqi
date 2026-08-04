/**
 * The match: the authoritative model, the pieces on the board, and the bridge
 * between them.
 *
 * One `Position` on the main thread is the single source of truth for the rules.
 * The engine client holds its own copy inside the worker and is re-synchronised
 * from the full move list, never from a diff — that is what keeps repetition
 * history (and therefore perpetual-check adjudication) correct.
 *
 * The view is reconciled against the model rather than mutated in step with it.
 * A takeback, a harness `setPosition`, and an ordinary move all run the same
 * `sync()`, so there is exactly one code path that can put a figure on a square
 * and exactly one that can take it off.
 */

import type * as THREE from 'three';
import {
  Position,
  adjudicate,
  findLegalMove,
  hasLegalMove,
  legalMoves as allLegalMoves,
  legalTargets,
  moveToNotation,
  evaluateRedPov,
} from '@engine/index.ts';
import type { CharacterFactory, EngineClient, UnitInstance } from '@core/contracts.ts';
import type { Board } from '@scene/index.ts';
import { bus, type CaptureContext } from '@core/bus.ts';
import {
  type Difficulty,
  type GameResult,
  type Move,
  ONGOING,
  type PieceCode,
  type PieceType,
  Side,
  isCapture,
  moveFrom,
  moveTo,
  opposite,
  pieceSide,
  pieceType,
} from '@core/types.ts';
import { facingY, fileOf, rankOf, worldX, worldZ } from '@core/coords.ts';
import { START_FEN } from '@core/testapi.ts';

/** One figure on the board, tying a model square to a built unit and its base. */
export interface PieceView {
  /** Base-manager handle. Numeric because @scene keys its instanced bases by int. */
  id: number;
  side: Side;
  type: PieceType;
  square: number;
  unit: UnitInstance;
}

export interface MatchOptions {
  characters: CharacterFactory;
  board: Board;
  engine: EngineClient;
  /** Where built figures are parented. */
  stage: THREE.Group;
  difficulty?: Difficulty;
  humanSide?: Side;
}

let nextPieceId = 0;

export class Match {
  readonly pos = new Position(START_FEN);
  readonly moves: Move[] = [];
  /** Notation for each ply, parallel to `moves`. */
  readonly notation: string[] = [];
  /** Every figure currently on the board, keyed by square. */
  readonly views = new Map<number, PieceView>();
  /** Figures taken off the board, in capture order — the HUD's fallen ranks. */
  readonly captured: PieceView[] = [];

  difficulty: Difficulty;
  humanSide: Side;
  result: GameResult = ONGOING;
  /** True while the engine is searching, so input is ignored. */
  thinking = false;
  /** True while a move's choreography is playing. */
  animating = false;

  private readonly opts: MatchOptions;
  /** Soldiers get a variant index so a rank of five is not five copies. */
  private variantCounter = new Map<string, number>();

  constructor(opts: MatchOptions) {
    this.opts = opts;
    this.difficulty = opts.difficulty ?? 'medium';
    this.humanSide = opts.humanSide ?? Side.Red;
  }

  // -------------------------------------------------------------------------
  // Model queries — all synchronous, no worker round trip. This is the whole
  // reason the engine is isomorphic: hovering a piece must light its squares
  // on the same frame as the pointer moved.
  // -------------------------------------------------------------------------

  get sideToMove(): Side {
    return this.pos.side;
  }
  get inCheck(): boolean {
    return this.pos.checkNow;
  }
  get ply(): number {
    return this.moves.length;
  }
  get over(): boolean {
    return this.result.kind !== 'ongoing';
  }

  /** Legal destinations from a square, for the selection marks. */
  targetsFrom(square: number): number[] {
    const code = this.pos.board[square];
    if (!code || pieceSide(code) !== this.pos.side) return [];
    return legalTargets(this.pos, square);
  }

  legalMoves(): Move[] {
    return allLegalMoves(this.pos);
  }

  /** Whether the human may act right now. */
  get humanToMove(): boolean {
    return !this.over && !this.thinking && !this.animating && this.pos.side === this.humanSide;
  }

  evalRedPov(): number {
    return evaluateRedPov(this.pos);
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /** Build every figure for the current position. Call once, after prewarm. */
  async begin(resumeMoves?: Move[]): Promise<void> {
    await this.opts.engine.ready();
    await this.opts.engine.newGame();

    if (resumeMoves?.length) {
      // Replay through the real rule code. A save written by an older move
      // encoding fails here, which is exactly the signal we want — better a
      // fresh game than a resurrected corrupt position.
      for (const m of resumeMoves) {
        const legal = findLegalMove(this.pos, moveFrom(m), moveTo(m));
        if (!legal) break;
        this.notation.push(moveToNotation(this.pos, legal));
        this.pos.makeMove(legal);
        this.moves.push(legal);
      }
    }

    this.sync();
    this.result = adjudicate(this.pos);
    bus.emit('eval', { cp: this.evalRedPov(), mateIn: null });
  }

  /**
   * Reconcile the view against the model. The only path that adds or removes.
   *
   * `moved` relocates an existing figure rather than destroying and rebuilding
   * it. Without it every move would cost a 20-70ms unit build and would throw
   * away the animator's state mid-stride — a hitch on exactly the frame the
   * player is watching.
   */
  sync(moved?: { from: number; to: number }): void {
    const board = this.pos.board;
    const seen = new Set<number>();

    if (moved) {
      const mover = this.views.get(moved.from);
      if (mover) {
        // The destination's occupant, if any, has already been taken.
        const taken = this.views.get(moved.to);
        if (taken && taken !== mover) {
          this.captured.push(taken);
          this.opts.board.bases.remove(taken.id);
          taken.unit.root.removeFromParent();
          this.views.delete(moved.to);
        }
        this.views.delete(moved.from);
        mover.square = moved.to;
        this.views.set(moved.to, mover);
        this.opts.board.bases.setSquare(mover.id, moved.to);
      }
    }

    // Retire figures whose square no longer holds the piece they represent.
    for (const [square, view] of [...this.views]) {
      const code = board[square];
      if (!code || pieceSide(code) !== view.side || pieceType(code) !== view.type) {
        this.retire(view);
        this.views.delete(square);
      } else {
        seen.add(square);
      }
    }

    // Build figures for squares that gained a piece.
    for (let s = 0; s < 90; s++) {
      const code = board[s];
      if (!code || seen.has(s)) continue;
      if (this.views.has(s)) continue;
      this.views.set(s, this.spawn(s, code));
    }

    this.placeAll();
  }

  private spawn(square: number, code: PieceCode): PieceView {
    const side = pieceSide(code);
    const type = pieceType(code);
    const key = `${side}:${type}`;
    const variant = this.variantCounter.get(key) ?? 0;
    this.variantCounter.set(key, variant + 1);

    const unit = this.opts.characters.create(side, type, variant);
    const id = nextPieceId++;
    this.opts.stage.add(unit.root);
    this.opts.board.bases.add(id, side, type);
    this.opts.board.bases.setSquare(id, square);
    return { id, side, type, square, unit };
  }

  private retire(view: PieceView): void {
    this.opts.board.bases.remove(view.id);
    view.unit.root.removeFromParent();
    view.unit.dispose();
  }

  /** Stand every figure on its square, on top of its base. */
  placeAll(): void {
    for (const [square, view] of this.views) {
      view.square = square;
      const x = worldX(fileOf(square));
      const z = worldZ(rankOf(square));
      const top = this.opts.board.bases.topOf(view.id);
      view.unit.root.position.set(x, top ?? this.opts.board.heightAt(x, z), z);
      view.unit.root.rotation.y = facingY(view.side);
    }
  }

  // -------------------------------------------------------------------------
  // Making moves
  // -------------------------------------------------------------------------

  /**
   * Apply a move to the model and announce it. Choreography is the caller's
   * job — this returns as soon as the model is consistent, so the animator can
   * play against a board state that already knows the outcome.
   */
  apply(move: Move): { notation: string; capture: CaptureContext | null } | null {
    const from = moveFrom(move);
    const to = moveTo(move);
    const legal = findLegalMove(this.pos, from, to);
    if (!legal) return null;

    const mover = this.pos.board[from];
    const side = pieceSide(mover);
    // Notation must be read BEFORE the move: it inspects the board to
    // disambiguate 前/後 when two like pieces share a file.
    const notation = moveToNotation(this.pos, legal);

    let capture: CaptureContext | null = null;
    if (isCapture(legal)) {
      const defender = this.pos.board[to];
      capture = {
        attackerSq: from,
        defenderSq: to,
        attacker: mover,
        defender,
        // The 砲 resolves its capture from distance; everything else closes.
        ranged: pieceType(mover) === (6 as PieceType),
      };
    }

    this.pos.makeMove(legal);
    this.moves.push(legal);
    this.notation.push(notation);

    bus.emit('move:begin', { move: legal, side, piece: mover, capture, ply: this.ply });
    return { notation, capture };
  }

  /** Called once the choreography has settled. Reconciles and adjudicates. */
  settle(move: Move, side: Side, notation: string): void {
    this.sync({ from: moveFrom(move), to: moveTo(move) });
    this.opts.board.setLastMove(moveFrom(move), moveTo(move));
    bus.emit('move:end', { move, side, ply: this.ply, notation });

    if (this.pos.checkNow) {
      const gen = this.generalSquare(this.pos.side);
      bus.emit('check', {
        side: this.pos.side,
        generalSq: gen,
        escapable: hasLegalMove(this.pos),
      });
      this.opts.board.setCheck(gen);
    } else {
      this.opts.board.setCheck(null);
      bus.emit('check:clear', {});
    }

    bus.emit('eval', { cp: this.evalRedPov(), mateIn: null });

    this.result = adjudicate(this.pos);
    if (this.result.kind !== 'ongoing') bus.emit('match:end', { result: this.result });
  }

  /** Where a side's general currently stands. */
  generalSquare(side: Side): number {
    for (const [square, v] of this.views) {
      if (v.side === side && v.type === (1 as PieceType)) return square;
    }
    // Fall back to the model if the view has not been synced yet.
    for (let s = 0; s < 90; s++) {
      const c = this.pos.board[s];
      if (c && pieceSide(c) === side && pieceType(c) === (1 as PieceType)) return s;
    }
    return -1;
  }

  /** Undo one full exchange — the human's move and the engine's reply. */
  takeback(): boolean {
    if (this.animating || this.thinking) return false;
    let undone = 0;
    // Undo until it is the human's turn again, at most one full exchange.
    while (this.moves.length > 0 && undone < 2) {
      // unmakeMove pops the engine's own history; we only mirror the list here.
      this.pos.unmakeMove();
      this.moves.pop();
      this.notation.pop();
      undone++;
      if (this.pos.side === this.humanSide) break;
    }
    if (undone === 0) return false;

    this.result = ONGOING;
    this.sync();
    this.opts.board.setCheck(this.pos.checkNow ? this.generalSquare(this.pos.side) : null);
    bus.emit('move:takeback', { ply: this.ply });
    bus.emit('eval', { cp: this.evalRedPov(), mateIn: null });
    return true;
  }

  // -------------------------------------------------------------------------
  // Engine
  // -------------------------------------------------------------------------

  /** Push the authoritative position and ask for a move. */
  async think(): Promise<Move | null> {
    if (this.over) return null;
    this.thinking = true;
    bus.emit('engine:thinking', { on: true });
    try {
      await this.opts.engine.setPosition(START_FEN, this.moves);
      const r = await this.opts.engine.search(this.difficulty);
      bus.emit('eval', {
        cp: this.pos.side === Side.Red ? r.score : -r.score,
        mateIn: r.mateIn,
      });
      return r.move || null;
    } finally {
      this.thinking = false;
      bus.emit('engine:thinking', { on: false });
    }
  }

  /** A hint for the human: the engine's preferred move from here. */
  async hint(): Promise<Move | null> {
    if (!this.humanToMove) return null;
    await this.opts.engine.setPosition(START_FEN, this.moves);
    const r = await this.opts.engine.analyse(this.pos.toFen(), 800);
    return r.move || null;
  }

  /** Material remaining, 0..1, driving the underscore's density. */
  materialLeft(): number {
    let n = 0;
    for (const _ of this.views) n++;
    return n / 32;
  }

  dispose(): void {
    for (const v of this.views.values()) this.retire(v);
    this.views.clear();
    for (const v of this.captured) v.unit.dispose();
    this.captured.length = 0;
  }
}

export { opposite };
