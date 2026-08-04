/**
 * The board: make/unmake, incremental Zobrist, attack detection, history.
 *
 * `Position` is deliberately mutable and allocation-free after construction.
 * The search makes and unmakes millions of moves against one instance; the UI
 * holds a second instance and asks it for legal move lists on hover. Both use
 * exactly the same code, which is the whole point of the engine being
 * isomorphic — a highlight the player sees can never disagree with what the
 * worker searched.
 *
 * Flying general (對面笑) is not a special case anywhere in this file. It falls
 * out of `isAttacked`: a general is modelled as attacking down its own file
 * until the first obstruction, so "the generals may not face each other" is the
 * same test as "my general may not end the move attacked". That means it is
 * enforced for *every* move — including a quiet move by an unrelated piece that
 * happens to open the file — with no extra branch in the move loop.
 */

import { fileOf, rankOf } from '@core/coords.ts';
import {
  EMPTY,
  type Move,
  NO_MOVE,
  type PieceCode,
  PieceType,
  Side,
  moveFrom,
  moveTo,
  opposite,
} from '@core/types.ts';
import { type ParsedFen, formatFen, parseFen } from './fen.ts';
import {
  ADVISOR_STRIDE,
  ADVISOR_TO,
  ELEPHANT_EYE,
  ELEPHANT_STRIDE,
  ELEPHANT_TO,
  HORSE_ATK_FROM,
  HORSE_ATK_LEG,
  HORSE_ATK_N,
  HORSE_STRIDE,
  N_SQ,
  RAY_LEN,
  RAY_STRIDE,
  RAY_SQ,
  advisorCount,
  elephantCount,
} from './tables.ts';
import { Z_PIECE_HI, Z_PIECE_LO, Z_SIDE_HI, Z_SIDE_LO } from './zobrist.ts';

/** Deepest make/unmake stack the engine will ever build. */
export const MAX_HISTORY = 1024;

/** Piece-list stride. No promotions in xiangqi, so five soldiers is the ceiling. */
const LIST_STRIDE = 8;

/** Verdicts from `repetitionVerdict()`. */
export const REP_NONE = 0;
export const REP_DRAW = 1;
/** The side to move wins: the opponent has been checking forever. */
export const REP_WIN = 2;
/** The side to move loses: it has been the perpetual checker. */
export const REP_LOSS = 3;

export class Position {
  /** Piece code per square, `rank * 9 + file`. */
  readonly board = new Int8Array(N_SQ);

  side: Side = Side.Red;
  /** Plies since the last capture. 120 of them is the sixty-move draw. */
  halfmove = 0;
  fullmove = 1;
  /** Plies made on this object since it was set from a FEN. */
  ply = 0;

  keyLo = 0;
  keyHi = 0;

  /** Cached: is the side to move currently in check? Maintained by make/unmake. */
  checkNow = false;

  /** `generalSq[side]` — kept current so check tests never scan for the general. */
  readonly generalSq = new Int8Array(2);

  // --- piece lists -------------------------------------------------------
  /** `pieceSquares[code * LIST_STRIDE + i]` for `i < pieceCount[code]`. */
  readonly pieceSquares = new Int8Array(16 * LIST_STRIDE);
  readonly pieceCount = new Int8Array(16);
  /** Where the piece standing on a square sits inside its own code's list. */
  private readonly listIndex = new Int8Array(N_SQ);

  // --- history -----------------------------------------------------------
  private readonly hMove = new Int32Array(MAX_HISTORY);
  private readonly hCaptured = new Int8Array(MAX_HISTORY);
  private readonly hHalfmove = new Int16Array(MAX_HISTORY);
  private readonly hKeyLo = new Int32Array(MAX_HISTORY);
  private readonly hKeyHi = new Int32Array(MAX_HISTORY);
  private readonly hCheckBefore = new Uint8Array(MAX_HISTORY);
  /** Did the move made at this ply leave the *opponent* in check? */
  private readonly hCheckAfter = new Uint8Array(MAX_HISTORY);

  /** `keyStack[p]` is the key of the position standing at ply `p`. */
  private readonly keyStackLo = new Int32Array(MAX_HISTORY + 1);
  private readonly keyStackHi = new Int32Array(MAX_HISTORY + 1);

  constructor(fen?: string) {
    if (fen) this.setFen(fen);
  }

