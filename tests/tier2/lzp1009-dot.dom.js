// tests/tier2/lzp1009-dot.dom.js — the ⚙ dot, END TO END, through the real settings sheet.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY A SEPARATE FILE, AND WHAT IT MEASURES THAT NOTHING ELSE DOES
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `tests/tier2/feedback-admin.dom.js` §D1–§D4 own the DOT AS A FUNCTION: `reportsKnown \
// reportsSeen ≠ ∅`, two local prefs, zero requests, surviving a relaunch. Those rows set the
// prefs directly, which is right for what they are proving — the mechanism — and it leaves one
// claim unmeasured, and it is the claim the PO actually made:
//
//   **„a quiet 5px dot on ⚙ … it lights when something is waiting, and it clears when he opens
//     it" — and doing that costs no network request.**
//
// The gap between the two is the GESTURE. Between "the prefs say a dot" and "he opened
// Einstellungen and the dot went away" sit `settings.js#build`, `admin.js#buildReportsSection`,
// a real `openSettings()` sheet, `loadReports`, a card, a click, `markReportSeen` and a second
// open. Every one of those is a place a request could be added by somebody who reasonably thought
// the dot needed refreshing — and each of them would be a SECOND AUTOMATIC ORIGINATOR, which is
// exactly the bound story 21.5 as amended exists to hold and D10 exists to pay for.
//
// So this file drives the whole gesture through the shipped sheet and COUNTS. The number that
// matters is not zero — opening the section legitimately asks the relay for the list, on a human
// press, which is the one originator §5b of `tests/tier1/network-scope.test.js` permits. The
// number that matters is that the DOT ITSELF adds none of them: the same gesture costs the same
// count with the dot lit and with it dark.
//
// ONE OWNER PER FILE: this file is the LZP-1009 second-pass INTEGRATION's, and it deliberately
// asserts nothing `feedback-admin.dom.js` already asserts. It reads the same fixture-bridge
// shape as that file because a second, differently-shaped fake bridge would be a second thing to
// keep true.

const { store } = await importApp('store.js');
const { openSettings } = await importApp('settings.js');
const { anySheetOpen, closeTopSheet } = await importApp('ui.js');
const i18n = await importApp('i18n.js');
const admin = await importApp('feedback/admin.js');
const { setFeedbackPort } = await importApp('feedback/port.js');

const ORIGIN = 'https://relay.example.test';

/**
 * The bridge, recording every command. `sync_status` names an origin; `sync_request` answers the
 * three operator routes locally. An unknown command THROWS rather than returning `undefined`,
 * for `feedback-admin.dom.js`'s reason: a silent undefined is how a test passes over a path it
 * never exercised.
 */
function bridge(reports) {
  const calls = [];
  const paths = [];
  const invoke = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'sync_status') {
      return { enabled: false, configured: ORIGIN, origin: ORIGIN, originConfigured: true, reason: null };
    }
    if (cmd === 'sync_request') {
      paths.push(`${args.method} ${String(args.url).replace(ORIGIN, '')}`);
      return {
        status: 200, headers: {}, url: args.url, redirected: false,
        body: JSON.stringify({ ok: true, reports, more: false }),
      };
    }
    throw new Error(`the test bridge was asked for an unexpected command: ${cmd}`);
  };
  return { invoke, calls, paths, requests: () => calls.filter((x) => x === 'sync_request').length };
}

const REPORT = (n) => ({
  id: `rep_${String(n).padStart(22, 'q')}`,
  receivedAt: Date.UTC(2026, 8, n, 9, 15),
  expiresAt: Date.UTC(2026, 11, n, 9, 15),
  signed: false,
  devicePub: null,
  prose: `Bericht ${n}: Ich komme nicht mehr rein.`,
  hasImage: false,
});

function reset() {
  while (anySheetOpen()) closeTopSheet();
  setFeedbackPort(null);
  admin.setReportsCredential(null);
  admin.initReportsAdmin({});
  store.setSettings({ reportsAdmin: false, reportsKnown: [], reportsSeen: [] });
  admin.refreshReportsChrome();
  i18n.setLang('de');
}

const cred = () => ({ devicePub: 'A'.repeat(86), sign: async () => new Uint8Array(64) });
const dotShows = () => document.body.classList.contains('reports-hint');

