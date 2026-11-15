// Skyline Atlas worker: serves the static app as before, and runs the Send to Phone relay at /relay/<room>.
// Deployed only with wrangler.relay.jsonc (the default wrangler.jsonc is static assets only, so the relay stays off in
// production until it is deliberately switched on). Only /relay/* reaches this code (`run_worker_first`); every other
// request is a static asset, which is free and never invokes the worker. The relay forwards end-to-end encrypted messages between a desktop and a phone
// and stores nothing but a room's timestamps and byte count (see room-core.ts and docs/send-to-phone-feasibility.md).
import { DurableObject } from 'cloudflare:workers';
import { CLOSE, join, message, nextCheck, expired, other, spend, checkTicket, issueTicket, clientKey, clientOf, utcDay, b64, LIMITS, BUDGET, type Budget, type BudgetState, type Role, type RoomError, type RoomLimits, type RoomState } from './room-core';

interface Env {
  ROOMS: DurableObjectNamespace; BUDGET: DurableObjectNamespace; ASSETS: Fetcher;
  /** signs room tickets (`wrangler secret put RELAY_SECRET`); without it the relay refuses everything */
  RELAY_SECRET?: string;
  /** per-IP request limit, checked before any Durable Object is involved (approximate, per Cloudflare location) */
  RELAY_LIMIT?: RateLimit;
  /** test-only overrides (wrangler dev --var); unset in production */
  PAIR_MS?: string; MAX_MS?: string; ROOMS_PER_DAY?: string; BYTES_PER_DAY?: string; ROOMS_PER_CLIENT?: string;
}
const num = (v?: string) => (v && /^\d+$/.test(v) ? +v : undefined);
const budgetOf = (env: Env): Budget => ({ ...BUDGET, roomsPerDay: num(env.ROOMS_PER_DAY) ?? BUDGET.roomsPerDay, bytesPerDay: num(env.BYTES_PER_DAY) ?? BUDGET.bytesPerDay, roomsPerClient: num(env.ROOMS_PER_CLIENT) ?? BUDGET.roomsPerClient });
const limitsOf = (env: Env): RoomLimits => ({ ...LIMITS, pairMs: num(env.PAIR_MS) ?? LIMITS.pairMs, maxMs: num(env.MAX_MS) ?? LIMITS.maxMs });

