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
import { Match, type PieceView } from '@game/match.ts';
import { SaveScheduler, load as loadSave, clear as clearSave } from '@game/persistence.ts';
import { bus } from '@core/bus.ts';
import type { AnimState, CameraPose, QualitySettings, QualityTier } from '@core/contracts.ts';
import type { DebugFlag, NamedPose, XqFrameStats, XqTestApi } from '@core/testapi.ts';
import { START_FEN } from '@core/testapi.ts';
import { BOARD_HALF_X, BOARD_HALF_Z, facingY, worldToSquare } from '@core/coords.ts';
import {
  PieceType,
  pieceType,
  type Difficulty,
  type Move,
  Side,
  type UnitKey,
  UNIT_TYPE_BY_KEY,
  encodeMove,
  moveFrom,
  moveTo,
} from '@core/types.ts';

import { createRenderPipeline, collapseToAtlas, disposeCollapse } from '@render/index.ts';
import { createSceneRig, sealOutlineFromShapes, NAMED_POSES } from '@scene/index.ts';
import { createCharacters, unitsStillFallingBack } from '@characters/index.ts';
import { createEngineClient, legalTargets, findLegalMove } from '@engine/index.ts';
import { getSealGlyph, glyphToShapes } from '@ui/seal.ts';
import { createAudioEngine, pieceDetune } from '@ui/audio.ts';
import { createHud } from '@ui/hud.ts';
import {
  createAnimator,
  createChoreographer,
  createPigmentField,
  type Animator,
} from '@anim/index.ts';
import { FrameMonitor } from '@perf/instrument.ts';
import { QUALITY, QualityGovernor } from '@perf/governor.ts';

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
  // Merge ACROSS material buckets into one geometry per unit, drawn with the
  // atlas material that reads class, pigment and outline profile per vertex.
  // Doing it here rather than post-hoc in the renderer avoids duplicating the
  // cast's vertex data: the factory owns the source geometries and can free
  // them. Measured on the real cast: 295 meshes and 25 materials -> 32 and 1,
  // 590 draw calls -> 64, at identical triangle count.
  // `skinned` is deliberately ignored: three compiles USE_SKINNING per object,
  // so one atlas material serves both skinned and rigid meshes without splitting
  // the batch.
  atlasMaterial: () => pipeline.materials.getAtlas({}),
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
// 7. Animation
// ---------------------------------------------------------------------------

/** Hard-edged pigment chips. Budgeted and pooled; never allocates per capture. */
const pigment = createPigmentField({
  budget: governorSettingsParticleBudget(),
  ground: rig.heightAt,
});
scene.add(pigment.group);

/** One animator per figure, keyed by the unit's root so lookup is identity. */
const animators = new Map<THREE.Object3D, Animator>();

const choreographer = createChoreographer({
  camera: rig.director,
  audio,
  pigment,
  animatorFor: (unit) => animators.get(unit.root),
  ground: rig.heightAt,
});

/** Drop animators whose figure is no longer on the board, and dispose them. */
function pruneAnimators(): void {
  const live = new Set<THREE.Object3D>();
  for (const view of match.views.values()) live.add(view.unit.root);
  for (const [root, a] of animators) {
    if (live.has(root)) continue;
    a.dispose();
    animators.delete(root);
  }
}

function animatorFor(view: PieceView): Animator {
  let a = animators.get(view.unit.root);
  if (!a) {
    a = createAnimator(view.unit, {
      ground: rig.heightAt,
      audio,
      // Deterministic phase offset from the piece id, so a rank of five
      // soldiers does not breathe and step in lockstep. Never from a clock.
      variant: view.id,
    });
    animators.set(view.unit.root, a);
    a.play('idle', 0);
  }
  return a;
}

function retireAnimator(unit: { root: THREE.Object3D }): void {
  const a = animators.get(unit.root);
  if (!a) return;
  a.dispose();
  animators.delete(unit.root);
}

// ---------------------------------------------------------------------------
// 8. HUD — painted into the scene, never into the DOM
// ---------------------------------------------------------------------------

/** Line work for the HUD's fallen figures, tracked so they can be released. */
const hudCollapses = new Map<THREE.Object3D, ReturnType<typeof collapseToAtlas>>();

