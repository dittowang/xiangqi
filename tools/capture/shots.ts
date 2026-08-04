/**
 * The canonical shot list, as data.
 *
 * Every visual claim anyone makes about this project should be traceable to a
 * named entry in this file. "The chariot reads as a chariot in silhouette" is
 * an opinion; `silhouettes/red-chariot.png` is a measurement. Critics are
 * pointed at names from here, so the names are a stable vocabulary and should
 * change about as often as the palette does.
 *
 * A shot declares which parts of `window.__XQ` it needs (`requires`). When the
 * build cannot honour one — during bootstrap most of the position and
 * choreography surface is a no-op stub — the runner skips that shot and says
 * so, instead of writing 42 identical pictures of an empty board and calling it
 * a pass.
 */

import type { NamedPose } from '@core/testapi.ts';
import { START_FEN } from '@core/testapi.ts';
import { PIECE_TYPES, Side, UNIT_KEY, type UnitKey } from '@core/types.ts';
import type { Driver, XqMethod } from './driver.ts';
import type { FramePolicy } from './png.ts';

export type SuiteName = 'stills' | 'silhouettes' | 'units' | 'motion' | 'perf';
export const SUITE_NAMES: readonly SuiteName[] = ['stills', 'silhouettes', 'units', 'motion', 'perf'];

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/**
 * Hand-built FENs, each reachable from the opening position by legal play so
 * they stay valid once the engine can check them.
 *
 * `midgame` is ten plies of a central-cannon-versus-screen-horses opening:
 * 炮二平五 馬８進７ / 傌二進三 馬２進３ / 俥一平二 卒７進１ / 俥二進六 車９平８ /
 * 兵三進一 卒３進１. Both armies are developed, the red chariot has crossed to
 * b5, and the board still has 30 pieces on it — the busiest frame the renderer
 * will ever be asked for.
 *
 * `endgame` is deliberately sparse and asymmetric: seven pieces, a long
 * diagonal of empty board, and the low cool light the endgame mood grades to.
 */
export const FENS = {
  start: START_FEN,
  midgame: 'r1bakabr1/9/1cn3nc1/p3p3p/2p3p2/1RP6/P3P1P1P/2N1C2C1/9/2BAKABNR w - - 10 6',
  endgame: '3ak1b2/9/1r7/9/4p4/4R4/9/3N5/4A4/2B1K4 b - - 4 42',
} as const;

/** `rank * 9 + file`, matching core/coords.ts. Spelled out for the shot list. */
const sq = (file: number, rank: number) => rank * 9 + file;

/**
 * Capture pairs for the motion suite. Each carries its own position so the
 * exchange being scrubbed is a legal move rather than a plausible-looking one,
 * and each was chosen for a different weight class: the three-beat choreography
 * has to read differently for a chariot crushing a horse and for a soldier
 * taking a chariot.
 */
export interface CapturePair {
  name: string;
  label: string;
  fen: string;
  from: number;
  to: number;
}

export const CAPTURE_PAIRS: readonly CapturePair[] = [
  {
    name: 'chariot-takes-horse',
    label: '俥 takes 馬 — heavy melee, e5 x e2',
    fen: '3aka3/9/4n4/9/9/4R4/9/9/9/3AKA3 w - - 0 1',
    from: sq(4, 5),
    to: sq(4, 2),
  },
  {
    name: 'cannon-takes-chariot',
    label: '炮 takes 車 — ranged over a screen, e7 x e2',
    fen: '3aka3/9/4r4/9/4p4/9/9/4C4/9/3AKA3 w - - 0 1',
    from: sq(4, 7),
    to: sq(4, 2),
  },
  {
    name: 'horse-takes-soldier',
    label: '傌 takes 卒 — cantering strike, d7 x e5',
    fen: '3aka3/9/9/9/9/4p4/9/3N5/9/3AKA3 w - - 0 1',
    from: sq(3, 7),
    to: sq(4, 5),
  },
  {
    name: 'elephant-takes-soldier',
    label: '相 takes 卒 — trunk sweep, c9 x e7',
    fen: '3aka3/9/9/9/9/9/9/4p4/9/2B1K4 w - - 0 1',
    from: sq(2, 9),
    to: sq(4, 7),
  },
  {
    name: 'soldier-takes-chariot',
    label: '兵 takes 車 — the small unit landing a kill, e4 x e3',
    fen: '3aka3/9/9/4r4/4P4/9/9/9/9/3AKA3 w - - 0 1',
    from: sq(4, 4),
    to: sq(4, 3),
  },
];

