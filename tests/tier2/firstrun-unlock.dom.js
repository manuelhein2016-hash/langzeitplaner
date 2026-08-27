// TIER 2 · the first-run unlock screen — LZP-106. Story 22.2, amendment A12,
// design deliverable 27.
//
// Under PO decision D1 (ship unsigned) this screen is the only documented path
// onto a Mac that is not the developer's. Every assertion below is about one of
// three things:
//
//   · it does NOT appear on a healthy launch — the failure that would do real
//     damage is a calendar that greets people with a security screen;
//   · when it does appear, the macOS path it names is the right one, in both
//     languages, with no untranslated leakage;
//   · it obeys the product's own rules — no network, no external asset, not a
//     modal over the board, keyboard-dismissible, no motion.
//
// This runs in the real WKWebView, against the real index.html and the real
// stylesheet, because the whole deliverable is a rendering: a tier-1 test of
// this module could pass with an invisible screen.
//
// Plain script, not a module. Globals from the runner: test, assert, $, $$,
// waitFor, sleep, importApp, diag, skip.

const fr = await importApp('firstrun.js');
const i18n = await importApp('i18n.js');

const LS_KEY = 'langzeitplaner.unlock';
const layer = () => $('.unlock');
const text = () => layer()?.textContent || '';

/** Put the module back to a known state between tests; it owns exactly one key. */
function reset({ launches = 0, dismissedAt = null } = {}) {
  fr.closeUnlockHelp();
  localStorage.setItem(LS_KEY, JSON.stringify({ launches, dismissedAt }));
  i18n.setLang('de');
}

const blockedProbe = async () => ({ supported: true, blocked: true, reason: 'quarantine-block' });

// ── 1 · it stays away ────────────────────────────────────────────────────────

test('a healthy launch shows no unlock screen at all', async () => {
  // boot() already ran and already called maybeShowUnlock(); the harness waited
  // for the board. If the screen were speculative, it would be here now.
  assert.equal(layer(), null, 'the board launched cleanly and nothing covered it');
  assert.ok($('.board .col'), 'the board is what is on screen');
  assert.equal(document.body.classList.contains('unlock-on'), false);
});

test('against the REAL shell the probe reports "unsupported", so nothing is guessed', async () => {
  // This shell has no `gatekeeper_status` command yet (LZP-107 owns it). The
  // bridge rejects an unknown command; the module must read that as "we do not
  // know" and never as "blocked". This is the assertion that keeps the screen
  // honest while the native half is still missing.
  const p = await fr.probeHost();
  assert.equal(p.supported, false, 'an unimplemented command is not evidence of a block');
  assert.equal(p.blocked, false);
  assert.equal(fr.shouldAutoShow(p, { launches: 0, dismissedAt: null }), false);
});

test('the auto-show rule: only positive evidence, only once, never after a clean history', async () => {
  const fresh = { launches: 0, dismissedAt: null };
  assert.equal(fr.shouldAutoShow({ supported: true, blocked: true }, fresh), true,
    'the one case that shows it: the host says macOS refused this bundle');
  assert.equal(fr.shouldAutoShow({ supported: true, blocked: false }, fresh), false);
  assert.equal(fr.shouldAutoShow({ supported: false, blocked: false }, fresh), false,
    'no host, no screen — a browser preview must never show a Gatekeeper walkthrough');
  assert.equal(fr.shouldAutoShow({ supported: false, blocked: true }, fresh), false,
    '`blocked` from an unsupported host is not a signal');
  assert.equal(fr.shouldAutoShow({ supported: true, blocked: true },
    { launches: 0, dismissedAt: '2026-08-01T00:00:00.000Z' }), false,
    'dismissed once is dismissed forever');
  assert.equal(fr.shouldAutoShow({ supported: true, blocked: true },
    { launches: 7, dismissedAt: null }), false,
    'the app has opened before, so the unlock is behind this user, not ahead of them');
  assert.equal(fr.shouldAutoShow(null, fresh), false);
  assert.equal(fr.shouldAutoShow(undefined, undefined), false);
});

test('a blocked host shows it exactly once, and dismissal is remembered', async () => {
  reset();
  const shown = await fr.maybeShowUnlock({ probe: blockedProbe });
  assert.equal(shown, true, 'evidence of a block does show the screen');
  assert.ok(layer(), 'and it is really in the DOM');

  fr.closeUnlockHelp();
  assert.equal(layer(), null);
  const seen = JSON.parse(localStorage.getItem(LS_KEY));
  assert.ok(seen.dismissedAt, 'dismissing an auto-shown screen is written down');

  const again = await fr.maybeShowUnlock({ probe: blockedProbe });
  assert.equal(again, false, 'the same block does not show the screen a second time');
  assert.equal(layer(), null);
  reset();
});

