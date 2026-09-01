# E8 — family board rendering. Verification against the constraint that outranks it.

**Date:** 2026-09-01 · **Tickets:** LZP-801…807 (+808 stretch) · **Stories:** F17 17.1–17.7,
A3, A6, A7, A8, 2.4, 2.5, 3.7, 3.8, 9.2, 12.3, 14.1, 16.6, 16.7 · **Normative:** Design Spec v1
§3 principle 1 and §11 challenges 1/3/5 · DESIGN-DECISIONS §B/§C/§F · Addendum F17 and
deliverable 17 · ADR 004 §4 (the render seams) and §6 (the badge vocabulary)

---

## 0. The one-paragraph verdict

**The family is on the board and the board did not move.** Seven other people, 3 059 notes and
416 bars across two years render into a board whose row height, row block, column width, note-body
width, toolbar height and total height are **byte-identical to the solo board built from the same
fixture** — `deepEqual`, in the shipping WebKit, in `family-density.dom.js` §4. Every pixel E8
spends is spent **horizontally**, out of the ~60 px of note text v1 already had, and the worst case
is priced and published: **22.8 px** for a foreign entry carrying a „neu" dot, a chip and a ↻,
against `layout.js:PREFIX_COST_PX.foreignWorst` of 23. **The line box is 10 px in every one of the
seven marker combinations, exactly as in v1.**

**Deliverable 17's real question — do the five badges coexist — is answered by an overlap audit,
not by an opinion.** One day row carrying a visibility badge (16.6), a Belegt block (16.7), an
initial chip (17.2), a „neu" dot (17.5) and a ↻ repeat marker (9.2) **simultaneously**, plus the
`+n` badge and three bar lanes: **7 painted marks, 0 collisions, smallest mark 3 × 3 px, every gap
≥ 1 px.** The audit is mutation-tested — a 5 px negative margin on `.chip` turns it red and names
the two boxes and their overlap in pixels.

**At 18 px, v1's minimum, the answer changes and it is stated rather than smoothed over.** The
capacity rule gives an 18 px row one line, so the same day draws **one** entry and three marks; the
visibility badge and the ↻ go into `+5`. **Nothing overprints and nothing is illegible** — the loss
is v1's own capacity rule, not an E8 collision — but the sentence "all five coexist at 24 px" is
true at the 22 px default and **false at the 18 px floor**, and that is the finding.

**The perf AC (LZP-1007) is met with an order of magnitude in hand**, and the number that carries
the claim is the **worst drag frame: 8.7 ms of a 16.7 ms budget** in Chromium, ≤ 6 ms in WebKit, over
600 measured frames across three gesture kinds. **A wall-clock frame rate could not be sampled and
is not claimed** — neither available engine renders to a visible window in this environment, so rAF
is suspended in both; §5 measures main-thread work per frame instead and says so in its own output.

**Five suites are green. `test:fleet` is not, and none of the six failures is E8's** — they are the
parallel workflow's uncommitted founder-removal guard against their own not-yet-updated red team,
and the same suite is 244/244 at HEAD.

---

## 1. Suites — measured at the close of the pass

```bash
npm test               # tier 1                → 2008 pass /  0 fail  (170 suites)
npm run test:property  # property + domains    →  101 pass /  0 fail  ( 22 suites)
npm run test:attack    # adversarial corpus    →  860 pass /  0 fail  (153 suites)
npm run test:server    # relay                 →  892 pass /  0 fail
npm run test:fleet     # multi-device fleet    →  252 pass /  6 fail  ← NOT E8's, see §8.1
npm run test:dom       # tier 2, real WebKit   →  642 pass /  0 fail  (36 files)
```

Zero npm dependencies · no `node_modules` · no stray root files.

**Tier 2 files that are E8's:** `family-render.dom.js` 18 · `family-legend.dom.js` 13 ·
`family-attribution.dom.js` 25 · **`family-density.dom.js` 9 (new, this pass)** — 65 rows.

### 1.1 Two v1 characterization rows were red at HEAD, and both are fixed

