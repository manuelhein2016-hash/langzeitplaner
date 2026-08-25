# v1 story coverage — what the characterization suite actually tests

Companion to `tests/README.md`. That file explains *how* the suite works; this
one is the honest ledger of *what it covers*, story by story, for all 79
numbered stories (1.1 – 14.2) in `LangzeitPlaner_Design_Spec_v1.md`.

**This table is the gate for LZP-402.** The v2 sprint plan gates the op-log
retrofit on "the entire v1 feature set stays green" and names v1-regressions as
risk R5. A story marked *covered* here means a test will go red if the retrofit
changes that behaviour. A story marked *not automatable* means **nobody is
watching it** — those need a human pass before LZP-402 ships.

## Status at a glance

| | Stories | |
|---|---:|---|
| **Automated** | **63 / 79** | a test fails if v1's behaviour changes |
| Partial | 7 | the logic is covered; a native or visual edge is not |
| Not automatable | 8 | needs a real clock, a real dialog, or a human eye |
| Not implemented in v1 | 1 | 10.3 is a `[Could]` that never shipped |

Suite size: **444 tier-1 tests** (`node --test`, ~5 s) and **111 tier-2 tests**
(real WKWebView, ~12 s incl. build). 555 total, 0 failing, 0 skipped.

## How to read the columns

- **T1** — `tests/tier1/*.test.js`, pure logic under `node --test`.
- **T2** — `tests/tier2/*.dom.js`, the real board in a real WebKit engine.
- A story with both is covered at model *and* render level.

---

## F1 — Rolling 12-month board

| Story | T1 | T2 | Notes |
|---|:-:|:-:|---|
| 1.1 twelve columns, current month first | ✅ | ✅ | `buildBoard` window + 12 `.col` in the DOM |
| 1.2 slim day rows, weekday, weekends shaded | ✅ | ✅ | `.we` exactly on Sat/Sun, 104 weekend days in 2026 |
| 1.3 rolling ↔ pinned start month | ✅ | ✅ | rolling ignores `startMonth`; pinned ignores the wall clock |
| 1.4 horizontal scroll, headers pinned | — | ✅ | CSS-only; no model input. `position:sticky`, `overflow-x`, `max-content` |
| 1.5 page year back / forward in pinned mode | ✅ | ✅ | `pageYears ±N`; paged-back window renders past entries |
| 1.6 rows align by day number | ✅ | ✅ | slot *i* is always day *i+1*; void rows only at the bottom |

## F2 — Quick day notes

| Story | T1 | T2 | Notes |
|---|:-:|:-:|---|
| 2.1 click, type, Enter saves / Escape cancels | — | ✅ | real click + keystrokes; Escape leaves nothing behind |
| 2.2 edit in place, clear to delete | — | ✅ | dblclick edits the *same object*; clearing deletes; both undoable |
| 2.3 several notes per day | ✅ | ✅ | store order preserved; truncation, not wrapping |
| 2.4 crowded day shows `+n` | ✅ | ✅ | shows `capacity` notes, not literally two — see *Discrepancies* |
| 2.5 ~80-char cap, ellipsis, full text on hover | ✅ | ✅ | `maxLength = 80` asserted live; model carries the string verbatim |

## F3 — Multi-day bars

| Story | T1 | T2 | Notes |
|---|:-:|:-:|---|
| 3.1 press-and-drag lays a bar | ✅ | ✅ | incl. the degenerate single-day click-drag |
| 3.2 month split stays ONE entry | ✅ | ✅ | segment `.bar` object identity asserted across columns |
| 3.3 short label on the bar | ✅ | ✅ | label editor opens synchronously on create |
| 3.4 overlaps render in parallel lanes | ✅ | — | global first-fit; inclusive overlap; input-order independence |
| 3.5 dragging upward normalises | ✅ | ✅ | real upward drag produces a valid range |
| 3.6 "continues →" cue, both directions | ✅ | ✅ | strict edges; `.bar-cont-up` / `.bar-cont-down` / column footer |
| 3.7 label once per month segment | ✅ | ✅ | label row skips notes, holiday text and an existing `+n` |
| 3.8 lanes cap at 3, then `+n` | ✅ | ✅ | incl. the per-day lane rescue (DESIGN-DECISIONS challenge 3) |

