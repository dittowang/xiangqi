/**
 * Live diagnosis against a real running build.
 *
 *   npx vite build
 *   npx vite preview --port 4173 --host 127.0.0.1 --strictPort &
 *   npx tsx src/render/inspect.ts
 *
 * `bringup.ts` proves the shaders compile and that a synthetic scene
 * composites. It cannot tell you whether the shipped game is using them, and
 * that turned out to be the question that mattered: the first real frame of the
 * full cast had smooth falloff, no line work and no paper grain, all of which
 * `bringup` was blind to because it builds its own scene.
 *
 * So this script attaches to the ACTUAL page, walks the ACTUAL scene graph, and
 * reports what the materials, textures and passes really are at runtime. Then
 * it captures the debug modes, which exist precisely so a defect can be
 * attributed to the system that produced it rather than guessed at.
 */

const spec = (m: string): string => m;

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-gpu-sandbox',
];
const URL = 'http://127.0.0.1:4173/';
const OUT = 'docs/review';

/** A frame here takes 80–200 ms; Playwright's default is a UI timeout. */
const SHOT_TIMEOUT = 120000;

interface PageLike {
  goto(url: string, o?: Record<string, unknown>): Promise<unknown>;
  setViewportSize(s: { width: number; height: number }): Promise<void>;
  waitForFunction(fn: string, o?: Record<string, unknown>): Promise<{ jsonValue(): Promise<unknown> }>;
  evaluate(fn: string): Promise<unknown>;
  screenshot(o: Record<string, unknown>): Promise<unknown>;
  on(e: string, f: (a: never) => void): void;
}

async function main(): Promise<void> {
  const proc = (globalThis as unknown as { process?: { argv: string[]; exitCode?: number } })
    .process;
  const fs = (await import(spec('node:fs'))) as unknown as {
    mkdirSync(p: string, o: Record<string, unknown>): void;
  };
  fs.mkdirSync(OUT, { recursive: true });

  const pw = (await import(spec('playwright'))) as unknown as {
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
  const logs: string[] = [];
  page.on('console', (m: never) => {
    const msg = m as unknown as { type(): string; text(): string };
    if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (e: never) => logs.push(`pageerror: ${String(e)}`));

  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto(URL, { waitUntil: 'load', timeout: 120000 });

  console.log('waiting for the full cast …');
  await page.waitForFunction(
    'window.__XQ && window.__XQ.describe && window.__XQ.describe().pieces.length === 32',
    { timeout: 180000, polling: 250 },
  );

  await page.evaluate('window.__XQ.pause()');
  await page.evaluate("window.__XQ.setNamedPose('default', true)");
  await page.evaluate('window.__XQ.step(0.016)');

  // ---- what is actually in the scene -------------------------------------
  const probe = `(() => {
    const dbg = window.__DBG;
    const THREE = dbg.pipeline.renderer.constructor;
    const scene = dbg.scene;
    const pipeline = dbg.pipeline;

    const kinds = {};
    const matTypes = {};
    let meshes = 0, hulls = 0, skinned = 0, instanced = 0, gongbi = 0, foreign = 0;
    const foreignNames = new Set();
    scene.traverseVisible((o) => {
      if (!o.isMesh) return;
      meshes++;
      if (o.userData && o.userData.gongbiHull) hulls++;
      if (o.isSkinnedMesh) skinned++;
      if (o.isInstancedMesh) instanced++;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      matTypes[m.type] = (matTypes[m.type] || 0) + 1;
      const g = m.userData && m.userData.gongbi;
      if (g) { gongbi++; kinds[g.kind] = (kinds[g.kind] || 0) + 1; }
      else { foreign++; foreignNames.add(m.type + ':' + (m.name || '?')); }
    });

    const atlas = pipeline.materials.rampAtlas;
    const NEAREST = 1003;
    const ramp = {
      magFilter: atlas.magFilter, minFilter: atlas.minFilter,
      isNearest: atlas.magFilter === NEAREST && atlas.minFilter === NEAREST,
      generateMipmaps: atlas.generateMipmaps,
      width: atlas.image.width, height: atlas.image.height,
      type: atlas.type, colorSpace: atlas.colorSpace,
    };

    // A shared uniform read back off a live material: proves the push happened.
    let sample = null;
    scene.traverseVisible((o) => {
      if (sample) return;
      if (!o.isMesh) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m.userData && m.userData.gongbi && m.uniforms) {
        sample = {
          name: m.name,
          kind: m.userData.gongbi.kind,
          defines: Object.keys(m.defines || {}),
          csmEnabled: m.uniforms.uCsmEnabled && m.uniforms.uCsmEnabled.value,
          csmCount: m.uniforms.uCsmCount && m.uniforms.uCsmCount.value,
          silkGain: m.uniforms.uSilkGain && m.uniforms.uSilkGain.value,
          keyIntensity: m.uniforms.uKeyIntensity && m.uniforms.uKeyIntensity.value,
          keyDir: m.uniforms.uKeyDir && m.uniforms.uKeyDir.value.toArray().map(v=>+v.toFixed(3)),
          viewport: m.uniforms.uViewportPx && m.uniforms.uViewportPx.value.toArray(),
          exposure: m.uniforms.uExposure && m.uniforms.uExposure.value,
          rampAtlasBound: !!(m.uniforms.uRampAtlas && m.uniforms.uRampAtlas.value),
        };
      }
    });

    return {
      meshes, hulls, skinned, instanced, gongbi, foreign,
      foreignNames: [...foreignNames].slice(0, 12),
      kinds, matTypes, ramp, sample,
      stats: { ...pipeline.stats },
      quality: pipeline.quality,
      debug: pipeline.debug,
      xq: window.__XQ.stats(),
      shadowsCascades: pipeline.shadows.count,
      rendererShadowMap: pipeline.renderer.shadowMap.enabled,
      infoAutoReset: pipeline.renderer.info.autoReset,
      lights: (() => { const l = []; scene.traverse(o => { if (o.isLight) l.push(o.type + (o.castShadow ? '(cast)' : '')); }); return l; })(),
    };
  })()`;

  const info = (await page.evaluate(probe)) as Record<string, unknown>;
  console.log('\n=== live scene ===');
  console.log(JSON.stringify(info, null, 2));

  // ---- capture the debug modes -------------------------------------------
  const shots: [string, string | null][] = [
    ['board-diagnose-normal', null],
    ['board-diagnose-rampBands', 'rampBands'],
    ['board-diagnose-outlineOnly', 'outlineOnly'],
    ['board-diagnose-sobelOnly', 'sobelOnly'],
    ['board-diagnose-normals', 'normals'],
  ];

  for (const [name, flag] of shots) {
    if (flag) await page.evaluate(`window.__XQ.setDebug('${flag}', true)`);
    await page.evaluate('window.__XQ.step(0.016)');
    await page.evaluate('window.__XQ.step(0.016)');
    await page.screenshot({ path: `${OUT}/${name}.png`, timeout: SHOT_TIMEOUT });
    console.log(`captured ${name}.png`);
    if (flag) await page.evaluate(`window.__XQ.setDebug('${flag}', false)`);
  }

  if (logs.length) {
    console.log('\n=== console ===');
    for (const l of logs.slice(0, 40)) console.log(`  ${l}`);
  }

  await browser.close();
  void proc;
}

void main();
