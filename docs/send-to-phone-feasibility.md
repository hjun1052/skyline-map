# Send to Phone: feasibility study

Written 2026-11-15 against `main` at `ec6aa70` as a research study. **Option 1 (the encrypted relay) is now implemented** in `src/phone/` and `worker/`, off by default (see docs/send-to-phone-billing.md, "Switching it on"); see docs/architecture.md (Send to Phone) for what was built. The study below is unchanged.

**Question:** can a user who has a city open in Skyline Atlas on a desktop browser move it to their phone, ideally by scanning a QR code, with **zero additional monetary cost**, no accounts, no permanent server storage, working on iOS Safari, for files up to the size of a large `.cmm.gz`?

**Short answer:** yes, with one honest caveat. The only approach that works on *every* network pair (same Wi-Fi, Wi-Fi to cellular, restrictive school Wi-Fi) without paying for anything is an **end-to-end-encrypted streaming relay on the project's own Cloudflare account** (a Worker plus a Durable Object that forwards encrypted chunks between the two browsers and never stores them). It is free only while the account stays on the **Workers Free plan**, where going over a limit makes requests fail instead of billing. That has to be confirmed on the account before anything is built (section 9). Pure peer-to-peer WebRTC is attractive for privacy and LAN speed, but without a TURN relay it fails on a meaningful share of real network pairs, and there is no TURN service that is free without an account and an overage-billing risk. AirDrop through the Web Share API is the simplest zero-infrastructure path, but it only works from Safari on a Mac to an iPhone.

How sure each statement is:
- **[measured]**: measured on the project's own files in this study (scripts in section 10).
- **[V]**: verified in an official document or source code, linked.
- **[R]**: reported by a credible third party (issue tracker, forum, vendor blog), not independently checked.
- **[E]**: my estimate or reasoning.
- **[U]**: uncertain. I could not verify it; treat it as an open question.

---

## 1. What the codebase does today

### Loading pipeline
- **Entry points** (`src/main.ts`): `openFile(f)` (file picker, drag and drop) and `openRecent(r)` (a city kept in this browser). Both read the file into an `ArrayBuffer` and transfer it to the worker with `worker.postMessage({ type: 'load', buffer }, [buffer])`. The sample city and dev `/api/maps` take the same path.
- **Worker** (`src/worker.ts` `readCity`):
  1. Gunzip when the bytes start with gzip magic.
  2. Pick the reader:
     - a ZIP is read as `.vellummap` (`src/vellummap.ts`);
     - JSON starting with `schema_version: "cmm-…"` is read as `.cmm` (`src/cmm.ts`, which reads the district cells and skips the traffic snapshot before `JSON.parse`; see `docs/research/cmm-format.md`);
     - anything else is XML, a `.cslmap` (`src/parse.ts`).
  3. All readers produce one internal type, **`CityData`** (`src/parse.ts`):
     - nodes, segments, segment types (lanes), buildings, districts and parks, transit lines;
     - terrain, water and forest grids (`Float32Array` / `Uint8Array`);
     - `extras`, which holds format-specific facts such as exact one-ways (`Map`), TM:PE speeds (`Map`), the district grid (`Uint8Array`) and `.cmm` provenance.
- **Built map:** `buildCity(CityData)` (`src/build.ts`) makes the **`BuiltCity`** the page draws: GeoJSON sources, DEM, stop names, discoveries and search. The worker posts it to the main thread. The worker keeps `CityData`, the `Router` and the closure analyser for directions, travel-time areas and closures.
- **Save files (`.crp`):** loaded separately into the worker (`src/sim/`). The save must match the open map, checked by segment and node ids and geometry.

### Is the original file still around after loading? Yes.
- `pending = { blob: f, file: f.name }` keeps the `File` while it loads. On success it is stored **gzip-compressed** in IndexedDB as a recent city (`src/recent.ts`: `map: Blob`, plus `save?: { file, blob }` when a save was loaded over it). The last 5 cities are kept.
- **The desktop therefore already holds exactly what a phone would need:** the original map file, gzipped, plus the matching save, without re-reading anything. Sending that Blob reuses the phone's existing, tested open path (`openBuffer` → worker → `readCity`). The phone can even store it in its own recent cities.
- **Per-city user settings** (fares, toll prices: `localStorage['atlas:ctx:…']`) are small JSON and could travel with the map. Display preferences (`atlas:opts`, language, units) should stay per-device.

### How big each candidate payload is [measured]
Real files from the test fixtures: one city (서랑시) in all three formats, plus its matched save. Node 20 on an M-series Mac; gzip level 6, Brotli quality 5. "Clone" is V8's structured-clone serialisation, a stand-in for what an in-browser binary serialisation would roughly cost.

| | `.cslmap` | `.cmm.gz` | `.vellummap` | sample `.cslmap.gz` |
|---|---|---|---|---|
| File as the user has it | 20.4 MB (raw XML) | **11.7 MB** (gzip) | 6.2 MB (zip) | 5.1 MB (gzip) |
| Decompressed | 20.4 MB | 60.1 MB | 6.2 MB | 20.4 MB |
| **File gzipped** (what recent cities store) | **5.1 MB** | **11.6 MB** | **6.1 MB** | **5.1 MB** |
| File Brotli q5 | 4.5 MB | 10.0 MB | 6.1 MB | 4.5 MB |
| `CityData` clone / gzip | 18.0 / 5.3 MB | 25.9 / **6.4 MB** | 24.7 / 5.9 MB | 18.1 / 5.3 MB |
| `CityData` JSON / gzip | 23.6 / 5.2 MB | 39.9 / 6.3 MB | 40.0 / 5.9 MB | 23.6 / 5.2 MB |
| `BuiltCity` clone / gzip | 20.3 / 6.0 MB | 21.1 / 6.8 MB | 19.7 / 5.9 MB | 20.9 / 6.0 MB |
| Parse / build time (Node) | 225 / 842 ms | 866 / 992 ms | 247 / 1127 ms | 207 / 1026 ms |

