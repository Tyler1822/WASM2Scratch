// Reference runner: executes a module with Node's WebAssembly and a small WASI shim.

class ProcExit extends Error { constructor(code) { super('exit'); this.code = code; } }

export async function runNative(wasm, { stdin = [] } = {}) {
  let memory;
  const out = [];
  let line = [];
  const answers = [...stdin];
  let inBuf = [];
  const dec = (bytes) => Buffer.from(bytes).toString('latin1');
  const u32 = (p) => new DataView(memory.buffer).getUint32(p, true);
  const setU32 = (p, v) => new DataView(memory.buffer).setUint32(p, v, true);
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
    clock_time_get(id, prec, p) { new DataView(memory.buffer).setBigUint64(p, BigInt(Date.now()) * 1000000n, true); return 0; },
    clock_res_get(id, p) { new DataView(memory.buffer).setBigUint64(p, 1000000n, true); return 0; },
    random_get(p, n) { const b = new Uint8Array(memory.buffer); for (let i = 0; i < n; i++) b[p + i] = (Math.random() * 256) | 0; return 0; },
    fd_fdstat_get(fd, p) { const w = [2, 0, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]; w.forEach((x, k) => setU32(p + 4 * k, x)); return 0; },
    fd_close() { return 0; },
    fd_sync() { return 0; },
    fd_seek() { return 70; },
    fd_prestat_get() { return 8; },
    fd_prestat_dir_name() { return 8; },
    sched_yield() { return 0; },
  };
  const mod = await WebAssembly.compile(wasm);
  const imports = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] ??= {};
    if (imp.kind !== 'function') continue;
    if (imp.module.startsWith('wasi')) imports[imp.module][imp.name] = wasi[imp.name] || (() => 52);
    else if (imp.name === 'gc_roots_begin') imports[imp.module][imp.name] = () => -1; // cannot see wasm locals natively
    else imports[imp.module][imp.name] = () => 0;
  }
  const inst = await WebAssembly.instantiate(mod, imports);
  memory = inst.exports.memory;
  let exitCode = 0;
  try {
    if (inst.exports._initialize) inst.exports._initialize();
    const main = inst.exports._start || inst.exports.__main_argc_argv || inst.exports.main;
    if (main) {
      const r = main.length ? main(0, 0) : main();
      if (typeof r === 'number') exitCode = r | 0;
    }
  } catch (e) {
    if (e instanceof ProcExit) exitCode = e.code;
    else if (WebAssembly.Exception && e instanceof WebAssembly.Exception) { out.push(...(line.length ? [dec(line)] : []), 'wasm trap: uncaught wasm exception'); line = []; exitCode = 134; }
    else if (e instanceof WebAssembly.RuntimeError) { out.push(...(line.length ? [dec(line)] : []), `wasm trap: ${e.message}`); line = []; exitCode = 134; }
    else throw e;
  }
  if (line.length) out.push(dec(line));
  return { stdout: out, exitCode, memory: memory ? new Uint8Array(memory.buffer) : null };
}

