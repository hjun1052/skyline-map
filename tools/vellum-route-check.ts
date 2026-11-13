// Approximate .vellummap directions (src/lane-infer.ts): how close they come to the real routes.
//
// Each .cslmap city is stripped down to what a .vellummap holds (no prefab names, no lane table, no sub-building
// chains) and routed through the same path the worker uses (routingCopy → Router). The lane catalogue comes from the
// *other* cities only, so a city never sees its own lanes. Routes are compared with the true ones on the full export.
// With a single city (CI: the sample) the shipped catalogue is used instead, which is only a smoke test.
// Also routes the committed converted fixture (tools/fixtures/seorang.vellummap) through the real reader.
//
// The numbers describe these cities; they are not a promise for other cities, which may use other road mods.
//   npm run check:vellum-routes [files...] [--n=40]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import { parseCity, type CityData } from '../src/parse';
import { buildCity } from '../src/build';
import { Router, type Mode, type Route } from '../src/router';
import { inferOneWay } from '../src/oneway';
import { detectTolls } from '../src/tolls';
import { fromLngLat } from '../src/geo';
import { buildCatalog, routingCopy, type LaneCatalog } from '../src/lane-infer';
import { readVellummap, vellumToCity, roadTypeName } from '../src/vellummap';
import { createClosures, segInfoFrom } from '../src/closure';
import shipped from '../src/lane-catalog.json';

const dir = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const N = +(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? 40);
if (!files.length && existsSync(dir)) {
  const seen = new Set<string>();
  files = readdirSync(dir).filter((f) => /\.cslmap$/i.test(f)).sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)
    .filter((f) => { const c = f.normalize('NFC').replace(/-\d{8}-\d{6}\.cslmap$|\.cslmap$/i, ''); return !seen.has(c) && seen.add(c); }).map((f) => path.join(dir, f));
}
if (!files.length) files = ['public/samples/seorang.cslmap.gz'];
const load = (f: string) => { const b = readFileSync(f); return parseCity((f.endsWith('.gz') ? gunzipSync(b) : b).toString('utf8')); };
const cities = files.map((f) => ({ name: path.basename(f).normalize('NFC'), city: load(f) }));

let failures = 0;
const fail = (m: string) => { failures++; console.error('  ✗ ' + m); };

/** what a .vellummap holds of this city: class + width per road, no prefab names, lanes or building chains */
function strip(c: CityData): CityData {
  return {
    ...c, segTypes: new Map(),
    segs: c.segs.map((s) => (s.path ? s : { ...s, name: roadTypeName(s.icls, s.width) })),
    buildings: c.buildings.map((b) => ({ ...b, parent: 0, sub: 0 })),
    extras: { source: 'vellummap', caps: { lanes: false, buildingParts: false }, producer: 'test', districtStats: new Map(), stopInfo: new Map() },
  };
}
const coords = (r: Route) => r.legs.flatMap((l) => l.coords).map((p) => fromLngLat(p[0], p[1]));
/** share of route A's length that runs within 8 m of route B */
function overlap(a: Route, b: Route) {
  const A = coords(a), B = coords(b), g = new Map<string, [number, number][]>();
  for (let i = 1; i < B.length; i++) {
    const n = Math.ceil(Math.hypot(B[i][0] - B[i - 1][0], B[i][1] - B[i - 1][1]) / 4);
    for (let k = 0; k <= n; k++) { const x = B[i - 1][0] + ((B[i][0] - B[i - 1][0]) * k) / n, z = B[i - 1][1] + ((B[i][1] - B[i - 1][1]) * k) / n, key = `${Math.floor(x / 10)},${Math.floor(z / 10)}`; (g.get(key) ?? g.set(key, []).get(key)!).push([x, z]); }
  }
  let on = 0, tot = 0;
  for (let i = 1; i < A.length; i++) {
    const L = Math.hypot(A[i][0] - A[i - 1][0], A[i][1] - A[i - 1][1]), mx = (A[i][0] + A[i - 1][0]) / 2, mz = (A[i][1] + A[i - 1][1]) / 2;
    tot += L;
    let ok = false;
    for (let dx = -1; dx <= 1 && !ok; dx++) for (let dz = -1; dz <= 1 && !ok; dz++) ok = (g.get(`${Math.floor(mx / 10) + dx},${Math.floor(mz / 10) + dz}`) ?? []).some((p) => Math.hypot(p[0] - mx, p[1] - mz) < 8);
    if (ok) on += L;
  }
  return tot ? on / tot : 1;
}
const q = (xs: number[], f: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(f * (s.length - 1))] ?? NaN; };
type Tally = { trips: number; found: number; ratio: number[]; same: number[]; against: number };
const tally = (): Tally => ({ trips: 0, found: 0, ratio: [], same: [], against: 0 });
const line = (t: Tally) => {
  const w = (x: number) => (t.ratio.length ? Math.round((100 * t.ratio.filter((r) => Math.abs(r - 1) <= x).length) / t.ratio.length) : 0);
  return `found ${t.found}/${t.trips}, time within 10% ${w(0.1)}% / 25% ${w(0.25)}%, ratio p10 ${q(t.ratio, 0.1).toFixed(2)} p90 ${q(t.ratio, 0.9).toFixed(2)}, same path median ${Math.round(100 * q(t.same, 0.5))}% p10 ${Math.round(100 * q(t.same, 0.1))}%${t.against ? `, ${t.against} against a likely one-way` : ''}`;
};

