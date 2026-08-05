/**
 * The vocabulary the parts library and the seven unit authors share.
 *
 * A *part* is one BufferGeometry authored in **rig space** — feet at the origin,
 * facing -Z, in rig units (the same units as `UnitProportions.height`), before
 * the root `scale` is applied. It never owns a material: it declares what it is
 * made of (`cls`) and which pigment slot it belongs to (`pigment`), and the
 * factory resolves both against the army palette and the injected
 * `GongbiMaterials`. That indirection is what lets one part function serve the
 * cinnabar Han army and the ink-lacquer Chu army without branching.
 *
 * `boneHint` is the part's anchor in the shared skeleton. Two things read it:
 *   - the skinner, which uses it to gate *which* bones may influence the part's
 *     vertices (a pauldron hinted at `clavicleR` can never be dragged by
 *     `foreArmR`, however close the forearm passes in bind pose);
 *   - the factory, which uses it as the parent bone when the part is rigid.
 */

import * as THREE from 'three';
import type { BoneName } from '@core/contracts.ts';
import { ARMY, type MaterialClass, type PigmentName } from '@core/palette.ts';
import type { Side } from '@core/types.ts';

export type V2 = [number, number];
export type V3 = [number, number, number];

/**
 * The one bone that is not in the skeleton's own hierarchy.
 *
 * `Part.mountBone = STATIC_BONE` hangs a geometry off the **unit root group**
 * instead of off a bone, so nothing an animation clip does can reach it. The
 * factory creates it (at the identity, i.e. exactly where the part was
 * authored) only for units that ask for it, and it costs no extra draw call:
 * the geometry still merges into the unit's skinned mesh, it is simply weighted
 * to a bone that never moves.
 *
 * It exists for **furniture the figure stands on rather than wears** — the 帥's
 * command dais is the whole reason. The dais used to be bound rigidly to the
 * `root` bone, which is the bone every clip's authored root translation is
 * written to, so the death collapse's 238 mm drop took the platform down with
 * the body and the general died standing on a dais that had sunk through the
 * board. A thing the figure stands on does not move when the figure falls off
 * it.
 *
 * It follows the unit root, so it still travels and turns with the piece; it
 * just does not listen to the skeleton.
 */
export const STATIC_BONE = 'static';

/**
 * Pin every geometry in a group to `STATIC_BONE`. Convenience for the common
 * case, where a whole sub-assembly — a platform, a plinth, a mooring — is
 * furniture rather than anatomy.
 */
export function pinStatic(g: PartGroup): PartGroup {
  for (const p of g.parts) p.mountBone = STATIC_BONE;
  for (const p of g.instanced) p.mountBone = STATIC_BONE;
  return g;
}

/**
 * A slot in the army palette rather than a literal pigment. Nearly every part
 * should use one of these; a literal `PigmentName` is for the handful of things
 * that are the same substance in both armies (bone, flesh, timber, blade iron).
 */
export type PigmentSlot = 'lacquer' | 'cloth' | 'leather' | 'metal' | 'accent';

export type PartPigment = PigmentSlot | PigmentName;

const SLOTS: ReadonlySet<string> = new Set(['lacquer', 'cloth', 'leather', 'metal', 'accent']);

export function isSlot(p: PartPigment): p is PigmentSlot {
  return SLOTS.has(p);
}

/** Resolve a part's pigment declaration against the army palette. */
export function resolvePigment(p: PartPigment, side: Side): PigmentName {
  if (!isSlot(p)) return p;
  return ARMY[side as 0 | 1][p];
}

/**
 * One geometry with everything the factory needs to bind and shade it.
 * This is the shape the brief fixes: `{ geometry, cls, pigment, boneHint }`.
 * The remaining fields are optional binding hints with safe defaults.
 */
export interface Part {
  geometry: THREE.BufferGeometry;
  cls: MaterialClass;
  pigment: PartPigment;
  boneHint: BoneName;

  /** Label for the perf table and the debug overlay. Never used for logic. */
  name?: string;
  /**
   * Bind every vertex 100% to `boneHint` instead of blending through the bone
   * distance field. Correct for anything that is physically rigid — a helmet, a
   * boot, a lacquered pauldron, a blade — and cheaper besides.
   */
  rigid?: boolean;
  /**
   * Parent this geometry to a *mount* bone (`'horse.neck'`, `'chariot.wheelL'`,
   * `'elephant.trunk03'`) as a rigid child rather than skinning it to the
   * humanoid rig. `boneHint` is still required and is used only for grouping.
   *
   * `STATIC_BONE` is the special case: it parents the geometry to the unit root
   * rather than to anything the animator can move.
   */
  mountBone?: string;
  /** Extra humanoid bones allowed to influence this part, beyond the automatic
   *  neighbourhood of `boneHint`. Rarely needed; a long cloak wants `pelvis`. */
  allow?: BoneName[];
  /** Opt this part out of the silk-weave shadow wash (tiny props). */
  noSilk?: boolean;
}

/**
 * A part that ships as an `InstancedMesh`: one geometry, N transforms. Lamellar
 * plates, rivets, wheel spokes and bead strands all come through here — they are
 * the difference between a cuirass that costs 700 triangles and one draw call
 * and a cuirass that costs 700 triangles and 60 draw calls.
 *
 * `transforms` are in the same rig space as `geometry`. When `mountBone` is set
 * the factory rebases them into that bone's space; otherwise the whole
 * `InstancedMesh` is parented to `boneHint` (instanced geometry cannot be
 * skinned, so a plate array follows exactly one bone — which is what a rigid
 * lacquered plate physically does).
 */
