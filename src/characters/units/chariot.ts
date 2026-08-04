/**
 * 俥 / 車 — the war chariot 戰車.
 *
 * SILHOUETTE CONTRACT
 * -------------------
 * This is the widest and the most horizontal thing on the board, and it is the
 * only outline with a **disc floating above a void**: two tall wheels, a low box
 * between them, a long draught pole running forward, and a canopy on a mast with
 * clear air under it. Nothing else in the cast has air inside its silhouette. At
 * board distance the read is
 *
 *     two big circles + a long horizontal + a lid on a stick
 *
 * and it survives being reduced to black precisely because the gap between the
 * car and the canopy is part of the shape.
 *
 * WHEELS AND THE GROUND — THE ONE HARD CONTRACT
 * ---------------------------------------------
 * `chariot.wheelL` and `chariot.wheelR` publish `data.radius` in **rig units**.
 * The animator turns ground travel into wheel rotation with
 *
 *     Δθ = Δs / (radius · scale)
 *
 * where `scale` is `UnitInstance.meta.proportions.scale`, because the radius
 * here is pre-scale and the travel is measured in world units. Publishing the
 * number rather than letting the animator estimate it is the whole difference
 * between a wheel that rolls and a wheel that skids, and a skidding wheel is an
 * automatic fail. `data` also carries `width` and `spokes` so a motion-blur or
 * strobe pass can reason about spoke frequency without re-deriving it.
 *
 * The wheel is built here rather than taken from `parts/vehicle.ts` for two
 * reasons: the two armies need different wheels (26 heavy spokes and a rounded
 * felloe against 30 light ones and a flat tread), and the shared
 * `spokedWheel()` composes its spoke instance transforms as
 * `Euler(a, 0, π/2, 'YXZ')`, which is `Rx(a)·Rz(π/2)` — and `Rz(π/2)` sends the
 * spoke's +Y axis onto −X, the axle direction, where `Rx(a)` cannot move it. All
 * of its spokes therefore collapse into one stub lying along the axle. The
 * correct transform for a wheel standing in the YZ plane is a plain rotation
 * about the axle, `Euler(θ, 0, 0)`, which is what `wheel()` below uses.
 *
 * TWO ARMIES
 * ----------
 *   |          | Han 俥                          | Chu 車                        |
 *   |----------|---------------------------------|-------------------------------|
 *   | canopy   | round 傘蓋 parasol, scalloped   | square canopy, four upswept   |
 *   |          | rim, single finial              | corners each with a finial    |
 *   | car      | rounded rail that dips at the   | square car, four corner posts |
 *   |          | 軾 front bar                    | with capped finials           |
 *   | wheel    | 26 stout spokes, round felloe   | 30 fine spokes, flat tread    |
 *   | yoke     | two curved neck forks 軛        | straight yoke, bronze caps    |
 *   | crew     | doumou helms                    | Chu peaked helms              |
 *
 * CREW
 * ----
 * Two figures, as a real 戰車 carries: the 御者 driver on the left with both
 * fists closed on the reins, and the 車右 halberdier on the right with a 戟
 * levelled forward over the team.
 *
 * Only the driver can have the shared humanoid rig — a unit has exactly one, and
 * it is his. The halberdier is built from the same parts library, from stations
 * derived from the driver's own metrics so the two men are proportioned
 * identically, and every one of his geometries is bound rigidly to the
 * `chariot.warrior` mount bone. He is a passenger: the animator can sway him
 * with that bone but cannot bend his elbow. That is a real limitation and it is
 * the honest cost of one skeleton per unit.
 */

import * as THREE from 'three';
import type { BoneName } from '@core/contracts.ts';
import { PieceType, Side } from '@core/types.ts';
import { registerUnit, type UnitBuildContext } from '@characters/factory.ts';
import type { Rig, RigMetrics, RigOptions } from '@characters/rig.ts';
import type { PartGroup, V3 } from '@characters/parts/types.ts';

// ---------------------------------------------------------------------------
// Local helpers. `units/` has no shared module by contract, so these are
// deliberately duplicated per file rather than lifted somewhere common.
// ---------------------------------------------------------------------------

const v3 = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];

function mergeInto(dst: PartGroup, src: PartGroup, parts: UnitBuildContext['parts']): void {
  const merged = parts.mergeGroups(dst, src);
  dst.parts = merged.parts;
  dst.instanced = merged.instanced;
  dst.bones = merged.bones;
  dst.attach = merged.attach;
  dst.points = merged.points;
}

