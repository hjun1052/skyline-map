// Direction-aware traffic (src/sim/directional.ts) against real saves on this computer. Local only, like check:sim.
//   npm run check:traffic-dir
// Saves:   $CS_SAVES_DIR  (default: the game's Saves folder on macOS)
// Exports: $CSLMAP_DIR    (default: CSLMapView's folder in the game install)
// Pairs are found by time: CSLMapView's "Auto export on saving game" writes the export a few seconds before the save.
// Without pairs the check skips. What it measures:
//  1. vehicles are placed on the right direction (moving ones travel the way their lane runs);
//  2. the split keeps each segment's lane-weighted average equal to the game's density;
//  3. on twin carriageways (two one-way segments of one road, each with its own density from the game) taken as one
//     two-way road, splitting their combined density beats giving both directions the combined value.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCity } from '../src/parse';
import { readCrp, openSaveData, ASSET_DATA } from '../src/sim/reader';
import { readNet } from '../src/sim/net';
import { readBuildings } from '../src/sim/buildings';
import { validate, M } from '../src/sim/validate';
import { readVehicles, readPaths } from '../src/sim/vehicles';
import { dirFeatures, splitDensity, directionalTraffic, MIN_EVIDENCE, type DirFeatures } from '../src/sim/directional';

const SAVES = process.env.CS_SAVES_DIR ?? path.join(os.homedir(), 'Library/Application Support/Colossal Order/Cities_Skylines/Saves');
const EXPORTS = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
let failures = 0;
const ok = (c: boolean, what: string, got?: unknown) => { console.log(`${c ? '  ✓' : '  ✗'} ${what}${got !== undefined ? '  → ' + JSON.stringify(got) : ''}`); if (!c) failures++; };

if (!existsSync(SAVES) || !existsSync(EXPORTS)) { console.log('traffic-dir check skipped: no saves or exports here'); process.exit(0); }
const exportsByTime = readdirSync(EXPORTS).filter((f) => /\.cslmap$/i.test(f)).map((f) => ({ f: path.join(EXPORTS, f), t: statSync(path.join(EXPORTS, f)).mtimeMs }));
const pairs = readdirSync(SAVES).filter((f) => f.endsWith('.crp')).map((f) => path.join(SAVES, f))
  .map((s) => { const t = statSync(s).mtimeMs; const e = exportsByTime.find((x) => x.t <= t && t - x.t < 15000); return e ? { save: s, export: e.f } : null; })
  .filter((x): x is { save: string; export: string } => !!x);

