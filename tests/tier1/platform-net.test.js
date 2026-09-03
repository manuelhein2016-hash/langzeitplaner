// TIER 1 · LZP-501 — `src/js/platform/net.js`, the only transport.  ADR 003 §1, §2, §4, §6.1, §7.
//
// `network-scope.test.js` proves there is exactly ONE call site. This file proves the one call
// site is correct: that what it signs is what the relay verifies, that it can reach exactly one
// origin and one path shape, that a timeout is a failure rather than a hang, and that a redirect
// cannot move a signed request off that origin.
//
// NO SOCKET IS OPENED ANYWHERE HERE. `fetchImpl` is injected — the same shape ADR 003 §8's
// `transport` port has, for the same reason (ADR 005 §5 rule 5: no test reads the network). The
// keys are REAL P-256 keys and the signature check is the RELAY'S OWN, through
// `tests/helpers/relay-auth.js`; nothing about the crypto is faked.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFetchTransport, createBridgeTransport, chooseTransport,
  canonicalQuery, signedString, signRequest, normalizeOrigin, assertReachable, buildRequest,
  NetError, HDR, PROTOCOL, SIGNED_PREFIX, NONCE_BYTES, DEFAULT_TIMEOUT_MS, MAX_REQUEST_BYTES,
} from '../../src/js/platform/net.js';
import { deviceShortOf } from '../../src/js/core/ids.js';
import { b64u } from '../../src/js/core/b64.js';
import { verifyAsRelay, serverCanonicalQuery, serverSignedString } from '../helpers/relay-auth.js';

const S = globalThis.crypto.subtle;
const ORIGIN = 'https://relay.example';

/** A real device signing key, and the `sign` port the family opt-in moment binds. */
async function device() {
  const pair = await S.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const sigPubRaw = new Uint8Array(await S.exportKey('raw', pair.publicKey));
  return {
    sigPubRaw,
    deviceShort: deviceShortOf(sigPubRaw),
    // The ONE line every caller writes; in the product it is
    // `(b) => signBytes(identity.devSig.privateKey, b)` from src/js/crypto/identity.js.
    sign: async (bytes) => new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes)),
  };
}

/** A fetch double that records what it was asked to do and answers 200 with `{ok:true}`. */
function recorder(answer = { status: 200, body: '{"ok":true}', headers: { 'x-lzp-protocol': '1' } }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (typeof answer === 'function') return answer(url, init);
    return {
      status: answer.status,
      headers: new Map(Object.entries(answer.headers || {})),
      text: async () => answer.body,
    };
  };
  return { calls, impl };
}

