// TIER 2 · LZP-1009 SECOND PASS — the solo sender, „Berichte", and a dot that costs no requests.
//
// Plain script, not a module: `await importApp('x.js')`, no `import` statements, no top-level
// `return`. Globals: test, assert, $, $$, waitFor, sleep, importApp, diag, skip.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT ONLY THIS TIER CAN SAY
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Three claims, and none of them has a tier-1 form:
//
//   1. **A SOLO MAC CAN SEND, AND THE DOOR STAYS SHUT WHEN IT LEADS NOWHERE.** `relay.js` opens
//      `platform/net.js` with a real `await import()` against a real module graph, and the thing
//      being measured is a NUMBER: how many `sync_request` calls happen when no origin is
//      configured. Tier 1 can read the import graph; only a running engine can count the calls.
//   2. **THE WHOLE OPERATOR PATH, SIGNATURE INCLUDED.** The bridge is faked; everything above it
//      is the shipping code — `buildRequest`, `assertReachable`, the `LZPADMIN` header, the reply
//      checks. A test that mocked `openReportsClient` would prove nothing about the two things
//      most likely to be wrong, which are the signed string and the path.
//   3. **PRINCIPLE 10 ON THE SCREEN THAT WOULD MOST LIKE TO BREAK IT.** „Berichte" is where a
//      reply box would seem obvious. This looks at the rendered DOM, expanded, and at the
//      section builder's own source.
//
// ── WHAT THIS FILE DOES NOT PROVE, SAID RATHER THAN LEFT TO BE ASSUMED ──────────────────────
//
// **Nothing under `src/js/` ever writes `reportsAdmin: true`** is the claim the admin gate rests
// on, and it is a claim about a source tree. Tier 2 has no filesystem: §A3 below measures the
// BEHAVIOURAL half — every control the settings sheet draws is pressed with the flag off and none
// of them writes it — which is one level deep and is not the same statement. The grep belongs in
// tier 1 and is owed; see this pass's hand-off notes.

const { store } = await importApp('store.js');
const { openSettings } = await importApp('settings.js');
const { anySheetOpen, closeTopSheet } = await importApp('ui.js');
const i18n = await importApp('i18n.js');
const { c } = await importApp('feedback/copy.js');
const { setFeedbackPort, canSend, feedbackPort } = await importApp('feedback/port.js');
const { openFeedback } = await importApp('feedback/ui.js');
const relay = await importApp('feedback/relay.js');
const admin = await importApp('feedback/admin.js');

const T = (k, ...a) => c('de', k, ...a);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FIXTURE BRIDGE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// A `sync_status` that answers whatever the case under test needs, and a `sync_request` that
// answers locally. EVERY call is recorded, including the ones nobody expected: an unknown command
// throws by name rather than returning undefined, because a silent `undefined` from a bridge is
// how a test passes over a path it never exercised.
//
// The reply carries `url` and `redirected` because `createBridgeTransport` REQUIRES them
// (finding P-5): a reply that does not name the URL its bytes came from is refused before the
// body is parsed. Faking those correctly is part of what makes this a test of the real transport.

const ORIGIN = 'https://relay.example.test';

function fakeBridge(opts) {
  const o = opts || {};
  const calls = [];
  const requests = [];
  const invoke = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'sync_status') {
      const configured = o.originConfigured !== false;
      return {
        enabled: o.enabled !== false,
        configured: o.configured !== undefined ? o.configured : ORIGIN,
        origin: configured ? ORIGIN : null,
        originConfigured: configured,
        reason: configured ? null : 'unset',
      };
    }
    if (cmd === 'sync_request') {
      requests.push(args);
      const r = (o.reply || (() => ({ status: 200, body: '{"ok":true}' })))(args, requests.length);
      return { status: 200, headers: {}, body: '{}', url: args.url, redirected: false, ...r, url: r.url || args.url };
    }
    throw new Error(`the test bridge was asked for an unexpected command: ${cmd}`);
  };
  return { invoke, calls, requests, count: () => calls.filter((x) => x === 'sync_request').length };
}

