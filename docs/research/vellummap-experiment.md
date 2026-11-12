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
- **Routing is switched off** for files with no lane table: directions, "How far can I get?", "What if it closes?" and save files (`.crp`).
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
| Road class drawn | — | 5,790 / 7,094 the same | width separates ramps, highways, runways and taxiways; gravel paths and parking-lane quirks don't separate |
| Bridges | 435 | 314 found, 6 wrong | low bridges are only known from the prefab name |
| Tunnels | 152 | 152 found, 3 wrong | |
| Discoveries | 33 | 24, all also in `.cslmap` | missing: station-name ones (no names), street, widest road (lanes), footprint, parts |
| Driving, walking, transit directions | yes | **off** | no lane table |
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

- **Routing:** impossible to do reliably without lanes. An item-class lane guess put four of twelve test drives 46–70% off in the research spike. It is not used anywhere.
- **Road classes:** gravel paths draw as footpaths; the R69 racetrack draws as a highway ramp (width 12); some streets draw a class off.
- **Multi-part assets** are separate buildings, so toll booth sub-buildings count separately.
- **Attribution** in the map corner still says "CSLMapView" for a `.vellummap`.
- **Findfile help** only covers CSLMapView's folder. Bridge's folder (`Documents/Vellum Bridge/<city>/`) is not mentioned.
- **Spec drift:** written against Vellum `8857666`. A newer minor is tolerated; a major 2 is refused with a clear message.

## Assessment

**Not production-ready as a headline feature, but solid as an "experimental: map only" option.**

- The map itself is close to the `.cslmap` one and the reader is robust.
- Two things block calling it equivalent:
  - **No routing.** Directions and the save features are central to Skyline, and the format can't support them. This needs data upstream; parser work can't fix it.
  - **Unverified on real exports.** Every number here comes from converter output, which lacks exactly the fields that make `.vellummap` attractive (names, district grids, stats, station ids).
- Before shipping, even as experimental: test against a few real Bridge exports, ideally the same save exported by both mods, and decide whether a map-only mode is worth the support load.
