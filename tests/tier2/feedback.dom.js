// TIER 2 · LZP-1009 — „Rückmeldung senden", in the engine that ships.
//
// Plain script, not a module: `await importApp('x.js')`, no `import` statements, no top-level
// `return`. Globals: test, assert, $, $$, waitFor, sleep, importApp, diag, skip.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT ONLY THIS TIER CAN SAY
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `tests/tier1/feedback.test.js` proves the whole pipeline over a FAKE board — injected readers,
// hand-built nodes — because tier 1 has no DOM by design. Two claims survive that and cannot be
// made there, and they are the two this file exists for:
//
//   1. **THE SELECTORS MATCH A REAL BOARD.** `geometry.js` reads `.bar`, `.note`, `.day`,
//      `.d-more`, `.bar-label` … and `src/js/board.js` belongs to a PARALLEL WORKFLOW. A rename
//      there turns the report into a blank rectangle and every tier-1 row stays green, because
//      tier 1 supplies its own nodes. Here the nodes are `renderBoard`'s own.
//   2. **THE REAL TEXT IS REALLY ON THE BOARD AND REALLY NOT IN THE IMAGE.** Tier 1's needles are
//      strings a test put into a fake node. These are entries in the real store, laid out by the
//      real layout engine, measured by real `getBoundingClientRect` and real `Range` geometry.
//
// And one product claim that is a claim about a SCREEN and therefore has no tier-1 form at all:
//
//   3. **PRINCIPLE 10** — the entry point is in Einstellungen and there is NO button on the
//      board. Asserted by looking at the board.

const { store } = await importApp('store.js');
const { renderBoard } = await importApp('board.js');
const { openSettings } = await importApp('settings.js');
const { anySheetOpen, closeTopSheet } = await importApp('ui.js');
const i18n = await importApp('i18n.js');
const { collectPrimitives, assertNumericOnly, BOARD_SELECTORS } = await importApp('feedback/geometry.js');
const { renderRedactedBoard, pngDataUrl } = await importApp('feedback/redact.js');
const { buildReport, wireBody } = await importApp('feedback/report.js');
const { openFeedback, initFeedback } = await importApp('feedback/ui.js');
const { setFeedbackPort, canSend } = await importApp('feedback/port.js');
const { noteEvent, clearEvents } = await importApp('feedback/events.js');
const { c } = await importApp('feedback/copy.js');

const board = () => $('#board');
const redraw = () => renderBoard(board());

// ── the fixture, on the REAL board ───────────────────────────────────────────────────────────
// German, with umlauts, and each one a sentence a person would mind seeing on a stranger's desk.

const NEEDLE = {
  note: 'Scheidungsanwältin Dr. Kübler 14:30',
  bar: 'Kur in Bad Wörishofen',
  second: 'Diagnose F32.1 mittelgradig',
};

const addNote = (n) => store.mutate('fb:add-note', (s) => { s.notes.push(n); });
const addBar = (b) => store.mutate('fb:add-bar', (s) => { s.bars.push(b); });

function seed() {
  const day = $('.board .day[data-date]');
  const date = day.dataset.date;
  const key = date.slice(0, 7);
  const cat = store.state.categories[0].id;
  addNote({ id: 'fb-n1', date, text: NEEDLE.note, categoryId: cat, repeatsYearly: false });
  addNote({ id: 'fb-n2', date, text: NEEDLE.second, categoryId: cat, repeatsYearly: false });
  addBar({ id: 'fb-b1', startDate: `${key}-05`, endDate: `${key}-19`, label: NEEDLE.bar, categoryId: cat });
  redraw();
  return { date, key };
}

function unseed() {
  store.mutate('fb:clean', (s) => {
    s.notes = s.notes.filter((n) => !n.id.startsWith('fb-'));
    s.bars = s.bars.filter((b) => !b.id.startsWith('fb-'));
  });
  redraw();
  clearEvents();
  setFeedbackPort(null);
  while (anySheetOpen()) closeTopSheet();
  i18n.setLang('de');
}

/** Every byte of a PNG as one latin-1 character each — the spelling a byte plane holds. */
function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return s;
}

