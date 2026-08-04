/**
 * Weapons: 戈 戟 矛 劍 刀 弓 盾 鉞 節.
 *
 * AUTHORING CONVENTION — every builder in this file follows it, and every unit
 * author depends on it:
 *
 *   A weapon is built in *grip space* — the point the hand closes around is the
 *   origin, the haft runs along +Y, the business end is at +Y — and is then
 *   transformed into rig space by `grip` and `rot` before being returned. Every
 *   builder publishes `tip` (the far end, in rig space) so the animator can use
 *   it as an IK target, and `butt` (the near end).
 *
 * That convention exists because `body.hand()` bores a real grip cylinder along
 * +Y through the fist. A haft placed at the published `gripR`/`gripL` point
 * passes through that bore, so the weapon is *held*, not parented next to a
 * wrist. It is the difference the motion critic will notice first.
 *
 * BLADES — the brief's requirement, and it is the right one: every edged weapon
 * here goes through `bladeGeometry`, which sweeps a seven-point cross-section
 * with a real edge bevel and a ground fuller. A fuller is not decoration; it is
 * a second highlight band running the length of the blade, and under a hard
 * four-step iron ramp it is the only thing distinguishing a sword from a
 * painted plank.
 *
 * HAFTS are tapered faceted prisms with binding rings, never cylinders. A
 * cylinder under a quantised ramp produces one band down its whole length; a
 * six-sided taper produces three, and the rings break it into segments.
 */

import * as THREE from 'three';
import type { BoneName } from '@core/contracts.ts';
import {
  bevelSlab,
  bladeGeometry,
  extrudePlanar,
  hardLathe,
  loft,
  prism,
  ring,
  shell,
  sweep,
} from './prim.ts';
import { boss, ferrule, tassel } from './trim.ts';
import {
  emptyGroup,
  mergeGroups,
  mkPart,
  transformGroup,
  type Part,
  type PartGroup,
  type PartPigment,
  type V2,
  type V3,
} from './types.ts';

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

export interface WeaponBase {
  /** Where the hand grips it, rig space. */
  grip: V3;
  /** XYZ Euler applied about the grip, radians. Default: haft vertical. */
  rot?: V3;
  /** Bone the weapon rides on. Defaults to the right hand. */
  bone?: BoneName;
  /** Mount bone instead of a humanoid bone (a weapon racked on a chariot). */
  mountBone?: string;
  pigment?: PartPigment;
  metalPigment?: PartPigment;
  /** Overall scale multiplier applied after construction. */
  scale?: number;
}

const IRON = 'iron' as const;
const TIMBER = 'ochre' as const;

function finish(g: PartGroup, o: WeaponBase, bone: BoneName): PartGroup {
  for (const p of g.parts) {
    p.boneHint = bone;
    p.rigid = true;
    if (o.mountBone) p.mountBone = o.mountBone;
  }
  for (const p of g.instanced) {
    p.boneHint = bone;
    p.rigid = true;
    if (o.mountBone) p.mountBone = o.mountBone;
  }
  const s = o.scale ?? 1;
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...o.grip),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0]), 'XYZ')),
    new THREE.Vector3(s, s, s),
  );
  return transformGroup(g, m);
}

// ---------------------------------------------------------------------------
// Hafts
// ---------------------------------------------------------------------------

export interface HaftOpts {
  /** Distance below the grip the butt sits. */
  below: number;
  /** Distance above the grip the head sits. */
  above: number;
  /** Radius at the grip. */
  r: number;
  /** Taper: radius at the butt as a multiple of `r`. */
  buttTaper?: number;
  /** Taper: radius at the head as a multiple of `r`. */
  headTaper?: number;
  sides?: number;
  /** Binding rings up the shaft. */
  rings?: number;
  pigment?: PartPigment;
  metalPigment?: PartPigment;
  boneHint?: BoneName;
}

/**
 * A polearm shaft in grip space: a faceted taper from butt to head with binding
 * rings. Han hafts are laminated bamboo bound with lacquered cord, which is
 * exactly a tapered prism with rings on it.
 */
