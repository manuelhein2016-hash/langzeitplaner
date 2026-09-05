// ATTACK · THE PRIVACY ADVERSARY, 2 of 5 — "EXACTLY ONE SYNC ENDPOINT AND NOTHING ELSE".
//
// Story 21.5's second clause. `tests/tier1/network-scope.test.js` §3 asserts `PATH_RE` accepts
// and refuses the right strings; that is a test of a regular expression. This file attacks the
// TRANSPORT — the thing that would actually make the request — and asks the questions a regex
// cannot answer:
//
//   §1  can anything reach a second origin: a hostile path, a `//host`, a `..`, an absolute URL?
//   §2  what does the client do with a 30x to another host? with an error page? a referrer?
//   §3  what may a CALLER add to a request that the transport did not decide?
//   §4  what may the USER put in the origin field — and is `http://` refused anywhere?
//   §5  over a whole real M1 session, what is the complete set of origins, paths and methods?
//
// SUCCEEDED / FAILED are from the adversary's point of view, as in `crypto-relay-read.test.js`.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFetchTransport, createBridgeTransport, normalizeOrigin, isLoopbackHost,
  insecureOriginMessage, NetError, PATH_PREFIX, HDR, AUTH_SCHEME,
} from '../../src/js/platform/net.js';
import { createFleet } from '../helpers/fleet.js';
import { recordWire, repoFile } from '../helpers/privacy-audit.js';

const S = globalThis.crypto.subtle;