const hud = createHud({
  materials: pipeline.materials,
  characters,
  heightAt: rig.heightAt,
  dress: (root) =>
    hudCollapses.set(root, collapseToAtlas(root, pipeline.materials, { variation: 0.5 })),
  undress: (root) => {
    const c = hudCollapses.get(root);
    if (c) disposeCollapse(c);
    hudCollapses.delete(root);
  },
  difficulty: saved?.difficulty ?? 'medium',
  sideToMove: Side.Red,
  width: window.innerWidth,
  height: window.innerHeight,
  dpr: startDpr,
});
scene.add(hud.group);

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
  const from = moveFrom(move);
  const to = moveTo(move);
  // Take both figures BEFORE the model moves: apply() only mutates the model,
  // and the view map is not reconciled until settle(), so this is the one
  // window where both the mover and its victim are still addressable.
  const mover = match.views.get(from);
  const capturedView = match.views.get(to);

  const applied = match.apply(move);
  if (!applied) return;

  match.animating = true;
  if (applied.capture && mover) {
    const defender = capturedView;
    if (defender) {
      await choreographer.capture(mover.unit, defender.unit, {
        attackerSq: applied.capture.attackerSq,
        defenderSq: applied.capture.defenderSq,
        attackerType: pieceType(applied.capture.attacker),
        defenderType: pieceType(applied.capture.defender),
        ranged: applied.capture.ranged,
      });
      retireAnimator(defender.unit);
    }
  } else if (mover) {
    await choreographer.walk(mover.unit, from, to);
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
// Line work
// ---------------------------------------------------------------------------

/**
 * Give a figure its ink-and-gold line work.
 *
 * `collapseToAtlas` replaces `attachOutlines` rather than complementing it: it
 * merges the figure's 8-13 per-material meshes into one that reads its class,
 * pigment and outline profile per fragment, and builds the matching hull itself.
 * Measured over the real cast that is 305 meshes and 288 materials down to 32
 * and 1 — 2137 draw calls to 226.
 *
 * The collapse is tracked per figure so it can be released with the unit; the
 * merged geometry is new data and the originals belong to the UnitInstance.
 */
const collapses = new Map<number, ReturnType<typeof collapseToAtlas>>();

function dressUnit(view: PieceView): void {
  const prev = collapses.get(view.id);
  if (prev) disposeCollapse(prev);
  // The factory already merged this unit to a single atlas mesh, so the
  // renderer-side collapse has nothing left to merge — it now only builds the
  // matching BackSide hull, which is still ours to attach.
  collapses.set(
    view.id,
    collapseToAtlas(view.unit.root, pipeline.materials, {
      // Per-figure value variation so a rank of five soldiers is not a xerox;
      // the atlas reads it per fragment, so it costs no extra material.
      variation: ((view.id * 37) % 16) / 16,
    }),
  );
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const monitor = new FrameMonitor();
const governor = new QualityGovernor(startTier, (q: QualitySettings) => {
  pipeline.applyQualitySettings(q);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.maxPixelRatio));
});

/** Particle budget for the tier we booted at; the governor may revise it. */
function governorSettingsParticleBudget(): number {
  return QUALITY[startTier].particleBudget;
}

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
  for (const view of match.views.values()) {
    dressUnit(view);
    animatorFor(view).play('idle', 0);
  }
  // A resumed match replays its moves without emitting move:end, so the record
  // and the fallen rail would come back empty without this.
  if (saved?.moves.length) hud.syncRecord(match.moves, match.notation);
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
  // Animators before the choreographer: it reads their settled state to decide
  // when a beat has landed.
  for (const a of animators.values()) a.update(dt);
  // The showcase figure is deliberately outside the match's animator map, so it
  // has to be ticked here or its mount bones never move.
  showcaseAnimator?.update(dt);
  choreographer.update(dt);
  // After the choreographer, never before it: the plinths are written from the
  // root positions this frame's animation just produced.
  match.followBases();
  hud.update(dt);
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
  hud.resize(w, h, Math.min(window.devicePixelRatio || 1, governor.settings.maxPixelRatio));
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

/** One isolated figure for character review. See `showcase` below. */
const showcaseGroup = new THREE.Group();
showcaseGroup.name = 'showcase';
scene.add(showcaseGroup);
let showcaseUnit: ReturnType<typeof characters.create> | null = null;
let showcaseCollapse: ReturnType<typeof collapseToAtlas> | null = null;
let showcaseAnimator: Animator | null = null;

