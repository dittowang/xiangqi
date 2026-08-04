/**
 * The character factory: parts in, `UnitInstance` out.
 *
 * A unit author never touches a material, a skeleton, a skin weight or a draw
 * call. They write one function that returns a `PartGroup` — geometry in rig
 * space, each piece labelled with what it is made of and which bone it belongs
 * to — and everything below happens here:
 *
 *   1. the shared rig is built from the unit's proportions;
 *   2. mount bones are created and rebased into their parents' space;
 *   3. skinned parts get weights baked from the bone distance field;
 *   4. parts are merged by material, so a figure is five or six draw calls
 *      rather than sixty;
 *   5. repeated geometry becomes `InstancedMesh`;
 *   6. attachment sockets are placed;
 *   7. the result is measured — triangles, bounding box, aspect — and checked
 *      against the unit's budget and its declared silhouette.
 *
 * REGISTRATION. The seven per-unit files each call `registerUnit(type, builder)`
 * at module scope. `factory.ts` never imports them — that would invert the
 * dependency and make this file change every time a unit lands. The unit
 * modules are pulled in by `@characters/index.ts`, which is the only place that
 * knows they exist. An unregistered type falls back to a generic figure (see
 * `fallback.ts`) so the game is runnable throughout, and the factory says so
 * through `onWarn` rather than silently.
 */

import * as THREE from 'three';
import {
  BONE_ORDER,
  type AttachName,
  type BoneName,
  type CharacterFactory,
  type GongbiMaterials,
  type MaterialRequest,
  type UnitInstance,
  type UnitMeta,
} from '@core/contracts.ts';
import { type PigmentName } from '@core/palette.ts';
import { seedFor, type Rng } from '@core/rng.ts';
import { PieceType, Side, UNIT_KEY, type UnitKey } from '@core/types.ts';
import * as PARTS from './parts/index.ts';
import { addSmoothNormals, mergeGeometryList, triangleCount } from './parts/prim.ts';
import {
  resolvePigment,
  type AttachSpec,
  type BoneSpec,
  type InstancedPart,
  type Part,
  type PartGroup,
} from './parts/types.ts';
import { unitSpec, type UnitSpec } from './proportions.ts';
import { buildRig, type Rig, type RigOptions } from './rig.ts';
import { bindRigidToIndex, bindSkin } from './skinning.ts';

// ===========================================================================
// The unit-builder contract
// ===========================================================================

export interface UnitBuildContext {
  side: Side;
  type: PieceType;
  key: UnitKey;
  variant: number;
  /** Proportions, mount, gait, design and silhouette targets for this unit. */
  spec: UnitSpec;
  /**
   * The shared skeleton, already built from `spec.proportions`. Read
   * `rig.metrics` for measurements and `rig.bindWorld` for joint positions.
   */
  rig: Rig;
  /** Deterministic stream, seeded from (unit, side, variant). Never Math.random. */
  rng: Rng;
  /** The whole parts library. Do not import `@characters/parts/*` directly. */
  parts: typeof PARTS;
  /**
   * The renderer's material cache, injected. Almost no unit needs it — declare
   * `cls` and `pigment` on a part and the factory resolves both. It is here for
   * the rare case of a unit that must share a material with something else.
   */
  materials: GongbiMaterials;
  /**
   * Rebuild the rig with options — a lifted origin for a rider, or authored
   * bind-pose offsets for a seated or crouched figure. Returns the new rig and
   * installs it as `ctx.rig`; call it *before* building any geometry.
   */
  useRig(options: RigOptions): Rig;
}

/** What every file in `units/` exports and registers. */
export type UnitBuilder = (ctx: UnitBuildContext) => PartGroup;

const REGISTRY = new Map<PieceType, UnitBuilder>();

/**
 * Register a unit builder. Call this at module scope in `units/<name>.ts`:
 *
 *   registerUnit(PieceType.Soldier, buildSoldier);
 *
 * Registering twice for the same type replaces the previous builder, which is
 * what hot-reload wants and what a test that stubs a unit wants.
 */
export function registerUnit(type: PieceType, builder: UnitBuilder): void {
  REGISTRY.set(type, builder);
}

export function unregisterUnit(type: PieceType): void {
  REGISTRY.delete(type);
}

export function registeredUnits(): PieceType[] {
  return [...REGISTRY.keys()].sort((a, b) => a - b);
}

export function isUnitRegistered(type: PieceType): boolean {
  return REGISTRY.has(type);
}

