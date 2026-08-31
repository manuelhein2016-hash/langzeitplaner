# E7 — visibility and sharing. Verification of the redaction boundary.

**Date:** 2026-08-31 · **Tickets:** LZP-701…706 · **Stories:** F16 16.1–16.7, F17 17.1–17.6,
18.1, 18.2, A3, A4, A6, A7, A8 · **Normative:** ADR 004 (*"the most security-critical document in
the project"*), ADR 001 §3.1/§4, ADR 002 §5

---

## 0. The one-paragraph verdict

**The invariant is enforced, and it is enforced where ADR 004 says it must be: on the emitted ops
and on the sealed bytes, never on the rendering.** `src/js/core/project.js` is no longer an orphan —
it is now the only path by which a family patch comes into existence, and there is no second one.
Papa's Mac creates an entry through the real store, the store *derives* the publication, the real
`sealOp` seals it under a real family key with barriers 2, 3 and 4 injected, Mama's Mac opens it
with the real `openOp`, folds it with the real `foldAuthorized` and draws it with the real
`materialize` — and **the word "Scheidungsanwalt" appears in no pre-seal plaintext, no envelope
field, no ciphertext byte, and in no object recovered by decrypting the whole family log under
every epoch key the family has ever held.** Papa downgrades to Privat; the entry leaves Mama's
board at the next sync, and every withdrawable register on her disk holds an explicit `null`.

**Three defects were found by wiring it rather than by reading it,** and the first of them meant
the feature could not have worked at all: **`core/ops.js:makeOp` spread the patch and dropped
barrier 3's brand**, so every op built through the shipped constructor arrived at `sealOp`
unbranded and was refused. Two more — a badge that promised a disclosure the server had not
received, and an acknowledgement that never redrew it — were found by writing the row that asks
what the badge says while the op is still in the outbox.

**One measured finding is a real weakness and is stated rather than hidden:** ADR 004 §10's **P7i**
("a Belegt op and a Geteilt op of the same entity are the same ciphertext length") is true *inside
a padding bucket* and stops being true **below the product's own note-length cap**. It is not a
break of INV-R1 — no content escapes — but a relay operator can distinguish a long shared note from
a booking without a key. §7 measures the boundary and pins it.

**All six suites are green.**

---

## 1. Suites — measured at the close of the pass

```bash
npm test              # tier 1                    → 2004 pass / 0 fail  (169 suites)
npm run test:attack   # adversarial corpus        →  769 pass / 0 fail  (130 suites)
npm run test:property # property + domains        →  101 pass / 0 fail  ( 22 suites)
npm run test:server   # relay                     →  868 pass / 0 fail
npm run test:fleet    # multi-device scenarios    →  193 pass / 0 fail  ( 66 suites)
npm run test:dom      # tier 2, real WebKit       →   32 files, all pass
```

Zero npm dependencies, no `node_modules`, no stray root files.

The attack suite moved **720 → 769**: `tests/attack/redaction-invariants.test.js` is new and
contributes **49 rows in 10 groups** (ADR 004 §10's row set), and `sharing-control.dom.js` gained
one. The property suite's module domain moved **67 → 68**: `src/js/family/sharing.js` became
reachable the moment `family/mount.js` installed it through `popover.js#useSharing`. The two rows
that were red at the start of this pass — `S5a → S5-core-project` and
`privacy-e5-silence.test.js`'s orphan row — are closed, by wiring, not by deletion.

---

## 2. Status by ticket

| ticket | story | verdict | where the evidence is |
|---|---|---|---|
| **LZP-701** the redaction boundary | 16.1, 16.5, A3 · INV-R1…R4 | **VERIFIED-HERE** | `tests/attack/redaction-invariants.test.js` §1–§6, §8; the projection is reached only through `store._publishAndEnqueue` |
| **LZP-702** the sharing cluster | 16.3, 18.1, 18.2, A7 | **VERIFIED-HERE** | `tests/tier2/sharing-control.dom.js` — 36 transition cells through the real store, and the op-level half is now checked on BOTH the truth write and the derived publication |
| **LZP-703** category default | 16.4 | **VERIFIED-HERE** | `sharing-control.dom.js` §7 (the popover create path, driven) + `visibility.test.js` C4 + §6 of the invariant suite |
| **LZP-704** transitions and retraction | 16.5, Principle 9 | **VERIFIED-HERE** | §4 — twelve sequences ending in `privat`, asserted on **Mama's** registers |
| **LZP-705** exposure badges | 16.6 | **VERIFIED-HERE** (model) · **OWED** (pixels) | §7 of the invariant suite drives the pending/acked ladder through the real outbox; the glyphs are `tests/tier2/belegt-render.dom.js` |
| **LZP-706** the two-sided Belegt | 16.7, 17.1–17.4, A6 | **VERIFIED-HERE** | §8 — Mama's board built from bytes that really were sealed and really were opened |

---

## 3. What was wired, and what it cost

Seven files, and every one of them was a seam another work package had named and left open.

| file | change | why it could not be skipped |
|---|---|---|
| `src/js/core/ops.js` | `makeOp` carries own **symbol** keys across the patch copy | **`{ ...f }` dropped barrier 3's brand.** Every op built through the shipped constructor was refused by `sealOp`. Nothing could be shared, and the failure read as a bug in the projection. |
| `src/js/core/project.js` | `derivePublication(localOps, regs, ctx)` — `ops.contract.js` §6's declared-and-unimplemented function | The projection's one caller. It answers *"does what the family holds still equal the projection of what I hold?"* and emits exactly the ops that close the difference — idempotent, so a keystroke storm is not an op storm. |
| `src/js/store.js` | `_publishAndEnqueue`, `_truthOf`, `_exposureCtx`, `redactionHalt`, the halt on `familyOutbox()`, the re-projection on `ackPushed` | ADR 004 §2.3's loud failure path, §4.1's promotion, §6's badge. `PUBLISH_FAILURE_CONTRACT`'s six clauses, satisfied. |
| `src/js/popover.js` | the create path reads the category default | ADR 004 §3 names this site. It hardcoded `'privat'`, so **16.4 did not fire from the popover at all**. |
| `src/js/interact.js` | `defaultVisibilityOf` routes through `visibilityForNewEntry` | It was correct only by coincidence — `undefined` became `'privat'` because three other files happened to hold. |
| `src/js/family/mount.js` | `useSharing(circle ? sharing : null)` | The cluster shipped dark. A **port**, not an import: `boot.js → main.js → popover.js` is the solo graph, and ADR 003 §7 gate 2 refuses a static path from it into `family/`. |
| `src/js/i18n.js` | `belegt`/`geteilt`/`privat`/`vonMember`/`geaendert`/`neu`, both tables | ADR 004 §4.3's own row. `board.js:FAMILY_COPY` was the interim table and has now stepped aside on its own. |

### The publication is DERIVED, and that is a structural decision

`store.js`'s own header states the rule the outbox is built on: *"every path that appends a local op
is in the outbox automatically, with no publish hook to forget at one of them. A separate queue
would have to be written to at six call sites and would drift at the seventh."* A publication minted
by the sharing control would be exactly that seventh site — and it would be missing from ⌘Z, from a
text edit of an already-shared entry, from a delete and from a drag.

`core/undo.js` had already decided this from the other direction: a `pub.set` is deliberately **not
undoable**, because *"undoing the truth and letting the publisher re-derive is the only path that
cannot leave the family space describing a state the owner's board no longer holds."* That sentence
is only true if a publisher re-derives. It now does — from `_commit`, from `undo()` and from
`redo()` — and **⌘Z on a share emits the retraction** (§8's third row; mutant M7).

### It runs synchronously, and that is a departure from §2.3's wording with §2.3's own reason

ADR 004 §2.3 places the publish path "inside the `queueMicrotask` after `emit()`" because ADR 001
§0.9 forbids an `await` above `emit()`. **The hazard is asynchrony**, and `derivePublication` is
pure and synchronous. Deferring it would buy nothing and cost two things: the **gid** (an op
appended after `_stacks.push` is outside the undo entry, so ⌘Z would restore `visibility: 'privat'`
in the truth and leave `pub.level: 'geteilt'` published — a leak that survives its own undo), and
the **ordering** (every listener would redraw against a board whose publication had not been
derived, and the exposure badge would read a state one tick stale in the unsafe direction). What
genuinely belongs in the microtask is the **sealing**, and it is already there.

---

## 4. The invariant table — ADR 004 §10, and the evidence for each row

| id | property | asserted on | verdict |
|---|---|---|---|
| **INV-R1** | no plaintext escape | pre-seal patch · sealed bytes · decryption under every epoch key | **HOLDS** |
| **INV-R2** | two representations, one entity | two entity keys, two register sets, two spaces, two stamps, one uuid | **HOLDS** |
| **INV-R3** | the owner always sees the truth | the owner's materialized state and truth registers, after a downgrade and after a co-editor's write | **HOLDS** |
| **INV-R4** | a downgrade removes | **the peer's** materialization and **the peer's** registers, 12 sequences | **HOLDS** |
| **P7a** | patch ⊆ allowlist ∪ explicit nulls | the emitted ops | **HOLDS** |
| **P7b** | no non-null content below `geteilt` | emitted ops + sealed bytes + decrypted log | **HOLDS** |
| **P7c** | promotion never promotes my own `pub.*` writes | materialized state, both sides | **HOLDS** |
| **P7d** | any sequence ending in `privat` leaves the peer nothing | peer materialization | **HOLDS** |
| **P7e** | barrier 2 throws off-list; barrier 3 refuses unbranded | unit + the real seal seam | **HOLDS** |
| **P7f** | the level is re-derived from the register map | the real `sealOp`, with a caller lying twice | **HOLDS** |
| **P7g** | `categoryId` in no family op, ever | tables + emitted ops + sealed bytes | **HOLDS** |
| **P7h** | a non-owner cannot write a governing field | *not this pass* — `authz.js` stage 3a, covered by `tests/attack/ownership-authz-content.test.js` | **PRE-EXISTING** |
| **P7i** | Belegt ≡ Geteilt by ciphertext length | sealed bytes, at the bucket boundary | **HOLDS INSIDE A BUCKET — see §7** |
| **A3** | no `pub.` counterpart at any level | **structurally**: no allowlist row, no `FIELDS` row, no `TRUTH_SOURCE` row | **HOLDS** |
| **16.1** | private by default costs zero bytes | a COUNT of emitted family ops | **HOLDS** |
| **16.6** | the badge never over-promises | the real outbox, pending → acked → pending → acked | **HOLDS** (wired this pass) |
| **P9** | no snitch | the op vocabulary, the plan's key set, the peer's registers | **HOLDS** |

### `assertNeverTransmitted`, and where it runs

`tests/helpers/never-transmitted.js`. Three halves, and they are three different claims:

1. **the pre-seal plaintext** — a hit means the redaction boundary let the string through;
2. **the sealed bytes and the stored envelopes** — searched as BYTES, not as a JSON substring,
   because a leak that arrived as raw bytes would be a substring of nothing. A hit here after a
   clean (1) means something outside the projection put the string on the wire;
3. **decryption of the whole family log under every epoch key** — the only half that can see a
   field that IS correctly encrypted and should never have existed. Every envelope is tried under
   every key (a ring that answers one key regardless of what is asked, so the AAD is what refuses
   the wrong ones — the refusal is the product's, not the harness's).

It runs in **every Belegt scenario** in the file: §1 (three needles), §4 (every sequence that never
reaches Geteilt), §5 (the category name), §6 (the Privat lifecycle), §8 (the end-to-end story).

**ADR 005 §1.1 names `fleet.js` as its home and that is not possible today.** `tests/helpers/fleet.js`
is M1's fleet — one member with several Macs, over a personal space; its own identity gate asserts
`new Set(memberIds).size === 1`. Every clause of §10.1 is about the FAMILY log. So it ships as a
recorder any sealer can feed, and `fleet.js` can adopt it the day it grows a family space.

### Non-vacuity, because a leak test over an empty board passes

Four independent guards, each of which has fired during this pass:

- `peerFold` **throws** if the peer's fold rejected or parked anything. An attestation that does not
  verify makes `foldAuthorized` refuse every family op at stage 0b, and the symptom is an empty
  board — which is exactly what "the secret never reached Mama" looks like. That is a real bug this
  guard caught in the harness itself (`attestOpenOver` needs the recovery **CryptoKey**, not its raw
  export).
- Every needle is a string that never legitimately leaves this device **anywhere in the file**; a
  scenario that must really share carries `SHARED.text` instead. A suite in which nothing is ever
  shared would pass against a build that publishes nothing at all.
- Counts, not shapes: `pubs.length >= 4`, `opened >= 4`, `attempts === envelopes × keys`,
  `new Set(env.ep).size >= 2`.
- The two transcriptions of ADR 004 §2 — the module's and the helper's — are asserted to agree, so
  a mutant that widens one does not widen the other.

---

## 5. Findings

### E7-1 · `core/ops.js:makeOp` dropped barrier 3's brand — HIGH, closed

`const patch = opts.born ? { ...f, _born: ts } : { ...f }` copies string keys only.
`projectForFamily` returns a frozen patch carrying a non-enumerable
`Symbol.for('lzp/v2/family-patch')`, and `sealOp` refuses any family `pub.set` whose patch is
unbranded. **Every op built through the shipped constructor therefore arrived at the seal seam
unbranded**, and the whole epic could not have worked. `PUBLISH_FAILURE_CONTRACT.byReference` states
the obligation on the caller; `makeOp` is the one copy on the path a caller cannot avoid, so it now
discharges it there rather than asking every future call site to remember. Carried across **only
when `makeOp` did not widen the patch** — a `born: true` op has a different field set from the one
the projection asserted, and branding a widened copy is the "take the object the allowlist produced
and add a key" attack the freeze exists to stop. Mutant **M1**, 21 rows.

### E7-2 · the exposure badge promised a disclosure the server had not received — MEDIUM, closed

`materialize.js:exposureOf` accepts `ctx.lastAckedPubLevel` and `ctx.pendingPub` and neither was
wired, so exposure was simply the current level and never pending. A **pending downgrade therefore
rendered as already withdrawn** — the badge under-reporting what the family could still see, which
is the one direction ADR 004 §6 forbids. Wired in `store._exposureCtx`. Mutant **M17**.

### E7-2b · the newest ACKED level cannot be read off the register map — MEDIUM, closed

The obvious implementation asks the register map for `pub.level` and treats an unacked winner as
"no answer". That renders a pending Geteilt→Belegt as **`privat`** — worse than the bug it fixes.
The map keeps only the winner, and the winner of a pending downgrade is the op that has not reached
the server, so the acked level has to come from a pass over the log. Mutant **M18**.

### E7-3 · acknowledging a push did not redraw the badge — LOW, closed

`ackPushed` is the only place a server `seq` ever appears for a local op, and it did not
re-project. The entry was published, the family could see it, and my own board went on saying "not
synced yet" until I touched something unrelated. Lagging in the safe direction, which is why it was
invisible, and still wrong (19.3). Mutant **M19**.

### E7-4 · P7i is true inside a padding bucket and false below the note-length cap — MEDIUM, OPEN

ADR 004 §10 states P7i without qualification. ADR 002 §5.3's padding hides a length difference only
**within** a bucket (`PAD_BUCKET = 256`), and measured through the real `sealOp`, a Geteilt note
leaves a Belegt op's bucket **below 80 characters of ASCII text** — inside `core/ops.js`'s own
`str80` cap and inside `popover.js`'s `maxLength`. A relay operator, who sees
`(spaceId, epoch, deviceShort, seq, length)` in the clear (ADR 003 §6.3), can then distinguish
"Papa shared something" from "Papa marked himself busy" **without a key**.

It is not a break of INV-R1: no content escapes, and the adversary learns one bit about a level,
not a word of text. And the cap counts **characters** while the bucket counts **bytes**, so an
80-character note of astral codepoints is 320 bytes and the gap is wider than the number above.

**Not closed here.** Closing it means a second padding tier for `pub.set`, which is a real storage
cost (ADR 002 §8.7 already prices padding at ~1.4×) and a product decision. The boundary is
**measured and pinned** in `§7 · THE BUCKET BOUNDARY`, phrased so that a change to `PAD_BUCKET`, to
the op header or to the entity-key shape moves the row rather than passing quietly, and so that the
day it rises above 80 the row must be **inverted rather than relaxed**.

### E7-5 · a share undone before it is pushed still transmits a retraction — LOW, OPEN

`derivePublication` reads `lastPublished` from the **locally folded** `pub.level`, which includes
this device's own not-yet-pushed op. So "share, then change your mind before the next push" emits a
retraction for an entity no peer ever saw: `pub.level: 'privat'` plus nulls, which creates a cell on
every peer's disk for a uuid they have never otherwise heard of. It discloses **that an entity
exists**, which is the same shape `projectForFamily` already guards against for a
dead-and-never-published entry.

The safe half is verified: the first op is refused at barrier 4 (the truth register has moved on),
quarantined by `sync/family.js` with `seal: …`, and its bytes never reach the relay — so **no
content leaks**. Making `lastPublished` ack-aware would make the projection depend on transport
state and diverge across a member's own two Macs, so it is not an obvious fix. Filed for the owner
of `derivePublication`.

### E7-6 · ADR 004 §5.1's printed `retractPatch` remains unsealable — DOC, confirmed

WP-10 reported it; this pass confirms it end to end. `pub.alive: false` is refused by
`envelope.js` barrier 4 ("a privat payload carries a value"). The shipped `null` is also the better
answer, and §4's row now proves why: the owner's "→ Privat" and the admin's unshare are
**byte-identical on the wire**, so a peer cannot tell which happened. Mutant **M3** kills 23 rows.

### E7-7 · `interact.js`'s old reading was correct only by coincidence — LOW, closed

`store.category(catId)?.defaultVisibility` answers `undefined` for a dangling category **and** for a
`defaultVisibility` outside the enum, and that `undefined` became `'privat'` only because
`ops.js`'s enum validation, `replace.js`'s floor and `materialize.js` all happened to hold. Routed
through `visibilityForNewEntry`, it holds on its own. No mutant dies today — the three downstream
files still hold — and that is exactly the point: it is now robust to any one of them changing.

---

## 6. The mutation table — 22 mutants, 22 dead, plus one null control

Every one against a full scratch copy of the tree; the working tree was never mutated.
Harness: `…/scratchpad/mutants.py`.

| mutant | what it does | first row that dies | rows |
|---|---|---|---|
| **M1** `makeOp` drops the brand again | the real defect, restored | `P7b · …on the SEALED BYTES` | 21 |
| **M2** omission instead of an explicit null | ADR 004 §5.1's bug | `P7b · …on the EMITTED OPS` | 5 |
| **M3** `retractPatch` writes `pub.alive: false` | §5.1's printed snippet | `P7d · note [geteilt → privat]` | 23 |
| **M4** a Privat entry publishes a retraction | 16.1 defeated | `a Privat entry … emits ZERO family ops` | 3 |
| **M5** `RedactionError` logged and skipped | §2.3 defeated | `a RedactionError … STOPS the sync loop` | 1 |
| **M6** the outbox keeps going after a halt | §2.3's other half | same row | 1 |
| **M7** `undo()` does not re-derive | a share that survives ⌘Z | `the truth write and the publication share ONE gid` | 1 |
| **M8** barrier 2 by truthiness | §2.2's printed barrier | `a BLANK text is a value, not an absence` | 1 |
| **M9** barrier 4 `declared ?? folded` | finding S5, restored | `P7f · sealOp re-derives the level` | 1 |
| **M10** project at the LAST-PUBLISHED level | S5's shape one seam earlier | `P7a` | 31 |
| **M11** `_truthOf` drops promotion | §4.1 defeated | `P7c · …the CO-EDITOR's newer value` | 1 |
| **M12** no A3 spelling table | the message stops being A3's | `A3 refuses BY NAME` | 1 |
| **M13** the store publishes nothing | the whole seam removed | `P7a` | 31 |
| **M14** `in` instead of `Object.hasOwn` | the prototype-chain hole | `P7e` | 1 |
| **M15** the brand is synthesised when absent | barrier 3 defeated | `P7e` | 1 |
| **M17** the badge never pends | 16.6 unwired again | `a pending publication shows the OLD…` | 1 |
| **M18** acked level from the register map | E7-2b, restored | same row | 1 |
| **M19** `ackPushed` does not redraw | E7-3, restored | same row | 1 |
| **M20** `mount.js` does not install the cluster | the cluster ships dark | `S5a` / `S5b`, naming `src/js/family/sharing.js` | 2 |
| **M21** the popover hardcodes `'privat'` | 16.4 does not fire | `§7 · 16.4 … the CATEGORY DEFAULT` | 1 |
| **M22** an i18n level word is reworded | the interim table would mask it | 5 rows in `belegt-render.dom.js` | 5 |
| **M16** *(null control)* an unreachable branch | nothing | **SURVIVES, correctly** | 0 |

---

## 7. What a row costs — the density measurements, unchanged by this pass

`src/js/layout.js:PREFIX_COST_PX`, measured in WebKit and re-measured by
`tests/tier2/belegt-render.dom.js` §5 at **22 px and 18 px**:

```
↻ repeat marker    8 px   unchanged from v1
„neu" dot          5 px   foreign only
initial chip      10 px   foreign only
exposure badge     9 px   OWN only
Belegt block       0 px   a fill on a note that was already there

own worst      17 px = 28 % of the 60 px text budget   (badge + ↻)
foreign worst  23 px = 38 %                            (dot + chip + ↻)
```

**Two of the five markers can never co-occur** — the exposure badge is *my* disclosure of *my*
entry; the chip and the dot appear only on someone else's — so ADR 004 §6's contested slot never
has more than three entrants. **The whole family is horizontal**: no marker changes a line box,
`rowCapacity` is untouched, and a family board hosts exactly as many entries per day as a solo one.
The cost is a fixed pixel cost, identical at 18 px and 22 px, so the squeeze is worst at the
narrowest column and never at the shortest row.

**Still owed for print (A4):** `print.css` sets `--col-w: 88px`, a **39 px** text budget, and the
foreign worst case would eat 59 % of it. `belegt-render.dom.js`'s report carries the suggested rule.

---

## 8. What is owed

1. **A second padding tier for `pub.set`, or an accepted-defect row** — finding E7-4. A PO decision,
   not an engineering one.
2. **`derivePublication`'s `lastPublished`** — finding E7-5.
3. **18.2's co-edit write path.** `projectCoEditPatch` exists, is narrow and reviewed, and has **no
   caller**. §3's `P7c` row drives a co-editor's op in through `applyRemote` to prove promotion, but
   nothing in the product *authors* one. LZP-902.
4. **The admin unshare (18.3) is still unsealable.** `envelope.js` barrier 4 reads `ctx.levelOf`
   from the entity's own `visibility` truth register, and an admin unsharing *someone else's* entry
   has no such register — `store.familyLevelOf` correctly answers `null`, and "no authenticated
   level" is a refusal. `retractPatch(kind)` produces the right bytes and there is no `levelOf` that
   can authorise them. Owner: `crypto/envelope.js` / `core/authz.js`.
5. **`tests/tier1/redaction-failpath.test.js` does not exist.** ADR 004 §2.3 names it. Its content
   is now covered by `redaction-invariants.test.js` §3's fourth row (mutants M5, M6), so this is a
   filename the ADR owes rather than a gap.
6. **ADR 005 §1.1's module tree** has no row for `core/project.js`, `core/visibility.js` or
   `family/sharing.js`, and names `assertNeverTransmitted` in `fleet.js`, where it cannot live.
   Doc-only.
7. **A4 print density** — §7 above.
