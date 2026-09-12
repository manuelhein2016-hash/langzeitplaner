# LangzeitPlaner — Complete UX Audit Catalogue

| | |
|---|---|
| **Document** | The exhaustive, auditable inventory of everything the user shall be able to experience and see |
| **Version** | 1.0 |
| **Date** | 2026-08-25 |
| **Sources** | Spec v1.0 · Addendum v2.1 · Delivery Plan v1.0 — all amendments (A1–A12) and fixed decisions **already applied**; every item below is final wording |
| **Item series** | **Canonical** stories 1.1–22.8 (130) · **Derived** behaviors x.A, x.B … (from design notes, interaction reference, fixed decisions) · **N-series** committed absences · **O-series** open items (not yet auditable) |

**How to audit.** Each line is one independently verifiable behavior — check it when observed exactly as stated. Tags: **[M]** Must, **[C]** Could (absence of a [C] item is a noted gap, not a defect). *(am.)* marks wording that differs from its first appearance because an amendment or fixed decision is folded in — this catalogue is the resolved truth, so audit against *this* wording. Derived items carry a source pointer. On any conflict between this catalogue and the spec documents, the specs govern and this catalogue receives an erratum. The N-series is audited by confirming *absence*. Solo mode (F1–F14) must be fully auditable with networking disabled.

---

## F1 — Rolling 12-month board

