# LZP-1006 — the Mom test: the kit, and the test itself

| | |
|---|---|
| **Ticket** | LZP-1006 (E10, 3 pts) — *"clean Mac, real email with DMG + code, unassisted install & join; fix what stumbles"* |
| **Stories** | 22.1 (one attachment, one drag), 22.2 (first launch under quarantine), 15.3 (join in a minute) |
| **Governing decision** | **D1 — ship unsigned.** LZP-105 out of scope, LZP-106 mandatory. |
| **Written** | 2026-09-03 |
| **State of the ticket** | **THE KIT IS BUILT. THE TEST IS OUTSTANDING.** |

---

## 0. The one thing this document will not do

**This ticket cannot be closed by the person who wrote this file, and it is not closed.**

The acceptance criterion is not a document and not a suite. It is *a person who has never seen
the app, on a Mac that has never held it, with no one sitting beside her.* The moment anybody who
knows how the app works is in the room, the measurement is gone: the single most valuable
property of this test — that nobody can explain the confusing part away — is destroyed by the
first helpful sentence.

So the test belongs to the PO and to his mother, and to nobody else. What is delivered here is
everything that can be prepared in advance: the artefacts she meets, a walk of the install path
as a stranger, an instrument that runs the join-screen's own parser against the shipped e-mail,
and a sheet to write on while she works.

**Report LZP-1006 as OUTSTANDING.** The points are not earned by this file.

---

## 1. What the kit contains

| # | piece | where |
|---|---|---|
| 1 | the invitation e-mail, and the D9 rule it must not break | §2 |
| 2 | the install path on a clean Mac, walked as a stranger | §3 |
| 3 | join → first shared entry, with every stumble instrumented | §4 |
| 4 | **`scripts/mom-test-probe.mjs`** — run it before the test; it finds today's stumbles without spending her afternoon | §5 |
| 5 | the script the PO reads on the day, and the sheet he writes on | §6, §7 |
| 6 | what is already known to be broken, and what the test is therefore *not* for | §8 |

---

## 2. The real e-mail

### 2.1 What ships today

Four artefacts, already written and already gated by
`node .github/scripts/check-email-copy.mjs`:

```
docs/v2/email/invitation.de.txt    docs/v2/email/invitation.de.html
docs/v2/email/invitation.en.txt    docs/v2/email/invitation.en.html
```

Four placeholders, so a live invite can never be committed:
`{{NAME}}`, `{{RELEASE_URL}}`, `{{EINLADUNGSCODE}}`, `{{ABSENDER}}`.

The German text is the one that ships to Mom. It carries the subject line, the two install steps,
the third step that warns her about Gatekeeper **before** she meets it, the Releases fallback for
providers that strip `.dmg`, the invitation code, the D9 waiting-state sentence, and a short
honest paragraph about what does and does not leave her Mac.

### 2.2 D9 is absolute, and the copy already honours it

> **An invite carries no key material of any kind. There is no column to put it in.**
> — `server/prisma/schema.prisma`, the `Invite` model

`Invite` holds: `id` (an HKDF of the code), `verifier` (a hash), `wrapSalt`, `epoch`, `createdBy`,
`expiresAt`, `usedAt`, `revokedAt`. Nothing else. Decision D9 removed `wrappedKeys` from the
ADR 002 §7.1 sketch, and the schema comment records the removal so it cannot come back quietly.

**What that buys, exactly:** a leaked invitation e-mail is a leaked *membership offer*. Whoever
holds it can join the circle if it has not been used and has not expired — and will then see
whatever is shared from that moment on. It is **never** sufficient, by itself, to read one word
of family content, because the family keys are wrapped to a joiner's device key by an existing
member's device, after the redemption, over an authenticated request.

**Three rules the copy must obey, and one sentence to delete on sight:**

1. **Never describe the code as a key, a password, or a login.** It authorises membership. If the
   copy calls it a key, a reader who loses the e-mail believes she has lost her data, and a
   reader who forwards it believes she has forwarded nothing.
