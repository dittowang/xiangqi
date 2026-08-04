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
import { bindSkin } from './skinning.ts';

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

  private geometryCount = 0;
  private triangleTotal = 0;
  private readonly materialsSeen = new Set<THREE.Material>();
  private readonly live = new Set<UnitInstance>();

  constructor(opts: FactoryOptions) {
    this.materials = opts.materials;
    this.allowFallback = opts.allowFallback !== false;
    this.fallback = opts.fallback;
    this.warn = opts.onWarn ?? ((m) => console.warn(`[characters] ${m}`));
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

    const skinned: THREE.SkinnedMesh[] = [];
    const props: THREE.Object3D[] = [];
    const owned = new Set<THREE.BufferGeometry>();
    let triangles = 0;

    // --- skinned parts ------------------------------------------------------
    const skinGroups = new Map<string, { key: MeshGroupKey; geoms: THREE.BufferGeometry[] }>();
    for (const p of group.parts) {
      if (p.mountBone) continue;
      const geo = p.geometry;
      bindSkin(geo, rig, p.boneHint, {
        ...(p.rigid ? { rigid: true } : {}),
        ...(p.allow ? { allow: p.allow } : {}),
        depth: p.rigid ? 1 : 2,
      });
      const pigment = resolvePigment(p.pigment, spec.side);
      const k = `${p.cls}|${pigment}|${p.noSilk ? 1 : 0}`;
      let bucket = skinGroups.get(k);
      if (!bucket) {
        bucket = { key: { cls: p.cls, pigment, noSilk: !!p.noSilk }, geoms: [] };
        skinGroups.set(k, bucket);
      }
      bucket.geoms.push(geo);
    }
    for (const bucket of skinGroups.values()) {
      const merged = addSmoothNormals(mergeGeometryList(bucket.geoms));
      owned.add(merged);
      this.geometryCount++;
      const mat = this.material({
        cls: bucket.key.cls,
        pigment: bucket.key.pigment,
        skinned: true,
        variation,
        ...(bucket.key.noSilk ? { noSilk: true } : {}),
      });
      const mesh = new THREE.SkinnedMesh(merged, mat);
      mesh.name = `${spec.key}:${bucket.key.cls}:${bucket.key.pigment}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Explicit identity bind matrix: the geometry is authored in the same
      // space the bone inverses were taken in, and the mesh's own transform is
      // cancelled out by three's attached bind mode.
      mesh.bind(rig.skeleton, new THREE.Matrix4());
      root.add(mesh);
      skinned.push(mesh);
      triangles += triangleCount(merged);
    }

    // --- rigid parts on mount bones ----------------------------------------
    const rigidGroups = new Map<
      string,
      { key: MeshGroupKey; bone: string; geoms: THREE.BufferGeometry[] }
    >();
    for (const p of group.parts) {
      if (!p.mountBone) continue;
      const pigment = resolvePigment(p.pigment, spec.side);
      const k = `${p.mountBone}|${p.cls}|${pigment}|${p.noSilk ? 1 : 0}`;
      let bucket = rigidGroups.get(k);
      if (!bucket) {
        bucket = {
          key: { cls: p.cls, pigment, noSilk: !!p.noSilk },
          bone: p.mountBone,
          geoms: [],
        };
        rigidGroups.set(k, bucket);
      }
      // Rig space into the owning bone's local space.
      const inv = (bindWorld.get(p.mountBone) ?? IDENTITY).clone().invert();
      p.geometry.applyMatrix4(inv);
      bucket.geoms.push(p.geometry);
    }
    for (const bucket of rigidGroups.values()) {
      const merged = addSmoothNormals(mergeGeometryList(bucket.geoms));
      owned.add(merged);
      this.geometryCount++;
      const mat = this.material({
        cls: bucket.key.cls,
        pigment: bucket.key.pigment,
        variation,
        ...(bucket.key.noSilk ? { noSilk: true } : {}),
      });
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `${spec.key}:${bucket.bone}:${bucket.key.cls}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      objectFor(bucket.bone).add(mesh);
      props.push(mesh);
      triangles += triangleCount(merged);
    }

    // --- instanced parts ----------------------------------------------------
    for (const p of group.instanced) {
      if (p.transforms.length === 0) continue;
      const host = p.mountBone ?? p.boneHint;
      const inv = (bindWorld.get(host) ?? IDENTITY).clone().invert();
      const pigment = resolvePigment(p.pigment, spec.side);
      const mat = this.material({
        cls: p.cls,
        pigment,
        variation,
        ...(p.noSilk ? { noSilk: true } : {}),
      });
      // Instanced geometry is shared between bands, so it may already carry
      // smooth normals from an earlier unit; adding them twice is harmless but
      // wasteful, hence the guard.
      if (!p.geometry.getAttribute('aSmoothNormal')) addSmoothNormals(p.geometry);
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
      owned.add(p.geometry);
      this.geometryCount++;
      triangles += triangleCount(p.geometry) * p.transforms.length;
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
      skeleton: rig.skeleton,
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
    const m = this.materials.get(req);
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

/** Construct the factory. `main.ts` calls this once, after the renderer exists. */
export function createCharacterFactory(opts: FactoryOptions): Factory {
  return new Factory(opts);
}
