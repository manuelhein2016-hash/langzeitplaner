# v2 — the findings register

**One place to look.** Every defect, gap and deliberate divergence found by any audit of WP-1
(the pure core), WP-2 (the v1 characterization suite) and WP-3 (the retrofit) lives here, with its
owner and its status. Nothing is "known but written down somewhere else".

**Opened:** 2026-08-27, folding in `judge:adversary3` and `judge:conformance` (both run read-only
against `c0306ac`), the four WP-3 adversary findings already in STATUS, and the three deferred
items from STATUS §5.

**Updated:** 2026-08-27 by the **fix pass** — three parallel fixers and one integration pass.
Eight rows closed (A3-C1, A3-H1, A3-H2, A3-H3, A3-M1a, F-1, F-3, F-10); six new rows opened by
the work itself (I-1 … I-6), one of which was closed in the same pass. **Every closure in this
file is mutation-tested** — reverted in a scratch copy of the tree, and required to redden a
named row. The table is §7. *A fix with no test that dies is not recorded as fixed*, and one
"fix" that survived its own mutant is recorded as what it actually is instead.

**Updated again 2026-08-27, rounds 4 and 5 + their integration pass.** Two more adversary rounds
ran against the retrofit and the authority rule, and this register did not keep up with them — the
`R4-*` and `R5-*` rows lived only in `tests/attack/` and in ADR 006's header. That is the failure
mode this file exists to prevent, so the round-5 findings are folded in below and §1's counts are
recomputed from the rows rather than carried forward.

Three things in this update are corrections to *earlier entries in this register*, not new
findings, and they are the reason the round was worth running:

- **A3-C1 was reachable again**, through the one branch its own fix created (`R7`, the
  absent-`board.json` recovery). Filed as **R5-3**, closed, and A3-C1's row now says so.
- **A3-M5 was not "latent"**, as it was filed. It was load-bearing on every launch after the
  first, and it was the most consequential defect this project has had. It is promoted from
  MEDIUM to **HIGH** and closed.
- **I-3 is worse than filed.** Round 5 turned it from "a member can take a lookup" into a remote
  denial of service against any family member's device, and showed that WP-6's owed P2 check does
  not close it. Escalated to **HIGH** and moved to §4 as a decision.

Every round-5 closure carries its own mutant in §7, on the same rule as the first pass.

**Updated again 2026-08-27, round 6 + the round-7 fix and integration pass.** A sixth adversary
round ran against the op-log core and the retrofit, three fixers worked in parallel against an
**enumerated input domain**, and one integration pass landed the cross-file work and caught the
register up. **39 rows → 49.** Nine closures and one new open row; counts recomputed from the rows.

Three things in this update are worth reading before the rows:

- **Round 6's closing claim that "content is safe" is wrong**, and the input that disproves it —
  `D1-b18`, an object that is nothing but ADR 006's envelope — was found by enumerating the
  **bytes** rather than the branches. It is the only path in the register that costs the
  **calendar** rather than the history, and at WP-8 what it propagates is not a corrupt file but
  well-formed deletes this app minted itself. → **R6-5**, CRITICAL, closed.
- **§7d is new and is a process rule, not a finding.** Five consecutive rounds each *relocated* the
  same failure, because each fix was chosen a branch at a time and the branch was chosen before the
  input domain was written down. The domain is now a committed artifact —
  **`tests/helpers/domains.js`**, 310 entries — and it is the required method for anything in ADR
  006 §5/§7/§9.
- **§4.6's open decision is closed and no PO ruling is owed on it**, because the dilemma was
  misstated rather than unresolvable.

**Updated 2026-08-29 by the E5 integration pass — the first pass with a SECOND DEVICE.** WP-8 is
built and milestone M1 („Zwei Macs") is demonstrated in two real browser contexts against
`node server/dev-server.mjs` over real HTTP; the run is in **`docs/v2/E5-VERIFICATION.md` §3**.
This is the pass §3 of this file was written for, so §3 now carries a **disposition line on every
row** rather than a plan.

Four things in this update are worth reading before the rows:

- **E5-2 is the most consequential defect since A3-M5, and it was inside A3-M5's own fix.** The
  outbox did not survive a quit: `_persistOps` folded unacknowledged ops into `checkpoint().regs`
  and dropped their LINES, so five entries made on an offline laptop never reached the desktop,
  ever, while `sync.status()` said `healthy`. Found by the fleet harness, closed by one clamp,
  and its accepted-defect row is **inverted**.
- **F-6 is closed at the seam the finding names**, and closing it took four coordinated edits, not
  one: the park reason had to exist (**E3-3**), it had to SURVIVE A RELAUNCH (`classifyOp` gained
  `haveAttestation`, because `load()` re-classifies parked lines and would otherwise have
  promoted an unattested device's op to live), `applyRemote` had to park instead of drop, and
  something had to re-judge the held lines.
- **Three findings were produced BY the demonstration** — E5-5 (the pairing poll cannot fit the
  published `pairGet` budget, measured as a real 429), E5-6 (a paired Mac receives none of the
  pre-space board, categories included — this is M1's last real gap), E5-7 (`device.attestation`
  has two spellings on two endpoints).
- **Four network gates were amended from "no import edge" to "no STATIC import edge".** The
  stronger form forbade the design ADR 003 §7 gate 2 and ADR 002 §2.4 themselves describe, and the
  way it gets worked around in practice is by hiding the specifier from the walker — which turns a
  real gate into a vacuous one. The gate now counts the doors instead: exactly one, named.

**Updated 2026-08-29 by the ROUND-8 integration pass — the op lifecycle, enumerated.** E5's two
adversaries attacked M1 and found **no confidentiality break**: 21.1 and 21.2 both held. What they
found was that the engine **lost ops silently and reported `healthy` while doing it**. Four fixers
worked in parallel against `tests/helpers/sync-domains.js` — 253 entries, five domains, zero
imports, §7d's method applied to the OP LIFECYCLE rather than the op kinds — and this pass landed
the cross-file work. **49 rows → 55.** All six suites green; the property that walks the domain is
**85/85, 0 UNEXPECTED, 0 STALE**. The rows are §3c and the mutants are §7a-round8.

Four things in this update are worth reading before the rows:

- **E5-2 was recorded as fixed and was not.** Its own clamp asked about the CAP where the
  unrecoverable condition is about the FLOOR, and the arm it got wrong is the state EVERY
  compaction leaves behind. Re-opened, and closed twice — because a second, independent defect
  (**L-4**) was hiding behind it and became visible only once the first was fixed. The 24-seed
  convergence sweep still lost an op on 2 seeds in between, which is a rate that reads as "it
  works" on most runs; the headline now runs at **128 seeds**.
- **`sync/client.js` was the only importer of four modules this register had filed as dead code**,
  and three of them were defences the product was designed to have and did not: the chain witness,
  a durable park for sealed envelopes, and a durable chain anchor. One was deleted; three were
  wired. **A module is not dead because nothing imports it; it is dead because nothing needs it.**
- **A fix that reports errors for ever is the same failure in the other direction**, and this pass
  walked into it: folding `store.warnings` — which carries repairs, re-joins and successful cures
  — into `error` lit a fault on every launch that had anything to say. → **L-5**. The `S4-quiet`
  and `S4-pending` controls caught it, which is what non-vacuity controls are for.
- **Two rows of the ENUMERATION were internally contradictory** and no build could satisfy both
  (§3c, L-5). They are corrected in the probe, not in the `expect`, and recorded — a domain that
  cannot be satisfied is a work order that lies.

**Status vocabulary**

| status | means |
|---|---|
| **open** | a real defect; someone must change code. The owner column says who. |
| **accepted** | measured, understood, and deliberately left as it is. Not a bug. Do not "fix". |
| **decision** | a PO must choose before an engineer can act. See §4. |
| **fixed** | closed, with the evidence that closed it — *and* the mutant that proves the gate can fail. |

**Reading the evidence.** Several rows are pinned by tests under `tests/attack/` that are green
**because the defect exists** — the directory's convention. **If one of those goes red, the gap was
closed: invert the row, do not repair the test.** Rows that have already been through that carry
`FAILED (held)` or `INVERTED` in their title and now assert the fix.

---

## 1. By severity — the count

| severity | open | accepted | decision | fixed | total |
|---|---|---|---|---|---|
| **CRITICAL** | — | — | — | 5 | **5** |
| **HIGH** | 3 | — | 1 | 11 | **15** |
| **MEDIUM** | 8 | — | 1 | 10 | **19** |
| **LOW** | 5 | 3 | 1 | 4 | **13** |
| **INFO / gap** | 2 | 2 | — | 1 | **5** |
| | **18** | **5** | **3** | **29** | **55** |

*(Recomputed 2026-08-29 by the **round-8 integration pass**: 49 → **55**. Six new rows — **L-1**,
**L-2**, **L-3** (HIGH), **L-4** (CRITICAL), **L-5** (MEDIUM), and **P-8** (CRITICAL), which had
lived only in `tests/attack/privacy-e5-scope.test.js`. **P-4** moves from open to fixed. **E5-2**
was re-opened and closed again; it is counted once, as fixed. Three of the six were opened BY the
enumeration and had no `tests/attack/` row at all before it — which is the argument for
enumerating an input domain rather than reviewing branches, made a second time.)*

*(Recomputed from the rows on 2026-08-27 by the **round-7 integration pass**: 39 → **49**. Ten new
rows — R6-2, R6-3, R6-4, R6-5, R6-6, R6-7, R6-7e, R6-10, R6-11, and **R7-1**, which this pass
found itself. Nine of the ten are **fixed**; R7-1 is open and is a defect round 7's own fix
introduced. Round 6's `R6-*` findings had until now lived **only in `tests/attack/` and in ADR
006's header** — the same failure mode that made the round-5 update necessary, one round later.
The `A3-M5` and `I-3` rows appear in two severity tables as cross-reference stubs and are counted
once, in the table they were promoted to.)*

Nothing in this register breaks the app that ships today. Read §3 before starting WP-8: **six of
the eighteen open rows go from latent to live the moment a second device exists.**

> **E3's findings are in their own block, §2e**, and are deliberately **not** folded into the
> table above: they did not come from an adversary reading v1's code but from *building* the
> crypto layer and running it in the engine that ships, and three of them are facts about
> **WKWebView** that no review would have produced. **`E3-1` is the one to read first — it is
> currently the only row in this register that stops a family-mode release**, and it is an input
> to PO decision **D1**. Full evidence: `docs/v2/E3-VERIFICATION.md`.
>
> **Read `E3-9` and `E3-10` second, because between them they mean two of the five suites were
> not green when they were recorded as green.** Neither is a defect in the product: E3-9 is two
> red-team rows that decided their verdict on a random ciphertext byte (`npm run test:attack`
> failed ~1 run in 13 — **fixed**), and E3-10 is a tier-2 rendering row that reads the wall clock
> and therefore fails every Saturday, Sunday and Ferien day (**open, another owner's file**). A
> suite that is green four days in seven is not a gate, and a fix recorded green off a lucky run
> is a fix nobody checked.

**All three CRITICALs are closed** — A3-C1, the R7 branch that re-opened it (R5-3), and **R6-5**,
the classifier that guards the precondition of the whole ADR and had a hole in it on **both**
sides. So are the seven HIGHs that a file on disk could reach, including A3-M5 (round 5 promoted
it out of MEDIUM) and **R6-4**, which is A3-M5's *cost* re-created by A3-M5's own *fix*. The three
HIGHs that remain are one convergence blocker (A3-H4) and two rows found *while proving other
fixes* (I-1, I-2). The HIGH **decision** was I-3, which round 5 escalated — **decided and built
2026-08-28, §4.5 option (a)**.

**§4 has no open decisions left.** §4.6 (R5-11g — a bar edge with no faithful v2 value) is
**closed**: round 7 showed the dilemma was not about fidelity at all but about one rule being asked
to serve two fields, and the answer is per field. No PO ruling is owed there. **§4.5 (I-3 / R5-7)
is decided and built** — 2026-08-28, option (a), as a possession proof at fold time rather than as
the first-writer race the option was priced as. What survives it is two obligations on WP-8, not a
question: nothing may append an op that has not passed `openOp`, and ADR 002 §5.2.2's check 4 may
not be weakened.

**One open row is this pass's own doing.** **R7-1** — R6-6 added a fourth boot outcome to a
three-valued `diagnostics().source`, and the value it reports for that outcome is the one
documented to mean the opposite. Diagnostics only; nothing on disk, on screen or in the read-only
promise depends on it. It is filed rather than patched because widening a documented contract
field belongs to that contract's owner, and because jamming a fourth outcome into whichever of
three values fits least badly is exactly the move §7d exists to stop.

**What moved between severities, and why** — recorded because a severity that changes silently is
worth as little as a finding that is never written down:

| row | was | is | what changed the reading |
|---|---|---|---|
| **A3-M5** | MEDIUM, open, "latent — nothing appends, so nothing grows" | **HIGH, fixed** | It was never latent. R5-4 measured it live on every launch after the first: no op the user made was written to the log again, ever. |
| **I-3** | MEDIUM, open | **HIGH, decision (§4.5)** — *decided and **built** 2026-08-28, option (a)* | R5-7 turned a lookup-shadowing trick into a permanent remote mute of a named device, self-authorizing and irrevocable. The answer is a possession proof at fold time, not P2. |
| **A3-C1** | CRITICAL, fixed | **CRITICAL, fixed** (unchanged) — but see **R5-3** | The rule held; the *implementation* grew a second door into it. Recorded as its own row rather than by quietly re-opening the old one. |

**Suites at the close of the ROUND-7 integration pass**, all four fully green:
`npm test` **1665**/0 · `npm run test:property` **62**/0 · `npm run test:attack` **566**/0 ·
`npm run test:dom` **22 files**, tier 2 PASS. The tier-1 and tier-2 counts include the untracked
files of the parallel WP-6 crypto workflow (which owns `src/js/crypto/`,
`src/js/platform/keystore.js` and the shells' Keychain bridge); nothing in this pass's scope
touched any of them.

**`tests/property/domains.test.js` is fully green: 310 enumerated inputs, 0 UNEXPECTED, 0 STALE,
`openFinding` null on every entry** — D1 94 + D1_RECOVERY 8 · D2 44 · D3 5 · D4 14 · D5 4 · D6 141.
The 51-entry work order the enumeration opened with is closed in full.

*(Round-5 close: 39 rows, `npm test` 1374/0 · `test:property` 51/0 · `test:attack` 512/0 ·
`test:dom` 15 files. First fix pass: 31 rows, `npm test` 1360 · `test:attack` 340.)*

---

## 2. The register

`aka` is the id the finding carries in the audit report it came from, so both reports stay
navigable. Line numbers are against `c0306ac`.

### CRITICAL

| id | aka | one line | file:line | owner | status |
|---|---|---|---|---|---|
| **A3-C1** | C-1 | One well-formed line in `ops.jsonl` discards `board.json` entirely — 0 notes, 0 bars, 0 categories, **no warning** — and the first autosave commits the empty board to disk, to `snapshots.json`, and to the next migration | `src/js/store.js:465-478` | **WP-8** | **fixed** (third attempt — ADR 006; see **R5-3**) |
| **R5-3** | R5-3a/b/c | A3-C1 **reachable again**, behind one corrupted byte: an unreadable `board.json` fell into R7's recovery branch, which performs **no lineage check of any kind**, so a planted log became the board — and `persistNow()` then committed it over the file that was merely unparseable | `src/js/store.js` (`init`, `_recoverFromLog`), `src/js/storage.js` (`loadBoardText`) | **WP-3** | **fixed** |
| **R6-5** | R6-5a/c/d/g · D1-b01, D1-b14…b18 | A3-C1's precondition, reached from **both sides at once**. (a) A **zero-byte** `board.json` was `absent`, so a truncated write took §5.5 — the one branch that may adopt a log on no evidence. (d) `Array.isArray` was the **whole** shape gate, so **any** JSON object was a board — and `{"_v2":{lineageId:<the victim's>,gen:N}}`, an object that is *only* ADR 006's envelope, was classified `ok`, matched `same-lineage`, **adopted the log, and minted one `{_alive:false}` retraction per entity**. The empty board and its tombstones were both committed and the next launch agreed | `src/js/storage.js:97-140` (`loadBoardFile`), `src/js/store.js:805-935` (`BOARD_SHAPE`, `boardKeysOf`, `classifyBoardFile`) | **WP-3** | **fixed** |

`shouldMigrate(board, {opsLogExists})` has exactly one input about the log — *does one exist* — and
none about whether that log has anything to do with **this** board. On the log branch `init()` does
`this.state = this._blankState(); this._project(…)`, so `board.json` is discarded in favour of
whatever the log folds to; `persistNow()` writes that back; `rollSnapshot()` stores the
already-emptied `_persisted`, so 11.5's "restore yesterday" returns the empty board too. Reached
identically by a **torn final line** (`parseJSONL` correctly skips it; the intact first line is
still "a log") and by a **checkpoint the loader cannot read** (`{nonsense:true}` — no throw, board
emptied, `ready: true`).

**Reachability, honestly:** `store.js` never writes `ops.jsonl` or `checkpoint.json` today
(`_opsPersisted` is a closed loop; `tests/attack/round3-persistence.test.js` R3-38 pins that a
persist touches exactly the two v1 slots), so nothing in the shipping app can create the
precondition. It becomes reachable the moment **WP-8 appends one op**, a crash interrupts an
append, or anything else writes that `localStorage` key. **The defect is not "the app loses boards
today"; it is "the door has no lock and WP-8 is next."** The fix is a consistency check, not a
bigger guard: the checkpoint must carry the board identity/horizon it was folded from, and a log
that does not match `board.json` must be **quarantined**, not trusted.
→ `tests/attack/round3-persistence.test.js` R3-31/32/33/34.

> **FIXED 2026-08-27**, as the consistency check the filing asked for rather than a bigger guard.
> `shouldMigrate` keeps its contract (it answers *has migration already run?*); a separate
> `logBelongsToBoard()` answers *may this log discard `board.json`?*, and **only both together**
> may. Two layers:
>
> 1. **Provenance.** `_stampedCheckpoint()` writes `checkpoint.json` with an
>    `lzp: {v, boardFp, boardN, horizon, at}` envelope naming the generation of `board.json` it
>    was folded from. **No envelope ⇒ not written by this app over this board ⇒ refused.** A
>    *stale* fingerprint is **not** fatal — that is the ordinary crash-between-two-writes case —
>    so it warns and falls through to layer 2. `core/oplog.js` is untouched: it neither writes nor
>    reads `lzp`, and `load()` ignores unknown keys.
> 2. **Census.** Every entity key `board.json` asserts must overlap the keys the log has heard of
>    (registers ∪ every line's `e`, live or tombstoned). Overlap **zero** ⇒ not this board's log.
>    Partial ⇒ accepted, with a warning naming the entries the log never heard of.
>
> `_quarantineLog()` makes **three promises**: not applied, **not deleted**, **not overwritten**
> (`_opsPersisted = false` is set there structurally, so `_persistOps()` cannot touch the two
> slots for the rest of the session). It records `store.quarantine = {at, reason, detail,
> checkpointHorizon, tailLines, checkpoint, tailSample}`, which is what a "your op log was
> refused" notice should read.
>
> **Rows inverted, not deleted:** R3-31…R3-35 → `FAILED (held)`, plus new **R3-35b** (18 shapes of
> broken checkpoint, each must boot with the board intact and leave the file untouched),
> **R3-35c** (a log this build *wrote* is still trusted — the control that stops "refuse
> everything" passing as a fix) and **R3-35d** (a well-formed checkpoint of *another* board is
> refused). The three C-1 rows in `upgrade-day-crash.test.js` are inverted too; its fourth was
> re-anchored onto A3-M5, which stays open and still pinned.
>
> **Mutants (§7):** disabling the verdict reddens 11 rows; disabling **layer 1 alone** reddens 2;
> disabling **layer 2 alone** reddens 8. The two layers are independently falsifiable.
>
> **WP-8 MUST READ THIS:** whoever sets `_opsPersisted = true` when a space is created **has to
> consult `store.quarantine` first**. Turning the flag on over a quarantined log would overwrite
> the very bytes the quarantine exists to preserve. Noted at the call site.

> ### A3-C1's THIRD ATTEMPT, AND THE DOOR IT LEFT OPEN
>
> The register recorded A3-C1 as fixed by the two-layer check below. **Round 4 killed that check**
> (R4-1a: the census quarantines only on *zero* overlap, and `pad:<YYYY-MM>` is a month key every
> board that ever existed shares — one guess), and the rule was rewritten a third time as
> **ADR 006**: `board.json` is the truth, the op log is history, adoption turns on one equality
> and can never change content. **Round 5 confirmed that rule holds.** What it broke was the
> implementation, and R5-3 is the worst of it.
>
> **The attack.** ADR 006 §5.5 names one asymmetric branch: with no `board.json` there is nothing
> for a log to overrule, so a readable log becomes the truth (R7). The branch was entered on
> `kind !== 'ok'`, not on `kind === 'absent'` — so a `board.json` that merely **failed to parse**
> took it. One truncated byte in the victim's board, a legitimate `checkpoint.json` + `ops.jsonl`
> pair for the **attacker's own** board beside it, and A3-C1's original outcome is back: the
> stranger's board on screen, `persistNow()` committing it over the victim's file, and — one
> launch later — the quarantine machinery *renaming the evidence away*.
>
> Two smaller doors fed the same branch. `loadBoardText()` turned a **thrown** native read (a
> locked file, a dismissed permission prompt, an EIO) into `txt = null`, which is
> indistinguishable from *there is no board file* — so a transient error was a recovery. And
> nothing consulted `snapshots.json`, which is §8.2's own stated answer for exactly this morning.
>
> **THE FIX — the precondition, and a boot that refuses to write.**
>
> 1. `storage.loadBoardFile()` reports **four** statuses, not two: `ok` / `absent` /
>    `unparseable` / `read-failed`. A thrown read is a **fact** (`read-failed`), never an absence.
>    `loadBoardText()` is now a thin wrapper over it and keeps its two historic keys byte for byte.
> 2. `store.classifyBoardFile()` adds the fifth case `splitBoardEnvelope` was silently folding
>    into "absent": **`not-a-board`** — valid JSON that is `[]`, `"a string"`, `null` or `7`.
> 3. `init()` branches on the kind. **`_recoverFromLog` is reachable only when
>    `kind === 'absent'`** — which is, finally, the precondition ADR 006 §5.5 argues for.
> 4. Everything else goes to **`_bootUnreadableBoard`**, whose order is the whole fix: set
>    `bootFailure` so the session is read-only **before** anything can write; quarantine any log
>    as **`board-unreadable`** (an unreadable board has no `_v2.lineageId`, so nothing ties a log
>    to it — *a log is refused on the absence of a tie, never adopted on it*); then show the
>    newest usable `snapshots.json` entry, or an empty stand-in, and say so.
> 5. **`_sequesterQuarantine()` is gated on `!bootFailure`.** A read-only session's promise is
>    that every file is exactly as it was, and a move-aside is a write. This is what stops R5-3b's
>    second half: the evidence is no longer renamed away one launch after the board.
> 6. Genuine-absent recovery now says out loud that **nothing verified the log belongs to this
>    board**, names `snapshots.json`, and adopts the checkpoint's `lzp.lineageId` — so the
>    recovered board is written back carrying `_v2` and the *next* launch does not quarantine and
>    rename the only copy of the board it just rebuilt.
> 7. `diagnostics().recoveredFrom` tells R7's genuine recovery apart from the read-only disaster
>    boot that used to hide inside the same `source: 'recovery'`. `source` keeps its three
>    documented values.
>
> **Human-facing copy** (DE ships; EN twins) is written verbatim into `_bootUnreadableBoard`'s
> docblock, keyed off `bootFailure.reason`, and is the seam a settings pane renders from. Its
> first promise is the one that matters: *„Ihre Daten sind NICHT gelöscht — die Datei liegt
> unverändert an ihrem Platz."*
>
> **Two seams the parallel fixers could not reach, closed in the integration pass** — both were
> **unproven** when integration began (reverting either killed no row in any suite, which is the
> same thing as not having a fix):
>
> - **`_projectSafe` clobbered `bootFailure`.** If the *snapshot* standing in for the unreadable
>   board also refused to project, `reason` became `unprojectable` — a claim that the board is
>   BROKEN, made about a file nothing has successfully parsed — and `shownInstead`, `logPresent`
>   and the copy keyed off them went with it. First reason now wins; the projection error is
>   recorded beside it as `projectionFailure`. → **R5-3e**.
> - **`persistNow`'s read-only sentence** told all four reasons *"the board on disk could not be
>   **drawn**"*. On the three `board-*` reasons nothing has read the file, so nothing has tried to
>   draw it; the honest sentence is that the app could not **open** it, and on a dismissed
>   permission prompt that is the difference between relaunching and giving up. `readOnlyBecause()`
>   branches on the reason, and the `unprojectable` sentence is kept unchanged where it is true.
>   → **R5-3f**, whose third clause is the non-vacuity control.
>
> **Rows inverted:** R5-3a, R5-3b, R5-3c in `tests/attack/round5-authority.test.js`; R5-3e and
> R5-3f added by the integration pass. **Mutants (§7):** rows 24-30. Restoring both files makes
> all four original R5-3 rows green again — the control that says the rows measure the fix and not
> the weather.
>
> **Still owed on this path:** the first-run tour still shows over a disaster boot with no
> snapshot, because `seenFirstRun` is left at v1's `false` and
> `tests/tier1/store-persistence.test.js:240` characterizes that by name. Re-baselining a v1
> observable is the tier-1 owner's call; the read-only guard and the warning are what actually
> protect the file. And `quarantineLogAside` on the native path still cannot move anything (the
> owed `quarantine_logs` shell command) — now much less pressing, since a failed boot never
> sequesters at all.

> **R6-5 — FIXED 2026-08-27 (round 7), and it is the row that ends "content is safe".** Round 6's
> closing verdict said no attack it could construct cost one entry or one field value. `D1-b18`
> does, and it was found by **enumerating the bytes** rather than the branches — which is the
> whole argument for §7d's method.
>
> **The two halves, and why they are one row.** Both are the same precondition — *which of the
> five things is `board.json`?* — falling off opposite sides.
>
> · **`''` (R6-5a).** `loadBoardFile` tested `typeof txt !== 'string' || txt === ''` and
>   `fallback = … && txt !== ''`. **Zero bytes are bytes.** A store that answers with a string of
>   any length has answered; only when **no store answered with a string** and nothing threw can
>   the file be `absent`. `JSON.parse('')` throws, so an empty file now lands on `unparseable`
>   with its own detail — *"board.json is EMPTY — zero bytes"*, not *"its 0 bytes are still on
>   disk"* — and goes to §5.6's read-only boot with the other two.
> · **`{}` and its class (R6-5c/d).** An object is a board **iff** it carries ≥ 1 of the five
>   collections `notes/bars/categories/scratchpads/settings`, **present AND well-typed**.
>   `schemaVersion` and `_v2` are deliberately excluded: a version number is a claim any file can
>   make, and `_v2` is ADR 006 §4.1's *additive* key — it says which log is bound to a board, it is
>   not a board. Presence alone is not enough either: `{"notes":"nicht ein array"}` passes it
>   (mutant **F4b**). It is **not a validator** — `{notes:[…], bars:'x'}` is still a board and
>   `migrate()` still repairs it.
>
> **Why `{"_v2":{…}}` is the sharpest input in the domain.** Under ADR 006 `board.json` is the
> **sole** content authority, so calling an unrecognised object `ok` is not a shrug — it is an
> *authoritative assertion that the board is empty*. Three things followed, all measured:
> the calendar was empty and the session **writable**; a board with no `_v2` had its own log
> quarantined `board-carries-no-lineage` and **sequestered**; and with the victim's own lineage in
> the envelope the log was **adopted**, so §5.4's *"the log has a live entry the board lacks ⇒ an
> honoured deletion"* — which is exactly right for a Time-Machine restore — minted **nine
> well-formed `{_alive:false}` retractions**. At WP-8 what propagates is not a corrupt file but
> deletes this app minted itself.
>
> **Reachability, honestly, on the same terms as A3-C1.** Nothing in the shipping app writes a
> board file of either shape: a truncated write leaves invalid JSON, not an envelope, and
> `serializeBoard` never emits `_v2` alone. Both are reachable by anything else that writes the
> slot — a sync client, a restore tool, a partial write by a future build — which is precisely the
> class of writer WP-8 introduces. **The defect was never "the app loses boards today"; it is
> that the precondition of the whole ADR had a hole in it on both sides.**
>
> **Rows inverted** in `tests/attack/round6-recovery.test.js`: R6-5a, R6-5c, R6-5d. **Added:**
> **R6-5a2** (the source axis — browser / Tauri-native / native-throws-with-fallback /
> native-miss-with-fallback, plus the three `absent` controls), **R6-5g** (`D1-b18`: `_adopted`
> is null and a persist moves not one byte, i.e. the nine retractions are never minted), **R6-5h**
> (the non-vacuity control — six board shapes that must still boot **writable**, and a board with
> its own log adopting at `reconciled === 0`). Controls R6-5b/e/f still `FAILED (held)`.
> **Mutants (§7):** F3, F4, F4b — and F6-snapshot, which makes eleven attack rows load-bearing on
> `snapshots.json` actually being consulted.

### HIGH

| id | aka | one line | file:line | owner | status |
|---|---|---|---|---|---|
| **A3-H1** | H-1 | A `checkpoint.json` that **parses but has no `v`** throws out of `init()` and the app never boots — white screen, no recovery path, intact `board.json` sitting right there | `src/js/store.js:476` → `src/js/core/oplog.js:846` → `src/js/core/registers.js:711` | **WP-3** | **fixed** |
| **A3-H2** | H-2 | The migration door silently drops five entry shapes v1 keeps, and the loss is committed to `board.json` on the first autosave | `src/js/store.js:487-493`, `src/js/core/migrate1to2.js`, `src/js/core/materialize.js` (`projectable`) | **WP-3** | **fixed** — §4.2 decided COERCE |
| **A3-H3** | H-3 | `applyRemote([null, goodOp])` throws a bare `TypeError` and **discards the whole batch**, including the well-formed op | `src/js/store.js:698-703` | **WP-3** | **fixed** |
| **A3-H4** | H-4 | Two Macs over one board **cannot converge at all**: stamps and opIds agree exactly as ADR 001 §8.1 promises, but `_me` is ephemeral per process, so each refuses the other's ops with `notMyAct` | `src/js/store.js:415-425`, `src/js/core/authz.js:490-494` | **WP-6** → WP-8 | open |
| **I-1** | new | `replaceAll()` discards the live board **before** the projection that can refuse it — an import or an 11.5 snapshot restore that throws leaves `state` a blank the app can never have produced, and the ordinary 700 ms autosave writes the blank to `board.json` | `src/js/store.js` (`replaceAll`, `restoreSnapshot`) | **WP-4** | open |
| **I-2** | new | `init()` throws `MaterializeError` on a **poisoned `board.json`** (`startMonth: "nope"`, `pageYears: 1e9`) and `ready` stays `false` — the white screen A3-H1 closed, reached through the board rather than the checkpoint | `src/js/store.js` (`init` → `_project`) | **WP-3** | open |
| **A3-M5** | M-5 · R5-4 | **PROMOTED FROM MEDIUM.** `_persistOps()` documents itself as "append the tail, then checkpoint" and **never calls `appendOps`**; `truncateOps(0)` is guarded `keepFromLine > 0` so it **keeps every line**. Filed as latent. It was not: from the **second launch onward nothing the user did was ever written to the log again** | `src/js/store.js` (`_persistOps`), `src/js/core/oplog.js` (`resolveHorizon`) | **WP-3** | **fixed** |
| ~~I-3~~ | new · R5-7 | **ESCALATED FROM MEDIUM.** A contested `deviceShort` is resolved by **refusing it**, and the short is trivially discoverable — so one `member.set` filed under a peer's short makes every sealed envelope from that Mac park **for ever** | `src/js/core/authz.js` (`attestationOf`, `shortCollisions`) | **PO** → WP-6 | **CLOSED 2026-08-28** — §4.5 option (a), built as a possession proof at fold time |
| **R6-4** | R6-4a/b/c · D2 × D3 | **A3-M5, re-created by A3-M5's own fix, and remotely triggerable.** One ordinary op stamped beyond the 24 h window is **parked** — ADR 001 §7.4's shock absorber, applied to no register. `_clockSkew` walked `ops({includeParked:true})`, found that stamp, and quarantined **the entire log** as `clock-skew` **on every launch until the stamp passed** — at +90 days, for ninety days — with `_quarantineLog` setting `_opsPersisted = false`, so the device recorded nothing for the duration. And because `foldAuthorized` decided the park **before** any authorisation stage ran, an op the store refuses outright when stamped *now* was **kept** when stamped +48 h: a stranger could disable the victim's whole history with nothing but a date | `src/js/store.js` (`_clockSkew`, `applyRemote`) | **WP-3** | **fixed** |
| **R6-3** | R6-3a/b · D4 | **The bound on `ops.jsonl` was purchased with an unbounded `checkpoint.json`.** `compact()` calls `rememberBody` for every line it drops; `pruneSeqIndex` pruned `seqs`/`tsById` and **never touched `bodies`**; `bodies` is serialized into every checkpoint from then on. So the one file `saveCheckpoint` rewrites atomically on **every debounced save** grew with ops-**ever**-written rather than with the size of the board: measured at **6 000 fingerprints / 282 000 bytes** after 6 400 edits on a one-note board | `src/js/core/oplog.js` (`pruneSeqIndex`, new `boundBodies`) | **WP-3** | **fixed** |
| **R6-10** | R6-10a…f · D6 | **A bar edge that sorts INSIDE the rendered range had no faithful v2 value** — R5-11 closed only the two ends, and `coerceToV1BarEdge` returned `null` for everything between them, so the edge was dropped and a one-ended bar was anchored to the other end. Measured over 9 104 (text × field × grid) cases: **2 414 painted the wrong columns.** A separate half, **R6-10e**, crossed the axis the enumeration left at `string`: `coerceToV1Date` accepts the **integer** `20260304`, every comparison a number makes against a date string in `layout.js` is `NaN`-false so v1 painted **all twelve** columns, and v2 painted 10 (`startDate`) / 3 (`endDate`) and wrote `"2026-03-04"` into `board.json` | `src/js/core/migrate1to2.js` (`isV1BarEdge`, `coerceToV1BarEdge`, the alphabet), `src/js/core/replace.js` | **WP-3** | **fixed** |

- **A3-H1** — the asymmetry is the point: `storage.loadCheckpoint()` catches a JSON parse error and
  returns `null` (safe — R3-36 pins that an unparsable checkpoint lets the board through
  untouched), while one that *parses* reaches `deserializeRegisters` and throws
  `RegisterError: unknown format version undefined`. **Unparsable is safe; parsable-but-wrong is
  fatal.** There is no try/catch around `_log.load`, so `ready` stays `false`.
  → `tests/attack/round3-persistence.test.js` R3-35.
  **FIXED.** `_useLog()` wraps `_log.load({checkpoint, tail})` **and the consistency check itself**
  in try/catch; anything thrown on the way in becomes `quarantine('unreadable-log')` and the board
  loads from `board.json`. `ready` is always `true`. Independently falsifiable from A3-C1: removing
  just the try/catch reddens R3-35 and R3-35b, and the C-1 check alone does not cover it.
  The `MaterializeError` from a *poisoned `board.json`* is **deliberately not** swallowed here —
  the catch is kept tight around the log — and is now its own row, **I-2**.
- **A3-H2** — the five: a note whose date is not ISO (`4.3.2026`), a note with no date, a note with
  no id, a bar with no `endDate`, a scratchpad holding a number. The register usually still exists,
  but **in solo mode `board.json` IS the checkpoint**, so the next launch re-migrates the file and
  the register goes with it; `snapshots.json` cannot help (it stores the emptied `_persisted`).
  Principle 6 fails at the retrofit seam. Two aggravations: **a repeating note stops repeating** —
  `repeatsYearly: 'yes'` is truthy in v1 so the birthday repeats, is not a boolean so v2 drops the
  key entirely, and `find.js`/`layout.js` then read it as falsy (same shape for `visible: 'ja'` on a
  category); and **`store.warnings` has no consumer** (F-8), so the layer knows exactly what it lost
  and has no way to say so. → `tests/attack/round3-doors.test.js` R3-26/27/28.

  **FIXED — the PO decided COERCE (§4.2), and it is coerced to *v1's* meaning, not to a guess.**
  New §4b in `migrate1to2.js`, imported wholesale by `replace.js` so the two doors cannot drift:

  | helper | what v1 did, established from the v1 code rather than assumed |
  |---|---|
  | `coerceToV1Bool` | The two carried booleans **do not read alike**, so neither is guessed — both are *probed* through the v1 expressions this tree still carries (`V1_BOOL_READING`). `cat.visible` is `c.visible !== false` (`layout.js:111`), so `'ja'` **and `0`** stay visible; `note.repeatsYearly` is `if (!n.repeatsYearly)` (`layout.js:71`), so `'yes'`/`'nein'` repeat and `0` does not. **A `Boolean(v)` shortcut gets `visible: 0` wrong** — and that shortcut is one of the mutants in §7. |
  | `coerceToV1Date` | Reads only shapes that name exactly one day: `2026-3-1`, `2026-01-01T09:00`, `4.3.2026` (D.M.Y — this is a German product), `2026/03/04`, `20260304`. **Refuses** `3/4/2026`, `2026-13-45`, `''` — those keep the entry and lose the field. Format-checked only, so `2026-02-30` still passes (ADR 001 §12.8). |
  | `coerceToV1Id` | `id: 7` → `'7'`, applied to the entity id **and** to every `categoryId` pointing at it — coercing only one would silently re-parent that category's entries to the fallback. |
  | `mintedId` | A missing id is derived from `canonicalJSON(entry)` + an occurrence counter: deterministic across both Macs and both doors, and the counter is what keeps two byte-identical id-less notes apart — the collision the old "never invent an id" comment cited as its reason to drop. |
  | `missingBarEdge` | v1 draws an end-less bar to the far edge of the **visible window** (`layout.js:133-135`), which is a function of TODAY; a clock-reading migration breaks R12, so the bar is anchored to the edge the file **does** carry. |
  | `notDrawnReason` | Replaces the "will not be renderable" **loss** with a non-lossy "on the board, not drawn on any day" — which is exactly what v1 did with it. |

  `entities.js` is where *keep the entry* is enforced: `state.notes` is v1's **array**, and the
  date decides which day row draws a note, not whether it exists. An **own** note is renderable
  when it has a *text*; an own bar always is. Three things deliberately did **not** move: a
  **cleared** text still takes an own note off the board (ADR 004 §5.1 withdrawal); the **foreign**
  path is untouched (`has(date) && (belegt || has(text))`, and every word about not inferring
  meaning from absence is about that path); and a **repeat with no anchor** stays out, because
  `layout.js:72` does `Number(n.date.slice(0,4))` and takes the whole board down — v1 has no
  rendering of that shape to preserve, only a crash. Both doors also refuse to mint it.
  ADR 001 §5 step 3 is **amended** to say so.

  **Rows inverted:** R3-26 (+ new R3-26b field-by-field, R3-26c the door policy), R3-28, 17 rows in
  `upgrade-day-migration.test.js`, §2 of `upgrade-day-restore.test.js`. **R3-27 is NOT inverted and
  must not be** — it is F-8, and closing A3-H2 makes it *more* important: every coercion is on the
  warnings channel and nothing reads it.
  **Corpus widened** (`tests/helpers/gen.js`), six new ugly classes, each declared in
  `uglyShapesIn` so P14 fails a sanitised generator; observed frequencies in §6.
  **Mutants (§7): nine, one per value class, plus two that revert the IMPORT door only — P13
  caught both**, which is the property that says the two doors are one door.
- **A3-H3** — one missing guard, not a design gap. The refusal set is built defensively
  (`verdict.rejected.map((o) => o && o.id)`) and `op.id` is then read **unguarded** in the very next
  loop. Every *other* malformed shape (`{}`, `'string'`, `42`, `[]`, `true`) is refused with a
  warning and no throw. → R3-23 / R3-24.
  **FIXED.** A **shape pass** now admits only `{id: non-empty string}` objects and warns per
  refusal; a non-array argument warns and returns; `foldAuthorized` is wrapped (a gate that cannot
  reach a verdict **refuses** the batch rather than admitting it ungated); `verdict.rejected` /
  `verdict.rejectionOf` are guarded; `_log.append` is wrapped. **One malformed entry now costs
  that entry only.** R3-23 → `FAILED (held)`, plus new **R3-23b** for the siblings.
  **One of those "siblings" was not a defect at all**, and the mutation pass is what proved it:
  the `try/catch` added around `_clock.observe(op.ts)` killed no test, because `ops.js:validateOp`
  refuses a non-stamp `op.ts` and `foldAuthorized` therefore rejects it before the clock is
  touched. Ten hostile stamps were driven through the door and none reached it. The catch is kept
  as belt to that braces, but **what R3-23b asserts is the reachability claim itself** — the gate
  refuses each by name — so if a future gate change ever lets one past, the row goes red and the
  catch stops being redundant. That is the only honest way to pin code whose value is that it is
  currently unreachable.
- **A3-H4** — `store.js`'s own header claims "two Macs opening the same board agree byte for byte".
  Half true: the **stamps** agree, the **authors** do not, so `serializeRegisters()` is not
  byte-identical and the header's claim is false as stated. Worse, `foldAuthorized` degrades ADR 001
  §4.0's personal-space device check to `act === me` when `myDevices` is absent, so nothing merges.
  **Any fleet test that mints its ops with the receiving store's own `_me` is a false green.**
  ADR 002 §2.2's durable identity must land first. → R3-40/41.
  **What `authz.js` needs from it**, now that F-10 is closed and this is the next WP-6 gate:
  (1) a **durable `ctx.me`** — stage 0b's personal/local branch rejects `notMyAct` on
  `op.act !== me`, and `member:<M>` keys (and therefore where `dev.*` registers are housed) are
  unstable too, so write-once binds nothing across restarts; (2) a **durable `op.dev`** whose
  `deviceShort` is the one the stamps carry (ADR 002 §5.2.2 check 4 is `devOf(op.ts) === env.dv`);
  (3) **`ctx.myDevices` actually supplied** — it is optional today and the check degrades to
  `act === me`. Once identity is durable, (3) is *derived* (`attestationOf` filtered by
  `memberId`), needs no new plumbing, and removes the degradation.
- **I-1** — v1's `replaceAll` was `this.state = migrate(next); … persistNow()` and **could not
  throw at all**. LZP-402's is `migrate → planReplaceAll → append ops → state = blank →
  _project → persistNow`, and the window between the blank and the projection holds the user's
  entire board. `planReplaceAll` throwing is safe (it lands above the blank — pinned); `_project`
  throwing is not: `state` is left `{schemaVersion:1, notes:[], bars:[], categories:[],
  scratchpads:{}, settings:null}`, `emit('replace')` is never reached so **nothing on screen
  changes**, and 700 ms later the debounced autosave writes that blank over `board.json`.
  `restoreSnapshot` goes through the same door, so **11.5 — the safety net — is itself a way to
  lose the board**. The fix is ordering, not a bigger catch: project into a candidate and swap
  only on success. → `tests/attack/upgrade-day-restore.test.js` §1, six `DEFECT` rows.
- **I-2** — the same class as A3-H1 and a different input. A `board.json` whose `settings` make
  the projection refuse (`pinnedMonthsRenderable`, `entities.js` §2b — and refusing IS right:
  `layout.js:25` would produce a NaN year and `holidays.js:51` would loop forever) throws
  `MaterializeError` out of `init()`. `ready` stays `false`, nothing is drawn and nothing says
  why. The file is **not damaged** (`flushSync` no-ops on a store that never became ready), so
  this is a white screen, not a data loss. A3-H1's catch was deliberately kept tight around the
  log rather than widened to swallow this, so the row stays green and honest until someone
  decides what the app should *show* here. → `upgrade-day-restore.test.js`, the last `HELD` row.

> ### A3-M5 / R5-4 — THE LOG STOPS RECORDING ON THE SECOND LAUNCH
>
> **This row is here because its severity was wrong, and the reason it was wrong is instructive.**
> It was filed as *"latent — nothing appends, so nothing grows"*: `_persistOps` never called
> `appendOps`, so `ops.jsonl` never existed, so it could not grow past `LS_OPS_CAP`. That reading
> looked only at the file that was missing. Round 5 looked at the ops.
>
> **What was actually happening.** The body was `saveCheckpoint(this._log.checkpoint())` +
> `truncateOps(0)`, and **both halves were inert**:
>
> - `checkpoint()` folds to `resolveHorizon(opts, 'read')` = `horizon ?? maxLiveStamp()`, and
>   `horizon` is **non-null for any log that has been `load()`ed**. So from the second launch
>   onward the persisted checkpoint was frozen at the horizon it was read with, and every op
>   minted since was above it and simply **not in the file**.
> - Nothing called `appendOps`, so the ops the checkpoint did not carry had **nowhere else to be**.
>   `truncateOps(0)` means "keep from the beginning", i.e. keep everything — harmless only because
>   the file it kept was always empty.
>
> **Three measured consequences** (R5-4a-d), none of them latent:
>
> 1. No op after the first persist was ever written to the log. WP-8's outbox — ADR 006 §9.2's
>    whole mechanism — had no producer.
> 2. **Every ordinary launch reconciled a growing number of "changes `board.json` carried that the
>    log did not (expected after a crash)"**, so ADR 006's happy path and its crash path were
>    indistinguishable *forever*. The diagnostic that is supposed to reveal a real crash was
>    permanently crying wolf.
> 3. Every entry created after the first persist was re-minted `_born: true` at a fresh stamp on
>    **every** launch — and ADR 001 §5 step 5 calls array order "MANDATORY, NOT COSMETIC", so an
>    entry's position on the board became a function of when the app was last opened.
>
> **THE FIX — the four steps ADR 006 §6 names, each of them checked rather than assumed:**
>
> ① **APPEND** what the coming checkpoint will *not* carry — `_uncommittedTailLines()`, which is
> the outbox exactly: not parked (parked lines ride in `checkpoint().parked` with the reasons
> `load()` cannot re-derive), not folded by the coming checkpoint, not already on disk. Keyed by
> opId **and body**, so an envelope splice is appended rather than mistaken for the line already
> written. ② **COMPACT** when the tail has grown past `TAIL_COMPACT_AT`, which is the only thing
> that advances the horizon and therefore the only thing that lets ④ ever drop a line.
> ③ **CHECKPOINT.** ④ **TRUNCATE, and only lines ③ already folds** — the condition is *checked*:
> if one admitted op is above the checkpoint's horizon, the tail is the only copy of it and the
> file is left alone. That is the half that makes a crash between ③ and ④ cost nothing.
>
> **One fix in `core/oplog.js` came with it**, and it is the subtlest thing in the round:
> `resolveHorizon(opts, 'advance')` now takes the **max** of `maxLiveStamp()` and `horizon`
> instead of `maxLiveStamp() ?? horizon`. One live line *below* the horizon — a late op (ADR 001
> §7.2), or a tail the checkpoint already folds after a crash between ③ and ④ — used to make
> `compact()` throw for the rest of that log's life, **permanently disabling the one call that
> bounds `ops.jsonl`**.
>
> **THE ACCEPTANCE CHECK — R5-4f**, written as a sequence because the defect was only ever visible
> as one: *boot · edit · restart · edit · restart*. It asserts two things that are not the same
> claim: (a) an ordinary launch reconciles **0**, and (b) an op minted in session N is on disk in
> `checkpoint.json` ∪ `ops.jsonl` and is projected back in session N+1. Without (b),
> `reconciled: 0` is satisfiable by a store that adopts nothing and diffs nothing. The first
> launch is pinned at `reconciled: null` (there is no log yet — *nothing to reconcile* is not the
> same as *reconciled nothing*), and a genuine crash still reports exactly **1**, so the quiet
> launches mean something.
>
> **Rows inverted:** R5-4a/b/c/d, plus **R5-4e** for the bound A3-M5 was originally filed under,
> and **R5-4f** added by the integration pass. **R3-39 is inverted too** — it was still asserting
> "`_persistOps()` never appends" as a live defect, and its file header's claim that "`store.js`
> never writes `ops.jsonl`" is corrected to the narrower one R3-38 actually pins. A new tier-1 row
> in `core-oplog.test.js` pins the `resolveHorizon` half. **Mutants (§7):** rows 31-35.
>
> **Not implemented, and recorded rather than glossed:** ADR 001 §7.2's "30-day tail for
> debuggability" is *not* honoured — the compaction is total, because `truncateOps` can only drop
> a prefix and the store does not track which file line an op is on. The 2 MB-at-launch trigger is
> also absent. Both are in ADR 006 §8.5 and in the `TAIL_COMPACT_AT` docblock.
> **Round 7 closed both halves, in opposite directions — see R6-2 and R6-3 below.**

> **R6-4 — FIXED 2026-08-27 (round 7). Two independent defects wearing one number**, and either
> fix alone leaves the other's cell wrong, so they are two code changes with two mutants.
>
> **(A) The blast radius.** `_clockSkew` now walks `ops({liveOnly:true})`. ADR 006 §12.6's *"mint
> above every stamp the log carries"* is a statement about the stamps a **mint will be compared
> against**, and round 5 read `carries` as *holds a line for*. The domain is now written as a
> **table over what a stamp decides**, in the docblock, and the code is nothing but that table:
> register cells **yes**, `checkpoint.horizon` **yes**, live lines **yes**, **parked lines no**,
> rejected ops unreachable. **There is nothing for a mint to be above when the op is in no
> register.** `_observeEveryStamp` deliberately keeps `includeParked:true` and the docblock now
> says *why the two functions differ*: `clock.observe` declines anything past the window on its own
> (`core/stamp.js:167`), and a parked line **inside** the window (the five non-`future` reasons) is
> one this build may promote after an update.
>
> **(B) The ordering.** `applyRemote` calls `foldAuthorized(…, {me})` with **`nowMs` withheld**.
> `ctx.nowMs` has exactly one consumer in the whole authorization fold — `classifyOp`'s 24 h clamp
> (`core/ops.js:502`; it appears nowhere in `core/authz.js`) — so passing it made `foldAuthorized`
> short-circuit a future-stamped op into `parked` **before any authorisation stage ran**, and it
> never entered `verdict.rejected`. Withholding it moves nothing else; the park stays where it
> belongs, in `_log.append`, which classifies against its own `now()`. **`core/authz.js` was not
> touched.**
>
> **What is left reachable is exactly what R5-2e described.** A stamp only reaches a register by
> having been *inside* the window when it was written, so a register 48 h ahead means the **local
> clock has moved backwards** — a corrected NTP step, a restored VM, a hand-set date. The detail
> now says that instead of accusing a Mac that may be fine.
>
> **Rows inverted:** R6-4a, R6-4b, R6-4c in `round6-record.test.js`. **R6-4a/R6-4b also had a
> latent bug of their own**: they minted with the kit's default `act` (`ME ≠ v2store._me`), so they
> were probing the **foreign** cell while claiming to probe *own*. Re-minted with
> `actAs: v2store._me` — otherwise the `own` column was never tested at all. **Controls:** R6-4d
> (a 12 h stamp reconciles perfectly) and the new **R6-4e** — `clock-skew` still fires on its real
> input, a checkpoint in the shape a Mac whose clock ran fast and was corrected leaves behind.
> Without R6-4e the three inverted rows are all "nothing bad happens" and are equally satisfied by
> **deleting** `_clockSkew`. **Domain:** all 44 D2 cells and all 5 D3 cells now hold; `D3-p5` —
> *parked before authz ran*, the class that must not exist — is empty. **Mutants (§7):** F2, F2b.
> **ADR 006** §7's `clock-skew` row, §7.1, §12.6 rule 6 and INV-18 all said *"every stamp the log
> carries"* / *"the log's newest stamp"*, which is the exact wording round 6 walked in through.
> All four now say **LIVE**.

> **R6-3 — FIXED 2026-08-27 (round 7), as a CAP and not a PURGE.** `pruneSeqIndex()` ends in a new
> `boundBodies()`: oldest-first eviction (Map insertion order = absorption order) to
> `BODY_FINGERPRINT_CAP = 1500`, **never evicting an id that still holds a line**. Measured: 6 400
> edits on a one-note board go from **6 000 fingerprints / 282 000 bytes to 1 500 / 75 000**, flat
> thereafter.
>
> **Round 6's own proposed one-liner — prune `bodies` by `keepIds` — is wrong, and measuring it is
> what proved it.** It does not "put A1 back"; it does not change state at all. What it destroys is
> ADR 002 §5.1's tamper evidence for every absorbed op that no surviving register attributes, plus
> the cross-restart dedupe index. It is mutant **F1**, and the row that kills it (**R6-3c**) had to
> be written against a **superseded** op — written against the winner, every version of that test
> was green under the mutant.
>
> **Measured at integration, 10 sessions × 400 edits on a board that never grows:** the checkpoint
> is **5 996 B** while `bodies` is empty, steps to **75 000 B** at the first compaction that fills
> it, and is then **flat to within 1 byte across sessions 5…10** while ops-ever goes 2 000 → 4 000.
> The control — the same 4 000 ops on boards of 1/5/25/100/400 notes — holds `bodies` at the cap in
> every row, so the whole of the variation is the register, i.e. **the board**. The honest statement
> of the bound is therefore *`checkpoint ≈ O(board) + O(min(ops-ever-compacted, 1500))`*: bounded,
> flat, and no longer a function of ops-ever — with a **constant ceiling of ≈75 KB** that a 1 KB
> board pays in full once it has been edited 1 500 times. That constant is accepted, not
> overlooked: §7d's D4 domain pins it and `BODY_FINGERPRINT_CAP === min(5000, floor(LS_OPS_CAP ×
> 0.75))` is a tier-1 row, so drift is a red test.
>
> **Rows inverted:** R6-3a, R6-3b. **Added:** **R6-3c** (cap-not-purge, on a superseded op).
> New tier-1 rows in `core-oplog.test.js`: the cap curve plateaus; the live-line guard; and
> evict-vs-keep **convergence** — two logs, identical op sets, opposite caps, identical registers.
> **Mutants (§7):** F1, F1b, and the two that kill the live-line guard and the cap constant.
> **ADR 001 §7.2** amended: the `bodies` block's *"≈400 KB/year … pruned only for entities
> collected by the §7.3 tombstone GC"* was a growth rate with **no ceiling** — now the bound, the
> eviction policy, what an evicted fingerprint costs, and why the `keepIds` prune is a different
> trade.

> **R6-10 / R6-11 — FIXED 2026-08-27 (round 7), and the below/above/inside SPLIT is what was
> wrong.** `DATE_RE` accepts a finite, **totally ordered** set, so every text has a floor and a
> ceiling in it — two binary searches over an index space that is never materialised. v1 makes
> exactly four comparisons on a bar edge; `floor(t)` reproduces every `<` and `ceil(t)` every `>`.
> Hence **one rule for all three classes**:
>
> > **take the floor unless it is a last-of-month, then the ceiling unless it is a first-of-month.**
>
> The two ends fall out unchanged (below: no floor, ceiling = `EARLIEST_DATE`; above: no ceiling,
> floor = `LATEST_DATE`), so R6-9a/b/c/d are untouched **by construction** rather than by care.
>
> **Two corrections the fix made to the work order, both measured.** (i) The enumeration's revised
> §4.6 claim — *`startDate ⟶ smallest ISO ≥ t`, `endDate ⟶ largest ISO ≤ t`* — is exact for the
> test that decides **which columns** and wrong for the **chevron** test: `'2026-03'` as a
> `startDate` is **`'2026-02-31'`** (a member — `DATE_RE` does not check the calendar), not
> `'2026-03-01'`. (ii) **One class has no member at all**: a text sorting strictly between a
> 31-day month's last day and the next month's first — `'2026-3-1'`, `'2026'`, `'2026/03/04'`,
> `'20260304'`, `'2026-13-01'`. Verified independently at integration: for each of those five the
> floor is a `…-12-31` and the ceiling a `…-01-01`, so **both candidates fail their guard** and the
> class is genuinely empty. There the tie goes to the skip test and exactly one continuation
> chevron moves.
>
> **R6-10e is closed by a total rule rather than a branch: for a bar edge, `coerceToV1Date` is
> never consulted at all** (`isV1BarEdge`, applied on **both** doors). A note date is looked up by
> map equality, so *"what day does this name"* is the right question there; a bar edge is only ever
> compared, so it is not.
>
> **Numbers**, over 9 104 (text × field × grid) cases — every month boundary of 2024-2028 in eleven
> malformed shapes, plus 500 pseudo-random ugly strings, on four pinned years:
>
> | | exact | same-columns | **wrong columns** |
> |---|---|---|---|
> | before | 5 220 | 1 470 | **2 414** |
> | after | 8 320 | 784 | **0** |
>
> **Per-field ruling on the zoned datetime, made in code (R6-11b):** finding 6's refusal stands for
> a **note date** — *"which day is this"* has two answers and honouring the offset smuggles a
> timezone into a format that has none. For a **bar edge** the question is never asked; the floor
> is a position, not a reading. `'2026-04-01T23:00:00-05:00'` as a `startDate` is 9 columns in v1
> and now 9 in v2 (was 12); as an `endDate` 4 and now 4 (was 12); on a note it is still refused.
>
> **Rows inverted** in `round6-coercion.test.js`: R6-10a/b/c, R6-11a/b (R6-10d kept as the class
> contrast). **Added:** R6-10e, R6-10f (both doors agree on the same bytes, via `planReplaceAll`),
> R6-11c (the no-member class, named and measured — this is the emptiness proof), R6-11d (an
> ~880-pair boundary sweep asserting the column set is never wrong). In `round5-coercion.test.js`
> — **not the fixer's file, but the fix reddened it and it had to be inverted rather than left
> broken** — R5-11g, R5-12b and the second half of R5-12e. **Mutants (§7):** F7, F7b, F7c, and the
> one that makes `coerceToV1Date` reachable from a bar edge again.

### MEDIUM

| id | aka | one line | file:line | owner | status |
|---|---|---|---|---|---|
| **F-5** | F-5 | `checkpoint.json` is deserialised straight into the register map with **no admissibility fold at all** — it can install `visibility:'geteilt'`, `coEdit:true` and a foreign author on an entry the user never shared | `src/js/core/oplog.js:846`, `src/js/store.js:476` | **WP-8** | open |
| **F-6** | F-6 | A remote op whose device attestation has not arrived yet is **rejected, not parked**, then dropped without being appended — silent data loss on first contact and on every partial pull | `src/js/store.js:699-703`, `src/js/core/authz.js:671` | **WP-8** | open |
| **F-7** | F-7 · M-2 | A remote `pref.set` is admitted (ADR 001 §3.3: `local` is "never synced"), `applyRemote` has **no space filter**, and the registers and `state.settings` then disagree about row height and about **which Feiertage layer is drawn** | `src/js/store.js:542-566`, `:690-708`, `src/js/core/authz.js:672-675` | **WP-8** | open |
| **F-2** | F-2 · M-1 | The `apply()` door **throws** on 27 of 36 hostile field values where the `mutate()` door truncates-and-warns — in **two** error classes, `OpError` and `EntityKeyError` | `src/js/core/ops.js` (`MUTATIONS`, `makeOp`), `src/js/core/entities.js`, `src/js/store.js:206` vs `:672` | **WP-8** | open |
| **A3-M3** | M-3 | A **nested** `mutate()` spends one ⌘Z on two actions, and the R5 shadow guard then throws *after* the ops are appended and *before* `schedulePersist()`/`emit()` — board changed, unsaved, un-redrawn | `src/js/store.js:642-653`, `:756-766` | **WP-4** | open |
| **A3-M4** | M-4 | A throwing `mutate()` callback's half-edit is adopted into the log **permanently** by the *next* action, with no undo step that can reach it | `src/js/store.js:586-594` | **WP-4** | open |
| **A3-M5** | M-5 | *(moved to **HIGH** — round 5 proved it was not latent. See the HIGH table.)* | | | **fixed** |
| **F-10** | Part C | `foldAuthorized` returns `memberOfDevice(deviceId)` and **discards the decoded attestation payload**, so `openOp` cannot perform ADR 002 §5.2's checks — **the concrete WP-6 unblocker** | `src/js/core/authz.js:650-663`, `:853-854` | **WP-6** | **fixed** |
| **I-3** | new | *(escalated to **HIGH** and moved to §4.5 — round 5 (R5-7) turned this into a permanent remote mute of any named device, self-authorizing and irrevocable.)* | `src/js/core/authz.js` stage 0a | WP-6 | **fixed 2026-08-28** — §4.5 (a) |
| **R5-11** | R5-11 | An **unreadable bar edge** is dropped, and a dropped edge is anchored to the other end — so a bar v1 painted **nowhere** is painted by v2 across every column to the horizon, with chevrons, taking a lane from bars that are real | `src/js/core/migrate1to2.js`, `src/js/core/replace.js`, `src/js/core/entities.js` | **WP-3** | **fixed** — residual §4.6 **closed by R6-10/R6-11** |
| **R6-11** | R6-11a/b/c · D6 | The **inside** class of R6-10, and the ruling that closed it: one rule over the whole alphabet rather than a three-way split, plus the per-field answer for an ISO tail carrying a **zone offset** — refused on a note date, taken as a position on a bar edge | `src/js/core/migrate1to2.js:719-748, :893` | **WP-3** | **fixed** |
| **R6-7** | R6-7a/d/f · D5 | **The reconciler could not mint a position, so a restore moved the entry.** `diffCollection` asked one question — *is this id in `before`?* — and answered `born: true`, which writes `_born` = the op's own **fresh** stamp, and `_born` is the array-order sort key (ADR 001 §8.1). So restoring an older `board.json` over a log that had tombstoned an entry put the entry back **at the end of the list** instead of where the user had it, and an entity the log had never heard of landing in the **interior** of the order was sorted last | `src/js/store.js:258-470` (`diffCollection`, `cellsInLog`, `bornOfCells`, `bornBetween`) | **WP-3** | **fixed** |
| **R6-6** | R6-6a/b · D1-r3/r4/r5 | **The inverse of R5-3's caution: the recovery branch refusing to recover when recovery was right.** §5.5's precondition is about the **input** (`absent` + a log is there); it says nothing about the **outcome**. A log that would not **load**, and a log that loaded and asserted **nothing**, both fell out of `_recoverFromLog` as an **empty, WRITABLE** board with `_recoveredFrom === null` — which the first autosave then committed — while `store.snapshots` held §5.6's own stated answer, loaded two statements earlier and never read | `src/js/store.js:1458-1600` (`_recoverFromLog`, `_bootRecoveryFailed`, `_standIn`, `_logAssertsNothing`) | **WP-3** | **fixed** |
| **R5-5a** | R5-5a | The reconciler walks `COLLECTION[].fields`; the R4 post-condition walked **the same list**. A field outside it — `_born`, which decides user-visible **array order** — could be neither minted nor checked | `src/js/store.js` (`v1ContentOf`, `postConditionDetail`) | **WP-3** | **fixed** |
| **R5-5b** | R5-5b | …and the same hole swallows a field `board.json` **cannot express at all** (`visibility`, `coEdit`, `defaultVisibility`, a foreign `ownerId`): no post-condition written in terms of `board.json` can see it | `src/js/store.js`, `src/js/core/oplog.js` | **WP-8** | open (bounded — ADR 006 §8.4) |
| **R5-2e** | R5-2e | ADR 006 §12.6 ("reconcile so the post-condition holds") and ADR 001 §1.3 (no stamp beyond `MAX_FUTURE_DRIFT_MS`) are **jointly unsatisfiable** when the machine's clock is behind the log's newest stamp — and the loser was the user's entire history | `src/js/store.js` (`_clockSkew`, `_sequesterQuarantine`), ADR 006 §12.6 | **WP-3** | **fixed** |
| **R5-2g** | R5-2g | A Time-Machine restore of a **pre-lineage** `board.json` beside a current log destroys the log: the restored board carries no `_v2`, so `adoptable` refuses on `board-carries-no-lineage` and the history is quarantined | `src/js/store.js` (`adoptable`) | **WP-3** | open |
| **I-5** | new | A `board.json` whose `settings` nest a few thousand deep flattens into ONE register name with a few thousand dots; the projection rebuilds it iteratively and survives, and `_project`'s `structuredClone(state.settings)` then **overflows the stack out of `init()`** — outside every door, `ready === false` | `src/js/core/ops.js` (`flattenPref`), `src/js/store.js:859` | integration | **fixed** |

- **F-5** — `store.applyRemote` gates at admission *precisely so* "`registers()` stays the authorized
  fold and the checkpoint keeps its meaning" (`store.js:684-687`); the checkpoint is the one input
  that never passes through that gate, and `init():467` short-circuits migration on `hasLog` so the
  planted state is authoritative. This is **the second hole in 16.1** (the four minting doors are
  all clean — §5). Today it needs a local file write (T3, accepted for *reading*); the difference is
  that it converts a local file write into **family exposure** on the next publish. **Fix before
  WP-8's publisher reads truth registers.** → conformance probe p6 test 2.
- **F-6** — ADR 001 §2 explicitly has no causal delivery, so a member's first content op arriving
  before their attestation op is the **normal case**, not an attack. This is `PARK_REASONS`' whole
  purpose (§7.4: parking "makes an old client degrade to *does not show* instead of *loses*") and
  there is no park reason for it. Fix = a new `ATTESTATION` park reason in `ops.js:298`, or retain
  refused ops in the log. ADR 001 §4.0/§7.4 and ADR 002 §5.2.5 were amended 2026-08-27 to require
  the park. → conformance probe p4.
- **F-7** — `_project()` deliberately does not re-derive `state.settings` and `applyPrefOps()` runs
  only inside `_commit()`, so the remote path calls neither. In solo mode `board.json` wins at the
  next launch and the change is silently **discarded**; once `checkpoint.json` exists the checkpoint
  wins and the row height and the drawn layer change under the user **with no gesture behind them**.
  The same disagreement is reachable locally (R3-5) through `setSettings({layers})`'s preserved v1
  wholesale-replace quirk — latent, because all 12 shipping layer writes go through `setLayer`,
  which merges. → probe p6 test 1, R3-3/4/5.
- **F-2** — the original filing named the over-length case, which is **4** of the 27 rows. The rest
  are not exotic: a German date, an unpadded date (`2026-3-1`), a numeric date, an empty
  `categoryId`, an empty entity id, a stringy boolean, a `visibility` outside the enum, a month that
  does not exist, a non-month scratchpad key, a language that is not `de|en`, a category reassigned
  to itself, a `null` id in a delete-reassign fan-out. Every one is a value a hand-edited file, an
  import or a peer can supply. **A caller that wraps the door with `catch (e) { if (e instanceof
  OpError) … }` misses the seven `EntityKeyError` rows.** The two doors also disagree about the same
  bytes — `fitValue` truncates and warns, `makeOp` refuses — already observable at the import door,
  not only on a future wire. Three silent *accepts* found by the same enumeration are a decision:
  §4.3. → R3-20/21/25.
  **NARROWED, not closed, by the A3-M1a ruling (§4.3).** "Never throw on externally-sourced input"
  is now met at every door an outsider can actually reach — `migrateV1`, `planReplaceAll` and
  `applyRemote` all refuse-or-coerce and warn, pinned by R3-26c on eight hostile board shapes
  through **both** doors. `store.apply()` is an **internal** call site: the 22 UI sites are the
  only callers, no file and no peer reaches it, and under the ruling a throw there is programmer
  error and is allowed. What is left of F-2 is therefore smaller and still real: **the same door
  throws on 27 inputs and shrugs at 3**, in two error classes, and that is one rule short of
  being a rule. Owner stays WP-8, because that is when the wire arrives.
- **A3-M3** — the second half is the sharper finding. `store.undo()` is
  `append → _project() → verify() → schedulePersist() → emit()`. When the guard fires, the inverse
  ops are already in the log, `state` has already moved, the stack has already been popped, and
  neither `schedulePersist()` nor `emit()` is reached. **A DEV-only diagnostic that leaves the app
  in that state is worse than the mismatch it found.** `verify()` belongs before the append, or the
  throw belongs after `emit()`. No shipping site nests today, but `mutate()` is a supported door
  (ADR 005 §2.2, amended) and WP-2's oracle calls it 60 times. v1 is wrong here too, differently, so
  there is no parity argument for keeping it. → R3-11 / R3-11b.
- **A3-M5** — verified identical on all three backends (`dropFirst(0)` in Swift, `skip(0)` in Rust;
  the Rust half is read, not run — no toolchain on this Mac). The intent was
  `truncateOps(tail.length)`. Consequences once WP-8 turns the branch on: ADR 001 §7.2's compaction
  never shrinks anything and startup stays O(log) forever, and the ops minted in a session live
  **only** inside `checkpoint.json` — fine for state, fatal for a sync outbox that needs the ops.
  → R3-39, and the re-anchored fourth row of `upgrade-day-crash.test.js` (the quarantine path no
  longer reaches `_persistOps`, so that row now measures A3-M5 **on a trusted log**).
- **F-10 — FIXED.** `parseAttestationBlob` returns the full ADR 002 §2.3 `DeviceAttestation`
  (frozen). **All six fields are required**, and that is a deliberate tightening: §5.2.2's
  pre-decrypt gate is unrunnable without `sigPubRaw`, so a blob missing one is not a partially
  useful attestation, it is a credential `openOp` could only throw on — its op is rejected
  `badAttestation` rather than admitted into a table with a hole in it. Unknown **extra** fields
  are ignored (v2.1-attestation-on-v2.0-client skew). The register walk keeps the payload;
  `AuthzResult` gains `attestationOf(deviceShort)` and `shortCollisions`; `snapshot()` renders the
  table so P5 covers *which* attestation each short resolves to. `ctx.attestOpen(memberId, blob)`
  is accepted per ADR 001 §4.0 / ADR 002 §5.2.3, and **the payload always comes from the register
  bytes** — an `attestOpen` whose answer disagrees counts as a failed verification, otherwise the
  injected function is a second, unlogged source of device identity. No throws added:
  `attestationOf(junk)` returns `null`, because `env.dv` is peer-sourced.
  §2.3's **four acceptance conditions were all already enforced** and had **no individual tests**,
  so three of them could have been deleted in silence; each now has one, and each is separately
  falsifiable (§7). `attestedDevices` / `memberOfDevice` were **not** removed — they have live
  callers in two attack files — but are marked in `ops.contract.js` as derivable from
  `attestationOf`, "do not add new ones", removal owned by WP-6.
  One pre-existing test was **green for the wrong reason** and is fixed: it used `short16('OTHER')`
  as the disagreeing short, and `O`/`U` are outside the Crockford alphabet, so it never reached
  condition (2) at all.
- **I-3** — §2.3 justifies the single-key lookup by arguing two members would need the same
  signing *private* key. Nothing pure and synchronous can check
  `crock32(SHA-256(sigPubRaw)[0..10]) === att.deviceShort` — that is §5.2.2's **P2**, and it lives
  in `openOp`. So a member can mint an attestation under a peer's short that passes all four
  acceptance conditions and, **backdated**, win the lookup, because the contest resolves
  minimal-under-`≺`. Stage 0b is unaffected (the device gate is per-member) and P2 then refuses
  the envelope — but the fold must not pretend the collision did not happen, hence
  `shortCollisions` on the result. **WP-6's `attestOpen` should enforce the P2 binding at fold
  time**, which closes it at the root. Characterized at `tests/tier1/core-authz.test.js:658`,
  including five shuffles proving both devices resolve the short identically.
- **I-5 — FIXED**, and found by proving something else. The two **doors** already survived a
  `settings` nested thousands deep (`flattenPref`'s recursion overflows, both doors catch the
  `RangeError` alongside `OpError`, the key costs one key). The crash was one layer up and
  **outside every door**: at a depth where the recursion does *not* overflow, the flatten succeeds
  and mints one register name with two thousand dots, `prefsFromRegisters` rebuilds the nesting
  iteratively and survives, and `store._project`'s `structuredClone(this.state.settings)` throws
  `RangeError` out of `init()` with `ready === false`. **The non-monotonicity is why one test
  depth would have been a false green**: on the same build, depth 2000 crashed, 4000 was caught by
  the door, 6000 crashed again — where the overflow lands depends on how much stack the caller
  already used. Closed with **two locks**: `ops.js:PREF_MAX_DEPTH = 32` refuses to *mint* a name
  that deep (an `OpError`, which both doors already turn into a warning and a dropped key, and a
  throw from `settingsSet`/`layerSet`, which are internal), and `materialize.js:prefsFromRegisters`
  refuses the same depth on the way back *out*, so a name that arrived from a **checkpoint** (F-5 —
  the one input with no admissibility fold) or from a peer cannot build the projection either.
  Both locks are independently falsifiable (§7). The frozen v1 store still throws at every one of
  those depths, so this is a place v2 is now **strictly better** than v1 rather than equally bad —
  which matters, because "v1 does it too" was the only argument for leaving it.

> ### R5-11 — THE COERCION CLASS: A BAR v1 DREW NOWHERE, DRAWN EVERYWHERE
>
> **The rule the fix turns on, and it is not the obvious one.** v1 never *parses* a bar edge — it
> **compares** it (`layout.js:133-135`). So the faithful v2 value for an unreadable edge is not
> "the day this text means" (it means no day at all) but **"a date that sorts where this text
> sorted"**. For the two classes where such a date exists — text outside `DATE_RE`'s alphabet —
> it is the **end** of that alphabet.
>
> **What v2 did instead.** The edge failed `coerceToV1Date`, so the *field* was dropped; a bar
> with one end is then anchored to the other (R4-10, correct on its own terms); and the bar runs
> to the horizon. `endDate: ""` — the single commonest hand-edit there is — turned a bar v1 drew
> **nowhere** into a bar drawn across every column, with `contBot`/`beyondEnd` chevrons, **taking
> a lane from bars that are real**. Two entirely reasonable behaviours composing into a wrong one.
>
> **The fix.** `EARLIEST_DATE = '0000-01-01'` / `LATEST_DATE = '9999-12-31'`, declared next to
> `DATE_RE` because the claim they make is a claim *about* `DATE_RE`; a shared
> `coerceToV1BarEdge(kind, name, value)` — bar edges only, strings only, `< EARLIEST ⇒ EARLIEST`,
> `> LATEST ⇒ LATEST`, everything else `null`; wired into **both doors** *before* `coerceToV1Date`
> (which trims, so `' 2026-03-04'` would read as a good date there, and v1 painted it nowhere).
> A load-time assertion pins that both edges are still `date` fields.
>
> **Notes are deliberately untouched.** `layout.js:61-79` places a note by map **equality**, so
> absent and `'zzz'` already land on the same nowhere — and a substituted date on a
> `repeatsYearly` note would be *expanded* onto days the user never wrote.
>
> **The warning was wrong too** (R5-11b), in the direction that matters: `gridPlacementWarning`
> printed *"that is exactly what v1 painted for it … nothing on your board moves"* for an edge the
> file **never carried**, which was true, and for one that was **dropped**, which was not. A
> `dropped` out-parameter now threads through both `buildPatch`es so the tail is printed only
> where it is true, and a `NOT DRAWN on any day` branch was added for a bar whose stored dates put
> it outside every column. **R5-11h** pins that the sentence is still printed where it *is* true.
>
> **Measured** (R5-11a/c/d/e/f, against `buildBoard`): `endDate ∈ {'', ' ', '-', '(offen)', '0',
> ' 2026-03-04'}` → v1 nowhere, v2 nowhere, `'0000-01-01'` in the file, entry kept.
> `startDate ∈ {'zzz', 'unbekannt', 'ab wann?'}` → both nowhere. Lanes are byte-identical to v1's.
> **R5-11e became an inversion rather than a control**: `'irgendwann'` matched v1's *segments* but
> not its chevrons — an absent edge raises none and `'9999-12-31'` raises all three — so the same
> fix closed a half nobody had measured.
>
> **The corpus is why this survived four rounds.** `generateUglyBoard` reached one side of the
> boundary only. It now generates **both** (`EDGE_BELOW` / `EDGE_ABOVE`, both edges) and reports
> them as **two separate classes** — a merged count would go green on a corpus that had quietly
> become one-sided again, which is exactly how this hid. §6b has the refreshed table; P14 enforces
> the 1% floor on both new classes. **Mutants (§7):** rows 36-41.
>
> **The residual is narrowed, not closed, and it is a PO question:** §4.6.

> ### R5-5a / R5-5b — THE RECONCILER'S FIELD LIST WAS ITS GUARD'S BLIND SPOT
>
> ADR 006 R4 is the rule that makes the whole design safe: *after reconciling, assert
> `content(project(log)) ≡ content(board.json)`; if it does not hold, quarantine.* **"Every
> conceivable failure of the reconciler degrades to history lost, content kept."** That argument
> is only as good as what `content()` can see.
>
> The reconciler is `diffCollection`, which walks `COLLECTION[].fields`. The post-condition was
> `sameV1Content` → `v1ContentOf`, which walked **the same list**. Any field outside it was
> invisible to *both*: it could not be minted, and it could not be checked.
>
> **`_born` is outside that list**, and ADR 001 §5 step 5 is explicit that it is not cosmetic —
> v1's capacity slice and its per-column lane rescue are order-sensitive, so array order is
> user-visible. A log that disagrees with `board.json` about `_born` therefore changed **what the
> user sees**, through a field R3 could not mint and R4 could not catch.
>
> **The two halves part company here, and that is the finding.** `_born` is `writeOnce`, so R3
> *cannot* be satisfied by minting the difference — but the order it decides **is** asserted by
> `board.json`, in its array order, so **R4 can refuse a log that disagrees**. That is R5-5a:
> `v1ContentOf` now emits `order[spec.key]` (the id sequence) alongside the id→field maps, and
> `postConditionDetail(theirs, mine)` says **which half** failed, so `reconcile-failed` names the
> order and `_born`'s write-once-ness instead of naming the post-condition it tripped.
>
> **R5-5b is the half that stays open, deliberately.** No post-condition written in terms of
> `board.json` can see a field `board.json` **cannot carry** — `visibility`, `coEdit`,
> `defaultVisibility`, a foreign `ownerId`. There is no clever version of the check that fixes
> this; the real answer is folding an adopted checkpoint through `applyRemote`'s admissibility
> gate, which is **F-5**, which is WP-8. ADR 006 §8.4's residual list was a two-item prose aside
> and is now a four-row table naming how each is bounded. R5-5b's attack row stays green because
> the defect is still there. **Mutants (§7):** rows 42-43.

> ### R5-2e — TWO NORMATIVE RULES THAT COULD NOT BOTH BE OBEYED
>
> ADR 006 §12 rule 6 said *reconcile so the post-condition holds*. ADR 001 §1.3/§7.4 says *no
> stamp beyond `MAX_FUTURE_DRIFT_MS` into the future*. Put the machine's clock behind the log's
> newest stamp — a dead RTC battery, a laptop opened in another timezone, a restore — and
> reconciliation must mint above a horizon the clock refuses. §12.6 loses, and the way it lost was
> the whole finding: the reconcile threw, the log was quarantined `reconcile-failed`, **and the
> files were renamed away**. The user's entire history, destroyed by a wrong date.
>
> **THE FIX is a deferral, not a repair**, because the condition is *expected to stop being true*:
> `_clockSkew(log, checkpoint)` is asked **before** reconciliation is attempted at all, and
> quarantines `clock-skew` when the log's newest stamp is beyond the drift window. The detail
> names **the clock**, both dates, the number of hours, and the 24-hour rule, and says plainly
> that the log is not being discarded. `DEFERRED_QUARANTINE` makes `_sequesterQuarantine` **refuse
> to move a deferred log aside**, so the files keep the names the next launch looks under, and
> `quarantine.deferred === true`.
>
> **The ADR was corrected, not the code alone**, which is the part that keeps this closed: ADR 006
> gains **§7.1** (the two rules, and why §12.6 loses), `clock-skew` joins §7's reason table, and
> **§12 rule 6 is amended** to *"a precondition for adoption, not an instruction to try"*. **ADR
> 001 §1.3/§7.4 is left exactly as it was** — it is the rule protecting something real, and the
> one that had to give was the one asking for the impossible. The row asserts the 12-hour
> non-vacuity control first, and proves the same log is adopted with `reconciled === 0` once the
> skew is inside the window. **Mutants (§7):** rows 44-45.

> **R6-7 — FIXED 2026-08-27 (round 7). The reconciler can now mint a POSITION, so D5 cell (b) is
> cell (d).** The old code asked one question and answered `born: true`. The rewrite enumerates
> the input per id — *in `before`* × *the log holds a `_born`* × *the log holds it alive* × *where
> `after` puts it* — and answers per input:
>
> | log has `_born` | holds it alive | position in `after` | what is written |
> |---|---|---|---|
> | — | — | (in `before` too) | the field diff only; **never** re-stamped ⇒ R5-5a stays refused |
> | yes | no | anywhere | **RESTORE**: `_alive:true` + fields, **no `_born`** — a delete writes `_alive:false` and nothing else, so the log still carries the position `board.json` has |
> | no | — | last | `born: true`, unchanged — `mutate()`'s append, R4-4a |
> | no | — | interior | an explicit `_born` **strictly between its neighbours'** (`bornBetween`, all-zeros device short: a derived position, not an observed one) |
>
> The op's `ts` is still a fresh `ctx.mint()` above the horizon, so **LWW is untouched** — only the
> `_born` *register value* is chosen, and `_born` is a position, not a time. `_alive` — not
> `before` — is the restore discriminator, because on the `mutate()` door `before` is a clone taken
> at the top of a transaction and a **nested** `mutate()` can commit an entity inside the outer one
> (R3-11's shape, an open, latent, separate defect, which keeps exactly the behaviour it had).
>
> **Rows inverted:** R6-7a, R6-7d. **Added:** **R6-7f** (R5-5a's `_born` swap is still
> `reconcile-failed` — the guard against cell (c)), **R6-7g** (INV-4: exact match ⇒ 0 ops and
> byte-identical `_born` across launches), **R6-7h** (a restore is not an undelete, in both
> directions). **ADR 006** gains **INV-20**. **Mutant (§7):** F6.
>
> **Owed at WP-8, recorded so it is not rediscovered:** the interpolated `_born` carries
> `ZERO_DEVICE_SHORT`. Two devices that independently reconcile the same lost-tail board *will*
> agree on the value — it is a pure function of the neighbours — but nothing pins that across
> devices yet, and it is worth an invariant the moment a second device exists.

> **R6-6 — FIXED 2026-08-27 (round 7), by enumerating the recovery's OUTCOME.** Three ends, and
> only one of them is a recovery:
>
> · **R-a** `log.load()` **throws** ⇒ nothing recovered; the log is quarantined `unreadable-log`.
> · **R-b** it loads and asserts **no** note/bar/category/scratchpad ⇒ nothing recovered, and the
>   log is **not** quarantined — nothing is wrong with it, it is empty.
> · **R-c** it loads and asserts ≥ 1 entity ⇒ R7, unchanged.
>
> R-a and R-b go to `_bootRecoveryFailed` — §5.6's machinery reached from §5.5, with a new
> `bootFailure.reason` of `recovery-unusable`. `bootFailure` is set **first**, `snapshots.json` is
> consulted through the shared `_standIn`, and the warning says **"THIS IS NOT A FRESH INSTALL"**
> out loud, because a log beside a missing board file is proof this device has had a board.
> Because `bootFailure` is set, `_sequesterQuarantine`'s existing `!bootFailure` gate means the
> refused log **keeps its own name** — on this path it may be the freshest record that exists.
>
> **`_logAssertsNothing`'s `catch { return false; }` is load-bearing**: a projection that *throws*
> is a log with something in it that `_projectSafe` repairs one setting at a time. Answering
> `true` there would send a recoverable board to a read-only boot — control **R6-6e**, mutant
> **F5b**.
>
> **Rows inverted:** R6-6a, R6-6b. **Added:** **R6-6f** (D1-r5, the genuinely unrecoverable
> morning: empty is allowed, **silent and writable are not**; `_recoveredFrom.from === 'none'` —
> the stand-in says there *was* no stand-in rather than saying nothing) and **R6-6e**.
> **Mutant (§7):** F5. **Residual:** **R7-1**, below — `diagnostics().source` has no value for
> this fourth outcome and reports the wrong one of the three it has.

### LOW

| id | aka | one line | file:line | owner | status |
|---|---|---|---|---|---|
| **F-1** | F-1 · R3-1 | `board.json` stops being a fixed point across a restart once two scratchpads exist — the materializer's key sort is discarded one layer up | `src/js/store.js:368` (`reconcileMap`) | **PO** | **fixed** — §4.1 decided FIX |
| **A3-L1** | R3-2 | The same non-fixed-point one level down: `reconcileList` rebuilds array *order* but preserves an entry object's identity and therefore its **key order** | `src/js/store.js` (`reconcileList`) | **WP-4** | open |
| **A3-L2** | R3-6 | A `setSettings()` makes the next transaction emit a **duplicate** `pref.set` at a fresh stamp, outside any group — one `addCategory` emits `['pref.set','cat.set']` | `src/js/store.js` (`_pref`, `_adopt`) | **WP-4** | open |
| **F-8** | F-8 | `store.warnings`, `plan.lossy`, `plan.warnings` and `plan.reshares` are **written and read by nothing** — and `replaceAll()` *replaces* the warnings array rather than concatenating | `src/js/store.js:471`, `:802` | **WP-10** | open |
| **F-3** | F-3 | `store.undoStack.length = 0` also clears redo and `.push()` is a silent no-op — an undocumented divergence from the v1 surface | `src/js/store.js` (`_stacks`) | **WP-3** (doc) | **fixed** (documented) |
| **A3-M1a** | M-1 | The door policy is two rules: it **throws** on 27 hostile values and silently **accepts** 3 | `src/js/core/ops.js` | **PO** | **fixed** — §4.3 ruled; residual is F-2 |
| **F-4** | F-4 | ATT-5: deleting an already-deleted entry records 1 undo step where v1 recorded 2 | `src/js/core/undo.js` | — | **accepted** — strictly better |
| **I-4** | new | `GENESIS(index)` throws `RangeError` above 1,000,000 entities — a **data-driven throw out of the migration door**, which is the one thing A3-M1a's ruling forbids | `src/js/core/migrate1to2.js:127` | **PO** | **decision** — §4.4 |
| **R5-12d** | R5-12d | `coerceToV1Date`'s ISO tail is accepted **un-range-checked** (`'2026-03-04T25:00'` passes) — filed as a defect, closed as a **corrected claim**: the tail is a *shape*, and the invariant that matters is that nothing in it may change which day the value names | `src/js/core/migrate1to2.js:641-681` | **WP-3** | **accepted** |
| **I-6** | new | A quarantined op log is left on disk and therefore **re-derived and re-reported on every launch** — safe, but noisy, and there is no way for the user to make it stop | `src/js/storage.js` | **WP-8** | open |
| **R6-2** | R6-2b | ADR 001 §7.2 promised `ops.jsonl` compacts *"or on launch when it exceeds 2 MB"*, and **only the line cap was implemented**. Measured: ≈3 MB in ≈260 `pad.set` lines — nowhere near the 1 500-line cap, and never compacted | `src/js/store.js` (`TAIL_COMPACT_BYTES`, `tailBytes`, `_tailOverBytes`, `_persistOps` ②) | **WP-3** | **fixed** |
| **R7-1** | new · this pass | **`diagnostics().source` has three values and there are now four boot outcomes.** R6-6 added a stand-in boot (`bootFailure.reason === 'recovery-unusable'`: `board.json` absent, the log unusable, a snapshot on screen, read-only) which reports **`source: 'board.json'`** — the value documented as *"solo mode, or the log was quarantined"* — about a boot with **no `board.json` at all**. Its twin, §5.6's read-only boot over a *zero-byte* board, reports **`'recovery'`** for the same picture. Measured side by side at integration | `src/js/store.js:1783-1800`, `:2121`; `docs/v2/contracts/store.contract.js:120` | **WP-3** | open |
| **R6-7e** | R6-7e | ADR 006 §9.3's **W2** said a quarantine re-mints the `lineageId`; §7's table says four of the six reasons **preserve** it. Filed as a contradiction; closed as a **corrected claim** — §7 is right, W2 conflated the local `board.json`↔log binding with the *stamps* on a re-derivation, which §9.4 already made normative. Re-minting on `clock-skew` would orphan a log a later launch is meant to adopt | `docs/v2/adr/006-board-log-authority.md` §9.3 | **WP-3** | **accepted** — W2 amended |

- **F-8** is against **principle 6** and story 11.6. `migrate1to2.js` builds `MigrationLossyError`
  precisely so that "a migration that loses something may not complete silently", and `store.js:471`
  passes `acceptLossy: true` and assigns the warnings to a field no UI consumes:
  `grep -rn warnings src/js/*.js` outside `store.js` has **no hits**. `replace.js:388` says "the
  store must be able to refuse and tell the user before the board it is replacing is gone";
  `store.js:802` reads `plan.warnings` and ignores `plan.lossy` entirely. This is the *carrier* for
  A3-H2's message (`note "n": field "date" = "4.3.2026" is not representable in v2 and was DROPPED`)
  and for F-6's refusals.

  **HALF CLOSED — the carrier, not the consumer. The row stays open, and it moved UP the
  priority list rather than down.** The carrier is now real and durable: `warnings` is ONE array
  for the store's life (callers may hold it), `clearWarnings()` empties it **in place**,
  `subscribeWarnings(fn)` fires per warning and survives a listener that throws, `diagnostics()`
  returns `{ready, source, warnings, quarantine}`, and the channel is capped at 1000 entries.
  Two real bugs were in it: `replaceAll` did `this.warnings = plan.warnings`, so **an import that
  happened to be clean erased the whole session's report** — including the migration's, on the one
  launch where it matters most; and `plan.lossy` was read by nothing. Both fixed, both
  mutation-proven (R3-43/R3-44). New rows R3-43…R3-46 in `round3-seam.test.js`; the surface is
  recorded in `store.contract.js`.
  **What is still owed is the whole point of the finding: no UI reads it.** `R3-27` is deliberately
  *not* inverted, and closing A3-H2 makes it worse, not better — every coercion the migration now
  performs on the user's file is on this channel, and the user is still not told. **WP-10 seam:**
  `settings.js` (E1's file this round) wires `store.subscribeWarnings(fn)` and `store.diagnostics()`
  into the settings pane; `diagnostics().quarantine` is what a "your op log was refused" notice
  should read.
- **F-3** belongs in `docs/v2/contracts/store.contract.js` §2.2 as an explicit divergence. No
  shipping caller reaches it.
  **DOCUMENTED 2026-08-27**, as `UndoStackView` in that contract: `.length` reads the **group**
  depth (5.4's "~50 steps" is 50 groups, not 50 ops), `.length = 0` clears **both** stacks and any
  other number is a silent no-op, `.push()` is accepted and ignored, `.toJSON()` is the depth, and
  there is no `pop`/`slice`/index access. Checked against `main.js`, `settings.js`, `backup.js`:
  no shipping caller reaches past `.length` and `.length = 0`.
- **A3-M1a — RULED (§4.3) and applied.** Every door an outsider can reach now **refuses-or-coerces
  and warns**, and never throws: `migrateV1`, `planReplaceAll`, `applyRemote`. The one real throw
  site left in the doors was `flattenPref`'s recursion — a `settings` a few thousand deep
  overflowed the stack with a `RangeError`, not an `OpError`, and both doors rethrew it out of
  `init()`; it is now caught alongside `OpError` in both, and costs one key. `MigrationError` on a
  non-object board or a bad ctx is left throwing, and that is the ruling working as intended:
  those are **programmer error** (the caller must gate on `shouldMigrate`), and both are pinned by
  a test that says so. Pinned end to end by **R3-26c**, which drives eight hostile board shapes —
  a note that is an array, an id full of key separators, an id named `__proto__`, containers where
  dates go, `settings` nested two thousand deep, every field the wrong type at once — through
  **both** doors and requires the app to boot with a legal v1 board each time.
  **Residual:** the three silent accepts and the 27 throws at `store.apply()` are one door and one
  rule short of each other. That is **F-2**, which stays open and is now smaller.
- **I-4** — `GENESIS(index)` is how §8.1 carries a v1 array position into a stamp, and the index
  space it encodes runs out at 1,000,000 entities. Above that the migration door **throws** on
  data, which is exactly what §4.3's ruling forbids. It is filed as a decision rather than a fix
  because **every available answer costs something the PO has to choose between**: dropping the
  entries past the millionth loses data on a board nobody has; changing the stamp scheme changes
  `_born` for every existing entry and therefore array order (`layout.js:209`'s capacity slice is
  order-sensitive); and refusing the file with a message is the honest option that still stops the
  user on upgrade day. No real board is within four orders of magnitude of it.
- **I-6** — the A3-C1 quarantine keeps three promises, and "not deleted" is one of them, so the
  refused `ops.jsonl` / `checkpoint.json` stay exactly where they are and the check runs again on
  the next launch. **Nothing is lost either way** — that is the safe direction, and it is why this
  is LOW — but the user gets the same refusal every time and cannot act on it. The fix is in
  `src/js/storage.js`: move the files aside as `ops.quarantined-<ts>.jsonl` /
  `checkpoint.quarantined-<ts>.json`. Noted in `_quarantineLog`'s docblock. **Do not "fix" it by
  deleting them.**

> ### R5-12d — THE CLAIM WAS CORRECTED, NOT THE REGEX
>
> Filed as *"the ISO tail is not range-checked, so `T25:00` is accepted"*. Tightening it was
> **rejected on a measurement, not on taste**, and the measurement is the record: v1 paints
> `endDate: '2026-03-04T25:00'` in exactly **one** column (with a NaN end day of its own —
> `parseISO` splits on `-`), v2 paints that same one column, and refusing the tail moves it to
> **ten**. That is R5-11's cost all over again, arrived at from the opposite direction: the
> "stricter" behaviour is the one that diverges from v1.
>
> So the docblock now describes the tail as **a wall-clock time by shape, deliberately
> un-range-checked**, and states the invariant that is actually load-bearing: *nothing in the tail
> may change which day the value names* — which is exactly why `Z` and `±HH:MM` are still refused.
> R5-12d is inverted and pins the accepted behaviour; **R5-12e** is the new row carrying the
> one-column-versus-ten measurement, so a future pass that finds the regex "sloppy" meets the
> number before it meets the code. **Mutant (§7):** row 46.
>
> *A v1 quirk worth its own row if anyone ever cares:* `parseISO` splits on `-`, so that edge
> gives v1 a segment with `endDay: NaN`. v1's own rendering of this class is degenerate, which is
> part of why §4.6 is a judgement call rather than an obvious fix.

> **R6-2 — FIXED 2026-08-27 (round 7): both halves of ADR 001 §7.2's policy gap, in opposite
> directions.**
>
> · *"or on launch when it exceeds 2 MB"* — **the ADR was right and the code was missing it.**
>   Implemented: `TAIL_COMPACT_BYTES`, `tailBytes()`, `this._tailOverBytes` set in `init()` from
>   the tail just read and consumed one-shot by `_persistOps` step ②. Line cap and byte cap are
>   **independent**; first crossed wins. Measuring the tail's bytes means serializing it, which is
>   the one thing the debounced save path may not do on a keystroke — at launch the bytes have just
>   been read and parsed, so it is free and it happens once. **Mutants (§7):** *never consult
>   `_tailOverBytes`*, and *measure lines instead of bytes* — both kill R6-2b.
> · *"keeping a 30-day tail for debuggability"* — **the ADR was wrong; the clause is dropped.**
>   `truncateOps` can only drop a prefix and the store tracks a line count, not per-op file
>   positions — and §7.2's own losslessness result is precisely the statement that a retained tail
>   is worth nothing *to state*. The stale *"Reviewed 2026-08-27 — no change owed"* is kept and
>   **marked superseded** rather than deleted.

> **R7-1 — OPEN, and found by this integration pass rather than by an adversary.** R6-6's fix is
> correct in everything that touches a file; it added a **fourth** boot outcome to a **three**-valued
> diagnostics field. Measured side by side:
>
> | boot | `bootFailure.reason` | `source` | `recoveredFrom` |
> |---|---|---|---|
> | `board.json` absent, a usable log (§5.5 R-c) | — | `recovery` | `op-log` |
> | `board.json` **zero bytes**, a log beside it (§5.6) | `board-unparseable` | `recovery` | `snapshot` |
> | `board.json` absent, the log **will not load** (§5.5 R-a) | `recovery-unusable` | **`board.json`** | `snapshot` |
> | `board.json` absent, the log **projects to nothing** (R-b) | `recovery-unusable` | **`board.json`** | `snapshot` |
>
> Rows 2-4 are the **same event** — read-only, a snapshot standing in, nothing recovered from a
> log — and `source` says the opposite thing about row 2 than about rows 3-4. **Two rules are
> implemented at once:** `store.contract.js`'s (*"no **readable** `board.json`" ⇒ `recovery`*) and
> `_bootRecoveryFailed`'s (*"nothing was **recovered**" ⇒ not a recovery*), and the comment
> justifying the second is verbatim the argument that also condemns the first.
>
> **Neither of the three documented values is right for rows 3-4.** `'recovery'` is documented as
> *"the log had to be the truth (R7)"* — it did not. `'board.json'` is documented as *"solo mode,
> or the log was quarantined"* — there is no `board.json`, and on R-b the log is not quarantined
> either. **The enum is short a value; it is not a branch that was chosen wrongly.**
>
> **Cost:** diagnostics only. Nothing on disk, on screen or in the read-only promise depends on
> `source` — `bootFailure.reason` and `recoveredFrom` together carry the whole truth on every one
> of the four rows, and every content assertion in §7d's D1 domain is written against those two.
> **Deliberately not patched here.** Widening a documented three-valued contract field is a change
> to `docs/v2/contracts/store.contract.js`, which has an owner, and jamming a fourth outcome into
> whichever of the three fits least badly is exactly the branch-at-a-time move §7d exists to stop.
> **What is owed:** a fourth value (`'stand-in'` is the obvious name) in the contract, in
> `diagnostics()`, and in D1_RECOVERY's `expect`, with R6-6a/b/f extended to assert it.

### INFO, gaps and accepted divergences

| id | aka | one line | file:line | owner | status |
|---|---|---|---|---|---|
| **G-1** | STATUS §5 | **Security-relevant.** A bare `dev.*` attestation makes its author a `currentMember` — an outsider can appear in the Kreis unassisted, and `currentMembers` gates foreign-entry visibility (20.2) | `src/js/core/authz.js` | **WP-9** | open |
| **G-2** | STATUS §5 | `replaceAllOps()` returns ops alone by contract, so the retraction carrier exists only on the *plan*; the store had to be made to call `planReplaceAll` and hand `plan.retractions` to the publisher | `src/js/store.js:805` | WP-3 | **fixed** |
| **F-9** | F-9 | `src/js/platform/updater.js` (E1, uncommitted at audit time) is **unscanned**: `src/js/platform/` is not in `PURE_DIRS`, `tests/tier1/network-scope.test.js` does not exist, and `tauri.conf.json`'s `csp` does not yet name an update host | `src/js/platform/updater.js`, `tests/helpers/purity.js:28`, `src-tauri/tauri.conf.json` | **E1** | open |
| **A-1** | STATUS §5 | An import resurrects a tombstone at a fresh stamp. That is what restore *means* (11.5), and the fresh stamp is load-bearing for paired-device convergence (ADR 001 §8.5) | `src/js/core/replace.js` | — | **accepted** |
| **A-2** | new | Two residual drops **both** doors still make after A3-H2: a scratchpad key that is not `YYYY-MM`, and an "entry" that is not an object at all | `src/js/core/migrate1to2.js`, `src/js/core/replace.js` | — | **accepted** |

- **G-1 cannot be closed in WP-1** — membership has to be *conferred* by the invite/redeem flow
  before `authz.js` can refuse to infer it.
  → `tests/attack/convergence-authz.test.js:201`, `tests/attack/ownership-authz-admin.test.js`.
- **G-2 is closed and verified**, not merely claimed: `judge:conformance` A.3 (story 16.5) read
  `store.js:805` and confirmed `plan.retractions` is computed and handed to `publisher.retract`; the
  publisher is still `nullPublisher`, which is correct until WP-10.
  `tests/attack/recheck-att40-replace.test.js:220` stays as the pin.
- **F-9**: nothing to do in the audit that found it; flagged so **21.5 is re-verified after E1
  lands**. ADR 003 §7 gate 1 was marked **owed** on 2026-08-27 for the same reason.
- **A-2 — accepted, and stated so the pair is not mistaken for an oversight.** A scratchpad key
  that is not `YYYY-MM` has **no register that can address it** (`pad:<YYYY-MM>` is the whole key
  space, `entities.js:parseEntityKey`), and an "entry" that is not an object has **no fields to
  represent** — there is nothing to coerce it *to*. Neither is one of A3-H2's five. Both are
  reported on the warnings channel like every other loss.

---

---

## 2e. E3 — identity and crypto (LZP-302…306), integration pass 2026-08-27

Kept as its own block rather than merged into §2's severity tables, for one reason: **none of
these came from an adversary reading v1's code.** They came from *building* the crypto layer and
running it in the engine that ships, and three of the five are facts about **WKWebView** that no
amount of review would have produced. Full evidence: **`docs/v2/E3-VERIFICATION.md`**.

| id | one line | file | owner | status |
|---|---|---|---|---|
| **E3-1** | **A rebuilt or re-signed bundle makes every persisted device key read back as `null`.** WebKit encrypts persisted `CryptoKey`s under a per-app "WebCrypto master key" it keeps as a Keychain generic password **whose ACL is bound to the code signature**. With **D1 (ship unsigned)** + LZP-102's bundle-replacing updater, every device key becomes unreadable **after every update**. | `shell-macos/build.sh`, LZP-102 packaging | **WP-8 / LZP-102** | **open — blocks family mode shipping** |
| **E3-2** | **No wire field carries another member's `RK_kex`.** ADR 002 §4.2 step 2 requires a rotation to wrap "plus each member's `RK_kex`"; `MemberRowDb` carries only `recoveryPubSig`. | `server.contract.js` §4, ADR 003 §2 | **WP-7** | **open** |
| **E3-3** | **`core/ops.js` has no `PARK_REASONS.ATTESTATION`** — the other half of **F-6**. | `src/js/core/ops.js`, `authz.js:671`, `store.js:699-703` | **WP-8** | **open** |
| **E3-4** | **`KeyWrapRow.deviceId` cannot hold a recovery recipient** if it is a foreign key onto `Device`. `recoveryRecipientId` reserves `rec_<memberId>`. | server schema | **server** | **open — needs a decision** |
| **E3-5** | **ADR 002 §6.2 and ADR 003 §6.1 publish different pairing rate limiters** — 20 `pair/get`/IP/**hour** vs 5 failed rid lookups/IP/**minute** plus 10 sessions/member/hour. Not contradictory; not interchangeable. | ADR 002 §6.2, ADR 003 §6.1 | **WP-7** | **open — reconcile into one `RateBucket`** |
| **E3-6** | **The backup's board block is not authenticated.** Whoever edits the file edits the board that comes back. The *keys* are unaffected — a modified file will not open at all. | `src/js/crypto/backup.js` | **PO** | **ANSWERED and CLOSED 2026-08-28 (finding S3), verified 2026-08-29** — see below |
| **E3-7** | **ADR 002 §5.1's example `sp` did not satisfy `core/entities.js`'s `SPACE_ID_RE`** — 18 chars after the prefix where 22 is required. It had been copied into a fixture. | ADR 002 §5.1 | — | **fixed** 2026-08-27 |
| **E3-8** | **`DESIGN-DECISIONS.md` D9 said "the admin's device must be online"**; ADR 002 §7.1 step 4 says **any existing member device**, is later, and gives the reason. | `DESIGN-DECISIONS.md` D9 | — | **fixed** 2026-08-27 |
| **E3-9** | **Two red-team rows decided their verdict on a random ciphertext byte, so `npm run test:attack` failed ~1 run in 13 — and the E3 fix commit was recorded as green off a lucky run.** Both are "tampers" that were not guaranteed to tamper: **M-B3** rewrote the KDF salt's first character to `'A'`, a NO-OP when the salt already began with `'A'` (**1/64**, measured 18/1280), after which the row imported a *clean* file and failed asserting `cannot-open`; **M-B6b** truncated the sealed block by 8 characters, leaving `730 % 4 === 2` — a legal b64url length whose last character carries 4 **slack bits** — so `ub64`'s strictness decided between `identity-damaged` and `cannot-open` at **exactly 4 of 64** alphabet values (`A`,`Q`,`g`,`w`), i.e. **1/16**. M-B6b's own comment documents this trap and fixes it for the *bit-flip* four lines below, and not for the truncation. | `tests/attack/crypto-member-backup.test.js` | **E3 / crypto** | **fixed 2026-08-29** — both made deterministic and M-B6b **strengthened** into two cases (a length that is not a b64url length at all → the shape pass; the 8-char cut → refused by either code, key store asserted untouched). 40/40 clean runs. |
| **E3-10** | **A tier-2 row fails on every Saturday, Sunday and Ferien day, because it asserts today is a plain weekday.** `12.3/15.4 · the Today highlight is suppressed on paper` reads the REAL `.day.today` off the wall clock and asserts `SHADE.none` under print CSS. `src/css/print.css:69` says `.day.today.we { background: var(--bg-weekend) !important; }` — correctly — so on a weekend the row measures `SHADE.weekend` and fails; line 73 would fail the `--ink-3` assertion next. **The product code is right and the row is wrong**, and the row immediately below it (`a Today that falls on a weekend or in Ferien prints as that, not as blank`) forces the classes and proves the correct behaviour. This is why `npm run test:dom` reported tier 2 **PASS** on Friday 2026-08-28 and **FAIL** on Saturday 2026-08-29. Fix: force the classes (or assert against the day's actual `we`/`fer`) instead of reading the calendar. | `tests/tier2/dom-rendering.dom.js` (≈ line 1130) | **whoever owns `tests/tier2/dom-rendering.dom.js`** — NOT touched by the E3 verification pass, one owner per file | **open — no crypto content, but it red-lights the release gate two days in seven** |

### E3-1, in full — because it is the one that stops a release

Reproduced **three ways**: with no login keychain (`-60006`), and twice with a **rebuilt binary
against an item created by the previous build** (`-25299`, key returns `null`). The symptom is
built to be missed:

- WebKit logs `Cannot store WebCrypto master key, error -25299` to the **process's stderr**, where
  the page cannot see it;
- `put()` then rejects with `DataCloneError`;
- **previously stored keys read back as `null`** — while plain values in the same database survive
  untouched, which is what makes it look like a bug in our code rather than a custody failure.

Two consequences. **(a)** ADR 002 §2.2's framing that IndexedDB custody *avoids* depending on the
Keychain is only half true: on WebKit the Keychain is a **prerequisite of the primary store**.
**(b)** On the D1 + LZP-102 path, `ensureDeviceIdentity` would find 2 of its 3 records and refuse —
correctly, it is deliberately brittle about partial state — and the user would have to **re-pair
after every update**.

A stable **Developer-ID signature makes the ACL survive**, which turns code signing from a
packaging preference into a **hard requirement of the custody design**. That is a real input to
D1, which currently reads "ship unsigned"; D1 is explicitly reversible (a cert and two GitHub
secrets, no code change), and this is the first argument that has a cost attached to *not*
reversing it.

`idbKeyStore.put` already reports the loss as `KeyStoreUnavailableError` — *"custody unavailable"*,
never *"bad key material"* — **without branching on the error name** (rule 3), and `loadKeyRing`
**skips** a record that reads back `null` rather than throwing, reporting it on `ring.loadSkipped()`,
because it is recoverable: any other member device can re-deliver the ring (D9).

**It also produced a fix to the test runner, and that fix mattered on its own.**
`tests/run-dom-tests.sh` now re-identifies the tier-2 build as `org.langzeitplaner.domtest` before
launch, so WebKit's website data store — localStorage **and** IndexedDB — is genuinely isolated
from the installed app. **It was shared before.** The stale master-key item the suite must clear
now belongs to the suite; clearing the production one would have orphaned a real installation's
device keys.

### E3-6 — the decision, stated so it can be answered in one line

With a passphrase, a board digest could be bound into the backup's AAD. **The board-only export
path has no key at all**, so the guarantee would exist on one of the two paths — and a guarantee
that holds on one path is worse than one stated plainly. (Binding it would also let an export
**fail** on a board whose `settings` picked up a float, since `canonicalJSON` refuses non-integers;
losing the user's export to a stray setting is the worse failure.)

~~Left unbound, stated in German and English as `LIMITS.boardNotAuthenticated`, and pinned by a
characterization row so it cannot be quietly assumed away. **If you want it bound: say so.** It is
a small change plus a re-derivation of the AAD.~~

> **ANSWERED 2026-08-28 (finding S3), and the answer was BIND IT — verified 2026-08-29.** The
> paragraph above was the state of the question, not the state of the code, and the E3 fix pass
> resolved it while this section still read "left unbound". What it built:
>
> - The AAD now carries `board: { digest, hash }` — a SHA-256 over `boardDigestInput(file.board)`,
>   recomputed on **both** sides in `sealAad()`. It is **not a field of the file**: there is
>   nothing for an attacker to strip and no wire format to version (§7.2's `identity` shape is
>   unchanged). `sealAad` **throws** if a caller omits the digest, so the hole cannot be rebuilt
>   by forgetting an argument.
> - The objection above is **answered rather than overruled**, and it was the good objection. The
>   guarantee is stated **per path** — `LIMITS.board.withIdentity` ("either your board comes back,
>   or none does") and `LIMITS.board.boardOnly` ("this file holds no keys… whoever edits the file
>   edits the board that comes back") — instead of one sentence that would have been true on one
>   path and false on the other. `LIMITS.boardNotAuthenticated` survives as a **deprecated alias**
>   of `board.boardOnly` precisely because this document, `STATUS.md` and `E3-VERIFICATION.md`
>   quote it by name.
> - The second objection is answered too: `boardDigestInput()` deliberately does **not** use
>   `canonicalJSON`, so it is a total function over everything `JSON.stringify` can write. A float
>   that wandered into `settings` cannot cost the user their export.
>
> Proved by row **M-B4**, which is INVERTED in place ("the BOARD is inside the AAD now: her file
> no longer opens at all"), by 7 cells of domain **C2**, and in the shipping engine by
> `tests/tier2/crypto-backup.dom.js` #17 and #18. Reverting the one AAD line kills exactly M-B4
> and those 7 C2 cells and nothing else (E3 verification, mutant M-C, 2026-08-29).
>
> **What is still true, and is now said in the product rather than here:** the **board-only**
> export has no key at all and therefore no authentication. That is `LIMITS.board.boardOnly`, it
> is in the file's own README in both languages, and it is not a residual of E3-6 — it is the
> other path.

### What E3 explicitly did **not** close, recorded so nothing downstream is built as though it did

- ~~**I-3 / R5-7 — still open.**~~ **CLOSED 2026-08-28 by the E3 fix pass** — §4.5 option (a),
  built as a **possession proof at fold time**: a `dev.<S>` register is a credential only if the
  op that wrote it was stamped by the device it attests. Everything the paragraph below says
  about P2 is still true and is why the answer had to come from elsewhere; the characterization
  rows are inverted, not deleted, and R5-7c / M-I3a — the rows asserting *that P2 does not close
  it* — deliberately still assert exactly that. The original text follows.
  §4.5's option (a) is the only thing that closes it. E3
  shipped **P2** (`deviceShortOf(att.sigPubRaw) === att.deviceShort`) as a **MUST** in
  `verifyAttestation`, which is what §4.5 said WP-6 owed — **and §4.5's warning was right: it does
  not close it.** `sigPubRaw` is a public key travelling in the victim's own register; the squatter
  copies it, tells the truth about it, and passes P2. `openOp` therefore treats `attestationOf` as
  a **partial function** and **parks** — and it still does, because `attestationOf` is still
  partial for an absent, unproven or twice-proven short. Characterization rows named
  *"I-3 / R5-7 IS STILL OPEN"* existed in **both** test tiers and in three separate crypto suites;
  they are inverted in place.
- **§2.3 / §8.2a — no device revocation anywhere.** `openOp` has **no revocation input** and did
  not invent one: a test asserts an attestation carrying a `revokedAt` still opens. If that row
  ever fails, revocation was invented at the wrong seam. Consequence for **WP-9**: a „Gerät
  entfernen" button can only stop *future key distribution*, and the UI string must say the
  smaller true thing.
- **§8.5 — no key transparency.** A phantom member receives the family key and this layer cannot
  tell. Characterized, not fixed.
- **§8.9 — no forward secrecy within an epoch.** Characterized, not fixed.
- **`canonicalJSON` NFC-normalises**, so a note typed as NFD (macOS decomposes) is sealed as NFC
  and comes back NFC on every peer *and on the author's own second device*, while the local truth
  register still holds NFD. Not fixable in `envelope.js`: the fix, if wanted, is to normalise at
  the **mutation** seam so the store and the wire agree. Un-normalising the wire is not an option.
  Pinned as a characterization row for **WP-8**.


## 3. What must be fixed before WP-8 — **DISPOSED 2026-08-29 by the E5 integration pass**

WP-8 is the first package with a second device, and it turned seven of these rows from latent into
live. **WP-8 is now built and M1 is demonstrated** (`docs/v2/E5-VERIFICATION.md` §3), so this list
is no longer a plan: every row below carries what actually happened to it. **Three are still open
and each one names an owner. Nothing here has been absorbed into a closure it did not earn.**

| # | row | disposition |
|---|---|---|
| 1 | **F-10** `attestationOf` on `AuthzResult` | **CLOSED** before E5, and now load-bearing: it is `openOp`'s P1, and `createPersonalSync` refuses to be constructed without the port. |
| 2 | **A3-H4** durable device identity | **CLOSED.** `platform/device-identity.js` + `store.useIdentity()`. Proved by two genuinely distinct identities converging — in `store-identity.test.js`, in the fleet harness, and in the M1 run with two separate browser storage partitions. All three things `authz.js` needed are supplied: `me`, `myDevices`, `attestOpen`. |
| 3 | **F-5** the checkpoint must pass `applyRemote`'s gate | **STILL OPEN.** Untouched by E5. It remains the only input that becomes authoritative without being checked. Owner: `store.js`'s boot path. Closing it closes row 8 too. |
| 4 | **F-6** the ATTESTATION park reason, or retain refused ops | **CLOSED**, by both halves rather than either — see the header note. `sync/personal.js` additionally holds the cursor, so the op is re-served even if the park were lost. |
| 5 | **F-7** drop `local`-space ops · **F-2** one throw/accept rule | **F-7 CLOSED** at both ends of the wire by LZP-502; `round3-seam.test.js`'s two rows are inverted to `FAILED (held)`. **F-2 STILL OPEN** — `applyRemote` still mixes "throw" and "refuse and report". Nothing in M1 depends on it. Owner: `store.js`. |
| 6 | **A3-M5** `_persistOps` must append | **CLOSED** before E5 — and E5 found the defect *inside* that fix: **E5-2**, below. ADR 001 §7.2's 30-day debuggability tail is still not implemented (compaction is total); E5 did not need it and did not build it. |
| 7 | **I-3** the possession proof | **CLOSED** before E5. E5's two obligations are held and asserted: nothing appends an op that has not passed `openOp`, and §5.2.2 check 4 is not weakened (`store-identity.test.js` pins `devOf(op.ts) === deviceShort`). |
| 8 | **R5-5b** fold an adopted checkpoint through the gate | **STILL OPEN.** F-5 seen from the authority rule's side; one fix closes both. |
| 9 | **R5-2g** a Time-Machine restore of a pre-lineage board quarantines a current log | **STILL OPEN.** Unchanged. It needs a decision rather than an edit. |

**Not on the WP-8 path but on the shipping one:** **I-1** and **I-2** are reachable today, by any
user with a hand-edited or third-party `board.json`, with no second device anywhere. I-1 can lose
a board; I-2 shows a white screen. Neither waits for WP-8. **R5-3's whole class is in the same
category** and is closed, which is why it was worth the round: it needed no second device either,
only a truncated byte.

**Also latent-until-a-second-device, and now live:** **E3-1** — the row STATUS calls "the only row
blocking a family-mode release" — is **untouched by E5 and still open**; E5 was told not to edit
`src/js/crypto/`. **E3-3** is **CLOSED** (below). ADR 006 **§9.5**, **§9.3 / W2** and the **WP-3
retraction obligation** were closed by LZP-502 and are asserted. **W1** holds structurally and is
asserted as an *inequality* — a persisted cursor may be behind `board.json`, never ahead.

---

### 3b. Rows opened by the E5 integration pass and the M1 demonstration

#### E5-2 — an op authored offline is LOST from the outbox by the next relaunch · CRITICAL · **fixed**

*Found by:* `tests/fleet/long-offline.test.js`, on the first run of the fleet harness.
*Owner was:* `src/js/store.js`. *Closed:* 2026-08-29.

ADR 003 §8.1 defines the outbox as "`ops.jsonl` lines whose `seq` is unset" and promises it
"survives quit and crash (19.1)". `store.outbox()` implemented the first half exactly. The second
half did not hold: `_persistOps` ③ wrote a checkpoint whose horizon was above every op in the log,
acknowledged or not; `checkpoint()` folds everything at or below the horizon into `regs` and drops
the LINE; `load()` brings back registers, not lines. **So an op the relay had never seen was
written to disk as a register VALUE and never as a LINE.**

Measured consequence: five entries a user made on a laptop while it was offline never reach the
desktop, ever; the two boards are permanently divergent; and the engine reports **`healthy`**
throughout, so under F11's "silence is the design" the user is told nothing. Not only offline
either — the 700 ms autosave debounce beats the 2 s push debounce, so an edit and a quit within
two seconds took the same path on a perfectly online Mac.

**Fix:** `store._outboxHorizonCap()` — a persist may not fold past the oldest line the relay has
not acknowledged, with `outbox()` *called* as the definition of "not acknowledged" so the two
cannot drift, and the one value imposed on the tail selection, `compact()` and `checkpoint()`
alike. Same shape as ADR 001 §7.3's tombstone GC. `undefined` — no cap — on every solo persist, so
R5-4e's compaction bound is untouched. **Mutant:** remove the cap → `long-offline.test.js` §3 goes
red on `ops.jsonl` being empty after the quit.

#### E5-5 — the published `pairGet` budget cannot accommodate a polling rendezvous · MEDIUM · **open**

*Found by:* the M1 demonstration, as a live `429`. *Owner:* `server/`.

`GET /api/v1/pair/:rid` is charged against `pairGetPerIpHour = 20` (ADR 002 §6.2), enforced
`pre-auth`, so the offerer's *authenticated* read of its own rendezvous is charged too. The
rendezvous lives 180 s and **two Macs of one household are one IP**. A 1 s poll spends the hour's
budget in twenty seconds and the second Mac gets a 429 where it expected `box_A` — which surfaces
as `answerAsNew: that did not open`, correctly indistinguishable from a wrong code, and therefore
very hard to diagnose.

Mitigated client-side by `pairflow.js`'s `PAIR_POLL_SCHEDULE` (2, 2, 3, 5, 8, 12, 18, 24, 32, 36,
40 s — eleven reads cover the full TTL and leave nine for the joiner). **Still open:** a household
that pairs a third device within the hour runs out. The right fix is not charging the
authenticated offerer's own read, which `pair.js` §2 already argues for reads after `box_B` exists.

#### E5-6 — a paired Mac receives NONE of the pre-space board, categories included · HIGH · **open**

*Found by:* the M1 demonstration. *Owner:* WP-9 / the pairing flow.

The corollary of E5-1: the migration spine is shared *prehistory*, not traffic, so `outbox()`
excludes GENESIS stamps (re-stamping instead costs a permanent `409 forked_op_id` — LZP-502 built
that, measured it and withdrew it). A Mac that does not already hold the `board.json` therefore
receives nothing of the pre-space board, though ADR 002 §6.3 step 8 says it "pulls from seq 0".

The demonstration shows the cost is more than a missing note. Both Macs minted their own default
categories at first run — spine ops, so they never travelled — and every synced note carries its
author's `categoryId`, unknown on the other Mac. `deserializeBoard`'s reference repair quietly
remaps it to a local default:

```
MAC A  Arbeit c32ee91a-…   MAC B  Arbeit 596e6397-…
```

On that run every note landed on the right-looking local category. With a colour the user cares
about it would be wrong, silently, on every entry. **Until this is closed, pairing a Mac that does
not already hold the board is not delivered**, and story 19.4 reads as "my whole private board,
from the moment the space exists". ADR 002 §7.2's backup file or a `board.json` hand-over during
pairing is the fix.

#### E5-7 — `device.attestation` has two spellings on two endpoints · LOW · **open**

*Owner:* `server/`. `POST /spaces` reads it with `readBytes` (base64url of opaque bytes, never
verified); `POST /devices` and `/devices/adopt` read the raw blob string and verify it. A client
must encode the same value differently for the two calls. `family/engine.js` does, with a comment
at each site.

#### E5-3 — `pushNow()` threw where `syncNow()` returned a value · LOW · **fixed**

`syncNow()` consulted `isOnline()` and returned `{skipped:'offline'}`; `pushNow()` did not, and
let a `NetError('transport')` escape. The debounce timer, `flush()` on pagehide and any caller
reaching for the lower verb got a rejected promise. Fixed: `pushNow()` returns
`{pushed:0, batches:0, skipped:'offline'}`.

#### E3-3 — the `attestation` park reason does not exist in `core/ops.js` · HIGH · **fixed**

*Required by:* ADR 002 §5.2.5, "before WP-8 pulls from a real peer". *Closed:* 2026-08-29.

`PARK_REASONS.ATTESTATION` now exists, and landing the constant alone would have been **worse than
useless**: `oplog.load()` re-classifies every parked line on purpose, so a reason the classifier
cannot re-derive comes back LIVE — for this one that means an op from an unattested device
APPLIED, one relaunch later, with no gate. So `classifyOp` takes `haveAttestation` exactly as it
takes `haveEpochKey`, `load()` feeds the reason back, and `unpark()` re-asserts both.
`store.unparkAttested()` re-runs the AUTHORIZATION fold before selecting anything, because
`classifyOp` knows nothing about devices and would admit it blindly. Two accepted-defect rows
(`crypto-relay-tamper.test.js`, `crypto-envelope.dom.js`) are **inverted**.
**Owed to `src/js/crypto/`:** `ENVELOPE_PARK.ATTESTATION` should now be `PARK_REASONS.ATTESTATION`
and `PARK_REASONS_NEEDED` should be emptied. The two agree in VALUE — asserted — so nothing is
broken; it is a duplicate constant.

### 3c. Round 8 — THE OP LIFECYCLE, enumerated. E5's two adversaries, answered.

*Ran:* 2026-08-29, after M1 („Zwei Macs") was demonstrated. Four fixers in parallel against an
**enumerated input domain**, then one integration pass. **Nothing the adversaries found was a
confidentiality break — 21.1 and 21.2 both held.** What they found was worse in a different way:
**the engine lost ops silently and reported `healthy` while doing it.**

**The domain is `tests/helpers/sync-domains.js` — 253 entries, five domains, zero imports.** It is
§7d's method applied to a second area, and the sentence that chose the area is the convergence
adversary's own: *"the domain here is the OP LIFECYCLE, not the op kinds."* `domains.js`
enumerates what an op IS; this enumerates what happens TO it — the outcome of `openOp`, what the
engine does with that outcome, what survives a relaunch, what a compaction does to it, and what
anybody is able to SEE. The property that walks it is `tests/property/sync-domains.test.js`, and
it is **green: 85/85, 0 UNEXPECTED, 0 STALE.**

Two things in this round are corrections to *earlier entries in this register*:

- **E5-2 was not closed.** Its own fix — `_outboxHorizonCap()` — asked the wrong question in one
  arm, and that arm is the state EVERY compaction leaves behind. The row is re-opened below and
  closed again, twice over, because a **second, independent** defect (L-4) was hiding behind it
  and was only visible once the first was fixed.
- **F-8's "no consumer" was half the finding.** The channel now has one — and mapping the whole of
  `store.warnings` to `error` was measured turning three green rows red, because the channel
  carries repairs, re-joins and successful cures as well as faults. See L-5.

#### E5-2 — RE-OPENED, and closed twice · CRITICAL · **fixed**

*Re-opened by:* `tests/fleet/attack-converge-outbox.test.js` §1 and `sync-domains.js`
`S2s-compact-sandwich` / `S3-unacked` / `S4-lost`. *Owner:* `src/js/store.js`, `src/js/core/oplog.js`.

The clamp landed. Its stand-down did not. `_outboxHorizonCap()` returned `undefined` — **no cap at
all** — when `cap === null || cmp(cap, held) < 0`, on the reasoning that a receding horizon is
unrecoverable. But `cap === null` means only *"no live line strictly below the outbox floor"*, and
that is the state every log is in immediately after any compaction: once a checkpoint has folded
everything below the floor there is by definition nothing live below it. So `compact ▸ author
offline ▸ compact` handed the log back its own defaults and folded the unacknowledged line for
real, `outbox()` returned 0, and both Macs said `healthy` — E5-2 exactly, reached by ADR 001
§7.2's ordinary tail policy and no adversary at all.

**Fix (a).** The stand-down belongs to a fact about the FLOOR, not the CAP: only `held >= floor` —
the persisted checkpoint already folds the unacknowledged op — is unrecoverable. `cap === null`
answers with the persisted horizon itself (already folded, so not receding; below the floor, so it
folds nothing owed), or `ZERO_STAMP`. Every arm now returns a STAMP BELOW THE FLOOR; `undefined`
is reachable only from state ①.

**Fix (b) — L-4, and it is the reason (a) alone was not enough.** With (a) in place the 24-seed
convergence sweep still lost an op on seeds 3 and 10. See L-4.

**Mutants:** restoring the old condition reddens `attack-converge-outbox.test.js` §1 (all four
rows), `attack-converge-disorder.test.js` §2, and every one of S1–S4 in the property suite.

#### L-4 — the ACK and the LINE come back from disk disagreeing · CRITICAL · **fixed**

*Found by:* instrumenting the two seeds that still diverged after E5-2's own arm was fixed.
*Owner:* `src/js/core/oplog.js`. *Closed:* 2026-08-29.

`store.outbox()`'s own docblock states the invariant: *"an op leaves the outbox when the server
reports it … which rides in `checkpoint().seqs` and so survives a relaunch."* It did not. A tail
line is written to `ops.jsonl` **at the moment the op is authored** — before any server has seen
it — so `line.seq` on disk is `null` by construction, and `ack()` updates the live entry and
`seqById` **in memory** and never rewrites the line. `oplog.load()` fed the BYTES and dropped the
index.

The consequence was not a lost op *here*. It was a **phantom outbox entry**: an op the relay had
acknowledged came back looking unacknowledged, so `lines()` and `seqOfOp()` disagreed, and the
OUTBOX FLOOR — the input to `_outboxHorizonCap()` — sank below the persisted horizon. That pushed
the cap into E5-2's one genuinely unrecoverable arm, with no adversary, no old file, and no
hostile relay: **any Mac that quits after a compaction.**

**Fix:** `load()` falls back to `seqById` (populated from `cp.seqs` immediately above) when a tail
line carries no seq of its own. A line's own seq still wins, so a tail written by a future build
that does record acks is not overridden.

**Mutant:** revert the lookup → `tests/tier1/core-oplog.test.js` *"L-4 · `load()` restores a tail
line's ack from `checkpoint().seqs`"* dies, and so does the 128-seed convergence sweep.

#### P-8 — every park was a drop, and the park was not durable · CRITICAL · **fixed**

*Found by:* `tests/attack/privacy-e5-scope.test.js` §6; enumerated as S1's four park rows.
*Owner:* `src/js/sync/personal.js`. *Closed:* 2026-08-29, in three parts.

**(a) The branch was dead code.** `pullNow` read `out.parked`, which `openOp` never sets, so EVERY
park fell through to `terminal()`: quarantined, cursor released, op destroyed. The second mistake
was inside the dead branch and would have defeated it anyway — `CURABLE_PARKS` compared enum values
against `out.reason`, a human sentence. Fixed as a DOMAIN rather than two words: `PARK_HANDLING`
is one entry per value of `ENVELOPE_PARK`, `parkHandlingOf()` is TOTAL (a reason a newer
`crypto/envelope.js` emits is still held, never dropped), and `CURABLE_PARKS` is derived from it.

**(b) The retention was a session `Map`.** Held ops survived nothing. `sync/outbox.js`'s
`createParkingLot` — a durable, capped, storage-backed retention of SEALED envelopes with their
reasons, which **refuses at its cap rather than dropping** and tells the caller to hold the cursor
— was already written and was reachable from nothing (it was counted a P-4 orphan and this file's
own domain first called it *dead*). It is not superseded: `store.outbox()` replaces `createOutbox`
and nothing replaces this. Wired behind a `parkStore` port (`family/engine.js`'s
`parkedEnvelopeStore()`). `core/oplog.js` cannot do this job — P1, P4 and the version gate all
refuse BEFORE the decrypt, so there is no op to hand `oplog.park()`.

**(c) The cursor.** With durable retention, `PARK_HANDLING`'s `curedBy: 'update'` rows now RELEASE
the cursor, as ADR 003 §8.2 requires — a cursor pinned behind an envelope only a new binary can
read blocks every later op on the space, and is how a hostile relay would wedge a device with one
`v: 99` row. The release is gated on the lot's OWN answer about itself (`durable`), never an
assumption: with no port injected the cursor is held exactly as before, and both configurations
are pinned in tier 1.

**Mutants:** `out.status === 'park'` → `out.parked` kills five §4b rows including *"P1 ATTESTATION
— held, cursor held"* (M1's first contact) and S1a. Never writing the lot kills S1a and S1b.
Removing the `dormant` arm kills *"VERSION with a DURABLE park — the cursor is RELEASED"*.

#### L-1 — the engine's quarantine was a per-session `Map` · HIGH · **fixed**

*Opened by:* the enumeration (S1's three terminal rows, S3-quarantined, S4-refused).
*Owner:* `src/js/store.js` + `src/js/sync/personal.js`.

A terminal refusal — a bad signature, a failed AEAD, a malformed envelope — is CORRECT and final,
and ADR 003 §8.2 releases the cursor past it, so the relay will never offer that op again and the
record of the refusal is **the only thing left in the world that remembers the divergence**. It
lived in a `Map`: `error` for minutes, then `healthy` for ever.

**Fix:** `store.syncRefusals`, written by `terminal()`, riding in `checkpoint().lzp.refusals` —
the store's own half of the checkpoint, which `core/oplog.js` neither reads nor writes and which
is therefore the one place a fact the LOG has no line for can be made durable. Read back by
`init()`, and only from a checkpoint this launch actually believed (a quarantined log takes its
ledger with it). Capped at 200, most recent kept, stated rather than hidden.

**And the converse, which the enumeration forced:** a refusal the world later falsifies is
withdrawn. The ladder's terminal is a statement about ONE DELIVERY; when the STORE's own parked
copy is later promoted, the row is dropped from the ledger rather than lighting `error` for ever
over an op that is on the board.

**Mutant:** stop writing `refusals` into the checkpoint → S1a, S1b, S3a, S4a and
`attack-converge-attestation.test.js` §3 all die.

#### L-2 — nothing could see a held op · HIGH · **fixed**

*Opened by:* the enumeration (S4-held). *Owner:* `src/js/store.js`, `src/js/sync/status.js`,
`src/js/sync/personal.js`.

`sync.status()` derived its three states from `store.outboxSize()` and the engine's two in-memory
Maps; `diagnostics().sync` reported `outbox`, `cursor` and three booleans. Neither reported
`_log.parkedOps()`. A line parked under `attestation` is DURABLE and was INVISIBLE — and story
19.3's "silence is the design" is a promise that silence MEANS health.

**Fix:** `diagnostics().sync` gained `parked`, `refused`, `lost` and `chain`; `sync/status.js`
transcribes domain S4 into the product as `SYNC_OBSERVABLES` and folds over it; `personal.js`'s
`status()` merges the engine's reading with the store's by `max` over the ladder, so it can only
ever RAISE a state. `blindSpots()` is the load-bearing half: a MISSING field is `unknown`, never
`0`, because folding *"I cannot see a parked op"* into *"there are no parked ops"* is this finding
in one line of arithmetic.

**Mutant:** make `status()` relay the engine instead of folding → S4a and
`attack-converge-clock.test.js` §2 die.

#### L-3 — the park had no reaper · HIGH · **fixed**

*Opened by:* the enumeration (S3-parked); pinned by `attack-converge-attestation.test.js` §3.
*Owner:* `src/js/store.js`, `src/js/sync/personal.js`.

`store.unparkAttested()` re-judges a line held for a missing device attestation and was called
from exactly one place in the product — `family/mount.js`, on the adoption of a NEW peer. A Mac
that learned about its sibling on Monday and quit still held Monday's op on Tuesday, and on every
launch after that, for ever. By then the ladder had released the cursor, so the parked line was
the only copy this Mac could reach and nothing was looking at it.

**Fix:** two call sites, because the cure arrives by two routes — `store.init()` (the launch;
`useIdentity()` has already filled `_peerDevices`) and `pullNow` (the pairing that completes
mid-session, which has no launch to wait for). A promotion is committed synchronously with the
pull that caused it rather than left to the autosave debounce.

**Mutant:** remove both → S3a and `attack-converge-attestation.test.js` §3 die.

#### L-5 — `store.warnings` is a MIXED channel, and folding it into `error` breaks 19.3 the other way · MEDIUM · **fixed**

*Found by:* this integration pass, wiring F-8's consumer. *Owner:* `src/js/sync/status.js`.

`sync/status.js` enumerated `warnings` as an `error` observable. `_warn` fires for a refusal and a
quarantine — faults — and equally for a reconciliation after a crash (*"expected"*, in its own
text), a §9.3 re-join (*"nothing is lost and nothing on your peers is deleted"*), a settings
repair, and `unparkAttested`'s *"held ops are now authorised and have been applied"*, which is the
sound of a fix WORKING. Measured, that mapping turned three green rows red and lit a fault on
every launch that had anything to say — which is exactly what S4's `S4-quiet` and `S4-pending`
controls exist to catch, one row over.

**Fix:** the `warnings` row is `healthy` and still COUNTS. A non-empty channel puts a row in
`observables`, so `silent` is false and the settings sheet gets the sentences; only the SHARP rows
— a parked line, a refusal, a lost line, a forked chain — raise the indicator. *"There is nothing
to tell you"* and *"the indicator is quiet"* are different claims and this is the line between them.

**A second half of this finding is in the ENUMERATION, not the build.** `S4-refused` requires this
device, at this moment, to answer `sync.refused`; `S4-warnings` requires the same device at the
same moment to answer `warnings`; `storeReportsOf` is first-match-wins. **No implementation can
satisfy both.** It was invisible while L-1 was open, because a refusal that died with the session
left `warnings` as the only surviving answer. Neither `expect` was relaxed: S4-warnings now asks
its own question, which is what its `value` says it is about.

#### P-4 — seven shipped modules reachable from nothing, three of them DEFENCES · HIGH · **fixed**

*Found by:* `tests/attack/privacy-e5-silence.test.js` §5. *Closed:* 2026-08-29.

The two `crypto/` defences were wired by WP-9 (`probe.js` and `backup.js`, from
`family/familysettings.js`). This pass closed the five `sync/` rows, and **only one of them by
deletion** — which is the outcome the row existed to make impossible:

- **`sync/chain.js`** — ADR 002 §5.4's chain witness, the ONE mechanism the design names for
  detecting a relay that withholds, reorders or renumbers. `pullNow` now imports it and runs it
  over every page, plus a PAGE-CLAIM check: `server/core/handlers/ops.js` states that `nextCursor`
  is *"the seq of the last op ACTUALLY RETURNED"*, so a `nextCursor` past the last row served is
  the relay asking this device to step over rows it never sent — the withhold that leaves no hole
  to find, because the hole is at the END of the page. The first missing seq becomes a cursor
  HOLD. Neither check refuses an op: ADR 002 §8.6 / ADR 003 §10.6 keep the witness
  diagnostic-only, and refusing on its word would let one bad `chain` byte wedge the device.
- **`sync/outbox.js`** — `createParkingLot`. See P-8(b).
- **`sync/cursor.js`** — the durable chain ANCHOR, so a relay that forks the stream ACROSS a
  relaunch is caught on the first page after it rather than adopted as the new truth. It is **not**
  a second transport cursor: ADR 006 §9.1 W1 keeps that in the log, `store.cursor()` is still the
  only value read as `since`, and what the module contributes is its ONE WRITE PATH — `advance()`
  runs the commit first and persists only if it resolves, with `store.noteCursor` inside that
  commit.
- **`sync/protocol.js`** — reached through `chain.js`, which needs its seq helpers.
- **`sync/client.js`** — LZP-501's superseded ENGINE and nothing else. **DELETED**, with
  `tests/tier1/sync-client.test.js`. It was the only importer of the other four, which is the whole
  reason they looked dead.

**A rule this round earned:** *a module is not dead because nothing imports it; it is dead because
nothing NEEDS it.* Four of these five were filed as dead code and three of them were mechanisms
the product was designed to have and did not.

**Mutants:** stop calling `verifyChain` and the page claim → `attack-converge-relay.test.js`
§2/§3, `fleet-harness.test.js` §2a and S4a die. Drop the gap→hold conversion → §2a dies. Never
read the durable anchor → §5's cross-relaunch fork row dies. Remove the mid-stream re-anchor →
§5's *"a MISSING anchor accuses nobody"* row dies.

#### THE HEADLINE — the property the convergence adversary said was missing

> for every op set and every interleaving of partition, reorder, duplication, **compaction**,
> restart and quarantine, the two Macs' register digests agree

`tests/fleet/attack-converge-disorder.test.js` §2, **128 seeds × 30 steps**, alphabet unchanged and
un-narrowed:

- **Without a quarantine event: 128/128 converge** — on content, on the register digests cell by
  cell, stably, with nothing the script performed missing from either board and nothing on either
  board the script never performed. `_e52Warned` fires on **no seed**: this build never writes a
  checkpoint that folds past its own outbox floor.
- **With a quarantine event** (a flipped ciphertext byte, so AES-GCM refuses the op and the cursor
  is released past it) convergence is not the property to assert — a forged envelope must not be
  applied. The property is the one that makes the bar meaningful: **either the two Macs converge,
  or the Mac that lost something SAYS SO.** 128/128: **no run ended divergent and `silent`.** The
  converse control holds too — converged runs are still allowed to be, and are, silent.

The number that matters: before this round the same sweep at 24 seeds diverged on **the majority**;
after E5-2's own arm was fixed it still diverged on **2 of 24**, which is a rate a 24-seed sweep
reports as "it works" on most runs. That is why the headline runs at 128.


---

### 3d. Round 9 — THE WITNESS, AND THE VERDICT IT WAS CLOSING

*Ran:* 2026-08-29, immediately after round 8. A fresh adversary read round 8's own work and
returned one sentence: **"E6 cannot safely be built on this sync engine as it stands."** This
round closes that verdict. Three fixers worked in parallel; one integration pass landed the
cross-file work, built the two headline checks and ran the mutation table.

**The root cause was already diagnosed and was not re-derived:**

> `pullNow` uses `verifyChain` where it must use `createChainWitness`, and it turned a diagnostic
> into a cursor hold.

Round 8's own closing lesson — *a module is not dead because nothing imports it; it is dead
because nothing NEEDS it* — was applied to the FILE and not to the FUNCTION inside it. The round
imported the leaf, left the mechanism behind, and then compensated for the missing mechanism by
giving the leaf a power ADR 002 §5.4 forbids in one sentence: *"it NEVER BLOCKS SYNC in v2 (a
false positive that broke a family's board would be far worse than the attack)."*

`createChainWitness` now has **a real importer**: `src/js/sync/personal.js:168`, one instance per
engine at `:669`, on the product's only pull path. **The only `verifyChain` CALL left anywhere in
`src/` is `chain.js:370` — the witness's own use of its own leaf.** No raw `verifyChain` decides
sync behaviour.

#### R8-1 — an honest relay accused, and a durable record that was two rows · HIGH · **CLOSED**

*Owner:* `src/js/sync/personal.js`, `src/js/sync/chain.js`. *Rows:* `tests/fleet/round8-chain.test.js`
§1a/§1b/§1c, **inverted**.

Two shapes, both on a completely honest relay. **(a)** `chainAnchor` advanced whenever a PAGE
verified; the CURSOR advanced only when nothing in the page was held. F-6's first contact — a
peer's content op overtaking its attestation — is exactly where those differ, so the honest
re-serve of a held page was verified a second time against an anchor taken from INSIDE it and
reported as `seq jumped from 1 to 1`. **(b)** Its durable form was worse: `cursor.js advance()`
persists `{seq, chain}` and does not check the two are the same row, and round 8 handed it the
COMMIT POINT for `seq` and the LAST ROW OF THE PAGE for `chain`. The next launch anchored on a
value that had never belonged to that seq and accused the relay of forging what this device had
invented.

**Fix.** `observe()`'s `fresh` filter drops rows at or below the verified head before any check
runs — a row this device has already folded is evidence about the CALLER, not about the relay.
And the persisted record is looked up BY the commit seq (`chainBySeq`), storing `''` — which
`cursor.js head()` reads as "no anchor" — rather than a chain belonging to a later row.

#### R8-2 — one member removal wedged the space, for ever · CRITICAL · **CLOSED**

*Owner:* `src/js/sync/personal.js`. *Rows:* `round8-chain.test.js` §2 **inverted**, plus a new
CONTROL; `tests/fleet/round9-headline.test.js` §2a/§2b.

`POST /members/remove` purges the removed member's `Op` rows in the same transaction as the
membership write (ADR 003 §6.3, story 20.2). `Op.chain` is a hash chain in insertion order, so
deleting rows makes every later `chain` **unrecomputable by anyone, for ever**. Round 8 turned
every chain finding into a permanent cursor hold, so after the one legitimate destructive
operation in the product the cursor stopped at the hole and every op above it was unreachable,
across relaunches, on a relay that had done exactly what it was asked.

**The rule now, and it is a rule about who owns the hold rather than about which findings are
believed:** *a chain finding may hold the cursor for the pull that discovers it, and not after.*
One honest round trip for a relay that truncated a page; then the witness re-anchors on the row it
was served, does not re-report the break, and sync continues — with the finding standing in
`store.syncChain`. **The hold was moved, not deleted**: mutant M-B1 (delete it) still reddens the
withhold defence, and M-B2 (make it permanent again) reddens the removal rows. Both halves are
pinned.

`noteChain` also gained a second sentence. `withheld` still promises the changes are "still owed",
which is true — the relay holds them. A chain break no longer does: round 8 promised a delivery of
rows that had been deleted on purpose.

#### R8-4 — the ladder destroyed the only copy · CRITICAL · **CLOSED**

*Owner:* `src/js/sync/outbox.js`, `src/js/sync/personal.js`, `src/js/store.js`.

`release()` is now the APPLIED path and the only path in the file that destroys bytes. An oid the
caller parked or touched since its last release is one it has just said it cannot open, so it is
SHELVED — on disk, out of the replay set so nothing spins, revived by the next `load()` with
`tries` reset, bounded by `PARK_REVIVALS = 3`. `terminal()` calls the new `refuse()` rather than
`release()`, which says the transition out loud instead of inferring it from flush order.

**And the refusal is RETRACTED when the revival lands** (`store.retractSyncRefusal`, round 9). The
durable ledger was built for a refusal that is final; one class of refusal is now survivable, and a
ledger that cannot retract is a permanently red indicator — round 8's `healthy`-while-wrong with
the sign flipped. Only the store's own `applied` list can clear it, so a relay cannot clear its own
verdict without making the op apply, which is the cure.

**A measurement worth recording, because it corrects an earlier row.** Over the 128-seed tamper
sweep (`attack-converge-disorder.test.js` §2), before and after the retraction with nothing else
changed:

```
before:  quarantined-at-end 14 · durable ledger 17 · DIVERGED 0 · lost 0
after:   quarantined-at-end  0 · durable ledger  0 · DIVERGED 0 · lost 0
```

Every one of those 17 durable refusals was about an op that had in fact ARRIVED — the tamperer
flips one ciphertext byte per page, and a later page or a relaunch re-serves the op untampered.
Nothing was ever lost on either side of the change. So that row's title (*"a QUARANTINE in the
alphabet costs data"*) was overstated and its non-vacuity control was being satisfied by a stale
record rather than by a real loss. The row is renamed **CLOSED (R8-4)**, its non-vacuity is
re-based on `refusalsReached` — refusals the run REACHED, banked across relaunches — and a new
assertion forbids the retraction from ever following anything but the op actually landing.

#### R8-5 — `park()` reported success after a failed write · HIGH · **CLOSED**

Both exits of `createParkingLot.park()` return `persist()` instead of `await persist(); return
true;`. `pullNow`'s `if (!kept) holds.set(…)` was correct, documented and unreachable; it now
fires, and an unwritable park is the stall its own docblock always claimed it was.

#### R8-6 — a durably held op is invisible for the whole launch · MEDIUM · **HALF CLOSED**

*Row:* `round8-park.test.js` §3, now two rows.

**(a) CLOSED.** `attach()` did not read the durable park at all, so between a launch and its first
successful pull the engine had no idea it was holding anything — for ever, on a Mac that opens its
lid in a tunnel. `attach()` now starts `loadLot()` and RE-EMITS the status when it lands. It
cannot `await`: `attach()` is called synchronously from the mount and returns `detach`, and an
async `attach` would move a `store.subscribe` behind a microtask. It does not have to, because
`family/mount.js:78` wires `onStatus: () => refreshSyncChrome()` — the toolbar is PUSH-fed.

**(b) STILL OPEN**, and owned by `src/js/store.js`: `diagnostics().sync.parked` is
`_log.parkedOps().length`, the LOG's park, which can never count the lot's. It is why a SYNCHRONOUS
poll of `status()` at the instant of launch still reads `healthy`. `sync/status.js` cannot help:
the field exists and answers `0`, so `blindSpots()` has nothing to catch.

#### R8-7 — the closed field set ran on two doors of four · MEDIUM · **CLOSED**

*Owner:* `server/core/handlers/devices.js`. *Row:* `tests/attack/round8-seam.test.js` §1, **inverted**.

`assertAttestationClosed` moved down into `devices.js` and is called inside `verifyDeviceClaim`,
BEFORE the signature — a smuggled field is a shape fault and never a forgery, so S1 could not have
been what caught it. All four doors that persist a `Device` row now reach it.
`tests/server/blindness.test.js` §7a enumerates the doors as data × mutations as data and asserts
the set of handler files able to persist a Device row is exactly three, so a fifth door reddens a
row instead of quietly reopening this.

**And the twin is gone.** Round 8's fix left a private copy in `handlers/spaces.js` (one owner per
file), which §7a characterized as *"the two copies of the closed-set rule differ in one word"* —
within a single round they had already drifted on the `recoveryPubKex` refusal reason. The
round-9 integration pass deleted the twin and pointed `spaces.js` at the one function, passing its
own `safeField`ed name so a client with several devices in one request is still told which. That
characterization row named its own inversion, went red on cue, and was carried out.

#### R8-7b — a device id could name a key-wrap recipient · MEDIUM→HIGH on availability · **CLOSED**

`POST /devices` and `/devices/adopt` took `deviceId` through `requireId` — 128 chars of
`[A-Za-z0-9_.:-]` — where `readDevice` has always pinned `dev_` + 22 b64url. Measured on the
shipped router before the fix: `deviceId: 'rec_mem_…'` → **200**, served back verbatim by
`GET /spaces/:id/members`. The sharp half is availability: `POST /devices/revoke` calls
`deleteKeyWrapsForDevices`, which matches on `KeyWrap.recipientId`, so *register `rec_mem_MAMA`,
then revoke it* deletes that member's recovery wraps for every epoch — ADR 002 §7.3's "the only
path that survives losing every device". Two ordinary requests, one current member, no forgery.

Fixed by `DEVICE_ID_RE` on both doors. `memberId` is deliberately NOT tightened — unknown,
malformed and removed must stay one answer or the route becomes a member oracle.

#### R8-8 — a log quarantine is not an observable · MEDIUM · **HALF CLOSED**

`sync/status.js` gained a `quarantine` row and `fieldValue()` no longer hard-codes
`if (field === 'warnings')` — that hard-coded branch WAS the finding. The row is `state: healthy`
deliberately: making it `error` was measured turning `attack-converge-rejoin.test.js` §2 red (ADR
006 §9.3's converging re-join reaches this exact state), which is round 8's opposite failure and
the control caught it. What it buys is that `silent` is now false from SHARP evidence rather than
from a sentence happening to be in the mixed `warnings` prose channel. The loud half needs
`store.diagnostics().quarantine` to say what the quarantine DISCARDED; still open, `store.js`'s.

#### R9-1 — `fromGenesis` was a ratchet, and it is a report · LOW, durable · **CLOSED**

*Found by:* the round-9 integration pass, landing the chain-witness owner's cross-file item.
*Owner:* `src/js/sync/cursor.js`. *Row:* `tests/tier1/sync-queue.test.js`, **inverted** — it read
*"`fromGenesis` is sticky once true — one full pull earns it for good"*.

`advance()` could raise the flag and never lower it. But `fromGenesis` is not a reward for a past
pull; it is **the right to call an unknown `wit` a fork**, and `chain.js` gives that right up the
instant a break makes verification unprovable from genesis (`s.fromGenesis = false` beside
`s.broken = true`). A ratchet hands the right back at the next launch, and the device then accuses
an honest relay of a fork it can no longer prove — the false positive ADR 002 §5.4 forbids.
Unreachable today (this engine seals `wit: ''` on every push, so `UNKNOWN_WITNESS` cannot fire) and
a durable lie waiting for the day `wit` is populated. An OMITTED `fromGenesis` still carries the
stored value forward, so a caller with nothing to say changes nothing.

#### What round 9 did NOT close, and where each row is

| # | still open | why, and who owns it |
|---|---|---|
| ~~**R8-3**~~ | `chain` is declared `durable: true` and persisted nowhere — a fork detected before a quit is forgotten by the next launch | **CLOSED round 10.** `_stampedCheckpoint` writes `lzp.chain` through `_syncChainForDisk()` (a four-field PROJECTION, so 21.3 holds and a future `chain.js` field cannot silently reach the disk); `_restoreSyncLedger` reads it back under the same quarantine gate the refusals use. `round8-chain.test.js` §3 is INVERTED and gained a second row: the restored verdict must still be WITHDRAWABLE by positive evidence, or the fix trades a silent Mac for a permanently red one. |
| **R8-6(b)** | `diagnostics().sync.parked` counts the LOG's park and can never count the lot's | `round8-park.test.js` §3 row 1. Owner: `src/js/store.js`. |
| **R8-8 loud half** | `diagnostics().quarantine` does not say what was discarded | Owner: `src/js/store.js`, same fix as `_restoreSyncLedger` preserving the ledger. |
| **§7c-R9** | a relay that withholds a row in the MIDDLE of a page and keeps withholding it consumes that row on the second poll | `attack-converge-relay.test.js` §6b, RESIDUAL — it ASSERTS a loss and must be inverted when closed. **Re-verified and re-accepted round 10**, with the cost of the alternative now measured (mutant M-I4). See §4.8. |
| **E6's own** | there is no family-space sync client, so a member removal cannot be driven end-to-end in one row | `round9-headline.test.js` §2a/§2b, joined by a measured store call rather than by assumption. |


---

---

## 4. Needs a decision — a PO must choose, not an engineer

**Three of the seven are answered.** The rulings of 2026-08-27 are recorded verbatim below the
trade-off that produced them, so a later reader sees what was weighed and not only what was
chosen. **Do not re-litigate 4.1–4.3.** §4.4 was opened by the first fix pass; **§4.5 and §4.6
were opened by round 5** and are the two that block real work.

| § | question | opened by | blocks |
|---|---|---|---|
| 4.4 | `GENESIS(index)` above a million entities | fix pass | nothing today |
| ~~4.5~~ | ~~I-3 / R5-7 — a remote denial of service on any family member's device~~ | round 5 | **DECIDED AND BUILT 2026-08-28 — option (a). Nothing.** |
| **4.6** | **R5-11g — a bar edge with no faithful v2 value at all** | round 5 | nothing today; it is a fidelity ceiling |

### 4.1 F-1 — does `board.json` go back to being a fixed point?  · **DECIDED: FIX**

Fixing `reconcileMap` to rebuild the scratchpad map in projection key order restores ADR 001 §5
step 5 (whose stated purpose is byte-stable comparisons), restores v1's fixed-point property, and
removes the embarrassment of a green unit test asserting the sort at the layer where it holds while
the shipped file does not have it. **The cost is that it atomically rewrites `board.json` with
different bytes for every existing user on their next save** — content identical, nothing on screen
moves, but a file that had been stable changes, which is exactly the class of surprise a background
update should not produce.
*(Story 11.4 is **not** violated either way — the file is human-readable, v1-shaped,
`schemaVersion: 1`, zero v2 leakage. ADR 001 §5 step 5 **is** violated today.)*

> **RULING: FIX. The one-time rewrite of existing users' files is accepted.**
> `reconcileMap` now deletes and re-inserts every key so the live map carries the projection's key
> order, exactly as `reconcileList` already rebuilt array order — deleting and re-inserting is the
> only way to reorder a JS object's own keys, and the map object **keeps its identity**, so a
> caller holding `state.scratchpads` still holds it. R3-1 → `FAILED (held)` (`gen0 === gen1 ===
> gen2`), plus **R3-1b** for the identity. The pinned *exemption* in `tests/tier2/retrofit-probe5`
> — a `notPads` filter and a regex escape hatch on the byte compare — is **removed**: `diffs` must
> now be empty and `rawBefore` byte-identical, and the 200-gesture soak reports
> `STATE DIFFS ACROSS THE RESTART: none`. `retrofit-probe6`'s `assert.notEqual(rawBefore, rawAfter)`
> became `assert.equal`. **A3-L1 is NOT closed by this** — an entry object's *own* key order still
> settles only at the next launch (R3-2), which is the same class one level down.

### 4.2 A3-H2 — coerce, quarantine, or refuse, when v2's type table is stricter than v1's  · **DECIDED: COERCE**

Five entry shapes that v1 opens and keeps are dropped by v2's `FIELDS`, and the drop is committed to
`board.json` on the first autosave, so the user's file loses them permanently; the most user-visible
case is `repeatsYearly: 'yes'`, where **a birthday silently stops repeating**. The choice is between
**coercing** the v1 values v2 can obviously read (truthy string → `true`, `4.3.2026` → `2026-03-04`),
**quarantining** the unrepresentable entries into `_v2.quarantine` so a later build can rescue them,
and **refusing to migrate** with a visible message — the last is the only option that never loses
data and the only one that can stop the user in their tracks on upgrade day.

> **RULING: COERCE.** When a v1 board holds a value v2's type table rejects, coerce it to **v1's
> meaning** rather than dropping the entry or refusing the board. **Every coercion must be logged
> to the warnings channel so it is auditable.**
> Implemented as §4b of `migrate1to2.js`, imported wholesale by `replace.js` — see the A3-H2 row
> for the helper-by-helper table. The load-bearing word in the ruling is *v1's*: each helper reads
> the value the way **v1's own code** read it, established by probing the v1 expressions this tree
> still carries, not by guessing. The two carried booleans do not read alike, and a `Boolean(v)`
> shortcut gets `visible: 0` wrong.

### 4.3 A3-M1a — is a permissive door better than a throwing one?  · **DECIDED: CONSISTENT**

The same enumeration that found 27 throwing inputs (F-2) found three that are silently accepted:
`createNoteInline` with `text: null` mints a note that can never render; `recategoriseNote` with
`categoryId: null` is accepted and then quietly repaired to the first category by materialize
step 7; `deleteCategory` with `lastCategoryId: 9` writes a number into a pref register. **Either the
door validates and declines uniformly, or it accepts and the projection repairs uniformly — what it
must not do is throw on a German date and shrug at a `null` note.** Picking one decides what WP-8's
remote path does with a hostile peer, which is why it is worth a deliberate answer now.

> **RULING: make the door policy CONSISTENT.** **Never throw on externally-sourced input** —
> migration, import, a remote peer: refuse-or-coerce, and warn. **Throw only on programmer
> error** — an internal call site passing a bad argument. *"The mix of throwing on 27 hostile
> values and silently accepting 3 others is what was indefensible."*
>
> Applied: every external door refuses-or-coerces and warns (pinned by R3-26c, eight hostile board
> shapes through both doors); `MigrationError` on a non-object board or a bad ctx stays a throw and
> is pinned as programmer error; `flattenPref`'s `RangeError` — the last data-driven throw that
> escaped a door — is caught in both. `store.apply()` is an **internal** door (the 22 UI sites are
> its only callers), so its 27 throws are inside the ruling; its 3 silent accepts are the part that
> is still not one rule, and they stay filed under **F-2**.
> One data-driven throw is still **outside** the ruling and could not be fixed without a second
> decision: **I-4**, `GENESIS(index)` above a million entities. See §4.4.

### 4.4 I-4 — what should the migration door do when it runs out of GENESIS index space?

`GENESIS(index)` encodes a v1 array position into a stamp (§8.1) and the index space runs out at
1,000,000 entities; above that the door throws `RangeError` **on data**, which §4.3 just forbade.
No real board is within four orders of magnitude of it, and **every fix costs something only a PO
can weigh**: dropping the entries past the millionth loses data silently, changing the stamp scheme
moves `_born` for every existing entry and therefore array order (`layout.js:209`'s capacity slice
is order-sensitive, so this is user-visible), and refusing the file with a message is honest but
stops the user on upgrade day. **Doing nothing is also a defensible answer** — it is the only row
in this register whose trigger no user can reach — but it should be *chosen*, not inherited.

---

### 4.5 I-3 / R5-7 — a remote denial of service on any family member's device  · **DECIDED: OPTION (a) · BUILT 2026-08-28**

> **THE RULING, AND WHAT WAS ACTUALLY BUILT.** The lead took option (a) on the E3 red team's
> evidence: (b), a revocation register, is more machinery and is deferred anyway; (c), accept and
> bound, would leave a permanent remote mute on any family member's Mac, which is not acceptable
> in a product for a family.
>
> **The price the table below quoted for (a) — "the first writer wins a race" — is not paid**, and
> that is the one thing that changed in the building. The pair `(sigPubRaw, deviceShort)` is not
> claimed by whoever writes first; it is claimed by whoever can **prove** it, and only one party
> ever can:
>
> > A `dev.<S>` register is a CREDENTIAL only if the op that wrote it was itself stamped by the
> > device it attests — `devOf(cell.stamp) === att.deviceShort`.
>
> `openOp`'s P2, P3 and check 4 together mean an op stamped with `S` was signed by the holder of
> the private key that hashes to `S`. `sigPubRaw` is public and copyable — which is exactly why
> P2 alone never closed this — but the **signature** is not, and the stamp is where it shows
> through into the plaintext the fold sees. So a genuine 16-character collision does **not** now
> "resolve arbitrarily": two proven claims is an 80-bit event and is still refused outright.
>
> The squat is **admitted** (refusing it would hand any member the un-attest primitive `authz.js`
> already refuses for the label), **reported** on the new `AuthzResult.unprovenShorts`, and never
> resolved. Every honest flow already self-attests — ADR 002 §6.3 step 8, §7.3 step 4 — so nothing
> legitimate changes shape.
>
> · **`src/js/core/authz.js`** stage 0a — the one line, plus the reporting surface.
> · **ADR 002 §2.3** "Two shorts, no winner" is rewritten as **"One short, one signer"** and its
>   claim that P2 closes this is struck as false.
> · **Two obligations this creates**, both recorded in §2.3 and in `crypto.contract.js`:
>   §5.2.2 check 4 may not be weakened, made optional, or moved after the decrypt; and nothing may
>   append an op to the log without it having passed `openOp` — or that door must refuse
>   `member.set{dev.*}`. Characterized as **M-I5b**. Owner: **WP-8**.
> · **Rows inverted**, never deleted: `crypto-member-impersonate.test.js` M-I3b/c/d and M-I4 (plus
>   new M-I3e and M-I5b), `round5-attestation.test.js` R5-7b/d, `round4-attestation.test.js`
>   R4-14a/b, `tests/tier1/core-authz.test.js`. **R5-7c and M-I3a are NOT retired**: their claim —
>   that P2 does not close this — is still true and is what made the answer have to come from
>   somewhere else.
> · **Proved in the real WKWebView**, not only in Node: `tests/tier2/crypto-identity.dom.js`.
> · **Not closed, and next door:** the bootstrap. A brand-new device's own attestation travels in
>   an envelope sealed under its own short, so a peer who has never seen that device cannot open
>   the op that would tell it the key. That predates this change and is untouched by it. WP-9.
>
> The original trade-off analysis is kept below verbatim, because the reasoning that ruled out
> (b) and (c) is the reasoning a later reader will want.

**The trade-off, in two sentences.** `attestationOf` resolves a contested `deviceShort` by
**refusing it**, which is the safe answer to *"two attestations claim this short"* and the
catastrophic answer to *"someone deliberately filed one"* — so a rule written to prevent
impersonation instead hands any family member a button that silently and permanently mutes any
other member's Mac. Resolving contested shorts by **first claim on `(sigPubRaw, short)`** keeps a
victim's device working and moves the failure onto the squatter, at the cost of admitting that the
first writer wins a race the protocol does not otherwise arbitrate.

**Why it is a decision and not a bug fix.** The three candidate answers differ in what they
promise the family, not in how hard they are to code:

| option | what it costs | what it buys |
|---|---|---|
| **(a) first-claim on `(sigPubRaw, short)`** | the first writer wins a race; a genuine 16-char collision now resolves *arbitrarily* rather than safely | the attack stops working — a squatter cannot displace a key already bound |
| **(b) a revocation register** | a new op kind, a new authority question (*who may revoke?*), and every question ADR 004 asks about redaction, asked again | the only option that can ever **undo** a mistake; the fold currently has no way back from anything |
| **(c) accept and bound** | the hole stays; the family is asked to trust its own members, which is what a family calendar assumes anyway | nothing to build; honest, if it is written down where a user can read it |

**The mechanism, for whoever decides.** The short is the last 16 characters of every stamp that
device has ever written, so it is **trivially discoverable** — it is not a secret and was never
meant to be one. A bare `dev.*` attestation is **self-authorizing** (G-1), so *anyone* can file
one. `dev.*` is **write-once**, so the victim re-attesting changes nothing. There is **no
revocation anywhere in the fold**. The result is permanent: every sealed envelope from that Mac
parks for ever, and the user's symptom is "my calendar stopped syncing and nobody can say why".

**WP-6's owed P2 check does NOT close it**, and this is the part that must not be forgotten:
`sigPubRaw` is a **public key travelling in the victim's own register**. The squatter copies it,
tells the truth about it, and passes P2. Any plan of the form "we'll fix I-3 when we do the
attestation binding" is wrong; the binding must be `(sigPubRaw, short)` **first-claim**, i.e.
option (a), or P2 buys nothing here.

> **P2 HAS NOW SHIPPED, AND THE PARAGRAPH ABOVE WAS RIGHT — 2026-08-27, E3.**
> `verifyAttestation` enforces P2 as a **MUST**: it refuses a validly-signed blob whose
> `deviceShort` is not `crock32(SHA-256(sigPubRaw)[0..10])`, and `attestDevice` refuses to mint
> one. **This register's prediction held**: P2 buys *self-consistency*, not identity, and the
> squat still works. `tests/tier1/crypto-pairing.test.js` demonstrates it end to end — it mints a
> real paired device, then has a **different member** copy its `sigPubRaw` and `deviceShort`
> verbatim into her own record and file a blob that **verifies**.
>
> **[SUPERSEDED 2026-08-28 — §4.5 is DECIDED and BUILT; see the ruling at the head of §4.5. The
> paragraph below was right that option (a) was the only answer and right about P2; what it could
> not know is that option (a) does not have to be a race.]**
> So **§4.5 is still open and option (a) is still the only answer.** What changed is only that
> the seam downstream of it is now built and is built to survive the gap: `openOp` treats
> `attestationOf` as a **partial function** and **parks** a squatted short rather than opening it
> under the wrong key. Nothing under `src/js/crypto/` touches `authz.js`, and nothing downstream
> may be built as though `deviceShort -> DeviceAttestation` were a function. Characterization rows
> named *"I-3 / R5-7 IS STILL OPEN"* now exist in **both test tiers** and in three separate crypto
> suites, so this cannot be re-planned away. See `docs/v2/E3-VERIFICATION.md` §8.

→ `tests/attack/round5-attestation.test.js` R5-7b (one op mutes a device, permanently), R5-7c (P2
does not close it — the row exists so this cannot be re-planned), R5-7d (`authz.js:882` already
rules this trade out for the *label*, and ships it for the *short*).

### 4.6 R5-11g — a bar edge with no faithful v2 value at all  · **CLOSED 2026-08-27 (round 7) — NOT A DECISION AFTER ALL**

> **The dilemma below was real but it was not a dilemma about *fidelity*; it was a dilemma about
> *one rule serving two fields*.** R6-10/R6-11 dissolved it, and no PO ruling is needed.
>
> **The premise that was wrong.** *"An edge sorting inside the alphabet has no `YYYY-MM-DD` at its
> position"* is true, and irrelevant: `layout.js:133` never asks for the value at that position, it
> asks four **comparisons**. `DATE_RE` accepts a finite, totally ordered set, so every text has a
> floor and a ceiling in it; `floor(t)` reproduces every `<` and `ceil(t)` every `>`. The rule
> *"take the floor unless it is a last-of-month, then the ceiling unless it is a first-of-month"*
> covers **all three classes with no split**, and the two ends fall out of it unchanged.
>
> **The collision with finding 6 was a category error, and the answer is per FIELD, not per
> project.** A **note date** is looked up by map equality (`layout.js:61-79`), so *"which day is
> this"* is genuinely the question and honouring a zone offset would smuggle a timezone into a
> format that has none — **finding 6's refusal stands, unchanged**. A **bar edge** is only ever
> compared, so that question is never asked of it and the floor is a **position**, not a reading.
> Measured: `'2026-04-01T23:00:00-05:00'` as a `startDate` is 9 columns in v1 and now 9 in v2 (was
> 12); as an `endDate` 4 and now 4 (was 12); on a note it is still refused. **For a bar edge,
> `coerceToV1Date` is now never consulted at all** (`isV1BarEdge`).
>
> **One genuine ceiling survives, and it is much smaller than the one filed here.** For five texts
> the alphabet is empty where v1's two tests both want a member — verified independently at
> integration: the floor is a `…-12-31` and the ceiling a `…-01-01`, so both candidates fail their
> guard. There the **column set is still exact** and exactly one continuation chevron moves. Named,
> measured and proved empty in `round6-coercion.test.js` **R6-11c**, and carried in
> `tests/helpers/domains.js` as `D6_NO_MEMBER` with a per-pair proof. **This is a ceiling that is
> now explicit, which is what the paragraph below asked for.**
>
> **And one residual that is knowingly unreproducible, documented in `coerceToV1BarEdge` and not
> fixed:** an **object or array** bar edge. `String({})` sorts above the alphabet and v1 really does
> compare it (a `startDate` of `{}` is painted in no column; v2 paints twelve), while
> `String(['2026-03-04'])` is a date but `layout.js:136` then calls `parseISO` on the array and
> **v1 throws**, taking the board down. There is no v1 rendering to preserve for the array, and
> honouring the object would mean reading `toPrimitive` as a date field's meaning. Both stay
> dropped. → **R5-11g / R5-12b / R5-12e are inverted** in `round5-coercion.test.js`.

*The original filing is kept below, because the argument that dissolved it is only legible against
what it dissolved.*

**The trade-off, in two sentences.** R5-11 fixed the two classes where a faithful value exists —
text sorting outside `DATE_RE`'s alphabet, which maps to the ends of that alphabet — but an edge
sorting **inside** it (`'1.3'`, `'2026-03-04 bis 2026-03-09'`) has **no** `YYYY-MM-DD` at its
position, so it is still dropped and the bar still runs to the far edge where v1 drew one column
or none. The complete fix is a **floor** — *the greatest date that still sorts before this text* —
and it collides head-on with finding 6's normative refusal of a zoned datetime, because
`'2026-04-01T23:00:00-05:00'` floors to `'2026-04-01'`, which is the day v1 painted and **not** the
day that instant names in Berlin.

**So the question to the PO is which fidelity wins**: matching what v1 *painted* on every input,
or refusing to invent a day for a value that names an instant in another timezone. They cannot
both be honoured by one rule, and R5-12b's letter breaks if the floor is taken. The residual is
bounded and measured — the row is annotated `SUCCEEDED (defect, NARROWED)` and left green on
purpose — so nothing regresses while this waits. It blocks no work; it is a ceiling on how close
v2 can get to v1, and it should be an explicit ceiling rather than an accident.

→ `tests/attack/round5-coercion.test.js` R5-11g.

### 4.7 ADR 006 §12.6 vs ADR 001 §7.4 — **RESOLVED, not a decision**

Listed here because the round-5 brief flagged it as possibly needing a ruling. **It does not.**
R5-2e resolved it in code *and in the ADRs*: §12 rule 6 is amended to "a precondition for adoption,
not an instruction to try", ADR 006 gains §7.1 stating the two rules and why §12.6 loses, and **ADR
001 §1.3/§7.4 is untouched** — the rule protecting something real was kept and the rule asking for
the impossible was the one that gave. See R5-2e's MEDIUM narrative. Nothing is owed to a PO here.

### 4.8 R9-6b — how does a client re-ask for ONE seq?  · **OPEN, and it is a CADENCE decision**

*Opened by:* round 9's closure of R8-2. *Owner:* ADR 003 §4 / §8.2 — the protocol, not the witness.
*Pinned by:* `tests/fleet/attack-converge-relay.test.js` §6b, which ASSERTS the residual loss.

R8-2's bound — *a chain finding may hold the cursor for the pull that discovers it, and not after*
— is what makes a member removal survivable. It has one cost, and it is exactly one: a relay that
withholds a row in the MIDDLE of a page and keeps withholding it consumes that row on the second
poll. The loss is permanent, one-sided, and REPORTED (`error`, plus a gap finding that never
clears) — not silent, which is the property the whole round is about.

**The client cannot simply keep asking**, and this is the part that makes it a decision rather than
a bug. `GET /api/v1/ops` can only be asked *"everything after `since`"*. So "keep asking for the
hole" and "block every op above it" are the SAME REQUEST, and blocking every op above it for ever
is the wedge R8-2 just closed. The protocol offers no third option today.

Two ways out, neither of them in scope for round 9, and the choice between them is a cadence
question:

**(a) A bounded RE-ASK.** `since = hole − 1`, N times, ladder-bounded exactly as `maxDeferrals`
bounds a park. The protocol already permits it — it is an ordinary `GET /ops` — and no ADR
describes it. Unbounded, it re-fetches pages for the life of a purged space; bounded, it still
loses to a patient relay. It costs bandwidth and no new endpoint.

**(b) A seq RANGE request.** One new query parameter, and the client can ask for exactly the row it
is owed. It is a protocol change, an ADR amendment and a relay release, and it makes the "which
rows have you not got" question answerable — which is a metadata question, so 21.1 has to be
re-asked about it before it is designed.

Round 9 deliberately added neither: an unbounded re-ask is a worse failure than the one it fixes,
and a bounded one is a number nobody has chosen. **A PO or the protocol owner picks; an engineer
should not pick a retry count that is really a privacy trade.**

**RE-VERIFIED AND RE-ACCEPTED, round 10.** `attack-converge-relay.test.js` §6b is untouched and
still asserts the loss; it is green, which means the defect is still exactly as described. Round 10
did not close it and deliberately did not try: the genesis-page defence it *did* land (R10-2b) is a
different shape — an *unanchored* mismatch at row zero, not an *anchored* mid-page gap — and §4.8's
bounded re-ask is still a PO call, not an engineer's.

What round 10 adds is the **cost of the alternative, measured rather than argued**. Mutant **M-I4**
(make a chain verdict un-clearable, which is what "keep asking until you get it" amounts to at the
verdict level) turns `round9-headline` §2b, `round8-chain` §2 and `sync-domains` S4c red **on a
legitimate member removal** — three rows, in three files, all reporting a permanent red light on a
family that did nothing wrong. That is the same wall R10-2 hit, from the other side, and it is the
strongest available argument that (a) must be BOUNDED and (b) is the only clean answer.

**This row stays on the accepted-defect list (§7c) and is not owed by anybody until that ruling.**

## 5. What was attacked and held — recorded so it is not re-attacked

Both audits spent most of their time on things that turned out to be right.

**Undo and the transaction seam** — a caller's held entry reference survives an unrelated
transaction; a listener firing on the transaction sees the `[L]` pref **and** the new content; a
throwing constructor leaves nothing half-applied; re-entrancy through `emit()` lands as its own undo
step in correct LIFO; `registers()` hands out a memoised fold that append invalidates rather than
mutates; undo spanning `deleteCategoryReassign` whose entries were later edited *and* recategorised
round-trips over three ⌘Z and three ⌘⇧Z with `lastCategoryId` correctly **not** undone (rule U6);
undo is refused after an import and redo after a snapshot restore; undo after a remote fold restores
my field and leaves the peer's concurrent write standing (18.5) without touching either stack (U2).
*(R3-7…R3-19)*

**Persistence and the v1 shape** — ten boards including WP-1 round 1's four bricked shapes all open
and match v1 note-for-note; `replaceAll()` never throws on any garbage and always leaves a legal v1
board; an unparsable checkpoint is tolerated; `board.json` alone reloads byte-for-byte identically;
solo mode writes no second file; export → import → export is a fixed point; two live stores over one
`board.json` are last-writer-wins **exactly as v1 was** — recorded so it is not mistaken for
something the op log fixed. *(R3-29…R3-38, R3-42)*

**16.1 private by default** — all four doors that can mint an entry force `privat`
**unconditionally** (assignment, not defaulting): migration (`migrate1to2.js:259-263, 654-660`),
import/snapshot restore (`replace.js:228-233`, where the file's request is *handed back* as
`plan.reshares` and never granted), the `mutate()` diff (`store.js:245` — an existing entry's
`visibility` is not in `spec.fields`, so a direct `state` write cannot move it at all), and the 22
UI sites (`ops.js:751, 793, 851`; **no call site passes the argument**). A hand-edited `board.json`
carrying `visibility:"geteilt"`, `coEdit:true` produces **zero** ops granting exposure through
either door. The residual is **F-5**, and it is on none of those doors.

**A3 categories are never synced — structurally.** `FIELDS` declares eight kinds and there is no
`fcat`, no `fpad`, no `pub.category*` and no `pub.*` field on `cat` anywhere;
`OP_KINDS['pub.set'].entities = ['fnote','fbar']`. There is no op that can address a category in a
family space. A5 (pads stay private) holds by the same absence.

**18.4 undo scoped to own actions** — three independent enforcements: `undo.js:captureImages`
**throws** on any op whose `act !== me`, so a foreign op cannot enter the stack even by programming
error; `applyRemote` calls neither `push` nor `clear`; an import clears both stacks.

**11.6 migration, on a real board** — `materialize(foldAuthorized(migrateV1(b).ops))` deep-equals
`stripV2Fields(v1migrate(b))` on the PO's actual `board.json` (20 notes / 13 bars / 6 cats / 2 pads,
42 ops): **0 warnings, 0 rejected, 0 parked**.

---

## 6. What neither audit could execute

Not findings — **holes in the evidence**, and where the next round should start.

1. **The family half of `applyRemote`** (`pub.set` / `member.set` / `space.set`, co-edit, admin
   unshare). In solo mode `familySpaceId === null` and `foldAuthorized` fails closed with no
   attestation verifier, so **every** family op is rejected `unattestedDevice` before any of the
   interesting logic runs. Stages 3a/3b were unreachable through the store.
2. **Unproven hypothesis, flagged for WP-8/WP-9:** `applyRemote` skips only `verdict.rejected`,
   **never `verdict.parked`** — a parked-by-authz op is appended to the log, where `_log.append`
   re-classifies it with `classifyOp` alone and folds it. The only authz-only park reason is
   `UNSHARE_SHAPE`, which lives on the family path and is unreachable per (1). **If that reason can
   ever be produced, `store.js:687`'s claim that "`registers()` stays the authorized fold" is false.**
3. **Authz over a compacted history.** After a checkpoint load, `_log.ops({includeParked:true})`
   returns only the tail, so the op set `foldAuthorized` walks for the admin chain and the device
   attestations is **incomplete** — ops admissible before a relaunch could be refused after.
   Unreachable today only because the store never produces a checkpoint (A3-M5).
4. **A genuinely concurrent two-process race** — real filesystem, real interleaved writes,
   `board.json`'s atomic rename losing to itself. The two-Macs work simulated two module instances
   over one shared `localStorage`, which gets the identity and authz half right and says nothing
   about the write-ordering half.
5. **The Tauri path** — no Rust toolchain on this machine (STATUS §8). A3-M5's `truncate_ops`
   finding is **read** from `src-tauri/src/lib.rs:134`, not run.
6. ~~**`npm run test:dom` was not re-run** by either audit, and the DOM suite has not been re-run
   since the E1 agent's changes landed in the tree either.~~ **CLOSED 2026-08-27**: the fix pass ran
   it. **278 pass / 0 fail over 15 files, tier 2 PASS**, with E1's four new files in the tree
   alongside the fix pass's changes to `retrofit-probe5` / `retrofit-probe6`. The isolation guard
   (`~/Library/Application Support/LangzeitPlaner` untouched) held.

### 6b. The ugly corpus, measured — 500 seeds

**A class at zero frequency means the corpus cannot reach the code it was written for**, so P14
asserts every class is present in at least 1% of seeds and prints the table on failure. Observed,
`generateUglyBoard(0…499, {defaults})`, **refreshed after round 5**:

| ugly-value class | seeds hit | frequency | added for |
|---|---|---|---|
| over-length text/label | 430/500 | 86.0% | earlier round |
| a date that names one day but is not ISO | 401/500 | 80.2% | A3-H2 |
| undrawable entry | 375/500 | 75.0% | earlier round |
| unknown keys | 368/500 | 73.6% | earlier round |
| a truthy non-boolean flag | 335/500 | 67.0% | A3-H2 |
| non-string text | 334/500 | 66.8% | earlier round |
| a bar with one end | 322/500 | 64.4% | A3-H2 |
| null settings | 305/500 | 61.0% | earlier round |
| an id v2 cannot use | 294/500 | 58.8% | A3-H2 |
| duplicate ids | 193/500 | 38.6% | earlier round |
| **a bar edge sorting ABOVE every date v2 can hold** | 193/500 | 38.6% | **R5-11** |
| **a bar edge sorting BELOW every date v2 can hold** | 166/500 | 33.2% | **R5-11** |
| dangling categoryId | 123/500 | 24.6% | earlier round |
| empty scratchpad | 55/500 | 11.0% | earlier round |
| a non-string scratchpad | 47/500 | 9.4% | A3-H2 |
| empty categories | 43/500 | 8.6% | earlier round |
| unrenderable startMonth | 24/500 | 4.8% | earlier round |
| a bar with no dates at all | 24/500 | 4.8% | A3-H2 |

**Read the movement, not just the numbers.** Round 5's generator block consumes the rng stream, so
several existing rows moved even though nothing about them changed — `a bar with one end` 23.2% →
64.4%, `a date that names one day but is not ISO` 57.6% → 80.2%, `empty scratchpad` 11.4% → 11.0%,
`a bar with no dates at all` 5.0% → 4.8%. **This is why the table is regenerated and pasted rather
than hand-edited**: a stale corpus table reads exactly like a fresh one.

**The two new classes are reported separately, on purpose.** They were one class until round 5, and
a merged count goes green on a corpus that has quietly become one-sided — which is precisely how
R5-11 survived four rounds: `generateUglyBoard` reached only the side that sorted *above* the
range, so the empty-string case, the commonest hand-edit there is, was never generated. P14 now
enforces the 1% floor on both halves independently, and **mutant row 41** is the corpus losing the
ABOVE half again.

**No class is at zero.** P13 (the two doors produce the same board for the same bytes) runs over
this corpus and is green; it is the property that caught **both** of the mutants that reverted only
the import door, in the first pass and again in round 5.

`{toString(){}}` is deliberately **not** in the corpus: the harness `structuredClone`s every board
and a function kills the fixture rather than the door. That row lives in the hand-written attack
file instead.

---

## 7. The mutation table — every fix, and the test that dies without it

**The rule this pass worked to: a fix with no test that dies is not fixed.** Each row below was
reverted in a **scratch copy** of the whole tree (`…/scratchpad/mut`, never in the repo) and the
three node suites re-run. The scratch copy carries a copy of `.git`, because
`v1-frozen-store.test.js` re-derives its fixture from it and would otherwise fail in every row for
the wrong reason.

| # | fix reverted | rows that die | first row named |
|---|---|---|---|
| 1 | **A3-C1** — the whole `logBelongsToBoard` verdict is ignored | **11** | R3-31 · one stray line in `ops.jsonl` is quarantined |
| 2 | **A3-C1 layer 1 only** — a checkpoint with no `lzp` envelope is trusted | **2** | R3-34 · an unreadable checkpoint is quarantined |
| 3 | **A3-C1 layer 2 only** — a log that knows none of the board's entities is accepted | **8** | R3-31, R3-35d · another board's checkpoint is refused |
| 4 | **A3-H1** — the try/catch around `_log.load` | **2** | R3-35 · a checkpoint that parses but has no `v` |
| 5 | **A3-H3** — `applyRemote`'s shape pass | **2** | R3-23 · one bad entry costs that entry and nothing else |
| 6 | **F-1** — `reconcileMap`'s delete-and-reinsert | **2** | R3-1 · `board.json` IS a fixed point |
| 7 | **F-8** — `replaceAll` appends instead of replacing | **2** | R3-43 · `replaceAll` APPENDS to the channel |
| 8 | **H-2 / bool** — `coerceToV1Bool` refuses instead of probing v1 | **9** | R3-28 · a truthy `repeatsYearly` keeps repeating |
| 9 | **H-2 / bool** — `Boolean(v)` instead of probing v1's own expressions | **2** | the two booleans do not read alike (`visible: 0`) |
| 10 | **H-2 / date** — `coerceToV1Date` refuses every non-ISO shape | **5** | a note dated `4.3.2026` is preserved by v1 and by v2 |
| 11 | **H-2 / id** — `coerceToV1Id` refuses | **1** | a numeric id keeps the entries that POINT at it |
| 12 | **H-2 / mint** — `entityIdOf` never invents an id | **2** | **P13** · the two doors, 500 ugly seeds |
| 13 | **H-2 / bar edge** — `missingBarEdge` stops anchoring a one-ended bar | **3** | a bar with one end is anchored to the other |
| 14 | **H-2 / pad** — a numeric scratchpad is dropped again | **6** | R3-26 · all five boards v1 keeps are kept |
| 15 | **H-2 / keep note** — `renderableNote` requires a date again | **11** | `renderable(note)` · an OWN note with no date is on the board |
| 16 | **H-2 / keep bar** — `renderableBar` requires both ends again | **3** | `renderable(bar)` · an OWN bar is v1's array |
| 17 | **H-2 / repeat guard** — a repeat with no anchor is minted again | **2** | **P13** |
| 18 | **H-2 / IMPORT DOOR ONLY** — `replace.js` stops coercing ids, migration keeps doing it | **2** | **P13** — the property that says the two doors are one door |
| 19 | **F-10** — `parseAttestationBlob` returns the WP-1 three-field payload | **3** | the decoded attestation carries `sigPubRaw` |
| 20 | **I-5 both locks** — the settings-depth caps | **1** | R3-36b · a board nested thousands deep BOOTS, at every depth |
| 21 | **I-5 mint lock only** | **1** | R3-36b |
| 22 | **I-5 projection lock only** | **1** | a pref NAME nested past the cap is dropped by the projection |
| 23 | **A3-H3 / clock — the reachability claim** (`validateOp` stops refusing a non-stamp `ts`) | **1** | R3-23b · ten hostile stamps, each refused by name |

**Round 5 added twenty-six more.** Same rule, same scratch copy (`…/scratchpad/mut`, with `.git`),
all three node suites re-run per row. **Every count below was measured by the integration pass, not
carried over from a fixer's report** — and counting is leaf rows only: node reports a failing
`describe` as a `not ok` line too, and including those inflates every number by one per block.

| # | fix reverted | tier1 | attack | prop | first row named |
|---|---|---|---|---|---|
| | **R5-3 — the recovery path** | | | | |
| 24 | `init()`'s branch back to `kind !== 'ok' && hasLog ⇒ _recoverFromLog` (round 5's own **M1**) | — | **4** | — | R5-3a · an unparseable board.json is a READ-ONLY boot |
| 25 | `loadBoardFile` drops `failure = readError(e)`: a thrown native read is `absent` again (round 5's own **M2**) | — | **2** | — | R5-3c · storage reports four statuses |
| 26 | classify correctly but never set `bootFailure` — right board on screen, session still writable | — | **5** | — | R5-3a |
| 27 | drop `&& !this.bootFailure` from the sequester gate — a failed boot renames the evidence | — | **2** | — | R5-3a |
| 28 | `const snap = null` — `snapshots.json` is never consulted | — | **2** | — | R5-3a |
| 29 | `_projectSafe` assigns `bootFailure` again, erasing *why the board could not be read* | — | **1** | — | **R5-3e** · the FIRST reason wins |
| 30 | `persistNow`'s read-only sentence back to one-size-fits-all "could not be drawn" | — | **1** | — | **R5-3f** · the warning says which of the four happened |
| 30b | …and the opposite: the "could not be drawn" claim deleted for *every* reason | — | **1** | — | **R5-3f**'s third clause — the non-vacuity control |
| | **A3-M5 / R5-4 — the log records** | | | | |
| 31 | the `appendOps` call deleted (round 5's own **M4**) | — | **6** | — | R3-39 · `_persistOps()` appends |
| 32 | `_stampedCheckpoint` → `checkpoint({horizon: peek()})`, emptying the outbox (round 5's own **M3**) | — | **3** | — | R3-35c · a log this build wrote is still trusted |
| 33 | step ④'s guard dropped — truncate unconditionally | — | **5** | — | R3-39 |
| 34 | `TAIL_COMPACT_AT = Infinity` — the tail never compacts | — | **1** | — | R5-4e · the tail is BOUNDED |
| 35 | `resolveHorizon('advance')` back to `maxLiveStamp() ?? horizon` | **1** | — | — | `core-oplog.test.js` · compact() with every live line below the horizon |
| | **R5-11 — the coercion class** | | | | |
| 36 | `coerceToV1BarEdge` returns `null` — the whole fix | **1** | **11** | — | `INVERTED (R4-10)` · a bar with one end keeps ONE end |
| 37 | the edge rule sees the **trimmed** value, i.e. runs after `coerceToV1Date` | — | **1** | — | R5-11a · `endDate = " 2026-03-04"` |
| 38 | the edge rule wired into the **import door only** | **1** | **11** | **1** | `INVERTED (R4-10)`, and **P13** — the property that says the two doors are one door |
| 39 | the drop is never recorded (`wasDropped → false`) | — | **1** | — | R5-11g · the false fidelity claim returns |
| 39b | the dropped tail printed for an **absent** edge too (`wasDropped → true`) | — | **1** | — | R5-11h · R4-10 is untouched by the fix |
| 39c | the `NOT DRAWN on any day` branch deleted | — | **1** | — | R5-11b · the warning says what the user will see |
| 40 | `EARLIEST_DATE` / `LATEST_DATE` **swapped** | **2** | **12** | — | `INVERTED (R4-10)` |
| 40b | `EARLIEST_DATE = '0001-01-01'` — one step inside the alphabet | **1** | **7** | — | `core-ops.test.js` · the two ends of `DATE_RE` |
| 41 | the corpus loses the ABOVE half | — | **1** | **1** | R5-13a · both sides are generated, and **P14** |
| | **R5-5a — the post-condition's blind spot** | | | | |
| 42 | `v1ContentOf` stops emitting `order[spec.key]` | — | **1** | — | R5-5a · swapping two `_born` values is REFUSED |
| 43 | `postConditionDetail` loses the order clause | — | **1** | — | R5-5a |
| | **R5-2e — the clock skew** | | | | |
| 44 | the `_clockSkew` precondition removed | — | **1** | — | R5-2e · a skew of >24 h DEFERS and destroys nothing |
| 45 | `DEFERRED_QUARANTINE` emptied — a deferred log is renamed after all | — | **1** | — | R5-2e |
| | **R5-12d — the corrected claim** | | | | |
| 46 | R5-12d closed the other way: the ISO tail tightened to a real clock | — | **2** | — | R5-12d · the tail is a wall-clock time BY SHAPE |

**Round 5's own mutants were re-run on top of the round-5 fixes and are still lethal** — the check
that says one fix did not quietly undo another:

| round 5's mutant | tier1 | attack | prop | first row named |
|---|---|---|---|---|
| **M2** (recovery: a thrown read is `absent`) | — | 2 | — | R5-3c · storage reports four statuses |
| **M3** (the checkpoint folds the whole tail) | — | 3 | — | R3-35c |
| **M4** (nothing appends) | — | 6 | — | R3-39 |
| **M9** (`Boolean(v)` instead of probing v1) | **7** | **48** | **3** | `R3-28 INVERTED` · a truthy `repeatsYearly` keeps repeating |
| **M10** (`coerceToV1Date` refuses every non-ISO shape) | **4** | **33** | **3** | `R4-9` · `4.3.2026` |

**Two "fixes" arrived at the integration pass unproven** — rows 29 and 30. Reverting either killed
**nothing** in any of the four suites, which is the same thing as not having a fix. R5-3e and R5-3f
were written to close them *before* they were recorded here. That is the rule working, and it is
written down because the alternative is a register that lists a fix nothing defends.

### 7a-round7. Round 7 — twelve mutants, re-run by the integration pass in one clean tree

Every row below was applied to a **fresh scratch copy at the round-7 head** (`…/scratchpad/mut`,
never in the repo, reset between rows) and all three node suites re-run. **Baseline in that copy:
tier1 0 fail · attack 1 fail · property 0 fail** — the one attack failure is
`v1-frozen-store.test.js` shelling out to `git` in a directory that is not a repo, and it is
subtracted from the `attack` column below. The seven mutants the brief names by letter are **F1,
F2, F3, F4, F5, F6, F7**; the suffixed rows are the near-misses that distinguish a real fix from
one that merely passes.

| # | fix reverted | tier1 | attack | prop | first row that dies |
|---|---|---|---|---|---|
| **F1** | **R6-3** — round 6's own proposal: prune `bodies` by `keepIds` (a **purge**, not a cap) | 1 | 1 | — | tier1 `the cap is a CAP and not a purge: a SUPERSEDED body…` · then **R6-3c** |
| **F1b** | **R6-3** — delete the `boundBodies()` call outright | 1 | 2 | 2 | tier1 ``bodies` stops at the cap…` · **R6-3a**, **R6-3b** · **D4a**, **D4b** |
| **F2** | **R6-4a/b** — `_clockSkew` back to `ops({includeParked:true})` | — | 2 | 1 | **R6-4a** · a single 48 h-future op costs THAT OP AND NOTHING ELSE · **D2** |
| **F2b** | **R6-4c** — restore `nowMs: Date.now()` to `foldAuthorized` | — | 1 | 2 | **R6-4c** · the op authz refuses is refused AT EVERY STAMP · **D2**, **D3** |
| **F3** | **R6-5a** — `loadBoardFile` treats `''` as "this store held nothing" again | — | 2 | 2 | **R6-5a** · a ZERO-BYTE board.json is a FILE · then **R6-5a2**, **D1a**, **D1b** |
| **F4** | **R6-5c/d** — `classifyBoardFile` back to `board0 !== null`; `Array.isArray` is the whole guard | — | 3 | 1 | **R6-5c** · `{}` is NOT a board · then **R6-5d**, **R6-5g**, **D1b** |
| **F4b** | **R6-5d** — `boardKeysOf` counts a key that is PRESENT, not one that is WELL-TYPED | — | 1 | 1 | **R6-5d** · `{"notes":"nicht ein array"}` (D1-b17) · **D1b** |
| **F5** | **R6-6a/b** — the recovery's OUTCOME not enumerated: a failed recovery falls out as an empty **writable** board | — | 3 | 1 | **R6-6a** · read-only over the snapshot · then **R6-6b**, **R6-6f**, **D1c** |
| **F5b** | **R6-6e** — `_logAssertsNothing`'s `catch` answers `true`: a log that will not *draw* reads as empty | — | 3 | — | **R4-8a** · a poisoned setting is repaired, not read as emptiness · also **R6-6e** |
| **F6** | **R6-7** — the RESTORE branch mints a fresh `_born` (`{born:true}`) | — | 1 | 2 | **R6-7a** · a Time-Machine restore over this board's OWN log is honoured · **D5a**, **D5b** |
| **F7** | **R6-10/11** — round 6's own proposal: **the floor, always** | — | 3 | 1 | **R6-10a** · the bar v1 drew NOWHERE is drawn nowhere · then **R6-11c**, **R6-11d**, **D6b** |
| **F7b** | **R6-11** — the enumeration's own proposal: `startDate ⟶ ceiling`, `endDate ⟶ floor`, always | — | 2 | 1 | **R6-11a** · a value that sorts inside and names no day is KEPT · **R6-11b**, **D6b** |
| **F7c** | **R5-11's** two-ended guard restored: `coerceToV1BarEdge` returns `null` inside the range | — | 8 | 1 | **R5-11g** · a value that sorts INSIDE the range has a faithful date after all · **D6b** |

**Three of these initially killed nothing and the rows had to be rewritten, which is the part
worth recording.** F1 and the live-line-guard mutant were both satisfiable by the *wrong* fix until
their rows were re-written against the input that distinguishes — a **superseded** op, and a spliced
id that still holds a line at eviction time. And `D4a`/`D4b` go **STALE** rather than silently
passing when the D4 fix is applied, which is what proves those domain rows are not vacuous.

**F6-snapshot, recorded separately because of what it revealed.** Setting `_standIn`'s
`const snap = null` — `snapshots.json` loaded and never consulted — reddens **eleven** attack rows
(R5-3a, R6-5a/b/c/d/e/f/g, R6-6a/b). Story 11.5 is now load-bearing on the disaster path, which is
what §5.6 always claimed and nothing previously checked.

### 7a-round8. Round 8 — fourteen mutants, in one clean scratch tree

Every row below was applied to a **fresh copy of `src/` at the round-8 head**
(`…/scratchpad/mut`, never in the repo, `src/` restored between rows) and the named suites re-run.
**Baseline in that copy: 0 fail in every suite listed.** The three the brief names by hand are
**M3** (P-8's park branch → the two-Mac first-contact row), **M4** (the cursor rule → *"the cursor
is held with it"*), and **M5** (the chain wiring → a withholding-relay row **through the product's
own pull path**, not the fleet's direct `verifyChain` import).

| # | mutation | the row that dies |
|---|---|---|
| **M1** | `_outboxHorizonCap()` — restore the old stand-down (`cap === null` ⇒ no cap) | `attack-converge-outbox.test.js` §1, all four rows; `sync-domains` S1a, S1b, S2a, S2b, S3a, S4a |
| **M2** | `oplog.load()` — feed the tail line its own `seq: null`, drop `seqById` (L-4) | `core-oplog.test.js` *"L-4 · `load()` restores a tail line's ack from `checkpoint().seqs`"*; `attack-converge-disorder.test.js` §2 (both rows); `attack-converge-outbox.test.js` §1 |
| **M3** | `pullNow` — `out.status === 'park'` → `out.parked` (the dead field) | `sync-personal.test.js` §4b *"P1 ATTESTATION — held, cursor held, nothing quarantined"*, *"P4 EPOCH"*, *"VERSION"*, *"a held op reports WHAT WOULD CURE IT"*, *"the hold is BOUNDED"*; `sync-domains` S1a |
| **M4** | `defer()` — a hold no longer puts its seq in `holds` (the cursor rule) | `sync-personal.test.js` §4 *"the op is HELD, the cursor is held with it, and it lands the moment pairing completes"*; §4b ×3; `sync-domains` S1a |
| **M5** | `pullNow` — `verifyChain` never runs and the page claim is never checked | `attack-converge-relay.test.js` §2 *"it serves Mac B every op except the one where Mama cancelled the appointment"* and §3; `fleet-harness.test.js` §2a; `sync-domains` S4a |
| **M6** | `_stampedCheckpoint` — the refusal ledger stops riding in `lzp` (L-1) | `sync-domains` S1a, S1b, S3a, S4a; `attack-converge-attestation.test.js` §3 |
| **M7** | both `unparkAttested()` call sites removed (L-3) | `attack-converge-attestation.test.js` §3; `sync-domains` S3a |
| **M8** | `status()` relays the engine instead of folding `diagnostics()` (L-2) | `attack-converge-clock.test.js` §2; `sync-domains` S4a |
| **M9** | `pullNow` — the parking lot is never written (P-8's retention) | `sync-domains` S1a **and** S1b |
| **M10** | `defer()` — the `dormant` arm removed, so `'update'` parks pin the cursor | `sync-personal.test.js` §4b *"VERSION with a DURABLE park — the cursor is RELEASED"*; `sync-domains` S1a |
| **M11** | `sync/status.js` — `warnings` mapped back to `error` (L-5) | `attack-converge-rejoin.test.js` §2; `sync-domains` S3a |
| **M12** | `pullNow` — a chain GAP no longer becomes a cursor hold | `fleet-harness.test.js` §2a (the withhold-in-the-middle) |
| **M13** | `pullNow` — the mid-stream re-anchor removed | `attack-converge-relay.test.js` §5 *"a MISSING anchor re-anchors rather than accusing"* |
| **M14** | `loadLot()` — the durable anchor is loaded and never read | `attack-converge-relay.test.js` §5 *"a relay that forks the stream ACROSS a relaunch is caught"* |

**M13 and M14 SURVIVED on the first pass** and are the reason this table is fourteen rows rather
than twelve. Both halves of the chain anchor were unpinned: nothing tested that a fork across a
relaunch is caught, and nothing tested that a MISSING anchor re-anchors instead of accusing an
honest relay of a fork it did not commit. `attack-converge-relay.test.js` §5 was written for them
and both now die. A defence that cries wolf is a defence that gets turned off, so the second row
is as load-bearing as the first.

**One artefact, recorded rather than hidden.** M5 also reddens two rows of
`privacy-e5-silence.test.js` §1, which greps `src/` for `fetch(` call sites: the mutation is
applied as `if (false)` and changes the source TEXT those rows count. It is a property of the
mutation's form, not evidence about the fix.

### 7a-round9. Round 9 — eighteen mutants, in one clean scratch tree

Every row below was applied to a **fresh copy of the whole tree** at the round-9 head
(`…/scratchpad/mut`, never in the repo, every file restored between rows) and the named suites
re-run. **Baseline in that copy: 0 fail in every suite**, except the scratch-copy-only row
*"the frozen v1 store is the baseline commit, byte for byte"*, which re-derives its fixture from
`.git` and cannot pass in a copy that has none — it appears in three rows below purely for that
reason and is not evidence about those mutants.

The tree was copied with `tar`, never with `git stash`: several agents shared this working tree
this round and two files were observed reverting to `HEAD` mid-session when one of them stashed.

| # | mutation | the first rows that die |
|---|---|---|
| **M-A** | `chain.js observe()` — the `fresh` filter removed | `round8-chain` §2 and §1; `attack-converge-relay` §5 and §6; `fleet-harness` §2a; `sync-personal` §4c |
| **M-B1** | `pullNow` — the `chainHoles → holds` line DELETED | `attack-converge-relay` §6; `fleet-harness` §2a; `round8-chain` §2 **and §4 "a withheld op still stops the cursor"**; `sync-personal` §4c |
| **M-B2** | `pullNow` — the hold made PERMANENT again (round 8's behaviour, via the witness's dedupe) | `attack-converge-relay` §6; `round8-chain` §2; **`round9-headline` §2b**; `sync-personal` §4c |
| **M-C** | `pullNow` — the anchor taken from the PAGE HEAD again, not the committed row | `round8-chain` §1; `sync-personal` §4c |
| **M-D** | `pullNow` — a delivered OWED row is no longer positive evidence | `fleet-harness` §2a |
| **M-E** | `pullNow` — the mid-stream re-anchor removed | `attack-converge-relay` §5 (round 8's M13, still pinned) |
| **M-F** | `loadLot` — the durable anchor is loaded and never restored into the witness | `attack-converge-relay` §5 (round 8's M14, still pinned) |
| **M-G** | `outbox release()` — the `unopened` shelve guard removed | `round8-park` §6 |
| **M-H** | `outbox park()` — reports success without the write landing (R8-5) | `round8-park` §2 and §6 |
| **M-I** | `outbox load()` — a shelved envelope is never revived | `round8-park` §1 and §6; **`round9-headline` §1** |
| **M-J** | `cursor.js` — `fromGenesis` back to a RATCHET (R9-1) | `sync-queue` §2b |
| **M-K** | `terminal()` — `lot.release()` again instead of `lot.refuse()` | **SURVIVED — see §7b-round9 below** |
| **M-L** | a cured refusal is never retracted (R8-4's other half) | `round8-park` §1; **`round9-headline` §1** |
| **M-M** | `attach()` — the durable park is not read until the first pull (R8-6a) | `round8-park` §3 |
| **M-N** | `devices.js` — the closed-set call removed from `verifyDeviceClaim` | `blindness` §7a ×6 (both device doors); `round8-seam` §1 |
| **M-O** | `devices.js` — the `DEVICE_ID_RE` pin removed | `blindness` §7b ×4; `round8-seam` §3 |
| **M-P** | `spaces.js` — its door stops running the closed set at all | `blindness` §7a ×3 (`POST /invites/redeem`) |

**The two the brief named by hand, answered directly.**

- **M-A** — the `fresh` filter is load-bearing and it lives IN THE WITNESS. Removing it from
  `chain.js` kills five row groups. Adding a duplicate filter in `pullNow` kills nothing, which is
  the point: R8-1 is closed by the wrapper itself, not by a compensating guard at the call site.
- **M-B1 / M-B2** — the hold **moved**, and both directions are pinned. Deleting it reddens the
  withhold defence (`fleet-harness` §2a, `attack-converge-relay` §6, `round8-chain` §4). Making it
  permanent again reddens the removal rows (`round8-chain` §2, `round9-headline` §2b). A fix that
  only survived one of those two mutants would be the other failure.

### 7b-round9. The one that survived, and what was done about it

**M-K survived: `terminal()` calling `lot.release()` instead of `lot.refuse()` kills no row.**

That is not a broken fix; it is a fix with no behavioural difference **under the current flush
order**, and saying so is the point. `release()`'s guard works by INFERENCE — it retains an oid the
caller has parked or touched since its last release — and in `pullNow` that holds only because
`toPark` is flushed before anything is released. The coupling is invisible at the two flush sites
and would break silently if they were ever swapped, and the failure would be a park becoming a
drop, which is the whole of R8-4.

`refuse()` says the transition out loud instead of inferring it, so the coupling disappears. What
was done about the surviving mutant is **the difference was given a row of its own**:
`round8-park.test.js` §6.2b drives a lot with no `unopened` memory of an oid — a fresh process, or
a release earlier in the same pull, both of which clear it — and measures that `release()`
DESTROYS and `refuse()` KEEPS. The choice is now a tested property of `outbox.js` rather than a
preference at the call site.

**One integration bug this pass found in its own edit, recorded because it is the interesting
kind.** The first version passed `terminal()`'s reason through to `refuse(space, oids, reason)`.
That overwrites the shelved row's reason — and the shelf's reason is not prose for a human, it is
the ENUM the next launch re-judges the envelope by (`loadLot()` reads it back through
`parkHandlingOf`). Writing `"still attestation after 5 attempts"` there would turn a revived
`ENVELOPE_PARK.ATTESTATION` into an unknown park on the very launch that was supposed to cure it.
`round8-park` §1 caught it immediately. The sentence belongs in the refusal LEDGER, where a human
reads it, and `store.syncRefusals` already had it.

### 7b. The one that survived, and what was done about it

Row 23 is a correction, not a fix. The A3-H3 pass wrapped `this._clock.observe(op.ts)` and
described it as *"a live sibling a peer could trigger"*. **Reverting that wrapper killed no test.**
A probe drove ten hostile `ts` values — `'nope'`, `''`, `null`, `undefined`, `42`, `{}`, `[]`, two
37-character non-stamps, a 36-character stamp — through `applyRemote`, and **none reached the
clock**: `ops.js:validateOp` refuses an `op.ts` that is not a 37-character stamp, so
`foldAuthorized` has already put every one of them in `verdict.rejected` and the loop skips a
refused op before touching the clock.

The wrapper is kept as belt to that braces. **What R3-23b now asserts is the reachability claim
itself** — the gate refuses each of the ten *by name*, with a warning, and none of them lands — so
if a future change to the gate ever lets one past, the row goes red and the wrapper stops being
redundant. Row 23 in the table is that assertion's own mutant. This is the only honest way to pin
code whose entire value is that it is currently unreachable, and the alternative — leaving
"hardened against a hostile peer" in a report when the hostile peer never gets there — is the kind
of claim this register exists to stop.

---

### 7a-e3. E3 — the five crypto fixes of `f5add24`, mutation-tested by the verification pass (2026-08-29)

Every row below was applied **in the working tree**, the crypto red team + the domain property +
tier-1 crypto/authz re-run, and the tree restored with `git checkout -- src/js/` before the next
row. Nothing under `server/` or `tests/server/` was touched. Baseline for the columns:
crypto red team **82 pass / 0 fail**, domains **8 pass / 0 fail**, tier-1 crypto+authz
**415 pass / 0 fail**.

| # | fix reverted | red team | domains | tier1 | the rows that die |
|---|---|---|---|---|---|
| **M-A** | **S1** — `admitWraps` takes the sender's ECDH key off `row.senderKexPubRaw` again, as it did before `ctx.senders` | 14 | C1 (30 cells) | 3 | `crypto-relay-keyinjection` **1** (relay injects a key of its own choosing), **2** (the ring stays empty), **3** (the DoS goes with it), **4** (inbound = outbound), **5 THE PERSONAL INSTANCE — story 20.5**, **7**, **8**, **9**; `crypto-member-read` **M-R6** (personal ring, unattested *and* attested fellow member), **M-R6b** (row order no longer decides); `crypto-relay-removed` 7; `M-R5c` |
| **M-B** | **I-3 / §4.5 (a)** — drop `devOf(cell.stamp) === att.deviceShort`, so a `dev.<S>` register is a credential again without a possession proof | 4 | C3 (3 cells) | 1 | `crypto-member-impersonate` **M-I3b**, **M-I3c**, **M-I3d**, and **M-I4** |
| **M-C** | **S3 / E3-6** — remove `board: { digest, hash }` from `sealAad()` | 1 | C2 (7 cells) | 4 | `crypto-member-backup` **M-B4** |
| **M-D** | **S5, author side** — `const level = declared ?? folded` restored in `envelope.js:assertProjected` | 2 | C4 (35 cells) | 2 | `crypto-member-read` **M-R7c** (the seal half) |
| **M-D2** | **S5, clause (ii) only** — disable *just* the declared-vs-map agreement check, leaving `level = folded` | **0** | C4 | **0** | **nothing in the red team.** See below. |
| **M-E** | **S5-R, receiver side** — disable `authz.js` **stage 3c** (INV-R1 on the receiving device) | 1 | C5 (11 cells) | 7 | `crypto-member-read` **M-R7c** (the fold half) |

**All four fixes the brief named die on their named row, and in both spaces where the brief asked
for both.** M-A kills the personal-space row (`keyinjection` 5) and the family-space rows
(`keyinjection` 1–4) *and* `M-R6`, which asserts the personal ring against an **attested fellow
member** as well as an unattested stranger — the two halves of story 20.5 that S1 broke together.

**M-D2 is the row worth reading, because it is the one that killed nothing in the red team.**
Barrier 4 has two clauses: (i) `level = folded`, the only assignment, and (ii) a *declared*
`pub.level` that is present, non-null and different from the map is refused. Reverting (i) kills
M-R7c. Reverting **(ii) alone kills no adversarial row at all** — only domain **C4** goes red.
That is not a defect in the fix; it is a measurement of where clause (ii) is pinned: **the
enumeration is its only guard.** If C4 is ever trimmed, clause (ii) becomes untested code. Recorded
here rather than fixed, because adding a red-team row for it would be inventing an attack the
enumeration already covers — but it is the reason `tests/property/crypto-domains.test.js` may not
be treated as a duplicate of the attack suite.

**The 86-entry work order, closed and measured rather than asserted.** Applying **M-A + M-B + M-C
+ M-D + M-E together** reconstructs the pre-fix build, and the domain property then reports
exactly **30 (C1) + 7 (C2) + 3 (C3) + 35 (C4) + 11 (C5) = 86** failing inputs — the same 86 the
enumeration opened with, and the same 35 of C4 that ADR 004 §2.2 priced by hand. In the shipped
build all 86 hold: **0 known-open, 0 UNEXPECTED, 0 STALE**, with **one** input (`C2c-2`, "is this
still my Kreis?") **carried** — not closed — to `POST /api/v1/devices/adopt`, because C2c-1 and
C2c-2 are provably the *same input* and no implementation can warn on one and stay silent on the
other. Owner: `server/`.

---

## 7c. The accepted-defect list — every `tests/attack/` row that is green BECAUSE a defect exists

**The rule: invert one when you close its defect, never delete it.** Swept and re-verified at the
close of the round-5 integration pass. **23 rows**, against 24 before the sweep — R3-39 was still
asserting `_persistOps()` never appends, which A3-M5's closure made false, and it is now inverted.

| row | file | the defect it pins | register row |
|---|---|---|---|
| R3-2 | `round3-seam.test.js` | `reconcileList` preserves an entry object's **key order** | A3-L1 |
| ~~R3-3~~ | `round3-seam.test.js` | a remote `pref.set` moves the registers and never reaches `state.settings` | **INVERTED by LZP-502 · F-7 closed** — refused by name |
| ~~R3-4~~ | `round3-seam.test.js` | `applyRemote` has no space filter — it admits `local`-space ops | **INVERTED by LZP-502 · F-7 closed** |
| R3-5 | `round3-seam.test.js` | `setSettings`' wholesale replace disagrees about a DRAWN layer | F-7 |
| R3-6 | `round3-seam.test.js` | a `setSettings()` makes the next transaction emit a duplicate `pref.set` | A3-L2 |
| R3-10 | `round3-seam.test.js` | a throwing `mutate()` callback's half-edit is adopted by the next action | A3-M4 |
| R3-11 | `round3-seam.test.js` | a NESTED `mutate()` builds an undo step reverting two actions | A3-M3 |
| R3-11b | `round3-seam.test.js` | when `verify()` fires, `undo()` has already changed the board | A3-M3 |
| R3-20 | `round3-doors.test.js` | 27 of 36 hostile inputs THROW out of `apply()` | F-2 |
| R3-21 | `round3-doors.test.js` | the throw is not always an `OpError` — `EntityKeyError` too | F-2 |
| R3-25 | `round3-doors.test.js` | a peer's over-length value is REFUSED where the diff door truncates | F-2 |
| ~~R3-27~~ | `round3-doors.test.js` | `store.warnings` is write-only — nothing in `src/` reads it | **F-8 CLOSED 2026-08-29** — `family/syncstatus.js` subscribes and `sync/status.js` enumerates the channel. See **L-5** for why it reports without lighting the indicator. |
| R3-40 | `round3-persistence.test.js` | two Macs agree on stamps, not on **authors** | A3-H4 — **still true of a store with no `useIdentity()`; that is now the SOLO case and it is correct** |
| R3-41 | `round3-persistence.test.js` | the other Mac's ops are refused `notMyAct` | A3-H4 — as above; `store-identity.test.js` §1–§2 is the paired case |
| R4-11b | `round4-coercion-oracle.test.js` | `board.json` still not a fixed point after "clear a scratchpad" | F-1 residual |
| R4-16a | `round4-attestation.test.js` | the fold has **no revocation**, and write-once means no amendment | **I-3 / §4.5** |
| R4-19c | `round4-fixed-point.test.js` | a scratchpad held as `""` — v1 is a fixed point here, v2 is not | F-1 residual |
| R5-2g | `round5-authority.test.js` | a Time-Machine restore of a pre-lineage `board.json` destroys the log | R5-2g |
| R5-5b | `round5-authority.test.js` | a field `board.json` cannot express at all is invisible to both halves | R5-5b / F-5 |
| ~~R5-7b~~ | `round5-attestation.test.js` | ONE well-formed op mutes a named device, permanently | **INVERTED 2026-08-28 · I-3 closed** |
| R5-7c | `round5-attestation.test.js` | **P2 does not close it** — `sigPubRaw` is public | **STILL TRUE, AND KEPT** — it is why §4.5 (a) was needed |
| **R9-6b** | `attack-converge-relay.test.js` §6b | **RESIDUAL, round 9.** A relay that withholds a row in the MIDDLE of a page and KEEPS withholding it consumes that row on the second poll. The loss is permanent, REPORTED (`error` plus a gap finding that never clears) and one-sided. It is the price of R8-2's bound: the hold lasts one honest round trip instead of for ever, and the alternative is the wedge. The row ASSERTS the loss and must be inverted the day it is closed. See §4.8 for the two protocol moves that would close it. | §4.8 |
| ~~**R9-3**~~ | `round8-chain.test.js` §3 | `store.syncChain` is declared `durable: true` and persisted nowhere: a fork this device detected before a quit is `silent: true` after it | **INVERTED round 10** — R8-3 closed in `store.js` |
| **R9-6b2** | `round8-park.test.js` §3 row 1 | `diagnostics().sync.parked` counts the LOG's park, so a synchronous `status()` poll at launch reads `healthy` while a held envelope sits on the disk beside it | R8-6(b), `store.js` |
| **R9-8** | `round8-park.test.js` §5 | a quarantined log takes the durable refusal record with it | R8-8 loud half, `store.js` |
| ~~R5-7d~~ | `round5-attestation.test.js` | `authz.js` rules this trade out for the LABEL and ships it for the SHORT | **INVERTED 2026-08-28** — it is now refused for both |
| R5-11g | `round5-coercion.test.js` | an edge sorting INSIDE the alphabet has no faithful v2 date | **§4.6** |

**Nine of the twenty-three trace to just three register rows** — F-2/F-7 (the `applyRemote` seam),
A3-H4 (durable identity), and I-3 (§4.5). None of them is a small independent bug; each is a
decision or a work package. That concentration is the useful reading of this table.

**Rows inverted by the round-5 integration pass:** R3-39 (`_persistOps` appends; the file header's
"`store.js` never writes `ops.jsonl`" corrected to the narrower claim R3-38 actually pins).
**Rows added:** R5-3e, R5-3f (the two unproven fixes), R5-4f (the headline sequence).

**Rows inverted by the E5 integration pass (2026-08-29):** R3-3 and R3-4 (F-7, at both ends of the
wire); `crypto-relay-tamper.test.js` §(iii) and `crypto-envelope.dom.js`'s twin (E3-3 — the
`attestation` park reason exists and the log records it); `tests/fleet/long-offline.test.js` §3
(E5-2 — the outbox survives the quit and the peer receives every op); and
`tests/tier1/crypto-envelope.test.js`'s "THE `attestation` PARK REASON DOES NOT EXIST" row, which
now asserts that it does and keeps three lines asserting the ONE thing still owed to
`crypto/envelope.js`. **Rows added:** none — E5 inverted rows and added positive controls inside
them rather than opening new accepted defects, because every defect it found it also closed except
E5-5, E5-6 and E5-7, which are owned by `server/` and by WP-9 and have no `tests/attack/` row to
be green over.

**Rows inverted by round 8's integration pass (2026-08-29) — thirteen, across six files.** Every
one of them was green BECAUSE a defect existed, and every one names its own inversion trigger in
the text that was there before it was flipped:

| file | row | closed by |
|---|---|---|
| `attack-converge-outbox.test.js` §1 | *"compact ▸ author offline ▸ compact — the edit is destroyed"* and the story-19.6-scale twin | E5-2 + L-4 |
| `attack-converge-disorder.test.js` §2 | *"a permanent, stable content divergence, with `healthy` on both Macs"* → 128 seeds converge | E5-2 + L-4 |
| `attack-converge-attestation.test.js` §3 | *"after the ladder, nothing ever re-judges the held op again"* | L-3 |
| `attack-converge-clock.test.js` §2 | *"a fast Mac syncs nothing, and neither Mac is told"* → the peer now says `pending` | L-2 |
| `attack-converge-rejoin.test.js` §2 | *"…and nothing anywhere reports a loss"* (the silence half; the DATA half is still the finding) | F-8 |
| `attack-converge-relay.test.js` §2, §3, §4 | the one-sided withhold, the two-sided fork, and *"`sync/chain.js` is unreachable"* | P-4 |
| `fleet-harness.test.js` §2a | *"a relay that withholds ops from ONE Mac takes them PERMANENTLY"* → it only delays them | P-4 |
| `privacy-e5-silence.test.js` §4, §5 | P-2's documentation half; the door row; the orphan set; the sharp-half row | P-2 (doc), P-4 |

**Rows added by round 8:** `attack-converge-outbox.test.js` *"L-4 · the ack survives the quit"*;
`attack-converge-disorder.test.js` §2's second row (*"a QUARANTINE in the alphabet costs data — and
never costs it SILENTLY"*); `attack-converge-relay.test.js` §5's two anchor rows;
`core-oplog.test.js`'s two L-4 rows; `sync-personal.test.js` *"VERSION with a DURABLE park — the
cursor is RELEASED"*. **Four of the eight exist because the inverted rows are all "nothing bad
happens"** and would otherwise be satisfied by a build that syncs nothing, reports everything for
ever, or deletes the mechanism: the quarantine row (a loss may happen, but never silently), the
missing-anchor row (a defence may not accuse an honest relay), the no-`parkStore` row (the
fail-safe when the port is absent), and §2's own `silent` control.

**Rows inverted by round 7:** R6-3a, R6-3b, R6-4a, R6-4b, R6-4c, R6-5a, R6-5c, R6-5d, R6-6a,
R6-6b, R6-7a, R6-7d, R6-10a, R6-10b, R6-10c, R6-11a, R6-11b — and, in a file round 7 did not own
but reddened, R5-11g, R5-12b and the second half of R5-12e. **Rows added:** R6-2b, R6-3c, R6-4e,
R6-5a2, R6-5g, R6-5h, R6-6e, R6-6f, R6-7f, R6-7g, R6-7h, R6-10e, R6-10f, R6-11c, R6-11d.
Every added row is a non-vacuity control or a newly-found input, and **five of them exist
specifically because the inverted rows are all "nothing bad happens" and would otherwise be
satisfied by deleting the mechanism**: R6-3c, R6-4e, R6-5h, R6-6e, R6-11c.

---

## 7d-2. THE SECOND DOMAIN — the OP LIFECYCLE (round 8)

§7d's method, applied a second time and to a second area. The area was chosen by the convergence
adversary's own sentence: **"the domain here is the OP LIFECYCLE, not the op kinds."**
`domains.js` enumerates what an op IS; **`tests/helpers/sync-domains.js`** enumerates what happens
TO it. 792 lines, zero imports, **253 entries** over five domains, the same
`{id, value, label, expect, openFinding}` contract, and `expect` is again the REQUIRED behaviour
and never the current one.

| domain | entries | the axes it crosses |
|---|---|---|
| **S1** | 8 + 160 | an op's fate end to end: 8 `openOp` outcomes × what the engine does × what survives a relaunch — and the full 8 × 5 × 4 GRID, generated rather than hand-marked, so *"a park must never become a drop"* is 32 cells whose `required` is `false` rather than a sentence in a docblock |
| **S2** | 16 + 5 | durability across a restart: board × line × relay × outbox, all sixteen combinations with a decided answer, plus five real journeys that must land in named cells |
| **S3** | 5 | ADR 001 §7.2's compaction crossed with every other lifecycle state |
| **S4** | 7 | what the user and the system can OBSERVE — story 19.3's "silence must MEAN health", written as a table with two rows where silence is TRUE and must stay free |
| **S5** | 58 | every module under `src/js/`, and whether the app can reach it from `boot.js`, `main.js` or `firstrun.js` — following DYNAMIC doors, because ADR 003 §7 gate 2 requires them |

`tests/property/sync-domains.test.js` walks every entry against the real store, the real op log,
the real `openOp`, the shipped engine and all 23 server handlers. **85/85, 0 UNEXPECTED, 0 STALE.**

**What the enumeration produced that two adversary rounds did not.** Three of round 8's six new
findings — **L-1**, **L-2**, **L-3** — had no `tests/attack/` row at all before it. They are not
subtle: a refusal that dies with the session, a durable hold nothing can see, a park with no
reaper. They were invisible because every previous pass asked *"is this branch right?"* and the
answer was yes in each case — the missing thing was a whole column of the table nobody had drawn.

**And two cautions this domain earned, which §7d did not have to state:**

1. **A domain can be internally contradictory, and then it is a work order that lies.** `S4-refused`
   and `S4-warnings` are measured on ONE device at ONE moment and required two different answers
   from a first-match-wins helper. `S3-parked`'s three columns are requirements about two different
   moments and could not all hold at once. Both were corrected in the PROBE, with the `expect`
   untouched, and recorded (**L-5**). A domain file is an artifact and gets reviewed like one.
2. **`predicted` goes stale, loudly, and that is the point.** S1 carries this build's measured
   triple as data so the 160-cell grid can be generated. Every fix that moved a fate produced a
   STALE report naming the row — which is how a fix that closes three park reasons and forgets the
   fourth is caught by name rather than by a green suite.

## 7d. THE INPUT DOMAIN — the required method for `store.js`'s boot and coercion paths

**This section is a process rule, not a finding, and it is here because five consecutive rounds
each RELOCATED the same failure rather than closing it.** Round 6's closing verdict named why:

> The fixes are still being chosen a branch at a time, and the branch is chosen before the input
> domain is written down. R6-5a is the sharpest instance: round 5 replaced "is raw null?" with a
> careful five-way classifier and wrote out four of the five kinds in a docblock — and `''` still
> went to the wrong one, because the enumeration was of **branches** (ok/absent/unparseable/
> not-a-board/read-failed) rather than of **bytes**.

**The rule, in three steps.** Enumerate the **input domain** first, exhaustively, as **data**;
choose the behaviour **per input**; then **property-test over the domain**. A fix that only names
branches will be relocated by the next round.

**The contract file is `tests/helpers/domains.js`** — 968 lines, zero dependencies, **310 entries**
over six domains, each `{id, value, label, expect, openFinding}`. `expect` is the **required**
behaviour, not the current one; `openFinding` names the row that predicts the entry fails today,
and is `null` on every entry as of this pass.

| domain | entries | the axes it crosses |
|---|---|---|
| **D1** | 94 + 8 | 25 byte-inputs × 4 sources (browser / Tauri-native / native-throws-with-fallback / native-miss-with-fallback), + 3 no-bytes-anywhere rows; and `D1_RECOVERY`, the 8-row *what is lying beside the board file* axis |
| **D2** | 44 | 22 stamps (0, ±1 s, ±1 h, ±12 h, ±23 h 59 m, ±24 h, ±24 h 1 s, ±48 h, ±90 d, +10 y, `GENESIS`, 2 malformed, forged-own-device-short) × own/foreign author |
| **D3** | 5 | the five provenances, incl. `foreign-admitted` marked unreachable-in-WP-3 **and said so** |
| **D4** | 14 | 8 checkpoint indexes × what prunes them, + 6 growth marks (0 … 6 400 ops on a board that never grows) |
| **D5** | 4 | the *mint* × *see* matrix, with 3 separate probes |
| **D6** | 141 | 47 strings by sort position × {`startDate`, `endDate`, `note.date`}, each carrying its **measured** `buildBoard()` paint |

**`tests/property/domains.test.js`** (631 lines, 11 properties) walks every entry. **No property
stops at its first failure**: each walks its whole domain and fails once, splitting deviations
into **UNEXPECTED** (no finding named — a regression), **STALE** (a finding is named but the entry
now holds — *the work order is lying*) and **the work order**. `D6a` re-measures the recorded v1
oracle against `src/js/layout.js` on every run, so the embedded data cannot rot into a description
of a renderer that has moved.

**Two things the enumeration produced that six rounds of adversaries did not.**

1. **A content-loss path, and round 6's closing "content is safe" is wrong.** `D1-b18` — see the
   **R6-5** box under CRITICAL.
2. **A premise correction in the *permissive* direction.** §4.6's "no faithful value exists inside
   the range" was too pessimistic, and saying so cost 24 D6 rows their `openFinding`. The
   enumeration's own replacement rule was then itself too optimistic by one comparison, and the
   fix corrected it again — both corrections are recorded in the file's header rather than
   silently applied. **A domain file that only ever ratchets expectations downward is a domain
   file being used as an excuse.**

**Two honest cautions about the artifact itself.** `D6`'s `expect` is `paints: 'as-v1'` for all but
nine (value × field) pairs; those nine are `same-columns`, each with a **per-pair proof** in
`D6_SAME_COLUMNS` — five because the alphabet is provably empty where v1's two tests both want a
member (`D6_NO_MEMBER`; re-verified independently at this integration pass), four because **v1
itself** rendered the day as `NaN`. `same-columns` still asserts the **exact column set**; only a
continuation chevron may differ. And `D3-p5`'s cell is unreachable in WP-3 by construction — it is
carried because it becomes reachable at WP-8, and a domain that drops its unreachable rows stops
being an enumeration.

---

## 8. What the fix pass could not land, and who owns it

Three fixers worked in parallel with the **E1 release-pipeline agent**, which owns `.github/`,
`scripts/`, `server/`, `src-tauri/`, `shell-macos/`, `src/js/platform/`, `src/js/firstrun.js`,
`src/js/settings.js`, `src/js/i18n.js`, `src/js/main.js` and `src/css/`. **Nothing in that list was
touched.** These are the items that need one of those files, or a file no one owned this round:

### Needs E1's territory — for a follow-up pass, not for E1 to guess at

1. **The F-8 consumer — `src/js/settings.js`.** The carrier is finished and contracted; the seam is
   `store.subscribeWarnings(fn)` for live events and `store.diagnostics()` for the settings pane,
   and `diagnostics().quarantine` is what a "your op log was refused" notice should read. **This is
   the only reason F-8 is still open**, and A3-H2 made it matter more: every coercion the migration
   now performs on a user's file is on that channel, and nothing reads it. WP-10.

### Needs a file no one owned this round

2. **`src/js/storage.js` — move a quarantined log aside** (`ops.quarantined-<ts>.jsonl`,
   `checkpoint.quarantined-<ts>.json`). Row **I-6**. Until it exists the refusal is re-derived and
   re-reported on every launch: safe, noisy, nothing lost either way. **Do not "fix" it by
   deleting the files** — "not deleted" is one of the quarantine's three promises.

### Needs a decision before an edit is possible

3. **I-4** — `GENESIS(index)` above a million entities. §4.4.
3b. ~~**I-3 / R5-7** — §4.5.~~ **CLOSED 2026-08-28** by §4.5 option (a), built as a possession
   proof at fold time. The observation that the owed P2 check does not close it was correct and
   is why the answer came from elsewhere; read §4.5's ruling before writing any attestation code,
   and in particular the two obligations it puts on `openOp` and on anything that appends.
3c. ~~**R5-11g** — §4.6.~~ **CLOSED by round 7 (R6-10/R6-11). No decision is owed.** The dilemma
   was misstated: the collision with finding 6 is a question about *which field*, not about which
   fidelity, and the answer differs per field. What remains is a five-string ceiling that is now
   explicit, named and proved empty (`D6_NO_MEMBER`, R6-11c).
4. **I-1 / I-2** — both are `store.js` and both are *fixable*, but the fix is a re-ordering of
   `replaceAll` and a policy choice about what `init()` should show; neither is a guard that can be
   dropped in without deciding what the user sees. Filed rather than rushed, because the pass that
   found them was proving other fixes and had no mandate to change what an unbootable board does.

### Owed by round 5, and by this integration pass

8. ~~**ADR 001 §7.2's compaction policy is not implemented as written.**~~ **CLOSED by round 7,
   in both directions, and the direction is the point.** The **2 MB-at-launch trigger**: the ADR
   was right and the code was missing it — implemented (row **R6-2**). The **30-day debuggability
   tail**: the ADR was wrong and the clause is **dropped** — `truncateOps` can only drop a prefix,
   the store tracks a line count rather than per-op file positions, and §7.2's own losslessness
   result is precisely the statement that a retained tail is worth nothing *to state*. §7.2's
   `bodies` block also carried a growth rate with **no ceiling** (*"≈400 KB/year"*) and now carries
   the bound, the eviction policy and what an evicted fingerprint costs. The stale
   *"Reviewed 2026-08-27 — no change owed"* is kept and **marked superseded** rather than deleted.
9. **The first-run tour still shows over a disaster boot with no snapshot.** `seenFirstRun` is left
   at v1's `false` because `tests/tier1/store-persistence.test.js:240` characterizes it by name
   ("treated as a first run"). Re-baselining a v1 observable is the tier-1 owner's call. The
   read-only guard and the warning are what actually protect the file.
10. **`quarantineLogAside` on the native path** still cannot move anything (the owed
    `quarantine_logs` shell command — row **I-6**). Much less pressing than it was: a failed boot
    never sequesters at all now, so the path where this mattered most is gone.
11. **Two files had two owners this round.** `src/js/store.js` and
    `tests/attack/round5-authority.test.js` were assigned to two parallel fixers at once. Both used
    anchored edits and both sets of changes survived, but the reconciliation was luck rather than
    process. **Assign one owner per file next round.**
    **Round 7: it happened again, and it was flagged by the fixer rather than caught by the
    process.** `src/js/store.js` was edited concurrently by two of the three fixers throughout the
    round — `_clockSkew`/`applyRemote`/`_persistOps` on one side, `classifyBoardFile`/`BOARD_SHAPE`/
    `_recoverFromLog` on the other, plus `diffCollection` from a third. All three used surgical
    unique-anchor edits, all three landed cleanly, and each proved its own changes green in an
    isolated scratch copy — but that is care, not process. **`store.js` is 2 400 lines and is the
    file every round's fixes land in. It needs splitting, or it needs a single owner per round with
    the other fixers handing it patches.**

### Owed by round 7, to whoever picks up next

12. **R7-1 — `diagnostics().source` is short a value.** The full statement of what is owed is in
    the R7-1 box under LOW: a fourth value in `store.contract.js`, in `diagnostics()`, and in
    `D1_RECOVERY`'s `expect`, with R6-6a/b/f extended to assert it. Diagnostics only.
13. **A residual on `clock-skew`, outside D2's enumeration.** A *local* clock set a year forward,
    edits minted, clock corrected ⇒ live register stamps a year ahead ⇒ `clock-skew` on every
    launch **for a year**, deferred, with **no user action that helps**. Content is whole
    throughout. This is R5-2e's own case working as designed, but *"deferred forever"* has no
    escape hatch. **It needs a domain of its own** — how far back can a clock jump, and what does
    the user do about it — before it needs a fix.
14. **`seen` is still unbounded in-session** (`core/oplog.js`): it grows with ops-ever *within one
    process*, ≈150 KB of RAM at 6 400 ops. Not serialized, so it is bounded **across restarts** by
    `bodies`' cap. Deliberately not in D4, which enumerates the *checkpoint's* indexes. Noted, not
    fixed, not urgent.
15. **The DE/EN copy for `recovery-unusable`** is written verbatim into `_bootRecoveryFailed`'s
    docblock, keyed off `bootFailure.reason`, exactly as `_bootUnreadableBoard`'s is. **A settings
    pane still has to render it** — the same owed surface as F-8's consumer (item 1).
16. **A WP-8 invariant, from R6-7d.** The interpolated `_born` carries `ZERO_DEVICE_SHORT`. Two
    devices that independently reconcile the same lost-tail board *will* agree on the value — it is
    a pure function of the neighbours — but nothing pins that **across devices** yet.

### Owned by WP-6, recorded so it is not rediscovered

5. **Remove `attestedDevices` / `memberOfDevice`** once their callers move to `attestationOf`.
   They have live callers in `ownership-authz-content.test.js` and `ownership-authz-admin.test.js`
   and are marked in `ops.contract.js` as derivable, "do not add new ones".
6. ~~**Enforce the P2 binding in `attestOpen`** — row **I-3**.~~ **DONE, AND I-3 IS CLOSED
   2026-08-28** — but not by this item. P2 shipped and did not close it; §4.5 option (a) did.
   The reasoning below is kept because it is what ruled the shortcut out. Round 5
   (R5-7c) proved P2 does not close I-3: `sigPubRaw` is a public key travelling in the victim's own
   register, so a squatter copies it, tells the truth, and passes. **§4.5** is the decision that has
   to come first, and only option (a) — first-claim on `(sigPubRaw, short)` — makes the binding
   worth writing.
7. **`ctx.myDevices` should be derived, not plumbed** — `attestationOf` filtered by `memberId`,
   once A3-H4 lands. That removes the `act === me` degradation A3-H4 flags as a WP-8 blocker.

### Owed by round 9, to whoever picks up next

**All four of these are `src/js/store.js`.** Round 9 could not take them — `store.js` was another
owner's file for most of the round and the four are one pass, not four.

1. ~~**`store.syncChain` must ride in `checkpoint().lzp`** (R8-3)~~ — **DONE, round 10.** It rides
   there now, through `_syncChainForDisk()` and `_restoreSyncLedger`, and `round8-chain.test.js`
   §3 is inverted. Two things were learned landing it and are written into the code:
   the restore may NOT `_warn()` (the warning channel has no withdrawal door, so it outlived the
   verdict and re-created the un-clearable light one field over — measured as `'warnings' !== null`
   in `sync-domains` S4c), and an empty `findings` list is not a verdict.
2. **`diagnostics().sync.parked` must count the engine's held envelopes as well as the log's
   parked lines** (R8-6b). `round8-park.test.js` §3 row 1 asserts the defect. Half (a) is closed —
   `attach()` re-emits — so what is left is only the SYNCHRONOUS poll at the instant of launch.
3. **`diagnostics().quarantine` must say what the quarantine DISCARDED** — refusals, parked lines,
   cursors (R8-8's loud half). That is the signal that would let `sync/status.js`'s `quarantine`
   row be `error` for a launch that threw a divergence record away while staying quiet for an ADR
   006 §9.3 re-join. It is the same fix as `_restoreSyncLedger` preserving the ledger.
4. **`_syncLostOps()` and `retractSyncRefusal` should share one retraction path.** Round 9 added
   the second; the first still derives its answer fresh each call. Nothing is wrong today.

**And two that are not `store.js`:**

5. **ADR 002 §2.3 — the text amendment `devices.js` quotes verbatim at its own `:387`.** §2.3's
   bullet *"`parseAttestationBlob` already tolerates extra fields, deliberately, so a v2.0 client
   reads a v2.1 blob unchanged"* is true of a CLIENT and false of the RELAY DOOR, which refuses
   one. Applied to the ADR in §6 of this register by round 9; if the ADR text is ever rewritten,
   the sentence to keep is the one in the source.
6. **`server/core/store-interface.js` / the adapters — `deleteKeyWrapsForDevices` matches a device
   id against `KeyWrap.recipientId`.** That is the mechanism R8-7b exploited. The registration door
   is closed now, so no `rec_`-prefixed device row can be born — but the store method is still a
   purge keyed on a namespace it does not own. Whoever owns that file should decide whether it must
   refuse a `rec_`-prefixed argument outright. `revokeDevice` was deliberately left on plain
   `requireId`: a malformed id there matches no row and answers the same `not_a_member` as an
   unknown one, and a shape 400 would make malformed distinguishable from absent.

### Owed by round 8, to whoever picks up next

1. **`crypto/envelope.js` — `openOp`'s `park()` should return the op for its three post-decrypt
   reasons.** `unknownKind`, `unknownField` and `unknownSpace` are decided AFTER the decrypt, so
   the plaintext op is in scope at the `park()` call and is not returned. With it, `pullNow` could
   hand those three to `oplog.park()` — the LOG's park, which folds into `checkpoint().parked` and
   is re-judged by `unpark()` — instead of retaining sealed bytes it has already opened once. Not
   a defect: the sealed retention is correct and closes S1. It would be strictly better.
2. **`core/oplog.js` — one chain value beside each entry of `checkpoint().cursors`.** The chain
   anchor is durable now, in `sync/cursor.js` behind the `chainStore` port, which is a SECOND file
   for a fact that belongs beside the cursor. `cursor.js`'s own header makes the argument: *"two
   persisted answers to one question is how they drift apart."* Nothing is wrong today —
   `store.cursor()` is still the only value read as `since`, and the anchor can only lag it — but
   the two files should become one, and `checkpoint()` is the place.
3. **`src/js/storage.js` — two slots, both currently supplied by `family/engine.js`.**
   `parkedEnvelopeStore()` (P-8) and `chainHeadStore()` (P-4) write through `engine.js`'s own
   `readJSON`/`writeJSON` because `src/js/sync/` is I/O-free (ADR 005 §2) and `storage.js` was
   another owner's file. The sealed-outbox cache has had the same note since LZP-502. Three ports,
   one owner, one pass.
4. **A severity on `store.warnings`.** L-5 is closed by making the channel non-raising, which is
   right for today and is a blunt instrument: a genuine *"the tail could not be compacted"* now
   reads exactly like *"held ops are now authorised"*. `_warn(msg, {level})` and one `level` field
   in `diagnostics().warnings` would let `sync/status.js` fold faults and leave notices alone.
5. **Two i18n strings, unchanged from the observability pass** (`src/js/i18n.js`): one for a HELD
   op that is not merely pending (*„Eine Änderung wird zurückgehalten, bis dieser Mac das andere
   Gerät kennt."*), one for a line that will not reach the other Mac. Until they land, `parked`,
   `lost` and `chain` all speak with `syncErrGeneric`, which is why the settings sheet
   de-duplicates by sentence — a no-op the day the strings exist.
6. **`server/core/handlers/invites.js:218` — `readAttestedDevice`, not `readDevice`.** Carried
   forward from the E2↔E3 seam pass and still owed: without it a joiner can plant a blob signed by
   nothing, and because `familyRecipients()` throws on an unverifiable attestation, one bad joiner
   wedges every future rotation for the whole family. Two lines.
7. **`tests/tier1/platform-net.test.js`** — the day either shell ships `sync_request`, make
   `reply.url` required in `createBridgeTransport` and invert `privacy-e5-endpoint.test.js` §2's
   reduced row. Its assertion text is the deadline.
8. **`src/js/family/pairingui.js`** — „Gerät koppeln" is the third moment `crypto/probe.js` names
   and is still ungated. Pinned in `privacy-e5-silence.test.js` §5 with the line to invert.
   **RE-OWNED, round 10:** this is not a sync row and never was. `src/js/family/*` is E6's flow
   work, which held that directory for the whole of round 10, so the gate belongs in the pass that
   owns the pairing screen. Round 10 re-verified only that the row is still green — i.e. that the
   defect is still there — and touched nothing in that directory.

---

## 9. ROUND 10 — the E6 gate. What was integrated, what was found, and the verdict

*2026-08-29, the round-10 integration pass. All six suites green:*
`npm test` **1932** · `test:attack` **720** · `test:property` **88** · `test:server` **868** ·
`test:fleet` **168** · `test:dom` **29 files PASS**.

Three fixers worked the shortest path round 10's adversary set as the condition of a GO. Their work
is integrated, every item is mutation-tested below, and the verdict is **NO-GO for E6** — for a
reason that is *not* any of the nine items, and that no amount of finishing them would change.

### 9a. What landed in the integration pass itself

| # | change | file | row that dies without it |
|---|---|---|---|
| **R10-9c** | `status()` OFFERS the shelf: `held: lotLoaded ? shelvedDetail(lot, [spaceId]) : null` | `sync/personal.js` | `round8-park` §7d (INVERTED); `sync-domains` **S4e** |
| **R8-3** | `syncChain` rides in `checkpoint().lzp.chain` | `store.js` | `round8-chain` §3 (INVERTED); `sync-domains` **S4c** (INVERTED) |
| **R10-9d** | a shelf row for an op that has since OPENED is dropped — two halves | `sync/outbox.js`, `sync/personal.js` | `round8-park` §6.2c; `round10-e6-gate` §1b |
| **S4-shelved** | the domain gains the state the observable pointed at | `tests/helpers/sync-domains.js` | `sync-domains` S4a (`DOMAIN_SIZES.S4` 7 → 8) |
| **B-16** | ADR 002 §2.3's owed amendment — the allow-list moves with `X-LZP-Protocol` | `adr/002-crypto.md` | `server/adr-claims.test.js` |

**Two of these were found by wiring the other one**, which is the pass's most useful result:

- **`lotLoaded` (part of R10-9c).** Handing `shelvedDetail(lot, …)` in unconditionally is *worse
  than not wiring the row at all*: the lot is empty until `loadLot()` has read the disk, so a fresh
  process reported an empty shelf **with `unoffered: []` to prove it had looked** — a confident,
  wrong answer about a Mac with a retained envelope beside it. Measured before the guard existed.
- **R10-9d, NEW and the reason R10-9c could not ship alone.** `lot.release()` shelves any oid the
  caller "parked or touched since its last release", and `unopened` is cleared *only inside
  `release()`* — so a session where nothing applies for several pulls accumulates marks, and the
  pull where the cure finally lands shelves an op **that opened**. F-6's ordinary story therefore
  left a permanent shelf row behind, saying nothing would ever open bytes whose op was on the
  board. Invisible while nothing read the shelf; a **permanent user-visible `error`** the moment
  `status()` offered it. Fixed in two places: `pullNow` opens each pull with an empty `release()`
  (the pull boundary `round8-park` §6.2 models with a fresh lot and says so in its own comment), and
  `release()` drops shelf rows for oids the caller names as applied (the cross-session half).

### 9b. The mutation table

| mutant | change | row that dies |
|---|---|---|
| **M-F1** | `wit: ''` back in `sealLine` | `round9-witness` §1a, §1d · `privacy-e5-wire` §2 |
| **M-F1c** | `provable = s.fromGenesis` (drop `spanFromGenesis`) | `round9-witness` §1d · `tier1/sync-chain` §3 |
| **M-F3** | `if (commit > at)` — the durable `fromGenesis` write behind the cursor move alone | `round9-witness` §3, §3b |
| **M-F1c + M-F3** | both guards off, `wit` still wired | `round9-witness` **§3c**, §1d, §3, §3b |
| **M-F2b** | the genesis-page row-zero mismatch no longer holds the cursor | `round9-witness` §2b |
| **M-R9-1** | `fromGenesis` a ratchet again | `tier1/sync-queue` R9-1 · `round8-park` §8a · `round9-witness` §3, §3c |
| **M-F9a** | delete the `shelved` row from `SYNC_OBSERVABLES` | `round8-park` §7b, §7d · `sync-domains` S4e |
| **M-F9b** | `shelvedDetail` answers `[]` without asking the lot | `round8-park` §7a, §7b, §7c · `sync-domains` S4e |
| **M-I1** | `status()` stops offering the shelf | `round8-park` §7d · `sync-domains` S4e |
| **M-I2** | drop the `lotLoaded` guard | `round8-park` §7d · `sync-domains` S4-shelved (cold-launch half) |
| **M-I3** | `syncChain` out of the checkpoint | `round8-chain` §3 (both rows) · `sync-domains` S4c |
| **M-I4** | a chain verdict can never be cleared | `round8-chain` §2 and §3-control · `round9-headline` §2b · `sync-domains` S4c |
| **M-R10-9d-1** | delete the pull boundary | `round10-e6-gate` §1b |
| **M-R10-9d-2** | keep shelf rows for ops that opened | `round8-park` §6.2c |
| **M-F7a** | the `deviceShort` guard global again | `attack-relay-correlate` §1, §2 · `auth` STEP 4 ×2 · C29b, C32b |
| **M-F7d** | the progress setters ignore the space | contract **C32b** |

#### The one the brief asked for by name — and the received account of it was wrong

The brief required proof that *"a build with the witness value wired and `commit >=` missing must be
demonstrably red, because that combination is the false positive the ADR forbids."* It is red
(**M-F3** kills `round9-witness` §3 and §3b). But building each mutant and running it showed the
hazard has **three** parts, not two, and they do not compose the way the sentence suggests:

| build | result, measured on `round9-witness` §3c's arrangement |
|---|---|
| item 2 reverted alone (**M-F3**) | the durable lie IS restored (`fromGenesis: true` after a break the Mac gave the right up for) — **and no accusation follows**: `spanFromGenesis` is false on a fresh process |
| item 1b reverted alone (**M-F1c**) | no accusation: the disk honestly says `false` |
| **both reverted** | `unknownWitness`, `status: error`, `store.syncChain` SET — **against a relay honest since the break** |
| all three reverted (`wit: ''` too) | nothing: with no value to misjudge there is nothing to misjudge |

So the two guards are **independent and either alone is sufficient**, and `wit` is the *arming*
condition for all of it — which is the precise sense in which round 9's build was "safe": its
detector was dead. This is a stronger position than the brief assumed, and it is now a row
(`round9-witness` §3c) rather than an argument.

### 9c. Both directions, driven at fleet level over the real handlers

`tests/fleet/round10-e6-gate.test.js`, 11 rows. **Every honest-direction row carries a control in
the same arrangement** proving the detector was live and could have fired — without them the whole
section is satisfied by a build with the detector switched off.

| input | verdict | cursor | control |
|---|---|---|---|
| honest relay repeating itself, ×6 polls | quiet | moved | one rewritten value on the next page IS caught |
| a held page re-served, ×4, then cured | quiet | held, then **moved** | the hold is asserted, so the quiet is not the quiet of an idle Mac |
| a member purge (real `POST /members/remove`) | quiet | moved past the hole | verification RESUMES past the purge and catches a later lie |
| a first pull from genesis, 3 pages | quiet | moved off `0` | a head-of-log withhold on the same pull IS caught |
| **a real fork** | `error`, named, **survives the quit** | — | and is WITHDRAWN by one honest page with new rows |

### 9d. E6's actual shape — four devices, three members

| input | what the sync engine does |
|---|---|
| **a join into a circle that already has a removal** | not wedged; cursor reaches the head; **but she carries a live `gap` verdict** — see **R10-11** |
| **a removal during a partition** | the returning Mac traverses the hole, cursor moves, alleges nothing, and catches up on everything authored while it was away |
| **two removals racing** | both stick (the membership transaction serialises them); two holes in one log; the survivor is not wedged, alleges nothing, and its cursor moves through **both**. R8-2's bound is **per pull, not per hole** — which is why a race is not twice as bad as one removal |

#### R10-11 — a joiner past a pre-existing removal wears a red light on her first day · MEDIUM · **OPEN**

*Found by:* `tests/fleet/round10-e6-gate.test.js` §3a, which ASSERTS the defect and must be inverted
when it is closed.

She is not wedged and she alleges no fork, but she finishes her catch-up holding `gap@<seq>`, and
**pulling does not clear it** — measured over fourteen further rounds. The only thing that clears a
verdict is positive evidence (`foldedFresh` — the head MOVED), and her head is already at the top of
the log. Nothing is owed, nothing is broken, and the indicator is red.

The bound is real and is not comfort: **the next entry anybody in the family writes** moves the head
and withdraws the verdict (asserted in the same row). So the window is *"until someone writes"* —
minutes for an active family, days for a quiet one — on a new member's **first day**. Round 10 made
it worse in one specific way: `syncChain` now rides in the checkpoint, so quitting no longer clears
it either. That is the correct trade (a real fork must outlive a quit) and it sharpens this row.

**The shortest fix is already specified**: ADR 003 §4.1's `baselineSeq`/`baselineChain`, R4 — *a
break BELOW the baseline a joiner recorded at her first pull is not a finding*, because she can
prove nothing about a range she was never served. It is written; nothing implements it.

#### R10-10 — the relay admits a second member to a PERSONAL space · LOW / LATENT · **OPEN**

*Found by:* `round10-e6-gate.test.js` §4c. `POST /invites` + `POST /invites/redeem` admitted a second
member to a `psp_` space over the real handlers. **Not a confidentiality break, and it must not be
over-read as one:** `SK_personal` reaches a joiner by no relay path, and every client refuses her ops
as `notMyAct` regardless. What is missing is the relay's own half of story 21.2 — the membership
doors do not look at the space KIND — so the only thing between a personal space and a second member
is that no UI offers it. Defence in depth, absent. Inverts when those doors refuse a non-`fsp_`
space.

### 9e. THE GATE — why this is a NO-GO, and why finishing the nine items would not change it

`round10-e6-gate.test.js` §4, three rows over the shipped source:

1. **`createPersonalSync` throws on an `fsp_…` id** (`assertPersonalSpace`). This is *correct* —
   21.2 enforced at construction, which `personal.js`'s header calls "negative work" done on
   purpose. It is quoted as a fact about SCOPE, not as a defect.
2. **No other engine exists.** Six modules under `src/js/sync/`, exactly one of them an engine, no
   `family.js` — and `src/js/family/engine.js`, the file whose *name* says family, builds
   `createPersonalSync` and gates itself on `startsWith('psp_')`. „Familie" in this product means
   *"my own Macs, over a relay"*, which is M1 and is exactly what E5 shipped.
3. Consequently **§3's rows could only measure the CURSOR and the VERDICT, never the BOARD**: no
   content crossed between members in any of them, because a personal space correctly refuses
   another member's ops.

**So E6's convergence question cannot be asked of this build.** The adversary's sentence — *"E6's
threat model is the one this engine cannot currently serve"* — is not a statement about the fork
detector's quality. It is a statement about which space the product can sync, and it is still true
with all nine items landed. A suite of 168 green fleet rows is evidence that the personal engine is
sound under attack; **it is not evidence that a family engine will be**, and the three rows above
exist so that no future reader mistakes the first for the second.

### 9f. Owed after round 10

1. **R10-11's fix** — ADR 003 §4.1 R1–R4 (`baselineSeq`/`baselineChain`). Owner: `sync/cursor.js`
   (the record) and `sync/personal.js` (the "below the baseline is not a finding" rule).
2. **R10-2** — still blocked, and round 10 added a second reason. `personal.js:1075` carries the
   argument; **M-I4 now measures the cost directly**: make a verdict un-clearable and
   `round9-headline` §2b, `round8-chain` §2 and `sync-domains` S4c all go red on a legitimate
   removal. A PO ruling is still required.
3. **The witness window is not persisted** (`cursor.js`). A device can prove a fork only in a
   session in which it pulled from genesis. This is the honest ceiling of check 2 as shipped and is
   stated in ADR 003 §4.1 R5's copy contract („seit dem Beitritt geprüft").
4. **R10-10** — the membership doors should refuse a non-`fsp_` space.
5. **`lot.refuse()`'s return value is still discarded** at its one call site
   (`round9-e6` §3a/§3b). Untouched by this pass and still open.
6. **`round9-e6` §3c's reader walk is a TEXT grep including comments.** Two agents have now
   reddened it by writing a method name in prose. The row now says so; a reader who trips it should
   check whether they wrote a CALL or a sentence.

---

## 10. E6 — Familienkreis. What integrating and DRIVING the client flows found.

**Date:** 2026-08-29 · **Tickets:** LZP-601…607 · Full record: `docs/v2/E6-VERIFICATION.md`.

§9 closed with *"E6's convergence question cannot be asked of this build"*, reached from the sync
engine's side. This section is the same wall reached from the client's, plus five findings that only
appeared when the flows were driven against `node server/dev-server.mjs` with two real Macs.

**What DID hold, and is now measured rather than argued:** create → invite → join → both members
listed → rename → leave → delete are real signed HTTP round trips; the relay stores **no** display
name and **no** circle name; the invite row carries **no key material**; the colour collision rolls
the redemption back atomically so the code survives; solo mode loads **36 modules, 0 from
`family/`/`crypto/`/`sync/`, and makes 0 requests**.

### 10a. The five findings

| id | finding | owner |
|---|---|---|
| **E6-1** | `member.set` / `space.set` have op **constructors** and no `MUTATIONS` entry, so a circle has no shared vocabulary. Every member row on every Mac reads „Name noch nicht angekommen" — including **my own** name, since writing it is the same missing mutation. 15.6's write half does not exist; 20.1's rename is per-Mac. | `core/ops.js` + a family publish path |
| **E6-2** | **Handing over the admin role is a one-way demotion.** `POST /members/transfer` answers `{authoritative:false, stored:'nothing'}` by design; the authoritative record is the `space.set{admin}` op E6-1 is missing. Measured on two Macs: the outgoing admin demotes himself, the successor is never promoted, **the circle ends with no admin anywhere and no route back**. The control is now **disabled** behind `adminpanel.js#TRANSFER_PROPAGATES=false` with its reason in both languages; `family-admin.dom.js` §7 was inverted to assert that, and a second row guards the confirmation copy at `consequencesOf()` level so it cannot rot. | `core/ops.js`; re-enable is one constant + one test |
| **E6-3** | **Leaving a circle bricks that Mac's family mode on that relay.** The device row survives the leave (revoked, not deleted) and `deviceId` uniqueness is global, so a later create *or* join is refused `400 device.deviceId/registered`. Server finding **E2-203-1** met from a second direction — the reported case was `deviceShort` vs a *personal* space; this is `deviceId` vs the joiner's own *past* membership. | `server/` — scope uniqueness to `(spaceId, deviceId)` |
| **E6-4** | **The huge paste field defeated its own parser.** `parseInvitePaste` is correct and its tier-2 rows pass; the field is an `<input>`, and an `<input>` **strips** newlines rather than spacing them, so pasting a whole invitation welded the code to the next word and yielded `found:'none'`. Fixed at the `paste` event, where `clipboardData` still holds the original string. **The test exercised the pure function and passes either way** — the seam a tier-2 row cannot see. | closed here |
| **E6-5** | v1's default **category** „Familie" collides with the member **section** „Familie" in the legend and in ⚙. Rename the category, or drop the section label and let the divider carry A3's two halves (~48 px saved). | PO / design |

### 10b. D9 part 4 is not demonstrable, and this is why

ADR 002 §7.1 steps 4–6 have **no implementation in the client** — absent, not incomplete:

```
client callers of GET  /api/v1/spaces/:id/keys   → NONE
client callers of POST /api/v1/spaces/:id/epoch  → NONE
client code wrapping the ring for a PEER device  → NONE
a route to push a wrap outside space creation or
  epoch rotation                                 → DOES NOT EXIST (23 routes)
sync/personal.js from crypto/spacekeys.js        → { spaceKindOf, isSpaceId }  ← no wraps
```

and a Familienkreis arms no engine at all: `readFamilyConfig` requires `personalSpaceId` to start
with `psp_`, and `assertPersonalSpace` THROWS on an `fsp_` id — correctly, and it must stay. Measured:
a full member's Mac made **zero** `/ops` requests in 8 s after joining, and makes none on relaunch.

**So D9's waiting state can be entered and cannot be left.** Its first three required behaviours are
demonstrated and machine-checked as negatives (no spinner, no error, no instruction to wake anyone,
the line names *another Mac* and not a person). The fourth — "it resolves itself" — is honest about
what is *supposed* to happen and, in this build, never happens. `E6-VERIFICATION.md` §5 states it
plainly rather than describing it as working.

**This blocks LZP-608 by the same mechanism**, since rotation needs the same wrap producer and the
same `POST /spaces/:id/epoch` client. Whoever builds one should build both.

### 10c. One defect this pass introduced and caught in the browser

Mounting the members port unconditionally made „Familie" — a heading and a member row — render in
the settings sheet of a Mac that had never heard of a Familienkreis, which is exactly what 15.1
forbids. `buildMembersSection`'s own guard could not see it: it asks whether a **port** exists, not
whether a **circle** does. Fixed in `mount.js#syncCircleMounts`, which mounts *and unmounts* on every
sheet open, because a Mac becomes a member mid-session (the join flow) and stops being one
mid-session (20.3). The lesson is the guard's shape, not the mount: a capability check is not a
state check.

---

## 11. E7 — visibility and sharing. What wiring the redaction boundary found.

**Date:** 2026-08-31 · **Tickets:** LZP-701…706 · Full record: `docs/v2/E7-VERIFICATION.md`.

§9 and §10 both closed on the same wall: the family half of the product had a membership lifecycle
and no content. This section is what happened when the content half was wired — the projection
(`core/project.js`, built by WP-10 and reachable from nothing), the level policy
(`core/visibility.js`), the sharing cluster (`family/sharing.js`) and the badge family
(`layout.js`/`board.js`) all shipped as parts with no path between them — and then **driven end to
end through the real store, the real `sealOp`, real AES-GCM, real `openOp`, real `foldAuthorized`
and real `materialize`**.

**What now holds, measured on the emitted ops and the sealed bytes rather than on the rendering:**
Papa marks an entry Belegt, Mama sees a neutral block with its date, its owner and its duration, and
the word „Scheidungsanwalt" is in no pre-seal plaintext, no envelope field, no ciphertext byte and
in no object recovered by decrypting the whole family log under **every** epoch key the family has
ever held. Papa downgrades to Privat and it leaves Mama's board at the next sync, with an explicit
`null` in every withdrawable register on her disk. A Privat entry — created, edited, moved, made
repeating, recategorised and deleted — emits **zero** family ops, counted.

### 11a. The seven findings

| id | finding | severity | owner |
|---|---|---|---|
| **E7-1** | **`core/ops.js:makeOp` dropped barrier 3's brand.** `{ ...f }` copies string keys only, and `projectForFamily`'s brand is a non-enumerable **symbol**. So every op built through the shipped constructor reached `sealOp` unbranded and was refused — **the epic could not have worked at all**, and the failure read as a bug in the projection. `makeOp` now carries own symbol keys across, and only when it did not widen the patch (a `born: true` op is a different field set from the one the projection asserted, and branding a widened copy is the "add a key to the object the allowlist produced" attack the freeze exists to stop). | **HIGH** | closed here · mutant **M1**, 21 rows |
| **E7-2** | **The exposure badge promised a disclosure the server had not received.** `materialize.js:exposureOf` accepts `lastAckedPubLevel` / `pendingPub` and neither was wired, so a **pending downgrade rendered as already withdrawn** — the badge under-reporting what the family can still see, the one direction ADR 004 §6 forbids. | MEDIUM | closed here · **M17** |
| **E7-2b** | **The newest ACKED level cannot be read off the register map.** The obvious implementation asks the map and treats an unacked winner as "no answer", which renders a pending Geteilt→Belegt as **`privat`** — worse than the bug it fixes. The map keeps only the winner and the winner of a pending downgrade is the op that has not reached the server, so it takes a pass over the log. | MEDIUM | closed here · **M18** |
| **E7-3** | **Acknowledging a push did not redraw the badge.** `ackPushed` is the only place a server `seq` appears for a local op and it did not re-project, so the board went on saying "not synced yet" until an unrelated edit. Lagging in the safe direction, which is why it was invisible; still wrong (19.3). | LOW | closed here · **M19** |
| **E7-4** | **P7i is true inside a padding bucket and false below the note-length cap.** Measured through the real `sealOp`: a Geteilt note leaves a Belegt op's 256-byte bucket **below 80 ASCII characters** — inside `ops.js`'s own `str80` and `popover.js`'s `maxLength`. A relay operator, who sees `(spaceId, epoch, deviceShort, seq, length)` in the clear (ADR 003 §6.3), can then tell "Papa shared something" from "Papa marked himself busy" **without a key**. Not a break of INV-R1 — no content escapes, one bit about a level does. The cap counts CHARACTERS and the bucket counts BYTES, so an 80-character astral note is 320 bytes and the gap is wider. Closing it means a second padding tier, a real storage cost (ADR 002 §8.7 prices padding at ~1.4×). **The boundary is measured and pinned**, phrased so that the day it rises above 80 the row must be inverted rather than relaxed. | **MEDIUM** | **OPEN** — PO decision · `crypto/envelope.js` |
| **E7-5** | **A share undone before it is pushed still transmits a retraction.** `derivePublication` reads `lastPublished` from the locally folded `pub.level`, which includes this device's own unpushed op — so "share, then change your mind" emits `pub.level: 'privat'` plus nulls for an entity no peer ever saw, creating a cell for a uuid they have never heard of. It discloses THAT AN ENTITY EXISTS, the same shape the projection already guards against for a dead-and-never-published entry. The safe half is verified: the first op is refused at barrier 4 (the truth register has moved on), quarantined by `sync/family.js`, and its bytes never reach the relay — **no content leaks**. Making `lastPublished` ack-aware would make the projection depend on transport state and diverge across a member's own two Macs, so it is not an obvious fix. | LOW | **OPEN** · `core/project.js` |
| **E7-6** | **ADR 004 §5.1's printed `retractPatch` remains unsealable**, confirmed end to end this pass. `pub.alive: false` is refused by `envelope.js` barrier 4 ("a privat payload carries a value"). The shipped `null` is also the better answer, and §4's row proves why: the owner's "→ Privat" and the admin's unshare are **byte-identical on the wire**, so a peer cannot tell which happened — Principle 9 by the absence of a distinguishing byte. | DOC | ADR 004 §5.1 · mutant **M3**, 23 rows |
| **E7-7** | `interact.js`'s `store.category(catId)?.defaultVisibility` was correct **only by coincidence**: it answers `undefined` for a dangling category and for a level outside the enum, and that `undefined` became `'privat'` only because `ops.js`'s enum validation, `replace.js`'s floor and `materialize.js` all happened to hold. Routed through `visibilityForNewEntry` it holds on its own. No mutant dies today, and that is the point. | LOW | closed here |

### 11b. What integration cost, and the two seams nobody owned

**Five files were wired and three of them shipped dark**, each because its consumer belonged to a
different work package:

- **`popover.js` hardcoded `visibility: 'privat'`** on the create path ADR 004 §3 names, so **16.4
  did not fire from the popover at all**. A category default that silently does nothing.
- **`family/mount.js` never installed the sharing cluster**, so `family/sharing.js` was on disk and
  unreachable — and it may not be a static import from `popover.js`, because `boot.js → main.js →
  popover.js` is the solo graph and ADR 003 §7 gate 2 refuses a static path from it into `family/`.
  It arrives as a **port**, set to `null` when the circle is left (20.3).
- **`i18n.js` carried none of ADR 004 §4.3's six keys**, so `board.js:FAMILY_COPY` — an interim
  table written to step aside — was still the authority. It has now stepped aside on its own, and a
  reworded level takes five DOM rows down with it (**M22**).

**The publication is DERIVED, not emitted by the control**, and that is the decision this pass would
most like the next reader to keep. `store.js`'s own header states the rule the outbox is built on:
*"every path that appends a local op is in the outbox automatically, with no publish hook to forget
at one of them."* A publication minted by the sharing cluster would be the seventh call site — and
it would be missing from ⌘Z, from a text edit of an already-shared entry, from a delete and from a
drag. `core/undo.js` had already decided this from the other side: a `pub.set` is deliberately not
undoable, *"because undoing the truth and letting the publisher re-derive is the only path that
cannot leave the family space describing a state the owner's board no longer holds."* That sentence
is only true if a publisher re-derives. It now does, from `_commit`, `undo()` and `redo()` — and ⌘Z
on a share emits the retraction (**M7**).

### 11c. Still owed after E7

1. **18.2's co-edit write path has no caller.** `projectCoEditPatch` exists and is narrow;
   `redaction-invariants.test.js` drives a co-editor's op in through `applyRemote` to prove
   promotion, but nothing in the product *authors* one. LZP-902.
2. ~~**The admin unshare (18.3) is unsealable.** Barrier 4 reads `ctx.levelOf` from the entity's own
   `visibility` truth register, and an admin unsharing *someone else's* entry has no such register —
   `store.familyLevelOf` correctly answers `null`, and "no authenticated level" is a refusal.
   `retractPatch(kind)` produces the right bytes and no `levelOf` can authorise them.~~
   **CLOSED 2026-09-02 (E9 / LZP-903)**, and closed WITHOUT letting the caller declare a level —
   which was the trap, because a caller-declared level is finding S5 rebuilt. `ADR 004 §2.2b`
   is the amendment: barrier 4 gained a **retraction clause** that applies the string literal
   `'privat'` to a patch that can only be a withdrawal (`pub.level: 'privat'`, every other field an
   explicit null) and vouches for it with a **second authenticated source that is not the caller** —
   `ctx.adminOf(op.space)`, the family space's `admin` register as resolved by the admin chain and
   folded by `foldAuthorized`, which must equal `op.act`. `familyLevelOf` is unchanged and still
   answers `null` for a foreign key. Producer: `core/project.js:adminUnshareOp`; driver:
   `family/unshare.js`; 105-cell domain in `tests/tier1/unshare.test.js` U1.
   **What the close FOUND, and it is a second defect, not a nicety:** §5's "the owner's client also
   sets its local `visibility` to `'privat'` in a follow-up txn" had no implementation and without
   it 18.3's "it reverts" is true only until the owner next touches the entry — `derivePublication`
   reads the level from `visibility` and `lastPublished` from the folded `pub.level`, which
   disagree after a moderation, so the owner's very next keystroke re-publishes the whole Geteilt
   patch and silently undoes it. `core/project.js:adminUnshareFollowUp(regs, ctx)` is built, pure
   and tested (U3, U3-a) and **has no caller**: it needs one call from `store.applyRemote` after
   `foldAuthorized`. Owner: `src/js/store.js`. Measured in U3-b, which is written to be INVERTED
   the day the caller lands.
3. **`tests/tier1/redaction-failpath.test.js`** is named by ADR 004 §2.3 and does not exist. Its
   content is covered by `redaction-invariants.test.js` §3 (mutants M5, M6) — a filename the ADR
   owes rather than a gap.
4. **ADR 005 §1.1's module tree** has no row for `core/project.js`, `core/visibility.js` or
   `family/sharing.js`, and names `assertNeverTransmitted` in `fleet.js`, where it cannot live:
   `fleet.js` is M1's fleet and its own identity gate asserts one member. It ships as
   `tests/helpers/never-transmitted.js`, a recorder any sealer can feed.
5. **A4 print density.** The foreign worst case (23 px, fixed) eats 59 % of `print.css`'s 39 px
   text budget. The suggested rule is in `belegt-render.dom.js`'s report.

---

## 11. E6 INTEGRATION — a circle that actually shares. What closing the gap found.

**Date:** 2026-08-31 · **Tickets:** LZP-601…**608** · Full record: `docs/v2/E6-VERIFICATION.md`.

§9 and §10 both closed on the same wall from opposite sides: *"E6's convergence question cannot be
asked of this build"*, because ADR 002 §7.1 steps 4–6 had no client implementation. This section is
what happened when the family engine, the key delivery, the publish path and the removal driver were
wired together and three real Macs were put in one circle.

**Suites at the close:** 2008 · 769 · 101 · 868 · 193 · 32 files. All green.

### 11a. The convergence question, asked and answered

Three browser contexts against `node server/dev-server.mjs` (three origins, three storage
partitions, three durable identities): create → invite → join → **D9's waiting state clearing by
itself** → a shared entry on two other boards → a joiner receiving three years of history → a name
change propagating → removal with its epoch rotation → the removed member's board byte-identical.

**D9 part 4 is demonstrated.** On Mama's Mac, with `cadence.wake()` the only thing called anywhere
and no notification of any kind: `keysPending true → false`, `epochs [] → [1,2,3]`,
`heldEnvelopes 6 → 0` — six parked envelopes re-judged and applied **in the same pass**, because
`syncNow()` runs `keys.admit()` *before* the pull. That ordering is the mechanism; the `ringGrew`
second sweep is a labelled backstop.

The relay's stored bytes were searched with the search **armed** (a planted needle is found in the
same bytes): no display name, no circle name, no entry text and no date, in the raw 31 554 bytes or
in the 16 199 decoded from all 553 base64url tokens.

### 11b. Four findings, and why a green suite could not see any of them

**Every one of these silenced the entire circle while looking like normal operation**, because each
fails by *parking* or by *declining* — which is the shape this product is deliberately designed to
have. The ops arrive, they are held, the board is empty, and nothing anywhere is in an error state.
That is the correct failure mode and it is exactly why the absence of a cure has to be tested for.

| id | severity | finding | owner | status |
|---|---|---|---|---|
| **E6-7** | HIGH | **Nothing in `src/js/` ever supplied `ctx.attestOpen`.** `authz.js` stage 0a's `attestationVerifies` returns `false` for *every* blob without an opener — fail-closed, correctly. So every peer's `member.set{dev.<short>}` was rejected `badAttestation`, and because that op is the only thing that could ever attest that device, every later op from that peer parked `unattestedDevice` **for ever, curable by nothing**. A circle could not admit a single op from anybody. | `store.js` + `family/engine.js` | **CLOSED** |
| **E6-7b** | HIGH | The attestation tables were seeded **once, at engine start**. A member who joins while somebody's app is open — the normal case — was unattested on that Mac until it restarted. Same class, one layer down: a Mac in a Familienkreis and nothing else never adopted a durable identity at all, because `main.js#armFamilyMode` gated on 19.4's *personal* opt-in and `useIdentity()` may only be called before `init()`. Its `store._short` was random and `createFamilySync` refused to construct. | `sync/keys.js` + `family/engine.js` + `main.js` | **CLOSED** |
| **E6-9** | HIGH | **D9's own window destroyed the ops a joiner authors inside it.** `adoptCircleIntoLog` writes Mama's attestation and her name the instant she is admitted, when she holds no key — the state D9 exists for. `sealLine` threw and `pushNow` **quarantined** both, and a quarantine has no cure. The two ops that say who a member *is* were destroyed by the window designed to make her arrival survivable. | `sync/family.js` | **CLOSED** |
| **E6-8** | MEDIUM | A clipboard refusal destroyed the invite it was copying. `navigator.clipboard.writeText` threw `NotAllowedError`, the rejection escaped `createInvite`, and the panel reported failure and „Keine offene Einladung" **while the invite existed on the relay**. `POST /invites` stores a verifier and never the code, so a code not read out of that response is gone for ever. | `family/adminpanel.js` | **CLOSED** |

**The fixes, each in one sentence.** E6-7: `store.setAttestOpen(fn)` — a seam *separate* from
`useIdentity`, because an identity is adopted once before `init()` while *who I can verify* changes
every time the roster does. E6-7b: `sync/keys.js#roster()` gains an `onRoster(members)` port called
on every read (on `roster()` and not on `admit()`, so `deliver()` and `rotate()` refresh it too and
there is no second GET), and `main.js`'s gate grows `familySpaceId` with `mount.js#armCircle`
adopting the identity *without* a personal space. E6-9: a `FamilySyncError` of kind `'key'` leaves
the line in the outbox and counts it as `opsHeldForKey` — "waiting for a key" is a state, not an
absence — while a *shape* refusal is still quarantined. E6-8: the mint is committed and the list
drawn before the copy is attempted, and the toast shows the code whether or not the clipboard
cooperated.

**Mutants — each named row dies** (isolated copy, one run each, `tests/tier1/sync-family.test.js`):

| mutant | row |
|---|---|
| M-A `keys.js#roster` stops calling `onRoster` | `§7c` |
| M-B a key-less seal is quarantined again | `§7d` |
| M-C `store.setAttestOpen` becomes a no-op | `§7b` |
| M-D the fold ignores `ctx.attestOpen` | `§7a` |

### 11c. §10's rows, re-judged

- **E6-1** (`member.set`/`space.set` have no mutation) — **CLOSED.** `MUTATIONS` rows 23–28 plus the
  publish path. Closing it required closing **E6-7** as well, or the ops would have arrived and been
  rejected: the two are one defect seen from the two ends of the wire.
- **E6-2** (admin transfer is a one-way demotion) — **CLOSED.** `transferAdmin` is authored *before*
  the advisory relay call, `adminPrev` comes from `store.familyAdmin().headOpId`, and
  `TRANSFER_PROPAGATES` is `true`. `tests/tier2/family-admin.dom.js` §7 is inverted and asserts the
  op, its `adminPrev` and the ordering.
- **E6-5** (the „Familie" collision) and **E6-6** (hiding a second member un-hid the first) —
  **CLOSED**, and E6-6 is now driven through the same seam that had the bug.
- **E6-3** (leaving bricks that Mac's family mode: global device uniqueness) — **STILL OPEN,
  `server/`.** Not reachable from this pass. It is the last row of §10 that is untouched.

### 11d. One row this pass CLOSED in the property domain, and why it stayed a `defence`

`S5-core-project` reported `src/js/core/project.js` as reachable-from-nothing (`openFinding: P-4`).
It is now reachable, and the door is `sync/family.js#sealLine`, which passes `assertFamilyPatch` as
`ctx.assertFamilyPatch` (ADR 004 §2.2 barrier 2) alongside `store.familyLevelOf` as `ctx.levelOf`
(barrier 4). Both are **required** by `sealOp` for a family `pub.set`, so the boundary is not merely
reachable, it is unavoidable on the one path that seals one.

The row keeps `role: 'defence'` and loses its `openFinding`, and the distinction is the point of
having two fields: `openFinding` asks *"is it wired?"* and the answer is now yes; `role` asks
*"would deleting this file make the product worse while turning this row green?"* and for a choke
point that is permanently yes.

`store.familyLevelOf` is barrier 4's source, and the one decision in it is which register it reads.
`visibility` — the entity's own `gov` truth register — is the only right answer: `pub.level` is the
level a transition is moving *away* from, so wiring barrier 4 to it makes every first share and
every downgrade a refusal (finding S5, met from the store's side). A foreign entry answers `null`,
which barrier 4 turns into a `RedactionError`: **this device may not publish somebody else's entry**,
and answering with the peer's last-published level instead would let a co-edit re-publish a text its
owner had since withdrawn.

---

## 12. E8 — family board rendering. What integrating it against DENSITY found.

**Opened 2026-09-01 by the E8 integration pass.** Full record: `docs/v2/E8-VERIFICATION.md`.
Three build streams landed LZP-801…807; this pass applied them together, measured what they cost
the thing the product exists to do, and drove the result. **Suites at the close: 2008 · 101 · 860 ·
892 · 252/258 (six red, none E8's — 12c) · tier 2 36 files / 642 rows, all green.**

The headline is a measurement, not a claim: **seven other people, 3 059 notes and 416 bars across
two years produce a board whose geometry is `deepEqual` to the solo board built from the same
fixture** — row height, row block, board height, column width, note-body width, toolbar height,
board top. E8 is bought **entirely out of horizontal space**, and the worst prefix (22.8 px) is
under the 23 px `layout.js` publishes for it.

### 12a. Two v1 CHARACTERIZATION rows were red at HEAD — both calendar drift, both CLOSED

The brief's oracle is v1. Two rows were red on 2026-09-01, **both reproduced in a pristine
`git archive HEAD` copy with every E8 change absent**, and both were the same defect class: *a
characterization test whose answer depends on the month it is run in*.

- **E8-1 (MEDIUM) — `dom-rendering.dom.js` 7.2, „a weekday in Ferien". CLOSED.** The window opens on
  today; `ferienSample()` took the **first** Ferien weekday in it, which on any run inside a
  Sommerferien **is today** — and Today's tint deliberately outranks `.fer` (8.1 has its own test for
  exactly that). The row was silently re-characterising the Today rule under the wrong name. Fixed by
  excluding `M.today` from the sample, the rule `plainDate()` and `holidayDate()` two functions above
  already apply. **Mutant:** `.day.fer { background: transparent }` reddens the repaired row, so the
  fix moved the fixture and not the assertion.
- **E8-2 (MEDIUM) — `belegt-render.dom.js` §7, „hiding a member … repacks the lanes". CLOSED.** `COL`
  is the second visible column — **October** whenever the app opens in September — and the test puts
  two notes on **day 3**, Tag der Deutschen Einheit. The holiday takes line 1 (DESIGN-DECISIONS §B),
  capacity drops to one, and a row that placed two notes placed one. Fixed with `NO_LAYERS` on both
  `withBoard` calls — the constant `family-render.dom.js` already introduced for this hazard.

**The class, for whoever writes the next fixture:** any row-count assertion must own its ambient
layers, and any day-of-month or first-match fixture must be **scanned for** rather than guessed.

### 12b. E8-3 (MEDIUM, OPEN) — deliverable 17 does NOT hold at 18 px, and that is the finding

Deliverable 17 asks for the five badges „all coexisting at 24-px rows". At the **22 px default** they
do, and it is measured rather than asserted: one day row carrying a visibility badge (16.6), a Belegt
block (16.7), an initial chip (17.2), a „neu" dot (17.5) and a ↻ (9.2) **simultaneously**, plus `+n`
and three bar lanes, gives **7 painted marks, 0 collisions, smallest mark 3 × 3 px, every gap ≥ 1 px**
(`family-density.dom.js` §1). The audit is mutation-tested: `.note .chip { margin: 0 -4px }` reddens
it and names both boxes and the overlap in pixels.

**At 18 px — v1's own minimum — it does not.** The capacity rule gives an 18 px row one line, so the
same day draws **one** entry and three of the five marks; the visibility badge and the ↻ go into
`+5`. Nothing overprints, nothing is illegible, and the entries that lose their place are counted and
reachable through the popover — the loss is DESIGN-DECISIONS §B's capacity rule, **not an E8
collision**. But the deliverable's sentence is true at 22 and false at 18, and that is better said
here than discovered on paper. **Owner: design.** Either the deliverable is scoped to the default row
height, or 17.7's Komfort/Kompakt setting (LZP-808, `[Could]`) becomes the answer — both ends of the
range it would extend are now measured.

### 12c. E8-4 (HIGH, OPEN, NOT E8's) — `test:fleet` is red on the parallel workflow's own red team

`tests/fleet/e6-attack-removed.test.js` §1 and §1e fail with
`{"error":"admin_proof_required","reason":"founder_removal_needs_second_key"} · 403 !== 200`.
The `server/*` workflow has landed a **founder-removal guard** in the uncommitted
`server/core/auth.js` + `server/core/errors.js` and has not yet inverted its own red team against it —
the same shape as E6's `§5d`. **`test:fleet` is 244/244 at pristine HEAD** and E8 touches nothing the
fleet suite loads. **Owner: the `server/*` workflow.**

Related, and a rule rather than a finding: `test:server` reported **888/4** during a run that
overlapped one of that workflow's writes and **892/0** on four consecutive clean runs afterwards.
**A suite result taken while another workflow is writing the tree is not a result.**

### 12c-2. E8-7 (LOW, co-dependent by design) — one red-team row must invert WITH `deviceCount`

E8's files were also run **alone on top of HEAD**, in a `git worktree`: tier 1 **2008/0**, property
**101/0**, attack **860/0**, server **868/0**, fleet **243/1**. The single red row is
`tests/fleet/e6-attack-keydelivery.test.js` **§5d** —
`MemberRow has no device field, so §8.5's mitigation is not rendered anywhere · expected false,
actual true`. At HEAD that is an *attack-SUCCEEDED* row asserting ADR 002 §8.5's only stated
mitigation is absent; `membersui.js` adding `deviceCount` to `MemberRow` makes it present, so the row
**must** invert with the fix (§7c's rule). **The inversion already exists in the shared working
tree**, written by the `server/*` workflow inside the same file, which is why the full tree shows it
green. E8 does not own that file and does not stage it: the two commits are **co-dependent on one
row**, the branch tip is green once both land, and whoever lands second should confirm `test:fleet`.

### 12d. E8-5 (HIGH, OPEN) — LZP-804 has a board half and no inputs: 17.5 renders nothing today

`store.js:_project()` passes `materialize` no `seqOf`, no `lastSeenSeq` and no `levelDecreased`, and
nothing anywhere advances `settings.lastSeenSeq.<spaceId>`. `isNewOf` therefore always answers
`false`. The dot is built, priced (3 × 3 px painted, `PREFIX_COST_PX.neu` 5 px) and proven
Principle-9 clean — and **it cannot fire in the shipped app**. Carried forward from the
`build:legend-neu` pass and re-confirmed here on the running board.

**The hazard that makes this worse than a missing feature:** `materialize.js:359–371` — `ctx.seqOf`
and `ctx.levelDecreased` are **independent optional hooks** and `isNewOf` **fails open**. A caller
that supplies the seq source and forgets the suppression gets a „neu" dot on **every downgrade**,
silently, with nothing on screen that looks wrong — the exact mechanic Principle 9 forbids. A
tripwire in `family-legend.dom.js` §3 requires the two hook names to appear together in `store.js` or
not at all; it is green today because `_project()` supplies neither, and it goes red the moment
somebody wires half of it.

**And a design question that must be answered in the same change:** hiding Papa (17.3) filters his
entries at `layout.js` before they can dot, so a single per-space `lastSeenSeq` scalar marks his new
ink „seen" without it ever having been shown — un-hiding him then silently produces old ink. Either
the advance excludes hidden members, or 17.3 is documented as discarding their „neu" state.

### 12e. E8-6 (MEDIUM, OPEN) — 17.6 says *hover/popover* and the hover half says an initial

Driven on a real register map through the real `materialize` (E8-VERIFICATION §5), on Mama's board
with Papa as a peer:

- Papa's shared note renders `title="Zahnarzt"` — `board.js:renderNote` joins the text with
  `exposureTitle`, and a foreign entry has no exposure of mine, so the tooltip is the bare text. **No
  „von Papa", no „geändert".** The popover half is built and correct; the hover half is missing.
  Owner: `board.js`.
- His Belegt bar renders `title="P · Belegt · 2026-10-12 – 2026-10-18"` — right in shape, but the
  owner is an **initial**, and it stays an initial even with `useMemberNames` installed, because
  `redactedTitle` never consults it.

**Both trace to one uninstalled port.** `src/js/family/mount.js` never calls
`popover.useMemberNames(...)`, so `memberNameOf` answers `null` everywhere and every name in the
product falls back to a letter. Proven by installing it live: the print member key goes from `Ⓟ P` to
`Ⓟ Papa` and the A4 strip's ink from 336.5 px to 467.4 px of 1 062 — still one line, still one page.
One line of code in a file E8 does not own.

### 12f. What was attacked and HELD — recorded so it is not re-attacked

- **Geometry.** Solo vs family on the 8 × 2 y fixture: `deepEqual` on seven measurements, with
  non-vacuity asserted in the same row (192 → 715 notes, 40 → 135 bar segments in the DOM).
- **17.3 is a toggle, not a dimmer.** With all seven members hidden the board is the solo board
  **entry for entry** — 192 notes, 40 bars, 2 overflow badges on both sides — and the print strip
  returns to v1's exact ink width, 202.6 px to the tenth.
- **A8 on paper.** The A4 strip is **15.5 px tall** with 0, 7 and 8 members, and a hidden member is
  off the paper: 7 member items → 0, divider gone. Measured with the `@media print` rules lifted onto
  the screen — a height read without that lift is 0 px, and `0 === 0` is a green cell that measured
  nothing, which §6 now asserts against explicitly.
- **The 60 fps AC.** Worst main-thread drag frame **8.7 ms of 16.7** in Chromium and **≤ 6 ms** in the
  shipping WebKit, across 600 measured frames and three gesture kinds, zero frames over budget. E8
  roughly doubles the median frame cost (0.6 → 1.2 ms) and leaves 15.5 ms unspent. **What is NOT
  claimed:** a wall-clock frame rate — neither available engine renders to a visible window here, so
  rAF is suspended in both, and raster/composite is therefore unmeasured.
- **Principle 9.** A downgrade produces no dot, **no gap** (`noteBox` and `dayBox` equal to an
  untouched entry's — a suppressed marker that still reserved its 5 px would be a downgrade detector
  made of whitespace), no markup difference, no `title` difference, no `aria-*` difference, and no
  change to the toolbar's `innerHTML`. A control row proves added ink *does* dot, so the silence is a
  result and not a broken renderer.

### 12g. Process — the stash rule, restated because it has now bitten twice

`git stash` was run twice in this shared tree by earlier passes and swept up other workflows'
in-flight files both times. **Nobody may stash in this tree.** Every clean-tree comparison in this
pass used `git archive HEAD | tar -x` into a scratch directory, which touches nothing.

## 13. T5 — the family red team, and the integration pass that answered it

**The round.** After E6 and E7 landed green at `81b793d`, a red team attacked a **real
three-member Familienkreis** as an invited, attested, non-admin member — ADR 002 §0's T5: one
member, one patched app, one Keychain. 51 rows.

**The good half, and it is the important half. Nothing it found was a confidentiality break.**
Five routes at the redaction boundary produced **zero bytes** of a Privat entry. Barriers 2/3/4,
the two branded recipient scopes, the branded sender set, the per-space `KeyRing` and both
mirror-image constructor refusals all held, each for a stated reason. That set is unchanged by
this pass and still green — `tests/fleet/e6-attack-privat.test.js` §1a–§1g, and
`e6-attack-removed.test.js` §2a–§2d for the read half of story 20.5.

**Its verdict: „E7 can be built on this engine. It must not ship on it."** What a hostile member
could do was not read. It was **deny, destroy and redirect**. This section records the five
findings and what the integration pass did with each.

### 13a. The five findings

| id | sev | what | status |
|---|---|---|---|
| **T5-M1a** | HIGH | An ordinary member removes **the founder** in one request, taking ADR 001 §4.0's attestation and §4.1's admin-chain genesis link with him — after which `adminAtIn` answers null for every stamp in the space and no future joiner can admit anything he wrote. | **CLOSED** (founder anchor) · residual stated |
| **T5-M1b** | HIGH | An ordinary member deletes the whole Familienkreis in one request. | **CLOSED** (two-key rule) |
| **T5-M1c** | HIGH | The long way round: remove everybody, then `/members/leave`, whose last-member-out cascade deletes the space. | **CLOSED** — by M1a, not by gating the cascade |
| **T5-K1** | HIGH | A lost rotation race discharged the delivery this device owed: an epoch bump was read as proof that the bump delivered a **usable key**. The relay's coverage check is a **row count**. | **CLOSED** (client) + **CLOSED** (store) |
| **T5-K2** | MEDIUM | D9's waiting state cleared on the relay's `keysPending` row count rather than on the ring the device actually holds. | **CLOSED** |
| **T5-K3** | HIGH | `putKeyWraps` was an **upsert**. Any member could overwrite every wrap of every recipient for every epoch below her own with bytes nobody can open, and the relay recorded it as coverage. | **CLOSED** |
| **T5-K4** | MEDIUM | A member attests an outsider's Mac and the family delivers the ring to it. Every barrier passes, because every fact about the row is true. | **OPEN by design** · §8.5's mitigation now FED |

### 13b. The T5-M1a ruling, because it is a decision and not a diff

E2-203-2 asked for "a signature by the **current admin's** `RK_sig`". **That cannot be built**,
and the reason is structural rather than an omission: the admin chain is an in-log `transferAdmin`
op (ADR 001 §4.1) inside the ciphertext, and a blind relay may not read it. `Member.joinedAt` is
useless as a substitute — `createSpace` and `redeemInvite` both set it from `ctx.now()`, and it is
identical for every member of a space created and joined inside one millisecond
(`AUTH_INTERFACE_GAPS` E2-L1b).

So the relay's only blind rule is **"a second member co-signed"**. Three shapes were considered:

1. **Required for every removal.** Rejected, and *measured* rather than argued: mutant **M-M5**
   reddened **13 fleet rows and 31 server rows** — the whole E6 removal demonstration, round 9 and
   round 10. Worse, in a **two-member circle the rule is unsatisfiable**: the only other member is
   the target, and she will not co-sign her own removal. A rule that cannot be satisfied is not a
   rule, it is the feature deleted — and the couple whose relationship ends is the most likely
   real removal there is.
2. **`Space.founderMemberId` as an ADMIN column.** Rejected: `transferAdmin` is a real, shipped
   op, and `leavedelete.js:503` calls it when an admin leaves. Gating on the founder as if he were
   the admin would break the honest path after every transfer.
3. **Required to remove THE FOUNDER.** *Adopted.* Not a compromise between "closed" and "green" —
   it is where the damage is. Removing the founder is the only removal that destroys the space for
   **everybody** rather than for one person, and it is the one the relay can recognise blind.

`Space.founderMemberId` is written by the relay itself inside `POST /spaces`, from the Member row
it creates in the same transaction. No route sets it, no body field reaches it, it never moves.
It is a historical fact the relay observed, as `createdAt` is — **not** a role column, and
`blindness.test.js` §2 is where that classification is argued and enforced rather than assumed.
Nullable, and a null **fails OPEN**: a Space row written before the column existed must not be
wedged.

**What is still open, and it is asserted rather than implied.** An ordinary member may still
remove any **non-founder** on her own word, and two members who collude may remove the founder.
Rows: `attack-client-lifecycle.test.js` §D §3, `lifecycle.test.js` "and a NON-founder is still one
request away", `e6-attack-removed.test.js` §1e-ii. Closing it needs the relay to verify the admin
chain — an in-request transfer-certificate chain anchored at `founderMemberId` — which is a
protocol change (ADR 003 §3.7), not a gate.

### 13c. The wrap-cell conflict, and why the cell grew a fourth column

Two parallel fixes collided head-on, and resolving it was the largest single decision in the pass.

T5-K3's fix made `putKeyWraps` **write-once on `(spaceId, epoch, recipientId)`**. Correct for the
attack it closes — and it handed T5-K1 a new weapon, which the coverage-proof pass measured and
reported as BLOCKING: **a joiner's cells for epochs `1..e` are all empty when she arrives**, so a
hostile member who rotates first owns them for ever and every honest re-delivery is refused *by
the relay*. Measured: Mama ended holding `[4]`, no history, „Omas Geburtstag" never rendered, and
her ops quarantined into an `error` screen.

The close is to make the **depositor part of the cell** —
`@@id([spaceId, epoch, recipientId, senderDeviceId])`. Both findings then hold at once:

- Eve cannot move one byte anybody else deposited: a different depositor is a different row, so
  **T5-K3 is closed by construction rather than by refusal**.
- The honest wrap and the junk **coexist**, which is the case `admitWraps` already handled — it
  walks a recipient's rows, counts the one that will not open as `refused`, and admits the one
  that does. `assertCoverage` folds a recipient's rows into a Set of epoch numbers before it
  counts, so duplicates cannot inflate coverage.
- C61's **healing path** — a live sender re-delivering an epoch a since-revoked device deposited —
  comes back, safely. The intermediate three-column rule had given it up as indistinguishable from
  the attack; with the sender in the cell nobody ever overwrites anything, so the question does
  not arise.

**What it costs, stated:** rows, not data. One row per depositing device per `(epoch, recipient)`,
bounded by `MAX_WRAPS = 1024` per rotation and by the epoch race every rotation must win, under a
signed device identity and a rate-limit budget — the same shape of attributable, chargeable cost
as `e6-attack-removed` §1e-ii.

**One consequence had to be un-built.** `sync/keys.js` had gained a warning — "the relay kept N
wrap cell(s) somebody else had already filled". True under the narrower cell; a **permanent false
alarm** under this one, because `wrapsRefused` can now only ever be a device re-wrapping its own
earlier cells with a fresh salt and IV, which every rotation after the first does. It was removed
rather than kept as reassurance. `wrapsRefused` is **ordinary accounting and never an abuse
signal**, and `spaces.js`, `memory.js` and `store-interface.js` all say so at the point of use.

### 13d. Two rows that were passing vacuously, found by their own mutants

Recorded because they are the reason mutation testing is worth its cost.

- **`§3a2` / `§1d2` (the three rotation counts).** They asserted that `wrapsAdded + wrapsKept +
  wrapsRefused === wrapsStored`. That is **vacuously true** of a handler answering
  `wrapsAdded: wraps.length, wrapsRefused: 0` — mutant **M-E(spaces)** killed *nothing*. Fixed by
  asserting on a rotation where the store did something different from what was sent
  (`wrapsRefused > 0` and `wrapsAdded < wrapsStored`); the mutant now dies.
- **`§3a` (T5-K3's own invariant).** It folded `GET /keys` onto `epoch`, which after the cell
  change compares against whichever row the relay served last — a test artefact that reads exactly
  like the attack succeeding. Re-keyed onto `(epoch, senderKexPubRaw)`, the identity the store
  actually uses, with the depositors derived from each Mac's own device key rather than read back
  off the response.

### 13e. What the pass changed, by file

| file | change |
|---|---|
| `server/prisma/schema.prisma` | `KeyWrap.@@id` gains `senderDeviceId`; `Space.founderMemberId` added, with why it is not a role column |
| `server/adapters/memory.js` · `prisma.js` | the four-column cell; write-once; `{stored, kept, refused}` |
| `server/core/store-interface.js` | `Space.founderMemberId` in `MODEL_COLUMNS`, `NULLABLE_FIELDS` and `PLAINTEXT_STRINGS`; E6-I1 amended; C34/C61/C63 rewritten |
| `server/core/handlers/lifecycle.js` | the founder gate; `admin_proof_required` |
| `server/core/handlers/spaces.js` | `founderMemberId` stamped at creation; the three rotation counts |
| `server/core/auth.js` | `verifyAdminProof`, the two-key rule; E2-L1b re-stated as HALF CLOSED |
| `server/core/errors.js` | `admin_proof_required: 403` — authority, not shape |
| `server/core/limits.js` | `RATE_COVERAGE.deleteSpace` names the extra verify |
| `src/js/sync/keys.js` | coverage from **keys** not epochs; `ringIsWhole`; the false-alarm warning removed |
| `src/js/sync/outbox.js` · `cursor.js` · `family/engine.js` | per-space slot scoping, synchronous ports |
| `src/js/family/mount.js` | `refreshRoster` carries `devices` — §8.5's mitigation is now fed |

### 13f. Owed after T5

1. **The T5-M1a residual** — an in-request transfer-certificate chain anchored at
   `founderMemberId`, so the relay can verify the *current admin* and not only the founder.
   ADR 003 §3.7, `AUTH_INTERFACE_GAPS` E2-L1b.
2. **A co-signature UI. — CLOSED 2026-09-03 (LZP-1002 integration).** It read: *"`adminpanel.js`
   and `leavedelete.js` mint no `adminProof`, so the honest two-key paths — deleting a circle with
   more than one member row, and removing the founder — have a working relay and no screen."*
   The screen exists (`leavedelete.js#openCosignRequest` / `#openCosignSign`, 43 rows in
   `tests/tier2/cosign.dom.js`) and it has now been driven **end to end in the shipped `.app`, in
   a genuinely founder-less circle**: the relay refused with
   `founder_gone_every_removal_needs_second_key`, a second instance co-signed with its own
   `RK_sig`, and the spent proof came back `authorizedBy=admin_proof` with the epoch rotating
   6 → 7. `docs/v2/SHELL-VERIFICATION.md` §4.
3. **ADR 002 §8.5a's remaining residual.** No device can prove that an epoch minted by *somebody
   else* reached a third party in openable form. Closing it needs a way for a member to report "I
   cannot open epoch e" → ADR 003 + `server/core/handlers/keys.js`.
4. **T5-K4 is open by design** and stays a residual: a member may attest an outsider's Mac, and
   every barrier passes because every fact about the row is true. §8.5's device-count mitigation
   is now built *and* fed; it is a mitigation, not a fix.
5. **`prisma.js` is UNVERIFIED** against a real Postgres, as it has been throughout —
   `U-WRAPONCE` and `U-WRAPNOUPDATE` carry the claims, and the contract cases are what hold both
   adapters to them.

## 14. ROUND 3 — the member adversary's second pass, and the integration that answered it

**The round.** A second member-adversary attacked the gate that answered the first one, then
re-attacked the redaction boundary from every state each round created. Three fixers worked in
parallel against its findings — the epoch budget, the two-key premise, the parking slot — and this
is the integration pass that landed the cross-file work, mutation-tested every fix, re-ran both
red teams, re-drove the honest circle, and answered the ship question.

**The standing result held for a third round. Zero bytes of a Privat entry**, and this pass did
not merely re-run the old rows: every fix in the round *invented new refusal bodies*, and a
refusal is a response body assembled by a handler that is holding the roster. So the boundary was
re-measured across the four refusals that did not exist before — the presenter-mismatch `401`, the
already-removed `400`, the `space_full` `400`, and the founder-less `403` with its two new prose
fields — and it is clean across all of them (`tests/fleet/e6-gate-privat.test.js` §2a, new).

**The adversary's verdict was „No. E6/E7 cannot ship on this engine."** Its framing was the brief:

> Both are the fixes resting on a premise the T5 threat model does not grant: **that a `Member`
> row is a person, and that an epoch number is scarce.**

Both premises are now addressed *in the only two ways a blind relay can*: the epoch premise is
made true by a budget (E2-L9), and the person premise is **not** made true — it is demoted on the
wire and bounded, because no relay can make it true. That distinction is the whole of §14b.

### 14a. What this integration pass landed itself

| # | what | why it was this pass's job |
|---|---|---|
| 1 | **N-3 — the presenter binding** (`lzp/admin/2`). `adminProofString` gains a sixth component, `presenter = terms.callerMemberId`; `verifyAdminProof` passes it. | The two-key fixer costed it and could not land it: three fleet helpers mint the bytes and it owned none of them. **The integrating pass owns all three.** It landed *before any co-signature UI exists*, which was the stated condition. |
| 2 | The `e6-gate-privat.test.js` §1d patch | Predicted by the two-key fixer, in a file it did not own. |
| 3 | **§2a of `e6-gate-privat.test.js`** — the boundary re-attacked across the round's four new refusal bodies, with a **positive control** proving the search machinery is live | Nobody owned "what the new error paths emit"; each fixer saw only its own. |
| 4 | The owed **ADR 003 §6.1 amendment**, all five budgets (E2-L3 … E2-L9) | Carried as `AMENDMENT OWED` in `limits.js` since round 2. |
| 5 | **A latent flake in a redaction row**, found by the mutation harness and fixed | §14d — it is the one genuinely new defect this pass found. |

### 14b. The ship question, item by item

| # | question | answer | rows |
|---|---|---|---|
| 1 | Is the **epoch freeze** closed? | **Priced, not closed — and the record says so.** `epochRotationsPerMemberHour: 20` bounds the ratchet, keyed on the member, spent only where a request takes a rung. But §2a is **not** a volume attack: **one** poisoned rung freezes the space, so no rung budget reaches it. Closing it needs ADR 002 §8.5a's report path. `limits.js` pins `/DOES NOT CLOSE/` so a limiter cannot be credited with a finding it does not close. | `e6-gate-keys` §1a §1b §1c §2a §2d §3d |
| 2 | Is the **two-key rule** a real control or honestly demoted? | **Honestly demoted, and bounded.** It is a *two-row* rule, not a two-person rule: `PROVES`/`PROVES_NOT` ride every 200 and `checks`/`doesNotCheck` every 403, and the strong string is asserted to contain no "people"/"person". `MAX_LIVE_MEMBERS = 8` bounds the sybil fleet for the first time. It is **not closed** — T5-M2 is a PO ruling, and both closes are somebody else's file. | `e6-gate-removal` §1d §1e §1f §1g; `lifecycle.test.js` T5-M2 |
| 3 | Is the **founder anchor** live-checked? | **Yes, CLOSED.** `required` now asks `founderLive`, false for a tombstone *and* for a row that is gone. Cost stated, not hidden: in a founder-less **two**-member circle the rule is unsatisfiable — each can still leave, the last one out takes the space, every device holds a complete replica. | `e6-gate-removal` §2a §2a-ii §2b §2c |
| 4 | Is the proof bound to its **presenter** and its **target**? | **Yes — both halves, CLOSED this pass.** Target: an act already done authorizes nothing (`admin_proof_target_already_removed`). Presenter: `lzp/admin/2` puts the caller in the signed bytes. Refusal is the existing `401 bad_signature`, so no new oracle. **What it does not buy:** Eve holding two rows mints her own proof naming herself — it stops a proof travelling between two *people*, it cannot make two rows into two people. | `e6-gate-removal` §3d §3e §3e-ii; `auth.test.js` §6b |
| 5 | Is the **parking slot** per space? | **Yes, CLOSED.** `${LS_PARKED}.${spaceId}`, legacy slot read-never-deleted, the port exported so §2 drives shipped bytes, and R8-5 restored in production (`writeJSON` swallowed, so a failed park reported success on every full disk). The **shelf** still has no bound — narrowed, not closed. | `e6-gate-slots` §2a–§2h |

**Can E6/E7 ship on this engine now? Not yet — and what remains is three items, none of them a
confidentiality question.**

1. **A co-signature UI is now a shipping prerequisite, not an owed screen.** T5-M3's founder
   anchor means a founder-less circle needs a second key for *every* removal, and
   `adminpanel.js` / `leavedelete.js` mint no proof. The relay is ready and the client cannot
   drive it. This is the blocking item.
2. **T5-M2 is a PO/D7 ruling.** A `Member` row is not a person and no blind relay can make it
   one. The two real closes — an admin-signed invite on the transfer-certificate chain, or the
   co-signature moved into the op log — are protocol work. Until then `admin_proof` is a field
   that says on the wire that it is not a control.
3. **Two priced-not-closed residuals**: the epoch poisoning (§2a, needs ADR 002 §8.5a's report
   path) and the unbounded shelf (`sync/outbox.js`).

**What changed since the adversary's "cannot ship" is that all three are now decisions or
screens rather than unknowns**, every one of them is measured by a row that says SUCCEEDED, and
nothing in the round touched the redaction boundary.

### 14c. The mutation table — every fix, plus both over-closing controls

Every mutant is a `tar` scratch copy; the real tree is never mutated and `git stash` is never
used. Baseline noise in a copy: `tests/attack/v1-frozen-store.test.js` shells out to `git show`
and fails with no `.git`. **Every row below is a kill that was observed, not predicted.**

| mutant | the fix it reverts | rows that died |
|---|---|---|
| **N-5-inv** — the `enforceFor` block deleted | E2-L9, the epoch budget | `e6-gate-keys` §1a §1b §1c §3d **+** `limits.test.js` "a route that declares a rate rule must actually reach store.rateAllow" |
| **M-ENTRY** — charge every attempt, not every climb | the *shape* of E2-L9 | **`e6-gate-keys` §2d only** — the honest-loser control, and nothing else. This is the row that proves the charge belongs at the rung. |
| **M-IP** — `identity: 'ip'` | the key of E2-L9 | `limits.test.js` T2-E1 **+** `e6-gate-keys` §1a §1b §3d |
| **M-NUM** — 20 → 4 | the size of E2-L9 | `limits.test.js` T2-E1 (the "above every 10/hour cause" loop) + 3 more |
| **M-N2** — anchor stops asking `founderLive` | T5-M3 | `e6-gate-removal` §1f §2a §2b · `lifecycle.test.js` T5-M3 ×2 · `attack-client-lifecycle` §D |
| **M-N3** — presenter dropped from the bytes | T5-M4(a), **this pass** | `e6-gate-removal` §3d · `auth.test.js` §6b ×2 |
| **M-N4** — a spent proof accepted again | T5-M4(b) | `e6-gate-removal` §3e · `lifecycle.test.js` T5-M4 ×2 · `attack-client-lifecycle` §D |
| **M-CAP** — `MAX_LIVE_MEMBERS = 99` | the sybil bound | `e6-gate-removal` §1g |
| **M-DEMOTE** — `proves`/`provesNot` dropped | the demotion | `e6-gate-removal` §2a-ii · `lifecycle.test.js` T5-M3 ×2 · `attack-client-lifecycle` §D |
| **M-PROVES-WORD** — the strong string says "people" | the demotion's *wording* | `lifecycle.test.js` "the gate says on the wire what it checked" + 3 more |
| **M1** — `slot = LS_PARKED` (device-wide again) | the per-space slot | `e6-gate-slots` §2a §2b §2c §2d §2f §2g **and §2e, the honest-path control** |
| **M2 (= N-8)** — `saveRecords → writeJSON` | R8-5 in the shipped port | `e6-gate-slots` §2b §2c **§2h** |
| **M3** — no legacy read | the upgrade path | `e6-gate-slots` §2g |
| **M4 (= N-7)** — `foreignParkNote → ''` | the honest stall sentence | `e6-gate-slots` §2c |

**The two over-closing controls — the routes deliberately NOT taken.** These are the evidence,
because in each case what dies is something legitimate:

| control | what it would close | the honest rows that die — which is why it was refused |
|---|---|---|
| **N-1** — only the founder may mint an invite | the sybil (T5-M2) | **15 rows.** `e6-attack-removed` §0e §0f — a removed member returning under a fresh pseudonym, which ADR 002 §8.4 states *as designed*; `attack-client-lifecycle` §D ×2; and, decisively, `e6-gate-privat` §1b §1c §1d — **the redaction-boundary rows themselves stop being drivable.** It is also the wrong shape: a founder-signed invite makes the *founder* the admin, which `transferAdmin` exists to stop being true. |
| **N-6** — count the shelf against the cap | the unbounded shelf | tier-1 `§4 · the cap, and what happens AT the cap` and `"space made by a release is space the lot will use again"`; `round8-park` §6.5; and `e6-gate-slots` §2a, the row that states the residual honestly. The cap's contract is "the caller MUST NOT advance the cursor", so charging the shelf to it stalls a space for rows that are already dealt with. |

### 14d. One defect this pass found, and it was found by the harness rather than by a test

`tests/tier1/sync-personal.test.js` — *"THE RELAY IS BLIND — the note text is nowhere in the bytes
it stored (21.1)"* — went red roughly **once in two hundred runs**, and it took a mutation run to
notice, because a flake in a green suite reads as noise.

It is not a leak. The row scanned ciphertext for the entity id `'n0'`, and an *n*-character needle
appears by chance in *B* bytes of good ciphertext with probability ≈ `B / 256ⁿ` — for two
characters over the ~300 bytes this row scans, **≈ 0.5% per run** (measured, not estimated).

The reason it is worth a register entry is the second half: a needle that short was also **the
weakest possible evidence in the direction it was pointing**. It would have appeared in random
noise anyway, so it could never have distinguished a leak from luck — a row that cannot fail for
the right reason is not a control. Both needles are now long enough (11 and 8 characters, false
positive ≈ 1e-23 and 1e-17) that a hit is a leak and never a coincidence, and the row gained a
non-vacuity assertion that the needles really were on the Mac. 20 consecutive green runs.

### 14e. Owed after round 3

1. **The co-signature UI** — `adminpanel.js` / `leavedelete.js`. **A shipping prerequisite now**,
   not an owed screen (item 1 of the ship answer).
2. **T5-M2 — the PO/D7 ruling.** An admin-signed invite on the transfer-certificate chain
   (E2-L1b), or the co-signature in the op log (ADR 001 §4).
3. **ADR 002 §8.5a's "I cannot open epoch e" report path** — `handlers/keys.js` + the wire. This
   is the blocking item for `e6-gate-keys` §2a, *not* a rate limit.
4. **The `§1c` residual** — a prune/compaction route, or a `rotateTo` that sends only the missing
   rows. `src/js/sync/keys.js`.
5. **The unbounded shelf** — `src/js/sync/outbox.js`. The bound belongs on the shelf, not on the
   cap: N-6 is measured above as over-closing.
6. **`sync/keys.js` should treat `429 rate_limited` on `POST /spaces/:id/epoch` as a
   retry-after-`Retry-After`**, not a failure — the relay now emits it.
7. **`storage.js`** — the "three named slots" obligation is now **four** by name.
8. **`store.js` / `sealedEnvelopeStore`** — `writeJSON` still swallows for `LS_SEALED`. Worth the
   same R8-5 question the parked slot just answered.

---

## 15. E9 — collaboration and conflicts. What INTEGRATING it found.

Integration pass, 2026-09-02. Full record: `docs/v2/E9-VERIFICATION.md`. Five modules arrived from
four parallel build workflows; the epic could not be demonstrated until three seams were built,
and the seams are where the findings are.

### 15a. E9-I1 — **LZP-902 shipped a grant nobody could exercise.** FIXED.

„Familie darf bearbeiten" was written, folded, rendered and enforced, and **no co-editor's write
could be authored on any Mac.** `store.familyLevelOf` answers `null` for a foreign key — correctly,
it reads the entity's own `visibility` truth register and a viewer holds no truth for a peer's
entry — and ADR 004 §2.2 barrier 4 turns that `null` into a `RedactionError`, which sets
`store.redactionHalt` and stops **all** family sync from that Mac. `interact.js` was therefore
right to refuse the gesture (`authorable`), and 18.2 rendered a checkbox that granted nothing.

Three of the four build workflows closed with this item owed, each seeing one face of it.

**Fix:** `store.familyCoEditLevelOf(entityKey)` — a *separate* reader, not a loosening of
`familyLevelOf`. The distinction is the whole of it: `familyLevelOf`'s argument against reading
`pub.level` is *"the level a transition is moving away from"*, and that is an argument about a
**transition**, which only an owner has. A co-editor moves no level. So the new reader consults
exactly the registers `authz.js` stage 3b consults — `pub.level === 'geteilt'`,
`pub.coEdit === true`, `pub.alive !== false` — all folded, authenticated, and written by the owner
alone under stage 3a. It answers `null` for my own key, which is what stops it becoming the S5
second producer. Domain-tested over 72 cells with the oracle written from ADR 001 §4.3's prose;
mutants M1–M3, M5.

### 15b. E9-I2 — the retraction/co-edit split, and the way 18.3 would have broken silently. FIXED.

An admin unshare (18.3) is **also** a `pub.set` on a foreign key. Had the new co-edit reader been
wired into barrier 4 unconditionally, it would have answered `'geteilt'` for a moderation — and
barrier 4 would then have refused the op **for declaring `privat` against a map that says
`geteilt`**. Not a bypassed check: a hard refusal, and 18.3 stops working.

**Fix:** `sync/family.js:sealLevelFor(entityKey, op)` — barrier 4's level is now a function of the
**op**, split on `authz.js:classifyUnsharePatch`, the same predicate stage 3a admits an unshare by,
so the seal seam and the fold that judges its result cannot drift. Fails safe both ways: a
misclassified retraction is refused by barrier 4, a misclassified co-edit by the retraction clause.
Neither error seals a byte and neither can raise a level.

### 15c. E9-I3 — three modules that shipped with no caller. FIXED.

| module | consequence |
|---|---|
| `family/conflict.js` (LZP-904) | 18.5 shipped as a module nothing called |
| `core/project.js:adminUnshareFollowUp` (LZP-903) | 18.3's "it reverts" true only until the owner's next keystroke — measured |
| `store.applyCoEdit` (did not exist) | the wedge, and 18.2 unexercisable |

**`conflict.js`'s absence was measured by the suite, not spotted by a reader.**
`sync-domains.test.js` S5b went red the moment `family/mount.js` imported it — an unmounted module
is correctly invisible to the import-graph walk, so a module with no caller is not a shipped one.
`family/unshare.js` is still invisible for the same reason (§15f item 2), and S5b is what will
notice when it lands. S5 68 → 69.

### 15d. E9-I4 — **a co-editor cannot ⌘Z their own co-edit.** OPEN, and deliberately not closed.

Measured, not assumed: the row was written expecting an undo entry and went red.
`core/undo.js:captureImages` filters every entity kind outside `UNDOABLE_KINDS`
(note/bar/cat/pad) — rule U6, v1's `CONTENT_KEYS` snapshot in op terms — so a family `pub.set` is
never on anybody's undo stack.

For **my own** entry that is right, and the ADR says why: the publication is *derived*, so undoing
the truth and letting the publisher re-derive is the only path that cannot leave the family space
describing a state the owner's board no longer holds. **For a co-edit there is no truth to undo.**

Not closed by widening `UNDOABLE_KINDS`, because an undo that minted a `pub.set` would re-write the
pre-value **at a fresh stamp**, beating the owner's concurrent newer write and silently
resurrecting a value they had already replaced — the §5.1 failure arriving through the undo stack.
Failing closed costs a keystroke; failing open costs somebody else's edit. **Owner: `core/undo.js`
+ a PO call on whether 18.2 implies undoability at all.**

### 15e. E9-I5 — **attack rows C2/C2b/C3 change priority because of this pass.** OPEN, WP-9.

The co-editor × undo trio in `tests/attack/ownership-authz-undo.test.js` — *"my ⌘Z silently
discards a co-editor's newer write to the same field"*: the owner's undo restores their own truth
value at a fresh stamp, which then beats the co-editor's newer `pub.text` through promotion
(ADR 004 §4.1).

**Until this pass no co-editor write could be authored at all**, so the trio was reachable only by
a hand-built op — which is why it sat in WP-9 with the forged-genesis rows. It is now reachable
**through the product's own UI**, by two people using 18.2 exactly as designed. The rows are
unchanged and still green (they pin the defect, not the fix); what changed is that this stopped
being hypothetical. **Recommend promoting C2 out of WP-9 into the next work package.**

### 15f. Owed after E9

1. **The co-editor's ⌘Z** — §15d. `core/undo.js` + a PO call.
2. **An admin-unshare button. — CLOSED 2026-09-03, with a caveat.** It read: *"`family/unshare.js`
   is complete and tested and **no UI calls it**."* It has a caller:
   `familysettings.js#buildModerationSection` („Einträge im Familienkreis"), 26 rows in
   `tests/tier2/unshare-ui.dom.js`, and `tests/property/sync-domains.test.js` S5b measured the
   module moving from absent to present (69 → 70 reachable). `createjoin.js:320` emits the genesis
   `claimAdmin`, so `NO_ADMIN_CHAIN` no longer fires on a circle this build creates.
   **The caveat:** driving the button end to end in the shipped shell — the admin moderating a
   foreign entry that actually crossed — is blocked intermittently by **F-SHELL-1** (§19b), which
   is an attestation-admission defect and not this button's.
   `docs/v2/SHELL-VERIFICATION.md` §9, §10.
3. **`REJECT_REASONS.NOT_MEMBER` is not in `store.js:CURABLE_REFUSALS`**, so such an op is dropped
   rather than parked. Pre-existing for stage 3b; §4.2b widens the surface to the owner. Bounded in
   practice (member records carry strictly lower `seq` than any content op referencing them, so the
   outcome is "entity absent", never "entity corrupt"), and a genuine trade: `applyRemote`'s own
   comment argues parking a stranger's write forever is worse. **PO / store owner's call.**
4. **`A3b` / `A3c`** — one line closes them. §4.2b gates `pub.set` (stage 3a) because that is
   18.1's surface; `member.set{_alive:false}` (20.2, stage 2) still asks
   `adminAtKey(spaceKey(op.space))` with no check that the **subject** is a member of that space.
   Mirror fix: `membersIn(op.space).has(subject)`. WP-9 — it interacts with join/leave/rotation.
5. **`DESIGN-DECISIONS.md` D7 is stale in one number, and it is the PO's file.** The
   `⚠ OPEN FOR THE PO` block says the `ownership-authz-*` files carry *"twelve `SUCCEEDED` rows"*.
   The **admin** file now carries **10** (A3 and A4b closed at E9 §4.2b); across all three files
   there are **20**. Two of the three examples the block quotes are unchanged; what moved is the
   count, and the fact that the per-space membership gate has since closed two of them. **The PO's
   wording question is materially smaller than it was.** Not edited here — it is a decision file.

### 15g. E8-3 is answerable, and LZP-808 answers it

FINDINGS §12b's E8-3 — *"the deliverable-17 sentence is true at 22 px and false at 18 px"* — is
now **scoped to the density presets**, both ends measured. Komfort's `minRowHeight: 26` is the
smallest row on which the five badges and two entries coexist with 16.7 % more type, and
**capacity is 2 at both presets**, so Komfort buys type without costing an entry. `LINE_H = 10.5`
is a fact about **9 px type**, not about the app: a naive Komfort — bigger type over the shipped
capacity rule — would promise two lines to a 22 px row that can draw one and would make the
crowded board **worse**. The floor is what forbids that, and it is enforced in `buildBoard` rather
than only in the settings pane, so it holds for a `board.json` that arrived by import or by hand.
**E8-3 can be closed as "scoped to the density presets, both ends measured".**

---

## 16. E10 — privacy, migration and hardening (2026-09-03)

**Updated 2026-09-03 by the E10 integration pass.** Four defects closed by LZP-1003 (recorded in
§16a), five residuals priced, **one ticket never built**, and one new open finding. The pass added
39 rows in two files (`tests/attack/e10-network-scope.test.js`, `tests/attack/e10-outbound-payload.test.js`)
and one helper (`tests/helpers/native-scope.js`); ten mutants on a scratch copy, each killing a
named row, control 99/99 green before and after. Full record: `docs/v2/E10-VERIFICATION.md`.

### 16a. Closed by LZP-1003 (crypto self-audit) — mutants in that ticket's report

| id | severity | what | mutant |
|---|---|---|---|
| **E10-B1** | HIGH | an empty key ring restored as `identity-restored` — „Dein Board ist zurück und deine Schlüssel auch" over a space whose every op parks for ever. `KeyRing.missing()` answered `[1..upTo]` for the same ring; two modules gave opposite answers and the restore is the one the user reads first | M1 kills 3 INVERTED rows |
| **E10-P1** | HIGH | the pairing delivery leg broke rule 3 (engine `DataError` escaping as a caller-visible error) and left the two Macs disagreeing about whether pairing was over — sender terminal `delivered`, receiver live in `confirmed` | M3 / M5 / M6 |
| **E10-P2** | HIGH | the same rule-3 breach on the ECDH leg; a 65-byte off-curve `aEph` inside a well-sealed offer reached `DataError` one call later, session still live | M4 |
| **E10-B2** | MEDIUM | `bundle.epoch` was an unbounded loop on the restore path — `epoch: 2_000_000` built and froze a two-million-element array. The identical sentence that justifies clamping `kdf.iterations` | M2 |

### 16b. New, open

**E10-1 · story 17.5's „neu" dot never lights.** `core/materialize.js:isNewOf` implements ADR 004
§7.2 exactly and tier 1 proves it against injected hooks. `store.js:_project` supplies none of
`seqOf` / `isNew` / `lastSeenSeq` / `levelDecreased`. Both halves exist — the pref
`settings.lastSeenSeq.<spaceId>` is reserved and preserved across imports, `store.noteCursor`
moves a cursor — and they are not joined. **Owner: `store.js`, a parallel workflow's.** The fleet
row is green while the defect exists and says: *if it goes red the story was probably wired —
invert it, do not repair it.*

**E10-2 · LZP-1009 (the feedback button) is OWED, and its absence is now load-bearing.**
~~The PO's new ticket did not land~~ — **CLOSED 2026-09-03 by LZP-1009. See §18 below**, which
records what landed, the two of the eight rows that *did not go red on their own*, and the one
line that is still owed. The original text follows because the shape of the prediction is worth
keeping beside what actually happened:

> The PO's new ticket did not land: no module, no bridge command, no relay route, no copy, no
> processor named. Tasks 4 and 5 of the E10 integration were attacks on its payload and had no
> subject. Recorded as **eight rows that go red the day it lands** rather than as a sentence —
> §2a–§2e and §1a/§1d of `e10-network-scope.test.js`, plus §3a/§3b for the screenshot half.
> **When 1009 is built it is a third network job and a second remote host**, so it needs those
> rows inverted *and* a Datenschutz sentence naming a third processor (LZP-1001, also owed).

**Two of those predictions were wrong, and the errors are instructive.** 1009 is **not** a third
network job and **not** a second remote host: it is a POST to the sync relay's own origin, over
the transport that already exists, so §1a, §1d, §1g, §2b and §2e are all still green *for the
right reasons* and 21.5's exception count is unchanged at two. What it does add is one PATH on the
one origin, which §2c and §2d now bound. The Datenschutz sentence (LZP-1001) is still owed, and
what it owes is smaller than predicted: not a third processor, one more thing the existing one
receives.

**E10-3 · "solo mode makes zero network requests" is false as literally written, and the copy has
not caught up.** The *board* makes zero, measured six ways. The *shell* makes one — the update
manifest — at most once a day, only with `disclosed && enabled`. `updater.js`'s header resolves
21.5 ↔ 22.3 this way deliberately and says the Datenschutz text must name the release host as a
second remote; nothing has written that sentence. Amendment A1's permission to quote v1's "zero
network by architecture" for solo mode is therefore **not clean**: the update check happens in solo
mode too. **Owner: LZP-1001 / the PO.** Measured: the whole product names exactly **one**
hard-coded remote URL (`e10-network-scope.test.js` §1g), and it is still `OWNER-PLACEHOLDER`.

**E10-4 · the tier-2 isolation guard fired once against the user's real board.**
`tests/run-dom-tests.sh` reported `ISOLATION VIOLATED: ~/Library/Application Support/LangzeitPlaner
changed during the test run`, with `board.json` and `snapshots.json` both moving. It did not
reproduce on two later runs and the most likely cause is a concurrent workflow. **Filed rather than
dismissed:** a tier-2 run that can touch the user's real board is release-blocking, and "did not
reproduce" is not "cannot happen".

**E10-5 · the solo module-graph measurement SKIPs in the engine we ship.**
`network-audit.dom.js` §1's "no family module was ever fetched" rests on the Resource Timing API,
and WKWebView records no entries for the `app:` scheme. The row honestly skips. The claim stands on
E5-VERIFICATION §4's Chrome run (38 resources, none under `crypto/`, `sync/`, `family/`,
`platform/net.js`) plus the static import-graph walk in `network-scope.test.js` gate 2. Not a
defect; a limit on where the evidence comes from, recorded so nobody quotes the row as a WKWebView
measurement.

### 16c. Priced, not closed — LZP-1003's residuals

- **R1** a stolen backup yields the whole board in the clear, with no passphrase. `board` is
  plaintext JSON on *both* export paths; D8 covers the identity block and never claimed otherwise.
  The gap is in the copy: „Wer diese Datei und dein Passwort hat, ist du" reads as though both are
  needed, and „Auch die Einträge sind versiegelt" does integrity's work in a sentence a
  non-technical reader hears as confidentiality's. **The row asserts no string says the entries are
  readable without the password; it is the assertion to invert when one is added.**
- **R2** the backup file + passphrase is an unbounded, undetectable member-cloning primitive.
  §8.5's only stated mitigation — the per-member device count — renders as nothing, because
  `family/mount.js#refreshRoster` maps the roster down to `memberId`/`colorRef`/`removedAt`.
- **R3** epoch poisoning is locally correct and **unreportable**: a wrap addressed to a sibling Mac
  and 156 bytes of malice are both `refused: 1`. Needs ADR 002 §8.5a's report path.
- **R4** the 5-attempt pairing cap is a typist's budget, not an attacker's — four fresh sessions
  absorb 20 wrong codes.
- **R5** amendment A2 is enforced on two collections out of five (`notes`, `bars`); `categories`,
  `scratchpads` and `settings` are copied wholesale. Safe only while the family space carries no
  `cat:`/`pad:` registers.

### 16d. Corrections to earlier entries in this register

- **B-14 / F-9 are closed and STATUS §629 is stale.** That row says ADR 003 §7 gate 1 and ADR 005
  §5 rule 4 "do not exist: no `platform/net.js`, no `tests/tier1/network-scope.test.js`". Both
  exist, both are committed, and both are green. What was genuinely missing is a *different* gap
  and it is closed by this pass: **neither gate could see the native side**, and a bridge `invoke`
  is not a `fetch`.
- **The `e8-density-*` red count is a moving target, and it is now 3.** The brief carried 17.
  Three `test:dom` runs over this pass measured **9, 9 and 3** as the parallel density workflow
  landed fixes underneath. The three that remain are `e8-density-legibility` (1) and
  `e8-density-perf` (2), both in files that workflow owns. A single snapshot of this number is
  not a fact about the product; the sequence is.

### 16e. Owed after E10

1. **`server/prisma/migrations/` does not exist** — the first deploy creates no tables and
   `check-server-config.mjs` passes anyway. Release-blocking (LZP-1008).
2. **LZP-1001** — the Datenschutz section, now with E10-3's second remote in it.
3. **LZP-1006** — the Mom test itself. Blocked on a person, and on E-1/E-2/E-3 being fixed first.
4. **LZP-106's unlock screen** — `gatekeeper_status` is unimplemented in both shells, and
   `Bitte zuerst lesen.html` is not on the disk image, so **step 3 of the e-mail is the only
   surface that reaches a stranger before macOS refuses the app**.
5. **The three e-mail/parser defects** measured by `scripts/mom-test-probe.mjs`: „Mail-Anbieter"
   parses as a valid invitation code and wins; the e-mail carries no relay address and the parser
   takes the download host; trailing punctuation becomes part of the hostname.
6. **E10-1, E10-2, E10-4** above.

---

## 17. THE DENSITY/CO-EDITOR INTEGRATION PASS (2026-09-03)

Four parallel fixers — `fix:convergence` (the E9 co-editor red team), `fix:legibility`
(`app.css` + `board.js`), `fix:fairness` (`layout.js`) and `fix:legend` (`legend.js`) — landed
against one tree. This pass applied the cross-file work neither of them could reach, resolved the
one genuine collision between two of them, and re-measured everything.

**`test:dom` went 714 pass / 17 fail → 836 pass / 3 fail.** The three that remain are named in
§17e with the story each fails. Five suites are green: `npm test` **2121/2121** · `test:property`
**101/101** · `test:attack` **960/960** · `test:server` **903/903** · `test:fleet` **397/397**.

### 17a. THE V1 ORACLE DID NOT MOVE — verified per file, not per total

The headline number changed (2 105 → 2 121) and that is *not* evidence either way, so the check
was done file by file against a pristine `git archive 28f2a35` tree, which is the E9-close state
the brief quotes:

```
41 tier-1 files · 40 report a byte-identical row count and pass
 1 differs: tests/tier1/headless-shell.test.js   2 → 18
```

All sixteen new rows are the shell workflow's LZP-1002 rows (`sync_request` as a pinned-origin
bridge command). **Not one v1 characterization row changed, and the three deletions in the whole
tier-1 diff are an import line and two test doubles gaining a now-required `url` field** — a
strengthening, in the parallel net workflow's own files. `core-authz.test.js` gained one
`collect(…)` and no row, obliged by E9-A §1i's new `notAlive` enum member.

### 17b. THE ONE REAL COLLISION: `orderForCapacity` against deliverable 17

`fix:fairness` closed 17.2 („my board stays mine") by putting a stable ownership prefix in front
of v1's array order in the capacity slice. It was right to: store order was costing the owner up
to **93.5 % of their own notes** on a shared day, and *which* 93.5 % moved with nothing but
creation order.

Three E8 files then went red, and they were not wrong either — they were asserting the pre-fix
contract, each with a fixture **composed by array index** so that a peer's marks landed in the
slice:

| file | row | what it assumed |
|---|---|---|
| `family-render.dom.js` §3 | `22 px: store order decides, not ownership` | said so in as many words |
| `family-density.dom.js` §1/§2 | `16.7/belegt-block`, `17.2/initial-chip`, `17.5/neu-dot` | SCENE put Papa's block at index 0 |
| `family-legend.dom.js` ×2 | `the foreign worst case lost its .neu-dot` | „THE FOREIGN WORST CASE IS FIRST" |

**All four are inverted to the new contract, and none is inverted quietly.** Each file now also
carries the *cost* of the rule as its own row, because a fixture that avoids a cost reports a
conditional guarantee as an unconditional one:

- `family-density.dom.js` **§1b** — with two notes of mine on the day, both lines are mine, no peer
  mark reaches the note line, and the family is a digit in the „+n" that counts every one of them.
- `family-density.dom.js` §2 — at capacity 1 the one line is mine (`17.2/the-one-line-at-capacity-1-is-mine`),
  and a **peers-only** variant asks the same geometric question of the survivor that can now only
  be a peer.
- `family-legend.dom.js` — `CROWD()` takes a `{ mine }` parameter instead of relying on an index;
  the mixed day proves both halves of the badge family coexist at 22 px, the peers-only day proves
  the heaviest family prefix survives at **both** densities.
- `family-render.dom.js` §3 — plus a counterweight, because `[false, false]` is also what a board
  that simply *dropped* every peer would print: with none of mine on the day the slice draws
  theirs, the change leads, and the third is counted.

**The product consequence, stated:** on a day the owner has written on, at capacity 1 the family
reaches the note line only as a digit; at capacity 2, only if the owner has at most one entry
there. The ownership channel is not gone from those rows — it is in the lanes, which
`family-render.dom.js` §2 measures costing 0 px. This is the trade 17.2 asks for and
`e8-density-crowding.dom.js` §B2 prices the alternative at 54.1 % of the owner's own notes.

### 17c. A REGRESSION THIS ROUND INTRODUCED, ON THE PRINT PATH — closed

`app.css`'s `.day.claimed .d-more` promotes the „+n" badge from an overlay to a flex sibling on
rows where a bar label has retreated into the lane gutter. On screen that is a good trade priced
against a 61 px line. **On A4 it took 20 px of a 39.5 px line — half the sentence, on the one
surface with no hover to recover it** — and it bought nothing, because
`body.paper-a4 .bar-label` (0,2,1) out-specifies `.bar-label.on-ink` (0,2,0), so the retreat it was
paying for never happens on paper. There was no chip in the gutter to make room for.

`print.css` now keeps the badge an overlay, parked by `app.css`'s own
`right: calc(var(--gutter) - 2px - var(--more-w))` — 5 px on A4, inside the gutter and clear of the
text column. Measured in real WebKit under the lifted print rules:

```
                       before → after
.d-body                 19.5 → 39.5 px
the note's text column  21.5 → 41.5 px
a peer's text column     6.5 → 26.5 px
„Elternsprechtag Klasse 3b", mine     5 → 9 characters
„Chorprobe Kinder", a peer's          1 → 5 characters
```

This is better than the state this round created **and** better than what v1 printed, where the
badge sat at `--gutter + 1px` and covered the sentence outright. `§E2` went 8/9 → **11/11**: the
`A8/a-peer-entry-is-legible-on-A4` row it closes is joined by two counterweights, so the fix
cannot be re-spent by widening the column instead of moving the badge.

**RESIDUAL, NAMED:** 3.7's „the label retreats into the gutter" is therefore a **screen-only**
guarantee. A 24 px A4 gutter cannot hold a 17 px badge and a label chip side by side, so on paper a
bar label that lands on an inked row still overprints the note under it — v1's own trade on the
print path, unchanged by this round and not made worse by it.

### 17d. 17.5 WAS CLOSED IN THE MODEL AND OPEN ON THE GLASS — closed

`fix:fairness` shipped `layout.js:day.overflowNew`, the count of peer changes a row could not draw,
and **nothing read it**. Both that workflow and `fix:legend` listed the painting half as owed. It
is a `board.js` + `app.css` change, so no single-file owner could make it.

`board.js` sets `.d-more.has-new` from `overflowNew` and puts the count in the hover in both
languages („2 weitere · 1 neu" / „2 more · 1 new"). `app.css` paints it as a **2 px accent rule
along the badge's bottom edge, as a background** — not the 5 px lime plate used elsewhere, because
the badge is a fixed 17 px box that „+99" fills and a corner dot would land on the second digit,
which is the exact defect this round spent itself closing. As a background it adds no child node to
the row's collision audit, changes no geometry (measured: 17 px either way), and costs
`PREFIX_COST_PX` nothing.

Two rows, deliberately a pair — the first alone is satisfied by marking every badge, which signals
nothing: `17.5/the-badge-says-it-is-holding-a-change` and `17.5/and-stays-quiet-when-it-is-not`.
On the fixture: 25 badges carry the tell, **0** that should do not, **0 of 329** quiet badges carry
it. Principle 9 is untouched — `overflowNew` counts `foreign && isNew`, and `materialize.js:isNewOf`
is already blind to a downgrade and has nothing to count for a deletion, so
`family-legend.dom.js`'s tripwire row holds unchanged.

### 17e. WHAT IS STILL RED, AND WHY — three rows

**1. `e8-density-perf.dom.js` §E1 — `LZP-1007`. The honest number is 60.9 ms, and the row's own
threshold is 16.7.**

Measured in isolation (the full 46-file run reports ~75–107 ms for the same code; that is machine
contention, not the product, and a single suite-run reading of this row should not be quoted):

```
operation      solo    family   ×     frames of 16.7 ms
buildBoard      0.7       3.0  4.3    0.2
renderBoard    19.5      60.9  3.1    3.6   ← the floor
memberToggle   18.2      62.6  3.4    3.7
scroll          0.7       3.1  4.4    0.2
findKeystroke   1.8       9.9  5.5    0.6
findWorst       4.9      23.7  4.8    1.4
DOM nodes: solo 1975 · family 4195
```

E8 measured `renderBoard` at 51 ms and `buildBoard` at 3 ms. **It did not regress**: 51 ms was the
median of the scripting alone (`family-render.dom.js` still reports 56 ms); §E1 forces a style and
layout flush after every call, which is the honest unit for a frame. Decomposed on the 8-member
fixture:

```
buildBoard (the model)                 3.0 ms
DOM construction (4 195 nodes)       ~23   ms
style resolution + layout            ~34   ms   (measured by clone-swapping the finished subtree)
```

**No CSS lever moves it.** Measured, each as a full re-run: `.d-num`/`.d-wd` back to fixed widths
58.3, `text-overflow: clip` 60.9, pads hidden 58.8, `contain: layout style` on `.day` **74.3**
(worse), on `.col` 67.8, on `.rows` 65.3, `.bar-label` max-width removed 64.1 — against a baseline
that reads 59.3–65.5 on repeat. All inside the noise. `content-visibility` is not available: 11 of
12 columns are on screen at the harness's 1291 px viewport, and off-screen content reports no boxes,
which would falsify a large number of tier-2 geometry rows.

**The conclusion is architectural and should be read as a finding, not a shrug: a full twelve-month
rebuild of 4 195 boxes cannot fit in one 60 fps frame in WebKit.** Closing §E1 means not rebuilding
the whole board — an incremental renderer keyed on what changed. `renderBoard` is `textContent = ''`
plus a fresh tree today, and it is called by every settings change, every data change, and the
member toggle 17.3 puts one click away.

**One cell was genuinely improved.** `find.js` ran a full-document
`querySelectorAll('.board .bar[data-bar-id="…"]')` **inside the hit loop** — O(hits × nodes),
paid on every keystroke, and a one-letter query is exactly what the first keystroke of every
search is. Indexing the stripes once took `findWorst` **25.4 → 20.1 ms** and `findKeystroke`
**10.9 → 8.9 ms** (both re-measured at 23.7/9.9 on a later run; the run-to-run spread is ±3 ms).
It is behaviour-preserving, so no row dies without it — `repeats-find-i18n` 121/121,
`interaction.dom.js` 32/32 and `family-attribution.dom.js` 25/25 are what hold it, and its only
claim is a number §E1 prints and is still red on.

**2. `e8-density-legibility.dom.js` §A4 — the 9 px ink contrast floor. Two distinct causes, and
one of them is a PO decision this pass deliberately did not take.**

- `v1/palette-holds-its-own-floor` — five of v1's ten tones miss `palette.js`'s **own** stated
  „≥ 4.5:1 against #FFFFFF" on plain white, before any ambient shade: blau 4.43, tuerkis 4.08,
  gold 3.64, gruen 3.28, orange 2.94. **Closing it means changing `palette.js`'s hex values, and
  `tests/tier1/palette.test.js:38` pins `colorOf('blau') === '#2A7CC0'`.** The v1 characterization
  suite is the oracle and may not be weakened to make a v2 row pass, so this was left red rather
  than closed. `fix:legibility` computed a landable set (blau `#2368A0`, gruen `#426F24`, orange
  `#90560A`, tuerkis `#0B7070`, gold `#7D5F13`, magenta `#BE196B`, rot `#B93228`, schiefer
  `#566675`) which reads 4.53–10.99 on all six binding backgrounds — **and it must be weighed
  against story 4.5 before landing**: eight tones converge on ~5.9:1 against white, which compresses
  the value channel the 6 px ownership rail relies on. This needs a PO ruling and an oracle
  amendment, in that order.
- `E8/new-inks-hold-the-same-floor` — `layout.js:UNKNOWN_MEMBER_COLOR` at 3.71 and the „Belegt"
  word in `--ink-3` at 3.71 (3.09 on its own pill). These are **E8's own inks failing E8's own
  floor**, and unlike the half above they do not touch the oracle: `--ink-3` is pinned as the v1
  `.d-num` ink by `dom-rendering.dom.js:1158`, so the word needs a token of its own (`#685E8B`
  holds 4.54–5.90 on all six) and `belegt-render.dom.js:379` inverts with it. **Landable, not
  landed** — it does not change §A4's colour, and this pass chose not to open a palette change it
  could not finish in the same breath as the v1 half.

**3. `e8-density-perf.dom.js` §E3 — `A8/most-of-the-family-reaches-the-paper`. Arithmetically
unreachable, and left at its original strictness.**

365 day rows × capacity 2 = **730** drawable occurrences against **1 527** in the window: **48 % is
the ceiling for any ordering**, and the model draws 715 of the 730 available. At the clamp's own
maximum (capacity 3, DESIGN-DECISIONS §B) it is 72 %, still under the 75 % the cell asks for.
Every member still has ink on the poster (17 %–79 %; mine 100 %), which is what 17.1 asks for.
**This needs a spec decision about what a saturated poster does** — DESIGN-DECISIONS §B forbids the
only lever an engineer has — and the threshold was deliberately not re-cut to a number the product
happens to hit.

### 17f. The mutation table for this pass

Every fix reverted in a scratch copy of the tree, `shasum`-verified restored between runs.

| mutant | victim |
|---|---|
| **M-P1** `print.css`'s `.day.claimed .d-more` override deleted | `A8/a-peer-entry-is-legible-on-A4` **and** `A8/the-printed-badge-takes-no-width-from-the-sentence` — and only those |
| **M-O1** `orderForCapacity` → `[...rows]` (v1 array order) | `17.2/both-lines-are-mine`, `17.2/and-no-peer-mark-is-on-the-note-line`, `17.2/the-one-line-at-capacity-1-is-mine`, `17.5+17.2/still-drawn`, `17.2/the-floor-line-is-mine` ×2, `family-render` §3 — i.e. every row §17b inverted |
| **M-O2** `changedFirst` → `() => 0` | `family-render` §3's `17.5 — the peer CHANGE leads` alone. *(The peers-only cells in `family-density`/`family-legend` survive it, because in those fixtures the change is also first in array order — they are not load-bearing for 17.5's tier, and are not claimed to be.)* |
| **M-N1** drop `more.classList.add('has-new')` | `17.5/the-badge-says-it-is-holding-a-change` alone — 25 badges |
| **M-N2** add `has-new` to every badge | `17.5/and-stays-quiet-when-it-is-not` alone — 329 of 329 |

Honest-path controls, unmutated: `family-density` 10/10 · `family-legend` 13/13 ·
`family-render` 18/18 · `e8-density-crowding` 7/7 · `e8-density-chrome` 5/5 ·
`e8-density-truncation` 3/3 · `dom-rendering` 44/44 · `board-render` 19/19 ·
`belegt-render` 20/20 · `density-808` 8/8.

### 17g. The E9 co-editor red team, re-run in full

**33 rows, all green** (29 at the brief's writing; `fix:convergence` added four). Census:

- **CLOSED and inverted — 8:** §1i, §2a, §2b, §2c, §2e, §2h, §3b-b, §4c
- **Still open, and honestly labelled — 3:** §2f (18.5 cannot report a withdrawal at all — the
  refusal only ever sees a *later* write, and a withdrawal leaves the older one standing),
  §2g (a retroactively-refused *arrival* is dropped rather than parked, so a re-grant reaches only
  the Mac that held the line), §4c-b (two drags each ordered where they were made still converge to
  an inverted bar — the projection invariant is owed to `core/materialize.js`)
- **FAILED, i.e. working defences — 17:** §1b–§1h, §3b, §3c, §3d, §3e, §3g, §3h, §3i, §4a, §4b, §4d
- **Non-vacuity controls — 5:** §1a, §2d, §3a, §3f, §4c-c

**Not one defence regressed.**

### 17h. The standing bar — the redaction boundary, round five

This is the round where it was most exposed: finding 1's §2c put a `geteiltOnly` value into
`registers()` and onto disk. **114 rows, all green** — `e7-leak-{routes,downgrade,observer}` 91/91,
`e6-attack-privat` + `e6-gate-privat` 23/23, plus E9-D §4d („the standing bar: not one byte of a
Privat entry, after all of the above") and E9-B §2c („no `geteiltOnly` register stands at Belegt").
**Zero bytes of a Privat entry, for the fifth consecutive round.**

### 17i. Owed after this pass

1. **`core/materialize.js`** — the bar-interval projection invariant (E9-A §4c-b). Owed since
   `fix:convergence`; turns that row red, and it inverts then.
2. **`core/ops.js`** — `PARK_REASONS.WITHDRAWN`, so `applyRemote` can park a retroactively-refused
   arrival instead of dropping it (§2g). `oplog.js:park()` validates against `isParkReason`, so the
   constant lands there first.
3. **`core/registers.js` / `family/conflict.js`** — 18.5 still cannot report a withdrawal (§2f).
4. **`palette.js`** — §A4's v1 half. **PO ruling first**, then an oracle amendment; see §17e.
5. **`layout.js` + a new `--ink-belegt` token** — §A4's E8 half. Landable today; costs one inversion
   in `belegt-render.dom.js:379`.
6. **An incremental `renderBoard`** — the only thing that closes §E1. See §17e.
7. **A spec decision on the saturated poster** — §E3. Not an engineering ticket.
8. **`adr/001-op-log.md` §5 step 5** still says array order decides the capacity slice. It decides
   it *below* the prefix now; the bullet should name `layout.js:orderForCapacity` the way it
   already names `assignLanes`.

---

## 18. LZP-1009 — „Rückmeldung senden" (2026-09-03)

**Opened by the ticket that built it.** E10 measured this feature's absence in eight places
(§16, E10-2). It has landed; the eight rows are inverted or still green for their own reasons, and
the three rows below are what building it turned up.

### 18a. Defects found and closed by this ticket

| id | severity | what | the row that dies |
|---|---|---|---|
| **E10-1009-C** | MEDIUM | **A redaction box was drawn at the text's INTRINSIC width, not its painted width.** `.bar-label` is `max-width: 66px; overflow: hidden`, and a `Range` reports what the text *would* occupy — 90 px for „Kur in Bad Wörishofen". The box was therefore 24 px wider than the chip and painted solid ink across board the label does not cover, so the picture showed a layout that does not exist. Not a leak (it over-covers), but the opposite of "layout bugs stay visible": it invents one. Closed by clipping each line box to its host when the host's own computed `overflow` is not `visible` — the condition the engine itself uses, so a genuine `overflow: visible` spill is still shown. | `tests/tier2/feedback.dom.js` "a redaction box sits where the bar label was" |
| **E10-1009-D** | LOW | **`Palette` stored index 0 unquantised.** `add()` quantises to 5 bits per channel before looking a colour up, so the paper white stored raw never matched itself and every element painted in the background colour took a second, near-identical slot — spending the 256 indexed entries twice as fast on a tinted board. | `tests/tier1/feedback.test.js` §2g |
| **E10-1009-E** | MEDIUM *(a defect in a TEST, and the most useful one)* | **Searching a PNG's file bytes for a leaked string is not a detector.** IDAT is DEFLATE and DEFLATE Huffman-codes its literals, so a needle sitting plainly in the pixel buffer appears nowhere in the file. The image half of the payload grep was green over an image it could not have inspected. Closed by inflating the IDAT — with `node:zlib` in tier 1, with the engine's own `DecompressionStream` in tier 2 — and searching the raster, plus a fifth needle spelling (UTF-8 bytes read back as latin-1, which is what a byte plane actually holds). | `tests/tier1/feedback.test.js` §5e, `tests/attack/e10-outbound-payload.test.js` §4c |

### 18b. ⚠ E10-1009-B — two of the eight red-on-arrival rows never went red

**Severity: MEDIUM, and it is a finding about the gates rather than about the feature.**

`e10-network-scope.test.js` §2a and §3a were written to redden "the day 1009 lands". The whole
feature shipped and **both stayed green**, neither because its claim still held:

- **§2a** matched `/\bfeedback\b/i` against code with comments and strings blanked. Seven modules
  under `src/js/feedback/` spell themselves `openFeedback`, `setFeedbackPort`, `feedbackPort`,
  `initFeedback` — and `\bfeedback\b` matches **none** of them, because there is no word boundary
  inside `setFeedbackPort`. The import specifier naming the directory is a string, and strings are
  blanked. **Measured: 0 hits over the shipped tree with the whole sender in it.**
- **§3a** looked for `canvas`, `getContext`, `toDataURL`, `toBlob`, `getImageData`,
  `OffscreenCanvas`, `createImageBitmap`, `getDisplayMedia`, `html2canvas`. The delivered renderer
  uses **not one of them** — it is a hand-written indexed-PNG encoder over a `Uint8Array`, which is
  the entire point of it — so the scanner found nothing while the product gained the ability to
  draw.

This is exactly the failure `network-scope.test.js`'s own header names: *"it goes green the day its
regex stops matching anything, and nobody notices, because green is what it looked like when it
worked."* The gates did not rot — they were **never able to see the shape the feature actually
took**. Both are now inverted to claims checkable by CONSTRUCTION rather than by vocabulary: §2a
enumerates the FILES allowed to mention the subsystem (its own directory, plus one seam line in
`settings.js`), and §3c enumerates the CALL SITES of `encodePng` (exactly one). §3d is new and is
the claim the old §3a was reaching for: **there is no glyph path anywhere in the product** — no
`fillText`, `strokeText`, `measureText`, `drawImage`, `FontFace`, `foreignObject` or
`XMLSerializer`, and the raster's whole mutator surface is `fillRect` and `strokeRect`.

### 18c. E10-1009-A — the sender has no binder *(OPEN, LOW)*

`src/js/feedback/port.js` holds `setFeedbackPort(...)` and **nothing calls it**, so `canSend()` is
false on every Mac and „Senden" is disabled. The one line that closes it belongs to
`src/js/family/mount.js` — the only module that holds a transport and the only one behind ADR 003
§7 gate 2's single dynamic door — which a parallel workflow owns. The binding is written out
verbatim in `port.js`'s header and `tests/tier1/feedback.test.js` §6 pins the contract, so it
cannot land wrong.

**Why LOW.** The screen degrades honestly rather than failing: the preview renders, the payload is
built, and the two fallbacks LZP-1009 requires anyway — „In die Zwischenablage kopieren" and
„Als Datei sichern" — are on the screen *before* any send is attempted, because "the relay being
unreachable is itself worth reporting". A solo tester has no relay to send to in any case, so for
her the fallbacks are not a degraded path, they are the path. Verified end to end in the real
browser by performing that one line by hand: the report reached the real relay, which wrote it to
disk with zero board strings in either file.

### 18d. What the endpoint proves, and what it does not

`POST /api/v1/feedback` cannot require membership — a report is most needed when the family space
is broken, and a solo tester has no server relationship at all. Its credential is a **self-attested
device signature**, verified for real (a presented signature that does not verify is a 401), and
`handlers/feedback.js` states in `PROVES` / `PROVES_NOT` on the wire what that buys:

> **PROVES** — two reports carrying this same self-minted public key were signed by the same
> private key.
> **PROVES NOT** — that the key belongs to a member, to a device this server has ever registered,
> or to a person. It is self-minted client-side and never enrolled, so a fresh one costs one
> keypair. **The rate limit (`feedbackReport`) and the size cap (`bytesPerFeedback`) are the
> controls; the signature is a thread, not a gate.**

The signature is also **optional**, which is the same argument one step further: the report that
says „mein Schlüsselbund ist kaputt" is written by a Mac that cannot sign, and refusing it would
refuse the report the endpoint exists for.

### 18e. Owed after this pass

1. **`family/mount.js`** — the one binding line, E10-1009-A above.
2. **Call sites for `noteEvent`.** The ring buffer is real, bounded and tested, and the only thing
   currently writing to it is its own error tap. `renderBoard`'s timing, `drag:commit` refusals and
   `sync: n ops applied` are the three LZP-1009 names, and all three live in files this ticket does
   not own (`board.js`, `interact.js`, `sync/`). Each is one call.
3. **LZP-1001's Datenschutz sentence** — now one line smaller than E10-2 predicted: the relay
   receives reports too, and they contain no entry text. Not a third processor.
4. **A production `feedbackSink`.** `server/dev-server.mjs` writes two files beside the store;
   `server/adapters/vercel.js` has no sink, so the route answers **501** there — honestly, rather
   than accepting a report and dropping it. RUNBOOK owes the deployment step.

---

## 19. LZP-1002 — THE SHELL TRANSPORT INTEGRATION (2026-09-03)

**Full record: `docs/v2/SHELL-VERIFICATION.md`.** This section is the findings half.

The question the pass existed to answer — *does the family work in the app we ship, rather than in
a browser?* — has an answer, and it is **`chooseTransport()` returns `bridge` in the shipped app,
and the bridge carries bytes**: five separate instances of the shipped `.app` formed one
Familienkreis over `sync_request`, with zero `fetch` calls anywhere. It also has two findings that
are more important than the answer.

### 19a. The conformance finding had a second half nobody had named

`net.js:718` returning `bridge` while `sync_request` existed in neither shell was the reported
gap. The unreported one: **only `family/engine.js` ever asked `chooseTransport`.**
`family/createjoin.js` and `family/mount.js` built **six** transports with
`createFetchTransport` unconditionally — create, join, redeem, the anonymous adopt, the pairing
transport, and the one `adminpanel.js`/`leavedelete.js` borrow through `circleTransport`.

A `fetch` inside the shell is blocked by `default-src 'self'`
(`tests/tier2/shell-bridge.dom.js`: *"an outbound fetch is actually blocked, not merely
discouraged"*). So even with `sync_request` shipped, **creating a Familienkreis in the shipped app
could not have worked**, and neither could the co-signature screen that had just been built on top
of it. All six now go through `chooseTransport`.

The same shape one layer up: `sync_request` refuses everything until
`set_shell_pref: "sync_enabled"` is pushed, it defaults to false, and **nothing pushed it**. A
shipped shell would have refused every sync even with a relay configured and a circle joined.
`familysettings.js#armShellSync` pushes it now.

**The lesson, and it is the same one E6-1 taught from the far side:** a gate that is enforced in
one place and consulted in six is a gate that is off in five of them. `chooseTransport`'s docblock
had said *"a caller that reads `'fetch'` in the shipped shell has found a bug in gate 3"* — and
nobody had read it, because most callers never asked.

### 19b. FINDING F-SHELL-1 · CRITICAL · the family layer terminally refuses peer attestations, and every launch makes it worse

**Not a transport defect. It is the thing that stops the family working, and it is transport-blind.**

A Mac in a Familienkreis accumulates `badAttestation` refusals. Measured on the founder across
four launches, its refusal ledger read **0 → 6 → 13 → 25**. Once a peer's `member.set{dev.<short>}`
op has been refused, ADR 003 §8.2 has released the cursor past it and it can never be fetched
again — so that peer's device is permanently unattested on this Mac, every entry it authors parks
`unattestedDevice`, is retried five times, and is given up on.

The mechanism is written in the product's own words, in `family/engine.js#publishMyAttestation`:

> *"`selfAttest` re-signs on every launch and ECDSA is randomised, so the blob this launch minted
> is a DIFFERENT STRING from the one already in the log even though both attest the same six
> fields and both verify under the same recovery key."*

`platform/device-identity.js#buildAttestOpen` keys its verified map on the **exact blob string**,
and the only blobs it can pre-verify are the ones the relay's roster carries — the **first** blob
each device registered. Any later blob is unverifiable by every peer, `core/authz.js` stage 0a
answers `BAD_ATTESTATION`, and **the refusal is terminal**.

**Reproduced on demand:** running the demonstration's settle loop twice instead of once took it
from *"the entry crosses to both peers"* to *"the entry crosses to neither"*. Not a flaky test —
the defect, on a dial.

**The cheapest fix is a severity change, not a redesign.** Refusing an unverifiable attestation
`badAttestation` (terminal, cursor released) is the wrong verdict; `unattestedDevice` (parked,
re-judged when one arrives) is the right one, and the park machinery already exists and already
has a reaper (`store.unparkAttested`, L-3). The structural fix is either to verify an unknown blob
on demand, or to publish the blob the relay already holds for this device rather than a freshly
minted one.

Owner: `src/js/core/authz.js` · `src/js/platform/device-identity.js` · `src/js/family/engine.js`.

### 19c. FINDING F-SHELL-2 · MEDIUM · a leave leaves no trace, so the stranded sentence never fires

T5-M3's caveat — *"if this circle shrinks to two people and the person who created it is no longer
among them, nobody can remove anybody any more"* — is met **before it bites** by
`createAdminPort#eligibleCosigners` returning 0, which makes the sheet say so instead of sending a
request.

In a real founder-less two-member circle it returned **2**. `eligibleCosigners` counts from this
Mac's own member list — the folded family log, correctly, because that is the list the sheet shows
— and a **removal** writes `member.set{_alive:false}` into that log while a **leave does not**:
`POST /members/leave` is a relay call and the leaver is not there afterwards to author anything.

So in the one state the sentence was written for, the person meets
`403 founder_gone_every_removal_needs_second_key` instead of the paragraph that explains it. The
403 is at least readable — `leavedelete.js#proofDemand` reads it and the co-signature sheet opens
— so this is a copy-reachability defect, not a lockout. Fix: intersect the log's member list with
the roster's `removedAt` column, which `sync/keys.js#roster` already fetches.

Owner: `src/js/family/adminpanel.js` · `src/js/family/removal.js`.

### 19d. What was attacked and held

The SSRF surface is new and it is the most dangerous thing in the product: a bridge command
performing HTTP from the **native process**, outside the CSP, the navigation delegate and the
`app://` sandbox, reachable from the least trusted component in the system.

**38 rows over 29 launches of the shipped `.app`, all green.** Every address the page can name — a
different host, `http://`, `file:`/`app:`/`ftp:`/`javascript:`/`data:`/`smb:`, localhost in six
spellings, five private ranges, four link-local addresses, three LAN name shapes — is refused **by
the shell**, with no HTTP answer. An off-origin redirect, a same-origin redirect and a 307 are all
`redirect_refused`. A 12 MiB flood is cut in ~12 ms; an announced 64 MiB is refused on the
response header. A stalled relay times out at 15.99 s. A cookie is not kept. Smuggled headers
refuse the whole request rather than being dropped. And **there is no `origin` argument** —
passing one changes nothing.

The origin validator was swept with **28 launches, one per candidate value**, four of them
accepted so the sweep has a control. `isPrivateOrLocalSyncHost` is deliberately blunter than "no
private ranges": every IP literal is refused, v4 and v6, **including a perfectly routable public
one**, because a relay is a NAME.

**A real leak was found and closed on the way.** An unpinned `URLSession` was adding
`User-Agent: LangzeitPlaner/1.0.0 CFNetwork/3860.700.1 Darwin/25.6.0` — this Mac's macOS build —
and `Accept-Language: en-US,en;q=0.9` — the user's language preferences — to every sync. Signed by
nobody, in neither ADR 003 §2 nor `server-metadata.md`'s inventory. The hostile relay's own log
now reads `["LangzeitPlaner"]` and `["*"]`.

### 19e. The redaction boundary held a sixth time

A native process that speaks HTTP is a new surface with three new places bytes could surface:
stdout, the reply's `detail` field, and the pref file. Four static rows
(`tests/tier1/headless-shell.test.js`) and one runtime row (`tests/tier2/shell-ssrf.dom.js` §10)
close all three: nothing in the sync section prints, the body is never interpolated into any
string, `sync.json` holds `["enabled": enabled]` and nothing else, `sync_status`'s keys are
exactly five, and a marker planted in the body, the URL and a header appears in **no** reply over
six request paths. The existing 102 boundary rows are unchanged and green.

### 19f. Inverted, and closed

- **FINDING P-5's shell half.** `reply.url` is now **REQUIRED** in `createBridgeTransport`; both
  shells send it. `tests/attack/privacy-e5-endpoint.test.js` §2 inverted from
  *"SUCCEEDED (reduced) — a bridge reply that omits `url` is still accepted"* to
  *"FAILED (closed) — … is REFUSED"*, with an honest-path control and a row that fails if either
  shell stops naming the URL.
- **ADR 003 §7 gate 3 is no longer OWED.** The paragraph asking the navigation delegate to
  *"permit exactly the one sync origin"* is a **loosening** and was not built; the ADR is amended
  to the shape that ships, and a tier-1 row fails the build if anyone implements it as originally
  written.
- **Swift ↔ Rust parity is gated, not reviewed.** `helper-hygiene.js` gained `SHELL_RUST` /
  `rustSource()` and two tier-1 rows now hold the two shells to the same refusal vocabulary and
  the same seven checks by name. The Rust half is still uncompiled (no `cargo`, PLAN.md R8) and
  the `reqwest` line it needs is now in `Cargo.toml`, held by a row.

### 19g. Owed after this pass

1. **F-SHELL-1** (19b) — the one that stops the family working.
2. **F-SHELL-2** (19c).
3. **The remaining conditional stories** — `SHELL-VERIFICATION.md` §10 lists all 51 and which 31
   are now unconditional. Co-editing (18.2/18.5/18.6), pairing (19.5), the remaining admin verbs
   (20.1, 20.4) and Belegt-crossing (16.7) have still never run over the bridge.
4. **`SYNC_ORIGIN_BUILTIN` is `""`** and every shipped build therefore refuses locally. No TLS
   round trip has ever been made — the https-only rule is proven by refusal, not by success.
5. **The Rust half has never been compiled.**
6. **CI** — the two drivers are 56 app launches and are not in `npm run test:dom`. Both tier-2
   files skip visibly when their driver has not configured them.

---

## 20. LZP-1001 + LZP-1002 — the Datenschutz section, and 21.5 amended (2026-09-03)

Run after LZP-1009, which is why it exists in this order: 1009 made „Rückmeldung senden" the first
network request a solo copy of this app can make, and a story that says *zero* was false from that
commit. Full record: `docs/v2/E10-VERIFICATION.md` §10–§12.

### 20a. THE AMENDMENT — recorded as a decision, not as a diff

**Amending a measured property is exactly the quiet erosion a conformance sweep hunts for.**
`judge:conformance` B-14 caught ADR 003 §7 gate 1 being *vacuously* true by the same mechanism, so
this one is written down three times with the decider named: **ADR 003 §7.5**, **DESIGN-DECISIONS
D10**, and the front-matter *Amended* row of ADR 003.

- **OLD:** "in solo mode the app makes zero network requests; with a Familienkreis it talks to
  exactly one sync endpoint and nothing else."
- **NEW:** "in solo mode the app makes zero **unrequested** network requests — the only request a
  solo copy can originate is the one a human asks for, by pressing „Senden" on the Rückmeldung
  screen (LZP-1009); with a Familienkreis it talks to exactly one sync endpoint and nothing else."
- **DECIDED BY:** the **PO**, 2026-09-03. The alternative — family-only feedback — refuses the
  report from the only tester who has no Familienkreis, i.e. the person the feature is for.

**It is narrower, not softer.** Old bound: a **count** (zero), measurable only over sessions
somebody scripted. New bound: an **originator** (a human press), a property of the source tree,
checkable by construction — and the property that actually fails when the exception widens.
`tests/tier1/network-scope.test.js` §5, five rows, measured at HEAD: **1 originator, `human`,
`src/js/feedback/ui.js:245`, trigger `addEventListener('click', …)`**, over **78** shipped modules.

**The exception may not widen**, and §5b/§5c are the rows that detect it. The shape to expect is
not a second endpoint (§2c of the E10 sweep counts those) — it is a second **caller**: a retry
timer, an `online` listener, an `unhandledrejection` handler that files by itself. Each is a
courtesy alone; together they are an unattended solo Mac sending with every endpoint gate still
green.

### 20b. Two defects found in rows this ticket wrote — by mutants, not by review

- **E10-1002-A (MEDIUM, in a test)** — §5b's caller regex was `\b<fn>\s*\(`. Mutant **M4**
  (`setTimeout(autoReport, 0)`) survived it: a function dispatched **by reference** never writes a
  `(` after its name, and reference-dispatch is precisely the shape a background-retry patch
  takes. Now `\b<fn>\b`.
- **E10-1002-B (MEDIUM, in a test)** — tier 2 §5b asserted only that E10-B7's regex matched the
  union of the product's copy. It stayed **green** under mutant **M8**, which removed R1's
  sentence — because the regex's `nicht verschlüsselt` alternative matches the **Privat**
  paragraph, a sentence about family ops with nothing to do with a backup file. **Green for an
  unrelated reason** is the exact rot §2a and §3a of the E10 sweep died of, reproduced inside a row
  written to invert one of them. The inversion is now **located**: it must match inside
  `DATENSCHUTZ[lang].backupBody`, and the false positive is asserted and named so it is not
  rediscovered.
- **E10-1002-C (LOW, in a test, found before the mutants)** — §5b's classifier read the
  **stripped** source, in which `addEventListener('click', …)` has had its literal blanked, so the
  product's one real human press was classified **automatic**. Detection now runs on stripped
  source, classification on the raw line; the arrays are index-aligned because
  `stripCommentsAndStrings` preserves newlines.

### 20c. R1 — the copy half closed, and R1-b opened in the same breath

LZP-1003's **R1**: a stolen backup yields the whole board in the clear, with no passphrase. The
true sentence is now in the Datenschutz copy in both languages — „ohne Passwort lesbar, auch bei
einer Sicherung MIT Passwort. Das Passwort schützt die Schlüssel, nicht die Einträge … es macht
sie nicht unlesbar." — and D8's key-loss consequence sits beside it, naming the three parties who
cannot recover the data.

**R1-b (LOW, honest bookkeeping).** `tests/attack/e10-crypto-backup.test.js` E10-B7 names itself
as the assertion to invert when such a sentence is added. It scans `[EXPORT_SHEET_COPY, README,
LIMITS]` — three exports of `src/js/crypto/backup.js`, **a file this ticket does not own** (ONE
OWNER PER FILE). The inversion is therefore in `tests/tier2/datenschutz.dom.js` §5b instead, run
against the same matcher, and **E10-B7 remains green over a narrower object than the product**.
Owner: whoever next opens `crypto/backup.js`. Closing it is two edits — the sentence in
`EXPORT_SHEET_COPY.withPassword`, and flipping E10-B7's `assert.equal(…, false)` to `true`; my
tier-2 §5b's third assertion goes red the moment that lands and tells them so by name.

### 20d. LZP-1001 — what the Datenschutz section says, and what it deliberately does not

`src/js/settings.js`, a top-level section of ⚙ drawn on **every** launch. 24 blocks · 5 234
characters of German · 4 546 of English · screenshotted in the real browser in both languages.
Sentence-by-sentence provenance in `E10-VERIFICATION.md` §11.

Three deliberate refusals, each held by a row:

1. **No URL is printed.** §1g of the E10 sweep says the one remote URL in the product is still
   `OWNER-PLACEHOLDER`; a privacy page naming a host that does not exist is worse than one naming
   the company. `datenschutz.dom.js` §2e fails if a URL appears — which also stops
   `e10-network-scope.test.js` §2e acquiring its first exception inside a privacy paragraph.
2. **No „wird nach einer Stunde gelöscht".** RUNBOOK §7.2 forbids it in so many words: `RateBucket`
   is never swept and its key holds an IP. The copy says „unbefristet … bis sie jemand von Hand
   löscht", and §2d bans the comfortable phrasing while requiring the true one.
3. **No marketing and no survey vocabulary** (21.3's own "informed, not marketed"; Principle 9).
   §4a's ban list is paired with a length assertion over the same text, so it is not satisfiable by
   an empty section — mutant **M7** (drop `data-ds`) kills 14 of 19 rows including §4a, which is
   the proof that the pairing works.

**D11 — the section is NOT inside „Familienkreis", and A10 says it should be.** Built A10's way it
is drawn by `family/mount.js` — the one dynamic door — and is therefore **invisible on a solo
install**, to exactly the reader whose backup file three of its paragraphs are about. Recorded as a
decision rather than a slip.

### 20e. Two documents this pass made stale, and neither is mine

Both carry the line *"the 21.3 Datenschutz section is not in the product (`Frankfurt`, `Vercel`,
`Prisma` appear nowhere in `src/`)"* as the reason the story was open. Those three words are now in
`src/js/settings.js` and the line is false:

- `docs/v2/RELEASE-CHECKLIST.md` line 173
- `docs/v2/MOM-TEST.md` line 523
- `docs/v2/RUNBOOK.md` line 171 and §7's heading — *"until LZP-1001 puts that on a screen, **you
  are the Datenschutz page**"* — which no longer applies, and §7.3's item 2 (*"the Datenschutz text
  must name the release host as a second remote"*), which is now **done** in the form §1g permits:
  the operator is named (GitHub), the host is not, because there is not yet a real one.

Not edited here — one owner per file, and RUNBOOK/RELEASE are LZP-1008's. **No test asserts the
absence of those words in `src/`**, so nothing goes red; the staleness is in prose only, and this
is the register entry that says so.

### 20f. Owed after this pass

1. **R1-b** (20c) — `crypto/backup.js`'s own strings, and E10-B7 inverted in place.
2. **The three stale documents** (20e).
3. **E10-1009-A** — `family/mount.js` still owes its `setFeedbackPort(...)` line. Until it lands
   `canSend()` is false and „Senden" is disabled with the reason on screen. §5a of the tier-1 gate
   is written to accept that binder when it arrives: a module importing the **setter** is a binder
   and is allowed; a module importing `feedbackPort()` is an originator and is not.
4. **A production `feedbackSink`.** Vercel answers 501 today, honestly.
5. **The retention sentence is written to change with the code, not before it.** The day the
   `RateBucket` sweep exists, `DATENSCHUTZ.*.retentionBody` changes in the **same commit** — RUNBOOK
   §7.2's rule, and `datenschutz.dom.js` §2d is what fails if the copy moves first.

---

## 21. THE FINAL INTEGRATION — four parallel passes, and the third half of F-SHELL-1 (2026-09-03)

Full record: `docs/v2/V2-FINAL.md`. This section holds the findings.

### 21a. F-SHELL-1(b) — `store.js#_absorbedAttestOps` had never once run

**Severity: this is why a family did not work in the shipped app.**

`_absorbedAttestOps` was landed by the attestation pass to close the half of F-SHELL-1 that the
severity split does not reach: a joiner's first launch fixes a checkpoint horizon at its own
newest op, `_persistOps` ① then skips every line at or below it as "already durable in the
checkpoint", and the founder's `member.set{dev.<short>}` never reaches `ops.jsonl`. From the next
launch `foldAuthorized` has no attestation for the founder's device, and every op the founder
authors parks `unattestedDevice` for ever, curable by nothing.

**The reconstruction was inert.** `foldAuthorized`'s Pass A runs `classifyOp` before any
attestation condition, and it is not lenient: `core/ops.js:418` requires `op.id` to be a 22-char
opId and `:445` requires the same of `op.gid`. The method passed `gid: null` always, and for a
cell with no opId minted `cp_<member>_<name>`. Both are rejected `{stage:'attestation',
reason:'shape'}` — so every reconstructed op was discarded before it could attest anything.

**Why 5,448 green rows did not see it: nothing exercised it.** The method shipped with no test of
any kind. It is the exact shape of defect this project's rules exist to prevent, and it got
through a pass that landed 20 rows and 5 mutants beside it.

**Why the shell run read as flakiness rather than as a defect.** It only bites the Mac whose
checkpoint happened to absorb the founder's op. Measured from a kept work dir: Mama's Mac had a
`checkpoint.json` whose horizon was 5 µs after her own first op and which held Papa's
`dev.AB9ADNDX5TD1C4G7` cell; Oma's Mac had no `checkpoint.json` at all. Same relay, same run.
Mama parked Papa's entry `unattestedDevice` five times until `sync/family.js#terminal` quarantined
it and ADR 003 §8.2 released the cursor; Oma read the entry without trouble.

**THE FIX.** The cell's own opId is required, and is also the gid. A register cell is
`{value, stamp, author, op}` and does not retain the writing op's group, so the true gid is
unrecoverable — and it need not be recovered: **nothing in `core/authz.js`, `core/registers.js`
or `core/materialize.js` reads `gid`.** It is the local undo stack's grouping key
(`core/undo.js`), and a remote op reconstructed for a fold never enters that stack. The op's own
id satisfies the shape rule and stays deterministic on every Mac holding the cell, which is what
convergence needs. A cell with no usable opId is skipped rather than given an invented one:
without an id there is no deterministic identity and a minted one would differ every launch.

**Measured on the captured state of the Mac that failed** (its real `checkpoint.json` +
`ops.jsonl`, folded in Node): with a verifier installed, admitted ops **0 → 10**, and Papa's
entry „Omas Geburtstag" appears in Mama's fold. The one op still refused is the admin's unshare,
`{stage:'content', reason:'notOwner'}` — F-SHELL-3, below.

### 21b. F-SHELL-1(b2) — the reconstruction manufactured envelope splices

`applyRemote` folds `[…reconstructed, …lines, …wellFormed]`, and `wellFormed` is not a line yet.
So a cell whose op was **in the arriving batch** looked absorbed and was rebuilt beside it: the
same opId under two different bodies, because the synthesized gid differs from the real one.
`foldAuthorized` Pass A reads that as **envelope splicing** (ADR 002 §5.1) — it resolves the
contest by canonical max and records the opId in `splicedIds`. The store then reports tampering
that never happened, on ops nobody touched. A relay re-serves an op on every cursor reset, so this
is ordinary and not an edge. Measured in the fleet rig on a replayed batch: 2 reconstructions →
**2 spliced ids**. `_absorbedAttestOps(arriving)` now counts the arriving batch as live.

### 21c. F-SHELL-4 — a second, identical self-attestation, and a permanent `writeOnce` — **OPEN**

Measured in the shipped app across five acceptance runs. Mama published her own device attestation
**twice**, in two consecutive launches, for a register ADR 001 §4.0 makes write-once:

| | opId | ts | authored in |
|---|---|---|---|
| first | `KHtuA9DtDkRWwYxH99jkdw` | `…156958` | phase 02, her join |
| second | `luxBkX3rBVObeBqDLJFssA` | `…160800` | phase 06, her next launch |

Same member, same `deviceId`, **the same 545-byte blob**, 3.8 s apart. Both are admissible on
their face, so §4.0 does what it must — every Mac keeps the minimal claim under `≺` and refuses
the other `writeOnce`, terminally — and the circle splits on the record: Mama's log names `KHtu…`
as the writer of her own register, Papa's, Oma's and Opa's name `luxB…`.

**Nothing breaks.** The blobs are byte-identical, the device stays attested either way, and all 26
phases pass in all five runs. What remains is a permanent, misleading refusal on every peer, on
every launch — and it is the entire difference between the measured refusal ledger and zero:
**2 · 2 · 2 · 34 · 2**.

**A hypothesis was built, tested, DISPROVEN and reverted.** The obvious cause is that
`family/engine.js#publishMyAttestation` reads `store.registers()` — the *authorized* fold — at
`:629`, 104 lines and one `await` before the roster read installs `attestOpen` at `:733`. A
`store.ownAttestationBlob()` accessor was written on that hypothesis and wired in. **It is
false:** `store.js#_noteAuthzVerdict` returns the raw base register map unless there are
*withdrawals*, and `_withdrawalsOf` names `badAttestation` and `writeOnce` as explicitly not
withdrawals — the cell is visible with or without a verifier. A mutant reducing the new accessor
to the old lookup **killed no row**. The change was reverted rather than shipped with a confident
comment about a mechanism that had been disproven.

**The thread to pull next:** in the failing run Mama's `KHtu…` carried `seq: null` — it **never
reached the relay** — and her final `ops.jsonl` held only two of her own ops while her board
carried three notes. Whatever emptied her log between phase 02 and phase 06 is the cause.
Characterized by `tests/fleet/e11-attest.test.js` §5e, which pins the guard (live line, absorbed
cell, the constructor's `DECLINED`, and an honest-path control) so the next owner starts from a
tested guard rather than from nothing. **Owner: `family/engine.js#publishMyAttestation` +
`store.js#_persistOps`.**

### 21d. F-SHELL-3 confirmed as the only data-loss residual

`unshare-owner (B)` is BLOCKED in **10 of 10** measured runs, before and after this pass. The
admin's „→ Privat" reaches the owner's Mac as a **deletion** rather than a reversion, and she
loses her own entry. It is also the single `notOwner` in the residual refusal ledger — refused on
her Mac, then remembered by L-1 on every later launch, which is the whole of the "2" in four of
five acceptance runs. **Owner: `src/js/family/sharing.js`.**

### 21e. Three diagnostic bugs that would mislead the next reader

1. `tests/tier2/shell-family-e2e.dom.js:466-471` calls `Object.keys()` on
   `membersui.membersRegisters()`, which returns a **Map** (`membersui.js:774`), so
   `REGKEYS`/`DEVREGS`/`MEMREGS` print `[]` unconditionally. They are **not** evidence of an empty
   register map — this pass nearly chased them.
2. The same file's line 459 reads `m.attestation` on the member row; ADR 003 §3.6 puts the blob on
   `m.devices[].attestation`, so `att=` is always `false`.
3. **`assert.doesNotThrow(() => validateOp(op))` is vacuous.** `core/ops.js#validateOp` returns
   `{ok:true}` or a rejection object and never throws, so the assertion passes over a malformed
   op. The first cut of `e11-attest.test.js` §5b made exactly that mistake and survived the mutant
   that should have killed it; it now asserts `classifyOp(op).status === 'admit'`, which is the
   gate `foldAuthorized` actually runs.

### 21f. Owed after this pass

1. **F-SHELL-4** (21c) — open, characterized, cause unnamed.
2. **F-SHELL-3** (21d) — `family/sharing.js`, the only residual that loses data.
3. **F-SHELL-2** — `family/adminpanel.js` + `family/mount.js`: intersect the log's member list
   with the roster's `removedAt`. The originally assigned fix was refuted by measurement
   (`server/core/handlers/lifecycle.js:229` deletes the leaver's ops in the same transaction).
4. **A `Server:` line in `docs/v2/email/invitation.{de,en}.{txt,html}`** (LZP-108). Until it
   lands, the Mom test cannot be run at all: she has no relay address and `submitJoin` dead-ends.
5. **`server/adapters/prisma.js` against the real database** — the migration is verified, the
   adapter over it is not (§2.5's `store-contract.test.js`).
6. **`family/mount.js#setFeedbackPort(...)`**, and a production `feedbackSink` (Vercel answers
   501 today).
7. **`scripts/shell-family-e2e.mjs`'s stale phase label** — it still prints
   `BLOCKED (finding F-SHELL-1)` for any attempted phase that fails.

---

## 22. THE CLOSING PASS — R-1 answered, and the residual list re-issued (2026-09-03)

**Full record: `docs/v2/V2-FINAL.md` §8 (re-issued).** This section is the findings half.

The question this pass existed to answer: **can a stranger get from an e-mail to a shared family
board, and does nobody lose anything on the way?** Both halves now have a measured answer, and the
second one changed: the acceptance run's refusal ledger, which had never been flat, is **0**.

### 22a. F-SHELL-3 was three defects, and the headline on it was wrong

`docs/v2/V2-FINAL.md` R-1 read **„⛔ DATA LOSS — the owner loses her own entry"**. Measured on the
shipped binary and in the fleet: **nothing was ever deleted.** `pub.alive` is NULLED and never set
false, the patch is `pub.*` only, and the admin cannot address the owner's personal space at all
(`core/project.js:750-760`). Her text, her entry and her `_alive` were intact in every run. What
was lost was the **reversion** — she kept publishing an entry the admin had withdrawn, and the
circle was split on the record while the admin's screen said it had worked.

Three separate defects wore that one label.

**(a) The admin chain is absorbed by the checkpoint, so the retraction is refused `notOwner`.**
`core/authz.js:1404` stage 3a admits an admin's `pub.set` on another member's entity only if
`adminAtKey(spaceKey(op.space), op.ts)` names him. `adminAtKey` resolves the chain stage 1 built,
and **stage 1 builds it from `space.set{admin, adminPrev}` OPS only** (`authz.js:1234-1255`) —
never from registers. After the owner's *first relaunch* her `_log.ops()` holds no `space.set`
line at all, while `space:<id>.admin` still names the admin and `store.js#familyAdmin` answers
correctly. Empty chain → `who === null` → `REJECT_REASONS.NOT_OWNER`, and a rejection is final, so
L-1 re-refuses it on every later launch. That was the single `notOwner` in the residual ledger.

This is **F-SHELL-1(b) one register over.** `store.js#_absorbedAttestOps` rebuilds absorbed
`member.set{dev.*}` ops for exactly this reason; nothing rebuilt the `space.set` link.

**Why no row caught it:** `tests/fleet/e9-attack-moderation.test.js` §3a and
`tests/tier2/unshare-ui.dom.js` §5 are green because **neither ever reboots the owner's Mac.** The
shipped app is nothing but reboots.

**Closed** by `store.js#_absorbedChainOps()` — a sibling of `_absorbedAttestOps`, spread into the
same three fold inputs (`_refoldAuthorized`, `applyRemote`, `unparkAttested`), rebuilding ONE
`space.set{admin, adminPrev:null}` op per family space out of the `space:<id>` → `admin` cell,
with `dev` read out of `devOf(cell.stamp)` and matched against the author's own member record. It
is not trust: the reconstruction is handed back to `foldAuthorized` as an ordinary op and pays
stage 0b and stage 1's `resolveChain` again. It is inert outside a family circle, and its bound is
one op per space.

**(b) A relaunch turned a FOREIGN entry into one of the viewer's OWN Privat notes, once per
launch.** ADR 006 R1 re-migrates `board.json` into the spine on every launch
(`store.js#_buildSpine`), `board.json` is `store.state`, and `store.state.notes` carries the
viewer's redacted projection of another member's entry. `migrateV1` has no notion of a foreign
entry: it cannot use `fnote:<mem>/<uuid>` as an entity id, so `migrate1to2.js#mintedId` mints one
and the result is written as one of MY OWN `note.set` ops at `visibility: 'privat'`. Last launch's
copy is then itself in `board.json` with a usable id, so the occurrence counter hands the next
launch a fresh one. **Measured on the shipped binary at `78016e8`: seven copies of Papa's „Omas
Geburtstag" on Mama's board after seven launches.**

**Closed** by `store.js#withoutForeignEntries()`, called from `_buildSpine`. A foreign entry's
truth is the owner's ops, which this Mac holds as `fnote:`/`fbar:` registers in its checkpoint and
re-projects every launch — so dropping it from the spine loses nothing, and keeping it in was what
turned a revocable view into a copy nobody can take back.

**(c) „She lost her entry" was a HARNESS defect, not the product.**
`shell-macos/main.swift#runTestFile` printed the TAP and called `exit()` from inside the
`callAsyncJavaScript` completion. `exit()` does not run `applicationShouldTerminate` — the only
other caller of `window.__lzpFlush` — and does not fire `pagehide`, so the page's 700 ms
`SAVE_DEBOUNCE` was abandoned at the end of **every** phase and every tier-2 file. Under ADR 006
`board.json` IS the truth, so the entry a phase had just created was gone next launch. ⌘Q always
flushed; only the test runner did not. **Closed** by awaiting the same flush before `exit()`, with
the same 2 s watchdog `applicationShouldTerminate` uses. No UI call was added; `isHeadless` and
the `.accessory` activation policy are untouched, and `tests/tier1/headless-shell.test.js` asserts
both — the flush and the absence of a new presentation site — in one row.

### 22b. The residual inside R-1 that is NOT closed, and is now pinned

`_absorbedChainOps` rebuilds only a **genesis-shaped** link (`cell.author === cell.value`, ADR 001
§4.1's own root test). That is the limit of what one register cell contains, not a simplification:
after `transferAdmin` the head link carries `adminPrev: <opId>` and `act !== admin`, and
`resolveChain` needs the predecessor links to accept it — which a register cell does not retain.

**The previous pass recorded „no shipped circle transfers the seat yet". That is wrong.**
`family/adminpanel.js:654` ships `transferAdmin`, and `family/leavedelete.js:1433` calls it on the
path where a founder hands the seat over before leaving. So a circle whose admin seat has moved
still loses the admin's retraction once the owner's Mac has compacted.

The wrong repair would be to rebuild it anyway with `adminPrev: null`, presenting a transferred
seat as a genesis root — the rootless assertion `core/ops.js#transferAdmin` refuses to mint for
exactly this reason. `tests/fleet/e12-unshare.test.js` **§8** is what stops that: a real transfer,
through the shipped mutation and the shipped seal, and then the assertion that the reconstruction
stays **silent**. The general repair — keep `space.set` chain links out of compaction in
`store.js#_persistOps`, one op per transfer — is **not made here**, and it is residual R-1b.

### 22c. F-SHELL-2 is answered by one measurement, and it is not what the report said

`docs/v2/SHELL-VERIFICATION.md` §5 recorded `eligibleCosigners → 2` in a two-member stranded
circle. The previous pass could not decide from `adminpanel.js` and `mount.js` alone whether that
was a missing intersection or a stale roster, and asked for one run that records
`rosterCache.length` beside the count. `mount.js#rosterSnapshot()` now does, and the driver prints
it:

```
#    eligibleCosigners=0 · rosterCache=4 · alive on the relay=2
```

**The roster is present (4 rows) and the count is 0.** The stranded sentence fires. `membersui.js`
already applies `removedAt` and `adminpanel.js#eligibleCosigners` already reads that view, so the
number was right as soon as the roster was there — and it is there on the boot path. The **2** in
§5 was taken on a Mac whose `rosterCache` was empty at that moment; it is not reproducible in 10
consecutive runs of the shipped binary.

### 22d. LZP-1009 was unwired, and the wiring found one thing the hand-off could not know

`src/js/feedback/port.js` published the binding line its ticket did not own. It was one field
wrong: a transport answers `{status, headers, json}` and a `FeedbackPort` promises `{status,
body}` — `ui.js#doSend` reads `res.body.error` to name a refusal — so the suggested one-liner
would have turned every named server answer (`payload_too_large`, `rate_limited`,
`not_implemented`) into the generic failure sentence. `family/mount.js#bindFeedback` maps it.

It binds from `start()` on a personal-space Mac and from `startCircleEngine()` on one in a circle,
and **which one is decided by asking, not by racing** — both binders are async, so „last one wins"
would have been a coin flip on a slow key export. A solo Mac binds nothing, which is not a gap:
`canSend()` is false, „Senden" is disabled, `copy.js#noRelay` says why, and the two fallbacks are
on the preview screen before any attempt.

Two adversary rows went red on arrival and were **inverted, not weakened**:

- `tests/attack/e10-network-scope.test.js` §2a asserted the set of files that may mention the
  feedback tree is exactly `{settings.js}`. It is now exactly `{family/mount.js, settings.js}`,
  two seams with two different jobs, and the row gained the assertion that keeps them apart: the
  binder may not reach `openFeedback`/`buildHelpSection`/`initFeedback`, and the drawer may not
  reach a transport. A third file still reddens it.
- `tests/attack/privacy-e5-endpoint.test.js` §5 enumerates every path the source can build. It
  read six files and **not** `feedback/port.js`, which is where `FEEDBACK_PATH` lives — so for one
  pass the product could address a ninth path and this row could not see it. The file is in the
  list and `/api/v1/feedback` is in the expected set. `docs/v2/server-metadata.md` carries its
  line: what a platform request log records is *that somebody reported something, and when*.

**What is still owed is a destination, not a binding.** `server/dev-server.mjs` binds
`ctx.feedbackSink`; `server/adapters/vercel.js#buildCtx` binds none, so the deployed relay answers
**501 not_implemented** — honestly, rather than accepting a report and dropping it.

### 22e. Two things another agent's file was wrong about, corrected in place

1. **`tests/server/store-contract.test.js`'s `PRISMA_BLOCKED` is now empty.** Its one entry, C40,
   was a fixture defect: `putInvite({ id: 'inv_other', spaceId: SP2 })` named a space nothing had
   created, `memory` and `file` accepted the orphan because they have no referential integrity,
   and PostgreSQL 17.10 raised `Invite_spaceId_fkey` and was right to. `server/core/store-interface.js`
   now creates SP2 first. **The guard that made this an event rather than a stale skip went RED the
   moment the fixture was fixed**, which is the whole reason it exists. 66 of 66 cases against a
   live cluster; `test:server` reads **1069 / 0 / 0 skip** with `LZP_CONTRACT_DATABASE_URL` set.
2. **`server/vercel.json`'s `ignoreCommand` was single-commit** and is now the whole
   `VERCEL_GIT_PREVIOUS_SHA..HEAD` range, with both fail-open guards asserted by running the real
   string: an unset SHA exits 1 (BUILD) and an unresolvable one exits 128 (BUILD).
   `.github/scripts/check-deploy-window.mjs` no longer assumes the window — it reads it out of
   `vercel.json` and checks the half that a range does not fix. Mutant: a `${…:-HEAD}` fallback
   that skips on an unset SHA is caught and named.

### 22f. Every fix in this pass, and the mutant that kills it

Scratch copies of the tree (`tar`, never `git stash`), one run each, honest-path control green on
the same copy before every mutant.

| # | Mutant | Rows that died |
|---|---|---|
| **M-CHAIN-1** | `store.js#_absorbedChainOps` returns `[]` — i.e. exactly as the code shipped | `e12` §2 §3 §4 §5 (3/4). Control 8/8. |
| **M-CHAIN-2** | the rebuilt link's `dev` is **this Mac's own device** instead of `devOf(cell.stamp)` | `e12` §2 §3 §4 §5 — stage 0b refuses it `unattestedDevice`, which is the point: an invented device is the one field nothing could back |
| **M-CHAIN-3** | the genesis guard `cell.author !== cell.value` is deleted | `e12` §8 — a **transferred** seat is rebuilt as a genesis root. *(This mutant SURVIVED the first cut of the file; §8 was written because of it.)* |
| **M-FOREIGN-1** | `withoutForeignEntries` is a no-op | `e12` §6 |
| **M-SWIFT-1** | the flush is removed from `runTestFile` — `exit()` as it shipped | `tests/tier1/headless-shell.test.js` „the --test runner flushes the page before exit()", **and the shipped binary goes back to `unshare-owner (B) — BLOCKED` with „the owner lost her own entry — unshare DELETED instead of reverting"** while the refusal ledger stays **0**. That one run is the proof that (a) and (c) are two defects and that the „DATA LOSS" headline was the harness. |
| **M-FB-1** | the `setFeedbackPort({…})` call is deleted from `mount.js` | `e10-network-scope` §2a |
| **M-FB-2** | the binder gains a path to `openFeedback` | `e10-network-scope` §2a (the „binder may not open the screen" half) |
| **M-PATH-1** | `feedback/port.js` is dropped from the path enumeration's file list — the state before this pass | `privacy-e5-endpoint` §5 |
| **M-DW-1** | `vercel.json` reverts to `git diff --quiet HEAD^ HEAD -- .` | `check-deploy-window.mjs` takes the single-commit branch and is red on the push it guards |
| **M-DW-2** | the range is kept but the fail-safe is dropped (`${VERCEL_GIT_PREVIOUS_SHA:-HEAD}`) | `check-deploy-window.mjs` — „ignoreCommand skips on an unset SHA" |
| **C40** | *(no mutant needed)* — fixing the fixture made the „a case listed as BLOCKED must still be blocked" guard go **red**, which is the whole reason that guard exists |

One mutant that **survived**, recorded rather than hidden: `if (false) setFeedbackPort({…})`. §2a's
`assert.match(bindCode, /setFeedbackPort\s*\(/)` is textual and cannot see reachability. The
row's real teeth are the file-set assertion and the two „may not do the other's job" assertions,
all three of which M-FB-1 and M-FB-2 kill; the behavioural pin is the shell e2e's `feedback`
phase, which asks `canSend()` about a port **the test did not bind** and then gets a 202.

### 22g. Owed after this pass

The residual list is `docs/v2/V2-FINAL.md` §8, re-issued. In one line each:

1. **R-1b** — a TRANSFERRED admin seat is not rebuilt after compaction. `store.js#_persistOps`.
2. **§A4** — the 9 px ink floor. A PO ruling; `palette.js` is pinned by the tier-1 oracle.
3. **§E3** — the row asks 75 % where 48 % is the mathematical ceiling for any ordering.
4. **§E1** — `findWorst` straddles 16.7 ms; the last ~6 ms is `src/css/app.css:942-950`, i.e. what
   find looks like, which is a PO call.
5. **A production `feedbackSink`**, and the real relay origin substituted into the four
   invitation files (both now on `RELEASE-CHECKLIST.md` §A).
6. **R8-R1** — the adapter has met a local cluster, not Frankfurt's pooler.
7. **`storage.js#quarantineLogAside` still has no native command** in either shell.

---

## 23. THE AUDIT FIX CYCLE — the compaction class, the glass, the copy and the gate (2026-09-04)

An independent five-pass audit landed at `2d092a6` (`docs/v2/AUDIT.md`) and returned one verdict:
*"Ship the solo product. Do not ship the Familienkreis yet."* Its central result was a defect class
and, underneath it, a mechanical coverage hole:

> **`e9-attack-coedit.test.js` had 17 `coEdit` references and 0 relaunches;
> `scripts/shell-family-e2e.mjs` relaunched 27 times and had 0 co-edit phases.
> Every rig that co-edited never rebooted, and the rig that rebooted never co-edited.**

Five parallel workflows and one integration pass answered it. Every row below was **reproduced
first, then repaired, then re-measured**, and every closure carries mutants that name the row that
dies plus an honest-path control.

### 23.1 · The counts

| suite | before | after |
|---|---|---|
| `npm test` | 2229 · 0 | **2249 · 0** |
| `test:attack` | 970 · 0 | **977 · 0** |
| `test:property` | 101 · 0 | **101 · 0** |
| `test:server` | 1002 · 0 · 1 skip | **1009 · 0 · 1 skip** |
| `test:fleet` | 435 · 0 | **476 · 0** |
| `test:dom` | 875 · 3 · 36 skip | **904 · 3 · 36 skip** |
| **total** | **5 612** | **5 716** |

The three tier-2 reds are §A4, §E1 and §E3 and nothing else. **The v1 oracle did not move**: per
file, at `2d092a6` and at this tree, 436/437 tier-1 and 111/111 tier-2, identical. The one red
(`mutate() (5.4)`) is the admitted v1 behaviour change already recorded as F12.

### 23.2 · The rows

| id | finding | severity | status | owner file |
|---|---|---|---|---|
| **AU-1** | F1 · the shipped build cannot sync and no release gate says so | ⛔ | **CLOSED (gate)** · PO must claim a host | `RELEASE-CHECKLIST.md`, `main.swift`, `lib.rs`, `mom-test-probe.mjs`, `release-gate.test.js` |
| **AU-2** | F2 · a quit-and-open silently kills co-editing, for every family | ⛔ | **CLOSED** | `store.js#_absorbedGovernanceOps` |
| **AU-3** | F3 · after a relaunch a removal stops being enforced | ⛔ | **CLOSED** | `store.js`, same table |
| **AU-4** | F4 · the exposure badge under-reports what others can see | ⛔ | **CLOSED** | `store.js#_ackedLevelFloor` |
| **AU-5** | F5 · the Datenschutz screen states four things that are false | ⛔ | **CLOSED** · raises D10 | `settings.js` |
| **AU-6** | F6 · story 17.5's „neu" dot has never lit on any real board | HIGH | **CLOSED** | `store.js#_exposureCtx` + `main.js#armFamilySeen` |
| **AU-7** | F7 · a peer's change discards uncommitted typing (P3) | HIGH | **CLOSED** | `board.js` |
| **AU-8** | F8 · stale `data-date` on a yearly repeat → a phantom published write | HIGH | **CLOSED** | `board.js`, `interact.js` |
| **AU-9** | F9 / R-1b · the moderation path is lost on a bystander's Mac | MED | **CLOSED (retention)** · residual narrowed | `store.js#_persistOps` |
| **AU-10** | F10 · two honest co-editors collapse a shared bar to one day | MED | **PO-DECISION (D-G)** | — |
| **AU-11** | F11 · a peer's new *bar* can arrive with no mark of any kind | MED | **CLOSED** | `layout.js` |
| **AU-12** | F12 · the release record disagrees with the tree in five places | MED | **PARTLY CLOSED** | doc owner |
| **AU-13** | F13 · the relay address belongs to nobody and the gate asserts it | ⛔ | **CLOSED (gate)** · PO must claim | four invitations + both shells |
| **AU-14** | F14 · F22 has never executed | MED | **OPEN** | PO |
| **AU-15** | F15 · six low-severity observations | LOW | **OPEN** | various |

### 23.3 · The general statement behind AU-2/3/4/9

ADR 006 cuts the class in two and every face falls on one side:

- **A question about the PRESENT — the register answers it exactly.** `foldAuthorized` is handed
  `_log.ops()`, which is not "the ops" but "the ops no checkpoint has absorbed yet". An absorbed op
  is not gone: a register cell is `{value, stamp, author, op}`, which is `f`, `ts`, `act`, `id`, and
  `devOf(stamp)` matched against the author's own `dev.*` record is `dev`. So the fold's input is
  `absorbed(registers) ∪ lines`, computed once from a **table** — `ABSORBED_ROWS`, two rows,
  `member:`·`_alive` and `fnote|fbar:`·`pub.(level|coEdit|alive)`. **Content is not an
  admissibility input**, which is the sentence that keeps the redaction boundary intact.
- **A question about HISTORY — the op belongs outside compaction.** The admin *chain* is a causal
  sequence and an LWW cell keeps only its head, so `space:<id>` → `admin` can certify a transfer and
  can never certify the link it supersedes. `_persistOps` therefore retains the chain lines across
  the horizon. Bound: one line per transfer plus genesis.

**Grouping by `cell.op` rather than per cell is load-bearing.** `publishSharedEntry` writes
`pub.level`, `pub.coEdit` and `pub.alive` in one op; three bodies under one opId is what
`foldAuthorized` Pass A reports as envelope splicing (ADR 002 §5.1), resolves by canonical max, and
two of the three fields are discarded — the grant lost exactly as before the repair. Mutant M-E13-8
measures it.

### 23.4 · Two findings the fix cycle produced that the audit did not have

**(a) The severity of AU-2/3/4 must be re-priced, in the direction nobody expected.** AUDIT §5 item
5 predicted *"a real relaunch loses more, never less."* Measured on the shipped binary across five
acceptance runs: every launch of every Mac reads `lines == ops`, horizon covering 0–5 of them,
checkpoint holding 2 registers. **The app re-pulls from the relay on every launch and the lines come
back as lines**, so its fold never reaches the absorbed state; `_outboxHorizonCap` keeps the horizon
low while anything is unacknowledged. The fleet rig's `quitAndOpen` persists a fully converged,
fully acknowledged log with **no relay in between** — the *stricter* environment. So AU-2/3/4 were
real and terminal for a Mac that quits and opens with nothing to re-pull (offline, a pruned relay, a
peer whose `since` cursor is past the op) and were never reachable in the acceptance topology.
**AU-6 is the exception and always was**: `e13-relaunch-sweep.test.js` classifies it ALWAYS-WRONG —
wrong with *and* without the relaunch — and it reproduced on the shipped binary every run.

**(b) Two gates were defending the erosion they exist to catch.** `network-scope.test.js` §5e and
`datenschutz.dom.js` §3a both *required* the sentence „Von allein sendet dieses Programm nichts",
which `boot()`'s `startDailyTimer()` makes false. A gate that pins a false sentence is worse than no
gate: it converts a correction into a regression. Both now require the harder property — the screen
must name the automatic originator **and** the consent it is gated on, in both languages. The same
shape appeared a third time in `headless-shell.test.js:326`, which required the literal
`SYNC_ORIGIN_BUILTIN = ""` and so **actively forbade the correct release act**. Measured: with the
old assertion restored and a real origin pinned, `npm test` reads 22 · 1.

### 23.5 · The coverage hole, closed and self-maintaining

```
tests/fleet/e9-attack-coedit.test.js    coEdit  32 · relaunch  10     (was 17 · 0)
tests/fleet/e13-relaunch-sweep.test.js  coEdit  20 · relaunch  97     (new)
tests/fleet/e13-compaction.test.js      every row relaunches except four named controls
scripts/shell-family-e2e.mjs            27 → 35 launches, six new phases
```

`e13-relaunch-sweep.test.js` enumerates 16 fold inputs as data, runs every probe **twice over two
freshly built circles — once with a quit-and-open, once without** — and classifies each pair
HOLDS / ABSORBED / ALWAYS-WRONG / RIG-BROKEN. Separating ABSORBED from ALWAYS-WRONG is what
produced 23.4(a). Its §4a re-measures the co-edit/relaunch census on every run and fails if any
family gesture is driven in `tests/fleet/` by nothing that relaunches, so the hole cannot silently
reopen.

### 23.6 · The redaction boundary, asked a ninth time

The repair puts a **new producer of ops** inside the boundary, deciding who is admitted and what is
shown. `tests/attack/e13-absorbed-boundary.test.js` (7 rows) asks the bar of that producer
specifically: the vocabulary is a two-row table anchored at both ends, not a filter; on a real
converged circle after a real quit-and-open no rebuilt op carries a field outside it, nor the shared
entry's text nor any word of it; and a Privat entry has **nothing to reconstruct**, asserted at the
source rather than at the output. Attack suite: **977 · 0**.

⚠ **One mutant survived the first draft and the reason is the finding.** Copying the whole register
cell instead of its value leaks no entry text — the four admissible cells hold booleans and one
short enum — but it leaks `cell.stamp`, whose last sixteen characters **are** the authoring device
(`core/stamp.js#devOf`). Principle 9 is enforced by the absence of a distinguishing byte; that
would have added one. §2b now asserts the value's *type* as well as its name. **A mutant that
survives is a missing row.**

### 23.7 · Owed, and not closed here

- A shipped-app relaunch with the relay **unreachable or pruned**. That is the one measurement that
  would settle 23.4(a)'s offline case end to end on the binary.
- `src-tauri/` has **still never been compiled** — `cargo` is absent. `lib.rs` is held to
  `main.swift` by a refusal-vocabulary row and by source mirroring.
- `oplog.js#compact()` at `TAIL_COMPACT_AT` (5 000 lines) drops the retained admin link from the
  log and `bodiesObject()` then lists its fingerprint, so `load()` would answer a re-appended copy
  `duplicate`. A circle that reaches 5 000 tail lines loses a *transferred* seat again.
- **A log already compacted by an older build** keeps R-1b for a transferred seat. Retention
  prevents the loss; it cannot repair one. AU-3, AU-4 and AU-2 *are* repaired retroactively,
  because those are reconstructions.
- F12's remaining doc drift, F14, and all six F15 items.

---

## 24. LZP-1009's SECOND PASS — a solo Mac can send, and somebody can read it (2026-09-05)

The channel was complete and unusable. Two facts, both measured before anything was written:

- a **solo** Mac could not send — `setFeedbackPort` had one caller and it lived behind the family
  door — and the report that matters most is *"I cannot join"*, which only a solo person can write;
- the deployed relay bound **no sink**, so even a family Mac got an honest `501 not_implemented`.
  Probed on the live host on 2026-09-05, and it still does.

The PO ruled on both (2026-09-04/05): **a solo Mac may send**; **the admin view is a screen inside
the app, on his Mac only**; **a quiet 5 px dot on ⚙**; **90-day auto-expiry plus manual delete**.
`DESIGN-DECISIONS.md` carries them as *D10 EXTENDED* and *D12*.

### 24.1 · The nine reversals, and why none of them is a diff

Every pinned row below asserted something the ruling made false. Each is **inverted in place with
its reasoning and the verbatim text it replaces**, never deleted.

| row | said | says now |
|---|---|---|
| `network-scope.test.js` §2 | ONE dynamic door out of the boot graph | **TWO, each named** — plus a new row: the second reaches `net.js` and **not** `crypto/`, `sync/` or `family/`, with the five-module graph behind it enumerated |
| `release-gate.test.js` §4b | *"solo mode makes zero requests BECAUSE the switch is first"* | `originAt < switchAt` — **the stated mechanism was wrong**: both checks are pure, and the order was load-bearing for the REASON STRING, not for the packet. Now: the switch is read after the rebuild and before any request object exists |
| `e10-network-scope.test.js` §2c | ONE receiving route, write-only | **four routes, and exactly TWO mutating verbs** — the write and the delete. A count would pass over a fifth route with the wrong shape; **a reply route is P10's regression**, and that is what this row now guards |
| `e10-network-scope.test.js` §2d | the ONE new path | **three**, plus a depth bound so a report id cannot become a path prefix |
| `datenschutz-claims.test.js` §1 | `ROUTE_NAMES.length === 24` | **27** — and the row calls itself *a REVIEW TRIGGER*, so it is **answered**, not bumped: the three new verbs carry no `spaceParam`, are not `SPACE_SCOPED`, and are IP-keyed, so they widen the enum without widening what it says about a family |
| `e13-datenschutz.dom.js` `PINNED.routeNames` | 24 · „vierundzwanzig" · "twenty-four" | **27 · „siebenundzwanzig" · "twenty-seven"**, re-measured with the command in the comment |
| `e13-datenschutz.dom.js` §1a/§1b/§1c | nothing bound the port; „Senden" is dead; the copy says „braucht einen Familienkreis … „Senden" ist abgeschaltet" | the solo Mac **binds**, „Senden" **lives**, and the previous fix's own sentence is now a **mutant that must die**. §1a also counts the requests: **0** before the press |
| `e13-datenschutz.dom.js` §6c | `canSend() === false` after two opens | the row's subject was always sheet **idempotence**; the sender's existence is §1a's measurement |
| `privacy-e5-endpoint.test.js` | nine addressable paths | **eleven**, and `src/js/feedback/relay.js` joins the file list — its three paths are written as literals precisely so this enumeration can see them |
| `server-metadata.md` §7.4 | *"a closed enum of 24 verbs"* | **27**, naming the three, with the ⚠ that they cannot name a member or a circle |

### 24.2 · ⚠ THREE ROWS THAT WERE GREEN OVER A FEATURE THEY COULD NOT SEE

This is **E10-1009-B** repeating, and the plan predicted all three rather than the tree finding
them afterwards. Each is TIGHTENED in the same commit:

1. **`e10-network-scope` §2a** skipped everything under `src/js/feedback/` — `if
   (f.rel.startsWith(ALLOWED_DIR)) continue;` — so the subsystem could have grown a transport and
   this row would never have looked. It now asserts, over that directory: **no module may import
   `net.js` statically** (a static edge is on every solo launch's evaluation path, because
   `settings.js` imports the subsystem statically), and **exactly one may import it dynamically**.
2. **`e10-network-scope` §2b** — *"no bridge command can send a report"* — was already green and
   false: `sync_request` can send one and **its name did not change**, so a name-regex sees
   nothing. Replaced with the property a name cannot encode: **with sync off, exactly one
   (method, path) pair is reachable**, read off *both* shells — the gate is a conjunction, the
   carve-out is `==` on the percent-encoded path with no query, and `SYNC_SOLO_PATH` is one
   constant with one value in Swift and Rust.
3. **`network-scope` §5b** scanned `/\.send\(/`. The operator's reader calls
   `transport.request(`, three times, for three routes — **a whole new transport, invisible**. It
   now matches every dispatcher spelling over the **solo-reachable tree**, enumerates the three
   call sites by file and line, and classifies a dispatcher handed on under a property name as
   `handed-on` rather than as a trigger. Measured: **0 automatic · 1 human · 4 handed-on**.

⚠ **A mutant corrected the classifier, not a review.** The first draft read
`tick: () => setInterval(() => dispatch(…), 1000)` as `handed-on` — it saw the property binding and
not the timer between it and the call. §5d now plants that exact shape and requires it to be
`automatic`.

### 24.3 · The Datenschutz copy — four sentences that had stopped being true, and a sixth inference

- **`soloBody`** said „Senden" is off without a Familienkreis. Now: it works, you see word for word
  what goes, nothing goes without the press, and it points at the retention paragraph.
- **`retentionBody`** said *„Ehrlich: unbefristet. Es gibt keine automatische Löschung."* — a direct
  contradiction of `Report.expiresAt`. **The unbounded claim is SCOPED, not softened**: the rate
  rows and the change rows really are unbounded, and that is the harsher half. The one exception
  carries its number: **90 Tage**.
- **`feedbackBody`** described a report in transit and said nothing about it at rest. It is at rest
  for 90 days and now says so.
- **`infer4`**'s route numeral, 24 → 27.
- **`infer6` — NEW, and it is a genuinely new fact.** A **signed** report's `Report.devicePub` is
  byte-identical to `Device.sigPubRaw` — it has to be, or the signature could not be verified — so
  a retained report is **joinable to a circle**: one equality join names the member, her circle and
  her household, and `Report.prose` is plaintext. **Not defended against; the operator is the
  intended reader.** The bound is stated with it: an unsigned report — every report a solo Mac
  sends — carries no key at all. `server-metadata.md` §7.6, `datenschutz-claims.test.js` §8,
  `e13-datenschutz.dom.js` §5a.

### 24.4 · A defect nothing was watching for: two requests for one open of ⚙

Opening Einstellungen made **two** identical `GET /api/v1/feedback` calls. The loop is short and
every step is reasonable:

```
build → buildReportsSection → loadReports → GET → noteReportsKnown → store.setSettings
     → the store notifies → main.js:262 onChange → rebuildSettings() → api.rebuild()
     → buildReportsSection → loadReports → GET
```

It terminated **only because the second write of `reportsKnown` was value-identical and the store
did not notify again** — a coincidence of that data, not a property. A relay returning the list in
a different order, or one report arriving between the two calls, and the cycle runs again. *A
render path that writes state which triggers a render is a loop with a lucky base case, and this
one had a network request inside it.* `feedback/admin.js` §3b caches the rows for one open;
`settings.js#openSettings` clears them. **The cache is filled BEFORE the prefs are written**,
because writing them is what triggers the rebuild.

### 24.5 · The redaction boundary, an ELEVENTH time — over the two carriers this pass adds

`tests/attack/e11-reports-payload.test.js`, **9 rows**, and it re-argues nothing the tenth round
proved. A boundary breaks at a **new carrier**, and this pass adds two:

- **the solo sender** — a different transport configuration (`anonymous: true`, no `sign`, no
  `devicePub`, `spaceKind: 'solo'`) built by a different module, from a Mac with a full board;
- **the operator's reader** — three requests that leave a Mac which HAS a board on it.

A real German fixture board (five needles, each a sentence somebody would mind), the shipped
redaction renderer, the shipped bridge, three spellings of every needle over url + method + every
header name and value + body, and the **PNG inflated with `node:zlib` and the raster grepped one
latin-1 character per byte**. Zero bytes of a Privat entry, in any spelling, in the pixels or out.
Positive controls in both directions, both non-vacuity halves.

Two properties this round found worth naming:

- **no query string on any reader request.** Not aesthetics: a query is the natural place for a
  `since=` built from something on screen, and Vercel's own request log records path **and query**
  under their terms, not ours.
- **the reader is a TERMINUS.** For the first time bytes about a report travel *toward* a Mac. What
  came back does not ride out again — not on a later request, not in a header, and not in the
  **signed bytes**, which is the subtler version of the same defect.
- and `relay.js#assertId` refuses a malformed report id **synchronously**, while the template
  literal is built, so a value that came back over the network never becomes part of a URL at all.
  `assert.throws`, not `assert.rejects`, and the distinction is the finding.

Re-run and green alongside it: `e7-leak-downgrade`, `e7-leak-observer`, `e7-leak-routes`,
`e10-outbound-payload`, `e6-attack-privat`, `e6-gate-privat` — **132 rows**.

### 24.6 · Owed, and not closed here

- **NOTHING IN THIS PASS HAS MET POSTGRES.** `U-REPORTTTL` (Prisma binds a `Date` correctly against
  `TIMESTAMP(3)`; `@@index([expiresAt])` makes the sweep a range scan) and `U-REPORTONCE`
  (`Report_pkey` surfaces P2002; `deleteMany` on an unknown id returns 0, not P2025) are ledger
  rows with **no witness**. Closed by one run of `LZP_CONTRACT_DATABASE_URL=… npm run test:server`.
- **The migration SQL is hand-written**, matched to Prisma's emission conventions and to
  `check-server-config`'s parser. `prisma migrate dev` / `--deep` L2 has never confirmed
  byte-for-byte drift-freedom. Run L2 with `SHADOW_DATABASE_URL` before the deploy.
- **`LZP_REPORTS_ADMIN_PUB` is not set on the live relay**, and the live relay still runs the
  previous deploy: `GET /api/v1/feedback` answers **405**, `POST` answers **501**. Everything in
  §24 was driven against `node server/dev-server.mjs` over real HTTP. `U-ADMINENV` — that Vercel
  actually hands the function the variable — is closed by one signed `GET` returning 200 against
  the deployed function and by nothing available here.
- **`tests/server/attack-relay-read.test.js:332-336` is a SECOND, unnamed pin of the same claim**
  `blindness.test.js:215` carries. It filters `PLAINTEXT_STRINGS` on `/leak|palette/i` and asserts
  `['Member.colorRef']` under the comment *"It is the ONLY user-chosen String"*. It is green only
  because the words "leak" and "palette" were kept out of the `Report.prose` justification — **the
  sentence it asserts is false while the test passes**, which is precisely the §4.5 shape. Its
  owner should invert it to `['Member.colorRef', 'Report.prose']` and widen the regex to something
  that actually catches content-bearing rows.
- **`LZPADMIN` has never gone through the macOS shell.** The header NAME is unchanged and the
  four-name allowlist passes it; no request has been driven through `syncPreflight` with it.
- **The 90-day sweep across a real clock advance.** Read-side expiry is proved with a 91-day-old
  row aged on disk and re-read through HTTP; a long-running sweep is not.
- `tests/tier2/shell-ssrf.dom.js:127` still passes but its message — *"the switch is not the first
  check"* — is now misleading; and `scripts/shell-ssrf.mjs`'s `carveout` probe's permanent home is
  a §1b in that file. Both are its owner's.
- `docs/v2/adr/003-sync-protocol.md` §7 and `SHELL-VERIFICATION.md`'s SSRF table still describe
  gate 3's old check order.
