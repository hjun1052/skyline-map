# `.vellummap` support: experiment results

This is an experiment, not a decision to ship. It follows [the research report](vellummap-support.md) and lives on branch `experiment/vellummap-support`.

Everything below was measured on the sample city: Skyline's `public/samples/seorang.cslmap.gz`, and the same city converted to `.vellummap` by Vellum's reference converter (`tools/fixtures/seorang.vellummap`). No real Vellum Bridge export was available. See [Limits of the evidence](#limits-of-the-evidence).

## What was built

- **Reader** (`src/vellummap.ts`, about 13 KB minified, in the worker only):
  - zip central directory + `DecompressionStream('deflate-raw')`, with no dependencies;
  - written from Vellum's spec, with no Vellum code copied;
  - maps the file onto Skyline's existing `CityData`, so the whole pipeline (map layers, search, transit map, discoveries, time-lapse) runs unchanged.
- **What the reader accepts and rejects:**
  - lenient: any `1.x` version, unknown fields, unknown zip entries, missing optional modules;
  - strict: declared sizes are checked before anything is decompressed (1 MiB manifest, 256 MiB per JSON module, 1 GiB in total), grid sizes must be exact, required modules must be present, codec must match, sha256 must match;
  - errors are translated: not a city export, damaged (with the reason), or written by a newer Vellum Bridge.
- **Format detection** (`src/worker.ts`):
  - zip magic → `.vellummap`, otherwise `.cslmap`;
  - gzip is unwrapped first, so `.vellummap` files stored in recent cities reopen.
- **Data the format lacks is not invented:**
  - empty lane table, so no lanes, speed limits or one-way streets appear anywhere;
  - no sub-building chains;
  - `extras.caps` records this.
- **Derived values** (each one measured below):
  - node on-ground flag, from elevation and underground;
  - node and building service, from the item class (a 103-entry table read off 7 real exports; every class has exactly one service);
  - road type for drawing, from item class + width;
  - transit stop-to-stop legs, cut out of each line's whole route by dynamic programming.
- **Routing:** first switched off; now approximate, on estimated lanes (see [Approximate directions](#approximate-directions)). Save files (`.crp`) now work too (see [Saves](#saves-on-the-real-pair)).
  - The buttons stay visible but dimmed, with `aria-disabled`. Clicking one opens a panel that explains why.
  - Panel and right-click direction actions are hidden, and a one-time toast appears.
  - The drawer says "Opened from … (.vellummap)".
- **Uses data `.cslmap` doesn't have:**
  - the game's district grid draws real district areas instead of the estimate;
  - the district panel shows population, homes, jobs and specializations;
  - station platforms are grouped by `stationId`, and stop names come from the file when Skyline finds no named building.
  - None of these could be checked on real data: the converter writes neither the district grid nor stop data.
- **Time-lapse** accepts older `.vellummap` exports and mixes them with `.cslmap` ones (same ids and keys).
- **Discoveries:**
  - road totals use the drawn road class when there are no lanes;
  - "Biggest footprint" and "Most parts" are left out without building chains, since a wrong record is worse than none.
- **UI strings:** 11 new strings in English, Korean and Russian. Existing translations are unchanged; only additions.

## Results (sample city)

| What | `.cslmap` | `.vellummap` | Notes |
|---|---|---|---|
| Terrain, water, vegetation grids | — | **identical** (every cell) | |
| Nodes: ids, positions, elevation, underground | 14,321 | identical | |
| On-ground flag | from file | derived: 13,825 / 14,321 agree | |
| Road segments: ids, ends, class, points | — | identical | the converter drops landscaping canals and path-less line pieces |
| Buildings: ids, prefabs, sub-services, footprints | 9,652 | identical | |
| Building service (derived) | — | > 99% agree | |
| Transit lines: ids, names, modes, colours, stops | 36 | identical | |
| Transit legs (rebuilt from routes) | 438 | 418 exact | |
| Drawn transit line pieces | 2,850 | 2,850 | |
| Stations / bus stops | 57 / 186 | 57 / 186 | station names are missing in converter files |
| Lots / buildings / rails / roads drawn | 6,438 / 6,248 / 1,167 / 7,209 | 6,405 / 6,215 / 1,139 / 7,114 | tram and monorail tracks on roads need lanes; canals were dropped by the converter |
| Road class drawn | — | 4,312 / 7,094 the same; every difference is between neighbouring street classes | width separates ramps, highways, runways and taxiways. Small Road splits 58/42 minor/tertiary over 7 cities, so it is left unguessed (Seorang happens to lean tertiary) |
| Bridges | 435 | 314 found, 6 wrong | low bridges are only known from the prefab name |
| Tunnels | 152 | 152 found, 3 wrong | |
| Toll booths | 12 | 12 | a booth's " Sub" building is recognised by its prefab name |
| Discoveries | 33 | 20, all also in `.cslmap` | left out without the data: widest road (lanes), footprint and parts (building chains), longest bridge and viaduct (low bridges missed); station and street ones need names |
| Driving, walking, transit directions | yes | **approximate** | estimated lanes, see below |
| Save files (`.crp`) | yes | **yes** | matched by ids and geometry instead of prefab names (see below) |

**`.cslmap` behaviour is unchanged.** On the sample city, `main` and this branch produce identical hashes for:

- every map source, `meta`, the DEM and the district field;
- search, discoveries and one-way results;
- 60 routes (20 trip pairs × drive, walk and transit).

### Performance

| | `.cslmap` | `.vellummap` |
|---|---|---|
| File size | 5.1 MB gz (20 MB XML) | 4.0 MB |
| Read (Node, best of 3) | 197 ms | 145 ms (read 20–30 ms + map 80–100 ms) |
| Build + discoveries | 1,009 ms | 975 ms |
| Peak RSS, 4 runs | 601 MB | 541 MB |

- **In the browser** (headless Chromium, production build): 1.7 s from choosing the file to the map being ready, of which the worker's read and build take 1.2 s.
- **Other real cities** (Vellum's fixtures, converted) all open and draw: Altavento, Aurelia del Delta, Pepper Lake (17,838 buildings) and Island Hopping. Read takes 40–180 ms, build 0.26–1.5 s.

## Tests

- **`npm run check:vellummap`** (new, also in CI's build job):
  - mapping rules on documents built in the test;
  - lenient cases;
  - 14 damaged or unsupported cases: not a zip, no manifest, other format, major 2 document or module, missing module, sha256, codec, grid size, 300 MiB module, 2 GiB document, truncated, corrupted, invalid JSON, duplicate entries;
  - a reference-converter file;
  - full parity with the sample city, and mixed-format time-lapse.
- **All 16 existing checks pass**, and the production build passes.
- **Browser check** (scratchpad script, not committed: it needs a local headless Chromium):
  - loading through the real file input;
  - every switched-off entry point explains itself;
  - the right-click menu, search and place panels, and the transit map;
  - three error files, a gzipped file, and recent cities;
  - `.cslmap` afterwards keeps directions;
  - Korean and Russian on mobile.
  - All checks pass. One timing flake in the harness, which passed on rerun.

## Limits of the evidence

Only converted files were available. These can't be tested without real Vellum Bridge exports:

- **Not in converted files:**
  - street names;
  - building display names (station names on the map, landmark labels);
  - district stats and the district/park grids;
  - `stationId` and derived stop names;
  - `classLevel`.
  - The code paths are unit-tested on synthetic documents only.
- **Extra content in Bridge files:** water pipes, power lines, airplane and ship paths, line segments in `roads.json`, and about 6,000 `Untouchable` buildings per city. Skyline's filters handle the synthetic cases; real volume and variety are unknown.
- **Curve sampling:** Bridge writes a point every 25 m, where `.cslmap` has 2 or 5 points.
- **Leg splitting:** tested only on routes that are exact concatenations of `.cslmap` legs. Bridge's routes come from pathfinder units and may repeat or skip pieces.
- **Export time:** the converter guesses UTC from `.cslmap`'s local time, so the sample shows a shifted "Saved" time. Bridge writes true UTC.

## Remaining issues

- **Routing:** exact routing needs lane data upstream. The spike's item-class guess put four of twelve drives 46–70% off; the approximate routing below fixes most of that, but one-way vs two-way versions of the same class and width stay unknowable.
- **Road classes:** gravel paths draw as footpaths; the R69 racetrack draws as a highway ramp (width 12); some streets draw a class off.
- **Multi-part assets** are separate buildings (toll booths are handled through the " Sub" prefab name; other assets are not grouped).
- **Spec drift:** written against Vellum `8857666`. A newer minor is tolerated; a major 2 is refused with a clear message.

## Review pass

A second pass after the first experiment.

- **Attribution.** The map corner and the drawer footer credit the exporter of the open map: "Cities: Skylines · Vellum Bridge" and "Rendered from a Vellum Bridge export", or CSLMapView as before. The time-lapse tip follows the exporter too.
- **"Where is my file?"** now also shows Vellum Bridge's folder, each with its own copy button:
  - the paths come from Vellum's source (`ExportStorage.ExportFolder`): `%USERPROFILE%\Documents\Vellum Bridge` on Windows (with a OneDrive note, since `MyDocuments` follows a redirected Documents folder) and `~/Vellum Bridge` on macOS and Linux;
  - each city has its own subfolder (`VellumWriter.CityFolder`);
  - the find-file self-check pins the paths.
- **Rendering.** Measured against 7 real `.cslmap` exports, not one city:
  - **Medium Road** draws as primary (68% of 1,951 segments).
  - **Small Road** (58/42) is left to the default rules; the earlier tertiary rule fitted Seorang only and was removed.
  - **Rejected:** a "segment crosses water" bridge rule found 7 real bridges but invented 38–67.
  - **No signal in the data:** paths and tracks have no width difference between ground and elevated versions.
  - The check now requires every class difference to be between neighbouring street classes, instead of a match percentage on one city.
- **Zip security.** Found and fixed:
  - **Zip bomb.** Entries used to be fully decompressed before their size was checked. They now inflate into a growing buffer that stops the moment it passes the declared size. A 2 GiB bomb (2 MB compressed) is rejected in 5 ms with 6 MB of extra memory.
  - **Amplification.** Duplicate module records could inflate one entry many times. Now each module may appear once, at its fixed v1 path. Unknown modules are skipped without being inflated.
  - **Structure.** Added checks: end record must end the file; directory bounds; no multi-disk, zip64 or encrypted entries; at most 64 entries; local header name and method must match the directory; entries may not overlap.
  - **Manifest.** Known codec only; sha256 is now required.
  - **JSON shapes.** A non-list collection, non-numeric position, non-integer id or missing sea level gives a "damaged" message instead of a crash or NaN.
  - 19 new regression tests.
- **Feature degradation.** Newly covered:
  - **Cycling layer:** off with the explanation (bike lanes are lane data).
  - **Time-lapse:** road length uses the drawn road classes.
  - **Road panel:** shows the file's own item class, with a note that lanes, speeds and one-ways aren't in the file.
  - **Toll booths:** no longer doubled.
  - **Bridge records:** hidden.
- **Simplified.**
  - One `needLanes()` guard replaces seven copies.
  - The `.cslmap` and `.vellummap` time-lapse scans share one function.
  - The shared road-class set lives in `geo.ts`.
  - Unused fields (`parkGrid`, `cityId`, `waterDepth`, `formatVersion`, stop `derived`) were removed.
- **`.cslmap` unchanged:** identical hashes against `main` for map sources, meta, DEM, district field, search, discoveries, one-way, tolls, 60 routes and the time-lapse scan.

## Assessment

**Not production-ready as a headline feature, but solid as an "experimental: map only" option.**

_Written before routing and saves existed; superseded by [Approximate directions](#approximate-directions), [A real matched pair](#a-real-matched-pair) and [Saves on the real pair](#saves-on-the-real-pair)._

- The map itself is close to the `.cslmap` one and the reader is robust.
- Two things block calling it equivalent:
  - **No routing.** Directions and the save features are central to Skyline, and the format can't support them. This needs data upstream; parser work can't fix it.
  - **Unverified on real exports.** Every number here comes from converter output, which lacks exactly the fields that make `.vellummap` attractive (names, district grids, stats, station ids).
- Before shipping, even as experimental: test against a few real Bridge exports, ideally the same save exported by both mods, and decide whether a map-only mode is worth the support load.

## Approximate directions

A follow-up to "no routing": how far can routes get without lane data?

**Why the spike looked bad.** Its four slow drives came from:
- road mods whose classes never appear in other cities, which got no car lanes, so routes drove round them;
- toll-gate pieces (22.4 m) matched as ordinary 22 m highways;
- "2L2W" (two-way) mod highways read as one-way.

**What was built** (`src/lane-infer.ts`; details in [architecture.md](../architecture.md#approximate-directions-vellummap)):
- class + width catalogue from real .cslmap exports;
- family fallback;
- one-way evidence from bus routes, booths, class names and twin carriageways;
- a routing-only copy of the city.
- Every result is labelled approximate. No inferred one-way is treated as confirmed, and no estimated speed is shown as a limit.

**Measured** (`npm run check:vellum-routes`, each city's lanes estimated only from the other six, 40 trips per mode per city):

| | Found | Time within 10% | within 25% | Same path, worst 10% of trips |
|---|---|---|---|---|
| Drive | 280/280 | 92% | 99% | 84% |
| Walk | 234/234 | 99% | 100% | 100% |
| Transit | 240/240 | 99% | 100% | 100% |

- `.cslmap` routes, travel-time areas and closures are unchanged. The one exception is a router fix that drops alternatives drawing the same line as an earlier one, a bug that also showed on `.cslmap`.
- The converted Seorang fixture, through the real reader, gives the same quality. It is in the catalogue, so it is a smoke test.

**A real Vellum Bridge export** (Costa Tijuca, Bridge 0.9.0, the sample city shipped with Vellum Desktop) has no matching .cslmap, so it can only be checked for coverage and plausibility:
- 92% of road length matched by class + width; metro tunnels at an unseen width fell back to track;
- ship paths, airplane paths, pipes and connectors got no lanes;
- 60/60 drives found, at plausible average speeds (median 38 km/h);
- walking and cycling fail where the true network would too: walking found the same trips on true and estimated networks in four .cslmap cities.

**Limits:**
- one-way vs two-way versions of one class and width (Two Lane Highway, small one-way streets);
- road mods with lanes unlike anything in the catalogue;
- the numbers come from 7 cities and are not a guarantee for others.

## A real matched pair

A real Vellum Bridge 1.0.0 export of 서랑시 (2026-11-14) matches the 2026-11-07 CSLMapView export of the same city node for node: 14,321 nodes, and nothing was built in between. This is the first test on real Bridge output.

**What matched exactly:**
- every shared road's ends, item class and width (9,295 roads);
- every shared building's prefab, class and derived service;
- the 947 street names both exports have.

Bridge also names 3,495 more roads with the game's automatic names, so the map shows about 10 times as many street labels. 418 of 438 transit legs are identical, as with converted files.

**What it showed, now fixed in the reader:**
- **Ship and airplane lanes** (154 + 213 pieces) were drawn as ferry routes and taxiways. CSLMapView doesn't export them, so they're now skipped.
- **Network pieces exported as buildings** (pillars, medians, pipe junctions; 1,941, of which 108 were drawn) are now dropped. The rule: a building with a network's item class, except Beautification Item and dams.
  - Across the 7 CSLMapView exports this never removes a building those maps draw.
  - Drawn buildings now match the converted-file numbers (6,215 vs 6,248). The remaining 33 are parts of multi-part assets.
- **Node service** from the network class: 48% → 89% agreement. It only feeds the estimated-district fallback, which this format doesn't use.

**Map drawing.** Each road's drawn class and width now come from its estimated road type; lanes, speeds, one-ways, tram tracks and bridges still come from the file.

| Measure | Class + width rules | Estimated road type |
|---|---|---|
| Drawn class matches | 66% | 88% |
| Width within 1 m | 77% | 91% |
| Roads missing | 115 | 26 |
| False bridges | 74 | 74 |

The catalogue here was built from the other 6 cities.

**Approximate directions on the real file** (catalogue from the other 6 cities):
- every trip found: 80 drives, 80 walks, 80 transit trips;
- drive times within 10% for 98% and within 25% for 100%;
- walking and transit identical.
- A fallback that matches another variant of the same network by name ("Highway2L2W Tunnel" → "Highway2L2W") cut the roads whose estimate differs from 411 to 189.

What remains can't be told apart from the file:
- the R69 racetrack, which is Highway at 12 m, exactly like a ramp;
- small one-way streets;
- bus-only roads, which are Small Road at 16 m, like any small road.

**Discoveries:**
- 28 records, against 33 from CSLMapView;
- 20 identical, and 4 now name their road;
- longest road and rail tunnel come back: they come from the file's own tunnel classes and flags, and both match exactly;
- still left out without the data: longest bridge and viaduct (low bridges), widest road (lanes), biggest footprint and most parts (building chains).

**Tested before deciding:**

| Records | Test | Outcome |
|---|---|---|
| Road and rail tunnel | Each of the 7 CSLMapView cities, stripped to what a .vellummap holds | Identical in all 14 cases: kept |
| Bridge and viaduct | The same test | Wrong in 5 of 7 cities (one longest bridge 1.27 km instead of 3.09 km): still left out |

- **Bridges from node height:** missed 310 instead of 166, so not used. Most misses are low bridges whose nodes sit at ground level; only the prefab name marks them.
- **Cable car lines** no longer count as bridges (41 false ones), which halves false bridges to 33.

**Multi-part assets:**
- A part shares its main building's workshop prefix 80% of the time.
- Grouping by prefix and touching footprints is wrong for 59% of the pairs it makes, because neighbouring buildings from one asset pack share a prefix.
- What is reliable: a same-prefix building mostly inside a bigger one of a different class, as glass, roof and platform overlays are. That is right for 212 of 215 links on 7 cities, a third of all parts. These are linked; the rest stay separate.
- On the real file, buildings drawn only on the Bridge map dropped from 127 to 1.
- The records that add parts up stay off.

## Saves on the real pair

The 서랑시 save (`.crp`) that the CSLMapView export was written with also matches the Bridge export (`npm run check:vellum-sim`; catalogue from the other 6 cities):

- every node, road and building of the Bridge export matches the save, and all 36 lines;
- traffic density on 9,000+ shared roads, occupancy on 9,000+ shared buildings and every line's ridership are identical to the same save on the `.cslmap`;
- grids and city statistics read; one-way count identical; TM:PE and U-turn rules placed (at least 98% / 95% of the `.cslmap` count);
- 95% of driving roads get their real prefab lanes from the save; the rest stay estimated;
- driving with the save matches CSLMapView + save within 5% for 98% of 60 trips.

**Road facts, cycling and navigation** (same catalogue from the other 6 cities):
- the save names a prefab for 13,436 matched roads and paths; for the 8,409 it knows, lanes, speed limit, one-way and bike lane equal the CSLMapView export on every one;
- 95% of drivable road length is covered; 10 of the city's 39 bike-lane pieces are on covered roads (all 39 with the shipped catalogue, which includes this city);
- navigation shows no limit without the save and only CSLMapView's own values with it (25–100 km/h).
- TM:PE counts differ a little where roads stay estimated (speed 106 vs 98, turn bans 12 vs 6); with every prefab known they are identical. Every differing rule (8 speed, 2 restriction, 6 turn and 8 U-turn) is on a road whose prefab the catalogue doesn't know, so its lane layout is guessed: TM:PE's values come from the save, but which lanes (and so which direction) they sit on is a guess. None of 300 random drives passes them (298 within 5% of CSLMapView + save). Navigation shows a TM:PE limit on such a road only when both directions agree.

**Districts and stations:**
- the Bridge district grid equals the save's DistrictManager grid on every cell the save stores (40,041 cells of the central 512² area; the 900² Bridge grid beyond it can't be checked against this save);
- all 37 district populations equal the save's; ids, names and label positions equal CSLMapView;
- buildings get their district from that grid, so 18% of buildings land in a different district than CSLMapView's estimate — the Bridge value is the game's;
- 57 stations on both maps with the same names; 8 that CSLMapView leaves unnamed take the stop name the Bridge file carries.

**Discoveries still off:** widest road, longest bridge and viaduct, biggest footprint and most parts. A save could feed some of them (prefab names mark bridges, lanes give width), but only one test city has a save, which can't show them reliable, so they stay off.

In the browser (built catalogue, which includes this city) the save covers 100% of roads, the traffic layer draws, and every panel names where its lanes come from.

**What this can't show:** one save on one city. A save from another game version, a city with many workshop road prefabs the catalogue doesn't know, or a Bridge export made long after the save will match fewer objects; the panel says so (close match / too far apart), as it does for `.cslmap`.

## End-to-end audit

Journeys run in headless Chromium on fresh profiles (browser emulation, not real devices): desktop 1280×860 in English, phone 390×844 with touch in Korean, tablet 820×1180 with touch in Russian. Import with the first-open notice, search, station, district, road and building panels, all four route modes with alternatives, reach, closure, navigation at 10×, the save (status, every overlay, road/building/line panels, cycling, drawer), routes and navigation again, discoveries, removing the save, a different city's save, an older save of the same city, switching to the .cslmap of the same city and back, loading a save before exploring, reopening from recent cities with the remembered save, and switching to another city.

Found and fixed (most also affected .cslmap):
- Directions redrew its last route on the map while closed whenever a save loaded or was removed.
- A save loaded while its map was still being stored in recent cities was lost, so the city reopened without it; recent-city reads and writes now run in order.
- Esc from the map didn't close the closure, reach, discoveries or save panels.
- Alternatives that drew the same line to the metre (but not the micrometre) were both shown.
- The approximate-route note was five lines on a phone and mentioned one-way streets for walking and transit.
- Recent cities kept one entry per city name, so a .cslmap and a .vellummap of the same city replaced each other; they are now separate entries, and older stored entries move over with their saves.

Kept as is: the first-open notice shows on every file pick until "Don't show this again" (reopening from recent cities skips it); station names that only the Bridge file carries (the game's own stop names) are shown.

