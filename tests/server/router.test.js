// tests/server/router.test.js — the shared route table and the error shape.  LZP-201.
//
// `server/core/router.js` is the one file all three entry points go through: the Vercel
// function, `server/dev-server.mjs`, and `tests/helpers/loopback.js` (which the fleet suite
// binds the client's Transport port to, so the whole protocol runs with no sockets). A defect
// here is a defect in production and in CI simultaneously, which is exactly the property ADR 003
// §9 was after — and the reason it is worth testing the table on its own, before a single
// handler exists.
//
// `server/core/errors.js` is tested in the same file because the two are one decision: which
// (status, code) pairs exist, and what may ride on the body next to them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute, createRouter, ROUTES, ROUTE_NAMES, SPACE_SCOPED, API_PREFIX } from '../../server/core/router.js';
import { HttpError, ERROR_CODES, statusFor, fail, toResponse, FORBIDDEN_BODY_FIELDS } from '../../server/core/errors.js';

const ctx = { store: null };
const req = (method, path, extra) => ({ method, path, query: {}, headers: {}, body: null, rawBody: new Uint8Array(0), ...extra });

// ── the table ────────────────────────────────────────────────────────────────

test('the route table is exactly ADR 003 §3, with unique names and no duplicate (method, path)', () => {
  // 23 from ADR 003 §3, plus ONE that is not a sync endpoint at all: `POST /feedback`
  // (LZP-1009). It is counted separately in the message rather than folded into the number,
  // because "ADR 003 §3 lists 23" is still the true sentence about the ADR and this row is the
  // place a reader learns that the shipped surface is 23 + 1.
  assert.equal(ROUTES.length, 24, 'ADR 003 §3 lists 23 endpoints, plus LZP-1009 POST /feedback');
  assert.equal(ROUTES.filter((r) => r.pattern.startsWith('/feedback')).length, 1,
    'the feedback surface is exactly one route; a second one would be the read-back it must not have');
  assert.equal(new Set(ROUTE_NAMES).size, ROUTE_NAMES.length, 'duplicate handler names');
  const pairs = ROUTES.map((r) => `${r.method} ${r.pattern}`);
  assert.equal(new Set(pairs).size, pairs.length, 'two routes claim the same method and path');
  for (const r of ROUTES) {
    assert.match(r.pattern, /^\//);
    assert.ok(['GET', 'POST'].includes(r.method), `${r.name} uses ${r.method}; the API is GET and POST only`);
  }
});

test('every space-scoped route names where its space id comes from', () => {
  // Auth step 7 (ADR 003 §2) has to run on every route that touches one family's data, and the
  // id arrives in the path, the query or the body depending on the route. Enumerating the fact
  // here means a new space-scoped route cannot be added without a reviewer seeing this list.
  for (const name of Object.keys(SPACE_SCOPED)) {
    assert.ok(ROUTE_NAMES.includes(name), `${name} is space-scoped but is not a route`);
    assert.match(SPACE_SCOPED[name], /^(param|query|body):\w+$/);
  }
  const unscoped = ROUTE_NAMES.filter((n) => !(n in SPACE_SCOPED));
  assert.deepEqual(unscoped.sort(), [
    'adoptDevice', 'createSpace',
    // LZP-1009. Unscoped because it names NO space — not because its space check was forgotten,
    // which is the reading this list exists to make impossible. `handlers/feedback.js` is handed
    // no space id and has no way to obtain one, and that is what makes "a report can never reach
    // the family's board" a structural fact rather than a careful omission.
    'feedback',
    'meta', 'pairAnswer', 'pairDeliver', 'pairGet', 'pairOffer',
    'redeemInvite', 'registerDevice', 'revokeDevice',
  ], 'a route left out of SPACE_SCOPED skips the membership check — this list is the review surface');
});

// ── matching ─────────────────────────────────────────────────────────────────

test('matchRoute resolves static and parameterised paths', () => {
  assert.equal(matchRoute('GET', '/api/v1/meta').route.name, 'meta');
  assert.equal(matchRoute('POST', '/api/v1/ops').route.name, 'pushOps');
  assert.equal(matchRoute('GET', '/api/v1/ops').route.name, 'pullOps');
  const m = matchRoute('POST', '/api/v1/spaces/fsp_9xQ2mR7bL0aZ4tV8wK/epoch');
  assert.equal(m.route.name, 'rotateEpoch');
  assert.deepEqual(m.params, { id: 'fsp_9xQ2mR7bL0aZ4tV8wK' });
  assert.equal(matchRoute('GET', '/api/v1/pair/AbCdEf').params.rid, 'AbCdEf');
});

test('matchRoute is case-insensitive on the method and never on the path', () => {
  assert.equal(matchRoute('get', '/api/v1/meta').route.name, 'meta');
  assert.equal(matchRoute('GET', '/api/v1/META'), null);
});

test('a query string does not change which route matches', () => {
  assert.equal(matchRoute('GET', '/api/v1/ops?space=fsp_1&since=10&limit=500').route.name, 'pullOps');
});

test('anything outside /api/v1 does not match at all', () => {
  for (const p of ['/', '/meta', '/api/meta', '/api/v2/meta', '/api/v1meta', '/API/v1/meta']) {
    assert.equal(matchRoute('GET', p), null, `${p} must not match`);
  }
  assert.equal(API_PREFIX, '/api/v1');
});

test('a path that exists under another method is 405, not 404', () => {
  // The distinction matters to the client: a 404 says "this server does not speak the protocol
  // you think it does" and stops the sync loop; a 405 is a bug in the caller.
  assert.throws(() => matchRoute('POST', '/api/v1/meta'), (err) => err.status === 405 && err.code === 'method_not_allowed');
  assert.throws(() => matchRoute('GET', '/api/v1/spaces'), (err) => err.status === 405);
});

test('a traversal or a smuggled separator never becomes a route parameter', () => {
  // `rid` and `id` become map keys in the file adapter and WHERE values in Postgres. A segment
  // that decodes to something containing a separator is refused rather than re-split.
  for (const p of [
    '/api/v1/pair/..',
    '/api/v1/pair/.',
    '/api/v1/pair/%2e%2e',
    '/api/v1/pair/a%2Fb',
    '/api/v1/pair/a%5Cb',
    '/api/v1/spaces/..%2F..%2Fetc/keys',
    '/api/v1/pair/a%20b',
    '/api/v1/pair/%ZZ',
  ]) {
    assert.equal(matchRoute('GET', p), null, `${p} must be refused outright, never decoded into a parameter`);
  }
  // and the honest counter-example: a legitimate rid still matches
  assert.equal(matchRoute('GET', '/api/v1/pair/kQ7bR0aZ4tV9wLpNcg').params.rid, 'kQ7bR0aZ4tV9wLpNcg');
});

test('a trailing slash and a doubled slash resolve to the same route', () => {
  assert.equal(matchRoute('GET', '/api/v1/meta/').route.name, 'meta');
  assert.equal(matchRoute('GET', '/api/v1//meta').route.name, 'meta');
});

// ── the router ───────────────────────────────────────────────────────────────

test('createRouter dispatches to the registered handler with the params attached', async () => {
  let seen = null;
  const route = createRouter({
    rotateEpoch: async (r) => { seen = r; return { status: 200, body: { ok: true } }; },
  });
  const res = await route(ctx, req('POST', '/api/v1/spaces/fsp_1/epoch', { body: { epoch: 2 } }));
  assert.deepEqual(res, { status: 200, body: { ok: true } });
  assert.deepEqual(seen.params, { id: 'fsp_1' });
  assert.equal(seen.routeName, 'rotateEpoch');
  assert.deepEqual(seen.body, { epoch: 2 }, 'the request is passed through, not rebuilt');
});

test('an unwired route answers 501 with the handler it is waiting for, not 404', async () => {
  const route = createRouter({});
  await assert.rejects(() => route(ctx, req('GET', '/api/v1/meta')), (err) => {
    assert.equal(err.status, 501);
    assert.equal(err.code, 'not_implemented');
    assert.equal(err.extra.route, 'meta');
    return true;
  });
});

test('an unknown path is 404 and an unknown handler name is a startup failure', async () => {
  const route = createRouter({});
  await assert.rejects(() => route(ctx, req('GET', '/api/v1/nope')), (err) => err.status === 404);
  assert.throws(() => createRouter({ notARoute: async () => {} }), (err) => err.status === 500 && err.extra.unknownHandler === 'notARoute');
});

// ── the error shape ──────────────────────────────────────────────────────────

test('every error code has one status, and the auth ladder maps to the ADR 003 §2 order', () => {
  const ladder = [
    ['bad_auth', 401], ['stale_request', 401], ['replay', 401],
    ['device_revoked', 403], ['bad_signature', 401], ['not_a_member', 403],
  ];
  for (const [code, status] of ladder) assert.equal(ERROR_CODES[code], status, `${code} must be ${status}`);
  assert.equal(ERROR_CODES.protocol_too_old, 426, 'the N-1 rule answers 426 Upgrade Required');
  assert.equal(ERROR_CODES.forked_op_id, 409);
  assert.equal(ERROR_CODES.epoch_taken, 409);
  assert.equal(ERROR_CODES.incomplete_coverage, 409, 'a rotation that omits a member is refused, not accepted');
  assert.equal(ERROR_CODES.rate_limited, 429);
  assert.throws(() => statusFor('made_up'), (err) => err.status === 500);
});

test('toResponse emits a code and the extras a client branches on', () => {
  assert.deepEqual(toResponse(fail('not_a_member')), { status: 403, headers: {}, body: { error: 'not_a_member' } });
  const upgrade = toResponse(new HttpError(426, 'protocol_too_old', { minProto: 2, minClientVersion: '2.4.0' }));
  assert.deepEqual(upgrade.body, { error: 'protocol_too_old', minProto: 2, minClientVersion: '2.4.0' });
  const limited = toResponse(new HttpError(429, 'rate_limited', { retryAfter: 30 }));
  assert.equal(limited.headers['Retry-After'], '30', '429 must carry Retry-After (ADR 003 §6.1)');
});

test('an unrecognised throw becomes 500 internal with NO detail on the wire', () => {
  // A stack trace or a message built from request data is exactly how an opId, a space id or a
  // fragment of ciphertext ends up in a body the relay operator can read (21.3). The operator
  // gets the detail through ctx.log(); the client gets a code.
  const res = toResponse(new TypeError('cannot read envelope of undefined at fsp_9xQ2'));
  assert.deepEqual(res, { status: 500, headers: {}, body: { error: 'internal' } });
  assert.equal(JSON.stringify(res).includes('fsp_9xQ2'), false);
  assert.deepEqual(toResponse(null).body, { error: 'internal' });
  assert.deepEqual(toResponse('a string').body, { error: 'internal' });
});

test('ciphertext can never ride on an error body, even if a handler puts it there', () => {
  const leaky = new HttpError(409, 'forked_op_id', {
    oid: 'aQ7bR0aZ4tV9wLpNcg',
    envelope: 'BASE64CIPHERTEXT', ct: 'x', iv: 'y', sig: 'z', wrapped: 'w',
    boxA: 'b', boxB: 'b', delivery: 'd', wrappedKeys: 'k', verifier: 'v', attestation: 'a',
    stack: 'at pushOps (...)', message: 'internal detail',
  });
  const res = toResponse(leaky);
  assert.deepEqual(res.body, { error: 'forked_op_id', oid: 'aQ7bR0aZ4tV9wLpNcg' },
    'the opId is coordination data the client needs to re-mint; everything else is redacted');
  for (const f of FORBIDDEN_BODY_FIELDS) assert.equal(f in res.body, false, `${f} reached the wire`);
});