2. **Never put anything beside the code that would make the pair sufficient.** No exported backup
   file, no passphrase, no recovery sheet, no `.lzp-backup` attachment. The DMG and the code are
   safe together; the *backup file* and its passphrase are not, and they travel by different
   roads for that reason (D8).
3. **Never promise that a stolen code is harmless.** It is not: it is one seat in the circle,
   until it is revoked or used. The honest sentence is *„Der Code gilt genau einmal und sieben
   Tage lang"* — which the shipped copy already implies through `circleErrInviteUsed` and
   `circleErrInviteInvalid`, and which the e-mail may state outright.

The one thing to delete on sight is any variant of *„mit diesem Code kannst du auf unsere
Termine zugreifen"* — a code does not access anything, it joins. The current German copy says
*„den Code einsetzen, Namen und eine Farbe aussuchen. Das war's, du bist dabei"*, which is right.

### 2.3 Two defects in the shipped e-mail, measured, not suspected

Both were found by running the shipped join parser
(`src/js/family/createjoin.js#parseInvitePaste`) over the shipped e-mail files. Both are
reproduced by `node scripts/mom-test-probe.mjs`. Both are **in the artefacts, not in the parser**,
and neither is mine to fix — they are recorded here so the Mom test does not spend itself
discovering them.

#### E-1 · The German word „Mail-Anbieter" is a valid invitation code, and it wins

`parseInvitePaste` reads a whole pasted invitation and prefers *a token shaped `XXXX-XXXX-XXXX`*
over a bare twelve-character word. Its own comment argues that prose cannot win, because "a word
is not a token that normalises to exactly twelve". A German hyphenated compound can be:

```
„Mail-Anbieter"  →  crockNormalize  →  MA11ANB1ETER   (12 characters, all Crockford, one hyphen)
```

It appears in the shipped German mail in the paragraph *„Manche Mail-Anbieter filtern
.dmg-Dateien heraus"*, which sits **above** the code block. First match wins, so:

```
$ node scripts/mom-test-probe.mjs
  FAIL  M1-de.txt   the field fills with "MA11-ANB1-ETER" — a COMPLETE code that was never minted
  FAIL  M1-de.html  the field fills with "MA11-ANB1-ETER"
```

**Why this is the bad kind of failure.** The field looks correct. Twelve characters, three groups,
uppercase. The *Beitreten* button lights up. The relay answers `invite_invalid`, and
`circleErrInviteInvalid` then tells her, in good German, *„Vielleicht ist ein Zeichen vertippt"* —
about a character she never typed. She will try again, more carefully, and get the same sentence.

**The fix is one word in the e-mail** (`Mail-Programme`, `E-Mail-Anbieter` — anything that is not
twelve Crockford characters with a hyphen in it), and it is proved in §5.2's control. A second,
independent fix belongs to whoever owns `createjoin.js`: prefer the token that follows the words
the mail uses to introduce the code. Neither file is this work package's.

#### E-2 · The e-mail carries no relay address, and the parser takes the download host instead

`submitJoin` refuses without a server origin and says:

> „In der Einladung stand auch eine Serveradresse. Füge sie mit ein oder trag sie unten ein."

**That sentence is not true of the shipped e-mail.** There is no relay placeholder among the four.
The only URL in the mail is `{{RELEASE_URL}}` — the GitHub Releases fallback — and it appears
*before* the code. `parseInvitePaste` takes the first URL it finds, so pasting the whole
invitation fills the *Server* field with the download host:

```
  FAIL  M2-de.txt   origin = "https://github.com", which is the DOWNLOAD host, not the relay
```

and the screen then reassures her: *„Server aus der Einladung übernommen: https://github.com"*.

**What she meets:** either a *Server* field she has to fill with a URL nobody sent her, or a
confidently wrong one. Story 15.3's minute is gone either way, and the code comment that designed
this field says exactly why — *"asking her to find and type a URL is the registration form
wearing a hat"*.

**The fix has two parts, both in the e-mail:** add the relay address, and put it **before** the
Releases link. The ordering is load-bearing and it is proved in §5.2: repairing only the word, or
adding the address only below the download link, leaves `M2` red.

