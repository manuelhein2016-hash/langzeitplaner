// tests/server/auth.test.js — ADR 003 §2, attacked rather than demonstrated.  LZP-202.
//
// WHY THIS FILE IS ADVERSARIAL AND NOT A HAPPY PATH.
// `POST /api/v1/ops` is a PUBLIC endpoint on the open internet, reachable by anyone who learns
// the hostname. There is no cookie, no session, no bearer token and no account system to hide
// behind: the only thing standing between a stranger and a family's log is that this file's
// seven steps are each individually correct. So almost every test below is an attack, and the
// happy path appears mainly to prove the attacks are attacking something that otherwise works.
//
// The three properties worth naming, because the rest of the file is in service of them:
//
//   1. THE SIGNED BYTES ARE EXACTLY ADR 003 §2's. A known-answer test pins the whole string,
//      character for character, and then every single component is varied in isolation and the
//      signature must be refused. A protocol whose signed bytes are "roughly the request" is a
//      protocol with a signature-stripping attack in it somewhere.
//   2. THE PRINCIPAL IS SELF-CERTIFYING. `deviceShort` is recomputed from the stored public key
//      on every request and cross-checked against `src/js/core/ids.js`'s own implementation, so
//      the HTTP principal and the HLC tiebreak are provably ONE function and not two.
//   3. EVERY FAILURE FAILS CLOSED, IN ORDER, AND WITHOUT AN ORACLE. Unknown and revoked answer
//      the same code; removed and foreign answer the same code. A caller learns whether its own
//      request was accepted and nothing else about who exists.
//
// Everything runs against BOTH the memory and the file adapter, because auth's state — the nonce
// window above all — is store state, and a replay window that works only in Maps is not a replay
// window.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';

import {
  authenticate, assertMember, parseAuthorization, canonicalQuery, signedString, signedBytes,
  readSignedBody, deviceShortOfRaw, verifySignature, headerOf, spaceIdOf,
  b64u, ub64, crock32,
  AUTH_SCHEME, AUTH_PARAMS, SIGNED_PREFIX, SIG_BYTES, NONCE_BYTES, DEVICE_SHORT_RE,
  AUTH_INTERFACE_GAPS,
  verifyAdminProof, adminProofString, ADMIN_PROOF_PREFIX, ADMIN_ACTS,
} from '../../server/core/auth.js';
import { fixtures } from '../../server/core/store-interface.js';
import { memoryStore } from '../../server/adapters/memory.js';
import { fileStore } from '../../server/adapters/file.js';
import { HttpError } from '../../server/core/errors.js';
import { LIMITS_SHAPE } from '../../docs/v2/contracts/server.contract.js';
// The client's own definition of deviceShort, imported ONLY so the two can be compared. A test
// may cross the ADR 005 §2 boundary; the server source may not, and does not.
import { deviceShortOf as clientDeviceShortOf } from '../../src/js/core/ids.js';

const SUBTLE = webcrypto.subtle;
const TE = new TextEncoder();

const SPACE = 'fsp_AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_SPACE = 'fsp_BBBBBBBBBBBBBBBBBBBBBB';
const T0 = 1787836800000;

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-auth-'));
  tempDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function fakeClock(start) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (ms) => { t = ms; } };
}

const ADAPTERS = [
  { name: 'memory', make: (clock) => memoryStore({ now: clock.now }) },
  { name: 'file', make: (clock) => fileStore(tempDir(), { now: clock.now }) },
];

function makeCtx(store, clock, over) {
  const ctx = {
    store,
    now: () => clock.now(),
    random: (n) => new Uint8Array(n),
    log: () => {},
    limits: LIMITS_SHAPE,
    ...over,
  };
  if (!ctx.auth) ctx.auth = (req) => authenticate(req, ctx);
  if (!ctx.assertMember) ctx.assertMember = (m, s) => assertMember(m, s, ctx);
  return ctx;
}

/** A real P-256 signing pair plus everything the store needs to know about it. */
async function mintDevice(opts) {
  const pair = await SUBTLE.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const sigPubRaw = new Uint8Array(await SUBTLE.exportKey('raw', pair.publicKey));
  const kex = await SUBTLE.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const kexPubRaw = new Uint8Array(await SUBTLE.exportKey('raw', kex.publicKey));
  const short = await deviceShortOfRaw(sigPubRaw, {});
  return { pair, sigPubRaw, kexPubRaw, deviceShort: short, ...opts };
}

/**
 * A space with one member and one real device. Returns everything a test needs to forge with.
 */
async function seed(store, opts) {
  const o = opts || {};
  const spaceId = o.spaceId || SPACE;
  const memberId = o.memberId || 'mem_AAAAAAAAAAAAAAAAAAAAAA';
  await store.createSpace(fixtures.space({ id: spaceId, createdAt: new Date(T0) }));
  await store.addMember(fixtures.member({
    id: memberId, spaceId, colorRef: o.colorRef || 'gruen', joinedAt: new Date(T0),
  }));
  const dev = await mintDevice();
  await store.addDevice(fixtures.device({
    id: o.deviceId || 'dev_AAAAAAAAAAAAAAAAAAAAAA',
    memberId,
    deviceShort: o.forceShort || dev.deviceShort,
    sigPubRaw: dev.sigPubRaw,
    kexPubRaw: dev.kexPubRaw,
    addedAt: new Date(T0),
    revokedAt: o.revokedAt || null,
  }));
  return { spaceId, memberId, dev };
}

let nonceCounter = 0;
function freshNonce() {
  const b = new Uint8Array(NONCE_BYTES);
  const n = ++nonceCounter;
  b[0] = n & 255; b[1] = (n >>> 8) & 255; b[2] = (n >>> 16) & 255; b[3] = 42;
  return b64u(b);
}

/**
 * Build a request signed exactly as ADR 003 §2 specifies. Every knob a test might want to
 * corrupt is a parameter, so an attack is one field different from the honest call.
 */
