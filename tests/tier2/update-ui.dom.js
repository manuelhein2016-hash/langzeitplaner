// TIER 2 · the update UX — LZP-103. Stories 22.4 and 22.7, deliverable 26.
//
// There is no release server, so every state below is driven by a FAKE PORT
// handed to the updater module's own `createUpdater()`, and the resulting
// updater is handed to `initUpdateUI()` — the same init `main.js` calls at boot
// with the real bridge. Nothing in the shipped page knows this file exists:
// there is no `window.__lzp*` hook, no query parameter, no build flag, and the
// first test in this file is the one that keeps that true.
//
// What tier 1 already covers and this file therefore does not: version
// comparison, manifest parsing, cadence, the minimum-version decision. Those
// live in `tests/tier1/platform-updater.test.js` against the same port double.
// What THIS file covers is the half tier 1 structurally cannot see — what
// appears on screen, in which language, and, mostly, what does NOT appear.

const { createUpdater, TARGET, CHANNEL } = await importApp('platform/updater.js');
const ui = await importApp('update-ui.js');
const i18n = await importApp('i18n.js');
const { openSettings } = await importApp('settings.js');
const { anySheetOpen, closeTopSheet } = await importApp('ui.js');

// ── the fakes ────────────────────────────────────────────────────────────────

const CURRENT = '1.0.0';
const NEWER = '1.1.0';

/** A manifest the real `parseManifest` accepts — built once, tweaked per test. */
const manifest = (over = {}) => ({
  version: NEWER,
  channel: CHANNEL,
  notes: 'Kleinigkeiten',
  platforms: {
    [TARGET]: {
      url: 'https://example.invalid/LangzeitPlaner_1.1.0.app.tar.gz',
      signature: 'dGVzdC1zaWduYXR1cmU=',
      size: 9_000_000,
    },
  },
  ...over,
});

function makePort(cfg = {}) {
  const state = {
    currentVersion: cfg.currentVersion ?? CURRENT,
    enabled: cfg.enabled !== false,
    disclosed: cfg.disclosed !== false,
    lastCheckAt: cfg.lastCheckAt ?? null,
    stagedVersion: cfg.stagedVersion ?? null,
  };
  const calls = [];
  return {
    state, calls,
    async status() { calls.push('status'); return { ...state }; },
    async noteCheck(at) { calls.push('noteCheck'); state.lastCheckAt = at; },
    async fetchManifest() {
      calls.push('fetchManifest');
      return cfg.manifest === null
        ? { ok: false, error: 'network' }
        : { ok: true, manifest: cfg.manifest ?? manifest() };
    },
    async download(target) {
      calls.push('download');
      if (cfg.downloadError) return { ok: false, error: cfg.downloadError };
      state.stagedVersion = target.version;
      return { ok: true, staged: true };
    },
  };
}

function makeShell(port) {
  const log = [];
  return {
    log,
    async status() { return await port.status(); },
    async setEnabled(on) { log.push(`setEnabled:${on}`); port.state.enabled = !!on; return { ...port.state }; },
    async setDisclosed(on) { log.push(`setDisclosed:${on}`); port.state.disclosed = !!on; return { ...port.state }; },
    async restart() { log.push('restart'); return { ok: true, restarting: true }; },
    setMenuHint(v) { log.push(`menuHint:${v ?? 'none'}`); },
  };
}

/** Mount the UI over a fresh fake, exactly the way `main.js` mounts it over the
 *  real bridge, and run one check so there is state to render. */
async function mount(cfg = {}, { family = false, check = true } = {}) {
  const port = makePort(cfg);
  const shell = makeShell(port);
  const updater = createUpdater({ port, now: () => cfg.now ?? 1_800_000_000_000 });
  ui.initUpdateUI({
    updater, shell, familyMode: () => family, onChange: () => {},
    flush: async () => { shell.log.push('flush'); },
  });
  if (check) await updater.checkNow();
  ui.refreshUpdateChrome();
  return { port, shell, updater };
}

function unmount() {
  ui.initUpdateUI({});
  ui.refreshUpdateChrome();
  while (anySheetOpen()) closeTopSheet();
  i18n.setLang('de');
}

