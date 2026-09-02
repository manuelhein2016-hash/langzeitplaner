# ADR 004 — Privat / Belegt / Geteilt: the redaction boundary

| | |
|---|---|
| **Status** | Accepted — normative. **This is the most security-critical document in the project.** |
| **Date** | 2026-08-25 |
| **Tickets** | LZP-701, 702, 703, 704, 705, 706 · 801, 804, 805, 806, 807 · 901, 902, 903, 904 · 1003 |
| **Stories** | 16.1–16.7, 17.1–17.6, 18.1, 18.2, 18.3, 18.5, 20.5, 21.1, 21.2, A3, A4, A6, A7, A8 |
| **Depends on** | ADR 001 (registers, staged authz), ADR 002 (keys, padding) |

> **The invariant this ADR exists to enforce.** For every op that is sealed under a **family**
> key, for every entity whose level at seal time is not `geteilt`, the op's field patch contains
> no content field with a non-null value. It is asserted on the **emitted ops** and on the
> **sealed bytes** — never on the rendering. A rendering bug can therefore produce the wrong
> pixels; it cannot produce a leak.

---

## 1. One entry, two representations

The register-namespace split is the whole mechanism (ADR 001 §3.1):

```
personal space   note:5e1a-…-9c
                   date · text · categoryId · repeatsYearly
                   visibility · coEdit · _alive · _born                ← THE TRUTH

family space     fnote:mem_7f2c…/5e1a-…-9c
                   pub.level · pub.date · pub.text? · pub.repeatsYearly
                   pub.coEdit · pub.alive                              ← THE PUBLICATION
```

Four structural consequences, each replacing a rule someone would otherwise have to remember:

| property | how it is guaranteed |
|---|---|
| **A3 — categories are never synced** | `categoryId` has **no `pub.` counterpart at any level**. It is enforced by the *absence of a field*, not by a filter someone can forget to apply. |
| **18.1 — ownership** | the family entity key literally contains the owner's memberId. Admissibility compares it to `op.act` (ADR 001 §4.3). There is no owner register to backdate. |
| **20.5 — no admin x-ray** | the admin holds `FSK_e` like everyone. Truth registers were never sealed under it. There is no crypto path and no endpoint. |
| **16.1 — private by default** | a Privat entry produces **no family op at all**. Private by default costs zero bytes on the wire. |

**Invariants, named so tests can cite them:**

- **INV-R1 — no plaintext escape.** The `text`/`label` of a Belegt entry, and every field of a
  Privat entry, are never encoded into an op sealed under a family key. Enforced structurally by
  an allowlist plus a pre-seal assertion (§2), not by review.
- **INV-R2 — two representations, one entity.** At most one truth record and at most one
  publication record, with independent registers and independent stamps.
- **INV-R3 — the owner always sees the truth.** Materialization reads *my* entries from the truth
  registers, never from `pub.*` — except for the promotion rule (§4), which never promotes my own
  `pub.*` writes. A redaction can never make my own board lie to me.
- **INV-R4 — a downgrade removes.** Any transition to a lower level writes explicit `null`s to
  every content register it withdraws, at a newer stamp (§5). Omission is not withdrawal.

---

## 2. The projection — the single choke point

`src/js/core/project.js` — **DOM-free, zero side effects, imports nothing outside `core/`.**
This is the only function in the codebase permitted to turn a local entry into something that
leaves the device.

```js
export const GETEILT_FIELDS = Object.freeze({
  fnote: ['pub.level', 'pub.alive', 'pub.date', 'pub.repeatsYearly', 'pub.coEdit', 'pub.text'],
  fbar:  ['pub.level', 'pub.alive', 'pub.startDate', 'pub.endDate', 'pub.coEdit', 'pub.label'],
});

export const BELEGT_FIELDS = Object.freeze({
  fnote: ['pub.level', 'pub.alive', 'pub.date', 'pub.repeatsYearly'],
  fbar:  ['pub.level', 'pub.alive', 'pub.startDate', 'pub.endDate'],
});
// Note what is absent from BOTH lists, at every level:
//   categoryId  (A3)  ·  owner  (it is the entity key)  ·  memberColor / initial (derived)
// Note what is absent from BELEGT: text, label, coEdit.

/**
 * Build the family-space field patch for one entry. PURE. Additive construction from a frozen
 * allowlist — never `delete p.text`, never `{...entry, text: undefined}`. Both of those are one
 * refactor away from publishing a field somebody adds to Note next year.
 *
 * @param {'fnote'|'fbar'} kind
 * @param {Object} truth                 the entity's materialized truth fields
 * @param {'privat'|'belegt'|'geteilt'} level
 * @param {'privat'|'belegt'|'geteilt'|null} lastPublished
 * @returns {FamilyPatch|null}  null == nothing to publish (privat, never published before)
 */
export function projectForFamily(kind, truth, level, lastPublished) { … }
```

### 2.1 The projection table

Restated as a table because designers and reviewers read this section, not the code.