  // =======================================================================
  // Setup
  // =======================================================================

  setFen(fen: string): void {
    this.setParsed(parseFen(fen));
  }

  setParsed(p: ParsedFen): void {
    this.board.fill(EMPTY);
    this.pieceCount.fill(0);
    this.listIndex.fill(0);
    this.generalSq[0] = -1;
    this.generalSq[1] = -1;
    this.keyLo = 0;
    this.keyHi = 0;
    this.ply = 0;
    this.halfmove = p.halfmove;
    this.fullmove = p.fullmove;
    this.side = p.side;

    for (let s = 0; s < N_SQ; s++) {
      const code = p.cells[s];
      if (code === EMPTY) continue;
      this.addPiece(s, code);
    }
    if (this.side === Side.Black) {
      this.keyLo ^= Z_SIDE_LO;
      this.keyHi ^= Z_SIDE_HI;
    }
    this.keyStackLo[0] = this.keyLo;
    this.keyStackHi[0] = this.keyHi;
    this.checkNow = this.generalSq[this.side] >= 0 && this.isAttacked(this.generalSq[this.side], opposite(this.side));
  }

  toFen(): string {
    return formatFen(this);
  }

  clone(): Position {
    const p = new Position();
    p.copyFrom(this);
    return p;
  }

  /** Copies the board state but *not* the move history — searches start clean. */
  copyFrom(other: Position): void {
    this.board.set(other.board);
    this.pieceSquares.set(other.pieceSquares);
    this.pieceCount.set(other.pieceCount);
    this.listIndex.set(other.listIndex);
    this.generalSq.set(other.generalSq);
    this.side = other.side;
    this.halfmove = other.halfmove;
    this.fullmove = other.fullmove;
    this.keyLo = other.keyLo;
    this.keyHi = other.keyHi;
    this.checkNow = other.checkNow;
    this.ply = 0;
    this.keyStackLo[0] = this.keyLo;
    this.keyStackHi[0] = this.keyHi;
  }

  // =======================================================================
  // Piece bookkeeping
  // =======================================================================

  private addPiece(s: number, code: PieceCode): void {
    this.board[s] = code;
    const n = this.pieceCount[code];
    this.pieceSquares[code * LIST_STRIDE + n] = s;
    this.listIndex[s] = n;
    this.pieceCount[code] = n + 1;
    const zi = code * N_SQ + s;
    this.keyLo ^= Z_PIECE_LO[zi];
    this.keyHi ^= Z_PIECE_HI[zi];
    if ((code & 7) === PieceType.General) this.generalSq[code >> 3] = s;
  }

  private removePiece(s: number, code: PieceCode): void {
    const i = this.listIndex[s];
    const last = this.pieceCount[code] - 1;
    const lastSq = this.pieceSquares[code * LIST_STRIDE + last];
    this.pieceSquares[code * LIST_STRIDE + i] = lastSq;
    this.listIndex[lastSq] = i;
    this.pieceCount[code] = last;
    this.board[s] = EMPTY;
    const zi = code * N_SQ + s;
    this.keyLo ^= Z_PIECE_LO[zi];
    this.keyHi ^= Z_PIECE_HI[zi];
  }

  private shiftPiece(from: number, to: number, code: PieceCode): void {
    const i = this.listIndex[from];
    this.pieceSquares[code * LIST_STRIDE + i] = to;
    this.listIndex[to] = i;
    this.board[from] = EMPTY;
    this.board[to] = code;
    const zf = code * N_SQ + from;
    const zt = code * N_SQ + to;
    this.keyLo ^= Z_PIECE_LO[zf] ^ Z_PIECE_LO[zt];
    this.keyHi ^= Z_PIECE_HI[zf] ^ Z_PIECE_HI[zt];
  }

  /** Squares occupied by `code`, valid for `i < pieceCount[code]`. */
  squareOf(code: PieceCode, i: number): number {
    return this.pieceSquares[code * LIST_STRIDE + i];
  }

  countOf(code: PieceCode): number {
    return this.pieceCount[code];
  }

  // =======================================================================
  // Make / unmake
  // =======================================================================

