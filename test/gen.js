// Generates WAT modules that exercise one numeric operator over many inputs.
// Each module writes its results to memory starting at OUT and stores the end
// pointer at address 1020, so native and Scratch runs can be compared word by word.

export const OUT = 4096;
// Offset -> description of the most recently generated float test.
export const labels = new Map();

const I32_VALUES = [0, 1, 2, 31, 32, 255, 0x8000, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff, 0x89abcdef, 0x12345678, 1000000007, 0x00ff00ff];
const I32_CONSTS = [0, 1, 2, 3, 4, 8, 31, 32, 33, 255, 0xff00, 0xffff0000, 0x7fffffff, 0x80000000, 0xffffffff, 0x0f0f0f0f, 12345];
const I64_VALUES = [0n, 1n, 2n, 63n, 64n, 0xffffffffn, 0x100000000n, 0x7fffffffffffffffn, 0x8000000000000000n, 0xffffffffffffffffn,
  0xfffffffffffffffen, 0x123456789abcdef0n, 0xfedcba9876543210n, 0x38d7ea4c68000n, 0x20000000000001n];
const I64_CONSTS = [0n, 1n, 2n, 3n, 8n, 31n, 32n, 33n, 63n, 64n, 255n, 0xffffffffn, 0x100000000n, 0xffffffff00000000n, 0x8000000000000000n, 0xffffffffffffffffn, 1000000007n];

const hex = (n, bytes) => {
  let s = '';
  let x = BigInt.asUintN(bytes * 8, BigInt(n));
  for (let i = 0; i < bytes; i++) { s += '\\' + Number(x & 0xffn).toString(16).padStart(2, '0'); x >>= 8n; }
  return s;
};

// Transforms applied to operands so that operator lowering sees operands of
// different shapes (plain variables, list reads, masked values).
const T32 = {
  id: (x) => x,
  lo8: (x) => `(i32.and ${x} (i32.const 255))`,
  hi12: (x) => `(i32.shr_u ${x} (i32.const 20))`,
  bit: (x) => `(i32.and ${x} (i32.const 1))`,
  sh4: (x) => `(i32.shl ${x} (i32.const 4))`,
};
const T64 = {
  id: (x) => x,
  lo8: (x) => `(i64.and ${x} (i64.const 255))`,
  u32: (x) => `(i64.extend_i32_u (i32.wrap_i64 ${x}))`,
  s32: (x) => `(i64.extend_i32_s (i32.wrap_i64 ${x}))`,
  hi: (x) => `(i64.shr_u ${x} (i64.const 40))`,
};
const PAIRS = [['id', 'id'], ['lo8', 'id'], ['id', 'lo8'], ['bit', 'bit'], ['hi12', 'sh4'], ['sh4', 'hi12']];
const PAIRS64 = [['id', 'id'], ['lo8', 'id'], ['u32', 'u32'], ['s32', 'id'], ['hi', 's32'], ['id', 'hi']];

function guard(ty, op, a, b) {
  const min = ty === 'i32' ? '(i32.const 0x80000000)' : '(i64.const 0x8000000000000000)';
  if (/div_s|rem_s/.test(op)) {
    return `(i32.or (${ty}.eqz ${b}) (i32.and (${ty}.eq ${a} ${min}) (${ty}.eq ${b} (${ty}.const -1))))`;
  }
  if (/div_u|rem_u/.test(op)) return `(${ty}.eqz ${b})`;
  return null;
}

