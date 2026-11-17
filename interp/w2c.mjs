// w2c.mjs: translates selected guest functions to C for the hybrid build.
//
// The generated file is #included by wasmi.c (-DHYBRID). Each selected guest
// function K becomes `static T n_K(...)`, compiled (with the interpreter) by
// clang and then by wasm2sb3 into ordinary Scratch blocks, so it runs at
// directly-compiled speed. Everything else stays interpreted:
//   * guest memory is the interpreter's `mem` array, guest globals its
//     `globals[]` (64-bit slots, i32/f32 values zero-extended)
//   * calls to other native functions are direct C calls; calls to
//     interpreted functions go through icall(), imports through host_call()
//   * exceptions use a pending flag instead of unwinding: a throw sets
//     exn_pending (+ exn_tag/exn_vals) and jumps to the innermost handler; after
//     each call that may throw the flag is tested. A function with no handler
//     returns with the flag set, and the interpreter picks it up at the boundary.
//
//   node interp/w2c.mjs guest.wasm funcs.txt out.c
// funcs.txt: one function name (or #index) per line.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseWasm } from '../src/wasm/parser.js';

const CT = { i32: 'u32', i64: 'u64', f32: 'float', f64: 'double' };
const NAT = { i32: 4, i64: 8, f32: 4, f64: 8 };

class Unsupported extends Error {}

// Which functions may let an exception escape (conservative).
function mayThrowSet(mod) {
  const direct = new Set();
  const callers = mod.funcs.map(() => []);
  const visit = (f, list) => {
    for (const ins of list) {
      if (ins.op === 'throw' || ins.op === 'rethrow' || ins.op === 'call_indirect' || ins.op === 'return_call_indirect') direct.add(f.index);
      if (ins.op === 'call' || ins.op === 'return_call') callers[ins.func].push(f.index);
      for (const k of ['body', 'then', 'else', 'catchAll']) if (ins[k]) visit(f, ins[k]);
      if (ins.catches) for (const c of ins.catches) visit(f, c.body);
    }
  };
  for (const f of mod.funcs) if (!f.import) visit(f, f.body);
  const out = new Set(direct);
  const work = [...direct];
  while (work.length) {
    const g = work.pop();
    for (const c of callers[g]) if (!out.has(c)) { out.add(c); work.push(c); }
  }
  return out;
}

const toV = (t, e) => t === 'f32' ? `bitsf32(${e})` : t === 'f64' ? `bitsf64(${e})` : `(V)(${e})`;
const fromV = (t, e) => t === 'f32' ? `f32of(${e})` : t === 'f64' ? `f64of(${e})` : t === 'i32' ? `(u32)(${e})` : `(${e})`;

function lit(t, v) {
  if (t === 'i32') return `${v >>> 0}u`;
  if (t === 'i64') return `${BigInt.asUintN(64, v)}ull`;
  const bits = (x, f32) => {
    const b = Buffer.alloc(8);
    if (f32) { b.writeFloatLE(x); return `f32of(${b.readUInt32LE(0)}u)`; }
    b.writeDoubleLE(x); return `f64of(${b.readBigUInt64LE(0)}ull)`;
  };
  if (!Number.isFinite(v) || Object.is(v, -0)) return bits(v, t === 'f32');
  if (t === 'f32') return Number.isInteger(v) && Math.abs(v) < 2 ** 24 ? `${v}.0f` : bits(v, true);
  return Number.isInteger(v) && Math.abs(v) < 2 ** 53 ? `${v}.0` : bits(v, false);
}

