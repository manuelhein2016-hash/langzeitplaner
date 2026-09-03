// TIER 2 · LZP-1001 — the Datenschutz section (story 21.3), on the real screen, in both languages.
//
// Plain script, not a module: `await importApp('x.js')`, no `import` statements, no top-level
// `return`. Globals: test, assert, $, $$, waitFor, sleep, importApp, diag, skip.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS FOR, AND WHY THE COPY NEEDS A TEST AT ALL
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// 21.3: *"The app documents plainly what the server side can see … and names the processors
// (Vercel, Prisma Postgres; EU/Frankfurt region), so trust is informed, not marketed."*
//
// Until this ticket that sentence lived in `docs/v2/RUNBOOK.md` §7, whose own heading says it:
// *"until LZP-1001 puts that on a screen, **you are the Datenschutz page**"*. A privacy page in a
// runbook is a privacy page nobody reading the product will ever see.
//
// So the rows below are not string comparisons against the copy table — that would pass on a
// build where `buildDatenschutzSection` had stopped being called. **They read the rendered
// nodes**, on the screen a person opens with ⌘, and they check three separable things:
//
//   §1  IT IS ON THE SCREEN, in the shipped settings sheet, in both languages, once.
//   §2  IT SAYS THE TRUE THINGS — the processors, the region, what the relay sees, what it never
//       sees, how long that stays, and the two remotes.
//   §3  IT SAYS THE AMENDED 21.5 — solo makes no request UNLESS a person presses „Senden", and
//       the report is NOT end-to-end encrypted the way an entry is.
//   §4  IT DOES NOT MARKET — no reassurance vocabulary, no survey vocabulary, no promise the
//       retention section cannot keep.
//   §5  ██ R1 ██ — the backup sentence LZP-1003 asked for, and THE INVERSION of the row that
//       used to assert nothing anywhere said it.
//   §6  the rows above are not vacuous: the reader really did read rendered text.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ONE THING TO KNOW BEFORE EDITING
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Several rows below assert the ABSENCE of a word. An absence row is the cheapest thing in a
// suite to make vacuous — point it at an empty string and it is green forever — so every one of
// them is paired with a positive over the same text, and §6 pins the reader itself.

const { openSettings, buildDatenschutzSection, DATENSCHUTZ } = await importApp('settings.js');
const { anySheetOpen, closeTopSheet } = await importApp('ui.js');
const i18n = await importApp('i18n.js');
const backup = await importApp('crypto/backup.js');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0 · scaffolding
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The section alone, built into a detached body, in whatever language is currently set. */
function section() {
  const body = document.createElement('div');
  buildDatenschutzSection(body);
  return body;
}

/** What a person actually reads: every rendered character of the section, one string. */
const rendered = (body) => $$('[data-ds]', body).map((n) => n.textContent).join('\n');

function bothLanguages(fn) {
  for (const lang of ['de', 'en']) {
    i18n.setLang(lang);
    fn(lang, section());
  }
  i18n.setLang('de');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · IT IS ON THE SCREEN
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1a · Datenschutz is a section of the real settings sheet, on a solo Mac', async () => {
  // NOT the detached body: the shipped sheet, opened the way ⌘, opens it. `family/mount.js` is
  // never loaded here, so this is a solo install — which is the state three of the section's
  // paragraphs are about and the state A10's placement (inside „Familie") would have hidden them
  // in. See the copy block's header in `settings.js` for that deviation.
  while (anySheetOpen()) closeTopSheet();
  i18n.setLang('de');
  openSettings();
  const sheet = await waitFor(() => $('.sheet'), { what: 'the settings sheet' });
  try {
    const titles = $$('.section-title', sheet).map((n) => n.textContent.trim());
    assert.ok(titles.includes('Datenschutz'), `no Datenschutz section; the sheet has ${JSON.stringify(titles)}`);
    assert.equal(titles.filter((x) => x === 'Datenschutz').length, 1, 'two sections claim the name');
    const nodes = $$('[data-ds]', sheet);
    assert.ok(nodes.length >= 12, `only ${nodes.length} Datenschutz blocks were drawn`);
    const text = nodes.map((n) => n.textContent).join('\n');
    assert.ok(text.includes('Vercel') && text.includes('Frankfurt'),
      'the section is on screen but says nothing about where the server is');
  } finally {
    while (anySheetOpen()) closeTopSheet();
  }
});

