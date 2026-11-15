// Send to Phone, the page side: the desktop's "Send to phone" dialog (QR code, options, progress) and the phone's
// receive screen. The transfer itself is protocol.ts; the relay is worker/index.ts. Nothing here touches the map
// readers: the phone opens the very bytes the desktop opened, through the same path as a recent city.
import { renderSVG } from 'uqr';
import { t } from '../i18n';
import { LIMITS, Sender, Receiver, newDeviceKeys, type DeviceKeys, newKeyText, importKey, pairingUrl, parsePairing, ROOM_RE, TICKET_RE, pairingCode, type Manifest, type AbortReason, type Wire } from './protocol';
import type { Recent } from '../recent';
import type { CityContext } from '../context';


const fmtMB = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const relayUrl = (room: string, ticket: string, role: 'send' | 'recv') => `${location.origin.replace(/^http/, 'ws')}/relay/${room}?role=${role}&t=${encodeURIComponent(ticket)}`;
/** maps above this many bytes get a memory warning on the phone (the map is decompressed and parsed in memory) */
const LARGE = 40 * 1024 * 1024;

type Control = { t: 'joined'; peer: boolean; opened: number; pairMs: number; maxMs: number } | { t: 'peer'; on: boolean } | { t: 'error'; code: string };

/**
 * A relay connection that comes back after drops (backoff 1-8 s) until the room expires or the transfer ends. Binary
 * messages go to `onData`; the relay's own JSON messages to `onControl`.
 */
class Link {
  private ws: WebSocket | null = null;
  private tries = 0;
  private timer = 0;
  closed = false;
  constructor(private room: string, private ticket: string, private role: 'send' | 'recv', private on: { open: (w: Wire) => void; data: (b: Uint8Array) => void; control: (c: Control) => void; lost: () => void; unreachable: () => void }) {}
  connect() {
    if (this.closed) return;
    const ws = new WebSocket(relayUrl(this.room, this.ticket, this.role));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let opened = false;
    ws.onopen = () => { opened = true; this.tries = 0; this.on.open({ send: (b) => { if (ws.readyState === 1) ws.send(b as Uint8Array<ArrayBuffer>); } }); };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') { try { this.on.control(JSON.parse(e.data)); } catch { /* ignore */ } }
      else this.on.data(new Uint8Array(e.data as ArrayBuffer));
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed || e.code >= 4400) return; // the room said why (expired, replaced, limits) in a control message
      if (!opened && this.tries >= 3) { this.closed = true; this.on.unreachable(); return; }
      this.on.lost();
      this.timer = window.setTimeout(() => this.connect(), Math.min(8000, 1000 * 2 ** this.tries++));
    };
  }
  /** after the phone wakes up or the tab comes back: reconnect now rather than at the next backoff */
  nudge() { if (!this.closed && !this.ws) { clearTimeout(this.timer); this.connect(); } }
  close() { this.closed = true; clearTimeout(this.timer); try { this.ws?.close(1000); } catch { /* ignore */ } this.ws = null; }
}

export interface SendDeps {
  /** the remembered entry of the open map (its gzipped file and save), or null when it didn't come from a file */
  current: () => Promise<Recent | null>;
  /** fares and toll prices of the open city, if the user set any */
  settings: () => Promise<CityContext | null>;
  /** the loaded save as a .skysave (a fraction of the size of the .crp), or null when no save is loaded */
  skysave?: () => Promise<{ file: string; blob: Blob } | null>;
}