/** Open settings and hand back the Updates section's nodes. */
function settingsSection() {
  openSettings();
  const sheet = $('.sheet');
  const titles = $$('.sheet-body .section-title', sheet);
  const start = titles.find((n) => n.textContent.trim().startsWith(i18n.t('updates')));
  const nodes = [];
  if (start) {
    for (let n = start.nextElementSibling; n && !n.classList.contains('section-title'); n = n.nextElementSibling) {
      nodes.push(n);
    }
  }
  return { sheet, title: start, nodes, text: nodes.map((n) => n.textContent).join(' | ') };
}

// ═════════════════════════════════════════════════════════════════════════════
// 0 · the seam is a seam, not a backdoor
// ═════════════════════════════════════════════════════════════════════════════

test('the shipped page exposes NO update hook a page script could reach', () => {
  // `initUpdateUI` is an ES-module export, reachable only from code that is
  // already part of the module graph — i.e. code we wrote. What must not exist
  // is a global, a URL parameter or a flag, because those are reachable by
  // anything that manages to run in the page, and a settable updater is a
  // settable "here is your next binary".
  // Named shapes first — the ones a future "just for testing" commit would
  // reach for. (`ontimeupdate` and friends are WebKit's own event-handler
  // properties, which is why this cannot be a substring match on "update".)
  for (const k of ['__lzpUpdater', '__lzpUpdateUI', '__lzpFakeManifest', '__lzpUpdateHook',
                   'updater', 'updateUI', 'fakeManifest']) {
    assert.equal(window[k], undefined, `window.${k} must not exist`);
  }

  // Then a shape test, which no future name can slip past: nothing reachable
  // from `window` may quack like the updater or like this UI module. A settable
  // updater is a settable "here is your next binary", and that is precisely the
  // hijackable path 22.6 exists to close.
  const quacks = [];
  for (const k of Object.keys(window)) {
    let v;
    try { v = window[k]; } catch { continue; }
    if (!v || typeof v !== 'object') continue;
    const looksLikeUpdater = typeof v.checkNow === 'function' && typeof v.getState === 'function';
    const looksLikeUI = typeof v.initUpdateUI === 'function' || typeof v.updateUIState === 'function';
    if (looksLikeUpdater || looksLikeUI) quacks.push(k);
  }
  assert.deepEqual(quacks, [], `window exposes an updater-shaped object: ${quacks.join(', ')}`);

  // And the URL carries no switch either — the other classic backdoor shape.
  assert.equal(location.search, '');
  assert.equal(location.hash, '');
});

test('the updater the real boot built is bridge-backed, and reports nothing staged', async () => {
  // Before any fake is mounted: this is the production wiring, as booted.
  const s = ui.updateUIState();
  assert.equal(s.supported, true, 'inside the shell the feature is present');
  assert.equal(s.hint, false, 'a fresh scratch dir has nothing staged, so no hint');
  assert.equal(document.body.classList.contains('update-hint'), false);
  assert.equal($('#update-bar'), null, '22.7 — no bar in a solo install');
});

// ═════════════════════════════════════════════════════════════════════════════
// 1 · 22.4 — the quiet hint, and everything it refuses to be
// ═════════════════════════════════════════════════════════════════════════════

test('an available update is downloaded, staged, and announced ONLY as a hint', async () => {
  const boardBefore = $('#board').innerHTML;
  // A fresh scratch dir means the v1 first-run coach card is on screen. Counting
  // rather than asserting zero is the point: the update must not add ONE.
  const coachesBefore = $$('.coach').length;
  const { port, shell } = await mount();

  assert.equal(port.state.stagedVersion, NEWER, 'the shell staged the verified build');
  const s = ui.updateUIState();
  assert.equal(s.hint, true);
  assert.equal(s.stagedVersion, NEWER);

  // ── the three things it MUST be ────────────────────────────────────────────
  assert.equal(document.body.classList.contains('update-hint'), true, 'the ⚙ dot');
  assert.includes(shell.log, `menuHint:${NEWER}`, 'the native App-menu item');

  // ── the six things it MUST NOT be ──────────────────────────────────────────
  assert.equal($('.scrim'), null, '22.4 — NEVER a modal');
  assert.equal($('.toast'), null, 'not a toast either');
  assert.equal($$('.coach').length, coachesBefore, 'and not a coach card of its own');
  assert.equal($('#update-bar'), null, 'the 22.7 bar is not the 22.4 hint');
  assert.equal($('#board').innerHTML, boardBefore, 'nothing on the board changed — F11');
  assert.equal($('.board .update-hint'), null, 'and nothing was added to it');
  unmount();
});

