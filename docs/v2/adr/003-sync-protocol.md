# ADR 003 — The sync protocol and the blind relay

| | |
|---|---|
| **Status** | Accepted — normative |
| **Date** | 2026-08-25 |
| **Tickets** | LZP-201..207, 501, 502, 504, 505, 104, 109, 1002, 1008 |
| **Stories** | 15.2–15.6, 19.1, 19.2, 19.3, 19.4, 19.6, 20.1–20.4, 21.1, 21.3, 21.4, 21.5, 22.7 |
| **Depends on** | ADR 001 (op-log), ADR 002 (crypto) |

> **The one-sentence protocol.** Devices push signed, padded, end-to-end-encrypted envelopes to a
> per-space append-only log and pull everything after a cursor; the server assigns sequence
> numbers, enforces membership and rate limits, and can read nothing.

---

## 1. Transport

- Base URL `https://<vercel-app>.vercel.app/api/v1/…`, **Vercel functions and Prisma Postgres in
  the Frankfurt region** (addendum §3, §9, decision D2).
- **This is the only network destination in the product** (21.5). Enforced four ways in §7.
- All bodies are JSON, UTF-8. All responses carry `X-LZP-Min-Protocol` and `X-LZP-Protocol`.
- No cookies. No sessions. No bearer tokens. No account system — and none may be built
  (addendum §3).

Every request carries:

```
X-LZP-Protocol: 1
X-LZP-Client: 2.0.3
Authorization: LZP1 device=<deviceShort>, ts=<unixMillis>, nonce=<b64u16>, sig=<b64u>
```

---

## 2. Authentication — exactly what bytes are signed

```
signedString =
      "lzp/v2\n"
    + METHOD                       // uppercase, e.g. "POST"
    + "\n"
    + path                         // e.g. "/api/v1/ops"  — no scheme, no host, no fragment
    + "?"
    + sortedQuery                  // "" for no query; otherwise k=v pairs, percent-encoded,
                                   // sorted by key then value, joined with "&"
    + "\n"
    + b64u( SHA-256( rawBody ) )   // rawBody = the exact bytes sent; SHA-256 of ZERO bytes for GET
    + "\n"
    + ts                           // the decimal string from the Authorization header
    + "\n"
    + nonce                        // the b64url string from the Authorization header

sig = ECDSA-P256/SHA-256( IK_sig.private, UTF-8(signedString) )
```

`signedString` is **never empty** (ADR 002 §1 rule 2) — it always begins with `"lzp/v2\n"`.

**Server verification order** (`server/core/auth.js`), fail closed at each step:

1. Parse the `Authorization` header; reject a malformed one with `401 bad_auth`.
2. `|now − ts| > 120 000 ms` → `401 stale_request`.
3. `claimNonce(deviceShort, nonce, ttl = 300 s)` returns `false` (already used) →
   `401 replay`.
4. Look up the `Device` by `deviceShort`; unknown or `revokedAt != null` → `403 device_revoked`.
5. Verify `sig` against the stored `sigPubRaw`. Failure → `401 bad_signature`.
6. The device's `Member` has `removedAt != null` → `403 not_a_member`.
7. For any space-scoped route, the member is not a member of `spaceId` → `403 not_a_member`.

That is the whole auth model, and it is why removing a member is instant server-side: one column
write and every request from their devices fails at step 4 or 6. A stolen HTTP log yields nothing
reusable after 120 seconds and cannot be replayed at all.

**What the server does *not* validate: entry ownership.** It cannot — ownership lives inside the
ciphertext (ADR 001 §4.5). LZP-901's "server-side validation" clause is escalated to the PO as
risk **R7**, not silently reinterpreted.

---

## 3. Endpoints

