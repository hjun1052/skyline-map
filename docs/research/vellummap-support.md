# `.vellummap` support: research report (issue #5)

Research only: nothing in the app changed. This file and the scratchpad spike are the only outputs, and nothing is committed.

- Skyline Map: branch `feature/vellummap-support`, cut from `main` at `e531614`.
- Vellum: `sebas-tcotd/vellum` at `8857666` (Desktop 1.0.1, Bridge 1.x).
- Licence: MIT (`LICENSE`).

Spike code, the converted files and the raw outputs are in the session scratchpad. See [Appendix](#appendix-spike-artifacts).

---

## 1. Executive summary

**Reading `.vellummap` is easy. Matching what Skyline does with `.cslmap` is not, because the format is missing road data.**

The file is a zip of JSON modules and raw little-endian grids. It has a JSON Schema and a precise spec. A browser-native TypeScript reader is about 200 lines, needs no dependencies, and parses and maps a 4 MB file in about 110–140 ms (in Node).

In the spike, Skyline's existing pipeline (`buildCity`, `discover`, `Router`) ran on a `.vellummap` city unchanged. These came out the same as from the `.cslmap`:

- terrain, water and forests;
- about 6,400 building lots;
- rails, all 36 transit lines and all 57 stations;
- districts and parks.

The blocker is data, not parsing. `.vellummap` v1 has **no road prefab name and no lane table** (`.cslmap`'s `<SegmentTypes>`). Skyline uses those for:

- driving and walking directions;
- one-way detection;
- speed limits and access rules;
- ramp, bridge and tunnel classification;
- toll roads;
- save-file (`.crp`) matching.

Measured on the sample city (Seorang, 12 identical trips):

| Input | Driving routes found | Drive times vs `.cslmap` |
|---|---|---|
| `.cslmap` | 12/12 | reference |
| `.vellummap` v1 as it is | **0/12** | no route |
| v1 + guessed lanes per itemClass | 12/12 | 5 within 10%; four 46–70% too slow |
| v1 + each segment's prefab + a lane table | 12/12 | **identical, 12/12** |
| v1 + prefab + lane table from other cities only | 7/12 | 5 fail (workshop roads have no lane data); the rest 0–31% off |

**Feasibility:**

- **Map viewing:** high. A few days of work.
- **Directions parity:** needs one backward-compatible addition upstream: per-segment `prefab` plus lanes, as a new `roads` minor version. Vellum's own minor-version rule is designed for exactly this kind of addition.

**What Skyline gains** from `.vellummap`, compared with `.cslmap`:

- real district and park boundaries (Skyline currently estimates them);
- population, homes and jobs per district;
- stop names;
- station grouping (`stationId`);
- a stable city id across exports (useful for the time-lapse).

**Recommendation:** a TypeScript adapter in the worker that produces Skyline's existing `CityData`, plus a "capabilities" flag so the UI can say honestly when directions aren't available. Use Vellum's Rust converter and validator only as offline test tools. Propose `roads` 1.1 upstream. Details in [§5](#5-recommended-approach).

---

## 2. Architecture analysis

### Skyline Map

Single pipeline in a web worker. **Skyline's `CityData` is the only interface between the file and everything else.**

```
file bytes ─► worker.ts decode() (gzip sniff)       src/worker.ts:25
           ─► parseCity(xml) → CityData (raw)       src/parse.ts:98
           ─► inferOneWay / detectTolls             src/oneway.ts:29, src/tolls.ts
           ─► buildCity → GeoJSON sources, DEM      src/build.ts:285
           ─► discover, Router, closures, schematic src/worker.ts:52-66
           ─► page (MapLibre)                       src/main.ts
```

- **`CityData`** (`src/parse.ts:30`) stays close to the XML:
  - nodes with `srv/subsrv/dist/og/elev/ug`;
  - segments with prefab `name`, `customName`, points and transit `path`;
  - buildings with `srv/subsrv/icls`, `myname` and the sub-building chain `prntb/subb`;
  - a `segTypes` table (prefab → lanes);
  - raw `height`/`water` grids (1081²) and forest (512²).
- **Everything downstream reads only `CityData`.** That is the main reuse point: a second reader that fills `CityData` needs no changes to rendering or analysis code.
- **Format-specific code outside `parse.ts`:**

| What | Where |
|---|---|
| gzip detection | `src/worker.ts:25` |
| time-lapse scan (regex over XML) | `src/history.ts:28` |
| sample loading | `src/main.ts:131` |
| file pickers | `src/timelapse.ts:21` (`accept=".cslmap,.gz"`) |
| drop-zone copy | `index.html:136-137` |
| local dev export listing | `vite.config.ts` (`/\.cslmap(\.gz)?$/`) |
| "Where is my file?" paths | `src/findfile-os.ts` |
| recent cities (stores gzip) | `src/recent.ts:28` |
| save matching (compares prefab names) | `src/sim/validate.ts:65` |

- **Where lanes and prefab names matter:**

| Code | Use |
|---|---|
| `laneInfo`/`classify` (`src/build.ts:61,80`) | road class, oneway, speed, `motorway_link` |
| `src/oneway.ts:37` | one-way kind from lane directions |
| `src/router.ts:140,334` | edges, speeds, vehicle access |
| `src/access.ts:39` | walk, bike and car access |
| `src/discover.ts:487` | driving records |
| `src/sim/index.ts:142`, `src/sim/rules.ts:76,200,233` | save rules and traffic |

- **Sub-building chain** (`prntb/subb`): `buildingGroups` (`src/build.ts:203,435`), toll booths (`src/tolls.ts:50-57`), station naming.
- **District estimate:** a soft field from each node's `dist` (`src/build.ts:225-260`).

### Vellum

- **`packages/parser-cslmap`** (Rust crate, MIT) has two readers that feed one builder:
  - `.cslmap`: quick-xml event handlers → `RawCity` (`src/parser.rs`, `src/parser/handlers/*`).
  - `.vellummap`: `read_document` → `Document` → `into_raw()` → `RawCity` (`src/vellummap/read.rs`, `src/vellummap/mod.rs:80-280`).
  - `build_city_data(RawCity)` → `CityData` (`src/parser/builder.rs`).
- **Vellum's `CityData`** (`src/city_data.rs`) is **ready to render, not raw**:
  - WGS-84 land, coastline, contour polygons and terrain bands;
  - DEM as a PNG `data:` URI;
  - road segments with `WayType` flags;
  - building footprints;
  - forest cells;
  - district and park boundaries vectorized from the area grids.
  - It **does not keep the raw height and water grids**, which Skyline needs for its own DEM, contours, discoveries and water tests.
- **Strict reader** (`src/vellummap/read.rs`):
  - zip-bomb budgets from declared sizes, then inflates;
  - manifest checks: format, `MAJOR.MINOR`, RFC 3339 `Z` time, fixed module ids and paths, `codec` matches the zip method, `sha256` of inflated bytes, exact grid sizes;
  - the **minor rule**: unknown fields are an error at a known minor and ignored at a newer one (`serde_ignored` in `manifest::deserialize_scope`);
  - cross-module rules: water mask = depth > 16, area-grid ids exist, segment endpoints exist.
- **Reference converter** `cslmap_to_vellummap` (`src/vellummap/write.rs`), also as the example `examples/cslmap_to_vellummap.rs`.
- **Desktop** is a Tauri app. The crate depends on `tauri` directly: `Cargo.toml`, `src/parser.rs:17,35-79,193-233` (progress events).
- **Vellum Bridge** (`tools/vellum-bridge`, C# CS1 mod) writes the files:
  - extraction in `src/Export/VellumExtractor.cs`;
  - serialization in `src/Export/VellumWriter.cs`.

**Mismatch:** Vellum's shared model comes *after* the step Skyline needs. Skyline wants the `Document` level (raw modules), which the crate keeps `pub(crate)`.

---

## 3. Format compatibility

### Container (v1)

- **Zip entries:**
  - `manifest.json`;
  - `terrain.bin` (u16le 1081², 1/64 m);
  - `water.json`;
  - `water-mask.bin` (u8 1081²);
  - `water-depth.bin` (optional, u16le 1081²);
  - `vegetation.bin` (u8 512²);
  - `roads.json`, `transit.json`, `buildings.json`, `districts.json`, `parks.json`;
  - `districts.bin` and `parks.bin` (optional; u8×8 900², 19.2 m cells: 4 ids then 4 alphas).
- **Spec:** `docs/es/vellummap-format.md` (Spanish only) and `packages/parser-cslmap/schema/vellummap.schema.json`. The schema has 12 valid and 25 invalid examples.
- **Versions:**
  - manifest: `1.0` from the converter, `1.1` from Bridge 0.9+ (`city.id`);
  - modules: `buildings`/`districts` `1.1`, `transit` `1.2`.

### Field by field, onto Skyline's `CityData`

| Skyline field | `.cslmap` | `.vellummap` v1 | Mapping |
|---|---|---|---|
| `name`, `generated` | `<City>`, `<Generated>` (local time) | `city.name`, `exportedAtUtc` (ISO UTC) | direct. `fmtGenerated` and `exportTime` use `Date.parse`, which reads ISO. |
| `seaLevel` | `<SeaLevel>` | `water.json.seaLevel` | direct |
| `height` | `<Ter>` h/64 | `terrain.bin`/64 | **identical** (same `RawHeights2`, per Vellum's research) |
| `water` | `<Ter>` res/64 | `water-depth.bin`/64, or the mask only | identical with depth. With the mask only, wet cells need a synthetic depth and the shoreline loses sub-cell detail. |
| `forest` | `<Forest>` rows | `vegetation.bin` | **identical** (`m_tree`, verified on 262,144 cells upstream) |
| node `id, x, y, z, ug, elev` | ✓ | ✓ (`underground`, `elevation`) | direct |
| node `og` | ✓ | ✗ | approximate as `elev == 0 && !ug` |
| node `srv/subsrv` | ✓ | ✗ | derive from the itemClass of attached segments |
| node `dist` | ✓ | ✗ | **better:** sample `districts.bin` |
| seg `id, sn, en, icls, width, pts` | ✓ | ✓ | direct. Bridge samples curves every 25 m; `.cslmap` has 2 or 5 points. |
| seg `name` (prefab, e.g. "Oneway Road") | ✓ | **✗** | lost. ItemClass is coarser: `Small Road` = Basic Road, Oneway Road, Small 4 Lane… |
| seg `customName` (street name) | ✓ | `name` (`GetSegmentName`) | direct, but whether Bridge and CSLMapView name the same set of roads is **unverified** |
| seg `path` (transit legs) | `<Seg><Path>` per stop pair | `transit.lines[].route` (whole line, no leg boundaries) | rebuild legs by cutting the route at each next stop (heuristic; worked in the spike: 2,850 transit features, same as `.cslmap`) |
| `segTypes` (lanes, highway flag) | `<SegmentTypes>` | **✗** | lost (see §1) |
| building `id, subsrv, icls, pts` | ✓ | ✓ (`serviceType`, `itemClass`, `footprint`) | direct (rectangles in both) |
| building `name` (prefab) | ✓ | `prefab` (1.1) or `name` (1.0) | direct |
| building `myname` | player name | `name` + `customName` (1.1; renamed **or unique** buildings) | close; keep `customName` to separate the two |
| building `srv` | ✓ | ✗ | derive from sub-service and itemClass (worked for most; small drift in `utility`/`civic`) |
| building `parent/sub` | ✓ | **✗** | lost. Multi-part assets and toll booths split: spike counted 24 toll booths instead of 12. |
| districts, parks | id, name, label, type | same, plus area grids and district stats | direct, plus gains |
| transports | id, name, type, rgb, stop node ids | same, plus `#RRGGBBAA`, stop names, `stationId`, `classLevel` | direct, plus gains |

### What `.vellummap` adds

- **District and park boundaries** from the 900² area grids. Skyline currently estimates districts from road nodes (`src/build.ts:225`).
- **Per-district data:** `population`, `homes`, `jobs.{commercial,industrial,office}`, `specializations`.
- **Transit:** stop names (`nameDerived`), station grouping (`stationId`), city vs intercity split (`classLevel`).
- **Identity:** `city.id` and `snapshotId`/`parentSnapshotId` (time-lapse grouping without guessing from file names).
- **Data quality:** sha256 per module, and a water-depth provenance flag (`simulationPaused`).

### What is lost or needs heuristics

- **Lost:**
  - lane table and prefab names: directions, one-way, speed, access, ramps, toll segments, save matching;
  - sub-building chain.
- **Heuristic:**
  - `og` (on-ground flag);
  - node and building `srv`;
  - transit leg split.

### Bridge exports differ from converted files

Bridge exports differ from what the reference converter produces:

- Bridge exports networks `.cslmap` filters out, and Skyline must skip them:
  - water pipes, airplane and ship paths, connections, power lines;
  - `… Line` transit segments in `roads.json`;
  - about 6,000 `Untouchable` buildings per city in Vellum's corpus: pipe junctions, pillars, poles (`research/vellum-bridge/findings.md`).
  - Skyline's existing filters (`src/build.ts:83,92,127`) already cover most of these. The issue #2 pipe-junction fix is one of them.
- The **converter** (`write.rs`, via Vellum's `.cslmap` reader) **drops**:
  - street names: `src/parser/handlers/roads.rs:362` writes `name: None`;
  - landscaping canals, quays and flood walls (`roads.rs:357`): the spike lost 237 canals, and water features went from 258 to 21;
  - `… Line` segments.
- The converter also writes buildings, districts and transit as `1.0`: no display names, stats, grids or `stationId`.
- So converted files test the container and the grids well, but **under-represent** real Bridge exports.

---

## 4. Implementation options

Measured where possible: native builds on Apple Silicon, Node 26.

| | A. Vellum Rust → Wasm | B. TypeScript reader (port the read side) | C. Extract parts (schema + ajv) | D. Hybrid: B, with Rust tools only in tests | E. Convert to `.cslmap` XML, then `parseCity` |
|---|---|---|---|---|---|
| Works today? | **No.** `tauri` won't build for wasm32. After removing Tauri and two `std::thread::scope` calls (`read.rs` module reads, `builder.rs:411` terrain), it runs. | Yes (spike) | Partly | Yes | Possible |
| Output fits Skyline? | **No.** Vellum's render model, no raw grids. Would need a fork exposing `Document`. | Yes, fills `CityData` directly | n/a (validation only) | Yes | Yes, but throws away the gains |
| Runtime | 1.2–1.6 s single-threaded, plus 14–24 MB of JSON to parse in JS | 109–140 ms read + map (Seorang 4 MB, sha256 checked) | +ajv time | same as B | slow (build and re-parse ~20 MB of XML) |
| Bundle | 690 KB wasm (227 KB gzip) plus glue | ~3 KB min | +~120 KB (ajv) | ~3 KB | small |
| Memory | file copied into wasm memory, plus model and JSON | inflated modules (~25–30 MB per city), similar to today | + | same as B | + XML string |
| Browser support | wasm everywhere | `DecompressionStream('deflate-raw')`: Chrome 103, Firefox 113, Safari 16.4 (Skyline already needs `DecompressionStream('gzip')` and `CompressionStream`) | same | same | same |
| Maintenance | fork of a Tauri crate, Rust toolchain in CI, patch on each upstream change | own ~300 lines against a documented spec | schema copy to keep in sync | B, plus the converter as a test fixture generator | glue for a format that can't express the gains |
| Testability | Rust tests upstream | `tsx` checks like the existing `check:*` | | B, plus parity against Vellum's validator and converter | weak |
| Future `.cmm` | separate | same adapter pattern | | same adapter pattern | no |

Notes:

- **A:** what compiled is Vellum's whole crate, including marching squares, PNG encoding and contour bands that Skyline doesn't need. A trimmed fork would be smaller, but it is then a Rust copy of about 300 lines of zip/JSON reading, which TypeScript does with platform APIs.
- **Strictness:** Vellum's reader enforces its contract (unknown fields are an error at a known minor; unknown modules are an error). As a *consumer*, Skyline should be lenient:
  - accept any `1.x`;
  - ignore unknown fields and modules;
  - keep only the safety checks: zip-bomb budgets, exact grid sizes, required modules, and optionally sha256.
  - That keeps Skyline working when a newer Bridge adds fields.

---

## 5. Recommended approach

**Option D: a TypeScript format adapter in the worker, with Vellum's Rust converter and validator as dev-only test tools, plus an upstream proposal.**

1. **`src/formats/`**
   - `detect.ts` sniffs the bytes:
     - `PK\x03\x04` → vellummap;
     - `1f 8b` → gunzip, then sniff again;
     - `<`/BOM → cslmap.
   - `vellummap.ts`: zip central directory + `DecompressionStream('deflate-raw')`, module budgets and size checks, then a mapping to `CityData` as in §3. `parse.ts` stays the `.cslmap` adapter.
   - `.cmm` later becomes a third adapter behind the same `(bytes) → CityData` interface.
2. **`CityData` additions, all optional,** so `.cslmap` behaviour is unchanged:
   - `caps: { lanes: boolean; prefabs: boolean; buildingParts: boolean }`;
   - `districtGrid?` / `parkGrid?` (Uint8Array 900²×8);
   - `districtStats?`;
   - `stopInfo?` (name, `stationId`);
   - `cityId?`.
3. **Degrade honestly.** When `caps.lanes` is false:
   - turn off driving/walking/transit directions, reach and closures;
   - show one line: "Directions need lane data this file doesn't include."
   - Don't route on guessed lanes: the spike's itemClass guess was 46–70% too slow on four of the twelve trips, and would show wrong one-way streets with confidence.
   - Keep the guessed lanes for **road classes and line widths** only, where an error is cosmetic.
4. **Use the gains:**
   - real district boundaries in `districtSamples`/`districtField`;
   - district population and jobs in the place panel;
   - `stationId` for station grouping;
   - stop names in transit panels.
5. **Upstream.** Open a Vellum issue proposing `roads` 1.1:
   - per-segment `prefab`;
   - a `netInfos` table: prefab → `{ highway, lanes: [{ type, vehicleTypes, direction, position, width, speed }] }`, the same shape as `.cslmap`'s `<SegmentTypes>`;
   - optionally the segment `Invert` flag. `.cslmap` doesn't have it, so this would make one-way direction *exact*, where Skyline now infers it (`src/oneway.ts`).
   - Under their minor rule, older Vellum Desktops ignore the new fields.
   - It arguably passes their "atlas test" (`vellummap-format.md` § Prueba del atlas): one-way streets and speed limits are atlas facts.
6. **Licence hygiene.** Write the TypeScript from the spec rather than translating Rust line by line. If any code or fixtures are copied, add Vellum's MIT notice in a `THIRD_PARTY_NOTICES` file. MIT code is compatible with AGPL-3.0.

**Why not Wasm:**

- It doesn't produce the data Skyline needs.
- It needs a fork and patches to run at all.
- It is 10× slower here and adds about 227 KB gzipped.

The parsing problem is small. The data problem is upstream, and no amount of parser reuse fixes it.

---

## 6. Testing strategy

### Available material

- **Vellum fixtures** (`packages/parser-cslmap/fixtures`): 6 real cities as `.cslmap` (11–24 MB), plus small synthetic ones (minimal, transit, debug paths, unknown DLC, corrupted).
- **Schema examples:** `schema/examples/{valid,invalid}`, 37 module and manifest JSONs.
- **Skyline's sample:** `public/samples/seorang.cslmap.gz`.
- **Verified in this research:**
  - the release converter turns each fixture and Seorang into a `.vellummap` in 0.6–1.2 s (about 300 MB RSS);
  - all 5 pass Vellum's `validate_vellummap`;
  - Vellum's own suite passes: `cargo test -p parser-cslmap vellummap`, 97 passed.
  - Generating test files needs **no game**: `cargo run --release --example cslmap_to_vellummap -- in.cslmap out.vellummap`.

### Proposed checks

`npm run check:vellummap`, no Rust needed in CI:

1. **Container:**
   - read a small committed `.vellummap` (generated once from Seorang or a cropped fixture);
   - reject truncated zips, wrong grid sizes, a declared-size bomb, major `2.x`;
   - accept an unknown field at a newer minor.
2. **Parity, `.cslmap` vs converted `.vellummap`:** parse both, compare `CityData`:
   - terrain, water and forest arrays exactly;
   - node, segment and building ids and positions;
   - transit stops;
   - rebuilt transit legs vs `<Path>`.
   - Expected differences (prefab names, lanes, `og`, parents, canals and street names lost by the converter) are an explicit allow-list.
3. **Build parity:** `buildCity` stats within a tolerance. Feature counts for buildings, rails, transit, stations, districts and terrain should match. The spike's numbers are the baseline.
4. **Routing parity**, when lane data exists (upstream `roads` 1.1, or a hand-made fixture with `netInfos`): the 12-trip drive and transit comparison from the spike must match exactly.
5. **Browser:** load a `.vellummap` in headless Chromium (as in `langtest.mjs`) on desktop and mobile, EN/KO/RU; check the "no directions" state.

### What can't be tested without real Bridge exports

- Street-name coverage and whether it matches CSLMapView's names.
- Buildings `1.1`: display names, `customName`, `historical`.
- Districts `1.1` stats, and `districts.bin`/`parks.bin` (the converter writes neither).
- Transit `1.1`/`1.2`: `stationId`, `classLevel`, derived stop names.
- How many extra networks and `Untouchable` buildings Bridge exports, and whether Skyline's filters catch them all.
- Mask-only water (no depth): Bridge 0.9+ always pauses and writes depth, but older files may not.
- File size and speed on large cities (Bridge `roads.json` includes pipes, so it is bigger than converted files).

**Best fixture:** export the same save twice, once with CSLMapView and once with Vellum Bridge (Workshop 3815903587), with the game paused. Seorang would be ideal, because the `.cslmap` side is already the sample. That gives a matched pair for every check above. The issue author may also have Bridge files.

### Newer Bridge versions

- Under the minor rule, new fields come as minors. Skyline's lenient reader ignores them, so they won't break it.
- New modules or a major `2` would be visible in the manifest. Skyline should warn ("made by a newer Vellum Bridge") rather than fail when it can still read the required modules.
- Vellum plans `.quire` (multi-snapshot history) for after 1.0. That is a separate container, out of scope here.

---

## 7. Risks and unknowns

| Risk | Impact | Mitigation |
|---|---|---|
| No lanes or prefabs in v1 | no directions or save features for `.vellummap` | caps flag and honest UI; upstream `roads` 1.1 proposal |
| Upstream doesn't accept the proposal | lasting gap | itemClass lane guesses for appearance only; maybe route on them later, labelled approximate, if users want it |
| Young format (v1 since Sept 2026, Bridge 1.0.x; spec only in Spanish) | changes | lenient reader, version-tolerant tests, watch upstream releases |
| Heuristics (`srv`, `og`, transit leg split) | small misclassifications | allow-listed parity checks; tighten with a real Bridge pair |
| Lost sub-building chain | split multi-part assets, doubled toll booths | merge by footprint overlap/proximity, or ask upstream for `parentSourceId` in the same proposal |
| Save (`.crp`) matching compares prefab names (`src/sim/validate.ts:65`) | save features don't work on `.vellummap` | match on ids, endpoints and geometry only. The save's own prefab table could then *supply* prefab names, and lanes for vanilla prefabs: a later hybrid. |
| Workshop roads | a vanilla lane table covered only 75 of 179 prefabs (6,384 of 8,977 segments) in Seorang | real per-file lanes upstream, not a built-in catalog |
| Licence | MIT code in an AGPL project is fine with notice | write from the spec; add notices if code or fixtures are copied; credit Vellum in the README |
| Memory / zip bombs | tab crash | budgets from declared sizes before inflating (Vellum's limits: 1 MiB manifest, 256 MiB per JSON module, 1 GiB total) |
| Browsers older than Chrome 103 / Safari 16.4 / Firefox 113 | can't open `.vellummap` | already effectively Skyline's floor (gzip streams); show a clear error |

---

## 8. Implementation roadmap

Each phase is its own PR into `main` through the normal review and CI.

0. **Before code:**
   - get a matched CSLMapView + Bridge export pair (ideally Seorang);
   - open the upstream discussion on `roads` 1.1 (prefab, lanes, invert, building parent);
   - agree the caps-flag UX.
1. **Read and view, map only:**
   - `src/formats/detect.ts` and `src/formats/vellummap.ts`, the worker switching on the detected format, and `caps` in `CityData`;
   - accept `.vellummap` in the drop zone and pickers (`index.html:136-137`, `src/timelapse.ts:21`);
   - recent cities (`src/recent.ts`: store as-is, it's already compressed);
   - local dev listing (`vite.config.ts`);
   - "Where is my file?" Bridge paths (`~/Documents/Vellum Bridge/<city>/` on Windows, `~/Vellum Bridge/` on macOS and Linux);
   - Bridge credit next to CSLMapView;
   - turn directions, reach and closures off when there are no lanes;
   - i18n keys for EN/KO/RU (new strings only);
   - `check:vellummap` (container + parity), with a small committed fixture.
2. **Use the gains:**
   - district and park boundaries from the grids;
   - district stats in the place panel;
   - `stationId` station grouping and stop names;
   - `city.id`/snapshot ids in the time-lapse (`src/history.ts` gets a `.vellummap` scan beside the XML regex).
3. **Directions on `.vellummap`:**
   - when upstream ships lanes: map `netInfos` → `segTypes`, use `Invert` in `oneway.ts`, and enable routing; parity tests must match `.cslmap`;
   - optional save hybrid (prefab names from the `.crp`).
4. **`.cmm` (CSLModernMap):** a separate research spike. Per the issue comment it is JSON with base64 terrain; it would be a third adapter.

---

## Appendix: spike artifacts

The session scratchpad is temporary.

- `spike/vellummap.mts`: the browser-native zip reader and the `CityData` mapping. This is spike code, not a draft of the app code.
- `spike/compare.mts`: runs `.cslmap` and `.vellummap` through Skyline's pipeline: stats, one-way, tolls, discoveries, the 12-trip drive and transit timings.
- `spike/seorang4.txt`: the final comparison output, with the same trips for every variant.
- `vm/*.vellummap`: converted fixtures and Seorang.
- `wasm-try/`: the Tauri-free patched crate and the Node runner for the Wasm measurement.
