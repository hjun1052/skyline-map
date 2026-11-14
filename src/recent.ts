// Recent cities: the last few maps opened from a file, kept in this browser (IndexedDB) so they reopen in one
// click. A save loaded over a map is kept with it and reloads too. Files are stored gzip-compressed; the worker
// reads gzip either way. Nothing leaves the browser.
//
// One entry per city and file format: a newer export of the same city in the same format replaces the older one (and
// keeps its save only when it is the very same export), while a .cslmap and a .vellummap of one city are separate.

export type MapFormat = 'cslmap' | 'vellummap';

export interface Recent {
  id: string; // `${format}:${name}`, see recentId
  format: MapFormat;
  name: string; // city name from the export
  file: string; // file name as opened
  generated: string; // export time, from the file
  opened: number; // ms, last opened here
  map: Blob;
  save?: { file: string; blob: Blob };
}

/** the entry a map belongs to */
export const recentId = (format: MapFormat, name: string) => `${format}:${name}`;

// v1 kept one entry per city name (store 'cities', keyed by name); v2 keys them by format and name (store 'maps')
const DB = 'skyline-atlas-cities', STORE = 'maps', OLD_STORE = 'cities', KEEP = 5;

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      const d = r.result, tx = r.transaction!;
      const store = d.objectStoreNames.contains(STORE) ? tx.objectStore(STORE) : d.createObjectStore(STORE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(OLD_STORE)) return;
      // move v1 entries over, save included. The upgrade can't read the stored file (that would end it), so the format
      // comes from the file name it was opened as; anything not named .vellummap was a .cslmap
      const old = tx.objectStore(OLD_STORE).openCursor();
      old.onsuccess = () => {
        const c = old.result;
        if (!c) { d.deleteObjectStore(OLD_STORE); return; }
        const v = c.value as Omit<Recent, 'id' | 'format'>;
        const format: MapFormat = /\.vellummap(\.gz)?$/i.test(v.file ?? '') ? 'vellummap' : 'cslmap';
        store.put({ ...v, format, id: recentId(format, v.name) });
        c.continue();
      };
    };
    // a later version opened in another tab can upgrade: let go of this connection instead of blocking it
    r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); res(r.result); }; r.onerror = () => rej(r.error);
  });
}
async function req<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => { const q = fn(d.transaction(STORE, mode).objectStore(STORE)); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}

async function gzipped(b: Blob): Promise<Blob> {
  const h = new Uint8Array(await b.slice(0, 2).arrayBuffer());
  if (h[0] === 0x1f && h[1] === 0x8b) return b;
  return new Response(b.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

/** writes run one after another: a save remembered while its map is still being gzipped and stored must land on that
 *  record, not be dropped (no record yet) or overwritten by the map's write */
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => { const p = queue.then(f, f); queue = p.catch(() => {}); return p; };

/** newest first, after any write still running (a save just loaded shows up); [] when storage is blocked */
export const listRecent = (): Promise<Recent[]> => serial(listNow);
async function listNow(): Promise<Recent[]> {
  try { return ((await req('readonly', (s) => s.getAll())) as Recent[]).sort((a, b) => b.opened - a.opened); }
  catch { return []; }
}

/** remember a map that just opened; keeps the stored save only if it is the same file being reopened */
export const rememberMap = (format: MapFormat, name: string, file: string, generated: string, map: Blob) => serial(() => rememberMapNow(format, name, file, generated, map));
async function rememberMapNow(format: MapFormat, name: string, file: string, generated: string, map: Blob): Promise<void> {
  try {
    const id = recentId(format, name);
    const old = (await req('readonly', (s) => s.get(id))) as Recent | undefined;
    const same = !!old && old.generated === generated;
    const rec: Recent = { id, format, name, file, generated, opened: Date.now(), map: same ? old!.map : await gzipped(map), save: same ? old!.save : undefined };
    await req('readwrite', (s) => s.put(rec));
    for (const r of (await listNow()).slice(KEEP)) await forgetNow(r.id);
  } catch { /* storage blocked or full: the city simply isn't remembered */ }
}

/** remember the save loaded over a remembered map (`id`: the map's entry, taken when the save was loaded) */
export const rememberSave = (id: string, file: string, save: Blob) => serial(() => rememberSaveNow(id, file, save));
async function rememberSaveNow(id: string, file: string, save: Blob): Promise<void> {
  try {
    const rec = (await req('readonly', (s) => s.get(id))) as Recent | undefined;
    if (!rec) return;
    rec.save = { file, blob: await gzipped(save) };
    await req('readwrite', (s) => s.put(rec));
  } catch { /* ignore */ }
}

export const forget = (id: string) => serial(() => forgetNow(id));
async function forgetNow(id: string): Promise<void> {
  try { await req('readwrite', (s) => s.delete(id)); } catch { /* ignore */ }
}
