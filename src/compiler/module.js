// Whole-module compilation: WebAssembly binary -> Scratch project.

import * as A from '../scratch/ast.js';
import { parseWasm, evalConstExpr } from '../wasm/parser.js';
import { buildProject } from '../scratch/sb3.js';
import { analyzeCallGraph, sigKey } from './analysis.js';
import { FuncCompiler, restoreStmts } from './function.js';
import { Runtime, TABLES, LIST_LIMIT } from './runtime.js';
import { Imports, keyTable } from './imports.js';

const { v, num } = A;
const U = 4294967296;

function sanitize(name) {
  let s = String(name).replace(/[^A-Za-z0-9_]/g, '_');
  if (s.length > 48) s = s.slice(0, 48);
  return s;
}

class Context {
  constructor(mod, opts) {
    this.mod = mod;
    this.opts = opts;
    this.warnings = [];
    this.uses = { stdout: false, stdin: false, pen: false, keys: false, say: false, gcroots: false };
    // Must be known before any function is compiled (see FuncCompiler.paramIsArg).
    this.uses.gcroots = mod.imports.some((im) => im.kind === 'func' && im.name === 'gc_roots_begin');
    this.cg = analyzeCallGraph(mod);
    this.rt = new Runtime(this);
    this.imports = new Imports(this);
    this.dispatchers = new Map();
    this.frames = new Map();
    this.extraProcs = [];

    // Procedure / variable names.
    const taken = new Set();
    this.names = mod.funcs.map((f, i) => {
      let base = sanitize(f.name || (f.import ? `${f.import.module}_${f.import.name}` : `func${i}`)) || `func${i}`;
      if (/^\d/.test(base)) base = 'f' + base;
      let n = base;
      for (let k = 2; taken.has(n); k++) n = `${base}_${k}`;
      taken.add(n);
      return n;
    });
    const gtaken = new Set();
    this.gnames = mod.globals.map((g, i) => {
      const base = 'g.' + (mod.names.globals.has(i) ? sanitize(mod.names.globals.get(i)) : String(i));
      let n = base;
      for (let k = 2; gtaken.has(n); k++) n = `${base}_${k}`;
      gtaken.add(n);
      return n;
    });

    // Global initial values.
    const values = [];
    this.globalInit = mod.globals.map((g, i) => {
      if (g.import) {
        this.warn(`imported global ${g.import.module}.${g.import.name} is initialised to 0`);
        values[i] = g.type === 'i64' ? 0n : 0;
      } else {
        values[i] = evalConstExpr(g.init, values);
      }
      return values[i];
    });

    const mem = mod.memories[0];
    this.pages = mem ? mem.min : 0;
    this.maxPages = mem && mem.max !== null ? mem.max : 65536;
  }

  warn(msg) { this.warnings.push(msg); }

  // The procedure that fills the list `gcroots`; its body is generated after
  // all code is compiled, when every variable name is known.
  gcRootsProc() {
    if (!this.gcRoots) {
      this.gcRoots = { name: 'collect gc roots', args: [], warp: true, body: [] };
      this.extraProcs.push(this.gcRoots);
    }
    return this.gcRoots.name;
  }

  // Shared procedures that push / pop a set of variables on the call stack.
  frameProcs(names) {
    const key = names.join('\u0000');
    let f = this.frames.get(key);
    if (!f) {
      const n = this.frames.size;
      f = { save: `save frame ${n}`, restore: `restore frame ${n}` };
      this.frames.set(key, f);
      this.extraProcs.push({ name: f.save, args: [], warp: true, body: names.map((x) => A.ladd('cs', v(x))) });
      this.extraProcs.push({ name: f.restore, args: [], warp: true, body: restoreStmts(names) });
    }
    return f;
  }
  procName(i) { return this.names[i]; }
  varPrefix(i) { return this.names[i]; }
  globalVar(i) { return this.gnames[i]; }
  constGlobal(i) {
    const g = this.mod.globals[i];
    if (g.mutable || g.import) return undefined;
    const val = this.globalInit[i];
    return typeof val === 'number' || typeof val === 'bigint' ? val : undefined;
  }

