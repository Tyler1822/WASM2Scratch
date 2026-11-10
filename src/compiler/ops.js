// Lowering of WebAssembly integer arithmetic to Scratch expressions.
//
// Scratch only has IEEE doubles and no bitwise operators, so:
//   * an i32 is kept as an *unsigned* integer in [0, 2^32)
//   * an i64 is kept as two such halves [lo, hi]
//   * wrap-around is done with `mod 4294967296` (Scratch's mod is floored)
//   * shifts become multiplications / floored divisions by powers of two
//   * and/or/xor use arithmetic identities where a constant mask allows it and
//     fall back to a 256x256 lookup table otherwise (runtime helper).
//
// Every i32 expression node may carry `mask`: a conservative bitmask of the
// bits that can possibly be set. It is used to drop redundant wrap-arounds and
// to turn `or` of disjoint values into a plain addition.
//
// Functions take a `cx` (the function compiler) for the things that need
// statements: `cx.dup(e)` makes an expression safe to use more than once,
// `cx.setTmp(e)` stores a value in a fresh temporary, and `cx.h1(name, ...args)`
// / `cx.h2(...)` call a runtime procedure and return its result (one value, or
// a [lo, hi] pair) already copied into fresh temporaries.

import * as A from '../scratch/ast.js';

export const U = 4294967296;
export const S31 = 2147483648;
const num = A.num;
const isC = (e) => e.t === 'n';

export function maskOf(e) {
  if (e.t === 'n') return Number.isInteger(e.v) && e.v >= 0 && e.v < U ? e.v : U - 1;
  if (e.bool) return 1;
  return e.mask === undefined ? U - 1 : e.mask;
}
const M = (node, mask) => { node.mask = mask; return node; };

// Smallest 2^k - 1 that is >= x (capped at 2^32 - 1).
export function fillOnes(x) {
  if (x >= U - 1) return U - 1;
  let m = 1;
  while (m <= x) m *= 2;
  return m - 1;
}
const isPow2 = (x) => x > 0 && Number.isInteger(Math.log2(x)) && 2 ** Math.round(Math.log2(x)) === x;
const log2 = (x) => Math.round(Math.log2(x));

// ---- booleans --------------------------------------------------------------

const TRUE = () => ({ t: 'o', op: 'eq', a: num(0), b: num(0), bool: true, cb: true });
const FALSE = () => ({ t: 'o', op: 'eq', a: num(0), b: num(1), bool: true, cb: false });

// i32 expression -> Scratch boolean expression ("is non-zero").
export function toBool(e) {
  if (e.bool) return e;
  if (isC(e)) return e.v !== 0 ? TRUE() : FALSE();
  return A.gt(e, 0);
}
export function notB(e) {
  if (e.cb !== undefined) return e.cb ? FALSE() : TRUE();
  if (e.op === 'not') return e.a;
  return A.not(e);
}
export function andB(a, b) {
  if (a.cb !== undefined) return a.cb ? b : a;
  if (b.cb !== undefined) return b.cb ? a : b;
  return A.and(a, b);
}
export function orB(a, b) {
  if (a.cb !== undefined) return a.cb ? a : b;
  if (b.cb !== undefined) return b.cb ? b : a;
  return A.or(a, b);
}
const cbool = (x) => num(x ? 1 : 0);

// ---- i32 arithmetic --------------------------------------------------------

export function add32(a, b) {
  if (isC(a) && isC(b)) return num((a.v + b.v) % U);
  if (isC(a)) [a, b] = [b, a];
  if (isC(b) && b.v === 0) return a;
  const ma = maskOf(a), mb = maskOf(b);
  if (ma + mb < U) return M(A.add(a, b), fillOnes(ma + mb));
  if (isC(b) && b.v >= S31) return A.mod(A.sub(a, U - b.v), U);
  return A.mod(A.add(a, b), U);
}

