// A tiny AST for Scratch 3 scripts.
//
// Expressions (reporters):
//   {t:'n', v}                 number literal
//   {t:'s', v}                 string literal
//   {t:'v', name}              variable
//   {t:'a', name}              custom-block argument
//   {t:'o', op, a, b}          operator: add sub mul div mod lt eq gt and or not join letter length contains round random
//   {t:'m', fn, a}             operator_mathop: abs floor ceiling sqrt sin cos tan asin acos atan ln log 'e ^' '10 ^'
//   {t:'i', list, a}           item (a) of list
//   {t:'ll', list}             length of list
//   {t:'in', list, a}          item # of (a) in list
//   {t:'blk', opcode, inputs, fields, bool}   any other reporter
// Nodes that evaluate to a Scratch boolean carry `bool: true`.
//
// Statements:
//   {s:'set', name, v} {s:'change', name, v}
//   {s:'ladd', list, v} {s:'ldel', list, i} {s:'lclear', list} {s:'lrep', list, i, v} {s:'lins', list, i, v}
//   {s:'if', c, a, b} {s:'until', c, body} {s:'repeat', n, body} {s:'forever', body}
//   {s:'call', proc, args} {s:'stop', what}
//   {s:'blk', opcode, inputs, fields, substacks}

export const num = (v) => ({ t: 'n', v });
export const str = (v) => ({ t: 's', v });
export const v = (name) => ({ t: 'v', name });
export const arg = (name) => ({ t: 'a', name });

export function E(x) {
  if (typeof x === 'number') return { t: 'n', v: x };
  if (x === undefined || x === null || typeof x !== 'object') throw new Error(`bad Scratch expression: ${x}`);
  return x;
}

const bin = (op) => (a, b) => ({ t: 'o', op, a: E(a), b: E(b) });
const binBool = (op) => (a, b) => ({ t: 'o', op, a: E(a), b: E(b), bool: true });
export const add = bin('add');
export const sub = bin('sub');
export const mul = bin('mul');
export const div = bin('div');
export const mod = bin('mod');
export const lt = binBool('lt');
export const eq = binBool('eq');
export const gt = binBool('gt');
export const and = binBool('and');
export const or = binBool('or');
export const not = (a) => ({ t: 'o', op: 'not', a: E(a), bool: true });
export const join = bin('join');
export const letter = (i, s) => ({ t: 'o', op: 'letter', a: E(i), b: E(s) });
export const length = (s) => ({ t: 'o', op: 'length', a: E(s) });
export const contains = binBool('contains');
export const round = (a) => ({ t: 'o', op: 'round', a: E(a) });
export const random = bin('random');
const mathop = (fn) => (a) => ({ t: 'm', fn, a: E(a) });
export const floor = mathop('floor');
export const ceil = mathop('ceiling');
export const abs = mathop('abs');
export const sqrt = mathop('sqrt');
export const ln = mathop('ln');
export const item = (list, i) => ({ t: 'i', list, a: E(i) });
export const listLen = (list) => ({ t: 'll', list });
export const itemNum = (list, x) => ({ t: 'in', list, a: E(x) });
export const reporter = (opcode, inputs = {}, fields = {}, bool = false) => ({ t: 'blk', opcode, inputs, fields, bool });

// le / ge / ne built from the three comparison blocks Scratch has.
export const le = (a, b) => not(gt(a, b));
export const ge = (a, b) => not(lt(a, b));
export const ne = (a, b) => not(eq(a, b));

export const set = (name, x) => ({ s: 'set', name, v: E(x) });
export const change = (name, x) => ({ s: 'change', name, v: E(x) });
export const ladd = (list, x) => ({ s: 'ladd', list, v: E(x) });
export const ldel = (list, i) => ({ s: 'ldel', list, i: typeof i === 'string' ? str(i) : E(i) });
export const lclear = (list) => ({ s: 'lclear', list });
export const lrep = (list, i, x) => ({ s: 'lrep', list, i: typeof i === 'string' ? str(i) : E(i), v: E(x) });
export const lins = (list, i, x) => ({ s: 'lins', list, i: E(i), v: E(x) });
export const iff = (c, a, b = null) => ({ s: 'if', c, a, b });
export const until = (c, body) => ({ s: 'until', c, body });
export const repeat = (n, body) => ({ s: 'repeat', n: E(n), body });
export const forever = (body) => ({ s: 'forever', body });
export const call = (proc, ...args) => ({ s: 'call', proc, args: args.map(E) });
export const stopThis = () => ({ s: 'stop', what: 'this script' });
export const stopAll = () => ({ s: 'stop', what: 'all' });
export const stmt = (opcode, inputs = {}, fields = {}, substacks = null) => ({ s: 'blk', opcode, inputs, fields, substacks });

