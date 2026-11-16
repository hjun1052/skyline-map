// Reader for `.vellummap`, the city document written by the Vellum Bridge mod (https://github.com/sebas-tcotd/vellum).
// Format: a zip of JSON modules and little-endian grids, specified in Vellum's docs/es/vellummap-format.md and
// packages/parser-cslmap/schema/vellummap.schema.json (MIT). Written from that spec; no Vellum code is copied.
//
// The file is mapped onto the same CityData a .cslmap gives, so everything downstream works unchanged. What the
// format does not carry is left empty, never guessed into something that looks exact:
//  - no road prefab names and no lane table: `segTypes` stays empty, so the map has no lanes, one-way streets or
//    speed limits (`extras.caps.lanes = false`); routing runs on a separate copy with estimated lanes and is labelled
//    approximate (lane-infer.ts, worker.ts, main.ts canRoute);
//  - no sub-building chains (`prntb`/`subb`): multi-part assets are separate buildings;
//  - no service on nodes and buildings: derived from the item class (a fixed table, see SERVICE_OF);
//  - transit legs: the file has one route per line, cut back into stop-to-stop legs (splitLegs).
// As a reader of someone else's format this is lenient where that is safe: any 1.x version, unknown fields and
// unknown entries are ignored. It is strict about what protects the tab and the data: declared sizes before
// inflating (zip bombs), exact grid sizes, required modules, and each module's sha256.
import type { CityData, CNode, CSeg, CBuilding, CArea, CTransport, Vec3 } from './parse';

/** a reading failure the page can show translated (`key` is an i18n key, `params` its placeholders) */
export class FormatError extends Error {
  constructor(public key: string, public params: Record<string, string> = {}) { super(key.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? '')); }
}
// i18n-keys: reading errors, shown translated by the page
void ['This file is not a city export Skyline Map can read.', 'This .vellummap is damaged: {detail}', 'This .vellummap was written by a newer version of Vellum Bridge (format {version}). Skyline Map reads format 1.'];
// end i18n-keys
const damaged = (detail: string) => new FormatError('This .vellummap is damaged: {detail}', { detail });

export const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

// ------------------------------------------------------------------ zip container
//
// Defences, each with a regression test in tools/vellummap-check.ts:
//  - sizes: an entry inflates into a growing buffer and is cut off the moment it passes its declared size, so a
//    small entry that expands into gigabytes never gets far; declared sizes are capped (manifest 1 MiB, JSON module
//    256 MiB, document 1 GiB in total, grids exact) before anything is inflated;
//  - structure: one end record that ends the file, a directory inside the file, no multi-disk, zip64 or encrypted
//    entries, at most 64 entries, unique names, local headers that agree with the directory (name, method), and
//    entries whose data does not overlap (a classic zip bomb shares one compressed stream between many entries);
//  - manifest: each module at most once, at its fixed v1 path, with a known codec matching the zip method and the
//    sha256 of its content; unknown modules and entries are never inflated.

interface Entry { name: string; method: number; csize: number; usize: number; start: number; off: number }
const MiB = 1024 * 1024;
const LIMIT = { manifest: MiB, json: 256 * MiB, document: 1024 * MiB, entries: 64 };
const T = 1081, V = 512, A = 900; // terrain/water, vegetation, area grids (samples per side)
/** v1 modules: fixed path, exact byte size for grids */
const MODULES: Record<string, { path: string; bytes?: number; required?: true }> = {
  terrain: { path: 'terrain.bin', bytes: T * T * 2, required: true }, water: { path: 'water.json', required: true },
  'water-mask': { path: 'water-mask.bin', bytes: T * T, required: true }, 'water-depth': { path: 'water-depth.bin', bytes: T * T * 2 },
  vegetation: { path: 'vegetation.bin', bytes: V * V, required: true }, roads: { path: 'roads.json', required: true },
  transit: { path: 'transit.json', required: true }, buildings: { path: 'buildings.json', required: true },
  districts: { path: 'districts.json', required: true }, parks: { path: 'parks.json', required: true },
  'district-grid': { path: 'districts.bin', bytes: A * A * 8 }, 'park-grid': { path: 'parks.bin', bytes: A * A * 8 },
};

