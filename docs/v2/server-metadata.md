# What the relay can see

**LZP-207.** Derived by reading `server/prisma/schema.prisma`, `server/core/store-interface.js`
and all 23 handlers — not by reading ADR 003 §5.2. Where the two disagree, §9 of this document
says so and this document is the one that was checked against the code.

This feeds deliverable 21.3, the Datenschutz text. **It is deliberately not reassuring.** A
privacy page written from a list that quietly omits three columns is worse than no page, because
it is a promise the operator's own database can be shown to break. Everything below is either a
column that exists, a value a handler really computes, or an inference an operator could really
draw with SQL and no cryptography.

Throughout, **"the operator"** means anyone with the production database: the PO, Prisma's staff,
Vercel's staff, anyone who compromises any of them, and anyone with a lawful order addressed to
them. **"The relay"** means the running server. They see different things and both are listed.

---

## 1. The one-paragraph answer

The relay holds **who is in which circle, on how many machines, since when, and how much they
write, minute by minute** — and not one byte of what they wrote. Every entry, bar, category,
scratchpad line, display name and date is inside AES-256-GCM ciphertext whose key the relay has
never held and cannot derive. What is left is a **social and behavioural shadow** of the family:
its size, its shape, its rhythm, its changes and the day each one happened.

That shadow is not nothing, and §5 and §6 are about how much of it can be reconstructed.

---

## 2. Every column, and what it tells an operator

The column set is closed. It is declared twice — in `schema.prisma` and in `MODEL_COLUMNS` —
and `tests/server/blindness.test.js` §2 asserts the two agree field by field and that every
column falls into exactly one of four buckets: opaque bytes, a timestamp, a scalar, or a String
with a written justification.

### `Space`

| column | what it is | what it reveals |
|---|---|---|
| `id` | `fsp_`/`psp_` + 22 b64url | a random handle. The **prefix says whether this is a family or a personal space**, and so does `kind`. |
| `kind` | `PERSONAL` \| `FAMILY` | that this row is a household rather than one person's two Macs. |
| `currentEpoch` | integer | **how many times this family's key has been rotated** — see §6, the most informative number in the schema. |
| `nextSeq` | bigint | **the total number of ops this family has ever written**, including ops later purged. A lifetime activity counter that never goes down. |
| `headChain` | 32 bytes | opaque. Diagnostic only. |
| `createdAt` | timestamp | when the circle was created. |

### `Member`

| column | what it is | what it reveals |
|---|---|---|
| `id` | `mem_` + 22 b64url | pseudonymous. No name, no email, no phone — nothing links it to a person except behaviour. |
| `spaceId` | relation | **which household this person belongs to.** |
| `colorRef` | a palette word, in German (`gruen`, `blau`, …) | **THE ONE DELIBERATE PLAINTEXT LEAK.** Story 15.3 needs `@@unique([spaceId, colorRef])` server-side to stop two people picking the same colour, and that cannot be evaluated inside ciphertext. It reveals one palette index per member. It is the only String in the whole schema that carries a user's *choice*, and `blindness.test.js` asserts that it is still the only one. |
| `recoveryPubSig`, `recoveryPubKex` | 65-byte P-256 points | **public** keys. They reveal nothing on their own and are stable identifiers for as long as the member exists. |
| `joinedAt` | timestamp | **the day and second this person joined the family.** |
| `removedAt` | timestamp or null | **the day and second they were removed or left — retained after the fact.** A departure is permanently legible. |

### `Device`

| column | what it is | what it reveals |
|---|---|---|
| `id` | `dev_` + 22 b64url | a label the relay assigned. |
| `spaceId` | relation | **which circle this machine's membership is in.** Added round 10 as the namespace of `deviceShort` (ADR 003 §5.1). It is DERIVED — the relay already resolved it through `memberId → Member.spaceId` — so it reveals no fact the dump did not already contain. What changed the dump is not this column but the rows it permits: see inference 5. |
| `memberId` | relation | **which machines belong to which person.** The count is the interesting part: see §5. |
| `deviceShort` | 16 Crockford chars | derived from the device's **public** signing key. It is the key every op row is attributed by, so it is the join column for a per-machine activity history — and, since round 10, one Mac in three circles has this same value in three rows. Inference 5. |
| `sigPubRaw`, `kexPubRaw` | 65-byte P-256 points | **public** keys. |
| `attestation` | opaque bytes | signed by the member's recovery key; the relay cannot verify it and never reads it. **No endpoint returns it** — see finding E2-207-B in `E2-VERIFICATION.md`. |
| `lastSeenSeq` | bigint | **read progress: how far this machine has caught up.** Updated on every push. A machine whose `lastSeenSeq` is far behind the space head has been off for a while. |
| `lastPushedSeq` | bigint | **write progress: the space head at the moment this machine last confirmed an empty outbox.** A machine whose `lastPushedSeq` lags its own `lastSeenSeq` is **holding unsent edits** — the relay can see that somebody has written something they have not yet sent. |
| `addedAt` | timestamp | **when this Mac was added.** A second row under one member is a second machine, and §6 says what that means. |
| `revokedAt` | timestamp or null | **when a machine was revoked — retained.** A lost or stolen laptop is permanently legible as an event. |

### `Op` — the log

