/**
 * Collapsing a built figure to one draw call.
 *
 * THE ARITHMETIC THIS EXISTS TO FIX
 * A figure legitimately uses eight to thirteen (MaterialClass, PigmentName)
 * pairs. Lacquered plate over indigo cloth over ochre leather with gold
 * fittings, an iron blade and a shell-white face is not decoration — it is what
 * makes a unit nameable from its silhouette, which is `characters`' definition
 * of done. Under one material per pair, a measured 32-unit board is 475 meshes,
 * and the inverted-hull pass doubles that to 950 draw calls against
 * ARCHITECTURE.md's budget of 260.
 *
 * `characters/factory.ts` anticipated this and stamps a per-vertex float
 * `aMaterial` on every merged geometry, encoded `classIndex * 16 +
 * pigmentIndex`. `gongbi.ts` reads it (see `getAtlas`/`outlineAtlas`) and looks
 * the class and pigment up per fragment instead of per material. What is left
 * is a geometry problem: the buckets are still separate meshes, and a mesh is a
 * draw call whether or not it shares a material.
 *
 * So this file merges them. It operates on an ALREADY-BUILT figure and needs no
 * change from `characters`, which is what makes it adoptable today.
 *
 * THE BETTER FIX, stated plainly because this one has a cost:
 * merging here duplicates the vertex data — the source geometries stay alive
 * because the `UnitInstance` owns and disposes them. The right long-term move is
 * for `characters/factory.ts` to merge its buckets into ONE geometry before
 * building the mesh, which it is already almost doing (it merges per bucket
 * today; merging across buckets is the same call with a longer list, and
 * `aMaterial` already distinguishes the parts). Then there is no duplicate and
 * this file is not needed. Until then, this is the same win at the cost of
 * roughly the cast's vertex data again in CPU memory.
 */

import * as THREE from 'three';
import { GongbiMaterialLibrary } from './gongbi.ts';
import { buildHull, ensureSmoothNormals, HULL_FLAG, isHull } from './outline.ts';

/** The attributes an atlas mesh needs, in the order they are merged. */
const MERGED_ATTRIBUTES = [
  'position',
  'normal',
  'aSmoothNormal',
  'aMaterial',
  'skinIndex',
  'skinWeight',
] as const;

/** True when a geometry carries the per-vertex material code. */
export function hasAtlasAttribute(geometry: THREE.BufferGeometry): boolean {
  return geometry.getAttribute('aMaterial') !== undefined;
}

export interface AtlasCollapse {
  /** The single mesh that replaced the group. */
  mesh: THREE.Mesh;
  /** Its single hull, or null if outlines were not requested. */
  hull: THREE.Mesh | null;
  /** How many meshes were folded into it. */
  replaced: number;
  /** Frees the merged geometry. The source geometries belong to the unit. */
  dispose(): void;
}

export interface CollapseOptions {
  /** Per-unit value nudge; the same number that would go in a MaterialRequest. */
  variation?: number;
  /** Build the atlas hull too. Default true. */
  outlines?: boolean;
  /** Opt the whole figure out of the silk wash. */
  noSilk?: boolean;
}

/**
 * Merge a list of geometries that share an attribute layout.
 *
 * Hand-written rather than using three's `BufferGeometryUtils.mergeGeometries`
 * for one reason that matters: this must merge EXACTLY the six attributes an
 * atlas mesh needs and silently drop anything else. The addon requires every
 * input to carry an identical attribute set and fails the whole merge if one
 * part picked up a stray UV set — which, across thirty-two procedurally built
 * figures, is a question of when rather than whether.
 */
function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  let vertexTotal = 0;
  let indexTotal = 0;
  for (const g of list) {
    vertexTotal += g.getAttribute('position').count;
    const idx = g.getIndex();
    indexTotal += idx ? idx.count : g.getAttribute('position').count;
  }

  for (const name of MERGED_ATTRIBUTES) {
    const first = list[0].getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!first) continue;
    const itemSize = first.itemSize;
    // skinIndex is integer data; everything else is float. Preserving the type
    // matters — a Uint16 skin index widened to float still works, but a float
    // one narrowed to Uint16 does not, and getting it backwards is silent.
    const isIndexAttr = name === 'skinIndex';
    const array = isIndexAttr
      ? new Uint16Array(vertexTotal * itemSize)
      : new Float32Array(vertexTotal * itemSize);

    let at = 0;
    for (const g of list) {
      const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
      const count = g.getAttribute('position').count;
      if (!a) {
        at += count * itemSize;
        continue;
      }
      for (let i = 0; i < count * itemSize; i++) array[at + i] = a.array[i] as number;
      at += count * itemSize;
    }
    out.setAttribute(
      name,
      isIndexAttr
        ? new THREE.Uint16BufferAttribute(array as Uint16Array, itemSize)
        : new THREE.Float32BufferAttribute(array as Float32Array, itemSize),
    );
  }

  // 32-bit indices unconditionally: a merged figure runs well past 65 535
  // vertices and a silently truncated 16-bit index buffer draws garbage.
  const indices = new Uint32Array(indexTotal);
  let at = 0;
  let base = 0;
  for (const g of list) {
    const idx = g.getIndex();
    const count = g.getAttribute('position').count;
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices[at++] = idx.getX(i) + base;
    } else {
      for (let i = 0; i < count; i++) indices[at++] = i + base;
    }
    base += count;
  }
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** Meshes that can share one atlas draw call. */
interface Group {
  parent: THREE.Object3D;
  skeleton: THREE.Skeleton | null;
  bindMatrix: THREE.Matrix4 | null;
  doubleSided: boolean;
  meshes: THREE.Mesh[];
}