function zipEntries(buf: Uint8Array): Entry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), u16 = (p: number) => dv.getUint16(p, true), u32 = (p: number) => dv.getUint32(p, true);
  // the end record is the one whose comment runs exactly to the end of the file
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === buf.length) { eocd = i; break; }
  if (eocd < 0) throw damaged('no zip directory');
  const n = u16(eocd + 10), cdSize = u32(eocd + 12), cdOff = u32(eocd + 16);
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0 || u16(eocd + 8) !== n) throw damaged('multi-part zip archives are not supported');
  if (n === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw damaged('zip64 archives are not supported');
  if (n > LIMIT.entries) throw damaged(`too many entries (${n})`);
  if (cdOff + cdSize > eocd) throw damaged('broken zip directory');
  const out: Entry[] = [];
  const seen = new Set<string>();
  let p = cdOff;
  for (let k = 0; k < n; k++) {
    if (p + 46 > cdOff + cdSize || u32(p) !== 0x02014b50) throw damaged('broken zip directory');
    const flags = u16(p + 8), method = u16(p + 10), csize = u32(p + 20), usize = u32(p + 24), nl = u16(p + 28), xl = u16(p + 30), cl = u16(p + 32), start = u32(p + 42);
    if (p + 46 + nl + xl + cl > cdOff + cdSize) throw damaged('broken zip directory');
    const nameBytes = buf.subarray(p + 46, p + 46 + nl), name = new TextDecoder().decode(nameBytes);
    if (flags & 1) throw damaged(`${name}: encrypted entries are not supported`);
    if (seen.has(name)) throw damaged(`two entries named ${name}`);
    seen.add(name);
    if (start + 30 > cdOff || u32(start) !== 0x04034b50) throw damaged(`${name}: broken entry`);
    const lnl = u16(start + 26), lxl = u16(start + 28);
    // the local header must describe the same entry as the directory (tools that read either must see one file)
    if (u16(start + 8) !== method || lnl !== nl || buf.subarray(start + 30, start + 30 + lnl).some((b, i) => b !== nameBytes[i])) throw damaged(`${name}: local header disagrees with the directory`);
    const off = start + 30 + lnl + lxl;
    if (off + csize > cdOff) throw damaged(`${name}: truncated`);
    out.push({ name, method, csize, usize, start, off });
    p += 46 + nl + xl + cl;
  }
  // entries must not share bytes
  const byStart = [...out].sort((a, b) => a.start - b.start);
  for (let i = 1; i < byStart.length; i++) if (byStart[i].start < byStart[i - 1].off + byStart[i - 1].csize) throw damaged(`${byStart[i].name} overlaps ${byStart[i - 1].name}`);
  return out;
}

/** inflate one entry, never holding more than its declared size */
async function inflate(buf: Uint8Array, e: Entry): Promise<Uint8Array> {
  const raw = buf.subarray(e.off, e.off + e.csize);
  if (e.method === 0) { if (e.csize !== e.usize) throw damaged(`${e.name}: wrong size`); return raw.slice(); }
  if (e.method !== 8) throw damaged(`${e.name}: unsupported compression ${e.method}`);
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > e.usize) { await reader.cancel().catch(() => {}); throw damaged(`${e.name}: larger than declared`); }
      chunks.push(value);
    }
  } catch (err) { if (err instanceof FormatError) throw err; throw damaged(`${e.name}: cannot be decompressed`); }
  if (n !== e.usize) throw damaged(`${e.name}: wrong size`);
  const out = new Uint8Array(n);
  let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

async function sha256(b: Uint8Array) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
  let s = ''; for (const x of h) s += x.toString(16).padStart(2, '0'); return s;
}

export interface VellumDoc { manifest: any; files: Map<string, Uint8Array> }
const newer = (version: string) => new FormatError('This .vellummap was written by a newer version of Vellum Bridge (format {version}). Skyline Map reads format 1.', { version });
const notOurs = () => new FormatError('This file is not a city export Skyline Map can read.');

/**
 * Open a .vellummap held in memory. `only` limits which modules are inflated (the time-lapse needs just three);
 * the container and the manifest are checked in full either way.
 */
