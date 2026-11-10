// A small WebAssembly binary decoder.
//
// Produces a plain-object module description. Function bodies are decoded into
// a *tree* of instructions: `block`, `loop` and `if` carry their nested bodies,
// so later passes never have to match `end` opcodes themselves.

import { OPCODES, OPCODES_FC } from './opcodes.js';

const VALTYPES = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128', 0x70: 'funcref', 0x6f: 'externref' };

class Reader {
  constructor(bytes, pos = 0, end = bytes.length) {
    this.b = bytes;
    this.p = pos;
    this.end = end;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  eof() { return this.p >= this.end; }
  u8() {
    if (this.p >= this.end) throw new Error('unexpected end of wasm data');
    return this.b[this.p++];
  }
  u32() {
    let result = 0, shift = 0;
    for (;;) {
      const byte = this.u8();
      result += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) break;
      shift += 7;
      if (shift > 35) throw new Error('LEB128 u32 too long');
    }
    return result;
  }
  s32() {
    let result = 0, shift = 0, byte;
    do {
      byte = this.u8();
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    if (shift < 32 && (byte & 0x40)) result |= -1 << shift;
    return result | 0;
  }
  s64() {
    let result = 0n, shift = 0n, byte;
    do {
      byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    } while (byte & 0x80);
    if (byte & 0x40) result |= -1n << shift;
    return BigInt.asIntN(64, result);
  }
  f32() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  u32raw() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  bytes(n) {
    if (this.p + n > this.end) throw new Error('unexpected end of wasm data');
    const out = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return out;
  }
  name() { return new TextDecoder('utf-8').decode(this.bytes(this.u32())); }
  valtype() {
    const b = this.u8();
    const t = VALTYPES[b];
    if (!t) throw new Error(`unknown value type 0x${b.toString(16)}`);
    return t;
  }
  vec(fn) {
    const n = this.u32();
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = fn();
    return out;
  }
  limits() {
    const flags = this.u8();
    const min = this.u32();
    const max = flags & 1 ? this.u32() : null;
    return { min, max, shared: !!(flags & 2), is64: !!(flags & 4) };
  }
  sub(len) {
    const r = new Reader(this.b, this.p, this.p + len);
    this.p += len;
    return r;
  }
}

function readBlockType(r) {
  const b = r.b[r.p];
  if (b === 0x40) { r.p++; return null; }
  if (VALTYPES[b]) { r.p++; return VALTYPES[b]; }
  return r.s32(); // type index (s33, but indices fit comfortably)
}

// Reads instructions until a terminator (`end`, or one of `extra`, e.g. `else`
// inside `if` or `catch`/`delegate` inside `try`). Returns {term, imm}.
function readInstrs(r, out, extra = null) {
  for (;;) {
    const code = r.u8();
    if (code === 0x0b) return { term: 'end' };
    if (code === 0x05 || code === 0x07 || code === 0x18 || code === 0x19) {
      const term = OPCODES[code][0];
      if (!extra || !extra.includes(term)) throw new Error(`unexpected ${term}`);
      return { term, imm: code === 0x07 || code === 0x18 ? r.u32() : undefined };
    }
    let entry;
    if (code === 0xfc) {
      const sub = r.u32();
      entry = OPCODES_FC[sub];
      if (!entry) throw new Error(`unsupported opcode 0xfc ${sub}`);
    } else if (code === 0xfd) {
      throw new Error('SIMD (v128) instructions are not supported; compile with -mno-simd128');
    } else if (code === 0xfe) {
      throw new Error('threads/atomics instructions are not supported');
    } else {
      entry = OPCODES[code];
      if (!entry) throw new Error(`unsupported opcode 0x${code.toString(16)}`);
    }
    const [op, imm] = entry;
    const ins = { op };
    switch (imm) {
      case '': break;
      case 'block': {
        ins.bt = readBlockType(r);
        if (op === 'if') {
          ins.then = [];
          ins.else = null;
          if (readInstrs(r, ins.then, ['else']).term === 'else') {
            ins.else = [];
            readInstrs(r, ins.else);
          }
        } else if (op === 'try') {
          // try <body> (catch tag <body>)* (catch_all <body>)? end  |  try <body> delegate L
          ins.body = [];
          ins.catches = [];
          ins.catchAll = null;
          ins.delegate = null;
          let t = readInstrs(r, ins.body, ['catch', 'catch_all', 'delegate']);
          while (t.term === 'catch') {
            const c = { tag: t.imm, body: [] };
            ins.catches.push(c);
            t = readInstrs(r, c.body, ['catch', 'catch_all']);
          }
          if (t.term === 'catch_all') {
            ins.catchAll = [];
            readInstrs(r, ins.catchAll);
          } else if (t.term === 'delegate') {
            ins.delegate = t.imm;
          }
        } else {
          ins.body = [];
          readInstrs(r, ins.body);
        }
        break;
      }
      case 'label': ins.depth = r.u32(); break;
      case 'tag': ins.tag = r.u32(); break;
      case 'table': ins.targets = r.vec(() => r.u32()); ins.default = r.u32(); break;
      case 'func': ins.func = r.u32(); break;
      case 'calli': ins.type = r.u32(); ins.table = r.u32(); break;
      case 'local': ins.idx = r.u32(); break;
      case 'global': ins.idx = r.u32(); break;
      case 'mem': ins.align = r.u32(); ins.offset = r.u32(); break;
      case 'memidx': r.u8(); break;
      case 'mem2': r.u8(); r.u8(); break;
      case 'i32': ins.value = r.s32() >>> 0; break;
      case 'i64': ins.value = BigInt.asUintN(64, r.s64()); break;
      case 'f32': ins.value = r.f32(); break;
      case 'f64': ins.value = r.f64(); break;
      case 'selt': r.vec(() => r.valtype()); break;
      case 'reftype': ins.reftype = r.valtype(); break;
      case 'tableidx': ins.table = r.u32(); break;
      case 'dataidx_mem': ins.data = r.u32(); r.u8(); break;
      case 'dataidx': ins.data = r.u32(); break;
      case 'elem_table': ins.elem = r.u32(); ins.table = r.u32(); break;
      case 'elemidx': ins.elem = r.u32(); break;
      case 'table2': ins.table = r.u32(); ins.table2 = r.u32(); break;
      default: throw new Error(`internal: unknown immediate kind ${imm}`);
    }
    out.push(ins);
  }
}

function readConstExpr(r) {
  const out = [];
  readInstrs(r, out);
  return out;
}

export function parseWasm(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const r = new Reader(bytes);
  if (r.u32raw() !== 0x6d736100) throw new Error('not a WebAssembly binary (bad magic)');
  const version = r.u32raw();
  if (version !== 1) throw new Error(`unsupported WebAssembly version ${version}`);

  const mod = {
    types: [], imports: [], funcs: [], tables: [], memories: [], globals: [],
    exports: [], start: null, elems: [], datas: [], tags: [],
    names: { module: null, funcs: new Map(), locals: new Map(), globals: new Map() },
    numImportedFuncs: 0, numImportedGlobals: 0,
  };
  const funcTypeIdx = [];

  while (!r.eof()) {
    const id = r.u8();
    const size = r.u32();
    const s = r.sub(size);
    switch (id) {
      case 0: { // custom
        const name = s.name();
        if (name === 'name') {
          try { readNameSection(s, mod); } catch { /* malformed names are not fatal */ }
        }
        break;
      }
      case 1:
        mod.types = s.vec(() => {
          const form = s.u8();
          if (form !== 0x60) throw new Error(`unsupported type form 0x${form.toString(16)}`);
          return { params: s.vec(() => s.valtype()), results: s.vec(() => s.valtype()) };
        });
        break;
      case 2:
        s.vec(() => {
          const module = s.name(), name = s.name(), kind = s.u8();
          if (kind === 0) {
            const typeIdx = s.u32();
            mod.imports.push({ module, name, kind: 'func', typeIdx });
            mod.funcs.push({ index: mod.funcs.length, typeIdx, type: mod.types[typeIdx], import: { module, name }, locals: [], body: null });
            mod.numImportedFuncs++;
          } else if (kind === 1) {
            const reftype = s.valtype();
            mod.imports.push({ module, name, kind: 'table' });
            mod.tables.push({ reftype, ...s.limits(), import: { module, name } });
          } else if (kind === 2) {
            mod.imports.push({ module, name, kind: 'memory' });
            mod.memories.push({ ...s.limits(), import: { module, name } });
          } else if (kind === 3) {
            const type = s.valtype(), mutable = s.u8() === 1;
            mod.imports.push({ module, name, kind: 'global' });
            mod.globals.push({ type, mutable, init: null, import: { module, name } });
            mod.numImportedGlobals++;
          } else if (kind === 4) {
            s.u8();
            const typeIdx = s.u32();
            mod.imports.push({ module, name, kind: 'tag' });
            mod.tags.push({ typeIdx, type: mod.types[typeIdx], import: { module, name } });
          } else {
            throw new Error(`unsupported import kind ${kind}`);
          }
        });
        break;
      case 3:
        s.vec(() => funcTypeIdx.push(s.u32()));
        break;
      case 4:
        s.vec(() => { const reftype = s.valtype(); mod.tables.push({ reftype, ...s.limits(), import: null }); });
        break;
      case 5:
        s.vec(() => mod.memories.push({ ...s.limits(), import: null }));
        break;
      case 6:
        s.vec(() => {
          const type = s.valtype(), mutable = s.u8() === 1;
          mod.globals.push({ type, mutable, init: readConstExpr(s), import: null });
        });
        break;
      case 7:
        s.vec(() => {
          const name = s.name(), kind = ['func', 'table', 'memory', 'global'][s.u8()], index = s.u32();
          mod.exports.push({ name, kind, index });
        });
        break;
      case 8:
        mod.start = s.u32();
        break;
      case 9:
        s.vec(() => mod.elems.push(readElem(s)));
        break;
      case 10: {
        let i = 0;
        s.vec(() => {
          const bodySize = s.u32();
          const b = s.sub(bodySize);
          const locals = [];
          b.vec(() => {
            const n = b.u32(), t = b.valtype();
            if (locals.length + n > 50000) throw new Error('too many locals');
            for (let k = 0; k < n; k++) locals.push(t);
          });
          const body = [];
          readInstrs(b, body);
          const typeIdx = funcTypeIdx[i++];
          mod.funcs.push({ index: mod.funcs.length, typeIdx, type: mod.types[typeIdx], import: null, locals, body });
        });
        break;
      }
      case 11:
        s.vec(() => {
          const flag = s.u32();
          if (flag === 1) {
            mod.datas.push({ mode: 'passive', offset: null, bytes: s.bytes(s.u32()) });
          } else {
            if (flag === 2) s.u32();
            const offset = readConstExpr(s);
            mod.datas.push({ mode: 'active', offset, bytes: s.bytes(s.u32()) });
          }
        });
        break;
      case 12: // data count
        break;
      case 13: // tags (exception handling)
        s.vec(() => { s.u8(); const typeIdx = s.u32(); mod.tags.push({ typeIdx, type: mod.types[typeIdx], import: null }); });
        break;
      default:
        break; // unknown sections (e.g. tag section) are ignored
    }
  }
  for (const [idx, name] of mod.names.funcs) if (mod.funcs[idx]) mod.funcs[idx].name = name;
  return mod;
}

function readElem(s) {
  const flag = s.u32();
  const el = { mode: 'active', table: 0, offset: null, funcs: [] };
  const exprToFunc = () => {
    const e = readConstExpr(s);
    if (e.length === 1 && e[0].op === 'ref.func') return e[0].func;
    return null; // ref.null or something we cannot evaluate statically
  };
  switch (flag) {
    case 0: el.offset = readConstExpr(s); el.funcs = s.vec(() => s.u32()); break;
    case 1: el.mode = 'passive'; s.u8(); el.funcs = s.vec(() => s.u32()); break;
    case 2: el.table = s.u32(); el.offset = readConstExpr(s); s.u8(); el.funcs = s.vec(() => s.u32()); break;
    case 3: el.mode = 'declarative'; s.u8(); el.funcs = s.vec(() => s.u32()); break;
    case 4: el.offset = readConstExpr(s); el.funcs = s.vec(exprToFunc); break;
    case 5: el.mode = 'passive'; s.valtype(); el.funcs = s.vec(exprToFunc); break;
    case 6: el.table = s.u32(); el.offset = readConstExpr(s); s.valtype(); el.funcs = s.vec(exprToFunc); break;
    case 7: el.mode = 'declarative'; s.valtype(); el.funcs = s.vec(exprToFunc); break;
    default: throw new Error(`unsupported element segment flag ${flag}`);
  }
  return el;
}

function readNameSection(s, mod) {
  while (!s.eof()) {
    const id = s.u8();
    const sub = s.sub(s.u32());
    if (id === 0) {
      mod.names.module = sub.name();
    } else if (id === 1) {
      sub.vec(() => { const idx = sub.u32(); mod.names.funcs.set(idx, sub.name()); });
    } else if (id === 7) {
      sub.vec(() => { const idx = sub.u32(); mod.names.globals.set(idx, sub.name()); });
    } else if (id === 2) {
      sub.vec(() => {
        const fidx = sub.u32();
        const m = new Map();
        sub.vec(() => { const idx = sub.u32(); m.set(idx, sub.name()); });
        mod.names.locals.set(fidx, m);
      });
    }
  }
}

// Evaluates a constant expression (global initialisers, segment offsets).
// `globals` supplies values of already-evaluated globals.
export function evalConstExpr(expr, globals = []) {
  const st = [];
  for (const ins of expr) {
    switch (ins.op) {
      case 'i32.const': case 'f32.const': case 'f64.const': case 'i64.const': st.push(ins.value); break;
      case 'global.get': {
        const g = globals[ins.idx];
        if (g === undefined) throw new Error(`constant expression reads unknown global ${ins.idx}`);
        st.push(g);
        break;
      }
      case 'ref.null': st.push(null); break;
      case 'ref.func': st.push(ins.func); break;
      case 'i32.add': { const b = st.pop(), a = st.pop(); st.push((a + b) >>> 0); break; }
      case 'i32.sub': { const b = st.pop(), a = st.pop(); st.push((a - b) >>> 0); break; }
      case 'i32.mul': { const b = st.pop(), a = st.pop(); st.push(Math.imul(a, b) >>> 0); break; }
      case 'i64.add': { const b = st.pop(), a = st.pop(); st.push(BigInt.asUintN(64, a + b)); break; }
      case 'i64.sub': { const b = st.pop(), a = st.pop(); st.push(BigInt.asUintN(64, a - b)); break; }
      case 'i64.mul': { const b = st.pop(), a = st.pop(); st.push(BigInt.asUintN(64, a * b)); break; }
      default: throw new Error(`unsupported instruction in constant expression: ${ins.op}`);
    }
  }
  return st.pop();
}