export function genIntBinop(ty, op) {
  const is64 = ty === 'i64';
  const W = is64 ? 8 : 4;
  const values = is64 ? I64_VALUES : I32_VALUES;
  const consts = is64 ? I64_CONSTS : I32_CONSTS;
  const T = is64 ? T64 : T32;
  const pairs = is64 ? PAIRS64 : PAIRS;
  const N = values.length;
  const resTy = /eq|ne|lt|gt|le|ge/.test(op) ? 'i32' : ty;
  const RW = resTy === 'i64' ? 8 : 4;
  const load = (idx) => `(${ty}.load (i32.mul (local.get ${idx}) (i32.const ${W})))`;
  const store = (val) => `(${resTy}.store (local.get $o) ${val}) (local.set $o (i32.add (local.get $o) (i32.const ${RW})))`;
  const zero = `(${resTy}.const 0)`;
  const body = [];
  const emitOp = (a, b, ga, gb) => {
    const g = guard(ty, op, ga, gb);
    const expr = `(${ty}.${op} ${a} ${b})`;
    return g ? `(if (result ${resTy}) ${g} (then ${zero}) (else ${expr}))` : expr;
  };
  const loop2 = (inner) => `
    (local.set $i (i32.const 0))
    (loop $li
      (local.set $j (i32.const 0))
      (loop $lj
        ${inner}
        (br_if $lj (i32.lt_u (local.tee $j (i32.add (local.get $j) (i32.const 1))) (i32.const ${N}))))
      (br_if $li (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (i32.const ${N}))))`;
  const loop1 = (inner) => `
    (local.set $i (i32.const 0))
    (loop $li
      ${inner}
      (br_if $li (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (i32.const ${N}))))`;

  for (const [ta, tb] of pairs) {
    body.push(loop2(`
        (local.set $a ${T[ta](load('$i'))})
        (local.set $b ${T[tb](load('$j'))})
        ${store(emitOp('(local.get $a)', '(local.get $b)', '(local.get $a)', '(local.get $b)'))}
        ${store(emitOp(T[ta](load('$i')), T[tb](load('$j')), '(local.get $a)', '(local.get $b)'))}`));
  }
  for (const c of consts) {
    const k = `(${ty}.const ${is64 ? BigInt.asIntN(64, c) : c | 0})`;
    body.push(loop1(`
      (local.set $a ${load('$i')})
      ${store(emitOp('(local.get $a)', k, '(local.get $a)', k))}
      ${store(emitOp(k, '(local.get $a)', k, '(local.get $a)'))}
      ${store(emitOp(load('$i'), k, '(local.get $a)', k))}`));
  }
  const data = values.map((x) => hex(x, W)).join('');
  return `(module
  (memory (export "memory") 2)
  (data (i32.const 0) "${data}")
  (func (export "main")
    (local $i i32) (local $j i32) (local $o i32) (local $a ${ty}) (local $b ${ty})
    (local.set $o (i32.const ${OUT}))
    ${body.join('\n')}
    (i32.store (i32.const 1020) (local.get $o))))`;
}

export function genIntUnop(ty, op) {
  const is64 = ty === 'i64';
  const W = is64 ? 8 : 4;
  const values = is64 ? I64_VALUES : I32_VALUES;
  const T = is64 ? T64 : T32;
  const N = values.length;
  const resTy = op === 'eqz' ? 'i32' : op.startsWith('wrap') ? 'i32' : op.startsWith('extend_i32') ? 'i64' : ty;
  const srcTy = op.startsWith('extend_i32') ? 'i32' : ty;
  const SW = srcTy === 'i64' ? 8 : 4;
  const RW = resTy === 'i64' ? 8 : 4;
  const vals = srcTy === ty ? values : I32_VALUES;
  const load = `(${srcTy}.load (i32.mul (local.get $i) (i32.const ${SW})))`;
  const store = (val) => `(${resTy}.store (local.get $o) ${val}) (local.set $o (i32.add (local.get $o) (i32.const ${RW})))`;
  const Ts = srcTy === 'i64' ? T64 : T32;
  const body = Object.keys(Ts).map((t) => `
    (local.set $i (i32.const 0))
    (loop $li
      ${store(`(${resTy === ty || op === 'eqz' ? ty : resTy}.${op} ${Ts[t](load)})`)}
      (br_if $li (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (i32.const ${vals.length}))))`);
  void T; void N; void W;
  const data = vals.map((x) => hex(x, SW)).join('');
  return `(module
  (memory (export "memory") 1)
  (data (i32.const 0) "${data}")
  (func (export "main")
    (local $i i32) (local $o i32)
    (local.set $o (i32.const ${OUT}))
    ${body.join('\n')}
    (i32.store (i32.const 1020) (local.get $o))))`;
}

