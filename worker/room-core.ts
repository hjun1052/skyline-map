// Send to Phone relay: the rules of a transfer room, apart from the Workers runtime so they can be tested in Node.
// A room has at most one desktop ("send") and one phone ("recv") socket. It never sees the key or plaintext: it only
// forwards binary messages from one side to the other and enforces time and size limits.

export type Role = 'send' | 'recv';
export const ROLES: Role[] = ['send', 'recv'];
export const other = (r: Role): Role => (r === 'send' ? 'recv' : 'send');

export interface RoomLimits {
  /** the phone must join within this long of the room being opened */
  pairMs: number;
  /** a room closes this long after it opened, whatever is happening */
  maxMs: number;
  /** bytes the room forwards in total (both directions, with encryption overhead) */
  maxBytes: number;
  /** largest single message */
  maxMessage: number;
  /** messages a room forwards in total (a 100 MB transfer is about 400 chunks plus acknowledgements) */
  maxMessages: number;
}
export const LIMITS: RoomLimits = {
  pairMs: 5 * 60_000,
  maxMs: 15 * 60_000,
  maxBytes: 110 * 1024 * 1024, // 100 MB of payload plus per-chunk overhead and acknowledgements
  maxMessage: 1024 * 1024,
  maxMessages: 2000,
};

/**
 * Skyline's own daily budget for the relay, across all rooms (a singleton Durable Object keeps the counts, per UTC day).
 * It bounds what Send to Phone can use, whatever happens, independent of the account's other Workers; see
 * docs/send-to-phone-billing.md for the worst-case arithmetic behind these numbers.
 */
export interface Budget {
  /** rooms a desktop may open per UTC day (every attempt counts, finished or not) */
  roomsPerDay: number;
  /** bytes all rooms together may forward per UTC day */
  bytesPerDay: number;
  /** rooms one client address may open per UTC day, so one person can't use up everyone's rooms */
  roomsPerClient: number;
  /** a room reserves bytes from the day's budget in blocks of this size */
  block: number;
}
export const BUDGET: Budget = { roomsPerDay: 50, bytesPerDay: 2 * 1024 ** 3, roomsPerClient: 10, block: 8 * 1024 * 1024 };
/** `clients`: rooms opened today per client (keyed by a hash of the day and the address, never the address itself) */
export interface BudgetState { day: string; rooms: number; bytes: number; clients?: Record<string, number> }
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
/** spend from the day's budget: a room (for `client`), or `n` bytes. Refused (state unchanged) once the day's
 *  allowance, or that client's share of the rooms, is used. */
export function spend(s: BudgetState | null, kind: 'room' | 'bytes', n: number, now: number, b = BUDGET, client = ''): { ok: boolean; state: BudgetState } {
  const day = utcDay(now);
  const cur: BudgetState = s && s.day === day ? s : { day, rooms: 0, bytes: 0 };
  if (kind === 'room') {
    const mine = cur.clients?.[client] ?? 0;
    if (cur.rooms >= b.roomsPerDay || mine >= b.roomsPerClient) return { ok: false, state: cur };
    return { ok: true, state: { ...cur, rooms: cur.rooms + 1, clients: { ...cur.clients, [client]: mine + 1 } } };
  }
  return n <= 0 || cur.bytes + n > b.bytesPerDay ? { ok: n === 0, state: cur } : { ok: true, state: { ...cur, bytes: cur.bytes + n } };
}

/** what a room keeps (in Durable Object storage, a few bytes; never map data) */
export interface RoomState {
  opened: number; paired: boolean; bytes: number;
  /** the room's tickets expire here; the room closes then at the latest, however often it is reopened */
  until: number;
  /** messages forwarded so far */
  msgs: number;
  /** bytes this room has reserved from the day's budget (it forwards no more without reserving another block) */
  allowance: number;
}

/** reasons a socket is refused or closed; sent to the client as `{ t: 'error', code }` before closing */
export type RoomError = 'no-room' | 'expired' | 'bad-role' | 'too-big' | 'limit' | 'replaced' | 'busy' | 'bad-message';
/** WebSocket close codes (4000-4999 are free for applications) */
export const CLOSE: Record<RoomError | 'done', number> = { done: 1000, 'no-room': 4404, expired: 4410, 'bad-role': 4400, 'too-big': 4413, limit: 4429, replaced: 4409, busy: 4503, 'bad-message': 4422 };

export function expired(s: RoomState, now: number, l = LIMITS): boolean {
  return now >= s.until || now - s.opened >= l.maxMs || (!s.paired && now - s.opened >= l.pairMs);
}
/** when the room should next check itself (its alarm) */
export function nextCheck(s: RoomState, l = LIMITS): number {
  return Math.min(s.until, s.paired ? s.opened + l.maxMs : s.opened + l.pairMs);
}

