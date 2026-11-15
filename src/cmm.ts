// Reader for `.cmm` / `.cmm.gz`, the city document written by the CSLModernMap mod (Steam Workshop 3781187198).
// Format: one JSON object, `schema_version: "cmm-v1"`, gzip-compressed for `.cmm.gz`. There is no published spec;
// what each field means was read from the mod's exporter (CmmMapper, RoadGeometry.Facts, CSLModernMapExporter, v6.7.3f1)
// and checked against a .cslmap of the same city (docs/research/cmm-format.md, `npm run check:cmm`).
//
// The file is mapped onto the same CityData a .cslmap gives, so everything downstream works unchanged:
//  - ids are the game's own (nodes, segments, buildings, lines, districts), as in a .cslmap;
//  - road and path networks carry their prefab name, so their lanes come from the lane catalogue (src/lane-catalog.json,
//    built from real .cslmap exports), but only after the file confirms them: the mod writes, per segment, how many
//    lanes carry cars, in which directions, and which directions cars may drive. A catalogue entry is used for a prefab
//    only when its lanes give exactly those facts on every segment of that prefab. Otherwise (unknown or modified
//    prefab) the lanes are built from the file's facts alone: car lanes and nothing else (see factsType);
//  - one-way directions and speed limits are exact: the mod applies the game's per-segment Invert flag and reads the
//    effective limit (TM:PE-aware) per direction; a .cslmap has neither, so it infers one-way directions (oneway.ts);
//  - transit legs: each line's stop-to-stop segment carries the path vehicles drive (segment ids), as in a .cslmap.
//    The mod leaves it out where the path runs on a network it doesn't export with the expected kind (ferry paths,
//    walking tours, ship and airplane lanes). Legs on networks the file does have are rebuilt (rebuildLegs) and marked
//    as estimated (`extras.inferredLegs`); the rest are left without a path, as a .cslmap leaves a line it has no path for;
//  - the game's own district and park grids give exact district boundaries;
//  - automatic street names (the game's generated names) are used where the player gave none; a .cslmap has only the
//    player's names.
import type { CityData, CNode, CSeg, CBuilding, CArea, CTransport, CSegType, CLane, Vec3 } from './parse';
import type { LaneCatalog } from './lane-infer';
import type { OneWayResult } from './oneway';
import { FormatError, areaAt } from './vellummap';

// i18n-keys: reading errors, shown translated by the page
void ['This .cmm is damaged: {detail}', 'This .cmm uses format {version}, which Skyline Map does not read yet. It reads cmm-v1.'];
// end i18n-keys
const damaged = (detail: string) => new FormatError('This .cmm is damaged: {detail}', { detail });

/** JSON whose first key is the cmm schema version (the mod writes it first); a .cslmap starts with `<` */
export function isCmm(b: Uint8Array): boolean {
  let i = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0x09)) i++;
  if (b[i] !== 0x7b) return false;
  return /^\{\s*"schema_version"\s*:\s*"cmm-/.test(new TextDecoder().decode(b.subarray(i, i + 64)));
}

// shape checks: a bad value is a "damaged" message, never a crash or a NaN on the map
const list = (o: any, key: string, where: string): any[] => { const v = o?.[key]; if (!Array.isArray(v)) throw damaged(`${where}: ${key} is not a list`); return v; };
const num = (v: unknown, where: string): number => { if (typeof v !== 'number' || !Number.isFinite(v)) throw damaged(`${where}: not a number`); return v; };
const sid = (v: unknown, where: string): number => { if (!Number.isSafeInteger(v)) throw damaged(`${where}: bad id`); return v as number; };
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const vec3 = (p: any, where: string): Vec3 => { if (!Array.isArray(p) || p.length < 3) throw damaged(`${where}: bad point`); return { x: num(p[0], where), y: num(p[1], where), z: num(p[2], where) }; };
const xz = (p: any, where: string): [number, number] => { if (!Array.isArray(p) || p.length < 2) throw damaged(`${where}: bad point`); return [num(p[0], where), num(p[1], where)]; };

const T = 1081, CELL = 15.985198889916743, A = 900;

/** The file as a JSON object, with two parts taken out before JSON.parse, as they'd be most of the memory it needs:
 *  - each district's `grid_points` (a [x, z] pair per 19.2 m cell, every cell of the map at least once: 1.6 million
 *    small arrays for a full city, over 100 MB parsed). Each is read here into a Float64Array (x, z, x, z…) and the
 *    list in the document is replaced by its index into `grids`;
 *  - the top-level `traffic` (a TM:PE snapshot, which nothing reads yet: see docs/research/cmm-format.md), replaced by null.
 *  One pass over the bytes, aware of strings, so a name that says "grid_points" is left alone. */