test('§1b · every block exists in both languages, and the screen really changes with the language', () => {
  // Two failure modes in one row. A key present in `de` and missing in `en` renders `undefined`
  // in front of an English reader; and a section that renders the same text in both languages is
  // a section that stopped consulting the language at all.
  const de = Object.keys(DATENSCHUTZ.de).sort();
  const en = Object.keys(DATENSCHUTZ.en).sort();
  assert.deepEqual(de, en, 'the two languages carry different key sets');
  assert.ok(de.length >= 20, `only ${de.length} keys — the copy shrank`);

  const seen = {};
  bothLanguages((lang, body) => {
    const text = rendered(body);
    assert.equal(text.includes('undefined'), false, `${lang}: a block rendered undefined`);
    assert.ok(text.length > 2000, `${lang}: only ${text.length} characters of Datenschutz text`);
    assert.equal($$('[data-ds] li', body).length, DATENSCHUTZ[lang].sees.length,
      `${lang}: the „was die Vermittlungsstelle sieht" list did not render every line`);
    seen[lang] = text;
  });
  assert.notEqual(seen.de, seen.en, 'both languages render the same characters');
  assert.ok(seen.de.includes('Vermittlungsstelle'), 'the German is not German');
  assert.ok(seen.en.includes('relay'), 'the English is not English');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · IT SAYS THE TRUE THINGS
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2a · the processors and the region are named — 21.3, decision D2', () => {
  // The literal deliverable. `docs/v2/RELEASE-CHECKLIST.md` and `docs/v2/MOM-TEST.md` both carried
  // the line *"`Frankfurt`, `Vercel` and `Prisma` appear nowhere in `src/`"* as the reason this
  // story was open. This row is that line's opposite, and it is the reason those two documents
  // are now stale (FINDINGS §20e).
  bothLanguages((lang, body) => {
    const text = rendered(body);
    for (const must of ['Vercel', 'Prisma Postgres', 'Frankfurt', 'GitHub']) {
      assert.ok(text.includes(must), `${lang}: the copy does not name ${must}`);
    }
    assert.match(text, /EU/, `${lang}: the region is named without saying it is in the EU`);
  });
});

test('§2b · what the relay CAN see is enumerated, and the deliberate plaintext leak is named', () => {
  // ADR 003 §5.2's inventory, in human German. The colour is the one deliberate plaintext value
  // — `@@unique([spaceId, colorRef])` is what stops two members picking the same colour and that
  // check cannot happen inside ciphertext — and §5.2 says in so many words that it "appears
  // verbatim in the Datenschutz copy". This is that appearance.
  bothLanguages((lang, body) => {
    const text = rendered(body).toLowerCase();
    const must = lang === 'de'
      ? ['farbe', 'ip-adresse', 'version der app', '256 byte', 'kennungen']
      : ['colour', 'ip address', 'app version', '256 bytes', 'ids'];
    for (const m of must) assert.ok(text.includes(m), `${lang}: the inventory omits „${m}"`);
  });
});

test('§2c · what it can NEVER see is stated, and the paragraph is not empty', () => {
  bothLanguages((lang, body) => {
    const text = rendered(body).toLowerCase();
    const must = lang === 'de'
      ? ['keinen text eines eintrags', 'keine kategorie', 'keinen notizzettel', 'namen']
      : ['no entry text', 'no category', 'no scratchpad', 'name'];
    for (const m of must) assert.ok(text.includes(m), `${lang}: the copy does not say it never sees „${m}"`);
    // And the honest limit on that claim: shape is visible even when content is not.
    assert.ok(/dass jemand etwas geändert hat|that somebody changed something/i.test(rendered(body)),
      `${lang}: the copy claims blindness without admitting the traffic shape`);
  });
});

