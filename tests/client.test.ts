/**
 * The `EngineClient` facade and the isomorphic host behind it.
 *
 * Node has no `Worker`, so `createEngineClient()` falls back to the in-thread
 * implementation here — which is exactly the property being tested: the same
 * host answers the same requests on either side of the thread boundary.
 */

import { describe, expect, it } from 'vitest';
import { START_FEN } from '@core/testapi.ts';
import type { EngineClient } from '@core/contracts.ts';
import { moveFrom, moveTo } from '@core/types.ts';
import {
  EngineHost,
  MoveList,
  Position,
  createEngineClient,
  generateLegalMoves,
  iccsToMove,
  moveToIccs,
} from '@engine/index.ts';
import { positionOf } from './helpers.ts';

function movesFrom(fen: string, iccs: string[]): number[] {
  const pos = new Position(fen);
  return iccs.map((t) => {
    const m = iccsToMove(pos, t);
    if (!m) throw new Error(`illegal ${t}`);
    pos.makeMove(m);
    return m;
  });
}

describe('EngineClient', () => {
  it('falls back to the in-thread implementation when there is no Worker', async () => {
    const client: EngineClient = createEngineClient();
    await client.ready();
    await client.newGame();
    client.dispose();
  });

  it('searches and returns a legal move', async () => {
    const client = createEngineClient();
    await client.ready();
    await client.newGame();
    await client.setPosition(START_FEN, []);

    const result = await client.search('medium', { timeMs: 400 });
    const pos = new Position(START_FEN);
    const list = new MoveList();
    generateLegalMoves(pos, list);
    expect(list.toArray()).toContain(result.move);
    expect(result.pv.length).toBeGreaterThan(0);
    client.dispose();
  }, 30_000);

  it('applies a move list on top of the FEN', async () => {
    const client = createEngineClient();
    await client.ready();
    const moves = movesFrom(START_FEN, ['h2e2', 'h9g7', 'h0g2']);
    await client.setPosition(START_FEN, moves);

    const result = await client.search('medium', { timeMs: 300 });
    // It is Black to move after three plies, so the move must be a Black one.
    const pos = new Position(START_FEN);
    for (const m of moves) pos.makeMove(m);
    expect(pos.board[moveFrom(result.move)] >> 3).toBe(1);
    client.dispose();
  }, 30_000);

  it('answers perft through the same interface', async () => {
    const client = createEngineClient();
    await client.ready();
    expect(await client.perft(START_FEN, 3)).toBe(79666);
    client.dispose();
  }, 60_000);

  it('analyses an arbitrary FEN without disturbing the game position', async () => {
    const client = createEngineClient();
    await client.ready();
    const moves = movesFrom(START_FEN, ['h2e2', 'h9g7']);
    await client.setPosition(START_FEN, moves);

    const mateFen = positionOf({ e9: 'k', a8: 'R', i8: 'R', d0: 'K' }, 'w').toFen();
    const analysis = await client.analyse(mateFen, 800);
    expect(analysis.mateIn).toBe(1);
    expect(moveToIccs(analysis.move)).toBe('a8a9');

    // The game position is untouched: still Red's third move from the opening.
    const next = await client.search('medium', { timeMs: 300 });
    const pos = new Position(START_FEN);
    for (const m of moves) pos.makeMove(m);
    const list = new MoveList();
    generateLegalMoves(pos, list);
    expect(list.toArray()).toContain(next.move);
    client.dispose();
  }, 60_000);

  it('rejects an illegal move list rather than corrupting the position', async () => {
    const host = new EngineHost(14);
    const bogus = (moveTo(0) | (44 << 7)) >>> 0; // a1 -> nowhere sensible
    expect(() => host.setPosition(START_FEN, [bogus])).toThrow();
  });

  it('plays out of the book on hard and reports it', async () => {
    const client = createEngineClient();
    await client.ready();
    await client.newGame();
    await client.setPosition(START_FEN, []);
    const result = await client.search('hard', { timeMs: 200 });
    expect(result.fromBook).toBe(true);
    client.dispose();
  }, 30_000);

  it('easy skips the book so its first moves vary', async () => {
    const client = createEngineClient();
    await client.ready();
    await client.setPosition(START_FEN, []);
    const result = await client.search('easy', { timeMs: 200 });
    expect(result.fromBook).toBe(false);
    client.dispose();
  }, 30_000);
});
