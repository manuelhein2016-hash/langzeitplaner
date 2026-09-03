# LangzeitPlaner v2 — the final integration record

**Date:** 2026-09-03 · **Tree:** `v1-characterization-suite`, integrating four parallel fix passes
(`fix:attestation`, `fix:render-1007`, `fix:loose-ends`, `fix:readiness`) on top of `6268cbe`.

This file answers one question the project had never answered with a yes:

> **Does a family work, in the app we ship, repeatedly?**

**Yes — 5 of 5.** The refusal ledger is not flat, and §8 says exactly why and what is left.

---

## 1. The headline

Five consecutive runs of `node scripts/shell-family-e2e.mjs`. Each run is **26 launches of the
shipped macOS binary** — five instances, each with its own bundle identifier, its own
`~/Library/WebKit` store, its own WebCrypto master-key item and its own scratch disk — against a
real relay (`server/dev-server.mjs`, the same `server/core/router.js` and the same 23 handlers
that would run in Frankfurt). Papa creates a Kreis, Mama, Oma and Opa join, entries cross both
ways, the founder leaves, a co-signed removal rotates the epoch.

| Run | Phases failed | Founder received a joiner's entry | The Geteilt entry crossed to | Refusal ledger |
|---|---|---|---|---|
| 1 | **0 of 26** | **YES** | B **and** C | 2 |
| 2 | **0 of 26** | **YES** | B **and** C | 2 |
| 3 | **0 of 26** | **YES** | B **and** C | 2 |
| 4 | **0 of 26** | **YES** | B **and** C | 34 |
| 5 | **0 of 26** | **YES** | B **and** C | 2 |

**Before this pass** (`docs/v2/SHELL-VERIFICATION.md` §9): the founder received a joiner's entry
in **0 of 5**, the Geteilt entry crossed in 4 of 5 *to one peer*, and the ledger read
**0 → 6 → 13 → 25** as the founder relaunched.

**The bar was "5 of 5 with the ledger flat at zero". The first half is met outright. The second
is not**, and §8's F-SHELL-3 and F-SHELL-4 are the whole of the difference — neither is an
attestation defect and neither blocks a single phase. See §3.

---

## 2. Suites — measured, against the baselines

| Suite | Baseline (`6268cbe`) | Now | Δ |
|---|---|---|---|
| `npm test` (tier 1) | 2185 | **2216 / 0** | +31 `createjoin.test.js` |
| `test:property` | 101 | **101 / 0** | — |
| `test:attack` | 970 | **970 / 0** | — |
| `test:server` | 944 | **998 / 0** | +54 `deploy-readiness.test.js` |
| `test:fleet` | 398 | **423 / 0** | +20 `e11-attest §1–§4`, +5 `§5` |
| `test:dom` (54 files) | 850 pass / 3 fail | **902 pass / 3 fail** | +52 |

**5 610 green rows, 3 red.** The three reds are the three named residuals and nothing else:
`§A4` (the 9 px ink floor — a PO ruling), `§E1` (the 60 fps frame) and `§E3` (the saturated
poster — a spec threshold error). The tier-2 run's own isolation guard is green: the user's real
board at `~/Library/Application Support/LangzeitPlaner` was untouched by all 54 files.

Beyond the six suites, run in this pass:

- `node scripts/shell-ssrf.mjs` — **29 launches of the shipped `.app`, 38 rows, 0 failed**,
  0 requests carrying a cookie.
- `node .github/scripts/check-server-config.mjs` — **39 passed · 0 failed · 2 stated skips.**
- `node scripts/mom-test-probe.mjs` — **35 rows · 29 pass · 2 note · 4 FAIL** (§8, R-7).

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

---

## 5. The v1 oracle did not move — checked per file

Not a total. Every row of the v1 characterization suite (the 11 files added at `328c683`) was run
at `6268cbe` in a clean `git archive` tree and in the working tree, and the ordered lists of
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