// Binary / unary numeric ops: [resultType, C expression of a, b].
const S32 = (x) => `(int32_t)${x}`, S64 = (x) => `(int64_t)${x}`;
const OPS = {};
const def = (names, rt, fn) => names.split(' ').forEach((n) => { OPS[n] = [rt, fn]; });
for (const [p, S, bits] of [['i32', S32, 32], ['i64', S64, 64]]) {
  const T = CT[p];
  def(`${p}.eqz`, 'i32', (a) => `(u32)(${a} == 0)`);
  def(`${p}.eq`, 'i32', (a, b) => `(u32)(${a} == ${b})`);
  def(`${p}.ne`, 'i32', (a, b) => `(u32)(${a} != ${b})`);
  for (const [o, c] of [['lt', '<'], ['gt', '>'], ['le', '<='], ['ge', '>=']]) {
    def(`${p}.${o}_s`, 'i32', (a, b) => `(u32)(${S(a)} ${c} ${S(b)})`);
    def(`${p}.${o}_u`, 'i32', (a, b) => `(u32)(${a} ${c} ${b})`);
  }
  def(`${p}.clz`, p, (a) => `(${T})__builtin_clzg(${a}, ${bits})`);
  def(`${p}.ctz`, p, (a) => `(${T})__builtin_ctzg(${a}, ${bits})`);
  def(`${p}.popcnt`, p, (a) => `(${T})__builtin_popcountg(${a})`);
  def(`${p}.add`, p, (a, b) => `${a} + ${b}`);
  def(`${p}.sub`, p, (a, b) => `${a} - ${b}`);
  def(`${p}.mul`, p, (a, b) => `${a} * ${b}`);
  def(`${p}.div_s`, p, (a, b) => `(${T})(${S(a)} / ${S(b)})`);
  def(`${p}.div_u`, p, (a, b) => `${a} / ${b}`);
  def(`${p}.rem_s`, p, (a, b) => `(${T})(${b} == (${T})-1 ? 0 : ${S(a)} % ${S(b)})`);
  def(`${p}.rem_u`, p, (a, b) => `${a} % ${b}`);
  def(`${p}.and`, p, (a, b) => `${a} & ${b}`);
  def(`${p}.or`, p, (a, b) => `${a} | ${b}`);
  def(`${p}.xor`, p, (a, b) => `${a} ^ ${b}`);
  def(`${p}.shl`, p, (a, b) => `${a} << (${b} & ${bits - 1})`);
  def(`${p}.shr_s`, p, (a, b) => `(${T})(${S(a)} >> (${b} & ${bits - 1}))`);
  def(`${p}.shr_u`, p, (a, b) => `${a} >> (${b} & ${bits - 1})`);
  def(`${p}.rotl`, p, (a, b) => `__builtin_rotateleft${bits}(${a}, ${b})`);
  def(`${p}.rotr`, p, (a, b) => `__builtin_rotateright${bits}(${a}, ${b})`);
}
for (const [p, sfx] of [['f32', 'f'], ['f64', '']]) {
  for (const [o, c] of [['eq', '=='], ['ne', '!='], ['lt', '<'], ['gt', '>'], ['le', '<='], ['ge', '>=']]) {
    def(`${p}.${o}`, 'i32', (a, b) => `(u32)(${a} ${c} ${b})`);
  }
  def(`${p}.abs`, p, (a) => `__builtin_fabs${sfx}(${a})`);
  def(`${p}.neg`, p, (a) => `-${a}`);
  def(`${p}.ceil`, p, (a) => `__builtin_ceil${sfx}(${a})`);
  def(`${p}.floor`, p, (a) => `__builtin_floor${sfx}(${a})`);
  def(`${p}.trunc`, p, (a) => `__builtin_trunc${sfx}(${a})`);
  def(`${p}.nearest`, p, (a) => `__builtin_roundeven${sfx}(${a})`);
  def(`${p}.sqrt`, p, (a) => `__builtin_sqrt${sfx}(${a})`);
  def(`${p}.add`, p, (a, b) => `${a} + ${b}`);
  def(`${p}.sub`, p, (a, b) => `${a} - ${b}`);
  def(`${p}.mul`, p, (a, b) => `${a} * ${b}`);
  def(`${p}.div`, p, (a, b) => `${a} / ${b}`);
  def(`${p}.min`, p, (a, b) => `__builtin_wasm_min_${p}(${a}, ${b})`);
  def(`${p}.max`, p, (a, b) => `__builtin_wasm_max_${p}(${a}, ${b})`);
  def(`${p}.copysign`, p, (a, b) => `__builtin_copysign${sfx}(${a}, ${b})`);
}
def('i32.wrap_i64', 'i32', (a) => `(u32)${a}`);
def('i32.trunc_f32_s i32.trunc_f64_s', 'i32', (a) => `(u32)(int32_t)${a}`);
def('i32.trunc_f32_u i32.trunc_f64_u', 'i32', (a) => `(u32)${a}`);
def('i64.extend_i32_s', 'i64', (a) => `(u64)(int64_t)(int32_t)${a}`);
def('i64.extend_i32_u', 'i64', (a) => `(u64)${a}`);
def('i64.trunc_f32_s i64.trunc_f64_s', 'i64', (a) => `(u64)(int64_t)${a}`);
def('i64.trunc_f32_u i64.trunc_f64_u', 'i64', (a) => `(u64)${a}`);
def('f32.convert_i32_s', 'f32', (a) => `(float)(int32_t)${a}`);
def('f32.convert_i64_s', 'f32', (a) => `(float)(int64_t)${a}`);
def('f32.convert_i32_u f32.convert_i64_u f32.demote_f64', 'f32', (a) => `(float)${a}`);
def('f64.convert_i32_s', 'f64', (a) => `(double)(int32_t)${a}`);
def('f64.convert_i64_s', 'f64', (a) => `(double)(int64_t)${a}`);
def('f64.convert_i32_u f64.convert_i64_u f64.promote_f32', 'f64', (a) => `(double)${a}`);
def('i32.reinterpret_f32', 'i32', (a) => `(u32)bitsf32(${a})`);
def('i64.reinterpret_f64', 'i64', (a) => `bitsf64(${a})`);
def('f32.reinterpret_i32', 'f32', (a) => `f32of(${a})`);
def('f64.reinterpret_i64', 'f64', (a) => `f64of(${a})`);
def('i32.extend8_s', 'i32', (a) => `(u32)(int32_t)(int8_t)${a}`);
def('i32.extend16_s', 'i32', (a) => `(u32)(int32_t)(int16_t)${a}`);
def('i64.extend8_s', 'i64', (a) => `(u64)(int64_t)(int8_t)${a}`);
def('i64.extend16_s', 'i64', (a) => `(u64)(int64_t)(int16_t)${a}`);
def('i64.extend32_s', 'i64', (a) => `(u64)(int64_t)(int32_t)${a}`);
for (const [n, s, i, f] of [['i32.trunc_sat_f32_s', 's', 'i32', 'f32'], ['i32.trunc_sat_f32_u', 'u', 'i32', 'f32'],
  ['i32.trunc_sat_f64_s', 's', 'i32', 'f64'], ['i32.trunc_sat_f64_u', 'u', 'i32', 'f64'],
  ['i64.trunc_sat_f32_s', 's', 'i64', 'f32'], ['i64.trunc_sat_f32_u', 'u', 'i64', 'f32'],
  ['i64.trunc_sat_f64_s', 's', 'i64', 'f64'], ['i64.trunc_sat_f64_u', 'u', 'i64', 'f64']]) {
  def(n, i, (a) => `(${CT[i]})__builtin_wasm_trunc_saturate_${s}_${i}_${f}(${a})`);
}

