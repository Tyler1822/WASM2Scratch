#!/usr/bin/env node
// wasm2sb3: compile a WebAssembly module (.wasm or .wat) into a Scratch 3 project (.sb3).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileWasm } from '../src/index.js';

const USAGE = `usage: wasm2sb3 <input.wasm|input.wat|input.c> [options]

C sources are compiled with wasi-sdk (found via $WASI_SDK_PATH or ./toolchain/wasi-sdk-*).

options:
  -o, --output FILE   output .sb3 path (default: input name with .sb3)
  --entry NAME        exported function to run on green flag (default: _start / main)
  --run               also run the project headlessly in scratch-vm and print its output
  --stdin TEXT        line of input for --run (repeatable)
  --json FILE         also write the raw project.json
  --front-sprite      always open the editor on an empty sprite (default: above 5000 blocks)
  --no-front-sprite   never add that sprite
  --script-list FILE  initial contents of the "Python code" list (one item per line)
  --minify            smallest project.json: short names, no hidden input
                      defaults, tables and memory built at the green flag
  --gc-roots REGEX    only variables matching REGEX are GC roots (gc_roots_begin)
  --cflags "FLAGS"    extra clang flags for .c input (e.g. "-O2 -mexec-model=reactor -Wl,--export=frame")
  -q, --quiet         no statistics
  -h, --help          show this help`;

function parseArgs(argv) {
  const o = { stdin: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
    if (a === '-o' || a === '--output') o.output = next();
    else if (a === '--entry') o.entry = next();
    else if (a === '--run') o.run = true;
    else if (a === '--stdin') o.stdin.push(next());
    else if (a === '--json') o.json = next();
    else if (a === '--script-list') o.scriptList = next();
    else if (a === '--front-sprite') o.frontSprite = true;
    else if (a === '--no-front-sprite') o.frontSprite = false;
    else if (a === '--cflags') o.cflags = next();
    else if (a === '--minify') o.minify = true;
    else if (a === '--gc-roots') o.gcRoots = new RegExp(next());
    else if (a === '-q' || a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a.startsWith('-')) fail(`unknown option ${a}`);
    else if (!o.input) o.input = a;
    else fail(`unexpected argument ${a}`);
  }
  if (!o.input) { console.error(USAGE); process.exit(2); }
  return o;
}

function fail(msg) {
  console.error(`wasm2sb3: ${msg}`);
  process.exit(1);
}

function findClang() {
  const roots = [];
  if (process.env.WASI_SDK_PATH) roots.push(process.env.WASI_SDK_PATH);
  for (const base of [process.cwd(), path.join(path.dirname(fileURLToPath(import.meta.url)), '..')]) {
    const tc = path.join(base, 'toolchain');
    if (fs.existsSync(tc)) for (const d of fs.readdirSync(tc)) if (d.startsWith('wasi-sdk')) roots.push(path.join(tc, d));
  }
  for (const r of roots) {
    const clang = path.join(r, 'bin', 'clang');
    if (fs.existsSync(clang)) return clang;
  }
  fail('compiling C needs wasi-sdk: set WASI_SDK_PATH or unpack it into ./toolchain/');
}

async function readModule(file, opts) {
  if (file.endsWith('.c') || file.endsWith('.cc') || file.endsWith('.cpp')) {
    const { execFileSync } = await import('node:child_process');
    const os = await import('node:os');
    const clang = findClang();
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wasm2sb3-')), 'out.wasm');
    const inc = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'include');
    const flags = (opts.cflags || '-O2').split(/\s+/).filter(Boolean);
    const cxx = !file.endsWith('.c');
    const exe = cxx ? clang + '++' : clang;
    try {
      execFileSync(exe, [...flags, '-I', inc, '-o', out, file, '-lm', ...(cxx ? ['-fno-exceptions'] : [])], { stdio: 'inherit' });
    } catch { fail('C compilation failed'); }
    return fs.readFileSync(out);
  }
  const data = fs.readFileSync(file);
  if (file.endsWith('.wat') || file.endsWith('.wast')) {
    let wabtInit;
    try { ({ default: wabtInit } = await import('wabt')); } catch { fail('reading .wat files needs the "wabt" package (npm install wabt)'); }
    const wabt = await wabtInit();
    const m = wabt.parseWat(file, data.toString('utf8'), {
      exceptions: true, bulk_memory: true, sign_extension: true, sat_float_to_int: true, multi_value: true, tail_call: true, mutable_globals: true,
    });
    m.resolveNames();
    m.validate();
    return Buffer.from(m.toBinary({ write_debug_names: true }).buffer);
  }
  return data;
}

const opts = parseArgs(process.argv.slice(2));
let result;
try {
  const wasm = await readModule(opts.input, opts);
  const scriptLines = opts.scriptList ? fs.readFileSync(opts.scriptList, 'utf8').replace(/\t/g, '    ').replace(/\n$/, '').split('\n') : undefined;
  result = compileWasm(wasm, { entry: opts.entry, scriptLines, frontSprite: opts.frontSprite, minify: opts.minify, gcRoots: opts.gcRoots, spriteName: path.basename(opts.input).replace(/\.\w+$/, '') });
} catch (e) {
  fail(e.message);
}
const out = opts.output || opts.input.replace(/\.(wasm|wat|wast|c|cc|cpp)$/, '') + '.sb3';
fs.writeFileSync(out, result.sb3);
if (opts.json) fs.writeFileSync(opts.json, result.json);
for (const w of result.warnings) console.error(`warning: ${w}`);
if (!opts.quiet) {
  const s = result.stats;
  console.error(`wrote ${out}: ${s.functions} functions, ${s.blocks} blocks, ${s.variables} variables, ${s.lists} lists, project.json ${(s.jsonBytes / 1024).toFixed(0)} KiB`);
  if (s.jsonBytes > 5 * 1024 * 1024) console.error('warning: project.json is larger than 5 MiB, which the Scratch website will not accept');
}
if (opts.run) {
  let runSb3;
  try { ({ runSb3 } = await import('../src/vm.js')); } catch { fail('--run needs the "scratch-vm" package (npm install scratch-vm)'); }
  const r = await runSb3(result.sb3, { stdin: opts.stdin, timeout: 10 * 60 * 1000 });
  for (const line of r.lists.stdout || []) console.log(line);
  console.error(`[scratch-vm: exit code ${r.vars['exit code'] ?? 0}, ${r.frames} frames, ${(r.ms / 1000).toFixed(2)} s${r.timedOut ? ', TIMED OUT' : ''}]`);
}