The brief's oracle is v1: *if a v1 row goes red, E8 is wrong, not the test.* Two rows were red on
2026-09-01. **Both were reproduced in a pristine `git archive HEAD` copy with every E8 change
absent**, so neither is an E8 regression — and both were **fixture-selection bugs whose answer
depends on the month the suite is run in**, which is the one thing a characterization test may
never be. Both are fixed in the fixture, not in the assertion, and the repair is mutation-tested.

| row | root cause | fix |
|---|---|---|
| `dom-rendering.dom.js` 7.2 · *„a weekday in Ferien"* | The window opens on today. `ferienSample()` took the **first** Ferien weekday in it, which on any run inside a Sommerferien **is today** — and Today's tint deliberately outranks `.fer`. The row was silently re-characterising the Today rule (which has its own test, 8.1) under the wrong name. | `ferienSample()` now excludes `M.today`, on the rule `plainDate()` and `holidayDate()` two functions above already apply. `all` stays complete. |
| `belegt-render.dom.js` §7 · *„hiding a member … repacks the lanes"* | `COL` is the second visible column — **October** whenever the app opens in September — and the test places two notes on **day 3**, which is Tag der Deutschen Einheit. The holiday takes line 1 (DESIGN-DECISIONS §B), capacity drops to one, and a row that placed two notes placed one. | `NO_LAYERS` on both `withBoard` calls, the constant and the argument `family-render.dom.js` already uses. |

**Mutation proof that the 7.2 repair did not defang it:** with `.day.fer { background: transparent }`
the repaired row is **red**. The fix moved the sample; it did not weaken the assertion.

---

## 2. Ticket status

| ticket | story | status | where |
|---|---|---|---|
| **LZP-801** Foreign-entry rendering | 17.1, 17.2 | **VERIFIED-HERE** | Papa's shared entry on Mama's board in `#5D9E33` (= `colorOf('gruen')`) with chip „P", driven from a real register map through the real `materialize` — §5. `family-render.dom.js` §1–§2. The 1 px ownership rail (`.bar.foreign::after`) answers the case where a member tone and a category tone are the same ten tones in two namespaces. |
| **LZP-802** Two-section legend | 17.3, 4.3, A3 | **VERIFIED-HERE** | `▬ Arbeit ▬ Familie ▬ Reisen ▬ Deadlines · bearbeiten │ Ⓙ Ⓛ Ⓜ Ⓞ Ⓞ Ⓟ` — one divider, no second heading, **toolbar 40 px at 0, 2 and 8 members**, board top 68 px unchanged. §4. `family-legend.dom.js`. |
| **LZP-803** Density integration | 17.4, 2.4, 2.5, 3.8 | **VERIFIED-HERE** | §3, §4 here and `family-render.dom.js` §6. Geometry `deepEqual` solo↔family; hiding all seven reproduces the solo board **entry for entry** (192 notes / 40 bars / 2 badges, both sides). |
| **LZP-804** „neu" markers | 17.5 | **PARTIALLY OWED** | The **board half is built, measured (3 × 3 px, `PREFIX_COST_PX.neu` = 5 px) and Principle-9 clean**. Its **inputs do not exist**: `store.js:_project()` passes `materialize` no `seqOf`, no `lastSeenSeq` and no `levelDecreased`, and nothing advances `settings.lastSeenSeq`. **17.5 renders nothing in the shipped app today.** §8.2. |
| **LZP-805** Attribution | 17.6, 2.4, A7 | **VERIFIED-HERE (popover) · OWED (hover, names)** | The popover line is drawn and costs 0 px of board. **Two gaps confirmed live in §5:** a foreign Geteilt note's `title` is the bare text — 17.6's *hover* half is missing — and `memberNameOf` is never installed, so every name falls back to an initial. §8.2. |
| **LZP-806** Family find | 14.1, A6 | **WRITTEN-UNVERIFIED here** | Landed and covered by `family-attribution.dom.js` §2 (25 rows green). Not re-driven in this pass; nothing E8-integration-shaped depends on it. |
| **LZP-807** Family print parity | 12.3, A8 | **VERIFIED-HERE** | §6. A4 strip **15.5 px tall in all three states**, one page in all three, and **hiding a member takes him off the paper**: 7 member items → 0, divider gone, ink width back to v1's 202.6 px to the tenth. |
| **LZP-808** Komfort density | 17.7 `[Could]` | **NOT STARTED — correctly** | S10 stretch, scope-lever #1. The two ends of the range it would extend are measured here (§3) so whoever builds it starts from numbers rather than from a guess. |

