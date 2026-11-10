// Compiles one WebAssembly function into a Scratch custom block.
//
// Code generation keeps a *symbolic* operand stack: instructions push Scratch
// expressions instead of emitting statements, so `a + b * c` becomes a single
// nested reporter. Values are written to variables ("materialized") only when
// something would change what they read: a write to a variable they use, a
// memory store, a call, or the start of a control construct.
//
// Variables (per function, prefixed with the function's name):
//   NAME.lI   local I            (I64 values use a second variable NAME.lIh)
//   NAME.sD   operand stack slot at depth D (also block results)
//   NAME.xN   short-lived temporaries within one instruction
// Parameters that are never assigned are read straight from the custom block's
// arguments.
//
// Structured control flow:
//   * `block`/`if` labels: a branch sets the global `br` to the label id and
//     every following statement in the enclosing blocks is guarded by
//     `if br = 0` (or placed in the else-arm of the branch's own `if`); the
//     block clears `br` at its end.
//   * `loop` labels: `repeat until not (br = L)` re-runs the body while the body
//     ended with a branch back to it.
//   * branches to the function label are returns: `stop this script`.
//
// Recursion: Scratch variables are global, so calls within a recursive
// strongly-connected component push the caller's live locals onto the list
// `cs` and pop them afterwards.

import * as A from '../scratch/ast.js';
import * as O from './ops.js';
import * as M from './memory.js';
import { analyzeStructure, analyzeLiveness, sigKey } from './analysis.js';

const U = 4294967296;
const { num, v } = A;
const isC = (e) => e.t === 'n';
const parts = (ent) => (ent.ty === 'i64' ? ent.e : [ent.e]);

function readsOf(ty, e) {
  const r = { vars: new Set(), mem: false, world: false };
  for (const p of ty === 'i64' ? e : [e]) {
    A.walkExpr(p, (n) => {
      if (n.t === 'v') r.vars.add(n.name);
      else if ((n.t === 'i' || n.t === 'll' || n.t === 'in') && n.list === M.MEM) r.mem = true;
      else if (n.t === 'blk') r.world = true;
    });
  }
  return r;
}
const entry = (ty, e) => ({ ty, e, r: readsOf(ty, e) });

export function restoreStmts(names) {
  const out = [];
  for (const n of names.slice().reverse()) {
    out.push(A.set(n, A.item('cs', A.str('last'))));
    out.push(A.ldel('cs', 'last'));
  }
  return out;
}

function containsRethrow(instrs) {
  return instrs.some((i) => i.op === 'rethrow'
    || (i.body && containsRethrow(i.body)) || (i.then && containsRethrow(i.then)) || (i.else && containsRethrow(i.else))
    || (i.catches && i.catches.some((c) => containsRethrow(c.body))) || (i.catchAll && containsRethrow(i.catchAll)));
}

export class FuncCompiler {
  constructor(ctx, func) {
    this.ctx = ctx;
    this.mod = ctx.mod;
    this.func = func;
    this.name = ctx.procName(func.index);
    this.fp = ctx.varPrefix(func.index);
    this.params = func.type.params;
    this.results = func.type.results;
    this.ltypes = [...this.params, ...func.locals];
    this.recursive = !!ctx.cg.recursive[func.index];
    this.scc = ctx.cg.scc[func.index];
    this.written = analyzeStructure(func).written;
    this.liveIn = analyzeLiveness(func, this.ltypes.length, this.recursive);
    this.stack = [];
    this.ctl = [];
    this.out = [];
    this.xn = 0;
    this.nextLabel = 1;
  }

  // ---- naming -------------------------------------------------------------

  lvar(i, h) { return `${this.fp}.l${i}${h ? 'h' : ''}`; }
  svar(d, h) { return `${this.fp}.s${d}${h ? 'h' : ''}`; }
  newX() { return `${this.fp}.x${this.xn++}`; }
  isOwn(name) { return name.startsWith(this.fp + '.'); }
  isTransient(name) { return name.startsWith(this.fp + '.x') || name === 'r' || name === 'rh' || name === 'r2' || name === 'r2h'; }
  slotNames(d, ty) { return ty === 'i64' ? [this.svar(d), this.svar(d, 1)] : [this.svar(d)]; }
  // Unassigned parameters are read straight from the block's arguments, except
  // when the program scans Scratch variables for GC roots (arguments are not
  // visible to such a scan, so every parameter gets a variable).
  paramIsArg(i) { return i < this.params.length && !this.written.has(i) && !this.ctx.uses.gcroots; }

  emit(s) { this.out.push(s); }
  withOut(arr, fn) {
    const saved = this.out;
    this.out = arr;
    try { return fn(); } finally { this.out = saved; }
  }

  // ---- the interface used by ops.js --------------------------------------

  dup(e) {
    if (A.isSimple(e)) return e;
    return this.setTmp(e);
  }
  setTmp(e) {
    const x = this.newX();
    this.emit(A.set(x, e));
    const r = v(x);
    if (e.mask !== undefined) r.mask = e.mask;
    return r;
  }
  h1(name, ...args) {
    const r = this.ctx.rt.inline1(name, args, this);
    if (r) return r;
    this.emit(A.call(this.ctx.rt.use(name), ...args));
    return this.setTmp(v('r'));
  }
  h2(name, ...args) {
    this.emit(A.call(this.ctx.rt.use(name), ...args));
    return [this.setTmp(v('r')), this.setTmp(v('rh'))];
  }

  // ---- operand stack -----------------------------------------------------

  push(ty, e) {
    const ent = entry(ty, e);
    this.stack.push(ent);
    for (const n of ent.r.vars) {
      if (this.isTransient(n)) { this.materialize(this.stack.length - 1); break; }
    }
  }
  pop() {
    if (!this.stack.length) throw new Error(`operand stack underflow in ${this.name}`);
    return this.stack.pop();
  }
  popN(n) {
    if (n === 0) return [];
    if (this.stack.length < n) throw new Error(`operand stack underflow in ${this.name}`);
    return this.stack.splice(this.stack.length - n, n);
  }