async function signReq(o) {
  const method = o.method || 'GET';
  const reqPath = o.path || '/api/v1/ops';
  const query = o.query || {};
  const hasBody = o.bodyObj !== undefined && o.bodyObj !== null;
  const rawBody = hasBody ? TE.encode(JSON.stringify(o.bodyObj)) : new Uint8Array(0);
  const hash = new Uint8Array(await SUBTLE.digest('SHA-256', rawBody));
  const ts = String(o.ts === undefined ? T0 : o.ts);
  const nonce = o.nonce === undefined ? freshNonce() : o.nonce;

  const toSign = o.signOverride !== undefined ? o.signOverride : signedString({
    method: o.signMethod || method,
    path: o.signPath || reqPath,
    sortedQuery: o.signQuery === undefined ? canonicalQuery(query) : o.signQuery,
    bodyHashB64u: o.signBodyHash === undefined ? b64u(hash) : o.signBodyHash,
    ts: o.signTs === undefined ? ts : o.signTs,
    nonce: o.signNonce === undefined ? nonce : o.signNonce,
  });
  const key = o.signWith || o.dev.pair.privateKey;
  const sig = new Uint8Array(await SUBTLE.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, TE.encode(toSign)));

  const device = o.deviceShort || o.dev.deviceShort;
  const header = o.header !== undefined ? o.header
    : `${AUTH_SCHEME} device=${device}, ts=${ts}, nonce=${nonce}, sig=${b64u(sig)}`;

  return {
    method,
    path: reqPath,
    query,
    headers: { authorization: header, 'x-lzp-protocol': '1' },
    body: hasBody ? o.bodyObj : null,
    rawBody,
    routeName: o.routeName === undefined ? (method === 'GET' ? 'pullOps' : 'pushOps') : o.routeName,
    params: o.params || {},
    _signedString: toSign,
  };
}

