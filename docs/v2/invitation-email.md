# The invitation e-mail — LZP-108, deliverable 28

**Stories:** 22.1 (single DMG, three steps, Releases fallback), 15.3 (Mom joins with a code),
22.2 (the unsigned first launch). **Decisions:** D1 (ship unsigned), D9 (invites carry no keys).

This document is the source of truth for the copy. The files you actually send live in
`docs/v2/email/` and are copied next to their image by `scripts/build-release-assets.sh`:

| file | what it is |
|---|---|
| `docs/v2/email/invitation.de.txt` | German, plain text. Paste into any mail client. |
| `docs/v2/email/invitation.en.txt` | English, plain text. |
| `docs/v2/email/invitation.de.html` | German, HTML. Open in a browser, ⌘A ⌘C, paste into Mail. |
| `docs/v2/email/invitation.en.html` | English, HTML. |
| `build/email/LangzeitPlaner-Installation.png` | the one screenshot, generated |
| `build/email/invitation.*.preview.html` | the same HTML with the image inlined — **for proof-reading only** |

`node .github/scripts/check-email-copy.mjs` fails if any of the promises below goes missing
from any of the four files. It runs on every push.

---

## 1. Why this e-mail is the most important screen in the epic

Under D1 the app is unsigned. On macOS 15 and later an unsigned app does not launch on the
first double-click — Gatekeeper blocks it before a single line of our code runs.

**That has a consequence for LZP-106 that is worth stating plainly: the guided unlock screen
inside the app cannot be the first thing Mom sees.** It cannot run before the wall, because the
wall stops the process that would draw it. The only two things that reach her before the scary
dialog are this e-mail and the text painted into the DMG window background. LZP-106's screen is
the *second* line of defence — valuable for the person who deleted the e-mail, or who is helping
somebody else install it later — but it is not the first.

So the highest-leverage sentence in the whole of E1 is in step 3 of this e-mail, and it has to
arrive **before** she double-clicks:

> Beim allerersten Start sagt der Mac: „Apple konnte nicht überprüfen, ob ‚LangzeitPlaner'
> frei von Schadsoftware ist." Und er lässt die App zunächst nicht starten. Das ist keine Fehlermeldung, und kaputt ist auch nichts.

Unannounced, that dialog reads as *this is broken, and possibly dangerous*. Announced, it reads
as *step three*. Nothing else in this epic changes an outcome that much for that little.

---

## 2. The subject line

**DE — `Hier ist der Kalender für deinen Mac`**
**EN — `Here's the calendar for your Mac`**

