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

---

# v2 — Familien-Edition: decisions fixed by the PO (2026-08-25)

The v2 delivery plan (`docs/v2/PLAN.md` §5) listed nine blocking decisions. D2–D6 came
from the sprint plan; D7–D9 were surfaced by the architecture review. All nine are now
answered. This section is WP-0's exit criterion.

| # | decision | answer |
|---|---|---|
| D1 | Apple Developer ID (99 €/yr) | **No — ship unsigned** |
| D2 | EU/Frankfurt region for Vercel + Prisma | Yes |
| D3 | "GitHub sync" = deploy-on-push | Confirmed as written |
| D4 | Person-colour rule for foreign entries (17.2) | Accept as specced |
| D5 | Belegt in v2.0 | Keep |
| D6 | Path A or Path B | **A** — forced by reality; v1 exists as working code |
| D7 | LZP-901's impossible server-side ownership check | Client-side + structural ownership |
| D8 | Identity keys in the backup file | **Passphrase-encrypted** |
| D9 | Invite carries wrapped family keys | **No — admin's device must be online** |

## D1 — unsigned, with the guided unlock screen

LZP-105 (signing & notarization) is **out of scope**; **LZP-106 is in scope and mandatory**,
not optional. macOS 15 removed the right-click → Open bypass, so an unsigned build cannot be
opened by folklore any more — the first-run screen walking through the Systemeinstellungen
unlock in two illustrated steps is the *only* path onto Mom's Mac.

Consequences accepted:

- The scariest screen in the product ships. Deliverable 27 is required, not conditional.
- The invitation email (deliverable 28, 22.1) must set the expectation *before* she double-clicks,
  or the unlock screen arrives as an error rather than as a step.
- LZP-1006 (the Mom test) is now the highest-information test in the plan, because the thing it
  measures is precisely the thing this decision made harder.
- Amendment A12 stands: the v1 Gatekeeper note is superseded by 22.2's fallback path.

The CI release workflow is written with signing as a **flag that is off**. Turning it on later
needs a cert and two GitHub secrets — no code change. The decision is reversible; the fee is
the only thing standing in the way.

## D8 — the backup's identity block is passphrase-encrypted

PBKDF2-SHA-256 (600 000 iterations) → AES-256-GCM, per ADR 002 §7.2. Export gains one
passphrase field.

This does **not** contradict "no passwords" (addendum §3). That principle forbids a
*registration and login system* — an account you sign in to. This is a password on a key file,
the same category as an SSH key passphrase. Nothing on the server ever sees it, and it is not
an identity.

The alternative was worse than it looks: two of three reviewed architectures shipped **raw
private keys** inside a file the onboarding explicitly tells the user to email to themselves.
That file is a complete device takeover, and it would sit in a mail archive forever.

Copy consequence: the export sheet must say what the passphrase protects and that **losing it
loses the backup** — there is no reset, by design (Section 3's Option-B trade).

## D9 — invites do NOT carry wrapped keys

The tighter of the two options, chosen deliberately. A leaked invite email is **never**
sufficient to read family content; the admin's device must be online to wrap the family keys
to the joiner's device key.

The cost is real and lands on the flow the addendum cared most about. Story 15.3 promises a
non-technical family member "gets in within a minute". With D9 that is now conditional on the
admin's Mac being awake, so the join flow **must not hang or lie**. Required behaviour:

1. Mom pastes the code, picks name and colour, and is **immediately a member** — the code
   redeems against the server, her device key is published, the member list shows her.
2. Her board then enters an explicit, calm **waiting state**: she is in the circle, and the
   family entries appear as soon as the admin's Mac next syncs. German-first copy, one line,
   no spinner on the board (19.3's "silence is the design" still governs).
3. The admin's device wraps the keys on its next sync — no action required from the admin, no
   notification demanded of them. It must not need the admin to *notice* anything.
4. Only then do shared entries decrypt and appear.

This turns a 60-second flow into a two-step one whenever the admin is asleep. It is the price
of the guarantee, and the UI states it rather than hiding it. Deliverable 25 (empty states)
gains this waiting state; deliverable 15 (the join flow) must show it as a designed screen.

Not-negotiable follow-on: nothing in the waiting state may be phrased as an error, and it must
never tell Mom to "ask Dad to open his laptop" as a *requirement* — it resolves itself.

## D7 — ownership is structural, not server-validated

LZP-901 asked for server-side validation that non-owners cannot mutate an entry. That is
impossible without breaking story 21.1: the server relays ciphertext it cannot read, so it
cannot know who owns what. The ticket text is amended rather than the guarantee.

The replacement is stronger than a server check in one respect and weaker in another, and
both halves are stated honestly:

- **Ownership is structural** — the family entity key carries the owner's member id, so there
  is nothing to forge and nothing to backdate. Property P9 asserts that no op sequence, including
  stamps at `ms = 0`, can move an entity to a different owner.
- Every honest client applies the same **deterministic authorization fold**, order-independently.
- The **server** validates what it legitimately can see: membership, device signatures, rate
  limits.
- **What this does not do:** a member who patches their own client can still emit an op the
  others will reject — but not one they will accept. Enforcement is by convergence, not by
  gatekeeper. At family scale (2–8 people who know each other) that is the right trade, and
  it is the only one available under E2EE.

> **⚠ OPEN FOR THE PO — raised by the WP-1 round-2 hardening, not decided here.**
>
> The last bullet is load-bearing: it is quoted whenever an attack finding is triaged, and it is
> read as "anything a patched client can do is covered by D7". Two rounds of adversarial work have
> now produced findings where it does **not** apply, and the wording does not say so.
>
> 1. **Stamp collisions are not "an op the others will reject".** Two ops can legitimately share a
>    stamp: §8.1 stamps every migrated op `GENESIS(index)` with `ZERO_DEVICE_SHORT`, so a user who
>    migrates two boards into one personal space produces collisions **by construction, with no
>    adversary at all**. Such an op is well-formed, `validateOp` has no opinion about it, and every
>    device folds it identically — it is an op the others *accept*. (The consequence, a
>    stamp-keyed push-seq index letting one op's ack satisfy the tombstone-GC guard for another,
>    is fixed; the wording question is not.)
> 2. **The `ownership-authz-*` attack files carry twelve `SUCCEEDED` rows** — a self-declared
>    membership, a forged genesis, a former admin unsharing forever — and each is an op **every
>    honest device accepts and agrees with**. Their file headers already say they break D7's
>    stated guarantee rather than falling under its accepted trade, and they are deferred to WP-9
>    / WP-6 / WP-8 as work owed. That deferral is sound; what is not sound is D7 being cited as
>    though it had already accepted them.
>
> Requested: either a carve-out ("D7 does not cover stamp uniqueness, or membership and admin
> authority, which are WP-9's") or a re-wording of the last bullet. No code depends on the answer;
> triage does.
