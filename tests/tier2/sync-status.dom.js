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

// ═════════════════════════════════════════════════════════════════════════════
// 8 · SILENCE MUST *MEAN* HEALTH — the convergence adversary's second conclusion
// ═════════════════════════════════════════════════════════════════════════════
//
// Everything above tests that this module renders the engine's word faithfully. The convergence
// adversary's finding is that the word was wrong:
//
//   > In every finding this round, BOTH MACS REPORT `healthy`. Story 19.3's "silence is the
//   > design" is a promise that SILENCE MEANS HEALTH. At present silence means only that the
//   > engine's own two in-memory maps are empty.
//
// `sync/status.js` folds `tests/helpers/sync-domains.js`'s domain S4 — the enumeration of what
// can be observed — over the engine's reading AND `store.diagnostics()`. These rows are that
// promise, one enumerated failure state at a time. Every one of them mounts an engine that says
// `healthy`, because that is the exact situation each finding produces.
//
// The store is a fake for the same reason the engine is: this file owns what a person SEES.
// `tests/property/sync-domains.test.js` owns whether the store's four fields are true, against
// two real Macs and a real relay.

/**
 * The durable half of the reading, as `store.js` now supplies it. Note what it does NOT have:
 * `apply`, `txn`, `persistNow`, `replaceAll`. The chrome cannot write to the board, and cannot
 * grow the ability by accident.
 */
function makeStore(sync = {}, warnings = [], quarantine = null) {
  const warnListeners = new Set();
  let diag = {
    warnings: [...warnings],
    // TOP-LEVEL, like `warnings`, and present-and-null in the ordinary case — which is what the
    // real `store.diagnostics()` publishes. `sync/status.js`'s `quarantine` row (R8-8) reads it,
    // and a fixture that omitted it would report a BLIND SPOT rather than the state under test.
    quarantine,
    sync: {
      armed: true, personalSpaceId: 'psp_x', logWritable: true, outbox: 0, cursor: '7',
      rejoin: false, pendingRetractions: 0, parked: 0, refused: 0, lost: 0, chain: null, ...sync,
    },
  };
  return {
    reads: 0,
    port: {
      diagnostics() { return diag; },
      subscribeWarnings(fn) { warnListeners.add(fn); return () => warnListeners.delete(fn); },
    },
    set(patch) { diag = { ...diag, sync: { ...diag.sync, ...patch } }; },
    warn(msg) {
      diag = { ...diag, warnings: [...diag.warnings, msg] };
      for (const fn of [...warnListeners]) fn(msg, diag.warnings);
    },
    get listeners() { return warnListeners.size; },
  };
}

test('L-2 — a DURABLY PARKED op is visible, over an engine that says healthy', () => {
  // The state F-6's ladder is designed to produce: the line is on disk with `park:"attestation"`
  // and it survives every relaunch. `sync.status()` derives its three states from
  // `store.outboxSize()` and two in-memory Maps, so it cannot see it and says `healthy`.
  const engine = makeEngine({ state: 'healthy', pendingOps: 0 });
  const store = makeStore({ parked: 1 });
  const c = mount(engine, { store: store.port });

  assert.equal(engine.port.status().state, 'healthy', 'the engine must still be saying healthy');
  settle(c);

  const s = status.syncStatusState();
  assert.equal(s.state, 'pending', 'a held op is invisible — L-2 is open');
  // `pending` and NOT `error`: a held op is not a fault, it is work outstanding — the same thing
  // an unacknowledged outbox line is, and `sync-domains.js` S4-held says so by name.
  assert.equal(s.observables.map((o) => o.id).join(), 'parked');
  assert.equal(s.observables[0].row, 'S4-held');
  assert.equal(s.silent, false, 'a Mac holding an op claimed silence');

  // One hollow ring in the toolbar, and NOT a badge count. 19.3's design note files this feature
  // with the „neu" dot and the update hint: a dot, not a numeral.
  const g = glyph();
  assert.ok(g, 'nothing was drawn');
  assert.equal(g.classList.contains('pending'), true);
  assert.equal(g.classList.contains('error'), false);
  assert.equal(g.textContent, '', 'a count reached the chrome');
  assert.equal(/\d/.test(g.textContent), false);
  // The SENTENCE is the cause-free one, and that is deliberate: `syncPendingDetail` reads „wartet
  // auf die VERBINDUNG", and a held op is not waiting on the network — it is waiting on an
  // attestation, a key or an app update. Naming the connection would be the app inventing a cause.
  assert.equal(g.title, i18n.t('syncErrGeneric'));
  assert.notEqual(g.title, i18n.t('syncPendingDetail', 1), 'a held op was blamed on the network');
  // The outbox, which really IS waiting on the network, still gets the sentence written for it.
  // `pendingOps` is the ENGINE's count — in the shipped app it is `store.outboxSize()` — so it is
  // set here where the product sets it, and the two sentences cannot be confused for each other.
  engine.set({ pendingOps: 1 });
  status.refreshSyncChrome();
  assert.equal(glyph().title, i18n.t('syncPendingDetail', 1));
  engine.set({ pendingOps: 0 });
  status.refreshSyncChrome();

  // …and it goes away by itself when the cure lands. Nothing here is sticky.
  store.set({ parked: 0 });
  status.refreshSyncChrome();
  assert.equal(glyph(), null, 'the ring outlived the hold');
  assert.equal(status.syncStatusState().silent, true, 'silence was not given back');

  unmount();
});