Deliberately flat. It is from a family member, it says what the mail contains, and it survives
being read on a phone lock screen. Rejected: anything with a product name in front ("LangzeitPlaner
— Ihre Einladung"), which reads as a mailing list and gets treated like one.

---

## 3. Structure, and what each part is doing

| section | job | breaks if removed |
|---|---|---|
| Greeting + one sentence on what it is | context before instructions | she reads three steps for a thing she can't picture |
| "Im Anhang liegt …" | names the file, sets the two-minute expectation | — |
| **Step 1** open the attachment | — | — |
| the screenshot | shows the DMG window *before* she sees it | step 2 becomes ambiguous |
| **Step 2** drag onto *Programme* | the install, story 22.1 | — |
| **Step 3** launch + the Gatekeeper wall | **D1's whole survivability** | the install dead-ends at a security dialog |
| Fallback link | providers that strip `.dmg`, story 22.1 | the mail arrives with no app in it and no way forward |
| Invitation code | story 15.3 | — |
| The D9 waiting paragraph | sets the truth about arrival time | she thinks joining failed |
| Solo-mode line | story 15.1 — family is optional | the code reads as mandatory |
| Privacy + auto-update, two sentences | A1's scoped wording, story 22.3 | the daily update check looks like something we hid |
| "ruf einfach an" | — | — |

### Three steps, one screenshot — as specified

22.1 asks for exactly this, and `check-email-copy.mjs` enforces "exactly one `<img>`". The
screenshot sits between step 1 and step 2 because that is the moment it answers a question
("what am I looking at?") rather than decorating one.

### The D9 paragraph

`DESIGN-DECISIONS.md` § D9 requires four things: membership is instant, the wait is explicit
and calm, it resolves without the admin *noticing* anything, and it is never phrased as an
error or as an errand. The copy:

> Eine Sache noch, damit du nicht wartend davorsitzt: **Die gemeinsamen Termine sind direkt nach
> dem Beitreten noch nicht da.** Sie kommen von allein, sobald sich ein anderer Mac aus der
> Familie das nächste Mal meldet — meistens innerhalb eines Tages. Du musst dafür nichts tun und
> niemanden erinnern. Dein eigener Kalender läuft von der ersten Minute an ganz normal; du kannst
> sofort alles eintragen, was du willst.

Three deliberate choices. "**noch nicht da**" rather than "wird geladen" — nothing is loading,
and a progress metaphor would be a lie. "**von allein**" and "**niemanden erinnern**" close the
door on the failure mode D9 names by name: the invitation must never become an errand for
somebody else's laptop. And the last clause gives her something to do *now*, so the wait is not
an empty room. The checker rejects "frag mal Papa", "bitte deinen … Mac", and any phrasing that
makes the wait conditional on a person acting.

### What the e-mail deliberately does not say

- **No promise about *when*.** "Meistens innerhalb eines Tages" is a description, not an SLA. The
  sync cadence is pull-based (Section 3 of the addendum) and the admin's Mac may be shut.
- **No "you are now part of the family calendar!" celebration.** Principle 10, calm collaboration.
- **No feature tour.** The board explains itself; a list of features in an install mail is the
  marketing voice this product does not have.
- **No price, no "I built this for you", no apology for the security dialog.** The dialog is
  explained in one clause ("weil ich sie nicht offiziell bei Apple angemeldet habe") and then
  dropped. An apology would make it feel bigger than it is.

---

## 4. The placeholders

Four, in all four files. `check-email-copy.mjs` fails if any is missing — which also means a real
invite code can never be committed by accident, and invite codes are single-use and expire in
seven days (15.5), so a leaked one in git history would be a real problem.

| placeholder | fill with | note |
|---|---|---|
| `{{NAME}}` | the recipient's name | |
| `{{RELEASE_URL}}` | the GitHub Releases page or the direct `.dmg` link | **paste the link for the version you attached**, not `/latest` — see §6 |
| `{{EINLADUNGSCODE}}` | the code from *Einstellungen → Familienkreis → Einladung erstellen* | one per person; single-use, 7 days (15.5) |
| `{{ABSENDER}}` | your name | |

---

## 5. Sending it — the checklist

1. `./scripts/build-release-assets.sh` — regenerates the screenshot from source.
2. Open `build/email/invitation.de.html` in a browser. ⌘A, ⌘C.
3. New message in Mail, ⌘V. The image comes across as a real inline attachment.
   *Do not paste `invitation.de.preview.html`* — it carries the image as a `data:` URI, which
   Gmail and several other clients refuse to display.
4. Set the subject (§2). Mail does not take it from the pasted content.
5. Replace the four `{{PLACEHOLDERS}}`. Search for `{{` before sending.
6. Attach `LangzeitPlaner-<version>-universal.dmg`.
7. **Check the total size against the recipient's provider.** See §6.
8. Send it to yourself first and read it on a phone. The step numbers and the amber panel are
   the two things that break first in an unfamiliar client.

---

## 6. Size: the number that decides whether the attachment survives

Mail providers cap the **base64-encoded** message, which is 4/3 of the raw bytes plus line
breaks — about **×1.36**. The mail carries two things, not one.

| | measured, this machine |
|---|---|
| `LangzeitPlaner-Installation.png` | **72 KiB** → ~0.10 MB encoded |
| the HTML body | ~10 KB → ~0.014 MB encoded |
| the DMG | see below |

| provider | cap | budget left for the DMG |
|---|---|---|
| GMX, Web.de, T-Online | 20 MB | **≈ 14.6 MB** |
| Gmail, iCloud, Outlook | 25 MB | ≈ 18.3 MB |

> **Small correction to LZP-101's gate.** `release.yml` warns above 14.7 MB and fails above
> 20 MiB, measuring the DMG on its own. The e-mail also carries the screenshot, so the real
> 20 MB-provider budget is **≈14.6 MB of DMG**. The gate is right to about 0.1 MB — worth
> knowing, not worth changing. It would matter if the screenshot were heavier, which is one
> reason it is not (§6.1).

### 6.1 Real measurements

A complete DMG built here from the Swift shell — background, `/Applications` symlink, single
(non-universal) binary:

```
build/dmg/LangzeitPlaner.dmg   1 511 922 bytes = 1.44 MiB, ~2.1 MB base64-encoded
```

What this ticket's artwork adds to that, measured by building the same DMG twice:

| | on disk | inside the compressed DMG |
|---|---|---|
| `background.tiff` (660×420 + 2× hidpi) | 180 KB | **166 KiB** |
| `AppIcon.icns` gaining its alpha channel | +126 KB | included in the `.app` |
| the e-mail screenshot | 72 KiB | not in the DMG at all |

**The gradients were the whole cost.** The first draft had a vertical ground gradient and a warm
radial glow; both dither, and dithered pixels do not compress. Measured on the hidpi TIFF that
actually ships:

| background | TIFF | cost inside the DMG |
|---|---|---|
| gradient + radial glow | 845 KB | 824 KiB |
| gradient only | 571 KB | — |
| **flat** | **180 KB** | **166 KiB** |

665 KB — 4.6% of the tight provider budget — for two gradients that are almost invisible at
those values. The art is flat now and depth comes from the drop-well and the icons instead. The
same change took the e-mail screenshot from 255 KiB to 72 KiB. The reasoning is written into
`assets/dmg/background.svg` so that whoever reaches for a gradient next re-measures first.

### 6.2 What this does not tell you

That 1.44 MiB is the **Swift shell**, not the Tauri build. Rust cannot be installed on this
machine, and the Rust binary is the dominant term: estimated 13–20 MB universal, ~8–13 MB after
the DMG's zlib. **The shipping DMG is expected around 8–13 MB and remains an estimate until CI
produces one.** What is now measured rather than estimated is everything this ticket added to it:
under 0.3 MB, artwork and icon together.

**If the DMG ever exceeds the budget:** lead with `{{RELEASE_URL}}` and send no attachment. The
copy already works that way round — the fallback section stands on its own and needs no edit.

---

## 7. The full copy

### 7.1 German

**Betreff: Hier ist der Kalender für deinen Mac**

<!-- Kept in sync with docs/v2/email/invitation.de.txt by check-email-copy.mjs. -->

> Hallo {{NAME}},
>
> hier ist der Kalender, von dem ich erzählt habe. Ein ganzes Jahr auf einer Fläche, jeder Monat
> eine Spalte. Man klickt auf einen Tag und schreibt drauf, so wie auf einem Whiteboard in der
> Küche.
>
> Im Anhang liegt eine Datei namens **LangzeitPlaner.dmg**. Das Installieren dauert zwei Minuten.
>
> **1 — Die Datei im Anhang doppelklicken**
> Es geht ein Fenster auf: links das Kalender-Symbol, rechts ein blauer Ordner, dazwischen ein
> Pfeil. Es sieht so aus: *[Screenshot]*
>
> **2 — Das Kalender-Symbol auf den blauen Ordner ziehen**
> Der Ordner heißt **„Programme"** (falls dein Mac auf Englisch eingestellt ist: **„Applications"**).
> Symbol mit der Maus rüberziehen, loslassen — das war die Installation. Das Fenster kannst du
> danach zumachen.
>
> **3 — Starten — und einmal eine Sicherheitsmeldung wegklicken**
> Das schreibe ich dir vorher auf, damit du nicht erschrickst: **Beim allerersten Start sagt der
> Mac: „Apple konnte nicht überprüfen, ob ‚LangzeitPlaner' frei von Schadsoftware ist."** Und er
> lässt die App zunächst nicht starten.
>
> Das ist keine Fehlermeldung, und kaputt ist auch nichts. Der Mac kennt die App nur nicht, weil
> ich sie nicht offiziell bei Apple angemeldet habe. Du musst ihm einmal sagen, dass sie in
> Ordnung ist:
>
> **a)** Doppelklick auf LangzeitPlaner. Die Meldung kommt. Auf **„Fertig"** klicken — *nicht*
> auf „In den Papierkorb".
> **b)** Apple-Menü (das Apfel-Symbol ganz oben links) → **Systemeinstellungen** →
> **Datenschutz & Sicherheit**. Dort ganz nach unten scrollen, bis „Sicherheit" kommt. Da steht
> jetzt „LangzeitPlaner wurde blockiert, um deinen Mac zu schützen." und daneben ein Knopf
> **„Dennoch öffnen"**. Draufklicken.
> **c)** Die Meldung kommt noch einmal — diesmal mit einem Knopf **„Öffnen"**. Draufklicken. Dann
> fragt der Mac nach deinem Passwort oder dem Fingerabdruck.
>
> Fertig. Ab jetzt startet der Kalender wie jedes andere Programm, und diese Meldung kommt nie
> wieder.
>
> **Falls der Anhang fehlt**
> Manche Mail-Anbieter filtern .dmg-Dateien heraus. Wenn oben also gar keine Datei hängt, lade sie
> hier herunter — es ist genau dieselbe: {{RELEASE_URL}}
>
> **Dein Einladungscode**
> `{{EINLADUNGSCODE}}`
>
> In der App: **Einstellungen → „Familienkreis beitreten"**, den Code einsetzen, Namen und eine
> Farbe aussuchen. Das war's, du bist dabei.
>
> Eine Sache noch, damit du nicht wartend davorsitzt: **Die gemeinsamen Termine sind direkt nach
> dem Beitreten noch nicht da.** Sie kommen von allein, sobald sich ein anderer Mac aus der Familie
> das nächste Mal meldet — meistens innerhalb eines Tages. Du musst dafür nichts tun und niemanden
> erinnern. Dein eigener Kalender läuft von der ersten Minute an ganz normal; du kannst sofort
> alles eintragen, was du willst.
>
> Und wenn du ihn erst einmal lieber nur für dich nutzen möchtest: Code einfach weglassen. Dann
> läuft er komplett für sich allein, ohne Internet.
>
> **Zwei Sätze, die dich vielleicht interessieren**
> Was du für dich einträgst, bleibt auf deinem Mac — der Kalender selbst geht damit nicht ins
> Internet. Ausgetauscht werden nur die Termine, die wir ausdrücklich miteinander teilen, und die
> sind verschlüsselt unterwegs. Einmal am Tag fragt die App außerdem kurz nach, ob es eine neuere
> Version gibt, und installiert sie beim nächsten Start von selbst — du bekommst deswegen nie
> wieder eine E-Mail und musst nie wieder etwas herunterladen.
>
> Wenn irgendwas klemmt: ruf einfach an.
>
> {{ABSENDER}}

