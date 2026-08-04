/**
 * 砲 — the stone-throwing engine.
 *
 * The 砲 predates gunpowder by a thousand years: it is a *trebuchet*, and the
 * character's 石 radical says so. So there is no barrel here. There is a timber
 * A-frame on a sled, a beam pivoting on an iron axle, a sling with a stone in
 * it, and a crew.
 *
 * SILHOUETTE. One long diagonal crossing a triangle, low and very wide. Nothing
 * else on the board has a straight line running corner to corner through it, so
 * the beam is deliberately over-length and the frame deliberately squat: the
 * read is *machine*, at a glance, from any azimuth. The crew stand wide of the
 * frame rather than behind it, which keeps two upright human strokes outside the
 * machine's outline instead of buried in it, and the hooded head is the crown
 * tag that separates the 砲 from the 車 when both are reduced to black shapes.
 *
 * TWO ARMIES, TWO MACHINES. This is not a recolour:
 *
 *   漢  人力砲 — traction. Four splayed legs meeting at a lashed apex, X-braced
 *       on each side: a pure triangle in profile. The short arm ends in a
 *       spreader bar with a fan of haul ropes, and two crewmen haul them down.
 *       No counterweight anywhere on the machine.
 *   楚  配重砲 — counterweight. A boxed tower of four battered posts under a
 *       head beam, with long raking shores from both ends of the sled: a
 *       rectangle with two external diagonals. A plank-built, iron-strapped
 *       weight box swings from the short arm on iron links, and the crew wind
 *       the throwing arm down on a windlass instead of hauling.
 *
 * Both read as the same *weapon* and neither reads as the other's mesh tinted.
 *
 * JOINERY. Every timber-to-timber junction is a real joint, because a stack of
 * glued boxes reads as a prop and a pegged frame reads as something a carpenter
 * built. Cross ties pass clean through the sled runners and show a reduced tenon
 * with a hard shoulder on the far side, pegged. Frame legs are tenoned into the
 * runners and pegged through. The apex is bound with wound rope over the axle
 * bolster, and the axle pin is a real pin with a head, a washer and a cotter.
 * All the pegs in one unit are a single instanced geometry, so the whole
 * vocabulary costs about nine hundred triangles and no extra draw call.
 *
 * WHAT THE ANIMATOR GETS
 *   `treb.pivot`   the fixed bearing at the apex.
 *   `treb.beam`    the throwing beam, built in the **loaded** pose: at
 *                  `rotation.x = 0` the sling is already lying in the trough
 *                  with the stone on the boards, which is where a wound engine
 *                  sits. Rotating about +X is the throw, and the sign matters —
 *                  the sling end starts *behind* the pivot, so a **negative**
 *                  `rotation.x` sweeps it up and forward over the axle and a
 *                  positive one presses it further down. `userData` carries
 *                  `armLength`, `buttLength`, `armAngle` (the beam's rake at
 *                  rest), `throwSign` and `releaseAngle` — the `rotation.x` at
 *                  which the pouch has passed the pivot and should let go.
 *   `treb.sling`   the sling head, a child of the beam. It carries the pouch,
 *                  the stone and the `muzzle` socket, so the projectile origin
 *                  travels the release arc for free.
 *   `treb.weight`  (Chu) the swinging weight box, a child of the beam.
 *   `treb.yoke`    (Han) the haul-rope spreader, a child of the beam.
 *   `treb.windlass`(Chu) the winding drum; its two lever arms carry the crew.
 *   `treb.haulA.L/R`, `treb.haulB.L/R`
 *                  the four rope (Han) or lever (Chu) grips, one per crew hand,
 *                  parented to whichever member actually moves them. The A pair
 *                  is also published as the `reinL`/`reinR` sockets — that is
 *                  the existing "hand IK to a cord" socket and the animator's
 *                  hands should be locked to it. Crew B is rigid geometry on
 *                  `crew.*` bones and his fists are already on the rope in bind
 *                  pose; his anchors are the B pair.
 *   `muzzle`       the stone's centre in the pouch.
 *
 * Crew A rides the shared humanoid rig, and his bind pose is *authored*: the
 * forearm and hand bind offsets put both fists on the haul rope, hand over
 * hand, before a single clip runs. The rope is then routed through the grip
 * points the fists actually published, so it threads the bored fist rather than
 * passing near it. Crew B is a second figure — the shared rig cannot be two
 * people — built from the same parts and baked rigid onto nine `crew.*` mount
 * bones, so he is posed, cheap, and still animatable at the joints.
 */

import * as THREE from 'three';
import { BONE_ORDER, type BoneName } from '@core/contracts.ts';
import { PieceType, Side } from '@core/types.ts';
import { registerUnit, type UnitBuildContext } from '@characters/factory.ts';
import type { InstancedPart, PartGroup, PartPigment, V2, V3 } from '@characters/parts/types.ts';

type Parts = UnitBuildContext['parts'];
type Rng = UnitBuildContext['rng'];
type Rig = UnitBuildContext['rig'];
type Metrics = Rig['metrics'];
type Bind = Rig['bindWorld'];
type RigOpts = Parameters<UnitBuildContext['useRig']>[0];
type Offsets = NonNullable<RigOpts['offsets']>;

/**
 * Substances that are the same in both armies get a literal pigment, per the
 * unit contract. Oak is oak and hemp is hemp; the armies differ in what is
 * lacquered, dyed and forged, which is where the palette slots are used.
 */
const TIMBER: PartPigment = 'ochre';
const ROPE: PartPigment = 'ochre';
const STONE: PartPigment = 'stone';

const UP = new THREE.Vector3(0, 1, 0);

// ===========================================================================
// Layout
// ===========================================================================

/**
 * Every dimension of the machine in one record, all in rig units derived from
 * the crew's stature `h`. Keeping it in one place is what makes the two armies
 * comparable: the frames differ, the envelope does not.
 */
interface Layout {
  h: number;
  chu: boolean;
  /** Top surface of the sled runners — the ground plane of the machine. */
  deckY: number;
  runnerX: number;
  runnerHW: number;
  runnerHH: number;
  sledF: number;
  sledB: number;
  /** Axle centre. */
  pivot: V3;
  /** Rest elevation of the beam: the long arm points back and down by this. */
  armAngle: number;
  armLen: number;
  buttLen: number;
  beamHW: number;
  beamHH: number;
  armTip: V3;
  buttTip: V3;
  /** Pouch centre and the stone's radius. */
  pouch: V3;
  stoneR: number;
  /** Where the two crew stand, on the ground beside the sled. */
  crewA: V3;
  crewB: V3;
  /** Height of the pennant staff's tip: the top of the whole silhouette. */
  mastTop: number;
}

function layout(h: number, side: Side): Layout {
  const chu = side === Side.Black;
  const armAngle = 0.355;
  const armLen = 1.18 * h;
  const buttLen = 0.62 * h;
  const pivot: V3 = [0, 1.02 * h, -0.14 * h];
  const ca = Math.cos(armAngle);
  const sa = Math.sin(armAngle);
  const armTip: V3 = [0, pivot[1] - sa * armLen, pivot[2] + ca * armLen];
  const buttTip: V3 = [0, pivot[1] + sa * buttLen, pivot[2] - ca * buttLen];

  return {
    h,
    chu,
    deckY: 0.116 * h,
    runnerX: 0.4 * h,
    runnerHW: 0.052 * h,
    runnerHH: 0.058 * h,
    // The sled is deliberately not symmetric about the axle: the trough behind
    // the pivot has to be long enough for the loaded sling to lie in it, which
    // is also what gives the unit its horizontal read.
    sledF: -1.0 * h,
    sledB: 1.3 * h,
    pivot,
    armAngle,
    armLen,
    buttLen,
    // Deliberately heavy. The beam is the unit's one long diagonal and the
    // silhouette contract rests on it, so it is sized to survive the far rank
    // rather than to be structurally minimal.
    beamHW: 0.058 * h,
    beamHH: 0.075 * h,
    armTip,
    buttTip,
    // The loaded sling lies back along the trough with the stone on the boards.
    pouch: [0, 0.3 * h, 1.158 * h],
    stoneR: 0.13 * h,
    // Han haulers stand wide and forward of the frame, under the rope fan; Chu
    // winders stand aft at the windlass levers. Either way they are outside the
    // sled in plan, so they read as separate strokes in silhouette instead of
    // dissolving into the frame.
    // Han haulers stand directly under the rope fan at the bow, clear of the
    // frame's front legs, so in profile they are two separate upright strokes
    // instead of a thickening of the frame. Chu winders stand aft at the bars.
    crewA: chu ? [0.6 * h, 0, 0.78 * h] : [0.58 * h, 0, -0.71 * h],
    crewB: chu ? [-0.6 * h, 0, 0.8 * h] : [-0.62 * h, 0, -0.82 * h],
    mastTop: 1.36 * h,
  };
}

// ===========================================================================
// Timber
// ===========================================================================

/**
 * A sawn baulk's cross-section: a rectangle with its four arrises chamfered.
 * The chamfer is not decoration — under a three-band timber ramp it is the only
 * thing that puts a light edge on a dark face, and it is what separates a piece
 * of framing from an extruded rectangle.
 *
 * Counter-clockwise in the sweep's (right, up) plane, matching `prim.ring`.
 */
function baulkSection(hw: number, hh: number, chamfer: number): V2[] {
  const c = Math.max(1e-5, Math.min(chamfer, Math.min(hw, hh) * 0.42));
  return [
    [hw, -hh + c],
    [hw, hh - c],
    [hw - c, hh],
    [-hw + c, hh],
    [-hw, hh - c],
    [-hw, -hh + c],
    [-hw + c, -hh],
    [hw - c, -hh],
  ];
}

interface Station {
  p: V3;
  /** Half-width across the sweep's right axis. */
  hw: number;
  /** Half-height across the sweep's up axis. */
  hh: number;
  chamfer?: number;
}

/** A run of timber through a list of stations, section by section. */
function baulk(P: Parts, stations: Station[], name: string, up?: V3): THREE.BufferGeometry {
  return P.prim.sweep(
    stations.map((s) => ({
      p: s.p,
      rx: s.hw,
      rz: s.hh,
      section: baulkSection(s.hw, s.hh, s.chamfer ?? Math.min(s.hw, s.hh) * 0.26),
    })),
    { sides: 8, capStart: true, capEnd: true, name, ...(up ? { up } : {}) },
  );
}

/** A straight baulk between two points. */
function strutBaulk(
  P: Parts,
  a: V3,
  b: V3,
  hw: number,
  hh: number,
  name: string,
): THREE.BufferGeometry {
  return baulk(P, [{ p: a, hw, hh }, { p: b, hw, hh }], name);
}