export function haft(o: HaftOpts): PartGroup {
  const g = emptyGroup();
  const bone = o.boneHint ?? 'handR';
  const sides = o.sides ?? 6;
  const shaft = prism({
    rx0: o.r * (o.buttTaper ?? 1.06),
    rx1: o.r * (o.headTaper ?? 0.86),
    y0: -o.below,
    y1: o.above,
    sides,
    phase: Math.PI / sides,
    squareness: 0.34,
    name: 'haft',
  });
  g.parts.push(mkPart(shaft, 'timber', o.pigment ?? TIMBER, bone, { name: 'haft', rigid: true }));

  const n = o.rings ?? 3;
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / (n + 1);
    const y = -o.below + (o.above + o.below) * t;
    g.parts.push(
      ferrule({
        at: [0, y, 0],
        r: o.r * 0.95,
        height: o.r * 0.55,
        proud: o.r * 0.12,
        boneHint: bone,
        pigment: o.metalPigment ?? 'metal',
        sides,
      }),
    );
  }

  // Butt cap: a small ferrule, so the bottom end is finished.
  g.parts.push(
    ferrule({
      at: [0, -o.below + o.r * 0.4, 0],
      r: o.r * 1.02,
      height: o.r * 0.8,
      proud: o.r * 0.1,
      boneHint: bone,
      pigment: o.metalPigment ?? 'metal',
      sides,
    }),
  );

  g.points.butt = new THREE.Vector3(0, -o.below, 0);
  g.points.head = new THREE.Vector3(0, o.above, 0);
  return g;
}

/** Binding rings on their own, for a shaft built by hand. */
export function bindingRings(o: {
  from: V3;
  to: V3;
  count: number;
  r: number;
  boneHint: BoneName;
  pigment?: PartPigment;
}): PartGroup {
  const g = emptyGroup();
  for (let i = 0; i < o.count; i++) {
    const t = (i + 1) / (o.count + 1);
    g.parts.push(
      ferrule({
        at: [
          o.from[0] + (o.to[0] - o.from[0]) * t,
          o.from[1] + (o.to[1] - o.from[1]) * t,
          o.from[2] + (o.to[2] - o.from[2]) * t,
        ],
        r: o.r,
        height: o.r * 0.6,
        boneHint: o.boneHint,
        pigment: o.pigment ?? 'metal',
      }),
    );
  }
  return g;
}

// ---------------------------------------------------------------------------
// Blades
// ---------------------------------------------------------------------------

export interface BladeOpts {
  /** Blade length. */
  length: number;
  /** Half-width at the widest point. */
  halfWidth: number;
  thickness: number;
  /** Fuller depth, 0..0.6. */
  fuller?: number;
  /** Where the blade starts along +Y. */
  y0?: number;
  /** Single-edged: bias the spine to one side. */
  singleEdged?: boolean;
  pigment?: PartPigment;
  boneHint?: BoneName;
  name?: string;
}

/**
 * A leaf blade — the shape shared by a 矛 head, a 劍 blade and a 戈 援, differing
 * only in proportion. Six stations along the length, so the profile has real
 * shoulders instead of being an ellipse.
 */
export function blade(o: BladeOpts): Part {
  const y0 = o.y0 ?? 0;
  const L = o.length;
  const W = o.halfWidth;
  const outline: V2[] = [
    [W * 0.5, y0],
    [W * 0.98, y0 + L * 0.14],
    [W, y0 + L * 0.34],
    [W * 0.82, y0 + L * 0.62],
    [W * 0.48, y0 + L * 0.86],
    [W * 0.02, y0 + L],
  ];
  const offset = o.singleEdged ? outline.map((p) => p[0] * 0.42) : undefined;
  const g = bladeGeometry({
    outline,
    thickness: o.thickness,
    fuller: o.fuller ?? 0.42,
    fullerWidth: o.singleEdged ? 0.62 : 0.42,
    edgeBevel: 0.32,
    ...(offset ? { offset } : {}),
    name: o.name ?? 'blade',
  });
  return mkPart(g, IRON, o.pigment ?? 'metal', o.boneHint ?? 'handR', {
    name: o.name ?? 'blade',
    rigid: true,
  });
}

// ---------------------------------------------------------------------------
// 矛 — spear
// ---------------------------------------------------------------------------

