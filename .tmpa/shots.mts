const spec = (m: string) => m;
const pw: any = await import(spec('playwright'));
const browser = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-gpu-sandbox'] });
const page = await browser.newPage();
await page.setViewportSize({ width: 1100, height: 700 });
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__XQ && window.__XQ.describe().pieces.length === 32', { timeout: 180000, polling: 250 });
await page.evaluate('window.__XQ.pause()');
await page.evaluate("window.__XQ.setQuality('ultra')");
await page.evaluate("window.__XQ.setNamedPose('default', true)");
await page.evaluate('window.__XQ.step(0.016)'); await page.evaluate('window.__XQ.step(0.016)');
await page.screenshot({ path: 'docs/review/board-after.png', timeout: 180000 });
console.log('board-after.png');

await page.setViewportSize({ width: 900, height: 600 });
await page.evaluate("window.__XQ.setPose({target:[-2.0,0.55,2.6], distance:3.4, pitch:0.30, yaw:0.55, fov:34}, true)");
await page.evaluate('window.__XQ.step(0.016)'); await page.evaluate('window.__XQ.step(0.016)');
await page.screenshot({ path: 'docs/review/chariot-after.png', timeout: 180000 });
console.log('chariot-after.png');

for (const [flag, name] of [['rampBands','rampBands'],['sobelOnly','sobelOnly'],['outlineOnly','outlineOnly']]) {
  await page.evaluate(`window.__XQ.setDebug('${flag}', true)`);
  await page.evaluate('window.__XQ.step(0.016)'); await page.evaluate('window.__XQ.step(0.016)');
  await page.screenshot({ path: `docs/review/chariot-${name}.png`, timeout: 180000 });
  await page.evaluate(`window.__XQ.setDebug('${flag}', false)`);
  console.log(`chariot-${name}.png`);
}
await browser.close();
