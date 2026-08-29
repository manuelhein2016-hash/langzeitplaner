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
  createFetchTransport, normalizeOrigin, NetError, PATH_PREFIX, HDR, AUTH_SCHEME,
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

  test('SUCCEEDED — a 30x that a transport DOES return is not followed, but nothing verifies that it was not', () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-5 · MEDIUM · story 21.5 · ADR 003 §7 gate 3.
    //
    // Two halves, and only the first is closed.
    //
    // CLOSED: on the `fetch` path, `redirect: 'error'` makes the platform reject and
    // `sync/personal.js` reads `res.status` and never `res.headers.location` — so a 302 is a
    // failed pull and nothing follows it. Asserted below.
    //
    // OPEN: the SHIPPING path is `createBridgeTransport`, which hands `{url, method, headers,
    // body}` to a native `sync_request` command and trusts the reply. `net.js`'s own contract
    // says "the shell follows NO redirects and sends no cookies" — and **neither shell
    // implements `sync_request` at all** (E5's report, §6, owed to E1). So the redirect defence
    // that will actually ship is a sentence in a comment, in a command nobody has written, and
    // there is nothing on the JS side that could detect a shell which followed one: the reply
    // carries a status and a body, not the URL it came from.
    //
    // The cheap hardening, if the PO wants one: have `sync_request` return the FINAL url and
    // have `createBridgeTransport` refuse a reply whose url is not the one it asked for. That is
    // four lines and it turns an unverifiable promise into a checked one.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const bridge = repoFile('src/js/platform/net.js');
    const factory = bridge.slice(bridge.indexOf('export function createBridgeTransport'));
    assert.equal(/reply\.url|finalUrl|redirected/.test(factory), false,
      'the bridge transport now checks where the answer came from — close finding P-5');
    assert.match(factory, /sync_request/);

    // And the JS half that is closed: nothing anywhere reads a Location header.
    for (const f of ['src/js/sync/personal.js', 'src/js/platform/net.js', 'src/js/family/engine.js']) {
      assert.equal(/location['"\]]|\bLocation\b/i.test(repoFile(f).replace(/globalThis\.location|location\?\.reload/g, '')),
        false, `${f} reads a Location header`);
    }
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
  test('SUCCEEDED — `http://` is accepted everywhere, so one typo drops TLS for the whole stream', () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-7 · MEDIUM · story 21.3 · `server-metadata.md` §8 ("TLS in transit").
    //
    // There is no default relay (ADR 003 §1 names a host that does not exist yet), so the origin
    // is a free-text field in the settings sheet, saved on every keystroke, and it is the ONLY
    // thing that decides where the whole personal board is sent. `normalizeOrigin` accepts
    // `http:` deliberately — `node dev-server.mjs` needs it, and so does `app:` for the shell —
    // and NOTHING above it narrows that back down for a shipping build. The field's placeholder
    // says `https://…` and its validation is `if (!origin)`.
    //
    // What a `http://` origin costs, given that the payload is end-to-end encrypted: the CONTENT
    // is still safe, and everything in `server-metadata.md` §2 and §5 — the personal space id,
    // the device short, the read cursor, the op count, the byte count, the timing of every edit
    // — travels in the clear to anyone on the same café wifi, plus the `Authorization` header
    // and the 16-byte nonce. `server-metadata.md` §8 states "TLS in transit" as a fact about the
    // product; for an `http://` origin it is false, and the Datenschutz copy would inherit that.
    //
    // Two honest fixes, both small: refuse a non-`https:` origin unless the host is a loopback
    // literal, or accept it and say so in the sheet in one red line. Owner: WP-9 (the field) or
    // whoever holds `net.js` (the guard).
    // ═══════════════════════════════════════════════════════════════════════════════════════
    assert.equal(normalizeOrigin('http://relay.example'), 'http://relay.example');
    assert.equal(normalizeOrigin('http://192.0.2.7:8787'), 'http://192.0.2.7:8787');
    assert.equal(normalizeOrigin('https://relay.example'), 'https://relay.example');
    assert.equal(normalizeOrigin('app://localhost'), 'app://localhost');

    // Nothing in the UI or the engine narrows it. The opt-in button's whole validation is
    // emptiness, and `https` appears in that file exactly twice: in a prose comment and as the
    // input's PLACEHOLDER — which is a hint, not a check.
    const sheet = repoFile('src/js/family/familysettings.js');
    const handler = sheet.slice(sheet.indexOf("go.addEventListener('click'"), sheet.indexOf('acts.appendChild'));
    assert.match(handler, /if \(!origin\) \{ toast\(t\('familyNeedRelay'\)\); return; \}/);
    assert.equal(/https|protocol|scheme|startsWith/.test(handler), false,
      'the opt-in button now checks the scheme — close finding P-7');
    assert.deepEqual(sheet.match(/https/g), ['https', 'https'], 'a third https appeared — re-read P-7');
    assert.match(sheet, /input\.placeholder = 'https:\/\/…';/);
    assert.equal(/https/.test(repoFile('src/js/family/engine.js').replace(/\/\/[^\n]*/g, '')), false,
      'the engine now demands https — close finding P-7');

    // The comparison that makes the finding concrete: the UPDATER, which is a far smaller
    // exposure, refuses anything but https by name.
    assert.match(repoFile('src/js/platform/updater.js'), /u\.protocol !== 'https:'/);
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

  test('FAILED — the complete set of paths the SOURCE can build is eight, all under /api/v1/', () => {
    // The session above exercises the steady state. Pairing and opt-in add five more paths that
    // no fleet run reaches (the harness drives pairing over `mitm.js`, not over HTTP), so they
    // are read out of the source instead — which is the stronger statement anyway: this is every
    // path the product is CAPABLE of building, not every path one run happened to build.
    const files = ['src/js/sync/personal.js', 'src/js/family/mount.js', 'src/js/family/engine.js',
      'src/js/family/pairflow.js', 'src/js/crypto/pairing.js', 'src/js/crypto/backup.js'];
    const paths = new Set();
    for (const f of files) {
      for (const m of repoFile(f).matchAll(/['"`](\/api\/v1\/[^'"`]*)['"`]/g)) {
        paths.add(m[1].replace(/\$\{[^}]*\}/g, ':id'));
      }
    }
    assert.deepEqual([...paths].sort(), [
      '/api/v1/devices/adopt',
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