export function sub32(a, b) {
  if (isC(a) && isC(b)) return num((a.v - b.v + U) % U);
  if (isC(b)) {
    if (b.v === 0) return a;
    return add32(a, num(U - b.v));
  }
  return A.mod(A.sub(a, b), U);
}

export function mul32(a, b, cx) {
  if (isC(a) && isC(b)) return num(Math.imul(a.v, b.v) >>> 0);
  if (isC(a)) [a, b] = [b, a];
  const ma = maskOf(a), mb = maskOf(b);
  if (isC(b)) {
    const c = b.v;
    if (c === 0) return num(0);
    if (c === 1) return a;
    if (isPow2(c)) return shl32(a, num(log2(c)), cx);
    if (ma * c < U) return M(A.mul(a, c), fillOnes(ma * c));
    if (ma * c <= 2 ** 53) return A.mod(A.mul(a, c), U);
    a = cx.dup(a);
    const cl = c % 65536, ch = Math.floor(c / 65536);
    let t = A.mul(A.mod(A.mul(a, ch), 65536), 65536);
    if (cl) t = A.add(A.mul(a, cl), t);
    return A.mod(t, U);
  }
  if (ma * mb < U) return M(A.mul(a, b), fillOnes(ma * mb));
  if (ma * mb <= 2 ** 53) return A.mod(A.mul(a, b), U);
  a = cx.dup(a);
  b = cx.dup(b);
  return A.mod(A.add(A.mul(a, A.mod(b, 65536)), A.mul(A.mod(A.mul(a, A.floor(A.div(b, 65536))), 65536), 65536)), U);
}

// Signed value of an i32 (a plain, possibly negative, number).
export function signed32(a) {
  if (isC(a)) return num(a.v | 0);
  if (maskOf(a) < S31) return a;
  return A.sub(A.mod(A.add(a, S31), U), S31);
}

export function divU32(a, b, cx) {
  if (isC(a) && isC(b) && b.v !== 0) return num(Math.floor(a.v / b.v));
  if (isC(b) && b.v === 1) return a;
  if (isC(b) && isPow2(b.v)) return shrU32(a, num(log2(b.v)), cx);
  const m = isC(b) && b.v > 0 ? fillOnes(Math.floor(maskOf(a) / b.v)) : maskOf(a);
  return M(A.floor(A.div(a, b)), fillOnes(m));
}

export function remU32(a, b, cx) {
  if (isC(a) && isC(b) && b.v !== 0) return num(a.v % b.v);
  if (isC(b) && isPow2(b.v)) return and32(a, num(b.v - 1), cx);
  const m = isC(b) && b.v > 0 ? Math.min(fillOnes(b.v - 1), fillOnes(maskOf(a))) : fillOnes(Math.min(maskOf(a), maskOf(b)));
  return M(A.mod(a, b), m);
}

export function divS32(a, b, cx) {
  if (isC(a) && isC(b) && b.v !== 0) return num(Math.trunc((a.v | 0) / (b.v | 0)) >>> 0);
  if (maskOf(a) < S31 && maskOf(b) < S31) return divU32(a, b, cx);
  return cx.h1('divs', a, b);
}

export function remS32(a, b, cx) {
  if (isC(a) && isC(b) && b.v !== 0) return num(((a.v | 0) % (b.v | 0)) >>> 0);
  if (maskOf(a) < S31 && maskOf(b) < S31) return remU32(a, b, cx);
  return cx.h1('rems', a, b);
}

// ---- i32 bitwise -----------------------------------------------------------

// For a constant mask, returns [k, j] when mask == ((2^j - 1) << k).
function contiguous(m) {
  if (m === 0) return null;
  let k = 0;
  while (m % 2 === 0) { m /= 2; k++; }
  if (!isPow2(m + 1)) return null;
  return [k, log2(m + 1)];
}

