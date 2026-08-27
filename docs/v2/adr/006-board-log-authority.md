# ADR 006 — `board.json` vs. the op log: who wins

**Status:** accepted, normative · **Date:** 2026-08-27 · **Supersedes:** ADR 001 §8.4's idempotence
predicate; the two-layer consistency check added for A3-C1 (`store.js` `logBelongsToBoard`)
**Closes:** A3-C1 (third and final attempt — **and R5-3, which is A3-C1 reached through this
ADR's own R7 branch**), R4-1a/b/d, R4-2a, R4-3a, R4-4a, R4-7b, R5-2e, R5-3a/b/c/e/f,
R5-4a-f, R5-5a
**Amended 2026-08-27 (round 5):** §5.3, §6, §7 (the `clock-skew` reason and §7.1), §8.4's residual
list, §8.5 (A3-M5 closed), §10 (INV-17/18/19), §12.6. Closes R5-2e, R5-4a/b/c/d, R5-5a; R5-5b is
bounded in §8.4 and stays owed.
**Amended again 2026-08-27 (round 5 integration):** **§5.5 rewritten** — R7's precondition was
`kind !== 'ok'` where the argument only supports `kind === 'absent'`, which put A3-C1 back behind
one corrupted byte; **§5.6 is new** (`board.json` exists and cannot be read ⇒ a read-only boot over
`snapshots.json`, and a log beside it is refused, not believed); §7's reason enum gains
`board-unreadable`. Closes **R5-3a/b/c**, and R5-3e/R5-3f for the two seams the parallel fix passes
could not reach. **The rule in §1 is unchanged by all of this** — every round-5 finding was an
implementation defect, and the decision has now survived three audits without amendment.
**Owner of the build phase:** WP-3 (store) · **Read before touching:** `store.js` `init`,
`persistNow`, `_persistOps`, `_stampedCheckpoint`, `_quarantineLog`

---

## 0. The question, and why it is exactly one question

Round 4's closing note is the brief for this ADR:

> Finding 1 and finding 3 are one decision, not two. The census threshold and the drift branch are
> the same question — when `board.json` and the log disagree, who wins? Today the answer is "the
> log, on one shared key". A threshold alone does not fix finding 3, and a union/quarantine rule
> for finding 3 does not fix finding 1.

Three attempts have been made at this and two have been broken:

| attempt | the rule it shipped | the attack that killed it |
|---|---|---|
| 1 | `shouldMigrate(board, {opsLogExists})` — *does a log exist?* | **R3-31.** One well-formed line in `ops.jsonl` replaces the whole board with the fold of that line, and the first autosave commits it. |
| 2 | provenance envelope on `checkpoint.json` **+** an entity census with a zero-overlap threshold | **R4-1a.** The census quarantines only on zero overlap, so recognising **one** key is enough. `pad:<YYYY-MM>` is a *month* — every board that ever existed shares it. One guess. **R4-2a**: two boards that share one month key swap wholesale. |
| 3 | *(never shipped)* a bigger threshold | Killed below, §2, before it could be written. |

Attempts 1 and 2 are the same mistake at different resolutions: both treat `board.json` and the log
as **two rival answers to one question**, and then look for a predicate that picks the right one.
This ADR stops doing that.

---

## 1. THE DECISION

> ### `board.json` is the truth. The op log is history.
>
> **Every launch loads `board.json`. The log is then reconciled *onto* it — never the reverse.
> The log may contribute stamps, tombstones, parked ops, cursors and splice evidence. It may
> never contribute, remove, or alter one entity or one field value that `board.json` asserts.**

Seven normative rules follow. They are the whole decision; everything after §1 is argument,
mechanism and proof.

**R1 — There is no branch.** `board.json` is migrated into an op set on **every** launch, whether a
log exists or not. The predicate that used to decide "log or board" is deleted. The path that was
rare is now the only path.

**R2 — One equality decides whether history is adopted.** `board.json` and `checkpoint.json` each
carry the same opaque `lineageId`, minted once by this app. `cp.lzp.lineageId === board._v2.lineageId`
⇒ the log's history is adopted. Anything else ⇒ quarantine. No census, no threshold, no overlap, no
counter, no version comparison, no "drift".

**R3 — Adoption cannot change content.** Adoption is: load the log, project it, diff that projection
against `board.json`, and **mint ops for the difference at fresh stamps above the log's horizon**.
Where they agree, the log's stamps survive intact. Where they disagree, `board.json` wins with a new
stamp. A log the store adopts by mistake — a forged `lineageId`, a copied file — therefore costs
the user nothing, which is what makes a single blunt equality an acceptable gate where a two-layer
heuristic was not.

**R4 — The reconciliation is verified, not trusted.** After reconciling, the store asserts
`content(project(log)) ≡ content(board.json)`. If it does not hold, for any reason at all, the log
is quarantined and the board is used alone. **Every conceivable failure of the reconciler degrades
to "history lost, content kept."** This post-condition, not the equality in R2, is what makes the
rule obviously correct.

**R5 — `board.json` is written first, and that is the commit point.** `persistNow` writes
`board.json`, then the log files. Everything written after `board.json` is history and may be lost
to a crash. Nothing written after `board.json` may ever be needed to reconstruct content. The write
order does not change; §6 records *why* it was already right, so that no future pass "fixes" it.

**R6 — A quarantine can never cost content.** Structurally: the quarantine path does not touch
`state`, because `state` came from `board.json` before the log was consulted at all. The
quarantine's promises (§7) grow from three to five.

**R7 — Absent `board.json` is not a disagreement.** With no board file there is nothing for a log to
overrule, so a readable log is loaded as the truth and the boot is *reported as a recovery*. This is
the single asymmetric branch in the design and it is named, tested and bounded (§5.5).

### 1.1 The rule judged against the six required cases

| case | outcome under this rule | why, structurally |
|---|---|---|
| **R4-1a** — a stray line naming `pad:2026-03` | board intact, byte for byte; the stray op is **inert** | The victim board carries no `lineageId` (solo mode writes none), so nothing is adoptable. Even with a *forged* lineage the reconciler mints the board's own pad text at a stamp above the stranger's (R3). There is no census to guess at. |
| **R4-2a** — board A + board B's legitimate checkpoint | A's board on screen; quarantine `foreign-lineage`; B's files untouched | B's checkpoint carries B's `lineageId`. One comparison, no shared-key arithmetic. |
| **R4-3a** — a log from a NEWER build, after a downgrade | **adopted**, if it deserializes; otherwise `unreadable-log` with the lineage preserved | `lzp.v` is **not consulted**. `lineageId` and `gen` are frozen for all time; a build that cannot read the rest of the envelope still reads those two. The false message ("carries no `lzp` envelope") is gone with the branch that produced it. |
| **R4-4a** — a crash between `saveBoard` and `saveCheckpoint` | the note **survives**, with a fresh stamp above the checkpoint horizon; no quarantine, no warning about "drift" | The board is ahead of the log; being ahead is the *expected* state under R5, and reconciliation is the ordinary path, not an exception. |
| **R4-7b** — a quarantine costs all history | unchanged **when it happens**, and it now happens far less: never on a crash, never on a downgrade, never on an overlap accident. On the paths where it does happen, §9.3 makes it a *re-join* rather than a silent convergence reset. | Quarantine is reachable only from a genuinely foreign or genuinely unreadable log. |
| **R3-35c** — a log this build legitimately wrote (the control) | adopted; `state` deep-equals; **every stamp, `_born` and tombstone survives byte-identically** | The diff over an exactly matching pair is empty, so nothing is re-minted. This is INV-4, and it is the test that stops "refuse everything" and "re-mint everything" from passing as fixes. |

---

## 2. Why no threshold can work — the argument that ends the tuning

Attempt 2's census asks: *how many of `board.json`'s entity keys does the log know?* Consider the
two states the check must tell apart:

- **Ahead** (R4-4a): the log is this board's own log, one persist behind. The board has keys the
  log lacks.
- **Unrelated** (R4-2a): the log is another board's log. The board has keys the log lacks.

**They produce the same observation.** Set overlap is a function of the two key sets alone, and both
cases are "the board has keys the log lacks" — they differ only in *how many*, and the number is
attacker-chosen in one case and crash-timing-chosen in the other. The ranges overlap completely: a
crash can leave a board with one extra key or forty; a foreign log can share one key or forty.

> **No function of set overlap distinguishes "ahead" from "unrelated", so no threshold over that
> function can be correct. Raising the threshold from 1-of-N to k-of-N moves the failure from one
> case to the other; it does not remove it.**

This is why the brief's instruction — *do not tune the threshold* — is not a matter of taste. The
information needed is not in the key sets. It has to be **put on disk deliberately, by both files**,
which is §4.

---

## 3. Rejected alternatives, and the concrete attack that killed each

### 3.1 A larger census threshold (k-of-N, or "board ⊆ log")

**Killed by R4-4a and R4-2a simultaneously**, per §2. `board ⊆ log` quarantines **every** crash
between the two writes (the board always gains keys first), which is the most common real event in
this whole space. `log ⊆ board` still lets a foreign log that happens to be a subset delete
everything else. Any k in between is an arbitrary number two adversaries can straddle.

### 3.2 (a) — Exact provenance or nothing, as the *whole* rule

*The checkpoint binds to the exact generation of `board.json`; anything else quarantines.*

**Killed by R4-7b and R4-3a.** With the log still allowed to be the content authority, the
crash-between-writes case has no home: either it quarantines (and every crash costs the entire
history — every stamp back to GENESIS, every tombstone gone, a convergence reset per crash once WP-8
exists) or it does not, and then it is a threshold again with a different name. R4-3a adds that a
downgrade quarantines permanently.

**What survives from (a):** exactness itself. This ADR takes it — §4's binding is exact and there is
no partial credit — but applies it to *history only*, where a wrong answer costs stamps and never
notes. Exactness is affordable precisely because R3 moved it off the critical path.

### 3.3 (b) — Union, never choose

*Replay the log's tail over `board.json` so the result is a superset; a foreign log's entities are
simply additional.*

**Killed by tombstones, in both directions at once:**

- A union that **ignores** tombstones means deletes never stick. Delete a note, crash before the
  checkpoint, and the note comes back — forever, on every launch, because the board and the log
  each keep re-supplying it. That is a data *resurrection* bug traded for a data *loss* bug.
- A union that **honours** tombstones lets a foreign log's tombstone delete my entry. R4-2a with one
  `_alive:false` line is the exploit, and it is strictly easier than R4-1a because a tombstone needs
  no plausible content at all.
- A union also grows the board with a foreign log's live entities — R4-1a inverted: the stranger's
  notes appear on my board instead of mine disappearing.

**What survives from (b):** "never let one source discard the other" is right, and it is R3. But
union is a *merge mechanic*, and a merge mechanic cannot substitute for identity. Once identity is
settled (R2) and direction is settled (R1), the merge is a diff, not a union — and the diff is
already built (`store._diff`, §5.4).

### 3.4 (c) — One authority: the log is a derived cache, rebuilt and never believed

**Killed by R4-7b and by the R3-35c control.** Rebuilding the log from `board.json` on every launch
re-stamps every field at `GENESIS(i)` (ADR 001 §8.1) and drops every tombstone. In solo mode nothing
reads a stamp, so this is invisible — and on the day WP-8 exists, every field of the board loses
every contest against any op any peer ever wrote, and every deletion silently un-happens on the
peer. The R3-35c control also fails outright: a log this build wrote is never believed, so the log
serves no purpose and WP-3 was pointless.

**What survives from (c):** the authority direction. `board.json` *is* the truth about content. This
ADR takes that and adds the one thing (c) was missing — the log is still authoritative over
something, namely **history**, which `board.json` structurally cannot carry (11.4 forbids stamps in
that file).

### 3.5 A two-sided binding with the log winning on an exact match

*If the binding matches exactly, believe the log; otherwise believe the board.*

**Rejected on structure, not on an attack.** On an exact match the two files agree by construction,
so "who wins" is vacuous — the branch is unobservable and therefore untested, and every defect in
this register has lived on a branch that was rarely taken. Two branches where one will do is how
attempt 2 got a "benign drift" path that silently deleted a note. **One rule: the board always
wins.**

---

## 4. The binding — what goes on disk

The information §2 shows is missing must be written by **both** files. A one-sided provenance stamp
(attempt 2's `boardFp` on the checkpoint alone) can never distinguish *ahead* from *unrelated*,
because the one file that knows the board moved is the board.

### 4.1 `board.json` — one additive key

```jsonc
{
  "schemaVersion": 1,
  "notes": [ … ], "bars": [ … ], "categories": [ … ], "scratchpads": { … }, "settings": { … },
  "_v2": { "lineageId": "lin_9f3c…", "gen": 47 }
}
```

- ADR 001 §8.4 already sanctions exactly this: *"v2 additions are additive on the entry objects and
  inside one `_v2` key, so a v1 build still loads a v2 board and simply ignores the extra fields."*
  This ADR is the first thing to use it. It stays human-readable (11.4).
- **`_v2` holds exactly these two fields and nothing else, ever.** It is not a scratch area. Anything
  else that wants to live in `board.json` needs its own ADR.
- **`_v2` is written only once a lineage exists** — i.e. once the log is durable (WP-8 space
  creation). **In solo mode as it ships today, `board.json` does not change at all.** ADR 001 §11's
  "no extra file" and F-1's newly restored byte stability both survive untouched.
- **`_v2` never enters `store.state`.** It is attached at serialization and stripped at load, before
  `migrate()`. `exportJSON`, `snapshots.json` and `replaceAll` never see it.

### 4.2 `checkpoint.json` — the `lzp` envelope, rewritten

```jsonc
{ "horizon": …, "regs": …, "cursors": …, "seqs": …, "bodies": …, "parked": …, "spliced": …, "at": …,
  "lzp": { "v": 2, "lineageId": "lin_9f3c…", "gen": 47, "boardHash": "1a2b3c4d:8112", "horizon": "…", "at": 1756… } }
```

| field | frozen? | consulted by the verdict? | purpose |
|---|---|---|---|
| `lineageId` | **FOREVER** | **yes — it is the whole verdict** | Identity of the board lineage. Opaque, minted once, `lin_` + 128 random bits. |
| `gen` | **FOREVER** | **no** | Diagnostics and support bundles only. Frozen so a future envelope version is still legible. |
| `boardHash` | no | no | `fnv1a(bytes) + ':' + bytes.length` over the **exact bytes written to `board.json` in the same persist**. Chooses the fast path (skip the diff) and reports exactness. It is an optimisation and a diagnostic, **never a gate** — which is why a 32-bit hash is sufficient and no async WebCrypto call is needed on the `flushSync` path. |
| `v` | no | **no** | Envelope version, for humans and for a future migration. **A version this build does not know is not a refusal.** |

- `core/oplog.js` neither writes nor reads `lzp`, and `load()` ignores unknown keys. **The log must
  never learn what a board file is.** Unchanged from attempt 2, and still right.
- `lineageId` is forgeable by anyone who can write `ops.jsonl` — who can equally write `board.json`.
  Under R3 a forged lineage buys **nothing**: see §8.4.

---

## 5. The algorithm

### 5.1 Load

```js
async init() {
  const { text, raw }  = await storage.loadBoardText();     // raw parsed, text as read
  const { board0, binding } = splitBoardEnvelope(raw);       // binding = raw._v2 ?? null
  const board = migrate(board0 ?? defaultState());           // v0→v1 only; NOT v1→v2
  if (!board0) board.settings.seenFirstRun = false;

  const checkpoint = await storage.loadCheckpoint();         // null on parse failure (unchanged)
  const tail       = await storage.loadOps();                // [] when absent

  this.clearWarnings();
  this.quarantine = null;

  // R7 — no board file is not a disagreement. §5.5.
  if (!board0 && (checkpoint || tail.length)) return this._recoverFromLog(checkpoint, tail);

  // ── R1. THE SPINE. Unconditional, every launch, no predicate. ───────────────
  //   board.json becomes an op set. This is the ONLY source of content.
  const spine = createOpLog({ now: () => Date.now() });
  const m = migrateV1(board, {
    memberId: this._me, deviceId: this._device, acceptLossy: true,
    stampBase: binding ? 'now' : 'genesis',                  // §9.4
  });
  this._warnAll(m.warnings);
  for (const op of m.ops) spine.append(op);

  // ── R2. ONE EQUALITY. ───────────────────────────────────────────────────────
  const verdict = adoptable(binding, checkpoint);
  if (!verdict.ok) { this._log = spine; this._quarantineLog(verdict.reason, verdict.detail, checkpoint, tail); }
  else             { this._log = this._adoptHistory(spine, board, checkpoint, tail, verdict); }

  this._opsPersisted = false;                                // WP-8 turns this on; see §9.5
  this._stacks.remoteApplied();
  this.state = this._blankState();
  this._project({ settings: true });
  /* … snapshots, _persisted, ready = true, emit('init') — unchanged … */
}
```

### 5.2 The verdict — five reasons, one comparison

```js
/** @returns {{ok:boolean, reason:string, detail:string}} — never throws. */
function adoptable(binding, checkpoint) {
  if (!checkpoint)                     return no('no-checkpoint',
    'there is no checkpoint.json; a bare ops.jsonl carries no lineage and is never adopted');
  if (!binding || !isLineageId(binding.lineageId)) return no('board-carries-no-lineage',
    'board.json carries no _v2.lineageId, so no log has ever been bound to this board');
  const lzp = checkpoint.lzp;
  if (!lzp || typeof lzp !== 'object' || !isLineageId(lzp.lineageId)) return no('log-carries-no-lineage',
    'checkpoint.json carries no lzp.lineageId; it was not written by this app over any board');
  if (lzp.lineageId !== binding.lineageId) return no('foreign-lineage',
    `checkpoint.json belongs to lineage ${lzp.lineageId}; this board is ${binding.lineageId}`);
  return { ok: true, reason: 'same-lineage', detail: `lineage ${lzp.lineageId}`,
           exact: lzp.boardHash === boardHash(text) };     // reporting + fast path only
}
```

That is the entire gate. `gen` is not read. `v` is not read. `boardHash` does not gate. No key sets
are compared.

**A bare `ops.jsonl` with no `checkpoint.json` is never adopted.** It has no header and therefore no
lineage, and this is what makes attempt 1's original attack — one stray line in `ops.jsonl` —
structurally unreachable rather than merely unlikely. The cost is one class of crash (append
succeeded, checkpoint write did not) losing *history* for one session; under R5 it can never lose
content.

### 5.3 Adopt the history

```js
_adoptHistory(spine, board, checkpoint, tail, verdict) {
  const history = createOpLog({ now: () => Date.now() });
  // A3-H1 stays closed: anything thrown on the way in is a quarantine, never a dead app.
  try { history.load({ checkpoint, tail }); }
  catch (e) { this._quarantineLog('unreadable-log', `${e.name}: ${e.message}`, checkpoint, tail); return spine; }

  // ── THE PRECONDITION (§7.1). A log stamped beyond MAX_FUTURE_DRIFT_MS cannot be minted above
  //    AND admitted, so it is refused as `clock-skew` before the loop below is attempted.
  if (this._clockSkew(history, checkpoint)) { this._quarantineLog('clock-skew', …); return spine; }

  // ── THE HAZARD. Mint below the log's stamps and LWW silently keeps the log's value,
  //    which re-opens R4-4a with no warning anywhere. Advance the clock FIRST.
  try {
    if (isStamp(checkpoint?.horizon)) this._clock.observe(checkpoint.horizon);
    for (const cells of history.registers().values())
      for (const r of cells.values()) if (isStamp(r.stamp)) this._clock.observe(r.stamp);
    for (const op of history.ops({ includeParked: true })) if (isStamp(op?.ts)) this._clock.observe(op.ts);
  } catch (e) { this._quarantineLog('unreadable-log', `clock: ${e.name}: ${e.message}`, checkpoint, tail); return spine; }

  // ── R3. RECONCILE: mint the DIFFERENCE, at fresh stamps. §5.4.
  const n = this._reconcileOntoBoard(history, board);

  // ── R4. THE POST-CONDITION. Verify, do not trust.
  if (!sameV1Content(projectV1(history, this._ctxProject()), board)) {
    this._quarantineLog('reconcile-failed',
      'the log could not be reconciled onto board.json; board.json was kept whole', checkpoint, tail);
    return spine;
  }
  if (n) this._warn(`op log: reconciled ${n} change${n === 1 ? '' : 's'} board.json carried that the log did not `
                  + '(expected after a crash between the two writes; board.json is the truth and it won)');
  this._adopted = { lineageId: verdict.detail, exact: verdict.exact, reconciled: n };
  return history;
}
```

### 5.4 The reconciler is `_adopt()`, not `planReplaceAll()`

**This is load-bearing and it is easy to get wrong.** `planReplaceAll` emits a `set` op for **every**
entry unconditionally (`replace.js:560`, `emit(set(opCtx, id, patch, {born:true}))`). Using it here
would re-stamp every field and reset every `_born` **on every launch** — R4-7b, permanently, on the
happy path. It is the wrong primitive.

The right primitive already exists and is already attacked: `store._diff(before, beforeSettings)`,
the engine behind `_adopt()`, which means precisely *"the board object was edited outside a
transaction; mint ops for the difference."* Its parts are `diffCollection` (which already emits
`{_alive:false}` for an entry that has gone — the implicit tombstone), `diffPads`, `diffSettings`,
and `fitValue`, which truncates-and-warns instead of throwing (A3-M1a's ruling).

```js
_reconcileOntoBoard(history, board) {
  const before = v1ContentOf(projectV1(history, this._ctxProject()));  // the log's projection
  const saved  = this.state;
  this.state   = board;                       // `_diff` diffs `before` against `this.state`
  const ops    = this._diff(before, before.settings);
  this.state   = saved;
  for (const op of ops) history.append(op);   // fresh stamps, above every stamp observed in 5.3
  return ops.length;
}
```

Properties that fall out of this and are **not** special cases:

- **Exact match ⇒ zero ops.** Nothing is re-minted; every stamp, `_born`, tombstone, parked op,
  cursor and splice record survives byte-identically. (INV-4.)
- **Board has an entry the log lacks ⇒ one `set` at a fresh stamp.** R4-4a's note survives. Its
  stamp is above the log's horizon, so it also wins against a peer.
- **Log has a live entry the board lacks ⇒ one `{_alive:false}` at a fresh stamp.** A deletion the
  log never saw is honoured, and converges. A Time-Machine restore of an older `board.json` is
  therefore honoured too — which is what the user asked for by restoring it.
- **A foreign tombstone can never delete my entry.** If the board carries the entity, the diff mints
  a live `set` above the tombstone. No rule about tombstones is needed; option (b)'s hazard simply
  does not arise.
- **Parked ops are adopted wholesale and are not content.** A parked op *by definition* changes no
  register (ADR 001 §7.4), so it cannot violate R3, and dropping it would be exactly the "loses the
  new thing" failure §7.4 exists to prevent.

**Owed at WP-8, recorded so it is not rediscovered:** `_diff` produces no `retractions`. A deletion
discovered at init inside a family space owes the publisher a retraction the way `planReplaceAll`
does (`plan.retractions`, G-2). Until a family space can exist this is unreachable; it must land
with WP-8, not after it.

### 5.5 The one asymmetric branch — `board.json` **absent** (R7)

There is no truth to be authoritative, so there is no disagreement to resolve. Do **not** treat this
as a fresh install when a log is present.

> **AMENDED 2026-08-27 (R5-3a/b/c) — READ THE PRECONDITION, IT IS THE WHOLE SECTION.**
>
> This branch performs **no lineage check of any kind**. That is defensible for *absent*, and only
> for *absent*: there is no `_v2.lineageId` to compare against because there is no file. It was
> entered on `kind !== 'ok'` — so a `board.json` that merely **failed to parse** took it, and
> A3-C1's original outcome came straight back: one truncated byte in the victim's board, the
> attacker's own legitimate `checkpoint.json` + `ops.jsonl` pair beside it, and the stranger's
> board is on screen and committed over a file that was only unreadable, not wrong.
>
> **`_recoverFromLog` is now reachable if and only if `classifyBoardFile()` returns `absent`.**
> The other three kinds — `unparseable`, `not-a-board`, `read-failed` — go to §5.6, which is a
> different event and must stay a different event.

> **AMENDED AGAIN 2026-08-27 (round 7 / R6-6) — THE PRECONDITION IS ABOUT THE INPUT. IT SAYS
> NOTHING ABOUT THE OUTCOME, AND ROUND 5 WROTE THIS BRANCH AS THOUGH THE TWO WERE THE SAME
> THING.**
>
> `kind === 'absent' && hasLog` says a log is *there*. It does not say the log **loads**, and it
> does not say the log **has anything in it**. Enumerate the outcome instead — the input is the
> pair `(checkpoint, tail)`, and it has exactly three ends:
>
> | | what happened | what the boot must be | is the log at fault? |
> |---|---|---|---|
> | **R-a** | `log.load()` **throws** | **nothing was recovered** → §5.6 | yes → `unreadable-log` |
> | **R-b** | it loads and asserts **no** note, bar, category or scratchpad | **nothing was recovered** → §5.6 | **no** → `quarantine` stays **null** |
> | **R-c** | it loads and asserts **≥ 1** entity | R7, exactly as written below | no |
>
> **Only R-c is a recovery, and R-a and R-b go to §5.6's machinery** (`_bootRecoveryFailed`, a new
> `bootFailure.reason` of `recovery-unusable`): `bootFailure` is set **first**, `snapshots.json`
> is consulted through the same `_standIn` §5.6 uses, and the warning says *"THIS IS NOT A FRESH
> INSTALL"* out loud, because a log beside a missing board file is proof that this device has had
> a board. Because `bootFailure` is set, `_sequesterQuarantine`'s existing `!bootFailure` gate
> means the refused log **keeps its own name** — on this path it may be the freshest record that
> exists.
>
> Both used to fall out of this function as an **empty, WRITABLE** board with
> `_recoveredFrom === null`, which the first autosave then committed — while `store.snapshots`
> held §5.6's own stated answer, loaded two statements earlier in `init()` and never read. The
> board file being gone does not make an unloadable log a fresh install, and **a recovery that
> recovers no entry is indistinguishable on screen from no recovery at all.**
>
> **R-b's quarantine must stay `null`.** Nothing is wrong with an empty log; it is empty. And
> `_logAssertsNothing`'s `catch { return false; }` is load-bearing in the other direction: a
> projection that *throws* is a log with something in it this build cannot draw yet, and
> `_projectSafe` repairs exactly that, one setting at a time, without discarding an entry.
> Answering `true` there would send a recoverable board to a read-only boot (control: R6-6e).
>
> Rows: `round6-recovery.test.js` R6-6a/R6-6b/R6-6f (inverted), R6-6c/R6-6d/R6-6e (controls), and
> `D1-r1 … D1-r8` in `tests/helpers/domains.js` — the axis, enumerated, that this branch is now
> written against.

```js
// init(): the branch is on the KIND, and only one kind reaches R7.
const boardFile = classifyBoardFile(await storage.loadBoardFile(), board0);
if (boardFile.kind === 'absent' && hasLog) spine = this._recoverFromLog(checkpoint, tail);
else if (boardFile.kind !== 'ok')          spine = this._bootUnreadableBoard(boardFile, …);
```

```js
_recoverFromLog(checkpoint, tail) {
  try { this._log = createOpLog(…); this._log.load({ checkpoint, tail }); }
  catch (e) { this._log = createOpLog(…); this._quarantineLog('unreadable-log', …); }
  this._recovered = true;                     // diagnostics().source === 'recovery'
  this._lineageId = checkpoint?.lzp?.lineageId ?? this._lineageId;   // ◀── R5-3
  this._warn('board.json was missing and an op log was found; the board was recovered from the log. '
           + 'NOTHING VERIFIED THAT THE LOG BELONGS TO THIS BOARD — there was no board file to '
           + 'compare it against. Check it against Einstellungen › Schnappschüsse before editing.');
  /* … project, ready, emit('init') … */
}
```

- Fresh install = **no board file and no log** ⇒ unchanged, story 15.1 untouched.
- Recovery = **no board file and a log** ⇒ the log is loaded, and the boot is reported as a recovery
  on the warnings channel and in `diagnostics()`. The warning now **says out loud** that nothing
  verified the tie, and names `snapshots.json` as the thing to check it against — because the honest
  description of this branch is *"believe a log on no evidence"*, and a user who is told that can
  act on it.
- **The recovered board adopts the checkpoint's `lzp.lineageId`.** Without this, the board written
  back carried no `_v2`, so the *next* launch refused its own log `board-carries-no-lineage` and
  moved aside the only copy of the history it had just recovered from.
- `diagnostics().recoveredFrom` is `{from:'op-log', …}` here. It exists because `source` cannot tell
  this apart from §5.6's read-only boot, and they are not the same event.
- This does not reopen R4-1a: reaching it requires **deleting** `board.json`, and anyone who can
  delete it can write it. §8.4 bounds the residual.

### 5.6 `board.json` **exists and cannot be read** — a read-only boot (R5-3)

Not a recovery, not a fresh install. It is the one situation in which the app has genuinely lost
sight of the user's data and has to say so. Four statuses come out of `storage.loadBoardFile()` and
five kinds out of `classifyBoardFile()`; `ok` and `absent` are handled above, and these three are
this section — **plus, since round 7, §5.5's own R-a/R-b, which reach it through
`_bootRecoveryFailed`**:

| kind | what happened |
|---|---|
| `unparseable` | the bytes are there and are not JSON — **including ZERO BYTES (R6-5a)**. An empty file is bytes on disk that do not say what the board is, and it is what an interrupted write leaves behind. `JSON.parse('')` throws, so this is not a special case in the classifier; it was a special case in *`loadBoardFile`*, where `txt === ''` was tested as "this store held nothing" and collapsed a truncated file into `absent` — i.e. into §5.5, the one branch that may adopt a log |
| `not-a-board` | valid JSON that is not a board: `[]`, `"a string"`, `null`, `7` — the cases `splitBoardEnvelope` silently folded into "absent" — **and, since round 7, any OBJECT carrying none of a board's five collections in a board's shape (R6-5c/d)**: `{}`, `{"schemaVersion":1}`, `{"hallo":"welt"}`, `{"notes":"nicht ein array"}`, and `{"_v2":{lineageId,gen}}`. `Array.isArray` was the whole guard, and under an ADR that makes `board.json` the sole content authority, classifying an unrecognised object as `ok` is not a shrug — it is an **authoritative assertion that the board is empty**. See the box below for the member of that class that costs the calendar rather than the history |
| `read-failed` | the read **threw**: a locked file, a dismissed permission prompt, an EIO. Previously `txt = null`, i.e. indistinguishable from *there is no board file*, so a transient error was a recovery |
| `recovery-unusable` | not a kind but a **`bootFailure.reason`**: `board.json` is `absent`, a log is beside it, and §5.5's R-a/R-b ended with nothing recovered. Same machinery, same read-only promise, different sentence — the copy says **THIS IS NOT A FRESH INSTALL** |

> **THE ENVELOPE-ONLY OBJECT — the sharpest input in the whole domain (`D1-b18`, R6-5g).**
>
> `{"_v2":{"lineageId":<the victim's own>,"gen":N}}` is nothing but ADR 006 §4.1's additive
> binding. Measured against the pre-round-7 build: kind `ok`, `quarantine === null`, the verdict
> `same-lineage`, the log **adopted** — and `_reconcileOntoBoard` then mints **one `{_alive:false}`
> retraction per entity**, because §5.4's *"the log has a live entry the board lacks ⇒ an honoured
> deletion"* is exactly right for a Time-Machine restore and exactly wrong for a "board" that
> lacks all of them. The empty board and its tombstones are both committed, and the next launch
> agrees.
>
> Every other member of this domain costs **history**. That one costs **the calendar** — and at
> WP-8 what propagates to every paired device is not a corrupt file but well-formed deletes this
> app minted itself. It is why `schemaVersion` and `_v2` are deliberately **not** evidence of
> boardhood: a version number is a claim any file can make, and `_v2` says which log is bound to
> a board, not that this *is* one.
>
> The shape test is presence **and** well-typedness, because presence alone passes
> `{"notes":"nicht ein array"}` (mutant F4b). It is **not a validator**: a board that is merely
> damaged is still a board and `migrate()` repairs it.

**`_bootUnreadableBoard` does four things, and the order is the fix:**

1. **Set `bootFailure` FIRST**, before anything can write. `persistNow` and `flushSync` both return
   early while it is set, so `board.json` keeps its bytes for a rescue pass.
2. **Quarantine any log as `board-unreadable`.** An unreadable board has no `_v2.lineageId`, so
   nothing ties the log to it. **A log is refused on the absence of a tie, never adopted on it** —
   inferring the opposite from the same absence is exactly what R5-3b exploited. Salvaging a
   lineage out of corrupt bytes would be a fourth heuristic on a question that has killed three
   (§2); the honest answer is that the tie cannot be made.
3. **Show the newest usable `snapshots.json` entry**, which is §8.2's own stated answer for this
   morning and was never even consulted. It is at most a day old; the log might be fresher, but
   "fresher" is worth nothing when nothing ties it to this board. With no snapshot: an empty
   stand-in, labelled.
4. **Say all of it**, in the user's language. The copy is in `_bootUnreadableBoard`'s docblock,
   keyed off `bootFailure.reason`, and its first promise is the one that matters: *„Ihre Daten sind
   NICHT gelöscht — die Datei liegt unverändert an ihrem Platz."*

**`_sequesterQuarantine()` is gated on `!bootFailure`.** A read-only session's promise is that every
file is exactly as it was, and a move-aside is a write. Without this gate the evidence was renamed
away one launch after the board became unreadable — R5-3b's second half, and the reason the
original was unrecoverable rather than merely alarming.

**`bootFailure.reason` is FIRST-WINS.** `_projectSafe` runs after this and may also fail; if the
snapshot standing in for the unreadable board will not project either, the reason stays `board-*`
and the projection error is recorded beside it as `projectionFailure`. Overwriting it with
`unprojectable` would tell the user their board is BROKEN — a claim about a file nothing has
successfully parsed. Read-only-ness never depended on the reason, so keeping it costs nothing.

---

## 6. `persistNow` — the write order does not change, and here is why

```js
async persistNow() {
  clearTimeout(this._saveTimer);
  this._adopt();
  await this.rollSnapshot();

  // 1. the exact bytes — serialized ONCE, so the hash names what was written
  const text = serializeBoard(this.state, this._lineageId
    ? { lineageId: this._lineageId, gen: ++this._gen } : null);
  await storage.saveBoardText(text);          // ◀── THE COMMIT POINT
  this._persisted = structuredClone(this.state);

  // 2. everything below this line is HISTORY and may be lost to a crash
  if (this._opsPersisted) await this._persistOps(boardHash(text));
}
```

**Why board-first is right, stated once so it is never re-litigated:** if `board.json` is the truth
about content (R1/R3), the truth file must never be *behind*. Anything written after it can only
ever be behind it, and being behind is harmless for something that is only history. Invert the
order and a crash leaves `board.json` behind a checkpoint that is now the only copy of a note — and
under R3 the board would delete it. **The ordering and the authority rule are the same decision seen
from two sides.** Round 4 was right that the design "knows about this exact case and picked the
losing side"; the losing side was the authority rule, not the write order.

Consequences and constraints:

- `storage.saveBoard(state)` gains a sibling `saveBoardText(txt)` so that the bytes hashed are
  byte-identically the bytes written. Same for `saveBoardSync`.
- `flushSync` (browser) writes the board and no log files. The board therefore moves without the
  checkpoint — which is exactly the *ahead* state, and reconciliation handles it. `gen` may not
  advance on that path; nothing reads `gen`, which is why nothing reads `gen`.
- **A3-M5 interacts here** — closed 2026-08-27, §8.5. `_persistOps` is "append the new tail,
  checkpoint, then `truncateOps(folded)`". It stays entirely below the commit point, and
  `truncateOps` may only ever drop lines the checkpoint being written already folds — which is a
  CHECKED condition (`no admitted op above `cp.horizon``), not an assumed one, because
  `oplog.checkpoint()` folds to the horizon the log was LOADED with and that horizon does not move
  on its own. Everything the checkpoint does not carry is in `ops.jsonl`; that is the outbox of
  §9.2 and it is what makes the pair on disk complete.
- **`_v2` is not in `state`.** `serializeBoard` attaches it; `splitBoardEnvelope` removes it. This
  keeps 11.4 ("`board.json` IS `store.state`") true modulo one documented additive key, and keeps
  F-1's fixed point intact.

---

## 7. Quarantine — five promises, and an honest reason

**Promises 1–3 are unchanged** and remain structural, not incidental:

1. **Not applied.** The log's registers do not reach `state`.
2. **Not deleted.** `ops.jsonl` and `checkpoint.json` stay exactly where they are. (I-6's
   move-aside — `ops.quarantined-<ts>.jsonl` — is the sanctioned form and is still owed. **Do not
   "fix" I-6 by deleting them.**)
3. **Not overwritten.** `_opsPersisted = false` is set inside `_quarantineLog`, so `_persistOps`
   cannot touch either slot for the rest of the session.

**Two new ones, and the first is the point of this ADR:**

4. **A quarantine can never cost content.** Not "does not" — *cannot*. `state` is derived from the
   spine, which was built from `board.json` before the log was read, so there is no code path from a
   quarantine to a lost entry. This is provable by construction and is pinned by INV-15: the same
   board loads identically with and without the quarantined files present.
5. **The reason is true.** The enum is exact and each member names a fact, not a guess:

| reason | means | lineage |
|---|---|---|
| `no-checkpoint` | a bare `ops.jsonl`; no lineage exists to compare | preserved |
| `board-carries-no-lineage` | `board.json` has no `_v2.lineageId` (solo, or hand-edited) | preserved |
| `log-carries-no-lineage` | `checkpoint.json` has no `lzp.lineageId` | preserved |
| `foreign-lineage` | both carry one and they differ — **another board's log** | **re-minted** (§9.3) |
| `unreadable-log` | `load()` threw | preserved |
| `board-unreadable` | **`board.json` exists and could not be read** (§5.6), so it has no `_v2.lineageId` and there is nothing to compare — a log is refused on the absence of a tie, never adopted on it (R5-3) | preserved, **and the files keep their own names**: this reason always travels with a `bootFailure`, and a failed boot never sequesters |
| `clock-skew` | a stamp that **decides state** — a register cell, the checkpoint horizon, or a LIVE line — is more than `MAX_FUTURE_DRIFT_MS` ahead of this machine's wall clock, so §12.6 cannot be satisfied (§7.1). **A PARKED line is not such a stamp and never raises this** (round 7 / R6-4) | preserved, **and the files keep their own names** |
| `reconcile-failed` | R4's post-condition did not hold | preserved |

**`lzp.v` is never a reason.** R4-3a's refusal-on-version-bump and its false message are both gone.

The lineage is **re-minted only on `foreign-lineage`**, because that is the only reason that says the
old lineage was never ours. On every other reason the lineage is kept, so a log that a newer build
wrote and this build could not read becomes readable again the moment the user re-upgrades.

### 7.1 `clock-skew` — the one rule that could not be obeyed, resolved (R5-2e)

§12.6 says the clock is advanced past every stamp the log carries **before any op is minted**. ADR
001 §1.3 says `clock.observe` **declines** a stamp more than `MAX_FUTURE_DRIFT_MS` (24 h) ahead of
local wall time, and §7.4 says the log **parks** an op stamped that far ahead — and a parked op
changes no register, so an op minted up there would not be applied even if the clock had agreed to
mint it. For a log written while the machine clock was fast — a dead CMOS battery, a resumed VM
snapshot, a botched NTP step, a board carried between two Macs one of which is wrong — **the two
rules cannot both be obeyed.**

> **§12.6 is a PRECONDITION FOR ADOPTION, not an instruction to try.** The store asks the question
> before it attempts the observe loop (`store._clockSkew`). Inside the window, nothing happens and
> the ordinary path runs — a twelve-hour skew reconciles perfectly, and that is the non-vacuity
> control. Beyond it, the log is quarantined as `clock-skew`, the detail **names the clock** and
> the amount, and ADR 001 §1.3 is left alone, because it is the rule that is protecting something.

> **Amended 2026-08-27 (round 7 / R6-4) — "every stamp the log carries" MEANT LIVE STAMPS, and
> reading it as "every LINE" turned §7.4's shock absorber into a whole-history quarantine.**
>
> §12.6 is a statement about the stamps a MINT WILL BE COMPARED AGAINST. A parked op is compared
> against nothing: ADR 001 §7.4 retains it and applies it to no register, which is the entire
> point of parking. There is nothing for a mint to be "above" when the op is in no register, so a
> parked stamp may not raise this ceiling. `store._clockSkew` walks `ops({liveOnly:true})`, plus
> the register cells and the checkpoint horizon — the three things that decide state — and that
> list, not a list of branches, is the definition.
>
> Round 6 measured the cost of the wider reading: one ordinary `note.set` stamped 48 h ahead was
> parked exactly as designed, persisted into `checkpoint().parked` exactly as A2 round 2 requires,
> and then read back as `clock-skew` on the next launch — **on every launch until the stamp
> passed**, at +90 days for ninety days, with `_quarantineLog` setting `_opsPersisted = false` so
> that under WP-8 the device recorded nothing for the duration (A3-M5, remotely). And because
> `foldAuthorized` decided the park BEFORE the authorisation stages, a stranger whose write the
> store refuses outright when stamped NOW could trigger all of it with a date (R6-4c). The
> ordering half is fixed at `store.applyRemote`, which withholds `nowMs` from `foldAuthorized` —
> the 24 h clamp is that parameter's only consumer anywhere in the fold, so withholding it stops
> the clock pre-empting authorisation and does nothing else. **Authorisation is decided first; the
> park classification is applied to ops that have already been authorised.**
>
> What remains reachable is what R5-2e described and nothing else: a stamp only reaches a register
> by being INSIDE the window when it was written, so a register 48 h ahead means the local clock
> has moved BACKWARDS since. The detail says that now, instead of accusing this Mac of a fault
> that may belong to a peer. Rows: R6-4a/b/c (inverted), R6-4d and R6-4e (the two non-vacuity
> controls), and the whole 44-cell `D2` × 5-cell `D3` matrix in `tests/helpers/domains.js`.

`clock-skew` is the only reason that is **expected to stop being true** without anyone touching
either file: the date is corrected, or it simply passes. So it is the only reason exempt from I-6's
move-aside (`store.DEFERRED_QUARANTINE`) — a refusal that is deferred must leave the bytes under the
name the next launch will look for. A second member of that set needs the same argument: *what
changes, and who changes it?*

---

## 8. What this does NOT fix — the honest limits

1. **F-5 is narrowed, not closed.** An adopted checkpoint still installs its registers with no
   admissibility fold. This ADR removes the *solo* half of its reach — the diff re-asserts the
   board's own values, and `IMPORT_DEFAULTS`' `privat` floor is what the board carries — but a
   checkpoint can still plant `visibility:'geteilt'`, `coEdit:true` or a foreign author on fields
   `board.json` does not express. **The corollary this ADR does add, normatively:** *whenever
   `board.json` is the truth, it must carry every field that is truth.* Once a family space exists,
   the persisted board is the **full** projection, not `stripV2Fields` (ADR 001 §8.4 already says
   so). F-5's real fix — fold the checkpoint through `applyRemote`'s gate — stays owed and stays on
   the WP-8 list.
2. **I-2 is promoted, not fixed.** Making `board.json` the sole content authority makes a poisoned
   `board.json` a single point of failure. The answer is `snapshots.json` (11.5) and the quarantined
   log on disk — **not** a rule that lets the log overrule the board. I-2 (a `MaterializeError` out
   of `init()`, `ready === false`, white screen) becomes more urgent as a direct result of this ADR
   and should be fixed in the same pass.
3. **I-1 is untouched** and independently reachable.
4. **A forged `lineageId` still buys an attacker something — bounded.** Someone who can write both
   files can make a foreign log adoptable. Under R3 they cannot change one entity or one field: the
   diff mints the board's own values above theirs. **The list of what they DO retain was incomplete;
   this is the corrected one (R5-5a/b).** The reconciler walks `COLLECTION[].fields`, so anything
   outside that list cannot be minted, and the post-condition must therefore either see it or
   concede it:

   | retained | reaches the screen? | how it is bounded |
   |---|---|---|
   | foreign **parked** ops | no — a parked op changes no register | ADR 001 §7.4, by definition |
   | foreign **tombstones for keys the board does not carry** | no today; under WP-8 could suppress a peer's later creation of that exact id | accepted; smaller than write access to `board.json` |
   | **`_born`**, and therefore **array order** | **yes** — ADR 001 §5 step 5 is explicit that the comparators are MANDATORY, NOT COSMETIC | **CLOSED by R4, not by R3.** `_born` is `writeOnce`, so the difference cannot be minted; but `board.json`'s array order *is* the assertion, so the post-condition compares the id sequence and a log that disagrees is refused (`reconcile-failed`, detail naming the order). |
   | fields `board.json` **cannot express at all** — `visibility`, `coEdit`, `defaultVisibility`, a foreign `ownerId` | not today (`stripV2Fields` removes them before the board is drawn or written) | **NOT closed. Bounded here and owed at WP-8** with F-5 (§8.1): no post-condition written in terms of `board.json` can ever see a field `board.json` cannot carry. The fix is F-5's — fold the checkpoint through `applyRemote`'s gate — plus §8.1's corollary that once a space exists the persisted board is the FULL projection. Measured by `round5-authority.test.js` R5-5b, which stays green because the defect is still there. |
5. ~~**A3-M5 must be fixed in the same pass**~~ — **CLOSED 2026-08-27 (R5-4).** It was not fixed in
   the same pass, and the cost was the largest defect this project has had: with nothing appending
   and `oplog.checkpoint()` folding only to the horizon it was `load()`ed with, **the log stopped
   recording on the second launch**, every ordinary launch reported a crash that had not happened,
   and every entry created after the first persist was re-minted `born: true` at a fresh stamp on
   every launch. `_persistOps` is now the four steps §6 names — append what the coming checkpoint
   will not carry, compact when the tail has grown (ADR 001 §7.2), checkpoint, then truncate **only**
   where that checkpoint folds every line on disk. Two things ADR 001 §7.2 asks for are still owed
   and are not to be mistaken for done: the compaction is total rather than "keeping a 30-day tail
   for debuggability" (`truncateOps` can only drop a prefix and the store does not track which line
   of the file an op is on), and nothing compacts on the 2 MB-at-launch trigger.

