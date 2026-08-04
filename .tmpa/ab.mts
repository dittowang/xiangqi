const spec = (m: string) => m;
const pw: any = await import(spec('playwright'));
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await pw.chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-gpu-sandbox'] });
const page = await browser.newPage();
await page.setViewportSize({ width: 1100, height: 700 });
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__XQ && window.__XQ.describe().pieces.length === 32', { timeout: 180000, polling: 250 });
await page.evaluate('window.__XQ.pause()');
await page.evaluate("window.__XQ.setNamedPose('default', true)");

// Reach into the live pipeline. `__DBG` exposes it for exactly this.
const setup = `(() => {
  const p = window.__DBG.pipeline;
  // grade uniforms live on the grade ScreenPass; reach them via the passes.
  const g = p.gradePass ? p.gradePass.material.uniforms : null;
  window.__G = g;
  window.__P = p;
  return g ? Object.keys(g) : 'gradePass not exposed';
})()`;
console.log('grade uniforms:', await page.evaluate(setup));

const variants: [string, string][] = [
  ['baseline', ''],
  ['grain=0', 'window.__G.uGrainAmount.value = 0;'],
  ['grain=0,vignette=0', 'window.__G.uGrainAmount.value = 0; window.__G.uVignette.value = 0;'],
  ['+silk=0', 'window.__G.uGrainAmount.value=0; window.__G.uVignette.value=0; window.__P.materials.shared.uSilkGain.value = 0;'],
  ['+bounce=neutral', 'window.__G.uGrainAmount.value=0; window.__G.uVignette.value=0; window.__P.materials.shared.uSilkGain.value=0; window.__P.materials.shared.uBounceColour.value.setRGB(1,1,1);'],
  ['+grade=0', 'window.__G.uGrainAmount.value=0; window.__G.uVignette.value=0; window.__P.materials.shared.uSilkGain.value=0; window.__P.materials.shared.uBounceColour.value.setRGB(1,1,1); window.__G.uGradeAmount.value=0;'],
];

for (const [name, js] of variants) {
  await page.evaluate(`(() => { ${js} })()`);
  await page.evaluate('window.__XQ.step(0.016)');
  await page.evaluate('window.__XQ.step(0.016)');
  await page.screenshot({ path: `.tmpa/ab-${name.replace(/[^a-z0-9]+/gi,'_')}.png`, timeout: 120000 });
  console.log(`captured ${name}`);
}

// Outline contribution: hide every hull and diff.
await page.evaluate(`(() => {
  window.__G.uGrainAmount.value=0; window.__G.uVignette.value=0;
  window.__DBG.scene.traverse(o => { if (o.userData && o.userData.gongbiHull) o.visible = false; });
})()`);
await page.evaluate('window.__XQ.step(0.016)');
await page.evaluate('window.__XQ.step(0.016)');
await page.screenshot({ path: '.tmpa/ab-nohulls.png', timeout: 120000 });
console.log('captured nohulls');

await browser.close();
