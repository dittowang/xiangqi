// Decode a PNG with three's own zlib-free path? No — use node:zlib + a minimal
// PNG reader. Enough for statistics on a screenshot.
const spec = (m: string) => m;
const fs: any = await import(spec('node:fs'));
const zlib: any = await import(spec('node:zlib'));

function readPng(path: string) {
  const buf: Buffer = fs.readFileSync(path);
  let p = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw: Buffer = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const bpp = channels * (bitDepth / 8);
  const stride = w * bpp;
  const out = new Uint8Array(w * h * channels);
  let pos = 0;
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    for (let i = 0; i < stride; i++) cur[i] = raw[pos + i];
    pos += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = cur[i];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[i] = v;
    }
    out.set(cur.subarray(0, stride), y * stride);
    prev.set(cur);
  }
  return { w, h, channels, data: out };
}

function analyse(path: string, label: string) {
  const img = readPng(path);
  const { w, h, channels, data } = img;
  const at = (x: number, y: number) => {
    const o = (y * w + x) * channels;
    return [data[o], data[o + 1], data[o + 2]];
  };

  // Local gradient histogram: how much does a pixel differ from its right
  // neighbour? A hard-banded render is mostly zero with rare big jumps; a
  // smooth-falloff render is dominated by small non-zero steps.
  let zero = 0, small = 0, big = 0, total = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const a = at(x, y), b = at(x + 1, y);
      const d = Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) + Math.abs(a[2]-b[2]);
      total++;
      if (d === 0) zero++;
      else if (d <= 6) small++;
      else big++;
    }
  }
  const distinct = new Set<number>();
  for (let i = 0; i < data.length; i += channels) distinct.add((data[i]<<16)|(data[i+1]<<8)|data[i+2]);
  console.log(`${label.padEnd(28)} ${w}x${h}  flat ${(100*zero/total).toFixed(1)}%  ` +
    `micro-step(1..6) ${(100*small/total).toFixed(1)}%  edge(>6) ${(100*big/total).toFixed(1)}%  ` +
    `distinct colours ${distinct.size}`);
  return { zero: zero/total, small: small/total, big: big/total, distinct: distinct.size };
}

const args = (globalThis as any).process.argv.slice(2);
for (const a of args) analyse(a, a.split('/').pop()!);

// diff two images: how many pixels differ, and by how much
