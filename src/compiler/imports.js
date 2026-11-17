// Host functions available to WebAssembly modules.
//
//  * WASI preview 1 (`wasi_snapshot_preview1` / `wasi_unstable`): enough of it
//    for wasi-libc programs that print, read lines, exit and ask for the time.
//    stdout/stderr go to the `stdout` list (shown on stage); stdin uses
//    "ask and wait".
//  * The Scratch API (`scratch` module, or `env` for convenience): pen, motion,
//    speech bubbles, mouse/keyboard input and the timer. See include/scratch.h.

import * as A from '../scratch/ast.js';
import * as M from './memory.js';
import { signed32 } from './ops.js';

const U = 4294967296;
const { num, v } = A;

const WASI_MODULES = new Set(['wasi_snapshot_preview1', 'wasi_unstable']);
const SCRATCH_MODULES = new Set(['scratch', 'env']);

export const SCRIPT_LIST = 'Python code';

const sig = (t) => `${t.params.join(',')}->${t.results.join(',')}`;

function storeWord(cx, ptr, off, val) {
  cx.emit(A.lrep(M.MEM, M.wordIdx(M.effAddr(ptr, off)), val));
}
const ok = () => [{ ty: 'i32', e: num(0) }];
const errno = (n) => () => [{ ty: 'i32', e: num(n) }];
const helperR = (name) => (cx, a) => {
  cx.emit(A.call(cx.ctx.rt.use(name), ...a.map((x) => x.e)));
  return [{ ty: 'i32', e: cx.setTmp(v('r')) }];
};

const WASI = {
  fd_write: { sig: 'i32,i32,i32,i32->i32', fn: (cx, a) => { cx.ctx.uses.stdout = true; return helperR('fd_write')(cx, a); } },
  fd_read: { sig: 'i32,i32,i32,i32->i32', fn: (cx, a) => { cx.ctx.uses.stdin = true; return helperR('fd_read')(cx, a); } },
  proc_exit: { sig: 'i32->', fn: (cx, a) => { cx.ctx.uses.stdout = true; cx.emit(A.call(cx.ctx.rt.use('exit'), a[0].e)); return []; } },
  args_sizes_get: { sig: 'i32,i32->i32', fn: (cx, a) => {
    const p0 = cx.dup(a[0].e), p1 = cx.dup(a[1].e);
    storeWord(cx, p0, 0, num(1));
    storeWord(cx, p1, 0, num(5));
    return ok();
  } },
  args_get: { sig: 'i32,i32->i32', fn: (cx, a) => {
    const argv = cx.dup(a[0].e), buf = cx.dup(a[1].e);
    storeWord(cx, argv, 0, buf);
    const stu = cx.ctx.rt.use('stu');
    cx.emit(A.call(stu, buf, num(0x6d736177), num(4))); // "wasm"
    cx.emit(A.call(stu, A.add(buf, 4), num(0), num(1)));
    return ok();
  } },
  environ_sizes_get: { sig: 'i32,i32->i32', fn: (cx, a) => {
    const p0 = cx.dup(a[0].e), p1 = cx.dup(a[1].e);
    storeWord(cx, p0, 0, num(0));
    storeWord(cx, p1, 0, num(0));
    return ok();
  } },
  environ_get: { sig: 'i32,i32->i32', fn: ok },
  clock_time_get: { sig: 'i32,i64,i32->i32', fn: (cx, a) => {
    const id = a[0].e;
    const t = cx.newX();
    const real = A.mul(A.add(A.mul(A.reporter('sensing_dayssince2000'), 86400), 946684800), 1e9);
    const mono = A.mul(A.reporter('sensing_timer'), 1e9);
    cx.emit(A.iff(A.eq(id, 0), [A.set(t, A.floor(real))], [A.set(t, A.floor(mono))]));
    const ptr = cx.dup(a[2].e);
    storeWord(cx, ptr, 0, A.mod(v(t), U));
    storeWord(cx, ptr, 4, A.mod(A.floor(A.div(v(t), U)), U));
    return ok();
  } },
  clock_res_get: { sig: 'i32,i32->i32', fn: (cx, a) => {
    const ptr = cx.dup(a[1].e);
    storeWord(cx, ptr, 0, num(1000000));
    storeWord(cx, ptr, 4, num(0));
    return ok();
  } },
  random_get: { sig: 'i32,i32->i32', fn: (cx, a) => {
    const i = cx.newX(), p = cx.newX();
    const buf = cx.dup(a[0].e);
    cx.emit(A.set(i, 0));
    cx.emit(A.repeat(a[1].e, [
      A.set(p, A.add(buf, v(i))),
      ...M.storeSub(v(p), A.random(0, 255), 1, cx.tmpNames()),
      A.change(i, 1),
    ]));
    return ok();
  } },
  fd_fdstat_get: { sig: 'i32,i32->i32', fn: (cx, a) => {
    const ptr = cx.dup(a[1].e);
    [2, 0, U - 1, U - 1, U - 1, U - 1].forEach((w, k) => storeWord(cx, ptr, 4 * k, num(w)));
    return ok();
  } },
  fd_close: { sig: 'i32->i32', fn: ok },
  fd_sync: { sig: 'i32->i32', fn: ok },
  fd_seek: { sig: 'i32,i64,i32,i32->i32', fn: errno(70) }, // ESPIPE
  fd_prestat_get: { sig: 'i32,i32->i32', fn: errno(8) }, // EBADF: no preopened directories
  fd_prestat_dir_name: { sig: 'i32,i32,i32->i32', fn: errno(8) },
  sched_yield: { sig: '->i32', fn: ok },
};

