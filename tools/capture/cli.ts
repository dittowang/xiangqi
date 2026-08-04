/**
 * `npx tsx tools/capture/cli.ts <suite> [options]`
 *
 * Starts (or adopts) a server, drives the game to every shot in the suite,
 * writes the PNGs, and leaves behind a `captures/<suite>/index.md` that a critic
 * agent can be pointed at as a single file.
 *
 * The exit code is the contract: 0 means every shot in the suite produced a
 * frame that passed the blank-frame check, and the page reported no errors.
 * A skipped shot is not a failure — it is the harness refusing to pretend a
 * stubbed subsystem was judged — but it is loud, and it is counted.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { XqFrameStats } from '@core/testapi.ts';
import { Driver, firstLine, type ShotResult } from './driver.ts';
import { analysePng, describeStats, judgeFrame, pct, type FrameStats } from './png.ts';
import { REPO_ROOT, startServer, type ServerHandle } from './server.ts';
import { SheetSession, layoutSheet } from './sheet.ts';
import { PERF_BUDGET, SUITE_NAMES, shotsFor, type SheetShot, type Shot, type SuiteName } from './shots.ts';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Options {
  suites: SuiteName[];
  url: string | null;
  out: string;
  only: string[];
  port: number;
  width: number;
  height: number;
  deviceScaleFactor: number;
  reviewLongEdge: number;
  headless: boolean;
  verbose: boolean;
  bail: boolean;
  list: boolean;
  skipBuild: boolean;
  serverMode: 'auto' | 'preview' | 'dev';
}

const USAGE = `
capture — deterministic frames from the running game

  npx tsx tools/capture/cli.ts <suite> [options]

Suites
  stills        named camera framings at the opening, mid-game and endgame
  silhouettes   silhouette mode: every unit isolated, plus per-army line-up sheets
  units         each of the 14 (side, type) pairs at three angles, plus turntables
  motion        seekCapture and gait cycles, delivered as contact sheets
  perf          32 units on screen, stats() sampled over N frames
  all           every suite, in that order

Options
  --url=<url>        capture against an already-running server (skips vite entirely)
  --out=<dir>        output root (default <repo>/captures)
  --only=<a,b>       only shots whose name contains one of these substrings
  --port=<n>         port for the server this tool starts (default 4173)
  --width/--height   viewport in CSS px (default 1280x800)
  --dsf=<n>          device pixel ratio for the full-resolution capture (default 2)
  --review-edge=<n>  long edge of the review copies (default 1600)
  --server=<mode>    auto | preview | dev  (default auto: build+preview, dev on failure)
  --skip-build       reuse whatever is already in dist/
  --headed           run a visible browser
  --bail             stop at the first failure instead of reporting them all
  --list             print the shot list and exit
  --verbose          forward page console output
`.trimStart();

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) flags.set(a.slice(2), 'true');
      else flags.set(a.slice(2, eq), a.slice(eq + 1));
    } else positional.push(a);
  }
  const num = (k: string, d: number) => (flags.has(k) ? Number(flags.get(k)) : d);

  const suiteArg = (positional[0] ?? 'stills').toLowerCase();
  const suites: SuiteName[] =
    suiteArg === 'all' ? [...SUITE_NAMES] : SUITE_NAMES.includes(suiteArg as SuiteName) ? [suiteArg as SuiteName] : [];
  if (suites.length === 0) {
    process.stderr.write(`unknown suite "${suiteArg}"\n\n${USAGE}`);
    process.exit(2);
  }
  const serverMode = (flags.get('server') ?? 'auto') as Options['serverMode'];

  return {
    suites,
    url: flags.get('url') ?? null,
    out: path.resolve(flags.get('out') ?? path.join(REPO_ROOT, 'captures')),
    only: (flags.get('only') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    port: num('port', 4173),
    width: num('width', 1280),
    height: num('height', 800),
    deviceScaleFactor: num('dsf', 2),
    reviewLongEdge: num('review-edge', 1600),
    headless: !flags.has('headed'),
    verbose: flags.has('verbose'),
    bail: flags.has('bail'),
    list: flags.has('list'),
    skipBuild: flags.has('skip-build'),
    serverMode,
  };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

type Status = 'ok' | 'skipped' | 'failed';

interface Record_ {
  name: string;
  label: string;
  kind: Shot['kind'];
  status: Status;
  ms: number;
  /** Primary image, relative to the suite directory. */
  image: string | null;
  /** What a critic should open — the review copy for stills, the sheet itself. */
  review: string | null;
  bytes: number;
  reviewBytes: number;
  dimensions: string;
  stats: FrameStats | null;
  notes: string[];
  reason: string | null;
  /** Extra markdown appended under the shot in index.md (perf tables). */
  detail?: string;
}

