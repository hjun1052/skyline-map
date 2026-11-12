// Reader for `.vellummap`, the city document written by the Vellum Bridge mod (https://github.com/sebas-tcotd/vellum).
// Format: a zip of JSON modules and little-endian grids, specified in Vellum's docs/es/vellummap-format.md and
// packages/parser-cslmap/schema/vellummap.schema.json (MIT). Written from that spec; no Vellum code is copied.
//
// The file is mapped onto the same CityData a .cslmap gives, so everything downstream works unchanged. What the
// format does not carry is left empty, never guessed into something that looks exact:
//  - no road prefab names and no lane table: `segTypes` stays empty, so the map has no lanes, one-way streets or
//    speed limits, and routing is switched off (`extras.caps.lanes = false`, see main.ts canRoute);
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

interface Entry { name: string; method: number; csize: number; usize: number; off: number }
const MiB = 1024 * 1024;
const LIMIT = { manifest: MiB, json: 256 * MiB, document: 1024 * MiB };
const T = 1081, V = 512, A = 900; // terrain/water, vegetation, area grids (samples per side)
const GRID_BYTES: Record<string, number> = { 'terrain.bin': T * T * 2, 'water-mask.bin': T * T, 'water-depth.bin': T * T * 2, 'vegetation.bin': V * V, 'districts.bin': A * A * 8, 'parks.bin': A * A * 8 };
const REQUIRED = ['terrain', 'water', 'water-mask', 'vegetation', 'roads', 'transit', 'buildings', 'districts', 'parks'];

function zipEntries(buf: Uint8Array): Entry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw damaged('no zip directory');
  const n = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
  if (n === 0xffff || cdOff === 0xffffffff) throw damaged('zip64 archives are not supported');
  const out: Entry[] = [];
  const seen = new Set<string>();
  let p = cdOff;
  for (let k = 0; k < n; k++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw damaged('broken zip directory');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl));
    if (seen.has(name)) throw damaged(`two entries named ${name}`);
    seen.add(name);
    if (lho + 30 > buf.length || dv.getUint32(lho, true) !== 0x04034b50) throw damaged(`${name}: broken entry`);
    // the data follows the local header, whose name/extra lengths may differ from the directory's
    const off = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    if (off + csize > buf.length) throw damaged(`${name}: truncated`);
    out.push({ name, method, csize, usize, off });
    p += 46 + nl + xl + cl;
  }
  return out;
}

async function inflate(buf: Uint8Array, e: Entry): Promise<Uint8Array> {
  const raw = buf.subarray(e.off, e.off + e.csize);
  let out: Uint8Array;
  if (e.method === 0) out = raw.slice();
  else if (e.method === 8) {
    try { out = new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()); }
    catch { throw damaged(`${e.name}: cannot be decompressed`); }
  } else throw damaged(`${e.name}: unsupported compression ${e.method}`);
  if (out.length !== e.usize) throw damaged(`${e.name}: wrong size`);
  return out;
}

async function sha256(b: Uint8Array) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
  let s = ''; for (const x of h) s += x.toString(16).padStart(2, '0'); return s;
}

export interface VellumDoc { manifest: any; files: Map<string, Uint8Array> }

/**
 * Open a .vellummap held in memory. `only` limits which modules are inflated (the time-lapse needs just three);
 * required modules and sizes are checked either way.
 */