// a & constant, when it can be done arithmetically without duplicating `a`
// more than `allowDup` permits. Returns null if a table lookup is needed.
function andConst(a, m, cx, mayDup = true) {
  const ma = maskOf(a);
  if ((ma & m) >>> 0 === 0) return num(0);
  if ((ma & m) >>> 0 === ma) return a;
  const eff = (ma & m) >>> 0;
  const run = contiguous(m);
  if (run) {
    const [k, j] = run;
    if (k === 0) return M(A.mod(a, 2 ** j), eff);
    if (k + j === 32) {
      // High mask: clear the low k bits.
      if (!mayDup) return M(A.mul(A.floor(A.div(a, 2 ** k)), 2 ** k), eff);
      a = cx.dup(a);
      return M(A.sub(a, A.mod(a, 2 ** k)), eff);
    }
    return M(A.mul(A.mod(A.floor(A.div(a, 2 ** k)), 2 ** j), 2 ** k), eff);
  }
  // The mask may still be contiguous within the bits `a` can actually have.
  const run2 = contiguous(eff);
  if (run2 && ((m >>> run2[0]) & (2 ** run2[1] - 1)) >>> 0 === 2 ** run2[1] - 1) {
    const [k, j] = run2;
    if (k === 0) return M(A.mod(a, 2 ** j), eff);
    return M(A.mul(A.mod(A.floor(A.div(a, 2 ** k)), 2 ** j), 2 ** k), eff);
  }
  return null;
}

export function and32(a, b, cx) {
  if (isC(a) && isC(b)) return num((a.v & b.v) >>> 0);
  if (isC(a)) [a, b] = [b, a];
  const ma = maskOf(a), mb = maskOf(b);
  if ((ma & mb) >>> 0 === 0) return num(0);
  if (isC(b)) {
    const r = andConst(a, b.v, cx);
    if (r) return r;
  } else if (ma <= 1 && mb <= 1) {
    return andB(toBool(a), toBool(b));
  } else if (ma <= 1 || mb <= 1) {
    // (x & bit): bit * (x mod 2)
    const [bit, x] = ma <= 1 ? [a, b] : [b, a];
    return M(A.mul(bit, A.mod(x, 2)), 1);
  }
  const eff = (ma & mb) >>> 0;
  if (eff <= 0xff) {
    // Only the low byte can be non-zero: one table lookup, inline.
    const lo = (x) => (maskOf(x) <= 0xff ? x : A.mod(x, 256));
    return M(A.item('and8', A.add(A.add(A.mul(lo(a), 256), lo(b)), 1)), eff);
  }
  return M(cx.h1('and', a, b), eff);
}

export function or32(a, b, cx) {
  if (isC(a) && isC(b)) return num((a.v | b.v) >>> 0);
  if (isC(a)) [a, b] = [b, a];
  const ma = maskOf(a), mb = maskOf(b);
  if (isC(b) && b.v === 0) return a;
  if (isC(b) && b.v === U - 1) return b;
  if (isC(b) && (ma & ~b.v) >>> 0 === 0) return b;
  if ((ma & mb) >>> 0 === 0) return M(A.add(a, b), (ma | mb) >>> 0);
  if (ma <= 1 && mb <= 1 && !isC(b)) return orB(toBool(a), toBool(b));
  if (isC(b)) {
    // a | m == a + m - (a & m)
    a = cx.dup(a);
    const t = andConst(a, b.v, cx);
    if (t) return M(isC(t) ? A.add(a, b.v - t.v) : A.sub(A.add(a, b.v), t), (ma | mb) >>> 0);
  }
  return M(cx.h1('or', a, b), (ma | mb) >>> 0);
}

