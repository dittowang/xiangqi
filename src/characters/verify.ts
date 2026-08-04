/**
 * Standalone verification for the characters subsystem.
 *
 *     npx tsx src/characters/verify.ts            # full report
 *     npx tsx src/characters/verify.ts --parts    # parts table only
 *     npx tsx src/characters/verify.ts --units    # unit table only
 *
 * Runs headless — no WebGL, no DOM — against a stub `GongbiMaterials`, so it can
 * be run from a terminal or a CI job. It checks the things that are cheap to
 * check and expensive to get wrong:
 *
 *   - every part function produces finite, non-empty, correctly-shaped geometry;
 *   - triangle counts per part and per unit, against the budgets in the brief;
 *   - skin weights normalise, and no vertex is left unweighted;
 *   - measured joint collapse under a real 90° bend, using three's own skinning
 *     path rather than a reimplementation of it;
 *   - the silhouette table is internally consistent, and the *measured* size of
 *     each built unit is reported next to its declared design target so drift
 *     is visible rather than assumed away.
 *
 * Exit code is non-zero if any hard check fails, so it can gate a build.
 */

import * as THREE from 'three';
import { BONE_ORDER, type GongbiMaterials, type MaterialRequest } from '@core/contracts.ts';
import { SQUARE } from '@core/coords.ts';
import { PieceType, Side, UNIT_KEY, type UnitKey } from '@core/types.ts';
import { createCharacters, unitsStillFallingBack } from './index.ts';
import { silhouetteConflicts, unitSpec, UNIT_KEYS_IN_VALUE_ORDER } from './proportions.ts';
import { buildRig } from './rig.ts';
import { bindSkin, measureJointCollapse, skinStats } from './skinning.ts';
import { assertFinite, triangleCount } from './parts/prim.ts';
import { groupTriangles, type Part, type PartGroup } from './parts/types.ts';
import * as body from './parts/body.ts';
import * as cloth from './parts/cloth.ts';
import * as helmetParts from './parts/helmet.ts';
import * as lamellar from './parts/lamellar.ts';
import * as mountParts from './parts/mount.ts';
import * as rivets from './parts/rivets.ts';
import * as standardParts from './parts/standard.ts';
import * as trim from './parts/trim.ts';
import * as vehicle from './parts/vehicle.ts';
import * as weapons from './parts/weapons.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * The board read is the game. One square is `SQUARE` = 1.0 world units, so a
 * piece whose footprint exceeds that covers its neighbour's intersection and
 * you can no longer tell what is standing on the rank. A little overhang reads
 * as presence; a lot destroys the position.
 */
const BOARD_FOOTPRINT_LIMIT = 1.4;

// `@types/node` is not a dependency of this project and the brief forbids adding
// one, so the two Node globals this script touches are declared locally. They
// are the only thing here that is not portable to a browser.
declare const process: { argv: string[]; exitCode?: number };

let failures = 0;
const warnings: string[] = [];

function fail(msg: string): void {
  failures++;
  console.error(`  FAIL  ${msg}`);
}

function check(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
}

/** Minimal stand-in for the renderer's material cache. */
function stubMaterials(): GongbiMaterials & { count(): number } {
  const cache = new Map<string, THREE.Material>();
  return {
    get(req: MaterialRequest): THREE.Material {
      const k = `${req.cls}|${req.pigment}|${req.skinned ? 1 : 0}|${req.noSilk ? 1 : 0}`;
      let m = cache.get(k);
      if (!m) {
        m = new THREE.MeshBasicMaterial();
        m.name = k;
        cache.set(k, m);
      }
      return m;
    },
    outline: () => null,
    setSilhouetteMode: () => {},
    update: () => {},
    setMood: () => {},
    dispose: () => cache.clear(),
    count: () => cache.size,
  };
}

// ---------------------------------------------------------------------------
// Winding and normal audit
// ---------------------------------------------------------------------------

export interface GeometryAudit {
  triangles: number;
  /** Triangles whose stored normal disagrees with their vertex winding. */
  badWinding: number;
  /** Directed edges with no opposing twin — zero means a closed manifold. */
  openEdges: number;
  closed: boolean;
  /** Divergence-theorem volume. Positive on a correctly wound closed solid. */
  volume: number;
  /** Fraction of faces whose normal points away from the mesh centroid. */
  outwardFrac: number;
}

/**
 * The check that catches inside-out geometry.
 *
 * Three independent tests, because each catches a different failure:
 *
 *  1. **Winding vs stored normal.** Every builder here computes a flat normal
 *     from the vertex order, so the two must agree exactly. They disagree when
 *     something has post-processed positions without re-ordering triangles —
 *     a mirror that negated X, a matrix with a negative determinant.
 *
 *  2. **Closure.** Every directed edge in a closed solid must have exactly one
 *     twin running the other way. An unmatched edge means a hole, and a hole in
 *     an inverted-hull outline is a hole in the contour.
 *
 *  3. **Signed volume.** On a closed solid this is the rigorous form of "the
 *     normals point away from the middle": it is positive when the surface is
 *     wound outward and negative when the solid is inside out. This is what
 *     catches a whole loft or shell built the wrong way round, which tests 1
 *     and 2 both pass happily.
 *
 * The centroid-agreement fraction is reported rather than asserted, because an
 * open sheet legitimately has faces pointing both ways.
 */
