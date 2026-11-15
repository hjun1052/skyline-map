// .skysave: round trip, refusals (damaged, newer, oversized, out of range, another export), checks on every part, and
// on the local matched save (tools/fixtures/local, when present) that a .skysave gives exactly what the .crp gives.
//   npm run check:skysave
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { encodeSkysave, decodeSkysave, loadSkysave, makeSkysave, mapFingerprint, isSkysave, SKYSAVE_VERSION, type Skysave } from '../src/skysave';
import { IMM_RES, NAT_RES } from '../src/sim/grids';
import type { CityData } from '../src/parse';

let failures = 0;
const ok = (c: boolean, m: string) => { if (!c) { failures++; console.error('  ✗ ' + m); } };
const isTA = (x: unknown) => ArrayBuffer.isView(x) && !(x instanceof DataView);
function same(a: any, b: any): boolean {
  if (isTA(a) || isTA(b)) return isTA(a) && isTA(b) && a.constructor === b.constructor && a.length === b.length && a.every((v: number, i: number) => Object.is(v, b[i]));
  if (a instanceof Map || b instanceof Map) return a instanceof Map && b instanceof Map && a.size === b.size && [...a].every(([k, v]) => b.has(k) && same(v, b.get(k)));
  if (a instanceof Set || b instanceof Set) return a instanceof Set && b instanceof Set && a.size === b.size && [...a].every((v) => b.has(v));
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
  }
  return Object.is(a, b);
}

// a tiny map, and simulation data with every kind of value a real save produces
const city = {
  name: 'Testville', generated: '2026-11-16T10:00:00',
  nodes: new Map([[1, { id: 1, x: 0, z: 0 }], [2, { id: 2, x: 100, z: 5 }]]),
  segs: [{ id: 7, sn: 1, en: 2 }], buildings: [{ id: 3, name: 'House' }], transports: [{ id: 4 }],
} as unknown as CityData;
const sim = {
  save: { city: 'Testville', savedAt: '2026-11-16', gameDate: '2031-05-01', format: 121034 },
  v: { nodes: { exported: 2, verified: 2, changed: 0, replaced: 0, missing: 0, extraInSave: 0 }, segments: { exported: 1, verified: 1, changed: 0, replaced: 0, missing: 0 }, buildings: { exported: 1, verified: 1, changed: 0, replaced: 0, missing: 0 }, lines: { exported: 1, verified: 1, changed: 0, replaced: 0, missing: 0 }, verdict: 'match', reason: 'same', share: { nodes: 1, segments: 1, buildings: 1 }, saveOnlyShare: 0 },
  traffic: { ids: Uint16Array.from([7]), pct: Uint8Array.from([42]) },
  trafficDir: { ids: Int32Array.from([7]), f: Uint8Array.from([40]), b: Uint8Array.from([44]), evidence: Uint8Array.from([9]), queue: Uint8Array.from([1]), heading: Uint8Array.from([2]), trusted: Uint8Array.from([1]) },
  buildings: { ids: Uint16Array.from([3]), residents: Int32Array.from([4]), households: Int32Array.from([2]), homes: Int32Array.from([2]), workers: Int32Array.from([-1]), students: Int32Array.from([-1]), visitors: Int32Array.from([0]), level: Uint8Array.from([2]), happiness: Uint8Array.from([80]) },
  tmpe: { segs: [{ id: 7, kmh: [30, 50], typeDefault: null, parking: [true, false] }], modVersion: '11.9' },
  lines: [{ id: 4, residents: 120, tourists: 8, lastResidents: 100, lastTourists: 5, ageShares: [0.1, 0.2, 0.3, 0.3, 0.1], tripsSaved: 12 }],
  controls: [{ seg: 7, node: 2, kind: 'signal' }],
  city: { population: 1234, workers: 600, workplaces: 700 },
  grids: { landValue: new Uint16Array(IMM_RES * IMM_RES).fill(3), noise: new Uint16Array(IMM_RES * IMM_RES), crime: new Uint16Array(IMM_RES * IMM_RES), pollution: new Uint8Array(NAT_RES * NAT_RES).fill(1) },
  unavailable: [],
  rules: {
    oneway: new Map([[7, 1]]), speed: new Map([[7, [50, null]]]), carRestrict: new Map([[7, [false, true]]]), restrictFactor: null,
    uturnBan: [{ seg: 7, node: 2 }], turnBan: [{ from: 7, node: 2, to: 7 }], trackLimit: new Map([[7, new Map([['Car', 60]])]]),
    summary: { oneway: 1, speed: 1, carRestrict: 1, restrictBan: false, uturnBan: 1, turnBan: 1, track: 1, leftHand: false, tmpe: true },
  },
  rulesSummary: { oneway: 1, speed: 1, carRestrict: 1, restrictBan: false, uturnBan: 1, turnBan: 1, track: 1, leftHand: false, tmpe: true },
  savedLanes: { exact: 1, roads: 1, lenShare: 1 },
  roadFacts: new Map([[7, { prefab: 'Basic Road', lanes: 2, speed: 40, oneway: false, bike: false }]]),
  prefabs: new Map([[7, { name: 'Basic Road', lanes: 2 }]]),
};
const context = { format: 'skyline-atlas-context', schema: 1, city: 'Testville', updated: '2026-11-16T10:00:00Z', tollDefault: 3100 };