---

## 3. What E8 costs — measured, against the v1 baseline

### 3.1 The row: **0 px**, on every axis

`family-density.dom.js` §4 builds the 8 × 2 y fixture twice — once with the foreign half removed —
and requires `deepEqual`:

```
                 rowHeight  rowBlock  boardHeight  columnWidth  bodyWidth  toolbar  boardTop
solo (mine only)     22       682         784          118         87        40        68
family (8 people)    22       682         784          118         87        40        68
```

Non-vacuity is asserted in the same row: the family board really is denser — **192 → 715 notes and
40 → 135 bar segments in the DOM, 1 975 → 4 104 nodes.**

### 3.2 The note line: 0 px of height, and a priced horizontal prefix

Every marker combination, measured in WebKit at rowHeight 22:

| entry | marks | prefix | text left | line box |
|---|---|---|---|---|
| **v1 · plain own note** | — | **0 px** | 62 px | **10 px** |
| v1 · own + ↻ (9.2) | `rep` | 7.8 px | 54.2 px | 10 px |
| E8 · own + visibility badge (16.6) | `exp` | 9 px | 53 px | 10 px |
| **E8 · own WORST** (badge + ↻) | `exp` `rep` | **16.8 px** | 45.2 px | 10 px |
| E8 · foreign (17.2) | `chip` | 10 px | 52 px | 10 px |
| **E8 · foreign WORST** (neu + chip + ↻) | `neu-dot` `chip` `rep` | **22.8 px** | 39.2 px | 10 px |
| E8 · foreign Belegt block (16.7) | `neu-dot` `chip` | 15 px | 31.7 px | 10 px |

Against `layout.js:PREFIX_COST_PX` — published `ownWorst` 17, `foreignWorst` 23 — both measured
worsts are **under** what the module claims, and `FAMILY_LAYOUT_COST_PX` is all zeros. **The one
that outranks the rest: the line box is 10 px in all seven.** A marker that grew it by one pixel
would grow it on all 372 rows of all 12 columns.

**The delta, stated plainly:** the worst foreign entry gives up **37 % of the note's text width**
(62 → 39.2 px). That is E8's whole price, and it is paid only by entries that are not mine.

### 3.3 The toolbar: **0 px of height, 166 px of width at eight members**

| | toolbar height | board top | family section width |
|---|---|---|---|
| solo (v1 baseline) | **40 px** | 68 px | — |
| 2 members | **40 px** | 68 px | 46.1 px |
| 8 members | **40 px** | 68 px | 166.1 px |

At eight members the section renders as chips plus a `· 7` disclosure rather than names; the names
appear on hover and in ⚙. Board height 784 px in all three.

### 3.4 The print sheet: **0 px of page height**

Measured at the true A4 content box (1062 × 733 px = 297 × 210 mm less 8 mm margins at 96 dpi),
with the `@media print` rules lifted onto the screen — the only way to measure 7 pt type in the
engine that will set it. **A height read without that lift is 0 px, and `0 === 0` is a green cell
that has measured nothing**; §6 asserts the lift happened before it asserts anything else.

| | strip height | strip ink | items | divider |
|---|---|---|---|---|
| A4 solo (v1) | **15.5 px** | 202.6 px | 4 categories | 0 |
| A4 + 8-member family | **15.5 px** | 336.5 px | 4 + 7 members | 1 |
| A4, every member hidden | **15.5 px** | **202.6 px** | 4 categories | 0 |
| A3 + family | 17.5 px | — | 4 + 7 members | 1 |

