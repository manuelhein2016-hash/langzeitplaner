// tests/tier2/e13-datenschutz.dom.js — ██ F5 ██  `docs/v2/AUDIT.md`:
//
//     "The Datenschutz screen states three things that are false … This is the one surface whose
//      entire job is that trust is informed, not marketed."
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS, AND WHY IT IS A SECOND FILE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `tests/tier2/datenschutz.dom.js` is LZP-1001's characterization of this screen and it is
// somebody else's file (ONE OWNER PER FILE). Three of its rows assert the sentences F5 measured
// FALSE — §3a's `/Von allein sendet dieses Programm nichts/` most sharply. Those rows are
// INVERTED here rather than deleted there, and §0 below names each one, its file and its line, so
// the hand-off is a line number and not a search. The same applies to
// `tests/tier1/network-scope.test.js` §5e and to the two `tests/audit/` files, which are wired
// into no npm script and are the audit's own evidence.
//
// ── THE RULE THIS FILE FOLLOWS ────────────────────────────────────────────────────────────────
// A row that reads the copy table and asserts the copy table is a tautology with a test runner
// around it. So every claim row is paired with a MEASUREMENT of the thing the sentence is about,
// taken through the real module in the real engine:
//
//   (a) the feedback exception ..... `feedback/port.js#canSend()` and the real „Senden" button on
//                                    the real Rückmeldung sheet, on a Mac that bound nothing
//   (b) the automatic request ...... a real `createUpdater` driven by the real
//                                    `update-ui.js#startDailyTimer`, with nobody pressing anything
//   (c) the board-only backup ...... a real `exportBackup(…, null, …)` → `importBackup(…, null, …)`
//                                    round trip over a board with German note text on it
//
// Where the mechanism is on the server (`ROUTE_NAMES`, `RATE_RULES`) or in the shell
// (`updaterFetchManifest`'s gate ordering), neither is reachable from inside the WebView — the
// app bundle carries `index.html` and `src/` and nothing else. Those measurements are pinned as
// CONSTANTS with the command that produced them, and §6 states plainly that the server-side row
// is owed by another agent in `tests/server/`.
//
// ── MUTANTS ──────────────────────────────────────────────────────────────────────────────────
// The copy is a frozen table, so a mutant here is the PRE-FIX STRING fed to the same matcher the
// shipped string passes. Every mutant carries the § of the row that must die on it, and every
// mutant is paired with the honest-path control over the shipped text — a matcher that rejects
// everything is not a matcher.

const { openSettings, buildDatenschutzSection, DATENSCHUTZ } = await importApp('settings.js');
const { anySheetOpen, closeTopSheet } = await importApp('ui.js');
const i18n = await importApp('i18n.js');
const fbPort = await importApp('feedback/port.js');
const fb = await importApp('feedback/ui.js');
const backup = await importApp('crypto/backup.js');
const updateUI = await importApp('update-ui.js');
const updater = await importApp('platform/updater.js');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0 · scaffolding, and the rows this file inverts
// ═════════════════════════════════════════════════════════════════════════════════════════════

function section() {
  const body = document.createElement('div');
  buildDatenschutzSection(body);
  return body;
}
const rendered = (body) => $$('[data-ds]', body).map((n) => n.textContent).join('\n');

function bothLanguages(fn) {
  for (const lang of ['de', 'en']) {
    i18n.setLang(lang);
    fn(lang, section());
  }
  i18n.setLang('de');
}

/**
 * ██ THE INVERTED ROWS ██ — each one asserts a sentence F5 measured false, so each one MUST be
 * red until its owner lands the replacement. Listed as data, not prose, so a hand-off can diff it.
 */
const INVERTED = Object.freeze([
  Object.freeze({
    row: 'tests/tier1/network-scope.test.js §5e',
    asserts: '/Von allein sendet dieses Programm nichts/ and /On its own this program sends nothing/'
      + ' over the source of settings.js',
    why: 'F5(b) — boot() arms `runLaunchCheck(); startDailyTimer();` on every launch of every '
      + 'install. The sentence is true only while the release host is OWNER-PLACEHOLDER.',
    keeps: 'the other three matchers in that row are still true and are re-asserted in §2c below',
  }),
  Object.freeze({
    row: 'tests/tier2/datenschutz.dom.js §3a',
    asserts: 'the same two sentences, over the RENDERED section',
    why: 'F5(b), and F5(a): the paragraph promised a solo Mac an exception the family gate '
      + 'disables.',
    keeps: '/verlässt kein Eintrag diesen Mac/, /nur, wenn du sie auslöst/, /no entry leaves this '
      + 'Mac/, /only when you trigger it/ — all four still hold and are re-asserted in §1c/§2c',
  }),
  Object.freeze({
    row: 'tests/audit/pass1-datenschutz.test.js (the lossBody and seesNotBody rows)',
    asserts: '/keine Sicherung mit Passwort hast/ and /DASS jemand etwas geändert hat — nicht, was/',
    why: 'F5(c) and F5(d). Both are the audit\'s own evidence rows: they exist to be red once the '
      + 'copy is fixed. `tests/audit/` is wired into no npm script.',
    keeps: 'nothing — these two rows are the finding',
  }),
  Object.freeze({
    row: 'tests/audit/pass4-conformance.test.js:157',
    asserts: '/Von allein sendet dieses Programm nichts\\./',
    why: 'F5(b), same sentence, same reason.',
    keeps: 'nothing',
  }),
]);

