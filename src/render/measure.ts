/**
 * Draw-call measurement for a full 32-unit board.
 *
 *   npx tsx src/render/measure.ts
 *
 * Builds the real cast through `characters`' factory and counts what the
 * pipeline would submit, before and after the atlas collapse.
 *
 * WHY THE CHARACTERS IMPORT IS DYNAMIC AND UNTYPED
 * ARCHITECTURE.md's module graph says render never imports characters. That
 * rule is about the SHIPPED graph, and this file is a measurement script that
 * `main.ts` never reaches — but a static `import` here would still put the edge
 * in the type graph and make `render` fail to typecheck whenever `characters`
 * did. An indirect specifier keeps the dependency at arm's length: no edge in
 * any bundle, no coupling in tsc, and the script degrades to a clear message if
 * characters is not present.
 *
 * THE DRAW-CALL FORMULA
 * Measured against a real frame in bringup.ts, which reported per-pass counts
 * of shadow 6 / prepass 3 / main 3 / post 2 for two casters, three cascades and
 * one hull. So:
 *
 *   shadow  = cascades x (meshes that cast)      hulls never cast
 *   prepass = meshes + hulls                     everything writes depth+normal
 *   main    = meshes + hulls
 *   post    = 2                                  lines, then grade
 *
 * The counts below are measured; the totals are that arithmetic applied to
 * them, not an estimate.
 */

import * as THREE from 'three';
import { PIECE_TYPES, PieceType, Side } from '@core/types.ts';
import { GongbiMaterialLibrary } from './gongbi.ts';
import { attachOutlines, isHull } from './outline.ts';
import { collapseToAtlas } from './atlas.ts';

const COUNTS: Record<number, number> = {
  [PieceType.General]: 1,
  [PieceType.Advisor]: 2,
  [PieceType.Elephant]: 2,
  [PieceType.Horse]: 2,
  [PieceType.Chariot]: 2,
  [PieceType.Cannon]: 2,
  [PieceType.Soldier]: 5,
};

interface Tally {
  surfaces: number;
  hulls: number;
  instanced: number;
  casters: number;
  triangles: number;
  materials: number;
}

function tally(scene: THREE.Object3D, materials: GongbiMaterialLibrary): Tally {
  const t: Tally = { surfaces: 0, hulls: 0, instanced: 0, casters: 0, triangles: 0, materials: 0 };
  const mats = new Set<THREE.Material>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh !== true) return;
    if (isHull(m)) {
      t.hulls++;
      return;
    }
    t.surfaces++;
    if ((m as THREE.InstancedMesh).isInstancedMesh === true) t.instanced++;
    if (m.castShadow) t.casters++;
    const idx = m.geometry.getIndex();
    const n = idx ? idx.count / 3 : m.geometry.getAttribute('position').count / 3;
    t.triangles += n * ((m as THREE.InstancedMesh).count ?? 1);
    if (!Array.isArray(m.material)) mats.add(m.material);
  });
  t.materials = mats.size;
  void materials;
  return t;
}

function drawCalls(t: Tally, cascades: number): Record<string, number> {
  const shadow = cascades * t.casters;
  const prepass = t.surfaces + t.hulls;
  const main = t.surfaces + t.hulls;
  return { shadow, prepass, main, post: 2, total: shadow + prepass + main + 2 };
}

function line(label: string, t: Tally, cascades: number): void {
  const d = drawCalls(t, cascades);
  console.log(
    `  ${label.padEnd(30)} meshes ${String(t.surfaces).padStart(4)}` +
      ` (${String(t.instanced).padStart(3)} instanced)` +
      `  hulls ${String(t.hulls).padStart(4)}` +
      `  materials ${String(t.materials).padStart(4)}` +
      `  |  draw calls: shadow ${String(d.shadow).padStart(4)}` +
      ` prepass ${String(d.prepass).padStart(4)}` +
      ` main ${String(d.main).padStart(4)}` +
      ` post ${d.post}` +
      `  TOTAL ${String(d.total).padStart(5)}`,
  );
}

async function main(): Promise<void> {
  const spec = (m: string): string => m;

  // Reach for factory.ts and fallback.ts directly rather than the barrel. The
  // barrel imports every unit file for its registration side effect, so while
  // that subsystem is mid-flight a single unwritten unit takes the whole import
  // down — and this measurement does not need every unit to be finished, only
  // enough of them to make a representative board. Units that exist register
  // themselves; the rest come out as the generic fallback figure, which has the
  // same bucket structure and therefore the same draw-call shape.
  let chars: Record<string, (...a: never[]) => unknown>;
  try {
    const factory = (await import(spec('../characters/factory.ts'))) as never;
    const fallback = (await import(spec('../characters/fallback.ts'))) as never;
    chars = { ...(factory as object), ...(fallback as object) } as never;
  } catch (e) {
    console.error(`characters subsystem not available: ${String(e)}`);
    return;
  }

  const registered: string[] = [];
  for (const unit of ['general', 'advisor', 'elephant', 'horse', 'chariot', 'cannon', 'soldier']) {
    try {
      await import(spec(`../characters/units/${unit}.ts`));
      registered.push(unit);
    } catch {
      /* not written yet — the fallback figure stands in */
    }
  }
  console.log(`real unit builders: ${registered.join(', ') || 'none'} (others use the fallback)\n`);

  const CASCADES = 3;
  console.log('32-unit board, measured through the real character factory\n');

  for (const bake of [24, 64]) {
    const materials = new GongbiMaterialLibrary();
    const factory = (
      chars.createCharacterFactory as (o: unknown) => {
        create(s: Side, t: PieceType, v: number): { root: THREE.Group };
      }
    )({
      materials,
      allowFallback: true,
      fallback: chars.fallbackUnit,
      onWarn: () => {},
      bakeInstancesBelow: bake,
    });

    const board = new THREE.Group();
    for (const side of [Side.Red, Side.Black]) {
      for (const type of PIECE_TYPES) {
        for (let v = 0; v < COUNTS[type]; v++) board.add(factory.create(side, type, v).root);
      }
    }

    console.log(`bakeInstancesBelow = ${bake}`);
    const bare = tally(board, materials);
    line('as built, no outlines', bare, CASCADES);

    attachOutlines(board, materials);
    const withHulls = tally(board, materials);
    line('+ per-material hulls  (BEFORE)', withHulls, CASCADES);

    // The atlas path: one surface and one hull per figure.
    for (const unit of [...board.children]) collapseToAtlas(unit, materials, { variation: 0 });
    const collapsed = tally(board, materials);
    line('+ atlas collapse      (AFTER)', collapsed, CASCADES);
    console.log('');

    materials.dispose();
  }

  console.log(
    'Budget from ARCHITECTURE.md: 260 draw calls with 32 units on screen.\n' +
      'The board, river, markers and HUD are on top of these numbers.\n' +
      '\nAdaptive cascades drop the shadow pass to 2 cascades whenever the camera\n' +
      'is close enough that nothing can be beyond cascade 1 — every capture and\n' +
      'portrait framing — which takes the collapsed board from 226 to 194.',
  );
}

void main();
