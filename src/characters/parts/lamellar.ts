/**
 * 札甲 — the lamellar armour system.
 *
 * Han and Chu armour is not a moulded breastplate; it is several hundred small
 * lacquered plates laced into overlapping rows. That construction is the whole
 * reason the units read as *made* rather than sculpted: every plate edge is a
 * highlight, every row overlap is a shadow line, and the rows curve differently
 * over a chest, a shoulder and a thigh.
 *
 * It is also, by a wide margin, the largest triangle sink in the project, so
 * every function here returns its plates as an `InstancedPart`: one twelve-
 * triangle geometry plus a transform per plate. A general's full harness is
 * roughly 290 plates — 3 500 triangles and *four* draw calls, against 290 draw
 * calls if they were separate meshes.
 *
 * Instanced geometry cannot be skinned, so each band binds rigidly to one bone.
 * That is not a compromise: a lacquered iron plate is rigid, and letting the
 * bands articulate at the bone joints is exactly how the real armour moves.
 * Choose row boundaries at anatomical joints and the armour flexes correctly.
 */

import * as THREE from 'three';
import type { BoneName } from '@core/contracts.ts';
import { bevelSlab } from './prim.ts';
import {
  emptyGroup,
  type InstancedPart,
  type Part,
  type PartGroup,
  type PartPigment,
} from './types.ts';

// ---------------------------------------------------------------------------
// The plate
// ---------------------------------------------------------------------------

export interface PlateOpts {
  w: number;
  h: number;
  /** Thickness. Lacquered iron is thin; 6–9% of plate width reads right. */
  d: number;
  /** Chamfer on the outer face. This is where the highlight band lives. */
  bevel?: number;
  /** Extra forward push at the plate centre — a slight dome. */
  crown?: number;
  /** Emit the inner face. Off costs a hole in the outline hull; keep it on. */
  backFace?: boolean;
}

/**
 * One lamella. Twelve triangles: a chamfered outer face, four bevel walls, an
 * inner face. Authored in the XY plane with the outer face toward +Z, centred
 * on the origin, so a transform that points +Z outward from the body is all a
 * band needs.
 */
