// TIER 2 · the updater across the real bridge — LZP-102 / LZP-104.
// Stories 22.3, 22.5, 22.6, 22.7 and the 21.5 boundary.
//
// Tier 1 (`tests/tier1/platform-updater.test.js`) proves every decision the
// updater makes, against a port double. `shell-macos/updater-selftest.sh` proves
// the Swift half — Ed25519 verification and the bundle swap — against a scratch
// directory. What neither of them can prove is that the two halves speak the
// same protocol: that `bridgePort()`'s command names and argument shapes are the
// ones `Bridge.userContentController` actually implements, in the real WKWebView,
// with the real Swift host attached. That is this file.
//
// The scratch directory is fresh per file (run-dom-tests.sh), so `updater.json`
// does not exist when this starts: the state observed below is a FIRST LAUNCH.

const { createUpdater, bridgePort, CHANNEL, TARGET } = await importApp('platform/updater.js');

const invoke = (cmd, args = {}) => window.__TAURI__.core.invoke(cmd, args);
const status = async () => JSON.parse(await invoke('update_status'));

// A literal clock. Nothing in this file reads the wall clock — a cadence test
// that did would be a test that behaves differently at 23:59.
const T = 1_800_000_000_000;
const port = bridgePort(invoke);

test('the shell implements the four updater commands the JS port sends', async () => {
  const s = await status();
  assert.equal(typeof s, 'object');
  assert.equal(s.channel, CHANNEL, '22.5 — one channel, and both sides name it the same');
  assert.equal(s.target, TARGET);
  assert.match(s.currentVersion, /^\d+\.\d+\.\d+$/, 'the shell reports its CFBundleShortVersionString');
  assert.equal(s.stagedVersion, null, 'a first launch has nothing staged');
  // …and the port wrapper reads the same object the raw command returns
  const viaPort = await port.status();
  assert.equal(viaPort.currentVersion, s.currentVersion);
});

test('21.5 — a FIRST LAUNCH has not disclosed the check, so nothing is enabled to run', async () => {
  const s = await status();
  assert.equal(s.disclosed, false,
    'a fresh install must not have consented to anything on the user’s behalf');
});

test('21.5 — checkOnLaunch makes NO request at all before disclosure', async () => {
  // The whole tension between 22.3 ("check on launch and roughly daily") and
  // 21.5 ("zero network requests") lands here. The updater stops at the gate.
  const u = createUpdater({ port, now: () => T });
  const r = await u.checkOnLaunch();
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'not-disclosed');
  assert.equal(u.getState().phase, 'off');
  // and the shell refuses independently, because a bridge command is reachable
  // from any page script and the guarantee must not rest on a polite caller
  const raw = JSON.parse(await invoke('update_fetch_manifest'));
  assert.equal(raw.ok, false);
  assert.equal(raw.error, 'disabled');
});

// Corrected during E1 integration. This used to name LZP-106's unlock screen as
// the switch that opens the gate. It cannot be: that screen only appears on a
// launch macOS actually refused, so on a healthy install the gate would never
// open and 22.3 would never run. The disclosure now lives on the welcome coach
// (`maybeFirstRun` in main.js) and on the two explicit acts in Settings →
// Updates — turning the switch on, and pressing „Jetzt suchen“. All three call
// `discloseUpdateCheck()` in update-ui.js, which issues exactly this command.
test('the welcome card / settings disclosure is what opens the gate (LZP-103 → LZP-102)', async () => {
  const after = JSON.parse(await invoke('update_set_disclosed', { value: true }));
  assert.equal(after.disclosed, true);
  assert.equal(after.enabled, true, 'disclosed and on is the state the disclosure leaves behind');
  // the settings switch turns it back off, and that stops the REQUEST, not just the hint
  const off = JSON.parse(await invoke('update_set_enabled', { value: false }));
  assert.equal(off.enabled, false);
  const refused = JSON.parse(await invoke('update_fetch_manifest'));
  assert.equal(refused.error, 'disabled');
  const on = JSON.parse(await invoke('update_set_enabled', { value: true }));
  assert.equal(on.enabled, true);
});

