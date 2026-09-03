// TIER 2 · CHARACTERIZATION — `sync_request`: the shell IS the transport.
// LZP-1002 · story 21.5 · ADR 003 §7 gate 3 · net.js §6 · FINDING P-5's shell half.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS, AND WHAT IT REPLACES
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `chooseTransport()` returns the BRIDGE transport whenever a shell `invoke` exists — which,
// inside this app, is always (`family/mount.js` binds `window.__TAURI__.core.invoke`). Until the
// pass that added this file, `sync_request` was implemented by NEITHER shell, so every M1/E6/E7/E9
// demonstration that reported PASS had run in a browser on `createFetchTransport`. The bridge
// path — the one that ships — had never carried a byte.
//
// So this file runs in the SHIPPING SHELL, in real WebKit, against the real Swift host, and it
// asks the two questions no unit test can:
//
//   · with no relay configured, does the command refuse LOCALLY — no socket, no DNS, no session?
//     (story 21.5: "in solo mode the app makes zero network requests")
//   · when a relay IS configured, can a real, signed, sealed op make the round trip through the
//     bridge — and is everything that is NOT that relay refused?
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE TWO MODES OF THIS FILE, AND WHY THE SECOND IS NOT DEAD CODE
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `tests/run-dom-tests.sh` launches the shell as `--test <file> --scratch <dir>` and passes no
// sync configuration, so an ordinary `npm run test:dom` exercises §0–§2: the gate, the refusal
// and the copy. That is the SOLO configuration and it is the one that ships today.
//
// §3 and §4 need a pinned origin, and the shell takes one — in a headless run only — from
// `--sync-origin <origin>` or the `LZP_SYNC_ORIGIN` environment variable. The environment
// variable is inherited straight through the runner, so the FULL file runs with no change to any
// script:
//
//     node server/dev-server.mjs &                       # the real relay, loopback only
//     LZP_SYNC_ORIGIN=http://127.0.0.1:8787 npm run test:dom -- tests/tier2/shell-transport.dom.js
//
// Without it, §3 and §4 `skip()` with that command in the reason — VISIBLE in the TAP output and
// counted separately, never a silent pass. A suite that quietly stops testing something is the
// failure mode this suite exists to prevent.

const net = await importApp('platform/net.js');
const { b64u, ub64 } = await importApp('core/b64.js');
const ids = await importApp('core/ids.js');
const { fmt } = await importApp('core/stamp.js');
const identity = await importApp('crypto/identity.js');
const spacekeys = await importApp('crypto/spacekeys.js');
const envelope = await importApp('crypto/envelope.js');
const { memKeyStore } = await importApp('platform/keystore.js');

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args || {});
const S = globalThis.crypto.subtle;
const TE = new TextEncoder();
const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** A durable deviceShort shape (ADR 002 §5.2.0) — the transport refuses anything else. */
const DEV_SHORT = 'CHFBZPVRBG6M14TJ';

/** The status the shell reports about its own configuration. Read once, used by every section. */
const status = await invoke('sync_status');
const PINNED = status && status.originConfigured ? status.origin : null;
const SKIP_REASON =
  'no sync origin is configured for this run — start `node server/dev-server.mjs` and re-run with '
  + 'LZP_SYNC_ORIGIN=http://127.0.0.1:8787 npm run test:dom -- tests/tier2/shell-transport.dom.js';

diag('sync_status:', status);

/** Turn the shell's own pref on/off, from the page, through the real bridge. */
const setSync = (on) => invoke('set_shell_pref', { key: 'sync_enabled', value: on });

/** A raw `sync_request`, bypassing net.js — this is what a hostile page would actually send. */
const raw = (args) => invoke('sync_request', args);

/** A bridge transport wired exactly as `family/engine.js` wires the shipping one. */
function bridge(origin) {
  return net.createBridgeTransport({
    origin,
    deviceShort: DEV_SHORT,
    sign: async () => new Uint8Array(64),
    clientVersion: '2.0.0',
    invoke,
  });
}

/**
 * `POST /api/v1/spaces`, or a visible stand-down when the dev relay's own per-IP cap has been
 * reached. A 429 here says the RELAY refused, which means the whole transport worked.
 */
