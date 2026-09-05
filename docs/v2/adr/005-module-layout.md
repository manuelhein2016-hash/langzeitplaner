# ADR 005 — Module layout, the DOM-free boundary, and the test strategy

| | |
|---|---|
| **Status** | Accepted — normative |
| **Date** | 2026-08-25 |
| **Tickets** | LZP-402, 406, 1002, 1005, 1007 · shapes every ticket in E2–E9 |
| **Depends on** | ADR 001, 002, 003, 004 |
| **Non-negotiable** | **zero runtime npm dependencies**, and **zero new devDependencies**. `node:test` + `node:assert` are built in. |

---

## 1. The target file tree

`[new]` · `[changed]` · everything else is v1, untouched.

### 1.1 Client — pure core

```
src/js/core/                      ── DOM-FREE, I/O-FREE, dependency-free
  dev.js            [new]   export const DEV = !!globalThis.__LZP_DEV — the shadow-assert flag
  b64.js            [new]   base64url + Crockford base32 encode/decode
  canon.js          [new]   canonical JSON (sorted keys, no whitespace, NFC strings) + varint
  ids.js            [new]   entityUuid / opId / groupId / memberId / spaceId / deviceShort
  stamp.js          [new]   HLC: createClock, fmt, cmp, msOf/ctrOf/devOf, MAX_FUTURE_DRIFT_MS
  ops.js            [new]   the FIELDS table, op constructors, payload validation
  entities.js       [new]   entityKey helpers, the SHARED day-selector (see §3), renderability,
                            sort comparators
  registers.js      [new]   the LWW join: applyOp / foldAll / mergeMaps / serialize
  authz.js          [new]   the staged fold: attestation → admin chain → membership → content
  project.js        [NOT YET BUILT — WP-10]  projectForFamily / assertFamilyPatch / retractPatch  (ADR 004 §2)
  materialize.js    [new]   RegisterMap + ctx → the exact v1 state shape
  undo.js           [new]   txn groups, pre/post images, inverse-op emission
  oplog.js          [new]   in-memory log, dedupe, checkpoint, compaction, parking
  migrate1to2.js    [new]   board.json (v1) → v2 ops, with GENESIS(i) stamps
  replace.js        [new]   the ADR 001 §8.5 diff transaction: import (11.3), snapshot restore (11.5)
```

**`src/js/boot.js`** `[new]` also belongs to §1.5's client tree — two statements, loaded by `src`
from `index.html`; see §2.1 for why it cannot be inline.

>  **Amended 2026-08-27 — two files this section had no home for.**
>  · **`replace.js` is its own level-1 module**, not a corner of `migrate1to2.js` and not part of
>  `ops.js`. It is not migration (that runs once, is deterministic, and stamps `GENESIS`; this runs
>  on demand, stamps the present, and is non-deterministic by design) and it is not `ops.js` (it
>  reads the current `RegisterMap`, which `ops.js` never does). Evidence:
>  `src/js/core/replace.js:67-77`.
>  · **`project.js` is the only entry in this tree with no file on disk.** `ls src/js/core/` returns
>  14 files and none of them is `project.js` — so **all of ADR 004 §2's single choke point is
>  unbuilt**. Owner: **WP-10**. Recorded by `judge:conformance` B-11 / A.3.


### 1.2 Client — crypto and sync (DOM-free, ports injected)

```
src/js/crypto/                    ── WebCrypto only
  suite.js          [new]   LZP-CRYPTO-1 algorithm constants + the HKDF info labels
  probe.js          [new]   probeCrypto() — runs at family opt-in, never on first run
  identity.js       [new]   device keys (KeyStore port) + recovery keys + attestation
  spacekeys.js      [new]   createSpaceKey / wrap / unwrap / KeyRing / epoch bookkeeping
  envelope.js       [new]   sealOp / openOp, AAD, padding, the §5.2 post-decrypt checks
  pairing.js        [new]   the §6.3 state machine, both roles, transport-agnostic, SAS
  invite.js         [new]   invite code derivation + verifier. Carries NO key material (D9)
  backup.js         [new]   export/import of the recovery artifact (PBKDF2 → AES-GCM)

src/js/sync/                      ── transport injected; contains no fetch
  protocol.js       [new]   header names, version constants, the signed-string builder
  chain.js          [new]   chain-witness computation and cross-check (diagnostic only)
  outbox.js         [new]   durable queue, batching, ack handling, quarantine
  cursor.js         [new]   per-space cursor persistence
  client.js         [new]   push/pull loop, cadence, backoff
  status.js         [new]   the three sync states + debounce
```

