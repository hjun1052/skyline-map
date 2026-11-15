// Route ends on motorways, ramps and highways (issue #16).
// A trip whose start or destination the user put on a motorway, ramp or highway starts or ends on that road, in the
// direction it may be driven; a pin merely near one keeps the usual joins (the nearest ordinary roads).
//   npm run check:route-ends [-- file.cslmap]   (the sample city when no file is given)
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseCity, type CityData, type CNode, type CSeg, type CSegType } from '../src/parse';
import { buildCity } from '../src/build';
import { Router, type Route } from '../src/router';
import { inferOneWay, type OneWayResult } from '../src/oneway';
import { detectTolls } from '../src/tolls';
import { fromLngLat, nearestOnLine, type XY } from '../src/geo';
import catalog from '../src/lane-catalog.json';

let failures = 0;
const fail = (m: string) => { failures++; console.error('  ✗ ' + m); };
const pct = (a: number, b: number) => `${a}/${b} (${b ? ((100 * a) / b).toFixed(1) : '0'}%)`;
const xy = (ll: number[]) => fromLngLat(ll[0], ll[1]);
/** the drawn route between the pins (coords[0] and the last are the pins themselves) */
const line = (r: Route) => r.legs.flatMap((l) => l.coords).slice(1, -1).map(xy);
const types = (catalog as any).types as Record<string, { h?: number; lanes: [string, string, string, number, number, number][] }>;
const segType = (name: string): CSegType => ({ name, highway: !!types[name].h, lanes: types[name].lanes.map(([type, vType, dir, pos, width, speed]) => ({ type, vType, dir, pos, width, speed })) });

// ------------------------------------------------------------------ 1. made-up networks
/** a city from nodes [id, x, z, y?] and segments [id, sn, en, prefab, points?]; one-way directions exact (as from a .cmm) */
function toy(nodes: [number, number, number, number?][], segs: [number, number, number, string, [number, number][]?][]) {
  const N = new Map<number, CNode>(nodes.map(([id, x, z, y = 0]) => [id, { id, x, y, z, ug: false, srv: 'Road', subsrv: 'None', dist: 0, og: y === 0, elev: 0 }]));
  const S: CSeg[] = segs.map(([id, sn, en, name, mid = []]) => {
    const a = N.get(sn)!, b = N.get(en)!;
    return { id, sn, en, icls: /Highway/.test(name) ? 'Highway' : 'Small Road', width: types[name].lanes.reduce((w, l) => Math.max(w, Math.abs(l[3]) + l[4] / 2), 0) * 2, name, customName: name, path: null,
      pts: [{ x: a.x, y: a.y, z: a.z }, ...mid.map(([x, z]) => ({ x, y: (a.y + b.y) / 2, z })), { x: b.x, y: b.y, z: b.z }] };
  });
  const city = { name: 'toy', generated: '', seaLevel: 0, nodes: N, segs: S, buildings: [], segTypes: new Map(S.map((s) => [s.name, segType(s.name)])), districts: [], parks: [], transports: [],
    height: new Float32Array(1081 * 1081), water: new Float32Array(1081 * 1081), terrainSize: 1081, forest: new Uint8Array(512 * 512), forestSize: 512 } as unknown as CityData;
  // one-way: from the prefab's car lanes (all forward = start→end), marked exact so it is never driven against
  const ow: OneWayResult = { dir: new Map(), source: new Map(), truth: new Map(), stats: { oneway: 0, groups: 0, conflicts: 0, bySource: { transit: 0, keepright: 0, prior: 0, exact: 0 } } };
  for (const s of S) { const d = new Set(types[s.name].lanes.filter((l) => l[1] === 'Car' && l[0] === 'Vehicle').map((l) => l[2])); if (d.size === 1 && d.has('Forward')) { ow.dir.set(s.id, 1); ow.source.set(s.id, 'exact'); } }
  return new Router(city, new Map(), ow);
}
const startsOn = (r: Route | undefined, p: XY) => !!r && Math.hypot(line(r)[0][0] - p[0], line(r)[0][1] - p[1]) < 1;
const endsOn = (r: Route | undefined, p: XY) => !!r && Math.hypot(line(r).at(-1)![0] - p[0], line(r).at(-1)![1] - p[1]) < 1;