export async function readVellummap(bytes: Uint8Array, only?: string[]): Promise<VellumDoc> {
  if (!isZip(bytes)) throw notOurs();
  const entries = zipEntries(bytes);
  if (entries.reduce((s, e) => s + e.usize, 0) > LIMIT.document) throw damaged('it declares more than 1 GiB of content');
  const byName = new Map(entries.map((e) => [e.name, e]));
  const me = byName.get('manifest.json');
  if (!me) throw notOurs();
  if (me.usize > LIMIT.manifest) throw damaged('manifest.json is too large');
  let manifest: any;
  try { manifest = JSON.parse(new TextDecoder().decode(await inflate(bytes, me))); } catch (err) { if (err instanceof FormatError) throw err; throw damaged('manifest.json is not valid JSON'); }
  if (manifest?.format !== 'vellummap') throw notOurs();
  const ver = String(manifest.exportSchemaVersion ?? '');
  if (!/^\d+\.\d+$/.test(ver)) throw damaged('missing format version');
  if (!ver.startsWith('1.')) throw newer(ver);
  if (typeof manifest.city?.name !== 'string') throw damaged('no city name');
  if (!Array.isArray(manifest.modules)) throw damaged('no module list');

  // the modules this reader knows, each once, at its fixed path; newer ones (unknown ids) are skipped, never inflated
  const known = new Map<string, any>();
  for (const m of manifest.modules) {
    const spec = MODULES[m?.id];
    if (!spec) continue;
    if (known.has(m.id)) throw damaged(`module ${m.id} is listed twice`);
    if (m.path !== spec.path) throw damaged(`module ${m.id} is not at ${spec.path}`);
    if (!/^1\.\d+$/.test(String(m.version ?? ''))) throw newer(`${m.id} ${m.version}`);
    if (m.codec !== 'deflate' && m.codec !== 'stored') throw damaged(`${m.path}: unknown codec ${m.codec}`);
    if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sha256)) throw damaged(`${m.path}: no checksum`);
    known.set(m.id, m);
  }
  for (const [id, spec] of Object.entries(MODULES)) if (spec.required && !known.has(id)) throw damaged(`module ${id} is missing`);

  const files = new Map<string, Uint8Array>();
  await Promise.all([...known].map(async ([id, m]) => {
    const e = byName.get(m.path), spec = MODULES[id];
    if (!e) throw damaged(`${m.path} is missing`);
    if (spec.bytes !== undefined ? e.usize !== spec.bytes : e.usize > LIMIT.json) throw damaged(`${m.path}: wrong size`);
    if ((m.codec === 'stored') !== (e.method === 0)) throw damaged(`${m.path}: codec does not match`);
    if (only && !only.includes(m.path)) return;
    const data = await inflate(bytes, e);
    if ((await sha256(data)) !== m.sha256.toLowerCase()) throw damaged(`${m.path}: checksum mismatch`);
    files.set(m.path, data);
  }));
  return { manifest, files };
}

const json = (d: VellumDoc, path: string) => {
  const b = d.files.get(path);
  if (!b) throw damaged(`${path} is missing`);
  try { return JSON.parse(new TextDecoder().decode(b)); } catch { throw damaged(`${path} is not valid JSON`); }
};
// shape checks for the JSON modules: a bad value is a "damaged" message, never a crash or a NaN on the map
const list = (o: any, key: string, where: string): any[] => { const v = o?.[key]; if (!Array.isArray(v)) throw damaged(`${where}: ${key} is not a list`); return v; };
const num = (v: unknown, where: string): number => { if (typeof v !== 'number' || !Number.isFinite(v)) throw damaged(`${where}: not a number`); return v; };
const sid = (v: unknown, where: string): number => { if (!Number.isSafeInteger(v) || (v as number) < 0) throw damaged(`${where}: bad id`); return v as number; };
const pos = (p: any, where: string): Vec3 => ({ x: num(p?.x, where), y: num(p?.y, where), z: num(p?.z, where) });
const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** little-endian u16 grid (DataView: correct on any host) */
function u16(b: Uint8Array): Uint16Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), out = new Uint16Array(b.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = dv.getUint16(i * 2, true);
  return out;
}

// ------------------------------------------------------------------ services

/**
 * The game service of a building's item class. An item class belongs to exactly one service in CS1, and .cslmap
 * exports carry both, so this table is read off real exports (7 cities, 103 classes, no class with two services).
 * Classes not in it (DLC, mods) fall back to name patterns.
 */
