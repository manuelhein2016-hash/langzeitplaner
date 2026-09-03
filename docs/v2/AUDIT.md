# LangzeitPlaner v2 — INDEPENDENT AUDIT

**Tree:** `92545df` · **Audited:** 2026-09-03/04 · **Auditor:** synthesis pass over five independent
audit passes, all load-bearing claims re-measured in this tree.

**Nothing was fixed.** No file in `src/`, `server/`, `shell-macos/`, `src-tauri/` or any existing
test was modified. New evidence files live under `tests/audit/` and are wired into no npm script.

---

## THE VERDICT

**Ship the solo product. Do not ship the Familienkreis yet — and today you could not even if you
decided to, because `SYNC_ORIGIN_BUILTIN` is the empty string in both shells and no release gate
names it.** The engineering here is genuinely strong: I reproduced the 27-launch acceptance run
against the shipped `.app` and a real out-of-process relay (80 rows, 0 phases failed, refusal
ledger 0, a founder receiving a joiner's entry, a founder-less removal with key rotation), and the
redaction boundary held again under 970 attack rows. But the family feature has a defect class
that every one of this project's 5,612 green rows is structurally blind to: **a quit-and-open
turns ops into registers, and four things a fold reads from ops are never rebuilt.** The worst of
them kills story 18.2 — *"Familie darf bearbeiten"* — from the second launch onward, for every
family, with no attacker and no unusual setup, while the app still offers the gesture. That is not
covered by the acceptance battery either: the 27-launch driver has **no co-edit phase at all**.
Separately, the Datenschutz screen — the one surface whose entire job is that trust is informed
rather than marketed — carries **three false sentences**, two of which the product contradicts in
its own shipped copy one module over. None of that is expensive to fix; all of it is between a
person and a working calendar. **My recommendation: cut a solo-only release now, hold the
Familienkreis for one fix cycle covering the four compaction findings and the privacy copy.**

---

## 1 · THE NUMBERS, AS I MEASURED THEM

Every suite re-run by me in this tree, read-only.

| suite | command | measured | PO's figure |
|---|---|---|---|
| tier 1 | `npm test` | **2229 pass · 0 fail** (186 suites) | 2229 ✓ |
| property | `npm run test:property` | **101 pass · 0 fail** | 101 ✓ |
| attack | `npm run test:attack` | **970 pass · 0 fail** (184 suites) | 970 ✓ |
| server | `npm run test:server` | **1002 pass · 0 fail · 1 skip** (1003 tests) | 1002 ✓ |
| fleet | `npm run test:fleet` | **435 pass · 0 fail** (100 suites) | 435 ✓ |
| tier 2 (DOM) | `npm run test:dom` | **875 pass · 3 fail**, 55 files, isolation guard green | 875/3 ✓ |

**Total: 5,612 rows.** **Every number in the brief is accurate.**

**Counting convention.** The tier-2 figure is the sum of the runner's own per-file `# pass` lines.
The runner launches one process per file, so each file emits its own TAP summary; summing them is
the only correct total. Counting top-level `ok N` lines instead gives **911** here, because a
suite header prints an `ok` of its own alongside the subtests it contains. I used the `# pass`
convention throughout — the same one V2-FINAL §2 identifies as correct.

The three tier-2 reds are exactly the named residuals and nothing else:

```
not ok 4 - §A4 · every ink E8 puts on the board at 9 px, against every ambient shade
not ok 1 - §E1 · build, render, member toggle, scroll and find — against one 16.7 ms frame
not ok 5 - §E3 · how much of the family reaches the paper at all
```

**Two things the headline numbers hide,** both benign but worth stating:

- **36 tier-2 skips** are unreported by V2-FINAL §2/§10, which give pass/fail only. All are
  self-describing (files owned by the two external drivers, or needing `LZP_SYNC_ORIGIN`). I ran
  both drivers; nothing is uncovered by the skips.
- **The 1 server skip is `prisma :: the contract against a real PostgreSQL`** — the production
  database driver is executed by no suite in this configuration.

**Acceptance driver, reproduced by me** (`node scripts/shell-family-e2e.mjs`, exit 0):

```
27 launches of the shipped .app · 80 rows · 0 phase(s) failed
attempted, not required: unshare-owner (B) — completed
THE REFUSAL LEDGER: 0 across 8 reporting launch(es)
THE FOUNDER RECEIVED A JOINER'S ENTRY: YES
transport reported by the running family engine: bridge
founder-less removal authorizedBy=admin_proof · epoch 5 → 6
relay store (a process sharing no code with the page):
  spaces 1 · epochs 6 · ops 1 · members 4 · devices 4 · keyWraps 34 · invites 3 · pairs 0
```

**Zero npm dependencies** is true **at the repository root** — `dependencies: {}`, one
devDependency (`@tauri-apps/cli`), `node_modules/` absent. `server/package.json` declares
`@prisma/client` 6.19.3 (runtime) and `prisma` 6.19.3 (dev), with 28 top-level packages installed.
`RELEASE-CHECKLIST.md:105` states the scope correctly; the summary sentence drops it.

---

## 2 · WHAT IS GENUINELY GOOD

An audit that only lists problems is not an honest audit. These are real results and several of
them are unusual.

**The redaction boundary has produced zero bytes of a Privat entry across eight adversary rounds,
and it is structural rather than policed.** I re-ran the 970 attack rows and drove the renderer
directly: a Geteilt→Belegt downgrade arriving incrementally takes the text out of the DOM *and*
out of the `title` attribute; an eight-render chain over six withdrawn strings leaves 6/6 gone;
the redacted PNG emits **0 strings outside `role`** and none of the withdrawn words. A Privat
entry produces *zero* family ops, not a redacted one — the guarantee is an absence of bytes, not a
filter that could be bypassed.

**Principle 9 is enforced by the absence of a distinguishing byte.** There is no op kind for a
read receipt, a presence signal, or a visibility-change notice — `NO_SNITCH_CONTRACT` states the
four clauses and the enforcement is that nothing implements them. `retractPatch(kind)` takes the
kind and nothing else, so an owner's own downgrade and an admin's unshare are **byte-identical on
the wire**. A peer cannot tell which happened. That is a stronger design than any policy check.
(Method note: my first draft of this check grepped the raw files and went red twice — both times
on a *comment stating the guarantee*. The code is clean; the naive grep was wrong. Pinned in
`tests/audit/synthesis-reconciliation.test.js` §5b, which strips comments before scanning.)

**Principle 10 held where it could most easily have eroded.** No comment, reaction, chat, thread
or reply feature exists. The one conflict surface is `pointer-events: none` — "it is not
clickable, so it cannot become a conversation." The feedback channel is one-way to the relay and
cannot reach another member.

**Principle 7 — solo mode costs nothing — is measured, not asserted.** A solo launch evaluates
**0 of the 41 modules** behind the family door; I verified the gate itself
(`if (!hasPersonal && !hasCircle) return;`). A whole solo session in the shipped `.app` makes
**0 `sync_request` and 0 `fetch`** — reproduced in my own acceptance run, phase E. Solo
performance is 1.1 ms `buildBoard`, 0.9 ms `renderBoard`; the §E1 frame overrun is family-mode
only.

**Zero dependencies across 5,612 rows** is a real achievement and it is guarded
(`suite-integrity.test.js:130`). The tier-2 suite runs in a real WKWebView driven by a Swift shell
built from source, with per-file process and scratch isolation, a WebKit bundle-id isolation
scheme, and a fingerprint guard proving the user's real board was untouched — which passed.

**The v1 characterization suite genuinely holds.** I extracted the original files as of `328c683`
and ran them unmodified at HEAD: **436/437 tier-1** and **112/112 tier-2**. The store, the layout
model and the render path all survive the op log, the incremental renderer, the family layer and
the every-launch migration. That is the strongest evidence in the repository that v2 did not break
v1.

**The join parser and the invitation copy are careful work.** `parseInvitePaste` blanks URLs before
scanning for a code, requires shape/label/grouping evidence, refuses to truncate a 13-character
paste into a confident wrong code, and trims German punctuation before `new URL`. The mail names
the Gatekeeper wall *before* the person meets it, uses Apple's own German button names, and
carries no remote resource or tracking pixel. `mom-test-probe.mjs`: 35 rows, 33 pass, 2 note, 0 FAIL.

**The residual list is mostly honest.** Where the team declared a deviation open — R-1b, R-8b,
T5-M1a, T5-M2 — I found it still open and still declared, not quietly closed. `PROVES` /
`PROVES_NOT` strings say exactly what the code checks; I verified `admin_proof` and `sole_member`
line by line against their implementations.

---

## 3 · FINDINGS, RANKED BY WHAT THEY COST A PERSON

Severity is what it costs a person, not how hard it was to find. **BLOCKS** means I would not ship
the affected feature with it open.

---

### F1 · ⛔ BLOCKS FAMILY · The shipped build cannot sync at all, and no release gate says so

**What it is.** `syncOriginSetting()` has exactly three sources. Two are `isHeadless`-gated, so a
production launch reads `SYNC_ORIGIN_BUILTIN` — which is `""` in **both** shells
(`shell-macos/main.swift:770`, `src-tauri/src/lib.rs:696`). The empty string cannot normalise to
an https origin, so `pinnedSyncOrigin()` returns a refusal and **every `sync_request` is refused
locally**. The page cannot route around it: `chooseTransport` returns `bridge` inside the shell and
`index.html:14` is `connect-src 'self'`. The shell's own comment concedes it — *"the ordinary
tier-2 run exercises the REFUSAL path."*

**How it was measured.** Read both constants; traced `syncOriginSetting → normalizeSyncOrigin`;
grepped both release documents. `SYNC_ORIGIN_BUILTIN` appears **0 times** in
`RELEASE-CHECKLIST.md` and **0 times** in `V2-FINAL.md`. Pinned:
`tests/audit/synthesis-reconciliation.test.js` §1a–§1c.

**Why it is worse than a to-do.** The checklist *does* force the PO to substitute the relay address
into the four invitation mails. Work §A top to bottom and you ship a binary in which the address
you were just made to substitute **is read by nothing** and no family can sync — having passed
every gate.

**Owner:** PO (release) + shell owner. **Blocks:** the Familienkreis. Not solo.

---

### F2 · ⛔ BLOCKS FAMILY · A quit-and-open silently kills co-editing, for every family, for ever

**What it is.** `_persistOps` ① skips every line at or below the horizon; a checkpoint folds those
ops into registers and drops the LINE. After the first quit-and-open of a converged circle the log
holds **8 registers and 0 lines** — `ops.jsonl` on disk is empty. `authz.js` stage 3a then builds
`govRegs` with `emptyRegs()` and folds **only the `pub.set` ops in this fold**, so the owner's
`pub.coEdit` grant is invisible and stage 3b refuses every co-editor write `noCoEdit`. `NO_COEDIT`
is absent from `CURABLE_REFUSALS`, so the op is not even parked — the line is dropped and the
relay's `since` cursor has moved past it. **Terminal.**

**How it was measured.** `tests/audit/compaction-sweep.test.js` §1, on the real fleet rig with a
real relay, real `sealOp` and the shipped `store.applyCoEdit`. §1a is a green control.

```
§1b  Oma quits and opens once. Mama co-edits.
     Papa reads "Nordsee" · Oma reads "Herbstferien" after 4 syncs · parkedOps []
     store's own warning: "remote op … refused: noCoEdit"
§1c  once all three have relaunched — the steady state after day one —
     {papa:"Herbstferien", mama:"Nordsee", oma:"Herbstferien"}
     the co-editor is the only person who can see her own edit
```

**Why 5,612 green rows cannot see it.** I verified the coverage hole myself: `grep -c relaunch` is
**0** in every co-editor and removal rig this product has — `e9-attack-coedit`,
`e9-attack-moderation`, `e9-attack-restore`, `e6-removal`, `e6-gate-removal`, `e6-attack-removed`,
`e6-gate-privat`, `e10-fleet-board`. And **the 27-launch shipped-app acceptance battery has no
co-edit phase at all** (`grep coEdit scripts/shell-family-e2e.mjs` → nothing). Nothing in this
project exercises a co-edit after a relaunch. Pinned: `synthesis-reconciliation.test.js` §4a, §4b, §4d.

**What makes it expensive.** The door still opens: `familyCoEditLevelOf` reads `store.registers()`,
which *does* retain the grant, so the checkbox and the editable field are still offered. The
co-editor types, sees her own text, and is told nothing. The receiving Macs move a sync glyph; she
gets no signal whatsoever.

**Owner:** `core/authz.js` + `store.js` (one owner's file). **Blocks:** story 18.2.

---

### F3 · ⛔ BLOCKS FAMILY · After a relaunch a removal stops being enforced, and a re-join publishes what it hid

**What it is.** The same absorption, one register over. Stage 2 derives `currentMembers` from a
**fresh** fold of the ops in this fold. `_absorbedAttestOps` rebuilds every `dev.*` cell — so every
member's record exists again — but rebuilds **no `_alive` cell**. A removed member is alive again
inside the fold, and her post-removal write is admitted, folded and persisted.

**How it was measured.** `compaction-sweep.test.js` §2. §2a (control, no relaunch) refuses it
`notMember`; §2b (one quit-and-open) admits it. §2c drives the re-join: **`WAEHREND DER ENTFERNUNG`
appears on the board**; §2d is the control showing it never does without the relaunch.

**Why it is not yet catastrophic.** `materialize`'s render-time `currentMembers` filter still hides
it *today*, so the board is right until the re-join. Two layers of defence became one — and
`store.js#_withdrawalsOf`'s own docblock names this exact hazard as owed: *"the two mechanisms must
be designed together or a re-join will resurrect what the other one hid."* It is no longer
hypothetical.

**Caveat I am keeping.** §2 publishes `member.set{_alive:false}` deliberately to isolate the authz
layer from `family/removal.js`'s epoch rotation. I did **not** test whether key rotation
independently blocks a removed member in the field. The finding as stated is that *the fold's
`notMember` gate disappears after a relaunch* — whether the crypto layer alone is sufficient is a
question this audit did not answer, and it should be answered before this is priced.

**Owner:** `core/authz.js` + `store.js`. **Blocks:** story 20.2.

---

### F4 · ⛔ BLOCKS FAMILY · The exposure badge under-reports what others can see, on every launch after the first

**What it is.** `_exposureCtx()` walks `this._log.lines()` to answer `lastAckedPubLevel(fkey)` —
and lines are exactly what a persist absorbs. `materialize.js#exposureOf` reads
`ctx.lastAckedPubLevel(fkey) || 'privat'`.

**How it was measured.** `compaction-sweep.test.js` §4. Papa shares his own entry through the
shipped `store.txn('set-visibility', …)`. Before the quit: `visibility 'geteilt'`,
`exposure {level:'geteilt', pending:false}`. After one quit-and-open: `visibility 'geteilt'` — the
family still sees it — and **`exposure {level:'privat', pending:false}`**. Not even flagged
pending, because the same empty walk makes `pendingPub` false.

**Why this one is a principle violation, not a bug.** ADR 004 §6, quoted in the code directly above
that function: *"The badge must never promise a privacy state that has not yet reached the
server"*, and its account of the two error directions ends *"the badge never UNDER-reports what
others can see."* This under-reports it. Addendum principle 8 is *"the user can always see at a
glance exactly what others can see of them … No accidental oversharing, ever."* A person looking at
her board sees "Privat" on an entry the whole family can read.

**Owner:** `store.js#_exposureCtx`. **Blocks:** story 16.6.

---

### F5 · ⛔ BLOCKS · The Datenschutz screen states three things that are false

This is the one surface whose entire job is that *trust is informed, not marketed* (21.3). It is
copy, it is cheap to fix, and it is the reason a careful person would feel misled.

**(a) It promises a solo Mac an exception the code disables.**
> „Genau eine Ausnahme gibt es, und sie geschieht nur, wenn du sie auslöst: die Rückmeldung unter
> ‚Hilfe'. **Von allein sendet dieses Programm nichts.**"

Measured: `setFeedbackPort` is called from exactly one shipped module, `family/mount.js`, reachable
through exactly one dynamic `import()` in `main.js`, behind
`if (!hasPersonal && !hasCircle) return;`. **A solo Mac never mounts it and cannot send.** The
product ships the true sentence one module over, in `feedback/copy.js#noRelay`: *„Solange du keinen
Familienkreis nutzt, gibt es keinen Server, an den etwas gehen könnte."*

**(b) "Von allein sendet dieses Programm nichts" — while `boot()` arms a bare interval.**
`main.js:110-111` runs `runLaunchCheck(); startDailyTimer();` on every launch of every install,
solo included. `startDailyTimer` is a bare `setInterval` dispatching `updater.checkDaily()`. The
same screen then says, thirteen blocks later, *„Etwa einmal täglich fragt die App-Hülle … bei
GitHub nach"*. **Both sentences are on one screen, in both languages.** The shell's own comment
calls it *"The one network request in the whole product's solo mode."*
Today no packet leaves — but for a reason that will not survive the first release: in
`updaterFetchManifest` the two 21.5 consent gates are checked **before** the `OWNER-PLACEHOLDER`
refusal. **21.5 is vacuously true only because F22 has never been configured.**

**(c) It tells a person a board-only backup cannot restore her data. It can.**
`lossBody`: *"…und du keine Sicherung **mit Passwort** hast, kann niemand deine Daten
wiederherstellen."* The README written **inside** the passphrase-less export says
*„Sie stellt dein Board wieder her."* — and `backupBody`, three paragraphs above `lossBody` on the
same screen, already says entries are readable in the clear on both paths. The condition should be
"no backup", not "no password-protected backup". **This is the one with a data-loss shape**: a
person holding a board-only export is told it is worthless.

**(d) „…lässt sich ablesen, DASS jemand etwas geändert hat — nicht, was."** `LOG_FIELDS` allows
`route`, `spaceId` and `deviceShort` in the same line, and `route` is a closed enum containing
`removeMember`, `transferAdmin`, `renameSpace`, `deleteSpace`. `server-metadata.md` §7 states this
in the same words — *"**The log line names the event**"* — and the screen states the opposite.

**How it was measured.** `synthesis-reconciliation.test.js` §2a–§2f, plus a live
`ROUTE_NAMES`/`LOG_FIELDS` import. **Owner:** PO (copy) — `settings.js` only.

---

### F6 · HIGH · Story 17.5's "neu" dot has never lit on any real board

**What it is.** `materialize.js#isNewOf(ctx, …)` needs one of `ctx.seqOf` / `ctx.isNew`; with
neither, its only reachable exit is `return false`. `store.js#_project()` supplies `me`,
`familySpaceId`, `_memberCtx()`, `_exposureCtx()`, `defaultSettings` — and **none of `seqOf`,
`isNew`, `lastSeenSeq`, `levelDecreased`**. No producer for those hooks exists anywhere in
`src/js`.

**How it was measured.** Read `_project()` directly; `grep` for producers across `src/js`; and two
independent audit passes measured `isNew: false` on an entry that arrived seconds ago. Pinned:
`synthesis-reconciliation.test.js` §4e.

**What it costs.** Everything downstream is wired and blameless — `board.js` appends the dot,
`layout.js` gates it on `foreign`, `app.css` styles it, `settings.lastSeenSeq.<spaceId>` exists as
a pref. One call site is short of joining them. Addendum principle 10 is *"Changes from others
arrive quietly (a small 'neu' marker, 17.5) … you notice when you look."* **That mechanism does not
exist on a real board**, and the fleet row `e10-fleet-board §17.5` is green while the defect exists.

**Owner:** `store.js#_project()`. **Blocks:** no — it is a missing feature, not a wrong one.

---

### F7 · HIGH · A peer's change discards the user's uncommitted typing (P3)

**What it is.** `board.js:615` — `if (rec.padTa.value !== col.pad) rec.padTa.value = col.pad;`.
`main.js:91` skips a redraw only for reasons `pad` and `select`; a peer's ops folding in emit
`'remote'`, which redraws. Scratchpad text commits on a 600 ms pause or on blur.

**How it was measured.** `tests/audit/display-integrity.dom.js` §D3, in a real WKWebView: 51
characters typed, still uncommitted (`store.state.scratchpads['2026-01'] === undefined`); one
render later, same node, **still focused**, `value === ""`.

**Why the existing row does not cover it.** `e1-incremental.dom.js` §I4 pins the reset as correct
on the grounds *"a full rebuild reset it; so does this one."* That equivalence was true in v1,
where every redraw came from a gesture of the user's own — and every such gesture moves focus out
of the textarea first, so `commitPad` had already run. **`'remote'` needs no gesture and no focus
change.** v2 added a caller v1 did not have.

**Standing principle P3 — "the user's own ink wins" — outranks tickets.** It is not undoable: the
text was never committed. Solo mode is unaffected, so P7 holds.

**Owner:** `board.js` / `main.js`. **Blocks:** story 10.2 in family mode.

---

### F8 · HIGH · The year pager leaves a stale date on a repeating note, and a no-op drag becomes a published write (P10)

**What it is.** `board.js:noteSig` covers id, colour, five flags, initial, exposure and text —
**but `renderNote` also writes `node.dataset.date = d.date`**, which the signature does not cover.
`entities.js:noteOccurrences` pushes the *same note object* once per year, so occurrences share
`note.id`; `patchBody` keys on that id and keeps the node. A year page turn (`#pg-next`, wired at
`main.js:317`) then shows a note whose `data-date` is a year out.

**How it was measured.** `display-integrity.dom.js` §D1/§D1b/§D2, in a real WKWebView:

```
page 1: .note says 2026-03-12, the row it is in says 2027-03-12
outerHTML vs full rebuild: NOT equal, first diff at char 11400
5 of 6 year pages carry a stale date
```

**What it costs.** `interact.js:371` reads `fromDate: noteNode.dataset.date`; `:567` commits
`moveNote` when `drag.target !== drag.fromDate`. `drag.target` comes from the day row and is
correct. So after a page turn, **picking a repeating entry up and putting it back on the same day
reads as a move** — an op in the log, a step on the undo stack, and, on a shared entry, a
`pub.date` published to the whole circle for a day on which nothing happened. **P10: the board is
not a messenger.** `reanchorRepeat` means the resulting date is unchanged, so the damage is a
phantom write, not a wrong date.

**This also falsifies LZP-1007's single stated invariant** — *"the same DOM, node for node,
attribute for attribute"* — which `e1-incremental.dom.js`'s 89 cells do not catch because they are
a **fixed sample** (`let seed = 20260903`). Replaying e1's own PRNG over 20 000 draws: the
triggering transition (two consecutive pinned windows sharing a month, differing in year) occurs in
**6.47 %** of pairs. A property that holds at 89 sampled points is not an invariant.

**Caveat.** §D2 asserts the precondition at the point where it is checkable rather than driving a
pointer through real hit-testing. The mechanism is proven; the end-to-end gesture is not.

**Owner:** `board.js#noteSig`. **Blocks:** no, but it is the highest-value non-blocking fix here.

---

### F9 · MEDIUM · The moderation path is lost on a bystander's Mac after a relaunch (R-1b, now priced)

`_absorbedChainOps` rebuilds a link only when `cell.author === cell.value` — genesis only, verified
verbatim in the source. A transfer's cell has `author = outgoing admin`, `value = incoming`, so no
chain is rebuilt, `adminAtKey` answers `null`, and stage 3a refuses `notOwner` — in neither
`CURABLE_REFUSALS` nor `RETROACTIVE_REFUSALS`. **Terminal.**

Measured (`compaction-sweep.test.js` §3c): Papa transfers the seat to Oma; **Mama — the entry's
owner and a bystander to the transfer** — quits and opens. Oma unshares. Papa applies it; **Mama
refuses it and still shows `Mamas Eintrag` at `geteilt` after two syncs.** And `store.familyAdmin()`
reads the *register* map, so Mama's UI names Oma as admin throughout: the app looks entirely healthy
while the moderation silently does not apply.

This is the already-declared residual **R-1b**. The audit's contribution is that the victim is not
who the residual note implies — it is a bystander owner, not a participant in the transfer.
**Related:** `store.js:4706` still carries the sentence V2-FINAL R-1b explicitly retracted —
*"No shipped circle transfers the seat yet."* — while `adminpanel.js#transferAdmin` and
`leavedelete.js`'s `port.transferAdmin(...)` both ship. A maintainer at the seam reads a retracted
claim. **Owner:** `store.js`. **Blocks:** story 18.3 after a transfer.

---

### F10 · MEDIUM · Two honest co-editors can silently collapse a shared bar to one day (18.5)

The shipping row `tests/fleet/e9-attack-restore.test.js:256` asserts the outcome and its own
comment concedes it: Mama pulls the right edge in, Oma pushes the left edge out, both gestures legal
where made, and the registers fold to `start 2027-03-01 / end 2026-11-01`. `materialize#repairInterval`
then projects the bar collapsed onto its later-stamped edge — **an eight-month "Sommerferien"
becomes one day** — and per-field LWW displaced neither author, so 18.5 has no loser to notify.
**Nobody is told.** 18.5's contract is *"only the person whose in-flight edit lost sees a quiet
inline notice."* Here neither author's plan survives as a range and neither is told. The file
header at `:37` still calls this OPEN while the row at `:256` calls it CLOSED; both are in the tree.
**Owner:** PO decision + `materialize.js` / `family/conflict.js`. **Blocks:** no.

---

### F11 · MEDIUM · A peer's new bar can arrive with no mark of any kind (17.4/17.5)

`layout.js` counts `hiddenNew` over **notes only**, while `hiddenCount` covers notes *and*
`laneOverflow` (3.8's per-day lane cap). A dropped bar segment is counted into the "+n" badge's
digit and never into `overflowNew`. Measured (`display-integrity.dom.js` §D6): with lanes taken,
Mama's brand-new shared bar yields **`bars drawn=3`, „neu" dots board-wide `0`**, and the day's only
mark is `+1 · 1 weitere Balken` — indistinguishable from a badge hiding one unchanged thing.
`e8-density-crowding.dom.js` §B5 closed this for notes and left it open for bars.
**Owner:** `layout.js`. **Blocks:** no.

---

### F12 · MEDIUM · The release record disagrees with the tree in five places

Each verified by me and pinned in `synthesis-reconciliation.test.js` §3.

| the record says | the tree says |
|---|---|
| `V2-FINAL` §9: **LZP-1009 NOT BUILT**, points `—` | it ships. `server/core/handlers/feedback.js`, `family/mount.js#bindFeedback`, `feedback` in `ROUTE_NAMES`. The *same file* at :340 says *"LZP-1009 gives a solo Mac an outbound path."* |
| `V2-FINAL` R-7b: *"no join has ever run over the `sync_request` bridge"* | **false.** `shell-family-e2e.dom.js:303` drives the real join screen and asserts `POST /api/v1/invites/redeem` crossed `sync_request` with `WIRE.fetch` empty. **It passed three times in my own acceptance run.** |
| `server-metadata.md` §7.4 + three shipped comments: *"a closed enum of 23 verbs"* | `ROUTE_NAMES.length === 24` (feedback is the 24th). V2-FINAL §1 correctly says 24. |
| `traceability.json` `v1Oracle`: `"filesChanged": 0` | `git diff 328c683..HEAD` shows **3** of the 11 oracle files changed. One (`store-persistence.test.js`) narrows an assertion to accept a *changed v1 behaviour*. The original file is red at HEAD on exactly that row: `not ok 5 - mutate() (5.4)`. The change is defensible; **absorbing it by editing the oracle rather than recording a v1 deviation is not.** |
| `RELEASE-CHECKLIST.md` §G + `E10-VERIFICATION.md` §2: *"`Frankfurt`, `Vercel`, `Prisma` appear nowhere in `src/`"* | all three are in `settings.js` (15 hits, both languages). `E10-VERIFICATION.md:491` says the opposite in the same file. |

Also: the brief's ticket count (**67/68, 236/239**) matches neither `V2-FINAL.md:593`
(**68 of 69 · 239 points**) nor the corrected count once LZP-1009 is credited (**69 of 69**).
`traceability.json` story `21.5` still carries the **pre-D10 text** and `amendedBy: []`, while
story `13.4` in the same file carries `amendedBy: ["A1"]` — so the field is in use and D10's own
warning (*"amending a measured property … must not be findable only as a diff"*) is defeated for
anyone reading the machine-readable record.

**Owner:** PO / doc owner. **Blocks:** no, but F12 is why the other findings were not caught: the
record is what a ship decision leans on.

---

### F13 · ⛔ BLOCKS FAMILY · The relay address in all four invitations belongs to nobody, and the gate that should catch it asserts the placeholder

Measured live: `https://lzp-sync-po.vercel.app/api/v1/meta` → **HTTP 404,
`x-vercel-error: DEPLOYMENT_NOT_FOUND`**. That origin is in all four shipped invitation files.

`deriveInvite(code)` is pure — `inviteId` and `proof` are HKDF of the code with no salt, nonce,
origin or timestamp — and `SHA-256(proof) === verifier` is the whole of the relay's check. So a
joiner's first request to a wrong host hands over, in the clear, a token that redeems that invite
against the **real** relay unchanged, plus her device signing and KEX public keys and her IP. There
is no relay pinning. D9 still holds (a fake relay mints no epoch key and reads nothing); the damage
is a burnt invite, a stolen seat, and a person told she joined a family that does not exist.

**And the gate reads backwards.** `scripts/mom-test-probe.mjs:67` hardcodes
`const RELAY_ORIGIN = 'https://lzp-sync-po.vercel.app'` and row M2 asserts `parsed.origin ===
RELAY_ORIGIN`. `RELEASE-CHECKLIST.md` §B lists `mom-test-probe.mjs → exit 0` as a per-release gate.
So **green currently means "nobody has substituted the address yet"**, and substituting the real one
turns the gate red as if it were a regression.

**Owner:** PO (claim the host) + whoever substitutes must edit `mom-test-probe.mjs:67` and
`tests/tier1/createjoin.test.js:61` in the same commit. **Blocks:** the Familienkreis.

---

### F14 · MEDIUM · F22 has never executed, and the release notes promise something that cannot happen

`git tag` → **0**. `git remote` → **empty**. `release.yml` has never run.
`UPDATE_MANIFEST_URL` = `OWNER-PLACEHOLDER`, `UPDATER_PUBLIC_KEY_B64` = `""` (so no build can
install any update — correct fail-closed behaviour, but delivery has never worked end to end), and
the production Tauri DMG has never been built, so the ≈15 MB budget gate has never run.
`check-release-config.mjs --strict` exits 1 with 2 problems.

The GitHub Release notes written by `release.yml:460-465` say *„Beim ersten Start führt die App
durch die Freigabe in den Systemeinstellungen."* The auto-showing unlock screen **never fires**:
`gatekeeper_status` is implemented in neither shell, so `probeHost()` returns `supported:false` —
and while macOS blocks the app, the app is not running. That page is reached by the person whose
`.dmg` attachment was stripped by her mail provider, i.e. the one with *fewest* instructions.

Two smaller ones on the same path: the built disk image has **no `.DS_Store`**, so the Finder
window the invitation illustrates with a picture does not exist (and `release.yml` gate 10 makes a
missing `.DS_Store` a **hard release blocker**, so the two reachable states are *no release* or *a
release whose window nobody has seen*); and `Bitte zuerst lesen.html` is built but **is not on the
image** — the only surface that reaches a person at the blocked moment is step 3 of the e-mail.

**Owner:** PO. **Blocks:** the update channel, not the app.

---

### F15 · LOW · Things worth knowing, not worth blocking

- **`withoutForeignEntries` is blind to the file format solo mode writes.** It recognises a foreign
  entry by `isForeign` or an `f…` entity key; `stripV2Fields` removes both markers and keeps `id`,
  which still spells `fnote:<memberId>/<uuid>`. Not live — a family Mac persists the full v2 board,
  where the markers are present — but it is a defence-in-depth guard with a blind spot.
- **The spine authors an owner's Geteilt entry at `visibility:'privat'`.** Neutralised twice over
  today (the spine's ops are never appended on an ordinary launch), but it is one edit away from a
  silent unshare of a whole board.
- **`board.json` on a family Mac is the full v2 state** — `ownerId`, `entityKey`, `updatedBy`,
  `_born` (whose tail is the device short). Everything ATT-80/81 keeps out of the *export* is in
  the *persisted file*. It never leaves the Mac; this is about the blast radius of a stolen disk.
- **`RUNBOOK.md` §3.3 routes the `noRing` sentence to §5.2** (a joiner waiting — advice: wait),
  with no cross-reference to §5.1. **A family past the epoch wall that has just invited somebody
  presents identically**, and that wait never ends because rotation is unperformable.
- **`build/email/` is gitignored and no checklist row regenerates it.** Before I rebuilt it, the
  German text file on disk was the edition **without the relay address**. A stale `build/` is a
  silent way to send last week's mail.
- **Every unlock instruction shipped is written for macOS 15**; the product declares
  `minimumSystemVersion 12.0`. Nothing branches on the version.
- **Two documents give the Prisma contract run different numbers** — `RUNBOOK.md` §2.6 says *65 of
  66*, `RELEASE-CHECKLIST.md` and `V2-FINAL` say *66 of 66*. Not adjudicable here (no reachable
  Postgres); the runbook is the copy an operator reads and it holds the minority value.

---

## 4 · THE STORY TABLE — ALL 130

**108 PASS · 11 FAIL · 10 UNVERIFIABLE · 1 NOT-IMPLEMENTED**

Basis for v1: the **original** characterization files extracted from `328c683` and run unmodified
at HEAD (436/437 tier-1, 112/112 tier-2). Basis for v2: the fleet and DOM suites, the 27-launch
acceptance run I reproduced, and the compaction rows.

### v1 — F1–F14, 79 stories

| Stories | Verdict | Evidence / note |
|---|---|---|
| 1.1–1.6, 2.1–2.5, 3.1–3.8, 4.1–4.6 (25) | **PASS** | original T1+T2 rows, green at HEAD |
| 5.1, 5.2, 5.3, 5.4, 5.5 | **PASS** | 5.4 carries one admitted v1 behaviour change (F12) |
| 5.6 | **UNVERIFIABLE** | headless window renders all 12 columns; edge condition unreachable |
| 6.1–6.6 (6) | **PASS** | incl. Easter vs. independent Gauss 1900–2200 |
| 7.1–7.5 (5) | **PASS** | 7.4 carries the known 8–9-day horizon/label disagreement |
| 8.1, 8.2, 8.3, 8.4 | **PASS** | 8.2's *live* self-advance is not automatable |
| 8.5, 8.6 | **UNVERIFIABLE** | real clock crossing · 300 ms transition + Reduce Motion |
| 9.1–9.6 (6) | **PASS** | incl. Feb-29 century rule. **See F8** — yearly repeats carry the stale-`data-date` defect |
| 10.1, 10.4, 10.5 | **PASS** | 10.5's 5-line CSS cap unasserted |
| **10.2** | **FAIL** | **F7** — a peer's op discards uncommitted scratchpad typing (P3). Family mode only |
| **10.3** `[Could]` | **NOT-IMPLEMENTED** | no drag source in `src/`; declined in `DESIGN-DECISIONS.md` |
| 11.1–11.7 (7) | **PASS** | 11.4 now writes six files; ADR 006 makes `board.json` the truth. Atomicity itself unproven |
| 12.1, 12.2, 12.3 | **PASS** | print CSS lifted verbatim via CSSOM |
| 12.4 | **UNVERIFIABLE** | `NSPrintOperation` is modal |
| **13.4** | **FAIL / superseded by A1** | the app does make requests; successor 21.5 also fails |
| 13.1, 13.2 `[Could]`, 13.3, 13.5 | **UNVERIFIABLE** (4) | native window frame · `NSStatusItem` · `SMAppService` · app lifecycle |
| 13.6, 13.7 | **PASS** | full §9 keymap present; no test enumerates the map (coverage gap) |
| 14.1, 14.2 `[Could]` | **PASS** | store-wide hits, click pins the month |

**v1: 68 PASS · 2 FAIL · 8 UNVERIFIABLE · 1 NOT-IMPLEMENTED.**

### v2 — F15–F22, 51 stories

| Stories | Verdict | Evidence / note |
|---|---|---|
| 15.1–15.6 (6) | **PASS** | fleet §15.x + bridge rows; 15.3 verified through the real join screen in my run |
| 16.1, 16.2, 16.3, 16.4, 16.5, 16.7 (6) | **PASS** | fleet §16.x + `sharing-control.dom.js`, `belegt-render.dom.js` |
| **16.6** | **FAIL** | **F4** — the badge reads Privat for every shared entry after the first relaunch |
| 17.1, 17.2, 17.3, 17.6, 17.7 `[Could]` (5) | **PASS** | 17.7 is device-local and does not travel |
| **17.4** | **PASS**, with F11 open | density rules hold; a dropped *bar* carries no „neu" mark |
| **17.5** | **FAIL** | **F6** — the dot never lights on any real board; no producer for the ctx hooks |
| 18.1, 18.4, 18.6 (3) | **PASS** | 18.4's undo isolation verified |
| **18.2** | **FAIL** | **F2** — co-editing dies on the second launch, silently, for every family |
| **18.3** | **FAIL** after a seat transfer | **F9 / R-1b** — a bystander owner refuses the unshare, terminally |
| **18.5** | **FAIL** | **F10** — an inconsistent interval collapses to one day and nobody is told |
| 19.1, 19.2, 19.3, 19.4, 19.5, 19.6 (6) | **PASS** | 19.2's cadence verified at `family/engine.js:244-277`; no sync button anywhere. **19.4 has never run in a shell** — the relay store reads `pairs 0` |
| 20.1, 20.3, 20.4, 20.5, 20.6 (5) | **PASS** | 20.5 (admin cannot see private entries) holds structurally — enforced by encryption, re-verified under 970 attack rows |
| **20.2** | **FAIL** | **F3** — the removal gate is lost after a relaunch; a re-join resurrects what it hid |
| 21.1, 21.2 | **PASS** | eight adversary rounds, zero bytes of a Privat entry, re-measured |
| **21.3** | **FAIL** | **F5** — three false sentences, two contradicted by the product's own copy |
| **21.4** | **FAIL** | GitHub Releases is a third-party service beyond the sync endpoint |
| **21.5** | **FAIL** | **F5(b)** — the exception is two, and the second is a timer; true today only because F22 is unconfigured |
| **22.1** | **UNVERIFIABLE** | the production Tauri DMG has never been built (no Rust toolchain here) |
| 22.2, 22.3, 22.4, 22.5, 22.6, 22.7 (6) | **PASS** (mechanism only) | `UPDATER_PUBLIC_KEY_B64 = ""` ⇒ correct fail-closed; delivery has never worked end to end |
| **22.8** | **UNVERIFIABLE** | 0 git tags, 0 remotes; `release.yml` has never executed |

**v2: 40 PASS · 9 FAIL · 2 UNVERIFIABLE.**

---

## 5 · WHAT WAS **NOT** AUDITED

This section is what separates an audit from a reassurance.

**Not run at all**

1. **The production artefact.** No Rust toolchain on this machine, so `tauri build` never ran. The
   shipped DMG's real size, its Finder layout on a CI runner, and **whether `src-tauri/` compiles at
   all** are unmeasured by anybody. The Rust shell is held to the Swift by two tier-1 rows —
   **reviewed, never executed.**
2. **The Prisma adapter against a real database.** No credentials here. The 1069-row contract run
   and R-8b's transaction-mode pooler are unverified by me; `UNVERIFIED_CLAIMS` entries carry
   `verifiedOn` witnesses, which is evidence a run happened, not evidence of what it returned.
3. **Any TLS round trip.** The https-only rule is proven by 28 refusals and never by one successful
   https request.
4. **LZP-1006 — a real person, on a clean Mac, unassisted.** Nothing in this audit moves it. Report
   it OUTSTANDING.

**Verified in a rig, not in the shipped app**

5. **Every compaction finding (F2, F3, F4, F9).** All ran on the fleet rig — real relay, real
   router, real `sealOp`, one `store.js` evaluation and one `localStorage` image per Mac — not on
   the `.app`. The strongest bridge is that the empty `ops.jsonl` is bytes the store itself wrote.
   `quitAndOpen` keeps the store module in memory, exactly as `tests/helpers/fleet.js#relaunch`
   does; a real process boot re-establishes more from disk, so a real relaunch loses **more, never
   less**. But I did not reproduce these on the shipped binary, and that is the first thing I would
   do next.
6. **F3's real-world exploitability.** The row publishes `member.set{_alive:false}` by hand to
   isolate the authz layer. **Whether epoch rotation independently blocks a removed member in the
   field is a question I did not answer.**
7. **F8's cost as a real gesture.** The stale attribute and the drag-origin read are both proven;
   a pointer was never driven through real hit-testing to produce the phantom op.

**Proofs I did not re-derive**

8. **ADR 001 §5's fold, ADR 002 §4.2's rotation coverage, ADR 004's barriers 1–4.** I confirmed the
   named code paths exist and are shaped as described, and the pinning suites are green here. I did
   **not** independently re-derive the convergence or redaction proofs, and I did not re-run the
   mutants the verification documents cite as their evidence.
9. **The eight adversary rounds themselves.** I re-ran the 970 attack rows and drove the redaction
   boundary at the glass; I did not re-conduct the adversary exercises.

**Structurally unverifiable here**

10. **Ten stories needing a human or a native surface** — 5.6, 8.5, 8.6, 12.4, 13.1, 13.2, 13.3,
    13.5, 22.1, 22.8. Eight of them are an edge-drag, a real midnight, an animation under Reduce
    Motion, a print dialog, a window frame, a menu-bar item, launch-at-login and ⌘W/⌘Q. **None is
    in the op log's blast radius, and none has a recorded human walkthrough. This is the cheapest
    missing evidence in the whole audit — about twenty minutes with the app open.**
11. **Wall-clock fps.** Correctly declared never measured; both harnesses are headless.
12. **Apple's exact German dialog wording** on macOS 12–14 versus 15+ (F15).

**One observation, not a finding.** `tests/tier1/store-persistence.test.js → mutate() (5.4)` was
reported red once by an earlier pass while a WebKit suite ran concurrently, then green on three
isolated re-runs. I did not reproduce it. Recorded because the residual list already carries one
single-sighting flake and one concurrency-caused isolation trip.

---

## 6 · THE PO'S DECISIONS

Stated so they can be decided, not re-explained. Each is a ruling, not a bug.

**D-A · §A4 — the 9 px ink contrast floor.** A tier-2 red by design. `palette.js` is pinned by the
v1 characterization oracle, so raising contrast changes a file the oracle protects. **Decide:**
accept the red as a permanent declared residual, or accept a v1 palette deviation and re-baseline.

**D-B · §E3 — the print threshold is arithmetically unreachable.** Measured on a saturated
8-member board (1,527 note occurrences over 365 day rows at capacity 2): **47 % of entries are
drawn, 53 % print as a digit in a "+n" badge**, against a 75 % threshold whose ceiling is 48 %. The
three cells the ownership rule actually owns all pass — all of mine printed, no member erased, not
mostly one person. **The spec threshold is wrong, not the code.** Worth saying plainly: at eight
members a printed wall poster loses half the family's detail, by design. **Decide:** correct the
threshold to something reachable, or reduce what the poster promises at that family size.

**D-C · §E1 — `memberToggle` and `findWorst` straddle the 16.7 ms frame.** Family mode only; solo
is 1.1 ms / 4.0 ms, so **P7 is not violated.** The proposed remedy (neutralising three find CSS
rules takes 14.8 → 8.6 ms) changes what *find* looks like, in a file the oracle pins. **Decide:**
accept a family-mode frame overrun, or accept the visual change.

**D-D · The relay origin (F13).** `lzp-sync-po.vercel.app` is unclaimed and returns 404. **Decide
and do together, in one commit:** claim the host, substitute it in the four invitation files, **and
update `scripts/mom-test-probe.mjs:67` and `tests/tier1/createjoin.test.js:61`** — otherwise the
per-release gate goes red for the correct change.

**D-E · The feedback sink.** Still undirected. Note the coupling this audit found: the Datenschutz
promises the feedback path as the solo Mac's *one exception*, and a solo Mac **cannot reach it**
(F5a). **Decide:** either wire the feedback port outside the family door — which makes the promise
true and re-opens D10's 21.5 amendment — or correct the copy to say a solo Mac sends nothing at
all, which `feedback/copy.js` already says.

**D-F · 21.5, for the second time.** The update check is an automatic second remote armed by
`boot()` on every launch. **Decide:** amend 21.5 again to name the disclosed automatic update
check, or default the launch/daily check to off so the only automatic remote is a sync endpoint a
family member chose. Either way, widen `network-scope.test.js`'s originator scan past `.send(` to
the updater port, so the property is *gated* rather than asserted.

**D-G · 18.5's inconsistent interval (F10).** **Decide** what a backwards-folded interval should
project as — collapse to a day, keep the widest span, or hold the last consistent interval — and,
the part that matters for 18.5, whether that repair should raise the inline notice it currently
suppresses.

**D-H · The `.DS_Store` release gate (F14).** `release.yml` gate 10 fails the release when Finder
automation did not run on the runner — which is the failure mode observed here. **Decide:** keep
the hard gate and accept that the first tag will likely fail, or downgrade it to a warning and
require a human to look at the first CI-built DMG (which §A already asks for).

---

## 7 · WHAT I WOULD DO, IN ORDER

1. **Cut a solo-only release.** It is ready. F1 makes the family feature inert anyway, so shipping
   solo costs nothing and delivers a working product.
2. **Fix the Datenschutz copy (F5).** Four sentences in one file. A privacy page that contradicts
   itself is worse than no privacy page, and (c) has a data-loss shape.
3. **Close the compaction class (F2, F3, F4, F9).** They share one root — keep `space.set` links,
   `member.set{dev.*}`, `pub.*` governing writes and the acked-pub-level trail out of compaction,
   or rebuild all four rather than two. **Then add one relaunch to each co-editor and removal rig**,
   which is what would have caught this.
4. **Reproduce those four on the shipped `.app`** before pricing them (§5 item 5).
5. **Then the family release:** claim the relay host, substitute `SYNC_ORIGIN_BUILTIN`, and add
   both to `RELEASE-CHECKLIST.md` §A.
6. **Twenty minutes with the app open** to close the eight human-only v1 stories.

---

## APPENDIX · EVIDENCE FILES

All new, all under `tests/audit/`, wired into no npm script. `npm test` re-run after: **2229/2229**.

| file | rows | run |
|---|---|---|
| `synthesis-reconciliation.test.js` | 23 green | `node --test --import ./tests/helpers/dev-flag.mjs "tests/audit/synthesis-reconciliation.test.js"` |
| `compaction-sweep.test.js` (+ `_relaunch.js`) | 7 green / **7 red-on-arrival** | same runner |
| `display-integrity.dom.js` | 6 green / **5 red-on-arrival** | `./tests/run-dom-tests.sh tests/audit/display-integrity.dom.js` |
| `pass1-*.test.js` | 36 green | same runner |
| `pass4-conformance.test.js` | 15 green | same runner |
| `pass5-first-run.test.js`, `pass5-doc-drift.test.js` | 27 green | same runner |
| `v1orig-*.test.js` / `v1orig-*.dom.js` | **436/437** · **112/112** | the unmodified v1 oracle as of `328c683` |

**Red-on-arrival rows are findings, not regressions.** They assert the correct behaviour and go
green the day the defect is fixed. The green audit rows use the inverse convention — they assert
the defect and go **red** when it is repaired. Each file's header says which it uses. The PO's
`875 pass / 3 fail` tier-2 baseline is untouched by all of them.