**626 rows. Not one changed.** The tier-2 half was re-checked from the full 54-file run after
`store.js` changed, and `store-persistence.test.js` — the oracle file that exercises the code
this pass edited — was re-run after every edit. `_absorbedAttestOps` returns `[]` before looking
at anything when there is no family space, which is what keeps a v1 board out of it entirely.

---

## 6. The standing bar — the redaction boundary, a seventh round

Zero bytes of a Privat entry has now held seven rounds.

| Suite | Rows |
|---|--:|
| `attack/e7-leak-downgrade` · `e7-leak-observer` · `e7-leak-routes` · `redaction-invariants` | — |
| `fleet/e6-attack-privat` · `e6-gate-privat` · `round10-e6-gate` | — |
| `tier1/feedback` · `headless-shell` · `no-reconstruction` · `visibility` · `network-scope` | — |
| **combined** | **302 / 302, 0 failed, 0 skipped** |
| `tier2/feedback.dom.js` + `tier2/shell-family-e2e.dom.js` | **37 / 37** |
| `scripts/shell-ssrf.mjs` — the shipped `.app`, 29 hostile origins | **38 / 38**, 0 cookies |

An attestation change moves *who is admitted*, which is exactly where this could break. It did
not.

---

## 7. The join path, and the readiness check

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

Ordered by what it costs the human, not by how hard it is.

### R-1 · F-SHELL-3 — the owner loses her own entry on „→ Privat" ⛔ DATA LOSS
`unshare-owner (B)` is **BLOCKED in every run, before and after this pass** — 10 of 10 measured.
The admin takes a shared entry out of the circle; on the *owner's* Mac it arrives as a **deletion**
instead of a reversion to Privat, and her entry is gone. Tier-2 row §10. The single `notOwner` in
the residual refusal ledger is this op, refused on her Mac and then remembered by L-1 on every
later launch — which is the whole of the "2" in four of five acceptance runs.
**Owner: `src/js/family/sharing.js`, the unshare path.** This is the one residual that loses data.

### R-2 · F-SHELL-4 — a second, identical self-attestation, and a permanent refusal ⚠ NEW, OPEN
Measured in the shipped app: Mama published her own device attestation **twice**, in two
consecutive launches, for a register ADR 001 §4.0 makes write-once — same device, same 545-byte
blob, 3.8 s apart (`KHtu…` during her join, `luxB…` on her next launch). Both are admissible on
their face, so §4.0 does what it must: every Mac keeps the minimal claim under `≺` and refuses the
other `writeOnce`, **terminally**. The circle then splits on the record — Mama's log names `KHtu…`
as the writer of her register, Papa's, Oma's and Opa's name `luxB…`.

**Nothing breaks.** The two blobs are byte-identical, the device stays attested either way, and
all 26 phases pass. What remains is a permanent, misleading refusal on every peer, on every
launch. It is the whole of the difference between the measured ledger and zero: 2 · 2 · 2 · **34**
· 2 over five runs.

**The cause is not yet named.** The `store.registers()` hypothesis was tested and disproven (§3).
The thread to pull next: in the failing run Mama's `KHtu…` carried `seq: null` and **never
reached the relay at all**, and her final `ops.jsonl` held only two of her own ops. Characterized
by `e11-attest.test.js` §5e, which pins the guard so the next owner starts from a tested one.
**Owner: `src/js/family/engine.js#publishMyAttestation` + `store.js#_persistOps`.**

### R-3 · The Mom test is blocked by a missing line in an e-mail ⛔ SHE CANNOT JOIN
`node scripts/mom-test-probe.mjs` reads **35 rows · 29 pass · 2 note · 4 FAIL**, and all four
FAILs are one thing: **the shipped invitation carries no relay address at all.** Its only URL is
the Releases fallback. The parser now correctly refuses to scavenge it (R-7 below) and
`pasteOriginSentence` says so truthfully — but `submitJoin` dead-ends and she cannot join.
The fix is a `Server: <origin>` line in `docs/v2/email/invitation.{de,en}.{txt,html}`; the probe's
§M6 already publishes the rule for how to write it (own line, or `<angle brackets>`, never ending
a German sentence). **Owner: LZP-108.** The probe goes green the moment that line lands.