export function xor32(a, b, cx) {
  if (isC(a) && isC(b)) return num((a.v ^ b.v) >>> 0);
  if (isC(a)) [a, b] = [b, a];
  const ma = maskOf(a), mb = maskOf(b);
  if (isC(b) && b.v === 0) return a;
  if (isC(b) && b.v === U - 1) return A.sub(U - 1, a);
  if ((ma & mb) >>> 0 === 0) return M(A.add(a, b), (ma | mb) >>> 0);
  if (ma <= 1 && isC(b) && b.v === 1) return notB(toBool(a));
  if (isC(b) && (ma & ~b.v) >>> 0 === 0) return M(A.sub(b, a), b.v);
  if (ma <= 1 && mb <= 1 && !isC(b)) return notB(A.eq(toBool(a), toBool(b)));
  if (isC(b)) {
    // a ^ m == a + m - 2 * (a & m)
    a = cx.dup(a);
    const t = andConst(a, b.v, cx);
    if (t) return M(isC(t) ? A.add(a, b.v - 2 * t.v) : A.sub(A.add(a, b.v), A.mul(t, 2)), (ma | mb) >>> 0);
  }
  return M(cx.h1('xor', a, b), (ma | mb) >>> 0);
}

// 2^n for a (non-constant) shift amount already reduced to its valid range.
const pow2 = (n) => A.item('pow2', A.add(n, 1));
function shiftAmount(n, bits) {
  if (isC(n)) return num(n.v % bits);
  return maskOf(n) < bits ? n : A.mod(n, bits);
}

export function shl32(a, n, cx) {
  const ma = maskOf(a);
  if (isC(n)) {
    const k = n.v % 32;
    if (k === 0) return a;
    if (isC(a)) return num((a.v << k) >>> 0);
    if (ma * 2 ** k < U) return M(A.mul(a, 2 ** k), ma * 2 ** k);
    return M(A.mul(A.mod(a, 2 ** (32 - k)), 2 ** k), (ma << k) >>> 0);
  }
  const nn = cx.dup(shiftAmount(n, 32));
  return A.mul(A.mod(a, A.item('pow2', A.sub(33, nn))), pow2(nn));
}

export function shrU32(a, n, cx) {
  if (isC(n)) {
    const k = n.v % 32;
    if (k === 0) return a;
    if (isC(a)) return num(a.v >>> k);
    return M(A.floor(A.div(a, 2 ** k)), maskOf(a) >>> k);
  }
  return M(A.floor(A.div(a, pow2(shiftAmount(n, 32)))), maskOf(a));
}

export function shrS32(a, n, cx) {
  if (maskOf(a) < S31) return shrU32(a, n, cx);
  if (isC(n)) {
    const k = n.v % 32;
    if (k === 0) return a;
    if (isC(a)) return num((a.v >> k) >>> 0);
    return A.mod(A.floor(A.div(signed32(a), 2 ** k)), U);
  }
  return A.mod(A.floor(A.div(signed32(a), pow2(shiftAmount(n, 32)))), U);
}

export function rotl32(a, n, cx) {
  if (isC(n)) {
    const k = n.v % 32;
    if (k === 0) return a;
    if (isC(a)) return num(((a.v << k) | (a.v >>> (32 - k))) >>> 0);
    a = cx.dup(a);
    return A.add(A.mul(A.mod(a, 2 ** (32 - k)), 2 ** k), A.floor(A.div(a, 2 ** (32 - k))));
  }
  return cx.h1('rotl', a, n);
}

export function rotr32(a, n, cx) {
  if (isC(n)) return rotl32(a, num((32 - (n.v % 32)) % 32), cx);
  return cx.h1('rotl', a, A.sub(32, shiftAmount(n, 32)));
}

export function clz32(a) {
  if (isC(a)) return num(Math.clz32(a.v));
  // floor(log2(a + 0.5)) is exact for 32-bit integers and gives -1 for 0.
  return M(A.sub(31, A.floor(A.div(A.ln(A.add(a, 0.5)), Math.LN2))), 63);
}

export function ctz32(a, cx) {
  if (isC(a)) return num(a.v === 0 ? 32 : 31 - Math.clz32(a.v & -a.v));
  return M(cx.h1('ctz', a), 63);
}