#### E-3 · How the relay address must be written (a rule, not a defect)

`parseInvitePaste` matches `https?:\/\/[^\s"'<>]+` and hands the match to `new URL`. That
character class stops at whitespace, ASCII quotes and angle brackets, **and at nothing else**. So
German sentence punctuation becomes part of the host — and the result is not a parse error, which
is what makes it dangerous:

| written as | origin the app takes | what she sees |
|---|---|---|
| on its own line, bare | `https://…vercel.app` | ✅ correct |
| with a trailing slash | `https://…vercel.app` | ✅ correct |
| inside `<angle brackets>` | `https://…vercel.app` | ✅ correct |
| ending a sentence: `… ist https://…vercel.app.` | `https://…vercel.app.` | ❌ „Keine Verbindung zum Server" |
| followed by a comma | `https://…vercel.app,` | ❌ same |
| inside German quotes: `„https://…vercel.app“` | `https://…vercel.xn--app-5o0a` | ❌ same, via punycode |

`normalizeOrigin` accepts all six — they are https, they carry no path, no query, no credentials —
so nothing refuses the damaged ones. The failure surfaces one screen later as `circleErrOffline`,
which blames the connection for a spelling mistake in an e-mail.

**Rule for the invitation: the address stands alone on its own line, bare or in angle brackets,
and never ends a German sentence.** `scripts/mom-test-probe.mjs` rows `R01`–`R06` are the
reference table.

---

## 3. The install path on a clean Mac — walked as a stranger

D1 shipped **unsigned**. This section is the single most likely place the Mom test fails, and all
of it happens before the app has drawn one pixel.

### 3.1 What actually stands between her and the first pixel

| # | moment | what exists today |
|---|---|---|
| 1 | the mail arrives with a `.dmg` attachment | ~15 MB budget (22.1); a real DMG was built and mounted at **1.46 MiB** without the Tauri payload |
| 2 | she double-clicks it; a Finder window opens | icon left, `Applications` symlink right, background art at 660×420 — **the Finder layout has never been seen**: the authoring machine is refused Apple events to Finder (`-1743`), so the built DMG has no `.DS_Store` and opens unstyled |
| 3 | she drags the icon onto the blue folder | the symlink is named exactly `Applications`, which macOS displays as **„Programme"** in a German session. This is why it must not be renamed |
| 4 | she double-clicks the app in Programme | **macOS refuses it.** Unsigned, quarantined, macOS 15+ |
| 5 | she goes to Systemeinstellungen → Datenschutz & Sicherheit → „Dennoch öffnen" | Apple's own wording, `support.apple.com/de-de/102445` |
| 6 | the alert returns with „Öffnen"; the Mac asks for her password or Touch ID | done, and never again for this app |

### 3.2 The in-app unlock screen does not appear, and that is deliberate

LZP-106's guided screen exists, is tested (`tests/tier2/firstrun-unlock.dom.js`, 20/20 in a real
WKWebView, DE and EN, no external asset, no inline script), and **never fires on a real install.**

It asks the native host one question — `gatekeeper_status` — and shows nothing unless the answer
is a documented yes. Verified again at this commit:

```
$ grep -rn "gatekeeper_status" shell-macos/main.swift src-tauri/src/lib.rs
(no output)
```

The command exists in neither shell. `probeHost()` therefore returns `supported: false`, and
`supported: false` never shows the screen. E1-VERIFICATION §4 states the judgement behind leaving
it that way, and it is sound: the signal is the `com.apple.quarantine` flag word, its semantics
can only be confirmed against a build macOS has genuinely refused, and writing it blind risks the
one failure that would actually damage the product — greeting a *healthy* launch with a security
screen.

**Consequence for the test: while macOS is blocking the app, the app is not running, so nothing
inside it can be on screen.** That is a fact about macOS, not a gap in the work.

### 3.3 So exactly one surface reaches her before the dialog does

Three surfaces were designed for this moment. Two of them cannot reach her here:

| surface | reaches her before the dialog? |
|---|---|
| the in-app unlock screen (LZP-106) | **no** — the app is not running, and `gatekeeper_status` is unimplemented |
| Settings → „Wenn sich die App nicht öffnet" | **no** — same reason; it is the *afterwards* surface |
| `build/dmg/Bitte zuerst lesen.html` on the disk image | **no — it is not on the disk image.** `scripts/make-dmg.sh` stages two items, the app and the `Applications` symlink; verified by reading the script. The file is built and asset-free and sits in `build/dmg/` |
| **step 3 of the invitation e-mail** | **yes. Only this one.** |

**Step 3 of the e-mail is therefore a single point of failure for the whole install.** If she
skims it, or reads the mail on her phone and does the install later from memory, she meets an
unexplained security refusal with nothing to read.

Two cheap mitigations, both outside this work package, both worth deciding before the test:

- place `Bitte zuerst lesen.html` on the DMG as a third item — `docs/v2/invitation-email.md` §8.2
  has the options and the recommendation is to do it on the first CI run that produces a real DMG,
  which is also the first moment anyone can look at the Finder layout at all;
- or send step 3 again, on its own, as a second short message timed for when she sits down.

### 3.4 The words she sees, and the words we wrote

Apple's German label is **„Dennoch öffnen"**, and it agrees across the unlock screen, `i18n.js`,
the DMG art and all four e-mail files (LZP-106 verified this string by string).

Two wordings are **not** verified against a real blocked build, and the test is the first chance
to settle them. Photograph both dialogs:

1. the **first** refusal — the e-mail says the buttons are *„Fertig"* and *„In den Papierkorb"*;
2. the **second** alert, after „Dennoch öffnen" — the in-app illustration draws
   *„In den Papierkorb"* and *„Öffnen"* and the sentence *„Diese Software benötigt eine
   Bestätigung."*

If macOS 15.x on her machine words either differently, the e-mail and the screen are both wrong in
the same place, and a photograph is the only way anyone will know.

---

## 4. Join, then the first shared entry (15.3)

### 4.1 The flow as designed

1. Settings → *Familienkreis beitreten*.
2. One big field. Paste the whole invitation: the code and the server address are lifted out of it.
3. Name and colour.
4. *Beitreten* → **she is immediately a member.** The code redeems, her device key is published,
   the member list shows her.
5. Her board enters D9's waiting state, in one line:
   > „Die gemeinsamen Einträge erscheinen von selbst, sobald ein anderer Mac im Kreis das nächste
   > Mal abgleicht."
   > „Bis dahin bleibt dein Board genau so, wie es ist. Du musst nichts tun und niemanden fragen."
6. Any other member's Mac syncs, wraps the keys, and the shared entries appear:
   „Die gemeinsamen Einträge sind da."

Step 5 is the price of D9 and the copy states it rather than hiding it. It is **not** phrased as
an error and it does **not** tell her to ask anyone to open a laptop. For the test this matters
practically: **have the PO's Mac awake and syncing**, or the honest waiting state will be the
whole of what she sees, and the test will measure the wrong thing.

### 4.2 Where she can stumble — every case checked against the shipped parser

Measured by `node scripts/mom-test-probe.mjs`. `crockNormalize` folds case, maps `I`/`L` → `1` and
`O` → `0`, and strips `-`, space, non-breaking space and tab.