| column | what it is | what it reveals |
|---|---|---|
| `spaceId`, `seq` | the per-space gapless counter | ordering, and **exactly how many ops exist**. `seq` is per space and never global, which is deliberate: a global sequence would leak cross-family activity volume. |
| `opId` | 22 b64url, random | nothing by itself. It is stable, so it correlates a retry with its original. |
| `epoch` | integer | **which key era this op was sealed under.** Sorting the log by `seq` and reading `epoch` gives the exact position of every rotation in the family's history. |
| `deviceShort` | 16 chars | **which machine wrote it.** Present because 20.2's purge and ADR 003 §3.1's `e.dv` check both need it. It is what turns the log into a per-machine activity timeline. |
| `witness` | 32 bytes or null | opaque. **Null means this was that device's first push** (ADR 002 §5.1), so the column marks a machine's very first write. |
| `chain` | 32 bytes | opaque. |
| `envelope` | `iv ‖ ct ‖ sig`, padded | **unreadable.** Its LENGTH is not — see §4. |
| `receivedAt` | timestamp, millisecond | **the arrival time of every single operation.** Not the authoring time: that is inside the ciphertext and stays there. In practice they differ by however long the device was offline, which is usually seconds. This column plus `deviceShort` is the whole of §5. |

### `Epoch`, `KeyWrap`

| column | what it reveals |
|---|---|
| `Epoch.spaceId`, `epoch`, `createdAt` | **the exact timestamp of every key rotation.** |
| `KeyWrap.spaceId`, `epoch`, `recipientId` | **the complete recipient set of every rotation**, as either a `dev_…` id or the reserved `rec_<memberId>` form. This is the single most informative structure in the database and §6 is about it. |
| `KeyWrap.wrapped` | opaque `{salt,iv,ct}`. |

### `Invite`

| column | what it reveals |
|---|---|
| `id` | HKDF of the code. The raw code never reaches the server, so the relay cannot redeem an invite it holds. |
| `verifier`, `wrapSalt` | opaque. `wrapSalt` is **server-generated** and means nothing under D9 — it is not a place a client can park chosen bytes (finding E2-203-4). |
| `spaceId`, `epoch`, `expiresAt` | which circle, which key era, and the 7-day window. |
| `createdBy` | **which member issued this invitation.** |
| `usedAt`, `revokedAt` | **whether it was accepted, when, or withdrawn — retained.** An invitation that was sent and never accepted is legible for its whole 7 days and after. |

There is **no** `wrappedKeys` column, by PO decision D9, and no column to put one in.

### `PairSession` — a second Mac being added

| column | what it reveals |
|---|---|
| `rid` | HKDF of the 60-bit pairing code. The relay never learns the code. |
| `boxA`, `boxB`, `delivery` | opaque. But **whether each is null is the state of the pairing**: offered / answered / delivered. |
| `attempts` | **how many anonymous reads this rendezvous has taken** — i.e. how many times somebody tried and failed. |
| `expiresAt`, `burnedAt` | the 180-second window, and whether the pairing was burned rather than completed. **A burn is a tombstone and is retained**, deliberately: a row a replayed offer could re-create would reset the attempt budget. |

So the relay sees, per pairing: it started, it got this far, and it succeeded or it did not.

### `Nonce` — the replay window

`(deviceShort, nonce, expiresAt)`, one row per authenticated request, TTL 5 minutes.

**This is a rolling five-minute log of every request every machine made, keyed by machine.** It is
swept lazily on write (Hobby has no cron), so on a quiet relay rows can outlive their TTL until
the next write comes through. It carries no route, no path and no body — but its row *count* per
`deviceShort` is a per-machine request rate at five-minute resolution, and it exists in the
database rather than only in a log file.

### `RateBucket` — and the one place an IP is stored at rest

`key`, `count`, `windowStart`. The key is `JSON.stringify([rule, identity])` — never a join, never
content. For the four per-IP rules the identity **is the caller's IP address**:

```
["inviteRedeem","203.0.113.7"]      1 hour
["pairGet","203.0.113.7"]           1 hour
["spaceCreate","203.0.113.7"]       1 hour
["deviceRegister","203.0.113.7"]    1 hour
["deviceAdopt","203.0.113.7"]       1 hour
["pairRidMiss","203.0.113.7"]       1 minute
["push","<deviceShort>"]            1 minute
["pull","<deviceShort>"]            1 minute
["pairSession","<memberId>"]        1 hour
["memberRemove","<memberId>"]       1 hour
```

ADR 003 §5.2 says *"IP addresses in transit"*. That is not the whole truth and the Datenschutz
copy must not repeat it: **an IP address is written into a database row.** It is not joined to a
space, a member or a device by any column — the bucket key holds the rule name and the IP and
nothing else — but it is at rest, and any dump has it.

**How long.** The *count* is meaningful for at most the rule's window (an hour for the per-IP
rules). The *row* is not deleted when the window ends: `rateAllow` replaces `{count, windowStart}`
and leaves the `key`. Nothing sweeps `RateBucket`. So the honest answer is **the address stays
until somebody deletes it**, and §11 says what that would take.

---

## 3. What is NOT in the schema, and cannot be added quietly

No note text · no bar label · no category · no scratchpad · no entry date · no display name · no
authoring time · no email address · no phone number · no password or password hash · no role or
admin column · no `wrappedKeys` on an invite.

Three mechanisms, not one convention, keep that true:

1. **The column set is closed.** `normalizeRow` throws `StoreShapeError` on any column not in
   `MODEL_COLUMNS`, at the adapter boundary, in memory, in a file and in Postgres.