/** the desktop dialog */
export function openSendDialog(deps: SendDeps) {
  const dlg = document.createElement('dialog');
  dlg.className = 'card send-phone';
  dlg.setAttribute('aria-labelledby', 'spTitle');
  document.body.appendChild(dlg);
  let link: Link | null = null, sender: Sender | null = null, tick = 0;
  const close = () => {
    clearInterval(tick); dlg.close(); dlg.remove();
    // tell the phone first (it would otherwise wait until the room expires), then hang up
    const told = sender?.cancel() ?? Promise.resolve(), l = link;
    void Promise.race([told, new Promise((r) => setTimeout(r, 1000))]).then(() => setTimeout(() => l?.close(), 200));
  };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('[data-sp-close]')) close(); });
  const shell = (body: string) => {
    dlg.innerHTML = `<h2 id="spTitle">${esc(t('Send to phone'))}</h2>${body}<div class="sp-actions"><button type="button" class="pill" data-sp-close>${esc(t('Close'))}</button></div>`;
  };
  dlg.showModal();
  void (async () => {
    const rec = await deps.current();
    if (!rec) { shell(`<p>${esc(t('Send to phone needs a map opened from a file. Open the map file first.'))}</p>`); return; }
    // the relay issues the room and a signed ticket for it; without one nothing can connect
    let room: string, ticket: string, phoneTicket: string;
    try {
      const r = await fetch('/relay/new', { method: 'POST', cache: 'no-store' });
      if (!r.ok) { shell(`<p>${esc(r.status === 429 ? t('Too many attempts. Wait a minute and try again.') : r.status === 503 ? t('Send to phone isn\'t available right now.') : t('Couldn\'t reach the transfer service. Check your connection and try again.'))}</p>`); return; }
      // the desktop keeps its own ticket; only the phone's goes into the QR code
      ({ room, send: ticket, recv: phoneTicket } = await r.json());
      if (!ROOM_RE.test(room) || !TICKET_RE.test(ticket) || !TICKET_RE.test(phoneTicket)) throw new Error('bad ticket');
    } catch { shell(`<p>${esc(t('Couldn\'t reach the transfer service. Check your connection and try again.'))}</p>`); return; }
    if (!dlg.open) return; // closed while waiting
    const ctx = await deps.settings();
    // the save goes as a .skysave when one can be made (about 1% of the .crp), else as the .crp itself
    const sky = rec.save ? await deps.skysave?.().catch(() => null) ?? null : null;
    const save = sky ?? rec.save;
    const keyText = newKeyText();
    const key = await importKey(keyText);
    const url = pairingUrl(location.origin, room, keyText, phoneTicket);
    const mapSize = rec.map.size, saveSize = save?.blob.size ?? 0;
    const saveFits = !!save && mapSize + saveSize <= LIMITS.maxTotal;
    shell(`<p>${esc(t('Scan this code with your phone\'s camera to open this city there.'))}</p>
      <div class="sp-qr" data-link="${esc(url)}">${renderSVG(url, { ecc: 'M', border: 2, pixelSize: 6, whiteColor: '#ffffff', blackColor: '#000000' })}</div>
      <div class="sp-opts">
        ${save ? `<label><input type="checkbox" id="spSave" ${saveFits ? '' : 'disabled'}> ${esc(t('Include the save file ({size})', { size: fmtMB(saveSize) }))}</label>` : ''}
        ${ctx ? `<label><input type="checkbox" id="spCtx" checked> ${esc(t('Include fares and toll prices'))}</label>` : ''}
      </div>
      <p class="sp-status" role="status" aria-live="polite"></p>
      <div class="sp-confirm" hidden><p class="sp-code"></p><div class="sp-actions"><button type="button" class="pill" data-no>${esc(t('Cancel'))}</button><button type="button" class="pill primary" data-yes>${esc(t('Send'))}</button></div></div>
      <div class="sp-bar" hidden><i></i></div>`);
    const status = dlg.querySelector<HTMLElement>('.sp-status')!, bar = dlg.querySelector<HTMLElement>('.sp-bar')!;
    const say = (s: string) => { status.textContent = s; };
    let deadline = 0, phone = false;
    const countdown = () => {
      if (phone || !deadline) return;
      const left = Math.max(0, deadline - Date.now()), m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      say(t('Waiting for your phone… (link expires in {time})', { time: `${m}:${String(s).padStart(2, '0')}` }));
    };
    tick = window.setInterval(countdown, 1000);
    // a phone said hello: show its code and send only once the user confirms it is the phone in their hand
    const confirmBox = dlg.querySelector<HTMLElement>('.sp-confirm')!;
    const confirm = async (phonePub: string) => {
      confirmBox.querySelector('.sp-code')!.textContent = t('A phone is ready. Send only if it shows the code {code}.', { code: await pairingCode(phonePub) });
      confirmBox.hidden = false;
      confirmBox.querySelector<HTMLElement>('[data-yes]')!.focus();
      return new Promise<boolean>((res) => {
        confirmBox.onclick = (e) => {
          const b = (e.target as HTMLElement).closest('[data-yes],[data-no]');
          if (b) { confirmBox.hidden = true; confirmBox.onclick = null; res(b.hasAttribute('data-yes')); }
        };
      });
    };
    const lock = () => dlg.querySelectorAll<HTMLInputElement>('.sp-opts input').forEach((i) => (i.disabled = true));
    const finish = (msg: string) => { say(msg); clearInterval(tick); link?.close(); bar.hidden = true; confirmBox.hidden = true; dlg.querySelector('.sp-qr')?.classList.add('used'); };
    const abortText = (r: AbortReason) => r === 'cancelled' ? t('Your phone cancelled the transfer.') : r === 'too-large' ? t('The transfer was refused: the files are too large for a phone ({size} max).', { size: fmtMB(LIMITS.maxTotal) })
      : r === 'decrypt' || r === 'mismatch' || r === 'out-of-order' || r === 'bad-manifest' ? t('The transfer failed a security check and was stopped.') : r === 'storage' ? t('Your phone couldn\'t make room for this map.') : t('The transfer was interrupted and could not continue.');
    let wire: Wire | null = null;
    link = new Link(room, ticket, 'send', {
      open: (w) => { wire = w; sender?.attach(w); },
      data: (b) => void sender?.receive(b),
      control: (c) => {
        if (c.t === 'joined') { deadline = c.opened + c.pairMs; if (c.peer) phoneJoined(); else countdown(); }
        else if (c.t === 'peer') { if (c.on) phoneJoined(); else if (sender && !sender.done && !sender.stopped) { sender.pause(); say(t('The phone disconnected. Waiting for it to come back…')); } }
        else if (c.t === 'error') finish(c.code === 'busy' ? t('Send to phone has reached its limit for today. Please try again tomorrow.') : c.code === 'expired' ? t('This link has expired. Choose Send to phone again.') : c.code === 'limit' || c.code === 'too-big' ? abortText('too-large') : t('The transfer was interrupted and could not continue.'));
      },
      lost: () => { if (!sender?.done) say(t('Connection lost. Reconnecting…')); },
      unreachable: () => finish(t('Couldn\'t reach the transfer service. Check your connection and try again.')),
    });
    const phoneJoined = () => {
      phone = true;
      if (!sender) {
        // the options are read now and locked: the phone gets what was ticked when it joined
        lock();
        const withSave = !!dlg.querySelector<HTMLInputElement>('#spSave')?.checked && !!save;
        const withCtx = !!dlg.querySelector<HTMLInputElement>('#spCtx')?.checked && !!ctx;
        const manifest: Manifest = { v: 1, city: rec.name, files: [{ kind: 'map', name: rec.file, size: mapSize }, ...(withSave ? [{ kind: 'save' as const, name: save!.file, size: saveSize }] : [])], ...(withCtx ? { settings: ctx } : {}) };
        sender = new Sender(key, manifest, [rec.map, ...(withSave ? [save!.blob] : [])], {
          progress: (sent, total) => { bar.hidden = false; (bar.firstElementChild as HTMLElement).style.width = `${(100 * sent) / total}%`; say(t('Sending… {pct}%', { pct: Math.floor((100 * sent) / total) })); },
          done: () => finish(t('Sent. The map is opening on your phone.')),
          abort: (r) => finish(abortText(r)),
          confirm,
          declined: (another) => finish(another ? t('Another device opened this link, so the transfer was stopped. Choose Send to phone again.') : t('Not sent. Choose Send to phone again for a new code.')),
        });
        sender.attach(wire);
      }
      say(t('Phone connected'));
    };
    link.connect();
    countdown();
  })();
}