test('L-1 — a terminal refusal fills the ring, and healthy cannot argue it down', () => {
  // The refusal is CORRECT; the record of it is the finding. ADR 003 §8.2 releases the cursor
  // past a terminal, so the relay will never offer the op again and this record is all that is
  // left. Once the engine's per-session Map is gone, the engine says `healthy` for ever.
  const engine = makeEngine({ state: 'healthy' });
  const store = makeStore({ refused: 2 });
  const c = mount(engine, { store: store.port });
  settle(c);

  const s = status.syncStatusState();
  assert.equal(s.state, 'error');
  assert.equal(s.errorKind, 'quarantine', 'the sentence written for this case was not chosen');
  assert.equal(s.observables[0].row, 'S4-refused');
  // Same slot, filled — no second glyph, no bar, no modal. Section 3 asserts the geometry; this
  // asserts that a NEW reason reuses the one slot rather than inventing a signal.
  assert.equal($$('.sync-dot').length, 1);
  assert.equal(glyph().classList.contains('error'), true);
  assert.equal(glyph().title, i18n.t('syncErrQuarantine'));

  unmount();
});

test('E5-2 / P-4 — a folded-away line and a forked chain are both errors, and both say the board still works', () => {
  for (const [field, row] of [['lost', 'S4-lost'], ['chain', 'S4-diverged']]) {
    const engine = makeEngine({ state: 'healthy' });
    const store = makeStore({ [field]: field === 'chain' ? { forkedAt: '42' } : 1 });
    const c = mount(engine, { store: store.port });
    settle(c);

    const s = status.syncStatusState();
    assert.equal(s.state, 'error', `${field} was reported as healthy`);
    assert.equal(s.observables[0].row, row);
    // The one sentence both of these get is the true one, and its second half is the half that
    // matters to the person reading it: nothing on THIS Mac is lost or broken.
    assert.equal(s.sentence, i18n.t('syncErrGeneric'));
    assert.equal(glyph().classList.contains('error'), true);
    unmount();
  }
});

test('R8-8 — a QUARANTINED log is an enumerated observable, and still does not light the toolbar', () => {
  // The state in which the app has decided it cannot trust its own history: `init()` refused the
  // checkpoint, the log is moved aside, and `board.json` alone is authoritative. Round 8 measured
  // `SYNC_OBSERVABLES` with no row for it, so the only thing keeping a quarantined launch from
  // asserting 19.3's promise was somebody having written a sentence into `store.warnings` — a
  // MIXED prose channel that also carries repairs and cures. "There is nothing to tell you" may
  // not rest on that.
  const engine = makeEngine({ state: 'healthy' });
  const store = makeStore({}, [], { at: 1, reason: 'unreadable-log', detail: 'SyntaxError', movedAside: true });
  const c = mount(engine, { store: store.port });
  settle(c);

  const s = status.syncStatusState();
  assert.equal(s.observables.map((o) => o.id).join(), 'quarantine', 'the fold does not see it');
  assert.equal(s.observables[0].row, 'S4-untrusted');
  assert.deepEqual([...s.blind], [], 'and it is a row this build can ANSWER');
  assert.equal(s.silent, false, 'a Mac that refused its own history claimed there is nothing to tell');

  // AND THE TOOLBAR STAYS QUIET, deliberately. ADR 006 §9.3 makes a quarantine "a VISIBLE,
  // REPORTED, CONVERGING event, never a quiet one" — the board is intact, the Mac re-publishes,
  // the family converges, and nothing is asked of the person. `attack-converge-rejoin.test.js`
  // §2 pins the same thing end-to-end. A row that lit the dot here would be the failure round 8
  // walked into in the other direction: an app that shows a fault for ever.
  assert.equal(s.state, 'healthy', 'a converging quarantine lit the indicator');
  assert.equal(glyph(), null, 'and drew a glyph for it');
  unmount();
});