// Memory access: [type, bytes, signed, resultType].
const LOADS = {
  'i32.load': ['u32', 4, '', 'i32'], 'i64.load': ['u64', 8, '', 'i64'], 'f32.load': ['float', 4, '', 'f32'], 'f64.load': ['double', 8, '', 'f64'],
  'i32.load8_s': ['int8_t', 1, 'i32', 'i32'], 'i32.load8_u': ['uint8_t', 1, '', 'i32'],
  'i32.load16_s': ['int16_t', 2, 'i32', 'i32'], 'i32.load16_u': ['uint16_t', 2, '', 'i32'],
  'i64.load8_s': ['int8_t', 1, 'i64', 'i64'], 'i64.load8_u': ['uint8_t', 1, '', 'i64'],
  'i64.load16_s': ['int16_t', 2, 'i64', 'i64'], 'i64.load16_u': ['uint16_t', 2, '', 'i64'],
  'i64.load32_s': ['int32_t', 4, 'i64', 'i64'], 'i64.load32_u': ['u32', 4, '', 'i64'],
};
const STORES = {
  'i32.store': ['u32', 4], 'i64.store': ['u64', 8], 'f32.store': ['float', 4], 'f64.store': ['double', 8],
  'i32.store8': ['uint8_t', 1], 'i32.store16': ['uint16_t', 2],
  'i64.store8': ['uint8_t', 1], 'i64.store16': ['uint16_t', 2], 'i64.store32': ['u32', 4],
};
// An access whose alignment hint is below the natural alignment goes through
// a typedef with that alignment, so clang (and then wasm2sb3) see the same hint.
function ptrType(ct, bytes, alignLog) {
  const a = Math.min(bytes, 2 ** alignLog);
  return a >= bytes || bytes === 1 ? ct : `${ct.replace(/_t$/, '')}_a${a}`;
}

