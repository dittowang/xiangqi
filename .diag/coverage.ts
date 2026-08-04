import * as THREE from 'three';
import { BONE_ORDER, type GongbiMaterials, type MaterialRequest } from '@core/contracts.ts';
import { PieceType, Side } from '@core/types.ts';
import { createCharacters } from '@characters/index.ts';

const cache = new Map<string, THREE.Material>();
const materials: GongbiMaterials = {
  get: (r: MaterialRequest) => {
    const k = `${r.cls}|${r.pigment}`;
    let m = cache.get(k); if (!m) { m = new THREE.MeshBasicMaterial(); m.name = k; cache.set(k, m); } return m;
  },
  outline: () => null, setSilhouetteMode: () => {}, update: () => {}, setMood: () => {}, dispose: () => {},
};
const f = createCharacters({ materials, bakeInstancesBelow: 64, onWarn: (m) => console.log('  WARN', m) });
const types: [string, PieceType][] = [
  ['soldier', PieceType.Soldier], ['advisor', PieceType.Advisor], ['general', PieceType.General],
  ['cannon', PieceType.Cannon], ['horse', PieceType.Horse], ['elephant', PieceType.Elephant],
  ['chariot', PieceType.Chariot],
];
const watch = ['head','neck','handL','handR','foreArmL','foreArmR','upperArmL','upperArmR','thighL','thighR','shinL','shinR','footL','footR'];
console.log('vertices weighted to each humanoid bone (dominant influence), per unit');
console.log('unit'.padEnd(10)+'side'.padEnd(5)+watch.map(w=>w.replace('upperArm','uArm').replace('foreArm','fArm').padStart(6)).join(''));
for (const [name, t] of types) {
  for (const side of [Side.Red, Side.Black]) {
    const u = f.create(side, t, 0);
    const counts = new Map<number, number>();
    for (const sm of u.skinned) {
      const si = sm.geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
      const sw = sm.geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
      for (let v = 0; v < si.count; v++) {
        let best = -1, bw = 0;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(v,k); if (w > bw) { bw = w; best = si.getComponent(v,k); } }
        if (best >= 0) counts.set(best, (counts.get(best) ?? 0) + 1);
      }
    }
    const row = watch.map(w => {
      const i = BONE_ORDER.indexOf(w as never);
      const c = counts.get(i) ?? 0;
      return (c === 0 ? '  --  ' : String(c).padStart(6));
    }).join('');
    console.log(name.padEnd(10) + (side === Side.Red ? 'Han' : 'Chu').padEnd(5) + row);
    u.dispose();
  }
}