Whole sheet: **733 px of 733 px on A4 — one page**, measured here at the true content box.
(The A3 figure, 1 028 px of 1 046 px, is `family-attribution.dom.js`'s pass and is not re-taken here.) With
`memberNameOf` installed (the owed one-liner, §8.2) the ink grows to **467.4 px of 1 062** and still
does not wrap: **594 px of slack** at eight members with real names.

---

## 4. Deliverable 17 — the badge family, at 22 px and at 18 px

One day row is built carrying all five marks at once, plus the two things that compete for the same
microspace: the `+n` overflow badge and three bar lanes.

### 4.1 At the 22 px default — **all five, zero collisions**

```
22 px · 7 painted marks on the row, 0 collisions
    3×3    px  note.foreign.belegt>neu-dot      ← 17.5
    7×7    px  note>exp geteilt                 ← 16.6
    6.8×9  px  note>rep                         ← 9.2
    8×8    px  note.foreign.belegt>chip         ← 17.2
   15.1×10 px  .d-more   (+4)                   ← 2.4
   17×11   px  .d-num
   25.7×10 px  note.foreign.belegt>redacted-word ← 16.7
  marks per note [["neu-dot","chip","redacted-word"],["exp geteilt","rep"]]
  gaps 2, 1, 2 px · smallest painted mark 3×3 px · row height 22 px · capacity 2
```

Beside it, in the same column: **three lanes** — mine solid, Mama's geteilt with the ownership rail,
Papa's Belegt hatched — and their labels, `Projekt`, `Ⓜ Ferien Nordsee`, `Ⓟ Belegt`. Lena's fourth
bar is capped by 3.8 and counted into the `+n` on the days it covers, which is why the badge reads
`+4` for three hidden notes.

**Screenshot (a):** 5× loupe of the crowded 22 px row — geometry computed at 1× and only then
magnified, so these are the real 22 px pixels. Reading left to right, top to bottom: `Ⓟ` in Papa's
green preceded by the small green „neu" dot, the italic neutral word **Belegt** in its own pill, then
`+4`; on the second line a filled blue square (my Geteilt badge), `↻`, and „Omas G…" truncated at the
87 px body. Above and beside: `● Ⓜ Ferien N…` in magenta, `Ⓟ Belegt` in green, and three 6 px stripes
— hatched green, solid magenta, solid blue.

**Screenshot (b):** the same fixture as a whole board at 1512 × 900 — twelve months, 22 px rows,
the family stripes and chips distributed across all twelve columns, nothing scrolled and nothing
clipped.

### 4.2 At 18 px, v1's minimum — **the finding**

```
18 px · 1 of 5 notes, 5 marks, 0 collisions, overflow +5
  marks per note [["neu-dot","chip","redacted-word"]]
```

**Screenshot (c):** the same day at 18 px, 5× — a single line, `● Ⓟ Belegt  +5`, and the row above
and below untouched.

> **THE COST, STATED.** At v1's minimum row height the day row can carry at most the marks of **one**
> entry. The badge family still coexists **on the board** — the three bar lanes and their labels
> carry ownership at 18 px unchanged — but **not on the note line**. Nothing overprints; nothing is
> illegible; the entries that lose their place are counted into `+n` and reachable through the
> popover v1 already ships for exactly that. This is DESIGN-DECISIONS §B's capacity rule doing what
> it has always done, and it is the price of the 18 px setting rather than a price E8 added: the
> 18 px board is shorter than the 22 px board by **exactly** `(22 − 18) × 31 = 124 px`, asserted.

### 4.3 The audit is real

Mutating `.note .chip { margin: 0 1px }` to `margin: 0 -4px` turns §1 and §2 **red** and prints:

```
x deliverable-17/no-collision — neu-dot ∩ chip = 3×3px · chip ∩ redacted-word = 4×8px
```

A green cell in §1 is therefore a measurement, not a formality.

---

## 5. Driven against a real circle — Mama's board, Papa's entries

Driven through the **real `materialize`** from a **real register map** (`fnote:`/`fbar:` rows with
stamps and authors) into the **real board**, with Mama as `me` and Papa as a peer. The relay half is
not re-driven here — E6-VERIFICATION §3 proves it end to end across three browser contexts — so what
this section adds is the E8 seam: register map → materialize → layout → DOM.

**17.1 / 17.2 — Papa's shared entry on Mama's board, in his colour, with his initial:**

```html
<div class="note foreign readonly" data-note-id="fnote:mem_…2/p1" data-date="2026-10-08"
     data-foreign="1" title="Zahnarzt" style="color: rgb(93, 158, 51);">
  <span class="chip" aria-hidden="true" style="background: rgb(93, 158, 51);">P</span>Zahnarzt</div>
```

`rgb(93,158,51)` is `#5D9E33` is `colorOf('gruen')` is Papa's `colorRef`. Mama's own „Yoga" beside it
renders in **her category colour**, untouched — 17.2's two halves in one row.

**16.7 — a Belegt block that shows duration and owner and no text:**

```html
<div class="bar foreign belegt readonly" data-bar-id="fbar:mem_…2/p2" data-lane="0"
     title="P · Belegt · 2026-10-12 – 2026-10-18"
     style="top: calc(var(--row-h) * 11 + 1px); height: calc(var(--row-h) * 7 - 3px); …"></div>
```

Seven days, owner „P", the word „Belegt" on the label — and an armed check over the bar's and the
label's markup for either user text in the fixture returns **false**.

**17.3 — the toggle, on board *and* on paper:**

| | foreign notes | foreign bars | my notes | `mem_papa` anywhere in board HTML | print member key |
|---|---|---|---|---|---|
| Papa visible | 1 | 1 | 1 | **true** | `▬ Arbeit … │ Ⓟ Papa` |
| **Papa hidden** | **0** | **0** | **1** | **false** | `▬ Arbeit ▬ Familie ▬ Reisen ▬ Deadlines` |
| restored | 1 | 1 | 1 | true | `… │ Ⓟ Papa` |

**Screenshot (d):** the A4 print layout of the 8-member board — twelve months on one page, the
header „LangzeitPlaner · September 2026 – August 2027 · Feiertage: bundesweit", and at the foot the
two-section strip `▬ Arbeit ▬ Familie ▬ Reisen ▬ Deadlines │ Ⓙ Jonas Ⓛ Lena Ⓜ Mama Ⓐ Oma Ⓞ Opa
Ⓟ Papa Ⓣ Tante Ute`.

**Two gaps this drive found that a green suite had not:** Papa's shared note's `title` is
`"Zahnarzt"` — 17.6's *hover* half is missing from `board.js` — and the Belegt bar's tooltip says
`"P · Belegt · …"`, an **initial**, with `useMemberNames` installed. Both are §8.2, items 3 and 4.

---

## 6. Perf — LZP-1007, on the fixture the AC names

**Fixture:** 8 members × 2 years, deterministic LCG (no `Math.random`) → **3 059 notes, 416 bars**.
The off-screen half is in the arrays because `selectBars` filters by visibility, not by date, so the
lane sweep really sees all 24 months.

### 6.1 Build and draw — Chromium 1512 × 900, warm, median of 15 after 5 warm-ups

| | buildBoard | renderBoard | DOM nodes |
|---|---|---|---|
| solo (mine only: 380 notes, 52 bars) | **1.0 ms** (0.9–1.7) | **13.7 ms** (9.8–18.0) | 1 984 |
| family (3 059 notes, 416 bars) | **2.7 ms** (2.5–6.5) | **41.6 ms** (37.5–52.3) | 4 087 |

A full redraw of the eight-member board is **41.6 ms**. That is a redraw, not a frame: v1 redraws on
mutation, roll and settings change, never during a gesture.

### 6.2 The member toggle (17.3) costs exactly one redraw — no more

| | median | min–max |
|---|---|---|
| hide Papa (1 of 8 gone) | **39.4 ms** | 35.7–46.4 |
| show Papa | **42.2 ms** | 38.4–48.1 |
| all seven hidden (= the solo board) | **13.4 ms** | 11.8–15.1 |
| plain redraw, no settings change | 44.2 ms | — |

Hiding a member is **not more expensive than drawing the board it produces**: with all seven off, the
redraw costs the solo board's 13.4 ms and the DOM is the solo DOM (192 notes). This is the **render
half**. The write half (`setSettings` → `_adopt` → `_project`) is not measured at fixture scale
because the fixture is injected at the layout seam, and that is stated rather than estimated.

### 6.3 Drag — **the 60 fps AC**

**60 fps is 16.7 ms per frame.** What is measured is one frame of **main-thread** work: dispatch the
`pointermove` the app really listens for, then force a style + layout flush, and time the pair.
200 frames per gesture, per engine, after a 40-frame warm-up.

**Chromium (1 µs timer), 8 members × 2 years:**

| gesture | median | p95 | worst | frames over 16.7 ms |
|---|---|---|---|---|
| move-note | 1.2 ms | 1.3 ms | 8.7 ms | **0 / 200** |
| move-bar (6 preview segments) | 1.2 ms | 1.4 ms | 8.5 ms | **0 / 200** |
| create-bar | ~0 ms | 0.1 ms | 8.1 ms | **0 / 200** |

Solo, same fixture, same gestures: median 0.6 ms, worst 2.9–4.1 ms. **E8 roughly doubles the median
frame cost (0.6 → 1.2 ms) and leaves 15.5 ms of the 16.7 ms budget unspent.**

**WebKit — the engine that ships — in `family-density.dom.js` §5:**

```
move-note   solo   median 0 ms · p95 1 ms · worst 6 ms · over budget 0/200
            family median 0 ms · p95 1 ms · worst 5 ms · over budget 0/200
move-bar    family median 0 ms · p95 1 ms · worst 6 ms · over budget 0/200
create-bar  family median 0 ms · p95 1 ms · worst 6 ms · over budget 0/200
```

WebKit clamps `performance.now()` to ~1 ms, so its median and p95 are floors; **the worst-frame
column is the one that carries the claim, and it is ≤ 6 ms of 16.7 in every gesture.** Each row also
asserts `body.className` contained `is-dragging`/`is-creating` during the drag, so the numbers are
the cost of a gesture the state machine actually engaged and not of an event nobody handled.

> **WHAT IS NOT CLAIMED.** No wall-clock frame rate was sampled. Neither available engine renders to
> a visible window in this environment — the Browser pane is hidden and the tier-2 shell is headless
> by construction (`main.swift`: *"A headless run never shows a window"*) — and in both, `rAF` is
> suspended, so any fps printed here would be a fact about the harness. The AC is met on the budget:
> a gesture whose worst main-thread frame is 8.7 ms cannot miss 60 fps for any reason on this side
> of the compositor. **The remaining risk is raster/composite, which is unmeasured.**

### 6.4 Memory

`performance.memory` in this Chromium is bucketed and updates lazily, so a per-state delta is below
its resolution and **no per-state figure is claimed**. What is honest:

- Whole-page JS heap sits in the **5–10 MB band against a 4 096 MB limit**, empty board, solo
  fixture and 8-member fixture alike. The family layer is not a memory question at this scale.
- The structural numbers, which are exact: retained **DOM nodes 1 975 → 4 104** (+108 %), and entry
  objects **432 → 3 475** (+704 %). The DOM grows by half what the data does, because the capacity
  rule and the lane cap are doing their job.

---

## 7. Principle 9 — a downgrade produces no signal, anywhere

Green, and driven through the real `materialize` from a real register map into the real board
(`family-legend.dom.js` §3, 13/13). The claim asserted is not „no dot":

- **The control fires first.** Added ink with `seqOf` 412 against `lastSeenSeq` 400 **does** draw one
  `.neu-dot`. Without that row every assertion below would pass on a renderer that had simply
  forgotten how to draw a dot.
- **No dot.** The hostile case — seq 9999 against last-seen 1, the loudest possible evidence that
  something changed — draws zero dots when `levelDecreased` is true.
- **No gap.** `noteBox` and `dayBox` are equal to the untouched entry's. A suppressed marker that
  still reserved its 5 px would be a downgrade detector made of whitespace.
- **No signal.** The day's `innerHTML`, the note's `title`, and every `aria-*` attribute are equal.
- **Not in the chrome either.** The whole legend's `innerHTML` is equal, and `.legend .neu-dot` is
  empty. An aggregate „Mama has been active" in the toolbar is a presence indicator — first item on
  Principle 9's forbidden list — and `membersui.js` refuses to draw one, with the argument in the
  file.
- **A deletion materializes to nothing at all**, so there is nothing left to dot.

**The standing hazard is recorded, not closed.** `materialize.js:359–371` — `ctx.seqOf` and
`ctx.levelDecreased` are **independent optional hooks**, and `isNewOf` **fails open**: a caller that
supplies the seq source and forgets the suppression gets a dot on every downgrade, silently. A
tripwire over `store.js`'s source requires the two hook names to appear together or not at all. It is
green today because `_project()` supplies **neither** — which is also why 17.5 renders nothing yet
(§8.2 item 2).

---

## 8. What is owed

### 8.1 Not E8's, and blocking `test:fleet`

`tests/fleet/e6-attack-removed.test.js` §1 and §1e fail with

```
{"error":"admin_proof_required","field":"adminProof","reason":"founder_removal_needs_second_key",…}
403 !== 200
```

The parallel workflow has landed a **founder-removal guard** in the uncommitted `server/core/auth.js`
+ `server/core/errors.js` and has not yet inverted its own red team against it — the same pattern as
E6's `§5d`. **`test:fleet` is 244/244 at pristine HEAD**, the failing file is theirs, and E8 touches
nothing the fleet suite loads. Owner: the `server/*` workflow. *(Also seen: `test:server` reporting
888/4 during a run that overlapped one of their writes, and 892/0 on four consecutive clean runs.
Do not read a suite result taken while another workflow is writing the tree.)*

### 8.1a The isolation check, and the one row that is co-dependent by design

Because this tree is shared with a live workflow, E8's files were also run **alone on top of HEAD**,
in a `git worktree` (never a stash — §8.3):

```
tier 1     2008 / 0        test:attack   860 / 0        test:server  868 / 0   (HEAD's server)
property    101 / 0        test:fleet    243 / 1        ← ONE row, and it is E8's own
```

The single red row is `tests/fleet/e6-attack-keydelivery.test.js` **§5d**, and it is not a defect —
it is a red-team row **about this change's shape**:

```
MemberRow has no device field, so §8.5's mitigation is not rendered anywhere
expected: false   actual: true
```

At HEAD it is an *attack-SUCCEEDED* row asserting that ADR 002 §8.5's only stated mitigation is
absent from the UI. `membersui.js` adding `deviceCount` to `MemberRow` **makes it present**, so the
row must invert with the fix — the project's own rule for every `tests/attack/`-style row that is
green because a defect exists (FINDINGS §7c). **The inversion already exists in the shared working
tree**, written by the `server/*` workflow inside the same file
(`§5d · CLOSED · §8.5's stated mitigation is BUILT, and is now FED`), which is why the full tree
shows this row green and only the founder-removal rows red.

**Consequence, stated so nobody is surprised:** E8's commit and the `server/*` workflow's commit are
**co-dependent on that one file**, which E8 does not own and therefore does not stage. The branch tip
is green once both have landed; either commit alone leaves §5d red in one direction or the other.
Whoever lands second should confirm `test:fleet` before pushing.

### 8.2 E8's own, in the order that unblocks the most

1. **`src/js/family/mount.js` — two one-liners, and both are the difference between a fallback and
   the story.**
   - Next to `useSharing`:
     `useMemberNames(circle ? (id) => membersUIState().members.find((m) => m.memberId === id)?.displayName ?? null : null)`
     (import from `../popover.js`). Proven live in §3.4: with it installed the print key reads
     `Ⓟ Papa`; without it, `Ⓟ P`. Attribution says „von M", find matches on the initial.
   - `refreshRoster` (≈ line 296) maps the relay's members to `{memberId, colorRef, removedAt}` and
     drops `devices`, so `deviceCount` is `null` everywhere. **`tests/fleet/e6-attack-keydelivery.test.js`
     §5d asserts `devices` is ABSENT and must be inverted in the same change.**

2. **`src/js/store.js:3521–3527` — LZP-804 has no inputs.** `_project()` passes `materialize` no
   `seqOf`, no `lastSeenSeq`, no `levelDecreased`, and nothing anywhere advances
   `settings.lastSeenSeq.<spaceId>`. `isNewOf` therefore always answers `false`: **17.5 renders
   nothing in the shipped app today.** The board half is built and measured (§3.2, §4.1). **Wire all
   three together or none** — see the tripwire in §7.

3. **`src/js/board.js` — 17.6's hover half.** `renderNote` sets
   `node.title = [text, exposureTitle].join('\n')`, so a foreign Geteilt entry's tooltip is the bare
   text (§5). The story says *hover/popover*. `memberNameOf` is exported from `popover.js` and
   importable without touching the family gate.

4. **`hiddenMembers` × `lastSeenSeq` — a design question for whoever builds the advance.** Hiding
   Papa filters his entries at `layout.js` before they can dot. A single per-space `lastSeenSeq`
   scalar marks his new ink „seen" without it ever having been shown, so un-hiding him silently
   produces old ink. Either the advance excludes hidden members, or 17.3 is documented as discarding
   their „neu" state.

5. **`src/js/i18n.js`** — add `member` (de „Mitglied" / en „Member"); `print.js` falls back locally in
   `board.js`'s `FAMILY_COPY` idiom until then.

6. **`src/css/print.css`** — `.print-legend .item.member .sw` and `.print-legend .sep` are inline-styled
   from `print.js` because the file is not E8's; move them if you want them owned. Also: print.css
   sets `--lane-w: 5px` for A4, so the 1 px ownership rail leaves a 3 px colour core there — the same
   trade the Belegt hatch already makes at that width, at the floor of §10's „distinguishable at
   3–6 px". Nothing in print.css suppresses the rule (`.bar.hit { box-shadow: none }` targets `.bar`,
   not `::after`).

