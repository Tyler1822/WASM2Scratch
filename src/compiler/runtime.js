// Runtime support: lookup tables, inline expansions and helper procedures.
//
// Helper procedures return their result in the sprite variables `r` / `rh`
// (and `r2` / `r2h` for the remainder of 64-bit division). They are emitted
// only when used.

import * as A from '../scratch/ast.js';
import { signed32 } from './ops.js';
import { MEM, loadSub, storeSub } from './memory.js';

const U = 4294967296;
const S31 = 2147483648;
export const FPOW2_OFF = 1101; // item(fpow2, k + FPOW2_OFF) == 2^k for k in [-1100, 1023]
export const LIST_LIMIT = 200000;
const { v, num, set, change, iff, until, repeat, item, add, sub, mul, div, mod, floor, abs, lt, gt, eq, not, and, or } = A;
const P = (i) => A.arg('p' + i);
const pow2 = (k) => item('pow2', add(k, 1));
const fpow2 = (k) => item('fpow2', add(k, FPOW2_OFF));

// ---- lookup tables ----------------------------------------------------------

export const TABLES = {
  pow2: () => Array.from({ length: 65 }, (_, k) => 2 ** k),
  b4: () => [1, 256, 65536, 16777216],
  and8: () => Array.from({ length: 65536 }, (_, i) => (i >> 8) & (i & 255)),
  pop8: () => Array.from({ length: 256 }, (_, i) => { let c = 0; for (let x = i; x; x >>= 1) c += x & 1; return c; }),
  fpow2: () => Array.from({ length: 2124 }, (_, i) => 2 ** (i + 1 - FPOW2_OFF)),
  chr: () => Array.from({ length: 256 }, (_, c) => (c === 9 ? '    ' : (c >= 32 && c < 127) || c >= 160 ? String.fromCharCode(c) : '')),
};

// ---- inline expansions --------------------------------------------------------

function byteOf(x, k) {
  if (k === 0) return mod(x, 256);
  if (k === 3) return floor(div(x, 16777216));
  return mod(floor(div(x, 256 ** k)), 256);
}

function and32Expr(a, b) {
  let sum = null;
  for (let k = 0; k < 4; k++) {
    let term = item('and8', add(add(mul(byteOf(a, k), 256), byteOf(b, k)), 1));
    if (k) term = mul(term, 256 ** k);
    sum = sum ? add(sum, term) : term;
  }
  return sum;
}

function popcntExpr(a) {
  let sum = null;
  for (let k = 0; k < 4; k++) {
    const term = item('pop8', add(byteOf(a, k), 1));
    sum = sum ? add(sum, term) : term;
  }
  return sum;
}

// Returns an expression, or null when the operation needs a helper procedure.
export function inline1(name, args, cx) {
  switch (name) {
    case 'and': { const [a, b] = args.map((x) => cx.dup(x)); return and32Expr(a, b); }
    case 'or': { const [a, b] = args.map((x) => cx.dup(x)); return sub(add(a, b), and32Expr(a, b)); }
    case 'xor': { const [a, b] = args.map((x) => cx.dup(x)); return sub(add(a, b), mul(and32Expr(a, b), 2)); }
    case 'popcnt': return popcntExpr(cx.dup(args[0]));
    case 'divs': {
      const sa = cx.dup(signed32(args[0])), sb = cx.dup(signed32(args[1]));
      // q - 2q*neg avoids producing -0 (q * -1 would).
      const q = cx.dup(floor(div(abs(sa), abs(sb))));
      return mod(sub(q, mul(mul(q, 2), not(eq(lt(sa, 0), lt(sb, 0))))), U);
    }
    case 'rems': {
      const sa = cx.dup(signed32(args[0])), sb = cx.dup(signed32(args[1]));
      const m = cx.dup(mod(abs(sa), abs(sb)));
      return mod(sub(m, mul(mul(m, 2), lt(sa, 0))), U);
    }
    case 'rotl': {
      const a = cx.dup(args[0]);
      const n = cx.dup(mod(args[1], 32));
      const q = cx.dup(item('pow2', sub(33, n)));
      return add(mul(mod(a, q), pow2(n)), floor(div(a, q)));
    }
    default: return null;
  }
}

// ---- helper procedures --------------------------------------------------------

