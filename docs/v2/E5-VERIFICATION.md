# E5 — own-device sync. Verification, and the M1 demonstration.

**Date:** 2026-08-29 · **Milestone:** M1 „Zwei Macs" · **Tickets:** LZP-501…505, LZP-1002
**Read `docs/v2/FINDINGS.md` §3 first** — this document's §6 is that list's disposition.

> ### ⚠ SUPERSEDED IN PART — read §9 before you rely on anything below.
>
> This document records the M1 DEMONSTRATION and is kept as written, because what it claimed and
> what it missed are both part of the record. Two adversary rounds ran against it and round 8's
> integration pass then closed what they found. **Nothing here about confidentiality changed —
> 21.1 and 21.2 held under both attacks.** What changed is §0's verdict about DURABILITY, and
> §1's suite numbers. **§9 is the correction.**

---

## 0. The one-paragraph verdict

**M1 is demonstrated, not argued.** Two browser contexts with two separate storage partitions —
two genuinely distinct durable identities — paired over the real rendezvous with a six-digit SAS
compared on both screens, and then synchronised a whole private board through `node
server/dev-server.mjs` over real HTTP: a note created on one Mac appeared on the other, an edit
made on the second landed on the first, a bar dragged on the first landed on the second, and a
laptop taken offline, edited on both sides and brought back **converged**. The relay's own stored
bytes contain none of the note text. The sync indicator drew nothing at any point on the healthy
path. Every step below is pasted from the run.

**What integration cost:** one data-loss defect closed in `store.js` (E5-2), one finding closed
that had been open since round 4 (F-6), one park reason landed that ADR 002 §5.2.5 required before
this milestone (E3-3), a network gate rewritten to the form the ADRs actually state, and **three
new findings the demonstration produced** (E5-5, E5-6, E5-7). All six suites are green apart from
one pre-existing, date-dependent tier-2 row (E3-10).

---

## 1. Suites — measured 2026-08-29 at the close of the E5 integration pass

```bash
npm test              # tier 1, pure logic          → 1956 pass / 0 fail   (162 suites)
npm run test:attack   # adversarial corpus          →  648 pass / 0 fail   ( 91 suites)
npm run test:property # property harness + domains  →   70 pass / 0 fail   ( 12 suites)
npm run test:server   # the sync server             →  799 pass / 0 fail
npm run test:fleet    # the two-Mac fleet harness   →   60 pass / 0 fail   ( 13 suites)  ← NEW SCRIPT
npm run test:dom      # real headless WKWebView     → 26 files, 430 pass / 1 fail / 1 skip
```

`test:fleet` did not exist: `tests/fleet/`'s 60 tests were stranded with no script and were not in
`test:all`. Both are fixed; `test:all` now runs all six.

**The one tier-2 failure is E3-10 and is not E5's.** `tests/tier2/dom-rendering.dom.js:38` —
"12.3/15.4 · the Today highlight is suppressed on paper" — reads the real wall clock and asserts
that today is a plain weekday. 2026-08-29 is a Saturday, so `print.css:69` correctly keeps the
weekend shade and the row fails, as it does every Saturday, Sunday and Ferien day. Recorded in
`STATUS.md` §2 since the E3 pass. Owner: the print/DOM layer.

**The one skip is named and is a property of the host, not of the app.** `network-audit.dom.js`
§1's vacuity guard stands down inside WKWebView because WebKit records no Resource Timing entries
for the shell's `app:` custom scheme. The same measurement over `http:` is real and is in §4 below.

Zero npm dependencies (`dependencies: {}`, one devDependency: `@tauri-apps/cli`), no
`node_modules`, no new files in the repository root.

---

## 2. LZP-501…505 → VERIFIED-HERE / WRITTEN-UNVERIFIED / OWED

| ticket | state | evidence |
|---|---|---|
| **LZP-501** the sync protocol, chain, cursor, outbox, client | **VERIFIED-HERE** | 153 tier-1 rows in `sync-protocol/chain/queue/client.test.js`, run against the **real relay handlers** over the memory adapter through the real router and the real ADR 003 §2 ladder, with `platform/net.js` producing the actual signatures. |
| **LZP-502** the personal space — my two Macs, my whole private board | **VERIFIED-HERE** | 39 rows in `sync-personal.test.js` (two key stores, two P-256 pairs, one member, nothing stubbed but the socket) **and the M1 demonstration in §3**, which is this engine end to end in two real browsers. |
| **LZP-503** the pairing screens, both ends | **VERIFIED-HERE** | 24 tier-2 rows (`pairing-flow`, `pairing-sas`) in a real WKWebView, plus §3.2 below: the code was read off Mac A's rendered screen, typed into Mac B's rendered field, and both screens showed the same six digits. |
| **LZP-504** the sync indicator, three states | **VERIFIED-HERE** | 15 tier-2 rows (`sync-status.dom.js`), plus §3.7: `document.getElementById('sync-dot') === null` on both Macs at every checkpoint of the healthy path. |
| **LZP-505** the pairing flow and the family opt-in | **VERIFIED-HERE** | `src/js/family/pairflow.js` + `mount.js` + `engine.js` + `familysettings.js`, driven end to end in §3 over the real `/api/v1/pair/*`, `/api/v1/spaces`, `/api/v1/devices/adopt` and `/api/v1/ops`. |
| **LZP-1002** the network-scope audit | **VERIFIED-HERE** | tier 1 `network-scope.test.js` (10 rows, static) + tier 2 `network-audit.dom.js` (11 rows, runtime, both modes) + the live browser measurement in §4. |