export interface SpearOpts extends WeaponBase {
  /** Total length of the weapon. */
  length: number;
  /** How far below the grip the butt sits, as a fraction of length. */
  gripAt?: number;
  headLength?: number;
  shaftR?: number;
}

export function spear(o: SpearOpts): PartGroup {
  const bone = o.bone ?? 'handR';
  const L = o.length;
  const gripAt = o.gripAt ?? 0.34;
  const below = L * gripAt;
  const above = L * (1 - gripAt);
  const r = o.shaftR ?? L * 0.014;
  const headL = o.headLength ?? L * 0.2;

  const g = mergeGroups(
    haft({
      below,
      above: above - headL,
      r,
      rings: 3,
      pigment: o.pigment,
      metalPigment: o.metalPigment,
      boneHint: bone,
    }),
  );

  // Socket collar joining head to shaft.
  const socket = hardLathe(
    [
      [r * 1.1, above - headL - r * 1.4],
      [r * 1.35, above - headL - r * 0.4],
      [r * 1.1, above - headL + r * 0.9],
      [r * 0.7, above - headL + r * 1.6],
    ],
    6,
    { capStart: false, capEnd: false, name: 'spearSocket' },
  );
  g.parts.push(mkPart(socket, IRON, o.metalPigment ?? 'metal', bone, { name: 'socket', rigid: true }));

  g.parts.push(
    blade({
      length: headL,
      halfWidth: L * 0.028,
      thickness: L * 0.011,
      fuller: 0.46,
      y0: above - headL + r * 0.8,
      pigment: o.metalPigment,
      boneHint: bone,
      name: 'spearHead',
    }),
  );

  // 纓 — the horsehair tassel below the head, the detail that says 矛.
  g.instanced.push(
    ...tassel({
      at: [0, above - headL - r * 0.6, 0],
      length: L * 0.09,
      r: r * 2.1,
      strands: 6,
      boneHint: bone,
      pigment: o.pigment ?? 'accent',
    }).instanced,
  );

  g.points.tip = new THREE.Vector3(0, above, 0);
  return finish(g, o, bone);
}

// ---------------------------------------------------------------------------
// 戈 — dagger-axe
// ---------------------------------------------------------------------------

export interface GeOpts extends WeaponBase {
  length: number;
  gripAt?: number;
  shaftR?: number;
  /** Length of the horizontal blade 援. */
  bladeLength?: number;
}

/**
 * 戈 — the Han conscript's weapon and one of the most recognisable outlines in
 * Chinese arms: a horizontal blade lashed at right angles near the top of a
 * long haft, with a downward-hooking 胡 and a rearward 內 tang. Held upright it
 * gives a vertical stroke with a single hard perpendicular — which is exactly
 * the silhouette accent a rank of otherwise identical conscripts needs.
 */
