# Send to Phone: billing risk review

**Status: not deployed, and off by default.** Written 2026-11-15; updated the same day for signed tickets, the per-client room cap, phone confirmation and the final review.

**Off until switched on.** Merging this code changes nothing in production:
- the default `wrangler.jsonc` (used by `npm run deploy` and the deploy workflow) is still static assets only: no Worker code, no Durable Objects, no rate-limit namespace;
- the app is built without the feature unless `VITE_SEND_TO_PHONE=1`, so there is no menu item and pairing links are ignored.

Everything below applies only once it is switched on (section 6).

**Account:** the Cloudflare account is on **Workers Paid** and hosts other Workers, some of which use Durable Objects; they share the included usage below. **No account-wide spend limit is set**, and this feature doesn't set one. Current billable usage was not checked for this review.

**The question:** what is the most Send to Phone can add to the bill, and what can't be bounded?

---

## 1. Prices and included usage (Workers Paid)

All from Cloudflare's docs, fetched 2026-11-15:
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

| Meter | Included per month (whole account) | Then |
|---|---|---|
| Worker requests | 10 million | $0.30 per million |
| Worker CPU time | 30 million ms | $0.02 per million ms |
| Static asset requests | free and unlimited | — |
| Durable Object requests (incl. WebSocket connects; incoming WebSocket messages count 20:1; alarms) | 1 million | $0.15 per million |
| Durable Object duration (wall-clock while active and not hibernatable, 128 MB) | 400,000 GB-s | $12.50 per million GB-s |
| SQLite rows written / read | 50 million / 25 billion | $1.00 / $0.001 per million |
| SQLite stored data | 5 GB-month | $0.20 per GB-month |

Rules that shape the costs:
- Billable usage is rounded up to the next unit; for duration that's 1 million GB-s.
- Outgoing WebSocket messages and pings are not billed.
- Calling `accept()` on a WebSocket bills duration for as long as it's connected. The WebSocket Hibernation API avoids that.

**All "included" amounts are shared by every Worker on the account.**

## 2. What the relay does to keep its own usage bounded

All of these are in the code, independent of the account's other Workers.

**Before any Durable Object is involved** (`worker/index.ts`):
- Only `/relay/*` runs the Worker. Every other request is a free static asset.
- Requests whose `Origin` isn't the site itself are refused (`403`). This stops other websites from using visitors' browsers; it is no barrier to a script, which can send any `Origin`.
- Each client (an IPv4 address, or an IPv6 /64) is limited to **30 relay requests per minute** (tickets and connections together) with the Workers Rate Limiting binding. Tested locally: 30 opened, the next 15 were refused (`429`).
  - The count is approximate and applies per Cloudflare location.
  - The Workers pricing page lists no charge for this binding [checked by absence; no explicit "free" statement found].
- **Signed tickets.** A room can only be used with a ticket from `POST /relay/new`: an HMAC-SHA256 signature over the room id, the side (desktop or phone) and an expiry (15 minutes), keyed with the `RELAY_SECRET` Worker secret. The Worker checks it itself. A made-up room id, a ticket for another room or side, an extended expiry or a stale link is answered by the Worker and **never reaches a Durable Object**. Issuing a ticket involves no Durable Object either.
- **Room lifetime bound to the ticket.** The Worker hands the room the ticket's expiry; the room closes then at the latest. Reconnecting after everyone left reopens the room as a new one, which costs another room from the budget and still closes at the same moment (tested live).
- **Fails closed.** Without `RELAY_SECRET` the relay answers `503` to everything (tested locally).

**Per room** (`worker/room-core.ts`):
- one desktop and one phone socket;
- the phone must join within 5 minutes; every room closes 15 minutes after opening;
- at most 110 MB forwarded, 1 MiB per message, **2,000 messages**;
- text frames (clients only send binary) close the room at once, so they can't slip past the message cap (tested live);
- everything that changes a room (joins, messages, closes, its alarm) runs one at a time, so concurrent events can't double-open a room or bring a closed one back.

