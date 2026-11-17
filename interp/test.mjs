// Differential test for the interpreter: each guest runs directly (Node's
// WebAssembly) and inside the interpreter (also in Node); output must match.
//   node interp/test.mjs [filter]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import wabtInit from 'wabt';
import { runNative } from '../test/native.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const filter = process.argv[2] || '';
const wabt = await wabtInit();
const prelude = fs.readFileSync(path.join(root, 'test/programs/_prelude.wat'), 'utf8');
const guests = [];
for (const f of fs.readdirSync(path.join(root, 'test/programs')).filter((f) => f.endsWith('.wat') && !f.startsWith('_'))) {
  const m = wabt.parseWat(f, fs.readFileSync(path.join(root, 'test/programs', f), 'utf8').replace(';;@prelude', prelude), { exceptions: true, bulk_memory: true, sign_extension: true, sat_float_to_int: true, multi_value: true });
  m.resolveNames(); m.validate();
  const out = path.join(root, 'interp/build', f.replace('.wat', '.guest.wasm'));
  fs.writeFileSync(out, Buffer.from(m.toBinary({}).buffer));
  guests.push({ name: f, wasm: out, stdin: path.join(root, 'test/programs', f.replace('.wat', '.stdin')) });
}
for (const f of fs.readdirSync(path.join(root, 'build')).filter((f) => /-O[02]\.wasm$/.test(f))) {
  guests.push({ name: f, wasm: path.join(root, 'build', f), stdin: path.join(root, 'test/c', f.replace(/-O[02]\.wasm$/, '.stdin')) });
}
let pass = 0, fail = 0;
for (const g of guests.filter((x) => x.name.includes(filter))) {
  const stdin = fs.existsSync(g.stdin) ? fs.readFileSync(g.stdin, 'utf8').split('\n') : [];
  execFileSync(path.join(root, 'interp/build.sh'), [g.wasm, 'under-test'], { stdio: 'pipe' });
  const direct = await runNative(fs.readFileSync(g.wasm), { stdin });
  const interp = await runNative(fs.readFileSync(path.join(root, 'interp/build/under-test.wasm')), { stdin });
  const a = direct.stdout.join('\n'), b = interp.stdout.join('\n');
  // Trap messages differ between engines; compare up to the trap line.
  const norm = (s) => s.replace(/wasm trap: .*/g, 'wasm trap');
  if (norm(a) === norm(b) && direct.exitCode === interp.exitCode) { pass++; console.log('ok  ', g.name); }
  else { fail++; console.log('FAIL', g.name, `exit ${direct.exitCode} vs ${interp.exitCode}\n--- direct ---\n${a.slice(0, 600)}\n--- interpreted ---\n${b.slice(0, 600)}`); }
}
console.log(`${pass} passed, ${fail} failed`);
