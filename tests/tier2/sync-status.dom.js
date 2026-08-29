// TIER 2 · the three sync states — LZP-504. Story 19.3, deliverable 20. `sync.contract.js` §4.
//
// ═════════════════════════════════════════════════════════════════════════════
// MOST OF THIS FILE ASSERTS AN ABSENCE
// ═════════════════════════════════════════════════════════════════════════════
//
//   19.3  "Sync status is silent when healthy; only pending-offline or a real error produces a
//          small, unobtrusive indicator — v1's 'silence is the design' (F11) extends to the
//          network."
//
// A feature whose specification is mostly "nothing appears" is a feature whose tests are mostly
// negative, and negative tests have a specific failure mode: they pass on a broken build, because
// a module that does nothing at all also shows nothing at all. So every absence asserted here is
// paired with a PRESENCE in the same test — the node is gone in `healthy` AND arrives in
// `pending`, nothing is on the board AND something is in the toolbar. A green run therefore means
// the silence is chosen, not accidental.
//
// The engine is a fake, and it has to be: `src/js/sync/` is LZP-501/502's and does not exist yet.
// It is injected the way every collaborator in this app is injected — `initSyncStatus({sync})`,
// exactly the call the family opt-in moment will make — so there is no seam code in the shipped
// product and no `window.__lzpSync` for a page script to reach. Test 0 keeps that true.
//
// What tier 1 will own and this file does not: what MAKES a status pending or error — the
// backoff, the failure counting, the cursor. This file owns what a person sees when it does.

const status = await importApp('family/syncstatus.js');
const i18n = await importApp('i18n.js');

// ═════════════════════════════════════════════════════════════════════════════
// 0 · scaffolding
// ═════════════════════════════════════════════════════════════════════════════

function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    schedule: (ms, fn) => { const h = { at: t + ms, fn, dead: false }; timers.push(h); return h; },
    unschedule: (h) => { if (h) h.dead = true; },
    advance(ms) {
      t += ms;
      for (let guard = 0; guard < 64; guard++) {
        const due = timers.filter((x) => !x.dead && x.at <= t).sort((a, b) => a.at - b.at);
        if (!due.length) return;
        due[0].dead = true;
        due[0].fn();
      }
    },
  };
}

/**
 * The engine, as `sync.contract.js` §4 declares it — narrowed to the two methods this module is
 * given. Note what it does NOT have: `start`, `stop`, `pushNow`, `pullNow`. 19.2 says there is no
 * sync button anywhere, and a UI module that is structurally incapable of triggering a request
 * cannot grow one by accident.
 */
function makeEngine(initial = {}) {
  let s = {
    state: 'healthy', pendingOps: 0, consecutiveFailures: 0,
    lastPullAt: null, errorKind: null, detail: null, ...initial,
  };
  const subs = new Set();
  const reads = [];
  return {
    reads,
    port: {
      status() { reads.push(s.state); return { ...s }; },
      subscribe(f) { subs.add(f); return () => subs.delete(f); },
    },
    set(patch) {
      s = { ...s, ...patch };
      for (const f of [...subs]) f();
    },
  };
}

let clock = null;
function mount(engine, over = {}) {
  clock = fakeClock();
  status.initSyncStatus({
    sync: engine ? engine.port : null,
    now: clock.now, schedule: clock.schedule, unschedule: clock.unschedule, ...over,
  });
  status.refreshSyncChrome();
  return clock;
}
function unmount() {
  status.initSyncStatus({});
  i18n.setLang('de');
}

const glyph = () => document.getElementById(status.SYNC_GLYPH_ID);
/** Settle a state change past the debounce window and let the timer redraw. */
function settle(c) {
  c.advance(status.SYNC_DEBOUNCE_MS);
  status.refreshSyncChrome();
}

// ═════════════════════════════════════════════════════════════════════════════
// 0 · the seam is a seam
// ═════════════════════════════════════════════════════════════════════════════