---

## 9. WP-8 — the rule when the log carries a peer's ops

*"A rule that only works in solo mode is not a rule."* The rule does not change. Five extensions
make that true rather than merely asserted.

### 9.1 The inbox — a peer op `board.json` has never seen

Such an op exists only in the window between `applyRemote` folding it and the next `persistNow`. It
is not lost by R3, because **the durable record of a peer's op is the server, not the log**, and the
resume point is the cursor:

> **W1 (invariant).** The persisted cursor may never be ahead of `board.json`. Cursors ride in
> `checkpoint().cursors`, which is written *after* `board.json` in the same persist (R5), so this
> holds automatically — and it must be asserted, so that a future sync engine cannot break it by
> persisting a cursor through some other file.

A peer op the board has not committed is therefore always still behind the durable cursor, is
re-pulled on the next sync, and is idempotent by `opId` (ADR 001 §6). **Nothing is lost, and the log
never has to be believed over the board to avoid losing it.**

### 9.2 The outbox — local ops awaiting push

They live in `ops.jsonl`, which is written only after the `board.json` that already contains them
(R5), so the outbox is never ahead of the board either. When the log is **adopted**, the outbox
survives intact — this is the main reason adoption exists at all, and it is why (c) was rejected.

### 9.3 A quarantine, at WP-8 scale, is a re-join — not a silent divergence