// ===========================================================================
// Factory
// ===========================================================================

export interface FactoryOptions {
  /** The renderer's material cache. Injected — `characters` never imports it. */
  materials: GongbiMaterials;
  /**
   * Build unregistered units with the generic fallback figure instead of
   * throwing. On by default while the seven unit files are being written; a
   * shipping build should turn it off so a missing unit is a hard failure.
   */
  allowFallback?: boolean;
  /** The fallback builder. Injected so `factory.ts` need not import it. */
  fallback?: UnitBuilder;
  /** Diagnostics sink: budget overruns, silhouette drift, missing builders. */
  onWarn?: (message: string) => void;
  /**
   * Instance sets smaller than this are baked into the merged mesh they share a
   * material with instead of becoming their own `InstancedMesh`. Below the
   * threshold an InstancedMesh costs a draw call and saves only vertex memory,
   * which is the wrong trade at 32 units on screen. Raise it to trade draw
   * calls for memory, lower it (0) to keep every instance set instanced.
   */
  bakeInstancesBelow?: number;
  /**
   * Collapse every unit to a **single** merged mesh drawn with this one
   * material, instead of one mesh per (class, pigment) pair.
   *
   * `aMaterial` already carries the class and pigment on every vertex, so a
   * ramp shader that decodes it needs no material split at all — and the split
   * is what put a full board at ~475 meshes against a 260-draw-call budget.
   * The renderer supplies the material; `characters` merges. Doing the merge
   * here rather than downstream matters for memory: a consumer that merges
   * afterwards cannot free the originals, because the `UnitInstance` owns and
   * disposes them, so the whole cast's vertex data ends up in CPU memory twice.
   *
   * Instance sets large enough to survive `bakeInstancesBelow` stay their own
   * `InstancedMesh` — they cannot be merged into anything — but they are drawn
   * with this material too, so the material count still collapses to one.
   */
  atlasMaterial?: THREE.Material | ((skinned: boolean) => THREE.Material);
}

interface MeshGroupKey {
  cls: Part['cls'];
  pigment: PigmentName;
  noSilk: boolean;
}

export class Factory implements CharacterFactory {
  private readonly materials: GongbiMaterials;
  private readonly allowFallback: boolean;
  private readonly fallback: UnitBuilder | undefined;
  private readonly warn: (m: string) => void;
  private readonly bakeBelow: number;
  private readonly atlas: ((skinned: boolean) => THREE.Material) | null;

  private geometryCount = 0;
  private triangleTotal = 0;
  private readonly materialsSeen = new Set<THREE.Material>();
  private readonly live = new Set<UnitInstance>();

  constructor(opts: FactoryOptions) {
    this.materials = opts.materials;
    this.allowFallback = opts.allowFallback !== false;
    this.fallback = opts.fallback;
    this.warn = opts.onWarn ?? ((m) => console.warn(`[characters] ${m}`));
    this.bakeBelow = opts.bakeInstancesBelow ?? 24;
    const am = opts.atlasMaterial;
    this.atlas = am ? (typeof am === 'function' ? am : () => am) : null;
  }

  create(side: Side, type: PieceType, variant = 0): UnitInstance {
    const key = UNIT_KEY[type];
    if (!key) throw new Error(`characters: piece type ${type} has no unit`);

    const spec = unitSpec(side, type, variant);
    const rng = seedFor('unit', key, side, variant);
    let rig = buildRig(spec.proportions);

    const ctx: UnitBuildContext = {
      side,
      type,
      key,
      variant,
      spec,
      rig,
      rng,
      parts: PARTS,
      materials: this.materials,
      useRig: (options: RigOptions) => {
        rig = buildRig(spec.proportions, options);
        ctx.rig = rig;
        return rig;
      },
    };

    let builder = REGISTRY.get(type);
    if (!builder) {
      if (!this.allowFallback || !this.fallback) {
        throw new Error(
          `characters: no builder registered for ${key}. ` +
            `The unit author registers one with registerUnit(PieceType.${capitalise(key)}, fn) ` +
            `in src/characters/units/${key}.ts — see units/README.md.`,
        );
      }
      this.warn(`${key}: no builder registered, using the generic fallback figure`);
      builder = this.fallback;
    }

    const group = builder(ctx);
    return this.assemble(group, rig, spec, rng, variant);
  }

  // -------------------------------------------------------------------------

