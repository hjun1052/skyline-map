// Estimated lanes for maps whose file has none (.vellummap), so the existing router can give approximate directions.
//
// A .vellummap road segment carries its network class ("item class") and width, but no prefab name and no lane
// table. Most class + width pairs belong to one kind of road, so a catalogue built from real .cslmap exports
// (tools/lane-catalog.ts → src/lane-catalog.json) maps each pair to the lanes the game usually gives it. Where the
// pair is unknown (workshop networks), the nearest road of the same family stands in.
//
// Some pairs come as both a one-way and a two-way road (Two Lane Highway, small one-way streets). Evidence in the
// file settles some of them:
//  - a road that buses or trams drive in both directions is two-way (never one-way in 7 test cities);
//  - toll gates take one-way/two-way from the booth building next to them (booth prefabs are in the file);
//  - a class name that says so ("2L2W", "Twoway", "Oneway");
//  - for the ambiguous pairs only: one-way when a bus uses it in one direction or a twin carriageway runs beside it,
//    else two-way (a wrong two-way only allows a shortcut; a wrong one-way can block half of a road).
// The evidence is spread along each run of the same road through plain joins.
//
// None of this is exact. The result is used for routing only, never drawn on the map or shown as lane facts; the UI
// labels these directions as approximate (see main.ts canRoute / approxRouting).
import type { CityData, CSeg, CSegType, CLane } from './parse';
import { laneInfo } from './build';
import { inferOneWay, type OneWayResult } from './oneway';
import { detectTolls, type TollData } from './tolls';

export interface LaneCatalog {
  v: 1;
  /** prefab name → highway flag + lanes [type, vType, dir, pos, width, speed] */
  types: Record<string, { h?: 1; lanes: [string, string, string, number, number, number][] }>;
  /** "itemClass|width" (width to 0.1 m and rounded), or "itemClass": [prefab most used, share of length that is one-way] */
  keys: Record<string, [string, number]>;
}

export const exactKey = (icls: string, w: number) => `${icls}|${w.toFixed(1)}`;
export const roundKey = (icls: string, w: number) => `${icls}|${Math.round(w)}`;

const segLen = (s: CSeg) => s.pts.reduce((a, p, i) => (i ? a + Math.hypot(p.x - s.pts[i - 1].x, p.z - s.pts[i - 1].z) : 0), 0);
const hasVehicleLanes = (st: CSegType | undefined) => !!st && laneInfo(st).vehicle > 0;

