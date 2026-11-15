# `.cmm` (CSLModernMap) support

Skyline Map reads `.cmm` and `.cmm.gz`, the city document of the **CSLModernMap** mod (Steam Workshop 3781187198), into the same `CityData` as a `.cslmap` (`src/cmm.ts`). This note records what each field means, how sure we are, what the reader does with it, and how it compares with a `.cslmap` of the same city. Reproduce the numbers with `npm run check:cmm` (needs the local fixtures described below).

## Sources and how sure each statement is

There is no published specification. Statements are labelled by where they come from:

- **[mod]**: read from the mod's own exporter, decompiled from `CSLModernMap.dll` v6.7.3f1 with ILSpy. The relevant code is `CmmMapper.Map`, `CmmWriter`, `RoadGeometry.Facts` / `CaptureCarSpeeds`, and `CSLModernMapExporter` (nodes, segments, terrain, buildings, district grids). No mod code is copied into Skyline Map.
- **[cslmap]**: confirmed by comparing, id by id, with a CSLMapView `.cslmap` of the same city (서랑시, exported 2026-11-07 23:47). The `.cmm` is from 2026-11-14 12:52.
- **[save]**: confirmed against the game's own save (`.crp`) that matches that `.cslmap` exactly.
- **[inferred]**: neither of the above; stated as an inference.

One city and one mod version were tested. Other cities, game states or mod versions can differ.

## Container and versioning

- **Compression [mod]:** `.cmm.gz` is gzip around UTF-8 JSON without a BOM (`CmmWriter`); `.cmm` is the plain JSON. The mod writes to a temp file and validates the JSON before replacing the target.
- **Detection:** the worker gunzips first, as for any file. The data is taken as `.cmm` when it is a JSON object whose first key is `schema_version` with a `cmm-` value; the mod writes that key first [mod].
- **Version:** only `cmm-v1` is read. Any other `cmm-…` value shows "uses format …, which Skyline Map does not read yet". Missing or damaged structure shows "This .cmm is damaged: …" with the place that failed. No value turns into NaN on the map. Terrain grids must inflate to exactly 1081 × 1081 × 4 bytes and are cut off past that.
- **Size:** the test file is 12 MB gzipped and 60 MB of JSON.
- **Optional `traffic` key [mod]:** the mod embeds a TM:PE traffic snapshot (`TrafficSnapshotExporter`) under a top-level `traffic` key. The test file has one (8.6 MB: 4,464 road segments, 123 traffic lights), but it holds no measurements: all 10,549 vehicle lanes are counted as `vehicleLanesNoTmpeStats`. Every lane has `relativeSpeed` and `congestion` -1 and `vehicleCount` 0, and the city averages are -1. The mod fills them from TM:PE's `TrafficMeasurementManager.GetLaneTrafficData`, and every lookup failed here. Even when filled, a lane would carry only a relative speed (`meanSpeed / 10000`), and only for the road classes the snapshot exports. With no measured snapshot to check a mapping against, the reader skips the snapshot before parsing, which also saves memory. Traffic comes from a matched save instead, as for a `.cslmap`.

## Coordinates and geometry

- **Coordinates [mod][cslmap]:** game world metres, y up (`crs: "world-meters-y-up; rows=north"`), identical to a `.cslmap`. All 14,321 node x/z values are bit-identical.
- **Node heights [cslmap][save]:** 343 nodes differ in y only, by at most 1.10 m. The save matches the `.cslmap` exactly, so the heights changed in the game between the two exports, or the game settled them again on load [inferred].
- **Segment centrelines [mod][cslmap]:** sampled by the mod's own `RoadGeometry.Centerline`, with `extensions.cs1.centerline_tolerance_xz_m: 0.5`. Against CSLMapView's curves: median 0.00 m, p99 0.81 m, max 2.44 m.
- **Save matching:** the curves are not bit-identical to the game's, so a save is matched to a `.cmm` with exact prefab names and endpoints but geometry within tolerance, as for a `.vellummap` (`src/sim/validate.ts`, `tolerant`). The matched save verifies 14,321/14,321 nodes, 9,893/9,894 segments and every building, with verdict `match`.
- **Terrain [mod][cslmap]:** `height` and `water_depth` are base64 + zlib, little-endian float32, 1081 × 1081, row-major with rows running north (+z), in metres (`raw / 64`). Heights are identical to the `.cslmap`; 2 of 1,168,561 water depths differ (max 0.30 m).
- **The file's `cell` is wrong [mod][cslmap]:** the file says `cell: 15.985…` (17280 / 1081). The samples are actually 16 m apart, corner to corner (17280 / 1080), as Skyline Map already reads a `.cslmap`; ground-level node heights confirm it (median error 0.9 m at 16 m spacing vs 2.4 m at 15.985). The reader ignores `cell`.

