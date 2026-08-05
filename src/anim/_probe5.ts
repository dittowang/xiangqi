/** Headless: the attacker's pose through the exchange, at the critic's marks. */
import * as THREE from 'three';
import type {
  AudioCue, CameraDirector, CameraMode, CameraPose, GongbiMaterials, MaterialRequest,
} from '@core/contracts.ts';
import { PieceType, Side } from '@core/types.ts';
import { createCharacters } from '@characters/index.ts';
import { createAnimator, type Animator } from './controller.ts';
import { PigmentField } from './pigment.ts';
import { Choreography } from './choreography.ts';

function stubMaterials(): GongbiMaterials {
  const cache = new Map<string, THREE.Material>();
  return {
    get(req: MaterialRequest): THREE.Material {
      const k = `${req.cls}|${req.pigment}`;
      let m = cache.get(k);
      if (!m) { m = new THREE.MeshBasicMaterial(); cache.set(k, m); }
      return m;
    },
    outline: () => null, setSilhouetteMode: () => {}, update: () => {}, setMood: () => {}, dispose: () => {},
  };
}
class StubCamera implements CameraDirector {
  readonly camera = new THREE.PerspectiveCamera();
  update(): void {} setMode(_m: CameraMode): void {}
  pushToCapture(): Promise<void> { return Promise.resolve(); }
  pushToCheck(): void {} release(): void {} setUserControl(): void {} impulse(): void {}
  setPose(): void {}
  getPose(): CameraPose { return { target: [0, 0, 0], distance: 10, pitch: 0.9, yaw: 0, fov: 38 }; }
  resize(): void {}
}
const cues: AudioCue[] = [];
const audio = {
  unlock: () => Promise.resolve(), play: (c: AudioCue) => { cues.push(c); },
  setIntensity: () => {}, setCadence: () => {}, setMuted: () => {}, update: () => {}, dispose: () => {},
};

const factory = createCharacters({ materials: stubMaterials(), onWarn: () => {} });
const atk = factory.create(Side.Red, PieceType.Soldier, 0);
const def = factory.create(Side.Black, PieceType.Soldier, 1);
const anims = new Map<THREE.Object3D, Animator>();
anims.set(atk.root, createAnimator(atk, { ground: () => 0, variant: 0, footstepGain: 0 }));
anims.set(def.root, createAnimator(def, { ground: () => 0, variant: 1, footstepGain: 0 }));
const pigment = new PigmentField({ ground: () => 0 });
const choreo = new Choreography({
  camera: new StubCamera(), audio: audio as never, pigment,
  animatorFor: (u) => anims.get(u.root), ground: () => 0,
});

// squares 49 (f4 r5) x 40 (f4 r4)
void choreo.capture(atk, def, {
  attackerSq: 49, defenderSq: 40,
  attackerType: PieceType.Soldier, defenderType: PieceType.Soldier, ranged: false,
});

const p = new THREE.Vector3();
const marks = [0.0, 0.432, 0.96, 1.184, 1.264, 1.296, 1.552, 2.048, 2.352, 2.688, 3.04, 3.408];
let mi = 0;
let t = 0;
const dt = 1 / 60;
const rows: string[] = [];
const grab = (u: typeof atk, bone: 'handR' | 'head'): string => {
  p.setFromMatrixPosition(u.bones[bone].matrixWorld);
  return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
};
for (let i = 0; i < 260; i++) {
  if (mi < marks.length && t >= marks[mi] - 1e-9) {
    rows.push(
      `t=${marks[mi].toFixed(3)}  atk hand ${grab(atk, 'handR')}  atk head ${grab(atk, 'head')}` +
        `  def head ${grab(def, 'head')}  chips ${pigment.liveCount}`,
    );
    mi++;
  }
  choreo.update(dt);
  for (const a of anims.values()) a.update(dt);
  t += dt;
}
console.log(rows.join('\n'));
const A = new THREE.Vector3();
const B = new THREE.Vector3();
console.log('\ncues:', [...new Set(cues)].join(', '));
void A; void B;