test('a probe that throws is not a block, and does not take the boot down', async () => {
  reset();
  const shown = await fr.maybeShowUnlock({ probe: async () => { throw new Error('bridge gone'); } });
  assert.equal(shown, false);
  assert.equal(layer(), null);
  reset();
});

// ── 2 · what it says ─────────────────────────────────────────────────────────

test('it renders: title, lead, two numbered steps, two inline SVG illustrations', async () => {
  reset();
  fr.openUnlockHelp();
  assert.ok(layer(), 'the screen is on');
  assert.ok($('.unlock-title').textContent.length > 10);
  assert.ok($('.unlock-lead').textContent.length > 40);

  const steps = $$('.unlock-step');
  assert.equal(steps.length, 2, '22.2 — "in two illustrated steps", so: two');
  assert.deepEqual($$('.unlock-num').map((n) => n.textContent), ['1', '2']);
  for (const s of steps) {
    assert.ok($('h2', s), 'every step has a heading');
    assert.ok($('p', s).textContent.length > 30, 'and a sentence, not a label');
  }

  const figs = $$('.unlock-fig');
  assert.equal(figs.length, 2, 'one illustration per step');
  for (const f of figs) {
    assert.equal(f.namespaceURI, 'http://www.w3.org/2000/svg', 'inline SVG, not an image');
    assert.equal(f.getAttribute('role'), 'img');
    const titleId = f.getAttribute('aria-labelledby');
    assert.ok(titleId && $(`#${titleId}`, f), 'and it names itself for a screen reader');
    assert.ok(f.querySelectorAll('text').length >= 5,
      'the drawing carries the macOS words, it is not a decorative blob');
    // The whole point of the drawing is that it renders at a readable size.
    assert.ok(f.getBoundingClientRect().width > 200, 'and it is actually laid out');
  }
});

test('the German copy names the real macOS path — Systemeinstellungen → Datenschutz & Sicherheit → „Dennoch öffnen“', async () => {
  reset();
  fr.openUnlockHelp();
  const de = text();
  // Source: support.apple.com/de-de/102445. Each of these is a word the reader
  // has to find on their own screen; a wrong one strands them.
  for (const word of ['Systemeinstellungen', 'Datenschutz & Sicherheit', 'Sicherheit',
    'Dennoch öffnen', 'Öffnen']) {
    assert.includes(de, word, `the German path must contain “${word}”`);
  }
  // A12 — the bypass macOS 15 removed must not be taught anywhere on this screen.
  assert.equal(/[Rr]echtsklick|Control-?[Kk]lick|Ctrl-?[Kk]lick/.test(de), false,
    'the right-click → Öffnen folklore is gone from macOS 15 and must be gone from here');
  // Tone (brief): no exclamation marks, no blame, no error language.
  assert.equal(de.includes('!'), false, 'this is a normal step, not an alarm');
  assert.equal(/Fehler|fehlgeschlagen|Warnung|Achtung/.test(de), false,
    'nothing here is an error, and it must not read like one');
  // No jargon a non-technical reader would have to decode.
  assert.equal(/Gatekeeper|Quarantäne|quarantine|Signatur|notariz|Notariz|xattr|Terminal/.test(de),
    false, 'no jargon on the one screen a non-technical family member has to get through');
});

test('the English copy names the real macOS path — System Settings → Privacy & Security → Open Anyway', async () => {
  reset();
  fr.openUnlockHelp();
  const before = text();
  $('.unlock-lang').click();

  const en = text();
  assert.equal(i18n.getLang(), 'en', '13.7 — the toggle really switches the language');
  for (const word of ['System Settings', 'Privacy & Security', 'Security', 'Open Anyway', 'Open']) {
    assert.includes(en, word, `the English path must contain “${word}”`);
  }
  assert.equal(en.includes('!'), false);
  assert.equal(/right-?click|Control-?click/i.test(en), false);

  // And the two languages must actually be two languages: no German left in the
  // English screen, which is the failure mode a partly-translated table gives.
  assert.notEqual(en, before);
  for (const german of ['Systemeinstellungen', 'Dennoch öffnen', 'Das ist normal',
    'In den Papierkorb', 'Verstanden']) {
    assert.equal(en.includes(german), false, `“${german}” leaked into the English screen`);
  }

  // …and back, because a reader who toggled by accident has to get home.
  $('.unlock-lang').click();
  assert.equal(i18n.getLang(), 'de');
  assert.includes(text(), 'Dennoch öffnen');
});