## F4 — Color categories

| Story | T1 | T2 | Notes |
|---|:-:|:-:|---|
| 4.1 legend: rename, recolor, add, remove | ✅ | ✅ | add takes the next free tone; the final category cannot be deleted |
| 4.2 every entry has a category, defaults to last used | ✅ | ✅ | `lastCategoryId` never dangles |
| 4.3 toggle category visibility | ✅ | ✅ | hidden ≠ absent in the store; absent from the DOM |
| 4.4 deleting a category prompts to reassign | ✅ | ⚠️ | counts + reassign-then-delete mutation covered; the sheet's dropdown flow is not driven |
| 4.5 fixed ~10-tone palette | ✅ | — | `tests/tier1/palette.test.js`: the whole table pinned |
| 4.6 creating into a hidden category auto-unhides | ✅ | ✅ | incl. the undo asymmetry (the unhide rolls back, the setting does not) |

## F5 — Move, resize, undo

| Story | T1 | T2 | Notes |
|---|:-:|:-:|---|
| 5.1 drag a note to another day | — | ✅ | incl. the 9.3 rule: a repeat re-anchors month/day, keeps its year |
| 5.2 drag a bar whole | — | ✅ | length preserved, both ends move, label survives |
| 5.3 grab an edge to stretch/shrink | — | ✅ | **both** grips — the start grip has its own test |
| 5.4 ⌘Z / ⇧⌘Z, ~50 steps | ✅ | ✅ | 60 edits → exactly 50 undos; import excluded |
| 5.5 click selects; 4 px drag threshold | — | ✅ | a 2 px press selects and does **not** move the note |
| 5.6 auto-scroll when dragging near the edge | ❌ | ❌ | **not automatable** — needs a viewport narrower than the board; the headless window renders all 12 columns, so the edge condition never arises |

## F6 — Public holiday layer

| Story | T1 | T2 | Notes |
|---|:-:|:-:|---|
| 6.1 holidays inline, distinct style | ✅ | ✅ | short form, full name on hover, bold day number |
| 6.2 Bundesland picker drives regional days | ✅ | — | all 7 regional holidays × all 16 states |
| 6.3 baked in, works offline | ✅ | ✅ | pure computation (T1) + CSP blocks a real `fetch` (T2) |
| 6.4 layer toggles off | ✅ | ✅ | empties the layer without moving a single row |
| 6.5 computed from rules, never runs out | ✅ | ✅ | Easter cross-checked against an independent Gauss algorithm, 1900–2200; Buß- und Bettag 1900–2400 |
| 6.6 other Bundesländer dimmed | ✅ | ✅ | the union is always returned; only `own` varies |

## F7 — School holidays layer

| Story | T1 | T2 | Notes |
|---|:-:|:-:|---|
| 7.1 subtle background shading | ✅ | ✅ | inclusive at both ends; a holiday inside Ferien keeps both signals |
| 7.2 hover names the period | ✅ | ✅ | day-by-day lookup across whole periods |
| 7.3 toggles independently of Feiertage | ✅ | ✅ | all four on/off combinations |
| 7.4 visible data horizon | ✅ | — | `FERIEN_META` pinned field-by-field; see *Discrepancies* (FINDING 2) |
| 7.5 no Bundesland → layer stays off | ✅ | ✅ | shades nothing even when switched on |

> **Time-bomb note.** Three tier-2 Ferien tests derive their fixtures from the
> live window. Once the rolling board walks past `FERIEN_META.horizon`
> (2028-08-31) they call `skip(reason)` and report a TAP **`# SKIP`** — visible
> in the output and counted separately, never a silent `ok`.

## F8 — Today marker and auto-roll

