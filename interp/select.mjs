// Picks which guest functions to compile natively: greedy by profiled work per
// byte of project.json, until the native code reaches a size budget.
//   node interp/select.mjs profile.json costs.json budgetBytes out.txt
// profile.json: from profile.mjs. costs.json: {funcIndex: bytes} measured from
// an all-native build. Crossing between interpreted and native code costs
// about as much as CALL_WEIGHT interpreted instructions, so calls count too.
import fs from 'node:fs';

const [profFile, costFile, budget, outFile] = process.argv.slice(2);
const prof = JSON.parse(fs.readFileSync(profFile, 'utf8'));
const cost = JSON.parse(fs.readFileSync(costFile, 'utf8'));
const CALL_WEIGHT = 25;
const calls = new Map();
for (const [k, n] of Object.entries(prof.edges)) {
  const to = +k.split('>')[1];
  calls.set(to, (calls.get(to) || 0) + n);
}
const total = prof.funcs.reduce((a, f) => a + f.instr, 0);
const cands = prof.funcs.filter((f) => !f.import && cost[f.i] && (f.instr > 0))
  .map((f) => ({ ...f, value: f.instr + CALL_WEIGHT * (calls.get(f.i) || 0), cost: cost[f.i] + 300 }))
  .sort((a, b) => b.value / b.cost - a.value / a.cost);
let used = 0, covered = 0;
const pick = [];
for (const c of cands) {
  if (used + c.cost > +budget) continue;
  used += c.cost; covered += c.instr;
  pick.push(c);
}
fs.writeFileSync(outFile, pick.map((c) => c.name).join('\n') + '\n');
console.error(`selected ${pick.length} functions, ~${(used / 1024).toFixed(0)} KiB, covering ${(covered / total * 100).toFixed(1)}% of interpreted instructions`);
