// .cmm (CSLModernMap) reader checks: src/cmm.ts.
//
// 1. Always (CI): small made-up documents test format detection, errors, the lane rule the mod uses, lanes from the
//    file's facts for unknown prefabs, catalogue lanes the file contradicts, and leg rebuilding on a toy network.
// 2. With a matched pair of exports of one city in tools/fixtures/local (git-ignored): match.cmm.gz (or match.cmm) and
//    match.cslmap. Everything the reader produces is compared with the .cslmap, field by field, then the two are routed,
//    searched and summarised side by side. Rebuilt transit legs are scored against the .cslmap's paths and, by hiding
//    exported paths, against the legs the file does have.
// The numbers describe this pair of files; another city, game state or mod version can differ.
//   npm run check:cmm [--n=60]
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseCity, type CityData, type CSeg, type Vec3 } from '../src/parse';
import { readCmm, isCmm, laneFacts, rebuildLeg, legContext, cmmIdentities, parseDoc } from '../src/cmm';
import { laneInfo, buildCity } from '../src/build';
import { Router, type Mode, type Route } from '../src/router';
import { inferOneWay } from '../src/oneway';
import { detectTolls } from '../src/tolls';
import { discover } from '../src/discover';
import { fromLngLat } from '../src/geo';
import { createClosures, segInfoFrom } from '../src/closure';
import { FormatError } from '../src/vellummap';
import type { LaneCatalog } from '../src/lane-infer';
import { loadSim } from '../src/sim';
import shipped from '../src/lane-catalog.json';

const cat = shipped as unknown as LaneCatalog;
const N = +(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? 60);
let failures = 0;
const fail = (m: string) => { failures++; console.error('  ✗ ' + m); };
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const pct = (a: number, b: number) => (b ? `${a}/${b} (${((100 * a) / b).toFixed(1)}%)` : '0/0');
const q = (xs: number[], f: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(f * (s.length - 1))] ?? NaN; };

// ------------------------------------------------------------------ 1. made-up documents
const P = (x: number, z: number) => [x, 0, z];
function doc(extra: Record<string, unknown> = {}) {
  const road = (id: number, sn: number, en: number, name: string, f: string, b: string, count: number, dir: number, geom: number[][]) => ({
    id, kind: 'ROAD', start_id: sn, end_id: en, geometry: geom, mode: 'GROUND', width: 16, level: 'BRANCH', name, display_name: '', game_name: '', source_raw: 'Small Road',
    lane_summary: { car_lane_count: count, direction: dir }, car_access: { forward: f, backward: b }, car_speed: { forward: f === 'allowed' ? 11.1 : null, backward: b === 'allowed' ? 11.1 : null }, transit_for: null, path_segment_ids: [] });
  return {
    schema_version: 'cmm-v1', metadata: { origin: { game: 'cs1', exporter: 'CSLModernMap', source_name: 'Toy' }, exported_at: '2026-11-14 12:52:26' },
    nodes: [1, 2, 3, 4, 9].map((id) => ({ id, pos: id === 9 ? P(150, 3) : P(id * 100, 0), mode_hint: 'GROUND', station_service: null, source_raw: 'None' })),
    networks: [
      road(10, 1, 2, 'Basic Road', 'allowed', 'allowed', 2, 0, [P(100, 0), P(200, 0)]),
      road(11, 2, 3, 'Oneway Road', 'allowed', 'forbidden', 2, 1, [P(200, 0), P(300, 0)]),
      road(12, 3, 4, 'Made Up Road 3L', 'allowed', 'forbidden', 3, 1, [P(300, 0), P(400, 0)]),
      { id: 13, kind: 'BEAUTIFICATION', start_id: 4, end_id: 1, geometry: [P(400, 0), P(100, 0)], width: 4, name: 'Made Up Path', display_name: '', game_name: '', source_raw: 'Pedestrian Path', lane_summary: { car_lane_count: 0, direction: 0 }, car_access: { forward: 'forbidden', backward: 'forbidden' }, car_speed: {}, path_segment_ids: [] },
      { id: 14, kind: 'STOP_LINE', start_id: 9, end_id: 9, geometry: [P(150, 3), P(150, 3)], width: 0, name: 'Bus Line', display_name: '', game_name: '', source_raw: 'Bus Line', transit_for: 'BUS', lane_summary: { car_lane_count: 0, direction: 0 }, car_access: {}, car_speed: {}, path_segment_ids: [] },
    ],
    buildings: [], districts: [], transit_lines: [{ id: 1, name: 'Toy line', kind: 'BUS', source_raw: 'Bus', user_color: [1, 2, 3, 255] }],
    stops: [{ id: 9, network_node_id: 9, kind: 'BUS', position: P(150, 3), serving_line_ids: [1] }], routes: [{ id: 3, line_id: 1, stop_ids: [9, 9] }],
    forests: [], issues: [], extensions: { cs1: { network_sources: { 12: { segment_id: 12, invert: true } }, park_source_ids: {} } }, ...extra,
  };
}
const expectError = async (bytes: Uint8Array, key: RegExp, what: string) => {
  try { await readCmm(bytes, cat); fail(`${what}: read without error`); } catch (e) { if (!(e instanceof FormatError) || !key.test(e.key + ' ' + e.message)) fail(`${what}: wrong error ${(e as Error).message}`); }
};