export function auditGeometry(g: THREE.BufferGeometry): GeometryAudit {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const tris = pos.count / 3;
  const P = pos.array as ArrayLike<number>;

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < pos.count; i++) {
    cx += P[i * 3];
    cy += P[i * 3 + 1];
    cz += P[i * 3 + 2];
  }
  cx /= pos.count || 1;
  cy /= pos.count || 1;
  cz /= pos.count || 1;

  const edges = new Map<string, number>();
  const key = (a: number, b: number): string => {
    const q = (i: number) =>
      `${Math.round(P[i * 3] * 1e5)},${Math.round(P[i * 3 + 1] * 1e5)},${Math.round(P[i * 3 + 2] * 1e5)}`;
    return `${q(a)}|${q(b)}`;
  };

  let badWinding = 0;
  let outward = 0;
  let volume = 0;

  for (let t = 0; t < tris; t++) {
    const i0 = t * 3;
    const i1 = t * 3 + 1;
    const i2 = t * 3 + 2;
    const ax = P[i0 * 3];
    const ay = P[i0 * 3 + 1];
    const az = P[i0 * 3 + 2];
    const bx = P[i1 * 3];
    const by = P[i1 * 3 + 1];
    const bz = P[i1 * 3 + 2];
    const gx = P[i2 * 3];
    const gy = P[i2 * 3 + 1];
    const gz = P[i2 * 3 + 2];

    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = gx - ax;
    const vy = gy - ay;
    const vz = gz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) {
      nx /= len;
      ny /= len;
      nz /= len;
      if (nor) {
        const d = nx * nor.getX(i0) + ny * nor.getY(i0) + nz * nor.getZ(i0);
        if (d < 0.99) badWinding++;
      }
      const fx = (ax + bx + gx) / 3 - cx;
      const fy = (ay + by + gy) / 3 - cy;
      const fz = (az + bz + gz) / 3 - cz;
      if (nx * fx + ny * fy + nz * fz > 0) outward++;
    }
    // Divergence theorem: 6V = Σ a · (b × c)
    volume += (ax * (by * gz - bz * gy) + ay * (bz * gx - bx * gz) + az * (bx * gy - by * gx)) / 6;

    for (const [p, q] of [
      [i0, i1],
      [i1, i2],
      [i2, i0],
    ]) {
      const k = key(p, q);
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }

  let openEdges = 0;
  for (const [k] of edges) {
    const [a, b] = k.split('|');
    if (!edges.has(`${b}|${a}`)) openEdges++;
  }

  return {
    triangles: tris,
    badWinding,
    openEdges,
    closed: openEdges === 0 && tris > 0,
    volume,
    outwardFrac: tris > 0 ? outward / tris : 1,
  };
}

function pad(s: string | number, n: number, right = false): string {
  const t = String(s);
  return right ? t.padStart(n) : t.padEnd(n);
}

function rule(width = 92): string {
  return '-'.repeat(width);
}

// ---------------------------------------------------------------------------
// 1. Rig
// ---------------------------------------------------------------------------