### 7.2 English

**Subject: Here's the calendar for your Mac**

> Hi {{NAME}},
>
> here's the calendar I told you about. A whole year on one surface, one column per month. You
> click on a day and write on it, the way you would on a whiteboard in the kitchen.
>
> Attached is a file called **LangzeitPlaner.dmg**. Installing takes two minutes.
>
> **1 — Double-click the attachment**
> A window opens: the calendar icon on the left, a blue folder on the right, an arrow in between.
> It looks like this: *[Screenshot]*
>
> **2 — Drag the calendar icon onto the blue folder**
> The folder is called **Applications** (on a Mac set to German it is called **Programme**). Drag
> the icon across with the mouse and let go — that was the installation. You can close the window
> afterwards.
>
> **3 — Launch it — and dismiss one security warning**
> I'm writing this down in advance so it doesn't startle you: **the very first time you open it,
> your Mac will say: "Apple could not verify that 'LangzeitPlaner' is free of malware."** And it
> refuses to start the app.
>
> That is not an error message, and nothing is broken. Your Mac simply doesn't know this app,
> because I haven't officially registered it with Apple. You have to tell it once that the app is
> fine:
>
> **a)** Double-click LangzeitPlaner. The message appears. Click **"Done"** — *not* "Move to Trash".
> **b)** Apple menu (the apple at the very top left) → **System Settings** → **Privacy & Security**.
> Scroll all the way down to "Security". It now says "LangzeitPlaner was blocked to protect your
> Mac." with a button next to it, **"Open Anyway"**. Click that.
> **c)** The message comes back once more — this time with an **"Open"** button. Click it. Then
> your Mac asks for your password or your fingerprint.
>
> Done. From now on the calendar starts like any other app, and that message never comes back.
>
> **If the attachment isn't there**
> Some mail providers strip .dmg files out. If there is no file attached above, download it here
> instead — it is exactly the same one: {{RELEASE_URL}}
>
> **Your invitation code**
> `{{EINLADUNGSCODE}}`
>
> In the app: **Settings → "Join family circle"**, paste the code, pick a name and a colour.
> That's it, you're in.
>
> One more thing, so you're not sitting there waiting: **the shared entries won't be there the
> moment you join.** They arrive on their own, as soon as another Mac in the family next checks in
> — usually within a day. You don't have to do anything for that, and you don't have to remind
> anyone. Your own calendar works completely normally from the first minute; you can start writing
> in it straight away.
>
> And if you'd rather keep it to yourself for now: just leave the code out. Then it runs entirely
> on its own, with no internet at all.
>
> **Two sentences you might care about**
> What you write down for yourself stays on your Mac — the calendar itself doesn't go online with
> it. The only things exchanged are the entries we explicitly share with each other, and those
> travel encrypted. Once a day the app also quietly asks whether there's a newer version, and
> installs it the next time you start it — so you'll never get another e-mail about this and never
> have to download anything again.
>
> If anything gets stuck: just call.
>
> {{ABSENDER}}