// fallbacks for networks the catalogue has never seen
{
  const cat = shipped as unknown as LaneCatalog;
  const seg = (id: number, icls: string, width: number) => ({ id, sn: 1, en: 2, icls, width, name: icls, customName: '', pts: [{ x: 0, y: 0, z: 0 }, { x: 50, y: 0, z: 0 }], path: null });
  const probe: CityData = { ...cities[0].city, segs: [seg(1, 'Ship Path', 32), seg(2, 'Water Pipe', 9), seg(3, 'MadeUpHighway5L GroundClass', 26), seg(4, 'MadeUp Road 2L2W', 16), seg(5, 'Made Up Pedestrian Way', 7), seg(6, 'Made Up Metro Track', 12)], buildings: [], transports: [] };
  const r = routingCopy(probe, cat).city;
  const st = (id: number) => r.segTypes.get(r.segs.find((x) => x.id === id)!.name);
  const cars = (id: number) => !!st(id)?.lanes.some((l) => l.type.includes('Vehicle') && l.vType.split(',').some((v) => v.trim() === 'Car'));
  if (st(1) || st(2)) fail('ship paths and pipes must not get lanes');
  if (!cars(3) || !st(3)!.highway) fail('an unknown highway class should drive like a highway');
  if (!cars(4) || st(4)!.lanes.filter((l) => l.type.includes('Vehicle')).every((l) => l.dir === st(4)!.lanes.find((x) => x.type.includes('Vehicle'))!.dir)) fail('a "2L2W" class should be a two-way road');
  if (!st(5) || cars(5) || !st(5)!.lanes.some((l) => l.type.includes('Pedestrian'))) fail('an unknown path class should be a footpath');
  if (!st(6) || cars(6)) fail('an unknown metro class should be track');
}

const MODES: Mode[] = ['drive', 'walk', 'transit'];
const all: Record<string, Tally> = Object.fromEntries(MODES.map((m) => [m, tally()]));
const loo = cities.length > 1;
if (!loo) console.log('one city: using the shipped catalogue (a smoke test, not a fair accuracy test)');

/** route random trips on the true and the estimated network, and compare */
function compare(name: string, truth: CityData, approx: { router: Router }, seedBase: number) {
  const tr = new Router(truth, new Map(), inferOneWay(truth), detectTolls(truth));
  const nodes = [...truth.nodes.values()].filter((n) => !n.ug && n.srv === 'Road');
  for (const mode of MODES) {
    const t = tally();
    let seed = seedBase + mode.length;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < N * 6 && t.trips < N; i++) {
      const a = nodes[Math.floor(rnd() * nodes.length)], b = nodes[Math.floor(rnd() * nodes.length)];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 800 || (mode === 'walk' && d > 3500)) continue;
      const T = tr.route([a.x, a.z], [b.x, b.z], mode, {})[0];
      if (!T) continue;
      t.trips++;
      const B = approx.router.route([a.x, a.z], [b.x, b.z], mode, {})[0];
      if (!B) continue;
      t.found++; t.ratio.push(B.time / T.time); t.same.push(overlap(B, T));
      if (B.againstLikelyOneWay?.length) t.against++;
      if (B.legs.some((l) => l.spans?.some((x) => x.limit !== undefined))) fail(`${name}: an estimated speed is shown as a speed limit`);
    }
    console.log(`  ${mode.padEnd(7)} ${line(t)}`);
    const A = all[mode]; A.trips += t.trips; A.found += t.found; A.ratio.push(...t.ratio); A.same.push(...t.same); A.against += t.against;
    if (t.trips && t.found < t.trips) fail(`${name} ${mode}: ${t.trips - t.found} trips have a real route but no approximate one`);
  }
}