const keyOf = (c) => ({ KEY_OPTION: { menu: 'sensing_keyoptions', field: 'KEY_OPTION', value: 'space', expr: A.item('keys', A.add(c, 1)) } });

const SCRATCH = {
  pen_clear: { sig: '->', fn: (cx) => { cx.ctx.uses.pen = true; cx.emit(A.stmt('pen_clear')); return []; } },
  pen_down: { sig: '->', fn: (cx) => { cx.ctx.uses.pen = true; cx.emit(A.stmt('pen_penDown')); return []; } },
  pen_up: { sig: '->', fn: (cx) => { cx.ctx.uses.pen = true; cx.emit(A.stmt('pen_penUp')); return []; } },
  pen_stamp: { sig: '->', fn: (cx) => { cx.ctx.uses.pen = true; cx.emit(A.stmt('pen_stamp')); return []; } },
  pen_color: { sig: 'i32->', fn: (cx, a) => {
    cx.ctx.uses.pen = true;
    cx.emit(A.stmt('pen_setPenColorToColor', { COLOR: { shadow: 9, expr: a[0].e } }));
    return [];
  } },
  pen_hue: { sig: 'f64->', fn: (cx, a) => {
    cx.ctx.uses.pen = true;
    cx.emit(A.stmt('pen_setPenColorParamTo', {
      COLOR_PARAM: { menu: 'pen_menu_colorParam', field: 'colorParam', value: 'color' },
      VALUE: a[0].e,
    }));
    return [];
  } },
  pen_size: { sig: 'f64->', fn: (cx, a) => { cx.ctx.uses.pen = true; cx.emit(A.stmt('pen_setPenSizeTo', { SIZE: a[0].e })); return []; } },
  goto_xy: { sig: 'f64,f64->', fn: (cx, a) => { cx.emit(A.stmt('motion_gotoxy', { X: a[0].e, Y: a[1].e })); return []; } },
  // The sprite starts hidden (so "ask and wait" shows its question above the
  // input box); speech bubbles show it first.
  say: { sig: 'i32->', fn: (cx, a) => {
    cx.emit(A.call(cx.ctx.rt.use('cstr'), a[0].e));
    cx.emit(A.stmt('looks_show'));
    cx.emit(A.stmt('looks_say', { MESSAGE: v('r') }));
    return [];
  } },
  say_int: { sig: 'i32->', fn: (cx, a) => { cx.emit(A.stmt('looks_show')); cx.emit(A.stmt('looks_say', { MESSAGE: signed32(a[0].e) })); return []; } },
  say_num: { sig: 'f64->', fn: (cx, a) => { cx.emit(A.stmt('looks_show')); cx.emit(A.stmt('looks_say', { MESSAGE: a[0].e })); return []; } },
  stdout_visible: { sig: 'i32->', fn: (cx, a) => {
    cx.ctx.uses.stdout = true;
    const e = a[0].e;
    if (e.t === 'n') cx.emit(A.lshow('stdout', e.v !== 0));
    else cx.emit(A.iff(A.eq(e, 0), [A.lshow('stdout', false)], [A.lshow('stdout', true)]));
    return [];
  } },
  wait: { sig: 'f64->', fn: (cx, a) => { cx.emit(A.stmt('control_wait', { DURATION: a[0].e })); return []; } },
  mouse_x: { sig: '->f64', fn: () => [{ ty: 'f64', e: A.reporter('sensing_mousex') }] },
  mouse_y: { sig: '->f64', fn: () => [{ ty: 'f64', e: A.reporter('sensing_mousey') }] },
  mouse_down: { sig: '->i32', fn: () => [{ ty: 'i32', e: A.reporter('sensing_mousedown', {}, {}, true) }] },
  key_pressed: { sig: 'i32->i32', fn: (cx, a) => {
    cx.ctx.uses.keys = true;
    return [{ ty: 'i32', e: A.reporter('sensing_keypressed', keyOf(A.mod(a[0].e, 128)), {}, true) }];
  } },
  timer: { sig: '->f64', fn: () => [{ ty: 'f64', e: A.reporter('sensing_timer') }] },
  // Wall-clock seconds. Unlike the Scratch timer (which only advances between
  // frames), this keeps moving while a script runs.
  clock: { sig: '->f64', fn: () => [{ ty: 'f64', e: A.mul(A.reporter('sensing_dayssince2000'), 86400) }] },
  reset_timer: { sig: '->', fn: (cx) => { cx.emit(A.stmt('sensing_resettimer')); return []; } },
  // GC support: gc_roots_begin() snapshots every Scratch variable that can
  // hold a wasm value (locals, stack slots, globals, saved call frames) and
  // returns how many there are; gc_roots_copy(buf, start, count) writes a
  // range of them into linear memory as u32 words for a conservative scan.
  gc_roots_begin: { sig: '->i32', fn: (cx) => {
    cx.emit(A.call(cx.ctx.gcRootsProc()));
    return [{ ty: 'i32', e: cx.setTmp(A.listLen('gcroots')) }];
  } },
  gc_roots_copy: { sig: 'i32,i32,i32->i32', fn: (cx, a) => {
    cx.emit(A.call(cx.ctx.rt.use('gcroots_copy'), a[0].e, a[1].e, a[2].e));
    return [{ ty: 'i32', e: cx.setTmp(v('r')) }];
  } },
  // The program's source text kept in an editable Scratch list (one line
  // per item): script_lines() is the number of lines, script_line(i, buf, cap)
  // copies line i (0-based) into memory and returns its length.
  script_lines: { sig: '->i32', fn: (cx) => {
    cx.ctx.uses.scriptList = true;
    return [{ ty: 'i32', e: A.listLen(SCRIPT_LIST) }];
  } },
  script_line: { sig: 'i32,i32,i32->i32', fn: (cx, a) => {
    cx.ctx.uses.scriptList = true;
    cx.ctx.uses.stdin = true; // needs the character-code costumes
    cx.emit(A.call(cx.ctx.rt.use('strcopy'), A.item(SCRIPT_LIST, A.add(a[0].e, 1)), a[1].e, a[2].e));
    return [{ ty: 'i32', e: cx.setTmp(v('r')) }];
  } },
  random_int: { sig: 'i32,i32->i32', fn: (cx, a) => [{ ty: 'i32', e: A.mod(A.random(signed32(a[0].e), signed32(a[1].e)), U) }] },
};