---

## 8. The screenshot

`build/email/LangzeitPlaner-Installation.png`, 740×520 (and `@2x`), generated by
`scripts/build-release-assets.sh` from three committed SVGs plus two live icons.

It is **a rendering, not a screen capture** — say so if anyone asks. It is composited from the
*same* `assets/dmg/background.svg` the DMG ships and the *same* icon coordinates
`tauri.conf.json` gives the bundler, so it cannot drift away from the window Mom actually opens;
`check-dmg-geometry.mjs` fails the build if it starts to. The folder icon is the live system icon
for `/Applications` on the build machine, not a redrawn imitation. Once CI has produced a real
DMG, replacing this with an actual screen capture from a German Mac is a strict improvement —
nothing else in the e-mail changes.

**One thing in it is unverified:** the label under the folder. macOS localises `/Applications` to
*Programme* through `/System/Library/CoreServices/SystemFolderLocalizations/de.lproj` (verified —
that table really does map `"Applications" => "Programme"`), but whether Finder applies that
localisation to a *symlink* inside a DMG could not be tested on this machine, which runs in
English. If it does not, the label under the folder will read "Applications" while the picture
says "Programme". The copy is written so that this cannot mislead: step 2 names **both** words,
and the background art paints „Programme" into the window itself where the wording is ours.