### 1.3 Client — platform (the only side effects)

```
src/js/platform/
  net.js            [new]   THE ONLY fetch() in the product; dynamically imported (ADR 003 §7)
  keystore.js       [new]   IndexedDB (WebKit) / Keychain-backed file (dev) / memory (Node)
  oplogfile.js      [new]   ops.jsonl + checkpoint.json through storage.js
```

### 1.4 Client — family UI (DOM-coupled, new)

```
src/js/family/
  familysettings.js [new]   create/join entry point, member list, admin panel, Datenschutz (A10)
  sharing.js        [new]   the three-state control + co-edit flag + attribution (A7, deliv. 18)
  pairingui.js      [new]   both-ends pairing screens incl. the SAS comparison (deliv. 21)
  syncstatus.js     [new]   the three-state indicator (19.3, deliv. 20)
  membersui.js      [new]   member legend section + per-member toggles (17.3, A3, deliv. 16)
```

### 1.5 Client — the v1 files, and exactly how much each changes

| file | v1 lines | change | size |
|---|---|---|---|
| `store.js` | 284 | `mutate()` → `txn()`; `applyRemote()`; register-backed state; storage port; `migrate()` gains the v1→v2 branch at `:67`; `replaceAll` becomes the diff txn (ADR 001 §8.5) | **rewrite of ~120 lines**; the public surface in §2.2 is preserved exactly |
| `interact.js` | 638 | 10 mutate sites → `txn` builders; **move `window.__lzpContextMenu` from `:199` into `initInteractions()` (`:27-40`)**; owner/co-edit guards at `:116-127` | **~70 lines** |
| `popover.js` | 296 | 6 mutate sites → `txn`; sharing cluster after `:212` and `:251`; `notesOn`/`barsOn` (`:47-61`) replaced by the shared selector | **~60 lines**, net negative once the duplicate selector goes |
| `legend.js` | 209 | 6 mutate sites → `txn`; two-section legend (`:18-46`) | **~45 lines** |
| `layout.js` | 276 | the six seams in ADR 004 §4.3 | **~10 lines** |
| `board.js` | 201 | initial chip, `belegt` label + class, handle guard, badges, „neu" dot | **~25 lines** |
| `storage.js` | 101 | `loadOps` / `appendOps` / `truncateOps` / `loadCheckpoint` / `saveCheckpoint`, same try-Tauri-then-fallback shape | **+60 lines** |
| `settings.js` | 297 | the *Familie* section mounts `src/js/family/familysettings.js` (A10) | **~25 lines** |
| `find.js` | 198 | family entries + Belegt owner-name matching (A6) | **~20 lines** |
| `print.js` | 84 | member section in the print legend (A8) | **~15 lines** |
| `backup.js` | 84 | v2 export/import shape, passphrase sheet (A2) | **~40 lines** |
| `main.js` | 363 | wrap the boot IIFE at `:30` in `export function boot()`; lazy `import()` of `sync/` | **~15 lines** |
| `i18n.js` | 187 | the v2 string set, DE **and** EN | **+~60 lines** |
| `dates.js`, `palette.js`, `holidays.js`, `ferien.js`, `ui.js` | 693 | **unchanged** | 0 |

**Total v1 delta ≈ 465 changed lines out of 3 911.** The two most valuable single-line changes
are the `interact.js:199` move (it makes the pointer state machine importable and therefore
unit-testable) and the `store.js` storage port (it kills the `ReferenceError: localStorage is not
defined` that the debounced `persistNow()` throws 700 ms into every headless test).

### 1.6 Server

```
server/
  core/
    router.js            [new]  (method, path) → handler. SHARED by Vercel and by the tests.
    auth.js              [new]  §2 signature verification, replay window, membership check
    limits.js            [new]  rate limits + payload caps, pure, over the store
    errors.js            [new]  HttpError → {status, code, message}
    version.js           [new]  PROTO_MIN / PROTO_MAX and the N−1 rule
    store-interface.js   [new]  the SyncStore JSDoc typedef (documentation + contract test)
    handlers/
      meta.js  ops.js  spaces.js  invites.js  members.js  devices.js  keys.js  pair.js   [new]
  adapters/
    memory.js            [new]  Maps + a mutex for tx(); snapshot/rollback. Tests + fleet.
    file.js              [new]  JSON on disk. Powers dev-server.mjs for two real windows.
    prisma.js            [new]  production only. $transaction, pooling from day one.
    vercel.js            [new]  the ONLY Vercel-aware file, < 40 lines
  dev-server.mjs         [new]  zero-dependency node:http host over the file adapter
  prisma/schema.prisma   [new]  ADR 003 §5.1

api/v1/index.js    [new]  ~15 lines: Request → router → Response
```