async function createSpaceOrSkip(post, body) {
  const res = await post(body);
  if (res.status === 429) {
    skip('the dev relay rate-limited space creation (' + JSON.stringify(res.json) + '). That cap '
      + 'is ADR 003 §6.1 doing its job — the request reached it through the bridge. Restart '
      + '`node server/dev-server.mjs` with a fresh --dir and re-run to exercise this row.');
  }
  if (res.status !== 200) {
    throw new Error('POST /api/v1/spaces → ' + res.status + ' ' + JSON.stringify(res.json));
  }
  return res.json;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 — the command exists, and the shell is the one answering
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§0 the shipping shell implements sync_request — it is no longer an unknown command', async () => {
  // The whole finding, in one row. Before this pass the shell answered `unknown command:
  // sync_request` and `createBridgeTransport` turned that into NetError('transport'), which is
  // indistinguishable from a dropped wifi — so the defect could not even be seen from the page.
  const reply = await raw({ url: 'https://relay.test/api/v1/meta', method: 'GET', headers: {}, body: '' });
  assert.equal(typeof reply, 'object', 'sync_request answered something that is not an object');
  assert.notEqual(reply, null);
  assert.ok(!('unknown' in reply), 'the shell still treats sync_request as unknown');
  // Either a refusal or an answer — never a throw, and never `undefined`.
  assert.ok(typeof reply.error === 'string' || Number.isInteger(reply.status),
    'a reply must carry either an error kind or an integer status: ' + JSON.stringify(reply));
});

test('§0 sync_status reports the shell configuration, and the invariant holds both ways', async () => {
  const s = await invoke('sync_status');
  assert.equal(typeof s, 'object');
  assert.equal(typeof s.enabled, 'boolean', 'sync_enabled must be a boolean, not absent');
  assert.equal(typeof s.originConfigured, 'boolean');
  if (s.originConfigured) {
    assert.equal(typeof s.origin, 'string', 'a configured build must name its origin');
    assert.ok(s.origin.length > 0);
    assert.equal(s.reason, null, 'a configured build has no refusal reason');
  } else {
    assert.equal(s.origin, null, 'an unconfigured build must not name an origin');
    assert.equal(typeof s.reason, 'string', 'a refusal must say which rule fired');
  }
});

