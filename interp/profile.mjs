// Profiles a guest under the interpreter (built with -DPROFILE_FUNCS) and
// writes per-function instruction counts and call-edge counts.
//   node interp/profile.mjs guest.wasm out.json prog.py [prog2.py ...]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseWasm } from '../src/wasm/parser.js';
import { runReactor } from './host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [guest, outFile, ...progs] = process.argv.slice(2);
// prog.py or prog.py:frames (to also run that many on_frame callbacks)
execFileSync(path.join(here, 'build.sh'), [guest, 'prof'], {
  stdio: 'inherit', env: { ...process.env, CFLAGS: '-DREACTOR -mexec-model=reactor -DPROFILE_FUNCS -DGUEST_MEM_PAGES=24' },
});
const mod = parseWasm(fs.readFileSync(guest));
const n = mod.funcs.length;
const instr = new Array(n).fill(0);
const edges = new Map();
for (const spec of progs) {
  const [prog, frames] = spec.split(':');
  const lines = fs.readFileSync(prog, 'utf8').split('\n');
  const r = await runReactor(fs.readFileSync(path.join(here, 'build/prof.wasm')), { lines, stdin: ['Ada', 'n', 'look', 'go north', 'take key', 'quit'], frames: +frames || 0 });
  console.error(`${prog}: ${r.stdout.length} lines, ${r.ms.toFixed(0)} ms, exit ${r.exitCode}`);
  if (r.exitCode) console.error(r.stdout.slice(-5).join('\n'));
  const e = r.inst.exports;
  // Every program gets the same weight (time-sliced animations would
  // otherwise dominate): counts are scaled to 10M instructions per program.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += e.prof_fcount(i);
  const w = 1e7 / sum;
  for (let i = 0; i < n; i++) instr[i] += e.prof_fcount(i) * w;
  for (let i = 0; i < 65536; i++) {
    const k = e.prof_edge_key(i);
    if (!k) continue;
    const key = `${Math.floor((k - 1) / 4096)}>${(k - 1) % 4096}`;
    edges.set(key, (edges.get(key) || 0) + e.prof_edge_val(i) * w);
  }
}
const funcs = mod.funcs.map((f, i) => ({ i, name: f.name || `func${i}`, import: !!f.import, instr: instr[i] }));
fs.writeFileSync(outFile, JSON.stringify({ funcs, edges: Object.fromEntries(edges) }));
const tot = instr.reduce((a, b) => a + b, 0);
console.error(`total ${(tot / 1e6).toFixed(1)}M instructions`);
for (const f of [...funcs].sort((a, b) => b.instr - a.instr).slice(0, 30)) {
  console.error(`${(f.instr / tot * 100).toFixed(1).padStart(5)}%  ${f.name}`);
}