test('the language toggle is ON this screen, because Settings is behind it', async () => {
  reset();
  fr.openUnlockHelp();
  const btn = $('.unlock-lang');
  assert.ok(btn, '13.7 — a reader who cannot read this screen cannot reach ⌘, to change the language');
  assert.equal(btn.textContent, 'English', 'German first, and the toggle names its destination');
});

test('the recovery for the missing button is present — the one that decides whether Mom gets in', async () => {
  reset();
  fr.openUnlockHelp();
  // macOS 15+ only offers the button for a window after a launch attempt
  // (heise, Sweetwater). Without this sentence, a reader who looks too late
  // finds an empty Security section and concludes the app is broken.
  assert.ok($('.unlock-note'), 'the recovery note exists');
  assert.includes($('.unlock-note').textContent, 'Dennoch öffnen');
  assert.ok($('.unlock-note').textContent.length > 60, 'and it says what to do, not just that it happens');
});

// ── 3 · how it behaves ───────────────────────────────────────────────────────

test('it is a screen, not a dialog over the board (v1 design language)', async () => {
  reset();
  fr.openUnlockHelp();
  const cs = getComputedStyle(layer());
  assert.equal(cs.position, 'fixed');
  assert.equal($$('.scrim').length, 0, 'no scrim: dialogs are for destructive and rare, this is neither');
  const bg = cs.backgroundColor;
  assert.equal(/rgba\([^)]*,\s*0(\.\d+)?\)/.test(bg), false, `the surface is opaque, got ${bg}`);
  assert.equal(cs.backdropFilter === 'blur(1.5px)', false, 'no blurred calendar behind a security warning');
  assert.equal(layer().getAttribute('aria-modal'), 'true');
  assert.ok(document.body.classList.contains('unlock-on'), 'the page behind it does not scroll');
});

test('Escape closes it, and closing leaves no trace on the body', async () => {
  reset();
  fr.openUnlockHelp();
  assert.ok(layer());
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(layer(), null, 'keyboard-dismissible');
  assert.equal(document.body.classList.contains('unlock-on'), false);
  assert.equal(fr.unlockOpen(), false);
});

test('focus lands on the button, and Tab cannot escape into the board behind it', async () => {
  reset();
  fr.openUnlockHelp();
  assert.ok(document.activeElement.classList.contains('unlock-ok'),
    'the reader can dismiss it without hunting for the mouse');
  const buttons = $$('.unlock button');
  assert.ok(buttons.length >= 2);
  for (let i = 0; i < buttons.length + 2; i++) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    assert.ok(layer().contains(document.activeElement),
      'focus stayed inside the screen after ' + (i + 1) + ' tabs');
  }
});

test('Reduce Motion: nothing on this screen animates or transitions', async () => {
  reset();
  fr.openUnlockHelp();
  // The screen carries no entrance animation at all — that is the design, and
  // the reduced-motion rule is the belt to that braces.
  for (const n of [layer(), $('.unlock-card'), $('.unlock-step'), $('.unlock-ok')]) {
    const cs = getComputedStyle(n);
    assert.equal(cs.animationName, 'none', 'no animation on ' + n.className);
  }
  const rule = [...document.styleSheets]
    .flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
    .some((r) => r.media && String(r.media.mediaText).includes('reduced-motion')
      && String(r.cssText).includes('.unlock'));
  assert.ok(rule, 'and the rule is written down, so a later addition cannot forget it');
});

// ── 4 · CSP and the zero-network promise (13.4 / 21.5) ───────────────────────

