// tests/tier1/createjoin.test.js — LZP-1006, the join half. Story 15.3 · PO decision D9.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ONE PROPERTY, AND WHY IT IS A PROPERTY AND NOT A LIST OF CASES
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The Mom test's premise is a stranger, one e-mail, and nobody to ask. In that room there is
// exactly one outcome she cannot recover from by reading, and `scripts/mom-test-probe.mjs` names
// it in its own header: **a complete twelve-character code that was never minted.** The field
// looks right, „Beitreten" lights up, one redemption attempt is spent, and the relay's answer —
// „Vielleicht ist ein Zeichen vertippt" — blames her for a character she never typed.
//
// Everything else is friction. A refusal is friction. „Der Code ist noch nicht vollständig" is
// friction. Those cost her a minute; the wrong complete code costs her the belief that she did
// it right, which is the only thing this screen has.
//
// So the rows below are one property with a corpus behind it:
//
//   ██ `parseInvitePaste` NEVER ANSWERS WITH TWELVE CHARACTERS UNLESS THE TEXT CARRIES ██
//   ██ EVIDENCE FOR THEM: the field was SHAPED like a code, the sender LABELLED it in     ██
//   ██ words, or it stood in the CANONICAL GROUPING.                                      ██
//
// and the corpus is not invented: §2 and §3 run over the shipped invitation's own words and its
// two plain-text files verbatim, and §2d generalises them into 20 000 generated pastes.
//
//   §1  the shape gate — what a code alone in the field may look like, and what it may not
//   §2  ██ THE SHIPPED INVITATION'S OWN WORDS — six real decoys, and 20 000 generated pastes ██
//   §3  the whole invitation, pasted — and what a LABEL is allowed to decide (E-1d)
//   §4  `'partial'` is a promise about LENGTH, because the caller reads it as a code
//   §5  the address: a relay is a bare origin, and the download link is not one
//   §6  the refusal sentences — German first, they name the line to copy, and D9 holds
//   §7  five mutants, each naming the row that dies, and the honest-path control
//
// ── WHAT THIS FILE DOES NOT ASSERT ───────────────────────────────────────────────────────────
//
// Not the DOM. The `<input>` strips newlines, the `paste` event carries the original string, and
// `readFrom(raw, deliberate)` decides when a sentence appears — all three are the real engine's
// and are `tests/tier2/join-paste.dom.js`'s. This file is the pure function.
//
// Not the bytes on disk. `tests/tier1/suite-integrity.test.js` bans `node:fs` here by name, so
// the copy below is inlined and `scripts/mom-test-probe.mjs` is what reads the four shipped
// files. §2's header says which claim each of the two carries.
//
// Not whether a code exists on any relay. D9: an invitation carries an address and a code and
// neither is key material, and §6 asserts that no sentence this module produces says whether a
// code was ever minted, expired, or was already used.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseInvitePaste, formatInviteCode, inviteCodeChars, newInviteCode,
  pasteRefusalSentence, pasteOriginSentence, INVITE_UI,
} from '../../src/js/family/createjoin.js';
import { CROCKFORD_ALPHABET } from '../../src/js/core/b64.js';

/** The fixture `scripts/mom-test-probe.mjs` uses, so a failure here reads the same way there. */
const MINTED = 'J17Z-XSXN-7CSQ';
const RELEASE_URL = 'https://github.com/OWNER/REPO/releases/latest';
const RELAY = 'https://lzp-sync-po.vercel.app';

const N = INVITE_UI.codeChars;

/**
 * ██ THE DISHONEST CLASS, IN ONE PREDICATE ██ — everything in this file is written against it.
 *
 * `submitJoin` asks exactly one question of `view.code` before it spends a redemption:
 * `inviteCodeChars(view.code).length !== INVITE_UI.codeChars`. So "twelve characters came back"
 * IS "the button is enabled and the relay will be asked", whatever `found` says about it.
 */