test('a second mount tells its own shell the truth, rather than inheriting a belief', async () => {
  // The menu-hint push is de-duplicated so a redraw does not rebuild the native
  // menu sixty times a minute. That cache must not outlive the shell it was
  // caching for — otherwise a re-init with the same staged version would leave
  // the new shell's App menu with no hint in it at all.
  const a = await mount();
  assert.includes(a.shell.log, `menuHint:${NEWER}`);
  unmount();
  const b = await mount();
  assert.includes(b.shell.log, `menuHint:${NEWER}`, 'the second shell was told too');
  unmount();
});

test('the ⚙ dot is a dot — 5 px, no text, no count (17.5 / 19.3 family)', async () => {
  await mount();
  const gear = $('#btn-settings');
  const dot = getComputedStyle(gear, '::after');
  assert.equal(dot.content, '""', 'the dot is drawn, not written');
  assert.equal(dot.width, '5px');
  assert.equal(dot.height, '5px');
  // A badge count is the failure mode the design note names by name.
  assert.equal(gear.textContent.trim(), '⚙', 'the button never grows a number');
  assert.equal(gear.getAttribute('data-count'), null);
  unmount();
});

test('nothing about the hint animates, with or without Reduce Motion (§10)', async () => {
  await mount();
  const dot = getComputedStyle($('#btn-settings'), '::after');
  assert.equal(dot.animationName, 'none');
  assert.equal(dot.transitionDuration, '0s');
  unmount();
});

test('an update that is KNOWN about but not yet staged raises no hint at all', async () => {
  // 22.4 promises "one click restarts into the new version". Before the bytes
  // are downloaded and verified there is no version to restart into, so the
  // honest UI is silence — the download happens quietly in the background
  // (22.3) and the hint appears when the promise becomes true.
  const { shell } = await mount({ downloadError: 'network' });
  const s = ui.updateUIState();
  assert.equal(s.hint, false);
  assert.equal(document.body.classList.contains('update-hint'), false);
  assert.includes(shell.log, 'menuHint:none');
  unmount();
});

