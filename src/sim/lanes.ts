// Lane-by-lane moves from TM:PE lane connections (issue #26), shared by the rules (sim/rules.ts) and the router.

/**
 * A move from segment `from` at node `node` onto segment `to`, lane by lane (export lane indices): `lanes` are the car
 * lanes of `from` arriving at the node, and `targets[k]` the lanes of `to` a car in `lanes[k]` can take (null: any of
 * them; []: it can't go there). Only TM:PE lane connections name single lanes; a lane without connections takes any
 * lane its arrows allow, as the game lets a car change lanes at every node.
 */
export interface LaneMove { from: number; node: number; to: number; lanes: number[]; targets: (number[] | null)[] }

/** lanes (bit i: export lane i) a car may be in after `m`, coming from the lanes in `mask`
 *  (-1: every lane): 0 = any lane, -1 = none */
export function laneStep(m: LaneMove, mask: number): number {
  let out = 0;
  for (let k = 0; k < m.lanes.length; k++) {
    if (!(mask & (1 << m.lanes[k]))) continue;
    const t = m.targets[k];
    if (t === null) return 0;
    for (const j of t) out |= 1 << j;
  }
  return out || -1;
}
/** every lane of a move's `from` arriving at its node */
export const laneAll = (m: LaneMove) => m.lanes.reduce((a, l) => a | (1 << l), 0);
