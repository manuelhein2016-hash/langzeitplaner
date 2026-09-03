// TIER 2 · THE SSRF RED TEAM — the new attack surface, attacked from the page that would do it.
// LZP-1002 · story 21.5 · ADR 003 §7 gate 3 · FINDING P-5's shell half.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY A BRIDGE COMMAND THAT PERFORMS HTTP IS THE MOST DANGEROUS THING IN THIS PRODUCT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Until `sync_request` existed, every network rule this app has was enforced INSIDE WebKit: the
// CSP, the navigation delegate, the `app://` scheme sandbox, `assertReachable`. All of them are
// rules the web view applies to itself.
//
// `sync_request` is different in kind. It is performed by the NATIVE PROCESS, which is outside
// every one of those rules. A version of it that accepted a URL from the page would be a general
// SSRF primitive handed to the least trusted component in the system — the thing that renders the
// user's own text and is where a future XSS lands. It could reach `http://192.168.1.1/` (the
// household router's admin page), `http://169.254.169.254/` (the cloud metadata endpoint),
// `http://127.0.0.1:5432/` (whatever else this Mac is running), `file:///etc/passwd`, or any
// origin at all — and the CSP would never see it happen.
//
// So the shell **pins the origin and does not accept one**. This file is the adversary's half of
// that claim. Every row here is written as the page that wants to get out, and every row requires
// the refusal to come **from the shell**, not from `net.js`: each one calls
// `invoke('sync_request', …)` directly, with no transport in the way.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE TWO MODES, AND THE DRIVER THAT SUPPLIES THEM
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//     node scripts/shell-ssrf.mjs
//
//   · **classify** — the shell is LAUNCHED with one candidate origin (`--sync-origin` /
//     `LZP_SYNC_ORIGIN`) and this file checks how the shell classified it. The origin validator
//     is Swift and cannot be called from JavaScript, so the only honest way to test it is one
//     launch per value. The driver does 28 of them.
//   · **redteam** — the shell is pinned to a HOSTILE relay (`scripts/hostile-relay.mjs`) and this
//     file attacks it: redirects, an oversized response, a stall, a cookie, and every address
//     that is not the pin.
//
// Run plainly (`npm run test:dom`) neither mode is configured and every row `skip()`s with the
// driver command in its reason — visible in the TAP output, counted separately, never a silent
// pass.
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp, diag, skip.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SSRF = globalThis.__LZP_SSRF || null;
const MODE = SSRF ? String(SSRF.mode || '') : '';
const SKIP_REASON = 'driven by `node scripts/shell-ssrf.mjs`, which launches the shipped .app once '
  + 'per candidate origin and once against a hostile loopback relay.';

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args || {});
/** The command, called RAW — no transport, no `assertReachable`, nothing between page and shell. */
const raw = (args) => invoke('sync_request', args);

const OUT = {};
const emit = () => diag('SSRF-OUT ' + JSON.stringify(OUT));

