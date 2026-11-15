// .skysave: what Skyline Map reads from a game save (.crp), kept in a small file of its own.
//
// A save is tens of megabytes; the app uses about a megabyte of it (traffic per road and by direction, building
// occupancy, TM:PE rules and speed limits, junction controls, transit ridership, city figures, the land value, noise,
// crime and pollution grids, and on a .vellummap the save's road prefabs). A .skysave holds exactly that, already matched
// to one map export, plus the city's fares and toll prices when they are set. It opens wherever a .crp does, much faster,
// and is what Send to Phone sends instead of the save.
//
// File: "SKYSAVE" + a version byte, then gzip of: u32 (little-endian) length of a JSON header, the header, and the bytes
// of every typed array back to back. The header is the payload with each typed array replaced by {$t, o, n} (type,
// byte offset, length), each Map by {$m: entries} and each Set by {$s: values}.
//
// A .skysave is tied to the export it was made from by a fingerprint of that map (ids, positions and connections), so it
// is never applied to another map. Files can come from anyone (Send to Phone, Discord), so everything is checked before
// use: sizes, types and ranges; anything that doesn't check out is left out, as an unreadable part of a .crp would be.
import type { CityData } from './parse';
import type { SimData, SimResult, RoadFact } from './sim';
import type { SavePrefabs } from './lane-infer';
import { IMM_RES, NAT_RES } from './sim/grids';

export const SKYSAVE_VERSION = 1;
const MAGIC = [0x53, 0x4b, 0x59, 0x53, 0x41, 0x56, 0x45]; // "SKYSAVE"
/** largest header + data a .skysave may unpack to (a real one is about 1-2 MB) */
const MAX_UNPACKED = 64 * 1024 * 1024;

/** what a .skysave carries */
export interface Skysave {
  app: 'skyline-atlas'; v: number; created: string;
  /** the export it belongs to */
  map: { name: string; fingerprint: string };
  /** the save's simulation data, as loadSim produced it (without its routing copy, which is rebuilt from `prefabs`) */
  sim: Omit<SimData, 'ok' | 'ms' | 'routing' | 'context'>;
  /** the city's fares and toll prices (CityContext), when set; checked by sanitizeContext before use */
  context?: unknown;
}

export const isSkysave = (b: Uint8Array) => b.length >= 8 && MAGIC.every((c, i) => b[i] === c);

// ------------------------------------------------------------------ map fingerprint

/** identifies one map export: every node (id, position), road (id, ends), building (id, asset) and line (id) */
export async function mapFingerprint(c: CityData): Promise<string> {
  const parts: string[] = [c.name, c.generated];
  for (const n of [...c.nodes.values()].sort((a, b) => a.id - b.id)) parts.push(`n${n.id},${Math.round(n.x * 10)},${Math.round(n.z * 10)}`);
  for (const s of [...c.segs].sort((a, b) => a.id - b.id)) parts.push(`s${s.id},${s.sn},${s.en}`);
  for (const b of [...c.buildings].sort((a, b) => a.id - b.id)) parts.push(`b${b.id},${b.name}`);
  for (const t of [...c.transports].sort((a, b) => a.id - b.id)) parts.push(`t${t.id}`);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\n'))));
  return [...h].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ packing

type TA = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;
const TYPES: Record<string, { new (b: ArrayBuffer): TA; BYTES_PER_ELEMENT: number }> = {
  u8: Uint8Array, i8: Int8Array, u16: Uint16Array, i16: Int16Array, u32: Uint32Array, i32: Int32Array, f32: Float32Array, f64: Float64Array,
};
const tag = (a: TA) => Object.keys(TYPES).find((k) => a instanceof TYPES[k])!;

function pack(x: unknown, bin: Uint8Array[], at: { n: number }): unknown {
  if (x === null || typeof x === 'string' || typeof x === 'boolean') return x;
  if (typeof x === 'number') return Number.isFinite(x) ? x : { $n: String(x) };
  if (ArrayBuffer.isView(x) && !(x instanceof DataView)) {
    const a = x as TA, bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    bin.push(bytes); const o = at.n; at.n += bytes.length;
    return { $t: tag(a), o, n: a.length };
  }
  if (x instanceof Map) return { $m: [...x].map(([k, v]) => [pack(k, bin, at), pack(v, bin, at)]) };
  if (x instanceof Set) return { $s: [...x].map((v) => pack(v, bin, at)) };
  if (Array.isArray(x)) return x.map((v) => pack(v, bin, at));
  if (typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as object)) if (v !== undefined && typeof v !== 'function') out[k] = pack(v, bin, at);
    return out;
  }
  return null;
}

