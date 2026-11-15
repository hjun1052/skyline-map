// Send to Phone: encryption, chunking, transfer integrity, resume, failure handling and the relay room's rules.
//   npm run check:phone
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  LIMITS, Dir, T, b64url, unb64url, newRoom, newKeyText, newDeviceKeys, sessionKey, pairingUrl, parsePairing, importKey, pairingCode, seal, open,
  jsonMsg, dataMsg, readMsg, validManifest, Sender, Receiver, type Manifest, type Wire, type AbortReason,
} from '../src/phone/protocol';
import { join, message, expired, nextCheck, spend, issueTicket, checkTicket, clientKey, clientOf, restore, LIMITS as ROOM, BUDGET, type RoomState } from '../worker/room-core';

if (!globalThis.crypto) (globalThis as any).crypto = webcrypto;
const newRoomId = newRoom; // a room id the relay never issued (the live tests below get theirs from the relay)
let failures = 0;
const fail = (m: string) => { failures++; console.error('  ✗ ' + m); };
const ok = (c: boolean, m: string) => { if (!c) fail(m); };
const rand = (n: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return b; };
const same = async (blob: Blob, b: Uint8Array) => { const x = new Uint8Array(await blob.arrayBuffer()); return x.length === b.length && x.every((v, i) => v === b[i]); };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** two ends joined by an in-memory relay; `drop(n)` cuts the connection after n more messages, `tamper` edits messages */
type Tamper = (m: Uint8Array, dir: 'down' | 'up') => Uint8Array | null;
type Got = { files: { blob: Blob }[]; m: Manifest };
function link(opts: { tamper?: Tamper } = {}) {
  let up: Wire | null = null, down: Wire | null = null, budget = Infinity, live = true;
  const q: (() => Promise<void>)[] = [];
  let running = false;
  const flush = async () => { if (running) return; running = true; while (q.length) await q.shift()!(); running = false; };
  return {
    connect(s: Sender, r: Receiver) {
      live = true;
      // a fresh pair of wires: what the old ones carry after a drop is lost, as on a real socket
      const gen = {};
      let cur = gen;
      const mk = (dir: 'down' | 'up', to: (m: Uint8Array) => Promise<void>): Wire => ({
        send(m) {
          if (!live || cur !== gen) return;
          if (budget-- <= 0) { live = false; return; }
          const t = opts.tamper ? opts.tamper(m, dir) : m;
          if (t) { q.push(() => to(t)); void flush(); }
        },
      });
      down = mk('down', (m) => r.receive(m)); up = mk('up', (m) => s.receive(m));
      s.attach(down); void r.attach(up);
      return () => { cur = {}; };
    },
    drop(after: number) { budget = after; },
    idle: async () => { for (let i = 0; i < 200; i++) { await flush(); await tick(); } },
  };
}