  // Simultaneous assignment of [{name, e}], ordering the writes (and using a
  // temporary on cycles) so every expression sees the old values.
  parallelSet(pairs) {
    let pend = pairs.filter((p) => !(p.e.t === 'v' && p.e.name === p.name));
    while (pend.length) {
      const i = pend.findIndex((p) => !pend.some((q) => q !== p && A.readsVar(q.e, p.name)));
      if (i < 0) {
        const p = pend[0];
        const x = this.newX();
        this.emit(A.set(x, v(p.name)));
        pend = pend.map((q) => ({ name: q.name, e: A.substVar(q.e, p.name, v(x)) }));
        continue;
      }
      this.emit(A.set(pend[i].name, pend[i].e));
      pend.splice(i, 1);
    }
  }

  // Writes stack entry d into its slot variable(s).
  materialize(d, force = false) {
    const ent = this.stack[d];
    const names = this.slotNames(d, ent.ty);
    const ps = parts(ent);
    if (ps.every((p, i) => isC(p) || (p.t === 'v' && p.name === names[i]))) {
      if (!force || ps.every((p, i) => p.t === 'v' && p.name === names[i])) return;
    }
    if (!force && ent.r.vars.size === 0 && !ent.r.mem && !ent.r.world) return; // pure: args and constants only
    this.flushVars(names, d);
    this.parallelSet(names.map((n, i) => ({ name: n, e: ps[i] })));
    this.stack[d] = entry(ent.ty, ent.ty === 'i64' ? [v(names[0]), v(names[1])] : v(names[0]));
  }

  // Materializes entries below `below` that read any of `names`.
  flushVars(names, below = this.stack.length) {
    for (let d = 0; d < below && d < this.stack.length; d++) {
      const r = this.stack[d].r;
      if (names.some((n) => r.vars.has(n))) this.materialize(d);
    }
  }
  flushMem() {
    for (let d = 0; d < this.stack.length; d++) if (this.stack[d].r.mem) this.materialize(d);
  }
  // Before a call: callee may write globals, memory and (in the same SCC) our
  // own variables.
  flushForCall(nargs, sameScc) {
    for (let d = 0; d < this.stack.length - nargs; d++) {
      const r = this.stack[d].r;
      if (sameScc || r.mem || r.world || [...r.vars].some((n) => !this.isOwn(n))) this.materialize(d);
    }
  }
  spillAll(below = this.stack.length) {
    for (let d = 0; d < below; d++) this.materialize(d);
  }

  // ---- entry point ---------------------------------------------------------

  compile() {
    const args = [];
    this.params.forEach((t, i) => { args.push('p' + i); if (t === 'i64') args.push(`p${i}h`); });
    const prologue = [];
    // Parameters that are assigned live in variables.
    this.params.forEach((t, i) => {
      if (!this.paramIsArg(i)) {
        prologue.push(A.set(this.lvar(i), A.arg('p' + i)));
        if (t === 'i64') prologue.push(A.set(this.lvar(i, 1), A.arg(`p${i}h`)));
      }
    });
    // Locals read before being written start at zero (variables are reused across calls).
    for (const i of this.liveIn) {
      if (i < this.params.length) continue;
      prologue.push(A.set(this.lvar(i), 0));
      if (this.ltypes[i] === 'i64') prologue.push(A.set(this.lvar(i, 1), 0));
    }
    this.ctl.push({ kind: 'func', btypes: this.results, height: 0 });
    const { stmts } = this.compileSeq(this.func.body, () => this.emitReturn(this.results.length, true));
    this.ctl.pop();
    if (this.ctx.opts.profile) prologue.unshift(A.change(`prof.${this.name}`, 1));
    return { name: this.name, args, warp: true, body: [...prologue, ...stmts] };
  }

  // Compiles an instruction sequence into a new statement list. `onEnd` runs
  // (on the fall-through path only) if the end of the sequence is reachable.
  compileSeq(instrs, onEnd) {
    const saved = this.out;
    const top = [];
    this.out = top;
    const items = instrs.slice();
    let opened = 0, terminated = false;
    for (let i = 0; i < items.length; i++) {
      const ins = items[i];
      if (ins.op === '__end') { this.ctl.pop(); opened--; continue; }
      if ((ins.op === 'block' || ins.op === 'loop') && ins.selfBr === 0) {
        // Nothing branches to this label: compile its body in line.
        const { params } = this.btype(ins.bt);
        this.ctl.push({ kind: 'inline', height: this.stack.length - params.length, btypes: [] });
        opened++;
        items.splice(i + 1, 0, ...ins.body, { op: '__end' });
        continue;
      }
      this.xn = 0;
      const st = this.compileIns(ins);
      if (st === 'term') { terminated = true; break; }
      if (st === 'maybe') {
        const arr = [];
        this.emit(A.iff(A.eq(v('br'), 0), arr));
        this.out = arr;
      } else if (typeof st === 'object') {
        this.out = st.split;
      }
    }
    if (terminated) { while (opened-- > 0) this.ctl.pop(); }
    else if (onEnd) { this.xn = 0; onEnd(); }
    this.out = saved;
    return { stmts: top, terminated };
  }

  btype(bt) {
    if (bt === null || bt === undefined) return { params: [], results: [] };
    if (typeof bt === 'string') return { params: [], results: [bt] };
    return this.mod.types[bt];
  }

  // Assigns the top n stack values to the slots of a label at `height`.
  setSlots(height, n) {
    const vals = this.stack.slice(this.stack.length - n);
    const pairs = [];
    vals.forEach((ent, i) => {
      const names = this.slotNames(height + i, ent.ty);
      parts(ent).forEach((p, k) => pairs.push({ name: names[k], e: p }));
    });
    this.parallelSet(pairs);
  }
  pushSlots(height, types) {
    types.forEach((ty, i) => {
      const names = this.slotNames(height + i, ty);
      this.stack.push(entry(ty, ty === 'i64' ? [v(names[0]), v(names[1])] : v(names[0])));
    });
  }

  emitReturn(n, natural) {
    const vals = this.stack.slice(this.stack.length - n);
    const pairs = [];
    vals.forEach((ent, i) => {
      const base = i === 0 ? 'ret' : 'ret' + i;
      parts(ent).forEach((p, k) => pairs.push({ name: base + (k ? 'h' : ''), e: p }));
    });
    this.parallelSet(pairs);
    if (!natural) this.emit(A.stopThis());
  }

