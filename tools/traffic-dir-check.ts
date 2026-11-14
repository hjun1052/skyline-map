// Direction-aware traffic (src/sim/directional.ts) against real saves on this computer. Local only, like check:sim.
//   npm run check:traffic-dir
// Saves:   $CS_SAVES_DIR  (default: the game's Saves folder on macOS)
// Exports: $CSLMAP_DIR    (default: CSLMapView's folder in the game install)
// Pairs are found by time: CSLMapView's "Auto export on saving game" writes the export a few seconds before the save.
// Without pairs the check skips. What it measures:
//  1. vehicles are placed on the right direction (moving ones travel the way their lane runs), and a mirrored lane
//     mapping (as an unhandled left-hand-traffic city would give) is caught by the same check and switched off;
//  2. the split keeps each segment's lane-weighted average equal to the game's density;
//  3. twin carriageways (two one-way segments of one road, each with its own density from the game) taken as one
//     two-way road: the split against one value for both directions, with the model refitted without the city tested
//     (leave-one-city-out), by city, road type, length and evidence, and how often a clear split points the wrong way;
//  4. ordinary two-way streets, which have no ground truth: split-half agreement (even vs odd vehicles), compared with
//     the same agreement on twin carriageways, where the accuracy is known.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCity, type CityData } from '../src/parse';
import { readCrp, openSaveData, ASSET_DATA } from '../src/sim/reader';
import { readNet } from '../src/sim/net';
import { readBuildings } from '../src/sim/buildings';
import { validate, M } from '../src/sim/validate';
import { readVehicles, readPaths, type SaveVehicles } from '../src/sim/vehicles';
import { Router } from '../src/router';
import { inferOneWay } from '../src/oneway';
import { detectTolls } from '../src/tolls';
import { trafficFactor } from '../src/sim/traffic';
import { dirFeatures, splitDensity, directionalTraffic, directionCheck, MIN_EVIDENCE, MODEL, CHECK_SHARE, type DirFeatures, type DirSide } from '../src/sim/directional';

const SAVES = process.env.CS_SAVES_DIR ?? path.join(os.homedir(), 'Library/Application Support/Colossal Order/Cities_Skylines/Saves');
const EXPORTS = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
let failures = 0;
const ok = (c: boolean, what: string, got?: unknown) => { console.log(`${c ? '  ✓' : '  ✗'} ${what}${got !== undefined ? '  → ' + JSON.stringify(got) : ''}`); if (!c) failures++; };
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const corr = (a: number[], b: number[]) => { const ma = mean(a), mb = mean(b); let n = 0, x = 0, y = 0; a.forEach((v, i) => { n += (v - ma) * (b[i] - mb); x += (v - ma) ** 2; y += (b[i] - mb) ** 2; }); return n / Math.sqrt(x * y); };

if (!existsSync(SAVES) || !existsSync(EXPORTS)) { console.log('traffic-dir check skipped: no saves or exports here'); process.exit(0); }
const exportsByTime = readdirSync(EXPORTS).filter((f) => /\.cslmap$/i.test(f)).map((f) => ({ f: path.join(EXPORTS, f), t: statSync(path.join(EXPORTS, f)).mtimeMs }));
const pairs = readdirSync(SAVES).filter((f) => f.endsWith('.crp')).map((f) => path.join(SAVES, f))
  .map((s) => { const t = statSync(s).mtimeMs; const e = exportsByTime.find((x) => x.t <= t && t - x.t < 15000); return e ? { save: s, export: e.f } : null; })
  .filter((x): x is { save: string; export: string } => !!x);