function unpack(x: unknown, bin: Uint8Array, depth = 0): unknown {
  if (depth > 32) throw new Error('too deep');
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map((v) => unpack(v, bin, depth + 1));
  const o = x as Record<string, unknown>;
  if ('$t' in o) {
    const T = typeof o.$t === 'string' && Object.hasOwn(TYPES, o.$t) ? TYPES[o.$t] : null;
    const off = o.o, n = o.n;
    if (!T || !Number.isSafeInteger(off) || !Number.isSafeInteger(n) || (off as number) < 0 || (n as number) < 0) throw new Error('bad array');
    const end = (off as number) + (n as number) * T.BYTES_PER_ELEMENT;
    if (end > bin.length) throw new Error('array out of bounds');
    return new T(bin.slice(off as number, end).buffer); // a copy: aligned, and independent of the file
  }
  if ('$m' in o) { if (!Array.isArray(o.$m)) throw new Error('bad map'); return new Map((o.$m as unknown[]).map((e) => { if (!Array.isArray(e) || e.length !== 2) throw new Error('bad map'); return [unpack(e[0], bin, depth + 1), unpack(e[1], bin, depth + 1)] as [unknown, unknown]; })); }
  if ('$s' in o) { if (!Array.isArray(o.$s)) throw new Error('bad set'); return new Set((o.$s as unknown[]).map((v) => unpack(v, bin, depth + 1))); }
  if ('$n' in o) return o.$n === 'Infinity' ? Infinity : o.$n === '-Infinity' ? -Infinity : NaN;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = unpack(v, bin, depth + 1);
  return out;
}

async function gzip(parts: Uint8Array[]): Promise<Uint8Array> {
  const s = new Blob(parts as BlobPart[]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
/** gunzip, refusing to grow past `max` bytes (a small file can't unpack into gigabytes) */
async function gunzip(b: Uint8Array, max: number): Promise<Uint8Array> {
  const r = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    n += value.length;
    if (n > max) { void r.cancel(); throw new Error('too large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export async function encodeSkysave(s: Skysave): Promise<Uint8Array> {
  const bin: Uint8Array[] = [], at = { n: 0 };
  const header = new TextEncoder().encode(JSON.stringify(pack(s, bin, at)));
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, header.length, true);
  const gz = await gzip([len, header, ...bin]);
  const out = new Uint8Array(8 + gz.length);
  out.set(MAGIC); out[7] = SKYSAVE_VERSION; out.set(gz, 8);
  return out;
}

/** the file's contents, or why it can't be read: 'bad' (not a .skysave, or damaged), 'newer' (a later format) */
export async function decodeSkysave(b: Uint8Array): Promise<{ ok: true; s: Skysave } | { ok: false; why: 'bad' | 'newer' }> {
  if (!isSkysave(b)) return { ok: false, why: 'bad' };
  if (b[7] > SKYSAVE_VERSION) return { ok: false, why: 'newer' };
  try {
    const raw = await gunzip(b.subarray(8), MAX_UNPACKED);
    if (raw.length < 4) return { ok: false, why: 'bad' };
    const n = new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0, true);
    if (4 + n > raw.length) return { ok: false, why: 'bad' };
    const s = unpack(JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + n))), raw.subarray(4 + n)) as Skysave;
    if (!s || s.app !== 'skyline-atlas' || typeof s.v !== 'number' || !s.map || typeof s.map.fingerprint !== 'string' || typeof s.map.name !== 'string' || !s.sim || typeof s.sim !== 'object') return { ok: false, why: 'bad' };
    if (s.v > SKYSAVE_VERSION) return { ok: false, why: 'newer' };
    return { ok: true, s };
  } catch { return { ok: false, why: 'bad' }; }
}