  // Emits a branch. Returns 'ret', 'fall' (target is the end of the current
  // sequence, nothing to do) or 'set' (br was set).
  emitBranch(depth, fallOk) {
    const ti = this.ctl.length - 1 - depth;
    const t = this.ctl[ti];
    if (!t) throw new Error('branch depth out of range');
    if (t.kind === 'func') { this.emitReturn(t.btypes.length, false); return 'ret'; }
    if (t.kind === 'inline') throw new Error('internal: branch to inline block');
    this.setSlots(t.height, t.btypes.length);
    if (fallOk && ti === this.ctl.length - 1 && t.kind !== 'loop') { t.reached = true; return 'fall'; }
    for (let i = ti + 1; i < this.ctl.length; i++) this.ctl[i].escaped = true;
    t.used = true;
    this.emit(A.set('br', t.label));
    return 'set';
  }

  // ---- instructions ------------------------------------------------------------

  compileIns(ins) {
    switch (ins.op) {
      case 'block': return this.compileBlock(ins);
      case 'loop': return this.compileLoop(ins);
      case 'if': return this.compileIf(ins);
      case 'br': this.emitBranch(ins.depth, true); return 'term';
      case 'br_if': return this.compileBrIf(ins);
      case 'br_table': return this.compileBrTable(ins);
      case 'return': this.emitReturn(this.results.length, false); return 'term';
      case 'unreachable':
        this.emit(A.call(this.ctx.rt.use('trap'), A.str(`unreachable executed in ${this.name}`)));
        return 'term';
      case 'call': return this.compileCall(ins);
      case 'call_indirect': return this.compileCallIndirect(ins);
      case 'return_call': case 'return_call_indirect': {
        const st = ins.op === 'return_call' ? this.compileCall(ins) : this.compileCallIndirect(ins);
        if (typeof st === 'object') this.out = st.split;
        this.emitReturn(this.results.length, false);
        return 'term';
      }
      case 'try': return this.compileTry(ins);
      case 'throw': return this.compileThrow(ins);
      case 'rethrow': return this.compileRethrow(ins);
      default: this.compileOp(ins); return 'ok';
    }
  }

  compileBlock(ins) {
    const { params, results } = this.btype(ins.bt);
    this.spillAll();
    const h = this.stack.length - params.length;
    const c = { kind: 'block', label: this.nextLabel++, height: h, btypes: results };
    this.ctl.push(c);
    const { stmts, terminated } = this.compileSeq(ins.body, () => this.setSlots(h, results.length));
    this.ctl.pop();
    this.out.push(...stmts);
    if (c.used) this.emit(A.iff(A.eq(v('br'), c.label), [A.set('br', 0)]));
    this.stack.length = h;
    this.pushSlots(h, results);
    if (terminated && !c.used && !c.reached) return 'term';
    return c.escaped ? 'maybe' : 'ok';
  }

  compileLoop(ins) {
    const { params, results } = this.btype(ins.bt);
    this.spillAll();
    const h = this.stack.length - params.length;
    for (let k = 0; k < params.length; k++) this.materialize(h + k, true);
    const c = { kind: 'loop', label: this.nextLabel++, height: h, btypes: params };
    this.ctl.push(c);
    const { stmts, terminated } = this.compileSeq(ins.body, () => this.setSlots(h, results.length));
    this.ctl.pop();
    if (c.used) {
      this.emit(A.set('br', c.label));
      const prof = this.ctx.opts.profile ? [A.change(`prof.loop.${this.name}`, 1)] : [];
      this.emit(A.until(A.not(A.eq(v('br'), c.label)), [A.set('br', 0), ...prof, ...stmts]));
    } else {
      this.out.push(...stmts);
    }
    this.stack.length = h;
    this.pushSlots(h, results);
    if (terminated) return 'term';
    return c.escaped ? 'maybe' : 'ok';
  }

  compileIf(ins) {
    const { params, results } = this.btype(ins.bt);
    this.spillAll(this.stack.length - 1);
    const cond = O.toBool(this.pop().e);
    const h = this.stack.length - params.length;
    const c = { kind: 'if', label: this.nextLabel++, height: h, btypes: results };
    this.ctl.push(c);
    const snap = this.stack.slice();
    const a = this.compileSeq(ins.then, () => this.setSlots(h, results.length));
    this.stack = snap.slice();
    const b = this.compileSeq(ins.else || [], () => this.setSlots(h, results.length));
    this.ctl.pop();
    if (a.stmts.length === 0 && b.stmts.length > 0) this.emit(A.iff(O.notB(cond), b.stmts));
    else if (a.stmts.length || b.stmts.length) this.emit(A.iff(cond, a.stmts, b.stmts));
    if (c.used) this.emit(A.iff(A.eq(v('br'), c.label), [A.set('br', 0)]));
    this.stack = snap;
    this.stack.length = h;
    this.pushSlots(h, results);
    if (a.terminated && b.terminated && !c.used && !c.reached) return 'term';
    return c.escaped ? 'maybe' : 'ok';
  }

  compileBrIf(ins) {
    const cond = O.toBool(this.pop().e);
    const t = this.ctl[this.ctl.length - 1 - ins.depth];
    const arm = [];
    const kind = this.withOut(arm, () => this.emitBranch(ins.depth, true));
    if (kind === 'ret') { this.emit(A.iff(cond, arm)); return 'ok'; }
    const rest = [];
    if (arm.length === 0) this.emit(A.iff(O.notB(cond), rest));
    else this.emit(A.iff(cond, arm, rest));
    void t;
    return { split: rest };
  }

  compileBrTable(ins) {
    const idx = this.pop();
    const ranges = [];
    ins.targets.forEach((d, k) => {
      const last = ranges[ranges.length - 1];
      if (last && last.depth === d) return;
      ranges.push({ lo: k, depth: d });
    });
    const last = ranges[ranges.length - 1];
    if (!last || last.depth !== ins.default) ranges.push({ lo: ins.targets.length, depth: ins.default });
    const ie = ranges.length > 1 ? this.dup(idx.e) : idx.e;
    const build = (rs) => {
      if (rs.length === 1) {
        const arr = [];
        this.withOut(arr, () => this.emitBranch(rs[0].depth, true));
        return arr;
      }
      const mid = rs.length >> 1;
      return [A.iff(A.lt(ie, rs[mid].lo), build(rs.slice(0, mid)), build(rs.slice(mid)))];
    };
    this.out.push(...build(ranges));
    return 'term';
  }