function negate64(l, h) {
  // (l, h) <- -(l, h) mod 2^64; l and h are variable names.
  return [set(h, mod(add(sub(U - 1, v(h)), eq(v(l), 0)), U)), set(l, mod(sub(U, v(l)), U))];
}

function putcStmts(b, V) {
  // Appends byte `b` (a variable) of UTF-8 output to the current line.
  const cp = V('cp'), need = V('need');
  return [
    iff(lt(v(b), 128), [
      iff(eq(v(b), 10), [A.ladd('stdout', v('line')), set('line', A.str(''))], [set('line', A.join(v('line'), item('chr', add(v(b), 1))))]),
    ], [
      iff(gt(v(b), 191), [
        set(need, add(add(1, gt(v(b), 223)), gt(v(b), 239))),
        set(cp, mod(v(b), item('pow2', sub(7, v(need))))),
      ], [
        set(cp, add(mul(v(cp), 64), sub(v(b), 128))),
        change(need, -1),
        iff(eq(v(need), 0), [
          iff(lt(v(cp), 256), [set('line', A.join(v('line'), item('chr', add(v(cp), 1))))],
            [set('line', A.join(v('line'), A.str('?')))]),
        ]),
      ]),
    ]),
  ];
}

const HELPERS = {
  ctz: { args: 1, body: (V) => [
    set(V('x'), P(0)), set('r', 0),
    iff(eq(v(V('x')), 0), [set('r', 32), A.stopThis()]),
    ...[[65536, 16], [256, 8], [16, 4], [4, 2], [2, 1]].map(([m, n]) =>
      iff(eq(mod(v(V('x')), m), 0), [change('r', n), set(V('x'), div(v(V('x')), m))])),
  ] },

  mul32x32: { args: 2, body: (V) => mul32x32Stmts(P(0), P(1), V) },

  mul64: { args: 4, body: (V) => {
    const mullo = (a, b) => mod(add(mul(a, mod(b, 65536)), mul(mod(mul(a, floor(div(b, 65536))), 65536), 65536)), U);
    return [...mul32x32Stmts(P(0), P(2), V), set('rh', mod(add(add(v('rh'), mullo(P(0), P(3))), mullo(P(1), P(2))), U))];
  } },

  shl64: { args: 3, body: (V) => {
    const k = V('k'), q = V('q'), m = V('m');
    return [
      set(k, mod(P(2), 64)),
      iff(gt(v(k), 31), [
        set('rh', mul(mod(P(0), item('pow2', sub(65, v(k)))), item('pow2', sub(v(k), 31)))), set('r', 0),
      ], [
        set(q, item('pow2', sub(33, v(k)))), set(m, pow2(v(k))),
        set('rh', add(mul(mod(P(1), v(q)), v(m)), floor(div(P(0), v(q))))),
        set('r', mul(mod(P(0), v(q)), v(m))),
      ]),
    ];
  } },

  shru64: { args: 3, body: (V) => {
    const k = V('k'), q = V('q'), m = V('m');
    return [
      set(k, mod(P(2), 64)),
      iff(gt(v(k), 31), [
        set('r', floor(div(P(1), item('pow2', sub(v(k), 31))))), set('rh', 0),
      ], [
        set(m, pow2(v(k))), set(q, item('pow2', sub(33, v(k)))),
        set('r', add(floor(div(P(0), v(m))), mul(mod(P(1), v(m)), v(q)))),
        set('rh', floor(div(P(1), v(m)))),
      ]),
    ];
  } },

  shrs64: { args: 3, body: (V) => {
    const k = V('k'), q = V('q'), m = V('m'), sh = V('sh');
    return [
      set(k, mod(P(2), 64)),
      set(sh, sub(P(1), mul(gt(P(1), S31 - 1), U))),
      iff(gt(v(k), 31), [
        set('r', mod(floor(div(v(sh), item('pow2', sub(v(k), 31)))), U)),
        set('rh', mul(gt(P(1), S31 - 1), U - 1)),
      ], [
        set(m, pow2(v(k))), set(q, item('pow2', sub(33, v(k)))),
        set('r', add(floor(div(P(0), v(m))), mul(mod(P(1), v(m)), v(q)))),
        set('rh', mod(floor(div(v(sh), v(m))), U)),
      ]),
    ];
  } },

  rotl64: { args: 3, body: (V) => {
    const k = V('k'), q = V('q'), m = V('m'), a = V('a'), b = V('b');
    return [
      set(k, mod(P(2), 64)), set(a, P(0)), set(b, P(1)),
      iff(gt(v(k), 31), [set(a, P(1)), set(b, P(0)), change(k, -32)]),
      set(q, item('pow2', sub(33, v(k)))), set(m, pow2(v(k))),
      set('r', add(mul(mod(v(a), v(q)), v(m)), floor(div(v(b), v(q))))),
      set('rh', add(mul(mod(v(b), v(q)), v(m)), floor(div(v(a), v(q))))),
    ];
  } },

  // divmod64(al, ah, bl, bh, signed): quotient -> r/rh, remainder -> r2/r2h
  divmod64: { args: 5, body: (V) => {
    const [na, nb, xl, xh, yl, yh, X, Y, q, m, ql, qh, ml, mh, i, bit] =
      ['na', 'nb', 'xl', 'xh', 'yl', 'yh', 'X', 'Y', 'q', 'm', 'ql', 'qh', 'ml', 'mh', 'i', 'bit'].map(V);
    return [
      set(na, mul(P(4), gt(P(1), S31 - 1))), set(nb, mul(P(4), gt(P(3), S31 - 1))),
      set(xl, P(0)), set(xh, P(1)), set(yl, P(2)), set(yh, P(3)),
      iff(eq(v(na), 1), negate64(xl, xh)),
      iff(eq(v(nb), 1), negate64(yl, yh)),
      iff(and(lt(v(xh), 2097152), lt(v(yh), 2097152)), [
        set(X, add(mul(v(xh), U), v(xl))), set(Y, add(mul(v(yh), U), v(yl))),
        set(q, floor(div(v(X), v(Y)))),
        set(m, sub(v(X), mul(v(q), v(Y)))),
        iff(lt(v(m), 0), [change(q, -1), change(m, v(Y))]),
        iff(not(lt(v(m), v(Y))), [change(q, 1), set(m, sub(v(m), v(Y)))]),
        set(ql, mod(v(q), U)), set(qh, floor(div(v(q), U))),
        set(ml, mod(v(m), U)), set(mh, floor(div(v(m), U))),
      ], [
        set(ql, 0), set(qh, 0), set(ml, 0), set(mh, 0), set(i, 63),
        repeat(64, [
          iff(gt(v(i), 31), [set(bit, mod(floor(div(v(xh), item('pow2', sub(v(i), 31)))), 2))],
            [set(bit, mod(floor(div(v(xl), pow2(v(i)))), 2))]),
          set(mh, add(mul(v(mh), 2), floor(div(v(ml), S31)))),
          set(ml, add(mul(mod(v(ml), S31), 2), v(bit))),
          set(qh, add(mul(v(qh), 2), floor(div(v(ql), S31)))),
          set(ql, mul(mod(v(ql), S31), 2)),
          iff(or(gt(v(mh), v(yh)), and(eq(v(mh), v(yh)), not(lt(v(ml), v(yl))))), [
            set(ml, sub(v(ml), v(yl))), set(mh, sub(v(mh), v(yh))),
            iff(lt(v(ml), 0), [change(ml, U), change(mh, -1)]),
            change(ql, 1),
          ]),
          change(i, -1),
        ]),
      ]),
      iff(not(eq(v(na), v(nb))), negate64(ql, qh)),
      iff(eq(v(na), 1), negate64(ml, mh)),
      set('r', v(ql)), set('rh', v(qh)), set('r2', v(ml)), set('r2h', v(mh)),
    ];
  } },

  f64bits: { args: 1, body: (V) => {
    const [s, a, e, m, be] = ['s', 'a', 'e', 'm', 'be'].map(V);
    return [
      iff(eq(P(0), 0), [set('r', 0), set('rh', mul(lt(div(1, P(0)), 0), S31)), A.stopThis()]),
      set(s, lt(P(0), 0)), set(a, abs(P(0))),
      iff(gt(v(a), 1.7976931348623157e308), [set('r', 0), set('rh', add(mul(v(s), S31), 2146435072)), A.stopThis()]),
      ...exponentStmts(a, e, 1023),
      iff(lt(v(e), -1022), [
        set(be, 0), set(m, mul(mul(v(a), 2 ** 1000), 2 ** 74)),
      ], [
        set(be, add(v(e), 1023)), set(m, mul(sub(div(v(a), fpow2(v(e))), 1), 2 ** 52)),
      ]),
      set('r', mod(v(m), U)),
      set('rh', add(add(mul(v(s), S31), mul(v(be), 1048576)), floor(div(v(m), U)))),
    ];
  } },

  f64from: { args: 2, body: (V) => {
    const [s, hb, be, m] = ['s', 'hb', 'be', 'm'].map(V);
    return [
      set(s, gt(P(1), S31 - 1)), set(hb, mod(P(1), S31)),
      set(be, floor(div(v(hb), 1048576))),
      set(m, add(mul(mod(v(hb), 1048576), U), P(0))),
      iff(eq(v(be), 2047), [
        iff(eq(v(m), 0), [set('r', Infinity)], [set('r', 0)]),
      ], [
        iff(eq(v(be), 0), [set('r', mul(v(m), 2 ** -1074))],
          [set('r', mul(add(1, div(v(m), 2 ** 52)), fpow2(sub(v(be), 1023))))]),
      ]),
      set('r', mul(v('r'), sub(1, mul(2, v(s))))),
    ];
  } },

  f32bits: { args: 1, body: (V) => {
    const [s, a, e, m, be] = ['s', 'a', 'e', 'm', 'be'].map(V);
    return [
      iff(eq(P(0), 0), [set('r', mul(lt(div(1, P(0)), 0), S31)), A.stopThis()]),
      set(s, lt(P(0), 0)), set(a, abs(P(0))),
      iff(gt(v(a), 3.4028234663852886e38), [set('r', add(mul(v(s), S31), 2139095040)), A.stopThis()]),
      ...exponentStmts(a, e, 127),
      iff(lt(v(e), -126), [
        set(be, 0), set(m, A.round(mul(v(a), 2 ** 149))),
      ], [
        set(be, add(v(e), 127)), set(m, A.round(mul(sub(div(v(a), fpow2(v(e))), 1), 8388608))),
      ]),
      set('r', add(add(mul(v(s), S31), mul(v(be), 8388608)), v(m))),
    ];
  } },

  f32from: { args: 1, body: (V) => {
    const [s, hb, be, m] = ['s', 'hb', 'be', 'm'].map(V);
    return [
      set(s, gt(P(0), S31 - 1)), set(hb, mod(P(0), S31)),
      set(be, floor(div(v(hb), 8388608))), set(m, mod(v(hb), 8388608)),
      iff(eq(v(be), 255), [
        iff(eq(v(m), 0), [set('r', Infinity)], [set('r', 0)]),
      ], [
        iff(eq(v(be), 0), [set('r', mul(v(m), 2 ** -149))],
          [set('r', mul(add(1, div(v(m), 8388608)), fpow2(sub(v(be), 127))))]),
      ]),
      set('r', mul(v('r'), sub(1, mul(2, v(s))))),
    ];
  } },

  nearest: { args: 1, body: (V) => {
    const [f, d] = ['f', 'd'].map(V);
    return [
      iff(gt(abs(P(0)), 2 ** 52 - 1), [set('r', P(0)), A.stopThis()]),
      set(f, floor(P(0))), set(d, sub(P(0), v(f))),
      iff(gt(v(d), 0.5), [set('r', add(v(f), 1))], [
        iff(lt(v(d), 0.5), [set('r', v(f))], [set('r', add(v(f), mod(v(f), 2)))]),
      ]),
      iff(eq(v('r'), 0), [set('r', mul(P(0), 0))]),
    ];
  } },

  fmin: { args: 2, body: () => [
    iff(lt(P(0), P(1)), [set('r', P(0))], [
      iff(lt(P(1), P(0)), [set('r', P(1))], [
        iff(lt(div(1, P(0)), 0), [set('r', P(0))], [set('r', P(1))]),
      ]),
    ]),
  ] },

  fmax: { args: 2, body: () => [
    iff(gt(P(0), P(1)), [set('r', P(0))], [
      iff(gt(P(1), P(0)), [set('r', P(1))], [
        iff(gt(div(1, P(0)), 0), [set('r', P(0))], [set('r', P(1))]),
      ]),
    ]),
  ] },

  copysign: { args: 2, body: () => [
    set('r', mul(abs(P(0)), sub(1, mul(2, or(lt(P(1), 0), lt(div(1, P(1)), 0)))))),
  ] },

  clamp: { args: 3, body: () => [
    set('r', P(0)),
    iff(lt(P(0), P(1)), [set('r', P(1))]),
    iff(gt(P(0), P(2)), [set('r', P(2))]),
  ] },

  sat64s: { args: 1, body: (V) => {
    const t = V('t');
    return [
      set(t, add(P(0), 0)),
      iff(lt(v(t), -(2 ** 63)), [set(t, -(2 ** 63))]),
      iff(not(lt(v(t), 2 ** 63)), [set('r', U - 1), set('rh', S31 - 1), A.stopThis()]),
      set('r', add(mod(v(t), U), 0)), set('rh', mod(floor(div(v(t), U)), U)),
    ];
  } },

  sat64u: { args: 1, body: (V) => {
    const t = V('t');
    return [
      set(t, add(P(0), 0)),
      iff(lt(v(t), 0), [set(t, 0)]),
      iff(not(lt(v(t), 2 ** 64)), [set('r', U - 1), set('rh', U - 1), A.stopThis()]),
      set('r', mod(v(t), U)), set('rh', floor(div(v(t), U))),
    ];
  } },

  // Unaligned little-endian load of p1 bytes at p0.
  ldu: { args: 2, body: (V) => {
    const [i, k, a] = ['i', 'k', 'a'].map(V);
    return [
      set('r', 0), set(i, 0), set(k, 1),
      repeat(P(1), [
        set(a, add(P(0), v(i))),
        change('r', mul(loadSub(v(a), 1), v(k))),
        set(k, mul(v(k), 256)), change(i, 1),
      ]),
    ];
  } },

  // Unaligned little-endian store of p2 bytes of p1 at p0.
  stu: { args: 3, body: (V) => {
    const [i, x, a] = ['i', 'x', 'a'].map(V);
    const t = { i: V('ti'), k: V('tk'), w: V('tw') };
    return [
      set(i, 0), set(x, P(1)),
      repeat(P(2), [
        set(a, add(P(0), v(i))),
        ...storeSub(v(a), mod(v(x), 256), 1, t),
        set(x, floor(div(v(x), 256))), change(i, 1),
      ]),
    ];
  } },

  memcpy: { args: 3, body: (V) => {
    const [i, a, b, wd, ws] = ['i', 'a', 'b', 'wd', 'ws'].map(V);
    const t = { i: V('ti'), k: V('tk'), w: V('tw') };
    const copyByte = [
      set(a, add(P(1), v(i))), set(b, loadSub(v(a), 1)),
      set(a, add(P(0), v(i))), ...storeSub(v(a), v(b), 1, t),
    ];
    return [
      iff(and(gt(P(0), P(1)), lt(P(0), add(P(1), P(2)))), [
        set(i, P(2)),
        repeat(P(2), [change(i, -1), ...copyByte]),
        A.stopThis(),
      ]),
      set(i, 0),
      iff(eq(mod(P(0), 4), mod(P(1), 4)), [
        until(or(eq(mod(add(P(0), v(i)), 4), 0), not(lt(v(i), P(2)))), [...copyByte, change(i, 1)]),
        set(wd, add(div(add(P(0), v(i)), 4), 1)), set(ws, add(div(add(P(1), v(i)), 4), 1)),
        repeat(floor(div(sub(P(2), v(i)), 4)), [
          A.lrep(MEM, v(wd), item(MEM, v(ws))), change(wd, 1), change(ws, 1), change(i, 4),
        ]),
      ]),
      repeat(sub(P(2), v(i)), [...copyByte, change(i, 1)]),
    ];
  } },

  memfill: { args: 3, body: (V) => {
    const [i, b, a, wd, w] = ['i', 'b', 'a', 'wd', 'w'].map(V);
    const t = { i: V('ti'), k: V('tk'), w: V('tw') };
    const fillByte = [set(a, add(P(0), v(i))), ...storeSub(v(a), v(b), 1, t), change(i, 1)];
    return [
      set(b, mod(P(1), 256)), set(i, 0),
      until(or(eq(mod(add(P(0), v(i)), 4), 0), not(lt(v(i), P(2)))), fillByte),
      set(wd, add(div(add(P(0), v(i)), 4), 1)), set(w, mul(v(b), 16843009)),
      repeat(floor(div(sub(P(2), v(i)), 4)), [A.lrep(MEM, v(wd), v(w)), change(wd, 1), change(i, 4)]),
      repeat(sub(P(2), v(i)), fillByte),
    ];
  } },

  grow: { args: 1, body: (V, rt) => [
    iff(or(gt(add(v('memsize'), P(0)), rt.ctx.maxPages), gt(add(A.listLen(MEM), mul(P(0), 16384)), LIST_LIMIT)), [
      set('r', U - 1), A.stopThis(),
    ]),
    set('r', v('memsize')),
    repeat(mul(P(0), 16384), [A.ladd(MEM, 0)]),
    change('memsize', P(0)),
  ] },

  flush: { args: 0, body: () => [
    iff(not(eq(A.length(v('line')), 0)), [A.ladd('stdout', v('line')), set('line', A.str(''))]),
  ] },

  trap: { args: 1, deps: ['flush'], body: (V, rt) => [
    A.call(rt.name('flush')),
    A.ladd('stdout', A.join(A.str('wasm trap: '), P(0))),
    set('exit code', 134),
    A.stopAll(),
  ] },

  exit: { args: 1, deps: ['flush'], body: (V, rt) => [
    A.call(rt.name('flush')),
    set('exit code', P(0)),
    A.stopAll(),
  ] },

  // WASI fd_write(fd, iovs, iovs_len, nwritten): everything goes to the stdout list.
  fd_write: { args: 4, body: (V) => {
    const [t, iv, p, n, b] = ['t', 'iv', 'p', 'n', 'b'].map(V);
    return [
      set(t, 0), set(iv, P(1)),
      repeat(P(2), [
        set(p, item(MEM, add(div(v(iv), 4), 1))), set(n, item(MEM, add(div(v(iv), 4), 2))),
        change(t, v(n)),
        repeat(v(n), [set(b, loadSub(v(p), 1)), ...putcStmts(b, V), change(p, 1)]),
        change(iv, 8),
      ]),
      A.lrep(MEM, add(div(P(3), 4), 1), v(t)),
      set('r', 0),
    ];
  } },

  // WASI fd_read(fd, iovs, iovs_len, nread): reads lines with "ask and wait".
  fd_read: { args: 4, body: (V) => {
    const [t, iv, p, n, c, b] = ['t', 'iv', 'p', 'n', 'c', 'b'].map(V);
    const tt = { i: V('ti'), k: V('tk'), w: V('tw') };
    const costume = (x) => A.stmt('looks_switchcostumeto', { COSTUME: { menu: 'looks_costume', field: 'COSTUME', value: 'blank', expr: x } });
    return [
      set(t, 0), set(iv, P(1)),
      repeat(P(2), [
        set(p, item(MEM, add(div(v(iv), 4), 1))), set(n, item(MEM, add(div(v(iv), 4), 2))),
        iff(and(gt(v('stdin.pos'), A.length(v('stdin'))), eq(v(t), 0)), [
          // The unfinished output line (e.g. a prompt) becomes the question;
          // it stays in `line`, so an echoed answer completes it.
          A.stmt('sensing_askandwait', { QUESTION: v('line') }),
          set('stdin', A.join(A.reporter('sensing_answer'), A.str('\n'))),
          set('stdin.pos', 1),
        ]),
        until(or(eq(v(n), 0), gt(v('stdin.pos'), A.length(v('stdin')))), [
          set(c, A.letter(v('stdin.pos'), v('stdin'))),
          iff(eq(v(c), A.str('\n')), [set(b, 10)], [
            costume(A.str('blank')), costume(v(c)),
            set(b, add(A.reporter('looks_costumenumbername', {}, { NUMBER_NAME: 'number' }), 30)),
            iff(eq(v(b), 31), [set(b, 63)]),
          ]),
          ...storeSub(v(p), v(b), 1, tt),
          change(p, 1), change(n, -1), change('stdin.pos', 1), change(t, 1),
        ]),
        change(iv, 8),
      ]),
      costume(A.str('blank')),
      A.lrep(MEM, add(div(P(3), 4), 1), v(t)),
      set('r', 0),
    ];
  } },

  // strcopy(text, ptr, cap): writes up to cap characters of text into memory
  // as bytes (ASCII; other characters become '?') and returns the count in r.
  strcopy: { args: 3, body: (V) => {
    const [i, p, n, c, b] = ['i', 'p', 'n', 'c', 'b'].map(V);
    const tt = { i: V('ti'), k: V('tk'), w: V('tw') };
    const costume = (x) => A.stmt('looks_switchcostumeto', { COSTUME: { menu: 'looks_costume', field: 'COSTUME', value: 'blank', expr: x } });
    return [
      set(n, A.length(P(0))),
      iff(gt(v(n), P(2)), [set(n, P(2))]),
      set(i, 1), set(p, P(1)),
      repeat(v(n), [
        set(c, A.letter(v(i), P(0))),
        // Character code via the costume-name trick (names are case-sensitive).
        costume(A.str('blank')), costume(v(c)),
        set(b, add(A.reporter('looks_costumenumbername', {}, { NUMBER_NAME: 'number' }), 30)),
        iff(eq(v(b), 31), [set(b, 63)]),
        ...storeSub(v(p), v(b), 1, tt),
        change(p, 1), change(i, 1),
      ]),
      costume(A.str('blank')),
      set('r', v(n)),
    ];
  } },

  // gcroots_copy(buf, start, count): items start+1.. of `gcroots` -> words at buf.
  gcroots_copy: { args: 3, body: (V) => {
    const [i, w] = ['i', 'w'].map(V);
    return [
      set(i, 0), set(w, add(div(P(0), 4), 1)),
      repeat(P(2), [
        A.lrep(MEM, v(w), mod(floor(add(item('gcroots', add(add(P(1), v(i)), 1)), 0)), U)),
        change(i, 1), change(w, 1),
      ]),
      set('r', P(2)),
    ];
  } },

  // Copies the NUL-terminated string at p0 into r (ASCII/Latin-1 only).
  cstr: { args: 1, body: (V) => {
    const [p, b] = ['p', 'b'].map(V);
    return [
      set('r', A.str('')), set(p, P(0)), set(b, loadSub(v(p), 1)),
      until(eq(v(b), 0), [set('r', A.join(v('r'), item('chr', add(v(b), 1)))), change(p, 1), set(b, loadSub(v(p), 1))]),
    ];
  } },
};