type Twin = { city: string; kind: string; len: number; ta: number; tb: number; a: DirSide; b: DirSide };
type OneWay = { city: string; x: number[]; y: number };
const twins: Twin[] = [], oneWays: OneWay[] = [];
const half: { twin: [number, number, number][]; street: [number, number, number][] } = { twin: [], street: [] };
let consist: { n: number; colour: number; time: number; nav: number } | null = null;
let velOk = 0, velN = 0, mirOk = 0, mirN = 0, mirOff = 0, sumErr = 0, sumN = 0, saves = 0, ms = 0, segs = 0, shown = 0;
const side = (x: DirFeatures) => (x.f.lanes ? x.f : x.b);
const kindOf = (c: CityData, name: string) => (/ramp|slip|link/i.test(name) ? 'ramp' : c.segTypes.get(name)?.highway ? 'highway' : 'road');
/** the vehicles with even (0) or odd (1) index */
const halfOf = (v: SaveVehicles, k: number): SaveVehicles => {
  const idx = [...Array(v.n).keys()].filter((i) => i % 2 === k), pick = <T extends Uint8Array | Uint32Array | Float32Array>(a: T) => a.filter((_, i) => i % 2 === k) as T;
  return { frame: v.frame, n: idx.length, path: pick(v.path), pathIndex: pick(v.pathIndex), velX: pick(v.velX), velZ: pick(v.velZ), posX: pick(v.posX), posZ: pick(v.posZ), block: pick(v.block), length: pick(v.length) };
};
const share = (x: DirFeatures) => { const r = splitDensity(50, x); return x.f.lanes && x.b.lanes ? r.f / (r.f + r.b) : 0.5; };

