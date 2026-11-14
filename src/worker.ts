import { parseCity } from './parse';
import { buildCity, buildContours } from './build';
import { Router } from './router';
import { inferOneWay } from './oneway';
import { detectTolls } from './tolls';
import { setLang } from './i18n';
import { bestSchematic } from './schematic-render';
import type { SchemInput } from './schematic';
import { reachGrid } from './reach';
import { discover } from './discover';
import { createClosures, segInfoFrom } from './closure';
import { cityKeys, scanExport, scanIdentities, bornById, exportTime, type HistoryKeys } from './history';
import type { CityData } from './parse';
import type { LaneCatalog } from './lane-infer';
import { loadSim, transferables } from './sim';
import { readVellummap, vellumToCity, vellumIdentities, isZip, FormatError } from './vellummap';

let router: Router | null = null;
let closures: ReturnType<typeof createClosures> | null = null;
/** a map without lanes (.vellummap): what rebuilding the router needs when a save names the real prefabs (see 'sim') */
let vellumCtx: { cat: LaneCatalog; routingCopy: typeof import('./lane-infer')['routingCopy']; est: ReturnType<typeof import('./lane-infer')['routingCopy']>;
  stopNames: Map<number, string>; closable: Parameters<typeof segInfoFrom>[0]; savedRouter: boolean } | null = null;
/** the router and closure tools for a routing copy (estimated lanes, or the real prefabs of a matched save) */
function routeOn(rc: { city: CityData; oneway: ReturnType<typeof inferOneWay>; tolls: ReturnType<typeof detectTolls>; roads: Set<number> }, stopNames: Map<number, string>, closable: Parameters<typeof segInfoFrom>[0]) {
  router = new Router(rc.city, stopNames, rc.oneway, rc.tolls);
  closures = createClosures(rc.city, router, segInfoFrom(closable, rc.roads), stopNames);
}
let schemInput: SchemInput | null = null;
const schemCache = new Map<string, unknown>();

let lastHeight: { h: Float32Array; size: number } | null = null;
let lastCity: CityData | null = null;
let history: HistoryKeys | null = null;
/** bumped by every sim load and clear: an older load that finishes late must not apply its rules */
let simToken = 0;