  // Saves live locals (and stacked slots) around a call within our SCC.
  // Union of the locals live across this function's recursive calls.
  frameLocals() {
    if (this._frameLocals) return this._frameLocals;
    const live = new Set();
    const walk = (is) => {
      for (const i of is) {
        if ((i.op === 'call' || i.op === 'call_indirect') && i.liveAfter) {
          const same = i.op === 'call'
            ? this.ctx.cg.scc[i.func] === this.scc
            : (this.ctx.cg.tableFuncsBySig.get(sigKey(this.mod.types[i.type])) || []).some((f) => this.ctx.cg.scc[f] === this.scc);
          if (same) i.liveAfter.forEach((x) => live.add(x));
        }
        for (const k of ['body', 'then', 'else', 'catchAll']) if (i[k]) walk(i[k]);
        if (i.catches) i.catches.forEach((c) => walk(c.body));
      }
    };
    if (this.recursive) walk(this.func.body);
    const names = [];
    for (const i of [...live].sort((a, b) => a - b)) {
      if (this.paramIsArg(i)) continue;
      names.push(this.lvar(i));
      if (this.ltypes[i] === 'i64') names.push(this.lvar(i, 1));
    }
    this._frameLocals = names;
    return names;
  }

  saveSet(ins) {
    const names = new Set();
    for (const i of ins.liveAfter || []) {
      if (this.paramIsArg(i)) continue;
      names.add(this.lvar(i));
      if (this.ltypes[i] === 'i64') names.add(this.lvar(i, 1));
    }
    for (const ent of this.stack) for (const n of ent.r.vars) if (this.isOwn(n)) names.add(n);
    return [...names];
  }

  // ---- exceptions ----------------------------------------------------------
  //
  // The in-flight exception lives in the global variables `exn` (tag index + 1,
  // or 0) and `exn.K` / `exn.Kh` (payload). A throw unwinds to the handler of
  // the innermost enclosing `try` in this function by setting `br` to that
  // try's handler label, or returns from the custom block when there is none;
  // callers check `exn` after every call that may throw.

  unwindFrom(idx) {
    for (let i = idx; i >= 1; i--) {
      const t = this.ctl[i];
      if (t.kind === 'try' && t.inBody) {
        for (let j = i + 1; j < this.ctl.length; j++) this.ctl[j].escaped = true;
        t.handlerUsed = true;
        this.emit(A.set('br', t.H));
        return 'set';
      }
    }
    this.emit(A.stopThis());
    return 'ret';
  }

  exnCheck() {
    const arm = [];
    this.withOut(arm, () => this.unwindFrom(this.ctl.length - 1));
    const rest = [];
    this.emit(A.iff(A.gt(v('exn'), 0), arm, rest));
    return { split: rest };
  }

  tagPayloadNames(tag) {
    const names = [];
    this.mod.tags[tag].type.params.forEach((ty, k) => {
      names.push(`exn.${k}`);
      if (ty === 'i64') names.push(`exn.${k}h`);
    });
    return names;
  }

  allPayloadNames() {
    const set = new Set();
    this.mod.tags.forEach((_, t) => this.tagPayloadNames(t).forEach((n) => set.add(n)));
    return [...set];
  }

  compileThrow(ins) {
    const params = this.mod.tags[ins.tag].type.params;
    const vals = this.popN(params.length);
    const names = this.tagPayloadNames(ins.tag);
    this.flushVars([...names, 'exn']);
    const flat = vals.flatMap(parts);
    this.parallelSet(names.map((n, k) => ({ name: n, e: flat[k] })));
    this.emit(A.set('exn', ins.tag + 1));
    this.unwindFrom(this.ctl.length - 1);
    return 'term';
  }

  compileRethrow(ins) {
    const t = this.ctl[this.ctl.length - 1 - ins.depth];
    if (!t || t.kind !== 'try' || !t.saved) throw new Error('rethrow target is not a catch block');
    const names = ['exn', ...this.allPayloadNames()];
    this.flushVars(names);
    names.forEach((n) => this.emit(A.set(n, v(`${t.saved}.${n}`))));
    this.unwindFrom(this.ctl.length - 1);
    return 'term';
  }

  compileTry(ins) {
    const { params, results } = this.btype(ins.bt);
    this.spillAll();
    const h = this.stack.length - params.length;
    const c = { kind: 'try', label: this.nextLabel++, H: this.nextLabel++, height: h, btypes: results, inBody: true };
    const hasRethrow = [...ins.catches.map((ct) => ct.body), ins.catchAll || []].some(containsRethrow);
    if (hasRethrow) c.saved = `${this.fp}.e${c.label}`;
    this.ctl.push(c);
    const base = this.stack.slice(0, h);
    const body = this.compileSeq(ins.body, () => this.setSlots(h, results.length));
    c.inBody = false;
    this.out.push(...body.stmts);
    let armsReachEnd = false;
    if (c.handlerUsed) {
      const handler = [A.set('br', 0)];
      this.withOut(handler, () => {
        if (ins.delegate !== null) {
          this.unwindFrom(this.ctl.length - 2 - ins.delegate);
          return;
        }
        const arms = [];
        const compileArm = (tag, armBody) => {
          const stmts = [];
          this.withOut(stmts, () => {
            if (c.saved) ['exn', ...this.allPayloadNames()].forEach((n) => this.emit(A.set(`${c.saved}.${n}`, v(n))));
            this.emit(A.set('exn', 0));
          });
          this.stack = base.slice();
          if (tag !== null) {
            const names = this.tagPayloadNames(tag);
            let k = 0;
            for (const ty of this.mod.tags[tag].type.params) {
              this.stack.push(entry(ty, ty === 'i64' ? [v(names[k]), v(names[k + 1])] : v(names[k])));
              k += ty === 'i64' ? 2 : 1;
            }
          }
          const r = this.compileSeq(armBody, () => this.setSlots(h, results.length));
          if (!r.terminated) armsReachEnd = true;
          return [...stmts, ...r.stmts];
        };
        for (const ct of ins.catches) arms.push({ cond: A.eq(v('exn'), ct.tag + 1), stmts: compileArm(ct.tag, ct.body) });
        let fallback;
        if (ins.catchAll) fallback = compileArm(null, ins.catchAll);
        else {
          fallback = [];
          this.withOut(fallback, () => this.unwindFrom(this.ctl.length - 2)); // no match: keep unwinding
        }
        let chain = fallback;
        for (let k = arms.length - 1; k >= 0; k--) chain = [A.iff(arms[k].cond, arms[k].stmts, chain)];
        this.out.push(...chain);
      });
      this.emit(A.iff(A.eq(v('br'), c.H), handler));
    }
    this.ctl.pop();
    if (c.used) this.emit(A.iff(A.eq(v('br'), c.label), [A.set('br', 0)]));
    this.stack = base;
    this.pushSlots(h, results);
    if (body.terminated && !c.used && !c.reached && !armsReachEnd) return 'term';
    return c.escaped ? 'maybe' : 'ok';
  }