function unit() {
  console.log('made-up networks');
  // A one-way motorway west→east (z = 0) with an exit ramp at x = 600 down to a local road (z = 100), which runs
  // parallel to the motorway; the local road joins the motorway's start at x = -600 through an entry ramp.
  //   local:    10 ───────────── 11 ─────────── 12        (two-way, z = 100)
  //             │ entry                ↖ exit
  //   motorway: 1 ──────────────→ 2 ──────────→ 3 → 4      (one-way, z = 0)
  const R = toy(
    [[1, -600, 0], [2, 0, 0], [3, 600, 0], [4, 1200, 0], [10, -700, 100], [11, 0, 100], [12, 700, 100]],
    [[1, 1, 2, 'Highway'], [2, 2, 3, 'Highway'], [3, 3, 4, 'Highway'], [10, 10, 11, 'Basic Road'], [11, 11, 12, 'Basic Road'],
      [20, 10, 1, 'HighwayRamp'], [21, 3, 12, 'HighwayRamp']]);
  const onMw: XY = [-300, 0], east: XY = [650, 100], west: XY = [-650, 100];
  // the issue: a pin on the motorway started on the local road 100 m away (the motorway is never joined while any
  // ordinary road is within reach), drawing a line across to it; now it drives the motorway, then the exit ramp
  const r1 = R.route(onMw, east, 'drive')[0];
  if (!startsOn(r1, onMw)) fail(`a pin on the motorway should start on it: starts at ${r1 && line(r1)[0].map(Math.round)}`);
  if (r1 && !r1.legs[0].spans?.some((s) => s.cls === 'motorway_link')) fail('the route from the motorway should leave by the exit ramp');
  // same pin, picked by clicking the motorway (segment 1): the same
  if (!startsOn(R.route(onMw, east, 'drive', { fromSeg: 1 })[0], onMw)) fail('a click on the motorway should start on it');
  // going west: only by leaving at the exit and driving back along the local road, never backwards on the motorway
  const r2 = R.route(onMw, west, 'drive')[0];
  if (!startsOn(r2, onMw) || !(line(r2!)[1][0] > -300) || !r2!.legs[0].spans?.some((s) => s.cls === 'motorway_link')) fail('west from the eastbound motorway: east to the exit, then back along the local road');
  // destination on the motorway: reached along it, by the entry ramp, also from the east (round by the local road)
  const r3 = R.route(west, onMw, 'drive')[0], r3e = R.route(east, onMw, 'drive')[0];
  if (!endsOn(r3, onMw) || !endsOn(r3e, onMw)) fail(`a destination on the motorway should be reached on it: ends at ${r3 && line(r3).at(-1)!.map(Math.round)}`);
  if (r3e && !(line(r3e).at(-2)![0] < -300)) fail('the eastbound motorway must be reached driving east');

  // no legal route: a one-way motorway that ends without an exit; the local road beside it only feeds it.
  // A pin on it has nowhere to go: no route, rather than a jump across to the local road (the old behaviour)
  const D = toy(
    [[1, -600, 0], [2, 0, 0], [3, 600, 0], [10, -700, 100], [11, 0, 100], [12, 700, 100]],
    [[1, 1, 2, 'Highway'], [2, 2, 3, 'Highway'], [10, 10, 11, 'Basic Road'], [11, 11, 12, 'Basic Road'], [20, 10, 1, 'HighwayRamp']]);
  for (const [what, opts] of [['pin', {}], ['click', { fromSeg: 1 }]] as const) {
    const r = D.route(onMw, east, 'drive', opts);
    if (r.length) fail(`${what} on a dead-end one-way motorway: no legal route, yet one starts at ${line(r[0])[0].map(Math.round)}`);
  }
  // and as a destination it is reached, but only along the motorway from its entry
  const d2 = D.route(east, onMw, 'drive')[0];
  if (!endsOn(d2, onMw) || !d2!.legs[0].spans?.some((s) => s.cls === 'motorway_link')) fail('a destination on the dead-end motorway should be reached by its entry ramp');
  // near, not on: a pin 40 m beside the motorway (between it and the local road) keeps the usual joins (the local road)
  const near: XY = [-300, 40];
  const r4 = R.route(near, east, 'drive')[0];
  if (!r4 || r4.legs[0].spans?.[0]?.cls === 'motorway') fail('a pin beside the motorway should still join the ordinary road');
  // a click on the local road (an ordinary road) keeps the usual joins, picked or not: unchanged behaviour
  const onLocal: XY = [-300, 100];
  if (JSON.stringify(R.route(onLocal, east, 'drive', { fromSeg: 10 })) !== JSON.stringify(R.route(onLocal, east, 'drive'))) fail('a click on an ordinary road must route as before');

  // overlapping levels: an elevated motorway (y = 15) crosses over a local road at (0, 0)
  const B = toy(
    [[1, -500, 0, 15], [2, 500, 0, 15], [3, 1000, 0, 0], [10, 0, -500], [11, 0, 500], [12, 900, 400]],
    [[1, 1, 2, 'Highway Elevated'], [2, 2, 3, 'Highway'], [10, 10, 11, 'Basic Road'], [11, 11, 12, 'Basic Road'], [12, 12, 3, 'Basic Road']]);
  const cross: XY = [0, 0];
  // an unpicked pin at the crossing: the road drawn on top (the bridge) is the one under it
  const b1 = B.route(cross, [950, 200], 'drive')[0];
  if (!b1 || b1.legs[0].spans?.[0]?.cls !== 'motorway') fail(`a pin where a motorway bridge crosses a road should start on the bridge (drawn on top): ${b1?.legs[0].spans?.[0]?.cls}`);
  // a click that picked the road below keeps the usual joins (it is an ordinary road)
  const b2 = B.route(cross, [950, 200], 'drive', { fromSeg: 10 })[0];
  if (!b2 || JSON.stringify(b2) !== JSON.stringify(B.route([0, 1], [950, 200], 'drive', { fromSeg: 10 })[0]) && b2.legs[0].spans?.[0]?.cls === 'motorway') fail('a click on the road under a bridge must not start on the bridge');

  // parallel one-way carriageways 30 m apart: a pin on one drives that one, in its direction
  const P = toy(
    [[1, -800, 0], [2, 800, 0], [3, 800, 30], [4, -800, 30], [5, 1500, 15], [6, -1500, 15]],
    [[1, 1, 2, 'Highway'], [2, 3, 4, 'Highway'], [3, 2, 5, 'Highway'], [4, 5, 3, 'Highway'], [5, 4, 6, 'Highway'], [6, 6, 1, 'Highway']]);
  const p1 = P.route([0, 0], [-400, 30], 'drive')[0], p2 = P.route([0, 30], [400, 0], 'drive')[0];
  if (!startsOn(p1, [0, 0]) || !(line(p1!)[1][0] > 0)) fail('a pin on the eastbound carriageway should set off east on it');
  if (!startsOn(p2, [0, 30]) || !(line(p2!)[1][0] < 0)) fail('a pin on the westbound carriageway should set off west on it');
  if (!endsOn(p1, [-400, 30]) || !endsOn(p2, [400, 0])) fail('destinations on parallel carriageways should be reached on the one they are on');
}

