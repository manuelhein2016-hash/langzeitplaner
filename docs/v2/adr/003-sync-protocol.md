# ADR 003 — The sync protocol and the blind relay

| | |
|---|---|
| **Status** | Accepted — normative |
| **Date** | 2026-08-25 |
| **Tickets** | LZP-201..207, 501, 502, 504, 505, 104, 109, 1002, 1008 |
| **Stories** | 15.2–15.6, 19.1, 19.2, 19.3, 19.4, 19.6, 20.1–20.4, 21.1, 21.3, 21.4, 21.5, 22.7 |
| **Depends on** | ADR 001 (op-log), ADR 002 (crypto) |
| **Amended** | 2026-08-29 (E2↔E3 seam) — **§3 and §5.1 are amended so that this ADR and ADR 002 describe ONE wire.** Family key rotation could not be performed by any client over the endpoints below, and both sides' suites were green because neither ever put one side's output into the other's input. `POST /spaces/:id/epoch`'s body is stated exactly (§3.5); `GET /spaces/:id/keys` gains **`senderKexPubRaw`**, which ADR 002 §4.2 step 6 has required since 2026-08-28 and no column carried; `GET /spaces/:id/members` publishes **`device.attestation`**, the roster ADR 002 §4.2 step 6 already specified; `KeyWrap` gains a relay-stamped **`senderDeviceId`**; and `device.attestation` has ONE encoding on every write path — the blob string — verified on `POST /spaces` as it always was on `POST /devices`. §5.1's model block was also stale in four places and is refreshed against `server/prisma/schema.prisma`, which is the authority. Findings **E2E3-1 … E2E3-8**. |

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
GET  /api/v1/spaces/:id/keys            key wraps addressed to this device, ALL epochs  §3.5
POST /api/v1/spaces                     create space (15.2)
POST /api/v1/spaces/:id/epoch           rotate (ADR 002 §4.2) — atomic, coverage-checked   §3.5
GET  /api/v1/spaces/:id/members         member list + attested device public keys + BLOBS §3.6
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

### 3.5 Rotation and key delivery — the exact bodies  *(added 2026-08-29)*

> **WHY THIS SECTION EXISTS.** ADR 002 §4.2 describes what a client must do; §3 above listed two
> routes and no shapes. The two descriptions did not meet, and nothing in either suite would have
> said so — the E2 handlers were proved against hand-built bodies and the E3 crypto against a
> hand-built member list. Six fields disagreed and family key rotation was unbuildable by
> anybody. The shapes are written down here, once, and ADR 002 §4.2 steps 4 and 6 point at them.

```jsonc
// POST /api/v1/spaces/:id/epoch  — the rotation.  ADR 002 §4.2 step 4.
{
  "epoch": 4,                           // exactly currentEpoch + 1; 409 epoch_taken otherwise
  "wraps": [
    { "recipientId": "dev_8Kx2Qm7bR0aZ4tV9wLpNcg",   // a device id OR "rec_<memberId>"
      "epoch": 1,                                     // 1..epoch — the backfill rides along
      "wrapped": "eyJjdCI6…" }                        // b64url of canonicalJSON(WrapBlob)
  ]
}
```

**Three things are NOT on this body and each absence is load-bearing:**

| absent | why |
|---|---|
| `invites` | D9 removed every trace of key material from an invite, so there is nothing to re-wrap. The relay refreshes each open invite's epoch itself. The field's *presence* is `400 retired_by_d9` — not silently ignored, because a client that still sends it believes in a seven-day read window the PO removed |
| `senderDeviceId` / `senderKexPubRaw` | **the relay stamps the depositor**, from the request it just authenticated. A client may not name it under either spelling; an unknown key is `400 unknown_field` |
| a `deviceId` spelling of `recipientId` | a recipient may be `rec_<memberId>`, which is not a device id (finding E3-4). One name, and it is the true one |

`Space.currentEpoch`, the `Epoch` row, the wrap inserts, the stale-wrap purge and the invite
refresh are **one transaction**, and the coverage check runs *before* `claimEpoch` so a refused
rotation cannot burn `e+1`.

