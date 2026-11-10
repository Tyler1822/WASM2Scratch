// Turns the Scratch AST (see ast.js) into the block dictionary of an sb3 target.

import { fold } from './ast.js';

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// Short unique ids. The first character is always a letter so that no id
// looks like an array index (JavaScript orders integer-like keys first, and
// block order matters, see sb3.js).
export function makeIdGen(prefix = '') {
  let n = 0;
  return () => {
    let x = n++;
    let s = ID_CHARS[x % 52];
    x = Math.floor(x / 52);
    while (x > 0) {
      s += ID_CHARS[x % ID_CHARS.length];
      x = Math.floor(x / ID_CHARS.length);
    }
    return prefix + s;
  };
}

export function fmtNum(x) {
  if (Object.is(x, -0)) return '-0';
  return String(x);
}

const BIN_OPS = {
  add: ['operator_add', 'NUM1', 'NUM2', 4],
  sub: ['operator_subtract', 'NUM1', 'NUM2', 4],
  mul: ['operator_multiply', 'NUM1', 'NUM2', 4],
  div: ['operator_divide', 'NUM1', 'NUM2', 4],
  mod: ['operator_mod', 'NUM1', 'NUM2', 4],
  lt: ['operator_lt', 'OPERAND1', 'OPERAND2', 10],
  eq: ['operator_equals', 'OPERAND1', 'OPERAND2', 10],
  gt: ['operator_gt', 'OPERAND1', 'OPERAND2', 10],
  join: ['operator_join', 'STRING1', 'STRING2', 10],
  contains: ['operator_contains', 'STRING1', 'STRING2', 10],
  random: ['operator_random', 'FROM', 'TO', 4],
};

export class BlockWriter {
  // vars / lists: Map from name -> id. Unknown names are registered on demand
  // through the `declareVar` / `declareList` callbacks.
  constructor({ varId, listId }) {
    this.blocks = {};
    this.newId = makeIdGen();
    this.varId = varId;
    this.listId = listId;
    this.blockCount = 0;
  }

  put(id, opcode, parent, extra) {
    const b = { opcode, next: null, parent };
    if (extra) Object.assign(b, extra);
    this.blocks[id] = b;
    this.blockCount++;
    return b;
  }

  // ---- expressions -------------------------------------------------------

  // Encodes an expression as a (numeric/text) input.
  input(e, parent, litType = 4) {
    e = fold(e);
    switch (e.t) {
      case 'n': return [1, [litType, fmtNum(e.v)]];
      case 's': return [1, [10, e.v]];
      case 'v': return [3, [12, e.name, this.varId(e.name)], [litType, litType === 9 ? '#000000' : '']];
      default: return [3, this.expr(e, parent), [litType, litType === 9 ? '#000000' : '']];
    }
  }

  boolInput(e, parent) {
    if (!e.bool) throw new Error(`internal: non-boolean expression in boolean slot: ${JSON.stringify(e).slice(0, 200)}`);
    return [2, this.expr(e, parent)];
  }

  // Emits a reporter block and returns its id.
  expr(e, parent) {
    const id = this.newId();
    switch (e.t) {
      case 'a':
        this.put(id, 'argument_reporter_string_number', parent, { fields: { VALUE: [e.name, null] } });
        break;
      case 'o': {
        const op = e.op;
        if (op === 'and' || op === 'or') {
          this.put(id, op === 'and' ? 'operator_and' : 'operator_or', parent, {
            inputs: { OPERAND1: this.boolInput(e.a, id), OPERAND2: this.boolInput(e.b, id) },
          });
        } else if (op === 'not') {
          this.put(id, 'operator_not', parent, { inputs: { OPERAND: this.boolInput(e.a, id) } });
        } else if (op === 'letter') {
          this.put(id, 'operator_letter_of', parent, { inputs: { LETTER: this.input(e.a, id), STRING: this.input(e.b, id, 10) } });
        } else if (op === 'length') {
          this.put(id, 'operator_length', parent, { inputs: { STRING: this.input(e.a, id, 10) } });
        } else if (op === 'round') {
          this.put(id, 'operator_round', parent, { inputs: { NUM: this.input(e.a, id) } });
        } else {
          const d = BIN_OPS[op];
          if (!d) throw new Error(`internal: unknown operator ${op}`);
          this.put(id, d[0], parent, { inputs: { [d[1]]: this.input(e.a, id, d[3]), [d[2]]: this.input(e.b, id, d[3]) } });
        }
        break;
      }
      case 'm':
        this.put(id, 'operator_mathop', parent, { inputs: { NUM: this.input(e.a, id) }, fields: { OPERATOR: [e.fn, null] } });
        break;
      case 'i':
        this.put(id, 'data_itemoflist', parent, { inputs: { INDEX: this.input(e.a, id, 7) }, fields: { LIST: [e.list, this.listId(e.list)] } });
        break;
      case 'll':
        this.put(id, 'data_lengthoflist', parent, { fields: { LIST: [e.list, this.listId(e.list)] } });
        break;
      case 'in':
        this.put(id, 'data_itemnumoflist', parent, { inputs: { ITEM: this.input(e.a, id, 10) }, fields: { LIST: [e.list, this.listId(e.list)] } });
        break;
      case 'blk': {
        const b = this.put(id, e.opcode, parent, {});
        this.fillGeneric(b, id, e);
        break;
      }
      case 'n': case 's': case 'v':
        throw new Error('internal: literal/variable cannot be emitted as a standalone block');
      default:
        throw new Error(`internal: unknown expression node ${e.t}`);
    }
    return id;
  }