test('22.6 — a signature failure stages nothing, hints nothing, and says so in settings', async () => {
  const { port } = await mount({ downloadError: 'signature' });
  assert.equal(port.state.stagedVersion, null, 'NOTHING was installed');
  const s = ui.updateUIState();
  assert.equal(s.hint, false, 'a refused build must never look like an available one');
  assert.equal(s.error, 'signature-or-download');

  const sec = settingsSection();
  assert.includes(sec.text, i18n.t('updateSignatureFailed'));
  assert.equal($('.scrim .btn-primary').textContent, i18n.t('done'),
    'the sheet the user opened, not one that opened itself');
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 · the settings section — the hint's second home, in both languages
// ═════════════════════════════════════════════════════════════════════════════

test('DE — the settings section carries the whole feature and nothing more', async () => {
  await mount();
  const sec = settingsSection();
  assert.ok(sec.title, 'there is an Updates section');
  assert.ok(sec.title.querySelector('.quiet-dot'), 'the dot, second home');
  assert.includes(sec.text, 'Update verfügbar — 1.1.0');
  assert.includes(sec.text, 'Update bereit — beim nächsten Start aktiv');
  assert.includes(sec.text, 'Neu starten');
  assert.includes(sec.text, 'Automatisch nach Updates suchen');
  assert.includes(sec.text, 'Jetzt suchen');
  assert.includes(sec.text, 'Installierte Version');
  // 22.4's other half, which is the half that makes the feature calm.
  assert.includes(sec.text, 'beim nächsten Start');
  unmount();
});

test('EN — every string has a twin, and no German leaks through (13.7)', async () => {
  i18n.setLang('en');
  await mount();
  const sec = settingsSection();
  assert.includes(sec.text, 'Update available — 1.1.0');
  assert.includes(sec.text, 'Update ready — active on next start');
  assert.includes(sec.text, 'Restart');
  assert.includes(sec.text, 'Check for updates automatically');
  assert.includes(sec.text, 'Check now');
  assert.includes(sec.text, 'Installed version');
  assert.ok(!/verfügbar|Neu starten|Jetzt suchen|Installierte/.test(sec.text),
    `German leaked into the English UI: ${sec.text}`);
  unmount();
});

test('with nothing staged the section is calm: no dot, no restart button', async () => {
  await mount({ manifest: manifest({ version: CURRENT }) });
  const sec = settingsSection();
  assert.equal(sec.title.querySelector('.quiet-dot'), null);
  assert.ok(!sec.text.includes(i18n.t('updateRestart')),
    'nothing to restart into ⇒ no button offering it');
  assert.includes(sec.text, i18n.t('updateCurrentVersion'), 'the version is still stated');
  unmount();
});

test('the 21.5 switch turns the REQUEST off, not just the hint', async () => {
  const { port, shell } = await mount();
  const sec = settingsSection();
  const cb = sec.nodes.map((n) => n.querySelector('.switch input')).find(Boolean);
  assert.ok(cb, 'the switch exists');
  assert.equal(cb.checked, true);
  cb.checked = false;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(30);
  assert.includes(shell.log, 'setEnabled:false');
  assert.equal(port.state.enabled, false, 'the shell flag is what the shell re-checks');
  unmount();
});

test('„Jetzt suchen“ reports its own state on the button — never a spinner (19.3)', async () => {
  const { port } = await mount();
  const before = port.calls.length;
  const sec = settingsSection();
  const btn = sec.nodes
    .flatMap((n) => $$('button', n))
    .find((b) => b.textContent === i18n.t('updateCheckNow'));
  assert.ok(btn, 'the manual check button exists');
  btn.click();
  // Synchronously after the click, before any await resolves:
  assert.equal(btn.textContent, i18n.t('updateChecking'));
  assert.equal(btn.disabled, true);
  assert.equal($('.board .spinner, .board [class*="spin"]'), null, 'never on the board');
  await sleep(60);
  assert.ok(port.calls.length > before, 'and it really checked');
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 3 · 22.4 — "one click restarts into the new version"
// ═════════════════════════════════════════════════════════════════════════════

test('the restart button asks the shell exactly once, however often it is pressed', async () => {
  const { shell } = await mount();
  const sec = settingsSection();
  const btn = sec.nodes
    .flatMap((n) => $$('button', n))
    .find((b) => b.textContent === i18n.t('updateRestart'));
  assert.ok(btn, 'the button exists while a build is staged');
  btn.click();
  btn.click();
  btn.click();
  await sleep(40);
  assert.equal(shell.log.filter((x) => x === 'restart').length, 1,
    'three clicks, one relaunch — two overlapping LangzeitPlaners is the bug this prevents');
  // 11.1 — the board is never explicitly saved, so a restart the user asked for
  // must not be the one way to lose the last thirty seconds of typing.
  assert.equal(shell.log.indexOf('flush') < shell.log.indexOf('restart'), true,
    'the board is flushed BEFORE the shell is told to go away');
  unmount();
});

test('with nothing staged, restartToUpdate refuses rather than restarting into the same build', async () => {
  const { shell } = await mount({ manifest: manifest({ version: CURRENT }) });
  const r = await ui.restartToUpdate();
  assert.equal(r, null);
  assert.equal(shell.log.filter((x) => x === 'restart').length, 0);
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 4 · 22.7 / LZP-104 — the minimum-version notice
// ═════════════════════════════════════════════════════════════════════════════

const OUTDATED = { manifest: manifest({ minimum_version: '1.0.5' }) };

test('SOLO — an outdated client shows no bar, because there is no server to be old for', async () => {
  await mount(OUTDATED, { family: false });
  assert.equal(ui.updateUIState().outdated, true, 'the updater still knows');
  assert.equal(ui.outdatedNoticeActive(), false);
  assert.equal($('#update-bar'), null, '21.5 — a solo install talks to nothing');
  unmount();
});

test('FAMILY — the bar says it in ONE plain sentence, above the board, not as a modal', async () => {
  const boardBefore = $('#board').innerHTML;
  await mount(OUTDATED, { family: true });

  const bar = $('#update-bar');
  assert.ok(bar, 'the notice exists');
  assert.includes(bar.textContent, 'Diese Version ist zu alt. Bitte auf Version 1.0.5 oder neuer aktualisieren.');
  // ONE sentence-carrying node. Not a paragraph of explanation, not an error
  // code, not a "protocol version mismatch".
  assert.equal($('.ub-text', bar).textContent,
    'Diese Version ist zu alt. Bitte auf Version 1.0.5 oder neuer aktualisieren.');
  assert.ok(!/Protokoll|Fehler|Code|Server/i.test(bar.textContent), 'no jargon');

  assert.equal($('.scrim'), null, 'not a modal');
  assert.equal(bar.getAttribute('role'), 'status', 'announced to a screen reader, not as an alert');
  assert.equal(bar.previousElementSibling.className, 'toolbar', 'directly under the toolbar');
  assert.equal(bar.nextElementSibling.id, 'print-head');
  assert.equal(getComputedStyle(bar).animationName, 'none', 'and it does not animate');
  unmount();
  assert.equal($('#board').innerHTML, boardBefore, 'the board is untouched — only sync stopped');
});

test('FAMILY/EN — the same sentence, in English', async () => {
  i18n.setLang('en');
  await mount(OUTDATED, { family: true });
  assert.equal($('.ub-text').textContent,
    'This version is too old. Please update to version 1.0.5 or newer.');
  unmount();
});

test('the bar offers a restart only when there is something to restart into', async () => {
  // The manifest above ships 1.1.0 AND declares a minimum of 1.0.5, so the
  // download runs and the bar can honestly offer the button.
  await mount(OUTDATED, { family: true });
  assert.ok($('#update-bar .ub-act'), 'staged ⇒ the button is offered');
  unmount();

  // Same minimum, but the download failed: outdated, and nothing to click.
  await mount({ ...OUTDATED, downloadError: 'network' }, { family: true });
  assert.ok($('#update-bar'), 'still says it');
  assert.equal($('#update-bar .ub-act'), null, 'but offers no button that would lie');
  unmount();
});

test('the bar disappears by itself once the client is no longer under the minimum', async () => {
  await mount(OUTDATED, { family: true });
  assert.ok($('#update-bar'));
  // A later check against a manifest with no minimum clears it.
  const { } = await mount({ manifest: manifest() }, { family: true });
  assert.equal($('#update-bar'), null);
  unmount();
});

test('neither the bar nor the dot survives onto paper (12.2)', () => {
  // A printed year planner is used for months. "Diese Version ist zu alt" on a
  // sheet pinned to a kitchen wall would still be there long after the update
  // landed — and the ⚙ dot would print as a stray speck of ink.
  const printed = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) {
      if (r.type !== CSSRule.MEDIA_RULE || !r.conditionText.includes('print')) continue;
      for (const inner of r.cssRules) {
        if (/\.update-bar|update-hint/.test(inner.selectorText || '')) {
          printed.push(inner.style.display);
        }
      }
    }
  }
  assert.includes(printed, 'none', '@media print must hide .update-bar');
  assert.equal($('.toolbar').className, 'toolbar',
    'and the ⚙ dot rides the toolbar, which 12.2 already removes');
});

test('22.7 is restated inside settings, where the user is already looking', async () => {
  await mount(OUTDATED, { family: true });
  const sec = settingsSection();
  assert.includes(sec.text, 'Diese Version ist zu alt.');
  assert.ok(sec.nodes.some((n) => n.classList.contains('warn')),
    'as the same warning box the Ferien placeholder uses — not a new visual language');
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 5 · the native-menu bridge, against the REAL Swift host
// ═════════════════════════════════════════════════════════════════════════════

const invoke = (cmd, args = {}) => window.__TAURI__.core.invoke(cmd, args);

test('the shell implements update_menu_hint (22.4, App-menu half)', async () => {
  // The bridge answers "unknown command: x" for anything it does not implement,
  // so a successful round trip in both directions is the assertion — and it
  // really does rebuild the NSMenu, which is what `--smoke`'s MENU dump shows.
  await invoke('update_menu_hint', { version: '1.1.0' });
  await invoke('update_menu_hint', { version: '' });
  assert.ok(true, 'both round trips returned without an error');
  // …and a genuinely unknown command still fails, so the check above means
  // something rather than passing on a bridge that accepts everything.
  let failed = false;
  try { await invoke('update_menu_hint_typo', {}); }
  catch { failed = true; }
  assert.equal(failed, true, 'the negative control still rejects');
});

test('update_restart exists, and refuses to terminate a headless run', async () => {
  const r = JSON.parse(await invoke('update_restart', {}));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'headless',
    'the guard that lets this suite exercise the command without killing its own runner');
});

test('the menu ids LZP-103 wires are the ones the shell emits (`__lzpEmit`)', () => {
  // The Swift menu builds `check-updates` and `update-restart` items whose
  // action is emitMenu → window.__lzpEmit('menu', id). main.js registers both.
  // Firing them here proves the id spelling matches on both sides — a typo
  // would otherwise only ever be found by a human clicking a menu.
  assert.equal(typeof window.__lzpEmit, 'function');
  const before = $$('.scrim').length;
  window.__lzpEmit('menu', 'check-updates');
  assert.equal($$('.scrim').length, before + 1,
    '„Auf Updates prüfen …“ opens settings, where the answer will appear');
  while (anySheetOpen()) closeTopSheet();
  // `update-restart` with nothing staged must be inert rather than throwing.
  window.__lzpEmit('menu', 'update-restart');
  assert.equal($('.scrim'), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6 · the browser-preview case
// ═════════════════════════════════════════════════════════════════════════════

test('with no bridge the feature is ABSENT, not broken', () => {
  ui.initUpdateUI({ updater: null, shell: null });
  ui.refreshUpdateChrome();
  const s = ui.updateUIState();
  assert.equal(s.supported, false);
  assert.equal(s.hint, false);
  assert.equal(document.body.classList.contains('update-hint'), false);
  const sec = settingsSection();
  assert.includes(sec.text, i18n.t('updateUnsupported'));
  assert.ok(!sec.text.includes(i18n.t('updateCheckNow')),
    'no button that could not possibly work');
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// 7 · 21.5 disclosure — the gate that was never opened
// ═════════════════════════════════════════════════════════════════════════════
//
// Added during E1 integration, because the epic shipped with this half missing.
// Both shells implement `update_set_disclosed`, both default `disclosed` to
// false, and both refuse to fetch a manifest until it is true — and nothing in
// the JavaScript ever called it. The launch check and the daily check therefore
// stopped at the gate on every machine: 22.3 and 22.5 were dead in the product
// while every test around them stayed green, because every test seeded
// `disclosed: true` by hand.
//
// These four assert the gate is opened by a human act and by nothing else.

test('21.5 — the welcome card carries the disclosure sentence inside a real shell', () => {
  // The first-run coach is main.js's, rendered at boot, before any test ran.
  // Inside the shell `updatesSupported()` is true, so the card must carry the
  // one sentence that describes the daily request — this is the surface a
  // FRESH install meets, and the reason the gate can ever open at all.
  const coach = $('.coach');
  assert.ok(coach, 'a fresh scratch dir boots with the welcome card on screen');
  assert.equal(typeof window.__TAURI__?.core?.invoke, 'function',
    'and this really is the native shell, not a preview');
  assert.includes(coach.textContent, i18n.t('updateCheckHint'),
    'the same string settings shows — one sentence, one source');
});

test('21.5 — nothing at mount time discloses anything on the user’s behalf', async () => {
  const { shell } = await mount({ disclosed: false }, { check: false });
  assert.ok(!shell.log.some((l) => l.startsWith('setDisclosed')),
    'initUpdateUI must not consent for the user');
  assert.equal(ui.updateUIState().disclosed, false);
  unmount();
});

test('21.5 — a launch check does NOT disclose; it stops at the gate instead', async () => {
  const { shell, port } = await mount({ disclosed: false }, { check: false });
  await ui.runLaunchCheck();
  assert.ok(!shell.log.some((l) => l.startsWith('setDisclosed')),
    'a timer must never be able to open a consent gate');
  assert.ok(!port.calls.includes('fetchManifest'),
    'and no request left the machine');
  unmount();
});

test('22.3 — pressing „Jetzt suchen“ discloses, so the check can actually run', async () => {
  const { shell, port } = await mount({ disclosed: false }, { check: false });
  await ui.checkNow();
  assert.includes(shell.log, 'setDisclosed:true',
    'the user pressed a button sitting directly under the sentence that says what it does');
  assert.equal(port.state.disclosed, true);
  assert.ok(port.calls.includes('fetchManifest'),
    'and the request the button promises actually happens — before this fix it did not');
  unmount();
});

test('22.3 — turning the settings switch ON discloses; turning it off never does', async () => {
  const { shell } = await mount({ disclosed: false }, { check: false });
  await ui.setAutoUpdate(true);
  assert.includes(shell.log, 'setDisclosed:true');
  const afterOn = shell.log.filter((l) => l === 'setDisclosed:true').length;
  await ui.setAutoUpdate(false);
  assert.equal(shell.log.filter((l) => l === 'setDisclosed:true').length, afterOn,
    'switching off is not a consent event');
  assert.ok(!shell.log.includes('setDisclosed:false'),
    'and consent, once given, is not silently withdrawn by the enable switch');
  unmount();
});