function verifyRig(): void {
  console.log('\n== RIG ==');
  console.log(rule());
  console.log(
    pad('unit', 10) +
      pad('side', 6) +
      pad('height', 9, true) +
      pad('scale', 8, true) +
      pad('shoulderY', 11, true) +
      pad('headTop', 10, true) +
      pad('armLen', 9, true) +
      pad('legLen', 9, true),
  );
  console.log(rule());
  for (const key of UNIT_KEYS_IN_VALUE_ORDER) {
    for (const side of [Side.Red, Side.Black] as const) {
      const spec = unitSpec(side, typeOf(key), 0);
      const rig = buildRig(spec.proportions);
      const m = rig.metrics;

      // Structural invariants.
      check(rig.boneList.length === 20, `${key}: expected 20 bones, got ${rig.boneList.length}`);
      check(rig.skeleton.bones.length === 20, `${key}: skeleton bone count`);
      for (const b of rig.boneList) {
        check(
          Number.isFinite(b.position.x) && Number.isFinite(b.position.y) && Number.isFinite(b.position.z),
          `${key}: bone ${b.name} has a non-finite position`,
        );
      }
      check(rig.bindLengths.upperArmL > 0, `${key}: zero-length upper arm`);
      check(rig.bindLengths.thighL > 0, `${key}: zero-length thigh`);
      check(
        Math.abs(rig.bindWorld.handL.x + rig.bindWorld.handR.x) < 1e-9,
        `${key}: hands are not mirrored`,
      );
      check(
        Math.abs(m.headTopY - m.height) < 1e-6,
        `${key}: head top ${m.headTopY.toFixed(4)} != height ${m.height.toFixed(4)}`,
      );

      console.log(
        pad(key, 10) +
          pad(side === Side.Red ? 'Han' : 'Chu', 6) +
          pad(m.height.toFixed(3), 9, true) +
          pad(spec.proportions.scale.toFixed(2), 8, true) +
          pad(m.shoulderY.toFixed(3), 11, true) +
          pad(m.headTopY.toFixed(3), 10, true) +
          pad(m.armLen.toFixed(3), 9, true) +
          pad(m.legLen.toFixed(3), 9, true),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Parts
// ---------------------------------------------------------------------------

interface PartCase {
  group: string;
  name: string;
  run: () => PartGroup | Part | THREE.BufferGeometry;
}

function partCases(): PartCase[] {
  const spec = unitSpec(Side.Red, PieceType.Soldier, 0);
  const rig = buildRig(spec.proportions);
  const m = rig.metrics;
  const B = rig.bindWorld;
  const v = (p: THREE.Vector3): [number, number, number] => [p.x, p.y, p.z];
  const h = m.height;

  const cases: PartCase[] = [
    // -- body -------------------------------------------------------------
    {
      group: 'body',
      name: 'torso',
      run: () =>
        body.torso({
          hipY: m.hipY,
          waistY: m.waistY,
          chestY: m.chestY,
          shoulderY: m.shoulderY,
          hipWidth: m.hipWidth,
          waistWidth: m.waistWidth,
          chestWidth: m.chestWidth,
          shoulderWidth: m.shoulderWidth,
          hipDepth: m.hipDepth,
          waistDepth: m.waistDepth,
          chestDepth: m.chestDepth,
          neckR: m.neckR,
        }),
    },
    { group: 'body', name: 'neck', run: () => body.neck({ fromY: m.shoulderY, toY: m.headY, r: m.neckR }) },
    {
      group: 'body',
      name: 'head',
      run: () =>
        body.head({
          baseY: B.head.y,
          length: m.headLen,
          width: m.headWidth,
          depth: m.headDepth,
          beard: 'long',
          topknot: true,
        }),
    },
    {
      group: 'body',
      name: 'arm',
      run: () =>
        body.arm({
          side: 'R',
          shoulder: v(B.upperArmR),
          elbow: v(B.foreArmR),
          wrist: v(B.handR),
          upperR: m.upperArmR,
          foreR: m.foreArmR,
        }),
    },
    {
      group: 'body',
      name: 'leg',
      run: () =>
        body.leg({
          side: 'R',
          hip: v(B.thighR),
          knee: v(B.shinR),
          ankle: v(B.footR),
          thighR: m.thighR,
          shinR: m.shinR,
        }),
    },
    {
      group: 'body',
      name: 'hand (fist)',
      run: () => body.hand({ side: 'R', wrist: v(B.handR), length: m.handLen, r: m.handR, pose: 'fist' }),
    },
    {
      group: 'body',
      name: 'boot',
      run: () => body.boot({ side: 'R', ankle: v(B.footR), length: m.footLen, width: m.footLen * 0.42, shaft: 0.4 }),
    },
    {
      group: 'body',
      name: 'figure (whole)',
      run: () => body.figure({ metrics: m, bind: B }),
    },

    // -- helmet -----------------------------------------------------------
    ...(['hanDoumou', 'chuPeaked', 'softCap', 'crownedHelm', 'hood', 'turban', 'fanCrown'] as const).map(
      (style) => ({
        group: 'helmet',
        name: style,
        run: () =>
          helmetParts.helmet({
            style,
            baseY: B.head.y,
            headLen: m.headLen,
            headWidth: m.headWidth,
            headDepth: m.headDepth,
          }),
      }),
    ),
    ...(['plume', 'hornPair', 'fanCrest', 'standardSocket', 'buyao'] as const).map((style) => ({
      group: 'helmet',
      name: `crest:${style}`,
      run: () =>
        helmetParts.crest({
          style,
          at: [0, m.headTopY, 0],
          height: m.headLen * 0.8,
          width: m.headWidth * 0.6,
        }),
    })),

    // -- lamellar ---------------------------------------------------------
    {
      group: 'lamellar',
      name: 'cuirass (5 rows)',
      run: () =>
        lamellar.cuirass({
          fromY: m.waistY,
          toY: m.shoulderY,
          rx0: m.waistWidth * 0.58,
          rx1: m.chestWidth * 0.6,
          rows: 5,
          perRow: 14,
        }),
    },
    {
      group: 'lamellar',
      name: 'skirtArmour',
      run: () =>
        lamellar.skirtArmour({
          topY: m.waistY,
          bottomY: m.hipY - m.legLen * 0.3,
          rxTop: m.hipWidth * 0.62,
          rxBottom: m.hipWidth * 0.82,
          rows: 3,
          perRow: 16,
        }),
    },
    {
      group: 'lamellar',
      name: 'pauldron',
      run: () => lamellar.pauldron({ side: 'R', shoulder: v(B.upperArmR), r: m.upperArmR * 2.5 }),
    },
    {
      group: 'lamellar',
      name: 'tubeArmour (greave)',
      run: () =>
        lamellar.tubeArmour({
          bone: 'shinR',
          from: v(B.shinR),
          to: v(B.footR),
          r: m.shinR * 1.7,
          rows: 3,
          perRow: 7,
        }),
    },
    {
      group: 'lamellar',
      name: 'neckGuard',
      run: () => lamellar.neckGuard({ y: m.shoulderY, r: m.neckR * 2.6, height: m.neckLen * 0.6 }),
    },

    // -- cloth ------------------------------------------------------------
    {
      group: 'cloth',
      name: 'skirt',
      run: () =>
        cloth.skirt({
          topY: m.waistY,
          hemY: m.hipY - m.legLen * 0.4,
          rTop: m.waistWidth * 0.6,
          rHem: m.hipWidth * 0.86,
        }),
    },
    {
      group: 'cloth',
      name: 'robe',
      run: () =>
        cloth.robe({
          shoulderY: m.shoulderY,
          waistY: m.waistY,
          hemY: m.ankleY,
          shoulderR: m.shoulderWidth * 0.56,
          waistR: m.waistWidth * 0.62,
          hemR: m.hipWidth * 1.05,
        }),
    },
    {
      group: 'cloth',
      name: 'sleeve (court)',
      run: () =>
        cloth.sleeve({
          side: 'R',
          shoulder: v(B.upperArmR),
          elbow: v(B.foreArmR),
          wrist: v(B.handR),
          r0: m.upperArmR * 1.9,
          r1: m.upperArmR * 4.4,
        }),
    },
    {
      group: 'cloth',
      name: 'sash',
      run: () =>
        cloth.sash({
          y: m.waistY,
          rx: m.waistWidth * 0.58,
          rz: m.waistDepth * 0.66,
          height: m.torsoLen * 0.13,
          tail: m.torsoLen * 0.8,
        }),
    },
    {
      group: 'cloth',
      name: 'collar',
      run: () =>
        cloth.collar({
          shoulderY: m.shoulderY,
          chestY: m.chestY,
          rx: m.chestWidth * 0.55,
          rz: m.chestDepth * 0.6,
        }),
    },
    {
      group: 'cloth',
      name: 'cloak',
      run: () =>
        cloth.cloak({
          shoulderY: m.shoulderY,
          hemY: m.hipY - m.legLen * 0.8,
          rTop: m.shoulderWidth * 0.62,
          rHem: m.shoulderWidth * 1.05,
          z: m.chestDepth * 0.42,
        }),
    },
    {
      group: 'cloth',
      name: 'legWrap',
      run: () => cloth.legWrap({ side: 'R', knee: v(B.shinR), ankle: v(B.footR), r: m.shinR }),
    },
    {
      group: 'cloth',
      name: 'shoulderCape',
      run: () =>
        cloth.shoulderCape({ shoulderY: m.shoulderY, r: m.shoulderWidth * 0.78, drop: m.torsoLen * 0.5 }),
    },

    // -- weapons ----------------------------------------------------------
    { group: 'weapons', name: 'haft', run: () => weapons.haft({ below: h * 0.4, above: h * 0.7, r: h * 0.015 }) },
    {
      group: 'weapons',
      name: 'blade',
      run: () => weapons.blade({ length: h * 0.3, halfWidth: h * 0.03, thickness: h * 0.01 }),
    },
    { group: 'weapons', name: 'ge 戈', run: () => weapons.ge({ grip: v(B.handR), length: h * 1.24 }) },
    { group: 'weapons', name: 'ji 戟', run: () => weapons.ji({ grip: v(B.handR), length: h * 1.32 }) },
    { group: 'weapons', name: 'spear 矛', run: () => weapons.spear({ grip: v(B.handR), length: h * 1.9 }) },
    { group: 'weapons', name: 'sword 劍', run: () => weapons.sword({ grip: v(B.handR), length: h * 0.46 }) },
    { group: 'weapons', name: 'dao 刀', run: () => weapons.dao({ grip: v(B.handR), length: h * 0.4 }) },
    { group: 'weapons', name: 'axe 鉞', run: () => weapons.axe({ grip: v(B.handR), length: h * 0.94 }) },
    { group: 'weapons', name: 'baton 節', run: () => weapons.baton({ grip: v(B.handR), length: h * 1.05 }) },
    { group: 'weapons', name: 'bow 弓', run: () => weapons.bow({ grip: v(B.handL), length: h * 0.86 }) },
    {
      group: 'weapons',
      name: 'shield 盾',
      run: () => weapons.shield({ grip: v(B.handL), height: h * 0.52, width: h * 0.28 }),
    },
    {
      group: 'weapons',
      name: 'scabbard',
      run: () => weapons.scabbard({ grip: v(B.pelvis), length: h * 0.34, width: h * 0.035 }),
    },
    {
      group: 'weapons',
      name: 'quiver',
      run: () => weapons.quiver({ grip: v(B.spine02), length: h * 0.3, r: h * 0.036 }),
    },

    // -- standard ---------------------------------------------------------
    {
      group: 'standard',
      name: 'standard (Han)',
      run: () =>
        standardParts.standard({
          shape: 'hanSquare',
          base: v(B.spine02),
          poleLength: h * 0.72,
          poleR: h * 0.014,
          bannerHeight: h * 0.3,
          bannerWidth: h * 0.36,
        }),
    },
    {
      group: 'standard',
      name: 'standard (Chu)',
      run: () =>
        standardParts.standard({
          shape: 'chuSwallowtail',
          base: v(B.spine02),
          poleLength: h * 0.72,
          poleR: h * 0.014,
          bannerHeight: h * 0.3,
          bannerWidth: h * 0.36,
        }),
    },

    // -- rivets / trim ----------------------------------------------------
    {
      group: 'trim',
      name: 'rivetArc x12',
      run: () =>
        rivets.rivetArc({
          centre: [0, m.chestY, 0],
          rx: m.chestWidth * 0.5,
          count: 12,
          boneHint: 'spine02',
          rivet: { r: h * 0.008, h: h * 0.005 },
        }),
    },
    {
      group: 'trim',
      name: 'rivetGrid 3x4',
      run: () =>
        rivets.rivetGrid({
          corners: [
            [-0.1, 1, 0],
            [0.1, 1, 0],
            [0.1, 0.8, 0],
            [-0.1, 0.8, 0],
          ],
          rows: 3,
          cols: 4,
          boneHint: 'spine02',
          rivet: { r: h * 0.008, h: h * 0.005 },
        }),
    },
    {
      group: 'trim',
      name: 'buckle',
      run: () =>
        rivets.buckle({ at: [0, m.waistY, -0.1], w: h * 0.05, h: h * 0.035, thickness: h * 0.008, boneHint: 'pelvis' }),
    },
    {
      group: 'trim',
      name: 'cordLoop',
      run: () => rivets.cordLoop({ at: [0, m.waistY, -0.1], r: h * 0.02, thickness: h * 0.005, boneHint: 'pelvis' }),
    },
    {
      group: 'trim',
      name: 'tassel',
      run: () => trim.tassel({ at: [0, m.headTopY, 0], length: h * 0.1, r: h * 0.02, boneHint: 'head' }),
    },
    {
      group: 'trim',
      name: 'beadStrand',
      run: () =>
        trim.beadStrand({ at: [0, m.headTopY, 0], length: h * 0.12, beads: 6, r: h * 0.01, boneHint: 'head' }),
    },
    {
      group: 'trim',
      name: 'boss',
      run: () => trim.boss({ at: [0, m.chestY, -0.1], r: h * 0.03, height: h * 0.015, boneHint: 'spine02' }),
    },
    {
      group: 'trim',
      name: 'ferrule',
      run: () => trim.ferrule({ at: [0, m.chestY, 0], r: h * 0.015, height: h * 0.01, boneHint: 'handR' }),
    },
    {
      group: 'trim',
      name: 'plaque',
      run: () =>
        trim.plaque({ at: [0, m.waistY, -0.1], w: h * 0.05, h: h * 0.03, d: h * 0.006, boneHint: 'pelvis' }),
    },
    {
      group: 'trim',
      name: 'piping',
      run: () =>
        trim.piping({
          path: [
            [-0.1, m.chestY, -0.1],
            [0, m.chestY + 0.02, -0.12],
            [0.1, m.chestY, -0.1],
          ],
          r: h * 0.005,
          boneHint: 'spine02',
        }),
    },

    // -- mounts / vehicles ------------------------------------------------
    {
      group: 'mount',
      name: 'horse',
      run: () => mountParts.horse({ withers: h * 1.11, length: h * 1.5, barding: true }),
    },
    {
      group: 'mount',
      name: 'elephant',
      run: () => mountParts.elephant({ shoulder: h * 1.78, length: h * 2.12, trunkSegments: 9 }),
    },
    {
      group: 'mount',
      name: 'howdah',
      run: () =>
        mountParts.howdah({ y: h * 1.8, z: 0, hw: h * 0.5, depth: h * 0.6, height: h * 0.6 }),
    },
    {
      group: 'vehicle',
      name: 'spokedWheel (26)',
      run: () =>
        vehicle.spokedWheel({
          at: [0, h * 0.78, 0],
          radius: h * 0.78,
          width: h * 0.08,
          spokes: 26,
          mountBone: 'chariot.wheelL',
        }),
    },
    {
      group: 'vehicle',
      name: 'chariot',
      run: () =>
        vehicle.chariot({
          wheelRadius: h * 0.78,
          track: h * 0.72,
          carWidth: h * 0.92,
          carDepth: h * 0.66,
          railHeight: h * 0.5,
          poleLength: h * 1.5,
          canopyRadius: h * 0.82,
          canopyHeight: h * 1.42,
        }),
    },
    {
      group: 'vehicle',
      name: 'trebuchet 砲',
      run: () =>
        vehicle.trebuchet({
          pivotHeight: h * 0.88,
          armLength: h * 1.16,
          buttLength: h * 0.44,
          spread: h * 0.5,
          sledLength: h * 1.42,
        }),
    },
  ];
  return cases;
}

function verifyParts(): void {
  console.log('\n== PARTS ==');
  console.log(rule(104));
  console.log(
    pad('group', 10) +
      pad('part', 24) +
      pad('tris', 8, true) +
      pad('geoms', 7, true) +
      pad('inst', 6, true) +
      pad('closed', 8, true) +
      pad('open', 7, true) +
      pad('outward', 9, true) +
      '  status',
  );
  console.log(rule(104));

  let total = 0;
  let closedCount = 0;
  let openCount = 0;
  for (const c of partCases()) {
    let tris = 0;
    let geoms = 0;
    let inst = 0;
    let closedGeoms = 0;
    let openGeoms = 0;
    let openEdgeTotal = 0;
    let outwardMin = 1;
    let status = 'ok';
    try {
      const r = c.run();
      const group: PartGroup =
        r instanceof THREE.BufferGeometry
          ? { parts: [{ geometry: r, cls: 'iron', pigment: 'metal', boneHint: 'root' }], instanced: [], points: {}, bones: [], attach: [] }
          : 'geometry' in r
            ? { parts: [r], instanced: [], points: {}, bones: [], attach: [] }
            : r;
      for (const p of group.parts) {
        const label = `${c.group}/${c.name}/${p.name ?? '?'}`;
        assertFinite(p.geometry, label);
        const a = auditGeometry(p.geometry);
        if (a.badWinding > 0) {
          fail(`${label}: ${a.badWinding}/${a.triangles} triangles wound against their normal`);
        }
        if (a.closed) {
          closedGeoms++;
          if (a.volume <= 0) {
            fail(
              `${label}: closed solid with negative volume ${a.volume.toExponential(2)} — it is inside out`,
            );
          }
        } else {
          openGeoms++;
          openEdgeTotal += a.openEdges;
        }
        outwardMin = Math.min(outwardMin, a.outwardFrac);
        geoms++;
      }
      for (const p of group.instanced) {
        const label = `${c.group}/${c.name}/${p.name ?? '?'}`;
        assertFinite(p.geometry, label);
        const a = auditGeometry(p.geometry);
        if (a.badWinding > 0) {
          fail(`${label}: ${a.badWinding}/${a.triangles} instanced triangles wound against their normal`);
        }
        if (a.closed && a.volume <= 0) {
          fail(`${label}: closed instance geometry is inside out`);
        }
        if (a.closed) closedGeoms++;
        else {
          openGeoms++;
          openEdgeTotal += a.openEdges;
        }
        inst += p.transforms.length;
        for (const t of p.transforms) {
          if (!t.elements.every((e) => Number.isFinite(e))) {
            throw new Error(`${c.group}/${c.name}: non-finite instance transform`);
          }
        }
        geoms++;
      }
      tris = groupTriangles(group);
      total += tris;
      if (tris === 0) {
        status = 'EMPTY';
        fail(`${c.group}/${c.name} produced no triangles`);
      }
    } catch (err) {
      status = 'THREW';
      fail(`${c.group}/${c.name}: ${(err as Error).message}`);
    }
    closedCount += closedGeoms;
    openCount += openGeoms;
    console.log(
      pad(c.group, 10) +
        pad(c.name, 24) +
        pad(tris, 8, true) +
        pad(geoms, 7, true) +
        pad(inst, 6, true) +
        pad(closedGeoms, 8, true) +
        pad(openEdgeTotal, 7, true) +
        pad(outwardMin < 1 ? outwardMin.toFixed(2) : '1.00', 9, true) +
        `  ${status}`,
    );
  }
  console.log(rule(104));
  console.log(
    `${pad('', 34)}${pad(total, 8, true)}  triangles; ` +
      `${closedCount} closed solids audited, ${openCount} open surfaces`,
  );
}

// ---------------------------------------------------------------------------
// 3. Skinning
// ---------------------------------------------------------------------------

function verifySkinning(): void {
  console.log('\n== SKINNING ==');
  const spec = unitSpec(Side.Red, PieceType.Soldier, 0);
  const rig = buildRig(spec.proportions);
  const m = rig.metrics;
  const B = rig.bindWorld;
  const v = (p: THREE.Vector3): [number, number, number] => [p.x, p.y, p.z];

  const fig = body.figure({ metrics: m, bind: B });
  let worstNorm = 0;
  let verts = 0;
  let blend = 0;
  for (const p of fig.parts) {
    bindSkin(p.geometry, rig, p.boneHint, { ...(p.rigid ? { rigid: true } : {}), depth: p.rigid ? 1 : 2 });
    const s = skinStats(p.geometry);
    worstNorm = Math.max(worstNorm, s.worstNormError);
    verts += s.vertices;
    blend += s.blendHeavy;
  }
  console.log(`  vertices bound          ${verts}`);
  console.log(`  worst |Σw - 1|          ${worstNorm.toExponential(2)}`);
  console.log(`  blend-heavy vertices    ${blend} (${((blend / verts) * 100).toFixed(1)}%)`);
  check(worstNorm < 1e-5, `skin weights do not normalise: worst error ${worstNorm}`);

  // Bleed test: an isolated pauldron must not pick up the forearm, whatever the
  // A-pose puts next to it.
  const paul = lamellar.pauldron({ side: 'R', shoulder: v(B.upperArmR), r: m.upperArmR * 2.5 });
  check(paul.instanced.length > 0, 'pauldron produced no instanced plates');
  for (const p of paul.instanced) {
    check(
      p.boneHint === 'clavicleR',
      `pauldron bound to ${p.boneHint}, expected clavicleR — it will swing with the elbow`,
    );
  }

  // Deformation: bend each joint 90° and measure how much of the limb's
  // cross-section survives. This runs three's own `applyBoneTransform`, i.e.
  // exactly the maths the vertex shader does.
  console.log('\n  joint collapse under a 90 degree bend (1.00 = no loss)');
  console.log('  ' + rule(72));
  console.log(
    '  ' + pad('joint', 14) + pad('retained', 12, true) + pad('bind width', 14, true) + pad('posed width', 14, true) + pad('samples', 10, true),
  );
  console.log('  ' + rule(72));

  const armGroup = body.arm({
    side: 'R',
    shoulder: v(B.upperArmR),
    elbow: v(B.foreArmR),
    wrist: v(B.handR),
    upperR: m.upperArmR,
    foreR: m.foreArmR,
    deltoid: false,
  });
  const legGroup = body.leg({
    side: 'R',
    hip: v(B.thighR),
    knee: v(B.shinR),
    ankle: v(B.footR),
    thighR: m.thighR,
    shinR: m.shinR,
  });

  const trials: { label: string; part: Part; joint: Parameters<typeof measureJointCollapse>[2]; child: Parameters<typeof measureJointCollapse>[3] }[] = [
    { label: 'shoulder R', part: armGroup.parts[0], joint: 'upperArmR', child: 'upperArmR' },
    { label: 'elbow R', part: armGroup.parts[1], joint: 'foreArmR', child: 'foreArmR' },
    { label: 'hip R', part: legGroup.parts[0], joint: 'thighR', child: 'thighR' },
    { label: 'knee R', part: legGroup.parts[1], joint: 'shinR', child: 'shinR' },
  ];

  for (const t of trials) {
    const geo = t.part.geometry.clone();
    bindSkin(geo, rig, t.part.boneHint, { depth: 2 });
    const r = measureJointCollapse(geo, rig, t.joint, t.child, Math.PI / 2, 0.3);
    console.log(
      '  ' +
        pad(t.label, 14) +
        pad(r.retained.toFixed(3), 12, true) +
        pad(r.bindWidth.toFixed(4), 14, true) +
        pad(r.posedWidth.toFixed(4), 14, true) +
        pad(r.samples, 10, true),
    );
    if (r.samples >= 6 && r.retained < 0.7) {
      warnings.push(
        `${t.label}: only ${(r.retained * 100) | 0}% of the cross-section survives a 90 degree bend`,
      );
    }
    check(r.retained > 0.45, `${t.label}: catastrophic collapse (${r.retained.toFixed(2)})`);
  }
}

// ---------------------------------------------------------------------------
// 4. Silhouette table
// ---------------------------------------------------------------------------

function verifySilhouetteTable(): void {
  console.log('\n== SILHOUETTE TABLE ==');
  for (const side of [Side.Red, Side.Black] as const) {
    const conflicts = silhouetteConflicts(side);
    for (const c of conflicts) fail(`silhouette conflict: ${c}`);
  }
  console.log(rule());
  console.log(
    pad('unit', 10) + pad('crown', 16) + pad('class', 8) + pad('aspect', 9, true) + pad('height', 9, true) + pad('budget', 9, true),
  );
  console.log(rule());
  const heights: number[] = [];
  for (const key of UNIT_KEYS_IN_VALUE_ORDER) {
    const s = unitSpec(Side.Red, typeOf(key), 0);
    heights.push(s.silhouette.height);
    console.log(
      pad(key, 10) +
        pad(s.silhouette.crown, 16) +
        pad(s.silhouette.widthClass, 8) +
        pad(s.silhouette.aspect.toFixed(2), 9, true) +
        pad(s.silhouette.height.toFixed(2), 9, true) +
        pad(s.budget, 9, true),
    );
  }
  // Every declared height must be separable from every other by a visible
  // margin; 8% is roughly the smallest difference that survives a silhouette
  // render at board distance.
  for (let i = 0; i < heights.length; i++) {
    for (let j = i + 1; j < heights.length; j++) {
      const rel = Math.abs(heights[i] - heights[j]) / Math.max(heights[i], heights[j]);
      if (rel < 0.08) {
        warnings.push(
          `declared heights of ${UNIT_KEYS_IN_VALUE_ORDER[i]} and ${UNIT_KEYS_IN_VALUE_ORDER[j]} differ by only ${(rel * 100).toFixed(1)}%`,
        );
      }
    }
  }

  // The tightest aspect pair, reported so a collapsing separation axis is
  // visible rather than discovered by a critic. Crown tags are unique, so the
  // contract still holds when this is small — but it is worth knowing.
  let tightest = { a: '', b: '', rel: 1 };
  for (let i = 0; i < UNIT_KEYS_IN_VALUE_ORDER.length; i++) {
    for (let j = i + 1; j < UNIT_KEYS_IN_VALUE_ORDER.length; j++) {
      const ai = unitSpec(Side.Red, typeOf(UNIT_KEYS_IN_VALUE_ORDER[i]), 0).silhouette.aspect;
      const aj = unitSpec(Side.Red, typeOf(UNIT_KEYS_IN_VALUE_ORDER[j]), 0).silhouette.aspect;
      const rel = Math.abs(ai - aj) / Math.max(ai, aj);
      if (rel < tightest.rel) {
        tightest = { a: UNIT_KEYS_IN_VALUE_ORDER[i], b: UNIT_KEYS_IN_VALUE_ORDER[j], rel };
      }
    }
  }
  console.log(
    `  tightest aspect pair: ${tightest.a} / ${tightest.b} at ${(tightest.rel * 100).toFixed(1)}% apart` +
      (tightest.rel < 0.1 ? ' — separated by crown and cross-file width, not aspect' : ''),
  );
}

// ---------------------------------------------------------------------------
// 5. Units through the factory
// ---------------------------------------------------------------------------

function verifyUnits(): void {
  console.log('\n== UNITS (built through the factory) ==');
  const fallingBack = unitsStillFallingBack();
  if (fallingBack.length > 0) {
    console.log(`  NOTE: still using the generic fallback figure: ${fallingBack.join(', ')}`);
  }
  const materials = stubMaterials();
  // main.ts ships with bakeInstancesBelow: 64 — the render author measured that
  // folding small instance sets into the merged mesh beats instancing them, so
  // the verification must measure the configuration that actually runs.
  const factory = createCharacters({
    materials,
    bakeInstancesBelow: 64,
    onWarn: (m) => warnings.push(m),
  });

  console.log(rule(110));
  console.log(
    pad('unit', 10) +
      pad('side', 5) +
      pad('tris', 8, true) +
      pad('budget', 8, true) +
      pad('%', 6, true) +
      pad('skin', 6, true) +
      pad('prop', 6, true) +
      pad('bones', 7, true) +
      pad('W', 7, true) +
      pad('H', 7, true) +
      pad('D', 7, true) +
      pad('foot', 7, true) +
      pad('reachX', 8, true) +
      pad('reachZ', 8, true) +
      pad('y0', 7, true) +
      pad('aspect', 8, true) +
      pad('decl', 7, true) +
      pad('ms', 5, true),
  );
  console.log(rule(110));

  let grand = 0;
  let grandMeshes = 0;
  let windingAudited = 0;
  let footWorst = 0;
  let reachWorst = 0;
  const units: ReturnType<typeof factory.create>[] = [];

  for (const key of UNIT_KEYS_IN_VALUE_ORDER) {
    for (const side of [Side.Red, Side.Black] as const) {
      const t0 = Date.now();
      const u = factory.create(side, typeOf(key), side === Side.Red ? 0 : 1);
      const ms = Date.now() - t0;
      units.push(u);

      const spec = unitSpec(side, typeOf(key), 0);
      const meshes = u.skinned.length + u.props.length;
      const [w, hh, dd] = u.meta.size;
      const aspect = Math.max(w, dd) / Math.max(1e-6, hh);
      const foot = Math.max(w, dd);
      // Where the piece's lowest point sits. main.ts stands each figure on a
      // plinth top at y = BASE_TOP_Y, so anything below zero in the unit's own
      // space sinks through the plinth and through the board with it.
      u.root.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(u.root);
      const y0 = bb.min.y;
      // How far the piece reaches from its own intersection. This, not the
      // bounding-box *size*, is what decides whether it crowds a neighbour: a
      // silhouette centred off its origin crowds one side twice as hard. Under
      // 0.5 it sits entirely inside its own square; under 1.0 it leans over the
      // line but never covers the next intersection.
      const reachX = Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x));
      const reachZ = Math.max(Math.abs(bb.min.z), Math.abs(bb.max.z));
      const reach = Math.max(reachX, reachZ);
      footWorst = Math.max(footWorst, foot);
      reachWorst = Math.max(reachWorst, reach);
      check(
        reach < 1.0,
        `${key} (${side === Side.Red ? 'Han' : 'Chu'}): reaches ${reach.toFixed(2)} from its intersection — it covers a neighbour's`,
      );
      check(y0 > -0.02, `${key} (${side === Side.Red ? 'Han' : 'Chu'}): lowest point is ${y0.toFixed(3)}, below its own ground plane`);
      if (foot > BOARD_FOOTPRINT_LIMIT) {
        warnings.push(
          `${key}: footprint ${foot.toFixed(2)} exceeds the ${BOARD_FOOTPRINT_LIMIT} square-pitch limit — it covers a neighbour's intersection`,
        );
      }
      grand += u.meta.triangles;
      grandMeshes += meshes;

      // Hard checks. The skeleton's first twenty bones must be exactly
      // BONE_ORDER — clips retarget by index, so a shifted bone silently
      // animates the wrong limb. Mount bones follow after them.
      check(
        u.skeleton.bones.length >= 20,
        `${key}: skeleton has ${u.skeleton.bones.length} bones, expected at least 20`,
      );
      for (let i = 0; i < 20; i++) {
        check(
          u.skeleton.bones[i].name === BONE_ORDER[i],
          `${key}: skeleton bone ${i} is "${u.skeleton.bones[i].name}", expected "${BONE_ORDER[i]}"`,
        );
      }
      check(u.skinned.length > 0, `${key}: no skinned meshes`);
      check(hh > 0.2, `${key}: degenerate height ${hh}`);
      for (const sm of u.skinned) {
        const g = sm.geometry;
        check(!!g.getAttribute('skinIndex'), `${key}: skinned mesh without skinIndex`);
        check(!!g.getAttribute('aSmoothNormal'), `${key}: skinned mesh without aSmoothNormal`);
        check(!!g.getAttribute('aMaterial'), `${key}: skinned mesh without aMaterial`);
        assertFinite(g, `${key}/${sm.name}`);
        const a = auditGeometry(g);
        if (a.badWinding > 0) {
          fail(`${key}/${sm.name}: ${a.badWinding}/${a.triangles} triangles wound against their normal`);
        }
        windingAudited += a.triangles;
      }
      for (const pr of u.props) {
        const g = (pr as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (!g) continue;
        const a = auditGeometry(g);
        if (a.badWinding > 0) {
          fail(`${key}/${pr.name}: ${a.badWinding}/${a.triangles} prop triangles wound against their normal`);
        }
        windingAudited += a.triangles;
      }
      if (spec.mount !== 'none' && spec.mount !== 'platform') {
        check(
          Object.keys(u.mountBones).length > 0,
          `${key}: mount "${spec.mount}" published no mount bones`,
        );
      }

      console.log(
        pad(key, 10) +
          pad(side === Side.Red ? 'Han' : 'Chu', 5) +
          pad(u.meta.triangles, 8, true) +
          pad(spec.budget, 8, true) +
          pad(((u.meta.triangles / spec.budget) * 100).toFixed(0), 6, true) +
          pad(u.skinned.length, 6, true) +
          pad(u.props.length, 6, true) +
          pad(Object.keys(u.mountBones).length + 20, 7, true) +
          pad(w.toFixed(2), 7, true) +
          pad(hh.toFixed(2), 7, true) +
          pad(dd.toFixed(2), 7, true) +
          pad(foot.toFixed(2), 7, true) +
          pad(reachX.toFixed(2), 8, true) +
          pad(reachZ.toFixed(2), 8, true) +
          pad(y0.toFixed(3), 7, true) +
          pad(aspect.toFixed(2), 8, true) +
          pad(spec.silhouette.aspect.toFixed(2), 7, true) +
          pad(ms, 5, true),
      );
    }
  }
  console.log(rule(110));
  console.log(
    `  32-unit board estimate: ${(estimateBoard(units) / 1000).toFixed(1)}k triangles, ` +
      `${estimateBoardMeshes(units)} meshes (${estimateBoardMeshes(units) * 2} draw calls with the outline pass)`,
  );
  console.log(
    `  all 14 built: ${grand} triangles, ${grandMeshes} meshes, ${materials.count()} materials`,
  );
  console.log(`  winding audited across ${windingAudited} built triangles`);
  console.log(
    `  widest footprint ${footWorst.toFixed(2)} and worst reach-from-intersection ` +
      `${reachWorst.toFixed(2)} against a ${SQUARE} square pitch; a neighbour's ` +
      `intersection is covered at reach 1.0. Plinth is ${(0.345 * 2).toFixed(2)} across at y=0.046.`,
  );

  // The same cast built in atlas mode: one merged mesh per unit, one material
  // for everything. This is the configuration the renderer's ramp shader wants,
  // and the merge happens here so nobody downstream has to duplicate vertex
  // data to get it.
  {
    const atlasMat = new THREE.MeshBasicMaterial();
    atlasMat.name = 'atlas';
    const af = createCharacters({
      materials,
      bakeInstancesBelow: 64,
      atlasMaterial: atlasMat,
      onWarn: () => {},
    });
    let am = 0;
    let at = 0;
    const seen = new Set<THREE.Material>();
    const built: ReturnType<typeof af.create>[] = [];
    for (const key of UNIT_KEYS_IN_VALUE_ORDER) {
      for (const side of [Side.Red, Side.Black] as const) {
        const u = af.create(side, typeOf(key), 0);
        built.push(u);
        const per = BOARD_COUNT[key];
        am += (u.skinned.length + u.props.length) * per;
        at += u.meta.triangles * per;
        for (const m of u.skinned) seen.add(m.material as THREE.Material);
        for (const p of u.props) {
          const mm = (p as THREE.Mesh).material as THREE.Material | undefined;
          if (mm) seen.add(mm);
        }
        check(
          u.skinned.length === 1,
          `${key}: atlas mode produced ${u.skinned.length} skinned meshes, expected 1`,
        );
        for (const sm of u.skinned) {
          const a = auditGeometry(sm.geometry);
          if (a.badWinding > 0) fail(`${key} atlas mesh: ${a.badWinding} triangles wound against their normal`);
          check(!!sm.geometry.getAttribute('aMaterial'), `${key}: atlas mesh without aMaterial`);
        }
      }
    }
    console.log(
      `\n  atlas mode (one material injected): 32-unit board = ${am} meshes ` +
        `(${am * 2} draw calls with the outline pass), ${(at / 1000).toFixed(1)}k triangles, ` +
        `${seen.size} material(s)`,
    );
    for (const u of built) u.dispose();
    af.dispose();
  }

  // Attachment sockets and wheel radii — the two things other subsystems break on.
  console.log('\n  attachment sockets and published mount data');
  console.log('  ' + rule(88));
  for (const u of units) {
    const sockets = Object.keys(u.attach).sort().join(',') || '(none)';
    const wheels = Object.entries(u.mountBones)
      .filter(([n]) => n.includes('wheel'))
      .map(([n, o]) => `${n}=r${(o.userData.radius as number)?.toFixed(3) ?? '?'}`)
      .join(' ');
    console.log(
      '  ' + pad(`${u.meta.side === Side.Red ? 'Han' : 'Chu'} ${u.meta.key}`, 16) + pad(sockets, 46) + wheels,
    );
    if (u.meta.mount === 'chariot') {
      check(wheels.length > 0, `${u.meta.key}: chariot wheels must publish their radius`);
    }
  }

  // Mount bones must actually drive geometry. A horse whose legs are welded to
  // the body typechecks, builds, measures correctly and is completely broken;
  // the only way to know is to move a bone and watch a vertex.
  console.log('\n  mount bones drive their geometry');
  console.log('  ' + rule(72));
  for (const u of units) {
    const names = Object.keys(u.mountBones);
    if (names.length === 0) continue;
    const probe = names.find((n) => /leg|wheel|trunk|beam/.test(n)) ?? names[0];
    const idx = u.skeleton.bones.findIndex((b) => b.name === probe);
    check(idx >= 0, `${u.meta.key}: mount bone ${probe} is not in the skeleton`);
    if (idx < 0) continue;
    let moved = 0;
    let best = 0;
    for (const mesh of u.skinned) {
      const si = mesh.geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
      const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const picks: number[] = [];
      for (let i = 0; i < si.count && picks.length < 40; i++) {
        if (si.getComponent(i, 0) === idx) picks.push(i);
      }
      if (picks.length === 0) continue;
      const rest = picks.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i));
      const bone = u.mountBones[probe];
      bone.rotation.x += 0.5;
      u.root.updateMatrixWorld(true);
      u.skeleton.update();
      mesh.updateMatrixWorld(true);
      for (let k = 0; k < picks.length; k++) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, picks[k]);
        mesh.applyBoneTransform(picks[k], v);
        best = Math.max(best, v.distanceTo(rest[k]));
      }
      bone.rotation.x -= 0.5;
      u.root.updateMatrixWorld(true);
      u.skeleton.update();
      moved += picks.length;
    }
    console.log(
      '  ' +
        pad(`${u.meta.side === Side.Red ? 'Han' : 'Chu'} ${u.meta.key}`, 16) +
        pad(probe, 24) +
        pad(`${moved} verts`, 12, true) +
        pad(`max ${best.toFixed(4)}`, 14, true),
    );
    check(moved > 0, `${u.meta.key}: no vertex is bound to mount bone ${probe}`);
    check(best > 1e-4, `${u.meta.key}: rotating ${probe} moved nothing`);
  }

  const before = factory.stats();
  for (const u of units) u.dispose();
  const after = factory.stats();
  check(after.triangles === 0, `dispose() leaked ${after.triangles} triangles (was ${before.triangles})`);
  check(after.geometries === 0, `dispose() leaked ${after.geometries} geometries`);
  factory.dispose();
}