async function unit() {
  console.log('format');
  const fp = await mapFingerprint(city);
  const file: Skysave = { app: 'skyline-atlas', v: SKYSAVE_VERSION, created: '2026-11-16T10:00:00Z', map: { name: city.name, fingerprint: fp }, sim: sim as any, context };
  const bytes = await encodeSkysave(file);
  ok(isSkysave(bytes) && bytes[7] === SKYSAVE_VERSION, 'starts with SKYSAVE and its version');
  const d = await decodeSkysave(bytes);
  ok(d.ok && same(d.s, file), 'a .skysave decodes to exactly what was written (typed arrays, maps, nested maps, nulls)');
  const inf = await decodeSkysave(await encodeSkysave({ ...file, sim: { ...sim, rules: { ...sim.rules, restrictFactor: Infinity } } as any }));
  ok(inf.ok && (inf.s.sim as any).rules.restrictFactor === Infinity, 'non-finite numbers survive');

  console.log('refusals');
  const why = async (b: Uint8Array) => { const r = await decodeSkysave(b); return r.ok ? 'ok' : r.why; };
  ok((await why(new TextEncoder().encode('not a skysave at all'))) === 'bad', 'another file is not a .skysave');
  ok((await why(bytes.subarray(0, bytes.length - 40))) === 'bad', 'a cut-off file is refused');
  const flipped = bytes.slice(); flipped[bytes.length - 12] ^= 0xff;
  ok((await why(flipped)) === 'bad', 'a damaged file is refused (gzip checksum)');
  const newer = bytes.slice(); newer[7] = SKYSAVE_VERSION + 1;
  ok((await why(newer)) === 'newer', 'a file from a newer version says so');
  const raw = (header: unknown, bin = new Uint8Array(0)) => { const h = new TextEncoder().encode(JSON.stringify(header)), len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, h.length, true); const gz = gzipSync(Buffer.concat([len, h, bin])); const out = new Uint8Array(8 + gz.length); out.set([0x53, 0x4b, 0x59, 0x53, 0x41, 0x56, 0x45, 1]); out.set(gz, 8); return out; };
  const base = { app: 'skyline-atlas', v: 1, created: '', map: { name: 'x', fingerprint: fp } };
  ok((await why(raw({ ...base, sim: { traffic: { ids: { $t: 'u16', o: 0, n: 1000 } } } }, new Uint8Array(10)))) === 'bad', 'an array pointing past the data is refused');
  ok((await why(raw({ ...base, sim: { x: { $t: 'evil', o: 0, n: 1 } } }, new Uint8Array(10)))) === 'bad', 'an unknown array type is refused');
  ok((await why(raw({ ...base, app: 'other', sim: {} }))) === 'bad', 'a file from another app is refused');
  let deep: unknown = 1; for (let i = 0; i < 100; i++) deep = [deep];
  ok((await why(raw({ ...base, sim: { deep } }))) === 'bad', 'absurdly nested data is refused');
  const bomb = gzipSync(Buffer.alloc(80 * 1024 * 1024)); const bombFile = new Uint8Array(8 + bomb.length); bombFile.set([0x53, 0x4b, 0x59, 0x53, 0x41, 0x56, 0x45, 1]); bombFile.set(bomb, 8);
  ok((await why(bombFile)) === 'bad', `a small file that would unpack to 80 MB is refused (${(bombFile.length / 1024).toFixed(0)} KB)`);

  console.log('loading for a map');
  const step = () => {};
  const good = await loadSkysave(bytes, city, step);
  const { ms: _m, context: ctxBack, ...gotSim } = good as any;
  ok(good.ok && same({ ...gotSim, ok: undefined }, { ...sim }), 'loads every part unchanged for the export it was made from');
  ok(same(ctxBack, context), 'brings its fares and toll prices along');
  const other = { ...city, segs: [{ id: 7, sn: 2, en: 1 }] } as unknown as CityData;
  const mm = await loadSkysave(bytes, other, step);
  ok(!mm.ok && mm.code === 'skysave-mismatch', 'refused for another export of the map (a road joined differently)');
  ok(!(await loadSkysave(bytes, { ...city, generated: 'later' } as CityData, step)).ok, 'refused for a later export of the same map');
  // a part that doesn't check out is left out, like an unreadable part of a .crp; the rest still loads
  const broken = await loadSkysave(await encodeSkysave({ ...file, sim: { ...sim, traffic: { ids: Uint16Array.from([7, 8]), pct: Uint8Array.from([1]) }, controls: [{ seg: 7, node: 2, kind: 'banana' }], grids: { ...sim.grids, pollution: new Uint8Array(5) } } as any }), city, step) as any;
  ok(broken.ok && broken.traffic === null && broken.controls === null && broken.grids === null && broken.buildings !== null, 'malformed parts are dropped, the rest loads');
  ok(broken.unavailable.includes('controls') && broken.unavailable.includes('grids'), 'dropped parts are reported as unavailable');
  const badHeader = await loadSkysave(await encodeSkysave({ ...file, sim: { ...sim, v: { verdict: 'incompatible' } } as any }), city, step);
  ok(!badHeader.ok && badHeader.code === 'skysave-bad', 'a file without a usable match summary is refused');
  const xss = await loadSkysave(await encodeSkysave({ ...file, sim: { ...sim, roadFacts: new Map([[7, { prefab: 'x'.repeat(5000) }]]) } as any }), city, step) as any;
  ok(xss.ok && xss.roadFacts === null, 'oversized strings are dropped');
  let rebuilt: unknown = null;
  const vel = await loadSkysave(bytes, city, step, (saved) => { rebuilt = saved; return { city } as any; }) as any;
  ok(vel.ok && same(rebuilt, sim.prefabs) && vel.routing, 'on a .vellummap the routing copy is rebuilt from the saved prefabs');
}

