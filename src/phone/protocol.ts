// Send to Phone: the end-to-end encrypted transfer protocol between a desktop (sender) and a phone (receiver).
// Shared by the page and the tests; no DOM. See docs/send-to-phone-feasibility.md for the design and its reasons.
//
// Pairing: the relay hands the desktop a random room id (128 bits) and a signed, expiring ticket for each side; the
// desktop keeps its own ticket, makes a random AES-GCM key (256 bits) and shows the room, key and phone's ticket in a QR
// code as a URL fragment (`/#phone=<room>.<key>.<ticket>`). Browsers never send the fragment to a server, so the relay (worker/index.ts) only
// ever learns the room id and ticket; it forwards opaque binary messages between the two sockets of a room and never
// stores them. Each phone makes its own random id and shows a code derived from it; the desktop shows the code of the
// phone that said hello and sends nothing until the user confirms it, so a photographed QR code isn't enough to take
// the city. Once a phone is confirmed, any other device that opens the link ends the transfer.
//
// Every application message is encrypted: 12-byte random IV || AES-GCM(ciphertext + 16-byte tag). The direction is the
// additional authenticated data, so a message can't be reflected back to its sender. Inside, the first byte is the
// message type. Map bytes travel as DATA messages carrying their offset in one stream (the files of the manifest, back
// to back): the receiver only accepts the next expected offset, and END carries the total, so a tampered, reordered,
// replayed or truncated transfer is rejected instead of opening a corrupted map. After a dropped connection the
// receiver says where it got to and the sender carries on from there.

export const LIMITS = {
  /** largest transfer (map + save + settings) */
  maxTotal: 100 * 1024 * 1024,
  /** plaintext bytes per DATA message (a message is this plus 22 bytes) */
  chunk: 256 * 1024,
  /** chunks in flight before the sender waits for the receiver's acknowledgement */
  window: 8,
  /** the receiver acknowledges every this many chunks */
  ackEvery: 4,
  /** settings JSON in the manifest */
  maxSettings: 256 * 1024,
};

export const enum Dir { ToPhone = 1, ToDesktop = 2 }
export const enum T { Hello = 1, Manifest = 2, Data = 3, Ack = 4, End = 5, Done = 6, Abort = 7 }

export type FileKind = 'map' | 'save';
export interface ManifestFile { kind: FileKind; name: string; size: number }
export interface Manifest { v: 1; city: string; files: ManifestFile[]; settings?: unknown }
/** why a transfer stopped; shown to the user by the page */
export type AbortReason = 'too-large' | 'bad-manifest' | 'out-of-order' | 'decrypt' | 'storage' | 'cancelled' | 'mismatch';

// ------------------------------------------------------------------ ids and keys

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function b64url(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '') + (i + 2 < b.length ? B64[n & 63] : '');
  }
  return s;
}
export function unb64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => (i + k < s.length ? B64.indexOf(s[i + k]) : 0));
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    out[o++] = (n >> 16) & 255;
    if (i + 2 < s.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < s.length) out[o++] = n & 255;
  }
  return out;
}

/** a room id: 128 random bits, 22 characters */
export const ROOM_RE = /^[A-Za-z0-9_-]{22}$/;
export const newRoom = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
/** raw 256-bit key, 43 characters */
export const newKeyText = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

/** a phone's own id (random, per receive): 128 bits, 22 characters */
export const newPhoneId = newRoom;
/** the relay's ticket for a room: `<expiry, unix seconds>.<signature>` (checked by the relay, opaque here) */
export const TICKET_RE = /^\d{10}\.[A-Za-z0-9_-]{43}$/;

export function pairingUrl(origin: string, room: string, key: string, ticket: string) { return `${origin}/#phone=${room}.${key}.${ticket}`; }
/** room, key and ticket from a location hash, or null when it isn't a pairing link */
export function parsePairing(hash: string): { room: string; key: string; ticket: string } | null {
  const m = /^#phone=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})\.(\d{10}\.[A-Za-z0-9_-]{43})$/.exec(hash);
  return m ? { room: m[1], key: m[2], ticket: m[3] } : null;
}

export async function importKey(text: string): Promise<CryptoKey> {
  const raw = unb64url(text);
  if (!raw || raw.length !== 32) throw new Error('bad key');
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** four digits derived from a phone's id: the phone shows them, and the desktop asks the user to confirm them before
 *  sending, so it sends to the phone in the user's hand and not to someone else who scanned the same code */
export async function pairingCode(phoneId: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('skyline-pair:' + phoneId)));
  return String(((h[0] << 8) | h[1]) % 10000).padStart(4, '0');
}

