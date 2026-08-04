/**
 * Cloth: robes 袍, skirts 裳, sleeves, sashes 大帶, cloaks, collars 交領.
 *
 * The one rule that makes cloth work in this style: **a fold is a crease, not a
 * curve.** Dunhuang drapery is drawn as a sequence of straight runs meeting at
 * hard angles, and every garment here is built the same way — from *pleated*
 * cross-sections whose vertices sit alternately on an outer and an inner
 * radius. A smooth cylinder with a normal map would read as a bathrobe under a
 * quantised ramp; a sawtooth section reads as silk over a body, because each
 * facet lands in exactly one band of the ramp and the boundary between facets
 * is the line the painter would have drawn.
 *
 * The cost is trivial — a pleated ring is the same triangle count as a smooth
 * one at the same vertex count, and looks like cloth instead of like plumbing.
 */

import type { BoneName } from '@core/contracts.ts';
import { bevelSlab, loft, ring, shell, sweep } from './prim.ts';
import {
  emptyGroup,
  mergeGroups,
  mkPart,
  type Part,
  type PartGroup,
  type PartPigment,
  type V2,
  type V3,
} from './types.ts';

// ---------------------------------------------------------------------------
// Pleated sections
// ---------------------------------------------------------------------------

/**
 * A closed cross-section with `folds` hard pleats: 2·folds points alternating
 * between `rOuter` and `rInner`. Pass it to `sweep` or use `pleatedRing` for the
 * vertical case.
 */
export function pleatSection(
  folds: number,
  rOuter: number,
  rInner: number,
  o: { squash?: number; phase?: number } = {},
): V2[] {
  const n = folds * 2;
  const squash = o.squash ?? 1;
  const phase = o.phase ?? 0;
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const r = i % 2 === 0 ? rOuter : rInner;
    out.push([Math.cos(a) * r, Math.sin(a) * r * squash]);
  }
  return out;
}

/** The same section laid flat at a height, for a vertical loft. */
export function pleatedRing(
  folds: number,
  rOuter: number,
  rInner: number,
  y: number,
  o: { squash?: number; phase?: number; cx?: number; cz?: number } = {},
): V3[] {
  const cx = o.cx ?? 0;
  const cz = o.cz ?? 0;
  return pleatSection(folds, rOuter, rInner, o).map((p) => [cx + p[0], y, cz + p[1]] as V3);
}

// ---------------------------------------------------------------------------
// Skirt and robe
// ---------------------------------------------------------------------------

export interface SkirtOpts {
  /** Waistband height. */
  topY: number;
  /** Hem height. */
  hemY: number;
  /** Half-width at the waist. */
  rTop: number;
  /** Half-width at the hem. */
  rHem: number;
  /** Front-to-back squash; a body is not circular in plan. */
  squash?: number;
  folds?: number;
  /** Pleat depth at the hem as a fraction of radius. Grows from 0 at the waist. */
  foldDepth?: number;
  /** Split the hem so it hangs in two halves around a stride. */
  vents?: number;
  pigment?: PartPigment;
  cls?: Part['cls'];
  bone?: BoneName;
  name?: string;
}

/**
 * 裳 — the skirt or robe body. Pleat depth ramps from nothing at the waistband
 * to full at the hem, which is how gathered cloth actually behaves and what
 * stops the waist reading as a lampshade.
 */
export function skirt(o: SkirtOpts): Part {
  const folds = o.folds ?? 9;
  const depth = o.foldDepth ?? 0.14;
  const squash = o.squash ?? 0.82;
  const rows = 5;
  const rings: V3[][] = [];
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const y = o.topY + (o.hemY - o.topY) * t;
    const r = o.rTop + (o.rHem - o.rTop) * easeOutish(t);
    const d = depth * t * t; // pleats open quadratically toward the hem
    // Alternate the pleat phase slightly down the skirt so the creases are not
    // perfectly vertical prisms — cloth spirals a little as it falls.
    rings.push(pleatedRing(folds, r, r * (1 - d), y, { squash, phase: t * 0.12 }));
  }
  const g = loft(rings, { capStart: false, capEnd: true, name: o.name ?? 'skirt' });
  return mkPart(g, o.cls ?? 'cloth', o.pigment ?? 'cloth', o.bone ?? 'pelvis', {
    name: o.name ?? 'skirt',
    allow: ['thighL', 'thighR', 'spine01'],
  });
}