## Networks (`networks`)

### Ids, kinds and derived tracks

- **Ids [mod][cslmap]:** network ids are the game's segment ids, with the same start and end nodes, prefab name (`name`), item class (`source_raw`) and width as the `.cslmap`, for 9,894/9,894 segments.
- **Derived tracks [mod]:** negative ids, `-(segment × 8 + i + 1)`, are copies of a road's tram lanes as their own `TRAM` network. `extensions.cs1.network_sources[id].segment_id` names the road. The reader drops them and maps stop paths that use them back to the road, which is what a `.cslmap` path holds.
- **`kind` [mod]:**
  - `ROAD`: car lanes, plane lanes, or a road AI;
  - `RAIL` / `METRO` / `TRAM` / `MONORAIL` / `CABLECAR`: track lanes;
  - `BEAUTIFICATION`: a pedestrian or bicycle lane, or the Beautification service;
  - `STOP_LINE`: a transit line's own stop-to-stop segment (prefab name `… Line`);
  - `OTHER`: everything else, including walking-tour lines, ferry paths, canals and power lines.
- **Excluded by the mod [mod]:** Ship Path, Airplane Path, Water Pipe and Transport Connection (outside connections) networks are not exported.

### Lanes: `lane_summary.car_lane_count` and `direction`

- **The rule [mod]:** the count is the number of prefab lanes whose lane type includes `Vehicle` or `TransportVehicle`, whose vehicle type includes `Car`, and whose final direction is not `None`. Bus lanes are counted. Parking lanes (lane type `Parking`) and tram-only lanes (vehicle type `Tram`) are not.
- **`direction` [mod]:** +1 if those lanes only go forward, -1 if only backward, 0 if both, all relative to the segment's start → end. The game's per-segment Invert flag is already applied.
- **Verified [cslmap]:** applying that rule to the `.cslmap`'s lane table reproduces `car_lane_count`, `direction` and `car_access` on **5,135/5,135** road segments.
- **Why only 58% matched before:** the earlier comparison used Skyline Map's own `laneInfo().vehicle`, which also counts parking lanes and tram lanes (`src/build.ts`). That count matches the file on only 2,997/5,135 segments. The two counts mean different things; neither is wrong.
- **Invert [mod]:** `extensions.cs1.network_sources[id].invert` is the game's per-segment Invert flag. A `.cslmap` does not carry it, which is why Skyline Map infers one-way directions there.

### Car access, one-way streets and speed limits

- **`car_access.forward/backward` [mod]:** "allowed" when a general car lane (lane type `Vehicle`, vehicle type `Car`) runs that way, Invert applied. `cs1-default-allow-v1` marks segments where a car lane had no direction and both ways were assumed; the test city has none.
- **`car_speed.forward/backward` [mod][save]:** m/s, the fastest effective limit of the car lanes in that direction, read through TM:PE's `SpeedLimitManager.GetGameSpeedLimit`, so custom TM:PE limits are included. It equals the prefab speed on 4,776 of 4,874 car roads. On all **98/98** others it equals the TM:PE limit in the save.

### How the reader builds lanes

Lanes come from the shipped lane catalogue (`src/lane-catalog.json`, prefab → lane table, built from real `.cslmap` exports), but only when the file confirms them:

- **Confirmation:** the catalogue's lanes, put through the mod's rule, must give exactly the file's count, direction and car access on *every* segment of that prefab (Invert undone).
  - Result on the test city: 7,550 road and path segments confirmed, 0 conflicts. All 8,625 segments with lanes have the same lane table as the `.cslmap`.
  - Caveat: the catalogue was partly built from this city's `.cslmap`, so its full coverage here is expected. Another city with road mods will have prefabs the catalogue doesn't know.
