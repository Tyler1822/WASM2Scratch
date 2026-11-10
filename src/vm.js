// Headless scratch-vm runner used by the tests and by `wasm2sb3 --run`.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let quiet = false;
function silenceVmLogs() {
  if (quiet) return;
  quiet = true;
  try {
    const minilog = require('minilog');
    minilog.disable();
  } catch { /* optional */ }
}

// Runs a project until all threads finish. Returns the sprite's lists/variables.
//   opts.stdin:    array of answers for "ask and wait"
//   opts.timeout:  wall-clock limit in ms
//   opts.frames:   stop after this many frames even if still running (for frame-loop programs)
export async function runSb3(sb3, opts = {}) {
  silenceVmLogs();
  const origWarn = console.warn, origErr = console.error, origLog = console.log;
  if (!opts.verbose) { console.warn = () => {}; console.error = () => {}; console.log = () => {}; }
  const VirtualMachine = require(opts.vmPackage || 'scratch-vm');
  let vm;
  try { vm = new VirtualMachine(); } catch (e) { console.warn = origWarn; console.error = origErr; console.log = origLog; throw e; }
  let frames = 0;
  const t0 = Date.now();
  let timedOut = false;
  let loadMs = 0;
  try {
    await vm.loadProject(sb3);
    loadMs = Date.now() - t0;
    const answers = [...(opts.stdin || [])];
    vm.runtime.on('QUESTION', (q) => {
      if (q === null) return;
      const a = answers.length ? answers.shift() : '';
      setImmediate(() => vm.runtime.emit('ANSWER', a));
    });
    vm.runtime.currentStepTime = 1000 / 30;
    if (opts.compilerOptions && vm.setCompilerOptions) vm.setCompilerOptions(opts.compilerOptions);
    vm.greenFlag();
    const timeout = opts.timeout ?? 60000;
    while (vm.runtime.threads.length > 0) {
      vm.runtime._step();
      frames++;
      if (opts.frames && frames >= opts.frames) break;
      if (Date.now() - t0 > timeout) { timedOut = true; break; }
      // Let promise-based blocks (ask and wait) make progress.
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    console.warn = origWarn; console.error = origErr; console.log = origLog;
  }
  const sprite = vm.runtime.targets.filter((t) => !t.isStage).pop(); // the code sprite is last
  const lists = {}, vars = {};
  for (const id in sprite.variables) {
    const v = sprite.variables[id];
    if (v.type === 'list') lists[v.name] = v.value; else if (v.type === '') vars[v.name] = v.value;
  }
  vm.runtime.dispose?.();
  return { lists, vars, frames, ms: Date.now() - t0, loadMs, timedOut };
}
