/**
 * Move annotation for review mode.
 *
 * A move is judged by how much evaluation the mover gave up relative to the
 * engine's preferred line from the same position. Two details make the
 * difference between annotation that feels right and annotation that feels
 * like it is scolding you:
 *
 * 1. The threshold scales with how sharp the position already is. Dropping
 *    80 centipawns from a dead-level position is a real mistake; dropping the
 *    same 80 from a position you are already losing by a chariot is noise.
 * 2. Mate scores are handled separately. Walking into a forced mate is a
 *    blunder no matter what the centipawn arithmetic says, and missing a mate
 *    you had is a blunder even if the position stays winning.
 */

import type { MoveQuality } from '@core/types.ts';

/** Centipawn value the engine assigns to a forced mate, before depth adjustment. */
export const MATE_VALUE = 30000;
/** Anything above this is a mate score rather than a positional evaluation. */
export const MATE_THRESHOLD = MATE_VALUE - 1000;

export interface AnnotationInput {
  /** Evaluation before the move, from the MOVER's point of view, centipawns. */
  before: number;
  /** Evaluation after the move, from the MOVER's point of view, centipawns. */
  after: number;
  /** True when the move played was the engine's own first choice. */
  wasBest: boolean;
  /** How many legal alternatives existed. A forced move is never a mistake. */
  legalCount: number;
}

export interface Annotation {
  quality: MoveQuality;
  /** Centipawns given up, never negative. */
  loss: number;
  /** Chinese label for the HUD, in the register a 棋譜 would use. */
  label: string;
  /** Which pigment the mark is drawn in. */
  tone: 'gold' | 'ink' | 'cinnabar';
}

const LABEL: Record<MoveQuality, { label: string; tone: Annotation['tone'] }> = {
  brilliant: { label: '妙手', tone: 'gold' },
  strong: { label: '佳著', tone: 'gold' },
  ok: { label: '', tone: 'ink' },
  inaccuracy: { label: '緩著', tone: 'ink' },
  mistake: { label: '失著', tone: 'cinnabar' },
  blunder: { label: '漏著', tone: 'cinnabar' },
};

/**
 * The sharpness taper. In a balanced position every centipawn is visible; once
 * one side is up more than a chariot the same absolute loss matters far less.
 * Returns a multiplier applied to the loss thresholds.
 */
function tolerance(before: number): number {
  const advantage = Math.abs(before);
  // 1.0 at level, rising to 2.6 once the position is decided.
  return 1 + Math.min(1.6, advantage / 620);
}

export function annotate(input: AnnotationInput): Annotation {
  const { before, after, wasBest, legalCount } = input;

  // A forced move carries no judgement — there was nothing else to play.
  if (legalCount <= 1) {
    return { quality: 'ok', loss: 0, label: '', tone: 'ink' };
  }

  const beforeMate = Math.abs(before) >= MATE_THRESHOLD;
  const afterMate = Math.abs(after) >= MATE_THRESHOLD;

  // Walked into a forced mate against.
  if (afterMate && after < 0 && !(beforeMate && before < 0)) {
    return { quality: 'blunder', loss: MATE_VALUE, ...LABEL.blunder };
  }
  // Had a forced mate and let it go.
  if (beforeMate && before > 0 && !(afterMate && after > 0)) {
    return { quality: 'blunder', loss: MATE_VALUE, ...LABEL.blunder };
  }
  // Found a forced mate.
  if (afterMate && after > 0 && !(beforeMate && before > 0)) {
    return { quality: 'brilliant', loss: 0, ...LABEL.brilliant };
  }
  // Already mating and still mating: nothing to say.
  if (beforeMate && afterMate) {
    return { quality: 'ok', loss: 0, ...LABEL.ok };
  }

  const loss = Math.max(0, before - after);
  const k = tolerance(before);

  // The engine's own choice, or within a rounding error of it. A move that
  // *gains* against the engine's expectation is only "brilliant" if the engine
  // did not see it first — otherwise every good move in a won game gets a star,
  // which cheapens the mark.
  if (wasBest) {
    return loss <= 8 && after - before > 90
      ? { quality: 'brilliant', loss: 0, ...LABEL.brilliant }
      : { quality: 'strong', loss: 0, ...LABEL.strong };
  }

  if (loss >= 290 * k) return { quality: 'blunder', loss, ...LABEL.blunder };
  if (loss >= 130 * k) return { quality: 'mistake', loss, ...LABEL.mistake };
  if (loss >= 55 * k) return { quality: 'inaccuracy', loss, ...LABEL.inaccuracy };
  if (loss <= 12) return { quality: 'strong', loss, ...LABEL.strong };
  return { quality: 'ok', loss, ...LABEL.ok };
}

/** Format a centipawn score the way the HUD shows it, e.g. "+1.4" or "殺 3". */
export function formatScore(cp: number): string {
  if (Math.abs(cp) >= MATE_THRESHOLD) {
    const plies = MATE_VALUE - Math.abs(cp);
    const moves = Math.max(1, Math.ceil(plies / 2));
    return `${cp > 0 ? '' : '-'}殺${moves}`;
  }
  const v = cp / 100;
  return (v >= 0 ? '+' : '') + v.toFixed(1);
}
