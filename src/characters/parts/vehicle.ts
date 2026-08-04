/**
 * Vehicles: the war chariot 車 and the traction trebuchet 砲.
 *
 * WHEELS AND THE GROUND. The chariot publishes each wheel as a mount bone with
 * its `radius` recorded in `BoneSpec.data`. That number is contractual: the
 * animator matches wheel rotation to ground travel with
 *
 *     Δθ = Δs / radius
 *
 * and gets it exactly right, rather than by eye. A chariot whose wheels skid is
 * the first thing the motion critic names, and the only way to avoid it is for
 * the geometry to publish its own radius instead of the animator guessing. The
 * radius published is in **rig units**, before the unit's root scale; ground
 * travel measured in world units must be divided by that scale first, or the
 * `UnitInstance.meta.proportions.scale` factor cancelled on both sides.
 *
 * The 砲 is a traction trebuchet, not a cannon: a timber A-frame on a sled, a
 * beam pivoting on the apex, a sling on the long arm and a counterweight box on
 * the short one. Its pivot and beam are mount bones too, so the throw is
 * animated rather than faked.
 */

import * as THREE from 'three';
import { bevelSlab, hardLathe, loft, place, prism, ring, shell, strut, sweep } from './prim.ts';
import { rivetArc } from './rivets.ts';
import { boss, ferrule, piping, tassel } from './trim.ts';
import {
  emptyGroup,
  mkPart,
  type PartGroup,
  type PartPigment,
  type V3,
} from './types.ts';

const TIMBER = 'ochre' as const;

// ---------------------------------------------------------------------------
// Wheel
// ---------------------------------------------------------------------------

export interface WheelOpts {
  /** Hub centre, rig space. */
  at: V3;
  radius: number;
  /** Rim width along the axle. */
  width: number;
  spokes?: number;
  /** Which side the hub's long boss points, +1 or -1 along X. */
  side?: number;
  timberPigment?: PartPigment;
  metalPigment?: PartPigment;
  /** Bone this wheel belongs to. */
  mountBone: string;
}

/**
 * A spoked wheel: felloe, hub, and spokes as a single `InstancedMesh`.
 *
 * Han chariot wheels carry twenty-six to thirty spokes. At twenty-eight that is
 * 28 × 44 = 1 232 triangles per wheel — and one draw call, which is the only
 * reason a thirty-spoke wheel is affordable at all. Instancing here is not an
 * optimisation, it is what makes the historically correct wheel possible.
 */
