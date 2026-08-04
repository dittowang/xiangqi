const spec = (m: string) => m;
const pw: any = await import(spec('playwright'));
const browser = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-gpu-sandbox'] });
const page = await browser.newPage();
await page.setViewportSize({ width: 900, height: 600 });
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__XQ && window.__XQ.describe().pieces.length === 32', { timeout: 180000, polling: 250 });
await page.evaluate('window.__XQ.pause()');
await page.evaluate("window.__XQ.setQuality('ultra')");
// Their chariot close-up framing.
await page.evaluate("window.__XQ.setPose({target:[-2.0,0.55,2.6], distance:3.4, pitch:0.30, yaw:0.55, fov:34}, true)");
await page.evaluate('window.__XQ.step(0.016)');

const shots: [string, string][] = [
  ['c-00-asis', ''],
  ['c-01-nograin', 'p.tune({grain:0})'],
  ['c-02-nograin-nosilk', 'p.tune({grain:0, silkGain:0})'],
];
for (const [name, js] of shots) {
  if (js) await page.evaluate(`(() => { const p = window.__DBG.pipeline; ${js}; })()`);
  await page.evaluate('window.__XQ.step(0.016)'); await page.evaluate('window.__XQ.step(0.016)');
  await page.screenshot({ path: `.tmpa/${name}.png`, timeout: 180000 });
  console.log('captured', name);
}
// hull contribution: same frame with every hull hidden
await page.evaluate(`(() => { window.__DBG.scene.traverse(o => { if (o.userData && o.userData.gongbiHull) o.visible = false; }); })()`);
await page.evaluate('window.__XQ.step(0.016)'); await page.evaluate('window.__XQ.step(0.016)');
await page.screenshot({ path: '.tmpa/c-03-nohulls.png', timeout: 180000 });
console.log('captured c-03-nohulls');
await browser.close();