cities.forEach(({ name, city }, ci) => {
  const cat: LaneCatalog = loo ? buildCatalog(cities.filter((_, j) => j !== ci).map((x) => x.city)) : (shipped as unknown as LaneCatalog);
  const rc = routingCopy(strip(city), cat);
  const s = rc.stats;
  console.log(`\n${name}: ${s.segments} segments, ${s.known} by class + width, ${s.family} by road family, ${s.none} without lanes; evidence: ${s.onewayByEvidence} one-way, ${s.twowayByEvidence} two-way`);
  // nothing in the estimated copy may claim a direction confirmed by traffic, or a posted speed limit
  if ([...rc.oneway.source.values()].includes('transit')) fail(`${name}: a one-way street is marked confirmed by traffic`);
  const router = new Router(rc.city, new Map(), rc.oneway, rc.tolls);
  compare(name, city, { router }, 7 + ci);
});

console.log('\nAll cities');
for (const m of MODES) console.log(`  ${m.padEnd(7)} ${line(all[m])}`);
// floors well under what the test cities reach, so a regression trips them; not an accuracy promise
const within = (m: string, x: number) => all[m].ratio.filter((r) => Math.abs(r - 1) <= x).length / Math.max(1, all[m].ratio.length);
if (loo) {
  if (within('drive', 0.25) < 0.85) fail(`drive: only ${Math.round(100 * within('drive', 0.25))}% of times within 25%`);
  if (within('walk', 0.1) < 0.95) fail(`walk: only ${Math.round(100 * within('walk', 0.1))}% of times within 10%`);
  if (within('transit', 0.1) < 0.9) fail(`transit: only ${Math.round(100 * within('transit', 0.1))}% of times within 10%`);
}

// the converted fixture through the real reader: the same city as the sample, so routes should be close
const fx = 'tools/fixtures/seorang.vellummap', sample = 'public/samples/seorang.cslmap.gz';
if (existsSync(fx) && existsSync(sample)) {
  (async () => {
    const vc = vellumToCity(await readVellummap(new Uint8Array(readFileSync(fx))));
    const rc = routingCopy(vc, shipped as unknown as LaneCatalog);
    const built = buildCity(vc, () => {}, inferOneWay(vc), detectTolls(vc));
    console.log(`\nfixture ${fx} (real reader, shipped catalogue): ${rc.stats.known + rc.stats.family}/${rc.stats.segments} segments with lanes`);
    const before = all.drive.trips;
    const fxRouter = new Router(rc.city, built.stopNames ?? new Map(), rc.oneway, rc.tolls);
    compare('fixture', load(sample), { router: fxRouter }, 99);
    // what-if-it-closes must close ordinary car roads (the built map has no lanes; the estimated ones decide)
    const cl = createClosures(rc.city, fxRouter, segInfoFrom(built, rc.roads), built.stopNames ?? new Map());
    const cars = rc.city.segs.filter((x) => rc.roads.has(x.id) && !/Highway/.test(x.icls)).slice(0, 400).filter((_, i) => i % 40 === 0);
    const closed = cars.filter((x) => cl.analyze({ kind: 'road', seg: x.id })).length;
    console.log(`  closures: ${closed}/${cars.length} car roads can be closed`);
    if (!cars.length || closed < cars.length) fail(`fixture: only ${closed}/${cars.length} car roads can be closed`);
    // toll gates only next to real booth buildings
    if (rc.tolls.booths.some((x) => x.unconfirmed)) fail('fixture: estimated toll lanes without a booth count as tolls');
    if (all.drive.trips === before) fail('fixture: no trips');
    done();
  })().catch((e) => { fail('fixture: ' + e); done(); });
} else done();

function done() {
  if (failures) { console.error(`\n${failures} problems`); process.exit(1); }
  console.log('\nvellum route checks passed (these numbers describe the test cities, not a guarantee for others)');
}
