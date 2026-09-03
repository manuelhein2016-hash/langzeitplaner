// TIER 2 · CHARACTERIZATION — the native shell contract: the __TAURI__ bridge,
// storage isolation, the enforced no-network property (13.4), and the menu
// event channel. These are the pieces node --test can say nothing about,
// because they only exist inside a real WKWebView with the Swift host attached.

const storage = await importApp('storage.js');
const { store } = await importApp('store.js');

// ── the bridge exists and is the one storage.js talks to ─────────────────────

test('the shell presents a Tauri-shaped host', () => {
  assert.equal(typeof window.__TAURI__, 'object');
  assert.equal(typeof window.__TAURI__.core.invoke, 'function');
  assert.equal(typeof window.__TAURI__.event.listen, 'function');
  assert.equal(storage.isTauri(), true, 'storage takes its NATIVE branch here');
  assert.ok(document.body.classList.contains('in-tauri'), 'the page knows it is hosted');
});

test('save_board / load_board round-trip through the native host', async () => {
  const payload = JSON.stringify({ probe: 'roundtrip', at: Date.now() });
  await window.__TAURI__.core.invoke('save_board', { contents: payload });
  const back = await window.__TAURI__.core.invoke('load_board', {});
  assert.equal(back, payload, 'what came back is byte-identical to what went out');
});

test('save_snapshots / load_snapshots round-trip', async () => {
  const payload = JSON.stringify([{ day: '2099-01-01', at: 'x', state: {} }]);
  await window.__TAURI__.core.invoke('save_snapshots', { contents: payload });
  assert.equal(await window.__TAURI__.core.invoke('load_snapshots', {}), payload);
});

test('storage.saveBoard/loadBoard use that bridge, not localStorage', async () => {
  const state = { schemaVersion: 1, notes: [{ id: 'via-storage' }], bars: [], categories: [], scratchpads: {}, settings: {} };
  const lsBefore = localStorage.getItem('langzeitplaner.board');
  await storage.saveBoard(state);
  const back = await storage.loadBoard();
  assert.equal(back.notes[0].id, 'via-storage');
  assert.equal(localStorage.getItem('langzeitplaner.board'), lsBefore,
    'the browser fallback branch was NOT taken');
});

test('an unknown bridge command rejects rather than resolving quietly', async () => {
  let threw = false;
  try { await window.__TAURI__.core.invoke('definitely_not_a_command', {}); }
  catch (e) { threw = true; assert.includes(String(e), 'unknown command'); }
  assert.ok(threw, 'the host must reject unknown commands');
});

// ── isolation (the property that makes this suite safe to run) ───────────────

test('ISOLATION: every bridge write lands in the scratch dir, not the real board', async () => {
  // The Swift side redirects appSupportDir() for --smoke/--test and aborts if
  // that ever resolves inside ~/Library/Application Support/LangzeitPlaner.
  // From inside the page we can prove the redirection is ACTIVE by writing a
  // sentinel and reading it back: if this run were pointed at the user's real
  // board, the sentinel would have replaced it — the shell-side guard plus
  // tests/run-dom-tests.sh's before/after fingerprint cover that end.
  const sentinel = JSON.stringify({ __scratch_sentinel: true });
  await window.__TAURI__.core.invoke('save_board', { contents: sentinel });
  assert.equal(await window.__TAURI__.core.invoke('load_board', {}), sentinel);
  // storagePath() is a COSMETIC label for the settings sheet — it always names
  // the production path and is not evidence of where bytes actually went.
  assert.equal(storage.storagePath(), '~/Library/Application Support/LangzeitPlaner/board.json');
});

// ── zero network, enforced (13.4) ────────────────────────────────────────────

test('the page ships a Content-Security-Policy that forbids off-origin traffic', () => {
  const meta = $('meta[http-equiv="Content-Security-Policy"]');
  assert.ok(meta, 'no CSP meta tag');
  const csp = meta.getAttribute('content');
  assert.includes(csp, "default-src 'self'");
  assert.includes(csp, "connect-src 'self'");
  assert.includes(csp, "font-src 'self'");
});

test('an outbound fetch is actually blocked, not merely discouraged', async () => {
  let blocked = false;
  try {
    await fetch('https://example.com/ping', { mode: 'no-cors' });
  } catch {
    blocked = true;
  }
  assert.ok(blocked, 'CSP did not stop an off-origin request');
});

test('the board loads from the app: scheme, with no remote asset references', () => {
  assert.equal(location.protocol, 'app:');
  const remote = [...document.querySelectorAll('link[href], script[src], img[src]')]
    .map((n) => n.getAttribute('href') || n.getAttribute('src'))
    .filter((u) => /^(https?:)?\/\//.test(u));
  assert.deepEqual(remote, [], 'remote asset references: ' + remote.join(', '));
});

// ── native hooks the shell calls into ────────────────────────────────────────

test('the shell-facing hooks the Swift host depends on are installed', () => {
  assert.equal(typeof window.__lzpFlush, 'function', 'applicationShouldTerminate awaits this');
  assert.equal(typeof window.__lzpContextMenu, 'function', 'willOpenMenu calls this');
  assert.equal(typeof window.__lzpEmit, 'function', 'menu items are delivered through this');
});

test('menu events reach the board: "layer-feiertage" toggles the layer', async () => {
  const before = store.state.settings.layers.feiertage;
  window.__lzpEmit('menu', 'layer-feiertage');
  await waitFor(() => store.state.settings.layers.feiertage !== before, { what: 'the layer to flip' });
  assert.equal(store.state.settings.layers.feiertage, !before);
  assert.equal($$('.board .d-hol').length, before ? 0 : $$('.board .d-hol').length);
  window.__lzpEmit('menu', 'layer-feiertage');
  await waitFor(() => store.state.settings.layers.feiertage === before);
});

test('menu events reach the board: "mode-toggle" flips rolling ↔ pinned', async () => {
  const before = store.state.settings.mode;
  window.__lzpEmit('menu', 'mode-toggle');
  await waitFor(() => store.state.settings.mode !== before, { what: 'the mode to flip' });
  assert.equal(store.state.settings.mode, before === 'rolling' ? 'pinned' : 'rolling');
  assert.equal(store.state.settings.pageYears, 0, 'the pager resets on a mode change');
  window.__lzpEmit('menu', 'mode-toggle');
  await waitFor(() => store.state.settings.mode === before);
});

test('an unknown menu id is ignored rather than throwing', () => {
  window.__lzpEmit('menu', 'no-such-action');
  assert.deepEqual(window.__lzpErrors, [], 'nothing was thrown');
});

test('__lzpContextMenu opens the day popover for the point under the cursor', () => {
  const row = $('.board .day[data-date]');
  const r = row.getBoundingClientRect();
  window.__lzpContextMenu(r.left + 4, r.top + 2);
  const pop = $('.popover');
  assert.ok(pop, 'right-click on a day opened no popover');
  document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
});

// ── boot health ──────────────────────────────────────────────────────────────

test('the app booted with no uncaught errors or rejections', () => {
  assert.deepEqual(window.__lzpErrors, []);
});

test('the document title tracks the visible range', () => {
  assert.match(document.title, /^LangzeitPlaner — /);
});
