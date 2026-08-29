# E2 — integration and verification

**Scope.** E2 is the sync server: commit `c74663d` (LZP-201 skeleton plus the three endpoint
passes) and the integration and proof that were never run because the integrating agent was cut.
This document is that pass. It was carried out against `92713ba`, on a machine with **no Vercel
account, no Postgres and no network**, which is what makes §6's WRITTEN-UNVERIFIED column real
rather than a formality.

**How to read the status column.**

| status | meaning |
|---|---|
| **VERIFIED-HERE** | exercised by code that ran during this pass, with the output pasted below. |
| **WRITTEN-UNVERIFIED** | the code exists and is reviewed, and the property it claims cannot be exercised on this machine. Each row names exactly what the PO must run. |
| **OWED** | not built, or built and demonstrably incomplete. Each row names the owner. |

---

## 1. Suites

All five, on a tree with **no `node_modules` and no install step**. The root `package.json` still
declares zero `dependencies`; nothing below needed one.

```
npm test              # tests 1738   # pass 1738   # fail 0
npm run test:attack   # tests  648   # pass  648   # fail 0
npm run test:property # tests   70   # pass   70   # fail 0
npm run test:server   # tests  634   # pass  634   # fail 0     (was 569; +65 from this pass)
npm run test:dom      # files run: 22            # tier 2: FAIL  ← see §1.2, NOT caused by E2
```

> **`npm test` was 1690 when this pass started and is 1738 now, and none of the 48 are E2's.**
> A second workflow — the E3 crypto verification — was running in this same working tree
> throughout and committed `92713ba` partway through; it owns `src/js/`, `tests/tier1/` and
> `tests/helpers/`, and this pass owns `server/`, `tests/server/` and the two documents. The
> numbers that are wholly this pass's are `test:server` (569 → 634) and the two new files in
> §1.3. `test:attack` and `test:property` were 648 and 70 before and after, unchanged by either.
> The commit this pass produces is path-scoped and carries none of the other workflow's files.

### 1.1 Both adapters, every file

`tests/server/*` is nine files that take an adapter and one (`router.test.js`) that is pure
routing and touches no store at all. Counting the top-level suites the run actually emitted:

```
memory-scoped suites : 217
file-scoped suites   : 218
adapter-free suites  : 134   (router table, error shapes, limit arithmetic, version gate,
                              pure auth helpers, purity greps)
```

The file adapter has exactly one suite the memory adapter does not, and it is the one that
cannot exist in memory:

```
diff of the two suite name sets:
> the on-disk relay contains no text from a header, ever
```

That is the correct asymmetry. The file adapter is the second witness precisely because it is
where a `Uint8Array` could come back a `String`.

### 1.2 The one red thing on this machine, and why it is not E2's

`npm run test:dom` reports `tier 2: FAIL` on a single assertion:

```
not ok 38 - 12.3/15.4 · the Today highlight is suppressed on paper, quiet tells included
  message: Error: a pink band would date the sheet on the wall
  tests/tier2/dom-rendering.dom.js:1135
```

**It is pre-existing, it is date-dependent, and it is nobody's regression.** Verified in a clean
detached worktree:

- at `92713ba` (current HEAD, the parallel E3 verification commit): FAIL
- at `f5add24` (before both parallel workflows): **also FAIL**
- `git diff f5add24..HEAD -- src/js tests/tier2` is **empty** — neither workflow touched either.

The cause: the assertion reads the *real* `today` row and requires its printed background to be
`SHADE.none`. **Today is Saturday 2026-08-29**, so that row carries `.we` and prints as
`SHADE.weekend` — which the very next test, `12.3/15.4 · a Today that falls on a weekend or in
Ferien prints as that, not as blank`, asserts is **correct**. The two tests contradict each other
on two days in seven.

Proved rather than argued: adding `today.classList.remove('we', 'fer')` before the print block in
that one test, in a clean worktree, yields

```
ok 38 - 12.3/15.4 · the Today highlight is suppressed on paper, quiet tells included
# files run: 22
# tier 2: PASS
```

**Owner: whoever owns `tests/tier2/dom-rendering.dom.js` (WP-2 / the print work package).** Not
fixed here — it is outside this ticket's file ownership, and a one-line edit to a test in another
work package during a verification pass is how a verification stops being one. The fix is to
neutralise the ambient weekend/Ferien classes on the row under test, as line 1146's sibling test
already does in its own setup.

### 1.3 What this pass added

`tests/server/` gained two files, +65 tests:

| file | tests | what it is for |
|---|---|---|
| `blindness.test.js` | 26 | §4 — the relay is blind, asserted over the whole column domain and over a real session |
| `integration.test.js` | 39 | §5 — the composition, and the three E3 controls attacked through the real router |

---

## 2. THE HEADLINE — two real browser clients, one relay, real HTTP