export function ge(o: GeOpts): PartGroup {
  const bone = o.bone ?? 'handR';
  const L = o.length;
  const gripAt = o.gripAt ?? 0.38;
  const below = L * gripAt;
  const above = L * (1 - gripAt);
  const r = o.shaftR ?? L * 0.014;
  const bl = o.bladeLength ?? L * 0.22;

  const g = mergeGroups(
    haft({ below, above, r, rings: 4, pigment: o.pigment, metalPigment: o.metalPigment, boneHint: bone }),
  );

  // The 援: a tapering blade running forward (-Z), with a fuller, plus the 胡
  // hooking down along the haft.
  const headY = above - bl * 0.28;
  const armOutline: V2[] = [
    [bl * 0.17, 0],
    [bl * 0.155, bl * 0.28],
    [bl * 0.125, bl * 0.6],
    [bl * 0.075, bl * 0.84],
    [bl * 0.008, bl],
  ];
  const arm = bladeGeometry({
    outline: armOutline,
    thickness: bl * 0.055,
    fuller: 0.4,
    fullerWidth: 0.4,
    name: 'geArm',
  });
  // Built along +Y; lay it forward along -Z and lift it to the head.
  arm.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  arm.translate(0, headY, 0);
  g.parts.push(mkPart(arm, IRON, o.metalPigment ?? 'metal', bone, { name: 'geArm', rigid: true }));

  // 胡 — the hooked spur running down the front of the haft.
  const huOutline: V2[] = [
    [bl * 0.1, 0],
    [bl * 0.085, bl * 0.36],
    [bl * 0.05, bl * 0.68],
    [bl * 0.006, bl * 0.82],
  ];
  const hu = bladeGeometry({ outline: huOutline, thickness: bl * 0.045, fuller: 0.3, name: 'geHu' });
  hu.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI));
  hu.translate(0, headY - r * 0.4, -r * 1.5);
  g.parts.push(mkPart(hu, IRON, o.metalPigment ?? 'metal', bone, { name: 'geHu', rigid: true }));

  // 內 — the flat tang projecting behind the haft, with its lashing.
  const nei = bevelSlab({ w: r * 1.3, h: bl * 0.3, d: r * 0.5, bevel: r * 0.16 });
  nei.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  nei.translate(0, headY, r * 2.0);
  g.parts.push(mkPart(nei, IRON, o.metalPigment ?? 'metal', bone, { name: 'geNei', rigid: true }));

  for (let i = 0; i < 3; i++) {
    g.parts.push(
      ferrule({
        at: [0, headY - r * 1.2 - i * r * 1.5, 0],
        r: r * 1.02,
        height: r * 0.5,
        proud: r * 0.2,
        boneHint: bone,
        pigment: 'accent',
      }),
    );
  }

  g.points.tip = new THREE.Vector3(0, headY, -bl);
  g.points.head = new THREE.Vector3(0, above, 0);
  return finish(g, o, bone);
}

// ---------------------------------------------------------------------------
// 戟 — halberd
// ---------------------------------------------------------------------------

export interface JiOpts extends GeOpts {
  headLength?: number;
}

/** 戟 — a 戈 with a spear point on top. The officer's polearm. */
export function ji(o: JiOpts): PartGroup {
  const bone = o.bone ?? 'handR';
  const L = o.length;
  const headL = o.headLength ?? L * 0.17;
  // Build the 戈 body untransformed, then add the point, then transform once.
  const base = ge({ ...o, rot: [0, 0, 0], grip: [0, 0, 0], scale: 1 });
  const gripAt = o.gripAt ?? 0.38;
  const above = L * (1 - gripAt);
  base.parts.push(
    blade({
      length: headL,
      halfWidth: L * 0.024,
      thickness: L * 0.009,
      fuller: 0.44,
      y0: above,
      pigment: o.metalPigment,
      boneHint: bone,
      name: 'jiPoint',
    }),
  );
  base.points.tip = new THREE.Vector3(0, above + headL, 0);
  return finish(base, o, bone);
}

// ---------------------------------------------------------------------------
// 劍 — sword
// ---------------------------------------------------------------------------

export interface SwordOpts extends WeaponBase {
  /** Blade length. */
  length: number;
  halfWidth?: number;
  /** Point the blade down instead of up (a sheathed-carry or salute pose). */
  reversed?: boolean;
}

export function sword(o: SwordOpts): PartGroup {
  const bone = o.bone ?? 'handR';
  const L = o.length;
  const W = o.halfWidth ?? L * 0.042;
  const gripLen = L * 0.24;
  const g = emptyGroup();

  // 莖 — the grip, with its two binding rings.
  const grip = prism({
    rx0: W * 0.42,
    rz0: W * 0.3,
    rx1: W * 0.38,
    rz1: W * 0.27,
    y0: -gripLen * 0.55,
    y1: gripLen * 0.45,
    sides: 8,
    phase: Math.PI / 8,
    squareness: 0.4,
    name: 'swordGrip',
  });
  g.parts.push(mkPart(grip, 'leather', o.pigment ?? 'leather', bone, { name: 'swordGrip', rigid: true }));
  for (let i = 0; i < 2; i++) {
    g.parts.push(
      ferrule({
        at: [0, -gripLen * 0.3 + i * gripLen * 0.5, 0],
        r: W * 0.4,
        height: W * 0.16,
        proud: W * 0.06,
        boneHint: bone,
        pigment: o.metalPigment ?? 'metal',
        sides: 8,
      }),
    );
  }

  // 首 — the pommel disc.
  g.parts.push(
    boss({
      at: [0, -gripLen * 0.58, 0],
      r: W * 0.62,
      height: W * 0.34,
      boneHint: bone,
      pigment: o.metalPigment ?? 'metal',
      rot: [Math.PI, 0, 0],
      sides: 8,
    }),
  );

  // 格 — the guard.
  const guard = bevelSlab({
    w: W * 2.3,
    h: W * 0.36,
    d: W * 0.62,
    bevel: W * 0.12,
    name: 'swordGuard',
  });
  guard.translate(0, gripLen * 0.5, 0);
  g.parts.push(mkPart(guard, IRON, o.metalPigment ?? 'metal', bone, { name: 'guard', rigid: true }));

  g.parts.push(
    blade({
      length: L,
      halfWidth: W,
      thickness: W * 0.34,
      fuller: 0.5,
      y0: gripLen * 0.6,
      pigment: o.metalPigment,
      boneHint: bone,
      name: 'swordBlade',
    }),
  );

  g.points.tip = new THREE.Vector3(0, gripLen * 0.6 + L, 0);
  const rot = o.reversed
    ? ([Math.PI + (o.rot?.[0] ?? 0), o.rot?.[1] ?? 0, o.rot?.[2] ?? 0] as V3)
    : o.rot;
  return finish(g, { ...o, ...(rot ? { rot } : {}) }, bone);
}