export function spokedWheel(o: WheelOpts): PartGroup {
  const g = emptyGroup();
  const R = o.radius;
  const w = o.width;
  const n = o.spokes ?? 26;
  const side = o.side ?? 1;
  const timber = o.timberPigment ?? TIMBER;

  // Felloe: a rim built as a lathe about the X axis (the axle), so the wheel
  // stands upright. Built at the origin, then moved to `at`.
  const felloeProfile: [number, number][] = [
    [R * 0.9, -w * 0.5],
    [R * 0.98, -w * 0.42],
    [R, -w * 0.18],
    [R, w * 0.18],
    [R * 0.98, w * 0.42],
    [R * 0.9, w * 0.5],
    [R * 0.86, w * 0.3],
    [R * 0.86, -w * 0.3],
  ];
  const felloe = hardLathe(felloeProfile, 18, {
    capStart: false,
    capEnd: false,
    name: 'felloe',
  });
  // The lathe spins about +Y; rotate it onto the axle (+X).
  felloe.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  felloe.translate(...o.at);
  g.parts.push(
    mkPart(felloe, 'timber', timber, 'root', { name: 'felloe', rigid: true, mountBone: o.mountBone }),
  );

  // Hub: a long tapered barrel, longer on the outboard side.
  const hub = hardLathe(
    [
      [R * 0.1, -w * 1.1 * side],
      [R * 0.14, -w * 0.9 * side],
      [R * 0.15, -w * 0.2 * side],
      [R * 0.15, w * 0.35 * side],
      [R * 0.12, w * 0.75 * side],
      [R * 0.08, w * 0.85 * side],
    ],
    8,
    { name: 'hub' },
  );
  hub.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  hub.translate(...o.at);
  g.parts.push(
    mkPart(hub, 'timber', timber, 'root', { name: 'hub', rigid: true, mountBone: o.mountBone }),
  );

  // Spokes: one tapered prism, instanced around the hub. Authored along +Y at
  // the origin, then rotated into the wheel plane (the YZ plane).
  const spoke = prism({
    rx0: R * 0.035,
    rz0: R * 0.028,
    rx1: R * 0.022,
    rz1: R * 0.02,
    y0: R * 0.13,
    y1: R * 0.9,
    sides: 5,
    squareness: 0.4,
    name: 'spoke',
  });
  const mats: THREE.Matrix4[] = [];
  const pos = new THREE.Vector3(...o.at);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(a, 0, Math.PI / 2, 'YXZ'));
    mats.push(new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1)));
  }
  g.instanced.push({
    geometry: spoke,
    cls: 'timber',
    pigment: timber,
    boneHint: 'root',
    rigid: true,
    mountBone: o.mountBone,
    transforms: mats,
    name: 'spokes',
  });

  // Hub cap and a ring of rivets around the felloe joint.
  g.parts.push(
    boss({
      at: [o.at[0] - w * 1.12 * side, o.at[1], o.at[2]],
      r: R * 0.13,
      height: R * 0.07,
      boneHint: 'root',
      mountBone: o.mountBone,
      pigment: o.metalPigment ?? 'metal',
      rot: [0, 0, side > 0 ? Math.PI / 2 : -Math.PI / 2],
      sides: 8,
    }),
  );
  return g;
}

// ---------------------------------------------------------------------------
// 車 — the chariot
// ---------------------------------------------------------------------------

export interface ChariotOpts {
  /** Wheel radius, rig units. */
  wheelRadius: number;
  /** Half-distance between wheel centres. */
  track: number;
  /** Car floor width (X) and depth (Z). */
  carWidth: number;
  carDepth: number;
  /** Height of the car's side rail above the floor. */
  railHeight: number;
  /** Length of the draught pole running forward (-Z). */
  poleLength: number;
  /** Radius of the 傘蓋 canopy. 0 omits it. */
  canopyRadius?: number;
  canopyHeight?: number;
  at?: V3;
  timberPigment?: PartPigment;
  lacquerPigment?: PartPigment;
  metalPigment?: PartPigment;
  clothPigment?: PartPigment;
  spokes?: number;
}

/**
 * The 車. Two big spoked wheels, an axle, a railed box car, a draught pole with
 * a yoke, and a parasol canopy over the driver.
 *
 * Mount bones: `chariot.body`, `chariot.wheelL`, `chariot.wheelR` (each with
 * `data.radius`), `chariot.pole`, `chariot.canopy`.
 *
 * Publishes `seat` (where the driver stands — a Han charioteer stands, he does
 * not sit), `reinL`/`reinR` at the yoke, and `canopyTop`.
 */