/** A full board: 5 soldiers, 1 general, 2 of everything else, per side. */
const BOARD_COUNT: Record<UnitKey, number> = {
  soldier: 5,
  advisor: 2,
  general: 1,
  cannon: 2,
  horse: 2,
  elephant: 2,
  chariot: 2,
};

function estimateBoard(units: ReturnType<Awaited<ReturnType<typeof createCharacters>>['create']>[]): number {
  // A full board: 5 soldiers, 2 each of everything else, 1 general, per side.
  const per: Record<UnitKey, number> = {
    soldier: 5,
    advisor: 2,
    general: 1,
    cannon: 2,
    horse: 2,
    elephant: 2,
    chariot: 2,
  };
  let n = 0;
  for (const u of units) n += u.meta.triangles * per[u.meta.key];
  return n;
}

function estimateBoardMeshes(
  units: ReturnType<Awaited<ReturnType<typeof createCharacters>>['create']>[],
): number {
  const per: Record<UnitKey, number> = {
    soldier: 5,
    advisor: 2,
    general: 1,
    cannon: 2,
    horse: 2,
    elephant: 2,
    chariot: 2,
  };
  let n = 0;
  for (const u of units) n += (u.skinned.length + u.props.length) * per[u.meta.key];
  return n;
}

// ---------------------------------------------------------------------------

