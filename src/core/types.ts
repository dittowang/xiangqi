/**
 * Shared vocabulary for the whole project.
 *
 * Board convention (fixed, never re-derive it):
 *   file `f` : 0..8, left -> right from Red's seat
 *   rank `r` : 0..9, r = 0 is BLACK's back rank (far side / -Z),
 *                    r = 9 is RED's back rank  (near side / +Z)
 *   square index = r * 9 + f, so 0..89.
 *
 * The river runs between r = 4 and r = 5. Black owns 0..4, Red owns 5..9.
 * Palaces are the 3x3 blocks f = 3..5 at r = 0..2 (Black) and r = 7..9 (Red).
 *
 * Red is the Han army (cinnabar lacquer). Black is the Chu army (ink lacquer).
 * Red moves first, always.
 */

// ---------------------------------------------------------------------------
// Sides and pieces
// ---------------------------------------------------------------------------

export const enum Side {
  Red = 0,
  Black = 1,
}

export const enum PieceType {
  None = 0,
  General = 1, // 帥 / 將
  Advisor = 2, // 仕 / 士
  Elephant = 3, // 相 / 象
  Horse = 4, // 傌 / 馬
  Chariot = 5, // 俥 / 車
  Cannon = 6, // 炮 / 砲
  Soldier = 7, // 兵 / 卒
}

/**
 * A piece is packed as `side * 8 + type`, so:
 *   0        = empty
 *   1..7     = Red  general..soldier
 *   9..15    = Black general..soldier
 * The 8-stride keeps `code >> 3` as the side and `code & 7` as the type, which
 * both the engine's hot loops and the Zobrist table index directly.
 */
export type PieceCode = number;

export const EMPTY: PieceCode = 0;

export function makePiece(side: Side, type: PieceType): PieceCode {
  return (side << 3) | type;
}
export function pieceSide(code: PieceCode): Side {
  return (code >> 3) as Side;
}
export function pieceType(code: PieceCode): PieceType {
  return (code & 7) as PieceType;
}
export function isEmpty(code: PieceCode): boolean {
  return code === 0;
}
export function opposite(s: Side): Side {
  return (s ^ 1) as Side;
}

export const PIECE_TYPES: readonly PieceType[] = [
  PieceType.General,
  PieceType.Advisor,
  PieceType.Elephant,
  PieceType.Horse,
  PieceType.Chariot,
  PieceType.Cannon,
  PieceType.Soldier,
];

/** Stable machine-readable key, used for asset registries and capture tooling. */
export type UnitKey =
  | 'general'
  | 'advisor'
  | 'elephant'
  | 'horse'
  | 'chariot'
  | 'cannon'
  | 'soldier';

export const UNIT_KEY: Record<PieceType, UnitKey | ''> = {
  [PieceType.None]: '',
  [PieceType.General]: 'general',
  [PieceType.Advisor]: 'advisor',
  [PieceType.Elephant]: 'elephant',
  [PieceType.Horse]: 'horse',
  [PieceType.Chariot]: 'chariot',
  [PieceType.Cannon]: 'cannon',
  [PieceType.Soldier]: 'soldier',
};

export const UNIT_TYPE_BY_KEY: Record<UnitKey, PieceType> = {
  general: PieceType.General,
  advisor: PieceType.Advisor,
  elephant: PieceType.Elephant,
  horse: PieceType.Horse,
  chariot: PieceType.Chariot,
  cannon: PieceType.Cannon,
  soldier: PieceType.Soldier,
};

/**
 * Traditional characters. Red and Black use different glyphs for the same piece
 * — that asymmetry is part of the board's visual language and we honour it.
 * These strings exist only for logs, notation and tests; the on-screen glyphs
 * are drawn from hand-authored seal-script outlines (see ui/seal.ts), never
 * from a system font.
 */
export const GLYPH: Record<Side, Record<PieceType, string>> = {
  [Side.Red]: {
    [PieceType.None]: '',
    [PieceType.General]: '帥',
    [PieceType.Advisor]: '仕',
    [PieceType.Elephant]: '相',
    [PieceType.Horse]: '傌',
    [PieceType.Chariot]: '俥',
    [PieceType.Cannon]: '炮',
    [PieceType.Soldier]: '兵',
  },
  [Side.Black]: {
    [PieceType.None]: '',
    [PieceType.General]: '將',
    [PieceType.Advisor]: '士',
    [PieceType.Elephant]: '象',
    [PieceType.Horse]: '馬',
    [PieceType.Chariot]: '車',
    [PieceType.Cannon]: '砲',
    [PieceType.Soldier]: '卒',
  },
};

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

