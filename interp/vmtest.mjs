// Runs a Python-runner .sb3 in scratch-vm (or TurboWarp's, TW_VM=path) with
// the given program in the "Python code" list. The runner keeps a frame loop
// going forever, so the run ends when the program prints its last line
// (a marker appended to the program). Prints stdout and timings.
//   node interp/vmtest.mjs project.sb3 prog.py [stdin...]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import JSZip from 'jszip';

const require = createRequire(import.meta.url);
const [file, prog, ...stdin] = process.argv.slice(2);
const MARK = '__END__';
const zip = await JSZip.loadAsync(fs.readFileSync(file));
const pj = JSON.parse(await zip.file('project.json').async('string'));
const code = fs.readFileSync(prog, 'utf8').replace(/\n$/, '').split('\n').concat([`print("${MARK}")`]);
for (const t of pj.targets) for (const id in t.lists) if (t.lists[id][0] === 'Python code') t.lists[id][1] = code;
zip.file('project.json', JSON.stringify(pj));
const sb3 = await zip.generateAsync({ type: 'nodebuffer' });

const quiet = () => {};
const orig = [console.log, console.warn, console.error];
console.warn = console.error = quiet;
try { require('minilog').disable(); } catch { /* optional */ }
const VM = require(process.env.TW_VM || 'scratch-vm');
const vm = new VM();
if (process.env.TW_VM) vm.setCompilerOptions({ enabled: true, warpTimer: false });
const t0 = Date.now();
await vm.loadProject(sb3);
const loadMs = Date.now() - t0;
const answers = [...stdin];
vm.runtime.on('QUESTION', (q) => { if (q !== null) setImmediate(() => vm.runtime.emit('ANSWER', answers.length ? answers.shift() : '')); });
vm.runtime.currentStepTime = 1000 / 30;
const sprite = vm.runtime.targets.filter((t) => !t.isStage).pop();
const stdout = Object.values(sprite.variables).find((v) => v.name === 'stdout');
const t1 = Date.now();
vm.greenFlag();
let frames = 0, firstOut = null;
// An uncaught Python exception ends the program before the marker prints.
const finishedWithError = () => {
  const v = stdout.value;
  return v.some((l) => String(l).startsWith('Traceback')) && /^[A-Za-z]+(Error|Exception)\b/.test(String(v[v.length - 1]));
};
const limit = +(process.env.TIMEOUT || 1800) * 1000;
while (Date.now() - t1 < limit) {
  vm.runtime._step();
  frames++;
  if (firstOut === null && stdout.value.length) firstOut = Date.now() - t1;
  if (stdout.value.includes(MARK) || finishedWithError()) break;
  await new Promise((r) => setImmediate(r));
}
const ms = Date.now() - t1;
console.log = orig[0];
console.log(stdout.value.filter((l) => l !== MARK).join('\n'));
console.log(`[${process.env.TW_VM ? 'turbowarp' : 'scratch-vm'}: load ${loadMs} ms, first output ${firstOut} ms, total ${ms} ms, ${frames} frames${stdout.value.includes(MARK) || finishedWithError() ? '' : ', TIMED OUT'}]`);
process.exit(0);