export function parseDoc(b: Uint8Array): { d: any; grids: Float64Array[] } {
  const grids: Float64Array[] = [], cuts: [number, number, string][] = [];
  const n = b.length, ws = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;
  const is = (s: number, e: number, key: string) => { if (e - s !== key.length) return false; for (let k = 0; k < key.length; k++) if (b[s + k] !== key.charCodeAt(k)) return false; return true; };
  let depth = 0, i = 0;
  while (i < n) {
    const c = b[i];
    if (c !== 34) { if (c === 123 || c === 91) depth++; else if (c === 125 || c === 93) depth--; i++; continue; }
    const s = ++i;
    while (i < n && b[i] !== 34) i += b[i] === 92 ? 2 : 1;
    const e = i++;
    let v = i; while (ws(b[v])) v++;
    if (b[v] !== 58) continue; // a value, not a key
    v++; while (ws(b[v])) v++;
    if (b[v] === 91 && is(s, e, 'grid_points')) {
      const xs: number[] = [];
      let p = v + 1, level = 1, pairs = 0;
      while (level > 0) {
        if (p >= n) throw damaged('district cells are cut off');
        const ch = b[p];
        if (ch === 91) { if (++level > 2) throw damaged('district cells are not [x, z] pairs'); pairs++; p++; } else if (ch === 93) { level--; p++; } else if (ch === 44 || ws(ch)) p++;
        else {
          // a JSON number: integer mantissa, then the decimal point and exponent applied once (exact for these values)
          const neg = ch === 45; if (neg) p++;
          let m = 0, scale = 0, digits = 0;
          while (b[p] >= 48 && b[p] <= 57) { m = m * 10 + b[p++] - 48; digits++; }
          if (b[p] === 46) { p++; while (b[p] >= 48 && b[p] <= 57) { m = m * 10 + b[p++] - 48; scale++; digits++; } }
          if (b[p] === 101 || b[p] === 69) { p++; const es = b[p] === 45 ? -1 : 1; if (b[p] === 45 || b[p] === 43) p++; let x = 0; while (b[p] >= 48 && b[p] <= 57) x = x * 10 + b[p++] - 48; scale -= es * x; }
          if (!digits) throw damaged('district cells are not numbers');
          const val = scale > 0 ? m / 10 ** scale : m * 10 ** -scale;
          xs.push(neg ? -val : val);
        }
      }
      if (xs.length !== pairs * 2) throw damaged('district cells are not [x, z] pairs');
      cuts.push([v, p, String(grids.length)]); grids.push(Float64Array.from(xs));
      i = p;
    } else if (depth === 1 && is(s, e, 'traffic')) {
      let p = v, level = 0;
      do {
        if (p >= n) break;
        const ch = b[p];
        if (ch === 34) { p++; while (p < n && b[p] !== 34) p += b[p] === 92 ? 2 : 1; } else if (ch === 123 || ch === 91) level++; else if (ch === 125 || ch === 93) level--;
        p++;
      } while (level > 0);
      cuts.push([v, p, 'null']); i = p;
    }
  }
  let size = n; for (const [s, e, r] of cuts) size += r.length - (e - s);
  const out = new Uint8Array(size);
  let o = 0, from = 0;
  for (const [s, e, r] of cuts) { out.set(b.subarray(from, s), o); o += s - from; for (let k = 0; k < r.length; k++) out[o++] = r.charCodeAt(k); from = e; }
  out.set(b.subarray(from), o);
  try { return { d: JSON.parse(new TextDecoder('utf-8').decode(out)), grids }; } catch { throw damaged('not valid JSON'); }
}

/** a terrain grid: base64 of zlib-compressed little-endian float32, row-major, rows north (+z), metres */
async function grid(g: any, where: string): Promise<Float32Array | null> {
  if (!g || g.data == null) return null;
  if (g.encoding !== 'base64+zlib+float32-row-major' || g.rows !== T || g.cols !== T || Math.abs(g.cell - CELL) > 1e-6) throw damaged(`${where}: unknown grid layout`);
  let raw: Uint8Array;
  try { raw = Uint8Array.from(atob(str(g.data)), (c) => c.charCodeAt(0)); } catch { throw damaged(`${where}: not base64`); }
  const want = T * T * 4, out = new Uint8Array(want);
  let n = 0;
  const reader = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.length > want) { await reader.cancel().catch(() => {}); throw damaged(`${where}: larger than its size`); }
      out.set(value, n); n += value.length;
    }
  } catch (err) { if (err instanceof FormatError) throw err; throw damaged(`${where}: cannot be decompressed`); }
  if (n !== want) throw damaged(`${where}: wrong size`);
  const dv = new DataView(out.buffer), f = new Float32Array(T * T);
  for (let i = 0; i < f.length; i++) { const v = dv.getFloat32(i * 4, true); f[i] = Number.isFinite(v) ? v : 0; }
  return f;
}

