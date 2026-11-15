// Navigation simulation: traffic on the route, traffic callouts, and traffic lights / stop and yield signs (issue #17).
//   npm run check:nav-traffic   (made-up data always; the matched save in tools/fixtures/local when present)
import { readFileSync, existsSync } from 'node:fs';
import { parseCity, type CityData, type CNode, type CSeg, type CSegType } from '../src/parse';
import { buildCity } from '../src/build';
import { Router, type Route } from '../src/router';
import { inferOneWay, type OneWayResult } from '../src/oneway';
import { detectTolls } from '../src/tolls';
import { buildPlan, jamsOf, JAM, type NavTraffic } from '../src/nav';
import { junctionControls } from '../src/sim/controls';
import { loadSim } from '../src/sim';
import type { SaveNet } from '../src/sim/net';
import type { TmpeData } from '../src/sim/tmpe';
import catalog from '../src/lane-catalog.json';

let failures = 0;
const fail = (m: string) => { failures++; console.error('  ✗ ' + m); };
const types = (catalog as any).types as Record<string, { h?: number; lanes: [string, string, string, number, number, number][] }>;
const segType = (name: string): CSegType => ({ name, highway: !!types[name].h, lanes: types[name].lanes.map(([type, vType, dir, pos, width, speed]) => ({ type, vType, dir, pos, width, speed })) });