for (const p of pairs) {
  const b = new Uint8Array(readFileSync(p.save)); const de = readCrp(b).entries.find((e) => e.type === ASSET_DATA);
  if (!de) continue;
  const sd = openSaveData(b.subarray(de.offset, de.offset + de.size));
  if (sd.version !== 121034 || sd.leftHandTraffic) continue;
  const c = parseCity(readFileSync(p.export, 'utf8'));
  const net = readNet(sd), m = validate(c, net, readBuildings(sd), null).m.seg;
  if (m.filter((x) => x === M.Verified).length < 100) continue; // not this save's export after all
  const t0 = performance.now();
  const veh = readVehicles(sd), paths = readPaths(sd);
  const verified = (id: number) => m[id] === M.Verified;
  const dt = directionalTraffic(c, net, verified, veh, paths);
  ms += performance.now() - t0; saves++;
  // 1. directions: as read, and mirrored (what an unhandled left-hand city would look like)
  const chk = directionCheck(c, net, verified, veh, paths), mir = directionCheck(c, net, verified, veh, paths, undefined, true);
  velOk += chk.agree; velN += chk.moving; mirOk += mir.agree; mirN += mir.moving; if (mir.agree / mir.moving < CHECK_SHARE) mirOff++;
  if (!dt) { ok(false, `${path.basename(p.save)}: directions not confirmed by its vehicles`, chk); continue; }
  const feats = dirFeatures(c, net, verified, veh, paths);
  const segById = new Map(c.segs.map((s) => [s.id, s]));
  // 2. the lane-weighted average of the split equals the game's density (unless a side was capped at 100 %)
  dt.ids.forEach((id, k) => { const x = feats.get(id)!; const lf = x.f.lanes, lb = x.b.lanes, dens = net.segTraffic[id];
    if (dt.f[k] < 100 && dt.b[k] < 100) { sumErr += Math.abs((dt.f[k] * lf + dt.b[k] * lb) / (lf + lb) - dens); sumN++; } segs++; if (dt.trusted[k]) shown++; });
  // training rows for leave-one-city-out: one-way segments, features as laneWeight uses them
  for (const x of feats.values()) {
    if ((!x.f.lanes) === (!x.b.lanes) || x.len < 30) continue;
    const s_ = side(x), area = x.len * s_.lanes;
    oneWays.push({ city: c.name, x: [s_.occ / area, (s_.demand / area) * 100, 1], y: net.segTraffic[x.seg] });
  }
  // 3. twin carriageways
  const one = [...feats.values()].filter((x) => (!x.f.lanes) !== (!x.b.lanes) && x.len >= 40);
  const geo = (x: DirFeatures) => { const s = segById.get(x.seg)!, a = s.pts[0], z = s.pts[s.pts.length - 1], d = x.f.lanes ? 1 : -1, L = Math.hypot(z.x - a.x, z.z - a.z) || 1;
    return { mx: (a.x + z.x) / 2, mz: (a.z + z.z) / 2, ux: ((z.x - a.x) * d) / L, uz: ((z.z - a.z) * d) / L, lanes: x.f.lanes || x.b.lanes, name: s.name }; };
  const G = new Map(one.map((x) => [x.seg, geo(x)])), used = new Set<number>(), twinSegs: [number, number][] = [];
  for (const x of one) {
    if (used.has(x.seg)) continue; const g = G.get(x.seg)!;
    const y = one.find((o) => o !== x && !used.has(o.seg) && (() => { const h = G.get(o.seg)!; return g.ux * h.ux + g.uz * h.uz < -0.95 && Math.hypot(g.mx - h.mx, g.mz - h.mz) < 45 && h.lanes === g.lanes && h.name === g.name && x.len / o.len > 0.75 && x.len / o.len < 1.33; })());
    if (!y) continue; used.add(x.seg); used.add(y.seg); twinSegs.push([x.seg, y.seg]);
    const ta = net.segTraffic[x.seg], tb = net.segTraffic[y.seg];
    if ((ta + tb) / 2 >= 10) twins.push({ city: c.name, kind: kindOf(c, segById.get(x.seg)!.name), len: (x.len + y.len) / 2, ta, tb, a: side(x), b: side(y) });
  }
  // 5. consistency (first save only): roads busy one way and quiet the other, driven both ways
  if (!consist) consist = { n: 0, colour: 0, time: 0, nav: 0 };
  if (consist.n < 60) {
    const R = new Router(c, new Map(), inferOneWay(c), detectTolls(c));
    const tids: number[] = [], tp: number[] = []; for (let id = 1; id < net.segTraffic.length; id++) if (verified(id) && c.segTypes.has(segById.get(id)?.name ?? '')) { tids.push(id); tp.push(net.segTraffic[id]); }
    R.applyTraffic(tids, tp, dt); R.setTraffic(true);
    const asym = [...dt.ids].map((id, k) => ({ id, k })).filter(({ k }) => dt.trusted[k] && Math.abs(dt.f[k] - dt.b[k]) >= 40 && Math.max(dt.f[k], dt.b[k]) >= 60).slice(0, 40);
    for (const { id, k } of asym) {
      const s = segById.get(id)!; if (s.pts.length < 2) continue;
      // points 30 % and 70 % along the road; only routes that stay on it (about that long) count
      const cum = [0]; for (let i = 1; i < s.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(s.pts[i].x - s.pts[i - 1].x, s.pts[i].z - s.pts[i - 1].z));
      const L = cum[cum.length - 1]; if (L < 60) continue;
      const at = (f: number): [number, number] => { const d = f * L; let i = 1; while (i < cum.length - 1 && cum[i] < d) i++; const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1); return [s.pts[i - 1].x + (s.pts[i].x - s.pts[i - 1].x) * t, s.pts[i - 1].z + (s.pts[i].z - s.pts[i - 1].z) * t]; };
      const A = at(0.3), B = at(0.7);
      const fw = R.route(A, B, 'drive', {})[0], bw = R.route(B, A, 'drive', {})[0];
      if (!fw || !bw || fw.dist > 0.4 * L * 1.3 + 40 || bw.dist > 0.4 * L * 1.3 + 40) continue;
      const pieceOf = (r: typeof fw) => r.legs[0].traffic?.find((p) => p.seg === id);
      const pf = pieceOf(fw), pbk = pieceOf(bw);
      if (!pf || !pbk) continue;
      consist.n++;
      // route colour follows the direction driven
      if (Math.abs(pf.pct - dt.f[k]) <= 1 && Math.abs(pbk.pct - dt.b[k]) <= 1) consist.colour++;
      else if (process.env.DEBUG) console.log('colour', id, { f: dt.f[k], b: dt.b[k], pf, pbk, fwPieces: fw.legs[0].traffic, segs: s.pts.length });
      // the slower direction takes longer per metre than the quieter one (same road, same length) when traffic slows it
      const ff = trafficFactor(dt.f[k]), fb = trafficFactor(dt.b[k]);
      if (ff === fb || (fw.time / fw.dist > bw.time / bw.dist) === (ff > fb)) consist.time++;
      // the navigation drive speed (spans) follows the same direction
      const vf = fw.legs[0].spans?.[0]?.v ?? 0, vb = bw.legs[0].spans?.[0]?.v ?? 0;
      if (ff === fb || (vf < vb) === (ff > fb)) consist.nav++;
    }
  }
  // 4. split-half agreement: even and odd vehicles give two independent estimates
  const fa = dirFeatures(c, net, verified, halfOf(veh, 0), paths), fb = dirFeatures(c, net, verified, halfOf(veh, 1), paths);
  for (const [s1, s2] of twinSegs) {
    const A = { seg: s1, len: feats.get(s1)!.len, f: side(fa.get(s1)!), b: side(fa.get(s2)!) }, B = { seg: s1, len: feats.get(s1)!.len, f: side(fb.get(s1)!), b: side(fb.get(s2)!) };
    const ea = A.f.present + A.b.present + A.f.demand + A.b.demand, eb = B.f.present + B.b.present + B.f.demand + B.b.demand;
    if (ea >= 2 && eb >= 2) half.twin.push([share(A), share(B), Math.min(ea, eb)]);
  }
  for (const id of dt.ids) {
    const A = fa.get(id)!, B = fb.get(id)!, e = (x: DirFeatures) => x.f.present + x.b.present + x.f.demand + x.b.demand;
    if (e(A) >= 2 && e(B) >= 2) half.street.push([share(A), share(B), Math.min(e(A), e(B))]);
  }
}
if (!saves) { console.log('traffic-dir check skipped: no same-moment save + export pairs (format 121034) here'); process.exit(0); }