interface SuiteReport {
  suite: SuiteName;
  dir: string;
  url: string;
  startedAt: string;
  elapsedMs: number;
  webgl: string;
  viewport: string;
  records: Record_[];
  warnings: { message: string; count: number }[];
  capabilityNotes: string[];
}

const log = (s = '') => process.stdout.write(s + '\n');

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.list) {
    for (const suite of opts.suites) {
      log(`\n${suite}`);
      for (const s of shotsFor(suite)) {
        const req = s.requires?.length ? `  requires ${s.requires.join(', ')}` : '';
        log(`  ${s.kind.padEnd(5)} ${s.name.padEnd(34)} ${s.label}${req}`);
      }
    }
    return 0;
  }

  let server: ServerHandle | null = null;
  let url = opts.url;
  const cleanup = async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      void cleanup().then(() => process.exit(130));
    });
  }

  const reports: SuiteReport[] = [];
  let failures = 0;

  try {
    if (!url) {
      server = await startServer({
        port: opts.port,
        mode: opts.serverMode,
        skipBuild: opts.skipBuild,
        log,
      });
      url = server.url;
    } else {
      log(`server: using ${url} as given`);
    }

    for (const suite of opts.suites) {
      const report = await runSuite(suite, url, opts);
      reports.push(report);
      failures += report.records.filter((r) => r.status === 'failed').length;
      if (opts.bail && failures > 0) break;
    }
  } finally {
    await cleanup();
  }

  if (reports.length > 1) writeRootIndex(opts.out, reports);

  log('');
  for (const r of reports) printSummary(r);
  return failures > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// One suite
// ---------------------------------------------------------------------------

