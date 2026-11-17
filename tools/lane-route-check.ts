// TM:PE lane connections followed lane by lane (issue #26, src/sim/lanes.ts): a car that a connection leaves in one
// lane can't make a turn only another lane of the same road allows.
//   npm run check:lane-route
import type { CityData, CNode, CSeg, CSegType } from '../src/parse';
import { Router } from '../src/router';
import type { OneWayResult } from '../src/oneway';
import type { SimRules } from '../src/sim/rules';
import { laneStep, type LaneMove } from '../src/sim/lanes';
import type { XY } from '../src/geo';
import catalog from '../src/lane-catalog.json';

let failures = 0;
const ok = (c: boolean, m: string) => { if (!c) { failures++; console.error('  ✗ ' + m); } };
const types = (catalog as any).types as Record<string, { h?: number; lanes: [string, string, string, number, number, number][] }>;
const segType = (name: string): CSegType => ({ name, highway: !!types[name].h, lanes: types[name].lanes.map(([type, vType, dir, pos, width, speed]) => ({ type, vType, dir, pos, width, speed })) });

console.log('lane steps');
const m: LaneMove = { from: 1, node: 2, to: 3, lanes: [5, 7], targets: [[7], null] };
ok(laneStep(m, 1 << 5) === 1 << 7, 'a connected lane leads to the lane it connects to');
ok(laneStep(m, 1 << 7) === 0 && laneStep(m, -1) === 0, 'a lane without connections leads to any lane');
ok(laneStep({ ...m, targets: [[], []] }, -1) === -1, 'no lane leads there: the move is banned');
ok(laneStep({ ...m, targets: [[4], [6]] }, -1) === ((1 << 4) | (1 << 6)), 'the lanes of every lane the car may be in');

console.log('made-up network');
// A ramp R (one-way, north-east) joins a Medium Road B at node 2; at node 3 B meets C (south: a right turn), D (north: a
// left turn) and E (straight on). W joins B from the west at node 2. D, E and C are joined round a block (5-9-6-10-4).
//
//            5 ──── 9
//            D      │
//   8 ─W─ 2 ─B─ 3 ─E─ 6
//        ↗       C      │
//      R        4 ─── 10
//     7
//    ↗ Q (the road before the ramp: a trip's first turn starts in any lane, as TM:PE's start lanes do)
//   11
const nodes: [number, number, number][] = [[2, 0, 0], [3, 300, 0], [4, 300, -200], [5, 300, 200], [6, 600, 0], [7, -150, -150], [8, -300, 0], [9, 600, 200], [10, 600, -200], [11, -300, -300]];
const segs: [number, number, number, string][] = [
  [1, 7, 2, 'Oneway Road'], [2, 2, 3, 'Medium Road'], [3, 3, 4, 'Basic Road'], [4, 3, 5, 'Basic Road'], [5, 3, 6, 'Basic Road'],
  [6, 8, 2, 'Basic Road'], [7, 5, 9, 'Basic Road'], [8, 9, 6, 'Basic Road'], [9, 6, 10, 'Basic Road'], [10, 10, 4, 'Basic Road'], [11, 11, 7, 'Oneway Road'],
];
const N = new Map<number, CNode>(nodes.map(([id, x, z]) => [id, { id, x, y: 0, z, ug: false, srv: 'Road', subsrv: 'None', dist: 0, og: true, elev: 0 }]));
const S: CSeg[] = segs.map(([id, sn, en, name]) => { const a = N.get(sn)!, b = N.get(en)!; return { id, sn, en, icls: 'Small Road', width: 12, name, customName: name + ' ' + id, path: null, pts: [{ x: a.x, y: 0, z: a.z }, { x: b.x, y: 0, z: b.z }] }; });
const city = { name: 'toy', generated: '', seaLevel: 0, nodes: N, segs: S, buildings: [], segTypes: new Map(S.map((s) => [s.name, segType(s.name)])), districts: [], parks: [], transports: [],
  height: new Float32Array(1081 * 1081), water: new Float32Array(1081 * 1081), terrainSize: 1081, forest: new Uint8Array(512 * 512), forestSize: 512 } as unknown as CityData;
