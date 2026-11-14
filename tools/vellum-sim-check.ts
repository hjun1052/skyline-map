// A save (.crp) on a .vellummap: checked on a real matched set — a Vellum Bridge export, the save it was made from, and
// the CSLMapView export written with that save. Local only (needs the three files), like check:sim.
//   npm run check:vellum-sim -- <bridge.vellummap> <save.crp> <export.cslmap>
// With no arguments it looks for the newest 서랑시 files in the usual folders and skips when they are missing.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readVellummap, vellumToCity } from '../src/vellummap';
import { parseCity } from '../src/parse';
import { loadSim, type SimData } from '../src/sim/index';
import { routingCopy, buildCatalog } from '../src/lane-infer';
import { Router } from '../src/router';
import { inferOneWay } from '../src/oneway';
import { detectTolls } from '../src/tolls';
import { buildCity } from '../src/build';

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
ok(V.rulesSummary!.oneway === C.rulesSummary!.oneway && V.rulesSummary!.uturnBan >= C.rulesSummary!.uturnBan * 0.98 && V.tmpe!.segs.length >= C.tmpe!.segs.length * 0.95, 'one-ways exact; TM:PE and U-turn rules placed', { vellum: V.rulesSummary, cslmap: C.rulesSummary, tmpe: [V.tmpe!.segs.length, C.tmpe!.segs.length] });
ok(!!V.savedLanes && V.savedLanes.exact / V.savedLanes.roads > 0.9, 'most driving roads get their real lanes from the save', V.savedLanes);
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
ok(within >= 0.95, `driving with the save matches CSLMapView + save (${trips} trips, within 5%)`, `${Math.round(100 * within)}%`);
if (failures) { console.error(`${failures} problems`); process.exit(1); }
console.log('vellum sim checks passed');