/** least squares for the three laneWeight terms (normal equations, 3×3) */
function fit(rows: OneWay[]) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
  for (const r of rows) for (let i = 0; i < 3; i++) { v[i] += r.x[i] * r.y; for (let j = 0; j < 3; j++) A[i][j] += r.x[i] * r.x[j]; }
  for (let i = 0; i < 3; i++) { const p = A[i][i]; for (let j = i; j < 3; j++) A[i][j] /= p; v[i] /= p; for (let k = 0; k < 3; k++) if (k !== i) { const f = A[k][i]; for (let j = i; j < 3; j++) A[k][j] -= f * A[i][j]; v[k] -= f * v[i]; } }
  return { occ: v[0], demand: v[1] / 1, c: v[2] };
}
const cities = [...new Set(twins.map((t) => t.city))];
type Res = { naive: number[]; split: number[]; right: number; n: number; wrongClear: number; clear: number };
const empty = (): Res => ({ naive: [], split: [], right: 0, n: 0, wrongClear: 0, clear: 0 });
const score = (r: Res, t: Twin, model: typeof MODEL, minEv = MIN_EVIDENCE) => {
  const agg = (t.ta + t.tb) / 2, x = { seg: 0, len: t.len, f: t.a, b: t.b }, s = splitDensity(agg, x, model), use = s.evidence >= minEv;
  const ea = use ? s.f : agg, eb = use ? s.b : agg;
  r.naive.push(Math.abs(agg - t.ta), Math.abs(agg - t.tb)); r.split.push(Math.abs(ea - t.ta), Math.abs(eb - t.tb));
  if (Math.abs(t.ta - t.tb) >= 20 && use) { r.n++; if ((ea > eb) === (t.ta > t.tb)) r.right++; }
  if (use && Math.abs(ea - eb) >= 20) { r.clear++; if (Math.abs(t.ta - t.tb) >= 10 && (ea > eb) !== (t.ta > t.tb)) r.wrongClear++; }
};
const fmt = (r: Res) => ({ pairs: r.naive.length / 2, naive: +mean(r.naive).toFixed(2), split: +mean(r.split).toFixed(2), busierRight: r.n ? `${r.right}/${r.n}` : '-', clearButWrong: r.clear ? `${r.wrongClear}/${r.clear}` : '-' });
const fixed = empty(), loco = empty(), byCity = new Map<string, Res>(), byKind = new Map<string, Res>(), byLen = new Map<string, Res>(), byEv = new Map<string, Res>();
const models = new Map(cities.map((c) => [c, fit(oneWays.filter((r) => r.city !== c))]));
for (const t of twins) {
  const lm = models.get(t.city)!;
  score(fixed, t, MODEL); score(loco, t, lm);
  for (const [map, key] of [[byCity, t.city], [byKind, t.kind], [byLen, t.len < 80 ? '40-80 m' : t.len < 160 ? '80-160 m' : '160 m+'],
    [byEv, (() => { const e = t.a.present + t.b.present + t.a.demand + t.b.demand; return e < 2 ? '0-1' : e < 5 ? '2-4' : e < 10 ? '5-9' : e < 20 ? '10-19' : '20+'; })()]] as [Map<string, Res>, string][]) {
    if (!map.has(key)) map.set(key, empty()); score(map.get(key)!, t, lm, 0);
  }
}
console.log(`\n${saves} saves, ${segs} two-way segments split (${Math.round((100 * shown) / Math.max(1, segs))}% with enough evidence), ${Math.round(ms / saves)} ms per save`);
console.log('\nTwin carriageways (error per direction in density points; naive = both directions get the combined value)');
console.log('  model fitted on all cities:', fmt(fixed));
console.log('  refitted without the city tested:', fmt(loco));
for (const [k, r] of byCity) console.log(`  city ${k}:`, fmt(r));
for (const [k, r] of byKind) console.log(`  ${k}:`, fmt(r));
for (const [k, r] of byLen) console.log(`  length ${k}:`, fmt(r));
for (const k of ['0-1', '2-4', '5-9', '10-19', '20+']) if (byEv.has(k)) console.log(`  evidence ${k} (split at any evidence):`, fmt(byEv.get(k)!));
const hc = (a: [number, number, number][]) => ({ n: a.length, r: +corr(a.map((x) => x[0]), a.map((x) => x[1])).toFixed(3), sameSide: +(a.filter(([p, q]) => (p - 0.5) * (q - 0.5) > 0).length / Math.max(1, a.length)).toFixed(3) });
console.log('\nSplit-half agreement of the share (even vs odd vehicles): twin carriageways', hc(half.twin), 'two-way streets', hc(half.street));
for (const [lo, hi] of [[2, 5], [5, 10], [10, 20], [20, 1e9]]) {
  const sel = (a: [number, number, number][]) => a.filter((x) => x[2] >= lo && x[2] < hi);
  // clear in one half (20+ points apart on a 50 % road): does the other half agree on the side?
  const clear = (a: [number, number, number][]) => { const c = sel(a).filter((x) => Math.abs(x[0] - 0.5) >= 0.1); return c.length ? +(c.filter(([p, q]) => (p - 0.5) * (q - 0.5) > 0).length / c.length).toFixed(3) + ` of ${c.length}` : '-'; };
  console.log(`  evidence per half ${lo}-${hi === 1e9 ? '' : hi - 1}: twins`, hc(sel(half.twin)), 'clear agree', clear(half.twin), '| streets', hc(sel(half.street)), 'clear agree', clear(half.street));
}