| truth field | Privat | Belegt | Geteilt | published as |
|---|---|---|---|---|
| `date` / `startDate` / `endDate` | — | **✓** | **✓** | `pub.date` / `pub.startDate` / `pub.endDate` |
| `text` / `label` | — | **—** | **✓** | `pub.text` / `pub.label` |
| `repeatsYearly` | — | **✓** | **✓** | `pub.repeatsYearly` |
| `categoryId` | — | **—** | **—** | *(never — A3)* |
| `coEdit` | — | **—** | **✓** | `pub.coEdit` |
| `_alive` | — | **✓** | **✓** | `pub.alive` |
| `visibility` | — | ✓ | ✓ | `pub.level` |
| owner | — | *(the entity key)* | *(the entity key)* | — |
| member colour, initial | — | *(derived from the member record)* | *(same)* | — |

The owner and the colour are **never fields on the entry**. One fewer thing that can disagree.

### 2.2 Four independent barriers, so no single mistake leaks

1. **Additive construction from a frozen allowlist.** Adding a field to `Note` does not publish
   it; someone must edit `GETEILT_FIELDS`, which shows up in review.
2. **`assertFamilyPatch(patch, kind, level)` throws `RedactionError`** before anything is sealed:
   ```js
   export function assertFamilyPatch(patch, kind, level) {
     const allowed = new Set(level === 'geteilt' ? GETEILT_FIELDS[kind] : BELEGT_FIELDS[kind]);
     for (const k of Object.keys(patch)) {
       if (allowed.has(k)) continue;
       if (patch[k] === null && (k in FIELDS[kind])) continue;  // an explicit WITHDRAWAL, §5
       throw new RedactionError(`field "${k}" may not be sealed under a family key`);
     }
     if (level !== 'geteilt' && (patch['pub.text'] || patch['pub.label']))
       throw new RedactionError('non-geteilt payload carries content');
     if ('categoryId' in patch || 'pub.categoryId' in patch)
       throw new RedactionError('category leaked to the family space (A3)');
   }
   ```
   The `=== null` escape is what lets a *withdrawal* through — a downgrade must be able to clear a
   previously shared text (§5). It can never let a **value** through.
3. **`sealOp()` accepts only a branded patch for a family space.** `projectForFamily` returns an
   object carrying a non-enumerable brand; `sealOp` refuses any family-space `pub.set` whose
   patch is unbranded. **No future caller can bypass the allowlist**, including one written by a
   downstream agent who never read this document.
