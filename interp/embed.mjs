// Writes guest.h: the given .wasm (minus custom sections) as a C byte array.
//   node embed.mjs guest.wasm guest.h [native.c]
// With native.c (hybrid build), the bodies of natively compiled functions
// are replaced by `unreachable`: the interpreter never runs them.
import fs from 'node:fs';
const bytes = fs.readFileSync(process.argv[2]);
const native = new Set();
if (process.argv[4]) for (const x of (fs.readFileSync(process.argv[4], 'utf8').match(/^\/\/ native: (.*)$/m) || [, ''])[1].split(',').filter(Boolean)) native.add(+x);

let p = 8;
const u32 = () => { let r = 0, s = 0, b; do { b = bytes[p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
const leb = (n) => { const o = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; o.push(b); } while (n); return Buffer.from(o); };
const skipName = () => { const n = u32(); p += n; };

let nimports = 0;
const parts = [bytes.subarray(0, 8)];
while (p < bytes.length) {
  const start = p, id = bytes[p++], size = u32(), body = p, end = p + size;
  if (id === 2) {
    const n = u32();
    for (let i = 0; i < n; i++) {
      skipName(); skipName();
      const kind = bytes[p++];
      if (kind === 0) { u32(); nimports++; }
      else if (kind === 4) { p++; u32(); }
      else if (kind === 1) { p++; const f = bytes[p++]; u32(); if (f & 1) u32(); }
      else if (kind === 2) { const f = bytes[p++]; u32(); if (f & 1) u32(); }
      else if (kind === 3) { p += 2; }
    }
  }
  if (id === 10 && native.size) {
    p = body;
    const n = u32();
    const out = [leb(n)];
    for (let i = 0; i < n; i++) {
      const sz = u32(), b = p;
      p += sz;
      if (native.has(nimports + i)) out.push(Buffer.from([3, 0, 0x00, 0x0b]));
      else out.push(leb(sz), bytes.subarray(b, b + sz));
    }
    const content = Buffer.concat(out);
    parts.push(Buffer.from([10]), leb(content.length), content);
  } else if (id !== 0) {
    parts.push(bytes.subarray(start, end));
  }
  p = end;
}
const out = Buffer.concat(parts);
const lines = [];
for (let i = 0; i < out.length; i += 24) lines.push('  ' + [...out.subarray(i, i + 24)].join(',') + ',');
fs.writeFileSync(process.argv[3], `// Generated from ${process.argv[2].split('/').pop()} by embed.mjs\nstatic const unsigned char guest_wasm[] = {\n${lines.join('\n')}\n};\nstatic const unsigned int guest_wasm_len = ${out.length};\n`);
console.error(`embedded ${out.length} bytes (from ${bytes.length}${native.size ? `, ${native.size} native bodies stripped` : ''})`);
