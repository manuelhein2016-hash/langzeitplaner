# v2 — the findings register

**One place to look.** Every defect, gap and deliberate divergence found by any audit of WP-1
(the pure core), WP-2 (the v1 characterization suite) and WP-3 (the retrofit) lives here, with its
owner and its status. Nothing is "known but written down somewhere else".

**Opened:** 2026-08-27, folding in `judge:adversary3` and `judge:conformance` (both run read-only
against `c0306ac`), the four WP-3 adversary findings already in STATUS, and the three deferred
items from STATUS §5.

**Status vocabulary**

| status | means |
|---|---|
| **open** | a real defect; someone must change code. The owner column says who. |
| **accepted** | measured, understood, and deliberately left as it is. Not a bug. Do not "fix". |
| **decision** | a PO must choose before an engineer can act. See §4. |
| **fixed** | closed, with the evidence that closed it. |

**Reading the evidence.** Several rows are pinned by tests under `tests/attack/` that are green
**because the defect exists** — the directory's convention. **If one of those goes red, the gap was
closed: invert the row, do not repair the test.**

---

## 1. By severity — the count

| severity | open | accepted | decision | fixed | total |
|---|---|---|---|---|---|
| **CRITICAL** | 1 | — | — | — | **1** |
| **HIGH** | 3 | — | 1 | — | **4** |
| **MEDIUM** | 8 | — | — | — | **8** |
| **LOW** | 4 | 1 | 2 | — | **7** |
| **INFO / gap** | 2 | 1 | — | 1 | **4** |
| | **18** | **2** | **3** | **1** | **24** |

Nothing in this register breaks the app that ships today. Read §3 before starting WP-8: **eight of
the eighteen open rows go from latent to live the moment a second device exists.**

---

## 2. The register

`aka` is the id the finding carries in the audit report it came from, so both reports stay
navigable. Line numbers are against `c0306ac`.

### CRITICAL

| id | aka | one line | file:line | owner | status |
|---|---|---|---|---|---|
| **A3-C1** | C-1 | One well-formed line in `ops.jsonl` discards `board.json` entirely — 0 notes, 0 bars, 0 categories, **no warning** — and the first autosave commits the empty board to disk, to `snapshots.json`, and to the next migration | `src/js/store.js:465-478` | **WP-8** | open |

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

### HIGH

| id | aka | one line | file:line | owner | status |
|---|---|---|---|---|---|
| **A3-H1** | H-1 | A `checkpoint.json` that **parses but has no `v`** throws out of `init()` and the app never boots — white screen, no recovery path, intact `board.json` sitting right there | `src/js/store.js:476` → `src/js/core/oplog.js:846` → `src/js/core/registers.js:711` | **WP-3** | open |
| **A3-H2** | H-2 | The migration door silently drops five entry shapes v1 keeps, and the loss is committed to `board.json` on the first autosave | `src/js/store.js:487-493`, `src/js/core/migrate1to2.js`, `src/js/core/materialize.js` (`projectable`) | **WP-3** | **decision** — §4.2 |
| **A3-H3** | H-3 | `applyRemote([null, goodOp])` throws a bare `TypeError` and **discards the whole batch**, including the well-formed op | `src/js/store.js:698-703` | **WP-3** | open |
| **A3-H4** | H-4 | Two Macs over one board **cannot converge at all**: stamps and opIds agree exactly as ADR 001 §8.1 promises, but `_me` is ephemeral per process, so each refuses the other's ops with `notMyAct` | `src/js/store.js:415-425`, `src/js/core/authz.js:490-494` | **WP-6** → WP-8 | open |

- **A3-H1** — the asymmetry is the point: `storage.loadCheckpoint()` catches a JSON parse error and
  returns `null` (safe — R3-36 pins that an unparsable checkpoint lets the board through
  untouched), while one that *parses* reaches `deserializeRegisters` and throws
  `RegisterError: unknown format version undefined`. **Unparsable is safe; parsable-but-wrong is
  fatal.** There is no try/catch around `_log.load`, so `ready` stays `false`.
  → `tests/attack/round3-persistence.test.js` R3-35.