4. **`level` is read from the *authenticated entity state*, not from the caller.** A caller that
   passes `'geteilt'` for a Belegt entry does **not** get its text sealed — this is the correction
   to a design in which `projectForFamily(entry, vis)` and its assertion trusted the same
   caller-supplied argument, so a single level confusion defeated all four barriers at once.

   > **AMENDED 2026-08-28 — finding S5.** This clause used to spell the re-derivation as
   > `level = patch['pub.level'] ?? currentPubLevel(entityKey)`. **That formula reinstated the
   > very confusion the barrier exists to correct**, and `envelope.js` implemented it literally.
   > The caller's `pub.level` won whenever the caller supplied one, and a projection supplies one
   > on every transition — so nearly always. `brand.level === level` was then satisfied by the
   > same caller having lied twice, and the backstop was handed the lie as its level. The E3 red
   > team sealed a `pub.text` for an entry the register map called **belegt**
   > (`tests/attack/crypto-member-read.test.js`, row M-R7c); the enumeration of input domain C4
   > (`tests/helpers/crypto-domains.js`) priced it at 35 of 324 cells — every cell where the brand
   > backs the lie.
   >
   > **Two things were wrong, and the second is why the first looked necessary.**
   >
   > **(a) The wrong register was named.** `currentPubLevel(entityKey)` is the folded `pub.level`
   > of the *family* entity — the **level a transition is moving away FROM**. Against that, every
   > legitimate share disagrees, so the `??` was papering over a mis-named source rather than
   > protecting a real case. The authenticated state this barrier means is the entity's own
   > **`visibility` truth register in the personal space** (§2.1's last row: `visibility` is what
   > `pub.level` is *published as*). At publish time that register already carries the **new**
   > level, because the visibility op is emitted and folded before the publish microtask runs
   > (§2.3, ADR 001 §0.9). The transition therefore agrees with the map and needs no exception.
   >
   > **(b) A declared level was treated as a substitute. It is a claim to be CHECKED.**
   >
   > The normative rule, which `src/js/crypto/envelope.js:assertProjected` now implements and
   > `tests/property/crypto-domains.test.js` walks over all 325 C4 inputs:
   >
   > ```js
   > const level = ctx.levelOf(op.e);              // the ONLY assignment; `declared` never appears
   > if (!VISIBILITY_LEVELS.includes(level)) throw new RedactionError(…, 'barrier4');
   > const declared = op.f['pub.level'];           // a RESTATEMENT, checked like brand.level
   > if (declared !== undefined && declared !== null && declared !== level)
   >   throw new RedactionError(…, 'barrier4');
   > ```
   >
   > `absent` and `null` are **silence**, not disagreement — they consult the map, which is what
   > the map is for, and §5's withdrawal patches legitimately carry `pub.level: null`. An answer
   > from the map outside `privat|belegt|geteilt` (including `null` and `undefined`) is a
   > **refusal**, never a fallback to the patch: on a fresh device mid-pull the map has no answer
   > for most entities, and "no authenticated level" must read *you cannot publish*.
   >
   > **The obligation this puts on the outbox (WP-10):** `ctx.levelOf` MUST be wired to the truth
   > register, not to the published one. Wired to the published one, every first share becomes a
   > barrier-4 refusal — loudly, on the first attempt, which is the correct symptom of a mis-wired
   > seam and the reason this is safe to state as a hard rule. `PROJECT_CONTRACT` in
   > `src/js/crypto/envelope.js` carries it as an executable clause.
   >
   > ~~**Still open, and NOT this barrier's to close:** barriers 3, 4 and the backstop are all
   > **author-side**. `geteiltOnly` (`core/ops.js` `FIELDS`) is enforced at seal time only and
   > `core/authz.js` never reads it, so a peer running a patched build still has no seal path to
   > defeat and a receiver applies whatever arrives. The mirror check belongs in the fold: refuse
   > (or null out) a `geteiltOnly` field carrying a non-null value when the entity's folded
   > `pub.level` is not `geteilt`. Asserted as still-missing by row M-R7c.~~
   >
   > **CLOSED — and this paragraph was stale in the same commit that wrote it.** The mirror was
   > built, in the seam this paragraph names: `src/js/core/authz.js` **stage 3c**, "INV-R1 on the
   > RECEIVING device". It reads the same `FIELDS` marks the author side reads and adds no table
   > of its own; it **drops the field and admits the op** rather than rejecting, because at Belegt
   > a `pub.date` is not content above the level but the entire legitimate Belegt payload, and
   > rejecting the op would destroy the booking a Geteilt→Belegt downgrade exists to keep; an
   > explicit `null` always passes (§5's withdrawal); governing registers (`pub.level`,
   > `pub.coEdit`, `pub.alive`, `_born`) are never dropped; and it reads the **final folded**
   > level, so it is retroactive by construction and no non-null `geteiltOnly` value can survive
   > in the register map while the level says otherwise, in any arrival order. What was withheld
   > is reported on `AuthzResult.contentAboveLevel`.
   >
   > Row **M-R7c** now asserts the opposite of what this paragraph says it asserts, and it does so
   > **behaviourally rather than by grep** — the attacker skips `sealOp` entirely, which is exactly
   > the capability a patched build has and an honest one does not. The enumeration is domain
   > **C5** in `tests/helpers/crypto-domains.js` (60 inputs, the receiving-side mirror of C4),
   > added by the integrator for this reason; 11 of those 60 are the cells this paragraph owned.
   > Reverting stage 3c kills M-R7c's receiver half and exactly those 11 C5 cells (E3
   > verification, mutant M-E, 2026-08-29).
   >
   > **The obligation that remains** is the one every fold-side rule carries: stage 3c is a
   > function of the folded level, so anything that materializes a family entity WITHOUT running
   > `foldAuthorized` sees the unredacted patch. Nothing does today.

### 2.2b Barrier 4's **retraction clause** — story 18.3, LZP-903 (added 2026-09-02)

**The blocker it closes.** `ctx.levelOf` answers from the entity's own `visibility` truth register.
An admin unsharing *somebody else's* entry **has no such register on their device** — the key names
its owner (ADR 001 §4.4) and a viewer holds `pub.*` and nothing else — so `store.familyLevelOf`
answers `null`, correctly, and "no authenticated level" is a refusal. `retractPatch(kind)` produces
the right bytes and **no `levelOf` could authorise them**. 18.3 was therefore unsealable (E7,
`FINDINGS.md` §11c row 2).

**The clause, normative.** When `ctx.levelOf(op.e)` answers outside `privat|belegt|geteilt`,
`sealOp` refuses — *unless all four of these hold*, in which case the applied level is the **string
literal `'privat'`**:

1. the patch is a **pure retraction**: `pub.level` present and `'privat'`, every other field an
   explicit `null` — i.e. `retractPatch(kind)`, and the same predicate `core/authz.js:
   classifyUnsharePatch` admits at stage 3a;
2. `brand.level === 'privat'`;
3. a **second authenticated source** — `ctx.adminOf(op.space)`, the family space's `admin` register
   as resolved by the admin chain (ADR 001 §4.1) and folded by `foldAuthorized` — answers a
   `MemberId` **equal to `op.act`**;
4. and every refusal is the *original* "no authenticated level" refusal with one sentence added, so
   the default outcome for an entity the map cannot answer for is **unchanged**.

`ctx.adminOf` is wired in `src/js/family/unshare.js` to `store.familyAdmin().admin` and to nothing
else. Wiring it to a UI flag, a caller-supplied role or the relay's opinion is the mis-wiring the
port exists to make impossible.

