/**
 * The opening book, written as move sequences and expanded into a hash map.
 *
 * No file is loaded and nothing is downloaded: the table below *is* the book.
 * Each line is a real opening system given in ICCS coordinates (file a–i left
 * to right from Red's seat, row 0–9 bottom to top), with its traditional name
 * so the table stays readable to someone who knows the openings but not the
 * coordinate scheme.
 *
 * Lines are replayed through the real move generator at load time, so a typo
 * cannot produce an illegal book move — it produces a rejected line that
 * `bookStats()` reports and the test suite fails on. Positions are keyed by the
 * Zobrist key, which means transpositions between lines merge for free: the
 * forty lines below collapse into a couple of hundred distinct positions with
 * several replies each.
 *
 * Depth is deliberately modest (ten to fourteen plies). A book that runs deeper
 * than the author's real knowledge is worse than no book, because it walks the
 * engine into a structure it then has to play by search alone.
 */

import { START_FEN } from '@core/testapi.ts';
import type { Move } from '@core/types.ts';
import { iccsToMove } from './notation.ts';
import { Position } from './position.ts';
import { keyString } from './zobrist.ts';

interface BookLine {
  /** Traditional name, for readers and for the rejection diagnostics. */
  name: string;
  /** Space-separated ICCS moves, Red first. */
  moves: string;
  /** Relative frequency of this line's continuations. */
  weight?: number;
}

/**
 * The systems covered:
 *   中炮 (central cannon) against 屏風馬, 反宮馬 and 單提馬
 *   順炮 and 列炮
 *   仙人指路 and 對兵局
 *   飛相局 against left, right and 過宮 cannons
 *   起馬局
 */