async function unit() {
  console.log('made-up documents');
  if (!isCmm(enc(doc())) || !isCmm(new TextEncoder().encode(' \n{ "schema_version" : "cmm-v2"}'))) fail('cmm JSON not recognised');
  if (isCmm(new TextEncoder().encode('<?xml version="1.0"?><CSLExportXML>')) || isCmm(new TextEncoder().encode('{"a":1}'))) fail('non-cmm data recognised as cmm');
  await expectError(enc({ ...doc(), schema_version: 'cmm-v2' }), /does not read yet/, 'newer format');
  await expectError(new TextEncoder().encode('{"schema_version":"cmm-v1",'), /damaged.*not valid JSON/, 'truncated file');
  await expectError(enc({ ...doc(), nodes: 'x' }), /damaged.*nodes is not a list/, 'bad nodes');
  await expectError(enc({ ...doc(), terrain: { height: { rows: 1081, cols: 1081, cell: 15.985198889916743, encoding: 'base64+zlib+float32-row-major', data: 'AAAA' } } }), /damaged.*terrain height/, 'bad terrain');

  // the mod's lane rule (RoadGeometry.Facts): car lanes = Vehicle/TransportVehicle lanes that carry cars and have a direction
  const f = laneFacts([
    { type: 'Vehicle', vType: 'Car', dir: 'Forward', pos: 0, width: 3, speed: 1 }, { type: 'TransportVehicle', vType: 'Car', dir: 'Backward', pos: 0, width: 3, speed: 1 },
    { type: 'Parking', vType: 'Car', dir: 'Forward', pos: 0, width: 2, speed: 1 }, { type: 'Vehicle', vType: 'Tram', dir: 'Both', pos: 0, width: 3, speed: 1 },
    { type: 'Vehicle', vType: 'Car', dir: 'None', pos: 0, width: 3, speed: 1 }, { type: 'Vehicle', vType: 'CableCar', dir: 'Forward', pos: 0, width: 3, speed: 1 }]);
  if (f.count !== 2 || f.dir !== 3 || f.car !== 1) fail(`lane rule: ${JSON.stringify(f)} (want 2 lanes, both directions, cars forward only)`);

  const c = await readCmm(enc(doc()), cat);
  const st = (id: number) => c.segTypes.get(c.segs.find((s) => s.id === id)!.name);
  if (!st(10) || JSON.stringify(st(10)!.lanes) !== JSON.stringify(cat.types['Basic Road'].lanes.map(([type, vType, dir, pos, width, speed]) => ({ type, vType, dir, pos, width, speed })))) fail('a prefab the file confirms should use the catalogue lanes');
  if (!c.extras?.factsOnly?.has(12) || laneInfo(st(12)).vehicle !== 3 || laneInfo(st(12)).oneway !== true) fail('an unknown prefab should get the file\'s car lanes (3, one-way)');
  if (st(12)!.lanes.some((l) => /Pedestrian|Bicycle/.test(l.type + l.vType))) fail('an unknown road must not get invented sidewalks or bike lanes');
  if (!st(13)?.lanes.some((l) => l.type === 'Pedestrian') || laneInfo(st(13)).vehicle) fail('an unknown path should be walkable and carry no cars');
  // Oneway Road is in the catalogue as one-way: the file agrees (forward only) → catalogue
  if (c.extras?.factsOnly?.has(11)) fail('Oneway Road should use the catalogue lanes');
  if (c.extras!.oneway!.dir.get(11) !== 1 || c.extras!.oneway!.dir.get(12) !== 1 || c.extras!.oneway!.dir.has(10)) fail('one-way directions should come from car_access (relative to start→end)');
  if (c.generated !== '2026-11-14T12:52:26' || Number.isNaN(Date.parse(c.generated))) fail('export time not in ISO form');
  if (c.transports[0].stops.join() !== '9,9' || c.transports[0].color.join() !== '1,2,3' || c.transports[0].type !== 'Bus') fail('transit line not mapped');
  // a prefab whose catalogue lanes contradict the file: the file wins
  const d2 = doc(); (d2.networks[0] as any).lane_summary.car_lane_count = 5;
  const c2 = await readCmm(enc(d2), cat);
  if (!c2.extras!.cmm!.conflicts.includes('Basic Road') || laneInfo(c2.segTypes.get('Basic Road')).vehicle !== 5) fail('catalogue lanes the file contradicts must not be used');

  // leg rebuilding on the toy network: a bus from x=150 to x=350 drives 10 → 11 → 12; the way back is blocked by one-way 11
  // (12 is inverted: its prefab lanes run end→start, so the file's "forward allowed" must survive the un-invert and re-invert)
  const inv = new Set([12]);
  const r = rebuildLeg(c, inv, 'BUS', { x: 150, y: 0, z: 3 }, { x: 350, y: 0, z: 3 });
  if (r.path?.join() !== '10,11,12') fail(`rebuilt leg ${r.path} (want 10,11,12)`);
  const back = rebuildLeg(c, inv, 'BUS', { x: 350, y: 0, z: 3 }, { x: 150, y: 0, z: 3 });
  if (back.path) fail(`a leg against one-way roads was rebuilt: ${back.path}`);
  if (rebuildLeg(c, inv, 'BUS', { x: 150, y: 0, z: 200 }, { x: 350, y: 0, z: 3 }).why !== 'stop off network') fail('a stop far from the network must not be snapped');
  // both stops on one segment: the direct hop only in a direction the segment allows (11 is one-way 2→3, x 200→300;
  // the way round back into it runs over path 13, which buses can't use, so the wrong-way hop has no path)
  const same = (x0: number, x1: number) => rebuildLeg(c, inv, 'BUS', { x: x0, y: 0, z: 3 }, { x: x1, y: 0, z: 3 });
  if (same(220, 280).path?.join() !== '11' || Math.abs(same(220, 280).len! - 60) > 1e-6) fail(`same-segment hop with the one-way: ${JSON.stringify(same(220, 280))}`);
  if (same(280, 220).path) fail(`same-segment hop against a one-way was accepted: ${same(280, 220).path}`);
  if (same(180, 120).path?.join() !== '10') fail(`same-segment hop either way on a two-way road: ${same(180, 120).path}`);
  if (rebuildLeg(c, inv, 'SHIP', { x: 150, y: 0, z: 3 }, { x: 350, y: 0, z: 3 }).why !== 'no network') fail('ship legs have no network in the file');
  const tour = rebuildLeg(c, inv, 'TOUR', { x: 350, y: 0, z: 1 }, { x: 150, y: 0, z: 1 });
  if (!tour.path) fail('a walking tour should be able to walk any direction');
  if (cmmIdentities(enc(doc())).segs.length !== 5) fail('time-lapse identities');
  // bus legs are never rebuilt into the map (not validated well enough), even where a path exists
  if (c.segs.find((s) => s.id === 14)!.path || c.extras!.cmm!.legs.why['not validated'] !== 1) fail('a bus leg without a path must stay without one');
  if (rebuildLeg(c, inv, 'TOUR', { x: 8600, y: 0, z: 1 }, { x: 150, y: 0, z: 1 }).why !== 'outside connection') fail('legs to the map edge (outside connections) must not be rebuilt');

  // district cells are read before JSON.parse (parseDoc): same grid as reading them from the parsed lists would give,
  // strings that mention the key left alone, odd numbers parsed, bad cell lists reported, the traffic snapshot skipped
  const cells = [[-8630.4, -8630.4], [-8611.2, -8630.4], [9.6, 2.88e1], [-1.92e+1, 0.5E1]];
  const ds = [
    { id: 0, name: 'grid_points', kind: 'DISTRICT', grid_points: [[0, 0]], grid_cell: 19.2, position: [0, 0, 0] },
    { id: 3, name: 'Old "grid_points": [[1, 2]] town', kind: 'DISTRICT', grid_points: cells, grid_cell: 19.2, position: [9.6, 0, 9.6] }];
  const dd = doc({ districts: ds,
    traffic: { schemaVersion: '1.2', segments: [{ roadName: 'a } ] " \\" {', lanes: [[1]] }] } });
  const pd = parseDoc(enc(dd));
  if (pd.d.traffic !== null || pd.d.districts[1].name !== ds[1].name || pd.grids.length !== 2 || pd.d.districts[1].grid_points !== 1
    || Array.from(pd.grids[1]).join() !== cells.flat().join()) fail(`parseDoc: ${JSON.stringify({ t: pd.d.traffic, g: pd.grids.map((g) => Array.from(g)) })}`);
  const cd = await readCmm(enc(dd), cat), g = cd.extras!.districtGrid!;
  const at = ([x, z]: number[]) => g[(Math.floor((z + 8640) / 19.2) * 900 + Math.floor((x + 8640) / 19.2)) * 8];
  if (!cells.every((p) => at(p) === 3) || at([500, 500]) !== 0) fail('district grid from the pre-read cells');
  await expectError(enc(doc({ districts: [{ id: 3, name: 'x', kind: 'DISTRICT', grid_points: [[1, 'a']], grid_cell: 19.2 }] })), /damaged.*district cells are not numbers/, 'cells that are not numbers');
  await expectError(enc(doc({ districts: [{ id: 3, name: 'x', kind: 'DISTRICT', grid_points: [[1, 2, 3]], grid_cell: 19.2 }] })), /damaged.*not \[x, z\] pairs/, 'cells that are not pairs');
  await expectError(new TextEncoder().encode('{"schema_version":"cmm-v1","districts":[{"grid_points":[[1,2],'), /damaged.*cut off/, 'cells cut off');
}