```jsonc
// GET /api/v1/spaces/:id/keys  — delivery.  ADR 002 §4.2 step 6, §4.4.
{
  "spaceId": "fsp_…",
  "currentEpoch": 4,
  "wraps": [
    { "epoch": 1,
      "recipientId": "dev_8Kx2Qm7bR0aZ4tV9wLpNcg",
      "wrapped": "eyJjdCI6…",
      "senderKexPubRaw": "BF3k…" }   // b64url, 65 B — or NULL
  ],
  "keysPending": false,              // wraps.length === 0; the DESIGNED waiting state, not an error
  "serverTime": 1787900000000
}
```

**`senderKexPubRaw` is the field ADR 002 §4.2 step 6 has required since 2026-08-28**, and until
2026-08-29 nothing on this wire carried it, so `admitWraps` threw on every honest row (finding
E2E3-3). The relay stores the sender as `KeyWrap.senderDeviceId` — its own observation — and
serves it here by joining to the `Device.kexPubRaw` it already publishes in §3.6.

It is `null` when that device row is gone, which a member removal does by cascade. `null` is
**not** an error: `SenderSet.lookup` answers `null`, `admitWraps` counts the row `unauthorized`,
and the ops stay parked (ADR 002 §4.4) until a rotation by a live member re-deposits epochs
`1..e+1`. That is the correct answer for a key deposited by a device this space no longer admits.

**The relay cannot use this field to inject a key.** It selects among keys the receiver imported
from verified attestations; it never supplies one. A wrong value causes a refusal.

### 3.6 The member list carries the attestation blob  *(added 2026-08-29)*

`GET /api/v1/spaces/:id/members` publishes, per device, `deviceId`, `deviceShort`, `sigPubRaw`,
`kexPubRaw`, `revokedAt` **and `attestation`** — the blob string
`b64u(canonicalJSON(payload)) + '.' + b64u(sig)`.

