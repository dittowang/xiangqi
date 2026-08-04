/**
 * Drive `bringup.ts` in real headless Chromium and report which shader variants
 * compile.
 *
 *   npx tsx src/render/gputest.ts            # summary
 *   npx tsx src/render/gputest.ts --verbose  # every driver diagnostic
 *
 * No dev server and no extra HTML: esbuild bundles the bring-up module to a
 * single ES module string and Playwright injects it into a blank page. That
 * keeps the whole loop inside `src/render/`, which matters because this has to
 * be cheap enough to run after every shader edit — a harness you have to set up
 * is a harness that stops being run.
 *
 * SwiftShader is the software rasteriser Chromium falls back to with no GPU. It
 * is a strict, conformant GLSL ES 3.00 implementation, which is exactly what is
 * wanted here: it rejects things a permissive vendor compiler would wave
 * through, so passing on SwiftShader is a stronger statement than passing on
 * one desktop driver.
 */

// Node built-ins are reached through indirect specifiers so this file
// typechecks in a project with no @types/node — the same reason selfcheck.ts
// avoids `process`.
const nodeRequireSpec = (m: string): string => m;

interface ChildProc {
  execFileSync(cmd: string, args: string[], opts: Record<string, unknown>): string;
}
interface FsLike {
  readFileSync(p: string, enc: string): string;
  mkdtempSync(p: string): string;
  rmSync(p: string, opts: Record<string, unknown>): void;
}

interface VariantResult {
  name: string;
  shape: string;
  ok: boolean;
  errors: string[];
}
interface FrameResult {
  ok: boolean;
  notes: string[];
  distinctColours: number;
  coverage: number;
  drawCalls: number;
  triangles: number;
  errors: string[];
}
interface BringupReport {
  renderer: string;
  variants: VariantResult[];
  passed: number;
  failed: number;
  programs: number;
  ms: number;
  frame: FrameResult;
}

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-gpu-sandbox',
];

async function main(): Promise<void> {
  const proc = (globalThis as unknown as { process?: { argv: string[]; exitCode?: number } })
    .process;
  const verbose = proc?.argv.includes('--verbose') ?? false;

  const cp = (await import(nodeRequireSpec('node:child_process'))) as unknown as ChildProc;
  const fs = (await import(nodeRequireSpec('node:fs'))) as unknown as FsLike;
  const os = (await import(nodeRequireSpec('node:os'))) as unknown as { tmpdir(): string };
  const path = (await import(nodeRequireSpec('node:path'))) as unknown as {
    join(...p: string[]): string;
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xq-bringup-'));
  const out = path.join(dir, 'bringup.js');

  console.log('bundling src/render/bringup.ts …');
  cp.execFileSync(
    'node_modules/.bin/esbuild',
    [
      'src/render/bringup.ts',
      '--bundle',
      '--format=esm',
      '--target=es2022',
      '--platform=browser',
      '--log-level=error',
      '--alias:@core=./src/core',
      '--alias:@render=./src/render',
      `--outfile=${out}`,
    ],
    { stdio: 'inherit' },
  );

  const bundle = fs.readFileSync(out, 'utf8');
  console.log(`bundle: ${(bundle.length / 1024).toFixed(0)} kB`);

  const pw = (await import(nodeRequireSpec('playwright'))) as unknown as {
    chromium: {
      launch(o: Record<string, unknown>): Promise<{
        newPage(): Promise<PageLike>;
        close(): Promise<void>;
      }>;
    };
  };

  const browser = await pw.chromium.launch({
    executablePath: CHROME,
    args: CHROME_ARGS,
    headless: true,
  });
  const page = await browser.newPage();

  const pageErrors: string[] = [];
  page.on('pageerror', (e: Error) => pageErrors.push(String(e.stack ?? e)));

  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle, type: 'module' });

  const report = (await page.waitForFunction(
    'window.__RENDER_BRINGUP ? JSON.parse(JSON.stringify(window.__RENDER_BRINGUP)) : null',
    { timeout: 180000 },
  ).then((h: HandleLike) => h.jsonValue())) as BringupReport | { error: string };

  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });

  if (pageErrors.length) {
    console.error('\npage errors:');
    for (const e of pageErrors) console.error(`  ${e}`);
  }

  if ('error' in report) {
    console.error(`\nbring-up threw:\n${report.error}`);
    if (proc) proc.exitCode = 1;
    return;
  }

  console.log(`\ndriver: ${report.renderer}`);
  console.log(`variants compiled: ${report.passed}/${report.variants.length}`);
  console.log(`distinct GL programs: ${report.programs}`);
  console.log(`elapsed in page: ${(report.ms / 1000).toFixed(1)} s`);

  const f = report.frame;
  console.log(
    `\nend-to-end frame: ${f.ok ? 'RENDERED' : 'FAILED'} — ` +
      `${f.distinctColours} distinct colours, ${(f.coverage * 100).toFixed(1)}% coverage, ` +
      `${f.drawCalls} draw calls, ${f.triangles} triangles`,
  );
  for (const n of f.notes) console.log(`    ${n}`);
  for (const e of f.errors) console.error(`    ${e}`);

  const failures = report.variants.filter((v) => !v.ok);
  if (failures.length === 0 && f.ok) {
    console.log('\nALL VARIANTS COMPILE AND A FRAME RENDERS.');
    return;
  }
  if (failures.length === 0) {
    if (proc) proc.exitCode = 1;
    return;
  }

  // Group by the set of diagnostics: one root cause usually produces one group
  // with a hundred members, and reading the group is worth more than reading
  // the hundred.
  const groups = new Map<string, { errors: string[]; names: string[] }>();
  for (const f of failures) {
    const key = f.errors.join('\n');
    let g = groups.get(key);
    if (!g) {
      g = { errors: f.errors, names: [] };
      groups.set(key, g);
    }
    g.names.push(`${f.name} [${f.shape}]`);
  }

  console.error(`\n${failures.length} FAILING VARIANTS in ${groups.size} distinct group(s):\n`);
  for (const g of groups.values()) {
    console.error(`  ${g.names.length} variant(s), e.g. ${g.names.slice(0, 3).join(', ')}`);
    for (const e of g.errors.slice(0, verbose ? 200 : 12)) console.error(`      ${e}`);
    console.error('');
  }
  if (proc) proc.exitCode = 1;
}

interface HandleLike {
  jsonValue(): Promise<unknown>;
}
interface PageLike {
  on(event: string, fn: (arg: never) => void): void;
  setContent(html: string): Promise<void>;
  addScriptTag(opts: { content: string; type: string }): Promise<unknown>;
  waitForFunction(fn: string, opts: Record<string, unknown>): Promise<HandleLike>;
}

void main();
