// Whole-module and per-function analyses that run before code generation.

export const sigKey = (t) => `${t.params.join(',')}->${t.results.join(',')}`;

// ---- call graph / recursion ------------------------------------------------

// Returns { scc: Int32Array (component id per function), recursive: Uint8Array,
//           tableFuncsBySig: Map sigKey -> [funcIdx] }.
export function analyzeCallGraph(mod) {
  const n = mod.funcs.length;
  const tableFuncsBySig = new Map();
  const seen = new Set();
  for (const el of mod.elems) {
    for (const f of el.funcs) {
      if (f === null || f === undefined || seen.has(f)) continue;
      seen.add(f);
      const key = sigKey(mod.funcs[f].type);
      if (!tableFuncsBySig.has(key)) tableFuncsBySig.set(key, []);
      tableFuncsBySig.get(key).push(f);
    }
  }

  const edges = new Array(n);
  const throws = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const f = mod.funcs[i];
    const out = new Set();
    if (f.body) {
      const walk = (instrs) => {
        for (const ins of instrs) {
          switch (ins.op) {
            case 'call': case 'return_call': out.add(ins.func); break;
            case 'call_indirect': case 'return_call_indirect':
              for (const g of tableFuncsBySig.get(sigKey(mod.types[ins.type])) || []) out.add(g);
              break;
            case 'block': case 'loop': walk(ins.body); break;
            case 'if': walk(ins.then); if (ins.else) walk(ins.else); break;
            case 'try':
              walk(ins.body);
              for (const c of ins.catches) walk(c.body);
              if (ins.catchAll) walk(ins.catchAll);
              break;
            case 'throw': case 'rethrow': throws[i] = 1; break;
            default: break;
          }
        }
      };
      walk(f.body);
    }
    edges[i] = [...out];
  }

  // A function may throw if it throws itself or calls something that may.
  // (Conservative: catching is ignored.)
  const mayThrow = throws.slice();
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (mayThrow[i]) continue;
      if (edges[i].some((g) => mayThrow[g])) { mayThrow[i] = 1; changed = true; }
    }
  }

  // Iterative Tarjan SCC.
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const scc = new Int32Array(n).fill(-1);
  const sccSize = [];
  const stack = [];
  let counter = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work = [[root, 0]];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    while (work.length) {
      const top = work[work.length - 1];
      const [v, ei] = top;
      if (ei < edges[v].length) {
        top[1]++;
        const w = edges[v][ei];
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w]);
        }
      } else {
        work.pop();
        if (work.length) {
          const p = work[work.length - 1][0];
          low[p] = Math.min(low[p], low[v]);
        }
        if (low[v] === index[v]) {
          const id = sccSize.length;
          let size = 0, w;
          do {
            w = stack.pop();
            onStack[w] = 0;
            scc[w] = id;
            size++;
          } while (w !== v);
          sccSize.push(size);
        }
      }
    }
  }
  const recursive = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (sccSize[scc[i]] > 1 || edges[i].includes(i)) recursive[i] = 1;
  }
  return { scc, recursive, tableFuncsBySig, edges, mayThrow };
}

// ---- per-function structure info -------------------------------------------

// Annotates loops with `selfBr` (branches targeting the loop) and `escapes`
// (branches leaving the loop for an outer label other than the function
// itself), and collects the set of locals that are ever assigned.
export function analyzeStructure(func) {
  const written = new Set();
  const ctl = [{ kind: 'func' }];
  const branch = (depth) => {
    const ti = ctl.length - 1 - depth;
    const target = ctl[ti];
    if (!target) throw new Error('branch depth out of range');
    if (target.ins) target.ins.selfBr = (target.ins.selfBr || 0) + 1;
    if (ti === 0) return; // return: never needs a flag
    for (let i = ti + 1; i < ctl.length; i++) {
      if (ctl[i].kind === 'loop') ctl[i].ins.escapes++;
    }
  };
  const walk = (instrs) => {
    for (const ins of instrs) {
      switch (ins.op) {
        case 'local.set': case 'local.tee': written.add(ins.idx); break;
        case 'br': case 'br_if': branch(ins.depth); break;
        case 'br_table': {
          for (const d of new Set([...ins.targets, ins.default])) branch(d);
          break;
        }
        case 'block':
          ins.selfBr = 0;
          ctl.push({ kind: 'block', ins });
          walk(ins.body);
          ctl.pop();
          break;
        case 'loop':
          ins.selfBr = 0;
          ins.escapes = 0;
          ctl.push({ kind: 'loop', ins });
          walk(ins.body);
          ctl.pop();
          break;
        case 'if':
          ins.selfBr = 0;
          ctl.push({ kind: 'block', ins });
          walk(ins.then);
          if (ins.else) walk(ins.else);
          ctl.pop();
          break;
        case 'try':
          ins.selfBr = 0;
          ctl.push({ kind: 'block', ins });
          walk(ins.body);
          for (const c of ins.catches) walk(c.body);
          if (ins.catchAll) walk(ins.catchAll);
          ctl.pop();
          break;
        default: break;
      }
    }
  };
  walk(func.body);
  return { written };
}