/**
 * One representative unit per locomotion mode. `UnitMeta.gait` is the authority
 * — this table is the harness's expectation of which unit demonstrates which
 * gait, and if the characters author assigns them differently, fix it here.
 */
export const GAIT_UNITS: readonly { gait: string; unit: UnitKey }[] = [
  { gait: 'march', unit: 'soldier' },
  { gait: 'stride', unit: 'general' },
  { gait: 'canter', unit: 'horse' },
  { gait: 'lumber', unit: 'elephant' },
  { gait: 'roll', unit: 'chariot' },
  { gait: 'crew', unit: 'cannon' },
];

export const UNIT_KEYS: readonly UnitKey[] = PIECE_TYPES.map((t) => UNIT_KEY[t] as UnitKey);
export const SIDES: readonly { side: Side; slug: string; hanzi: string }[] = [
  { side: Side.Red, slug: 'red', hanzi: '漢' },
  { side: Side.Black, slug: 'black', hanzi: '楚' },
];

// ---------------------------------------------------------------------------
// Frame policies
// ---------------------------------------------------------------------------

/**
 * A silhouette shot is mostly one colour by design, so the generic "99% of one
 * colour means the harness lied" rule would either fire constantly or have to
 * be switched off. Instead it is replaced with a stronger, shape-specific
 * assertion: the frame must contain real ink *and* real paper. A black frame
 * fails on the missing paper, a white frame fails on the missing ink, and a
 * correctly rendered silhouette passes both.
 */
export const SILHOUETTE_POLICY: FramePolicy = {
  maxDominantFraction: 0.996,
  minDarkFraction: 0.004,
  minLightFraction: 0.05,
};

/** Ordinary lit shots: the default blank check plus a little tonal spread. */
export const SCENE_POLICY: FramePolicy = {
  maxDominantFraction: 0.99,
  minStdLuma: 0.01,
};

// ---------------------------------------------------------------------------
// Shot types
// ---------------------------------------------------------------------------

interface BaseShot {
  name: string;
  label: string;
  /** `__XQ` methods this shot cannot be honest without. */
  requires?: XqMethod[];
  expect?: FramePolicy;
}

export interface StillShot extends BaseShot {
  kind: 'still';
  setup(d: Driver): Promise<void>;
  clip?: { x: number; y: number; width: number; height: number };
}

export interface SheetShot extends BaseShot {
  kind: 'sheet';
  frames: number;
  subtitle?: string;
  cols?: number;
  /** CSS-pixel crop applied to every cell — used for tall line-ups. */
  cellClip?: { x: number; y: number; width: number; height: number };
  /** Also write every cell as its own PNG so a critic can zoom one beat. */
  keepFrames?: boolean;
  setup?(d: Driver): Promise<void>;
  /** Drive the scene to cell `i` and return its burned-in labels. */
  sample(d: Driver, i: number, frames: number): Promise<{ label: string; caption: string }>;
  teardown?(d: Driver): Promise<void>;
}

export interface PerfShot extends BaseShot {
  kind: 'perf';
  frames: number;
  dt: number;
  setup(d: Driver): Promise<void>;
}

export type Shot = StillShot | SheetShot | PerfShot;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load a position and let anything it kicked off settle before capturing. */
async function position(d: Driver, fen: string): Promise<void> {
  await d.setPosition(fen);
  await d.settle(2);
}