2. **Ciphertext columns are typed.** `OPAQUE_FIELDS` refuses a `String` where bytes belong, so
   `envelope = 'Zahnarzt'` is a throw rather than a review comment.
3. **Forbidden name tokens.** `displayname`, `plaintext`, `notetext`, `barlabel`, `category`,
   `scratchpad`, `title`, `caption`, `authoredat`, `role` and `wrappedkeys` may not appear in any
   column name in either declaration.

`tests/server/blindness.test.js` runs a realistic family session through the real router and then
searches the entire store — every row, every value, and for the file adapter the raw bytes on
disk — for the German text that was typed. It finds none, and a control case proves the search
would find one if it were there.

---

## 4. Sizes: what the padding does and does not hide

Envelopes are padded to 256-byte buckets before sealing (`PAD_BUCKET`, ADR 002 §5.3). The stored
`envelope` column is `iv(12) ‖ ct ‖ sig(64)`, and `ct` is the padded plaintext plus a 16-byte GCM
tag, so:

```
len(envelope) = 92 + 256·k        k = 1, 2, 3, …
```

Two real rows from the demonstration in `E2-VERIFICATION.md` §2: **604 bytes** (k = 2) and
**1372 bytes** (k = 5).

**What this hides:** the exact length of a note. „Zahnarzt" and „Zahnarzt Mama 14:30 Dr. Weber
Hauptstraße" are the same row.

**What it does not hide:** the size *class*. An operator reads `k` off the column with arithmetic.
A one-line note and a bar carrying a 40-character label and a `dev.*` attestation blob are
visibly different sizes, and `k` is a lower bound on how much was written. It is a coarse
measure, not a null one.

---

## 5. Request patterns: the rhythm of a household

The client pulls on a timer whose period depends on whether a window is visible — ADR 003 §8.2's
cadence table, not §10, which is "Known weaknesses":

```
timer, window visible   every 45 s ± 15 s jitter
timer, window HIDDEN    every 10 min  (the push cadence is unchanged)
```

Each pull is an authenticated request that writes a `Nonce` row and bumps a `RateBucket`. Each
push writes `Op` rows carrying `receivedAt` and `deviceShort`.

**The hidden cadence is the correction that matters, and this document had it wrong.** An earlier
draft said the pull cadence *stops* when the window is not visible. It does not: a Mac with the
app running behind other windows — the ordinary state of a calendar — emits a heartbeat every ten
minutes. That is the difference between *"the relay knows when you were looking at your calendar"*
and *"the relay knows your Mac was on"*, and the second is the true and the larger statement.

### The three requests that are not a poll

A poll says a machine is on. The client also makes three requests that are **event-driven**, and
each one timestamps a human action to the second (`family/engine.js`, ADR 003 §8.2's last rows):

| trigger | what goes out | what it timestamps |
|---|---|---|
| `visibilitychange` → visible | an **immediate** pull | **the moment somebody brought the calendar to the front.** Not "the Mac is on" — "she looked at it, now". |
| `online` | an **immediate** pull | **the moment this Mac's network came back**: the lid opened, the train left the tunnel, the café wifi connected. |
| `pagehide` | a force-flushed **push** | **the moment the app was quit or the window closed.** |

Together they bracket a session — opened at 08:12, looked at 08:12, 09:40 and 14:03, quit at
18:31 — and they are strictly more identifying than the poll above them. The cadence itself is
right and deliberate: a stale board when a person has just looked at it is a real cost. But a
Datenschutz page that says only „alle 45 Sekunden" is describing the least revealing half. It
should say plainly that **the app talks to the server when you look at it and when you close it.**

### The headers every request carries

This document enumerates database columns (§2), sizes (§4) and the transport headers the *server*
sets (§8). Until now it had no section for the headers the **client** sends. There are three, and
`tests/attack/privacy-e5-metadata.test.js` §1 asserts that they are the whole client-supplied
surface — no cookie, no session, no bearer token, no `User-Agent`, no `Referer`, no
`X-Forwarded-For`.

| header | value | what it reveals |
|---|---|---|
| `X-LZP-Client` | the **client version**, e.g. `2.0.0` | the exact build running on each `deviceShort`, on every request. Because the value changes, it also gives **the minute each Mac was updated** — cross-referenced with a release date, a machine-level upgrade timeline for the household. It is a fingerprint that separates two machines before any `Device` row is joined, and one that **survives a device revocation and re-adoption**. |
| `X-LZP-Protocol` | the protocol number | with `X-LZP-Client`, the N−1 window this client is inside — i.e. how far behind it is allowed to be, which is a proxy for how long it has been neglected. |
| `Authorization` | `LZP1 device=…, ts=…, nonce=…, sig=…` | `device` is the `deviceShort`. `nonce` is the `Nonce` table of §2. **`ts=` is the client's own wall clock in milliseconds**, compared by the server against its own inside a 120 s window — so the relay reads, on every request, **the exact offset between each Mac's clock and its own**. Clock drift is a property of the hardware and of whether the machine syncs NTP, so that offset is a stable per-machine fingerprint that survives everything else. |

Neither is a defect in the protocol. ADR 003 §4 needs the version for the N−1 rule and ADR 003 §2
needs the timestamp for the replay window; the mitigation and the leak are the same mechanism, and
there is no version of this protocol without them. They are **undocumented observables**, and the
Datenschutz page owes two sentences: „Jede Anfrage nennt die Version der App." and „Jede Anfrage
nennt die Uhrzeit des Macs, damit alte Anfragen nicht wiederverwendet werden können."

### The URL every pull carries — and therefore the platform's request log

§8 is careful and correct about one URL: `/api/v1/pair/<rid>` puts the pairing rendezvous id into
a URL *path*, and a platform request log is exactly where a URL path goes. It named only that one.
Every pull this product makes is

```
GET /api/v1/ops?limit=500&since=<cursor>&space=psp_<22 chars>
```

so **the space id and the device's read position are in a URL query string, on every request, at
the 45-second cadence.** By §8's own argument they are therefore in Vercel's request log, whose
retention and access are Vercel's terms and not ours. The space id is the join key for everything
in §2; the cursor is `Device.lastSeenSeq` restated. **An operator with only the platform log — no
database at all — can reconstruct this section's entire activity timeline per space.**

Two more paths carry a space id in the path rather than the query: `/api/v1/spaces/:id/members`
and `/api/v1/spaces/:id/keys`.

### The twelfth path — `POST /api/v1/spaces/:id/delete` (19.4, 2026-09-13)

The only path in this product whose purpose is to make the relay hold **less**. „Privaten Raum
auflösen" in „Server & eigene Geräte" sends it for a `psp_` space, and the relay cascades that
space's Member, Device, Op, epoch, KeyWrap and Invite rows away (`store.deleteSpace`, contract
cases C09..C11). No `adminProof` is carried or needed: a private room has exactly one Member row,
and `handlers/lifecycle.js` requires the second member's co-signature only above one.

