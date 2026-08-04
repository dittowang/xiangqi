/**
 * Entry point. Boots the renderer, constructs every subsystem, wires them
 * through the bus, and owns the one frame loop.
 *
 * Construction order is not arbitrary and is the thing most likely to break if
 * someone reorders it:
 *
 *   1. renderer            — the GL context everything else needs
 *   2. render pipeline     — owns the material library; three's own shadow map
 *                            is switched off because the CSM replaces it
 *   3. scene rig           — board, backdrop, lights, camera; takes the
 *                            materials by injection and never builds its own
 *   4. pipeline as a light consumer — the rig owns the light, the pipeline
 *                            follows it, so there is exactly one writer
 *   5. characters          — also takes the materials by injection
 *   6. engine + match      — the model, which nothing visual may write to
 *
 * Per frame there is exactly one draw call site: `pipeline.render()`. If
 * `renderer.render()` appears anywhere else, the post chain runs twice.
 */

import * as THREE from 'three';

import { clock } from '@game/clock.ts';
import { Match } from '@game/match.ts';
import { SaveScheduler, load as loadSave, clear as clearSave } from '@game/persistence.ts';
import { bus } from '@core/bus.ts';
import type { CameraPose, QualitySettings, QualityTier } from '@core/contracts.ts';
import type { DebugFlag, NamedPose, XqFrameStats, XqTestApi } from '@core/testapi.ts';
import { START_FEN } from '@core/testapi.ts';
import { BOARD_HALF_X, BOARD_HALF_Z, worldToSquare } from '@core/coords.ts';
import { type Difficulty, type Move, Side, encodeMove, moveFrom, moveTo } from '@core/types.ts';

import { createRenderPipeline, attachOutlines } from '@render/index.ts';
import { createSceneRig, sealOutlineFromShapes, NAMED_POSES } from '@scene/index.ts';
import { createCharacters, unitsStillFallingBack } from '@characters/index.ts';
import { createEngineClient, legalTargets, findLegalMove } from '@engine/index.ts';
import { getSealGlyph, glyphToShapes } from '@ui/seal.ts';
import { createAudioEngine, pieceDetune } from '@ui/audio.ts';
import { FrameMonitor } from '@perf/instrument.ts';
import { QualityGovernor } from '@perf/governor.ts';

// ---------------------------------------------------------------------------
// 1. Renderer
// ---------------------------------------------------------------------------

const host = document.getElementById('app')!;

const renderer = new THREE.WebGLRenderer({
  antialias: false, // the composer owns MSAA; the default buffer must stay cheap
  alpha: false,
  powerPreference: 'high-performance',
  stencil: false,
});
const startDpr = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(startDpr);
renderer.setSize(window.innerWidth, window.innerHeight);
// The cascaded shadow map in @render replaces three's shadow system entirely.
renderer.shadowMap.enabled = false;
// Gongbi is not photographic, and the grade pass encodes sRGB itself.
renderer.toneMapping = THREE.NoToneMapping;
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// ---------------------------------------------------------------------------
// 2. Render pipeline
// ---------------------------------------------------------------------------

const gl = renderer.getContext() as WebGL2RenderingContext;
const startTier = QualityGovernor.probe(gl);

const pipeline = createRenderPipeline(renderer, {
  width: window.innerWidth,
  height: window.innerHeight,
  dpr: startDpr,
  quality: startTier,
  mood: 'wide',
});

// ---------------------------------------------------------------------------
// 3. Scene: board, backdrop, lights, camera
// ---------------------------------------------------------------------------

const rig = createSceneRig({
  materials: pipeline.materials,
  // The board's incised characters come from our own seal-script outlines.
  // There is no font anywhere in this project.
  seal: (ch: string) => sealOutlineFromShapes(glyphToShapes(getSealGlyph(ch), { size: 1 }), 1),
  detail: startTier === 'low' ? 'medium' : 'high',
  aspect: window.innerWidth / Math.max(window.innerHeight, 1),
  input: renderer.domElement,
});
scene.add(rig.root);