- **A3-H2** — the five: a note whose date is not ISO (`4.3.2026`), a note with no date, a note with
  no id, a bar with no `endDate`, a scratchpad holding a number. The register usually still exists,
  but **in solo mode `board.json` IS the checkpoint**, so the next launch re-migrates the file and
  the register goes with it; `snapshots.json` cannot help (it stores the emptied `_persisted`).
  Principle 6 fails at the retrofit seam. Two aggravations: **a repeating note stops repeating** —
  `repeatsYearly: 'yes'` is truthy in v1 so the birthday repeats, is not a boolean so v2 drops the
  key entirely, and `find.js`/`layout.js` then read it as falsy (same shape for `visible: 'ja'` on a
  category); and **`store.warnings` has no consumer** (F-8), so the layer knows exactly what it lost
  and has no way to say so. → `tests/attack/round3-doors.test.js` R3-26/27/28.
- **A3-H3** — one missing guard, not a design gap. The refusal set is built defensively
  (`verdict.rejected.map((o) => o && o.id)`) and `op.id` is then read **unguarded** in the very next
  loop. Every *other* malformed shape (`{}`, `'string'`, `42`, `[]`, `true`) is refused with a
  warning and no throw. → R3-23 / R3-24.
- **A3-H4** — `store.js`'s own header claims "two Macs opening the same board agree byte for byte".
  Half true: the **stamps** agree, the **authors** do not, so `serializeRegisters()` is not
  byte-identical and the header's claim is false as stated. Worse, `foldAuthorized` degrades ADR 001
  §4.0's personal-space device check to `act === me` when `myDevices` is absent, so nothing merges.
  **Any fleet test that mints its ops with the receiving store's own `_me` is a false green.**
  ADR 002 §2.2's durable identity must land first. → R3-40/41.

### MEDIUM

| id | aka | one line | file:line | owner | status |
|---|---|---|---|---|---|
| **F-5** | F-5 | `checkpoint.json` is deserialised straight into the register map with **no admissibility fold at all** — it can install `visibility:'geteilt'`, `coEdit:true` and a foreign author on an entry the user never shared | `src/js/core/oplog.js:846`, `src/js/store.js:476` | **WP-8** | open |
| **F-6** | F-6 | A remote op whose device attestation has not arrived yet is **rejected, not parked**, then dropped without being appended — silent data loss on first contact and on every partial pull | `src/js/store.js:699-703`, `src/js/core/authz.js:671` | **WP-8** | open |
| **F-7** | F-7 · M-2 | A remote `pref.set` is admitted (ADR 001 §3.3: `local` is "never synced"), `applyRemote` has **no space filter**, and the registers and `state.settings` then disagree about row height and about **which Feiertage layer is drawn** | `src/js/store.js:542-566`, `:690-708`, `src/js/core/authz.js:672-675` | **WP-8** | open |
| **F-2** | F-2 · M-1 | The `apply()` door **throws** on 27 of 36 hostile field values where the `mutate()` door truncates-and-warns — in **two** error classes, `OpError` and `EntityKeyError` | `src/js/core/ops.js` (`MUTATIONS`, `makeOp`), `src/js/core/entities.js`, `src/js/store.js:206` vs `:672` | **WP-8** | open |
| **A3-M3** | M-3 | A **nested** `mutate()` spends one ⌘Z on two actions, and the R5 shadow guard then throws *after* the ops are appended and *before* `schedulePersist()`/`emit()` — board changed, unsaved, un-redrawn | `src/js/store.js:642-653`, `:756-766` | **WP-4** | open |
| **A3-M4** | M-4 | A throwing `mutate()` callback's half-edit is adopted into the log **permanently** by the *next* action, with no undo step that can reach it | `src/js/store.js:586-594` | **WP-4** | open |
| **A3-M5** | M-5 | `_persistOps()` documents itself as "append the tail, then checkpoint" and **never calls `appendOps`**; `truncateOps(0)` is guarded `keepFromLine > 0` so it **keeps every line** | `src/js/store.js:830-834`, `src/js/storage.js:192-207`, `shell-macos/main.swift:785`, `src-tauri/src/lib.rs:134` | **WP-8** | open |
| **F-10** | Part C | `foldAuthorized` returns `memberOfDevice(deviceId)` and **discards the decoded attestation payload**, so `openOp` cannot perform ADR 002 §5.2's checks — **the concrete WP-6 unblocker** | `src/js/core/authz.js:650-663`, `:853-854` | **WP-6** | open |

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
  → R3-39.