test('§2d · the retention sentence is the uncomfortable one, and the forbidden one is absent', () => {
  // RUNBOOK §7.2 is explicit: **do not write „wird nach einer Stunde gelöscht" anywhere.**
  // `RateBucket` is never swept and its key holds an IP; `Op` rows are never pruned. The honest
  // wording is „gespeichert, bis sie manuell gelöscht wird", and it changes in the same commit as
  // the sweeper, not before it.
  bothLanguages((lang, body) => {
    const text = rendered(body);
    assert.equal(/nach einer Stunde gel(ö|oe)scht|deleted after an hour|automatically deleted/i.test(text), false,
      `${lang}: the copy promises a deletion nothing performs`);
    const positive = lang === 'de'
      ? /unbefristet[\s\S]*von Hand löscht/
      : /indefinitely[\s\S]*by hand/;
    assert.match(text, positive, `${lang}: the retention paragraph does not say what actually happens`);
    assert.ok(/Vercel/.test(text) && /(Bedingungen|terms)/.test(text),
      `${lang}: Vercel's own request log and whose terms govern it are not mentioned`);
  });
});

test('§2e · the SECOND remote is named — the update check, and what it does not carry', () => {
  // `platform/updater.js`'s header and RUNBOOK §7.3: the board makes zero requests and the SHELL
  // makes one — a daily unauthenticated GET of one static manifest, no identifier, no query
  // string, no board content. E1-VERIFICATION §2 and E10-2 both predicted this line.
  //
  // The host itself is deliberately NOT named: `tests/attack/e10-network-scope.test.js` §1g says
  // the one remote URL in the product is still `OWNER-PLACEHOLDER`, and a Datenschutz page that
  // names a host that does not exist is worse than one that names the company.
  bothLanguages((lang, body) => {
    const text = rendered(body);
    assert.ok(/GitHub/.test(text), `${lang}: the release host's operator is not named`);
    assert.ok(/(täglich|a day)/.test(text), `${lang}: the cadence is not stated`);
    const noId = lang === 'de' ? /keine Kennung/ : /no identifier/;
    assert.match(text, noId, `${lang}: the copy does not say the update check carries no identifier`);
    assert.equal(/https?:\/\//.test(text), false, `${lang}: the copy prints a URL — §1g says there is not a real one yet`);
  });
});

test('§2f · Privat is stated as structural, not as "extra encryption"', () => {
  // ADR 004's boundary, and the sentence six adversary rounds earned: a Privat entry produces
  // ZERO family ops rather than a redacted one, and peers do not hold an entity key for it. The
  // wrong version of this sentence — „privat wird besonders stark verschlüsselt" — is a promise
  // about a cipher; the true one is a promise about an absence.
  bothLanguages((lang, body) => {
    const text = rendered(body);
    const must = lang === 'de'
      ? [/nie an den Familienkreis|geht nie an die Familie/, /keinen Schlüssel, den ein anderes Mitglied hätte/, /keine Größe und kein Zeitpunkt/]
      : [/never goes to the family/, /no key any other member holds/, /not even a size or a time/];
    for (const re of must) assert.match(text, re, `${lang}: the Privat paragraph is missing ${re}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · THE AMENDED 21.5, AND THE FEEDBACK EXCEPTION
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3a · solo mode is stated as zero UNREQUESTED requests, with the one exception named', () => {
  // THE AMENDMENT, ON THE GLASS. Story 21.5 said "zero network requests" and LZP-1009 made the
  // Rückmeldung the first request a solo copy can make. The amended promise (ADR 003 §7.5, D10,
  // PO 2026-09-03) bounds the ORIGINATOR rather than the count — and a promise amended in an ADR
  // and not in the product is the erosion with an extra step. `tests/tier1/network-scope.test.js`
  // §5b holds the code to it; this row holds the copy to it.
  bothLanguages((lang, body) => {
    const text = rendered(body);
    const must = lang === 'de'
      ? [/verlässt kein Eintrag diesen Mac/, /nur, wenn du sie auslöst/, /Von allein sendet dieses Programm nichts/]
      : [/no entry leaves this Mac/, /only when you trigger it/, /On its own this program sends nothing/];
    for (const re of must) assert.match(text, re, `${lang}: the solo paragraph is missing ${re}`);
    // And it must not have re-acquired the un-amended absolute, which is now false.
    assert.equal(/keine einzige Netzwerkanfrage|zero network requests/i.test(text), false,
      `${lang}: the copy still makes the pre-amendment claim, which LZP-1009 falsified`);
  });
});

test('§3b · ██ the report is NOT end-to-end encrypted, and the copy says so in those words ██', () => {
  // The sentence this ticket exists to get right. Entries are E2EE; a feedback report is not.
  // It is TLS in transit and readable at the far end by whoever operates the relay
  // (`server/core/handlers/feedback.js` — the sink is server configuration, and the handler
  // never touches a space store). A privacy page that let a reader carry the E2EE guarantee
  // across to the report would be the most consequential untruth on the screen.
  bothLanguages((lang, body) => {
    const text = rendered(body);
    const notE2ee = lang === 'de'
      ? /Rückmeldung ist nicht Ende-zu-Ende verschlüsselt/
      : /feedback report is not end-to-end encrypted/;
    assert.match(text, notE2ee, `${lang}: the copy does not say the report is not E2EE`);
    const readable = lang === 'de' ? /am Ziel lesbar/ : /readable at the far end/;
    assert.match(text, readable, `${lang}: it does not say who can read it`);
    const contrast = lang === 'de' ? /Einträge sind Ende-zu-Ende/ : /entries are end-to-end/;
    assert.match(text, contrast, `${lang}: the contrast with an entry is not drawn`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · IT DOES NOT MARKET
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4a · no reassurance vocabulary, and no survey vocabulary', () => {
  // 21.3's own words: *"so trust is informed, not marketed."* Principle 9 adds the other half —
  // the product does not study its user. Both banned lists are paired with the positive row
  // above them, so neither is satisfiable by an empty section.
  const BANNED = [
    /\b(?:100\s*%|absolut|völlig)\s+sicher\b/i, /\bmilitärisch/i, /\bbanken(?:übliche|standard)/i,
    /\bmilitary[- ]grade\b/i, /\bbank[- ]level\b/i, /\bcompletely secure\b/i,
    /\bwir nehmen deinen datenschutz ernst\b/i, /\bwe take your privacy seriously\b/i,
    /\bbewerte?n?\b/i, /\bumfrage\b/i, /\bsurvey\b/i, /\brate us\b/i, /\brecommend\b/i,
    /\bworld[- ]class\b/i, /\bnahtlos\b/i, /\bseamless\b/i,
  ];
  bothLanguages((lang, body) => {
    const text = rendered(body);
    for (const re of BANNED) {
      assert.equal(re.test(text), false, `${lang}: the Datenschutz copy markets — ${re} matched`);
    }
    assert.ok(text.length > 2000, `${lang}: the ban rows are passing over ${text.length} characters`);
  });
});

test('§4b · the third-party paragraph is exhaustive and closes the list', () => {
  bothLanguages((lang, body) => {
    const text = rendered(body);
    const must = lang === 'de'
      ? [/Keine Analyse-Werkzeuge/, /keine Tracker/, /keine Werbung/, /Stellen, die es gibt/]
      : [/No analytics tooling/, /no trackers/, /no advertising/, /every party there is/];
    for (const re of must) assert.match(text, re, `${lang}: 21.4's closing list is missing ${re}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · ██ R1 — THE BACKUP SENTENCE, AND THE ROW IT INVERTS ██
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// LZP-1003's pass, finding **R1**: a stolen backup yields the whole board in the clear, with no
// passphrase. `board` is plaintext JSON on BOTH export paths; D8 only ever covered the identity
// block. The defect is in the COPY — `README.withIdentity` says „Wer diese Datei und dein Passwort
// hat, ist du", which a reader hears as *both are needed*, and `sealsEntriesToo` says „Auch die
// Einträge sind versiegelt", where „versiegelt" is doing INTEGRITY's work in a sentence a
// non-technical reader hears as CONFIDENTIALITY's.
//
// `tests/attack/e10-crypto-backup.test.js` E10-B7 carries the assertion this inverts:
//
//   > THE COPY. No string anywhere in the export sheet, the READMEs or LIMITS tells the user that
//   > the entries are readable without the password. If one is ever added, this assertion is what
//   > has to be inverted, and the row above is the reason.
//
// ██ IT IS INVERTED HERE AND NOT THERE, AND THAT IS A DEVIATION WORTH READING. ██
// That row scans `[EXPORT_SHEET_COPY, README, LIMITS]` — three exports of `src/js/crypto/backup.js`,
// a file this ticket does not own (ONE OWNER PER FILE). The true sentence therefore lands in the
// copy this ticket DOES own, which is also the better place for it: the export sheet is read
// while deciding which button to press, and this is read before it matters. The consequence is
// that E10-B7's row is still green over a narrower object than the product — filed as **R1-b** in
// FINDINGS §20c, owner: whoever next opens `crypto/backup.js`.

test('§5a · the Datenschutz copy says the entries in a backup are readable without the password', () => {
  bothLanguages((lang, body) => {
    const text = rendered(body);
    const must = lang === 'de'
      ? [/im Klartext/, /ohne Passwort lesbar/, /auch bei einer Sicherung MIT Passwort/,
         /Passwort schützt die Schlüssel, nicht die Einträge/, /macht sie nicht unlesbar/]
      : [/in the clear/, /readable\s+without the password/, /including in a backup made WITH one/,
         /password protects the keys, not the entries/, /does not make it unreadable/];
    for (const re of must) assert.match(text, re, `${lang}: R1's sentence is missing ${re}`);
  });
});

test('§5b · \u2588\u2588 INVERTED — E10-B7\'s claim is false of the product, and the row is LOCATED \u2588\u2588', () => {
  // The inversion, run against the SAME matcher E10-B7 runs.
  const saysContentIsReadable = /ohne Passwort lesbar|lesbar für jeden|readable without|not encrypted|nicht verschlüsselt/i;

  // ── THE ROW THAT MEANS SOMETHING: the match is IN THE BACKUP PARAGRAPH ────────────────────
  //
  // ⚠ A MUTANT FOUND THIS, AND IT IS WORTH READING BEFORE EDITING EITHER ROW.
  //
  // The first form of this test asserted only that E10-B7's regex matched the union of the
  // product's copy. It stayed GREEN under a mutant that softened R1's sentence back to
  // „auch ohne dein Passwort einsehbar" — because the regex's `nicht verschlüsselt` alternative
  // matches the PRIVAT paragraph („Nicht verschlüsselt, sondern gar nicht"), which is a sentence
  // about family ops and has nothing to do with a backup file. The coarse form was green for a
  // reason unrelated to R1: exactly the rot `e10-network-scope.test.js`'s header warns about,
  // one file over, in a row written to invert it.
  //
  // So the inversion is LOCATED. It has to match inside the paragraph that is about the file.
  for (const lang of ['de', 'en']) {
    assert.ok(saysContentIsReadable.test(DATENSCHUTZ[lang].backupBody),
      `R1 IS STILL OPEN in ${lang}: the paragraph about the backup file does not say the entries `
      + 'are readable without the password');
  }

  // ── the coarse form, kept, and its false positive NAMED rather than left to be rediscovered ──
  const whole = JSON.stringify([backup.EXPORT_SHEET_COPY, backup.README, backup.LIMITS, DATENSCHUTZ]);
  assert.equal(saysContentIsReadable.test(whole), true, 'E10-B7\'s matcher over the whole product');
  assert.equal(saysContentIsReadable.test(DATENSCHUTZ.de.privatBody), true,
    'the Privat paragraph no longer trips E10-B7\'s matcher — if that sentence changed, the note '
    + 'above about why the located row exists needs re-checking');

  // ── the honest half: over `crypto/backup.js` ALONE — E10-B7's exact object — nothing matches ──
  // That row is green for the reason it always was, and it is now green over less than the
  // product. Filed as R1-b, owner: whoever next opens `crypto/backup.js`.
  const backupOnly = JSON.stringify([backup.EXPORT_SHEET_COPY, backup.README, backup.LIMITS]);
  assert.equal(saysContentIsReadable.test(backupOnly), false,
    'crypto/backup.js gained the sentence too — E10-B7 can now be inverted in place, and R1-b closes');

  // The two strings E10-B7 names as the misleading ones are still exactly as it found them, so
  // this row is measuring the same build that finding was written against.
  assert.match(backup.README.withIdentity.de, /Wer diese Datei und dein Passwort hat, ist du/);
  assert.match(backup.EXPORT_SHEET_COPY.withPassword.sealsEntriesToo.de, /Auch die Einträge sind versiegelt/);
});

test('§5c · D8\'s key-loss consequence is on a screen a person reads BEFORE it matters', () => {
  // D8: *"the export sheet must say what the passphrase protects and that losing it loses the
  // backup — there is no reset, by design."* LZP-1003 asked for the larger sentence in a place
  // that is not a support script: lose every Mac and the password, and NOBODY can recover the
  // data. Naming the three parties who cannot is what makes it land — a reader who has heard
  // „verschlüsselt" all week assumes a company somewhere holds a spare.
  bothLanguages((lang, body) => {
    const text = rendered(body);
    const must = lang === 'de'
      ? [/kein Zurücksetzen des Passworts/, /kein Konto/, /kann niemand deine Daten wiederherstellen/,
         /wir nicht, Vercel nicht, Prisma nicht/]
      : [/no password reset/, /no account/, /nobody can restore your data/,
         /not us, not Vercel, not\s+Prisma/];
    for (const re of must) assert.match(text, re, `${lang}: D8's consequence is missing ${re}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · THE READER IS NOT VACUOUS
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§6 · the rows above read RENDERED nodes, and would catch a section that stopped drawing', () => {
  // Every §2–§5 row goes through `rendered()`. If `buildDatenschutzSection` appended nothing, or
  // if `data-ds` were dropped, `rendered()` returns '' and every `assert.match` above fails — but
  // every `assert.equal(re.test(text), false)` in §4 would PASS. This row is what stops the
  // absence half from being satisfiable by an empty screen.
  i18n.setLang('de');
  const body = section();
  const text = rendered(body);
  assert.ok(text.length > 2000, `the reader returned ${text.length} characters`);
  assert.ok($$('[data-ds]', body).length >= 12, 'fewer than 12 tagged blocks were drawn');

  // Shown a positive: the reader really is reading the DOM and not the table.
  const empty = document.createElement('div');
  assert.equal(rendered(empty), '', 'the reader returns text for a body with nothing in it');

  // And the text on the glass is the text in the table — for one block, so a future refactor
  // that renders a *different* string cannot pass by looking similar.
  const solo = $('[data-ds="soloBody"]', body);
  assert.ok(solo, 'the solo paragraph carries no data-ds');
  assert.equal(solo.textContent, DATENSCHUTZ.de.soloBody, 'the rendered text is not the copy');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 · ██ THE AMENDED 21.5, MEASURED IN THE ENGINE — LZP-1002 ██
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `tests/tier1/network-scope.test.js` §5 proves by CONSTRUCTION that only a press can originate a
// report. `tests/tier2/network-audit.dom.js` §2 proves a full solo session opens no socket — but
// that session never opens ⚙, so it says nothing about the screen the exception lives on.
//
// This is the missing measurement, and it is the one a conformance sweep should ask for: with
// spies on all five ways a page can open a socket, do the things a curious solo user does with
// the new feature — open Einstellungen (which now draws the Datenschutz section AND the Hilfe
// section statically), open the Rückmeldung sheet, type, go to the preview, look at the redacted
// image — and count. The count must be **zero** up to and including the preview, and **one** on
// the press, and not one call more.
//
// ⚠ THE SPY IS NOT THE PORT. The port is bound to a recording function so the press has somewhere
// to go; the five socket globals are spied SEPARATELY, so a module that decided to bypass the
// port and call `fetch` itself would be caught by the spy rather than hidden by the recorder.

const port = await importApp('feedback/port.js');
const fb = await importApp('feedback/ui.js');

/** Replace all five, count every call, restore. Mirrors network-audit.dom.js's `watchSockets`. */
function watchSockets() {
  const calls = [];
  const saved = {
    fetch: window.fetch, XMLHttpRequest: window.XMLHttpRequest, WebSocket: window.WebSocket,
    EventSource: window.EventSource, sendBeacon: navigator.sendBeacon,
  };
  window.fetch = (...a) => { calls.push('fetch:' + String(a[0])); return Promise.reject(new Error('blocked by the audit')); };
  window.XMLHttpRequest = function () { calls.push('XMLHttpRequest'); throw new Error('blocked by the audit'); };
  window.WebSocket = function (u) { calls.push('WebSocket:' + u); throw new Error('blocked by the audit'); };
  window.EventSource = function (u) { calls.push('EventSource:' + u); throw new Error('blocked by the audit'); };
  try { navigator.sendBeacon = (u) => { calls.push('sendBeacon:' + u); return false; }; } catch { /* read-only in some builds */ }
  return {
    calls,
    restore() {
      window.fetch = saved.fetch; window.XMLHttpRequest = saved.XMLHttpRequest;
      window.WebSocket = saved.WebSocket; window.EventSource = saved.EventSource;
      try { navigator.sendBeacon = saved.sendBeacon; } catch { /* as above */ }
    },
  };
}

test('§7a · reading the whole privacy story — settings, Hilfe, preview — opens nothing', async () => {
  while (anySheetOpen()) closeTopSheet();
  i18n.setLang('de');
  const spy = watchSockets();
  const sends = [];
  port.setFeedbackPort({ send: async (b) => { sends.push(b); return { status: 202, body: {} }; } });
  try {
    openSettings();
    await waitFor(() => $('.sheet'), { what: 'the settings sheet' });
    assert.ok($$('[data-ds]', $('.sheet')).length >= 12, 'the Datenschutz section did not draw');
    while (anySheetOpen()) closeTopSheet();

    fb.openFeedback();
    const sheet = await waitFor(() => $('.scrim:last-of-type .sheet'), { what: 'the Rückmeldung sheet' });
    const ta = $('textarea.fb-text', sheet);
    ta.value = 'Der Balken springt beim Ziehen eine Woche zurück.';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    $$('button', sheet).find((b) => b.textContent.trim().startsWith('Weiter')).click();
    await waitFor(() => $('.scrim:last-of-type .sheet pre.fb-payload'), { what: 'the preview' });
    await sleep(150);

    // EVERYTHING UP TO THE PRESS. The report has been composed, the board has been walked, the
    // PNG has been encoded and is on the screen — and not one socket has been touched.
    assert.deepEqual(spy.calls, [], 'composing a report opened a socket: ' + spy.calls.join(', '));
    assert.equal(sends.length, 0, 'a report was dispatched before anybody pressed anything');
  } finally {
    spy.restore();
    port.setFeedbackPort(null);
    while (anySheetOpen()) closeTopSheet();
  }
});

test('§7b · and the press sends exactly one, through the port and not through a socket', async () => {
  // THE EXCEPTION, COUNTED. One press, one dispatch. The five socket globals stay at zero because
  // the feedback tree holds a PORT and cannot open a socket itself (tier 1 §1 is the structural
  // form of that; this is the running form).
  while (anySheetOpen()) closeTopSheet();
  i18n.setLang('de');
  const spy = watchSockets();
  const sends = [];
  port.setFeedbackPort({ send: async (b) => { sends.push(b); return { status: 202, body: {} }; } });
  try {
    fb.openFeedback();
    const sheet = await waitFor(() => $('.scrim:last-of-type .sheet'), { what: 'the Rückmeldung sheet' });
    const ta = $('textarea.fb-text', sheet);
    ta.value = 'Nach dem Aufwachen ist der Notizzettel leer.';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    $$('button', sheet).find((b) => b.textContent.trim().startsWith('Weiter')).click();
    const preview = await waitFor(() => $('.scrim:last-of-type .sheet'), { what: 'the preview' });

    const send = $$('button', preview).find((b) => b.textContent.trim() === 'Senden');
    assert.ok(send, 'there is no „Senden" button on the preview');
    assert.equal(send.disabled, false, 'the port is bound but „Senden" is disabled');
    send.click();
    await waitFor(() => sends.length === 1, { what: 'the one dispatch' });
    await sleep(200);

    assert.equal(sends.length, 1, `${sends.length} dispatches for one press`);
    assert.deepEqual(spy.calls, [], 'the feedback tree opened a socket of its own: ' + spy.calls.join(', '));
    assert.equal(typeof sends[0].report, 'string', 'the body carries no report text');
    assert.equal('to' in sends[0], false, 'the body carries a recipient — §2c of the E10 sweep');
  } finally {
    spy.restore();
    port.setFeedbackPort(null);
    while (anySheetOpen()) closeTopSheet();
  }
});

test('§7c · the spy is armed — a call planted beside the session is caught', async () => {
  // Without this row §7a and §7b are green the day `watchSockets` stops replacing anything, which
  // is the same failure `network-audit.dom.js` §2's own armed row exists for.
  const spy = watchSockets();
  try {
    await window.fetch('https://example.invalid/ping').catch(() => {});
    try { new window.WebSocket('wss://example.invalid'); } catch { /* the spy throws by design */ }
  } finally {
    spy.restore();
  }
  assert.ok(spy.calls.some((c) => c.startsWith('fetch:')), 'the fetch spy did not fire');
  assert.ok(spy.calls.some((c) => c.startsWith('WebSocket:')), 'the WebSocket spy did not fire');
});
