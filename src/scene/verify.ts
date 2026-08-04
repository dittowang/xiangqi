/**
 * Headless verification for the scene subsystem.
 *
 *     npx tsx src/scene/verify.ts
 *
 * three builds geometry perfectly well with no GL context, so the whole board,
 * the bases, the distance and the camera can be constructed in node and then
 * *measured*. This checks the claims that would otherwise be opinions:
 *
 *   - triangle counts and bounding boxes are what they are supposed to be;
 *   - `heightAt` returns sane, continuous values everywhere, including inside
 *     the river channel and on the timber frame;
 *   - every grid incision passes exactly through the intersections that
 *     `core/coords.ts` defines, to float32 precision;
 *   - the camera springs integrate identically at any dt, which is what makes a
 *     harness-stepped frame reproducible;
 *   - a capture push resolves, lands inside the pitch band that keeps the
 *     horizon level, and does not cross the axis of action.
 *
 * Exits non-zero on the first failure so it can gate a build.
 */

import * as THREE from 'three';
import { FILES, RANKS, sq, worldX, worldZ } from '@core/coords.ts';
import { MOODS } from '@core/palette.ts';
import { PieceType, Side } from '@core/types.ts';
import {
  BANK_HALF,
  BANK_RISE,
  Board,
  FRAME_TOP_Y,
  FRAME_WIDTH,
  OFF_BOARD_Y,
  RIVER_DEPTH,
  SILK_HALF_X,
  SILK_HALF_Z,
  TABLE_BOTTOM_Y,
  TABLE_HALF_X,
  TABLE_HALF_Z,
  WATER_HALF,
  WATER_Y,
  palaceDiagonals,
  silkSag,
} from './board.ts';
import {
  BASE_GLYPH_EM,
  BASE_TOP_Y,
  adaptGlyphPath,
  glyphInkBox,
  sealOutlineFromContours,
  sealOutlineFromShapes,
} from './bases.ts';
import { signedArea } from './geometry.ts';
// The scene never imports @ui at runtime — the module graph forbids it and the
// board takes its glyphs by injection. This script stands in for the integration
// layer that does the wiring, so that the incision is tested against the real
// type engine rather than against a fixture that agrees with it by construction.
import { getSealGlyph, glyphToContours, glyphToShapes, sealRoster } from '@ui/seal.ts';
import { Backdrop, LAKE_Y, TERRACE_RADIUS } from './backdrop.ts';
import { Director, PUSH_LAND_FRACTION, RETURN_SLOWDOWN, SPRING } from './camera.ts';
import { LightingRig } from './lighting.ts';
import { createFallbackMaterials } from './fallbackMaterials.ts';
import { createSceneRig } from './index.ts';
import type { SealOutline } from './bases.ts';

/**
 * This script runs under `tsx`, not in the browser, and the project ships no
 * `@types/node` (it is a browser build and nothing else needs them). These two
 * globals are the only node surface it touches, so they are declared here rather
 * than by adding a dependency.
 */
declare const process: {
  stdout: { write(s: string): boolean };
  exitCode: number;
};

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------

let passes = 0;
const failures: string[] = [];

function report(label: string, detail: string, ok: boolean): void {
  const tag = ok ? '  ok  ' : ' FAIL ';
  process.stdout.write(`[${tag}] ${label.padEnd(52)} ${detail}\n`);
  if (ok) passes++;
  else failures.push(`${label} — ${detail}`);
}

function check(label: string, ok: boolean, detail: string): void {
  report(label, detail, ok);
}

function near(label: string, value: number, expected: number, tol: number): void {
  const d = Math.abs(value - expected);
  report(
    label,
    `${fmt(value)} (want ${fmt(expected)} ±${fmt(tol)}, off by ${d.toExponential(2)})`,
    d <= tol,
  );
}