test('§0 the origin the shell was configured with is classified by the rule the table names', async () => {
  // The origin validator is Swift and cannot be called from here, so it is exercised by LAUNCHING
  // with each value and letting this row check the verdict. The table is the red team; the sweep
  // is `LZP_SYNC_ORIGIN=<value> npm run test:dom -- tests/tier2/shell-transport.dom.js`, once per
  // row, and it is recorded in the pass report.
  const TABLE = {
    '': 'no_origin_configured',
    // The ONE exception, and it is headless-only: `node server/dev-server.mjs` binds loopback.
    'http://127.0.0.1:8787': null,
    'http://localhost:8787': null,
    // Everything a page or a mistyped config could aim at the LAN, the router or the metadata
    // endpoint. Every one of them is refused BY THE SHELL, whatever the configuration says.
    'https://10.0.0.5': 'origin_host_is_local_private_or_an_ip_literal',
    'https://192.168.1.1': 'origin_host_is_local_private_or_an_ip_literal',
    'https://172.20.0.1': 'origin_host_is_local_private_or_an_ip_literal',
    'https://169.254.169.254': 'origin_host_is_local_private_or_an_ip_literal',
    'https://100.64.0.1': 'origin_host_is_local_private_or_an_ip_literal',
    'https://127.0.0.1': 'origin_host_is_local_private_or_an_ip_literal',
    'https://[::1]': 'origin_host_is_local_private_or_an_ip_literal',
    'https://[fd00::1]': 'origin_host_is_local_private_or_an_ip_literal',
    'https://router.local': 'origin_host_is_local_private_or_an_ip_literal',
    'https://nas': 'origin_host_is_local_private_or_an_ip_literal',
    'https://box.home.arpa': 'origin_host_is_local_private_or_an_ip_literal',
    'http://relay.example.org': 'origin_is_not_https',
    'https://relay.example.org/api': 'origin_is_not_scheme_host_port',
    'https://user:pw@relay.example.org': 'origin_is_not_scheme_host_port',
    'file:///etc/passwd': 'origin_is_not_scheme_host_port',
    'https://relay.example.org': null,
  };
  const s = await invoke('sync_status');
  const configured = typeof s.configured === 'string' ? s.configured : '';
  assert.equal(typeof s.configured, 'string', 'sync_status must report what it was configured WITH');
  if (Object.prototype.hasOwnProperty.call(TABLE, configured)) {
    const expected = TABLE[configured];
    if (expected === null) {
      assert.equal(s.originConfigured, true, `${JSON.stringify(configured)} should have been accepted`);
    } else {
      assert.equal(s.originConfigured, false, `${JSON.stringify(configured)} should have been refused`);
      assert.equal(s.reason, expected, `${JSON.stringify(configured)} was refused by the wrong rule`);
    }
  } else {
    // Not a table row — assert the invariant rather than nothing.
    assert.equal(s.originConfigured, s.origin !== null);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 — SOLO MODE MAKES ZERO REQUESTS (story 21.5), and the switch that gates it
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1 with sync_enabled OFF, sync_request refuses locally — no socket, no DNS', async () => {
  await setSync(false);
  const s = await invoke('sync_status');
  assert.equal(s.enabled, false, 'the switch did not turn off');

  // A perfectly well-formed request at whatever origin this build pins. There is nothing wrong
  // with it except that this Mac has not been told a Familienkreis exists.
  const url = (PINNED || 'https://relay.test') + '/api/v1/meta';
  const t0 = Date.now();
  const reply = await raw({ url, method: 'GET', headers: { 'X-LZP-Protocol': '1' }, body: '' });
  const ms = Date.now() - t0;

  assert.equal(reply.error, 'blocked', 'a disabled shell answered something other than blocked');
  assert.equal(reply.reason, 'sync_disabled', 'the wrong rule refused it');
  assert.equal(reply.status, undefined, 'a refusal must not carry an HTTP status');
  assert.equal(reply.body, undefined, 'a refusal must not carry a body');
  // Not a timing proof — a proof that nothing was AWAITED. A DNS lookup to a name that does not
  // resolve costs seconds; a refusal costs a file read.
  assert.ok(ms < 1500, `the refusal took ${ms}ms, which is long enough to have asked a resolver`);
});

test('§1 the switch alone is not a door: an unconfigured build still refuses', async () => {
  await setSync(true);
  const s = await invoke('sync_status');
  assert.equal(s.enabled, true, 'the switch did not turn on');

  const reply = await raw({
    url: 'https://relay.test/api/v1/meta', method: 'GET', headers: {}, body: '',
  });
  assert.equal(reply.error, 'blocked');
  if (PINNED) {
    // With an origin pinned, `https://relay.test` is simply not it — which is the §3 rule, and
    // proving it here as well costs one line and covers the seam between the two gates.
    assert.equal(reply.reason, 'url_is_not_the_pinned_origin');
  } else {
    assert.equal(reply.reason, 'no_origin_configured',
      'a build with no relay must refuse for THAT reason, not by failing to connect to one');
  }
});

test('§1 the switch is persisted, and it survives being read back', async () => {
  await setSync(false);
  assert.equal((await invoke('sync_status')).enabled, false);
  await setSync(true);
  assert.equal((await invoke('sync_status')).enabled, true);
  await setSync(false);
  assert.equal((await invoke('sync_status')).enabled, false, 'the pref did not round-trip');
});

test('§1 the shell owns the sentence, in both languages, German first', async () => {
  // `net.js`'s `insecureOriginMessage()` and `crypto/probe.js`'s `unavailableMessage()` set the
  // precedent: the module that owns the RULE owns the sentence that explains it, so the two
  // cannot drift, and the UI picks the language. This is the sync half of that.
  await setSync(false);
  const s = await invoke('sync_status');
  assert.equal(typeof s.message, 'object', 'no sentence for a state a person can see');
  assert.equal(typeof s.message.de, 'string');
  assert.equal(typeof s.message.en, 'string');
  assert.ok(s.message.de.length > 20 && s.message.en.length > 20, 'the copy is a stub');
  assert.notEqual(s.message.de, s.message.en, 'one language is standing in for the other');
  // It says what is true, not that something failed: nothing has gone wrong in solo mode.
  assert.ok(!/fehler|error/i.test(s.message.de + s.message.en),
    'solo mode is not an error state and must not be worded as one');

  const blocked = await raw({ url: 'https://evil.example/api/v1/meta', method: 'GET', headers: {}, body: '' });
  assert.equal(typeof blocked.message.de, 'string', 'a refusal carries no German sentence');
  assert.equal(typeof blocked.message.en, 'string', 'a refusal carries no English sentence');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 — the transport this shell actually chooses, and what the page can reach with it
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2 chooseTransport picks the BRIDGE in the shipping shell — and now that means something', async () => {
  // The audit's finding, asserted from inside the app it was made about. `deps.invoke` exists
  // here because `family/mount.js` binds `window.__TAURI__.core.invoke`, so this is the transport
  // every family feature has been getting all along.
  const picked = net.chooseTransport({
    origin: PINNED || 'https://relay.test',
    deviceShort: DEV_SHORT,
    sign: async () => new Uint8Array(64),
    clientVersion: '2.0.0',
    invoke,
  });
  assert.equal(picked.kind, 'bridge',
    'the shipping shell chose `fetch` — that is a bug in ADR 003 §7 gate 3');
  assert.equal(typeof picked.transport.request, 'function');
  assert.equal(picked.transport.origin, PINNED || 'https://relay.test');

  // …and without an `invoke` it is the browser build, which is what the 4,315 green rows ran on.
  const browser = net.chooseTransport({
    origin: 'https://relay.test',
    deviceShort: DEV_SHORT,
    sign: async () => new Uint8Array(64),
    clientVersion: '2.0.0',
  });
  assert.equal(browser.kind, 'fetch');
});

test('§2 the page cannot reach an origin of its own choosing through the bridge', async () => {
  // A transport built against a host the SHELL does not pin. This is the shape of the whole
  // defence: the page may name a path, it may not name a host, and the refusal comes from the
  // native side rather than from a check the page could have skipped.
  let kind = null;
  try {
    await bridge('https://evil.example').request('GET', '/api/v1/meta');
    assert.fail('a request to an unpinned origin was carried out');
  } catch (e) {
    kind = e.kind;
  }
  assert.equal(kind, 'blocked', 'the shell answered something other than `blocked`: ' + kind);
});

test('§2 an off-origin fetch from the page is still blocked — gate 4 did not move', async () => {
  // The sync work must not have loosened the CSP by one character. `shell-bridge.dom.js` asserts
  // this too; it is repeated here because THIS is the file that would have loosened it.
  let blocked = false;
  try { await fetch('https://example.com/ping', { mode: 'no-cors' }); } catch { blocked = true; }
  assert.ok(blocked, 'CSP no longer stops an off-origin request');
  const csp = $('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  assert.includes(csp, "connect-src 'self'");
  assert.ok(!/https:\/\//.test(csp), 'a remote host has been added to the shipped CSP');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE RED TEAM. Everything the web view might try, once an origin IS pinned.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3 the SSRF sweep: every address that is not the pinned relay is refused', async () => {
  if (!PINNED) skip(SKIP_REASON);
  await setSync(true);

  // Each row is a URL a compromised page would send if this command trusted its argument. The
  // native process is outside the WebView's network rules, so every one of these would otherwise
  // be a request the CSP, the navigation delegate and `assertReachable` could not see.
  const HOSTILE = [
    ['http://192.168.1.1/api/v1/meta', 'the household router'],
    ['http://10.0.0.5/api/v1/meta', 'a private-range host'],
    ['http://169.254.169.254/api/v1/meta', 'the link-local metadata endpoint'],
    ['http://127.0.0.1:5432/api/v1/meta', 'a loopback service on another port'],
    ['http://[::1]:8787/api/v1/meta', 'loopback, spelled v6'],
    ['file:///etc/passwd', 'the filesystem'],
    ['https://evil.example/api/v1/meta', 'another origin entirely'],
    ['https://evil.example@127.0.0.1:8787/api/v1/meta', 'userinfo dressed as a host'],
    ['//127.0.0.1:8787/api/v1/meta', 'a scheme-relative address'],
    ['app://localhost/index.html', 'the shell\'s own bundle scheme'],
    ['ftp://127.0.0.1:8787/api/v1/meta', 'a scheme this product does not speak'],
  ];
  for (const [url, what] of HOSTILE) {
    // eslint-disable-next-line no-await-in-loop
    const reply = await raw({ url, method: 'GET', headers: {}, body: '' });
    assert.equal(reply.error, 'blocked', `${what} (${url}) was NOT refused: ${JSON.stringify(reply)}`);
    assert.equal(reply.status, undefined, `${what} produced an HTTP answer`);
  }
});

test('§3 the pinned origin is not enough: the path must be an /api/v1/ path', async () => {
  if (!PINNED) skip(SKIP_REASON);
  await setSync(true);
  const BAD_PATHS = [
    '/', '/admin', '/api/v2/ops', '/api/v1', '/api/v1/', '/api/v1/../../etc/passwd',
    '/api/v1/ops/../../secret', '/api/v1/.hidden', '/api/v1/ops%2f..%2fsecret',
  ];
  for (const p of BAD_PATHS) {
    // eslint-disable-next-line no-await-in-loop
    const reply = await raw({ url: PINNED + p, method: 'GET', headers: {}, body: '' });
    assert.equal(reply.error, 'blocked', `${p} was accepted as a path`);
  }
  // …and a fragment, which would let a URL carry something the signature did not cover.
  const frag = await raw({ url: PINNED + '/api/v1/meta#x', method: 'GET', headers: {}, body: '' });
  assert.equal(frag.error, 'blocked');
});

test('§3 a URL that is not the canonical rebuild is refused, however equivalent it looks', async () => {
  if (!PINNED) skip(SKIP_REASON);
  await setSync(true);
  // The shell rebuilds `pinned + path + ?query` and requires the argument to EQUAL it. Anything
  // that merely resolves to the same place — a different case, an added default port, a doubled
  // slash — is refused rather than normalised, because "normalise then compare" is where the
  // parser-differential bugs live.
  const VARIANTS = [
    PINNED.toUpperCase() + '/api/v1/meta',
    PINNED + '//api/v1/meta',
    PINNED + '/api/v1/meta?',
    PINNED + '/./api/v1/meta',
  ];
  for (const url of VARIANTS) {
    // eslint-disable-next-line no-await-in-loop
    const reply = await raw({ url, method: 'GET', headers: {}, body: '' });
    assert.equal(reply.error, 'blocked', `${url} slipped past the canonical-rebuild check`);
  }
});

test('§3 method, headers and body are all constrained, not merely forwarded', async () => {
  if (!PINNED) skip(SKIP_REASON);
  await setSync(true);
  const url = PINNED + '/api/v1/meta';

  for (const method of ['PUT', 'DELETE', 'PATCH', 'CONNECT', 'TRACE', 'get\r\nX: y']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await raw({ url, method, headers: {}, body: '' });
    assert.equal(r.error, 'blocked', `${method} was carried out`);
  }
  // A cookie is ambient authority; this transport carries a signed request and nothing else.
  for (const headers of [
    { Cookie: 'session=1' },
    { Host: 'evil.example' },
    { 'X-Forwarded-For': '127.0.0.1' },
    { Referer: 'https://evil.example' },
    { Authorization: 'LZP1 device=x\r\nX-Injected: 1' },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await raw({ url, method: 'GET', headers, body: '' });
    assert.equal(r.error, 'blocked', `${Object.keys(headers)[0]} was forwarded`);
  }
  // A GET carries no body — ADR 003 §2 hashes zero bytes for one, so a body here would be signed
  // by nobody.
  const withBody = await raw({ url, method: 'GET', headers: {}, body: '{"x":1}' });
  assert.equal(withBody.error, 'blocked');
  assert.equal(withBody.reason, 'a_get_carries_no_body');
  // …and the 4 MiB cap (ADR 003 §6.1) is the shell's too, not only the client's.
  const huge = await raw({
    url: PINNED + '/api/v1/ops', method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(4 * 1024 * 1024 + 1),
  });
  assert.equal(huge.error, 'blocked');
  assert.equal(huge.reason, 'request_body_exceeds_the_cap');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE DEMONSTRATION. A real op, sealed here, through the bridge, to a real relay and back.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4 GET /api/v1/meta answers through the bridge, and names the URL it came from', async () => {
  if (!PINNED) skip(SKIP_REASON);
  await setSync(true);

  const t = bridge(PINNED);
  const res = await t.request('GET', '/api/v1/meta');
  assert.equal(res.status, 200, 'the relay did not answer 200: ' + JSON.stringify(res));
  assert.equal(typeof res.json, 'object');
  assert.equal(res.headers['x-lzp-protocol'], String(net.PROTOCOL),
    'the protocol header did not survive the bridge');

  // FINDING P-5's shell half, checked rather than promised: the reply names the final URL and
  // `createBridgeTransport` refuses one that is not the URL it asked for. A shell that followed a
  // 302 could not have produced this.
  const reply = await raw({
    url: PINNED + '/api/v1/meta', method: 'GET',
    headers: { 'X-LZP-Protocol': '1', 'X-LZP-Client': '2.0.0' }, body: '',
  });
  assert.equal(reply.url, PINNED + '/api/v1/meta', 'the reply did not name where the bytes came from');
  assert.equal(reply.redirected, false, 'the shell reported a redirect');
  assert.equal(typeof reply.headers, 'object');
  assert.ok(!('set-cookie' in reply.headers) || reply.headers['set-cookie'] === undefined,
    'a cookie came back through a transport that has no jar');
});

test('§4 a REAL OP round-trips: sealed here, pushed through the bridge, pulled back, opened', async () => {
  if (!PINNED) skip(SKIP_REASON);
  await setSync(true);

  // ── an identity, minted in this WebView with the shipped crypto ──────────────────────────
  const ks = memKeyStore();
  const memberId = ids.memberId();
  const deviceId = ids.deviceId();
  const day = new Date().toISOString().slice(0, 10);
  const rec = await identity.ensureRecoveryIdentity(ks, memberId, { createdAt: day });
  const dev = await identity.ensureAttestedDevice(ks, memberId, rec.recSig.privateKey,
    { deviceId, createdAt: day });
  const rawKey = async (k) => new Uint8Array(await S.exportKey('raw', k));
  const dv = dev.attestation.deviceShort;

  // ── the transport under test: the BRIDGE, signing with the real, non-extractable key ──────
  const t = net.chooseTransport({
    origin: PINNED,
    deviceShort: dv,
    sign: (bytes) => identity.signBytes(dev.identity.devSig.privateKey, bytes),
    clientVersion: '2.0.0',
    invoke,
  });
  assert.equal(t.kind, 'bridge', 'the demonstration ran on fetch — which is the defect, not the fix');
  const call = async (method, path, query, body) => {
    const r = await t.transport.request(method, path, query, body);
    if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };

  // ── a space, with epoch-1 wraps to this device and to its recovery key ────────────────────
  const spaceId = ids.spaceId('family');
  const k1 = await spacekeys.createSpaceKey();
  const wrapTo = async (key, epoch, pubRawB64u) => b64u(TE.encode(JSON.stringify(
    await spacekeys.wrapSpaceKey(key, dev.identity.devKex.privateKey,
      await identity.importKexPublic(ub64(pubRawB64u)), { spaceId, epoch }))));
  const kexPubRaw = b64u(await rawKey(dev.identity.devKex.publicKey));
  const recKexPubRaw = b64u(await rawKey(rec.recKex.publicKey));

  // `POST /spaces` is rate-limited per IP per hour (ADR 003 §6.1), and this row creates a space
  // every time it runs — so a relay that has served a few of these runs answers 429. That is the
  // RELAY's cap doing its job, not the shell's transport failing, and reporting it as a failure
  // would train a reader to ignore this row. It stands down VISIBLY instead, naming the fix.
  const create = (body) => t.transport.request('POST', '/api/v1/spaces', {}, body);
  const created = await createSpaceOrSkip(create, {
    spaceId, kind: 'FAMILY', colorRef: 'gruen',
    member: {
      memberId,
      recoveryPubSig: b64u(await rawKey(rec.recSig.publicKey)),
      recoveryPubKex: recKexPubRaw,
    },
    device: {
      deviceId, deviceShort: dv,
      sigPubRaw: b64u(await rawKey(dev.identity.devSig.publicKey)),
      kexPubRaw,
      attestation: dev.blob,
    },
    wraps: [
      { recipientId: deviceId, epoch: 1, wrapped: await wrapTo(k1, 1, kexPubRaw) },
      { recipientId: `rec_${memberId}`, epoch: 1, wrapped: await wrapTo(k1, 1, recKexPubRaw) },
    ],
  });
  assert.equal(created.currentEpoch, 1, 'the relay did not create the space at epoch 1');

  // ── one real op, sealed under the space key ───────────────────────────────────────────────
  const ring = { get: (sp, ep) => (sp === spaceId && ep === 1 ? k1 : null) };
  const op = {
    v: 1, id: ids.opId(), ts: fmt(Date.now(), 0, dv), space: spaceId,
    act: memberId, dev: deviceId, gid: ids.groupId(), k: 'space.set',
    e: `space:${spaceId}`,
    f: { name: 'Familie Hein', admin: memberId, adminPrev: null, epoch: 1 },
  };
  const sealed = await envelope.sealOp(op, ring, dev.identity.devSig.privateKey,
    { v: 1, sp: spaceId, ep: 1, dv, oid: op.id, wit: '' }, { attestation: dev.attestation });

  const pushed = await call('POST', '/api/v1/ops', {}, { space: spaceId, ops: [sealed] });
  assert.equal(pushed.accepted.length, 1, 'the relay did not accept the op: ' + JSON.stringify(pushed));
  // `spaceSeq` is a decimal STRING on the wire (ADR 003 §3.3 — a seq outlives 2^53).
  assert.match(pushed.spaceSeq, /^[0-9]+$/, 'no spaceSeq came back: ' + JSON.stringify(pushed));

  // ── and back out again, through the same bridge ───────────────────────────────────────────
  const pulled = await call('GET', '/api/v1/ops', { space: spaceId, since: 0, limit: 500 });
  assert.equal(pulled.ops.length, 1, 'the op did not come back: ' + JSON.stringify(pulled));
  const row = pulled.ops[0];
  assert.equal(row.oid, op.id, 'a different op came back');
  assert.equal(row.ct, sealed.ct, 'the ciphertext changed in transit — the relay is not blind');

  // The wire row carries the relay's framing (`seq`, `chain`) around the envelope; the envelope
  // is the nine fields `ENVELOPE_FIELDS` names, and it is those that must open.
  const back = { v: row.v, sp: row.sp, ep: row.ep, dv: row.dv, oid: row.oid, wit: row.wit,
                 iv: row.iv, ct: row.ct, sig: row.sig };
  const opened = await envelope.openOp(back, ring, () => dev.attestation);
  assert.equal(opened.status, 'opened',
    'the round-tripped envelope would not open: ' + JSON.stringify(opened));
  assert.equal(opened.op.id, op.id);
  assert.equal(opened.op.f.name, 'Familie Hein',
    'the op that came back is not the op that went out — through the BRIDGE, not through fetch');

  diag(`§4 round trip complete: ${pulled.ops.length} op, spaceSeq ${pushed.spaceSeq}, `
    + `transport kind "${t.kind}", origin ${PINNED}`);
});

// ── leave the shell as we found it: solo ──────────────────────────────────────────────────────

test('§4 the run leaves sync switched off, so nothing after this file inherits a live transport', async () => {
  await setSync(false);
  const s = await invoke('sync_status');
  assert.equal(s.enabled, false);
});