function unit(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function step(a: V3, b: V3, t: number): V3 {
  return [a[0] + b[0] * t, a[1] + b[1] * t, a[2] + b[2] * t];
}

function lerp3(a: V3, b: V3, t: number): V3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Rebind a whole group onto a mount bone as rigid geometry, and drop the
 * landmarks it published.
 *
 * The landmark part matters: `body.hand()` publishes `gripR`/`gripL` and
 * `helmet()` publishes `crest`, and the factory turns those into attachment
 * sockets *on the humanoid hand and head bones*. Letting the halberdier's
 * points survive would hang the unit's `gripR` socket on the driver's wrist at
 * the halberdier's hand position — a detached weapon, silently.
 */
function pinTo(g: PartGroup, mountBone: string): PartGroup {
  for (const p of g.parts) {
    p.mountBone = mountBone;
    p.rigid = true;
  }
  for (const p of g.instanced) {
    p.mountBone = mountBone;
    p.rigid = true;
  }
  g.points = {};
  g.attach = [];
  return g;
}

/** The six geometries `body.hand()` emits, per side. */
const FIST_PIECES = ['palm', 'fingers', 'fistCapT', 'fistCapB', 'fistBore', 'thumb'] as const;

/**
 * Rotate one fist about its own published grip point so the bore lines up with
 * whatever runs through it. Every weapon is authored haft-along-+Y through the
 * grip; a rein or a haft at any other angle needs the hand turned to match, or
 * it reads as a weapon floating beside a wrist.
 */
function rotateFist(g: PartGroup, side: 'L' | 'R', rot: V3): void {
  const grip = g.points[`grip${side}`];
  if (!grip) return;
  const m = new THREE.Matrix4()
    .makeTranslation(grip.x, grip.y, grip.z)
    .multiply(
      new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ')),
    )
    .multiply(new THREE.Matrix4().makeTranslation(-grip.x, -grip.y, -grip.z));
  const wanted = new Set(FIST_PIECES.map((n) => `${n}${side}`));
  for (const p of g.parts) if (p.name && wanted.has(p.name)) p.geometry.applyMatrix4(m);
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/**
 * Every measurement of the vehicle, derived once from the crew's stature so the
 * whole thing scales coherently with `proportions.height`. Read this table
 * rather than hunting constants through the builders.
 */
interface Car {
  R: number; // wheel radius — the published contract number
  track: number; // half the distance between wheel centres
  wheelW: number;
  spokes: number;
  axleY: number;
  floorY: number; // centre of the floor slab
  floorTop: number; // the surface the crew stand on
  floorThk: number;
  hw: number; // car half-width
  hd: number; // car half-depth
  panelTop: number;
  poleLen: number;
  poleTipY: number;
  canopyH: number;
  canopyR: number;
  canopyZ: number;
  canopyDrop: number;
}

function dimensions(h: number, han: boolean): Car {
  const R = h * 0.78;
  const floorThk = R * 0.1;
  const floorY = R * 1.1;
  const hd = h * 0.37;
  // Canopy height is the whole unit's height, and it is a compromise between
  // two hard constraints: it must clear the driver's fan crest (about 1.1
  // statures above the floor) and it must stay under the elephant, which is the
  // next unit up the height ladder at 2.76 world units. 1.22 statures leaves
  // roughly a finger's clearance over the crest and lands the finial at 2.5.
  const canopyH = h * 1.22;
  const canopyR = h * (han ? 0.86 : 0.8);
  return {
    R,
    track: h * 0.745,
    wheelW: R * 0.12,
    spokes: han ? 26 : 30,
    axleY: R,
    floorY,
    floorThk,
    floorTop: floorY + floorThk * 0.5,
    hw: h * 0.53,
    hd,
    panelTop: floorY + h * 0.5,
    poleLen: h * 1.66,
    poleTipY: floorY + h * 0.28,
    canopyH,
    canopyR,
    canopyZ: hd * 0.12,
    canopyDrop: canopyR * 0.34,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function buildChariot(ctx: UnitBuildContext): PartGroup {
  const P = ctx.parts;
  const han = ctx.side === Side.Red;
  const h = ctx.spec.proportions.height;
  const c = dimensions(h, han);
  const g = P.emptyGroup();

  // Crew stations. The driver stands left of centre, the halberdier right and a
  // little further back, which is where a 戰車 crew actually stands and which
  // keeps two sets of shoulders inside a car barely three shoulders wide.
  const driverAt: V3 = [-c.hw * 0.4, c.floorTop, c.hd * 0.18];
  const warriorAt: V3 = [c.hw * 0.46, c.floorTop, c.hd * 0.34];

  // --- bones ---------------------------------------------------------------
  // Positions are rig space; the factory rebases each into its parent. `radius`
  // on the two wheels is the contract the animator reads.
  g.bones.push(
    { name: 'chariot.body', parent: 'root', position: [0, c.floorY, 0] },
    {
      name: 'chariot.wheelL',
      parent: 'chariot.body',
      position: [-c.track, c.axleY, 0],
      data: { radius: c.R, width: c.wheelW, spokes: c.spokes },
    },
    {
      name: 'chariot.wheelR',
      parent: 'chariot.body',
      position: [c.track, c.axleY, 0],
      data: { radius: c.R, width: c.wheelW, spokes: c.spokes },
    },
    { name: 'chariot.pole', parent: 'chariot.body', position: [0, c.floorY, -c.hd] },
    { name: 'chariot.canopy', parent: 'chariot.body', position: [0, c.floorY, c.canopyZ] },
    { name: 'chariot.warrior', parent: 'chariot.body', position: warriorAt },
  );

  // --- the vehicle ---------------------------------------------------------
  for (const s of [-1, 1] as const) {
    mergeInto(
      g,
      wheel(ctx, {
        at: [s * c.track, c.axleY, 0],
        radius: c.R,
        width: c.wheelW,
        spokes: c.spokes,
        side: s,
        mountBone: s < 0 ? 'chariot.wheelL' : 'chariot.wheelR',
        han,
      }),
      P,
    );
  }
  mergeInto(g, carBody(ctx, c, han), P);
  mergeInto(g, draughtPole(ctx, c, han), P);
  mergeInto(g, canopy(ctx, c, han), P);

  // --- the driver, on the shared rig ---------------------------------------
  // Built twice: once to read the A-pose, once with the rein grip baked into
  // the bind pose so linear blend skinning never carries the posed shoulders.
  const origin: [number, number, number] = [driverAt[0], driverAt[1], driverAt[2]];
  const rig0 = ctx.useRig({ origin });
  const rig = ctx.useRig({ origin, offsets: reinPose(rig0) });
  mergeInto(g, driver(ctx, rig, c, han), P);

  // --- the halberdier, rigid on his own mount bone -------------------------
  const w = halberdier(ctx, {
    at: warriorAt,
    k: 0.97,
    m: rig.metrics,
    feetY: driverAt[1],
    mountBone: 'chariot.warrior',
    han,
  });
  mergeInto(g, w.group, P);
  g.attach.push({ name: 'haftTip', bone: 'chariot.warrior', position: w.haftTip });

  return g;
}

// ---------------------------------------------------------------------------
// Wheel
// ---------------------------------------------------------------------------

interface WheelOpts {
  at: V3;
  radius: number;
  width: number;
  spokes: number;
  /** −1 for the left wheel, +1 for the right. The nave runs outboard. */
  side: number;
  mountBone: string;
  han: boolean;
}

/**
 * One spoked wheel, standing in the YZ plane with the axle along X.
 *
 * Felloe and hub are lathes about +Y rotated onto the axle; the spokes are one
 * five-sided tapered prism instanced `spokes` times, each rotated about the
 * **axle** by its own angle. Twenty-six spokes at 26 triangles each is 676
 * triangles and one draw call, which is the only reason a historically correct
 * spoke count is affordable at all — a Han chariot wheel carries 26 to 30, and a
 * wheel with eight would read as a cart.
 */
function wheel(ctx: UnitBuildContext, o: WheelOpts): PartGroup {
  const P = ctx.parts;
  const g = P.emptyGroup();
  const R = o.radius;
  const w = o.width;
  const s = o.side;
  const toAxle = new THREE.Matrix4().makeRotationZ(Math.PI / 2);

  // Felloe 輞. Han rims are stout with a rounded tread; Chu rims are lighter
  // with a flat one, so the two wheels catch different numbers of ramp bands.
  const felloe = P.prim.hardLathe(
    o.han
      ? [
          [R * 0.86, -w * 0.5],
          [R * 0.96, -w * 0.46],
          [R * 1.0, -w * 0.2],
          [R * 1.0, w * 0.2],
          [R * 0.96, w * 0.46],
          [R * 0.86, w * 0.5],
          [R * 0.83, w * 0.34],
          [R * 0.83, -w * 0.34],
        ]
      : [
          [R * 0.88, -w * 0.42],
          [R * 1.0, -w * 0.42],
          [R * 1.0, w * 0.42],
          [R * 0.88, w * 0.42],
          [R * 0.85, w * 0.28],
          [R * 0.85, -w * 0.28],
        ],
    o.han ? 18 : 20,
    { capStart: false, capEnd: false, name: 'felloe' },
  );
  felloe.applyMatrix4(toAxle);
  felloe.translate(...o.at);
  g.parts.push(
    P.mkPart(felloe, 'timber', 'ochre', 'root', {
      name: 'felloe',
      rigid: true,
      mountBone: o.mountBone,
    }),
  );

  // Hub 轂: a long barrel with the nave projecting outboard, symmetric under
  // the `side` flip so the two wheels are mirror images rather than clones.
  const hub = P.prim.hardLathe(
    [
      [R * 0.09, s * w * 1.5],
      [R * 0.13, s * w * 1.2],
      [R * 0.16, s * w * 0.3],
      [R * 0.16, -s * w * 0.5],
      [R * 0.12, -s * w * 0.9],
      [R * 0.09, -s * w * 1.0],
    ],
    8,
    { name: 'hub' },
  );
  hub.applyMatrix4(toAxle);
  hub.translate(...o.at);
  g.parts.push(
    P.mkPart(hub, 'timber', 'ochre', 'root', { name: 'hub', rigid: true, mountBone: o.mountBone }),
  );

  // Spokes 輻, instanced. Authored along +Y at the origin, then rotated about
  // the axle — a plain `Euler(θ, 0, 0)`, so every spoke stays in the wheel's own
  // plane instead of collapsing onto the axle.
  const spoke = P.prim.prism({
    rx0: R * (o.han ? 0.04 : 0.032),
    rz0: R * (o.han ? 0.03 : 0.024),
    rx1: R * (o.han ? 0.024 : 0.019),
    rz1: R * (o.han ? 0.021 : 0.017),
    y0: R * 0.12,
    y1: R * 0.88,
    sides: 5,
    squareness: 0.4,
    name: 'spoke',
  });
  const pos = new THREE.Vector3(...o.at);
  const mats: THREE.Matrix4[] = [];
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < o.spokes; i++) {
    const th = (i / o.spokes) * Math.PI * 2;
    mats.push(
      new THREE.Matrix4().compose(
        pos,
        new THREE.Quaternion().setFromEuler(new THREE.Euler(th, 0, 0, 'XYZ')),
        one,
      ),
    );
  }
  g.instanced.push({
    geometry: spoke,
    cls: 'timber',
    pigment: 'ochre',
    boneHint: 'root',
    rigid: true,
    mountBone: o.mountBone,
    transforms: mats,
    name: 'spokes',
  });

  // Bronze nave cap outboard, and a ring of tyre nails around the tread. The
  // nails are what tell you the rim is banded rather than turned.
  g.parts.push(
    P.trim.boss({
      at: [o.at[0] + s * w * 1.55, o.at[1], o.at[2]],
      r: R * 0.14,
      height: R * 0.08,
      boneHint: 'root',
      mountBone: o.mountBone,
      rot: [0, 0, s > 0 ? -Math.PI / 2 : Math.PI / 2],
      sides: 8,
    }),
  );
  mergeInto(
    g,
    nailRing(ctx, o.at, R, o.han ? 12 : 16, o.mountBone),
    P,
  );
  return g;
}

/**
 * Tyre nails around the felloe. `rivets.rivetArc` places studs on an ellipse in
 * the XZ plane, which is the wrong plane for a wheel, so the ring is built here:
 * position on the YZ circle, +Y axis of the stud rotated onto the radius.
 */
function nailRing(
  ctx: UnitBuildContext,
  at: V3,
  R: number,
  count: number,
  mountBone: string,
): PartGroup {
  const P = ctx.parts;
  const g = P.emptyGroup();
  // Seated at 0.965 R with a 0.03 R head, so the nail crowns land at 0.995 R —
  // inside the tread. Nails proud of the rim look right in isolation and dip
  // below y = 0 at the bottom of the wheel, which puts them through the board.
  const geo = P.rivets.rivetGeometry({ r: R * 0.045, h: R * 0.03, sides: 6 });
  const up = new THREE.Vector3(0, 1, 0);
  const n = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const mats: THREE.Matrix4[] = [];
  for (let i = 0; i < count; i++) {
    const th = ((i + 0.5) / count) * Math.PI * 2;
    n.set(0, Math.cos(th), Math.sin(th));
    mats.push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(at[0], at[1] + n.y * R * 0.965, at[2] + n.z * R * 0.965),
        new THREE.Quaternion().setFromUnitVectors(up, n),
        one,
      ),
    );
  }
  g.instanced.push({
    geometry: geo,
    cls: 'iron',
    pigment: 'metal',
    boneHint: 'root',
    rigid: true,
    noSilk: true,
    mountBone,
    transforms: mats,
    name: 'tyreNails',
  });
  return g;
}

// ---------------------------------------------------------------------------
// Car 輿
// ---------------------------------------------------------------------------

/**
 * The box the crew stand in: axle, floor, three lacquered panels, the top rail,
 * and the 軾 front bar the driver braces against.
 *
 * Han and Chu differ where it shows in outline. The Han rail sweeps down toward
 * the front so the car reads as a shallow curve; the Chu car is square and
 * carries four corner posts standing proud of the rail, which puts four small
 * verticals into a silhouette that is otherwise all horizontals.
 */
function carBody(ctx: UnitBuildContext, c: Car, han: boolean): PartGroup {
  const P = ctx.parts;
  const g = P.emptyGroup();
  const { hw, hd, floorY, panelTop, R } = c;

  // -- axle 軸 --------------------------------------------------------------
  const axle = P.prim.prism({
    rx0: R * 0.085,
    rx1: R * 0.085,
    y0: -c.track * 1.06,
    y1: c.track * 1.06,
    sides: 6,
    squareness: 0.35,
    name: 'axle',
  });
  axle.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  axle.translate(0, c.axleY, 0);
  g.parts.push(
    P.mkPart(axle, 'timber', 'ochre', 'root', { name: 'axle', rigid: true, mountBone: 'chariot.body' }),
  );
  // Linchpins 轄 at each end of the axle.
  for (const s of [-1, 1]) {
    const pin = P.prim.bevelSlab({
      w: R * 0.05,
      h: R * 0.2,
      d: R * 0.05,
      bevel: R * 0.014,
      name: 'linchpin',
    });
    pin.translate(s * c.track * 1.02, c.axleY + R * 0.1, 0);
    g.parts.push(
      P.mkPart(pin, 'iron', 'metal', 'root', {
        name: 'linchpin',
        rigid: true,
        mountBone: 'chariot.body',
      }),
    );
  }

  // -- floor ---------------------------------------------------------------
  const floor = P.prim.bevelSlab({
    w: hw * 2,
    h: hd * 2,
    d: c.floorThk,
    bevel: R * 0.025,
    name: 'carFloor',
  });
  P.prim.place(floor, { pos: [0, floorY, 0], rot: [Math.PI / 2, 0, 0] });
  g.parts.push(
    P.mkPart(floor, 'timber', 'ochre', 'root', {
      name: 'carFloor',
      rigid: true,
      mountBone: 'chariot.body',
    }),
  );

  // -- side and back panels -------------------------------------------------
  // Grid rows run top → bottom and columns front → back, so the quad winding
  // gives an outward normal on the −X side; the +X panel is the mirror of that
  // geometry, which flips the winding with it.
  const topAt = (u: number): number =>
    han ? panelTop * (0.82 + 0.18 * Math.sin(u * Math.PI * 0.86 + 0.28)) : panelTop;

  const cols = 4;
  const sideGrid = (sx: number): V3[][] => {
    const top: V3[] = [];
    const bot: V3[] = [];
    for (let i = 0; i < cols; i++) {
      const u = i / (cols - 1);
      const z = -hd + u * hd * 2;
      top.push([sx * hw, topAt(u), z]);
      bot.push([sx * hw, floorY, z]);
    }
    return [top, bot];
  };

  const left = P.prim.shell(sideGrid(-1), R * 0.028, { name: 'carSideL' });
  g.parts.push(
    P.mkPart(left, 'lacquer', 'lacquer', 'root', {
      name: 'carSideL',
      rigid: true,
      mountBone: 'chariot.body',
    }),
  );
  g.parts.push(
    P.mkPart(P.prim.mirrorX(left), 'lacquer', 'lacquer', 'root', {
      name: 'carSideR',
      rigid: true,
      mountBone: 'chariot.body',
    }),
  );

  const back: V3[][] = [
    [
      [-hw, topAt(1), hd],
      [0, topAt(1), hd],
      [hw, topAt(1), hd],
    ],
    [
      [-hw, floorY, hd],
      [0, floorY, hd],
      [hw, floorY, hd],
    ],
  ];
  // Rows top→bottom, columns −X→+X gives an outward normal along +Z: the back
  // of the car, which is what we want.
  g.parts.push(
    P.mkPart(P.prim.shell(back, R * 0.028, { name: 'carBack' }), 'lacquer', 'lacquer', 'root', {
      name: 'carBack',
      rigid: true,
      mountBone: 'chariot.body',
    }),
  );

  // -- rails ----------------------------------------------------------------
  for (const s of [-1, 1]) {
    const path: V3[] = [];
    for (let i = 0; i < cols; i++) {
      const u = i / (cols - 1);
      path.push([s * hw, topAt(u) + R * 0.02, -hd + u * hd * 2]);
    }
    g.parts.push(
      P.trim.piping({
        path,
        r: R * 0.048,
        boneHint: 'root',
        mountBone: 'chariot.body',
        cls: 'timber',
        pigment: 'ochre',
        sides: 5,
        name: 'carRail',
      }),
    );
  }
  g.parts.push(
    P.trim.piping({
      path: [
        [-hw, topAt(1) + R * 0.02, hd],
        [0, topAt(1) + R * 0.02, hd],
        [hw, topAt(1) + R * 0.02, hd],
      ],
      r: R * 0.048,
      boneHint: 'root',
      mountBone: 'chariot.body',
      cls: 'timber',
      pigment: 'ochre',
      sides: 5,
      name: 'carRailBack',
    }),
  );

  // 軾 — the front bar. Han's bows forward and dips in the middle so the driver
  // can lean on it; Chu's is straight and sits higher.
  const frontY = topAt(0) + R * 0.02;
  g.parts.push(
    P.trim.piping({
      path: han
        ? [
            [-hw, frontY, -hd],
            [-hw * 0.4, frontY - R * 0.1, -hd - R * 0.1],
            [hw * 0.4, frontY - R * 0.1, -hd - R * 0.1],
            [hw, frontY, -hd],
          ]
        : [
            [-hw, frontY, -hd],
            [0, frontY, -hd],
            [hw, frontY, -hd],
          ],
      r: R * 0.055,
      boneHint: 'root',
      mountBone: 'chariot.body',
      cls: 'timber',
      pigment: 'ochre',
      sides: 5,
      name: 'shiBar',
    }),
  );

  // Uprights between rail and floor, so the car is a frame with panels rather
  // than a solid tub. Han gets two per side, Chu four plus corner posts.
  const uprights = han ? [0.3, 0.7] : [0.18, 0.44, 0.7, 0.94];
  for (const s of [-1, 1]) {
    for (const u of uprights) {
      const post = P.prim.prism({
        rx0: R * 0.035,
        rz0: R * 0.03,
        rx1: R * 0.028,
        rz1: R * 0.026,
        y0: floorY,
        y1: topAt(u),
        sides: 4,
        squareness: 0.5,
        name: 'carPost',
      });
      post.translate(s * hw * 1.01, 0, -hd + u * hd * 2);
      g.parts.push(
        P.mkPart(post, 'timber', 'ochre', 'root', {
          name: 'carPost',
          rigid: true,
          mountBone: 'chariot.body',
        }),
      );
    }
  }

  if (!han) {
    // Chu corner posts, standing proud of the rail with a capped finial: four
    // short verticals at the corners of an otherwise horizontal shape.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const post = P.prim.prism({
          rx0: R * 0.055,
          rz0: R * 0.055,
          rx1: R * 0.04,
          rz1: R * 0.04,
          y0: panelTop - R * 0.1,
          y1: panelTop + R * 0.34,
          sides: 4,
          squareness: 0.6,
          name: 'cornerPost',
        });
        post.translate(sx * hw, 0, sz * hd);
        g.parts.push(
          P.mkPart(post, 'lacquer', 'lacquer', 'root', {
            name: 'cornerPost',
            rigid: true,
            mountBone: 'chariot.body',
          }),
        );
        g.parts.push(
          P.trim.boss({
            at: [sx * hw, panelTop + R * 0.34, sz * hd],
            r: R * 0.07,
            height: R * 0.11,
            boneHint: 'root',
            mountBone: 'chariot.body',
            sides: 6,
          }),
        );
      }
    }
  }

  // Studs on the side panels — Han rounds them, Chu squares them.
  for (const s of [-1, 1]) {
    const studs = P.rivets.rivetLine({
      from: [s * hw * 1.04, (floorY + panelTop) * 0.5, -hd * 0.72],
      to: [s * hw * 1.04, (floorY + panelTop) * 0.5, hd * 0.72],
      count: 5,
      normal: [s, 0, 0],
      boneHint: 'root',
      mountBone: 'chariot.body',
      rivet: { r: R * 0.04, h: R * 0.026 },
      ...(han ? {} : { geometry: P.rivets.studGeometry({ w: R * 0.07, h: R * 0.026 }) }),
      name: 'carStuds',
    });
    mergeInto(g, studs, P);
  }

  g.points.seat = new THREE.Vector3(0, c.floorTop, hd * 0.2);
  g.attach.push({
    name: 'mountSeat',
    bone: 'chariot.body',
    position: [0, c.floorTop, hd * 0.2],
  });
  return g;
}