async function framed(d: Driver, pose: NamedPose): Promise<void> {
  await d.setNamedPose(pose, true);
  await d.setHudVisible(false);
  await d.step(0);
}

/**
 * Showcase one unit at a camera yaw. `showcase()` also accepts a `turntable`
 * angle, but rotating the *camera* is driven entirely by `setPose`, which is
 * live from the very first bootstrap — so the angle sweep works against any
 * build that can put a unit on screen at all.
 */
async function showcaseAt(d: Driver, side: Side, unit: UnitKey, yaw: number): Promise<boolean> {
  const ok = await d.showcase(side, unit);
  await d.setNamedPose('portrait', true);
  await d.setPose({ yaw }, true);
  await d.setHudVisible(false);
  await d.settle(1.5);
  return ok;
}

const THREE_ANGLES = [
  { slug: 'front', yaw: 0, label: 'front' },
  { slug: 'threequarter', yaw: 0.85, label: 'three-quarter' },
  { slug: 'profile', yaw: Math.PI / 2, label: 'profile' },
];

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

/** Named framings at the opening position, plus a mid-game and an endgame. */
function stills(): Shot[] {
  const poses: { pose: NamedPose; label: string }[] = [
    { pose: 'default', label: 'resting play framing — high, wide, 50° pitch' },
    { pose: 'top', label: 'plan view — board, grid and palace diagonals' },
    { pose: 'threeQuarterRed', label: "three-quarter close on Red's back rank" },
    { pose: 'threeQuarterBlack', label: "three-quarter close on Black's back rank" },
    { pose: 'overShoulder', label: 'over-the-shoulder — the capture framing' },
    { pose: 'portrait', label: 'portrait — one unit at board centre, eye level' },
    { pose: 'endgame', label: 'endgame framing — low, long, cool' },
    { pose: 'profile', label: "profile from Red's right — gait and contact reference" },
  ];

  const out: Shot[] = poses.map(({ pose, label }) => ({
    kind: 'still',
    name: pose,
    label: `${label} · opening position`,
    expect: SCENE_POLICY,
    async setup(d) {
      await position(d, FENS.start);
      await framed(d, pose);
    },
  }));

  for (const [slug, pose, label] of [
    ['midgame-default', 'default', 'mid-game, thirty pieces on the board'],
    ['midgame-overShoulder', 'overShoulder', 'mid-game, over-the-shoulder'],
    ['endgame-endgame', 'endgame', 'endgame, seven pieces, cool low light'],
    ['endgame-default', 'default', 'endgame from the resting framing'],
  ] as const) {
    out.push({
      kind: 'still',
      name: slug,
      label,
      requires: ['setPosition'],
      expect: SCENE_POLICY,
      async setup(d) {
        await position(d, slug.startsWith('midgame') ? FENS.midgame : FENS.endgame);
        await framed(d, pose);
      },
    });
  }

  /**
   * Eight azimuths around the board.
   *
   * It answers a real question — ARCHITECTURE.md's bar for `scene` is that the
   * board reads as a physical object with depth rather than a textured plane,
   * and one frame cannot show that; a turntable can. It also earns its keep as
   * the harness's own canary: it is the only sheet in the whole shot list that
   * depends on nothing but `setPose`, which has been live since the first
   * bootstrap. Every other sheet is gated behind a subsystem that may not exist
   * yet, so without this one the contact-sheet machinery could rot untested for
   * weeks and nobody would find out until the motion critic asked for a clip.
   */
  out.push({
    kind: 'sheet',
    name: 'board-turntable',
    label: 'board turntable — eight azimuths at the resting framing',
    subtitle: 'the board must read as an object with depth, not a textured plane',
    frames: 8,
    cols: 4,
    keepFrames: true,
    expect: SCENE_POLICY,
    async setup(d) {
      await position(d, FENS.start);
      await framed(d, 'default');
    },
    async sample(d, i, frames) {
      const yaw = (i / frames) * Math.PI * 2;
      await d.setPose({ yaw }, true);
      await d.step(0);
      return { label: String(i).padStart(2, '0'), caption: `yaw ${((yaw * 180) / Math.PI) | 0}°` };
    },
  });
  return out;
}

