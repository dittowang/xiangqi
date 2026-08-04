/**
 * The page driver: a browser, a page, a typed wrapper over `window.__XQ`, and
 * the one function that writes a PNG to disk.
 *
 * Three things here are load-bearing and worth stating plainly.
 *
 * **Software GL.** This runs on headless Linux with no GPU. Chromium is
 * launched with the ANGLE/SwiftShader flag set so WebGL2 initialises against a
 * software rasteriser, and `verifyWebGL()` reads the context back and refuses to
 * continue if it did not. A harness that quietly captures a WebGL-less page
 * produces a folder of black PNGs and a green summary, which is worse than no
 * harness at all.
 *
 * **The boot veil.** `index.html` covers the page with an opaque `#veil` that
 * fades out over 900 ms once the first frame composites. Screenshotting during
 * that fade yields a black or muddy frame. The driver removes the veil outright
 * after `ready()` instead of waiting on a wall-clock transition it does not own.
 *
 * **Review copies.** Every shot is written twice: once at full retina
 * resolution, and once downscaled so its long edge is <= 1600 px. The downscale
 * is a resample of *the very same PNG*, performed by `drawImage` in a scratch
 * page, not a second render at a different device pixel ratio. That distinction
 * matters: screen-space line work (the inverted hull, the Sobel pass) changes
 * thickness with the pixel ratio, so a re-render at DPR 1.25 would show the
 * critic a picture the game never actually drew. See `resample()`.
 */

import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { CameraPose, QualityTier } from '@core/contracts.ts';
import type { DebugFlag, NamedPose, XqFrameStats, XqTestApi } from '@core/testapi.ts';
import { START_FEN } from '@core/testapi.ts';
import { Side } from '@core/types.ts';
import {
  analysePng,
  describeStats,
  judgeFrame,
  type FramePolicy,
  type FrameStats,
  type FrameVerdict,
} from './png.ts';

// ---------------------------------------------------------------------------
// Chromium launch
// ---------------------------------------------------------------------------

/**
 * Software-GL flags. The exact spelling matters more than it looks:
 * `--use-angle=swiftshader` selects ANGLE's software backend, and
 * `--enable-unsafe-swiftshader` is what stops Chromium refusing WebGL outright
 * now that the silent software fallback is deprecated. We deliberately do *not*
 * pass `--enable-features=Vulkan`; ANGLE already reaches SwiftShader through
 * its own Vulkan backend, and forcing the feature flag destabilises it.
 *
 * `--force-color-profile=srgb` is not about GL at all — it stops the compositor
 * applying a display profile to the screenshot, which is what makes two
 * captures of the same frame byte-comparable.
 */
export const SOFTWARE_GL_ARGS: readonly string[] = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--disable-gpu-sandbox',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

/**
 * `@playwright/test` 1.62 expects chromium revision 1234; this image ships 1194
 * under `PLAYWRIGHT_BROWSERS_PATH`. Running `playwright install` is forbidden,
 * so resolve the binary that is actually on disk and hand it to `launch()`.
 * Returns undefined when nothing is found, leaving Playwright's own resolution
 * to try (and to produce its own, clearer, error).
 */
export function resolveChromiumExecutable(): string | undefined {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base) return undefined;
  const candidates: string[] = [];
  const direct = path.join(base, 'chromium');
  if (isFile(direct)) candidates.push(direct); // this image symlinks it straight at the binary
  let entries: string[] = [];
  try {
    entries = readdirSync(base);
  } catch {
    return candidates[0];
  }
  // Highest revision first, so a machine with several installs picks the newest.
  const revs = entries
    .filter((e) => /^chromium(_headless_shell)?-\d+$/.test(e))
    .sort((a, b) => revisionOf(b) - revisionOf(a));
  for (const dir of revs) {
    for (const rel of [
      'chrome-linux/chrome',
      'chrome-linux/headless_shell',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    ]) {
      const p = path.join(base, dir, rel);
      if (isFile(p)) candidates.push(p);
    }
  }
  return candidates[0];
}

function revisionOf(name: string): number {
  const m = /(\d+)$/.exec(name);
  return m ? Number(m[1]) : 0;
}
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type XqMethod = keyof XqTestApi;

export interface Capability {
  present: boolean;
  /** The function body is empty — the bootstrap's `async () => {}` placeholder. */
  sourceStub: boolean;
  /** Present and non-empty, but a behavioural probe showed it changes nothing. */
  inert: boolean;
  /** Safe to build a shot around. */
  usable: boolean;
  why: string;
}