function between(label: string, value: number, lo: number, hi: number): void {
  report(label, `${fmt(value)} (want ${fmt(lo)}..${fmt(hi)})`, value >= lo && value <= hi);
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function section(title: string): void {
  process.stdout.write(`\n── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}\n`);
}

function tris(o: THREE.Object3D): number {
  const m = o as THREE.Mesh;
  const pos = m.geometry?.getAttribute?.('position');
  return pos ? pos.count / 3 : 0;
}

// ---------------------------------------------------------------------------
// The real seal source: exactly the line the integration layer writes.
// ---------------------------------------------------------------------------

const seal = (ch: string): SealOutline | null =>
  sealOutlineFromShapes(glyphToShapes(ch, { size: 1, origin: 'center' }), 1);

/** Every character this subsystem asks the type engine for. */
const CHARS_USED = [
  '楚',
  '河',
  '漢',
  '界',
  '帥',
  '仕',
  '相',
  '傌',
  '俥',
  '炮',
  '兵',
  '將',
  '士',
  '象',
  '馬',
  '車',
  '砲',
  '卒',
];

// ---------------------------------------------------------------------------

const materials = createFallbackMaterials();

section('board construction');

const t0 = Date.now();
const board = new Board({
  materials,
  seal,
  detail: 'high',
});
const buildMs = Date.now() - t0;
process.stdout.write(`      built in ${buildMs} ms\n`);

// Register a full set of bases so heightAt has something to step onto.
{
  let id = 0;
  const layout: [Side, PieceType, number][] = [];
  for (const side of [Side.Red, Side.Black]) {
    const back = side === Side.Red ? 9 : 0;
    layout.push([side, PieceType.General, sq(4, back)]);
    layout.push([side, PieceType.Advisor, sq(3, back)]);
    layout.push([side, PieceType.Advisor, sq(5, back)]);
    layout.push([side, PieceType.Elephant, sq(2, back)]);
    layout.push([side, PieceType.Elephant, sq(6, back)]);
    layout.push([side, PieceType.Horse, sq(1, back)]);
    layout.push([side, PieceType.Horse, sq(7, back)]);
    layout.push([side, PieceType.Chariot, sq(0, back)]);
    layout.push([side, PieceType.Chariot, sq(8, back)]);
    const cannonRank = side === Side.Red ? 7 : 2;
    layout.push([side, PieceType.Cannon, sq(1, cannonRank)]);
    layout.push([side, PieceType.Cannon, sq(7, cannonRank)]);
    const soldierRank = side === Side.Red ? 6 : 3;
    for (const f of [0, 2, 4, 6, 8]) layout.push([side, PieceType.Soldier, sq(f, soldierRank)]);
  }
  for (const [side, type, square] of layout) {
    board.bases.add(id, side, type);
    board.bases.setSquare(id, square);
    id++;
  }
  check('32 bases registered', id === 32, `${id} bases`);
}

// ---------------------------------------------------------------------------

section('triangle counts');

const partTris: Record<string, number> = {};
for (const [name, mesh] of Object.entries(board.parts)) {
  partTris[name] = tris(mesh);
  process.stdout.write(`      ${name.padEnd(16)} ${String(partTris[name]).padStart(8)} tris\n`);
}
process.stdout.write(
  `      ${'bases (14 geo)'.padEnd(16)} ${String(Math.round(board.bases.triangles)).padStart(8)} tris\n`,
);
process.stdout.write(
  `      ${'markers'.padEnd(16)} ${String(Math.round(board.markers.triangles)).padStart(8)} tris\n`,
);

const boardStats = board.stats();
process.stdout.write(
  `      ${'TOTAL drawn'.padEnd(16)} ${String(Math.round(boardStats.triangles)).padStart(8)} tris in ${boardStats.meshes} meshes\n`,
);

check('deck exists', partTris.deck > 1000, `${partTris.deck} tris`);
check('frame exists', partTris.frame > 500, `${partTris.frame} tris`);
check('incisions exist', partTris.incisions > 1000, `${partTris.incisions} tris`);
check('palace leaf exists', partTris.palaceLeaf > 40, `${partTris.palaceLeaf} tris`);
check('river banking exists', partTris.banking > 500, `${partTris.banking} tris`);
check('river bed exists', partTris.riverBed > 100, `${partTris.riverBed} tris`);
check('water exists', partTris.water > 500, `${partTris.water} tris`);
check(
  'board fits the perf budget',
  boardStats.triangles < 200_000,
  `${Math.round(boardStats.triangles)} of a 900k frame budget`,
);
check(
  'board draw calls are cheap',
  boardStats.meshes <= 32,
  `${boardStats.meshes} meshes (budget is 260 calls for the whole frame)`,
);

// ---------------------------------------------------------------------------

section('winding and normals');

{
  // The invariant every piece of geometry in this subsystem has to hold: the
  // stored vertex normal must agree with the direction the triangle's winding
  // makes it face. Break it and the surface is either back-face culled out of
  // existence or lit from behind — and both look like "the material is wrong"
  // rather than "the geometry is inside out", which is a long afternoon.
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();
  const C = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const face = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  const audit = (label: string, geo: THREE.BufferGeometry) => {
    const pos = geo.getAttribute('position');
    const nAttr = geo.getAttribute('normal');
    if (!pos || !nAttr) return;
    let bad = 0;
    let degenerate = 0;
    let upFacing = 0;
    const total = pos.count / 3;
    for (let i = 0; i < pos.count; i += 3) {
      A.fromBufferAttribute(pos, i);
      B.fromBufferAttribute(pos, i + 1);
      C.fromBufferAttribute(pos, i + 2);
      ab.subVectors(B, A);
      ac.subVectors(C, A);
      face.crossVectors(ab, ac);
      if (face.lengthSq() < 1e-16) {
        degenerate++;
        continue;
      }
      face.normalize();
      nrm.fromBufferAttribute(nAttr, i);
      if (face.dot(nrm) < 0.02) bad++;
      if (face.y > 0.5) upFacing++;
    }
    report(
      `${label} winding agrees with normals`,
      `${total - bad - degenerate}/${total} good, ${bad} inverted, ${degenerate} degenerate, ${Math.round((upFacing / total) * 100)}% face up`,
      bad === 0,
    );
  };

  for (const name of ['deck', 'frame', 'incisions', 'palaceLeaf', 'banking', 'riverBed', 'water']) {
    const mesh = board.parts[name] as THREE.Mesh | undefined;
    if (mesh) audit(name.padEnd(11), mesh.geometry);
  }
  board.bases.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) audit(('base ' + m.name.split('/').slice(-2).join('/')).padEnd(11), m.geometry);
  });
  board.markers.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) audit(('mark ' + m.name.split('/').pop()).padEnd(11), m.geometry);
  });
}

// ---------------------------------------------------------------------------

section('bounding boxes');

function bbox(o: THREE.Object3D): THREE.Box3 {
  const b = new THREE.Box3();
  const m = o as THREE.Mesh;
  if (m.geometry) {
    m.geometry.computeBoundingBox();
    b.copy(m.geometry.boundingBox!);
  }
  return b;
}

{
  const frame = bbox(board.parts.frame);
  near('frame outer half-extent X', frame.max.x, TABLE_HALF_X, 0.13);
  near('frame outer half-extent Z', frame.max.z, TABLE_HALF_Z, 0.13);
  near('frame top', frame.max.y, FRAME_TOP_Y, 0.004);
  near('table underside', frame.min.y, TABLE_BOTTOM_Y, 0.002);

  const deck = bbox(board.parts.deck);
  near('deck half-extent X', deck.max.x, SILK_HALF_X, 1e-4);
  near('deck half-extent Z', deck.max.z, SILK_HALF_Z, 1e-4);
  between('deck sag range', deck.max.y - deck.min.y, 0.0005, 0.005);

  const bed = bbox(board.parts.riverBed);
  near('river bed depth', bed.min.y, -RIVER_DEPTH, 0.003);
  between('river bed half-width', bed.max.z, 0.19, 0.23);

  const water = bbox(board.parts.water);
  near('water plane height', water.max.y, WATER_Y, 1e-5);
  near('water half-width', water.max.z, WATER_HALF, 1e-4);
  between('water sits below the silk', WATER_Y, -RIVER_DEPTH, -0.01);
  between('water sits above the bed', WATER_Y + RIVER_DEPTH, 0.02, 0.12);

  const bank = bbox(board.parts.banking);
  near('banking cap height', bank.max.y, BANK_RISE, 0.006);
  near('banking outer half-width', bank.max.z, BANK_HALF, 1e-4);

  const all = new THREE.Box3().setFromObject(board.group);
  process.stdout.write(
    `      board group bbox  x[${fmt(all.min.x)}, ${fmt(all.max.x)}]  y[${fmt(all.min.y)}, ${fmt(all.max.y)}]  z[${fmt(all.min.z)}, ${fmt(all.max.z)}]\n`,
  );
  check(
    'board group is table-sized',
    all.max.x <= TABLE_HALF_X + 0.02 && all.max.z <= TABLE_HALF_Z + 0.02,
    `${fmt(all.max.x)} x ${fmt(all.max.z)}`,
  );
}

// ---------------------------------------------------------------------------

section('heightAt');