const lerp3 = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/**
 * A member that passes clean through two hosts and shows a reduced tenon with a
 * hard shoulder on each far side — a through mortise and tenon, the joint that
 * held every timber engine together before iron bolts.
 *
 * `tA`/`tB` are the parameters along a→b at which the hosts' outer faces sit.
 * The shoulder is a pair of stations a hair apart, which is what makes it a
 * step in the surface rather than a taper.
 */
function throughTenon(
  P: Parts,
  a: V3,
  b: V3,
  tA: number,
  tB: number,
  body: { hw: number; hh: number },
  tenon: { hw: number; hh: number },
  name: string,
): THREE.BufferGeometry {
  const eps = 0.004;
  return baulk(
    P,
    [
      { p: a, hw: tenon.hw, hh: tenon.hh },
      { p: lerp3(a, b, tA), hw: tenon.hw, hh: tenon.hh },
      { p: lerp3(a, b, tA + eps), hw: body.hw, hh: body.hh },
      { p: lerp3(a, b, tB - eps), hw: body.hw, hh: body.hh },
      { p: lerp3(a, b, tB), hw: tenon.hw, hh: tenon.hh },
      { p: b, hw: tenon.hw, hh: tenon.hh },
    ],
    name,
  );
}

/**
 * The common case: a member lying athwart the machine, spanning ±`half` to the
 * outer faces of its two hosts, with its tenons standing `proud` beyond them.
 * Every cross member on this unit is one of these.
 */
function athwartTenon(
  P: Parts,
  half: number,
  proud: number,
  yy: number,
  zz: number,
  body: { hw: number; hh: number },
  tenon: { hw: number; hh: number },
  name: string,
): THREE.BufferGeometry {
  const t = proud / (2 * (half + proud));
  return throughTenon(P, [-(half + proud), yy, zz], [half + proud, yy, zz], t, 1 - t, body, tenon, name);
}

/**
 * Rope binding — turns of cord wound round a joint. Built as one continuous
 * helix rather than a stack of rings, so the turns actually climb the way a
 * lashing does; `rx`/`rz` let the wrap be an oval so it can bind two timbers
 * lying side by side.
 */
function lashing(
  P: Parts,
  o: {
    centre: V3;
    axis: V3;
    rx: number;
    rz: number;
    turns: number;
    pitch: number;
    cordR: number;
  },
): THREE.BufferGeometry {
  const A = new THREE.Vector3(...o.axis).normalize();
  const seed = Math.abs(A.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : UP;
  const U = new THREE.Vector3().crossVectors(seed, A).normalize();
  const V = new THREE.Vector3().crossVectors(A, U).normalize();
  const perTurn = 7;
  const n = Math.max(2, Math.round(o.turns * perTurn));
  const stations = [];
  for (let i = 0; i <= n; i++) {
    const t = i / perTurn;
    const th = t * Math.PI * 2;
    const d = (t - o.turns / 2) * o.pitch;
    stations.push({
      p: [
        o.centre[0] + A.x * d + U.x * o.rx * Math.cos(th) + V.x * o.rz * Math.sin(th),
        o.centre[1] + A.y * d + U.y * o.rx * Math.cos(th) + V.y * o.rz * Math.sin(th),
        o.centre[2] + A.z * d + U.z * o.rx * Math.cos(th) + V.z * o.rz * Math.sin(th),
      ] as V3,
      rx: o.cordR,
      squareness: 0.25,
    });
  }
  return P.prim.sweep(stations, { sides: 4, name: 'lashing' });
}

/**
 * A river cobble, and never a lathe: a rotationally symmetric stone reads as a
 * ball, and this one is on screen at arm's length during the capture beat. Rings
 * are jittered per vertex from the unit's seeded stream, so every stone in the
 * build is a different rock and the same rock on every run.
 */
function boulder(P: Parts, rng: Rng, r: number, name: string): THREE.BufferGeometry {
  const rows = 5;
  const sides = 7;
  const rings: V3[][] = [];
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    // Profile: a squat spheroid, flattened top and bottom so it sits still.
    const prof = Math.sin(Math.PI * (0.12 + t * 0.76));
    const row: V3[] = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const j = 0.82 + rng.range(0, 0.3);
      const rr = r * prof * j;
      row.push([
        Math.cos(a) * rr,
        (-r + 2 * r * t) * (0.9 + rng.range(0, 0.16)),
        Math.sin(a) * rr,
      ]);
    }
    rings.push(row);
  }
  return P.prim.loft(rings, { name });
}

// ===========================================================================
// The yard: accumulation helpers
// ===========================================================================

interface Yard {
  P: Parts;
  g: PartGroup;
  /** Peg transforms bucketed by the mount bone they ride on. */
  pegs: Map<string, THREE.Matrix4[]>;
  pegGeo: THREE.BufferGeometry;
  pegLen: number;
}

function timberPart(y: Yard, geo: THREE.BufferGeometry, bone: string, name: string): void {
  y.g.parts.push(
    y.P.mkPart(geo, 'timber', TIMBER, 'root', { name, rigid: true, mountBone: bone }),
  );
}

function ironPart(y: Yard, geo: THREE.BufferGeometry, bone: string, name: string): void {
  y.g.parts.push(y.P.mkPart(geo, 'iron', 'metal', 'root', { name, rigid: true, mountBone: bone }));
}

function ropePart(y: Yard, path: V3[], r: number, bone: string, name: string): void {
  y.g.parts.push(
    y.P.trim.piping({
      path,
      r,
      boneHint: 'root',
      mountBone: bone,
      pigment: ROPE,
      cls: 'leather',
      sides: 4,
      name,
    }),
  );
}

/**
 * Drive a peg. One geometry for every peg in the unit, scaled along its own
 * axis for length, so twenty joints cost one instance set.
 */
function peg(y: Yard, at: V3, axis: V3, length: number, bone: string): void {
  const dir = new THREE.Vector3(...axis).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...at),
    q,
    new THREE.Vector3(1, length / y.pegLen, 1),
  );
  let list = y.pegs.get(bone);
  if (!list) y.pegs.set(bone, (list = []));
  list.push(m);
}

/** An oak peg: six sides, chamfered at both ends so it reads as driven. */
function pegGeometry(P: Parts, r: number, len: number): THREE.BufferGeometry {
  const ring = (rr: number, yy: number) => P.prim.ring({ rx: rr, y: yy, sides: 6, phase: Math.PI / 6 });
  return P.prim.loft(
    [
      ring(r * 0.6, -len / 2),
      ring(r, -len / 2 + r * 0.55),
      ring(r, len / 2 - r * 0.55),
      ring(r * 0.6, len / 2),
    ],
    { name: 'peg' },
  );
}

// ===========================================================================
// Sled
// ===========================================================================

function buildSled(y: Yard, L: Layout): void {
  const { P } = y;
  const h = L.h;
  const B = 'treb.base';

  // -- runners -------------------------------------------------------------
  // Turned up at the nose like a real sledge, because a flat plank end reads as
  // a cut-off box and the upturn is legible from the far rank.
  for (const s of [-1, 1]) {
    const x = s * L.runnerX;
    const run = baulk(
      P,
      [
        { p: [x, L.deckY + 0.052 * h, L.sledF], hw: L.runnerHW * 0.68, hh: L.runnerHH * 0.62 },
        { p: [x, L.deckY - 0.012 * h, L.sledF + 0.14 * h], hw: L.runnerHW * 0.88, hh: L.runnerHH * 0.86 },
        { p: [x, L.runnerHH, L.sledF + 0.3 * h], hw: L.runnerHW, hh: L.runnerHH },
        { p: [x, L.runnerHH, L.sledB - 0.1 * h], hw: L.runnerHW, hh: L.runnerHH },
        { p: [x, L.runnerHH + 0.014 * h, L.sledB], hw: L.runnerHW * 0.9, hh: L.runnerHH * 0.9 },
      ],
      'sledRunner',
    );
    timberPart(y, run, B, 'sledRunner');
  }

  // -- through-tenoned cross ties ------------------------------------------
  // The tie runs the full width and out the far side of each runner. `tA`/`tB`
  // are the runners' outer faces along that run, so the tenon that shows is the
  // real end of the real timber.
  const proud = 0.062 * h;
  const outer = L.runnerX + L.runnerHW;
  for (const tz of [-0.66 * h, 0.1 * h, 0.8 * h]) {
    const tie = athwartTenon(
      P,
      outer,
      proud,
      L.runnerHH + 0.028 * h,
      tz,
      { hw: 0.045 * h, hh: 0.042 * h },
      { hw: 0.026 * h, hh: 0.03 * h },
      'sledTie',
    );
    timberPart(y, tie, B, 'sledTie');
    // A peg through each protruding tenon locks the frame square.
    for (const s of [-1, 1]) {
      peg(y, [s * (outer + proud * 0.5), L.runnerHH + 0.028 * h, tz], [0, 1, 0], 0.12 * h, B);
    }
  }

  // -- trough boards -------------------------------------------------------
  // The bed the loaded sling and its stone lie on, plus a floor under the shot
  // crib at the bow. Laid athwart with visible gaps: a solid deck would be one
  // unmodulated value under a three-band timber ramp. The gap at z ≈ 0.66h is
  // where the Chu windlass posts land, and it is left open in both armies so
  // the two machines share one sled.
  for (const z of [-0.68, -0.54, 0.4, 0.53, 0.79, 0.92, 1.05, 1.18]) {
    const board = baulk(
      P,
      [
        { p: [-L.runnerX + 0.01 * h, L.deckY + 0.016 * h, z * h], hw: 0.056 * h, hh: 0.016 * h },
        { p: [L.runnerX - 0.01 * h, L.deckY + 0.016 * h, z * h], hw: 0.056 * h, hh: 0.016 * h },
      ],
      'troughBoard',
    );
    timberPart(y, board, B, 'troughBoard');
  }

  // -- shot crib at the bow ------------------------------------------------
  // Two spare stones behind a low rail. It is the cheapest piece of
  // storytelling available and it says what the machine is for without a glyph.
  for (const s of [-1, 1]) {
    const rail = baulk(
      P,
      [
        { p: [s * 0.22 * h, L.deckY + 0.06 * h, CRIB_Z * h - 0.16 * h], hw: 0.024 * h, hh: 0.038 * h },
        { p: [s * 0.22 * h, L.deckY + 0.06 * h, CRIB_Z * h + 0.16 * h], hw: 0.024 * h, hh: 0.038 * h },
      ],
      'shotCrib',
    );
    timberPart(y, rail, B, 'shotCrib');
  }
}

/** Centre of the shot crib, in units of `h`. */
const CRIB_Z = -0.61;

// ===========================================================================
// Frames
// ===========================================================================

/**
 * 漢 — the traction frame. Four legs splayed fore and aft, meeting a pair of
 * axle bolsters at the apex, X-braced on each side and pegged into the runners.
 * In profile it is one clean triangle, and the beam's diagonal cuts it.
 */