const isCompleteCode = (p) => inviteCodeChars(p.code).length === N;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE SHAPE GATE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · a code alone in the field is a code only when it is written as one', () => {
  test('§1a · the three spellings a minted code arrives in are all read', () => {
    // Derived from INVITE_UI so this row moves with the parameter and not with a literal.
    const groups = [];
    for (let i = 0; i < N; i += INVITE_UI.codeGroup) groups.push(MINTED.split('-').join('').slice(i, i + INVITE_UI.codeGroup));
    for (const [what, raw] of [
      ['as minted', groups.join('-')],
      ['spaces for hyphens', groups.join(' ')],
      ['no separators at all', groups.join('')],
      ['lower case', groups.join('-').toLowerCase()],
      ['leading and trailing whitespace', `\n   ${groups.join('-')}  \t\n`],
      ['non-breaking spaces', groups.join(' ')],
      ['en dashes (macOS text substitution)', groups.join('–')],
      ['a soft hyphen inside a group', `${MINTED.slice(0, 6)}­${MINTED.slice(6)}`],
      ['German quotation marks around it', `„${MINTED}“`],
      ['a full stop after it', `${MINTED}.`],
    ]) {
      const p = parseInvitePaste(raw);
      assert.equal(p.code, MINTED, `${what}: ${JSON.stringify(raw)} → ${JSON.stringify(p.code)}`);
      assert.equal(p.found, 'code', what);
    }
  });

  test('§1b · ██ a WORD alone in the field is refused, however legal its letters ██', () => {
    // DEFECT E-1b. Step 0 used to ask `codeToken` alone — "does the whole field normalise to
    // twelve Crockford characters" — and every one of these answered yes. Three of the four
    // stand in the shipped German invitation, and the fourth is a circle name typed on the
    // wrong screen. Each produced a COMPLETE code, an enabled button and one spent redemption.
    for (const [word, wasBecoming] of [
      ['Mail-Anbieter', 'MA11-ANB1-ETER'],       // four-and-eight, the E-1 decoy by name
      ['Installation', '1NST-A11A-T10N'],        // twelve unbroken, I·L·O substituted
      ['Applications', 'APP1-1CAT-10NS'],        // twelve unbroken, L·O substituted
      ['Familie Weber', 'FAM1-11EW-EBER'],       // a circle NAME, on the join screen
      ['MAIL-ANBIETER', 'MA11-ANB1-ETER'],
      ['mail-anbieter', 'MA11-ANB1-ETER'],
      ['Mail–Anbieter', 'MA11-ANB1-ETER'],  // the same word after text substitution
    ]) {
      const p = parseInvitePaste(word);
      assert.equal(isCompleteCode(p), false,
        `${JSON.stringify(word)} still becomes the complete code ${JSON.stringify(p.code)} `
        + `(it used to be ${wasBecoming}) — the button lights up on a word`);
      assert.equal(p.found, 'none', word);
      assert.equal(p.codeIssue, 'absent', word);
    }
  });

  test('§1c · the unbroken shape pays for itself: no substitution, or no code', () => {
    // `XXXXXXXXXXXX` carries no separator evidence at all, so the alphabet has to carry it. A
    // minted code needs no substitution — `crock32` never emits I, L, O or U — and a word does.
    assert.equal(parseInvitePaste('J17ZXSXN7CSQ').code, MINTED, 'a real code, unbroken, is read');
    for (const word of ['INSTALLATION', 'Applications', 'installation']) {
      assert.equal(parseInvitePaste(word).found, 'none', `${word} needed I/L/O substituted`);
    }
    // …and the forgiveness for a retyped O or I is KEPT where separators carry the evidence.
    assert.equal(parseInvitePaste('JI7Z-XSXN-7CSQ').code, MINTED, 'O/I substitution, grouped');
    assert.equal(parseInvitePaste('JI7Z XSXN 7CSQ').code, MINTED, 'O/I substitution, spaced');
  });

  test('§1d · a line the mail client wrapped AT a separator is read; one wrapped INSIDE is not', () => {
    // Crockford holds no dash of any kind, so a hyphen with whitespace beside it can only ever
    // have been a separator a 72-column wrap split. That is evidence. A break inside a group is
    // not evidence of anything, and stays refused even though a person can see what she meant.
    for (const raw of [`${MINTED.slice(0, 10)}\n${MINTED.slice(10)}`,
      `${MINTED.slice(0, 10)}\n   ${MINTED.slice(10)}`,
      `${MINTED.slice(0, 9)}\n-${MINTED.slice(10)}`]) {
      assert.equal(parseInvitePaste(raw).code, MINTED, `wrapped at the separator: ${JSON.stringify(raw)}`);
    }
    const inside = `${MINTED.slice(0, 7)}\n${MINTED.slice(7)}`;
    assert.equal(parseInvitePaste(inside).found, 'none',
      'a break INSIDE a group was reassembled — that is a guess, not evidence');
  });

  test('§1e · every code this product can mint survives its own parser, 400 of them', () => {
    // The formatter, the shape gate and the generator have to agree about what a code looks
    // like or a real invitation is refused on the day it is used. 400 real codes, round-tripped
    // in all three spellings.
    for (let i = 0; i < 400; i++) {
      const code = newInviteCode();
      assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      const bare = inviteCodeChars(code);
      for (const raw of [code, bare, bare.match(/.{4}/g).join(' '), code.toLowerCase()]) {
        const p = parseInvitePaste(raw);
        assert.equal(p.code, code, `a minted code was not read back: ${JSON.stringify(raw)}`);
      }
    }
  });
});

// ── THE TWO PLAIN-TEXT INVITATIONS, INLINED VERBATIM ────────────────────────────────────────
//
// `docs/v2/email/invitation.de.txt` and `.en.txt` with the four `{{…}}` placeholders filled, as
// `scripts/mom-test-probe.mjs` fills them. Inlined for the reason §2's header gives — a tier-1
// file may not import `node:fs`, and the gate that says so is not weakened for convenience — so
// the two HTML files, and the byte-exact check that these two copies are still the shipped ones,
// belong to the probe. A drift shows up there as a `M1` row, one command before the Mom test.

const MAIL_DE = (code) => `Betreff: Hier ist der Kalender für deinen Mac


Hallo Mama,

hier ist der Kalender, von dem ich erzählt habe. Ein ganzes Jahr auf
einer Fläche, jeder Monat eine Spalte. Man klickt auf einen Tag und
schreibt drauf, so wie auf einem Whiteboard in der Küche.

Im Anhang liegt eine Datei namens LangzeitPlaner.dmg. Das Installieren dauert
zwei Minuten.


-------------------------------------------------------------------------
 1   Die Datei im Anhang doppelklicken
-------------------------------------------------------------------------

     Es geht ein Fenster auf: links das Kalender-Symbol, rechts ein blauer
     Ordner, dazwischen ein Pfeil.


-------------------------------------------------------------------------
 2   Das Kalender-Symbol auf den blauen Ordner ziehen
-------------------------------------------------------------------------

     Der Ordner heißt „Programme" (falls dein Mac auf Englisch
     eingestellt ist: „Applications"). Symbol mit der Maus rüberziehen,
     loslassen — das war die Installation. Das Fenster kannst du danach
     zumachen.


-------------------------------------------------------------------------
 3   Starten — und einmal eine Sicherheitsmeldung wegklicken
-------------------------------------------------------------------------

     Das hier schreibe ich dir vorher auf, damit du nicht erschrickst:

     Beim allerersten Start sagt der Mac: „Apple konnte nicht überprüfen,
     ob ‚LangzeitPlaner' frei von Schadsoftware ist." Und er lässt die App
     zunächst nicht starten.

     Das ist keine Fehlermeldung, und kaputt ist auch nichts. Der Mac kennt
     die App nur nicht, weil ich sie nicht offiziell bei Apple angemeldet
     habe. Du musst ihm einmal sagen, dass sie in Ordnung ist:

     a)  Doppelklick auf LangzeitPlaner. Die Meldung kommt.
         Auf „Fertig" klicken — NICHT auf „In den Papierkorb".

     b)  Apple-Menü (das Apfel-Symbol ganz oben links)
         -> Systemeinstellungen -> Datenschutz & Sicherheit.
         Dort ganz nach unten scrollen, bis „Sicherheit" kommt. Da steht
         jetzt „LangzeitPlaner wurde blockiert, um deinen Mac zu schützen."
         und daneben ein Knopf „Dennoch öffnen". Draufklicken.

     c)  Die Meldung kommt noch einmal — diesmal mit einem Knopf
         „Öffnen". Draufklicken. Dann fragt der Mac nach deinem Passwort
         oder dem Fingerabdruck.

     Fertig. Ab jetzt startet der Kalender wie jedes andere Programm, und
     diese Meldung kommt nie wieder.


FALLS DER ANHANG FEHLT

Manche Mail-Anbieter filtern .dmg-Dateien heraus. Wenn oben also gar keine
Datei hängt, lade sie hier herunter — es ist genau dieselbe:

    ${RELEASE_URL}


DEIN EINLADUNGSCODE

    ${code}

In der App: Einstellungen -> „Familienkreis beitreten", den Code einsetzen,
Namen und eine Farbe aussuchen. Das war's, du bist dabei.

Eine Sache noch, damit du nicht wartend davorsitzt: Die gemeinsamen
Termine sind direkt nach dem Beitreten noch nicht da. Sie kommen von
allein, sobald sich ein anderer Mac aus der Familie das nächste Mal
meldet — meistens innerhalb eines Tages. Du musst dafür nichts tun und
niemanden erinnern. Dein eigener Kalender läuft von der ersten Minute an
ganz normal; du kannst sofort alles eintragen, was du willst.

Und wenn du ihn erst einmal lieber nur für dich nutzen möchtest: Code
einfach weglassen. Dann läuft er komplett für sich allein, ohne Internet.


ZWEI SÄTZE, DIE DICH VIELLEICHT INTERESSIEREN

Was du für dich einträgst, bleibt auf deinem Mac — der Kalender selbst
geht damit nicht ins Internet. Ausgetauscht werden nur die Termine, die
wir ausdrücklich miteinander teilen, und die sind verschlüsselt unterwegs.
Einmal am Tag fragt die App außerdem kurz nach, ob es eine neuere Version
gibt, und installiert sie beim nächsten Start von selbst — du bekommst
deswegen nie wieder eine E-Mail und musst nie wieder etwas herunterladen.

Wenn irgendwas klemmt: ruf einfach an.

Manuel
`;

