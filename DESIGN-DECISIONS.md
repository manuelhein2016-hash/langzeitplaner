# LangzeitPlaner — what was built, and which wireframe won

The wireframe document `LangzeitPlaner Wireframes.dc.html` is an exploration: fifteen
options (1a–1o) across the five hard problems in spec §11. Implementing it means
choosing. This file records each choice and the reason, so the decisions can be
argued with rather than reverse-engineered from CSS.

Story numbers refer to the spec (`LangzeitPlaner_Design_Spec_v1.md`).

---

## A · Board shell — where the chrome lives (open question 3)

**Chosen: 1a — toolbar.**

The 40 px strip costs one and a half day rows out of 900. In exchange, layer
state and category visibility are readable without clicking anything, which
matters because both are *modes*: a hidden category silently changes what the
board means, and the user must be able to see that at a glance.

- **1b (left rail)** is the most informative but costs 168 px of width. Columns
  drop 118 → 104 px, i.e. roughly twelve characters of note text on *every one of
  372 rows*. Density is the feature (principle 1); paying for it in a rail that
  is mostly whitespace is the wrong trade.
- **1c (bare board)** is the most beautiful and the most dishonest. With the
  layer toggles in the titlebar and no legend, "why is my Reisen bar gone?"
  becomes unanswerable from the board itself.

The toolbar keeps 1c's idea of a legend strip — but as the *print* footer, where
there is no interactive alternative (see F12 below).

## B · Row economics — what fits in one day row (challenges 1 + 2)

**Chosen: 1d at 22 px, with the capacity rule generalised.**

Row height is a setting (18–32 px, default 22). The number of text lines a row
can host is derived, not hard-coded:

```
capacity = clamp(floor((rowHeight - 1) / 10.5), 1, 3)
```

18–20 px → 1 line · 22–31 px → 2 lines · 32 px → 3.

**Challenge 2 — who yields, holiday text or user content?** The user always wins,
but the holiday never disappears:

| situation | result |
|---|---|
| capacity ≥ 2 | holiday takes line 1, notes take the rest |
| capacity 1, no notes | holiday takes the line |
| capacity 1, notes present | holiday **demotes**: tinted + bolder day number, a 3 px dot before the text, full name on hover |

This is the priority the spec's own F6 design note suggests, made conditional on
density instead of absolute. 1e (holidays demoted *everywhere*) buys three rows
back but contradicts story 6.1 — the poster writes its holidays out. 1f (30 px
two-tier) is honest that it does not fit a 13″ screen, and it is reachable
anyway by dragging the row-height slider to 30.

## C · Vertical bars — labels, month split, horizon (challenge 3)

**Chosen: 1g — 6 px lane + horizontal label chip.**

- **1h (rotated label inside a 13 px lane)** is the wireframe's own "riskiest
  thing on the board". 8.5 px vertical type has to survive 6 pt A4 print (F12);
  it does not. Three lanes would also cost 42 px of every column.
- **1i (row tint + left rule)** is the most poster-like and the cheapest in
  width, but a tinted row is a *fourth* background system fighting weekend and
  Ferien shading — exactly what challenge 4 is trying to avoid.

Implementation details that make 1g work:

- **Lanes are assigned globally, not per column.** A first-fit sweep over the
  whole timeline gives every bar one lane for its entire life, so a six-month
  stripe does not jump sideways at each January. (Per-column assignment, as the
  wireframe prototype did, visibly reshuffles.)
- **Label placement (3.7)** scans the first six rows of each month segment for
  one carrying no holiday text, no note and no `+n` badge, and puts the chip
  there. So the chip lands on empty space rather than covering the user's own
  ink.
- **Month split (3.2)** falls out of segment geometry; continuation segments get
  a `↑` prefix.
- **Horizon (3.6)** is doubled: a `↓` on the stripe where it leaves the last
  column, plus `läuft weiter →` under the column. Mirrored via the same `↑` cue
  for bars that started before the view.
- **Lane cap (3.8):** bars beyond lane 3 are not drawn; each covered day adds to
  its `+n` badge, and the popover lists them with their real date ranges.

## D · Layer separability (challenge 4)

**Chosen: 1j — one lilac hue family at three strengths**, with **1k's hatch
available as a setting**.

```
weekend            #F2EEFC
Ferien             #FAF8FE
weekend in Ferien  #E6DEF8
today              #FFE6F1  + a 3 px solid ink rule in the gutter
```

1j's own critique is fair: four ambient states within a few percent of each
other can die on a bad monitor. Rather than pick a side, "Ferien schraffieren"
in settings switches the Ferien layer to 1k's 45° hatch — a second channel
(texture) next to brightness, which also survives photocopying. Off by default
because the hatch adds noise behind 9 px text.

1l (no fills at all, Ferien as a labelled gutter rail) keeps category colour
completely uncontaminated, which is genuinely attractive — but it discards the
shaded weekend, which is the single most recognisable feature of the paper
original.