**What it tells the operator.** One request, naming one space id that the operator already holds —
it is the same id that has been in every cadence query string since the room was armed — and after
it there are no further requests from that Mac at all. So it adds no new fact to §2 and removes
the rows that §2 is about. It is never on the cadence: it is reached once, from a typed
confirmation, and the Mac goes silent afterwards.

**Why it exists at all**, beyond privacy: a Mac mints one device identity for life, and the relay
refuses a device id it already holds anywhere. So a Mac that had armed the private room could
never join a Familienkreis, and until this path was wired nothing in the product could clear the
row that refused it. Deleting is what frees it; revoking is not, because the refusal does not care
whether a row is revoked.

### The ninth path — `POST /api/v1/feedback` (LZP-1009)

Added when „Rückmeldung senden" was bound to a transport (`family/mount.js#bindFeedback`), and it
is the **only** path a Mac with no Familienkreis and no own-device sync can ever address. It is
never on the cadence: it is reached once, when a person has written a sentence, read the entire
payload on the preview screen, and pressed „Senden".

What the platform's request log therefore records is `POST /api/v1/feedback`, a source IP, a
timestamp and a byte count — **the fact that somebody reported something, and when.** There is no
space id in the path and none in the query; there is no space id in the body either, because
`server/core/handlers/feedback.js` holds no space and is given none. The report carries an
optional device signature, so an operator can tell two reports from one Mac apart from two reports
from two Macs (`proves: device_continuity`) — which is the point of it, and it is stated on the
preview screen before anything is sent.

The relay's own record is whatever `ctx.feedbackSink` is configured to be. `server/dev-server.mjs`
writes two files beside the store; `server/adapters/vercel.js` binds no sink at all, so the
deployed relay answers **501 not_implemented** — honestly, rather than accepting a report and
dropping it. That is a deployment step the RUNBOOK still owes.

### What an operator derives from all of it

An operator with the database and nothing else can derive, per machine, per day:

- **when that Mac is awake and has the app open** — and, because of the ten-minute hidden
  heartbeat, this holds whether or not anybody is looking at the window;
- **when somebody looked at the calendar, and when they quit** — the three event-driven requests;
- **when a person is actually editing** — pushes are event-driven, pulls are not;
- **the working rhythm of a household**: who writes in the morning, who writes at 23:00, who
  writes only at weekends, and which machine goes quiet for two weeks in August;
- **who is currently offline**, from `lastSeenSeq` against the space head;
- **who is holding unsent edits**, from `lastPushedSeq` against `lastSeenSeq`.

None of this needs the ciphertext and none of it is defended against. It is the price of a relay
that answers in real time, and it is what a Datenschutz page should say plainly rather than
imply is covered by "end-to-end encrypted".

**What bounds it in practice, honestly stated:** the family is 2–8 people, so the shadow is small
and specific rather than large and anonymous. That makes it *more* identifying, not less.

**What genuinely is not there — and the one qualifier that sentence has always needed:**
solo mode makes **zero requests** *to this relay* (ADR 003 §7, four independent gates,
`tests/tier1/network-scope.test.js`). A person who never joins a circle has no rows at
all — not an empty account, no account.

That is a true statement about **this relay's database**, and it has been read as "no traffic".
The two are not the same: see §8 on the **release host**, the second remote this product contacts,
which a solo install with updates enabled reaches on every launch.

---

## 6. What a rotation row implies about a family event

This is the sharpest inference in the schema and it deserves its own section, because it is the
one an operator can draw without any cleverness.