R4-7b's real cost lands here: a quarantine discards every stamp and every tombstone, and a device
that silently rejoins with GENESIS stamps loses every field contest and un-deletes on its peers.

> **W2 (normative).** After a quarantine on a board that carried a lineage, the store treats the
> event as a **re-join**: it **re-derives at `now` (§9.4)** and re-publishes its whole personal
> projection. A quarantine is a visible, reported, converging event, never a quiet one.

> **AMENDED 2026-08-27 (round 7 / R6-7e) — the `lineageId` clause is STRUCK, and the substance it
> was trying to protect is a DIFFERENT FIELD that was already normative and already implemented.**
>
> W2 used to open *"the store mints a **new** `lineageId`"*, and that contradicted §7's own table,
> where four of the six reasons preserve the lineage and only `foreign-lineage` re-mints. §7 is
> right and W2 was wrong. **`lineageId` is the LOCAL `board.json` ↔ log binding (§4.1/§4.2), not a
> sync identity.** Re-minting it on every quarantine would orphan a log a later launch is meant to
> adopt — `clock-skew` is expressly the reason *"expected to stop being true without anyone
> touching either file"* (§7.1), so a Mac whose date was wrong for an afternoon would lose its
> history permanently for having been quarantined once.
>
> W2's *substance* — **do not silently rejoin at the bottom of the order** — is about **stamps**,
> and §9.4 already says it: `migrateV1`'s `stampBase: 'now'` on a re-derivation over a
> lineage-bearing board (`store._buildSpine({restamp: !!binding})`). Two fields, two jobs, and W2
> conflated them.
>
> **Measured, because the distinction is testable and the measurement sharpens the rule** (R6-7e,
> `round6-authority.test.js`): on a quarantine over a lineage-bearing board the **register cell
> stamps** are at `now` — so no field contest is lost — while the **`_born` values** stay at
> `GENESIS(i)`. That is deliberate: `_born` is `board.json`'s array order (ADR 001 §8.1), not a
> time, and reshuffling it would be a v1 regression on screen. See INV-20.