/**
 * Readability. Everything here runs in silhouette mode: flat black units on a
 * white ground, no outlines, no HUD. The bar is that all 32 units are nameable
 * from shape alone, and the line-up sheets are the exact image that question
 * gets asked of.
 */
function silhouettes(): Shot[] {
  const out: Shot[] = [
    {
      kind: 'still',
      name: 'board-silhouette',
      label: 'full board in silhouette, low and level — the army-scale read',
      requires: ['setSilhouette'],
      expect: SILHOUETTE_POLICY,
      async setup(d) {
        await position(d, FENS.start);
        await d.setSilhouette(true);
        await framed(d, 'silhouette');
      },
    },
    {
      kind: 'still',
      name: 'board-silhouette-top',
      label: 'full board in silhouette from above — footprint separation',
      requires: ['setSilhouette'],
      expect: SILHOUETTE_POLICY,
      async setup(d) {
        await position(d, FENS.start);
        await d.setSilhouette(true);
        await framed(d, 'top');
      },
    },
    {
      kind: 'still',
      name: 'board-silhouette-midgame',
      label: 'mid-game silhouette — units overlapping across the river',
      requires: ['setSilhouette', 'setPosition'],
      expect: SILHOUETTE_POLICY,
      async setup(d) {
        await position(d, FENS.midgame);
        await d.setSilhouette(true);
        await framed(d, 'silhouette');
      },
    },
  ];

  // Every unit, isolated.
  for (const { side, slug, hanzi } of SIDES) {
    for (const unit of UNIT_KEYS) {
      out.push({
        kind: 'still',
        name: `${slug}-${unit}`,
        label: `${hanzi} ${unit} — isolated silhouette`,
        requires: ['setSilhouette', 'showcase'],
        expect: SILHOUETTE_POLICY,
        async setup(d) {
          await d.setSilhouette(true);
          await showcaseAt(d, side, unit, 0.85);
        },
      });
    }
  }

  // The line-up sheets: seven unit types side by side, one army per sheet.
  // This is the single image the readability critic is handed.
  for (const { side, slug, hanzi } of SIDES) {
    out.push({
      kind: 'sheet',
      name: `lineup-${slug}`,
      label: `${hanzi} army line-up — all seven unit types in silhouette`,
      subtitle: 'every unit at the same camera and scale; no two may share a shape',
      requires: ['setSilhouette', 'showcase'],
      frames: UNIT_KEYS.length,
      cols: UNIT_KEYS.length,
      // A tall centred column per unit, so the sheet reads as a parade rather
      // than seven letterboxes with a figure lost in the middle of each.
      cellClip: { x: 460, y: 60, width: 360, height: 700 },
      expect: SILHOUETTE_POLICY,
      async setup(d) {
        await d.setSilhouette(true);
      },
      async sample(d, i) {
        const unit = UNIT_KEYS[i]!;
        await showcaseAt(d, side, unit, 0.85);
        return { label: unit.slice(0, 3), caption: unit };
      },
      async teardown(d) {
        await d.exitShowcase();
        await d.setSilhouette(false);
      },
    });
  }
  return out;
}

/** Character review: each of the fourteen (side, type) pairs, lit, from three angles. */
function units(): Shot[] {
  const out: Shot[] = [];
  for (const { side, slug, hanzi } of SIDES) {
    for (const unit of UNIT_KEYS) {
      for (const angle of THREE_ANGLES) {
        out.push({
          kind: 'still',
          name: `${slug}-${unit}-${angle.slug}`,
          label: `${hanzi} ${unit} — ${angle.label}`,
          requires: ['showcase'],
          expect: SCENE_POLICY,
          async setup(d) {
            await showcaseAt(d, side, unit, angle.yaw);
          },
        });
      }
      out.push({
        kind: 'sheet',
        name: `${slug}-${unit}-turntable`,
        label: `${hanzi} ${unit} — turntable`,
        subtitle: 'eight camera azimuths, 45° apart, portrait framing',
        requires: ['showcase'],
        frames: 8,
        cols: 4,
        keepFrames: false,
        expect: SCENE_POLICY,
        async sample(d, i, frames) {
          const yaw = (i / frames) * Math.PI * 2;
          await showcaseAt(d, side, unit, yaw);
          return { label: String(i).padStart(2, '0'), caption: `${((yaw * 180) / Math.PI) | 0}°` };
        },
        async teardown(d) {
          await d.exitShowcase();
        },
      });
    }
  }
  return out;
}