```
GET  /api/v1/meta                       → { minProto, maxProto, region, serverTime }
POST /api/v1/ops                        push          §3.1
GET  /api/v1/ops                        pull          §3.2
GET  /api/v1/spaces/:id/keys            key wraps addressed to this device, ALL epochs
POST /api/v1/spaces                     create space (15.2)
POST /api/v1/spaces/:id/epoch           rotate (ADR 002 §4.2) — atomic, coverage-checked
GET  /api/v1/spaces/:id/members         member list + attested device public keys
POST /api/v1/spaces/:id/rename          20.1
POST /api/v1/spaces/:id/delete          20.4 — cascade purge
POST /api/v1/invites                    create   (15.2, 15.5)
POST /api/v1/invites/redeem             redeem   (15.3)
POST /api/v1/invites/revoke             revoke   (15.5)
GET  /api/v1/invites/open?spaceId=…     open invites needing a re-wrap (ADR 002 §4.2 step 3)
POST /api/v1/members/remove             20.1, 20.2
POST /api/v1/members/leave              20.3
POST /api/v1/members/transfer           20.1 — mirrors the in-log admin chain; never authoritative
POST /api/v1/devices                    register an attested device
POST /api/v1/devices/adopt              A2 recovery — signed by RK_sig
POST /api/v1/devices/revoke             19.5
POST /api/v1/pair/offer                 ADR 002 §6.3
GET  /api/v1/pair/:rid
POST /api/v1/pair/answer
POST /api/v1/pair/deliver
```

### 3.1 Push — `POST /api/v1/ops`

```jsonc
// request
{
  "space": "fsp_9xQ2mR7bL0aZ4tV8wK",
  "ackSeq": "10201",                      // highest seq this device has folded (feeds §6.3 GC)
  "ops": [
    { "v":1, "sp":"fsp_9xQ2mR7bL0aZ4tV8wK", "ep":3, "dv":"7QAR2MZ9XKPNC0GV",
      "oid":"8Kx2Qm7bR0aZ4tV9wLpNcg", "wit":"kQ7bR0aZ4tV9wLpNcgXk92",
      "iv":"pQ7bR0aZ4tV9wLpN", "ct":"Xk92…", "sig":"MEUCIQD…" }
  ]
}
```

```jsonc
// 200
{
  "accepted":  [ { "oid": "8Kx2Qm7bR0aZ4tV9wLpNcg", "seq": "10432", "chain": "9fA2…" } ],
  "duplicate": [ { "oid": "aQ7bR0aZ4tV9wLpNcg",     "seq": "10201", "chain": "3bC1…" } ],
  "spaceSeq":  "10432",
  "serverTime": 1787836800123
}
```

**Idempotency** is `@@unique([spaceId, opId])`. A re-push of a stored envelope is reported in
`duplicate[]` with its **existing** `seq` and returns 200 — never an error. The client treats
`accepted` and `duplicate` identically: both mean "the server has it". A response lost in flight
therefore costs one retry and never a duplicate entry. Combined with the idempotent fold
(ADR 001 §6), **at-least-once delivery is sufficient; exactly-once is never needed.**

A re-push of the same `oid` with **different bytes** returns `409 forked_op_id`. The client must
treat this as local corruption: re-mint the affected ops with fresh `opId`s and log it loudly.

Server validation, in order: header shape; §2 auth; membership in `space`; `e.dv === auth.deviceShort`
(else `403 device_mismatch`); `e.sp === body.space`; `e.ep ≤ space.currentEpoch` (else
`400 future_epoch`); size caps (§6.1). **The server never inspects `ct`.**

### 3.2 Pull — `GET /api/v1/ops?space=fsp_…&since=10201&limit=500`

```jsonc
// 200
{
  "ops": [ { "seq": "10202", "chain": "…", "v":1, "sp":"…", "ep":3, "dv":"…",
             "oid":"…", "wit":"…", "iv":"…", "ct":"…", "sig":"…" } ],
  "nextCursor": "10432",
  "hasMore": false,
  "currentEpoch": 3,
  "serverTime": 1787836800123,
  "members": [ { "memberId":"mem_7f2c…", "colorRef":"gruen", "removedAt": null,
                 "devices": [ { "deviceShort":"7QAR…", "sigPubRaw":"b64u", "kexPubRaw":"b64u",
                                "revokedAt": null } ] } ]
}
```

