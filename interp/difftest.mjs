// Runs Python programs on two reactor builds (e.g. interpreter vs hybrid) in
// Node and compares their output.
//   node interp/difftest.mjs a.wasm b.wasm prog.py...
import fs from 'node:fs';
import { runReactor } from './host.mjs';
const [a, b, ...progs] = process.argv.slice(2);
let fail = 0;
for (const p of progs) {
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const ra = await runReactor(fs.readFileSync(a), { lines, stdin: ['Ada'] });
  const rb = await runReactor(fs.readFileSync(b), { lines, stdin: ['Ada'] });
  const same = ra.stdout.join('\n') === rb.stdout.join('\n') && ra.exitCode === rb.exitCode;
  console.log(`${same ? 'ok  ' : 'FAIL'} ${p}  (${ra.ms.toFixed(0)} ms vs ${rb.ms.toFixed(0)} ms)`);
  if (!same) { fail++; console.log('--- a ---\n' + ra.stdout.slice(-8).join('\n') + '\n--- b ---\n' + rb.stdout.slice(-8).join('\n')); }
}
process.exit(fail ? 1 : 0);