test('with both gates open the shell still refuses, and this suite still touches no network', async () => {
  // INVERTED 2026-09-05, and the reason is worth keeping. This row used to assert
  // `no-release-host`, because UPDATE_MANIFEST_URL was a marked placeholder — and its own comment
  // named what that bought: "it means this suite performs no real network I/O".
  //
  // Substituting the real repository slug would have quietly turned that into a suite that GETs
  // github.com on every CI run. The hermeticity was never really about the URL; it was about
  // there being nothing worth fetching yet. So the guard in `updaterFetchManifest` now refuses on
  // the EMPTY UPDATER KEY instead: a manifest that cannot be verified is one we have no business
  // fetching, which is true permanently rather than only until someone creates a repository.
  //
  // When the PO generates the keypair this row goes red, and that is correct — it is the point at
  // which this suite would start making real requests, and it must become a decision (pass
  // `--updater-manifest-url` at a local fixture) rather than a silent network dependency.
  const r = JSON.parse(await invoke('update_fetch_manifest'));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no-updater-key',
    'the empty updater key is what keeps this suite hermetic now that the release host is real');
});

test('the runner turns that refusal into a visible error state, never an exception', async () => {
  const u = createUpdater({ port, now: () => T });
  const r = await u.checkNow();
  assert.equal(r.error, 'network');
  assert.equal(u.getState().phase, 'error');
  assert.equal(u.getState().stagedVersion, null);
});

test('22.3 — the check time is persisted natively and gates the next launch check', async () => {
  // `noteCheck` is written before the request goes out, so the timestamp above
  // is already stored. A second launch check within the debounce window must not
  // reach the network again.
  const s = await status();
  assert.equal(s.lastCheckAt, T, 'update_note_check persisted the literal we injected');
  const u = createUpdater({ port, now: () => T + 60_000 });
  const r = await u.checkOnLaunch();
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'not-due');
  // …and a day later it is due again
  const u2 = createUpdater({ port, now: () => T + 25 * 60 * 60 * 1000 });
  const r2 = await u2.checkDaily();
  assert.equal(r2.ran, true, 'a day later the timer fires');
});

test('22.6 — with no updater key configured, download installs nothing and says why', async () => {
  // D1 shipped unsigned and there is no updater key yet either. The correct
  // behaviour for that state is to be UN-updatable, not updatable by anyone.
  const r = JSON.parse(await invoke('update_download', {
    version: '9.9.9',
    url: 'https://example.invalid/LangzeitPlaner_9.9.9_universal.app.tar.gz',
    signature: 'AAAA',
    size: 0,
  }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no-updater-key');
  const s = await status();
  assert.equal(s.stagedVersion, null, 'nothing was staged');
});

test('22.7 — the updater never touches the board, the op log or the snapshots', async () => {
  // The whole updater surface is six commands, and none of them can reach user
  // data. Proven end-to-end: write a board, run the updater through every
  // command it has, read the board back unchanged.
  const payload = JSON.stringify({ probe: 'untouched-by-updates' });
  await invoke('save_board', { contents: payload });
  await invoke('save_snapshots', { contents: '[]' });
  await invoke('append_ops', { contents: '{"probe":"op"}\n' });

  await invoke('update_status');
  await invoke('update_note_check', { at: T + 1 });
  await invoke('update_fetch_manifest');
  await invoke('update_download', { version: '9.9.9', url: 'https://example.invalid/x.tar.gz', signature: 'AAAA', size: 0 });
  await invoke('update_clear_staged');

  assert.equal(await invoke('load_board', {}), payload, 'board.json is byte-identical');
  assert.equal(await invoke('load_snapshots', {}), '[]');
  assert.equal(await invoke('load_ops', {}), '{"probe":"op"}\n');
});

test('the updater module is DOM-free even inside a real browser', () => {
  // It is imported here by the same page that renders the board, so if it had
  // reached for `document` at import time this file would already have failed.
  // The stronger claim — that it cannot fetch — is structural: there is no
  // `fetch` in it, and the page's CSP (`default-src 'self'`, asserted in
  // shell-bridge.dom.js) would stop one anyway.
  assert.equal(typeof createUpdater, 'function');
  assert.equal(typeof bridgePort, 'function');
  const u = createUpdater({ port, now: () => T });
  assert.equal(typeof u.getState().phase, 'string');
});
