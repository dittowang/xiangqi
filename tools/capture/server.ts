/**
 * The static server the harness captures against.
 *
 * Strategy, in preference order:
 *
 *   1. **Reuse.** If something already answers on the port, use it. A developer
 *      with `npm run dev` open should be able to run the harness without the
 *      harness fighting them for the port.
 *   2. **`vite build` + `vite preview`.** The default. A preview server serves
 *      static files that were already transformed, so no capture can ever race
 *      an on-demand transform, and the bytes under test are the bytes that ship.
 *   3. **`vite` dev server.** Fallback only. Used when the build fails, so that
 *      a broken production build still lets you look at the frame that broke it.
 *
 * Readiness is decided by polling HTTP for a 2xx, never by sleeping. A fixed
 * sleep is how a harness ends up screenshotting a connection-refused page.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, derived from this file's location — never from cwd. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const VITE_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'vite');

export type ServerMode = 'reused' | 'preview' | 'dev';

export interface ServerOptions {
  /** Port to serve on / look for. Default 4173 (vite preview's configured port). */
  port?: number;
  host?: string;
  /** 'auto' tries preview then falls back to dev. Default 'auto'. */
  mode?: 'auto' | 'preview' | 'dev';
  /** Adopt an already-running server on the port. Default true. */
  reuse?: boolean;
  /** How long to wait for the port to answer, ms. Default 60000. */
  timeoutMs?: number;
  /** Skip `vite build` and serve whatever is already in dist/. Default false. */
  skipBuild?: boolean;
  log?: (line: string) => void;
}

export interface ServerHandle {
  url: string;
  port: number;
  host: string;
  mode: ServerMode;
  /** Idempotent. A reused server is never killed — we did not start it. */
  stop(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<ServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 4173;
  const mode = opts.mode ?? 'auto';
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const log = opts.log ?? (() => {});
  const url = `http://${host}:${port}/`;

  if (opts.reuse !== false && (await probe(host, port, 1500))) {
    log(`server: reusing the process already answering on ${url}`);
    return { url, port, host, mode: 'reused', stop: async () => {} };
  }

  if (!existsSync(VITE_BIN)) {
    throw new Error(
      `vite is not installed at ${VITE_BIN}. Run the harness from a checkout with node_modules present.`,
    );
  }

  if (mode !== 'dev') {
    try {
      if (!opts.skipBuild) {
        log('server: vite build …');
        const t0 = Date.now();
        await runToCompletion(VITE_BIN, ['build'], log);
        log(`server: build finished in ${Date.now() - t0} ms`);
      }
      return await spawnServer('preview', ['preview', '--port', String(port), '--host', host, '--strictPort'], host, port, timeoutMs, log);
    } catch (err) {
      if (mode === 'preview') throw err;
      log(`server: preview path failed (${(err as Error).message}); falling back to the dev server`);
    }
  }

  // Dev fallback. Uses its own port from vite.config.ts unless one was asked for.
  const devPort = opts.port ?? 5173;
  const devUrl = `http://${host}:${devPort}/`;
  if (opts.reuse !== false && (await probe(host, devPort, 1500))) {
    log(`server: reusing the dev server already answering on ${devUrl}`);
    return { url: devUrl, port: devPort, host, mode: 'reused', stop: async () => {} };
  }
  return await spawnServer('dev', ['--port', String(devPort), '--host', host, '--strictPort'], host, devPort, timeoutMs, log);
}

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

async function spawnServer(
  kind: 'preview' | 'dev',
  args: string[],
  host: string,
  port: number,
  timeoutMs: number,
  log: (s: string) => void,
): Promise<ServerHandle> {
  log(`server: vite ${args.join(' ')}`);
  // `detached` gives the child its own process group, so stop() can take down
  // vite *and* anything it spawned with one signal. Orphaned vite processes
  // holding a port are a genuinely miserable way to lose an afternoon.
  const child = spawn(VITE_BIN, args, {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const tail: string[] = [];
  const collect = (b: Buffer) => {
    const s = b.toString();
    tail.push(s);
    if (tail.length > 40) tail.shift();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on('exit', (code, signal) => (exited = { code, signal }));

  const url = `http://${host}:${port}/`;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (exited) {
      throw new Error(
        `vite ${kind} exited before serving (code ${(exited as { code: number | null }).code}).\n${tail.join('')}`,
      );
    }
    if (await probe(host, port, 1000)) {
      log(`server: ${kind} answering on ${url} after ${Date.now() - started} ms`);
      return { url, port, host, mode: kind, stop: () => killTree(child) };
    }
    await delay(150);
  }
  await killTree(child);
  throw new Error(`vite ${kind} did not answer on ${url} within ${timeoutMs} ms.\n${tail.join('')}`);
}

async function runToCompletion(bin: string, args: string[], log: (s: string) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const out: string[] = [];
    child.stdout?.on('data', (b: Buffer) => out.push(b.toString()));
    child.stderr?.on('data', (b: Buffer) => out.push(b.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      log(out.join(''));
      reject(new Error(`\`${path.basename(bin)} ${args.join(' ')}\` exited with code ${code}`));
    });
  });
}

async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    process.kill(-child.pid, 'SIGTERM'); // negative pid = the whole process group
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  const graceful = await Promise.race([done.then(() => true), delay(3000).then(() => false)]);
  if (!graceful && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await Promise.race([done, delay(2000)]);
  }
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * One HTTP GET against the loopback interface. Uses `node:http` rather than
 * global `fetch` on purpose: this environment exports HTTPS_PROXY, and a proxy
 * dispatcher has no business anywhere near 127.0.0.1.
 */
export function probe(host: string, port: number, timeoutMs = 1000, pathname = '/'): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: pathname, timeout: timeoutMs, agent: false }, (res) => {
      const ok = (res.statusCode ?? 500) < 400;
      res.resume(); // drain, otherwise the socket lingers
      resolve(ok);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