*(Deliberate baseline change, do not revert: H13 „one character too many" moved `ok` → `note`. It
was green only by truncating 13 characters to 12 — a guess about which one was spurious. It is now
an honest refusal naming the line to copy, at zero relay round trips.)*

### R-4 · F-SHELL-2 — a founder-less circle offers a removed member as a co-signer
`eligibleCosigners` reads the folded member list and returned **2** in a two-member circle where
one had been removed. The assigned fix (publishing `member.set{me}{_alive:false}` before
`port.leaveSpace()`) was **refuted by measurement**: `server/core/handlers/lifecycle.js:229`
deletes every op authored by the leaver's devices in the same transaction, so that op is doomed —
already pinned by `tests/server/lifecycle.test.js` on both adapters. The real fix is two lines:
give `adminpanel.js` the roster port `mount.js#refreshRoster` already builds, and intersect the
log's member list with the roster's `removedAt`. **Owner: `family/adminpanel.js` + `family/mount.js`.**

### R-5 · §E1 — two operations are over the 60 fps frame
`memberToggle` **19.4 – 20.5 ms** (1.2 frames) and `findWorst` **22.3 – 23.4 ms** (1.3 – 1.4
frames), five isolated runs. `renderBoard` is closed at 3.3 – 3.5 ms. The toggle cannot reach
16.7 ms without changing what the board shows (§4); `findWorst` is `find.js` and was already red
before LZP-1007. **Owners: `find.js`, and a product decision on the toggle.**

### R-6 · §A4 and §E3 — the two reds that are not code defects
- **§A4** — the 9 px ink floor. A **PO ruling**: it may not be closed by editing `palette.js`,
  which the tier-1 oracle pins.
- **§E3** — the row asks for 75 % where **48 % is the mathematical ceiling for any ordering**. A
  spec threshold error, not a code defect. Do not silently change the number.

### R-7 · The join path is fixed but has never crossed the real bridge
The four paste defects are closed and pinned by 42 rows (`tier1/createjoin.test.js` 31 incl. a
20 000-paste generator that found E-1d, `tier2/join-paste.dom.js` 11 in the real WKWebView). But
**no join has ever run over the `sync_request` bridge**: the tier-2 relay verifies
`SHA-256(proof) === verifier` over real WebCrypto and is in-process.
`SHELL-VERIFICATION.md` §10's conditional-story list is unchanged.

### R-8 · The database is verified; the adapter over it is not
The migration was applied to a real PostgreSQL 17.10 cluster and every constraint the ADRs lean on
was exercised with live SQL. **`server/adapters/prisma.js` has never run against it** — that needs
the generated client and §2.5's `store-contract.test.js`. The check reports L1 and L2 as **stated
skips**, never as passes. **Owed.**

### R-9 · Three CI and deploy gaps, each in someone else's file
1. `server.yml`'s path filter does not include `tests/server/**`, so the test that guards the
   readiness check is not triggered by edits to itself. A schema change *does* trigger it, so the
   recurrence guard works; its own guard has a blind spot.
2. `vercel.json`'s `ignoreCommand` is `git diff --quiet HEAD^ HEAD -- .` — single-commit. A push
   whose *last* commit misses `server/` skips the deploy even when an earlier commit in the same
   push changed it. No row checks this.
3. `scripts/shell-family-e2e.mjs` still prints `BLOCKED (finding F-SHELL-1)` for any attempted
   phase that fails. With F-SHELL-1 closed the label is stale; the only attempted phase left is
   F-SHELL-3.

### R-10 · Two tickets built but not wired, and one never built
- **LZP-1009 „Rückmeldung senden"** — the eight `src/js/feedback/` modules exist, but
  `family/mount.js` never calls `setFeedbackPort(...)`, so `canSend()` is false and „Senden" is
  disabled with the reason on screen. And there is **no production sink**: Vercel answers 501,
  honestly.