### 1.7 Tests — extending the harness that already exists

`tests/README.md`, `tests/helpers/env.js`, `tests/helpers/fixtures.js`, `tests/tier1/*`,
`tests/tier2/*` and `tests/run-dom-tests.sh` **already exist and are the convention. Extend them;
do not replace them.** In particular `env.js` already solves the `localStorage` problem, already
asserts (rather than shims) `crypto.randomUUID` / `structuredClone` / `queueMicrotask`, and
deliberately provides **no `document`** — a module that needs one belongs in tier 2, against a
real WebKit, not a hand-rolled fake DOM.

```
tests/
  README.md              [changed]  add the new dirs and the two-tier classification for core/
  helpers/
    env.js               unchanged
    fixtures.js          [changed]  + v2 register fixtures, + the 8×2y perf fixture builder
    clock.js             [new]  fakeClock(startMs): now(), advance(ms), and an HLC bound to it.
                                 NO TEST MAY READ THE WALL CLOCK.
    rng.js               [new]  mulberry32, seeded; the seed is printed on every failure so any
                                 failure is replayable
    gen.js               [new]  the op-stream generator every property test draws from (§5.2)
    loopback.js          [new]  a Transport bound directly to server/core/router.js
    fleet.js             [new]  makeFleet / makeDevice / assertConverged / assertNeverTransmitted
    mitm.js              [new]  an active-attacker Transport that substitutes ephemeral keys
    memkeystore.js       [new]  the KeyStore port, in memory
  tier1/                 node --test — pure logic (existing five files stay)
    …existing…
    core-purity.test.js  [new]  §2's two mechanical checks
    network-scope.test.js[new]  LZP-1002 gates 1 and 2
    stamp.test.js  registers.test.js  authz.test.js  materialize.test.js
    project.test.js  undo.test.js  oplog.test.js  migrate1to2.test.js
    envelope.test.js  spacekeys.test.js  pairing.test.js  invite.test.js
    backup.test.js  protocol.test.js  redaction-failpath.test.js          [new]
  property/              [new]  the LZP-406 harness — P1…P11, §5.2
  server/                [new]  one file per handler + store-contract.test.js + log-redaction
  fleet/                 [new]  LZP-1005 — one scenario file per F15–F18 story
  regression/v1/         [new]  the characterization suite LZP-402 is gated on (§5.3)
  fixtures/              [new]  real board.json corpus + family-8x2y.json
  tier2/                 real WKWebView (existing three files stay, + two new)
    …existing…
    family-render.dom.js [new]  foreign entries, Belegt block, badges, two-section legend
    crypto-persist.dom.js[new]  IndexedDB CryptoKey survival across relaunch (ADR 002 §2.2)
```

`package.json` scripts — **no new dependency**:

```json
"test":          "node --test \"tests/tier1/*.test.js\"",
"test:property": "node --test \"tests/property/*.test.js\"",
"test:server":   "node --test \"tests/server/*.test.js\"",
"test:fleet":    "node --test \"tests/fleet/*.test.js\"",
"test:regress":  "node --test \"tests/regression/v1/*.test.js\"",
"test:dom":      "./tests/run-dom-tests.sh",
"test:all":      "npm test && npm run test:property && npm run test:server && npm run test:regress && npm run test:fleet && npm run test:dom",
"dev:server":    "node server/dev-server.mjs"
```

---

## 2. The DOM-free boundary

> **HARD RULE.** No file under `src/js/core/`, `src/js/crypto/`, `src/js/sync/` or
> `server/core/` may reference `window`, `document`, `localStorage`, `indexedDB`, `navigator`,
> `alert`, `fetch`, `XMLHttpRequest`, `setTimeout`/`setInterval` (use the injected `schedule`
> port), `process.env`, `node:fs`, `Date.now()` or `Math.random()`. Clock and randomness arrive
> through `ctx`/ports. `core/` may not import from `platform/`, from `sync/`, or from any
> DOM-coupled v1 module.