/** A credential whose `sign` records exactly what it was handed. Never a real key: the bytes are
 *  the subject of §A5, and a real ECDSA signature would hide them behind an opaque blob. */
function fakeCredential() {
  const signed = [];
  return {
    signed,
    devicePub: 'A'.repeat(86),                       // 65 raw bytes, base64url, the right width
    sign: async (bytes) => { signed.push(new TextDecoder().decode(bytes)); return new Uint8Array(64); },
  };
}

const REPORT = (n, over) => ({
  id: `rep_${String(n).padStart(22, 'x')}`,
  receivedAt: Date.UTC(2026, 8, n, 12, 30),
  expiresAt: Date.UTC(2026, 11, n, 12, 30),
  signed: false,
  devicePub: null,
  prose: `Bericht ${n}: Der Balken springt beim Ziehen zurück.`,
  hasImage: false,
  ...over,
});

function reset() {
  setFeedbackPort(null);
  admin.setReportsCredential(null);
  admin.initReportsAdmin({});
  store.setSettings({ reportsAdmin: false, reportsKnown: [], reportsSeen: [] });
  document.body.classList.remove('reports-hint');
  for (const n of $$('#rp-probe')) n.remove();
  while (anySheetOpen()) closeTopSheet();
  i18n.setLang('de');
}

/** Open Einstellungen and hand back the „Berichte" heading's node, or null. */
function openAndFindReports() {
  openSettings();
  const sheet = $('.sheet');
  const titles = $$('.sheet-body .section-title', sheet);
  return { sheet, head: titles.find((n) => n.textContent.trim().startsWith(T('aSectionTitle'))) || null };
}

/**
 * The section, drawn into a container of this file's own, ATTACHED to the document so
 * `getComputedStyle` is real.
 *
 * ⚠ WHY NOT THE SETTINGS SHEET FOR THE ROWS BELOW, when §A2 proves the wiring through it: the
 * open sheet is rebuilt from under a test by `update-ui.js` — `runLaunchCheck()` runs on every
 * launch of every install and its `onChange` calls `rebuildSettings()`, which is correct product
 * behaviour (22.4: a background check must not leave the sheet showing a stale answer) and makes
 * any multi-step interaction with the live sheet a race. That was MEASURED here, not guessed: the
 * first draft of §A4 saw the list re-issued twice and its expanded card replaced mid-test.
 *
 * §A2 keeps the integration claim — the section really is drawn by `settings.js` in the real
 * sheet — and the rows below characterise the section itself against a container nothing else
 * owns.
 */
function renderSection() {
  const box = document.createElement('div');
  box.id = 'rp-probe';
  document.body.appendChild(box);
  admin.buildReportsSection(box, null);
  return box;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §S · THE SOLO SENDER — and the door that stays shut
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§S1 · ██ MEASURED ██ with NO origin configured the door is never opened: ZERO requests', async () => {
  // THE PROPERTY THE AMENDMENT DID NOT BUY BACK. Story 21.5 as amended lets a solo Mac send;
  // it does not let a build with nothing pinned reach anything, and `bindSoloSender` returns
  // BEFORE `await import('../platform/net.js')` in that case. What is asserted is the observable
  // consequence — a number — rather than the shape of the `if`.
  reset();
  const b = fakeBridge({ originConfigured: false });
  try {
    const r = await relay.bindSoloSender(b.invoke);
    assert.equal(r, 'no-origin', 'the binder bound something against an unconfigured build');
    assert.equal(canSend(), false, '„Senden" is live on a Mac with nowhere to send to');
    assert.equal(b.count(), 0, `${b.count()} requests were made while binding a solo sender`);
    assert.deepEqual(b.calls, ['sync_status'], 'the probe is one bridge read and nothing else');
  } finally { reset(); }
});