class FuncGen {
  constructor(mod, f, ctx) {
    this.mod = mod; this.f = f; this.ctx = ctx;
    this.lines = [];
    this.decls = { u32: [], u64: [], float: [], double: [] };
    this.nt = 0; this.nl = 0;
    this.stack = [];
    this.labels = [];
    this.results = f.type.results;
    if (this.results.length > 1) throw new Unsupported('multi-value result');
    this.ret = this.results.length ? CT[this.results[0]] : 'void';
    this.retExn = this.results.length ? 'return 0;' : 'return;';
    this.usesRethrow = false;
  }

  tmp(t) { const n = `t${this.nt++}`; this.decls[CT[t]].push(n); return n; }
  emit(s) { this.lines.push('  ' + s); }
  push(t, expr) { const n = this.tmp(t); this.emit(`${n} = ${expr};`); this.stack.push({ n, t }); return n; }
  pop() { if (!this.stack.length) throw new Error('stack underflow'); return this.stack.pop(); }
  label() { return `L${this.nl++}`; }
  localType(i) {
    const np = this.f.type.params.length;
    return i < np ? this.f.type.params[i] : this.f.locals[i - np];
  }

  blockTypes(bt) {
    if (bt === null) return { params: [], results: [] };
    if (typeof bt === 'string') return { params: [], results: [bt] };
    const ty = this.mod.types[bt];
    return { params: ty.params, results: ty.results };
  }