function buildHanFrame(y: Yard, L: Layout): void {
  const { P } = y;
  const h = L.h;
  const B = 'treb.base';
  const apexY = L.pivot[1];
  const legHW = 0.042 * h;
  const legHH = 0.046 * h;
  const footZ = [L.pivot[2] - 0.44 * h, L.pivot[2] + 0.42 * h];

  for (const s of [-1, 1]) {
    const topX = s * (L.beamHW + 0.058 * h);
    for (const fz of footZ) {
      const foot: V3 = [s * 0.375 * h, L.deckY - 0.03 * h, fz];
      const top: V3 = [topX, apexY - 0.01 * h, L.pivot[2] + (fz > L.pivot[2] ? 0.03 * h : -0.03 * h)];
      // The leg is tenoned into the runner: a reduced foot below the deck line
      // with a hard shoulder on it, exactly like the ties.
      const shoulder = 0.09;
      const leg = baulk(
        P,
        [
          { p: foot, hw: legHW * 0.56, hh: legHH * 0.56 },
          { p: lerp3(foot, top, shoulder), hw: legHW * 0.56, hh: legHH * 0.56 },
          { p: lerp3(foot, top, shoulder + 0.005), hw: legHW, hh: legHH },
          { p: lerp3(foot, top, 0.6), hw: legHW * 0.94, hh: legHH * 0.94 },
          { p: top, hw: legHW * 0.8, hh: legHH * 0.8 },
        ],
        'frameLeg',
      );
      timberPart(y, leg, B, 'frameLeg');
      // Peg driven through the runner's cheek into the leg tenon.
      peg(y, [s * L.runnerX, L.runnerHH, fz], [1, 0, 0], 0.16 * h, B);

      // Knee brace from the runner up to the leg — the joint that stops the
      // frame racking, and a second short diagonal in the silhouette.
      const kneeA: V3 = [s * 0.375 * h, L.deckY + 0.01 * h, fz + (fz > L.pivot[2] ? -0.26 * h : 0.26 * h)];
      const kneeB: V3 = lerp3(foot, top, 0.36);
      timberPart(y, strutBaulk(P, kneeA, kneeB, 0.026 * h, 0.03 * h, 'kneeBrace'), B, 'kneeBrace');
      peg(y, kneeB, [1, 0, 0], 0.1 * h, B);
    }

    // X-brace across each side, half-lapped where the two struts cross.
    const a0: V3 = [s * 0.34 * h, L.deckY + 0.06 * h, footZ[0] + 0.06 * h];
    const a1: V3 = [s * 0.12 * h, apexY - 0.3 * h, footZ[1] - 0.08 * h];
    const b0: V3 = [s * 0.34 * h, L.deckY + 0.06 * h, footZ[1] - 0.06 * h];
    const b1: V3 = [s * 0.12 * h, apexY - 0.3 * h, footZ[0] + 0.08 * h];
    timberPart(y, strutBaulk(P, a0, a1, 0.022 * h, 0.028 * h, 'xBrace'), B, 'xBrace');
    timberPart(y, strutBaulk(P, b0, b1, 0.022 * h, 0.028 * h, 'xBrace'), B, 'xBrace');
    peg(y, lerp3(a0, a1, 0.5), [1, 0, 0], 0.09 * h, B);

    // Axle bolster: the short block the pin actually bears in.
    const bolster = baulk(
      P,
      [
        { p: [s * (L.beamHW + 0.024 * h), apexY, L.pivot[2] - 0.13 * h], hw: 0.048 * h, hh: 0.05 * h },
        { p: [s * (L.beamHW + 0.024 * h), apexY, L.pivot[2] + 0.13 * h], hw: 0.048 * h, hh: 0.05 * h },
      ],
      'axleBolster',
    );
    timberPart(y, bolster, B, 'axleBolster');

    // Rope binding over the leg tops and the bolster. This is the joint that
    // takes the whole throw, and on a real engine it is lashed, not bolted.
    y.g.parts.push(
      P.mkPart(
        lashing(P, {
          centre: [s * (L.beamHW + 0.042 * h), apexY - 0.012 * h, L.pivot[2]],
          axis: [0, 0, 1],
          rx: 0.062 * h,
          rz: 0.07 * h,
          turns: 3,
          pitch: 0.048 * h,
          cordR: 0.011 * h,
        }),
        'leather',
        ROPE,
        'root',
        { name: 'apexLashing', rigid: true, mountBone: B },
      ),
    );
  }

  // Collar tie across the frame, through-tenoned into both bolsters.
  const collarY = apexY - 0.4 * h;
  const cx = 0.2 * h;
  const collar = athwartTenon(
    P,
    cx,
    0.05 * h,
    collarY,
    L.pivot[2] + 0.02 * h,
    { hw: 0.03 * h, hh: 0.036 * h },
    { hw: 0.019 * h, hh: 0.022 * h },
    'collarTie',
  );
  timberPart(y, collar, B, 'collarTie');
  for (const s of [-1, 1]) peg(y, [s * (cx + 0.025 * h), collarY, L.pivot[2] + 0.02 * h], [0, 1, 0], 0.09 * h, B);
}

/**
 * 楚 — the counterweight tower. Four battered posts under a longitudinal head
 * beam, with long raking shores off both ends of the sled. Where the Han frame
 * is a triangle, this is a rectangle with two external diagonals, and the
 * difference survives the silhouette pass at board distance.
 */
function buildChuFrame(y: Yard, L: Layout): void {
  const { P } = y;
  const h = L.h;
  const B = 'treb.base';
  const headY = L.pivot[1];
  const postZ = [L.pivot[2] - 0.34 * h, L.pivot[2] + 0.3 * h];
  const postHW = 0.046 * h;

  for (const s of [-1, 1]) {
    for (const pz of postZ) {
      const foot: V3 = [s * 0.3 * h, L.deckY - 0.03 * h, pz];
      const top: V3 = [s * (L.beamHW + 0.062 * h), headY + 0.03 * h, pz];
      const post = baulk(
        P,
        [
          { p: foot, hw: postHW * 0.56, hh: postHW * 0.56 },
          { p: lerp3(foot, top, 0.085), hw: postHW * 0.56, hh: postHW * 0.56 },
          { p: lerp3(foot, top, 0.09), hw: postHW, hh: postHW * 1.06 },
          { p: top, hw: postHW * 0.88, hh: postHW * 0.94 },
        ],
        'towerPost',
      );
      timberPart(y, post, B, 'towerPost');
      peg(y, [s * L.runnerX, L.runnerHH, pz], [1, 0, 0], 0.16 * h, B);
    }

    // Head beam, running fore and aft over the posts and carrying the bolster.
    const head = baulk(
      P,
      [
        { p: [s * (L.beamHW + 0.05 * h), headY + 0.052 * h, postZ[0] - 0.14 * h], hw: 0.04 * h, hh: 0.04 * h },
        { p: [s * (L.beamHW + 0.05 * h), headY + 0.052 * h, postZ[1] + 0.14 * h], hw: 0.04 * h, hh: 0.04 * h },
      ],
      'headBeam',
    );
    timberPart(y, head, B, 'headBeam');

    // Long raking shores. These are the diagonals that make the Chu machine a
    // different shape rather than a different colour.
    for (const dir of [-1, 1]) {
      const a: V3 = [s * 0.34 * h, L.deckY + 0.02 * h, dir < 0 ? L.sledF + 0.1 * h : L.sledB - 0.1 * h];
      const b: V3 = [
        s * (L.beamHW + 0.055 * h),
        headY - 0.02 * h,
        dir < 0 ? postZ[0] - 0.02 * h : postZ[1] + 0.02 * h,
      ];
      timberPart(y, strutBaulk(P, a, b, 0.026 * h, 0.032 * h, 'shore'), B, 'shore');
      peg(y, lerp3(a, b, 0.02), [1, 0, 0], 0.11 * h, B);
      peg(y, lerp3(a, b, 0.97), [1, 0, 0], 0.1 * h, B);
    }

    // Axle bolster under the head beam.
    const bolster = baulk(
      P,
      [
        { p: [s * (L.beamHW + 0.026 * h), headY, L.pivot[2] - 0.14 * h], hw: 0.05 * h, hh: 0.05 * h },
        { p: [s * (L.beamHW + 0.026 * h), headY, L.pivot[2] + 0.14 * h], hw: 0.05 * h, hh: 0.05 * h },
      ],
      'axleBolster',
    );
    timberPart(y, bolster, B, 'axleBolster');
    y.g.parts.push(
      P.mkPart(
        lashing(P, {
          centre: [s * (L.beamHW + 0.044 * h), headY + 0.012 * h, L.pivot[2]],
          axis: [0, 0, 1],
          rx: 0.066 * h,
          rz: 0.076 * h,
          turns: 3,
          pitch: 0.05 * h,
          cordR: 0.011 * h,
        }),
        'leather',
        ROPE,
        'root',
        { name: 'apexLashing', rigid: true, mountBone: B },
      ),
    );
  }

  // Two athwart braces, through-tenoned, at the height a man's shoulder passes.
  for (const [ty, tz] of [
    [headY - 0.34 * h, postZ[0]],
    [headY - 0.34 * h, postZ[1]],
  ]) {
    const bx = 0.21 * h;
    const brace = athwartTenon(
      P,
      bx,
      0.05 * h,
      ty,
      tz,
      { hw: 0.028 * h, hh: 0.034 * h },
      { hw: 0.018 * h, hh: 0.021 * h },
      'towerBrace',
    );
    timberPart(y, brace, B, 'towerBrace');
    for (const s of [-1, 1]) peg(y, [s * (bx + 0.024 * h), ty, tz], [0, 1, 0], 0.085 * h, B);
  }
}

// ===========================================================================
// Beam, axle, sling
// ===========================================================================