  fillGeneric(b, id, node) {
    const inputs = {};
    let any = false;
    for (const k in node.inputs) {
      const x = node.inputs[k];
      any = true;
      if (x.menu) {
        // Shadow menu block, e.g. {menu:'sensing_keyoptions', field:'KEY_OPTION', value:'space'},
        // optionally covered by a reporter (`expr`).
        const e = x.expr ? fold(x.expr) : null;
        const literal = e && (e.t === 's' || e.t === 'n');
        const mid = this.newId();
        this.put(mid, x.menu, id, { fields: { [x.field]: [literal ? String(e.v) : x.value, null] }, shadow: true });
        if (!e || literal) inputs[k] = [1, mid];
        else if (e.t === 'v') inputs[k] = [3, [12, e.name, this.varId(e.name)], mid];
        else inputs[k] = [3, this.expr(e, id), mid];
      } else if (x.shadow) {
        inputs[k] = this.input(x.expr, id, x.shadow);
      } else if (x.bool && x.t !== 'n') {
        inputs[k] = [2, this.expr(x, id)];
      } else {
        inputs[k] = this.input(x, id, x.t === 's' ? 10 : 4);
      }
    }
    if (any) b.inputs = inputs;
    const fields = {};
    any = false;
    for (const k in node.fields) {
      any = true;
      const f = node.fields[k];
      if (f && typeof f === 'object' && f.list) fields[k] = [f.list, this.listId(f.list)];
      else if (f && typeof f === 'object' && f.var) fields[k] = [f.var, this.varId(f.var)];
      else fields[k] = [f, null];
    }
    if (any) b.fields = fields;
  }

  // ---- statements --------------------------------------------------------

  // Emits a statement list; returns the id of the first block (or null).
  // Very long chains are folded into nested `repeat (1)` blocks, because the
  // VM and editor walk `next` links recursively and overflow on chains of
  // several thousand blocks.
  stmts(list, parent) {
    const CHUNK = 200;
    while (list.length > CHUNK) {
      const out = [];
      for (let i = 0; i < list.length; i += CHUNK) {
        const part = list.slice(i, i + CHUNK);
        if (part.some((s) => s.s === 'stop' && s.what === 'all') || part.length < 4) out.push(...part);
        else out.push({ s: 'repeat', n: { t: 'n', v: 1 }, body: part });
      }
      if (out.length >= list.length) break;
      list = out;
    }
    let first = null, prev = null;
    for (const s of list) {
      const id = this.newId();
      if (prev) this.blocks[prev].next = id; else first = id;
      this.stmt(s, id, prev || parent);
      prev = id;
    }
    return first;
  }

  substack(list, parent) {
    const first = list && list.length ? this.stmts(list, parent) : null;
    return first ? [2, first] : null;
  }

