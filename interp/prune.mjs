// Writes a copy of wasmi.c without the interpreter cases the guest cannot
// reach: opcodes that no interpreted guest function uses, and imports the
// guest does not have. Every removed case is Scratch blocks saved.
//   node prune.mjs guest.wasm [native.c] wasmi.c out.c
import fs from 'node:fs';
import { parseWasm } from '../src/wasm/parser.js';
import { OPCODES } from '../src/wasm/opcodes.js';

const [guest, nativeFile, src, outFile] = process.argv.slice(2);
const mod = parseWasm(fs.readFileSync(guest));
const native = new Set();
if (nativeFile && fs.existsSync(nativeFile)) for (const x of (fs.readFileSync(nativeFile, 'utf8').match(/^\/\/ native: (.*)$/m) || [, ''])[1].split(',').filter(Boolean)) native.add(+x);

const byName = new Map();
OPCODES.forEach((e, code) => { if (e && !byName.has(e[0])) byName.set(e[0], code); });
byName.set('select', 0x1b);
const used = new Set();
for (let c = 0; c < 0x20; c++) used.add(c); // control flow (shared labels)
used.add(0xfc);
const visit = (list) => {
  for (const ins of list) {
    const c = byName.get(ins.op);
    if (c !== undefined) used.add(c);
    if (ins.op === 'select') used.add(0x1c);
    for (const k of ['body', 'then', 'else', 'catchAll']) if (ins[k]) visit(ins[k]);
    if (ins.catches) for (const x of ins.catches) visit(x.body);
  }
};
for (const f of mod.funcs) if (!f.import && !native.has(f.index)) visit(f.body);

// Host import ids: H_ + upper-case name, via the host_names table in wasmi.c.
const text = fs.readFileSync(src, 'utf8');
const hostIds = new Map([...text.matchAll(/\{"(\w+)", (H_\w+)\}/g)].map((m) => [m[1], m[2]]));
const usedHost = new Set(['H_GC_BEGIN', 'H_GC_COPY']);
for (const f of mod.funcs) if (f.import && hostIds.has(f.import.name)) usedHost.add(hostIds.get(f.import.name));

const lines = text.split('\n');
const out = [];
let region = null, removed = 0;
let group = null;
const flush = () => {
  if (!group) return;
  const keep = group.labels.some((l) => region === 'op' ? used.has(parseInt(l, 16)) : usedHost.has(l));
  if (keep) out.push(...group.lines); else removed++;
  group = null;
};
for (const line of lines) {
  const m = line.match(/\/\/ PRUNE-BEGIN (\w+)/);
  if (m) { region = m[1]; out.push(line); continue; }
  if (region && /\/\/ PRUNE-END/.test(line)) { flush(); region = null; out.push(line); continue; }
  if (!region) { out.push(line); continue; }
  const t = line.trim();
  const labels = region === 'op' ? [...t.matchAll(/^(?:case (0x[0-9a-f]+):\s*)/g)] : null;
  if (/^case (0x|H_)/.test(t)) {
    flush();
    const ls = [];
    let rest = t;
    for (;;) {
      const mm = rest.match(/^case (0x[0-9a-f]+|H_\w+):\s*/);
      if (!mm) break;
      ls.push(mm[1]);
      rest = rest.slice(mm[0].length);
    }
    group = { labels: ls, lines: [line] };
    void labels;
  } else if (t.startsWith('#') || t.startsWith('// ----') || t.startsWith('default:')) {
    flush();
    out.push(line);
  } else if (group) {
    group.lines.push(line);
  } else {
    out.push(line);
  }
}
fs.writeFileSync(outFile, out.join('\n'));
console.error(`prune: ${removed} interpreter cases removed (${used.size} opcodes kept)`);