- **Unknown prefabs, or catalogue lanes the file contradicts:**
  - **Roads:** lanes are built from the file's facts alone: as many car lanes as the file counts, each open in the directions the file allows, at the file's speed. The file doesn't say how many lanes run each way, so the lanes of a two-way road are marked both ways. No sidewalks or bike lanes are invented, so walking and cycling don't use such a road.
  - **Paths** (kind `BEAUTIFICATION`): one pedestrian lane, so walking routes don't break at an unknown path. That kind means "has a pedestrian *or bicycle* lane", so this is an inference. Bicycle-only paths become walkable.
  - Tracks, ferry paths and the like that the catalogue doesn't know get no lanes, since the file says nothing about them.
  - `extras.factsOnly` lists these segments.
- **One-way directions are exact:**
  - car roads from `car_access`;
  - tracks (trams, trains, metro) from their lanes with the file's Invert flag applied;
  - result: 1,416 one-way segments, the same set as the `.cslmap`'s.
  - Accuracy: they agree with the direction transit vehicles were seen driving on **282/282** segments, and with the save's own one-ways on **1,416/1,416**.
  - By contrast, the `.cslmap`'s inferred directions (no Invert flag there) are wrong on 48 of them (96.6% right; 98.6% where it calls itself sure).
  - The router treats exact directions like confirmed ones (`OneWaySource 'exact'`): a route never breaks them.
- **Speed limits:** the router drives each road at the file's limit per direction (`Edge.spd`, as a matched save does), and road panels show it.

### Names

- **`display_name` [mod][cslmap]:** the player's street name (`m_flags` CustomName). 947/947 equal the `.cslmap`'s.
- **`game_name` [mod]:** the game's own generated street name (`NetManager.GetSegmentName`), on roads without a custom name. A `.cslmap` doesn't have it.
- **What the reader does:** it uses the player's name, else the game's. That adds 3,306 named segments, so roads labelled "Unnamed road" on a `.cslmap` show the name the game shows. In search, this city's 27 named roads become 316.

### Node fields

- **`mode_hint` [mod][cslmap]:** `TUNNEL` if the UnderGround flag is set, else `GROUND` if OnGround, else `ELEVATED`. Underground matches 14,321/14,321.
- **OnGround is lost under `TUNNEL`:** because `TUNNEL` takes precedence, OnGround is lost for nodes that have both flags. That affects 6 tunnel-portal nodes, which differ from the `.cslmap`. Nothing in the file tells them apart: like the other 290 tunnel nodes, they join only `TUNNEL` networks and sit well below the terrain. So they stay "not on ground". As a result, bridge and tunnel counts in the discoveries summary differ slightly (126 → 122 bridges, 36 → 38 tunnels).
- **Service is not in the file:**
  - from the sub-service: transport, park;
  - otherwise from the node's networks: roads, paths, tracks, dams and power lines (Electricity), canals (Beautification);
  - about 4,200 nodes that have no exported segment at all (water pipes and the like) get none.
- **Sub-service:** 14,321/14,321 match.

## Buildings

- **Matches [mod][cslmap]:** all 9,652 match on id, prefab (`name`), player's name (`display_name` with source `custom`), service, sub-service, item class, and the sub-building chain.
- **Chain fields:** `parent_building_id` and `sub_building_id` are the raw `m_parentBuilding` / `m_subBuilding` fields; `parent_id` / `child_ids` are the mod's tidied version.
- **Footprints:** identical 4-corner footprints (from the building's cell size and angle).
- **Base height [mod]:** `base_elevation_m` is the building position's y plus the model's lowest point. It equals the `.cslmap`'s height on 81% of buildings (88% within 0.1 m). The rest have basements or raised models. Used for the "highest building" record.
- **Category [mod]:** `category_name` is the game's localized category, missing on 2,425 buildings (the file's `MISSING_BUILDING_CATEGORY` issues). Skyline Map classifies by service and class, as for a `.cslmap`, so it is not used.

## Districts and parks