{
  // Every intersection sits on flat silk; only the sag moves it.
  let worst = -1;
  let worstAt = '';
  for (let r = 0; r < RANKS; r++) {
    for (let f = 0; f < FILES; f++) {
      const x = worldX(f);
      const z = worldZ(r);
      const h = board.surfaceAt(x, z);
      const want = silkSag(x, z);
      const d = Math.abs(h - want);
      if (d > worst) {
        worst = d;
        worstAt = `f${f} r${r}`;
      }
    }
  }
  check(
    'all 90 intersections sit on the silk',
    worst < 1e-9,
    `worst deviation ${worst.toExponential(2)} at ${worstAt}`,
  );

  const sagMax = (() => {
    let m = 0;
    for (let i = 0; i <= 200; i++) {
      for (let j = 0; j <= 200; j++) {
        const x = -SILK_HALF_X + (i / 200) * SILK_HALF_X * 2;
        const z = -SILK_HALF_Z + (j / 200) * SILK_HALF_Z * 2;
        m = Math.max(m, Math.abs(silkSag(x, z)));
      }
    }
    return m;
  })();
  between('silk sag peak amplitude', sagMax, 0.0005, 0.0025);

  // The channel.
  near('river centre is the water surface', board.surfaceAt(0, 0), WATER_Y, 1e-9);
  near('river centre, off-axis', board.surfaceAt(-3.5, 0), WATER_Y, 1e-9);
  check(
    'below the water line the surface is the water',
    board.surfaceAt(0, WATER_HALF - 0.01) === WATER_Y,
    `at z=${fmt(WATER_HALF - 0.01)} -> ${fmt(board.surfaceAt(0, WATER_HALF - 0.01))}`,
  );
  check(
    'above the water line the cut wall emerges',
    board.surfaceAt(0, 0.28) > WATER_Y && board.surfaceAt(0, 0.28) < BANK_RISE,
    `at z=0.28 -> ${fmt(board.surfaceAt(0, 0.28))} (between water ${fmt(WATER_Y)} and cap ${fmt(BANK_RISE)})`,
  );
  between('water line sits on the cut wall', WATER_HALF, 0.21, 0.3);
  near('banking cap', board.surfaceAt(0, 0.36), BANK_RISE + silkSag(0, 0.36), 1e-9);
  near('silk just past the bank', board.surfaceAt(0, 0.55), silkSag(0, 0.55), 1e-9);
  check(
    'channel floor is 0.12 below the silk',
    Math.abs(-RIVER_DEPTH - -0.12) < 1e-9,
    `RIVER_DEPTH = ${fmt(RIVER_DEPTH)}`,
  );
  between(
    'water surface depth below silk',
    -board.surfaceAt(0, 0),
    0.02,
    RIVER_DEPTH,
  );

  // The frame.
  const frameMid = SILK_HALF_X + 0.5;
  near('frame top face', board.surfaceAt(frameMid, 0), FRAME_TOP_Y, 1e-9);
  check(
    'frame stands above the silk',
    board.surfaceAt(frameMid, 0) > board.surfaceAt(0, 3),
    `${fmt(board.surfaceAt(frameMid, 0))} > ${fmt(board.surfaceAt(0, 3))}`,
  );
  near('frame corner (mitre) top face', board.surfaceAt(SILK_HALF_X + 0.5, SILK_HALF_Z + 0.5), FRAME_TOP_Y, 1e-9);
  near('off the table', board.surfaceAt(TABLE_HALF_X + 2, 0), OFF_BOARD_Y, 1e-9);
  near('far off the table', board.surfaceAt(40, -40), OFF_BOARD_Y, 1e-9);

  // Continuity. The height field is piecewise linear, so a "discontinuity" would
  // show up as a step far larger than the steepest authored slope. Three regions
  // matter, and they have different right answers:
  //
  //   1. anywhere a figure can stand (the silk and the frame's top face) —
  //      must be gentle, or foot IK will pop;
  //   2. the rest of the table, including the near-vertical outer bead of the
  //      edge profile — steep is correct, a *jump* is not;
  //   3. past the outer bead, where the table genuinely ends and the terrace is
  //      0.55 below. That cliff is the design, and it is asserted as such.
  const stepMm = 0.001;
  const slopeOver = (
    axis: 'x' | 'z',
    lo: number,
    hi: number,
    fixed: number,
  ): { slope: number; at: number } => {
    let worst = 0;
    let at = lo;
    for (let v = lo; v < hi; v += stepMm) {
      const a = axis === 'z' ? board.surfaceAt(fixed, v) : board.surfaceAt(v, fixed);
      const b = axis === 'z' ? board.surfaceAt(fixed, v + stepMm) : board.surfaceAt(v + stepMm, fixed);
      const s = Math.abs(b - a) / stepMm;
      if (s > worst) {
        worst = s;
        at = v;
      }
    }
    return { slope: worst, at };
  };

  // 1. The standable region: silk plus the frame's flat top face.
  const standZ = slopeOver('z', -(SILK_HALF_Z + 0.86), SILK_HALF_Z + 0.86, 0.37);
  const standX = slopeOver('x', -(SILK_HALF_X + 0.86), SILK_HALF_X + 0.86, 2.5);
  check(
    'gentle gradients everywhere a figure can stand (Z)',
    standZ.slope < 2.5,
    `steepest ${fmt(standZ.slope)}:1 at z=${fmt(standZ.at)}`,
  );
  check(
    'gentle gradients everywhere a figure can stand (X)',
    standX.slope < 2.5,
    `steepest ${fmt(standX.slope)}:1 at x=${fmt(standX.at)}`,
  );

  // 2. The whole table top, including the turned edge.
  const tableZ = slopeOver('z', -TABLE_HALF_Z + 0.001, TABLE_HALF_Z - 0.002, 0.37);
  const tableX = slopeOver('x', -TABLE_HALF_X + 0.001, TABLE_HALF_X - 0.002, 2.5);
  check(
    'no jump anywhere on the table (Z)',
    tableZ.slope < 6.5,
    `steepest ${fmt(tableZ.slope)}:1 at z=${fmt(tableZ.at)} — the outer bead`,
  );
  check(
    'no jump anywhere on the table (X)',
    tableX.slope < 6.5,
    `steepest ${fmt(tableX.slope)}:1 at x=${fmt(tableX.at)}`,
  );

  // 3. The designed cliff at the table's edge.
  const lastOnTable = board.surfaceAt(0.37, TABLE_HALF_Z - 0.0005);
  const firstOffTable = board.surfaceAt(0.37, TABLE_HALF_Z + 0.0005);
  near('table edge is exactly at TABLE_HALF_Z', lastOnTable, -0.09, 0.004);
  near('and the terrace is right below it', firstOffTable, OFF_BOARD_Y, 1e-9);
  process.stdout.write(
    `      table edge drop: ${fmt(lastOnTable - firstOffTable)} world units, from the bead to the terrace\n`,
  );

  // Bases.
  const bx = worldX(4);
  const bz = worldZ(9);
  near('heightAt on an occupied square', board.heightAt(bx, bz), silkSag(bx, bz) + BASE_TOP_Y, 1e-9);
  near('surfaceAt ignores bases', board.surfaceAt(bx, bz), silkSag(bx, bz), 1e-9);
  near('heightAt clear of any base', board.heightAt(worldX(4), worldZ(5)), board.surfaceAt(worldX(4), worldZ(5)), 1e-9);
  between(
    'base rim tapers to the board',
    board.heightAt(bx + 0.33, bz) - silkSag(bx + 0.33, bz),
    0.0,
    BASE_TOP_Y,
  );

  const heights = [
    ['centre of the river', board.surfaceAt(0, 0)],
    ['a palace corner', board.surfaceAt(worldX(3), worldZ(0))],
    ['board centre-file, rank 5', board.surfaceAt(worldX(4), worldZ(5))],
    ['inner arris of the frame', board.surfaceAt(SILK_HALF_X + 0.14, 0)],
    ['outer bead of the frame', board.surfaceAt(SILK_HALF_X + 1.0, 0)],
  ] as const;
  for (const [name, h] of heights) {
    process.stdout.write(`      heightAt ${name.padEnd(30)} = ${fmt(h)}\n`);
  }
  near('frame width matches the profile', FRAME_WIDTH, 1.02, 1e-9);
}