/** a socket asks to join as `role` (`until`: when its ticket expires). The desktop opens the room; a phone can only
 *  join one that exists and is still open. */
export function join(s: RoomState | null, role: string, now: number, l = LIMITS, until = now + l.maxMs): { ok: true; state: RoomState } | { ok: false; error: RoomError } {
  if (role !== 'send' && role !== 'recv') return { ok: false, error: 'bad-role' };
  if (!s) return role === 'send' ? { ok: true, state: { opened: now, paired: false, bytes: 0, msgs: 0, allowance: 0, until: Math.min(until, now + l.maxMs) } } : { ok: false, error: 'no-room' };
  if (expired(s, now, l)) return { ok: false, error: 'expired' };
  return { ok: true, state: role === 'recv' ? { ...s, paired: true } : s };
}

/**
 * A room read back from storage (after hibernation, which forgets memory). Its stored byte count may be behind what it
 * really forwarded since the last checkpoint, so whatever it had reserved and not yet stored as used is treated as
 * spent: forwarding more needs a fresh reservation. Otherwise every wake-up could reuse the same reservation and the
 * daily byte cap would leak.
 */
export function restore(s: RoomState): RoomState { return { ...s, allowance: Math.min(s.allowance, s.bytes) }; }

/** a message of `size` bytes arrives: forward it, or close the room. `reserve`: bytes to reserve from the day's budget
 *  first (0 when the room's allowance already covers it) */
export function message(s: RoomState, size: number, now: number, l = LIMITS, b = BUDGET): { ok: true; state: RoomState; reserve: number } | { ok: false; error: RoomError } {
  if (expired(s, now, l)) return { ok: false, error: 'expired' };
  if (size > l.maxMessage) return { ok: false, error: 'too-big' };
  if (s.bytes + size > l.maxBytes || s.msgs + 1 > l.maxMessages) return { ok: false, error: 'limit' };
  const bytes = s.bytes + size;
  return { ok: true, state: { ...s, bytes, msgs: s.msgs + 1 }, reserve: bytes > s.allowance ? Math.max(b.block, bytes - s.allowance) : 0 };
}

// ------------------------------------------------------------------ tickets

/**
 * A room can only be used with a ticket the relay itself issued (`/relay/new`): HMAC-SHA256 over the room id, the role
 * (desktop or phone) and an expiry, keyed with a Worker secret. The Worker checks it before any Durable Object is
 * involved, so made-up room ids and stale links cost one Worker request and nothing more. The desktop keeps its `send`
 * ticket; only the `recv` ticket travels in the QR code, so whoever sees the code can't take the desktop's place.
 * Format: `<expiry, unix seconds>.<signature, base64url>`.
 */
export const TICKET_RE = /^(\d{10})\.([A-Za-z0-9_-]{43})$/;
export const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const keys = new Map<string, Promise<CryptoKey>>();
const hmacKey = (secret: string) => {
  let k = keys.get(secret);
  if (!k) keys.set(secret, (k = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])));
  return k;
};
export async function issueTicket(secret: string, room: string, role: Role, exp: number): Promise<string> {
  return `${exp}.${b64(await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(`${room}.${role}.${exp}`)))}`;
}
/** 'ok' (with its expiry, ms), 'expired' (genuine but past its expiry) or 'bad' (not issued by this relay, or for
 *  another room or role) */
export async function checkTicket(secret: string, room: string, role: string, ticket: string, now: number): Promise<{ ok: 'ok'; until: number } | { ok: 'expired' | 'bad' }> {
  const m = TICKET_RE.exec(ticket);
  if (!m || (role !== 'send' && role !== 'recv')) return { ok: 'bad' };
  const good = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64(m[2]), new TextEncoder().encode(`${room}.${role}.${m[1]}`));
  return !good ? { ok: 'bad' } : +m[1] * 1000 <= now ? { ok: 'expired' } : { ok: 'ok', until: +m[1] * 1000 };
}
/** who to count a request against: an IPv4 address, or the /64 an IPv6 address is in (one subscriber usually gets a
 *  whole /64, so counting single IPv6 addresses would let one person rotate past every limit) */
export function clientOf(ip: string): string {
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (v4 || !ip.includes(':')) return v4 ? v4[1] : ip;
  const [head, tail] = ip.toLowerCase().split('%')[0].split('::');
  const h = head ? head.split(':') : [], t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const all = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return all.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16)).join(':') + '::/64';
}
/** the per-day key a client's room count is kept under: a hash, so the budget never stores an address */
export async function clientKey(ip: string, day: string): Promise<string> {
  return b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`skyline-relay:${day}:${clientOf(ip)}`))).slice(0, 16);
}