export function popcnt32(a, cx) {
  if (isC(a)) { let x = a.v, c = 0; while (x) { c += x & 1; x >>>= 1; } return num(c); }
  return M(cx.h1('popcnt', a), 63);
}

export function extendS32(a, bits) {
  const half = 2 ** (bits - 1), full = 2 ** bits;
  if (isC(a)) return num((((a.v % full) + half) % full - half + U) % U);
  if (maskOf(a) < half) return a;
  return A.mod(A.sub(A.mod(A.add(a, half), full), half), U);
}

// ---- i32 comparisons (results are Scratch booleans) ------------------------

export function eqz32(a) {
  if (isC(a)) return cbool(a.v === 0);
  if (a.bool) return notB(a);
  return A.eq(a, 0);
}
export function eq32(a, b) {
  if (isC(a) && isC(b)) return cbool(a.v === b.v);
  if (isC(a)) [a, b] = [b, a];
  if (isC(b) && b.v === 0) return eqz32(a);
  if (isC(b) && b.v === 1 && a.bool) return a;
  return A.eq(a, b);
}
export function ne32(a, b) {
  const e = eq32(a, b);
  if (isC(e)) return cbool(!e.v);
  return notB(e);
}

// op: 'lt' | 'gt' | 'le' | 'ge'
export function cmpU32(op, a, b) {
  if (isC(a) && isC(b)) {
    return cbool(op === 'lt' ? a.v < b.v : op === 'gt' ? a.v > b.v : op === 'le' ? a.v <= b.v : a.v >= b.v);
  }
  switch (op) {
    case 'lt': return A.lt(a, b);
    case 'gt': return A.gt(a, b);
    case 'le': return notB(A.gt(a, b));
    default: return notB(A.lt(a, b));
  }
}

// Adding 2^31 (mod 2^32) maps signed order onto unsigned order.
function bias(x) {
  if (isC(x)) return num((x.v + S31) % U);
  return A.mod(A.add(x, S31), U);
}

export function cmpS32(op, a, b) {
  if (isC(a) && isC(b)) {
    const x = a.v | 0, y = b.v | 0;
    return cbool(op === 'lt' ? x < y : op === 'gt' ? x > y : op === 'le' ? x <= y : x >= y);
  }
  if (maskOf(a) < S31 && maskOf(b) < S31) return cmpU32(op, a, b);
  // Sign tests against 0 / -1 need no bias at all.
  if (isC(b) && b.v === 0 && op === 'lt') return A.gt(a, S31 - 1);
  if (isC(b) && b.v === 0 && op === 'ge') return A.lt(a, S31);
  if (isC(b) && b.v === U - 1 && op === 'gt') return A.lt(a, S31);
  if (isC(b) && b.v === U - 1 && op === 'le') return A.gt(a, S31 - 1);
  if (isC(a) && a.v === 0 && op === 'gt') return A.gt(b, S31 - 1);
  if (isC(a) && a.v === 0 && op === 'le') return A.lt(b, S31);
  return cmpU32(op, bias(a), bias(b));
}

// ---- i64 (pairs [lo, hi]) --------------------------------------------------

const big = (p) => (BigInt(p[1].v) << 32n) | BigInt(p[0].v);
const isC64 = (p) => isC(p[0]) && isC(p[1]);
export function const64(v) {
  v = BigInt.asUintN(64, v);
  return [num(Number(v & 0xffffffffn)), num(Number(v >> 32n))];
}

export function add64(a, b, cx) {
  if (isC64(a) && isC64(b)) return const64(big(a) + big(b));
  if (isC64(a)) [a, b] = [b, a];
  let [al, ah] = a, [bl, bh] = b;
  if (maskOf(al) + maskOf(bl) < U) return [add32(al, bl), add32(ah, bh)];
  al = cx.dup(al);
  bl = cx.dup(bl);
  const carry = isC(bl) ? A.gt(al, U - 1 - bl.v) : A.gt(A.add(al, bl), U - 1);
  const hi = isC(bh) && bh.v === 0 ? A.mod(A.add(ah, carry), U) : A.mod(A.add(A.add(ah, bh), carry), U);
  return [add32(al, bl), hi];
}

