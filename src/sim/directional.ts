// Traffic by direction. The game stores one density per segment (both directions together, smoothed over game
// hours: sim/traffic.ts). This splits that value between the two directions of a two-way road, using what the save
// holds per direction at the moment it was written:
//  - occupancy: the vehicles on each direction's lanes (length + 1 m each, over the lanes' length), the same quantity
//    the game's density is built from (RoadBaseAI: 2.5 × (length + 1) per vehicle step);
//  - near demand: how many vehicles' paths cross the segment in that direction within their next 8 path positions.
// A least-squares fit on one-way segments (where the game's density is already directional) turns the two into a
// per-lane density estimate for each direction; only their ratio is used, and it is pulled toward an even split when
// few vehicles give evidence, so the result never strays far from the game's own value without reason. The split
// keeps the segment's lane-weighted average exactly equal to the game's density.
// Validated on twin carriageways (two one-way segments of one road taken as a single two-way road; all highways and
// ramps, so streets get a stricter evidence bar): docs/research/
// directional-traffic.md. It is an estimate of the moment the save was written, not a live or verified value.
import type { CityData } from '../parse';
import type { SaveNet } from './net';
import { segmentLanes } from './net';
import type { SaveVehicles, SavePaths } from './vehicles';

const LIGHTS = 0x800000; // NetNode.Flags.TrafficLights
/** least-squares fit on 22,191 one-way segments of 19 saves (3 cities): per-lane density ≈ a·occupancy + b·demand + c */
export const MODEL = { occ: 0.256 * 250, demand: 0.798, c: 2.811 };
/** evidence (vehicles present + near passes, both directions) worth as much as the even split */
export const SHRINK = 6;
const NEAR_STEPS = 8, NEAR_END = 40, STOPPED = 0.5;

export interface DirSide { lanes: number; occ: number; demand: number; present: number; stoppedAtLights: number; stoppedElsewhere: number }
export interface DirFeatures { seg: number; len: number; f: DirSide; b: DirSide }

/** +1: a car lane runs start→end, -1: end→start, 0: not a car lane (direction after the segment's Invert flag).
 *  CSLMapView exports the prefab's own lane direction (`NetInfo.Lane.m_direction`); the game drives `m_finalDirection`,
 *  which left-hand traffic inverts for vehicle lanes (NetInfo.InitializePrefab). `mirror` applies that inversion. */
function laneDirs(city: CityData, net: SaveNet, segId: number, name: string, mirror = false): Int8Array | null {
  const st = city.segTypes.get(name);
  if (!st) return null;
  const inv = ((net.segFlags[segId] & 16) !== 0) !== mirror;
  return Int8Array.from(st.lanes, (l) => (l.type !== 'Vehicle' || !l.vType.split(',').some((v) => v.trim() === 'Car') ? 0 : (l.dir === 'Forward' ? 1 : l.dir === 'Backward' ? -1 : 0) * (inv ? -1 : 1)));
}