console.log('');
ok(velN > 1000 && velOk / velN > 0.99, 'moving vehicles travel the way their lane runs', `${velOk}/${velN}`);
ok(mirOff === saves && mirOk / mirN < 0.05, 'a mirrored lane mapping is caught on every save (directions would be switched off)', `${mirOk}/${mirN}`);
ok(sumN > 1000 && sumErr / sumN < 0.6, 'the split keeps the lane-weighted average at the game\'s density (rounding only)', +(sumErr / Math.max(1, sumN)).toFixed(2));
ok(loco.naive.length > 500 && mean(loco.split) < mean(loco.naive) * 0.8, 'twin carriageways, city held out: splitting beats one value for both directions', fmt(loco));
ok(loco.n > 100 && loco.right / loco.n > 0.8, 'twin carriageways, city held out: the busier direction is right when they differ by 20+ points', `${loco.right}/${loco.n}`);
ok(loco.clear > 50 && loco.wrongClear / loco.clear < 0.1, 'a clear split (20+ points) rarely points the wrong way', `${loco.wrongClear}/${loco.clear}`);
if (consist) {
  ok(consist.n >= 10 && consist.colour === consist.n, 'route colours use the direction driven on roads busy one way only', consist);
  ok(consist.n >= 10 && consist.time >= consist.n * 0.9, 'travel times follow the direction driven (quiet direction not penalised)', `${consist.time}/${consist.n}`);
  ok(consist.n >= 10 && consist.nav >= consist.n * 0.9, 'navigation speeds follow the direction driven', `${consist.nav}/${consist.n}`);
}
ok(ms / saves < 400, 'fast enough for the browser', `${Math.round(ms / saves)} ms`);
if (failures) { console.error(`${failures} problems`); process.exit(1); }
console.log('traffic-dir checks passed (an estimate validated on these saves, not a guarantee for others)');