// ------------------------------------------------------------------ lanes, checked against the file's facts

/** NetInfo.Direction: Forward 1, Backward 2, Both 3; every Avoid* value has both bits (AvoidBackward 7, AvoidForward 11, AvoidBoth 15) */
const dirBits = (d: string) => (d === 'Forward' ? 1 : d === 'Backward' ? 2 : d === 'Both' || d.startsWith('Avoid') ? 3 : 0);
const flags = (s: string) => s.split(',').map((x) => x.trim());

/** what the mod writes for a lane table (RoadGeometry.Facts), prefab-relative: car-carrying lanes, their directions,
 *  and which directions general (non-transit) car lanes allow */
export function laneFacts(lanes: CLane[]) {
  let count = 0, dir = 0, car = 0;
  for (const l of lanes) {
    const t = flags(l.type), v = flags(l.vType), b = dirBits(l.dir);
    if (!(t.includes('Vehicle') || t.includes('TransportVehicle')) || !v.includes('Car') || !b) continue;
    count++; dir |= b;
    if (t.includes('Vehicle')) car |= b;
  }
  return { count, dir, car };
}

/** the same facts as the file states them for one segment, turned back to prefab-relative (the mod applied Invert) */
function fileFacts(w: any, invert: boolean) {
  const ls = w.lane_summary ?? {}, ca = w.car_access ?? {};
  const d = num(ls.direction ?? 0, `network ${w.id} direction`), ok = (s: unknown) => s === 'allowed';
  let dir = ls.car_lane_count > 0 ? (d === 1 ? 1 : d === -1 ? 2 : 3) : 0;
  let car = (ok(ca.forward) ? 1 : 0) | (ok(ca.backward) ? 2 : 0);
  const swap = (x: number) => ((x & 1) << 1) | ((x & 2) >> 1);
  if (invert) { dir = swap(dir); car = swap(car); }
  return { count: num(ls.car_lane_count ?? 0, `network ${w.id} lanes`), dir, car };
}
const sameFacts = (a: ReturnType<typeof laneFacts>, b: ReturnType<typeof laneFacts>) => a.count === b.count && a.dir === b.dir && a.car === b.car;

/**
 * Lanes from the file's facts alone, for a prefab the catalogue doesn't know (or knows differently): the car-carrying
 * lanes, as many as the file counts, each allowed in the directions the file allows (a two-way road gets lanes open both
 * ways, since the file doesn't say how many lanes go each way), at the file's speed. Nothing else is invented: no
 * sidewalks or bike lanes on roads. A path network (BEAUTIFICATION: the mod's kind for a network with a pedestrian or
 * bicycle lane and no car lanes) gets one pedestrian lane, so walking routes don't break at an unknown path.
 */
function factsType(name: string, w: any, f: ReturnType<typeof laneFacts>, speed: number): CSegType {
  const lanes: CLane[] = [];
  const d = (b: number) => (b === 1 ? 'Forward' : b === 2 ? 'Backward' : b === 3 ? 'Both' : 'None');
  const transitOnly = f.count > 0 && !f.car;
  for (let i = 0; i < f.count; i++) lanes.push({ type: transitOnly ? 'TransportVehicle' : 'Vehicle', vType: 'Car', dir: d(f.car || f.dir), pos: 0, width: 3, speed: speed / 13.888889 });
  if (w.kind === 'BEAUTIFICATION' && !f.count) lanes.push({ type: 'Pedestrian', vType: 'None', dir: 'Both', pos: 0, width: 2, speed: 0.25 });
  return { name, highway: w.level === 'HIGHWAY', lanes };
}

// ------------------------------------------------------------------ transit legs the file leaves without a path