function easeOutish(t: number): number {
  return 1 - (1 - t) * (1 - t) * 0.55 - (1 - t) * 0.45;
}

export interface RobeOpts {
  /** Shoulder height — the robe starts at the collar. */
  shoulderY: number;
  waistY: number;
  hemY: number;
  shoulderR: number;
  waistR: number;
  hemR: number;
  squash?: number;
  folds?: number;
  pigment?: PartPigment;
  name?: string;
}

/**
 * 袍 — a full-length robe as one garment from collar to hem, worn instead of a
 * tunic. Two skinning zones: the bodice follows `spine01`, the skirt follows
 * `pelvis` and both thighs, so the hem swings with a stride.
 */
export function robe(o: RobeOpts): PartGroup {
  const folds = o.folds ?? 10;
  const squash = o.squash ?? 0.8;
  const g = emptyGroup();

  const bodice = loft(
    [
      pleatedRing(folds, o.shoulderR, o.shoulderR * 0.97, o.shoulderY, { squash }),
      pleatedRing(folds, o.shoulderR * 0.95, o.shoulderR * 0.9, (o.shoulderY + o.waistY) / 2, {
        squash,
      }),
      pleatedRing(folds, o.waistR, o.waistR * 0.94, o.waistY, { squash }),
    ],
    { capStart: true, capEnd: false, name: 'robeBodice' },
  );
  g.parts.push(
    mkPart(bodice, 'cloth', o.pigment ?? 'cloth', 'spine01', {
      name: 'robeBodice',
      allow: ['spine02', 'pelvis'],
    }),
  );

  g.parts.push(
    skirt({
      topY: o.waistY,
      hemY: o.hemY,
      rTop: o.waistR,
      rHem: o.hemR,
      squash,
      folds,
      foldDepth: 0.18,
      pigment: o.pigment,
      name: 'robeSkirt',
    }),
  );
  return g;
}

// ---------------------------------------------------------------------------
// Sleeves
// ---------------------------------------------------------------------------

export interface SleeveOpts {
  side: 'L' | 'R';
  shoulder: V3;
  elbow: V3;
  wrist: V3;
  /** Radius at the shoulder. */
  r0: number;
  /** Radius at the cuff. A court sleeve flares to two or three times this. */
  r1: number;
  folds?: number;
  /** How far down the arm the sleeve reaches, 0..1. */
  length?: number;
  pigment?: PartPigment;
}

/**
 * A pleated sleeve swept along the arm. The wide flaring cuff of a court robe
 * is the advisor's single strongest silhouette cue after his cap, so `r1` is
 * deliberately unbounded — a value of three or four times `r0` is correct for
 * the 仕/士 and looks absurd on anyone else.
 */
export function sleeve(o: SleeveOpts): Part {
  const folds = o.folds ?? 7;
  const len = o.length ?? 1;
  const lerp = (a: V3, b: V3, t: number): V3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  const end = len <= 0.5 ? lerp(o.shoulder, o.elbow, len * 2) : lerp(o.elbow, o.wrist, (len - 0.5) * 2);
  const mid = lerp(o.shoulder, end, 0.55);

  const sec = (r: number, d: number) => pleatSection(folds, r, r * (1 - d), { squash: 0.94 });
  const g = sweep(
    [
      { p: o.shoulder, rx: o.r0, section: sec(o.r0 * 1.05, 0.04) },
      { p: mid, rx: o.r0, section: sec(o.r0 * 0.98, 0.1) },
      { p: end, rx: o.r1, section: sec(o.r1, 0.16) },
    ],
    { sides: folds * 2, capStart: false, capEnd: true, name: `sleeve${o.side}` },
  );
  const bone = (len <= 0.5 ? `upperArm${o.side}` : `foreArm${o.side}`) as BoneName;
  return mkPart(g, 'cloth', o.pigment ?? 'cloth', bone, {
    name: `sleeve${o.side}`,
    allow: [`clavicle${o.side}` as BoneName, `upperArm${o.side}` as BoneName],
  });
}

