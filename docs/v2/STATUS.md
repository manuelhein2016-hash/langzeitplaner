# v2 — where the work stands

**Last session:** 2026-08-27 · **Stopped at:** **E3 — identity and crypto — is built, proved in the
real WKWebView, and integrated** (LZP-302…306); round 6 fixed, integrated and verified against an
**enumerated input domain**; the register is caught up with rounds 6 and 7
**Resume by reading:** this file (start at the **E3 addendum** at the bottom), then
**`docs/v2/E3-VERIFICATION.md`**, then `docs/v2/FINDINGS.md` **§2e**, §1, §4 and §7d, then
`tests/helpers/domains.js`, then `docs/v2/adr/006-board-log-authority.md`, then `PLAN.md`.

---

## 1. One-paragraph state

The v2 **design** is complete and decided (5 ADRs, 5 contracts, 9 PO decisions). The **v1
regression gate** exists and is green. **WP-1 — the DOM-free op-log core — is built, attacked
three times and hardened twice. WP-3 — the retrofit — has landed: the shipping v1 app now derives
its state from an append-only op log**, all 22 mutate sites converted, and it behaves identically.
`board.json` is still `schemaVersion: 1` with v1's exact field set and zero v2 leakage.
**Both owed judges have now run** (§4), the twelve ADR amendments they produced are **applied to
the ADR text** (§6), and the **`deviceShort` contradiction is resolved** — ADR 002 §5.2 is
rewritten and is the single normative answer. Every finding from every audit now lives in one
register, `docs/v2/FINDINGS.md`. **A fix pass on 2026-08-27 closed seven of those rows** —
A3-C1 (CRITICAL), A3-H1, A3-H2, A3-H3, F-1, F-3, F-10 — each of them mutation-tested. The next
package is **WP-6, the crypto core**; **F-10 is no longer its blocker** (`attestationOf` is live
and `openOp` has its credential), so the remaining WP-6 prerequisite is **A3-H4**, durable device
identity (ADR 002 §2.2). Until that lands no fleet test means anything.

## 2. Suites — run these first tomorrow to confirm nothing rotted

```bash
npm test              # tier 1, pure logic          → 1665 pass / 0 fail   (101 suites)
npm run test:attack   # adversarial corpus          →  566 pass / 0 fail   ( 74 suites)
npm run test:property # property harness + domains  →   62 pass / 0 fail
npm run test:dom      # real headless WKWebView     →   22 files, tier 2 PASS
```

**Re-measured 2026-08-27 at the close of the round-7 integration pass — all four fully green.**
The tier-1 count includes the **parallel WP-6 crypto workflow**'s untracked files, which is why it
moves between runs; that workflow owns `src/js/crypto/`, `src/js/platform/keystore.js` and the
shells' Keychain bridge, and nothing in the round-6/7 fix pass touched any of them.

**`npm run test:property` now includes `tests/property/domains.test.js`** — 11 properties that walk
all **310 enumerated inputs**. If you change anything in `src/js/store.js`'s boot path,
`src/js/storage.js`, `core/oplog.js`'s indexes or `core/migrate1to2.js`'s coercion, **run that file
first**: it is the artifact that says what the *required* behaviour is, and it reports a
regression as `UNEXPECTED` and a stale work order as `STALE`.

**Re-measured 2026-08-27 after the round-5 integration pass** — these are the current numbers.
(The 1360 / 340 / 51 / 278 figures below are the *first fix pass*'s and are kept because the
paragraphs explaining the movement were written against them.)

Re-measured **after the fix pass of 2026-08-27** (A3-C1 / A3-H1 / A3-H2 / A3-H3 / F-1 / F-10
closed), all four green. The counts move for three independent reasons and none of them is a
regression: `judge:adversary3` added **43 rows in three files** under `tests/attack/`; the
**E1 pipeline agent** added `platform-updater.test.js`, `shell-updater.dom.js`,
`firstrun-unlock.dom.js` and `update-ui.dom.js` in parallel; and the fix pass **inverted** the rows
that were green because a defect existed and added the rows that pin the fixes. Rows in
`tests/attack/round3-*.test.js` tagged `SUCCEEDED (defect)` are green **because the defect is
there**; if one goes red, invert it, do not repair it. Rows tagged `FAILED (held)` or `INVERTED`
are the ones that have already been through that.

**Green is not the gate; falsifiability is.** Every fix in that pass was mutation-tested: reverted
in a scratch copy of the tree and required to redden a named row. The table is in
`docs/v2/FINDINGS.md` §7. One "fix" survived its own mutant and was rewritten as a reachability
characterization rather than left as a claim.