function buildBeam(y: Yard, L: Layout, rng: Rng): void {
  const { P } = y;
  const h = L.h;
  const BEAM = 'treb.beam';

  // -- the beam ------------------------------------------------------------
  // Deepest at the pivot where the bending moment is, tapering both ways. A
  // parallel beam would be structurally illiterate and visually inert.
  const shaft = baulk(
    P,
    [
      { p: L.buttTip, hw: L.beamHW * 0.72, hh: L.beamHH * 0.66 },
      { p: lerp3(L.buttTip, L.pivot, 0.6), hw: L.beamHW * 0.9, hh: L.beamHH * 0.86 },
      { p: L.pivot, hw: L.beamHW, hh: L.beamHH },
      { p: lerp3(L.pivot, L.armTip, 0.42), hw: L.beamHW * 0.86, hh: L.beamHH * 0.82 },
      { p: lerp3(L.pivot, L.armTip, 0.78), hw: L.beamHW * 0.66, hh: L.beamHH * 0.6 },
      { p: L.armTip, hw: L.beamHW * 0.46, hh: L.beamHH * 0.44 },
    ],
    'trebBeam',
  );
  timberPart(y, shaft, BEAM, 'trebBeam');

  // Rope whippings up the throwing arm: a laminated beam is bound, and the
  // bands break its long flat run into readable segments.
  const axis: V3 = [
    L.armTip[0] - L.pivot[0],
    L.armTip[1] - L.pivot[1],
    L.armTip[2] - L.pivot[2],
  ];
  for (const t of [0.3, 0.56, 0.82]) {
    y.g.parts.push(
      P.mkPart(
        lashing(P, {
          centre: lerp3(L.pivot, L.armTip, t),
          axis,
          rx: L.beamHW * (1.02 - t * 0.34),
          rz: L.beamHH * (1.02 - t * 0.34),
          turns: 2,
          pitch: 0.03 * h,
          cordR: 0.009 * h,
        }),
        'leather',
        ROPE,
        'root',
        { name: 'beamWhipping', rigid: true, mountBone: BEAM },
      ),
    );
  }
  for (const t of [0.42, 0.68]) {
    y.g.parts.push(
      P.trim.ferrule({
        at: lerp3(L.buttTip, L.pivot, t),
        r: L.beamHW * 0.98,
        height: L.beamHH * 0.4,
        proud: L.beamHW * 0.14,
        boneHint: 'root',
        mountBone: BEAM,
        pigment: 'metal',
        rot: [Math.PI / 2 - L.armAngle, 0, 0],
        sides: 6,
      }),
    );
  }

  // -- pivot ironwork ------------------------------------------------------
  // Two cheek plates riveted through the beam, an axle pin with a head one side
  // and a washer and cotter the other, and a binding over the pin's collar.
  for (const s of [-1, 1]) {
    const cheek = P.prim.bevelSlab({
      w: 0.3 * h,
      h: 0.15 * h,
      d: 0.012 * h,
      bevel: 0.016 * h,
      name: 'pivotCheek',
    });
    P.prim.place(cheek, {
      pos: [s * (L.beamHW + 0.008 * h), L.pivot[1], L.pivot[2]],
      rot: [-L.armAngle, Math.PI / 2, 0],
    });
    ironPart(y, cheek, BEAM, 'pivotCheek');
    y.g.instanced.push(
      ...P.rivets.rivetLine({
        from: [s * (L.beamHW + 0.02 * h), L.pivot[1] + Math.sin(L.armAngle) * 0.1 * h, L.pivot[2] - Math.cos(L.armAngle) * 0.1 * h],
        to: [s * (L.beamHW + 0.02 * h), L.pivot[1] - Math.sin(L.armAngle) * 0.1 * h, L.pivot[2] + Math.cos(L.armAngle) * 0.1 * h],
        count: 4,
        normal: [s, 0, 0],
        boneHint: 'root',
        mountBone: BEAM,
        pigment: 'metal',
        rivet: { r: 0.017 * h, h: 0.011 * h },
        name: 'pivotRivets',
      }).instanced,
    );
  }

  // The pin itself lives on the fixed bearing, not the beam: it does not turn.
  const pinHalf = L.beamHW + 0.11 * h;
  const pin = P.prim.hardLathe(
    [
      [0.017 * h, -pinHalf],
      [0.017 * h, pinHalf * 0.86],
      [0.03 * h, pinHalf * 0.88],
      [0.03 * h, pinHalf],
    ],
    8,
    { name: 'axlePin' },
  );
  pin.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  pin.translate(...L.pivot);
  ironPart(y, pin, 'treb.pivot', 'axlePin');
  // Cotter through the far end of the pin — the detail that says "this comes
  // apart", which is what a field engine has to do.
  ironPart(
    y,
    P.prim.place(
      P.prim.bevelSlab({ w: 0.012 * h, h: 0.07 * h, d: 0.01 * h, bevel: 0.004 * h, name: 'cotter' }),
      { pos: [-pinHalf - 0.008 * h, L.pivot[1], L.pivot[2]], rot: [0, Math.PI / 2, 0] },
    ),
    'treb.pivot',
    'cotter',
  );
  y.g.parts.push(
    P.mkPart(
      lashing(P, {
        centre: [pinHalf * 0.72, L.pivot[1], L.pivot[2]],
        axis: [1, 0, 0],
        rx: 0.028 * h,
        rz: 0.028 * h,
        turns: 2,
        pitch: 0.02 * h,
        cordR: 0.007 * h,
      }),
      'leather',
      ROPE,
      'root',
      { name: 'pinBinding', rigid: true, mountBone: 'treb.pivot' },
    ),
  );

  // -- sling head ----------------------------------------------------------
  buildSling(y, L, rng);
}

/**
 * The sling: two cords off the arm tip, a leather pouch slung between them and
 * a stone in it. One cord is beckets — knotted to the beam's eye and never
 * leaves it. The other ends in a loop dropped over the release prong, and the
 * prong's angle is what sets the launch angle on a real engine. Both are here
 * because the capture beat pushes the camera to about arm's length from this
 * and a pouch made of one quad would fall apart at that distance.
 */
function buildSling(y: Yard, L: Layout, rng: Rng): void {
  const { P } = y;
  const h = L.h;
  const S = 'treb.sling';
  const tip = L.armTip;
  const pouch = L.pouch;
  const halfLen = 0.16 * h;
  // Wider than the shot's own radius, or the stone bulges through the leather —
  // and this is the one piece of the machine the capture camera gets close to.
  const halfW = 0.165 * h;
  // The cord eyes sit at the stone's equator: that is where a sling's pouch is
  // actually gathered, and it is what stops the shot reading as a ball resting
  // on a flap of leather.
  const front: V3 = [0, pouch[1] + 0.02 * h, pouch[2] - halfLen];
  const back: V3 = [0, pouch[1] + 0.02 * h, pouch[2] + halfLen];

  // Release prong: an iron hook standing off the arm tip along the beam axis.
  const beamDir = new THREE.Vector3(
    tip[0] - L.pivot[0],
    tip[1] - L.pivot[1],
    tip[2] - L.pivot[2],
  ).normalize();
  const prongBase: V3 = [
    tip[0] + beamDir.x * 0.01 * h,
    tip[1] + beamDir.y * 0.01 * h,
    tip[2] + beamDir.z * 0.01 * h,
  ];
  const prongTip: V3 = [prongBase[0], prongBase[1] + 0.1 * h, prongBase[2] + 0.03 * h];
  ironPart(
    y,
    P.prim.sweep(
      [
        { p: prongBase, rx: 0.016 * h, squareness: 0.5 },
        { p: [prongBase[0], prongBase[1] + 0.06 * h, prongBase[2] - 0.01 * h], rx: 0.012 * h, squareness: 0.5 },
        { p: prongTip, rx: 0.007 * h, squareness: 0.5 },
      ],
      { sides: 5, name: 'releaseProng' },
    ),
    S,
    'releaseProng',
  );
  // The becket the fixed cord is knotted to. `cordLoop` takes no mount bone and
  // defaults to leather, so it is re-labelled here as the iron eye it is.
  const becket = P.rivets.cordLoop({
    at: [0, tip[1] - 0.026 * h, tip[2] - 0.012 * h],
    r: 0.026 * h,
    thickness: 0.007 * h,
    boneHint: 'root',
    pigment: 'metal',
    rot: [0, Math.PI / 2, 0],
  });
  becket.mountBone = S;
  becket.cls = 'iron';
  y.g.parts.push(becket);

  ropePart(y, [[0, tip[1] - 0.03 * h, tip[2]], lerp3([0, tip[1] - 0.03 * h, tip[2]], front, 0.55), front], 0.011 * h, S, 'slingCordFixed');
  ropePart(
    y,
    [
      [0, prongTip[1] - 0.012 * h, prongTip[2]],
      lerp3([0, prongTip[1], prongTip[2]], back, 0.5),
      back,
    ],
    0.011 * h,
    S,
    'slingCordRelease',
  );

  // -- pouch ---------------------------------------------------------------
  // A saddle that actually cradles the shot: deepest across the middle, drawn
  // in at both ends where the cords take it.
  const rows = 5;
  const cols = 6;
  const grid: V3[][] = [];
  for (let r = 0; r < rows; r++) {
    const u = (r / (rows - 1)) * 2 - 1; // across
    const row: V3[] = [];
    for (let c = 0; c < cols; c++) {
      const v = c / (cols - 1); // along the sling
      const draw = 0.42 + 0.58 * Math.sin(Math.PI * v); // pinched at the cords
      row.push([
        u * halfW * draw,
        pouch[1] + 0.02 * h - (1 - u * u) * 0.155 * h * draw,
        pouch[2] + (v - 0.5) * halfLen * 2,
      ]);
    }
    grid.push(row);
  }
  y.g.parts.push(
    P.mkPart(P.prim.shell(grid, 0.007 * h, { name: 'slingPouch' }), 'leather', ROPE, 'root', {
      name: 'slingPouch',
      rigid: true,
      mountBone: S,
    }),
  );
  // Stitched edge along both long sides, and a grommet at each cord eye.
  ropePart(y, grid[0], 0.006 * h, S, 'pouchWelt');
  ropePart(y, grid[rows - 1], 0.006 * h, S, 'pouchWelt');
  for (const at of [front, back]) {
    const loop = P.rivets.cordLoop({
      at: [at[0], at[1] - 0.012 * h, at[2]],
      r: 0.016 * h,
      thickness: 0.005 * h,
      boneHint: 'root',
      pigment: 'metal',
      rot: [Math.PI / 2, 0, 0],
    });
    loop.mountBone = S;
    loop.cls = 'iron';
    y.g.parts.push(loop);
  }

  // -- the shot ------------------------------------------------------------
  const shot = boulder(P, rng, L.stoneR, 'slingStone');
  shot.translate(0, pouch[1], pouch[2]);
  y.g.parts.push(
    P.mkPart(shot, 'stone', STONE, 'root', { name: 'slingStone', rigid: true, mountBone: S }),
  );

  // Spare shot in the crib, resting on the crib's floor boards.
  for (let i = 0; i < 2; i++) {
    const r = L.stoneR * (0.88 + i * 0.12);
    const s = boulder(P, rng, r, 'spareShot');
    s.translate(
      (i === 0 ? -1 : 1) * 0.09 * h,
      L.deckY + 0.032 * h + r * 0.94,
      CRIB_Z * h + (i - 0.5) * 0.15 * h,
    );
    y.g.parts.push(
      P.mkPart(s, 'stone', STONE, 'root', { name: 'spareShot', rigid: true, mountBone: 'treb.base' }),
    );
  }

  y.g.points.muzzle = new THREE.Vector3(pouch[0], pouch[1], pouch[2]);
  y.g.attach.push({ name: 'muzzle', bone: S, position: [pouch[0], pouch[1], pouch[2]] });
}