- **Grids [mod]:** each district and park has `grid_points`, the centres of the game's 900 × 900 district grid cells (19.2 m) that `DistrictManager.SampleDistrict` / `SamplePark` assigns to it.
- **Ids [mod]:** district ids are the game's own. Park ids are written as `-(id + 1)`, with `extensions.cs1.park_source_ids` mapping them back. The reader uses the game's ids, matching the `.cslmap` (38 districts and 8 parks, equal lists).
- **What the reader does:** district 0, the game's "no district", is left out of the grid. The other districts become the same exact district grid a `.vellummap` gives (`extras.districtGrid`), so district boundaries are the game's own, not estimated.
- **Verified [cslmap]:** where the `.cslmap` puts a node in a district, the grid agrees on 1,105/1,118 nodes (98.8%). The `.cslmap` names a district on only 1,118 of 14,321 nodes.
- **Not in the file:** district statistics (population and the like) aren't in the file; they come from a save.

## Transit

- **Lines [mod][cslmap]:** `transit_lines` match on id, name, type (`source_raw` = the game's transport type) and stop list, 37/37.
- **Colours:** 36/37 match. 전차 0호선 (line 8) is (73, 6, 134) in the `.cmm` and (169, 15, 255) in the `.cslmap`. Explained [save]: the matched save has line 8 with flags Created + Temporary + Hidden and no CustomColor. It is the transport tool's unfinished line, with no stops (its route's `stop_ids` is empty). The mod writes `TransportLine.GetColor()`, which falls back to the game's default colour when no custom colour is set. Neither value is a colour the player chose, and the default differed between the two exports, a week apart. The line has no stops or path, so nothing is drawn for it either way.
- **White [mod]:** the mod writes a white colour as `null`; the reader treats it as white.
- **Stops [mod]:** stops are line nodes; `network_node_id` is the node, as in a `.cslmap`. Stop names are always empty: the mod writes `Name("", "empty")`.
- **Stop names:** the reader names stops the same way as for a `.cslmap`, from nearby named station buildings, never invented. No other field carries a stop name.
- **Routes [mod]:** `routes[].path_segment_ids` is always empty, with `geometry_kind: STOP_DIRECT`. The real paths are on the `STOP_LINE` networks: each line's stop-to-stop segment carries the segment ids its vehicles drive (the game's path unit), exactly as a `.cslmap` stores them.
- **When the mod drops a path [mod]:** it drops it, and logs `INVALID_TRANSIT_PATH`, when a path segment is missing or not of the expected kind. This affects:
  - ferry paths, whose kind is `OTHER`/`BEAUTIFICATION`, not `FERRY`;
  - airplane and ship lanes, which aren't exported;
  - outside connections;
  - tram lanes without a derived track.
- **Tour lines [mod]:** walking-tour lines are `OTHER`, and the mod only fills paths for `STOP_LINE`, so they never have one.

Results by mode (legs = stop-to-stop segments):

| Mode | Legs | Exported path (= `.cslmap`) | Rebuilt (= `.cslmap`) | No path |
|---|---|---|---|---|
| Bus | 308 | 308 (308) | – | 0 |
| Metro | 59 | 59 (59) | – | 0 |
| Train | 68 | 58 (58) | – | 10 (9 have none in the `.cslmap` either; 1 runs to an outside connection) |
| Cable car | 10 | 10 (10) | – | 0 |
| Ferry | 19 | 0 | 19 (17, median length overlap 100%) | 0 |
| Walking tour | 29 | 0 | 25 (23) | 4 |
| Ship | 6 | 0 | – | 6 (lanes not in the file) |
| Airplane | 100 | 0 | – | 100 (lanes not in the file) |

### Rebuilding paths the file leaves out

`rebuildLeg` finds the shortest path along the lanes the line's vehicles use:
- each stop is snapped to the nearest such segment, within 24 m;
- lane directions are followed, with Invert applied;
- walking tours may go either way;
- the result runs from the first stop's segment to the second's;
- a path more than 4 times the straight distance is rejected;
- legs to the map edge (outside connections) are never rebuilt, because the connection segments are missing from the file and a "shortest path" would be invented.

