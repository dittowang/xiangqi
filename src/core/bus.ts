/**
 * The one event bus. Game logic emits; rendering, animation, camera, HUD and
 * audio listen. No subsystem reaches into another's internals — if two modules
 * need to agree on something, it goes through here or through a contract in
 * `contracts.ts`.
 */

import type { Difficulty, GameResult, Move, PieceCode, Side } from './types.ts';

/** The dramatic arc of a match. The camera, lighting and score all key off this. */
export type MatchPhase =
  | 'boot'
  | 'formation' // armies marching in
  | 'development' // high and wide
  | 'middlegame' // capture cuts armed
  | 'endgame' // low, cool, long shadows
  | 'terminal' // checkmate set piece
  | 'review';

export interface CaptureContext {
  attackerSq: number;
  defenderSq: number;
  attacker: PieceCode;
  defender: PieceCode;
  /** Ranged units (the 砲) resolve their capture from distance. */
  ranged: boolean;
}

export interface BusEvents {
  // --- match lifecycle ---
  'match:start': { difficulty: Difficulty; resumed: boolean };
  'match:phase': { phase: MatchPhase; previous: MatchPhase };
  'match:end': { result: GameResult };
  'match:reset': Record<string, never>;

  // --- moves ---
  /** Fired the instant a move is committed to the model, before any animation. */
  'move:begin': {
    move: Move;
    side: Side;
    piece: PieceCode;
    capture: CaptureContext | null;
    ply: number;
  };
  /** Fired when the move's full animation (including any capture) has settled. */
  'move:end': { move: Move; side: Side; ply: number; notation: string };
  'move:takeback': { ply: number };

  // --- combat choreography ---
  /** Beat 1 windup, beat 2 contact, beat 3 collapse and dispersal. */
  'capture:beat': CaptureContext & { beat: 1 | 2 | 3 };
  'check': { side: Side; generalSq: number; escapable: boolean };
  'check:clear': Record<string, never>;

  // --- interaction ---
  'select': { square: number; targets: number[] };
  'deselect': Record<string, never>;
  'hover': { square: number; targets: number[] };
  'hint': { move: Move | null };

  // --- engine ---
  'engine:thinking': { on: boolean };
  'engine:progress': { depth: number; score: number; nodes: number; pv: Move[] };
  /** Evaluation in centipawns from Red's point of view; drives the ink bar. */
  'eval': { cp: number; mateIn: number | null };

  // --- presentation ---
  'camera:impulse': { strength: number; direction?: [number, number, number] };
  'fx:flash': { strength: number; colour: string };
  'review:enter': Record<string, never>;
  'review:exit': Record<string, never>;
  'review:seek': { ply: number };
  'toast': { text: string; sub?: string; ms?: number };
}

type Handler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

class Bus {
  private map = new Map<string, Set<(p: unknown) => void>>();

  on<K extends keyof BusEvents>(key: K, fn: Handler<K>): () => void {
    let set = this.map.get(key as string);
    if (!set) {
      set = new Set();
      this.map.set(key as string, set);
    }
    set.add(fn as (p: unknown) => void);
    return () => set!.delete(fn as (p: unknown) => void);
  }

  once<K extends keyof BusEvents>(key: K, fn: Handler<K>): () => void {
    const off = this.on(key, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  emit<K extends keyof BusEvents>(key: K, payload: BusEvents[K]): void {
    const set = this.map.get(key as string);
    if (!set) return;
    // Copy before iterating: handlers are allowed to unsubscribe themselves.
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] handler for "${String(key)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}

export const bus = new Bus();
