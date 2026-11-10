// Runs a project headlessly in scratch-vm with a stand-in renderer that
// records Pen drawing, then writes the stage as a PNG.
//
//   node scripts/snapshot.mjs project.sb3 out.png [--frames N] [--events events.json] [--stdin LINE]...
//
// events.json is a list of input events applied at given frames:
//   [{"frame": 40, "mouse": [x, y, true]}, {"frame": 60, "key": "ArrowLeft", "down": true}]
// Mouse coordinates are Scratch stage coordinates (x -240..240, y -180..180).

import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const [sb3Path, outPath] = args;
const frames = Number(opt('--frames', 300));
const events = opt('--events') ? JSON.parse(fs.readFileSync(opt('--events'), 'utf8')) : [];
const stdin = args.flatMap((a, i) => (a === '--stdin' ? [args[i + 1]] : []));

const W = 480, H = 360;
const px = new Uint8Array(W * H * 3).fill(255);
const clear = () => px.fill(255);
function disc(cx, cy, r, rgb) {
  // Stage coordinates -> pixels.
  const sx = cx + W / 2, sy = H / 2 - cy;
  const rr = Math.max(r, 0.5);
  for (let y = Math.floor(sy - rr); y <= Math.ceil(sy + rr); y++) {
    if (y < 0 || y >= H) continue;
    for (let x = Math.floor(sx - rr); x <= Math.ceil(sx + rr); x++) {
      if (x < 0 || x >= W) continue;
      if ((x + 0.5 - sx) ** 2 + (y + 0.5 - sy) ** 2 > rr * rr) continue;
      const o = (y * W + x) * 3;
      px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2];
    }
  }
}
const rgbOf = (attrs) => attrs.color4f.slice(0, 3).map((c) => Math.round(c * 255));
let penOps = 0;

// A renderer that only implements what the VM needs, recording pen drawing.
let nextId = 1;
const renderer = new Proxy({
  penLine(skin, attrs, x0, y0, x1, y1) {
    penOps++;
    const rgb = rgbOf(attrs), r = attrs.diameter / 2;
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= n; i++) disc(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, r, rgb);
  },
  penPoint(skin, attrs, x, y) { penOps++; disc(x, y, attrs.diameter / 2, rgbOf(attrs)); },
  penClear() { penOps++; clear(); },
  getFencedPositionOfDrawable(id, pos) { return pos; },
  getCurrentSkinSize() { return [2, 2]; },
  getBounds() { return { left: 0, right: 0, top: 0, bottom: 0 }; },
  getBoundsForBubble() { return { left: 0, right: 0, top: 0, bottom: 0 }; },
  getDrawableOrder() { return 0; },
  getNativeSize() { return [W, H]; },
  getSkinSize() { return [2, 2]; },
}, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === 'string' && /^create/.test(prop)) return () => nextId++;
    return () => undefined;
  },
});

const L = console.log;
console.log = () => {}; console.warn = () => {}; console.error = () => {};
const VM = require('scratch-vm');
const vm = new VM();
vm.attachRenderer(renderer);
await vm.loadProject(fs.readFileSync(sb3Path));
const answers = [...stdin];
vm.runtime.on('QUESTION', (q) => { if (q !== null) setImmediate(() => vm.runtime.emit('ANSWER', answers.shift() ?? '')); });
vm.runtime.currentStepTime = 1000 / 30;
vm.greenFlag();
const t0 = Date.now();
let f = 0;
for (; f < frames && vm.runtime.threads.length; f++) {
  for (const e of events.filter((ev) => ev.frame === f)) {
    if (e.mouse) {
      const [x, y, down] = e.mouse;
      vm.postIOData('mouse', { x: x + W / 2, y: H / 2 - y, isDown: down, canvasWidth: W, canvasHeight: H });
    }
    if (e.key) vm.postIOData('keyboard', { key: e.key, isDown: e.down });
  }
  vm.runtime._step();
  await new Promise((r) => setImmediate(r));
}
console.log = L;

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = ~0; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(outPath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));

const sprite = vm.runtime.targets.filter((t) => !t.isStage).pop();
const out = Object.values(sprite.variables).find((v) => v.name === 'stdout');
console.log(`${f} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${penOps} pen operations -> ${outPath}`);
for (const line of out ? out.value : []) console.log('  | ' + line);
process.exit(0);