This is the roster ADR 002 §4.2 step 6 already specified ("`MemberRowDb.recoveryPubSig` plus the
`dev.*` blobs") and `familyRecipients()` refuses to build a recipient without it, so without this
field no rotation is buildable at all (finding E2E3-6). It is a **hint**, never authority: every
reader verifies it under the housing member's `recoveryPubSig` first, so the relay's device rows
support *key distribution* and never *admissibility*. See ADR 002 §4.2 step 6 for the 21.1
accounting, which is nil, and for the closed payload field set that keeps it nil.

**It is NOT on the `GET /ops` piggyback** (§3.2), which stays four device fields. That runs every
45 seconds for every device in every space; the roster is a membership-change path. Two
projections, on purpose — `server/core/handlers/members.js` holds the reasoning and
`tests/server/blindness.test.js` §7 holds both to one justified allowlist.

**One encoding, everywhere.** `device.attestation` is the blob STRING on `POST /devices`,
`POST /devices/adopt`, `POST /spaces` and `POST /invites/redeem`, stored as its UTF-8 bytes, and
republished here byte for byte — it has to be, because clients verify a signature over exactly
those bytes. `POST /spaces` previously read base64url and verified nothing while `POST /devices`
read the string and verified P2 + S1 + S2; the column therefore had no type and a publication of
it would have published two different things (finding E2E3-7). **`POST /invites/redeem` still
does not verify the signature and must** — one unverifiable blob wedges every future rotation of
that space, because `familyRecipients()` throws on it.

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

**Forward compatibility at the RELAY's doors (the N−1 half, server-first) — amendment, round 9.**
The N+1 rule above is about a CLIENT meeting something it does not know, and a client can park:
the unknown field is inside a signature it can verify and a stream it can read, so *"keep it, do
not interpret it"* is available and is the right answer. **The relay has no such option for the
device attestation.** It is not a reader of that blob, it is a PUBLISHER of it — an opaque column
it stores in the clear and hands to every member of the space (`GET /spaces/:id/members`). "Park
it" and "store it" are the same act at a door, so a door has exactly two answers: store the bytes,
which is a free-text channel through a relay whose whole claim (story 21.1) is that it holds none,
or refuse them. `server/core/handlers/devices.js assertAttestationClosed` refuses them, on all four
doors that persist a `Device` row.

The forward-compatibility cost is real and is paid **N−1, in the server-first direction: the
relay's allow-list ships one release BEFORE any client mints the field.** `recoveryPubKex` is on it
today, which is exactly what lets ADR 002 §2.3's binding land as a client-only change. This is
versioning, not negotiation — no round trip, nothing offered or withdrawn, and the release order is
the whole protocol. See ADR 002 §2.3 and finding R8-7.

### 4.1 The baseline a joining device may claim — and the case where it may claim none  *(round 10, item 9)*

**The case this is about is E6's normal one, not an edge.** Mama joins a Familienkreis that
already removed someone. Story 20.2's removal purges the departed member's `Op` rows server-side,
so the log she pulls **has holes by design**: `seq` numbers are missing, and `Op.chain =
SHA-256(prevChain ‖ opId)` (ADR 002 §5.4) was computed over the *original* sequence, so it does not
verify across the gap even against a perfectly honest relay. She has no anchor that predates the
holes, because she was not there.

**The answer is that she cannot prove a baseline, and the specification is that she must say so.**
An unprovable claim reported as proved is worse than one reported as unprovable — that is what ADR
002 §5.4's `fromGenesis` flag exists for, and this section is the rule that makes a client's use of
it testable rather than tasteful.

**Why there is no anchor to be had. Three candidates, and each fails for its own reason:**

| candidate | why it is not a baseline |
|---|---|
| `Op.chain` itself | The **relay** computes it, per space, and **nobody signs it**. For a device with no independent history it proves only that the relay served a self-consistent sequence — which a lying relay produces from genesis at zero cost. |
| a peer's `Envelope.wit` | Signed, and it *does* anchor — but only at ops the joiner can also see and recompute. A `wit` committing to a head across a purged range names a chain she can never reconstruct, so it is **unverifiable rather than falsifiable**: she cannot tell a lie from a legal hole. |
| the `member.remove` op | It is in the log she pulls and it is signed by the admin, so she can see **that** a removal happened and roughly where. That upgrades "an unexplained break" to "a break with a signed explanation next to it" — the strongest honest statement available — and it is still not proof that the break is *only* the removal's. The relay chooses which rows to serve and can hide withheld ops under the cover of a real one. That is finding R10-4: **to this client a withhold and a purge are the same event.** |

**The rules. A client is conformant iff all five hold.**

- **R1 — record the baseline, once.** On its first successful pull in a space a device MUST persist
  `baselineSeq` (the `seq` of the first op it folds) and `baselineChain` (that op's `chain`), and
  MUST record them as **asserted by the relay**, never as verified. There is no endpoint that
  supplies them and none may be added: any value the relay hands over is a value the relay chose.
- **R2 — `fromGenesis` is derived, not set.** It is true iff `baselineSeq === 1` **and** every chain
  link from 1 to the device's cursor has verified without a break. Anything else is false.
- **R3 — `fromGenesis` may fall and may never rise.** A device that has once seen a break lowers it
  and keeps it lowered across restarts. Raising it — on a fresh pull, a re-anchor, a cache clear —
  is the lie this section exists to forbid.
- **R4 — a break below `baselineSeq` is not a finding.** It is outside what this device can speak
  about at all, and reporting it would make every honest post-removal join look like an attack. A
  break **at or above** `baselineSeq` is a finding, and it stays a **diagnostic** that never blocks
  sync (ADR 002 §5.4; the wedge R8-2 measured is what a blocking one costs).
- **R5 — the copy contract.** A device with `fromGenesis === false` may render „**seit dem Beitritt
  geprüft**" and MUST NOT render „geprüft", „vollständig" or a bare green check for history it did
  not witness. This is the sync half of ADR 002 §7.4, and it is the half 19.3's *"silence must MEAN
  health"* depends on: a joiner whose UI says "verified" has turned silence into a claim.

**What would actually fix it, named so that its absence is a decision.** A signed, append-only
transparency log over `(spaceId, seq, chain)` with client-side continuity checking and cross-member
gossip — ADR 002 §8.6, *"the item most worth reconsidering if the threat model ever hardens"*. That
is the only construction in which a post-removal joiner verifies against a commitment the relay
cannot rewrite per device. Until it exists, R1–R5 are the whole of what an honest client may claim,
and E6 ships with a member who says „seit dem Beitritt geprüft" rather than one who says nothing.

---

### 4.2 The attestation allow-list moves with `X-LZP-Protocol` — the versioning contradiction, settled  *(round 10)*

Round 9 reconciled the *reasoning* (the paragraph above: a client parks, a publisher cannot) and
left the *mechanism* implicit — "the release order is the whole protocol". Implicit is what bites:
a v2.1 client minting a new attestation field against a relay one release behind gets
`400 bad_request { reason: "attestation_unknown_field" }` on `POST /devices`, which reads to a UI
as a malformed request and to a user as a Mac that will not pair, with nothing anywhere saying
*update the relay*. Made explicit here, and it needs no new surface:

> **The device-attestation allow-list is part of the HTTP surface, and is therefore versioned by
> `X-LZP-Protocol` like every other part of it.** A field enters the allow-list in protocol `N`. A
> client MUST NOT mint it until it has seen the relay answer `N` or higher — `GET /meta`'s
> `maxProto`, or the `X-LZP-Protocol` on any response. `400 attestation_unknown_field` from a relay
> whose `maxProto` is below the field's `N` is a **version signal**, and the client shows 22.4's
> quiet „Update verfügbar" for the SERVER rather than a pairing error.

**And this is where ADR 002 §2.3's forward-compatibility bullet is wrong, which is worth naming
because it looks like it contradicts the rule above.** §2.3 says `parseAttestationBlob` *"already
tolerates extra fields, deliberately, so a v2.0 client reads a v2.1 blob unchanged"*, offered as a
reason a seventh field is cheap. It is true of a **client reading a blob out of the member list**
and false of the **relay's door**, which refuses one — and the two are not in conflict, because
they are not about the same object:

- §4's **N+1 park rule** governs the **encrypted op stream**, which the relay never reads. Parking
  is available there, so parking is required.
- The **attestation blob** is not in that stream. It is an HTTP field the relay **stores and
  publishes** (`GET /spaces/:id/members`), so "park it" and "store it" are one act and a tolerant
  door is a free-text channel (finding R8-7). It is governed by `X-LZP-Protocol`.

ADR 002 §2.3 needs one sentence after that bullet to say so; it is **owed and is not this
document's to write** — recorded here and in `server/core/handlers/devices.js`'s §2 note.

**⚠ OPEN — a client cannot re-ask for ONE seq, and R8-2's bound makes that visible.**
`GET /api/v1/ops` can only be asked *"everything after `since`"*. Since round 9, a chain-witness
finding holds the cursor for the pull that discovers it and not after (ADR 002 §5.4 forbids the
witness blocking sync, and a permanent hold on a hole a member removal made unfillable wedges the
space — finding R8-2). The residual: a relay that withholds a row in the middle of a page and keeps
withholding it consumes that row on the second poll — permanently, one-sidedly, and LOUDLY.
Closing it needs either a bounded re-ask (`since = hole − 1`, ladder-bounded exactly as
`maxDeferrals` bounds a park — already permitted by this protocol and described by no ADR) or a
way to request one seq range. **Neither is chosen here: the retry count is a privacy trade as much
as a cadence, so it is a decision, not an implementation.** Recorded as FINDINGS §4.8 and pinned by
`tests/fleet/attack-converge-relay.test.js` §6b, which asserts the loss.

---

## 5. The server: models and what it can see

### 5.1 Prisma models (refining the addendum §3 sketch)

> **REFRESHED 2026-08-29.** `server/prisma/schema.prisma` and `MODEL_COLUMNS` are the authority —
> `tests/server/store-contract.test.js` parses the schema and compares it column by column — and
> this block had drifted from both in four places. It is corrected in place rather than annotated,
> because a sketch that disagrees with the schema is the thing an implementer reads first:
> `Member.recoveryPubKex` (finding E3-2), `Device.lastPushedSeq` (interface extension E2-I8),
> `KeyWrap`'s `recipientId`/composite key (finding E3-4) and its new `senderDeviceId` (finding
> E2E3-3), and `PairSession.burnedAt` (E2-I7).

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
  recoveryPubKex Bytes                          // 65 B raw P-256 (RK_kex). Finding E3-2: ADR 002
                                                //   §4.2 step 2 wraps to each member's RK_kex and
                                                //   had no public key to address. NOTHING SIGNS
                                                //   IT — see ADR 002 §4.2 step 2 as amended
                                                //   (finding E2E3-8): the FAMILY recovery wrap is
                                                //   suspended until the attestation carries it.
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
  spaceId      String                           // THE NAMESPACE OF deviceShort — round 10 item 8.
                                                //   Derived from member.spaceId; addDevice refuses
                                                //   a row where the two disagree
  memberId     String
  deviceShort  String                           // 16 Crockford base32 — the stamp tiebreak.
                                                //   NOT @unique any more; see @@unique below
  sigPubRaw    Bytes                            // 65 B
  kexPubRaw    Bytes                            // 65 B
  attestation  Bytes                            // signed by the member's recovery key. UTF-8 of the
                                                //   blob STRING on every write path (E2E3-7), and
                                                //   PUBLISHED by GET /members (E2E3-6, §3.6)
  lastSeenSeq  BigInt    @default(0)            // READ progress; reported on push, gates GC
  lastPushedSeq BigInt   @default(0)            // WRITE progress. E2-I8: read progress alone is
                                                //   unsafe — a device can be caught up on reads
                                                //   and still hold a 3-week-old unpushed edit
  addedAt      DateTime  @default(now())
  revokedAt    DateTime?
  member       Member    @relation(fields: [memberId], references: [id], onDelete: Cascade)
  @@unique([spaceId, deviceShort])              // round 10 item 8 — see below
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
  spaceId        String
  epoch          Int
  recipientId    String                         // a device id OR "rec_<memberId>" — finding E3-4.
                                                //   NOT a foreign key onto Device: a recovery
                                                //   recipient has no Device row
  wrapped        Bytes                          // {salt,iv,ct} — opaque
  senderDeviceId String                         // WHO DEPOSITED IT. Finding E2E3-3: ADR 002 §4.2
                                                //   step 6 makes the RECEIVER verify the sender,
                                                //   and admitWraps needs an index into its own
                                                //   verified set. STAMPED BY THE RELAY from the
                                                //   authenticated request, never read off a body;
                                                //   GET /keys publishes it as `senderKexPubRaw`
                                                //   by joining to Device.kexPubRaw. Not a foreign
                                                //   key, for the same reason recipientId is not
  @@id([spaceId, epoch, recipientId])           // the composite key IS the upsert target
  @@index([recipientId])
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
                    attempts Int @default(0)  expiresAt DateTime  burnedAt DateTime? }
