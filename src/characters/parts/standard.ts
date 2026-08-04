/**
 * Standards: poles, banners and 旒 streamers.
 *
 * The two armies fly different shapes, and that is a deliberate second read on
 * top of colour. Han flies a stiff square pennant 旌 with a straight lower edge
 * and a fringe of streamers; Chu flies a swallow-tailed pennant 燕尾旗 whose
 * notch is visible from any angle. Colour tells you which army from the front;
 * the notch tells you from behind, in shadow, and in the silhouette pass.
 *
 * Cloth is authored with a fixed wave baked into the surface rather than
 * simulated. The wave phase comes from the caller, so the anim author can build
 * a small set of standards at different phases and cross-fade between them if a
 * banner ever needs to move; nothing here reads a clock.
 */

import * as THREE from 'three';
import type { BoneName } from '@core/contracts.ts';
import { hardLathe, prism, shell } from './prim.ts';
import { ferrule, tassel } from './trim.ts';
import {
  emptyGroup,
  mergeGroups,
  mkPart,
  transformGroup,
  type PartGroup,
  type PartPigment,
  type V3,
} from './types.ts';

export type BannerShape = 'hanSquare' | 'chuSwallowtail';

// ---------------------------------------------------------------------------
// Pole
// ---------------------------------------------------------------------------

export interface FlagpoleOpts {
  /** Butt of the pole, rig space. */
  base: V3;
  /** Overall length. */
  length: number;
  r: number;
  /** Lean from vertical, radians, in the XZ plane given by `leanAxis`. */
  lean?: number;
  leanAxis?: number;
  boneHint?: BoneName;
  mountBone?: string;
  pigment?: PartPigment;
  metalPigment?: PartPigment;
  /** Finial spike on top. */
  finial?: boolean;
  rings?: number;
}

export function flagpole(o: FlagpoleOpts): PartGroup {
  const g = emptyGroup();
  const bone = o.boneHint ?? 'spine02';
  const L = o.length;
  const shaft = prism({
    rx0: o.r * 1.1,
    rx1: o.r * 0.72,
    y0: 0,
    y1: L,
    sides: 6,
    phase: Math.PI / 6,
    squareness: 0.34,
    name: 'flagpole',
  });
  g.parts.push(mkPart(shaft, 'timber', o.pigment ?? 'leather', bone, { name: 'pole', rigid: true }));

  const rings = o.rings ?? 3;
  for (let i = 0; i < rings; i++) {
    g.parts.push(
      ferrule({
        at: [0, (L * (i + 1)) / (rings + 1), 0],
        r: o.r,
        height: o.r * 0.8,
        proud: o.r * 0.2,
        boneHint: bone,
        pigment: o.metalPigment ?? 'metal',
      }),
    );
  }

  if (o.finial !== false) {
    const spike = hardLathe(
      [
        [o.r * 0.8, L],
        [o.r * 1.35, L + o.r * 1.6],
        [o.r * 0.6, L + o.r * 3.4],
        [o.r * 0.06, L + o.r * 5.2],
      ],
      6,
      { capStart: false, name: 'finial' },
    );
    g.parts.push(
      mkPart(spike, 'gold', o.metalPigment ?? 'metal', bone, { name: 'finial', rigid: true }),
    );
    g.points.finial = new THREE.Vector3(0, L + o.r * 5.2, 0);
  }

  g.points.top = new THREE.Vector3(0, L, 0);
  g.points.butt = new THREE.Vector3(0, 0, 0);

  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...o.base),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        Math.cos(o.leanAxis ?? 0) * (o.lean ?? 0),
        0,
        -Math.sin(o.leanAxis ?? 0) * (o.lean ?? 0),
        'XYZ',
      ),
    ),
    new THREE.Vector3(1, 1, 1),
  );
  if (o.mountBone) for (const p of g.parts) p.mountBone = o.mountBone;
  return transformGroup(g, m);
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

export interface BannerOpts {
  shape: BannerShape;
  /** Top of the hoist edge, rig space — normally the pole's `top`. */
  at: V3;
  /** Height of the hoist edge. */
  height: number;
  /** Fly length, away from the pole. */
  width: number;
  /** Direction the fly runs, XZ radians. 0 = +X. */
  fly?: number;
  /** Amplitude of the baked wave, as a fraction of height. */
  wave?: number;
  /** Phase of the baked wave. */
  phase?: number;
  boneHint?: BoneName;
  mountBone?: string;
  pigment?: PartPigment;
  thickness?: number;
}

export function banner(o: BannerOpts): PartGroup {
  const g = emptyGroup();
  const bone = o.boneHint ?? 'spine02';
  const H = o.height;
  const W = o.width;
  const wave = (o.wave ?? 0.1) * H;
  const phase = o.phase ?? 0;
  const rows = 5;
  const cols = 6;

  const grid: V3[][] = [];
  for (let r = 0; r < rows; r++) {
    const v = r / (rows - 1);
    const row: V3[] = [];
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      // Swallowtail: the fly edge is notched to a V; square: it is straight.
      const notch =
        o.shape === 'chuSwallowtail' ? Math.max(0, u - 0.62) * (1 - Math.abs(v - 0.5) * 2) * W * 0.9 : 0;
      const x = u * W - notch;
      // Wave runs along the fly and grows with distance from the hoist, the way
      // a flag actually behaves — pinned at the pole, loose at the tail.
      const y = -v * H + Math.sin(u * 4.2 + phase) * wave * u;
      const z = Math.sin(u * 3.1 + phase + v * 0.8) * wave * u * 1.5;
      row.push([x, y, z]);
    }
    grid.push(row);
  }

  const cloth = shell(grid, (o.thickness ?? 0.01) * H, { name: `banner:${o.shape}` });
  g.parts.push(
    mkPart(cloth, 'cloth', o.pigment ?? 'accent', bone, {
      name: 'banner',
      rigid: true,
      ...(o.mountBone ? { mountBone: o.mountBone } : {}),
    }),
  );

  g.points.fly = new THREE.Vector3(W, -H * 0.5, 0);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...o.at),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, o.fly ?? 0, 0, 'XYZ')),
    new THREE.Vector3(1, 1, 1),
  );
  return transformGroup(g, m);
}