const SERVICE_OF: Record<string, string> = {
  'Airplane Decoration': 'PublicTransport', 'Airplane Facility': 'PublicTransport', 'Airplane Facility Large Gate': 'PublicTransport', 'Airplane Facility Small Gate': 'PublicTransport', 'Airplane Path': 'PublicTransport',
  'Beautification Item': 'Beautification', 'Beautification Marker': 'Beautification', 'Bus Biofuel': 'PublicTransport', 'Bus Facility': 'PublicTransport', 'CableCar Facility': 'PublicTransport',
  'Childcare Facility': 'HealthCare', 'DeathCare Facility': 'HealthCare', 'Disaster Response': 'Disaster', 'Earthquake Sensor': 'Disaster', 'Eco Commercial': 'Commercial', 'Eldercare Facility': 'HealthCare',
  'Electricity Facility': 'Electricity', 'Electricity Wind Turbine': 'Electricity', 'Elementary School': 'Education', 'Farming - Extractor': 'Industrial', 'Farming - Processing': 'Industrial',
  'Ferry Facility': 'PublicTransport', 'Fire Department Facility': 'FireDepartment', 'Fire Helicopter': 'FireDepartment', 'Firewatch': 'FireDepartment', 'Forestry - Extractor': 'Industrial',
  'Forestry - Processing': 'Industrial', 'Garbage Facility': 'Garbage', 'Garbage Recycling': 'Garbage', 'Hadron Collider': 'Education', 'HealthCare Facility': 'HealthCare', 'High School': 'Education',
  'Hot Air Balloon': 'PublicTransport', 'Leisure Commercial': 'Commercial', 'Library': 'Education', 'Medical Helicopter': 'HealthCare', 'Metro Facility': 'PublicTransport', 'Metro Track': 'PublicTransport',
  'Monument - UpgradeLevel3': 'Monument', 'Monument Facility': 'Monument', 'Oil - Processing': 'Industrial', 'Ore - Processing': 'Industrial', 'Park Maintenance': 'Beautification', 'Parks Item': 'Beautification',
  'Player Forestry': 'PlayerIndustry', 'Player Trade School': 'PlayerEducation', 'Player University': 'PlayerEducation', 'Player Varsity Sports': 'VarsitySports', 'Police Department Facility': 'PoliceDepartment',
  'Police Helicopter': 'PoliceDepartment', 'Post Office': 'PublicTransport', 'Prison Facility': 'PoliceDepartment', 'Radio': 'Disaster', 'Road Maintenance Facility': 'Road', 'Shelter': 'Disaster',
  'Ship Cargo Facility': 'PublicTransport', 'Ship Facility': 'PublicTransport', 'Ship Path': 'PublicTransport', 'Space Elevator': 'PublicTransport', 'Taxi Facility': 'PublicTransport',
  'Tourist Commercial - Beach': 'Commercial', 'Tourist Commercial - Land': 'Commercial', 'Train Cargo Facility': 'PublicTransport', 'Train Facility': 'PublicTransport', 'Train Facility_Analog': 'PublicTransport',
  'Tram Facility': 'PublicTransport', 'Tsunami Buoy': 'Disaster', 'Unique Factories': 'PlayerIndustry', 'University': 'Education', 'Warehouses': 'PlayerIndustry', 'Waste Collection': 'Garbage',
  'Waste Transfer': 'Garbage', 'Water Facility': 'Water', 'Weather Radar': 'Disaster',
};
export function serviceOf(itemClass: string, subService: string): string {
  const known = SERVICE_OF[itemClass];
  if (known) return known;
  const zoned = /^(Low|High) (Residential|Commercial)|^(Industrial|Office) - /.exec(itemClass);
  if (zoned) return zoned[2] ?? zoned[3];
  for (const s of ['PublicTransport', 'Residential', 'Commercial', 'Industrial', 'Office', 'PlayerIndustry', 'PlayerEducation']) if (subService.startsWith(s)) return s;
  const pat: [RegExp, string][] = [[/Beautification|Parks?\b|Landscaping/i, 'Beautification'], [/Bus|Metro|Train|Tram|Ship|Ferry|Airplane|Plane|Monorail|Cable|Taxi|Blimp|Post/i, 'PublicTransport'],
    [/School|University|Library|Education|Campus/i, 'Education'], [/Health|Care|Hospital|Clinic/i, 'HealthCare'], [/Fire/i, 'FireDepartment'], [/Police|Prison/i, 'PoliceDepartment'],
    [/Electricity|Power/i, 'Electricity'], [/Water/i, 'Water'], [/Garbage|Waste|Recycl/i, 'Garbage'], [/Monument|Unique/i, 'Monument'], [/Disaster|Shelter/i, 'Disaster']];
  for (const [re, s] of pat) if (re.test(itemClass)) return s;
  return '';
}

