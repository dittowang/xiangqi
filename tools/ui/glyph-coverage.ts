/**
 * Seal-script coverage check.
 *
 *   npx tsx tools/ui/glyph-coverage.ts
 *
 * Renders every character the game asks for onto contact sheets using the same
 * `drawGlyph` the HUD calls, and reports what is authored, at what fidelity,
 * and what is missing. A character with no authored form comes back as a tofu
 * box — it is counted as missing here and it is visibly a box on screen, which
 * is the whole point: a gap must be seen, not swallowed.
 *
 * It also exercises `glyphToContours` (the union that feeds ExtrudeGeometry) and
 * fails the run if any glyph produces no ink, no contour, or a contour that is
 * not a closed ring.
 *
 * Sheets land in `tools/ui/out/`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { band } from '../../src/core/palette.ts';
import { GLYPHS, PARTS } from '../../src/ui/glyphs.ts';
import {
  drawGlyph,
  drawText,
  getSealGlyph,
  glyphToContours,
  glyphToShapes,
  measureGlyph,
  measureText,
  missingRequests,
  sealCoverage,
  strokeToOutline,
  type SealGlyph,
} from '../../src/ui/seal.ts';
import { encodePng, RasterCanvas } from './raster.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');

// The characters the rest of the game will actually ask this module for.
const REQUIRED = {
  pieces: [...'帥將仕士相象傌馬俥車炮砲兵卒'],
  river: [...'楚河漢界'],
  hud: [...'先手後軍和局勝負悔棋提示覆盤難度初學國目前'],
  numerals: [...'一二三四五六七八九'],
  notation: [...'進退平'],
  blackFiles: [...'１２３４５６７８９'],
};

const PAPER = band('shellWhite', 3);
const INK = band('ink', 0);
const RULE = band('stone', 2);
const MARK_HIGH = band('gold', 1);
const MARK_LEGIBLE = band('stone', 1);
const MARK_MISSING = band('cinnabar', 2);

interface Row {
  ch: string;
  group: string;
  tier: string;
  strokes: number;
  segments: number;
  ink: number;
  contours: number;
  holes: number;
  shapes: number;
  note: string;
}

const rows: Row[] = [];
const problems: string[] = [];

// ---------------------------------------------------------------------------
// Sheet 1 — the whole roster at HUD size
// ---------------------------------------------------------------------------

const all: { ch: string; group: string }[] = [];
for (const [group, chars] of Object.entries(REQUIRED)) for (const ch of chars) all.push({ ch, group });

const COLS = 8;
const CELL = 116;
const GLYPH_PX = 84;
const rowsN = Math.ceil(all.length / COLS);
const sheet = new RasterCanvas(COLS * CELL, rowsN * CELL, PAPER);

for (let i = 0; i < all.length; i++) {
  const { ch, group } = all[i];
  const cx = (i % COLS) * CELL;
  const cy = Math.floor(i / COLS) * CELL;

  // Cell rule and em-box guide, so proportion errors are visible.
  sheet.fillRect(cx, cy + CELL - 1, CELL, 1, RULE, 0.5);
  sheet.fillRect(cx + CELL - 1, cy, 1, CELL, RULE, 0.5);
  const gx = cx + (CELL - GLYPH_PX) / 2;
  const gy = cy + (CELL - GLYPH_PX) / 2;
  sheet.fillRect(gx, gy, GLYPH_PX, 1, RULE, 0.25);
  sheet.fillRect(gx, gy + GLYPH_PX - 1, GLYPH_PX, 1, RULE, 0.25);

  const g: SealGlyph = getSealGlyph(ch);
  drawGlyph(sheet, g, gx, gy, GLYPH_PX, { pigment: 'ink', band: 0 });

  const mark = g.tier === 'high' ? MARK_HIGH : g.tier === 'legible' ? MARK_LEGIBLE : MARK_MISSING;
  sheet.fillRect(cx + 4, cy + 4, 14, 5, mark);

  const inkFrac = sheet.inkFraction(gx, gy, GLYPH_PX, GLYPH_PX, PAPER);

  // Union contours — this is what the board's incised characters extrude from.
  let contours = 0;
  let holes = 0;
  let shapes = 0;
  try {
    const cs = glyphToContours(g, { size: 1, resolution: 200 });
    contours = cs.length;
    holes = cs.reduce((n, c) => n + c.holes.length, 0);
    for (const c of cs) {
      if (c.outer.length < 8) problems.push(`${ch}: degenerate outer contour (${c.outer.length / 2} pts)`);
      for (const h of c.holes) if (h.length < 8) problems.push(`${ch}: degenerate hole`);
    }
    shapes = glyphToShapes(g, { size: 1, resolution: 200 }).length;
  } catch (err) {
    problems.push(`${ch}: contouring threw — ${(err as Error).message}`);
  }

  if (g.tier === 'missing') problems.push(`${ch}: NOT AUTHORED (rendered as tofu)`);
  if (inkFrac < 0.02) problems.push(`${ch}: renders almost nothing (ink ${(inkFrac * 100).toFixed(1)}%)`);
  if (inkFrac > 0.62) problems.push(`${ch}: ink is clotted (${(inkFrac * 100).toFixed(1)}%) — strokes too heavy`);
  if (contours === 0 && g.tier !== 'missing') problems.push(`${ch}: union produced no contour`);

  // Outline sanity: every stroke must expand to a closed ring of real area.
  for (let s = 0; s < g.strokes.length; s++) {
    const ring = strokeToOutline(g.strokes[s]);
    if (ring.length < 12) problems.push(`${ch}: stroke ${s} expanded to ${ring.length / 2} points`);
    let area = 0;
    for (let k = 0, j = ring.length / 2 - 1; k < ring.length / 2; j = k++) {
      area += (ring[j * 2] - ring[k * 2]) * (ring[j * 2 + 1] + ring[k * 2 + 1]);
    }
    if (Math.abs(area * 0.5) < 1e-6) problems.push(`${ch}: stroke ${s} outline has no area`);
  }

  rows.push({
    ch,
    group,
    tier: g.tier,
    strokes: g.strokes.length,
    segments: g.segments,
    ink: inkFrac,
    contours,
    holes,
    shapes,
    note: g.note ?? '',
  });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'roster.png'), encodePng(sheet.width, sheet.height, sheet.pixels));

// ---------------------------------------------------------------------------
// Sheet 2 — the eighteen that are large on screen, at piece size
// ---------------------------------------------------------------------------

const BIG_SET = [...REQUIRED.pieces, ...REQUIRED.river];
const BCOLS = 6;
const BCELL = 200;
const brows = Math.ceil(BIG_SET.length / BCOLS);
const big = new RasterCanvas(BCOLS * BCELL, brows * BCELL, PAPER);
for (let i = 0; i < BIG_SET.length; i++) {
  const cx = (i % BCOLS) * BCELL;
  const cy = Math.floor(i / BCOLS) * BCELL;
  big.fillRect(cx, cy + BCELL - 1, BCELL, 1, RULE, 0.4);
  big.fillRect(cx + BCELL - 1, cy, 1, BCELL, RULE, 0.4);
  const pad = 18;
  big.fillRect(cx + pad, cy + pad, BCELL - pad * 2, 1, RULE, 0.25);
  big.fillRect(cx + pad, cy + BCELL - pad, BCELL - pad * 2, 1, RULE, 0.25);
  drawGlyph(big, BIG_SET[i], cx + BCELL / 2, cy + BCELL / 2, BCELL - pad * 2, {
    pigment: 'ink',
    band: 0,
    align: 'center',
    baseline: 'middle',
  });
}
writeFileSync(join(OUT, 'pieces.png'), encodePng(big.width, big.height, big.pixels));

// ---------------------------------------------------------------------------
// Sheet 3 — text in situ: the 棋譜 column, the labels, and a deliberate gap
// ---------------------------------------------------------------------------

const spec = new RasterCanvas(760, 420, PAPER);
drawText(spec, '楚河漢界', 24, 24, 76, { pigment: 'ink', band: 0 });
drawText(spec, '炮二平五', 24, 124, 46, { pigment: 'cinnabar', band: 1 });
drawText(spec, '馬８進７', 24, 184, 46, { pigment: 'inkLacquer', band: 1 });
drawText(spec, '將軍', 24, 244, 46, { pigment: 'cinnabar', band: 2 });
drawText(spec, '初學棋士國手', 24, 310, 40, { pigment: 'ink', band: 1 });
drawText(spec, '悔棋提示覆盤', 24, 366, 40, { pigment: 'ink', band: 1 });
// Vertical column, the way a record actually runs.
drawText(spec, '車一進一', 620, 24, 52, { pigment: 'ink', band: 0, vertical: true });
drawText(spec, '和局勝負', 700, 24, 52, { pigment: 'ink', band: 0, vertical: true });
// Deliberately unauthored characters, so the tofu path is exercised on the sheet.
drawText(spec, '飛龍在天', 300, 300, 44, { pigment: 'cinnabar', band: 1 });
writeFileSync(join(OUT, 'specimen.png'), encodePng(spec.width, spec.height, spec.pixels));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const cov = sealCoverage();
const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);

console.log('');
console.log('SEAL GLYPH COVERAGE');
console.log('===================');
console.log('');
console.log(pad('ch', 4) + pad('group', 11) + pad('tier', 10) + pad('strk', 6) + pad('seg', 6) + pad('ink%', 7) + pad('cont', 6) + pad('hole', 6) + 'note');
console.log('-'.repeat(112));
for (const r of rows) {
  console.log(
    pad(r.ch, 4) +
      pad(r.group, 11) +
      pad(r.tier, 10) +
      pad(String(r.strokes), 6) +
      pad(String(r.segments), 6) +
      pad((r.ink * 100).toFixed(1), 7) +
      pad(String(r.contours), 6) +
      pad(String(r.holes), 6) +
      (r.note ? r.note.slice(0, 60) : ''),
  );
}

const required = all.map((a) => a.ch);
const authored = required.filter((c) => getSealGlyph(c).tier !== 'missing');
const missing = required.filter((c) => getSealGlyph(c).tier === 'missing');

console.log('');
console.log(`roster authored : ${Object.keys(GLYPHS).length} glyphs, ${Object.keys(PARTS).length} shared components`);
console.log(`required        : ${required.length}`);
console.log(`authored        : ${authored.length}`);
console.log(`missing         : ${missing.length}${missing.length ? ' -> ' + missing.join(' ') : ''}`);
console.log(`high fidelity   : ${cov.high.length}  ${cov.high.join('')}`);
console.log(`legible         : ${cov.legible.length}  ${cov.legible.join('')}`);
console.log(`tofu requested  : ${missingRequests().join('') || '(none beyond the deliberate specimen)'}`);

// The tofu path has to survive everything a real glyph does, or a missing
// character takes the HUD down with it instead of showing a box.
{
  const tofu = getSealGlyph('龘'); // deliberately unauthored
  if (tofu.tier !== 'missing') problems.push('tofu: an unauthored char did not come back as tier "missing"');
  if (tofu.strokes.length === 0) problems.push('tofu: has no strokes — a gap would render as nothing');
  if (Math.abs(tofu.advance - 1) > 1e-6) problems.push('tofu: advance is not one em, so runs would mis-lay-out');
  try {
    const cs = glyphToContours(tofu, { size: 1 });
    if (cs.length === 0) problems.push('tofu: produced no contour');
    if (glyphToShapes(tofu).length === 0) problems.push('tofu: produced no Shape');
  } catch (err) {
    problems.push(`tofu: contouring threw — ${(err as Error).message}`);
  }
}

// The per-stroke Shape mode is the escape hatch for flat inlays; it must work
// for every glyph even though the union path is the default.
for (const ch of required) {
  try {
    const shapes = glyphToShapes(ch, { mode: 'perStroke', size: 2 });
    if (shapes.length !== getSealGlyph(ch).strokes.length) {
      problems.push(`${ch}: perStroke mode returned ${shapes.length} shapes for ${getSealGlyph(ch).strokes.length} strokes`);
    }
  } catch (err) {
    problems.push(`${ch}: perStroke mode threw — ${(err as Error).message}`);
  }
}

// Vertical runs are how the move record is laid out, so measure them too.
{
  const v = measureText('車一進一', 50, { vertical: true });
  if (Math.abs(v.advance - 200) > 1e-6) problems.push(`vertical measureText advance is ${v.advance}, expected 200`);
  if (v.offsets.length !== 4) problems.push('vertical measureText returned the wrong number of offsets');
  const t = measureText('炮二平五', 40, { tracking: 0.1 });
  if (Math.abs(t.advance - (160 + 3 * 4)) > 1e-6) problems.push(`tracking is not applied: ${t.advance}`);
}

// Metrics spot check — an advance that is not one em would break HUD layout.
const badAdvance = required.filter((c) => Math.abs(measureGlyph(c).advance - 1) > 1e-6);
if (badAdvance.length) problems.push(`non-unit advance on: ${badAdvance.join(' ')}`);
const line = measureText('炮二平五', 40);
if (Math.abs(line.advance - 160) > 1e-6) problems.push(`measureText advance wrong: ${line.advance}`);

console.log('');
if (problems.length) {
  console.log('PROBLEMS');
  console.log('--------');
  for (const p of problems) console.log('  ' + p);
} else {
  console.log('No problems found.');
}
console.log('');
console.log(`sheets -> ${OUT}/roster.png, pieces.png, specimen.png`);

// The deliberate specimen gap (飛龍在天) is expected; anything else is a failure.
const unexpected = problems.filter((p) => !/^[飛龍在天]: NOT AUTHORED/.test(p));
process.exit(unexpected.length ? 1 : 0);