const MAIL_EN = (code) => `Subject: Here's the calendar for your Mac


Hi Mama,

here's the calendar I told you about. A whole year on one surface, one
column per month. You click on a day and write on it, the way you would
on a whiteboard in the kitchen.

Attached is a file called LangzeitPlaner.dmg. Installing takes two minutes.


-------------------------------------------------------------------------
 1   Double-click the attachment
-------------------------------------------------------------------------

     A window opens: the calendar icon on the left, a blue folder on the
     right, an arrow in between.


-------------------------------------------------------------------------
 2   Drag the calendar icon onto the blue folder
-------------------------------------------------------------------------

     The folder is called "Applications" (on a Mac set to German it is
     called "Programme"). Drag the icon across with the mouse and let go
     — that was the installation. You can close the window afterwards.


-------------------------------------------------------------------------
 3   Launch it — and dismiss one security warning
-------------------------------------------------------------------------

     I'm writing this down in advance so it doesn't startle you:

     The very first time you open it, your Mac will say: "Apple could not
     verify that 'LangzeitPlaner' is free of malware." And it refuses to
     start the app.

     That is not an error message, and nothing is broken. Your Mac simply
     doesn't know this app, because I haven't officially registered it
     with Apple. You have to tell it once that the app is fine:

     a)  Double-click LangzeitPlaner. The message appears.
         Click "Done" — NOT "Move to Trash".

     b)  Apple menu (the apple at the very top left)
         -> System Settings -> Privacy & Security.
         Scroll all the way down to "Security". It now says
         "LangzeitPlaner was blocked to protect your Mac." with a button
         next to it, "Open Anyway". Click that.

     c)  The message comes back once more — this time with an "Open"
         button. Click it. Then your Mac asks for your password or your
         fingerprint.

     Done. From now on the calendar starts like any other app, and that
     message never comes back.


IF THE ATTACHMENT ISN'T THERE

Some mail providers strip .dmg files out. If there is no file attached
above, download it here instead — it is exactly the same one:

    ${RELEASE_URL}


YOUR INVITATION CODE

    ${code}

In the app: Settings -> "Join family circle", paste the code, pick a name
and a colour. That's it, you're in.

One more thing, so you're not sitting there waiting: the shared entries
won't be there the moment you join. They arrive on their own, as soon as
another Mac in the family next checks in — usually within a day. You don't
have to do anything for that, and you don't have to remind anyone. Your own
calendar works completely normally from the first minute; you can start
writing in it straight away.

And if you'd rather keep it to yourself for now: just leave the code out.
Then it runs entirely on its own, with no internet at all.


TWO SENTENCES YOU MIGHT CARE ABOUT

What you write down for yourself stays on your Mac — the calendar itself
doesn't go online with it. The only things exchanged are the entries we
explicitly share with each other, and those travel encrypted. Once a day
the app also quietly asks whether there's a newer version, and installs it
the next time you start it — so you'll never get another e-mail about this
and never have to download anything again.

If anything gets stuck: just call.

Manuel
`;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE SHIPPED INVITATION'S OWN WORDS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ── WHY THE FOUR FILES ARE NOT READ FROM DISK HERE, AND WHERE THEY ARE ──────────────────────
//
// `tests/tier1/suite-integrity.test.js` — „no tier-1 test reaches outside the repo or into real
// user storage" — bans `node:fs` in a tier-1 test FILE by name. That gate is not weakened to
// make this section convenient, so the corpus below is INLINED, and the byte-exact sweep over
// `docs/v2/email/invitation.{de,en}.{txt,html}` is `scripts/mom-test-probe.mjs`'s — the
// instrument LZP-1006's kit was built around, whose own header says to run it before the test
// and fix what it reports. That probe reads the real files; this file holds the property.
//
// The inlined corpus is not a guess at what is in those files. `DECOYS_12` is the COMPLETE set
// of whitespace-separated words in all four of them whose Crockford normalisation is exactly
// twelve legal characters — the only single words that could ever have become a code — extracted
// from the shipped files at the time this row was written. `DECOYS_NEAR` are the ones that come
// close enough to be truncated into one. Both are asserted for the property they were selected
// for, so a stale entry is a visible contradiction rather than a silent pass.

/**
 * ██ EVERY WORD IN THE SHIPPED INVITATION THAT NORMALISES TO TWELVE LEGAL CHARACTERS ██
 *
 * Six of them, in four files, two languages. Three are the ones `family/createjoin.js`'s own
 * docblocks name; the other three nobody had noticed. All six used to produce a COMPLETE code.
 */
const DECOYS_12 = Object.freeze([
  'Mail-Anbieter',    // „Manche Mail-Anbieter filtern .dmg-Dateien heraus" — DE, step 3's fallback
  'Installation',     // „das war die Installation" — DE
  'installation',     // „that was the installation" — EN
  'Installieren',     // „Das Installieren dauert zwei Minuten" — DE
  'Applications',     // the folder's English name, in BOTH languages' step 2
  'PLACEHOLDERS',     // the HTML files' footnote listing the four `{{…}}` names
]);