/** Per-direction evidence for every matched segment with car lanes (`only`: limit to these segment ids). */
export function dirFeatures(city: CityData, net: SaveNet, verified: (id: number) => boolean, veh: SaveVehicles, paths: SavePaths, only?: Set<number>, mirror = false): Map<number, DirFeatures> {
  const out = new Map<number, DirFeatures>();
  const dirs = new Map<number, Int8Array>();
  const side = (): DirSide => ({ lanes: 0, occ: 0, demand: 0, present: 0, stoppedAtLights: 0, stoppedElsewhere: 0 });
  for (const s of city.segs) {
    if (s.path || !verified(s.id) || (only && !only.has(s.id))) continue;
    const d = laneDirs(city, net, s.id, s.name, mirror);
    if (!d || segmentLanes(net, s.id).length !== d.length) continue; // lane indices must line up with the save's
    const f = side(), b = side();
    for (const x of d) { if (x > 0) f.lanes++; else if (x < 0) b.lanes++; }
    if (!f.lanes && !b.lanes) continue;
    let len = 0;
    for (let i = 1; i < s.pts.length; i++) len += Math.hypot(s.pts[i].x - s.pts[i - 1].x, s.pts[i].z - s.pts[i - 1].z);
    dirs.set(s.id, d);
    out.set(s.id, { seg: s.id, len: Math.max(1, len), f, b });
  }
  const seg = new Map(city.segs.map((s) => [s.id, s]));
  const at = (unit: number, idx: number): [number, number] | null => (unit && idx < paths.count[unit] ? [paths.posSeg[paths.start[unit] + idx], paths.posLane[paths.start[unit] + idx]] : null);
  for (let v = 0; v < veh.n; v++) {
    let unit = veh.path[v], idx = (veh.pathIndex[v] === 255 ? 0 : veh.pathIndex[v]) >> 1;
    const here = at(unit, idx);
    if (here) {
      const [sg, ln] = here, F = out.get(sg), dir = dirs.get(sg)?.[ln] ?? 0;
      if (F && dir) {
        const S = dir > 0 ? F.f : F.b, s = seg.get(sg)!;
        S.occ += veh.length[v] + 1; S.present++;
        if (Math.hypot(veh.velX[v], veh.velZ[v]) < STOPPED) {
          const end = dir > 0 ? s.en : s.sn;
          const near = Math.hypot(veh.posX[v] - net.nodeX[end], veh.posZ[v] - net.nodeZ[end]) < NEAR_END;
          if (near && net.nodeFlags[end] & LIGHTS) S.stoppedAtLights++; else S.stoppedElsewhere++;
        }
      }
    }
    // the next positions of its path, across path units
    for (let step = 0; step < NEAR_STEPS && unit; step++) {
      idx++;
      if (idx >= paths.count[unit]) { unit = paths.next[unit]; idx = 0; if (!unit) break; }
      const p = at(unit, idx);
      if (!p) break;
      const F = out.get(p[0]), dir = dirs.get(p[0])?.[p[1]] ?? 0;
      if (F && dir) (dir > 0 ? F.f : F.b).demand++;
    }
  }
  return out;
}

/** a direction's per-lane density estimate from its evidence, used only relative to the other direction */
export function laneWeight(s: DirSide, len: number, model = MODEL): number {
  if (!s.lanes) return 0;
  const area = len * s.lanes;
  return model.occ * (s.occ / area) + model.demand * (s.demand / area) * 100 + model.c;
}

/** Split a segment's density between its two directions; evidence = vehicles present + near passes. */
export function splitDensity(density: number, x: DirFeatures, model = MODEL): { f: number; b: number; evidence: number } {
  const lf = x.f.lanes, lb = x.b.lanes;
  const evidence = x.f.present + x.b.present + x.f.demand + x.b.demand;
  if (!lf || !lb) return { f: lf ? density : 0, b: lb ? density : 0, evidence };
  const wf = laneWeight(x.f, x.len, model) * lf, wb = laneWeight(x.b, x.len, model) * lb;
  const even = lf / (lf + lb);
  const share = ((wf / (wf + wb)) * evidence + even * SHRINK) / (evidence + SHRINK);
  const total = density * (lf + lb);
  let f = (total * share) / lf, b = (total * (1 - share)) / lb;
  // a direction can't pass 100 %: what it can't hold stays on the other side
  if (f > 100) { b = Math.min(100, b + ((f - 100) * lf) / lb); f = 100; }
  if (b > 100) { f = Math.min(100, f + ((b - 100) * lb) / lf); b = 100; }
  return { f, b, evidence };
}

export interface DirTraffic {
  /** two-way road segments with an estimate */
  ids: Int32Array;
  /** estimated density (0-100) start→end and end→start */
  f: Uint8Array; b: Uint8Array;
  /** vehicles present + near passes behind the split (capped at 255); below MIN_EVIDENCE the split is the game's value both ways */
  evidence: Uint8Array;
  /** bit 1: the start→end traffic is vehicles waiting at the lights ahead, bit 2: the same end→start */
  queue: Uint8Array;
  /** compass octant of start→end (0 east, 2 north, 4 west, 6 south; game x/z), for naming the directions */
  heading: Uint8Array;
  /** 1: enough evidence for this road type (MIN_EVIDENCE / MIN_EVIDENCE_STREET); 0: the game's value both ways */
  trusted: Uint8Array;
}
/** evidence a highway or ramp needs before its split is used: the road types twin carriageways validate */
export const MIN_EVIDENCE = 5;
/** other roads: their splits agree less between two independent halves of the vehicles at the same evidence (split-half
 *  check in tools/traffic-dir-check.ts); at twice the evidence they agree about as well as highways do at MIN_EVIDENCE */