export const isConst = (e) => e.t === 'n';
// "Simple" expressions are free to duplicate: literals, variables, arguments.
export const isSimple = (e) => e.t === 'n' || e.t === 'v' || e.t === 'a' || e.t === 's';

// Number of blocks an expression expands to (literals and variables are free-ish).
export function exprSize(e) {
  switch (e.t) {
    case 'n': case 's': case 'v': case 'a': return 0;
    case 'o': return 1 + exprSize(e.a) + (e.b ? exprSize(e.b) : 0);
    case 'm': case 'i': case 'in': return 1 + exprSize(e.a);
    case 'll': return 1;
    case 'blk': {
      let n = 1;
      for (const k in e.inputs) if (e.inputs[k] && e.inputs[k].t) n += exprSize(e.inputs[k]);
      return n;
    }
    default: return 1;
  }
}

// Visits every variable / list an expression reads.
export function walkExpr(e, fn) {
  fn(e);
  switch (e.t) {
    case 'o': walkExpr(e.a, fn); if (e.b) walkExpr(e.b, fn); break;
    case 'm': case 'i': case 'in': walkExpr(e.a, fn); break;
    case 'blk': for (const k in e.inputs) if (e.inputs[k] && e.inputs[k].t) walkExpr(e.inputs[k], fn); break;
    default: break;
  }
}

export function readsVar(e, name) {
  let found = false;
  walkExpr(e, (n) => { if (n.t === 'v' && n.name === name) found = true; });
  return found;
}

// Returns `e` with every read of variable `name` replaced by `repl`.
export function substVar(e, name, repl) {
  switch (e.t) {
    case 'v': return e.name === name ? repl : e;
    case 'o': {
      const a = substVar(e.a, name, repl), b = e.b ? substVar(e.b, name, repl) : e.b;
      return a === e.a && b === e.b ? e : { ...e, a, b };
    }
    case 'm': case 'i': case 'in': {
      const a = substVar(e.a, name, repl);
      return a === e.a ? e : { ...e, a };
    }
    case 'blk': {
      let changed = false;
      const inputs = {};
      for (const k in e.inputs) {
        const x = e.inputs[k];
        inputs[k] = x && x.t ? substVar(x, name, repl) : x;
        if (inputs[k] !== x) changed = true;
      }
      return changed ? { ...e, inputs } : e;
    }
    default: return e;
  }
}

// Constant folding with Scratch's own arithmetic semantics.
const FOLD_BIN = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  mod: (a, b) => { let r = a % b; if (r / b < 0) r += b; return r; },
};
const FOLD_UN = { floor: Math.floor, ceiling: Math.ceil, abs: Math.abs };

export function fold(e) {
  if (e._f) return e;
  let out = e;
  if (e.t === 'o' && FOLD_BIN[e.op]) {
    const a = fold(e.a), b = fold(e.b);
    if (a.t === 'n' && b.t === 'n') {
      const r = FOLD_BIN[e.op](a.v, b.v);
      if (!Number.isNaN(r)) out = { t: 'n', v: r };
    } else if (a !== e.a || b !== e.b) {
      out = { ...e, a, b };
    }
  } else if (e.t === 'm' && FOLD_UN[e.fn]) {
    const a = fold(e.a);
    if (a.t === 'n') out = { t: 'n', v: FOLD_UN[e.fn](a.v) };
    else if (a !== e.a) out = { ...e, a };
  }
  if (out === e) e._f = true; else out._f = true;
  return out;
}