export async function readVellummap(bytes: Uint8Array, only?: string[]): Promise<VellumDoc> {
  if (!isZip(bytes)) throw new FormatError('This file is not a city export Skyline Map can read.');
  const entries = zipEntries(bytes);
  let declared = 0;
  for (const e of entries) declared += e.usize;
  if (declared > LIMIT.document) throw damaged('it declares more than 1 GiB of content');
  const byName = new Map(entries.map((e) => [e.name, e]));
  const me = byName.get('manifest.json');
  if (!me) throw new FormatError('This file is not a city export Skyline Map can read.');
  if (me.usize > LIMIT.manifest) throw damaged('manifest.json is too large');
  let manifest: any;
  try { manifest = JSON.parse(new TextDecoder().decode(await inflate(bytes, me))); } catch (err) { if (err instanceof FormatError) throw err; throw damaged('manifest.json is not valid JSON'); }
  if (manifest?.format !== 'vellummap') throw new FormatError('This file is not a city export Skyline Map can read.');
  const ver = String(manifest.exportSchemaVersion ?? '');
  if (!/^\d+\.\d+$/.test(ver)) throw damaged('missing format version');
  if (ver.split('.')[0] !== '1') throw new FormatError('This .vellummap was written by a newer version of Vellum Bridge (format {version}). Skyline Map reads format 1.', { version: ver });
  const modules: any[] = Array.isArray(manifest.modules) ? manifest.modules : [];
  for (const m of modules) {
    if (String(m.version ?? '').split('.')[0] !== '1') throw new FormatError('This .vellummap was written by a newer version of Vellum Bridge (format {version}). Skyline Map reads format 1.', { version: `${m.id} ${m.version}` });
  }
  for (const id of REQUIRED) if (!modules.some((m) => m.id === id)) throw damaged(`module ${id} is missing`);
  if (!manifest.city || typeof manifest.city.name !== 'string') throw damaged('no city name');

  const files = new Map<string, Uint8Array>();
  await Promise.all(modules.map(async (m) => {
    const e = byName.get(m.path);
    if (!e) throw damaged(`${m.path} is missing`);
    const grid = GRID_BYTES[m.path];
    if (grid !== undefined ? e.usize !== grid : e.usize > LIMIT.json) throw damaged(`${m.path}: wrong size`);
    if ((m.codec === 'stored') !== (e.method === 0)) throw damaged(`${m.path}: codec does not match`);
    if (only && !only.includes(m.path)) return;
    const data = await inflate(bytes, e);
    if (typeof m.sha256 === 'string' && (await sha256(data)) !== m.sha256.toLowerCase()) throw damaged(`${m.path}: checksum mismatch`);
    files.set(m.path, data);
  }));
  return { manifest, files };
}

const json = (d: VellumDoc, path: string) => {
  const b = d.files.get(path);
  if (!b) throw damaged(`${path} is missing`);
  try { return JSON.parse(new TextDecoder().decode(b)); } catch { throw damaged(`${path} is not valid JSON`); }
};
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
export interface StopInfo { name?: string; derived: boolean; stationId?: number }

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