> **Why this is still NOT a caller-declared level** — the question finding S5 makes mandatory of
> any change to this barrier.
>
> **(a) The level is a literal.** `'privat'` is the floor of the model. There is no expression in
> the clause in which `op.f`, `brand` or any argument appears on the right-hand side of the
> assignment — the same sentence clause (i) of the main path carries. `op.f['pub.level']` remains
> a **restatement checked for agreement**, exactly as on the main path.
>
> **(b) The second source is an IDENTITY, never a level.** It cannot raise a level: whatever
> `adminOf` answers, the applied level stays `'privat'`. S5's hole was that a caller-supplied
> *level* won; nothing here supplies one.
>
> **(c) The codomain is one content-free patch shape.** Because the level is `'privat'`, barrier
> 4's privat clause, `ctx.assertFamilyPatch` and `assertNoContentAboveLevel` all run at the
> **strictest** level. So even a wholly forged answer to (3) leaks nothing: it can only *withdraw*.
>
> **(d) Authority is settled by the fold, not by this gate — D7.** An op that gets past (3) on a
> patched build is REJECTED at `core/authz.js` stage 3a (`NOT_OWNER`) on every honest device,
> including the author's own. This clause exists so an honest admin's op is not unsealable, not to
> be where admin authority is decided. Enforcement is by convergence, not by gatekeeper.
>
> **(e) It cannot override a level the map HAS.** It is reached only when `levelOf` has no answer,
> so no `adminOf` answer changes the outcome for an entity this device owns.
>
> Executable form: `crypto/envelope.js:RETRACTION_CLAUSE` (6 clauses) and
> `core/project.js:ADMIN_UNSHARE_CONTRACT` (6 clauses). Asserted by
> `tests/tier1/unshare.test.js` U1 — 105 cells of `levelOf × patch × adminOf` through the real
> `sealOp`, against an oracle written from this section. Mutants **M-A** (drop the `seat ===
> op.act` comparison) and **M-B** (drop the retraction-shape test) each kill U1; **M1** — applying
> the *declared* level instead of the literal — is provably **equivalent**, because clause 1 admits
> only patches whose declared level already IS the literal. That equivalence is the strongest form
> of (a) available: on this path there is no caller value distinguishable from the constant.

### 2.3 The failure path is loud, never swallowed

`RedactionError` is thrown on the publish path, which runs inside the `queueMicrotask` after
`emit()` (ADR 001 §0.9) — where an unhandled rejection is plausible. Therefore, normatively:

> `store._publishAndEnqueue()` wraps the projection in `try/catch`. A `RedactionError`
> **stops the sync loop**, sets the `error` sync state, writes a local diagnostic, and shows the
> settings strip. It is **never** logged-and-skipped, and it never silently omits a family op —
> because a silently omitted downgrade op is exactly the failure in §5.

`tests/tier1/redaction-failpath.test.js` asserts that path exists and that sync stops.

---

## 3. Category default visibility (16.4, LZP-703)

`cat.defaultVisibility ∈ {'privat','belegt','geteilt'}`, default `'privat'`, a **personal-space**
field on the category (ADR 001 §3.1) that is **never published** — like every other category
field (A3).

It is read **exactly once, at entry creation**, by the six create paths (`interact.js:543`,
`interact.js:307`, `popover.js:159` and their v2 siblings):

```js
visibility: cat(catId)?.defaultVisibility ?? 'privat'
```