  // The goto target for an exception raised here.
  handler() {
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const l = this.labels[i];
      if (l.kind === 'try' && l.phase === 'body') return `goto ${l.catchL};`;
    }
    return this.retExn;
  }
  // Handler for an exception delegated to label depth d.
  handlerAt(d) {
    for (let i = this.labels.length - 1 - d; i >= 0; i--) {
      const l = this.labels[i];
      if (l.kind === 'try' && l.phase === 'body') return `goto ${l.catchL};`;
    }
    return this.retExn;
  }
  checkExn() { this.emit(`if (exn_pending) ${this.handler()}`); }

  // Branch to label depth d (values taken from the top of the stack, not popped).
  branch(d) {
    const l = this.labels[this.labels.length - 1 - d];
    if (l.kind === 'func') {
      if (this.results.length) return `return ${this.stack[this.stack.length - 1].n};`;
      return 'return;';
    }
    if (l.kind === 'loop') return `goto ${l.top};`;
    const vals = this.stack.slice(this.stack.length - l.results.length);
    const asg = l.resVars.map((v, i) => `${v} = ${vals[i].n}; `).join('');
    return `{ ${asg}goto ${l.end}; }`;
  }

  openBlock(kind, bt) {
    const { params, results } = this.blockTypes(bt);
    if (params.length) throw new Unsupported('block parameters');
    const l = { kind, results, resVars: results.map((t) => this.tmp(t)), end: this.label(), height: this.stack.length };
    this.labels.push(l);
    return l;
  }
  // Ends a block body that fell through: assign results and jump to the end.
  fallthrough(l) {
    if (this.dead) return;
    const vals = this.stack.slice(this.stack.length - l.results.length);
    l.resVars.forEach((v, i) => this.emit(`${v} = ${vals[i].n};`));
    this.emit(`goto ${l.end};`);
  }
  closeBlock(l) {
    this.labels.pop();
    this.stack.length = l.height;
    this.lines.push(`${l.end}:;`);
    this.dead = false;
    for (let i = 0; i < l.results.length; i++) this.stack.push({ n: l.resVars[i], t: l.results[i] });
    // Copy into fresh temps (a later branch to the same label must not change them).
    for (let i = l.results.length; i > 0; i--) {
      const s = this.stack[this.stack.length - i];
      const n = this.tmp(s.t);
      this.emit(`${n} = ${s.n};`);
      s.n = n;
    }
  }

  seq(list) {
    for (const ins of list) {
      if (this.dead) return;
      this.instr(ins);
    }
  }

  callArgs(type) {
    const n = type.params.length;
    const args = this.stack.splice(this.stack.length - n, n);
    return args;
  }
  finishCall(type, expr, mayThrow) {
    if (type.results.length > 1) throw new Unsupported('multi-value call');
    if (type.results.length) {
      const n = this.tmp(type.results[0]);
      this.emit(`${n} = ${expr};`);
      if (mayThrow) this.checkExn();
      this.stack.push({ n, t: type.results[0] });
    } else {
      this.emit(`${expr};`);
      if (mayThrow) this.checkExn();
    }
  }
  // Arguments for host_call/icall/call_any go through one global buffer:
  // every callee copies them out before doing anything else.
  packArgs(args) {
    if (args.length > 16) throw new Unsupported('too many arguments');
    args.forEach((x, i) => this.emit(`cargs[${i}] = ${toV(x.t, x.n)};`));
    return 'cargs';
  }

  instr(ins) {
    const { op } = ins;
    const ctx = this.ctx;
    if (OPS[op]) {
      const [rt, fn] = OPS[op];
      if (fn.length === 2) { const b = this.pop(), a = this.pop(); this.push(rt, fn(a.n, b.n)); }
      else { const a = this.pop(); this.push(rt, fn(a.n)); }
      return;
    }
    if (LOADS[op]) {
      const [ct, bytes, sx, rt] = LOADS[op];
      const a = this.pop();
      const p = `*(${ptrType(ct, bytes, ins.align)} *)(mem + ${a.n} + ${ins.offset}u)`;
      const e = sx === 'i32' ? `(u32)(int32_t)${p}` : sx === 'i64' ? `(u64)(int64_t)${p}` : `(${CT[rt]})${p}`;
      this.push(rt, e);
      return;
    }
    if (STORES[op]) {
      const [ct, bytes] = STORES[op];
      const v = this.pop(), a = this.pop();
      this.emit(`*(${ptrType(ct, bytes, ins.align)} *)(mem + ${a.n} + ${ins.offset}u) = (${ct})${v.n};`);
      return;
    }
    switch (op) {
      case 'nop': return;
      case 'unreachable': this.emit('trap("unreachable");'); this.dead = true; return;
      case 'i32.const': case 'i64.const': case 'f32.const': case 'f64.const': {
        const t = op.slice(0, 3);
        this.stack.push({ n: lit(t, ins.value), t });
        return;
      }
      case 'local.get': {
        const t = this.localType(ins.idx);
        this.push(t, `l${ins.idx}`);
        return;
      }
      case 'local.set': this.emit(`l${ins.idx} = ${this.pop().n};`); return;
      case 'local.tee': this.emit(`l${ins.idx} = ${this.stack[this.stack.length - 1].n};`); return;
      case 'global.get': {
        const g = this.mod.globals[ins.idx];
        const t = g.type;
        this.push(t, t === 'i64' ? `globals[${ins.idx}]` : `*(${CT[t]} *)&globals[${ins.idx}]`);
        return;
      }
      case 'global.set': {
        const g = this.mod.globals[ins.idx];
        const v = this.pop();
        this.emit(g.type === 'i64' ? `globals[${ins.idx}] = ${v.n};` : `*(${CT[g.type]} *)&globals[${ins.idx}] = ${v.n};`);
        return;
      }
      case 'drop': this.pop(); return;
      case 'select': {
        const c = this.pop(), b = this.pop(), a = this.pop();
        this.push(a.t, `${c.n} ? ${a.n} : ${b.n}`);
        return;
      }
      case 'memory.size': this.push('i32', 'mem_pages'); return;
      case 'memory.grow': {
        const n = this.pop();
        this.push('i32', `mem_grow(${n.n})`);
        return;
      }
      case 'memory.copy': {
        const n = this.pop(), s = this.pop(), d = this.pop();
        this.emit(`memmove(mem + ${d.n}, mem + ${s.n}, ${n.n});`);
        return;
      }
      case 'memory.fill': {
        const n = this.pop(), v = this.pop(), d = this.pop();
        this.emit(`memset(mem + ${d.n}, (int)${v.n}, ${n.n});`);
        return;
      }
      case 'block': {
        const l = this.openBlock('block', ins.bt);
        this.seq(ins.body);
        this.fallthrough(l);
        this.closeBlock(l);
        return;
      }
      case 'loop': {
        const l = this.openBlock('loop', ins.bt);
        l.top = this.label();
        this.lines.push(`${l.top}:;`);
        this.seq(ins.body);
        this.fallthrough(l);
        this.closeBlock(l);
        return;
      }
      case 'if': {
        const c = this.pop();
        const l = this.openBlock('if', ins.bt);
        const els = this.label();
        this.emit(`if (!${c.n}) goto ${els};`);
        this.seq(ins.then);
        this.fallthrough(l);
        this.stack.length = l.height;
        this.dead = false;
        this.lines.push(`${els}:;`);
        if (ins.else) this.seq(ins.else);
        this.fallthrough(l);
        this.closeBlock(l);
        return;
      }
      case 'try': {
        const l = this.openBlock('try', ins.bt);
        l.phase = 'body';
        l.catchL = this.label();
        l.saved = `x${this.nl++}`;
        this.seq(ins.body);
        this.fallthrough(l);
        this.stack.length = l.height;
        this.dead = false;
        l.phase = 'catch';
        this.lines.push(`${l.catchL}:;`);
        if (ins.delegate !== null && ins.delegate !== undefined) {
          // Rethrow at the delegate target (depth counted from inside the try).
          l.phase = 'done';
          this.labels.pop();
          this.emit(this.handlerAt(ins.delegate));
          this.labels.push(l);
          this.dead = true;
          this.closeBlock(l);
          return;
        }
        this.emit('exn_pending = 0;');
        this.lines.push(`  uint32_t ${l.saved}_t = exn_tag; V ${l.saved}_v0 = exn_vals[0], ${l.saved}_v1 = exn_vals[1], ${l.saved}_v2 = exn_vals[2], ${l.saved}_v3 = exn_vals[3];`);
        let next = null;
        for (const c of ins.catches) {
          if (next) this.lines.push(`${next}:;`);
          next = this.label();
          this.emit(`if (exn_tag != ${c.tag}) goto ${next};`);
          this.dead = false;
          this.stack.length = l.height;
          const tt = ctx.tagType(c.tag);
          tt.params.forEach((t, i) => this.push(t, fromV(t, `exn_vals[${i}]`)));
          this.seq(c.body);
          this.fallthrough(l);
        }
        if (next) this.lines.push(`${next}:;`);
        this.dead = false;
        this.stack.length = l.height;
        if (ins.catchAll) {
          this.seq(ins.catchAll);
          this.fallthrough(l);
        } else {
          // No clause matched: keep unwinding.
          this.labels.pop();
          this.emit(`exn_pending = 1; ${this.handler()}`);
          this.labels.push(l);
          this.dead = true;
        }
        this.closeBlock(l);
        return;
      }
      case 'throw': {
        const tt = ctx.tagType(ins.tag);
        const args = this.stack.splice(this.stack.length - tt.params.length);
        this.emit(`exn_tag = ${ins.tag};`);
        args.forEach((a, i) => this.emit(`exn_vals[${i}] = ${toV(a.t, a.n)};`));
        this.emit(`exn_pending = 1; ${this.handler()}`);
        this.dead = true;
        return;
      }
      case 'rethrow': {
        const l = this.labels[this.labels.length - 1 - ins.depth];
        const s = l.saved;
        this.emit(`exn_tag = ${s}_t; exn_vals[0] = ${s}_v0; exn_vals[1] = ${s}_v1; exn_vals[2] = ${s}_v2; exn_vals[3] = ${s}_v3;`);
        this.emit(`exn_pending = 1; ${this.handler()}`);
        this.dead = true;
        return;
      }
      case 'br': this.emit(this.branch(ins.depth)); this.dead = true; return;
      case 'br_if': {
        const c = this.pop();
        this.emit(`if (${c.n}) ${this.branch(ins.depth)}`);
        return;
      }
      case 'br_table': {
        const i = this.pop();
        const cases = new Map();
        ins.targets.forEach((d, k) => { if (d !== ins.default) { if (!cases.has(d)) cases.set(d, []); cases.get(d).push(k); } });
        this.emit(`switch (${i.n}) {`);
        for (const [d, ks] of cases) this.emit(`${ks.map((k) => `case ${k}:`).join(' ')} ${this.branch(d)}`);
        this.emit(`default: ${this.branch(ins.default)}`);
        this.emit('}');
        this.dead = true;
        return;
      }
      case 'return': this.emit(this.branch(this.labels.length - 1)); this.dead = true; return;
      case 'call': {
        const g = this.mod.funcs[ins.func];
        const args = this.callArgs(g.type);
        if (g.import) {
          const a = this.packArgs(args);
          const r = g.type.results[0];
          this.finishCall(g.type, r ? fromV(r, `host_call(funcs[${g.index}].host, ${a})`) : `host_call(funcs[${g.index}].host, ${a})`, false);
        } else if (ctx.native.has(g.index)) {
          this.finishCall(g.type, `n_${g.index}(${args.map((x) => x.n).join(', ')})`, ctx.mayThrow.has(g.index));
        } else {
          const a = this.packArgs(args);
          const r = g.type.results[0];
          this.finishCall(g.type, r ? fromV(r, `icall(${g.index}, ${a})`) : `icall(${g.index}, ${a})`, ctx.mayThrow.has(g.index));
        }
        return;
      }
      case 'call_indirect': {
        const type = this.mod.types[ins.type];
        const idx = this.pop();
        const args = this.callArgs(type);
        const fn = ctx.indirect(ins.type);
        this.finishCall(type, `${fn}(${[idx.n, ...args.map((x) => x.n)].join(', ')})`, true);
        return;
      }
      default:
        throw new Unsupported(`instruction ${op}`);
    }
  }

  gen() {
    const f = this.f;
    const np = f.type.params.length;
    const params = f.type.params.map((t, i) => `${CT[t]} l${i}`).join(', ') || 'void';
    this.labels.push({ kind: 'func', results: this.results });
    this.seq(f.body);
    if (!this.dead) this.emit(this.results.length ? `return ${this.pop().n};` : 'return;');
    const locals = f.locals.map((t, i) => `${CT[t]} l${np + i} = 0;`);
    const decl = Object.entries(this.decls).filter(([, v]) => v.length).map(([t, v]) => `  ${t} ${v.join(', ')};`);
    return [`static NOINLINE ${this.ret} n_${f.index}(${params}) {`, ...(locals.length ? ['  ' + locals.join(' ')] : []), ...decl, ...this.lines, '}'].join('\n');
  }
}