// ---------------------------------------------------------------------------
// 旒 — streamers
// ---------------------------------------------------------------------------

export interface StreamerOpts {
  /** Anchor, rig space. */
  at: V3;
  count: number;
  length: number;
  /** Width of each streamer. */
  width: number;
  /** Spread across X. */
  spread: number;
  /** Baked wave amplitude. */
  wave?: number;
  boneHint?: BoneName;
  mountBone?: string;
  pigment?: PartPigment;
}

/**
 * 旒 — the fringe of narrow streamers hanging below a standard. Each is its own
 * shell with its own wave phase, so the fringe breaks up rather than moving as
 * one plank. Cheap: four rows by two columns each.
 */
export function streamers(o: StreamerOpts): PartGroup {
  const g = emptyGroup();
  const bone = o.boneHint ?? 'spine02';
  for (let i = 0; i < o.count; i++) {
    const u = o.count > 1 ? i / (o.count - 1) - 0.5 : 0;
    const phase = i * 1.7;
    const grid: V3[][] = [];
    for (let r = 0; r < 4; r++) {
      const t = r / 3;
      const y = o.at[1] - o.length * t;
      const drift = Math.sin(t * 3.4 + phase) * (o.wave ?? o.width * 1.2) * t;
      const x = o.at[0] + u * o.spread + drift * 0.4;
      const z = o.at[2] + Math.cos(t * 2.6 + phase) * (o.wave ?? o.width) * t;
      grid.push([
        [x - o.width * 0.5, y, z],
        [x + o.width * 0.5, y, z],
      ]);
    }
    g.parts.push(
      mkPart(shell(grid, o.width * 0.12, { name: 'streamer' }), 'cloth', o.pigment ?? 'accent', bone, {
        name: 'streamer',
        rigid: true,
        noSilk: true,
        ...(o.mountBone ? { mountBone: o.mountBone } : {}),
      }),
    );
  }
  return g;
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

export interface StandardOpts {
  shape: BannerShape;
  base: V3;
  poleLength: number;
  poleR: number;
  bannerHeight: number;
  bannerWidth: number;
  lean?: number;
  fly?: number;
  boneHint?: BoneName;
  mountBone?: string;
  clothPigment?: PartPigment;
  polePigment?: PartPigment;
  metalPigment?: PartPigment;
  streamerCount?: number;
  phase?: number;
}

/**
 * Pole, banner, streamers and a tassel in one call — what a unit author
 * actually wants. Publishes `top` and `fly` so a camera or an IK target can be
 * aimed at the standard.
 */
export function standard(o: StandardOpts): PartGroup {
  const bone = o.boneHint ?? 'spine02';
  const pole = flagpole({
    base: o.base,
    length: o.poleLength,
    r: o.poleR,
    ...(o.lean !== undefined ? { lean: o.lean } : {}),
    boneHint: bone,
    ...(o.mountBone ? { mountBone: o.mountBone } : {}),
    ...(o.polePigment ? { pigment: o.polePigment } : {}),
    ...(o.metalPigment ? { metalPigment: o.metalPigment } : {}),
  });
  const top = pole.points.top;
  const flag = banner({
    shape: o.shape,
    at: [top.x, top.y - o.poleR * 1.5, top.z],
    height: o.bannerHeight,
    width: o.bannerWidth,
    ...(o.fly !== undefined ? { fly: o.fly } : {}),
    ...(o.phase !== undefined ? { phase: o.phase } : {}),
    boneHint: bone,
    ...(o.mountBone ? { mountBone: o.mountBone } : {}),
    ...(o.clothPigment ? { pigment: o.clothPigment } : {}),
  });
  const fringe = streamers({
    at: [top.x, top.y - o.poleR * 1.5 - o.bannerHeight, top.z],
    count: o.streamerCount ?? 5,
    length: o.bannerHeight * 0.7,
    width: o.bannerWidth * 0.05,
    spread: o.bannerWidth * 0.45,
    boneHint: bone,
    ...(o.mountBone ? { mountBone: o.mountBone } : {}),
    ...(o.clothPigment ? { pigment: o.clothPigment } : {}),
  });
  const knot = tassel({
    at: [top.x, top.y - o.poleR * 1.2, top.z],
    length: o.bannerHeight * 0.28,
    r: o.poleR * 2.6,
    strands: 7,
    boneHint: bone,
    ...(o.mountBone ? { mountBone: o.mountBone } : {}),
    ...(o.metalPigment ? { pigment: o.metalPigment } : {}),
  });
  const g = mergeGroups(pole, flag, fringe, knot);
  g.points.top = top;
  return g;
}