// ---------------------------------------------------------------------------
// Sash and collar
// ---------------------------------------------------------------------------

export interface SashOpts {
  y: number;
  rx: number;
  rz: number;
  height: number;
  /** Length of the two hanging tails. 0 for a plain belt. */
  tail?: number;
  pigment?: PartPigment;
  bone?: BoneName;
  /** Knot on the front. */
  knot?: boolean;
}

/**
 * 大帶 — the waist sash. A flat band with a knot and two hanging tails. Cheap,
 * and it does more for a plain tunic than any amount of extra armour: it cuts
 * the torso into two values at exactly the height the eye wants a break.
 */
export function sash(o: SashOpts): PartGroup {
  const g = emptyGroup();
  const bone = o.bone ?? 'pelvis';
  const pig = o.pigment ?? 'accent';
  const band = loft(
    [
      ring({ rx: o.rx * 1.03, rz: o.rz * 1.03, y: o.y - o.height / 2, sides: 12, squareness: 0.45 }),
      ring({ rx: o.rx * 1.06, rz: o.rz * 1.06, y: o.y, sides: 12, squareness: 0.45 }),
      ring({ rx: o.rx * 1.03, rz: o.rz * 1.03, y: o.y + o.height / 2, sides: 12, squareness: 0.45 }),
    ],
    { capStart: false, capEnd: false, name: 'sash' },
  );
  g.parts.push(mkPart(band, 'cloth', pig, bone, { name: 'sash', allow: ['spine01'] }));

  if (o.knot !== false) {
    const knot = bevelSlab({
      w: o.rx * 0.5,
      h: o.height * 1.5,
      d: o.rz * 0.24,
      bevel: o.height * 0.22,
    });
    knot.translate(0, o.y, -o.rz * 1.06);
    g.parts.push(mkPart(knot, 'cloth', pig, bone, { name: 'sashKnot', rigid: true }));
  }

  const tail = o.tail ?? 0;
  if (tail > 0.001) {
    for (const s of [-1, 1]) {
      const t = loft(
        [
          [
            [s * o.rx * 0.22 - o.rx * 0.09 * s, o.y, -o.rz * 1.02],
            [s * o.rx * 0.22 + o.rx * 0.09 * s, o.y, -o.rz * 1.02],
            [s * o.rx * 0.22 + o.rx * 0.09 * s, o.y, -o.rz * 1.02 + o.rz * 0.1],
            [s * o.rx * 0.22 - o.rx * 0.09 * s, o.y, -o.rz * 1.02 + o.rz * 0.1],
          ] as V3[],
          [
            [s * o.rx * 0.3 - o.rx * 0.1 * s, o.y - tail * 0.55, -o.rz * 1.06],
            [s * o.rx * 0.3 + o.rx * 0.1 * s, o.y - tail * 0.55, -o.rz * 1.06],
            [s * o.rx * 0.3 + o.rx * 0.1 * s, o.y - tail * 0.55, -o.rz * 1.06 + o.rz * 0.09],
            [s * o.rx * 0.3 - o.rx * 0.1 * s, o.y - tail * 0.55, -o.rz * 1.06 + o.rz * 0.09],
          ] as V3[],
          [
            [s * o.rx * 0.24 - o.rx * 0.07 * s, o.y - tail, -o.rz * 0.98],
            [s * o.rx * 0.24 + o.rx * 0.07 * s, o.y - tail, -o.rz * 0.98],
            [s * o.rx * 0.24 + o.rx * 0.07 * s, o.y - tail, -o.rz * 0.98 + o.rz * 0.07],
            [s * o.rx * 0.24 - o.rx * 0.07 * s, o.y - tail, -o.rz * 0.98 + o.rz * 0.07],
          ] as V3[],
        ],
        { name: 'sashTail' },
      );
      g.parts.push(mkPart(t, 'cloth', pig, bone, { name: 'sashTail', allow: ['thighL', 'thighR'] }));
    }
  }
  return g;
}

