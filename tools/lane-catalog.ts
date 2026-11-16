// Builds src/lane-catalog.json, the class + width → lanes table behind approximate .vellummap directions
// (src/lane-infer.ts), from real .cslmap exports: the newest export of each city in the CSLMapView folder, or the
// files given. Only network types and lane layouts go in (game data), never names, places or anything personal.
//   npx tsx tools/lane-catalog.ts [files...]
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import { parseCity } from '../src/parse';
import { buildCatalog } from '../src/lane-infer';

const dir = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
let files = process.argv.slice(2);
if (!files.length && existsSync(dir)) {
  const seen = new Set<string>();
  files = readdirSync(dir).filter((f) => /\.cslmap$/i.test(f)).sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)
    .filter((f) => { const c = f.normalize('NFC').replace(/-\d{8}-\d{6}\.cslmap$|\.cslmap$/i, ''); return !seen.has(c) && seen.add(c); }).map((f) => path.join(dir, f));
}
if (!files.length) files = ['public/samples/seorang.cslmap.gz'];
const cities = files.map((f) => { const b = readFileSync(f); return parseCity((f.endsWith('.gz') ? gunzipSync(b) : b).toString('utf8')); });
const cat = buildCatalog(cities);
const out = JSON.stringify(cat);
writeFileSync('src/lane-catalog.json', out + '\n');
console.log(`${files.length} cities → ${Object.keys(cat.keys).length} keys, ${Object.keys(cat.types).length} road types, ${(out.length / 1024).toFixed(0)} KB`);