`members` is piggybacked on every pull because the projection rule (ADR 001 §5 step 3) needs the
**current** member set to be correct *before* the ops are applied, and because §5.2's post-decrypt
`op.act === memberOf(dv)` check needs the device→member mapping and the signing keys. It is at
most 8 rows of pseudonymous ids — cheaper than a second round trip. **Display names and colors
still travel encrypted, as `member.set` ops**; `colorRef` is the one deliberate plaintext leak
(§5.1).

### 3.3 Ordering and cursors

`seq` is a **per-space, gapless, monotone counter**, assigned inside the same transaction as the
batch insert:

```sql
UPDATE "Space" SET "nextSeq" = "nextSeq" + $n WHERE id = $1 RETURNING "nextSeq";
```

**Not a Postgres `SERIAL`/`BIGSERIAL`.** A global sequence leaves gaps when transactions commit
out of order, and `WHERE seq > cursor` can then skip an op that committed *after* a
higher-numbered one — a silent, intermittent data-loss bug that is very hard to find later. A
row-locked per-space counter makes the cursor safe. Duplicate `opId`s are filtered *before* the
counter bump (`ON CONFLICT DO NOTHING` + a `RETURNING` diff) so idempotent re-pushes do not burn
seq numbers. This serialises concurrent pushes per space, which is entirely fine at family scale
and is the correct trade against correctness.

> **`seq` is a transport cursor and never a merge input.** No merge outcome anywhere depends on
> it. A server that assigns out of stamp order, re-delivers, or delays cannot cause divergence —
> only latency. This is the single most valuable simplification in the protocol, and it is what
> makes story 19.6 (three weeks offline, across a month roll) reduce to "a large op set arrives
> late", which set-based merge handles by definition.

**Cursor persistence.** `cursor[spaceId] = lastSeq` lives in the `local` space and is advanced
**only after** the batch has been decrypted, folded into the registers **and persisted**. A crash
mid-pull re-fetches rather than skips.

### 3.4 Why 19.6 needs no special case

- **Month rolls are not data.** The visible window derives from `todayISO()` at render time
  (`layout.js:86`). Nothing is emitted, nothing merges, nothing can conflict.
- **Yearly repeats are single objects** (9.3, A4). A repeat crossing a year boundary emits no op;
  occurrences are computed by `dates.js:projectYearly` at render.
- **Catching up is one pull loop.** Ops arrive in `seq` order, are folded in any order, and the
  result equals what every other device already has (ADR 001 §6).

The fleet suite still scripts it explicitly, including a device that misses two key rotations.

---

## 4. Protocol versioning and the N−1 rule (LZP-206, LZP-104 · addendum §3, story 22.7)

- `X-LZP-Protocol` is an integer. **v2.0 GA ships protocol `1`.**
- **The server always accepts `PROTO_MAX` and `PROTO_MAX − 1`.** A breaking change bumps to 2; the
  server then speaks both, and only a *later* release drops 1. Constraint from addendum §9:
  *"The server always supports the current and the previous client protocol version."*
- Every response carries `X-LZP-Min-Protocol`, so a client learns about a coming gate **before**
  it is enforced and can surface the quiet „Update verfügbar" hint (22.4) instead of hitting a
  wall.
- Below `PROTO_MIN` → **`426 Upgrade Required`** with
  `{ "error": "protocol_too_old", "minProto": 2, "minClientVersion": "2.4.0" }`.
  The client shows the plain-language outdated screen (deliverable 26, LZP-104) and **keeps
  working fully offline** — 19.1 does not bend for a protocol bump. This is 22.7's *"instead of
  failing quietly"*.