  stmt(s, id, parent) {
    switch (s.s) {
      case 'set':
        this.put(id, 'data_setvariableto', parent, { inputs: { VALUE: this.input(s.v, id, 10) }, fields: { VARIABLE: [s.name, this.varId(s.name)] } });
        break;
      case 'change':
        this.put(id, 'data_changevariableby', parent, { inputs: { VALUE: this.input(s.v, id) }, fields: { VARIABLE: [s.name, this.varId(s.name)] } });
        break;
      case 'ladd':
        this.put(id, 'data_addtolist', parent, { inputs: { ITEM: this.input(s.v, id, 10) }, fields: { LIST: [s.list, this.listId(s.list)] } });
        break;
      case 'ldel':
        this.put(id, 'data_deleteoflist', parent, { inputs: { INDEX: this.input(s.i, id, 7) }, fields: { LIST: [s.list, this.listId(s.list)] } });
        break;
      case 'lclear':
        this.put(id, 'data_deletealloflist', parent, { fields: { LIST: [s.list, this.listId(s.list)] } });
        break;
      case 'lrep':
        this.put(id, 'data_replaceitemoflist', parent, {
          inputs: { INDEX: this.input(s.i, id, 7), ITEM: this.input(s.v, id, 10) },
          fields: { LIST: [s.list, this.listId(s.list)] },
        });
        break;
      case 'lins':
        this.put(id, 'data_insertatlist', parent, {
          inputs: { ITEM: this.input(s.v, id, 10), INDEX: this.input(s.i, id, 7) },
          fields: { LIST: [s.list, this.listId(s.list)] },
        });
        break;
      case 'if': {
        const hasElse = s.b && s.b.length > 0;
        const b = this.put(id, hasElse ? 'control_if_else' : 'control_if', parent, {});
        const inputs = { CONDITION: this.boolInput(s.c, id) };
        const a = this.substack(s.a, id);
        if (a) inputs.SUBSTACK = a;
        if (hasElse) inputs.SUBSTACK2 = this.substack(s.b, id);
        b.inputs = inputs;
        break;
      }
      case 'until': {
        const b = this.put(id, 'control_repeat_until', parent, {});
        const inputs = { CONDITION: this.boolInput(s.c, id) };
        const a = this.substack(s.body, id);
        if (a) inputs.SUBSTACK = a;
        b.inputs = inputs;
        break;
      }
      case 'repeat': {
        const b = this.put(id, 'control_repeat', parent, {});
        const inputs = { TIMES: this.input(s.n, id, 6) };
        const a = this.substack(s.body, id);
        if (a) inputs.SUBSTACK = a;
        b.inputs = inputs;
        break;
      }
      case 'forever': {
        const b = this.put(id, 'control_forever', parent, {});
        const a = this.substack(s.body, id);
        if (a) b.inputs = { SUBSTACK: a };
        break;
      }
      case 'call': {
        const b = this.put(id, 'procedures_call', parent, {});
        const inputs = {};
        const ids = [];
        s.args.forEach((a, i) => {
          const aid = 'a' + i;
          ids.push(aid);
          inputs[aid] = this.input(a, id, 10);
        });
        b.inputs = inputs;
        b.mutation = {
          tagName: 'mutation', children: [],
          proccode: procCode(s.proc, s.args.length),
          argumentids: JSON.stringify(ids),
          warp: 'true',
        };
        break;
      }
      case 'stop':
        this.put(id, 'control_stop', parent, {
          fields: { STOP_OPTION: [s.what, null] },
          mutation: { tagName: 'mutation', children: [], hasnext: 'false' },
        });
        break;
      case 'blk': {
        const b = this.put(id, s.opcode, parent, {});
        this.fillGeneric(b, id, s);
        if (s.substacks) {
          b.inputs = b.inputs || {};
          s.substacks.forEach((ss, i) => {
            const sub = this.substack(ss, id);
            if (sub) b.inputs[i === 0 ? 'SUBSTACK' : 'SUBSTACK' + (i + 1)] = sub;
          });
        }
        break;
      }
      default:
        throw new Error(`internal: unknown statement ${s.s}`);
    }
  }

  // ---- top-level scripts -------------------------------------------------

  // proc: {name, args:[names], warp, body}
  procedure(proc, x = 0, y = 0) {
    const defId = this.newId();
    const protoId = this.newId();
    const def = this.put(defId, 'procedures_definition', null, { inputs: { custom_block: [1, protoId] }, topLevel: true, x, y });
    const inputs = {};
    const ids = [];
    proc.args.forEach((name, i) => {
      const aid = 'a' + i;
      const rid = this.newId();
      ids.push(aid);
      this.put(rid, 'argument_reporter_string_number', protoId, { fields: { VALUE: [name, null] }, shadow: true });
      inputs[aid] = [1, rid];
    });
    this.put(protoId, 'procedures_prototype', defId, {
      inputs, shadow: true,
      mutation: {
        tagName: 'mutation', children: [],
        proccode: procCode(proc.name, proc.args.length),
        argumentids: JSON.stringify(ids),
        argumentnames: JSON.stringify(proc.args),
        argumentdefaults: JSON.stringify(proc.args.map(() => '')),
        warp: proc.warp === false ? 'false' : 'true',
      },
    });
    def.next = this.stmts(proc.body, defId);
  }

  // script: {hat: opcode, body}
  script(hatOpcode, body, x = 0, y = 0) {
    const id = this.newId();
    const hat = this.put(id, hatOpcode, null, { topLevel: true, x, y });
    hat.next = this.stmts(body, id);
  }
}

export function procCode(name, nargs) {
  return name + ' %s'.repeat(nargs);
}