/**
 * A phone can open one pairing link twice (iOS sometimes opens a scanned link in two tabs, or the code is scanned
 * again). Every tab of this browser then uses the same key pair for that room, kept in IndexedDB (non-extractable)
 * until the room's ticket expires, so the desktop sees one phone that reconnected (and resumes) rather than another
 * device (which would end the transfer). Without IndexedDB each tab makes its own keys, as before.
 */
async function roomKeys(room: string, until: number): Promise<DeviceKeys> {
  const mine = await newDeviceKeys();
  try {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('skyline-send-to-phone', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('keys', { keyPath: 'room' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    // one transaction: two tabs racing here end up with the same keys (whichever stored first)
    const got = await new Promise<DeviceKeys>((res, rej) => {
      const tx = db.transaction('keys', 'readwrite'), store = tx.objectStore('keys');
      let out: DeviceKeys = mine;
      const all = store.getAll();
      all.onsuccess = () => {
        const now = Date.now();
        for (const e of all.result as { room: string; until: number }[]) if (e.until <= now) store.delete(e.room); // stale rooms
        const e = (all.result as ({ room: string; until: number } & DeviceKeys)[]).find((x) => x.room === room && x.until > now);
        if (e) out = { pair: e.pair, pub: e.pub }; else store.put({ room, until, pair: mine.pair, pub: mine.pub });
      };
      tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error);
    });
    db.close();
    return got;
  } catch { return mine; }
}
/** which tab of this browser last started receiving a room (so a tab replaced by its sibling can say so) */
const tabId = Math.random().toString(36).slice(2);
const ownerKey = (room: string) => 'skyline-phone-tab:' + room;
const claim = (room: string) => { try { localStorage.setItem(ownerKey(room), tabId); } catch { /* storage off */ } };
const ownedElsewhere = (room: string) => { try { const o = localStorage.getItem(ownerKey(room)); return !!o && o !== tabId; } catch { return false; } };
const release = (room: string) => { try { if (localStorage.getItem(ownerKey(room)) === tabId) localStorage.removeItem(ownerKey(room)); } catch { /* storage off */ } };

export interface ReceiveDeps {
  /** open the received map (and save) the way a recent city opens */
  open: (map: Blob, file: string, save?: { file: string; blob: Blob }) => Promise<void>;
  /** keep the fares and toll prices that came with it, unless this phone has newer ones for that city */
  settings: (ctx: CityContext) => Promise<void>;
}

/** the phone side: when the page was opened from a pairing QR code (`hash`, read before anything rewrote the URL; the
 *  caller has already taken it out of the address bar and history), receive and open the city. Returns false when it
 *  isn't a pairing link. */
export function receiveFromHash(hash: string, deps: ReceiveDeps): boolean {
  const pair = parsePairing(hash);
  if (!pair) return false;
  const box = document.createElement('div');
  box.id = 'receivePhone';
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'rpTitle');
  box.innerHTML = `<div class="card rp-card"><h2 id="rpTitle">${esc(t('Receiving a city from your computer'))}</h2>
    <p class="rp-code"></p><p class="rp-status" role="status" aria-live="polite">${esc(t('Waiting for your computer…'))}</p>
    <div class="sp-bar" hidden><i></i></div><p class="rp-note">${esc(t('Keep this screen open until it finishes.'))}</p>
    <p class="rp-warn" hidden></p><div class="sp-actions"></div></div>`;
  document.body.appendChild(box);
  const status = box.querySelector<HTMLElement>('.rp-status')!, bar = box.querySelector<HTMLElement>('.sp-bar')!, actions = box.querySelector<HTMLElement>('.sp-actions')!, warn = box.querySelector<HTMLElement>('.rp-warn')!;
  const say = (s: string) => { status.textContent = s; };
  let wake: { release(): Promise<void> } | null = null;
  const keepAwake = async () => { try { wake = await (navigator as any).wakeLock?.request('screen'); } catch { /* not allowed: the note asks to keep it open */ } };
  const letSleep = () => { void wake?.release().catch(() => {}); wake = null; };
  const end = (msg: string, buttons: { label: string; act: () => void }[] = [{ label: t('Close'), act: () => box.remove() }]) => {
    say(msg); bar.hidden = true; link.close(); letSleep(); document.removeEventListener('visibilitychange', onVisible);
    box.querySelector('.rp-note')?.remove();
    actions.innerHTML = buttons.map((b, i) => `<button type="button" class="pill${i === 0 ? ' primary' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('');
    actions.onclick = (e) => { const i = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')?.dataset.i; if (i !== undefined) buttons[+i].act(); };
  };
  let receiver: Receiver | null = null, wire: Wire | null = null, peer = false, name = '';
  // until the desktop confirms this phone's code nothing arrives: say what to do
  const greet = () => { void receiver?.attach(wire); if (receiver && !receiver.manifest) say(t('Confirm the code on your computer to start.')); };
  const link: Link = new Link(pair.room, pair.ticket, 'recv', {
    open: (w) => { wire = w; },
    data: (b) => void receiver?.receive(b),
    control: (c) => {
      if (c.t === 'joined') { peer = c.peer; if (peer) greet(); }
      else if (c.t === 'peer') { peer = c.on; if (c.on) greet(); else if (!receiver?.done) say(t('Waiting for your computer…')); }
      else if (c.t === 'error') end(c.code === 'busy' ? t('Send to phone has reached its limit for today. Please try again tomorrow.') : c.code === 'replaced' ? (ownedElsewhere(pair.room) ? t('This city is being received in another tab. You can close this one.') : t('This link was opened on another device.')) : t('This link has expired or was already used. On your computer, choose Send to phone again.'));
    },
    lost: () => { if (!receiver?.done) say(t('Connection lost. Reconnecting…')); },
    unreachable: () => end(t('Couldn\'t reach the transfer service. Check your connection and try again.')),
  });
  void (async () => {
    let key: CryptoKey;
    try { key = await importKey(pair.key); } catch { end(t('This link has expired or was already used. On your computer, choose Send to phone again.')); return; }
    claim(pair.room);
    const keys = await roomKeys(pair.room, Number(pair.ticket.split('.')[0]) * 1000);
    box.querySelector('.rp-code')!.textContent = t('Your computer will ask you to confirm this code: {code}', { code: await pairingCode(keys.pub) });
    receiver = new Receiver(key, keys, {
      manifest: (m) => {
        name = m.city;
        const map = m.files.find((f) => f.kind === 'map')!;
        if (map.size > LARGE) { warn.hidden = false; warn.textContent = t('This is a large map ({size}). It may not open on phones with little memory.', { size: fmtMB(map.size) }); }
        return null;
      },
      progress: (got, total) => { bar.hidden = false; (bar.firstElementChild as HTMLElement).style.width = `${(100 * got) / total}%`; say(t('Receiving {name}… {pct}%', { name, pct: Math.floor((100 * got) / total) })); },
      done: (files, m) => void finished(files, m),
      abort: (r, byPeer) => end(byPeer && r === 'cancelled' ? t('The transfer was cancelled on your computer.') : r === 'decrypt' || r === 'mismatch' || r === 'out-of-order' || r === 'bad-manifest' ? t('The transfer failed a security check and was stopped.') : r === 'too-large' ? t('The transfer was refused: the files are too large for a phone ({size} max).', { size: fmtMB(LIMITS.maxTotal) }) : t('The transfer was interrupted and could not continue.')),
    });
    await keepAwake();
    link.connect();
  })();
  // a phone that locked or switched apps drops the socket: come back as soon as the page is visible again
  const onVisible = () => { if (document.visibilityState === 'visible') { link.nudge(); if (!wake && receiver && !receiver.done) void keepAwake(); } };
  document.addEventListener('visibilitychange', onVisible);
  const finished = async (files: { file: { kind: string; name: string }; blob: Blob }[], m: Manifest) => {
    release(pair.room);
    // the desktop has its Done: hang up and let the screen sleep again
    document.removeEventListener('visibilitychange', onVisible); link.close(); letSleep();
    const map = files.find((f) => f.file.kind === 'map')!, save = files.find((f) => f.file.kind === 'save');
    const saveFile = () => { for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f.blob); a.download = f.file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60_000); } };
    if (m.settings && typeof m.settings === 'object') { try { await deps.settings(m.settings as CityContext); } catch { /* settings are a nicety */ } }
    const openIt = async () => { box.remove(); await deps.open(map.blob, map.file.name, save ? { file: save.file.name, blob: save.blob } : undefined); };
    // a large map is decompressed and parsed in memory: let the user keep the file instead of risking the tab
    if (map.blob.size > LARGE) end(t('This is a large map ({size}). It may not open on phones with little memory.', { size: fmtMB(map.blob.size) }), [{ label: t('Open map'), act: () => void openIt() }, { label: t('Save the file instead'), act: saveFile }]);
    else { say(t('Received. Opening the map…')); await openIt(); }
  };
  return true;
}