function unit() {
  console.log('made-up data');
  // ---- jams: slowed stretches joined across short gaps; delay as routing counts it; the worst colour wins
  const T = (s0: number, s1: number, color: string, delay: number): NavTraffic => ({ s0, s1, color, delay });
  const j = jamsOf([T(0, 500, '', 5), T(500, 900, '#f29900', 40), T(900, 980, '', 3), T(980, 1500, '#d93025', 50), T(1500, 3000, '', 10), T(3000, 3400, '#f29900', 20)]);
  if (j.length !== 1 || j[0].s0 !== 500 || j[0].s1 !== 1500 || j[0].delay !== 93 || j[0].color !== '#d93025') fail(`jam joining: ${JSON.stringify(j)}`);
  if (jamsOf([T(0, 300, '#f29900', JAM.minDelay - 1)]).length) fail('a jam adding under a minute should get no callout');
  if (jamsOf([T(0, 300, '#d93025', 40), T(300 + JAM.gap + 1, 900, '#d93025', 40)]).length) fail('stretches farther apart than the gap are separate jams (each too small here)');
  if (jamsOf([T(0, 300, '', 500)]).length) fail('delay on unslowed stretches alone makes no jam');

  // ---- junction controls from save data
  const city = { segs: [
    { id: 1, sn: 10, en: 11 }, { id: 2, sn: 11, en: 12 }, { id: 3, sn: 13, en: 11 }, // node 11: lights
    { id: 4, sn: 12, en: 14 }, { id: 5, sn: 15, en: 12 }, // node 12: level crossing (lights + barrier flag)
    { id: 6, sn: 14, en: 16 }, { id: 7, sn: 17, en: 14 }, // node 14: plain junction, signs / yield flags
  ] } as unknown as CityData;
  const nodeFlags = new Uint32Array(20), segFlags = new Uint32Array(10);
  nodeFlags[11] = 0x1 | 0x80 | 0x800000; nodeFlags[12] = 0x1 | 0x80 | 0x800000 | 0x200000; nodeFlags[14] = 0x1 | 0x80;
  nodeFlags[16] = 0x1 | 0x800000; // lights flag but not a junction: never shown
  segFlags[6] = 0x1 | 0x40000000; // the game's own yield at segment 6's start (node 14)
  const net = { nodeCount: 20, segCount: 10, nodeFlags, segFlags } as unknown as SaveNet;
  const key = (cs: { seg: number; node: number; kind: string }[]) => cs.map((c) => `${c.seg}:${c.node}:${c.kind}`).sort().join(' ');
  const plain = junctionControls(city, net, null, null);
  if (key(plain) !== '1:11:signal 2:11:signal 3:11:signal 6:14:yield') fail(`controls without TM:PE: ${key(plain)} (want lights on every road into node 11, the game's yield at 6/14, nothing at the level crossing)`);
  const tm = { prioritySigns: [{ segment: 7, node: 14, type: 'stop' }, { segment: 4, node: 14, type: 'main' }, { segment: 1, node: 11, type: 'yield' }] } as unknown as TmpeData;
  const withTm = junctionControls(city, net, tm, true);
  if (key(withTm) !== '1:11:signal 2:11:signal 3:11:signal 7:14:stop') fail(`controls with TM:PE: ${key(withTm)} (want its stop sign, not "main road", not a sign under lights, not the game's yield)`);
  if (key(junctionControls(city, net, tm, false)) !== '1:11:signal 2:11:signal 3:11:signal') fail('TM:PE signs with its priority-signs option off must not be shown');

  // ---- the router puts each control on the junction the route drives through, from the road it arrives on
  //   1 ── 2 ── 3      a straight two-way street; node 2 has a light for traffic arriving from segment 10 only
  //        │           (made up: the approach from 11 has none), and a side road 12 to node 4
  //        4
  const N = new Map<number, CNode>([[1, -300, 0], [2, 0, 0], [3, 300, 0], [4, 0, -300]].map(([id, x, z]) => [id, { id, x, y: 0, z, ug: false, srv: 'Road', subsrv: 'None', dist: 0, og: true, elev: 0 }]));
  const seg = (id: number, sn: number, en: number): CSeg => ({ id, sn, en, icls: 'Small Road', width: 12, name: 'Basic Road', customName: 'Main St', path: null, pts: [N.get(sn)!, N.get(en)!].map((n) => ({ x: n.x, y: 0, z: n.z })) });
  const toy = { name: 'toy', generated: '', seaLevel: 0, nodes: N, segs: [seg(10, 1, 2), seg(11, 2, 3), seg(12, 2, 4)], buildings: [], segTypes: new Map([['Basic Road', segType('Basic Road')]]), districts: [], parks: [], transports: [],
    height: new Float32Array(1081 * 1081), water: new Float32Array(1081 * 1081), terrainSize: 1081, forest: new Uint8Array(512 * 512), forestSize: 512 } as unknown as CityData;
  const ow: OneWayResult = { dir: new Map(), source: new Map(), truth: new Map(), stats: { oneway: 0, groups: 0, conflicts: 0, bySource: { transit: 0, keepright: 0, prior: 0, exact: 0 } } };
  const R = new Router(toy, new Map(), ow);
  R.applyControls([{ seg: 10, node: 2, kind: 'signal' }]);
  const at = (r: Route | undefined) => (r?.legs[0].controls ?? []).map((c) => c.kind + '@' + r!.legs[0].coords[c.i].map((v) => Math.round(v * 1e6) / 1e6).join(','));
  const east = R.route([-250, 0], [250, 0], 'drive')[0], west = R.route([250, 0], [-250, 0], 'drive')[0], toNode2 = R.route([-250, 0], [0, -20], 'drive')[0];
  if (at(east).length !== 1 || !east.legs[0].controls![0].kind) fail(`eastbound through node 2 (arriving on 10) should meet its light: ${at(east)}`);
  else { const c = east.legs[0].coords[east.legs[0].controls![0].i], p2 = R.route([-250, 0], [250, 0], 'drive')[0].legs[0].coords.find((q) => Math.abs(q[0]) < 1e-9); if (!p2 || c[0] !== p2[0] || c[1] !== p2[1]) fail('the light should sit at the junction it controls'); }
  if (at(west).length) fail(`westbound arrives on segment 11, which has no light: ${at(west)}`);
  if (!at(toNode2).length) fail('turning at node 2 (arriving on 10) should still meet its light');
  // a destination on the road itself: the route's last road point and the destination are one point, merged in the
  // plan; the last road's traffic must still run to the end of the line (its colour and callout ahead of the car)
  R.applyTraffic(new Uint16Array([10, 11]), new Uint8Array([95, 95])); R.setTraffic(true);
  const busy = R.route([-250, 0], [250, 0], 'drive')[0], bp = busy && buildPlan(busy);
  const lastT = bp?.traffic.at(-1);
  if (!bp || !lastT || Math.abs(lastT.s1 - bp.total) > 0.5 || lastT.s1 - lastT.s0 < 100) fail(`traffic on the last road should run to the end of the line: ${JSON.stringify(lastT)} (total ${bp?.total})`);
  if (!bp || !bp.jams.length || bp.jams[0].s1 - bp.jams[0].s0 < 100) fail(`a jam on the last road should keep its length: ${JSON.stringify(bp?.jams)}`);
  if (bp && Math.abs(bp.spans.at(-1)!.s1 - bp.total) > 0.5) fail('the last road span should run to the end of the line');
  R.setTraffic(false); R.clearTraffic();
  R.applyControls([]);
  if (R.route([-250, 0], [250, 0], 'drive')[0].legs[0].controls) fail('no save, no controls');
}