// `burnedAt` is a TOMBSTONE, not a delete (E2-I7): a row a replayed pair/offer could re-create
// would reset the 5-attempt budget and make the 60-bit code the security parameter after all.

model Nonce { deviceShort String  nonce String  expiresAt DateTime
              @@id([deviceShort, nonce])  @@index([expiresAt]) }

model RateBucket { key String @id  count Int  windowStart DateTime }
```

#### The `deviceShort` namespace — the decision, the residual, and what it does NOT buy  *(round 10, item 8)*

`Device.deviceShort` was `@unique` **globally**. It is now `@@unique([spaceId, deviceShort])`.

**Why the old constraint was wrong in two directions.** `IK_sig` is minted per DEVICE (ADR 002
§2.1), so a Mac has one `deviceShort` for life, while `Device.memberId` names one `Member`, which
is per space. So one Mac could hold a row in exactly one space — while 19.4 and 15.2 require it in
two, and §10.2 of this document budgets *"8 members × 2 spaces"* of pull traffic. That is finding
E2-203-1, and it blocked the product. The second direction is sharper and is round 10's own finding
R10-7: **`deviceShort` is a function of a PUBLIC key**, and `GET /spaces/:id/members` publishes
`sigPubRaw` to every member of the space, while `POST /devices` is authorized by an attestation the
caller signs with her *own* recovery key. So any member of your circle could compute your short,
mint a row under it, and burn the one global slot your Mac would ever have — a permanent lockout,
one request, from inside the family. **A uniqueness constraint over a value everyone can compute is
not an identity check; it is a land grab with a queue.**

**Why per SPACE and not per member.** E2-203-1 proposed `@@unique([memberId, deviceShort])`. That
is one notch too loose: two different members of the *same* circle could then hold the same short,
and §2 step 4 would face two rows inside one space with nothing to choose on. Per space, the
resolution is exact — and it is what lets step 4 keep answering with a single member id.

**Why NOT "require a signature by the key being registered", the other option.** It is already
enforced everywhere it can be: `authenticate`'s bootstrap ladder binds the header's `device=` to
the key in the body, and steps 4b and 5 re-derive and verify on every later request. The one door
it is *not* on is `POST /devices` / `POST /devices/adopt`, which are **deliberately
unauthenticated** — authorized by the attestation under `Member.recoveryPubSig`. Adding a
possession proof there is a wire change to a door designed not to have one, and the namespace fix
makes it unnecessary for the reachable attack: a squatted row is now local to the squatter's own
circle and inert in it, because she still cannot authenticate as it.

> **⚠ RESIDUAL — finding R10-8a, OPEN.** She can still pre-empt a KNOWN Mac's short **inside her
> own circle** and keep that machine out of *that* circle. It needs the victim's `sigPubRaw`, which
> she has only if they already share a space — so it is a co-member's nuisance, inside ADR 002 §0's
> T5, and it is bounded to one circle. Closing it means giving `POST /devices` the same
> self-authenticating ladder the two bootstrap routes have (`BOOTSTRAP_ROUTES` becomes four), which
> is a client-transport change and is **owned by WP-8 / LZP-501**, not by the relay alone.

**What this does NOT buy: the cross-space join is now real, and no naming choice removes it.**
One Mac legitimately holds a row in every circle it belongs to, and those rows carry the same
`deviceShort` **and the same `sigPubRaw`**. `sigPubRaw` is the stronger join — 65 exact bytes the
relay must hold to verify a signature — so blinding or per-space-deriving the short would change
nothing. The only construction that removes it is a **per-space device signing key**, and ADR 002
§2.1 mints `IK_sig` per device; that is a client crypto change (pairing and A2 recovery would each
have to mint one per circle, and `Op.dv` and the authorization fold would need per-space shorts) and
nobody has costed it. Recorded, not fixed. `docs/v2/server-metadata.md` §7 states it as a dump
inference, and `tests/server/attack-relay-correlate.test.js` §2 measures both columns.

`@@unique([spaceId, deviceShort])` does mean a bare `WHERE deviceShort = ?` is not served by the
leading column of any index. **That is a speed bump for ad-hoc SQL and not a control**: the
operator owns the database and can `CREATE INDEX`. It is stated so nobody mistakes it for one.

### 5.2 The metadata inventory (LZP-207 → LZP-1001)

**Everything the server can observe, exhaustively:**

space ids and kinds · pseudonymous member ids · member **color refs** · join and removal
timestamps · device ids, device shorts and public keys · **device attestation blobs** · device
`lastSeenSeq` and `lastPushedSeq` · epoch numbers and rotation times · **which device deposited
each key wrap** · per-space op counts · **padded** envelope sizes (256-byte buckets) · op
**arrival** times · the chain hashes · invite id hashes, epochs and expiry · IP addresses in
transit · Vercel's own request logs.

> **Two of those are new on 2026-08-29 and neither widens what the relay knows** — which is why
> neither adds a sentence to the Datenschutz copy, and why that claim is checked rather than
> asserted (`tests/server/rotation-wire.test.js` §6, `blindness.test.js` §7).
>
> · **`Device.attestation`** was already stored and is now also *published to members of the same
>   space* (finding E2E3-6). Every field inside it is a column above — `memberId`, `deviceId`,
>   `deviceShort`, `sigPubRaw`, `kexPubRaw` — plus `createdAt`, a DAY, coarser than the `addedAt`
>   the relay keeps to the millisecond. The payload's field set is CLOSED at every write path, so
>   there are no free bits and the blob is not a channel. And every member could already read the
>   same blob out of the E2EE stream (ADR 002 §2.3).
> · **`KeyWrap.senderDeviceId`** is stamped by the relay from the request it authenticated
>   (finding E2E3-3). It carries no client-chosen bits — `readWraps` refuses the field on a body —
>   and states nothing the relay did not observe when it checked that signature.

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