// ===========================================================================
// Working ends: what the crew take hold of
// ===========================================================================

/** One crewman's two fists, hand over hand. Positions are grip-bore centres. */
interface Grip {
  high: V3;
  low: V3;
}

/**
 * What the machine offers its crew. `head` is where the rope leaves the beam or
 * where the bar tops out; `fixed` is a pair of fist positions when the machine's
 * own geometry dictates them (a capstan bar does, a hanging rope does not — the
 * rope goes wherever the man's hands are, which is why the Han crew's grips are
 * derived from his stature instead).
 */
interface Working {
  headL: V3;
  headR: V3;
  fixedL: Grip | null;
  fixedR: Grip | null;
}

// ===========================================================================
// Han: spreader bar and haul ropes
// ===========================================================================

/**
 * The 人力砲's short arm ends in a spreader bar carrying a fan of haul ropes —
 * that bar is the whole reason a traction engine can be worked by a crew rather
 * than a counterweight, and it is the Han machine's identifying feature at the
 * front of the silhouette.
 *
 * Returns the two rope-head positions the crew pull on.
 */
function buildSpreader(y: Yard, L: Layout): Working {
  const { P } = y;
  const h = L.h;
  const Y = 'treb.yoke';
  const tip = L.buttTip;
  const half = 0.3 * h;

  const bar = athwartTenon(
    P,
    half,
    0.05 * h,
    tip[1],
    tip[2],
    { hw: 0.033 * h, hh: 0.036 * h },
    { hw: 0.021 * h, hh: 0.023 * h },
    'spreaderBar',
  );
  timberPart(y, bar, Y, 'spreaderBar');
  peg(y, [0, tip[1], tip[2]], [0, 1, 0], 0.11 * h, Y);

  // Iron caps on the bar ends, and a lashing binding it to the beam.
  for (const s of [-1, 1]) {
    y.g.parts.push(
      P.trim.ferrule({
        at: [s * (half - 0.02 * h), tip[1], tip[2]],
        r: 0.03 * h,
        height: 0.028 * h,
        proud: 0.008 * h,
        boneHint: 'root',
        mountBone: Y,
        pigment: 'metal',
        rot: [0, 0, Math.PI / 2],
        sides: 6,
      }),
    );
  }
  y.g.parts.push(
    P.mkPart(
      lashing(P, {
        centre: [0, tip[1], tip[2]],
        axis: [1, 0, 0],
        rx: 0.055 * h,
        rz: 0.058 * h,
        turns: 3,
        pitch: 0.026 * h,
        cordR: 0.009 * h,
      }),
      'leather',
      ROPE,
      'root',
      { name: 'yokeLashing', rigid: true, mountBone: Y },
    ),
  );

  // Four slack ropes hanging off the bar between the two working ones, so the
  // fan reads as a crew's worth of tackle and not two strings.
  for (const t of [-0.62, -0.2, 0.2, 0.62]) {
    const x = t * half;
    const drop = 0.3 * h + Math.abs(t) * 0.1 * h;
    ropePart(
      y,
      [
        [x, tip[1] - 0.02 * h, tip[2]],
        [x * 1.06, tip[1] - drop * 0.55, tip[2] + 0.03 * h],
        [x * 1.12, tip[1] - drop, tip[2] + 0.055 * h],
      ],
      0.008 * h,
      Y,
      'slackRope',
    );
  }

  return {
    headL: [-half * 0.9, tip[1] - 0.02 * h, tip[2]],
    headR: [half * 0.9, tip[1] - 0.02 * h, tip[2]],
    fixedL: null,
    fixedR: null,
  };
}

// ===========================================================================
// Chu: counterweight box and windlass
// ===========================================================================

/**
 * 配重 — the weight box, hung from the short arm on two iron links so it stays
 * upright through the swing. Plank-built with iron straps and a rope net over
 * the fill, because a smooth box would read as a crate of nothing.
 */
function buildCounterweight(y: Yard, L: Layout): void {
  const { P } = y;
  const h = L.h;
  const W = 'treb.weight';
  const tip = L.buttTip;
  const hang = 0.21 * h;
  const c: V3 = [0, tip[1] - hang - 0.19 * h, tip[2] + 0.02 * h];
  const hx = 0.185 * h;
  const hy = 0.185 * h;
  const hz = 0.16 * h;

  // Links from the beam eye down to the box trunnions.
  for (const s of [-1, 1]) {
    ironPart(
      y,
      P.prim.sweep(
        [
          { p: [s * 0.03 * h, tip[1] - 0.02 * h, tip[2]], rx: 0.012 * h, rz: 0.006 * h, squareness: 0.6 },
          { p: [s * (hx * 0.55), c[1] + hy * 0.86, c[2]], rx: 0.011 * h, rz: 0.006 * h, squareness: 0.6 },
        ],
        { sides: 4, name: 'weightLink' },
      ),
      W,
      'weightLink',
    );
  }

  // Six planks: four sides, a bottom, and a lid left slightly proud so the box
  // reads as filled rather than sealed.
  const plank = (w: number, ht: number, d: number, pos: V3, rot: V3, name: string) => {
    const g = P.prim.bevelSlab({ w, h: ht, d, bevel: Math.min(w, ht) * 0.06, name });
    P.prim.place(g, { pos, rot });
    timberPart(y, g, W, name);
  };
  plank(hx * 2, hy * 2, 0.02 * h, [0, c[1], c[2] - hz], [0, 0, 0], 'weightPlank');
  plank(hx * 2, hy * 2, 0.02 * h, [0, c[1], c[2] + hz], [0, 0, 0], 'weightPlank');
  plank(hz * 2, hy * 2, 0.02 * h, [-hx, c[1], c[2]], [0, Math.PI / 2, 0], 'weightPlank');
  plank(hz * 2, hy * 2, 0.02 * h, [hx, c[1], c[2]], [0, Math.PI / 2, 0], 'weightPlank');
  plank(hx * 2, hz * 2, 0.02 * h, [0, c[1] - hy, c[2]], [Math.PI / 2, 0, 0], 'weightPlank');
  plank(hx * 1.9, hz * 1.9, 0.018 * h, [0, c[1] + hy * 1.02, c[2]], [Math.PI / 2, 0, 0], 'weightLid');

  // Two iron bands right round the box. A four-sided ring with the phase
  // rotated onto the corners hugs a square crate exactly, which is why the box
  // is a box and the band is a lathe.
  for (const ty of [-0.52, 0.52]) {
    const band = P.prim.loft(
      [
        // A four-point ring at phase π/4 has its vertices at (±r/√2, ±r/√2), so
        // the radii are scaled by √2 to put them exactly on the box corners.
        P.prim.ring({ rx: hx * 1.06 * Math.SQRT2, rz: hz * 1.07 * Math.SQRT2, y: c[1] + ty * hy - 0.018 * h, cz: c[2], sides: 4, phase: Math.PI / 4 }),
        P.prim.ring({ rx: hx * 1.06 * Math.SQRT2, rz: hz * 1.07 * Math.SQRT2, y: c[1] + ty * hy + 0.018 * h, cz: c[2], sides: 4, phase: Math.PI / 4 }),
      ],
      { capStart: false, capEnd: false, name: 'weightStrap' },
    );
    ironPart(y, band, W, 'weightStrap');
  }
  y.g.instanced.push(
    ...P.rivets.rivetGrid({
      corners: [
        [-hx * 0.7, c[1] + hy * 0.7, c[2] + hz + 0.012 * h],
        [hx * 0.7, c[1] + hy * 0.7, c[2] + hz + 0.012 * h],
        [hx * 0.7, c[1] - hy * 0.7, c[2] + hz + 0.012 * h],
        [-hx * 0.7, c[1] - hy * 0.7, c[2] + hz + 0.012 * h],
      ],
      rows: 2,
      cols: 3,
      boneHint: 'root',
      mountBone: W,
      pigment: 'metal',
      rivet: { r: 0.014 * h, h: 0.009 * h },
      name: 'weightStuds',
    }).instanced,
  );

  // Net over the fill.
  for (let i = 0; i < 3; i++) {
    const u = (i - 1) * hx * 0.62;
    ropePart(
      y,
      [
        [u, c[1] + hy * 0.94, c[2] - hz],
        [u, c[1] + hy * 1.06, c[2]],
        [u, c[1] + hy * 0.94, c[2] + hz],
      ],
      0.006 * h,
      W,
      'weightNet',
    );
  }
}

/**
 * The Chu winding gear: a drum athwart the sled aft, two lever arms the crew
 * bear down on, and a rope up to the throwing arm. Returns the lever grips the
 * crew's hands lock to.
 */
