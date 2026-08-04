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
console.log('tuning:', JSON.stringify(await page.evaluate('window.__DBG.pipeline.tuning()')));
console.log('quality:', await page.evaluate('window.__DBG.pipeline.quality'));

const variants: [string, string][] = [
  ['00-baseline', ''],
  ['01-nograin', 'p.tune({grain:0})'],
  ['02-nograin-novig', 'p.tune({grain:0, vignette:0})'],
  ['03-nosilk', 'p.tune({grain:0, vignette:0, silkGain:0})'],
  ['04-noboun', 'p.tune({grain:0, vignette:0, silkGain:0}); p.materials.shared.uBounceColour.value.setRGB(1,1,1)'],
  ['05-ultra', "p.tune({grain:0, vignette:0}); p.materials.shared.uBounceColour.value.setRGB(1,1,1); window.__XQ.setQuality('ultra')"],
];
for (const [name, js] of variants) {
  if (js) await page.evaluate(`(() => { const p = window.__DBG.pipeline; ${js}; })()`);
  await page.evaluate('window.__XQ.step(0.016)');
  await page.evaluate('window.__XQ.step(0.016)');
  await page.screenshot({ path: `.tmpa/v-${name}.png`, timeout: 180000 });
  console.log(`captured ${name}  stats=${JSON.stringify(await page.evaluate('({...window.__DBG.pipeline.stats})'))}`);
}
await browser.close();