// ---------------------------------------------------------------------------
// Draught pole 辀 and yoke 衡
// ---------------------------------------------------------------------------

function draughtPole(ctx: UnitBuildContext, c: Car, han: boolean): PartGroup {
  const P = ctx.parts;
  const g = P.emptyGroup();
  const { R, hd, floorY, poleLen, poleTipY, track } = c;
  const tipZ = -hd - poleLen;

  // The pole runs under the floor, out through the front and rises toward the
  // yoke. Four stations, so it has a real bend in it rather than a straight
  // stick sloping upward.
  const pole = P.prim.sweep(
    [
      { p: [0, floorY - R * 0.04, hd * 0.5], rx: R * 0.08, squareness: 0.4 },
      { p: [0, floorY - R * 0.02, -hd], rx: R * 0.075, squareness: 0.4 },
      { p: [0, floorY + (poleTipY - floorY) * 0.42, -hd - poleLen * 0.52], rx: R * 0.062, squareness: 0.4 },
      { p: [0, poleTipY, tipZ], rx: R * 0.05, squareness: 0.4 },
    ],
    { sides: 6, name: 'draughtPole' },
  );
  g.parts.push(
    P.mkPart(pole, 'timber', 'ochre', 'root', {
      name: 'draughtPole',
      rigid: true,
      mountBone: 'chariot.pole',
    }),
  );

  // Yoke 衡 across the pole tip.
  const yoke = P.prim.prism({
    rx0: R * 0.055,
    rz0: R * 0.045,
    rx1: R * 0.055,
    rz1: R * 0.045,
    y0: -track * 0.78,
    y1: track * 0.78,
    sides: han ? 6 : 4,
    squareness: han ? 0.35 : 0.6,
    name: 'yoke',
  });
  yoke.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  yoke.translate(0, poleTipY, tipZ);
  g.parts.push(
    P.mkPart(yoke, 'timber', 'ochre', 'root', {
      name: 'yoke',
      rigid: true,
      mountBone: 'chariot.pole',
    }),
  );

  // Neck forks 軛: Han's curve down and forward around a horse's neck, Chu's
  // are straight bronze-capped struts.
  for (const s of [-1, 1]) {
    if (han) {
      const fork = P.prim.sweep(
        [
          { p: [s * track * 0.46, poleTipY, tipZ], rx: R * 0.038, squareness: 0.4 },
          { p: [s * track * 0.6, poleTipY - R * 0.26, tipZ - R * 0.06], rx: R * 0.032, squareness: 0.4 },
          { p: [s * track * 0.58, poleTipY - R * 0.52, tipZ + R * 0.16], rx: R * 0.026, squareness: 0.4 },
        ],
        { sides: 5, name: 'yokeFork' },
      );
      g.parts.push(
        P.mkPart(fork, 'timber', 'ochre', 'root', {
          name: 'yokeFork',
          rigid: true,
          mountBone: 'chariot.pole',
        }),
      );
    } else {
      const fork = P.prim.strut(
        [s * track * 0.5, poleTipY, tipZ],
        [s * track * 0.64, poleTipY - R * 0.5, tipZ + R * 0.12],
        R * 0.04,
        R * 0.028,
        4,
        0.55,
      );
      g.parts.push(
        P.mkPart(fork, 'timber', 'ochre', 'root', {
          name: 'yokeFork',
          rigid: true,
          mountBone: 'chariot.pole',
        }),
      );
      g.parts.push(
        P.trim.boss({
          at: [s * track * 0.5, poleTipY + R * 0.02, tipZ],
          r: R * 0.06,
          height: R * 0.08,
          boneHint: 'root',
          mountBone: 'chariot.pole',
          sides: 6,
        }),
      );
    }
  }
  g.parts.push(
    P.trim.ferrule({
      at: [0, poleTipY, tipZ + R * 0.06],
      r: R * 0.075,
      height: R * 0.1,
      proud: R * 0.02,
      boneHint: 'root',
      mountBone: 'chariot.pole',
    }),
  );

  // Rein anchors at the yoke. These are the sockets the animator drives the
  // driver's hands toward; the reins drawn below are static geometry between
  // them and his fists.
  const reinL: V3 = [-track * 0.42, poleTipY + R * 0.04, tipZ + R * 0.1];
  const reinR: V3 = [track * 0.42, poleTipY + R * 0.04, tipZ + R * 0.1];
  g.points.reinL = new THREE.Vector3(...reinL);
  g.points.reinR = new THREE.Vector3(...reinR);
  g.attach.push(
    { name: 'reinL', bone: 'chariot.pole', position: reinL },
    { name: 'reinR', bone: 'chariot.pole', position: reinR },
  );
  return g;
}