  emitCall(procName, args, sameScc, ins, results, mayThrow) {
    let save = sameScc ? this.saveSet(ins) : [];
    // Functions with many locals to preserve use one shared pair of
    // save/restore procedures holding every local that is live across any of
    // their recursive calls; only extra stack slots are saved inline.
    let frame = null;
    if (save.length && this.frameLocals().length >= 3) {
      const fl = this.frameLocals();
      frame = this.ctx.frameProcs(fl);
      const inFrame = new Set(fl);
      save = save.filter((n) => !inFrame.has(n));
    }
    if (frame) this.emit(A.call(frame.save));
    for (const n of save) this.emit(A.ladd('cs', v(n)));
    this.emit(A.call(procName, ...args));
    for (const stmt of restoreStmts(save)) this.emit(stmt);
    if (frame) this.emit(A.call(frame.restore));
    results.forEach((ty, i) => {
      const base = i === 0 ? 'ret' : 'ret' + i;
      this.stack.push(entry(ty, ty === 'i64' ? [v(base), v(base + 'h')] : v(base)));
    });
    return mayThrow ? this.exnCheck() : 'ok';
  }

  compileCall(ins) {
    const callee = this.mod.funcs[ins.func];
    const type = callee.type;
    if (callee.import) {
      this.flushForCall(type.params.length, false);
      const args = this.popN(type.params.length);
      const res = this.ctx.imports.compile(this, callee, args);
      for (const r of res) this.push(r.ty, r.e);
      return 'ok';
    }
    const sameScc = this.recursive && this.ctx.cg.scc[ins.func] === this.scc;
    this.flushForCall(type.params.length, sameScc);
    const args = this.popN(type.params.length).flatMap(parts);
    return this.emitCall(this.ctx.procName(ins.func), args, sameScc, ins, type.results, this.ctx.cg.mayThrow[ins.func]);
  }

  compileCallIndirect(ins) {
    const type = this.mod.types[ins.type];
    const targets = this.ctx.cg.tableFuncsBySig.get(sigKey(type)) || [];
    const sameScc = this.recursive && targets.some((f) => this.ctx.cg.scc[f] === this.scc);
    this.flushForCall(type.params.length + 1, sameScc);
    const idx = this.pop();
    const args = this.popN(type.params.length).flatMap(parts);
    const mayThrow = targets.some((f) => this.ctx.cg.mayThrow[f]);
    return this.emitCall(this.ctx.dispatcher(ins.type), [idx.e, ...args], sameScc, ins, type.results, mayThrow);
  }

  // ---- straight-line operations ------------------------------------------

  fround(e) {
    if (isC(e)) return num(Math.fround(e.v));
    const x = this.newX(), p = this.newX();
    this.emit(A.set(x, e));
    // Veltkamp splitting rounds to 24 significant bits; zeros and values
    // beyond the f32 range take the other arm (which keeps -0 and makes ±inf).
    this.emit(A.iff(A.and(A.lt(A.abs(v(x)), 3.4028235677973366e38), A.gt(A.abs(v(x)), 0)),
      [A.set(p, A.mul(v(x), 536870913)), A.set(x, A.add(A.sub(v(x), v(p)), v(p)))],
      [A.set(x, A.mul(A.mul(v(x), 1e300), 1e300))]));
    return v(x);
  }

  trunc(e) {
    if (isC(e)) return num(Math.trunc(e.v));
    const x = this.dup(e);
    return A.mul(A.floor(A.abs(x)), A.sub(A.gt(x, 0), A.lt(x, 0)));
  }

  select(ty) {
    const c = O.toBool(this.pop().e);
    const b = this.pop(), a = this.pop();
    const d = this.stack.length;
    if (c.cb !== undefined) { this.push(ty, c.cb ? a.e : b.e); return; }
    if (ty === 'i32' || ty === 'i64') {
      const pick = (x, y) => {
        if (isC(x) && isC(y)) return x.v === y.v ? x : A.add(y, A.mul(x.v - y.v, c));
        const yy = this.dup(y);
        return A.add(yy, A.mul(A.sub(x, yy), c));
      };
      if (ty === 'i32') this.push(ty, pick(a.e, b.e));
      else {
        const cc = this.dup(c.t === 'v' ? c : A.mul(1, c));
        const pick2 = (x, y) => {
          if (isC(x) && isC(y)) return x.v === y.v ? x : A.add(y, A.mul(x.v - y.v, cc));
          const yy = this.dup(y);
          return A.add(yy, A.mul(A.sub(x, yy), cc));
        };
        this.push(ty, [pick2(a.e[0], b.e[0]), pick2(a.e[1], b.e[1])]);
      }
      return;
    }
    // Floats: arithmetic blending breaks on infinities, so use statements.
    const [name] = this.slotNames(d, ty);
    this.flushVars([name], d);
    this.emit(A.iff(c, [A.set(name, a.e)], [A.set(name, b.e)]));
    this.stack.push(entry(ty, v(name)));
  }

  localGet(i) {
    const ty = this.ltypes[i];
    if (this.paramIsArg(i)) return ty === 'i64' ? [A.arg('p' + i), A.arg(`p${i}h`)] : A.arg('p' + i);
    return ty === 'i64' ? [v(this.lvar(i)), v(this.lvar(i, 1))] : v(this.lvar(i));
  }

  localSet(i, ent) {
    const ty = this.ltypes[i];
    const names = ty === 'i64' ? [this.lvar(i), this.lvar(i, 1)] : [this.lvar(i)];
    this.flushVars(names);
    this.parallelSet(names.map((n, k) => ({ name: n, e: parts(ent)[k] })));
  }