export function chariot(o: ChariotOpts): PartGroup {
  const g = emptyGroup();
  const at = o.at ?? [0, 0, 0];
  const R = o.wheelRadius;
  const timber = o.timberPigment ?? TIMBER;
  const lacq = o.lacquerPigment ?? 'lacquer';
  const P = (x: number, y: number, z: number): V3 => [at[0] + x, at[1] + y, at[2] + z];

  // Floor sits just above the axle so the car clears the ground.
  const axleY = R;
  const floorY = R * 1.06;

  g.bones.push(
    { name: 'chariot.body', parent: 'root', position: P(0, floorY, 0) },
    {
      name: 'chariot.wheelL',
      parent: 'chariot.body',
      position: P(-o.track, axleY, 0),
      data: { radius: R },
    },
    {
      name: 'chariot.wheelR',
      parent: 'chariot.body',
      position: P(o.track, axleY, 0),
      data: { radius: R },
    },
    { name: 'chariot.pole', parent: 'chariot.body', position: P(0, floorY, -o.carDepth * 0.5) },
  );

  // -- axle ----------------------------------------------------------------
  const axle = prism({
    rx0: R * 0.09,
    rx1: R * 0.09,
    y0: -o.track * 1.12,
    y1: o.track * 1.12,
    sides: 6,
    squareness: 0.3,
    name: 'axle',
  });
  axle.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  axle.translate(at[0], at[1] + axleY, at[2]);
  g.parts.push(
    mkPart(axle, 'timber', timber, 'root', { name: 'axle', rigid: true, mountBone: 'chariot.body' }),
  );

  // -- wheels --------------------------------------------------------------
  for (const s of [-1, 1]) {
    const w = spokedWheel({
      at: P(s * o.track, axleY, 0),
      radius: R,
      width: R * 0.1,
      spokes: o.spokes ?? 26,
      side: s,
      timberPigment: timber,
      ...(o.metalPigment ? { metalPigment: o.metalPigment } : {}),
      mountBone: s < 0 ? 'chariot.wheelL' : 'chariot.wheelR',
    });
    g.parts.push(...w.parts);
    g.instanced.push(...w.instanced);
  }

  // -- car -----------------------------------------------------------------
  const hw = o.carWidth * 0.5;
  const hd = o.carDepth * 0.5;
  const floor = bevelSlab({
    w: o.carWidth,
    h: o.carDepth,
    d: R * 0.1,
    bevel: R * 0.03,
    name: 'carFloor',
  });
  place(floor, { pos: P(0, floorY, 0), rot: [Math.PI / 2, 0, 0] });
  g.parts.push(
    mkPart(floor, 'timber', timber, 'root', { name: 'carFloor', rigid: true, mountBone: 'chariot.body' }),
  );

  // Side and back panels — lacquered, and the biggest flat area on the unit, so
  // they get a piped edge and a row of studs to break them up.
  const panelTop = floorY + o.railHeight;
  const panels: { grid: V3[][]; name: string }[] = [];
  for (const s of [-1, 1]) {
    panels.push({
      name: `carSide${s < 0 ? 'L' : 'R'}`,
      grid: [
        [P(s * hw, panelTop, -hd), P(s * hw, panelTop, 0), P(s * hw, panelTop * 0.98, hd)],
        [P(s * hw, floorY, -hd), P(s * hw, floorY, 0), P(s * hw, floorY, hd)],
      ],
    });
  }
  panels.push({
    name: 'carBack',
    grid: [
      [P(-hw, panelTop * 0.98, hd), P(0, panelTop * 0.98, hd), P(hw, panelTop * 0.98, hd)],
      [P(-hw, floorY, hd), P(0, floorY, hd), P(hw, floorY, hd)],
    ],
  });
  for (const p of panels) {
    g.parts.push(
      mkPart(shell(p.grid, R * 0.025, { name: p.name }), 'lacquer', lacq, 'root', {
        name: p.name,
        rigid: true,
        mountBone: 'chariot.body',
      }),
    );
  }

  // Rail around the top of the panels.
  for (const s of [-1, 1]) {
    g.parts.push(
      piping({
        path: [P(s * hw, panelTop, -hd), P(s * hw, panelTop, 0), P(s * hw, panelTop * 0.98, hd)],
        r: R * 0.045,
        boneHint: 'root',
        mountBone: 'chariot.body',
        pigment: o.metalPigment ?? 'metal',
        cls: 'timber',
        sides: 5,
        name: 'carRail',
      }),
    );
  }
  g.parts.push(
    piping({
      path: [P(-hw, panelTop * 0.98, hd), P(0, panelTop * 0.98, hd), P(hw, panelTop * 0.98, hd)],
      r: R * 0.045,
      boneHint: 'root',
      mountBone: 'chariot.body',
      pigment: o.metalPigment ?? 'metal',
      cls: 'timber',
      sides: 5,
      name: 'carRailBack',
    }),
  );
  for (const s of [-1, 1]) {
    g.instanced.push(
      ...rivetArc({
        centre: P(s * hw * 1.02, (floorY + panelTop) * 0.5, 0),
        rx: R * 0.02,
        rz: hd * 0.8,
        count: 5,
        boneHint: 'root',
        mountBone: 'chariot.body',
        pigment: o.metalPigment ?? 'metal',
        rivet: { r: R * 0.035, h: R * 0.022 },
        name: 'carStuds',
      }).instanced,
    );
  }

  // -- draught pole and yoke ------------------------------------------------
  const poleTipY = floorY + o.poleLength * 0.16;
  const pole = sweep(
    [
      { p: P(0, floorY - R * 0.02, hd * 0.4), rx: R * 0.075, squareness: 0.35 },
      { p: P(0, floorY + R * 0.02, -hd), rx: R * 0.07, squareness: 0.35 },
      { p: P(0, floorY + o.poleLength * 0.06, -hd - o.poleLength * 0.55), rx: R * 0.06, squareness: 0.35 },
      { p: P(0, poleTipY, -hd - o.poleLength), rx: R * 0.05, squareness: 0.35 },
    ],
    { sides: 6, name: 'draughtPole' },
  );
  g.parts.push(
    mkPart(pole, 'timber', timber, 'root', { name: 'draughtPole', rigid: true, mountBone: 'chariot.pole' }),
  );

  // Yoke: a crossbar with two neck forks.
  const yoke = prism({
    rx0: R * 0.055,
    rx1: R * 0.055,
    y0: -o.track * 0.72,
    y1: o.track * 0.72,
    sides: 5,
    squareness: 0.35,
    name: 'yoke',
  });
  yoke.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  yoke.translate(at[0], at[1] + poleTipY, at[2] - hd - o.poleLength);
  g.parts.push(
    mkPart(yoke, 'timber', timber, 'root', { name: 'yoke', rigid: true, mountBone: 'chariot.pole' }),
  );
  for (const s of [-1, 1]) {
    const fork = strut(
      P(s * o.track * 0.5, poleTipY, -hd - o.poleLength),
      P(s * o.track * 0.62, poleTipY - R * 0.42, -hd - o.poleLength + R * 0.1),
      R * 0.035,
      R * 0.028,
      5,
    );
    g.parts.push(
      mkPart(fork, 'timber', timber, 'root', { name: 'yokeFork', rigid: true, mountBone: 'chariot.pole' }),
    );
  }
  g.parts.push(
    ferrule({
      at: P(0, poleTipY, -hd - o.poleLength + R * 0.05),
      r: R * 0.08,
      height: R * 0.09,
      proud: R * 0.02,
      boneHint: 'root',
      mountBone: 'chariot.pole',
      pigment: o.metalPigment ?? 'metal',
    }),
  );

  // -- 傘蓋 canopy ----------------------------------------------------------
  const cr = o.canopyRadius ?? 0;
  if (cr > 0.001) {
    const ch = o.canopyHeight ?? R * 1.9;
    g.bones.push({ name: 'chariot.canopy', parent: 'chariot.body', position: P(0, floorY, hd * 0.1) });
    const mast = prism({
      rx0: R * 0.045,
      rx1: R * 0.03,
      y0: floorY,
      y1: floorY + ch,
      sides: 6,
      squareness: 0.3,
      name: 'canopyMast',
    });
    mast.translate(at[0], at[1], at[2] + hd * 0.1);
    g.parts.push(
      mkPart(mast, 'timber', timber, 'root', {
        name: 'canopyMast',
        rigid: true,
        mountBone: 'chariot.canopy',
      }),
    );

    // The canopy itself: a shallow scalloped dome. Sixteen segments, with the
    // rim alternating high and low so the edge is a scallop and not a circle —
    // this is the floating horizontal disc that identifies the 車 from above.
    const segs = 16;
    const rings: V3[][] = [];
    for (let r = 0; r < 4; r++) {
      const t = r / 3;
      const row: V3[] = [];
      for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const scallop = i % 2 === 0 ? 1.0 : 0.93;
        const rr = cr * t * scallop;
        row.push(P(Math.cos(a) * rr, floorY + ch - t * t * cr * 0.34, hd * 0.1 + Math.sin(a) * rr));
      }
      rings.push(row);
    }
    const dome = loft(rings, { capStart: false, capEnd: false, name: 'canopy' });
    g.parts.push(
      mkPart(dome, 'cloth', o.clothPigment ?? 'cloth', 'root', {
        name: 'canopy',
        rigid: true,
        mountBone: 'chariot.canopy',
      }),
    );
    // Ribs under the canopy, instanced.
    const rib = prism({
      rx0: cr * 0.012,
      rx1: cr * 0.008,
      y0: 0,
      y1: cr,
      sides: 4,
      name: 'canopyRib',
    });
    const ribMats: THREE.Matrix4[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ribMats.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(at[0], at[1] + floorY + ch - cr * 0.02, at[2] + hd * 0.1),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -a, Math.PI / 2 - 0.28, 'YXZ')),
          new THREE.Vector3(1, 1, 1),
        ),
      );
    }
    g.instanced.push({
      geometry: rib,
      cls: 'timber',
      pigment: timber,
      boneHint: 'root',
      rigid: true,
      mountBone: 'chariot.canopy',
      transforms: ribMats,
      name: 'canopyRibs',
    });
    // Finial and corner tassels.
    g.parts.push(
      boss({
        at: P(0, floorY + ch + cr * 0.03, hd * 0.1),
        r: cr * 0.09,
        height: cr * 0.14,
        boneHint: 'root',
        mountBone: 'chariot.canopy',
        pigment: o.metalPigment ?? 'metal',
        sides: 8,
      }),
    );
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const t = tassel({
        at: P(Math.cos(a) * cr * 0.97, floorY + ch - cr * 0.34, hd * 0.1 + Math.sin(a) * cr * 0.97),
        length: cr * 0.3,
        r: cr * 0.07,
        strands: 5,
        boneHint: 'root',
        mountBone: 'chariot.canopy',
        ...(o.clothPigment ? { pigment: o.clothPigment } : {}),
      });
      g.parts.push(...t.parts);
      g.instanced.push(...t.instanced);
    }
    g.points.canopyTop = new THREE.Vector3(at[0], at[1] + floorY + ch + cr * 0.17, at[2] + hd * 0.1);
  }

  g.points.seat = new THREE.Vector3(at[0], at[1] + floorY + R * 0.06, at[2] + hd * 0.18);
  g.points.reinL = new THREE.Vector3(at[0] - o.track * 0.4, at[1] + poleTipY, at[2] - hd - o.poleLength * 0.9);
  g.points.reinR = new THREE.Vector3(at[0] + o.track * 0.4, at[1] + poleTipY, at[2] - hd - o.poleLength * 0.9);
  g.attach.push(
    { name: 'mountSeat', bone: 'chariot.body', position: [g.points.seat.x, g.points.seat.y, g.points.seat.z] },
    { name: 'reinL', bone: 'chariot.pole', position: [g.points.reinL.x, g.points.reinL.y, g.points.reinL.z] },
    { name: 'reinR', bone: 'chariot.pole', position: [g.points.reinR.x, g.points.reinR.y, g.points.reinR.z] },
  );
  return g;
}