**Dependency direction is one-way and must stay so:**

```
DOM modules  →  store.js  →  core/ ← crypto/ ← sync/
                                ↑
                          platform/ (may import core/, never the reverse)
```

**Enforced twice, mechanically, in `tests/tier1/core-purity.test.js`:**

1. **Static.** Read every file in the four directories, strip comments and strings, and fail on a
   regex match for any forbidden identifier — reporting `file:line`. Also fail on any `import`
   whose specifier escapes the allowed direction.
2. **Dynamic.** `await import()` every one of those files under bare Node with `globalThis.window`
   and `globalThis.document` **deleted**, asserting no throw.

### 2.1 The two v1 import blockers, and their fixes

Both were verified: 16 of 18 v1 modules import cleanly under bare Node 22; exactly two do not.

- **`interact.js:199`** — `window.__lzpContextMenu = (x, y) => { … }` at top level. **Move it
  inside `initInteractions()` (`:27-40`).** One line. This also unlocks unit-testing the
  drag-commit handlers at `:296-360`.
- **`main.js:30`** — `(async function boot() { … })()`. **Wrap it as `export function boot()`.**
  It **cannot** be called from `index.html` directly: the page ships
  `Content-Security-Policy: default-src 'self'` with no `script-src` override (story 13.4, asserted
  at `tests/tier2/shell-bridge.dom.js:68`), so an inline `<script type="module">` is refused by the
  page's own CSP and the app silently never starts. A CSP hash is brittle and `'unsafe-inline'`
  would destroy the zero-network property tier 2 asserts. The call therefore lives in
  **`src/js/boot.js`** — a two-statement, same-origin module — and `index.html:82` ships
  `<script type="module" src="./src/js/boot.js">`.
- **`main.js`'s top-level `window.addEventListener('blur', …)`** — a **third** import blocker the
  recon did not list, and the one that actually threw *synchronously* on import (the boot IIFE only
  produced a rejected promise). Move it inside `boot()`.

>  **Amended 2026-08-27 — this section said `index.html` calls `boot()`; it cannot.** Corrected
>  against the shipped `index.html:17, 82` and the 11-line `src/js/boot.js` that WP-3 landed.
>  `judge:conformance` B-12 also records that **STATUS §"New ADR amendment owed" named the file
>  `src/js/entry.js`; the file on disk is `src/js/boot.js`** and no `entry.js` exists — the STATUS
>  line is corrected in the same pass.

`tests/tier1/core-purity.test.js` additionally imports **all 18 v1 modules** and asserts none
throws, so this cannot rot.

### 2.2 The `store` surface that must survive LZP-402 verbatim

`board.js`, `find.js`, `print.js`, `legend.js`, `popover.js`, `settings.js`, `backup.js` and
`main.js` consume the store. These members are the **compatibility contract** and must keep their
v1 names, signatures and semantics:

```
store.state          store.subscribe(fn)      store.emit(reason)
store.undo()         store.redo()             store.canUndo()      store.canRedo()
store.setSettings()  store.setLayer()         store.replaceAll(next)
store.category(id)   store.categoryVisible(id) store.countEntriesIn(catId)
store.ensureVisible(catId)
store.listSnapshots() store.restoreSnapshot(day)
store.exportJSON()   store.exportFilename()
store.init()         store.flushSync()        store.schedulePersist()  store.persistNow()
store.ready
```

**`txn(label, fn)` replaces `mutate(label, fn)` at all 22 call sites** (ADR 001 §7.1) — the one
deliberate break, and the reason all 22 call sites are rewritten. New members:
`store.txn()`, `store.applyRemote(ops)`, `store.registers()`, `store.publisher`.

**`mutate()` itself survives, re-implemented as a diff transaction.** `fn` edits `state` in place
exactly as it always did; the store then diffs the four content keys plus `settings` against a
pre-image and emits the describing ops. It is kept for two reasons: WP-2's characterization suite —
which is the retrofit's *oracle* — calls `store.mutate` 44 times in
`tests/tier1/store-persistence.test.js` and 16 more times in `tests/tier2/`; and it made the
22-site conversion incremental, because a converted site and an unconverted one produce the same
ops into the same log. Same declines, same return value, same "a declining callback's edits are not
rolled back" quirk.