| she does | what the app does | verdict |
|---|---|---|
| pastes with a **trailing space** | stripped; code accepted | fine |
| leading **and** trailing whitespace | stripped | fine |
| triple-clicks, so a **newline** comes along | stripped | fine |
| types it in **lower case** | folded up | fine |
| uses **spaces instead of hyphens** | stripped | fine |
| **non-breaking spaces** from an HTML mail | stripped (` ` is in the set) | fine |
| pastes it inside **German quotation marks** `„…"` | quotes are token separators; code found | fine |
| types **O for 0** or **I for 1** | folded to `0` / `1` — Crockford's whole point | fine |
| pastes one character **too many** | the 13th is dropped, the code is right | fine, silently |
| pastes it inside a **forwarded sentence** | found | fine |
| **en-dash or em-dash** instead of hyphen (text substitution, WhatsApp, a retyped code) | **no code found.** The button stays disabled; *Beitreten* answers „Der Code ist noch nicht vollständig — es sind zwölf Zeichen." | honest, and she will not know what to change |
| a **soft hyphen** from a line wrap, or a **zero-width space** from an HTML mail | same — no code found, no visible reason | honest, invisible |
| types **U** for a V (`U` is not in Crockford's alphabet) | the character is dropped; the field shows eleven | honest, looks like a lost keystroke |
| an **expired** code (older than 7 days) | relay `invite_invalid` → „Dieser Code passt nicht. Vielleicht ist ein Zeichen vertippt — oder er ist älter als sieben Tage. Lass dir am besten einen neuen schicken." | good: names both causes |
| a code somebody **already used** | relay `invite_used` → „Dieser Code ist schon eingelöst. Jeder Code gilt genau einmal" | good: the distinction is deliberate |
| a **colour somebody already has** | `colorRef/taken` → „Diese Farbe hat schon jemand im Kreis. *X* ist frei — nimmst du die?" | good: offers the fix |
| the **circle is full** (8 live members) | `space_full` | not reachable in a two-person test |
| **no connection** | „Keine Verbindung zum Server. Dein Board bleibt unverändert; später geht es weiter." | good |
| pastes the **whole shipped German e-mail** | fills in `MA11-ANB1-ETER` and `https://github.com` | **§2.3 E-1 and E-2. Fix before the test.** |

### 4.3 The right code on the wrong screen

**The invite code and the device-pairing code are the same shape**: twelve Crockford characters in
groups of four (`INVITE_UI.codeChars = 12`, `PAIR_UI.codeChars = 12`). Nothing about the string
tells them apart, and the two entry points sit in the same Settings sheet:

- **„Familienkreis beitreten"** — where her invitation code goes;
- **„Meine Geräte" → „Ich habe einen Code"** — the pairing screen, for adding a *second Mac of her
  own*, whose copy reads *„Öffne LangzeitPlaner auf dem zweiten Mac … und tippe die zwölf Zeichen
  ein."*

A stranger reading "I have a code" is reading a true sentence about herself. If she takes that
door, the code is accepted by the field, derives a pairing `rid` nobody minted, and the session
simply never appears — the 180-second TTL and the 5-attempt cap do their job and she waits.

**Watch for this specifically.** If she opens the pairing screen first, that is a finding about
the *labels*, not about her, and it is one of the few things a two-person test can measure that
no suite can.

### 4.4 The first shared entry

Once the keys arrive: the PO creates an entry on his Mac, sets it to *Geteilt*, and it should
appear on hers with his colour and his initials. Then she creates one and shares it back. Watch
for whether she can find the visibility control at all — the sharing cluster in the popover
(deliverable 18) is where "what the others see" becomes a decision she has to make on purpose.

---

## 5. The instrument — `scripts/mom-test-probe.mjs`

### 5.1 What it does

```
node scripts/mom-test-probe.mjs            # human output; exit 1 if anything FAILs
node scripts/mom-test-probe.mjs --verbose  # every row, including the passes
node scripts/mom-test-probe.mjs --json     # machine-readable
```

Zero dependencies, no network, no DOM. It imports the **shipped** `parseInvitePaste` and runs it
over the **shipped** e-mail files with the placeholders filled, plus a corpus of paste damage.

It asserts one thing, and the phrasing matters:

> A paste is **honest** when it yields either exactly the minted code, or no complete code at all —
> because then the button stays disabled and `circleNeedCode` says so in one German sentence.
> A paste is **dishonest** when it yields a *complete twelve-character code that nobody minted*,
> because that is the only outcome she cannot recover from by reading: the field looks right, the
> button lights up, and the relay's refusal blames her for a typo she did not make.

Only the dishonest class FAILs. Honest-but-unhelpful outcomes are NOTE rows — real friction, not
lies. The `R01`–`R06` rows never fail: they are the reference table for how to write the relay
address, and `M2` is the row that asserts the mail actually did it.

It deliberately asserts **properties, not line numbers**: it imports two named exports and one
frozen constant, and if the module moves or an export is renamed it exits `2` with that as the
finding rather than pretending to have measured something.

### 5.2 That it can fail, and that it can pass — proved, not asserted

Every mutant below is a `tar` scratch copy under the session scratchpad. The real tree is never
mutated and `git stash` is never used.

**The honest-path control — can the probe ever go green?**

| mutant | what was changed, in the copy only | result |
|---|---|---|
| **A** | „Mail-Anbieter" → „Mail-Programme" in both German mails, **and** a bare `{{RELAY_URL}}` line added to all four mails *above every other URL* | **exit 0 · 35 rows · 27 pass · 8 note · 0 FAIL** |
| **A′** | the same word fix, but the relay line placed *below* the Releases link | `M1-de.txt`, `M1-de.html` go green; **`M2-de.txt` and `M2-en.txt` stay red** |
| **A″** | the relay line placed first, but written as `Hallo Mama — Server: https://…,` | `M2` red with `origin = "https://…vercel.app,"` — the trailing comma, which is E-3 |

A′ and A″ are why §2.3's fix is stated as *two* parts and a spelling rule rather than "add the
address": the two obvious repairs each leave the row red, for two different reasons.

**The negative controls — do the rows die when the thing they measure breaks?**

| mutant | what was broken, in the copy only | rows that died |
|---|---|---|
| **B1** | `crockNormalize` stops stripping the plain space (`src/js/core/b64.js`) | `H05` (*spaces instead of hyphens*) — **and nothing else**, because a stray space is still a token separator further down the parser. The row is measuring the exact thing it names. |
| **B2** | a live-looking code committed into `invitation.en.txt` in place of `{{EINLADUNGSCODE}}` | `M5-en.txt` (*no live invite code committed*) **and** `M1-en.txt`, which now finds a code that is not the minted one |
| **B3** | the URL match trims trailing `.,;:!?)` and German quotes | `R04`, `R05`, `R06` flip from NOTE to pass — the survival table is live, not hard-coded |

Baseline for the diffs: the unmutated copy, `35 rows · 21 pass · 8 note · 6 FAIL`, identical to
the real tree.

### 5.3 Today's output on the real tree

```
6 FAIL:  M1-de.txt   M1-de.html          the „Mail-Anbieter" collision (§2.3 E-1)
         M2-de.txt   M2-en.txt
         M2-de.html  M2-en.html          no relay address; the download host wins (§2.3 E-2)
8 note:  H09 H10 H11 H12 H14             dash and invisible-character damage; honest, silent
         R04 R05 R06                     how NOT to write the relay address (§2.3 E-3)
```

---

## 6. The script the PO runs on the day

German first, because that is the language of the room.

### 6.1 Vorbereitung (am Abend davor)

1. **`node scripts/mom-test-probe.mjs` läuft grün.** Wenn nicht: erst die E-Mail reparieren,
   dann testen. Was der Probe findet, findet sie auch — nur teurer.
2. **Ein echter Mac, der die App noch nie gesehen hat.** Kein Entwicklungsrechner, kein Konto,
   das schon einmal einen Kreis hatte, kein `~/Library/Application Support/LangzeitPlaner`.
3. **Der eigene Mac ist wach und gleicht ab** — sonst sieht sie nur den Wartezustand aus D9,
   und der Test misst etwas anderes als er soll.
4. **Ein frischer Einladungscode**, heute erzeugt. Codes gelten sieben Tage; ein alter Code
   liefert `invite_invalid`, und das ist dann ein Befund über die Vorbereitung, nicht über sie.
5. **Die E-Mail wirklich abschicken** — an ihre echte Adresse, mit Anhang. Nicht vorzeigen, nicht
   vorlesen. Der Anhang darf unterwegs verschwinden; dass er verschwindet, ist ein Befund.
6. **Ein Telefon zum Fotografieren** und dieses Blatt ausgedruckt oder auf einem dritten Gerät.

### 6.2 Die Regel, und sie ist die ganze Methode

> **Nicht helfen.**
>
> Nicht auf den Bildschirm zeigen. Nicht „scroll mal runter" sagen. Nicht die Maus nehmen.
> Nicht erklären, was gemeint ist. Nichts vorlesen, was auf dem Bildschirm steht.
>
> Erlaubt sind genau zwei Sätze: **„Was denkst du gerade?"** und **„Was würdest du jetzt tun?"**
>
> Wenn es wirklich nicht weitergeht: die Uhrzeit notieren, aufschreiben was blockiert hat, *dann*
> helfen — und in der Tabelle vermerken, dass ab hier geholfen wurde. Ein Test, in dem geholfen
> wurde, ist immer noch ein Befund; einer, in dem verschwiegen wurde dass geholfen wurde, ist
> keiner.

### 6.3 Der Ablauf

| # | was sie tun soll | was zu beobachten ist |
|---|---|---|
| 1 | Die E-Mail öffnen | Liest sie Schritt 3, **bevor** sie doppelklickt? Oder erst, wenn der Mac schon meckert? Das ist die wichtigste einzelne Beobachtung des ganzen Tests. |
| 2 | Den Anhang doppelklicken | Ist der Anhang überhaupt angekommen? Sieht das Fenster aus wie beschrieben — Symbol links, blauer Ordner rechts? |
| 3 | Auf „Programme" ziehen | Trifft sie den Ordner? Weiß sie danach, dass etwas passiert ist? |
| 4 | Die App starten | **Hier scheitert es am ehesten.** Was sagt der Mac genau? Fotografieren. Erschrickt sie? Sagt sie „das habe ich kaputt gemacht"? |
| 5 | Systemeinstellungen → Datenschutz & Sicherheit | Findet sie den Weg allein? Scrollt sie weit genug? Ist „Dennoch öffnen" überhaupt da, oder war der Startversuch zu lange her? |
| 6 | „Dennoch öffnen" → „Öffnen" → Passwort | Fotografieren. Stimmen die Wörter mit der E-Mail überein? |
| 7 | Die App ist offen | Was sagt sie als Erstes? Was probiert sie als Erstes an? |
| 8 | Einstellungen → Familienkreis beitreten | Findet sie es? Oder landet sie bei „Meine Geräte → Ich habe einen Code"? (§4.3) |
| 9 | Den Code einsetzen | **Wie** setzt sie ein: ganze Mail, nur der Codeblock, abgetippt? Fragt der Bildschirm nach einer Serveradresse? (§2.3 E-2) |
| 10 | Namen und Farbe wählen | Zögert sie bei der Farbe? Versteht sie, dass die Farbe sie ist? |
| 11 | „Beitreten" | Was steht danach auf dem Board? Versteht sie den Wartezustand als „läuft" und nicht als „kaputt"? |
| 12 | Warten, bis die gemeinsamen Einträge da sind | Wie lange dauert es wirklich? Merkt sie, dass sie da sind? |
| 13 | Selbst einen Eintrag anlegen | Traut sie sich? Findet sie den Tag? |
| 14 | Diesen Eintrag teilen | Findet sie die Sichtbarkeit im Popover? Versteht sie den Unterschied Privat / Belegt / Geteilt? |

### 6.4 Danach — drei Fragen, wörtlich mitschreiben

1. „Was war die unangenehmste Stelle?"
2. „Gab es einen Moment, in dem du dachtest, du hast etwas falsch gemacht?"
3. „Würdest du das noch mal machen, wenn ich dir morgen den zweiten Mac schicke?"

---

## 7. The observation sheet

Copy this table into the run and fill it in while it happens, not afterwards.

```
Datum ............................  Uhrzeit Start ..........  Ende ..........
Mac (Modell / macOS-Version) ...................................................
Sprache des Systems .......................  Mail-Programm ......................
Einladungscode erzeugt am .................  E-Mail gesendet um .................
Anhang angekommen?  ja / nein / gefiltert
Geholfen wurde ab Schritt .......  weil ........................................
```

| Schritt | Zeit | was passiert ist | was sie gesagt hat | Befund? |
|---|---|---|---|---|
| 1 E-Mail gelesen | | | | |
| 2 DMG geöffnet | | | | |
| 3 auf Programme gezogen | | | | |
| 4 Start → Blockade | | | | |
| 5 Systemeinstellungen gefunden | | | | |
| 6 „Dennoch öffnen" → „Öffnen" | | | | |
| 7 App zum ersten Mal offen | | | | |
| 8 Beitritts-Bildschirm gefunden | | | | |
| 9 Code eingesetzt | | | | |
| 10 Name + Farbe | | | | |
| 11 beigetreten | | | | |
| 12 gemeinsame Einträge da (nach … min) | | | | |
| 13 eigener Eintrag | | | | |
| 14 geteilt | | | | |

**Fotos, die gebraucht werden:** die erste Blockade-Meldung · der „Dennoch öffnen"-Bereich in den
Systemeinstellungen · die zweite Meldung mit „Öffnen" · das DMG-Fenster im Finder (wegen der nie
gesehenen Layouts, §3.1) · der Beitritts-Bildschirm mit dem, was sie eingesetzt hat.