/**
 * A move packed into one 32-bit integer so move lists are flat Int32Arrays and
 * the search never allocates:
 *   bits  0..6   from square (0..89)
 *   bits  7..13  to square   (0..89)
 *   bits 14..17  captured piece code (0 = quiet move)
 */
export type Move = number;

export const NO_MOVE: Move = 0;

export function encodeMove(from: number, to: number, captured: PieceCode = 0): Move {
  return (from | (to << 7) | (captured << 14)) >>> 0;
}
export function moveFrom(m: Move): number {
  return m & 0x7f;
}
export function moveTo(m: Move): number {
  return (m >>> 7) & 0x7f;
}
export function moveCaptured(m: Move): PieceCode {
  return (m >>> 14) & 0xf;
}
export function isCapture(m: Move): boolean {
  return ((m >>> 14) & 0xf) !== 0;
}

// ---------------------------------------------------------------------------
// Game outcome
// ---------------------------------------------------------------------------

export type GameResultKind =
  | 'ongoing'
  | 'checkmate' // side to move is mated
  | 'stalemate' // side to move has no legal move — a LOSS in xiangqi
  | 'perpetual-check' // the side delivering endless check loses
  | 'perpetual-chase' // endless chasing of an unprotected piece loses
  | 'sixty-move' // 60 full moves with no capture — draw
  | 'repetition-draw' // repetition with no perpetual attacker — draw
  | 'insufficient' // bare general vs bare general — draw
  | 'resign';

export interface GameResult {
  kind: GameResultKind;
  /** Winner, or null for a draw / still running. */
  winner: Side | null;
  /** Human-readable reason, already in Chinese for the HUD. */
  reason: string;
}

export const ONGOING: GameResult = { kind: 'ongoing', winner: null, reason: '' };

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface DifficultyProfile {
  key: Difficulty;
  /** Chinese label for the HUD. */
  label: string;
  /** Hard ceiling for iterative deepening. */
  maxDepth: number;
  /** Wall-clock budget for one search, milliseconds. */
  timeMs: number;
  /** Centipawn sigma of the noise sprinkled on root move scores. */
  noiseCp: number;
  /** How many root candidates stay in the weighted-random pool. */
  candidatePool: number;
  /** Probability of deliberately taking a non-best candidate. */
  slipChance: number;
  /** Whether the opening book is consulted. */
  useBook: boolean;
}

export const DIFFICULTY: Record<Difficulty, DifficultyProfile> = {
  easy: {
    key: 'easy',
    label: '初學',
    maxDepth: 3,
    timeMs: 380,
    noiseCp: 78,
    candidatePool: 4,
    slipChance: 0.62,
    useBook: false,
  },
  medium: {
    key: 'medium',
    label: '棋士',
    maxDepth: 6,
    timeMs: 1100,
    noiseCp: 22,
    candidatePool: 2,
    slipChance: 0.17,
    useBook: true,
  },
  hard: {
    key: 'hard',
    label: '國手',
    maxDepth: 26,
    timeMs: 2600,
    noiseCp: 0,
    candidatePool: 1,
    slipChance: 0,
    useBook: true,
  },
};

// ---------------------------------------------------------------------------
// Move annotation (review mode)
// ---------------------------------------------------------------------------

export type MoveQuality = 'brilliant' | 'strong' | 'ok' | 'inaccuracy' | 'mistake' | 'blunder';

export interface AnnotatedMove {
  move: Move;
  /** Notation in the traditional relative form, e.g. 炮二平五. */
  notation: string;
  side: Side;
  /** Engine eval before the move, in centipawns, from Red's point of view. */
  evalBefore: number;
  /** Engine eval after the move, from Red's point of view. */
  evalAfter: number;
  /** How much the mover gave up, in centipawns (always >= 0). */
  loss: number;
  quality: MoveQuality;
  /** Engine's preferred continuation from the position before the move. */
  bestLine: Move[];
  bestNotation: string[];
}

// ---------------------------------------------------------------------------
// Small maths helpers shared everywhere
// ---------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
/** Cubic ease used for nearly every UI and camera transition in the project. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
export function easeOutQuint(t: number): number {
  return 1 - Math.pow(1 - t, 5);
}
export function easeInQuad(t: number): number {
  return t * t;
}
/** Overshooting ease — the weight cue for an attack windup releasing. */
export function easeOutBack(t: number, overshoot = 1.7): number {
  const c3 = overshoot + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + overshoot * Math.pow(t - 1, 2);
}
/** Frame-rate independent exponential approach; `rate` is per second. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}