export type Capabilities = Record<string, Capability>;

export interface WebGLReport {
  ok: boolean;
  version: string;
  vendor: string;
  renderer: string;
  webgl2: boolean;
  maxTextureSize: number;
  maxDrawBuffers: number;
  colorBufferFloat: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface DriverOptions {
  url: string;
  /** Where PNGs land. Usually `captures/<suite>`. */
  outDir: string;
  suite?: string;
  width?: number;
  height?: number;
  /** Retina by default: the full capture is width*dsf x height*dsf. */
  deviceScaleFactor?: number;
  /** Long edge of the review copy, px. Default 1600. */
  reviewLongEdge?: number;
  headless?: boolean;
  /** Navigation / ready() budget, ms. Default 60000. */
  timeoutMs?: number;
  /** Run the behavioural capability probes at launch. Default true. */
  probe?: boolean;
  log?: (line: string) => void;
  verbose?: boolean;
}

export interface CaptureOptions {
  /** Human label, shown beside the image in index.md. */
  label?: string;
  /** Blank-frame policy for this shot. */
  expect?: FramePolicy;
  /** 'device' = full retina (default). 'css' = one image pixel per CSS pixel. */
  scale?: 'device' | 'css';
  /** Region to capture, in CSS pixels. */
  clip?: { x: number; y: number; width: number; height: number };
  /** Write the downscaled review copy. Default true. */
  review?: boolean;
  /** Subdirectory under outDir. */
  dir?: string;
  /** Downgrade a blank-frame verdict to a note instead of an error. */
  warnOnly?: boolean;
}

export interface ShotResult {
  name: string;
  label: string;
  file: string;
  relFile: string;
  reviewFile: string | null;
  relReviewFile: string | null;
  bytes: number;
  reviewBytes: number;
  width: number;
  height: number;
  stats: FrameStats | null;
  verdict: FrameVerdict;
  notes: string[];
}

export class PageErrorsDetected extends Error {
  override name = 'PageErrorsDetected';
}
export class BlankFrameDetected extends Error {
  override name = 'BlankFrameDetected';
}

/** Console noise that is never worth failing a capture run over. */
const BENIGN_CONSOLE = [
  /favicon\.ico/i,
  /GroupMarkerNotSet/,
  /Automatic fallback to software WebGL has been deprecated/i,
  /\[\.WebGL-/, // Chromium's own driver chatter
];

export class Driver {
  readonly page: Page;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly outDir: string;
  readonly suite: string;
  readonly viewport: { width: number; height: number; deviceScaleFactor: number };
  readonly webgl: WebGLReport;

  private caps: Capabilities = {};
  private readonly errors: string[];
  private readonly warnCounts = new Map<string, number>();
  private compositorContext: BrowserContext | null = null;
  private compositorPage: Page | null = null;
  private readonly reviewLongEdge: number;
  private readonly log: (line: string) => void;

  private constructor(init: {
    page: Page;
    browser: Browser;
    context: BrowserContext;
    outDir: string;
    suite: string;
    viewport: { width: number; height: number; deviceScaleFactor: number };
    webgl: WebGLReport;
    reviewLongEdge: number;
    errors: string[];
    log: (line: string) => void;
  }) {
    this.page = init.page;
    this.browser = init.browser;
    this.context = init.context;
    this.outDir = init.outDir;
    this.suite = init.suite;
    this.viewport = init.viewport;
    this.webgl = init.webgl;
    this.reviewLongEdge = init.reviewLongEdge;
    this.errors = init.errors;
    this.log = init.log;
  }

  // -- lifecycle ------------------------------------------------------------

  static async launch(opts: DriverOptions): Promise<Driver> {
    const log = opts.log ?? (() => {});
    const width = opts.width ?? 1280;
    const height = opts.height ?? 800;
    const deviceScaleFactor = opts.deviceScaleFactor ?? 2;
    const timeoutMs = opts.timeoutMs ?? 60_000;

    const browser = await launchChromium(opts.headless !== false, log);

    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor,
      colorScheme: 'dark',
      // The scene is deterministic; anything the browser animates on its own
      // (CSS transitions, the boot veil) is noise we do not want in a frame.
      reducedMotion: 'reduce',
    });
    await installKeepNamesShim(context);
    const page = await context.newPage();

    // One array, owned from here on by the Driver, so nothing that fires after
    // construction lands somewhere nobody reads.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? '(no stack)'}`));
    page.on('crash', () => errors.push('pageerror: the page crashed (renderer process gone)'));
    page.on('console', (m: ConsoleMessage) => {
      const text = m.text();
      const loc = m.location();
      // Match the source URL as well as the text: a failed favicon request is
      // reported as a generic "Failed to load resource: … 404" whose only clue
      // is the location, and the browser asks for /favicon.ico unprompted on
      // every navigation.
      if (BENIGN_CONSOLE.some((re) => re.test(text) || re.test(loc.url))) return;
      if (m.type() === 'error') {
        errors.push(`console.error: ${text}\n    at ${loc.url}:${loc.lineNumber}:${loc.columnNumber}`);
      } else if (opts.verbose) {
        log(`  page ${m.type()}: ${text}`);
      }
    });

    await page.goto(opts.url, { waitUntil: 'load', timeout: timeoutMs });
    await page.evaluate(KEEP_NAMES_SHIM);

    const webgl = await verifyWebGL(page);
    log(`driver: ${webgl.detail}`);
    if (!webgl.ok) {
      await browser.close();
      throw new Error(
        `WebGL did not initialise in this browser — every capture would be a blank frame.\n` +
          `  ${webgl.detail}\n` +
          `  Launched with: ${SOFTWARE_GL_ARGS.join(' ')}`,
      );
    }
    if (!webgl.webgl2) {
      log('driver: WARNING — the context is WebGL1. The render pipeline needs WebGL2 (MRT prepass).');
    }

    // __XQ is installed at the end of main.ts's module evaluation, which can be
    // a tick or two after `load` on a cold start.
    await page.waitForFunction(() => typeof (window as Window).__XQ !== 'undefined', undefined, {
      timeout: timeoutMs,
    });
    await page.evaluate(async (ms) => {
      await Promise.race([
        window.__XQ!.ready(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`__XQ.ready() never resolved (${ms} ms)`)), ms),
        ),
      ]);
    }, timeoutMs);

    // Kill the boot veil. It is a DOM overlay with a 900 ms opacity transition;
    // waiting it out would be a fixed sleep, and screenshotting through it is
    // the classic "why is my capture black" bug.
    await page.evaluate(() => {
      const v = document.getElementById('veil');
      if (v) {
        v.style.transition = 'none';
        v.style.opacity = '0';
        v.style.display = 'none';
      }
    });

    const d = new Driver({
      page,
      browser,
      context,
      outDir: opts.outDir,
      suite: opts.suite ?? path.basename(opts.outDir),
      viewport: { width, height, deviceScaleFactor },
      webgl,
      reviewLongEdge: opts.reviewLongEdge ?? 1600,
      errors,
      log,
    });

    mkdirSync(opts.outDir, { recursive: true });
    await d.pause(); // deterministic clock from here on
    await d.step(0); // one composited frame, so the first screenshot is real
    d.caps = await d.probeCapabilities(opts.probe !== false);
    return d;
  }

  async close(): Promise<void> {
    if (this.compositorContext) await this.compositorContext.close().catch(() => {});
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }

  // -- diagnostics ----------------------------------------------------------

  capabilities(): Capabilities {
    return this.caps;
  }
  can(name: XqMethod): boolean {
    return this.caps[name]?.usable ?? false;
  }
  /** Which of `names` this build cannot honour. Drives per-shot skipping. */
  missing(names: readonly XqMethod[] | undefined): string[] {
    return (names ?? []).filter((n) => !this.can(n));
  }
  why(name: XqMethod): string {
    return this.caps[name]?.why ?? 'unknown';
  }
  warnings(): { message: string; count: number }[] {
    return [...this.warnCounts].map(([message, count]) => ({ message, count }));
  }
  warn(message: string): void {
    const n = this.warnCounts.get(message) ?? 0;
    this.warnCounts.set(message, n + 1);
    if (n === 0) this.log(`  warn: ${message}`);
  }

  /** Throws with the full stack if the page reported anything since the last check. */
  assertClean(context: string): void {
    if (this.errors.length === 0) return;
    const all = this.errors.splice(0, this.errors.length);
    throw new PageErrorsDetected(
      `page reported ${all.length} error(s) during ${context}:\n\n${all.join('\n\n')}`,
    );
  }
  pendingErrors(): string[] {
    return [...this.errors];
  }

  // -- typed __XQ wrappers --------------------------------------------------
  //
  // Each wrapper checks the capability table first. A method that is *absent*
  // is never called (it would throw); a method that is a *stub* is called
  // anyway — it is a no-op, and calling it keeps the code path identical for
  // the day the real implementation lands. Either way the first touch records
  // a warning, which the CLI prints and index.md carries.

  private note(name: XqMethod): boolean {
    const c = this.caps[name];
    if (!c) return true; // probe never ran (probe:false) — assume live
    if (!c.present) {
      this.warn(`__XQ.${name}() is missing from this build`);
      return false;
    }
    if (!c.usable) this.warn(`__XQ.${name}() is not live in this build — ${c.why}`);
    return true;
  }

  // clock
  async pause(): Promise<void> {
    if (this.note('pause')) await this.page.evaluate(() => window.__XQ!.pause());
  }
  async resume(): Promise<void> {
    if (this.note('resume')) await this.page.evaluate(() => window.__XQ!.resume());
  }
  /** Advance the simulation by `seconds` and render one frame. `0` just renders. */
  async step(seconds: number): Promise<void> {
    await this.page.evaluate((s) => window.__XQ!.step(s), seconds);
  }
  async stepFrames(frames: number, seconds = 1 / 60): Promise<void> {
    await this.page.evaluate((a) => window.__XQ!.stepFrames(a.frames, a.seconds), { frames, seconds });
  }
  async settle(maxSeconds = 4): Promise<void> {
    await this.page.evaluate((s) => window.__XQ!.settle(s), maxSeconds);
  }

  // position
  async setPosition(fen: string): Promise<boolean> {
    if (!this.note('setPosition') || !this.can('setPosition')) return false;
    await this.page.evaluate((f) => window.__XQ!.setPosition(f), fen);
    return true;
  }
  async getPosition(): Promise<string> {
    if (!this.note('getPosition')) return '';
    return this.page.evaluate(() => window.__XQ!.getPosition());
  }
  async playMove(from: number, to: number): Promise<boolean> {
    if (!this.note('playMove') || !this.can('playMove')) return false;
    await this.page.evaluate((m) => window.__XQ!.playMove(m.from, m.to), { from, to });
    return true;
  }
  async forceMove(from: number, to: number): Promise<boolean> {
    if (!this.note('forceMove') || !this.can('forceMove')) return false;
    await this.page.evaluate((m) => window.__XQ!.forceMove(m.from, m.to), { from, to });
    return true;
  }
  async legalMoves(from?: number): Promise<number[]> {
    if (!this.note('legalMoves')) return [];
    return this.page.evaluate(
      (f) => [...window.__XQ!.legalMoves(f < 0 ? undefined : f)],
      from ?? -1,
    );
  }
  async setDifficulty(d: 'easy' | 'medium' | 'hard'): Promise<void> {
    if (this.note('setDifficulty')) await this.page.evaluate((v) => window.__XQ!.setDifficulty(v), d);
  }
  async setHumanSide(s: Side): Promise<void> {
    if (this.note('setHumanSide')) {
      await this.page.evaluate((v) => window.__XQ!.setHumanSide(v as Side), s as number);
    }
  }

  // choreography
  async seekCapture(from: number, to: number, t: number): Promise<boolean> {
    if (!this.note('seekCapture') || !this.can('seekCapture')) return false;
    await this.page.evaluate((a) => window.__XQ!.seekCapture(a.from, a.to, a.t), { from, to, t });
    return true;
  }
  async seekFormation(t: number): Promise<boolean> {
    if (!this.note('seekFormation') || !this.can('seekFormation')) return false;
    await this.page.evaluate((v) => window.__XQ!.seekFormation(v), t);
    return true;
  }
  async seekUnitState(
    side: Side,
    unit: string,
    state: string,
    t: number,
    opts: { isolate?: boolean } = {},
  ): Promise<boolean> {
    if (!this.note('seekUnitState') || !this.can('seekUnitState')) return false;
    await this.page.evaluate((a) => window.__XQ!.seekUnitState(a.side as Side, a.unit, a.state, a.t, a.opts), {
      side: side as number,
      unit,
      state,
      t,
      opts,
    });
    return true;
  }

  // presentation
  async setPose(pose: Partial<CameraPose>, immediate = true): Promise<void> {
    if (this.note('setPose')) {
      await this.page.evaluate((a) => window.__XQ!.setPose(a.pose, a.immediate), { pose, immediate });
    }
  }
  async getPose(): Promise<CameraPose | null> {
    if (!this.note('getPose')) return null;
    return this.page.evaluate(() => window.__XQ!.getPose());
  }
  async setNamedPose(name: NamedPose, immediate = true): Promise<void> {
    if (this.note('setNamedPose')) {
      await this.page.evaluate((a) => window.__XQ!.setNamedPose(a.name, a.immediate), { name, immediate });
    }
  }
  async setSilhouette(on: boolean): Promise<boolean> {
    if (!this.note('setSilhouette')) return false;
    await this.page.evaluate((v) => window.__XQ!.setSilhouette(v), on);
    return this.can('setSilhouette');
  }
  async setHudVisible(on: boolean): Promise<void> {
    if (this.note('setHudVisible')) await this.page.evaluate((v) => window.__XQ!.setHudVisible(v), on);
  }
  async setQuality(tier: QualityTier | 'auto'): Promise<void> {
    if (this.note('setQuality')) await this.page.evaluate((v) => window.__XQ!.setQuality(v), tier);
  }
  async showcase(side: Side, unit: string, opts: { state?: string; turntable?: number } = {}): Promise<boolean> {
    if (!this.note('showcase') || !this.can('showcase')) return false;
    await this.page.evaluate((a) => window.__XQ!.showcase(a.side as Side, a.unit, a.opts), {
      side: side as number,
      unit,
      opts,
    });
    return true;
  }
  async exitShowcase(): Promise<void> {
    if (this.can('showcase')) await this.page.evaluate(() => window.__XQ!.exitShowcase());
  }
  async setDebug(flag: DebugFlag, on: boolean): Promise<void> {
    if (this.note('setDebug')) {
      await this.page.evaluate((a) => window.__XQ!.setDebug(a.flag, a.on), { flag, on });
    }
  }

  // measurement
  async stats(): Promise<XqFrameStats> {
    return this.page.evaluate(() => window.__XQ!.stats());
  }
  async resetStats(): Promise<void> {
    await this.page.evaluate(() => window.__XQ!.resetStats());
  }
  async describe(): Promise<ReturnType<XqTestApi['describe']>> {
    return this.page.evaluate(() => window.__XQ!.describe());
  }

  /**
   * Advance the paused clock `frames` times, reading `stats()` after each step,
   * all inside a single page evaluation. Running the loop in the page rather
   * than over the CDP wire keeps protocol latency out of the numbers.
   *
   * `wallMs` is the elapsed real time for the whole loop, and it matters more
   * than it looks. `XqFrameStats.frameMs` is measured around
   * `renderer.render()`, which on WebGL only submits work — the driver returns
   * long before the pixels exist. On a software rasteriser the gap between the
   * two is two orders of magnitude, and reporting only `frameMs` would say
   * "0.3 ms per frame" about a loop that is really taking 300. Measuring the
   * clock here is fine: this is the harness observing, not an update path.
   */
  async sampleStats(frames: number, dt: number): Promise<{ samples: XqFrameStats[]; wallMs: number }> {
    return this.page.evaluate(
      async (a) => {
        const api = window.__XQ!;
        const out: XqFrameStats[] = [];
        api.resetStats();
        const t0 = performance.now();
        for (let i = 0; i < a.frames; i++) {
          await api.step(a.dt);
          out.push(api.stats());
        }
        return { samples: out, wallMs: performance.now() - t0 };
      },
      { frames, dt },
    );
  }

  // -- capture --------------------------------------------------------------

  /** Screenshot without touching the disk. Used to build contact-sheet cells. */
  async captureFrame(opts: CaptureOptions = {}): Promise<Buffer> {
    await this.step(0); // render + two rAFs, so the compositor holds this frame
    return this.page.screenshot({
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      scale: opts.scale ?? 'device',
      ...(opts.clip ? { clip: opts.clip } : {}),
    });
  }

  /**
   * Capture, write `<outDir>/<name>.png` at full retina resolution and
   * `<outDir>/review/<name>.png` downscaled for a critic to read, then judge the
   * bytes that landed. Throws on a page error or a blank frame.
   */
  async shoot(name: string, opts: CaptureOptions = {}): Promise<ShotResult> {
    this.assertClean(`setup for "${name}"`);
    const png = await this.captureFrame(opts);
    this.assertClean(`capture of "${name}"`);

    const dir = opts.dir ? path.join(this.outDir, opts.dir) : this.outDir;
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    writeFileSync(file, png);

    const notes: string[] = [];
    let stats: FrameStats | null = null;
    let verdict: FrameVerdict = { ok: true, failures: [] };
    try {
      stats = analysePng(png);
      verdict = judgeFrame(stats, opts.expect);
    } catch (err) {
      notes.push(`frame statistics unavailable: ${firstLine(err)}`);
    }

    let reviewFile: string | null = null;
    let reviewBytes = 0;
    if (opts.review !== false) {
      const reviewDir = path.join(dir, 'review');
      mkdirSync(reviewDir, { recursive: true });
      reviewFile = path.join(reviewDir, `${name}.png`);
      const small = await this.resample(png, this.reviewLongEdge, notes, opts);
      writeFileSync(reviewFile, small);
      reviewBytes = small.length;
    }

    if (!verdict.ok && !opts.warnOnly) {
      throw new BlankFrameDetected(
        `"${name}" failed the frame check — ${verdict.failures.join('; ')}\n` +
          `  wrote ${file} (${png.length} bytes)\n` +
          `  ${stats ? describeStats(stats) : ''}`,
      );
    }
    if (!verdict.ok) notes.push(...verdict.failures);

    return {
      name,
      label: opts.label ?? name,
      file,
      relFile: path.relative(this.outDir, file),
      reviewFile,
      relReviewFile: reviewFile ? path.relative(this.outDir, reviewFile) : null,
      bytes: png.length,
      reviewBytes,
      width: stats?.width ?? 0,
      height: stats?.height ?? 0,
      stats,
      verdict,
      notes,
    };
  }

  /**
   * Downscale a PNG so its long edge is at most `longEdge`.
   *
   * The work happens in a scratch `about:blank` page in a *separate browser
   * context* — sharing a context with the game page risks the compositor
   * treating one of them as occluded and throttling its rAF, which would stall
   * `step()`. Halving repeatedly before the final draw keeps a >2x reduction
   * from aliasing: `drawImage` samples the source roughly once per destination
   * pixel, so a single 4:1 draw discards three quarters of the detail the
   * critic is being asked to judge.
   *
   * If anything in that path fails we fall back to a second screenshot at CSS
   * scale — a compositor-side 2:1 downscale of the same frame. Lower resolution
   * than we would like, but never a lie.
   */
  private async resample(
    png: Buffer,
    longEdge: number,
    notes: string[],
    opts: CaptureOptions,
  ): Promise<Buffer> {
    try {
      const page = await this.compositor();
      const dataUri = 'data:image/png;base64,' + png.toString('base64');
      const out = await page.evaluate(
        async (a) => {
          const img = new Image();
          img.src = a.dataUri;
          await img.decode();
          let w = img.naturalWidth;
          let h = img.naturalHeight;
          const scale = Math.min(1, a.longEdge / Math.max(w, h));
          const tw = Math.max(1, Math.round(w * scale));
          const th = Math.max(1, Math.round(h * scale));

          let src: CanvasImageSource = img;
          while (w > tw * 2 && h > th * 2) {
            const hw = Math.max(tw, w >> 1);
            const hh = Math.max(th, h >> 1);
            const c = document.createElement('canvas');
            c.width = hw;
            c.height = hh;
            const g = c.getContext('2d')!;
            g.imageSmoothingEnabled = true;
            g.imageSmoothingQuality = 'high';
            g.drawImage(src, 0, 0, hw, hh);
            src = c;
            w = hw;
            h = hh;
          }
          const dst = document.createElement('canvas');
          dst.width = tw;
          dst.height = th;
          const g = dst.getContext('2d')!;
          g.imageSmoothingEnabled = true;
          g.imageSmoothingQuality = 'high';
          g.drawImage(src, 0, 0, tw, th);
          return dst.toDataURL('image/png');
        },
        { dataUri, longEdge },
      );
      return Buffer.from(out.slice(out.indexOf(',') + 1), 'base64');
    } catch (err) {
      notes.push(`review copy fell back to a CSS-scale screenshot: ${firstLine(err)}`);
      return this.page.screenshot({
        type: 'png',
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        ...(opts.clip ? { clip: opts.clip } : {}),
      });
    }
  }

  /** The scratch page used for downscales and contact-sheet composition. */
  async compositor(): Promise<Page> {
    if (this.compositorPage) return this.compositorPage;
    this.compositorContext = await this.browser.newContext({ viewport: { width: 64, height: 64 } });
    await installKeepNamesShim(this.compositorContext);
    this.compositorPage = await this.compositorContext.newPage();
    await this.compositorPage.goto('about:blank');
    await this.compositorPage.evaluate(KEEP_NAMES_SHIM);
    this.compositorPage.on('pageerror', (e) =>
      this.errors.push(`compositor pageerror: ${e.message}\n${e.stack ?? ''}`),
    );
    return this.compositorPage;
  }

  // -- probes ---------------------------------------------------------------

  private async probeCapabilities(behavioural: boolean): Promise<Capabilities> {
    const raw = await this.page.evaluate(() => {
      const api = window.__XQ as unknown as Record<string, unknown>;
      const out: Record<string, { present: boolean; sourceStub: boolean }> = {};
      /**
       * A stub in this codebase is literally `() => {}` / `async () => {}`.
       * Stripping whitespace and matching an empty body catches it both in the
       * dev server's original text and in esbuild's minified `async()=>{}`.
       * Anything that does not match is assumed real — the heuristic can only
       * produce false *negatives*, which the behavioural probes below catch.
       */
      const isEmptyBody = (fn: unknown): boolean => {
        if (typeof fn !== 'function') return false;
        const s = Function.prototype.toString.call(fn).replace(/\s+/g, '');
        return (
          /^(async)?\(?[^)]*\)?=>\{\}$/.test(s) || /^(async)?function[^(]*\([^)]*\)\{\}$/.test(s)
        );
      };
      for (const k of Object.keys(api)) {
        out[k] = { present: typeof api[k] === 'function', sourceStub: isEmptyBody(api[k]) };
      }
      return out;
    });

    const caps: Capabilities = {};
    for (const [name, c] of Object.entries(raw)) {
      caps[name] = {
        present: c.present,
        sourceStub: c.sourceStub,
        inert: false,
        usable: c.present && !c.sourceStub,
        why: !c.present ? 'not defined on window.__XQ' : c.sourceStub ? 'empty function body' : 'live',
      };
    }
    const mark = (name: string, why: string) => {
      const c = caps[name];
      if (!c || !c.usable) return;
      c.inert = true;
      c.usable = false;
      c.why = why;
    };
    if (!behavioural) return caps;
    this.caps = caps; // the probes below go through the wrappers

    // 1. Does the build have a board at all? Everything position-shaped depends
    //    on describe() reporting pieces.
    let boardLive = false;
    try {
      const d = await this.describe();
      boardLive = Array.isArray(d?.pieces) && d.pieces.length > 0;
    } catch {
      boardLive = false;
    }
    if (!boardLive) {
      // Only the *position-shaped* surface. `showcase()` and `seekUnitState()`
      // put one unit on an empty board and are expected to work as soon as the
      // characters and anim subsystems land, which may well be before the
      // engine can hold a position — marking them dead here would silently skip
      // the entire units suite on the day it first becomes capturable.
      const why = 'describe() reports no pieces — the position subsystem is not live yet';
      for (const n of ['setPosition', 'getPosition', 'playMove', 'forceMove', 'legalMoves', 'seekCapture', 'seekFormation']) {
        mark(n, why);
      }
    }

    // 2. Round-trip a FEN. A getPosition() that always returns the start
    //    position is a stub the source scan cannot see.
    if (boardLive && caps.setPosition?.usable) {
      try {
        // Legal, ongoing, and unmistakably not the opening position: the
        // generals sit on different files (no flying-general violation) and a
        // red chariot keeps it out of bare-general territory, so an engine that
        // validates what it is handed will accept it and will not immediately
        // declare a result and run the terminal set piece mid-probe.
        const probeFen = '3k5/9/9/9/9/9/9/9/9/4K3R w - - 0 1';
        await this.page.evaluate((f) => window.__XQ!.setPosition(f), probeFen);
        const got = await this.page.evaluate(() => window.__XQ!.getPosition());
        if (!got.startsWith(probeFen.split(' ')[0]!)) {
          mark('setPosition', `setPosition() then getPosition() returned "${got}"`);
          mark('getPosition', 'does not reflect the loaded position');
        }
        await this.page.evaluate((f) => window.__XQ!.setPosition(f), START_FEN);
      } catch (err) {
        mark('setPosition', `threw during the round-trip probe: ${firstLine(err)}`);
      }
    }

    // 3 & 4. Visual probes. The scene is frozen, so an identical frame hash
    //    before and after a call means the call changed nothing that renders.
    if (caps.setSilhouette?.usable) {
      const changed = await this.visuallyChanges(
        () => this.page.evaluate(() => window.__XQ!.setSilhouette(true)),
        () => this.page.evaluate(() => window.__XQ!.setSilhouette(false)),
      );
      if (!changed) mark('setSilhouette', 'toggling it produced an identical frame');
    }
    if (caps.showcase?.usable) {
      const changed = await this.visuallyChanges(
        () => this.page.evaluate(() => window.__XQ!.showcase(0 as Side, 'general')),
        () => this.page.evaluate(() => window.__XQ!.exitShowcase()),
      );
      if (!changed) mark('showcase', 'entering showcase produced an identical frame');
    }
    return caps;
  }

  private async visuallyChanges(
    apply: () => Promise<unknown>,
    revert: () => Promise<unknown>,
  ): Promise<boolean> {
    // A centred crop: whatever the call affects will be in frame, and a small
    // clip keeps the probe well under 100 ms.
    const clip = {
      x: Math.round(this.viewport.width * 0.25),
      y: Math.round(this.viewport.height * 0.2),
      width: Math.round(this.viewport.width * 0.5),
      height: Math.round(this.viewport.height * 0.6),
    };
    const shot = async () => {
      await this.step(0);
      const b = await this.page.screenshot({ type: 'png', scale: 'css', clip, animations: 'disabled' });
      return createHash('sha1').update(b).digest('hex');
    };
    try {
      const before = await shot();
      await apply();
      const after = await shot();
      await revert();
      await this.step(0);
      return before !== after;
    } catch {
      return true; // never fail a run because a probe was unhappy
    }
  }
}