// ═════════════════════════════════════════════════════════════════════════════════════════════
// MODE `classify` — one launch, one candidate origin, one verdict
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the shell classifies the origin it was configured with, by the rule the table names', async () => {
  if (MODE !== 'classify') skip(MODE ? `mode is ${MODE}` : SKIP_REASON);
  const st = await invoke('sync_status');

  assert.equal(typeof st.configured, 'string',
    'sync_status must report what it was configured WITH — a sheet that can only say "not '
    + 'configured" cannot tell a missing relay from a rejected one');
  assert.equal(st.configured, SSRF.origin,
    `the shell was launched with ${JSON.stringify(SSRF.origin)} and reports `
    + `${JSON.stringify(st.configured)}`);

  if (SSRF.expect === null) {
    assert.equal(st.originConfigured, true,
      `${JSON.stringify(SSRF.origin)} should have been ACCEPTED, and was refused: ${st.reason}`);
    assert.equal(st.reason, null);
    assert.equal(typeof st.origin, 'string');
    // Accepted means NORMALISED, not echoed: the pin every URL is rebuilt from is lower-cased
    // scheme and host with the port only when there is one.
    assert.equal(st.origin, st.origin.toLowerCase(), 'the pin was not lower-cased');
    OUT.normalised = st.origin;
  } else {
    assert.equal(st.originConfigured, false,
      `${JSON.stringify(SSRF.origin)} should have been REFUSED and was accepted as ${st.origin}`);
    assert.equal(st.reason, SSRF.expect,
      `${JSON.stringify(SSRF.origin)} was refused by the wrong rule`);
    assert.equal(st.origin, null, 'a refused origin must not be offered as a pin');
    // …and the refusal is not phrased as an error. Nothing has gone wrong: a build with nowhere
    // to sync to is a calendar that runs entirely on this Mac.
    assert.ok(st.message && st.message.de && st.message.en, 'no sentence for a refused origin');
    assert.equal(/fehler/i.test(st.message.de), false);
    assert.equal(/error/i.test(st.message.en), false);
    OUT.reason = st.reason;
  }

  // WHATEVER the verdict, the command must refuse a request while nothing is pinned — and it must
  // do so LOCALLY. A configured-but-refused origin is exactly the state in which a bug would
  // reach the wire.
  await invoke('set_shell_pref', { key: 'sync_enabled', value: true });
  const probe = await raw({
    url: (st.origin || 'https://relay.example.org') + '/api/v1/meta',
    method: 'GET', headers: {}, body: '',
  });
  if (SSRF.expect !== null) {
    assert.equal(probe.error, 'blocked', 'a request went out while no origin was pinned');
    assert.equal(probe.reason, SSRF.expect, 'the request was refused by a different rule than the config');
  }
  await invoke('set_shell_pref', { key: 'sync_enabled', value: false });
  OUT.mode = 'classify';
  emit();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// MODE `redteam` — a hostile relay IS the pin, and the page tries to get out
// ═════════════════════════════════════════════════════════════════════════════════════════════

const PIN = SSRF ? String(SSRF.origin || '') : '';

test('§1 NO CONFIGURED ORIGIN AT ALL — every request is refused, locally, before a socket exists', async () => {
  if (MODE !== 'redteam') skip(MODE ? `mode is ${MODE}` : SKIP_REASON);
  // The state EVERY SHIPPED BUILD IS IN today (`SYNC_ORIGIN_BUILTIN = ""`), reached here by
  // turning the switch off first: check 1 is the switch and check 2 is the pin, and a request
  // that gets past neither has not resolved a name, opened a socket or allocated a session.
  await invoke('set_shell_pref', { key: 'sync_enabled', value: false });
  const off = await raw({ url: PIN + '/api/v1/meta', method: 'GET', headers: {}, body: '' });
  assert.equal(off.error, 'blocked');
  assert.equal(off.reason, 'sync_disabled',
    'the switch is not the first check — solo mode\'s zero-request promise is a property of the order');
  assert.equal(off.status, undefined, 'a refused request carried an HTTP answer');
  // The sentence a person is shown, in both languages, German first, and not an error.
  assert.ok(off.message && off.message.de && off.message.en);
  assert.equal(/fehler/i.test(off.message.de), false);

  await invoke('set_shell_pref', { key: 'sync_enabled', value: true });
  // …and with the switch ON the same request is now allowed, which is the honest-path control
  // without which the row above would pass on a shell that refused everything for ever.
  const on = await raw({ url: PIN + '/api/v1/meta', method: 'GET', headers: {}, body: '' });
  assert.equal(on.status, 200, 'the honest control did not go through: ' + JSON.stringify(on));
  OUT.controlStatus = on.status;
});