**Setup.** Two hosts, exactly as the ticket asks:

```
node server/dev-server.mjs --port 8787 --dir /tmp/lzp-e2-store --demo
  LangzeitPlaner dev sync host
    http://127.0.0.1:8787/api/v1   (loopback only)
    store: /tmp/lzp-e2-store/sync-store.json  (file adapter, single writer)
    routes: 23 of 23 wired
    protocol: 1..1  (N-1 rule, version.js)

node dev-server.mjs
  LangzeitPlaner dev server → http://localhost:4173
```

Two browser tabs, each an independent JavaScript realm with its own key pairs:
`…/_dev/two-client.html?role=A` (Papa) and `?role=B` (Mama).

### 2.1 The one thing that is genuinely not there, stated first

**The page cannot be served from `:4173`.** This API deliberately sends no
`Access-Control-Allow-Origin` — story 21.5, and `.github/scripts/check-server-config.mjs` fails
the deploy if one ever appears in `vercel.json`. A browser page on the app origin therefore
cannot read a response from the API origin, and **the honest fix is not to weaken the control.**

So `server/dev-server.mjs` gained a `--demo` flag (off by default) that serves the demonstration
page and the repository's real `src/js/**` modules **from the same origin as the API**, GET-only,
extension-allowlisted and path-confined. No CORS header exists anywhere. `node dev-server.mjs`
was still running on 4173 throughout, and the app it serves is unchanged.

Traversal is refused:

```
GET /src/js/../../../../etc/passwd   → 404
GET /src/js/../../package.json       → 404 {"error":"not_found"}
GET /src/js/crypto/envelope.js       → 200 text/javascript
```

### 2.2 What ran

Verbatim from the two tabs.

**Tab A — Papa, `deviceShort PRJW87Z00DTCECH4`, `mem_uUSSgFw-HjVS6Wyx9Y2umQ`:**

```
 1  POST /spaces  — creating fsp_BEe22rr9AqrfLxto6EM2nw with epoch-1 wraps to my device and my recovery key
 2    200 · epoch 1 · 1 member
 3  sealOp × 1 — plaintext: space name "Familie Hein", under epoch 1, before B exists
 4  POST /ops — pushing 1 envelope(s) (iv‖ct‖sig; the relay copies, never reads)
 5    200 · accepted 1 · spaceSeq 1
 6  POST /invites — the code stays here; the server gets HKDF(code,"…/id") and SHA-256(HKDF(code,"…/verify"))
 7    200 · inviteId wx5sLKSZFqoKy0fyNIL2Mg · epoch 1 · expires 2026-09-05
 8  courier ← {spaceId, code}   (stand-in for the invitation email, story 15.2)
 9  courier ← attestation(A)    (STAND-IN: no endpoint returns one — finding E2-207-B)
10  waiting for B to redeem the invite (out-of-band)
11  B redeemed as mem_hbNIwavLoT61hGMPFnZWsw
12  GET /spaces/fsp_BEe22rr9AqrfLxto6EM2nw/members — reading the roster the relay publishes
13    200 · 2 members · B has 1 device, kexPubRaw BDOU7WL6f0y0…
14  POST /spaces/fsp_BEe22rr9AqrfLxto6EM2nw/epoch — rotating to 2 with 8 wraps (D9: THIS is where B's key comes from)
15    200 · currentEpoch 2 · wrapsStored 8 · the server ran the coverage check
16  sealOp × 1 — plaintext: displayName "Papa", under the NEW epoch 2
17  POST /ops — pushing 1 envelope(s) (iv‖ct‖sig; the relay copies, never reads)
18    200 · accepted 1 · spaceSeq 2
```

**Tab B — Mama, `deviceShort 1C7XGEVAZBDRWJN9`, `mem_hbNIwavLoT61hGMPFnZWsw`:**