- Above `PROTO_MAX` → `400 protocol_unknown`. A client that gets this has been downgraded; same
  screen.
- The **update manifest carries the same `minClientVersion`** (LZP-104), so the gate is enforced
  by the updater first and by the server only as a backstop.

**Three version numbers, deliberately independent:**

| number | changes when |
|---|---|
| `X-LZP-Protocol` | the **HTTP surface** changes |
| `Envelope.v` | the **ciphertext format** changes (ADR 002 §5) |
| `Op.v` | the **op format** changes (ADR 001 §2) |

They will usually move together and must be allowed not to. A client keeps the ability to *open*
every `Envelope.v` it has ever seen.

**Forward compatibility inside the payload (the N+1 half):** unknown op **kinds** and unknown
**field names** are **parked, not dropped** (ADR 001 §7.4). An old client in a family with a newer
one degrades to *"does not show the new thing"* instead of *"loses the new thing"* — which
matters, because desktops update on their own schedule (F22, 22.5).

**CI (LZP-206):** the fleet suite runs twice — once with every device at `PROTO_MAX`, once with
half the fleet at `PROTO_MAX − 1` — asserting round-trip and convergence in both.

---

## 5. The server: models and what it can see

### 5.1 Prisma models (refining the addendum §3 sketch)

```prisma
// server/prisma/schema.prisma        region: eu-central-1 (Frankfurt)

enum SpaceKind { PERSONAL FAMILY }

model Space {
  id           String    @id                    // "psp_"|"fsp_" + 22 b64url
  kind         SpaceKind
  currentEpoch Int       @default(1)
  nextSeq      BigInt    @default(0)            // §3.3 — gapless, row-locked
  headChain    Bytes?                           // ADR 002 §5.4
  createdAt    DateTime  @default(now())
  members  Member[]   ops Op[]   invites Invite[]   wraps KeyWrap[]   epochs Epoch[]
}

model Member {
  id             String    @id                  // "mem_" + 22 b64url — pseudonymous
  spaceId        String
  colorRef       String                         // PLAINTEXT — see the leak note below
  recoveryPubSig Bytes                          // 65 B raw P-256; verifies device attestations
                                                //   and /devices/adopt (ADR 002 §7.3)
  joinedAt       DateTime  @default(now())
  removedAt      DateTime?
  devices        Device[]
  space          Space     @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  @@unique([spaceId, colorRef])                 // 15.3 — no two members share a color
  @@index([spaceId, removedAt])
}
// NOTE: no displayNameCipher and no role column. Display names travel as `member.set` ops
// inside the encrypted stream; the admin is resolved from the in-log chain (ADR 001 §4.1).
// The server holds strictly less than the §3 sketch proposed. This is a refinement, not a
// deviation.

model Device {
  id           String    @id                    // "dev_" + 22 b64url
  memberId     String
  deviceShort  String    @unique                // 16 Crockford base32 — the stamp tiebreak
  sigPubRaw    Bytes                            // 65 B
  kexPubRaw    Bytes                            // 65 B
  attestation  Bytes                            // signed by the member's recovery key
  lastSeenSeq  BigInt    @default(0)            // reported on push; gates tombstone GC
  addedAt      DateTime  @default(now())
  revokedAt    DateTime?
  member       Member    @relation(fields: [memberId], references: [id], onDelete: Cascade)
}

model Op {
  spaceId     String
  seq         BigInt
  opId        String                            // 22 b64url — the idempotency key
  epoch       Int
  deviceShort String
  witness     Bytes?                            // ADR 002 §5.4
  chain       Bytes                             // SHA-256(prevChain ‖ opId)
  envelope    Bytes                             // iv ‖ ct ‖ sig — PADDED. UNREADABLE.
  receivedAt  DateTime  @default(now())
  space       Space     @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  @@id([spaceId, seq])
  @@unique([spaceId, opId])
  @@index([spaceId, seq])
  @@index([spaceId, deviceShort])               // 20.2 — purge a removed member's ops
}
// NOTE: there is deliberately NO `ts` column. The addendum §3 sketch had one. Authoring time
// lives inside the ciphertext (ADR 002 §5.1); the server keeps only `receivedAt`, which it
// cannot avoid knowing.

model Epoch  { spaceId String  epoch Int  createdAt DateTime @default(now())
               @@id([spaceId, epoch]) }         // first-writer-wins rotation (ADR 002 §4.2)

model KeyWrap {
  id       String @id @default(cuid())
  spaceId  String
  epoch    Int
  deviceId String
  wrapped  Bytes                                // {salt,iv,ct} — opaque
  @@unique([spaceId, epoch, deviceId])
  @@index([deviceId])
}

model Invite {
  id          String    @id                     // HKDF(code,…,'id') — the raw code never arrives
  spaceId     String
  verifier    Bytes                             // SHA-256(HKDF(code,…,'verify'))
  // wrappedKeys — REMOVED by PO decision D9. An invite carries no key material.
  wrapSalt    Bytes
  epoch       Int
  createdBy   String
  expiresAt   DateTime
  usedAt      DateTime?
  revokedAt   DateTime?
}

model PairSession { rid String @id  boxA Bytes?  boxB Bytes?  delivery Bytes?
                    attempts Int @default(0)  expiresAt DateTime }

model Nonce { deviceShort String  nonce String  expiresAt DateTime
              @@id([deviceShort, nonce])  @@index([expiresAt]) }

model RateBucket { key String @id  count Int  windowStart DateTime }
```