>  **Amended 2026-08-27 — this section said `mutate()` was removed. It was not.** Corrected against
>  `src/js/store.js:19-31, 642-653` by `judge:conformance` B-13. Because `mutate()` is a **supported
>  door**, two `judge:adversary3` findings against it are API-contract defects rather than dead
>  branches: **M-3** (a *nested* `mutate()` spends one ⌘Z on two actions, and the R5 shadow guard
>  then throws *after* the ops are appended and *before* `schedulePersist()`/`emit()` — leaving the
>  board changed, unsaved and un-redrawn) and **M-4** (a throwing callback's half-edit is adopted
>  into the log by the *next* action, permanently, with no undo step). Both are in
>  `docs/v2/FINDINGS.md`, owner **WP-4**.

The `return false` decline protocol at `store.js:150` survives verbatim; it already prevents 16
no-op mutations from reaching the log and it maps exactly onto "emit no op".

### 2.3 Storage plumbing — both shells

`storage.js` gains, in the same try-Tauri-then-fallback shape as its five existing functions:

```js
export async function loadOps();                     // → parsed JSONL lines
export async function appendOps(lines);              // JSONL APPEND — not a whole-file rewrite
export async function truncateOps(keepFromLine);     // whole-file rewrite; rare
export async function loadCheckpoint();
export async function saveCheckpoint(blob);
```

Both shells need matching bridge commands.

- **`shell-macos/main.swift` lands first** — it is what actually compiles and runs on this
  machine. Add `case "load_ops"`, `"append_ops"`, `"truncate_ops"`, `"load_checkpoint"`,
  `"save_checkpoint"`, plus `"keychain_set"/"keychain_get"/"keychain_delete"` (ADR 002 §2.2), to
  the switch at `:142-211`.
  **`append_ops` MUST use `FileHandle.seekToEnd` + `write`** — *not* the existing `writeAtomic`
  at `:39-43`, which is a whole-file replace. Appending a log by rewriting it is O(n²).
- **`src-tauri/src/lib.rs`** gets the same commands beside `:44-62`, registered in
  `generate_handler!` at `:209-217`, using `OpenOptions::append`. **This machine has no Rust and
  it will not be compiled here.** That asymmetry is inherited from the v1 baseline, is accepted,
  and is Risk R8 in `docs/v2/PLAN.md`.
- **`localStorage` cannot hold a growing log** (~5 MB quota, whole-value rewrite per `setItem`,
  and it is the only browser path). Decision: in the browser fallback the op log is **capped at
  2 000 tail ops with aggressive checkpointing**, and the dev banner says
  „Dev-Modus: Op-Log gekappt". Dev fidelity degrades; the shipped path's correctness does not.
- **`saveBoardSync` has no Tauri path** (`storage.js:60-66`); `store.flushSync()` relies on the
  shell awaiting `window.__lzpFlush` (`main.js:312`, honoured at `main.swift:375-387` with a 2 s
  watchdog). An unflushed **outbox** at quit inherits exactly this race — flush the outbox in the
  same hook.

---

## 3. One shared day-selector

`popover.js:47-61` (`notesOn` / `barsOn`) re-implements the day query independently of
`layout.js:61-79` and `:132-135`. In v2 it will **silently omit foreign entries** unless updated
in lockstep, so 17.1 and A6 would disagree in the popover.

**Extract one selector into `src/js/core/entities.js`** and have both `layout.js` and `popover.js`
call it. It is the cheapest way to guarantee agreement and it is a net line reduction.

---

## 4. Test strategy

### 4.1 Tiering, unchanged in principle

| | Tier 1 | Tier 2 |
|---|---|---|
| runner | `node --test` | `LangzeitPlaner --test <file>` (real WKWebView) |
| covers | `core/`, `crypto/`, `sync/`, `server/core/`, and the v1 pure modules | the real DOM, the real bridge, real events, the real `app://` origin gate |
| deps | none | none (`swiftc` + WebKit ship with macOS) |

Everything new in §1.1–§1.3 and §1.6 is **tier 1 by construction** — that is the entire point of
§2's rule. Only `src/js/family/*` and the v1 DOM modules need tier 2.

### 4.2 Property tests (LZP-406) — these land before any feature