const ROOM_PATH = /^\/relay\/([A-Za-z0-9_-]{22})$/;
const clientIp = (req: Request) => req.headers.get('CF-Connecting-IP') ?? 'unknown';
const sendJson = (ws: WebSocket, msg: object) => { try { ws.send(JSON.stringify(msg)); } catch { /* closed */ } };
const closeWs = (ws: WebSocket, code: number, reason: string) => { try { ws.close(code, reason); } catch { /* closed */ } };
/** accept, say why, and close: a browser can't read an HTTP status from a refused WebSocket */
function refuse(error: RoomError): Response {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  sendJson(server, { t: 'error', code: error });
  closeWs(server, CLOSE[error], error);
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const isNew = url.pathname === '/relay/new', m = ROOM_PATH.exec(url.pathname);
    if (!isNew && !m) return env.ASSETS.fetch(req);
    if (isNew ? req.method !== 'POST' : req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(isNew ? 'Expected POST' : 'Expected a WebSocket', { status: isNew ? 405 : 426 });
    // only pages served from this same origin may use the relay
    if (req.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
    // a flood from one address is turned away here, before it costs a Durable Object request
    if (env.RELAY_LIMIT && !(await env.RELAY_LIMIT.limit({ key: clientOf(clientIp(req)) })).success) return new Response('Too many requests', { status: 429 });
    // fail closed: without the signing secret no ticket can be issued or checked
    if (!env.RELAY_SECRET) return new Response('Send to phone is not configured', { status: 503 });
    const now = Date.now();
    if (isNew) {
      // a fresh room id and a ticket for each side, valid for as long as a room can live; no Durable Object is involved
      const room = b64(crypto.getRandomValues(new Uint8Array(16))), exp = Math.floor(now / 1000) + Math.ceil(limitsOf(env).maxMs / 1000);
      const [send, recv] = await Promise.all([issueTicket(env.RELAY_SECRET, room, 'send', exp), issueTicket(env.RELAY_SECRET, room, 'recv', exp)]);
      return new Response(JSON.stringify({ room, send, recv }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    // a made-up room id, a ticket for another room or side, or a stale link is answered here: it never reaches (or
    // wakes) a Durable Object
    const role = url.searchParams.get('role') ?? '';
    const t = await checkTicket(env.RELAY_SECRET, m![1], role, url.searchParams.get('t') ?? '', now);
    if (t.ok !== 'ok') return refuse('expired');
    // the room learns the checked role and expiry from the worker, never from the client
    const inner = new URL(`https://room/${m![1]}`);
    inner.searchParams.set('role', role); inner.searchParams.set('until', String(t.until));
    return env.ROOMS.get(env.ROOMS.idFromName(m![1])).fetch(new Request(inner, req));
  },
};

/** One transfer room. Uses WebSocket hibernation, so a room waiting for the phone to scan costs no duration. */
export class TransferRoom extends DurableObject<Env> {
  private state: RoomState | null | undefined; // undefined: not read from storage yet
  private get limits(): RoomLimits { return limitsOf(this.env); }
  /** spend from Skyline's daily relay budget (the RelayBudget singleton); false once the day's allowance (or this
   *  client's share of the rooms) is used, and false when the budget can't be reached: it fails closed */
  private async spend(kind: 'room' | 'bytes', n = 0, ip = ''): Promise<boolean> {
    const stub = this.env.BUDGET.get(this.env.BUDGET.idFromName('budget'));
    try { return (await stub.fetch(new Request(`https://budget/${kind}?n=${n}&ip=${encodeURIComponent(ip)}`, { method: 'POST' }))).ok; } catch { return false; }
  }

  private async load(): Promise<RoomState | null> {
    if (this.state === undefined) this.state = (await this.ctx.storage.get<RoomState>('room')) ?? null;
    return this.state;
  }
  private async save(s: RoomState) { this.state = s; await this.ctx.storage.put('room', s); }
  private sockets(role: Role) { return this.ctx.getWebSockets(role); }
  private roleOf(ws: WebSocket): Role { return (this.ctx.getTags(ws)[0] as Role) ?? 'send'; }

  /**
   * Everything that reads or changes the room (joins, messages, closes, the alarm) runs one at a time, in order. Awaiting
   * the budget lets other events in, so without this a close or the alarm could forget the room in the middle of a
   * message and the message would then store it again, or two joins could both open it.
   */
  private chain: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  fetch(req: Request): Promise<Response> { return this.serial(() => this.open(req)); }
  private async open(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams, role = q.get('role') ?? '', until = Number(q.get('until'));
    const now = Date.now();
    const L = this.limits;
    const j = join(await this.load(), role, now, L, Number.isFinite(until) ? until : now);
    if (!j.ok) return refuse(j.error);
    // a new room costs one of the day's rooms (and one of this client's); once they are used up, say so instead
    if (!this.state && !(await this.spend('room', 0, clientIp(req)))) return refuse('busy');
    const [client, server] = Object.values(new WebSocketPair());
    const r = role as Role;
    // one socket per side: a reconnect replaces the old one
    for (const old of this.sockets(r)) { sendJson(old, { t: 'error', code: 'replaced' }); closeWs(old, CLOSE.replaced, 'replaced'); }
    this.ctx.acceptWebSocket(server, [r]);
    await this.save(j.state);
    await this.ctx.storage.setAlarm(nextCheck(j.state, L));
    const peer = this.sockets(other(r))[0];
    sendJson(server, { t: 'joined', role: r, peer: !!peer, opened: j.state.opened, pairMs: L.pairMs, maxMs: L.maxMs });
    if (peer) sendJson(peer, { t: 'peer', on: true });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, data: ArrayBuffer | string): Promise<void> { return this.serial(() => this.onMessage(ws, data)); }
  private async onMessage(ws: WebSocket, data: ArrayBuffer | string) {
    // clients only send encrypted binary; anything else ends the room (it would otherwise slip past the message cap)
    if (typeof data === 'string') return this.shut('bad-message');
    const s = await this.load();
    if (!s) return this.shut('expired');
    const m = message(s, data.byteLength, Date.now(), this.limits, budgetOf(this.env));
    if (!m.ok) return this.shut(m.error);
    if (m.reserve) {
      // forwarding past this room's allowance needs another block from the day's budget
      if (!(await this.spend('bytes', m.reserve))) return this.shut('busy');
      await this.save({ ...m.state, allowance: s.allowance + m.reserve });
    } else {
      // counts are kept in memory and stored every 4 MB or 64 messages, so waking from hibernation (which forgets
      // memory) can under-count by at most that much
      this.state = m.state;
      if (Math.floor(m.state.bytes / (4 << 20)) !== Math.floor(s.bytes / (4 << 20)) || m.state.msgs % 64 === 0) await this.ctx.storage.put('room', m.state);
    }
    for (const peer of this.sockets(other(this.roleOf(ws)))) { try { peer.send(data); } catch { /* peer gone; the client resends after reconnecting */ } }
  }

  webSocketClose(ws: WebSocket, code: number): Promise<void> {
    return this.serial(async () => {
      const role = this.roleOf(ws);
      closeWs(ws, code === 1005 || code === 1006 ? 1000 : code, 'closed');
      for (const peer of this.sockets(other(role))) sendJson(peer, { t: 'peer', on: false });
      await this.tidy();
    });
  }
  webSocketError(ws: WebSocket): Promise<void> { return this.webSocketClose(ws, 1011); }

  /** the room's deadline: close everything once it has expired, otherwise check again at the next deadline */
  alarm(): Promise<void> {
    return this.serial(async () => {
      const s = await this.load();
      if (!s) return;
      if (expired(s, Date.now(), this.limits)) return this.shut('expired');
      await this.ctx.storage.setAlarm(nextCheck(s, this.limits));
    });
  }

  private async shut(error: RoomError) {
    for (const ws of this.ctx.getWebSockets()) { sendJson(ws, { t: 'error', code: error }); closeWs(ws, CLOSE[error], error); }
    await this.forget();
  }
  /** nobody left: forget the room entirely. Its tickets can open it again until they expire, which counts as a new room
   *  against the budget and still closes when the tickets expire. */
  private async tidy() { if (!this.ctx.getWebSockets().some((ws) => ws.readyState === 1)) await this.forget(); }
  private async forget() { this.state = null; await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); }
}

/** Skyline's daily relay budget, one instance for the whole relay: counts today's rooms and forwarded bytes (UTC day) */
export class RelayBudget extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url), kind = url.pathname.slice(1), n = Number(url.searchParams.get('n') ?? 0), now = Date.now();
    if (kind !== 'room' && kind !== 'bytes') return new Response(null, { status: 400 });
    const client = kind === 'room' ? await clientKey(url.searchParams.get('ip') ?? '', utcDay(now)) : '';
    const r = spend((await this.ctx.storage.get<BudgetState>('day')) ?? null, kind, Number.isFinite(n) ? n : 0, now, budgetOf(this.env), client);
    await this.ctx.storage.put('day', r.state);
    return new Response(null, { status: r.ok ? 204 : 429 });
  }
}