// ------------------------------------------------------------------ encryption

export async function seal(key: CryptoKey, dir: Dir, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array([dir]) }, key, plain as BufferSource));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}
/** throws when the message was tampered with, sent the other way, or encrypted with another key */
export async function open(key: CryptoKey, dir: Dir, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < 12 + 16) throw new Error('short message');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12) as BufferSource, additionalData: new Uint8Array([dir]) }, key, sealed.subarray(12) as BufferSource));
}

// ------------------------------------------------------------------ messages

const enc = new TextEncoder(), dec = new TextDecoder();
const PHONE_RE = /^[A-Za-z0-9_-]{22}$/;
export function jsonMsg(t: T, body: unknown): Uint8Array {
  const j = enc.encode(JSON.stringify(body));
  const out = new Uint8Array(1 + j.length);
  out[0] = t; out.set(j, 1);
  return out;
}
export function dataMsg(offset: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + bytes.length);
  out[0] = T.Data;
  new DataView(out.buffer).setUint32(1, offset);
  out.set(bytes, 5);
  return out;
}
export function readMsg(m: Uint8Array): { t: T; json?: any; offset?: number; bytes?: Uint8Array } {
  if (!m.length) throw new Error('empty');
  const t = m[0] as T;
  if (t === T.Data) {
    if (m.length < 5) throw new Error('short data');
    return { t, offset: new DataView(m.buffer, m.byteOffset, m.byteLength).getUint32(1), bytes: m.subarray(5) };
  }
  return { t, json: JSON.parse(dec.decode(m.subarray(1))) };
}

/** a manifest the receiver accepts: sizes add up to at most the limit, names are plain, at most one map and one save */
export function validManifest(x: any): x is Manifest {
  if (!x || x.v !== 1 || typeof x.city !== 'string' || x.city.length > 200 || !Array.isArray(x.files) || !x.files.length || x.files.length > 2) return false;
  let total = 0;
  const kinds = new Set<string>();
  for (const f of x.files) {
    if (!f || (f.kind !== 'map' && f.kind !== 'save') || kinds.has(f.kind) || typeof f.name !== 'string' || !f.name || f.name.length > 260 || /[\\/\0]/.test(f.name)) return false;
    if (!Number.isSafeInteger(f.size) || f.size <= 0) return false;
    kinds.add(f.kind); total += f.size;
  }
  if (!kinds.has('map') || total > LIMITS.maxTotal) return false;
  if (x.settings !== undefined && enc.encode(JSON.stringify(x.settings)).length > LIMITS.maxSettings) return false;
  return true;
}
export const manifestTotal = (m: Manifest) => m.files.reduce((s, f) => s + f.size, 0);

// ------------------------------------------------------------------ the two ends

/** where encrypted messages go (a WebSocket, or a fake in tests) */
export interface Wire { send(bytes: Uint8Array): void }

/** the desktop end: once the user confirms the phone, sends the manifest, then the files as one stream of chunks, at
 *  most LIMITS.window ahead of the receiver's acknowledgements; carries on from where the receiver says it got to after
 *  a reconnect of the same phone. Any other phone after that ends the transfer. */