Rotation is not routine. `ROTATION_TRIGGERS` in `src/js/crypto/spacekeys.js` fires it on member
join, member removal and member departure (family space) and on device pair/unpair (personal
space) — and never on a rename, a profile edit or an admin transfer, because none of those
changes who can read what. The server's coverage check (`assertCoverage`) then forces every
rotation to address **every current, non-revoked device of every non-removed member, plus each
member's recovery key, for every epoch 1..e**. So the `KeyWrap` recipient set at epoch *e* is an
exact census of the family at the moment epoch *e* was created — and the diff between consecutive
epochs names the event:

| what changed between epoch *e* and *e+1* | what happened, in the house |
|---|---|
| one new `dev_…` **and** one new `rec_<memberId>` | **somebody joined the family.** Cross-check: a `Member` row with a matching `joinedAt` and an `Invite` with a matching `usedAt` and a `createdBy` — so the operator also learns **who invited them**. |
| one `dev_…` and one `rec_…` disappear | **somebody was removed or left.** `Member.removedAt` says which and when; `POST /members/remove` also **purges that member's `Op` rows in the same transaction**, so their `seq` numbers are simply missing from the log — and counting the gaps says **how much that person had written before they left.** |
| one new `dev_…` under an **existing** member | **that person added a second Mac.** `ROTATION_TRIGGERS['device.pair']` is scoped to the PERSONAL space, so the family rotation is not triggered by the pairing itself — it is *forced* by the coverage rule: the new device holds no family wrap, `GET /spaces/:id/keys` answers `keysPending: true` for it, and the next rotation any member performs must cover it. Either way the recipient set gains a device under an existing member, and a `PairSession` row with a matching `burnedAt` corroborates it. |
| one `dev_…` under an existing member disappears | **a machine was revoked.** `Device.revokedAt` is retained. In a household, "Papa revoked a device on 14 March" has one obvious reading and several less obvious ones, and the relay cannot tell them apart — but it can see that it happened. |

`deleteKeyWrapsForDevices` purges the stale rows, so a **single** dump shows only the survivors.
It does not help much: `Member.removedAt`, `Device.revokedAt`, `Device.addedAt`, `Member.joinedAt`
and `Epoch.createdAt` are all retained, so the timeline reconstructs from one dump anyway, and an
operator who keeps backups has the diffs as well.

**A rotation timestamp is therefore a family-event timestamp.** Not a labelled one — the relay
cannot tell "Mama got a new MacBook" from "Papa's laptop was stolen" — but a real one, to the
second, with the affected person's pseudonymous id attached.

---

## 7. What a database dump reveals

Everything in §2, at once, joined. Concretely, for one household:

- **how many people are in it, and how many machines each of them has** — including the fact that
  one person has three Macs and another has one;
- **the order they joined in, to the second, and who invited whom**;
- **who has left, and when**;
- **how much each person has written**, as an op count per `deviceShort` — and, for a removed
  member, how much they *had* written, from the gaps their purge left in `seq`;
- **the complete activity timeline** of §5;
- **every key rotation and, by §6, the family event behind each one**;
- **each member's colour**;
- an **IP address** for any per-IP limiter that fired within the last hour;
- for each pairing ever attempted: that it happened, how far it got, and whether it burned.

### Six things the tables above imply and never say out loud

§2 and §3 are claims about **columns**, and they are true. These six are claims about the
**dump**, and a Datenschutz page written only from the column tables would miss every one of them.