/** Measured outside the WebView; the command that produced each is in the string. */
const PINNED = Object.freeze({
  routeNames: 24,                       // node -e "import('./server/core/router.js').then(m=>console.log(m.ROUTE_NAMES.length))"
  memberKeyedRateRules: Object.freeze(['pairSession', 'memberRemove', 'epochRotate']),
  //                                    // node -e "…Object.entries(RATE_RULES).filter(([,v])=>v.identity==='member')"
  logFieldsInOneLine: Object.freeze(['route', 'spaceId', 'deviceShort']),
  //                                    // node -e "…console.log(Object.keys(LOG_FIELDS))"
  swiftGateBeforePlaceholder: true,     // consent gate at +110, OWNER-PLACEHOLDER refusal at +308
});

test('§0 · the inversion ledger is a ledger — every row it names is named completely', () => {
  // Not decoration. A hand-off list with a hole in it is how an inverted row gets lost, and a
  // lost inverted row is a green suite over a false sentence — which is the whole shape of F5.
  assert.equal(INVERTED.length, 4, 'the ledger changed size without the report changing');
  for (const e of INVERTED) {
    for (const k of ['row', 'asserts', 'why', 'keeps']) {
      assert.ok(typeof e[k] === 'string' && e[k].length > 0, `${e.row}: ${k} is empty`);
    }
    assert.match(e.row, /^tests\/(tier1|tier2|audit)\//, `${e.row} is not a locatable path`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · F5(a) — THE EXCEPTION A SOLO MAC CANNOT TAKE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Measured outside this file: `setFeedbackPort` has exactly ONE caller in the product,
// `family/mount.js#bindFeedback`, and it is reachable only through the single dynamic `import()`
// in `main.js`, which sits behind `if (!hasPersonal && !hasCircle) return;`. This process is that
// Mac: `family/mount.js` was never loaded, so nothing bound the port. The rows below do not
// assume that — they measure it.

test('§1a · ██ MEASURED ██ on this solo Mac nothing bound the port, and „Senden" is dead', async () => {
  // Deliberately NOT binding a port, which is what makes this a solo Mac rather than a fixture.
  // `datenschutz.dom.js` §7b binds one before it presses Senden; that row measures the family
  // case. This one measures the case the Datenschutz paragraph was written about.
  assert.equal(fbPort.canSend(), false,
    'a port is bound in a process that never loaded family/mount.js — the family gate leaked');
  assert.equal(fbPort.feedbackPort(), null, 'feedbackPort() is not null on a solo Mac');

  while (anySheetOpen()) closeTopSheet();
  i18n.setLang('de');
  try {
    fb.openFeedback();
    const sheet = await waitFor(() => $('.scrim:last-of-type .sheet'), { what: 'the Rückmeldung sheet' });
    const ta = $('textarea.fb-text', sheet);
    ta.value = 'Der Balken springt beim Ziehen eine Woche zurück.';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    $$('button', sheet).find((b) => b.textContent.trim().startsWith('Weiter')).click();
    await waitFor(() => $('.scrim:last-of-type .sheet pre.fb-payload'), { what: 'the preview' });
    const preview = $('.scrim:last-of-type .sheet');

    const send = $$('button', preview).find((b) => b.textContent.trim() === 'Senden');
    assert.ok(send, 'there is no „Senden" button on the preview at all');
    assert.equal(send.disabled, true,
      '„Senden" is pressable on a Mac with no Familienkreis — the Datenschutz promise would then '
      + 'be true and this whole finding is stale');
    // And the product already says why, one module over. This is the sentence F5(a) says the
    // Datenschutz screen should have been saying all along.
    const status = $$('p.hint', preview).map((n) => n.textContent).join('\n');
    assert.match(status, /Solange du keinen Familienkreis nutzt, gibt es keinen Server/,
      'feedback/copy.js#noRelay is not on the screen — the true sentence moved and §1c is stale');
  } finally {
    while (anySheetOpen()) closeTopSheet();
  }
});

/**
 * THE MATCHER. Wherever the solo paragraph names the Rückmeldung, the same paragraph must carry
 * the condition that makes it reachable. Written as "from the mention onward" rather than as one
 * regex, because the pre-fix string ALSO contained „Rückmeldung" and „Familienkreis" — just not
 * in that order and not about each other.
 */
function namesTheFamilienkreisCondition(text, lang) {
  const mention = lang === 'de' ? text.indexOf('Rückmeldung unter') : text.indexOf('feedback screen under');
  if (mention < 0) return false;
  const tail = text.slice(mention);
  const needsCircle = lang === 'de' ? /braucht einen Familienkreis/ : /needs a Familienkreis/;
  const noServer = lang === 'de'
    ? /keinen Server, an den etwas gehen könnte/ : /no server anything could go to/;
  const disabled = lang === 'de' ? /„Senden" ist\s+abgeschaltet/ : /"Send" is switched off/;
  return needsCircle.test(tail) && noServer.test(tail) && disabled.test(tail);
}

test('§1b · the screen states the condition, in both languages, in the paragraph that promises it', () => {
  bothLanguages((lang, body) => {
    const text = rendered(body);
    assert.ok(namesTheFamilienkreisCondition(text, lang),
      `${lang}: the solo paragraph names the Rückmeldung without naming the Familienkreis it needs`);
    // The promise F5(a) found — an UNCONDITIONAL „genau eine Ausnahme" — must be gone.
    const unconditional = lang === 'de'
      ? /Genau eine Ausnahme gibt es, und sie geschieht nur, wenn du sie auslöst: die\s+Rückmeldung/
      : /There is\s+exactly one exception, and it happens only when you trigger it: the feedback/;
    assert.equal(unconditional.test(text), false,
      `${lang}: the screen has re-acquired the exception a solo Mac cannot take`);
  });
});

test('§1c · MUTANT ██ §1b dies on the pre-fix sentence, and passes the shipped one ██', () => {
  // The honest-path control first: a matcher that rejects everything proves nothing.
  assert.ok(namesTheFamilienkreisCondition(DATENSCHUTZ.de.soloBody, 'de'),
    'CONTROL: the shipped German fails its own matcher');
  assert.ok(namesTheFamilienkreisCondition(DATENSCHUTZ.en.soloBody, 'en'),
    'CONTROL: the shipped English fails its own matcher');

  const MUTANTS = [
    ['M-a-verbatim  ', 'de', 'Solange du keinen Familienkreis nutzt, verlässt kein Eintrag diesen Mac. '
      + 'Genau eine Ausnahme gibt es, und sie geschieht nur, wenn du sie auslöst: die Rückmeldung '
      + 'unter „Hilfe". Von allein sendet dieses Programm nichts.'],
    ['M-a-verbatim  ', 'en', 'As long as you use no Familienkreis, no entry leaves this Mac. There is '
      + 'exactly one exception, and it happens only when you trigger it: the feedback screen under '
      + '"Help". On its own this program sends nothing.'],
    // The softening a hurried edit would reach for: the word Familienkreis is in the paragraph
    // (it is in the FIRST sentence of every version) but the condition on the press is not.
    ['M-a-softened  ', 'de', 'Solange du keinen Familienkreis nutzt, verlässt kein Eintrag diesen Mac. '
      + 'Die Rückmeldung unter „Hilfe" geht nur, wenn du sie auslöst.'],
    ['M-a-softened  ', 'en', 'As long as you use no Familienkreis, no entry leaves this Mac. The '
      + 'feedback screen under "Help" goes only when you trigger it.'],
    // The half-fix: says it needs a circle, does not say the button is dead without one — which
    // is the fact a person standing in front of a greyed-out „Senden" needs.
    ['M-a-halfway   ', 'de', 'Die Rückmeldung unter „Hilfe" geht nur, wenn du sie auslöst — und sie '
      + 'braucht einen Familienkreis.'],
  ];
  for (const [name, lang, mutant] of MUTANTS) {
    assert.equal(namesTheFamilienkreisCondition(mutant, lang), false,
      `${name} (${lang}): §1b survived the pre-fix copy — the row is not measuring the condition`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · F5(b) — „Von allein sendet dieses Programm nichts", while boot() arms an interval
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2a · ██ MEASURED ██ the daily timer fetches a manifest with nobody pressing anything', async () => {
  // THE MECHANISM, RUNNING. `update-ui.js#startDailyTimer` is a bare `setInterval` over
  // `updater.checkDaily()`, and `main.js#boot()` calls it on every launch of every install, solo
  // included. Here it is driven with the real `createUpdater` over a port that answers the way a
  // configured release host would — which is precisely the state F22 puts the product in.
  //
  // The shell re-checks both 21.5 gates natively, and in `updaterFetchManifest` it checks them
  // BEFORE the OWNER-PLACEHOLDER refusal (PINNED.swiftGateBeforePlaceholder). So today no packet
  // leaves for a reason that has nothing to do with consent, and everything to do with the
  // release host not existing yet.
  const calls = [];
  let now = 10_000_000_000;
  const port = {
    status: async () => ({ disclosed: true, enabled: true, currentVersion: '2.0.0', lastCheckAt: null }),
    noteCheck: async (at) => { calls.push('noteCheck:' + at); },
    fetchManifest: async () => { calls.push('fetchManifest'); return { ok: false, error: 'network' }; },
    download: async () => ({ ok: false }),
  };
  const u = updater.createUpdater({ port, now: () => now });
  updateUI.initUpdateUI({ updater: u });
  try {
    const timer = updateUI.startDailyTimer(20);
    assert.notEqual(timer, null, 'startDailyTimer refused to arm — the seam moved');
    await waitFor(() => calls.includes('fetchManifest'),
      { timeout: 3000, what: 'the timer to reach the network on its own' });
    assert.ok(calls.includes('fetchManifest'),
      'nothing left the machine unbidden — if that is now true of the shipped code, F5(b) is '
      + 'closed and soloBody may say so again');
  } finally {
    updateUI.stopDailyTimer();
    updateUI.initUpdateUI({});
  }
  assert.equal(PINNED.swiftGateBeforePlaceholder, true,
    'shell-macos/main.swift#updaterFetchManifest re-ordered — re-measure before trusting §2b');
});

function claimsNothingHappensUnbidden(text) {
  return /Von allein sendet dieses Programm nichts|On its own this program sends nothing/.test(text);
}
/**
 * Scoped to the SOLO paragraph on purpose. The cadence („etwa einmal täglich") lives in
 * `updateBody`, thirteen blocks down, and §2b asserts it separately over the whole section — a
 * matcher that needed both would be un-runnable against `soloBody` alone, which is what §2d's
 * control has to do to be a control.
 */
function namesTheAutomaticCheck(text, lang) {
  return (lang === 'de'
    ? /Von allein geschieht genau eines, und nur, wenn du vorher zugestimmt hast: die\s+Update-Prüfung/
    : /Exactly\s+one thing happens on its own, and only if you agreed to it beforehand: the update check/
  ).test(text);
}

test('§2b · the screen names the one thing that happens unbidden, and no longer denies it', () => {
  bothLanguages((lang, body) => {
    const text = rendered(body);
    assert.equal(claimsNothingHappensUnbidden(text), false,
      `${lang}: the screen still says the program originates nothing — §2a just measured it doing so`);
    assert.ok(namesTheAutomaticCheck(text, lang),
      `${lang}: the update check is not named as the automatic one in the solo paragraph`);
    // The honest version was always thirteen blocks further down. Both must still be there, and
    // they must now agree rather than contradict.
    assert.match(text, lang === 'de' ? /täglich/ : /a day/, `${lang}: the cadence is not stated`);
    assert.match(text, /GitHub/, `${lang}: the update paragraph lost its operator`);
    const consent = lang === 'de' ? /nur, wenn du der\s+Update-Prüfung zugestimmt hast/ : /only if you agreed to the update check/;
    assert.match(text, consent, `${lang}: the update paragraph no longer states the consent gate`);
    assert.equal(/https?:\/\//.test(text), false, `${lang}: the copy printed a URL`);
  });
});

test('§2c · what F5 did NOT touch is still on the screen, in both languages', () => {
  // `network-scope.test.js` §5e and `datenschutz.dom.js` §3a each assert four things; F5 falsifies
  // one of the four. Re-asserting the other three here is what makes the hand-off in §0 a
  // one-line edit rather than a re-litigation of the whole row.
  bothLanguages((lang, body) => {
    const text = rendered(body);
    const must = lang === 'de'
      ? [/Solange du keinen Familienkreis nutzt, verlässt kein Eintrag diesen Mac/, /nur, wenn du sie auslöst/]
      : [/no entry leaves this Mac/, /only when you trigger it/];
    for (const re of must) assert.match(text, re, `${lang}: A1's scoped guarantee lost ${re}`);
    assert.equal(/keine einzige Netzwerkanfrage|zero network requests/i.test(text), false,
      `${lang}: the pre-amendment absolute came back`);
  });
});

test('§2d · MUTANT ██ §2b dies on the pre-fix sentence, and passes the shipped one ██', () => {
  assert.equal(claimsNothingHappensUnbidden(DATENSCHUTZ.de.soloBody), false, 'CONTROL: shipped de');
  assert.equal(claimsNothingHappensUnbidden(DATENSCHUTZ.en.soloBody), false, 'CONTROL: shipped en');
  assert.ok(namesTheAutomaticCheck(DATENSCHUTZ.de.soloBody, 'de'), 'CONTROL: shipped de names the check');
  assert.ok(namesTheAutomaticCheck(DATENSCHUTZ.en.soloBody, 'en'), 'CONTROL: shipped en names the check');

  const MUTANTS = [
    ['M-b-verbatim  ', 'Genau eine Ausnahme gibt es … Von allein sendet dieses Programm nichts.'],
    ['M-b-english   ', 'There is exactly one exception … On its own this program sends nothing.'],
    ['M-b-restored  ', 'Die Update-Prüfung steht weiter unten. Von allein sendet dieses Programm nichts.'],
  ];
  for (const [name, mutant] of MUTANTS) {
    assert.equal(claimsNothingHappensUnbidden(mutant), true,
      `${name}: the matcher stopped recognising the sentence it exists to forbid`);
  }
  // And the direction that matters: the mutant fails §2b's assertion, the shipped text passes it.
  assert.equal(claimsNothingHappensUnbidden(DATENSCHUTZ.de.soloBody + ' Von allein sendet dieses Programm nichts.'),
    true, 'M-b-appended: appending the false sentence to the true one does not trip §2b');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · F5(c) — THE ONE WITH A DATA-LOSS SHAPE
// ═════════════════════════════════════════════════════════════════════════════════════════════

const MEMBER = 'mem_AAAAAAAAAAAAAAAAAAAAAA';
const GERMAN_NOTE = 'Mamas Geburtstag — Kuchen bestellen';
const GERMAN_BAR = 'Urlaub Ostsee';
const GERMAN_PAD = 'Zahnarzt anrufen';

function testBoard() {
  return {
    notes: [{ id: 'n1', date: '2026-07-14', text: GERMAN_NOTE }],
    bars: [{ id: 'b1', startDate: '2026-07-01', endDate: '2026-07-14', label: GERMAN_BAR }],
    categories: [],
    scratchpads: { '2026-07': GERMAN_PAD },
    settings: { language: 'de' },
  };
}

test('§3a · ██ MEASURED ██ a board-only export carries the entries and importBackup hands them back', async () => {
  // THE FACT THE SCREEN GOT BACKWARDS. `lossBody` conditioned the loss on having no
  // PASSWORD-PROTECTED backup; a passphrase-less export is a complete, readable, restorable copy
  // of the board, and its own README says so („Sie stellt dein Board wieder her").
  const file = await backup.exportBackup(testBoard(), { memberId: MEMBER }, null, null,
    { exportedAt: '2026-09-04', app: '2.0.0' });
  const bytes = JSON.stringify(file);

  assert.equal('identity' in file, false, 'the board-only path wrote an identity block');
  assert.includes(bytes, GERMAN_NOTE, 'the note text is not in the file — R1 no longer holds');
  assert.includes(bytes, GERMAN_BAR, 'the bar label is not in the file');
  assert.includes(bytes, GERMAN_PAD, 'the scratchpad is not in the file');
  assert.match(file._README_de, /Sie stellt dein Board wieder her/,
    'README.boardOnly stopped promising a restore — re-read F5(c) before touching lossBody');

  const back = await backup.importBackup(file, null, null);
  assert.equal(back.identityRestored, false, 'a keyless file restored an identity');
  assert.equal(back.board.notes.length, 1, 'importBackup returned no notes for a board-only file');
  assert.equal(back.board.notes[0].text, GERMAN_NOTE,
    'the note did not survive the round trip — the copy that says it does would then be wrong');
  assert.equal(back.board.scratchpads['2026-07'], GERMAN_PAD, 'the scratchpad did not come back');
});

function lossIsConditionedOnHavingNoBackupAtAll(text, lang) {
  const wrong = lang === 'de'
    ? /keine Sicherung mit Passwort hast/ : /hold no password-protected backup/;
  const right = lang === 'de' ? /gar keine Sicherung hast/ : /hold no backup at all/;
  const salvage = lang === 'de'
    ? /Sicherung OHNE Passwort genügt dafür trotzdem: sie bringt deine Einträge zurück/
    : /backup made WITHOUT a password\s+is still enough for this: it brings your entries back/;
  return !wrong.test(text) && right.test(text) && salvage.test(text);
}

test('§3b · the loss paragraph is conditioned on NO backup, and says what a keyless one saves', () => {
  bothLanguages((lang, body) => {
    const text = rendered(body);
    assert.ok(lossIsConditionedOnHavingNoBackupAtAll(text, lang),
      `${lang}: the screen still tells a person holding a board-only export that her entries are gone`);
    // What the keyless file genuinely does NOT restore has to stay on the screen too, or the fix
    // trades one false sentence for another. `README.boardOnly` is the source.
    const membership = lang === 'de' ? /nicht zurückbringt, ist deine Mitgliedschaft/ : /not bring back is your membership/;
    assert.match(text, membership, `${lang}: the fix over-promises — the circle does not come back`);
    // D8's three parties survive: §5c of datenschutz.dom.js reads the same sentence.
    const parties = lang === 'de' ? /wir nicht, Vercel nicht, Prisma nicht/ : /not us, not Vercel, not Prisma/;
    assert.match(text, parties, `${lang}: D8's three parties left the paragraph`);
  });
});

test('§3c · MUTANT ██ §3b dies on the pre-fix condition, and passes the shipped one ██', () => {
  assert.ok(lossIsConditionedOnHavingNoBackupAtAll(DATENSCHUTZ.de.lossBody, 'de'), 'CONTROL: shipped de');
  assert.ok(lossIsConditionedOnHavingNoBackupAtAll(DATENSCHUTZ.en.lossBody, 'en'), 'CONTROL: shipped en');

  const MUTANTS = [
    ['M-c-verbatim  ', 'de', 'Wenn alle deine Macs verloren gehen und du keine Sicherung mit Passwort '
      + 'hast, kann niemand deine Daten wiederherstellen — wir nicht, Vercel nicht, Prisma nicht.'],
    ['M-c-verbatim  ', 'en', 'If all your Macs are lost and you hold no password-protected backup, '
      + 'nobody can restore your data — not us, not Vercel, not Prisma.'],
    // The half-fix: right condition, and it still leaves her believing the file she holds is
    // worthless, because nothing tells her it is not.
    ['M-c-halfway   ', 'de', 'Wenn alle deine Macs verloren gehen und du gar keine Sicherung hast, '
      + 'kann niemand deine Daten wiederherstellen.'],
    ['M-c-halfway   ', 'en', 'If all your Macs are lost and you hold no backup at all, nobody can '
      + 'restore your data.'],
    // And the direction the fix must not slide into: both conditions in one paragraph.
    ['M-c-both      ', 'de', 'Wenn du gar keine Sicherung hast, ist alles weg — und wenn du keine '
      + 'Sicherung mit Passwort hast, auch.'],
  ];
  for (const [name, lang, mutant] of MUTANTS) {
    assert.equal(lossIsConditionedOnHavingNoBackupAtAll(mutant, lang), false,
      `${name} (${lang}): §3b survived the pre-fix condition`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · F5(d) — „nicht, was" was true of the database and false of the relay
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4a · the content claim survives, scoped to the entry, and the log is named', () => {
  bothLanguages((lang, body) => {
    const text = rendered(body);
    // The half that is TRUE and must not be lost in the fix: from timings and rounded sizes you
    // get the fact of a change and not the text of one.
    const shape = lang === 'de' ? /DASS jemand etwas geändert hat/ : /THAT somebody changed something/;
    assert.match(text, shape, `${lang}: the traffic-shape admission disappeared with the fix`);
    // The half that was FALSE: the unqualified „nicht, was".
    const unqualified = lang === 'de' ? /geändert hat — nicht, was\./ : /changed something — never what\./;
    assert.equal(unqualified.test(text), false,
      `${lang}: the screen again claims the relay cannot tell what happened`);
    // And the correction, in the register the screen uses.
    const names = lang === 'de'
      ? /Anfrageprotokoll hält bei jeder Anfrage fest, WELCHE Handlung es war/
      : /request\s+log records, for every request, WHICH action it was/;
    assert.match(text, names, `${lang}: the log is not named as the thing that records the act`);
    // At least one of the closed enum's verbs, spelled in the reader's language. „Mitglied
    // entfernt" and „Verwaltung übergeben" are `removeMember` and `transferAdmin`; both are in
    // `ROUTE_NAMES`, and a person reading this page is entitled to know that the words exist.
    const namedAct = lang === 'de'
      ? /Mitglied\s+entfernt|Verwaltung übergeben/ : /member removed|admin handed over/;
    assert.match(text, namedAct, `${lang}: no named act appears on the screen`);
  });
});

test('§4b · the enum this rests on, pinned — and the row another agent owes', () => {
  // `server/` is not in the app bundle (build.sh copies `index.html` and `src/` and nothing
  // else), so this cannot be measured from inside the WebView. It IS measurable in one line from
  // the repo, and the number is pinned so a change to the enum shows up as a red row here rather
  // than as a silently stale sentence on a privacy page.
  assert.equal(PINNED.routeNames, 24,
    'ROUTE_NAMES changed length — re-measure, then re-read infer4, which says „vierundzwanzig"');
  assert.deepEqual(PINNED.logFieldsInOneLine, ['route', 'spaceId', 'deviceShort'],
    'LOG_FIELDS changed — the sentence about one line naming the act may no longer hold');
  const de = DATENSCHUTZ.de.infer4;
  assert.match(de, /vierundzwanzig festen Bezeichnungen/,
    'the German no longer states the count the pin above guards');
  assert.match(DATENSCHUTZ.en.infer4, /twenty-four fixed names/, 'the English lost the count');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · F5's MISSING HALF — `docs/v2/server-metadata.md` §7's five disclosures
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// §7: *"a Datenschutz page written only from the column tables would miss every one of them"* —
// and of the first: *"'the relay can tell which of the five of you is in charge' is exactly the
// kind of sentence 21.3 exists to say out loud."* None of the five was on this screen in either
// language. Each row below asserts the CLAIM and its MECHANISM, because a disclosure without its
// mechanism is a scare and a mechanism without its claim is documentation.

const FIVE = Object.freeze([
  Object.freeze({
    key: 'infer1', what: '§7.1 — the relay can identify the admin four ways',
    de: [/wer von euch das Sagen hat/, /wer zuerst dabei war/, /wer sie ausgestellt hat/,
      /eine Zeile, die\s+auf ihn ausgestellt ist/, /Übergabe der Verwaltung/],
    en: [/which of you is in\s+charge/, /whoever was there first/, /who issued it/,
      /a row made out in their\s+name/, /handing over the administration/],
  }),
  Object.freeze({
    key: 'infer2', what: '§7.2 — time-zone inference from shifted activity windows',
    de: [/anderen Zeitzone|Tagesmuster/, /um Stunden verschoben/, /keinen Text und keine\s+IP-Adresse/],
    en: [/another time zone|daily\s+pattern/, /shifted by hours/, /no text and no IP address/],
  }),
  Object.freeze({
    key: 'infer3', what: '§7.3 — member-keyed rate rows are an action record at rest, unswept',
    de: [/auf ein Mitglied/, /dieses Mitglied hat das getan/, /nie\s+automatisch gelöscht/],
    en: [/to a member/, /this\s+member did this/, /never deleted automatically/],
  }),
  Object.freeze({
    key: 'infer4', what: '§7.4 — the application log names the act',
    de: [/vierundzwanzig festen Bezeichnungen/, /Umbenennen/, /speichert den neuen Namen\s+nirgends/],
    en: [/twenty-four fixed names/, /Renaming/, /stores the\s+new name nowhere/],
  }),
  Object.freeze({
    key: 'infer5', what: '§7.5 — cross-space correlation attaches two circles to one person',
    de: [/zwei Mitglieder mit verschiedenen Kennungen/, /denselben öffentlichen Schlüssel/,
      /Wiederherstellungsschlüssel/, /derselben Person zuordnen/],
    en: [/two members with different ids/, /the same public key in both/,
      /recovery key/, /attach\s+them to one person/],
  }),
]);

test('§5a · all five are on the glass, in both languages, each with its mechanism', () => {
  bothLanguages((lang, body) => {
    const text = rendered(body);
    for (const d of FIVE) {
      const node = $(`[data-ds="${d.key}"]`, body);
      assert.ok(node && node.textContent.length > 150,
        `${lang}: ${d.what} is not drawn, or is a one-liner`);
      for (const re of d[lang]) {
        assert.match(text, re, `${lang}: ${d.what} is missing its mechanism — ${re}`);
      }
    }
    // §7's own closing point, which the tables also never say: the realistic re-identification
    // path is the IP address and not the database.
    const ip = lang === 'de' ? /nicht anonym/ : /not anonymous/;
    assert.match($(`[data-ds="inferIp"]`, body).textContent, ip,
      `${lang}: the screen keeps the pseudonymity claim without §7's own limit on it`);
  });
});

test('§5b · they are stated, not softened — no mitigation clause, no reassurance', () => {
  // The failure mode for a disclosure section is not omission, it is the trailing sentence that
  // takes it back. This is 21.3's „informed, not marketed" applied to the paragraphs that were
  // hardest to write.
  const SOFTENERS = [
    /kein Grund zur Sorge/i, /keine Sorge/i, /in der Praxis (?:aber )?unwahrscheinlich/i,
    /nothing to worry about/i, /no cause for concern/i, /in practice this is unlikely/i,
    /wir würden (?:das )?nie/i, /we would never/i, /rein theoretisch/i, /purely theoretical/i,
  ];
  bothLanguages((lang, body) => {
    const five = FIVE.map((d) => $(`[data-ds="${d.key}"]`, body).textContent).join('\n')
      + '\n' + $('[data-ds="inferIp"]', body).textContent;
    for (const re of SOFTENERS) {
      assert.equal(re.test(five), false, `${lang}: a disclosure is taken back — ${re} matched`);
    }
    assert.ok(five.length > 1800, `${lang}: the five disclosures are only ${five.length} characters`);
  });
});

test('§5c · MUTANT ██ dropping one disclosure names which one died ██', () => {
  // The row that makes §5a worth having: it must fail per-disclosure, not as one blob. Each
  // mutant here is „the section as shipped, minus one paragraph", and the assertion is that the
  // matcher for exactly that paragraph is the one that stops matching.
  i18n.setLang('de');
  const whole = FIVE.map((d) => DATENSCHUTZ.de[d.key]).join('\n');
  for (const dropped of FIVE) {
    const mutant = FIVE.filter((d) => d.key !== dropped.key).map((d) => DATENSCHUTZ.de[d.key]).join('\n');
    const stillMatch = dropped.de.filter((re) => re.test(mutant));
    assert.equal(stillMatch.length, 0,
      `M-5-${dropped.key}: ${dropped.what} was dropped and §5a would still be green — ` +
      `${stillMatch.join(', ')} matched another paragraph`);
    for (const other of FIVE.filter((d) => d.key !== dropped.key)) {
      for (const re of other.de) {
        assert.ok(re.test(mutant),
          `M-5-${dropped.key}: dropping one disclosure broke ${other.key}'s matcher (${re}) — ` +
          'the matchers are not independent and §5a cannot say which one died');
      }
    }
  }
  assert.ok(FIVE.every((d) => d.de.every((re) => re.test(whole))), 'CONTROL: the shipped five');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · THE SCREEN AS A WHOLE — not vacuous, not marketing, and the same on the second open
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§6a · the reader reads the DOM, both languages carry every new key, and nothing renders undefined', () => {
  const de = Object.keys(DATENSCHUTZ.de).sort();
  const en = Object.keys(DATENSCHUTZ.en).sort();
  assert.deepEqual(de, en, 'the two languages carry different key sets');
  for (const k of ['inferTitle', 'inferLead', 'infer1', 'infer2', 'infer3', 'infer4', 'infer5', 'inferIp']) {
    assert.ok(de.includes(k), `${k} is missing from the copy table`);
  }
  bothLanguages((lang, body) => {
    const text = rendered(body);
    assert.equal(text.includes('undefined'), false, `${lang}: a block rendered undefined`);
    assert.ok(text.length > 4000, `${lang}: only ${text.length} characters — the section shrank`);
    // The five are paragraphs, not a second <ul>, so `datenschutz.dom.js` §1b's
    // `[data-ds] li` count against `sees.length` still holds. That row is not mine; keeping it
    // green was a design constraint on this section and this is where that is written down.
    assert.equal($$('[data-ds] li', body).length, DATENSCHUTZ[lang].sees.length,
      `${lang}: a second list appeared — datenschutz.dom.js §1b now fails for the wrong reason`);
  });
  // Shown a positive, exactly as §6 of datenschutz.dom.js does: an empty body reads as ''.
  assert.equal(rendered(document.createElement('div')), '',
    'the reader returns text for a body that was never built — every absence row above is vacuous');
});

test('§6b · it still does not market, over the enlarged section', () => {
  // `datenschutz.dom.js` §4a's banned list, re-run because this ticket added ~3 000 characters to
  // the surface it guards and a ban row is only as good as the text it ran over.
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
      assert.equal(re.test(text), false, `${lang}: the enlarged section markets — ${re} matched`);
    }
  });
});

test('§6c · a second open of the sheet renders the identical screen, and „Senden" is still dead', async () => {
  // ── WHAT THIS ROW IS, AND WHAT IT IS NOT ────────────────────────────────────────────────────
  // The audit's central defect class is a QUIT-AND-OPEN: a fold that needs the op log to answer a
  // question about the present. F5 is copy, and copy is a frozen module-level table drawn from
  // scratch on every `build()`, so there is no register for a relaunch to fail to rebuild.
  //
  // What CAN be measured in one process is the closest analogue: the sheet closed and opened
  // again renders byte-identical text, and the solo Mac's port is still unbound after the whole
  // session above ran — including §2a, which replaced the app's updater, and §3a, which drove the
  // real backup module. A REAL second process launch is NOT proven here and cannot be: the tier-2
  // runner launches the app once per file. `scripts/shell-family-e2e.mjs` is the rig that
  // relaunches, and it never opens ⚙.
  while (anySheetOpen()) closeTopSheet();
  i18n.setLang('de');
  const read = async () => {
    openSettings();
    const sheet = await waitFor(() => $('.sheet'), { what: 'the settings sheet' });
    const text = $$('[data-ds]', sheet).map((n) => n.textContent).join('\n');
    while (anySheetOpen()) closeTopSheet();
    return text;
  };
  const first = await read();
  const second = await read();
  assert.ok(first.length > 4000, `the first open drew only ${first.length} characters`);
  assert.equal(first, second, 'the screen is not the same on the second open');
  assert.equal(fbPort.canSend(), false,
    'the port became bound during this session — a solo Mac gained a sender it cannot have');
  // And the section really is in the shipped sheet, not only in the detached body §1–§5 used.
  assert.includes(first, 'Vercel');
  assert.includes(first, 'Frankfurt');
});
