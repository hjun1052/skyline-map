// Vehicles on the road and the paths they follow, for direction-aware traffic (sim/directional.ts).
// VehicleManager.Data.Serialize and PathManager.Data.Serialize (format 121034). Older formats lay the vehicle
// records out differently: they throw, and traffic stays per segment as before.
import { SaveError, section, endSection, type SaveData } from './reader';

const NV = 16384, NPARKED = 32768, NPATH = 262144;
const SPAWNED = 0x4, WAITING_PATH = 0x100;

export interface SaveVehicles {
  /** SimulationManager.m_currentFrameIndex */
  frame: number;
  /** one entry per spawned road vehicle with a path (trailers and cargo carried on another vehicle left out) */
  n: number;
  path: Uint32Array; pathIndex: Uint8Array; // m_path, m_pathPositionIndex (>> 1 = position in the unit)
  velX: Float32Array; velZ: Float32Array; posX: Float32Array; posZ: Float32Array;
  block: Uint8Array; // m_blockCounter: simulation steps in a row it couldn't move (resets when it moves)
  length: Uint8Array; // metres, a guess from the vehicle type (the save has no sizes)
}
export interface SavePaths {
  /** per path unit: first position in pos*, position count, next unit */
  start: Int32Array; count: Uint8Array; next: Uint32Array;
  posSeg: Uint16Array; posLane: Uint8Array;
}

/** a rough length by vehicle type: buses and coaches, lorries and service trucks, else a car */
const lengthOf = (info: string) => (/bus|coach|tram/i.test(info) ? 12 : /truck|lorry|cargo|garbage|fire|semi|tanker|hearse|post/i.test(info) ? 9 : 5);

export function readVehicles(sd: SaveData): SaveVehicles {
  if (sd.version !== 121034) throw new SaveError('unsupported-version', 'vehicle records of this save format are not read');
  const sm = section(sd, 'SimulationManager');
  if (!sm) throw new SaveError('corrupt', 'no SimulationManager section');
  sm.s.u32(); const frame = sm.s.u32() >>> 0;
  const sec = section(sd, 'VehicleManager');
  if (!sec) throw new SaveError('corrupt', 'no VehicleManager section');
  const { s, end } = sec;
  const flags = s.eaU32(2 * (NV - 1)); // m_flags, then m_flags2
  const parked = s.eaU16(NPARKED - 1);
  const live: number[] = [];
  for (let k = 0; k < NV - 1; k++) if (flags[k]) live.push(k);
  let nParked = 0;
  for (let k = 0; k < NPARKED - 1; k++) if (parked[k]) nParked++;
  const infoIdx = s.eaU16(live.length + nParked);
  const names: (string | null)[] = [];
  for (let k = s.u16(); k > 0; k--) names.push(s.ustr());
  const n = live.length;
  s.eaU8(n); s.eaU16(n); s.eaU8(n); s.eaU8(n); s.eaU16(n); // gate index, race team, teammate, racer index, water source
  const keep: number[] = [];
  const tmp = { path: new Uint32Array(n), pi: new Uint8Array(n), vx: new Float32Array(n), vz: new Float32Array(n), px: new Float32Array(n), pz: new Float32Array(n), block: new Uint8Array(n), len: new Uint8Array(n) };
  const trailers = new Set<number>();
  for (let k = 0; k < n; k++) {
    tmp.vx[k] = s.f32(); s.f32(); tmp.vz[k] = s.f32(); // velocity
    tmp.px[k] = s.f32(); s.f32(); tmp.pz[k] = s.f32(); // position
    s.skip(4 * 4 + 4 + 16 * 4); // rotation, angle velocity, target positions 0-3
    s.skip(2 + 2 + 2 + 2 + 1 + 1); // source/target building, line, transfer size/type, wait counter
    tmp.block[k] = s.u8();
    s.u24(); // citizen units
    tmp.path[k] = s.u24(); tmp.pi[k] = s.u8(); s.u8(); // path, position index, last path offset
    const trailing = s.u16(), cargoParent = s.u16(); s.u16(); // custom
    if (trailing) trailers.add(trailing);
    const f = flags[live[k]];
    if (cargoParent || !(f & SPAWNED) || (f & WAITING_PATH) || !tmp.path[k]) continue;
    const info = names[infoIdx[k]] ?? '';
    if (/bicycle|bike|aircraft|airplane|helicopter|ship|ferry|train|metro|monorail|cable|blimp|balloon|rocket/i.test(info)) continue;
    tmp.len[k] = lengthOf(info);
    keep.push(k);
  }
  for (let k = NPARKED - 1; k > 0; k--) if (parked[k - 1]) { s.skip(12 + 16 + 3); } // parked vehicles: position, rotation, owner
  s.u32(); s.u32(); s.u8(); s.u32(); s.u32(); // traffic flow totals, vehicle counts
  endSection(s, end, 'VehicleManager');
  const ids = keep.filter((k) => !trailers.has(live[k] + 1));
  const pick = <T extends Uint8Array | Uint32Array | Float32Array>(a: T, ctor: new (n: number) => T) => { const o = new ctor(ids.length); ids.forEach((k, i) => (o[i] = a[k])); return o; };
  return { frame, n: ids.length, path: pick(tmp.path, Uint32Array), pathIndex: pick(tmp.pi, Uint8Array), velX: pick(tmp.vx, Float32Array), velZ: pick(tmp.vz, Float32Array),
    posX: pick(tmp.px, Float32Array), posZ: pick(tmp.pz, Float32Array), block: pick(tmp.block, Uint8Array), length: pick(tmp.len, Uint8Array) };
}

export function readPaths(sd: SaveData): SavePaths {
  const sec = section(sd, 'PathManager');
  if (!sec) throw new SaveError('corrupt', 'no PathManager section');
  const { s, end } = sec;
  const used = s.eaU16(NPATH - 1);
  const start = new Int32Array(NPATH).fill(-1), count = new Uint8Array(NPATH), next = new Uint32Array(NPATH);
  const seg: number[] = [], lane: number[] = [];
  for (let u = 1; u < NPATH; u++) {
    if (!used[u - 1]) continue;
    s.u8(); s.u8(); s.u32(); // path-find flags, lane types, vehicle types
    const pc = s.u8(); next[u] = s.u24(); s.u32(); s.f32(); s.u8(); // count, next unit, build index, length, speed
    start[u] = seg.length; count[u] = pc;
    for (let k = 0; k < pc; k++) { seg.push(s.u16()); s.u8(); lane.push(s.u8()); } // segment, offset, lane
  }
  endSection(s, end, 'PathManager');
  return { start, count, next, posSeg: Uint16Array.from(seg), posLane: Uint8Array.from(lane) };
}
