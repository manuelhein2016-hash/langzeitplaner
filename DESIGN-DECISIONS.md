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
| D9 | Invite carries wrapped family keys | **No — an existing member device must be online** ¹ |

¹ Corrected 2026-08-27 (E3 integration). This row read "the admin's device must be online"; ADR 002
§7.1 step 4 says **any existing member device, not only the admin's**, and it is later and gives the
reason — a two-person family would otherwise depend on one sleeping laptop. The decision itself is
unchanged; only the assumption about *whose* Mac is. See the corrected paragraph under D9 below.

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

> **EXTENDED 2026-08-28, E3 fix pass — findings S3 and S7. Neither reverses D8; both are the UX
> half of it, and both are one line away from a different answer if the PO wants one.**
>
> **S7 — the passphrase now has a FLOOR, and the floor is SOFT.** `passphraseBytes` refused the
> empty string and whitespace-only and nothing else, so `'1'`, `'1234'` and `'passwort'` all
> sealed a real identity; the red team cracked a `'1234'` file with a four-entry dictionary.
> 600 000 rounds is the right number and it is not a substitute for entropy — a 4-digit PIN is
> 10 000 candidates, minutes on one laptop, against the file whose own README says *„Wer diese
> Datei und dein Passwort hat, ist du."*
>
> `backup.js` now exports `PASSPHRASE_FLOOR` (12 code points, 5 distinct characters) and a pure
> `passphraseStrength()`, and `EXPORT_SHEET_COPY.passphrase` carries the German and English copy
> the sheet shows **before** anything is typed. A weak passphrase is still **accepted**, with the
> warning shown and the button reading *„Trotzdem so sichern"*.
>
> **Why soft.** A hard refusal on this artefact has a failure mode strictly worse than the one it
> prevents: the user who cannot get past the field clicks *„Nur Einträge sichern"* instead and
> now has **no recovery artefact at all** — no keys, no Familienkreis, one dead Mac away from
> nothing. (The other well-known outcome is the sticky note, which moves the secret from a KDF to
> a desk.) A weak passphrase behind 600 000 rounds is a bad lock on a real door; the board-only
> file is no door. **If the PO wants a hard floor**, it is `PASSPHRASE_FLOOR.hard = true` plus
> flipping `exported` on rows `C2d-3…7` in `tests/helpers/crypto-domains.js`; the error code
> `passphrase-too-weak` and its German and English sentence already exist, unused, so that the
> switch really is one line and no caller's `switch` stops being exhaustive.
>
> **S3 — the board block is now authenticated too, on this path only.** ADR 002's finding E3-6
> was a PO question and it is answered: with a passphrase, a SHA-256 of the whole `board` block
> is bound into the AES-GCM AAD, so whoever edits a recovery file can no longer open it. E3-6's
> argument for leaving it unbound — *"the board-only path has no key, so the guarantee would hold
> on one of the two paths"* — is true of the board-only file and says nothing about the file that
> says „DIES IST DEIN SCHLÜSSEL" across the top. **Two paths with two stated guarantees** is the
> shape that argument permits, and `LIMITS.board` carries both sentences in both languages.

## D10 — story 21.5 is amended: "zero requests" becomes "zero UNREQUESTED requests"

**Decided by the PO, 2026-09-03.** Recorded here and in `docs/v2/adr/003-sync-protocol.md` §7.5,
because **amending a measured property is exactly the quiet erosion a conformance sweep hunts
for** and it must not be findable only as a diff.

**The old wording**, story 21.5, superseding v1's 13.4:

> "Network scope, replacing 13.4: **in solo mode the app makes zero network requests**; with a
> Familienkreis it talks to exactly one sync endpoint and nothing else. The v1 property survives
> as a scoped guarantee."

**The new wording**, story 21.5 as amended:

> "Network scope, replacing 13.4: **in solo mode the app makes zero *unrequested* network
> requests — the only request a solo copy can originate is the one a human asks for, by pressing
> „Senden" on the Rückmeldung screen (LZP-1009)**; with a Familienkreis it talks to exactly one
> sync endpoint and nothing else. The v1 property survives as a scoped guarantee."

**Why.** LZP-1009 puts „Rückmeldung senden" in Einstellungen, and Einstellungen is in the boot
graph of every launch. That makes the feedback POST the **first network request a solo copy of
this app can ever make**, and 21.5's "zero" was false from the commit that landed it. Two honest
options: amend the story, or make the feature family-only. The second refuses the report from the
only tester who has no Familienkreis — the person the feature exists for, and the person whose
report will say „ich komme nicht mehr rein". The PO chose to amend.

**What the amendment buys back, and it is not nothing.** The old promise bounded a **count**
(zero). A count is only ever measured over the sessions somebody thought to script, and it goes
green over a session nobody ran. The new promise bounds an **originator** — a human press, and
nothing else — which is a property of the source tree and is checkable by construction:

- `src/js/feedback/port.js` exports one getter, `feedbackPort()`, and it is the only way to reach
  `send`. **Exactly one module may import it**, and it is the screen with the button on it.
  Everyone else — including `family/mount.js`, which owes the binding line (E10-1009-A) — may
  import the **setter** and can therefore bind a sender but never fire one.
- `tests/tier1/network-scope.test.js` §5 measures it over all **78** shipped modules: **1
  originator, `human`, `src/js/feedback/ui.js:245`, triggered by `addEventListener('click', …)`**.
- §5d is armed by four planted automatic callers (`setInterval`, `online`, `DOMContentLoaded`, a
  `setTimeout`'d `autoReport`) plus an honest-path control and a second-human-press control.

**██ THE EXCEPTION MAY NOT WIDEN. ██** A *second automatic* caller of the feedback path is a
regression against this decision, not an extension of it. The shapes to expect are all courtesies:
a retry timer, an `online` listener "so it goes out when the wifi is back", an
`unhandledrejection` handler that files a report by itself. Each looks harmless alone; together
they are an unattended solo Mac sending, **with every endpoint gate still green**, because none of
them adds an endpoint. §5b is the row that goes red; §5c is the row that keeps
`feedback/events.js` — the module that already listens to `error` and `unhandledrejection` — one
import short of being able to.

**What did not change.** Not a third network job, not a second remote host: the exception is a
POST to the sync relay's **own origin** over the **existing transport**. ADR 003 §7's four gates
are untouched, the CSP diff is still empty, and the native-socket exception count is still **two**
(sync, update). What is new is a third thing a human can ask for over the first of them.

**A1 is unaffected.** *"v1's wording may remain true for solo mode and should be quoted that way
in about/marketing copy."* On its own the app still does nothing, and the Datenschutz copy (D11)
states it in that scoped form rather than as an absolute.

---

### D10 EXTENDED — 2026-09-05 · the amendment stops being vacuous

**Decided by the PO, 2026-09-04/05, at the LZP-1009 second pass.**

D10 as written above was **true and unreachable**. It amended 21.5 so that a solo copy could
originate one request — and the shell refused it anyway. `syncPreflight` read the `sync_enabled`
switch first and returned `sync_disabled` for every request a Mac with no Familienkreis could
make, so „Senden" was disabled on exactly the Mac D10's own argument is about:

> *"The second refuses the report from the only tester who has no Familienkreis — the person the
> feature exists for, and the person whose report will say „ich komme nicht mehr rein"."*

That paragraph was the reason for the amendment and it described a product that did not exist.
**A solo Mac may now send**, and D10's amendment becomes load-bearing rather than aspirational.

**What changed, and what did not.**

| | before | after |
|---|---|---|
| the shell gate | switch → pin → rebuild → method | pin → rebuild → method → **switch, as a conjunction** |
| the sync-off surface | nothing | **exactly one (method, path)**: `POST /api/v1/feedback`, exact equality, no query |
| the binder | `family/mount.js#bindFeedback` only | **plus** `feedback/relay.js#bindSoloSender`, and only when `canSend()` is already false |
| dynamic doors out of the boot graph | one (`main.js -> family/mount.js`) | **two** — the second reaches `platform/net.js` and nothing else |
| the ORIGINATOR | one human press | **unchanged, and re-measured over a wider scan** |

**The reorder is not a weakening, and the reason it happened is worth keeping.** The carve-out has
to be decided on a **canonical** URL — `/api/v1/%66eedback` and `/api/v1/feedback/../feedback` are
one path to a server and two strings to a comparison — so deciding it before the rebuild would
decide it on the string the page sent, which is the class of bug the pin and the rebuild exist to
close. Everything above the switch is pure and local: a compiled-in constant, `URLComponents`,
string comparison. No name is resolved and no `URLSession` is allocated, so moving the switch down
three steps costs **no request**. `tests/tier1/release-gate.test.js` §4b carried the opposite
claim — *"solo mode makes zero requests BECAUSE the switch is first"* — and that claim was never
measured; it is now inverted, with the mechanism written where the number is.

**The exception still may not widen, and the scan that holds it got wider, not looser.**
`tests/tier1/network-scope.test.js` §5b used to match `/\.send\(/` and nothing else. The
operator's reader calls `transport.request(`, so that row would have stayed green over an entire
new transport — the E10-1009-B failure for the third time. It now matches every dispatcher
spelling over the **solo-reachable tree** (everything outside `sync/`, `crypto/`, `family/`, which
are the three directories gate 2 proves a solo launch cannot evaluate), **enumerates the three
call sites by file and line**, and classifies a dispatcher handed on under a property name as
`handed-on` rather than as a trigger. Measured: **0 automatic, 1 human, 4 handed-on**.

---

## D12 — a report is KEPT for 90 days, and the operator is a server-configured key

**Decided by the PO, 2026-09-04/05.** Two decisions that only make sense together: the channel is
useless without somewhere to read it, and a place to read it is a place the report is stored.

**D12a — the admin view is a screen inside the app, on his Mac only.** Not e-mail (a report would
then be in a mailbox at a third party, and the relay would need a credential to send with), not a
web page (the relay ships `public/` precisely to say it has no website, and a web page is a second
authentication surface on the open internet). It is a section in Einstellungen, after Hilfe, gated
on `reportsAdmin === true` — a local pref **nothing under `src/js/` ever writes**, so no sequence
of clicks reaches it on anybody else's Mac.

**D12b — the operator identity is `LZP_REPORTS_ADMIN_PUB`, a P-256 public key in the relay's
environment.** The private half is his existing device signing key. **This is not `Member.role`
returning.** ADR 003 §5.1 removed `Member.role` because *the admin of a circle* must be resolved
from the log; *who operates this relay* is server configuration, exactly like `feedbackSink` —
no column, no row, no body field, nothing a client can send to become it, and `'role'` stays in
`FORBIDDEN_COLUMN_TOKENS`. The variable is read in `adapters/vercel.js` and nowhere else, so
`server/core/` stays free of `process.env`.

Scheme `LZPADMIN`, domain prefix `lzp/reports/v1\n`, **no body hash — because a body is refused
outright**: a field that cannot be present cannot be unsigned. Replay goes through the existing
`Nonce` table, so there is no schema change for it. A relay with **no operator configured answers
404** on all three routes — the same answer `/api/v1/nope` gets — before the credential is parsed,
so the reply cannot depend on what was presented.

**What it does NOT defend against, stated on the wire as `ADMIN_PROVES_NOT[0]` and not only here:**
whoever can set this relay's environment variables can read its database directly and can set the
variable to a key of their own. It is a control against the internet, not against Vercel.

**D12c — 90 days, plus manual delete.** Copies the `Nonce`/`PairSession` `@@index([expiresAt])`
pattern, with a lazy sweep on both put and list because Vercel Hobby has no cron, and expiry
enforced **at read** as well — the way `getPairSession` and `consumeInvite` already do. `Report`
has **no `spaceId` and no relation to `Space`**, so *"a report can never appear on the family's
board"* stays structural rather than careful; `deleteSpace` deliberately does not cascade into it.

**THE PRICE, AND IT IS A NEW DISCLOSURE.** A **signed** report's `Report.devicePub` is
byte-identical to `Device.sigPubRaw` — it has to be, or the signature could not be verified — so a
retained report is **joinable to a circle**: one equality join names the member, her circle and her
household, and `Report.prose` is plaintext. That is not defended against and must not pretend to
be; the operator is the intended reader. It is **said** instead: `server-metadata.md` §7.6,
`DATENSCHUTZ.*.infer6` in both languages, and `tests/server/datenschutz-claims.test.js` §8. The
bound is stated with it: an **unsigned** report — every report a solo Mac sends, which is the case
D10's extension exists for — carries no key at all, and there is nothing to join.

**D12d — the signal is a quiet 5px dot on ⚙**, reusing the updater's existing hint (17.5 / 19.3).
No count, no banner, no sound, **never on the board** (P9). It is a pure function of two local
prefs — `reportsKnown \ reportsSeen ≠ ∅` — so it survives a relaunch with **zero network
requests**, measured in `tests/tier2/lzp1009-dot.dom.js` §2 as a difference: the same gesture costs
the same number of requests with the dot lit and with it dark. A once-per-launch poll was
considered and rejected: it would be a second automatic originator and would spend exactly the
bound D10 exists to hold.

**P10 IS UNTOUCHED AND IS NOW GUARDED BY AN ENUMERATION.** The board is not a messenger and there
is no reply path, ever. `tests/attack/e10-network-scope.test.js` §2c no longer counts the
reporting routes — a count would pass over a fifth one with the wrong shape — it asserts that the
**mutating** verbs on that surface are exactly two, the write and the delete. A reply route, an
answer route, a `PATCH` that adds a field the client could poll: every one of them is a third
mutating verb, whatever it is called.

## D11 — the Datenschutz section is a section of its own, not part of „Familienkreis"

**Built 2026-09-03, LZP-1001, story 21.3 · amendment A10 places it differently and this is the
deviation.** A10 says *"Settings gains a Familie section: … Datenschutz text (21.3) …"*. Built
that way, the section is drawn by `family/mount.js` — the one dynamically imported door — and is
therefore **invisible on a solo install**, which never loads it.

Three of the section's paragraphs are true and load-bearing on exactly that Mac:

1. „Ohne Familienkreis spricht dieser Mac mit niemandem", with D10's exception named;
2. the backup file — **R1**: the entries in an exported backup are readable without the password;
3. D8's consequence — lose every Mac and the password and **nobody** can recover the data.

A solo tester is also the reader most likely to be carrying a backup file around and least likely
to have been told what is in it. So the section is drawn on every launch, from `settings.js`, and
each family-specific paragraph names its condition in its first clause („Mit Familienkreis: …").
Held by `tests/tier2/datenschutz.dom.js` §1a, which opens the **real** settings sheet on a Mac
with no space.

The copy itself lives in `settings.js` beside the code that draws it and **not** in `i18n.js`, for
the reason `feedback/copy.js` gives one section down: these are promises, not labels, and a person
changing the thing a sentence describes should see the sentence in the same diff.

## D9 — invites do NOT carry wrapped keys

The tighter of the two options, chosen deliberately. A leaked invite email is **never**
sufficient to read family content; **an existing member's device** must be online to wrap the
family keys to the joiner's device key.

> **CORRECTED 2026-08-27, E3 integration.** The sentence above originally said *"the admin's
> device must be online"*. ADR 002 §7.1 step 4 says **any existing member device — not only the
> admin's**, and it is the later document and the one that gives the reason: a two-person family
> would otherwise be blocked whenever one particular laptop was asleep, which is the failure this
> decision's own cost paragraph is trying to bound. The delivered code enforces the ADR
> **structurally rather than by convention**: nothing in `src/js/crypto/spacekeys.js` takes a
> role, an `isAdmin` flag or an admin id, and `tests/tier1/crypto-spacekeys.test.js` asserts that
> no export names one. Steps 1–4 below are unchanged except that step 3's "the admin's device"
> is likewise **any member device**; nothing else about D9 moves.

The cost is real and lands on the flow the addendum cared most about. Story 15.3 promises a
non-technical family member "gets in within a minute". With D9 that is now conditional on the
admin's Mac being awake, so the join flow **must not hang or lie**. Required behaviour:

1. Mom pastes the code, picks name and colour, and is **immediately a member** — the code
   redeems against the server, her device key is published, the member list shows her.
2. Her board then enters an explicit, calm **waiting state**: she is in the circle, and the
   family entries appear as soon as ANY member's Mac next syncs. German-first copy, one line,
   no spinner on the board (19.3's "silence is the design" still governs).
3. The next member device to sync wraps the keys — no action required from anyone, and no
   notification demanded of them. It must not need any particular person to *notice* anything.
4. Only then do shared entries decrypt and appear.

This turns a 60-second flow into a two-step one whenever every other Mac is asleep. It is the price
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

---

# v2 — decisions open after the WP-1/WP-3 audits (2026-08-27)

Both owed judges (`judge:adversary3`, `judge:conformance`) ran read-only against `c0306ac`. Their
full register — 24 findings, with owner and status per row — is **`docs/v2/FINDINGS.md`**. Three
rows there are a **PO decision, not an engineering fix**, and they are repeated here because this
is the file the PO reads. The trade-off is stated in full in `FINDINGS.md` §4.

| | decision | the trade |
|---|---|---|
| **F-1** | does `board.json` go back to being a byte-stable fixed point across a restart? | fixing it restores ADR 001 §5 step 5 and v1's fixed-point property; it also **rewrites `board.json` for every existing user on their next save** — identical content, different bytes |
| **A3-H2** | when v2's type table is stricter than v1's, do we **coerce**, **quarantine**, or **refuse to migrate**? | five entry shapes v1 keeps are dropped and the loss is committed to disk on the first autosave — most visibly, `repeatsYearly: 'yes'` makes **a birthday silently stop repeating**. Only "refuse" never loses data; only "coerce" is invisible to the user |
| **A3-M1a** | is a permissive door better than a throwing one? | the op door throws on 27 hostile values and silently accepts 3 others (a `null` note text that can never render, a `null` `categoryId` quietly repaired, a number written into a pref register). Either behaviour is defensible; **the mix is not**, and the answer decides what WP-8 does with a hostile peer |

## The `deviceShort` contradiction — decided, no PO input needed

Recorded here only so it is visibly closed: `deviceShort` is `crock32(SHA-256(rawSigPubKey)[0..10])`,
a function of the device's **signing key**, defined once in ADR 001 §1.2. `op.dev` is an unrelated
random identifier, and the two are joined by a **lookup** over the member's `dev.*` attestation
registers — never a hash. **ADR 002 §5.2 is rewritten and is the normative answer**; ADR 001 §4.0
now says lookup. This was the item blocking WP-6; its remaining blocker is a ~10-line code change
(finding F-10), not a decision.

## D7's open wording question is unchanged

The `⚠ OPEN FOR THE PO` block above D7 is still open and neither judge closed it. `FINDINGS.md`
does **not** duplicate it, because it is a wording question about this file rather than a defect.
