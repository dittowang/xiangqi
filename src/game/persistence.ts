/**
 * Match persistence. A refresh resumes the game exactly where it was — same
 * position, same move list, same difficulty, same side.
 *
 * Only the move list is stored, never a board snapshot. Replaying moves from
 * the start position through the real rule code is self-validating: a save
 * written by an older build with different move encoding fails to replay and is
 * discarded rather than resurrecting a corrupt position.
 */

import type { SavedMatch } from '@core/contracts.ts';
import { type Difficulty, type GameResult, type Move, ONGOING, Side } from '@core/types.ts';
import { START_FEN } from '@core/testapi.ts';

const KEY = 'xiangqi.gongbi.match';
/** Bump when the move encoding or the saved shape changes. */
const VERSION = 1;

function storage(): Storage | null {
  try {
    // Private browsing and some embedded webviews throw on access, not on use.
    const s = window.localStorage;
    const probe = '__xq_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export function save(match: Omit<SavedMatch, 'version' | 'savedAt'>): void {
  const s = storage();
  if (!s) return;
  const payload: SavedMatch = { ...match, version: VERSION, savedAt: Date.now() };
  try {
    s.setItem(KEY, JSON.stringify(payload));
  } catch {
    // A quota error here is not worth interrupting a game over. The match is
    // still fully playable; only the resume-after-refresh affordance is lost.
  }
}

export function load(): SavedMatch | null {
  const s = storage();
  if (!s) return null;
  const raw = s.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SavedMatch>;
    if (parsed.version !== VERSION) return null;
    if (!Array.isArray(parsed.moves) || !parsed.moves.every((m) => Number.isInteger(m))) return null;
    if (typeof parsed.fen !== 'string') return null;
    return {
      version: VERSION,
      difficulty: (parsed.difficulty ?? 'medium') as Difficulty,
      fen: parsed.fen || START_FEN,
      moves: parsed.moves as Move[],
      humanSide: parsed.humanSide === Side.Black ? Side.Black : Side.Red,
      result: (parsed.result as GameResult) ?? ONGOING,
      savedAt: parsed.savedAt ?? 0,
    };
  } catch {
    return null;
  }
}

export function clear(): void {
  storage()?.removeItem(KEY);
}

/**
 * Debounced writer. A save on every ply during a fast takeback sequence would
 * serialise the move list a dozen times in one frame for no benefit.
 */
export class SaveScheduler {
  private pending: Omit<SavedMatch, 'version' | 'savedAt'> | null = null;
  private timer = 0;

  constructor(private readonly delaySeconds = 0.4) {}

  request(match: Omit<SavedMatch, 'version' | 'savedAt'>): void {
    this.pending = match;
    this.timer = this.delaySeconds;
  }

  update(dt: number): void {
    if (!this.pending) return;
    this.timer -= dt;
    if (this.timer <= 0) this.flush();
  }

  flush(): void {
    if (!this.pending) return;
    save(this.pending);
    this.pending = null;
  }
}