export interface CollarOpts {
  shoulderY: number;
  chestY: number;
  rx: number;
  rz: number;
  pigment?: PartPigment;
  /** Width of the collar band. */
  width?: number;
}

/**
 * 交領 — the crossed collar of a Han robe: two bands running from the shoulders
 * down to the centre of the chest, one lapping over the other. It is a two-quad
 * detail that instantly dates the costume, and it survives at silhouette size as
 * a V notch at the neck.
 */
export function collar(o: CollarOpts): PartGroup {
  const g = emptyGroup();
  const w = o.width ?? o.rx * 0.3;
  const drop = o.shoulderY - o.chestY;
  for (const s of [-1, 1]) {
    const grid: V3[][] = [];
    for (let r = 0; r < 3; r++) {
      const t = r / 2;
      const row: V3[] = [];
      for (let c = 0; c < 3; c++) {
        const u = c / 2;
        // Runs from the shoulder inward and down to the sternum.
        const x = s * o.rx * (0.78 - t * 0.72) + s * u * w;
        const y = o.shoulderY + o.rx * 0.1 - t * drop * 1.1 - u * w * 0.55;
        const z = -o.rz * (0.86 + Math.abs(x / o.rx) * 0.06);
        row.push([x, y, z]);
      }
      grid.push(row);
    }
    g.parts.push(
      mkPart(shell(grid, o.rx * 0.045, { name: 'collar', flip: s < 0 }), 'cloth', o.pigment ?? 'accent', 'spine02', {
        name: 'collar',
        allow: ['spine01', 'neck'],
      }),
    );
  }
  return g;
}

// ---------------------------------------------------------------------------
// Cloak
// ---------------------------------------------------------------------------

export interface CloakOpts {
  /** Height of the shoulder line the cloak hangs from. */
  shoulderY: number;
  hemY: number;
  /** Half-width at the shoulders. */
  rTop: number;
  /** Half-width at the hem. */
  rHem: number;
  /** Distance behind the figure the cloak surface sits. */
  z: number;
  /** Number of authored fold planes across the width. Odd numbers read best. */
  folds?: number;
  /** Depth of each fold. */
  foldDepth?: number;
  /** Backward sweep of the hem, as a fraction of the drop. */
  flare?: number;
  pigment?: PartPigment;
  thickness?: number;
}

/**
 * A cloak, built from explicitly authored fold planes rather than a smooth
 * sheet. The `folds` alternate toward and away from the body, deepening as they
 * fall, and the hem is scalloped so the bottom edge is a broken line — a
 * straight hem reads as a curtain, and a curtain is the single fastest way to
 * make an armoured figure look like a lamp.
 *
 * Only the general wears one, and it is most of what makes his silhouette wider
 * than everyone else's without making him fat.
 */
export function cloak(o: CloakOpts): Part {
  const folds = o.folds ?? 7;
  const depth = o.foldDepth ?? 0.22;
  const flare = o.flare ?? 0.34;
  const rows = 5;
  const cols = folds * 2 + 1;
  const drop = o.shoulderY - o.hemY;

  const grid: V3[][] = [];
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const row: V3[] = [];
    const rr = o.rTop + (o.rHem - o.rTop) * t;
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      // The cloak wraps forward at the edges: the shoulder line is an arc, not
      // a flat plane, so the cloak reads as enclosing the figure.
      const a = (u - 0.5) * Math.PI * 0.94;
      const foldPhase = c % 2 === 0 ? 1 : -1;
      const fd = foldPhase * depth * rr * t;
      const x = Math.sin(a) * rr;
      const z = o.z + Math.cos(a) * rr * 0.42 + fd + t * t * drop * flare;
      // Scalloped hem: the deep folds hang lower than the shallow ones.
      const hemBias = c % 2 === 0 ? 0 : drop * 0.07;
      const y = o.shoulderY - drop * t - hemBias * t;
      row.push([x, y, z]);
    }
    grid.push(row);
  }

  const g = shell(grid, o.thickness ?? Math.abs(o.rTop) * 0.03, { name: 'cloak' });
  return mkPart(g, 'cloth', o.pigment ?? 'cloth', 'spine02', {
    name: 'cloak',
    allow: ['spine01', 'pelvis', 'clavicleL', 'clavicleR'],
  });
}