test('§2 A DIFFERENT HOST — the page names one, and the shell refuses it', async () => {
  if (MODE !== 'redteam') skip(MODE ? `mode is ${MODE}` : SKIP_REASON);
  await invoke('set_shell_pref', { key: 'sync_enabled', value: true });
  for (const url of [
    'https://evil.example/api/v1/meta',
    'https://relay.example.org/api/v1/meta',
    'https://evil.example@127.0.0.1:8792/api/v1/meta',   // userinfo dressed as a host
    '//127.0.0.1:8792/api/v1/meta',                       // scheme-relative
    'https://127.0.0.1:8792/api/v1/meta',                 // the right host, the wrong scheme
    'http://127.0.0.1:9999/api/v1/meta',                  // the right host, the wrong port
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await raw({ url, method: 'GET', headers: {}, body: '' });
    assert.equal(r.error, 'blocked', `${url} was NOT refused: ${JSON.stringify(r)}`);
    assert.equal(r.status, undefined, `${url} produced an HTTP answer`);
  }
  // AND THE ARGUMENT THAT DOES NOT EXIST. There is no `origin` parameter to this command; passing
  // one changes nothing, which is the property the whole design rests on.
  const withOrigin = await raw({
    url: 'https://evil.example/api/v1/meta', method: 'GET', headers: {}, body: '',
    origin: 'https://evil.example', pinned: 'https://evil.example', host: 'evil.example',
  });
  assert.equal(withOrigin.error, 'blocked');
  assert.equal(withOrigin.reason, 'url_is_not_the_pinned_origin');
});

test('§3 http:// TO A PUBLIC HOST — refused, and refused as a scheme problem', async () => {
  if (MODE !== 'redteam') skip(MODE ? `mode is ${MODE}` : SKIP_REASON);
  await invoke('set_shell_pref', { key: 'sync_enabled', value: true });
  // From the page, `http://` to anything but the pin is off-origin and dies there. The `http://`
  // rule proper is a CONFIGURATION rule and is exercised by the `classify` launches — see the
  // table in `scripts/shell-ssrf.mjs`, where `http://relay.example.org` is `origin_is_not_https`.
  for (const url of ['http://relay.example.org/api/v1/meta', 'http://evil.example/api/v1/meta']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await raw({ url, method: 'GET', headers: {}, body: '' });
    assert.equal(r.error, 'blocked', `${url} was not refused`);
    assert.equal(r.reason, 'url_is_not_the_pinned_origin');
  }
  // And every scheme that is not http/https, including the shell's own bundle scheme and the
  // ones that would reach the filesystem or another program.
  for (const url of [
    'file:///etc/passwd', 'app://localhost/index.html', 'ftp://127.0.0.1:8792/api/v1/meta',
    'javascript:alert(1)', 'data:text/plain,hi', 'smb://127.0.0.1/share',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await raw({ url, method: 'GET', headers: {}, body: '' });
    assert.equal(r.error, 'blocked', `${url} was not refused`);
  }
});

test('§4 LOCALHOST AND EVERY LOOPBACK SPELLING — refused, whichever way it is written', async () => {
  if (MODE !== 'redteam') skip(MODE ? `mode is ${MODE}` : SKIP_REASON);
  await invoke('set_shell_pref', { key: 'sync_enabled', value: true });
  // The pin IS a loopback host in this run — that is the headless dev carve-out — so these are
  // the OTHER loopback addresses and ports: whatever else this Mac happens to be running.
  for (const url of [
    'http://127.0.0.1:5432/api/v1/meta',     // a database
    'http://127.0.0.1:6379/api/v1/meta',     // a cache
    'http://localhost:8792/api/v1/meta',     // the same server, a different NAME for it
    'http://[::1]:8792/api/v1/meta',         // loopback, spelled v6
    'http://127.0.0.2:8792/api/v1/meta',     // elsewhere in 127/8
    'http://0.0.0.0:8792/api/v1/meta',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await raw({ url, method: 'GET', headers: {}, body: '' });
    assert.equal(r.error, 'blocked', `${url} was not refused: ${JSON.stringify(r)}`);
    assert.equal(r.status, undefined);
  }
});

test('§5 A PRIVATE RANGE AND A LINK-LOCAL ADDRESS — the router and the metadata endpoint', async () => {
  if (MODE !== 'redteam') skip(MODE ? `mode is ${MODE}` : SKIP_REASON);
  await invoke('set_shell_pref', { key: 'sync_enabled', value: true });
  // The two that matter most, and the reason a native HTTP client in a desktop app is worth
  // being frightened of: the household router's admin page, and the cloud metadata endpoint that
  // hands out credentials to anything that can reach it.
  const TARGETS = [
    ['http://192.168.1.1/api/v1/meta', 'the household router'],
    ['http://192.168.0.1/api/v1/meta', 'the other household router'],
    ['http://10.0.0.5/api/v1/meta', 'a private-range host (10/8)'],
    ['http://172.20.0.1/api/v1/meta', 'a private-range host (172.16/12)'],
    ['http://100.64.0.1/api/v1/meta', 'carrier-grade NAT space'],
    ['http://169.254.169.254/api/v1/meta', 'the link-local metadata endpoint'],
    ['http://169.254.1.1/api/v1/meta', 'link-local, generally'],
    ['http://[fe80::1]/api/v1/meta', 'link-local, spelled v6'],
    ['http://[fd00::1]/api/v1/meta', 'unique-local, spelled v6'],
    ['http://router.local/api/v1/meta', 'an mDNS name'],
    ['http://nas/api/v1/meta', 'a single-label LAN name'],
    ['http://box.home.arpa/api/v1/meta', 'a reserved LAN suffix'],
  ];
  for (const [url, what] of TARGETS) {
    // eslint-disable-next-line no-await-in-loop
    const r = await raw({ url, method: 'GET', headers: {}, body: '' });
    assert.equal(r.error, 'blocked', `${what} (${url}) was NOT refused: ${JSON.stringify(r)}`);
    assert.equal(r.status, undefined, `${what} produced an HTTP answer`);
  }
  OUT.privateTargetsRefused = TARGETS.length;
});

test('§6 A REDIRECT TO ANOTHER ORIGIN — not followed, and reported as blocked', async () => {
  if (MODE !== 'redteam') skip(MODE ? `mode is ${MODE}` : SKIP_REASON);
  await invoke('set_shell_pref', { key: 'sync_enabled', value: true });
  // FINDING P-5. `URLSession` follows redirects BY DEFAULT; refusing takes a delegate, and a
  // shell that followed one would replay a SIGNED request at a destination the relay chose —
  // undetectable from JavaScript, because the reply would carry a status and a body and no
  // address. The hostile relay 302s off-origin here.
  const off = await raw({ url: PIN + '/api/v1/rediroff', method: 'GET', headers: {}, body: '' });
  assert.equal(off.error, 'blocked', 'an off-origin redirect was followed: ' + JSON.stringify(off));
  assert.equal(off.reason, 'redirect_refused');
  assert.equal(off.status, undefined, 'the redirect produced an HTTP answer');

  // SAME-ORIGIN TOO. The relay choosing which of ITS OWN endpoints answered a signed request is
  // the same attack with a smaller blast radius, and it is the one a "just check the host" fix
  // would miss.
  const same = await raw({ url: PIN + '/api/v1/redirsame', method: 'GET', headers: {}, body: '' });
  assert.equal(same.error, 'blocked', 'a same-origin redirect was followed');
  assert.equal(same.reason, 'redirect_refused');

  // A 307 preserves the method and the body, so a followed one replays a signed POST verbatim.
  const p307 = await raw({
    url: PIN + '/api/v1/redir307', method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{"space":"fsp_x"}',
  });
  assert.equal(p307.error, 'blocked');
  assert.equal(p307.reason, 'redirect_refused');

  // THE HONEST-PATH CONTROL, and it is what makes the three rows above mean something: a normal
  // answer from the same relay goes through, names the URL it came from, and says it was not
  // redirected. Without this the rows would pass on a shell that had simply stopped working.
  const ok = await raw({ url: PIN + '/api/v1/meta', method: 'GET', headers: {}, body: '' });
  assert.equal(ok.status, 200);
  assert.equal(ok.url, PIN + '/api/v1/meta', 'the reply did not name the URL the bytes came from');
  assert.equal(ok.redirected, false);
  OUT.redirectsRefused = 3;
});

test('§7 AN OVERSIZED RESPONSE — cut at the cap, announced or not', async () => {
  if (MODE !== 'redteam') skip(MODE ? `mode is ${MODE}` : SKIP_REASON);
  await invoke('set_shell_pref', { key: 'sync_enabled', value: true });
  // Without a cap, a hostile or merely broken relay decides how much memory this process
  // allocates. 8 MiB is headroom over the largest honest answer (a pull of 500 envelopes, ADR
  // 003 §3.2) and it is still a bound.
  const t0 = Date.now();
  const flood = await raw({ url: PIN + '/api/v1/huge', method: 'GET', headers: {}, body: '' });
  const ms = Date.now() - t0;
  assert.equal(flood.error, 'transport', '12 MiB was accepted: ' + JSON.stringify(flood).slice(0, 200));
  assert.equal(flood.reason, 'response_exceeds_the_cap');
  assert.ok(ms < 15000, `the flood was cut, but only after ${ms} ms — the cap is not counting as it goes`);

  // The relay ANNOUNCING 64 MiB is the easy case and must not be the only one that works: this
  // one is refused on the response header, before a body byte is buffered.
  const announced = await raw({ url: PIN + '/api/v1/hugesaid', method: 'GET', headers: {}, body: '' });
  assert.equal(announced.error, 'transport');
  assert.equal(announced.reason, 'response_exceeds_the_cap');

  // THE CONTROL: an ordinary-sized answer from the same relay is not cut.
  const ok = await raw({ url: PIN + '/api/v1/meta', method: 'GET', headers: {}, body: '' });
  assert.equal(ok.status, 200);
  OUT.floodCutInMs = ms;
});

test('§8 NOTHING AMBIENT — no cookie is kept, and nothing the page did not ask for is sent', async () => {
  if (MODE !== 'redteam') skip(MODE ? `mode is ${MODE}` : SKIP_REASON);
  await invoke('set_shell_pref', { key: 'sync_enabled', value: true });

  // The relay hands out a cookie and then reports what it gets back. An ephemeral session with
  // `httpCookieStorage = nil` keeps none, so the second call must still see none.
  const first = await raw({ url: PIN + '/api/v1/setscookie', method: 'GET', headers: {}, body: '' });
  assert.equal(first.status, 200);
  const second = await raw({ url: PIN + '/api/v1/setscookie', method: 'GET', headers: {}, body: '' });
  assert.equal(second.status, 200);
  const body = JSON.parse(second.body);
  assert.equal(body.sawCookie, null,
    'the shell kept a cookie across requests — this transport carries a signed request and '
    + 'nothing ambient (ADR 003 §1)');

  // WHAT `URLSession` ADDS FOR FREE, read back off the wire. It was MEASURED adding
  // `User-Agent: LangzeitPlaner/1.0.0 CFNetwork/3860.700.1 Darwin/25.6.0` — this Mac's OS build —
  // and `Accept-Language: en-US,en;q=0.9` — the user's language preferences — on every sync.
  // Neither is in ADR 003 §2, neither is signed, and neither is in `server-metadata.md`'s
  // inventory. Both are pinned now, and this is the row that would notice them coming back.
  const echo = await raw({ url: PIN + '/api/v1/meta', method: 'GET', headers: {}, body: '' });
  const saw = JSON.parse(echo.body).sawHeaders || {};
  assert.equal(saw['user-agent'], 'LangzeitPlaner',
    `the relay was told ${JSON.stringify(saw['user-agent'])} — an unpinned agent leaks the OS build`);
  assert.equal(saw['accept-language'], '*',
    `the relay was told ${JSON.stringify(saw['accept-language'])} — that is the user's locale`);
  assert.equal(saw.cookie, undefined);
  assert.equal(saw.referer, undefined);
  assert.equal(saw.origin, undefined);
  OUT.userAgent = saw['user-agent'];
  OUT.acceptLanguage = saw['accept-language'];

  // …and a header the page tries to smuggle never reaches the wire at all, because the shell
  // refuses the whole request rather than dropping the header.
  for (const headers of [
    { Cookie: 'session=1' }, { Host: 'evil.example' }, { 'X-Forwarded-For': '127.0.0.1' },
    { Referer: 'https://evil.example' }, { 'Authorization': 'LZP1 x\r\nX-Injected: 1' },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await raw({ url: PIN + '/api/v1/meta', method: 'GET', headers, body: '' });
    assert.equal(r.error, 'blocked', `${Object.keys(headers)[0]} was forwarded`);
  }
  emit();
});

test('§9 A RELAY THAT NEVER ANSWERS — a timeout, not a hang', async () => {
  if (MODE !== 'redteam') skip(MODE ? `mode is ${MODE}` : SKIP_REASON);
  await invoke('set_shell_pref', { key: 'sync_enabled', value: true });
  // 15 s is `net.js`'s `DEFAULT_TIMEOUT_MS`, and ADR 003 §8.2's backoff counts a timeout as a
  // transport error rather than as an answer. A shell without one would leave a sync that never
  // returns and a settings sheet that says nothing.
  const t0 = Date.now();
  const stalled = await raw({ url: PIN + '/api/v1/stall', method: 'GET', headers: {}, body: '' });
  const ms = Date.now() - t0;
  assert.equal(stalled.error, 'timeout', 'a stalled relay did not time out: ' + JSON.stringify(stalled));
  assert.ok(ms >= 14000 && ms < 25000, `the timeout fired at ${ms} ms, not near 15 s`);
  OUT.timeoutMs = ms;
  emit();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §10 · THE REDACTION BOUNDARY, AT ITS NEWEST EDGE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// "Zero bytes of a Privat entry leave this Mac" has held four rounds. A native process that now
// speaks HTTP is a fifth surface and a different kind of one: it holds the request in memory and
// it hands a reply back to page script. `tests/tier1/headless-shell.test.js` greps the Swift for
// the static half (nothing is printed, the body is never interpolated, `sync.json` holds one
// boolean, `sync_status` reports nothing about a request). This is the RUNTIME half: whatever the
// shell answers, it must not be the thing it was given.

test('§10 nothing the shell answers ever carries the request back — on any path, refused or not', async () => {
  if (MODE !== 'redteam') skip(MODE ? `mode is ${MODE}` : SKIP_REASON);
  await invoke('set_shell_pref', { key: 'sync_enabled', value: true });

  // A marker that could only have come from the request. If it appears in ANY reply — a refusal,
  // a timeout, a cap, an OS error description — the shell has echoed what it was handed.
  const MARKER = 'lzp-redaction-marker-9f3a7c';
  const probes = [
    ['an accepted POST', { url: PIN + '/api/v1/meta', method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: `{"secret":"${MARKER}"}` }],
    ['a refused method', { url: PIN + '/api/v1/meta', method: 'PUT',
      headers: {}, body: `{"secret":"${MARKER}"}` }],
    ['an off-origin URL', { url: `https://evil.example/api/v1/${MARKER}`, method: 'GET',
      headers: {}, body: '' }],
    ['a refused header', { url: PIN + '/api/v1/meta', method: 'GET',
      headers: { Cookie: MARKER }, body: '' }],
    ['an over-cap body', { url: PIN + '/api/v1/ops', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: MARKER + 'x'.repeat(4 * 1024 * 1024) }],
    ['a redirect', { url: PIN + '/api/v1/rediroff', method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: `{"secret":"${MARKER}"}` }],
  ];
  for (const [what, args] of probes) {
    // eslint-disable-next-line no-await-in-loop
    const reply = await raw(args);
    const asText = JSON.stringify(reply);
    assert.equal(asText.includes(MARKER), false,
      `${what}: the shell's reply carries the request back — ${asText.slice(0, 300)}`);
    // A refusal must also carry no HTTP answer at all: a status and a body from a request that
    // was never sent would be the shell inventing one.
    if (reply.error) {
      assert.equal(reply.body, undefined, `${what}: a refused request came back with a body`);
      assert.equal(reply.headers, undefined, `${what}: a refused request came back with headers`);
    }
  }

  // The one field the shell DOES echo, and it is the one the contract requires: the URL the bytes
  // came from (FINDING P-5). It is the URL the page itself built, so it discloses nothing the page
  // did not already know — and `createBridgeTransport` refuses a reply whose URL is any other.
  const ok = await raw({ url: PIN + '/api/v1/meta', method: 'GET', headers: {}, body: '' });
  assert.equal(ok.url, PIN + '/api/v1/meta');
  assert.deepEqual(Object.keys(ok).sort(), ['body', 'headers', 'redirected', 'status', 'url'],
    'the reply grew a field — is it about the REQUEST?');

  // And the pref file the shell writes on every arming holds one boolean. `sync_status` is the
  // only way to read it back, and it reports the switch and the pin — never a request.
  const st = await invoke('sync_status');
  assert.deepEqual(Object.keys(st).sort(),
    ['configured', 'enabled', 'origin', 'originConfigured', 'reason'],
    'sync_status grew a field — is it about a REQUEST?');
  assert.equal(JSON.stringify(st).includes(MARKER), false);
  OUT.redactionProbes = probes.length;
  emit();
});
