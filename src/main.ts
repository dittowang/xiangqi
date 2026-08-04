/**
 * Entry point. Boots the renderer, wires the subsystems together, and owns the
 * frame loop. Everything else is behind a contract in `core/contracts.ts`.
 *
 * NOTE: this is the bootstrap stage. Subsystems are attached here as they land;
 * the integration layer in `game/` takes over orchestration.
 */

import * as THREE from 'three';
import { clock } from '@game/clock.ts';
import { PIGMENTS, srgbToLinear, hexToRgb } from '@core/palette.ts';
import { BOARD_HALF_X, BOARD_HALF_Z } from '@core/coords.ts';
import type { CameraPose, QualityTier } from '@core/contracts.ts';
import type { NamedPose, XqTestApi, XqFrameStats, DebugFlag } from '@core/testapi.ts';
import { START_FEN } from '@core/testapi.ts';
import { Side } from '@core/types.ts';

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const host = document.getElementById('app')!;

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
  stencil: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping; // Gongbi is not photographic.
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
{
  const c = hexToRgb(PIGMENTS.ink.bands[1]);
  scene.background = new THREE.Color(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
}

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 400);

// Resting framing: high and wide over Red's seat, 50 degrees of pitch.
const pose: CameraPose = {
  target: [0, 0.35, 0],
  distance: 15.5,
  pitch: (50 * Math.PI) / 180,
  yaw: 0,
  fov: 38,
};

function applyPose(p: CameraPose) {
  camera.fov = p.fov;
  camera.updateProjectionMatrix();
  const cp = Math.cos(p.pitch);
  const sp = Math.sin(p.pitch);
  camera.position.set(
    p.target[0] + Math.sin(p.yaw) * cp * p.distance,
    p.target[1] + sp * p.distance,
    p.target[2] + Math.cos(p.yaw) * cp * p.distance,
  );
  camera.lookAt(p.target[0], p.target[1], p.target[2]);
}
applyPose(pose);

// ---------------------------------------------------------------------------
// Placeholder scene content — replaced as subsystems land
// ---------------------------------------------------------------------------

const key = new THREE.DirectionalLight(0xfff0ce, 2.5);
key.position.set(-6, 11, 7);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -9;
key.shadow.camera.right = 9;
key.shadow.camera.top = 9;
key.shadow.camera.bottom = -9;
scene.add(key);
scene.add(new THREE.HemisphereLight(0x7e9bc0, 0xb98e52, 0.8));

const placeholder = new THREE.Group();
placeholder.name = 'placeholder';
{
  const g = new THREE.BoxGeometry(BOARD_HALF_X * 2 + 1.4, 0.5, BOARD_HALF_Z * 2 + 1.4);
  const c = hexToRgb(PIGMENTS.gamboge.bands[1]);
  const m = new THREE.MeshLambertMaterial({
    color: new THREE.Color(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)),
  });
  const table = new THREE.Mesh(g, m);
  table.position.y = -0.25;
  table.receiveShadow = true;
  placeholder.add(table);
}
scene.add(placeholder);

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

let firstFrameResolve: (() => void) | null = null;
const firstFrame = new Promise<void>((res) => (firstFrameResolve = res));

let worstMs = 0;
let fps = 60;
let smoothedMs = 16.6;

function frame(nowMs: number) {
  requestAnimationFrame(frame);
  const dt = clock.tick(nowMs);

  const t0 = performance.now();
  renderer.render(scene, camera);
  const ms = performance.now() - t0;
  smoothedMs += (ms - smoothedMs) * 0.08;
  if (clock.frame > 30 && ms > worstMs) worstMs = ms;
  if (dt > 0) fps += (1 / dt - fps) * 0.08;

  if (firstFrameResolve) {
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
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
});

// ---------------------------------------------------------------------------
// Capture harness control surface
// ---------------------------------------------------------------------------

/** Render exactly one frame after advancing the clock by `seconds`. */
function stepOnce(seconds: number): Promise<void> {
  clock.queueStep(seconds);
  return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
}

export const NAMED_POSES: Record<NamedPose, CameraPose> = {
  default: { target: [0, 0.35, 0], distance: 15.5, pitch: 0.873, yaw: 0, fov: 38 },
  top: { target: [0, 0, 0], distance: 14.0, pitch: 1.5533, yaw: 0, fov: 40 },
  silhouette: { target: [0, 0.9, 0], distance: 13.0, pitch: 0.12, yaw: 0, fov: 30 },
  threeQuarterRed: { target: [0, 0.7, 2.6], distance: 7.4, pitch: 0.44, yaw: 0.62, fov: 34 },
  threeQuarterBlack: { target: [0, 0.7, -2.6], distance: 7.4, pitch: 0.44, yaw: Math.PI - 0.62, fov: 34 },
  overShoulder: { target: [0, 0.8, 0], distance: 4.2, pitch: 0.3, yaw: 0.5, fov: 42 },
  portrait: { target: [0, 0.85, 0], distance: 3.1, pitch: 0.2, yaw: 0.38, fov: 30 },
  endgame: { target: [0, 0.3, 0], distance: 11.5, pitch: 0.24, yaw: -0.3, fov: 36 },
  profile: { target: [0, 0.8, 0], distance: 6.0, pitch: 0.16, yaw: Math.PI / 2, fov: 32 },
};

const api: XqTestApi = {
  ready: () => firstFrame,
  pause: () => clock.pause(),
  resume: () => clock.resume(),
  step: (s) => stepOnce(s),
  stepFrames: async (n, s = 1 / 60) => {
    for (let i = 0; i < n; i++) await stepOnce(s);
  },
  settle: async () => {
    await stepOnce(1 / 60);
  },
  setPosition: async () => {},
  getPosition: () => START_FEN,
  playMove: async () => {},
  forceMove: () => {},
  legalMoves: () => [],
  setDifficulty: () => {},
  setHumanSide: () => {},
  seekCapture: async () => {},
  seekFormation: async () => {},
  seekUnitState: async () => {},
  setPose: (p, immediate) => {
    Object.assign(pose, p);
    if (immediate !== false) applyPose(pose);
  },
  getPose: () => ({ ...pose }),
  setNamedPose: (n, immediate) => api.setPose(NAMED_POSES[n], immediate),
  setSilhouette: () => {},
  setHudVisible: () => {},
  setQuality: () => {},
  showcase: async () => {},
  exitShowcase: async () => {},
  setDebug: (_f: DebugFlag, _on: boolean) => {},
  stats: (): XqFrameStats => ({
    fps,
    frameMs: smoothedMs,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.programs?.length ?? 0,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    worstMs,
    quality: 'ultra' as QualityTier,
    pixelRatio: renderer.getPixelRatio(),
  }),
  resetStats: () => {
    worstMs = 0;
    renderer.info.reset();
  },
  describe: () => ({
    phase: 'boot',
    ply: 0,
    sideToMove: Side.Red,
    inCheck: false,
    result: 'ongoing',
    pieces: [],
  }),
};

window.__XQ = api;