// ------------------------------------------------------------------ 2. a matched pair of exports
const fx = (n: string) => ['tools/fixtures/local/' + n + '.gz', 'tools/fixtures/local/' + n].find((p) => existsSync(p));
const read = (p: string) => { const b = readFileSync(p); return p.endsWith('.gz') ? gunzipSync(b) : b; };
const norm = (p: number[]) => p.filter((x, i) => i === 0 || x !== p[i - 1]);
const polyLen = (pts: Vec3[]) => pts.reduce((a, p, i) => (i ? a + Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) : 0), 0);
function distTo(p: { x: number; z: number }, pts: Vec3[]) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz, t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.z + t * dz - p.z));
  }
  return best;
}
/** farthest any point of a lies from polyline b (one-sided Hausdorff, a resampled every 2 m) */
function hausdorff(a: Vec3[], b: Vec3[]) {
  let worst = 0;
  for (let i = 0; i + 1 < a.length; i++) {
    const n = Math.max(1, Math.ceil(Math.hypot(a[i + 1].x - a[i].x, a[i + 1].z - a[i].z) / 2));
    for (let k = 0; k <= n; k++) worst = Math.max(worst, distTo({ x: a[i].x + ((a[i + 1].x - a[i].x) * k) / n, z: a[i].z + ((a[i + 1].z - a[i].z) * k) / n }, b));
  }
  return worst;
}
const coords = (r: Route) => r.legs.flatMap((l) => l.coords).map((p) => fromLngLat(p[0], p[1]));
function overlap(a: Route, b: Route) {
  const A = coords(a), B = coords(b).map(([x, z]) => ({ x, y: 0, z }));
  let on = 0, tot = 0;
  for (let i = 1; i < A.length; i++) { const L = Math.hypot(A[i][0] - A[i - 1][0], A[i][1] - A[i - 1][1]); tot += L; if (distTo({ x: (A[i][0] + A[i - 1][0]) / 2, z: (A[i][1] + A[i - 1][1]) / 2 }, B) < 8) on += L; }
  return tot ? on / tot : 1;
}