- **`docs/v2/traceability.json`'s E10 verdicts are stale** — LZP-1001 and LZP-1009 are recorded
  `OWED`, but `settings.js:534 DATENSCHUTZ` and `src/js/feedback/` are both in the tree. Corrected
  in this pass's `verification.final` block.

### R-11 · Three diagnostic bugs that will mislead the next reader
1. `tests/tier2/shell-family-e2e.dom.js:466-471` calls `Object.keys()` on
   `membersui.membersRegisters()`, which returns a **Map**, so `REGKEYS`/`DEVREGS`/`MEMREGS` print
   `[]` unconditionally. They are **not** evidence of an empty register map.
2. The same file's line 459 reads `m.attestation` on the member row, but ADR 003 §3.6 puts the
   blob on `m.devices[].attestation` — so `att=` is always `false`.
3. `assert.doesNotThrow(() => validateOp(op))` is **vacuous**: `core/ops.js#validateOp` returns
   its verdict as `{ok:true}` or a rejection object and never throws. The first cut of §5b made
   exactly that mistake and survived the mutant that should have killed it.

### R-12 · One flake seen twice and not reproduced since
`tests/tier1/createjoin.test.js` §2d failed twice in an unmodified copy of this tree earlier in
the session — `i=18397 "join\tdein\tcode" → J01N-DE1N-C0DE` — and has passed on every run since,
including all of this pass's. Not reachable from anything edited here. Its owner should look.

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
| LZP-1009 | E10 | — | Feedback button | 21.3 21.4 21.5 | **NOT BUILT** |
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
npm test                    # 2216 / 0
npm run test:property       #  101 / 0
npm run test:attack         #  970 / 0
npm run test:server         #  998 / 0
npm run test:fleet          #  423 / 0
npm run test:dom            #  902 pass / 3 fail, 54 files

# the acceptance run — 26 launches of the shipped binary, ~4.5 min each
node scripts/shell-family-e2e.mjs --port 8801
#   → "THE FOUNDER RECEIVED A JOINER'S ENTRY: YES" and "0 phase(s) failed"

# §E1 in isolation — run the file ALONE or the numbers are contention
./tests/run-dom-tests.sh tests/tier2/e8-density-perf.dom.js

# the identity proof
./tests/run-dom-tests.sh tests/tier2/e1-incremental.dom.js

# the redaction boundary, and the shell's SSRF refusal
node --test --import ./tests/helpers/dev-flag.mjs \
  tests/attack/e7-leak-*.test.js tests/attack/redaction-invariants.test.js \
  tests/fleet/e6-attack-privat.test.js tests/fleet/e6-gate-privat.test.js
node scripts/shell-ssrf.mjs

# deployability, and the Mom test
node .github/scripts/check-server-config.mjs
node scripts/mom-test-probe.mjs
```

**The v1 oracle, per file** — a total is not evidence:

```bash
git archive 6268cbe | tar -x -C /tmp/base
for f in dates-holidays layout palette repeats-find-i18n storage store-persistence suite-integrity; do
  diff <(cd /tmp/base && node --test --import ./tests/helpers/dev-flag.mjs "tests/tier1/$f.test.js" \
          | grep -E '^[[:space:]]*(not )?ok [0-9]+ - ' | sed 's/ # [0-9.]*ms$//') \
       <(node --test --import ./tests/helpers/dev-flag.mjs "tests/tier1/$f.test.js" \
          | grep -E '^[[:space:]]*(not )?ok [0-9]+ - ' | sed 's/ # [0-9.]*ms$//') \
    && echo "IDENTICAL $f"
done
```

---

## 11. The one-line verdict

**A family works in the app we ship, five times out of five.** What is left is one data-loss bug
in the unshare path (R-1), one cosmetic-but-permanent refusal nobody has yet explained (R-2), and
a missing line in an e-mail that stops the only test that matters — a person who has never seen
the app (R-3).