| Story | T1 | T2 | Notes |
|---|:-:|:-:|---|
| 8.1 today unmistakably highlighted | ✅ | ✅ | incl. Today beating weekend + Ferien shading (the `.day.day.today` fix) |
| 8.2 board advances by itself at month change | ⚠️ | ❌ | the *model* is covered — `buildBoard` with an injected `today` yields the rolled window. The **live** self-advance is not automatable: it needs the wall clock to cross a month boundary |
| 8.3 "Today" button jumps back | — | ✅ | resets `pageYears` in pinned mode; a no-op for state in rolling mode |
| 8.4 rolled-out entries kept in storage | ✅ | — | paging back renders them again; nothing is deleted |
| 8.5 date change while running (midnight, wake) | ❌ | ❌ | **not automatable** — needs a real clock change or a real sleep/wake cycle |
| 8.6 roll animation, respects Reduce Motion | ❌ | ❌ | **not automatable** — a ~300 ms visual transition and a macOS accessibility setting; needs a human eye |

## F9 — Yearly repeats

| Story | T1 | T2 | Notes |
|---|:-:|:-:|---|
| 9.1 repeats yearly, survives the roll | ✅ | ✅ | decades-old anchors; multiple coexisting series |
| 9.2 ↻ marker | ✅ | ✅ | rendered **before** the text so truncation cannot eat it |
| 9.3 edit/delete applies to the whole series | ✅ | ✅ | every occurrence is the same stored object (`===`) |
| 9.4 Feb-29 shows on Feb-28 in non-leap years | ✅ | — | century rule included; the anchor is never rewritten |
| 9.5 series exists from its first year onward | ✅ | — | paging back before the anchor shows nothing |
| 9.6 repeats are notes-only | ✅ | — | a bar carrying the flag is never projected |

## F10 — Month scratchpad

| Story | T1 | T2 | Notes |
|---|:-:|:-:|---|
| 10.1 free-text area per month column | — | ✅ | one textarea per column, keyed by month |
| 10.2 persists and autosaves | ✅ | ✅ | reaches the store and survives a redraw |
| 10.3 drag a pad line onto a day | n/a | n/a | **not implemented in v1** — a `[Could]` story; no drag source exists in `src/`. Nothing to characterize |
| 10.4 pads belong to a specific month | ✅ | ✅ | keyed `YYYY-MM`, so Aug '26 and Aug '27 are different pads |
| 10.5 ~5 lines then scrolls; print skips empty pads | — | ⚠️ | the print half is covered (empty pads `visibility:hidden`); the 5-line scroll cap is a CSS `max-height` and is not asserted |

## F11 — Autosave and backup

| Story | T1 | T2 | Notes |
|---|:-:|:-:|---|
| 11.1 saved within ~a second, no save button | ✅ | — | the real 700 ms debounce, no fake timers; rapid edits coalesce |
| 11.2 one-click export of the entire state | ✅ | ⚠️ | the JSON document is covered lossless-round-trip; the native `NSSavePanel` is **not automatable** (a modal panel hangs a headless run) |
| 11.3 import restores after confirmation | ✅ | ⚠️ | `replaceAll` covered incl. clearing undo/redo; the native `NSOpenPanel` and the confirm sheet are not driven |
| 11.4 one human-readable JSON, written atomically | ✅ | ⚠️ | the single pretty-printed document and its location are covered. The **atomicity itself** (temp file + `replaceItemAt`, `main.swift:85`) is not — proving it needs an interrupted write |
| 11.5 last 7 daily snapshots, one-click restore | ✅ | — | cap of 7, oldest dropped, restore deep-clones and migrates |
| 11.6 schema version + migration | ✅ | — | v0→v1, dangling refs repaired, unknown keys, idempotence |
| 11.7 dated default export filename | ✅ | — | `LangzeitPlaner-${todayISO()}.json` |

## F12 — Print / PDF export