async function unit() {
  console.log('encryption and pairing');
  for (const n of [0, 1, 2, 3, 16, 31, 32, 33]) { const b = rand(n), t = b64url(b), back = unb64url(t)!; ok(back.length === n && back.every((v, i) => v === b[i]), `base64url round trip (${n} bytes)`); }
  ok(unb64url('ab$c') === null && unb64url('a') === null, 'base64url rejects bad text');
  const room = newRoom(), keyText = newKeyText();
  ok(/^[A-Za-z0-9_-]{22}$/.test(room) && keyText.length === 43, 'room id 22 chars (128 bits), key 43 chars (256 bits)');
  ok(newRoom() !== room && newKeyText() !== keyText, 'room ids and keys are random');
  const ticket = await issueTicket('test-secret', room, 'recv', Math.floor(Date.UTC(2026, 10, 15, 10) / 1000));
  const url = pairingUrl('https://skyline.codz.me', room, keyText, ticket), p = parsePairing(new URL(url).hash);
  ok(!!p && p.room === room && p.key === keyText && p.ticket === ticket, 'pairing link round trip (room, key, ticket)');
  ok(!parsePairing('#phone=short.key') && !parsePairing('#other=' + room + '.' + keyText + '.' + ticket) && !parsePairing('#phone=' + room + '.' + keyText), 'malformed or ticketless pairing links are ignored');
  ok(url.length < 200, `pairing link stays short enough for a small QR code (${url.length} chars)`);
  const phoneKeys = await newDeviceKeys(), deskKeys = await newDeviceKeys();
  ok(/^[A-Za-z0-9_-]{87}$/.test(phoneKeys.pub) && phoneKeys.pub !== deskKeys.pub, 'device public keys are 87 characters (65 raw bytes) and random');
  const code = await pairingCode(phoneKeys.pub);
  ok(/^\d{4}$/.test(code) && code === (await pairingCode(phoneKeys.pub)), 'a phone\'s code is 4 stable digits');
  let distinct = 0;
  for (let i = 0; i < 20; i++) if ((await pairingCode((await newDeviceKeys()).pub)) !== code) distinct++;
  ok(distinct >= 18, 'different phones show different codes');
  const sp = await sessionKey(phoneKeys.pair, deskKeys.pub, phoneKeys.pub, deskKeys.pub), sd = await sessionKey(deskKeys.pair, phoneKeys.pub, phoneKeys.pub, deskKeys.pub);
  const probe = await seal(sd, Dir.ToPhone, new TextEncoder().encode('session'));
  ok(new TextDecoder().decode(await open(sp, Dir.ToPhone, probe)) === 'session', 'phone and desktop derive the same session key');
  const outsider = await newDeviceKeys();
  const so = await sessionKey(outsider.pair, deskKeys.pub, phoneKeys.pub, deskKeys.pub);
  let leaked = true; try { await open(so, Dir.ToPhone, probe); } catch { leaked = false; }
  ok(!leaked, 'someone with only the public keys (and the QR key) cannot derive the session key');

  console.log('tickets');
  const T0 = Date.UTC(2026, 10, 15, 10), exp = Math.floor(T0 / 1000) + 900;
  const tk = await issueTicket('s3cret', room, 'recv', exp);
  const chk = async (...a: Parameters<typeof checkTicket>) => (await checkTicket(...a)).ok;
  const genuine = await checkTicket('s3cret', room, 'recv', tk, T0);
  ok(genuine.ok === 'ok' && genuine.until === exp * 1000, 'a ticket the relay issued is accepted, with its expiry');
  ok((await chk('s3cret', newRoom(), 'recv', tk, T0)) === 'bad', 'a ticket is only good for its own room');
  ok((await chk('s3cret', room, 'send', tk, T0)) === 'bad', 'the phone\'s ticket (the one in the QR code) cannot connect as the desktop');
  ok((await chk('other', room, 'recv', tk, T0)) === 'bad', 'a ticket signed with another secret is refused');
  ok((await chk('s3cret', room, 'recv', tk, exp * 1000)) === 'expired', 'a ticket past its expiry is refused');
  const later = tk.replace(/^\d+/, String(exp + 3600));
  ok((await chk('s3cret', room, 'recv', later, T0)) === 'bad', 'extending a ticket\'s expiry breaks its signature');
  ok((await chk('s3cret', room, 'recv', '', T0)) === 'bad' && (await chk('s3cret', room, 'recv', 'x.y', T0)) === 'bad' && (await chk('s3cret', room, 'admin', tk, T0)) === 'bad', 'missing or malformed tickets and unknown roles are refused');
  ok(clientOf('203.0.113.7') === '203.0.113.7' && clientOf('::ffff:203.0.113.7') === '203.0.113.7', 'IPv4 (also IPv4-mapped) is counted per address');
  ok(clientOf('2001:db8:1:2:aaaa::1') === '2001:db8:1:2::/64' && clientOf('2001:db8:1:2:bbbb:cccc:dddd:eeee') === '2001:db8:1:2::/64' && clientOf('2001:DB8:1:2::') === '2001:db8:1:2::/64', 'IPv6 is counted per /64, so rotating addresses inside one doesn\'t escape the limits');
  ok(clientOf('2001:db8::1') === '2001:db8:0:0::/64' && clientOf('2001:db8:0:3::1') !== clientOf('2001:db8::1'), 'different /64s are different clients');
  const key = await importKey(keyText), other = await importKey(newKeyText());
  const msg = new TextEncoder().encode('hello map');
  const sealed = await seal(key, Dir.ToPhone, msg);
  ok(new TextDecoder().decode(await open(key, Dir.ToPhone, sealed)) === 'hello map', 'seal / open round trip');
  ok(!sealed.slice(12).some((_, i, a) => i + msg.length <= a.length && msg.every((v, k) => a[i + k] === v)), 'ciphertext does not contain the plaintext');
  const s2 = await seal(key, Dir.ToPhone, msg);
  ok(b64url(s2) !== b64url(sealed), 'a fresh IV per message (same plaintext, different ciphertext)');
  const rejects = async (p: Promise<unknown>) => { try { await p; return false; } catch { return true; } };
  const flipped = sealed.slice(); flipped[20] ^= 1;
  ok(await rejects(open(key, Dir.ToPhone, flipped)), 'a tampered message is rejected');
  ok(await rejects(open(key, Dir.ToDesktop, sealed)), 'a message reflected back the other way is rejected');
  ok(await rejects(open(other, Dir.ToPhone, sealed)), 'a message under another key is rejected');
  ok(await rejects(importKey('short')), 'a malformed key is rejected');

  console.log('messages and manifest');
  const d = readMsg(dataMsg(123456789, new Uint8Array([1, 2, 3])));
  ok(d.t === T.Data && d.offset === 123456789 && d.bytes!.join() === '1,2,3', 'data message round trip');
  ok(readMsg(jsonMsg(T.Ack, { offset: 5 })).json.offset === 5, 'json message round trip');
  const good: Manifest = { v: 1, city: 'Seorang', files: [{ kind: 'map', name: 'seorang.cslmap', size: 10 }, { kind: 'save', name: 'seorang.crp', size: 20 }] };
  ok(validManifest(good), 'a normal manifest is accepted');
  ok(!validManifest({ ...good, files: [{ kind: 'save', name: 'x.crp', size: 1 }] }), 'a manifest without a map is refused');
  ok(!validManifest({ ...good, files: [{ kind: 'map', name: '../etc', size: 1 }] }), 'file names with paths are refused');
  ok(!validManifest({ ...good, files: [{ kind: 'map', name: 'a', size: LIMITS.maxTotal + 1 }] }), 'more than the size limit is refused');
  ok(!validManifest({ ...good, files: [good.files[0], good.files[0]] }), 'two maps are refused');
  ok(!validManifest({ ...good, settings: 'x'.repeat(LIMITS.maxSettings + 1) }), 'oversized settings are refused');

  console.log('transfers');
  // a map and a save whose sizes are not multiples of the chunk size, with settings
  const map = rand(3 * LIMITS.chunk + 12345), save = rand(LIMITS.chunk + 7);
  const manifest: Manifest = { v: 1, city: 'Seorang', files: [{ kind: 'map', name: 'seorang.cmm.gz', size: map.length }, { kind: 'save', name: 'seorang.crp', size: save.length }], settings: { city: 'Seorang', fares: { 3: 1.5 } } };
  const run = async (o: { drops?: number[]; tamper?: Tamper; vetoManifest?: AbortReason; cancelAfter?: number; manifest?: Manifest; blobs?: Blob[] } = {}) => {
    const key = await importKey(keyText);
    let got: Got | null = null, rAbort: [AbortReason, boolean] | null = null, sAbort: AbortReason | null = null, sDone = false, progress = 0;
    const m = o.manifest ?? manifest;
    const s = new Sender(key, m, o.blobs ?? [new Blob([map as BlobPart]), new Blob([save as BlobPart])], { done: () => (sDone = true), abort: (r) => (sAbort = r) });
    const r = new Receiver(key, await newDeviceKeys(), { manifest: () => o.vetoManifest ?? null, progress: (g) => (progress = g), done: (files, mm) => (got = { files, m: mm }), abort: (why, peer) => (rAbort = [why, peer]) });
    let downs = 0;
    const l = link({ tamper: (msg, dir) => { if (dir === 'down' && o.cancelAfter !== undefined && ++downs === o.cancelAfter) s.cancel(); return o.tamper ? o.tamper(msg, dir) : msg; } });
    const drops = [...(o.drops ?? [])];
    l.drop(drops.shift() ?? Infinity);
    l.connect(s, r);
    for (let i = 0; i < 20 && !got && !rAbort && !sAbort; i++) {
      await l.idle();
      if (!got && !rAbort && drops.length + 1 > 0 && (s as any).wire && !r.done) { l.drop(drops.shift() ?? Infinity); l.connect(s, r); } // reconnect both
    }
    await l.idle();
    return { got: got as Got | null, rAbort: rAbort as [AbortReason, boolean] | null, sAbort: sAbort as AbortReason | null, sDone, progress, r };
  };
  const plain = await run();
  ok(!!plain.got && plain.sDone, 'a transfer completes and both ends know');
  ok(!!plain.got && (await same(plain.got.files[0].blob, map)) && (await same(plain.got.files[1].blob, save)), 'map and save arrive byte for byte');
  ok(JSON.stringify(plain.got?.m.settings) === JSON.stringify(manifest.settings), 'settings arrive with the manifest');
  // interrupted twice mid-stream, reconnecting each time: carries on from where the phone got to
  const resumed = await run({ drops: [5, 9] });
  ok(!!resumed.got && (await same(resumed.got!.files[0].blob, map)) && (await same(resumed.got!.files[1].blob, save)), 'a transfer interrupted twice resumes and arrives intact');
  // only the phone reconnects (the desktop's socket stays up): whatever the desktop had queued for the old phone socket
  // must not reach the new one ahead of the resume point
  {
    const key = await importKey(keyText);
    const big = rand(12 * LIMITS.chunk + 5);
    let got: Blob | null = null, why: AbortReason | null = null;
    const s = new Sender(key, { v: 1, city: 'x', files: [{ kind: 'map', name: 'b', size: big.length }] }, [new Blob([big as BlobPart])]);
    const r = new Receiver(key, await newDeviceKeys(), { done: (f) => (got = f[0].blob), abort: (w) => (why = w) });
    let phoneUp = true, delivered = 0;
    const toPhone: Uint8Array[] = [];
    // the relay: desktop → phone messages wait in a queue (as in flight); the phone drops after 3 of them
    s.attach({ send: (m) => { toPhone.push(m); } });
    const up: Wire = { send: (m) => void s.receive(m) };
    await r.attach(up);
    const deliver = async (n: number) => { for (let i = 0; i < n && toPhone.length; i++) { const m = toPhone.shift()!; if (phoneUp) { delivered++; await r.receive(m); } } };
    for (let i = 0; i < 20; i++) { await tick(); await deliver(1); if (delivered >= 3) break; }
    phoneUp = false; s.pause(); // the relay tells the desktop the phone left; what was in flight is lost
    await deliver(100); for (let i = 0; i < 20; i++) await tick();
    toPhone.length = 0;
    phoneUp = true; await r.attach(up); // the phone comes back on a new socket; the desktop's socket never dropped
    for (let i = 0; i < 400 && !got && !why; i++) { await tick(); await deliver(100); }
    ok(!why && !!got && (await same(got, big)), `the phone reconnecting alone resumes cleanly (${why ?? 'ok'})`);
  }
  // a byte changed in transit (by the relay or anyone in between): the phone refuses it
  let n = 0;
  const tampered = await run({ tamper: (m, dir) => { if (dir === 'down' && ++n === 4) { const c = m.slice(); c[40] ^= 0xff; return c; } return m; } });
  ok(!tampered.got && tampered.rAbort?.[0] === 'decrypt' && tampered.sAbort === 'decrypt', 'a tampered chunk aborts the transfer on both ends');
  // a chunk lost without a reconnect (can't happen on one socket, so it means something is wrong): refused, not skipped
  n = 0;
  const gap = await run({ tamper: (m, dir) => (dir === 'down' && ++n === 3 ? null : m) });
  ok(!gap.got && gap.rAbort?.[0] === 'out-of-order', 'a missing chunk aborts instead of opening a corrupted map');
  // too large for the phone: refused before any data
  const big = await run({ manifest: { ...manifest, files: [{ kind: 'map', name: 'x', size: LIMITS.maxTotal + 1 }] }, blobs: [{ size: LIMITS.maxTotal + 1, slice: () => new Blob([]) } as unknown as Blob] });
  ok(!big.got && big.rAbort?.[0] === 'too-large' && big.sAbort === 'too-large', 'a transfer over the size limit is refused and the desktop is told');
  // the phone declines (e.g. not enough room): both ends stop
  const veto = await run({ vetoManifest: 'storage' });
  ok(!veto.got && veto.rAbort?.[0] === 'storage' && veto.sAbort === 'storage' && veto.progress === 0, 'the phone can decline a transfer before any data');
  // the desktop cancels
  const long = rand(20 * LIMITS.chunk); // longer than the send window, so the cancel lands mid-stream
  const cancelled = await run({ cancelAfter: 3, manifest: { v: 1, city: 'x', files: [{ kind: 'map', name: 'long.cslmap', size: long.length }] }, blobs: [new Blob([long as BlobPart])] });
  ok(!cancelled.got && cancelled.rAbort?.[0] === 'cancelled' && cancelled.rAbort?.[1] === true, 'cancelling on the desktop stops the phone');
  // a truncated stream: END claims a different total
  {
    const key = await importKey(keyText);
    let why: AbortReason | null = null;
    const pk = await newDeviceKeys(), dk = await newDeviceKeys();
    const r = new Receiver(key, pk, { abort: (w) => (why = w) });
    await r.attach({ send() {} });
    await r.receive(await seal(key, Dir.ToPhone, jsonMsg(T.Key, { pub: dk.pub })));
    const sess = await sessionKey(dk.pair, pk.pub, pk.pub, dk.pub);
    const m1: Manifest = { v: 1, city: 'x', files: [{ kind: 'map', name: 'a', size: 10 }] };
    await r.receive(await seal(sess, Dir.ToPhone, jsonMsg(T.Manifest, m1)));
    await r.receive(await seal(sess, Dir.ToPhone, dataMsg(0, new Uint8Array(6))));
    await r.receive(await seal(sess, Dir.ToPhone, jsonMsg(T.End, { total: 10 })));
    ok(why === 'mismatch' && !r.done, 'a truncated transfer is refused');
    // the map under the QR key alone (not from the desktop that confirmed this phone) is refused
    why = null;
    const r2 = new Receiver(key, await newDeviceKeys(), { abort: (w) => (why = w) });
    await r2.attach({ send() {} });
    await r2.receive(await seal(key, Dir.ToPhone, jsonMsg(T.Manifest, m1)));
    ok(why === 'decrypt' && !r2.manifest, 'a manifest under the QR key alone is refused');
  }
  // the sender ignores messages that aren't from its phone (wrong key), instead of acting on them
  {
    const key = await importKey(keyText), wrong = await importKey(newKeyText());
    const sent: Uint8Array[] = [];
    const s = new Sender(key, { v: 1, city: 'x', files: [{ kind: 'map', name: 'a', size: 4 }] }, [new Blob([new Uint8Array(4)])]);
    s.attach({ send: (m) => sent.push(m) });
    const id = (await newDeviceKeys()).pub;
    await s.receive(await seal(wrong, Dir.ToDesktop, jsonMsg(T.Hello, { offset: 0, pub: id })));
    ok(sent.length === 0, 'a hello under another key is ignored (nothing is sent)');
    await s.receive(await seal(key, Dir.ToDesktop, jsonMsg(T.Hello, { offset: 0 })));
    await tick(); await tick();
    ok(sent.length === 0, 'a hello without a public key is ignored');
    await s.receive(await seal(key, Dir.ToDesktop, jsonMsg(T.Hello, { offset: 0, pub: 'A'.repeat(87) })));
    await tick(); await tick();
    ok(sent.length === 0, 'a hello with an unusable public key is ignored');
    await s.receive(await seal(key, Dir.ToDesktop, jsonMsg(T.Hello, { offset: 0, pub: id })));
    await tick(); await tick();
    ok(sent.length >= 2, 'a hello from the phone starts the transfer');
  }
  // the desktop sends only to the phone the user confirmed
  {
    const key = await importKey(keyText);
    const data = rand(3 * LIMITS.chunk);
    const asked: string[] = [];
    let answer = false;
    const mkSender = () => new Sender(key, { v: 1, city: 'x', files: [{ kind: 'map', name: 'a', size: data.length }] }, [new Blob([data as BlobPart])], { confirm: async (id) => { asked.push(id); return answer; } });
    // declined: the phone is told it was cancelled and gets nothing
    let s = mkSender(), why: AbortReason | null = null, got: Blob | null = null;
    let r = new Receiver(key, await newDeviceKeys(), { abort: (w) => (why = w), done: (f) => (got = f[0].blob) });
    const pipe = (s: Sender, r: Receiver) => { s.attach({ send: (m) => void r.receive(m) }); return r.attach({ send: (m) => void s.receive(m) }); };
    await pipe(s, r);
    for (let i = 0; i < 50; i++) await tick();
    ok(asked.length === 1 && why === 'cancelled' && !got && !r.manifest, 'a phone the user declines gets nothing and is told it was cancelled');
    // confirmed: the transfer runs; the same phone reconnecting is not asked again
    answer = true; asked.length = 0; why = null;
    s = mkSender();
    const pk = await newDeviceKeys(), id = pk.pub;
    r = new Receiver(key, pk, { abort: (w) => (why = w), done: (f) => (got = f[0].blob) });
    await pipe(s, r);
    await r.attach({ send: (m) => void s.receive(m) }); // a reconnect of the same phone
    for (let i = 0; i < 300 && !got; i++) await tick();
    ok(!why && !!got && (await same(got, data)) && asked.length === 1 && asked[0] === id, 'a confirmed phone receives the city, and is asked about once');
    // another device with the same link (a photographed QR code) after the user confirmed their phone: transfer over
    answer = false; asked.length = 0;
    let another: boolean | null = null;
    const sent: Uint8Array[] = [];
    s = new Sender(key, { v: 1, city: 'x', files: [{ kind: 'map', name: 'a', size: data.length }] }, [new Blob([data as BlobPart])], { confirm: async (pid) => { asked.push(pid); return answer; }, declined: (a) => (another = a) });
    s.attach({ send: (m) => sent.push(m) });
    answer = true;
    await s.receive(await seal(key, Dir.ToDesktop, jsonMsg(T.Hello, { offset: 0, pub: id })));
    answer = false;
    for (let i = 0; i < 50; i++) await tick(); // the first phone's window is in flight
    // someone who photographed the QR code and silently took over the phone's socket sees all of this, but with the QR
    // key alone can read only the desktop's public key: the map is under the session key
    const readable: number[] = [];
    for (const m of sent) { try { readable.push(readMsg(await open(key, Dir.ToPhone, m)).t); } catch { /* not readable */ } }
    ok(sent.length > 3 && readable.length === 1 && readable[0] === T.Key, `a silent socket with the QR key reads none of the map (${readable.length} of ${sent.length} messages readable)`);
    // ... nor fake the phone's acknowledgements
    await s.receive(await seal(key, Dir.ToDesktop, jsonMsg(T.Done, {})));
    ok(!s.done, 'a Done under the QR key alone is ignored');
    const before = sent.length;
    await s.receive(await seal(key, Dir.ToDesktop, jsonMsg(T.Hello, { offset: 0, pub: (await newDeviceKeys()).pub })));
    for (let i = 0; i < 20; i++) await tick();
    ok(asked.length === 1 && s.stopped === 'cancelled' && another === true, 'another device after the confirmed phone is not asked about: the transfer stops');
    ok(sent.length - before === 1, 'the other device gets only the cancellation');
  }

  console.log('deploy configuration');
  const jsonc = (f: string) => JSON.parse(readFileSync(f, 'utf8').replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (m, str) => str ?? ''));
  const prod = jsonc('wrangler.jsonc'), rel = jsonc('wrangler.relay.jsonc');
  ok(!prod.main && !prod.durable_objects && !prod.migrations && !prod.ratelimits && !prod.assets.run_worker_first, 'the default deploy (wrangler.jsonc) is static assets only: the relay stays off in production');
  ok(rel.main === 'worker/index.ts' && rel.assets.run_worker_first?.join() === '/relay/*', 'the relay configuration runs the worker for /relay/* only');
  for (const k of ['name', 'compatibility_date', 'routes']) ok(JSON.stringify(prod[k]) === JSON.stringify(rel[k]), `wrangler.relay.jsonc matches wrangler.jsonc: ${k}`);
  ok(prod.assets.directory === rel.assets.directory && prod.assets.not_found_handling === rel.assets.not_found_handling, 'wrangler.relay.jsonc serves the same assets the same way');

  console.log('relay room');
  const t0 = 1_000_000;
  ok(!join(null, 'recv', t0).ok && (join(null, 'recv', t0) as any).error === 'no-room', 'a phone cannot open a room');
  ok((join(null, 'admin', t0) as any).error === 'bad-role', 'unknown roles are refused');
  const j = join(null, 'send', t0) as { ok: true; state: RoomState };
  ok(j.ok && j.state.opened === t0 && !j.state.paired, 'the desktop opens a room');
  const jr = join(j.state, 'recv', t0 + 60_000) as { ok: true; state: RoomState };
  ok(jr.ok && jr.state.paired, 'the phone joins within the pairing window');
  ok((join(j.state, 'recv', t0 + ROOM.pairMs) as any).error === 'expired', 'the phone cannot join after the pairing window');
  ok(!expired(jr.state, t0 + ROOM.pairMs + 1) && expired(jr.state, t0 + ROOM.maxMs), 'a paired room lives until the hard limit, not longer');
  ok(nextCheck(j.state) === t0 + ROOM.pairMs && nextCheck(jr.state) === t0 + ROOM.maxMs, 'the alarm is set at the next deadline');
  ok((join(jr.state, 'send', t0 + ROOM.maxMs) as any).error === 'expired', 'nobody can rejoin an expired room');
  // the tickets' expiry bounds the room, also when it is forgotten and opened again with the same ticket
  const short = join(null, 'send', t0, ROOM, t0 + 60_000) as { ok: true; state: RoomState };
  ok(short.ok && expired(short.state, t0 + 60_000) && nextCheck(short.state) === t0 + 60_000, 'a room closes when its tickets expire, before its own limits');
  const reopened = join(null, 'send', t0 + 50_000, ROOM, t0 + 60_000) as { ok: true; state: RoomState };
  ok(reopened.ok && expired(reopened.state, t0 + 60_000), 'reopening a room with the same ticket does not extend its life');
  ok((join(null, 'send', t0, ROOM, t0 + 10 * ROOM.maxMs) as any).state.until === t0 + ROOM.maxMs, 'a room never lives longer than its own limit, whatever the ticket says');
  ok(message(jr.state, 1000, t0 + 1).ok, 'normal messages are forwarded');
  ok((message(jr.state, ROOM.maxMessage + 1, t0 + 1) as any).error === 'too-big', 'an oversized message closes the room');
  ok((message({ ...jr.state, bytes: ROOM.maxBytes - 10 }, 11, t0 + 1) as any).error === 'limit', 'the room stops at its byte limit');
  ok((message(jr.state, 10, t0 + ROOM.maxMs) as any).error === 'expired', 'messages after expiry close the room');
  ok(LIMITS.chunk + 64 < ROOM.maxMessage && LIMITS.maxTotal * 1.05 < ROOM.maxBytes, 'the client chunk and total fit the relay limits with overhead');
  ok(Math.ceil(LIMITS.maxTotal / LIMITS.chunk) * 1.5 < ROOM.maxMessages, 'a full-size transfer (chunks and acknowledgements) fits the per-room message cap');
  ok((message({ ...jr.state, msgs: ROOM.maxMessages }, 10, t0 + 1) as any).error === 'limit', 'a room stops after its message cap');

  console.log('daily budget');
  const day = Date.UTC(2026, 10, 15, 10);
  let b = spend(null, 'room', 0, day, BUDGET, 'a');
  ok(b.ok && b.state.rooms === 1 && b.state.day === '2026-11-15', 'the first room of the day is allowed');
  let st = { ...b.state, rooms: BUDGET.roomsPerDay };
  ok(!spend(st, 'room', 0, day).ok, 'rooms past the daily cap are refused (attempts count, finished or not)');
  ok(spend(st, 'room', 0, Date.UTC(2026, 10, 16, 0, 0, 1)).ok, 'the room count starts again the next UTC day');
  st = { ...b.state, bytes: BUDGET.bytesPerDay - 100 };
  ok(spend(st, 'bytes', 100, day).ok && !spend(st, 'bytes', 101, day).ok, 'bytes past the daily cap are refused');
  const r1 = message({ ...jr.state, bytes: 0, allowance: 0 }, 1000, t0 + 1) as any;
  ok(r1.ok && r1.reserve === BUDGET.block, 'a room reserves a block from the budget before forwarding its first bytes');
  const r2 = message({ ...jr.state, bytes: 1000, allowance: BUDGET.block }, 1000, t0 + 1) as any;
  ok(r2.ok && r2.reserve === 0, 'within its allowance a room forwards without asking the budget');
  // hibernation forgets a room's memory: waking it from storage must not let it reuse a reservation it had partly used
  // (the room's storage rules, as in worker/index.ts: stored on a reservation, every 4 MB and every 64 messages)
  {
    let stored: RoomState = { ...jr.state, bytes: 0, msgs: 0, allowance: 0 }, reserved = 0, forwarded = 0;
    for (let wake = 0; wake < 10; wake++) {
      let st = restore(stored);
      for (let k = 0; k < 3; k++) {
        const m = message(st, 1 << 20, t0 + 1) as { ok: true; state: RoomState; reserve: number };
        if (m.reserve) { reserved += m.reserve; st = { ...m.state, allowance: st.allowance + m.reserve }; stored = st; }
        else { const prev = st; st = m.state; if (Math.floor(st.bytes / (4 << 20)) !== Math.floor(prev.bytes / (4 << 20)) || st.msgs % 64 === 0) stored = st; }
        forwarded += 1 << 20;
      }
    }
    ok(reserved >= forwarded, `waking from hibernation never forwards more than was reserved from the budget (${forwarded >> 20} MiB forwarded, ${reserved >> 20} MiB reserved)`);
  }
  let cs = null as ReturnType<typeof spend>['state'] | null;
  for (let i = 0; i < BUDGET.roomsPerClient; i++) cs = spend(cs, 'room', 0, day, BUDGET, 'a').state;
  ok(!spend(cs, 'room', 0, day, BUDGET, 'a').ok && spend(cs, 'room', 0, day, BUDGET, 'b').ok, 'one client can\'t use up everyone\'s rooms; others still get theirs');
  ok(spend(cs, 'room', 0, Date.UTC(2026, 10, 16, 0, 0, 1), BUDGET, 'a').ok, 'a client\'s room count starts again the next UTC day');
  const ka = await clientKey('203.0.113.7', '2026-11-15');
  ok(ka === (await clientKey('203.0.113.7', '2026-11-15')) && ka !== (await clientKey('203.0.113.7', '2026-11-16')) && !ka.includes('203'), 'clients are counted under a daily hash, never their address');
}