```
 1  waiting for A to create the circle (out-of-band)
 2  courier → {spaceId fsp_BEe22rr9AqrfLxto6EM2nw, code}   (stand-in for the invitation email)
 3  POST /invites/redeem — proving I hold the code, publishing my public keys
 4    200 · I am a member of fsp_BEe22rr9AqrfLxto6EM2nw · 2 members · pendingKeys true
 5    D9 · key material in the redemption response: NONE
 6  GET /spaces/fsp_BEe22rr9AqrfLxto6EM2nw/keys — before anyone has wrapped to me
 7    200 · wraps 0 · keysPending true  ← D9's designed waiting state (19.3)
 8  GET /ops — I am a member, so the relay hands me the envelopes. I cannot read them.
 9    200 · 1 envelope(s) delivered, 0 openable — no epoch key here yet
10    ct[0] = 92uXef3-c93dtwVR4FR7hBjaKUHHRATFDVZdSbMrRbZnaHiWpp4BcoiWpb6IW2ad…
11  GET /spaces/fsp_BEe22rr9AqrfLxto6EM2nw/keys — A has rotated
12    200 · 4 wraps · currentEpoch 2 · keysPending false
13  unwrapSpaceKey with MY private ECDH key → epochs [1, 2] admitted
14  courier → attestation(A)   (STAND-IN: the wire carries no attestation — finding E2-207-B)
15  GET /ops — pulling again, now that I hold a key
16    200 · 2 envelope(s) · currentEpoch 2
17    openOp uEICmnJdvPwB1aRyz7TLjw (ep 1) → space.set  {"admin":"mem_uUSSgFw-…","adminPrev":null,"epoch":1,"name":"Familie Hein"}
18    openOp FFKVWoU-SjO96kMsXEjzAw (ep 2) → member.set  {"colorRef":"gruen","dev.PRJW87Z00DTCECH4":"ZXlKamNtVmhkR1ZrUVhRaU9pSXlNREkyTFRBNExUSTVJaXdpWkdWMmFXTmxTV1FpT2lKa1pYWmZh…","displayName":"Papa"}
```

**Verdict, as the page rendered it:**

> B: joined with a code the server never saw, was handed 1 envelope(s) it could not read,
> then — after A wrapped epoch keys to B's public key — opened them and read:
>     space name  "Familie Hein"   (sealed under epoch 1, BEFORE B existed — ADR 002 §4.3, A4)
>     displayName "Papa"   (sealed under epoch 2)
> 6 signed requests. B's private keys never left this tab.

### 2.3 What that proves, item by item

- **Real HTTP.** Two browser contexts, `fetch`, loopback TCP, real status codes and real
  `X-LZP-Protocol` headers.
- **Real router.** `createHandlers()` — the version gate outside, the 23-route table inside, all
  23 wired. The startup banner says `23 of 23`.
- **Real signatures.** Every request carries `LZP1 device=…, ts=…, nonce=…, sig=…` over
  `lzp/v2\n` + method + path + `?` + sorted query + `b64u(SHA-256(rawBody))` + ts + nonce, ECDSA
  P-256/SHA-256, verified by `server/core/auth.js` against the device's public key.
- **Real envelopes.** `src/js/crypto/envelope.js` `sealOp` and `openOp`, imported **unmodified**
  from the repository over `/src/js/crypto/envelope.js`. Not a copy, not a shim.
- **Real key delivery, and D9 working.** B redeemed with **no key material in the response**, was
  handed ciphertext it could not read, sat in the designed waiting state
  (`keysPending: true`, story 19.3), and became able to read only once *an existing member device*
  wrapped the epoch keys to B's public ECDH key and posted them. That is D9's whole promise,
  executing.
- **ADR 002 §4.3 / story A4 / risk R11.** The `space.set` op was sealed under **epoch 1, before B
  existed**, and B read it — because the rotation backfilled epochs `1..e`, which is what
  `assertCoverage` demands. „Oma's birthday still renders for the joiner", demonstrated.
- **Blindness, on the live relay.** The whole server log and the on-disk store, grepped:

  ```
  Familie Hein     0
  Papa             0
  Zahnarzt         0
  gruen            1        ← Member.colorRef, the one documented leak
  blau             1        ← the same, for the other member
  ```

  and the `Op` rows as the file adapter really holds them:

  ```
  { spaceId: "fsp_BEe22rr9AqrfLxto6EM2nw", seq: "1n", opId: "uEICmnJdvPwB1aRyz7TLjw",
    epoch: 1, deviceShort: "PRJW87Z00DTCECH4", witness: null,
    chain: BYTES(32), envelope: BYTES(604), receivedAt: "2026-08-29T01:51:54.338Z" }
  { … seq: "2n", epoch: 2, … envelope: BYTES(1372), receivedAt: "…:55.575Z" }
  ```

  604 and 1372 are `92 + 256·k` for k = 2 and k = 5 — the padding buckets, working.
- **The log leaks nothing.** Every line the relay wrote is the seven-field allowlist and no path
  ever appears:

  ```
  { route: 'rotateEpoch', spaceId: 'fsp_BEe22rr9AqrfLxto6EM2nw',
    deviceShort: 'PRJW87Z00DTCECH4', status: 200 }
  { route: 'pushOps', byteCount: 2014, status: 200, ms: 4 }
  ```

### 2.4 What is stood in for, and it is exactly two things

Both are labelled **on screen** while the demonstration runs, not only here.

1. **The invitation email.** A `localStorage` key carries `{spaceId, code}` from tab A to tab B.
   In the product that hop is deliverable 28's email and a human typing the code. It is
   out-of-band **by design** — the server only ever sees HKDF derivations of the code — so a
   same-origin courier is a faithful stand-in for the channel, not a shortcut past a control.
2. **The sender's device attestation, and this one is a real gap** — finding **E2-207-B** below.

