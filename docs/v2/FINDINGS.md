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
| **CRITICAL** | — | — | — | 2 | **2** |
| **HIGH** | 3 | — | 1 | 4 | **8** |
| **MEDIUM** | 8 | — | 1 | 5 | **14** |
| **LOW** | 4 | 2 | 1 | 3 | **10** |
| **INFO / gap** | 2 | 2 | — | 1 | **5** |
| | **17** | **4** | **3** | **15** | **39** |

Nothing in this register breaks the app that ships today. Read §3 before starting WP-8: **six of
the seventeen open rows go from latent to live the moment a second device exists.**

**Both CRITICALs are closed** — A3-C1 and the R7 branch that re-opened it (R5-3) — and so are the
four HIGHs that a file on disk could reach, including A3-M5, which round 5 promoted out of MEDIUM
because it was mis-filed as latent. The three HIGHs that remain are one convergence blocker
(A3-H4) and two rows found *while proving other fixes* (I-1, I-2). The HIGH **decision** is I-3,
which round 5 escalated: §4.5.

**What moved between severities, and why** — recorded because a severity that changes silently is
worth as little as a finding that is never written down:

| row | was | is | what changed the reading |
|---|---|---|---|
| **A3-M5** | MEDIUM, open, "latent — nothing appends, so nothing grows" | **HIGH, fixed** | It was never latent. R5-4 measured it live on every launch after the first: no op the user made was written to the log again, ever. |
| **I-3** | MEDIUM, open | **HIGH, decision (§4.5)** | R5-7 turned a lookup-shadowing trick into a permanent remote mute of a named device, self-authorizing and irrevocable. |
| **A3-C1** | CRITICAL, fixed | **CRITICAL, fixed** (unchanged) — but see **R5-3** | The rule held; the *implementation* grew a second door into it. Recorded as its own row rather than by quietly re-opening the old one. |

**Suites at the close of the round-5 integration pass**, all four green:
`npm test` **1374**/0 · `npm run test:property` **51**/0 · `npm run test:attack` **512**/0 ·
`npm run test:dom` 15 files, tier 2 PASS.

*(For the record, the counts at the close of the first fix pass were 31 rows and
`npm test` 1360 · `test:attack` 340.)*

---

## 2. The register

`aka` is the id the finding carries in the audit report it came from, so both reports stay
navigable. Line numbers are against `c0306ac`.

### CRITICAL

| id | aka | one line | file:line | owner | status |
|---|---|---|---|---|---|
| **A3-C1** | C-1 | One well-formed line in `ops.jsonl` discards `board.json` entirely — 0 notes, 0 bars, 0 categories, **no warning** — and the first autosave commits the empty board to disk, to `snapshots.json`, and to the next migration | `src/js/store.js:465-478` | **WP-8** | **fixed** (third attempt — ADR 006; see **R5-3**) |
| **R5-3** | R5-3a/b/c | A3-C1 **reachable again**, behind one corrupted byte: an unreadable `board.json` fell into R7's recovery branch, which performs **no lineage check of any kind**, so a planted log became the board — and `persistNow()` then committed it over the file that was merely unparseable | `src/js/store.js` (`init`, `_recoverFromLog`), `src/js/storage.js` (`loadBoardText`) | **WP-3** | **fixed** |

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
| **I-3** | new · R5-7 | **ESCALATED FROM MEDIUM.** A contested `deviceShort` is resolved by **refusing it**, and the short is trivially discoverable — so one `member.set` filed under a peer's short makes every sealed envelope from that Mac park **for ever** | `src/js/core/authz.js` (`attestationOf`, `shortCollisions`) | **PO** → WP-6 | **decision** — §4.5 |

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
| **I-3** | new | *(escalated to **HIGH** and moved to §4.5 — round 5 (R5-7) turned this into a permanent remote mute of any named device, self-authorizing and irrevocable.)* | | | **decision** |
| **R5-11** | R5-11 | An **unreadable bar edge** is dropped, and a dropped edge is anchored to the other end — so a bar v1 painted **nowhere** is painted by v2 across every column to the horizon, with chevrons, taking a lane from bars that are real | `src/js/core/migrate1to2.js`, `src/js/core/replace.js`, `src/js/core/entities.js` | **WP-3** | **fixed** (narrowed — residual §4.6) |
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

## 3. What must be fixed before WP-8, in order

WP-8 is the first package with a second device, and it turns seven of these rows from latent into
live. **Steps 1, 3-a and 5-a of the original list are done.** What is left, in order:

1. ~~**F-10** — `attestationOf` on `AuthzResult`.~~ **DONE.** WP-6 is unblocked at this seam.
2. **A3-H4** — durable device identity (ADR 002 §2.2). **Now the first item.** Until it lands, no
   fleet test means anything, and the three things `authz.js` needs from it are listed on the row.