const ow = (): OneWayResult => ({ dir: new Map([[1, 1], [11, 1]]), source: new Map([[1, 'exact'], [11, 'exact']]), truth: new Map(), stats: { oneway: 0, groups: 0, conflicts: 0, bySource: { transit: 0, keepright: 0, prior: 0, exact: 0 } } });
// Medium Road eastbound (Forward) lanes: 7 inner (x 4.5, the left lane), 5 outer (x 7.5, the right lane)
const moves: LaneMove[] = [
  // the ramp's two lanes both connect to B's left lane only
  { from: 1, node: 2, to: 2, lanes: [4, 5], targets: [[7], [7]] },
  // at node 3 B's left lane turns left only (its arrows), its right lane goes straight on or right
  { from: 2, node: 3, to: 3, lanes: [5, 7], targets: [null, []] },
  { from: 2, node: 3, to: 4, lanes: [5, 7], targets: [[], null] },
  { from: 2, node: 3, to: 5, lanes: [5, 7], targets: [null, []] },
];
const rules = (laneMoves: LaneMove[]): SimRules => ({ oneway: new Map(), speed: new Map(), carRestrict: new Map(), restrictFactor: null, uturnBan: [], turnBan: [], laneMoves, trackLimit: new Map(),
  summary: { oneway: 0, speed: 0, carRestrict: 0, restrictBan: true, uturnBan: 0, turnBan: 0, track: 0, leftHand: false, tmpe: true } });
const plain = new Router(city, new Map(), ow()), laned = new Router(city, new Map(), ow());
plain.applyRules(rules([])); laned.applyRules(rules(moves));

// the segments a drive passes, in order (the router's own search, as Directions runs it)
const segsOf = (r: Router, p: XY, q: XY): number[] => {
  const x = (r as any).driveRoute(p, q, new Map()) as { path: { e: number }[] } | null;
  return x ? x.path.map((s) => (r as any).edges[s.e].id).filter((v: number, k: number, A: number[]) => k === 0 || v !== A[k - 1]) : [];
};
const has = (segs: number[], run: number[]) => segs.some((_, k) => run.every((v, i) => segs[k + i] === v));
const startQ: XY = [-250, -250], onC: XY = [300, -120], onW: XY = [-200, 0], onE: XY = [450, 0];
const a = plain.route(startQ, onC, 'drive')[0], b = laned.route(startQ, onC, 'drive')[0];
ok(!!a && has(segsOf(plain, startQ, onC), [1, 2, 3]), 'without lane moves: off the ramp, along B and right into C');
ok(!!b && !has(segsOf(laned, startQ, onC), [1, 2, 3]) && b.time > a!.time, `with them: the ramp leaves the car in B's left lane, which can't turn right, so it goes another way (${segsOf(laned, startQ, onC).join(',')}; ${b ? Math.round(b.time) : '-'} s vs ${a ? Math.round(a.time) : '-'} s)`);
ok(has(segsOf(laned, onW, onC), [2, 3]), 'from W, which joins B in any lane, the right turn into C is still taken');
const e = segsOf(laned, startQ, onE);
ok(e.length > 0 && !has(e, [1, 2, 5]) && !has(e, [1, 2, 3]), `the ramp's lane can't go straight on or right, yet E is reached (${e.join(',')})`);
ok(has(segsOf(laned, startQ, [300, 120]), [1, 2, 4]), 'and the left turn the lane allows is taken directly');
// reach and node-to-node routes follow the same lanes
const idx = (laned as any).nodeIndex.bind(laned) as (id: number) => number;
const rp = plain.reachTimes(startQ, 'drive', 3600), rl = laned.reachTimes(startQ, 'drive', 3600);
ok(rl[idx(4)] > rp[idx(4)] + 20, `reach: node 4 (C's far end) is farther off the ramp with lane moves (${Math.round(rl[idx(4)])} s vs ${Math.round(rp[idx(4)])} s)`);
const nr = laned.nodeRoute(idx(11), idx(4), 'drive'), np = plain.nodeRoute(idx(11), idx(4), 'drive');
ok(!!nr && !!np && nr.time > np.time && !has(nr.segs, [1, 2, 3]), `node routes too (${nr ? nr.segs.join(',') : '-'})`);
// clearing the rules restores the plain router exactly
laned.clearRules();
ok(JSON.stringify(laned.route(startQ, onC, 'drive')) === JSON.stringify(plain.route(startQ, onC, 'drive')), 'clearing the rules restores the route without lane moves');
// a .skysave made before lane moves (no laneMoves field) still applies
const old = new Router(city, new Map(), ow()); const r0 = rules([]); delete r0.laneMoves; old.applyRules(r0);
ok(JSON.stringify(old.route(startQ, onC, 'drive')) === JSON.stringify(a ? plain.route(startQ, onC, 'drive') : null), 'rules without lane moves route as before');

if (failures) { console.error(`\n${failures} lane routing check(s) failed`); process.exit(1); }
console.log('\nlane routing checks passed');