### 9.4 Stamps on a re-derivation — `GENESIS` is for upgrade day only

`migrateV1` gains `ctx.stampBase`:

- **`'genesis'` (default)** — upgrade day. `GENESIS(i)` encodes the v1 array index and nothing else
  (ADR 001 §8.1), which is what makes two Macs migrating the same file agree byte for byte. Used
  when `board.json` carries **no** `_v2` — the board has never had a log.
- **`'now'`** — re-derivation. Used when `board.json` **does** carry a lineage but the log was
  quarantined. These values are the newest thing this device knows; stamping them at the bottom of
  the order would make them lose every contest they should win. Determinism within the run is kept
  (one `mint()` sequence, same order), and cross-device agreement is not required, because a
  re-derivation is a re-join (W2), not a migration.

### 9.5 `_opsPersisted` and the quarantine

Unchanged from A3-C1 and repeated here because it is the one line that can undo promise 3:
**whoever sets `_opsPersisted = true` when a space is created must consult `store.quarantine` first.**
Turning the flag on over a quarantined log overwrites the very bytes the quarantine exists to
preserve.

---

## 10. Invariant tests that must exist

Every row must be **mutation-tested**: reverted in a scratch copy of the tree and required to redden
the named row. A fix with no test that dies is not recorded as fixed (FINDINGS §7).