// ---------------------------------------------------------------------------

section('grid incisions land on coords.ts');

{
  const geo = (board.parts.incisions as THREE.Mesh).geometry;
  const pos = geo.getAttribute('position');
  // Bucket the incision vertices by XZ cell so the 90-point search is not
  // 90 x 60000.
  const CELL = 0.25;
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const k = `${Math.round(x / CELL)}:${Math.round(z / CELL)}`;
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(i);
  }

  let worst = -1;
  let worstAt = '';
  let worstDepth = 0;
  for (let r = 0; r < RANKS; r++) {
    for (let f = 0; f < FILES; f++) {
      const x = worldX(f);
      const z = worldZ(r);
      let best = Infinity;
      let bestY = 0;
      const cx = Math.round(x / CELL);
      const cz = Math.round(z / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const arr = buckets.get(`${cx + dx}:${cz + dz}`);
          if (!arr) continue;
          for (const i of arr) {
            const d = Math.hypot(pos.getX(i) - x, pos.getZ(i) - z);
            if (d < best) {
              best = d;
              bestY = pos.getY(i);
            }
          }
        }
      }
      if (best > worst) {
        worst = best;
        worstAt = `f${f} r${r}`;
        worstDepth = bestY - silkSag(x, z);
      }
    }
  }
  check(
    'a groove vertex sits on every intersection',
    worst < 2e-5,
    `worst XZ miss ${worst.toExponential(2)} at ${worstAt}; that vertex is ${fmt(worstDepth)} below the silk`,
  );

  // And that vertex is at the bottom of the vee, not on a lip.
  let deepest = 0;
  let shallowest = 0;
  for (let r = 0; r < RANKS; r++) {
    for (let f = 0; f < FILES; f++) {
      const x = worldX(f);
      const z = worldZ(r);
      let best = Infinity;
      let bestY = 0;
      const cx = Math.round(x / CELL);
      const cz = Math.round(z / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const arr = buckets.get(`${cx + dx}:${cz + dz}`);
          if (!arr) continue;
          for (const i of arr) {
            const d = Math.hypot(pos.getX(i) - x, pos.getZ(i) - z);
            if (d < best) {
              best = d;
              bestY = pos.getY(i);
            }
          }
        }
      }
      const depth = silkSag(x, z) - bestY;
      deepest = Math.max(deepest, depth);
      shallowest = shallowest === 0 ? depth : Math.min(shallowest, depth);
    }
  }
  between('groove depth at intersections', shallowest, 0.008, 0.016);
  between('groove depth at intersections (max)', deepest, 0.008, 0.016);

  // The vee's walls must be real walls: measure the angle one of them makes with
  // the board plane, which is what decides whether the key light can separate
  // them at all.
  {
    // A window on the rank-5 groove one third of the way along a span, so no
    // file line is anywhere near it. Measuring the *width* of the vertex cloud
    // rather than the offset from the nominal centreline cancels the line's bow.
    const zLine = worldZ(5);
    let lipY = -Infinity;
    let bottomY = Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let n = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      if (x < 2.3 || x > 2.37) continue;
      const z = pos.getZ(i);
      if (Math.abs(z - zLine) > 0.05) continue;
      n++;
      if (pos.getY(i) > lipY) lipY = pos.getY(i);
      if (pos.getY(i) < bottomY) bottomY = pos.getY(i);
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const halfWidth = (maxZ - minZ) / 2;
    const deckY = silkSag(2.333, zLine);
    const wallAngle = (Math.atan2(lipY - bottomY, halfWidth) * 180) / Math.PI;
    check(
      'groove lips stand proud of the deck (no z-fight with the silk)',
      n > 0 && lipY > deckY,
      `${n} vertices; lip ${fmt(lipY)} vs deck ${fmt(deckY)}, burr ${fmt(lipY - deckY)}`,
    );
    between('groove wall angle from the board plane', wallAngle, 25, 65);
    process.stdout.write(
      `      vee at rank 5, x≈2.33: half-width ${fmt(halfWidth)}, depth ${fmt(lipY - bottomY)}, wall ${fmt(wallAngle)}° off the plane\n`,
    );
  }

  // Palace diagonals must terminate on palace corners.
  let worstPalace = 0;
  for (const [ax, az, bxx, bz] of palaceDiagonals()) {
    for (const [px, pz] of [
      [ax, az],
      [bxx, bz],
    ]) {
      let best = Infinity;
      for (let i = 0; i < pos.count; i++) {
        const d = Math.hypot(pos.getX(i) - px, pos.getZ(i) - pz);
        if (d < best) best = d;
        if (best < 1e-6) break;
      }
      worstPalace = Math.max(worstPalace, best);
    }
  }
  check('palace diagonals end on palace corners', worstPalace < 2e-5, `worst ${worstPalace.toExponential(2)}`);

  // Interior files must be broken at the river; outer files must not.
  const zBank = worldZ(4);
  let interiorCross = 0;
  let outerCross = 0;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    if (Math.abs(z) > Math.abs(zBank) - 0.02) continue;
    if (Math.abs(z) < 0.02) continue; // rank lines do not exist here anyway
    const x = pos.getX(i);
    const f = Math.round(x + (FILES - 1) / 2);
    if (Math.abs(worldX(f) - x) > 0.05) continue;
    if (f === 0 || f === FILES - 1) outerCross++;
    else interiorCross++;
  }
  check(
    'the river breaks the interior files',
    interiorCross === 0,
    `${interiorCross} interior-file vertices inside the river band`,
  );
  check(
    'the outer files run the full length',
    outerCross > 0,
    `${outerCross} outer-file vertices inside the river band`,
  );
}