  /**
   * Applies a pseudo-legal move. Returns `false` when the move leaves the
   * mover's general attacked — including by the enemy general down an open file
   * — in which case the caller **must** still call `unmakeMove()`.
   */
  makeMove(m: Move): boolean {
    const from = moveFrom(m);
    const to = moveTo(m);
    const piece = this.board[from];
    const captured = this.board[to];
    const mover = this.side;
    const p = this.ply;

    this.hMove[p] = m;
    this.hCaptured[p] = captured;
    this.hHalfmove[p] = this.halfmove;
    this.hKeyLo[p] = this.keyLo;
    this.hKeyHi[p] = this.keyHi;
    this.hCheckBefore[p] = this.checkNow ? 1 : 0;

    if (captured !== EMPTY) this.removePiece(to, captured);
    this.shiftPiece(from, to, piece);
    if ((piece & 7) === PieceType.General) this.generalSq[mover] = to;

    this.keyLo ^= Z_SIDE_LO;
    this.keyHi ^= Z_SIDE_HI;
    this.halfmove = captured !== EMPTY ? 0 : this.halfmove + 1;
    if (mover === Side.Black) this.fullmove++;
    this.side = opposite(mover);
    this.ply = p + 1;
    this.keyStackLo[p + 1] = this.keyLo;
    this.keyStackHi[p + 1] = this.keyHi;

    // Legality: the mover's own general must not be attacked by the side that
    // is now to move. This single test covers ordinary check evasion, pins and
    // the flying-general prohibition.
    if (this.isAttacked(this.generalSq[mover], this.side)) {
      this.hCheckAfter[p] = 0;
      return false;
    }
    const gives = this.isAttacked(this.generalSq[this.side], mover);
    this.hCheckAfter[p] = gives ? 1 : 0;
    this.checkNow = gives;
    return true;
  }

  unmakeMove(): void {
    const p = this.ply - 1;
    this.ply = p;
    const mover = opposite(this.side);
    if (mover === Side.Black) this.fullmove--;
    this.side = mover;

    const m = this.hMove[p];
    this.halfmove = this.hHalfmove[p];
    this.checkNow = this.hCheckBefore[p] === 1;

    if (m === NO_MOVE) {
      // Null move: only the side key changed.
      this.keyLo = this.hKeyLo[p];
      this.keyHi = this.hKeyHi[p];
      return;
    }

    const from = moveFrom(m);
    const to = moveTo(m);
    const piece = this.board[to];
    const captured = this.hCaptured[p];

    this.shiftPiece(to, from, piece);
    if (captured !== EMPTY) this.addPiece(to, captured);
    if ((piece & 7) === PieceType.General) this.generalSq[mover] = from;

    this.keyLo = this.hKeyLo[p];
    this.keyHi = this.hKeyHi[p];
  }

  /** Null move for the search's null-move pruning. Never legal in a real game. */
  makeNull(): void {
    const p = this.ply;
    this.hMove[p] = NO_MOVE;
    this.hCaptured[p] = EMPTY;
    this.hHalfmove[p] = this.halfmove;
    this.hKeyLo[p] = this.keyLo;
    this.hKeyHi[p] = this.keyHi;
    this.hCheckBefore[p] = this.checkNow ? 1 : 0;
    this.hCheckAfter[p] = 0;

    this.keyLo ^= Z_SIDE_LO;
    this.keyHi ^= Z_SIDE_HI;
    this.halfmove++;
    if (this.side === Side.Black) this.fullmove++;
    this.side = opposite(this.side);
    this.ply = p + 1;
    this.keyStackLo[p + 1] = this.keyLo;
    this.keyStackHi[p + 1] = this.keyHi;
    // A null move is only ever taken when the mover was not in check, and it
    // cannot give check, so the new side to move is not in check either.
    this.checkNow = false;
  }

  unmakeNull(): void {
    this.unmakeMove();
  }

  /** The move played at `ply`, or NO_MOVE. */
  moveAt(p: number): Move {
    return p >= 0 && p < this.ply ? this.hMove[p] : NO_MOVE;
  }
  /** Did the move played at `ply` give check? */
  checkAt(p: number): boolean {
    return p >= 0 && p < this.ply && this.hCheckAfter[p] === 1;
  }
  capturedAt(p: number): PieceCode {
    return p >= 0 && p < this.ply ? this.hCaptured[p] : EMPTY;
  }
  /** The most recent move, for killer/counter heuristics and the HUD. */
  lastMove(): Move {
    return this.ply > 0 ? this.hMove[this.ply - 1] : NO_MOVE;
  }