// ------------------------------------------------------------------ 2. a real city
function real(file: string) {
  const city = parseCity(file.endsWith('.gz') ? gunzipSync(readFileSync(file)).toString('utf8') : readFileSync(file, 'utf8'));
  const ow = inferOneWay(city), tl = detectTolls(city);
  const built = buildCity(city, () => {}, ow, tl);
  const R = new Router(city, built.stopNames ?? new Map(), ow, tl) as any;
  const HW = new Set(['motorway', 'motorway_link', 'trunk']);
  console.log(`\n${file}`);
  const hw = (R.edges as any[]).map((e, ei) => ({ e, ei })).filter(({ e }) => HW.has(e.cls) && e.len >= 60 && R.allowed(e, 'drive'));
  const mid = (pts: XY[]) => pts[Math.floor(pts.length / 2)];
  const ordinary = R.edges.find((e: any) => !HW.has(e.cls) && R.allowed(e, 'drive') && e.len > 100); // a far destination on an ordinary road
  const dest: XY = ordinary.pts[Math.floor(ordinary.pts.length / 2)];
  let n = 0, start = 0, legal = 0, none = 0, endOk = 0, endN = 0, picked = 0;
  for (const { e, ei } of hw) {
    const p = mid(e.pts) as XY;
    // only where the point is on this road alone at the top level (else another road at that spot is as valid)
    const others = R.edgesNear(p, 60).filter((j: number) => j !== ei && R.allowed(R.edges[j], 'drive') && nearestOnLine(p, R.edges[j].pts).d <= R.edges[j].w / 2 + 2);
    if (others.length) continue;
    n++;
    const r = R.route(p, dest, 'drive')[0];
    if (!r) { none++; continue; }
    if (startsOn(r, p)) start++;
    // sets off the way the road may be driven: along the road's one-way direction when it has one
    const c = line(r), ahead = nearestOnLine(c[Math.min(c.length - 1, 2)], e.pts).along - nearestOnLine(c[0], e.pts).along;
    if (!e.ow || !(e.sure || e.confirmed) || Math.sign(ahead) === e.ow || Math.abs(ahead) < 0.5) legal++;
    if (startsOn(R.route(p, dest, 'drive', { fromSeg: e.id })[0], p)) picked++;
    const back = R.route(dest, p, 'drive')[0];
    if (back) { endN++; if (endsOn(back, p)) endOk++; }
  }
  console.log(`  pins on a motorway, ramp or highway (alone there): ${n}, no legal route ${none}`);
  console.log(`  route starts on the road under the pin: ${pct(start, n - none)}; clicked: ${pct(picked, n - none)}; sets off in a legal direction: ${pct(legal, n - none)}`);
  console.log(`  destination reached on the road under the pin: ${pct(endOk, endN)}`);
  if (start < (n - none) * 0.99 || picked < (n - none) * 0.99) fail('routes should start on the motorway, ramp or highway under the pin');
  if (legal !== n - none) fail('every route from a one-way road should set off in its direction');
  if (endOk < endN * 0.99) fail('destinations on a motorway, ramp or highway should be reached on it');
  // near, not on: points 40 m to the side of a motorway are not on any carriageway, so the new rule never applies to
  // them and they join roads exactly as before (an ordinary road when one is in reach)
  let nearN = 0, nearOn = 0;
  for (const { e } of hw.slice(0, 600)) {
    if (e.cls !== 'motorway') continue;
    const [a, b] = [e.pts[0], e.pts[1]], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, p: XY = [(a[0] + b[0]) / 2 - ((b[1] - a[1]) / L) * (e.w / 2 + 40), (a[1] + b[1]) / 2 + ((b[0] - a[0]) / L) * (e.w / 2 + 40)];
    if (R.edgesNear(p, 60).some((j: number) => R.allowed(R.edges[j], 'drive') && nearestOnLine(p, R.edges[j].pts).d <= R.edges[j].w / 2 + 2)) continue; // on some other road there
    nearN++;
    if (R.highwayEnd(p).length) nearOn++;
  }
  console.log(`  pins 40 m beside a motorway treated as on a highway: ${nearOn}/${nearN} (want 0: they keep the usual joins)`);
  if (nearOn) fail('pins beside a motorway must keep the usual joins');
}

unit();
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
for (const f of files.length ? files : ['public/samples/seorang.cslmap.gz']) real(f);
if (failures) { console.error(`\n${failures} route-end check(s) failed`); process.exit(1); }
console.log('\nroute-end checks passed');