// ---------------------------------------------------------------------------

section('bases and the incised glyph');

{
  const blank = new Board({ materials, detail: 'low' });
  blank.bases.add(0, Side.Red, PieceType.General);
  const blankTris = blank.bases.triangles;
  const glyphTris = board.bases.triangles;
  check(
    'a glyph provider adds real incision geometry',
    glyphTris > blankTris * 2,
    `${Math.round(glyphTris)} tris across 14 base geometries vs ${Math.round(blankTris)} for one blank`,
  );
  check(
    'a missing glyph provider degrades to a blank plinth',
    blankTris > 200 && Number.isFinite(blankTris),
    `${Math.round(blankTris)} tris`,
  );
  blank.dispose();

  board.bases.setPosition(0, 1.5, -2.5);
  near('base follows its piece', board.heightAt(1.5, -2.5), silkSag(1.5, -2.5) + BASE_TOP_Y, 1e-9);
  board.bases.setScale(0, 0);
  near('a scaled-out base stops contributing', board.heightAt(1.5, -2.5), silkSag(1.5, -2.5), 1e-9);
  board.bases.setScale(0, 1);
  board.bases.setSquare(0, sq(4, 9));
}

// ---------------------------------------------------------------------------

section('glyph adapter and marks');

{
  // The adapter is what the integration layer wires @ui/seal.ts through, so it
  // has to survive whatever shape that module settles on.
  const square = [0, 0, 1, 0, 1, 1, 0, 1];
  const asPoints = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  check('adapter: bare array of flat contours', adaptGlyphPath([square])?.contours.length === 1, 'ok');
  check('adapter: { contours }', adaptGlyphPath({ contours: [square] })?.contours.length === 1, 'ok');
  check('adapter: { paths } alias', adaptGlyphPath({ paths: [square] })?.contours.length === 1, 'ok');
  check('adapter: arrays of {x,y} points', adaptGlyphPath([asPoints])?.contours.length === 1, 'ok');
  check('adapter: explicit hole flags survive', adaptGlyphPath({ contours: [square, square], holes: [false, true] })?.holes?.[1] === true, 'ok');
  check('adapter: junk yields null, not a throw', adaptGlyphPath({ nope: 1 }) === null && adaptGlyphPath(null) === null, 'ok');
  check('adapter: contours too short are dropped', adaptGlyphPath([[0, 0, 1, 1]]) === null, 'ok');

  // Legal marks: stage in, then retire.
  const targets = [sq(0, 5), sq(1, 5), sq(2, 5), sq(3, 5)];
  board.showLegalMarks(targets);
  const legal = board.markers.group.getObjectByName('scene/markers/legal') as THREE.InstancedMesh;
  check('legal marks appear', legal.count === targets.length, `${legal.count} instances`);
  for (let i = 0; i < 60; i++) board.update(1 / 60);
  const m = new THREE.Matrix4();
  const s = new THREE.Vector3();
  legal.getMatrixAt(3, m);
  m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
  near('the last mark reaches full size', s.x, 1, 0.01);
  board.clearLegalMarks();
  for (let i = 0; i < 60; i++) board.update(1 / 60);
  check('legal marks retire completely', legal.count === 0, `${legal.count} instances`);

  // Hover slides to the square rather than jumping.
  board.setHover(sq(4, 5));
  for (let i = 0; i < 60; i++) board.update(1 / 60);
  const hover = board.markers.group.getObjectByName('scene/markers/hover') as THREE.Mesh;
  near('hover ring lands on its square (x)', hover.position.x, worldX(4), 0.01);
  near('hover ring lands on its square (z)', hover.position.z, worldZ(5), 0.01);
  check('hover ring floats clear of the board', hover.position.y > board.surfaceAt(worldX(4), worldZ(5)), `${fmt(hover.position.y)}`);
  board.setHover(null);
  for (let i = 0; i < 90; i++) board.update(1 / 60);
  check('hover ring leaves', hover.visible === false, 'hidden');

  // Check pulse.
  board.setCheck(sq(4, 0));
  for (let i = 0; i < 30; i++) board.update(1 / 60);
  const chk = board.markers.group.getObjectByName('scene/markers/check') as THREE.Mesh;
  const a = chk.scale.x;
  for (let i = 0; i < 18; i++) board.update(1 / 60);
  const b2 = chk.scale.x;
  check('check mark pulses', Math.abs(a - b2) > 0.01, `scale ${fmt(a)} -> ${fmt(b2)}`);
  board.setCheck(null);

  board.setLastMove(sq(1, 7), sq(4, 7));
  const rings = board.markers.group.getObjectByName('scene/markers/lastMove') as THREE.InstancedMesh;
  check('last move leaves two marks', rings.count === 2, `${rings.count} instances`);

  // Growing a base bucket past a standard game's piece count.
  const extra = new Board({ materials, detail: 'low' });
  for (let i = 0; i < 8; i++) {
    extra.bases.add(100 + i, Side.Red, PieceType.Soldier);
    extra.bases.setPosition(100 + i, i * 0.9 - 3.6, 1.0);
  }
  near('a grown bucket still reports the right height', extra.heightAt(-3.6, 1.0), silkSag(-3.6, 1.0) + BASE_TOP_Y, 1e-9);
  near('and so does its eighth instance', extra.heightAt(2.7, 1.0), silkSag(2.7, 1.0) + BASE_TOP_Y, 1e-9);
  extra.bases.remove(103);
  near('a removed base stops contributing', extra.heightAt(-0.9, 1.0), silkSag(-0.9, 1.0), 1e-9);
  extra.dispose();
}

// ---------------------------------------------------------------------------

section('backdrop');