Nothing else is simulated. In particular the key delivery is not: B genuinely could not read a
byte until A's rotation landed.

### 2.5 Reproducing it

```
node server/dev-server.mjs --port 8787 --dir /tmp/lzp-e2-store --demo
node dev-server.mjs
open http://127.0.0.1:8787/_dev/two-client.html?role=A
open http://127.0.0.1:8787/_dev/two-client.html?role=B
```

Press **Start** in both, in either order; they rendezvous.

---

## 3. Findings from the integration pass

| # | finding | status |
|---|---|---|
| **E2-207-A** | `handlers/index.js` claimed *"`assertComposition()` makes the choice structural rather than a comment: it refuses to build a router that has both"*. **It did not.** `createHandlers({registry: withLimits(handlers)})` built a working, silently double-charging router. | **FIXED HERE** |
| **E2-207-B** | `Device.attestation` is a **write-only column**. | **OPEN — owner WP-9 / ADR 002** |
| **E2-207-C** | `server/dev-server.mjs` built its `ctx` by hand and never called `assertCtx`, which `REQUIRED_CTX`'s own docblock names this file as a checklist for. `adapters/vercel.js` called it; the dev host did not. | **FIXED HERE** |
| **E2-207-D** | `tests/tier2/dom-rendering.dom.js:1135` fails on weekends. Pre-existing, not E2's. | **OPEN — owner WP-2**, see §1.2 |

### E2-207-A — the double-charge that could not be refused

`limits.js`'s INTEGRATION WARNING names two valid compositions and says there is no third. The
handlers self-limit through `enforceFor`, so `withLimits` must not be composed on top —
`invites.js` even carries the warning in prose at its own `enforceFor` call. `assertComposition`
checked only that every name was a route and every value a function, both of which a wrapped
registry satisfies.

**What it would have cost.** Nothing errors. Every pre-auth budget is charged twice and the
number ADR 003 §6.1 *publishes* silently halves: `invitesPerIpHour` 10 → 5, `pairGetPerIpHour`
20 → 10, `spacesPerIpHour` 5 → 2. A family onboarding two people from one household hits a 429
that the documentation says cannot happen.

**The fix** derives both facts from `limits.js` instead of copying them: the pre-auth route set
comes from `RATE_COVERAGE`, and the wrapper's function name is learned by running the real
`withLimits` over a stub at module load. So a renamed wrapper or a sixth pre-auth rule keeps the
check working. Now:

```
refused: 500 internal {"doubleCharged":["createSpace","redeemInvite","registerDevice","adoptDevice","pairGet"]}
```

Pinned by `integration.test.js` §1, which re-derives the expected set from `RATE_COVERAGE` on the
other side so the two cannot drift.

### E2-207-B — the attestation the wire never carries

`Device.attestation` is written by `POST /spaces`, `POST /invites/redeem` and `POST /devices`,
and **read back by no endpoint**. `handlers/members.js` withholds it deliberately and gives its
reason (ADR 002 §2.3 — it belongs inside the E2EE stream, and a client that verified the relay's
copy would hand back the property that "a malicious relay cannot fabricate a device row").

That reason is sound and it collides with ADR 002 §4.4, which says a joining device's roster
comes from *"relay coordination data (`MemberRowDb.recoveryPubSig` plus the `dev.*` blobs)"* —
blobs the relay does not serve. ADR 002 §2.3's own *"What is not closed"* paragraph takes the
other side: the in-stream path cannot bootstrap itself, because a device's first attestation
travels in an envelope sealed under its own short, and *"§2.3's device panel and the pairing flow
— not the fold — have to deliver a first attestation. Owner: WP-9."*

**Both cannot hold.** Concretely: `openOp` resolves the signing key from a verified attestation,
so with today's API a joining device can decrypt nothing from a peer it has never met. That is
why §2's demonstration carries one value out-of-band and says so.

**It is a capability gap, not a privacy one.** An attestation is a signed public record; serving
it leaks nothing §2 of `server-metadata.md` does not already list. Two candidate resolutions,
both cheap, neither this ticket's to choose:

- add `attestation` to `DEVICE_PROJECTION` (a client must still verify it against the member's
  `recoveryPubSig`, which the same projection already carries — the relay's copy becomes a hint,
  never an authority); or
- keep the column write-only and make WP-9's device panel and pairing flow the sole delivery
  path, and say so in ADR 002 §4.4 instead of pointing at coordination data.

`blindness.test.js` §7 pins the current answer, so whichever is chosen has to change a test on
purpose. **E5 will meet this** the moment it builds a real sync client.

---

## 4. Blindness — `tests/server/blindness.test.js`

26 tests, both adapters, no `src/js` import (the claim under test is about the *server*, so a
failure must be a server failure and not a crypto-layer failure arriving by import).

