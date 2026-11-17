// Runs doom.sb3 headlessly in TurboWarp's scratch-vm (compiler enabled) and
// reports how long each Scratch frame takes.
//   TW_VM=/path/to/turbowarp/scratch-vm node doom/twbench.mjs [sb3] [frames] [keys]
// keys: "frame:scratchkey:down|up,..." e.g. "20:q:down,22:q:up"
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const VM = require(process.env.TW_VM);
const file = process.argv[2] || new URL('build/doom.sb3', import.meta.url).pathname;
const frames = +(process.argv[3] || 30);
const keys = (process.argv[4] || '').split(',').filter(Boolean).map((s) => { const [f, k, d] = s.split(':'); return { f: +f, k, d: d !== 'up' }; });

const vm = new VM();
for (const m of ['log', 'warn', 'error']) console[m] = ((orig) => (...a) => { if (!String(a[0]).includes('[')) orig(...a); })(console[m]);
let t = Date.now();
await vm.loadProject(fs.readFileSync(file));
console.log(`load ${Date.now() - t} ms`);
vm.setFramerate?.(30);
vm.runtime.currentStepTime = 1000 / 30;
vm.greenFlag();
const sprite = vm.runtime.targets.filter((x) => !x.isStage).pop();
const stdout = Object.values(sprite.variables).find((v) => v.name === 'stdout');
let printed = 0;
const t0 = Date.now();
for (let f = 0; f < frames; f++) {
  for (const e of keys) if (e.f === f) vm.postIOData('keyboard', { key: e.k === 'space' ? ' ' : e.k === 'enter' ? 'Enter' : e.k, isDown: e.d });
  t = Date.now();
  vm.runtime._step();
  const ms = Date.now() - t;
  while (printed < stdout.value.length) console.log('  | ' + stdout.value[printed++]);
  console.log(`frame ${f}: ${ms} ms`);
}
console.log(`total ${Date.now() - t0} ms`);
process.exit(0);