/** the local matched save: a .skysave of it loads exactly what the .crp loads */
async function real() {
  const L = 'tools/fixtures/local/';
  if (!existsSync(L + 'match.cslmap') || !existsSync(L + 'match.crp')) { console.log('\nno matched .cslmap + save in tools/fixtures/local: real-save checks skipped'); return; }
  const { parseCity } = await import('../src/parse');
  const { loadSim } = await import('../src/sim');
  console.log(`\n${L}match.cslmap + match.crp`);
  const c = parseCity(readFileSync(L + 'match.cslmap', 'utf8'));
  const crp = readFileSync(L + 'match.crp');
  const t0 = performance.now();
  const s: any = await loadSim(crp.buffer.slice(crp.byteOffset, crp.byteOffset + crp.byteLength) as ArrayBuffer, c, () => {});
  const tCrp = performance.now() - t0;
  ok(s.ok, 'the save loads');
  if (!s.ok) return;
  const file = await makeSkysave(s, c, context);
  const t1 = performance.now();
  const back: any = await loadSkysave(file, c, () => {});
  const tSky = performance.now() - t1;
  console.log(`  .crp ${(crp.length / 1e6).toFixed(1)} MB (${(gzipSync(crp).length / 1e6).toFixed(1)} MB gzipped), loads in ${(tCrp / 1000).toFixed(1)} s; .skysave ${(file.length / 1e3).toFixed(0)} KB, loads in ${(tSky / 1000).toFixed(2)} s`);
  ok(file.length < 1e6, `a .skysave of the real save is under 1 MB (${(file.length / 1e3).toFixed(0)} KB)`);
  for (const k of Object.keys(s)) {
    if (['ms', 'routing', 'ok'].includes(k)) continue;
    ok(same(back[k] ?? null, s[k] ?? null), `real save: "${k}" is identical from the .skysave`);
  }
  ok(back.ok && same(back.context, context), 'real save: fares and tolls come along');
}

await unit();
await real();
if (failures) { console.error(`\n${failures} .skysave check(s) failed`); process.exit(1); }
console.log('\n.skysave checks passed');
