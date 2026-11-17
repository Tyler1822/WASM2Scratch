// Runs doom.wasm natively in Node with an emulated pen, to check the port
// before compiling it to Scratch.
//   node doom/native.mjs [frames] [out.png] [keys]
// keys: "frame:key:down|up,..." e.g. "40:enter:down,42:enter:up"
import fs from 'node:fs';
import zlib from 'node:zlib';

const frames = +(process.argv[2] || 200);
const outPng = process.argv[3] || 'doom/build/native.png';
const keyEvents = (process.argv[4] || '').split(',').filter(Boolean).map((s) => {
  const [f, k, d] = s.split(':');
  return { f: +f, k, d: d !== 'up' };
});

const W = 480, H = 360;
const img = new Uint8Array(W * H * 3);
let penSize = 1, color = 0, px = 0, py = 0, down = false;
function dot(x, y) {
  const r = penSize / 2;
  const cx = x + 240, cy = 180 - y;
  for (let j = Math.floor(cy - r); j <= Math.ceil(cy + r); j++) {
    for (let i = Math.floor(cx - r); i <= Math.ceil(cx + r); i++) {
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      if ((i + 0.5 - cx) ** 2 + (j + 0.5 - cy) ** 2 > r * r) continue;
      const o = (j * W + i) * 3;
      img[o] = color >> 16; img[o + 1] = (color >> 8) & 255; img[o + 2] = color & 255;
    }
  }
}
function line(x0, y0, x1, y1) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let k = 0; k <= n; k++) dot(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n);
}

const keysDown = new Set();
const keyName = (c) => ({ 32: 'space', 10: 'enter', 28: 'left', 29: 'right', 30: 'up', 31: 'down' })[c] || String.fromCharCode(c);
let penOps = 0;
let mem;
const text = (p, n) => Buffer.from(mem.buffer, p, n).toString('latin1');
const env = {
  pen_clear: () => img.fill(0),
  pen_size: (s) => { penSize = s; },
  pen_color: (c) => { color = c >>> 0; },
  goto_xy: (x, y) => { if (down) { line(px, py, x, y); penOps++; } px = x; py = y; },
  pen_down: () => { down = true; dot(px, py); },
  pen_up: () => { down = false; },
  stdout_visible: () => {},
  key_pressed: (c) => (keysDown.has(keyName(c)) ? 1 : 0),
};
const wasi = new Proxy({
  fd_write: (fd, iovs, n, nw) => {
    const dv = new DataView(mem.buffer);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const p = dv.getUint32(iovs + 8 * i, true), l = dv.getUint32(iovs + 8 * i + 4, true);
      process.stdout.write(text(p, l)); total += l;
    }
    dv.setUint32(nw, total, true);
    return 0;
  },
  proc_exit: (c) => { throw new Error(`exit ${c}`); },
  clock_time_get: (id, prec, out) => { new DataView(mem.buffer).setBigUint64(out, BigInt(Date.now()) * 1000000n, true); return 0; },
  fd_fdstat_get: () => 0,
  fd_prestat_get: () => 8,
}, { get: (t, k) => t[k] || (() => 52) });

const { instance } = await WebAssembly.instantiate(fs.readFileSync(new URL('build/doom.wasm', import.meta.url)), { scratch: env, wasi_snapshot_preview1: wasi });
mem = instance.exports.memory;
instance.exports._initialize();
const t0 = performance.now();
for (let f = 0; f < frames; f++) {
  for (const e of keyEvents) if (e.f === f) (e.d ? keysDown.add(e.k) : keysDown.delete(e.k));
  const t = performance.now();
  instance.exports.frame();
  if (f === 0) console.log(`\n[boot ${(performance.now() - t).toFixed(0)} ms]`);
}
console.log(`[${frames} frames in ${(performance.now() - t0).toFixed(0)} ms, ${penOps} pen lines]`);

// PNG writer
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) Buffer.from(img.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(outPng, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`wrote ${outPng}`);