// ---- floats ------------------------------------------------------------------

const F64_VALUES = [0, -0, 1, -1, 0.5, 1.5, -2.25, 3.141592653589793, 1e10, -1e-10, 123456.789, 2 ** 53, 2 ** 53 + 2, 1e300, 5e-324, 2.2250738585072014e-308, Infinity, -Infinity, 0.1, 2.5, -3.5, 4294967295.5, -2147483648.75];
const F32_VALUES = F64_VALUES.map(Math.fround).filter((x, i, a) => a.findIndex((y) => Object.is(x, y)) === i);

const isNaNish = (x) => Number.isNaN(x);

function f32Exact(x) { return Object.is(Math.fround(x), x); }

// Straight-line test of float operators; NaN-producing inputs are skipped
// because Scratch cannot represent NaN.
export function genFloat(ty) {
  const vals = ty === 'f32' ? F32_VALUES : F64_VALUES;
  const W = ty === 'f32' ? 4 : 8;
  const R = ty === 'f32' ? Math.fround : (x) => x;
  const lines = [];
  let out = OUT;
  const ld = (i) => `(${ty}.load offset=${i * W} (local.get $z))`;
  labels.clear();
  const st = (rty, e) => {
    const w = rty === 'f64' || rty === 'i64' ? 8 : 4;
    out = Math.ceil(out / w) * w;
    lines.push(`(${rty}.store offset=${out} (i32.const 0) ${e})`);
    const desc = e.replace(/\(\w+\.load offset=(\d+) \(local\.get \$z\)\)/g, (_, o) => String(vals[o / W]));
    for (let k = 0; k < w; k += 4) labels.set(out + k, desc);
    out += w;
  };
  const bins = { add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => a * b, div: (a, b) => a / b, min: Math.min, max: Math.max, copysign: (a, b) => Math.sign(b) < 0 || Object.is(b, -0) ? -Math.abs(a) : Math.abs(a) };
  const cmps = ['eq', 'ne', 'lt', 'gt', 'le', 'ge'];
  for (let i = 0; i < vals.length; i++) {
    for (let j = 0; j < vals.length; j++) {
      const a = vals[i], b = vals[j];
      for (const [op, fn] of Object.entries(bins)) {
        if (isNaNish(R(fn(a, b)))) continue;
        st(ty, `(${ty}.${op} ${ld(i)} ${ld(j)})`);
      }
      for (const op of cmps) st('i32', `(${ty}.${op} ${ld(i)} ${ld(j)})`);
    }
    const a = vals[i];
    for (const op of ['abs', 'neg', 'ceil', 'floor', 'trunc', 'nearest']) st(ty, `(${ty}.${op} ${ld(i)})`);
    if (a >= 0 || Object.is(a, -0)) st(ty, `(${ty}.sqrt ${ld(i)})`);
    const t = Math.trunc(a);
    if (t >= -2147483648 && t <= 2147483647) st('i32', `(i32.trunc_${ty}_s ${ld(i)})`);
    if (t >= 0 && t <= 4294967295 && a > -1) st('i32', `(i32.trunc_${ty}_u ${ld(i)})`);
    if (Number.isFinite(a) && Math.abs(t) < 2 ** 63) st('i64', `(i64.trunc_${ty}_s ${ld(i)})`);
    if (Number.isFinite(a) && t >= 0 && t < 2 ** 64) st('i64', `(i64.trunc_${ty}_u ${ld(i)})`);
    for (const s of ['s', 'u']) {
      st('i32', `(i32.trunc_sat_${ty}_${s} ${ld(i)})`);
      st('i64', `(i64.trunc_sat_${ty}_${s} ${ld(i)})`);
    }
    st(ty === 'f32' ? 'i32' : 'i64', `(${ty === 'f32' ? 'i32' : 'i64'}.reinterpret_${ty} ${ld(i)})`);
    if (ty === 'f64') {
      st('f32', `(f32.demote_f64 ${ld(i)})`);
    } else {
      st('f64', `(f64.promote_f32 ${ld(i)})`);
    }
  }
  // Integer -> float conversions.
  const ints = [0, 1, -1, 2147483647, -2147483648, 16777217, 123456789];
  for (const x of ints) {
    st(ty, `(${ty}.convert_i32_s (i32.const ${x}))`);
    lines.push(`(i32.store offset=1000 (i32.const 0) (i32.const ${x}))`);
    st(ty, `(${ty}.convert_i32_s (i32.load offset=1000 (i32.const 0)))`);
    st(ty, `(${ty}.convert_i32_u (i32.load offset=1000 (i32.const 0)))`);
  }
  const longs = [0n, 1n, -1n, 9007199254740993n, -9223372036854775808n, 0x7fffffffffffffffn, 123456789012345n];
  for (const x of longs) {
    lines.push(`(i64.store offset=1000 (i32.const 0) (i64.const ${x}))`);
    st(ty, `(${ty}.convert_i64_s (i64.load offset=1000 (i32.const 0)))`);
    if (ty === 'f64' || f32Exact(Number(BigInt.asUintN(64, x)))) st(ty, `(${ty}.convert_i64_u (i64.load offset=1000 (i32.const 0)))`);
  }
  // Bit patterns -> float.
  const bits32 = [0, 0x80000000, 0x3f800000, 0x7f7fffff, 0x00000001, 0x007fffff, 0x7f800000, 0xff800000, 0x40490fdb];
  const bits64 = [0n, 0x8000000000000000n, 0x3ff0000000000000n, 0x7fefffffffffffffn, 1n, 0x000fffffffffffffn, 0x7ff0000000000000n, 0x400921fb54442d18n];
  if (ty === 'f32') for (const b of bits32) st('f32', `(f32.reinterpret_i32 (i32.load offset=1000 (i32.const ${0})))`) || lines.splice(lines.length - 1, 0, `(i32.store offset=1000 (i32.const 0) (i32.const ${b | 0}))`);
  else for (const b of bits64) st('f64', `(f64.reinterpret_i64 (i64.load offset=1000 (i32.const ${0})))`) || lines.splice(lines.length - 1, 0, `(i64.store offset=1000 (i32.const 0) (i64.const ${BigInt.asIntN(64, b)}))`);

  const data = vals.map((x) => {
    const buf = new ArrayBuffer(W);
    if (ty === 'f32') new DataView(buf).setFloat32(0, x, true); else new DataView(buf).setFloat64(0, x, true);
    return [...new Uint8Array(buf)].map((b) => '\\' + b.toString(16).padStart(2, '0')).join('');
  }).join('');
  const pages = Math.ceil((out + 16) / 65536) + 1;
  return `(module
  (memory (export "memory") ${pages})
  (data (i32.const 0) "${data}")
  (func (export "main")
    (local $z i32)
    ${lines.join('\n    ')}
    (i32.store (i32.const 1020) (i32.const ${out}))))`;
}

export const I32_BINOPS = ['add', 'sub', 'mul', 'div_s', 'div_u', 'rem_s', 'rem_u', 'and', 'or', 'xor', 'shl', 'shr_s', 'shr_u', 'rotl', 'rotr',
  'eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u'];
export const I32_UNOPS = ['eqz', 'clz', 'ctz', 'popcnt', 'extend8_s', 'extend16_s'];
export const I64_BINOPS = I32_BINOPS;
export const I64_UNOPS = ['eqz', 'clz', 'ctz', 'popcnt', 'extend8_s', 'extend16_s', 'extend32_s'];