test('§S2 · with an origin configured a SOLO Mac binds, and the space kind is „solo"', async () => {
  // D10's amendment stops being vacuous here, and `report.js`'s long-unused `SPACE_KINDS` entry
  // `'solo'` stops being unused. This is the row the PO's decision of 2026-09-04/05 is.
  reset();
  const b = fakeBridge({});
  try {
    const r = await relay.bindSoloSender(b.invoke);
    assert.equal(r, 'bound', 'a Mac with a pinned relay still cannot send');
    assert.equal(canSend(), true, '„Senden" is dead on a Mac that has somewhere to send to');
    const p = feedbackPort();
    assert.equal(p.spaceKind, 'solo');
    // ██ NO CREDENTIAL, AND THAT IS THE HONEST SHAPE. ██ ADR 002 §2.4 mints a device key at the
    // family opt-in and nowhere else, so a solo Mac has none. The handler accepts that and
    // records `signed: false` rather than the client pretending otherwise.
    assert.equal(p.sign, undefined, 'the solo binder acquired a signing key from somewhere');
    assert.equal(p.devicePub, undefined, 'the solo binder acquired a device public key');
    assert.equal(b.count(), 0, 'binding a port made a request — binding is not sending');
  } finally { reset(); }
});

test('§S3 · the solo report really goes, ANONYMOUSLY, to the one path, once', async () => {
  // The whole stack below `openFeedback`: `buildRequest`, `assertReachable`, the bridge
  // transport's P-5 checks. Only the socket is faked.
  reset();
  const b = fakeBridge({ reply: () => ({ status: 202, body: '{"ok":true}' }) });
  try {
    await relay.bindSoloSender(b.invoke);
    const send = feedbackPort().send;
    const res = await send({ v: 1, report: 'Es klemmt.', image: null });
    assert.equal(res.status, 202);
    assert.equal(b.requests.length, 1, `one press produced ${b.requests.length} requests`);
    const req = b.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, `${ORIGIN}/api/v1/feedback`, 'the solo sender addressed something else');
    // ██ ANONYMOUS. ██ `buildRequest` with `anonymous: true` emits NO `Authorization` at all —
    // not an empty one, which `optionalAuth` would treat as an error. This is also what makes the
    // solo path cheap: no `signRequest`, no `cfg.subtle`, so nothing under `src/js/crypto/`.
    const names = Object.keys(req.headers).map((k) => k.toLowerCase());
    assert.equal(names.includes('authorization'), false, 'a solo request carried a credential');
    assert.equal(names.includes('cookie'), false);
    assert.ok(names.includes('x-lzp-protocol') && names.includes('x-lzp-client'));
    assert.equal(JSON.parse(req.body).report, 'Es klemmt.');
  } finally { reset(); }
});