| Story | T1 | T2 | Notes |
|---|:-:|:-:|---|
| 12.1 clean A4/A3 landscape print view | — | ✅ | `@page` follows the paper setting; A4 metrics fit the 1062 × 733 content box |
| 12.2 hides UI, keeps entry colours | — | ✅ | incl. the documented exception: the `+n` badge stays, because the count is content |
| 12.3 respects layer and category toggles | — | ✅ | Today suppressed; find dimming dropped; hidden categories absent from board and key |
| 12.4 goes through the macOS print dialog | ❌ | ❌ | **not automatable** — `NSPrintOperation` is a modal native dialog and would hang a headless run |

> **Method note.** WKWebView cannot be put into `@media print` headlessly. The
> print tests lift the shipped rules out of their `@media print` blocks
> *verbatim* (via CSSOM) and inject them at the position `print.css` already
> occupies in the cascade. No declaration is retyped.

## F13 — App shell

| Story | T1 | T2 | Notes |
|---|:-:|:-:|---|
| 13.1 remembers size, position, scroll | ❌ | ❌ | **not automatable** — native window frame restoration; the headless window is never shown or moved |
| 13.2 menu-bar icon | ❌ | ❌ | **not automatable** — a real `NSStatusItem` in the system menu bar |
| 13.3 launch-at-login toggle | ❌ | ❌ | **not automatable** — `SMAppService` mutates real system state; deliberately never exercised |
| 13.4 zero network requests | — | ✅ | CSP asserted **and** a real off-origin `fetch` is blocked, not merely discouraged |
| 13.5 ⌘W hides, ⌘Q quits | ❌ | ❌ | **not automatable** — native window/app lifecycle |
| 13.6 every core action has a shortcut | — | ⚠️ | the menu event channel is covered (`layer-feiertage`, `mode-toggle`, unknown ids). The full keymap in spec §9 is not enumerated |
| 13.7 German default, English toggle | ✅ | ✅ | ~70 keys, weekday/month tables, holiday names, Bundesland names |

## F14 — Find

| Story | T1 | T2 | Notes |
|---|:-:|:-:|---|
| 14.1 ⌘F, matches light up, Enter steps, Esc restores | — | ✅ | dimming, `.hit`/`.current`, the n/m counter, Enter + ⇧Enter **with wraparound**, Esc |
| 14.2 search covers rolled-out history | ✅ | — | store-wide, independent of the visible window, ordered by date |

---

## The 8 stories nobody is watching

Before LZP-402 ships, these need a human pass — no test will catch a regression:

| Story | Why it cannot be automated here |
|---|---|
| 5.6 auto-scroll on edge drag | needs a viewport narrower than the board; headless shows all 12 columns |
| 8.5 live date change | needs the real clock to cross midnight, or a real sleep/wake |
| 8.6 roll animation + Reduce Motion | a 300 ms visual transition and a macOS accessibility setting |
| 12.4 macOS print dialog | `NSPrintOperation` is modal; it would hang a headless run |
| 13.1 window size/position/scroll restore | native window frame; the test window is never shown |
| 13.2 menu-bar icon | real `NSStatusItem` |
| 13.3 launch at login | `SMAppService` writes real system state |
| 13.5 ⌘W / ⌘Q | native app lifecycle |

Note the shape of that list: **every one is native-shell or visual.** None of
them is store behaviour, so none of them is in LZP-402's blast radius. The
store, the layout model and the render path — the things an op-log retrofit
actually touches — are covered end to end.

---

## Discrepancies this characterization surfaced

Reported, **not fixed** — the suite pins what v1 does today. None of these
contradicts a numbered story, so none is a spec violation.

1. **Dropped holiday on a 23 March Easter** (`src/js/holidays.js:119-131`). When
   Easter falls on 23 March, Christi Himmelfahrt (Easter+39) lands on 1 May,
   where Tag der Arbeit already sits. The collision guard keeps the incumbent
   and **drops** the newcomer, so that year's map holds 18 entries instead of 19
   and Christi Himmelfahrt vanishes from the board. Affected years in range:
   1913, **2008**, 2160, 2228, 2380. No story legislates two holidays on one
   date. *Pinned so the retrofit neither "fixes" nor worsens it by accident.*