---

## 8.1 The words in step 3 are not mine

Every macOS label quoted in step 3 comes from `src/js/i18n.js` — the same table LZP-106's in-app
unlock screen draws from, which in turn takes them from Apple's own German documentation. That
matters more than it sounds: Mum reads this e-mail and then goes looking for a button. The German
button is **„Dennoch öffnen"**, not „Trotzdem öffnen"; the first dialog's safe button is
**„Fertig"** and the dangerous one right next to it is **„In den Papierkorb"**, which the copy now
names so she does not click it.

`check-email-copy.mjs` pins the e-mail to those strings rather than to anybody's memory of macOS.

## 8.2 The unlock page that should ride on the DMG — built, not yet placed

`src/js/firstrun.js` exposes `renderUnlockDocument()`: the same two illustrated steps as one
self-contained HTML file, both languages, no script and no external asset. Its purpose is to sit
on the disk image next to the app, where a double-click opens it in Safari — which Gatekeeper does
not block — so that somebody who has lost this e-mail still has a way through.

It is **built and verified**: `./scripts/build-unlock-page.sh` produces
`build/dmg/Bitte zuerst lesen.html` (19 KB) by running `renderUnlockDocument()` in a real
WKWebView through the tier-2 harness, and the generator asserts the page is complete,
script-free and asset-free before writing it.

**It is not on the DMG, and that is a decision, not an oversight.** Tauri's DMG bundler can
position exactly two items — `bundle.macOS.dmg` offers `appPosition` and
`applicationFolderPosition` and nothing else. A third file injected into the image after the
build lands wherever Finder puts it, which can be directly on top of the arrow. Shipping that
would make the window this ticket exists to polish worse, in a way nobody can check here, because
Finder automation is refused on this machine (`-1743`) and Rust cannot be installed at all.

Three ways forward, for whoever owns the call:

| option | cost |
|---|---|
| **a.** Post-build inject **and re-run the whole layout** with the read-me positioned | replaces Tauri's DMG styling with `make-dmg.sh`'s; one layout implementation instead of two, but it is the production path and it cannot be tested here |
| **b.** Inject and accept an unpositioned icon | free, and risks landing on the artwork |
| **c.** Leave it off the DMG; reach it from Settings and from the e-mail | free, verified, and useless in exactly the case it was designed for |

Recommendation: **(a)**, on the first CI run that produces a real DMG, with the background art
gaining a third slot at that point. Doing it blind now would be guessing at a layout in the one
part of this epic that has no test.

## 9. Related

- The DMG window this e-mail depicts: `assets/dmg/background.svg`, `scripts/build-release-assets.sh`
- The release pipeline that produces the attachment: `docs/v2/RELEASE.md`, `.github/workflows/release.yml`
- The in-app unlock screen, which comes *after* this e-mail, not before it: LZP-106
- D9's join flow and its waiting state: `DESIGN-DECISIONS.md` § D9, deliverables 15 and 25