{
  const backdrop = new Backdrop({ materials, detail: 'high' });
  process.stdout.write(`      ${Math.round(backdrop.triangles)} tris total\n`);
  check('backdrop is cheap', backdrop.triangles < 40_000, `${Math.round(backdrop.triangles)} tris`);
  const box = new THREE.Box3().setFromObject(backdrop.group);
  process.stdout.write(
    `      bbox  x[${fmt(box.min.x)}, ${fmt(box.max.x)}]  y[${fmt(box.min.y)}, ${fmt(box.max.y)}]\n`,
  );
  check('backdrop encloses the camera', box.max.x > 250 && box.min.x < -250, `half-extent ${fmt(box.max.x)}`);
  check('terrace sits just under the table', OFF_BOARD_Y < TABLE_BOTTOM_Y + 0.02, `${fmt(OFF_BOARD_Y)} vs ${fmt(TABLE_BOTTOM_Y)}`);
  check('the lake is below the terrace', LAKE_Y < OFF_BOARD_Y - 1, `lake ${fmt(LAKE_Y)}, terrace ${fmt(OFF_BOARD_Y)}`);
  check('terrace clears the table corners', TERRACE_RADIUS > Math.hypot(TABLE_HALF_X, TABLE_HALF_Z), `${fmt(TERRACE_RADIUS)} > ${fmt(Math.hypot(TABLE_HALF_X, TABLE_HALF_Z))}`);
  backdrop.dispose();
}

// ---------------------------------------------------------------------------

section('shaders');

{
  /**
   * There is no GL context in node, so the GLSL cannot actually be compiled
   * here. What *can* be checked without one is the whole class of mistake that
   * produces a silently black surface rather than an exception:
   *
   *   - an `#include <chunk>` that does not name a real ShaderChunk;
   *   - re-including one of the `*_pars_*` chunks that three already injects
   *     into every ShaderMaterial prefix, which is a duplicate function
   *     definition and a link failure;
   *   - a uniform declared in the GLSL with no matching entry in the uniforms
   *     object, or the reverse — a typo on either side is invisible until the
   *     surface renders wrong;
   *   - a varying read in the fragment shader that the vertex shader never
   *     writes, or writes at a different type.
   */
  const INJECTED_BY_THREE = new Set([
    'colorspace_pars_fragment',
    'tonemapping_pars_fragment',
  ]);
  const BUILTIN_UNIFORMS = new Set([
    'modelMatrix',
    'modelViewMatrix',
    'projectionMatrix',
    'viewMatrix',
    'normalMatrix',
    'cameraPosition',
    'isOrthographic',
  ]);

  const auditShader = (label: string, mat: THREE.ShaderMaterial) => {
    const problems: string[] = [];
    const sources = { vertex: mat.vertexShader, fragment: mat.fragmentShader };

    for (const [stage, src] of Object.entries(sources)) {
      for (const m of src.matchAll(/^[ \t]*#include\s+<(\w+)>/gm)) {
        const name = m[1];
        if (!(name in THREE.ShaderChunk)) problems.push(`${stage}: unknown chunk <${name}>`);
        else if (INJECTED_BY_THREE.has(name)) {
          problems.push(`${stage}: <${name}> is already in three's prefix — duplicate definition`);
        }
      }
      let depth = 0;
      for (const ch of src) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        if (depth < 0) break;
      }
      if (depth !== 0) problems.push(`${stage}: unbalanced braces (${depth})`);
    }

    // Uniforms declared in GLSL vs supplied on the material.
    const declared = new Set<string>();
    for (const src of Object.values(sources)) {
      for (const m of src.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/gm)) {
        if (!BUILTIN_UNIFORMS.has(m[1])) declared.add(m[1]);
      }
    }
    const supplied = new Set(Object.keys(mat.uniforms));
    for (const d of declared) if (!supplied.has(d)) problems.push(`uniform ${d} declared but not supplied`);
    for (const s of supplied) if (!declared.has(s)) problems.push(`uniform ${s} supplied but never declared`);

    // Varyings: the fragment shader may only read what the vertex shader writes.
    const varyingsOf = (src: string) => {
      const out = new Map<string, string>();
      for (const m of src.matchAll(/^\s*varying\s+(\w+)\s+(\w+)\s*;/gm)) out.set(m[2], m[1]);
      return out;
    };
    const vv = varyingsOf(sources.vertex);
    const fv = varyingsOf(sources.fragment);
    for (const [name, type] of fv) {
      if (!vv.has(name)) problems.push(`varying ${name} read in fragment but never written`);
      else if (vv.get(name) !== type) problems.push(`varying ${name} is ${vv.get(name)} / ${type}`);
    }
    for (const [name] of vv) {
      if (!fv.has(name)) problems.push(`varying ${name} written but never read`);
    }

    report(
      `${label} shader is well formed`,
      problems.length ? problems.join('; ') : `${declared.size} uniforms, ${vv.size} varyings, all matched`,
      problems.length === 0,
    );
  };

  const waterMat = (board.parts.water as THREE.Mesh).material as THREE.ShaderMaterial;
  auditShader('river water', waterMat);
  const bd = new Backdrop({ materials, detail: 'low' });
  const skyMesh = bd.group.getObjectByName('sky') as THREE.Mesh;
  auditShader('sky        ', skyMesh.material as THREE.ShaderMaterial);

  // The water shader has to be driven by the shared clock, never a wall clock.
  const before = waterMat.uniforms.uTime.value as number;
  board.update(0.25);
  const after = waterMat.uniforms.uTime.value as number;
  near('water flow advances by exactly dt', after - before, 0.25, 1e-12);
  board.update(0);
  near('and a zero step moves nothing', waterMat.uniforms.uTime.value as number, after, 1e-12);

  // Silhouette mode has to reach the shaders, not just hide meshes.
  board.setSilhouetteMode(true);
  check('silhouette mode reaches the water', waterMat.uniforms.uSilhouette.value === 1, 'uSilhouette = 1');
  check('silhouette mode hides the marks', board.markers.group.visible === false, 'markers hidden');
  board.setSilhouetteMode(false);
  check('and it comes back off', waterMat.uniforms.uSilhouette.value === 0, 'uSilhouette = 0');
  bd.dispose();
}

// ---------------------------------------------------------------------------

section('lighting');