**The enumeration.** §2 of the file walks **every model × every column in `MODEL_COLUMNS`** — 10
models, 61 columns — and requires each cell to fall into exactly one of four buckets:

```
opaque bytes  ·  a timestamp  ·  a number/bigint/bool/enum  ·  a String on PLAINTEXT_STRINGS
```

with the fourth carrying a written justification. The classification is asserted **total** (the
four buckets sum to the column count) and **disjoint** (no column in two). A new column lands in
none of them and the test fails naming it. It also asserts:

- `schema.prisma` declares **exactly** `MODEL_COLUMNS`, model by model, parsed from the file;
- no column name in either declaration carries a `FORBIDDEN_COLUMN_TOKENS` substring;
- **exactly one** justified String is content rather than an identifier, and it is
  `Member.colorRef` — the leak 15.3 forces and 21.3 names. A second one would need a new sentence
  in the Datenschutz copy, so the test makes that a decision rather than a diff.

**The session.** A realistic family — create the circle, push two sealed ops under epoch 1, mint
an invite, redeem it, rotate to epoch 2, push four more sealed ops, pull, list members, fetch
keys, list open invites, `meta`, and open a pairing rendezvous — through `createHandlers()` with
the full auth ladder, on a fake clock. The plaintext corpus is what a German family really types:

```
Zahnarzt Mama 14:30 · Sommerferien Italien · Arzttermine · Großmutter Käthe
Einkaufszettel: Milch, Brot · Familie Hein · 2026-09-10
```

(an entry, a bar label, a category, a display name with an Umlaut and an ß, a scratchpad line, the
space name, and a date — the five things story 21.1 names plus the two the schema header promises
are absent.)

Then **everything the relay is left holding** is searched: every Map, every row, every value, and
for the file adapter the raw bytes on disk and again after a hydration round trip. Also every
response body, every log line, and the error bodies from eight hostile requests that put corpus
text into every field a handler reads.

**Result: nothing.** And the search is proved non-vacuous — a control case plants one corpus word
in `Member.colorRef` and asserts the same walk finds it.

**Also proved:** six sealed ops really are in the store with `envelope instanceof Uint8Array`, so
the store is *full and unreadable* rather than empty; the 604/1372-byte padding arithmetic holds;
and the two member projections publish only fields on one justified allowlist, with the pull
piggyback a strict subset — derived from a **live response**, not from a declared constant.

### 4.1 Mutation-tested

Three mutants were applied to shipped files and reverted:

| mutant | result |
|---|---|
| `members.js` publishes a `displayName` | **killed** — §7's allowlist, `not ok 19` |
| `errors.js` drops the `FORBIDDEN_BODY_FIELDS` filter in `toResponse` | survived this file; **killed by its owner**, `router.test.js:62` *"ciphertext can never ride on an error body, even if a handler puts it there"* |
| `ops.js` logs the op ids into the `spaceId` field | **survived, correctly** — `LOG_FIELDS.spaceId` carries a pattern and the sanitiser **drops** the value, so nothing leaked |

The third mutant found a real defect **in this pass's own test**: §5's field-name check regex-
scanned `String(line)`, but `createLog` hands the sink the sanitised **object**, so the scan was
matching `[object Object]` and could never fail. Rewritten to walk the object's keys *and* check
each value against its own `LOG_FIELDS` rule, plus two new tests that pin the drop-vs-clamp
behaviour directly. A log assertion that cannot fail is worse than none, because it reads like
coverage.

### 4.2 Also asserted, because two files claimed it and nothing checked it

- **`handlers/index.js`**: *"a test asserts the mapping is total, injective and free of that
  collision"* and *"`blindness.test.js` asserts that every entry here is really that module's
  export"*. Now true — §8 imports each of the eight handler modules and compares identity.
- **`handlers/members.js`**: *"`tests/server/blindness.test.js` asserts the difference is still
  exactly that"*. Now true — §7.
- **ADR 003 §9 purity, across all of `server/core/`** — no `Date.now()`, no `Math.random()`, no
  `process.env`, no `node:` builtin, no `fetch(`, no `@prisma`/`@vercel`, comments and string
  literals stripped first so a rule named in prose is not a hit. `limits.test.js` checked
  `auth.js`'s import graph; this checks every file.

---

## 5. The three E3 controls — `tests/server/integration.test.js`

The E3 red team's charge:

> "every server-enforced control in ADR 002 — rotation coverage, the `rid` burn, the 5-attempt
> budget, all rate limits — exists in a contract and in no code that runs."

Each control now has a test where a hostile client enters through `POST /api/v1/…` with a real
signature over real bytes and tries to defeat it. Both adapters; 39 tests.

### 5.1 Rotation coverage — an admin cannot silently omit an honest member (story 20.2)