/** against a running relay (wrangler dev): RELAY_URL=http://127.0.0.1:8788 with short test deadlines (PAIR_MS=3000,
 *  MAX_MS=8000, as in .claude/launch.json "relay-test"). Real WebSockets, real Durable Object. */
async function relay(base: string) {
  console.log(`\nrelay at ${base}`);
  const origin = new URL(base).origin, wsBase = origin.replace(/^http/, 'ws');
  type Ctl = { t: string; code?: string; peer?: boolean; on?: boolean };
  const fresh = async (o: string = origin) => { const r = await fetch(`${origin}/relay/new`, { method: 'POST', headers: { Origin: o } }); if (!r.ok) throw new Error(`relay/new ${r.status}`); return (await r.json()) as { room: string; send: string; recv: string }; };
  const tickets = new Map<string, { send: string; recv: string }>();
  const newRoom = async () => { const f = await fresh(); tickets.set(f.room, f); return f.room; };
  const sock = (room: string, role: string, o: string = origin, t = (tickets.get(room) as any)?.[role] ?? '') => new Promise<{ ws: WebSocket; ctl: Ctl[]; data: Uint8Array[]; closed: Promise<number> }>((res, rej) => {
    const ws = new (WebSocket as any)(`${wsBase}/relay/${room}?role=${role}&t=${encodeURIComponent(t)}`, { headers: { Origin: o } }) as WebSocket;
    ws.binaryType = 'arraybuffer';
    const ctl: Ctl[] = [], data: Uint8Array[] = [];
    let closedRes: (c: number) => void;
    const closed = new Promise<number>((r) => (closedRes = r));
    ws.onmessage = (e) => { if (typeof e.data === 'string') ctl.push(JSON.parse(e.data)); else data.push(new Uint8Array(e.data)); };
    ws.onclose = (e) => closedRes(e.code);
    ws.onopen = () => res({ ws, ctl, data, closed });
    ws.onerror = () => rej(new Error('socket error'));
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (f: () => boolean, ms = 4000) => { for (let i = 0; i < ms / 20 && !f(); i++) await wait(20); return f(); };

  // refused: a phone without a room, a page from another site, a room without a genuine ticket
  const lone = await sock(await newRoom(), 'recv');
  ok((await lone.closed) === 4404 && lone.ctl[0]?.code === 'no-room', 'a phone cannot open a room on the relay');
  let foreign = false;
  try { const f = await sock(await newRoom(), 'send', 'https://evil.example'); f.ws.close(); } catch { foreign = true; }
  ok(foreign, 'a page from another origin is refused by the relay');
  ok((await fetch(`${origin}/relay/new`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status === 403, 'another site cannot get a ticket');
  ok((await fetch(`${origin}/relay/new`, { headers: { Origin: origin } })).status === 405, 'tickets are only issued for a POST');
  const made = await sock(newRoomId(), 'send', origin, '');
  ok((await made.closed) === 4410 && made.ctl[0]?.code === 'expired', 'a made-up room without a ticket is refused (by the Worker, before any room)');
  const real = await fresh(), other = await fresh();
  const stolen = await sock(other.room, 'send', origin, real.send);
  ok((await stolen.closed) === 4410, 'a ticket for one room does not open another');
  const forged = await sock(real.room, 'send', origin, real.send.replace(/^\d+/, (d) => String(+d + 60)));
  ok((await forged.closed) === 4410, 'a ticket with an extended expiry is refused');
  const usurp = await sock(real.room, 'send', origin, real.recv);
  ok((await usurp.closed) === 4410, 'the phone\'s ticket (from the QR code) cannot connect as the desktop');
  // a text frame (clients only send binary) ends the room instead of slipping past the message cap
  const rt = await newRoom();
  const ts = await sock(rt, 'send'), tp = await sock(rt, 'recv');
  ts.ws.send('hello');
  ok((await ts.closed) === 4422 && (await tp.closed) === 4422, 'a text frame closes the room for both');

  // a full transfer through the relay, with a drop and resume in the middle
  const keyText = newKeyText(), key = await importKey(keyText), room = await newRoom();
  const map = rand(2 * 1024 * 1024 + 333), save = rand(700_000);
  const manifest: Manifest = { v: 1, city: 'Relay', files: [{ kind: 'map', name: 'r.cslmap.gz', size: map.length }, { kind: 'save', name: 'r.crp', size: save.length }] };
  let done = null as { blob: Blob }[] | null;
  const sender = new Sender(key, manifest, [new Blob([map as BlobPart]), new Blob([save as BlobPart])]);
  const receiver = new Receiver(key, await newDeviceKeys(), { done: (f) => (done = f) });
  const wireOf = (ws: WebSocket): Wire => ({ send: (b) => { if (ws.readyState === 1) ws.send(b as Uint8Array<ArrayBuffer>); } });
  const desk = await sock(room, 'send');
  desk.ws.onmessage = (e) => { if (typeof e.data !== 'string') void sender.receive(new Uint8Array(e.data)); else desk.ctl.push(JSON.parse(e.data)); };
  sender.attach(wireOf(desk.ws));
  let phone = await sock(room, 'recv');
  let seen = 0;
  const hook = (p: Awaited<ReturnType<typeof sock>>, dropAfter: number) => {
    p.ws.onmessage = (e) => {
      if (typeof e.data === 'string') return p.ctl.push(JSON.parse(e.data));
      if (++seen === dropAfter) { p.ws.close(); return; } // the phone locks mid-transfer: this chunk is lost with the socket
      void receiver.receive(new Uint8Array(e.data));
    };
  };
  hook(phone, 4);
  await receiver.attach(wireOf(phone.ws));
  ok(await until(() => phone.ws.readyState === 3), 'the phone dropped mid-transfer (simulated lock)');
  ok(await until(() => desk.ctl.some((c) => c.t === 'peer' && c.on === false)), 'the desktop is told the phone left');
  phone = await sock(room, 'recv');
  hook(phone, Infinity);
  await receiver.attach(wireOf(phone.ws));
  ok(await until(() => !!done, 8000), 'the transfer resumes through the relay and completes');
  ok(!!done && (await same(done![0].blob, map)) && (await same(done![1].blob, save)), 'map and save arrive intact through the relay');
  ok(await until(() => sender.done), 'the desktop learns the phone has it');
  desk.ws.close(); phone.ws.close();

  // a second desktop socket replaces the first; the pairing window and the hard limit close rooms
  const r2 = await newRoom();
  const a = await sock(r2, 'send'), b = await sock(r2, 'send');
  ok((await a.closed) === 4409 && a.ctl.some((c) => c.code === 'replaced'), 'a reconnecting desktop replaces its old socket');
  const late = await (async () => { await wait(3300); return sock(r2, 'recv'); })();
  // once the pairing window passes the room is gone: a late phone hears no-room (or expired, if it raced the alarm)
  ok([4404, 4410].includes(await late.closed) && late.ctl.some((c) => c.code === 'no-room' || c.code === 'expired'), 'the phone cannot join after the pairing window');
  // the room's error message is what the page acts on; the emulator may leave the socket in CLOSING after it
  ok(await until(() => b.ctl.some((c) => c.code === 'expired') && b.ws.readyState >= 2, 3000), 'the waiting desktop is told the room expired');
  const r3 = await newRoom();
  const s3 = await sock(r3, 'send'), p3 = await sock(r3, 'recv');
  ok(await until(() => s3.ctl.some((c) => c.t === 'peer' && c.on === true)), 'the desktop sees the phone join');
  ok(await until(() => p3.ctl.some((c) => c.code === 'expired') && s3.ctl.some((c) => c.code === 'expired') && p3.ws.readyState >= 2 && s3.ws.readyState >= 2, 9500), 'a paired room still closes at the hard limit');
  // reopened after everyone left, with the same tickets: still closes when the tickets expire (MAX_MS after issue), not
  // MAX_MS after reopening. The worker hands the room the checked expiry.
  const rr = await newRoom(), issued = Date.now();
  (await sock(rr, 'send')).ws.close();
  await wait(4500);
  const rs = await sock(rr, 'send'), rp = await sock(rr, 'recv');
  ok(await until(() => rp.ctl.some((c) => c.code === 'expired'), 6000) && Date.now() - issued < 8000 + 2500, `a reopened room still closes when its tickets expire (after ${((Date.now() - issued) / 1000).toFixed(1)} s)`);
  rs.ws.close(); rp.ws.close();
  // a phone reconnecting replaces its old socket; the old socket's close arrives later and must not tell the desktop the
  // phone left (the desktop would pause and the transfer would stall)
  const r6 = await newRoom();
  const s6 = await sock(r6, 'send'), p6a = await sock(r6, 'recv');
  ok(await until(() => s6.ctl.some((c) => c.t === 'peer' && c.on)), 'the desktop sees the phone');
  const p6b = await sock(r6, 'recv');
  await p6a.closed; await wait(500);
  const peers = s6.ctl.filter((c) => c.t === 'peer');
  ok(peers.length >= 2 && peers[peers.length - 1].on === true, `after a phone reconnects the desktop still sees it (${peers.map((c) => (c.on ? 'on' : 'off')).join(', ')})`);
  s6.ws.close(); p6b.ws.close();
  // an oversized message closes the room for both
  const r4 = await newRoom();
  const s4 = await sock(r4, 'send'), p4 = await sock(r4, 'recv');
  s4.ws.send(new Uint8Array(ROOM.maxMessage + 1));
  ok((await p4.closed) === 4413 && (await s4.closed) === 4413, 'an oversized message closes the room');
}

/** against a relay started with tiny daily caps (ROOMS_PER_DAY=3, BYTES_PER_DAY=3000000, a fresh state directory) */
async function budget(base: string) {
  console.log(`\nrelay budget at ${base}`);
  const origin = new URL(base).origin, wsBase = origin.replace(/^http/, 'ws');
  const tickets = new Map<string, { send: string; recv: string }>();
  const newRoom = async () => { const r = await fetch(`${origin}/relay/new`, { method: 'POST', headers: { Origin: origin } }); const f = (await r.json()) as { room: string; send: string; recv: string }; tickets.set(f.room, f); return f.room; };
  const sock = (room: string, role: string) => new Promise<{ ws: WebSocket; ctl: { t: string; code?: string }[]; closed: Promise<number> }>((res, rej) => {
    const ws = new (WebSocket as any)(`${wsBase}/relay/${room}?role=${role}&t=${encodeURIComponent(tickets.get(room)?.[role as 'send' | 'recv'] ?? '')}`, { headers: { Origin: origin } }) as WebSocket;
    ws.binaryType = 'arraybuffer';
    const ctl: { t: string; code?: string }[] = [];
    let cr: (c: number) => void; const closed = new Promise<number>((r) => (cr = r));
    ws.onmessage = (e) => { if (typeof e.data === 'string') ctl.push(JSON.parse(e.data)); };
    ws.onclose = (e) => cr(e.code); ws.onopen = () => res({ ws, ctl, closed }); ws.onerror = () => rej(new Error('socket error'));
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (f: () => boolean, ms = 4000) => { for (let i = 0; i < ms / 20 && !f(); i++) await wait(20); return f(); };
  // rooms: 3 allowed (attempts count even if nobody ever joins), the 4th refused as busy
  const opened = [];
  for (let i = 0; i < 3; i++) opened.push(await sock(await newRoom(), 'send'));
  await wait(300);
  ok(opened.every((o) => o.ctl.some((c) => c.t === 'joined')), 'rooms within the daily cap open (unused ones still count)');
  const fourth = await sock(await newRoom(), 'send');
  ok((await fourth.closed) === 4503 && fourth.ctl.some((c) => c.code === 'busy'), 'the room past the daily cap is refused as busy');
  // bytes: forwarding stops (busy) once the day's bytes are spent, even inside a room that is still open
  const a = opened[0], room = new URL(a.ws.url).pathname.split('/').pop()!;
  const p = await sock(room, 'recv');
  ok(await until(() => a.ctl.some((c) => c.t === 'peer')), 'the phone joins a budgeted room');
  let sent = 0;
  for (let i = 0; i < 16 && a.ws.readyState === 1; i++) { a.ws.send(new Uint8Array(256 * 1024)); sent += 256 * 1024; await wait(30); }
  ok(await until(() => a.ctl.some((c) => c.code === 'busy') && p.ctl.some((c) => c.code === 'busy'), 4000), `forwarding stops at the daily byte cap (after ${(sent / 1e6).toFixed(1)} MB sent)`);
  for (const o of opened) o.ws.close();
}

await unit();
if (process.env.RELAY_URL) await relay(process.env.RELAY_URL);
if (process.env.RELAY_BUDGET_URL) await budget(process.env.RELAY_BUDGET_URL);
if (failures) { console.error(`\n${failures} send-to-phone check(s) failed`); process.exit(1); }
console.log('\nsend-to-phone checks passed');
