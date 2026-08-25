# v2 — where the work stands

**Last session:** 2026-08-25 · **Stopped at:** WP-1 round-2 hardening, judge phase cut short
**Resume by reading:** this file, then `docs/v2/PLAN.md`, then the ADRs.

---

## 1. One-paragraph state

The v2 **design** is complete and decided (5 ADRs, 5 contracts, 9 PO decisions). The **v1
regression gate** exists and is green. **WP-1 — the DOM-free op-log core — is built, attacked
three times, and hardened twice.** No v1 file has been modified yet: the app still runs exactly
as it did at the baseline commit. The next work package is **WP-3, the retrofit**, which is the
first one that touches shipping v1 code.

## 2. Suites — run these first tomorrow to confirm nothing rotted

```bash
npm test              # tier 1, pure logic          → 1308 pass / 0 fail
npm run test:attack   # adversarial corpus          →  218 pass / 0 fail
npm run test:property # property harness, 500 seeds →   51 pass / 0 fail
npm run test:dom      # real headless WKWebView     →   16 pass, tier 2 PASS
```

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

## 4. The one unfinished thing from last session

Round-2 hardening ran **Repair → Prove** to completion and committed as `3ab00c3`. Its final
**Judge** phase was stopped mid-flight. Two reviews were never run:

1. **`judge:adversary3`** — a third adversary against round 2's own fixes. Rounds 1 and 2 both
   introduced regressions while fixing things, so assume round 2 did too. Highest value: attack
   the unified door, the A1 splice-across-compaction fix, the A7 seq-by-opId fix, the
   park-reason persistence, and hunt for a round-2 equivalent of "the guard now refuses boards
   v1 opens".
2. **`judge:conformance`** — a story-by-story audit of `src/js/core/` against the v1 and v2
   specs, plus the list of **ADR amendments now required**. Several ADR statements were corrected
   in code comments but never in the ADR text (see §6).

Re-run both first thing. The workflow script is preserved and can be resumed from cache:

```
Workflow({scriptPath: "<session>/workflows/scripts/lzp-wp1-harden-2-wf_9f9b7354-435.js", resumeFromRunId: "wf_9f9b7354-435"})
```

Repair and Prove replay from cache; only the two judges actually run.

## 5. Open findings, deliberately deferred (do not lose these)

Both are annotated in the tests themselves, pinned to current behaviour so the row is green
while the gap exists. **If either test goes red, the gap was closed — invert the row, do not
"repair" it.**

- **KNOWN GAP → WP-9 · security-relevant.** A bare `dev.*` attestation makes its author a
  `currentMember`: an outsider can appear in the Kreis unassisted, and `currentMembers` is what
  gates foreign-entry visibility (story 20.2). Cannot be closed in WP-1 — membership has to be
  *conferred* by the invite/redeem flow before `authz.js` can refuse to infer it.
  → `tests/attack/convergence-authz.test.js:201`, `tests/attack/ownership-authz-admin.test.js`

- **STILL OPEN → WP-3.** `replaceAllOps()` returns ops alone by contract, so the retraction
  carrier exists only on the *plan*. **The retrofitted store must call `planReplaceAll` — never
  the short entry point — for every import and snapshot restore, and hand `plan.retractions` to
  the publisher.** Core cannot enforce this; nothing in `core/` runs after the transaction lands.
  Without it, an imported/restored board leaves entries live on the family's boards (story 16.5).
  → `tests/attack/recheck-att40-replace.test.js:220`

- **ACCEPTED, not a defect.** An import resurrects a tombstone at a fresh stamp. That is what
  restore *means* (story 11.5), and the fresh stamp is load-bearing for paired-device
  convergence (ADR 001 §8.5). Documented so nobody "fixes" it later.

## 6. ADR amendments owed

Corrected in code and comments, never in the ADR text. `judge:conformance` was going to produce
the exact list; these are the ones already known:

- **ADR 001 §7.3 condition 3** states only the `lastSeenSeq` half. It must also require write
  progress — `min(lastPushedSeq)` — or an unpushed write of any age resurrects a deleted entry.
- **ADR 001 §8.3's acceptance criterion** was false as written (bar array order). Bars now sort
  by `(_born, id)`; the AC text needs to match.
- **ADR 001 §3.2 row 13** ("toggle-repeat → one op, two fields") is wrong for the OFF direction;
  v1 only assigns `date` when the repeat is switched ON. The code is right, the ADR is not.
- **ADR 001 §1.2 vs §4.0 / ADR 002 §5.2 — `deviceShort(op.dev)` is a genuine contradiction.**
  `op.dev` has no derivational relationship to the signing key, so `deviceShort()` cannot be a
  function of it. Implemented per §1.2 (the numbered definition); the §4.0/§5.2 step must
  therefore be a **lookup** over the member's `dev.*` registers, not a hash. **Resolve this
  before `envelope.js` is written** (WP-6).
- **ADR 005 §1.1** has no home for `src/js/core/replace.js`, which now exists.
- **ADR 002 §7.1** was already rewritten for decision D9 — no further action.

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