### 5.2 The metadata inventory (LZP-207 → LZP-1001)

**Everything the server can observe, exhaustively:**

space ids and kinds · pseudonymous member ids · member **color refs** · join and removal
timestamps · device ids, device shorts and public keys · device `lastSeenSeq` · epoch numbers and
rotation times · per-space op counts · **padded** envelope sizes (256-byte buckets) · op
**arrival** times · the chain hashes · invite id hashes, epochs and expiry · IP addresses in
transit · Vercel's own request logs.

**Nothing else. No note text, no bar label, no category, no scratchpad, no date, no display name,
no authoring time.**

**One deliberate plaintext leak, named:** `Member.colorRef`, because 15.3's colour-collision
prevention needs `@@unique([spaceId, colorRef])` server-side. It reveals one palette index per
member. Acceptable, and it appears verbatim in the Datenschutz copy.

---

## 6. Abuse basics, retention, logging (LZP-205)

### 6.1 Caps

| | |
|---|---|
| request body | ≤ 4 MB |
| ops per push | ≤ 200 |
| bytes per envelope | ≤ 64 KB |
| ops per pull | ≤ 500 (`limit`, default 500) |
| pair sessions | 10 per member per hour; 5 failed `rid` lookups per IP per minute |
| invite redemptions | 10 per IP per hour |
| push / pull | 60 / min and 120 / min per device, sliding window in `RateBucket` |

`429` responses carry `Retry-After`.

### 6.2 Logging

Structured logs record `{ route, spaceId, deviceShort, opCount, byteCount, status, ms }` and
**never** `envelope`, `iv`, `ct`, `sig`, `wrapped`, `boxA/boxB/delivery`, or `wrappedKeys`.
`ctx.log()` takes a whitelisted field set, and `tests/server/log-redaction.test.js` greps the log
serialiser and fails on any other identifier reaching it. (21.3, 21.4)

### 6.3 Retention

- **No timed pruning in v2.** Every device holds a complete replica, so total server loss costs
  the family the *relay*, not the *data*: re-create the space, re-pair, re-push from the
  local logs. What is genuinely unrecoverable is losing every device **and** the backup file —
  the Option-B trade the addendum already states.