- [ ] **1.1 [M]** When I open the app, I see the current month plus the next 11 as vertical day columns on one screen, so the whole planning horizon is visible without any clicks.
- [ ] **1.2 [M]** Each day is a slim row with date and weekday abbreviation (Mo–So) and weekends shaded, so the board reads like the printed Jahresplaner I'm used to.
- [ ] **1.3 [M]** I can switch from rolling mode to a pinned start month (e.g., always January), so I can also use it as a classic year calendar.
- [ ] **1.4 [M]** If the window is narrower than 12 columns (13" MacBook), the board scrolls horizontally with month headers pinned, so small screens degrade gracefully instead of shrinking to unreadable.
- [ ] **1.5 [M]** In pinned mode I can page year-back/year-forward, so retained history (8.4) is actually reachable, not just theoretically stored.
- [ ] **1.6 [M]** Rows align by day number (01 at top, like the PDF), so columns compare cleanly even though weekdays shift.
- [ ] **1.A [M]** Month columns carry headers in the reference format (e.g., `August '26`); months shorter than 31 days leave their bottom rows empty. *(src: v1 §5)*
- [ ] **1.B [M]** The board never scrolls vertically; vertical fit is achieved by row density, truncation, and popovers. *(src: v1 F1 notes)*
- [ ] **1.C [M]** Rolling vs. pinned is a settings-level mode; year-paging controls are visible only in pinned mode. *(src: v1 F1 notes)*
- [ ] **1.D [M]** First launch in solo mode opens directly onto the usable (empty) board — no wizard, no account prompt, no setup steps. *(src: Principle 7, A10)*

## F2 — Quick day notes

- [ ] **2.1 [M]** I click any day, type, and hit Enter to save — Escape cancels — so capturing a note takes seconds and never opens a dialog.
- [ ] **2.2 [M] *(am.)*** I click an existing note to select it, double-click it (or press Enter while selected) to edit it in place, and clear its text or hit ✕ to delete it, so maintenance is as fast as creation. *(click model fixed in v1 §15)*
- [ ] **2.3 [M]** A day can hold more than one note (with graceful truncation on narrow columns), so busy days don't force compromises.
- [ ] **2.4 [M]** A crowded day shows the first two notes plus "+n"; clicking expands a popover with the full stack, so narrow columns never silently hide entries.
- [ ] **2.5 [M]** Notes cap at ~80 characters, truncate with ellipsis, and show full text on hover — keeping rows thin is what keeps 12 months on one screen.
- [ ] **2.A [M]** Notes render in their category's color on the board. *(src: v1 F2 notes)*
- [ ] **2.B [M]** The day popover offers full note texts with in-place edit and delete, and shows each note's category. *(src: v1 F2 notes)*
- [ ] **2.C [M] *(am.)*** In v2 the popover additionally contains the sharing cluster: the three-state visibility control, the co-edit flag, and the attribution line. *(src: A7)*

## F3 — Multi-day bars

- [ ] **3.1 [M]** I press a start day and drag to an end day to lay down a colored bar, so vacations and project phases go on the board in one gesture.
- [ ] **3.2 [M]** A bar crossing a month boundary splits across the two columns but stays one entry (same color, label shown once per segment, edit either part edits the whole), so real ranges aren't broken by the layout.
- [ ] **3.3 [M]** I can give a bar a short label shown on or beside it, so every stripe is self-explaining.
- [ ] **3.4 [M]** Overlapping bars render in parallel lanes within the day rows, so simultaneous things (project + vacation) stay readable.
- [ ] **3.5 [M]** Dragging upward (end before start) just normalizes — no error state for a natural gesture.
- [ ] **3.6 [M]** A bar reaching past the visible horizon gets a "continues →" cue and grows back into view as the board rolls, so long projects are never clipped silently. Mirrored for bars starting before the view.
- [ ] **3.7 [M]** A bar's label renders once per month segment with full text on hover, so six-month stripes stay labeled without clutter.
- [ ] **3.8 [M]** Parallel lanes cap at 3 per day; further overlaps compress into a "+n" marker with tooltip, so extreme weeks stay legible.
- [ ] **3.A [M]** While a bar is being dragged or resized, lane assignment stays stable — no mid-gesture reshuffling of other bars. *(src: v1 F3 notes)*
- [ ] **3.B [M]** Creating a bar shows a live preview of the range during the drag, before release. *(src: v1 §12 deliverable 5)*
## F4 — Color categories

- [ ] **4.1 [M]** I manage a legend of categories (rename, recolor, add, remove) that starts with a sensible default set (Arbeit / Familie / Reisen / Deadlines), so it works out of the box but fits my life.
- [ ] **4.2 [M]** Every note and bar belongs to a category, defaulting to the last one I used, so entries come out colored without extra clicks.
- [ ] **4.3 [M]** I toggle a category's visibility in the legend, so I can isolate e.g. Work when planning around deadlines.
- [ ] **4.4 [M]** Deleting a category with entries prompts me to reassign them ("Move 23 entries to …?"), so nothing vanishes as a side effect.
- [ ] **4.5 [M]** Colors come from a fixed palette of ~10 distinguishable, print-safe tones instead of a free picker, so the legend stays readable on screen and paper.
- [ ] **4.6 [M]** Creating an entry whose category is currently hidden auto-unhides that category with a brief flash, so a new entry can never disappear the moment I make it.
- [ ] **4.A [M] *(am.)*** In v2 the legend has two sections — *Meine Kategorien* (personal, never synced) and *Familie* (members) — and categories remain a private organizational system. *(src: A3)*

## F5 — Move, resize, undo

- [ ] **5.1 [M]** I drag a note onto another day to reschedule it, so replanning is one motion instead of delete-and-retype.
- [ ] **5.2 [M]** I drag a bar as a whole to shift it while keeping its length, so sliding a vacation one week later is a single move.
- [ ] **5.3 [M]** I grab a bar's start or end edge to stretch or shrink it, so adjusting durations is direct.
- [ ] **5.4 [M] *(am.)*** ⌘Z undoes / ⇧⌘Z redoes my recent changes (~50 steps), covering create, edit, move, resize, and delete — so no drag or delete is ever scary. Import is excluded; it has its own confirmation instead. In family mode, undo covers only **my own** actions (18.4).
- [ ] **5.5 [M]** Click selects a note or bar (Esc deselects, Delete removes); drags only start past a small pixel threshold (~4 px), so clicking to edit never turns into an accidental move.
- [ ] **5.6 [M]** Dragging near the board's edge auto-scrolls horizontally, so a note can be dragged from August into a month that's currently off-screen.
- [ ] **5.A [M]** Entries expose the full state set: default, hover, selected, editing, dragging (ghost at origin + preview at target), and resize handles on selected bars. *(src: v1 §10)*
- [ ] **5.B [M]** The cursor communicates the action: default / grab / grabbing / row-resize over bar edges. *(src: v1 F5 notes)*
- [ ] **5.C [M]** There are no invalid drop targets — dropping is always allowed on any day. *(src: v1 F5 notes)*

## F6 — Public holiday layer (Feiertage)

- [ ] **6.1 [M]** German public holidays appear inline next to their date in a distinct style, so the board matches the paper original.
- [ ] **6.2 [M]** I pick my Bundesland once in settings, so regional holidays (Fronleichnam, Allerheiligen …) show correctly.
- [ ] **6.3 [M]** The holiday data is baked into the app for any year, so it works fully offline with zero sync.
- [ ] **6.4 [M]** I can toggle the layer off, so it never competes with my own entries when I don't need it.
- [ ] **6.5 [M]** Holidays are computed from rules (fixed dates + Easter arithmetic + Buß- und Bettag rule), not from a lookup table — so this layer literally never runs out of data, forever, offline: any pinned year, past or future, shows correct holidays.
- [ ] **6.6 [C]** A "show other Bundesländer dimmed" toggle reproduces the PDF's union view — my state's holidays strong, everyone else's muted (two distinct visual weights).
- [ ] **6.A [M]** When user content covers a holiday's text, the user entry wins the space but the holiday stays discoverable (marked day + tooltip). *(src: v1 F6 notes)*
- [ ] **6.B [M]** The Bundesland selector offers all 16 states plus "nur bundesweite Feiertage". *(src: v1 §13)*

## F7 — School holidays layer (Schulferien)

- [ ] **7.1 [M]** Schulferien for my Bundesland appear as subtle background shading behind the day rows, so school-free periods are visible without stealing attention.
- [ ] **7.2 [M]** Hovering (or tapping) the shading reveals which break it is (Herbstferien, Osterferien …), so the shading is never cryptic.
- [ ] **7.3 [M]** The layer toggles independently of public holidays, so each layer can be on or off on its own.
- [ ] **7.4 [M] *(am.)*** Ferien are published only ~2–3 years ahead — the bundled dataset has a visible horizon ("Ferien-Daten bis Sommer 2028" in settings), beyond which shading is simply absent; the dataset refreshes through the normal app-update channel (F22), never a separate download. *(A11)*
- [ ] **7.5 [M]** With no Bundesland selected, the layer stays off, and toggling it prompts for the selection first.
- [ ] **7.A [M]** The four ambient backgrounds — plain day, weekend, Ferien, weekend-within-Ferien — are all visually distinguishable while staying quieter than any user content. *(src: v1 F7 notes, §10)*

## F8 — Today marker and auto-roll

- [ ] **8.1 [M]** Today is unmistakably highlighted, so I can orient myself instantly.
- [ ] **8.2 [M]** In rolling mode the board advances by itself at the month change — oldest column out, new twelfth in — so I always face the next 12 months without maintenance.
- [ ] **8.3 [M]** A "Today" button jumps me back to the current day from wherever I've scrolled, so exploring next summer is never a one-way trip.
- [ ] **8.4 [M] *(am.)*** Entries that roll out of view are kept in storage, not deleted, so history survives and reappears if I pin an earlier start month; family entries remain part of that history only while I'm a member. *(A9)*
- [ ] **8.5 [M]** Date changes while the app is running — midnight passes, or the Mac wakes from sleep days later — update the today marker and trigger the month-roll live, no restart needed.
- [ ] **8.6 [M]** The roll itself is a brief, subtle slide animation (~300 ms), so the leftmost column leaving is comprehensible rather than a glitch.
- [ ] **8.A [M]** The Today marker reads clearly against every other highlight (weekend, Ferien, selection) as the board's single permanent accent. *(src: v1 F8 notes, §10 hierarchy)*
- [ ] **8.B [M]** With macOS "Reduce Motion" enabled, the roll (and all other animations) become instant swaps. *(src: v1 §15)*

## F9 — Yearly repeats

- [ ] **9.1 [M]** A "repeats yearly" checkbox on a note makes it reappear on the same date every year, so birthdays survive the roll into the next year.
- [ ] **9.2 [M]** Repeating notes carry a small ↻ marker, so I can tell recurring from one-off at a glance.
- [ ] **9.3 [M]** Editing or deleting a repeating note applies to the whole series, so there's exactly one object to maintain — no exception logic.
- [ ] **9.4 [M]** A Feb-29 repeat shows on Feb 28 in non-leap years, so leap-day birthdays never skip a year.
- [ ] **9.5 [M]** A series exists from its first year onward — paging back before its creation year shows nothing, matching reality.
- [ ] **9.6 [M]** Repeats apply to notes only; bars stay one-off (annual events with movable dates would silently land wrong).
- [ ] **9.A [M]** The repeat toggle lives in the note's edit state / popover, not on the board surface; the ↻ marker sits before the text so it survives truncation. *(src: v1 F9 notes)*
- [ ] **9.B [M] *(am.)*** A repeating series can be shared; its visibility is series-level (the whole series is Privat/Belegt/Geteilt — no per-year exceptions), so Oma's birthday is entered once and visible to everyone, forever. *(src: A4)*
## F10 — Month scratchpad

- [ ] **10.1 [M]** Each month column has a small free-text area beneath it, so undated thoughts ("book cabin?") live next to the month they belong to.
- [ ] **10.2 [M]** Scratchpad text persists and autosaves like everything else, so it's a real part of the board, not a sticky note that vanishes.
- [ ] **10.3 [C]** I can drag a scratchpad line onto a day to turn it into a dated note, so vague plans can graduate into real ones.
- [ ] **10.4 [M]** Pads belong to a *specific* month — Aug '26 and Aug '27 are different pads; new months arrive empty, old pads persist into history.
- [ ] **10.5 [M]** A pad grows to ~5 lines then scrolls; print includes only non-empty pads.
- [ ] **10.A [M]** Pads read visually as margin, not day content, and support native text editing incl. its own text undo. *(src: v1 F10 notes)*
- [ ] **10.B [M] *(am.)*** Scratchpads remain private in v2 — they never sync to the family. *(src: A5)*

## F11 — Autosave and backup

- [ ] **11.1 [M]** Every change is saved locally within about a second, with no save button anywhere, so I never think about persistence.
- [ ] **11.2 [M] *(am.)*** One click exports my entire own state — private entries, my shared/Belegt entries with their flags, categories, settings, and my identity keys — as a single JSON; the file is the recovery artifact and says so in its header; other members' entries are never included. *(A2)*
- [ ] **11.3 [M] *(am.)*** Importing a JSON restores my data — and re-joins my Familienkreis when the keys are present — after an explicit "replace current board?" confirmation, so recovery is one action and never an accident. *(A2)*
- [ ] **11.4 [M]** Data lives as one human-readable JSON in Application Support, written atomically, so even a crash mid-save can't corrupt the board.
- [ ] **11.5 [M]** The app keeps the last 7 daily snapshots with one-click restore, so yesterday's bad idea is recoverable even after undo history is gone.
- [ ] **11.6 [M]** The data file carries a schema version and newer app versions migrate it automatically, so updating the app never strands data.
- [ ] **11.7 [M]** Export uses the native save dialog with a dated default name (`LangzeitPlaner-2026-08-01.json`).
- [ ] **11.A [M]** Snapshot restore lives in settings as a list of 7 dates with a restore action behind a confirmation. *(src: v1 F11 notes)*

## F12 — Print / PDF export

- [ ] **12.1 [M]** One click opens a clean A4/A3 landscape print view in the style of the schulferien poster, with my entries on it, so the plan can still end up on a wall.
- [ ] **12.2 [M]** The print view hides all UI (buttons, legend controls) and keeps entry colors, so the paper version looks designed, not screenshotted.
- [ ] **12.3 [M] *(am.)*** Printing respects the current layer, category, and (in v2) member toggles — what I see is what prints. *(A8)*
- [ ] **12.4 [M]** Printing goes through the macOS print dialog — "Als PDF sichern", paper size, and scale-to-fit come free and native.
- [ ] **12.A [M]** The whole board prints on one landscape page; the Today highlight is excluded from print. *(src: v1 §15)*
- [ ] **12.B [M]** Truncated content prints truncated (paper has no hover); only non-empty scratchpads print. *(src: v1 F12 notes, 10.5)*

## F13 — App shell, shortcuts, menus, settings

- [ ] **13.1 [M]** A normal Dock app with a single window that remembers size, position, and scroll offset across launches.
- [ ] **13.2 [C]** A menu-bar icon focuses/opens the window with one click — a settings toggle, default **on**, with a monochrome template glyph.
- [ ] **13.3 [M]** A launch-at-login toggle in settings, so the board is just always there.
- [ ] **13.4 — superseded by A1.** Audit as **21.5**: solo mode makes zero network requests; family mode talks to exactly one sync endpoint.
- [ ] **13.5 [M]** ⌘W hides the window while the app keeps running; ⌘Q quits; reopening from the Dock is instant with full state.
- [ ] **13.6 [M]** Every core action has a shortcut — audited item-by-item as 13.A–13.J below.
- [ ] **13.7 [M]** UI language is German by default, with an English toggle in settings; switching translates the full UI while German content terms (Feiertage names, Ferien names) remain German.
- [ ] **13.A [M]** ⌘Z / ⇧⌘Z — undo / redo. *(src: v1 §9)*
- [ ] **13.B [M]** ⌘F — find.
- [ ] **13.C [M]** ⌘T — jump to today.
- [ ] **13.D [M]** ⌘P — print.
- [ ] **13.E [M]** ⌘1 / ⌘2 — toggle Feiertage / Schulferien layer.
- [ ] **13.F [M]** ⌘, — settings.
- [ ] **13.G [M]** ⇧⌘E / ⇧⌘I — export / import backup.
- [ ] **13.H [M]** ⌘W / ⌘Q — hide window / quit.
- [ ] **13.I [M]** Enter / Esc — commit edit & step through find hits / cancel, deselect, close find or popover.
- [ ] **13.J [M]** Delete (⌫) — delete the selected entry.
- [ ] **13.K [M]** The macOS menu bar carries the standard structure with these entries: App (About, Einstellungen ⌘,, Beenden ⌘Q) · Ablage (Exportieren ⇧⌘E, Importieren ⇧⌘I, Drucken ⌘P, Fenster schließen ⌘W) · Bearbeiten (Widerrufen/Wiederholen, text editing, Suchen ⌘F) · Darstellung (Heute ⌘T, Feiertage ⌘1, Schulferien ⌘2, Modus Rollierend/Fixiert) · Fenster/Hilfe standard. *(src: v1 §9)*
- [ ] **13.L [M]** Settings contains, findable in one surface: Bundesland selector (6.B) · layer defaults · rolling vs. pinned mode · language DE/EN · launch at login · menu-bar icon on/off · snapshot restore (11.A) · Ferien data horizon display (7.4) — plus, in v2: the *Familie* section (create/join, members, admin panel, sync detail, device pairing) and the *Datenschutz* section. *(src: v1 F13 notes, A10)*

## F14 — Find

- [ ] **14.1 [M] *(am.)*** ⌘F opens a slim search field; matching notes and bars light up while everything else dims (~30 %); Enter steps through hits, ⇧Enter backwards, with a "3/17" counter; Esc restores the board. Search covers note texts, bar labels, scratchpads — and, in v2, family entries (shared text, Belegt owner names). *(v1 §15, A6)*
- [ ] **14.2 [C]** Search also covers rolled-out history, listing off-screen hits as clickable results.
- [ ] **14.A [M]** Find is an overlay state of the board, never a separate screen. *(src: v1 F14 notes)*
## F15 — Familienkreis

- [ ] **15.1 [M]** By default I'm in solo mode and nothing has changed from v1 — no account, no network activity, no prompts; the family features exist only behind an explicit "Familienkreis erstellen / beitreten" entry point in settings.
- [ ] **15.2 [M]** I create a Familienkreis with a name ("Familie Weber"), automatically become its admin, and receive a shareable invite code, so setup is one screen.
- [ ] **15.3 [M]** Mom joins by pasting the invite code into her app and choosing a display name and a personal color — no email, no password, no registration form — so a non-technical family member gets in within a minute.
- [ ] **15.4 [M]** All members see the member list (name, color, initial), so everyone knows who's in the circle.
- [ ] **15.5 [M]** Invite codes are single-use, expire after 7 days, and are revocable by the admin, so a leaked link can't haunt the family.
- [ ] **15.6 [M]** I can change my display name and color anytime and it propagates to everyone's boards, so identity stays current without admin involvement.
- [ ] **15.A [M]** The join flow is one screen with a large paste field; it prevents choosing a color already taken by another member. *(src: v2 F15 notes)*

## F16 — Visibility (Privat / Belegt / Geteilt)

- [ ] **16.1 [M]** Everything I create is **private by default** — joining a family changes nothing about existing or new entries until I explicitly share them — so oversharing is structurally impossible.
- [ ] **16.2 [M]** Every note and bar has one of three visibility levels: **Privat** (only me), **Belegt** (others see that the range is taken, and by whom, but no text), **Geteilt** (others see everything) — so I can coordinate without disclosing.
- [ ] **16.3 [M]** I change an entry's visibility with a three-state control in its selected state and popover, two clicks maximum, so privacy management never feels like administration.
- [ ] **16.4 [M]** A personal category can set a default visibility for *new* entries in it (e.g., category "Familie" ⇒ Geteilt), so routine sharing costs zero extra clicks while the global default stays private.
- [ ] **16.5 [M]** I can change visibility at any time; a downgrade removes the entry (or its details) from other members' boards at the next sync, so nothing shared is shared forever.
- [ ] **16.6 [M]** My shared and busy entries carry a small badge **on my own board**, so I always see my exposure at a glance and never have to wonder what Mom can see.
- [ ] **16.7 [M]** A Belegt entry appears on others' boards as a neutral block with my color/initial and the word "Belegt" — duration and owner are deliberately visible, the content deliberately not — so "I'm away, don't plan with me" works without explanation.

## F17 — Family content on my board

- [ ] **17.1 [M]** Shared and Belegt entries from other members appear on my board automatically in their date rows, so family plans live exactly where my plans live.
- [ ] **17.2 [M]** Color logic: **my** entries always render in **my category colors**; **others'** entries render in the **member's personal color** with an initial chip ("M") — so "whose is this?" is answered before "what is it?".
- [ ] **17.3 [M]** The legend's member section lets me toggle each member's visibility, so I can hide Papa's entries the same way I hide a category.
- [ ] **17.4 [M]** Family entries obey all v1 density rules — lanes cap, "+n" overflow, truncation — so a busy family can never break the board's legibility.
- [ ] **17.5 [M]** Entries added or changed by others since my last session carry a quiet "neu" dot that fades once I've seen them — no popups, no counters, no push — so I notice change the way I'd notice new ink on a wall calendar.
- [ ] **17.6 [M]** Hover/popover shows attribution: "von Mama · geteilt · geändert So.", so provenance is one glance away but never printed on the board.
- [ ] **17.7 [C]** A per-device density setting (Kompakt / Komfort) slightly increases row height and font size on that machine only, accepting horizontal scroll as the trade.

## F18 — Editing rights and collaboration

- [ ] **18.1 [M]** By default only the owner can edit or delete an entry; other members view — so nobody's plans can be rewritten behind their back.
- [ ] **18.2 [M]** An entry-level flag "Familie darf bearbeiten" opts one entry into co-editing, so collaboration exists exactly where invited and nowhere else.
- [ ] **18.3 [M]** As admin I can *unshare* any entry from the family space — it reverts to owner-private, it is never deleted — so moderation is non-destructive, and I still can't read what was never shared.
- [ ] **18.4 [M]** My ⌘Z undoes only **my own** actions; other members' changes never appear in my undo stack.
- [ ] **18.5 [M]** If two people edit the same co-editable entry near-simultaneously, the later change wins per field, attribution updates, and only the person whose in-flight edit lost sees a quiet one-line inline notice that dismisses itself.
- [ ] **18.6 [M]** Deletions propagate to all boards; my undo of my own deletion restores the entry as a new shared operation.
- [ ] **18.A [M]** The co-edit flag sits next to the visibility control in the popover as one "sharing" cluster. *(src: v2 F18 notes)*

## F19 — Sync, offline, own devices

- [ ] **19.1 [M]** The app is fully functional offline — create, edit, move, everything — and queues changes locally; sync happens when connectivity returns, so a train ride never interrupts planning.
- [ ] **19.2 [M] *(am.)*** My changes upload within seconds of saving; others' changes arrive automatically — on app focus and every ~30–60 s while the app is open. There is no sync button and no manual refresh anywhere.
- [ ] **19.3 [M]** Sync status is silent when healthy; only pending-offline or a real error produces a small, unobtrusive indicator.
- [ ] **19.4 [M]** I can pair my own second Mac: my **entire** board — including private entries — syncs end-to-end encrypted between **my** devices only.
- [ ] **19.5 [M]** Adding a device means entering a short pairing code shown on an existing device — not a password-reset flow; there are no passwords in this product.
- [ ] **19.6 [M]** After long offline periods everything merges cleanly on return — including month rolls and yearly repeats that occurred meanwhile — so a laptop opened after three weeks just catches up.
- [ ] **19.A [M]** Pairing has designed screens on both ends (show code / enter code) with both-ends confirmation. *(src: v2 F19 notes, deliverable 21)*

## F20 — Space lifecycle and admin

- [ ] **20.1 [M]** As admin I can invite, revoke invites, remove members, rename the space, and transfer the admin role to another member.
- [ ] **20.2 [M]** Removing a member deletes their shared/Belegt entries from all family boards and their access — their private data on their own machine is untouched.
- [ ] **20.3 [M]** Leaving voluntarily has the same effect, self-initiated; other members' shared entries disappear from my board, my own entries all revert to private and stay with me — nobody ever loses their *own* data by leaving.
- [ ] **20.4 [M]** As admin I can delete the entire Familienkreis: server data is purged, every member reverts to a fully intact solo board.
- [ ] **20.5 [M]** Even as admin, I structurally **cannot** see other members' private entries or the contents of their Belegt entries — enforced by encryption, not by policy.
- [ ] **20.6 [M]** Each user belongs to at most **one** Familienkreis, so the mental model stays as simple as the family it serves.
- [ ] **20.A [M]** The admin panel is a section inside settings, not a separate console; removal/leave/delete confirmations state their consequences in one plain sentence. *(src: v2 F20 notes)*

## F21 — Privacy and security, as experienced

- [ ] **21.1 [M]** Shared and Belegt entries are end-to-end encrypted; only member devices hold keys — the server stores ciphertext it cannot read.
- [ ] **21.2 [M]** Private entries never leave my machines except end-to-end encrypted to my *own* paired devices — no family key can ever decrypt them.
- [ ] **21.3 [M] *(am.)*** The app documents plainly what the server side *can* see — pseudonymous IDs, timestamps, IP addresses in transit, encrypted blob sizes — and names the processors (Vercel, Prisma Postgres; EU/Frankfurt region), so trust is informed, not marketed.
- [ ] **21.4 [M]** Still no analytics, no tracking, no third-party services beyond the sync endpoint.
- [ ] **21.5 [M]** In solo mode the app makes zero network requests; with a Familienkreis it talks to exactly one sync endpoint and nothing else. *(supersedes 13.4)*
- [ ] **21.A [M]** A "Datenschutz" section in settings carries this in human German, not legalese. *(src: v2 F21 notes)*
- [ ] **21.B [M]** Family onboarding contains the honesty moment: "Kein Passwort. Dein Backup ist dein Schlüssel — exportiere jetzt eins," making key-loss consequences plain and prompting an immediate backup export. *(src: v2 §3, deliverable 24)*

## F22 — Installation and updates

- [ ] **22.1 [M]** The app ships as a single DMG small enough to attach to a normal email; installing is open → drag to *Programme* → launch; the same email carries the download link as fallback.
- [ ] **22.2 [M]** First launch handles macOS quarantine gracefully: a signed and notarized build simply opens; in the unsigned fallback, a first-run screen walks through the Systemeinstellungen unlock in two illustrated steps.
- [ ] **22.3 [M]** The app checks for updates on launch and roughly daily, downloads quietly in the background, and applies on the next start — after the first email, nobody ever downloads anything manually again.
- [ ] **22.4 [M]** An available update announces itself only as a quiet "Update verfügbar" hint (app menu and settings), never a modal; one click restarts into the new version, and simply quitting applies it on next launch.
- [ ] **22.5 [M]** Every device — my two Macs and Mom's — follows the same single release channel and converges automatically.
- [ ] **22.6 [M]** Updates are cryptographically signed and verified before installing — a device installs authentic builds or nothing.
- [ ] **22.7 [M]** Updates never touch user data; migrations run after the swap; if a server change ever requires a minimum client version, outdated clients say so in one plain sentence instead of failing quietly.
- [ ] **22.8 [M]** Releases flow from GitHub: one tag moves the entire product — server and every desktop — forward together.
- [ ] **22.A [M]** The update hint is a dot in the quiet-signal family, not a badge count. *(src: v2 F22 notes)*
- [ ] **22.B [M]** The invitation email is itself part of the experience: subject, three install steps with a screenshot, the invite code, the fallback link. *(src: deliverable 28)*
---

## N — Committed absences (audit by confirming these are NOT present)

- [ ] **N1 [M]** No accounts, emails, or passwords exist anywhere in the product. *(15.3, 19.5, v2 §3)*
- [ ] **N2 [M]** No save button, no sync button, no manual refresh, anywhere. *(11.1, 19.2)*
- [ ] **N3 [M]** No dialogs for creating or editing entries — dialogs appear only for destructive or rare actions (delete category, import, restore, leave/remove/delete space). *(v1 Principle 2)*
- [ ] **N4 [M]** No times of day anywhere — dates only; consequently no timezone or DST behavior exists to audit. *(v1 §13, v2 §8)*
- [ ] **N5 [M]** No reminders, notifications, or push of any kind. *(anti-goals; v2 §11)*
- [ ] **N6 [M]** No popups, badge counts, or attention-demanding signals for family changes or available updates — only quiet dots. *(17.5, 22.4, 22.A)*
- [ ] **N7 [M]** No read receipts, no presence indicators, no "seen" states — in either direction. *(Principle 9)*
- [ ] **N8 [M]** No notification or trace when someone changes an entry's visibility — downgraded entries are simply no longer there ("no snitch mechanics"). *(v2 §6)*
- [ ] **N9 [M]** No comments, reactions, or chat on entries — the board is not a messenger. *(v2 §6)*
- [ ] **N10 [M]** No ads, analytics, tracking, or third-party calls beyond the single sync endpoint; solo mode = zero network, verifiable with a network monitor. *(21.4, 21.5)*
- [ ] **N11 [M]** No spinners or loading states on the board itself. *(v2 F19 notes)*
- [ ] **N12 [M]** No role — including admin — can access another member's private entries or Belegt contents. *(20.5)*
- [ ] **N13 [M]** No per-year exceptions on repeat series, and no recurrence beyond yearly notes (no weekly/monthly, no repeating bars). *(9.3, 9.6)*
- [ ] **N14 [M]** No free color picker — only the fixed palette. *(4.5)*
- [ ] **N15 [M]** Nothing is ever deleted by the passage of time — rolling removes from view, never from storage. *(8.4)*
- [ ] **N16 [M]** The board never scrolls vertically. *(1.B)*
- [ ] **N17 [M]** No UI copy ever promises "live" sync. *(v2 §3)*
- [ ] **N18 [M]** Solo first-run contains no family, account, or network prompts of any kind. *(15.1, Principle 7)*
- [ ] **N19 [M]** Sharing is never a side effect — no action other than the explicit visibility control (or a category default the user configured) ever exposes an entry. *(16.1, 16.4)*
- [ ] **N20 [M]** No per-member visibility ("share with Mom but not Papa") — the circle is the unit of trust. *(v2 §8)*

## O — Open by design (do NOT audit; absence is not a defect)

- **O1** First-run coach marks / guided "first shared entry" moment — open (v1 §16 Q1, v2 §12 Q7).
- **O2** Dark mode — open (v1 §16 Q2).
- **O3** Placement of persistent controls (Today, layer toggles, find, legend) — design's call (v1 §16 Q3).
- **O4** Minimum window size and exact row metrics per display class — open (v1 §16 Q4).
- **O5** Printed category-legend footer strip — open (v1 §16 Q6).
- **O6** App icon and the exact ~10-tone palette values — design deliverables, not yet fixed.
- **O7** `langzeitplaner://` invite links beyond plain codes — open (v2 §12 Q4).
- **O8** Per-month "neu" counts in headers beyond per-entry dots — open (v2 §12 Q5).
- **O9** Exact icons of the three-state visibility control — suggestion only, not committed (v2 F16 notes).
- **O10** Everything on the deferred list (phone/tablet viewer, web app, shared scratchpads, multiple circles, etc.) — explicitly out of scope (v2 §11).

## Catalogue summary

| Series | Items |
|---|---|
| Canonical stories (final wording, incl. one superseded pointer) | 130 |
| Derived auditable behaviors (x.A …) | 46 |
| N-series committed absences | 20 |
| **Total auditable items** | **196** |
| O-series open items (excluded from audit) | 10 |

Coverage: all 130 canonical stories from Spec v1.0 + Addendum v2.1 appear exactly once, in post-amendment wording (A1–A12 and the v1 §15 decisions resolved); the derived series promotes every user-observable commitment from design notes, the interaction reference (v1 §9), constraints, and fixed decisions into checkable form. Priorities: 5 [C] items (6.6, 10.3, 13.2, 14.2, 17.7); all other items are [M].

*End of catalogue v1.0 — on conflict, Spec v1.0 and Addendum v2.1 govern.*