// Scratch key names for ASCII codes (28-31 are the arrow keys).
export function keyTable() {
  const t = Array.from({ length: 128 }, () => '');
  for (let c = 33; c < 127; c++) t[c] = String.fromCharCode(c).toLowerCase();
  t[32] = 'space';
  t[10] = 'enter';
  t[13] = 'enter';
  t[28] = 'left arrow';
  t[29] = 'right arrow';
  t[30] = 'up arrow';
  t[31] = 'down arrow';
  return t;
}

export class Imports {
  constructor(ctx) {
    this.ctx = ctx;
  }

  resolve(func) {
    const { module, name } = func.import;
    let table = null;
    if (WASI_MODULES.has(module)) table = WASI;
    else if (SCRATCH_MODULES.has(module)) table = SCRATCH;
    const def = table && table[name];
    if (def && def.sig !== sig(func.type)) {
      throw new Error(`import ${module}.${name} has signature (${sig(func.type)}), expected (${def.sig})`);
    }
    return def || null;
  }

  // Validates imports up front so unknown ones are reported once.
  check() {
    for (const f of this.ctx.mod.funcs) {
      if (!f.import || !this.ctx.reachable.has(f.index)) continue;
      if (!this.resolve(f)) {
        const { module, name } = f.import;
        const hint = WASI_MODULES.has(module) ? ' (returns ENOSYS)' : ' (traps when called)';
        this.ctx.warn(`unsupported import ${module}.${name}${hint}`);
      }
    }
  }

  compile(cx, func, args) {
    const def = this.resolve(func);
    if (def) return def.fn(cx, args);
    const { module, name } = func.import;
    if (WASI_MODULES.has(module) && func.type.results.length === 1 && func.type.results[0] === 'i32') {
      return [{ ty: 'i32', e: num(52) }]; // ENOSYS
    }
    cx.emit(A.call(cx.ctx.rt.use('trap'), A.str(`call to unsupported import ${module}.${name}`)));
    return func.type.results.map((ty) => ({ ty, e: ty === 'i64' ? [num(0), num(0)] : num(0) }));
  }
}
