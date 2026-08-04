/**
 * The page `worker.browser.test.ts` loads in a real Chromium.
 *
 * Everything here has to run against the *worker* client, not the in-thread
 * fallback, because the whole point is to exercise the one code path Node
 * cannot: `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`
 * as Vite actually bundles it, plus the message plumbing on both sides.
 *
 * The result lands on `window.__WORKER_CHECK` for Playwright to read.
 */

import { START_FEN } from '@core/testapi.ts';
import { MoveList, Position, createEngineClient, generateLegalMoves, moveToIccs } from '@engine/index.ts';

export interface WorkerCheckResult {
  ok: boolean;
  /** True when the client really constructed a Worker rather than falling back. */
  usedWorker: boolean;
  perft3: number;
  searchMove: string;
  searchDepth: number;
  searchNodes: number;
  mateMove: string;
  mateIn: number | null;
  fromBook: boolean;
  progressEvents: number;
  legalOnMainThread: number;
  error: string | null;
}

declare global {
  interface Window {
    __WORKER_CHECK?: WorkerCheckResult;
  }
}

async function run(): Promise<WorkerCheckResult> {
  const result: WorkerCheckResult = {
    ok: false,
    usedWorker: false,
    perft3: -1,
    searchMove: '',
    searchDepth: 0,
    searchNodes: 0,
    mateMove: '',
    mateIn: null,
    fromBook: false,
    progressEvents: 0,
    legalOnMainThread: 0,
    error: null,
  };

  // The main thread must be able to answer legal-move questions itself; this is
  // the hover-highlight path and it must not need the worker at all.
  const pos = new Position(START_FEN);
  const list = new MoveList();
  generateLegalMoves(pos, list);
  result.legalOnMainThread = list.count;

  let progress = 0;
  const client = createEngineClient({ onProgress: () => progress++ });
  // `LocalEngineClient` is the fallback; anything else came from the Worker path.
  result.usedWorker = client.constructor.name !== 'LocalEngineClient';

  await client.ready();
  await client.newGame();

  result.perft3 = await client.perft(START_FEN, 3);

  await client.setPosition(START_FEN, []);
  const hard = await client.search('hard', { timeMs: 600 });
  result.searchMove = moveToIccs(hard.move);
  result.fromBook = hard.fromBook;

  // A position the book has never heard of, so the worker really searches.
  const endgame = '2bak4/9/9/4c4/9/R3P4/4C4/9/9/4KAB2 w - - 0 1';
  await client.setPosition(endgame, []);
  const searched = await client.search('hard', { timeMs: 900 });
  result.searchDepth = searched.depth;
  result.searchNodes = searched.nodes;

  // Mate in one, through `analyse` — a different message path.
  const mate = '4k4/R7R/9/9/9/9/9/9/9/3K5 w - - 0 1';
  const analysis = await client.analyse(mate, 500);
  result.mateMove = moveToIccs(analysis.move);
  result.mateIn = analysis.mateIn;

  result.progressEvents = progress;
  client.dispose();
  result.ok = true;
  return result;
}

run()
  .then((r) => {
    window.__WORKER_CHECK = r;
    document.getElementById('status')!.textContent = 'done';
  })
  .catch((err: unknown) => {
    window.__WORKER_CHECK = {
      ok: false,
      usedWorker: false,
      perft3: -1,
      searchMove: '',
      searchDepth: 0,
      searchNodes: 0,
      mateMove: '',
      mateIn: null,
      fromBook: false,
      progressEvents: 0,
      legalOnMainThread: 0,
      error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
    };
    document.getElementById('status')!.textContent = 'failed';
  });