test('F-8 — `store.warnings` finally has a consumer, and a warning between redraws moves the glyph', () => {
  // `_warn` has fired for every refusal, every park, every coercion and every quarantine since
  // LZP-30x; `subscribeWarnings()` has been the seam the whole time; NOTHING HAS EVER SUBSCRIBED.
  const engine = makeEngine({ state: 'healthy' });
  const store = makeStore();
  const c = mount(engine, { store: store.port });
  settle(c);
  assert.equal(glyph(), null, 'a quiet store is not quiet');
  assert.equal(store.listeners, 1, 'nothing subscribed to the warnings channel — F-8 is open');

  // Written between two redraws, with nothing else happening. Without the subscription this is
  // observable only by luck of timing.
  store.warn('op log: the tail could not be compacted; ops.jsonl keeps growing');
  c.advance(status.SYNC_DEBOUNCE_MS);

  // ── WHAT THE CONSUMER DOES WITH IT, AND WHAT IT DELIBERATELY DOES NOT ────────────────────
  //
  // The channel is READ — that is F-8, and the two assertions below are it. The channel does not
  // light the INDICATOR, and that is `sync/status.js`'s `warnings` row: `store.warnings` is mixed
  // prose. `_warn` fires for a refusal and a quarantine, and equally for a reconciliation after a
  // crash ("expected", in its own text), a §9.3 re-join ("nothing is lost"), a settings repair,
  // and `unparkAttested`'s "held ops are now authorised and have been applied" — the sound of a
  // fix WORKING. An indicator that lit whenever the app had anything to say would break story
  // 19.3 in the other direction, which the `S4-quiet` control exists to catch.
  //
  // So: the sentence reaches the settings sheet, and the toolbar stays quiet until there is SHARP
  // evidence — a parked line, a refusal, a lost line, a forked chain. Those four raise it, and
  // the rows above and below this one measure each of them.
  assert.equal(glyph(), null,
    'a warning alone lights the indicator — see `sync/status.js`\'s `warnings` row before '
    + 'changing this: the channel carries good news too');
  assert.equal(status.syncStatusState().observables.map((o) => o.id).join(), 'warnings',
    'but the fold REPORTS it — the consumer F-8 was missing');
  assert.equal(status.syncStatusState().silent, false,
    'and silence is no longer claimed: 19.3 promises quiet MEANS nothing to tell you, and there '
    + 'is now something to tell');

  // And the subscription dies with the mount — a live one would keep a dead module redrawing.
  unmount();
  assert.equal(store.listeners, 0, 'the warnings subscription survived the unmount');
});

test('silence is EARNED: a store that cannot answer, or that throws, is not healthy-by-default', () => {
  // THE DISTINCTION IS THE WHOLE FINDING. A missing field means "nobody can answer this
  // question", and folding that into zero is exactly the move that turns "I cannot see a parked
  // op" into "there are no parked ops".
  const engine = makeEngine({ state: 'healthy' });

  // An OLD store — the four fields simply are not there.
  const old = { diagnostics: () => ({ warnings: [], sync: { outbox: 0 } }), subscribeWarnings: () => () => {} };
  mount(engine, { store: old });
  let s = status.syncStatusState();
  assert.equal(s.state, 'healthy', 'a blind spot is not by itself a fault');
  assert.deepEqual([...s.blind], ['quarantine', 'parked', 'refused', 'lost', 'chain']);
  assert.equal(s.silent, false, 'a build that has not looked claimed there is nothing to tell');
  unmount();

  // A store that THROWS. Every row is blind; the module does not crash and does not lie.
  const broken = { diagnostics() { throw new Error('disk'); }, subscribeWarnings: () => () => {} };
  mount(engine, { store: broken });
  s = status.syncStatusState();
  assert.equal(s.blind.length, 7);
  assert.equal(s.silent, false);
  unmount();

  // THE CONTROL, and it is what stops a "fix" that reports something for ever: a whole store with
  // every field present and every field empty is SILENT, and silence stays free.
  mount(engine, { store: makeStore().port });
  s = status.syncStatusState();
  assert.equal(s.state, 'healthy');
  assert.deepEqual([...s.blind], []);
  assert.equal(s.silent, true, 'a settled Mac could not earn silence — silence is not free');
  assert.equal(glyph(), null);
  unmount();
});