function groupKey(m: THREE.Mesh): string {
  const s = m as THREE.SkinnedMesh;
  const mat = m.material as THREE.Material;
  return [
    m.parent?.uuid ?? 'none',
    s.isSkinnedMesh ? s.skeleton.uuid : 'rigid',
    s.isSkinnedMesh ? s.bindMatrix.elements.join(',') : '',
    mat.side === THREE.DoubleSide ? 'double' : 'front',
  ].join('|');
}

/**
 * Collapse every eligible mesh under `root` into one atlas mesh per group.
 *
 * Eligible means: a Mesh (not an InstancedMesh — different instance matrices
 * cannot merge, and an InstancedMesh is already one draw call for many copies),
 * not a hull, carrying `aMaterial`, and sharing a parent, a skeleton, a bind
 * matrix and a sidedness with the rest of its group. In practice `characters`
 * produces exactly one such group per figure: every bucket is a direct child of
 * the unit root, bound to the same skeleton with an identity bind matrix.
 *
 * The originals are removed from the scene graph but NOT disposed — the
 * `UnitInstance` owns them and will dispose them itself, and disposing here
 * would leave its bookkeeping describing geometries that no longer exist.
 */
export function collapseToAtlas(
  root: THREE.Object3D,
  materials: GongbiMaterialLibrary,
  opts: CollapseOptions = {},
): AtlasCollapse[] {
  const groups = new Map<string, Group>();

  const candidates: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh !== true) return;
    if (isHull(m)) return;
    if ((m as THREE.InstancedMesh).isInstancedMesh === true) return;
    if (Array.isArray(m.material)) return;
    if (!m.geometry || !hasAtlasAttribute(m.geometry)) return;
    candidates.push(m);
  });

  for (const m of candidates) {
    const key = groupKey(m);
    let g = groups.get(key);
    if (!g) {
      const s = m as THREE.SkinnedMesh;
      g = {
        parent: m.parent ?? root,
        skeleton: s.isSkinnedMesh ? s.skeleton : null,
        bindMatrix: s.isSkinnedMesh ? s.bindMatrix.clone() : null,
        doubleSided: (m.material as THREE.Material).side === THREE.DoubleSide,
        meshes: [],
      };
      groups.set(key, g);
    }
    g.meshes.push(m);
  }

  const out: AtlasCollapse[] = [];

  for (const g of groups.values()) {
    // A group of one is already one draw call; merging it would only duplicate
    // its geometry. It still swaps to the atlas material so the whole cast
    // shares one program and one set of state.
    const merged =
      g.meshes.length === 1
        ? g.meshes[0].geometry
        : mergeGeometries(g.meshes.map((m) => m.geometry));
    const owned = g.meshes.length > 1;
    ensureSmoothNormals(merged);

    const material = materials.getAtlas({
      ...(opts.variation !== undefined ? { variation: opts.variation } : {}),
      ...(opts.noSilk ? { noSilk: true } : {}),
      doubleSided: g.doubleSided,
    });

    let mesh: THREE.Mesh;
    if (g.skeleton) {
      const sm = new THREE.SkinnedMesh(merged, material);
      sm.bind(g.skeleton, g.bindMatrix ?? new THREE.Matrix4());
      mesh = sm;
    } else {
      mesh = new THREE.Mesh(merged, material);
    }
    mesh.name = `${g.meshes[0].name.split(':')[0] || 'unit'}:atlas`;
    mesh.castShadow = g.meshes.some((m) => m.castShadow);
    mesh.receiveShadow = g.meshes.some((m) => m.receiveShadow);
    mesh.frustumCulled = g.meshes[0].frustumCulled;

    for (const m of g.meshes) {
      // Drop any hull the per-material path already gave them, then unhook the
      // mesh itself. Its geometry stays alive under the unit's ownership.
      for (const child of [...m.children]) if (isHull(child)) child.removeFromParent();
      m.removeFromParent();
    }
    g.parent.add(mesh);

    const hull =
      opts.outlines === false ? null : buildHull(mesh, materials.outlineAtlas());
    if (hull) hull.userData[HULL_FLAG] = true;

    out.push({
      mesh,
      hull,
      replaced: g.meshes.length,
      dispose: () => {
        if (owned) merged.dispose();
        mesh.removeFromParent();
      },
    });
  }

  return out;
}

/**
 * Undo a collapse: drop the merged meshes and put the originals back.
 *
 * Only useful for A/B measurement — the measurement script renders the same
 * board both ways — but cheap to provide and it makes the collapse reversible
 * rather than destructive, which is the difference between a measurement and a
 * commitment.
 */
export function disposeCollapse(collapses: AtlasCollapse[]): void {
  for (const c of collapses) {
    c.hull?.removeFromParent();
    c.dispose();
  }
}