  // =======================================================================
  // Attack detection
  // =======================================================================

  /**
   * True when `by` could capture a piece standing on `sq`.
   *
   * One caveat worth stating out loud: the general is treated as attacking
   * every square down its own file up to the first obstruction, not just the
   * adjacent one. That is exactly the 對面笑 rule and it is what makes flying
   * general fall out of ordinary legality testing. It also means "attacked" is
   * a slight over-count for eval purposes on a square that is not a general —
   * the evaluation never relies on general attacks, so nothing downstream cares.
   */
  isAttacked(sq: number, by: Side): boolean {
    const board = this.board;
    const bySide = by as number;
    const rank = (sq / 9) | 0;

    // --- rays: chariot, cannon (needs one screen), general, adjacent soldier
    for (let dir = 0; dir < 4; dir++) {
      const base = (sq * 4 + dir) * RAY_STRIDE;
      const len = RAY_LEN[sq * 4 + dir];
      let i = 0;
      let firstPiece = EMPTY;
      let firstDist = 0;
      for (; i < len; i++) {
        const p = board[RAY_SQ[base + i]];
        if (p !== EMPTY) {
          firstPiece = p;
          firstDist = i + 1;
          i++;
          break;
        }
      }
      if (firstPiece === EMPTY) continue;

      if (firstPiece >> 3 === bySide) {
        const t = firstPiece & 7;
        if (t === PieceType.Chariot) return true;
        // Vertical: the flying general. Horizontal or vertical at range 1: the
        // general's ordinary step.
        if (t === PieceType.General && (dir < 2 || firstDist === 1)) return true;
        if (t === PieceType.Soldier && firstDist === 1) {
          if (by === Side.Red) {
            // A red soldier advances toward rank 0, so it must be *below* `sq`.
            if (dir === 1) return true;
            if (dir >= 2 && rank <= 4) return true; // sideways, river crossed
          } else {
            if (dir === 0) return true;
            if (dir >= 2 && rank >= 5) return true;
          }
        }
      }

      // Cannon: keep walking past the screen for the second occupied square.
      for (; i < len; i++) {
        const p = board[RAY_SQ[base + i]];
        if (p === EMPTY) continue;
        if (p >> 3 === bySide && (p & 7) === PieceType.Cannon) return true;
        break;
      }
    }

    // --- horse, with its leg
    const hn = HORSE_ATK_N[sq];
    for (let i = 0; i < hn; i++) {
      const h = HORSE_ATK_FROM[sq * HORSE_STRIDE + i];
      const p = board[h];
      if (p === EMPTY || p >> 3 !== bySide || (p & 7) !== PieceType.Horse) continue;
      if (board[HORSE_ATK_LEG[sq * HORSE_STRIDE + i]] === EMPTY) return true;
    }

    // --- advisor: only reachable inside the attacker's own palace, so the
    //     table lookup is already zero for every other square.
    const an = advisorCount(by, sq);
    for (let i = 0; i < an; i++) {
      const a = ADVISOR_TO[(bySide * N_SQ + sq) * ADVISOR_STRIDE + i];
      const p = board[a];
      if (p !== EMPTY && p >> 3 === bySide && (p & 7) === PieceType.Advisor) return true;
    }

    // --- elephant: symmetric relation, so the forward table doubles as the
    //     reverse one; the eye is the same square either way.
    const en = elephantCount(by, sq);
    for (let i = 0; i < en; i++) {
      const idx = (bySide * N_SQ + sq) * ELEPHANT_STRIDE + i;
      const e = ELEPHANT_TO[idx];
      const p = board[e];
      if (p === EMPTY || p >> 3 !== bySide || (p & 7) !== PieceType.Elephant) continue;
      if (board[ELEPHANT_EYE[idx]] === EMPTY) return true;
    }

    return false;
  }

  /** Is `side` (default: the side to move) currently in check? */
  inCheck(side?: Side): boolean {
    if (side === undefined || side === this.side) return this.checkNow;
    return this.isAttacked(this.generalSq[side], opposite(side));
  }

