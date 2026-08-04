/**
 * Board <-> world space. Every subsystem converts through here so nothing ever
 * disagrees about where a square physically is.
 *
 * World axes:  +X = increasing file, +Z = toward Red's seat (the camera's
 * default home), +Y = up out of the table. The board surface is y = 0, so a
 * unit's feet sit at y = 0 with no offset anywhere in the character code.
 */

import { Side } from './types.ts';

/** Distance between adjacent intersections, in world units. */
export const SQUARE = 1.0;

export const FILES = 9;
export const RANKS = 10;
export const NUM_SQUARES = FILES * RANKS; // 90

/** Rank index of the last Black row and the first Red row (the river banks). */
export const RIVER_BLACK_BANK = 4;
export const RIVER_RED_BANK = 5;

/** Half-extent of the playing field, used for board geometry and camera limits. */
export const BOARD_HALF_X = ((FILES - 1) * SQUARE) / 2; // 4.0
export const BOARD_HALF_Z = ((RANKS - 1) * SQUARE) / 2; // 4.5

export function sq(file: number, rank: number): number {
  return rank * FILES + file;
}
export function fileOf(s: number): number {
  return s % FILES;
}
export function rankOf(s: number): number {
  return (s / FILES) | 0;
}
export function onBoard(file: number, rank: number): boolean {
  return file >= 0 && file < FILES && rank >= 0 && rank < RANKS;
}

/** True when the square lies on `side`'s own half of the river. */
export function isOwnHalf(s: number, side: Side): boolean {
  const r = rankOf(s);
  return side === Side.Red ? r >= RIVER_RED_BANK : r <= RIVER_BLACK_BANK;
}
export function hasCrossedRiver(s: number, side: Side): boolean {
  return !isOwnHalf(s, side);
}

/** The 3x3 palace test. */
export function inPalace(s: number, side: Side): boolean {
  const f = fileOf(s);
  const r = rankOf(s);
  if (f < 3 || f > 5) return false;
  return side === Side.Red ? r >= 7 : r <= 2;
}

// ---------------------------------------------------------------------------
// World space
// ---------------------------------------------------------------------------

export function worldX(file: number): number {
  return (file - (FILES - 1) / 2) * SQUARE;
}
export function worldZ(rank: number): number {
  return (rank - (RANKS - 1) / 2) * SQUARE;
}
export function squareToWorld(s: number, out: { x: number; y: number; z: number }) {
  out.x = worldX(fileOf(s));
  out.y = 0;
  out.z = worldZ(rankOf(s));
  return out;
}

/** Nearest intersection to a world position, or -1 when well outside the grid. */
export function worldToSquare(x: number, z: number, tolerance = 0.62): number {
  const f = Math.round(x / SQUARE + (FILES - 1) / 2);
  const r = Math.round(z / SQUARE + (RANKS - 1) / 2);
  if (!onBoard(f, r)) return -1;
  const dx = x - worldX(f);
  const dz = z - worldZ(r);
  if (Math.abs(dx) > tolerance || Math.abs(dz) > tolerance) return -1;
  return sq(f, r);
}

/**
 * Which way a unit of `side` faces when idle, as a Y rotation applied to a
 * unit root.
 *
 * Units are authored facing -Z (see contracts.ts). Red's back rank is r = 9 at
 * +Z, nearest the default camera, and Red attacks up the board toward Black at
 * -Z — so Red needs no rotation at all, and Black turns to face back down the
 * board at +Z.
 *
 * This returned Red and Black the wrong way round until the character author
 * measured it against the authoring convention. Both facts have to be read
 * together to see the error, which is exactly why they are now written down
 * here next to each other.
 */
export function facingY(side: Side): number {
  return side === Side.Red ? 0 : Math.PI;
}

// ---------------------------------------------------------------------------
// Notation — traditional relative form (e.g. 炮二平五)
// ---------------------------------------------------------------------------

/** Red counts files right-to-left with Chinese numerals; Black left-to-right with digits. */
export const RED_FILE_NAMES = ['九', '八', '七', '六', '五', '四', '三', '二', '一'];
export const BLACK_FILE_NAMES = ['１', '２', '３', '４', '５', '６', '７', '８', '９'];
export const RED_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
export const BLACK_NUMERALS = ['１', '２', '３', '４', '５', '６', '７', '８', '９'];

export function fileName(file: number, side: Side): string {
  return side === Side.Red ? RED_FILE_NAMES[file] : BLACK_FILE_NAMES[file];
}
export function numeral(n: number, side: Side): string {
  return side === Side.Red ? RED_NUMERALS[n - 1] : BLACK_NUMERALS[n - 1];
}