It is **not** a live rule. Changing a category's default never re-publishes existing entries —
that would be a bulk disclosure triggered by a settings click, which 16.1 ("oversharing is
structurally impossible") forbids. The global default stays Privat, and the legend's category
editor states the default next to the swatch.

Interaction with 4.6 (`ensureVisible`): unchanged. A hidden category still auto-unhides on
create; visibility-of-category and visibility-to-family are orthogonal axes and must never be
conflated in the UI.

---

## 4. Materialization: owner side vs viewer side (LZP-706, deliverable 19)

### 4.1 The owner

Reads **truth**, then applies **promotion** for co-editable fields:

```js
effective[f] = maxByStamp( truth[f], pub[f] where pub[f].author !== me );
```

> **Never promote my own `pub.*` writes.** They are projections *of* the truth, not edits *to*
> it. This single asymmetry is why publishing `pub.text: null` to make an entry Belegt does not
> blank my own note. **Put this sentence in a comment in `materialize.js`.** It is guarded by
> property test P7c.

So the owner sees: the real text, in **my category colour** (17.2 — my board stays mine), fully
editable, plus the **exposure badge** (§6).

### 4.2 The viewer

Reads `pub.*` only. Truth fields for a foreign entity cannot exist, because they were never
transmitted.

| `pub.level` | renders as |
|---|---|
| `'belegt'` | a neutral block: the **owner's member colour**, the initial chip ("M"), the word `t('belegt')` in place of text, no resize grips, no editor, no category colour anywhere |
| `'geteilt'` | the real text, member colour, initial chip; editable **iff** `pub.coEdit === true` |
| `'privat'` or absent | **not projected at all** |

Plus, on both: the quiet „neu" dot (17.5, §7.2) and the attribution line (17.6).

### 4.3 Render seams — the exact lines

From the v1 code map; every one of these is a no-op in solo mode.

| file:line | change |
|---|---|
| `layout.js:111` | build a second map `visibleMember`, same `!== false` tri-state convention as `visibleCat` |
| `layout.js:115`, `:119` | add `&& memberVisible(e.ownerId)` to the note and bar filters (17.3) |
| `layout.js:142`, `:196` | `isForeign ? colorOf(memberColorRef) : colorOf(catOf.get(categoryId)?.paletteRef)` — **never** fall through to `colorOf(undefined)`, which silently returns `PALETTE[0]` (blue, `palette.js:28`) and would render a foreign entry as one of mine |
| `layout.js:193` | **mandatory injection point for foreign notes** — they must pass through `notesHere` so they hit the capacity slice at `:208-210` and are counted into `overflow`. That is story **17.4**. |
| `layout.js:132` | **mandatory injection point for foreign bars**, for the same reason (lane cap 3.8, `+n`) |
| `board.js:118-123` | the initial chip goes **before** the text node, in the same slot as the `↻` marker at `:121`, for the same reason (`.note` is `text-overflow: ellipsis`, `app.css:282-284`) |
| `board.js:137`, `:156` | `seg.bar.redacted ? t('belegt') : (seg.bar.label \|\| t('untitledBar'))` — the existing `\|\| t('untitledBar')` fallback is exactly the seam |
| `board.js:136` | `if (seg.bar.redacted) bar.classList.add('belegt')` — hatched / desaturated fill in CSS beside `.bar` (`app.css:328-334`) |
| `board.js:141-142` | suppress `.bar-handle` when `!canEdit(entry)` where `canEdit = !isForeign \|\| coEdit` (18.1/18.2, LZP-901) |
| `interact.js:116-127` | the same guard on the `resize` and `bar`-move pending branches |
| `i18n.js` | add `belegt`, `geteilt`, `privat`, `vonMember`, `geaendert`, `neu` to **both** tables |
| `popover.js:47-61` | `notesOn`/`barsOn` duplicate `layout.js:61-79` + `:132-135` and will **silently omit foreign entries** unless updated in lockstep. **Replace both with one shared selector extracted into `src/js/core/entities.js`** — the cheapest way to guarantee 17.1 and A6 agree, and a net line reduction. |
| `find.js:186-198` | search `pub.text`/`pub.label` for Geteilt, and the **owner's display name** for Belegt (A6). Note `find.js:70` reads scratchpads from the live **DOM** while `:186-198` reads the **store** — two paths, and only the store path gains family entries (A5 keeps scratchpads private). |
| `print.js:67-83` | mirror the member section into the print legend, honouring member toggles, or the printed poster loses the key for every person-coloured entry (A8, 12.3) |
| `legend.js:18-46` | wrap `:22-42` in a *Meine Kategorien* section, append a *Familie* section, keep the "bearbeiten" button at `:43-45` last (A3, 17.3) |

**A hard constraint deliverable 16 must price in.** `app.css:130` makes `.legend` a **single flex
row inside the 40 px toolbar** sharing horizontal space with the today button, pager, two layer
toggles and the search box (`index.html:33-66`), with `overflow: hidden` — it **clips, it does not
wrap**. At 8 members plus 4+ categories it overflows. Deliverable 16 needs a real answer: a
disclosure popover, a second row (costing ~22 px of the ~900 px vertical budget), or collapsing
categories to swatches.

**The sharing cluster's home** (A7, LZP-702/805): between `popover.js:212` and `:214` for notes
(after the ↻ toggle, before delete) and after `:251` for bars. `toggleSwatches` (`:283-296`) is
the exact precedent for a disclosure strip inserted below a row
(`insertAdjacentElement('afterend')`), and `.pop-cat` (`app.css:437-445`) is the style to clone
for a segmented control. **`barRow` (`:224-253`) currently has no ✕ and no ↻** — the cluster must
be added to *both* row builders or bars lose visibility control in the popover.

---

## 5. Transitions and retraction (16.5, LZP-704) — and the bug that would not have been caught

Every transition is **one transaction** carrying the truth write plus the publication write:

| transition | ops (one `gid`) |
|---|---|
| Privat → Belegt | `note.set{visibility:'belegt'}` + `pub.set{'pub.level':'belegt','pub.date':…,'pub.repeatsYearly':…,'pub.alive':true,'pub.text':null,'pub.coEdit':null,'_born':…}` |
| Privat → Geteilt | `note.set{visibility:'geteilt'}` + `pub.set{ …all GETEILT_FIELDS…, '_born':… }` |
| Belegt → Geteilt | `note.set{visibility:'geteilt'}` + `pub.set{'pub.level':'geteilt','pub.text':<current text>,'pub.coEdit':false}` |
| **Geteilt → Belegt** | `note.set{visibility:'belegt'}` + `pub.set{'pub.level':'belegt', **'pub.text':null**, 'pub.coEdit':null}` |
| **→ Privat** (from either) | `note.set{visibility:'privat'}` + `pub.set{'pub.level':'privat','pub.alive':false,'pub.date':null,'pub.text':null,'pub.repeatsYearly':null,'pub.coEdit':null}` |
| delete while published | `note.set{_alive:false}` + `pub.set{'pub.alive':false, …all content fields → null}` |
| **admin unshare (18.3)** | `pub.set{'pub.level':'privat', …all content → null}` **only** — `core/project.js:adminUnshareOp`, whose patch IS `retractPatch(kind)`, so it is byte-identical to the row above. The owner's truth is untouched — the entry reverts to owner-private and is **never deleted**. Sealable since 2026-09-02 via §2.2b. On receipt, the owner's client also sets its local `visibility` to `'privat'` in a follow-up txn so the two agree — `core/project.js:adminUnshareFollowUp`, and it is **not optional**: without it `derivePublication` re-publishes the whole Geteilt patch on the owner's very next keystroke and silently undoes the moderation (measured, `tests/tier1/unshare.test.js` U3-b). |

### 5.1 ⚠ A downgrade MUST write explicit `null`s. Omission is not withdrawal.

This is the single highest-value defect in the whole v2 surface, and it is the reason this
section is written the way it is.

The family materializer is a per-field LWW fold. If `Geteilt → Belegt` published a patch that
merely **omitted** `pub.text`, **no register write for `pub.text` would occur**, the old register
would keep its value and its stamp, and **every other member's board would keep rendering the
text**. The entry would look correctly downgraded on my board and be fully readable on Mama's.

**No owner-side smoke test catches this**, because the owner's board is right. That is exactly
what makes it dangerous.

> **Rule (normative).** A downgrade writes a `null` to **every content register it withdraws**,
> stamped at the downgrade's HLC. `→ Privat` additionally nulls **every** content register —
> `pub.alive` included — so a later re-share cannot resurrect stale text through registers that
> were never overwritten.

```js
// src/js/core/project.js — CORRECTED 2026-09-02 (finding E7-6, LZP-903)
export function retractPatch(kind) {
  const out = { 'pub.level': 'privat' };
  for (const f of GETEILT_FIELDS[kind])
    if (f !== 'pub.level') out[f] = null;   // pub.alive INCLUDED — see below
  return out;                               // every withdrawable field, explicitly null
}
```

> **AMENDED 2026-09-02 — this block used to seed `'pub.alive': false`, and that patch cannot be
> sealed by the code this ADR governs.** Three shipped gates say so, and §5's own transition table
> above says so too (its admin-unshare row is "`pub.level:'privat'`, all content → null", with no
> `pub.alive: false` in it):
>
> 1. `crypto/envelope.js` barrier 4's privat clause refuses any family patch at `privat` carrying
>    a non-null value in any field but `pub.level`. A `false` **is** such a value.
> 2. `core/authz.js:classifyUnsharePatch` reads a non-null value beside `pub.level: 'privat'` as
>    version **skew** and PARKS the op — so a retraction shaped like the old block would arrive at
>    every peer unapplied.
> 3. `core/authz.js:unsharePatch` — the admin's retraction, shipped since E3 — already writes
>    `'pub.alive': null`.
>
> **And `null` is the better answer, not merely the compatible one.** One retraction shape means
> the owner's own „→ Privat" and the admin's unshare (18.3) are **byte-identical on the wire**, so
> a peer cannot tell which happened — Principle 9 enforced by the absence of a distinguishing
> byte rather than by a policy. Nothing is lost: §4.2 drops an entity on `pub.level === 'privat'`
> before it ever consults the tombstone. Asserted by `tests/tier1/unshare.test.js` §3 (byte
> equality across all three producers) and U2-b; mutant **M-C** — restoring `false` — makes
> `retractPatch` throw `INV-R4` at module load.

**Property test P7d (mandatory, LZP-704's AC):** *for any random sequence of visibility
transitions ending in `privat`, a peer's family materialization contains no field of that entity
other than a tombstone.*

### 5.2 The guarantee, stated precisely

> **Claim.** Let `t` be the moment I downgrade entry `E` from Geteilt to Privat, producing
> retraction op `r` with server sequence `seq(r)`. For every peer device `D` that pulls the
> family space to a cursor `≥ seq(r)`, `D`'s materialized state contains **no content field of
> `E`**.
>
> **Proof.** `r` writes `null` to every content register of `E` at stamp `s(r)`. Every op `o`
> that previously wrote a content value of `E` was authored before the local downgrade on my
> device, so `s(o) ≺ s(r)`: my clock advanced past every stamp I authored, and any *remote*
> write to `E` requires `pub.coEdit`, whose ops my clock also received and absorbed via
> `clock.observe()`. By ADR 001 §6 each register holds `max_≺`, which is `null`. Materialization
> step 1 skips `null`-valued registers, and step 3 drops the entity on `pub.alive === false`. ∎
>
> **What the claim does not say.** Nothing about a peer that never pulls, about a screenshot,
> about a peer's `snapshots.json`, or about a modified client that keeps its pre-retraction fold.
> Those are outside cryptography and outside code. They are addendum §6, and §7.3 is how the
> product tells the truth about them.

### 5.3 Three mechanisms, all required

1. **The register overwrite** (§5.1) — even a peer that never saw the intermediate op lands on
   the final state, because the argmax rule ignores intermediates.
2. **The forget pass.** On applying a family op that sets a content field to `null` or
   `pub.alive` to `false`, the receiving client immediately (a) removes the entity from the
   materialized arrays, (b) purges every line in its local `ops.jsonl` whose entity key matches
   and whose space is the family space, and (c) drops the corresponding register **values** while
   **retaining the stamps**. Retaining stamps is required for convergence; dropping values is what
   makes the removal real on that peer's disk.
3. **Honest copy** (ADR 002 §7.4). There is no server-side per-entity purge (ADR 003 §6.3) — an
   endpoint any member could use to delete another member's ops from the relay is a censorship
   primitive. The exposure window for a peer that has not yet pulled is therefore one pull cycle
   (~45 s online, unbounded offline), and the UI says so rather than implying a guarantee we
   cannot keep.

---

## 6. Exposure badges (16.6, LZP-705)

> **The badge must never promise a privacy state that has not yet reached the server.**

The badge on **my own** entry is derived from **what actually reached the log**, not from my local
intent:

```js
exposure(entity) =
  outboxHasPendingPubOp(entity) ? { level: lastAckedPubLevel(entity), pending: true }
                                : { level: currentPubLevel(entity),   pending: false };
```

- `lastAckedPubLevel` reads the family register `pub.level` **restricted to ops that carry a
  server `seq`** (i.e. are in `accepted`/`duplicate`, ADR 003 §3.1).
- A pending upgrade therefore shows the **old, lower** exposure plus the pending marker. A pending
  downgrade shows the **old, higher** exposure plus the pending marker. Both errors point the same
  way: the badge never under-reports what others can see.
- Rendering: a 8 px glyph in the `.note` prefix slot (`board.js:118-123`) and on the bar segment;
  `pending` is the same glyph, hollow. Belegt and Geteilt get distinct glyphs; Privat gets none —
  the absence of a badge means private, which is the default and the quiet state (Principle 8).

The badge system is **one family** with the `↻` repeat marker (9.2), the initial chip (17.2) and
the „neu" dot (17.5), all coexisting at 24-px rows — deliverable 17, and it is a single design
problem, not four.

---

## 7. No surveillance mechanics (Principle 9, addendum §6)

A stable entity key across a downgrade means a viewer's client *could* detect "this was Geteilt
yesterday, now it is Belegt". **Three binding rules:**

1. **A Belegt block that was downgraded from Geteilt renders identically to one that was always
   Belegt.** No history, no „war geteilt", no strikethrough, no animation.
2. **The „neu" dot fires only on content-*adding* changes** (17.5, LZP-804):
   ```js
   isNew(e) = maxSeq(e) > lastSeenSeq[space]
              && !levelDecreased(e)          // a retraction or downgrade never dots
              && pub.alive !== false          // a deletion never dots
   ```
   `lastSeenSeq` is a **device-local pref** (ADR 001 §3.3). The dot fades once seen. No popups, no
   counters, no push.
3. **Attribution (17.6) shows who and when, never what.** „von Mama · geteilt · geändert So." —
   composed at `board.js:124`/`:137` (the two `title` sites) and in the popover row. There is no
   level history, no diff, no "changed from".

**There is no op kind for a read receipt, a presence signal, or a visibility-change notification.
The eight kinds in ADR 001 §3 are the whole vocabulary**, and that is how Principle 9 is enforced
— by the absence of a mechanism, not by a policy.

### 7.3 Copy contract

See ADR 002 §7.4 for the exact required strings and the forbidden ones. LZP-1003 audits **strings**
as well as code.

---

## 8. Co-editing (18.2, 18.5 · LZP-902, 904)

- `pub.coEdit` exists **only at Geteilt** (§2.1). The three-state control disables the co-edit
  flag at any other level: co-editing dates you can see while the text stays hidden is
  incoherent.
- A co-editor's write goes into `pub.*` and is admitted by ADR 001 §4.3 stage 3b. It reaches the
  owner's board through **promotion** (§4.1) and every other member's board directly.
- **The lost-edit notice (18.5, deliverable 23)** is a *UI observation of the fold*, never a merge
  rule: it fires when a field I wrote within the last 30 s is subsequently overwritten by a remote
  write with a greater stamp. One line, inline, self-dismissing. It is **best-effort** — it only
  fires if my client is running when the winning op arrives, and it never fires for the peer whose
  op arrived second at *my* machine. Stated as a weakness in ADR 001 §13.1.
- **A co-editor can never grant themselves co-edit.** `pub.coEdit` is a *governing* field folded
  in stage 3a, admissible only from the owner (or the admin's unshare). That ordering is the whole
  point of the staged fold.

---

## 9. Series-level visibility for repeats (A4)

A repeating note **is** its series (9.3, one object). There is no `seriesId` field and there are no
occurrence entities (ADR 001 §3.1). Therefore:

- There is **exactly one `visibility` register and one `pub.level` register per series**, so
  "series-level visibility, no per-year exceptions" is free and no per-year variant can be
  constructed.
- The family key `fnote:<mem>/<uuid>` is uuid-addressed, so moving a repeat's anchor
  (`interact.js:330-334`, which rewrites `date` while keeping the anchor *year*) cannot change
  what the family record points at.
- A Geteilt yearly repeat publishes `pub.date` (the anchor) and `pub.repeatsYearly: true`; each
  peer expands occurrences locally with `dates.js:projectYearly` (including the Feb-29 → Feb-28
  rule, 9.4) and honours 9.5 (a series exists from its first year onward). **No occurrence op ever
  crosses the wire** — which is also why a three-weeks-offline device converges without special
  handling (ADR 003 §3.4).

This is A4's "killer family feature": Oma's birthday entered once, visible to everyone, forever,
at the cost of one entity and one register.

---

## 10. The invariant tests that must exist

These are LZP-701's and LZP-1003's acceptance criteria. **A ticket in E7 does not close without
its row here green.**

| id | property | asserted on |
|---|---|---|
| **P7a** | for every emitted family op, `Object.keys(patch) ⊆ GETEILT_FIELDS[kind] ∪ BELEGT_FIELDS[kind] ∪ {explicit nulls}` | the emitted ops |
| **P7b** | for every entity whose level ≠ `geteilt`, no emitted family op carries a non-null `pub.text` / `pub.label` | the emitted ops |
| **P7c** | promotion never promotes the owner's own `pub.*` writes: after `Geteilt → Belegt`, the owner's materialized `text` is unchanged | materialized state, both sides |
| **P7d** | for any random sequence of transitions ending in `privat`, a peer's materialization contains no field of the entity but a tombstone | peer materialization |
| **P7e** | `assertFamilyPatch` throws for every off-list field, and `sealOp` refuses an unbranded family patch | unit |
| **P7f** | `sealOp` re-derives `level` from the register map: a caller passing `'geteilt'` for a Belegt entity does not get its text sealed | unit |
| **P7g** | `categoryId` appears in no family op, at any level, ever | the emitted ops + the sealed bytes |
| **P7h** | co-edit: a non-owner cannot write `pub.level`, `pub.coEdit` or `pub.alive`; shuffling ops never changes which ops are admitted | authz fold |
| **P7i** | a Belegt op and a Geteilt op of the same entity are **the same ciphertext length** (padding, ADR 002 §5.3) | sealed bytes |
| **P7j** | *(18.3, LZP-903)* the admin unshare **reverts** (a peer holds `pub.level: 'privat'` and an explicit null in every other register), **never deletes** (the owner's board and personal-space registers are untouched, same value, same stamp, same op) and **never reads** (`adminUnshareOp` is arity 2, refuses an unknown `spec` key, and produces bytes that are a function of the KIND alone) | peer registers + owner board + the emitted op |
| **P7k** | *(18.3, §2.2b)* barrier 4 seals a retraction for an entity this device does not own **iff** the patch is a pure withdrawal and `ctx.adminOf(op.space) === op.act`; the applied level is the literal `'privat'` on every such cell, and an entity the map CAN answer for is unaffected by any `adminOf` answer | `sealOp`, 105-cell domain |

### 10.1 `assertNeverTransmitted` — the end-to-end leak test

The fleet harness records, per device: **every pre-seal plaintext** handed to `sealOp`, **every
sealed byte** handed to the transport, and **every stored server envelope**. Then:

```js
fleet.assertNeverTransmitted('Zahnarzt', { except: ['papa-desktop', 'papa-laptop'] });
```

It fails if the UTF-8 of the string appears in any recorded plaintext or any sealed byte outside
the excepted devices, **and** it additionally decrypts the whole family log with **each epoch
key** and fails if any resulting object carries a key outside the level's allowlist.

This is the only check in the design that covers the whole pipeline — projection, assertion,
sealing, transport, storage and decryption — rather than one stage of it. **Run it in every Belegt
scenario.**

---

## 11. Known weaknesses

1. **Belegt leaks existence, owner and duration — by choice** (16.7). Across months, a family
   member can infer real patterns from Belegt blocks alone. Belegt is *not* privacy; it is a
   smaller disclosure. Pure invisibility is what Privat is for, and deliverable 18 must make that
   legible.
2. **Retraction is client-cooperative** (§5.3, ADR 002 §8.3).
3. **The exposure badge can lag reality by one pull cycle** in the pending state — deliberately in
   the safe direction (§6).
4. **The promotion rule is the hardest thing here to hold in your head**, and P7c is the only
   thing standing between it and a bug that blanks the owner's own note.
5. **A viewer briefly sees an entry-shaped hole** when a Geteilt entry's `pub.text` op arrives in
   the next batch (ADR 001 §13.6). Chosen over inferring meaning from a missing field.
6. **Padding costs ~1.4× storage** and does not hide timing (ADR 002 §8.7).
7. **The legend's horizontal budget is a real, unsolved design constraint at 8 members** (§4.3).
