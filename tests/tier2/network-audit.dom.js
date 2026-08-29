// TIER 2 · LZP-1002 — THE NETWORK-SCOPE AUDIT, IN A REAL ENGINE, IN BOTH MODES.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE PROMISE, AND WHY IT NEEDS A SECOND TEST
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   "In solo mode the app makes zero network requests; with a Familienkreis it talks to exactly
//    one sync endpoint and nothing else."                            — story 21.5, story 21.4
//
// `tests/tier1/network-scope.test.js` proves no session CAN make a request: one call site in the
// whole shipped tree, no STATIC path from the boot graph to it, exactly one dynamic door, and a
// CSP that names no remote host. That is a claim about the SOURCE.
//
// This file is the other half and it is a claim about a RUNNING APP. It boots the real
// `index.html` in the real WKWebView the product ships — the harness does not start until the
// board has rendered, so everything §1 measures happened during an actual launch — and then:
//
//   §1  SOLO · the launch loaded none of `crypto/`, `sync/`, `family/` or `platform/net.js`,
//       fetched nothing off-origin, and called no API. Measured with the Resource Timing API,
//       which records EVERY subresource including ES module fetches, from before the first line
//       of `boot.js` ran — the one observation a test running inside the page can make about
//       what happened before it existed.
//   §2  SOLO · with spies on all five ways a page can open a socket, a full session — create,
//       edit, undo, redo, settings, persist, search, layer toggles, a day roll — makes zero
//       calls. §1 says the modules were never loaded; this says the modules that WERE loaded do
//       not call out either.
//   §3  FAMILY · the transport is confined to ONE origin and to `/api/v1/…`. Every other origin,
//       scheme, path and method is refused BY NAME, before a byte leaves the process.
//   §4  the audit itself is armed: each check is shown a positive, so a green §1–§3 is a fact
//       about the app and not about a matcher that has stopped matching.
//
// ORDER MATTERS IN THIS FILE, and it is the one thing to know before editing it. §3 imports the
// family graph, which permanently changes what §1 would measure. So §1's evidence is SNAPSHOTTED
// at the top, before any `importApp` of a family module, and the tests read the snapshot.

// ── the snapshot, taken before anything in this file imports anything ────────────────────────
const SOLO_RESOURCES = performance.getEntriesByType('resource').map((r) => ({
  name: r.name,
  type: r.initiatorType,
}));
const SOLO_ORIGIN = location.origin;

const { store } = await importApp('store.js');

/** Everything family mode is made of. None of it may appear in the solo snapshot. */
const FAMILY_GRAPH = [
  '/src/js/platform/net.js',
  '/src/js/platform/keystore.js',
  '/src/js/platform/device-identity.js',
  '/src/js/sync/',
  '/src/js/crypto/',
  '/src/js/family/',
];

const hit = (name, frag) => name.includes(frag);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · SOLO — what this launch actually fetched
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1 solo · the launch loaded no family module at all', () => {
  // The strongest available statement about a solo launch: not "the code path was not taken" but
  // "the module was never even fetched". A `crypto/identity.js` in this list would mean WebCrypto
  // key generation is one function call away on a Mac that has never opted in (ADR 002 §2.4).
  const loaded = SOLO_RESOURCES
    .map((r) => r.name.replace(SOLO_ORIGIN, ''))
    .filter((n) => FAMILY_GRAPH.some((f) => hit(n, f)));
  assert.deepEqual(loaded, [], 'family-mode modules were evaluated on a solo launch: ' + loaded.join(', '));
});