function buildWindlass(y: Yard, L: Layout): Working {
  const { P } = y;
  const h = L.h;
  const D = 'treb.windlass';
  const B = 'treb.base';
  const drum: V3 = [0, L.deckY + 0.2 * h, 0.66 * h];

  // Two posts carrying the drum, tenoned into the runners.
  for (const s of [-1, 1]) {
    const foot: V3 = [s * 0.29 * h, L.deckY - 0.03 * h, drum[2]];
    const top: V3 = [s * 0.27 * h, drum[1] + 0.06 * h, drum[2]];
    timberPart(
      y,
      baulk(
        P,
        [
          { p: foot, hw: 0.026 * h, hh: 0.026 * h },
          { p: lerp3(foot, top, 0.16), hw: 0.026 * h, hh: 0.026 * h },
          { p: lerp3(foot, top, 0.17), hw: 0.042 * h, hh: 0.038 * h },
          { p: top, hw: 0.04 * h, hh: 0.036 * h },
        ],
        'windlassPost',
      ),
      B,
      'windlassPost',
    );
    peg(y, [s * L.runnerX, L.runnerHH, drum[2]], [1, 0, 0], 0.16 * h, B);
  }

  // The drum: a faceted barrel with a rope already wound on it.
  const barrel = P.prim.hardLathe(
    [
      [0.028 * h, -0.28 * h],
      [0.05 * h, -0.25 * h],
      [0.05 * h, 0.25 * h],
      [0.028 * h, 0.28 * h],
    ],
    8,
    { name: 'windlassDrum' },
  );
  barrel.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  barrel.translate(...drum);
  timberPart(y, barrel, D, 'windlassDrum');
  y.g.parts.push(
    P.mkPart(
      lashing(P, {
        centre: drum,
        axis: [1, 0, 0],
        rx: 0.056 * h,
        rz: 0.056 * h,
        turns: 4,
        pitch: 0.026 * h,
        cordR: 0.009 * h,
      }),
      'leather',
      ROPE,
      'root',
      { name: 'windlassCoil', rigid: true, mountBone: D },
    ),
  );

  // Capstan bars, one each side, raked up and out. They are kept close to
  // vertical on purpose: the fist that grips them is bored along +Y, so a bar
  // lying across that axis would read as a hand resting beside its handle.
  const grips: Grip[] = [];
  for (const s of [-1, 1]) {
    const a: V3 = [s * 0.18 * h, drum[1] - 0.02 * h, drum[2] - 0.02 * h];
    const b: V3 = [s * 0.46 * h, drum[1] + 0.46 * h, drum[2] + 0.05 * h];
    // Tapered to the tip — what a lever wants structurally, and what makes the
    // outer end thin enough for a fist to close on it. There is a section
    // station at each of the two grip heights, so the bar has real geometry
    // exactly where a hand is, not an interpolated gap.
    const GRIP_LOW = 0.58;
    const GRIP_HIGH = 0.88;
    timberPart(
      y,
      baulk(
        P,
        [
          { p: a, hw: 0.028 * h, hh: 0.03 * h },
          { p: lerp3(a, b, GRIP_LOW), hw: 0.0185 * h, hh: 0.0195 * h },
          { p: lerp3(a, b, GRIP_HIGH), hw: 0.016 * h, hh: 0.0168 * h },
          { p: b, hw: 0.014 * h, hh: 0.015 * h },
        ],
        'capstanBar',
      ),
      D,
      'capstanBar',
    );
    y.g.parts.push(
      P.trim.ferrule({
        at: lerp3(a, b, 0.42),
        r: 0.028 * h,
        height: 0.026 * h,
        proud: 0.006 * h,
        boneHint: 'root',
        mountBone: D,
        pigment: 'metal',
        rot: [0.1, 0, -s * 0.55],
        sides: 6,
      }),
    );
    // Rope grommets whipped round the bar just clear of where the hands close.
    for (const t of [0.44, 0.73]) {
      y.g.parts.push(
        P.mkPart(
          lashing(P, {
            centre: lerp3(a, b, t),
            axis: [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
            rx: 0.03 * h,
            rz: 0.031 * h,
            turns: 2,
            pitch: 0.026 * h,
            cordR: 0.007 * h,
          }),
          'leather',
          ROPE,
          'root',
          { name: 'barGrip', rigid: true, mountBone: D },
        ),
      );
    }
    grips.push({ high: lerp3(a, b, GRIP_HIGH), low: lerp3(a, b, GRIP_LOW) });
  }

  // Winding rope from the drum up to the arm tip: the tackle that cocks it.
  ropePart(
    y,
    [
      [0.03 * h, drum[1] + 0.05 * h, drum[2]],
      lerp3([0.03 * h, drum[1] + 0.05 * h, drum[2]], L.armTip, 0.5),
      [0.02 * h, L.armTip[1] - 0.03 * h, L.armTip[2] - 0.01 * h],
    ],
    0.01 * h,
    B,
    'windingRope',
  );

  return {
    headL: grips[0].high,
    headR: grips[1].high,
    fixedL: grips[0],
    fixedR: grips[1],
  };
}

// ===========================================================================
// Pennant
// ===========================================================================

/**
 * A mark on the machine so a player can tell whose engine it is from behind.
 * Han flies the stiff square 旌, Chu the swallow-tail — the shapes are the
 * parts library's, and they are the only thing on this unit that says "army"
 * without saying "colour".
 */
function buildPennant(y: Yard, L: Layout): void {
  const { P } = y;
  const h = L.h;
  const B = 'treb.base';
  const base: V3 = [
    L.chu ? 0.19 * h : 0.17 * h,
    L.pivot[1] - (L.chu ? 0.02 * h : 0.06 * h),
    L.chu ? L.pivot[2] + 0.44 * h : L.pivot[2] + 0.4 * h,
  ];
  const len = L.mastTop - base[1];

  const pole = P.standard.flagpole({
    base,
    length: len,
    r: 0.011 * h,
    lean: L.chu ? 0.1 : -0.07,
    leanAxis: 0,
    boneHint: 'root',
    mountBone: B,
    pigment: TIMBER,
    metalPigment: 'metal',
    finial: false,
    rings: 2,
  });
  y.g.parts.push(...pole.parts);

  const top = pole.points.top;
  y.g.parts.push(
    ...P.standard.banner({
      shape: L.chu ? 'chuSwallowtail' : 'hanSquare',
      at: [top.x, top.y - 0.02 * h, top.z],
      height: 0.24 * h,
      width: 0.28 * h,
      fly: L.chu ? 2.5 : -2.5,
      wave: 0.14,
      phase: L.chu ? 1.9 : 0.4,
      boneHint: 'root',
      mountBone: B,
      pigment: 'accent',
    }).parts,
  );
  y.g.parts.push(
    ...P.standard.streamers({
      at: [top.x, top.y - 0.26 * h, top.z],
      count: 4,
      length: 0.17 * h,
      width: 0.014 * h,
      spread: 0.07 * h,
      boneHint: 'root',
      mountBone: B,
      pigment: 'accent',
    }).parts,
  );
  y.g.parts.push(
    P.trim.boss({
      at: [top.x, top.y + 0.012 * h, top.z],
      r: 0.02 * h,
      height: 0.036 * h,
      boneHint: 'root',
      mountBone: B,
      pigment: 'metal',
      cls: 'iron',
      sides: 6,
    }),
  );
}

// ===========================================================================
// Crew
// ===========================================================================

/**
 * Bind-pose offsets that fold one arm onto a target. Offsets move a bone and
 * everything under it, so the elbow delta is applied at `foreArm` and the wrist
 * delta on top of it at `hand` — the same idea as the fallback's leg folding,
 * and the reason a crewman's fists are on the rope before any clip runs.
 */
function reachOffsets(rig: Rig, side: 'L' | 'R', elbow: V3, wrist: V3): Offsets {
  const B = rig.bindWorld;
  const e = B[`foreArm${side}` as BoneName];
  const w = B[`hand${side}` as BoneName];
  const d1: V3 = [elbow[0] - e.x, elbow[1] - e.y, elbow[2] - e.z];
  const out: Offsets = {};
  out[`foreArm${side}` as BoneName] = d1;
  out[`hand${side}` as BoneName] = [
    wrist[0] - w.x - d1[0],
    wrist[1] - w.y - d1[1],
    wrist[2] - w.z - d1[2],
  ];
  return out;
}

/**
 * Legs braced against the pull: knees bent, one foot forward, one back.
 *
 * `origin` is the crewman's standing point and is *not* optional. `buildRig`
 * folds a rig's vertical origin into its metrics but adds the horizontal origin
 * to every bone at the end, so a target expressed in bare metrics would be an
 * absolute rig-space coordinate near x = 0 — and would haul the crewman's legs
 * out from under him toward the machine's centre line.
 */
function braceOffsets(rig: Rig, origin: V3, forward: number): Offsets {
  const m = rig.metrics;
  const B = rig.bindWorld;
  const y0 = B.root.y;
  const out: Offsets = {};
  for (const S of ['L', 'R'] as const) {
    const s = S === 'L' ? -1 : 1;
    const knee = B[`shin${S}`];
    const ankle = B[`foot${S}`];
    const kneeT: V3 = [
      origin[0] + s * m.hipWidth * 0.72,
      y0 + m.legLen * 0.5,
      origin[2] - m.legLen * (0.12 + forward * 0.16) + (s > 0 ? -m.legLen * 0.06 : m.legLen * 0.1),
    ];
    const ankleT: V3 = [
      origin[0] + s * m.stanceWidth * 0.78,
      y0 + m.ankleY,
      origin[2] + m.legLen * (0.1 - forward * 0.2) + (s > 0 ? -m.legLen * 0.22 : m.legLen * 0.2),
    ];
    const dK: V3 = [kneeT[0] - knee.x, kneeT[1] - knee.y, kneeT[2] - knee.z];
    out[`shin${S}` as BoneName] = dK;
    out[`foot${S}` as BoneName] = [
      ankleT[0] - ankle.x - dK[0],
      ankleT[1] - ankle.y - dK[1],
      ankleT[2] - ankle.z - dK[2],
    ];
  }
  return out;
}

/**
 * Where a hauling crewman's two fists want to be when the machine does not
 * dictate it: hand over hand on a rope hanging just off his working shoulder,
 * with the rope vertical between them. The bore through `hand({pose:'fist'})`
 * runs along +Y, so a vertical run through both fists is the only arrangement
 * in which the cord genuinely threads the hand.
 */
function haulGrip(m: Metrics, origin: V3, outward: number, high: number): Grip {
  const x = origin[0] + outward * m.shoulderWidth * 0.42;
  const z = origin[2] - m.chestDepth * 0.62;
  return {
    high: [x, high, z],
    low: [x, high - m.armLen * 0.52, z],
  };
}

/**
 * Bind offsets that put both fists on a grip pair. `hand()` bores the grip half
 * a hand-length below the wrist and a little behind it, so the wrist target is
 * the grip pushed back out along those two axes; the elbow is placed outboard
 * and behind, which is where a man's elbow goes when he is pulling something
 * toward his chest.
 */
function gripOffsets(rig: Rig, grip: Grip, outward: number): Offsets {
  const m = rig.metrics;
  const lift = m.handLen * 0.5;
  const back = m.handR * 0.55;
  const u = m.upperArmLen;
  const wristOf = (p: V3): V3 => [p[0], p[1] + lift, p[2] + back];
  // The high hand is the one on the outboard side; crossing them over is what
  // makes the pose read as hauling rather than as reaching.
  return {
    ...reachOffsets(
      rig,
      outward > 0 ? 'R' : 'L',
      [grip.high[0] + outward * u * 0.52, grip.high[1] - u * 0.26, grip.high[2] + u * 1.0],
      wristOf(grip.high),
    ),
    ...reachOffsets(
      rig,
      outward > 0 ? 'L' : 'R',
      [grip.low[0] + outward * u * 0.66, grip.low[1] + u * 0.2, grip.low[2] + u * 0.95],
      wristOf(grip.low),
    ),
  };
}

interface CrewLook {
  side: Side;
  chu: boolean;
  rng: Rng;
  /**
   * Bore radius through the closed fist. It has to match what the man is
   * actually holding, or the thing he is holding passes through his fingers:
   * a Han hauler closes on a rope, a Chu winder on a capstan bar.
   */
  bore: number;
}

/**
 * A crewman's bind pose with his standing point taken back off him, so the whole
 * figure can be built in his own local space — feet at the origin, on the
 * machine's centre line — and stood where he works afterwards with a single
 * `transformGroup`.
 *
 * This is not a tidiness measure, it is the only space `crewFigure` can safely
 * be built in. `buildRig` folds the *vertical* origin into `metrics` but adds
 * the *horizontal* origin to `bindWorld` at the very end, so a figure built
 * from both at once is built in two different spaces: everything sized from
 * `metrics` — torso, neck, skirt, sash, cape, harness, hood — is centred on
 * x = z = 0, and everything placed from `bindWorld` — arms, legs, hands, boots,
 * puttees, scabbard — is out at the standing point. The man then renders as a
 * pair of legs and two arms beside the sled with his torso a metre away inside
 * the frame. Rebase the bind pose and both halves land in one space; the
 * translation afterwards carries geometry, published grip points and `crew.*`
 * bone rest positions together.
 */
function localBind(B: Bind, origin: V3): Bind {
  const d = new THREE.Vector3(origin[0], 0, origin[2]);
  const out = {} as Bind;
  for (const b of BONE_ORDER) out[b] = B[b].clone().sub(d);
  return out;
}

/**
 * One dressed artillerist, built in his own local space — see `localBind`, and
 * pass a rebased bind pose or he comes apart. Hooded — that is the 砲's crown
 * tag and it does not move — in a short tunic under a light two-row harness,
 * with puttees, boots and a 環首刀 at the hip. Built from explicit parts rather
 * than `body.figure` so every pigment lands in a bucket this unit already pays
 * for.
 */
function crewFigure(P: Parts, m: Metrics, B: Bind, look: CrewLook): PartGroup {
  const v = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];
  const g = P.emptyGroup();
  const chu = look.chu;

  g.parts.push(
    P.body.torso({
      hipY: m.hipY,
      waistY: m.waistY,
      chestY: m.chestY,
      shoulderY: m.shoulderY,
      hipWidth: m.hipWidth,
      waistWidth: m.waistWidth,
      chestWidth: m.chestWidth,
      shoulderWidth: m.shoulderWidth,
      hipDepth: m.hipDepth,
      waistDepth: m.waistDepth,
      chestDepth: m.chestDepth,
      neckR: m.neckR,
      pigment: 'cloth',
      cls: 'cloth',
    }),
  );
  g.parts.push(P.body.neck({ fromY: m.shoulderY, toY: B.head.y + m.headLen * 0.08, r: m.neckR }));
  const head = P.body.head({
    baseY: B.head.y,
    length: m.headLen,
    width: m.headWidth,
    depth: m.headDepth,
    z: B.head.z,
    beard: 'none',
    topknot: false,
  });
  g.parts.push(...head.parts);

  for (const S of ['L', 'R'] as const) {
    g.parts.push(
      ...P.body.arm({
        side: S,
        shoulder: v(B[`upperArm${S}`]),
        elbow: v(B[`foreArm${S}`]),
        wrist: v(B[`hand${S}`]),
        upperR: m.upperArmR,
        foreR: m.foreArmR,
        cls: 'cloth',
        pigment: 'cloth',
        deltoid: false,
      }).parts,
    );
    g.parts.push(
      ...P.body.leg({
        side: S,
        hip: v(B[`thigh${S}`]),
        knee: v(B[`shin${S}`]),
        ankle: v(B[`foot${S}`]),
        thighR: m.thighR,
        shinR: m.shinR,
        cls: 'cloth',
        pigment: 'cloth',
      }).parts,
    );
    const hand = P.body.hand({
      side: S,
      wrist: v(B[`hand${S}`]),
      length: m.handLen,
      r: m.handR,
      gripR: look.bore,
      pose: 'fist',
    });
    g.parts.push(...hand.parts);
    for (const k of Object.keys(hand.points)) g.points[k] = hand.points[k];
    g.parts.push(
      ...P.body.boot({
        side: S,
        ankle: v(B[`foot${S}`]),
        length: m.footLen,
        width: m.footLen * 0.42,
        shaft: 0.22,
        cls: 'leather',
        pigment: ROPE,
      }).parts,
    );
    g.parts.push(
      P.cloth.legWrap({
        side: S,
        knee: v(B[`shin${S}`]),
        ankle: v(B[`foot${S}`]),
        r: m.shinR,
        turns: 4,
        pigment: 'cloth',
      }),
    );
  }

  // Short working tunic and a sash. Nothing long: a hem near the ankles on a
  // man braced against a rope reads as a robe, and this unit is not a courtier.
  g.parts.push(
    P.cloth.skirt({
      topY: m.waistY + m.torsoLen * 0.04,
      hemY: m.hipY - m.legLen * 0.3,
      rTop: m.waistWidth * 0.6,
      rHem: m.hipWidth * 0.9,
      squash: 0.82,
      folds: 8,
      foldDepth: 0.18,
      pigment: 'cloth',
    }),
  );
  const sash = P.cloth.sash({
    y: m.waistY,
    rx: m.waistWidth * 0.58,
    rz: m.waistDepth * 0.66,
    height: m.torsoLen * 0.12,
    tail: m.torsoLen * 0.34,
    pigment: 'accent',
  });
  g.parts.push(...sash.parts);

  // Light harness: two rows over the chest only. An artillerist is not armoured
  // like a line soldier, and a full cuirass would fight the machine for
  // attention. Laced with `lamellarBand` rather than `cuirass` so the lacing
  // cord can be hemp instead of the army accent — one fewer material pair, and
  // two fewer draw calls per cannon on the board.
  const rows = [
    { y: m.waistY + m.torsoLen * 0.12, rx: m.waistWidth * 0.62, rz: m.waistWidth * 0.48, count: 11, tilt: -0.08, bone: 'spine01' as BoneName },
    { y: m.chestY + m.torsoLen * 0.1, rx: m.chestWidth * 0.62, rz: m.chestWidth * 0.48, count: 11, tilt: -0.1, bone: 'spine02' as BoneName },
  ];
  const plateW = ((Math.PI * 2 * m.chestWidth * 0.55) / 11) * 1.1;
  const harness = P.lamellar.lamellarBand({
    rows,
    plate: {
      w: plateW,
      h: m.torsoLen * 0.28,
      d: plateW * 0.11,
      bevel: plateW * 0.17,
      crown: plateW * 0.03,
    },
    boneHint: 'spine02',
    pigment: 'lacquer',
    cord: true,
    cordPigment: ROPE,
    name: 'crewHarness',
  });
  g.instanced.push(...harness.instanced);

  // Army-specific outer layer, so the two crews are not one crew tinted.
  if (chu) {
    // A long scarf over the shoulder, tailed like the Chu pennant.
    const grid: V3[][] = [];
    for (let r = 0; r < 5; r++) {
      const t = r / 4;
      const yy = m.shoulderY + m.torsoLen * 0.05 - m.torsoLen * 1.05 * t;
      const zz = B.spine02.z + m.chestDepth * (0.5 + t * 0.42);
      const w = m.chestWidth * (0.2 - t * 0.09);
      grid.push([
        [-m.chestWidth * 0.34 + t * m.chestWidth * 0.16 - w, yy, zz],
        [-m.chestWidth * 0.34 + t * m.chestWidth * 0.16 + w, yy, zz],
      ]);
    }
    g.parts.push(
      P.mkPart(
        P.prim.shell(grid, m.chestWidth * 0.02, { name: 'crewScarf' }),
        'cloth',
        'accent',
        'spine02',
        { name: 'crewScarf', allow: ['spine01', 'clavicleL', 'pelvis'] },
      ),
    );
  } else {
    g.parts.push(
      P.cloth.shoulderCape({
        shoulderY: m.shoulderY + m.torsoLen * 0.05,
        r: m.shoulderWidth * 0.74,
        drop: m.torsoLen * 0.42,
        folds: 8,
        pigment: 'cloth',
      }),
    );
  }

  // 巾 hood: the crown tag. Cloth in the army's colour, leather brow band.
  const hood = P.helmet.helmet({
    style: 'hood',
    baseY: B.head.y,
    headLen: m.headLen,
    headWidth: m.headWidth,
    headDepth: m.headDepth,
    z: B.head.z,
    clothPigment: 'cloth',
    metalPigment: ROPE,
  });
  g.parts.push(...hood.parts);
  g.points.crest = hood.points.crest;

  // 環首刀 at the hip.
  const hipAt: V3 = [
    B.pelvis.x - m.hipWidth * 0.66,
    B.pelvis.y + m.torsoLen * 0.02,
    B.pelvis.z + m.hipDepth * 0.14,
  ];
  const sword = P.weapons.scabbard({
    grip: hipAt,
    rot: [0.3, 0, 0.36],
    bone: 'pelvis',
    length: m.height * 0.28,
    width: m.height * 0.034,
    pigment: 'lacquer',
    metalPigment: 'metal',
  });
  g.parts.push(...sword.parts);
  g.points.hip = new THREE.Vector3(...hipAt);
  return g;
}