`tests/property/`. Seeded, reproducible, zero dependencies. **The generator matters more than
the assertions**: `tests/helpers/gen.js` must produce *realistic* traffic — concurrent edits of
the same field by different devices, deletes racing edits, resurrect-after-delete, visibility
flips racing co-edits, category deletes with fan-out, two devices renaming the same category, a
Feb-29 repeat crossing a leap boundary, a month-roll boundary, and stamps from devices with
±10-minute clock skew plus one at +23 h (parked-adjacent) and one at +25 h (parked).

| id | property |
|---|---|
| **P1** | **order-independence** — for random op sets and 20 shuffles, `materialize(foldAuthorized(σᵢ(S)))` is deep-equal for all `i`, **including array order** |
| **P2** | **idempotence** — folding `S ∪ any multiset drawn from S` equals folding `S` |
| **P3** | **partition/heal** — 2–8 replicas, random local ops, random partitions, full gossip → all identical |
| **P4** | **monotonicity** — an op with a stamp older than a register never changes it |
| **P5** | **authz determinism** — shuffling ops never changes which ops `foldAuthorized` admits |
| **P6** | **solo-undo parity** — a reference implementation of v1's snapshot undo runs beside the op-log undo over random action sequences; materialized states compared **after every step** |
| **P7a–i** | **redaction** — the nine properties in ADR 004 §10, asserted on emitted ops and sealed bytes |
| **P8** | **migration losslessness** — `materialize(fold(migrateV1(b)))` deep-equals `stripV2Fields(v1migrate(b))` over a board corpus, array order included |
| **P9** | **ownership** — no op sequence, including backdated stamps at `ms = 0`, causes an entity's owner to change |
| **P10** | **checkpoint transparency** — `fold(S) === fold(checkpoint(S₁) ∪ S₂)` for every partition, **including out-of-order late ops** |
| **P11** | **envelope round-trip** — seal→open under the right key/epoch succeeds; wrong key → `OperationError`; mutated header → bad signature; substituted signer → bad signature; **and never a byte comparison of signatures** |

A failing seed is printed and pinned as a permanent regression case. Shrinking is delta-debugging
over the op array (remove one op, re-check, repeat) — about 30 lines, no library.

### 4.3 The v1 regression suite — LZP-402's gate (Risk R5)

`tests/regression/v1/` scripts **each v1 story that touches state** as a sequence of store calls
plus assertions on the projected state and on `buildBoard()` output.

**It must exist and be green *before* the retrofit, against unmodified v1**, via a thin
`txn → mutate` shim. That is the whole mitigation for R5, and it is why the work package order in
`PLAN.md` puts it at WP-2.

It runs with the **shadow-undo assertion** on (`__LZP_DEV = true`, ADR 001 §7.1), so any mutation
path whose op set is incomplete fails the suite rather than shipping.

It also pins the deliberate behaviour changes so they cannot drift further:
deterministic array order (ADR 001 §5 step 5) and the resulting `+n` truncation choice
(ADR 001 §13.8).

### 4.4 Server tests — real handlers, no Postgres, no Vercel

`tests/server/` drives `server/core/handlers/*` through `server/core/router.js` against
`server/adapters/memory.js`. Because §1.6 forbids any framework or Prisma import inside
`server/core/`, **every server story (LZP-202…207) is testable on this machine today** and "we
could not test it because we could not deploy" is never a valid excuse in this project.

`tests/server/store-contract.test.js` runs the same ~40 assertions against **`memory` and
`file`**, so `prismaStore` has one written specification to satisfy when a machine with Postgres
finally runs it. `store.tx(fn)` is in the interface precisely because Postgres transaction
semantics are the one behaviour that cannot be exercised here — the memory adapter implements it
with a mutex plus snapshot/rollback so the *shape* is exercised.

`tests/server/log-redaction.test.js` greps the log serialiser and fails if `envelope`, `ct`, `iv`,
`sig`, `wrapped`, `wrappedKeys` or any pair box can reach it (ADR 003 §6.2).

### 4.5 The simulated fleet (LZP-1005)

```js
// tests/helpers/fleet.js
export function makeFleet({ members, devicesPerMember, server = 'memory', seed })
// each device: its own KeyStore, its own OpLog, its own Store, its own sync client,
// a controllable clock, and a recorded transport.

fleet.dev('mama').act.createNote('2026-12-24', 'Bescherung', { visibility: 'geteilt' });
fleet.offline('papa-laptop');  fleet.advance('21d');  fleet.online('papa-laptop');
await fleet.settle();
fleet.assertConverged();                       // every device, identical materialization
fleet.assertNeverTransmitted('Zahnarzt', { except: ['papa-desktop','papa-laptop'] });
```