test('the shipped page exposes no sync hook, and no sync control anywhere', () => {
  for (const k of ['__lzpSync', '__lzpSyncStatus', '__lzpSyncClient', 'sync', 'syncClient', 'syncStatus']) {
    assert.equal(window[k], undefined, `window.${k} must not exist`);
  }
  // 19.2, asserted against the whole shipped chrome rather than against this module's intentions:
  // no control anywhere offers to sync, refresh or retry.
  const labels = $$('button, [role="button"]').map((n) => `${n.textContent} ${n.title || ''}`.toLowerCase());
  for (const word of ['sync', 'abgleich', 'refresh', 'aktualisieren', 'neu laden', 'erneut']) {
    const hit = labels.find((l) => l.includes(word));
    assert.equal(hit, undefined, `a control offers to ${word}: ${hit}`);
  }
  assert.equal(status.syncSupported(), false, 'nothing is mounted until someone mounts it');
});

// ═════════════════════════════════════════════════════════════════════════════
// 1 · healthy is NOTHING
// ═════════════════════════════════════════════════════════════════════════════

test('healthy draws no node at all — not a tick, not an empty slot', () => {
  const engine = makeEngine({ state: 'healthy' });
  const c = mount(engine);

  assert.equal(glyph(), null, 'healthy put something on screen');
  assert.equal($$('.sync-dot').length, 0, 'healthy left a slot behind');
  assert.equal(status.syncStatusState().state, 'healthy');

  // The paired PRESENCE, so this test cannot pass on a module that draws nothing ever.
  engine.set({ state: 'pending', pendingOps: 2 });
  settle(c);
  assert.ok(glyph(), 'pending drew nothing — the absence above proves nothing');

  // …and going back to healthy REMOVES it again, immediately. Good news is silent and instant:
  // a glyph that outlives its condition is the one way a quiet signal can lie.
  engine.set({ state: 'healthy', pendingOps: 0 });
  status.refreshSyncChrome();
  assert.equal(glyph(), null, 'the glyph outlived the condition');
  assert.equal(status.syncStatusState().state, 'healthy');

  unmount();
});