How far this can be trusted was measured on legs whose path *is* known: the exported legs were hidden, rebuilt and compared.

| Mode | Found | Identical path | Length overlap (median / p10) |
|---|---|---|---|
| Cable car | 10/10 | 10/10 | 100% / 100% |
| Metro | 59/59 | 57/59 | 100% / 100% |
| Train | 34/58 | 33/34 | 100% / 100% |
| Bus | 263/308 | 195/263 (74%) | 100% / 22% |

Which rebuilt legs are used:
- **Used:** ferries, walking tours, metro and cable cars (`REBUILD` in `src/cmm.ts`), the kinds that reproduced the game's paths.
- **Not used:**
  - buses: their drivers weigh speed, lanes and traffic, not distance; 1 in 4 rebuilt paths differs, some by a lot;
  - trains: one rebuilt leg to an outside connection was entirely wrong before the edge rule;
  - tram, monorail and trolleybus: nothing to test with.
  Their legs without a path stay without one, as a `.cslmap` leaves a line with no path undrawn.
- **How the page shows rebuilt legs (never as exported geometry):**
  - drawn fainter (`est` on the transit feature);
  - the line panel says "Part of this line's path is estimated from the network it runs on, because the export doesn't include it";
  - `extras.inferredLegs` lists them for any other use.
- **Lines with no path at all:** these (ships, airplanes) are not drawn, and their panel says so.

## Feature compatibility