| the attack | result |
|---|---|
| rotate omitting the honest member's **device** (her recovery recipient present, so the ring looks complete at a glance) | `409 incomplete_coverage`, and the body **names** `honest.deviceId` so an honest client can fix it |
| rotate omitting her **recovery key** — finding E3-2's column, the wrap A2 depends on | `409 incomplete_coverage`, naming `rec_<memberId>` |
| rotate covering everyone at epoch 2 but **not backfilling epoch 1** — the attack that reads as an optimisation, and silently un-renders Oma's birthday for the joiner | `409 incomplete_coverage`, naming `{epoch: 1, recipientId: honest.deviceId}` |
| pad the ring with **invented recipients** so the count looks right | `400 bad_request unknown_recipient` |
| a **stranger** rotates someone else's space | `403 not_a_member` — and a space that does not exist answers **identically**, so the endpoint is not a space-id oracle |

Every one of them additionally asserts that the refusal **left nothing behind**:
`space.currentEpoch` is still 1 and no epoch-2 wrap was written. That matters more than the
refusal: a refused rotation that consumed `e+1` would wedge the family — the honest rotator that
comes next gets `409 epoch_taken` for an epoch whose key nobody holds. Proved positively, by then
performing the honest rotation **at the same epoch number** and getting `200 · currentEpoch 2`.

### 5.2 The pairing `rid` burn

| the attack | result |
|---|---|
| **re-`POST /pair/offer` a burned rid** — the resurrection primitive; a row a replayed offer could re-create would reset the attempt budget and make the 60-bit code the security parameter after all | `410 pair_burned` |
| answer a burned rid | `404 not_found` |
| deliver to a burned rid | `404 not_found` |
| read a burned rid | `404 not_found` |
| **replay the collection** — the attack that would hand a second party the same payload | `404`; the first collection consumed it (`consumed: true`) |
| a second `pair/answer` on a live rid — a MITM replacing the box the human has already begun comparing SAS digits against | `400 bad_request`, and `store.getPairSession(rid).boxB` is byte-identical to the honest one |

Also asserted: after the burn, `store.getPairSession(rid)` is `null` **and**
`store.bumpPairAttempts(rid)` returns `Number.MAX_SAFE_INTEGER` — it fails **closed**, so a caller
written as `if (attempts >= max) burn()` needs no special case.

### 5.3 The 5-attempt budget

| the attack | result |
|---|---|
| **change IP on every request** to escape the budget | `attempts` goes 1,2,3,4,5 regardless; the sixth read, from a sixth address, is `404` |
| an unknown, an **expired** and a **burned** rid, compared | byte-identical `404 not_found`. A `410` on an expired rid would confirm to a guesser that they had found a real code — the single most valuable bit in the protocol |
| **hammer random rids** hoping to find a live one | the `pairRidMiss` budget (5 failed lookups per IP per minute, E2-L1) cuts the address off with `429` carrying a positive `Retry-After`; a different address is unaffected |

And the two ways the control could break the *honest* flow, asserted not to:

- the **authenticated offerer** polling for `boxB` is not charged (12 polls, `attempts` stays 0) —
  otherwise every real pairing would die after five polls while the human was still reading digits
  aloud — and is never handed the single-use `delivery`;
- once **answered**, reads are no longer charged (8 polls, `attempts` stays 0, the rendezvous
  survives) — B must poll for the delivery on a slow link.

### 5.4 The composition and the stack in front of the controls

- the registry is **total** (23 = 23) and **injective** (no two routes share a function — the
  hazard that nearly shipped when `lifecycle.js` and `spaces.js` both implemented `rotateEpoch`);
- a registry naming a non-route, or missing one, is refused at **build** time;
- `assertCtx` names each missing member, one at a time, and `log`/`subtle` really are optional;
- the **version gate is outermost**: `POST /spaces` and `GET /ops` with no protocol header answer
  `426 protocol_too_old` before any handler parses a body, and `meta` is the only exemption and
  reports `region: 'fra1'` with exactly its four documented keys;
- **every route in the table is reachable** — none answers `501 not_implemented`, and each
  pattern matches a path built from itself under its own method.

---

## 6. LZP-201…207