**Where the result goes.** Fill in §9 of this file, and open one register row per stumble in
`docs/v2/FINDINGS.md` with the step number and the photograph. A stumble without a row is a
stumble that will still be there for the next person.

---

## 8. What the test is *not* for

Everything below is already known to be broken or absent. Finding it again on Mom's afternoon is
a waste of the one thing this test has that nothing else does.

| known | where it is written |
|---|---|
| the Finder layout of the DMG has never been seen by anybody | E1-VERIFICATION §3 (LZP-107); this machine is refused Apple events to Finder |
| `Bitte zuerst lesen.html` is not on the disk image | `scripts/make-dmg.sh` stages two items |
| the in-app unlock screen never fires (`gatekeeper_status` unimplemented in both shells) | E1-VERIFICATION §4, re-verified by grep at this commit |
| the German mail's „Mail-Anbieter" collision | §2.3 E-1 |
| the mail carries no relay address | §2.3 E-2 |
| the relay's own address does not exist yet — no Vercel project, no Prisma database | E1-VERIFICATION §7, `docs/v2/RUNBOOK.md` §2 |
| `server/prisma/migrations/` does not exist, so the first deploy creates no tables | E2-VERIFICATION §7.2, RUNBOOK §2.4 |
| the 21.3 Datenschutz text is not in the product — „Frankfurt", „Vercel" and „Prisma" appear nowhere in `src/` | LZP-1001, still open |
| the real relaunch after an update has never been performed | E1-VERIFICATION §3 (LZP-103) |

**The relay is the hard prerequisite.** Steps 8–14 of §6.3 cannot happen at all until §2 of the
runbook has been done once. Steps 1–7 — the install, which is the half D1 made harder — can be run
today, and are worth running today on their own.

---

## 9. Result — TO BE FILLED IN BY THE PO

```
Test durchgeführt am: ..............................................  ☐ nicht durchgeführt
Teilnehmerin: ......................................................
Unassistiert bis Schritt: ..........................................
Installiert ohne Hilfe:  ja / nein
Beigetreten ohne Hilfe:  ja / nein
Ersten gemeinsamen Eintrag gesehen nach: ...........................
```

**Stumbles found:**

| # | Schritt | was gestolpert ist | FINDINGS-Zeile | Ticket |
|---|---|---|---|---|
| | | | | |

**Verdict on 22.1 / 22.2 / 15.3:**

---

> **STATUS OF LZP-1006 AT THE TIME OF WRITING: OUTSTANDING.**
>
> The kit is complete. The test has not been run, cannot be run by the author of this file, and
> is not claimed. It belongs to the PO and to his mother, and the acceptance criterion is her
> afternoon.