// ------------------------------------------------------------------ transit legs

const distToPolyline = (p: Vec3, pts: Vec3[]) => {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.z + t * dz - p.z));
  }
  return best;
};

/**
 * Cut a line's whole route (segment ids in travel order) back into stop-to-stop legs, as .cslmap stores them.
 * Legs come in stop order from the first stop, so the cut points are non-decreasing: pick the ones that put each
 * stop closest to the segment it is cut at (dynamic programming over all monotone choices, O(stops x route)).
 * Consecutive legs share the cut segment, the segment the stop sits on.
 */
export function splitLegs(route: number[], stops: Vec3[], geom: (id: number) => Vec3[] | undefined): number[][] {
  const n = stops.length, L = route.length;
  if (n < 2) return [];
  if (!L) return stops.map(() => []);
  const far = 1e7;
  const cost = (i: number, k: number) => { const g = geom(route[k]); return g && g.length ? distToPolyline(stops[i], g) : far; };
  // dp over stops 1..n-1 (stop 0 starts the route; the last leg runs to its end)
  let prev = new Float64Array(L).fill(0);
  const from: Int32Array[] = [];
  for (let i = 1; i < n; i++) {
    const cur = new Float64Array(L), arg = new Int32Array(L);
    let bestV = Infinity, bestK = 0;
    for (let k = 0; k < L; k++) {
      if (prev[k] < bestV) { bestV = prev[k]; bestK = k; }
      cur[k] = bestV + cost(i, k); arg[k] = bestK;
    }
    from.push(arg); prev = cur;
  }
  let k = 0, v = Infinity;
  for (let j = 0; j < L; j++) if (prev[j] < v) { v = prev[j]; k = j; }
  const cuts = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 1; i--) { cuts[i] = k; k = from[i - 1][k]; }
  cuts[0] = 0;
  const legs: number[][] = [];
  for (let i = 0; i < n; i++) legs.push(route.slice(cuts[i], i + 1 < n ? cuts[i + 1] + 1 : L));
  return legs;
}

// ------------------------------------------------------------------ mapping onto CityData

export interface DistrictStats { population?: number; homes?: number; jobs?: { commercial: number; industrial: number; office: number }; specializations?: string[] }
export interface StopInfo { name?: string; stationId?: number }

/** the strongest area id of a cell of a 900² u8x8 area grid (4 ids, then their 4 alphas); 0 = none */
export function areaAt(grid: Uint8Array, x: number, z: number): number {
  const i = Math.floor((x + 8640) / 19.2), j = Math.floor((z + 8640) / 19.2);
  if (i < 0 || j < 0 || i >= A || j >= A) return 0;
  const c = (j * A + i) * 8;
  let id = 0, a = 0;
  for (let s = 0; s < 4; s++) if (grid[c + s] && grid[c + 4 + s] > a) { a = grid[c + 4 + s]; id = grid[c + s]; }
  return id;
}

/**
 * A road-type name for drawing, from the item class and the width (both in the file). Within an item class the game's
 * variants differ in width, consistently across real exports: highway ramps are 12 m, two-lane highways 16 m, full
 * highways 22-26 m; runways 44 m, taxiways 20-32 m; elevated and bridge versions of ordinary roads are 4 m narrower
 * than the ground version (16 → 12, 32 → 28). Only the drawn class and the bridge test use it; it carries no lanes.
 */
