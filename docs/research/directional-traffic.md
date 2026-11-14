# Traffic by direction: what a save holds and how far it gets

2026-11-14. For issue #14 (traffic on the route, traffic by direction). Implementation: `src/sim/vehicles.ts`
(reader), `src/sim/directional.ts` (estimate), `npm run check:traffic-dir` (validation on real saves). Data: 19
same-moment save + CSLMapView export pairs (format 121034) from 4 cities. Game code read from the decompiled
Assembly-CSharp of the installed game.

## 1. What the save has

| Data | Per direction? | What it is (game code) |
|---|---|---|
| `NetSegment.m_trafficDensity` | no | The value the game's traffic view colours by. Every vehicle step adds 2.5 × (length + 1) to the segment; every 256 frames this becomes `min(100, buffer × 100 / (16 × car-lane length))`, then the stored value moves at most 5 points toward it. Smoothed over about 2 game hours. |
| `NetSegment.m_trafficBuffer` | no | The same sum, part way through the current 256-frame window. |
| `NetLane.m_reservedPrev/Next/Frame` | **yes (per lane)** | Each vehicle reserves its length + 1 m on its lane every 16-frame step (`CarAI` → `NetLane.ReserveSpace`), as a share of the lane length (0-255). The game uses it to check for space ahead. With `SimulationManager.m_currentFrameIndex` from the save it gives each lane's occupancy in the last complete step. |
| Vehicles (`VehicleManager`) | **yes** | Position, velocity, path unit and position index (so the segment and lane it is on), `m_blockCounter` (simulation steps in a row it couldn't move; resets when it moves), `m_waitCounter`, flags (`Stopped`, `Congestion`: set when the next lanes on its path have no space, and passenger cars with it are despawned on their next step). |
| Paths (`PathManager`) | **yes** | Every vehicle's planned route: segment and lane per position, chained across path units. Where each vehicle will drive next. |
| `NetNode` | — | Traffic-light flag (`0x800000`), maximum waiting time, junction counters. |
| Speeds per segment direction | no | TM:PE measures them while running but doesn't save them. |

So nothing in the save is a per-direction density, but three things are per direction: lane occupancy, the vehicles
themselves, and their paths.

## 2. Checks on the data

- **Direction of lanes:** a lane's direction comes from its prefab (`Forward` / `Backward`) and the segment's Invert
  flag. 99.6% of moving vehicles (46,379 of 46,546) travel the way their lane runs.
- **Lane reservations are occupancy:** per segment direction they match the vehicles on those lanes (r = 0.80), and
  250 × occupancy averages 10.8 against the game's density average of 9.5, which confirms the game's own scale.
- **One moment against two hours:** per segment, snapshot occupancy (both directions) correlates with the game's
  density at r = 0.63. One frame of vehicles is noisy against a value smoothed over hours.

## 3. Ground truth for a direction

No save stores traffic per direction, but one-way segments do have their own density, so the game's value on a
one-way segment is directional ground truth. Two uses:

1. **Calibration:** on 22,191 one-way segments, how well do the per-direction signals predict the game's density?
   Leave-one-city-out:

   | Signal | r | Within one 20-point band |
   |---|---|---|
   | lane reservations | 0.48 | 96% |
   | vehicles present (length + 1 m per lane length) | 0.59 | 97% |
   | near demand (paths crossing it within their next 8 positions) | 0.71 | 98% |
   | vehicles + near demand | **0.73** | 98% |
   | + stopped and blocked vehicles | 0.73 | 98% |

   Paths reach more segments than the vehicles on them at one instant, so demand is the strongest single signal. The
   game's value lags by up to two hours, which limits any snapshot.

2. **The split itself:** twin carriageways, two parallel one-way segments of one road (opposite directions, within
   45 m, same lanes, name and similar length), are a two-way road whose two directions each have a true density. Give
   the method only their combined density and compare its split with the truth (1,403 pairs in 3 cities):

   | | Error per direction (mean, points) | Within 20 points |
   |---|---|---|
   | Both directions get the combined value | 9.4 | 92% |
   | Split by the model | **6.0** | 97% |

   - When the two directions differ by 20+ points, the busier one is right 87% of the time (488 of 564).
   - With plenty of evidence (15+ vehicles or near passes) the error halves, 10.2 → 5.6. With little evidence there is
     no gain, and the shrinkage keeps it near the combined value.

## 4. The method

For each two-way segment with car lanes both ways (on a `.vellummap`, only roads whose real lanes a matched save
names):

1. Per direction, a per-lane density estimate from the fit: 64 × occupancy + 0.80 × near passes per 100 m of lane +
   2.8.
2. Their lane-weighted ratio is pulled toward the lane share in proportion to the evidence (vehicles present + near
   passes; 6 count as much as the even split).
3. The game's density is shared out by that ratio, so the lane-weighted average of the two directions stays exactly
   the game's value. A side that would pass 100% gives the rest to the other side.
4. Highways and ramps need 5 pieces of evidence, other roads 10 (section 8). Below that, both directions show the
   game's value.
5. First, the save's own moving vehicles must confirm the lane directions: 95% of them (at least 100) must travel the way
   their lane runs, or the save gets no split at all.

On the real save 24% of two-way segments have enough evidence (19 saves: 24% of 43,524). The rest are mostly quiet
roads, where the game's value is low anyway.

## 5. Queues at lights vs congestion

The game's density counts queued vehicles like any other, so the game's own traffic view also turns red for a queue
at a light. In a fit on one-way segments, stopped vehicles near a lit junction predict a high density (coefficient
12, against 3.7 for moving vehicles), because busy roads are the ones with lights and queues.

So the map keeps the game's meaning and labels the queue instead of hiding it. In the road panel, a direction whose
stopped vehicles are all within 40 m of a light ahead (at least 2) and none elsewhere reads "waiting at the lights".

- `m_blockCounter` doesn't separate them: a car at a red light is blocked too, and in the fit, vehicles blocked 20+
  steps carry no extra weight beyond being stopped.
- The `Congestion` flag is too rare to use, because passenger cars carrying it are despawned on their next step.

## 6. What it supports

- **Traffic layer:** from zoom 14, two-way roads with enough evidence are drawn as two lines, one per direction on
  its side of the road (right of travel). Others keep one line with the game's
  value.
- **Road panel:** the game's value plus each direction by compass heading, or "not enough vehicles to tell".
- **Route colouring:** with traffic-aware routing on, each stretch of the chosen driving route is coloured by the
  slowdown the traffic curve gives (×1.3 orange, ×2 red, ×3 dark red) in the direction driven, using the split where
  there is one and the segment's value otherwise.
- **Traffic-aware routing:** edges use the direction's density where split.
  - On the real save: 89% of 285 trips keep their path, the median time changes by +0.4%, and 16 trips (6%) change
    by more than 5% (−9% to +11%).
  - It stays an estimate, and only on when the user turns it on.

## 7. Limits

- **The moment of saving:** a snapshot, not a daily pattern or live traffic. Two saves minutes apart could differ;
  none of the test saves were close enough in time to measure that.
- **Left-hand traffic:** skipped (section 9).
- **Format:** format 121034 only. Older saves lay the vehicle records out differently and keep one value per segment.
- **Validation domain:** every twin carriageway found is a highway or a ramp. Ordinary streets have no ground truth;
  their reliability is judged by split-half agreement only, and they get the stricter threshold (section 8).
- **Vehicle lengths:** guessed from the vehicle type (the save has no sizes), which only affects the occupancy part.
- **What would make it exact:** a per-direction (per-lane) density stored by the game or a mod, e.g. TM:PE saving its
  measured mean speeds per segment direction, or several saves a few in-game minutes apart.

## 8. Audit (accuracy, generalisation, thresholds)

All from `npm run check:traffic-dir` on the 19 saves.

**Generalisation across cities.** Refitting the model without the city being tested changes little (error 6.00 →
6.08 points), so the fixed weights are not tuned to these cities:

| Held-out city | Twin pairs | Error, one value both ways | Error, split | Busier direction right (gap 20+) |
|---|---|---|---|---|
| 라스 크루즈 | 681 | 10.1 | 5.9 | 245/270 |
| Quda City | 111 | 17.1 | 6.3 | 103/104 |
| 서랑시 | 611 | 7.2 | 6.2 | 136/190 |

서랑시 gains least: its twin roads are less often lopsided, and its busier direction is right 72% of the time.

**Road types and length.**
- Highways (882 pairs): error 9.7 → 5.8.
- Ramps (521): 8.8 → 6.5.
- 40-80 m pieces: 10.6 → 6.4; 80-160 m: 8.5 → 5.9.

**Evidence.** Splitting at any evidence:

| Evidence | Pairs | Error, one value both ways | Error, split | Busier right |
|---|---|---|---|---|
| 0-1 | 4 | 10.8 | 10.7 | 2/3 |
| 2-4 | 62 | 7.7 | 7.5 | 16/22 |
| 5-9 | 182 | 7.7 | 6.8 | 53/72 |
| 10-19 | 478 | 7.2 | 6.3 | 102/139 |
| 20+ | 677 | 11.5 | 5.6 | 311/328 |

Below 5 there is no gain, so 5 stays as the threshold for highways and ramps.

**Misleading splits.** Of 226 splits showing a gap of 20+ points (city held out), 6 point the wrong way (2.7%) where
the true directions differ by 10+ points.

**Ordinary streets.** They have no ground truth, so their reliability is measured by splitting each save's vehicles
into two independent halves (even and odd) and comparing the two halves' shares:

| Evidence per half | Twins: r / clear splits agreeing | Streets: r / clear splits agreeing |
|---|---|---|
| 2-4 | 0.39 / 79% | 0.29 / 65% |
| 5-9 | 0.61 / 87% | 0.48 / 75% |
| 10-19 | 0.75 / 91% | 0.64 / 84% |
| 20+ | 0.92 / 97% | 0.80 / 90% |

At the same evidence, streets agree less than highways. They match the highways' agreement at the highways' threshold
only with about twice the evidence, so other roads need 10. Agreement measures noise, not bias, which remains untested
on streets.

**Consistency.** On 65 roads busy one way only (40+ points apart), driven both ways, route colours, travel times and
navigation speeds follow the direction driven every time. The audit found and fixed:
- Route colours and navigation speeds took the forward value when a road was driven backwards. The direction test
  only ran for roads with TM:PE limits.
- Travel-time areas, closure trips and step times didn't use the direction driven.

**Performance** (서랑시, 3,552 vehicles):
- Directional traffic adds 57 ms to a 620 ms save load.
- The page keeps 37 KB; about 8 MB of path data is temporary while loading.
- A traffic-aware route takes 52.9 ms instead of 51.6 ms.

## 9. Left-hand traffic

- **What the game does:** CSLMapView exports each lane's prefab direction (`NetInfo.Lane.m_direction`, in
  `MapInfoExporter`). The game drives `m_finalDirection`, which `NetInfo.InitializePrefab` sets to the inverse for vehicle
  lanes when the save's `m_invertTraffic` is on. So in a left-hand city every exported vehicle-lane direction is the
  reverse of the traffic on it.
- **The safeguard:** before splitting, each save's moving vehicles must agree with the lane directions. On all 19
  right-hand test saves, 99.6% agree. Taking the directions mirrored, as an unhandled left-hand city would, gives 0.3%,
  so the safeguard switches it off on every save.
- **What is missing:** none of the 143 local saves or 740 large Workshop files is a left-hand save, so mirroring for
  left-hand cities has never been seen to work. The feature stays off for them.
- **What a left-hand save would need:** turning it on means mirroring the lane directions and drawing each direction on
  the left of travel. The safeguard above would confirm the mirroring per save. That one save is all that's missing.