  // Procedure implementing call_indirect for one signature.
  dispatcher(typeIdx) {
    const type = this.mod.types[typeIdx];
    const key = sigKey(type);
    if (this.dispatchers.has(key)) return this.dispatchers.get(key);
    const name = `call_indirect ${this.dispatchers.size}`;
    this.dispatchers.set(key, name);
    const args = ['idx'];
    type.params.forEach((t, i) => { args.push('p' + i); if (t === 'i64') args.push(`p${i}h`); });
    const fwd = args.slice(1).map((a) => A.arg(a));
    const entries = [...this.table.entries()].filter(([, f]) => sigKey(this.mod.funcs[f].type) === key).sort((a, b) => a[0] - b[0]);
    const trap = (msg) => [A.call(this.rt.use('trap'), A.str(msg))];
    const idx = A.arg('idx');
    const build = (es) => {
      if (es.length === 0) return trap('indirect call to null or mismatched function');
      if (es.length === 1) {
        return [A.iff(A.eq(idx, es[0][0]), [A.call(this.procName(es[0][1]), ...fwd)], trap('indirect call signature mismatch'))];
      }
      const mid = es.length >> 1;
      return [A.iff(A.lt(idx, es[mid][0]), build(es.slice(0, mid)), build(es.slice(mid)))];
    };
    this.extraProcs.push({ name, args, warp: true, body: build(entries) });
    return name;
  }
}

function findEntries(mod) {
  const exp = new Map(mod.exports.filter((e) => e.kind === 'func').map((e) => [e.name, e.index]));
  const out = { start: mod.start, init: exp.get('_initialize'), main: null, mainName: null, frame: exp.get('frame') };
  for (const n of ['_start', '__main_argc_argv', 'main']) {
    if (exp.has(n)) { out.main = exp.get(n); out.mainName = n; break; }
  }
  return out;
}

function reachableFrom(roots, cg, mod) {
  const seen = new Set();
  const work = roots.filter((r) => r !== null && r !== undefined);
  while (work.length) {
    const f = work.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const g of cg.edges[f]) work.push(g);
  }
  // Functions referenced from element segments may be called indirectly.
  void mod;
  return seen;
}

function walkStmts(stmts, fn) {
  for (const s of stmts) {
    fn(s);
    if (s.a) walkStmts(s.a, fn);
    if (s.b) walkStmts(s.b, fn);
    if (s.body) walkStmts(s.body, fn);
    if (s.substacks) s.substacks.forEach((ss) => walkStmts(ss, fn));
  }
}

function varsUsed(procs) {
  const used = new Set();
  const expr = (e) => A.walkExpr(e, (n) => {
    if (n.t === 'v') used.add(n.name);
    if (n.t === 'blk') for (const k in n.inputs) { const x = n.inputs[k]; if (x && x.expr) expr(x.expr); }
  });
  const visit = (s) => {
    if (s.name && (s.s === 'set' || s.s === 'change')) used.add(s.name);
    for (const k of ['v', 'i', 'c', 'n']) if (s[k] && s[k].t) expr(s[k]);
    if (s.args) s.args.forEach(expr);
    if (s.inputs) for (const k in s.inputs) { const x = s.inputs[k]; if (x && x.t) expr(x); else if (x && x.expr) expr(x.expr); }
  };
  for (const p of procs) walkStmts(p.body, visit);
  return used;
}

function listsUsed(procs, scripts) {
  const used = new Set();
  const expr = (e) => A.walkExpr(e, (n) => {
    if (n.list) used.add(n.list);
    if (n.t === 'blk') for (const k in n.inputs) { const x = n.inputs[k]; if (x && x.expr) expr(x.expr); }
  });
  const visit = (s) => {
    if (s.list) used.add(s.list);
    for (const k of ['v', 'i', 'c', 'n']) if (s[k] && s[k].t) expr(s[k]);
    if (s.args) s.args.forEach(expr);
    if (s.inputs) for (const k in s.inputs) { const x = s.inputs[k]; if (x && x.t) expr(x); else if (x && x.expr) expr(x.expr); }
  };
  for (const p of procs) walkStmts(p.body, visit);
  for (const s of scripts) walkStmts(s.body, visit);
  return used;
}