export function roadTypeName(itemClass: string, width: number): string {
  const w = Math.round(width);
  if (/^Highway( Tunnel)?$/.test(itemClass)) return w <= 13 ? (itemClass === 'Highway Tunnel' ? 'Highway Ramp Tunnel' : 'Highway Ramp') : w <= 17 ? (itemClass === 'Highway Tunnel' ? 'Two Lane Highway Tunnel' : 'Two Lane Highway') : itemClass;
  if (itemClass === 'Airplane Runway') return w >= 40 ? 'Airplane Runway' : 'Airplane Taxiway';
  const ground: Record<string, number> = { 'Small Road': 16, 'Medium Road': 32, 'Large Road': 32 };
  if (ground[itemClass] && w < ground[itemClass] && w >= ground[itemClass] - 5) return itemClass + ' Elevated';
  return itemClass;
}

const LINE_SEG = (ic: string) => / Line$/.test(ic) && !/Pipe|Power/.test(ic);
/** the lanes ships and planes travel (Vellum Bridge exports them, CSLMapView does not): not drawn, never routed */
const VEHICLE_LANE = (ic: string) => /^(Ship|Airplane) Path$/.test(ic);
/** service of a network's nodes, as CSLMapView reports it (checked on a matched pair of exports of one city) */
const nodeService = (ic: string) => LINE_SEG(ic) || /Track|Metro|Monorail|Cable|Station|Stop|Ferry|Ship|Airplane|Transport Connection/i.test(ic) ? 'PublicTransport'
  : /Water|Pipe|Heating/i.test(ic) ? 'Water' : /Electricity|Power|Wire/i.test(ic) ? 'Electricity' : /Beautification|Pedestrian|Landscaping/i.test(ic) ? 'Beautification' : 'Road';

/**
 * The format has no sub-building chains (CSLMapView's prntb/subb). The parts it can be sure of are linked back to their
 * main building: a building from the same workshop item (same Steam id prefix) that lies mostly inside a bigger one of a
 * different class, as glass, roof and platform overlays do. On 7 CSLMapView exports this is right for 212 of 215 links
 * (a third of all parts); the rest stay separate buildings, so the records that add parts up stay off (caps.buildingParts).
 */
function linkOverlays(buildings: CBuilding[]) {
  const prefix = (n: string) => /^(\d{6,})\./.exec(n)?.[1];
  const box = (b: CBuilding) => { let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const p of b.pts) { x0 = Math.min(x0, p.x); z0 = Math.min(z0, p.z); x1 = Math.max(x1, p.x); z1 = Math.max(z1, p.z); } return [x0, z0, x1, z1]; };
  const area = (a: number[]) => (a[2] - a[0]) * (a[3] - a[1]);
  const byItem = new Map<string, CBuilding[]>();
  for (const b of buildings) { const k = prefix(b.name); if (k && b.pts.length >= 3) (byItem.get(k) ?? byItem.set(k, []).get(k)!).push(b); }
  for (const list of byItem.values()) {
    if (list.length < 2) continue;
    const bx = list.map(box);
    list.forEach((b, i) => {
      let best = -1;
      for (let j = 0; j < list.length; j++) {
        if (i === j || list[j].icls === b.icls || area(bx[j]) <= area(bx[i]) || (best >= 0 && area(bx[j]) <= area(bx[best]))) continue;
        const ov = Math.max(0, Math.min(bx[i][2], bx[j][2]) - Math.max(bx[i][0], bx[j][0])) * Math.max(0, Math.min(bx[i][3], bx[j][3]) - Math.max(bx[i][1], bx[j][1]));
        if (ov >= 0.5 * Math.max(1, area(bx[i]))) best = j;
      }
      if (best >= 0) b.parent = list[best].id;
    });
  }
}

