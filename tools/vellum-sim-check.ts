// A save (.crp) on a .vellummap: checked on a real matched set — a Vellum Bridge export, the save it was made from, and
// the CSLMapView export written with that save. Local only (needs the three files), like check:sim.
//   npm run check:vellum-sim -- <bridge.vellummap> <save.crp> <export.cslmap>
// With no arguments it looks for the newest 서랑시 files in the usual folders and skips when they are missing.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readVellummap, vellumToCity, areaAt } from '../src/vellummap';
import { readCrp, openSaveData, loadBytes, ASSET_DATA } from '../src/sim/reader';
import { readDistrictData } from '../src/sim/city';
import { parseCity } from '../src/parse';
import { loadSim, type SimData } from '../src/sim/index';
import { routingCopy, buildCatalog } from '../src/lane-infer';
import { Router } from '../src/router';
import { inferOneWay } from '../src/oneway';
import { detectTolls } from '../src/tolls';
import { buildCity, laneInfo } from '../src/build';

const home = os.homedir();
const newest = (dir: string, re: RegExp) => (existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f.normalize('NFC'))).map((f) => path.join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] : undefined);
const exportDir = path.join(home, 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
const [vf, sf, cf] = process.argv.slice(2).length === 3 ? process.argv.slice(2) : [
  newest(path.join(home, 'Vellum Bridge', '서랑시'), /\.vellummap$/),
  path.join(home, 'Library/Application Support/Colossal Order/Cities_Skylines/Saves/!w_nweg_23%002E0%002E1.crp'),
  newest(exportDir, /^서랑시-20261107-234707\.cslmap$/),
];
if (!vf || !sf || !cf || ![vf, sf, cf].every((f) => existsSync(f))) { console.log('vellum sim check skipped: no matched Bridge export, save and CSLMapView export here'); process.exit(0); }

let failures = 0;
const ok = (c: boolean, what: string, got?: unknown) => { console.log(`${c ? '  ✓' : '  ✗'} ${what}${got !== undefined ? '  → ' + JSON.stringify(got) : ''}`); if (!c) failures++; };
const buf = (f: string) => { const b = readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const v = vellumToCity(await readVellummap(new Uint8Array(readFileSync(vf))));
const c = parseCity(readFileSync(cf, 'utf8'));
// the lane catalogue without this city, so lanes the save cannot name stay honest estimates
const seen = new Set<string>([c.name]);
const others = readdirSync(exportDir).filter((f) => /\.cslmap$/i.test(f)).sort((a, b) => statSync(path.join(exportDir, b)).mtimeMs - statSync(path.join(exportDir, a)).mtimeMs)
  .filter((f) => { const k = f.normalize('NFC').replace(/-\d{8}-\d{6}\.cslmap$|\.cslmap$/i, ''); return !seen.has(k) && seen.add(k); });
const cat = buildCatalog(others.map((f) => parseCity(readFileSync(path.join(exportDir, f), 'utf8'))));

const rv = await loadSim(buf(sf), v, () => {}, (saved) => routingCopy(v, cat, saved));
const rc = await loadSim(buf(sf), c, () => {});
ok(rv.ok && rc.ok, 'the save loads on both maps');
if (!rv.ok || !rc.ok) process.exit(1);
const V = rv as SimData, C = rc as SimData;
ok(V.v.verdict === 'match' && V.v.share.nodes === 1 && V.v.share.segments === 1 && V.v.share.buildings === 1, 'every node, road and building of the Bridge export matches the save', V.v.share);
ok(V.v.lines.verified === V.v.lines.exported, 'every transit line matches', V.v.lines);
// the save's values on the same objects are the same on both maps
const tv = new Map([...V.traffic!.ids].map((id, i) => [id, V.traffic!.pct[i]]));
const roads = new Set(c.segs.filter((s) => !s.path).map((s) => s.id));
let same = 0, n = 0; C.traffic!.ids.forEach((id, i) => { if (!roads.has(id) || !tv.has(id)) return; n++; if (tv.get(id) === C.traffic!.pct[i]) same++; });
ok(n > 9000 && same === n, 'traffic density identical on every shared road', `${same}/${n}`);
const bv = new Map([...V.buildings!.ids].map((id, i) => [id, V.buildings!.residents[i]]));
let bs = 0, bn = 0; C.buildings!.ids.forEach((id, i) => { if (!bv.has(id)) return; bn++; if (bv.get(id) === C.buildings!.residents[i]) bs++; });
ok(bn > 9000 && bs === bn, 'building occupancy identical on every shared building', `${bs}/${bn}`);
ok(V.lines!.length === C.lines!.filter((l) => V.lines!.some((x) => x.id === l.id)).length && V.lines!.every((l) => { const x = C.lines!.find((y) => y.id === l.id); return x && x.residents === l.residents && x.tourists === l.tourists; }), 'line ridership identical');
ok(!!V.grids && !!V.city && V.unavailable.length === 0, 'grids and city statistics read', V.unavailable);
// districts: the Bridge export's own grid and figures against the save's DistrictManager
{
  const bytes = await loadBytes(buf(sf)); const e = readCrp(bytes).entries.find((x) => x.type === ASSET_DATA)!;
  const dd = readDistrictData(openSaveData(bytes.subarray(e.offset, e.offset + e.size)));
  const G = 512, P = G * G, g = dd.grid, dg = v.extras!.districtGrid!;
  let n = 0, same = 0;
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const c = j * G + i; let id = 0, a = 0;
    for (let k = 0; k < 4; k++) if (g[k * P + c] && g[(4 + k) * P + c] > a) { a = g[(4 + k) * P + c]; id = g[k * P + c]; }
    const vv = areaAt(dg, (i + 0.5) * 19.2 - G * 9.6, (j + 0.5) * 19.2 - G * 9.6);
    if (!id && !vv) continue; n++; if (id === vv) same++;
  }
  ok(n > 10000 && same === n, 'district grid identical to the save on every cell the save covers (512², the central area)', `${same}/${n}`);
  let pn = 0, ps = 0; for (const [id, st] of v.extras!.districtStats) { const p = dd.pop.get(id); if (p === undefined) continue; pn++; if (p === st.population) ps++; }
  ok(pn > 30 && ps === pn, 'district populations identical to the save', `${ps}/${pn}`);
  const cn = new Map(c.districts.map((a) => [a.id, a.name]));
  ok(v.districts.every((a) => cn.get(a.id) === a.name), 'district ids and names identical to the CSLMapView export', v.districts.length);
}
ok(V.rulesSummary!.oneway === C.rulesSummary!.oneway && V.rulesSummary!.uturnBan >= C.rulesSummary!.uturnBan * 0.98 && V.tmpe!.segs.length >= C.tmpe!.segs.length * 0.95, 'one-ways exact; TM:PE and U-turn rules placed', { vellum: V.rulesSummary, cslmap: C.rulesSummary, tmpe: [V.tmpe!.segs.length, C.tmpe!.segs.length] });
ok(!!V.savedLanes && V.savedLanes.exact / V.savedLanes.roads > 0.9, 'most driving roads get their real lanes from the save', V.savedLanes);
// what the road panel shows from the save: the CSLMapView export's own values for the same road, wherever it shows any
{
  const cs = new Map(c.segs.map((x) => [x.id, x]));
  let known = 0, same = 0, unknownWithLanes = 0, bikeKnownRoads = 0, bikeSame = 0;
  for (const [id, f] of V.roadFacts!) {
    const x = cs.get(id); if (!x) continue;
    const li = laneInfo(c.segTypes.get(x.name));
    if (f.prefab !== x.name) continue;
    if (f.lanes === undefined) { if (f.speed !== undefined || f.oneway !== undefined) unknownWithLanes++; continue; }
    known++;
    if (f.lanes === li.vehicle && (f.speed ?? 0) === (li.speed > 0 && li.speed < 200 ? li.speed : 0) && f.oneway === li.oneway) same++;
    bikeKnownRoads++; if (!!f.bike === (li.bike || /Bicycle|Bike/i.test(x.name))) bikeSame++;
  }
  ok(known > 8000 && same === known && unknownWithLanes === 0, 'road panel facts from the save equal the CSLMapView export (lanes, speed limit, one-way)', `${same}/${known}`);
  ok(bikeSame === bikeKnownRoads, 'bike lanes from the save equal the CSLMapView export wherever the road type is known', `${bikeSame}/${bikeKnownRoads}`);
  ok(V.savedLanes!.lenShare > 0.9 && V.savedLanes!.lenShare <= 1, 'coverage is a share of road length', V.savedLanes!.lenShare.toFixed(3));
}
// driving on the save's lanes and rules against the CSLMapView export with the same save
const built = buildCity(v, () => {}, inferOneWay(v), detectTolls(v));
const RV = new Router(V.routing!.city, built.stopNames ?? new Map(), V.routing!.oneway, V.routing!.tolls); RV.applyRules(V.rules!);
const RC = new Router(c, new Map(), inferOneWay(c), detectTolls(c)); RC.applyRules(C.rules!);
const nodes = [...c.nodes.values()].filter((x) => !x.ug && x.srv === 'Road');
let seed = 41; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const ratio: number[] = []; let trips = 0;
for (let i = 0; i < 500 && trips < 60; i++) {
  const a = nodes[Math.floor(rnd() * nodes.length)], b = nodes[Math.floor(rnd() * nodes.length)];
  if (Math.hypot(a.x - b.x, a.z - b.z) < 800) continue;
  const T = RC.route([a.x, a.z], [b.x, b.z], 'drive', {})[0]; if (!T) continue; trips++;
  const S = RV.route([a.x, a.z], [b.x, b.z], 'drive', {})[0]; if (S) ratio.push(S.time / T.time);
}
const within = ratio.filter((r) => Math.abs(r - 1) <= 0.05).length / Math.max(1, trips);
// navigation: posted limits only from game data. Without the save none are shown; with it, every limit is one the
// CSLMapView + save router also shows somewhere on the network (prefab limits and TM:PE ones)
{
  const est = routingCopy(v, cat);
  const RE = new Router(est.city, built.stopNames ?? new Map(), est.oneway, est.tolls);
  const limits = (R: Router, a: number[], b: number[]) => (R.route(a as never, b as never, 'drive', {})[0]?.legs ?? []).flatMap((l) => l.spans ?? []).map((sp) => sp.limit).filter((x): x is number => !!x);
  let noSave = 0, withSave = 0, cslLimits = new Set<number>(), saveLimits = new Set<number>(); seed = 7;
  for (let i = 0; i < 40; i++) {
    const a = nodes[Math.floor(rnd() * nodes.length)], b = nodes[Math.floor(rnd() * nodes.length)];
    const p = [a.x, a.z], q = [b.x, b.z];
    noSave += limits(RE, p, q).length;
    const ls = limits(RV, p, q); withSave += ls.length; ls.forEach((x) => saveLimits.add(x));
    limits(RC, p, q).forEach((x) => cslLimits.add(x));
  }
  ok(noSave === 0, 'navigation shows no speed limit without a save (estimated speeds are never posted limits)', noSave);
  ok(withSave > 0 && [...saveLimits].every((x) => cslLimits.has(x)), 'navigation shows real limits with the save, the same values as CSLMapView + save', { withSave, save: [...saveLimits].sort((a, b) => a - b), cslmap: [...cslLimits].sort((a, b) => a - b) });
}
ok(within >= 0.95, `driving with the save matches CSLMapView + save (${trips} trips, within 5%)`, `${Math.round(100 * within)}%`);
if (failures) { console.error(`${failures} problems`); process.exit(1); }
console.log('vellum sim checks passed');