export async function launch(opts: DriverOptions): Promise<Driver> {
  return Driver.launch(opts);
}

/**
 * `tsx` runs this file through esbuild with `keepNames` on, which rewrites
 * every named function expression as `__name(fn, "fn")`. Playwright ships the
 * *compiled* text of an `evaluate()` callback into the page, where that helper
 * does not exist — so any callback that declares an inner function dies with
 * "ReferenceError: __name is not defined", in the page, at capture time.
 *
 * Defining `__name` as the identity function is the standard shim. It is
 * written as a string rather than a function so that esbuild cannot transform
 * the shim itself, and installed both as an init script (survives navigation)
 * and as a direct evaluation (covers the already-loaded document).
 */
const KEEP_NAMES_SHIM =
  'globalThis.__name = globalThis.__name || function (f) { return f; };';

async function installKeepNamesShim(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: KEEP_NAMES_SHIM });
}

async function launchChromium(headless: boolean, log: (s: string) => void): Promise<Browser> {
  const args = [...SOFTWARE_GL_ARGS];
  try {
    return await chromium.launch({ headless, args });
  } catch (err) {
    const executablePath = resolveChromiumExecutable();
    if (!executablePath) throw err;
    log(`driver: bundled chromium unavailable (${firstLine(err)})`);
    log(`driver: falling back to ${executablePath}`);
    return chromium.launch({ headless, args, executablePath });
  }
}

