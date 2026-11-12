// .vellummap reader checks. Run: npm run check:vellummap
//  1. container and mapping rules on small documents built here (valid, lenient cases, damaged and unsupported);
//  2. a file from Vellum's reference converter (tools/fixtures/minimal-valid.vellummap);
//  3. parity: the sample city opened from .cslmap and from the reference converter's .vellummap of it
//     (tools/fixtures/seorang.vellummap) must give the same grids, nodes, buildings and transit, and buildCity
//     must draw the same map apart from the differences the format explains (no lanes, no sub-building chains).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { readVellummap, vellumToCity, splitLegs, serviceOf, areaAt, isZip, FormatError, vellumIdentities } from '../src/vellummap.ts';
import { parseCity, type CityData } from '../src/parse.ts';
import { buildCity } from '../src/build.ts';
import { inferOneWay } from '../src/oneway.ts';
import { detectTolls } from '../src/tolls.ts';
import { cityKeys, scanIdentities } from '../src/history.ts';
import { discover } from '../src/discover.ts';

let failed = 0;
const ok = (cond: unknown, what: string, got?: unknown) => { if (!cond) { failed++; console.error(`FAIL ${what}${got !== undefined ? ' → ' + JSON.stringify(got) : ''}`); } };
async function rejects(p: Promise<unknown>, key: RegExp, what: string) {
  try { await p; ok(false, what + ' (accepted)'); } catch (e) { ok(e instanceof FormatError && key.test(e.message), what, (e as Error).message); }
}