/** Which `crew.*` mount bone each humanoid bone's geometry is baked onto. */
const CREW_BONE: Record<BoneName, string> = {
  root: 'crew.hips',
  pelvis: 'crew.hips',
  spine01: 'crew.hips',
  spine02: 'crew.chest',
  neck: 'crew.chest',
  head: 'crew.head',
  clavicleL: 'crew.chest',
  upperArmL: 'crew.armL',
  foreArmL: 'crew.foreL',
  handL: 'crew.foreL',
  clavicleR: 'crew.chest',
  upperArmR: 'crew.armR',
  foreArmR: 'crew.foreR',
  handR: 'crew.foreR',
  thighL: 'crew.legL',
  shinL: 'crew.legL',
  footL: 'crew.legL',
  thighR: 'crew.legR',
  shinR: 'crew.legR',
  footR: 'crew.legR',
};

/**
 * Bake a figure built against the humanoid rig onto the `crew.*` mount bones.
 * The shared skeleton can only carry one person, so the second crewman becomes
 * rigid geometry on nine of his own bones — still posable at hips, chest, head,
 * both arms and both legs, which is everything a hauling loop needs.
 */
function bakeOntoCrewBones(g: PartGroup): void {
  for (const p of g.parts) p.mountBone = CREW_BONE[p.boneHint];
  for (const p of g.instanced) p.mountBone = CREW_BONE[p.boneHint];
}

function crewBoneSpecs(B: Bind): PartGroup['bones'] {
  const at = (b: BoneName): V3 => [B[b].x, B[b].y, B[b].z];
  return [
    { name: 'crew.hips', parent: 'root', position: at('pelvis') },
    { name: 'crew.chest', parent: 'crew.hips', position: at('spine02') },
    { name: 'crew.head', parent: 'crew.chest', position: at('head') },
    { name: 'crew.armL', parent: 'crew.chest', position: at('upperArmL') },
    { name: 'crew.foreL', parent: 'crew.armL', position: at('foreArmL') },
    { name: 'crew.armR', parent: 'crew.chest', position: at('upperArmR') },
    { name: 'crew.foreR', parent: 'crew.armR', position: at('foreArmR') },
    { name: 'crew.legL', parent: 'crew.hips', position: at('thighL') },
    { name: 'crew.legR', parent: 'crew.hips', position: at('thighR') },
  ];
}

// ===========================================================================
// Builder
// ===========================================================================