// 4. One writer for the light: the rig owns it, the pipeline follows.
rig.lighting.addConsumer(pipeline);
rig.lighting.setShadowsEnabled(false);
pipeline.setShadowSpec(rig.lighting.csmSpec());

// ---------------------------------------------------------------------------
// 5. Characters
// ---------------------------------------------------------------------------

const characters = createCharacters({
  materials: pipeline.materials,
  onWarn: (m: string) => console.warn('[characters]', m),
  // Fold every instance set under this size into the merged mesh. Instancing
  // saves vertex memory, not triangles, and an InstancedMesh cannot be merged
  // into the material atlas — at the default of 24 the atlas collapse stalls at
  // 534 draw calls because 44 instanced sets refuse to fold. At 64 they all
  // fold, at identical triangle count, and the board lands at 226.
  bakeInstancesBelow: 64,
});

/** Everything that is a figure lives here, so silhouette mode can find it. */
const stage = new THREE.Group();
stage.name = 'units';
scene.add(stage);

// ---------------------------------------------------------------------------
// 6. Engine, audio, match
// ---------------------------------------------------------------------------

const engine = createEngineClient({
  onProgress: (p) =>
    bus.emit('engine:progress', { depth: p.depth, score: p.score, nodes: p.nodes, pv: p.pv }),
});

const audio = createAudioEngine();
window.addEventListener('pointerdown', () => void audio.unlock(), { once: true });

const saved = loadSave();
const match = new Match({
  characters,
  board: rig.board,
  engine,
  stage,
  difficulty: saved?.difficulty ?? 'medium',
  humanSide: saved?.humanSide ?? Side.Red,
});
const saver = new SaveScheduler();

// ---------------------------------------------------------------------------
// Bus wiring
// ---------------------------------------------------------------------------

bus.on('move:end', ({ move }) => {
  audio.play('pieceLand', { pan: panFor(moveTo(move)) });
  saver.request({
    difficulty: match.difficulty,
    fen: START_FEN,
    moves: match.moves.slice(),
    humanSide: match.humanSide,
    result: match.result,
  });
});
bus.on('select', () => audio.play('pieceLift'));
bus.on('check', ({ generalSq }) => {
  audio.play('drumCheck');
  rig.director.pushToCheck(generalSq);
});
bus.on('check:clear', () => rig.director.release());
bus.on('match:end', () => {
  audio.play('gong');
  rig.setPhase('terminal');
});
bus.on('camera:impulse', ({ strength, direction }) =>
  rig.director.impulse(strength, direction ? new THREE.Vector3(...direction) : undefined),
);
bus.on('fx:flash', ({ strength, colour }) => pipeline.flash(strength, colour));
bus.on('eval', ({ cp }) => void cp);

/** Stereo placement from a square's position across the board. */
function panFor(square: number): number {
  const f = square % 9;
  return (f - 4) / 4;
}

// ---------------------------------------------------------------------------
// Input: hover, selection, and moving
// ---------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hitPoint = new THREE.Vector3();

let selected = -1;
let hovered = -1;
let selectedTargets: number[] = [];

/** Which intersection the pointer is over, or -1. */
function pickSquare(ev: PointerEvent): number {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, rig.camera);
  if (!raycaster.ray.intersectPlane(boardPlane, hitPoint)) return -1;
  if (Math.abs(hitPoint.x) > BOARD_HALF_X + 0.6) return -1;
  if (Math.abs(hitPoint.z) > BOARD_HALF_Z + 0.6) return -1;
  return worldToSquare(hitPoint.x, hitPoint.z);
}

renderer.domElement.addEventListener('pointermove', (ev) => {
  const sq = pickSquare(ev);
  if (sq === hovered) return;
  hovered = sq;
  rig.board.setHover(sq >= 0 ? sq : null);
  if (sq >= 0 && selected < 0 && match.humanToMove) {
    const targets = match.targetsFrom(sq);
    if (targets.length) bus.emit('hover', { square: sq, targets });
  }
});

renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const sq = pickSquare(ev);
  if (sq < 0) return;
  if (!match.humanToMove) return;

  // Clicking a legal destination commits the move.
  if (selected >= 0 && selectedTargets.includes(sq)) {
    const move = findLegalMove(match.pos, selected, sq);
    deselect();
    if (move) void playMove(move);
    return;
  }

  // Otherwise select, if the square holds one of the human's pieces.
  const targets = match.targetsFrom(sq);
  if (targets.length) {
    selected = sq;
    selectedTargets = targets;
    rig.board.showLegalMarks(targets);
    bus.emit('select', { square: sq, targets });
  } else {
    deselect();
  }
});

function deselect(): void {
  if (selected < 0) return;
  selected = -1;
  selectedTargets = [];
  rig.board.clearLegalMarks();
  bus.emit('deselect', {});
}

// ---------------------------------------------------------------------------
// Move flow
// ---------------------------------------------------------------------------

/**
 * Apply a move, play its choreography, then let the engine reply.
 *
 * The animation layer is not attached yet, so the "choreography" here is the
 * model settling immediately. When @anim lands, this is where its
 * `Choreographer.walk` / `.capture` promise is awaited — the surrounding flow
 * does not change.
 */
async function playMove(move: Move): Promise<void> {
  const side = match.sideToMove;
  const applied = match.apply(move);
  if (!applied) return;

  match.animating = true;
  if (applied.capture) {
    await rig.director.pushToCapture(applied.capture.attackerSq, applied.capture.defenderSq);
    pipeline.flash(0.85, '#F2E9D6');
    audio.play('bladeStrike', { pan: panFor(applied.capture.defenderSq) });
    rig.director.release();
  }
  match.animating = false;

  match.settle(move, side, applied.notation);
  audio.setIntensity(match.materialLeft());

  if (!match.over && match.sideToMove !== match.humanSide) {
    const reply = await match.think();
    if (reply) await playMove(reply);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const monitor = new FrameMonitor();
const governor = new QualityGovernor(startTier, (q: QualitySettings) => {
  pipeline.applyQualitySettings(q);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.maxPixelRatio));
});

let booted = false;
let firstFrameResolve: (() => void) | null = null;
const firstFrame = new Promise<void>((res) => (firstFrameResolve = res));

async function boot(): Promise<void> {
  await characters.prewarm();
  const stillFallback = unitsStillFallingBack();
  if (stillFallback.length) {
    console.warn('[characters] still using the generic fallback figure:', stillFallback.join(', '));
  }
  await match.begin(saved?.moves);
  // Give every figure its ink-and-gold line work.
  for (const view of match.views.values()) attachOutlines(view.unit.root, pipeline.materials);
  rig.setPhase('development', 0);
  booted = true;
  bus.emit('match:start', { difficulty: match.difficulty, resumed: !!saved?.moves.length });
}

void boot().catch((err) => {
  console.error('[boot] failed', err);
  // A stale save is the likeliest cause; drop it so a reload recovers.
  clearSave();
});

// ---------------------------------------------------------------------------
// Frame loop — the only draw call site in the project
// ---------------------------------------------------------------------------

function frame(nowMs: number): void {
  requestAnimationFrame(frame);
  const dt = clock.tick(nowMs);
  monitor.begin(nowMs);

  rig.update(dt);
  audio.update(dt);
  saver.update(dt);
  if (booted) governor.update(dt, monitor.percentile(0.95));

  pipeline.render(scene, rig.camera, dt);

  // Measured after the draw call rather than around renderer.render(), which
  // on WebGL only *submits* work and reports a frame time near zero.
  monitor.end(performance.now(), dt);

  if (firstFrameResolve && booted) {
    const r = firstFrameResolve;
    firstFrameResolve = null;
    document.getElementById('veil')?.classList.add('lifted');
    r();
  }
}
requestAnimationFrame(frame);

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  pipeline.setSize(w, h, Math.min(window.devicePixelRatio || 1, governor.settings.maxPixelRatio));
  rig.resize(w, h);
});