A full 100 MB transfer is about 400 chunks plus acknowledgements, which fits these limits.

**Per UTC day, across all rooms** (the singleton `RelayBudget` Durable Object):
- **50 rooms opened.** Every attempt counts, whether or not a phone ever joins.
- **10 rooms per client** (an IPv4 address, or an IPv6 /64, since one subscriber usually has a whole /64). One person can't use up everyone's rooms. Counted under a hash of the day and the client; the address itself is never stored. Someone with many addresses can still use up the 50 rooms of the day: that blocks the feature for others until the next UTC day, but can't raise the bill past the caps.
- **2 GiB forwarded.** Rooms reserve bytes in 8 MiB blocks before forwarding.
- If the budget can't be reached, rooms and forwarding are refused (fails closed).

Once either is spent, new rooms and further forwarding are refused with "Send to phone has reached its limit for today."

**Idle cost:**
- Rooms use WebSocket hibernation, so a room waiting for the phone to scan, or between bursts, isn't billed for duration.
- Plain `accept()` is used only to send a refusal and close at once.

## 3. Expected usage (normal use)

One typical transfer is a 12 MB map taking about 30 seconds:

| Meter | Per transfer | 50 transfers a day × 30 days |
|---|---|---|
| Worker requests | 2 to 4 (desktop and phone connect, plus reconnects) | about 6,000 (0.06% of 10M) |
| DO requests | about 12 (2 connects, about 62 incoming messages ÷ 20 ≈ 3, 1 room and 2 byte reservations, 1 or 2 alarms, room bookkeeping) | about 18,000 (1.8% of 1M) |
| DO duration | about 4 GB-s (30 s × 0.125 GB) | about 6,000 GB-s (1.5% of 400k) |
| Rows written | about 10 | about 15,000 (0.03% of 50M) |

**If the other Workers leave headroom in the included amounts, normal use costs $0.** If they had already used up the included Durable Object duration, the same 6,000 GB-s would still round up to one full million: **$12.50 for that month** (section 1).

## 4. Worst case within the caps (deliberate misuse)

An attacker who opens the day's 50 rooms and keeps each one awake for its full 15 minutes, sending a small message every few seconds (within the 2,000-message cap so hibernation never starts):

| Meter | Per day | Per month | Share of included |
|---|---|---|---|
| DO duration | 50 × 900 s × 0.125 GB = **5,625 GB-s** | **168,750 GB-s** | 42% of 400k |
| DO requests | 50 × (2,000 ÷ 20 + about 20) = about 6,000 | about 180,000 | 18% of 1M |
| Bytes forwarded | at most 2 GiB | at most 60 GiB | (bandwidth is free) |

**What this costs:**
- **$0** as long as the other Workers use less than about 58% of the included Durable Object duration and 82% of the included requests.
- **If the other Workers had already used it all:** the 168,750 GB-s round up to one million, $12.50. The 180,000 requests round up to one million, $0.15. **About $12.65 a month.**

## 5. Risks the caps can't remove

1. **Floods of refused requests.**
   - Every request to `/relay/*` reaches the Worker. Requests without a genuine, current ticket stop there (since tickets were added they no longer cost a Durable Object request).
   - Someone can still request genuine tickets (30 a minute per IP) and use them. Each new room is one DO request plus a budget check, and room opening stops at the per-client and daily caps; refused room attempts after that cost about 2 DO requests each.
   - One IP at the limit, all month: 30/min × 43,200 min ≈ 1.3 million Worker requests, and at most about 1.3 million DO requests if every one were a ticketed connection attempt.
     - Once the account is past its included usage, that is about $0.39 for the Worker requests and up to $0.30 for the DO requests (charged per million, rounded up).
     - It is not enough on its own to exhaust the included 10M Worker requests.
   - Many IPs, or many Cloudflare locations, multiply this.
   - Roughly, **every extra million refused attempts costs about $0.30 (no ticket) to $0.60 (ticketed)** once past the included amounts.
   - This is true of any public endpoint on the account. The rate limit stops one address, not a botnet.
   - Possible further mitigations, none implemented:
     - Cloudflare WAF rate-limiting rules on `/relay/*`. These stop requests before the Worker; zone rules on the Free website plan are limited [not verified].
     - Turnstile before creating a room. That adds a step for users.