// ---------------------------------------------------------------------------
// 刀 — dao
// ---------------------------------------------------------------------------

export interface DaoOpts extends WeaponBase {
  length: number;
  halfWidth?: number;
}

/**
 * 刀 — the single-edged ring-pommel sabre. Straight-backed, as Han 環首刀 are;
 * the curve comes later in history and would read as a much later weapon.
 */
export function dao(o: DaoOpts): PartGroup {
  const bone = o.bone ?? 'handR';
  const L = o.length;
  const W = o.halfWidth ?? L * 0.034;
  const gripLen = L * 0.2;
  const g = emptyGroup();

  const grip = prism({
    rx0: W * 0.5,
    rz0: W * 0.32,
    rx1: W * 0.46,
    rz1: W * 0.3,
    y0: -gripLen * 0.6,
    y1: gripLen * 0.4,
    sides: 6,
    squareness: 0.5,
    name: 'daoGrip',
  });
  g.parts.push(mkPart(grip, 'leather', o.pigment ?? 'leather', bone, { name: 'daoGrip', rigid: true }));

  // 環首 — the ring pommel. This ring *is* the weapon's identity.
  const ringProfile: V2[] = [];
  for (let i = 0; i <= 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    ringProfile.push([W * 0.62 + Math.cos(a) * W * 0.16, Math.sin(a) * W * 0.16]);
  }
  const pommel = hardLathe(ringProfile, 8, { capStart: false, capEnd: false, name: 'daoRing' });
  pommel.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  pommel.translate(0, -gripLen * 0.72, 0);
  g.parts.push(mkPart(pommel, IRON, o.metalPigment ?? 'metal', bone, { name: 'daoRing', rigid: true }));

  const collar = ferrule({
    at: [0, gripLen * 0.44, 0],
    r: W * 0.55,
    height: W * 0.3,
    proud: W * 0.14,
    boneHint: bone,
    pigment: o.metalPigment ?? 'metal',
    sides: 6,
  });
  g.parts.push(collar);

  const outline: V2[] = [
    [W * 0.9, gripLen * 0.55],
    [W, gripLen * 0.55 + L * 0.2],
    [W * 0.96, gripLen * 0.55 + L * 0.55],
    [W * 0.82, gripLen * 0.55 + L * 0.82],
    [W * 0.03, gripLen * 0.55 + L],
  ];
  const bl = bladeGeometry({
    outline,
    thickness: W * 0.4,
    fuller: 0.44,
    fullerWidth: 0.6,
    edgeBevel: 0.42,
    offset: outline.map((p) => p[0] * 0.4),
    name: 'daoBlade',
  });
  g.parts.push(mkPart(bl, IRON, o.metalPigment ?? 'metal', bone, { name: 'daoBlade', rigid: true }));

  g.points.tip = new THREE.Vector3(W * 0.4, gripLen * 0.55 + L, 0);
  return finish(g, o, bone);
}

