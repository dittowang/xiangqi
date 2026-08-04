/**
 * Zobrist hashing.
 *
 * JavaScript has no cheap 64-bit integer, and `BigInt` in the make/unmake path
 * would cost more than the search saves. So the key is carried as *two* 32-bit
 * halves that are XORed independently. The low half indexes the transposition
 * table; the high half is stored in the entry and compared on probe, which
 * gives the same collision behaviour as a real 64-bit key at the cost of one
 * extra XOR per update.
 *
 * The keys come from `seedFor()` so a build hashes every position identically
 * on every machine and every run — the opening book is a hash map built at load
 * time, and it would silently miss if the keys drifted.
 */

import { seedFor } from '@core/rng.ts';
import { N_SQ } from './tables.ts';

/** 16 piece codes (side << 3 | type) x 90 squares. */
const TABLE_SIZE = 16 * N_SQ;

export const Z_PIECE_LO = new Int32Array(TABLE_SIZE);
export const Z_PIECE_HI = new Int32Array(TABLE_SIZE);

/** XORed in whenever it is Black to move. */
export let Z_SIDE_LO = 0;
export let Z_SIDE_HI = 0;

{
  const rng = seedFor('engine', 'zobrist', 'v1');
  // `rng.next()` returns [0,1); scaling by 2^32 and truncating gives a full
  // 32-bit spread. Two independent draws per (piece, square) keep the halves
  // uncorrelated, which is what makes the high half a real verification.
  const draw32 = () => (rng.next() * 4294967296) | 0;

  for (let i = 0; i < TABLE_SIZE; i++) {
    Z_PIECE_LO[i] = draw32();
    Z_PIECE_HI[i] = draw32();
  }
  Z_SIDE_LO = draw32();
  Z_SIDE_HI = draw32();
}

/** Index into the piece tables. `code` is 0..15, `sq` is 0..89. */
export function zIndex(code: number, sq: number): number {
  return code * N_SQ + sq;
}

/** Combine both halves into one printable, comparable string (tests, book). */
export function keyString(lo: number, hi: number): string {
  return ((hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0'));
}