// ---------------------------------------------------------------------------
// WebGL verification
// ---------------------------------------------------------------------------

async function verifyWebGL(page: Page): Promise<WebGLReport> {
  return page.evaluate(() => {
    const blank: WebGLReportShape = {
      ok: false,
      version: '',
      vendor: '',
      renderer: '',
      webgl2: false,
      maxTextureSize: 0,
      maxDrawBuffers: 0,
      colorBufferFloat: false,
      detail: '',
    };
    // Prefer the renderer's own canvas. getContext() on a canvas that already
    // owns a context returns that context; on an unused one it would *create*
    // a context, which is why #app is tried first.
    const canvases = [
      ...document.querySelectorAll<HTMLCanvasElement>('#app canvas'),
      ...document.querySelectorAll<HTMLCanvasElement>('canvas'),
    ];
    if (canvases.length === 0) return { ...blank, detail: 'the page has no <canvas> element' };
    for (const c of canvases) {
      const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
      if (!gl) continue;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const webgl2 =
        typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      const version = String(gl.getParameter(gl.VERSION));
      const vendor = String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
      const renderer = String(
        dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      );
      return {
        ok: true,
        version,
        vendor,
        renderer,
        webgl2,
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
        // 0x8824 = MAX_DRAW_BUFFERS. The MRT prepass needs at least 2.
        maxDrawBuffers: webgl2 ? ((gl as WebGL2RenderingContext).getParameter(0x8824) as number) : 1,
        colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
        detail: `${version} · ${renderer} · drawing buffer ${c.width}x${c.height}`,
      };
    }
    return { ...blank, detail: `found ${canvases.length} canvas element(s), none with a WebGL context` };
  });
}

/** Structural twin of WebGLReport, declared for use inside the page callback. */
type WebGLReportShape = WebGLReport;

export function firstLine(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.split('\n')[0] ?? m;
}