export function translate(mod, nativeIdx) {
  const native = new Set(nativeIdx);
  const mayThrow = mayThrowSet(mod);
  const tags = mod.tags.map((t) => t.type); // imported tags come first, as in the index space
  const indirectFns = new Map();
  // Table contents (to call native targets of call_indirect directly).
  const table = [];
  for (const el of mod.elems) {
    if (el.mode !== 'active' || !el.offset || el.offset[0].op !== 'i32.const') continue;
    el.funcs.forEach((g, k) => { if (g !== null) table[el.offset[0].value + k] = g; });
  }
  const ctx = {
    native, mayThrow,
    tagType: (i) => tags[i],
    indirect(typeIdx) {
      const type = mod.types[typeIdx];
      const key = `${type.params.join(',')}>${type.results.join(',')}`;
      if (!indirectFns.has(key)) indirectFns.set(key, { name: `ci_${indirectFns.size}`, type });
      return indirectFns.get(key).name;
    },
  };
  const out = [];
  const ok = [];
  const skipped = [];
  for (const i of native) {
    const f = mod.funcs[i];
    if (!f || f.import) { skipped.push([i, 'import']); continue; }
    try {
      out.push(new FuncGen(mod, f, ctx).gen());
      ok.push(i);
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      skipped.push([f.name || i, e.message]);
    }
  }
  if (skipped.length) {
    // Retry without the unsupported ones (their callers then use icall).
    for (const [n] of skipped) native.delete(typeof n === 'number' ? n : mod.funcs.findIndex((f) => f.name === n));
    return translate(mod, [...native]);
  }
  const sigKey = (t) => `${t.params.join(',')}>${t.results.join(',')}`;
  const protos = ok.map((i) => {
    const f = mod.funcs[i];
    const r = f.type.results.length ? CT[f.type.results[0]] : 'void';
    return `static ${r} n_${i}(${f.type.params.map((t) => CT[t]).join(', ') || 'void'});`;
  });
  // Only natives that interpreted code (or the host) can call need a case in
  // native_dispatch: called directly by an interpreted function, reachable
  // through the table, or exported.
  const entry = new Set();
  const callsIn = (list, fn) => {
    for (const ins of list) {
      if (ins.op === 'call' || ins.op === 'return_call') fn(ins.func);
      for (const k of ['body', 'then', 'else', 'catchAll']) if (ins[k]) callsIn(ins[k], fn);
      if (ins.catches) for (const c of ins.catches) callsIn(c.body, fn);
    }
  };
  for (const f of mod.funcs) if (!f.import && !native.has(f.index)) callsIn(f.body, (g) => entry.add(g));
  for (const g of table) if (g !== undefined) entry.add(g);
  for (const e of mod.exports) if (e.kind === 'func') entry.add(e.index);
  if (mod.start !== null) entry.add(mod.start);
  const disp = ok.filter((i) => entry.has(i)).map((i) => {
    const f = mod.funcs[i];
    const call = `n_${i}(${f.type.params.map((t, k) => fromV(t, `a[${k}]`)).join(', ')})`;
    return f.type.results.length ? `  case ${i}: return ${toV(f.type.results[0], call)};` : `  case ${i}: ${call}; return 0;`;
  });
  const ind = [];
  for (const { name, type } of indirectFns.values()) {
    const ps = type.params.map((t, k) => `${CT[t]} p${k}`);
    const r = type.results[0];
    const targets = [...new Set(table.filter((g) => g !== undefined && native.has(g) && sigKey(mod.funcs[g].type) === sigKey(type)))];
    const lines = [`static ${r ? CT[r] : 'void'} ${name}(${['uint32_t i', ...ps].join(', ')}) {`,
      `  uint32_t f = i < table_size ? table[i] : 0xffffffffu;`, '  switch (f) {'];
    for (const g of targets) {
      const call = `n_${g}(${type.params.map((_, k) => `p${k}`).join(', ')})`;
      lines.push(r ? `  case ${g}: return ${call};` : `  case ${g}: ${call}; return;`);
    }
    lines.push('  }');
    type.params.forEach((t, k) => lines.push(`  cargs[${k}] = ${toV(t, `p${k}`)};`));
    lines.push(r ? `  return ${fromV(r, 'call_any(f, cargs)')};` : '  call_any(f, cargs);');
    lines.push('}');
    ind.push(lines.join('\n'));
  }
  const src = [
    `// Generated by w2c.mjs: ${ok.length} natively compiled guest functions.`,
    `// native: ${ok.join(',')}`,
    ...protos,
    ...ind,
    ...out,
    `static void native_mark(void) {${ok.filter((i) => entry.has(i)).map((i) => ` funcs[${i}].native = 1;`).join('')} }`,
    'static NOINLINE V native_dispatch(uint32_t f, V *a) {',
    '  switch (f) {',
    ...disp,
    '  }',
    '  trap("bad native call");',
    '}',
  ].join('\n');
  return { src, ok };
}

if (fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [guest, list, outFile] = process.argv.slice(2);
  const mod = parseWasm(fs.readFileSync(guest));
  const byName = new Map(mod.funcs.map((f) => [f.name, f.index]));
  const idx = fs.readFileSync(list, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('//'))
    .map((s) => s.startsWith('#') ? +s.slice(1) : byName.get(s)).filter((x) => x !== undefined);
  const { src, ok } = translate(mod, idx);
  fs.writeFileSync(outFile, src + '\n');
  console.error(`w2c: ${ok.length}/${idx.length} functions translated`);
}