**Two server modes.** `'memory'` — the loopback transport calls the real handlers directly; fast,
and the default for the ~40 story scenarios. `'http'` — **one** scenario runs over
`server/dev-server.mjs` on real sockets, so the wire format, the request-signature auth and the
version header are exercised for real on a machine with no Vercel.

**Scenario inventory** (the traceability table's other half — one file per F15–F18 story, plus):

- pairing with the full SAS exchange · **pairing through `mitm.js`, which must produce SAS
  divergence and a refused pairing**
- two own devices syncing private data end-to-end (19.4); a device recovered from a backup
- create a Kreis, redeem an invite, assert the joiner rotates to `e+1` and the server's coverage
  check accepts it; assert an under-covering rotation is rejected
- share an entry → it appears person-coloured on the peer's board, counted into `+n` (17.4)
- **Geteilt → Belegt** → assert `pub.text === null` on the peer **and unchanged on the owner and
  on the owner's second device** (the promotion asymmetry, P7c)
- **→ Privat** → assert absence on the peer, presence on the owner
- admin unshare → the owner's entry reverts to private and is not deleted (18.3)
- remove a member → rotation, their entries vanish from every board, their next push 403s, their
  server ops are purged (20.2)
- leave → my entries revert to private and stay with me; others' entries leave my board (20.3)
- delete space → everyone reverts to an intact solo board (20.4)
- co-edit conflict with a per-field winner and exactly one loser notice (18.5)
- undo of my delete resurrecting against a peer's newer delete (18.6)
- **three weeks offline across two rotations and a month roll**, then converge (19.6)
- backup export → wipe → import → re-join, with and without the passphrase (A2, LZP-1004)
- every scenario re-run twice more with (a) all deliveries shuffled and (b) 15 % duplicated

### 4.6 Perf (LZP-1007, LZP-803)

`tests/fixtures/family-8x2y.json` — 8 members × 2 years, ≈6 000 entries. Asserted budgets:

| | budget |
|---|---|
| full `materialize()` | < 40 ms |
| `foldAuthorized()` of the whole checkpoint | < 120 ms |
| `sealOp` + outbox append for one op | < 10 ms |
| `buildBoard()` on the fixture | < 60 ms |

If `materialize` misses its budget, an incremental applier becomes its own ticket **with its own
equivalence property test** — it does not enter the foundation on speculation (ADR 001 §5.1).

### 4.7 Tier 2 additions

- `family-render.dom.js` — foreign entries in real day rows, the Belegt block's class and label,
  the badge family at 24 px, the two-section legend, the sharing cluster in the popover.
- `crypto-persist.dom.js` — **the ADR 002 §2.2 verification item**: generate a non-extractable
  `CryptoKey`, store it in IndexedDB, relaunch, re-read it, sign with it. If this fails, the
  fallback in ADR 002 §2.2 ships and `DESIGN-DECISIONS.md` records the downgrade.
- The existing `shell-bridge.dom.js` gains the new bridge commands and the **origin gate**: a
  real `fetch` to an off-allowlist host must be *blocked by the shell*, not merely unused.

---

## 5. What downstream agents must not change without a new ADR

1. `src/js/core/`, `src/js/crypto/`, `src/js/sync/`, `server/core/` are DOM-free and I/O-free, and
   the dependency direction is one-way.
2. Zero runtime npm dependencies. Zero new devDependencies. A test-only devDependency needs an
   explicit `DESIGN-DECISIONS.md` entry; a runtime one needs PO sign-off.
3. `server/core/` never imports Prisma, `@vercel/*` or `node:fs`, and never reads
   `process.env`/`Date.now()`/`Math.random()`.
4. `platform/net.js` is the only `fetch` call site, and it is dynamically imported. **(Rule stands;
   its mechanical gate is OWED — see ADR 003 §7 gate 1, amended 2026-08-27. `src/js/platform/` is
   not in `PURE_DIRS` and nothing scans it.)**
5. No test reads the wall clock or the network.
6. The v1 store surface in §2.2 is preserved; only `mutate` → `txn` breaks.
7. `appendOps` appends; it never rewrites the log.
8. The v1 regression suite is green **before** and **after** the retrofit.
