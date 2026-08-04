const spec = (m: string) => m;
const pw: any = await import(spec('playwright'));
const browser = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-gpu-sandbox'] });
const page = await browser.newPage();
await page.setViewportSize({ width: 1100, height: 700 });
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__XQ && window.__XQ.describe().pieces.length === 32', { timeout: 180000, polling: 250 });
await page.evaluate('window.__XQ.pause()');

async function shot(path: string, tier: string) {
  await page.evaluate(`window.__XQ.setQuality('${tier}')`);
  await page.evaluate("window.__XQ.setNamedPose('default', true)");
  await page.evaluate('window.__XQ.step(0.016)');
  await page.evaluate('window.__XQ.step(0.016)');
  const pose = await page.evaluate('JSON.stringify(window.__XQ.getPose())');
  const st = await page.evaluate('JSON.stringify({...window.__DBG.pipeline.stats, dpr: window.__XQ.stats().pixelRatio, sobel: window.__DBG.pipeline.tuning().sobelEnabled})');
  await page.screenshot({ path, timeout: 180000 });
  console.log(`${path}  tier=${tier} pose=${pose}\n    ${st}`);
}
await shot('.tmpa/f-low.png', 'low');
await shot('docs/review/board-after.png', 'ultra');
await browser.close();