3. **F-5** — the checkpoint must pass the same admissibility gate `applyRemote` uses.
   ~~**A3-C1** — the checkpoint must carry the identity it was folded from.~~ **DONE**, and F-5 is
   now the *only* input that becomes authoritative without being checked. **Read A3-C1's WP-8 note
   before touching `_opsPersisted`.**
4. **F-6** — the `ATTESTATION` park reason, or retain refused ops. First contact loses data without it.
5. **F-7**, **F-2** — the `applyRemote` seam: drop `local`-space ops, and make the throw/accept
   rule one rule. ~~**A3-H3** — guard `null`.~~ **DONE.**
6. ~~**A3-M5** — `_persistOps` must append, and `truncateOps` must be given the tail length.~~
   **DONE**, and it was not the small item this list made it look like — see its HIGH row. Two
   things follow from it that WP-8 owns: the outbox in `ops.jsonl` now genuinely exists and has a
   producer, and **ADR 001 §7.2's 30-day debuggability tail is still not implemented** (the
   compaction is total). If WP-8 needs the tail for anything but bounding the file, say so before
   building on it.
7. **I-3** — **now a decision, not an engineering task: §4.5.** WP-6's owed P2 check was the
   planned fix and round 5 proved it does not close the hole, because `sigPubRaw` is a public key
   travelling in the victim's own register. Do not start this one by writing code.
8. **R5-5b** — folding an adopted checkpoint through `applyRemote`'s gate. This is **F-5** seen
   from the authority rule's side, and closing F-5 closes both. ADR 006 §8.1's corollary comes
   with it: once a space exists, the persisted board is the FULL projection.
9. **R5-2g** — a Time-Machine restore of a pre-lineage `board.json` still quarantines a current
   log. Low frequency, high consequence, and the fix is not obvious: the restored board carries no
   `_v2`, so there is nothing to compare, and the honest options are the same three the ADR
   rejected for A3-C1. Decide it deliberately rather than at 3 a.m.

**Not on the WP-8 path but on the shipping one:** **I-1** and **I-2** are reachable today, by any
user with a hand-edited or third-party `board.json`, with no second device anywhere. I-1 can lose
a board; I-2 shows a white screen. Neither waits for WP-8. **R5-3's whole class is in the same
category** and is closed, which is why it was worth the round: it needed no second device either,
only a truncated byte.

---

## 4. Needs a decision — a PO must choose, not an engineer

**Three of the seven are answered.** The rulings of 2026-08-27 are recorded verbatim below the
trade-off that produced them, so a later reader sees what was weighed and not only what was
chosen. **Do not re-litigate 4.1–4.3.** §4.4 was opened by the first fix pass; **§4.5 and §4.6
were opened by round 5** and are the two that block real work.

| § | question | opened by | blocks |
|---|---|---|---|
| 4.4 | `GENESIS(index)` above a million entities | fix pass | nothing today |
| **4.5** | **I-3 / R5-7 — a remote denial of service on any family member's device** | round 5 | **WP-6, and WP-8 behind it** |
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

### 4.5 I-3 / R5-7 — a remote denial of service on any family member's device  · **OPEN**

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

→ `tests/attack/round5-attestation.test.js` R5-7b (one op mutes a device, permanently), R5-7c (P2
does not close it — the row exists so this cannot be re-planned), R5-7d (`authz.js:882` already
rules this trade out for the *label*, and ships it for the *short*).

### 4.6 R5-11g — a bar edge with no faithful v2 value at all  · **OPEN**

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

## 7c. The accepted-defect list — every `tests/attack/` row that is green BECAUSE a defect exists

**The rule: invert one when you close its defect, never delete it.** Swept and re-verified at the
close of the round-5 integration pass. **23 rows**, against 24 before the sweep — R3-39 was still
asserting `_persistOps()` never appends, which A3-M5's closure made false, and it is now inverted.