export interface InstancedPart extends Part {
  transforms: THREE.Matrix4[];
}

/**
 * An extra bone belonging to a mount or vehicle. These live outside
 * `BONE_ORDER`, so they are plain `Object3D`s in `UnitInstance.mountBones`
 * rather than members of the shared `Skeleton`.
 */
export interface BoneSpec {
  /** Dotted name, e.g. `'horse.legFL01'`. Must be unique within the unit. */
  name: string;
  /** Another mount bone's name, a humanoid `BoneName`, or null for the root. */
  parent: string | null;
  /** Position in **rig space** (not parent-local). The factory rebases it. */
  position: V3;
  /** Rest rotation, XYZ Euler radians, applied after the rebase. */
  rotation?: V3;
  /**
   * Numbers the animator needs from geometry it cannot see. The one that is
   * contractual: wheels MUST publish `radius`, so wheel spin can be matched to
   * ground travel exactly rather than by eye.
   */
  data?: Record<string, number>;
}

/** A socket other subsystems attach to. Position is in **rig space**. */
export interface AttachSpec {
  name: AttachNameLike;
  /** Humanoid `BoneName` or a mount bone name. */
  bone: string;
  position: V3;
  /** XYZ Euler radians, in rig space. */
  rotation?: V3;
}

/** Widened so parts can publish sockets before the factory maps them. */
export type AttachNameLike =
  | 'gripR'
  | 'gripL'
  | 'haftTip'
  | 'crest'
  | 'back'
  | 'hip'
  | 'mountSeat'
  | 'reinL'
  | 'reinR'
  | 'muzzle'
  | 'trunkTip';

/**
 * What every composite part function returns. Atomic single-geometry helpers
 * return a bare `Part`; anything that produces more than one geometry, or that
 * needs to tell the caller where something ended up, returns one of these.
 *
 * `points` is the escape hatch that keeps unit authors from re-deriving
 * geometry: a spear publishes `tip`, a helmet publishes `crest`, an elephant
 * publishes `trunkTip` and `seat`. All in rig space.
 */
export interface PartGroup {
  parts: Part[];
  instanced: InstancedPart[];
  points: Record<string, THREE.Vector3>;
  bones: BoneSpec[];
  attach: AttachSpec[];
}

export function emptyGroup(): PartGroup {
  return { parts: [], instanced: [], points: {}, bones: [], attach: [] };
}

/** Fold any number of groups (or bare parts) into one. Order is preserved. */
export function mergeGroups(...items: (PartGroup | Part | null | undefined)[]): PartGroup {
  const out = emptyGroup();
  for (const it of items) {
    if (!it) continue;
    if ('geometry' in it) {
      out.parts.push(it);
      continue;
    }
    out.parts.push(...it.parts);
    out.instanced.push(...it.instanced);
    out.bones.push(...it.bones);
    out.attach.push(...it.attach);
    for (const k of Object.keys(it.points)) out.points[k] = it.points[k];
  }
  return out;
}

/**
 * Move a whole group by a matrix: geometries, instance transforms, published
 * points, bone rest positions and attachment sockets all move together.
 *
 * This is what lets a weapon or a mount be authored in a convenient local space
 * — grip at the origin, haft along +Y — and then dropped into rig space in one
 * call, with its `tip` point and its bones arriving in the right place too.
 * Mutates and returns the group.
 */
export function transformGroup(g: PartGroup, m: THREE.Matrix4): PartGroup {
  const seen = new Set<THREE.BufferGeometry>();
  for (const p of g.parts) {
    if (seen.has(p.geometry)) continue;
    seen.add(p.geometry);
    p.geometry.applyMatrix4(m);
  }
  for (const p of g.instanced) {
    for (const t of p.transforms) t.premultiply(m);
  }
  for (const k of Object.keys(g.points)) g.points[k].applyMatrix4(m);
  for (const b of g.bones) {
    const v = new THREE.Vector3(...b.position).applyMatrix4(m);
    b.position = [v.x, v.y, v.z];
  }
  for (const a of g.attach) {
    const v = new THREE.Vector3(...a.position).applyMatrix4(m);
    a.position = [v.x, v.y, v.z];
  }
  return g;
}

/** Total triangles in a group, including every instance of every instanced part. */
export function groupTriangles(g: PartGroup): number {
  let n = 0;
  for (const p of g.parts) n += triCount(p.geometry);
  for (const p of g.instanced) n += triCount(p.geometry) * p.transforms.length;
  return n;
}

/** Distinct meshes a group will cost, ignoring merging across groups. */
export function groupMeshes(g: PartGroup): number {
  const keys = new Set<string>();
  for (const p of g.parts) keys.add(`${p.cls}|${p.pigment}|${p.mountBone ?? ''}`);
  return keys.size + g.instanced.length;
}

function triCount(g: THREE.BufferGeometry): number {
  const idx = g.getIndex();
  if (idx) return idx.count / 3;
  const pos = g.getAttribute('position');
  return pos ? pos.count / 3 : 0;
}

/** Convenience constructor so a one-off geometry can become a part inline. */
export function mkPart(
  geometry: THREE.BufferGeometry,
  cls: MaterialClass,
  pigment: PartPigment,
  boneHint: BoneName,
  extra: Omit<Part, 'geometry' | 'cls' | 'pigment' | 'boneHint'> = {},
): Part {
  return { geometry, cls, pigment, boneHint, ...extra };
}