export function sub64(a, b, cx) {
  if (isC64(a) && isC64(b)) return const64(big(a) - big(b));
  if (isC64(b)) return add64(a, const64(-big(b)), cx);
  let [al, ah] = a, [bl, bh] = b;
  if (isC(bl) && bl.v === 0) return [al, sub32(ah, bh)];
  al = cx.dup(al);
  bl = cx.dup(bl);
  // + U keeps the operand of mod non-negative (Scratch's mod of -U is -0).
  return [sub32(al, bl), A.mod(A.sub(A.add(A.sub(ah, bh), U), A.lt(al, bl)), U)];
}

export function mul64(a, b, cx) {
  if (isC64(a) && isC64(b)) return const64(big(a) * big(b));
  if (isC64(a)) [a, b] = [b, a];
  if (isC64(b)) {
    const c = big(b);
    if (c === 0n) return const64(0n);
    if (c === 1n) return a;
    if ((c & (c - 1n)) === 0n) return shl64(a, num(c.toString(2).length - 1), cx);
  }
  const zeroHi = (p) => isC(p[1]) && p[1].v === 0;
  if (zeroHi(a) && zeroHi(b)) {
    const ma = maskOf(a[0]), mb = maskOf(b[0]);
    if (ma * mb < U) return [M(A.mul(a[0], b[0]), fillOnes(ma * mb)), num(0)];
    if (ma * mb <= 2 ** 53) {
      const p = cx.setTmp(A.mul(a[0], b[0]));
      return [A.mod(p, U), A.floor(A.div(p, U))];
    }
    return cx.h2('mul32x32', a[0], b[0]);
  }
  return cx.h2('mul64', a[0], a[1], b[0], b[1]);
}

function bitwise64(fn) {
  return (a, b, cx) => [fn(a[0], b[0], cx), fn(a[1], b[1], cx)];
}
export const and64 = bitwise64(and32);
export const or64 = bitwise64(or32);
export const xor64 = bitwise64(xor32);

export function shl64(a, n, cx) {
  if (isC(n)) {
    const k = n.v % 64;
    if (k === 0) return a;
    if (isC64(a)) return const64(big(a) << BigInt(k));
    if (k === 32) return [num(0), a[0]];
    if (k > 32) return [num(0), shl32(a[0], num(k - 32), cx)];
    const lo = cx.dup(a[0]);
    const carry = A.floor(A.div(lo, 2 ** (32 - k)));
    const hiPart = shl32(a[1], num(k), cx);
    return [shl32(lo, num(k), cx), isC(hiPart) && hiPart.v === 0 ? carry : A.add(hiPart, carry)];
  }
  return cx.h2('shl64', a[0], a[1], n);
}

export function shrU64(a, n, cx) {
  if (isC(n)) {
    const k = n.v % 64;
    if (k === 0) return a;
    if (isC64(a)) return const64(big(a) >> BigInt(k));
    if (k === 32) return [a[1], num(0)];
    if (k > 32) return [shrU32(a[1], num(k - 32), cx), num(0)];
    if (isC(a[1]) && a[1].v === 0) return [shrU32(a[0], num(k), cx), num(0)];
    const hi = cx.dup(a[1]);
    return [A.add(shrU32(a[0], num(k), cx), A.mul(A.mod(hi, 2 ** k), 2 ** (32 - k))), shrU32(hi, num(k), cx)];
  }
  return cx.h2('shru64', a[0], a[1], n);
}