export function compileWasm(bytes, opts = {}) {
  const mod = parseWasm(bytes);
  if (mod.memories.length > 1) throw new Error('multiple memories are not supported');
  if (mod.tables.length > 1) throw new Error('multiple tables are not supported');
  const ctx = new Context(mod, opts);
  const entries = findEntries(mod);
  if (opts.entry) {
    const e = mod.exports.find((x) => x.kind === 'func' && x.name === opts.entry);
    if (!e) throw new Error(`no exported function named ${opts.entry}`);
    entries.main = e.index;
    entries.mainName = opts.entry;
  }
  if (entries.main === null && entries.frame === undefined && entries.start === null && entries.init === undefined) {
    throw new Error('module has no entry point: export _start, main, _initialize or frame (or pass --entry NAME)');
  }

  // Table contents (from active element segments with constant offsets).
  ctx.table = new Map();
  for (const el of mod.elems) {
    if (el.mode !== 'active') continue;
    const off = Number(evalConstExpr(el.offset, ctx.globalInit));
    el.funcs.forEach((f, k) => { if (f !== null && f !== undefined) ctx.table.set(off + k, f); });
  }

  ctx.reachable = reachableFrom([entries.start, entries.init, entries.main, entries.frame], ctx.cg, mod);
  ctx.imports.check();

  // Compile functions.
  const procs = [];
  for (const f of mod.funcs) {
    if (f.import || !ctx.reachable.has(f.index)) continue;
    try {
      const t0 = Date.now();
      if (opts.trace) process.stderr.write(`compiling ${ctx.procName(f.index)}... `);
      procs.push(new FuncCompiler(ctx, f).compile());
      if (opts.trace) process.stderr.write(`${Date.now() - t0} ms\n`);
    } catch (err) {
      err.message = `in function ${ctx.procName(f.index)}: ${err.message}`;
      throw err;
    }
  }

  // Memory image.
  const lists = new Map();
  const vars = new Map();
  const words = ctx.pages * 16384;
  const memdata = [];
  if (mod.memories.length) {
    const bytesArr = new Uint8Array(ctx.pages * 65536);
    for (const d of mod.datas) {
      if (d.mode !== 'active') { ctx.warn('passive data segments are ignored'); continue; }
      const off = Number(evalConstExpr(d.offset, ctx.globalInit));
      if (off + d.bytes.length > bytesArr.length) throw new Error('data segment does not fit in initial memory');
      bytesArr.set(d.bytes, off);
    }
    const dv = new DataView(bytesArr.buffer);
    const image = new Array(words);
    for (let i = 0; i < words; i++) {
      const w = dv.getUint32(i * 4, true);
      image[i] = w;
      if (w !== 0) memdata.push(i + 1, w);
    }
    lists.set('mem', image);
    lists.set('memdata', memdata);
    if (words > LIST_LIMIT) ctx.warn(`initial memory (${words} words) exceeds Scratch's ${LIST_LIMIT}-item list limit; memory.grow will fail`);
  }

  // Init procedure.
  const i = 'init.i';
  const init = [
    A.set('br', 0), A.set('exn', 0), A.lclear('cs'), A.set('exit code', 0),
    A.lclear('stdout'), A.set('line', A.str('')),
    A.set('stdin', A.str('')), A.set('stdin.pos', 1),
  ];
  if (mod.memories.length) {
    init.push(
      A.iff(A.eq(v('booted'), 1), [
        A.repeat(A.sub(A.listLen('mem'), words), [A.ldel('mem', 'last')]),
        A.set(i, 1),
        A.repeat(words, [A.lrep('mem', v(i), 0), A.change(i, 1)]),
        A.set(i, 1),
        A.repeat(A.div(A.listLen('memdata'), 2), [A.lrep('mem', A.item('memdata', v(i)), A.item('memdata', A.add(v(i), 1))), A.change(i, 2)]),
      ]),
      A.set('booted', 1),
      A.set('memsize', ctx.pages),
    );
    vars.set('booted', 0);
  }
  mod.globals.forEach((g, gi) => {
    if (ctx.constGlobal(gi) !== undefined) return;
    const val = ctx.globalInit[gi];
    if (g.type === 'i64') {
      const b = BigInt.asUintN(64, BigInt(val ?? 0));
      init.push(A.set(ctx.globalVar(gi), Number(b & 0xffffffffn)), A.set(ctx.globalVar(gi) + 'h', Number(b >> 32n)));
    } else {
      init.push(A.set(ctx.globalVar(gi), typeof val === 'number' ? val : 0));
    }
  });
  procs.unshift({ name: 'wasm init', args: [], warp: true, body: init });

  // Green flag script.
  const body = [A.call('wasm init')];
  const callEntry = (f, args = []) => body.push(A.call(ctx.procName(f), ...args));
  if (entries.start !== null) callEntry(entries.start);
  if (entries.init !== undefined) callEntry(entries.init);
  if (entries.main !== null) {
    const t = mod.funcs[entries.main].type;
    callEntry(entries.main, t.params.map(() => num(0)));
    if (t.results.length && t.results[0] === 'i32') body.push(A.set('exit code', A.sub(A.mod(A.add(v('ret'), 2147483648), U), 2147483648)));
  }
  if (mod.tags.length) body.push(A.iff(A.gt(v('exn'), 0), [A.call(ctx.rt.use('trap'), A.str('uncaught wasm exception'))]));
  if (ctx.uses.stdout || ctx.rt.used.has('trap')) body.push(A.call(ctx.rt.use('flush')));
  if (entries.frame !== undefined) body.push(A.forever([A.call(ctx.procName(entries.frame))]));
  const scripts = [{ hat: 'event_whenflagclicked', body }];

  const allProcs = [...procs, ...ctx.extraProcs, ...ctx.rt.procs()];

  if (ctx.gcRoots) {
    // Every variable that may hold a wasm value, plus the saved call frames.
    const names = [...varsUsed(allProcs)].filter((n) => !n.startsWith('prof.') && !['line', 'stdin', 'exit code'].includes(n)).sort();
    const k = 'gc.i';
    ctx.gcRoots.body = [
      A.lclear('gcroots'),
      ...names.map((n) => A.ladd('gcroots', v(n))),
      A.set(k, 1),
      A.repeat(A.listLen('cs'), [A.ladd('gcroots', A.item('cs', v(k))), A.change(k, 1)]),
    ];
  }

  // Lookup tables and other lists.
  for (const name of listsUsed(allProcs, scripts)) {
    if (lists.has(name)) continue;
    if (TABLES[name]) lists.set(name, TABLES[name]());
    else if (name === 'keys') lists.set(name, keyTable());
  }

  const monitors = [];
  if (ctx.uses.stdout || ctx.rt.used.has('trap')) {
    monitors.push(ctx.uses.pen
      ? { list: 'stdout', x: 0, y: 260, width: 480, height: 100, visible: true }
      : { list: 'stdout', x: 0, y: 0, width: 480, height: 360, visible: true });
  }
  const costumes = [];
  if (ctx.uses.stdin) for (let c = 32; c < 127; c++) costumes.push(String.fromCharCode(c));

  const extensions = [];
  if (ctx.uses.pen) extensions.push('pen');

  const project = buildProject({
    procs: allProcs, scripts, vars, lists, monitors, costumes, extensions,
    spriteName: opts.spriteName || 'WASM',
    // Hidden unless the program uses speech bubbles; a hidden sprite also makes
    // "ask and wait" show its question above the input box.
    visible: ctx.uses.say,
    frontSprite: 'Click the green flag',
  });
  return {
    ...project,
    warnings: ctx.warnings,
    stats: { ...project.stats, functions: procs.length - 1, helpers: ctx.rt.used.size },
  };
}
