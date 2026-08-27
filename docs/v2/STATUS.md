# v2 — where the work stands

**Last session:** 2026-08-27 · **Stopped at:** both owed judges ran; their documentation half is landed
**Resume by reading:** this file, then `docs/v2/FINDINGS.md`, then `docs/v2/PLAN.md`, then the ADRs.

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
npm test              # tier 1, pure logic          → 1360 pass / 0 fail   (100 suites)
npm run test:attack   # adversarial corpus          →  340 pass / 0 fail   (29 suites)
npm run test:property # property harness, 500 seeds →   51 pass / 0 fail
npm run test:dom      # real headless WKWebView     →  278 pass / 15 files, tier 2 PASS
```

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