const buildCannon = (ctx: UnitBuildContext): PartGroup => {
  const P = ctx.parts;
  const h = ctx.spec.proportions.height;
  const L = layout(h, ctx.side);
  const rng = ctx.rng;

  const y: Yard = {
    P,
    g: P.emptyGroup(),
    pegs: new Map(),
    pegGeo: pegGeometry(P, 0.019 * h, 0.14 * h),
    pegLen: 0.14 * h,
  };
  const g = y.g;

  // -- mount bones ---------------------------------------------------------
  g.bones.push(
    { name: 'treb.base', parent: 'root', position: [0, 0, 0] },
    { name: 'treb.pivot', parent: 'treb.base', position: L.pivot },
    {
      name: 'treb.beam',
      parent: 'treb.pivot',
      position: L.pivot,
      data: {
        armLength: L.armLen,
        buttLength: L.buttLen,
        armAngle: L.armAngle,
        // Rotating about +X by θ moves the arm from angle φ to φ−θ measured
        // from +Z toward +Y; the loaded arm sits at φ = −armAngle, so throwing
        // it forward over the pivot means driving θ negative. Release once the
        // arm is about 25° past vertical, which is θ ≈ −2.4.
        throwSign: -1,
        releaseAngle: -2.4,
      },
    },
    {
      name: 'treb.sling',
      parent: 'treb.beam',
      position: L.armTip,
      data: {
        cordLength: Math.hypot(L.pouch[1] - L.armTip[1], L.pouch[2] - L.armTip[2]),
        stoneRadius: L.stoneR,
      },
    },
  );

  // -- the machine ---------------------------------------------------------
  buildSled(y, L);
  if (L.chu) buildChuFrame(y, L);
  else buildHanFrame(y, L);
  buildBeam(y, L, rng);

  let rope: Working;
  if (L.chu) {
    g.bones.push(
      { name: 'treb.weight', parent: 'treb.beam', position: L.buttTip },
      { name: 'treb.windlass', parent: 'treb.base', position: [0, L.deckY + 0.2 * h, 0.66 * h] },
    );
    buildCounterweight(y, L);
    rope = buildWindlass(y, L);
  } else {
    g.bones.push({ name: 'treb.yoke', parent: 'treb.beam', position: L.buttTip });
    rope = buildSpreader(y, L);
  }
  buildPennant(y, L);

  // -- crew ----------------------------------------------------------------
  // Both crew need their hands on something before the animator touches them,
  // so each is built against a rig whose forearm and hand bind offsets already
  // put the fists on the rope (Han) or the capstan bar (Chu). `useRig` is
  // called twice per man — once to read where his joints land by default, once
  // with the offsets derived from that — exactly as the fallback does for a
  // seated rider.
  const look: CrewLook = {
    side: ctx.side,
    chu: L.chu,
    rng,
    // Sized to what each army's crew closes on: the haul rope is 0.011h thick,
    // the capstan bar necks to 0.014h at the grips.
    bore: L.chu ? 0.017 * h : 0.0125 * h,
  };

  // Crew B first. He is baked onto his own `crew.*` bones, so the rig he is
  // measured from is discarded and only crew A's rig reaches the skinner. The
  // rig builder is deterministic, so rebuilding crew A's rig afterwards gives
  // back exactly the skeleton his geometry was authored against.
  const probeB = ctx.useRig({ origin: L.crewB });
  // "Reduced scale": the second man is built a hair smaller so the pair reads
  // as two people rather than one mesh used twice.
  const sc = 0.93;
  // A *machine-fixed* grip — the Chu capstan bars — is geometry crew B does not
  // own and is not scaled with him, so his bind pose has to be solved against
  // the grip pre-divided by his reduction. Skip this and the 7% shrink about his
  // feet drags both fists that fraction of the way back toward his standing
  // point, which on the Chu bar is a whole fist's width: the bar ends up beside
  // his hand instead of through it. A haul rope needs none of this — it is
  // routed through the grip points his fists actually publish, afterwards.
  const preScale = (p: V3): V3 => [
    L.crewB[0] + (p[0] - L.crewB[0]) / sc,
    p[1] / sc,
    L.crewB[2] + (p[2] - L.crewB[2]) / sc,
  ];
  const gripB = rope.fixedL
    ? { high: preScale(rope.fixedL.high), low: preScale(rope.fixedL.low) }
    : haulGrip(probeB.metrics, L.crewB, -1, probeB.metrics.shoulderY + 0.02 * h);
  const offB: Offsets = {
    ...braceOffsets(probeB, L.crewB, L.chu ? 0.15 : 0.85),
    ...gripOffsets(probeB, gripB, -1),
  };
  const rigB = ctx.useRig({ origin: L.crewB, offsets: offB });
  // Built in his own space, then stood on his feet beside the sled — the rig is
  // already out there, only the geometry has to be brought to it. See
  // `localBind`; handing `crewFigure` a raw `bindWorld` scatters the man.
  const bindB = localBind(rigB.bindWorld, L.crewB);
  const crewB = crewFigure(P, rigB.metrics, bindB, look);
  bakeOntoCrewBones(crewB);
  crewB.bones.push(...crewBoneSpecs(bindB));
  // He is still standing on his own origin here, so the reduction is about his
  // feet and needs no re-centring; the translation then puts him on the ground
  // beside the sled.
  P.transformGroup(
    crewB,
    new THREE.Matrix4()
      .makeTranslation(L.crewB[0], 0, L.crewB[2])
      .multiply(new THREE.Matrix4().makeScale(sc, sc, sc)),
  );
  const gripBL = crewB.points.gripL.clone();
  const gripBR = crewB.points.gripR.clone();
  // Crew B must not hand his grip points to the factory's implied-socket rule;
  // `gripL`/`gripR` belong to the rigged crewman.
  delete crewB.points.gripL;
  delete crewB.points.gripR;
  delete crewB.points.crest;
  delete crewB.points.hip;

  // Crew A: the rigged figure. His is the rig the factory keeps, and he takes
  // his grip a little higher than crew B so the pair are two men working the
  // same tackle rather than one pose mirrored.
  const probeA = ctx.useRig({ origin: L.crewA });
  const gripA =
    rope.fixedR ?? haulGrip(probeA.metrics, L.crewA, 1, probeA.metrics.shoulderY + 0.12 * h);
  const offA: Offsets = {
    ...braceOffsets(probeA, L.crewA, L.chu ? 0.15 : 0.85),
    ...gripOffsets(probeA, gripA, 1),
  };
  const rigA = ctx.useRig({ origin: L.crewA, offsets: offA });
  const crewA = crewFigure(P, rigA.metrics, localBind(rigA.bindWorld, L.crewA), look);
  // Same rebasing, same reason. Crew A is skinned rather than baked, so this
  // has to happen before the factory solves his weights against `rigA` — a
  // torso sitting a metre from every bone it is supposed to belong to gets
  // whatever the distance field falls back to.
  P.transformGroup(crewA, new THREE.Matrix4().makeTranslation(L.crewA[0], 0, L.crewA[2]));

  const merged = P.mergeGroups(g, crewB, crewA);
  g.parts = merged.parts;
  g.instanced = merged.instanced;
  g.bones = merged.bones;
  g.attach = merged.attach;
  g.points = merged.points;

  // -- the ropes, routed through the fists that actually exist --------------
  // Built last, from the grip points the hands published, so the cord passes
  // through the bore rather than beside it. This is the difference between a
  // crew member holding a rope and a crew member near a rope.
  const gripAL = crewA.points.gripL;
  const gripAR = crewA.points.gripR;
  if (!L.chu) {
    // Spreader → a bend just above the working hand → straight down through
    // both fists → a slack tail. The bend is where the man has pulled the rope
    // back to himself, and it is the only reason the run through the fists can
    // be vertical while the run to the beam is not.
    const haulRope = (head: V3, hi: THREE.Vector3, lo: THREE.Vector3) => {
      const above: V3 = [hi.x, hi.y + 0.13 * h, hi.z - 0.015 * h];
      ropePart(
        y,
        [
          head,
          lerp3(head, above, 0.52),
          above,
          [hi.x, hi.y, hi.z],
          [lo.x, lo.y, lo.z],
          [lo.x + (lo.x - hi.x) * 0.3, lo.y - 0.19 * h, lo.z + 0.05 * h],
        ],
        0.011 * h,
        'treb.yoke',
        'haulRope',
      );
    };
    // Crew A works with his right hand high, crew B with his left — they are on
    // opposite sides of the machine and both take the rope on the outboard arm.
    haulRope(rope.headR, gripAR, gripAL);
    haulRope(rope.headL, gripBL, gripBR);
  }

  // -- attachment sockets --------------------------------------------------
  // `reinL`/`reinR` are the project's "hand IK to a cord" sockets; on the 砲
  // they are the working grips, parented to whichever member moves them, so an
  // IK'd hand tracks the rope through the whole wind-and-release.
  const anchorBone = L.chu ? 'treb.windlass' : 'treb.yoke';
  g.bones.push(
    { name: 'treb.haulA.L', parent: anchorBone, position: [gripAL.x, gripAL.y, gripAL.z] },
    { name: 'treb.haulA.R', parent: anchorBone, position: [gripAR.x, gripAR.y, gripAR.z] },
    { name: 'treb.haulB.L', parent: anchorBone, position: [gripBL.x, gripBL.y, gripBL.z] },
    { name: 'treb.haulB.R', parent: anchorBone, position: [gripBR.x, gripBR.y, gripBR.z] },
  );
  g.attach.push(
    { name: 'gripL', bone: 'handL', position: [gripAL.x, gripAL.y, gripAL.z] },
    { name: 'gripR', bone: 'handR', position: [gripAR.x, gripAR.y, gripAR.z] },
    { name: 'reinL', bone: anchorBone, position: [gripAL.x, gripAL.y, gripAL.z] },
    { name: 'reinR', bone: anchorBone, position: [gripAR.x, gripAR.y, gripAR.z] },
  );
  if (crewA.points.hip) {
    const hip = crewA.points.hip;
    g.attach.push({ name: 'hip', bone: 'pelvis', position: [hip.x, hip.y, hip.z] });
  }
  if (crewA.points.crest) {
    const c = crewA.points.crest;
    g.attach.push({ name: 'crest', bone: 'head', position: [c.x, c.y, c.z] });
  }

  // -- pegs ----------------------------------------------------------------
  for (const [bone, mats] of y.pegs) {
    if (mats.length === 0) continue;
    const part: InstancedPart = {
      geometry: y.pegGeo,
      cls: 'timber',
      pigment: TIMBER,
      boneHint: 'root',
      rigid: true,
      mountBone: bone,
      transforms: mats,
      name: 'pegs',
    };
    g.instanced.push(part);
  }

  return g;
};

registerUnit(PieceType.Cannon, buildCannon);

export { buildCannon };