// ---------------------------------------------------------------------------
// Leg wraps
// ---------------------------------------------------------------------------

export interface LegWrapOpts {
  side: 'L' | 'R';
  knee: V3;
  ankle: V3;
  r: number;
  /** Number of visible windings. */
  turns?: number;
  pigment?: PartPigment;
}

/**
 * 行縢 — the puttee wound around the shin. Built as a stack of slightly offset
 * rings so each winding steps over the last; that stepping is the detail that
 * makes a marching conscript's legs read as wrapped rather than painted.
 */
export function legWrap(o: LegWrapOpts): Part {
  const turns = o.turns ?? 4;
  const stations = [];
  for (let i = 0; i <= turns * 2; i++) {
    const t = i / (turns * 2);
    const step = i % 2 === 0 ? 1.0 : 1.09;
    stations.push({
      p: [
        o.knee[0] + (o.ankle[0] - o.knee[0]) * t,
        o.knee[1] + (o.ankle[1] - o.knee[1]) * t,
        o.knee[2] + (o.ankle[2] - o.knee[2]) * t,
      ] as V3,
      rx: o.r * (1.12 - t * 0.34) * step,
      rz: o.r * (1.08 - t * 0.32) * step,
      squareness: 0.3,
    });
  }
  const g = sweep(stations, { sides: 6, name: `legWrap${o.side}` });
  return mkPart(g, 'cloth', o.pigment ?? 'leather', `shin${o.side}` as BoneName, {
    name: `legWrap${o.side}`,
  });
}

// ---------------------------------------------------------------------------
// Hood
// ---------------------------------------------------------------------------

export interface ShoulderCapeOpts {
  shoulderY: number;
  r: number;
  drop: number;
  folds?: number;
  pigment?: PartPigment;
}

/** A short cape over the shoulders — the artillerist's weather layer. */
export function shoulderCape(o: ShoulderCapeOpts): Part {
  const folds = o.folds ?? 8;
  const g = loft(
    [
      pleatedRing(folds, o.r * 0.62, o.r * 0.6, o.shoulderY + o.drop * 0.18, { squash: 0.9 }),
      pleatedRing(folds, o.r * 1.0, o.r * 0.92, o.shoulderY - o.drop * 0.3, { squash: 0.9 }),
      pleatedRing(folds, o.r * 1.16, o.r * 1.0, o.shoulderY - o.drop, { squash: 0.9 }),
    ],
    { capStart: false, capEnd: true, name: 'cape' },
  );
  return mkPart(g, 'cloth', o.pigment ?? 'cloth', 'spine02', {
    name: 'cape',
    allow: ['spine01', 'clavicleL', 'clavicleR', 'neck'],
  });
}

// ---------------------------------------------------------------------------
// Composite helper
// ---------------------------------------------------------------------------

/** Two sleeves at once. */
export function sleeves(
  base: Omit<SleeveOpts, 'side' | 'shoulder' | 'elbow' | 'wrist'>,
  left: { shoulder: V3; elbow: V3; wrist: V3 },
  right: { shoulder: V3; elbow: V3; wrist: V3 },
): PartGroup {
  return mergeGroups(
    sleeve({ ...base, side: 'L', ...left }),
    sleeve({ ...base, side: 'R', ...right }),
  );
}