- `POST /members/remove` and `/members/leave` **purge that member's `Op` rows** in the same
  transaction as the membership write (20.2), using `@@index([spaceId, deviceShort])`.
- `POST /spaces/:id/delete` cascades everything (20.4).
- **There is no per-entity redaction endpoint.** An endpoint that lets any member delete another
  member's ops from the relay is a censorship primitive; one reviewed design shipped exactly that
  and it is rejected here. Downgrade removal is a register overwrite plus the client-side forget
  pass (ADR 004 §5) plus honest copy (ADR 002 §7.4).
- Tombstone GC is client-side and gated on `Device.lastSeenSeq` (ADR 001 §7.3), for which `ackSeq`
  on push is the input.

---

## 7. Solo mode makes zero requests — four independent gates (21.5, LZP-1002)

A promise this central does not rest on one `if`.

1. **One call site.** `src/js/platform/net.js` is the **only** module in the tree that calls
   `fetch`. `tests/tier1/network-scope.test.js` greps all of `src/js/` for `fetch(`,
   `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon` and fails on any hit
   outside that file.

   > **Amended 2026-08-27 — gate 1 is OWED, not held. Owner: WP-8 / LZP-1002.** Neither
   > `src/js/platform/net.js` nor `tests/tier1/network-scope.test.js` exists, and
   > `tests/helpers/purity.js:28`'s `PURE_DIRS` is `['src/js/core','src/js/crypto','src/js/sync',
   > 'server/core']` — it never scans `src/js/` as a whole. At HEAD the property is **vacuously**
   > true: `grep -rn "fetch\|XMLHttpRequest\|WebSocket\|EventSource\|sendBeacon" src/` returns
   > three comment hits and nothing else, and the op log added nothing networked. Gates 2, 3 and 4
   > are real and asserted (`tests/tier2/shell-bridge.dom.js:68` proves a real off-origin `fetch`
   > is **blocked**, not merely unused). This gate is ~20 lines and it is the one that would have
   > caught `src/js/platform/updater.js` arriving unscanned — see finding **F-9**. Recorded by
   > `judge:conformance` B-14.
2. **Never loaded.** `net.js` and the whole of `src/js/sync/` are reached only through a dynamic
   `await import()` gated on `store.state._v2.spaces.personal || store.state._v2.spaces.family`.
   In solo mode the modules are never evaluated, so there is no code path to a request even under
   a bug elsewhere.
3. **The shell enforces it.** `WKNavigationDelegate` / `WKURLSchemeHandler` in
   `shell-macos/main.swift` rejects every request whose scheme is not `app://` unless the shell
   has been told (`set_shell_pref: "sync_enabled"`) that a space exists — and then permits exactly
   the one sync origin. **This gate survives a JS bug**, which no test-only assertion does.
4. **CSP.** `src-tauri/tauri.conf.json` → `connect-src 'self' ipc: http://ipc.localhost https://<sync-host>`
   and nothing else, mirrored as a `Content-Security-Policy` meta in `index.html` for the Swift
   shell.

LZP-1002 asserts (1) by grep, (2) by a `fetch` spy over a full scripted solo session **including
first run**, (3) by the shell's own `--test` run, and (4) by reading the shipped config.

---

## 8. The client sync engine (LZP-501, 504, 505)

```js
// src/js/sync/client.js — DOM-FREE. Owns no I/O; the transport is injected.
/**
 * @param {{ transport: Transport, keyring: KeyRing, oplog: OpLog, identity: Identity,
 *           spaces: SpaceConfig, clock: Clock, schedule: Scheduler,
 *           onOps: (ops: Op[]) => void, onStatus: (s: SyncState) => void }} deps
 */
export function createSyncClient(deps) {
  return { start(), stop(), pushNow(), pullNow(), status() };
}

/** @typedef {{ request(method, path, query, body, headers): Promise<{status, headers, json}> }} Transport */
```