// ------------------------------------------------------------------ checking what came in

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Map) && !(x instanceof Set) && !ArrayBuffer.isView(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const numOrNull = (x: unknown) => x === null || isNum(x);
const str = (x: unknown, max = 400): x is string => typeof x === 'string' && x.length <= max;
const allTA = <T extends TA>(o: any, keys: readonly string[], T: { new (...a: any[]): T }) => keys.every((k) => o[k] instanceof T);
const sameLen = (o: any, keys: readonly string[]) => keys.every((k) => o[k].length === o[keys[0]].length);
const pair = (x: unknown, f: (v: unknown) => boolean) => Array.isArray(x) && x.length === 2 && f(x[0]) && f(x[1]);
const UNAVAILABLE = new Set(['transit', 'vehicles', 'buildings', 'tmpe', 'rules', 'controls', 'city', 'grids']);
const VERDICTS = new Set(['match', 'near']), REASONS = new Set(['same', 'differs', 'too-different', 'different-city', 'empty']);

const check: { [K in keyof Skysave['sim']]?: (x: any) => boolean } = {
  traffic: (x) => isObj(x) && x.ids instanceof Uint16Array && x.pct instanceof Uint8Array && x.ids.length === x.pct.length,
  trafficDir: (x) => isObj(x) && x.ids instanceof Int32Array && allTA(x, ['f', 'b', 'evidence', 'queue', 'heading', 'trusted'], Uint8Array) && sameLen(x, ['ids', 'f', 'b', 'evidence', 'queue', 'heading', 'trusted']),
  buildings: (x) => isObj(x) && x.ids instanceof Uint16Array && allTA(x, ['residents', 'households', 'homes', 'workers', 'students', 'visitors'], Int32Array) && allTA(x, ['level', 'happiness'], Uint8Array)
    && sameLen(x, ['ids', 'residents', 'households', 'homes', 'workers', 'students', 'visitors', 'level', 'happiness']),
  grids: (x) => isObj(x) && allTA(x, ['landValue', 'noise', 'crime'], Uint16Array) && x.pollution instanceof Uint8Array
    && x.landValue.length === IMM_RES * IMM_RES && x.noise.length === IMM_RES * IMM_RES && x.crime.length === IMM_RES * IMM_RES && x.pollution.length === NAT_RES * NAT_RES,
  tmpe: (x) => isObj(x) && (x.modVersion === null || str(x.modVersion, 40)) && Array.isArray(x.segs) && x.segs.every((s: any) => isObj(s) && isInt(s.id) && Array.isArray(s.kmh) && s.kmh.every(isNum)
    && numOrNull(s.typeDefault) && (s.parking === null || pair(s.parking, (v) => typeof v === 'boolean'))),
  lines: (x) => Array.isArray(x) && x.every((l: any) => isObj(l) && isInt(l.id) && ['residents', 'tourists', 'lastResidents', 'lastTourists'].every((k) => isNum(l[k]))
    && Array.isArray(l.ageShares) && l.ageShares.length === 5 && l.ageShares.every(isNum) && numOrNull(l.tripsSaved)),
  controls: (x) => Array.isArray(x) && x.every((c: any) => isObj(c) && isInt(c.seg) && isInt(c.node) && (c.kind === 'signal' || c.kind === 'stop' || c.kind === 'yield')),
  city: (x) => isObj(x) && numbersOnly(x, 0),
  rules: (x) => isObj(x)
    && x.oneway instanceof Map && [...x.oneway].every(([k, v]) => isInt(k) && (v === 1 || v === -1))
    && x.speed instanceof Map && [...x.speed].every(([k, v]) => isInt(k) && pair(v, numOrNull))
    && x.carRestrict instanceof Map && [...x.carRestrict].every(([k, v]) => isInt(k) && pair(v, (b) => typeof b === 'boolean'))
    && numOrNull(x.restrictFactor)
    && Array.isArray(x.uturnBan) && x.uturnBan.every((u: any) => isObj(u) && isInt(u.seg) && isInt(u.node))
    && Array.isArray(x.turnBan) && x.turnBan.every((u: any) => isObj(u) && isInt(u.from) && isInt(u.node) && isInt(u.to))
    && x.trackLimit instanceof Map && [...x.trackLimit].every(([k, v]) => isInt(k) && v instanceof Map && [...v].every(([t, n]) => str(t, 40) && isNum(n)))
    && summaryOk(x.summary),
  rulesSummary: (x) => summaryOk(x),
  savedLanes: (x) => isObj(x) && isInt(x.exact) && isInt(x.roads) && isNum(x.lenShare),
  roadFacts: (x) => x instanceof Map && [...x].every(([k, f]: [unknown, RoadFact]) => isInt(k) && isObj(f) && str(f.prefab, 200)
    && (f.lanes === undefined || isInt(f.lanes)) && (f.speed === undefined || isNum(f.speed)) && (f.oneway === undefined || typeof f.oneway === 'boolean') && (f.bike === undefined || typeof f.bike === 'boolean')),
  prefabs: (x) => x instanceof Map && [...x].every(([k, p]) => isInt(k) && isObj(p) && str(p.name, 200) && isInt(p.lanes)),
};
/** an object or array (city figures) whose every leaf is a number or null, a few levels deep at most */
function numbersOnly(x: unknown, depth: number): boolean {
  if (x === null || isNum(x)) return true;
  if (depth > 3) return false;
  if (Array.isArray(x)) return x.length <= 64 && x.every((v) => numbersOnly(v, depth + 1));
  return isObj(x) && Object.keys(x).length <= 64 && Object.values(x).every((v) => numbersOnly(v, depth + 1));
}
function summaryOk(s: any) {
  return isObj(s) && ['oneway', 'speed', 'carRestrict', 'uturnBan', 'turnBan', 'track'].every((k) => isInt(s[k])) && ['restrictBan', 'leftHand', 'tmpe'].every((k) => typeof s[k] === 'boolean');
}
const tallyOk = (t: any) => isObj(t) && ['exported', 'verified', 'changed', 'replaced', 'missing'].every((k) => isInt(t[k]));

/**
 * The simulation data of a .skysave for the open map, or why not. `vellum`: rebuilds the routing copy from the save's
 * road prefabs on a .vellummap (as loadSim does from a .crp).
 */
export async function loadSkysave(b: Uint8Array, city: CityData, step: (s: string) => void, vellum?: (saved: SavePrefabs) => NonNullable<SimData['routing']>): Promise<SimResult & { context?: unknown }> {
  const t0 = performance.now();
  step('Reading save file');
  const d = await decodeSkysave(b);
  if (!d.ok) return { ok: false, code: d.why === 'newer' ? 'skysave-newer' : 'skysave-bad', detail: d.why };
  const { s } = d, sim = s.sim as any;
  step('Checking it matches this map');
  if (s.map.fingerprint !== (await mapFingerprint(city))) return { ok: false, code: 'skysave-mismatch', detail: 'made for another export' };
  // what every result needs, or the file isn't usable at all
  const v = sim.v, save = sim.save;
  if (!isObj(v) || !VERDICTS.has(v.verdict) || !REASONS.has(v.reason) || !['nodes', 'segments', 'buildings', 'lines'].every((k) => tallyOk(v[k])) || !isObj(v.share) || !isObj(save)
    || !(save.city === null || str(save.city, 200)) || !(save.savedAt === null || str(save.savedAt, 60)) || !(save.gameDate === null || str(save.gameDate, 60)) || !numOrNull(save.format)) {
    return { ok: false, code: 'skysave-bad', detail: 'header' };
  }
  step('Reading simulation data');
  const unavailable: string[] = Array.isArray(sim.unavailable) ? sim.unavailable.filter((u: unknown) => typeof u === 'string' && UNAVAILABLE.has(u)) : [];
  const out: any = { ok: true, save: { city: save.city, savedAt: save.savedAt, gameDate: save.gameDate, format: save.format }, v, unavailable };
  const part: Record<string, string> = { traffic: 'grids', trafficDir: 'vehicles', buildings: 'buildings', grids: 'grids', tmpe: 'tmpe', lines: 'transit', controls: 'controls', city: 'city', rules: 'rules' };
  for (const [k, ok] of Object.entries(check) as [string, (x: unknown) => boolean][]) {
    const x = sim[k];
    if (x === null || x === undefined) { out[k] = null; continue; }
    let good = false;
    try { good = ok(x); } catch { good = false; }
    out[k] = good ? x : null;
    if (!good && part[k] && !unavailable.includes(part[k])) unavailable.push(part[k]);
  }
  if (!out.rules) out.rules = undefined;
  if (out.rules && !out.rulesSummary) out.rulesSummary = out.rules.summary;
  if (vellum && out.prefabs) { try { out.routing = vellum(out.prefabs); } catch { /* keep the estimate */ } }
  out.context = s.context;
  out.ms = Math.round(performance.now() - t0);
  return out;
}

/** the .skysave of a loaded save (`sim`: loadSim's result, as the worker kept it) */
export async function makeSkysave(sim: SimData, city: CityData, context?: unknown): Promise<Uint8Array> {
  const { ok: _ok, ms: _ms, routing: _r, context: _c, ...rest } = sim;
  return encodeSkysave({ app: 'skyline-atlas', v: SKYSAVE_VERSION, created: new Date().toISOString(), map: { name: city.name, fingerprint: await mapFingerprint(city) }, sim: rest, ...(context ? { context } : {}) });
}