  private assemble(
    group: PartGroup,
    rig: Rig,
    spec: UnitSpec,
    rng: Rng,
    variant: number,
  ): UnitInstance {
    const root = new THREE.Group();
    root.name = `unit:${spec.side}:${spec.key}:${variant}`;
    root.add(rig.rootBone);
    root.scale.setScalar(spec.proportions.scale);

    // Per-unit value nudge so a rank of five soldiers is not one soldier five
    // times. Small — the value ladder in palette.ts is not negotiable.
    const variation = rng.range(-1, 1);

    // --- bind-space bookkeeping --------------------------------------------
    // All rebasing uses stored *unscaled* bind matrices rather than live
    // `matrixWorld`, so the root group's scale can never leak into a bone
    // inverse or an instance transform.
    const bindWorld = new Map<string, THREE.Matrix4>();
    for (const n of BONE_ORDER) bindWorld.set(n, rig.bindMatrix[n]);

    const mountBones: Record<string, THREE.Object3D> = {};
    const objectFor = (name: string): THREE.Object3D =>
      mountBones[name] ?? rig.bones[name as BoneName] ?? rig.bones.root;

    // --- mount bones --------------------------------------------------------
    this.buildMountBones(group.bones, bindWorld, mountBones, objectFor);

    // --- one skeleton for the figure AND its mount --------------------------
    // The first twenty bones are exactly `BONE_ORDER`, so a clip authored
    // against the shared rig retargets untouched. Mount bones are appended
    // after them. That lets a horse's sixteen leg-segment bones drive *skin
    // weights* instead of parenting sixteen separate meshes, which is the
    // difference between twenty draw calls per horse and two.
    const boneNames: string[] = [...BONE_ORDER];
    const allBones: THREE.Bone[] = [...rig.boneList];
    for (const name of Object.keys(mountBones)) {
      const b = mountBones[name];
      if (b instanceof THREE.Bone) {
        boneNames.push(name);
        allBones.push(b);
      }
    }
    const boneIndex = new Map<string, number>();
    boneNames.forEach((n, i) => boneIndex.set(n, i));
    const inverses = boneNames.map((n) => (bindWorld.get(n) ?? IDENTITY).clone().invert());
    const skeleton = new THREE.Skeleton(allBones, inverses);

    const skinned: THREE.SkinnedMesh[] = [];
    const props: THREE.Object3D[] = [];
    const owned = new Set<THREE.BufferGeometry>();
    let triangles = 0;

    // --- material buckets ---------------------------------------------------
    // Keyed on (class, pigment) only. `noSilk` deliberately does NOT split a
    // bucket: it is a small opt-out for tiny props, and splitting a material on
    // it would double the draw calls of every unit that has one ferrule on it.
    // A bucket asks for `noSilk` only when every part in it wanted it.
    const buckets = new Map<string, { key: MeshGroupKey; geoms: THREE.BufferGeometry[] }>();
    const bucketFor = (p: { cls: Part['cls']; pigment: PigmentName; noSilk?: boolean }) => {
      const k = `${p.cls}|${p.pigment}`;
      let b = buckets.get(k);
      if (!b) {
        b = { key: { cls: p.cls, pigment: p.pigment, noSilk: !!p.noSilk }, geoms: [] };
        buckets.set(k, b);
      } else if (!p.noSilk) {
        b.key.noSilk = false;
      }
      return b;
    };

    for (const p of group.parts) {
      const pigment = resolvePigment(p.pigment, spec.side);
      if (p.mountBone) {
        // Rigid on a mount bone. Geometry stays in rig space; the bone's
        // inverse bind matrix does the work.
        const idx = boneIndex.get(p.mountBone);
        if (idx === undefined) {
          this.warn(`${spec.key}: part "${p.name ?? '?'}" names unknown mount bone "${p.mountBone}"`);
          continue;
        }
        bindRigidToIndex(p.geometry, idx);
      } else {
        bindSkin(p.geometry, rig, p.boneHint, {
          ...(p.rigid ? { rigid: true } : {}),
          ...(p.allow ? { allow: p.allow } : {}),
          depth: p.rigid ? 1 : 2,
        });
      }
      bucketFor({ cls: p.cls, pigment, ...(p.noSilk ? { noSilk: true } : {}) }).geoms.push(p.geometry);
    }

    // --- instanced parts ----------------------------------------------------
    // Below the threshold an `InstancedMesh` costs a draw call and saves only
    // vertex memory, so a fifteen-plate pauldron is cheaper baked into the mesh
    // it shares a material with. Above it — a twenty-six-spoke wheel, a
    // ninety-plate cuirass row — instancing wins on both counts and stays.
    for (const p of group.instanced) {
      if (p.transforms.length === 0) continue;
      const host = p.mountBone ?? p.boneHint;
      const idx = boneIndex.get(host);
      const pigment = resolvePigment(p.pigment, spec.side);

      if (p.transforms.length < this.bakeBelow && idx !== undefined) {
        const bucket = bucketFor({ cls: p.cls, pigment, ...(p.noSilk ? { noSilk: true } : {}) });
        for (const t of p.transforms) {
          const g = p.geometry.clone();
          g.applyMatrix4(t);
          bindRigidToIndex(g, idx);
          bucket.geoms.push(g);
        }
        continue;
      }

      const inv = (bindWorld.get(host) ?? IDENTITY).clone().invert();
      const mat = this.atlas
        ? this.trackMaterial(this.atlas(false))
        : this.material({
            cls: p.cls,
            pigment,
            variation,
            ...(p.noSilk ? { noSilk: true } : {}),
          });
      // Instanced geometry is shared between bands, so it may already carry
      // smooth normals from an earlier band; adding them twice is wasteful.
      if (!p.geometry.getAttribute('aSmoothNormal')) addSmoothNormals(p.geometry);
      if (!p.geometry.getAttribute('aMaterial')) tagMaterial(p.geometry, p.cls, pigment);
      const mesh = new THREE.InstancedMesh(p.geometry, mat, p.transforms.length);
      mesh.name = `${spec.key}:${p.name ?? 'instanced'}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const m = new THREE.Matrix4();
      for (let i = 0; i < p.transforms.length; i++) {
        m.multiplyMatrices(inv, p.transforms[i]);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      objectFor(host).add(mesh);
      props.push(mesh);
      if (!owned.has(p.geometry)) {
        owned.add(p.geometry);
        this.geometryCount++;
      }
      triangles += triangleCount(p.geometry) * p.transforms.length;
    }

    // --- merge ---------------------------------------------------------------
    // Tagging happens per source geometry rather than per merged bucket, so the
    // same tagged geometries can be merged either per bucket or all together.
    for (const bucket of buckets.values()) {
      for (const g of bucket.geoms) {
        if (!g.getAttribute('aMaterial')) tagMaterial(g, bucket.key.cls, bucket.key.pigment);
      }
    }

    const addSkinned = (geoms: THREE.BufferGeometry[], mat: THREE.Material, name: string) => {
      const merged = addSmoothNormals(mergeGeometryList(geoms));
      owned.add(merged);
      this.geometryCount++;
      const mesh = new THREE.SkinnedMesh(merged, mat);
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Explicit identity bind matrix: the geometry is authored in the same
      // space the bone inverses were taken in, and the mesh's own transform is
      // cancelled out by three's attached bind mode.
      mesh.bind(skeleton, new THREE.Matrix4());
      root.add(mesh);
      skinned.push(mesh);
      triangles += triangleCount(merged);
    };

    if (this.atlas) {
      const all: THREE.BufferGeometry[] = [];
      for (const bucket of buckets.values()) all.push(...bucket.geoms);
      if (all.length > 0) {
        addSkinned(all, this.trackMaterial(this.atlas(true)), `${spec.key}:atlas`);
      }
    } else {
      for (const bucket of buckets.values()) {
        if (bucket.geoms.length === 0) continue;
        addSkinned(
          bucket.geoms,
          this.material({
            cls: bucket.key.cls,
            pigment: bucket.key.pigment,
            skinned: true,
            variation,
            ...(bucket.key.noSilk ? { noSilk: true } : {}),
          }),
          `${spec.key}:${bucket.key.cls}:${bucket.key.pigment}`,
        );
      }
    }

    // --- attachment sockets -------------------------------------------------
    const attach = this.buildAttachments(group, rig, bindWorld, objectFor);

    // --- measure ------------------------------------------------------------
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    const measured: [number, number, number] = [size.x, size.y, size.z];

    const meta: UnitMeta = {
      key: spec.key,
      side: spec.side,
      type: spec.type,
      proportions: spec.proportions,
      mount: spec.mount,
      size: measured,
      silhouette: {
        aspect: spec.silhouette.aspect,
        crown: spec.silhouette.crown,
        widthClass: spec.silhouette.widthClass,
      },
      dispersal: spec.dispersal,
      gait: spec.gait,
      triangles,
    };

    this.checkBudget(spec, meta, measured);
    this.triangleTotal += triangles;

    const instance: UnitInstance = {
      root,
      skinned,
      props,
      skeleton,
      bones: rig.bones,
      mountBones,
      attach,
      meta,
      dispose: () => {
        for (const g of owned) g.dispose();
        this.triangleTotal -= triangles;
        this.geometryCount -= owned.size;
        this.live.delete(instance);
        root.removeFromParent();
      },
    };
    this.live.add(instance);
    return instance;
  }

  // -------------------------------------------------------------------------

  private buildMountBones(
    specs: BoneSpec[],
    bindWorld: Map<string, THREE.Matrix4>,
    out: Record<string, THREE.Object3D>,
    objectFor: (name: string) => THREE.Object3D,
  ): void {
    // Parents may appear after children in the list, so resolve iteratively
    // rather than assuming an order the unit author had to remember.
    let pending = [...specs];
    let guard = pending.length + 2;
    while (pending.length > 0 && guard-- > 0) {
      const next: BoneSpec[] = [];
      for (const s of pending) {
        const parentName = s.parent ?? 'root';
        if (!bindWorld.has(parentName)) {
          next.push(s);
          continue;
        }
        const world = new THREE.Matrix4().compose(
          new THREE.Vector3(...s.position),
          new THREE.Quaternion().setFromEuler(
            new THREE.Euler(...(s.rotation ?? [0, 0, 0]), 'XYZ'),
          ),
          ONE,
        );
        const local = bindWorld.get(parentName)!.clone().invert().multiply(world);
        const bone = new THREE.Bone();
        bone.name = s.name;
        local.decompose(bone.position, bone.quaternion, bone.scale);
        if (s.data) bone.userData = { ...s.data };
        objectFor(parentName).add(bone);
        out[s.name] = bone;
        bindWorld.set(s.name, world);
      }
      if (next.length === pending.length) {
        this.warn(
          `mount bones with unresolved parents: ${next.map((b) => `${b.name}<-${b.parent}`).join(', ')}`,
        );
        break;
      }
      pending = next;
    }
  }

  private buildAttachments(
    group: PartGroup,
    rig: Rig,
    bindWorld: Map<string, THREE.Matrix4>,
    objectFor: (name: string) => THREE.Object3D,
  ): Partial<Record<AttachName, THREE.Object3D>> {
    const attach: Partial<Record<AttachName, THREE.Object3D>> = {};
    const specs: AttachSpec[] = [...group.attach];

    // Convenience: a part that published a `gripR`/`gripL`/`crest` point but no
    // explicit socket still gets one. Saves every unit author writing the same
    // three lines, and keeps the animator's assumptions true by default.
    const implied: [string, AttachName, string][] = [
      ['gripR', 'gripR', 'handR'],
      ['gripL', 'gripL', 'handL'],
      ['crest', 'crest', 'head'],
      ['trunkTip', 'trunkTip', 'head'],
    ];
    for (const [pointName, socket, bone] of implied) {
      if (specs.some((s) => s.name === socket)) continue;
      const p = group.points[pointName];
      if (!p) continue;
      specs.push({ name: socket, bone, position: [p.x, p.y, p.z] });
    }

    for (const s of specs) {
      const obj = new THREE.Object3D();
      obj.name = `attach:${s.name}`;
      const world = new THREE.Matrix4().compose(
        new THREE.Vector3(...s.position),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...(s.rotation ?? [0, 0, 0]), 'XYZ')),
        ONE,
      );
      const parentName = bindWorld.has(s.bone) ? s.bone : 'root';
      const local = bindWorld.get(parentName)!.clone().invert().multiply(world);
      local.decompose(obj.position, obj.quaternion, obj.scale);
      objectFor(parentName).add(obj);
      attach[s.name as AttachName] = obj;
    }
    void rig;
    return attach;
  }

  private checkBudget(spec: UnitSpec, meta: UnitMeta, size: [number, number, number]): void {
    if (meta.triangles > spec.budget) {
      this.warn(
        `${spec.key} (${spec.side === Side.Red ? 'Han' : 'Chu'}): ${meta.triangles} triangles ` +
          `exceeds the ${spec.budget} budget by ${meta.triangles - spec.budget}`,
      );
    }
    const h = size[1];
    const w = Math.max(size[0], size[2]);
    if (h > 1e-4) {
      const aspect = w / h;
      const drift = Math.abs(aspect - spec.silhouette.aspect) / spec.silhouette.aspect;
      if (drift > 0.35) {
        this.warn(
          `${spec.key}: measured aspect ${aspect.toFixed(2)} drifts ${(drift * 100) | 0}% ` +
            `from the declared ${spec.silhouette.aspect.toFixed(2)} — the silhouette table is now a lie`,
        );
      }
      const hDrift = Math.abs(h - spec.silhouette.height) / spec.silhouette.height;
      if (hDrift > 0.3) {
        this.warn(
          `${spec.key}: measured height ${h.toFixed(2)} drifts ${(hDrift * 100) | 0}% ` +
            `from the declared ${spec.silhouette.height.toFixed(2)}`,
        );
      }
    }
  }

  private material(req: MaterialRequest): THREE.Material {
    return this.trackMaterial(this.materials.get(req));
  }

  private trackMaterial(m: THREE.Material): THREE.Material {
    this.materialsSeen.add(m);
    return m;
  }

  // -------------------------------------------------------------------------

  /**
   * Build one of every (side, type) so the first move never hitches on geometry
   * generation or shader compilation, then throw them away. Yields between
   * units so a boot sequence can still paint.
   */
  async prewarm(): Promise<void> {
    for (const side of [Side.Red, Side.Black] as const) {
      for (const type of [
        PieceType.General,
        PieceType.Advisor,
        PieceType.Elephant,
        PieceType.Horse,
        PieceType.Chariot,
        PieceType.Cannon,
        PieceType.Soldier,
      ]) {
        const u = this.create(side, type, 0);
        u.dispose();
        await Promise.resolve();
      }
    }
  }

  stats(): { geometries: number; triangles: number; materials: number } {
    return {
      geometries: this.geometryCount,
      triangles: this.triangleTotal,
      materials: this.materialsSeen.size,
    };
  }

  dispose(): void {
    for (const u of [...this.live]) u.dispose();
    this.live.clear();
    this.materialsSeen.clear();
    this.geometryCount = 0;
    this.triangleTotal = 0;
  }
}

const ONE = new THREE.Vector3(1, 1, 1);
const IDENTITY = new THREE.Matrix4();

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Stamp `aMaterial` on a geometry: `classIndex * 16 + pigmentIndex`, one float
 * per vertex.
 *
 * Nothing in `characters` reads it. It is here because the draw-call arithmetic
 * for this project does not close under one-material-per-(class, pigment): a
 * full board is roughly 500 meshes, and doubling that for the inverted-hull
 * outline pass puts it well past the 260-call budget. The way out is a single
 * ramp shader that looks its parameters up per vertex instead of per material,
 * and this attribute is exactly what such a shader needs. Emitting it costs
 * four bytes a vertex and means the renderer can adopt that path without
 * `characters` changing at all.
 *
 * Decode: `cls = MATERIAL_CLASS_ORDER[floor(aMaterial / 16)]`,
 *         `pigment = PIGMENT_ORDER[mod(aMaterial, 16)]`.
 */
function tagMaterial(g: THREE.BufferGeometry, cls: Part['cls'], pigment: PigmentName): void {
  const ci = MATERIAL_CLASS_ORDER.indexOf(cls);
  const pi = PIGMENT_ORDER.indexOf(pigment);
  const code = Math.max(0, ci) * 16 + Math.max(0, pi);
  const n = (g.getAttribute('position') as THREE.BufferAttribute).count;
  const arr = new Float32Array(n);
  arr.fill(code);
  g.setAttribute('aMaterial', new THREE.Float32BufferAttribute(arr, 1));
}

/** Encoding order for `aMaterial`. Frozen: the renderer decodes against it. */
export const MATERIAL_CLASS_ORDER: readonly Part['cls'][] = [
  'lacquer',
  'cloth',
  'leather',
  'gold',
  'ivory',
  'timber',
  'stone',
  'silk',
  'flesh',
  'hair',
  'iron',
];

export const PIGMENT_ORDER: readonly PigmentName[] = [
  'azurite',
  'malachite',
  'cinnabar',
  'ochre',
  'gamboge',
  'shellWhite',
  'ink',
  'inkLacquer',
  'gold',
  'indigo',
  'vermilionDeep',
  'stone',
];

/** Construct the factory. `main.ts` calls this once, after the renderer exists. */
export function createCharacterFactory(opts: FactoryOptions): Factory {
  return new Factory(opts);
}