async function pair(cmmPath: string, cslPath: string) {
  console.log(`\nmatched pair: ${cmmPath} ↔ ${cslPath}`);
  const t0 = performance.now();
  const bytes = new Uint8Array(read(cmmPath));
  const t1 = performance.now();
  const m = await readCmm(bytes, cat);
  const t2 = performance.now();
  const c = parseCity(read(cslPath).toString('utf8'));
  const raw = JSON.parse(new TextDecoder().decode(bytes));
  console.log(`  read: gunzip ${Math.round(t1 - t0)} ms, cmm ${Math.round(t2 - t1)} ms (${(bytes.length / 1e6).toFixed(0)} MB JSON)`);
  const info = m.extras!.cmm!;

  // ---- nodes
  let nId = 0, nXZ = 0, nY = 0, nUg = 0, nOg = 0, nSrv = 0, nSub = 0, maxDy = 0;
  for (const [id, a] of m.nodes) {
    const b = c.nodes.get(id); if (!b) continue; nId++;
    if (a.x === b.x && a.z === b.z) nXZ++;
    if (a.y === b.y) nY++; else maxDy = Math.max(maxDy, Math.abs(a.y - b.y));
    if (a.ug === b.ug) nUg++; if (b.og === null || a.og === b.og) nOg++;
    if (a.srv === b.srv || (!a.srv && /Water|Electricity/.test(b.srv))) nSrv++; if (a.subsrv === b.subsrv) nSub++;
  }
  console.log(`  nodes: ids ${pct(nId, c.nodes.size)}, same x/z ${pct(nXZ, nId)}, same height ${pct(nY, nId)} (max diff ${maxDy.toFixed(2)} m), underground ${pct(nUg, nId)}, on ground ${pct(nOg, nId)}, service ${pct(nSrv, nId)}, sub-service ${pct(nSub, nId)}`);
  if (nId !== c.nodes.size || nXZ < nId * 0.999 || nUg !== nId || nSub !== nId) fail('nodes differ');
  const srvMiss = new Map<string, number>(); for (const [id, a] of m.nodes) { const b = c.nodes.get(id); if (b && a.srv !== b.srv) srvMiss.set(`${a.srv || '-'}→${b.srv}`, (srvMiss.get(`${a.srv || '-'}→${b.srv}`) ?? 0) + 1); }
  console.log(`    service differences (cmm→cslmap): ${[...srvMiss].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  // ---- segments
  const cs = new Map(c.segs.map((s) => [s.id, s])), ms = new Map(m.segs.map((s) => [s.id, s]));
  let sId = 0, sEnds = 0, sName = 0, sIcls = 0, sCustom = 0, sGame = 0, sWidth = 0; const haus: number[] = [];
  for (const b of c.segs) {
    const a = ms.get(b.id); if (!a) continue; sId++;
    if (a.sn === b.sn && a.en === b.en) sEnds++; if (a.name === b.name) sName++; if (a.icls === b.icls) sIcls++; if (Math.abs(a.width - b.width) < 0.01) sWidth++;
    if (b.customName) { if (a.customName === b.customName) sCustom++; } else if (a.customName) sGame++;
    if (!b.path && b.pts.length > 1 && a.pts.length > 1) haus.push(Math.max(hausdorff(a.pts, b.pts), hausdorff(b.pts, a.pts)));
  }
  const customs = c.segs.filter((s) => s.customName).length;
  console.log(`  segments: ${pct(sId, c.segs.length)} found (cmm has ${m.segs.length}), same ends ${pct(sEnds, sId)}, prefab ${pct(sName, sId)}, item class ${pct(sIcls, sId)}, width ${pct(sWidth, sId)}`);
  console.log(`    names: the player's ${pct(sCustom, customs)}; the game's automatic names add ${sGame} named segments the .cslmap leaves unnamed`);
  console.log(`    centreline distance to the .cslmap's: median ${q(haus, 0.5).toFixed(2)} m, p99 ${q(haus, 0.99).toFixed(2)} m, max ${q(haus, 1).toFixed(2)} m`);
  if (sId !== c.segs.length || sEnds !== sId || sName !== sId || sCustom !== customs) fail('segments differ');
  if (q(haus, 0.99) > 2) fail(`centrelines differ by more than 2 m on 1% of segments`);

  // ---- lanes: the reader's lanes against the .cslmap's lane table, per segment
  let lSame = 0, lInfo = 0, lN = 0; const lMiss: string[] = [];
  for (const b of c.segs) {
    const a = ms.get(b.id), sa = a && m.segTypes.get(a.name), sb = c.segTypes.get(b.name);
    if (!sb || !sb.lanes.length || b.path) continue; lN++;
    if (sa && JSON.stringify(sa.lanes) === JSON.stringify(sb.lanes) && sa.highway === sb.highway) lSame++; else lMiss.push(b.name);
    if (JSON.stringify(laneInfo(sa)) === JSON.stringify(laneInfo(sb))) lInfo++;
  }
  console.log(`  lanes: ${info.lanes.catalogue} road/path segments use catalogue lanes the file confirms, ${info.lanes.facts} the file's facts only; conflicts: ${info.conflicts.join(', ') || 'none'}`);
  console.log(`    same lane table as the .cslmap: ${pct(lSame, lN)} segments; same lane summary (count, one-way, speed): ${pct(lInfo, lN)}`);
  if (lSame !== lN) fail(`lane tables differ: ${[...new Set(lMiss)].slice(0, 5).join(', ')}`);
  // the file's own facts, against the mod's rule applied to the .cslmap's lane table (proves the rule, not the catalogue)
  let fN = 0, fOk = 0, legacy = 0;
  for (const w of raw.networks) {
    if (w.kind !== 'ROAD' || w.id < 0) continue;
    const sb = c.segTypes.get(cs.get(w.id)?.name ?? ''); if (!sb) continue; fN++;
    const f = laneFacts(sb.lanes), inv = raw.extensions.cs1.network_sources[String(w.id)]?.invert === true;
    let dir = f.dir, car = f.car; const swap = (x: number) => ((x & 1) << 1) | ((x & 2) >> 1); if (inv) { dir = swap(dir); car = swap(car); }
    const fd = dir === 1 ? 1 : dir === 2 ? -1 : 0;
    if (f.count === w.lane_summary.car_lane_count && (f.count === 0 || fd === w.lane_summary.direction) && ((car & 1) ? 'allowed' : 'forbidden') === w.car_access.forward && ((car & 2) ? 'allowed' : 'forbidden') === w.car_access.backward) fOk++;
    if (laneInfo(sb).vehicle === w.lane_summary.car_lane_count) legacy++;
  }
  console.log(`    car_lane_count, direction and car access vs the mod's rule on the .cslmap lanes: ${pct(fOk, fN)} (Skyline Map's own lane count, which also counts parking and tram lanes, matches ${pct(legacy, fN)})`);
  if (fOk !== fN) fail('the mod\'s lane rule does not reproduce the file');

  // ---- one-way: exact in the file; the .cslmap infers it
  const inf = inferOneWay(c), ex = m.extras!.oneway!;
  let owBoth = 0, owAgree = 0, owSure = 0, owSureAgree = 0;
  for (const [id, d] of ex.dir) { const g = inf.dir.get(id); if (g === undefined) continue; owBoth++; if (g === d) owAgree++; if (inf.source.get(id) !== 'prior') { owSure++; if (g === d) owSureAgree++; } }
  const carOw = [...ex.dir.keys()].filter((id) => m.extras!.carSpeed!.has(id)).length;
  const sameSet = [...ex.dir.keys()].filter((id) => inf.dir.has(id)).length === ex.dir.size && ex.dir.size === inf.dir.size;
  console.log(`  one-way: ${ex.dir.size} one-way segments, exact (${carOw} car roads from car access, ${ex.dir.size - carOw} tracks from lanes + Invert); same set as the .cslmap's: ${sameSet}`);
  console.log(`    the .cslmap's inferred direction (no Invert flag in that format) agrees on ${pct(owAgree, owBoth)} (${pct(owSureAgree, owSure)} where it calls itself sure)`);
  if (!sameSet) fail('one-way sets differ');
  // ground truth: transit vehicles drove these one-way segments (the .cslmap's own evidence); exact directions must agree
  let tN = 0, tOk = 0; for (const [id, d] of inf.truth) { const e = ex.dir.get(id); if (e === undefined) continue; tN++; if (e === d) tOk++; }
  console.log(`    against the directions transit vehicles were seen driving: ${pct(tOk, tN)}`);
  if (tOk !== tN) fail('an exact one-way direction disagrees with transit vehicles');

  // ---- speed limits: effective (file) vs prefab (.cslmap lanes)
  let spN = 0, spSame = 0; const spDiff = new Map<string, number>();
  for (const [id, v] of m.extras!.carSpeed!) {
    const b = cs.get(id), li = laneInfo(c.segTypes.get(b?.name ?? '')); if (!b || !li.speed) continue; spN++;
    const kmh = Math.round(Math.max(v[0] ?? 0, v[1] ?? 0) * 3.6);
    if (Math.abs(kmh - li.speed) <= 1) spSame++; else spDiff.set(`${b.name} ${li.speed}→${kmh}`, (spDiff.get(`${b.name} ${li.speed}→${kmh}`) ?? 0) + 1);
  }
  console.log(`  speed limits: file = prefab speed on ${pct(spSame, spN)} car roads; differences (prefab → file, km/h): ${[...spDiff].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k} ×${v}`).join(', ')}`);

  // ---- buildings
  const cb = new Map(c.buildings.map((b) => [b.id, b]));
  let bN = 0, bSame = 0, bPts = 0, bY = 0;
  for (const a of m.buildings) {
    const b = cb.get(a.id); if (!b) continue; bN++;
    if (a.name === b.name && a.myname === b.myname && a.srv === b.srv && a.subsrv === b.subsrv && a.icls === b.icls && a.parent === b.parent && a.sub === b.sub) bSame++;
    if (a.pts.length === b.pts.length && a.pts.every((p, i) => Math.abs(p.x - b.pts[i].x) < 0.01 && Math.abs(p.z - b.pts[i].z) < 0.01)) bPts++;
    if (a.pts.every((p, i) => !b.pts[i] || Math.abs(p.y - b.pts[i].y) < 0.01)) bY++;
  }
  console.log(`  buildings: ${pct(bN, c.buildings.length)} found, same prefab/name/service/class/chain ${pct(bSame, bN)}, same footprint ${pct(bPts, bN)}, same base height ${pct(bY, bN)}`);
  if (bN !== c.buildings.length || bSame !== bN || bPts < bN * 0.999) fail('buildings differ');
  const cats = raw.buildings.filter((b: any) => b.category_name).length;
  console.log(`    official category label in the file: ${pct(cats, raw.buildings.length)} (not used: Skyline Map classifies by service and class, as for a .cslmap)`);

  // ---- districts: the game's grid (file) vs the .cslmap's per-node district
  let dN = 0, dSame = 0;
  // the .cslmap gives a district on few nodes (most say 0); compare where it names one
  for (const [id, a] of m.nodes) { const b = c.nodes.get(id); if (!b || !b.dist) continue; dN++; if (a.dist === b.dist) dSame++; }
  const dn = (xs: { id: number; name: string }[]) => xs.map((d) => d.id + ':' + d.name).sort().join('|');
  console.log(`  districts: ${m.districts.length} districts, ${m.parks.length} parks (lists equal: ${dn(m.districts) === dn(c.districts) && dn(m.parks) === dn(c.parks)}); nodes the .cslmap puts in a district: the game's grid agrees on ${pct(dSame, dN)}`);
  if (dn(m.districts) !== dn(c.districts) || dn(m.parks) !== dn(c.parks)) fail('district or park lists differ');
  if (dSame < dN * 0.97) fail('district grid disagrees with the .cslmap on more than 3% of nodes');

  // ---- terrain, water, forests
  const diff = (a: Float32Array, b: Float32Array) => { let mx = 0, n = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > 1e-3) n++; mx = Math.max(mx, d); } return { mx, n }; };
  const th = diff(m.height, c.height), tw = diff(m.water, c.water);
  let fSame = 0; for (let i = 0; i < m.forest.length; i++) if (m.forest[i] === c.forest[i]) fSame++;
  console.log(`  terrain: ${th.n} of ${m.height.length} heights differ (max ${th.mx.toFixed(2)} m); water depth: ${tw.n} differ (max ${tw.mx.toFixed(2)} m); forests ${pct(fSame, m.forest.length)} equal; sea level ${m.seaLevel} vs ${c.seaLevel}`);
  if (m.terrainSize !== c.terrainSize || th.n > m.height.length * 0.01) fail('terrain differs');

  // ---- transit
  const ct = new Map(c.transports.map((t) => [t.id, t]));
  let tSame = 0; for (const a of m.transports) { const b = ct.get(a.id); if (b && a.type === b.type && a.name === b.name && a.stops.join() === b.stops.join()) tSame++; }
  const colours = m.transports.filter((a) => ct.get(a.id)?.color.join() === a.color.join()).length;
  console.log(`  transit: lines ${pct(tSame, c.transports.length)} same type, name and stops; colours ${pct(colours, c.transports.length)}`);
  if (tSame !== c.transports.length) fail('transit lines differ');
  const legKind = (s: CSeg) => raw.networks.find((w: any) => w.id === s.id)?.transit_for ?? (/Pedestrian/.test(s.icls) ? 'TOUR' : '?');
  const byKind = new Map<string, { n: number; exported: number; same: number; rebuilt: number; rebuiltSame: number; rebuiltOverlap: number[]; none: number; cslNone: number }>();
  const inferred = m.extras!.inferredLegs!;
  const lenOf = (ids: number[], city: CityData) => { const by = new Map(city.segs.map((s) => [s.id, s])); return ids.reduce((a, id) => a + polyLen(by.get(id)?.pts ?? []), 0); };
  const segOverlap = (a: number[], b: number[]) => { const A = new Set(a), B = new Set(b); const inter = [...A].filter((x) => B.has(x)); return lenOf(inter, c) / Math.max(1, lenOf([...new Set([...A, ...B])], c)); };
  for (const s of m.segs) {
    const isLeg = raw.networks.find((w: any) => w.id === s.id && (w.kind === 'STOP_LINE' || (w.kind === 'OTHER' && / Line$/.test(w.source_raw) && !/Wire|Pipe|Power/.test(w.source_raw))));
    if (!isLeg) continue;
    const k = legKind(s), t = byKind.get(k) ?? byKind.set(k, { n: 0, exported: 0, same: 0, rebuilt: 0, rebuiltSame: 0, rebuiltOverlap: [], none: 0, cslNone: 0 }).get(k)!;
    const truth = cs.get(s.id)?.path; t.n++;
    if (!truth?.length) t.cslNone++;
    if (!s.path) { t.none++; continue; }
    if (inferred.has(s.id)) { t.rebuilt++; if (truth?.length) { if (norm(s.path).join() === norm(truth).join()) t.rebuiltSame++; t.rebuiltOverlap.push(segOverlap(s.path, truth)); } }
    else { t.exported++; if (truth && norm(s.path).join() === norm(truth).join()) t.same++; }
  }
  console.log('    legs by mode: total | exported (same as .cslmap) | rebuilt (same as .cslmap, length overlap median) | none | .cslmap has none');
  for (const [k, t] of [...byKind].sort()) console.log(`    ${k.padEnd(10)} ${String(t.n).padStart(4)} | ${t.exported} (${t.same}) | ${t.rebuilt} (${t.rebuiltSame}, ${t.rebuiltOverlap.length ? Math.round(100 * q(t.rebuiltOverlap, 0.5)) + '%' : '-'}) | ${t.none} | ${t.cslNone}`);
  console.log(`    why legs stay without a path: ${JSON.stringify(info.legs.why)}`);
  for (const [k, t] of byKind) if (t.same !== t.exported) fail(`${k}: an exported leg differs from the .cslmap`);
  // hold-out: hide the exported paths and rebuild them; this is how far a rebuilt leg can be trusted per mode
  const inv = new Set<number>(Object.entries(raw.extensions.cs1.network_sources).filter(([, v]: any) => v.invert === true).map(([k]) => +k));
  const held = new Map<string, { n: number; found: number; same: number; ov: number[] }>();
  for (const s of m.segs) {
    if (!s.path || inferred.has(s.id)) continue;
    const k = legKind(s), a = m.nodes.get(s.sn), b = m.nodes.get(s.en); if (!a || !b) continue;
    const h = held.get(k) ?? held.set(k, { n: 0, found: 0, same: 0, ov: [] }).get(k)!; h.n++;
    const ctx = (held as any)['ctx' + k] ??= legContext(m, inv, k);
    const r = rebuildLeg(m, inv, k, a, b, ctx);
    if (!r.path) continue; h.found++;
    if (norm(r.path).join() === norm(s.path).join()) h.same++; h.ov.push(segOverlap(r.path, s.path));
  }
  console.log('    hold-out (exported legs hidden, then rebuilt): found | same path | length overlap median / p10');
  for (const [k, h] of [...held].sort()) console.log(`    ${k.padEnd(10)} ${pct(h.found, h.n)} | ${pct(h.same, h.found)} | ${Math.round(100 * q(h.ov, 0.5))}% / ${Math.round(100 * q(h.ov, 0.1))}%`);

  // ---- the built map, side by side
  const bm = buildCity(m, () => {}, m.extras!.oneway, detectTolls(m)), bc = buildCity(c, () => {}, inf, detectTolls(c));
  const names = (b: typeof bm, kind: string) => new Set(b.search.filter((e) => e.kind === kind).map((e) => e.name));
  for (const kind of ['poi', 'district', 'line', 'road']) {
    const A = names(bm, kind), B = names(bc, kind), both = [...B].filter((x) => A.has(x)).length;
    console.log(`  search ${kind.padEnd(8)}: .cslmap ${B.size}, .cmm ${A.size}, ${pct(both, B.size)} of the .cslmap's found`);
    if (both < B.size && kind !== 'road') fail(`search: ${B.size - both} ${kind} entries missing`);
    if (kind === 'road' && both < B.size * 0.98) fail(`search: road names missing`);
  }
  const statKeys = [...new Set([...Object.keys(bc.meta.stats), ...Object.keys(bm.meta.stats)])].filter((k) => bc.meta.stats[k] !== bm.meta.stats[k]);
  console.log(`  map statistics that differ: ${statKeys.map((k) => `${k} ${bc.meta.stats[k] ?? 0}→${bm.meta.stats[k] ?? 0}`).join(', ') || 'none'}`);
  const dm = discover(m, bm), dc = discover(c, bc);
  const dIds = (r: typeof dm) => new Map(r.items.map((x) => [x.id, x.value + ' ' + x.unit + ' ' + x.subject]));
  const DA = dIds(dm), DB = dIds(dc), dSameN = [...DB].filter(([k, v]) => DA.get(k) === v).length;
  console.log(`  discoveries: .cslmap ${DB.size}, .cmm ${DA.size}, identical ${dSameN}; differing: ${[...DB].filter(([k, v]) => DA.get(k) !== v).map(([k, v]) => `${k} [${v} → ${DA.get(k) ?? 'absent'}]`).slice(0, 6).join('; ') || 'none'}`);
  console.log(`  summary: ${JSON.stringify(dc.summary)} vs ${JSON.stringify(dm.summary)}`);
  if (dSameN < DB.size * 0.8) fail('discoveries differ a lot');

  // ---- routing: the same random trips on both
  const rm = new Router(m, bm.stopNames ?? new Map(), m.extras!.oneway, detectTolls(m)), rc = new Router(c, bc.stopNames ?? new Map(), inf, detectTolls(c));
  const nodes = [...c.nodes.values()].filter((n) => !n.ug && n.srv === 'Road');
  const MODES: Mode[] = ['drive', 'walk', 'bike', 'transit'];
  // the same trips with the .cslmap's own speeds and inferred one-ways: what is left over is not the file's extra facts
  const rmPlain = new Router({ ...m, extras: { ...m.extras!, carSpeed: undefined } }, bm.stopNames ?? new Map(), inferOneWay(m), detectTolls(m));
  for (const mode of MODES) {
    let seed = 11 + mode.length * 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const ratio: number[] = [], same: number[] = [], plain: number[] = []; let trips = 0, found = 0, lim = 0, limSame = 0;
    for (let i = 0; i < N * 8 && trips < N; i++) {
      const a = nodes[Math.floor(rnd() * nodes.length)], b = nodes[Math.floor(rnd() * nodes.length)];
      const dd = Math.hypot(a.x - b.x, a.z - b.z);
      if (dd < 600 || (mode === 'walk' && dd > 3500)) continue;
      const B = rc.route([a.x, a.z], [b.x, b.z], mode)[0]; if (!B) continue; trips++;
      const A = rm.route([a.x, a.z], [b.x, b.z], mode)[0]; if (!A) continue; found++;
      ratio.push(A.time / B.time); same.push(overlap(A, B));
      if (mode === 'drive') { const Pl = rmPlain.route([a.x, a.z], [b.x, b.z], mode)[0]; if (Pl) plain.push(Pl.time / B.time); }
      if (mode === 'drive') for (const l of A.legs) for (const sp of l.spans ?? []) if (sp.limit !== undefined) lim++;
      if (mode === 'drive') for (const l of B.legs) for (const sp of l.spans ?? []) if (sp.limit !== undefined) limSame++;
    }
    const w = (x: number) => Math.round((100 * ratio.filter((r) => Math.abs(r - 1) <= x).length) / Math.max(1, ratio.length));
    console.log(`  route ${mode.padEnd(7)} found ${found}/${trips}, time within 2% ${w(0.02)}% / 10% ${w(0.1)}%, ratio p10 ${q(ratio, 0.1).toFixed(3)} median ${q(ratio, 0.5).toFixed(3)} p90 ${q(ratio, 0.9).toFixed(3)}, same path median ${Math.round(100 * q(same, 0.5))}% p10 ${Math.round(100 * q(same, 0.1))}%`);
    if (plain.length) { const wp = Math.round((100 * plain.filter((r) => Math.abs(r - 1) <= 0.02).length) / plain.length); console.log(`          with the .cslmap's speeds and inferred one-ways instead: time within 2% ${wp}%, ratio p10 ${q(plain, 0.1).toFixed(3)} p90 ${q(plain, 0.9).toFixed(3)}`); if (wp < 95) fail('driving differs for reasons other than speeds and one-ways'); }
    if (found < trips) fail(`route ${mode}: ${trips - found} trips have a .cslmap route but no .cmm route`);
      if ((mode === 'walk' || mode === 'transit') && w(0.02) < 95) fail(`${mode} times differ`);
  }
  // reach and closures run
  const a = nodes[100];
  const tr = rm.reachTimes([a.x, a.z], 'drive', 1200), tcs = rc.reachTimes([a.x, a.z], 'drive', 1200);
  const reachN = (t: ArrayLike<number>) => Array.from(t).filter((x) => x < 1200).length;
  console.log(`  reach (drive, 20 min): .cslmap ${reachN(tcs)} nodes, .cmm ${reachN(tr)}`);
  const cl = createClosures(m, rm, segInfoFrom(bm), bm.stopNames ?? new Map());
  const roads = m.segs.filter((s) => laneInfo(m.segTypes.get(s.name)).vehicle && !s.path).filter((_, i) => i % 400 === 0);
  const closed = roads.filter((s) => cl.analyze({ kind: 'road', seg: s.id })).length;
  console.log(`  closures: ${closed}/${roads.length} sample roads analysed`);
  if (closed < roads.length) fail('closures fail on some roads');
  console.log(`  memory: heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB after both cities`);

  // ---- a matched save (.crp) on the .cmm: it must match, and its own TM:PE limits and one-ways must equal the file's
  const crp = fx('match.crp');
  if (crp) {
    const b = readFileSync(crp);
    const r: any = await loadSim(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, m, () => {});
    if (!r.ok) { fail(`save does not load on the .cmm: ${r.code} ${JSON.stringify(r.v?.segments ?? '')}`); return; }
    let sN = 0, sSame = 0, oN = 0, oSame = 0;
    for (const [id, sp] of r.rules?.speed ?? []) { const f = m.extras!.carSpeed!.get(id); if (!f) continue; sN++; if ([0, 1].every((i) => (sp[i] == null ? null : Math.round(sp[i])) === (f[i] == null ? null : Math.round(f[i]! * 3.6)))) sSame++; }
    for (const [id, d] of r.rules?.oneway ?? []) { oN++; if (m.extras!.oneway!.dir.get(id) === d) oSame++; }
    console.log(`  save ${crp}: ${r.v.verdict}, segments ${r.v.segments.verified}/${r.v.segments.exported} verified; its TM:PE limits equal the file's speeds on ${pct(sSame, sN)}; its one-ways equal the file's on ${pct(oSame, oN)}; traffic on ${r.traffic?.ids.length ?? 0} roads, by direction on ${r.trafficDir?.ids.length ?? 0}`);
    if (r.v.verdict !== 'match' || sSame !== sN || oSame !== oN) fail('the matched save disagrees with the .cmm');
  }
}

await unit();
const cm = fx('match.cmm'), cl = fx('match.cslmap');
if (cm && cl) await pair(cm, cl); else console.log('\nno matched pair in tools/fixtures/local (match.cmm[.gz] + match.cslmap[.gz]): real-file comparison skipped');
if (failures) { console.error(`\n${failures} problems`); process.exit(1); }
console.log('\ncmm checks passed (the numbers describe these files, not a guarantee for other cities)');
