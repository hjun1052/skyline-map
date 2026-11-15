// Traffic lights and stop/yield signs a car meets entering a junction, from a matched save (issue #17), keyed by the
// segment it arrives on and the node it enters, so a route only shows what faces its own direction of travel.
//
// What the game and TM:PE store, and how they combine (read from Assembly-CSharp RoadBaseAI / NetNode and TM:PE 11.9
// TrafficLightManager, VehicleBehaviorManager, OptionsManager):
//  - Traffic lights are a node flag, NetNode.Flags.TrafficLights (0x800000). The game sets it by road layout unless the
//    player overrode it (CustomTrafficLights, 0x80000000); TM:PE's toggle and timed lights write the same two flags and
//    keep no list of their own (its SaveData returns nothing), so the saved flag is the state the game runs. Checked on a
//    save against the light junctions the CSLModernMap mod read live from the game: the same 112 signal junctions and
//    38 overrides. A light controls every road a car can enter the junction from (RoadBaseAI.SetTrafficLightState).
//  - Railway level crossings carry the same flag with LevelCrossing (0x200000): barriers, not traffic signals; left out.
//  - TM:PE priority signs (stop, yield; "main road" is shown as nothing) sit on one segment end and are obeyed only with
//    TM:PE's "priority signs" option on (options byte 18) and not at a junction with lights (TM:PE removes them there).
//  - The game's own yield flags (NetSegment YieldStart 0x40000000 / YieldEnd 0x80000000, per segment end) are obeyed by
//    the game's car AI at junctions without lights. With TM:PE they are not: its junction logic lets cars on a yield lane
//    go on (VehicleBehaviorManager.MayChangeSegment), so they are used only for a save without TM:PE data.
// Nothing else is inferred: without a save there are no controls.
import type { CityData } from '../parse';
import type { SaveNet } from './net';
import type { TmpeData } from './tmpe';

export type ControlKind = 'signal' | 'stop' | 'yield';
export interface Control { seg: number; node: number; kind: ControlKind }

const N_JUNCTION = 0x80, N_LEVEL_CROSSING = 0x200000, N_LIGHTS = 0x800000, N_ONEWAY_IN = 0x1000000;
const S_YIELD_START = 0x40000000, S_YIELD_END = 0x80000000;

/** `prioritySignsOn`: TM:PE's "priority signs" option as saved (null when unknown: then its signs aren't shown) */
export function junctionControls(city: CityData, net: SaveNet, tmpe: TmpeData | null, prioritySignsOn: boolean | null): Control[] {
  const out: Control[] = [];
  const atNode = new Map<number, number[]>();
  for (const s of city.segs) for (const n of [s.sn, s.en]) (atNode.get(n) ?? atNode.set(n, []).get(n)!).push(s.id);
  const flags = (n: number) => (n > 0 && n < net.nodeCount ? net.nodeFlags[n] >>> 0 : 0);
  const lit = (n: number) => (flags(n) & (N_LIGHTS | N_LEVEL_CROSSING)) === N_LIGHTS && (flags(n) & N_JUNCTION) !== 0;
  for (const [n, segs] of atNode) if (lit(n)) for (const seg of segs) out.push({ seg, node: n, kind: 'signal' });
  if (tmpe) {
    if (prioritySignsOn) for (const p of tmpe.prioritySigns) if ((p.type === 'stop' || p.type === 'yield') && !lit(p.node) && (flags(p.node) & N_JUNCTION)) out.push({ seg: p.segment, node: p.node, kind: p.type });
  } else {
    for (const s of city.segs) {
      const f = s.id > 0 && s.id < net.segCount ? net.segFlags[s.id] >>> 0 : 0;
      for (const [n, bit] of [[s.sn, S_YIELD_START], [s.en, S_YIELD_END]] as const) {
        if (!(f & bit) || !(flags(n) & N_JUNCTION) || (flags(n) & (N_LIGHTS | N_ONEWAY_IN))) continue;
        out.push({ seg: s.id, node: n, kind: 'yield' });
      }
    }
  }
  return out;
}