/** A needle's UTF-8 bytes, read back one byte per character. */
function utf8Spelling(s) {
  return latin1(new TextEncoder().encode(s));
}

/** The IDAT of a PNG, inflated. Returns null when the engine has no DecompressionStream. */
async function inflateIdat(png) {
  if (typeof DecompressionStream !== 'function') return null;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts = [];
  let off = 8;
  while (off + 12 <= png.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    if (type === 'IDAT') parts.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  if (!parts.length) return null;
  let total = 0;
  for (const p of parts) total += p.length;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { joined.set(p, at); at += p.length; }
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([joined]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · PRINCIPLE 10 — the board is not a messenger
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('there is NO feedback control on the board — not a button, not a badge, not a bubble', () => {
  // The half of Principle 10 that has no tier-1 form: it is a claim about a screen. Two reasons
  // it matters, and the second is the one that gets forgotten — a permanent widget makes the
  // tester permanently aware she is being studied, and she is using a calendar, not taking part
  // in a beta.
  const b = board();
  assert.ok(b, 'no board to look at');
  const suspects = $$('button, a, [role="button"]', b);
  const offenders = suspects.filter((n) => /rückmeldung|feedback|melden|report|hilfe|help/i
    .test(`${n.textContent} ${n.title || ''} ${n.className} ${n.getAttribute('aria-label') || ''}`));
  assert.deepEqual(offenders.map((n) => n.className), [],
    'the board grew a feedback control — Principle 10: it lives in Einstellungen/Hilfe');
  // and nowhere else on the page outside a sheet, either: no floating layer, no corner bubble.
  const floating = $$('body > button, body > .fab, body > [class*="feedback"], body > [class*="report"]');
  assert.deepEqual(floating.map((n) => n.className), [], 'a floating control was added to the page');
});

test('the ONLY way in is the Hilfe section of Einstellungen, and it is there', () => {
  openSettings();
  const sheet = $('.sheet');
  const titles = $$('.sheet-body .section-title', sheet).map((n) => n.textContent.trim());
  assert.includes(titles, c('de', 'sectionTitle'), 'Einstellungen has no Hilfe section');
  const btn = $$('.sheet-body button', sheet).find((n) => n.textContent.trim() === c('de', 'openButton'));
  assert.ok(btn, 'the Hilfe section has no „Rückmeldung senden …" button');
  closeTopSheet();
});

test('NOTHING AUTOMATIC — no timer, no beacon, no rating prompt appears on its own', async () => {
  // Principle 9, measured rather than asserted: a whole second of a live page with the module
  // loaded, and nothing opens, nothing is scheduled, nothing asks her anything.
  const before = $$('.scrim').length;
  await sleep(1000);
  assert.equal($$('.scrim').length, before, 'something opened a sheet by itself');
  const asks = $$('*').filter((n) => n.children.length === 0
    && /bewerte|gefällt dir|wie zufrieden|rate us|how likely/i.test(n.textContent || ''));
  assert.deepEqual(asks.map((n) => n.textContent), [], 'the product asked the user to rate it');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE SELECTORS MEET THE REAL BOARD
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('every BOARD_SELECTOR that should match a real board does', () => {
  // ██ THE ROW THAT CATCHES A PARALLEL WORKFLOW'S RENAME. ██ `board.js`, `layout.js` and
  // `app.css` are not this ticket's files. If `.bar-label` becomes `.bar-title`, the report
  // silently loses the bars — and every tier-1 row stays green, because tier 1 supplies its own
  // nodes. This is the only place the two can be compared.
  const { key } = seed();
  try {
    const b = board();
    const missing = [];
    for (const { sel, role } of BOARD_SELECTORS) {
      // Four roles are CONDITIONAL on the board's contents and one on its mode, so their
      // absence here is a fact about this fixture and not a broken selector:
      //   weekend/today — present on a real calendar, but not guaranteed inside a seeded month
      //   barcont       — only when a bar crosses a column boundary
      //   overflow      — only when a day swallows more entries than it can show
      //   rail          — ██ FAMILY MODE ONLY ██. `.chip` is the member-attribution mark and
      //                   `.neu-dot` the unseen marker; a SOLO board has neither, and this run is
      //                   solo. `tests/tier2/family-attribution.dom.js` is where a real chip
      //                   exists; the selector is checked against a real one there or nowhere.
      if (['weekend', 'today', 'barcont', 'overflow', 'rail'].includes(role)) continue;
      if ($$(sel, b).length === 0) missing.push(`${role} (${sel})`);
    }
    assert.deepEqual(missing, [],
      'these selectors match nothing on a real, seeded board — the report would be blank there:\n'
      + missing.join('\n'));
    diag('board key', key, '· cols', $$('.col', b).length, '· notes', $$('.note', b).length,
      '· bars', $$('.bar', b).length);
  } finally { unseed(); }
});

test('the walk over the REAL board yields numbers only, and a lot of them', () => {
  seed();
  try {
    const { prims, counts, w, h } = collectPrimitives(board());
    assertNumericOnly(prims);
    assert.ok(counts.rects > 300, `only ${counts.rects} rectangles from a 12-month board`);
    assert.ok(counts.redactions > 50, `only ${counts.redactions} redaction boxes — the day numbers alone are 372`);
    assert.ok(w > 200 && h > 200, `the board measured ${w}x${h}`);
    // The roles a report is FOR are all present, from the real DOM.
    for (const role of ['column', 'day', 'note', 'bar', 'redaction']) {
      assert.ok(counts.roles[role] > 0, `no ${role} rectangles came out of the real board`);
    }
    diag('primitives', counts.rects, 'redactions', counts.redactions, JSON.stringify(counts.roles));
  } finally { unseed(); }
});

test('a redaction box sits where the bar label was, at the label\'s own metrics', () => {
  // "The label overflows its bar" is exactly the bug class a report is for, and it is invisible
  // if the redaction is one rectangle the size of the bar. Measured against real line boxes.
  seed();
  try {
    const label = $('.bar .bar-label') || $('.bar-label');
    assert.ok(label, 'the real board has no .bar-label to redact');
    const lr = label.getBoundingClientRect();
    const br = board().getBoundingClientRect();
    const { prims } = collectPrimitives(board());
    const near = prims.filter((p) => p.role === 'redaction'
      && Math.abs(p.x - (lr.left - br.left)) < 4 && Math.abs(p.y - (lr.top - br.top)) < lr.height);
    assert.ok(near.length > 0, 'no redaction box covers the bar label — the label was not redacted');
    // ██ THE BOX IS CLIPPED THE WAY THE GLYPHS ARE. ██ `.bar-label` is `overflow: hidden` with a
    // `max-width`, and a `Range` reports the text's INTRINSIC width — 90px for a 66px chip. An
    // unclipped box would paint 24px of ink across board the label does not cover and the picture
    // would show a layout that does not exist. See `geometry.js`'s redaction pass.
    assert.ok(near[0].w > 0 && near[0].w <= lr.width + 2,
      `the box is ${near[0].w}px for a ${lr.width}px label — it is not clipped to its host`);
    assert.ok(near[0].w > lr.width * 0.4,
      `the box is only ${near[0].w}px of a ${lr.width}px label — it does not cover the text`);
  } finally { unseed(); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · THE REDACTED IMAGE, FROM THE REAL BOARD
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('THE TEXT IS ON THE BOARD — the fixture is not empty', () => {
  seed();
  try {
    const text = board().textContent;
    for (const [name, needle] of Object.entries(NEEDLE)) {
      assert.includes(text, needle, `${name} is not on the rendered board — the fixture proves nothing`);
    }
  } finally { unseed(); }
});

test('██ AND IT IS NOT IN THE IMAGE — not in the file, not in the inflated pixels ██', async () => {
  seed();
  try {
    const out = renderRedactedBoard(board());
    assert.deepEqual([...out.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'not a PNG');
    const file = latin1(out.bytes);
    for (const [name, needle] of Object.entries(NEEDLE)) {
      assert.equal(file.includes(needle), false, `${name} is in the PNG file`);
      assert.equal(file.includes(utf8Spelling(needle)), false, `${name} is in the PNG file as UTF-8`);
    }
    // ██ THE HALF A FILE SEARCH CANNOT REACH. ██ IDAT is DEFLATE, and DEFLATE Huffman-codes its
    // literals: a needle sitting plainly in the pixel buffer appears nowhere in the file. So the
    // stream is inflated by the ENGINE's own decompressor and the raster itself is searched.
    const raster = await inflateIdat(out.bytes);
    if (raster === null) {
      skip('this engine has no DecompressionStream; the file-level search above still ran');
    }
    assert.ok(raster.length > 1000, `the inflated raster is ${raster.length} bytes`);
    const plane = latin1(raster);
    for (const [name, needle] of Object.entries(NEEDLE)) {
      assert.equal(plane.includes(needle), false, `${name} IS IN THE PIXELS`);
      assert.equal(plane.includes(utf8Spelling(needle)), false, `${name} IS IN THE PIXELS as UTF-8`);
    }
    // NON-VACUITY on the inflater: it really did decompress something board-shaped.
    assert.equal(raster.length % (out.w + 1), 0, 'the inflated raster is not a whole number of scanlines');
    assert.equal(raster.length / (out.w + 1), out.h, 'the raster is not the image\'s own height');
    diag('image', out.w + 'x' + out.h, out.bytes.length + ' bytes', 'scale ' + out.scale,
      out.counts.redactions + ' boxes');
  } finally { unseed(); }
});

test('the image is small enough for the endpoint\'s own cap, from a full board', () => {
  seed();
  try {
    const out = renderRedactedBoard(board());
    assert.ok(out.bytes.length < 262144,
      `${out.bytes.length} bytes exceeds bytesPerFeedback — the endpoint would 413 a real board`);
    assert.ok(out.bytes.length > 500, 'the image is suspiciously empty');
    // and it survives being turned into what the preview screen shows.
    const url = pngDataUrl(out.bytes);
    assert.ok(url.startsWith('data:image/png;base64,'), 'the preview cannot display it');
    assert.ok(url.length > 600);
  } finally { unseed(); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · THE PREVIEW SCREEN
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Open the sheet, type `text`, and go to the preview. Returns the sheet. */
async function toPreview(text) {
  initFeedback({ screen: () => 'settings', now: () => 1_800_000_000_000 });
  openFeedback();
  const sheet = await waitFor(() => $('.scrim:last-of-type .sheet'), { what: 'the Rückmeldung sheet' });
  const ta = $('textarea.fb-text', sheet);
  assert.ok(ta, 'the write screen has no textarea');
  ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const next = $$('button', sheet).find((b) => b.textContent.trim() === c('de', 'next'));
  assert.ok(next, 'there is no „Weiter zur Vorschau" button');
  next.click();
  await waitFor(() => $('.scrim:last-of-type .sheet pre.fb-payload'), { what: 'the preview' });
  return $('.scrim:last-of-type .sheet');
}

test('her text is REQUIRED — an empty report cannot reach the preview', async () => {
  initFeedback({ screen: () => 'settings' });
  openFeedback();
  const sheet = await waitFor(() => $('.scrim:last-of-type .sheet'));
  try {
    const next = $$('button', sheet).find((b) => b.textContent.trim() === c('de', 'next'));
    next.click();
    await sleep(50);
    assert.equal($('pre.fb-payload'), null, 'an empty report reached the preview screen');
    const hint = $$('.hint', sheet).find((n) => n.textContent.includes('ohne Text wird nichts verschickt'));
    assert.ok(hint && !hint.hidden, 'she is not told why nothing happened');
  } finally { unseed(); }
});

test('██ THE PREVIEW IS THE PAYLOAD — the string on screen is the string on the wire ██', async () => {
  seed();
  try {
    noteEvent('render', { ms: 51 }, 1_800_000_000_000);
    const sheet = await toPreview('Der Balken springt beim Ziehen zurück.');
    const shown = $('pre.fb-payload', sheet).textContent;
    // Rebuilt through the same builder with the same inputs: the screen is not a summary.
    assert.includes(shown, 'Der Balken springt beim Ziehen zurück.');
    assert.includes(shown, 'LangzeitPlaner — Rückmeldung');
    assert.includes(shown, 'render ms=51');
    // ██ AND NOT ONE BOARD STRING IS IN IT. ██ This is the promise she is reading, checked
    // against the board that is behind the sheet.
    for (const [name, needle] of Object.entries(NEEDLE)) {
      assert.equal(shown.includes(needle), false, `${name} is on the preview screen`);
    }
    // The image she is shown is the redacted one, and it is really an image.
    const img = $('img.fb-shot', sheet);
    assert.ok(img, 'the preview shows no image');
    assert.ok(img.src.startsWith('data:image/png;base64,'), 'the preview image is not an inline PNG');
    assert.equal(img.src.includes(btoa(unescape(encodeURIComponent(NEEDLE.bar)))), false,
      'the bar label is in the preview image, b64-encoded');
  } finally { unseed(); }
});

test('the preview names what never goes, and says the picture was re-drawn', async () => {
  try {
    const sheet = await toPreview('Etwas stimmt nicht.');
    const text = sheet.textContent;
    assert.includes(text, 'Genau dieser Text und genau dieses Bild verlassen deinen Mac');
    assert.includes(text, 'neu gezeichnet, nicht abfotografiert');
    assert.includes(text, 'Was nie mitgeht');
    assert.includes(text, 'die Texte deiner Einträge und Notizen');
    assert.includes(text, 'deine Schlüssel');
    assert.equal($$('.fb-never li', sheet).length, 4, 'the „was nie mitgeht" list is not four lines');
  } finally { unseed(); }
});

test('THE FALLBACKS ARE THERE BEFORE THE FIRST ATTEMPT, not only after a failure', async () => {
  // "The relay being unreachable is itself worth reporting" — so the way out must not require
  // failing once to discover it.
  try {
    const sheet = await toPreview('Keine Verbindung.');
    const labels = $$('button', sheet).map((b) => b.textContent.trim());
    assert.includes(labels, c('de', 'copy'));
    assert.includes(labels, c('de', 'save'));
    assert.includes(labels, c('de', 'send'));
    assert.includes(labels, c('de', 'back'));
  } finally { unseed(); }
});

test('with NO RELAY CONFIGURED, „Senden" is DISABLED and the screen says why', async () => {
  // ─────────────────────────────────────────────────────────────────────────────────────────
  // ██ REWRITTEN 2026-09-05 · LZP-1009 SECOND PASS · it was GREEN BY A 40 ms RACE ██
  // ─────────────────────────────────────────────────────────────────────────────────────────
  //
  // WHAT IT SAID: 'with no sender bound, „Senden" is DISABLED and the screen says why', opening
  // with `assert.equal(canSend(), false, 'a sender is bound in this run — the row cannot measure
  // this')` and then reading the button on the next tick.
  //
  // `feedback/ui.js#openFeedback` now calls `bindSoloSender()` and DOES NOT AWAIT IT — the screen
  // must open at the speed of a screen. In this shell the bind lands about 40 ms later, and this
  // row read the button before it. It passed 20/20 on three runs, and it would have passed
  // 20/20 on a machine where the button was live by the time a person could see it. **A row that
  // is green because it is faster than the thing it measures is not measuring anything**, and
  // this project has a name for the failure of a green row over a changed product.
  //
  // WHAT IS MEASURED NOW is the state the sentence is actually about, made DETERMINISTIC rather
  // than raced: a build with NO RELAY ADDRESS. `relay.js#bindSoloSender` asks the bridge for
  // `sync_status` and returns 'no-origin' without opening its door when nothing is pinned — so a
  // bridge that answers nothing is exactly that build, and the wait below proves the binder ran
  // and declined rather than proving the scheduler was slow.
  const core = globalThis.window?.__TAURI__?.core;
  const real = core && core.invoke;
  let probed = false;
  if (core) core.invoke = async (cmd, args) => {
    if (cmd === 'sync_status') { probed = true; return { configured: false, originConfigured: false, origin: null, enabled: false }; }
    return real(cmd, args);
  };
  try {
    const sheet = await toPreview('Kein Familienkreis hier.');
    if (core) {
      await waitFor(() => probed, { what: 'the solo binder to ask the shell' });
      // …and having asked, it did NOT open its door: no origin, no `net.js`, no port.
    }
    assert.equal(canSend(), false,
      'a sender was bound against a build with no relay address — `bindSoloSender` opened its '
      + 'door on a `sync_status` that names no origin, which is the one case it must not');
    const send = $$('button', sheet).find((b) => b.textContent.trim() === c('de', 'send'));
    assert.equal(send.disabled, true, '„Senden" is enabled with nothing to send through');
    assert.includes(sheet.textContent, 'Dieser Mac kennt keine Gegenstelle',
      'the screen does not explain why sending is off');
    // The REASON moved with the product and the sentence had to move with it: it is no longer
    // „you have no Familienkreis" (a solo Mac may send now) but „this build has no address".
    assert.includes(sheet.textContent, 'In dieser Version ist keine Adresse hinterlegt',
      'the screen still blames the Familienkreis for a missing relay address');
  } finally {
    if (core) core.invoke = real;
    unseed();
  }
});

test('with a relay configured, the solo binder makes „Senden" LIVE — and sends nothing', async () => {
  // The other half of the row above, and the reversal PO decision 1 bought. Same screen, same
  // absence of a Familienkreis, an origin pinned — and the button lives. Written as a separate
  // row so that the two outcomes are two named rows rather than one row with a branch in it.
  const core = globalThis.window?.__TAURI__?.core;
  if (!core) return;                       // a browser has no bridge; §1a of e13 covers the shell
  const real = core.invoke;
  const seen = [];
  core.invoke = async (cmd, args) => {
    seen.push(cmd);
    if (cmd === 'sync_status') {
      return { configured: true, originConfigured: true, origin: 'https://relay.example.com', enabled: false };
    }
    return real(cmd, args);
  };
  try {
    const sheet = await toPreview('Ich komme nicht mehr rein.');
    await waitFor(() => canSend(), { what: 'the solo sender to be bound' });
    // The button is read AFTER a rebuild, which is what `openFeedback` schedules on a successful
    // bind. `waitFor` on the DOM rather than on a timer, for the reason the row above records.
    const live = await waitFor(() => {
      const s = $('.scrim:last-of-type .sheet');
      const b = $$('button', s).find((x) => x.textContent.trim() === c('de', 'send'));
      return b && !b.disabled ? b : null;
    }, { what: '„Senden" to become pressable' });
    assert.ok(live, '„Senden" never became pressable with an origin configured');
    assert.equal(seen.filter((x) => x === 'sync_request').length, 0,
      'the binder made a REQUEST. It binds a port; the one thing that sends is the click handler, '
      + 'and nobody has clicked. `network-scope.test.js` §5b counts the same property in source.');
    assert.ok(sheet, 'the preview vanished');
  } finally {
    core.invoke = real;
    unseed();
  }
});

test('with a sender bound, pressing „Senden" sends EXACTLY the previewed payload, once', async () => {
  seed();
  try {
    const sent = [];
    setFeedbackPort({
      send: async (body) => { sent.push(body); return { status: 202, body: { ok: true } }; },
      appVersion: '2.0.0', build: '1041', spaceKind: 'family',
    });
    const sheet = await toPreview('Beim Ziehen springt der Balken zurück.');
    const shown = $('pre.fb-payload', sheet).textContent;
    const send = $$('button', sheet).find((b) => b.textContent.trim() === c('de', 'send'));
    assert.equal(send.disabled, false, '„Senden" is disabled with a sender bound');
    send.click();
    await waitFor(() => sent.length === 1, { what: 'the send' });
    await sleep(60);
    assert.equal(sent.length, 1, `pressing once sent ${sent.length} reports`);
    // ██ THE IDENTITY, MEASURED ON THE WIRE. ██
    assert.equal(sent[0].report, shown, 'what was sent is not what she read');
    assert.deepEqual(Object.keys(sent[0]).sort(), ['image', 'report', 'v'],
      'the payload carries a field the preview did not show');
    assert.equal('to' in sent[0], false, 'the payload names a recipient');
    // and the whole body carries no board string, in either spelling.
    const hay = JSON.stringify(sent[0]);
    for (const [name, needle] of Object.entries(NEEDLE)) {
      assert.equal(hay.includes(needle), false, `${name} was sent`);
    }
  } finally { unseed(); }
});

test('a refused send offers the fallbacks and does not claim success', async () => {
  try {
    setFeedbackPort({ send: async () => ({ status: 429, body: { error: 'rate_limited' } }) });
    const sheet = await toPreview('Das Netz ist weg.');
    const send = $$('button', sheet).find((b) => b.textContent.trim() === c('de', 'send'));
    send.click();
    await waitFor(() => /später/.test(sheet.textContent), { what: 'the 429 message' });
    assert.includes(sheet.textContent, 'Bitte versuch es später');
    assert.equal(sheet.textContent.includes(c('de', 'sentTitle')), false,
      'a refused send reported success');
    // The preview is still on screen with the payload and both fallbacks intact.
    assert.ok($('pre.fb-payload', sheet), 'the payload vanished on failure — nothing to salvage');
    const labels = $$('button', sheet).map((b) => b.textContent.trim());
    assert.includes(labels, c('de', 'copy'));
    assert.includes(labels, c('de', 'save'));
  } finally { unseed(); }
});

test('a 413 explains that the report is NOT truncated', async () => {
  try {
    setFeedbackPort({
      send: async () => ({ status: 413, body: { error: 'payload_too_large', cap: 'bytesPerFeedback', max: 262144 } }),
    });
    const sheet = await toPreview('Zu groß.');
    $$('button', sheet).find((b) => b.textContent.trim() === c('de', 'send')).click();
    await waitFor(() => /gekürzt/.test(sheet.textContent), { what: 'the 413 message' });
    assert.includes(sheet.textContent, 'nicht gekürzt');
    assert.includes(sheet.textContent, 'gelogen');
  } finally { unseed(); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · BOTH LANGUAGES
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the whole flow is English on an English board, and no German survives', async () => {
  i18n.setLang('en');
  try {
    const sheet = await toPreviewEn('The bar jumps back a week when I drag it.');
    const text = sheet.textContent;
    assert.includes(text, 'This is what gets sent');
    assert.includes(text, 'Your plan, without a single letter');
    assert.includes(text, 'What never goes');
    assert.includes($('pre.fb-payload', sheet).textContent, 'LangzeitPlaner — feedback');
    assert.includes($('pre.fb-payload', sheet).textContent, 'What happened');
    assert.equal(/Rückmeldung|Vorschau|Verlauf|Zeitpunkt|Senden/.test(text), false,
      'German survived into the English screen: '
      + (text.match(/Rückmeldung|Vorschau|Verlauf|Zeitpunkt|Senden/) || [])[0]);
  } finally { unseed(); }
});

async function toPreviewEn(text) {
  initFeedback({ screen: () => 'settings', now: () => 1_800_000_000_000 });
  openFeedback();
  const sheet = await waitFor(() => $('.scrim:last-of-type .sheet'));
  const ta = $('textarea.fb-text', sheet);
  ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  $$('button', sheet).find((b) => b.textContent.trim() === c('en', 'next')).click();
  await waitFor(() => $('.scrim:last-of-type .sheet pre.fb-payload'), { what: 'the English preview' });
  return $('.scrim:last-of-type .sheet');
}

test('the Hilfe section is English too', () => {
  i18n.setLang('en');
  try {
    openSettings();
    const sheet = $('.sheet');
    const titles = $$('.sheet-body .section-title', sheet).map((n) => n.textContent.trim());
    assert.includes(titles, 'Help');
    const btn = $$('.sheet-body button', sheet).find((n) => n.textContent.trim() === 'Send feedback …');
    assert.ok(btn, 'the English Hilfe section has no button');
  } finally { unseed(); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · THE SEAM IS NOT A BACKDOOR
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the shipped page exposes NO feedback hook a page script could reach', () => {
  // `update-ui.dom.js`'s rule, applied to this seam: what must not exist is a GLOBAL, because a
  // settable sender is "here is where your family's board goes".
  for (const name of ['__lzpFeedback', 'lzpFeedback', 'feedback', 'setFeedbackPort', '__feedback',
    'sendFeedback', 'openFeedback']) {
    assert.equal(name in window, false, `window.${name} exists — the seam is a backdoor`);
  }
  const params = new URLSearchParams(location.search);
  for (const k of ['feedback', 'report', 'debug']) {
    assert.equal(params.has(k), false, `?${k}= is honoured — a URL can open the reporter`);
  }
});