/** Catalogue from .cslmap cities: for each class + width, the prefab with the most road length, and its lanes. */
export function buildCatalog(cities: CityData[]): LaneCatalog {
  const votes = new Map<string, Map<string, number>>();
  const oneway = new Map<string, [number, number]>();
  const types: LaneCatalog['types'] = {};
  for (const c of cities) for (const s of c.segs) {
    const st = c.segTypes.get(s.name);
    if (!st || s.path || s.pts.length < 2) continue;
    const L = segLen(s);
    if (!types[s.name]) types[s.name] = { ...(st.highway ? { h: 1 as const } : {}), lanes: st.lanes.map((l) => [l.type, l.vType, l.dir, l.pos, l.width, l.speed]) };
    for (const k of [exactKey(s.icls, s.width), roundKey(s.icls, s.width), s.icls]) {
      const m = votes.get(k) ?? votes.set(k, new Map()).get(k)!;
      // station tracks (platforms, slower lanes) only win for station classes
      m.set(s.name, (m.get(s.name) ?? 0) + (/Station/i.test(s.name) && !/Station/i.test(s.icls) ? L * 0.2 : L));
      if (hasVehicleLanes(st)) { const o = oneway.get(k) ?? [0, 0]; o[1] += L; if (laneInfo(st).oneway) o[0] += L; oneway.set(k, o); }
    }
  }
  const keys: LaneCatalog['keys'] = {};
  for (const [k, m] of [...votes].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const best = [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    const o = oneway.get(k);
    keys[k] = [best, o && o[1] ? Math.round((1000 * o[0]) / o[1]) / 1000 : 0];
  }
  // keep only the prefabs some key points to
  const used = new Set(Object.values(keys).map((v) => v[0]));
  for (const n of Object.keys(types)) if (!used.has(n)) delete types[n];
  return { v: 1, types, keys };
}

const typeOf = (cat: LaneCatalog, name: string): CSegType => {
  const t = cat.types[name];
  return { name, highway: !!t.h, lanes: t.lanes.map(([type, vType, dir, pos, width, speed]) => ({ type, vType, dir, pos, width, speed })) };
};

// families for networks the catalogue has never seen (mostly workshop classes): same family, nearest width
const FAMILY = /highway|avenue|large|medium|small|basic|oneway|road|street|busway/gi;
const PATHS = /pedestrian|footpath|path|trail|walkway/i;
const RAILS = /metro|train|tram|monorail/gi;
/** never matched by family: ships, planes, pipes, wires and the game's hidden connectors are not roads or paths */
const NOT_A_WAY = /ship|ferry|airplane|plane|blimp|helicopter|cable ?car|pipe|power|electricity|heating|connection|quay|canal|fence|wall/i;
const words = (s: string, re: RegExp) => new Set(s.toLowerCase().match(re) ?? []);
const carLanes = (lanes: LaneCatalog['types'][string]['lanes']) => lanes.some((l) => l[0].includes('Vehicle') && l[1].split(',').some((v) => v.trim() === 'Car'));

/** a network class without its variant word: "Highway2L2W TunnelTunnelClass" and "Highway2L2WGroundClass" are both "highway2l2w" */
const stem = (ic: string) => ic.replace(/[\s_-]*(Ground|Elevated|Bridge|Tunnel|Slope)\b.*$|[\s_-]*(Ground|Elevated|Bridge|Tunnel|Slope)[A-Z]\w*$/, '').trim().toLowerCase();

/**
 * Lanes for a class the catalogue has never seen: first another variant of the same network (its ground, tunnel or
 * elevated version, by name), whose one-way share is then known; else the nearest width in the same family, which
 * leaves one-way to the evidence rules (`share` undefined).
 */
function fallback(cat: LaneCatalog, icls: string, width: number): { name: string; share?: number } | undefined {
  if (NOT_A_WAY.test(icls)) return undefined;
  const mine = stem(icls);
  if (mine.length >= 4) {
    let hit: { name: string; share: number } | undefined, gap = Infinity;
    for (const [k, [name, share]] of Object.entries(cat.keys)) {
      const bar = k.lastIndexOf('|');
      if (bar < 0 || /\.\d$/.test(k) || stem(k.slice(0, bar)) !== mine) continue;
      const d = Math.abs(+k.slice(bar + 1) - width) + (/Station/i.test(name) && !/Station/i.test(icls) ? 5 : 0);
      if (d < gap || (d === gap && hit && name < hit.name)) { gap = d; hit = { name, share }; }
    }
    if (hit) return hit;
  }
  const rail = words(icls, RAILS), road = words(icls, FAMILY);
  const kind = rail.size && !/road|avenue|highway/i.test(icls) ? 'rail' : road.size ? 'road' : PATHS.test(icls) ? 'path' : null;
  if (!kind) return undefined;
  let best: string | undefined, score = -Infinity;
  for (const [k, [name]] of Object.entries(cat.keys)) {
    const bar = k.lastIndexOf('|');
    if (bar < 0 || /\.\d$/.test(k)) continue; // rounded "class|width" keys only
    const ic = k.slice(0, bar), w = +k.slice(bar + 1), lanes = cat.types[name].lanes;
    if (NOT_A_WAY.test(ic)) continue;
    let shared = 0;
    if (kind === 'road') { if (carLanes(lanes)) { const theirs = words(ic, FAMILY); shared = [...road].filter((f) => theirs.has(f)).length; } }
    else if (kind === 'rail') { if (!carLanes(lanes)) { const theirs = words(ic, RAILS); shared = [...rail].filter((f) => theirs.has(f)).length; } }
    else shared = !carLanes(lanes) && PATHS.test(ic) && lanes.some((l) => l[0].includes('Pedestrian')) ? 1 : 0;
    if (!shared) continue;
    // station tracks have platforms and slower lanes: only for station classes
    const sc = shared * 10 - Math.abs(w - width) - (/Station/i.test(name) && !/Station/i.test(icls) ? 5 : 0);
    if (sc > score || (sc === score && best !== undefined && name < best)) { score = sc; best = name; }
  }
  return best === undefined ? undefined : { name: best };
}

/** rewrite a road's vehicle lanes as one-way (all forward along the segment) or two-way (alternating) */
function withDirection(st: CSegType, oneway: boolean): CLane[] {
  let i = 0;
  return st.lanes.map((l) => (l.type.includes('Vehicle') ? { ...l, dir: oneway ? 'Forward' : i++ % 2 ? 'Backward' : 'Forward' } : l));
}

export interface InferStats { segments: number; known: number; family: number; none: number; onewayByEvidence: number; twowayByEvidence: number }

/**
 * A copy of `city` with estimated prefab names and lane types, for the router only. Segment names become the
 * catalogue's prefab names (the router and access rules read them, as for a .cslmap); the map keeps the original.
 */
export function inferLanes(city: CityData, cat: LaneCatalog): { city: CityData; stats: InferStats } {
  const stats: InferStats = { segments: 0, known: 0, family: 0, none: 0, onewayByEvidence: 0, twowayByEvidence: 0 };
  const base = new Map<number, { name: string; key: string; share?: number; family: boolean }>();
  const memo = new Map<string, { name: string; share?: number } | undefined>();
  for (const s of city.segs) {
    if (s.path || s.pts.length < 2) continue;
    stats.segments++;
    const k = [exactKey(s.icls, s.width), roundKey(s.icls, s.width), s.icls].find((x) => cat.keys[x]);
    if (k) { stats.known++; base.set(s.id, { name: cat.keys[k][0], key: exactKey(s.icls, s.width), share: cat.keys[k][1], family: false }); continue; }
    const fk = roundKey(s.icls, s.width);
    if (!memo.has(fk)) memo.set(fk, fallback(cat, s.icls, s.width));
    const f = memo.get(fk);
    if (f) { stats.family++; base.set(s.id, { name: f.name, key: exactKey(s.icls, s.width), share: f.share, family: f.share === undefined }); } else stats.none++;
  }
  const isRoad = (id: number) => { const b = base.get(id); return !!b && cat.types[b.name].lanes.some((l) => l[0].includes('Vehicle') && l[1].split(',').some((v) => v.trim() === 'Car')); };
  const want = new Map<number, boolean>(); // segment id → one-way?

  // 1. class names that say it
  for (const s of city.segs) if (isRoad(s.id)) {
    if (/2L2W|2W\b|Two ?way/i.test(s.icls)) want.set(s.id, false);
    else if (/1W\b|One ?way/i.test(s.icls)) want.set(s.id, true);
  }
  // 2. toll gates follow the nearest booth (within 40 m)
  const booths = city.buildings.filter((b) => /Toll Booth/i.test(b.name) && b.pts.length >= 3)
    .map((b) => ({ oneway: /One ?way/i.test(b.name), x: b.pts.reduce((t, p) => t + p.x, 0) / b.pts.length, z: b.pts.reduce((t, p) => t + p.z, 0) / b.pts.length }));
  for (const s of city.segs) {
    if (want.has(s.id) || !/Toll/i.test(base.get(s.id)?.name ?? '')) continue;
    const m = s.pts[s.pts.length >> 1];
    let near: (typeof booths)[number] | undefined, d = 40;
    for (const b of booths) { const e = Math.hypot(b.x - m.x, b.z - m.z); if (e < d) { d = e; near = b; } }
    if (near) want.set(s.id, near.oneway);
  }

  // 3. evidence along runs of the same road
  const roads = city.segs.filter((s) => isRoad(s.id) && city.nodes.has(s.sn) && city.nodes.has(s.en));
  const byId = new Map(city.segs.map((s) => [s.id, s]));
  const at = new Map<number, CSeg[]>();
  for (const s of roads) for (const n of [s.sn, s.en]) (at.get(n) ?? at.set(n, []).get(n)!).push(s);
  // directions buses, trolleybuses and trams drove each segment (transit legs list the segments in order)
  const onRoad = new Set<string>();
  for (const t of city.transports) if (/Bus|Trolley|Evacuation|Taxi|Tram/i.test(t.type)) t.stops.forEach((a, i) => onRoad.add(a + ',' + t.stops[(i + 1) % t.stops.length]));
  const fwd = new Set<number>(), bwd = new Set<number>();
  for (const p of city.segs) {
    if (!p.path || !onRoad.has(p.sn + ',' + p.en)) continue;
    const seq = p.path.filter((id, i) => (i === 0 || id !== p.path![i - 1]) && byId.has(id));
    seq.forEach((id, k) => {
      const s = byId.get(id)!;
      const shared = (o: CSeg) => [s.sn, s.en].filter((n) => n === o.sn || n === o.en);
      let end: number | undefined;
      if (k + 1 < seq.length) { const sh = shared(byId.get(seq[k + 1])!); if (sh.length === 1) end = sh[0]; }
      else if (k > 0) { const sh = shared(byId.get(seq[k - 1])!); if (sh.length === 1) end = sh[0] === s.sn ? s.en : s.sn; }
      if (end !== undefined) (end === s.en ? fwd : bwd).add(id);
    });
  }
  // twin carriageway: an antiparallel road of the same class and width beside it, at the same height
  const info = roads.map((s) => { const a = s.pts[0], b = s.pts[s.pts.length - 1]; return { s, k: base.get(s.id)!.key, mx: (a.x + b.x) / 2, mz: (a.z + b.z) / 2, dx: b.x - a.x, dz: b.z - a.z, y: s.pts.reduce((t, p) => t + p.y, 0) / s.pts.length, len: Math.hypot(b.x - a.x, b.z - a.z) }; });
  const grid = new Map<string, typeof info>();
  for (const o of info) { const g = Math.floor(o.mx / 80) + ',' + Math.floor(o.mz / 80); (grid.get(g) ?? grid.set(g, []).get(g)!).push(o); }
  const twin = new Set<number>();
  for (const o of info) {
    if (o.len <= 15) continue;
    const gx = Math.floor(o.mx / 80), gz = Math.floor(o.mz / 80);
    search: for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of grid.get(`${gx + i},${gz + j}`) ?? []) {
      if (q.s.id === o.s.id || q.k !== o.k || q.len <= 15 || Math.abs(q.y - o.y) > 4 || Math.hypot(q.mx - o.mx, q.mz - o.mz) > 70) continue;
      const cos = (o.dx * q.dx + o.dz * q.dz) / o.len / q.len;
      const cross = Math.abs((o.dx * (q.mz - o.mz) - o.dz * (q.mx - o.mx)) / o.len);
      if (cos < -0.94 && cross >= 6 && cross <= (o.s.width + q.s.width) / 2 + 20) { twin.add(o.s.id); break search; }
    }
  }
  // runs: same class and width through nodes where exactly two roads meet
  const run = new Map<number, number>();
  let runs = 0;
  for (const s of roads) {
    if (run.has(s.id)) continue;
    run.set(s.id, ++runs);
    const stack = [s];
    while (stack.length) {
      const x = stack.pop()!;
      for (const n of [x.sn, x.en]) {
        const inc = at.get(n)!;
        if (inc.length !== 2) continue;
        for (const y of inc) if (!run.has(y.id) && base.get(y.id)!.key === base.get(s.id)!.key) { run.set(y.id, runs); stack.push(y); }
      }
    }
  }
  const both = new Set<number>(), oneHint = new Set<number>();
  for (const s of roads) {
    const r = run.get(s.id)!;
    if (fwd.has(s.id) && bwd.has(s.id)) both.add(r);
    if (fwd.has(s.id) !== bwd.has(s.id) || twin.has(s.id)) oneHint.add(r);
  }
  for (const s of roads) {
    if (want.has(s.id)) continue;
    const b = base.get(s.id)!, r = run.get(s.id)!;
    if (both.has(r)) { want.set(s.id, false); stats.twowayByEvidence++; continue; }
    const ambiguous = b.family || (b.share !== undefined && b.share > 0.15 && b.share < 0.85);
    if (ambiguous) { const ow = oneHint.has(r); want.set(s.id, ow); if (ow) stats.onewayByEvidence++; }
  }

  // 4. the routing copy
  const segTypes = new Map<string, CSegType>();
  const segs = city.segs.map((s) => {
    const b = base.get(s.id);
    if (!b) return s;
    const plain = segTypes.get(b.name) ?? typeOf(cat, b.name);
    if (!segTypes.has(b.name)) segTypes.set(b.name, plain);
    let name = b.name;
    const w = want.get(s.id);
    if (w !== undefined && hasVehicleLanes(plain) && laneInfo(plain).oneway !== w) {
      name = `${b.name} (${w ? 'one-way' : 'two-way'}, estimated)`;
      if (!segTypes.has(name)) segTypes.set(name, { ...plain, name, lanes: withDirection(plain, w) });
    }
    return { ...s, name };
  });
  return { city: { ...city, segs, segTypes }, stats };
}