{
  const rig = new LightingRig({ initial: 'wide' });
  near('wide key intensity', rig.state.keyIntensity, MOODS.wide.keyIntensity, 1e-9);
  const wideElev = rig.key.position.y / rig.key.position.length();
  near('key elevation matches the mood', Math.asin(wideElev), MOODS.wide.keyElevation, 1e-6);

  rig.setMood('endgame', 2.0);
  near('cross-fade starts at the old mood', rig.state.keyIntensity, MOODS.wide.keyIntensity, 1e-9);
  rig.update(1.0);
  const mid = rig.state.keyIntensity;
  check(
    'cross-fade is genuinely between the two',
    mid < MOODS.wide.keyIntensity && mid > MOODS.endgame.keyIntensity,
    `${fmt(mid)} between ${fmt(MOODS.endgame.keyIntensity)} and ${fmt(MOODS.wide.keyIntensity)}`,
  );
  rig.update(1.0);
  near('cross-fade lands on the target mood', rig.state.keyIntensity, MOODS.endgame.keyIntensity, 1e-6);
  near('and on its elevation', rig.state.keyElevation, MOODS.endgame.keyElevation, 1e-6);
  const spec = rig.csmSpec();
  near('cascade split 0 stretched', spec.splits[0], 6 * MOODS.endgame.shadowStretch, 1e-4);
  near('cascade split 2 stretched', spec.splits[2], 34 * MOODS.endgame.shadowStretch, 1e-4);
  near('csm direction is a unit vector', spec.direction.length(), 1, 1e-6);
  check('key casts shadows', rig.key.castShadow, 'castShadow = true');
  rig.dispose();
}

// ---------------------------------------------------------------------------

section('camera springs');

{
  near(
    'return spring is 1.6x slower than the push',
    Math.sqrt(SPRING.push.stiffness) / Math.sqrt(SPRING.return.stiffness),
    RETURN_SLOWDOWN,
    0.01,
  );
  near(
    'rest spring is critically damped',
    SPRING.rest.damping / (2 * Math.sqrt(SPRING.rest.stiffness)),
    1,
    0.005,
  );
  between(
    'push spring is a hair underdamped',
    SPRING.push.damping / (2 * Math.sqrt(SPRING.push.stiffness)),
    0.88,
    0.96,
  );

  // Frame-rate independence: one 0.4 s step must equal 24 steps of 1/60.
  const mk = () => {
    const d = new Director({ aspect: 1.777 });
    d.setNamedPose('default', true);
    d.setNamedPose('endgame', false);
    return d;
  };
  const coarse = mk();
  const fine = mk();
  coarse.update(0.4);
  for (let i = 0; i < 24; i++) fine.update(1 / 60);
  const a = coarse.getPose();
  const b = fine.getPose();
  const diff = Math.max(
    Math.abs(a.distance - b.distance),
    Math.abs(a.pitch - b.pitch),
    Math.abs(a.yaw - b.yaw),
    Math.abs(a.fov - b.fov),
    Math.abs(a.target[1] - b.target[1]),
  );
  check(
    'springs integrate identically at any dt',
    diff < 1e-9,
    `1x0.4s vs 24x(1/60) differ by ${diff.toExponential(2)}`,
  );
  process.stdout.write(
    `      after 0.4 s: distance ${fmt(a.distance)}, pitch ${fmt(a.pitch)}, fov ${fmt(a.fov)}\n`,
  );

  // No overshoot on a critically damped channel.
  const d2 = new Director({ aspect: 1.777 });
  d2.setPose({ target: [0, 0, 0], distance: 10, pitch: 0.8, yaw: 0, fov: 38 }, true);
  d2.setPose({ target: [0, 0, 0], distance: 18, pitch: 0.8, yaw: 0, fov: 38 }, false);
  let maxDist = 0;
  for (let i = 0; i < 600; i++) {
    d2.update(1 / 60);
    maxDist = Math.max(maxDist, d2.getPose().distance);
  }
  near('critically damped channel does not overshoot', maxDist, 18, 0.02);
  near('and it arrives', d2.getPose().distance, 18, 0.01);
  d2.dispose();
  coarse.dispose();
  fine.dispose();
}

// ---------------------------------------------------------------------------

section('camera event pushes');

async function pushTests(): Promise<void> {
  const d = new Director({ aspect: 1.777 });
  d.setMode('wide');
  for (let i = 0; i < 240; i++) d.update(1 / 60);
  const before = d.getPose();

  let landed = false;
  let landedAt = 0;
  const p = d.pushToCapture(sq(1, 7), sq(1, 2)).then(() => {
    landed = true;
  });
  for (let i = 0; i < 300 && !landed; i++) {
    d.update(1 / 60);
    landedAt += 1 / 60;
    await Promise.resolve();
  }
  await p;
  const after = d.getPose();

  check('pushToCapture resolves', landed, `landed after ${fmt(landedAt)} s`);
  between('push lands in a cinematic window', landedAt, 0.15, 1.1);
  between('over-the-shoulder pitch keeps the horizon level', after.pitch, 0.15, 0.42);
  between('over-the-shoulder distance', after.distance, 1.5, 9);
  let yawSwing = Math.abs(after.yaw - before.yaw);
  while (yawSwing > Math.PI) yawSwing = Math.abs(yawSwing - Math.PI * 2);
  check(
    'the push does not cross the axis of action',
    yawSwing < Math.PI / 2,
    `yaw swung ${fmt(yawSwing)} rad (${fmt((yawSwing * 180) / Math.PI)}°)`,
  );
  process.stdout.write(
    `      framing: target [${after.target.map(fmt).join(', ')}] d=${fmt(after.distance)} pitch=${fmt(after.pitch)} yaw=${fmt(after.yaw)} fov=${fmt(after.fov)}\n`,
  );

  // The way back out must be slower than the way in.
  d.release();
  let backAt = 0;
  for (let i = 0; i < 600; i++) {
    d.update(1 / 60);
    backAt += 1 / 60;
    const pose = d.getPose();
    if (Math.abs(pose.distance - 15.0) < (Math.abs(after.distance - 15.0) * PUSH_LAND_FRACTION)) break;
  }
  check(
    'the return is slower than the push',
    backAt > landedAt * 1.35,
    `push ${fmt(landedAt)} s, return ${fmt(backAt)} s (ratio ${fmt(backAt / landedAt)})`,
  );

  // A superseded push must not leave a promise hanging.
  let firstSettled = false;
  const first = d.pushToCapture(sq(0, 9), sq(0, 0)).then(() => {
    firstSettled = true;
  });
  d.pushToCapture(sq(8, 9), sq(8, 0));
  await Promise.resolve();
  await first;
  check('a superseded push resolves rather than leaking', firstSettled, 'resolved');

  // Check push: a dolly, not a swing.
  d.release();
  for (let i = 0; i < 240; i++) d.update(1 / 60);
  const yawBefore = d.getPose().yaw;
  d.pushToCheck(sq(4, 0));
  for (let i = 0; i < 120; i++) d.update(1 / 60);
  const chk = d.getPose();
  near('check push keeps its yaw (a dolly, not a swing)', chk.yaw, yawBefore, 1e-9);
  between('check push distance', chk.distance, 4.5, 6.5);
  near('check push targets the general', chk.target[0], worldX(4), 0.05);
  near('check push targets the general (z)', chk.target[2], worldZ(0), 0.15);

  // Soft limits: push past them, then let go.
  d.setUserControl(true);
  d.setPose({ target: [0, 0.35, 0], distance: 16, pitch: 1.0, yaw: 0, fov: 38 }, true);
  const settledPose = d.getPose();
  check('setPose immediate is exact', Math.abs(settledPose.distance - 16) < 1e-9, `${fmt(settledPose.distance)}`);

  // Shake introduces no roll.
  d.impulse(1.0);
  for (let i = 0; i < 10; i++) d.update(1 / 60);
  const up = d.camera.up.clone();
  near('camera up stays world +Y (no roll)', up.dot(new THREE.Vector3(0, 1, 0)), 1, 1e-9);
  const m = new THREE.Matrix4().extractRotation(d.camera.matrixWorld);
  const camRight = new THREE.Vector3(1, 0, 0).applyMatrix4(m);
  check('camera right stays horizontal', Math.abs(camRight.y) < 1e-6, `right.y = ${camRight.y.toExponential(2)}`);

  d.dispose();
}