let velOk = 0, velN = 0, sumErr = 0, sumN = 0, saves = 0, ms = 0, segs = 0, shown = 0;
const naive: number[] = [], split: number[] = []; let dirRight = 0, dirN = 0;
for (const p of pairs) {
  const b = new Uint8Array(readFileSync(p.save)); const de = readCrp(b).entries.find((e) => e.type === ASSET_DATA);
  if (!de) continue;
  const sd = openSaveData(b.subarray(de.offset, de.offset + de.size));
  if (sd.version !== 121034) continue;
  const c = parseCity(readFileSync(p.export, 'utf8'));
  const net = readNet(sd), m = validate(c, net, readBuildings(sd), null).m.seg;
  if (m.filter((x) => x === M.Verified).length < 100) continue; // not this save's export after all
  const t0 = performance.now();
  const veh = readVehicles(sd), paths = readPaths(sd);
  const verified = (id: number) => m[id] === M.Verified;
  const dt = directionalTraffic(c, net, verified, veh, paths);
  ms += performance.now() - t0; saves++;
  const feats = dirFeatures(c, net, verified, veh, paths);
  // 1. direction of moving vehicles (their velocity against the segment's start→end vector)
  const segById = new Map(c.segs.map((s) => [s.id, s]));
  for (let v = 0; v < veh.n; v++) {
    const sp = Math.hypot(veh.velX[v], veh.velZ[v]); if (sp < 1) continue;
    const u = veh.path[v], i = (veh.pathIndex[v] === 255 ? 0 : veh.pathIndex[v]) >> 1; if (!u || i >= paths.count[u]) continue;
    const sg = paths.posSeg[paths.start[u] + i], ln = paths.posLane[paths.start[u] + i], s = segById.get(sg), st = s && c.segTypes.get(s.name), L = st?.lanes[ln];
    if (!s || !L || L.type !== 'Vehicle' || !verified(sg) || !/\bCar\b/.test(L.vType)) continue;
    const d = (L.dir === 'Forward' ? 1 : L.dir === 'Backward' ? -1 : 0) * ((net.segFlags[sg] & 16) ? -1 : 1); if (!d) continue;
    const a = s.pts[0], z = s.pts[s.pts.length - 1];
    velN++; if (veh.velX[v] * (z.x - a.x) * d + veh.velZ[v] * (z.z - a.z) * d > 0) velOk++;
  }
  // 2. the lane-weighted average of the split equals the game's density (unless a side was capped at 100 %)
  dt.ids.forEach((id, k) => { const x = feats.get(id)!; const lf = x.f.lanes, lb = x.b.lanes, dens = net.segTraffic[id];
    if (dt.f[k] < 100 && dt.b[k] < 100) { sumErr += Math.abs((dt.f[k] * lf + dt.b[k] * lb) / (lf + lb) - dens); sumN++; } segs++; if (dt.evidence[k] >= MIN_EVIDENCE) shown++; });
  // 3. twin carriageways
  const one = [...feats.values()].filter((x) => (!x.f.lanes) !== (!x.b.lanes) && x.len >= 40);
  const geo = (x: DirFeatures) => { const s = segById.get(x.seg)!, a = s.pts[0], z = s.pts[s.pts.length - 1], d = x.f.lanes ? 1 : -1, L = Math.hypot(z.x - a.x, z.z - a.z) || 1;
    return { mx: (a.x + z.x) / 2, mz: (a.z + z.z) / 2, ux: ((z.x - a.x) * d) / L, uz: ((z.z - a.z) * d) / L, lanes: x.f.lanes || x.b.lanes, name: s.name }; };
  const G = new Map(one.map((x) => [x.seg, geo(x)])), used = new Set<number>();
  for (const x of one) {
    if (used.has(x.seg)) continue; const g = G.get(x.seg)!;
    const y = one.find((o) => o !== x && !used.has(o.seg) && (() => { const h = G.get(o.seg)!; return g.ux * h.ux + g.uz * h.uz < -0.95 && Math.hypot(g.mx - h.mx, g.mz - h.mz) < 45 && h.lanes === g.lanes && h.name === g.name && x.len / o.len > 0.75 && x.len / o.len < 1.33; })());
    if (!y) continue; used.add(x.seg); used.add(y.seg);
    const ta = net.segTraffic[x.seg], tb = net.segTraffic[y.seg], agg = (ta + tb) / 2; if (agg < 10) continue;
    const sa = x.f.lanes ? x.f : x.b, sb = y.f.lanes ? y.f : y.b;
    const r = splitDensity(agg, { seg: x.seg, len: (x.len + y.len) / 2, f: sa, b: sb });
    naive.push(Math.abs(agg - ta), Math.abs(agg - tb)); split.push(Math.abs(r.f - ta), Math.abs(r.b - tb));
    if (Math.abs(ta - tb) >= 20) { dirN++; if ((r.f > r.b) === (ta > tb)) dirRight++; }
  }
}
if (!saves) { console.log('traffic-dir check skipped: no same-moment save + export pairs (format 121034) here'); process.exit(0); }
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
console.log(`${saves} saves, ${segs} two-way segments split (${Math.round((100 * shown) / Math.max(1, segs))}% with enough evidence), ${Math.round(ms / saves)} ms per save`);
ok(velN > 1000 && velOk / velN > 0.99, 'moving vehicles travel the way their lane runs', `${velOk}/${velN}`);
ok(sumN > 1000 && sumErr / sumN < 0.6, 'the split keeps the lane-weighted average at the game\'s density (rounding only)', +(sumErr / Math.max(1, sumN)).toFixed(2));
ok(naive.length > 500 && mean(split) < mean(naive) * 0.8, 'twin carriageways: splitting beats one value for both directions', { pairs: naive.length / 2, naiveMAE: +mean(naive).toFixed(2), splitMAE: +mean(split).toFixed(2) });
ok(dirN > 100 && dirRight / dirN > 0.8, 'twin carriageways: the busier direction is right when they differ by 20+ points', `${dirRight}/${dirN}`);
ok(ms / saves < 400, 'fast enough for the browser', `${Math.round(ms / saves)} ms`);
if (failures) { console.error(`${failures} problems`); process.exit(1); }
console.log('traffic-dir checks passed (an estimate validated on these saves, not a guarantee for others)');