export function vellumToCity(d: VellumDoc): CityData {
  const m = d.manifest;
  const seaLevel = num(json(d, 'water.json').seaLevel, 'water.json seaLevel');

  const terrain = u16(d.files.get('terrain.bin')!);
  const depthB = d.files.get('water-depth.bin'), mask = d.files.get('water-mask.bin')!;
  const depth = depthB ? u16(depthB) : null;
  const height = new Float32Array(T * T), wat = new Float32Array(T * T);
  for (let i = 0; i < T * T; i++) {
    height[i] = terrain[i] / 64;
    // without captured depth (allowed by the format), wet cells are filled to sea level, at least 0.5 m: the
    // shoreline follows the mask, which the format calls its stable contract
    wat[i] = depth ? depth[i] / 64 : mask[i] ? Math.max(0.5, seaLevel - height[i]) : 0;
  }

  const dg = d.files.get('districts.bin');
  const distAt = (p: Vec3) => (dg ? areaAt(dg, p.x, p.z) : 0);
  const roads = json(d, 'roads.json');
  const nodes = new Map<number, CNode>();
  for (const n of list(roads, 'nodes', 'roads.json')) {
    const id = sid(n?.sourceId, 'roads.json node'), p = pos(n.position, `roads.json node ${id}`), elev = Number(n.elevation) || 0, ug = n.underground === true;
    // `og` (on ground) is not in the file: a node with no elevation step that is not underground is on the ground
    nodes.set(id, { id, ...p, ug, srv: '', subsrv: '', dist: distAt(p), og: elev === 0 && !ug, elev });
  }

  const segs: CSeg[] = [];
  const geom = new Map<number, Vec3[]>();
  const lineSegs = new Map<string, CSeg[]>(); // Bridge exports the lines' own segments; .cslmap carries the legs on them
  const offGround = (id: number) => { const nd = nodes.get(id); if (nd) nd.og = false; };
  const netClasses = new Set<string>(), laneNodes: number[] = [];
  for (const s of list(roads, 'segments', 'roads.json')) {
    const id = sid(s?.sourceId, 'roads.json segment'), where = `roads.json segment ${id}`, ic = str(s.itemClass), width = Number(s.width) || 0;
    const seg: CSeg = { id, sn: sid(s.startNodeSourceId, where), en: sid(s.endNodeSourceId, where), icls: ic, width: width || 8,
      // no prefab name in the format: a road-type name from the item class and width stands in, and no lane table matches it
      name: roadTypeName(ic, width), customName: str(s.name), pts: list(s, 'points', where).map((p) => pos(p, where)), path: null };
    netClasses.add(ic);
    if (VEHICLE_LANE(ic)) { laneNodes.push(seg.sn, seg.en); continue; }
    const srv = nodeService(ic);
    for (const n of [seg.sn, seg.en]) { const nd = nodes.get(n); if (nd && (!nd.srv || nd.srv === 'Road')) nd.srv = srv; }
    geom.set(id, seg.pts);
    if (LINE_SEG(ic)) { offGround(seg.sn); offGround(seg.en); const k = seg.sn + ',' + seg.en; (lineSegs.get(k) ?? lineSegs.set(k, []).get(k)!).push(seg); continue; }
    segs.push(seg);
  }
  // nodes only ship or plane lanes use (stops, outside connections): transport, as CSLMapView reports them
  for (const n of laneNodes) { const nd = nodes.get(n); if (nd && !nd.srv) nd.srv = 'PublicTransport'; }

  const stopInfo = new Map<number, StopInfo>();
  let synthetic = -1;
  const transports: CTransport[] = list(json(d, 'transit.json'), 'lines', 'transit.json').map((l) => {
    const lid = sid(l?.sourceId, 'transit.json line'), where = `transit.json line ${lid}`, type = str(l.transportType);
    const stops = list(l, 'stops', where).map((s) => ({ id: sid(s?.sourceId, where), p: pos(s.position, where), name: str(s.name), station: s.stationId === undefined ? undefined : sid(s.stationId, where) }));
    for (const s of stops) {
      const nd = nodes.get(s.id);
      if (!nd) nodes.set(s.id, { id: s.id, ...s.p, ug: false, srv: 'PublicTransport', subsrv: '', dist: distAt(s.p), og: false, elev: 0 });
      else { nd.srv = 'PublicTransport'; nd.og = false; } // stops are transit-line nodes, never flagged on-ground
      if (s.name || s.station !== undefined) stopInfo.set(s.id, { name: s.name || undefined, stationId: s.station });
    }
    if (stops.length >= 2) {
      const route = list(l, 'route', where).map((x) => sid(x, where)).filter((x) => x);
      splitLegs(route, stops.map((s) => s.p), (id) => geom.get(id)).forEach((path, i) => {
        const a = stops[i], b = stops[(i + 1) % stops.length];
        const own = lineSegs.get(a.id + ',' + b.id)?.shift();
        segs.push(own ? { ...own, path } : { id: synthetic--, sn: a.id, en: b.id, icls: `${type} Line`, width: 0, name: `${type} Line`, customName: '', pts: [a.p, b.p], path });
      });
    }
    const c = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(str(l.color)) ?? [, '80', '80', '80'];
    return { id: lid, name: str(l.name), type, color: [parseInt(c[1]!, 16), parseInt(c[2]!, 16), parseInt(c[3]!, 16)] as [number, number, number], stops: stops.map((s) => s.id) };
  });

  const buildings: CBuilding[] = list(json(d, 'buildings.json'), 'buildings', 'buildings.json').map((b) => {
    const id = sid(b?.sourceId, 'buildings.json building'), ic = str(b.itemClass), sub = str(b.serviceType);
    // module 1.1: `prefab` is the asset and `name` the name the player sees (renamed or unique buildings only)
    const prefab = str(b.prefab) || str(b.name), shown = b.prefab ? str(b.name).trim() : '';
    return { id, name: prefab, myname: shown, srv: serviceOf(ic, sub), subsrv: sub, icls: ic, parent: 0, sub: 0, pts: list(b, 'footprint', `building ${id}`).map((p) => pos(p, `building ${id}`)) };
  })
    // pieces of networks (pillars, medians, pipe junctions) that Vellum Bridge exports as buildings and CSLMapView leaves out:
    // a building with a network's item class. Beautification Item (rocks, parking lots) and dams are real buildings too.
    .filter((b) => !netClasses.has(b.icls) || b.icls === 'Beautification Item' || /Dam\b/.test(b.icls));
  linkOverlays(buildings);

  const districtStats = new Map<number, DistrictStats>();
  const area = (a: any, where: string): CArea => {
    const id = sid(a?.sourceId, where), p = a.labelPosition ? pos(a.labelPosition, where) : { x: 0, y: 0, z: 0 };
    return { id, name: str(a.name), ...p, type: typeof a.parkType === 'string' ? a.parkType : undefined };
  };
  const districts = list(json(d, 'districts.json'), 'districts', 'districts.json').map((x) => {
    const a = area(x, 'districts.json');
    const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    if (x.population !== undefined || x.jobs !== undefined) districtStats.set(a.id, { population: count(x.population), homes: count(x.homes),
      jobs: x.jobs ? { commercial: count(x.jobs.commercial) ?? 0, industrial: count(x.jobs.industrial) ?? 0, office: count(x.jobs.office) ?? 0 } : undefined,
      specializations: Array.isArray(x.specializations) ? x.specializations.filter((v: unknown) => typeof v === 'string') : undefined });
    return a;
  });

  return {
    name: m.city.name, generated: str(m.exportedAtUtc), seaLevel,
    nodes, segs, buildings, segTypes: new Map(), districts, transports,
    parks: list(json(d, 'parks.json'), 'parks', 'parks.json').map((x) => area(x, 'parks.json')),
    height, water: wat, terrainSize: T, forest: d.files.get('vegetation.bin')!, forestSize: V,
    extras: {
      source: 'vellummap',
      caps: { lanes: false, buildingParts: false },
      producer: `${str(m.producer?.name)} ${str(m.producer?.version)}`.trim(),
      districtGrid: dg, districtStats, stopInfo,
    },
  };
}

/** Time-lapse: the identities in an older .vellummap (same keys as history.ts scans from .cslmap). */
export async function vellumIdentities(bytes: Uint8Array) {
  const d = await readVellummap(bytes, ['roads.json', 'buildings.json', 'transit.json']);
  const segs = list(json(d, 'roads.json'), 'segments', 'roads.json').map((s): [number, number, number] => [sid(s?.sourceId, 'segment'), sid(s.startNodeSourceId, 'segment'), sid(s.endNodeSourceId, 'segment')]);
  const blds = list(json(d, 'buildings.json'), 'buildings', 'buildings.json').map((b): [number, string] => [sid(b?.sourceId, 'building'), str(b.prefab) || str(b.name)]);
  const lines = list(json(d, 'transit.json'), 'lines', 'transit.json').map((l): [number, string] => [sid(l?.sourceId, 'line'), str(l.transportType)]);
  return { name: String(d.manifest.city.name), time: Date.parse(str(d.manifest.exportedAtUtc)), segs, blds, lines };
}
