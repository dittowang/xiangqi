const spec = (m: string) => m;
const fs: any = await import(spec('node:fs'));
const zlib: any = await import(spec('node:zlib'));
function readPng(path: string) {
  const buf: Buffer = fs.readFileSync(path); let p = 8, w = 0, h = 0, bd = 0, ct = 0; const idat: Buffer[] = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p); const t = buf.toString('ascii', p+4, p+8); const d = buf.subarray(p+8, p+8+len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; } else if (t === 'IDAT') idat.push(d); else if (t === 'IEND') break; p += 12 + len; }
  const raw: Buffer = zlib.inflateSync(Buffer.concat(idat)); const ch = ct === 6 ? 4 : 3; const bpp = ch * (bd/8); const stride = w*bpp;
  const out = new Uint8Array(w*h*ch); let pos = 0; const prev = new Uint8Array(stride); const cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) { const f = raw[pos++]; for (let i=0;i<stride;i++) cur[i]=raw[pos+i]; pos+=stride;
    for (let i=0;i<stride;i++){ const a=i>=bpp?cur[i-bpp]:0,b=prev[i],c=i>=bpp?prev[i-bpp]:0; let v=cur[i];
      if(f===1)v=(v+a)&255; else if(f===2)v=(v+b)&255; else if(f===3)v=(v+((a+b)>>1))&255;
      else if(f===4){const pp=a+b-c,pa=Math.abs(pp-a),pb=Math.abs(pp-b),pc=Math.abs(pp-c);v=(v+(pa<=pb&&pa<=pc?a:pb<=pc?b:c))&255;} cur[i]=v; }
    out.set(cur.subarray(0,stride), y*stride); prev.set(cur); }
  return { w, h, ch, data: out };
}
const [pa, pb] = (globalThis as any).process.argv.slice(2);
const A = readPng(pa), B = readPng(pb);
let diff = 0, strong = 0, sum = 0;
for (let i = 0; i < A.w*A.h; i++) {
  const oa = i*A.ch, ob = i*B.ch;
  const d = Math.abs(A.data[oa]-B.data[ob]) + Math.abs(A.data[oa+1]-B.data[ob+1]) + Math.abs(A.data[oa+2]-B.data[ob+2]);
  if (d > 0) diff++; if (d > 24) strong++; sum += d;
}
const n = A.w*A.h;
console.log(`${pa.split('/').pop()} vs ${pb.split('/').pop()}: ${(100*diff/n).toFixed(2)}% pixels differ, ${(100*strong/n).toFixed(2)}% strongly, mean |d| ${(sum/n).toFixed(2)}`);