/** the lanes a line's vehicles use, by the line network's transit kind (null: networks the mod doesn't export) */
const LEG_LANES: Record<string, ((l: CLane) => boolean) | null> = {
  BUS: (l) => /Vehicle/.test(l.type) && flags(l.vType).includes('Car'),
  TROLLEYBUS: (l) => flags(l.vType).includes('Trolleybus'),
  TRAM: (l) => flags(l.vType).includes('Tram'),
  TRAIN: (l) => flags(l.vType).includes('Train'),
  METRO: (l) => flags(l.vType).includes('Metro'),
  MONORAIL: (l) => flags(l.vType).includes('Monorail'),
  CABLECAR: (l) => flags(l.vType).includes('CableCar'),
  FERRY: (l) => flags(l.vType).includes('Ferry'),
  TOUR: (l) => /Pedestrian/.test(l.type),
  // ship and airplane lanes (Ship Path, Airplane Path) and outside connections are not in the file
  SHIP: null, AIRPLANE: null, HELICOPTER: null,
};
/** walking tours use paths both ways; vehicles keep to their lanes' directions */
const ANY_DIRECTION = new Set(['TOUR']);
/**
 * Kinds whose rebuilt legs are used on the map and in directions: the ones where the shortest path along their lanes
 * reproduced the game's own paths (matched .cslmap, and exported legs hidden then rebuilt; `npm run check:cmm`):
 * ferries 17/19 identical, walking tours 23/25, metro 57/59, cable cars 10/10. Buses (74% identical: drivers weigh
 * speed, lanes and traffic, not just distance) and trains (64%: the game's track choice at junctions) are not, nor are
 * kinds there was nothing to test with (tram, monorail, trolleybus): their legs without a path stay without one.
 */
export const REBUILD = new Set(['FERRY', 'TOUR', 'METRO', 'CABLECAR']);
/** outside connections sit at the map's edge; the segments that reach them (Transport Connection) are not in the file */
const atEdge = (p: Vec3) => Math.max(Math.abs(p.x), Math.abs(p.z)) > 8640 - 200;

const segLen = (pts: Vec3[]) => { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); return l; };
function distTo(p: Vec3, pts: Vec3[]) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.z + t * dz - p.z));
  }
  return best;
}

/** acceptance: a stop must lie on its network (lane offsets plus curve sampling) and the path must not wander */
export const LEG = { snap: 24, detour: 4 };

export interface LegResult { path: number[] | null; why?: 'no network' | 'stop off network' | 'no path' | 'detour' | 'outside connection' | 'not validated'; len?: number }

/**
 * The path a line's vehicles most likely drive between two stops: the shortest one along the lanes their vehicles use
 * (in the lanes' directions, Invert applied), from the segment the first stop is on to the one the second stop is on.
 * Same shape as an exported path: segment ids, starting and ending with the stops' own segments.
 */