| ticket | what it is | status | evidence, or the exact reason |
|---|---|---|---|
| **LZP-201** | models, route table, store interface, adapters | **VERIFIED-HERE** (except Prisma/Vercel) | `store-contract.test.js` runs 60 contract cases against **memory and file**; `blindness.test.js` §2 asserts `schema.prisma` and `MODEL_COLUMNS` declare exactly the same columns, model by model. `prismaStore` and `vercelAdapter` are **WRITTEN-UNVERIFIED** — see §7. |
| **LZP-202** | `POST/GET /ops` | **VERIFIED-HERE** | `ops.test.js`, both adapters; plus §2's live push/pull over HTTP and §4's six sealed ops surviving as opaque bytes. |
| **LZP-203** | spaces, members, **rotation coverage** | **VERIFIED-HERE** | `spaces.test.js` + `integration.test.js` §5.1 — five hostile rotations through the real router, each also proving nothing was consumed. |
| **LZP-204** | keys, devices, invites, pairing, lifecycle | **VERIFIED-HERE** | `lifecycle.test.js`, `invites.test.js`, `pair.test.js` + `integration.test.js` §5.2/§5.3; and §2's live D9 flow, which is `redeemInvite` → `keysPending` → `rotateEpoch` → `fetchKeys` end to end. |
| **LZP-205** | limits, logging | **VERIFIED-HERE** | `limits.test.js` (both adapters); `blindness.test.js` §5 over a real session; `integration.test.js` §5.3's live 429 with `Retry-After`. The `log-redaction.test.js` ADR 003 §6.2 names lives in `limits.test.js` §7 by that file's own stated decision, and is now additionally covered from the session side. |
| **LZP-206** | `meta`, protocol versioning | **VERIFIED-HERE** | `version.test.js`; `integration.test.js` §5.4 asserts the gate is outermost and `meta` exempt; §2's live host answered `{"region":"fra1","minProto":1,"maxProto":1,"serverTime":…}`. |
| **LZP-207** | **integration, composition, metadata inventory** | **VERIFIED-HERE**, with one open finding | `handlers/index.js` existed and was correct except **E2-207-A**, fixed and pinned. `integration.test.js` §1 (composition), `blindness.test.js` §8 (owners, ctx, purity). `docs/v2/server-metadata.md` written from the schema and handlers — §9 of it lists **ten things ADR 003 §5.2's "exhaustive" inventory omits**, including one correction. Open: **E2-207-B**. |

---

## 7. What needs the PO's Vercel and Prisma accounts

Nothing below can be exercised on a machine with no database and no deploy. Every item is
**WRITTEN-UNVERIFIED**: the code exists, is reviewed, and declares its own assumptions in a
machine-readable export rather than in a comment somebody can delete.

### 7.1 `server/adapters/prisma.js` — 19 unverified claims

`prismaStore` passes `assertStoreShape` and imports with no database present (the client is
injected; there is no top-level `@prisma/client` import). **Nothing else about it has been run.**
It exports `UNVERIFIED_CLAIMS`, 19 entries, each `{tag, method, claim, breaks}`. The five whose
`breaks` field is a data-loss scenario rather than an outage:

| tag | if the claim is false |
|---|---|
| `U-SEQ` | two concurrent pushes assign the same `seq`; the second overwrites the first in the primary key, and **one family member's afternoon of edits is gone with a 200 OK** |
| `U-TX` | a rotation that fails after inserting half its wraps leaves an epoch nobody can open — **every member locked out of their own board** |
| `U-CONSUME` | two people redeem one invite; the admin sent one invitation and sees two names |
| `U-BURN` | the 5-attempt cap resets on demand and §5.3's whole control stops holding |
| `U-CASCADE` | story 20.4 promises a purge; rows survive, and the relay keeps ciphertext for a family that asked to be forgotten |

**What the PO must run.** One command, once there is a database:

```
cd server && npm ci && npx prisma migrate deploy
DATABASE_URL="postgres://…?connection_limit=1" node --test tests/server/store-contract.test.js
```

`store-contract.test.js` is written adapter-agnostically for exactly this: it runs
`STORE_CONTRACT_CASES` — the same 60 cases that memory and file already pass — and
`prismaStore` has one written specification to satisfy. **Until that run happens, treat every
`UNVERIFIED_CLAIMS` row as an open question, not as documentation.**

Two of them (`U-SEQ`, `U-TX`) need concurrency, not just a database: run the suite twice
simultaneously against the same `DATABASE_URL`, or add a case that fires 25 parallel pushes. The
memory adapter exercises the *shape* of `tx()` with a mutex plus snapshot/rollback; Postgres
transaction semantics are the one behaviour that cannot be modelled here.

### 7.2 `server/prisma/migrations/` — **OWED, and it blocks the first deploy**

`server/prisma/` contains `schema.prisma` and **no migrations directory**. RELEASE §7.4 lists
`server/prisma/migrations/` as owed and *"append-only from the first deploy onward"*;
`vercel.json`'s build command runs `prisma migrate deploy`, which **applies migrations and does
not create them**. So the first deploy against an empty database applies nothing and every query
fails on a missing table.

**What the PO must run**, once, on a machine with a scratch Postgres, and commit the result:

```
cd server
DATABASE_URL="postgres://…/scratch" npx prisma migrate dev --name init
git add server/prisma/migrations && git commit
```

`migrate dev` is safe **only** against a throwaway database — `check-server-config.mjs` fails the
build if it ever appears in `vercel.json`, and that check is right.

### 7.3 `server/adapters/vercel.js` — 4 unverified claims