// ---------------------------------------------------------------------------
// 鉞 — axe
// ---------------------------------------------------------------------------

export interface AxeOpts extends WeaponBase {
  length: number;
  gripAt?: number;
  headWidth?: number;
  shaftR?: number;
}

/** 鉞 — the crescent axe. Also serves as the mahout's goad when scaled down. */
export function axe(o: AxeOpts): PartGroup {
  const bone = o.bone ?? 'handR';
  const L = o.length;
  const gripAt = o.gripAt ?? 0.42;
  const below = L * gripAt;
  const above = L * (1 - gripAt);
  const r = o.shaftR ?? L * 0.017;
  const hw = o.headWidth ?? L * 0.3;

  const g = mergeGroups(
    haft({ below, above, r, rings: 2, pigment: o.pigment, metalPigment: o.metalPigment, boneHint: bone }),
  );

  // Crescent outline in XY: a concave inner arc and a convex cutting edge.
  const poly: V2[] = [];
  const n = 7;
  for (let i = 0; i <= n; i++) {
    const a = -0.95 + (i / n) * 1.9;
    poly.push([Math.sin(a) * hw * 0.42 - hw * 0.05, Math.cos(a) * hw]);
  }
  for (let i = n; i >= 0; i--) {
    const a = -0.85 + (i / n) * 1.7;
    poly.push([Math.sin(a) * hw * 0.12 - hw * 0.05, Math.cos(a) * hw * 0.52]);
  }
  const head = extrudePlanar(poly, {
    depth: hw * 0.09,
    chamfer: hw * 0.03,
    name: 'axeHead',
  });
  head.applyMatrix4(new THREE.Matrix4().makeRotationZ(-Math.PI / 2));
  head.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  head.translate(0, above - hw * 0.5, -r * 1.2);
  g.parts.push(mkPart(head, IRON, o.metalPigment ?? 'metal', bone, { name: 'axeHead', rigid: true }));

  g.points.tip = new THREE.Vector3(0, above - hw * 0.5, -hw);
  return finish(g, o, bone);
}

// ---------------------------------------------------------------------------
// 節 — the general's staff of authority
// ---------------------------------------------------------------------------

export interface BatonOpts extends WeaponBase {
  length: number;
  gripAt?: number;
  shaftR?: number;
  /** Tiers of ox-tail. The Han 節 carries three. */
  tiers?: number;
}

/**
 * 節 — not a weapon at all but a warrant: a plain staff carrying three tiers of
 * dyed ox-tail. It is the only thing the general holds, and it is deliberately
 * *soft* — three fringed bundles against an otherwise entirely hard figure.
 */
export function baton(o: BatonOpts): PartGroup {
  const bone = o.bone ?? 'handR';
  const L = o.length;
  const gripAt = o.gripAt ?? 0.36;
  const below = L * gripAt;
  const above = L * (1 - gripAt);
  const r = o.shaftR ?? L * 0.019;
  const tiers = o.tiers ?? 3;

  const g = mergeGroups(
    haft({
      below,
      above,
      r,
      rings: 2,
      buttTaper: 1.0,
      headTaper: 0.9,
      pigment: o.pigment,
      metalPigment: o.metalPigment,
      boneHint: bone,
    }),
  );

  for (let i = 0; i < tiers; i++) {
    const y = above - L * 0.06 - i * L * 0.13;
    g.parts.push(
      ...tassel({
        at: [0, y, 0],
        length: L * 0.14,
        r: r * 3.4,
        strands: 9,
        boneHint: bone,
        pigment: o.metalPigment ?? 'accent',
      }).parts,
    );
    g.instanced.push(
      ...tassel({
        at: [0, y, 0],
        length: L * 0.14,
        r: r * 3.4,
        strands: 9,
        boneHint: bone,
        pigment: o.pigment ?? 'accent',
      }).instanced,
    );
  }

  const finial = hardLathe(
    [
      [r * 1.1, above],
      [r * 1.5, above + r * 1.2],
      [r * 0.9, above + r * 2.6],
      [r * 0.1, above + r * 3.2],
    ],
    8,
    { capStart: false, name: 'batonFinial' },
  );
  g.parts.push(
    mkPart(finial, 'gold', o.metalPigment ?? 'metal', bone, { name: 'batonFinial', rigid: true }),
  );

  g.points.tip = new THREE.Vector3(0, above + r * 3.2, 0);
  return finish(g, o, bone);
}