/**
 * Motion. Sixteen samples across the whole three-beat exchange, and one full
 * cycle of every gait. Sixteen is chosen so the impact hold — which the
 * choreography stretches with a 0.06 time scale — occupies several cells rather
 * than falling between two of them.
 */
function motion(): Shot[] {
  const out: Shot[] = [];
  for (const pair of CAPTURE_PAIRS) {
    out.push({
      kind: 'sheet',
      name: `capture-${pair.name}`,
      label: pair.label,
      subtitle: `seekCapture(${pair.from}, ${pair.to}, t) · t = 0 … 1 · ${pair.fen}`,
      requires: ['seekCapture', 'setPosition'],
      frames: 16,
      cols: 4,
      keepFrames: true,
      expect: SCENE_POLICY,
      async setup(d) {
        await position(d, pair.fen);
        await framed(d, 'overShoulder');
      },
      async sample(d, i, frames) {
        const t = i / (frames - 1);
        await d.seekCapture(pair.from, pair.to, t);
        await d.step(0);
        return { label: String(i).padStart(2, '0'), caption: `t ${t.toFixed(3)}` };
      },
    });
  }

  for (const { gait, unit } of GAIT_UNITS) {
    out.push({
      kind: 'sheet',
      name: `walk-${gait}-${unit}`,
      label: `${gait} gait — ${unit}, one full cycle`,
      subtitle: 'profile framing; feet must not slide and wheels must match ground travel',
      requires: ['seekUnitState'],
      frames: 12,
      cols: 6,
      keepFrames: true,
      expect: SCENE_POLICY,
      async setup(d) {
        await framed(d, 'profile');
      },
      async sample(d, i, frames) {
        const t = i / frames; // a cycle is periodic: t = 1 would repeat cell 0
        await d.seekUnitState(Side.Red, unit, 'move', t, { isolate: true });
        await d.step(0);
        return { label: String(i).padStart(2, '0'), caption: `t ${t.toFixed(3)}` };
      },
    });
  }
  return out;
}

/**
 * Performance. The opening position is the worst case the budget is written
 * against: thirty-two units on screen, every one of them skinned and outlined.
 */
function perf(): Shot[] {
  return [
    {
      kind: 'perf',
      name: 'perf-32-units',
      label: 'thirty-two units, resting framing, ultra tier',
      frames: 120,
      dt: 1 / 60,
      expect: SCENE_POLICY,
      async setup(d) {
        await position(d, FENS.start);
        await d.setQuality('ultra');
        await framed(d, 'default');
      },
    },
    {
      kind: 'perf',
      name: 'perf-32-units-close',
      label: 'thirty-two units, over-the-shoulder — the heaviest overdraw',
      frames: 120,
      dt: 1 / 60,
      expect: SCENE_POLICY,
      async setup(d) {
        await position(d, FENS.start);
        await d.setQuality('ultra');
        await framed(d, 'overShoulder');
      },
    },
  ];
}

const BUILDERS: Record<SuiteName, () => Shot[]> = { stills, silhouettes, units, motion, perf };

export function shotsFor(suite: SuiteName): Shot[] {
  return BUILDERS[suite]();
}

/** ARCHITECTURE.md's perf budget, checked by the perf suite. */
export const PERF_BUDGET = {
  frameMs: 16.6,
  spikeMs: 20,
  drawCalls: 260,
  triangles: 900_000,
} as const;