/** A transport whose socket records instead of connecting. `seen` is every URL that got out. */
function spyTransport(over = {}) {
  const seen = [];
  const t = createFetchTransport({
    origin: 'https://relay.test',
    deviceShort: 'CHFBZPVRBG6M14TJ',
    sign: async () => new Uint8Array(64),
    clientVersion: '2.0.0',
    subtle: S,
    now: () => 1787836800000,
    random: (n) => new Uint8Array(n),
    schedule: (ms, fn) => globalThis.setTimeout(fn, ms),
    unschedule: (h) => globalThis.clearTimeout(h),
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return over.respond
        ? over.respond(url, init)
        : { status: 200, headers: { forEach() {} }, async text() { return '{}'; } };
    },
    ...over.deps,
  });
  return { t, seen };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 — A SECOND ORIGIN
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · a second origin, tried eleven ways', () => {
  test('FAILED — every hostile path is refused BEFORE a byte leaves the process', async () => {
    // The distinction that matters and that a regex test cannot make: refused *before the
    // socket*. A transport that built the URL, opened the connection and only then noticed would
    // have already leaked a DNS lookup and a TLS SNI to the attacker's host — which is a real
    // request, to a real second origin, whatever the response is discarded.
    const { t, seen } = spyTransport();
    const hostile = [
      'https://evil.example/api/v1/ops',
      'http://evil.example/api/v1/ops',
      '//evil.example/api/v1/ops',
      '/\\evil.example/api/v1/ops',
      '/api/v1/../../etc/passwd',
      '/api/v1/ops/../../../../evil',
      '/api/v1/ops?redirect=https://evil.example',
      '/api/v1/ops#https://evil.example',
      '/api/v2/ops',
      '/ops',
      'api/v1/ops',
      '/api/v1/',
      '/api/v1',
      '/api/v1/ops\n/api/v1/meta',
      '/api/v1/./ops',
    ];
    const kinds = [];
    for (const path of hostile) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(() => t.request('GET', path, undefined, null, {}), (e) => {
        assert.ok(e instanceof NetError, `${path} threw ${e.name}, not a NetError`);
        kinds.push(e.kind);
        return true;
      }, `${path} was not refused`);
    }
    assert.deepEqual(seen, [], 'a hostile path reached the socket');
    assert.deepEqual([...new Set(kinds)], ['blocked'], 'every refusal must be `blocked`, never a generic throw');
  });

  test('FAILED — a hostile QUERY cannot smuggle a host either, and the URL is re-parsed to prove it', async () => {
    // `assertReachable` builds the URL, parses it back and requires the parse to agree. This is
    // the half a path-only test misses: a query value is attacker-controlled in the one place it
    // matters — `since` comes off the relay's own `nextCursor`.
    const { t, seen } = spyTransport();
    await t.request('GET', '/api/v1/ops', {
      space: 'psp_AAAAAAAAAAAAAAAAAAAAAA',
      since: 'https://evil.example/#',
      limit: '500',
    }, null, {});
    assert.equal(seen.length, 1);
    const u = new URL(seen[0].url);
    assert.equal(`${u.protocol}//${u.host}`, 'https://relay.test');
    assert.equal(u.pathname, '/api/v1/ops');
    assert.equal(u.hash, '', 'a fragment survived into the URL');
    assert.equal(u.searchParams.get('since'), 'https://evil.example/#');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 — REDIRECTS, ERROR PAGES, REFERRERS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · what the transport tells the platform, and what it does with an answer', () => {
  test('FAILED — the fetch is made with redirect:error, credentials:omit, no referrer and no cache', async () => {
    // `redirect: 'error'` is the whole answer to "a 302 to another host": the platform rejects
    // rather than replaying the SIGNED request at a destination the relay chose. The other three
    // are the ambient channels a browser adds for free — a cookie jar, a Referer, a shared cache
    // an intermediary can read.
    const { t, seen } = spyTransport();
    await t.request('POST', '/api/v1/ops', {}, { space: 'psp_AAAAAAAAAAAAAAAAAAAAAA', ops: [] }, {});
    const init = seen[0].init;
    assert.equal(init.redirect, 'error', 'a 30x would be FOLLOWED — the signed request is replayable');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal, 'no abort signal — a hung request never times out');
  });

  test('FAILED (held) — the bridge reply must name the URL it came from, and a stranger is refused', async () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-5 · MEDIUM · story 21.5 · ADR 003 §7 gate 3. **JS half CLOSED by WP-9; the
    // SHELL half is still owed and is named at the bottom of this row.** Inverted, not deleted.
    //
    // WHAT IT WAS. On the `fetch` path "no redirects" is a fact the PLATFORM enforces:
    // `redirect: 'error'` makes a 302 a rejected promise, so the signed request is never
    // replayed at a destination the relay chose. On the SHIPPING path — `createBridgeTransport`
    // handing `{url, method, headers, body}` to a native `sync_request` — it was a SENTENCE IN A
    // COMMENT. The reply carried a status and a body and not the URL they came from, so a shell
    // that followed a redirect (`URLSession` follows them by default; refusing takes a delegate)
    // was undetectable from JS, and the page would have read another host's answer as the
    // relay's.
    //
    // WHAT LANDED. The reply carries the FINAL url; the transport refuses one that is not the
    // url it asked for, and refuses `redirected: true` for a shell that reports the fact without
    // the address. Both are refused BEFORE the body is parsed.
    //
    // WHAT LANDED SINCE (LZP-1002). Both shells now implement `sync_request` and both put the
    // final URL on every reply, so the field is no longer optional: an OMISSION is refused the
    // same way a MISMATCH is. The row below, which used to pin the half-measure, is inverted.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const mk = (reply) => createBridgeTransport({
      origin: 'https://relay.test', deviceShort: 'CHFBZPVRBG6M14TJ',
      sign: async () => new Uint8Array(64), clientVersion: '2.0.0', subtle: S,
      now: () => 1787836800000, random: (n) => new Uint8Array(n),
      invoke: async () => reply,
    });
    const OK = { status: 200, headers: {}, body: '{}' };

    // A stranger's answer is `blocked`, not a parsed anything.
    await assert.rejects(
      () => mk({ ...OK, url: 'https://evil.example/api/v1/meta' }).request('GET', '/api/v1/meta'),
      (e) => e instanceof NetError && e.kind === 'blocked' && /evil\.example/.test(e.message),
      'a reply from another host was accepted — P-5 has been reverted');
    // Same host, different path — the relay choosing which endpoint answered is the same attack.
    await assert.rejects(
      () => mk({ ...OK, url: 'https://relay.test/api/v1/ops' }).request('GET', '/api/v1/meta'),
      (e) => e instanceof NetError && e.kind === 'blocked');
    // A shell that admits the redirect without naming the destination is refused too.
    await assert.rejects(
      () => mk({ ...OK, redirected: true }).request('GET', '/api/v1/meta'),
      (e) => e instanceof NetError && e.kind === 'blocked' && /redirect/.test(e.message));
    // And the honest answer still goes through, url and all.
    const good = await mk({ ...OK, url: 'https://relay.test/api/v1/meta' }).request('GET', '/api/v1/meta');
    assert.deepEqual(good, { status: 200, headers: {}, json: {} });

    // The refusal happens BEFORE the body is read: a hostile answer must not be parsed at all.
    await assert.rejects(
      () => mk({ status: 200, headers: {}, body: 'not json', url: 'https://evil.example/api/v1/meta' })
        .request('GET', '/api/v1/meta'),
      (e) => e.kind === 'blocked', 'the body was parsed before the origin was checked');

    // And the JS half that was always closed: nothing anywhere reads a Location header.
    for (const f of ['src/js/sync/personal.js', 'src/js/platform/net.js', 'src/js/family/engine.js']) {
      assert.equal(/location['"\]]|\bLocation\b/i.test(repoFile(f).replace(/globalThis\.location|location\?\.reload/g, '')),
        false, `${f} reads a Location header`);
    }
  });

  test('FAILED (closed) — a bridge reply that omits `url` is REFUSED, now that both shells send one', async () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // THE OTHER HALF OF P-5, CLOSED. **Inverted, not deleted.**
    //
    // WHAT IT WAS. The check above caught a MISMATCH and not an OMISSION, so a shell that simply
    // never sent the field disabled it silently — exactly the shape of defence this suite exists
    // to distrust. It was a half-measure with a stated deadline: `sync_request` was implemented
    // by NEITHER shell, so requiring the field would have refused every reply in
    // `tests/tier1/platform-net.test.js` and no real one.
    //
    // WHAT CHANGED. LZP-1002 shipped the command in both shells. `shell-macos/main.swift`'s
    // `SyncRequestDelegate.urlSession(_:task:didCompleteWithError:)` puts
    // `http.url?.absoluteString` on the answer, and `src-tauri/src/lib.rs` mirrors it. There is
    // now a build in the world that sends the field, so the deadline has passed and
    // `reply.url` is REQUIRED. A quiet shell is a blocked shell.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const mk = (reply) => createBridgeTransport({
      origin: 'https://relay.test', deviceShort: 'CHFBZPVRBG6M14TJ',
      sign: async () => new Uint8Array(64), clientVersion: '2.0.0', subtle: S,
      now: () => 1787836800000, random: (n) => new Uint8Array(n),
      invoke: async () => reply,
    });

    // The omission — the case that used to succeed.
    await assert.rejects(
      () => mk({ status: 200, headers: {}, body: '{}' }).request('GET', '/api/v1/meta'),
      (e) => e instanceof NetError && e.kind === 'blocked' && /without naming the URL/.test(e.message),
      'a bridge reply that names no URL was accepted — P-5 has been reverted');
    // …and `null` / `''` are omissions too, not "close enough".
    for (const bad of [null, '', 0, {}]) {
      await assert.rejects(
        () => mk({ status: 200, headers: {}, body: '{}', url: bad }).request('GET', '/api/v1/meta'),
        (e) => e instanceof NetError && e.kind === 'blocked', `url: ${JSON.stringify(bad)}`);
    }
    // THE HONEST-PATH CONTROL. Without this the row would pass on a transport that refused
    // every reply, which proves nothing about the check.
    assert.deepEqual(
      await mk({ status: 200, headers: {}, body: '{}', url: 'https://relay.test/api/v1/meta' })
        .request('GET', '/api/v1/meta'),
      { status: 200, headers: {}, json: {} });

    // The contract is still written down in the file the Swift and the Rust were written from.
    const bridge = repoFile('src/js/platform/net.js');
    assert.match(bridge, /body: String, url: String/,
      'the sync_request contract no longer promises a final url — P-5 cannot be closed without it');
    // The deadline sentence is GONE, and its absence is the receipt that this row inverted.
    assert.equal(/neither shell implements `sync_request` yet/.test(bridge), false,
      'net.js still says no shell implements sync_request, but this row assumes one does');
    // BOTH shells, held to the same promise: each must name the URL on the way back.
    const swift = repoFile('shell-macos/main.swift');
    assert.match(swift, /"url": finalURL/, 'the Swift shell no longer names the final URL');
    assert.match(swift, /completionHandler\(nil\)/, 'the Swift shell no longer refuses redirects');
    const rust = repoFile('src-tauri/src/lib.rs');
    assert.match(rust, /"url"/, 'the Rust shell no longer names the final URL');
  });

  test('FAILED — an HTML error page is a bad_response, not a parsed anything', async () => {
    // The other thing a hostile or merely broken relay returns: a Cloudflare interstitial, a
    // captive-portal login page, a 502 with markup. It must not be parsed, must not be rendered,
    // and must not be mistaken for an empty answer.
    const { t } = spyTransport({
      respond: () => ({
        status: 502,
        headers: { forEach(fn) { fn('text/html', 'content-type'); } },
        async text() { return '<html><body>Sign in to the hotel wifi</body></html>'; },
      }),
    });
    await assert.rejects(() => t.request('GET', '/api/v1/ops', undefined, null, {}), (e) => {
      assert.equal(e.kind, 'bad_response');
      return true;
    });
  });

  test('FAILED — an empty body is null and never a throw, so a 204 does not look like an attack', async () => {
    const { t } = spyTransport({
      respond: () => ({ status: 204, headers: { forEach() {} }, async text() { return ''; } }),
    });
    const r = await t.request('GET', '/api/v1/ops', undefined, null, {});
    assert.deepEqual(r, { status: 204, headers: {}, json: null });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 — WHAT A CALLER MAY ADD
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · the request surface, and who decides it', () => {
  test('SUCCEEDED — `extraHeaders` is an unbounded channel: Cookie and Referer are both accepted', async () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-6 · LOW today, MEDIUM the day the bridge lands · ADR 003 §1.
    //
    // `net.js` says "These five headers are the whole request surface, and `extraHeaders` may
    // not overwrite one of them." The second clause is enforced — an attempt to set
    // `X-LZP-Client` is a `config` throw, asserted below. The FIRST clause is not: `extraHeaders`
    // is an allowlist-free passthrough, so a caller may add any header at all, including the two
    // ADR 003 §1 exists to forbid.
    //
    // Today it is latent: every one of the five call sites passes `{}` or nothing (asserted
    // below), and on the `fetch` path a browser drops `Cookie` and `Referer` as forbidden header
    // names anyway. It stops being latent on the BRIDGE path, where the headers object is handed
    // to a native HTTP client that has no forbidden-header list — so on the shipping transport a
    // future caller really could attach a cookie or a referrer, and nothing between it and the
    // socket would notice.
    //
    // The fix is one line: an allowlist in `buildRequest` instead of a collision check.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const { t, seen } = spyTransport();
    await t.request('GET', '/api/v1/ops', undefined, null, {
      Cookie: 'session=abc',
      Referer: 'https://relay.test/board',
      'X-Telemetry': 'v=1;board=privat',
    });
    const sent = Object.keys(seen[0].init.headers);
    assert.ok(sent.includes('Cookie'), 'if this goes red an allowlist landed — close finding P-6');
    assert.ok(sent.includes('Referer'));
    assert.ok(sent.includes('X-Telemetry'));

    // The half that IS enforced.
    await assert.rejects(() => t.request('GET', '/api/v1/ops', undefined, null, { 'x-lzp-client': 'spoof' }),
      (e) => e.kind === 'config');
    await assert.rejects(() => t.request('GET', '/api/v1/ops', undefined, null, { Authorization: 'Bearer x' }),
      (e) => e.kind === 'config');

    // And the reason it is LOW: nobody uses it. Every `.request(` in the product passes `{}`,
    // `undefined`, or nothing at all as the fifth argument.
    const callers = ['src/js/sync/personal.js', 'src/js/family/mount.js', 'src/js/family/engine.js',
      'src/js/family/pairflow.js'];
    for (const f of callers) {
      for (const call of repoFile(f).match(/\.request\([^;]*?\);/gs) || []) {
        assert.equal(/,\s*\{\s*[A-Za-z'"]/.test(call.slice(call.lastIndexOf(','))), false,
          `${f} passes real extra headers: ${call.slice(0, 120)}`);
      }
    }
  });

  test('FAILED — only GET and POST exist, and a GET may not carry a body', async () => {
    const { t, seen } = spyTransport();
    for (const m of ['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT']) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(() => t.request(m, '/api/v1/ops', undefined, null, {}), (e) => e.kind === 'blocked');
    }
    await assert.rejects(() => t.request('GET', '/api/v1/ops', undefined, { leak: 'x' }, {}),
      (e) => e.kind === 'blocked');
    assert.deepEqual(seen, []);
  });

  test('FAILED — the auth header names a device and a nonce, and carries no cookie and no session', async () => {
    const { t, seen } = spyTransport();
    await t.request('GET', '/api/v1/ops', undefined, null, {});
    const h = seen[0].init.headers;
    assert.deepEqual(Object.keys(h).sort(), [HDR.auth, HDR.client, HDR.protocol].sort());
    assert.match(h[HDR.auth], new RegExp(`^${AUTH_SCHEME} device=[0-9A-Z]{16}, ts=\\d+, nonce=[\\w-]{22}, sig=`));
    assert.equal(/session|token|bearer|cookie/i.test(h[HDR.auth].replace(AUTH_SCHEME, '')), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE ORIGIN IS A FIELD A HUMAN TYPES INTO
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · the one allowed origin is chosen by the user, in a text box', () => {
  test('FAILED (held) — `http://` reaches nothing but this Mac, and the sheet says why first', () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-7 · MEDIUM · CLOSED by WP-9. INVERTED, not deleted — this row now guards the
    // fix, and it is written so that reverting either half turns it red.
    //
    // WHAT IT WAS. There is no default relay (ADR 003 §1 names a host that does not exist yet),
    // so the origin is a free-text field in the settings sheet, saved on every keystroke, and it
    // is the ONLY thing that decides where the whole personal board is sent. `normalizeOrigin`
    // accepted `http:` for EVERY host — `node dev-server.mjs` needs it, and `app:` for the shell
    // — and nothing above it narrowed that back down. The field's placeholder said `https://…`
    // and the opt-in button's whole validation was `if (!origin)`.
    //
    // WHAT IT COST. The payload is end-to-end encrypted, so the CONTENT was never the exposure.
    // Everything in `server-metadata.md` §2 and §5 was: the personal space id, the deviceShort,
    // the read cursor, the op count, the byte count, the timing of every single edit — plus the
    // `Authorization` header and its nonce — in the clear to anyone on the same café wifi. §8
    // states "TLS in transit" as a FACT about this product and the Datenschutz copy inherits it;
    // for one mistyped scheme it was false.
    //
    // WHAT LANDED. Both halves of the fix the finding named, because either alone is weak: a
    // guard with no sentence produces an error the user cannot act on, and a sentence with no
    // guard is a suggestion.
    //
    //   1. `normalizeOrigin` refuses a non-loopback `http://` outright — the rule, in the one
    //      function every transport is built through, so a caller that never opens the sheet is
    //      covered too.
    //   2. `familysettings.js`'s opt-in button asks that same function BEFORE anything is minted
    //      and shows `insecureOriginMessage()`, which says what would be readable rather than
    //      „ungültig" at an address the user can see nothing wrong with.
    //
    // The carve-out is loopback and only loopback: `node dev-server.mjs` + `node
    // server/dev-server.mjs` live there, and a host that is this machine has no wire to tap.
    // ═══════════════════════════════════════════════════════════════════════════════════════

    // ── 1. THE RULE ────────────────────────────────────────────────────────────────────────
    for (const remote of [
      'http://relay.example', 'http://192.0.2.7:8787', 'http://127.0.0.1.evil.example',
      'http://localhost.evil.example', 'http://[2001:db8::1]:8787', 'http://128.0.0.1',
      'http://12.7.0.0.1', 'http://xn--127-0-0-1-9zg.example',
    ]) {
      assert.throws(() => normalizeOrigin(remote), (e) => e instanceof NetError && e.kind === 'config',
        `normalizeOrigin still accepts ${remote} — P-7 has been reverted`);
    }
    // …and the carve-out is exactly this machine, in every spelling `URL` normalises to it.
    assert.equal(normalizeOrigin('http://127.0.0.1:8788'), 'http://127.0.0.1:8788');
    assert.equal(normalizeOrigin('http://127.9.9.9'), 'http://127.9.9.9');
    assert.equal(normalizeOrigin('http://localhost:5173'), 'http://localhost:5173');
    assert.equal(normalizeOrigin('http://relay.localhost:8787'), 'http://relay.localhost:8787');
    assert.equal(normalizeOrigin('http://[::1]:8788'), 'http://[::1]:8788');
    // https and the shell's own scheme are untouched.
    assert.equal(normalizeOrigin('https://relay.example'), 'https://relay.example');
    assert.equal(normalizeOrigin('app://localhost'), 'app://localhost');

    // ── 2. THE SENTENCE, BEFORE THE BUTTON DOES ANYTHING ──────────────────────────────────
    const sheet = repoFile('src/js/family/familysettings.js');
    const handler = sheet.slice(sheet.indexOf("go.addEventListener('click'"), sheet.indexOf('acts.appendChild(go)'));
    assert.match(handler, /normalizeOrigin\(origin\)/,
      'the opt-in button no longer asks the one function that decides — P-7 has been reverted');
    assert.match(handler, /insecureOriginMessage\(\)/, 'the button refuses without saying why');
    // It must refuse BEFORE the button is disabled and before anything is minted: a refused
    // address has to leave the sheet usable, because fixing it is the very next thing.
    assert.ok(handler.indexOf('normalizeOrigin(origin)') < handler.indexOf('go.disabled = true'),
      'the scheme is checked after the button commits');
    assert.ok(handler.indexOf('normalizeOrigin(origin)') < handler.indexOf('hooks.onOptIn'),
      'the space is created before the scheme is checked');

    // The sentence itself is `net.js`'s, in both languages, and it names the scheme rather than
    // an algorithm — the same discipline `probe.js`'s `unavailableMessage` uses.
    const msg = insecureOriginMessage();
    assert.deepEqual(Object.keys(msg).sort(), ['de', 'en']);
    for (const lang of ['de', 'en']) {
      assert.match(msg[lang], /http:\/\//);
      assert.match(msg[lang], /https:\/\//);
      assert.ok(msg[lang].length > 80, `the ${lang} sentence explains nothing`);
    }

    // The comparison that made the finding concrete, kept: the UPDATER — a far smaller exposure,
    // one signed manifest — has refused anything but https by name since E1. This is now the
    // same rule at the larger exposure.
    assert.match(repoFile('src/js/platform/updater.js'), /u\.protocol !== 'https:'/);
  });

  test("FAILED (held) — the loopback carve-out is a HOSTNAME test, not a string that can be dressed up", () => {
    // The way a rule of this shape dies: `origin.startsWith('http://localhost')` or
    // `/127\.0\.0\.1/.test(origin)`, and `http://127.0.0.1.evil.example` walks through it. The
    // predicate is written over `URL.hostname` — already lower-cased, already punycoded, with
    // `http://127.1` already resolved to `127.0.0.1` — so a remote host cannot be spelled as a
    // local one. Asserted directly, and over the whole /8 rather than one address.
    for (const yes of ['localhost', 'a.localhost', '127.0.0.1', '127.9.9.9', '127.0.0.255', '[::1]']) {
      assert.equal(isLoopbackHost(yes), true, `${yes} is this machine`);
    }
    for (const no of [
      '127.0.0.1.evil.example', 'localhost.evil.example', 'evil.example', '128.0.0.1',
      '1270.0.0.1', '127.0.0.256', '::1', '[2001:db8::1]', 'notlocalhost', '', 'LOCALHOST',
    ]) {
      assert.equal(isLoopbackHost(no), false, `${no} is not this machine and must not pass`);
    }
    // `LOCALHOST` is false ON PURPOSE and is not a hole: the predicate is fed `URL.hostname`,
    // which is already lower-cased, so the only way to reach it in upper case is to call it with
    // a raw user string — which is the bug this row would catch.
    assert.equal(new URL('http://LOCALHOST:1/').hostname, 'localhost');
  });

  test('FAILED — an origin may not carry a path, a query, a fragment or credentials', () => {
    for (const bad of [
      'https://relay.example/api', 'https://relay.example/?x=1', 'https://relay.example/#f',
      'https://user:pass@relay.example', 'https://user@relay.example',
      'ftp://relay.example', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd',
      '', 'relay.example', 'not a url',
    ]) {
      assert.throws(() => normalizeOrigin(bad), (e) => e instanceof NetError && e.kind === 'config', bad);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 — A WHOLE M1 SESSION, RECORDED
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · everything two real Macs address over a real session', () => {
  test('FAILED — one origin, three paths, two methods, and a GET with no body', async () => {
    // The measurement the static gates cannot make: what a RUNNING pair of Macs actually
    // addresses. Two distinct durable identities, the shipped engine, the real handlers.
    const fleet = await createFleet({ board: BOARD() });
    const rec = recordWire(fleet.wire);
    try {
      await fleet.A.apply('createNotePopover', {
        id: 'p1', date: '2027-05-06', text: 'Blutdruck-Check Praxis Sonnenberg', categoryId: 'c1',
      });
      await fleet.settle(2);
      await fleet.B.apply('editNotePopover', { id: 'p1', text: 'Blutdruck-Check — 14:30' });
      await fleet.settle(2);
    } finally {
      rec.restore();
    }

    assert.ok(rec.calls.length >= 4, `only ${rec.calls.length} requests were made`);
    assert.deepEqual([...new Set(rec.calls.map((c) => c.path))].sort(),
      ['/api/v1/ops'], 'the steady state addresses exactly one path');
    assert.deepEqual([...new Set(rec.calls.map((c) => c.method))].sort(), ['GET', 'POST']);
    for (const c of rec.calls) {
      assert.ok(c.path.startsWith(PATH_PREFIX), `${c.path} is outside ${PATH_PREFIX}`);
      if (c.method === 'GET') assert.equal(c.rawBody.length, 0, 'a GET carried a body');
      assert.deepEqual(Object.keys(c.headers).sort().filter((k) => k.startsWith('x-lzp')),
        ['x-lzp-client', 'x-lzp-protocol']);
    }
  });

  test('FAILED — the complete set of paths the SOURCE can build is eleven, all under /api/v1/', () => {
    // The session above exercises the steady state. Pairing and opt-in add five more paths that
    // no fleet run reaches (the harness drives pairing over `mitm.js`, not over HTTP), so they
    // are read out of the source instead — which is the stronger statement anyway: this is every
    // path the product is CAPABLE of building, not every path one run happened to build.
    //
    // `src/js/feedback/port.js` IS IN THIS LIST AND WAS NOT (LZP-1009, this pass). It holds
    // `FEEDBACK_PATH`, and `family/mount.js#bindFeedback` addresses it by that IDENTIFIER — so
    // for one pass the product could build a ninth path and this enumeration could not see it.
    // A path constant that lives in a leaf module is exactly the shape this row exists to catch.
    //
    // ██ AND `src/js/feedback/relay.js` JOINS IT NOW (LZP-1009 SECOND PASS, 2026-09-05). ██
    // It is the only other module that builds a path: the solo sender's `POST /api/v1/feedback`
    // and the OPERATOR'S READER's two. Nine becomes eleven, and the two new ones are the first
    // paths in this product that carry a value that came BACK over the network — a report id —
    // which is why `relay.js#assertId` refuses anything but `rep_` + 22 base64url characters
    // BEFORE the value is concatenated into a URL, rather than leaving `assertReachable` to catch
    // it two modules later. `e10-network-scope.test.js` §2d drives the look-alikes.
    //
    // ⚠ THE THREE PATHS ARE WRITTEN AS LITERALS IN `relay.js` ON PURPOSE — `port.js`'s
    // `FEEDBACK_PATH` is not imported there — precisely so this enumeration can see them. A
    // constant reached by identifier is a path this row cannot read, which is the defect the
    // paragraph above records.
    const files = ['src/js/sync/personal.js', 'src/js/family/mount.js', 'src/js/family/engine.js',
      'src/js/family/pairflow.js', 'src/js/crypto/pairing.js', 'src/js/crypto/backup.js',
      'src/js/feedback/port.js', 'src/js/feedback/relay.js'];
    const paths = new Set();
    for (const f of files) {
      for (const m of repoFile(f).matchAll(/['"`](\/api\/v1\/[^'"`]*)['"`]/g)) {
        paths.add(m[1].replace(/\$\{[^}]*\}/g, ':id'));
      }
    }
    assert.deepEqual([...paths].sort(), [
      '/api/v1/devices/adopt',
      // LZP-1009. The ONE path a solo Mac can address, and only after a person has written a
      // sentence and read the whole payload on the preview screen. `docs/v2/server-metadata.md`
      // carries its line; story 21.5's „zero requests in solo mode" was already amended for it.
      '/api/v1/feedback',
      // LZP-1009 SECOND PASS. The OPERATOR'S two, and neither is reachable from a solo Mac: the
      // shell's carve-out is a single (method, path) pair (`e10-network-scope` §2b), and the relay
      // answers 404 on both unless `LZP_REPORTS_ADMIN_PUB` is configured and the P-256 signature
      // over `lzp/reports/v1\n` verifies. `:id` is a report id, refused by shape before it reaches
      // a URL. `docs/v2/server-metadata.md` §7.6 carries their line.
      '/api/v1/feedback/:id',
      '/api/v1/feedback/:id/delete',
      '/api/v1/ops',
      '/api/v1/pair/:id',
      '/api/v1/pair/answer',
      '/api/v1/pair/deliver',
      '/api/v1/pair/offer',
      '/api/v1/spaces',
      '/api/v1/spaces/:id/members',
    ], 'the addressable path set changed — every entry needs a line in server-metadata.md');
  });
});

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n0', date: '2027-03-04', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false }],
  bars: [{ id: 'b0', startDate: '2027-07-01', endDate: '2027-07-14', label: 'Urlaub', categoryId: 'c1' }],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: { '2027-03': 'Notizen' },
  settings: { locale: 'de' },
});