  /** True when the two generals see each other — an illegal position. */
  generalsFacing(): boolean {
    const r = this.generalSq[Side.Red];
    const b = this.generalSq[Side.Black];
    if (r < 0 || b < 0) return false;
    if (fileOf(r) !== fileOf(b)) return false;
    const lo = Math.min(r, b);
    const hi = Math.max(r, b);
    for (let s = lo + 9; s < hi; s += 9) {
      if (this.board[s] !== EMPTY) return false;
    }
    return true;
  }

  // =======================================================================
  // Repetition and material
  // =======================================================================

  /** How many times the current position has appeared, counting this one. */
  repetitionCount(): number {
    let count = 1;
    const stop = Math.max(0, this.ply - this.halfmove);
    for (let i = this.ply - 2; i >= stop; i -= 2) {
      // A null move breaks the chain: the positions on either side of it are
      // not reachable from one another by legal play.
      if (this.hMove[i] === NO_MOVE || this.hMove[i + 1] === NO_MOVE) break;
      if (this.keyStackLo[i] === this.keyLo && this.keyStackHi[i] === this.keyHi) count++;
    }
    return count;
  }

  /** Ply of the earliest occurrence of the current key in the current window, or -1. */
  firstRepetitionPly(): number {
    let found = -1;
    const stop = Math.max(0, this.ply - this.halfmove);
    for (let i = this.ply - 2; i >= stop; i -= 2) {
      if (this.hMove[i] === NO_MOVE || this.hMove[i + 1] === NO_MOVE) break;
      if (this.keyStackLo[i] === this.keyLo && this.keyStackHi[i] === this.keyHi) found = i;
    }
    return found;
  }

  /**
   * Check-only repetition verdict, from the side to move's point of view.
   *
   * Perpetual check is a loss for the checker, so a repetition is *not*
   * automatically a draw and the search must not score it as one. This is the
   * cheap classifier the search uses at every node; `rules.ts` runs the fuller
   * one (which also weighs perpetual chase) when adjudicating a real game.
   *
   * `minOccurrences` is 2 inside the search — treating the first repetition as
   * terminal is standard and costs nothing in practice — and 3 for adjudication.
   */
  repetitionVerdict(minOccurrences = 2): number {
    if (this.repetitionCount() < minOccurrences) return REP_NONE;
    const start = this.firstRepetitionPly();
    if (start < 0) return REP_DRAW;

    let redMoves = 0;
    let blackMoves = 0;
    let redChecks = 0;
    let blackChecks = 0;
    for (let i = start; i < this.ply; i++) {
      // The side that made the move at ply `i` alternates back from the side
      // that is to move now.
      const mover = ((this.side as number) + (this.ply - i)) & 1;
      if (mover === (Side.Red as number)) {
        redMoves++;
        if (this.hCheckAfter[i] === 1) redChecks++;
      } else {
        blackMoves++;
        if (this.hCheckAfter[i] === 1) blackChecks++;
      }
    }
    const redPerp = redMoves > 0 && redChecks === redMoves;
    const blackPerp = blackMoves > 0 && blackChecks === blackMoves;
    if (redPerp === blackPerp) return REP_DRAW; // both, or neither
    const loser = redPerp ? Side.Red : Side.Black;
    return loser === this.side ? REP_LOSS : REP_WIN;
  }

  /** Neither side has anything but a general. */
  bareGenerals(): boolean {
    for (let code = 1; code < 16; code++) {
      if ((code & 7) === PieceType.None || (code & 7) === PieceType.General) continue;
      if (this.pieceCount[code] > 0) return false;
    }
    return true;
  }

  /** Chariots + cannons + horses for one side — the null-move safety gate. */
  majorCount(side: Side): number {
    const b = (side as number) << 3;
    return (
      this.pieceCount[b | PieceType.Chariot] +
      this.pieceCount[b | PieceType.Cannon] +
      this.pieceCount[b | PieceType.Horse]
    );
  }

  /** Total pieces on the board, both sides. */
  totalPieces(): number {
    let n = 0;
    for (let code = 1; code < 16; code++) n += this.pieceCount[code];
    return n;
  }

  /** Square of `side`'s general. */
  general(side: Side): number {
    return this.generalSq[side];
  }
}

/** Rank helper kept local so hot loops do not pay for a cross-module call. */
export function rankOfSquare(s: number): number {
  return rankOf(s);
}
