// Assembles a Scratch 3 project (project.json + assets) and zips it into an .sb3.

import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { BlockWriter, makeIdGen } from './serialize.js';

// ---- minimal zip writer ----------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const comp = deflateRawSync(raw, { level: 9 });
    const useDeflate = comp.length < raw.length;
    const body = useDeflate ? comp : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cenSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

// ---- project assembly ------------------------------------------------------

const BACKDROP_SVG = '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect width="480" height="360" fill="#ffffff"/></svg>';
const SPRITE_SVG = '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="2" height="2" viewBox="0 0 2 2"></svg>';

function asset(svg) {
  const data = Buffer.from(svg, 'utf8');
  const id = createHash('md5').update(data).digest('hex');
  return { id, data, file: `${id}.svg` };
}

// program: {
//   procs:   [{name, args, warp, body}],
//   scripts: [{hat, body}],
//   vars:    Map name -> initial value,
//   lists:   Map name -> array of initial items,
//   monitors: [{list|var, x, y, width, height, visible}],
//   costumes: [names]  (extra costumes for the sprite, all blank)
//   extensions: [ids]
// }
export function buildProject(program) {
  const varIdGen = makeIdGen('v');
  const listIdGen = makeIdGen('l');
  const varIds = new Map();
  const listIds = new Map();
  const vars = program.vars;
  const lists = program.lists;
  const varId = (name) => {
    let id = varIds.get(name);
    if (!id) {
      id = varIdGen();
      varIds.set(name, id);
      if (!vars.has(name)) vars.set(name, 0);
    }
    return id;
  };
  const listId = (name) => {
    let id = listIds.get(name);
    if (!id) {
      id = listIdGen();
      listIds.set(name, id);
      if (!lists.has(name)) lists.set(name, []);
    }
    return id;
  };
  for (const name of vars.keys()) varId(name);
  for (const name of lists.keys()) listId(name);

  const w = new BlockWriter({ varId, listId });
  let y = 0;
  for (const s of program.scripts) { w.script(s.hat, s.body, 0, y); y += 400; }
  let x = 600;
  for (const p of program.procs) { w.procedure(p, x, 0); x += 600; }

  const variables = {};
  for (const [name, id] of varIds) variables[id] = [name, vars.get(name)];
  const listsJson = {};
  for (const [name, id] of listIds) listsJson[id] = [name, lists.get(name)];

  const backdrop = asset(BACKDROP_SVG);
  const costume = asset(SPRITE_SVG);
  const spriteCostumes = [{ name: 'blank', dataFormat: 'svg', assetId: costume.id, md5ext: costume.file, rotationCenterX: 1, rotationCenterY: 1 }];
  for (const name of program.costumes || []) {
    spriteCostumes.push({ name, dataFormat: 'svg', assetId: costume.id, md5ext: costume.file, rotationCenterX: 1, rotationCenterY: 1 });
  }

  const stage = {
    isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {},
    currentCostume: 0,
    costumes: [{ name: 'backdrop1', dataFormat: 'svg', assetId: backdrop.id, md5ext: backdrop.file, rotationCenterX: 240, rotationCenterY: 180 }],
    sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null,
  };
  const sprite = {
    isStage: false, name: program.spriteName || 'WASM', variables, lists: listsJson, broadcasts: {}, blocks: w.blocks, comments: {},
    currentCostume: 0, costumes: spriteCostumes, sounds: [], volume: 100, layerOrder: 1,
    visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
  };

  const monitors = [];
  for (const m of program.monitors || []) {
    if (m.list) {
      monitors.push({
        id: listId(m.list), mode: 'list', opcode: 'data_listcontents', params: { LIST: m.list }, spriteName: sprite.name,
        value: [], width: m.width ?? 480, height: m.height ?? 360, x: m.x ?? 0, y: m.y ?? 0, visible: m.visible ?? true,
      });
    } else {
      monitors.push({
        id: varId(m.var), mode: m.mode || 'default', opcode: 'data_variable', params: { VARIABLE: m.var }, spriteName: sprite.name,
        value: 0, width: 0, height: 0, x: m.x ?? 5, y: m.y ?? 5, visible: m.visible ?? true,
        sliderMin: 0, sliderMax: 100, isDiscrete: true,
      });
    }
  }

  const project = {
    targets: [stage, sprite],
    monitors,
    extensions: program.extensions || [],
    meta: { semver: '3.0.0', vm: '0.2.0', agent: 'wasm2sb3' },
  };
  const json = JSON.stringify(project);
  const files = [{ name: 'project.json', data: Buffer.from(json, 'utf8') }, { name: backdrop.file, data: backdrop.data }];
  if (costume.file !== backdrop.file) files.push({ name: costume.file, data: costume.data });
  return {
    sb3: zip(files),
    json,
    stats: { blocks: w.blockCount, variables: varIds.size, lists: listIds.size, jsonBytes: Buffer.byteLength(json) },
  };
}