`transport` is a **port**, not `fetch`. In tests it is bound directly to the real server handlers
over the memory adapter, so the fleet suite exercises the real client and the real server logic
with no sockets (ADR 005 §5.4).

### 8.1 Outbox and inbox

- **Outbox** — `ops.jsonl` lines whose `seq` is unset, i.e. sealed envelopes not yet acknowledged.
  Append-only, survives quit and crash (19.1). An entry is removed only after the server reports
  it in `accepted` **or** `duplicate`. No size limit and no expiry: a three-weeks-offline device
  pushes three weeks of ops in `⌈n/200⌉` batches.
- **Envelopes are sealed in a `queueMicrotask` *after* `store.emit()`** (ADR 001 §0.9), never
  before.
- **Inbox is not persisted separately.** Pulled ops are decrypted, folded, appended to
  `ops.jsonl`, and only then does the cursor advance (§3.3).

### 8.2 Cadence (19.2 as amended in v2.1)

| trigger | action |
|---|---|
| a txn commits | debounce **2 s**, then push the outbox (*"my changes upload within seconds"*) |
| `focus`, `visibilitychange → visible`, `online` | pull all configured spaces immediately |
| timer, window visible | pull every **45 s ± 15 s jitter** |
| timer, window hidden | pull every **10 min**; push continues, so a queued edit still uploads |
| `pagehide` | force-flush the outbox through the same path `store.flushSync()` already uses |
| offline (`navigator.onLine === false` or a transport error) | stop scheduling; queue in `ops.jsonl` |
| back online | pull, then push |

Jitter is re-randomised each tick, per device, so eight family members do not synchronise into a
thundering herd on a Hobby-tier function after a shared trigger (Risk R3).

**Backoff:** on 5xx or a network error, `min(300 s, 2^n × 2 s)` with **full jitter**
(`delay = random(0, base)`), reset on the first 2xx. `429` honours `Retry-After`. `401`/`403`/`426`
**do not back off** — they stop the loop and set the status. A `4xx` other than `408`/`429`/`409`
on a specific envelope is terminal for that item: it moves to a **quarantine** list with a visible
error, because a permanently rejected op must never silently spin forever.

**There is no sync button and no manual refresh anywhere** (19.2 — an acceptance criterion, not a
preference). **Never a spinner on the board.**

### 8.3 The three sync states (19.3, LZP-504)

```js
/** @typedef {'healthy'|'pending'|'error'} SyncState */
```

| state | condition | UI |
|---|---|---|
| `healthy` | outbox empty ∧ last successful pull < 3 min ∧ `consecutiveFailures === 0` | **nothing at all** — no dot, no text, no tooltip. F11's "silence is the design" extends to the network. |
| `pending` | outbox non-empty for > 20 s ∨ `navigator.onLine === false` ∨ `1 ≤ failures ≤ 2` | one small, still, hollow glyph in the toolbar; tooltip „Änderungen werden übertragen, sobald du online bist" |
| `error` | `failures ≥ 5` ∨ 401/403 ∨ 426 ∨ a quarantined op ∨ a decrypt failure ∨ clock skew > 5 min | the same slot, filled, calm (never red-alert); click opens the *Familie* settings section with one plain sentence and, for the skew case, a specific one |

Transitions are debounced by 2 s so a normal push does not flicker the indicator. No modal, no
badge count, never on the board itself.

---

## 9. Server implementation shape — and why CI here is real

This machine has no Vercel and no Postgres. The tests must still be real, meaning: **the same
handler code that runs in production runs in CI.**

> **Normative:** no file under `server/core/` may import Prisma, `@vercel/*`, `node:fs`, call
> `fetch`, read `process.env`, call `Date.now()` or `crypto.randomUUID()`. Handlers receive
> everything through `ctx`.