async function transport(extra = {}) {
  const d = await device();
  const rec = recorder(extra.answer);
  const t = createFetchTransport({
    origin: ORIGIN,
    deviceShort: d.deviceShort,
    sign: d.sign,
    clientVersion: '2.0.3',
    now: () => 1787836800123,
    random: (n) => new Uint8Array(n).fill(7),
    subtle: S,
    fetchImpl: rec.impl,
    ...extra.deps,
  });
  return { d, rec, t };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The signed bytes — the relay's own verifier is the oracle
// ═════════════════════════════════════════════════════════════════════════════

describe('ADR 003 §2 — what is signed is what the relay verifies', () => {
  test("a POST's Authorization header verifies under server/core/auth.js, unchanged", async () => {
    const { d, rec, t } = await transport();
    await t.request('POST', '/api/v1/ops', {}, { space: 'fsp_9xQ2mR7bL0aZ4tV8wK', ops: [] });

    const sent = rec.calls[0];
    const verdict = await verifyAsRelay(
      { method: 'POST', path: '/api/v1/ops', query: {}, rawBody: sent.init.body, headers: sent.init.headers },
      d.sigPubRaw
    );
    assert.equal(verdict.ok, true, verdict.reason);
    assert.equal(verdict.device, d.deviceShort, 'the principal is the KEY-DERIVED short (ADR 002 §5.2.0)');
  });

  test('a GET with a query verifies too — the sort domain and the encoding agree with the relay', async () => {
    // The half ADR 003 §2 leaves unstated and `server/core/auth.js` pins as E2-202-3. Two files
    // agreeing with the same prose is not the same as two files agreeing with each other, so the
    // query below is deliberately one where sorting-before-encoding and sorting-after disagree.
    const { d, rec, t } = await transport();
    const query = { since: '10201', space: 'fsp_9xQ2mR7bL0aZ4tV8wK', limit: 500, 'a b': 'c!d' };
    await t.request('GET', '/api/v1/ops', query);

    const sent = rec.calls[0];
    assert.equal(sent.init.body, undefined, 'a GET carries no body — §2 hashes ZERO bytes');
    const verdict = await verifyAsRelay(
      { method: 'GET', path: '/api/v1/ops', query, rawBody: new Uint8Array(0), headers: sent.init.headers },
      d.sigPubRaw
    );
    assert.equal(verdict.ok, true, verdict.reason);
    assert.equal(canonicalQuery(query), serverCanonicalQuery(query), 'the two canonicalisers disagree');
    assert.ok(sent.url.endsWith('?' + canonicalQuery(query)), 'the URL must carry the string that was SIGNED');
  });

  test('the signed string is never empty and is assembled in ADR 003 §2 order', () => {
    const p = {
      method: 'post', path: '/api/v1/ops', sortedQuery: '',
      bodyHashB64u: 'aGFzaA', ts: '1787836800123', nonce: 'bm9uY2U',
    };
    const mine = signedString(p);
    assert.ok(mine.startsWith(SIGNED_PREFIX), 'rule 2: it always begins with "lzp/v2\\n"');
    assert.equal(mine, serverSignedString(p), 'the client and the relay build different strings');
    assert.equal(mine, 'lzp/v2\nPOST\n/api/v1/ops?\naGFzaA\n1787836800123\nbm9uY2U',
      'the "?" is unconditional — a separator, not a query marker');
  });

  test('the nonce is 16 bytes of client randomness and the ts is decimal unix millis', async () => {
    const { rec, t } = await transport();
    await t.request('GET', '/api/v1/meta');
    const auth = rec.calls[0].init.headers[HDR.auth];
    const m = auth.match(/^LZP1 device=([^,]+), ts=(\d+), nonce=([^,]+), sig=(.+)$/);
    assert.ok(m, `the header is not the LZP1 form: ${auth}`);
    assert.equal(m[2], '1787836800123');
    assert.equal(m[3], b64u(new Uint8Array(NONCE_BYTES).fill(7)));
    assert.equal(m[3].length, 22, '16 bytes -> 22 base64url characters');
  });

  test('a sign port that returns the wrong type is a config error, not a bad request on the wire', async () => {
    const d = await device();
    await assert.rejects(
      () => signRequest({
        method: 'GET', path: '/api/v1/meta', sortedQuery: '', rawBody: new Uint8Array(0),
        deviceShort: d.deviceShort, ts: 1, nonce: new Uint8Array(16), subtle: S,
        sign: async () => 'not bytes',
      }),
      (e) => e instanceof NetError && e.kind === 'config'
    );
    await assert.rejects(
      () => signRequest({
        method: 'GET', path: '/api/v1/meta', sortedQuery: '', rawBody: new Uint8Array(0),
        deviceShort: 'not-a-short', ts: 1, nonce: new Uint8Array(16), subtle: S, sign: d.sign,
      }),
      (e) => e instanceof NetError && e.kind === 'config'
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Exactly one endpoint, and nothing else (story 21.5)
// ═════════════════════════════════════════════════════════════════════════════

describe('the allowlisted origin is the only place a request can go', () => {
  test('an origin must be scheme://host[:port] and nothing more', () => {
    assert.equal(normalizeOrigin('https://relay.example'), 'https://relay.example');
    assert.equal(normalizeOrigin('https://relay.example/'), 'https://relay.example');
    assert.equal(normalizeOrigin('app://localhost'), 'app://localhost');
    assert.equal(normalizeOrigin('http://127.0.0.1:8788'), 'http://127.0.0.1:8788');
    for (const bad of [
      '', 'relay.example', 'https://relay.example/api', 'https://relay.example?x=1',
      'https://u:p@relay.example', 'ftp://relay.example', 'file:///etc/passwd', null, 42,
    ]) {
      assert.throws(() => normalizeOrigin(bad), (e) => e instanceof NetError && e.kind === 'config',
        `normalizeOrigin accepted ${JSON.stringify(bad)}`);
    }
  });

  test('a path that could escape the origin is refused before anything is built', () => {
    for (const bad of [
      'https://evil.example/api/v1/ops',   // an absolute URL as a "path"
      '//evil.example/api/v1/ops',         // protocol-relative
      '/api/v1/../../evil',
      '/api/v1/ops?space=x',               // a query smuggled into the path
      '/api/v1/ops#frag',
      '/api/v2/ops',
      '/',
      '',
    ]) {
      assert.throws(() => assertReachable(ORIGIN, bad, ''),
        (e) => e instanceof NetError && e.kind === 'blocked', `assertReachable accepted ${JSON.stringify(bad)}`);
    }
    assert.equal(assertReachable(ORIGIN, '/api/v1/ops', 'since=1'), 'https://relay.example/api/v1/ops?since=1');
  });

  test('every request the transport makes lands on the one origin', async () => {
    const { rec, t } = await transport();
    await t.request('GET', '/api/v1/meta');
    await t.request('GET', '/api/v1/spaces/fsp_9xQ2mR7bL0aZ4tV8wK/keys');
    await t.request('POST', '/api/v1/ops', {}, { space: 'x', ops: [] });
    assert.equal(rec.calls.length, 3);
    for (const c of rec.calls) assert.ok(c.url.startsWith(ORIGIN + '/api/v1/'), c.url);
    await assert.rejects(() => t.request('GET', 'https://evil.example/steal'),
      (e) => e instanceof NetError && e.kind === 'blocked');
    assert.equal(rec.calls.length, 3, 'a refused destination must not reach fetch at all');
  });

  test('a redirect cannot move a signed request to a host of the relay\'s choosing', async () => {
    // `redirect: 'error'` is the assertion. A 302 would otherwise replay a signed request at a
    // destination chosen by whoever answered — after `assertReachable` had already approved the
    // one it was built for.
    const { rec, t } = await transport();
    await t.request('GET', '/api/v1/meta');
    assert.equal(rec.calls[0].init.redirect, 'error');
    assert.equal(rec.calls[0].init.credentials, 'omit', 'there are no cookies and none may be built');
    assert.equal(rec.calls[0].init.cache, 'no-store');
    assert.equal(rec.calls[0].init.referrerPolicy, 'no-referrer');
  });

  test('only GET and POST exist, and a GET may not carry a body', async () => {
    const { t } = await transport();
    for (const m of ['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE']) {
      await assert.rejects(() => t.request(m, '/api/v1/ops'), (e) => e.kind === 'blocked', m);
    }
    await assert.rejects(() => t.request('GET', '/api/v1/ops', {}, { sneaky: true }),
      (e) => e.kind === 'blocked');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Headers, caps, timeouts (ADR 003 §4, §6.1, §8.2)
// ═════════════════════════════════════════════════════════════════════════════

describe('the protocol version header, the caps and the clock', () => {
  test('every request carries X-LZP-Protocol and X-LZP-Client, and no cookie', async () => {
    const { rec, t } = await transport();
    await t.request('POST', '/api/v1/ops', {}, { space: 'x', ops: [] });
    const h = rec.calls[0].init.headers;
    assert.equal(h[HDR.protocol], String(PROTOCOL));
    assert.equal(h[HDR.client], '2.0.3');
    assert.equal(h['Content-Type'], 'application/json');
    assert.equal(Object.keys(h).some((k) => /cookie|authorization-bearer|x-api-key/i.test(k)), false);
    assert.deepEqual(Object.keys(h).sort(), ['Authorization', 'Content-Type', 'X-LZP-Client', 'X-LZP-Protocol']);
  });

  test('a caller may not overwrite a header the transport owns', async () => {
    const { t } = await transport();
    await assert.rejects(() => t.request('GET', '/api/v1/meta', {}, null, { 'x-lzp-protocol': '99' }),
      (e) => e instanceof NetError && e.kind === 'config');
    await assert.rejects(() => t.request('GET', '/api/v1/meta', {}, null, { Authorization: 'LZP1 nope' }),
      (e) => e instanceof NetError && e.kind === 'config');
  });

  test('the 4 MB request cap is refused here rather than by the relay', async () => {
    const { rec, t } = await transport();
    const huge = { pad: 'x'.repeat(MAX_REQUEST_BYTES) };
    await assert.rejects(() => t.request('POST', '/api/v1/ops', {}, huge),
      (e) => e instanceof NetError && e.kind === 'too_large');
    assert.equal(rec.calls.length, 0, 'nothing was sent');
  });

  test('a request that never answers becomes a timeout, not a hang', async () => {
    const d = await device();
    let fired = null;
    const t = createFetchTransport({
      origin: ORIGIN, deviceShort: d.deviceShort, sign: d.sign, clientVersion: '2.0.3',
      now: () => 1, random: (n) => new Uint8Array(n), subtle: S, timeoutMs: 50,
      schedule: (ms, fn) => { fired = { ms, fn }; return 'H'; },
      unschedule: () => {},
      fetchImpl: (url, init) => new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    });
    const p = t.request('GET', '/api/v1/meta');
    // Signing is async (SHA-256 + ECDSA), so the timer is armed a few microtasks in.
    while (fired === null) await new Promise((r) => setTimeout(r, 0));
    assert.equal(fired.ms, 50, 'the timeout was not armed');
    fired.fn();
    await assert.rejects(() => p, (e) => e instanceof NetError && e.kind === 'timeout');
    assert.equal(DEFAULT_TIMEOUT_MS, 15000, 'the shipped default');
  });

  test('a transport failure is reported as one, and a non-JSON body as another', async () => {
    const d = await device();
    const boom = createFetchTransport({
      origin: ORIGIN, deviceShort: d.deviceShort, sign: d.sign, clientVersion: '2.0.3',
      subtle: S, fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    });
    await assert.rejects(() => boom.request('GET', '/api/v1/meta'),
      (e) => e instanceof NetError && e.kind === 'transport');

    const { t } = await transport({ answer: { status: 200, body: '<html>proxy error</html>', headers: {} } });
    await assert.rejects(() => t.request('GET', '/api/v1/meta'),
      (e) => e instanceof NetError && e.kind === 'bad_response');
  });

  test('a response comes back as {status, headers, json} with header names lower-cased', async () => {
    const { t } = await transport({
      answer: { status: 426, body: '{"error":"protocol_too_old","minProto":2}', headers: { 'X-LZP-Min-Protocol': '2' } },
    });
    const res = await t.request('GET', '/api/v1/meta');
    assert.equal(res.status, 426);
    assert.equal(res.headers['x-lzp-min-protocol'], '2', 'ADR 003 §4 reads this on every response');
    assert.deepEqual(res.json, { error: 'protocol_too_old', minProto: 2 });

    const empty = await transport({ answer: { status: 204, body: '', headers: {} } });
    assert.equal((await empty.t.request('GET', '/api/v1/meta')).json, null, 'an empty body is null, not a throw');
  });

  test('a missing dependency is refused at construction, not at the first request', async () => {
    const d = await device();
    const base = { origin: ORIGIN, deviceShort: d.deviceShort, sign: d.sign, clientVersion: '2.0.3' };
    for (const k of ['origin', 'deviceShort', 'sign', 'clientVersion']) {
      const bad = { ...base };
      delete bad[k];
      assert.throws(() => createFetchTransport(bad), (e) => e instanceof NetError && e.kind === 'config', k);
    }
    assert.ok(createFetchTransport(base));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. The bridge transport — the shipping path, which is why the CSP does not move
// ═════════════════════════════════════════════════════════════════════════════

describe('createBridgeTransport — the page signs, the shell transports', () => {
  test('the shell is handed the exact URL, method, headers and body, and nothing else', async () => {
    const d = await device();
    const seen = [];
    const t = createBridgeTransport({
      origin: ORIGIN, deviceShort: d.deviceShort, sign: d.sign, clientVersion: '2.0.3',
      now: () => 1787836800123, random: (n) => new Uint8Array(n).fill(3), subtle: S,
      invoke: async (cmd, args) => {
        seen.push({ cmd, args });
        // `url` is REQUIRED as of LZP-1002 — both shells send it (FINDING P-5's shell half), so
        // the transport refuses a reply that omits it. A shell double must answer like a shell.
        return { status: 200, headers: { 'X-LZP-Protocol': '1' }, body: '{"accepted":[]}',
                 url: ORIGIN + '/api/v1/ops' };
      },
    });
    const res = await t.request('POST', '/api/v1/ops', {}, { space: 'fsp_9xQ2mR7bL0aZ4tV8wK', ops: [] });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].cmd, 'sync_request', 'the one command the shell must implement');
    assert.deepEqual(Object.keys(seen[0].args).sort(), ['body', 'headers', 'method', 'url']);
    assert.equal(seen[0].args.url, ORIGIN + '/api/v1/ops');
    assert.equal(seen[0].args.body, '{"space":"fsp_9xQ2mR7bL0aZ4tV8wK","ops":[]}');
    assert.deepEqual(res, { status: 200, headers: { 'x-lzp-protocol': '1' }, json: { accepted: [] } });

    // and it is the SAME signature the fetch transport would have produced — the page signs
    // either way, which is exactly what makes the transport choice a free one.
    const verdict = await verifyAsRelay(
      {
        method: 'POST', path: '/api/v1/ops', query: {},
        rawBody: new TextEncoder().encode(seen[0].args.body), headers: seen[0].args.headers,
      },
      d.sigPubRaw
    );
    assert.equal(verdict.ok, true, verdict.reason);
  });

  test("the shell's four error words become typed NetErrors, and anything else is 'transport'", async () => {
    const d = await device();
    const mk = (reply) => createBridgeTransport({
      origin: ORIGIN, deviceShort: d.deviceShort, sign: d.sign, clientVersion: '2.0.3', subtle: S,
      invoke: async () => reply,
    });
    for (const kind of ['offline', 'timeout', 'blocked', 'transport']) {
      await assert.rejects(() => mk({ error: kind }).request('GET', '/api/v1/meta'),
        (e) => e instanceof NetError && e.kind === kind, kind);
    }
    await assert.rejects(() => mk({ error: 'who knows' }).request('GET', '/api/v1/meta'),
      (e) => e.kind === 'transport');
    await assert.rejects(() => mk(null).request('GET', '/api/v1/meta'),
      (e) => e.kind === 'bad_response');
    await assert.rejects(() => mk({ headers: {}, body: '' }).request('GET', '/api/v1/meta'),
      (e) => e.kind === 'bad_response', 'a reply with no status is not an answer');
    // LZP-1002 · P-5's shell half, now that both shells send the field: a reply that names no
    // URL at all is `blocked`, not accepted. Before this, an omission silently disabled the
    // origin check — a shell that followed a redirect and stayed quiet was indistinguishable
    // from an honest one.
    await assert.rejects(
      () => mk({ status: 200, headers: {}, body: '{}' }).request('GET', '/api/v1/meta'),
      (e) => e instanceof NetError && e.kind === 'blocked' && /without naming the URL/.test(e.message),
      'a reply with no `url` was accepted — P-5 has been reverted');
    // …and the honest shape still goes through.
    const ok = await mk({ status: 200, headers: {}, body: '{}', url: ORIGIN + '/api/v1/meta' })
      .request('GET', '/api/v1/meta');
    assert.deepEqual(ok, { status: 200, headers: {}, json: {} });
  });

  test('chooseTransport says WHICH — a shipped shell reporting "fetch" is a gate-3 bug', async () => {
    const d = await device();
    const base = { origin: ORIGIN, deviceShort: d.deviceShort, sign: d.sign, clientVersion: '2.0.3', subtle: S };
    assert.equal(chooseTransport({ ...base, invoke: async () => ({ status: 200, body: '', url: ORIGIN }) }).kind, 'bridge');
    assert.equal(chooseTransport({ ...base, fetchImpl: async () => ({}) }).kind, 'fetch');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. buildRequest is the one place a request is decided
// ═════════════════════════════════════════════════════════════════════════════

test('both transports build their request through the same function', async () => {
  // The property that makes §4's "the same signature either way" true by construction rather than
  // by two code paths that happen to agree today.
  const d = await device();
  const cfg = {
    origin: ORIGIN, deviceShort: d.deviceShort, sign: d.sign, clientVersion: '2.0.3',
    now: () => 5, random: (n) => new Uint8Array(n).fill(1), subtle: S,
  };
  const a = await buildRequest(cfg, 'post', '/api/v1/ops', { b: 2, a: 1 }, { x: 1 }, {});
  assert.equal(a.method, 'POST', 'the method is upper-cased before it is signed');
  assert.equal(a.url, ORIGIN + '/api/v1/ops?a=1&b=2');
  assert.equal(a.sortedQuery, 'a=1&b=2');
  assert.deepEqual([...a.rawBody], [...new TextEncoder().encode('{"x":1}')]);
  assert.ok(a.headers[HDR.auth].startsWith('LZP1 device=' + d.deviceShort));
});
