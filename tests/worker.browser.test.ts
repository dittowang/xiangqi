/**
 * The one test that runs the engine worker in a real browser.
 *
 * Node has no `Worker`, and `src/engine/worker.ts` touches `self` at module
 * scope, so every other client test in this suite exercises `LocalEngineClient`
 * instead. That leaves the path the game actually ships on —
 * `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`,
 * bundled by Vite as a separate ES-module chunk — completely uncovered. A
 * worker that fails to instantiate in Chromium would look identical to a green
 * suite.
 *
 * So: build the page for production with Vite's own bundler, serve the build,
 * drive it with the Chromium that Playwright already has, and read the result
 * back out of the page. This is the production worker chunk, not a dev-server
 * approximation.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { build, preview, type PreviewServer } from 'vite';
import type { WorkerCheckResult } from './browser/worker-check.ts';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
/** Inside the already-ignored `.scratch/` so the build never lands in the tree. */
const OUT_DIR = `${ROOT}/.scratch/worker-check-build`;
const PORT = 4399;

/**
 * Playwright's bundled revision may not be the one installed in this image, so
 * try the default first and then the known install locations. No `node:fs`
 * import: this file has to typecheck without `@types/node`.
 */
const CHROME_CANDIDATES = [
  undefined,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];

async function launchChromium(): Promise<Browser | null> {
  for (const executablePath of CHROME_CANDIDATES) {
    try {
      return await chromium.launch({
        ...(executablePath ? { executablePath } : {}),
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
    } catch {
      // try the next candidate
    }
  }
  return null;
}

let browser: Browser | null = null;
let server: PreviewServer | null = null;

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('engine worker in a real browser', () => {
  it('builds, instantiates the module worker and answers every request', async () => {
    browser = await launchChromium();
    if (!browser) {
      throw new Error('no Chromium available to run the worker check');
    }

    // Production build of just the check page, with the same aliases and
    // worker format `vite.config.ts` uses for the game itself.
    await build({
      configFile: false,
      root: ROOT,
      base: './',
      logLevel: 'warn',
      resolve: {
        alias: {
          '@core': `${ROOT}/src/core`,
          '@engine': `${ROOT}/src/engine`,
        },
      },
      worker: { format: 'es' },
      build: {
        outDir: OUT_DIR,
        emptyOutDir: true,
        target: 'es2022',
        rollupOptions: { input: `${ROOT}/tests/browser/worker-check.html` },
      },
    });

    // `preview` serves `build.outDir` resolved against `root`, so both have to
    // be handed to it the same way the build got them.
    server = await preview({
      configFile: false,
      root: ROOT,
      base: './',
      logLevel: 'warn',
      build: { outDir: OUT_DIR },
      preview: { port: PORT, host: '127.0.0.1', strictPort: true },
    });

    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text());
    });

    await page.goto(`http://127.0.0.1:${PORT}/tests/browser/worker-check.html`, {
      waitUntil: 'load',
    });
    await page.waitForFunction(() => (window as unknown as { __WORKER_CHECK?: unknown }).__WORKER_CHECK !== undefined, {
      timeout: 60_000,
    });
    const result = (await page.evaluate(
      () => (window as unknown as { __WORKER_CHECK: WorkerCheckResult }).__WORKER_CHECK,
    )) as WorkerCheckResult;

    console.log('[browser]', JSON.stringify(result));
    expect(result.error, `page errors: ${pageErrors.join(' | ')}`).toBeNull();
    expect(result.ok).toBe(true);

    // It really went through the Worker, not the in-thread fallback.
    expect(result.usedWorker).toBe(true);
    // Every message kind round-tripped.
    expect(result.perft3).toBe(79666);
    expect(result.fromBook).toBe(true); // 'hard' from the start position
    expect(result.searchDepth).toBeGreaterThanOrEqual(4);
    expect(result.searchNodes).toBeGreaterThan(1000);
    expect(result.mateMove).toBe('a8a9');
    expect(result.mateIn).toBe(1);
    // Progress messages arrived unsolicited during the searches.
    expect(result.progressEvents).toBeGreaterThan(0);
    // ...and the main thread answered its own legal-move question meanwhile.
    expect(result.legalOnMainThread).toBe(44);
    // Ignore the console noise every headless page produces (favicon 404s and
    // the like); a real failure would have shown up in `result.error`.
    const realErrors = pageErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
    expect(realErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  }, 300_000);
});