### LOW

| id | aka | one line | file:line | owner | status |
|---|---|---|---|---|---|
| **F-1** | F-1 · R3-1 | `board.json` stops being a fixed point across a restart once two scratchpads exist — the materializer's key sort is discarded one layer up | `src/js/store.js:368` (`reconcileMap`) | **PO** | **decision** — §4.1 |
| **A3-L1** | R3-2 | The same non-fixed-point one level down: `reconcileList` rebuilds array *order* but preserves an entry object's identity and therefore its **key order** | `src/js/store.js` (`reconcileList`) | **WP-4** | open |
| **A3-L2** | R3-6 | A `setSettings()` makes the next transaction emit a **duplicate** `pref.set` at a fresh stamp, outside any group — one `addCategory` emits `['pref.set','cat.set']` | `src/js/store.js` (`_pref`, `_adopt`) | **WP-4** | open |
| **F-8** | F-8 | `store.warnings`, `plan.lossy`, `plan.warnings` and `plan.reshares` are **written and read by nothing** — and `replaceAll()` *replaces* the warnings array rather than concatenating | `src/js/store.js:471`, `:802` | **WP-10** | open |
| **F-3** | F-3 | `store.undoStack.length = 0` also clears redo and `.push()` is a silent no-op — an undocumented divergence from the v1 surface | `src/js/store.js` (`_stacks`) | **WP-3** (doc) | open |
| **A3-M1a** | M-1 | Three hostile values are silently **accepted**: `text: null` mints an unrenderable note, `categoryId: null` is quietly repaired by materialize, `lastCategoryId: 9` writes a number into a pref register | `src/js/core/ops.js` | **PO** | **decision** — §4.3 |
| **F-4** | F-4 | ATT-5: deleting an already-deleted entry records 1 undo step where v1 recorded 2 | `src/js/core/undo.js` | — | **accepted** — strictly better |

- **F-8** is against **principle 6** and story 11.6. `migrate1to2.js` builds `MigrationLossyError`
  precisely so that "a migration that loses something may not complete silently", and `store.js:471`
  passes `acceptLossy: true` and assigns the warnings to a field no UI consumes:
  `grep -rn warnings src/js/*.js` outside `store.js` has **no hits**. `replace.js:388` says "the
  store must be able to refuse and tell the user before the board it is replacing is gone";
  `store.js:802` reads `plan.warnings` and ignores `plan.lossy` entirely. This is the *carrier* for
  A3-H2's message (`note "n": field "date" = "4.3.2026" is not representable in v2 and was DROPPED`)
  and for F-6's refusals.
- **F-3** belongs in `docs/v2/contracts/store.contract.js` §2.2 as an explicit divergence. No
  shipping caller reaches it.

### INFO, gaps and accepted divergences

| id | aka | one line | file:line | owner | status |
|---|---|---|---|---|---|
| **G-1** | STATUS §5 | **Security-relevant.** A bare `dev.*` attestation makes its author a `currentMember` — an outsider can appear in the Kreis unassisted, and `currentMembers` gates foreign-entry visibility (20.2) | `src/js/core/authz.js` | **WP-9** | open |
| **G-2** | STATUS §5 | `replaceAllOps()` returns ops alone by contract, so the retraction carrier exists only on the *plan*; the store had to be made to call `planReplaceAll` and hand `plan.retractions` to the publisher | `src/js/store.js:805` | WP-3 | **fixed** |
| **F-9** | F-9 | `src/js/platform/updater.js` (E1, uncommitted at audit time) is **unscanned**: `src/js/platform/` is not in `PURE_DIRS`, `tests/tier1/network-scope.test.js` does not exist, and `tauri.conf.json`'s `csp` does not yet name an update host | `src/js/platform/updater.js`, `tests/helpers/purity.js:28`, `src-tauri/tauri.conf.json` | **E1** | open |
| **A-1** | STATUS §5 | An import resurrects a tombstone at a fresh stamp. That is what restore *means* (11.5), and the fresh stamp is load-bearing for paired-device convergence (ADR 001 §8.5) | `src/js/core/replace.js` | — | **accepted** |

