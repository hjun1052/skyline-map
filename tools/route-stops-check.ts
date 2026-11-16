// Trips through stops (issue #26): Router.routeVia joins the best route between each pair of neighbouring points into
// one route, and a car leaves a stop the way it arrived (no turning round in the road, no one-way driven backwards).
//   npm run check:route-stops
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseCity, type CityData, type CNode, type CSeg, type CSegType } from '../src/parse';
import { buildCity } from '../src/build';
import { Router, type Route } from '../src/router';
import { buildPlan } from '../src/nav';
import { inferOneWay, type OneWayResult } from '../src/oneway';
import { detectTolls } from '../src/tolls';
import { fromLngLat, type XY } from '../src/geo';
import catalog from '../src/lane-catalog.json';

let failures = 0;
const ok = (c: boolean, m: string) => { if (!c) { failures++; console.error('  ✗ ' + m); } };
const xy = (ll: number[]) => fromLngLat(ll[0], ll[1]);
const types = (catalog as any).types as Record<string, { h?: number; lanes: [string, string, string, number, number, number][] }>;
const segType = (name: string): CSegType => ({ name, highway: !!types[name].h, lanes: types[name].lanes.map(([type, vType, dir, pos, width, speed]) => ({ type, vType, dir, pos, width, speed })) });

/** a city from nodes [id, x, z] and segments [id, sn, en, prefab]; one-way directions exact */
function toy(nodes: [number, number, number][], segs: [number, number, number, string][]) {
  const N = new Map<number, CNode>(nodes.map(([id, x, z]) => [id, { id, x, y: 0, z, ug: false, srv: 'Road', subsrv: 'None', dist: 0, og: true, elev: 0 }]));
  const S: CSeg[] = segs.map(([id, sn, en, name]) => {
    const a = N.get(sn)!, b = N.get(en)!;
    return { id, sn, en, icls: 'Small Road', width: 12, name, customName: name + ' ' + id, path: null, pts: [{ x: a.x, y: 0, z: a.z }, { x: b.x, y: 0, z: b.z }] };
  });
  const city = { name: 'toy', generated: '', seaLevel: 0, nodes: N, segs: S, buildings: [], segTypes: new Map(S.map((s) => [s.name, segType(s.name)])), districts: [], parks: [], transports: [],
    height: new Float32Array(1081 * 1081), water: new Float32Array(1081 * 1081), terrainSize: 1081, forest: new Uint8Array(512 * 512), forestSize: 512 } as unknown as CityData;
  const ow: OneWayResult = { dir: new Map(), source: new Map(), truth: new Map(), stats: { oneway: 0, groups: 0, conflicts: 0, bySource: { transit: 0, keepright: 0, prior: 0, exact: 0 } } };
  for (const s of S) { const d = new Set(types[s.name].lanes.filter((l) => l[1] === 'Car' && l[0] === 'Vehicle').map((l) => l[2])); if (d.size === 1 && d.has('Forward')) { ow.dir.set(s.id, 1); ow.source.set(s.id, 'exact'); } }
  return new Router(city, new Map(), ow);
}
const line = (r: Route) => r.legs.flatMap((l) => l.coords).map(xy);
/** where the joined line passes the stop `p` (index of the nearest point), and which way it goes on from there */
function after(r: Route, p: XY) {
  const L = line(r);
  let k = 0, bd = Infinity;
  L.forEach((q, i) => { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; k = i; } });
  for (let j = k + 1; j < L.length; j++) if (Math.hypot(L[j][0] - L[k][0], L[j][1] - L[k][1]) > 3) return [L[j][0] - L[k][0], L[j][1] - L[k][1]] as XY;
  return [0, 0] as XY;
}
const stepsOf = (r: Route) => r.legs[0].steps.map((s) => s.maneuver);

