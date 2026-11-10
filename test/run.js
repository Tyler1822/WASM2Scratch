// Differential test runner: every test module runs natively (Node's
// WebAssembly) and as a compiled Scratch project in scratch-vm; results must
// match exactly.
//
//   node test/run.js [filter...] [--verbose] [--keep]

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wabtInit from 'wabt';
import { compileWasm } from '../src/index.js';
import { runSb3 } from '../src/vm.js';
import * as G from './gen.js';
import { runNative } from './native.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const keep = args.includes('--keep');
const filters = args.filter((a) => !a.startsWith('--'));

const wabt = await wabtInit();

export function watToWasm(src, name = 'test.wat') {
  const m = wabt.parseWat(name, src, { exceptions: true, bulk_memory: true, sign_extension: true, sat_float_to_int: true, multi_value: true, tail_call: true, mutable_globals: true });
  m.resolveNames();
  m.validate();
  return Buffer.from(m.toBinary({ write_debug_names: true }).buffer);
}

// ---- comparison helpers ---------------------------------------------------------

function scratchWord(memList, i) {
  const x = memList[i];
  const n = typeof x === 'boolean' ? (x ? 1 : 0) : Number(x);
  return Number.isNaN(n) ? 0 : n;
}

function compareMem(native, scratchMem) {
  const dv = new DataView(native.buffer);
  const end = dv.getUint32(1020, true);
  const sEnd = scratchWord(scratchMem, 1020 / 4);
  const diffs = [];
  if (sEnd !== end) diffs.push(`end pointer: native ${end}, scratch ${sEnd}`);
  for (let p = G.OUT; p < end; p += 4) {
    const a = dv.getUint32(p, true);
    const b = scratchWord(scratchMem, p / 4);
    if (!Object.is(a, b)) {
      const lbl = G.labels.get(p);
      diffs.push(`@${p}: native 0x${a.toString(16)}, scratch ${typeof b === 'number' && Number.isInteger(b) && b >= 0 ? '0x' + b.toString(16) : b}${lbl ? '   ' + lbl : ''}`);
    }
    if (diffs.length > 30) break;
  }
  return { diffs, count: (end - G.OUT) / 4 };
}

// ---- test cases -----------------------------------------------------------------

const cases = [];
for (const op of G.I32_BINOPS) cases.push({ name: `i32.${op}`, kind: 'mem', wat: () => G.genIntBinop('i32', op) });
for (const op of G.I32_UNOPS) cases.push({ name: `i32.${op}`, kind: 'mem', wat: () => G.genIntUnop('i32', op) });
for (const op of G.I64_BINOPS) cases.push({ name: `i64.${op}`, kind: 'mem', wat: () => G.genIntBinop('i64', op) });
for (const op of G.I64_UNOPS) cases.push({ name: `i64.${op}`, kind: 'mem', wat: () => G.genIntUnop('i64', op) });
cases.push({ name: 'f64.ops', kind: 'mem', wat: () => G.genFloat('f64') });
cases.push({ name: 'f32.ops', kind: 'mem', wat: () => G.genFloat('f32') });

const progDir = path.join(here, 'programs');
for (const f of fs.existsSync(progDir) ? fs.readdirSync(progDir).sort() : []) {
  const full = path.join(progDir, f);
  if (f.startsWith('_')) continue;
  const prelude = () => fs.readFileSync(path.join(progDir, '_prelude.wat'), 'utf8');
  if (f.endsWith('.wat')) cases.push({ name: `prog/${f}`, kind: 'stdout', wat: () => fs.readFileSync(full, 'utf8').replace(';;@prelude', prelude()), stdinFile: full.replace(/\.wat$/, '.stdin') });
  if (f.endsWith('.wasm')) cases.push({ name: `prog/${f}`, kind: 'stdout', wasm: () => fs.readFileSync(full), stdinFile: full.replace(/\.wasm$/, '.stdin') });
}