7. **`src/js/family/adminpanel.js`** — ADR 002 §2.3 wants `deviceCount` (now on `MemberRow`),
   `deviceIdCollisions`, `shortCollisions` and `unprovenShorts` on the member list;
   `family/engine.js:543` already computes the last three and no panel shows them.

8. **Unmeasured, and named so nobody assumes it was measured:** raster and composite cost during a
   drag (§6.3), and the projection half of a member toggle (§6.2).

### 8.3 Process

`git stash` was run twice in this shared tree by earlier passes and swept up other workflows'
in-flight files both times. **Nobody should stash in this tree.** This pass used
`git archive HEAD | tar -x` into a scratch directory for every clean-tree comparison, which touches
nothing.

---

## 9. Files this pass owns

```
src/js/layout.js                       lanes, ownership rail, label-scan fallbacks, cost constants
src/css/app.css                        the badge vocabulary + `.bar.foreign::after`
src/js/family/membersui.js             the legend half, device count, the refusal in LZP-804
src/js/popover.js                      attribution line, useMemberNames / memberNameOf
src/js/find.js                         the family haystack + the `text: null` crash
src/js/print.js                        A3's second section on paper
tests/tier2/family-render.dom.js       18  (new, build:foreign-entries)
tests/tier2/family-legend.dom.js       13  (new, build:legend-neu)
tests/tier2/family-attribution.dom.js  25  (new, build:attribution-find-print)
tests/tier2/family-density.dom.js       9  (new, THIS PASS — the density gate)
tests/tier2/family-members.dom.js      +1  `deviceCount` on the MemberRow shape assertion
tests/tier2/belegt-render.dom.js       §7  NO_LAYERS — the calendar-drift repair
tests/tier2/dom-rendering.dom.js       7.2 ferienSample excludes today — the calendar-drift repair
docs/v2/E8-VERIFICATION.md             this file
```

**Not touched, by rule:** `server/*`, `src/js/sync/*`, `src/js/family/engine.js`, `src/js/board.js`,
`src/js/legend.js`, `src/css/print.css`, `src/js/i18n.js`, `tests/fleet/*`, `tests/server/*`.