// ---------------------------------------------------------------------------
// 弓 — bow
// ---------------------------------------------------------------------------

export interface BowOpts extends WeaponBase {
  /** Tip-to-tip height when strung. */
  length: number;
  /** Depth of the belly curve. */
  depth?: number;
  strung?: boolean;
}

/**
 * 弓 — a Han composite recurve: the limbs bend back on themselves at the tips
 * (the 弭), which is what separates the outline from a plain arc. The string is
 * a four-sided prism, thin enough to be a line and solid enough to take an
 * outline.
 */
export function bow(o: BowOpts): PartGroup {
  const bone = o.bone ?? 'handL';
  const L = o.length;
  const d = o.depth ?? L * 0.17;
  const g = emptyGroup();

  const stations = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const y = (t - 0.5) * L;
    const u = Math.abs(t - 0.5) * 2;
    // Belly curve out to about 80% of the limb, then a recurve back the other
    // way for the last 20% — the classic siyah.
    const z = u < 0.8 ? -d * (1 - u * u * 0.6) : -d * 0.55 + (u - 0.8) * d * 3.4;
    const r = L * 0.019 * (1 - u * 0.55);
    stations.push({ p: [0, y, z] as V3, rx: r * 0.7, rz: r, squareness: 0.4 });
  }
  g.parts.push(
    mkPart(sweep(stations, { sides: 5, name: 'bowLimb' }), 'timber', o.pigment ?? 'leather', bone, {
      name: 'bowLimb',
      rigid: true,
    }),
  );

  if (o.strung !== false) {
    const a = stations[0].p;
    const b = stations[n - 1].p;
    const string = prism({
      rx0: L * 0.0035,
      y0: 0,
      y1: Math.abs(b[1] - a[1]),
      sides: 4,
      name: 'bowString',
    });
    string.translate(0, a[1], (a[2] + b[2]) / 2);
    g.parts.push(
      mkPart(string, 'hair', 'shellWhite', bone, { name: 'bowString', rigid: true, noSilk: true }),
    );
  }

  // Grip wrap at the centre.
  g.parts.push(
    ferrule({
      at: [0, 0, -d],
      r: L * 0.022,
      height: L * 0.09,
      proud: L * 0.004,
      boneHint: bone,
      pigment: o.metalPigment ?? 'accent',
      sides: 6,
    }),
  );

  g.points.tip = new THREE.Vector3(0, L * 0.5, stations[n - 1].p[2]);
  g.points.nock = new THREE.Vector3(0, 0, -d + L * 0.02);
  return finish(g, o, bone);
}

export interface QuiverOpts extends WeaponBase {
  length: number;
  r: number;
  arrows?: number;
}

/** A quiver of arrows, slung at the back. */
export function quiver(o: QuiverOpts): PartGroup {
  const bone = o.bone ?? 'spine02';
  const g = emptyGroup();
  const body = loft(
    [
      ring({ rx: o.r * 0.9, y: 0, sides: 8, squareness: 0.4 }),
      ring({ rx: o.r, y: o.length * 0.55, sides: 8, squareness: 0.4 }),
      ring({ rx: o.r * 0.92, y: o.length, sides: 8, squareness: 0.4 }),
    ],
    { name: 'quiver' },
  );
  g.parts.push(mkPart(body, 'leather', o.pigment ?? 'leather', bone, { name: 'quiver', rigid: true }));

  const n = o.arrows ?? 5;
  const shaft = prism({ rx0: o.r * 0.07, y0: 0, y1: o.length * 0.42, sides: 4, name: 'arrow' });
  const mats: THREE.Matrix4[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    mats.push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(Math.cos(a) * o.r * 0.5, o.length * 0.9, Math.sin(a) * o.r * 0.5),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12, 'XYZ'),
        ),
        new THREE.Vector3(1, 1, 1),
      ),
    );
  }
  g.instanced.push({
    geometry: shaft,
    cls: 'timber',
    pigment: TIMBER,
    boneHint: bone,
    rigid: true,
    noSilk: true,
    transforms: mats,
    name: 'arrows',
  });
  return finish(g, { ...o, bone }, bone);
}