- **G-1 cannot be closed in WP-1** — membership has to be *conferred* by the invite/redeem flow
  before `authz.js` can refuse to infer it.
  → `tests/attack/convergence-authz.test.js:201`, `tests/attack/ownership-authz-admin.test.js`.
- **G-2 is closed and verified**, not merely claimed: `judge:conformance` A.3 (story 16.5) read
  `store.js:805` and confirmed `plan.retractions` is computed and handed to `publisher.retract`; the
  publisher is still `nullPublisher`, which is correct until WP-10.
  `tests/attack/recheck-att40-replace.test.js:220` stays as the pin.
- **F-9**: nothing to do in the audit that found it; flagged so **21.5 is re-verified after E1
  lands**. ADR 003 §7 gate 1 was marked **owed** on 2026-08-27 for the same reason.

---

## 3. What must be fixed before WP-8, in order

WP-8 is the first package with a second device, and it turns eight of these rows from latent into
live. In this order:

1. **F-10** — `attestationOf` on `AuthzResult`. Blocks WP-6, which blocks WP-8. ~10 lines.
2. **A3-H4** — durable device identity (ADR 002 §2.2). Until it lands, no fleet test means anything.
3. **A3-C1** + **F-5** — the checkpoint must carry the identity it was folded from and must pass the
   same admissibility gate `applyRemote` uses. These are the two rows where a file on disk becomes
   authoritative without being checked.
4. **F-6** — the `ATTESTATION` park reason, or retain refused ops. First contact loses data without it.
5. **A3-H3**, **F-7**, **F-2** — the `applyRemote` seam: guard `null`, drop `local`-space ops,
   decide truncate-vs-decline for hostile values.
6. **A3-M5** — `_persistOps` must append, and `truncateOps` must be given the tail length.

---

## 4. Needs a decision — a PO must choose, not an engineer

Three items. Each states the trade-off in two sentences.

### 4.1 F-1 — does `board.json` go back to being a fixed point?

Fixing `reconcileMap` to rebuild the scratchpad map in projection key order restores ADR 001 §5
step 5 (whose stated purpose is byte-stable comparisons), restores v1's fixed-point property, and
removes the embarrassment of a green unit test asserting the sort at the layer where it holds while
the shipped file does not have it. **The cost is that it atomically rewrites `board.json` with
different bytes for every existing user on their next save** — content identical, nothing on screen
moves, but a file that had been stable changes, which is exactly the class of surprise a background
update should not produce.
*(Story 11.4 is **not** violated either way — the file is human-readable, v1-shaped,
`schemaVersion: 1`, zero v2 leakage. ADR 001 §5 step 5 **is** violated today.)*

### 4.2 A3-H2 — coerce, quarantine, or refuse, when v2's type table is stricter than v1's

Five entry shapes that v1 opens and keeps are dropped by v2's `FIELDS`, and the drop is committed to
`board.json` on the first autosave, so the user's file loses them permanently; the most user-visible
case is `repeatsYearly: 'yes'`, where **a birthday silently stops repeating**. The choice is between
**coercing** the v1 values v2 can obviously read (truthy string → `true`, `4.3.2026` → `2026-03-04`),
**quarantining** the unrepresentable entries into `_v2.quarantine` so a later build can rescue them,
and **refusing to migrate** with a visible message — the last is the only option that never loses
data and the only one that can stop the user in their tracks on upgrade day.

### 4.3 A3-M1a — is a permissive door better than a throwing one?

The same enumeration that found 27 throwing inputs (F-2) found three that are silently accepted:
`createNoteInline` with `text: null` mints a note that can never render; `recategoriseNote` with
`categoryId: null` is accepted and then quietly repaired to the first category by materialize
step 7; `deleteCategory` with `lastCategoryId: 9` writes a number into a pref register. **Either the
door validates and declines uniformly, or it accepts and the projection repairs uniformly — what it
must not do is throw on a German date and shrug at a `null` note.** Picking one decides what WP-8's
remote path does with a hostile peer, which is why it is worth a deliberate answer now.

---

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
6. **`npm run test:dom` was not re-run** by either audit, and the DOM suite has not been re-run since
   the E1 agent's changes landed in the tree either.