const LINES: BookLine[] = [
  // --- 中炮 against 屏風馬 -------------------------------------------------
  { name: '中炮對屏風馬 · 基本陣型', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 g6g5 b0c2 c9e7 a0b0 a9b9', weight: 22 },
  { name: '中炮過河車對屏風馬平炮兌車', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 g6g5 h0h6 h7i7 h6g6 i7i8 b0c2 a9b9', weight: 20 },
  { name: '中炮巡河車對屏風馬', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 h0h4 c6c5 b0c2 c9e7 c3c4 a9b9', weight: 16 },
  { name: '中炮直橫車對屏風馬', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 a0a1 c6c5 a1d1 a9b9', weight: 14 },
  { name: '五六炮對屏風馬', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 b2d2 c6c5 b0c2 a9b9', weight: 14 },
  { name: '五七炮對屏風馬', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 b2c2 c6c5 b0a2 a9b9', weight: 14 },
  { name: '中炮盤頭馬對屏風馬', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 e3e4 c6c5 b0c2 a9b9', weight: 12 },
  { name: '中炮兩頭蛇對屏風馬', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 g6g5 g3g4 c6c5', weight: 12 },
  { name: '中炮對屏風馬騎河炮', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 h7h5 b0c2 a9b9', weight: 10 },
  { name: '中炮補士對屏風馬', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 g6g5 d0e1 c9e7', weight: 10 },
  { name: '中炮七路馬對屏風馬', moves: 'h2e2 h9g7 h0g2 b9c7 b0c2 i9h9 i0h0 h7i7 h0h6 a9b9', weight: 12 },
  { name: '中炮左馬盤河對屏風馬', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 b0c2 c9e7 c3c4 a9b9', weight: 12 },
  { name: '中炮過河車對屏風馬 · 進中卒', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 g6g5 h0h6 c6c5 b0c2 a9b9', weight: 10 },
  { name: '中炮過河車對屏風馬 · 兌車後', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 g6g5 h0h6 h7i7 h6g6 c6c5', weight: 10 },
  { name: '五七炮對屏風馬 · 黑平炮', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 b2c2 c6c5 b0a2 h7i7', weight: 8 },
  { name: '五六炮對屏風馬 · 黑飛象', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 b2d2 g6g5 b0c2 c9e7', weight: 8 },
  { name: '中炮對屏風馬 · 黑進３卒', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 c6c5 h0h4 a9b9', weight: 10 },

  // --- 中炮 against the other black systems -------------------------------
  { name: '中炮對反宮馬', moves: 'h2e2 b9c7 h0g2 h7f7 i0h0 h9g7 h0h6 a9b9 b0c2 i9h9', weight: 16 },
  { name: '中炮對單提馬', moves: 'h2e2 h9g7 h0g2 b9a7 i0h0 i9h9 h0h6 a9b9 b0c2 h7i7', weight: 12 },

  // --- 順炮 / 列炮 ---------------------------------------------------------
  { name: '順炮直車對橫車', moves: 'h2e2 h7e7 h0g2 h9g7 i0h0 i9h9 h0h6 b9c7 b0c2 a9b9', weight: 18 },
  { name: '順炮橫車對直車', moves: 'h2e2 h7e7 h0g2 h9g7 a0a1 i9h9 a1d1 b9c7 i0h0 a9b9', weight: 14 },
  { name: '順炮緩開車', moves: 'h2e2 h7e7 h0g2 h9g7 c3c4 i9h9 b0c2 b9c7 i0h0 a9b9', weight: 12 },
  { name: '順炮過河車', moves: 'h2e2 h7e7 h0g2 h9g7 i0h0 i9h9 h0h6 c6c5 b0c2 b9c7', weight: 10 },
  { name: '順炮進七兵', moves: 'h2e2 h7e7 h0g2 h9g7 i0h0 i9h9 c3c4 b9c7 b0c2 a9b9', weight: 10 },
  { name: '列炮', moves: 'h2e2 b7e7 h0g2 h9g7 i0h0 i9h9 h0h6 b9c7 b0c2 a9b9', weight: 14 },

  // --- 仙人指路 / 對兵局 ---------------------------------------------------
  { name: '仙人指路對卒底炮', moves: 'c3c4 b7g7 h2e2 b9c7 h0g2 a9b9 i0h0 b9b5', weight: 14 },
  { name: '仙人指路對中炮', moves: 'c3c4 h7e7 h0g2 h9g7 i0h0 i9h9 b0c2 b9c7 a0b0 a9b9', weight: 14 },
  { name: '仙人指路對進７卒', moves: 'c3c4 g6g5 h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 b0c2 a9b9', weight: 12 },
  { name: '對兵局轉中炮', moves: 'c3c4 c6c5 h2e2 b9c7 h0g2 h9g7 i0h0 i9h9 b0c2 a9b9', weight: 12 },
  { name: '仙人指路轉中炮 · 黑進７卒', moves: 'c3c4 g6g5 h2e2 b9c7 h0g2 h9g7 i0h0 i9h9 b0c2 a9b9', weight: 10 },
  { name: '對兵局轉起馬', moves: 'c3c4 c6c5 b0c2 b9c7 h2e2 h9g7 h0g2 i9h9 i0h0 a9b9', weight: 10 },

  // --- 飛相局 --------------------------------------------------------------
  { name: '飛相局對左中炮', moves: 'g0e2 h7e7 b0c2 h9g7 a0b0 i9h9 g3g4 b9c7 h0g2 c6c5', weight: 16 },
  { name: '飛相局對右中炮', moves: 'g0e2 b7e7 b0c2 b9c7 a0b0 a9b9 h0g2 h9g7 i0h0 i9h9', weight: 14 },
  { name: '飛相局對進７卒', moves: 'g0e2 g6g5 h0g2 h9g7 i0h0 i9h9 h2h4 b9c7 b0c2 a9b9', weight: 12 },
  { name: '飛相局對過宮炮', moves: 'g0e2 h7f7 b0c2 b9c7 a0b0 a9b9 h0g2 h9g7 i0h0 i9h9', weight: 12 },
  { name: '飛相局轉直車', moves: 'g0e2 h7e7 b0c2 h9g7 a0b0 i9h9 h0g2 b9c7 i0h0 a9b9', weight: 10 },

  // --- 起馬局 --------------------------------------------------------------
  { name: '起馬局對進３卒', moves: 'b0c2 c6c5 c3c4 b9c7 h2e2 h9g7 h0g2 i9h9 i0h0 a9b9', weight: 12 },
  { name: '起馬局對中炮', moves: 'b0c2 h7e7 h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 a0b0 a9b9', weight: 12 },
  { name: '起馬轉屏風馬', moves: 'h0g2 h7e7 b2e2 h9g7 b0c2 i9h9 i0h0 b9c7 a0b0 a9b9', weight: 10 },
  { name: '起馬對進３卒轉左中炮', moves: 'h0g2 c6c5 b2e2 b9c7 b0c2 h9g7 i0h0 i9h9 a0b0 a9b9', weight: 10 },

  // --- deeper deviations, widening the book without deepening it ----------
  { name: '中炮對屏風馬 · 黑補左士', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 f9e8 b0c2 c6c5', weight: 8 },
  { name: '中炮對屏風馬 · 黑補右士', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 d9e8 b0c2 g6g5', weight: 8 },
  { name: '中炮對屏風馬 · 紅補仕', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 f0e1 c6c5 b0c2 a9b9', weight: 8 },
  { name: '中炮對屏風馬 · 紅進一兵', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 i3i4 g6g5 b0c2 a9b9', weight: 8 },
  { name: '中炮對屏風馬 · 紅進九兵', moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 a3a4 c6c5 b0c2 a9b9', weight: 8 },
  { name: '順炮直車 · 黑進中卒', moves: 'h2e2 h7e7 h0g2 h9g7 i0h0 i9h9 h0h6 e6e5 b0c2 b9c7', weight: 8 },
  { name: '列炮 · 紅巡河車', moves: 'h2e2 b7e7 h0g2 h9g7 i0h0 i9h9 h0h4 b9c7 b0c2 a9b9', weight: 8 },
  { name: '飛相局對飛象', moves: 'g0e2 c9e7 b0c2 b9c7 a0b0 a9b9 h0g2 h9g7 i0h0 i9h9', weight: 10 },
  { name: '飛相局對起馬', moves: 'g0e2 h9g7 b0c2 i9h9 a0b0 b9c7 h0g2 a9b9 i0h0 g6g5', weight: 10 },
  { name: '仙人指路對飛象', moves: 'c3c4 c9e7 h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 b0c2 a9b9', weight: 10 },
  { name: '對兵局轉飛相', moves: 'c3c4 c6c5 g0e2 b9c7 b0c2 h9g7 h0g2 i9h9 i0h0 a9b9', weight: 8 },
  { name: '起馬局對飛象', moves: 'b0c2 c9e7 h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 a0b0 a9b9', weight: 8 },
];

export interface BookEntry {
  move: Move;
  weight: number;
}

export interface BookStats {
  /** Distinct positions in the book. */
  positions: number;
  /** Distinct (position, move) pairs. */
  entries: number;
  lines: number;
  /** Lines that contained an illegal move, with the ply that failed. */
  rejected: string[];
  /** Deepest ply reached by any line. */
  maxPly: number;
}

let table: Map<string, BookEntry[]> | null = null;
let stats: BookStats = { positions: 0, entries: 0, lines: 0, rejected: [], maxPly: 0 };

function build(): Map<string, BookEntry[]> {
  const map = new Map<string, BookEntry[]>();
  const rejected: string[] = [];
  let entries = 0;
  let maxPly = 0;

  const pos = new Position(START_FEN);
  for (const line of LINES) {
    pos.setFen(START_FEN);
    const tokens = line.moves.trim().split(/\s+/);
    const weight = line.weight ?? 10;
    for (let i = 0; i < tokens.length; i++) {
      const m = iccsToMove(pos, tokens[i]);
      if (m === 0) {
        rejected.push(`${line.name}: ply ${i + 1} "${tokens[i]}" is not legal`);
        break;
      }
      const key = keyString(pos.keyLo, pos.keyHi);
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      const existing = list.find((e) => e.move === m);
      if (existing) existing.weight += weight;
      else {
        list.push({ move: m, weight });
        entries++;
      }
      pos.makeMove(m);
      if (i + 1 > maxPly) maxPly = i + 1;
    }
  }

  stats = { positions: map.size, entries, lines: LINES.length, rejected, maxPly };
  return map;
}

function ensure(): Map<string, BookEntry[]> {
  if (!table) table = build();
  return table;
}

/** Weighted replies for this position, or null when the book has nothing. */
export function bookEntries(pos: Position): BookEntry[] | null {
  const list = ensure().get(keyString(pos.keyLo, pos.keyHi));
  return list && list.length > 0 ? list : null;
}

export function bookStats(): BookStats {
  ensure();
  return stats;
}

/** Line names, so the HUD can say which opening is being played. */
export function bookLineNames(): string[] {
  return LINES.map((l) => l.name);
}