/** Open ⚙, wait for the reports list to have rendered, and hand back the sheet. */
async function openAndSettle() {
  openSettings();
  const sheet = await waitFor(() => $('.scrim:last-of-type .sheet'), { what: 'the settings sheet' });
  await waitFor(() => $('.rp-list', sheet) && !$('.rp-list .rp-status', sheet), { what: 'the reports list' });
  return sheet;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE GESTURE, END TO END
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1 · ██ MEASURED ██ the dot lights, he opens ⚙, reads one, and it clears', async () => {
  reset();
  const b = bridge([REPORT(1)]);
  try {
    admin.initReportsAdmin({ invoke: b.invoke });
    admin.setReportsCredential(cred());
    store.setSettings({ reportsAdmin: true });

    // ── it is DARK before anything has arrived ────────────────────────────────────────────────
    admin.refreshReportsChrome();
    assert.equal(dotShows(), false, 'the ⚙ is lit with nothing waiting at all');

    // ── one report arrives · the LIST is what learns of it, on a human press ──────────────────
    const sheet = await openAndSettle();
    assert.equal(b.paths.length, 1, `opening ⚙ made ${b.paths.length} requests: ${b.paths.join(', ')}`);
    assert.equal(b.paths[0], 'GET /api/v1/feedback',
      'opening the section asked the relay for something other than the list');
    assert.ok($('.rp-list .rp-card', sheet) || $$('.rp-list *', sheet).length > 0,
      'the section drew no report at all — this row would then be measuring an empty screen');
    // The dot is a claim about UNREAD reports, so it lights the moment one is known and unseen.
    assert.equal(admin.reportsHintActive(), true, 'a report he has not opened does not light the dot');

    // ── he reads it · the dot clears, and it costs NOTHING ────────────────────────────────────
    const before = b.requests();
    const head = $('.rp-list .rp-head', sheet) || $$('.rp-list *', sheet).find((n) => n.className && String(n.className).includes('rp-head'));
    assert.ok(head, 'there is nothing to click — the card has no head');
    head.click();
    await waitFor(() => admin.reportsHintActive() === false, { what: 'the dot to clear' });
    assert.equal(b.requests() - before, 0,
      `reading a report cost ${b.requests() - before} request(s). Expanding a card is a pure DOM `
      + 'operation: the prose came down with the list, and only the PICTURE is fetched lazily — '
      + 'which is a second human press, on a second button, on a report with an image.');
    while (anySheetOpen()) closeTopSheet();
    admin.refreshReportsChrome();
    assert.equal(dotShows(), false, 'the ⚙ is still lit after he read the only report');
  } finally { reset(); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE DOT ADDS NO REQUEST — THE SAME GESTURE, LIT AND DARK
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2 · ██ MEASURED ██ the SAME gesture costs the same, dot lit or dot dark', async () => {
  // THE BOUND, STATED AS A DIFFERENCE RATHER THAN AS A NUMBER. A row asserting "one request" is
  // satisfied by an implementation that polls once and calls it the list. This asserts that the
  // HINT is not on the network path at all: whatever opening ⚙ costs, it costs the same with an
  // unread report and with none, so no code path exists that refreshes the dot by asking.
  const measure = async (seen) => {
    reset();
    const b = bridge([REPORT(1), REPORT(2)]);
    admin.initReportsAdmin({ invoke: b.invoke });
    admin.setReportsCredential(cred());
    store.setSettings({ reportsAdmin: true, reportsKnown: [REPORT(1).id, REPORT(2).id], reportsSeen: seen });
    admin.refreshReportsChrome();
    const lit = dotShows();
    await openAndSettle();
    while (anySheetOpen()) closeTopSheet();
    return { lit, n: b.requests(), paths: b.paths.slice() };
  };
  try {
    const dark = await measure([REPORT(1).id, REPORT(2).id]);   // everything read
    const litUp = await measure([]);                            // two waiting
    assert.equal(dark.lit, false, 'the dot is lit with everything read');
    assert.equal(litUp.lit, true, 'the dot is dark with two reports waiting');
    assert.deepEqual(litUp.paths, dark.paths,
      `the dot changed what the app asks for. lit: ${litUp.paths.join(', ')} / dark: ${dark.paths.join(', ')}`);
    assert.equal(litUp.n, dark.n,
      `opening ⚙ cost ${litUp.n} requests with the dot lit and ${dark.n} with it dark. The hint is `
      + 'a pure function of two local prefs (17.5 / 19.3) and must never be on the network path — '
      + 'a poll here would be a SECOND automatic originator and would spend exactly the bound D10 '
      + 'exists to hold.');
  } finally { reset(); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · AND IT IS NEVER ON THE BOARD (PO decision 3)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3 · the hint is one class on <body> and one dot on ⚙ — nothing on the board', () => {
  reset();
  try {
    store.setSettings({ reportsAdmin: true, reportsKnown: ['rep_a'], reportsSeen: [] });
    admin.refreshReportsChrome();
    assert.equal(dotShows(), true, 'the hint did not arm — §3 would be measuring nothing');
    // The board is `#board`; the hint may not put a node inside it, and may not put TEXT anywhere.
    const board = $('#board') || document.querySelector('.board');
    if (board) {
      assert.equal(board.querySelectorAll('.quiet-dot, .reports-hint').length, 0,
        'the reports hint reached the board. PO decision 3: never on the board, no count, no '
        + 'banner, no sound.');
    }
    // No COUNT anywhere on the chrome: „3 neue Berichte" is the shape that was ruled out.
    const gear = document.getElementById('btn-settings');
    if (gear) {
      assert.equal(/\d/.test(gear.textContent || ''), false,
        `the ⚙ carries a number ("${gear.textContent}"). The decision was a DOT — 5 px, no count.`);
    }
    store.setSettings({ reportsSeen: ['rep_a'] });
    admin.refreshReportsChrome();
    assert.equal(dotShows(), false, 'the class survives having read everything');
  } finally { reset(); }
});