  globalNames(i) {
    const g = this.mod.globals[i];
    const base = this.ctx.globalVar(i);
    return g.type === 'i64' ? [base, base + 'h'] : [base];
  }

  compileOp(ins) {
    const op = ins.op;
    const bin = (fn, ty = 'i32') => { const b = this.pop(), a = this.pop(); this.push(ty, fn(a.e, b.e)); };
    const un = (fn, ty = 'i32') => { const a = this.pop(); this.push(ty, fn(a.e)); };
    const cx = this;
    switch (op) {
      case 'nop': return;
      case 'drop': this.pop(); return;
      case 'select': {
        const ty = this.stack[this.stack.length - 2]?.ty;
        this.select(ty);
        return;
      }
      case 'local.get': this.push(this.ltypes[ins.idx], this.localGet(ins.idx)); return;
      case 'local.set': this.localSet(ins.idx, this.pop()); return;
      case 'local.tee': {
        const ent = this.pop();
        this.localSet(ins.idx, ent);
        this.push(this.ltypes[ins.idx], this.localGet(ins.idx));
        return;
      }
      case 'global.get': {
        const g = this.mod.globals[ins.idx];
        const c = this.ctx.constGlobal(ins.idx);
        if (c !== undefined) { this.push(g.type, g.type === 'i64' ? O.const64(c) : num(c)); return; }
        const names = this.globalNames(ins.idx);
        this.push(g.type, g.type === 'i64' ? names.map((n) => v(n)) : v(names[0]));
        return;
      }
      case 'global.set': {
        const ent = this.pop();
        const names = this.globalNames(ins.idx);
        this.flushVars(names);
        this.parallelSet(names.map((n, k) => ({ name: n, e: parts(ent)[k] })));
        return;
      }

      case 'i32.const': this.push('i32', num(ins.value)); return;
      case 'i64.const': this.push('i64', O.const64(ins.value)); return;
      case 'f32.const': case 'f64.const': this.push(op.slice(0, 3), num(ins.value)); return;

      // ---- memory ----
      case 'memory.size': this.push('i32', v('memsize')); return;
      case 'memory.grow': {
        const n = this.pop();
        this.flushVars(['memsize']);
        this.emit(A.call(this.ctx.rt.use('grow'), n.e));
        this.push('i32', this.setTmp(v('r')));
        return;
      }
      case 'memory.fill': case 'memory.copy': {
        const [d, x, n] = this.popN(3);
        this.flushMem();
        this.emit(A.call(this.ctx.rt.use(op === 'memory.fill' ? 'memfill' : 'memcpy'), d.e, x.e, n.e));
        return;
      }

      // ---- i32 ----
      case 'i32.eqz': un(O.eqz32); return;
      case 'i32.eq': bin(O.eq32); return;
      case 'i32.ne': bin(O.ne32); return;
      case 'i32.lt_s': bin((a, b) => O.cmpS32('lt', a, b)); return;
      case 'i32.lt_u': bin((a, b) => O.cmpU32('lt', a, b)); return;
      case 'i32.gt_s': bin((a, b) => O.cmpS32('gt', a, b)); return;
      case 'i32.gt_u': bin((a, b) => O.cmpU32('gt', a, b)); return;
      case 'i32.le_s': bin((a, b) => O.cmpS32('le', a, b)); return;
      case 'i32.le_u': bin((a, b) => O.cmpU32('le', a, b)); return;
      case 'i32.ge_s': bin((a, b) => O.cmpS32('ge', a, b)); return;
      case 'i32.ge_u': bin((a, b) => O.cmpU32('ge', a, b)); return;
      case 'i32.clz': un(O.clz32); return;
      case 'i32.ctz': un((a) => O.ctz32(a, cx)); return;
      case 'i32.popcnt': un((a) => O.popcnt32(a, cx)); return;
      case 'i32.add': bin(O.add32); return;
      case 'i32.sub': bin(O.sub32); return;
      case 'i32.mul': bin((a, b) => O.mul32(a, b, cx)); return;
      case 'i32.div_s': bin((a, b) => O.divS32(a, b, cx)); return;
      case 'i32.div_u': bin((a, b) => O.divU32(a, b, cx)); return;
      case 'i32.rem_s': bin((a, b) => O.remS32(a, b, cx)); return;
      case 'i32.rem_u': bin((a, b) => O.remU32(a, b, cx)); return;
      case 'i32.and': bin((a, b) => O.and32(a, b, cx)); return;
      case 'i32.or': bin((a, b) => O.or32(a, b, cx)); return;
      case 'i32.xor': bin((a, b) => O.xor32(a, b, cx)); return;
      case 'i32.shl': bin((a, b) => O.shl32(a, b, cx)); return;
      case 'i32.shr_s': bin((a, b) => O.shrS32(a, b, cx)); return;
      case 'i32.shr_u': bin((a, b) => O.shrU32(a, b, cx)); return;
      case 'i32.rotl': bin((a, b) => O.rotl32(a, b, cx)); return;
      case 'i32.rotr': bin((a, b) => O.rotr32(a, b, cx)); return;
      case 'i32.extend8_s': un((a) => O.extendS32(a, 8)); return;
      case 'i32.extend16_s': un((a) => O.extendS32(a, 16)); return;

      // ---- i64 ----
      case 'i64.eqz': un(O.eqz64); return;
      case 'i64.eq': bin(O.eq64); return;
      case 'i64.ne': bin(O.ne64); return;
      case 'i64.lt_s': bin((a, b) => O.cmp64('lt', true, a, b, cx)); return;
      case 'i64.lt_u': bin((a, b) => O.cmp64('lt', false, a, b, cx)); return;
      case 'i64.gt_s': bin((a, b) => O.cmp64('gt', true, a, b, cx)); return;
      case 'i64.gt_u': bin((a, b) => O.cmp64('gt', false, a, b, cx)); return;
      case 'i64.le_s': bin((a, b) => O.cmp64('le', true, a, b, cx)); return;
      case 'i64.le_u': bin((a, b) => O.cmp64('le', false, a, b, cx)); return;
      case 'i64.ge_s': bin((a, b) => O.cmp64('ge', true, a, b, cx)); return;
      case 'i64.ge_u': bin((a, b) => O.cmp64('ge', false, a, b, cx)); return;
      case 'i64.clz': un((a) => {
        const hi = this.dup(a[1]);
        if (isC(hi) && hi.v !== 0) return [O.clz32(hi), num(0)];
        return [A.add(O.clz32(hi), A.mul(A.eq(hi, 0), O.clz32(a[0]))), num(0)];
      }, 'i64'); return;
      case 'i64.ctz': un((a) => {
        const lo = this.dup(a[0]);
        const cl = O.ctz32(lo, cx);
        return [A.add(cl, A.mul(A.eq(lo, 0), O.ctz32(a[1], cx))), num(0)];
      }, 'i64'); return;
      case 'i64.popcnt': un((a) => [A.add(O.popcnt32(a[0], cx), O.popcnt32(a[1], cx)), num(0)], 'i64'); return;
      case 'i64.add': bin((a, b) => O.add64(a, b, cx), 'i64'); return;
      case 'i64.sub': bin((a, b) => O.sub64(a, b, cx), 'i64'); return;
      case 'i64.mul': bin((a, b) => O.mul64(a, b, cx), 'i64'); return;
      case 'i64.div_s': case 'i64.div_u': case 'i64.rem_s': case 'i64.rem_u': {
        const b = this.pop(), a = this.pop();
        const signed = op.endsWith('_s') ? 1 : 0;
        const fast = !signed && isC(a.e[1]) && a.e[1].v === 0 && isC(b.e[1]) && b.e[1].v === 0;
        if (fast && op === 'i64.div_u') { this.push('i64', [O.divU32(a.e[0], b.e[0], cx), num(0)]); return; }
        if (fast && op === 'i64.rem_u') { this.push('i64', [O.remU32(a.e[0], b.e[0], cx), num(0)]); return; }
        this.emit(A.call(this.ctx.rt.use('divmod64'), a.e[0], a.e[1], b.e[0], b.e[1], num(signed)));
        const rv = op.startsWith('i64.div') ? ['r', 'rh'] : ['r2', 'r2h'];
        this.push('i64', [this.setTmp(v(rv[0])), this.setTmp(v(rv[1]))]);
        return;
      }
      case 'i64.and': bin((a, b) => O.and64(a, b, cx), 'i64'); return;
      case 'i64.or': bin((a, b) => O.or64(a, b, cx), 'i64'); return;
      case 'i64.xor': bin((a, b) => O.xor64(a, b, cx), 'i64'); return;
      case 'i64.shl': bin((a, b) => O.shl64(a, b[0], cx), 'i64'); return;
      case 'i64.shr_s': bin((a, b) => O.shrS64(a, b[0], cx), 'i64'); return;
      case 'i64.shr_u': bin((a, b) => O.shrU64(a, b[0], cx), 'i64'); return;
      case 'i64.rotl': bin((a, b) => O.rotl64(a, b[0], cx), 'i64'); return;
      case 'i64.rotr': bin((a, b) => O.rotr64(a, b[0], cx), 'i64'); return;
      case 'i64.extend8_s': un((a) => O.extendS64(a[0], 8, cx), 'i64'); return;
      case 'i64.extend16_s': un((a) => O.extendS64(a[0], 16, cx), 'i64'); return;
      case 'i64.extend32_s': un((a) => O.extendS64(a[0], 32, cx), 'i64'); return;
      case 'i32.wrap_i64': un((a) => a[0]); return;
      case 'i64.extend_i32_s': un((a) => O.extendS64(a, 32, cx), 'i64'); return;
      case 'i64.extend_i32_u': un((a) => [a, num(0)], 'i64'); return;

      default: break;
    }
    if (op.startsWith('f32.') || op.startsWith('f64.')) { this.compileFloatOp(ins); return; }
    if (/^(i32|i64|f32|f64)\.(load|store)/.test(op)) { this.compileMemOp(ins); return; }
    if (op.includes('.trunc') || op.includes('.reinterpret')) { this.compileConvOp(ins); return; }
    throw new Error(`unsupported instruction: ${op}`);
  }