/**
 * What the router gets for a city without lane data: the copy with estimated lanes, its one-way streets (none treated
 * as confirmed by traffic, since even "is it one-way" is a guess, so a route may break one with a warning) and tolls.
 */
export function routingCopy(city: CityData, cat: LaneCatalog): { city: CityData; oneway: OneWayResult; tolls: TollData; roads: Set<number>; stats: InferStats } {
  const est = inferLanes(city, cat);
  const rCity: CityData = { ...est.city, ...(city.extras ? { extras: { ...city.extras, caps: { ...city.extras.caps, lanesEstimated: true } } } : {}) };
  const ow = inferOneWay(rCity);
  const oneway = { ...ow, source: new Map([...ow.source].map(([id, src]) => [id, src === 'transit' ? 'keepright' as const : src])) };
  // toll lanes count only next to a real booth building: estimated toll widths with no booth would invent tolls
  const all = detectTolls(rCity), fake = new Set(all.booths.filter((b) => b.unconfirmed).map((b) => b.id));
  const keep = (m: Map<number, number>) => new Map([...m].filter(([, b]) => !fake.has(b)));
  const tolls: TollData = { booths: all.booths.filter((b) => !fake.has(b.id)), gateOf: keep(all.gateOf), boothOf: keep(all.boothOf), orphans: [] };
  // roads cars may use on the estimated lanes (what-if-it-closes needs them: the built map has no lanes)
  const roads = new Set(rCity.segs.filter((s) => !s.path && hasVehicleLanes(rCity.segTypes.get(s.name))).map((s) => s.id));
  return { city: rCity, oneway, tolls, roads, stats: est.stats };
}