2. **No account-wide hard stop.** As instructed, no spend policy is set. If any Worker on the account (not only Skyline) misbehaves, nothing caps the bill. A generous account-wide limit (for example $10) would stop a runaway without affecting normal use. It's your call; not done.
3. **Shared included usage.** The account's other Workers could already be near or over the included allowances. Their usage this month couldn't be read here; check it under Dashboard → Workers & Pages → usage.
4. **Rounding.** Billable usage rounds up to one million units, so the first byte past an included amount costs a full unit ($12.50 for duration).
5. **Requests for missing pages.** These might invoke the Worker, now that one exists. The Worker hands them straight to the static assets, so each costs one Worker request (10M included) [not verified].
6. **Budget accuracy.** A room counts its bytes and messages in memory and stores them every 4 MB or 64 messages. Waking from hibernation forgets memory, so after each wake a room's own counts can be behind by up to 4 MB and 63 messages; a room woken repeatedly (one message every ten seconds or so) can forward somewhat more than its per-room caps over its 15 minutes. The daily byte budget is not affected: on waking, whatever a room had reserved and not yet stored as used counts as spent, so it never forwards more than it reserved (tested), at the price of over-counting up to 8 MB per wake.
7. **Unverified on Cloudflare itself.** Everything here was tested with `wrangler dev` (Miniflare), not on Cloudflare. Hibernation timing, the rate limiter's behaviour across locations, and how Durable Object requests and duration are actually billed were taken from Cloudflare's documentation, not measured.

## 6. Switching it on and off

- **On (needs the owner's approval):**
  1. `wrangler secret put RELAY_SECRET -c wrangler.relay.jsonc`, with a long random value (for example `openssl rand -base64 32`).
  2. `VITE_SEND_TO_PHONE=1 npm run build && wrangler deploy -c wrangler.relay.jsonc`, and change the deploy workflow the same way so later deploys keep it.
  - This creates the two Durable Object classes (`TransferRoom`, `RelayBudget`, migration `v1`) and the rate-limit namespace (`73001`) on the `skyline-atlas` Worker. It changes no plan or billing setting.
- **Off fast:** delete the secret (`wrangler secret delete RELAY_SECRET -c wrangler.relay.jsonc`). Every relay request is then refused by the Worker (`503`) without touching a Durable Object, and the app says "isn't available right now". Deploying with the default `wrangler.jsonc` again removes the Worker code entirely (the Durable Object classes stay, idle, until a deleting migration).
- **Caps:** `BUDGET` (`roomsPerDay`, `roomsPerClient`, `bytesPerDay`) and `LIMITS` (`maxMs`, `maxMessages`) in `worker/room-core.ts`, and `ratelimits` in `wrangler.relay.jsonc`.
  - Halving `roomsPerDay` halves the worst-case duration in section 4.
  - Shortening `maxMs` to 10 minutes cuts it by a third.

## 7. Before deploying

- [ ] Check this month's Workers and Durable Objects usage in the dashboard. This confirms the headroom assumed in sections 3 and 4.
- [ ] Decide whether to add an account-wide spend policy (section 5, item 2). It isn't required by this feature.
- [ ] Decide whether a WAF rate rule on `/relay/*` is wanted (section 5, item 1).
- [ ] Set the ticket secret before switching it on (section 6). Until it is set, the relay answers "isn't available right now" and costs nothing beyond the refused Worker requests. Rotating it invalidates open links only.
- [ ] Switching on creates two Durable Object classes and one rate-limit namespace (section 6). It changes no plan or billing setting.
- [ ] Try it once on a real iPhone and Android phone (camera scan, lock and resume, a large map).