/** the file's bytes, gunzipped when gzip (a .cslmap.gz, or any map kept in the browser's recent cities) */
async function gunzip(buf: ArrayBuffer): Promise<Uint8Array> {
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = await new Response(stream).arrayBuffer();
  }
  return new Uint8Array(buf);
}
/** open either format: a zip is a .vellummap, anything else is read as .cslmap XML */
async function readCity(buf: ArrayBuffer, p: (s: string) => void): Promise<CityData> {
  const bytes = await gunzip(buf);
  if (isZip(bytes)) { p('Reading nodes'); return vellumToCity(await readVellummap(bytes)); }
  return parseCity(new TextDecoder('utf-8').decode(bytes), p);
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  const progress = (step: string, pct: number) => self.postMessage({ type: 'progress', step, pct });
  try {
    if (msg.type === 'load') {
      progress('Decoding file', 4);
      // i18n-keys: progress steps, shown translated by the page
      const steps = ['Reading nodes', 'Reading segments', 'Reading buildings', 'Reading terrain', 'Classifying roads', 'Shaping buildings', 'Tracing transit lines', 'Tracing coastlines', 'Growing forests', 'Mapping built-up areas'];
      void ['Decoding file', 'Preparing directions', 'Finding discoveries', 'Rendering'];
      // end i18n-keys
      const p = (s: string) => progress(s, 8 + (steps.indexOf(s) + 1) * 8.5);
      const city = await readCity(msg.buffer, p);
      lastHeight = { h: city.height, size: city.terrainSize };
      lastCity = city; history = null; vellumCtx = null;
      const oneway = inferOneWay(city);
      const tolls = detectTolls(city);
      // a file without lanes (.vellummap) gets lanes estimated from each road's class and width (lane-infer.ts): the router
      // runs on that separate copy, and the map takes only each road's drawn class and width from it, so the map, records
      // and road panels keep showing what the file holds. If it fails (a stale page after a deploy, odd data) the map still
      // opens as before, with directions off.
      let est: Awaited<ReturnType<typeof import('./lane-infer')['routingCopy']>> | null = null;
      if (city.extras && !city.extras.caps.lanes) {
        try {
          const [{ routingCopy }, catMod] = await Promise.all([import('./lane-infer'), import('./lane-catalog.json')]);
          const cat = (catMod.default ?? catMod) as unknown as LaneCatalog;
          const e = routingCopy(city, cat);
          if (e.stats.known + e.stats.family > 0) { est = e; vellumCtx = { cat, routingCopy, est: e, stopNames: new Map(), closable: { sources: {} }, savedRouter: false }; }
        } catch (err) { console.warn('[atlas] estimated lanes failed; directions stay off', err); }
      }
      const drawAs = est ? new Map(est.city.segs.flatMap((s) => { const st = est!.city.segTypes.get(s.name); return st && !s.path ? [[s.id, st] as const] : []; })) : undefined;
      const built = buildCity(city, p, oneway, tolls, drawAs);
      progress('Finding discoveries', 92);
      // a record that throws must not stop the city from opening
      try { built.discoveries = discover(city, built); } catch (err) { console.warn('[atlas] discoveries failed', err); built.discoveries = null; }
      progress('Preparing directions', 94);
      const rCity = est?.city ?? city, rOneway = est?.oneway ?? oneway, rTolls = est?.tolls ?? tolls;
      if (est && built.meta.source) built.meta.source.approxRoutes = true;
      router = new Router(rCity, built.stopNames ?? new Map(), rOneway, rTolls);
      closures = createClosures(rCity, router, segInfoFrom(built, est?.roads), built.stopNames ?? new Map());
      if (vellumCtx) {
        // kept for rebuilding the router on a matched save: stop names and the closable roads and rails (not the whole map)
        vellumCtx.stopNames = built.stopNames ?? new Map();
        vellumCtx.closable = { sources: { roads: { features: built.sources.roads.features.map((f) => ({ properties: f.properties })) }, rails: { features: built.sources.rails.features.map((f) => ({ properties: f.properties })) } } };
      }
      delete built.stopNames;
      schemInput = built.schem ?? null; schemCache.clear();
      delete built.schem;
      progress('Rendering', 96);
      const df = built.districtField;
      self.postMessage({ type: 'city', city: built }, { transfer: [built.dem.surface.buffer, ...(df ? [df.l1.buffer, df.d1.buffer, df.l2.buffer, df.d2.buffer, df.land.buffer] : [])] });
    } else if (msg.type === 'route') {
      const routes = router ? router.route(msg.from, msg.to, msg.mode, { avoidTolls: !!msg.avoidTolls, rules: msg.rules }) : [];
      self.postMessage({ type: 'route', id: msg.id, mode: msg.mode, routes });
    } else if (msg.type === 'reach') {
      const grid = router ? reachGrid(router.nodePositions(), router.reachTimes(msg.from, msg.mode, msg.max), msg.max) : null;
      self.postMessage({ type: 'reach', id: msg.id, grid }, grid ? { transfer: [grid.t.buffer] } : {});
    } else if (msg.type === 'closure') {
      self.postMessage({ type: 'closure', id: msg.id, result: closures?.analyze(msg.pick) ?? null });
    } else if (msg.type === 'closureReach') {
      const r = router && closures?.reach(msg.pick, msg.from, msg.mode, msg.max);
      const before = r ? reachGrid(router!.nodePositions(), r.before, msg.max) : null, after = r ? reachGrid(router!.nodePositions(), r.after, msg.max) : null;
      self.postMessage({ type: 'closureReach', id: msg.id, before, after }, { transfer: [before?.t.buffer, after?.t.buffer].filter(Boolean) as ArrayBuffer[] });
    } else if (msg.type === 'historyStart' && lastCity) {
      history = cityKeys(lastCity, exportTime(lastCity.generated));
      self.postMessage({ type: 'historyStart', name: lastCity.name, time: exportTime(lastCity.generated) });
    } else if (msg.type === 'historyFile' && history) {
      const bytes = await gunzip(msg.buffer);
      const r = isZip(bytes) ? scanIdentities(await vellumIdentities(bytes), history) : scanExport(new TextDecoder('utf-8').decode(bytes), history);
      self.postMessage({ type: 'historyFile', id: msg.id, ...r });
    } else if (msg.type === 'historyDone' && history && lastCity) {
      const born = bornById(lastCity, history);
      history = null;
      self.postMessage({ type: 'history', ...born });
    } else if (msg.type === 'schematic') {
      // which modes exist, and the diagram for the requested ones (cached per mode set)
      const available = [...new Set((schemInput?.lines ?? []).map((l) => l.mode))];
      const modes = (msg.modes as string[]).filter((m) => available.includes(m)).sort();
      const k = modes.join(',');
      if (!schemCache.has(k)) schemCache.set(k, schemInput && modes.length ? bestSchematic(schemInput, modes) : null);
      self.postMessage({ type: 'schematic', id: msg.id, available, modes, layout: schemCache.get(k) });
    } else if (msg.type === 'sim') {
      // optional simulation data from a save; never touches the map built above
      // i18n-keys: sim progress steps, shown translated by the page
      void ['Reading save file', 'Checking it matches this map', 'Reading simulation data'];
      // end i18n-keys
      if (!lastCity) { self.postMessage({ type: 'sim', id: msg.id, result: { ok: false, code: 'corrupt', detail: 'no map open' } }); return; }
      router?.clearRules(); router?.clearTraffic();
      // a new save starts from the estimated lanes again (.vellummap), whatever an earlier save did
      if (vellumCtx?.savedRouter) { routeOn(vellumCtx.est, vellumCtx.stopNames, vellumCtx.closable); vellumCtx.savedRouter = false; }
      // parsing can await (gzip): remember what this load was for, so a stale one never applies its rules
      const token = ++simToken, forRouter = router, forCity = lastCity;
      const vc = vellumCtx;
      const result = await loadSim(msg.buffer, forCity, (step) => self.postMessage({ type: 'simProgress', id: msg.id, step }),
        vc ? (saved) => vc.routingCopy(forCity, vc.cat, saved) : undefined);
      // a matched save's traffic rules drive routing from now on (directions, reach, closures, transit times)
      if (result.ok) {
        const current = router && router === forRouter && lastCity === forCity && token === simToken;
        // .vellummap: the router moves onto the save's real prefabs (lanes, one-ways) before its rules apply
        if (current && vc && result.routing) { routeOn(result.routing, vc.stopNames, vc.closable); vc.savedRouter = true; }
        delete result.routing;
        if (current && result.rules) router!.applyRules(result.rules);
        // densities of matched segments, for traffic-aware routing (used only once the page switches it on)
        if (current && result.traffic) router!.applyTraffic(result.traffic.ids, result.traffic.pct);
        delete result.rules;
      }
      self.postMessage({ type: 'sim', id: msg.id, result }, { transfer: transferables(result) });
    } else if (msg.type === 'simClear') {
      simToken++;
      router?.clearRules(); router?.clearTraffic();
      // .vellummap: back to the estimated lanes
      if (vellumCtx?.savedRouter) { routeOn(vellumCtx.est, vellumCtx.stopNames, vellumCtx.closable); vellumCtx.savedRouter = false; }
    } else if (msg.type === 'traffic') {
      router?.setTraffic(!!msg.on);
    } else if (msg.type === 'lang') {
      setLang(msg.lang, false); // directions text is written in the UI language
    } else if (msg.type === 'contours' && lastHeight) {
      const fc = buildContours(lastHeight.h, lastHeight.size, msg.interval ?? 10, msg.major ?? 50);
      self.postMessage({ type: 'contours', fc });
    }
  } catch (err) {
    if (err instanceof FormatError) self.postMessage({ type: 'error', message: err.message, key: err.key, params: err.params });
    else self.postMessage({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};