```js
// server/core/handlers/ops.js — pure. No req/res, no framework, no globals.
/**
 * @param {ServerReq} req
 * @param {ServerCtx} ctx
 * @returns {Promise<ServerRes>}
 */
export async function pushOps(req, ctx) { … }
export async function pullOps(req, ctx) { … }
```

```js
/** @typedef {Object} ServerReq
 *  @property {string} method @property {string} path
 *  @property {Object<string,string>} query @property {Object<string,string>} headers
 *  @property {any} body @property {Uint8Array} rawBody */
/** @typedef {Object} ServerRes
 *  @property {number} status @property {Object<string,string>} [headers] @property {any} body */
/** @typedef {Object} ServerCtx
 *  @property {SyncStore} store
 *  @property {() => number} now                       // injectable clock
 *  @property {(n:number) => Uint8Array} random
 *  @property {(req:ServerReq) => Promise<{deviceShort, deviceId, memberId}>} auth
 *  @property {(memberId:string, spaceId:string) => Promise<void>} assertMember
 *  @property {(evt:Object) => void} log                // whitelisted fields ONLY (§6.2)
 *  @property {Object} limits */
```

The full `SyncStore` interface is in `docs/v2/contracts/server.contract.js`. Three adapters
implement it:

| adapter | used by | notes |
|---|---|---|
| `server/adapters/memory.js` | tier-1 handler tests + the fleet suite | Maps + a mutex for `tx()`, with snapshot/rollback on throw. ~250 lines, zero deps. |
| `server/adapters/file.js` | `server/dev-server.mjs` — a zero-dependency `node:http` host | lets **two real app windows** sync on this machine over real HTTP, with no Vercel and no Postgres |
| `server/adapters/prisma.js` | production only | `$transaction`, Prisma connection pooling **from day one** (Risk R3) |

`api/v1/[[...path]].js` is the only Vercel-aware file, ~15 lines: normalise `Request` →
`ServerReq`, build `ctx` with `prismaStore()`, run `router`, write `ServerRes` back. **A bug in it
cannot be a bug in a handler.**

`tests/server/store-contract.test.js` runs the same ~40 assertions against `memory` and `file`, so
`prismaStore` has one written specification to satisfy when a machine with Postgres finally runs
it. `store.tx(fn)` is in the interface precisely because Postgres transaction semantics are the
one thing that cannot be exercised here.

### 9.1 What the server refuses to do

- It never validates entry ownership. **It cannot** (§2, ADR 001 §4.5).
- It never decides merges. It assigns `seq` and stores bytes.
- It never emails, never pushes, never notifies. **No surveillance surface to build on**
  (Principle 9).
- It holds no key material of any kind.

---

## 10. Known weaknesses

1. **Per-space `seq` assignment serialises pushes.** Correct and simple; it is the first thing
   that will hurt if this ever leaves family scale. So will Vercel cold starts at the 45-second
   pull cadence (Risk R3) — budgeted and asserted in LZP-202, not designed around.
2. **Every request writes and later sweeps a `Nonce` row.** At the 45 s cadence × 8 members ×
   2 spaces that is roughly 1 400 writes/hour on a free-tier Postgres. It fits, and it is the
   first thing to watch; the sweep is lazy (`WHERE expiresAt < now()` on write) because Hobby has
   no cron.
3. **Push and pull latency is at the mercy of a serverless cold start.** No UX copy may promise
   "live" (addendum §3).
4. **A device offline longer than the tombstone horizon** (ADR 001 §7.3) still holds ops peers may
   have GC'd. The GC's condition 3 makes that impossible in practice, and the price is that a
   device which never returns blocks GC forever.
5. **`members` is piggybacked on every pull**, so a family of 8 pays ~2 KB per pull for data that
   rarely changes. An ETag would fix it; deferred as premature.
6. **The chain witness is diagnostic-only** (ADR 002 §5.4, §8.6).
7. **LZP-901's server-side ownership validation is impossible** (§2). Escalated as R7, not
   reinterpreted.
