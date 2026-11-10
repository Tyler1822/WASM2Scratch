// Linear memory model.
//
// Memory is the Scratch list `mem`; item k+1 holds the little-endian 32-bit
// word at byte address 4k as an unsigned integer. Accesses whose alignment
// hint is at least their natural alignment (or 4 bytes for 64-bit values) are
// trusted to be aligned and become one list read/write per word. Sub-word
// accesses extract bytes arithmetically; under-aligned accesses go through
// byte-wise runtime helpers.

import * as A from '../scratch/ast.js';

export const MEM = 'mem';
const isC = (e) => e.t === 'n';

// Effective address expression base + offset.
export function effAddr(base, off) {
  if (!off) return base;
  if (isC(base)) return A.num(base.v + off);
  if (base.t === 'o' && base.op === 'add' && isC(base.b) && base.b.v + off < 2 ** 53) {
    return { ...A.add(base.a, base.b.v + off), mask: undefined };
  }
  return A.add(base, off);
}

// True if an expression can be repeated without a temporary.
export function cheap(e) {
  if (A.isSimple(e)) return true;
  return e.t === 'o' && e.op === 'add' && A.isSimple(e.a) && A.isSimple(e.b);
}

// 1-based list index of the word containing an *aligned* address.
export function wordIdx(ea) {
  if (isC(ea)) return A.num(Math.floor(ea.v / 4) + 1);
  if (ea.t === 'o' && ea.op === 'add' && isC(ea.b) && ea.b.v % 4 === 0) {
    return A.add(A.div(ea.a, 4), ea.b.v / 4 + 1);
  }
  return A.add(A.div(ea, 4), 1);
}

// 1-based list index of the word containing any address.
export function wordIdxU(ea) {
  if (isC(ea)) return A.num(Math.floor(ea.v / 4) + 1);
  return A.add(A.floor(A.div(ea, 4)), 1);
}

// 256^(ea mod 4): the multiplier of the byte at `ea` within its word.
export function byteMul(ea) {
  if (isC(ea)) return A.num(256 ** (ea.v % 4));
  return A.item('b4', A.add(A.mod(ea, 4), 1));
}

export const loadWord = (ea) => A.item(MEM, wordIdx(ea));

// Load `bytes` (1 or 2) bytes that lie within one word. `ea` is used twice.
export function loadSub(ea, bytes) {
  const w = A.item(MEM, wordIdxU(ea));
  const m = bytes === 1 ? 256 : 65536;
  if (isC(ea) && ea.v % 4 === 0) return { ...A.mod(w, m), mask: m - 1 };
  return { ...A.mod(A.floor(A.div(w, byteMul(ea))), m), mask: m - 1 };
}

// Statements storing `val` (already reduced to `bytes` bytes) inside a word.
// `t` provides three scratch variable names: {i, k, w}.
export function storeSub(ea, val, bytes, t) {
  const m = bytes === 1 ? 256 : 65536;
  const out = [];
  let idx = wordIdxU(ea), k = byteMul(ea);
  if (!A.isSimple(idx)) { out.push(A.set(t.i, idx)); idx = A.v(t.i); }
  if (!A.isSimple(k)) { out.push(A.set(t.k, k)); k = A.v(t.k); }
  out.push(A.set(t.w, A.item(MEM, idx)));
  const w = A.v(t.w);
  const old = isC(k) && k.v === 1 ? A.mod(w, m) : A.mod(A.floor(A.div(w, k)), m);
  const delta = A.sub(val, old);
  out.push(A.lrep(MEM, idx, A.add(w, isC(k) && k.v === 1 ? delta : A.mul(delta, k))));
  return out;
}