| tag | the claim, and what breaks |
|---|---|
| `U-RAWBODY` | the request reaching the handler is an unconsumed stream, so buffering yields the exact signed bytes. If a platform body parser ran first, **every signature fails** — total outage, loud. `config.bodyParser = false` is re-exported from the entry module because Vercel reads it there. |
| `U-VERCELIP` | the edge sets `x-vercel-forwarded-for` to the real client address and overwrites a client-supplied copy. If not, **every per-IP limit is evadable by a header** — silent. |
| `U-HEADERS` | `vercel.json`'s `headers` block and `res.writeHead` merge rather than replace. If not, HSTS or `no-store` silently vanishes. |
| `U-COLD` | a warm invocation reuses module scope, so the Prisma singleton really is one client. If not, connection exhaustion on Hobby tier. |

**What the PO must run:** deploy a preview, then

```
curl -si https://<preview>/api/v1/meta
```

and check `{"region":"fra1","minProto":1,"maxProto":1,…}`, `Strict-Transport-Security`,
`Cache-Control: no-store`, **no `Access-Control-Allow-Origin`**, and `X-LZP-Protocol: 1`. Then one
authenticated request — any `POST /api/v1/spaces` — which fails with `401 bad_signature` if
`U-RAWBODY` is false and succeeds if it holds. That single request settles the one claim whose
failure is total.

### 7.4 The preview-database trap

`vercel.json`'s build command already refuses to run `migrate deploy` on a preview unless
`LZP_PREVIEW_DB_IS_ISOLATED=true`. **Keep it that way.** A preview deploy that runs
`migrate deploy` against the production `DATABASE_URL` migrates production from a branch.

### 7.5 What does NOT need an account

Everything in §1–§5. `node .github/scripts/check-server-config.mjs` (§8), the whole
`tests/server/` suite against both adapters, and §2's two-client demonstration all run offline
with no install.

---

## 8. E1's deploy pre-flight

`node .github/scripts/check-server-config.mjs`, after this pass:

```
LangzeitPlaner sync-server deploy pre-flight
  ok    every check passed
exit=0
```

**Zero owed items.** All five files RELEASE §7.4 listed as owed by E2 now exist:
`server/package.json`, `server/package-lock.json`, `server/prisma/schema.prisma`, `server/api/`,
`tests/server/`. Every previously-advisory check is now binding and passes: `regions: ["fra1"]`
(decision D2), `prisma generate` + `prisma migrate deploy` in the build command, `VERCEL_ENV`
distinguishing production from preview, no `migrate dev` or `db push`, `Cache-Control: no-store`
on `/api`, **no `Access-Control-Allow-Origin`**, `env("DATABASE_URL")` with no literal connection
string, and no plaintext-looking column in the schema.

Note that `server/prisma/migrations/` is **not** on the script's owed list, and §7.2 says it
should be. That is a gap in the pre-flight, not in the schema: the check would pass a deploy that
cannot work. Suggested one-line addition for E1's owner, filed here rather than edited into
another work package's file.

---

## 9. The dependency boundary

- `package.json` at the repository root is **unchanged by this pass** (`git diff` is empty for it)
  and still declares `"dependencies"`: **absent**, with `@tauri-apps/cli` the only `devDependency`.
- There is **no `node_modules`** anywhere in the tree. Every suite in §1, the two-client
  demonstration in §2, and the pre-flight in §8 ran with **no install**.
- `server/package.json` declares `@prisma/client` and `prisma`, which is where they belong. The
  pre-flight fails if Prisma is ever mentioned in the root manifest, and it passes.
- `server/dev/two-client.{html,js}` — added by this pass — import only from `/src/js/**` and
  WebCrypto. No CDN, no bundler, no package.

---

## 10. Files this pass touched

| file | change |
|---|---|
| `server/core/handlers/index.js` | E2-207-A — `assertComposition` now really refuses a `withLimits`-wrapped registry, deriving both the pre-auth route set and the wrapper's name from `limits.js` |
| `server/dev-server.mjs` | E2-207-C — calls `assertCtx(ctx)` at startup; `--demo` static lane (§2.1) |
| `server/dev/two-client.html`, `server/dev/two-client.js` | **new** — the §2 demonstration |
| `tests/server/blindness.test.js` | **new** — §4, 26 tests |
| `tests/server/integration.test.js` | **new** — §5, 39 tests |
| `docs/v2/server-metadata.md` | **new** — LZP-207's metadata inventory |
| `docs/v2/E2-VERIFICATION.md` | **new** — this file |

Nothing under `src/js/` was touched. `server/core/handlers/{ops,members,spaces,invites,devices,
pair,lifecycle,keys,meta}.js`, `core/{auth,limits,router,errors,version,store-interface}.js` and
all four adapters are unchanged from `c74663d`; the three mutants in §4.1 were applied and
reverted, and `git diff` for those files is empty.