*(Was five. The sixth arrived on 2026-09-05 with LZP-1009's second pass, because a report is now
**kept**. It is §7.6, and it is the one thing about that change that a person is entitled to be
told before they press „Senden".)*
Each was demonstrated against the real router in `tests/server/attack-relay-infer.test.js` and
`tests/server/attack-relay-correlate.test.js`.

1. **The relay can tell which member is admin — four independent ways.** §3 lists "no role or
   admin column" among the things that cannot be added quietly, and that is true and it is not the
   question. (a) **The founder:** the earliest `Member.joinedAt` in a family space created the
   circle, because every other member arrived through an invite that row predates — one `ORDER
   BY`. (b) **The issuer:** inviting is admin-only (20.1) and `Invite.createdBy` records it.
   (c) **The remover:** `RATE_RULES.memberRemove` is keyed on the *acting* member, so removing
   somebody writes `["memberRemove","mem_…"]` into `RateBucket.key`, and only the admin removes
   members. (d) **The transfer:** `POST /members/transfer` stores nothing — the handler says so on
   the wire — but the running relay sees both ends of it, the caller being the outgoing admin and
   the body naming the successor, and the application log keeps the line. In a household the admin
   is a specific person, and *"the relay can tell which of the five of you is in charge"* is
   exactly the kind of sentence 21.3 exists to say out loud.

2. **A member in another time zone is visible as a shifted activity window.** §5 gives the raw
   material — "when that Mac is awake", "who writes at 23:00" — and stops there. The conclusion it
   does not draw is that the **offset** between two members' quiet windows locates one of them in
   a different **time zone**: an au pair at home for the summer, a parent posted abroad, a child
   at university on another continent. No ciphertext, no IP, one `GROUP BY` over
   `Op.receivedAt`.

3. **`RateBucket`'s member-keyed rules are a per-member action record, at rest, unswept.** §2 and
   §11 are honest that the row **survives indefinitely** and frame that as a problem about IP
   addresses. The member-keyed rules survive identically and say something different: not
   "somebody at this address", but **"this member did this thing"**. `["memberRemove","mem_…"]`
   and `["pairSession","mem_…"]` outlive the counters they were created for and outlive the
   membership they recorded, and each one **names the actor** in a table whose stated purpose is
   abuse defence.

4. **The application log's `route` is a named per-member event feed.** §8 lists the seven fields
   the log may carry and then says what is *not* in it. It never says what the fields that **are**
   in it mean together: `(route, spaceId, deviceShort)` at a timestamp, with `LOG_ROUTES` a closed
   enum of 27 verbs (AUDIT F12, corrected 2026-09-04 — `feedback` is the 24th; **LZP-1009 second
   pass, 2026-09-05 — `reportsList`, `reportsGet` and `reportsDelete` are the 25th, 26th and
   27th**; asserted against the live enum by `tests/server/datenschutz-claims.test.js` §1), is
   *this machine renamed the circle / invited somebody / removed somebody /
   handed over the admin role* — and `deviceShort` maps to a member by one join. **The log line
   names the event.** `renameSpace` is the sharpest case: the handler stores nothing, is
   documented as storing nothing, and the log still records that the family renamed its circle on
   25 July.

   ⚠ **The three new verbs are NOT of that kind, and the count moving from 24 to 27 overstates
   what changed.** `reportsList` / `reportsGet` / `reportsDelete` carry **no `spaceParam`**, are
   not in `SPACE_SCOPED`, and their rate rules are `identity:'ip'` — so their log lines say
   "somebody at some address read the operator's inbox" and cannot say more. The only party who
   can produce one is the holder of the private half of `LZP_REPORTS_ADMIN_PUB`. They widen the
   enum; they do not widen what the enum can say about a family. **What genuinely changed is
   §7.6.**

5. **Two circles can be attached to one person — cross-space correlation.** §7's dump list and
   §2's tables were written for a single-space world. Three joins work **across spaces**, and the
   relay holds every household at once. *(Updated round 10: the first of these was LATENT until
   the schema permitted the rows. It is now actual — see ADR 003 §5.1 for why the change was
   taken anyway, and why no namespace choice would have avoided it.)*
   - `Device.deviceShort` is derived from a device's public signing key and is unique per machine
     **across the whole database** — the constraint is now scoped per space, but the VALUE is
     still a function of one `IK_sig` and that key is minted per machine, not per circle. So one
     Mac in three circles is three rows carrying one short **and one `sigPubRaw`**. The public key
     is the stronger of the two: 65 exact bytes the relay must hold in order to verify a
     signature at all, so it cannot be renamed, blinded or scoped away. Only a per-space device
     signing key would remove this join, and ADR 002 §2.1 does not mint one. The `@@unique([spaceId,
     deviceShort])` index means a bare `WHERE deviceShort = ?` is a scan rather than a seek — a
     speed bump for ad-hoc SQL, **not a control**, since the operator can build any index.
   - `Member.recoveryPubSig` / `recoveryPubKex` — §2 calls them "public keys … stable identifiers
     for as long as the member exists". Both halves are true and the sentence misses the point: a
     **stable identifier is exactly what a JOIN needs**, and the scope that matters is not "as
     long as the member exists" but "across every space in the database". No constraint forbids
     the same recovery point appearing in two spaces, and nothing in the product warns anybody.
   - **Timing alone.** §5's rhythm is a link **between households** as well as a portrait of one:
     two circles with no column in common can be attached to one person by arrival times, with no
     cryptography and no IP address.

6. **Who a retained report came from — the report/device join.** *(New, 2026-09-05 · LZP-1009
   second pass · PO decisions 1 and 4.)* Until now a feedback report took no custody: the relay
   answered 501 and nothing was written. `Report` changes that — seven columns, a 90-day
   `expiresAt`, **no `spaceId` and no relation to `Space`**, so a report can never appear on a
   family's board. That structural guarantee is real, and it is not the guarantee this section is
   about.

   `Report.devicePub` on a **signed** report is the raw uncompressed P-256 point of the sending
   device — **byte-identical to `Device.sigPubRaw`**, because it has to be, or the signature could
   not be verified. `Report` has no foreign key to `Device`, but a foreign key is not what a join
   needs; equal bytes are. One `JOIN … ON Report.devicePub = Device.sigPubRaw` names the device;
   `Device.memberId` names the member; `Member.spaceId` names the circle; and §5's rhythm names
   the household. **The prose is plaintext** (`blindness.test.js:215` pins it as the second and
   last deliberate content-bearing String, beside `Member.colorRef`), so the result of that join
   is a named person's own words.

   **This is not defended against and must not pretend to be.** The operator is the intended
   reader: a report he cannot attribute is a report he cannot answer, and story 21.5's whole
   argument for keeping a report at all is that somebody reads it. What is owed is that it be
   **said** — `DATENSCHUTZ.*.infer6`, asserted by `tests/server/datenschutz-claims.test.js` §8.

   The bound, stated with it: an **unsigned** report — every report a solo Mac sends, which is the
   case the second pass exists for — carries **no `devicePub` at all**. `signed: false`, and
   `PROVES.unsigned` says so on the wire. There is nothing to join. So the disclosure is exact
   rather than general: *a report from inside a Familienkreis is attributable; a report from a
   solo Mac is text, an image and a time.*

What a dump does **not** reveal: a single word anyone wrote, a single date anyone entered, a
single person's name, or which of the pseudonymous ids is which human. The link from `mem_…` to a
name exists only inside the ciphertext, as `member.set{displayName}` ops, and inside the heads of
the people in the circle.

**The realistic re-identification path is not the database — it is the IP address.** A residential
IP plus a household of five with a shared activity rhythm is not anonymous to anyone who can also
see the ISP's records. The pseudonymity of `mem_…` is real and it is not the whole story.

---

## 8. Region, transport and third parties

- **Frankfurt.** `server/vercel.json` pins `regions: ["fra1"]`; Prisma Postgres spells the same
  datacentre `eu-central-1`. Decision D2. `.github/scripts/check-server-config.mjs` fails the
  deploy on any other value, because the Datenschutz text names the region and changing one
  without the other makes the copy false.
- **TLS in transit**, HSTS on `/api/*`, `Cache-Control: no-store` so encrypted batches do not sit
  in an intermediary cache, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  and **no `Access-Control-Allow-Origin`** — the client is a desktop app, not a browser origin.
- **Vercel's own request logs** are outside this schema and outside the application's control.
  They record method, path, status, timing and source IP for every request. `/api/v1/pair/<rid>`
  puts the pairing rendezvous id — HKDF output of the pairing code — **into a URL path**, and a
  platform request log is exactly where a URL path goes. The application's own log never writes a
  path (`LOG_ROUTES` is a closed enum of the 27 route names); the platform's does. Retention and
  access there are Vercel's terms, not ours, and the Datenschutz page must name Vercel and Prisma
  as processors.
- **Application logs** carry at most `{route, spaceId, deviceShort, opCount, byteCount, status,
  ms}` — seven fields, allowlisted by name *and* by shape, so a value that does not look like what
  it claims to be is dropped rather than written. No IP, no path, no body, no ciphertext.
  `blindness.test.js` §5 asserts this over a real session. What the seven fields mean *together*
  is §7's fourth inference, and it is sharper than the list suggests.
- **The client's own URLs go into the platform log too**, and there are more of them than the
  pairing path: see §5's "the URL every pull carries". Every 45 seconds, a space id and a read
  cursor.

### The second remote: the release host

**This product contacts two hosts, and only one of them is the relay.** The macOS shell's updater
fetches a static **release** manifest — Tauri v2's `latest.json`, from the host configured in
`src-tauri/tauri.conf.json` — to decide whether a newer build exists. That is an entirely separate
operator, an entirely separate request log, and it appears in no privacy document.

- It is **disclosure-gated**: `src/js/platform/updater.js` and story 21.5 require the user to have
  been told before the first check, and the settings switch turns the **request** off and not
  merely the hint (`tests/tier2/update-ui.dom.js`). So it is a real request that a person has
  agreed to, not a hidden one.
- What leaves the machine is *"some Mac asked for latest.json"* — no space, no member, no device
  id, no board. What the release host's own log necessarily sees is the **IP address, the time,
  and the fact that this Mac is running this app**, on the update-check cadence, for **solo
  installs as well as family ones**.
- That is why §5's sentence *"a person who never joins a circle has no rows at all — not an empty
  account, no account"* needs its qualifier. It is true of **this relay's database**. It has been
  read as "no traffic", and for a solo install with updates enabled that reading is wrong.

**There is no `docs/v2/datenschutz.md` yet.** When it is written it must name **two** remotes and
two processors, not one — and this document is the source for only the first of them. Owner:
LZP-207 / the PO. (Finding P-2, recorded in E1 and again by the E5 privacy adversary.)

---

## 9. Where this document is wider than ADR 003 §5.2

§5.2's inventory says "everything the server can observe, exhaustively". Reading the schema and
the handlers, it is not exhaustive. None of these is a defect in the *server*; each is a sentence
the Datenschutz copy would otherwise be missing, which is why LZP-207 was told to derive this
from the code.

| not in §5.2 | why it matters |
|---|---|
| `Device.lastPushedSeq` | §5.2 lists `lastSeenSeq` only. Write progress reveals **unsent edits**, which read progress does not. |
| `Device.addedAt`, `revokedAt` | when a machine was added and when it was revoked — §6's device-level events. |
| `Invite.createdBy`, `usedAt`, `revokedAt` | **who invited whom**, and whether an invitation was ever accepted. |
| `Op.epoch` | places every rotation exactly in the log. |
| `KeyWrap.recipientId` | §5.2 does not mention the recipient set at all, and it is the structure §6 is built on. |
| `Space.nextSeq` | a lifetime op counter that survives purges. |
| the `Nonce` table | a rolling five-minute per-machine request record, in the database. |
| **an IP address in `RateBucket.key`** | §5.2 says IPs are "in transit". For up to an hour they are also **at rest**. This one is a correction, not an addition. |
| `Member.recoveryPubKex` | added by finding E3-2 after §5.2 was written. Public, harmless, and should still be listed. |
| purge gaps in `Op.seq` | how much a departed member had written. |

**And ten more, added after the E5 adversaries read this document against the code.** The first
nine were derived from the SERVER. These were derived from the CLIENT and from the DUMP, which is
why they were missed: a document written by reading `schema.prisma` cannot see a request header,
and a document written column by column cannot see what two columns imply.

| not in §5.2, and until now not here either | where it now lives |
|---|---|
| `X-LZP-Client` — the exact build per machine, the minute each Mac updated, and a fingerprint that survives revoke-and-readopt | §5, "the headers every request carries" |
| `X-LZP-Protocol` — the N−1 window this client is inside | §5, same table |
| `ts=` in `Authorization` — the client's wall clock, hence a per-machine drift fingerprint | §5, same table |
| the space id and read cursor **in a URL query string** on every pull | §5, "the URL every pull carries" |
| the pull cadence when the window is hidden — **10 minutes, not "stopped"** | §5, the cadence block. This one was a factual error in this document, not an omission. |
| `visibilitychange`, `online`, `pagehide` — three event-driven requests that bracket a session | §5, "the three requests that are not a poll" |
| **the admin is identifiable four ways** | §7, inference 1 |
| a member's **time zone**, from the offset between two activity windows | §7, inference 2 |
| the member-keyed `RateBucket` rows as **a per-member action record** | §7, inference 3 |
| the application log's `route` as a named per-member event feed | §7, inference 4 |
| **cross-space correlation** by `deviceShort`, by the recovery point, and by timing | §7, inference 5 |
| **the release host** — a second remote, contacted by solo installs too | §8, "the second remote" |

**Recommended action:** amend ADR 003 §5.2 to point at this file rather than restate a list that
has to be kept in sync by hand. Owner: whoever holds ADR 003.

---

## 10. Sentences the Datenschutz page can use, and one it cannot

**Can (each one is true and checked by a test):**

> Der Server speichert nur verschlüsselte Daten. Er kann keinen Eintrag, keinen Balken, keine
> Kategorie, keinen Namen und keinen Notizzettel lesen.

> Der Server weiß, **wie viele** Personen und Geräte zu einem Familienkreis gehören, **seit wann**,
> und **wann** jedes Gerät zuletzt Daten abgeholt hat. Er weiß nicht, **wer** diese Personen sind
> und **was** sie schreiben.

> Die einzige lesbare Angabe, die eine Person selbst gewählt hat, ist ihre **Farbe**. Sie ist
> nötig, damit nicht zwei Personen dieselbe Farbe bekommen.

> Server und Datenbank stehen in **Frankfurt am Main**.

> Zur Missbrauchsabwehr speichert der Server **IP-Adressen** zusammen mit einem Zähler. Der
> Zähler läuft nach spätestens einer Stunde ab; **die Zeile selbst wird derzeit nicht automatisch
> gelöscht** — siehe §11.

> Jede Anfrage nennt die **Version der App** und die **Uhrzeit dieses Macs**. Die Uhrzeit ist
> nötig, damit alte Anfragen nicht wiederverwendet werden können.

> Die App meldet sich beim Server **nicht nur alle 45 Sekunden**, sondern auch **immer dann, wenn
> Sie den Kalender nach vorne holen, wenn dieser Mac wieder Netz hat und wenn Sie die App
> schließen**. Steht das Fenster im Hintergrund, meldet sie sich alle zehn Minuten.

> Die App fragt außerdem bei einem **zweiten Server** nach, ob es eine neuere Version gibt. Das
> passiert erst, nachdem Sie zugestimmt haben, und lässt sich in den Einstellungen wieder
> ausschalten. Dieser Server erfährt nur, dass ein Mac gefragt hat — nichts über Ihren Kalender.

(That last sentence is uncomfortable and it is the true one. If the PO adds the cleanup job in
§11, it becomes „…und wird nach 24 Stunden gelöscht", and this page should be updated in the same
change — not before it.)

**Cannot, because it is not true as stated:**

> „Der Server sieht nur verschlüsselte Daten und sonst nichts."

He sees §5 and §6. The honest version names the shadow and says why it is the price of a relay
that works.

---

## 11. Open, and owed to somebody else

- **E2-207-B — `Device.attestation` is write-only.** Three routes store it; no route returns it.
  ADR 002 §4.4's bootstrap roster says a joining device builds its sender set from relay
  coordination data "plus the `dev.*` blobs"; ADR 002 §2.3 says the opposite, that the in-stream
  path cannot bootstrap itself and the device panel and pairing flow must deliver the first
  attestation (owner WP-9). Both cannot hold. It is a *capability* gap, not a privacy one — the
  attestation is a signed public record and publishing it would leak nothing new — but it is
  the reason the two-client demonstration in `E2-VERIFICATION.md` §2 carries one value
  out-of-band, and E5 will meet it.
- **Retention has no timer, and one row is worse than "up to an hour" suggests.** ADR 003 §6.3:
  nothing prunes, and Vercel Hobby has no cron. `Nonce` is swept lazily on the next `claimNonce`
  (the sweep is global, so one write clears every expired row) — which means on an *idle* relay
  expired nonces persist until somebody makes a request. **`RateBucket` is never swept at all**:
  `rateAllow` REPLACES an expired bucket's `{count, windowStart}` and leaves the `key` in place,
  so a key containing an IP address survives **indefinitely** once written — its *count* resets,
  its *identity* does not. §2 says "up to an hour"; that is the window during which the count is
  meaningful, not the lifetime of the row. **A "delete after N days" job does not exist and the
  Datenschutz page must not imply one.** The cheapest honest fix is a periodic
  `DELETE FROM "RateBucket" WHERE "windowStart" < now() - interval '1 day'`, which needs a cron
  and therefore a paid plan or a deploy-time hook. Owner: the PO, on the day there is a real
  database. Until then, §2's IP paragraph should read *"gespeichert, bis sie manuell gelöscht
  wird"* rather than *"bis zu eine Stunde"*, and §10's German sentence is corrected accordingly.
- **`Op` rows are never pruned except by removal or space deletion.** A family that uses this for
  ten years has ten years of arrival timestamps on the relay.