// ---------------------------------------------------------------------------
// 傘蓋 — canopy
// ---------------------------------------------------------------------------

/**
 * The canopy: a mast rising out of the car floor and a shade on top of it.
 *
 * Both roofs are lofted from the **rim upward**, not from the apex down.
 * `prim.loft` gets its outward winding from the assumption that each successive
 * ring is further along the sweep and therefore higher; feed it a dome from the
 * top down and every face on it points inward.
 *
 * Han flies a round 傘蓋 parasol with a scalloped rim and one finial. Chu carries
 * a square canopy whose four corners sweep upward, each capped with its own
 * finial. From above, one is a disc and the other a lozenge; from the side, one
 * is a shallow arc and the other a notched trapezoid.
 */
function canopy(ctx: UnitBuildContext, c: Car, han: boolean): PartGroup {
  const P = ctx.parts;
  const g = P.emptyGroup();
  const { R, canopyR: cr, canopyZ: cz, canopyH, canopyDrop: drop, floorY } = c;
  const topY = floorY + canopyH;

  const mast = P.prim.prism({
    rx0: R * 0.055,
    rz0: R * 0.055,
    rx1: R * 0.032,
    rz1: R * 0.032,
    y0: floorY,
    y1: topY,
    sides: 6,
    phase: Math.PI / 6,
    squareness: 0.35,
    name: 'canopyMast',
  });
  mast.translate(0, 0, cz);
  g.parts.push(
    P.mkPart(mast, 'timber', 'ochre', 'root', {
      name: 'canopyMast',
      rigid: true,
      mountBone: 'chariot.canopy',
    }),
  );

  const segs = 16;
  const levels = 4;
  const rings: V3[][] = [];
  for (let l = 0; l < levels; l++) {
    // l = 0 is the rim, l = levels-1 the apex: rings must climb for the loft to
    // wind outward.
    const t = 1 - l / (levels - 1);
    const row: V3[] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      let rr: number;
      let y = topY - t * t * drop;
      if (han) {
        // Scalloped rim: alternate segments pull in, so the edge is a row of
        // petals rather than a circle.
        rr = cr * t * (i % 2 === 0 ? 1.0 : 0.91);
      } else {
        // Square plan: a radius of 1/max(|cos|,|sin|) traces a square exactly,
        // and at sixteen segments the four corners land on i = 2, 6, 10, 14
        // (45°, 135°, …) — the *diagonals*, not the edge midpoints at i = 0.
        // Getting that index wrong lifts the middle of each side instead and
        // the canopy comes out as a bat rather than a roof.
        const sq = 1 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
        rr = cr * t * sq;
        if (i % 4 === 2) y += t * t * drop * 0.55;
      }
      row.push([Math.cos(a) * rr, y, cz + Math.sin(a) * rr]);
    }
    rings.push(row);
  }
  const dome = P.prim.loft(rings, { capStart: false, capEnd: true, name: 'canopy' });
  g.parts.push(
    P.mkPart(dome, 'cloth', 'cloth', 'root', {
      name: 'canopy',
      rigid: true,
      mountBone: 'chariot.canopy',
    }),
  );

  // Ribs 蓋弓 *under* the shade: eight radial for the round parasol, four along
  // the diagonals for the square one, where the corner lift needs supporting.
  //
  // The tilt has to follow the cloth. The dome falls `drop` over `cr`, so its
  // surface lies atan(drop/cr) *below* horizontal, and the rib is rotated about
  // Z by π/2 + that angle. Rotating by π/2 − it instead — the obvious sign
  // slip — leaves eight spars radiating upward out of the finial like a
  // starburst, well clear of the canopy they are supposed to hold up.
  const ribCount = han ? 8 : 4;
  const ribLen = han ? cr * 0.99 : cr * 1.4;
  const ribDrop = han ? Math.atan(drop / cr) : Math.atan((drop * 0.45) / (cr * 1.414));
  const rib = P.prim.prism({
    rx0: cr * 0.014,
    rz0: cr * 0.011,
    rx1: cr * 0.008,
    rz1: cr * 0.007,
    y0: 0,
    y1: ribLen,
    sides: 4,
    name: 'canopyRib',
  });
  const ribMats: THREE.Matrix4[] = [];
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < ribCount; i++) {
    const a = (i / ribCount) * Math.PI * 2 + (han ? 0 : Math.PI / 4);
    // Build along +Y, tip it down to the canopy's own slope, then swing it
    // around the mast. 'YXZ' applies Z first, so the tilt happens in the rib's
    // own plane before the yaw carries it around; a plain XYZ order would shear.
    ribMats.push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(0, topY - cr * 0.05, cz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -a, Math.PI / 2 + ribDrop, 'YXZ')),
        one,
      ),
    );
  }
  g.instanced.push({
    geometry: rib,
    cls: 'timber',
    pigment: 'ochre',
    boneHint: 'root',
    rigid: true,
    mountBone: 'chariot.canopy',
    transforms: ribMats,
    name: 'canopyRibs',
  });

  // Finials: one for Han, five for Chu (centre plus a corner each).
  const finial = (at: V3, r: number, height: number) =>
    g.parts.push(
      P.trim.boss({
        at,
        r,
        height,
        boneHint: 'root',
        mountBone: 'chariot.canopy',
        sides: 8,
      }),
    );
  finial([0, topY + cr * 0.02, cz], cr * 0.09, cr * 0.16);
  if (!han) {
    // One on each swept corner — same 45° diagonals the roof corners sit on, at
    // the square's corner radius (√2 · cr) and the height the corner lift ends.
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i / 4) * Math.PI * 2;
      finial(
        [
          Math.cos(a) * cr * 1.4,
          topY - drop * 0.45,
          cz + Math.sin(a) * cr * 1.4,
        ],
        cr * 0.055,
        cr * 0.15,
      );
    }
  }

  // Corner tassels hanging off the rim — soft, and they break a large flat
  // horizontal that would otherwise sit in one band of the ramp.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + (han ? Math.PI / 4 : 0);
    const rr = han ? cr * 0.96 : cr * 1.0;
    mergeInto(
      g,
      P.trim.tassel({
        at: [Math.cos(a) * rr, topY - drop * 0.94, cz + Math.sin(a) * rr],
        length: cr * 0.3,
        r: cr * 0.07,
        strands: 5,
        boneHint: 'root',
        mountBone: 'chariot.canopy',
      }),
      P,
    );
  }

  g.points.canopyTop = new THREE.Vector3(0, topY + cr * 0.18, cz);
  return g;
}