The shadow-undo assertion (risk R5's mechanical guard) is **armed** in all three `node --test`
scripts via `tests/helpers/dev-flag.mjs`, pinned by `suite-integrity.test.js` so an `--import` of
a no-op cannot satisfy it.

`test:dom` compiles the Swift shell with `swiftc` and drives the real board in WKWebView. It is
macOS-only, which is why `npm test` is tier 1 alone.

## 3. What is done

| | status |
|---|---|
| **Design** — ADR 001 op-log · 002 crypto · 003 sync protocol · 004 visibility/redaction · 005 module layout | complete, normative |
| **Contracts** — `docs/v2/contracts/*.contract.js` | complete, `node --check` clean |
| **Traceability** — `docs/v2/traceability.json` | 71 stories · 68 tickets · 12 amendments · 13 constraints |
| **Decisions D1–D9** | answered in `DESIGN-DECISIONS.md`, propagated into ADRs + contracts |
| **WP-2 v1 regression gate** (`tests/tier1/`, `tests/tier2/`) | the R5 gate the plan required; did not exist before |
| **WP-1 core** (`src/js/core/`, 14 modules) | LZP-401, 403, 404, 405, 406 |

**Commits** (nothing pushed; no remote exists):

```
3ab00c3  WP-1 round 2 — close the two-doors class, widen the corpus, prove the gates
99781fc  WP-1 fix pass — integrate six parallel fixes, close five more defects
496fa0d  WP-1 — the pure core, integrated and proven (LZP-401, LZP-406)
b230847  Propagate PO decisions D1/D7/D8/D9 through the ADRs and contracts
9c39775  Record the nine v2 blocking decisions (WP-0 exit criterion)
328c683  Add the v1 characterization suite (gate for LZP-402)
66126e9  v1 baseline — LangzeitPlaner 1.0 as handed over
```

## 4. The two owed judges — **DONE**, 2026-08-27

Both ran as a standalone read-only pass (not via workflow resume), against `c0306ac`. Neither
touched `src/`.

1. **`judge:adversary3` — DONE.** 43 new adversarial rows in three files under `tests/attack/`
   (`round3-seam`, `round3-doors`, `round3-persistence`). Produced **1 CRITICAL, 4 HIGH, 5 MEDIUM
   and 3 LOW** findings, and a list of 19 attacks that **failed** — the code held — which is
   recorded in `FINDINGS.md` §5 so the next round does not re-run them.
2. **`judge:conformance` — DONE.** A story-by-story audit of all 79 v1 stories and the v2 addendum
   against `src/js/core/` and the seven retrofitted v1 files, plus **the full ADR amendment list**
   and **the `deviceShort` resolution**. Produced 6 further findings (F-5…F-10) and confirmed
   11.6 lossless on the PO's real `board.json`.

**Everything both judges found is triaged in `docs/v2/FINDINGS.md`** — one register, with owner and
status per row, and a clearly marked "needs a decision" section for the three items that are a PO
call rather than an engineering fix. **The documentation half is landed (this session); the code
half is a separate later pass** — no `src/` file was changed.

## 5. Open findings → **`docs/v2/FINDINGS.md`**

**That file is now the single register.** 24 rows: 1 CRITICAL, 4 HIGH, 8 MEDIUM, 7 LOW, 4
INFO/gap — 18 open, 2 accepted, 3 needing a PO decision, 1 fixed. It carries the three items that
used to live in this section, plus F-1…F-4 from the WP-3 adversaries, plus everything both judges
found. **Do not add findings here; add them there.**

Read `FINDINGS.md` §3 before starting WP-8: **eight of the eighteen open rows go from latent to
live the moment a second device exists.** The three PO decisions are §4 of that file: F-1
(`board.json`'s byte stability), A3-H2 (coerce / quarantine / refuse when v2's type table is
stricter than v1's), and A3-M1a (a permissive door vs a throwing one).

The three items that were listed here, with what changed:

- **KNOWN GAP → WP-9 · security-relevant · still open (`G-1`).** A bare `dev.*` attestation makes its author a
  `currentMember`: an outsider can appear in the Kreis unassisted, and `currentMembers` is what
  gates foreign-entry visibility (story 20.2). Cannot be closed in WP-1 — membership has to be
  *conferred* by the invite/redeem flow before `authz.js` can refuse to infer it.
  → `tests/attack/convergence-authz.test.js:201`, `tests/attack/ownership-authz-admin.test.js`

- **~~STILL OPEN → WP-3~~ → FIXED, and verified (`G-2`).** The obligation was that the retrofitted
  store must call `planReplaceAll` — never the short entry point — for every import and snapshot
  restore, and hand `plan.retractions` to the publisher. `judge:conformance` A.3 (story 16.5) read
  `store.js:805` and confirmed it does exactly that; the publisher is still `nullPublisher`, which
  is correct until WP-10. `tests/attack/recheck-att40-replace.test.js:220` stays as the pin.

- **ACCEPTED, not a defect (`A-1`).** An import resurrects a tombstone at a fresh stamp. That is what
  restore *means* (story 11.5), and the fresh stamp is load-bearing for paired-device
  convergence (ADR 001 §8.5). Documented so nobody "fixes" it later.

## 6. ADR amendments — **applied 2026-08-27**

`judge:conformance` produced the exact list; **all sixteen are now in the ADR text.** Every
correction carries a marginal **Amended 2026-08-27** note naming the test, probe or finding id that
caught it, so the next reader can tell a *verified* sentence from a *reasoned* one.

### Applied

| # | where | what was wrong | evidence that corrected it |
|---|---|---|---|
| B-1 | **ADR 001 §7.3 cond. 3** | read progress alone was unsafe; write progress (`min(lastPushedSeq)`) is required or an unpushed write of any age resurrects a deleted entry | `src/js/core/oplog.js:150-199`, which implements both halves and fails closed |
| B-2 | **ADR 001 §5 step 5** | the **bar comparator** — `(startDate, endDate desc, id)` throws away the v1 array index. Corrected to `(_born, id)`. **§8.3's AC was correct as written; this section is where the error lived** — the old §6 mis-located it | `src/js/core/entities.js:694-704 cmpBars`, property P8 |
| B-3 | **ADR 001 §3.2 row 13** | `toggle-repeat` OFF must not re-write the anchor date | `git show 66126e9:src/js/popover.js:205-208`; `core-ops.test.js:1087`, `layout.test.js:1048` |
| B-4 | **ADR 001 §3.2 rows 11, 16** | two `[L]` marks the v1 source does not support, and a `{categoryId}` on a row with no category picker | `src/js/core/ops.js:845-848, 903-905` |
| B-5 | **ADR 001 §3.1** | `_born` was missing from the `fnote`/`fbar` field tables while §4.3 and ADR 004 §5 both already treat it as governing | `src/js/core/ops.js:154-160, 168` |
| B-6 | **ADR 001 §8.1 property 2** | "two migrations are **byte-identical**" overstates what holds *and* what is needed — the **registers** are identical; opIds and `dev` are not, and must not be | conformance probe `p2` test 2 against the PO's real `board.json` |
| B-7 | **ADR 001 §4.0** | attestation is a **LOOKUP**, not `deviceShort(op.dev)`; plus the self-authorizing bootstrap, write-once as *admissibility*, and park-don't-reject | `src/js/core/authz.js:159-173, 591-663`; findings F-6, H-4 |
| B-8 | **ADR 001 §7.4** | two parked classes missing: unarrived attestation, and an unreadable admin unshare | `src/js/core/ops.js:310-325`, `authz.js:782-793` |
| B-9 | **ADR 001 §5 step 2** | the promotion formula and 18.3 could not both hold — an admin unshare's `pub.text: null` blanked **my own note on my own board** | `src/js/core/registers.js:493-542 withdrawnByOther` |
| B-10 | **ADR 001 §7.2** | nothing wrong; re-read and marked **reviewed, no change**, with the `checkpoint().bodies` cross-reference, so it is not re-opened | `src/js/core/oplog.js:323, 492` |
| B-11 | **ADR 005 §1.1** | no home for `src/js/core/replace.js` (now added, with why it is its own level-1 module); `project.js` marked **NOT YET BUILT** — it is the only entry with no file on disk, and all of ADR 004 §2 depends on it | `src/js/core/replace.js:67-77`; `ls src/js/core/` |
| B-12 | **ADR 005 §2.1** | `boot()` **cannot** be called from `index.html` — the page's own CSP refuses an inline module. The call lives in `src/js/boot.js`; and `main.js`'s top-level `blur` listener was an unlisted **third** import blocker | `index.html:17, 82`; `src/js/boot.js` |
| B-13 | **ADR 005 §2.2** | `mutate()` was **not** removed; it survives re-implemented as a diff transaction, and is a supported door — which is why findings A3-M3/M4 against it are contract defects, not dead branches | `src/js/store.js:19-31, 642-653` |
| B-14 | **ADR 003 §7 gate 1** + **ADR 005 §5 rule 4** | the gate **does not exist**: no `platform/net.js`, no `tests/tier1/network-scope.test.js`, and `PURE_DIRS` never scans `src/js/` as a whole. Marked **OWED (WP-8 / LZP-1002)** rather than left implying it holds | `tests/helpers/purity.js:28`; finding F-9 |
| B-16 | **ADR 002 §2.3 + §5.2** | the `deviceShort` resolution — see below | `src/js/core/ids.js:138`, `authz.js:591-663` |
| — | **contracts** | `ops.contract.js` (`attestedDevices` mistyped; `attestationOf` owed), `crypto.contract.js` (`openOp`'s signature and check list), `server.contract.js` (`setLastPushedSeq`/`minLastPushedSeq`) | all three still `node --check` clean |

**B-15 · ADR 002 §7.1** was already rewritten for decision D9 — confirmed, no action.

### The `deviceShort` contradiction — **RESOLVED**

**ADR 002 §5.2 is rewritten and is the single normative answer; ADR 001 §1.2 is the single
definition and every other document defers to it.** `deviceShort = crock32(SHA-256(rawSigPubKey)[0..10])`,
a function of the **signing key**; `op.dev` is an unrelated random id; the two are joined by a
**lookup** over the member's `dev.*` attestation registers. ADR 001 §4.0 and ADR 002 §5.2 both now
say lookup. `envelope.js` can be written against §5.2 without a further decision.

**Two corrections were made to the resolution as the reviewer filed it**, stated in ADR 002 §5.2.1
rather than papered over:

1. **`att === null` cannot be a post-decrypt check.** The attestation is the only source of
   `authorSigPub`, so resolving it is a **pre-decrypt gate**, and what gets parked is a **sealed
   envelope, unopened**.
2. **`attestationOf` is keyed by `deviceShort` alone** — `op.act` is not knowable before decrypt, so
   a two-key lookup could not run where it is needed. That is sound **only** because ADR 002 §2.3's
   four acceptance conditions make `deviceShort → DeviceAttestation` a function across the space;
   those conditions are now written down, with a warning that relaxing them breaks §5.2.

~~**One thing is still owed in code:** `foldAuthorized` discards the decoded payload
(`authz.js:661`), so `openOp` has nothing to check against. That is finding **F-10**, ~10 lines,
and it is **the** WP-6 blocker.~~
**CLOSED 2026-08-27.** `parseAttestationBlob` now returns the full ADR 002 §2.3 `DeviceAttestation`
(all six fields, required — a blob missing one is rejected `badAttestation` rather than admitted as
a credential `openOp` could only throw on), the register walk keeps the payload, and `AuthzResult`
gains `attestationOf(deviceShort)` and `shortCollisions`. `ctx.attestOpen(memberId, blob)` is
accepted per ADR 001 §4.0 / ADR 002 §5.2.3, and the payload **always** comes from the register
bytes: an `attestOpen` whose answer disagrees counts as a failed verification, because otherwise
the injected function is a second, unlogged source of device identity.

**What §2.3 still does not close, and WP-6 must read:** §2.3 claims `deviceShort →
DeviceAttestation` is a function because two members would need the same signing *private* key.
Nothing pure and synchronous can check `crock32(SHA-256(sigPubRaw)[0..10]) === att.deviceShort` —
that is §5.2.2's **P2**, and it lives in `openOp`. A member can mint a well-formed attestation
under a peer's short and, **backdated**, take the lookup, because the contest resolves
minimal-under-`≺`. Stage 0b is unaffected (the device gate is per-member) and P2 refuses the
envelope, but the fold must not pretend the collision did not happen — hence `shortCollisions`.
**WP-6's `attestOpen` should enforce the P2 binding at fold time.** Register row I-3.

### Owed, and not amendments

- `ops.contract.js` now names `attestOpen(memberId, blob) => DeviceAttestation|null` as the
  replacement for `attestVerify`. **Owner: WP-6.**
- `server.contract.js` now names `setLastPushedSeq` / `minLastPushedSeq`. **Owner: WP-7.**
- ADR 003 §7 gate 1 and ADR 005 §5 rule 4 are marked **owed**. **Owner: WP-8 / LZP-1002.**

## 7. What to build next, in order

Per `docs/v2/PLAN.md` §2. WP-1 and WP-2 are done.

1. **WP-3 — the retrofit** *(LZP-402, 403, 404, 405)*. The first package that touches shipping v1
   code: `store.js` `mutate()` → `txn()`, all 22 mutate sites in `interact.js` / `popover.js` /
   `legend.js`, `storage.js` gains the op-log file, plus the two one-line unblockers
   (`interact.js:199`'s top-level `window.__lzpContextMenu`, `main.js:30`'s boot IIFE).
   **Gate: the v1 characterization suite stays green, with the shadow-undo assertion armed
   (`globalThis.__LZP_DEV = true`).** Honour the WP-3 obligation in §5.
2. **WP-4** property harness extension · **WP-5** render seams behind a null family.
3. **WP-6 crypto core** — resolve the `deviceShort` contradiction first.
4. **WP-7 server** (runs against the memory adapter here; Vercel/Prisma need your accounts) →
   **WP-8 sync + fleet → M1 "Zwei Macs"**.
5. **WP-9 Familienkreis** — closes the KNOWN GAP in §5 · **WP-10 visibility** · **WP-11
   rendering** · **WP-12 pipeline + hardening**.

Note that **E1 (the release pipeline) touches none of the same files** and can run in parallel
with WP-3–WP-5 whenever you want distribution dogfooded early, as the sprint plan intends.

## 8. What still needs you (not buildable here)

- **Vercel account + Prisma Postgres**, Frankfurt (D2) — for `server/adapters/prisma.js` and the
  real deploy. Every handler is testable here against the memory adapter without them.
- **A GitHub remote** (D3) — for Actions, Releases, and the updater channel.
- **No Rust toolchain on this Mac**, so `src-tauri/` cannot be compiled or smoke-tested. The
  Swift/WKWebView shell is the reference implementation and is fully buildable here. Risk R8:
  the Tauri commands must be built and smoke-tested on a machine with cargo before any Tauri
  build ships.
- **D1 = unsigned**, so **LZP-106 (the guided Systemeinstellungen unlock screen) is mandatory**
  and is the first thing Mom meets. Deliverables 27 and 28 are release-blocking. Reversible: a
  cert plus two CI secrets, no code change.

---

# Session 2 addendum — 2026-08-26

## WP-3 landed (LZP-402 / 403 / 404 / 405)

The v1 app is on the op log. Commits `125ba17` (retrofit) and the adversarial suites after it.

**What changed in v1 code** — 7 files, everything else byte-identical to the baseline:

| file | change |
|---|---|
| `store.js` | 284 → 888 lines. `mutate()` → `txn()`/`apply()` over the log; `applyRemote()` seam for WP-8; register-backed state materialised into the exact v1 shape |
| `storage.js` | +159. `ops.jsonl` + `checkpoint.json` beside `board.json`, same atomic-write and localStorage-fallback shape |
| `interact.js` | 10 sites converted; `__lzpContextMenu` moved out of top level |
| `popover.js` | 6 sites; local day-selector replaced by `core/entities.js`'s shared one (**net −4 lines**) |
| `legend.js` | 6 sites |
| `main.js` | boot IIFE → `export function boot()` |
| `boot.js` / `entry.js` | **new** — see the CSP note below |

`layout.js`, `board.js`, `dates.js`, `find.js`, `print.js`, `settings.js`, `backup.js`, `ui.js`,
`holidays.js`, `ferien.js`, `palette.js`, `i18n.js` are **untouched**. Rendering never learned about
the op log.

**Independently verified** (not just by the agents): the live app renders 12 columns / 372 rows /
12 pads with zero console errors; create → undo → redo → undo round-trips on the log; the persisted
note carries exactly v1's five keys at `schemaVersion: 1`.

## New findings from the WP-3 adversaries — all open, none blocking

- **F-1 · LOW · a decision, not a repair.** `board.json` stops being a fixed point across a restart
  once two scratchpads exist: `store.js:reconcileMap` does `Object.assign` and never *reorders* an
  existing live object, so `sortScratchpads` only takes effect on a freshly projected board. Content
  is identical and nothing on screen moves — but the file is atomically rewritten with different
  bytes on the first save of each session, and v1 *was* a fixed point. The fix is a one-liner
  (rebuild the map in projection key order, as `reconcileList` already does for arrays) **but it
  changes `board.json` bytes for existing users on their next save**, so decide it deliberately.
  Pinned green in `retrofit-probe5/6.dom.js`.
- **F-2 · not reachable by a human today, wrong failure mode.** An over-length value through the
  `apply()` door throws an **uncaught** `OpError` — the note is lost, no undo step, no warning —
  while the same value through the diff door truncates-and-warns. Measured in both WKWebView and
  Blink: `maxLength` holds for every human input route (typing, paste, `execCommand`, drop); only
  scripted `setRangeText` / direct `.value` bypass it, and no shipping site does. **It becomes live
  the moment WP-8's remote path puts an over-length string in front of `apply()`** — fix it before
  sync lands, as a truncate-and-warn or a visible decline.
- **F-3 · cosmetic.** `store.undoStack.length = 0` also clears redo, and `.push()` is a silent
  no-op. No shipping caller; belongs in `store.contract.js` §2.2 as an explicit divergence.
- **F-4 · already decided, now measured through the real keyboard.** ATT-5: deleting an already-
  deleted entry records 1 undo step where v1 recorded 2. Strictly better.

**Everything else held.** The real-app adversary ran 92 gesture-level rows in WKWebView — undo
grouping across month boundaries, the 50-step limit, autosave timing and `pagehide`, ⌘Z near a
focused field, delete-with-reassign over 80 entries as one undo step, pinned-mode paging, find,
print, the first-run coach, and a 200-gesture soak across a restart — with zero uncaught errors and
no divergence from v1 beyond F-1.

## New ADR amendment owed (adds to §6) — **APPLIED, see §6 row B-12**

> **Correction, 2026-08-27:** this section named the file `src/js/entry.js`. **The file on disk is
> `src/js/boot.js`** and no `entry.js` exists; ADR 005 §1.1 and §2.1 were amended to say `boot.js`.

**ADR 005 §1.1 / §2.1 owe `src/js/boot.js`.** §2.1 says `boot()` is called from `index.html`. It
cannot be: `index.html` ships `default-src 'self'` with no `script-src` override (story 13.4), so an
inline `<script type="module">` is refused by the page's own CSP and the app would silently never
start. A CSP hash is brittle and `'unsafe-inline'` would destroy the zero-network property tier 2
asserts — so the call lives in a two-statement same-origin module loaded by `src`, and the purity
gate pins it to exactly those two statements.

Also: the seams work found a **second, unlisted top-level blocker** the ADR does not name —
`main.js`'s top-level `window.addEventListener('blur', …)`, which was the *synchronous* throw on
import (the boot IIFE only produced a rejected promise).

## Still owed from session 1 — **CLEARED 2026-08-27**

> **Both judges ran** as a standalone read-only pass, exactly as this section asked. See §4 and
> `docs/v2/FINDINGS.md`. The paragraph below is kept for the history of *why* the resume attempt
> was abandoned.

The two WP-1 judges (§4) had **not** run. A resume attempt re-executed the Repair phase instead of
replaying it from cache, and it was writing to core files whose fixes were already committed while
WP-3 was building against them — so it was stopped and its uncommitted work reverted to the
proven-green commit. **Run the two judges as a standalone read-only workflow**, not via resume.

Its one genuinely new artifact — a shared `src/js/core/v1import.js` extracting the duplicated
v1→ops logic out of `migrate1to2.js` and `replace.js` — is saved as a patch at
`<scratchpad>/round2-rerun/rerun.patch`. It is an internal refactor, not a correctness fix: the
two-doors parity it would tidy is already proven by property **P13** over 500 seeds. Redo it cleanly
when convenient, or drop it.

---

# Session 3 addendum — 2026-08-27 · the documentation half

Read-only session. **No file under `src/` was changed**, and no code fix was applied — the code half
of both audits is a separate, later pass, and three of the findings are PO decisions rather than
repairs.

**What landed**

- **`docs/v2/FINDINGS.md` — new, and the single register.** 24 rows with id, severity, one-line
  description, `file:line`, owning work package and status; a "fix before WP-8, in order" list; a
  clearly marked "needs a decision" section with the trade-off in two sentences each; a record of
  the 19 attacks that **failed**, so the next round does not re-run them; and a record of the six
  things neither audit could execute.
- **Sixteen ADR amendments applied** to ADR 001, 002, 003 and 005 plus three contracts — §6 above
  has the table. Each carries a marginal note naming its evidence.
- **The `deviceShort` contradiction is resolved** in ADR 002 §5.2, with two corrections to the
  filed resolution stated loudly in §5.2.1 rather than smoothed over.

**Suites re-measured, all four green** (§2). Unchanged code, so this was a check that nothing rotted
under the E1 agent's parallel work, not a claim about this session.

**Watch out for:** the E1 pipeline agent was editing the working tree throughout this session
(`shell-macos/`, `src-tauri/`, `.github/`, `scripts/`, `server/`, `src/js/platform/`, `src/js/i18n.js`).
Those changes are **not** part of this session's commit. One tier-2 run failed mid-session with a
shell syntax error because `shell-macos/build.sh` was being written at that moment; the re-run was
clean. **Finding F-9 is about that work and belongs to E1: `src/js/platform/` is scanned by
nothing.**


---

# Session 4 addendum — 2026-08-27 · rounds 4 and 5, fixed and integrated

**Read this first.** Two more adversary rounds ran against the retrofit, three fixers worked in
parallel, and one integration pass landed the cross-file work, verified it, and caught the register
up. All four suites green: **`npm test` 1374 · `test:attack` 512 · `test:property` 51 ·
`test:dom` 15 files, tier 2 PASS.**

## The headline: the rule held, the implementation did not

ADR 006 — *`board.json` is the truth, the op log is history* — **survived round 5 without
amendment to §1**. Three attempts at this question have now been made and the third is the first
one an adversary could not break at the level of the rule. Every round-5 finding was an
implementation defect underneath it, which is the outcome you want from an ADR.

**Four things were wrong under it, and two of them were serious:**

| what | severity | why it mattered |
|---|---|---|
| **R5-3** — A3-C1 reachable again through R7 | CRITICAL | R7 (the absent-`board.json` recovery) was entered on `kind !== 'ok'`, so a board that merely failed to **parse** took the branch that performs **no lineage check at all**. One truncated byte + the attacker's own legitimate log pair = the stranger's board on screen and committed. **CLOSED.** |
| **A3-M5 / R5-4** — the log stops recording on the second launch | HIGH (was filed MEDIUM/latent) | `_persistOps` never called `appendOps`, and `checkpoint()` folds only to the horizon it was loaded with — so from launch 2 onward **nothing the user did was ever written to the log again**, every ordinary launch reconciled a growing diff, and `_born` (which decides array order) was re-minted on every launch. **CLOSED.** |
| **R5-11** — an unreadable bar edge | MEDIUM | The edge was dropped, a one-ended bar is anchored to the other end, and a bar v1 drew **nowhere** was drawn across every column with chevrons, taking a lane from real bars. `endDate: ""` is the commonest hand-edit there is. **CLOSED**, narrowed residual in FINDINGS §4.6. |
| **R5-2e** — two ADRs that could not both be obeyed | MEDIUM | A wrong wall clock made ADR 006 §12.6 and ADR 001 §1.3 jointly unsatisfiable, and the loser was the user's whole history — quarantined *and renamed*. **CLOSED** as a deferral, in code and in both ADRs. |

## What the integration pass itself found

**Two of the three fixers' "left for another agent" items were unproven fixes.** `_projectSafe`
clobbering `bootFailure`, and `persistNow`'s read-only sentence claiming a board "could not be
**drawn**" on three reasons where nothing had even read it. Both were landed here — and reverting
either killed **nothing** in any of the four suites, which is the same thing as not having a fix.
Rows **R5-3e** and **R5-3f** were written to close them before they were recorded as fixed.

**One attack row was still asserting a closed defect.** R3-39 claimed `_persistOps()` never
appends. Inverted, and its file header's "`store.js` never writes `ops.jsonl`" corrected to the
narrower claim R3-38 actually pins.

**The headline check for R5-4 — boot · edit · restart · edit · restart — is now a permanent row**
(R5-4f), because the defect was only ever visible as a *sequence*: each launch looked fine and the
damage was that the number grew.

## What you actually have to decide

**`docs/v2/FINDINGS.md` §4 has two new open decisions, and one of them blocks WP-6:**

- **§4.5 — I-3 / R5-7: a remote denial of service on any family member's device.** One op from
  anybody permanently mutes a named Mac, and **WP-6's owed P2 check does not close it.** If the
  plan of record for WP-6 is "we'll fix I-3 with the attestation binding", that plan is wrong. Read
  §4.5 before any attestation code is written.
- **§4.6 — R5-11g:** a bar edge with no faithful v2 value at all. Blocks nothing; it is a fidelity
  ceiling and should be an explicit one.

**§4.7 records that ADR 006 §12.6 vs ADR 001 §7.4 is NOT a decision** — R5-2e resolved it in code
and in both ADRs. Nothing is owed to you there.

## Register and ADRs

**`docs/v2/FINDINGS.md` was three rounds behind and is now caught up.** 31 rows → **39**, counts
recomputed from the rows rather than carried forward, with a table of what moved between severities
and why. New: **§7c**, the accepted-defect list — all 23 `tests/attack/` rows that are green
*because a defect exists*, each mapped to its register row. Nine of the twenty-three trace to just
three rows (F-2/F-7, A3-H4, I-3), which is the useful reading of it. §6b's corpus table is
regenerated, not hand-edited: round 5's new generator block consumes the rng stream, so several
existing rows moved without anything about them changing.

**ADR 006** gains a rewritten **§5.5** (R7's precondition is `absent`, and only `absent`), a new
**§5.6** (the read-only boot over `snapshots.json`), and `board-unreadable` in §7's reason enum.
**`store.contract.js`** documents `diagnostics().recoveredFrom`, the widened `bootFailure.reason`,
and the two new quarantine reasons.

## Two things to fix about the process, not the code

1. **`src/js/store.js` and `tests/attack/round5-authority.test.js` were assigned to two fixers at
   once.** Both used anchored edits and both survived, but that was luck. One owner per file.
2. **A fixer reporting "left for another agent" is reporting an unproven fix.** Two of three did,
   and neither item had a test. Treat that list as work, not as a note.

## Still owed (full list in FINDINGS §8)

- **ADR 001 §7.2's own text** still describes a 30-day debuggability tail and a 2 MB-at-launch
  trigger. Neither is implemented — compaction is total. The deviation is recorded in ADR 006 §8.5
  and at the `TAIL_COMPACT_AT` docblock; **§7.2's text itself is unamended.**
- **The first-run tour still shows over a disaster boot with no snapshot** (`seenFirstRun` left at
  v1's value; a tier-1 row characterizes it by name). Tier-1 owner's call.
- **I-6** — `quarantineLogAside` on the native path still cannot move anything. Much less pressing:
  a failed boot never sequesters at all now.
- **F-5 / R5-5b** — folding an adopted checkpoint through `applyRemote`'s gate. WP-8.

---

# Session 5 addendum — 2026-08-27 · round 6, and the method that finally closed it

**Read this first, and read it before you read the fixes.** Round 6 ran against the op-log core and
the retrofit. Its findings were closed by three parallel fixers and one integration pass, and all
four suites are green: **`npm test` 1665/0 · `test:attack` 566/0 · `test:property` 62/0 ·
`test:dom` 22 files, tier 2 PASS.**

**Per-domain, every enumerated input gets its required behaviour:** D1 94 + D1_RECOVERY 8 · D2 44 ·
D3 5 · D4 14 · D5 4 · D6 141 = **310 entries, 0 UNEXPECTED, 0 STALE, 0 `openFinding` remaining.**

## THE PROCESS CHANGE — this is the part that matters, and it is now a rule

**`tests/helpers/domains.js` is the required method for ADR 006 §5/§7/§9.** Not a suggestion, not
a nice-to-have: **the required method.** It is recorded in FINDINGS **§7d** and in ADR 006 **§10**.

Five consecutive rounds each **relocated** the same failure rather than closing it, and round 6's
closing verdict named why:

> The fixes are still being chosen a branch at a time, and the branch is chosen before the input
> domain is written down. R6-5a is the sharpest instance: round 5 replaced "is raw null?" with a
> careful five-way classifier and wrote out four of the five kinds in a docblock — and `''` still
> went to the wrong one, because the enumeration was of **branches** (ok/absent/unparseable/
> not-a-board/read-failed) rather than of **bytes**.

**So: enumerate the INPUT DOMAIN first, exhaustively, as data. Then choose behaviour per input.
Then property-test over the domain.** `tests/helpers/domains.js` holds **310 entries** across six
domains (D1 bytes × sources, D2 stamps × authorship, D3 provenance, D4 checkpoint growth, D5 array
order, D6 date strings by sort position), each `{id, value, label, expect, openFinding}` where
`expect` is the **required** behaviour. `tests/property/domains.test.js` walks every entry and
never stops at the first failure: it splits deviations into **UNEXPECTED** (a regression),
**STALE** (a finding is named but the entry now holds — *the work order is lying*), and the work
order itself.

**It worked, measurably.** The enumeration opened with a **51-entry work order** and 0 unexpected,
0 stale. All 51 are closed; `openFinding` is `null` on all 310 entries; every property is green.

**And it found two things six adversary rounds did not:**

1. **Round 6's closing "content is safe" is wrong.** `D1-b18` — `{"_v2":{lineageId:<the victim's>,
   gen:N}}`, an object that is nothing but ADR 006's envelope — classified `ok`, matched
   `same-lineage`, **adopted the log**, and made `_reconcileOntoBoard` mint **nine well-formed
   `{_alive:false}` retractions**, both committed. Every other row in the register costs *history*.
   That one costs **the calendar** — and at WP-8 what propagates is not a corrupt file but deletes
   this app minted itself. **`Array.isArray` was the entire guard.** → FINDINGS **R6-5**, CRITICAL.
2. **A premise correction in the *permissive* direction**, which is the one that proves the method
   is not just a ratchet. FINDINGS §4.6's open decision — *a bar edge with no faithful v2 value* —
   turned out to be **misstated**: the collision with finding 6 is a question about *which field*,
   not about which fidelity. **§4.6 is closed and no PO ruling is owed.**

## What was closed

| row | severity | one line |
|---|---|---|
| **R6-5** | CRITICAL | ADR 006's precondition had a hole on **both** sides: a **zero-byte** `board.json` was `absent` (so a truncated write took the one branch that may adopt a log), and **any** JSON object was a board (so the envelope-only object emptied the calendar and minted the deletes) |
| **R6-4** | HIGH | One op parked for a bad clock quarantined **the entire history**, on every launch until the stamp passed — with `_opsPersisted = false`, so the device recorded nothing meanwhile. And the park was decided **before** authorisation, so a stranger could trigger it with a date |
| **R6-3** | HIGH | The bound on `ops.jsonl` was purchased with an **unbounded `checkpoint.json`**: `bodies` was the one index `pruneSeqIndex` stepped over, and it is serialized into the file rewritten on every debounced save |
| **R6-10 / R6-11** | HIGH / MEDIUM | A bar edge sorting **inside** the rendered range was dropped; **2 414 of 9 104** measured cases painted the wrong columns. Closed by one rule over the whole alphabet instead of a three-way split |
| **R6-7** | MEDIUM | The reconciler could not mint a **position**, so restoring an older `board.json` put a deleted entry back at the **end** of the list instead of where the user had it |
| **R6-6** | MEDIUM | The inverse of R5-3's caution: a recovery that **failed** fell out as an empty, **writable** board — while `snapshots.json` sat loaded and unread |
| **R6-2** | LOW | ADR 001 §7.2's 2 MB-at-launch compaction trigger was never implemented (≈3 MB in ≈260 lines, nowhere near the line cap) |
| **R6-7e** | LOW | ADR 006 §9.3's W2 contradicted §7's own table. §7 is right; W2 conflated the local binding with the stamps on a re-derivation. **Amended** |

## The headline checks, measured at integration

- **(a)** A **foreign** op stamped +48 h becomes **0 lines**, reaches `checkpoint().parked` **0**
  times, and the next launch has `quarantine === null` with the history adopted and `reconciled 0`.
  The refusal is reported **by name** (`notMyAct`), and no warning names this Mac's clock. The
  user's **own** device at +48 h is still **parked** — the park survives the re-read, the future
  value never reaches the screen, and it still costs that op and nothing else.
- **(b)** `checkpoint.json` over **10 sessions × 400 edits** on a one-note board: 5 996 B → **75 000
  B at the first compaction that fills `bodies`, then flat to within 1 byte** while ops-ever goes
  2 000 → 4 000. The control — the same 4 000 ops on 1/5/25/100/400-note boards — holds `bodies` at
  the cap in every row, so all the variation is the register, i.e. the board. **Honest statement of
  the bound: `O(board) + O(min(ops-ever-compacted, 1500))`** — bounded and flat, *not* proportional
  to board size, with a ≈75 KB constant a small board pays once it has been edited 1 500 times.
  That constant is pinned by D4 and by a tier-1 row on `BODY_FINGERPRINT_CAP`, so drift is red.
- **(c)** A **zero-byte** `board.json` beside a stranger's *legitimate* log: `bootFailure` is
  `board-unparseable`, `_adopted` is **null**, the stranger's note is **not** on screen, the
  snapshot stands in, the log is quarantined `board-unreadable` and **not** renamed, and a persist
  **moves not one byte**.
- **(d)** Delete the middle of three notes, then restore the older `board.json`: `quarantine` null,
  **exactly 1 op** reconciles the difference, the note is **back** and the order is `a, b, c` — and
  the **second** launch reconciles **0**, so it converged rather than re-minting every launch.

## Mutation testing

**Twelve mutants**, applied to a fresh scratch copy at the round-7 head, reset between rows, all
three node suites re-run each time. **Every one is lethal and every one names the row it kills** —
the table is FINDINGS **§7a-round7**. The seven the brief names by letter (F1 bodies-pruning, F2
`_clockSkew` liveOnly, F3 `''` unparseable, F4 object shape gate, F5 empty-projection fallback,
F6 order clause, F7 bar-edge floor) are all included, along with five near-misses that distinguish
a real fix from one that merely passes.

**Three mutants initially killed nothing**, which is the part worth remembering: the rows had to be
rewritten against the input that *distinguishes* — a **superseded** op, and a spliced id that still
holds a line at eviction time. And a fourth (`_standIn`'s snapshot set to `null`) reddens **eleven**
attack rows, so story 11.5 is now genuinely load-bearing on the disaster path rather than merely
claimed to be.

## What this pass found itself

**R7-1, open, LOW.** R6-6's fix added a **fourth** boot outcome to a **three**-valued
`diagnostics().source`, and it reports `'board.json'` — documented as *"solo mode, or the log was
quarantined"* — about a boot where there is **no `board.json` at all**. Its twin (§5.6's read-only
boot over a zero-byte board) reports `'recovery'` for the same picture. Two rules are implemented
at once, and the comment justifying the second is verbatim the argument that condemns the first.
**Diagnostics only** — `bootFailure.reason` and `recoveredFrom` carry the whole truth. **Filed, not
patched**: widening a documented contract field belongs to `store.contract.js`'s owner, and jamming
a fourth outcome into whichever of three values fits least badly is the exact move §7d exists to
stop.

## Process, again — and it is the same item as last session

**`src/js/store.js` had three concurrent editors this round.** All three used surgical
unique-anchor edits, all three landed cleanly, and each proved its own changes green in isolation —
but that is care, not process, and it is the second round running. `store.js` is 2 400 lines and is
the file every round's fixes land in. **It needs splitting, or one owner per round with the other
fixers handing it patches.** → FINDINGS §8 item 11.

The other standing lesson held: **a fixer reporting "left for another agent" is reporting unowned
work**, and this pass landed all of it — ADR 006 §5.5's outcome enumeration, §5.6's table,
§9.3's W2, INV-20, §10's method note, ADR 001 §7.2's two halves, and the register itself, which had
**no `R6-*` rows at all** before this pass.

## Still owed (full list in FINDINGS §8)

- **R7-1** — the fourth `source` value (item 12).
- **A `clock-skew` residual with no escape hatch**: a local clock set a *year* forward and then
  corrected leaves live register stamps a year ahead, so the log is deferred-quarantined **for a
  year** with no user action that helps. Content is whole throughout. **It needs a domain of its
  own before it needs a fix** (item 13).
- **`seen` is unbounded in-session** — ≈150 KB RAM at 6 400 ops, bounded across restarts by
  `bodies`' cap (item 14).
- **A settings pane for `recovery-unusable`'s copy**, which is written and unrendered — the same
  owed surface as F-8's consumer (items 1 and 15).
- **A WP-8 cross-device invariant on the interpolated `_born`** (item 16).
- **I-6** — `quarantineLogAside` on the native path still cannot move anything. Less pressing
  again: neither a failed boot nor a failed recovery sequesters.