// ---------------------------------------------------------------------------
// 盾 — shield
// ---------------------------------------------------------------------------

export interface ShieldOpts extends WeaponBase {
  height: number;
  width: number;
  /** Curvature of the face, as a fraction of width. */
  curve?: number;
}

/**
 * 盾 — the Han hexagonal shield: a tall, slightly waisted hexagon with a raised
 * central spine and a boss. Built from a grid shell so it can be dished, then
 * given a rim and a boss.
 */
export function shield(o: ShieldOpts): PartGroup {
  const bone = o.bone ?? 'handL';
  const H = o.height;
  const W = o.width;
  const curve = (o.curve ?? 0.16) * W;
  const g = emptyGroup();

  const rows = 5;
  const cols = 5;
  // Hexagonal plan: full width at the waist, narrowing to points top and bottom.
  const widthAt = (t: number) => {
    const u = Math.abs(t - 0.5) * 2;
    return W * 0.5 * (u < 0.55 ? 1 : 1 - (u - 0.55) / 0.45);
  };
  const grid: V3[][] = [];
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const hw = widthAt(t);
    const row: V3[] = [];
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      const x = (u - 0.5) * 2 * hw;
      const bulge = 1 - Math.pow((u - 0.5) * 2, 2);
      row.push([x, H * (0.5 - t), -curve * bulge]);
    }
    grid.push(row);
  }
  g.parts.push(
    mkPart(shell(grid, W * 0.035, { name: 'shieldFace' }), 'lacquer', o.pigment ?? 'lacquer', bone, {
      name: 'shieldFace',
      rigid: true,
    }),
  );

  // Vertical spine ridge down the centre.
  const spine = bevelSlab({ w: W * 0.11, h: H * 0.92, d: W * 0.05, bevel: W * 0.02 });
  spine.translate(0, 0, -curve - W * 0.03);
  g.parts.push(
    mkPart(spine, 'iron', o.metalPigment ?? 'metal', bone, { name: 'shieldSpine', rigid: true }),
  );

  g.parts.push(
    boss({
      at: [0, 0, -curve - W * 0.05],
      r: W * 0.17,
      height: W * 0.1,
      boneHint: bone,
      pigment: o.metalPigment ?? 'metal',
      rot: [-Math.PI / 2, 0, 0],
      sides: 8,
    }),
  );

  g.points.tip = new THREE.Vector3(0, H * 0.5, 0);
  return finish(g, o, bone);
}

// ---------------------------------------------------------------------------
// Scabbard
// ---------------------------------------------------------------------------

export interface ScabbardOpts extends WeaponBase {
  length: number;
  width: number;
}

/** A scabbard at the hip, with its two suspension bands. */
export function scabbard(o: ScabbardOpts): PartGroup {
  const bone = o.bone ?? 'pelvis';
  const g = emptyGroup();
  const W = o.width;
  const body = loft(
    [
      ring({ rx: W * 0.58, rz: W * 0.3, y: 0, sides: 6, squareness: 0.55 }),
      ring({ rx: W * 0.55, rz: W * 0.29, y: -o.length * 0.6, sides: 6, squareness: 0.55 }),
      ring({ rx: W * 0.42, rz: W * 0.24, y: -o.length * 0.94, sides: 6, squareness: 0.55 }),
      ring({ rx: W * 0.2, rz: W * 0.14, y: -o.length, sides: 6, squareness: 0.55 }),
    ],
    { name: 'scabbard' },
  );
  g.parts.push(
    mkPart(body, 'lacquer', o.pigment ?? 'lacquer', bone, { name: 'scabbard', rigid: true }),
  );
  for (let i = 0; i < 2; i++) {
    g.parts.push(
      ferrule({
        at: [0, -o.length * (0.12 + i * 0.3), 0],
        r: W * 0.56,
        height: W * 0.22,
        proud: W * 0.05,
        boneHint: bone,
        pigment: o.metalPigment ?? 'metal',
        sides: 6,
      }),
    );
  }
  g.points.tip = new THREE.Vector3(0, -o.length, 0);
  return finish(g, o, bone);
}