// ---- liveness of locals ----------------------------------------------------

class Bits {
  constructor(n, words) { this.n = n; this.w = words || new Uint32Array((n + 31) >>> 5); }
  clone() { return new Bits(this.n, this.w.slice()); }
  set(i) { this.w[i >>> 5] |= 1 << (i & 31); }
  clear(i) { this.w[i >>> 5] &= ~(1 << (i & 31)); }
  has(i) { return (this.w[i >>> 5] >>> (i & 31)) & 1; }
  // this |= o; returns true if anything changed.
  or(o) {
    let changed = false;
    const a = this.w, b = o.w;
    for (let i = 0; i < a.length; i++) {
      const x = (a[i] | b[i]) >>> 0;
      if (x !== a[i]) { a[i] = x; changed = true; }
    }
    return changed;
  }
  assign(o) { this.w.set(o.w); }
  zero() { this.w.fill(0); }
  toArray() {
    const out = [];
    for (let i = 0; i < this.n; i++) if (this.has(i)) out.push(i);
    return out;
  }
}

// Backward liveness over the structured instruction tree.
//  * every call instruction gets `ins.liveAfter` (array of local indices live
//    right after the call) when `annotateCalls` is set
//  * returns the array of locals live on entry (these need initialising)
// Loop-head sets persist across whole-function passes, which repeat until no
// head set changes; each pass is linear, so deep loop nests stay cheap.
export function analyzeLiveness(func, numLocals, annotateCalls) {
  const heads = new Map(); // loop instruction -> Bits live at its head
  let changed = true;
  let annotate = false;
  const labels = [];
  const exn = []; // stack: locals live on entry to the innermost exception handler
  const seq = (instrs, live) => {
    for (let i = instrs.length - 1; i >= 0; i--) {
      const ins = instrs[i];
      switch (ins.op) {
        case 'local.get': live.set(ins.idx); break;
        case 'local.set': case 'local.tee': live.clear(ins.idx); break;
        case 'call': case 'call_indirect':
          // A call inside `try` may continue in a catch handler.
          if (exn.length) live.or(exn[exn.length - 1]);
          if (annotate) ins.liveAfter = live.toArray();
          break;
        case 'throw': case 'rethrow':
          if (exn.length) live.assign(exn[exn.length - 1]); else live.zero();
          break;
        case 'try': {
          const after = live.clone();
          // Any enclosing handler may receive what escapes (delegate can skip levels).
          const outer = new Bits(numLocals);
          for (const e of exn) outer.or(e);
          // Locals live on entry to any handler.
          const handler = new Bits(numLocals);
          if (ins.delegate !== null) {
            handler.or(outer);
          } else {
            labels.push(after);
            for (const body of [...ins.catches.map((c) => c.body), ...(ins.catchAll ? [ins.catchAll] : [])]) {
              const h = after.clone();
              seq(body, h);
              handler.or(h);
            }
            labels.pop();
            if (!ins.catchAll) handler.or(outer);
          }
          labels.push(after);
          exn.push(handler);
          seq(ins.body, live);
          exn.pop();
          labels.pop();
          break;
        }
        case 'return_call': case 'return_call_indirect':
          live.zero();
          if (annotate) ins.liveAfter = [];
          break;
        case 'block':
          labels.push(live.clone());
          seq(ins.body, live);
          labels.pop();
          break;
        case 'loop': {
          let head = heads.get(ins);
          if (!head) { head = new Bits(numLocals); heads.set(ins, head); }
          labels.push(head);
          seq(ins.body, live);
          labels.pop();
          if (head.or(live)) changed = true;
          break;
        }
        case 'if': {
          labels.push(live.clone());
          const e = live.clone();
          seq(ins.then, live);
          if (ins.else) seq(ins.else, e);
          labels.pop();
          live.or(e);
          break;
        }
        case 'br': live.assign(labels[labels.length - 1 - ins.depth]); break;
        case 'br_if': live.or(labels[labels.length - 1 - ins.depth]); break;
        case 'br_table': {
          live.zero();
          for (const d of ins.targets) live.or(labels[labels.length - 1 - d]);
          live.or(labels[labels.length - 1 - ins.default]);
          break;
        }
        case 'return': case 'unreachable': live.zero(); break;
        default: break;
      }
    }
  };
  let live;
  for (;;) {
    changed = false;
    live = new Bits(numLocals);
    labels.length = 0;
    labels.push(new Bits(numLocals)); // function label: nothing is live after return
    seq(func.body, live);
    if (!changed) {
      if (annotateCalls && !annotate) { annotate = true; continue; }
      break;
    }
  }
  return live.toArray();
}