// ------------------------------------------------------------ a tiny zip writer (tests only)
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const deflate = async (b: Uint8Array) => new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('');
interface ZEntry { name: string; data: Uint8Array; store?: boolean; fakeSize?: number }
async function zip(entries: ZEntry[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let off = 0;
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name), body = e.store ? e.data : await deflate(e.data), crc = crc32(e.data), usize = e.fakeSize ?? e.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, e.store ? 0 : 8, true); lh.setUint32(14, crc, true); lh.setUint32(18, body.length, true); lh.setUint32(22, usize, true); lh.setUint16(26, name.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(10, e.store ? 0 : 8, true); ch.setUint32(16, crc, true); ch.setUint32(20, body.length, true); ch.setUint32(24, usize, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    parts.push(new Uint8Array(lh.buffer), name, body); central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
  let p = 0; for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

// ------------------------------------------------------------ a small valid document
const T = 1081, A = 900;
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
function u16le(v: (i: number) => number, n: number) { const b = new Uint8Array(n * 2), dv = new DataView(b.buffer); for (let i = 0; i < n; i++) dv.setUint16(i * 2, v(i), true); return b; }
const cellOf = (x: number, z: number) => Math.floor((z + 8640) / 16 + 0.5) * T + Math.floor((x + 8640) / 16 + 0.5);
type Mods = Record<string, Uint8Array>;
function baseModules(): Mods {
  const terrain = u16le((i) => (i % T < 540 ? 100 * 64 : 50 * 64), T * T); // west half 100 m, east half 50 m
  const depth = u16le((i) => (i % T >= 1000 ? 12 * 64 : 0), T * T); // a strip of sea in the far east
  const mask = new Uint8Array(T * T).map((_, i) => (i % T >= 1000 ? 1 : 0));
  const veg = new Uint8Array(512 * 512); veg[5] = 200;
  const dist = new Uint8Array(A * A * 8);
  for (let j = 0; j < A; j++) for (let i = 0; i < 450; i++) { const c = (j * A + i) * 8; dist[c] = 3; dist[c + 4] = 255; } // district 3: the west half
  const P = (x: number, z: number, y = 100) => ({ x, y, z });
  return {
    'terrain.bin': terrain, 'water-mask.bin': mask, 'water-depth.bin': depth, 'vegetation.bin': veg, 'districts.bin': dist,
    'water.json': enc({ seaLevel: 40, depth: { simulationPaused: true } }),
    'roads.json': enc({
      nodes: [{ sourceId: 1, position: P(-2000, 0), elevation: 0, underground: false }, { sourceId: 2, position: P(-1000, 0), elevation: 0, underground: false }, { sourceId: 3, position: P(0, 0), elevation: 12, underground: false },
        { sourceId: 4, position: P(1000, 0), elevation: 0, underground: true }, { sourceId: 10, position: P(-1500, 10), elevation: 0, underground: false }, { sourceId: 11, position: P(-500, 10), elevation: 0, underground: false }],
      segments: [
        { sourceId: 100, startNodeSourceId: 1, endNodeSourceId: 2, itemClass: 'Medium Road', width: 16, name: 'Elm Street', points: [P(-2000, 0), P(-1500, 0), P(-1000, 0)] },
        { sourceId: 101, startNodeSourceId: 2, endNodeSourceId: 3, itemClass: 'Medium Road', width: 16, name: 'Elm Street', points: [P(-1000, 0), P(-500, 0), P(0, 0)] },
        { sourceId: 102, startNodeSourceId: 3, endNodeSourceId: 4, itemClass: 'Highway', width: 22, points: [P(0, 0), P(1000, 0)] },
        { sourceId: 103, startNodeSourceId: 1, endNodeSourceId: 4, itemClass: 'Water Pipe', width: 2, points: [P(-2000, 0), P(1000, 0)] },
        // the bus line's own segments, as Bridge exports them (no path: that is in transit.json)
        { sourceId: 200, startNodeSourceId: 10, endNodeSourceId: 11, itemClass: 'Bus Line', width: 0, points: [P(-1500, 10), P(-500, 10)] },
      ],
    }),
    'transit.json': enc({ lines: [{ sourceId: 7, name: 'Line 7', transportType: 'Bus', color: '#FF6600FF', classLevel: 0, route: [100, 101, 101, 100],
      stops: [{ sourceId: 10, position: P(-1500, 10), name: 'Elm Street 1', nameDerived: true }, { sourceId: 11, position: P(-500, 10), name: 'Central', nameDerived: false, stationId: 900 }] }] }),
    'buildings.json': enc({ buildings: [
      { sourceId: 900, prefab: 'Bus Station', name: 'Central', customName: true, itemClass: 'Bus Facility', serviceType: 'PublicTransportBus', footprint: [P(-520, 30), P(-480, 30), P(-480, 60), P(-520, 60)] },
      { sourceId: 901, name: 'H1 1x1 Sweatshop01', itemClass: 'Low Commercial - Level1', serviceType: 'CommercialLow', footprint: [P(-1900, 30), P(-1880, 30), P(-1880, 50), P(-1900, 50)] },
    ] }),
    'districts.json': enc({ districts: [{ sourceId: 3, name: 'Westside', labelPosition: P(-4000, 0, 0), population: 1234, homes: 500, jobs: { commercial: 10, industrial: 20, office: 30 }, specializations: ['Tourist'] }] }),
    'parks.json': enc({ parks: [{ sourceId: 1, name: 'Zoo Park', labelPosition: P(-3000, 2000, 0), parkType: 'Zoo' }] }),
  };
}
const IDS: Record<string, string> = { 'terrain.bin': 'terrain', 'water.json': 'water', 'water-mask.bin': 'water-mask', 'water-depth.bin': 'water-depth', 'vegetation.bin': 'vegetation', 'roads.json': 'roads', 'transit.json': 'transit', 'buildings.json': 'buildings', 'districts.json': 'districts', 'parks.json': 'parks', 'districts.bin': 'district-grid', 'parks.bin': 'park-grid' };
async function doc(mods: Mods, o: { version?: string; manifestExtra?: object; moduleVersion?: Record<string, string>; badHash?: string; codec?: Record<string, string>; extraEntries?: ZEntry[]; drop?: string[]; fakeSize?: Record<string, number> } = {}) {
  const paths = Object.keys(mods).filter((p) => !o.drop?.includes(p));
  const modules = await Promise.all(paths.map(async (p) => ({ id: IDS[p], path: p, version: o.moduleVersion?.[p] ?? '1.0', codec: o.codec?.[p] ?? 'deflate', sha256: p === o.badHash ? '0'.repeat(64) : await sha(mods[p]) })));
  const manifest = { format: 'vellummap', exportSchemaVersion: o.version ?? '1.1', snapshotId: 'x', exportedAtUtc: '2026-09-23T14:05:00Z', game: { version: 'unknown' }, producer: { name: 'Vellum Bridge', version: '1.0.0' }, city: { name: 'Testville', id: 'abc' }, modules, ...o.manifestExtra };
  return zip([{ name: 'manifest.json', data: enc(manifest) }, ...paths.map((p) => ({ name: p, data: mods[p], fakeSize: o.fakeSize?.[p] })), ...(o.extraEntries ?? [])]);
}

// ------------------------------------------------------------ 1. rules
{
  const city = vellumToCity(await readVellummap(await doc(baseModules())));
  ok(city.name === 'Testville' && city.generated === '2026-09-23T14:05:00Z' && city.seaLevel === 40, 'manifest fields', [city.name, city.generated, city.seaLevel]);
  ok(city.terrainSize === 1081 && city.height[0] === 100 && city.height[1080] === 50, 'terrain in metres, row-major', [city.height[0], city.height[1080]]);
  ok(city.water[1080] === 12 && city.water[0] === 0, 'water depth in metres', city.water[1080]);
  ok(city.forest[5] === 200 && city.forestSize === 512, 'vegetation grid');
  const n3 = city.nodes.get(3)!, n4 = city.nodes.get(4)!, n1 = city.nodes.get(1)!;
  ok(n1.og === true && n3.og === false && n3.elev === 12 && n4.ug && n4.og === false, 'node elevation, underground, on-ground', [n1.og, n3.og, n4.og]);
  ok(n1.dist === 3 && n4.dist === 0, 'node district from the district grid', [n1.dist, n4.dist]);
  ok(city.segTypes.size === 0, 'no lane table invented');
  const s100 = city.segs.find((s) => s.id === 100)!;
  ok(s100.customName === 'Elm Street' && s100.icls === 'Medium Road' && s100.pts.length === 3 && s100.path === null, 'road segment', s100);
  const lineSeg = city.segs.find((s) => s.path);
  ok(lineSeg?.id === 200 && lineSeg.sn === 10 && lineSeg.en === 11 && lineSeg.path!.join() === '100,101', "transit leg on the line's own segment, cut at the stop", lineSeg);
  ok(city.segs.filter((s) => s.path).length === 2, 'one leg per stop pair (loop)', city.segs.filter((s) => s.path).map((s) => [s.sn, s.en, s.path]));
  const tr = city.transports[0];
  ok(tr.id === 7 && tr.type === 'Bus' && tr.color.join() === '255,102,0' && tr.stops.join() === '10,11', 'transit line', tr);
  const b900 = city.buildings.find((b) => b.id === 900)!, b901 = city.buildings.find((b) => b.id === 901)!;
  ok(b900.name === 'Bus Station' && b900.myname === 'Central' && b900.srv === 'PublicTransport' && b900.subsrv === 'PublicTransportBus', 'buildings 1.1: prefab, shown name, service', b900);
  ok(b901.name === 'H1 1x1 Sweatshop01' && b901.myname === '' && b901.srv === 'Commercial', 'buildings 1.0: name is the prefab', b901);
  ok(city.districts[0].name === 'Westside' && city.parks[0].type === 'Zoo', 'districts and parks');
  const ex = city.extras!;
  ok(ex.source === 'vellummap' && !ex.caps.lanes && ex.cityId === 'abc' && ex.waterDepth && ex.producer === 'Vellum Bridge 1.0.0', 'extras', { ...ex, districtGrid: undefined, parkGrid: undefined });
  ok(ex.districtStats.get(3)?.population === 1234 && ex.districtStats.get(3)?.jobs?.office === 30, 'district stats');
  ok(ex.stopInfo.get(11)?.stationId === 900 && ex.stopInfo.get(11)?.name === 'Central' && ex.stopInfo.get(10)?.derived === true, 'stop names and station ids');

  const built = buildCity(city, () => {}, inferOneWay(city), detectTolls(city));
  ok(built.meta.source?.format === 'vellummap' && built.meta.source.lanes === false && built.meta.source.exactDistricts, 'built map says what it can do', built.meta.source);
  ok(built.sources.roads.features.every((f) => f.properties.lanes === 0 && f.properties.speed === 0 && f.properties.oneway === 0), 'no lanes, speeds or one-ways shown');
  ok(!built.sources.roads.features.some((f) => f.properties.id === 103), 'water pipes are not roads');
  ok(built.sources.roads.features.find((f) => f.properties.id === 102)?.properties.cls === 'motorway', 'highway class from the item class');
  ok(built.sources.roads.features.find((f) => f.properties.id === 100)?.properties.cls === 'primary', 'medium road class from the item class');
  const dpl = built.sources.places.features.find((f) => f.properties.kind === 'district');
  ok(dpl?.properties.pop === 1234 && dpl.properties.jobs === 60 && dpl.properties.spec === 'Tourist', 'district figures on the map', dpl?.properties);
  const f = built.districtField!;
  const cellAt = (x: number, z: number) => Math.floor((z + 8640) / f.cell) * f.n + Math.floor((x + 8640) / f.cell);
  ok(f.l1[cellAt(-4000, 0)] === 3 && f.l1[cellAt(4000, 0)] === 0, 'district area is the grid, not an estimate', [f.l1[cellAt(-4000, 0)], f.l1[cellAt(4000, 0)]]);
  const st = built.sources.places.features.filter((p) => p.properties.kind === 'busstop');
  ok(st.length >= 1, 'bus stops drawn', st.length);

  // mask-only water: wet cells are filled to sea level (at least 0.5 m)
  const m2 = baseModules(); delete m2['water-depth.bin']; m2['water.json'] = enc({ seaLevel: 60 });
  const c2 = vellumToCity(await readVellummap(await doc(m2)));
  ok(c2.water[1080] === 10 && c2.water[0] === 0 && c2.extras!.waterDepth === false, 'mask-only water filled to sea level', c2.water[1080]);
  // leniency: newer minor, unknown fields, unknown entries, missing optional modules
  const m3 = baseModules(); delete m3['districts.bin'];
  const r3 = JSON.parse(new TextDecoder().decode(m3['roads.json'])); r3.segments[0].lanes = 4; r3.futureThing = true; m3['roads.json'] = enc(r3);
  const c3 = vellumToCity(await readVellummap(await doc(m3, { version: '1.7', manifestExtra: { newField: 1 }, moduleVersion: { 'roads.json': '1.3' }, extraEntries: [{ name: 'future.json', data: enc({}) }] })));
  ok(c3.segs.length > 0 && !c3.extras!.districtGrid && c3.nodes.get(1)!.dist === 0, 'newer minor with unknown fields and entries opens');
  ok(isZip(await doc(baseModules())) && !isZip(new TextEncoder().encode('<CSLExportXML>')), 'zip sniffing');
}
// damaged and unsupported
{
  const m = baseModules();
  await rejects(readVellummap(new TextEncoder().encode('<?xml version="1.0"?><CSLExportXML>')), /not a city export/, 'XML is not a .vellummap');
  await rejects(readVellummap(await zip([{ name: 'hello.txt', data: enc('hi') }])), /not a city export/, 'zip without a manifest');
  await rejects(readVellummap(await zip([{ name: 'manifest.json', data: enc({ format: 'something-else' }) }])), /not a city export/, 'other zip formats');
  await rejects(readVellummap(await doc(m, { version: '2.0' })), /newer version of Vellum Bridge \(format 2\.0\)/, 'major 2 document');
  await rejects(readVellummap(await doc(m, { moduleVersion: { 'roads.json': '2.0' } })), /newer version/, 'major 2 module');
  await rejects(readVellummap(await doc(m, { drop: ['roads.json'] })), /module roads is missing/, 'missing required module');
  await rejects(readVellummap(await doc(m, { badHash: 'buildings.json' })), /buildings\.json: checksum mismatch/, 'sha256 mismatch');
  await rejects(readVellummap(await doc(m, { codec: { 'roads.json': 'stored' } })), /codec does not match/, 'codec mismatch');
  const small = { ...m, 'vegetation.bin': new Uint8Array(100) };
  await rejects(readVellummap(await doc(small)), /vegetation\.bin: wrong size/, 'grid of the wrong size');
  await rejects(readVellummap(await doc(m, { fakeSize: { 'roads.json': 300 * 1024 * 1024 } })), /roads\.json: wrong size/, 'JSON module above 256 MiB (declared)');
  await rejects(readVellummap(await doc(m, { fakeSize: { 'roads.json': 2000 * 1024 * 1024 } })), /more than 1 GiB/, 'document above 1 GiB (declared, before inflating)');
  const good = await doc(m);
  await rejects(readVellummap(good.slice(0, good.length - 40)), /damaged/, 'truncated file');
  const broken = good.slice(); broken.fill(0x41, 200, 4000);
  await rejects(readVellummap(broken), /damaged/, 'corrupted entry data');
  const badJson = { ...m, 'transit.json': new TextEncoder().encode('{"lines": [') };
  await rejects(readVellummap(await doc(badJson)).then(vellumToCity), /transit\.json is not valid JSON/, 'invalid JSON module');
  await rejects(readVellummap(await zip([{ name: 'manifest.json', data: enc({ format: 'vellummap', exportSchemaVersion: '1.0' }) }, { name: 'manifest.json', data: enc({}) }])), /two entries named/, 'duplicate entry names');
}
// pieces
{
  const g = new Map<number, { x: number; y: number; z: number }[]>([[1, [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }]], [2, [{ x: 100, y: 0, z: 0 }, { x: 200, y: 0, z: 0 }]], [3, [{ x: 200, y: 0, z: 0 }, { x: 300, y: 0, z: 0 }]], [4, [{ x: 300, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]]]);
  const legs = splitLegs([1, 2, 3, 4], [{ x: 10, y: 0, z: 5 }, { x: 150, y: 0, z: 5 }, { x: 290, y: 0, z: 5 }], (id) => g.get(id));
  ok(JSON.stringify(legs) === '[[1,2],[2,3],[3,4]]', 'legs cut at the segment each stop sits on', legs);
  ok(JSON.stringify(splitLegs([], [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], () => undefined)) === '[[],[]]', 'line without a computed route');
  ok(serviceOf('Metro Facility', 'PublicTransportMetro') === 'PublicTransport' && serviceOf('High Residential - Level3', 'ResidentialHigh') === 'Residential' && serviceOf('Mod Hospital Thing', 'None') === 'HealthCare' && serviceOf('', 'None') === '', 'services from item classes');
  const grid = new Uint8Array(A * A * 8); const c = (10 * A + 10) * 8; grid[c] = 5; grid[c + 1] = 6; grid[c + 4] = 40; grid[c + 5] = 200;
  ok(areaAt(grid, 10 * 19.2 - 8640 + 1, 10 * 19.2 - 8640 + 1) === 6 && areaAt(grid, 0, 0) === 0, 'strongest area of a grid cell');
}

// ------------------------------------------------------------ 2. reference converter output
{
  const bytes = new Uint8Array(readFileSync('tools/fixtures/minimal-valid.vellummap'));
  const city = vellumToCity(await readVellummap(bytes));
  ok(city.name && city.nodes.size > 0 && city.segs.length > 0, 'opens a reference-converter file', [city.name, city.nodes.size, city.segs.length]);
  const ids = await vellumIdentities(bytes);
  ok(ids.segs.length === city.segs.filter((s) => !s.path).length && Number.isFinite(ids.time), 'time-lapse identities', ids.segs.length);
}

// ------------------------------------------------------------ 3. parity with the sample city
{
  const cs = parseCity(gunzipSync(readFileSync('public/samples/seorang.cslmap.gz')).toString('utf8'));
  const raw = new Uint8Array(readFileSync('tools/fixtures/seorang.vellummap'));
  const mem0 = process.memoryUsage().rss;
  const t0 = performance.now();
  const doc0 = await readVellummap(raw);
  const t1 = performance.now();
  const vm = vellumToCity(doc0);
  const t2 = performance.now();
  console.log(`seorang.vellummap (${(raw.length / 1e6).toFixed(1)} MB): read ${Math.round(t1 - t0)} ms, mapped ${Math.round(t2 - t1)} ms, +${Math.round((process.memoryUsage().rss - mem0) / 1e6)} MB RSS`);

  const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);
  ok(same(cs.height, vm.height), 'terrain identical');
  ok(same(cs.water, vm.water), 'water identical');
  ok(same(cs.forest, vm.forest), 'vegetation identical');
  ok(cs.seaLevel === vm.seaLevel && cs.name === vm.name, 'city name and sea level');
  ok(Math.abs(Date.parse(vm.generated) - Date.parse(cs.generated + ' UTC')) < 1000, 'export time (converter assumes UTC)', [cs.generated, vm.generated]);
  ok(cs.nodes.size === vm.nodes.size && [...cs.nodes.values()].every((n) => { const m = vm.nodes.get(n.id); return m && m.x === n.x && m.z === n.z && m.ug === n.ug && m.elev === n.elev; }), 'nodes: ids, positions, underground, elevation');
  const og = [...cs.nodes.values()].filter((n) => n.og !== null); const ogSame = og.filter((n) => vm.nodes.get(n.id)!.og === n.og).length;
  ok(ogSame / og.length > 0.95, 'on-ground derived from elevation agrees', `${ogSame}/${og.length}`);
  console.log(`  on-ground flag derived: ${ogSame}/${og.length} agree with the export`);
  const csRoads = cs.segs.filter((s) => !s.path && !/^Landscaping/.test(s.icls) && !/ Line$/.test(s.icls)), vmRoads = new Map(vm.segs.filter((s) => !s.path).map((s) => [s.id, s]));
  ok(csRoads.every((s) => { const m = vmRoads.get(s.id); return m && m.sn === s.sn && m.en === s.en && m.icls === s.icls && m.pts.length === s.pts.length; }), 'road segments: ids, ends, item class, geometry (the converter drops landscaping and line pieces)');
  ok(cs.buildings.length === vm.buildings.length && cs.buildings.every((b, i) => vm.buildings[i].id === b.id && vm.buildings[i].name === b.name && vm.buildings[i].subsrv === b.subsrv && vm.buildings[i].pts.length === b.pts.length), 'buildings: ids, prefabs, sub-services, footprints');
  const srvSame = cs.buildings.filter((b, i) => vm.buildings[i].srv === b.srv).length;
  ok(srvSame / cs.buildings.length > 0.99, 'service derived from item class', `${srvSame}/${cs.buildings.length}`);
  ok(JSON.stringify(cs.districts) === JSON.stringify(vm.districts.map((d) => ({ ...d, type: undefined }))) || cs.districts.every((d, i) => vm.districts[i].id === d.id && vm.districts[i].name === d.name), 'districts');
  { const real = cs.parks.filter((p) => p.id); ok(real.length === vm.parks.length && real.every((p, i) => vm.parks[i].id === p.id && vm.parks[i].name === p.name && vm.parks[i].type === p.type), 'parks (the converter drops the id-0 placeholder)'); }
  ok(cs.transports.every((t, i) => { const v = vm.transports[i]; return v.id === t.id && v.name === t.name && v.type === t.type && v.stops.join() === t.stops.join() && v.color.join() === t.color.join(); }), 'transit lines: ids, names, modes, colours, stops');
  // legs: rebuilt from each line's whole route
  const norm = (p: number[]) => p.filter((x, i) => x && x !== p[i - 1]).join();
  const want = new Map<string, string[]>();
  for (const s of cs.segs) if (s.path) (want.get(s.sn + ',' + s.en) ?? want.set(s.sn + ',' + s.en, []).get(s.sn + ',' + s.en)!).push(norm(s.path));
  const got = vm.segs.filter((s) => s.path && want.has(s.sn + ',' + s.en));
  const exact = got.filter((s) => want.get(s.sn + ',' + s.en)!.includes(norm(s.path!))).length;
  ok(exact / got.length > 0.93, 'transit legs recovered from routes', `${exact}/${got.length}`);
  console.log(`  transit legs exactly recovered: ${exact}/${got.length}`);

  // time-lapse: an older export as .vellummap lowers the same identities a .cslmap of it would (ids, ends, prefabs, line types)
  const keys = cityKeys(cs, Date.parse('2030-01-01T00:00:00Z'));
  const idn = await vellumIdentities(raw);
  scanIdentities(idn, keys);
  const lowered = (m: Map<string, number>) => [...m.values()].filter((v) => v < Date.parse('2030-01-01T00:00:00Z')).length;
  const roadSegs = cs.segs.filter((s) => !s.path && !/^Landscaping/.test(s.icls) && !/ Line$/.test(s.icls)).length;
  ok(lowered(keys.blds) === cs.buildings.length && lowered(keys.lines) === cs.transports.length && lowered(keys.segs) >= roadSegs, 'time-lapse: .vellummap identities match the .cslmap city', [lowered(keys.blds), lowered(keys.lines), lowered(keys.segs), roadSegs]);

  // the drawn map
  const b1 = buildCity(cs, () => {}, inferOneWay(cs), detectTolls(cs));
  const t3 = performance.now();
  const b2 = buildCity(vm, () => {}, inferOneWay(vm), detectTolls(vm));
  console.log(`  buildCity: ${Math.round(performance.now() - t3)} ms`);
  const n = (b: typeof b1, k: string) => b.sources[k].features.length;
  for (const k of ['lots', 'buildings', 'rails']) { const a = n(b1, k), c = n(b2, k); ok(Math.abs(a - c) / a < 0.04, `${k} within 4%`, [a, c]); console.log(`  ${k}: ${a} → ${c}`); }
  ok(n(b1, 'transit') === n(b2, 'transit'), 'transit line geometry: same pieces', [n(b1, 'transit'), n(b2, 'transit')]);
  ok(b1.meta.lines.length === b2.meta.lines.length && b1.meta.stats.stations === b2.meta.stats.stations && b1.meta.stats.busStops === b2.meta.stats.busStops, 'lines, stations, bus stops', [b1.meta.stats.stations, b2.meta.stats.stations]);
  const roads1 = b1.sources.roads.features.filter((f) => f.properties.cls !== 'canal').length, roads2 = n(b2, 'roads');
  ok(Math.abs(roads1 - roads2) / roads1 < 0.03, 'roads within 3%', [roads1, roads2]); console.log(`  roads: ${roads1} → ${roads2}`);
  // drawn road classes: from the item class and width instead of prefab and lanes
  const cls2 = new Map(b2.sources.roads.features.map((f) => [f.properties.id, f.properties.cls]));
  const both = b1.sources.roads.features.filter((f) => cls2.has(f.properties.id));
  const sameCls = both.filter((f) => cls2.get(f.properties.id) === f.properties.cls).length;
  console.log(`  road classes: ${sameCls}/${both.length} the same`);
  ok(sameCls / both.length > 0.8, 'road classes mostly the same', `${sameCls}/${both.length}`);
  for (const c of ['motorway', 'motorway_link', 'runway', 'taxiway']) {
    const want = both.filter((f) => f.properties.cls === c), hit = want.filter((f) => cls2.get(f.properties.id) === c).length;
    ok(hit / want.length > 0.85, `${c} kept (width tells the variants apart)`, `${hit}/${want.length}`);
  }
  const br = (b: typeof b1, v: string) => b.sources.roads.features.filter((f) => f.properties.brunnel === v).length;
  console.log(`  bridges ${br(b1, 'bridge')} → ${br(b2, 'bridge')}, tunnels ${br(b1, 'tunnel')} → ${br(b2, 'tunnel')}`);
  // without prefab names a low bridge (named "Bridge"/"Elevated" only) looks like a road: bridges are missed, not invented
  const kind = (b: typeof b1) => new Map(b.sources.roads.features.map((f) => [f.properties.id, f.properties.brunnel]));
  const k1 = kind(b1), k2 = kind(b2);
  for (const v of ['bridge', 'tunnel']) {
    const truth = [...k1].filter(([, x]) => x === v).length, found = [...k2].filter(([id, x]) => x === v && k1.get(id) === v).length, wrong = [...k2].filter(([id, x]) => x === v && k1.has(id) && k1.get(id) !== v).length;
    console.log(`  ${v}s: ${found}/${truth} found, ${wrong} wrong`);
    ok(found / truth > (v === 'bridge' ? 0.65 : 0.85) && wrong / Math.max(1, found) < 0.05, `${v}s: most found, almost none invented`, [found, truth, wrong]);
  }
  ok(b2.sources.roads.features.every((f) => !f.properties.lanes && !f.properties.speed && !f.properties.oneway), 'no lanes, speeds or one-ways invented');
  ok(b2.meta.source?.lanes === false && !b1.meta.source, 'only the .vellummap map is marked as unable to route');
  // discoveries: road totals from the drawn classes; records that need lanes or building parts are left out, not guessed
  const d1 = discover(cs, b1), d2 = discover(vm, b2);
  ok(Math.abs(d1.summary.roadKm - d2.summary.roadKm) / d1.summary.roadKm < 0.05, 'discoveries: road length', [d1.summary.roadKm, d2.summary.roadKm]);
  const ids2 = d2.items.map((i) => i.id);
  ok(!ids2.includes('footprint') && !ids2.includes('parts') && !ids2.includes('wide'), 'discoveries: no footprint, parts or widest-road records without the data', ids2);
  ok(d2.items.every((i) => d1.items.some((j) => j.id === i.id)), 'discoveries: nothing the .cslmap does not have');
  console.log(`  discoveries: ${d1.items.length} → ${d2.items.length}`);
}

if (failed) { console.error(`\n${failed} .vellummap checks failed`); process.exit(1); }
console.log('\n.vellummap checks passed');