test('the screen loads nothing: no <img>, no external URL, no webfont', async () => {
  reset();
  fr.openUnlockHelp();
  assert.equal($$('.unlock img, .unlock image, .unlock iframe, .unlock object').length, 0,
    'the illustrations are inline SVG because the CSP forbids everything else');
  const html = layer().innerHTML;
  assert.equal(/https?:\/\//.test(html), false, 'no absolute URL anywhere in the screen');
  assert.equal(/url\((?!#)/.test(html), false,
    'the only url() references are same-document gradient ids');
  assert.equal(/<script/i.test(html), false);
});

test('an off-origin fetch really is blocked — the promise the screen relies on', async () => {
  // 21.5 / rule 3: this is not about the screen's own code, it is about the
  // page it lives on. If the CSP were not enforced here, "the board never goes
  // online" would be a habit rather than a property.
  let blocked = false;
  try {
    await fetch('https://example.com/lzp-csp-probe');
  } catch {
    blocked = true;
  }
  assert.equal(blocked, true, 'default-src \'self\' cancels an off-origin request');
});

// ── 5 · the copy that reaches the blocked moment ─────────────────────────────

test('renderUnlockDocument() is a self-contained, script-free, both-language page', async () => {
  reset();
  const doc = fr.renderUnlockDocument();
  assert.match(doc, /^<!doctype html>/i);
  assert.equal(/<script/i.test(doc), false, 'it is opened from a DMG in Safari; it must not need JS');
  assert.equal(/https?:\/\//i.test(doc), false, 'and it must not reach for anything');
  assert.equal(/<img|<iframe/i.test(doc), false);
  // Both languages, because the file on the disk image has no toggle to click.
  assert.includes(doc, 'Dennoch öffnen');
  assert.includes(doc, 'Open Anyway');
  assert.includes(doc, 'Systemeinstellungen');
  assert.includes(doc, 'System Settings');
  assert.includes(doc, 'lang="en"');
  // The styles come from the app's own sheet, so the DMG page cannot drift.
  assert.includes(doc, '--ink-1');
  assert.includes(doc, '.unlock-step');
  assert.ok(doc.length > 8000, 'a complete page, not a stub');
});

test('exporting the document leaves the running app in the language it was in', async () => {
  reset();
  i18n.setLang('en');
  fr.renderUnlockDocument();
  assert.equal(i18n.getLang(), 'en', 'the exporter borrows the language table and gives it back');
  i18n.setLang('de');
  fr.renderUnlockDocument();
  assert.equal(i18n.getLang(), 'de');
});

// ── 6 · it survives a small window ───────────────────────────────────────────

test('at a narrow width the steps stack and nothing overflows sideways', async () => {
  reset();
  fr.openUnlockHelp();
  const card = $('.unlock-card');
  const wide = getComputedStyle($('.unlock-steps')).gridTemplateColumns;
  assert.equal(wide.split(' ').length, 2, 'two columns while there is room');

  // The media query keys off the viewport, which a test cannot resize here, so
  // the stacking is asserted the only honest way available: the rule exists and
  // the layout does not already overflow at the width we have.
  const stack = [...document.styleSheets]
    .flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
    .filter((r) => r.media && String(r.media.mediaText).includes('max-width'))
    .some((r) => String(r.cssText).includes('.unlock-steps')
      && /grid-template-columns:\s*1fr\b/.test(String(r.cssText)));
  assert.ok(stack, 'a narrow window collapses the two steps into one column');

  assert.ok(card.scrollWidth <= card.clientWidth + 1,
    `the card does not scroll sideways (${card.scrollWidth} vs ${card.clientWidth})`);
  assert.ok(document.documentElement.scrollWidth <= window.innerWidth + 1,
    'and neither does the page');
  for (const f of $$('.unlock-fig')) {
    const r = f.getBoundingClientRect();
    assert.ok(r.right <= window.innerWidth + 1, 'no illustration hangs off the right edge');
  }
  reset();
});

test('Settings offers the walkthrough forever, not just on a first run', async () => {
  // Under D1 this is the screen the PO points at over the phone. A one-shot
  // that a dismissed first run puts out of reach would be useless for that.
  reset();
  const { openSettings } = await importApp('settings.js');
  openSettings();
  const entry = $$('.sheet-body button').find((b) => b.textContent === i18n.t('gatekeeper'));
  assert.ok(entry, 'the settings sheet has a way back to the unlock screen');
  entry.click();
  await waitFor(() => layer(), { what: 'the unlock screen from Settings' });
  assert.ok(layer());
  assert.equal(JSON.parse(localStorage.getItem(LS_KEY)).dismissedAt, null,
    'opening it by hand is not the auto-show, and closing it must not burn the one auto-show');
  fr.closeUnlockHelp();
  assert.equal(JSON.parse(localStorage.getItem(LS_KEY)).dismissedAt, null);
  reset();
});