### WRITTEN-UNVERIFIED

- **The bridge transport.** `net.js`'s `createBridgeTransport` is unit-tested against an injected
  `invoke`, and **no shell implements `sync_request`**. The whole demonstration ran on
  `createFetchTransport`. Until a shell lands the command, family mode inside the shipped Tauri or
  Swift app has no transport at all. **Owner: E1.** The command's full contract is in net.js §6.
- **The 45 s / 10 min pull cadence** (`family/engine.js`'s `driveCadence`) ran in the browser and
  its four triggers fired, but the *timing* was not measured — the demonstration woke it with the
  `online` event rather than waiting out three-quarters of a minute per step.

### OWED

- `shell-macos/main.swift` and `src-tauri/src/lib.rs`: the `sync_request` bridge command (E1).
- `src/js/storage.js`: named slots for the key ring, the peer attestations and the sealed outbox.
  `family/engine.js` keeps all three in `localStorage` today, which is correct in a browser and
  wrong in a Tauri build, where they belong beside `board.json`. **Owner: WP-3's file.**
- `src/js/crypto/envelope.js`: `ENVELOPE_PARK.ATTESTATION` should now be
  `PARK_REASONS.ATTESTATION` and `PARK_REASONS_NEEDED` should be emptied. The two spellings agree
  in VALUE — asserted — so nothing is broken; it is a duplicate constant. **Owner: the crypto
  workflow** (E5 was told not to edit `src/js/crypto/`).
- ADR amendments, listed in §7.

---

## 3. THE M1 DEMONSTRATION

### 3.0 The setup — two hosts, two Macs

```
node server/dev-server.mjs --port 8787 --dir .lzp-dev-store
  LangzeitPlaner dev sync host
    http://127.0.0.1:8787/api/v1   (loopback only)
    store: …/.lzp-dev-store/sync-store.json  (file adapter, single writer)
    routes: 23 of 23 wired
    protocol: 1..1  (N-1 rule, version.js)

node dev-server.mjs --relay http://127.0.0.1:8787
  LangzeitPlaner dev server → http://localhost:4173
    /api/v1/* → http://127.0.0.1:8787   (M1 demonstration lane; same-origin by design)
```

**Mac A = `http://localhost:4173`  ·  Mac B = `http://127.0.0.1:4173`.** Two different origins, so
two separate `localStorage` partitions and two separate IndexedDB key stores — the browser's own
enforcement, not a test convention. Two device identities were minted independently and neither
Mac ever saw the other's private key:

```
relay device rows after pairing:
  24GK2RJ4TGC59XM2  mem__4kcZiXAdOiFt_9D7_TapA  live      ← Mac A
  8K8JXA7A3G2VAQ07  mem__4kcZiXAdOiFt_9D7_TapA  live      ← Mac B
                    ^^^ one member, two devices — M1 is one person with two Macs
```

**Why the relay is proxied onto the app's own origin, and why that is not a fudge.** `index.html`
ships `connect-src 'self'` and E5 deliberately did **not** widen it: a `<meta>` CSP is one static
string and cannot be conditional on a space existing, so naming a sync host there would relax every
*solo* install's policy for a request solo mode must never make (ADR 003 §7 gate 4). The shipping
answer is the shell's `sync_request` bridge (gate 3). The dev answer is to put the relay on the
app's own origin, so the page under test is byte-for-byte the page that ships. The proxy is
`dev-server.mjs`'s `--relay` flag, off by default.

### 3.1 Solo, before anything — Mac A's first launch

```js
performance.getEntriesByType('resource')  →  38 entries
  offOrigin      : []
  apiCalls       : []
  familyModules  : []          // nothing under crypto/, sync/, family/, platform/net.js
  byType         : { link: 2, script: 36 }
```

A note was made through the real gesture — click a day, type, Enter:

```
board.json  →  [{ "date": "2026-09-11", "text": "Zahnarzt 9 Uhr" }]
```

### 3.2 The opt-in, the code, and the SAS

⚙ → „Familienkreis" → Server `http://localhost:4173` → **Einrichten**:

```
POST /api/v1/spaces            → 200
relay store:  spaces 1 · members 1 · devices 1 · keyWraps 2 · ops 0
board.json settings:  { syncEnabled: true,
                        syncOrigin: "http://localhost:4173",
                        personalSpaceId: "psp_fCUlKBpdnzr11Z8fAg43Gg" }
```

⚙ → „Meine Geräte" → **Zweiten Mac hinzufügen** on Mac A:

```
POST /api/v1/pair/offer        → 200          (authenticated)
GET  /api/v1/pair/MRj7…        → polling      (authenticated; never charged as a probe)

  ┌──────────────────────────────────────────────────────┐
  │  GERÄTE KOPPELN                                      │
  │  Diesen Code auf dem neuen Mac eintippen             │
  │                                                      │
  │            C F 9 6 — 7 A Z 9 — T 1 C 4               │
  │                Noch 2:59 gültig                      │
  └──────────────────────────────────────────────────────┘
```

Mac B — a genuinely empty install (`lsKeys: ["langzeitplaner.unlock"]`, zero family modules, zero
requests) — ⚙ → „Ich habe einen Code" → typed `CF967AZ9T1C4`:

```
GET  /api/v1/pair/MRj7…        → 200   (ANONYMOUS — Mac B has no identity the relay knows)
POST /api/v1/pair/answer       → 200   (ANONYMOUS)
```

**Both screens then showed the same six digits, and each named the other Mac by its key-derived
short:**

```
MAC A                                        MAC B
Stimmen die Zahlen überein?                  Stimmen die Zahlen überein?

      5 6 4    7 6 0                               5 6 4    7 6 0

Dieser Mac: 24GK2RJ4TGC59XM2                 Anderer Mac: 24GK2RJ4TGC59XM2
Anderer Mac: 8K8JXA7A3G2VAQ07

[ Die Zahlen sind verschieden ] [ Zuerst    [ Die Zahlen sind verschieden ]
                                 vergleichen ]  [ Ja — auf beiden steht 564 760 ]
```

Note the two LZP-503 properties visible in that paste: the refusal is **first** in the DOM (and so
first in tab order), and Mac A's affirmative still reads „Zuerst vergleichen" because the
two-second inert window had not elapsed. On Mac B it had, and reads „Ja — auf beiden steht 564
760" — the affirmative **restates the digits**.

Both humans confirmed:

```
MAC A:  POST /api/v1/pair/deliver   → 200   →  „Fertig"
MAC B:  GET  /api/v1/pair/MRj7…     → 200   (delivery collected; the relay burns the rid)
        POST /api/v1/devices/adopt  → 200   (ANONYMOUS; authorized by the attestation signature)
        GET  /api/v1/spaces/psp_…/members → 200
        localStorage: langzeitplaner.ring.psp_fCUlKBpdnzr11Z8fAg43Gg
                      langzeitplaner.peers.psp_fCUlKBpdnzr11Z8fAg43Gg
        settings: { syncEnabled: true, personalSpaceId: "psp_fCUlKBpdnzr11Z8fAg43Gg" }
```

### 3.3 A private note on A appears on B — and the relay cannot read it

Created on Mac A through the real gesture, on 15 September 2026:

```
MAC A  board.json → "Blutdruck-Check Praxis Sonnenberg"
```

On Mac B, one pull later:

```
MAC B  board.json  → [{ "d": "2026-09-15", "t": "Blutdruck-Check Praxis Sonnenberg" }]
       .note nodes → ["Blutdruck-Check Praxis Sonnenberg"]
```

**What the relay stored for that op — every field, decoded from its own file adapter:**

```
[ "psp_fCUlKBpdnzr11Z8fAg43Gg",
  { "spaceId":     "psp_fCUlKBpdnzr11Z8fAg43Gg",
    "seq":         "1",
    "opId":        "UOZ8r4rORTl8W3qfMisCBg",
    "epoch":       1,
    "deviceShort": "24GK2RJ4TGC59XM2",
    "witness":     null,
    "chain":       BYTES[44 b64]:0865eDpR4daiKVOvI0OKWhAneNoeosTSKnQVIWqtsAM=…
    "envelope":    BYTES[1148 b64]:zNzrezZcp8Igsh0hBJZkQUmxoREC8fbGkMPUD8g1/tTI…
    "receivedAt":  DATE } ]
```

**Plaintext search over every byte the relay holds for all seven ops of this run:**

```
   'Blutdruck'      → absent        'Steuerberater'  → absent
   'Sonnenberg'     → absent        'Herbstferien'   → absent
   'Zahnarzt'       → absent        'Nordsee'        → absent
   'Elternabend'    → absent        'note.set'       → absent
   'Werkstatt'      → absent        'bar.set'        → absent
   'Reifenwechsel'  → absent        '2026-11-03'     → absent
   '14:30'          → absent
```

The relay knows a space id, a sequence number, an opId, an epoch, which device wrote it and a
chain hash. It does not know that this is a note, what day it is on, or a single character of its
text. **Not even the op KIND** — `note.set` is inside the ciphertext.

### 3.4 An edit on B lands on A

Double-click the note on Mac B, edit, Enter:

```
MAC B  → "Blutdruck-Check Praxis Sonnenberg — 14:30"
MAC A  (one pull later)
       board.json → [ "Zahnarzt 9 Uhr",
                      "Blutdruck-Check Praxis Sonnenberg — 14:30" ]
       .note nodes → the same two, on screen
```

### 3.5 A bar dragged on A lands on B

A real vertical drag across `2026-10-05 → 2026-10-16`, then the label typed:

```
MAC A  bars → [{ s: "2026-10-05", e: "2026-10-16", l: "Herbstferien Nordsee" }]
MAC B  bars → [{ s: "2026-10-05", e: "2026-10-16", l: "Herbstferien Nordsee" }]
       .bar-label nodes → ["Herbstferien Nordsee"]
```

### 3.6 Offline on B, edits on both, and convergence

Mac B taken offline — `navigator.onLine === false`, which is the port `engine.js` reads:

```
MAC B  window.dispatchEvent(new Event('online'))     // the strongest wake the app has
       apiBefore 4 → apiAfter 4                       // ZERO requests. The queue holds.
```

Two entries made on the offline Mac, one on the online Mac:

```
MAC B (offline)  "Elternabend 19 Uhr (offline auf B)"
                 "Werkstatt Reifenwechsel (offline auf B)"
MAC A (online)   "Steuerberater Unterlagen (auf A, waehrend B weg war)"
```

The two boards were genuinely divergent at this point — B had two entries A had never seen, A had
one B had never seen. Mac B back online:

```
MAC B  notes → [ "Blutdruck-Check Praxis Sonnenberg — 14:30",
                 "Elternabend 19 Uhr (offline auf B)",
                 "Steuerberater Unterlagen (auf A, waehrend B weg war)",
                 "Werkstatt Reifenwechsel (offline auf B)" ]

MAC A  notes → [ "Blutdruck-Check Praxis Sonnenberg — 14:30",
                 "Elternabend 19 Uhr (offline auf B)",
                 "Steuerberater Unterlagen (auf A, waehrend B weg war)",
                 "Werkstatt Reifenwechsel (offline auf B)",
                 "Zahnarzt 9 Uhr" ]                       ← see §5, finding E5-6
```

**`board.json` compared field by field**, after a full reload of both Macs:

```
notes  (id, date, text)         IDENTICAL on both, for all four synced entries — same entity ids
bars   (id, start, end, label)  IDENTICAL — 1549fdfd-…, 2026-10-05, 2026-10-16, "Herbstferien Nordsee"
scratchpads                     {} on both
categories                      DIFFERENT IDS — finding E5-6, below
```

And it survived a relaunch on both machines:

```
MAC A after reload → 5 notes, 1 bar, 5 .note nodes on screen
MAC B after reload → 4 notes, 1 bar, 4 .note nodes on screen
```

### 3.7 The indicator was silent throughout

`document.getElementById('sync-dot')` was checked at every checkpoint of the healthy path — after
the opt-in, after pairing, after each of the three content exchanges, after the offline
convergence, and after the relaunch of both Macs:

```
MAC A  syncDot: false        MAC B  syncDot: false
```

**Healthy draws nothing.** That is 19.3 and it is the whole of `syncstatus.js`'s first state: the
node is not hidden, it is absent.

### 3.8 What the demonstration could NOT do here, stated plainly

- **It ran in Chrome, not in the shipped shell.** No shell implements `sync_request`, so a Tauri
  or Swift build cannot make the request at all today. The page, the store, the crypto, the
  protocol and the relay were all the shipping code; the *host* was a browser.
- **Screenshots stop partway through.** The browser pane became non-compositing after the SAS
  step, so §3.3 onward is pasted state and DOM text rather than pictures. Every claim after that
  point is read from `board.json`, from the rendered `.note` / `.bar-label` nodes, and from the
  relay's own store file.
- **Notes and bars were created by dispatching the real pointer/keyboard events** at the real
  elements, which run the real `interact.js` handlers, because the pane could no longer receive
  synthetic OS-level clicks. The ops that crossed the wire are the ops those handlers minted.
- **The clock was never faked.** The 45 s cadence is real; the demonstration woke it with the
  `online` event — a trigger the product listens for — instead of waiting for it eight times.

---

## 4. LZP-1002 — the network-scope audit, in both modes

### 4.1 The static half — `tests/tier1/network-scope.test.js`, 10 rows

```
GREP GATE — scanned 54 files under src/js/
  identifiers: fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon, importScripts
  hits outside the allowlist: []
  hits inside  the allowlist:
    src/js/platform/net.js:… fetch | const f = fetchImpl || globalThis.fetch;
```

**Gate 2 was rewritten, and the rewrite is the finding.** It asserted that `net.js` and `sync/`
were unreachable from `boot.js` / `firstrun.js` / `main.js` **by any kind of import edge**,
dynamic ones included. That is a stronger claim than either ADR makes and it makes their own
design unimplementable: ADR 003 §7 gate 2 says the modules are *"reached only through a dynamic
`await import()` gated on `spaces.personal || spaces.family`"*, and ADR 002 §2.4 says *"key
generation happens at the family opt-in moment"* — both require the opt-in to be able to reach
them. A gate that forbids every edge is resolved in practice by hiding the specifier from the
walker (a computed string, a variable), which turns a real gate into a vacuous one.

So `tests/helpers/importgraph.js` now records each edge's KIND, and the gate is:

```
§2  no STATIC path from boot.js / firstrun.js / main.js to
      platform/net.js · sync/ · crypto/ · family/                      → [] for all twelve pairs
    exactly ONE dynamic door out of the eagerly-evaluated graph:
      src/js/main.js -> src/js/family/mount.js                          → and nothing else
    the door really leads somewhere (it reaches all three prefixes)
    the static walker CAN find a static edge (mount.js -> crypto/)      ← the vacuity guard
```

The same amendment was applied, with the same reasoning, to the three other PRINCIPLE 7 gates
(`crypto-identity`, `crypto-guarantees`, `crypto-pairing`) and to `store-identity.test.js` —
where `store.js` itself is deliberately held to the STRONGER form, neither statically nor
dynamically, because it is a leaf and nothing about it needs a door.

### 4.2 The runtime half — `tests/tier2/network-audit.dom.js`, 11 rows, real WKWebView

```
ok 1  §1 solo · the launch loaded no family module at all
ok 2  §1 solo · the launch made no request off its own origin, and no API call
ok 3  §1 solo · the snapshot is not empty  # SKIP  (app: scheme has no Resource Timing)
ok 4  §2 solo · a full session — edit, undo, settings, persist, search — opens no socket
ok 5  §2 solo · the spy is armed — it catches a call planted right beside the session
ok 6  §2 solo · and the engine itself refuses an off-origin request — CSP, not politeness
ok 7  §3 family · every request the transport makes is one origin and one path prefix
ok 8  §3 family · a second origin is refused before a byte leaves the process
ok 9  §3 family · only GET and POST exist, and a GET carries no body
ok 10 §3 family · the allowlisted origin is normalised, and a path may not carry one
ok 11 §4 · §1 would have caught a family module, and §3 would have caught a second host
```

§2 spies on all five sockets and drives a whole solo session — create, edit, undo, redo, settings,
layer toggles, persist, search, „Heute", `visibilitychange`, `online`, `focus` — and asserts zero
calls; then plants a call beside it and asserts the spy fires, so a green §2 is not a spy that
stopped replacing anything. §3 refuses `https://someone-else.example/api/v1/ops`,
`//someone-else.example/api/v1/ops`, `https://relay.example.attacker.test/…`, `/api/v1/../../..`,
`/api/v2/ops` and `/ops` **by name**, with `seen === []` — nothing reaches the socket.

### 4.3 The live measurement, in a browser where Resource Timing works

**SOLO — Mac A's first launch, and Mac B's:**

```
totalResources : 38            offOrigin : []
apiCalls       : []            familyModules : []
byType         : { link: 2, script: 36 }
```

**FAMILY — Mac A after opt-in, pairing and a full sync session:**

```
totalResources : 55
offOrigin      : []
apiPaths       : [ "/api/v1/ops" ]          ← the only path a steady-state session touches
nonApiNonApp   : []                          ← nothing that is neither the API nor the app's own files
```

Across the whole demonstration the complete set of paths ever addressed was:

```
/api/v1/spaces          /api/v1/pair/offer      /api/v1/devices/adopt
/api/v1/spaces/:id/members  /api/v1/pair/:rid   /api/v1/ops
                        /api/v1/pair/answer
                        /api/v1/pair/deliver
```

One origin. Eight paths, all under `/api/v1/`. Nothing else, in either mode.

---

## 5. Findings this integration produced

### E5-2 — an op authored offline was LOST from the outbox by the next relaunch · **CLOSED**

**Severity: CRITICAL (silent, permanent, one-directional data loss between two Macs).** Found by
the fleet harness, fixed here.

ADR 003 §8.1 defines the outbox as "`ops.jsonl` lines whose `seq` is unset" and promises it
"survives quit and crash (19.1)". `store.outbox()` implemented the first half exactly. The second
half did not hold: `_persistOps` ③ wrote a checkpoint whose horizon was above every op in the log,
acknowledged or not; `checkpoint()` FOLDS everything at or below the horizon into `regs` and drops
the LINE; `load()` brings back registers, not lines. So an op the relay had never seen was written
to disk as a register VALUE and never as a LINE, and the next launch's outbox was empty. Five
entries made on a laptop while it was offline never reached the desktop, ever — and
`sync.status()` reported `healthy` throughout. Not only offline, either: the 700 ms autosave
debounce beats the 2 s push debounce, so an edit and a quit within two seconds took the same path
on a perfectly online Mac.

**The fix** is `store._outboxHorizonCap()`: a persist may not fold past the oldest line the relay
has not acknowledged. `outbox()` is the definition of "not acknowledged", *called* rather than
re-derived, so the two cannot drift. The one value is imposed on ① the tail selection, ②
`compact()` and ③ `checkpoint()` alike — the defect was precisely that ① predicted a horizon ③
then exceeded. Same shape as ADR 001 §7.3's tombstone GC, which is already gated on
`Device.lastSeenSeq` for the same reason. `undefined` — no cap — is returned whenever nothing is
unacknowledged, which is every solo persist, so R5-4e's compaction bound is untouched.

`tests/fleet/long-offline.test.js` §3's accepted-defect row is **inverted**: the outbox now holds
five lines after the quit, the peer receives every one of them on the first sync, and the boards
converge.

### F-6 — first contact loses data · **CLOSED, at the seam the finding names**

The finding: "`applyRemote` drops a refused op without appending it, so an unattested-device op
that arrives before its attestation is lost rather than parked." Two of `authz.js` stage 0b's
verdicts — `notMyDevice` and `unattestedDevice` — are not judgements about the op at all; they are
judgements about what THIS DEVICE KNOWS, and an attestation is itself an op that can arrive later.

Closed in four coordinated pieces:

1. **`core/ops.js` gains `PARK_REASONS.ATTESTATION`** — finding **E3-3**, which ADR 002 §5.2.5
   requires "before WP-8 pulls from a real peer". Before it existed, `oplog.park()` validated the
   reason against `isParkReason`, refused it, and the line was dropped.
2. **`classifyOp` gains `haveAttestation`, `oplog.load()` feeds the reason back, `unpark()`
   re-asserts it.** Landing the constant alone would have been *worse* than useless: `load()`
   re-classifies every parked line on purpose, so a reason the classifier cannot re-derive comes
   back LIVE — for this one that means an op from an unattested device APPLIED, one relaunch
   later, with no gate.
3. **`applyRemote` parks a curable refusal instead of dropping it**, and every other refusal is
   still a refusal — `foreignSpace`, `localSpace`, a forged act, a malformed shape are verdicts
   about the op that no later op can change, and parking them would keep a stranger's write on
   disk for ever.
4. **`applyRemote` re-judges the held lines in the same pass**, using the verdict it already
   computed (which was folded over `includeParked: true` and so has already judged them), and
   `store.unparkAttested()` does the same with no batch to trigger it — which is the ONLY case M1
   has, because `member.set` is a family-space op kind and a person with two Macs and no
   Familienkreis has nowhere in the log to record an attestation at all.

Both accepted-defect rows that recorded the gap (`tests/attack/crypto-relay-tamper.test.js`,
`tests/tier2/crypto-envelope.dom.js`) are inverted.

### E5-3 — `pushNow()` threw where `syncNow()` returned · **CLOSED**

`syncNow()` consulted `isOnline()` and returned `{skipped:'offline'}`; `pushNow()` did not, and
let a `NetError('transport')` escape from inside the transport. The debounce timer, `flush()` on
pagehide and any test reaching for the lower verb got a rejected promise where the higher one got
a value. Two verbs, two answers to one question, and the one that fires on every quit was the one
that threw. `pushNow()` now returns `{pushed:0, batches:0, skipped:'offline'}`.

### E5-5 — the published `pairGet` budget cannot accommodate a polling rendezvous · **OPEN, reported**

**Found by the demonstration, in exactly the shape a household would meet it.**

`GET /api/v1/pair/:rid` is charged against `pairGetPerIpHour = 20` (ADR 002 §6.2, enforced in
`server/core/limits.js` as a **pre-auth** rule, so the offerer's *authenticated* read is charged
too). The rendezvous lives 180 s. **Two Macs of one household are one IP** — that is the ordinary
case, not the exotic one — so twenty reads are shared between both ends of one pairing.

A fixed 1 s poll spends the whole hour's budget in twenty seconds, and the second Mac then gets a
`429` where it expected `box_A`. Measured live; the pairing failed with
`answerAsNew: that did not open` — which is the correct, indistinguishable answer, and exactly why
it took three attempts to see the real cause.

**Mitigated client-side, not fixed.** `pairflow.js`'s `PAIR_POLL_SCHEDULE` is front-loaded and
then backs off — `2, 2, 3, 5, 8, 12, 18, 24, 32, 36, 40 s` — because a person types a
twelve-character code in about twenty seconds, which is where responsiveness has to be. Eleven
reads cover the full TTL and leave nine of the twenty for the joiner.

**Still open:** a household that pairs a *third* device within the hour runs out. The right fix is
on the relay — not charging the authenticated offerer's own read of its own rendezvous, which is
what `pair.js` §2 already argues for reads *after* `box_B` exists. **Owner: `server/`.** E5 was
told not to edit it.

### E5-6 — a paired Mac receives none of the pre-space board, categories included · **OPEN, and it is M1's last real gap**

The corollary of E5-1 (which LZP-502 closed): the migration spine is shared *prehistory*, not
traffic, so `store.outbox()` excludes GENESIS stamps. Every Mac that already holds that
`board.json` has minted the identical ops; a Mac that does **not** hold it receives nothing of the
pre-space board, though ADR 002 §6.3 step 8 says it "pulls from seq 0".

The demonstration shows what that costs, and it is more than the missing note:

```
MAC A categories:  Arbeit c32ee91a-…   Familie a79f4c08-…   Reisen 26f8a6e2-…   Deadlines 3a73adf1-…
MAC B categories:  Arbeit 596e6397-…   Familie 3844f932-…   Reisen 7fe411cd-…   Deadlines e38fa989-…
```

Both Macs minted their own default categories at first run — those are spine ops too, so they
never travelled. Every synced note carries its author's `categoryId`, which is unknown on the
other Mac, and `deserializeBoard`'s "repair references so a hand-edited file can never orphan an
entry" quietly remaps it to a local default. On this run every note landed on the receiving Mac's
own „Arbeit", which happened to be right; with a colour the user cares about it would be wrong,
silently, and on every entry.

**Owner: WP-9 / the pairing flow.** ADR 002 §7.2's backup file or a `board.json` hand-over during
pairing is the fix; a `psp_` space full of re-stamped spine ops is not (it costs a permanent
`409 forked_op_id` — LZP-502 measured that and withdrew it). Until then, **pairing a Mac that does
not already hold the board is not delivered**, and story 19.4 should be read as "my whole private
board, from the moment the space exists".

### E5-7 — `device.attestation` has two spellings on two endpoints · **OPEN, reported**

`POST /spaces` reads `device.attestation` with `readBytes` (base64url of opaque bytes, never
verified); `POST /devices` and `POST /devices/adopt` read the raw blob string and VERIFY it. A
client must encode the same value differently for the two calls — `family/engine.js` does, with a
comment at each site. Reported by LZP-501; confirmed here by having to write both. **Owner:
`server/`.**

---

## 6. FINDINGS §3 — the disposition, row by row

§3 is the list of rows that go "from latent into live the moment a second device exists". Here is
where each one stands after this pass. **Nothing is absorbed; the three that are still open are
named, with an owner.**

| § | row | state after E5 |
|---|---|---|
| 1 | **F-10** `attestationOf` on `AuthzResult` | **CLOSED before E5.** Now load-bearing: it is `openOp`'s P1 and the port `sync/personal.js` refuses to be built without. |
| 2 | **A3-H4** durable device identity | **CLOSED.** `platform/device-identity.js` + `store.useIdentity()`; proved by two genuinely distinct identities converging in `store-identity.test.js`, in the fleet harness, and in §3 above with two separate browser storage partitions. All three of the things `authz.js` needed are supplied: `me`, `myDevices` (`_myDevices()`), and `attestOpen`. |
| 3 | **F-5** the checkpoint must pass `applyRemote`'s gate | **STILL OPEN.** Not touched by E5. It is the only input that becomes authoritative without being checked. A checkpoint is written by this device and read back by this device, so it is not reachable by a peer — but it is reachable by anything that can write the file. **Owner: whoever owns `store.js`'s boot path.** See also row 8. |
| 4 | **F-6** the ATTESTATION park reason, or retain refused ops | **CLOSED**, by both halves rather than either: the reason exists and is durable (E3-3, above), *and* refused-but-curable ops are retained. `sync/personal.js` additionally holds the cursor, so the op is re-served even if the park were lost. |
| 5 | **F-7** drop `local`-space ops · **F-2** one throw/accept rule | **F-7 CLOSED** by LZP-502 at both ends of the wire — `applyRemote` refuses a `local`-space op by name, `outbox()` never offers one — and `tests/attack/round3-seam.test.js`'s two rows are inverted from `SUCCEEDED (defect)` to `FAILED (held)`. **F-2 STILL OPEN**: `applyRemote` still mixes "throw" and "refuse and report" for different classes of bad input. Nothing in M1 depends on which way it is resolved. **Owner: `store.js`.** |
| 6 | **A3-M5** `_persistOps` must append | **CLOSED before E5** — and E5 found the defect *inside* the fix: see **E5-2**. The 30-day debuggability tail of ADR 001 §7.2 is still not implemented (compaction is total); E5 did not need it and did not build it. |
| 7 | **I-3** the possession proof | **CLOSED before E5.** E5's two obligations are both held and both now asserted: nothing appends an op that has not passed `openOp` (`sync/personal.js` refuses to be constructed without an `open` port; `client.js` the same), and §5.2.2's check 4 is not weakened — `store-identity.test.js` pins `devOf(op.ts) === deviceShort`. |
| 8 | **R5-5b** fold an adopted checkpoint through the gate | **STILL OPEN**, and it is F-5 seen from the authority rule's side. Closing F-5 closes both. |
| 9 | **R5-2g** a Time-Machine restore of a pre-lineage board quarantines a current log | **STILL OPEN.** Unchanged by E5; low frequency, high consequence, and it needs a decision rather than an edit. |

**Also latent-until-a-second-device and now live, though not on §3's numbered list:**

- **E3-1** — the row `STATUS.md` calls "the only row blocking a family-mode release" — is
  **untouched by E5** and is still open. E5 was told not to edit `src/js/crypto/`.
- **E3-3** (`PARK_REASONS.ATTESTATION`) is **CLOSED**, above.
- **ADR 006 §9.5** (`_opsPersisted` decided last), **§9.3 / W2** (a quarantine over a
  lineage-bearing board republishes) and **the WP-3 obligation** (`planReplaceAll`'s retractions
  carried across `setPublisher`) were all closed by LZP-502 and are asserted.
- **W1** (the persisted cursor may never be ahead of `board.json`) is structural: there is exactly
  one way to move a cursor and it writes into the log, whose only route to disk is `_persistOps`,
  which runs after the `saveBoardText` commit point. Asserted as an *inequality*, not an equality
  — behind is correct, ahead is not.

---

## 7. Amendments requested — the docs are another workflow's

1. **ADR 003 §7 gate 2** and **ADR 002 §2.4** should say **STATIC** reachability. The current
   wording is read by four separate tests as "no edge of any kind", which forbids the design the
   same paragraph describes. Suggested: *"no static import path from the boot graph; exactly one
   dynamic `import()`, and the gate names which file it is."*
2. **ADR 003 §7 gate 4**'s `https://<sync-host>` clause should be restated as *"the shell
   transports; the document's `connect-src` stays `'self'`"*, and §7 gate 1's "OWED" amendment can
   be struck — gate 1 is now held by `tests/tier1/network-scope.test.js`.
3. **ADR 002 §6.2** should say what a client's poll cadence may be, given `pairGetPerIpHour = 20`
   and a 180 s TTL shared by two devices on one IP. See **E5-5**.
4. **ADR 003 §8.1** should name the file the sealed outbox envelopes live in (LZP-502's §4(b)), and
   should be reconciled with ADR 006 §9.2's "`ops.jsonl` holds plaintext op lines".
5. **ADR 003 §8.2**'s `pagehide` row should say that durability is guaranteed and delivery is best
   effort — `flushSync` is synchronous and a request cannot be.
6. **ADR 003 §8.3** has no state for a stalled pull (the parking lot full). LZP-501 classifies it
   `pending`; the ADR should say so.
7. **`sync.contract.js` §3** — `verifyChain` cannot be synchronous (SHA-256 is `subtle.digest`).
   **§2** — `authHeader(p, deviceShort, sigPriv)` is not implemented as a separate function; the
   transport signs, because the signature covers the exact bytes it is about to send.
   **Cursors** — `set(space, seq)` is deliberately absent; `advance(space, seq, head, commit)`
   *runs* the commit, so there is no spelling of "advance the cursor" that skips the fold.
8. **ADR 001 §8.1** should state that the migration spine never travels, and that pairing owes the
   `board.json` hand-over. See **E5-6**.

---

## 8. Files E5 owns

```
src/js/family/engine.js          the family opt-in: identity, transport, key ring, engine, cadence
src/js/family/pairflow.js        LZP-505 — the pairing flow over the real rendezvous
src/js/family/mount.js           THE ONE DOOR — the only module the boot graph imports dynamically
src/js/family/familysettings.js  A10 — „Familienkreis" · „Meine Geräte" · „Abgleich"
src/js/family/pairingui.js       LZP-503 (built by the pairing-UI pass)
src/js/family/syncstatus.js      LZP-504 (built by the pairing-UI pass)
src/js/sync/*.js                 LZP-501, LZP-502
src/js/platform/net.js           the only fetch in the product, + the anonymous transport
src/js/platform/device-identity.js
tests/tier1/network-scope.test.js · platform-net · store-identity · sync-* (7 files)
tests/tier2/network-audit.dom.js · pairing-flow · pairing-sas · sync-status
tests/fleet/*.test.js · tests/helpers/{fleet,loopback,sync-loopback,netscope,relay-auth}.js
```

Files E5 edited that belong to someone else, and why each edit was unavoidable:

| file | edit |
|---|---|
| `src/js/store.js` | the E5-2 cap; the F-6 park and `unparkAttested()` |
| `src/js/core/ops.js` | `PARK_REASONS.ATTESTATION` + `classifyOp`'s `haveAttestation` (E3-3) |
| `src/js/core/oplog.js` | `load()`/`append()`/`unpark()` carry `haveAttestation` — without it the park is undone by a relaunch |
| `src/js/sync/personal.js` | E5-3's offline guard on `pushNow()` |
| `src/js/settings.js` | `setFamilySections(fn)` — a null callback, never an import |
| `src/js/main.js` | the one dynamic door, and `refreshFamilyChrome()` in `redraw()` |
| `src/js/i18n.js` | nine keys × two languages for „Familienkreis" |
| `dev-server.mjs` | `--relay` — the M1 demonstration lane, off by default |
| `package.json` | `test:fleet`, and it in `test:all` |
| four tier-1 / attack / tier-2 gate files | the STATIC amendment (§4.1) and three inverted accepted-defect rows |
| `tests/helpers/{importgraph,loopback,helper-hygiene}.js` | edge kinds; one re-export; the guard's self-exclusion |


---

## 9. WHAT ROUND 8 CORRECTED — read this before §0

*Added 2026-08-29 by the round-8 integration pass. `docs/v2/FINDINGS.md` §3c has the rows, §7a-round8
the mutants, §7d-2 the method.*

### 9.1 §0's verdict was right about secrecy and wrong about durability

> **M1 is demonstrated, not argued.**

It was, and every confidentiality claim in this document survived two adversary rounds intact. But
the demonstration was ONE scripted run, and a scripted run cannot see a defect whose trigger is an
interleaving. Two of them were there:

- **E5-2 was recorded in this document as CLOSED and was not.** §5's account of the clamp is
  accurate about what the clamp does; the clamp stood down in one arm, and that arm — `cap === null`
  — is the state EVERY compaction leaves a log in. `compact ▸ author offline ▸ compact` therefore
  still destroyed the unacknowledged edit, `outbox()` still returned 0, and both Macs still said
  `healthy`.
- **A second, independent defect was hiding behind it.** `oplog.load()` fed each tail line the
  `seq` its BYTES carry, and a tail line is written before any ack exists, so it always reads
  `null`; the durable ack lives in `checkpoint().seqs`. An acknowledged op came back looking
  unacknowledged, which dragged the outbox floor below the persisted horizon and pushed the clamp
  into its one unrecoverable arm. **Filed as L-4, CRITICAL.** It is reached by any Mac that quits
  after a compaction — no adversary, no old file, no hostile relay.

The measurement that separates a demonstration from a proof: the seeded convergence sweep diverged
on **the majority** of 24 seeds before this round, on **2 of 24** after E5-2's own arm was fixed —
a rate that reads as *"it works"* on most runs — and on **0 of 128** after L-4.

### 9.2 The park branch in this document's own engine was dead code

§2 records `pullNow`'s F-6 handling as built. The branch existed and never ran: it tested
`out.parked`, a field `openOp` does not set, so **every** park fell through to `terminal()` —
quarantined, cursor released, op destroyed. The two ADR promises this document cites (ADR 002
§5.2.5, ADR 003 §4: *"an old client in a family with a newer one degrades to does not show the new
thing instead of loses the new thing"*) were false in the shipped engine. **Filed as P-8,
CRITICAL, closed.**

### 9.3 Three states this document could not report, because nothing could see them

Round 8's enumeration of the op lifecycle opened three findings that had no adversary row at all:
a refusal that dies with the session (**L-1**), a durable hold nothing can report (**L-2**), and a
park with no reaper (**L-3**). All three are HIGH and all three are closed. They matter to this
document specifically, because §0's confidence rests on the demonstration having reported nothing
— and at the time, `sync.status()` could not have reported any of them.

### 9.4 The suite numbers in §1 are superseded

| suite | §1 (E5) | round 8 |
|---|---|---|
| `npm test` | 1956 / 0 | **1929 / 0** — the drop is `sync-client.test.js` deleted with the dead engine |
| `test:attack` | 648 / 0 | **706 / 0** |
| `test:property` | 70 / 0 | **85 / 0** — `sync-domains` walks 253 entries: 0 UNEXPECTED, 0 STALE |
| `test:server` | 799 / 0 | **815 / 0** |
| `test:fleet` | 60 / 0 | **103 / 0** |
| `test:dom` | 26 files, 1 fail | **26 files, tier 2 PASS** — the E3-10 Saturday row is closed |

### 9.5 What §0's verdict should say now

**For LOSS, M1 is proved rather than demonstrated.** The claim is no longer one run: it is 128
generated interleavings of partition, reorder, duplication, compaction, restart and quarantine
against the real store, the real op log, the real `openOp`, the shipped engine and all 23 server
handlers, over an enumerated 253-entry domain whose every cell is decided, with fourteen mutants
each naming the row that dies.

**For the PRODUCT it is not, and the gaps are unchanged and are not about losing ops:** **E5-6**
(a paired Mac receives none of the pre-space board, categories included) and **E1's `sync_request`**
in both shells — the demonstration ran on `fetch` in a browser, and the shipped app still has no
family transport. The two-Mac evidence also remains fleet-level: two real store modules with two
real disks over the real handlers, not two real machines.