/** Longer words from the same files: twelve characters fall out of each if anything truncates. */
const DECOYS_NEAR = Object.freeze([
  'Familienkreis', 'LangzeitPlaner', 'Kalender-Symbol', 'Schadsoftware', 'Sicherheitsmeldung',
  'Systemeinstellungen', 'Datenschutz', 'Papierkorb', 'Apfel-Symbol', 'doppelklicken',
  'INTERESSIEREN', 'Whiteboard', 'erschrickst', 'davorsitzt', 'wegklicken', 'eingestellt',
  'Serveradresse', 'Einladungscode', 'gemeinsamen', 'miteinander', 'installiert', 'Doppelklick',
]);

/** The e-mail's own vocabulary, for the generated sweep. Words, not sentences: a generator that
 *  only ever produced sentences somebody wrote would test the sentences and not the rule. */
const MAIL_WORDS = Object.freeze([
  ...DECOYS_12, ...DECOYS_NEAR,
  'Hallo', 'hier', 'ist', 'der', 'Kalender', 'von', 'dem', 'ich', 'erzählt', 'habe', 'Ein',
  'ganzes', 'Jahr', 'auf', 'einer', 'Fläche', 'jeder', 'Monat', 'eine', 'Spalte', 'Man', 'klickt',
  'einen', 'Tag', 'und', 'schreibt', 'drauf', 'wie', 'einem', 'Küche', 'Anhang', 'liegt', 'Datei',
  'namens', 'dauert', 'zwei', 'Minuten', 'Fenster', 'links', 'rechts', 'blauer', 'Ordner',
  'dazwischen', 'Pfeil', 'ziehen', 'heißt', 'Programme', 'falls', 'dein', 'Mac', 'Englisch',
  'Maus', 'rüberziehen', 'loslassen', 'zumachen', 'Starten', 'einmal', 'Meldung', 'Fertig',
  'Apple', 'konnte', 'nicht', 'überprüfen', 'frei', 'Fehlermeldung', 'kaputt', 'auch', 'nichts',
  'offiziell', 'angemeldet', 'Ordnung', 'Apfel', 'Symbol', 'ganz', 'oben', 'scrollen', 'Knopf',
  'Dennoch', 'öffnen', 'Draufklicken', 'Passwort', 'Fingerabdruck', 'startet', 'Programm',
  'filtern', 'heraus', 'Wenn', 'keine', 'hängt', 'lade', 'sie', 'herunter', 'genau', 'dieselbe',
  'App', 'Einstellungen', 'beitreten', 'Code', 'einsetzen', 'Namen', 'Farbe', 'aussuchen',
  'dabei', 'Sache', 'noch', 'damit', 'wartend', 'Termine', 'direkt', 'nach', 'Beitreten',
  'kommen', 'allein', 'sobald', 'anderer', 'Familie', 'nächste', 'meldet', 'meistens', 'Tages',
  'musst', 'dafür', 'tun', 'niemanden', 'erinnern', 'eigener', 'läuft', 'ersten', 'Minute',
  'normal', 'kannst', 'sofort', 'alles', 'eintragen', 'willst', 'lieber', 'nur', 'dich',
  'nutzen', 'möchtest', 'einfach', 'weglassen', 'komplett', 'ohne', 'Internet', 'Sätze',
  'vielleicht', 'bleibt', 'geht', 'Ausgetauscht', 'werden', 'Einträge', 'teilen', 'sind',
  'verschlüsselt', 'unterwegs', 'kurz', 'neuere', 'Version', 'gibt', 'Start', 'selbst',
  'bekommst', 'deswegen', 'wieder', 'Mail', 'herunterladen', 'irgendwas', 'klemmt', 'ruf',
  'calendar', 'whole', 'year', 'one', 'surface', 'column', 'per', 'month', 'click', 'day',
  'write', 'whiteboard', 'kitchen', 'Attached', 'file', 'called', 'takes', 'two', 'minutes',
  'window', 'opens', 'icon', 'left', 'blue', 'folder', 'right', 'arrow', 'between', 'Drag',
  'onto', 'German', 'across', 'mouse', 'let', 'close', 'afterwards', 'Launch', 'dismiss',
  'security', 'warning', 'writing', 'down', 'advance', 'startle', 'very', 'first', 'time',
  'open', 'your', 'will', 'say', 'could', 'verify', 'malware', 'refuses', 'start', 'app',
  'error', 'message', 'nothing', 'broken', 'simply', 'know', 'this', 'because', 'have',
  'registered', 'with', 'tell', 'once', 'fine', 'Done', 'Move', 'Trash', 'menu', 'apple',
  'System', 'Settings', 'Privacy', 'Security', 'Scroll', 'blocked', 'protect', 'button',
  'next', 'Anyway', 'Click', 'comes', 'back', 'more', 'asks', 'password', 'fingerprint',
  'From', 'now', 'starts', 'like', 'any', 'other', 'never', 'attachment', 'providers', 'strip',
  'files', 'there', 'above', 'download', 'instead', 'exactly', 'same', 'invitation', 'code',
  'paste', 'pick', 'name', 'colour', 'youre', 'thing', 'sitting', 'waiting', 'shared',
  'entries', 'wont', 'moment', 'join', 'They', 'arrive', 'their', 'own', 'soon', 'another',
  'family', 'checks', 'usually', 'within', 'dont', 'anything', 'that', 'remind', 'anyone',
  'works', 'completely', 'normally', 'from', 'you', 'can', 'straight', 'away', 'rather', 'keep',
  'yourself', 'just', 'leave', 'out', 'Then', 'runs', 'entirely', 'internet', 'sentences',
  'might', 'care', 'about', 'What', 'stays', 'itself', 'doesnt', 'online', 'only', 'things',
  'exchanged', 'are', 'explicitly', 'each', 'those', 'travel', 'encrypted', 'Once', 'also',
  'quietly', 'whether', 'theres', 'newer', 'version', 'installs', 'youll', 'get', 'email',
  'download', 'again', 'gets', 'stuck', 'call',
]);

/** The punctuation a selection drags along, and the wrappers a mail client adds. */
const WRAPPERS = Object.freeze([
  ['', ''], ['„', '“'], ['"', '"'], ['(', ')'], ['<', '>'], ['', '.'], ['', ','], ['', ':'],
  ['', '!'], ['', '?'], ['', '…'], ['-', '-'], ['*', '*'], ['', ')'], ['', '"'],
]);