test('§1 solo · the launch made no request off its own origin, and no API call', () => {
  const off = SOLO_RESOURCES.map((r) => r.name).filter((n) => !n.startsWith(SOLO_ORIGIN) && !n.startsWith('app:'));
  assert.deepEqual(off, [], 'off-origin resources: ' + off.join(', '));
  const api = SOLO_RESOURCES.map((r) => r.name).filter((n) => n.includes('/api/'));
  assert.deepEqual(api, [], 'a solo launch called the sync API: ' + api.join(', '));
  const xhr = SOLO_RESOURCES.filter((r) => r.initiatorType === 'xmlhttprequest' || r.initiatorType === 'fetch');
  assert.deepEqual(xhr.map((r) => r.name), [], 'a solo launch made an XHR or a fetch');
});

test('§1 solo · the snapshot is not empty — it really did watch a launch', () => {
  // THE VACUITY GUARD, and it is the one row in this file that stands down.
  //
  // Every assertion above is satisfied by an empty list, so the list has to be shown to be a
  // real one — a launch loads the whole board layer. **WKWebView records no Resource Timing
  // entries for the shell's `app:` custom scheme**, so inside the tier-2 harness the timeline is
  // genuinely empty and §1 is unfalsifiable HERE. That is a property of the host, not of the
  // app, and the honest response is a visible SKIP rather than two green rows that measured
  // nothing.
  //
  // The same measurement over `http:` is real and was run: `docs/v2/E5-VERIFICATION.md` §4
  // records it in Chrome against `node dev-server.mjs` — 38 resources on a solo launch, none of
  // them under `crypto/`, `sync/`, `family/` or `platform/net.js`, and zero `/api/` calls.
  // §2 below is the runtime half that DOES work in this engine, and it is not a weaker claim:
  // §1 says the modules were never fetched, §2 says the modules that were fetched never call out.
  if (SOLO_RESOURCES.length === 0) {
    assert.equal(store.personalSpaceId(), null, 'this launch is at least genuinely solo');
    skip('WKWebView records no Resource Timing entries for the app: scheme — see E5-VERIFICATION §4');
  }
  assert.ok(SOLO_RESOURCES.length > 20, `only ${SOLO_RESOURCES.length} resources — the timeline is empty`);
  for (const must of ['/src/js/boot.js', '/src/js/main.js', '/src/js/store.js', '/src/js/core/oplog.js']) {
    assert.ok(SOLO_RESOURCES.some((r) => hit(r.name, must)), `${must} was not in the timeline`);
  }
  assert.equal(store.personalSpaceId(), null, 'this launch is genuinely solo');
  assert.equal(store.hasDurableIdentity(), false, 'and it minted no durable identity');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · SOLO — a whole session, with every socket watched
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Replace all five, count every call, restore. A test that leaked one would break the next. */
function watchSockets() {
  const calls = [];
  const saved = {
    fetch: window.fetch,
    XMLHttpRequest: window.XMLHttpRequest,
    WebSocket: window.WebSocket,
    EventSource: window.EventSource,
    sendBeacon: navigator.sendBeacon,
  };
  window.fetch = (...a) => { calls.push('fetch:' + String(a[0])); return Promise.reject(new Error('blocked by the audit')); };
  window.XMLHttpRequest = function () { calls.push('XMLHttpRequest'); throw new Error('blocked by the audit'); };
  window.WebSocket = function (u) { calls.push('WebSocket:' + u); throw new Error('blocked by the audit'); };
  window.EventSource = function (u) { calls.push('EventSource:' + u); throw new Error('blocked by the audit'); };
  try { navigator.sendBeacon = (u) => { calls.push('sendBeacon:' + u); return false; }; } catch { /* read-only in some builds */ }
  return {
    calls,
    restore() {
      window.fetch = saved.fetch;
      window.XMLHttpRequest = saved.XMLHttpRequest;
      window.WebSocket = saved.WebSocket;
      window.EventSource = saved.EventSource;
      try { navigator.sendBeacon = saved.sendBeacon; } catch { /* as above */ }
    },
  };
}

test('§2 solo · a full session — edit, undo, settings, persist, search — opens no socket', async () => {
  const spy = watchSockets();
  try {
    // Everything a person does to a board in ten minutes, through the real store and the real
    // DOM layer. If any of it ever grows a "phone home", this is where it shows up.
    const cat = store.state.categories[0].id;
    store.apply('createNotePopover', { id: 'audit-1', date: '2027-03-03', text: 'Netzwerk-Audit', categoryId: cat });
    store.apply('editNotePopover', { id: 'audit-1', text: 'Netzwerk-Audit, geändert' });
    store.undo();
    store.redo();
    store.setSettings({ rowHeight: 24 });
    store.setLayer({ feiertage: false });
    store.setLayer({ feiertage: true });
    await store.persistNow();
    $('#find-input').value = 'Audit';
    $('#find-input').dispatchEvent(new Event('input', { bubbles: true }));
    $('#btn-today').click();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('focus'));
    await sleep(250);
    assert.deepEqual(spy.calls, [], 'a solo session opened a socket: ' + spy.calls.join(', '));
  } finally {
    spy.restore();
    store.apply('deleteNotePopover', { id: 'audit-1' });
    await store.persistNow();
  }
});

test('§2 solo · the spy is armed — it catches a call planted right beside the session', async () => {
  // Without this row, §2 is green the day `watchSockets` stops replacing anything.
  const spy = watchSockets();
  try {
    await window.fetch('https://example.invalid/ping').catch(() => {});
    try { new window.WebSocket('wss://example.invalid'); } catch { /* the spy throws by design */ }
    try { navigator.sendBeacon('https://example.invalid/b', 'x'); } catch { /* as above */ }
  } finally {
    spy.restore();
  }
  assert.ok(spy.calls.some((c) => c.startsWith('fetch:')), 'the fetch spy did not fire');
  assert.ok(spy.calls.some((c) => c.startsWith('WebSocket:')), 'the WebSocket spy did not fire');
});

test('§2 solo · and the engine itself refuses an off-origin request — CSP, not politeness', async () => {
  // The gate below the JS: even if every guard in the product were removed, the document's own
  // `connect-src 'self'` stops the request. This is ADR 003 §7 gate 4, measured.
  let blocked = false;
  try { await fetch('https://example.com/ping', { mode: 'no-cors' }); } catch { blocked = true; }
  assert.ok(blocked, 'CSP did not stop an off-origin request');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · FAMILY — one origin, one path prefix, everything else refused BY NAME
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// From here on the family graph is loaded, so §1's snapshot is the only evidence about a solo
// launch and it was taken before this line.

const net = await importApp('platform/net.js');

const ORIGIN = 'https://relay.example';
const OTHER = 'https://someone-else.example';

/** A transport whose `fetchImpl` records instead of dialling. Nothing leaves this process. */
function auditedTransport(origin = ORIGIN) {
  const seen = [];
  const transport = net.createFetchTransport({
    origin,
    deviceShort: 'ABCDEFGHJKMNPQRS',
    sign: async () => new Uint8Array(64),
    clientVersion: '2.0.0',
    now: () => 1_800_000_000_000,
    random: (n) => new Uint8Array(n),
    fetchImpl: async (url) => {
      seen.push(String(url));
      return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{}' };
    },
  });
  return { transport, seen };
}

test('§3 family · every request the transport makes is one origin and one path prefix', async () => {
  const { transport, seen } = auditedTransport();
  // The whole surface the client uses, taken from the demonstration: ops, spaces, pairing,
  // device adoption. Every one of them has to land inside the allowlist.
  await transport.request('GET', '/api/v1/ops', { space: 'psp_x', since: '0' });
  await transport.request('POST', '/api/v1/ops', undefined, { space: 'psp_x' });
  await transport.request('POST', '/api/v1/spaces', undefined, {});
  await transport.request('GET', '/api/v1/spaces/psp_x/members');
  await transport.request('POST', '/api/v1/pair/offer', undefined, {});
  await transport.request('POST', '/api/v1/devices/adopt', undefined, {});
  assert.equal(seen.length, 6);
  for (const u of seen) {
    assert.ok(u.startsWith(ORIGIN + '/api/v1/'), `${u} is outside the allowlist`);
    assert.equal(new URL(u).origin, ORIGIN);
    assert.ok(new URL(u).pathname.startsWith('/api/v1/'));
  }
});

test('§3 family · a second origin is refused before a byte leaves the process', async () => {
  const { transport, seen } = auditedTransport();
  // Not "it would 404" and not "CORS would stop it": `assertReachable` builds the URL, RE-PARSES
  // it, and requires the round trip to agree. The three shapes below are the ones that would
  // otherwise smuggle an origin past a naive concatenation.
  for (const bad of [
    `${OTHER}/api/v1/ops`,
    '//someone-else.example/api/v1/ops',
    'https://relay.example.attacker.test/api/v1/ops',
    '/api/v1/../../../etc/passwd',
    '/api/v2/ops',
    '/ops',
  ]) {
    let refused = null;
    try { await transport.request('GET', bad); } catch (e) { refused = e; }
    assert.ok(refused, `${bad} was NOT refused`);
    assert.equal(refused.name, 'NetError', `${bad} threw ${refused.name}, not NetError`);
  }
  assert.deepEqual(seen, [], 'a refused request still reached the socket');
});

test('§3 family · only GET and POST exist, and a GET carries no body', async () => {
  const { transport, seen } = auditedTransport();
  for (const m of ['DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE']) {
    let refused = null;
    try { await transport.request(m, '/api/v1/ops'); } catch (e) { refused = e; }
    assert.ok(refused, `${m} was not refused`);
    assert.equal(refused.kind, 'blocked');
  }
  let bodyOnGet = null;
  try { await transport.request('GET', '/api/v1/ops', undefined, { x: 1 }); } catch (e) { bodyOnGet = e; }
  assert.ok(bodyOnGet, 'a GET with a body was accepted');
  assert.deepEqual(seen, []);
});

test('§3 family · the allowlisted origin is normalised, and a path may not carry one', () => {
  assert.equal(net.normalizeOrigin('https://relay.example/'), 'https://relay.example');
  assert.equal(net.normalizeOrigin('https://relay.example:443'), 'https://relay.example');
  for (const bad of ['https://relay.example/api', 'https://relay.example?x=1', 'ftp://relay.example',
    'https://user:pw@relay.example', 'not a url']) {
    let threw = false;
    try { net.normalizeOrigin(bad); } catch { threw = true; }
    assert.ok(threw, `${bad} was accepted as an origin`);
  }
  assert.equal(net.PATH_PREFIX, '/api/v1/');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · THE AUDIT IS ARMED
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4 · §1 would have caught a family module, and §3 would have caught a second host', async () => {
  // §1's matcher, shown a positive. If `FAMILY_GRAPH` were ever emptied or the prefixes changed,
  // §1 would go green over a launch that loaded the whole crypto layer.
  const planted = ['/src/js/crypto/identity.js', '/src/js/sync/personal.js', '/src/js/family/mount.js',
    '/src/js/platform/net.js'];
  for (const p of planted) {
    assert.ok(FAMILY_GRAPH.some((f) => hit(p, f)), `the §1 matcher no longer recognises ${p}`);
  }
  for (const ok of ['/src/js/store.js', '/src/js/board.js', '/src/js/platform/updater.js']) {
    assert.equal(FAMILY_GRAPH.some((f) => hit(ok, f)), false, `the §1 matcher falsely flags ${ok}`);
  }
  // §3's matcher, shown a positive: the audited transport really does record what it sends.
  const { transport, seen } = auditedTransport();
  await transport.request('GET', '/api/v1/meta');
  assert.equal(seen.length, 1, 'the audited transport records nothing — §3 proves nothing');
  assert.ok(seen[0].startsWith(ORIGIN));
});