export const MIN_EVIDENCE_STREET = 10;
const isHighway = (city: CityData, name: string) => !!city.segTypes.get(name)?.highway || /ramp|slip|link/i.test(name);

/**
 * How many moving vehicles travel the way their lane's direction says (velocity against the segment's start→end
 * vector). A wrong lane-direction mapping (a mod that changes lanes, an untested traffic side) shows up here as a low
 * share; a correct one gives about 99.6 % on the test saves (the rest are vehicles turning at segment ends).
 */
export function directionCheck(city: CityData, net: SaveNet, verified: (id: number) => boolean, veh: SaveVehicles, paths: SavePaths, only?: Set<number>, mirror = false): { agree: number; moving: number } {
  const seg = new Map(city.segs.map((s) => [s.id, s])), dirs = new Map<number, Int8Array | null>();
  let agree = 0, moving = 0;
  for (let v = 0; v < veh.n; v++) {
    if (Math.hypot(veh.velX[v], veh.velZ[v]) < 1) continue;
    const u = veh.path[v], i = (veh.pathIndex[v] === 255 ? 0 : veh.pathIndex[v]) >> 1;
    if (!u || i >= paths.count[u]) continue;
    const sg = paths.posSeg[paths.start[u] + i], s = seg.get(sg);
    if (!s || !verified(sg) || (only && !only.has(sg))) continue;
    if (!dirs.has(sg)) dirs.set(sg, laneDirs(city, net, sg, s.name, mirror));
    const d = dirs.get(sg)?.[paths.posLane[paths.start[u] + i]] ?? 0;
    if (!d) continue;
    const a = s.pts[0], z = s.pts[s.pts.length - 1];
    moving++; if (veh.velX[v] * (z.x - a.x) * d + veh.velZ[v] * (z.z - a.z) * d > 0) agree++;
  }
  return { agree, moving };
}
/** the share of moving vehicles that must agree before a save's directions are trusted, and how many must be moving */
export const CHECK_SHARE = 0.95, CHECK_MOVING = 100;

export function directionalTraffic(city: CityData, net: SaveNet, verified: (id: number) => boolean, veh: SaveVehicles, paths: SavePaths, only?: Set<number>): DirTraffic | null {
  // the save's own vehicles confirm the lane directions first; if they don't, traffic stays per road
  const chk = directionCheck(city, net, verified, veh, paths, only);
  if (chk.moving < CHECK_MOVING || chk.agree / chk.moving < CHECK_SHARE) return null;
  const feats = dirFeatures(city, net, verified, veh, paths, only);
  const ids: number[] = [], f: number[] = [], b: number[] = [], ev: number[] = [], q: number[] = [], hd: number[] = [], tr: number[] = [];
  const seg = new Map(city.segs.map((s) => [s.id, s]));
  const queued = (s: DirSide) => s.stoppedAtLights >= 2 && s.stoppedElsewhere === 0;
  for (const x of feats.values()) {
    if (!x.f.lanes || !x.b.lanes) continue;
    const r = splitDensity(net.segTraffic[x.seg], x);
    ids.push(x.seg); f.push(Math.round(r.f)); b.push(Math.round(r.b)); ev.push(Math.min(255, r.evidence));
    tr.push(r.evidence >= (isHighway(city, seg.get(x.seg)!.name) ? MIN_EVIDENCE : MIN_EVIDENCE_STREET) ? 1 : 0);
    q.push((queued(x.f) ? 1 : 0) | (queued(x.b) ? 2 : 0));
    const s = seg.get(x.seg)!, a = s.pts[0], z = s.pts[s.pts.length - 1];
    hd.push((Math.round(Math.atan2(z.z - a.z, z.x - a.x) / (Math.PI / 4)) + 8) % 8);
  }
  return { ids: Int32Array.from(ids), f: Uint8Array.from(f), b: Uint8Array.from(b), evidence: Uint8Array.from(ev), queue: Uint8Array.from(q), heading: Uint8Array.from(hd), trusted: Uint8Array.from(tr) };
}