test('§S4 · precedence — a Mac that ALREADY has a sender is left exactly as it was', async () => {
  // `family/mount.js#bindFeedback` binds at boot with a `sign`, a `devicePub` and the right
  // `spaceKind`. `ui.js#openFeedback` asks `canSend()` FIRST, so this module binds the case that
  // had no binder and no other — otherwise a family Mac's signed reports would silently become
  // unsigned ones and `PROVES.device_continuity` would quietly stop holding.
  reset();
  try {
    setFeedbackPort({
      send: async () => ({ status: 202, body: { ok: true } }),
      sign: async () => new Uint8Array(64),
      devicePub: 'PUB',
      appVersion: '2.0.0',
      spaceKind: 'family',
    });
    const b = fakeBridge({});
    openFeedback();
    await sleep(80);
    assert.equal(feedbackPort().spaceKind, 'family', 'the solo binder overrode the family binder');
    assert.equal(feedbackPort().devicePub, 'PUB', 'the signed identity was dropped');
    assert.equal(b.count(), 0);
  } finally { reset(); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §A · „BERICHTE" — the admin screen
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§A1 · with the flag off there is NO section — not a heading, not an empty one', () => {
  // The default state of every Mac in the world but his. An empty section with a heading would
  // advertise that the surface exists, which is the same mistake the relay refuses to make by
  // answering 404 rather than 401 when no operator key is configured.
  reset();
  try {
    const { sheet, head } = openAndFindReports();
    assert.equal(head, null, 'a Mac with the flag off draws „Berichte"');
    assert.equal($('.rp-list', sheet), null);
    assert.equal(sheet.textContent.includes(T('aSectionHint')), false);
  } finally { reset(); }
});

test('§A2 · with the flag on, hand-set, the section is drawn and lists what the relay holds', async () => {
  reset();
  const cred = fakeCredential();
  const b = fakeBridge({
    reply: (args) => (args.method === 'GET' && args.url.endsWith('/feedback')
      ? { status: 200, body: JSON.stringify({ ok: true, reports: [REPORT(3), REPORT(9)], more: false }) }
      : { status: 404, body: '{"error":"not_found"}' }),
  });
  try {
    admin.setReportsCredential(cred);
    admin.initReportsAdmin({ invoke: b.invoke });
    store.setSettings({ reportsAdmin: true });
    const { sheet, head } = openAndFindReports();
    assert.ok(head, 'the section did not draw with the flag hand-set');
    await waitFor(() => $$('.rp-card', sheet).length === 2, { what: 'the two reports' });
    const cards = $$('.rp-card', sheet);
    // NEWEST FIRST, decided by the screen: a relay that answered in insertion order would put the
    // report he is waiting for at the bottom.
    assert.match($('.rp-when', cards[0]).textContent, /2026-09-09/, 'the newest report is not first');
    assert.match($('.rp-when', cards[1]).textContent, /2026-09-03/);
    // „verfällt am …" — SAID, not implied. Without it the 90 days are a fact only the sender's
    // Datenschutz screen knows about, and he is the one who has to act before it runs out.
    assert.includes($('.rp-expiry', cards[0]).textContent, 'verfällt am 2026-12-09');
    assert.includes(sheet.textContent, T('aRetention', 90));
    // his own key, and the enrolment sentence that says where it goes
    assert.equal($('.rp-key', sheet).textContent, cred.devicePub);
    assert.includes(sheet.textContent, 'LZP_REPORTS_ADMIN_PUB');
    assert.ok($('.rp-copy', sheet), 'there is no way to copy the key out of the app');
  } finally { reset(); }
});

test('§A3 · ██ MEASURED ██ no control the settings sheet draws writes `reportsAdmin`', () => {
  // THE BEHAVIOURAL HALF of "unreachable by any sequence of clicks". Every switch, button and
  // select the sheet draws is pressed with the flag off, and the store is watched. It is one
  // level deep and this file says so in its header: the SOURCE-level claim — nothing under
  // `src/js/` ever writes the key — is a tier-1 grep and is owed.
  reset();
  const wrote = [];
  const realSet = store.setSettings.bind(store);
  const realLayer = store.setLayer.bind(store);
  let pressed = 0;
  try {
    store.setSettings = (patch) => { wrote.push(patch); return realSet(patch); };
    store.setLayer = (patch) => { wrote.push(patch); return realLayer(patch); };
    openSettings();
    const sheet = $('.sheet');
    for (const node of $$('button, input, select, .switch', sheet)) {
      // Not the ones that navigate away or destroy something: „Wiederherstellen" restores a
      // snapshot over the fixture board, and „Sichern"/„Laden" open a file panel. Pressing them
      // would be testing something else and would leave the run in a different state.
      const label = `${node.textContent || ''} ${node.className}`;
      if (/wiederherstell|restore|sichern|laden|import|export|zurücksetzen/i.test(label)) continue;
      pressed++;
      try { node.click(); } catch { /* a control that throws is not one that wrote the key */ }
    }
    const offenders = wrote.filter((x) => x && Object.prototype.hasOwnProperty.call(x, 'reportsAdmin'));
    assert.deepEqual(offenders, [], 'a control in Einstellungen switches the admin view on');
    // The non-vacuity guard is on PRESSES, not on writes: most of this sheet's controls are
    // `select`s and sliders that a synthetic `click()` does not move, and a guard that demanded a
    // write would be satisfiable by a sheet with one button in it.
    assert.ok(pressed > 10, `only ${pressed} controls were pressed — the row is measuring nothing`);
    assert.equal(admin.reportsAdminEnabled(), false, 'the flag is on after pressing everything');
  } finally {
    store.setSettings = realSet;
    store.setLayer = realLayer;
    reset();
  }
});

test('§A4 · her prose is verbatim and monospaced, and the picture is fetched only when asked', async () => {
  // THE SYMMETRY THAT IS THE POINT. `ui.js#previewScreen` shows her the payload in a monospaced
  // `<pre>`; this shows him the same characters in the same face. A question about a character —
  // an umlaut mangled, a line that wrapped — is then answerable rather than a guess.
  reset();
  const prose = 'Der Balken für „Kur" springt zurück — und zwar immer um genau eine Woche.\n\nZweiter Absatz.';
  const png = 'iVBORw0KGgo';                          // not a real PNG; §A4 never decodes it
  const b = fakeBridge({
    reply: (args) => (args.url.endsWith('/feedback')
      ? { status: 200, body: JSON.stringify({ ok: true, reports: [REPORT(4, { prose, hasImage: true })] }) }
      : { status: 200, body: JSON.stringify({ ok: true, report: { ...REPORT(4, { prose }), image: png } }) }),
  });
  try {
    admin.setReportsCredential(fakeCredential());
    admin.initReportsAdmin({ invoke: b.invoke });
    store.setSettings({ reportsAdmin: true });
    const box = renderSection();
    await waitFor(() => $('.rp-card', box), { what: 'the report' });
    const before = b.requests.length;
    $('.rp-head', box).click();
    const pre = $('.rp-prose', box);
    assert.ok(pre, 'the expanded report shows no prose');
    assert.equal(pre.textContent, prose, 'her sentence was reflowed, trimmed or re-rendered');
    assert.match(getComputedStyle(pre).fontFamily, /mono/i, 'the prose is not monospaced');
    // LAZY, and measured: expanding a report fetches no picture until he asks for one. Thirty
    // reports is thirty redacted PNGs over his Mac's one link to the relay.
    assert.equal(b.requests.length, before, 'expanding a report pulled the image down with it');
    $('.rp-img', box).click();
    await waitFor(() => $('.rp-png', box), { what: 'the image' });
    assert.equal(b.requests.length, before + 1, 'asking for one image made a different number of requests');
    assert.match(b.requests[before].url, /\/api\/v1\/feedback\/rep_/, 'the image came from somewhere else');
  } finally { reset(); }
});

test('§A5 · ██ THE OPERATOR CREDENTIAL, ON THE WIRE ██ — scheme, domain prefix and signed bytes', async () => {
  // The two things most likely to be wrong, and whose failure mode is total: every real request
  // gets a 401 and nothing on either side says why. The signed string is asserted as a LITERAL,
  // so a change on either side of the pipe reddens this row rather than being discovered in
  // production. (`tests/server/reports.test.js` owes the other half: this builder and
  // `handlers/reports.js#adminSignedString` run against each other.)
  reset();
  const cred = fakeCredential();
  const b = fakeBridge({ reply: () => ({ status: 200, body: '{"ok":true,"reports":[]}' }) });
  try {
    const client = await relay.openReportsClient({ invoke: b.invoke, credential: cred });
    assert.ok(client, 'the reader would not open against a configured relay with a credential');
    await client.list();
    const auth = b.requests[0].headers.Authorization || b.requests[0].headers.authorization;
    assert.match(auth, /^LZPADMIN ts=\d+, nonce=[A-Za-z0-9_-]{22}, sig=[A-Za-z0-9_-]+$/,
      `the operator header is not the shape auth.js#parseAdminAuthorization parses: ${auth}`);
    // NOT `LZP1`. `parseAuthorization` throws on any scheme it does not know, in both
    // directions, so a family member's valid device credential can never be read as an
    // operator's and vice versa.
    assert.equal(auth.startsWith('LZP1 '), false);
    assert.equal(auth.includes('device='), false, 'the operator header names a device');
    const ts = /ts=(\d+)/.exec(auth)[1];
    const nonce = /nonce=([A-Za-z0-9_-]+)/.exec(auth)[1];
    assert.equal(cred.signed.length, 1, 'the reader signed a different number of times');
    assert.equal(cred.signed[0], `lzp/reports/v1\nGET\n/api/v1/feedback?\n${ts}\n${nonce}`,
      'the signed string moved — the relay will 401 every request and say nothing about why');
    // NO BODY HASH, because there is no body: `requireOperator` step 3 refuses a non-empty
    // rawBody outright, so a field that cannot be present cannot be unsigned.
    assert.equal(b.requests[0].body, '', 'an admin request carried a body');
  } finally { reset(); }
});

test('§A6 · „Löschen" is behind confirmSheet, and it is the only destructive control', async () => {
  reset();
  const deleted = [];
  const b = fakeBridge({
    reply: (args) => {
      if (args.url.endsWith('/delete')) { deleted.push(args.url); return { status: 200, body: '{"ok":true,"deleted":true}' }; }
      return { status: 200, body: JSON.stringify({ ok: true, reports: deleted.length ? [] : [REPORT(7)] }) };
    },
  });
  try {
    admin.setReportsCredential(fakeCredential());
    admin.initReportsAdmin({ invoke: b.invoke });
    store.setSettings({ reportsAdmin: true });
    const box = renderSection();
    await waitFor(() => $('.rp-card', box), { what: 'the report' });
    $('.rp-head', box).click();
    $('.rp-delete', box).click();
    // A confirm sheet, not an immediate delete: it is the one irreversible thing on this screen.
    const confirm = $$('.sheet').pop();
    assert.includes(confirm.textContent, T('aDeleteBody'));
    assert.equal(deleted.length, 0, 'the report was deleted before anybody confirmed');
    $$('button', confirm).find((x) => x.textContent.trim() === T('aDelete')).click();
    await waitFor(() => deleted.length === 1, { what: 'the delete' });
    assert.match(deleted[0], /\/api\/v1\/feedback\/rep_[A-Za-z0-9_-]{22}\/delete$/);
  } finally { reset(); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §P10 · THE BOARD IS NOT A MESSENGER
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§P10 · NO textarea, NO input, NO reply — asserted on the DOM and on the source', async () => {
  // P10 is structural here because this is the screen where a reply box would seem obvious,
  // helpful and one commit away. Asserted twice on purpose: the DOM covers what actually renders
  // (including the expanded card, whose builder is not exported), and the source covers a control
  // that exists but is `hidden` on the run that happened to be measured.
  reset();
  const b = fakeBridge({
    reply: () => ({ status: 200, body: JSON.stringify({ ok: true, reports: [REPORT(2), REPORT(5)] }) }),
  });
  try {
    admin.setReportsCredential(fakeCredential());
    admin.initReportsAdmin({ invoke: b.invoke });
    store.setSettings({ reportsAdmin: true });
    const box = renderSection();
    await waitFor(() => $$('.rp-card', box).length === 2, { what: 'the reports' });
    for (const h of $$('.rp-head', box)) h.click();
    await sleep(30);
    const html = box.innerHTML.toLowerCase();
    for (const forbidden of ['<textarea', '<input', 'contenteditable']) {
      assert.equal(html.includes(forbidden), false,
        `„Berichte" grew a compose field (${forbidden}) — Principle 10: there is no reply path`);
    }
    // ⚠ THE ONE PARAGRAPH THAT IS ALLOWED TO SAY „antworten" IS THE ONE THAT SAYS THERE IS NO
    // REPLY, and it is excised before the scan rather than the scan being loosened to tolerate
    // it — a word list with an exception in it stops being a word list. It is asserted on its
    // own two lines below, so removing it does not quietly satisfy this row.
    const noreply = $('.rp-noreply', box);
    assert.ok(noreply, 'the screen does not state that there is no reply path');
    assert.includes(noreply.textContent, 'keine Antwortmöglichkeit');
    const clone = box.cloneNode(true);
    $('.rp-noreply', clone).remove();
    const text = clone.textContent.toLowerCase();
    for (const word of ['antworten', 'antwort schreiben', 'reply', 'nachricht senden', 'schreiben an']) {
      assert.equal(text.includes(word), false, `„Berichte" offers to ${word}`);
    }
    // The source half. `buildReportsSection` is the exported entry point; a compose field added
    // to it would be caught here even on a run where it rendered `hidden`.
    const src = String(admin.buildReportsSection);
    assert.equal(/textarea|createElement\(\s*['"]input/.test(src), false,
      'the section builder constructs an input — P10 is a claim about this file');
  } finally { reset(); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §D · THE DOT
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§D1 · ██ MEASURED ██ the dot is a pure function of two local prefs: ZERO requests', () => {
  // The whole design of the hint in one row. Nothing polls, nothing checks on launch, nothing
  // runs on a timer — so 21.5, P9 and `network-scope` §5b are untouched by it.
  reset();
  const b = fakeBridge({});
  try {
    admin.initReportsAdmin({ invoke: b.invoke });
    store.setSettings({ reportsAdmin: true, reportsKnown: ['rep_a'], reportsSeen: [] });
    assert.equal(admin.reportsHintActive(), true, 'an unopened report does not light the dot');
    admin.refreshReportsChrome();
    assert.equal(document.body.classList.contains('reports-hint'), true, 'the ⚙ shows nothing');
    store.setSettings({ reportsSeen: ['rep_a'] });
    admin.refreshReportsChrome();
    assert.equal(admin.reportsHintActive(), false, 'the dot survives having read everything');
    assert.equal(document.body.classList.contains('reports-hint'), false);
    assert.equal(b.count(), 0, `the dot cost ${b.count()} network requests`);
  } finally { reset(); }
});

test('§D2 · it survives a relaunch, because both halves are on disk and neither is a request', () => {
  // „the last time you looked, there were reports you had not opened" — which is what an unread
  // dot means in a mail client before it syncs, and the strongest thing local state can say.
  // The relaunch is simulated the only way a running page can: drop the class the way a fresh
  // document would have it, then let the boot-path function put it back from the prefs alone.
  reset();
  try {
    store.setSettings({ reportsAdmin: true, reportsKnown: ['rep_x', 'rep_y'], reportsSeen: ['rep_x'] });
    document.body.classList.remove('reports-hint');
    admin.refreshReportsChrome();          // `settings.js#applySettingsToBody`'s one line
    assert.equal(document.body.classList.contains('reports-hint'), true,
      'the dot did not come back from local state alone — it needs a request, which is the thing it must not need');
  } finally { reset(); }
});

test('§D3 · the flag is the outer gate: without it there is no dot, whatever the prefs say', () => {
  reset();
  try {
    store.setSettings({ reportsAdmin: false, reportsKnown: ['rep_a', 'rep_b'], reportsSeen: [] });
    assert.equal(admin.reportsHintActive(), false, 'a Mac that is not the admin can light the dot');
    admin.refreshReportsChrome();
    assert.equal(document.body.classList.contains('reports-hint'), false);
  } finally { reset(); }
});

test('§D4 · listing REPLACES `known`, so a deleted or swept report stops lighting it', () => {
  // The alternative — a union — would leave the dot lit for ever over a report that no longer
  // exists, and the only cure would be a „alles gelesen" button, which is a way to clear a dot
  // without reading anything.
  reset();
  try {
    store.setSettings({ reportsAdmin: true, reportsKnown: ['rep_old'], reportsSeen: [] });
    assert.equal(admin.reportsHintActive(), true, 'CONTROL: the old report lights it');
    admin.noteReportsKnown([]);            // the relay now holds nothing
    assert.deepEqual(store.state.settings.reportsKnown, []);
    assert.equal(admin.reportsHintActive(), false, 'a report that no longer exists still lights the dot');
    // and `seen` is pruned to what is still known, so it cannot grow without bound.
    admin.noteReportsKnown(['rep_1']);
    admin.markReportSeen('rep_1');
    admin.noteReportsKnown(['rep_2']);
    assert.deepEqual(store.state.settings.reportsSeen, [], '`seen` kept an id nothing knows about');
  } finally { reset(); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §M · THE MUTANTS — each naming the row that dies, plus the honest-path control
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§M · four defects, run rather than reasoned, and the control first', async () => {
  reset();
  try {
    // ── THE HONEST-PATH CONTROL. Without it every row below is satisfiable by a predicate that
    // says "no" to everything, which is exactly how a gate goes green while measuring nothing.
    store.setSettings({ reportsAdmin: true, reportsKnown: ['rep_a'], reportsSeen: [] });
    assert.equal(admin.reportsHintActive(), true, 'CONTROL: the shipped predicate lights the dot');
    store.setSettings({ reportsAdmin: true, reportsKnown: ['rep_a'], reportsSeen: ['rep_a'] });
    assert.equal(admin.reportsHintActive(), false, 'CONTROL: and clears it');
    reset();

    // ── M1 · „the binder ignores `originConfigured`" ⇒ §S1 dies. ────────────────────────────
    // The mutant is the shell answering as though a build with nothing pinned had an origin. If
    // `bindSoloSender` did not read the flag, this would bind — and §S1's count of zero would be
    // the row that noticed.
    const m1 = fakeBridge({ originConfigured: false });
    assert.equal(await relay.bindSoloSender(m1.invoke), 'no-origin');
    assert.equal(m1.count(), 0, 'M1: §S1 is not measuring the door');
    const m1b = fakeBridge({ originConfigured: true });
    assert.equal(await relay.bindSoloSender(m1b.invoke), 'bound',
      'M1-control: the binder refuses a CONFIGURED build too — §S1 would be vacuous');
    reset();

    // ── M2 · „the admin gate accepts a truthy flag" ⇒ §A1 dies. ─────────────────────────────
    // `reportsAdmin: 'true'` out of a hand-edited JSON file is the realistic shape of this. The
    // gate is `=== true`, so a string does not open it, and §A1 is what would catch a `!!`.
    for (const truthy of ['true', 1, 'yes', {}]) {
      store.setSettings({ reportsAdmin: truthy });
      assert.equal(admin.reportsAdminEnabled(), false, `M2: \`${JSON.stringify(truthy)}\` opened the admin view`);
    }
    store.setSettings({ reportsAdmin: true });
    assert.equal(admin.reportsAdminEnabled(), true, 'M2-control: the real flag no longer opens it');
    reset();

    // ── M3 · „a malformed id reaches a path" ⇒ §A6's shape assertion dies. ──────────────────
    // A report id arrives over a network. `relay.js#assertId` refuses anything that is not the
    // relay's own `rep_…` shape BEFORE it is concatenated, so a traversal or a second endpoint
    // cannot be built out of a reply.
    const m3 = fakeBridge({});
    const client = await relay.openReportsClient({ invoke: m3.invoke, credential: fakeCredential() });
    for (const bad of ['../ops', 'rep_short', '', 'rep_' + 'x'.repeat(23), 'ops']) {
      let threw = false;
      try { await client.one(bad); } catch { threw = true; }
      assert.equal(threw, true, `M3: the id ${JSON.stringify(bad)} became a request`);
    }
    assert.equal(m3.count(), 0, 'M3: a malformed id reached the bridge');
    let ok = false;
    try { await client.one(REPORT(1).id); ok = true; } catch { ok = false; }
    assert.equal(ok, true, 'M3-control: a WELL-FORMED id is refused too — the check is not a check');
    reset();

    // ── M4 · „the dot counts known instead of known \\ seen" ⇒ §D1 dies. ────────────────────
    // The plausible simplification — "light it when there are any reports" — is a dot that never
    // goes out, which is a dot somebody turns off.
    store.setSettings({ reportsAdmin: true, reportsKnown: ['rep_a', 'rep_b'], reportsSeen: ['rep_a', 'rep_b'] });
    assert.equal(admin.reportsHintActive(), false,
      'M4: the dot is lit with everything read — it is counting reports, not unread ones');
  } finally { reset(); }
});