export class Sender {
  private wire: Wire | null = null;
  /** bumped on every (re)connect: anything queued for an older connection is dropped, not sent on the new one */
  private gen = 0;
  /** after a (re)connect nothing is sent until the receiver says where it got to */
  private waiting = true;
  private acked = 0;
  private sent = 0;
  private total: number;
  private pumping = false;
  private endSent = false;
  private inbox: Promise<void> = Promise.resolve();
  private outbox: Promise<void> = Promise.resolve();
  /** the id of the phone the user confirmed; data only goes to it */
  private phone = '';
  done = false;
  stopped: AbortReason | null = null;
  constructor(private key: CryptoKey, private manifest: Manifest, private blobs: Blob[], private on: {
    progress?: (sent: number, total: number) => void; done?: () => void; abort?: (r: AbortReason) => void;
    /** a phone said hello: may it have the city? (the page shows its code). Without this, every phone may. */
    confirm?: (phoneId: string) => Promise<boolean>;
    /** the transfer is over without being sent: the user said no (`another` false), or another device opened the link
     *  after the user had confirmed a phone (`another` true). That device has been told. */
    declined?: (another: boolean) => void;
  } = {}) {
    this.total = manifestTotal(manifest);
    if (blobs.length !== manifest.files.length || blobs.some((b, i) => b.size !== manifest.files[i].size)) throw new Error('blobs do not match the manifest');
  }
  /** a (re)connected wire; nothing is sent until the receiver says hello */
  attach(wire: Wire | null) { this.wire = wire; this.gen++; this.waiting = true; }
  /** the phone left (the relay said so): stop sending into the void until it says hello again */
  pause() { this.gen++; this.waiting = true; }
  /** messages are handled one at a time, in arrival order (decryption is asynchronous) */
  receive(sealed: Uint8Array): Promise<void> { return (this.inbox = this.inbox.then(() => this.handle(sealed))); }
  private async handle(sealed: Uint8Array) {
    if (this.done || this.stopped) return;
    let m;
    try { m = readMsg(await open(this.key, Dir.ToDesktop, sealed)); } catch { return; } // not from our phone: ignore
    if (m.t === T.Hello) {
      const id = typeof m.json?.id === 'string' && PHONE_RE.test(m.json.id) ? m.json.id : '';
      if (!id) return;
      if (this.phone && id !== this.phone) {
        // someone else opened the link (a photographed QR code?) after the user confirmed their phone: stop everything
        this.gen++; this.waiting = true;
        await this.cancel(); this.on.declined?.(true); return;
      }
      let fresh = false;
      if (!this.phone) {
        // a phone the user hasn't confirmed: send nothing (and drop anything queued) until they do
        this.gen++; this.waiting = true;
        const gen = this.gen;
        const yes = this.on.confirm ? await this.on.confirm(id).catch(() => false) : true;
        if (this.done || this.stopped) return;
        if (!yes) { await this.cancel(); this.on.declined?.(false); return; }
        this.phone = id; fresh = true;
        // the phone left while the user was deciding: its next hello carries on
        if (gen !== this.gen) return;
      }
      // a fresh receiver starts at 0; a reconnecting one says how far it got (never beyond what was sent)
      const from = !fresh && Number.isSafeInteger(m.json?.offset) ? Math.max(0, Math.min(m.json.offset, this.sent)) : 0;
      // anything still queued from before belongs to the old position: drop it, then carry on from `from`
      this.gen++;
      this.acked = from; this.sent = from; this.waiting = false; this.endSent = false;
      if (from === 0) this.put(jsonMsg(T.Manifest, this.manifest));
      void this.pump();
    } else if (m.t === T.Ack) {
      if (Number.isSafeInteger(m.json?.offset) && m.json.offset > this.acked && m.json.offset <= this.sent) { this.acked = m.json.offset; this.on.progress?.(this.acked, this.total); void this.pump(); }
    } else if (m.t === T.Done) {
      this.done = true; this.on.progress?.(this.total, this.total); this.on.done?.();
    } else if (m.t === T.Abort) {
      this.stopped = (m.json?.reason as AbortReason) ?? 'cancelled'; this.on.abort?.(this.stopped);
    }
  }
  /** stop, and tell the phone; resolves once the message has been handed to the wire */
  cancel(): Promise<void> { if (this.done || this.stopped) return Promise.resolve(); this.stopped = 'cancelled'; return this.put(jsonMsg(T.Abort, { reason: 'cancelled' })); }
  /** encrypt and send in order, on the connection that was current when queued */
  private put(plain: Uint8Array): Promise<void> {
    const gen = this.gen;
    return (this.outbox = this.outbox.then(async () => { const sealed = await seal(this.key, Dir.ToPhone, plain); if (gen === this.gen) this.wire?.send(sealed); }));
  }
  /** the bytes at [from, from + n) of the stream (the files back to back) */
  private async slice(from: number, n: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let start = 0;
    for (const b of this.blobs) {
      const end = start + b.size;
      if (from < end && from + n > start) parts.push(new Uint8Array(await b.slice(Math.max(0, from - start), Math.min(b.size, from + n - start)).arrayBuffer()));
      start = end;
    }
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const ready = () => !this.done && !this.stopped && !this.waiting && !!this.wire;
      while (ready() && this.sent < this.total && this.sent - this.acked < LIMITS.window * LIMITS.chunk) {
        const n = Math.min(LIMITS.chunk, this.total - this.sent), at = this.sent, gen = this.gen;
        const bytes = await this.slice(at, n);
        if (this.sent !== at || gen !== this.gen) continue; // a reconnect or resume moved the position while reading
        this.sent = at + n;
        void this.put(dataMsg(at, bytes));
      }
      if (ready() && this.sent === this.total && !this.endSent) { this.endSent = true; void this.put(jsonMsg(T.End, { total: this.total })); }
    } finally { this.pumping = false; }
  }
}

/** the phone end: says hello, checks the manifest, takes chunks only in order, acknowledges them, and hands over the
 *  files once END confirms the total */