The matched save `.crp` is 44.8 MB raw and **21.7 MB gzipped** [measured]. Sending the save often costs more than sending the map.

**What this shows:**
- **Sending parsed data is not smaller in general.** For `.cslmap` and `.vellummap` the gzipped original is as small as, or smaller than, any parsed representation. Sending `BuiltCity` (what the page draws) is never smaller.
- **`.cmm` is the exception.** Its parsed `CityData` gzips to 6.4 MB against 11.7 MB for the file, because the file carries data the app discards: 26 MB of district cell lists (`grid_points`) and a TM:PE traffic snapshot that nothing reads.
- **Phone-side memory only improves a little** [measured]. Rebuilding the map from that `CityData` instead of reading the `.cmm.gz` brought:
  - peak RSS down from about 540 MB to about 455 MB (2 runs each), roughly −17%;
  - read time down from about 0.78 s to about 0.33 s.

  Building the map (`buildCity`), not parsing, dominates the peak.
- **Brotli would save 10–15%,** but browsers can't produce it: `CompressionStream('brotli')` is in Firefox 147 and Safari 18.4, not Chrome [V] ([MDN BCD](https://github.com/mdn/browser-compat-data/blob/main/api/CompressionStream.json)). gzip is the only format compressed and decompressed natively everywhere.

**Verdict on a new transfer format:** **not justified at first.** Sending the original gzipped file:
- needs no new format;
- keeps the phone's recent cities, time-lapse and save matching identical to the desktop's;
- can't drift from the reader code.

A compact `.cmm` → `CityData` encoding would roughly halve `.cmm` transfers and save about 17% of phone memory. It would also add a versioned format that both devices must agree on, and it doesn't cover the save. Keep it as a later optimisation if `.cmm` transfers turn out to dominate (section 8, Option 3).