export function shrS64(a, n, cx) {
  if (maskOf(a[1]) < S31) return shrU64(a, n, cx);
  if (isC(n)) {
    const k = n.v % 64;
    if (k === 0) return a;
    if (isC64(a)) return const64(BigInt.asIntN(64, big(a)) >> BigInt(k));
    const hi = cx.dup(a[1]);
    const sign = A.mul(A.gt(hi, S31 - 1), U - 1);
    if (k === 32) return [hi, sign];
    if (k > 32) return [shrS32(hi, num(k - 32), cx), sign];
    return [A.add(shrU32(a[0], num(k), cx), A.mul(A.mod(hi, 2 ** k), 2 ** (32 - k))), shrS32(hi, num(k), cx)];
  }
  return cx.h2('shrs64', a[0], a[1], n);
}

export function rotl64(a, n, cx) {
  if (isC(n)) {
    const k = n.v % 64;
    if (k === 0) return a;
    if (isC64(a)) { const v = big(a); return const64((v << BigInt(k)) | (v >> BigInt(64 - k))); }
    let lo = cx.dup(a[0]), hi = cx.dup(a[1]);
    if (k === 32) return [hi, lo];
    let s = k;
    if (k > 32) { [lo, hi] = [hi, lo]; s = k - 32; }
    const p = 2 ** (32 - s);
    return [
      A.add(A.mul(A.mod(lo, p), 2 ** s), A.floor(A.div(hi, p))),
      A.add(A.mul(A.mod(hi, p), 2 ** s), A.floor(A.div(lo, p))),
    ];
  }
  return cx.h2('rotl64', a[0], a[1], n);
}

export function rotr64(a, n, cx) {
  if (isC(n)) return rotl64(a, num((64 - (n.v % 64)) % 64), cx);
  return cx.h2('rotl64', a[0], a[1], A.sub(64, shiftAmount(n, 64)));
}

export function eqz64(a) {
  if (isC64(a)) return cbool(big(a) === 0n);
  if (isC(a[1]) && a[1].v === 0) return eqz32(a[0]);
  // Both halves are non-negative, so the sum is zero only if both are.
  return A.eq(A.add(a[0], a[1]), 0);
}

export function eq64(a, b) {
  if (isC64(a) && isC64(b)) return cbool(big(a) === big(b));
  const lo = eq32(a[0], b[0]), hi = eq32(a[1], b[1]);
  return andB(toBool(hi), toBool(lo));
}

export function ne64(a, b) {
  const e = eq64(a, b);
  if (isC(e)) return cbool(!e.v);
  return notB(toBool(e));
}

// op: lt gt le ge; signed applies to the high halves only.
export function cmp64(op, signed, a, b, cx) {
  if (isC64(a) && isC64(b)) {
    const x = signed ? BigInt.asIntN(64, big(a)) : big(a), y = signed ? BigInt.asIntN(64, big(b)) : big(b);
    return cbool(op === 'lt' ? x < y : op === 'gt' ? x > y : op === 'le' ? x <= y : x >= y);
  }
  if (isC(a[1]) && isC(b[1]) && a[1].v === b[1].v) return cmpU32(op, a[0], b[0]);
  const strict = op === 'lt' || op === 'le' ? 'lt' : 'gt';
  const ah = cx.dup(a[1]), bh = cx.dup(b[1]);
  const hiCmp = toBool((signed ? cmpS32 : cmpU32)(strict, ah, bh));
  const hiEq = toBool(eq32(ah, bh));
  const loCmp = toBool(cmpU32(op, a[0], b[0]));
  return orB(hiCmp, andB(hiEq, loCmp));
}

export function extendS64(a, bits, cx) {
  // Sign-extend the low `bits` (8/16/32) of the low half to 64 bits.
  const lo = cx.dup(bits === 32 ? a : extendS32(a, bits));
  if (isC(lo)) return [lo, num(lo.v >= S31 ? U - 1 : 0)];
  if (maskOf(lo) < S31) return [lo, num(0)];
  return [lo, A.mul(A.gt(lo, S31 - 1), U - 1)];
}