export class Receiver {
  private wire: Wire | null = null;
  manifest: Manifest | null = null;
  private chunks: Uint8Array[] = [];
  private got = 0;
  private sinceAck = 0;
  private gen = 0;
  private inbox: Promise<void> = Promise.resolve();
  private outbox: Promise<void> = Promise.resolve();
  done = false;
  stopped: AbortReason | null = null;
  /** `id`: this phone's own id (newPhoneId); the desktop asks the user to confirm the code derived from it */
  constructor(private key: CryptoKey, private id: string, private on: {
    manifest?: (m: Manifest) => AbortReason | null; progress?: (got: number, total: number) => void;
    done?: (files: { file: ManifestFile; blob: Blob }[], m: Manifest) => void; abort?: (r: AbortReason, byPeer: boolean) => void;
  } = {}) {}
  get received() { return this.got; }
  /** a (re)connected wire with the sender present: say where we are */
  attach(wire: Wire | null): Promise<void> {
    this.wire = wire; this.gen++;
    // queued behind any message still being handled, so the offset it reports is final
    return (this.inbox = this.inbox.then(() => { if (wire && !this.done && !this.stopped) return this.put(jsonMsg(T.Hello, { offset: this.got, id: this.id })); }));
  }
  /** messages are handled one at a time, in arrival order (decryption is asynchronous) */
  receive(sealed: Uint8Array): Promise<void> { return (this.inbox = this.inbox.then(() => this.handle(sealed))); }
  private async handle(sealed: Uint8Array) {
    if (this.done || this.stopped) return;
    let m;
    try { m = readMsg(await open(this.key, Dir.ToPhone, sealed)); } catch { return this.fail('decrypt'); }
    if (m.t === T.Manifest) {
      if (this.manifest) return; // a repeat after a reconnect from 0
      if (!validManifest(m.json)) return this.fail(manifestTotalSafe(m.json) > LIMITS.maxTotal ? 'too-large' : 'bad-manifest');
      const veto = this.on.manifest?.(m.json) ?? null;
      if (veto) return this.fail(veto);
      this.manifest = m.json;
    } else if (m.t === T.Data) {
      if (!this.manifest) return this.fail('out-of-order');
      if (m.offset! < this.got) return; // a duplicate after a resume
      if (m.offset! > this.got) return this.fail('out-of-order');
      const total = manifestTotal(this.manifest);
      if (this.got + m.bytes!.length > total) return this.fail('mismatch');
      this.chunks.push(m.bytes!.slice()); this.got += m.bytes!.length;
      this.on.progress?.(this.got, total);
      if (++this.sinceAck >= LIMITS.ackEvery || this.got === total) { this.sinceAck = 0; await this.put(jsonMsg(T.Ack, { offset: this.got })); }
    } else if (m.t === T.End) {
      if (!this.manifest || m.json?.total !== manifestTotal(this.manifest) || this.got !== m.json.total) return this.fail('mismatch');
      const files: { file: ManifestFile; blob: Blob }[] = [];
      // split the stream back into files without copying it twice: whole chunks become Blob parts
      let at = 0, ci = 0, co = 0;
      for (const f of this.manifest.files) {
        const parts: Uint8Array[] = [];
        let need = f.size;
        while (need > 0) {
          const c = this.chunks[ci], take = Math.min(need, c.length - co);
          parts.push(co === 0 && take === c.length ? c : c.subarray(co, co + take));
          need -= take; co += take; at += take;
          if (co === c.length) { ci++; co = 0; }
        }
        files.push({ file: f, blob: new Blob(parts as BlobPart[]) });
      }
      this.chunks = [];
      this.done = true;
      await this.put(jsonMsg(T.Done, {}));
      this.on.done?.(files, this.manifest);
    } else if (m.t === T.Abort) {
      this.stopped = (m.json?.reason as AbortReason) ?? 'cancelled'; this.chunks = []; this.on.abort?.(this.stopped, true);
    }
  }
  cancel(reason: AbortReason = 'cancelled') { return this.fail(reason); }
  private async fail(reason: AbortReason) {
    if (this.done || this.stopped) return;
    this.stopped = reason; this.chunks = [];
    await this.put(jsonMsg(T.Abort, { reason }));
    this.on.abort?.(reason, false);
  }
  private put(plain: Uint8Array): Promise<void> {
    const gen = this.gen;
    return (this.outbox = this.outbox.then(async () => { const sealed = await seal(this.key, Dir.ToDesktop, plain); if (gen === this.gen) this.wire?.send(sealed); }));
  }
}
function manifestTotalSafe(x: any): number { try { return (x?.files ?? []).reduce((s: number, f: any) => s + (Number(f?.size) || 0), 0); } catch { return 0; } }
