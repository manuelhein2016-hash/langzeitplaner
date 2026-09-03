# E9 — collaboration and conflicts. Verification, and the demonstration the epic exists for.

**Date:** 2026-09-02 · **Tickets:** LZP-901…905, and LZP-808 (E8's last) · **Stories:** F18
18.1–18.6, 17.6, 17.7, A7 · **Normative:** ADR 001 §4.3 (the staged fold), §4.4 (structural
ownership), §5 (per-field LWW) · ADR 004 §2.2 barrier 4, §5, §5.1, §8 · Addendum Principles 9
and 10 · **PO decision D7**

---

## 0. The one-paragraph verdict

**Two people edit one bar and it stays boring.** Mama drags Papa's „Familie darf bearbeiten" bar
in a real browser; one `pub.set` leaves her Mac carrying `pub.startDate` and `pub.endDate` and
nothing else; Papa writes the same field a moment later; **the later write takes that field, her
untouched end date survives it, attribution moves to Papa, and she — the loser — gets one 289 ×
19 px line that names him, presses nothing, and fades.** He gets nothing. The board does not
move by a pixel: every `#board .col` rect is byte-identical with the line on screen.

**The epic arrived as five modules that did not touch each other, and integrating it meant
building the write.** LZP-902 shipped „Familie darf bearbeiten" as a **grant nobody could
exercise**: the flag was written, folded, rendered and enforced, and every path a co-editor's
write could take ended in `store.familyLevelOf` answering `null` for a foreign key — which
barrier 4 turns into a `RedactionError`, which sets `redactionHalt` and stops **all** family sync
from that Mac. `interact.js` was therefore correct to refuse the gesture, and 18.2 was a checkbox
that granted nothing. Three of the four build workflows closed with the same item owed. §3 is
what closed it.

**D7 is implemented and it is stated where a reader will look.** Ownership is read off the entity
key at every one of the four layers that now touch a foreign write, and no layer takes the level
from its caller: `store.familyCoEditLevelOf` reads three folded governing registers,
`projectCoEditPatch` refuses every governing field, `sealOp` re-derives the level, and `authz.js`
stage 3b decides it again on every receiving device. A patched client can still emit an op the
others reject; it cannot emit one they accept.

**Six suites. Five are wholly green; the sixth carries 17 red rows that are byte-identical to
HEAD** — the round-2 `e8-density-*` adversary findings, landed red by design, verified unchanged
on a pristine `git archive HEAD` tree before any of this work began.

**808 ships.** Komfort is +16.7 % type for +124 px of height and one month of width at 1280 px,
and its `minRowHeight: 26` floor is what stops a bigger-type Komfort from *worsening* the crowded
board it exists to help. Numbers in §7.

---

## 1. Suites — measured at the close of the pass

```bash
npm test               # tier 1, the v1 ORACLE   → 2105 pass /  0 fail
npm run test:property  # property + domains      →  101 pass /  0 fail
npm run test:attack    # adversarial corpus      →  860 pass /  0 fail
npm run test:server    # relay                   →  903 pass /  0 fail
npm run test:fleet     # multi-device fleet      →  317 pass /  0 fail
npm run test:dom       # tier 2, real WebKit     →  716 pass / 17 fail  (45 files) ← see §1.1
```

Zero npm dependencies · no `node_modules`.

**The v1 suite is the oracle and it did not move.** 2008 → 2105 is entirely additive: +19
`coedit-write.test.js` (new, this pass) and +78 from the four build workflows' own files. **Not
one v1 characterization row changed**, which is the property that matters for `interact.js` — v1
has no foreign entries, so `stripV2Fields` leaves `isForeign`/`coEdit`/`level` `undefined` on a
solo board and every new predicate short-circuits.

### 1.1 The 17 red DOM rows are not this pass's, and that was established before it started

They are the E8 round-2 adversary findings in `e8-density-{chrome,crowding,legibility,perf,
truncation}.dom.js` — open defects recorded as red rows, which is this repo's convention.
Verified, not assumed:

```
git archive HEAD | tar -x -C <scratch>
cd <scratch> && ./tests/run-dom-tests.sh tests/tier2/e8-density-*.dom.js
→ the same 17 rows, same names, same order
```

**New and green this pass:** `e9-demonstration.dom.js` **18/18** (new) · `coedit.dom.js` **24/24**
(was 23; §1c inverted, §1c-b added) · `conflict.dom.js` 18 · `density-808.dom.js` 8 ·
`sharing-control.dom.js` 36 · `interaction.dom.js` 32 · `crypto-envelope.dom.js` 20 ·
`family-render.dom.js` 18.

---

## 2. Status per ticket

| | | status |
|---|---|---|
| **LZP-901** | 18.1 owner-only editing | **VERIFIED-HERE** — `authz.js` §4.2b (per-space membership, owner *and* author), `layout.js:canEditEntry` as the one predicate for pixels, pointer and popover. Demonstrated at §4.1. |
| **LZP-902** | 18.2 the co-edit flag | **VERIFIED-HERE** — and the *write* landed this pass (§3). Demonstrated at §4.2. |
| **LZP-903** | 18.3 admin unshare | **VERIFIED-HERE** — barrier 4's retraction clause, plus the owner-side follow-up which had no caller until this pass. Demonstrated at §4.5. |
| **18.4** | ⌘Z is mine only | **VERIFIED-HERE** — `applyRemote` touches neither stack; `captureImages` refuses any op not authored by me. §4.4. |
| **LZP-904** | 18.5 the lost-edit notice | **VERIFIED-HERE** — and it had no caller until this pass (§3.4). Demonstrated at §4.3, both languages. |
| **LZP-905** | 18.6 deletions propagate | **VERIFIED-HERE** — §4.4. |
| **LZP-808** | 17.7 Komfort density | **VERIFIED-HERE**, recommendation **ship** — §7. |
| — | co-editor's own ⌘Z | **OWED** — rule U6 excludes family entities from undo. §8.1. |
| — | an admin-unshare *button* | **CLOSED 2026-09-03 (LZP-1002)** — the caller is `familysettings.js#buildModerationSection` („Einträge im Familienkreis"), 26 rows in `tests/tier2/unshare-ui.dom.js`; `sync-domains.test.js` S5b measured the module moving from absent to present. Driving it end to end in the shipped shell is blocked intermittently by **F-SHELL-1** (`FINDINGS.md` §19b), which is not this button's defect. |
| — | `NOT_MEMBER` is not curable | **OWED** — §8.3. |
| — | attack rows A3b/A3c, C2/C2b/C3 | **OWED to WP-9** — and C2's priority rises, §8.4. |

---

## 3. What the integration had to build, and why each piece is not optional

The four build workflows each closed with an owed item, and three of them were the same item seen
from three sides. Nothing in E9 could be demonstrated without closing it.

### 3.1 `store.familyCoEditLevelOf` — barrier 4's level for somebody else's entity

`familyLevelOf` answers `null` for a foreign key and **that stays exactly right**: it reads the
entity's own `visibility` truth register, and a viewer holds no truth for a peer's entry. What was
wrong was reading "there is no truth here" as "nothing may be sealed here".

**The level of a co-edit is not a truth question.** `familyLevelOf`'s own argument against
`pub.level` — *"the level a transition is moving away from"* — is an argument about a
**transition**, and only an owner has one. A co-editor moves no level. So the right source is the
one `authz.js` stage 3b itself consults, and the new function reads exactly those registers:

```
pub.level === 'geteilt'   AND   pub.coEdit === true   AND   pub.alive !== false
```

— folded, authenticated, written by the **owner** alone under stage 3a, on a key whose owner
segment is somebody else. It answers `null` for my own key, deliberately: my entries publish
through `derivePublication` from the truth register, and a second producer reading `pub.level`
would re-publish a downgrade at the level it was leaving. **That is finding S5, and this is the
one place it could have been rebuilt.** Pinned by `coedit-write.test.js` §1 over the whole
4 × 3 × 3 × 2 cross product of what the three registers and ownership can hold — 72 cells, oracle
written from ADR 001 §4.3's prose.

### 3.2 `core/project.js:coEditOp` — the branded-op door

`projectCoEditPatch` produced a branded **patch** and nothing that could carry it. Without a door,
the agent wiring 18.2 holds a correct patch, no op, and exactly one way forward: forge
`Symbol.for('lzp/v2/family-patch')`. `adminUnshareOp` is the precedent one section up and the
reasoning is identical — a narrow reviewed door is strictly safer than the hand-rolled one its
absence guarantees. It refuses my own entity, every governing field, and any unknown `spec` key.

### 3.3 `sync/family.js:sealLevelFor` — the three-way split, in one place

Barrier 4's level source is now a function of the **op**, not only the key, because two different
things legitimately reach that seam addressed to somebody else's entity and they need opposite
answers:

| | source | why |
|---|---|---|
| my entity | `familyLevelOf` — the truth register | unchanged, and first |
| a **co-edit** (18.2) | `familyCoEditLevelOf` — the authenticated fold | barrier 4 then takes its normal path; the `geteiltOnly` backstop still applies |
| a **retraction** (18.3) | `null`, **on purpose** | the retraction clause fires only while `levelOf` has no answer, and it is the clause that demands the folded admin chain name `op.act` |

**The third row is the one that would have broken 18.3 silently.** An admin unshare is also a
`pub.set` on a foreign key. Had the co-edit reader answered `geteilt` for it, barrier 4 would not
merely have skipped the admin check — the patch declares `pub.level: 'privat'`, so it would have
been **refused outright for disagreeing with the map**, and admin unshare would have stopped
working. The split is on `authz.js:classifyUnsharePatch`, the same predicate stage 3a admits an
unshare by, so the seal seam and the fold that judges its result cannot drift. It fails safe in
both directions: a misclassified retraction is refused by barrier 4, a misclassified co-edit by
the retraction clause. Neither error seals a byte, and neither can raise a level.

### 3.4 The three callers that did not exist

| owed by | wired into | consequence if left |
|---|---|---|
| LZP-904 | `family/mount.js:mountCircleSurfaces` → `installConflictNotice({store, nameOf: memberNameOf})` | 18.5 shipped as a module nothing called |
| LZP-903 | `store.js:applyRemote` → `adminUnshareFollowUp` | 18.3's "it reverts" true only until the owner's next keystroke — measured, §4.5 |
| LZP-902 | `interact.js:commitEntry` → `store.applyCoEdit` | the wedge, and 18.2 unexercisable |

`installConflictNotice`'s absence was **measured by the suite, not noticed by a reader**:
`sync-domains.test.js` S5b went red the moment `mount.js` imported it, because an unmounted
module is correctly invisible to the import-graph walk. `family/unshare.js` is still invisible for
the same reason — that is §8.2, and S5b is what will notice when it lands.

### 3.5 One place 18.2's grant deliberately does **not** reach

`interact.js:deleteSelected` gates on `isForeign`, not on `mayGesture`. `pub.alive` is a
**governing** register, so a co-editor's `pub.alive: false` is an op every honest device rejects:
the entry would vanish from my board and stay on everyone else's — a **divergence**, which is
worse than a refusal. 18.2 grants the right to edit the family vacation bar, not the right to take
it out of the family's year. `projectCoEditPatch` has no field that could carry one either, so
this is a refusal the projection would make anyway, made early where it is cheap.

---

## 4. THE DEMONSTRATION

Driven three ways: a durable tier-2 file in real WebKit (`e9-demonstration.dom.js`, **18/18**),
a live Chromium session against a real relay for the pictures, and a real-HTTP script for the
relay bytes. **This Mac is MAMA** — the co-editor and the moderated owner, the two roles E9 added
and neither of which had ever been driven end to end. Papa is a genuine peer: his own HLC, his own
device, his own attestation, ops built with the real `makeOp` and delivered through the real
`store.applyRemote`, and he holds the **genesis admin seat** via a real `space.set{admin, adminPrev: null}`.

### 4.1 Papa shares a bar and ticks „Familie darf bearbeiten"; 18.1 holds for everything else

| | measured |
|---|---|
| on Mama's board | `isForeign: true`, `level: 'geteilt'`, `label: 'Herbstferien Nordsee'`, `coEdit: true`, rendered |
| the fold's answer | `store.familyCoEditLevelOf(fbar:PAPA/…)` → `'geteilt'` |
| **Papa's other bar** (no flag) | fold → `null`; a real drag moves nothing, authors **0 ops**, `is-dragging: false` |
| **Papa's Belegt block** | fold → `null`; same — and the same owner, space and member colour, so the *only* difference is the flag |
| ⌫ on the co-editable bar | `deleteSelected()` → `false`, 0 ops, bar still there (§3.5) |

### 4.2 Mama drags it — and the write is real

A real pointer sequence in Chromium, on the live board:

```
moved            2026-10-05…10-19  →  2026-10-09…10-23
ops authored     1
  k              pub.set
  e              fbar:mem_PPPP…/e9live01-…      ← PAPA's entity key
  act            MAMA                            ← what stage 3b judges
  f              { pub.startDate, pub.endDate }  ← and nothing else
truth register   bar:e9live01-…  NOT minted      ← the entry is not mine
redactionHalt    null                            ← the failure this seam removed
is-dragging      false        ghosts 0
```

That single op is the whole of LZP-902's write path, and every clause of it is a property: the key
names the owner because ownership is structural; the author is me; the patch carries only fields
`ops.js:FIELDS` marks `coEdit: true`; and no truth register exists to move.

### 4.3 Both at once — per-field LWW, attribution, and one line for the loser only

Mama's drag is in flight; Papa writes `pub.startDate` a moment later on his own HLC.

| requirement | measured |
|---|---|
| **per-field LWW** | `startDate` → `2026-10-14` (his, later). **`endDate` → `2026-10-23` — MINE, survived**, because he never wrote that cell. A whole-entity LWW would have taken it and changed the bar's length. |
| **attribution updates (17.6)** | `updatedBy` → `PAPA` |
| **only the loser** | Mama: 1 notice. **The winner of the same race gets none** — driven as its own row (`2d`), with Papa's write arriving *first* and Mama's landing newer. |
| **one line, inline, dismisses itself** | 1 `.lzp-conflict`, 289 × 19 px, `position: fixed`, `role="status"`, `aria-live="polite"`, **0 children, 0 buttons/links/inputs, `pointer-events: none`**, 0 dialogs |
| **zero pixel cost** | every `#board .col` rect byte-identical with the line on screen; `scrollWidth` unchanged; the line is **not a child of `#board`** |

```
DE   Papa hat das gerade auch geändert — die neuere Änderung gilt.
EN   Papa changed this too just now — the newer change stands.
```

Both screenshotted in-transcript on the live board. The line says **who, never what**: asserted
absent are `Konflikt`, `überschrieben`, `verworfen`, the field name, the date and the entry's own
label. And Principle 10 is swept across the whole rendered document — no `Kommentar`/`comment`,
`Antwort`/`reply`, `gelesen`/`read receipt`, `online`, `tippt`/`typing`, `Reaktion`/`reaction`,
`Chat` or `Nachricht` surface exists anywhere.

### 4.4 Papa deletes it; his ⌘Z restores it; Mama's ⌘Z never touches it

| | measured |
|---|---|
| Papa's `pub.alive: false` | the bar leaves Mama's board **and** her pixels |
| his ⌘Z → a **new shared op** | another `pub.set{pub.alive: true}` at a newer stamp; the bar returns whole, label intact (18.6) |
| **18.4, arrival** | a peer's `pub.set` moves neither `undoStack` nor `redoStack` |
| **18.4, my own undo** | Mama creates a note, presses ⌘Z; her note goes, **Papa's bar is untouched** in `startDate` and `label` |

### 4.5 The admin unshares one of Mama's entries

Papa — holding the real folded admin seat — unshares Mama's shared note through the shipped
`adminUnshareOp(ctx, {kind, owner, uuid})`.

| clause | measured |
|---|---|
| **it reverts** | `pub.level` → `'privat'` |
| **…on her machine too** | `note:<uuid>.visibility` → `'privat'`, via the follow-up wired this pass |
| **it is never deleted** | the note is on her board, `text: 'Bescherung 18:00'`, unchanged, still rendered — now owner-private |
| **and it stays reverted** | her **next keystroke** (`editNoteInline`) leaves `pub.level: 'privat'` and `pub.text: null`. Without the follow-up this is where 18.3 quietly failed. |
| **it notifies nobody** | no notice, and `entfernt` / `Verwalter hat` / `moderiert` / `removed by` appear nowhere in the document (Principle 9, ADR 004 §7) |
| **the op carries no content** | `pub.level: 'privat'` and every other field an explicit `null`; the withdrawn text is not in the op's bytes |

### 4.6 „the admin never reads it" — the relay bytes, grepped

A **real** two-Mac circle over **real HTTP** against `server/dev-server.mjs`'s file adapter — real
identity, real device keys, real space key, real `sealOp`, the shipped `createFleet` harness with
only the socket replaced. Reproducible:

```bash
node server/dev-server.mjs --port 8788 --dir /tmp/lzp-e9-relay
node scripts/e9-relay-bytes.mjs --relay http://127.0.0.1:8788 --dir /tmp/lzp-e9-relay
```

```
relay store: /tmp/lzp-e9-relay/sync-store.json — 8297 bytes

  ok   non-vacuity: the relay really is holding data (8297 B)
  ok   the Privat entry's text is NOT on the relay
  ok   not even the SHARED entry is plaintext — the envelope encrypts
  ok   the relay cannot read "note.set" / "createNoteInline" / "visibility"
  ok   the relay cannot read "geteilt" / "privat" / "categoryId" / "2026-10-05" / "repeatsYearly"
  ok   it holds 14 opaque blobs (envelopes, keys, wraps)
  ok   including op rows — the ops really were pushed
```

What the relay *does* hold, walked leaf by leaf: `devices`, `epochs`, `keyWraps`, `members`, and op
rows whose bodies are `…/ops/…/envelope/$b` — opaque base64. **Zero plaintext leaves.** One
substitution was required and is recorded in the script's header: `simClock()` starts at
2026-08-29 and ADR 003 §2 gives a signed request a 120 000 ms window, so against a real host every
POST is `401 stale_request`. A simulated clock is right for a simulated relay and wrong for this one.

It is a **script and not a fleet row** deliberately: `tests/fleet/` reaches the 23 real handlers
through an in-process loopback, and a loopback relay has no disk to read.

---

## 5. The redaction boundary did not regress

E9 adds **write paths into the family space** — a co-editor's `pub.set` and an admin's retraction
— which is precisely where a leak would appear.

```bash
node --test tests/attack/e7-leak-*.test.js   →  91 pass / 0 fail
node --test tests/fleet/e6-attack-privat.test.js →  16 pass / 0 fail
```

Plus two sweeps of the finished state after the whole arc above
(`e9-demonstration.dom.js` §5):

- **§5a** — three entries created Privat and **never shared**; their text appears in **no family
  op, no family register, and not in the family outbox**. The predicate is deliberately
  *never shared*, not *privat now*: §4.5 moderates an entry that **was** legitimately Geteilt, so
  its text is in the family half by design and stays there — `UNSHARE_COPY.honesty` says so out
  loud („Was schon sichtbar war, wurde schon gesehen"). A sweep over "everything privat now" would
  flag a correct product, which is the worst kind of leak test: one that has to be argued down.
- **§5b** — every co-edit the demonstration authored wrote **only** co-editable fields; not one
  `pub.level`, `pub.coEdit`, `pub.alive` or `_born` among them.

`store.redactionHalt` is `null` at every checkpoint in every row.

---

## 6. Mutants — each fix proven able to fail

Scratch copy of `src/` + `tests/`, one mutation at a time, baseline restored between each
(`coedit-write.test.js`, 19 rows). **Never `git stash`.**

| mutant | rows that die |
|---|---|
| **M1** `familyCoEditLevelOf` stops reading `pub.coEdit` (18.1 becomes opt-**out**) | §1, §3c, §3d |
| **M2** it answers for my own key too (the S5 second producer) | §1, §1b |
| **M3** it stops reading `pub.level` (co-edit leaks to Belegt) | §1, §3c |
| **M4** `coEditOp` stops refusing my own entity | §2c |
| **M5** `applyCoEdit` hardcodes `'geteilt'` instead of asking the fold | §3c, §3d |
| **M6** `applyRemote` stops calling `adminUnshareFollowUp` | §4a, §4b |
| **M7** the follow-up is **committed** rather than appended (Mama's ⌘Z would eat Papa's moderation) | §4b |

Two rows in the tier-2 files were **inverted rather than deleted**, per the convention:

- `coedit.dom.js` **§1c** asserted a co-editable foreign note opens **no** editor, reasoning
  „an editor that could never have committed". That reason was a statement about the missing
  capability, not about 18.2. It now pins which **door** the gesture chooses and with which
  fields, and **§1c-b** was added as its non-vacuity twin — a *non*-co-editable entry must reach
  that door not at all, or a `commitEntry` that routed every foreign gesture there would look
  identical.
- `sync-domains.test.js` **S5** 68 → 69 modules, with `family/conflict.js` enumerated and the
  reason recorded in `tests/helpers/sync-domains.js`.

### 6.1 Two fixture bugs the rows found, worth recording because both were silent

- **A peer op stamped from a constant loses every LWW contest.** The store stamps its own ops from
  its real HLC, so a moderation minted at a fixed `BASE_MS` is older than every local write:
  `pub.level` stayed `geteilt`, the follow-up correctly emitted nothing, and the row failed for a
  reason unrelated to the code under test. Peer ops are now stamped **relative to the log they
  extend** (`aboveTheLog()`), which is the rule `unshare.test.js` states in its own header.
- **A Privat entry cannot be published, so a fixture must not ask the projection for one.**
  `projectForFamily` returns an empty patch and `makeOp` refuses it — asking for a Privat
  publication is asking for the one thing the redaction boundary exists to make impossible. The
  refusal-case fixtures write the governing registers directly, which is the state a *downgrade*
  legitimately leaves behind.

---

## 7. LZP-808 — Komfort density. **Recommendation: ship it.**

Measured independently in a real browser at 1280 × 800, both presets applied the way
`settings.js` applies them (density + the row and column metrics that ride with it):

| | Kompakt | Komfort | Δ |
|---|---|---|---|
| entry type | 9 px | **10.5 px** | **+16.7 %** |
| line box | 10.5 | 12.5 | |
| row height | 22 px | **26 px** | +4 px |
| column width | 118 px | **138 px** | +20 px |
| board width | 1432 px | 1672 px | **+240 px** |
| board height | 784 px | 908 px | **+124 px** |
| months fully visible @1280 | 10 | 9 | **−1** |
| **row capacity** | **2** | **2** | **0 — no entry is lost** |
| `.col-head` | sticky | sticky | pinned at both |

**Why it ships.** The presets are not invented — v1 §2 names *two* display classes and gives each
a row band *and* a type size; v1 shipped one row and the smaller type for every machine. 17.7 is
v1's other display class made selectable, and it closes v1 open question 4 with a control instead
of a constant.

**The number that decides it is `minRowHeight: 26`, and it is a hazard the ticket does not
mention.** `LINE_H = 10.5` is a fact about **9 px type**, not about the app. A naive Komfort —
bigger type over the shipped capacity rule — would promise two lines to a 22 px row that can draw
one, and would make the crowded board **worse, not better**. The floor forbids it
(`floor((26−1)/12.5) = 2`, `floor((25−1)/12.5) = 1`) and is enforced in `buildBoard`, so it holds
for a `board.json` that arrived by import or by hand. The row above is the proof: **capacity is 2
at both presets — Komfort buys type without costing a single entry.**

**The cost is honest and the pane says it.** 17.7 sells horizontal scroll as the price; there is
also a **vertical** price, and v1 does not treat that one as a trade („the board never scrolls
vertically"). 31 × 4 px = 124 px. On a 13" MacBook Komfort simply is not for that machine, and the
settings pane measures the actual window and says what falls below the fold, in both languages,
exactly when `need > have`.

**Per device is free**, and that is the finding rather than the feature: `settings` is written
through `tx.pref()`, a `local`-space op `store.js:outbox()` filters out by construction — rule U6's
comment already cites story 17.7 by number. Asserted, not trusted: one `pref.set`, space `local`,
`gid: null`, outbox 0.

**Cut it only if the 124 px are needed elsewhere — not because it is a `[Could]`.** §10 of the
addendum's cut list should be annotated to that effect.

---

## 8. What is owed

### 8.1 A co-editor cannot ⌘Z their own co-edit — rule U6

**Measured, not assumed:** `coedit-write.test.js` §3b was written expecting `depth + 1` and went
red. `core/undo.js:captureImages` filters every entity kind outside `UNDOABLE_KINDS`
(note/bar/cat/pad), which is v1's `CONTENT_KEYS` snapshot stated in op terms, so a family
`pub.set` is never on anybody's undo stack.

For **my own** entry that is exactly right and the ADR says why — the publication is *derived*, so
undoing the truth and letting the publisher re-derive is the only path that cannot leave the
family space describing a state the owner's board no longer holds. **For a co-edit there is no
truth to undo**, so the consequence differs in kind.

**Deliberately not closed by widening `UNDOABLE_KINDS`.** An undo that minted a `pub.set` would
re-write the pre-value **at a fresh stamp**, beating the owner's concurrent newer write and
silently resurrecting a value they had already replaced — the §5.1 failure, arriving through the
undo stack. Failing closed costs a keystroke; failing open costs somebody else's edit. What 18.4
actually requires holds and is asserted: the stack is untouched, in both directions, by anybody.
**Owner: `core/undo.js` + a PO call on whether 18.2 implies undoability at all.**

### 8.2 There is no admin-unshare button

`family/unshare.js` (`planUnshare`, `createUnshare`) is complete and tested, and **no UI calls
it** — §4.5 drives `adminUnshareOp` directly. It is consequently still invisible to
`sync-domains.test.js` S5's import-graph walk, which is the check that will notice when it lands.
It also still owes `family/createjoin.js`'s genesis admin link
(`UNSHARE_BLOCKERS.NO_ADMIN_CHAIN`), the same dependency `removal.js` reports.
**Owner: `family/adminpanel.js`, `family/createjoin.js`.**

### 8.3 `REJECT_REASONS.NOT_MEMBER` is not in `store.js:CURABLE_REFUSALS`

Such an op is dropped, not parked. Pre-existing for stage 3b; §4.2b widens the surface to the
owner. Bounded in practice — member records carry strictly lower `seq` than any content op
referencing them, and a missing owner record drops the entity's *first* publication too, so the
outcome is "entity absent", never "entity corrupt". It is a genuine trade, not an obvious fix:
`applyRemote`'s own comment argues that parking a stranger's write forever is the worse outcome.
**PO / store owner's call.**

### 8.4 The open attack rows — and one of them just got more reachable

`ownership-authz-*` carries **20** open `SUCCEEDED` rows (admin 10, content 6, undo 4), all
deferred to WP-9/WP-6/WP-8.

- **A3b / A3c** remain open and one line closes them. §4.2b gates `pub.set` (stage 3a) because
  that is 18.1's surface; `member.set{_alive:false}` — 20.2's removal, stage 2 — still asks
  `adminAtKey(spaceKey(op.space))` with no check that the **subject** is a member of that space.
  Mirror fix: `membersIn(op.space).has(subject)`. Left to WP-9 because it interacts with
  join/leave/rotation.
- **⚠ C2 / C2b / C3 change priority because of this pass.** They are the co-editor × undo trio —
  *"my ⌘Z silently discards a co-editor's newer write to the same field"*: the owner's undo
  restores their own truth value at a fresh stamp, which then beats the co-editor's newer
  `pub.text` through promotion. Until this pass **no co-editor write could be authored at all**,
  so the trio was reachable only by a hand-built op. It is now reachable **through the product's
  own UI**, by two people using 18.2 exactly as designed. The rows are unchanged and still green
  (they pin the defect); what changed is that this is no longer hypothetical. **Recommend
  promoting C2 out of WP-9 into the next work package.**

### 8.5 `DESIGN-DECISIONS.md` D7 is stale in one number — the PO's file, not edited here

D7's `⚠ OPEN FOR THE PO` block says *"the `ownership-authz-*` attack files carry twelve
`SUCCEEDED` rows"*. The **admin** file now carries **10** (A3 and A4b closed at E9 §4.2b), and
across all three files there are **20**. Two of the three examples that block quotes — *"a
self-declared membership, a forged genesis, a former admin unsharing forever"* — are unchanged;
what moved is the count and the fact that the per-space membership gate has since closed two of
them. **The PO's wording question is materially smaller than it was.** Left for the PO because it
is a decision file.

### 8.6 Housekeeping

- `layout.js:canEditEntry` and `interact.js` now agree in **both** directions for a co-editable
  foreign entry — the cosmetic lie E7 flagged (grips painted on a bar the pointer refused) is gone
  by construction, because the gesture now commits.
- The dev relay and app origin used for §4 are on **8788** and **4174** and were started by this
  pass; `/tmp/lzp-e9-relay` is scratch.

---

## 9. Principle 10 — the board is not a messenger

Asserted as an **absence**, on the real rendered document, in both languages
(`e9-demonstration.dom.js` §2c, and again in `conflict.dom.js`):

**no** comments · **no** replies · **no** reactions · **no** chat · **no** messages · **no** read
receipts · **no** presence · **no** typing indicators.

The conflict notice is **one line**, it is the **only** conflict UI in the product, it has zero
child elements and zero pressable controls, `pointer-events: none`, `role="status"` (never
`alert`), it fades itself out, and it costs the board zero pixels. An admin unshare (18.3) and a
remote delete (18.6) are **unconstructible** as notices — `conflict.js:admits()` refuses governing
fields outright, which is where ADR 004 §7's "no *X made an entry private* notification" is
enforced rather than remembered.