> **AND, SINCE ROUND 7, THE INVARIANTS ARE NOT THE WHOLE GATE FOR THIS AREA.** Five consecutive
> rounds each **relocated** the same failure rather than closing it, because each fix was chosen a
> **branch** at a time and the branch was chosen before the input domain was written down. The
> sharpest instance is R6-5a: round 5 replaced *"is the raw value null?"* with a careful five-way
> classifier and wrote four of the five kinds out in a docblock — and `''` still went to the wrong
> one, because the enumeration was of **branches** (ok / absent / unparseable / not-a-board /
> read-failed) rather than of **bytes**.
>
> **The required method for anything in §5, §7 or §9 is now: enumerate the INPUT DOMAIN first,
> exhaustively, as data; choose the behaviour per input; then property-test over the domain.**
> The domains live in **`tests/helpers/domains.js`** — 310 entries over six domains, each
> `{id, value, label, expect, openFinding}` where `expect` is the *required* behaviour and
> `openFinding` names the row that predicts it fails today. `tests/property/domains.test.js` walks
> every entry and splits deviations three ways: **UNEXPECTED** (a regression), **STALE** (a finding
> is named but the entry now holds — the work order is lying) and the work order itself. A fix that
> only names branches will be relocated by the next round.

| # | invariant | the mutant that must redden it |
|---|---|---|
| **INV-1** | **The ADR in one assertion.** For any board `B` and any *non-adoptable* log `L`: `content(boot(B, L)) ≡ content(boot(B, ∅))`. Run as a **property** over the 500-seed ugly corpus × hostile logs (zero-overlap, one-key, all-keys, all-keys-plus-tombstones, a legitimate log of a different board). | make adoption change content |
| **INV-2** | **R4-2a inverted.** Board A + board B's legitimate checkpoint ⇒ A's content, `foreign-lineage`, B's two files byte-identical on disk after a full session. | compare anything other than `lineageId` |
| **INV-3** | **R4-4a inverted.** Crash between the two writes ⇒ the note survives, `quarantine === null`, `source === 'op-log'`, and the note's stamp is **above** `checkpoint.horizon`. | drop the clock-observe loop in §5.3 (this mutant is subtle and silent — it must be in the table) |
| **INV-4** | **The anti-churn control.** Exact match ⇒ the reconciliation plan is **empty**; `serializeRegisters()` is byte-identical across the restart; every `_born` and every tombstone survives. | swap `_diff` for `planReplaceAll` |
| **INV-5** | **R3-35c strengthened.** A log this build wrote is adopted; `state` deep-equals; stamps survive. The control that stops "refuse everything" passing as a fix. | quarantine unconditionally |
| **INV-6** | **R4-7b inverted.** After a crash-forward reconcile, **no stamp regresses to GENESIS**; unchanged fields keep their original stamps; the log's tombstones survive. | re-mint every field |
| **INV-7** | **R4-3a inverted.** `lzp.v = 99` with a matching lineage ⇒ **adopted** if it deserializes; `unreadable-log` with the lineage **preserved** if it does not. | consult `lzp.v` |
| **INV-8** | **R5, the ordering pin** (replaces R4-7a). In every persist, `saveBoard` resolves before any write to `ops.jsonl` or `checkpoint.json`. Instrument `storage`. | move `_persistOps` above `saveBoard` |
| **INV-9** | **Solo mode untouched.** No space ⇒ `board.json` carries **no** `_v2`, no second file is written, and `gen0 === gen1 === gen2` across a restart (F-1's fixed point). | write `_v2` unconditionally |
| **INV-10** | **R1, no branch.** The spine is built on **every** launch, including when the log is adopted. | skip `migrateV1` when the log is adoptable (INV-1 and INV-3 must also redden) |
| **INV-11** | **R2, one equality.** Mutating `lzp.gen`, `lzp.at`, `lzp.boardHash`, `lzp.v`, or `_v2.gen` changes **no** boot outcome; changing one character of either `lineageId` quarantines. | let any second field into the verdict |
| **INV-12** | **R7.** No board + a log ⇒ recovery boot, reported. No board + no log ⇒ fresh install, `seenFirstRun === false`, story 15.1 untouched. | treat recovery as a fresh install |
| **INV-13** | **R4, the post-condition.** With a deliberately sabotaged reconciler (inject a no-op `_diff`), a mismatched board+log boots with **`board.json` whole** and `reconcile-failed`. | delete the post-condition |
| **INV-14** | **Tombstones, both halves.** Delete a note and complete the persist ⇒ it stays deleted across a relaunch. Delete a note and crash before the checkpoint ⇒ it **returns** (the delete was never committed). | honour an uncommitted delete |
| **INV-15** | **Promise 4.** The same board loads byte-identically with and without a quarantined log beside it. | let the quarantine path touch `state` |
| **INV-16** | **W1 (WP-8).** The persisted cursor is never ahead of the board that was last written. | persist a cursor outside the checkpoint |
| **INV-17** | **The log records (R5-4).** After any launch that loads a log, an op the user makes is on disk — in `ops.jsonl` when the checkpoint's horizon does not cover it — and the next launch reconciles **zero** changes, so a non-zero count is news. The tail is bounded: it compacts and is truncated, and nothing is lost across the compaction. | remove the `appendOps` call; fold the tail into the checkpoint and truncate it (`checkpoint({horizon: peek()})`); drop the "only what the checkpoint folds" guard; set the compaction threshold to `Infinity` |
| **INV-18** | **§7.1.** A log whose LIVE stamps — register cells, horizon, live lines — are beyond `MAX_FUTURE_DRIFT_MS` is `clock-skew`, the detail names the CLOCK, the files keep their own names, and the same log is adopted once the skew is inside the window. A 12-hour skew reconciles perfectly (the non-vacuity control), and a PARKED line at any stamp costs that op and nothing else (round 7 / R6-4). | remove the precondition; move the files aside anyway; count parked stamps |
| **INV-19** | **Order is content (R5-5a).** Two `_born` values swapped in an adopted checkpoint ⇒ `reconcile-failed`, `board.json`'s order on screen, content whole. | compare id→fields maps only |
| **INV-20** | **Order SURVIVES a restore (round 7 / R6-7).** `board.json`'s array order survives a Time-Machine restore over this board's own log, and a lost tail. An entity the log tombstoned and the restored board still carries is written back as a **restore** — `_alive:true` and the fields, and **no `_born`**, because a delete writes `_alive:false` and nothing else, so the log still holds the position `board.json` has. An entity the log has never heard of that lands in the **interior** of the order gets a `_born` **strictly between its neighbours'** (a derived position, `ZERO_DEVICE_SHORT`), not a fresh stamp that would sort it last. And INV-19 is unweakened: a `_born` **swap** in an adopted checkpoint is still `reconcile-failed`. | mint `{born:true}` on the restore branch (F6); make `bornBetween` never find room; record `seq.length` instead of `seq` in the post-condition |

**Rows to invert, not delete** (`tests/attack/`): `round4-quarantine.test.js` R4-1a, R4-1b, R4-1d,
R4-2a, R4-3a, R4-4a; `round4-failsafe-init.test.js` R4-7b. **Rows that must stay green as they are:**
R4-1c, R4-2b, R4-3b, R4-3c, R4-7a, R3-35b, R3-35c, R3-35d, R3-36.

---

## 11. The code changes, file by file, for the build phase

### `src/js/store.js` — the whole of the change lives here

**Delete** (three defeated heuristics are three attack surfaces; removing them is part of the fix):
`logBelongsToBoard`, `boardCensus`, `logCensus`, `censusFingerprint`, `LZP_CHECKPOINT_ENVELOPE`'s
old meaning, the "two layers" docblock at `:416-445`, and the `shouldMigrate(…, {opsLogExists})` call
at `:636`.

**Add:**
- `LINEAGE_PREFIX = 'lin_'`, `mintLineageId()`, `isLineageId()`.
- `splitBoardEnvelope(raw)` → `{board0, binding}`; `serializeBoard(state, binding|null)` → text.
- `boardHash(text)` — keep `fnv1a`, now over the whole board text plus its length.
- `adoptable(binding, checkpoint)` — §5.2, five reasons, one comparison, never throws.
- `_adoptHistory(spine, board, checkpoint, tail, verdict)` — §5.3, including the **clock-observe
  loop** and the **post-condition**.
- `_reconcileOntoBoard(history, board)` — §5.4, over `_diff`.
- `_recoverFromLog(checkpoint, tail)` — §5.5.
- `this._lineageId`, `this._gen`, `this._adopted`, `this._recovered`.

**Rewrite:** `init()` (§5.1 — unconditional spine, no predicate); `_useLog` → `_adoptHistory`;
`_stampedCheckpoint()` (envelope becomes `{v:2, lineageId, gen, boardHash, horizon, at}`);
`persistNow()` (§6 — serialize once, `saveBoardText`, hash those bytes); `_persistOps(hash)`;
`_quarantineLog(reason, …)` (new enum, re-mint the lineage on `foreign-lineage` only, promise 4 in
the docblock); `diagnostics()` (add `lineage: {id, gen, adopted, exact, reconciled}` and
`source: 'board.json' | 'op-log' | 'recovery'`); `flushSync` (must go through `serializeBoard`).

**Do not touch:** `_diff`, `diffCollection`, `diffPads`, `diffSettings`, `reconcileMap`,
`reconcileList` — the reconciler is these, unchanged, called with a different `before`.

### `src/js/storage.js`

- `loadBoardText()` → `{text, raw}` so the hash is over the bytes **as read**.
- `saveBoardText(txt)` and a `saveBoardSync` that takes text. `saveBoard(state)` may stay as the
  thin wrapper its existing callers use.
- `opsLogExists()` loses its only caller. Mark deprecated; remove with `shouldMigrate`'s parameter.
- **I-6 becomes more attractive and stays owed**: move a quarantined pair aside as
  `ops.quarantined-<ts>.jsonl` / `checkpoint.quarantined-<ts>.json`. Do **not** close it by deleting.

### `src/js/core/migrate1to2.js`

- `shouldMigrate(board, env)` → `shouldMigrate(board)`. The `opsLogExists` input is **removed**, not
  ignored: it is the input that caused A3-C1 and no correct caller has one to give any more.
- `migrateV1(board, ctx)` accepts `ctx.stampBase ∈ {'genesis','now'}`, default `'genesis'` (§9.4).
  `checkCtx` validates it.

### `src/js/core/oplog.js`, `entities.js`, `materialize.js`, `replace.js`

**Unchanged.** The log must not learn what a board file is; `load()` already ignores `lzp`, and
`replace.js` keeps its wholesale semantics because import and snapshot restore genuinely *are*
wholesale (A-1). Only `store.js` chooses between the two primitives.

### Docs

- **`docs/v2/adr/001-op-log.md`** — amend §8.4 (the idempotence predicate is superseded: migration
  now runs on every launch and its idempotence comes from reconciliation, not from a predicate),
  §9 (`board.json` gains `_v2`; the write order becomes normative), §7.2 (a checkpoint is history,
  never an authority over content), §11 (restate why solo is still untouched).
- **`docs/v2/contracts/store.contract.js`** — `diagnostics()` shape, the quarantine reason enum,
  `lineage`, the five promises.
- **`docs/v2/contracts/ops.contract.js`** — `shouldMigrate` signature, `ctx.stampBase`.
- **`docs/v2/FINDINGS.md`** — A3-C1 re-closed against this ADR with the mutation table; R4-1a/1b/1d,
  R4-2a, R4-3a, R4-4a, R4-7b inverted; F-5 marked *narrowed, still owed*; **I-2 promoted** (§8.2);
  A3-M5 marked as required in the same pass (§8.5); I-6 unchanged.

---

## 12. What downstream agents must not change without a new ADR

1. **`board.json` is written first in `persistNow`, and it is the commit point.** Nothing written
   after it may ever be needed to reconstruct content.
2. **`lineageId` and `gen` are frozen in both files, forever.** A future envelope version must still
   be legible to this build for exactly those two fields.
3. **`_v2` in `board.json` holds `{lineageId, gen}` and nothing else.**
4. **The verdict is one equality.** Do not add a second condition to `adoptable()`. If a second
   condition seems necessary, the reconciler is wrong, not the gate.
5. **The reconciler is a diff, never a wholesale replace.** `planReplaceAll` at init resets every
   stamp on every launch.
6. **The clock is advanced past every LIVE stamp in the loaded log before any op is minted.**
   Without it the reconciliation silently loses to LWW and R4-4a is back with no warning anywhere.
   **Amended 2026-08-27 (R5-2e):** this is a *precondition for adoption*, not an instruction to
   try. A log whose stamps are beyond `MAX_FUTURE_DRIFT_MS` cannot satisfy it and cannot be made
   to — ADR 001 §1.3 and §7.4 both refuse — so it is quarantined as `clock-skew` and deferred
   (§7.1). Minting below the log's stamps and hoping is what this rule forbids, and that has not
   changed. **Amended 2026-08-27 again (round 7 / R6-4):** the word is **LIVE**. This rule is
   about the stamps a mint is COMPARED AGAINST — register cells, the checkpoint horizon, and live
   lines. A parked op is in no register and is compared against nothing, so it neither needs to be
   minted above nor may block adoption; see §7.1's round-7 amendment for what reading it as "every
   line" cost.
7. **The post-condition (R4) may not be removed as redundant.** It is what makes every other failure
   in this file degrade to "history lost, content kept".