export function vellumToCity(d: VellumDoc): CityData {
  const m = d.manifest;
  const water = json(d, 'water.json');
  const seaLevel = Number(water.seaLevel) || 0;

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
  const roads = json(d, 'roads.json');
  const nodes = new Map<number, CNode>();
  for (const n of roads.nodes ?? []) {
    const p = n.position, elev = Number(n.elevation) || 0, ug = !!n.underground;
    // `og` (on ground) is not in the file: a node with no elevation step that is not underground is on the ground
    nodes.set(n.sourceId, { id: n.sourceId, x: p.x, y: p.y, z: p.z, ug, srv: '', subsrv: '', dist: dg ? areaAt(dg, p.x, p.z) : 0, og: elev === 0 && !ug, elev });
  }

  const segs: CSeg[] = [];
  const geom = new Map<number, Vec3[]>();
  const lineSegs = new Map<string, CSeg[]>(); // Bridge exports the lines' own segments; .cslmap carries the legs on them
  for (const s of roads.segments ?? []) {
    const ic = String(s.itemClass ?? '');
    const seg: CSeg = { id: s.sourceId, sn: s.startNodeSourceId, en: s.endNodeSourceId, icls: ic, width: Number(s.width) || 8,
      // no prefab name in the format: a road-type name from the item class and width stands in, and no lane table matches it
      name: roadTypeName(ic, Number(s.width) || 0), customName: typeof s.name === 'string' ? s.name : '', pts: (s.points ?? []).map((p: Vec3) => ({ x: p.x, y: p.y, z: p.z })), path: null };
    for (const id of [seg.sn, seg.en]) { const nd = nodes.get(id); if (nd && (!nd.srv || nd.srv === 'Road')) nd.srv = LINE_SEG(ic) || /Track|Metro|Monorail|Cable|Station|Stop/i.test(ic) ? 'PublicTransport' : /Beautification/i.test(ic) ? 'Beautification' : 'Road'; }
    geom.set(seg.id, seg.pts);
    if (LINE_SEG(ic)) { for (const id of [seg.sn, seg.en]) { const nd = nodes.get(id); if (nd) nd.og = false; } const k = seg.sn + ',' + seg.en; (lineSegs.get(k) ?? lineSegs.set(k, []).get(k)!).push(seg); continue; }
    segs.push(seg);
  }

  const transit = json(d, 'transit.json');
  const stopInfo = new Map<number, StopInfo>();
  let synthetic = -1;
  const transports: CTransport[] = (transit.lines ?? []).map((l: any) => {
    const stops: any[] = l.stops ?? [];
    for (const s of stops) {
      if (!nodes.has(s.sourceId)) nodes.set(s.sourceId, { id: s.sourceId, ...s.position, ug: false, srv: 'PublicTransport', subsrv: '', dist: dg ? areaAt(dg, s.position.x, s.position.z) : 0, og: null, elev: 0 });
      else { const nd = nodes.get(s.sourceId)!; nd.srv = 'PublicTransport'; nd.og = false; } // stops are transit-line nodes, never flagged on-ground
      if (s.name || s.stationId !== undefined) stopInfo.set(s.sourceId, { name: s.name, derived: !!s.nameDerived, stationId: s.stationId });
    }
    if (stops.length >= 2) {
      const legs = splitLegs((l.route ?? []).filter((id: number) => id), stops.map((s) => s.position), (id) => geom.get(id));
      legs.forEach((path, i) => {
        const a = stops[i], b = stops[(i + 1) % stops.length];
        const own = lineSegs.get(a.sourceId + ',' + b.sourceId)?.shift();
        segs.push(own ? { ...own, path } : { id: synthetic--, sn: a.sourceId, en: b.sourceId, icls: `${l.transportType} Line`, width: 0, name: `${l.transportType} Line`, customName: '', pts: [a.position, b.position], path });
      });
    }
    const c = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(String(l.color ?? '')) ?? [, '80', '80', '80'];
    return { id: l.sourceId, name: String(l.name ?? ''), type: String(l.transportType ?? ''), color: [parseInt(c[1]!, 16), parseInt(c[2]!, 16), parseInt(c[3]!, 16)] as [number, number, number], stops: stops.map((s) => s.sourceId) };
  });

  const buildings: CBuilding[] = (json(d, 'buildings.json').buildings ?? []).map((b: any) => {
    const ic = String(b.itemClass ?? ''), sub = String(b.serviceType ?? '');
    // module 1.1: `prefab` is the asset and `name` the name the player sees (renamed or unique buildings only)
    const prefab = b.prefab ?? b.name ?? '', shown = b.prefab ? String(b.name ?? '').trim() : '';
    return { id: b.sourceId, name: String(prefab), myname: shown, srv: serviceOf(ic, sub), subsrv: sub, icls: ic, parent: 0, sub: 0, pts: (b.footprint ?? []).map((p: Vec3) => ({ x: p.x, y: p.y, z: p.z })) };
  });

  const districtsJ = json(d, 'districts.json').districts ?? [];
  const districtStats = new Map<number, DistrictStats>();
  for (const x of districtsJ) if (x.population !== undefined || x.jobs !== undefined) districtStats.set(x.sourceId, { population: x.population, homes: x.homes, jobs: x.jobs, specializations: x.specializations });
  const area = (a: any): CArea => ({ id: a.sourceId, name: String(a.name ?? ''), x: a.labelPosition?.x ?? 0, y: a.labelPosition?.y ?? 0, z: a.labelPosition?.z ?? 0, type: a.parkType });

  return {
    name: m.city.name, generated: String(m.exportedAtUtc ?? ''), seaLevel,
    nodes, segs, buildings, segTypes: new Map(),
    districts: districtsJ.map(area), parks: (json(d, 'parks.json').parks ?? []).map(area), transports,
    height, water: wat, terrainSize: T, forest: d.files.get('vegetation.bin')!, forestSize: V,
    extras: {
      source: 'vellummap',
      caps: { lanes: false, buildingParts: false, saveMatch: false },
      producer: `${m.producer?.name ?? ''} ${m.producer?.version ?? ''}`.trim(), formatVersion: String(m.exportSchemaVersion),
      cityId: typeof m.city.id === 'string' ? m.city.id : undefined,
      districtGrid: dg, parkGrid: d.files.get('parks.bin'), districtStats, stopInfo, waterDepth: !!depth,
    },
  };
}

/** Time-lapse: the identities in an older .vellummap (same keys as history.ts scans from .cslmap). */
export async function vellumIdentities(bytes: Uint8Array) {
  const d = await readVellummap(bytes, ['roads.json', 'buildings.json', 'transit.json']);
  const segs: [number, number, number][] = (json(d, 'roads.json').segments ?? []).map((s: any) => [s.sourceId, s.startNodeSourceId, s.endNodeSourceId]);
  const blds: [number, string][] = (json(d, 'buildings.json').buildings ?? []).map((b: any) => [b.sourceId, String(b.prefab ?? b.name ?? '')]);
  const lines: [number, string][] = (json(d, 'transit.json').lines ?? []).map((l: any) => [l.sourceId, String(l.transportType ?? '')]);
  return { name: String(d.manifest.city.name), time: Date.parse(String(d.manifest.exportedAtUtc ?? '')), segs, blds, lines };
}
