// WebAssembly opcode tables.
//
// Each entry is [name, immediateKind]. Immediate kinds:
//   ''        none
//   'block'   block type (structured control)
//   'label'   label index
//   'table'   br_table vector
//   'func'    function index
//   'calli'   type index + table index
//   'local'   local index
//   'global'  global index
//   'mem'     memarg (align, offset)
//   'memidx'  single reserved byte (memory.size / memory.grow)
//   'i32' 'i64' 'f32' 'f64'  constants
//   'selt'    typed select (vector of value types)
//   'reftype' 'tableidx' and bulk-memory specific kinds

const T = [];
const def = (code, name, imm = '') => { T[code] = [name, imm]; };

def(0x00, 'unreachable');
def(0x01, 'nop');
def(0x02, 'block', 'block');
def(0x03, 'loop', 'block');
def(0x04, 'if', 'block');
def(0x05, 'else');
def(0x0b, 'end');
def(0x0c, 'br', 'label');
def(0x0d, 'br_if', 'label');
def(0x0e, 'br_table', 'table');
def(0x0f, 'return');
def(0x10, 'call', 'func');
def(0x11, 'call_indirect', 'calli');
def(0x12, 'return_call', 'func');
def(0x13, 'return_call_indirect', 'calli');
def(0x1a, 'drop');
def(0x1b, 'select');
def(0x1c, 'select', 'selt');
def(0x20, 'local.get', 'local');
def(0x21, 'local.set', 'local');
def(0x22, 'local.tee', 'local');
def(0x23, 'global.get', 'global');
def(0x24, 'global.set', 'global');
def(0x25, 'table.get', 'tableidx');
def(0x26, 'table.set', 'tableidx');

[
  'i32.load', 'i64.load', 'f32.load', 'f64.load',
  'i32.load8_s', 'i32.load8_u', 'i32.load16_s', 'i32.load16_u',
  'i64.load8_s', 'i64.load8_u', 'i64.load16_s', 'i64.load16_u', 'i64.load32_s', 'i64.load32_u',
  'i32.store', 'i64.store', 'f32.store', 'f64.store',
  'i32.store8', 'i32.store16', 'i64.store8', 'i64.store16', 'i64.store32',
].forEach((n, i) => def(0x28 + i, n, 'mem'));

def(0x3f, 'memory.size', 'memidx');
def(0x40, 'memory.grow', 'memidx');
def(0x41, 'i32.const', 'i32');
def(0x42, 'i64.const', 'i64');
def(0x43, 'f32.const', 'f32');
def(0x44, 'f64.const', 'f64');

[
  'i32.eqz', 'i32.eq', 'i32.ne', 'i32.lt_s', 'i32.lt_u', 'i32.gt_s', 'i32.gt_u', 'i32.le_s', 'i32.le_u', 'i32.ge_s', 'i32.ge_u',
  'i64.eqz', 'i64.eq', 'i64.ne', 'i64.lt_s', 'i64.lt_u', 'i64.gt_s', 'i64.gt_u', 'i64.le_s', 'i64.le_u', 'i64.ge_s', 'i64.ge_u',
  'f32.eq', 'f32.ne', 'f32.lt', 'f32.gt', 'f32.le', 'f32.ge',
  'f64.eq', 'f64.ne', 'f64.lt', 'f64.gt', 'f64.le', 'f64.ge',
  'i32.clz', 'i32.ctz', 'i32.popcnt', 'i32.add', 'i32.sub', 'i32.mul', 'i32.div_s', 'i32.div_u', 'i32.rem_s', 'i32.rem_u',
  'i32.and', 'i32.or', 'i32.xor', 'i32.shl', 'i32.shr_s', 'i32.shr_u', 'i32.rotl', 'i32.rotr',
  'i64.clz', 'i64.ctz', 'i64.popcnt', 'i64.add', 'i64.sub', 'i64.mul', 'i64.div_s', 'i64.div_u', 'i64.rem_s', 'i64.rem_u',
  'i64.and', 'i64.or', 'i64.xor', 'i64.shl', 'i64.shr_s', 'i64.shr_u', 'i64.rotl', 'i64.rotr',
  'f32.abs', 'f32.neg', 'f32.ceil', 'f32.floor', 'f32.trunc', 'f32.nearest', 'f32.sqrt',
  'f32.add', 'f32.sub', 'f32.mul', 'f32.div', 'f32.min', 'f32.max', 'f32.copysign',
  'f64.abs', 'f64.neg', 'f64.ceil', 'f64.floor', 'f64.trunc', 'f64.nearest', 'f64.sqrt',
  'f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.min', 'f64.max', 'f64.copysign',
  'i32.wrap_i64', 'i32.trunc_f32_s', 'i32.trunc_f32_u', 'i32.trunc_f64_s', 'i32.trunc_f64_u',
  'i64.extend_i32_s', 'i64.extend_i32_u', 'i64.trunc_f32_s', 'i64.trunc_f32_u', 'i64.trunc_f64_s', 'i64.trunc_f64_u',
  'f32.convert_i32_s', 'f32.convert_i32_u', 'f32.convert_i64_s', 'f32.convert_i64_u', 'f32.demote_f64',
  'f64.convert_i32_s', 'f64.convert_i32_u', 'f64.convert_i64_s', 'f64.convert_i64_u', 'f64.promote_f32',
  'i32.reinterpret_f32', 'i64.reinterpret_f64', 'f32.reinterpret_i32', 'f64.reinterpret_i64',
  'i32.extend8_s', 'i32.extend16_s', 'i64.extend8_s', 'i64.extend16_s', 'i64.extend32_s',
].forEach((n, i) => def(0x45 + i, n));

def(0xd0, 'ref.null', 'reftype');
def(0xd1, 'ref.is_null');
def(0xd2, 'ref.func', 'func');

// 0xFC-prefixed opcodes.
const FC = [];
const defFC = (code, name, imm = '') => { FC[code] = [name, imm]; };
[
  'i32.trunc_sat_f32_s', 'i32.trunc_sat_f32_u', 'i32.trunc_sat_f64_s', 'i32.trunc_sat_f64_u',
  'i64.trunc_sat_f32_s', 'i64.trunc_sat_f32_u', 'i64.trunc_sat_f64_s', 'i64.trunc_sat_f64_u',
].forEach((n, i) => defFC(i, n));
defFC(8, 'memory.init', 'dataidx_mem');
defFC(9, 'data.drop', 'dataidx');
defFC(10, 'memory.copy', 'mem2');
defFC(11, 'memory.fill', 'memidx');
defFC(12, 'table.init', 'elem_table');
defFC(13, 'elem.drop', 'elemidx');
defFC(14, 'table.copy', 'table2');
defFC(15, 'table.grow', 'tableidx');
defFC(16, 'table.size', 'tableidx');
defFC(17, 'table.fill', 'tableidx');

export const OPCODES = T;
export const OPCODES_FC = FC;
