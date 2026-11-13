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
- **Routing:** first switched off; now approximate, on estimated lanes (see [Approximate directions](#approximate-directions)). Save files (`.crp`) stay off.
  - The buttons stay visible but dimmed, with `aria-disabled`. Clicking one opens a panel that explains why.
  - Panel and right-click direction actions are hidden, and a one-time toast appears.
  - The drawer says "Opened from … (.vellummap, experimental)".
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
| Save files (`.crp`) | yes | **off** | the save is matched by segment prefab names |

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