// ---------------------------------------------------------------------------
// 御者 — the driver
// ---------------------------------------------------------------------------

/**
 * Bind-pose offsets that close both fists on the reins: elbows down and a
 * little forward, forearms level and reaching out over the 軾.
 *
 * Directions are unit vectors out of each joint, scaled by the rig's own bone
 * lengths, so the posed skeleton keeps its bind lengths exactly — the animator
 * normalises clips against `rig.bindLengths`, and a bind pose that quietly
 * shortened a forearm would retarget every clip wrong. `+X` means outward from
 * the body; the left arm mirrors X.
 */
function reinPose(rig: Rig): NonNullable<RigOptions['offsets']> {
  const m = rig.metrics;
  const B = rig.bindWorld;
  const out: NonNullable<RigOptions['offsets']> = {};
  const upper: V3 = [0.14, -0.9, -0.41];
  const fore: V3 = [-0.1, 0.16, -0.98];
  for (const S of ['L', 'R'] as const) {
    const s = S === 'L' ? -1 : 1;
    const shoulder = v3(B[`upperArm${S}`]);
    const elbow = step(shoulder, unit([upper[0] * s, upper[1], upper[2]]), m.upperArmLen);
    const wrist = step(elbow, unit([fore[0] * s, fore[1], fore[2]]), m.foreArmLen);
    const e0 = B[`foreArm${S}`];
    const w0 = B[`hand${S}`];
    const dE: V3 = [elbow[0] - e0.x, elbow[1] - e0.y, elbow[2] - e0.z];
    out[`foreArm${S}` as BoneName] = dE;
    out[`hand${S}` as BoneName] = [
      wrist[0] - w0.x - dE[0],
      wrist[1] - w0.y - dE[1],
      wrist[2] - w0.z - dE[2],
    ];
  }
  return out;
}

