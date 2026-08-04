/* TEMPORARY review harness — deleted before hand-off. Software-rasterises the
 * units this author owns into a PNG contact sheet so the geometry can be looked
 * at rather than assumed. No WebGL, no browser. */
import * as THREE from 'three';
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { createCharacters } from '../src/characters/index.ts';
import { PieceType, Side } from '../src/core/types.ts';
import { PIGMENTS, type PigmentName } from '../src/core/palette.ts';
import type { GongbiMaterials, MaterialRequest } from '../src/core/contracts.ts';

function stub(): GongbiMaterials {
  const cache = new Map<string, THREE.Material>();
  return {
    get(req: MaterialRequest) {
      const k = `${req.cls}|${req.pigment}`;
      let m = cache.get(k);
      if (!m) { m = new THREE.MeshBasicMaterial(); m.name = k; cache.set(k, m); }
      return m;
    },
    outline: () => null, setSilhouetteMode: () => {}, update: () => {},
    setMood: () => {}, dispose: () => cache.clear(),
  };
}

const hex = (s: string): [number, number, number] => {
  const n = parseInt(s.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

interface Tri { p: THREE.Vector3[]; c: [number, number, number] }

function collect(root: THREE.Object3D, silhouette: boolean): Tri[] {
  const out: Tri[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!(mesh as THREE.Mesh).isMesh) return;
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const name = mesh.name.split(':');
    const pig = name[name.length - 1] as PigmentName;
    const p = PIGMENTS[pig];
    const base: [number, number, number] = silhouette ? [20, 20, 24] : (p ? hex(p.bands[2]) : [140, 140, 140]);
    const mats: THREE.Matrix4[] = [];
    const im = mesh as THREE.InstancedMesh;
    if (im.isInstancedMesh) {
      const t = new THREE.Matrix4();
      for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, t); mats.push(mesh.matrixWorld.clone().multiply(t)); }
    } else mats.push(mesh.matrixWorld.clone());
    for (const m of mats) {
      for (let i = 0; i < pos.count; i += 3) {
        const tri: THREE.Vector3[] = [];
        for (let k = 0; k < 3; k++) tri.push(new THREE.Vector3().fromBufferAttribute(pos, i + k).applyMatrix4(m));
        out.push({ p: tri, c: base });
      }
    }
  });
  return out;
}

function render(tris: Tri[], dir: THREE.Vector3, W: number, H: number, silhouette: boolean): Uint8Array {
  const fwd = dir.clone().normalize();
  const up0 = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up0, fwd).normalize();
  const up = new THREE.Vector3().crossVectors(fwd, right).normalize();
  // fit
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  const proj = (v: THREE.Vector3) => [v.dot(right), v.dot(up), v.dot(fwd)];
  for (const t of tris) for (const v of t.p) {
    const [x, y] = proj(v);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const pad = 0.06;
  const sx = (maxX - minX) * (1 + pad * 2), sy = (maxY - minY) * (1 + pad * 2);
  const s = Math.min(W / sx, H / sy);
  const ox = W / 2 - ((minX + maxX) / 2) * s, oy = H / 2 + ((minY + maxY) / 2) * s;

  const buf = new Uint8Array(W * H * 3).fill(silhouette ? 250 : 236);
  const zb = new Float64Array(W * H).fill(1e18);
  const light = new THREE.Vector3(-0.45, 0.78, -0.44).normalize();
  const n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();

  for (const t of tris) {
    e1.subVectors(t.p[1], t.p[0]); e2.subVectors(t.p[2], t.p[0]);
    n.crossVectors(e1, e2);
    if (n.lengthSq() < 1e-16) continue;
    n.normalize();
    let lam = Math.max(0, n.dot(light)) * 0.72 + 0.28;
    if (silhouette) lam = 1;
    // quantise, like the gongbi ramp
    if (!silhouette) lam = Math.round(lam * 3.4) / 3.4;
    const P = t.p.map(proj);
    const X = P.map((p) => ox + p[0] * s), Y = P.map((p) => oy - p[1] * s), Z = P.map((p) => p[2]);
    const x0 = Math.max(0, Math.floor(Math.min(...X))), x1 = Math.min(W - 1, Math.ceil(Math.max(...X)));
    const y0 = Math.max(0, Math.floor(Math.min(...Y))), y1 = Math.min(H - 1, Math.ceil(Math.max(...Y)));
    const d = (X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0]);
    if (Math.abs(d) < 1e-9) continue;
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
      const cx = px + 0.5, cy = py + 0.5;
      const w0 = ((X[1] - cx) * (Y[2] - cy) - (X[2] - cx) * (Y[1] - cy)) / d;
      const w1 = ((X[2] - cx) * (Y[0] - cy) - (X[0] - cx) * (Y[2] - cy)) / d;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * Z[0] + w1 * Z[1] + w2 * Z[2];
      const i = py * W + px;
      if (z >= zb[i]) continue;
      zb[i] = z;
      buf[i * 3] = Math.min(255, t.c[0] * lam);
      buf[i * 3 + 1] = Math.min(255, t.c[1] * lam);
      buf[i * 3 + 2] = Math.min(255, t.c[2] * lam);
    }
  }
  return buf;
}

function png(rgb: Uint8Array, W: number, H: number): Buffer {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b: Buffer): number { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c; }

function tile(cells: { rgb: Uint8Array; w: number; h: number }[], cols: number): { rgb: Uint8Array; w: number; h: number } {
  const cw = cells[0].w, ch = cells[0].h;
  const rows = Math.ceil(cells.length / cols);
  const W = cw * cols, H = ch * rows;
  const out = new Uint8Array(W * H * 3).fill(255);
  cells.forEach((c, i) => {
    const ox = (i % cols) * cw, oy = Math.floor(i / cols) * ch;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const s = (y * cw + x) * 3, d = ((oy + y) * W + ox + x) * 3;
      out[d] = c.rgb[s]; out[d + 1] = c.rgb[s + 1]; out[d + 2] = c.rgb[s + 2];
    }
  });
  return { rgb: out, w: W, h: H };
}

const f = createCharacters({ materials: stub(), onWarn: () => {} });
const VIEWS: [string, THREE.Vector3][] = [
  ['front', new THREE.Vector3(0, -0.12, 1)],
  ['3/4', new THREE.Vector3(0.85, -0.3, 0.75)],
  ['profile', new THREE.Vector3(1, -0.12, 0.02)],
];
const args = process.argv.slice(2);
const sil = args.includes('--sil');
const which = args.find((a) => !a.startsWith('--')) ?? 'general';
const type = which === 'chariot' ? PieceType.Chariot : PieceType.General;
const S = 460;
const cells: { rgb: Uint8Array; w: number; h: number }[] = [];
for (const side of [Side.Red, Side.Black]) {
  const u = f.create(side, type, 0);
  const tris = collect(u.root, sil);
  for (const [, d] of VIEWS) cells.push({ rgb: render(tris, d, S, S, sil), w: S, h: S });
  u.dispose();
}
const sheet = tile(cells, 3);
const path = `/tmp/claude-0/-home-user-xiangqi/c475b782-29bd-5bcd-b658-b00155aace6c/scratchpad/${which}${sil ? '-sil' : ''}.png`;
writeFileSync(path, png(sheet.rgb, sheet.w, sheet.h));
console.log('wrote', path, sheet.w, 'x', sheet.h);