/** Run and return the thrown HttpError code, or 'OK'. */
async function codeOf(fn) {
  try { await fn(); return 'OK'; } catch (err) {
    if (err instanceof HttpError) return err.code;
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The signed string, pinned
// ─────────────────────────────────────────────────────────────────────────────

test('signedString is byte-for-byte ADR 003 §2', () => {
  const s = signedString({
    method: 'POST',
    path: '/api/v1/ops',
    sortedQuery: '',
    bodyHashB64u: '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU',
    ts: '1787836800123',
    nonce: 'AAECAwQFBgcICQoLDA0ODw',
  });
  assert.equal(s,
    'lzp/v2\n' +
    'POST\n' +
    '/api/v1/ops?\n' +
    '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU\n' +
    '1787836800123\n' +
    'AAECAwQFBgcICQoLDA0ODw');
  // Six lines, five separators, and the '?' is unconditional — it is a separator, not a marker.
  assert.equal(s.split('\n').length, 6);
  assert.ok(s.startsWith(SIGNED_PREFIX), 'ADR 002 §1 rule 2: the signed payload is never empty');
});

test('the empty-body hash in that vector really is SHA-256 of zero bytes', async () => {
  const h = new Uint8Array(await SUBTLE.digest('SHA-256', new Uint8Array(0)));
  assert.equal(b64u(h), '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
});

test('signedBytes hashes rawBody — never the parsed body', async () => {
  const clock = fakeClock(T0);
  const ctx = makeCtx(null, clock);
  const raw = TE.encode('{"space":"fsp_AAAAAAAAAAAAAAAAAAAAAA"}');
  const a = await signedBytes({ method: 'POST', path: '/api/v1/ops', query: {}, rawBody: raw, body: { space: 'x' } }, ctx, { ts: '1', nonce: 'n' });
  const b = await signedBytes({ method: 'POST', path: '/api/v1/ops', query: {}, rawBody: raw, body: { totally: 'different' } }, ctx, { ts: '1', nonce: 'n' });
  assert.deepEqual(a, b, 'the parsed body must not influence the signed bytes at all');
});

test('canonicalQuery: empty, sorted by encoded key then value, repeated keys kept', () => {
  assert.equal(canonicalQuery(undefined), '');
  assert.equal(canonicalQuery({}), '');
  assert.equal(canonicalQuery({ space: SPACE, since: '10201', limit: '500' }),
    `limit=500&since=10201&space=${SPACE}`);
  // sorting is over the ENCODED forms
  assert.equal(canonicalQuery({ b: 'x', a: 'z' }), 'a=z&b=x');
  assert.equal(canonicalQuery({ k: ['b', 'a'] }), 'k=a&k=b');
  assert.equal(canonicalQuery({ 'a b': 'c d' }), 'a%20b=c%20d');
  // key order in the object must never change the output
  assert.equal(canonicalQuery({ since: '1', space: SPACE }), canonicalQuery({ space: SPACE, since: '1' }));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. deviceShort — one function, two implementations, asserted equal
// ─────────────────────────────────────────────────────────────────────────────

test('the server derives the SAME deviceShort as src/js/core/ids.js, over real keys', async () => {
  for (let i = 0; i < 8; i++) {
    const d = await mintDevice();
    assert.equal(d.deviceShort, clientDeviceShortOf(d.sigPubRaw),
      'the HTTP principal and the HLC tiebreak must be one function, not two');
    assert.match(d.deviceShort, DEVICE_SHORT_RE);
  }
});

test('deviceShortOfRaw refuses anything that is not a 65-byte raw point', async () => {
  assert.equal(await deviceShortOfRaw(new Uint8Array(64), {}), null);
  assert.equal(await deviceShortOfRaw(new Uint8Array(66), {}), null);
  assert.equal(await deviceShortOfRaw('not bytes', {}), null);
  assert.equal(await deviceShortOfRaw(null, {}), null);
});

test('crock32 and b64u round-trip against the client alphabets', () => {
  assert.equal(crock32(new Uint8Array(10)), '0'.repeat(16));
  assert.equal(b64u(new Uint8Array(0)), '');
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(ub64(b64u(bytes)), bytes);
});

test('ub64 is strict: padding, standard-base64, junk and non-canonical tails are all null', () => {
  assert.equal(ub64('AA=='), null, 'padding is never emitted and never accepted');
  assert.equal(ub64('++//'), null, 'standard base64 is not base64url');
  assert.equal(ub64('A'), null, 'impossible length');
  assert.equal(ub64('AB'), null, 'spare bits set — a second spelling of the same byte');
  assert.deepEqual(ub64('AA'), new Uint8Array([0]), 'the canonical spelling of one zero byte');
  assert.equal(ub64('AAB'), null, 'spare bits set in a 2-byte tail');
  // Two spellings of one nonce would defeat the replay window, so the canonical one is the only one.
  assert.deepEqual(ub64('AQ'), new Uint8Array([1]));
  assert.equal(ub64('AAAAAAAAAAAAAAAAAAAAAA', NONCE_BYTES).length, 16);
  assert.equal(ub64('AAAAAAAAAAAAAAAAAAAAAA', 15), null, 'the expected length is enforced');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The Authorization header parser
// ─────────────────────────────────────────────────────────────────────────────

test('parseAuthorization accepts exactly the four parameters and nothing else', () => {
  const good = `LZP1 device=7QAR2MZ9XKPNC0GV, ts=${T0}, nonce=AAAAAAAAAAAAAAAAAAAAAA, sig=${'A'.repeat(86)}`;
  const p = parseAuthorization(good);
  assert.equal(p.device, '7QAR2MZ9XKPNC0GV');
  assert.equal(p.tsMs, T0);
  assert.equal(p.sigBytes.length, SIG_BYTES);
  assert.deepEqual(AUTH_PARAMS.slice().sort(), ['device', 'nonce', 'sig', 'ts']);

  const bad = [
    [undefined, 'absent'],
    ['', 'empty'],
    ['Bearer abc', 'a different scheme'],
    ['LZP1', 'no parameters'],
    [good.replace('LZP1 ', 'LZP2 '), 'the wrong scheme version'],
    [good + ', alg=none', 'an unknown parameter'],
    [good + `, ts=${T0}`, 'a duplicated parameter'],
    [good.replace(`ts=${T0}, `, ''), 'a missing parameter'],
    [good.replace('device=7QAR2MZ9XKPNC0GV', 'device=7qar2mz9xkpnc0gv'), 'a lower-case short'],
    [good.replace('device=7QAR2MZ9XKPNC0GV', 'device=7QAR2MZ9XKPNC0G'), 'a 15-character short'],
    [good.replace('device=7QAR2MZ9XKPNC0GV', 'device=UQAR2MZ9XKPNC0GV'), 'U — excluded from Crockford'],
    [good.replace('device=7QAR2MZ9XKPNC0GV', 'device=../../etc/passwd'), 'traversal in the store key'],
    [good.replace(`ts=${T0}`, 'ts=-1'), 'a negative ts'],
    [good.replace(`ts=${T0}`, 'ts=1e12'), 'an exponent'],
    [good.replace('nonce=AAAAAAAAAAAAAAAAAAAAAA', 'nonce=AAAA'), 'a 3-byte nonce'],
    [good.replace('nonce=AAAAAAAAAAAAAAAAAAAAAA', 'nonce=AAAAAAAAAAAAAAAAAAAAAB'), 'a non-canonical nonce'],
    [good.replace('sig=' + 'A'.repeat(86), 'sig=' + 'A'.repeat(94)), 'a 70-byte DER signature'],
    [good.replace('sig=' + 'A'.repeat(86), 'sig='), 'an empty signature'],
  ];
  for (const [header, why] of bad) {
    assert.throws(() => parseAuthorization(header), (e) => e.code === 'bad_auth', `accepted ${why}`);
  }
});

test('the scheme token is case-insensitive; the parameter names are not', () => {
  const base = `device=7QAR2MZ9XKPNC0GV, ts=${T0}, nonce=AAAAAAAAAAAAAAAAAAAAAA, sig=${'A'.repeat(86)}`;
  assert.ok(parseAuthorization(`lzp1 ${base}`));
  assert.throws(() => parseAuthorization(`LZP1 ${base.replace('device=', 'Device=')}`), (e) => e.code === 'bad_auth');
});

test('headerOf reads case-insensitively, because entry points disagree and the protocol does not', () => {
  assert.equal(headerOf({ headers: { Authorization: 'x' } }, 'authorization'), 'x');
  assert.equal(headerOf({ headers: { AUTHORIZATION: 'x' } }, 'Authorization'), 'x');
  assert.equal(headerOf({ headers: {} }, 'authorization'), undefined);
  assert.equal(headerOf({}, 'authorization'), undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The seven steps, per adapter
// ─────────────────────────────────────────────────────────────────────────────

for (const adapter of ADAPTERS) {
  const T = (name, fn) => test(`[${adapter.name}] ${name}`, fn);

  T('an honest request authenticates and yields the principal, not a token', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev, memberId } = await seed(store);
    const ctx = makeCtx(store, clock);
    const req = await signReq({ dev, query: { space: SPACE, since: '0' } });
    const a = await authenticate(req, ctx);
    assert.equal(a.deviceShort, dev.deviceShort);
    assert.equal(a.memberId, memberId);
    assert.equal(a.deviceId, 'dev_AAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(a.spaceId, SPACE);
    assert.equal(a.member.id, memberId);
    assert.equal(a.body, null, 'a GET signs zero bytes and carries no body');
  });

  T('STEP 5 — a signature over DIFFERENT BYTES is refused, one component at a time', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev } = await seed(store);
    const ctx = makeCtx(store, clock);

    // Each row signs a string that differs from the request in exactly one place. This is the
    // test the whole scheme rests on: if any single one of these passed, that component would be
    // unsigned and therefore attacker-controlled.
    const variants = [
      ['method', { signMethod: 'GET', method: 'POST', bodyObj: { space: SPACE } }],
      ['path', { signPath: '/api/v1/meta' }],
      ['query', { signQuery: `space=${SPACE}&since=0`, query: { space: SPACE, since: '999999' } }],
      ['the query it omits', { signQuery: '', query: { space: SPACE } }],
      ['body hash', { method: 'POST', bodyObj: { space: SPACE, ops: [] }, signBodyHash: b64u(new Uint8Array(32)) }],
      ['ts', { signTs: String(T0 - 1) }],
      ['nonce', { signNonce: 'AAAAAAAAAAAAAAAAAAAAAA' }],
      ['the "lzp/v2" prefix', { signOverride: 'GET\n/api/v1/ops?\nx\n1\nn' }],
      ['a newline moved', { signOverride: `lzp/v2\nGET\n/api/v1/ops?\n\nx\n${T0}\nn` }],
    ];
    for (const [what, over] of variants) {
      const req = await signReq({ dev, query: { space: SPACE }, ...over });
      assert.equal(await codeOf(() => authenticate(req, ctx)), 'bad_signature',
        `a signature over a different ${what} was ACCEPTED`);
    }

    // ... and the same request, signed correctly, passes. Otherwise the rows above prove nothing.
    const ok = await signReq({ dev, query: { space: SPACE } });
    assert.equal(await codeOf(() => authenticate(ok, ctx)), 'OK');
  });

  T('STEP 5 — another device\'s key does not authenticate this device', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev } = await seed(store);
    const attacker = await mintDevice();
    const ctx = makeCtx(store, clock);
    const req = await signReq({ dev, query: { space: SPACE }, signWith: attacker.pair.privateKey });
    assert.equal(await codeOf(() => authenticate(req, ctx)), 'bad_signature');
  });

  T('STEP 2 — the replay window is symmetric and is 120 s', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev } = await seed(store);
    const ctx = makeCtx(store, clock);
    for (const [ts, expect] of [
      [T0, 'OK'],
      [T0 + LIMITS_SHAPE.authWindowMs, 'OK'],
      [T0 - LIMITS_SHAPE.authWindowMs, 'OK'],
      [T0 + LIMITS_SHAPE.authWindowMs + 1, 'stale_request'],
      [T0 - LIMITS_SHAPE.authWindowMs - 1, 'stale_request'],
    ]) {
      const req = await signReq({ dev, query: { space: SPACE }, ts });
      assert.equal(await codeOf(() => authenticate(req, ctx)), expect, `ts offset ${ts - T0}`);
    }
    // A stolen HTTP log is worthless after two minutes — and cannot be replayed at all inside
    // them, which is step 3.
  });

  T('STEP 3 — the same request twice is a replay, and the SECOND one is refused', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev } = await seed(store);
    const ctx = makeCtx(store, clock);
    const req = await signReq({ dev, query: { space: SPACE } });
    assert.equal(await codeOf(() => authenticate(req, ctx)), 'OK');
    assert.equal(await codeOf(() => authenticate(req, ctx)), 'replay',
      'a perfectly valid signature, captured and re-sent, must not work twice');
  });

  T('STEP 3 — the nonce window re-opens after the TTL, and the ts window closes first', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev } = await seed(store);
    const ctx = makeCtx(store, clock);
    const nonce = freshNonce();
    const req = await signReq({ dev, query: { space: SPACE }, nonce });
    assert.equal(await codeOf(() => authenticate(req, ctx)), 'OK');
    clock.advance(LIMITS_SHAPE.nonceTtlMs + 1);
    // The nonce row has expired, so step 3 would now pass — but step 2 has already refused,
    // which is the point: the 300 s nonce TTL strictly outlives the 120 s signing window, so a
    // nonce can never be reused while a request bearing it is still fresh.
    assert.equal(await codeOf(() => authenticate(req, ctx)), 'stale_request');
    assert.ok(LIMITS_SHAPE.nonceTtlMs > LIMITS_SHAPE.authWindowMs,
      'if this inequality ever flips, replay comes back');
  });

  T('STEP 3 — a nonce is per device, so two devices may pick the same 16 bytes', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev, memberId } = await seed(store);
    const second = await mintDevice();
    await store.addDevice(fixtures.device({
      id: 'dev_BBBBBBBBBBBBBBBBBBBBBB', memberId, deviceShort: second.deviceShort,
      sigPubRaw: second.sigPubRaw, kexPubRaw: second.kexPubRaw, addedAt: new Date(T0),
    }));
    const ctx = makeCtx(store, clock);
    const nonce = freshNonce();
    const first = await signReq({ dev, query: { space: SPACE }, nonce });
    assert.equal(await codeOf(() => authenticate(first, ctx)), 'OK');
    const a = await signReq({ dev, query: { space: SPACE }, nonce });
    const b = await signReq({ dev: second, query: { space: SPACE }, nonce });
    assert.equal(await codeOf(() => authenticate(a, ctx)), 'replay');
    assert.equal(await codeOf(() => authenticate(b, ctx)), 'OK');
  });

  T('STEP 4 — unknown and revoked are the SAME answer, so the endpoint is not an oracle', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev } = await seed(store);
    const ghost = await mintDevice();
    const ctx = makeCtx(store, clock);

    const unknown = await signReq({ dev: ghost, query: { space: SPACE } });
    assert.equal(await codeOf(() => authenticate(unknown, ctx)), 'device_revoked');

    await store.revokeDevice('dev_AAAAAAAAAAAAAAAAAAAAAA', clock.now());
    const revoked = await signReq({ dev, query: { space: SPACE } });
    assert.equal(await codeOf(() => authenticate(revoked, ctx)), 'device_revoked');
  });

  T('STEP 4 — revocation is instant: the same key stops working on the next request', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev } = await seed(store);
    const ctx = makeCtx(store, clock);
    assert.equal(await codeOf(async () => authenticate(await signReq({ dev, query: { space: SPACE } }), ctx)), 'OK');
    await store.revokeDevice('dev_AAAAAAAAAAAAAAAAAAAAAA', clock.now());
    assert.equal(await codeOf(async () => authenticate(await signReq({ dev, query: { space: SPACE } }), ctx)), 'device_revoked');
  });

  T('STEP 4b — a device row claiming a short it cannot derive is refused', async () => {
    // The relay holds no attestation registers — they live inside ciphertext it cannot read
    // (ADR 002 §5.2) — so the principal has to be self-certifying or it is an unverifiable claim.
    // This is the line that keeps that true even for a row written by some other path.
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const dev = await mintDevice();
    await store.createSpace(fixtures.space({ id: SPACE }));
    await store.addMember(fixtures.member({ id: 'mem_AAAAAAAAAAAAAAAAAAAAAA', spaceId: SPACE }));
    await store.addDevice(fixtures.device({
      id: 'dev_AAAAAAAAAAAAAAAAAAAAAA', memberId: 'mem_AAAAAAAAAAAAAAAAAAAAAA',
      deviceShort: 'ZZZZZZZZZZZZZZZZ',                 // not crock32(SHA-256(sigPubRaw)[0..10])
      sigPubRaw: dev.sigPubRaw, kexPubRaw: dev.kexPubRaw,
    }));
    const ctx = makeCtx(store, clock);
    const req = await signReq({ dev, deviceShort: 'ZZZZZZZZZZZZZZZZ', query: { space: SPACE } });
    assert.equal(await codeOf(() => authenticate(req, ctx)), 'device_revoked',
      'a principal the relay cannot re-derive from the key it holds must not authenticate');
  });

  T('STEP 6 — a removed member is refused instantly, with one column write', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev, memberId } = await seed(store);
    const ctx = makeCtx(store, clock);
    assert.equal(await codeOf(async () => authenticate(await signReq({ dev, query: { space: SPACE } }), ctx)), 'OK');
    await store.removeMember(memberId, clock.now());
    assert.equal(await codeOf(async () => authenticate(await signReq({ dev, query: { space: SPACE } }), ctx)), 'not_a_member',
      '20.1 "sofort" is a property of the auth model, not a promise of the UI');
  });

  T('STEP 7 — a member of one space may not act on another, and cannot tell it apart from removal', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev } = await seed(store);
    await store.createSpace(fixtures.space({ id: OTHER_SPACE }));
    await store.addMember(fixtures.member({ id: 'mem_BBBBBBBBBBBBBBBBBBBBBB', spaceId: OTHER_SPACE, colorRef: 'blau' }));
    const ctx = makeCtx(store, clock);
    const req = await signReq({ dev, query: { space: OTHER_SPACE } });
    assert.equal(await codeOf(() => authenticate(req, ctx)), 'not_a_member');

    // A space that does not exist answers identically — no existence oracle.
    const ghost = await signReq({ dev, query: { space: 'fsp_CCCCCCCCCCCCCCCCCCCCCC' } });
    assert.equal(await codeOf(() => authenticate(ghost, ctx)), 'not_a_member');
    // ... and so does a malformed one.
    const junk = await signReq({ dev, query: { space: 'not-a-space' } });
    assert.equal(await codeOf(() => authenticate(junk, ctx)), 'not_a_member');
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // STEP 4, ROUND 10 ITEM 8 — the short names a machine; the ROW names a membership
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('STEP 4 — one Mac, two circles: each request resolves the member of ITS OWN space', async () => {
    // The whole of E2-203-1's product half, at the auth layer. Before round 10 this store state
    // was not representable: `deviceShort` was globally unique, so the second row threw.
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev, memberId } = await seed(store);
    await store.createSpace(fixtures.space({ id: OTHER_SPACE }));
    await store.addMember(fixtures.member({ id: 'mem_BBBBBBBBBBBBBBBBBBBBBB', spaceId: OTHER_SPACE, colorRef: 'blau' }));
    await store.addDevice(fixtures.device({
      id: 'dev_BBBBBBBBBBBBBBBBBBBBBB', spaceId: OTHER_SPACE, memberId: 'mem_BBBBBBBBBBBBBBBBBBBBBB',
      deviceShort: dev.deviceShort,                       // THE SAME MAC: one IK_sig, one short
      sigPubRaw: dev.sigPubRaw, kexPubRaw: dev.kexPubRaw, addedAt: new Date(T0),
    }));
    const ctx = makeCtx(store, clock);

    const here = await authenticate(await signReq({ dev, query: { space: SPACE } }), ctx);
    assert.equal(here.memberId, memberId, 'in her own space she is her own member');
    assert.equal(here.deviceId, 'dev_AAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(here.spaceId, SPACE);

    const there = await authenticate(await signReq({ dev, query: { space: OTHER_SPACE } }), ctx);
    assert.equal(there.memberId, 'mem_BBBBBBBBBBBBBBBBBBBBBB',
      'and in the circle she is the OTHER member — resolving this by picking the first row would '
      + 'attribute her family ops to her personal member id and vice versa');
    assert.equal(there.deviceId, 'dev_BBBBBBBBBBBBBBBBBBBBBB');
  });

  T('STEP 4 — revocation is per circle: unpairing a Mac from the family leaves the personal space alone', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev } = await seed(store);
    await store.createSpace(fixtures.space({ id: OTHER_SPACE }));
    await store.addMember(fixtures.member({ id: 'mem_BBBBBBBBBBBBBBBBBBBBBB', spaceId: OTHER_SPACE, colorRef: 'blau' }));
    await store.addDevice(fixtures.device({
      id: 'dev_BBBBBBBBBBBBBBBBBBBBBB', spaceId: OTHER_SPACE, memberId: 'mem_BBBBBBBBBBBBBBBBBBBBBB',
      deviceShort: dev.deviceShort, sigPubRaw: dev.sigPubRaw, kexPubRaw: dev.kexPubRaw, addedAt: new Date(T0),
    }));
    await store.revokeDevice('dev_BBBBBBBBBBBBBBBBBBBBBB', clock.now());
    const ctx = makeCtx(store, clock);

    assert.equal(await codeOf(async () => authenticate(await signReq({ dev, query: { space: OTHER_SPACE } }), ctx)),
      'device_revoked', 'revoked HERE');
    assert.equal(await codeOf(async () => authenticate(await signReq({ dev, query: { space: SPACE } }), ctx)),
      'OK', 'and still this person\'s own machine in their own space — a family unpairing is not a wipe');
  });

  T('STEP 4/7 — a Mac with no row in the named space answers not_a_member, and only AFTER the signature', async () => {
    // The oracle this ordering exists to deny: "is device X in circle Y?" must cost the private
    // key. Answering the membership question at step 4 would have made it free.
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev } = await seed(store);
    await store.createSpace(fixtures.space({ id: OTHER_SPACE }));
    await store.addMember(fixtures.member({ id: 'mem_BBBBBBBBBBBBBBBBBBBBBB', spaceId: OTHER_SPACE, colorRef: 'blau' }));
    const ctx = makeCtx(store, clock);

    const forged = await signReq({
      dev, query: { space: OTHER_SPACE }, signWith: (await mintDevice()).pair.privateKey,
    });
    assert.equal(await codeOf(() => authenticate(forged, ctx)), 'bad_signature',
      'step 5 wins: a prober without the key learns nothing about which circles this short is in');
    const honest = await signReq({ dev, query: { space: OTHER_SPACE } });
    assert.equal(await codeOf(() => authenticate(honest, ctx)), 'not_a_member');
  });

  T('the steps run IN ORDER: an earlier failure always wins', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev, memberId } = await seed(store);
    await store.removeMember(memberId, clock.now());
    await store.revokeDevice('dev_AAAAAAAAAAAAAAAAAAAAAA', clock.now());
    const ctx = makeCtx(store, clock);

    // This request is stale AND signed by the wrong key AND from a revoked device AND from a
    // removed member AND for a space it is not in. Step 2 wins.
    const req = await signReq({
      dev, ts: T0 - 10 * 60000, query: { space: OTHER_SPACE }, signWith: (await mintDevice()).pair.privateKey,
    });
    assert.equal(await codeOf(() => authenticate(req, ctx)), 'stale_request');

    // Fix the clock: now step 4 wins over 5, 6 and 7.
    const req2 = await signReq({
      dev, query: { space: OTHER_SPACE }, signWith: (await mintDevice()).pair.privateKey,
    });
    assert.equal(await codeOf(() => authenticate(req2, ctx)), 'device_revoked');
  });

  T('a space-scoped route with NO space id in the request never silently skips step 7', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev } = await seed(store);
    const ctx = makeCtx(store, clock);
    const req = await signReq({ dev, query: {} });          // routeName pullOps, no `space`
    const a = await authenticate(req, ctx);
    assert.equal(a.spaceId, null);
    assert.equal(a.member, null,
      'auth reports honestly that it could not check; the handler must then refuse — see ops.js');
  });

  T('a route that is not space-scoped is authenticated but not membership-checked', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const { dev, memberId } = await seed(store);
    await store.removeMember(memberId, clock.now());
    const ctx = makeCtx(store, clock);
    const req = await signReq({ dev, method: 'POST', path: '/api/v1/devices', bodyObj: { x: 1 }, routeName: 'registerDevice' });
    const a = await authenticate(req, ctx);
    assert.equal(a.spaceId, null);
    // This is gap E2-202-A, asserted so it cannot be forgotten: a REMOVED member's device still
    // authenticates on the ten routes that name no space. LZP-202's own two routes are
    // space-scoped and unaffected; LZP-204's are not.
    assert.equal(a.memberId, memberId);
    assert.ok(AUTH_INTERFACE_GAPS.some((g) => g.id === 'E2-202-A'));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The body a handler is allowed to act on
// ─────────────────────────────────────────────────────────────────────────────

test('readSignedBody parses the SIGNED bytes and ignores req.body entirely', () => {
  const raw = TE.encode('{"space":"real"}');
  const out = readSignedBody({ rawBody: raw, body: { space: 'forged' } });
  assert.deepEqual(out, { space: 'real' },
    'two parsers and one signature is how unsigned data reaches a handler');
});

test('readSignedBody refuses a parsed body that arrived without the bytes it came from', () => {
  assert.throws(() => readSignedBody({ rawBody: new Uint8Array(0), body: { a: 1 } }), (e) => e.code === 'bad_auth');
  assert.throws(() => readSignedBody({ body: { a: 1 } }), (e) => e.code === 'bad_auth');
  assert.equal(readSignedBody({ rawBody: new Uint8Array(0), body: null }), null);
  assert.equal(readSignedBody({ body: null }), null);
});

test('readSignedBody refuses non-JSON and a non-object top level', () => {
  for (const s of ['not json', '[]', '"a string"', '42', 'null', '{']) {
    assert.throws(() => readSignedBody({ rawBody: TE.encode(s), body: null }), (e) => e.code === 'bad_request', s);
  }
});

test('a duplicate JSON key cannot make the signer and the handler disagree', () => {
  // JSON.parse takes the last occurrence. Whatever it takes, both sides take the same one,
  // because there is only one parse of one byte string.
  const raw = TE.encode('{"space":"a","space":"b"}');
  assert.deepEqual(readSignedBody({ rawBody: raw, body: null }), { space: 'b' });
});

test('spaceIdOf reads the table LZP-201 owns, from the right place per route', () => {
  assert.equal(spaceIdOf({ routeName: 'pushOps' }, { space: SPACE }), SPACE);
  assert.equal(spaceIdOf({ routeName: 'pullOps', query: { space: SPACE } }, null), SPACE);
  assert.equal(spaceIdOf({ routeName: 'rotateEpoch', params: { id: SPACE } }, null), SPACE);
  assert.equal(spaceIdOf({ routeName: 'registerDevice' }, { space: SPACE }), null);
  assert.equal(spaceIdOf({ routeName: 'pushOps' }, { space: 42 }), null, 'a non-string is not a space id');
  assert.equal(spaceIdOf({}, null), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. verifySignature — the engine boundary
// ─────────────────────────────────────────────────────────────────────────────

test('verifySignature returns false rather than throwing, for every malformed input', async () => {
  const d = await mintDevice();
  const bytes = TE.encode('lzp/v2\nGET\n/x?\ny\n1\nn');
  const sig = new Uint8Array(await SUBTLE.sign({ name: 'ECDSA', hash: 'SHA-256' }, d.pair.privateKey, bytes));
  assert.equal(await verifySignature(d.sigPubRaw, sig, bytes, {}), true);
  // ADR 002 §1 rule 3: never branch on an engine's error NAME. So nothing here may throw.
  assert.equal(await verifySignature(new Uint8Array(64), sig, bytes, {}), false, 'short key');
  assert.equal(await verifySignature(d.sigPubRaw, new Uint8Array(70), bytes, {}), false, 'DER-length signature');
  assert.equal(await verifySignature(d.sigPubRaw, sig, new Uint8Array(0), {}), false, 'rule 2: zero-length payload');
  assert.equal(await verifySignature(d.sigPubRaw, sig, TE.encode('other'), {}), false);
  const notAPoint = new Uint8Array(65); notAPoint[0] = 4;
  assert.equal(await verifySignature(notAPoint, sig, bytes, {}), false, 'a point that is not on the curve');
});

test('ADR 002 §1 rule 1 — signatures are non-deterministic, so none of this may compare them', async () => {
  const d = await mintDevice();
  const bytes = TE.encode('lzp/v2\nGET\n/x?\ny\n1\nn');
  const a = new Uint8Array(await SUBTLE.sign({ name: 'ECDSA', hash: 'SHA-256' }, d.pair.privateKey, bytes));
  const b = new Uint8Array(await SUBTLE.sign({ name: 'ECDSA', hash: 'SHA-256' }, d.pair.privateKey, bytes));
  assert.notDeepEqual(a, b, 'if this ever fails the engine changed, not the test');
  assert.equal(await verifySignature(d.sigPubRaw, a, bytes, {}), true);
  assert.equal(await verifySignature(d.sigPubRaw, b, bytes, {}), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The gaps this file could not close, kept honest
// ─────────────────────────────────────────────────────────────────────────────

test('every recorded interface gap names what breaks and who owns it', () => {
  assert.ok(AUTH_INTERFACE_GAPS.length >= 3);
  const ids = AUTH_INTERFACE_GAPS.map((g) => g.id);
  assert.deepEqual(ids, [...new Set(ids)], 'duplicate gap ids');
  for (const g of AUTH_INTERFACE_GAPS) {
    // `E2-L…` joined the table with the admin proof (§6b): a gap in the STORE INTERFACE that
    // this file's authorization code runs into is the same kind of row as a gap in the auth
    // ladder, and splitting them into two lists would mean one of the two stopped being read.
    assert.match(g.id, /^(E2-202-[A-Z]|E2-L\d[a-z]?)$/);
    assert.ok(g.what.length > 40, `${g.id}: "what" must be specific enough to act on`);
    assert.ok(g.consequence.length > 80, `${g.id}: a gap without a stated consequence is a TODO`);
    assert.ok(g.owner.length > 0);
  }
  assert.ok(Object.isFrozen(AUTH_INTERFACE_GAPS));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6b · THE ADMIN PROOF — attacked, not demonstrated.  ADR 003 §3.7, finding T5-M1b.
//
// This is the relay's SECOND authorization mechanism and the first one that is not about a
// device. Everything below is the same discipline as the request signature above: pin the exact
// bytes, then vary every component in isolation and require a refusal — because a proof whose
// payload is "roughly the act" authorizes acts nobody signed for.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SP_A = 'fsp_AAAAAAAAAAAAAAAAAAAAAA';

async function recoveryKeypair() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { priv: kp.privateKey, pubRaw: new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey)) };
}
async function signProof(kp, terms) {
  const bytes = new TextEncoder().encode(adminProofString(terms));
  return b64u(new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.priv, bytes)));
}
const memberRowOf = (id, kp, removedAt = null) => ({ id, spaceId: SP_A, recoveryPubSig: kp.pubRaw, removedAt });

test('§6b the admin-proof string is pinned byte for byte, and its domain is not the request domain', () => {
  // T5-M4 (round 3): SIX components, and the sixth is the PRESENTER. The version moved with the
  // arity on purpose — a `lzp/admin/1` proof over four fields can never verify here again, so an
  // old bearer token stops being a token rather than becoming a shorter one.
  assert.equal(
    adminProofString({
      act: 'space.delete', spaceId: SP_A, target: SP_A, epoch: 4, presenter: 'mem_eve',
    }),
    'lzp/admin/2\nspace.delete\n' + SP_A + '\n' + SP_A + '\n4\nmem_eve');
  assert.equal(ADMIN_PROOF_PREFIX, 'lzp/admin/2\n');
  // A request signature and an admin proof must never be interchangeable. Different prefix,
  // different arity — a caller cannot hand the relay one where it asked for the other.
  assert.notEqual(ADMIN_PROOF_PREFIX, SIGNED_PREFIX);
  assert.deepEqual([...ADMIN_ACTS], ['space.delete', 'member.remove']);
  assert.ok(Object.isFrozen(ADMIN_ACTS));

  // A MISSING presenter must THROW and never silently stringify into the bytes: `undefined`
  // appended is a payload nobody signed for, and it would re-open T5-M4 by accident rather than
  // by decision. This is the assertion that kills a "make presenter optional" regression.
  for (const bad of [undefined, null, '', 42]) {
    assert.throws(
      () => adminProofString({ act: 'space.delete', spaceId: SP_A, target: SP_A, epoch: 4, presenter: bad }),
      /presenter is required/,
      `adminProofString accepted presenter=${JSON.stringify(bad)}`);
  }
});

test('§6b a proof by a second live member verifies — the NON-VACUITY half', async () => {
  const admin = await recoveryKeypair();
  const terms = { act: 'space.delete', spaceId: SP_A, target: SP_A, epoch: 2, presenter: 'mem_eve' };
  const members = [memberRowOf('mem_admin', admin), memberRowOf('mem_eve', await recoveryKeypair())];
  const out = await verifyAdminProof(
    { by: 'mem_admin', sig: await signProof(admin, terms) },
    { ...terms, members, callerMemberId: 'mem_eve' });
  assert.deepEqual(out, { by: 'mem_admin' });
});

test('§6b every single-actor and mix-and-match shape is refused, each for its own reason', async () => {
  const admin = await recoveryKeypair();
  const eve = await recoveryKeypair();
  const gone = await recoveryKeypair();
  const terms = { act: 'space.delete', spaceId: SP_A, target: SP_A, epoch: 2, presenter: 'mem_eve' };
  const members = [
    memberRowOf('mem_admin', admin),
    memberRowOf('mem_eve', eve),
    memberRowOf('mem_gone', gone, 1234),
  ];
  const run = async (proof, over) => {
    try {
      await verifyAdminProof(proof, { ...terms, ...over, members, callerMemberId: 'mem_eve' });
      return null;
    } catch (e) { return { status: e.status, code: e.code, reason: e.extra && e.extra.reason }; }
  };
  const good = await signProof(admin, terms);

  // THE TWO-KEY RULE: her own key, correctly signed, is the attack this mechanism exists for.
  assert.deepEqual(await run({ by: 'mem_eve', sig: await signProof(eve, terms) }),
    { status: 400, code: 'bad_request', reason: 'admin_proof_self_signed' });
  // A signer who is not in this space, and one who is only a tombstone.
  assert.equal((await run({ by: 'mem_nobody', sig: good })).reason, 'admin_proof_signer_not_a_member');
  assert.equal((await run({ by: 'mem_gone', sig: await signProof(gone, terms) })).reason,
    'admin_proof_signer_not_a_member');
  // MIX AND MATCH: an honest name over somebody else's signature.
  assert.equal((await run({ by: 'mem_admin', sig: await signProof(eve, terms) })).code, 'bad_signature');
  // Every component of the payload, varied in isolation, over a signature that is otherwise good.
  for (const over of [
    { act: 'member.remove' },
    { epoch: 3 },
    { target: 'mem_admin' },
    { spaceId: 'fsp_BBBBBBBBBBBBBBBBBBBBBB' },
  ]) {
    assert.equal((await run({ by: 'mem_admin', sig: await signProof(admin, terms) }, over)).code,
      'bad_signature', `a proof survived ${JSON.stringify(over)}`);
  }
  // Shapes. None of these may reach the verify at all.
  for (const p of [null, undefined, '', 0, [], { sig: good }, { by: 'mem_admin' },
    { by: 'mem_admin', sig: 'not base64url!!' }, { by: 'mem_admin', sig: b64u(new Uint8Array(63)) },
    { by: 42, sig: good }, { by: 'm'.repeat(200), sig: good }]) {
    const r = await run(p);
    assert.equal(r && r.status, 400, `accepted ${JSON.stringify(p)}`);
  }
  // And an act outside the closed set is a BUG in the caller, not a client error.
  assert.equal((await run({ by: 'mem_admin', sig: good }, { act: 'space.rename' })).code, 'internal');
});

test('§6b T5-M4 · a proof is minted FOR one member and is bytes to everybody else', async () => {
  // ROUND 3, the half that was open. `lzp/admin/1` named an act and no beneficiary, so Mama's
  // co-signature "so that Papa may remove Oma" was spendable by whoever held the bytes — Eve
  // included (`tests/fleet/e6-gate-removal.test.js` §3d, then SUCCEEDED). The presenter is now
  // the sixth component, taken off the AUTHENTICATED device's member row.
  const mama = await recoveryKeypair();
  const act = { act: 'member.remove', spaceId: SP_A, target: 'mem_oma', epoch: 7 };
  const members = [
    memberRowOf('mem_mama', mama),
    memberRowOf('mem_papa', await recoveryKeypair()),
    memberRowOf('mem_eve', await recoveryKeypair()),
  ];
  const forPapa = { by: 'mem_mama', sig: await signProof(mama, { ...act, presenter: 'mem_papa' }) };

  // The beneficiary spends it: 200-shaped, and it is the SAME co-signature both ways round.
  assert.deepEqual(
    await verifyAdminProof(forPapa, { ...act, members, callerMemberId: 'mem_papa' }),
    { by: 'mem_mama' });

  // Anybody else presenting the identical bytes is a wrong signature, not a special error: there
  // is no new refusal code and therefore no new oracle — the same shape as the wrong act, the
  // wrong epoch and the wrong space above.
  let refused = null;
  try {
    await verifyAdminProof(forPapa, { ...act, members, callerMemberId: 'mem_eve' });
  } catch (e) { refused = { status: e.status, code: e.code }; }
  assert.deepEqual(refused, { status: 401, code: 'bad_signature' });

  // And a caller the handler could not name is a HANDLER bug, never a 400 that tells the caller
  // anything: the presenter is now load-bearing, so an absent one may not degrade to /1 bytes.
  for (const caller of [undefined, null, '', 7]) {
    let r = null;
    try {
      await verifyAdminProof(forPapa, { ...act, members, callerMemberId: caller });
    } catch (e) { r = e.code; }
    assert.equal(r, 'internal', `callerMemberId=${JSON.stringify(caller)}`);
  }
});

test('§6b no refusal ever echoes a caller\'s bytes, and none is an enumeration oracle', async () => {
  const admin = await recoveryKeypair();
  const members = [memberRowOf('mem_admin', admin), memberRowOf('mem_eve', await recoveryKeypair())];
  const secret = 'Familie Hein — Zahnarzt 14:30';
  for (const p of [{ by: secret, sig: b64u(new Uint8Array(64)) }, { by: 'mem_admin', sig: secret }]) {
    try {
      await verifyAdminProof(p, {
        act: 'member.remove', spaceId: SP_A, target: 'mem_x', epoch: 1, members, callerMemberId: 'mem_eve',
      });
      assert.fail('accepted');
    } catch (e) {
      assert.equal(JSON.stringify(e.extra || {}).includes('Zahnarzt'), false);
      assert.equal(JSON.stringify(e.extra || {}).includes('Hein'), false);
    }
  }
  // "not a member of this space" and "never existed" answer the SAME reason, exactly as step 6/7
  // does — and neither is worth hiding, because `GET /spaces/:id/members` already serves the
  // caller this list. What must not happen is a THIRD answer that separates the two.
  const seen = new Set();
  for (const by of ['mem_admin_typo', 'mem_zzzz']) {
    try {
      await verifyAdminProof({ by, sig: b64u(new Uint8Array(64)) }, {
        act: 'member.remove', spaceId: SP_A, target: 'mem_x', epoch: 1, members, callerMemberId: 'mem_eve',
      });
    } catch (e) { seen.add(`${e.status}:${e.extra.reason}`); }
  }
  assert.equal(seen.size, 1, [...seen].join(' | '));
});

test('auth.js imports nothing outside server/core — the ADR 005 §2 direction holds', () => {
  const src = fs.readFileSync(new URL('../../server/core/auth.js', import.meta.url), 'utf8');
  const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(specs.sort(), ['./errors.js', './router.js'],
    'the server may not reach into src/js/ — which is why the codecs are written out in auth.js');
});
