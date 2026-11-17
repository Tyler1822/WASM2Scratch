// Runs a reactor build (start/frame exports, e.g. the Python runner, or the
// interpreter/hybrid around it) in Node with WASI + `scratch` imports.
//   runReactor(wasmBytes, { lines, stdin, frames }) -> { stdout, exitCode, inst }
// `lines` feeds script_lines/script_line (the "Python code" list).

class ProcExit extends Error { constructor(code) { super('exit'); this.code = code; } }

export async function runReactor(wasm, { lines = [], stdin = [], frames = 0, gcRoots = -1 } = {}) {
  let memory;
  const out = [];
  let line = [];
  const answers = [...stdin];
  let inBuf = [];
  const dec = (b) => Buffer.from(b).toString('latin1');
  const dv = () => new DataView(memory.buffer);
  const u32 = (p) => dv().getUint32(p, true);
  const setU32 = (p, v) => dv().setUint32(p, v, true);
  const wasi = {
    fd_write(fd, iovs, n, nw) {
      let total = 0;
      const bytes = new Uint8Array(memory.buffer);
      for (let i = 0; i < n; i++) {
        const p = u32(iovs + 8 * i), len = u32(iovs + 8 * i + 4);
        for (let k = 0; k < len; k++) {
          const b = bytes[p + k];
          if (b === 10) { out.push(dec(line)); line = []; } else line.push(b);
        }
        total += len;
      }
      setU32(nw, total);
      return 0;
    },
    fd_read(fd, iovs, n, nr) {
      let total = 0;
      const bytes = new Uint8Array(memory.buffer);
      for (let i = 0; i < n; i++) {
        const p = u32(iovs + 8 * i), len = u32(iovs + 8 * i + 4);
        if (inBuf.length === 0 && total === 0) inBuf = [...Buffer.from((answers.length ? answers.shift() : '') + '\n', 'latin1')];
        let k = 0;
        while (k < len && inBuf.length) { bytes[p + k] = inBuf.shift(); k++; }
        total += k;
      }
      setU32(nr, total);
      return 0;
    },
    proc_exit(code) { throw new ProcExit(code); },
    args_sizes_get(a, b) { setU32(a, 1); setU32(b, 5); return 0; },
    args_get(argv, buf) { setU32(argv, buf); new Uint8Array(memory.buffer).set([119, 97, 115, 109, 0], buf); return 0; },
    environ_sizes_get(a, b) { setU32(a, 0); setU32(b, 0); return 0; },
    environ_get() { return 0; },
    clock_time_get(id, prec, p) { dv().setBigUint64(p, BigInt(Date.now()) * 1000000n, true); return 0; },
    random_get(p, n) { const b = new Uint8Array(memory.buffer); for (let i = 0; i < n; i++) b[p + i] = (Math.random() * 256) | 0; return 0; },
    fd_fdstat_get(fd, p) { [2, 0, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff].forEach((x, k) => setU32(p + 4 * k, x)); return 0; },
    fd_close() { return 0; },
    fd_seek() { return 70; },
    fd_prestat_get() { return 8; },
    fd_prestat_dir_name() { return 8; },
    sched_yield() { return 0; },
  };
  const t0 = performance.now();
  const scratch = {
    script_lines: () => lines.length,
    script_line(i, buf, cap) {
      const b = Buffer.from(lines[i] ?? '', 'latin1').subarray(0, cap);
      new Uint8Array(memory.buffer).set(b, buf);
      return b.length;
    },
    clock: () => (performance.now() - t0) / 1000,
    timer: () => (performance.now() - t0) / 1000,
    gc_roots_begin: () => gcRoots,
    random_int: (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1)),
  };
  const mod = await WebAssembly.compile(wasm);
  const imports = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] ??= {};
    if (imp.kind !== 'function') continue;
    const tbl = imp.module.startsWith('wasi') ? wasi : imp.module === 'scratch' ? scratch : {};
    imports[imp.module][imp.name] = tbl[imp.name] || (() => 0);
  }
  const inst = await WebAssembly.instantiate(mod, imports);
  memory = inst.exports.memory;
  let exitCode = 0;
  try {
    if (inst.exports._initialize) inst.exports._initialize();
    inst.exports.start();
    for (let f = 0; f < frames && inst.exports.frame; f++) inst.exports.frame();
  } catch (e) {
    if (e instanceof ProcExit) exitCode = e.code;
    else if (e instanceof WebAssembly.RuntimeError || (WebAssembly.Exception && e instanceof WebAssembly.Exception)) {
      if (line.length) { out.push(dec(line)); line = []; }
      out.push(`wasm trap: ${e.message || 'exception'}`);
      exitCode = 134;
    } else throw e;
  }
  if (line.length) out.push(dec(line));
  return { stdout: out, exitCode, inst, ms: performance.now() - t0 };
}