export function lamellarPlate(o: PlateOpts): THREE.BufferGeometry {
  return bevelSlab({
    w: o.w,
    h: o.h,
    d: o.d,
    bevel: o.bevel ?? Math.min(o.w, o.h) * 0.16,
    crown: o.crown ?? 0,
    backFace: o.backFace !== false,
    name: 'lamella',
  });
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface LamellarRow {
  /** Height of the row's centre, rig space. */
  y: number;
  /** Radius across X of the body surface this row wraps. */
  rx: number;
  /** Radius across Z. Defaults to `rx`. */
  rz?: number;
  cx?: number;
  cz?: number;
  /** Plates in this row. */
  count: number;
  /** Angular span. Default 2π — a closed ring. */
  arc?: number;
  /** Centre of the arc, radians about +Y from +X. Default -π/2, i.e. the front. */
  arcCentre?: number;
  /** Lean of the plates from vertical; positive tips the top outward. */
  tilt?: number;
  /** Multiplier on plate width and height for this row. */
  scale?: number;
  /** Bone this row binds to. Rows sharing a bone share one InstancedMesh. */
  bone?: BoneName;
}

export interface BandOpts {
  rows: LamellarRow[];
  plate: PlateOpts;
  /** Fallback bone for rows that do not name one. */
  boneHint: BoneName;
  pigment?: PartPigment;
  cls?: Part['cls'];
  /** Lay a lacing cord along the top edge of every row. */
  cord?: boolean;
  cordPigment?: PartPigment;
  /** Cord thickness as a fraction of plate height. */
  cordScale?: number;
  name?: string;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

/**
 * Array plates around a stack of elliptical rows. This is the primitive every
 * other function in the file is built from, and it is exported so a unit author
 * can lace plates onto a surface it never occurred to us to provide — a horse's
 * barding, a howdah's flank, a shield face.
 */
export function lamellarBand(o: BandOpts): PartGroup {
  const g = emptyGroup();
  const cls = o.cls ?? 'lacquer';
  const pigment = o.pigment ?? 'lacquer';
  const base = lamellarPlate(o.plate);

  // One InstancedMesh per bone, not per row: a five-row cuirass on one bone is
  // one draw call.
  const byBone = new Map<BoneName, THREE.Matrix4[]>();
  const cordByBone = new Map<BoneName, THREE.Matrix4[]>();

  for (const row of o.rows) {
    const bone = row.bone ?? o.boneHint;
    const rz = row.rz ?? row.rx;
    const arc = row.arc ?? Math.PI * 2;
    const closed = arc >= Math.PI * 2 - 1e-6;
    const centre = row.arcCentre ?? -Math.PI / 2;
    const tilt = row.tilt ?? 0;
    const sc = row.scale ?? 1;
    const cx = row.cx ?? 0;
    const cz = row.cz ?? 0;

    let list = byBone.get(bone);
    if (!list) byBone.set(bone, (list = []));
    let cords = cordByBone.get(bone);
    if (o.cord && !cords) cordByBone.set(bone, (cords = []));

    for (let i = 0; i < row.count; i++) {
      // Closed rings step by arc/count; an open arc puts a plate at each end.
      const f = closed ? (i + 0.5) / row.count : row.count > 1 ? i / (row.count - 1) : 0.5;
      const th = centre - arc / 2 + f * arc;
      const ct = Math.cos(th);
      const st = Math.sin(th);
      _p.set(cx + row.rx * ct, row.y, cz + rz * st);
      // Local +Z must point out along the surface normal. For an ellipse the
      // true normal is (rz·cosθ, 0, rx·sinθ) normalised; using it rather than
      // the radial direction keeps plates flush on a flattened chest.
      const nx = rz * ct;
      const nz = row.rx * st;
      const yaw = Math.atan2(nx, nz);
      _e.set(tilt, yaw, 0);
      _q.setFromEuler(_e);
      _s.set(sc, sc, 1);
      list.push(new THREE.Matrix4().compose(_p, _q, _s));

      if (cords) {
        const ch = o.plate.h * sc * (o.cordScale ?? 0.16);
        _p.set(
          cx + row.rx * ct * 1.006,
          row.y + (o.plate.h * sc) / 2 - ch * 0.4,
          cz + rz * st * 1.006,
        );
        _e.set(tilt, yaw, 0);
        _q.setFromEuler(_e);
        _s.set(sc, 1, 1);
        cords.push(new THREE.Matrix4().compose(_p, _q, _s));
      }
    }
  }

  // Every band on the same bone shares one geometry across its InstancedMeshes;
  // three is happy with that and the factory de-duplicates on dispose.
  for (const [bone, mats] of byBone) {
    if (mats.length === 0) continue;
    const part: InstancedPart = {
      geometry: base,
      cls,
      pigment,
      boneHint: bone,
      rigid: true,
      transforms: mats,
      name: `${o.name ?? 'lamellar'}:${bone}`,
    };
    g.instanced.push(part);
  }

  if (o.cord) {
    const cordGeo = bevelSlab({
      w: o.plate.w * 0.92,
      h: o.plate.h * (o.cordScale ?? 0.16),
      d: o.plate.d * 0.9,
      bevel: o.plate.d * 0.35,
      backFace: false,
      name: 'lacing',
    });
    for (const [bone, mats] of cordByBone) {
      if (mats.length === 0) continue;
      g.instanced.push({
        geometry: cordGeo,
        cls: 'leather',
        pigment: o.cordPigment ?? 'accent',
        boneHint: bone,
        rigid: true,
        noSilk: true,
        transforms: mats,
        name: `${o.name ?? 'lamellar'}:cord:${bone}`,
      });
    }
  }

  return g;
}

// ---------------------------------------------------------------------------
// Named armour pieces
// ---------------------------------------------------------------------------

export interface CuirassOpts {
  /** Bottom of the plate stack (usually just below the waist). */
  fromY: number;
  /** Top of the plate stack (the collarbone line). */
  toY: number;
  /** Half-width at the bottom. */
  rx0: number;
  /** Half-width at the top. */
  rx1: number;
  /** Depth ratio: rz = rx * depthRatio. A chest is flatter than it is wide. */
  depthRatio?: number;
  /** Rows of plates. Four is a light harness, seven a general's. */
  rows?: number;
  /** Plates per row at the widest row; narrower rows scale down proportionally. */
  perRow?: number;
  /** Bone for rows in the lower half. */
  lowerBone?: BoneName;
  /** Bone for rows in the upper half. */
  upperBone?: BoneName;
  cord?: boolean;
  pigment?: PartPigment;
  /** Plate thickness as a fraction of plate width. */
  thickness?: number;
}

/**
 * The body armour. Rows are split between two spine bones at the ribcage, so
 * the harness creases where a torso creases instead of moving as one shell.
 */
export function cuirass(o: CuirassOpts): PartGroup {
  const rows = o.rows ?? 5;
  const perRow = o.perRow ?? 14;
  const depth = o.depthRatio ?? 0.72;
  const h = (o.toY - o.fromY) / rows;
  const plateH = h * 1.34; // rows overlap by a third, as laced armour does
  const circ = Math.PI * (o.rx0 + o.rx1) * 0.5 * (1 + depth);
  const plateW = (circ / perRow) * 1.12;

  const list: LamellarRow[] = [];
  for (let i = 0; i < rows; i++) {
    const t = (i + 0.5) / rows;
    const rxi = o.rx0 + (o.rx1 - o.rx0) * t;
    // Plate count follows circumference so plate *width* stays constant up the
    // body — a row of wider plates at the chest would read as a different armour.
    const c = Math.max(6, Math.round((perRow * rxi) / Math.max(o.rx0, o.rx1)));
    list.push({
      y: o.fromY + h * (i + 0.5),
      rx: rxi,
      rz: rxi * depth,
      count: c,
      tilt: -0.08,
      bone: t < 0.5 ? (o.lowerBone ?? 'spine01') : (o.upperBone ?? 'spine02'),
    });
  }

  return lamellarBand({
    rows: list,
    plate: {
      w: plateW,
      h: plateH,
      d: plateW * (o.thickness ?? 0.1),
      bevel: Math.min(plateW, plateH) * 0.17,
      crown: plateW * 0.03,
    },
    boneHint: o.upperBone ?? 'spine02',
    pigment: o.pigment ?? 'lacquer',
    cord: o.cord ?? true,
    name: 'cuirass',
  });
}

export interface SkirtArmourOpts {
  /** Top of the skirt (the belt line). */
  topY: number;
  /** Bottom of the skirt. */
  bottomY: number;
  rxTop: number;
  rxBottom: number;
  depthRatio?: number;
  rows?: number;
  perRow?: number;
  /** Leave the front open so the legs can stride through. */
  frontGap?: number;
  pigment?: PartPigment;
  bone?: BoneName;
  cord?: boolean;
}

/**
 * 甲裳 — the armoured skirt. Flares outward, and the front is left open by
 * `frontGap` radians so a striding leg does not shear through it. That gap is
 * also what turns the lower silhouette from a bell into a pair of vertical
 * strokes, which is worth as much as the range of motion.
 */
export function skirtArmour(o: SkirtArmourOpts): PartGroup {
  const rows = o.rows ?? 3;
  const perRow = o.perRow ?? 18;
  const depth = o.depthRatio ?? 0.8;
  const h = (o.topY - o.bottomY) / rows;
  const gap = o.frontGap ?? 0.5;
  const arc = Math.PI * 2 - gap;
  const circ = Math.PI * (o.rxTop + o.rxBottom) * 0.5 * (1 + depth);
  const plateW = ((circ * (arc / (Math.PI * 2))) / perRow) * 1.1;

  const list: LamellarRow[] = [];
  for (let i = 0; i < rows; i++) {
    const t = (i + 0.5) / rows;
    const rxi = o.rxTop + (o.rxBottom - o.rxTop) * t;
    list.push({
      y: o.topY - h * (i + 0.5),
      rx: rxi,
      rz: rxi * depth,
      count: perRow,
      arc,
      arcCentre: Math.PI / 2, // gap centred on the front (-Z is forward)
      tilt: 0.1 + t * 0.14, // the skirt flares as it falls
      bone: o.bone ?? 'pelvis',
    });
  }

  return lamellarBand({
    rows: list,
    plate: {
      w: plateW,
      h: h * 1.3,
      d: plateW * 0.1,
      bevel: Math.min(plateW, h) * 0.16,
    },
    boneHint: o.bone ?? 'pelvis',
    pigment: o.pigment ?? 'lacquer',
    cord: o.cord ?? true,
    name: 'skirtArmour',
  });
}

export interface PauldronOpts {
  side: 'L' | 'R';
  /** Shoulder joint, rig space. */
  shoulder: [number, number, number];
  /** Radius of the shoulder cap. */
  r: number;
  rows?: number;
  perRow?: number;
  pigment?: PartPigment;
}

/**
 * 披膊 — the shoulder cap. Arcs over the outside of the deltoid only; a full
 * ring would collide with the cuirass. Bound to the clavicle rather than the
 * upper arm so the plate stays put when the arm swings, which is what a real
 * pauldron does and what the skinner's hint gate exists to guarantee.
 */
export function pauldron(o: PauldronOpts): PartGroup {
  const rows = o.rows ?? 3;
  const perRow = o.perRow ?? 5;
  const dir = o.side === 'L' ? -1 : 1;
  const list: LamellarRow[] = [];
  for (let i = 0; i < rows; i++) {
    const t = i / Math.max(1, rows - 1);
    list.push({
      y: o.shoulder[1] + o.r * (0.42 - t * 1.5),
      rx: o.r * (0.72 + t * 0.34),
      rz: o.r * (0.7 + t * 0.3),
      cx: o.shoulder[0],
      cz: o.shoulder[2],
      count: perRow,
      arc: 2.5 - t * 0.5,
      // Face outward and slightly forward, hugging the outside of the arm.
      arcCentre: dir > 0 ? 0.1 : Math.PI - 0.1,
      tilt: -0.18 - t * 0.12,
      scale: 1 - t * 0.12,
      bone: `clavicle${o.side}` as BoneName,
    });
  }
  const plateW = (o.r * 2.2) / perRow;
  return lamellarBand({
    rows: list,
    plate: {
      w: plateW,
      h: o.r * 0.62,
      d: plateW * 0.12,
      bevel: plateW * 0.16,
    },
    boneHint: `clavicle${o.side}` as BoneName,
    pigment: o.pigment ?? 'lacquer',
    cord: false,
    name: `pauldron${o.side}`,
  });
}

export interface TubeArmourOpts {
  /** Bone the band binds to. */
  bone: BoneName;
  /** Axis start and end, rig space. */
  from: [number, number, number];
  to: [number, number, number];
  r: number;
  rows?: number;
  perRow?: number;
  pigment?: PartPigment;
  /** Leave a gap on the inner face so the band does not clip the body. */
  arc?: number;
  /** Direction the arc faces: +1 outward in +X, -1 outward in -X. */
  facing?: number;
}

/**
 * 臂鞲 / 脛甲 — bracers and greaves. A short stack of rows wrapped around a
 * limb segment. `from`/`to` may be at any angle; the band is built along +Y and
 * rotated onto the segment, so it follows a pre-broken elbow correctly.
 */
export function tubeArmour(o: TubeArmourOpts): PartGroup {
  const rows = o.rows ?? 2;
  const perRow = o.perRow ?? 8;
  const arc = o.arc ?? Math.PI * 1.5;
  const facing = o.facing ?? 1;
  const dx = o.to[0] - o.from[0];
  const dy = o.to[1] - o.from[1];
  const dz = o.to[2] - o.from[2];
  const len = Math.hypot(dx, dy, dz);

  const list: LamellarRow[] = [];
  for (let i = 0; i < rows; i++) {
    list.push({
      y: (len * (i + 0.5)) / rows,
      rx: o.r,
      rz: o.r,
      count: perRow,
      arc,
      arcCentre: facing > 0 ? 0 : Math.PI,
      tilt: -0.06,
      bone: o.bone,
    });
  }
  const plateW = ((o.r * arc) / perRow) * 1.12;
  const grp = lamellarBand({
    rows: list,
    plate: { w: plateW, h: (len / rows) * 1.22, d: plateW * 0.12, bevel: plateW * 0.16 },
    boneHint: o.bone,
    pigment: o.pigment ?? 'lacquer',
    cord: false,
    name: `tubeArmour:${o.bone}`,
  });

  // Rotate the +Y-built band onto the limb axis.
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len),
  );
  const m = new THREE.Matrix4()
    .makeTranslation(o.from[0], o.from[1], o.from[2])
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q));
  for (const inst of grp.instanced) {
    for (const t of inst.transforms) t.premultiply(m);
  }
  return grp;
}