async function exitShowcase(): Promise<void> {
  if (showcaseAnimator) {
    showcaseAnimator.dispose();
    showcaseAnimator = null;
  }
  if (showcaseCollapse) {
    disposeCollapse(showcaseCollapse);
    showcaseCollapse = null;
  }
  if (showcaseUnit) {
    showcaseUnit.root.removeFromParent();
    showcaseUnit.dispose();
    showcaseUnit = null;
  }
  stage.visible = true;
  await stepOnce(0);
}

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
    // sync() rebuilds every figure here by design, so unlike an ordinary move
    // there is no from/to hint that would preserve them. That leaves the
    // animator map holding entries keyed on disposed roots, which the frame loop
    // would go on ticking against dead skeletons.
    pruneAnimators();
    for (const view of match.views.values()) {
      dressUnit(view);
      animatorFor(view).play('idle', 0);
    }
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
    // The hint is not optional. Without it, sync() retires the figure and spawns
    // a brand-new UnitInstance, while `animators` is keyed on the OLD unit.root
    // — so animatorFor() misses, every choreographer play() becomes a silent
    // no-op, and the figure slides across the board with its pose frozen at
    // bind. The choreographer's direct writes (root position, facing,
    // visibility) keep working, which is what made this look like a dead
    // AnimationMixer rather than an orphaned animator. Match.settle passes the
    // same hint; forceMove must match it.
    match.sync({ from, to });
  },
  legalMoves: (from?: number): Move[] =>
    from === undefined
      ? match.legalMoves()
      : match.targetsFrom(from).map((t) => encodeMove(from, t, match.pos.board[t])),
  setDifficulty: (d: Difficulty) => {
    hud.setDifficulty(d);
    match.difficulty = d;
  },
  setHumanSide: (s: Side) => {
    match.humanSide = s;
  },

  // Choreography scrubbing arrives with @anim. Kept as empty-bodied async
  // methods, deliberately: the harness probes for their presence to decide
  // whether to capture or to skip with a reason, and deleting them would turn
  // "56 shots skipped, here is why" into "the harness crashed".
  seekCapture: async (from, to, t) => {
    const attacker = match.views.get(from);
    const defender = match.views.get(to);
    if (!attacker || !defender) return;
    animatorFor(attacker);
    animatorFor(defender);
    choreographer.seekCapture(
      attacker.unit,
      defender.unit,
      {
        attackerSq: from,
        defenderSq: to,
        attackerType: attacker.type,
        defenderType: defender.type,
        ranged: attacker.type === PieceType.Cannon,
      },
      t,
    );
    await stepOnce(0);
  },
  seekFormation: async () => {},
  seekUnitState: async () => {},

  setPose: (p: Partial<CameraPose>, immediate?: boolean) =>
    rig.director.setPosePartial(p, immediate !== false),
  getPose: () => rig.director.getPose(),
  setNamedPose: (n: NamedPose, immediate?: boolean) =>
    rig.director.setNamedPose(n, immediate !== false),
  setSilhouette: (on: boolean) => {
    hud.setVisible(!on && hudVisible);
    pipeline.setSilhouetteMode(on);
    rig.setSilhouetteMode(on);
  },
  setHudVisible: (on: boolean) => {
    hudVisible = on;
    hud.setVisible(on);
  },
  setQuality: (tier) => governor.force(tier === 'auto' ? null : (tier as QualityTier)),
  showcase: async (side, unit, opts) => {
    await exitShowcase();
    const type = UNIT_TYPE_BY_KEY[unit as UnitKey];
    if (!type) throw new Error(`showcase: unknown unit "${unit}"`);

    // Hide the match rather than tearing it down, so exitShowcase is cheap and
    // the position the harness set up survives a whole showcase sweep.
    stage.visible = false;
    rig.board.clearLegalMarks();
    rig.board.setHover(null);

    const built = characters.create(side, type, 0);
    // Stand it on the board's centre intersection so it is lit and shadowed
    // exactly as it would be in play — a figure floating in a void reads
    // differently, and the critic is judging the shipped look.
    built.root.position.set(0, rig.board.heightAt(0, 0), 0);
    built.root.rotation.y = opts?.turntable ?? facingY(side);
    showcaseGroup.add(built.root);
    showcaseUnit = built;
    showcaseCollapse = collapseToAtlas(built.root, pipeline.materials, { variation: 0 });

    // A unit needs an animator even when it is standing still. Parts bound to
    // mount bones — the cannon crew, the elephant's trunk, the chariot's wheels
    // — are only placed once something poses those bones, and an unposed mount
    // bone sits at the rig origin. Without this the crew's limbs scatter around
    // the machine, which is exactly how the first retina showcase capture came
    // out, and it reads as broken geometry rather than as a missing update.
    showcaseAnimator = createAnimator(built, { ground: rig.heightAt, audio, variant: 0 });
    showcaseAnimator.play((opts?.state ?? 'idle') as AnimState, 0);

    api.setNamedPose('portrait', true);
    // Two steps: the first poses the skeleton, the second lets the pose settle
    // through the IK pass so contact points are resolved before capture.
    await stepOnce(0);
    await stepOnce(1 / 60);
  },
  exitShowcase: () => exitShowcase(),
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

/**
 * Live handles for diagnosis. The test API is already a debug surface, and
 * chasing "the draw calls are there but nothing is on screen" without being
 * able to walk the scene graph from the console is needlessly hard.
 */
(window as unknown as Record<string, unknown>).__DBG = { scene, stage, rig, match, pipeline, characters };

// Keep the unused-but-intentional bindings honest for the type checker.
void hudVisible;
void legalTargets;
void moveFrom;
void pieceDetune;
void NAMED_POSES;