// C programs, if the wasi-sdk toolchain has been downloaded into toolchain/.
const cDir = path.join(here, 'c');
const sdk = fs.existsSync(path.join(here, '..', 'toolchain')) && fs.readdirSync(path.join(here, '..', 'toolchain')).find((d) => d.startsWith('wasi-sdk'));
if (sdk) {
  const clang = path.join(here, '..', 'toolchain', sdk, 'bin', 'clang');
  for (const f of fs.readdirSync(cDir).filter((x) => x.endsWith('.c')).sort()) {
    for (const opt of ['-O2', '-O0']) {
      const src = path.join(cDir, f);
      cases.push({
        name: `c/${f}${opt}`, kind: 'stdout', stdinFile: src.replace(/\.c$/, '.stdin'),
        wasm: () => {
          const out = path.join(here, '..', 'build', f.replace(/\.c$/, opt + '.wasm'));
          fs.mkdirSync(path.dirname(out), { recursive: true });
          const m = /^\/\/ cflags: (.*)$/m.exec(fs.readFileSync(src, 'utf8'));
          const extra = m ? m[1].trim().split(/\s+/) : [];
          execFileSync(clang, [opt, '-o', out, src, '-lm', ...extra], { stdio: 'inherit' });
          return fs.readFileSync(out);
        },
      });
    }
  }
}

// MicroPython REPL sessions, if python/build/micropython.wasm has been built.
const mpWasm = path.join(here, '..', 'python', 'build', 'micropython.wasm');
if (fs.existsSync(mpWasm)) {
  for (const f of fs.readdirSync(path.join(here, 'python')).filter((x) => x.endsWith('.stdin')).sort()) {
    cases.push({ name: `python/${f.replace(/\.stdin$/, '')}`, kind: 'stdout', stdinFile: path.join(here, 'python', f), wasm: () => fs.readFileSync(mpWasm) });
  }
}

const selected = cases.filter((c) => !filters.length || filters.some((f) => c.name.includes(f)));
let pass = 0, fail = 0;
const t0 = Date.now();
for (const c of selected) {
  const label = c.name.padEnd(28);
  try {
    const wasm = c.wasm ? c.wasm() : watToWasm(c.wat(), c.name);
    const stdin = c.stdinFile && fs.existsSync(c.stdinFile) ? fs.readFileSync(c.stdinFile, 'utf8').split('\n') : [];
    const native = await runNative(wasm, { stdin });
    const compiled = compileWasm(wasm);
    if (keep) fs.writeFileSync(path.join(here, '..', 'build', c.name.replace(/[^\w.-]/g, '_') + '.sb3'), compiled.sb3);
    const res = await runSb3(compiled.sb3, { stdin, timeout: 300000 });
    const problems = [];
    if (res.timedOut) problems.push('timed out');
    if (c.kind === 'mem') {
      const { diffs, count } = compareMem(native.memory, res.lists.mem);
      problems.push(...diffs);
      c.detail = `${count} values`;
    } else {
      const a = native.stdout.join('\n'), b = (res.lists.stdout || []).join('\n');
      if (a !== b) problems.push(`stdout differs:\n--- native ---\n${a.slice(0, 1500)}\n--- scratch ---\n${b.slice(0, 1500)}`);
      const ec = Number(res.vars['exit code'] ?? 0);
      if (ec !== native.exitCode) problems.push(`exit code: native ${native.exitCode}, scratch ${ec}`);
      c.detail = `${native.stdout.length} lines`;
    }
    const info = `${c.detail}, ${compiled.stats.blocks} blocks, ${res.ms} ms`;
    if (problems.length) {
      fail++;
      console.log(`FAIL ${label} ${info}\n  ${problems.join('\n  ')}`);
    } else {
      pass++;
      console.log(`ok   ${label} ${info}`);
    }
    if (verbose && compiled.warnings.length) console.log('  warnings: ' + compiled.warnings.join('; '));
  } catch (e) {
    fail++;
    console.log(`FAIL ${label} ${verbose ? e.stack : e.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
