const spec = (m: string) => m;
const pw: any = await import(spec('playwright'));
const browser = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-gpu-sandbox'] });
const page = await browser.newPage();
await page.setViewportSize({ width: 1100, height: 700 });
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__XQ && window.__XQ.describe().pieces.length === 32', { timeout: 180000, polling: 250 });
await page.evaluate('window.__XQ.pause()');
await page.evaluate("window.__XQ.setNamedPose('default', true)");

for (const tier of ['low','ultra']) {
  await page.evaluate(`window.__XQ.setQuality('${tier}')`);
  await page.evaluate('window.__XQ.step(0.016)'); await page.evaluate('window.__XQ.step(0.016)');
  const r = await page.evaluate(`(() => {
    const scene = window.__DBG.scene, p = window.__DBG.pipeline;
    let cast = {surface:0, hull:0, other:0}, sceneM = {surface:0, hull:0, other:0};
    const kinds = {};
    const units = window.__DBG.match ? null : null;
    scene.traverseVisible(o => {
      if (!o.isMesh) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const g = m.userData && m.userData.gongbi;
      const k = g ? g.kind : (m.type + '(foreign)');
      kinds[k] = (kinds[k]||0)+1;
    });
    return { kinds, stats: {...p.stats}, cascades: p.shadows.count,
             programs: p.renderer.info.programs.length, geometries: p.renderer.info.memory.geometries,
             tuning: p.tuning() };
  })()`);
  console.log(`\n--- ${tier} ---`);
  console.log(JSON.stringify(r, null, 1));
}
await browser.close();