### Memory on the receiving phone
- Opening the test `.cmm.gz` peaks at about **500–550 MB** in Node. Desktop Chromium's process memory rose about 0.8 GB while opening it (`docs/research/cmm-format.md`) [measured]. This is a cost of *opening* the map on a phone at all, independent of how it arrives.
- **iOS limits:**
  - Apple publishes no per-tab limit.
  - A WebKit engineer put the iPhone web content soft limit around **1.5 GB** [R] ([WebKit bug 194268](https://bugs.webkit.org/show_bug.cgi?id=194268)).
  - Kills at a **2 GB** hard limit were reported on a recent iPhone, confirmed as a memory kill by an Apple engineer [R] ([Apple forum 823061](https://developer.apple.com/forums/thread/823061)).
  - Older devices have less [E].
- **The transfer itself must not double the footprint.** Receive chunks into an array and build one `Blob` at the end (about 1× the file, 5–25 MB here). Or stream them straight into the existing open path. Never keep both decompressed copies.
- **Proposed experiment** (section 10, E1): open the large `.cmm.gz` on a real older iPhone (6 GB RAM or less) through the existing file picker. If it doesn't survive that, no transfer method helps.

---

## 2. Requirements a transfer method must meet

Derived from the brief and section 1:
- **Payload:** usually 5–12 MB (one gzipped map). Up to about 35 MB with a save. Design for 100 MB as a hard cap.
- **Cost and accounts:** zero recurring cost; no accounts; no storage beyond the transfer.
- **Browsers:** desktop Chrome, Edge, Safari and Firefox to iOS Safari and Android Chrome.
- **Flow:** one button on desktop, the native camera on the phone (the iOS Camera app opens URLs from QR codes; an in-page scanner isn't needed), then the map opens.
- **Must not affect existing features.** Today the site is **static assets only** (`wrangler.jsonc` has no Worker script). Any server part means adding one. Static asset requests stay free and unlimited and don't run the Worker [V] ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)), as long as the Worker only takes its own paths.

---

## 3. Architectures investigated

### A. WebRTC DataChannel, peer to peer

**How it would work:**
1. The desktop creates an `RTCPeerConnection` with a data channel.
2. The two browsers exchange an offer, an answer and ICE candidates (signaling).
3. The file is chunked over the channel.

**What is verified:**
- **iOS Safari support:** `RTCDataChannel`, `binaryType = 'arraybuffer'`, `bufferedAmount` and `bufferedAmountLowThreshold` all since Safari 11; `RTCSctpTransport.maxMessageSize` since 15.4 [V] ([MDN BCD](https://github.com/mdn/browser-compat-data/blob/main/api/RTCDataChannel.json)).
- **Message size:** Chrome and Safari negotiate a 256 KiB maximum; Firefox negotiates far more [V] ([W3C public-webrtc, Apr 2026](https://lists.w3.org/Archives/Public/public-webrtc/2026Apr/0029.html)).
- **Chunk size:** 16 KiB is the RFC recommendation while browsers lack message interleaving [V] ([RFC 8831 §6.6](https://www.rfc-editor.org/rfc/rfc8831)). 64 KiB is safe in every implementation [V] ([Mozilla](https://blog.mozilla.org/webrtc/large-data-channel-messages)). Use 64 KiB with `bufferedAmountLowThreshold` backpressure.
  - The official webrtc/samples file-transfer demo has **no backpressure**; don't copy it [V] ([main.js](https://github.com/webrtc/samples/blob/gh-pages/src/content/datachannel/filetransfer/js/main.js)).
- **Same Wi-Fi:** browsers hide local addresses behind random `.local` mDNS names, and peers on the same network resolve them by multicast. Two browsers can connect with host candidates only, no STUN [V] ([IETF draft](https://datatracker.ietf.org/doc/draft-ietf-mmusic-mdns-ice-candidates/)). This **fails on networks that block multicast or isolate clients from each other**, which is common on guest, school and enterprise Wi-Fi [R].
- **Free STUN:** `stun.cloudflare.com:3478` is documented as "free and unlimited" [V] ([Cloudflare TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/)). Google's `stun.l.google.com:19302` is widely used but has no published terms [U].

**What is not solvable for free:**
- **Pairs that need a relay.** Historically about 22% of WebRTC conferences needed a TURN relay and about 9% needed TCP [V, 2015–16 data] ([webrtcHacks](https://webrtchacks.com/usage-stats/)). Vendors still quote "~20%" [R]. There is no recent large public figure [U].
  - Carrier-grade NAT on cellular varies [R].
  - Networks that block UDP (some school and guest Wi-Fi) defeat STUN entirely; only TURN over TCP or TLS on port 443 gets through [V] ([Tailscale](https://tailscale.com/blog/how-nat-traversal-works)).
- **TURN options:**
  - **Cloudflare Realtime TURN:** 1,000 GB/month free, then **$0.05/GB billed** [V] ([pricing](https://developers.cloudflare.com/realtime/pricing/)). Credentials must be minted server-side with an API token [V]. No TCP relaying [V]. Whether the free tier needs a card is unclear [U].
  - **Metered Open Relay:** 20 GB/month, with a free account and an API key [V] ([page](https://metered.ca/tools/openrelay/)).
  - Both need an account, and Cloudflare's bills overage, so neither strictly meets "no paid infrastructure". 20 GB/month also doesn't scale.
- **iOS lifecycle:** WebRTC in iOS Safari is reported to be **suspended when the screen locks or Safari goes to the background** [R] ([Apple forum 774239](https://developer.apple.com/forums/thread/774239)). For native apps, Apple DTS confirms that networking stops on suspension [V] ([799259](https://developer.apple.com/forums/thread/799259)).
- **iOS reliability:** a November 2025 W3C post reports Safari/iOS DataChannel transfers of a few MB failing frequently. An Apple WebKit engineer called it "an implementation restriction or a bug" [R] ([post](https://lists.w3.org/Archives/Public/public-webrtc/2025Nov/0021.html), [reply](https://lists.w3.org/Archives/Public/public-webrtc/2025Nov/0022.html)). PairDrop and PeerJS have open iOS issues: messages not received, failure on 4G, failure on an iPhone hotspot [R] ([PeerJS #786](https://github.com/peers/peerjs/issues/786), [#824](https://github.com/peers/peerjs/issues/824), [#1302](https://github.com/peers/peerjs/issues/1302); [PairDrop #410](https://github.com/schlagmichdoch/PairDrop/issues/410)).

**Signaling options compared:**

| Signaling | Verdict |
|---|---|
| **QR only (offer in one QR, answer back in another)** | Works in principle. A data-channel offer is about 2.5 KB raw. Aggressive custom encoding gets it to about 55–100 B [R] ([write-up](https://magarcia-io.pages.dev/air-gapped-webrtc-breaking-the-qr-limit)). Version-40-L QR holds 2,953 bytes [V] ([Thonky](https://www.thonky.com/qr-code-tutorial/character-capacities)). The phone's *answer* must still get back to the desktop: either the phone shows a QR to the desktop's webcam (many desktops have none, and it's awkward), or the user types a code. Fragile UX; rejected as the main path. |
| **Manual pairing code** | Same return-path problem, unless a relay carries the SDP, at which point the code is just a room id. |
| **PeerJS public cloud** | Free, donation-funded, no SLA. Its own docs recommend self-hosting for production [V] ([PeerServer](https://peerjs.com/peerserver.html)). Multi-minute connection delays were reported while the status page showed green [R] ([#1350](https://github.com/peers/peerjs/issues/1350)). Rejected: the core flow would depend on a third party. |
| **Public MQTT, Nostr or WebTorrent trackers** (as Trystero uses) | Shared services with no guarantee [V] ([mqtt.org](https://github.com/mqtt/mqtt.org/wiki/public_brokers)). Reported drops on public trackers [R]. Rejected for the same reason. |
| **Firebase Spark** | Free, no card, 100 simultaneous Realtime Database connections [V] ([pricing](https://firebase.google.com/pricing)). Adds a Google account and project, plus a second provider. Possible, but there is no reason to prefer it over the project's own Cloudflare account. |
| **Own Worker + Durable Object** (WebSocket room) | A few kilobytes per pairing, on infrastructure the project already deploys to. SQLite-backed Durable Objects are on the Workers Free plan [V] ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). **Best signaling choice.** |

**Verdict:** WebRTC is the right *fast path* on a shared network and the most private, because data never touches a server. It is **not reliable enough as the only path** without a relay, and the free relays don't truly meet the constraints. See D for the relay that does.

### B. Temporary server-side storage (upload, then download within 5 minutes)

| Store | Fit for 5–100 MB, 5-minute expiry, zero cost |
|---|---|
| **Cloudflare R2** | Free tier of 10 GB-month, 1M writes, 10M reads; egress free [V] ([pricing](https://developers.cloudflare.com/r2/pricing/)). But **lifecycle expiry works in days**, with deletion "typically within 24 hours" [V] ([lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)), so 5 minutes needs your own deletion code. **Enabling R2 goes through a checkout and very likely needs a card** [R/U]. **Overage is billed automatically, with no spending cap yet** (spend limits cover only Workers and Durable Objects) [V] ([changelog](https://developers.cloudflare.com/changelog/post/2026-11-13-spend-management/)). **Rejected: it can cost money.** |
| **Workers KV** | 25 MiB per value, so a file needs several keys; 1,000 writes/day and 1 GB stored on Free; minimum TTL 60 s [V] ([KV limits](https://developers.cloudflare.com/kv/platform/limits/)). Workable for small transfers, but it stores the map at rest on the provider, and the daily write cap allows only about 300 three-key transfers. Inferior to D. |
| **Durable Object SQLite storage** | 5 GB per account on Free, 8 MB per row [V] ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). Possible, but it stores data at rest for no benefit over streaming it through (D). |
| **Free public upload hosts** (tmpfiles.org: 100 MB, 1 h default; Litterbox: 1 GB, 1 h minimum; both allow cross-origin uploads [V]) | Zero cost, no account. But user maps go to an unaffiliated host with unread terms of service [U], files can be retained for an hour or more, and the service can vanish without notice (file.io's API was retired in 2025 [V]). End-to-end encryption would hide the contents, but not the dependency or the terms risk. **Rejected for production.** |

**Workers request limits that matter:**
- A request body of up to 100 MB is accepted on Free and Pro zones [V] ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
- A Worker on Free has **10 ms of CPU per request**. Streaming a body through is fine; buffering or hashing 60 MB inside a Worker probably is not [E].

**Verdict:** a store-and-forward design adds retention and expiry problems that a relay doesn't have, and the one Cloudflare store built for large files (R2) can bill. **Not recommended.**

### C. Same-network transfer without a backend

- A web page **cannot listen for connections.** Listening sockets exist only through Direct Sockets in Chrome Isolated Web Apps [V] ([Chrome docs](https://developer.chrome.com/docs/iwa/direct-sockets)). There is no LAN discovery API.
- Chrome's Local Network Access puts requests from public pages to private addresses behind a permission prompt [V] ([Chrome blog](https://developer.chrome.com/blog/local-network-access)). It's irrelevant anyway: the phone browser has nothing to connect to.
- **The only browser-to-browser LAN path is WebRTC with mDNS host candidates (A),** and it still needs signaling.
- Anything with real discovery (Bluetooth, NFC, a local server) needs a native app or an extension.
- Web Bluetooth and Web NFC are not in Safari [V] ([WebKit tracking prevention](https://webkit.org/tracking-prevention/)).

**Verdict:** there is no backend-free LAN option in ordinary browsers. "Same Wi-Fi" is just the easy case of A.

### D. Encrypted streaming relay on the project's own Worker (the option that meets every constraint)

**Idea:** a Durable Object per transfer room accepts two WebSockets, one from the desktop and one from the phone, and **forwards binary messages from one to the other as they arrive**.
- **Nothing is written to storage.** The object lives only for the transfer.
- **The map is encrypted in the browser before it leaves:** AES-GCM via WebCrypto, with a random 256-bit key. The key travels only in the QR code's URL fragment (`#k=…`), which browsers never send to servers. Cloudflare relays ciphertext it cannot read.
- To the network it looks like an ordinary `wss://` connection on port 443, which works through NAT, cellular and UDP-blocking Wi-Fi alike.

**Verified limits that shape it** (all [V], [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)):
- Durable Objects on Workers Free: SQLite-backed only. Daily: 100,000 requests and 13,000 GB-s of duration (at 128 MB per object, about 28 object-hours a day [E]).
- Incoming WebSocket messages bill at **20:1**: 100 messages count as 5 requests.
- A WebSocket message can be at most **32 MiB** (incoming).
- **Over a Free daily quota, operations fail with an error and nothing is billed.** It resets at 00:00 UTC.
- Workers egress and bandwidth are free on every plan [V] ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).

**Cost of one transfer on the Free plan [E]:**
- A 12 MB `.cmm.gz` (plus 16 bytes of tag per chunk) in 256 KiB chunks is about 48 messages, about 3 billed requests, plus a few for the room.
- A 30-second transfer uses 0.125 GB × 30 s, about 4 GB-s.
- The free day therefore covers roughly **3,000 such transfers**. Far beyond plausible use, and the failure mode past that is "try tomorrow", not a bill.

**Caveats:**
- **Plan matters.** On **Workers Paid** ($5/month minimum), usage beyond what the plan includes is billed. The Nov 2026 spend-limit beta caps Workers and Durable Objects [V], but still needs to be set up. **Confirm the account is on Workers Free and keep it there** (section 9).
- **Terms of service:** Cloudflare may limit using "the CDN without such Paid Services" for disproportionately large files; it names the Developer Platform among those services [V] ([service-specific terms](https://www.cloudflare.com/service-specific-terms-application-services/)). A Worker relaying WebSocket data is Developer Platform use, not cached CDN use, so this should be fine [E/U]. Not a legal opinion.
- **No server-side backpressure signal.** Whether a Durable Object can observe a WebSocket's send buffer is [U]. Design application-level flow control: the receiver acknowledges every N chunks and the sender keeps at most M unacknowledged. This bounds memory in the 128 MB object regardless.
- **The map passes through Cloudflare's network,** encrypted. This is weaker than pure peer to peer, but it is never stored and never readable without the key in the fragment.

**Verdict:** **the only design that meets every constraint on every network pair.** Its cost is a small Worker plus a Durable Object class, and keeping the account on the Free plan.

### E. Other alternatives

- **AirDrop through the Web Share API ("Share…" button):**
  - Safari on macOS shares files with no type allow-list in WebKit's `Navigator::share` [V] ([source](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/Navigator.cpp)). The share sheet should offer AirDrop [E/U, test on a Mac].
  - **Chrome rejects `.gz`, `.cmm` and unknown types** (allow-list in [share_service_impl.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/webshare/share_service_impl.cc)) and **caps a share at 50 MiB** [V for Chromium 140]. Disguising the file as `.txt` might pass, but it's a hack [U].
  - Firefox desktop has no Web Share [V] ([MDN BCD](https://github.com/mdn/browser-compat-data/blob/main/api/Navigator.json)).
  - On the iPhone (iOS 17+) an AirDropped file lands in Files → Downloads [R] ([Apple forum 737971](https://developer.apple.com/forums/thread/737971)). The user then opens the site and picks it.
  - **iOS Safari ignores extensions in `accept`** [V] ([caniuse](https://caniuse.com/input-file-accept)). The site's picker must not filter by extension on iOS, or the file appears greyed out [R].
  - **Zero infrastructure and simple, but Apple-to-Apple, Safari-only, and with no QR.**
- **"Open the site on the phone, pick the file" with a QR code to the site:** zero work beyond showing a QR code. It only helps when the file is already on the phone (iCloud Drive, AirDrop, a messenger). A useful fallback hint, not a transfer.
- **Animated QR / fountain codes** (e.g. cimbar, about 106 KB/s self-reported [V]): 5 MB takes about a minute, 60 MB about 10 minutes [E]. The reference receiver is an Android app, not iOS Safari. **Rejected.**
- **WebTorrent:** WebRTC plus a public tracker for signaling [V] ([FAQ](https://github.com/webtorrent/webtorrent/blob/master/docs/faq.md)). Nothing over A plus own signaling. **Rejected.**
- **Send less data ("viewer-only" payload):** a phone that only *views* could get pre-built vector tiles or the `BuiltCity`. At 6.0–6.8 MB gzipped [measured] that is no smaller, and it breaks directions, closures, travel-time areas and save matching. **Rejected.**
- **A Home Screen web app on the phone:** doesn't change the transfer. It does exempt the site's storage from Safari's 7-day cap [V] ([WebKit](https://webkit.org/blog/14403/updates-to-storage-policy/)), so a transferred map stays in recent cities. Worth mentioning in the receive UI later.

---

## 4. Reliability by scenario

Key: ✅ works, ⚠️ works with conditions, ❌ fails. "P2P" is A with own signaling and STUN, without TURN; "Relay" is D; "Hybrid" is P2P first, then the relay; "AirDrop" is E's Web Share path.

| # | Scenario | P2P | Relay | Hybrid | AirDrop |
|---|---|---|---|---|---|
| 1 | MacBook + iPhone, same Wi-Fi | ✅ usually; ❌ on client-isolated Wi-Fi | ✅ | ✅ (P2P, fast) | ✅ (Safari only) |
| 2 | Mac on Wi-Fi, iPhone on cellular | ⚠️ depends on NATs; a minority fail [E] | ✅ | ✅ | ✅ (AirDrop doesn't need Wi-Fi) |
| 3 | Different Wi-Fi networks | ⚠️ as above | ✅ | ✅ | ❌ unless physically near |
| 4 | Restrictive school or public Wi-Fi (UDP blocked) | ❌ | ✅ (wss on 443) | ✅ (falls back) | ⚠️ (AirDrop may be disabled by policy) |
| 5 | iOS Safari, little free memory | ⚠️ the opening is the risk, not the transfer | same | same | same |
| 6 | Large `.cmm.gz` (12 MB; 100 MB cap) | ✅ | ✅ (chunked under 32 MiB) | ✅ | ✅ Safari; ❌ Chrome over 50 MiB or `.gz` |
| 7 | Transfer interrupted halfway | ⚠️ needs resume-from-offset | ⚠️ needs resume (same design) | ⚠️ same | ✅ (OS retries) |
| 8 | Desktop tab in the background | ⚠️ background tabs throttle timers, not WebSockets or DataChannels; send must be event-driven [E] | ⚠️ same | ⚠️ same | ✅ |
| 9 | Phone locks during transfer | ❌ suspended [R]; resume after unlock | ❌ socket dropped; resume after unlock | same | ✅ |
| 10 | Several transfers at once | ✅ (independent) | ✅ (one object per room; Free quotas are daily, not concurrent) | ✅ | ✅ |

**Mitigations every web-based option needs:**
- Screen Wake Lock on the phone while receiving.
- A "keep this screen open" note.
- Chunk sequence numbers, with resume from the last acknowledged offset on reconnect. The desktop still holds the Blob, so it can re-send from any offset.
- A heartbeat to detect silent drops.
- A size cap (100 MB) checked before sending.

---

## 5. Security and privacy

- **QR contents:** `https://skyline.codz.me/receive#r=<room>&k=<key>`:
  - **room:** 128 bits of `crypto.getRandomValues`, base64url (22 characters), not guessable;
  - **key:** a 256-bit AES-GCM key (43 characters).
  - The fragment is never sent in HTTP requests, so the Worker sees only the room id, given separately on the WebSocket URL. The whole URL fits a small QR code (about 100 characters, version 5–6 at error-correction level M) [E from the Thonky tables].
- **End-to-end encryption:** AES-GCM per chunk with a counter nonce. The sender authenticates the chunk count and the file hash in a final message. A tampered or truncated transfer fails to decrypt instead of opening a corrupted map.
  - The same scheme also protects the P2P path, on top of DTLS. WebRTC DataChannels are already DTLS-encrypted end to end; the extra layer guards against a malicious signaling server swapping fingerprints [E].
- **Unauthorised downloads:**
  - The room accepts exactly one receiver. A second connection is refused.
  - The desktop shows "Phone connected", and can show a 2-digit confirmation derived from the key for the user to compare, if desired.
  - Without the key, a third party who guesses the room id gets only ciphertext.
- **Expiry and retention:**
  - The room closes when the transfer completes, 5 minutes after creation, or 60 s after the desktop disconnects. Enforce it with a Durable Object alarm.
  - Nothing is written to storage; ciphertext exists only in transit and in memory.
  - P2P never touches the server at all.
- **Abuse and resource exhaustion:**
  - Hard cap of 100 MB per room, counted at the object.
  - One sender and one receiver; idle timeout.
  - Optionally rate-limit room creation per IP with a cheap in-object counter. Cloudflare's own rate limiting rules may be a paid feature [U].
  - On the Free plan the worst case is the daily quota running out, which makes the feature unavailable until 00:00 UTC. It never costs money. Expose that state clearly ("Send to phone is busy, try later").
  - The relay is open to anyone who reads the code. Someone could misuse it as a generic encrypted pipe, but only within the same quotas [E].
- **Third parties:** with Hybrid or Relay, signaling and (when needed) ciphertext pass only through the project's own Cloudflare account. P2P uses Cloudflare STUN, which sees IP addresses but no data [E]. Avoid PeerJS cloud, public brokers and upload hosts: they would see metadata or data under terms the project doesn't control.

---

## 6. Decision matrix

Qualitative; no numbers invented. "Own Worker" means a Worker plus a Durable Object on the project's account, Workers Free plan.

| | P2P only (A + own signaling) | P2P + free TURN (Cloudflare or Metered) | Relay (D) | **Hybrid (A + D)** | AirDrop via Web Share (E) | Temporary storage (R2 / KV / upload host) |
|---|---|---|---|---|---|---|
| Added cost | None (Free plan) | TURN overage billed (Cloudflare) or 20 GB cap (Metered); accounts | None on Free (errors past quota) | None on Free | None | R2 can bill; KV small caps; hosts free but third-party |
| Infrastructure | Own Worker (signaling) | Own Worker + TURN account + credential minting | Own Worker | Own Worker | None | Storage + deletion jobs |
| Implementation complexity | Medium–high | High | **Low–medium** | High | **Very low** | Medium |
| Connection success | Good on LAN; a minority fail across networks; ❌ UDP-blocked | Near-universal (except TCP-only networks on Cloudflare) | **Near-universal** (wss 443) | **Near-universal** | Apple-to-Apple Safari only | Near-universal |
| Speed | Best on LAN | Relay-limited when relayed | Bounded by both uplinks via Cloudflare edge [E] | Best of both | Fast (AirDrop) | Upload + download time |
| Large files | ✅ with chunking | ✅ | ✅ (32 MiB messages, chunked) | ✅ | Safari ✅; Chrome ❌ over 50 MiB or `.gz` | ✅ (100 MB body cap) |
| iOS Safari | Works in foreground; reported flakiness [R] | Same | Works in foreground | Same | ✅ (native) | ✅ |
| Security / privacy | Best (never touches a server) | Good (TURN sees DTLS ciphertext) | Good (E2E; ciphertext transits Cloudflare) | Best when P2P, good when relayed | Good (local) | Weakest (data at rest) |
| Maintenance | WebRTC edge cases | + TURN credentials, quotas | Small | Largest | None | Expiry, abuse, terms |
| Scalability | Unlimited | TURN quota-bound | Free daily quota (thousands of transfers) | Relay used only on fallback | Unlimited | Quota-bound |
| UX | QR, but fails silently on some networks | QR | QR, predictable | QR, predictable | Share sheet, then Files, then pick | QR |
| Main failure modes | NAT, CGNAT, client isolation, iOS suspend | Billing risk, accounts | Phone locking; Free quota day | Complexity; phone locking | Non-Safari, Windows, Android | Retention, billing, third-party terms |

---

## 7. Is there a dominant design?

**Mostly, yes: the relay (D).** It is the only approach that is simultaneously zero-cost, account-free, storage-free and works on every network pair. Everything else either fails on some networks (P2P, AirDrop) or risks cost, retention or a third-party dependency (TURN, storage, upload hosts).

The **Hybrid** improves on D in two respects only:
- **Privacy:** data never leaves the LAN when P2P works.
- **Speed on a shared LAN.**

It is not more reliable than D; it falls back to it. **AirDrop** is not a competitor but a complement: nearly free to add for Safari-on-Mac users.

So the three recommended options below are genuinely different in *effort and scope*, but Options 1 and 3 share the same core. Option 3 is Option 1 plus a P2P fast path and a compact `.cmm` encoding.

---

## 8. Recommended options

### Option 1, best overall: E2E-encrypted relay on own Worker + Durable Object

```
Desktop (has map Blob)                    Cloudflare (own account, Workers Free)                 iPhone (Safari)
──────────────────────                    ──────────────────────────────────────                 ───────────────
[Send to phone] ─► key K, room R (random)
show QR: /receive#r=R&k=K   ─────────── user scans with Camera app ──────────────────────────────► opens /receive#r=R&k=K
wss /relay/R?role=send ─────────────────► Worker ─► Durable Object "Room R" ◄──── wss /relay/R?role=recv
                                                     (memory only; 1 sender + 1 receiver;
                                                      alarm closes after 5 min)
header {name,size,format,hash} (enc) ───► forward ───────────────────────────────────────────────► decrypt, check size ≤ cap
chunk 1..n: AES-GCM(K, 256 KiB) ────────► forward (no storage) ──────────────────────────────────► ack every N chunks
            ◄────────────────────────── forward ◄──────────────────────────────────────────────── acks (flow control)
done {count, hash} ─────────────────────► forward, close ────────────────────────────────────────► Blob → openBuffer() → map; save to recent cities
```

**User flow:**
1. Desktop: menu, then "Send to phone". A QR code appears, with "Scan with your phone's camera".
2. The phone opens the link: "Receiving 서랑시 (11.7 MB)…", with a progress bar and a "Keep this screen open" note.
3. The map opens on the phone and is saved in its recent cities. The desktop shows "Sent".

**Technologies:**
- WebSocket and WebCrypto (AES-GCM), which are standard everywhere.
- One Worker script with a Durable Object class (SQLite-backed, as Free requires), deployed with the existing `wrangler deploy`.
- A small QR encoder: for example Nayuki's single-file MIT QR generator, or `qrcode-generator` (MIT, about 20 KB) [E]. No other dependencies.

**Changes in the codebase:**
- `wrangler.jsonc`:
  - add `main` (the Worker script) and a `durable_objects` binding with a `new_sqlite_classes` migration;
  - keep `assets` as is, and route only `/relay/*` to the Worker. Static asset requests then stay free and never invoke it [V].
- `src/send-to-phone.ts` (new): the desktop sender (QR display, chunked encrypted send, flow control, resume) and the `/receive` handler, which collects chunks into a Blob and calls the existing `openBuffer` path (`src/main.ts`).
- `src/main.ts`:
  - a menu item, enabled when the current map came from a file or a recent city (there's a Blob to send);
  - the receive route;
  - storing the received map with `saveRecent`.
- **Payload:** the recent-city Blob (gzip) as is, plus optionally the save Blob and `atlas:ctx:<city>` settings, each with a size check and a toggle ("Include save file, +21.7 MB").
- i18n strings in EN, KO and RU.
- **No change to readers, `CityData`, router or simulation:** the phone opens the same bytes the desktop opened.

**Limitations:**
- The phone must stay unlocked with Safari in front. Resume covers short interruptions.
- It depends on the account staying on Workers Free. On the quota-exhausted day the feature is unavailable; it never bills.
- Ciphertext transits Cloudflare.

**Security:** section 5. 128-bit room id, 256-bit key in the fragment only, one receiver, 5-minute alarm, 100 MB cap, no storage.

**Testing:**
- Unit tests for chunking, encryption, flow control and resume, against a mocked socket.
- `wrangler dev` integration test with two headless browsers.
- Real-device matrix: iPhone Safari (newer and older devices), Android Chrome, against desktop Chrome, Safari, Firefox and Edge, across scenarios 1–4.
- Lock-the-phone and background-tab tests.
- A quota-exhaustion test (simulate the 1027 and failed-operation errors).

**Effort [E]:** about 2–3 days of implementation plus 1–2 days of device testing.

### Option 2, simplest MVP: "Share…" via Web Share, plus a QR code to the site

```
Desktop Safari: [Share map…] → navigator.share({ files: [map.cslmap.gz] }) → macOS share sheet → AirDrop
iPhone: AirDrop → Files/Downloads → scan QR (or open skyline.codz.me) → Open file → pick it → map
Other browsers: canShare() false → button hidden; show QR to the site + "AirDrop or message the file to yourself"
```

**User flow:**
- **Safari on a Mac:** "Share…", pick the phone in AirDrop, then on the phone open the site from the QR code and choose the file from Downloads.
- **Elsewhere:** a QR code to the site plus a hint to move the file however they like.

**Technologies:** Web Share Level 2 (`navigator.canShare({ files })`) and a QR encoder. No server.

**Changes:**
- A menu item shown only when `canShare` accepts the file.
- The phone's file input must **not** filter by extension on iOS, which greys out unmatched files [R]. Today's `#fileInput` (`index.html`) has no `accept` attribute, so this already holds; keep it that way.
- A short "how to" hint.

**Limitations:**
- Safari on a Mac to an iPhone only.
- Chrome rejects `.gz` and anything over 50 MiB [V].
- No Firefox desktop.
- Several manual steps on the phone.
- The save file is a second share.

**Security:** never leaves the user's devices. AirDrop's own security applies.

**Testing:**
- Real Mac Safari to iPhone, with `.cslmap.gz`, `.cmm.gz` and `.vellummap`.
- Confirm AirDrop appears in the sheet [U] and that the iOS picker accepts the file.

**Effort [E]:** about half a day.

### Option 3, most robust: Hybrid, P2P first, encrypted relay fallback, plus a compact `.cmm` payload

```
Desktop ──wss /relay/R (signaling first)── Durable Object ──wss── iPhone
   │  exchange offer/answer/ICE (STUN: stun.cloudflare.com; mDNS host candidates)
   ├─ DataChannel connects within ~5 s? ──► P2P: AES-GCM chunks over DTLS, never touches Cloudflare
   └─ else (NAT/CGNAT/UDP blocked/iOS refuses) ──► same room switches to relay mode (Option 1)
```

Same QR and flow as Option 1, so the user never sees which path was used.

**Technologies:** Option 1 plus `RTCPeerConnection` and DataChannel (64 KiB chunks, `bufferedAmountLowThreshold` backpressure), and Cloudflare STUN. **No TURN** (cost and accounts).

**Codebase changes:** as Option 1, plus:
- a WebRTC transport behind the same send/receive interface;
- the room protocol gains signaling messages and a "switch to relay" message.

Optionally, a **compact `.cmm` payload:** a versioned binary or JSON-and-gzip encoding of `CityData`, with tagged `Map`/`Set`/typed arrays. It is 6.4 MB instead of 11.7 MB [measured], and parses in 0.33 s instead of 0.78 s with about 17% lower peak memory on the phone [measured]. It needs a format version and a fallback to the original file when versions differ. The phone could then store it as a new recent-city kind.

**Limitations:**
- The most code.
- WebRTC on iOS has reported reliability issues [R], which is exactly why the relay stays.
- The phone still must stay unlocked.

**Security:** as Option 1. On P2P, data never touches a server. Signaling is protected by the fragment key (sign the SDP fingerprints with K).

**Testing:** Option 1's matrix, plus forcing each path:
- block UDP to force the relay;
- client-isolated Wi-Fi;
- cellular;
- measure how often P2P succeeds in practice (experiment E4).

**Effort [E]:** about 5–7 days plus device testing. Add about 2 days for the compact `.cmm` payload.

---

## 9. Recommendation

1. **Build Option 1 (the encrypted relay) first.**
   - It is the only design meeting every constraint across all ten scenarios, short of a locked phone, which no web approach survives.
   - It reuses the project's own Cloudflare deployment and the app's existing open path unchanged.
   - It adds one small Worker and Durable Object, and no new data format.
2. **Add Option 2's "Share…" button alongside it if it's cheap.** It is the nicest path for Safari-on-Mac users and costs almost nothing. It isn't the main path because it fails everywhere else.
3. **Treat Option 3's P2P fast path as a later upgrade,** justified only if relayed traffic or privacy feedback warrants it. The relay must stay as the fallback either way.
4. **Don't build a new transfer format now.** The gzipped original is the right payload for `.cslmap` and `.vellummap`. A compact `.cmm` encoding is a measured but modest win (about half the bytes, about 17% less phone memory) to revisit later.

**Before any implementation, confirm these on the Cloudflare account** (the whole "zero cost" claim rests on them):
- [ ] The account is on **Workers Free**, not Workers Paid, so over-quota means errors, not charges [V for Free behaviour]. Note whether a payment method is on file [U whether Free needs one].
- [ ] Do **not** enable R2 or Realtime TURN; neither is needed.
- [ ] If the account is, or ever becomes, Workers Paid, set the Workers and Durable Objects spend limit (Nov 2026 beta) before deploying the relay [V].

---

## 10. Proposed experiments (not run; none cost money)

| # | Experiment | Why |
|---|---|---|
| E1 | Open the test `.cmm.gz` and the sample `.cslmap.gz` on an older iPhone (6 GB RAM or less) and a recent one, via the existing file picker; note crashes and Safari memory in Web Inspector | Decides whether large maps are viable on phones at all, independent of transfer |
| E2 | `wrangler dev` prototype of the relay room (local only, no deploy): two browser tabs, 12 MB and 100 MB payloads, measure Durable Object memory, flow control and resume | Validates the 32 MiB and 128 MB assumptions and the missing server-side backpressure [U] |
| E3 | Mac Safari `navigator.share({ files })` with `.cslmap.gz` and `.cmm.gz`: is AirDrop offered? Does the iOS picker accept the received file with today's `accept`? | Settles Option 2's two [U]s |
| E4 | WebRTC P2P success rate between the developer's devices across scenarios 1–4, using only Cloudflare STUN and local signaling | Real-world data for whether Option 3's fast path is worth its complexity |
| E5 | Measure the CPU time of an AES-GCM chunk loop on an iPhone for 12 MB and 100 MB | Confirms encryption overhead is negligible [E] |

**Scripts used for the measurements in section 1** (kept outside the repo, reproducible with the local fixtures):
- **Sizes:** reads each fixture with the app's own readers, builds the map, and reports the raw, gzip, Brotli, V8 structured-clone and JSON sizes of the file, `CityData` and `BuiltCity`.
- **Memory:** compares the peak RSS of reading the `.cmm.gz` plus building, against rebuilding from a gzip-JSON `CityData` with tagged `Map`/`Set`/typed arrays (2 runs each).
