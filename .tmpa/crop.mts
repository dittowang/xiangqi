const spec = (m: string) => m;
const fs: any = await import(spec('node:fs'));
const zlib: any = await import(spec('node:zlib'));
function readPng(path: string) {
  const buf: Buffer = fs.readFileSync(path); let p = 8, w = 0, h = 0, bd = 0, ct = 0; const idat: Buffer[] = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p); const t = buf.toString('ascii', p+4, p+8); const d = buf.subarray(p+8, p+8+len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; } else if (t === 'IDAT') idat.push(d); else if (t === 'IEND') break; p += 12 + len; }
  const raw: Buffer = zlib.inflateSync(Buffer.concat(idat)); const ch = ct === 6 ? 4 : 3; const bpp = ch*(bd/8); const stride = w*bpp;
  const out = new Uint8Array(w*h*ch); let pos = 0; const prev = new Uint8Array(stride); const cur = new Uint8Array(stride);
  for (let y=0;y<h;y++){ const f=raw[pos++]; for(let i=0;i<stride;i++)cur[i]=raw[pos+i]; pos+=stride;
    for(let i=0;i<stride;i++){const a=i>=bpp?cur[i-bpp]:0,b=prev[i],c=i>=bpp?prev[i-bpp]:0;let v=cur[i];
      if(f===1)v=(v+a)&255;else if(f===2)v=(v+b)&255;else if(f===3)v=(v+((a+b)>>1))&255;
      else if(f===4){const pp=a+b-c,pa=Math.abs(pp-a),pb=Math.abs(pp-b),pc=Math.abs(pp-c);v=(v+(pa<=pb&&pa<=pc?a:pb<=pc?b:c))&255;}cur[i]=v;}
    out.set(cur.subarray(0,stride), y*stride); prev.set(cur);} return { w,h,ch,data:out };
}
function crc32(buf: Uint8Array) { let c = ~0; for (let i=0;i<buf.length;i++){ c ^= buf[i]; for(let k=0;k<8;k++) c = (c>>>1) ^ (0xEDB88320 & -(c&1)); } return ~c >>> 0; }
function chunk(type: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8); const crcBuf = Buffer.concat([Buffer.from(type,'ascii'), Buffer.from(data)]);
  out.writeUInt32BE(crc32(crcBuf), 8+data.length); return out;
}
function writePng(path: string, w: number, h: number, rgb: Uint8Array) {
  const stride = w*3; const raw = Buffer.alloc((stride+1)*h);
  for (let y=0;y<h;y++){ raw[y*(stride+1)] = 0; Buffer.from(rgb.subarray(y*stride,(y+1)*stride)).copy(raw, y*(stride+1)+1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4); ihdr[8]=8; ihdr[9]=2;
  fs.writeFileSync(path, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', new Uint8Array(0))]));
}
// argv: out.png zoom  then triples: file x y w h label
const a = (globalThis as any).process.argv.slice(2);
const outPath = a[0]; const zoom = +a[1];
const panels: {file:string;x:number;y:number;w:number;h:number}[] = [];
for (let i = 2; i < a.length; i += 5) panels.push({ file:a[i], x:+a[i+1], y:+a[i+2], w:+a[i+3], h:+a[i+4] });
const pw = panels[0].w*zoom, ph = panels[0].h*zoom;
const gap = 8;
const W = pw*panels.length + gap*(panels.length-1), H = ph;
const canvas = new Uint8Array(W*H*3).fill(30);
panels.forEach((pn, idx) => {
  const img = readPng(pn.file);
  for (let y=0;y<ph;y++) for (let x=0;x<pw;x++) {
    const sx = pn.x + Math.floor(x/zoom), sy = pn.y + Math.floor(y/zoom);
    if (sx<0||sy<0||sx>=img.w||sy>=img.h) continue;
    const so = (sy*img.w+sx)*img.ch; const dx = idx*(pw+gap)+x; const dO = (y*W+dx)*3;
    canvas[dO]=img.data[so]; canvas[dO+1]=img.data[so+1]; canvas[dO+2]=img.data[so+2];
  }
});
writePng(outPath, W, H, canvas);
console.log(`wrote ${outPath} (${W}x${H})`);