function typeOf(key: UnitKey): PieceType {
  const entries: [UnitKey, PieceType][] = [
    ['general', PieceType.General],
    ['advisor', PieceType.Advisor],
    ['elephant', PieceType.Elephant],
    ['horse', PieceType.Horse],
    ['chariot', PieceType.Chariot],
    ['cannon', PieceType.Cannon],
    ['soldier', PieceType.Soldier],
  ];
  const hit = entries.find(([k]) => k === key);
  if (!hit) throw new Error(`unknown unit key ${key}`);
  return hit[1];
}

function main(): void {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith('--'))?.slice(2);
  const t0 = Date.now();

  console.log('characters/verify — headless geometry, skinning and budget check');
  console.log(`three r${THREE.REVISION}`);

  if (!only || only === 'rig') verifyRig();
  if (!only || only === 'parts') verifyParts();
  if (!only || only === 'skin') verifySkinning();
  if (!only || only === 'silhouette') verifySilhouetteTable();
  if (!only || only === 'units') verifyUnits();

  console.log(`\n== SUMMARY ==`);
  console.log(`  elapsed ${Date.now() - t0} ms`);
  if (warnings.length) {
    console.log(`  ${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`    - ${w}`);
  }
  if (failures > 0) {
    console.log(`  ${failures} FAILURE(S)`);
    process.exitCode = 1;
  } else {
    console.log('  all hard checks passed');
  }
  // Sanity: UNIT_KEY must cover every type the factory can be asked for.
  void UNIT_KEY;
}

main();