async function runSuite(suite: SuiteName, url: string, opts: Options): Promise<SuiteReport> {
  const dir = path.join(opts.out, suite);
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  log(`\n── ${suite} ────────────────────────────────────────────`);
  const d = await Driver.launch({
    url,
    outDir: dir,
    suite,
    width: opts.width,
    height: opts.height,
    deviceScaleFactor: opts.deviceScaleFactor,
    reviewLongEdge: opts.reviewLongEdge,
    headless: opts.headless,
    verbose: opts.verbose,
    log,
  });

  const capabilityNotes: string[] = [];
  for (const [name, c] of Object.entries(d.capabilities())) {
    if (!c.usable) capabilityNotes.push(`__XQ.${name}() — ${c.why}`);
  }
  if (capabilityNotes.length) {
    log(`driver: ${capabilityNotes.length} of ${Object.keys(d.capabilities()).length} __XQ methods are not live yet`);
  }

  const records: Record_[] = [];
  const shots = shotsFor(suite).filter(
    (s) => opts.only.length === 0 || opts.only.some((o) => s.name.toLowerCase().includes(o)),
  );

  try {
    for (const shot of shots) {
      const t = Date.now();
      const missing = d.missing(shot.requires);
      if (missing.length > 0) {
        const reason = missing.map((m) => `${m}() — ${d.why(m as never)}`).join('; ');
        records.push(blank(shot, 'skipped', Date.now() - t, reason));
        log(`  skip  ${shot.name.padEnd(34)} ${reason}`);
        continue;
      }
      try {
        const rec = await runShot(d, shot, opts);
        rec.ms = Date.now() - t;
        records.push(rec);
        // A perf shot can come back over budget without throwing, so the line
        // reports the record's own status rather than assuming success.
        const tag = rec.status === 'ok' ? 'ok  ' : rec.status.toUpperCase().padEnd(4);
        log(
          `  ${tag}  ${shot.name.padEnd(34)} ${rec.dimensions}  ${human(rec.bytes)}  ${rec.ms} ms` +
            (rec.reason ? `  ${rec.reason}` : ''),
        );
        if (rec.status === 'failed' && opts.bail) break;
      } catch (err) {
        records.push(blank(shot, 'failed', Date.now() - t, firstLine(err)));
        log(`  FAIL  ${shot.name.padEnd(34)} ${firstLine(err)}`);
        log(indent(err instanceof Error ? (err.stack ?? err.message) : String(err)));
        if (opts.bail) break;
      }
    }
  } finally {
    // Anything the page reported after the last shot still matters.
    try {
      d.assertClean('teardown');
    } catch (err) {
      log(`  FAIL  ${'(after last shot)'.padEnd(34)} ${firstLine(err)}`);
      records.push({
        name: '__teardown',
        label: 'page errors after the last shot',
        kind: 'still',
        status: 'failed',
        ms: 0,
        image: null,
        review: null,
        bytes: 0,
        reviewBytes: 0,
        dimensions: '',
        stats: null,
        notes: [],
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    await d.close();
  }

  const report: SuiteReport = {
    suite,
    dir,
    url,
    startedAt,
    elapsedMs: Date.now() - t0,
    webgl: d.webgl.detail,
    viewport: `${opts.width}x${opts.height} @ ${opts.deviceScaleFactor}x (${opts.width * opts.deviceScaleFactor}x${opts.height * opts.deviceScaleFactor})`,
    records,
    warnings: d.warnings(),
    capabilityNotes,
  };
  writeSuiteIndex(report);
  return report;
}

function blank(shot: Shot, status: Status, ms: number, reason: string): Record_ {
  return {
    name: shot.name,
    label: shot.label,
    kind: shot.kind,
    status,
    ms,
    image: null,
    review: null,
    bytes: 0,
    reviewBytes: 0,
    dimensions: '',
    stats: null,
    notes: [],
    reason,
  };
}

// ---------------------------------------------------------------------------
// One shot
// ---------------------------------------------------------------------------

async function runShot(d: Driver, shot: Shot, opts: Options): Promise<Record_> {
  if (shot.kind === 'still') {
    await shot.setup(d);
    const r = await d.shoot(shot.name, {
      label: shot.label,
      expect: shot.expect,
      ...(shot.clip ? { clip: shot.clip } : {}),
    });
    return fromShot(shot, r);
  }
  if (shot.kind === 'sheet') return runSheet(d, shot, opts);
  // perf
  await shot.setup(d);
  const { samples, wallMs } = await d.sampleStats(shot.frames, shot.dt);
  const still = await d.shoot(shot.name, { label: shot.label, expect: shot.expect });
  const rec = fromShot(shot, still);
  const summary = summarisePerf(samples, wallMs);
  writeFileSync(
    path.join(d.outDir, `${shot.name}.json`),
    JSON.stringify({ shot: shot.name, frames: shot.frames, dt: shot.dt, summary, samples }, null, 2),
  );
  rec.detail = perfMarkdown(summary, shot.frames);
  rec.notes.push(
    `draw calls ${summary.drawCalls} / ${PERF_BUDGET.drawCalls}` +
      (summary.drawCalls > PERF_BUDGET.drawCalls ? ' — OVER BUDGET' : ''),
    `triangles ${summary.triangles.toLocaleString('en-US')} / ${PERF_BUDGET.triangles.toLocaleString('en-US')}` +
      (summary.triangles > PERF_BUDGET.triangles ? ' — OVER BUDGET' : ''),
  );
  if (summary.drawCalls > PERF_BUDGET.drawCalls || summary.triangles > PERF_BUDGET.triangles) {
    rec.status = 'failed';
    rec.reason = 'over the ARCHITECTURE.md draw-call / triangle budget';
  }
  return rec;
}

/**
 * Build a contact sheet. Cells are captured at CSS scale — a 1280x800 frame per
 * cell — because a sheet is a downscale by construction and a retina cell would
 * be four times the base64 traffic for detail the grid immediately throws away.
 * Individual frames are written at that same size when `keepFrames` is set, so
 * a critic who wants one beat gets a full-size frame rather than a crop of the
 * sheet.
 */
async function runSheet(d: Driver, shot: SheetShot, opts: Options): Promise<Record_> {
  if (shot.setup) await shot.setup(d);

  const cellSize = shot.cellClip
    ? { w: shot.cellClip.width, h: shot.cellClip.height }
    : { w: opts.width, h: opts.height };
  const sheetOpts = {
    title: shot.label,
    subtitle: shot.subtitle ?? '',
    count: shot.frames,
    cellAspect: cellSize.w / cellSize.h,
    ...(shot.cols ? { cols: shot.cols } : {}),
    maxLongEdge: 1600,
  };
  const layout = layoutSheet(sheetOpts);
  const session = await SheetSession.open(await d.compositor(), sheetOpts);

  const framesDir = path.join(d.outDir, 'frames', shot.name);
  if (shot.keepFrames) mkdirSync(framesDir, { recursive: true });

  const notes: string[] = [];
  let badCells = 0;
  for (let i = 0; i < shot.frames; i++) {
    const { label, caption } = await shot.sample(d, i, shot.frames);
    d.assertClean(`sheet "${shot.name}" cell ${i}`);
    const png = await d.captureFrame({
      scale: 'css',
      ...(shot.cellClip ? { clip: shot.cellClip } : {}),
    });
    let bad = false;
    try {
      const verdict = judgeFrame(analysePng(png), shot.expect);
      bad = !verdict.ok;
      if (bad) notes.push(`cell ${i}: ${verdict.failures.join('; ')}`);
    } catch {
      /* statistics are a bonus here; the sheet still gets built */
    }
    if (bad) badCells++;
    if (shot.keepFrames) writeFileSync(path.join(framesDir, `${String(i).padStart(2, '0')}.png`), png);
    await session.add(png, label, caption, bad);
  }
  if (shot.teardown) await shot.teardown(d);

  const result = await session.finish();
  const file = path.join(d.outDir, `${shot.name}.png`);
  writeFileSync(file, result.png);

  // A sheet is already inside the review budget, so it is its own review copy.
  const rec: Record_ = {
    name: shot.name,
    label: shot.label,
    kind: 'sheet',
    status: badCells === shot.frames ? 'failed' : 'ok',
    ms: 0,
    image: path.basename(file),
    review: path.basename(file),
    bytes: result.bytes,
    reviewBytes: result.bytes,
    dimensions: `${result.width}x${result.height} (${layout.cols}x${layout.rows} of ${layout.cellW}x${layout.cellH})`,
    stats: null,
    notes,
    reason: badCells === shot.frames ? `every one of the ${shot.frames} cells failed the frame check` : null,
  };
  if (badCells > 0 && badCells < shot.frames) {
    rec.notes.unshift(`${badCells} of ${shot.frames} cells failed the frame check (flagged in cinnabar on the sheet)`);
  }
  if (shot.keepFrames) rec.detail = `Individual frames: \`frames/${shot.name}/00.png\` … \`${String(shot.frames - 1).padStart(2, '0')}.png\``;
  if (rec.status === 'failed') throw new Error(rec.reason!);
  return rec;
}

function fromShot(shot: Shot, r: ShotResult): Record_ {
  return {
    name: shot.name,
    label: shot.label,
    kind: shot.kind,
    status: 'ok',
    ms: 0,
    image: r.relFile,
    review: r.relReviewFile,
    bytes: r.bytes,
    reviewBytes: r.reviewBytes,
    dimensions: `${r.width}x${r.height}`,
    stats: r.stats,
    notes: [...r.notes],
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// Perf
// ---------------------------------------------------------------------------

interface PerfSummary {
  frames: number;
  /** Real elapsed time per stepped frame, including rasterisation. */
  wallMsPerFrame: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  worstMs: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  quality: string;
  pixelRatio: number;
}

function summarisePerf(samples: XqFrameStats[], wallMs: number): PerfSummary {
  const ms = samples.map((s) => s.frameMs).sort((a, b) => a - b);
  const at = (q: number) => ms[Math.min(ms.length - 1, Math.max(0, Math.round(q * (ms.length - 1))))] ?? 0;
  const last = samples[samples.length - 1];
  return {
    frames: samples.length,
    wallMsPerFrame: wallMs / Math.max(1, samples.length),
    minMs: ms[0] ?? 0,
    meanMs: samples.reduce((a, s) => a + s.frameMs, 0) / Math.max(1, samples.length),
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: ms[ms.length - 1] ?? 0,
    worstMs: Math.max(...samples.map((s) => s.worstMs), 0),
    drawCalls: Math.max(...samples.map((s) => s.drawCalls), 0),
    triangles: Math.max(...samples.map((s) => s.triangles), 0),
    programs: last?.programs ?? 0,
    geometries: last?.geometries ?? 0,
    textures: last?.textures ?? 0,
    quality: last?.quality ?? '',
    pixelRatio: last?.pixelRatio ?? 0,
  };
}

function perfMarkdown(s: PerfSummary, frames: number): string {
  const flag = (v: number, budget: number) => (v > budget ? ` **over ${budget}**` : ` (budget ${budget})`);
  return [
    '',
    `| measure | value |`,
    `|---|---|`,
    `| frames sampled | ${frames} |`,
    `| draw calls (max) | ${s.drawCalls}${flag(s.drawCalls, PERF_BUDGET.drawCalls)} |`,
    `| triangles (max) | ${s.triangles.toLocaleString('en-US')}${flag(s.triangles, PERF_BUDGET.triangles)} |`,
    `| programs / geometries / textures | ${s.programs} / ${s.geometries} / ${s.textures} |`,
    `| quality tier · pixel ratio | ${s.quality} · ${s.pixelRatio} |`,
    `| \`stats().frameMs\` — min / p50 / mean / p95 / max | ${s.minMs.toFixed(2)} / ${s.p50Ms.toFixed(2)} / ${s.meanMs.toFixed(2)} / ${s.p95Ms.toFixed(2)} / ${s.maxMs.toFixed(2)} |`,
    `| \`stats().worstMs\` since reset | ${s.worstMs.toFixed(2)} |`,
    `| **wall clock per frame** | **${s.wallMsPerFrame.toFixed(1)} ms** |`,
    '',
    '> Two different numbers, and the difference is the point. `stats().frameMs` is',
    '> measured around `renderer.render()`, which on WebGL only *submits* work — the',
    '> call returns long before any pixel exists. **Wall clock per frame** is the real',
    '> elapsed time for a stepped frame, rasterisation included.',
    '>',
    '> Neither is a verdict against the 16.6 ms budget here: this ran on',
    '> ANGLE/SwiftShader, a software rasteriser, and the budget is written for a GPU.',
    '> Both are regression signals against previous runs on the same machine.',
    '> Draw calls and triangle counts *are* meaningful — three.js counts them on the',
    '> CPU and they do not depend on the rasteriser.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function writeSuiteIndex(r: SuiteReport): void {
  const ok = r.records.filter((x) => x.status === 'ok');
  const skipped = r.records.filter((x) => x.status === 'skipped');
  const failed = r.records.filter((x) => x.status === 'failed');

  const md: string[] = [];
  md.push(`# captures / ${r.suite}`);
  md.push('');
  md.push(`${ok.length} captured · ${skipped.length} skipped · ${failed.length} failed · ${(r.elapsedMs / 1000).toFixed(1)} s`);
  md.push('');
  md.push(`- **run** ${r.startedAt}`);
  md.push(`- **url** ${r.url}`);
  md.push(`- **viewport** ${r.viewport}`);
  md.push(`- **gl** ${r.webgl}`);
  md.push('');
  md.push('Open the file in the **review** column: those are downscaled to a 1600 px long edge');
  md.push('and are what the critics read. The sibling PNG at full retina resolution is there for');
  md.push('pixel-level questions.');
  md.push('');

  md.push('| shot | status | review copy | size | frame statistics |');
  md.push('|---|---|---|---|---|');
  for (const x of r.records) {
    const review = x.review ? `\`${x.review}\`` : '—';
    // Sheets are judged cell by cell rather than as one image, so their row
    // carries the grid shape instead of whole-image statistics.
    const stat = x.stats ? describeStats(x.stats) : (x.reason ?? x.dimensions);
    md.push(`| \`${x.name}\` | ${x.status} | ${review} | ${x.bytes ? human(x.bytes) : '—'} | ${stat} |`);
  }
  md.push('');

  if (failed.length) {
    md.push('## Failures');
    md.push('');
    for (const x of failed) md.push(`- **${x.name}** — ${x.reason}`);
    md.push('');
  }
  if (skipped.length) {
    md.push('## Skipped');
    md.push('');
    md.push('These shots need parts of `window.__XQ` that this build does not implement yet.');
    md.push('They were not captured, because a picture of an empty board is not evidence.');
    md.push('');
    for (const x of skipped) md.push(`- **${x.name}** — ${x.reason}`);
    md.push('');
  }
  if (r.capabilityNotes.length) {
    md.push('## Test API surface not yet live');
    md.push('');
    for (const n of r.capabilityNotes) md.push(`- ${n}`);
    md.push('');
  }
  if (r.warnings.length) {
    md.push('## Warnings');
    md.push('');
    for (const w of r.warnings) md.push(`- ${w.message} (${w.count}x)`);
    md.push('');
  }

  md.push('## Shots');
  md.push('');
  for (const x of r.records) {
    md.push(`### ${x.name}`);
    md.push('');
    md.push(x.label);
    md.push('');
    if (x.status !== 'ok') {
      md.push(`*${x.status}* — ${x.reason}`);
      md.push('');
      continue;
    }
    md.push(
      `\`${x.image}\` · ${x.dimensions} · ${human(x.bytes)}` +
        (x.review && x.review !== x.image ? ` · review \`${x.review}\` ${human(x.reviewBytes)}` : ''),
    );
    md.push('');
    if (x.stats) {
      md.push(
        `dominant ${x.stats.dominantHex} at ${pct(x.stats.dominantFraction)} · ` +
          `${x.stats.uniqueBuckets} distinct colours · ` +
          `luma ${x.stats.meanLuma.toFixed(3)} ± ${x.stats.stdLuma.toFixed(3)} · ` +
          `ink ${pct(x.stats.darkFraction)} · paper ${pct(x.stats.lightFraction)}`,
      );
      md.push('');
    }
    for (const n of x.notes) md.push(`- ${n}`);
    if (x.notes.length) md.push('');
    if (x.detail) md.push(x.detail);
    if (x.review) {
      md.push(`![${x.name}](${x.review.split(path.sep).join('/')})`);
      md.push('');
    }
  }

  writeFileSync(path.join(r.dir, 'index.md'), md.join('\n'));
}

function writeRootIndex(out: string, reports: SuiteReport[]): void {
  const md: string[] = ['# captures', ''];
  md.push(`Run ${reports[0]?.startedAt ?? ''} · ${reports[0]?.webgl ?? ''}`);
  md.push('');
  md.push('| suite | captured | skipped | failed | index |');
  md.push('|---|---|---|---|---|');
  for (const r of reports) {
    const c = r.records.filter((x) => x.status === 'ok').length;
    const s = r.records.filter((x) => x.status === 'skipped').length;
    const f = r.records.filter((x) => x.status === 'failed').length;
    md.push(`| ${r.suite} | ${c} | ${s} | ${f} | [\`${r.suite}/index.md\`](${r.suite}/index.md) |`);
  }
  md.push('');
  writeFileSync(path.join(out, 'index.md'), md.join('\n'));
}

function printSummary(r: SuiteReport): void {
  const rows = r.records.map((x) => [
    x.name,
    x.kind,
    x.status,
    x.dimensions,
    x.bytes ? human(x.bytes) : '—',
    x.stats ? `${pct(x.stats.dominantFraction)} ${x.stats.dominantHex}` : '',
    `${x.ms} ms`,
  ]);
  const head = ['shot', 'kind', 'status', 'size', 'bytes', 'dominant', 'time'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ');

  const ok = r.records.filter((x) => x.status === 'ok').length;
  const skipped = r.records.filter((x) => x.status === 'skipped').length;
  const failed = r.records.filter((x) => x.status === 'failed').length;

  log(`\n${r.suite} — ${ok} captured, ${skipped} skipped, ${failed} failed, ${(r.elapsedMs / 1000).toFixed(1)} s`);
  log(line(head));
  log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) log(line(row));
  if (r.warnings.length) {
    log('');
    for (const w of r.warnings) log(`  warn ${w.message}${w.count > 1 ? ` (${w.count}x)` : ''}`);
  }
  log(`\n  index: ${path.join(r.dir, 'index.md')}`);
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => '        ' + l)
    .join('\n');
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`\ncapture run aborted: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