  compileFloatOp(ins) {
    const op = ins.op;
    const ty = op.slice(0, 3);
    const f32 = ty === 'f32';
    const R = (e) => (f32 ? this.fround(e) : e);
    const name = op.slice(4);
    const bin = (fn, rty = ty) => { const b = this.pop(), a = this.pop(); this.push(rty, fn(a.e, b.e)); };
    const un = (fn, rty = ty) => { const a = this.pop(); this.push(rty, fn(a.e)); };
    switch (name) {
      case 'add': bin((a, b) => R(A.add(a, b))); return;
      case 'sub': bin((a, b) => R(A.sub(a, b))); return;
      case 'mul': bin((a, b) => R(A.mul(a, b))); return;
      case 'div': bin((a, b) => R(A.div(a, b))); return;
      case 'sqrt': un((a) => R(A.sqrt(a))); return;
      case 'abs': un((a) => A.abs(a)); return;
      case 'neg': un((a) => (isC(a) ? num(-a.v) : A.mul(a, -1))); return;
      case 'ceil': un((a) => A.ceil(a)); return;
      case 'floor': un((a) => A.floor(a)); return;
      case 'trunc': un((a) => {
        if (isC(a)) return num(Math.trunc(a.v));
        const x = this.dup(a), r = this.newX();
        this.emit(A.iff(A.lt(x, 0), [A.set(r, A.ceil(x))], [A.set(r, A.floor(x))]));
        return v(r);
      }); return;
      case 'nearest': un((a) => this.h1('nearest', a)); return;
      case 'min': bin((a, b) => this.h1('fmin', a, b)); return;
      case 'max': bin((a, b) => this.h1('fmax', a, b)); return;
      case 'copysign': bin((a, b) => this.h1('copysign', a, b)); return;
      case 'eq': bin((a, b) => A.eq(a, b), 'i32'); return;
      case 'ne': bin((a, b) => A.not(A.eq(a, b)), 'i32'); return;
      case 'lt': bin((a, b) => A.lt(a, b), 'i32'); return;
      case 'gt': bin((a, b) => A.gt(a, b), 'i32'); return;
      case 'le': bin((a, b) => A.not(A.gt(a, b)), 'i32'); return;
      case 'ge': bin((a, b) => A.not(A.lt(a, b)), 'i32'); return;
      case 'convert_i32_s': un((a) => R(O.signed32(a))); return;
      case 'convert_i32_u': un((a) => R(a)); return;
      case 'convert_i64_s': un((a) => R(A.add(A.mul(O.signed32(a[1]), U), a[0]))); return;
      case 'convert_i64_u': un((a) => R(A.add(A.mul(a[1], U), a[0]))); return;
      case 'demote_f64': un((a) => this.fround(a)); return;
      case 'promote_f32': un((a) => a); return;
      case 'reinterpret_i32': un((a) => this.h1('f32from', a)); return;
      case 'reinterpret_i64': un((a) => this.h1('f64from', a[0], a[1])); return;
      default: break;
    }
    if (/^(load|store)/.test(name)) { this.compileMemOp(ins); return; }
    throw new Error(`unsupported instruction: ${op}`);
  }