| row | file | the defect it pins | register row |
|---|---|---|---|
| R3-2 | `round3-seam.test.js` | `reconcileList` preserves an entry object's **key order** | A3-L1 |
| R3-3 | `round3-seam.test.js` | a remote `pref.set` moves the registers and never reaches `state.settings` | F-7 |
| R3-4 | `round3-seam.test.js` | `applyRemote` has no space filter — it admits `local`-space ops | F-7 |
| R3-5 | `round3-seam.test.js` | `setSettings`' wholesale replace disagrees about a DRAWN layer | F-7 |
| R3-6 | `round3-seam.test.js` | a `setSettings()` makes the next transaction emit a duplicate `pref.set` | A3-L2 |
| R3-10 | `round3-seam.test.js` | a throwing `mutate()` callback's half-edit is adopted by the next action | A3-M4 |
| R3-11 | `round3-seam.test.js` | a NESTED `mutate()` builds an undo step reverting two actions | A3-M3 |
| R3-11b | `round3-seam.test.js` | when `verify()` fires, `undo()` has already changed the board | A3-M3 |
| R3-20 | `round3-doors.test.js` | 27 of 36 hostile inputs THROW out of `apply()` | F-2 |
| R3-21 | `round3-doors.test.js` | the throw is not always an `OpError` — `EntityKeyError` too | F-2 |
| R3-25 | `round3-doors.test.js` | a peer's over-length value is REFUSED where the diff door truncates | F-2 |
| R3-27 | `round3-doors.test.js` | `store.warnings` is write-only — nothing in `src/` reads it | F-8 |
| R3-40 | `round3-persistence.test.js` | two Macs agree on stamps, not on **authors** | A3-H4 |
| R3-41 | `round3-persistence.test.js` | the other Mac's ops are refused `notMyAct` | A3-H4 |
| R4-11b | `round4-coercion-oracle.test.js` | `board.json` still not a fixed point after "clear a scratchpad" | F-1 residual |
| R4-16a | `round4-attestation.test.js` | the fold has **no revocation**, and write-once means no amendment | **I-3 / §4.5** |
| R4-19c | `round4-fixed-point.test.js` | a scratchpad held as `""` — v1 is a fixed point here, v2 is not | F-1 residual |
| R5-2g | `round5-authority.test.js` | a Time-Machine restore of a pre-lineage `board.json` destroys the log | R5-2g |
| R5-5b | `round5-authority.test.js` | a field `board.json` cannot express at all is invisible to both halves | R5-5b / F-5 |
| R5-7b | `round5-attestation.test.js` | ONE well-formed op mutes a named device, permanently | **I-3 / §4.5** |
| R5-7c | `round5-attestation.test.js` | **P2 does not close it** — `sigPubRaw` is public | **I-3 / §4.5** |
| R5-7d | `round5-attestation.test.js` | `authz.js:882` rules this trade out for the LABEL and ships it for the SHORT | **I-3 / §4.5** |
| R5-11g | `round5-coercion.test.js` | an edge sorting INSIDE the alphabet has no faithful v2 date | **§4.6** |

**Nine of the twenty-three trace to just three register rows** — F-2/F-7 (the `applyRemote` seam),
A3-H4 (durable identity), and I-3 (§4.5). None of them is a small independent bug; each is a
decision or a work package. That concentration is the useful reading of this table.

**Rows inverted by the round-5 integration pass:** R3-39 (`_persistOps` appends; the file header's
"`store.js` never writes `ops.jsonl`" corrected to the narrower claim R3-38 actually pins).
**Rows added:** R5-3e, R5-3f (the two unproven fixes), R5-4f (the headline sequence).

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
3b. **I-3 / R5-7** — §4.5. **This one is on the WP-6 path and the plan of record for it is wrong**:
   the owed P2 check does not close it. Read §4.5 before writing any attestation code.
3c. **R5-11g** — §4.6. Blocks nothing; it is a fidelity ceiling that should be explicit.
4. **I-1 / I-2** — both are `store.js` and both are *fixable*, but the fix is a re-ordering of
   `replaceAll` and a policy choice about what `init()` should show; neither is a guard that can be
   dropped in without deciding what the user sees. Filed rather than rushed, because the pass that
   found them was proving other fixes and had no mandate to change what an unbootable board does.

### Owed by round 5, and by this integration pass

8. **ADR 001 §7.2's compaction policy is not implemented as written.** The compaction is **total**:
   the "30-day tail for debuggability" is absent, because `truncateOps` can only drop a prefix and
   the store does not track which file line an op is on. The 2 MB-at-launch trigger is absent too.
   Recorded in ADR 006 §8.5 and in the `TAIL_COMPACT_AT` docblock; **ADR 001 §7.2's own text is
   still unamended** and should be, by whoever owns that ADR.
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

### Owned by WP-6, recorded so it is not rediscovered

5. **Remove `attestedDevices` / `memberOfDevice`** once their callers move to `attestationOf`.
   They have live callers in `ownership-authz-content.test.js` and `ownership-authz-admin.test.js`
   and are marked in `ops.contract.js` as derivable, "do not add new ones".
6. ~~**Enforce the P2 binding in `attestOpen`** — row **I-3**.~~ **DO NOT START HERE.** Round 5
   (R5-7c) proved P2 does not close I-3: `sigPubRaw` is a public key travelling in the victim's own
   register, so a squatter copies it, tells the truth, and passes. **§4.5** is the decision that has
   to come first, and only option (a) — first-claim on `(sigPubRaw, short)` — makes the binding
   worth writing.
7. **`ctx.myDevices` should be derived, not plumbed** — `attestationOf` filtered by `memberId`,
   once A3-H4 lands. That removes the `act === me` degradation A3-H4 flags as a WP-8 blocker.
