/**
 * Motion sheets for the animation review. Temporary driver, deleted after use.
 *
 *   npx tsx tools/capture/_animsheet.ts <exchange|walk|orphan> <port> <out.png>
 */

import { chromium, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SheetSession } from './sheet.ts';

const EXEC = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-gpu-sandbox',
];

const [, , mode, portArg, outPath] = process.argv;
const PORT = Number(portArg);
const W = 700;
const H = 470;

interface XQ {
  ready(): Promise<void>;
  pause(): void;
  step(s: number): Promise<void>;
  setQuality(t: string): void;
  setHudVisible(on: boolean): void;
  setHumanSide(s: number): void;
  playMove(a: number, b: number): Promise<void>;
  forceMove(a: number, b: number): void;
  setPose(p: unknown, immediate?: boolean): void;
  describe(): { pieces: unknown[] };
}
type Win = { __XQ: XQ; __mv?: Promise<void> };
declare const window: Win;

/**
 * tsx compiles this file with esbuild's `keepNames`, which rewrites every arrow
 * function into `__name(() => …, "…")`. That helper exists in the Node module
 * scope, not in the page — so every `page.evaluate` argument throws
 * `__name is not defined` the moment it is deserialised in the browser.
 * Defining a no-op in the page before anything else runs is the whole fix, and
 * it is passed as a *string* so it is not itself transpiled.
 */
const SHIM =
  '(function(){ if (typeof globalThis.__name !== "function") { globalThis.__name = function (f) { return f; }; } })()';

async function shim(page: Page): Promise<void> {
  await page.addInitScript(SHIM);
  await page.evaluate(SHIM);
}