  compileConvOp(ins) {
    const op = ins.op;
    const a = this.pop();
    const m = /^(i32|i64)\.trunc_(sat_)?f(32|64)_([su])$/.exec(op);
    if (m) {
      const [, ity, sat, , sign] = m;
      // + 0 turns a -0 (from truncating values in (-1, 0)) into +0.
      const t = A.add(this.trunc(a.e), 0);
      if (ity === 'i32') {
        let x = t;
        if (sat) x = this.h1('clamp', t, num(sign === 's' ? -2147483648 : 0), num(sign === 's' ? 2147483647 : U - 1));
        this.push('i32', A.mod(x, U));
      } else if (sat) {
        this.push('i64', this.h2(sign === 's' ? 'sat64s' : 'sat64u', t));
      } else {
        const tt = this.setTmp(t);
        this.push('i64', [A.add(A.mod(tt, U), 0), A.mod(A.floor(A.div(tt, U)), U)]);
      }
      return;
    }
    if (op === 'i32.reinterpret_f32') { this.push('i32', this.h1('f32bits', a.e)); return; }
    if (op === 'i64.reinterpret_f64') { this.push('i64', this.h2('f64bits', a.e)); return; }
    throw new Error(`unsupported instruction: ${op}`);
  }

  // ---- memory -----------------------------------------------------------------

  tmpNames() { return { i: this.newX(), k: this.newX(), w: this.newX() }; }

  // Address expression that may be used several times.
  addrReuse(e) { return M.cheap(e) ? e : this.dup(e); }

  load32(ea, align) {
    if (align >= 2) return M.loadWord(ea);
    return this.h1Proc('ldu', ea, num(4));
  }
  h1Proc(name, ...args) {
    this.emit(A.call(this.ctx.rt.use(name), ...args));
    return this.setTmp(v('r'));
  }

  compileMemOp(ins) {
    const op = ins.op;
    const [ty, kind] = op.split('.');
    if (kind.startsWith('load')) {
      const a = this.pop();
      let ea = M.effAddr(a.e, ins.offset);
      const sub = kind.slice(4); // '', '8_s', '8_u', '16_s', '16_u', '32_s', '32_u'
      const bytes = sub ? Number(sub.split('_')[0]) / 8 : ty === 'i64' || ty === 'f64' ? 8 : 4;
      const signed = sub.endsWith('_s');
      if (bytes === 8) {
        let lo, hi;
        if (ins.align >= 2) {
          const idx = this.addrReuse(M.wordIdx(ea));
          lo = A.item(M.MEM, idx);
          hi = A.item(M.MEM, A.add(idx, 1));
        } else {
          ea = this.addrReuse(ea);
          lo = this.h1Proc('ldu', ea, num(4));
          hi = this.h1Proc('ldu', A.add(ea, 4), num(4));
        }
        if (ty === 'f64') this.push('f64', this.h1('f64from', lo, hi));
        else this.push('i64', [lo, hi]);
        return;
      }
      let w;
      if (bytes === 4) w = this.load32(ea, ins.align);
      else if (ins.align >= (bytes === 2 ? 1 : 0)) w = M.loadSub(this.addrReuse(ea), bytes);
      else w = { ...this.h1Proc('ldu', ea, num(bytes)), mask: 65535 };
      if (signed && bytes < 4) w = O.extendS32(w, bytes * 8);
      if (ty === 'f32') this.push('f32', this.h1('f32from', w));
      else if (ty === 'i64') this.push('i64', signed ? O.extendS64(w, bytes * 8, this) : [w, num(0)]);
      else this.push('i32', w);
      return;
    }

    // stores
    const val = this.pop(), a = this.pop();
    this.flushMem();
    let ea = M.effAddr(a.e, ins.offset);
    const sub = kind.slice(5);
    const bytes = sub ? Number(sub) / 8 : ty === 'i64' || ty === 'f64' ? 8 : 4;
    let x = val.e;
    if (ty === 'f32') x = this.h1('f32bits', x);
    if (ty === 'f64') x = this.h2('f64bits', x);
    if (bytes === 8) {
      const [lo, hi0] = x;
      if (ins.align >= 2) {
        const idx = this.addrReuse(M.wordIdx(ea));
        const hi = readsOf('i32', hi0).mem ? this.setTmp(hi0) : hi0;
        this.emit(A.lrep(M.MEM, idx, lo));
        this.emit(A.lrep(M.MEM, A.add(idx, 1), hi));
      } else {
        ea = this.addrReuse(ea);
        const hi = this.dup(hi0);
        this.emit(A.call(this.ctx.rt.use('stu'), ea, lo, num(4)));
        this.emit(A.call(this.ctx.rt.use('stu'), A.add(ea, 4), hi, num(4)));
      }
      return;
    }
    if (ty === 'i64') x = x[0];
    if (bytes === 4) {
      if (ins.align >= 2) this.emit(A.lrep(M.MEM, M.wordIdx(ea), x));
      else this.emit(A.call(this.ctx.rt.use('stu'), ea, x, num(4)));
      return;
    }
    const m = bytes === 1 ? 256 : 65536;
    if (ins.align >= (bytes === 2 ? 1 : 0)) {
      const xv = O.maskOf(x) < m ? x : A.mod(x, m);
      for (const s of M.storeSub(this.addrReuse(ea), xv, bytes, this.tmpNames())) this.emit(s);
    } else {
      this.emit(A.call(this.ctx.rt.use('stu'), ea, x, num(bytes)));
    }
  }
}