2. **Ferien data outruns its own declared horizon** (`ferien.js:19` vs `:48`,
   `:63`). `FERIEN_META.horizon` says `2028-08-31`, which the settings sheet
   renders as a promise, but the bundled data runs 9 days (BW) and 8 days (BY)
   past it — 17 shaded days the UI says are uncovered. The label undersells, so
   no user is misled; the two numbers simply disagree.

3. **`rowCapacity(32)` is 2, not 3** (`layout.js:18` + `settings.js:142`).
   `DESIGN-DECISIONS.md §B` prints the correct formula but a wrong derived
   table: `floor((32-1)/10.5) = 2`, and the row-height slider stops at 32, so
   **the 3-line row is unreachable in shipped v1**. The table also misses 21 px
   (also 1 line). Documentation defect, not a code defect.

4. **Category renaming is one-way, not symmetric** (`legend.js:116`).
   DESIGN-DECISIONS says renaming per language leaves the other label alone.
   Renaming in *English* behaves that way; renaming in **German deletes
   `nameEn`**, so both languages then read the German name. Wording defect.

5. **`paletteRef` repair degenerates to "first tone"** (`store.js:88`). The
   repair passes an empty used-list to `nextFreeRef`, so three palette-less
   categories all become `blau`. Contradicts `palette.js:32`'s own doc comment,
   but story 4.5 only requires a fixed palette, not distinctness.

6. **Opening a future file in v1 is a silent downgrade** (`store.js:64-70`).
   A newer `schemaVersion` warns, then gets stamped **back down to 1**, and
   `migrate()` rebuilds state from a fixed six-key list — so unknown *top-level*
   keys are dropped while unknown *settings* keys survive. Directly relevant to
   LZP-402: a v2 file opened in v1 loses its v2 root fields on the next autosave.

7. **A declining callback that already edited state is not rolled back**
   (`store.js` `mutate`). Returning `false` skips the undo push but keeps the
   edit. No current caller does this — but it is a live landmine for an op-log
   retrofit, where "declined" and "applied" must not diverge.

8. **`setSettings` is a shallow merge**, so `setSettings({layers:{…}})` replaces
   the whole `layers` object. This is why `setLayer()` exists and why every
   caller in `src/` uses it for layer flags.

9. **`buildBoard` reads `state.settings.language`, never `i18n.getLang()`.** The
   two language stores are kept in sync only by `main.js:35` and
   `settings.js:179`. A retrofit that flips only the i18n module would leave the
   board silently in the old language.

10. **`--head-h` is dead on paper** (`print.css:98`/`:119` vs `:52`). The
    `.col-head { height: 16px }` literal inside `@media print` beats the
    variable, so the A3 token never has any effect. Measured 16 px in both
    paper modes.

---

## Two properties the suite enforces about itself

Because a green suite that proves nothing is worse than no suite — it converts
an ungated retrofit into one that only *looks* gated.

- **No vacuous tests.** Tier 2's harness counts `assert` calls per test and
  reports a test that asserted nothing as `not ok — VACUOUS`; standing down
  requires an explicit `skip(reason)` that prints a TAP `# SKIP`. Tier 1 has no
  such runtime hook, so `tests/tier1/suite-integrity.test.js` enforces the same
  rule statically, and also fails on a disabled test, a stranded test file that
  no glob picks up, a tier-1 file that reaches outside the repo, or any new npm
  dependency. Both guards were verified by deliberately introducing each fault.
- **No contact with real user data.** Tier 1 gets a `Map`-backed `localStorage`
  and never imports `node:fs`. Tier 2 redirects `appSupportDir()` to a scratch
  dir, **aborts with exit 70** if that path resolves inside the real board
  directory (verified), and shasums
  `~/Library/Application Support/LangzeitPlaner` before and after every run.
  A full two-tier run was confirmed byte-for-byte non-mutating against a real
  board containing real user data.