// ---------------------------------------------------------------------------

async function rigTests(): Promise<void> {
  section('scene rig (the path main.ts takes)');

  const rig = createSceneRig({
    materials,
    seal: () => testOutline(),
    riverText: () => testOutline(),
    detail: 'medium',
    aspect: 16 / 9,
  });

  check('rig root holds board, backdrop and lights', rig.root.children.length === 3, `${rig.root.children.length} children`);
  check('rig exposes the camera', rig.camera.isPerspectiveCamera === true, `fov ${fmt(rig.camera.fov)}`);
  check(
    'a riverText provider carves the banking',
    !!rig.board.parts.riverText && tris(rig.board.parts.riverText) > 20,
    `${rig.board.parts.riverText ? tris(rig.board.parts.riverText) : 0} tris of inscription`,
  );

  const st = rig.stats();
  process.stdout.write(
    `      medium detail: ${Math.round(st.triangles)} board tris in ${st.meshes} meshes, ${Math.round(st.backdropTriangles)} backdrop tris\n`,
  );

  // The lighting rig must reach the water and sky shaders, not just the lights.
  const waterMat = (rig.board.parts.water as THREE.Mesh).material as THREE.ShaderMaterial;
  const gradeBefore = waterMat.uniforms.uGradeAmount.value as number;
  rig.setPhase('endgame', 1.0);
  for (let i = 0; i < 90; i++) rig.update(1 / 60);
  const gradeAfter = waterMat.uniforms.uGradeAmount.value as number;
  near('the mood grade reaches the water shader', gradeAfter, MOODS.endgame.gradeAmount, 1e-6);
  check('and it actually moved', Math.abs(gradeAfter - gradeBefore) > 0.05, `${fmt(gradeBefore)} -> ${fmt(gradeAfter)}`);
  near('the key light followed the same mood', rig.lighting.state.keyElevation, MOODS.endgame.keyElevation, 1e-6);
  near('and the camera took the endgame framing', rig.director.getPose().pitch, 0.42, 0.02);

  // Terminal: the slow arc has to keep turning.
  rig.director.setTerminalFocus(sq(4, 0));
  rig.director.setMode('terminal', 0.5);
  for (let i = 0; i < 120; i++) rig.update(1 / 60);
  const yaw0 = rig.director.getPose().yaw;
  for (let i = 0; i < 120; i++) rig.update(1 / 60);
  const yaw1 = rig.director.getPose().yaw;
  check('terminal mode arcs', Math.abs(yaw1 - yaw0) > 0.05, `yaw ${fmt(yaw0)} -> ${fmt(yaw1)} over 2 s`);
  near('and it arcs around the fallen general', rig.director.getPose().target[2], worldZ(0), 0.2);

  // A capture during the terminal set piece must hand the arc back on release.
  // NOTE: the push promise resolves from inside `update()`, so it has to be
  // driven, not merely awaited — awaiting it on a stalled clock is a deadlock,
  // and the choreographer must interleave the same way.
  {
    let done = false;
    const p = rig.director.pushToCapture(sq(3, 0), sq(4, 0)).then(() => {
      done = true;
    });
    for (let i = 0; i < 300 && !done; i++) {
      rig.update(1 / 60);
      await Promise.resolve();
    }
    await p;
    check('a push fired during the terminal arc lands', done, 'resolved');
  }
  rig.director.release();
  for (let i = 0; i < 120; i++) rig.update(1 / 60);
  const yaw2 = rig.director.getPose().yaw;
  for (let i = 0; i < 120; i++) rig.update(1 / 60);
  check(
    'the arc resumes after an event push releases',
    Math.abs(rig.director.getPose().yaw - yaw2) > 0.05,
    `yaw moved ${fmt(Math.abs(rig.director.getPose().yaw - yaw2))} rad in 2 s`,
  );

  // Formation tracking.
  rig.director.setMode('formation');
  rig.director.setTrackTarget(0, 3.2, 0.4);
  for (let i = 0; i < 90; i++) rig.update(1 / 60);
  near('formation tracking moves the orbit target', rig.director.getPose().target[2], 3.2, 0.05);

  // The height field is what the animator binds to.
  near('rig.heightAt matches board.heightAt', rig.heightAt(1.0, 1.0), rig.board.heightAt(1.0, 1.0), 1e-12);

  rig.setSilhouetteMode(true);
  check('rig silhouette mode reaches everything', waterMat.uniforms.uSilhouette.value === 1 && rig.backdrop.group.children.length === 3, 'set');
  rig.setSilhouetteMode(false);

  rig.resize(1920, 1080);
  near('resize sets the aspect', rig.camera.aspect, 1920 / 1080, 1e-9);

  rig.dispose();
  check('rig disposes cleanly', rig.root.children.length === 0, 'root emptied');
}

async function main(): Promise<void> {
  await pushTests();
  await rigTests();

  section('summary');
  process.stdout.write(`      ${passes} checks passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) process.stdout.write(`      FAIL: ${f}\n`);
    process.exitCode = 1;
  }
  board.dispose();
  materials.dispose();
}

void main();