async function boot(page: Page): Promise<void> {
  const t0 = Date.now();
  const mark = (s: string) => process.stdout.write(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}\n`);
  await shim(page);
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await shim(page);
  mark('loaded');
  await page.waitForFunction(() => !!window.__XQ, null, { timeout: 90000 });
  await page.evaluate(() => window.__XQ.ready());
  mark('ready');
  await page.waitForFunction(() => window.__XQ.describe().pieces.length === 32, null, {
    timeout: 300000,
  });
  mark('32 pieces');
  await page.evaluate(() => {
    window.__XQ.setQuality('ultra');
    window.__XQ.setHudVisible(false);
    window.__XQ.pause();
  });
  mark('paused at ultra');
}

const step = (p: Page, dt: number) => p.evaluate((d) => window.__XQ.step(d), dt);
const play = async (p: Page, from: number, to: number, human: number) => {
  await p.evaluate((h) => window.__XQ.setHumanSide(h), human);
  await p.evaluate(([f, t]) => {
    window.__mv = window.__XQ.playMove(f, t);
  }, [from, to]);
};

/** Step to an absolute time on the sequence clock, screenshotting at the marks. */
async function run(
  page: Page,
  sheet: SheetSession,
  marks: { t: number; caption: string; flag?: boolean }[],
  dt: number,
  probe: (() => Promise<string>) | null,
): Promise<void> {
  let t = 0;
  let i = 0;
  const end = marks[marks.length - 1].t + 1e-6;
  while (i < marks.length) {
    if (t >= marks[i].t - 1e-9) {
      const shot = await page.screenshot();
      let cap = marks[i].caption;
      if (probe) cap = `${cap} ${await probe()}`;
      await sheet.add(shot, String(i + 1).padStart(2, '0'), cap, marks[i].flag ?? false);
      process.stdout.write(`  cell ${i + 1}/${marks.length} @ ${t.toFixed(3)}s\n`);
      i++;
      continue;
    }
    await step(page, dt);
    t += dt;
    if (t > end + 1) break;
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ executablePath: EXEC, args: ARGS });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const scratch = await browser.newPage();
  await scratch.goto('about:blank');
  await shim(scratch);
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') process.stdout.write(`  [page] ${m.text()}\n`);
  });
  await boot(page);

  let sheet: SheetSession;

  if (mode === 'exchange') {
    // Two legal pawn steps bring a Red and a Black 兵 face to face on file 4;
    // the third move is the capture. No forceMove: see the report.
    // Coarse steps: the setup moves only have to *finish*, they are not shot.
    await play(page, 58, 49, 1);
    for (let i = 0; i < 26; i++) await step(page, 0.05);
    process.stdout.write('  setup move 1 done\n');
    await play(page, 31, 40, 0);
    for (let i = 0; i < 26; i++) await step(page, 0.05);
    process.stdout.write('  setup move 2 done\n');
    await page.evaluate(() =>
      window.__XQ.setPose(
        { target: [0, 0.42, 0], distance: 2.4, pitch: 0.19, yaw: Math.PI / 2 - 0.5, fov: 34 },
        true,
      ),
    );
    await step(page, 0);

    sheet = await SheetSession.open(scratch, {
      title: '兵 takes 兵 — the three-beat exchange',
      subtitle:
        'soldier 49 x 40 · dt 1/60 · marks: windupStart 0.43 windupTop 0.96 contact 1.28 knock 1.69 disperse 2.35 disperseEnd 3.94',
      count: 16,
      cellAspect: W / H,
      cols: 4,
    });
    await play(page, 49, 40, 1);
    await run(
      page,
      sheet,
      [
        { t: 0.0, caption: 't 0.000 approach' },
        { t: 0.432, caption: 't 0.432 windupStart' },
        { t: 0.96, caption: 't 0.960 windupTop', flag: true },
        { t: 1.104, caption: 't 1.104 strike start' },
        { t: 1.184, caption: 't 1.184 mid-strike' },
        { t: 1.264, caption: 't 1.264 pre-contact', flag: true },
        { t: 1.296, caption: 't 1.296 CONTACT' },
        { t: 1.376, caption: 't 1.376 hold ends' },
        { t: 1.552, caption: 't 1.552 hit' },
        { t: 1.744, caption: 't 1.744 knockback end' },
        { t: 2.048, caption: 't 2.048 collapse' },
        { t: 2.352, caption: 't 2.352 disperse' },
        { t: 2.688, caption: 't 2.688 chips' },
        { t: 3.04, caption: 't 3.040 chips' },
        { t: 3.408, caption: 't 3.408 settled' },
      ],
      1 / 60,
      null,
    );
  } else if (mode === 'walk') {
    // The 馬 crosses two squares: the gait whose stride was derived from the
    // rider's shin instead of the horse's leg.
    await page.evaluate(() =>
      window.__XQ.setPose(
        { target: [-2.25, 0.36, 3.05], distance: 2.5, pitch: 0.12, yaw: Math.PI / 2, fov: 34 },
        true,
      ),
    );
    await step(page, 0);
    sheet = await SheetSession.open(scratch, {
      title: '馬 — the mount gait, one move',
      subtitle: 'horse 82 → 65 · profile · dt 1/60 · hoof travel is the measure, not the clock',
      count: 12,
      cellAspect: W / H,
      cols: 4,
    });
    await play(page, 82, 65, 1);
    const marks = [];
    for (let i = 0; i < 12; i++) marks.push({ t: 0.08 + i * 0.096, caption: `t ${(0.08 + i * 0.096).toFixed(3)}` });
    await run(page, sheet, marks, 1 / 60, null);
  } else {
    // The harness artefact: forceMove rebuilds the figure, the animator map
    // still points at the old one, and every clip plays into the void.
    await page.evaluate(() => {
      window.__XQ.forceMove(58, 49);
      window.__XQ.forceMove(31, 40);
    });
    await page.evaluate(() =>
      window.__XQ.setPose(
        { target: [0, 0.42, 0], distance: 2.4, pitch: 0.19, yaw: Math.PI / 2 - 0.5, fov: 34 },
        true,
      ),
    );
    await step(page, 0);
    sheet = await SheetSession.open(scratch, {
      title: 'the same exchange, set up with __XQ.forceMove()',
      subtitle:
        'forceMove calls match.sync() with no {from,to}, so the figure is destroyed and rebuilt — and the new root is not in the animator map',
      count: 8,
      cellAspect: W / H,
      cols: 4,
    });
    await play(page, 49, 40, 1);
    await run(
      page,
      sheet,
      [
        { t: 0.0, caption: 't 0.000 approach' },
        { t: 0.432, caption: 't 0.432 windupStart' },
        { t: 0.96, caption: 't 0.960 windupTop', flag: true },
        { t: 1.264, caption: 't 1.264 pre-contact', flag: true },
        { t: 1.296, caption: 't 1.296 CONTACT' },
        { t: 1.744, caption: 't 1.744 knockback end' },
        { t: 2.352, caption: 't 2.352 disperse' },
        { t: 3.04, caption: 't 3.040 chips' },
      ],
      1 / 60,
      null,
    );
  }

  const res = await sheet.finish();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, res.png);
  process.stdout.write(`wrote ${outPath} ${res.width}x${res.height} ${(res.bytes / 1024) | 0} kB\n`);
  await browser.close();
}

void main().then(
  () => process.exit(0),
  (e) => {
    process.stdout.write(`FAILED ${String(e)}\n`);
    process.exit(1);
  },
);