// ---------------------------------------------------------------------------
// 砲 — the traction trebuchet
// ---------------------------------------------------------------------------

export interface TrebuchetOpts {
  /** Height of the pivot above the ground. */
  pivotHeight: number;
  /** Length of the throwing arm from pivot to sling end. */
  armLength: number;
  /** Length of the short arm carrying the counterweight. */
  buttLength: number;
  /** Half-width of the A-frame at the base. */
  spread: number;
  /** Sled base length. */
  sledLength: number;
  at?: V3;
  timberPigment?: PartPigment;
  metalPigment?: PartPigment;
  clothPigment?: PartPigment;
  lacquerPigment?: PartPigment;
  /** Arm elevation at rest, radians above horizontal. */
  armAngle?: number;
}

/**
 * 砲 — a counterweighted traction trebuchet on a sled.
 *
 * Mount bones: `treb.base`, `treb.pivot`, `treb.beam` (rotate this one to
 * throw), `treb.weight`, `treb.sling`. Publishes `muzzle` at the sling's
 * release point, which the factory maps to the `muzzle` attachment socket — the
 * projectile origin the anim and FX systems need.
 */
export function trebuchet(o: TrebuchetOpts): PartGroup {
  const g = emptyGroup();
  const at = o.at ?? [0, 0, 0];
  const H = o.pivotHeight;
  const timber = o.timberPigment ?? TIMBER;
  const P = (x: number, y: number, z: number): V3 => [at[0] + x, at[1] + y, at[2] + z];
  const angle = o.armAngle ?? 0.62;

  g.bones.push(
    { name: 'treb.base', parent: 'root', position: P(0, 0, 0) },
    { name: 'treb.pivot', parent: 'treb.base', position: P(0, H, 0) },
    { name: 'treb.beam', parent: 'treb.pivot', position: P(0, H, 0) },
  );

  // -- sled ----------------------------------------------------------------
  const beamR = H * 0.055;
  for (const s of [-1, 1]) {
    const runner = bevelSlab({
      w: H * 0.11,
      h: H * 0.1,
      d: o.sledLength,
      bevel: H * 0.02,
    });
    place(runner, { pos: P(s * o.spread * 0.92, H * 0.05, 0), rot: [Math.PI / 2, 0, 0] });
    g.parts.push(
      mkPart(runner, 'timber', timber, 'root', { name: 'sledRunner', rigid: true, mountBone: 'treb.base' }),
    );
  }
  for (const z of [-o.sledLength * 0.38, o.sledLength * 0.38]) {
    const tie = prism({
      rx0: H * 0.045,
      rx1: H * 0.045,
      y0: -o.spread * 0.95,
      y1: o.spread * 0.95,
      sides: 4,
      name: 'sledTie',
    });
    tie.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
    tie.translate(at[0], at[1] + H * 0.1, at[2] + z);
    g.parts.push(
      mkPart(tie, 'timber', timber, 'root', { name: 'sledTie', rigid: true, mountBone: 'treb.base' }),
    );
  }

  // -- A-frame -------------------------------------------------------------
  // Four legs meeting at the pivot, plus a cross-brace on each side. The frame
  // is the widest part of the silhouette and it is deliberately splayed: the 砲
  // has to read as low and braced against the horse's long-and-lean.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.parts.push(
        mkPart(
          strut(
            P(sx * o.spread, H * 0.09, sz * o.sledLength * 0.34),
            P(sx * beamR * 1.4, H, 0),
            H * 0.055,
            H * 0.04,
            5,
          ),
          'timber',
          timber,
          'root',
          { name: 'frameLeg', rigid: true, mountBone: 'treb.base' },
        ),
      );
    }
    g.parts.push(
      mkPart(
        strut(
          P(sx * o.spread * 0.62, H * 0.52, -o.sledLength * 0.2),
          P(sx * o.spread * 0.62, H * 0.52, o.sledLength * 0.2),
          H * 0.035,
          H * 0.035,
          4,
        ),
        'timber',
        timber,
        'root',
        { name: 'frameBrace', rigid: true, mountBone: 'treb.base' },
      ),
    );
  }

  // Pivot bearing.
  const bearing = prism({
    rx0: H * 0.075,
    rx1: H * 0.075,
    y0: -beamR * 3.2,
    y1: beamR * 3.2,
    sides: 8,
    name: 'pivotBearing',
  });
  bearing.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  bearing.translate(at[0], at[1] + H, at[2]);
  g.parts.push(
    mkPart(bearing, 'iron', o.metalPigment ?? 'metal', 'root', {
      name: 'pivotBearing',
      rigid: true,
      mountBone: 'treb.pivot',
    }),
  );

  // -- beam ----------------------------------------------------------------
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const tipUp: V3 = P(0, H + sa * o.armLength, ca * o.armLength);
  const tipDown: V3 = P(0, H - sa * o.buttLength, -ca * o.buttLength);
  const beam = sweep(
    [
      { p: tipDown, rx: beamR * 0.72, rz: beamR * 0.6, squareness: 0.45 },
      { p: P(0, H - sa * o.buttLength * 0.3, -ca * o.buttLength * 0.3), rx: beamR * 1.05, rz: beamR * 0.9, squareness: 0.45 },
      { p: P(0, H + sa * o.armLength * 0.3, ca * o.armLength * 0.3), rx: beamR, rz: beamR * 0.86, squareness: 0.45 },
      { p: tipUp, rx: beamR * 0.5, rz: beamR * 0.44, squareness: 0.45 },
    ],
    { sides: 6, name: 'trebBeam' },
  );
  g.parts.push(
    mkPart(beam, 'timber', timber, 'root', { name: 'trebBeam', rigid: true, mountBone: 'treb.beam' }),
  );
  for (let i = 0; i < 3; i++) {
    const t = (i + 1) / 4;
    g.parts.push(
      ferrule({
        at: P(0, H + sa * o.armLength * t, ca * o.armLength * t),
        r: beamR * 1.02,
        height: beamR * 0.5,
        proud: beamR * 0.16,
        boneHint: 'root',
        mountBone: 'treb.beam',
        pigment: o.metalPigment ?? 'metal',
        rot: [Math.PI / 2 - angle, 0, 0],
      }),
    );
  }

  // -- counterweight box ---------------------------------------------------
  g.bones.push({ name: 'treb.weight', parent: 'treb.beam', position: tipDown });
  const boxW = o.spread * 0.78;
  const box = loft(
    [
      ring({ rx: boxW * 0.86, rz: boxW * 0.7, y: tipDown[1] - boxW * 1.15, cx: tipDown[0], cz: tipDown[2], sides: 4, phase: Math.PI / 4 }),
      ring({ rx: boxW, rz: boxW * 0.82, y: tipDown[1] - boxW * 0.3, cx: tipDown[0], cz: tipDown[2], sides: 4, phase: Math.PI / 4 }),
      ring({ rx: boxW * 0.98, rz: boxW * 0.8, y: tipDown[1] - boxW * 0.16, cx: tipDown[0], cz: tipDown[2], sides: 4, phase: Math.PI / 4 }),
    ],
    { name: 'counterweight' },
  );
  g.parts.push(
    mkPart(box, 'timber', o.lacquerPigment ?? timber, 'root', {
      name: 'counterweight',
      rigid: true,
      mountBone: 'treb.weight',
    }),
  );
  // Iron banding round the box — four straps, instanced.
  const strap = bevelSlab({
    w: boxW * 2.06,
    h: boxW * 0.12,
    d: boxW * 0.05,
    bevel: boxW * 0.02,
    backFace: false,
  });
  const strapMats: THREE.Matrix4[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    strapMats.push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(tipDown[0], tipDown[1] - boxW * 0.62, tipDown[2]),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, a, 0, 'YXZ')),
        new THREE.Vector3(1, 1, 1),
      ),
    );
  }
  g.instanced.push({
    geometry: strap,
    cls: 'iron',
    pigment: o.metalPigment ?? 'metal',
    boneHint: 'root',
    rigid: true,
    mountBone: 'treb.weight',
    transforms: strapMats,
    name: 'weightBands',
  });

  // -- sling ---------------------------------------------------------------
  g.bones.push({ name: 'treb.sling', parent: 'treb.beam', position: tipUp });
  const slingLen = o.armLength * 0.42;
  const pouchAt: V3 = [tipUp[0], tipUp[1] - slingLen, tipUp[2] + slingLen * 0.12];
  for (const s of [-1, 1]) {
    g.parts.push(
      piping({
        path: [
          [tipUp[0] + s * beamR * 0.4, tipUp[1], tipUp[2]],
          [
            tipUp[0] + s * beamR * 1.5,
            tipUp[1] - slingLen * 0.5,
            tipUp[2] + slingLen * 0.06,
          ],
          [pouchAt[0] + s * beamR * 1.1, pouchAt[1], pouchAt[2]],
        ],
        r: beamR * 0.13,
        boneHint: 'root',
        mountBone: 'treb.sling',
        pigment: o.clothPigment ?? 'leather',
        cls: 'leather',
        sides: 4,
        name: 'slingCord',
      }),
    );
  }
  // Pouch: a small shell cradling a stone.
  const pouch: V3[][] = [];
  for (let r = 0; r < 3; r++) {
    const t = r / 2;
    const row: V3[] = [];
    for (let c = 0; c < 3; c++) {
      const u = c / 2;
      row.push([
        pouchAt[0] + (u - 0.5) * beamR * 2.6,
        pouchAt[1] - Math.sin(t * Math.PI) * beamR * 0.9,
        pouchAt[2] + (t - 0.5) * beamR * 2.6,
      ]);
    }
    pouch.push(row);
  }
  g.parts.push(
    mkPart(shell(pouch, beamR * 0.1, { name: 'slingPouch' }), 'leather', o.clothPigment ?? 'leather', 'root', {
      name: 'slingPouch',
      rigid: true,
      mountBone: 'treb.sling',
    }),
  );
  const stone = hardLathe(
    [
      [0.001, pouchAt[1] - beamR * 1.5],
      [beamR * 0.8, pouchAt[1] - beamR * 0.8],
      [beamR * 0.9, pouchAt[1] - beamR * 0.1],
      [beamR * 0.6, pouchAt[1] + beamR * 0.5],
      [0.001, pouchAt[1] + beamR * 0.8],
    ],
    7,
    { name: 'slingStone' },
  );
  stone.translate(pouchAt[0], 0, pouchAt[2]);
  g.parts.push(
    mkPart(stone, 'stone', 'stone', 'root', { name: 'slingStone', rigid: true, mountBone: 'treb.sling' }),
  );

  // -- traction ropes for the crew -----------------------------------------
  for (const s of [-1, 1]) {
    g.parts.push(
      piping({
        path: [
          [tipDown[0] + s * boxW * 0.3, tipDown[1] - boxW * 0.2, tipDown[2]],
          [tipDown[0] + s * boxW * 0.6, at[1] + H * 0.5, tipDown[2] - o.sledLength * 0.16],
          [tipDown[0] + s * boxW * 0.7, at[1] + H * 0.22, tipDown[2] - o.sledLength * 0.3],
        ],
        r: beamR * 0.11,
        boneHint: 'root',
        mountBone: 'treb.base',
        pigment: o.clothPigment ?? 'leather',
        cls: 'leather',
        sides: 4,
        name: 'tractionRope',
      }),
    );
  }

  g.points.muzzle = new THREE.Vector3(...pouchAt);
  g.points.pivot = new THREE.Vector3(at[0], at[1] + H, at[2]);
  g.points.armTip = new THREE.Vector3(...tipUp);
  g.attach.push({ name: 'muzzle', bone: 'treb.sling', position: pouchAt });
  return g;
}
