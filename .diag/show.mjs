import { chromium } from 'playwright';
const units = process.argv[2].split(',');
const side = process.argv[3] || '0';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 560, height: 700 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__XQ && window.__XQ.describe().pieces.length === 32, null, { timeout: 300000, polling: 1000 });
for (const u of units) {
  await page.evaluate(async ([unit, s]) => {
    await window.__XQ.showcase(Number(s), unit);
    window.__XQ.pause();
    const h = { soldier: 0.66, advisor: 0.74, general: 1.32, cannon: 0.82, horse: 1.0, elephant: 1.1, chariot: 0.9 }[unit] || 1;
    window.__XQ.setPose({ target: [0, h * 0.55, 0], distance: h * 2.3, pitch: 0.22, yaw: 0.55, fov: 34 }, true);
    await window.__XQ.step(0.016);
  }, [u, side]);
  await page.screenshot({ path: `.diag/show-${u}-${side}.png`, timeout: 300000 });
  console.log('shot', u);
}
await browser.close();