function driver(ctx: UnitBuildContext, rig: Rig, c: Car, han: boolean): PartGroup {
  const P = ctx.parts;
  const g = P.emptyGroup();
  const m = rig.metrics;
  const B = rig.bindWorld;
  const h = m.height;

  const fig = P.body.figure({
    metrics: m,
    bind: B,
    torsoPigment: 'cloth',
    torsoCls: 'cloth',
    bootShaft: 0.3,
    beard: 'none',
    deltoid: false,
    handPose: 'fist',
  });
  // Reins run fore-and-aft through both fists, so both hands turn about their
  // own grips until the bore points forward.
  rotateFist(fig, 'R', [-1.24, 0, -0.16]);
  rotateFist(fig, 'L', [-1.24, 0, 0.16]);
  mergeInto(g, fig, P);

  // Short tunic (robe = 0.36) and a sash.
  g.parts.push(
    P.cloth.skirt({
      topY: m.waistY + m.torsoLen * 0.03,
      hemY: m.hipY - m.legLen * 0.34,
      rTop: m.waistWidth * 0.62,
      rHem: m.hipWidth * 0.9,
      squash: 0.84,
      folds: 8,
      foldDepth: 0.16,
    }),
  );
  mergeInto(
    g,
    P.cloth.sash({
      y: m.waistY,
      rx: m.waistWidth * 0.6,
      rz: m.waistDepth * 0.68,
      height: m.torsoLen * 0.12,
      tail: m.torsoLen * 0.34,
    }),
    P,
  );

  // armour = 0.55: cuirass, pauldrons and a light armoured skirt. Row counts
  // are kept under the factory's instancing threshold on purpose — a 22-plate
  // band is baked into the mesh it shares a material with and costs no extra
  // draw call, and there are two crew and two wheels already competing for them.
  mergeInto(
    g,
    P.lamellar.cuirass({
      fromY: m.waistY - m.torsoLen * 0.12,
      toY: m.shoulderY + m.torsoLen * 0.02,
      rx0: m.waistWidth * 0.6,
      rx1: m.chestWidth * 0.62,
      depthRatio: 0.74,
      rows: 4,
      perRow: 11,
      cord: true,
    }),
    P,
  );
  mergeInto(
    g,
    P.lamellar.skirtArmour({
      topY: m.waistY - m.torsoLen * 0.08,
      bottomY: m.hipY - m.legLen * 0.22,
      rxTop: m.hipWidth * 0.64,
      rxBottom: m.hipWidth * 0.86,
      rows: 2,
      perRow: 11,
      frontGap: 0.6,
      cord: false,
    }),
    P,
  );
  for (const S of ['L', 'R'] as const) {
    mergeInto(
      g,
      P.lamellar.pauldron({
        side: S,
        shoulder: v3(B[`upperArm${S}`]),
        r: m.upperArmR * 2.5,
        rows: 3,
        perRow: 5,
      }),
      P,
    );
  }

  // Head: the low fan crown with its flat vertical fan crest — this unit's
  // crown tag, and the only vertical accent on the crew.
  const helm = P.helmet.helmet({
    style: 'fanCrown',
    baseY: B.head.y,
    headLen: m.headLen,
    headWidth: m.headWidth,
    headDepth: m.headDepth,
    z: B.head.z,
    cheeks: true,
  });
  mergeInto(g, helm, P);
  mergeInto(
    g,
    P.helmet.crest({
      style: 'fanCrest',
      at: v3(helm.points.crest),
      height: m.headLen * ctx.spec.design.crown.crestScale,
      width: m.headWidth * (han ? 1.05 : 0.86),
    }),
    P,
  );

  // Quiver on his back, 劍 at his hip.
  const quiverAt: V3 = [
    B.spine02.x + m.chestWidth * 0.36,
    B.spine02.y - m.torsoLen * 0.36,
    B.spine02.z + m.chestDepth * 0.66,
  ];
  mergeInto(
    g,
    P.weapons.quiver({
      grip: quiverAt,
      rot: [-0.28, 0, -0.24],
      bone: 'spine02',
      length: h * 0.3,
      r: h * 0.036,
      arrows: 6,
    }),
    P,
  );
  g.attach.push({ name: 'back', bone: 'spine02', position: quiverAt });

  const hipAt: V3 = [
    B.pelvis.x - m.hipWidth * 0.68,
    B.pelvis.y + m.torsoLen * 0.02,
    B.pelvis.z + m.hipDepth * 0.2,
  ];
  mergeInto(
    g,
    P.weapons.scabbard({
      grip: hipAt,
      rot: [0.22, 0, 0.36],
      bone: 'pelvis',
      length: h * 0.28,
      width: h * 0.034,
    }),
    P,
  );
  g.attach.push({ name: 'hip', bone: 'pelvis', position: hipAt });

  // The 弓, cased along the inside of the left rail. `design.primary` is a bow
  // and a charioteer who is driving cannot also be shooting, so it is racked
  // where a 車左 would reach for it rather than left in a hand that is full.
  const railY = c.panelTop * 0.78;
  mergeInto(
    g,
    P.weapons.bow({
      grip: [-c.hw * 0.9, railY, c.hd * 0.1],
      rot: [Math.PI / 2, 0, 0.16],
      bone: 'root',
      mountBone: 'chariot.body',
      length: h * 0.92,
      depth: h * 0.13,
      strung: false,
      pigment: 'ochre',
    }),
    P,
  );
  for (const z of [-c.hd * 0.34, c.hd * 0.5]) {
    g.parts.push(
      P.rivets.cordLoop({
        at: [-c.hw * 0.94, railY, z],
        r: c.R * 0.06,
        thickness: c.R * 0.015,
        boneHint: 'root',
        rot: [0, 0, Math.PI / 2],
      }),
    );
  }
  // `cordLoop` has no mountBone hook, so pin the two loops by hand.
  for (const p of g.parts) if (p.name === 'cordLoop') p.mountBone = 'chariot.body';

  // Reins: yoke to fists. Static geometry — they do not follow an IK'd hand,
  // which is a real limitation and the reason `reinL`/`reinR` exist as sockets.
  const gripR = fig.points.gripR;
  const gripL = fig.points.gripL;
  const tipZ = -c.hd - c.poleLen;
  for (const S of ['L', 'R'] as const) {
    const s = S === 'L' ? -1 : 1;
    const hand = S === 'L' ? gripL : gripR;
    if (!hand) continue;
    const anchor: V3 = [s * c.track * 0.42, c.poleTipY + c.R * 0.04, tipZ + c.R * 0.1];
    g.parts.push(
      P.trim.piping({
        path: [
          anchor,
          lerp3(anchor, v3(hand), 0.45),
          lerp3(anchor, v3(hand), 0.8),
          v3(hand),
        ],
        r: c.R * 0.016,
        boneHint: 'root',
        mountBone: 'chariot.body',
        cls: 'leather',
        pigment: 'leather',
        sides: 4,
        name: 'rein',
      }),
    );
  }
  return g;
}

