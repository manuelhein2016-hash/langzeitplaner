# LangzeitPlaner v2 — the final integration record

**Date:** 2026-09-04 · **Tree:** `v1-characterization-suite`. Three passes are recorded here: the
four-way integration onto `6268cbe` (§3 onward, kept as written), the closing pass onto `78016e8`
(§0, §1, §2 and the re-issued §8), and **the audit fix cycle onto `2d092a6`**, which is §-1 below
and the re-issued §8. The audit itself, with every finding marked and its evidence, is
`docs/v2/AUDIT.md`.

This file answers the question the whole product is for:

> **Can a stranger get from an e-mail to a shared family board — and does nobody lose anything on
> the way?**

**Yes, and nobody does.** The refusal ledger, which had never once been flat, is **0** — and it
stays 0 across a quit-and-open, which is the thing this project could not previously say.

---

## −2. LZP-1009's second pass (2026-09-05), in five lines

The feedback channel composed a report, redacted the board by re-rendering it with **no glyph path
in the product at all**, previewed exactly what would leave, and POSTed it — and it was unusable,
for two measured reasons: a **solo** Mac could not send (the port was bound only behind the family
door, and the report that matters most is *"I cannot join"*), and the deployed relay bound **no
sink**, so even a family Mac got an honest 501. The PO ruled on both.

1. **A solo Mac may send.** `feedback/relay.js#bindSoloSender` is a second caller of
   `setFeedbackPort` and the **second dynamic door** out of the boot graph — onto `platform/net.js`
   and nothing else, never `crypto/`, `sync/` or `family/`. The shell gate is reordered (pin →
   rebuild → method → **switch**, as a conjunction with one exact-equality carve-out), which costs
   no request because everything above the switch is pure and local. D10's amendment stops being
   vacuous.
2. **The report is KEPT for 90 days**, plus manual delete. `Report` has **no `spaceId` and no
   relation to `Space`**, so *"a report can never appear on the family's board"* stays structural.
   `feedbackSink` binds to `store.putReport` in `vercel.js#buildCtx` and in `dev-server.mjs`;
   `handlers/feedback.js` is **not touched**, so `feedback.test.js` §4 passes unchanged — which is
   the check that storage did not break promise 1.
3. **The operator is a server-configured P-256 key** (`LZP_REPORTS_ADMIN_PUB`), read in
   `adapters/vercel.js` and nowhere else, so `server/core/` stays env-free. Three routes, `24 → 27`.
   A relay with no operator answers **404** — the same answer `/api/v1/nope` gets. It is **not**
   `Member.role` returning, and it is **not** a control against the platform; the wire says both.
4. **Nine pinned rows were inverted with their reasoning, and three rows that were GREEN over a
   feature they could not see were tightened** — `e10-network-scope` §2a and §2b, `network-scope`
   §5b. That is E10-1009-B a third time, predicted in the plan rather than found afterwards.
5. **The redaction boundary was asked an eleventh time**, over the two carriers this pass adds, with
   the PNG inflated and the raster grepped. Zero bytes of a Privat entry.

Driven end to end against `node server/dev-server.mjs`: solo unsigned send → **202
`proves: unsigned`**; the report in the admin view, prose verbatim, image byte-identical;
`expiresAt − receivedAt` = exactly **90 days**; a 91-day-old report swept and **404** to both list
and get; „Löschen" removes one; a family device credential → **401** on every admin route. The ⚙
dot costs **zero** requests, measured as a difference. ⚠ The LIVE relay is behind this tree and has
no operator key: `GET /api/v1/feedback` → 405, `POST` → 501.

---

## −1. The audit fix cycle (2026-09-04), in five lines

An independent five-pass audit at `2d092a6` said: *"Ship the solo product. Do not ship the
Familienkreis yet."* Its central result was that **a quit-and-open turns ops into registers, and
four things a fold reads from ops are never rebuilt** — invisible to 5,612 green rows because
every rig that co-edited never rebooted and the rig that rebooted never co-edited.