// ---------------------------------------------------------------------------
// The capture harness's control surface
// ---------------------------------------------------------------------------

/** Advance the clock by `seconds` and render exactly one frame. */
function stepOnce(seconds: number): Promise<void> {
  clock.queueStep(seconds);
  return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
}

let hudVisible = true;

const api: XqTestApi = {
  ready: () => firstFrame,

  pause: () => clock.pause(),
  resume: () => clock.resume(),
  step: (s) => stepOnce(s),
  stepFrames: async (n, s = 1 / 60) => {
    for (let i = 0; i < n; i++) await stepOnce(s);
  },
  settle: async (maxSeconds = 4) => {
    const limit = Math.ceil(maxSeconds * 60);
    for (let i = 0; i < limit; i++) {
      await stepOnce(1 / 60);
      if (rig.director.settled() && !match.animating && !match.thinking) return;
    }
  },

  setPosition: async (fen: string) => {
    match.pos.setFen(fen);
    match.moves.length = 0;
    match.notation.length = 0;
    match.sync();
    for (const view of match.views.values()) attachOutlines(view.unit.root, pipeline.materials);
    rig.setPhase('development', 0);
    await stepOnce(0);
  },
  getPosition: () => match.pos.toFen(),
  playMove: async (from, to) => {
    const m = findLegalMove(match.pos, from, to);
    if (m) await playMove(m);
  },
  forceMove: (from, to) => {
    const m = findLegalMove(match.pos, from, to);
    if (!m) return;
    match.pos.makeMove(m);
    match.moves.push(m);
    match.sync();
  },
  legalMoves: (from?: number): Move[] =>
    from === undefined
      ? match.legalMoves()
      : match.targetsFrom(from).map((t) => encodeMove(from, t, match.pos.board[t])),
  setDifficulty: (d: Difficulty) => {
    match.difficulty = d;
  },
  setHumanSide: (s: Side) => {
    match.humanSide = s;
  },

  // Choreography scrubbing arrives with @anim. Kept as empty-bodied async
  // methods, deliberately: the harness probes for their presence to decide
  // whether to capture or to skip with a reason, and deleting them would turn
  // "56 shots skipped, here is why" into "the harness crashed".
  seekCapture: async () => {},
  seekFormation: async () => {},
  seekUnitState: async () => {},

  setPose: (p: Partial<CameraPose>, immediate?: boolean) =>
    rig.director.setPosePartial(p, immediate !== false),
  getPose: () => rig.director.getPose(),
  setNamedPose: (n: NamedPose, immediate?: boolean) =>
    rig.director.setNamedPose(n, immediate !== false),
  setSilhouette: (on: boolean) => {
    pipeline.setSilhouetteMode(on);
    rig.setSilhouetteMode(on);
  },
  setHudVisible: (on: boolean) => {
    hudVisible = on;
  },
  setQuality: (tier) => governor.force(tier === 'auto' ? null : (tier as QualityTier)),
  showcase: async () => {},
  exitShowcase: async () => {},
  setDebug: (flag: DebugFlag, on: boolean) => pipeline.setDebug(flag, on),

  stats: (): XqFrameStats => ({
    fps: monitor.fps,
    frameMs: monitor.smoothedMs,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.programs?.length ?? 0,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    worstMs: monitor.worstMs,
    quality: governor.tier,
    pixelRatio: renderer.getPixelRatio(),
  }),
  resetStats: () => {
    monitor.reset();
    renderer.info.reset();
  },
  describe: () => ({
    phase: booted ? 'development' : 'boot',
    ply: match.ply,
    sideToMove: match.sideToMove,
    inCheck: match.inCheck,
    result: match.result.kind,
    pieces: [...match.views.entries()].map(([square, v]) => ({
      square,
      code: (v.side << 3) | v.type,
    })),
  }),
};

window.__XQ = api;

// Keep the unused-but-intentional bindings honest for the type checker.
void hudVisible;
void legalTargets;
void moveFrom;
void pieceDetune;
void NAMED_POSES;