async function real() {
  const L = 'tools/fixtures/local/';
  if (!existsSync(L + 'match.cslmap') || !existsSync(L + 'match.crp')) { console.log('\nno matched .cslmap + save in tools/fixtures/local: real-save checks skipped'); return; }
  console.log(`\n${L}match.cslmap + match.crp`);
  const c = parseCity(readFileSync(L + 'match.cslmap', 'utf8')); const ow = inferOneWay(c), tl = detectTolls(c);
  const r = new Router(c, buildCity(c, () => {}, ow, tl).stopNames ?? new Map(), ow, tl);
  const sb = readFileSync(L + 'match.crp');
  const s: any = await loadSim(sb.buffer.slice(sb.byteOffset, sb.byteOffset + sb.byteLength) as ArrayBuffer, c, () => {});
  if (!s.ok || !s.controls) { fail('the matched save should load with its junction controls'); return; }
  const kinds: Record<string, number> = {}; for (const x of s.controls) kinds[x.kind] = (kinds[x.kind] ?? 0) + 1;
  console.log(`  controls: ${s.controls.length} junction approaches ${JSON.stringify(kinds)}`);
  r.applyRules(s.rules); r.applyControls(s.controls); r.applyTraffic(s.traffic.ids, s.traffic.pct, s.trafficDir ?? undefined); r.setTraffic(true);
  const byKey = new Map<string, string>(s.controls.map((x: any) => [x.seg + ':' + x.node, x.kind]));
  const nodes = [...c.nodes.values()].filter((n) => !n.ug && n.srv === 'Road');
  let seed = 5; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let n = 0, sumOk = 0, ctl = 0, jams = 0, planned = 0;
  for (let i = 0; i < 120; i++) {
    const a = nodes[Math.floor(rnd() * nodes.length)], q = nodes[Math.floor(rnd() * nodes.length)];
    if (Math.hypot(a.x - q.x, a.z - q.z) < 1500) continue;
    const rt = r.route([a.x, a.z], [q.x, q.z], 'drive')[0]; if (!rt) continue;
    n++;
    const leg = rt.legs[0], d = (leg.traffic ?? []).reduce((x, p) => x + p.delay, 0), extra = rt.time - (rt.baseTime ?? rt.time);
    if (Math.abs(d - extra) <= Math.max(2, 0.02 * extra)) sumOk++;
    ctl += leg.controls?.length ?? 0;
    const p = buildPlan(rt);
    if (p) { planned++; jams += p.jams.length; if (p.jams.some((j) => j.delay < JAM.minDelay)) fail('a callout below the delay threshold'); }
  }
  console.log(`  ${n} driving routes with traffic: per-stretch delays add up to the route's traffic delay on ${sumOk}; ${ctl} controls met; ${jams} callouts`);
  if (sumOk !== n) fail('per-stretch traffic delays must add up to the route card\'s traffic delay');
  if (!ctl) fail('routes through a city with traffic lights should meet some');
  if (byKey.size !== s.controls.length) fail('one control per junction approach');
}

unit();
await real();
if (failures) { console.error(`\n${failures} nav-traffic check(s) failed`); process.exit(1); }
console.log('\nnav-traffic checks passed');