/** A small deterministic PRNG, so a failure is reproducible from its seed and not from luck. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

describe('§2 · the shipped invitation cannot produce a code by accident', () => {
  test('§2a · ██ THE SIX WORDS — none of them becomes a code, alone or wrapped ██', () => {
    // She has one e-mail and no help. A stranger who double-clicks the wrong WORD must meet a
    // refusal — never a confident, wrong, complete code, an enabled button and a spent
    // redemption whose answer blames her for a character she never typed.
    const offenders = [];
    for (const word of DECOYS_12) {
      for (const [open, close] of WRAPPERS) {
        for (const cand of [`${open}${word}${close}`, `${open}${word}${close} `,
          `\n${open}${word}${close}\n`, `${open}${word.toUpperCase()}${close}`,
          `${open}${word.toLowerCase()}${close}`]) {
          const p = parseInvitePaste(cand);
          if (isCompleteCode(p)) offenders.push(`${JSON.stringify(cand)} → ${p.code}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      'a word from the shipped invitation becomes a complete code nobody minted:\n'
      + offenders.join('\n'));
  });

  test('§2b · the corpus is real: each of the six DOES normalise to twelve legal characters', () => {
    // The compensating claim §2a owes. Without it, „no decoy wins" is satisfiable by a list of
    // words that were never dangerous — and a stale entry would pass silently for ever.
    for (const word of DECOYS_12) {
      const norm = [...word.replace(/-/g, '')].map((c) => {
        const u = c.toUpperCase();
        return u === 'I' || u === 'L' ? '1' : u === 'O' ? '0' : u;
      }).join('');
      assert.equal(norm.length, N, `${word} is not ${N} characters — this entry is stale`);
      for (const ch of norm) {
        assert.ok(CROCKFORD_ALPHABET.includes(ch), `${word} → ${norm}: ${ch} is not legal`);
      }
    }
    assert.equal(DECOYS_12.length, 6, 'the extracted set changed size — re-run the extraction');
  });

  test('§2c · the near misses do not become codes by truncation either', () => {
    const offenders = [];
    for (const word of [...DECOYS_NEAR, ...DECOYS_12]) {
      for (const cand of [word, `${word} `, `„${word}“`, `${word}.`, word.toUpperCase()]) {
        const p = parseInvitePaste(cand);
        if (isCompleteCode(p)) offenders.push(`${JSON.stringify(cand)} → ${p.code}`);
      }
    }
    assert.deepEqual(offenders, [], offenders.join('\n'));
  });

  test('§2d · ██ 20 000 GENERATED PASTES OF THE MAIL’S OWN WORDS — NOT ONE IS A CODE ██', () => {
    // Naming six decoys is a check on the six somebody thought of. This is the rule: build
    // pastes out of the invitation's own vocabulary — one word, five words, hyphenated, any
    // casing, any wrapper — with NO minted code anywhere in them, and assert that nothing ever
    // comes back complete.
    //
    // ── THE ONE EXCLUSION, AND WHY IT IS NOT A GET-OUT ──────────────────────────────────────
    //
    // The generator joins words with `-`, a space or a tab, so it sometimes synthesises
    // `ganz-nach-Code` or `join\tdein\tcode` — three four-letter runs with a separator between
    // them. That IS the spelling of a minted code, character for character; there is no further
    // evidence anywhere in the string, and a parser that refused it would refuse every real code
    // written the same way. Such a paste is therefore excluded from the claim and COUNTED, and
    // the count is asserted to be a small minority — an exclusion that quietly swallowed the
    // corpus would be a green row over nothing. `wearsCodeShape` is the exclusion, and it is the
    // same three spellings §1a asserts a real code arrives in, restated independently here.
    //
    // No word or pair of words in the shipped invitation produces that shape: §2a and §2c are
    // the rows that say so over the real vocabulary, and this row is what says the RULE holds
    // beyond the words anybody listed.
    const g = INVITE_UI.codeGroup;
    const n = N / g;
    const CANON = new RegExp(`^[0-9A-Za-z]{${g}}(?:-[0-9A-Za-z]{${g}}){${n - 1}}$`);
    const SPACED = new RegExp(`^[0-9A-Za-z]{${g}}(?: [0-9A-Za-z]{${g}}){${n - 1}}$`);
    const UNBROKEN = new RegExp(`^[0-9A-Za-z]{${N}}$`);
    const bare = (t) => t.replace(/^[^0-9A-Za-z]+|[^0-9A-Za-z]+$/g, '');
    /** Does this paste WEAR a minted code's spelling? Then it is not prose any more. */
    const wearsCodeShape = (text) => {
      if (text.split(/\s+/).some((tok) => CANON.test(bare(tok)))) return true;
      const whole = bare(text.replace(/[ \t]/g, ' ').trim().replace(/\s+/g, ' '));
      return CANON.test(whole) || SPACED.test(whole)
        || (UNBROKEN.test(whole) && [...whole.toUpperCase()].every((c) => CROCKFORD_ALPHABET.includes(c)));
    };
    const rand = rng(20260903);
    const pick = () => MAIL_WORDS[Math.floor(rand() * MAIL_WORDS.length)];
    const offenders = [];
    let excluded = 0;
    let judged = 0;
    for (let i = 0; i < 20000; i++) {
      const n = 1 + Math.floor(rand() * 5);
      const words = [];
      for (let k = 0; k < n; k++) words.push(pick());
      const sep = [' ', '-', '\n', '  ', '\t'][Math.floor(rand() * 5)];
      const [open, close] = WRAPPERS[Math.floor(rand() * WRAPPERS.length)];
      const cand = `${open}${words.join(sep)}${close}`;
      // Does the paste itself carry the code's own shape? Then it is not prose any more.
      if (wearsCodeShape(cand)) { excluded++; continue; }
      judged++;
      const p = parseInvitePaste(cand);
      if (isCompleteCode(p)) offenders.push(`i=${i} ${JSON.stringify(cand)} → ${p.code}`);
      if (offenders.length > 5) break;
    }
    assert.deepEqual(offenders, [],
      'prose built from the invitation’s own words produced a complete code:\n'
      + offenders.join('\n'));
    assert.ok(judged > 19000, `only ${judged} of 20000 pastes were judged — the exclusion ate the corpus`);
    assert.ok(excluded > 0, 'the exclusion never fired — it is describing a case that cannot happen');
  });

  test('§2e · ██ THE PAIRED CONTROL ██ — the same generator, with the code in it, always finds it', () => {
    // §2d alone is satisfiable by a parser that refuses everything. Same generator, same
    // vocabulary, same wrappers — with a real code standing under its real heading. It must be
    // found, and it must be the one that was minted, every time.
    const rand = rng(20260904);
    const pick = () => MAIL_WORDS[Math.floor(rand() * MAIL_WORDS.length)];
    for (let i = 0; i < 500; i++) {
      const code = newInviteCode();
      const before = [pick(), pick(), pick()].join(' ');
      const after = [pick(), pick()].join(' ');
      const heading = rand() < 0.5 ? 'DEIN EINLADUNGSCODE' : 'YOUR INVITATION CODE';
      const paste = `${before}\n\n${heading}\n\n    ${code}\n\n${after}\n`;
      const p = parseInvitePaste(paste);
      assert.equal(p.code, code, `i=${i}: ${JSON.stringify(paste)} → ${JSON.stringify(p.code)}`);
      assert.equal(p.found, 'code');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · THE WHOLE INVITATION, PASTED
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · the one gesture the join screen is designed around', () => {
  test('§3a · select all, copy, paste — the field fills with the code that was minted', () => {
    for (const [lang, mail] of [['de', MAIL_DE], ['en', MAIL_EN]]) {
      const p = parseInvitePaste(mail(MINTED));
      assert.equal(p.code, MINTED, `${lang}: the whole invitation yielded ${JSON.stringify(p.code)}`);
      assert.equal(p.found, 'code', lang);
    }
  });

  test('§3b · the LABEL is what wins, so the e-mail can carry decoys and still work', () => {
    // „DEIN EINLADUNGSCODE" stands above the code in all four files. That is the sender saying
    // in words which one it is, and it beats a canonical-shaped decoy standing elsewhere.
    const decoy = 'ABCD-EFGH-JKMN';
    const mail = `Manche Mail-Anbieter filtern .dmg-Dateien heraus.\n\n${decoy}\n\n`
      + `DEIN EINLADUNGSCODE\n\n    ${MINTED}\n`;
    assert.equal(parseInvitePaste(mail).code, MINTED, 'the labelled code did not win');
  });

  test('§3c · two labelled codes disagree → refuse, and say so', () => {
    const two = `Dein Einladungscode: ${MINTED}\nDein Einladungscode: ABCD-EFGH-JKMN\n`;
    const p = parseInvitePaste(two);
    assert.equal(p.found, 'ambiguous');
    assert.equal(p.code, '', 'a refusal must not leave a code in the field');
  });

  test('§3d · ██ a LABEL picks between candidates; it may not promote prose — DEFECT E-1d ██', () => {
    // Found by §2d's generator, not by naming a decoy. `CODE_LABEL_RE` also matches the bare
    // word „Code", which the shipped German copy uses twice, so any twelve-legal-character word
    // standing within `LABEL_WINDOW` of it was promoted on the strength of the label alone.
    //
    // Direction one: a wrong complete code out of prose.
    for (const raw of [
      'Dein Einladungscode steht bei der Installation',
      'invitation code is in Applications',
      'Dein Einladungscode auf Mail-Anbieter.',
      'den Code einsetzen — Familienkreis Installation',
    ]) {
      const p = parseInvitePaste(raw);
      assert.equal(isCompleteCode(p), false,
        `${JSON.stringify(raw)} → ${JSON.stringify(p.code)}: a label made a word into a code`);
    }

    // Direction two, and the worse one: a decoy standing AFTER the code, inside the window,
    // made the CORRECT paste refuse itself as ambiguous and throw the real code away.
    const good = `DEIN EINLADUNGSCODE\n\n    ${MINTED}\n\nmusst Mail-Anbieter\n`;
    assert.equal(parseInvitePaste(good).code, MINTED,
      'a decoy after the labelled code destroyed the code');

    // And what the label still does, which is all it ever knew: pick between two shaped things.
    const decoy = 'ABCD-EFGH-JKMN';
    assert.equal(parseInvitePaste(`${decoy}\n\nDein Einladungscode\n\n${MINTED}\n`).code, MINTED);
    // …including an unbroken one that needed no substitution, because that is evidence too.
    assert.equal(parseInvitePaste(`Dein Einladungscode: ${inviteCodeChars(MINTED)}`).code, MINTED);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · `'partial'` IS A PROMISE ABOUT LENGTH
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("§4 · 'partial' is the caller's permission to rewrite the field", () => {
  test('§4a · ██ a partial is NEVER twelve characters — DEFECT E-1c ██', () => {
    // `submitJoin` asks one question of `view.code`: is it twelve characters? So a `'partial'`
    // that reaches twelve IS a complete code wearing a different label — the field is rewritten,
    // „Beitreten" lights up, and a word is sent to the relay to be redeemed.
    for (const [word, wasBecoming] of [
      ['Sicherheitsmeldung', 'S1CH-ERHE-1TSM'],
      ['Systemeinstellungen', 'SYST-EME1-NSTE'],
      ['Serveradresse', 'SERV-ERAD-RESS'],
      ['Schadsoftware', 'SCHA-DS0F-TWAR'],
      ['LangzeitPlaner', '1ANG-ZE1T-P1AN'],
      ['Kalender-Symbol', 'KA1E-NDER-SYMB'],
      [`${MINTED}P`, MINTED],                 // one character too many: which one is spurious?
      ['J177Z-XSXN-7CSQ', 'J177-ZXSX-N7CS'],  // one DOUBLED, and truncation guesses wrong
    ]) {
      const p = parseInvitePaste(word);
      assert.equal(isCompleteCode(p), false,
        `${JSON.stringify(word)} yields the complete code ${JSON.stringify(p.code)} `
        + `(it used to be ${wasBecoming}) with found=${p.found}`);
    }
  });

  test('§4b · a code being TYPED still gets its groups back, so the field is not dead', () => {
    // The reason step 4 exists at all. Refusing every unfinished token would mean the groups
    // never appear while somebody types, which is the thing this screen is supposed to do.
    for (const [raw, want] of [
      ['J17Z', 'J17Z'],
      ['J17ZXS', 'J17Z-XS'],
      ['j17zxsxn7cs', 'J17Z-XSXN-7CS'],
      [`${MINTED.slice(0, -1)}U`, 'J17Z-XSXN-7CS'],   // U is not in the alphabet; 11 survive
    ]) {
      const p = parseInvitePaste(raw);
      assert.equal(p.found, 'partial', `${raw} → found=${p.found}`);
      assert.equal(p.code, want, raw);
      assert.ok(inviteCodeChars(p.code).length < N, 'a partial reached the full length');
    }
  });

  test('§4c · a paste that held TWO things is not one unfinished code — the server line', () => {
    // Every URL is blanked out of the text before the tokens are scanned, so „Server: https://…"
    // looked like ONE leftover token and the screen answered a pasted server line by replacing
    // it with `SERV-ER`. The paste held two things; `spans.length` is the half that was hidden.
    for (const raw of [
      `Server: „${RELAY}“`,
      `Serveradresse: ${RELAY}`,
      `${RELAY} Server`,
    ]) {
      const p = parseInvitePaste(raw);
      assert.equal(p.code, '', `${JSON.stringify(raw)} rewrote the field to ${JSON.stringify(p.code)}`);
      assert.equal(p.found, 'none', raw);
      assert.equal(p.origin, RELAY, 'the address in it is still read — that half was never wrong');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · THE ADDRESS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · a relay address is a bare origin, and a download link is not one', () => {
  test('§5a · the shipped invitation yields NO server address, and says which link it saw', () => {
    // DEFECT E-2, held closed. The one URL in these files is the Releases fallback for providers
    // that strip `.dmg`. Taking it would put `https://github.com` in the Server field under a
    // reassuring green sentence — a join flow silently pointed at the wrong host, which is the
    // worst failure available here because it looks like it worked.
    for (const [lang, mail] of [['de', MAIL_DE], ['en', MAIL_EN]]) {
      const p = parseInvitePaste(mail(MINTED));
      assert.equal(p.origin, null, `${lang} yielded the address ${JSON.stringify(p.origin)}`);
      assert.equal(p.originIssue, 'not_an_address', lang);
    }
  });

  test('§5b · trailing punctuation is not part of a host — DEFECT E-3', () => {
    for (const [what, raw] of [
      ['ending a German sentence', `Der Server ist ${RELAY}.`],
      ['followed by a comma', `${RELAY}, und der Code folgt.`],
      ['inside German quotation marks', `Server: „${RELAY}“`],
      ['inside angle brackets', `Server: <${RELAY}>`],
      ['with a trailing slash', `Server: ${RELAY}/`],
      ['on its own line', `Server:\n${RELAY}\n`],
      ['followed by an ellipsis', `${RELAY}…`],
    ]) {
      assert.equal(parseInvitePaste(raw).origin, RELAY, `${what}: ${JSON.stringify(raw)}`);
    }
  });

  test('§5c · two addresses and no label → refuse; two and one labelled → the labelled one', () => {
    // Both of these are BARE origins, so both are candidate addresses and nothing in the text
    // says which is the relay. A path is not ambiguity — `${RELEASE_URL}` is excluded a step
    // earlier for carrying one, which is §5a's rule and is asserted there.
    const both = `Vielleicht ${RELAY}\noder https://other.example\n`;
    const p = parseInvitePaste(both);
    assert.equal(p.origin, null, 'a guess between two addresses');
    assert.equal(p.originIssue, 'ambiguous');
    const labelled = `Herunterladen: ${RELEASE_URL}\nServer: ${RELAY}\nDein Einladungscode: ${MINTED}`;
    const q = parseInvitePaste(labelled);
    assert.equal(q.origin, RELAY, 'the labelled address did not win');
    assert.equal(q.code, MINTED);
  });

  test('§5d · a path, a query, a fragment or credentials mean it is not an address', () => {
    for (const url of [
      'https://github.com/OWNER/REPO/releases/latest',
      'https://relay.example.com/api/v1',
      'https://relay.example.com/?x=1',
      'https://relay.example.com/#top',
      'https://user:pass@relay.example.com',
      'ftp://relay.example.com',
      'javascript:alert(1)',
    ]) {
      const p = parseInvitePaste(`Adresse: ${url}`);
      assert.equal(p.origin, null, `${url} was accepted as a relay address`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · THE REFUSAL SENTENCES
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§6 · a refusal names the line of the e-mail to copy, and leaks nothing', () => {
  test('§6a · every refusal has a sentence, in both languages, and it is not a shrug', () => {
    // „Der Code ist noch nicht vollständig" is true and useless to a stranger who has just
    // pasted the wrong line: it describes the field, not the next move.
    const refusals = ['Mail-Anbieter', 'Installation', 'Familie Weber', ''];
    for (const raw of refusals) {
      const p = parseInvitePaste(raw);
      const s = pasteRefusalSentence(p);
      assert.ok(s && s.length > 60, `no usable sentence for ${JSON.stringify(raw)}: ${s}`);
      assert.match(s, /Einladungscode|invitation code/,
        'the sentence must name the heading in the e-mail she is holding');
    }
  });

  test('§6b · „mehr als eine" is said only when there IS more than one — the honest code', () => {
    // The commonest paste that lands here is the „Manche Mail-Anbieter filtern .dmg-Dateien
    // heraus" line, which carries exactly ONE decoy. Telling her there are several sends her
    // looking for a second thing that is not there.
    const one = parseInvitePaste('Manche Mail-Anbieter filtern .dmg-Dateien heraus.');
    assert.equal(one.codeIssue, 'absent', 'one decoy was reported as ambiguous');
    const two = parseInvitePaste('Mail-Anbieter und Installation stehen beide da.');
    assert.equal(two.codeIssue, 'ambiguous', 'two distinct decoys were not reported as ambiguous');
    assert.match(pasteRefusalSentence(two), /mehr als eine|more than one/);
    assert.equal(/mehr als eine|more than one/.test(pasteRefusalSentence(one)), false);
  });

  test('§6c · ██ D9 — no sentence says whether a code exists, existed or expired ██', () => {
    // An invitation carries an address and a code and neither is key material. A refusal that
    // said „diesen Code gibt es nicht" would turn this field into an oracle over the relay's
    // invite table, from a screen that needs no authentication at all.
    const banned = /gibt es nicht|existiert|abgelaufen|verfallen|unbekannt|nicht gefunden|ungültig|schon eingelöst|expired|does not exist|no such|unknown|already used|not found|invalid/i;
    const sentences = [];
    for (const raw of ['Mail-Anbieter', 'Installation', '', 'Mail-Anbieter und Installation',
      RELEASE_URL, `Server: ${RELAY}`, 'Familie Weber']) {
      const p = parseInvitePaste(raw);
      for (const s of [pasteRefusalSentence(p), pasteOriginSentence(p)]) if (s) sentences.push(s);
    }
    assert.ok(sentences.length >= 6, 'the sweep found almost no sentences — it is not sweeping');
    for (const s of sentences) {
      assert.equal(banned.test(s), false, `a refusal about the PASTE talks about the CODE: ${s}`);
    }
  });

  test('§6d · the address sentence tells her what the link she pasted actually was', () => {
    const p = parseInvitePaste(MAIL_DE(MINTED));
    const s = pasteOriginSentence(p);
    assert.ok(s, 'no sentence for the one thing the shipped e-mail does wrong');
    assert.match(s, /Herunterladen|Serveradresse/, 'German first, and it names both things');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 · THE MUTANTS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Each row below is a defect re-introduced against the SAME corpus §2 runs, and names the test
// above that dies with it. They are run over local re-implementations of the two gates rather
// than by editing the module, because a tier-1 file may not rewrite the tree it is testing;
// `docs/v2/` carries the scratch-copy run that edited the real file.

describe('§7 · the mutants, each naming the row that dies', () => {
  const CANON = /^[0-9A-Za-z]{4}(?:-[0-9A-Za-z]{4}){2}$/;
  const fold = (s) => String(s ?? '')
    .replace(/[­​‌‍⁠﻿]/g, '')
    .replace(/[‐-―⁃−]/g, '-')
    .replace(/[ -   　]/g, ' ')
    .replace(/[ \t]/g, ' ')
    .replace(/-\s+/g, '-').replace(/\s+-/g, '-')
    .trim()
    .replace(/\s+/g, ' ');
  const norm = (s) => [...s].filter((c) => c !== '-' && c !== ' ')
    .map((c) => { const u = c.toUpperCase(); return u === 'I' || u === 'L' ? '1' : u === 'O' ? '0' : u; })
    .join('');
  const legal = (s) => s.length === 12 && [...s].every((c) => CROCKFORD_ALPHABET.includes(c));

  test('§7-M1 · the shape gate deleted (step 0 asks only the alphabet) → §1b and §2b die', () => {
    // The defect exactly as it shipped: "does the whole field normalise to twelve Crockford
    // characters".
    const mutant = (raw) => { const n = norm(fold(raw)); return legal(n) ? n : null; };
    assert.ok(mutant('Mail-Anbieter'), 'M1 did not re-introduce the defect');
    assert.equal(mutant('Mail-Anbieter'), 'MA11ANB1ETER');
    assert.ok(mutant('Familie Weber'), 'M1 must also let a circle name through');
    // and the shipped gate does not:
    assert.equal(parseInvitePaste('Mail-Anbieter').found, 'none', '§1b is what dies under M1');
  });

  test('§7-M2 · the unbroken shape without the alphabet guard → §1c and §2b die', () => {
    const mutant = (raw) => {
      const f = fold(raw);
      if (!CANON.test(f) && !/^[0-9A-Za-z]{12}$/.test(f)) return null;
      const n = norm(f);
      return legal(n) ? n : null;
    };
    assert.equal(mutant('Installation'), '1NSTA11AT10N', 'M2 did not re-introduce the defect');
    assert.equal(mutant('Applications'), 'APP11CAT10NS');
    assert.equal(parseInvitePaste('Installation').found, 'none', '§1c is what dies under M2');
    assert.equal(parseInvitePaste('Applications').found, 'none');
  });

  test('§7-M3 · the length cap on a partial removed → §4a dies', () => {
    const mutant = (raw) => formatInviteCode(raw);           // what step 4 used to return
    assert.equal(inviteCodeChars(mutant('Sicherheitsmeldung')).length, 12,
      'M3 did not re-introduce the defect');
    assert.equal(mutant('Sicherheitsmeldung'), 'S1CH-ERHE-1TSM');
    const p = parseInvitePaste('Sicherheitsmeldung');
    assert.ok(inviteCodeChars(p.code).length < 12, '§4a is what dies under M3');
  });

  test('§7-M4 · the wrap fold made unconditional (any whitespace joins) → §1d dies', () => {
    const mutant = (raw) => {
      const f = fold(raw).replace(/\s+/g, '');              // join EVERYTHING, no separator needed
      const n = norm(f);
      return legal(n) ? n : null;
    };
    const inside = `${MINTED.slice(0, 7)}\n${MINTED.slice(7)}`;
    assert.ok(mutant(inside), 'M4 did not re-introduce the guess');
    assert.equal(parseInvitePaste(inside).found, 'none', '§1d is what dies under M4');
    // The honest-path CONTROL for M4: the evidence-bearing wrap still works without it.
    assert.equal(parseInvitePaste(`${MINTED.slice(0, 10)}\n${MINTED.slice(10)}`).code, MINTED);
  });

  test('§7-M5 · the label allowed to promote any candidate → §3d dies, both ways', () => {
    // Step 1 as it stood: `candidates.filter((c) => isAnchored(…))`, with no shape requirement.
    const promoted = (text) => {
      const out = [];
      for (const m of text.matchAll(/[0-9A-Za-z-]+/g)) {
        const n = norm(fold(m[0]));
        if (!legal(n)) continue;
        // `isAnchored`, restated: does a label end within 120 characters before this token?
        for (const lab of text.matchAll(/(einladungs-?code|\bcode\b)/gi)) {
          const end = lab.index + lab[0].length;
          if (m.index > end && m.index - end <= 120) { out.push(n); break; }
        }
      }
      return [...new Set(out)];
    };
    assert.deepEqual(promoted('Dein Einladungscode steht bei der Installation'), ['1NSTA11AT10N'],
      'M5 did not re-introduce the promotion');
    assert.equal(promoted(`DEIN EINLADUNGSCODE\n\n    ${MINTED}\n\nmusst Mail-Anbieter\n`).length, 2,
      'M5 did not re-introduce the ambiguity that destroyed the real code');
    // …and the shipped gate does neither.
    assert.equal(isCompleteCode(parseInvitePaste('Dein Einladungscode steht bei der Installation')),
      false, '§3d is what dies under M5');
    assert.equal(parseInvitePaste(`DEIN EINLADUNGSCODE\n\n    ${MINTED}\n\nmusst Mail-Anbieter\n`).code,
      MINTED, '§3d is what dies under M5');
  });

  test('§7-M6 · ██ THE HONEST-PATH CONTROL ██ — with every gate in place, real codes still work', () => {
    // Without this row, every assertion above is satisfiable by a parser that refuses
    // everything. The two things that must keep working are the whole-e-mail paste and a
    // freshly minted code.
    for (const [lang, mail] of [['de', MAIL_DE], ['en', MAIL_EN]]) {
      assert.equal(parseInvitePaste(mail(MINTED)).code, MINTED, `${lang} stopped working`);
    }
    for (let i = 0; i < 50; i++) {
      const code = newInviteCode();
      assert.equal(parseInvitePaste(code).code, code);
      assert.equal(parseInvitePaste(`Dein Einladungscode\n\n    ${code}\n`).code, code);
      assert.equal(parseInvitePaste(`${RELAY}\n${code}`).origin, RELAY);
    }
  });
});