function mul32x32Stmts(a, b, V) {
  const [p0, p1, s] = ['p0', 'p1', 's'].map(V);
  return [
    set(p0, mul(mod(a, 65536), b)),
    set(p1, mul(floor(div(a, 65536)), b)),
    set(s, add(v(p0), mul(mod(v(p1), 65536), 65536))),
    set('r', mod(v(s), U)),
    set('rh', add(floor(div(v(s), U)), floor(div(v(p1), 65536)))),
  ];
}

// e <- floor(log2(a)) exactly, for finite a > 0.
function exponentStmts(a, e, maxExp) {
  return [
    set(e, floor(div(A.ln(v(a)), Math.LN2))),
    iff(gt(v(e), maxExp), [set(e, maxExp)]),
    iff(gt(fpow2(v(e)), v(a)), [change(e, -1)]),
    iff(and(lt(v(e), maxExp), not(gt(fpow2(add(v(e), 1)), v(a)))), [change(e, 1)]),
  ];
}

export class Runtime {
  constructor(ctx) {
    this.ctx = ctx;
    this.used = new Map(); // name -> proc
  }
  name(h) { return 'rt.' + h; }
  use(h) {
    if (this.used.has(h)) return this.name(h);
    const def = HELPERS[h];
    if (!def) throw new Error(`internal: unknown runtime helper ${h}`);
    const proc = { name: this.name(h), args: Array.from({ length: def.args }, (_, i) => 'p' + i), warp: true, body: null };
    this.used.set(h, proc);
    for (const d of def.deps || []) this.use(d);
    proc.body = def.body((x) => `rt.${h}.${x}`, this);
    if (this.ctx.opts.profile) {
      proc.body.unshift(A.change(`prof.rt.${h}`, 1));
      if (h === 'memcpy' || h === 'memfill') proc.body.unshift(A.change(`prof.rt.${h}.bytes`, P(2)));
    }
    return proc.name;
  }
  inline1(name, args, cx) { return inline1(name, args, cx); }
  procs() { return [...this.used.values()]; }
}