The **Today marker** owns the gutter edge rather than competing on fill, so it
still reads on a weekend inside Ferien. It is excluded from print (§15.4).

## E · Day popover (open question 5)

**Chosen: 1m — anchored popover.**

**1n (row expands in place)** is tempting because it needs no floating layer and
would print identically — but it pushes the rest of the column down and breaks
day-number alignment across columns, which is story 1.6 and the reason the board
reads as a grid at all. That is not a trade; it is a regression.

The popover carries the full note stack with category dots, inline rename,
the ↻ yearly toggle, delete, a category swatch strip, *and* the bars covering
that day with their ranges — which gives 3.8's lane overflow a real home instead
of a tooltip.

---

## Open questions from spec §16 — answered

1. **First-run flow.** Start bare. A modal on first launch would contradict the
   whole premise ("no dialogs"), and the board is fully legible before any
   setting is made. One dismissible card names the two gestures and offers the
   Bundesland; declining it leaves a working board with nationwide holidays and
   no Ferien shading (7.5).
2. **Dark mode.** Not in v1. It would double the ambient-layer problem —
   four backgrounds and ten category tones would need a second calibration, and
   the palette is tuned for white paper first (4.5). The token layer is a single
   `:root` block, so adding it later is a contained change, not a rewrite.
3. **Placement of persistent controls.** Toolbar — see A above.
4. **Minimum window size and row metrics.** Minimum 900 × 640. Row height is a
   setting, not a display-class table: 20 px for 13″, 22 px default, 26–28 px on
   a 27″ where a holiday and a note can share a row comfortably. Below the fit
   threshold the board scrolls vertically with month headers pinned rather than
   shrinking type further.
5. **"+n" pattern.** Popover, as specced — see E.
6. **Print footer.** Include the legend strip. A printed stripe with no colour
   key is just a coloured line, and the sheet has no hover to fall back on. The
   strip also carries the active layers and Bundesland, so the poster says what
   it is.
7. **App icon direction.** Not delivered — see "Not built" below.

## Decisions the implementation adds

- **Find counts entries, not segments.** A six-month bar wears one label per
  month (3.7) but is one entry; stepping through it five times would misreport
  the result count. Repeating-note occurrences *do* count separately — each is a
  real, separate place on the board.
- **`+n` badges print.** They are content, not chrome: paper has no hover, so a
  silently dropped entry would make the sheet lie about how full a day is.
- **Snapshots store the last *persisted* board**, not the edited one. Snapshotting
  after the edit would make "restore yesterday" hand back the very change you
  wanted gone.
- **All board geometry is `calc()` against `--row-h` / `--col-w` / `--lane-gap`.**
  This is what lets the print stylesheet re-metric the identical DOM for A4/A3
  instead of maintaining a second renderer.
- **Category renaming is per language.** Renaming "Arbeit" in the German UI does
  not overwrite the English label and vice versa.

## Decisions added by the story audit (2026-08-01)

A 16-agent audit of all 79 stories (each failure adversarially verified)
produced these refinements:

- **9.1 — popover reachability.** The ↻ repeat toggle lives in the popover, but
  the "+n" chip only exists on crowded days, so a lone birthday note had no
  path to it. Right-click on any day now opens the popover.
- **3.8 — the lane cap is per day, not per bar lifetime.** Global first-fit
  lane assignment stays (stable lanes across month splits), but a bar that lost
  the lane lottery is *rescued* per column wherever a base lane is free across
  its whole segment there. It only compresses into "+n" on days where three
  bars actually coincide. Rescued bars may change lanes between months —
  visible beats stable.
- **7.5 — Schulferien defaults off** until a Bundesland exists, and the first
  Bundesland pick auto-enables it. A pressed toggle that shades nothing was a
  lie in presented state.
- **8.1 — Today wins by specificity.** `.day.day.today` outranks the
  weekend-in-Ferien shade that beat it exactly on the launch-day case.
- **⌘Z near text.** Any focused field keeps native text undo — the keydown
  guard returns *before* `preventDefault`, and the shell's menu equivalents
  route through the same guard via `execCommand`. Board undo requires no field
  focus.
- **14.2 `[Could]` is now built:** find lists store-wide matches outside the
  visible window under the search field; clicking one pins the board to that
  month (the only honest way to show the past — rolling mode cannot).
- **--smoke isolation:** the headless test redirects all bridge writes to a
  scratch directory, so it can never touch the user's real board.

## Not built

- **Dark mode** (open question 2) — deferred on purpose, see above.
- **6.6 `[Could]`** *is* built (settings → "Andere Bundesländer gedimmt"); other
  states render in a dimmed italic style.
- **10.3 `[Could]`** — dragging a scratchpad line onto a day is not implemented.
  The pad is a plain textarea with native text editing; line-level drag sources
  would mean tokenising it, which is a different component.