| Feature | `.cslmap` | `.vellummap` | `.cmm` |
|---|---|---|---|
| Map, styles, 3D buildings, terrain, water, forests | Full | Full | Full (identical terrain and forests) |
| Road types, lanes, speed limits, bike lanes | Full (prefab speeds) | Estimated for routing; not shown | Full: catalogue lanes confirmed by the file; effective (TM:PE) speeds. Facts-only lanes for unknown prefabs |
| One-way streets | Inferred direction (96.6% here) | Estimated | **Exact** (file's car access, and lanes with Invert) |
| Street names | Player's names | Player's names | Player's + the game's automatic names |
| Buildings, landmarks, sub-building chains | Full | No chains (overlays linked) | Full |
| Districts and parks | Estimated areas | Game's grid + statistics | Game's grid (no statistics without a save) |
| Search | Full | Full | Full (+ automatic street names) |
| Driving, walking, cycling directions | Full | Approximate | Full; driving follows exact one-ways and TM:PE limits |
| Transit visualization and directions | Full | Legs cut from whole routes | Exported paths for bus, metro, train, cable car; ferry and tour legs rebuilt (shown as estimated); ship and airplane lines undrawn; in transit directions a ship hop without a path is a straight stop-to-stop line at a default speed, as for any leg without a path in a `.cslmap` (airplanes are not used for directions in either format) |
| Closures, reach / travel-time areas, navigation | Full | Approximate | Full |
| Discoveries | Full | Some left out | Full (6 of 33 differ: names now known, and small bridge/tunnel differences) |
| Time-lapse | Yes | Yes | Yes (older `.cmm` files) |
| Simulation data (`.crp`) | Exact match | Geometry match | Prefabs exact, geometry within tolerance. Everything a `.cslmap` gets (traffic, by-direction traffic, rules, ridership) |

## Validation against the matched `.cslmap`

`npm run check:cmm` always runs the made-up-document tests. With `tools/fixtures/local/match.cmm.gz` (or `match.cmm`) and `match.cslmap` present (git-ignored symlinks), it also runs the comparisons above, plus:

- **Routing, 60 random trips per mode:**
  - walking, cycling and transit are identical within 2% on every trip;
  - driving is within 2% on 62% of trips and within 10% on 95%;
  - with the `.cslmap`'s prefab speeds and inferred one-ways swapped in, driving is within 2% on 98%. The differences are the file's exact one-way directions and TM:PE speed limits, not reader errors.
- **Search:** every point of interest, district, line and road name of the `.cslmap` is found.
- **Map statistics:** identical.
- **Discoveries:** 27 of 33 identical. The others:
  - three name a road the `.cslmap` called "Unnamed road";
  - one names a different junction road;
  - two differ by under 3% (viaduct length, road tunnel).
- **Travel-time area and closures:** both run; closure analysis worked on every sampled road.
- **With `tools/fixtures/local/match.crp`:** the save loads with verdict `match`. Its TM:PE limits equal the file's speeds and its one-ways equal the file's (above).

## Performance (서랑시: 12 MB `.cmm.gz`, 60 MB JSON; 20 MB `.cslmap`)

Measured on an M-series Mac. "Before" is the first version of the reader, which ran `JSON.parse` on the whole file. "After" adds `parseDoc`, which takes the district cells and the traffic snapshot out of the bytes first. Node: three runs each of a stage-timing script with `--expose-gc`, kernel peak RSS. Browser: three opens each in headless Chromium (software GL), RSS of the browser and all its processes sampled every 50 ms.

| | `.cslmap` | `.cmm.gz` before | `.cmm.gz` after |
|---|---|---|---|
| Read into `CityData` (Node) | 185–192 ms | 829–917 ms | 647–667 ms |
| of which parsing (gunzip excluded) | n/a (XML scan) | 920–1,230 ms (decode + `JSON.parse`, with GC pressure) | 549–689 ms (`parseDoc`) |
| Build the map (Node, same code) | 728–777 ms | 713–843 ms | 707–742 ms |
| Peak RSS after reading (Node) | 194 MB | 705–712 MB | 496–547 MB |
| Peak RSS reading and building (Node) | 328 MB | 762–840 MB | 549–680 MB |
| Heap kept after loading (city and built map) | 82 MB | 52 MB | 52 MB |
| Browser RSS rise while opening (all processes) | 710–760 MB | 826–1,093 MB | 806–828 MB |
| Open to ready map (headless) | 1.6–1.7 s | 2.0–2.7 s | 2.1–2.3 s |
| Page JS heap after opening | 54–60 MB | 60–64 MB | 64–68 MB |

- **Where the memory went before** (Node heap, after GC at each step): gunzipped bytes 60 MB; the decoded string 120 MB (two bytes per character, because the file has Korean names); the parsed document 165 MB, of which 117 MB was the districts' `grid_points`. Every 19.2 m cell of the map is listed at least once, as a two-number array: 1.62 million arrays. The traffic snapshot was another 10 MB, and all of these coexisted at the peak.
- **What changed:** `parseDoc` makes one string-aware pass over the bytes. It reads each `grid_points` list straight into a `Float64Array` (26 MB in all, freed once the district grid is built), drops the traffic snapshot, and parses the rest, which is 34 MB of JSON instead of 60 MB. The reader's output is byte-identical to before on the test city: city data and time-lapse identities both compared.
- **Trade-offs:** about 60 lines of hand-written scanning (string-aware, checks pair shape, unit-tested in `check:cmm`), and the traffic snapshot is no longer available to future code without changing `parseDoc`. Parsing got faster, not slower.
- **What's left:** the gunzipped bytes, the decoded string and the parsed document still overlap briefly. Going further would take a streaming JSON parser, a larger change for what is now about 100 MB more than a `.cslmap` in the browser. The heap kept after loading is smaller than for a `.cslmap`.
- **Rendering:** the drawn map is the same, so frame times are the same.

## Unresolved

- 6 tunnel-portal nodes lose their OnGround flag in the format. The file has nothing that tells them apart (above).
- Bus and train legs without an exported path are left without one: their rebuild isn't reliable enough to show.
- The mod's `traffic` snapshot (TM:PE) is not read. The test file's snapshot holds no measurements, so a mapping can't be validated (above).
- **Left-hand traffic: untested.** The file doesn't record the traffic side, and the mod never reads the game's setting. One-way directions, car access and speeds come from the game's final lane directions with Invert applied [mod], so they should hold. Catalogue lane positions, and anything that depends on which side vehicles keep to, have only been checked on right-hand cities.
- **Unknown workshop prefabs: partial.** Where the catalogue doesn't know a road prefab, or its lanes contradict the file, the road gets car lanes from the file's facts only: no sidewalks, bike lanes, parking or tram lanes. Driving is exact, but walking and cycling avoid those roads. Unknown track, ferry and path prefabs get no lanes. The test city had none, because the catalogue was partly built from it, so other cities will show this more.