function unit() {
  console.log('made-up networks');
  // A square block of two-way streets (200 m), with a dead-end street going south from its south-east corner:
  //   4 ────────── 3
  //   │            │
  //   1 ── s → ─── 2
  //                │ (dead end)
  //                5
  const R = toy([[1, 0, 0], [2, 200, 0], [3, 200, 200], [4, 0, 200], [5, 200, -150]],
    [[1, 1, 2, 'Basic Road'], [2, 2, 3, 'Basic Road'], [3, 3, 4, 'Basic Road'], [4, 4, 1, 'Basic Road'], [5, 2, 5, 'Basic Road']]);
  const start: XY = [20, 0], stop: XY = [150, 0], behind: XY = [100, 0];
  // the car arrives at the stop heading east; the next destination lies 50 m behind it
  const via = R.routeVia([start, stop, behind], 'drive', { labels: ['A', 'Shop', 'B'] })[0];
  ok(!!via, 'a trip through a stop is found');
  if (via) {
    const go = after(via, stop);
    ok(go[0] > 0, `the car drives on from the stop the way it arrived, not turning round in the road (heads ${go.map(Math.round)})`);
    const direct = R.route(stop, behind, 'drive')[0];
    ok(!!direct && via.dist > R.route(start, stop, 'drive')[0].dist + direct.dist + 50, 'so the leg after the stop is longer than reversing on the spot would be');
    ok(via.legs.length === 1 && stepsOf(via).filter((m) => m === 'stop').length === 1 && stepsOf(via).at(-1) === 'arrive', 'one leg, one "arrive at stop" step, and the arrival at the end');
    const stopStep = via.legs[0].steps.find((s) => s.maneuver === 'stop')!;
    ok(/1/.test(stopStep.text) && /Shop/.test(stopStep.text), `the stop step names it ("${stopStep.text}")`);
    ok(via.legs[0].spans!.every((s, i, a) => s.i >= 0 && s.i < via.legs[0].coords.length && (i === 0 || s.i >= a[i - 1].i)), 'road spans point into the joined line, in order');
  }
  // the same trip on foot: a pedestrian may simply turn round at the stop
  const walk = R.routeVia([start, stop, behind], 'walk')[0];
  ok(!!walk && after(walk, stop)[0] < 0, 'walking: turning round at the stop is fine');
  // a stop at the end of the dead-end street: the only way on is back out (turning at the dead end, as the router allows)
  const dead = R.routeVia([start, [200, -140], [100, 200]], 'drive')[0];
  ok(!!dead, 'a stop at a dead end still leads on (turning round at its end)');

  // A one-way street east (1→2) beside a two-way loop: a stop on the one-way never sends the car back up it
  //   4 ────────── 3
  //   │            │
  //   1 ═══ → ════ 2   (one-way)
  const O = toy([[1, 0, 0], [2, 300, 0], [3, 300, 200], [4, 0, 200]],
    [[1, 1, 2, 'Oneway Road'], [2, 2, 3, 'Basic Road'], [3, 3, 4, 'Basic Road'], [4, 4, 1, 'Basic Road']]);
  const ow = O.routeVia([[10, 0], [200, 0], [50, 0]], 'drive')[0];
  ok(!!ow && after(ow, [200, 0])[0] > 0, 'a stop on a one-way: the car continues along it, never back against it');
  const segsAgainst = ow ? line(ow).some((p, i, L) => i > 0 && Math.abs(p[1]) < 1 && Math.abs(L[i - 1][1]) < 1 && p[0] < L[i - 1][0] - 1) : true;
  ok(!segsAgainst, 'and no stretch of the trip drives the one-way westwards');

  console.log('limits');
  ok(R.routeVia([start, stop, behind], 'transit').length === 0, 'transit has no stops');
  ok(R.routeVia(Array.from({ length: 11 }, (_, i) => [10 + i * 15, 0] as XY), 'drive').length === 0, 'more than 10 points are refused');
  const two = R.routeVia([start, behind], 'drive'), plain = R.route(start, behind, 'drive');
  ok(JSON.stringify(two) === JSON.stringify(plain), 'two points: exactly what an ordinary route gives (alternatives included)');
}

/** the sample city: real roads, one-ways, traffic rules absent */
function real() {
  const city = parseCity(gunzipSync(readFileSync('public/samples/seorang.cslmap.gz')).toString('utf8'));
  const ow = inferOneWay(city), tl = detectTolls(city);
  const R = new Router(city, buildCity(city, () => {}, ow, tl).stopNames ?? new Map(), ow, tl);
  console.log('\nsample city');
  const nodes = [...city.nodes.values()].filter((n) => !n.ug && n.srv === 'Road');
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let tried = 0, found = 0, sane = 0, simOk = 0;
  for (let i = 0; i < 25; i++) {
    const pts = Array.from({ length: 4 }, () => { const n = nodes[Math.floor(rnd() * nodes.length)]; return [n.x, n.z] as XY; });
    tried++;
    const r = R.routeVia(pts, 'drive', { labels: ['a', 'b', 'c', 'd'] })[0];
    if (!r) continue;
    found++;
    const parts = [0, 1, 2].map((k) => R.route(pts[k], pts[k + 1], 'drive')[0]);
    const steps = stepsOf(r);
    // each leg is at least as long as the best route between its two points (keeping the heading can only add)
    if (r.legs.length === 1 && steps.filter((m) => m === 'stop').length === 2 && steps.at(-1) === 'arrive' && parts.every(Boolean) && r.time >= parts.reduce((a, p) => a + p!.time, 0) - 1) sane++;
    const plan = buildPlan(r);
    if (plan && plan.maneuvers.some((m) => m.man === 'stop') && plan.maneuvers.at(-1)!.man === 'arrive') simOk++;
  }
  console.log(`  ${found}/${tried} trips through 2 stops routed`);
  ok(found >= tried * 0.8, `most random trips through stops are found (${found}/${tried})`);
  ok(sane === found, `every one is one leg with two stop steps and no faster than its separate legs (${sane}/${found})`);
  ok(simOk === found, `the navigation simulation plans every one, stops included (${simOk}/${found})`);
}

unit();
real();
if (failures) { console.error(`\n${failures} route stop check(s) failed`); process.exit(1); }
console.log('\nroute stop checks passed');