test('the judge only ever RAISES: an engine error survives a perfectly clean store', () => {
  // The merge is a max over a ladder, not a choice between two opinions. An engine that saw a 401
  // happen knows something the disk cannot, and a store with nothing to add may not talk it down.
  const engine = makeEngine({ state: 'error', errorKind: 'auth' });
  const c = mount(engine, { store: makeStore().port });
  settle(c);
  const s = status.syncStatusState();
  assert.equal(s.state, 'error');
  assert.equal(s.errorKind, 'auth', 'the engine\'s own kind was overwritten by the enumeration');
  assert.equal(s.sentence, i18n.t('syncErrAuth'));

  // …and the enumeration may not talk a pending engine down either. The de-escalation waits out
  // the window like every other transition that is not "back to healthy" — §5's asymmetry.
  engine.set({ state: 'pending', errorKind: null, pendingOps: 3 });
  settle(c);
  assert.equal(status.syncStatusState().state, 'pending');
  unmount();
});

test('the settings section names every reason at once, in both languages, and still offers nothing to press', () => {
  // The one place in the app where more than one thing is said, and the right place: the sheet is
  // where somebody has gone looking. Collapsing two reasons into one here would be the same lie
  // in miniature that `status()` was telling.
  const engine = makeEngine({ state: 'healthy', lastPullAt: 1_800_000_000_000 });
  // `outbox: 1` is here on purpose: it is a PRESENT row of the enumeration that must NOT get a
  // line of its own, because the sentence beside the dot is already about it. Three observables,
  // two reasons.
  const store = makeStore({ parked: 2, refused: 1, outbox: 1 });
  const c = mount(engine, { store: store.port });
  settle(c);

  const body = document.createElement('div');
  status.buildSyncSection(body, {});
  assert.equal(status.syncStatusState().observables.length, 3);
  // Three observables, and every one of them is SAID — but each sentence exactly once. The
  // refusal supplied the headline beside the dot, so it is not repeated below it; the hold gets
  // its own line; the outbox is the subject of the headline's own count and never gets one.
  assert.includes(body.textContent, i18n.t('syncErrQuarantine'));
  assert.includes(body.textContent, i18n.t('syncErrGeneric'));
  assert.equal($$('.sync-reason', body).length, 1,
    'the reasons were collapsed, duplicated, or the outbox was double-counted');
  const said = body.textContent.split(i18n.t('syncErrQuarantine')).length - 1;
  assert.equal(said, 1, 'the headline sentence was printed twice — one fault read as two');
  // 19.2 is an acceptance criterion and the new lines may not smuggle a control past it.
  assert.equal($$('button, input, select', body).length, 0, 'a reason line offered a control');
  // Nothing animates, and nothing new is on the board.
  assert.equal($$('.board .sync-dot, .board .sync-reason').length, 0);

  // English, and no German leaks through — the raw `_warn` sentences are German prose and are
  // deliberately NOT rendered here; they stay in `diagnostics().warnings` for a support bundle.
  i18n.setLang('en');
  const en = document.createElement('div');
  status.buildSyncSection(en, {});
  assert.includes(en.textContent, i18n.t('syncErrQuarantine'));
  assert.equal(en.textContent.includes('Abgleich'), false, 'German leaked into the English sheet');
  assert.equal(en.textContent.includes('Abgleich steht'), false, 'German leaked into the English sheet');

  // A SETTLED Mac gets its three lines and not a fourth reassuring one. Silence, in the sheet.
  i18n.setLang('de');
  store.set({ parked: 0, refused: 0, outbox: 0 });
  const calm = document.createElement('div');
  status.buildSyncSection(calm, {});
  assert.equal($$('.sync-reason', calm).length, 0, 'a healthy Mac was given something to read');
  assert.includes(calm.textContent, i18n.t('syncHealthy'));

  unmount();
});

test('solo mode still reaches nothing — no diagnostics read, no warnings subscription', () => {
  // 21.5: the board stays on this Mac. With no engine there is no sync to report on, so the
  // durable half is not consulted either — the module\'s original promise, unchanged.
  const store = makeStore({ parked: 3, refused: 3, lost: 3 });
  let asked = 0;
  const spy = {
    diagnostics() { asked += 1; return store.port.diagnostics(); },
    subscribeWarnings: store.port.subscribeWarnings,
  };
  mount(null, { store: spy });
  status.refreshSyncChrome();
  assert.equal(asked, 0, 'solo mode read the store');
  assert.equal(store.listeners, 0, 'solo mode subscribed to something');
  assert.equal(glyph(), null);
  assert.equal(status.syncStatusState().sentence, i18n.t('syncSolo'));
  unmount();
});