// ---------------------------------------------------------------------------
// 車右 — the halberdier
// ---------------------------------------------------------------------------

interface CrewOpts {
  /** Where his feet stand, rig space. */
  at: V3;
  /** Stature relative to the driver. */
  k: number;
  /** The driver's metrics — every station below is derived from them. */
  m: RigMetrics;
  /** The driver's origin height, i.e. the floor his stations are measured from. */
  feetY: number;
  mountBone: string;
  han: boolean;
}

/**
 * The second crewman, built from the driver's own metrics and bound rigidly to
 * `chariot.warrior`.
 *
 * Stations are mapped with `S()`: subtract the driver's origin to get a height
 * above his feet, scale by `k`, add back the halberdier's own floor. That is
 * exact rather than approximate, because `computeMetrics` adds the origin to
 * every station and is otherwise linear in stature — so the two men share one
 * set of proportions and differ only in size, which is what "use the shared rig
 * for the crew at reduced scale" has to mean when there is only one skeleton.
 */
function halberdier(ctx: UnitBuildContext, o: CrewOpts): { group: PartGroup; haftTip: V3 } {
  const P = ctx.parts;
  const g = P.emptyGroup();
  const m = o.m;
  const k = o.k;
  const [cx, , cz] = o.at;
  /** Map one of the driver's absolute stations onto the halberdier. */
  const S = (y: number): number => o.at[1] + (y - o.feetY) * k;
  /** Map one of the driver's lengths. */
  const L = (x: number): number => x * k;

  const hipY = S(m.hipY);
  const waistY = S(m.waistY);
  const chestY = S(m.chestY);
  const shoulderY = S(m.shoulderY);
  const ankleY = S(m.ankleY);
  const headY = S(m.headY);
  const headLen = L(m.headLen);
  const hipW = L(m.hipWidth);
  const shoulderW = L(m.shoulderWidth);

  // -- braced stance --------------------------------------------------------
  // Feet apart and staggered: he is standing in a moving box, and a symmetric
  // stance on a vehicle reads as a shop mannequin.
  const stance = L(m.stanceWidth) * 0.62;
  const feet: Record<'L' | 'R', V3> = {
    L: [cx - stance, ankleY, cz - L(m.legLen) * 0.2],
    R: [cx + stance * 0.86, ankleY, cz + L(m.legLen) * 0.14],
  };
  const shoulders: Record<'L' | 'R', V3> = {
    L: [cx - shoulderW * 0.5, shoulderY, cz],
    R: [cx + shoulderW * 0.5, shoulderY, cz],
  };

  // -- torso, neck, head ----------------------------------------------------
  g.parts.push(
    P.body.torso({
      hipY,
      waistY,
      chestY,
      shoulderY,
      hipWidth: hipW,
      waistWidth: L(m.waistWidth),
      chestWidth: L(m.chestWidth),
      shoulderWidth: shoulderW,
      hipDepth: L(m.hipDepth),
      waistDepth: L(m.waistDepth),
      chestDepth: L(m.chestDepth),
      neckR: L(m.neckR),
      pigment: 'cloth',
      cls: 'cloth',
    }),
  );
  // The torso is authored about x = 0; slide it and everything else that is
  // built from bare stations onto his standing position.
  const toStation = new THREE.Matrix4().makeTranslation(cx, 0, cz);
  g.parts[g.parts.length - 1].geometry.applyMatrix4(toStation);

  const neck = P.body.neck({ fromY: shoulderY, toY: headY + headLen * 0.08, r: L(m.neckR) });
  neck.geometry.applyMatrix4(toStation);
  g.parts.push(neck);

  const head = P.body.head({
    baseY: headY,
    length: headLen,
    width: L(m.headWidth),
    depth: L(m.headDepth),
    beard: 'short',
  });
  for (const p of head.parts) p.geometry.applyMatrix4(toStation);
  mergeInto(g, head, P);

  const helm = P.helmet.helmet({
    style: o.han ? 'hanDoumou' : 'chuPeaked',
    baseY: headY,
    headLen,
    headWidth: L(m.headWidth),
    headDepth: L(m.headDepth),
    cheeks: true,
    nape: true,
    rivets: o.han,
  });
  for (const p of helm.parts) p.geometry.applyMatrix4(toStation);
  for (const p of helm.instanced) for (const t of p.transforms) t.premultiply(toStation);
  mergeInto(g, helm, P);

  // -- legs and arms --------------------------------------------------------
  const tKnee = L(m.thighLen) / Math.max(1e-6, L(m.thighLen) + L(m.shinLen));
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? -1 : 1;
    const hip: V3 = [cx + s * hipW * 0.5, hipY, cz];
    const ankle = feet[side];
    const knee = lerp3(hip, ankle, tKnee);
    knee[2] -= L(m.thighLen) * 0.12; // pre-broken knee, forward
    mergeInto(
      g,
      P.body.leg({
        side,
        hip,
        knee,
        ankle,
        thighR: L(m.thighR),
        shinR: L(m.shinR),
      }),
      P,
    );
    mergeInto(
      g,
      P.body.boot({
        side,
        ankle,
        length: L(m.footLen),
        width: L(m.footLen) * 0.42,
        shaft: 0.3,
      }),
      P,
    );
  }

  // Right arm carries the 戟 at chest height; the left braces on the side rail.
  const arms: Record<'L' | 'R', [V3, V3]> = {
    R: [
      [0.16, -0.94, -0.3],
      [-0.2, 0.4, -0.89],
    ],
    L: [
      [0.42, -0.87, -0.26],
      [0.5, -0.7, -0.51],
    ],
  };
  const wrists = {} as Record<'L' | 'R', V3>;
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? -1 : 1;
    const [u0, f0] = arms[side];
    const elbow = step(shoulders[side], unit([u0[0] * s, u0[1], u0[2]]), L(m.upperArmLen));
    const wrist = step(elbow, unit([f0[0] * s, f0[1], f0[2]]), L(m.foreArmLen));
    wrists[side] = wrist;
    mergeInto(
      g,
      P.body.arm({
        side,
        shoulder: shoulders[side],
        elbow,
        wrist,
        upperR: L(m.upperArmR),
        foreR: L(m.foreArmR),
        deltoid: false,
      }),
      P,
    );
    const hand = P.body.hand({
      side,
      wrist,
      length: L(m.handLen),
      r: L(m.handR),
      pose: 'fist',
    });
    // The 戟 is raked; the fist that holds it turns with it.
    if (side === 'R') rotateFist(hand, 'R', [-1.15, 0, -0.3]);
    else rotateFist(hand, 'L', [-1.4, 0, 0]);
    const grip = hand.points[`grip${side}`];
    if (grip) wrists[side] = [grip.x, grip.y, grip.z];
    mergeInto(g, hand, P);
  }

  // -- light harness --------------------------------------------------------
  mergeInto(
    g,
    P.lamellar.cuirass({
      fromY: waistY - L(m.torsoLen) * 0.12,
      toY: shoulderY + L(m.torsoLen) * 0.02,
      rx0: L(m.waistWidth) * 0.6,
      rx1: L(m.chestWidth) * 0.62,
      depthRatio: 0.74,
      rows: 4,
      perRow: 11,
      cord: true,
    }),
    P,
  );
  g.parts.push(
    P.cloth.skirt({
      topY: waistY + L(m.torsoLen) * 0.03,
      hemY: hipY - L(m.legLen) * 0.36,
      rTop: L(m.waistWidth) * 0.62,
      rHem: hipW * 0.92,
      squash: 0.84,
      folds: 8,
      foldDepth: 0.16,
    }),
  );
  // The cuirass and skirt are also authored about x = 0.
  for (const p of g.parts) {
    if (p.name === 'skirt') p.geometry.applyMatrix4(toStation);
  }
  for (const inst of g.instanced) {
    if (inst.name?.startsWith('cuirass')) {
      for (const t of inst.transforms) t.premultiply(toStation);
    }
  }

  // -- 戟 -------------------------------------------------------------------
  // Levelled forward over the team rather than carried upright: under a canopy
  // only two thirds of a stature above the crew's heads there is no room for a
  // vertical polearm, and a 戟 raked forward is the charging-chariot posture
  // anyway. The rake is chosen so the head passes outside the canopy rim.
  const ji = P.weapons.ji({
    grip: wrists.R,
    rot: [-1.15, 0, -0.3],
    bone: 'handR',
    mountBone: o.mountBone,
    length: L(m.height) * 1.5,
    gripAt: 0.4,
    shaftR: L(m.height) * 0.013,
    bladeLength: L(m.height) * 0.24,
    headLength: L(m.height) * 0.2,
  });
  const tip = ji.points.tip.clone();
  mergeInto(g, ji, P);

  pinTo(g, o.mountBone);
  return { group: g, haftTip: [tip.x, tip.y, tip.z] };
}

// ---------------------------------------------------------------------------

registerUnit(PieceType.Chariot, buildChariot);