export interface NeckGuardOpts {
  /** Base of the collar. */
  y: number;
  r: number;
  height: number;
  count?: number;
  pigment?: PartPigment;
}

/**
 * 盆領 — the standing plate collar. One row, tipped outward, on the neck bone.
 * Small, but it is the thing that stops an armoured figure's head reading as a
 * ball balanced on a box.
 */
export function neckGuard(o: NeckGuardOpts): PartGroup {
  const count = o.count ?? 12;
  const plateW = ((Math.PI * 2 * o.r) / count) * 1.12;
  return lamellarBand({
    rows: [
      {
        y: o.y + o.height * 0.5,
        rx: o.r,
        rz: o.r * 0.95,
        count,
        tilt: 0.34,
        bone: 'neck',
      },
    ],
    plate: { w: plateW, h: o.height * 1.1, d: plateW * 0.14, bevel: plateW * 0.18 },
    boneHint: 'neck',
    pigment: o.pigment ?? 'lacquer',
    cord: false,
    name: 'neckGuard',
  });
}

/**
 * How many triangles a band will cost, so a unit author can budget before
 * building. Twelve triangles per plate, plus ten per cord segment.
 */
export function bandCost(g: PartGroup): number {
  let n = 0;
  for (const inst of g.instanced) {
    const pos = inst.geometry.getAttribute('position');
    n += (pos.count / 3) * inst.transforms.length;
  }
  return n;
}