export function rebuildLeg(city: Pick<CityData, 'nodes' | 'segs' | 'segTypes'>, invert: Set<number>, kind: string, a: Vec3, b: Vec3, ctx = legContext(city, invert, kind)): LegResult {
  if (!ctx) return { path: null, why: 'no network' };
  if (atEdge(a) || atEdge(b)) return { path: null, why: 'outside connection' };
  const near = (p: Vec3) => { let best: { s: CSeg; d: number } | null = null; for (const s of ctx.segs) { const d = distTo(p, s.pts); if (!best || d < best.d) best = { s, d }; } return best && best.d <= LEG.snap ? best.s : null; };
  const s0 = near(a), s1 = near(b);
  if (!s0 || !s1) return { path: null, why: 'stop off network' };
  if (s0 === s1) return { path: [s0.id], len: Math.hypot(b.x - a.x, b.z - a.z) };
  // Dijkstra over nodes: leave s0 by an end it may be driven towards, arrive at s1 through an end it may be driven from
  const dist = new Map<number, number>(), prev = new Map<number, { node: number; seg: number }>();
  const heap: [number, number][] = [];
  const push = (n: number, d: number) => { heap.push([d, n]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const ways = (s: CSeg) => ctx.ways.get(s.id)!; // bit 1: sn→en, bit 2: en→sn
  for (const [bit, end] of [[1, s0.en], [2, s0.sn]] as const) if (ways(s0) & bit) { dist.set(end, 0); push(end, 0); }
  const goal = new Map<number, number>(); // node → s1 enterable from it
  if (ways(s1) & 1) goal.set(s1.sn, 1);
  if (ways(s1) & 2) goal.set(s1.en, 1);
  let hit = -1;
  while (heap.length) {
    const [d, n] = pop();
    if (d > (dist.get(n) ?? Infinity)) continue;
    if (goal.has(n)) { hit = n; break; }
    for (const s of ctx.adj.get(n) ?? []) {
      if (s === s1 || s === s0) continue;
      const w = ways(s), fwd = s.sn === n;
      if (!(w & (fwd ? 1 : 2))) continue;
      const m = fwd ? s.en : s.sn, nd = d + ctx.len.get(s.id)!;
      if (nd < (dist.get(m) ?? Infinity)) { dist.set(m, nd); prev.set(m, { node: n, seg: s.id }); push(m, nd); }
    }
  }
  if (hit < 0) return { path: null, why: 'no path' };
  const mid: number[] = [];
  for (let n = hit; prev.has(n); n = prev.get(n)!.node) mid.push(prev.get(n)!.seg);
  const len = dist.get(hit)! + (ctx.len.get(s0.id)! + ctx.len.get(s1.id)!) / 2;
  if (len > LEG.detour * Math.max(50, Math.hypot(b.x - a.x, b.z - a.z))) return { path: null, why: 'detour', len };
  return { path: [s0.id, ...mid.reverse(), s1.id], len };
}

/** the network one transit kind can use: its segments, their allowed directions, lengths and node adjacency */
export function legContext(city: Pick<CityData, 'nodes' | 'segs' | 'segTypes'>, invert: Set<number>, kind: string) {
  const uses = LEG_LANES[kind];
  if (!uses) return null;
  const segs: CSeg[] = [], ways = new Map<number, number>(), len = new Map<number, number>(), adj = new Map<number, CSeg[]>();
  for (const s of city.segs) {
    if (s.path || s.pts.length < 2 || !city.nodes.has(s.sn) || !city.nodes.has(s.en)) continue;
    const lanes = (city.segTypes.get(s.name)?.lanes ?? []).filter(uses);
    if (!lanes.length) continue;
    let w = ANY_DIRECTION.has(kind) ? 3 : lanes.reduce((m, l) => m | dirBits(l.dir), 0);
    if (invert.has(s.id)) w = ((w & 1) << 1) | ((w & 2) >> 1);
    if (!w) continue;
    segs.push(s); ways.set(s.id, w); len.set(s.id, segLen(s.pts));
    for (const n of [s.sn, s.en]) (adj.get(n) ?? adj.set(n, []).get(n)!).push(s);
  }
  return segs.length ? { segs, ways, len, adj } : null;
}

// ------------------------------------------------------------------ mapping onto CityData

export interface CmmInfo {
  /** road and path segments by where their lanes come from */
  lanes: { catalogue: number; facts: number; none: number };
  /** prefabs whose catalogue lanes disagreed with the file (their segments use the file's facts) */
  conflicts: string[];
  /** transit legs: exported path, rebuilt from the network (estimated), or none */
  legs: { exported: number; rebuilt: number; none: number; why: Record<string, number> };
  issues: Record<string, number>;
}

export async function readCmm(bytes: Uint8Array, cat: LaneCatalog): Promise<CityData> {
  const { d, grids } = parseDoc(bytes);
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw damaged('not a JSON object');
  const ver = str(d.schema_version);
  if (ver !== 'cmm-v1') {
    if (/^cmm-/.test(ver)) throw new FormatError('This .cmm uses format {version}, which Skyline Map does not read yet. It reads cmm-v1.', { version: ver });
    throw damaged('missing format version');
  }
  if (d.metadata?.origin?.game !== undefined && d.metadata.origin.game !== 'cs1') throw damaged(`a ${str(d.metadata.origin.game)} city, not Cities: Skylines`);

  const seaLevel = typeof d.sea_level === 'number' && Number.isFinite(d.sea_level) ? d.sea_level : 0;
  const height = (await grid(d.terrain?.height, 'terrain height')) ?? new Float32Array(T * T);
  const water = (await grid(d.terrain?.water_depth, 'water depth')) ?? new Float32Array(T * T);
  /** terrain height at a point (nearest sample), for things the file places in 2D. The samples are 16 m apart, corner to
   *  corner (17280 m / 1080), as for a .cslmap (build.ts makeTerrainSampler): the file's `cell` (17280 / 1081) is not their spacing */
  const ground = (x: number, z: number) => { const i = Math.round((x + 8640) / 16), j = Math.round((z + 8640) / 16); return i >= 0 && j >= 0 && i < T && j < T ? height[j * T + i] : 0; };

  // districts and parks: the game's own grids (cell centres where each area is), ids as the game has them
  const districts: CArea[] = [], parks: CArea[] = [];
  const src = d.extensions?.cs1 ?? {}, parkIds = src.park_source_ids ?? {};
  let districtGrid: Uint8Array | undefined;
  for (const a of list(d, 'districts', 'file')) {
    const where = `district ${a?.id}`, id = sid(a?.id, where), park = a.kind === 'PARK_ZONE';
    const gid = park ? (Number.isSafeInteger(parkIds[String(id)]) ? parkIds[String(id)] : -id - 1) : id;
    const [x, z] = a.position ? xz(a.position, where) : [0, 0];
    (park ? parks : districts).push({ id: gid, name: str(a.name?.text), x, y: ground(x, z), z, type: str(a.source_raw) || undefined });
    // district 0 is the game's "no district"; the grid keeps the others (same layout as a .vellummap's, see areaAt)
    const g = typeof a.grid_points === 'number' ? grids[a.grid_points] : undefined;
    if (!park && gid > 0 && gid < 256 && g?.length && Math.abs(a.grid_cell - 19.2) < 1e-6) {
      districtGrid ??= new Uint8Array(A * A * 8);
      for (let k = 0; k + 1 < g.length; k += 2) {
        const i = Math.floor((g[k] + 8640) / 19.2), j = Math.floor((g[k + 1] + 8640) / 19.2);
        if (i < 0 || j < 0 || i >= A || j >= A) continue;
        const c = (j * A + i) * 8; districtGrid[c] = gid; districtGrid[c + 4] = 255;
      }
    }
  }
  const distAt = (p: Vec3) => (districtGrid ? areaAt(districtGrid, p.x, p.z) : 0);

  const nodes = new Map<number, CNode>();
  for (const n of list(d, 'nodes', 'file')) {
    const id = sid(n?.id, 'node'), p = vec3(n.pos, `node ${id}`), sub = str(n.source_raw);
    // service: not in the file; transport and park sub-services say it, the rest comes from the node's networks below
    const srv = sub.startsWith('PublicTransport') ? 'PublicTransport' : sub.startsWith('Beautification') ? 'Beautification' : '';
    nodes.set(id, { id, ...p, ug: n.mode_hint === 'TUNNEL', srv, subsrv: sub || 'None', dist: distAt(p), og: n.mode_hint === 'GROUND', elev: 0 });
  }

  // networks: derived track copies (negative ids, the tram lanes of a road as their own network) stand for their road
  const sources = src.network_sources ?? {};
  const realId = (id: number) => (id < 0 ? (Number.isSafeInteger(sources[String(id)]?.segment_id) ? sources[String(id)].segment_id : null) : id);
  const invert = new Set<number>();
  const nets: any[] = [];
  for (const w of list(d, 'networks', 'file')) {
    const id = sid(w?.id, 'network');
    if (id < 0) continue;
    if (sources[String(id)]?.invert === true) invert.add(id);
    nets.push(w);
  }

  // lanes: the catalogue's, where the file confirms them on every segment of the prefab; else the file's facts
  // (every network: roads, paths, tracks, ferry paths, canals, the lines' own stop-to-stop segments)
  const isLegNet = (w: any) => w.kind === 'STOP_LINE' || (w.kind === 'OTHER' && / Line$/.test(str(w.source_raw)) && !/Wire|Pipe|Power/.test(str(w.source_raw)));
  const roadLike = (w: any) => w.kind === 'ROAD' || w.kind === 'BEAUTIFICATION';
  const byPrefab = new Map<string, any[]>();
  for (const w of nets) (byPrefab.get(str(w.name)) ?? byPrefab.set(str(w.name), []).get(str(w.name))!).push(w);
  const segTypes = new Map<string, CSegType>(), factsOnly = new Set<number>(), conflicts: string[] = [];
  const carSpeed = new Map<number, [number | null, number | null]>();
  const speedOf = (w: any) => { const s = w.car_speed ?? {}, ok = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null); return [ok(s.forward), ok(s.backward)] as [number | null, number | null]; };
  for (const [name, ws] of byPrefab) {
    const t = cat.types[name];
    const known = t ? { name, highway: !!t.h, lanes: t.lanes.map(([type, vType, dir, pos, width, speed]) => ({ type, vType, dir, pos, width, speed })) } : null;
    const kf = known && laneFacts(known.lanes);
    if (known && kf && ws.every((w) => sameFacts(kf, fileFacts(w, invert.has(w.id))))) { segTypes.set(name, known); continue; }
    if (known) conflicts.push(name);
    // tracks, ferry paths and the like the catalogue doesn't know: the file says nothing about their lanes, so none
    if (!ws.some(roadLike)) continue;
    // every segment of one prefab has the same lanes; take the most common facts (they agree unless the file is odd)
    const votes = new Map<string, { f: ReturnType<typeof laneFacts>; w: any; n: number }>();
    for (const w of ws) { const f = fileFacts(w, invert.has(w.id)), k = `${f.count},${f.dir},${f.car}`; const v = votes.get(k) ?? votes.set(k, { f, w, n: 0 }).get(k)!; v.n++; }
    const best = [...votes.values()].sort((a, b) => b.n - a.n)[0];
    const sp = Math.max(...ws.map((w) => Math.max(...speedOf(w).map((v) => v ?? 0))));
    segTypes.set(name, factsType(name, best.w, best.f, sp));
    for (const w of ws) factsOnly.add(w.id);
  }

  const segs: CSeg[] = [], legs: any[] = [];
  const oneway: OneWayResult = { dir: new Map(), source: new Map(), truth: new Map(), stats: { oneway: 0, groups: 0, conflicts: 0, bySource: { transit: 0, keepright: 0, prior: 0, exact: 0 } } };
  const serviceOfKind: Record<string, string> = { ROAD: 'Road', BEAUTIFICATION: 'Beautification', RAIL: 'PublicTransport', METRO: 'PublicTransport', TRAM: 'PublicTransport', MONORAIL: 'PublicTransport', CABLECAR: 'PublicTransport', STOP_LINE: 'PublicTransport' };
  for (const w of nets) {
    const id = w.id as number, where = `network ${id}`, pts = list(w, 'geometry', where).map((p) => vec3(p, where));
    const isLeg = isLegNet(w);
    const path = isLeg ? list(w, 'path_segment_ids', where).map((x) => realId(sid(x, where))).filter((x): x is number => x !== null) : [];
    const seg: CSeg = { id, sn: sid(w.start_id, where), en: sid(w.end_id, where), icls: str(w.source_raw), width: typeof w.width === 'number' && w.width > 0 ? w.width : 8,
      name: str(w.name), customName: (str(w.display_name) || str(w.game_name)).trim(), pts, path: isLeg ? (path.length ? path : null) : null };
    segs.push(seg);
    if (isLeg) legs.push({ seg, kind: w.kind === 'STOP_LINE' ? str(w.transit_for) : 'TOUR' });
    // a node's service is its own network's: dams (car lanes, but an electricity building) and power lines are
    // Electricity, canals Beautification (as a .cslmap of the same city reports them); a dam wins at a shared node
    const own = /\bDam\b/.test(seg.name) || /Wire|Power|Electricity/i.test(seg.icls) ? 'Electricity' : /Canal/i.test(seg.name) ? 'Beautification' : '';
    const srv = own || serviceOfKind[w.kind] || '';
    if (srv) for (const n of [seg.sn, seg.en]) { const nd = nodes.get(n); if (nd && (!nd.srv || (own === 'Electricity' && nd.srv === 'Road'))) nd.srv = srv; }
    if (w.kind === 'ROAD') {
      const sp = speedOf(w);
      if (sp[0] !== null || sp[1] !== null) carSpeed.set(id, sp);
      const f = w.car_access?.forward === 'allowed', b = w.car_access?.backward === 'allowed';
      if (f !== b) { oneway.dir.set(id, f ? 1 : -1); oneway.source.set(id, 'exact'); oneway.stats.oneway++; oneway.stats.bySource.exact++; }
    }
  }
  // one-way tracks and other vehicle networks without car lanes (trams, trains, metro): from their lanes, with Invert
  // applied, which the file gives; the same lanes oneway.ts reads, so the same networks count as one-way
  const ONEWAY_VEHICLES = /Car|Train|Metro|Tram|Monorail/;
  for (const seg of segs) {
    if (seg.path || oneway.dir.has(seg.id) || carSpeed.has(seg.id)) continue;
    const dirs = new Set((segTypes.get(seg.name)?.lanes ?? []).filter((l) => ONEWAY_VEHICLES.test(l.vType)).map((l) => l.dir));
    if (!dirs.size) continue;
    let k: 1 | -1 | 0 = [...dirs].every((x) => x === 'Forward' || x === 'AvoidBackward') ? 1 : [...dirs].every((x) => x === 'Backward' || x === 'AvoidForward') ? -1 : 0;
    if (!k) continue;
    if (invert.has(seg.id)) k = -k as 1 | -1;
    oneway.dir.set(seg.id, k); oneway.source.set(seg.id, 'exact'); oneway.stats.oneway++; oneway.stats.bySource.exact++;
  }
  oneway.stats.groups = oneway.stats.oneway;

  // transit lines: stops are line nodes, in route order (one route per line, from its first stop)
  const stopNode = new Map<number, number>();
  for (const s of list(d, 'stops', 'file')) stopNode.set(sid(s?.id, 'stop'), sid(s.network_node_id, `stop ${s.id}`));
  const routeOf = new Map<number, any>();
  for (const r of list(d, 'routes', 'file')) if (Number.isSafeInteger(r?.line_id) && !routeOf.has(r.line_id)) routeOf.set(r.line_id, r);
  const transports: CTransport[] = list(d, 'transit_lines', 'file').map((l) => {
    const id = sid(l?.id, 'transit line'), c = Array.isArray(l.user_color) ? l.user_color : [255, 255, 255];
    const stops = (routeOf.get(id)?.stop_ids ?? []).map((s: unknown) => stopNode.get(sid(s, `line ${id} stop`))).filter((n: number | undefined): n is number => n !== undefined && nodes.has(n));
    return { id, name: str(l.name), type: str(l.source_raw) || str(l.kind), color: [c[0] | 0, c[1] | 0, c[2] | 0] as [number, number, number], stops };
  });

  const buildings: CBuilding[] = list(d, 'buildings', 'file').map((b) => {
    const id = sid(b?.id, 'building'), where = `building ${id}`;
    const fp = list(b, 'footprint', where).map((p) => xz(p, where));
    const y = typeof b.base_elevation_m === 'number' && Number.isFinite(b.base_elevation_m) ? b.base_elevation_m : fp.length ? ground(fp[0][0], fp[0][1]) : 0;
    return { id, name: str(b.name), myname: b.display_name?.source === 'custom' ? str(b.display_name.text).trim() : '', srv: str(b.service), subsrv: str(b.sub_service), icls: str(b.icls),
      parent: Number(b.parent_building_id) || 0, sub: Number(b.sub_building_id) || 0, pts: fp.map(([x, z]) => ({ x, y, z })) };
  });

  // legs without a path: rebuilt where the network they run on is in the file
  const inferredLegs = new Set<number>();
  const info: CmmInfo = { lanes: { catalogue: 0, facts: factsOnly.size, none: 0 }, conflicts, legs: { exported: 0, rebuilt: 0, none: 0, why: {} }, issues: {} };
  const partial = { nodes, segs, segTypes };
  const ctxs = new Map<string, ReturnType<typeof legContext>>();
  for (const { seg, kind } of legs) {
    if (seg.path) { info.legs.exported++; continue; }
    const a = nodes.get(seg.sn), b = nodes.get(seg.en);
    if (REBUILD.has(kind) && !ctxs.has(kind)) ctxs.set(kind, legContext(partial, invert, kind));
    const r: LegResult = !REBUILD.has(kind) ? { path: null, why: LEG_LANES[kind] ? 'not validated' : 'no network' }
      : a && b ? rebuildLeg(partial, invert, kind, a, b, ctxs.get(kind)) : { path: null, why: 'stop off network' };
    if (r.path) { seg.path = r.path; inferredLegs.add(seg.id); info.legs.rebuilt++; }
    else { info.legs.none++; info.legs.why[r.why!] = (info.legs.why[r.why!] ?? 0) + 1; }
  }
  for (const w of nets) if (roadLike(w)) { if (factsOnly.has(w.id)) continue; if (segTypes.has(str(w.name))) info.lanes.catalogue++; else info.lanes.none++; }
  for (const i of Array.isArray(d.issues) ? d.issues : []) info.issues[str(i?.code)] = (info.issues[str(i?.code)] ?? 0) + 1;

  const forestRows = Array.isArray(d.forests) ? d.forests : [];
  const forestSize = forestRows.length || 512, forest = new Uint8Array(forestSize * forestSize);
  forestRows.forEach((r: any, y: number) => { const v = Array.isArray(r?.data) ? r.data : []; for (let x = 0; x < forestSize && x < v.length; x++) forest[y * forestSize + x] = Number(v[x]) & 255; });

  return {
    name: str(d.metadata?.origin?.source_name) || 'Untitled city',
    // "2026-11-14 12:52:26" (game-local time): ISO form so every browser parses it
    generated: str(d.metadata?.exported_at).replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)$/, '$1T$2'),
    seaLevel, nodes, segs, buildings, segTypes, districts, parks, transports, height, water, terrainSize: T, forest, forestSize,
    extras: {
      source: 'cmm', caps: { lanes: true, buildingParts: true }, producer: 'CSLModernMap', districtGrid, districtStats: new Map(), stopInfo: new Map(),
      oneway, carSpeed, inferredLegs, factsOnly, cmm: info,
    },
  };
}

/** Time-lapse: the identities in an older .cmm (same keys as history.ts scans from .cslmap). */
export function cmmIdentities(bytes: Uint8Array) {
  const { d } = parseDoc(bytes);
  const segs = list(d, 'networks', 'file').filter((w) => w?.id >= 0).map((w): [number, number, number] => [sid(w.id, 'network'), sid(w.start_id, 'network'), sid(w.end_id, 'network')]);
  const blds = list(d, 'buildings', 'file').map((b): [number, string] => [sid(b?.id, 'building'), str(b.name)]);
  const lines = list(d, 'transit_lines', 'file').map((l): [number, string] => [sid(l?.id, 'line'), str(l.source_raw) || str(l.kind)]);
  return { name: str(d.metadata?.origin?.source_name), time: Date.parse(str(d.metadata?.exported_at).replace(' ', 'T')), segs, blds, lines };
}