1. **The compaction class is closed** by one general statement (ADR 006's two clauses): a question
   about the PRESENT is answered from the registers by a two-row table, a question about HISTORY is
   kept out of compaction. All seven red-on-arrival rows in `tests/audit/compaction-sweep.test.js`
   turned green. **Content is not an admissibility input** — the redaction boundary is asked a
   ninth time, of the new producer specifically, in `tests/attack/e13-absorbed-boundary.test.js`.
2. **The coverage hole is closed and self-maintaining.** `e9-attack-coedit` went from 17 co-edit
   references and **0** relaunches to 32 and **10**; the acceptance driver grew 27 → **35 launches**
   with six co-edit / removal / exposure / „neu" phases; and `e13-relaunch-sweep.test.js` §4a
   re-measures the census on every run and fails if any family gesture is driven by a rig that
   never reboots.
3. **The release gate now fails on an unset origin**, in both directions, demonstrated in four tree
   states — and the row that *forbade* the correct act is gone. The invitation placeholder is
   `https://serveradresse-fehlt.invalid`: RFC 2606 §2, undelegatable, unregistrable by anyone.
4. **The Datenschutz screen is true.** Four false sentences replaced, five disclosures added, both
   languages, held to the live server enums by `tests/server/datenschutz-claims.test.js`.
5. **Five acceptance runs of five, 35 launches each, 0 phases failed, ledger 0, battery 8 of 8** —
   co-editing works on the second launch and the fifth, the badge reads `geteilt` after a relaunch,
   and the „neu" dot lights on a real board for the first time.

⚠ **One re-pricing.** The audit predicted a real relaunch would lose *more* than the rig. It loses
**less**: on the shipped `.app` the fold never reaches the absorbed state, because the app re-pulls
from the relay and the lines come back as lines. The fleet rig — which quits and reopens with **no
relay in between** — is the stricter environment. So the compaction findings were real for a Mac
that quits and opens offline or against a pruned relay, and were never reachable in the acceptance
topology. **17.5's „neu" dot is the exception**: it was wrong with and without a relaunch.

---

## 0. What the closing pass changed, in four lines

1. **R-1 is closed for every circle that exists today.** `unshare-owner (B)` was **BLOCKED 10 of
   10**; it is now **completed 10 of 10** on the shipped binary. It was three defects wearing one
   label, and the „DATA LOSS" headline on it was wrong — nothing was ever deleted. `FINDINGS.md`
   §22a.
2. **The refusal ledger is 0, in 10 consecutive runs.** It was 2 · 2 · 2 · 34 · 2.
3. **„Rückmeldung senden" is wired**, end to end, on the real relay — bound by
   `family/mount.js#bindFeedback`, a real 202 with a verified device signature, and the payload
   searched for a Privat entry before it left.
4. **The residual list is shorter and one entry is new**: `_absorbedChainOps` rebuilds only a
   GENESIS-shaped admin link, and `transferAdmin` **is** shipped, so a circle whose seat has moved
   is still exposed (R-1b). The previous issue said no circle transfers the seat. It was wrong.

---

## 1. The headline

Ten consecutive runs of `node scripts/shell-family-e2e.mjs`. Each run is **27 launches of the
shipped macOS binary** — five instances, each with its own bundle identifier, its own
`~/Library/WebKit` store, its own WebCrypto master-key item and its own scratch disk — against a
real relay (`server/dev-server.mjs`, the same `server/core/router.js` and the same 24 handlers
that would run in Frankfurt). Papa creates a Kreis, Mama, Oma and Opa join, entries cross both
ways, the admin unshares one of Mama's, a report goes to the relay, the founder leaves, a
co-signed removal rotates the epoch.

| Run | Phases failed | Founder received a joiner's entry | Crossed to | `unshare-owner (B)` | Refusal ledger |
|---|---|---|---|---|---|
| 1 | **0 of 27** | **YES** | B **and** C | **completed** | **0** |
| 2 | **0 of 27** | **YES** | B **and** C | **completed** | **0** |
| 3 | **0 of 27** | **YES** | B **and** C | **completed** | **0** |
| 4 | **0 of 27** | **YES** | B **and** C | **completed** | **0** |
| 5 | **0 of 27** | **YES** | B **and** C | **completed** | **0** |
| 6 | **0 of 27** | **YES** | B **and** C | **completed** | **0** |
| 7 | **0 of 27** | **YES** | B **and** C | **completed** | **0** |
| 8 | **0 of 27** | **YES** | B **and** C | **completed** | **0** |
| 9 | **0 of 27** | **YES** | B **and** C | **completed** | **0** |
| 10 | **0 of 27** | **YES** | B **and** C | **completed** | **0** |

80 rows per run, 800 in the battery, none red.

**Before this pass** (this file's previous issue): 26 launches, `unshare-owner (B)` **BLOCKED in
every run, 10 of 10**, and the ledger **2 · 2 · 2 · 34 · 2**. **Before *that***
(`SHELL-VERIFICATION.md` §9): the founder received a joiner's entry in **0 of 5** and the ledger
read 0 → 6 → 13 → 25 as the founder relaunched.

**The bar was „5 of 5 with the ledger flat at zero". Both halves are now met, twice over.**

The 27th launch is new: a `feedback` phase on Mama's Mac. It asserts that the shipped app — not
the test — bound the „Rückmeldung senden" sender, builds a report off the live board, searches
the wire body for the Privat entry that is on that board, and posts it over the bridge. The relay
answers **202** with `proves: „two reports carrying this same self-minted public key were signed
by the same private key"`. 10 of 10.

**And one number that decides a finding.** The driver now prints, from the stranded phase:

```
#    eligibleCosigners=0 · rosterCache=4 · alive on the relay=2
```

identically in all ten runs. `SHELL-VERIFICATION.md` §5 recorded `eligibleCosigners → 2`, which no
log state can produce with a roster present — so **F-SHELL-2 was a stale roster, not a missing
intersection**, and it does not reproduce. `FINDINGS.md` §22c.

---

## 2. Suites — measured, against the baselines

| Suite | Baseline (`78016e8`) | Now | Δ |
|---|---|---|---|
| `npm test` (tier 1) | 2216 | **2229 / 0** | +12 `cosigners.test.js`, +1 `headless-shell.test.js` |
| `test:property` | 101 | **101 / 0** | — |
| `test:attack` | 970 | **970 / 0** | — (two rows inverted, none added) |
| `test:server` | 998 | **1002 / 0** | +4 static rows; **1069 / 0 / 0 skip** with `LZP_CONTRACT_DATABASE_URL` set |
| `test:fleet` | 423 | **435 / 0** | +11 `e11-attest §5f–§5i`, +8 `e12-unshare.test.js` |
| `test:dom` | 867 pass / 3 fail (54 files) | **875 pass / 3 fail** (55 files) | +`unshare-owner.dom.js`, +§E1c |

**The three reds are the three named residuals and nothing else:** `§A4` (the 9 px ink floor — a
PO ruling), `§E1` (`findWorst` straddling the 60 fps frame) and `§E3` (the saturated poster — a
spec threshold error). The tier-2 run's own isolation guard is green: the user's real board at
`~/Library/Application Support/LangzeitPlaner` was untouched.

**A correction to this file's own previous issue.** §2 claimed `test:dom` **902 pass / 3 fail over
54 files** at `78016e8`. The `# pass` lines in that run sum to **867**; 902 is the count of
top-level `ok` lines, which double-counts a suite and its rows in the files that use `describe`.
Both numbers are quoted above from the same convention (`# pass`), so the delta is a delta.

Beyond the six suites, run in this pass:

- `node scripts/mom-test-probe.mjs` — **35 rows · 33 pass · 2 note · 0 FAIL**, exit 0. It was
  29 · 2 · 4.
- `node .github/scripts/check-server-config.mjs --deep` (with `DATABASE_URL` and
  `SHADOW_DATABASE_URL` against a live cluster) — **41 passed · 0 failed · 0 not checked.** L1 and
  L2 pass for the first time; L2 reports *no drift, the migration set reproduces `schema.prisma`
  exactly*. The shallow run is **39 · 0 · 2 stated skips**, unchanged.
- `node .github/scripts/check-deploy-window.mjs` — exit 0, and it now reads the window out of
  `server/vercel.json` rather than assuming it.
- `check-ci-triggers`, `check-email-copy`, `check-release-config`, `check-dmg-geometry` — all
  exit 0.

---

## 3. The defect that made a family not work, and what it actually was

`F-SHELL-1` was **three** defects, not two. The first two were closed by the parallel passes:

1. **`selfAttest` re-signed on every launch** (`crypto/identity.js#ensureAttestedDevice`). ECDSA
   is randomised, so an unchanged fact produced a different *string* on a write-once register.
2. **`BAD_ATTESTATION` was terminal** (`core/authz.js` stage 0a). `attestOpen`'s `null` means
   "forged" *or* "my roster is older than this claim", and both were answered the same way. The
   second is now `UNATTESTED_DEVICE` — held and re-judged — under a bound of one held claim per
   `(member, device)` register.

The third was found **in this integration**, and it is why the family still did not work:

### F-SHELL-1(b) — `store.js#_absorbedAttestOps` had never once run

A joiner's first launch fixes a checkpoint horizon at its own newest op — which is newer than
every op the founder authored when the circle was created. `_persistOps` ① then skips those lines
as "already durable in the checkpoint", so the founder's `member.set{dev.<short>}` never reaches
`ops.jsonl` and `foldAuthorized` never sees it again. `_absorbedAttestOps` was landed alongside
the other two fixes to rebuild that op from the register cell the checkpoint *did* keep.

**It was inert.** `foldAuthorized` Pass A runs `classifyOp` before any attestation condition, and
`core/ops.js:445` requires `op.gid` to be a 22-char GroupId. The reconstruction passed
`gid: null`, and for a cell with no opId it minted the id `cp_<member>_<name>`, which `ops.js:418`
also rejects. **Every reconstructed op was discarded as `{stage:'attestation', reason:'shape'}`
before it could attest anything.**

It was invisible to 5 448 green rows because **nothing exercised it** — there was no test of any
kind — and invisible in the shell run because it only bites the Mac whose checkpoint happened to
absorb the founder's op. In a kept run Mama had a `checkpoint.json` whose horizon was 5 µs after
her own first op and held Papa's `dev.AB9ADNDX5TD1C4G7` cell; Oma had no checkpoint at all. Same
relay, same run: Mama's Mac parked Papa's entry `unattestedDevice` five times until
`sync/family.js#terminal` quarantined it and released the cursor, Oma's read it without trouble.
That reads as flakiness. It was a defect.

**The fix** (`src/js/store.js`): the cell's own opId is required and is also the gid. A register
cell is `{value, stamp, author, op}` and does not retain the writing op's group, so the true gid
is unrecoverable — and it does not need to be recovered: **nothing in `foldAuthorized`,
`registers.js` or `materialize.js` reads `gid` at all.** It is the local undo stack's grouping
key, and a remote op reconstructed for a fold never enters that stack. Using the op's own id
satisfies the shape rule while staying deterministic on every Mac that holds the cell. A cell with
no usable opId is skipped rather than given an invented one.

Measured on the captured state of the Mac that failed: with a verifier installed, **0 → 10 ops
admitted**, and Papa's entry „Omas Geburtstag" appears in Mama's fold.

### F-SHELL-1(b2) — the reconstruction manufactured splices

`applyRemote` folds `[reconstructed, …lines, …wellFormed]`. `wellFormed` is not a line yet, so a
cell whose op was **in the arriving batch** looked absorbed and was rebuilt beside it — the same
opId under two different bodies, because the synthesized gid differs from the real one.
`foldAuthorized` Pass A reads that as **envelope splicing** (ADR 002 §5.1) and records an anomaly
that never happened, on ops nobody tampered with. A relay re-serves an op on every cursor reset,
so this is Tuesday, not an edge. Measured in the fleet rig before the fix: 2 reconstructions → 2
spliced ids. `_absorbedAttestOps(arriving)` now counts the arriving batch as live.

### The tests that did not exist

`tests/fleet/e11-attest.test.js` **§5, 5 rows** — §5a the property (a peer whose attestation is
only in the checkpoint is still attested, the entry crosses, the ledger stays at zero), §5b the
reconstruction's own shape (`classifyOp` must answer `admit`) plus the opId-less-cell guard, §5c
the control (nothing is rebuilt while the op is still a line; nothing at all outside a family
space), §5d the splice, §5e the characterization of F-SHELL-4.

**Mutants — six, one run each on a scratch copy, rows measured not predicted; control 25/25:**

| Mutant | Rows that died |
|---|---|
| M-E11-6 `gid: cell.op` → `gid: null` *(the code exactly as it shipped)* | §5a · §5b |
| M-E11-7 the `isOpId(cell.op)` guard removed, id/gid minted `cp_<name>` | §5b |
| M-E11-8 `_absorbedAttestOps` returns `[]` | §5a · §5b |
| M-E11-9 the still-a-line skip removed (every cell rebuilt always) | §5c |
| M-E11-10 the `arriving` batch ignored (the manufactured splice returns) | §5d |
| M-E11-11 `attestMyDevice`'s idempotence gate removed | §5e |

### A hypothesis that was built, tested, DISPROVEN and reverted

The residual ledger (§8, F-SHELL-4) is a **second, identical self-attestation**. The obvious
cause is that `family/engine.js#publishMyAttestation` reads `store.registers()` — the *authorized*
fold — at `:629`, 104 lines and one `await` before the roster read installs `attestOpen` at
`:733`. A `store.ownAttestationBlob()` accessor was built on that hypothesis, wired in, and
tested. **The hypothesis is false:** `_noteAuthzVerdict` returns the raw base register map unless
there are *withdrawals*, and `store.js#_withdrawalsOf` names `badAttestation` and `writeOnce` as
explicitly not withdrawals — so the cell is visible with or without a verifier. A mutant that
reduced the new accessor to the old lookup **killed no row**. The change was reverted rather than
shipped, and §5e is a characterization row that says so in the file.

**And the thread this section told the next reader to pull was itself wrong** — corrected here
rather than left to cost them a day. It said the failing run's first attestation *"carried `seq:
null` and never reached the relay at all"*. A line's `seq` is written once at append time; the
relay's ack rides in `checkpoint().seqs` and is re-attached by `load()`. Measured on a kept
scratch dir from a **healthy** run: the line on disk read `seq: null` and the loaded log read
`seq: 4`. **`seq` in `ops.jsonl` is evidence of nothing.**

The real cause was found and F-SHELL-4 is closed: `_persistOps` appended before it checkpointed,
so a launch that ended between the two left a bare `ops.jsonl` with no `checkpoint.json`;
`adoptable()` refuses exactly that (`no-checkpoint`) and — because `storage.js#quarantineLogAside`
has no native command — the refusal is **permanent** on a Mac. From then on that Mac writes no
history, `registers()` can never carry `member:<me> → dev.<short>`, and `publishMyAttestation`
mints a fresh op for the same device on every launch. Step ⓪b writes the header before the first
line can exist. See `FINDINGS.md` and `tests/fleet/e11-attest.test.js` §5f–§5i.

---

## 4. LZP-1007 — the incremental render

### The identity proof: it exists, and it is strong

`tests/tier2/e1-incremental.dom.js` compares `#board.outerHTML` **byte for byte** after an
incremental render against the string a from-scratch rebuild produces — plus the `<textarea>`
`value` properties, the one piece of board state `outerHTML` does not carry. A failure prints the
first differing character with 90 characters of both sides, not a 400 000-character inequality.

| Section | Cells |
|---|---|
| §I1 · every mutation kind, one step (25 kinds) | **66 / 66** |
| §I2 · eight incremental renders in a row, no full render between | **10 / 10** |
| §I3 · marks and foreign nodes on the board between renders | **6 / 6** |
| §I4 · a scratchpad holding uncommitted typing | **3 / 3** |
| §I5 · a peer change folded into a „+n" badge | **4 / 4** |

**89 cells, all green.** `invalidateBoardCache()` is the exported seam that produces the
from-scratch board, so the comparison is against the real fallback path and not a re-render.

### §E1 re-measured in isolation — the file run **alone**, five times

WebKit, the shipped `.app` binary, the 8 × 2 fixture. Family = 4 195 DOM nodes, solo = 1 975.

| Operation | solo (ms) | family (ms) | family frames of 16.7 ms |
|---|---|---|---|
| `buildBoard` | 1.1 | 4.4 – 4.7 | 0.3 |
| **`renderBoard`** | 0.9 – 1.0 | **3.3 – 3.5** | **0.2** |
| **`memberToggle`** | 1.1 | **19.4 – 20.5** | **1.2** ⛔ |
| `scroll` | 0.7 | 2.4 – 2.6 | 0.1 – 0.2 |
| `findKeystroke` | 1.5 – 1.8 | 9.5 – 9.8 | 0.6 |
| **`findWorst`** | 4.0 – 4.1 | **22.3 – 23.4** | **1.3 – 1.4** ⛔ |

The harness's own forced style+layout flush with nothing to flush is **0.3 ms solo · 1.4 ms
family**, and is included in every cell above rather than subtracted.

**Does LZP-1007 pass? The ticket does; the row does not.**

- `renderBoard` was **60.8 / 54.1 ms**. It is now **3.3 – 3.5 ms** — a 17× improvement, 0.2 of a
  frame, and byte-identical to the rebuild it replaced. That is the ticket, and it is closed.
- `§E1` as written requires **all six** cells inside one frame, and two are not:
  - **`memberToggle` at 19.4 – 20.5 ms.** Hiding one of eight members re-slices 287 of 372 day
    rows, 117 of 708 notes and 70 of 268 bar nodes — the capacity rule and the three-pass lane
    rescue. §E1b asserts the renderer touches *only* those. Decomposed: ~3.4 ms model, ~3 ms
    signatures and construction, **~13 ms of layout**, ~1.5 ms harness. Getting under a frame
    means changing what the board *shows*.
  - **`findWorst` at 22.3 – 23.4 ms.** `find.js`, untouched by this ticket, and already 19.8 /
    18.1 ms on the pre-change baseline. It is now the frame budget's floor.

**Never measured, and still not:** wall-clock frames per second. Neither harness has a visible
window (`--test` is `isHeadless` by design; the browser pane reports `document.hidden`), so rAF
is throttled in both. Every number above is main-thread work.

**⚠ THE `find` ROW OF THAT TABLE IS SUPERSEDED.** `find.js` was rewritten in the closing pass
against a phase-by-phase measurement — of 21.4 ms, 16.5 ms was one line, the first geometry read
after the marking, paying the style recalculation the marking had made necessary — and the marking
was doing roughly twice the work it needed to. Class writes per worst-case keystroke are **840 →
516**. Measured now, same rig, seven isolated runs: **`findWorst` 15.4 – 17.0 ms** (was 22.3 –
23.4) and **`findKeystroke` 5.9 – 6.5 ms** (was 9.5 – 9.8). It straddles the frame and the row was
not inverted; §8's **R-5b** carries where the last ~6 ms is and why moving it is a PO call.
`memberToggle` is unchanged.

---

## 5. The v1 oracle did not move — checked per file

Not a total. Every row of the v1 characterization suite (the 11 files added at `328c683`) was run
at **`78016e8`** in a clean `git archive` tree and in the working tree, and the ordered lists of
`ok` / `not ok` lines were compared **file by file, including nested rows**.

| File | Rows | Red | Verdict |
|---|--:|--:|---|
| `tier1/dates-holidays.test.js` | 103 | 0 | **identical** |
| `tier1/layout.test.js` | 108 | 0 | **identical** |
| `tier1/palette.test.js` | 6 | 0 | **identical** |
| `tier1/repeats-find-i18n.test.js` | 137 | 0 | **identical** |
| `tier1/storage.test.js` | 11 | 0 | **identical** |
| `tier1/store-persistence.test.js` | 139 | 0 | **identical** |
| `tier1/suite-integrity.test.js` | 11 | 0 | **identical** |
| `tier2/board-render.dom.js` | 19 | 0 | **identical** |
| `tier2/dom-rendering.dom.js` | 44 | 0 | **identical** |
| `tier2/interaction.dom.js` | 32 | 0 | **identical** |
| `tier2/shell-bridge.dom.js` | 16 | 0 | **identical** |

**626 rows (515 tier-1 + 111 tier-2). Not one changed.**

This pass edited `store.js` twice — `_absorbedChainOps()` and `withoutForeignEntries()` — and
`store-persistence.test.js` is the oracle file that exercises exactly that code. Both new
functions return before looking at anything when there is no family space (`_familySpaceId ===
null` for the first, nothing carrying `isForeign` or an `f…:` entity key for the second), which is
what keeps a v1 board out of them entirely. `shell-macos/main.swift` was edited too, and
`shell-bridge.dom.js` — the oracle file that runs inside it — is byte-identical.

---

## 6. The standing bar — the redaction boundary, an eighth round

Zero bytes of a Privat entry has now held eight rounds — and this pass moved code that is
**inside** that boundary twice, which is exactly where it could have broken.

| Suite | Rows |
|---|--:|
| `attack/e7-leak-downgrade` · `e7-leak-observer` · `e7-leak-routes` · `redaction-invariants` + `fleet/e6-attack-privat` · `e6-gate-privat` · `round10-e6-gate` + `tier1/feedback` · `headless-shell` · `no-reconstruction` · `visibility` · `network-scope` | **303 / 303**, 0 failed, 0 skipped |
| `tier2/feedback.dom.js` 20 · `tier2/datenschutz.dom.js` 19 · `tier2/unshare-owner.dom.js` 7 | **46 / 46** |
| `scripts/shell-ssrf.mjs` — the shipped `.app`, 29 hostile origins | **29 launches, 38 rows, 0 failed**, 0 requests carrying a cookie |

**Why it was at risk twice this time, not once:**

1. **The unshare path is inside the boundary.** `_absorbedChainOps` changes *who is admitted* —
   an admin's `pub.set` on somebody else's entity now lands where it used to be refused. The two
   rows that matter are in `tests/fleet/e12-unshare.test.js` §4: the same reconstruction does
   **not** let a non-admin retract, and an **empty** chain refuses everybody, including a
   non-admin. That second one is a security property of `adminAtKey`'s `null`, and the mutant
   that reads it as „whoever asked" kills three rows in each of the two new files.
2. **`withoutForeignEntries` removes another member's entry from the spine.** The direction of
   that change matters: it *stops* a foreign entry being re-authored into the viewer's own log at
   `visibility: 'privat'`, which is content flowing the wrong way across the boundary. It never
   adds anything to a projection.
3. **LZP-1009 gives a solo Mac an outbound path.** The one payload that leaves a Mac which is not
   syncing anything is now searched, in the shell, on a board that carries the needle: the phase
   seeds „Scheidungsanwältin Dr. Kübler 14:30" onto Mama's real board, renders it, and asserts
   the wire body contains neither that string, nor its surname, nor even the date it sits on —
   **before** the report is sent. 10 of 10 runs.

---

## 7. The join path, and the readiness check

**The Mom test is green.** `node scripts/mom-test-probe.mjs` reads **35 rows · 33 pass · 2 note ·
0 FAIL**, exit 0; it was 29 · 2 · 4, and all four FAILs were one thing — the shipped invitation
carried no relay address at all, so `createjoin.js#readPastedOrigin` had nothing to find (it
rejects any URL with a path, and the only URL in the mail was the Releases fallback) and
`submitJoin` dead-ended. The four files now carry a `SERVERADRESSE` / `SERVER ADDRESS` heading
with the origin **alone on its own line or cell**, unpunctuated, exactly as the probe's own §M6
rule publishes it. The two remaining `note` rows are H13 and H14 — a code one character short, and
a `U` typed for a `V` — and both are honest refusals that name the shortfall rather than guessing
which character was spurious.

**The readiness check now passes L1 and L2 for the first time.** `check-server-config.mjs --deep`,
with `DATABASE_URL` and `SHADOW_DATABASE_URL` against a live cluster: **41 passed · 0 failed · 0
not checked**, and L2 reports *no drift — the migration set reproduces `schema.prisma` exactly*.
The shallow run is unchanged at 39 · 0 · 2 stated skips, and the skips still say what they are.


**„Mail-Anbieter" is no longer a valid code.** Measured against the shipped parser in this tree:

| Paste | Before | Now |
|---|---|---|
| `Mail-Anbieter` | `MA11-ANB1-ETER`, `found:'code'` | `found:'none'` |
| `Installation` / `Applications` | `1NST-A11A-T10N` / `APP1-1CAT-10NS` | `found:'none'` |
| `Familie Weber` (circle name, wrong screen) | `FAM1-11EW-EBER` | `found:'none'` |
| `Sicherheitsmeldung`, `Systemeinstellungen`, `Serveradresse` | 12-char `'partial'`, button lit | `found:'none'` |
| `Code: Mail-Anbieter` | promoted by the label | `found:'none'` |
| `https://github.com/…` | field rewritten to `SERV-ER` | `found:'none'` |

And the honest path still works: `JDNC-5A5R-JSV6`, `JDNC 5A5R JSV6`, `JDNC5A5RJSV6` and a real
code with „Mail-Anbieter" *after* it all read as `found:'code'` with the exact code back.

**The readiness check fails on an undeployable configuration.** Demonstrated by hand — delete
`server/prisma/migrations/` and the check exits **1** with `FAIL M1` naming the remedy — and
pinned by `tests/server/deploy-readiness.test.js`, **54 rows / 37 mutants**, including M9 (a
narrowed `KeyWrap` primary key, which would reopen T5-K3), M10 (the `Op` idempotency key, story
15.3's colour uniqueness), M12 (`Bytes` degraded to `TEXT`), M13, M14, M15 (`ON DELETE CASCADE`
downgraded, which is story 20.2's purge) and M16 (reverse drift). The runbook agrees with it:
`docs/v2/RUNBOOK.md` §2.4 is closed-and-verified, §2.4.1 enumerates the failure modes as a table
and §2.4.2 carries the real-PostgreSQL numbers (10 tables, 1 enum, 64 columns, 3 uniques, 8
indexes, 6 FKs, verified against a live PostgreSQL 17.10 cluster).

---

## 8. THE RESIDUAL LIST — what a person would be shipping

Ordered by what it costs the human, not by how hard it is. **Re-issued 2026-09-03** after the
closing pass: R-1 through R-5, R-7's readiness half, R-8, R-9 and R-10 are closed and the
paragraphs that carried them are replaced by what is actually left. Nothing here is a plan; every
line is a measurement or a decision.

### R-1b · ✅ CLOSED BY RETENTION (2026-09-04) — with one narrowed residual

**The repair landed and it is the one this paragraph asked for.** `store.js#_persistOps` step ①
now keeps `space.set` chain links out of compaction — they are written to `ops.jsonl` even when the
coming checkpoint folds them, and step ④ re-appends them after the truncate. Bound: **one line per
transfer plus genesis**, because `family/adminpanel.js#transferAdmin` is a deliberate, rare, human
act, so `ops.jsonl` does not grow with the log, with time, or with a peer. Measured on the shipped
binary: every family Mac's `ops.jsonl` retains exactly **one** `space.set` line after a full
acceptance run; a solo Mac writes no such line and no checkpoint at all.

`tests/fleet/e12-unshare.test.js` §8's refusal is intact and byte-for-byte unchanged — the
reconstruction still declines to guess a transfer — and §3, §4 and §8 now impose the absorption
(`withSpaceSetAbsorbed`) rather than waiting for a persist to produce it, because retention means
it no longer does. That is the repair working, not a weakening: the rows' *precondition* evaporated,
not their claim. `tests/tier2/unshare-owner.dom.js` §3 and §4 carry the same idiom.

**THE NARROWED RESIDUAL — what retention cannot do.** Retention prevents the loss; it cannot repair
one. Two situations still reach the old state:

1. **A log already compacted by an older build** keeps R-1b for a transferred seat. (F2, F3 and F4
   *are* repaired retroactively, because those are reconstructions from registers the checkpoint
   kept.)
2. **`oplog.js#compact()` at `TAIL_COMPACT_AT` (5 000 lines)** drops the retained link from the log,
   and `bodiesObject()` then lists its fingerprint, so `load()` would answer a re-appended copy
   `duplicate`. A circle that reaches 5 000 tail lines loses a *transferred* seat again.
   `_retainedTailLines` reads `_log.lines()` precisely so it never writes bytes that cannot come
   back. **Owner: `src/js/core/oplog.js`.**

Also: step ④ truncates then re-appends. A crash between the two lands on the *old* behaviour
(genesis rebuilt, transfer lost) and can lose no content, because step ③ has already folded them.
`storage` offers append and truncate and no rewrite.

<details><summary>The paragraph this replaces, as it was written on 2026-09-03</summary>

### R-1b · A TRANSFERRED admin seat is still not rebuilt after compaction ⚠ OPEN
`store.js#_absorbedChainOps` closed R-1 for a circle whose admin seat has never moved: it rebuilds
ONE **genesis-shaped** `space.set{admin, adminPrev:null}` link (`cell.author === cell.value`, ADR
001 §4.1's own root test) out of the register cell the checkpoint kept. After `transferAdmin` the
head link carries `adminPrev: <opId>` and `act !== admin`, and `resolveChain` needs the
predecessor links to accept it — which one register cell does not retain. So a circle whose seat
has moved still loses the admin's retraction once the owner's Mac has compacted.

**The previous issue of this list said „no shipped circle transfers the seat yet". That was
wrong:** `family/adminpanel.js:654` ships `transferAdmin` and `family/leavedelete.js:1433` calls
it on the path where a founder hands the seat over before leaving.

Rebuilding it anyway with `adminPrev: null` would present a transferred seat as a genesis root —
the rootless assertion `core/ops.js#transferAdmin` refuses to mint. `tests/fleet/e12-unshare.test.js`
**§8** performs a real transfer through the shipped mutation and then asserts the reconstruction
stays **silent**, so the wrong repair cannot land quietly. **The right one:** keep `space.set`
chain links (and `member.set{dev.*}`) out of compaction in `store.js#_persistOps` — bounded at one
op per transfer and per (member, device). **Owner: `src/js/store.js#_persistOps`.**

</details>

### R-6 · §A4 and §E3 — the two reds that are not code defects
- **§A4** — the 9 px ink floor. A **PO ruling**: it may not be closed by editing `palette.js`,
  which the tier-1 oracle pins.
- **§E3** — the row asks for 75 % where **48 % is the mathematical ceiling for any ordering**. A
  spec threshold error, not a code defect. Do not silently change the number.

### R-5b · §E1 — `findWorst` straddles the 60 fps frame, and the last 6 ms is a look
`find.js` was rewritten against a measurement: of 21.4 ms, 16.5 ms was one line — the first
geometry read after the marking, paying the style recalculation the marking had made necessary.
Class writes per worst-case keystroke are **840 → 516**; `findWorst` is now **15.4–17.0 ms**
(from 22.3–23.4) and `findKeystroke` **5.9–6.5** (from 8.8–9.8). It straddles 16.7 ms: green in
most isolated runs, red in some, and **the row was not inverted**.

The remaining ~13 ms is the browser recalculating style for the ~516 board nodes whose appearance
genuinely changes when the hit set moves, and the marking is already down to the difference
between two hit sets. Measured hand-off: neutralising the three rules find writes — `app.css:948`
`.note.hit`'s `border-bottom`, `app.css:942-945` `body.finding … :not(.hit){opacity:.3}`,
`app.css:949-950` `.bar/.bar-label.hit`'s box-shadow — **together** takes the same measurement
from 14.8 to **8.6 ms**, while removing any one of them buys ~0.4 ms. That is a change to what
find looks like, in a file the tier-1 oracle pins. **A PO call, not a code fix.**

### R-7b · ✅ RETRACTED (AUDIT F12, 2026-09-04) — the join HAS crossed the real bridge
**This residual was false when it was written, and the evidence was already in the tree.**
`tests/tier2/shell-family-e2e.dom.js:303` drives the real join screen and asserts that
`POST /api/v1/invites/redeem` crossed `sync_request` with `WIRE.fetch` empty — i.e. over the shell
bridge, not over `fetch`. It passed three times in the auditor's own reproduction of the acceptance
run and five times in the fix cycle's (§-1). The four paste defects remain closed and pinned by 42
rows, and the Mom-test probe's one FAIL is `M2s`, which is red **by design** until the PO claims a
relay host.

What is still true, and is a different sentence: **no join has crossed the bridge to a REMOTE
host.** Every run so far is against `server/dev-server.mjs` on loopback — a real out-of-process
relay running the same `server/core/router.js`, but not TLS and not Frankfurt. See R-8b, and the
audit's §5 item 3: the https-only rule is proven by 28 refusals and never by one successful https
request.

<details><summary>The paragraph this replaces, as it was written on 2026-09-03</summary>

Unchanged and still true. The four paste defects are closed and pinned by 42 rows, the Mom-test
probe is green, and the e-mail now carries a relay address — but **no join has ever run over the
`sync_request` bridge**: the tier-2 relay verifies `SHA-256(proof) === verifier` over real
WebCrypto and is in-process. `SHELL-VERIFICATION.md` §10's conditional-story list is unchanged.

</details>

### R-8b · The adapter has met a local cluster, not Frankfurt's pooler ⚠ THE ONE THAT MATTERS
`server/adapters/prisma.js` now runs against a real PostgreSQL 17.10 — **66 of 66 contract cases,
1069 rows, 0 fail, 0 skip** — and four defects were found by doing it, one of which (no retry for
a `Serializable` abort) no single-process test could ever have found. But Frankfurt is Prisma
Postgres **behind the platform pooler**, and a transaction-mode pooler can refuse an interactive
`$transaction` or silently downgrade `Serializable`. Every atomicity guarantee rests on getting
one. **Run `RUNBOOK.md` §2.5.1 against the deployed database before it holds a family.**

Beside it: after 5 retries the adapter re-throws and nothing above maps `P2034`/`P2010` to a
status code, so a still-conflicting transaction becomes an undefined 500 (**R8-R2**, one line in
`server/core/router.js` + `errors.js`: answer 503 with `retryAfter`). And
`server/adapters/vercel.js` is still unexecuted (**R8-R4**).

### R-9b · Two deployment lines nobody can write from here
1. **A production `feedbackSink`.** „Rückmeldung senden" is bound in the app
   (`family/mount.js#bindFeedback`) and works end to end against `server/dev-server.mjs` — a real
   202, a verified device signature, the payload searched for a Privat entry first. But
   `server/adapters/vercel.js#buildCtx` binds no sink, so the **deployed** relay answers **501
   not_implemented** — honestly, rather than accepting a report and dropping it. It needs a
   destination, which is a PO decision.
2. **The real relay origin, substituted into the four invitation files.** They carry the literal
   `https://lzp-sync-po.vercel.app` — the project's own placeholder name, and **no such app
   exists**; a `*.vercel.app` name is claimable by anyone until the PO claims it. It is a literal
   and not a `{{…}}` placeholder because the probe's `FILL` substitutes only four keys and row
   `M2` asserts the parsed origin equals that exact string. Both are now lines in
   `RELEASE-CHECKLIST.md` §A, with the `sed`.

**And one thing that address changed, which the PO should be told rather than discover:** before
it, the e-mail alone was not enough to join — the reader had to learn the relay address elsewhere.
Now it is. That is inside the accepted model (ADR 002 §8.4 and §5's residual-risk paragraph
already say whoever reads the mail within 7 days can consume the invite and become a member, with
the member list 15.4 and epoch-rotating removal 20.2 as the controls), and „what they cannot do is
read anything from the email alone" is unchanged.

### R-10b · `storage.js#quarantineLogAside` still has no native command
`_persistOps` step ⓪b stops a Mac **manufacturing** a permanent quarantine — the F-SHELL-4 cause —
but it does not make a genuine one recoverable. `quarantine_logs` is named in the warning and
implemented in neither `src-tauri/src/lib.rs` nor `shell-macos/main.swift`. A Mac that acquires a
refused log still writes no history for ever, and `tests/fleet/e11-attest.test.js` §5i pins that
state and what it costs.

### R-11b · Two diagnostics that are still wrong, in a file nobody owned this round
`tests/tier2/shell-family-e2e.dom.js:466-471` calls `Object.keys()` on a **Map**, so
`REGKEYS`/`DEVREGS`/`MEMREGS` print `[]` unconditionally and are not evidence of an empty register
map; and line 459 reads `m.attestation` where ADR 003 §3.6 puts the blob on
`m.devices[].attestation`, so `att=` is always `false`. Neither is load-bearing and both will cost
the next reader an hour.

Also in that file: **§3 does not await the join it starts.** `waitFor(() => cj.familyCircle())`
returns after `rememberCircle`, i.e. *before* `adoptCircleIntoLog`, so the phase can exit
mid-persist. That timing is what made F-SHELL-4 reproducible; step ⓪b makes it harmless, but the
row measures less than it reads as.

### R-12 · One flake seen twice and not reproduced since
`tests/tier1/createjoin.test.js` §2d failed twice in an unmodified copy of this tree earlier in
the session — `i=18397 "join\tdein\tcode" → J01N-DE1N-C0DE` — and has passed on every run since,
including all of this pass's. Not reachable from anything edited here.

### What is NOT on this list, and why

- **`publishMyAttestation` is module-private**, so `e11-attest.test.js` §5f–§5i's `shippedGuard()`
  is a replica and the console sentence it added is prose no row pins. What *is* pinned is the
  fact it branches on (`logIsWritable()`, §5i, mutant-killed). §4c already carried the same debt.
- **`tests/attack/attack-relay-ordering.test.js` §6** is stale: its title („What is NOT settled")
  and its comment „nothing in this repository can execute it" are both false now. It asserts
  `U-SEQ`/`U-TX` are still in `UNVERIFIED_CLAIMS`, which is why that export name was kept even
  though every row now carries a `verifiedOn` witness. Renaming it is a two-file change.
- **No wall-clock fps has ever been measured.** Both harnesses are headless, so rAF is throttled.
  Every millisecond in this document is main-thread work, harness flush included, never subtracted.

---

## 9. Tickets and stories

### Every ticket

| Ticket | Epic | Pts | Title | Stories | State |
|---|---|--:|---|---|---|
| LZP-101 | E1 | 3 | Release workflow | 22.1 22.8 7.4 | built |
| LZP-102 | E1 | 5 | Auto-updater | 22.3 22.5 22.6 | built |
| LZP-103 | E1 | 3 | Update UX | 22.4 | built |
| LZP-104 | E1 | 2 | Minimum-version enforcement | 22.7 | built |
| LZP-105 | E1 | 3 | Signing & notarization | 22.2 22.6 | built |
| LZP-106 | E1 | 2 | Unsigned fallback screen | 22.2 | built |
| LZP-107 | E1 | 2 | DMG polish | 22.1 | built |
| LZP-108 | E1 | 1 | Invitation email template | 22.1 15.3 | built |
| LZP-109 | E1 | 2 | Server auto-deploy | 22.8 | built |
| LZP-1001 | E10 | 2 | Datenschutz section | 21.3 21.5 | built |
| LZP-1002 | E10 | 3 | Network scope audit | 21.5 21.4 13.4 | built |
| LZP-1003 | E10 | 5 | Crypto self-audit | 20.5 21.1 21.2 | built |
| LZP-1004 | E10 | 3 | Backup/restore tests | 11.2 11.3 | built |
| LZP-1005 | E10 | 8 | Multi-device E2E suite | 15.1 15.2 15.3 15.4 15.5 15.6 16.1 16.2 16.3 16.4 16.5 16.6 16.7 17.1 17.2 17.3 17.4 17.5 17.6 17.7 18.1 18.2 18.3 18.4 18.5 18.6 | built |
| LZP-1006 | E10 | 3 | "Mom test" beta | 22.1 22.2 15.3 | built |
| LZP-1007 | E10 | 3 | Perf pass | 17.4 | built |
| LZP-1008 | E10 | 2 | Ops runbook | — | built |
| LZP-1009 | E10 | 2 | Feedback button | 21.3 21.4 21.5 | **built** (AUDIT F12, corrected 2026-09-04: `server/core/handlers/feedback.js`, `family/mount.js#bindFeedback`, `feedback` is the 24th name in `ROUTE_NAMES`; §-1 and §1 of this file already described it as shipped) |
| LZP-201 | E2 | 3 | Schema & DB setup | — | built |
| LZP-202 | E2 | 5 | Op endpoints | 19.1 19.2 21.1 | built |
| LZP-203 | E2 | 5 | Space & invite endpoints | 15.2 15.3 15.4 15.5 15.6 | built |
| LZP-204 | E2 | 5 | Lifecycle endpoints | 20.1 20.2 20.3 20.4 | built |
| LZP-205 | E2 | 2 | Abuse basics | 21.3 21.4 | built |
| LZP-206 | E2 | 3 | Protocol versioning | 22.7 | built |
| LZP-207 | E2 | 1 | Server metadata inventory | 21.3 | built |
| LZP-301 | E3 | 5 | Crypto spike & ADR | 21.1 21.2 20.5 | built |
| LZP-302 | E3 | 3 | Device identity | 19.5 | built |
| LZP-303 | E3 | 8 | Space keys & rotation | 20.2 20.5 21.1 | built |
| LZP-304 | E3 | 5 | Op envelopes | 21.1 | built |
| LZP-305 | E3 | 5 | Backup v2 | 11.2 11.3 | built |
| LZP-306 | E3 | 8 | Device pairing protocol | 19.5 | built |
| LZP-401 | E4 | 3 | Local op-log ADR | 18.5 | built |
| LZP-402 | E4 | 8 | Storage retrofit | — | built |
| LZP-403 | E4 | 5 | v1→v2 migration | 11.6 11.5 22.7 | built |
| LZP-404 | E4 | 3 | Entry metadata | 16.2 18.2 9.1 9.3 | built |
| LZP-405 | E4 | 5 | Undo rework | 5.4 18.4 | built |
| LZP-406 | E4 | 5 | Merge property tests | 19.6 18.5 | built |
| LZP-501 | E5 | 8 | Sync engine client | 19.1 19.2 | built |
| LZP-502 | E5 | 5 | Personal space | 19.4 21.2 | built |
| LZP-503 | E5 | 3 | Pairing UX | 19.5 | built |
| LZP-504 | E5 | 2 | Sync status states | 19.3 | built |
| LZP-505 | E5 | 3 | Long-offline convergence | 19.6 8.5 | built |
| LZP-601 | E6 | 3 | Create-space flow | 15.1 15.2 20.6 | built |
| LZP-602 | E6 | 3 | Join flow | 15.3 4.5 | built |
| LZP-603 | E6 | 2 | Member list & self-edit | 15.4 15.6 | built |
| LZP-604 | E6 | 2 | Invite management | 15.5 | built |
| LZP-605 | E6 | 3 | Admin panel | 20.1 | built |
| LZP-606 | E6 | 3 | Leave flow | 20.3 8.4 | built |
| LZP-607 | E6 | 2 | Delete space | 20.4 | built |
| LZP-608 | E6 | 5 | Removal end-to-end | 20.2 20.5 | built |
| LZP-701 | E7 | 5 | Visibility end-to-end | 16.1 16.2 16.7 | built |
| LZP-702 | E7 | 3 | Three-state control | 16.3 2.4 | built |
| LZP-703 | E7 | 2 | Category default visibility | 16.4 | built |
| LZP-704 | E7 | 3 | Visibility transitions | 16.5 | built |
| LZP-705 | E7 | 2 | Exposure badges | 16.6 | built |
| LZP-706 | E7 | 3 | Belegt rendering | 16.7 | built |
| LZP-801 | E8 | 5 | Foreign-entry rendering | 17.1 17.2 | built |
| LZP-802 | E8 | 3 | Two-section legend | 17.3 4.3 | built |
| LZP-803 | E8 | 3 | Density integration | 17.4 2.4 2.5 3.8 | built |
| LZP-804 | E8 | 3 | "Neu" markers | 17.5 | built |
| LZP-805 | E8 | 2 | Attribution | 17.6 2.4 | built |
| LZP-806 | E8 | 2 | Family find | 14.1 | built |
| LZP-807 | E8 | 1 | Family print parity | 12.3 | built |
| LZP-808 | E8 | 3 | Komfort density | 17.7 | built |
| LZP-901 | E9 | 3 | Owner-only enforcement | 18.1 | built |
| LZP-902 | E9 | 3 | Co-edit flag | 18.2 | built |
| LZP-903 | E9 | 2 | Admin unshare | 18.3 | built |
| LZP-904 | E9 | 5 | Conflict resolution | 18.5 | built |
| LZP-905 | E9 | 3 | Deletes & restore | 18.6 | built |

**68 of 69 tickets built · 239 points.**


### v2 stories (F15–F22, 51)

| Story | F | Priority | Tickets | Text |
|---|---|---|---|---|
| 15.1 | F15 | Must | LZP-601 LZP-1005 | By default I'm in solo mode and nothing has changed from v1 — no account, no network activity, no prompts; the family features exist only behind an… |
| 15.2 | F15 | Must | LZP-601 LZP-203 LZP-1005 | I create a Familienkreis with a name ("Familie Weber"), automatically become its admin, and receive a shareable invite code/link, so setup is one s… |
| 15.3 | F15 | Must | LZP-602 LZP-203 LZP-108 LZP-1006 LZP-1005 | Mom joins by pasting the invite code into her app and choosing a display name and a personal color — no email, no password, no registration form — … |
| 15.4 | F15 | Must | LZP-603 LZP-203 LZP-1005 | All members see the member list (name, color, initial), so everyone knows who's in the circle. |
| 15.5 | F15 | Must | LZP-604 LZP-203 LZP-1005 | Invite codes are single-use, expire after 7 days, and are revocable by the admin, so a leaked link can't haunt the family. |
| 15.6 | F15 | Must | LZP-603 LZP-203 LZP-1005 | I can change my display name and color anytime and it propagates to everyone's boards, so identity stays current without admin involvement. |
| 16.1 | F16 | Must | LZP-701 LZP-1005 | Everything I create is private by default — joining a family changes nothing about existing or new entries until I explicitly share them — so overs… |
| 16.2 | F16 | Must | LZP-701 LZP-404 LZP-1005 | Every note and bar has one of three visibility levels: Privat (only me), Belegt (others see that the day/range is taken, and by whom, but no text),… |
| 16.3 | F16 | Must | LZP-702 LZP-1005 | I change an entry's visibility with a three-state control in its selected state and popover, two clicks maximum, so privacy management never feels … |
| 16.4 | F16 | Must | LZP-703 LZP-1005 | A personal category can set a default visibility for new entries in it (e.g., category "Familie" ⇒ Geteilt), so routine sharing costs zero extra cl… |
| 16.5 | F16 | Must | LZP-704 LZP-1005 | I can change visibility at any time; a downgrade removes the entry (or its details) from other members' boards at the next sync, so nothing shared … |
| 16.6 | F16 | Must | LZP-705 LZP-1005 | My shared and busy entries carry a small badge on my own board, so I always see my exposure at a glance and never have to wonder what Mom can see. |
| 16.7 | F16 | Must | LZP-701 LZP-706 LZP-1005 | A Belegt entry appears on others' boards as a neutral block with my color/initial and the word "Belegt" — duration and owner are deliberately visib… |
| 17.1 | F17 | Must | LZP-801 LZP-1005 | Shared and Belegt entries from other members appear on my board automatically in their date rows, so family plans live exactly where my plans live. |
| 17.2 | F17 | Must | LZP-801 LZP-1005 | Color logic: my entries always render in my category colors (my board stays mine); others' entries render in the member's personal color with an in… |
| 17.3 | F17 | Must | LZP-802 LZP-1005 | The legend gains a member section: each member with color and a visibility toggle, so I can hide Papa's entries the same way I hide a category (4.3). |
| 17.4 | F17 | Must | LZP-803 LZP-1007 LZP-1005 | Family entries obey all v1 density rules — lanes cap (3.8), "+n" overflow (2.4), truncation (2.5) — so a busy family can never break the board's le… |
| 17.5 | F17 | Must | LZP-804 LZP-1005 | Entries added or changed by others since my last session carry a quiet "neu" dot that fades once I've seen them — no popups, no counters, no push —… |
| 17.6 | F17 | Must | LZP-805 LZP-1005 | Hover/popover shows attribution: "von Mama · geteilt · geändert So.", so provenance is one glance away but never printed on the board. |
| 17.7 | F17 | Could | LZP-808 LZP-1005 | A per-device density setting (Kompakt / Komfort) slightly increases row height and font size on that machine only — Mom's display and eyes are not … |
| 18.1 | F18 | Must | LZP-901 LZP-1005 | By default only the owner can edit or delete an entry; other members view — so nobody's plans can be rewritten behind their back. |
| 18.2 | F18 | Must | LZP-902 LZP-404 LZP-1005 | An entry-level flag "Familie darf bearbeiten" opts one entry into co-editing (the family vacation bar both of us drag around), so collaboration exi… |
| 18.3 | F18 | Must | LZP-903 LZP-1005 | As admin I can unshare any entry from the family space — it reverts to owner-private, it is never deleted — so moderation is possible but non-destr… |
| 18.4 | F18 | Must | LZP-405 LZP-1005 | My ⌘Z undoes only my own actions; other members' changes never appear in my undo stack, so undo stays predictable in a shared world. |
| 18.5 | F18 | Must | LZP-904 LZP-406 LZP-401 LZP-1005 | If two people edit the same co-editable entry near-simultaneously, the later change wins per field, attribution updates (17.6), and only the person… |
| 18.6 | F18 | Must | LZP-905 LZP-1005 | Deletions propagate to all boards; my undo of my own deletion restores the entry as a new shared operation, so even destructive acts stay reversibl… |
| 19.1 | F19 | Must | LZP-501 LZP-202 | The app is fully functional offline — create, edit, move, everything — and queues changes locally; sync happens when connectivity returns, so a tra… |
| 19.2 | F19 | Must | LZP-501 LZP-202 | (amended v2.1) My changes upload within seconds of saving; others' changes arrive automatically — on app focus and every ~30–60 s while the app is … |
| 19.3 | F19 | Must | LZP-504 | Sync status is silent when healthy; only pending-offline or a real error produces a small, unobtrusive indicator — v1's "silence is the design" (F1… |
| 19.4 | F19 | Must | LZP-502 | I can pair my own second Mac (desktop + laptop): my entire board — including private entries — syncs end-to-end encrypted between my devices only, … |
| 19.5 | F19 | Must | LZP-306 LZP-503 LZP-302 | Adding a device means entering a short pairing code shown on an existing device (key transfer), not a password-reset flow — there are no passwords … |
| 19.6 | F19 | Must | LZP-505 LZP-406 | After long offline periods everything merges cleanly on return — including month rolls and yearly repeats that occurred meanwhile — so a laptop ope… |
| 20.1 | F20 | Must | LZP-605 LZP-204 | As admin I can invite, revoke invites, remove members, rename the space, and transfer the admin role to another member, so the circle stays maintai… |
| 20.2 | F20 | Must | LZP-608 LZP-303 LZP-204 | Removing a member deletes their shared/Belegt entries from all family boards and their access — their private data on their own machine is untouche… |
| 20.3 | F20 | Must | LZP-606 LZP-204 | Leaving voluntarily has the same effect, self-initiated; other members' shared entries disappear from my board, my own entries all revert to privat… |
| 20.4 | F20 | Must | LZP-607 LZP-204 | As admin I can delete the entire Familienkreis: server data is purged, every member reverts to a fully intact solo board. |
| 20.5 | F20 | Must | LZP-303 LZP-1003 LZP-301 LZP-608 | Even as admin, I structurally cannot see other members' private entries or the contents of their Belegt entries — the admin role grants space manag… |
| 20.6 | F20 | Must | LZP-601 | In v2, each user belongs to at most one Familienkreis, so the mental model stays as simple as the family it serves. |
| 21.1 | F21 | Must | LZP-303 LZP-304 LZP-202 LZP-301 LZP-1003 | Shared and Belegt entries are end-to-end encrypted; only member devices hold keys — the server stores and relays ciphertext it cannot read. |
| 21.2 | F21 | Must | LZP-502 LZP-301 LZP-1003 | Private entries never leave my machines except end-to-end encrypted to my own paired devices (19.4) — no family key can ever decrypt them. |
| 21.3 | F21 | Must | LZP-207 LZP-1001 LZP-205 | (amended v2.1) The app documents plainly what the server side can see — pseudonymous IDs, timestamps, IP addresses in transit, encrypted blob sizes… |
| 21.4 | F21 | Must | LZP-205 LZP-1002 | Still no analytics, no tracking, no third-party services beyond the sync endpoint. |
| 21.5 | F21 | Must | LZP-1002 LZP-1001 | Network scope, replacing 13.4: in solo mode the app makes zero network requests; with a Familienkreis it talks to exactly one sync endpoint and not… |
| 22.1 | F22 | Must | LZP-101 LZP-107 LZP-108 LZP-1006 | The app ships as a single DMG (≈15 MB, comfortably under mail attachment limits); installing is open → drag to Programme → launch, so Mom's entire … |
| 22.2 | F22 | Must | LZP-105 LZP-106 LZP-1006 | First launch handles macOS quarantine gracefully: a signed and notarized build simply opens; in the unsigned fallback, a first-run screen walks thr… |
| 22.3 | F22 | Must | LZP-102 | The app checks for updates on launch and roughly daily, downloads quietly in the background, and applies on the next start — after the first email,… |
| 22.4 | F22 | Must | LZP-103 | An available update announces itself only as a quiet "Update verfügbar" hint (app menu and settings), never a modal; one click restarts into the ne… |
| 22.5 | F22 | Must | LZP-102 | Every device — my two Macs and Mom's — follows the same single release channel: when I publish a version, the whole family converges on it automati… |
| 22.6 | F22 | Must | LZP-102 LZP-105 | Updates are cryptographically signed with the app's updater key and verified before installing, so an email-distributed app cannot grow a hijackabl… |
| 22.7 | F22 | Must | LZP-104 LZP-403 LZP-206 | Updates never touch user data; schema migrations (11.6) run after the swap. If a server protocol change ever requires a minimum client version, the… |
| 22.8 | F22 | Must | LZP-101 LZP-109 | Releases flow from GitHub: tagging a version triggers the build (GitHub Actions) and publishes DMG + update manifest to GitHub Releases, while the … |

### v1 stories (F1–F14, 79) — the characterization oracle

| Story | T1 | T2 | What the suite pins |
|---|:-:|:-:|---|
| 1.1 twelve columns, current month first | ✅ | ✅ | `buildBoard` window + 12 `.col` in the DOM |
| 1.2 slim day rows, weekday, weekends shaded | ✅ | ✅ | `.we` exactly on Sat/Sun, 104 weekend days in 2026 |
| 1.3 rolling ↔ pinned start month | ✅ | ✅ | rolling ignores `startMonth`; pinned ignores the wall clock |
| 1.4 horizontal scroll, headers pinned | — | ✅ | CSS-only; no model input. `position:sticky`, `overflow-x`, `max-content` |
| 1.5 page year back / forward in pinned mode | ✅ | ✅ | `pageYears ±N`; paged-back window renders past entries |
| 1.6 rows align by day number | ✅ | ✅ | slot *i* is always day *i+1*; void rows only at the bottom |
| 2.1 click, type, Enter saves / Escape cancels | — | ✅ | real click + keystrokes; Escape leaves nothing behind |
| 2.2 edit in place, clear to delete | — | ✅ | dblclick edits the *same object*; clearing deletes; both undoable |
| 2.3 several notes per day | ✅ | ✅ | store order preserved; truncation, not wrapping |
| 2.4 crowded day shows `+n` | ✅ | ✅ | shows `capacity` notes, not literally two — see *Discrepancies* |
| 2.5 ~80-char cap, ellipsis, full text on hover | ✅ | ✅ | `maxLength = 80` asserted live; model carries the string verbatim |
| 3.1 press-and-drag lays a bar | ✅ | ✅ | incl. the degenerate single-day click-drag |
| 3.2 month split stays ONE entry | ✅ | ✅ | segment `.bar` object identity asserted across columns |
| 3.3 short label on the bar | ✅ | ✅ | label editor opens synchronously on create |
| 3.4 overlaps render in parallel lanes | ✅ | — | global first-fit; inclusive overlap; input-order independence |
| 3.5 dragging upward normalises | ✅ | ✅ | real upward drag produces a valid range |
| 3.6 "continues →" cue, both directions | ✅ | ✅ | strict edges; `.bar-cont-up` / `.bar-cont-down` / column footer |
| 3.7 label once per month segment | ✅ | ✅ | label row skips notes, holiday text and an existing `+n` |
| 3.8 lanes cap at 3, then `+n` | ✅ | ✅ | incl. the per-day lane rescue (DESIGN-DECISIONS challenge 3) |
| 4.1 legend: rename, recolor, add, remove | ✅ | ✅ | add takes the next free tone; the final category cannot be deleted |
| 4.2 every entry has a category, defaults to last used | ✅ | ✅ | `lastCategoryId` never dangles |
| 4.3 toggle category visibility | ✅ | ✅ | hidden ≠ absent in the store; absent from the DOM |
| 4.4 deleting a category prompts to reassign | ✅ | ⚠️ | counts + reassign-then-delete mutation covered; the sheet's dropdown flow is not driven |
| 4.5 fixed ~10-tone palette | ✅ | — | `tests/tier1/palette.test.js`: the whole table pinned |
| 4.6 creating into a hidden category auto-unhides | ✅ | ✅ | incl. the undo asymmetry (the unhide rolls back, the setting does not) |
| 5.1 drag a note to another day | — | ✅ | incl. the 9.3 rule: a repeat re-anchors month/day, keeps its year |
| 5.2 drag a bar whole | — | ✅ | length preserved, both ends move, label survives |
| 5.3 grab an edge to stretch/shrink | — | ✅ | **both** grips — the start grip has its own test |
| 5.4 ⌘Z / ⇧⌘Z, ~50 steps | ✅ | ✅ | 60 edits → exactly 50 undos; import excluded |
| 5.5 click selects; 4 px drag threshold | — | ✅ | a 2 px press selects and does **not** move the note |
| 5.6 auto-scroll when dragging near the edge | ❌ | ❌ | **not automatable** — needs a viewport narrower than the board; the headless window renders all 12 columns, so the edge condition never arises |
| 6.1 holidays inline, distinct style | ✅ | ✅ | short form, full name on hover, bold day number |
| 6.2 Bundesland picker drives regional days | ✅ | — | all 7 regional holidays × all 16 states |
| 6.3 baked in, works offline | ✅ | ✅ | pure computation (T1) + CSP blocks a real `fetch` (T2) |
| 6.4 layer toggles off | ✅ | ✅ | empties the layer without moving a single row |
| 6.5 computed from rules, never runs out | ✅ | ✅ | Easter cross-checked against an independent Gauss algorithm, 1900–2200; Buß- und Bettag 1900–2400 |
| 6.6 other Bundesländer dimmed | ✅ | ✅ | the union is always returned; only `own` varies |
| 7.1 subtle background shading | ✅ | ✅ | inclusive at both ends; a holiday inside Ferien keeps both signals |
| 7.2 hover names the period | ✅ | ✅ | day-by-day lookup across whole periods |
| 7.3 toggles independently of Feiertage | ✅ | ✅ | all four on/off combinations |
| 7.4 visible data horizon | ✅ | — | `FERIEN_META` pinned field-by-field; see *Discrepancies* (FINDING 2) |
| 7.5 no Bundesland → layer stays off | ✅ | ✅ | shades nothing even when switched on |
| 8.1 today unmistakably highlighted | ✅ | ✅ | incl. Today beating weekend + Ferien shading (the `.day.day.today` fix) |
| 8.2 board advances by itself at month change | ⚠️ | ❌ | the *model* is covered — `buildBoard` with an injected `today` yields the rolled window. The **live** self-advance is not automatable: it needs the wall clock to cross a month boundary |
| 8.3 "Today" button jumps back | — | ✅ | resets `pageYears` in pinned mode; a no-op for state in rolling mode |
| 8.4 rolled-out entries kept in storage | ✅ | — | paging back renders them again; nothing is deleted |
| 8.5 date change while running (midnight, wake) | ❌ | ❌ | **not automatable** — needs a real clock change or a real sleep/wake cycle |
| 8.6 roll animation, respects Reduce Motion | ❌ | ❌ | **not automatable** — a ~300 ms visual transition and a macOS accessibility setting; needs a human eye |
| 9.1 repeats yearly, survives the roll | ✅ | ✅ | decades-old anchors; multiple coexisting series |
| 9.2 ↻ marker | ✅ | ✅ | rendered **before** the text so truncation cannot eat it |
| 9.3 edit/delete applies to the whole series | ✅ | ✅ | every occurrence is the same stored object (`===`) |
| 9.4 Feb-29 shows on Feb-28 in non-leap years | ✅ | — | century rule included; the anchor is never rewritten |
| 9.5 series exists from its first year onward | ✅ | — | paging back before the anchor shows nothing |
| 9.6 repeats are notes-only | ✅ | — | a bar carrying the flag is never projected |
| 10.1 free-text area per month column | — | ✅ | one textarea per column, keyed by month |
| 10.2 persists and autosaves | ✅ | ✅ | reaches the store and survives a redraw |
| 10.3 drag a pad line onto a day | n/a | n/a | **not implemented in v1** — a `[Could]` story; no drag source exists in `src/`. Nothing to characterize |
| 10.4 pads belong to a specific month | ✅ | ✅ | keyed `YYYY-MM`, so Aug '26 and Aug '27 are different pads |
| 10.5 ~5 lines then scrolls; print skips empty pads | — | ⚠️ | the print half is covered (empty pads `visibility:hidden`); the 5-line scroll cap is a CSS `max-height` and is not asserted |
| 11.1 saved within ~a second, no save button | ✅ | — | the real 700 ms debounce, no fake timers; rapid edits coalesce |
| 11.2 one-click export of the entire state | ✅ | ⚠️ | the JSON document is covered lossless-round-trip; the native `NSSavePanel` is **not automatable** (a modal panel hangs a headless run) |
| 11.3 import restores after confirmation | ✅ | ⚠️ | `replaceAll` covered incl. clearing undo/redo; the native `NSOpenPanel` and the confirm sheet are not driven |
| 11.4 one human-readable JSON, written atomically | ✅ | ⚠️ | the single pretty-printed document and its location are covered. The **atomicity itself** (temp file + `replaceItemAt`, `main.swift:85`) is not — proving it needs an interrupted write |
| 11.5 last 7 daily snapshots, one-click restore | ✅ | — | cap of 7, oldest dropped, restore deep-clones and migrates |
| 11.6 schema version + migration | ✅ | — | v0→v1, dangling refs repaired, unknown keys, idempotence |
| 11.7 dated default export filename | ✅ | — | `LangzeitPlaner-${todayISO()}.json` |
| 12.1 clean A4/A3 landscape print view | — | ✅ | `@page` follows the paper setting; A4 metrics fit the 1062 × 733 content box |
| 12.2 hides UI, keeps entry colours | — | ✅ | incl. the documented exception: the `+n` badge stays, because the count is content |
| 12.3 respects layer and category toggles | — | ✅ | Today suppressed; find dimming dropped; hidden categories absent from board and key |
| 12.4 goes through the macOS print dialog | ❌ | ❌ | **not automatable** — `NSPrintOperation` is a modal native dialog and would hang a headless run |
| 13.1 remembers size, position, scroll | ❌ | ❌ | **not automatable** — native window frame restoration; the headless window is never shown or moved |
| 13.2 menu-bar icon | ❌ | ❌ | **not automatable** — a real `NSStatusItem` in the system menu bar |
| 13.3 launch-at-login toggle | ❌ | ❌ | **not automatable** — `SMAppService` mutates real system state; deliberately never exercised |
| 13.4 zero network requests | — | ✅ | CSP asserted **and** a real off-origin `fetch` is blocked, not merely discouraged |
| 13.5 ⌘W hides, ⌘Q quits | ❌ | ❌ | **not automatable** — native window/app lifecycle |
| 13.6 every core action has a shortcut | — | ⚠️ | the menu event channel is covered (`layer-feiertage`, `mode-toggle`, unknown ids). The full keymap in spec §9 is not enumerated |
| 13.7 German default, English toggle | ✅ | ✅ | ~70 keys, weekday/month tables, holiday names, Bundesland names |
| 14.1 ⌘F, matches light up, Enter steps, Esc restores | — | ✅ | dimming, `.hit`/`.current`, the n/m counter, Enter + ⇧Enter **with wraparound**, Esc |
| 14.2 search covers rolled-out history | ✅ | — | store-wide, independent of the visible window, ordered by date |

---

## 10. How to reproduce every number in this file

```bash
npm test                    # 2229 / 0
npm run test:property       #  101 / 0
npm run test:attack         #  970 / 0
npm run test:server         # 1003 tests, 1002 pass, 0 fail, 1 stated skip
npm run test:fleet          #  435 / 0
npm run test:dom            #  875 pass / 3 fail, 55 files

# the server suite against a REAL PostgreSQL — 66 of 66 contract cases
cd server && npm ci && DATABASE_URL="postgresql://…/lzp_contract" npx prisma migrate deploy \
  && DATABASE_URL="postgresql://…/lzp_contract" npx prisma generate && cd ..
LZP_CONTRACT_DATABASE_URL="postgresql://…/lzp_contract?connection_limit=1" npm run test:server
#   → 1069 tests, 1069 pass, 0 fail, 0 skip

# THE ACCEPTANCE RUN — 27 launches of the shipped binary, ~4 min each. Run it ten times.
for i in $(seq 1 10); do node scripts/shell-family-e2e.mjs --port $((8850+i)); done
#   → "0 phase(s) failed", "unshare-owner (B) — completed",
#     "THE REFUSAL LEDGER: 0", "THE FOUNDER RECEIVED A JOINER'S ENTRY: YES"
#     and, from the stranded phase, "eligibleCosigners=0 · rosterCache=4"

# §E1 in isolation — run the file ALONE or the numbers are contention
./tests/run-dom-tests.sh tests/tier2/e8-density-perf.dom.js

# the identity proof
./tests/run-dom-tests.sh tests/tier2/e1-incremental.dom.js

# the redaction boundary, and the shell's SSRF refusal
node --test --import ./tests/helpers/dev-flag.mjs \
  tests/attack/e7-leak-*.test.js tests/attack/redaction-invariants.test.js \
  tests/fleet/e6-attack-privat.test.js tests/fleet/e6-gate-privat.test.js
node scripts/shell-ssrf.mjs

# deployability, the deploy window, and the Mom test
node .github/scripts/check-server-config.mjs
DATABASE_URL=… SHADOW_DATABASE_URL=… node .github/scripts/check-server-config.mjs --deep
node .github/scripts/check-deploy-window.mjs
node scripts/mom-test-probe.mjs          # 35 rows · 33 pass · 2 note · 0 FAIL, exit 0
```

**The v1 oracle, per file** — a total is not evidence:

```bash
git archive 78016e8 | tar -x -C /tmp/base
for f in dates-holidays layout palette repeats-find-i18n storage store-persistence suite-integrity; do
  diff <(cd /tmp/base && node --test --import ./tests/helpers/dev-flag.mjs "tests/tier1/$f.test.js" \
          | grep -E '^[[:space:]]*(not )?ok [0-9]+ - ' | sed 's/ # [0-9.]*ms$//') \
       <(node --test --import ./tests/helpers/dev-flag.mjs "tests/tier1/$f.test.js" \
          | grep -E '^[[:space:]]*(not )?ok [0-9]+ - ' | sed 's/ # [0-9.]*ms$//') \
    && echo "IDENTICAL $f"
done
# the tier-2 half needs a shell build in each tree:
(cd /tmp/base && ./tests/run-dom-tests.sh tests/tier2/board-render.dom.js \
   tests/tier2/dom-rendering.dom.js tests/tier2/interaction.dom.js tests/tier2/shell-bridge.dom.js)
```

**Counting convention.** Every suite number above is the sum of the runner's own `# pass` /
`# fail` lines. Counting top-level `ok` lines instead gives a larger `test:dom` number (902 at
`78016e8`, where `# pass` sums to 867), because a `describe` suite and its rows are both `ok`
lines. This file's previous issue quoted 902 against baselines gathered the other way.

---

## 11. The one-line verdict

**A stranger can get from an e-mail to a shared family board, and nobody loses anything on the
way** — 10 of 10 runs of the shipped binary, 27 launches each, every phase, the admin's „→ Privat"
landing on the owner's Mac with her text intact, and a refusal ledger of **0**.

What is left is not a defect anybody has reproduced. It is: one circle shape nobody has built yet
(an admin seat that has been handed over, R-1b), a database this code has met on a laptop and not
in Frankfurt (R-8b), a millisecond that is a decision about what find looks like (R-5b), and two
lines only the PO can write — where feedback reports go, and what the relay is actually called.