test('solo mode has no engine, no node, and never asks one anything', () => {
  mount(null);
  assert.equal(status.syncSupported(), false);
  assert.equal(glyph(), null);
  const s = status.syncStatusState();
  assert.equal(s.supported, false);
  assert.equal(s.state, 'healthy');
  // Absent, not broken — and it says which. 21.5: solo mode talks to nothing, and the sentence a
  // user finds in settings says exactly that rather than implying sync is switched off somewhere.
  assert.equal(s.sentence, i18n.t('syncSolo'));
  const body = document.createElement('div');
  status.buildSyncSection(body, {});
  assert.includes(body.textContent, i18n.t('syncSolo'));
  assert.equal($$('button', body).length, 0, 'solo mode offered a control');
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 · pending is a small hollow ring, and it is calm
// ═════════════════════════════════════════════════════════════════════════════

test('pending is one 6 px hollow glyph in the toolbar, with no number on it', () => {
  const engine = makeEngine({ state: 'pending', pendingOps: 3 });
  const c = mount(engine);
  settle(c);

  const g = glyph();
  assert.ok(g, 'pending drew nothing');
  assert.equal(g.parentElement.className, 'toolbar', 'the glyph is not in the toolbar');
  assert.equal(g.classList.contains('pending'), true);
  assert.equal(g.classList.contains('error'), false);

  const cs = getComputedStyle(g);
  assert.equal(cs.width, '6px', `the glyph is ${cs.width} wide`);
  assert.equal(cs.height, '6px');
  // HOLLOW — `sync.contract.js` §4's word. A filled dot is what `error` gets, and the two states
  // have to be distinguishable at 6 px without colour vision.
  assert.equal(cs.backgroundColor, 'rgba(0, 0, 0, 0)', `pending is filled: ${cs.backgroundColor}`);
  assert.notEqual(cs.borderTopWidth, '0px', 'a hollow glyph with no ring is an invisible glyph');

  // A DOT, NOT A BADGE COUNT — the addendum's design note, filed with the „neu" dot and the
  // update hint. Three waiting changes is a sentence in settings, never a numeral in chrome.
  assert.equal(g.textContent, '', `the glyph carries text: ${g.textContent}`);
  assert.equal(/\d/.test(g.textContent), false);
  // The whole vocabulary of the chrome is the tooltip.
  assert.includes(g.title, '3');
  assert.equal(g.getAttribute('role'), 'status');
  // `role="alert"` interrupts a screen reader. Being offline with your work safe is not an
  // interruption, and `aria-live` would make the quiet signal audible on every save.
  assert.equal(g.hasAttribute('aria-live'), false);

  unmount();
});

test('pending says the work is safe, not that something is wrong', () => {
  const engine = makeEngine({ state: 'pending', pendingOps: 1 });
  const c = mount(engine);
  settle(c);
  for (const lang of ['de', 'en']) {
    i18n.setLang(lang);
    status.refreshSyncChrome();
    const sentence = status.syncStatusState().sentence;
    assert.equal(sentence, i18n.t('syncPendingDetail', 1));
    // The word that has to be in it: the change is not lost.
    assert.match(sentence, lang === 'de' ? /gesichert/ : /safe/);
    // The words that must not be: this is not an error and does not ask for anything.
    assert.equal(/fehler|error|failed|warning|achtung/i.test(sentence), false, `${lang}: ${sentence}`);
  }
  // Singular and plural are different sentences in both languages.
  i18n.setLang('de');
  assert.notEqual(i18n.t('syncPendingDetail', 1), i18n.t('syncPendingDetail', 4));
  engine.set({ pendingOps: 0 });
  status.refreshSyncChrome();
  assert.equal(status.syncStatusState().sentence, i18n.t('syncPendingNone'));
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 3 · error is the SAME slot, filled, and never red
// ═════════════════════════════════════════════════════════════════════════════

test('error fills the same 6 px in the same place — no second glyph, no bar, no modal', () => {
  const engine = makeEngine({ state: 'pending', pendingOps: 1 });
  const c = mount(engine);
  settle(c);
  const wasAt = glyph().previousElementSibling;

  engine.set({ state: 'error', errorKind: 'auth' });
  settle(c);

  const g = glyph();
  assert.equal($$('.sync-dot').length, 1, 'error added a second signal instead of changing the first');
  assert.equal(g.previousElementSibling, wasAt, 'the glyph moved when the state changed');
  assert.equal(g.classList.contains('error'), true);
  assert.equal(g.classList.contains('pending'), false);

  const cs = getComputedStyle(g);
  assert.equal(cs.width, '6px', 'error is a different size from pending');
  assert.notEqual(cs.backgroundColor, 'rgba(0, 0, 0, 0)', 'error must be the FILLED state');
  // Calm, never red-alert (`sync.contract.js` §4). Red says "your board is broken"; the board is
  // fine — every note, bar and scratchpad still works, still saves, still prints. The tone is the
  // amber-brown `app.css` already spends on the 22.7 outdated bar.
  const rgb = cs.backgroundColor.match(/\d+/g).map(Number);
  assert.ok(rgb[1] > 90 && rgb[2] > 20, `error is a red alert: ${cs.backgroundColor}`);

  // No other surface appeared. An error is worth 6 px and a tooltip, and nothing else.
  assert.equal($('.scrim'), null, 'a sheet opened over a sync error');
  assert.equal($('.toast.show'), null, 'a toast fired for a sync error');
  assert.equal($$('.update-bar').length, 0);

  unmount();
});

test('every errorKind has its own plain sentence, in both languages, and none of them nags', () => {
  const engine = makeEngine();
  const c = mount(engine);
  for (const kind of status.SYNC_ERROR_KINDS) {
    engine.set({ state: 'error', errorKind: kind, detail: null });
    settle(c);
    const de = (() => { i18n.setLang('de'); status.refreshSyncChrome(); return status.syncStatusState().sentence; })();
    const en = (() => { i18n.setLang('en'); status.refreshSyncChrome(); return status.syncStatusState().sentence; })();
    assert.ok(de.length > 20, `${kind}: the German sentence is a stub`);
    assert.notEqual(de, en, `${kind}: identical in both tables — an untranslated leftover`);
    // One sentence, plain language, no error code, no jargon, no imperative shouting.
    assert.equal(/[A-Z_]{4,}|\bHTTP\b|\b4\d\d\b|\b5\d\d\b/.test(de + en), false,
      `${kind}: leaked a code or a status number: ${de} / ${en}`);
    assert.equal(/!/.test(de + en), false, `${kind}: an exclamation mark`);
    assert.equal(glyph().title, en, `${kind}: the tooltip and the sentence disagree`);
  }
  // An unknown kind falls back to a sentence, never to a blank tooltip.
  i18n.setLang('de');
  engine.set({ state: 'error', errorKind: 'something-new', detail: null });
  settle(c);
  assert.equal(status.syncStatusState().sentence, i18n.t('syncErrGeneric'));
  assert.equal(status.syncStatusState().errorKind, null, 'an unknown kind was passed through');

  // The engine's own `detail` wins when it has one — it can say what the table cannot — and it
  // replaces the generic sentence rather than stacking on top of it.
  engine.set({ state: 'error', errorKind: 'offline', detail: 'Der Server in Frankfurt antwortet nicht.' });
  settle(c);
  assert.equal(status.syncStatusState().sentence, 'Der Server in Frankfurt antwortet nicht.');
  assert.equal(glyph().title.includes(i18n.t('syncErrOffline')), false, 'both sentences were shown');

  unmount();
});

test('an engine that throws becomes a visible error, not a silent healthy', () => {
  // The quiet-signal design has one catastrophic failure mode: a bug that makes everything quiet.
  // `status()` throwing is the shape that bug takes, and it must fail LOUD-ish rather than closed.
  const port = { status() { throw new Error('the engine is on fire'); } };
  clock = fakeClock();
  status.initSyncStatus({ sync: port, now: clock.now, schedule: clock.schedule, unschedule: clock.unschedule });
  status.refreshSyncChrome();
  settle(clock);
  assert.equal(status.syncStatusState().rawState, 'error');
  assert.ok(glyph(), 'a throwing engine drew nothing at all');
  assert.equal(glyph().classList.contains('error'), true);
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 4 · the debounce, and its asymmetry
// ═════════════════════════════════════════════════════════════════════════════

test('an ordinary push does not flicker the glyph — appearing waits, vanishing does not', () => {
  const engine = makeEngine({ state: 'healthy' });
  const c = mount(engine);

  // A save queues an op. `pendingOps` is non-zero for a moment; nothing must appear.
  engine.set({ state: 'pending', pendingOps: 1 });
  status.refreshSyncChrome();
  assert.equal(glyph(), null, 'the glyph appeared instantly and will now blink');
  c.advance(status.SYNC_DEBOUNCE_MS - 1);
  status.refreshSyncChrome();
  assert.equal(glyph(), null, 'the debounce window is shorter than it claims');

  // The push lands inside the window. The user never saw anything, which is the definition of
  // healthy — not a missed notification.
  engine.set({ state: 'healthy', pendingOps: 0 });
  status.refreshSyncChrome();
  assert.equal(glyph(), null);
  c.advance(10 * status.SYNC_DEBOUNCE_MS);
  status.refreshSyncChrome();
  assert.equal(glyph(), null, 'a resolved condition drew its glyph late');

  // A condition that PERSISTS past the window does appear — and appears on its own, from the
  // module's own timer, without anything else redrawing.
  engine.set({ state: 'pending', pendingOps: 2 });
  status.refreshSyncChrome();
  assert.equal(glyph(), null);
  c.advance(status.SYNC_DEBOUNCE_MS);
  assert.ok(glyph(), 'the glyph never arrived without an external redraw');

  // And it leaves the instant the condition does.
  engine.set({ state: 'healthy', pendingOps: 0 });
  status.refreshSyncChrome();
  assert.equal(glyph(), null);

  assert.equal(status.SYNC_DEBOUNCE_MS, 2000, 'CADENCE.statusDebounceMs is 2000 in sync.contract.js');
  assert.equal(status.syncDebounceMs(), 2000, 'the default window is not the contract window');
  unmount();
});

test('the window is injectable, because `sync/client.js` already debounces and `personal.js` does not', () => {
  // Stacked with an engine that debounces its own emission (ADR 003 §8.3), the full window would
  // take four seconds to show a glyph. `debounce: 0` is the host's escape, and it has to be a
  // real one rather than a comment — this asserts the wiring, not the intention.
  const engine = makeEngine({ state: 'healthy' });
  const c = mount(engine, { debounce: 0 });
  assert.equal(status.syncDebounceMs(), 0);
  engine.set({ state: 'pending', pendingOps: 1 });
  status.refreshSyncChrome();
  assert.ok(glyph(), 'debounce:0 still waited');

  // And re-mounting without the option restores the contract window rather than remembering 0 —
  // module state that survives a re-init is how a test option reaches production.
  unmount();
  const c2 = mount(engine);
  assert.equal(status.syncDebounceMs(), status.SYNC_DEBOUNCE_MS);
  status.refreshSyncChrome();
  assert.equal(glyph(), null, 'the injected 0 leaked into the next mount');
  c2.advance(status.SYNC_DEBOUNCE_MS);
  assert.ok(glyph());
  void c;
  unmount();
});

test('pending escalating to error also waits, so one failed request does not become a warning', () => {
  const engine = makeEngine({ state: 'pending', pendingOps: 1 });
  const c = mount(engine);
  settle(c);
  assert.equal(glyph().classList.contains('pending'), true);

  engine.set({ state: 'error', errorKind: 'offline' });
  status.refreshSyncChrome();
  assert.equal(glyph().classList.contains('pending'), true, 'the escalation was instant');
  assert.equal(glyph().classList.contains('error'), false);

  // A retry succeeds inside the window: the user never saw the word "error".
  engine.set({ state: 'pending', errorKind: null });
  c.advance(status.SYNC_DEBOUNCE_MS);
  status.refreshSyncChrome();
  assert.equal(glyph().classList.contains('error'), false, 'a recovered blip showed as an error');
  assert.equal(glyph().classList.contains('pending'), true);

  // A failure that persists does escalate.
  engine.set({ state: 'error', errorKind: 'offline' });
  settle(c);
  assert.equal(glyph().classList.contains('error'), true, 'a persistent failure never escalated');
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 5 · never a spinner, never on the board
// ═════════════════════════════════════════════════════════════════════════════

test('nothing this feature draws is inside the board, and nothing it draws moves', () => {
  const engine = makeEngine({ state: 'error', errorKind: 'offline' });
  const c = mount(engine);
  settle(c);

  const board = $('.board');
  assert.ok(board, 'the board is not rendered — this assertion would be vacuous');
  assert.equal(board.querySelector('.sync-dot'), null, 'a sync glyph is on the board');
  assert.equal(board.querySelector(`#${status.SYNC_GLYPH_ID}`), null);
  // The generic form: no descendant of the board carries any class this module invents.
  assert.equal($$('.board [class*="sync"]').length, 0, 'this feature reached the board');

  // "NEVER a spinner" — stated twice in the addendum. A spinner is motion; there is none, in
  // either state, and `@media (prefers-reduced-motion)` in the stylesheet is belt over braces.
  for (const st of ['pending', 'error']) {
    engine.set({ state: st, errorKind: st === 'error' ? 'offline' : null });
    settle(c);
    const cs = getComputedStyle(glyph());
    assert.equal(cs.animationName, 'none', `${st} animates`);
    assert.equal(cs.transitionDuration, '0s', `${st} transitions`);
  }
  assert.includes(status.SYNC_CSS, 'prefers-reduced-motion');

  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 6 · the settings section — prose, and no button (19.2)
// ═════════════════════════════════════════════════════════════════════════════

test('the settings section explains and offers nothing to press', () => {
  const engine = makeEngine({ state: 'pending', pendingOps: 2, lastPullAt: 1_800_000_000_000 });
  const c = mount(engine);
  settle(c);

  const body = document.createElement('div');
  status.buildSyncSection(body, { rebuild: () => {}, close: () => {} });

  assert.includes(body.textContent, i18n.t('syncSectionTitle'));
  assert.includes(body.textContent, i18n.t('syncPendingDetail', 2));
  // The half a user actually needs: nothing is expected of them.
  assert.includes(body.textContent, i18n.t('syncNoButtonHint'));
  // 19.2 is an acceptance criterion, and this is what it looks like from the sheet.
  assert.equal($$('button, input, select', body).length, 0, 'the sync section offers a control');
  // The timestamp is a fact, not a signal — and it is formatted, not a raw epoch.
  assert.equal(/1800000000000/.test(body.textContent), false, 'a raw epoch reached the screen');
  assert.match(body.textContent, /\d{2}\.\d{2}\.\d{4}|\d{2}\/\d{2}\/\d{4}/);

  // Never synced yet is its own sentence rather than a blank or an epoch of zero.
  engine.set({ lastPullAt: null });
  const body2 = document.createElement('div');
  status.buildSyncSection(body2, {});
  assert.includes(body2.textContent, i18n.t('syncNever'));

  // Both languages.
  i18n.setLang('en');
  const body3 = document.createElement('div');
  status.buildSyncSection(body3, {});
  assert.includes(body3.textContent, 'Sync');
  assert.includes(body3.textContent, i18n.t('syncNoButtonHint'));
  assert.equal(body3.textContent.includes('Abgleich'), false, 'German leaked into the English sheet');

  unmount();
});

test('every string this feature added exists in both languages and is genuinely translated', () => {
  const keys = [
    'syncSectionTitle', 'syncHealthy', 'syncPendingNone', 'syncErrOffline', 'syncErrAuth',
    'syncErrProtocol', 'syncErrQuarantine', 'syncErrDecrypt', 'syncErrClockSkew',
    'syncErrGeneric', 'syncNever', 'syncSolo', 'syncNoButtonHint',
  ];
  const de = {};
  i18n.setLang('de');
  for (const k of keys) {
    de[k] = i18n.t(k);
    assert.notEqual(de[k], k, `de.${k} fell through to the key name`);
    assert.ok(de[k].length > 0);
  }
  i18n.setLang('en');
  for (const k of keys) {
    const v = i18n.t(k);
    assert.notEqual(v, k, `en.${k} fell through to the key name`);
    assert.notEqual(v, de[k], `${k} is identical in both tables`);
  }
  for (const lang of ['de', 'en']) {
    i18n.setLang(lang);
    assert.notEqual(i18n.t('syncPendingDetail', 1), i18n.t('syncPendingDetail', 7),
      `${lang}: one change and seven changes read the same`);
    assert.includes(i18n.t('syncLastPull', '01.01.2027'), '01.01.2027');
  }
  i18n.setLang('de');
});

// ═════════════════════════════════════════════════════════════════════════════
// 7 · the module leaves nothing behind
// ═════════════════════════════════════════════════════════════════════════════

test('unmounting removes the glyph, the subscription and the timer', () => {
  const engine = makeEngine({ state: 'error', errorKind: 'offline' });
  const c = mount(engine);
  settle(c);
  assert.ok(glyph());

  unmount();
  assert.equal(glyph(), null, 'the glyph survived the unmount');
  // A live subscription would keep a dead module redrawing — and, worse, keep a reference to the
  // engine of a Familienkreis the user has just left (20.3).
  engine.set({ state: 'pending', pendingOps: 9 });
  c.advance(10 * status.SYNC_DEBOUNCE_MS);
  status.refreshSyncChrome();
  assert.equal(glyph(), null, 'the old engine is still driving the UI');

  // And the styles were injected exactly once across everything above.
  assert.equal($$(`#${status.SYNC_CSS_ID}`).length, 1, 'the stylesheet was injected more than once');
});
