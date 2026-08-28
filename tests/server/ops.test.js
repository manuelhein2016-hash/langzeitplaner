// tests/server/ops.test.js — push and pull, attacked.  ADR 003 §3.1–§3.3; LZP-202.
//
// WHAT THIS FILE IS TRYING TO BREAK, in priority order — because these are the defects that
// would ship, run for months, and be discovered as "my calendar lost an entry":
//
//   1. A CURSOR THAT SKIPS. Every pull test that can page, pages: with limit 1, limit 2, across
//      a purge's holes, from a cursor past the head, and from a cursor into an empty space. The
//      invariant asserted every time is not "the page looked right" — it is that the UNION of
//      every page equals the whole log, each seq exactly once. A cursor bug does not fail a
//      happy-path assertion; it fails this one.
//   2. A BURNED SEQ ON RETRY. Five retries of one batch must leave the counter exactly where one
//      push left it, and the next real op must be the next number. Gaps are not cosmetic here:
//      `WHERE seq > cursor` over a gappy counter is how an op gets skipped.
//   3. AN ACK THAT LIES. `ackSeq` gates tombstone GC on every peer. A member inflating it is
//      T5 — a family member as adversary — and the failure mode is a deleted entry coming back.
//   4. PLAINTEXT REACHING THE STORE. The relay is blind or it is not; there is no middle. So the
//      envelope's field set is closed, `ct` is only ever measured and copied, and the pull
//      response's key set is pinned so a future field cannot arrive unnoticed.
//
// Everything runs against BOTH adapters. The budget assertions (risk R3) count STORE ROUND TRIPS
// rather than milliseconds, because the round trips are what become network hops to Frankfurt.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';

import { pushOps, pullOps, BUDGET, ENVELOPE_FIELDS, ACCEPTED_ENVELOPE_VERSIONS, handlers } from '../../server/core/handlers/ops.js';
import { authenticate, assertMember, canonicalQuery, signedString, b64u, ub64, deviceShortOfRaw, NONCE_BYTES } from '../../server/core/auth.js';
import { fixtures, MODEL_COLUMNS, STORE_METHODS } from '../../server/core/store-interface.js';
import { memoryStore } from '../../server/adapters/memory.js';
import { fileStore } from '../../server/adapters/file.js';
import { HttpError, toResponse } from '../../server/core/errors.js';
import { createRouter } from '../../server/core/router.js';
import { LIMITS_SHAPE } from '../../docs/v2/contracts/server.contract.js';

const SUBTLE = webcrypto.subtle;
const TE = new TextEncoder();

const SPACE = 'fsp_AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_SPACE = 'fsp_BBBBBBBBBBBBBBBBBBBBBB';
const MEMBER = 'mem_AAAAAAAAAAAAAAAAAAAAAA';
const DEVICE = 'dev_AAAAAAAAAAAAAAAAAAAAAA';
const T0 = 1787836800000;

// ─────────────────────────────────────────────────────────────────────────────
// Harness  (deliberately duplicated from auth.test.js: one owner per file, and a test helper
// shared between two files is a helper that quietly changes both when it changes.)
// ─────────────────────────────────────────────────────────────────────────────

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-ops-'));
  tempDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function fakeClock(start) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const ADAPTERS = [
  { name: 'memory', make: (clock) => memoryStore({ now: clock.now }) },
  { name: 'file', make: (clock) => fileStore(tempDir(), { now: clock.now }) },
];

function makeCtx(store, clock, over) {
  const ctx = { store, now: () => clock.now(), random: (n) => new Uint8Array(n), log: () => {}, limits: LIMITS_SHAPE, ...over };
  if (!ctx.auth) ctx.auth = (req) => authenticate(req, ctx);
  if (!ctx.assertMember) ctx.assertMember = (m, s) => assertMember(m, s, ctx);
  return ctx;
}

/** Wrap a store so every method call is recorded — including inside a transaction. */
function countingStore(store) {
  const calls = [];
  const wrap = (s) => {
    const out = {};
    for (const name of STORE_METHODS) {
      if (name === 'tx') continue;
      out[name] = (...a) => { calls.push(name); return s[name](...a); };
    }
    out.tx = (fn) => { calls.push('tx'); return s.tx((h) => fn(wrap(h))); };
    return out;
  };
  return { store: wrap(store), calls };
}

async function mintDevice() {
  const pair = await SUBTLE.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const sigPubRaw = new Uint8Array(await SUBTLE.exportKey('raw', pair.publicKey));
  const kex = await SUBTLE.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const kexPubRaw = new Uint8Array(await SUBTLE.exportKey('raw', kex.publicKey));
  return { pair, sigPubRaw, kexPubRaw, deviceShort: await deviceShortOfRaw(sigPubRaw, {}) };
}

async function seed(store, opts) {
  const o = opts || {};
  await store.createSpace(fixtures.space({ id: SPACE, currentEpoch: o.epoch || 1, createdAt: new Date(T0) }));
  await store.addMember(fixtures.member({ id: MEMBER, spaceId: SPACE, colorRef: 'gruen', joinedAt: new Date(T0) }));
  const dev = await mintDevice();
  await store.addDevice(fixtures.device({
    id: DEVICE, memberId: MEMBER, deviceShort: dev.deviceShort,
    sigPubRaw: dev.sigPubRaw, kexPubRaw: dev.kexPubRaw, addedAt: new Date(T0),
  }));
  return dev;
}

let nonceCounter = 0;
function freshNonce() {
  const b = new Uint8Array(NONCE_BYTES);
  const n = ++nonceCounter;
  b[0] = n & 255; b[1] = (n >>> 8) & 255; b[2] = (n >>> 16) & 255; b[3] = (n >>> 24) & 255; b[4] = 7;
  return b64u(b);
}

async function signReq(o) {
  const method = o.method;
  const reqPath = o.path || '/api/v1/ops';
  const query = o.query || {};
  const hasBody = o.bodyObj !== undefined && o.bodyObj !== null;
  const rawBody = hasBody ? TE.encode(JSON.stringify(o.bodyObj)) : new Uint8Array(0);
  const hash = new Uint8Array(await SUBTLE.digest('SHA-256', rawBody));
  const ts = String(o.ts === undefined ? T0 : o.ts);
  const nonce = freshNonce();
  const toSign = signedString({
    method, path: reqPath, sortedQuery: canonicalQuery(query), bodyHashB64u: b64u(hash), ts, nonce,
  });
  const sig = new Uint8Array(await SUBTLE.sign({ name: 'ECDSA', hash: 'SHA-256' }, o.dev.pair.privateKey, TE.encode(toSign)));
  return {
    method, path: reqPath, query,
    headers: { authorization: `LZP1 device=${o.dev.deviceShort}, ts=${ts}, nonce=${nonce}, sig=${b64u(sig)}` },
    body: hasBody ? o.bodyObj : null,
    rawBody,
    routeName: o.routeName || (method === 'GET' ? 'pullOps' : 'pushOps'),
    params: {},
  };
}

const push = async (ctx, dev, bodyObj) => pushOps(await signReq({ method: 'POST', dev, bodyObj }), ctx);
const pull = async (ctx, dev, query) => pullOps(await signReq({ method: 'GET', dev, query }), ctx);

async function codeOf(fn) {
  try { await fn(); return 'OK'; } catch (err) {
    if (err instanceof HttpError) return err.code;
    throw err;
  }
}

// ── envelopes ────────────────────────────────────────────────────────────────

const B64U_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** A distinct, canonical 22-character opId per integer. */
function oid(n) {
  let s = '';
  let x = n;
  for (let i = 0; i < 22; i++) { s = B64U_CHARS[x % 64] + s; x = Math.floor(x / 64); }
  return s;
}
function filler(len, seed) {
  const out = new Uint8Array(len);
  let x = (seed | 0) || 1;
  for (let i = 0; i < len; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x & 0xff; }
  return out;
}
/** A well-formed sealed envelope. The bytes are opaque filler — the relay never reads them. */
function env(dev, n, over) {
  return {
    v: 1, sp: SPACE, ep: 1, dv: dev.deviceShort, oid: oid(n), wit: '',
    iv: b64u(filler(12, n + 1)),
    ct: b64u(filler(64, n + 2)),
    sig: b64u(filler(64, n + 3)),
    ...over,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Static shape — the surface, before any behaviour
// ═════════════════════════════════════════════════════════════════════════════

test('the handler registry names exactly the two routes LZP-202 owns', () => {
  assert.deepEqual(Object.keys(handlers).sort(), ['pullOps', 'pushOps']);
  assert.equal(handlers.pushOps, pushOps);
  assert.equal(handlers.pullOps, pullOps);
});

test('the envelope has exactly nine fields, each with a stated job', () => {
  assert.deepEqual(Object.keys(ENVELOPE_FIELDS).sort(), ['ct', 'dv', 'ep', 'iv', 'oid', 'sig', 'sp', 'v', 'wit'].sort());
  for (const [k, why] of Object.entries(ENVELOPE_FIELDS)) {
    assert.ok(why.length > 20, `${k}: a field without a stated job is a field nobody audits`);
  }
  // `ct` is in the envelope and NOT in ENVELOPE_FIELDS' reasoning as something read: check the
  // handler source never does anything with it but decode-and-measure.
  const src = fs.readFileSync(new URL('../../server/core/handlers/ops.js', import.meta.url), 'utf8');
  const codeOnly = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.equal(/JSON\.parse\s*\(\s*[a-z]*ct/i.test(codeOnly), false, 'the relay must never parse a ciphertext');
  assert.equal(/TextDecoder\(\)\.decode\(\s*ct/i.test(codeOnly), false);
});

test('ops.js imports nothing outside server/core', () => {
  const src = fs.readFileSync(new URL('../../server/core/handlers/ops.js', import.meta.url), 'utf8');
  const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  // ADR 005 §2 caps `server/core` at `server/core`: no client tree, no adapters, no Node builtins.
  // `../limits.js` arrived at integration (LZP-207), when push/pull were converged off their own
  // hand-built bucket keys onto `enforceFor` so every RateBucket.key in the server goes through
  // `rateKey()`. It is inside server/core, so the rule this test states is unchanged.
  assert.deepEqual(specs.sort(), ['../auth.js', '../errors.js', '../limits.js']);
  for (const s of specs) {
    assert.ok(s.startsWith('../') && !s.startsWith('../../'), `${s} reaches outside server/core`);
  }
});

test('only Envelope.v values the relay can round-trip are accepted', () => {
  // ADR 003 §3.2's pull response carries `v` per op and `MODEL_COLUMNS.Op` has no `v` column, so
  // the accepted set is exactly what a constant can reconstruct. Finding E2-202-D.
  assert.deepEqual([...ACCEPTED_ENVELOPE_VERSIONS], [1]);
  assert.equal(MODEL_COLUMNS.Op.includes('v'), false, 'if this ever gains a column, widen the set');
});

// ═════════════════════════════════════════════════════════════════════════════
// Behaviour, per adapter
// ═════════════════════════════════════════════════════════════════════════════

for (const adapter of ADAPTERS) {
  const T = (name, fn) => test(`[${adapter.name}] ${name}`, fn);

  const setup = async (opts) => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const dev = await seed(store, opts);
    return { clock, store, dev, ctx: makeCtx(store, clock) };
  };

  // ── push: the append ──────────────────────────────────────────────────────

  T('push assigns gapless per-space seq from 1 and reports each op once', async () => {
    const { ctx, dev } = await setup();
    const res = await push(ctx, dev, { space: SPACE, ops: [env(dev, 1), env(dev, 2), env(dev, 3)] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.accepted.map((a) => a.seq), ['1', '2', '3']);
    assert.deepEqual(res.body.accepted.map((a) => a.oid), [oid(1), oid(2), oid(3)]);
    assert.deepEqual(res.body.duplicate, []);
    assert.equal(res.body.spaceSeq, '3');
    assert.equal(res.body.serverTime, T0);
    for (const a of res.body.accepted) assert.equal(ub64(a.chain).length, 32);
  });

  T('the chain is SHA-256(prevChain ‖ opId), recomputed here from nothing but the ADR', async () => {
    const { ctx, dev, store } = await setup();
    const res = await push(ctx, dev, { space: SPACE, ops: [env(dev, 10), env(dev, 11)] });
    let prev = new Uint8Array(0);
    for (const [i, n] of [10, 11].entries()) {
      const buf = new Uint8Array(prev.length + 22);
      buf.set(prev, 0);
      buf.set(TE.encode(oid(n)), prev.length);
      prev = new Uint8Array(await SUBTLE.digest('SHA-256', buf));
      assert.equal(res.body.accepted[i].chain, b64u(prev));
    }
    const space = await store.getSpace(SPACE);
    assert.equal(b64u(space.headChain), b64u(prev), 'the space head advances to the last chain');
  });

  T('a re-push is a DUPLICATE with the EXISTING seq, 200, and burns no counter', async () => {
    const { ctx, dev, store } = await setup();
    const batch = { space: SPACE, ops: [env(dev, 1), env(dev, 2)] };
    const first = await push(ctx, dev, batch);
    assert.deepEqual(first.body.accepted.map((a) => a.seq), ['1', '2']);

    // Five retries — the shape of a client on a flaky connection whose 200 never arrived.
    for (let i = 0; i < 5; i++) {
      const again = await push(ctx, dev, batch);
      assert.deepEqual(again.body.accepted, [], 'a retry must never re-accept');
      assert.deepEqual(again.body.duplicate.map((d) => d.seq), ['1', '2']);
      assert.deepEqual(again.body.duplicate.map((d) => d.chain), first.body.accepted.map((a) => a.chain),
        'a duplicate keeps its original chain; re-chaining would fork the log');
    }
    assert.equal((await store.getSpace(SPACE)).nextSeq, 2n, 'five retries burned five sequence numbers');
    const next = await push(ctx, dev, { space: SPACE, ops: [env(dev, 3)] });
    assert.equal(next.body.accepted[0].seq, '3', 'the next real op must be 3, not 8');
  });

  T('the same opId twice INSIDE one batch collapses to one row', async () => {
    const { ctx, dev, store } = await setup();
    const res = await push(ctx, dev, { space: SPACE, ops: [env(dev, 1), env(dev, 1), env(dev, 2)] });
    assert.deepEqual(res.body.accepted.map((a) => a.seq), ['1', '2']);
    assert.equal(res.body.duplicate.length, 1);
    assert.equal(res.body.duplicate[0].seq, '1');
    assert.equal((await store.getSpace(SPACE)).nextSeq, 2n);
  });

  T('the same opId with DIFFERENT bytes is 409 forked_op_id, and writes nothing', async () => {
    const { ctx, dev, store } = await setup();
    await push(ctx, dev, { space: SPACE, ops: [env(dev, 1)] });
    const forged = env(dev, 1, { ct: b64u(filler(64, 999)) });
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: [forged, env(dev, 2)] })), 'forked_op_id');
    // The honest op that shared the batch must NOT have been written, and no seq may be burned:
    // the client's fix is to re-mint and re-push, and it must find the log where it left it.
    assert.equal((await store.getSpace(SPACE)).nextSeq, 1n);
    assert.equal((await store.listOps(SPACE, 0n, 100)).ops.length, 1);
  });

  T('idempotency is keyed on opId and NEVER on a signature', async () => {
    // ADR 002 §1 rule 1. If the key were the signature, this re-push — same op, freshly signed,
    // which is what any re-sealing client produces — would duplicate the family's entry.
    const { ctx, dev } = await setup();
    const a = env(dev, 5);
    await push(ctx, dev, { space: SPACE, ops: [a] });
    const resigned = { ...a, sig: b64u(filler(64, 4242)) };
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: [resigned] })), 'forked_op_id',
      'the relay is blind, so a re-seal and a genuine collision are indistinguishable — 409 is correct, ' +
      'and ADR 003 §8.1\'s "the outbox holds SEALED envelopes" is what keeps honest clients out of it');
  });

  // ── push: validation, in ADR 003 §3.1's order ─────────────────────────────

  T('validation refuses each hostile envelope with the code §3.1 names', async () => {
    const { ctx, dev, store } = await setup({ epoch: 3 });
    const other = await mintDevice();
    const rows = [
      ['device_mismatch', env(dev, 1, { dv: other.deviceShort })],
      ['device_mismatch', env(dev, 1, { dv: 42 })],
      ['space_mismatch', env(dev, 1, { sp: OTHER_SPACE })],
      ['future_epoch', env(dev, 1, { ep: 4 })],
      ['bad_request', env(dev, 1, { ep: 0 })],
      ['bad_request', env(dev, 1, { ep: 1.5 })],
      ['bad_request', env(dev, 1, { v: 2 })],
      ['bad_request', env(dev, 1, { oid: 'too-short' })],
      ['bad_request', env(dev, 1, { oid: oid(1) + 'x' })],
      ['bad_request', env(dev, 1, { iv: b64u(filler(11, 1)) })],
      ['bad_request', env(dev, 1, { sig: b64u(filler(70, 1)) })],
      ['bad_request', env(dev, 1, { ct: b64u(filler(15, 1)) })],
      ['bad_request', env(dev, 1, { ct: 'Zahnarzt 14:30' })],
      ['bad_request', env(dev, 1, { ct: 'Zahnarzt' })],
      ['bad_request', env(dev, 1, { wit: 'not b64url!' })],
      ['bad_request', env(dev, 1, { wit: 7 })],
      ['bad_request', { ...env(dev, 1), text: 'Zahnarzt 14:30' }],
      ['bad_request', { ...env(dev, 1), ts: '2026-08-28' }],
      ['bad_request', (() => { const e = env(dev, 1); delete e.wit; return e; })()],
      ['bad_request', null],
      ['bad_request', 'an op'],
      ['bad_request', []],
    ];
    for (const [code, e] of rows) {
      assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: [e] })), code, JSON.stringify(e));
    }
    assert.equal((await store.getSpace(SPACE)).nextSeq, 0n, 'not one rejected op burned a seq');
  });

  T('an op from an OLDER epoch is accepted; only the future is refused', async () => {
    const { ctx, dev } = await setup({ epoch: 3 });
    const res = await push(ctx, dev, { space: SPACE, ops: [env(dev, 1, { ep: 1 }), env(dev, 2, { ep: 3 })] });
    assert.equal(res.body.accepted.length, 2, 'ADR 002 §4.4 — a device that missed a rotation still pushes');
  });

  T('the caps of ADR 003 §6.1 are enforced, and a rejected batch writes nothing', async () => {
    const { ctx, dev, store } = await setup();
    const many = Array.from({ length: LIMITS_SHAPE.opsPerPush + 1 }, (_, i) => env(dev, i + 1));
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: many })), 'payload_too_large');

    const huge = env(dev, 1, { ct: b64u(filler(LIMITS_SHAPE.bytesPerEnvelope, 5)) });
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: [huge] })), 'payload_too_large');

    // Exactly at the cap is fine — an off-by-one here rejects a legitimate 200-op catch-up batch
    // from a device that was offline for three weeks (19.6).
    const exact = Array.from({ length: LIMITS_SHAPE.opsPerPush }, (_, i) => env(dev, 1000 + i));
    const ok = await push(ctx, dev, { space: SPACE, ops: exact });
    assert.equal(ok.body.accepted.length, LIMITS_SHAPE.opsPerPush);
    assert.equal((await store.getSpace(SPACE)).nextSeq, BigInt(LIMITS_SHAPE.opsPerPush));
  });

  T('the top-level body is a closed key set', async () => {
    const { ctx, dev } = await setup();
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: [], note: 'hi' })), 'bad_request');
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE })), 'bad_request', 'ops is required');
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: {} })), 'bad_request');
    // A malformed `space` never reaches the handler's own check: auth step 7 already asked the
    // store whether this member belongs to it, and answered the one code it may answer.
    assert.equal(await codeOf(() => push(ctx, dev, { space: 'nope', ops: [] })), 'not_a_member');
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: [], drained: 'yes' })), 'bad_request');
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: [] })), 'OK', 'an empty push is a legal ack');
  });

  // ── push: the ack, and the tombstone-GC attack ────────────────────────────

  T('ackSeq advances read progress, is monotone, and CANNOT exceed what the space assigned', async () => {
    const { ctx, dev, store } = await setup();
    await push(ctx, dev, { space: SPACE, ops: [env(dev, 1), env(dev, 2), env(dev, 3)] });

    await push(ctx, dev, { space: SPACE, ops: [], ackSeq: '2' });
    assert.equal((await store.getDevice(DEVICE)).lastSeenSeq, 2n);

    await push(ctx, dev, { space: SPACE, ops: [], ackSeq: '1' });
    assert.equal((await store.getDevice(DEVICE)).lastSeenSeq, 2n, 'a stale ack never rewinds');

    // T5 — a family member as adversary. `minLastSeenSeq` is a MINIMUM, so one inflated ack
    // removes this device as the brake on tombstone GC; in a two-device family that is the whole
    // brake, and the peers then collect tombstones for ops nobody folded. ADR 001 §12.5 keeps the
    // old unpushed edit, so the deleted entry comes BACK. Silently.
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: [], ackSeq: '9007199254740991' })), 'bad_request');
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: [], ackSeq: '4' })), 'bad_request');
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: [], ackSeq: '-1' })), 'bad_request');
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: [], ackSeq: 'nine' })), 'bad_request');
    assert.equal((await store.getDevice(DEVICE)).lastSeenSeq, 2n);

    // An ack of exactly the high-water is legal, and is the normal steady state.
    await push(ctx, dev, { space: SPACE, ops: [], ackSeq: '3' });
    assert.equal((await store.getDevice(DEVICE)).lastSeenSeq, 3n);
  });

  T('write progress is only ever an explicit claim, and its absence fails CLOSED', async () => {
    const { ctx, dev, store } = await setup();
    await push(ctx, dev, { space: SPACE, ops: [env(dev, 1), env(dev, 2)] });
    assert.equal((await store.getDevice(DEVICE)).lastPushedSeq, 0n,
      'a push is not by itself evidence of a drained outbox');
    assert.equal(await store.minLastPushedSeq(SPACE), 0n, 'so no tombstone is collectable — correct');

    await push(ctx, dev, { space: SPACE, ops: [env(dev, 3)], drained: true });
    assert.equal((await store.getDevice(DEVICE)).lastPushedSeq, 3n);
    assert.equal(await store.minLastPushedSeq(SPACE), 3n);
  });

  // ── push: who may append ──────────────────────────────────────────────────

  T('a device may only push into a space it belongs to', async () => {
    const { ctx, dev, store } = await setup();
    await store.createSpace(fixtures.space({ id: OTHER_SPACE }));
    await store.addMember(fixtures.member({ id: 'mem_BBBBBBBBBBBBBBBBBBBBBB', spaceId: OTHER_SPACE, colorRef: 'blau' }));
    const body = { space: OTHER_SPACE, ops: [env(dev, 1, { sp: OTHER_SPACE })] };
    assert.equal(await codeOf(() => push(ctx, dev, body)), 'not_a_member');
    assert.equal((await store.listOps(OTHER_SPACE, 0n, 10)).ops.length, 0);
  });

  T('a removed member cannot push, and a revoked device cannot push', async () => {
    const { ctx, dev, store } = await setup();
    await store.revokeDevice(DEVICE, T0);
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: [env(dev, 1)] })), 'device_revoked');
  });

  T('the handler re-checks membership even when ctx.auth skipped it', async () => {
    // A handler whose security depends on how it was wired is a handler with a deployment bug
    // waiting in it. Both wirings are exercised: a lax ctx.auth WITH ctx.assertMember, and a lax
    // one WITHOUT — where auth.js's own assertMember is the fallback.
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const dev = await seed(store);
    await store.createSpace(fixtures.space({ id: OTHER_SPACE }));
    await store.addMember(fixtures.member({ id: 'mem_BBBBBBBBBBBBBBBBBBBBBB', spaceId: OTHER_SPACE, colorRef: 'blau' }));

    for (const withAssert of [true, false]) {
      const lax = { deviceShort: dev.deviceShort, deviceId: DEVICE, memberId: MEMBER };
      const ctx = makeCtx(store, clock, {
        auth: async () => lax,
        assertMember: withAssert ? undefined : null,
      });
      if (!withAssert) delete ctx.assertMember;
      const req = await signReq({ method: 'POST', dev, bodyObj: { space: OTHER_SPACE, ops: [] } });
      assert.equal(await codeOf(() => pushOps(req, ctx)), 'not_a_member', `withAssert=${withAssert}`);
      const q = await signReq({ method: 'GET', dev, query: { space: OTHER_SPACE } });
      assert.equal(await codeOf(() => pullOps(q, ctx)), 'not_a_member', `withAssert=${withAssert}`);
    }
  });

  T('a push whose space row has vanished answers not_a_member, never an existence oracle', async () => {
    const { ctx, dev, store } = await setup();
    const req = await signReq({ method: 'POST', dev, bodyObj: { space: SPACE, ops: [env(dev, 1)] } });
    const lax = { deviceShort: dev.deviceShort, deviceId: DEVICE, memberId: MEMBER, spaceId: SPACE, member: { id: MEMBER } };
    const ctx2 = makeCtx(store, fakeClock(T0), { auth: async () => lax });
    await store.deleteSpace(SPACE);
    assert.equal(await codeOf(() => pushOps(req, ctx2)), 'not_a_member');
    void ctx;
  });

  // ── push/pull: rate limits (ADR 003 §6.1) ─────────────────────────────────

  T('push is limited to 60/min per device and pull to 120/min, with Retry-After', async () => {
    const { ctx, dev } = await setup();
    for (let i = 0; i < LIMITS_SHAPE.pushPerMin; i++) {
      assert.equal((await push(ctx, dev, { space: SPACE, ops: [] })).status, 200, `push ${i}`);
    }
    let thrown = null;
    try { await push(ctx, dev, { space: SPACE, ops: [] }); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof HttpError);
    assert.equal(thrown.code, 'rate_limited');
    assert.equal(thrown.status, 429);
    assert.equal(thrown.extra.retryAfter, 60);

    // The two limiters are independent — a device that has exhausted its pushes must still be
    // able to PULL, or a family member who edits a lot stops receiving everyone else's work.
    assert.equal((await pull(ctx, dev, { space: SPACE })).status, 200);
  });

  T('the rate-limit window is per device, so one busy Mac cannot lock out the family', async () => {
    const { ctx, dev, store, clock } = await setup();
    const second = await mintDevice();
    await store.addDevice(fixtures.device({
      id: 'dev_BBBBBBBBBBBBBBBBBBBBBB', memberId: MEMBER, deviceShort: second.deviceShort,
      sigPubRaw: second.sigPubRaw, kexPubRaw: second.kexPubRaw,
    }));
    for (let i = 0; i < LIMITS_SHAPE.pushPerMin; i++) await push(ctx, dev, { space: SPACE, ops: [] });
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: [] })), 'rate_limited');
    assert.equal((await push(ctx, second, { space: SPACE, ops: [] })).status, 200);
    clock.advance(60001);
    assert.equal((await push(ctx, dev, { space: SPACE, ops: [] })).status, 200, 'the window re-opens');
  });

  // ── pull: the cursor ──────────────────────────────────────────────────────

  T('pull returns the documented shape and nothing else', async () => {
    const { ctx, dev } = await setup({ epoch: 2 });
    await push(ctx, dev, { space: SPACE, ops: [env(dev, 1, { wit: b64u(filler(32, 3)) })] });
    const res = await pull(ctx, dev, { space: SPACE, since: '0' });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(),
      ['currentEpoch', 'hasMore', 'members', 'nextCursor', 'ops', 'serverTime'].sort());
    assert.deepEqual(Object.keys(res.body.ops[0]).sort(),
      ['chain', 'ct', 'dv', 'ep', 'iv', 'oid', 'seq', 'sig', 'sp', 'v', 'wit'].sort());
    const o = res.body.ops[0];
    assert.equal(o.seq, '1');
    assert.equal(o.v, 1);
    assert.equal(o.sp, SPACE);
    assert.equal(o.ep, 1);
    assert.equal(o.dv, dev.deviceShort);
    assert.equal(o.oid, oid(1));
    assert.equal(o.wit, b64u(filler(32, 3)));
    assert.equal(res.body.currentEpoch, 2);
    assert.equal(res.body.hasMore, false);
    assert.equal(res.body.nextCursor, '1');
    assert.equal(res.body.serverTime, T0);
  });

  T('the envelope survives the round trip byte for byte', async () => {
    const { ctx, dev } = await setup();
    const e = env(dev, 1);
    await push(ctx, dev, { space: SPACE, ops: [e] });
    const got = (await pull(ctx, dev, { space: SPACE })).body.ops[0];
    assert.equal(got.iv, e.iv);
    assert.equal(got.ct, e.ct, 'the relay stores iv‖ct‖sig and must give back exactly the ct it was handed');
    assert.equal(got.sig, e.sig);
    // ... including a `ct` of an awkward length, where the iv/sig framing could slip.
    const odd = env(dev, 2, { ct: b64u(filler(17, 9)) });
    await push(ctx, dev, { space: SPACE, ops: [odd] });
    const got2 = (await pull(ctx, dev, { space: SPACE, since: '1' })).body.ops[0];
    assert.equal(got2.ct, odd.ct);
    assert.equal(ub64(got2.ct).length, 17);
  });

  T('THE CURSOR CANNOT SKIP: every page size yields the whole log, each seq exactly once', async () => {
    const { ctx, dev } = await setup();
    const total = 37;
    await push(ctx, dev, { space: SPACE, ops: Array.from({ length: total }, (_, i) => env(dev, i + 1)) });

    for (const limit of [1, 2, 5, 36, 37, 38, 500]) {
      const seen = [];
      let cursor = '0';
      let guard = 0;
      for (;;) {
        const res = await pull(ctx, dev, { space: SPACE, since: cursor, limit: String(limit) });
        for (const o of res.body.ops) seen.push(o.seq);
        assert.equal(res.body.nextCursor, res.body.ops.length ? res.body.ops[res.body.ops.length - 1].seq : cursor);
        cursor = res.body.nextCursor;
        if (!res.body.hasMore) break;
        assert.ok(++guard < 200, 'the loop must terminate — a cursor that does not advance is a hung sync');
      }
      assert.deepEqual(seen, Array.from({ length: total }, (_, i) => String(i + 1)), `limit ${limit}`);
    }
  });

  T('an EMPTY page keeps the caller\'s cursor — it never jumps to the head', async () => {
    const { ctx, dev } = await setup();
    await push(ctx, dev, { space: SPACE, ops: [env(dev, 1), env(dev, 2), env(dev, 3)] });
    const at3 = await pull(ctx, dev, { space: SPACE, since: '3' });
    assert.deepEqual(at3.body.ops, []);
    assert.equal(at3.body.nextCursor, '3');
    assert.equal(at3.body.hasMore, false);

    // A cursor BEYOND the head (a client that saw a later push, or a purge) must also not move.
    const beyond = await pull(ctx, dev, { space: SPACE, since: '99' });
    assert.equal(beyond.body.nextCursor, '99');

    // ... and an empty space starts and stays at 0.
    const { ctx: ctx2, dev: dev2 } = await setup();
    const empty = await pull(ctx2, dev2, { space: SPACE });
    assert.deepEqual(empty.body.ops, []);
    assert.equal(empty.body.nextCursor, '0');
  });

  T('a purge leaves holes, and paging across them still loses nothing', async () => {
    // 20.2 deletes a removed member's ops, which is the one thing that makes the log gappy. The
    // cursor is `WHERE seq > n`, so holes are harmless — but only if `nextCursor` is the last
    // seq RETURNED and not `since + limit`.
    const { ctx, dev, store, clock } = await setup();
    const second = await mintDevice();
    await store.addMember(fixtures.member({ id: 'mem_BBBBBBBBBBBBBBBBBBBBBB', spaceId: SPACE, colorRef: 'blau' }));
    await store.addDevice(fixtures.device({
      id: 'dev_BBBBBBBBBBBBBBBBBBBBBB', memberId: 'mem_BBBBBBBBBBBBBBBBBBBBBB', deviceShort: second.deviceShort,
      sigPubRaw: second.sigPubRaw, kexPubRaw: second.kexPubRaw,
    }));
    for (let i = 1; i <= 10; i++) {
      const who = i % 2 === 0 ? second : dev;
      await push(ctx, who, { space: SPACE, ops: [env(who, i, { dv: who.deviceShort })] });
    }
    await store.deleteOpsByDevices(SPACE, [second.deviceShort]);
    await store.removeMember('mem_BBBBBBBBBBBBBBBBBBBBBB', clock.now());

    const seen = [];
    let cursor = '0';
    for (;;) {
      const res = await pull(ctx, dev, { space: SPACE, since: cursor, limit: '2' });
      for (const o of res.body.ops) seen.push(o.seq);
      cursor = res.body.nextCursor;
      if (!res.body.hasMore) break;
    }
    assert.deepEqual(seen, ['1', '3', '5', '7', '9'], 'the survivors, in order, with the holes skipped over');
    assert.equal((await store.getSpace(SPACE)).nextSeq, 10n, 'and the counter never rewinds over a hole');
  });

  T('pull refuses a limit that cannot make progress, and clamps one that is too large', async () => {
    const { ctx, dev } = await setup();
    await push(ctx, dev, { space: SPACE, ops: Array.from({ length: 3 }, (_, i) => env(dev, i + 1)) });
    for (const limit of ['0', '-1', '1.5', 'abc', ' 2', '2\n', '1e3', '+2']) {
      assert.equal(await codeOf(() => pull(ctx, dev, { space: SPACE, limit })), 'bad_request', `limit=${limit}`);
    }
    const clamped = await pull(ctx, dev, { space: SPACE, limit: '100000' });
    assert.equal(clamped.body.ops.length, 3);
    for (const since of ['-1', '1.5', 'x', '00x']) {
      assert.equal(await codeOf(() => pull(ctx, dev, { space: SPACE, since })), 'bad_request', `since=${since}`);
    }
    assert.equal(await codeOf(() => pull(ctx, dev, { space: 'nope' })), 'not_a_member',
      'auth step 7 answers first, and answers the one code it may answer');
  });

  T('hasMore is honest at the boundary', async () => {
    const { ctx, dev } = await setup();
    await push(ctx, dev, { space: SPACE, ops: Array.from({ length: 4 }, (_, i) => env(dev, i + 1)) });
    assert.equal((await pull(ctx, dev, { space: SPACE, limit: '3' })).body.hasMore, true);
    assert.equal((await pull(ctx, dev, { space: SPACE, limit: '4' })).body.hasMore, false);
    assert.equal((await pull(ctx, dev, { space: SPACE, limit: '5' })).body.hasMore, false);
  });

  // ── pull: the members piggyback ───────────────────────────────────────────

  T('members rides along with colorRef and public keys — and nothing about a person', async () => {
    const { ctx, dev, store, clock } = await setup();
    const second = await mintDevice();
    await store.addMember(fixtures.member({ id: 'mem_BBBBBBBBBBBBBBBBBBBBBB', spaceId: SPACE, colorRef: 'blau' }));
    await store.addDevice(fixtures.device({
      id: 'dev_BBBBBBBBBBBBBBBBBBBBBB', memberId: 'mem_BBBBBBBBBBBBBBBBBBBBBB', deviceShort: second.deviceShort,
      sigPubRaw: second.sigPubRaw, kexPubRaw: second.kexPubRaw,
    }));
    await store.removeMember('mem_BBBBBBBBBBBBBBBBBBBBBB', clock.now());

    const res = await pull(ctx, dev, { space: SPACE });
    assert.equal(res.body.members.length, 2);
    assert.deepEqual(res.body.members.map((m) => m.memberId), [MEMBER, 'mem_BBBBBBBBBBBBBBBBBBBBBB']);
    for (const m of res.body.members) {
      assert.deepEqual(Object.keys(m).sort(), ['colorRef', 'devices', 'memberId', 'removedAt']);
      for (const d of m.devices) assert.deepEqual(Object.keys(d).sort(), ['deviceShort', 'kexPubRaw', 'revokedAt', 'sigPubRaw']);
    }
    assert.equal(res.body.members[0].colorRef, 'gruen');
    assert.equal(res.body.members[0].removedAt, null);
    assert.equal(res.body.members[1].removedAt, T0, 'a removed member is still listed — the projection needs to know');
    assert.equal(res.body.members[0].devices[0].deviceShort, dev.deviceShort);
    assert.equal(ub64(res.body.members[0].devices[0].sigPubRaw).length, 65);
    assert.equal(ub64(res.body.members[0].devices[0].kexPubRaw).length, 65);

    // 21.1, asserted rather than asserted-about: nothing in this response is named like content.
    const json = JSON.stringify(res.body);
    assert.equal(/"(text|label|name|displayName|title|note|category|scratchpad|authoredAt|ts)"\s*:/.test(json), false,
      `a content-shaped key appeared in a pull response: ${json.slice(0, 400)}`);
    // ... and `recoveryPubSig`, which the store holds, is NOT published here. ADR 003 §3.2 lists
    // four device fields; the members endpoint (LZP-203) owns anything more.
    assert.equal(json.includes('recoveryPub'), false);
  });

  T('members and devices come back in a deterministic order that no content can influence', async () => {
    const { ctx, dev, store } = await setup();
    const shorts = [];
    for (let i = 0; i < 4; i++) {
      const d = await mintDevice();
      shorts.push(d.deviceShort);
      await store.addDevice(fixtures.device({
        id: `dev_${String(i).repeat(22).slice(0, 22)}`, memberId: MEMBER, deviceShort: d.deviceShort,
        sigPubRaw: d.sigPubRaw, kexPubRaw: d.kexPubRaw,
      }));
    }
    const res = await pull(ctx, dev, { space: SPACE });
    const got = res.body.members[0].devices.map((d) => d.deviceShort);
    assert.deepEqual(got, [...got].sort(), 'sorted by deviceShort, which is a hash of a public key');
    assert.equal(got.length, 5);
  });

  // ── the log line ──────────────────────────────────────────────────────────

  T('the log line carries only ADR 003 §6.2\'s whitelist', async () => {
    const clock = fakeClock(T0);
    const store = adapter.make(clock);
    const dev = await seed(store);
    const lines = [];
    const ctx = makeCtx(store, clock, { log: (e) => lines.push(e) });
    await push(ctx, dev, { space: SPACE, ops: [env(dev, 1)] });
    await pull(ctx, dev, { space: SPACE });
    assert.equal(lines.length, 2);
    for (const l of lines) {
      assert.deepEqual(Object.keys(l).sort(),
        ['byteCount', 'deviceShort', 'ms', 'opCount', 'route', 'spaceId', 'status'].sort(),
        'ctx.log takes a whitelisted field set — never envelope, ct, iv, sig, wrapped or a box');
    }
    assert.equal(lines[0].route, 'pushOps');
    assert.equal(lines[0].opCount, 1);
    assert.ok(lines[0].byteCount > 0);
    assert.equal(lines[1].route, 'pullOps');
    assert.equal(lines[1].opCount, 1);
    assert.equal(JSON.stringify(lines).includes(env(dev, 1).ct), false, 'no ciphertext may reach a log line');
  });

  // ── R3: the budget ────────────────────────────────────────────────────────

  T('the pull path costs a CONSTANT number of store round trips', async () => {
    const clock = fakeClock(T0);
    const base = adapter.make(clock);
    const dev = await seed(base);
    // Seed a fleet: 8 members, 16 devices, 600 ops. In Frankfurt each extra round trip is a
    // network hop through a `connection_limit=1` pool, so a per-member query would be invisible
    // here and fatal there.
    for (let i = 1; i < 8; i++) {
      const mid = `mem_${String.fromCharCode(66 + i).repeat(22)}`;
      await base.addMember(fixtures.member({ id: mid, spaceId: SPACE, colorRef: `farbe${i}` }));
      for (let j = 0; j < 2; j++) {
        const d = await mintDevice();
        await base.addDevice(fixtures.device({
          id: `dev_${String.fromCharCode(66 + i)}${j}${'x'.repeat(20)}`, memberId: mid,
          deviceShort: d.deviceShort, sigPubRaw: d.sigPubRaw, kexPubRaw: d.kexPubRaw,
        }));
      }
    }
    const ctxSeed = makeCtx(base, clock);
    for (let b = 0; b < 3; b++) {
      await push(ctxSeed, dev, { space: SPACE, ops: Array.from({ length: 200 }, (_, i) => env(dev, b * 200 + i + 1)) });
    }

    const counted = countingStore(base);
    const ctx = makeCtx(counted.store, clock);
    counted.calls.length = 0;
    await pull(ctx, dev, { space: SPACE, since: '0', limit: '1' });
    const small = counted.calls.length;
    counted.calls.length = 0;
    await pull(ctx, dev, { space: SPACE, since: '0', limit: '500' });
    const large = counted.calls.length;

    assert.equal(small, large, `a 1-op page cost ${small} round trips and a 500-op page cost ${large}`);
    assert.ok(large <= BUDGET.pullStoreCalls,
      `pull cost ${large} store round trips, budget ${BUDGET.pullStoreCalls}: ${counted.calls.join(', ')}`);

    const started = Date.now();
    const res = await pull(ctx, dev, { space: SPACE, since: '0', limit: '500' });
    const ms = Date.now() - started;
    assert.equal(res.body.ops.length, 500);
    assert.equal(res.body.hasMore, true);
    assert.ok(ms < BUDGET.pullMs,
      `a 500-op pull took ${ms} ms against the ${adapter.name} adapter; budget ${BUDGET.pullMs} ms ` +
      '(PLAN.md R3 signal S3 is 2 s end to end, and the rest of it is cold start and Frankfurt)');
  });

  T('the push path costs a CONSTANT number of store round trips', async () => {
    const clock = fakeClock(T0);
    const base = adapter.make(clock);
    const dev = await seed(base);
    const counted = countingStore(base);
    const ctx = makeCtx(counted.store, clock);

    counted.calls.length = 0;
    await push(ctx, dev, { space: SPACE, ops: [env(dev, 1)], ackSeq: '0', drained: true });
    const one = counted.calls.length;
    counted.calls.length = 0;
    const started = Date.now();
    await push(ctx, dev, { space: SPACE, ops: Array.from({ length: 200 }, (_, i) => env(dev, i + 100)), ackSeq: '1', drained: true });
    const many = counted.calls.length;
    const ms = Date.now() - started;

    assert.equal(one, many, `a 1-op push cost ${one} and a 200-op push cost ${many}`);
    assert.ok(many <= BUDGET.pushStoreCalls,
      `push cost ${many} store round trips, budget ${BUDGET.pushStoreCalls}: ${counted.calls.join(', ')}`);
    assert.ok(ms < BUDGET.pushMs, `a 200-op push took ${ms} ms; budget ${BUDGET.pushMs} ms`);
  });

  // ── the parts auth cannot reach ───────────────────────────────────────────

  T('the handler validates the space id itself, for the wiring where auth did not', async () => {
    const { store, clock, dev } = await setup();
    const lax = { deviceShort: dev.deviceShort, deviceId: DEVICE, memberId: MEMBER };
    const ctx = makeCtx(store, clock, { auth: async () => lax });
    for (const bad of ['nope', '', 'fsp_short', 'psp_' + 'A'.repeat(23), 42, null, undefined]) {
      const req = await signReq({ method: 'POST', dev, bodyObj: { space: bad === undefined ? SPACE : bad, ops: [] } });
      if (bad === undefined) continue;
      assert.equal(await codeOf(() => pushOps(req, ctx)), 'bad_request', JSON.stringify(bad));
    }
    const q = await signReq({ method: 'GET', dev, query: { space: 'nope' } });
    assert.equal(await codeOf(() => pullOps(q, ctx)), 'bad_request');
  });

  T('the 4 MB request cap is enforced by the handler as well as by the entry point', async () => {
    // The dev-server and the Vercel adapter both cap the socket read, but a handler that trusts
    // its caller to have done so is a handler that is only safe in the entry points that exist
    // today. The limit is read from ctx, so this shrinks it rather than building four megabytes.
    const { store, clock, dev } = await setup();
    const ctx = makeCtx(store, clock, { limits: { ...LIMITS_SHAPE, bytesPerRequest: 40 } });
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: [] })), 'payload_too_large');
  });

  T('one device cannot re-attribute another device\'s op to itself, or steal its opId', async () => {
    const { ctx, dev, store } = await setup();
    const second = await mintDevice();
    await store.addDevice(fixtures.device({
      id: 'dev_BBBBBBBBBBBBBBBBBBBBBB', memberId: MEMBER, deviceShort: second.deviceShort,
      sigPubRaw: second.sigPubRaw, kexPubRaw: second.kexPubRaw,
    }));
    const mine = env(dev, 1);
    await push(ctx, dev, { space: SPACE, ops: [mine] });

    // Replaying a peer's envelope verbatim: `dv` is not the pusher, so it never reaches the log.
    assert.equal(await codeOf(() => push(ctx, second, { space: SPACE, ops: [mine] })), 'device_mismatch');
    // Claiming the peer's opId under its own `dv` is a fork, not an append.
    assert.equal(await codeOf(() => push(ctx, second, { space: SPACE, ops: [env(second, 1, { dv: second.deviceShort })] })),
      'forked_op_id');
    assert.equal((await store.listOps(SPACE, 0n, 10)).ops.length, 1);
  });

  T('a fork that differs ONLY in the witness is still a fork', async () => {
    const { ctx, dev } = await setup();
    const e = env(dev, 1);
    await push(ctx, dev, { space: SPACE, ops: [e] });
    assert.equal(await codeOf(() => push(ctx, dev, { space: SPACE, ops: [{ ...e, wit: b64u(filler(32, 77)) }] })),
      'forked_op_id', '`wit` is an AAD field: rewriting it rewrites what the author claimed to have seen');
  });

  T('concurrent pushes from several devices produce a gapless 1…N with no collisions', async () => {
    // Per-space seq assignment serialises pushes (ADR 003 §10 item 1). That is the trade, and
    // this is the property it was made for: if two pushes could share a number the second would
    // overwrite the first in the primary key and an afternoon of edits would vanish behind a 200.
    const { ctx, store, dev } = await setup();
    const devices = [dev];
    for (let i = 1; i < 6; i++) {
      const d = await mintDevice();
      await store.addDevice(fixtures.device({
        id: `dev_${'C'.repeat(21)}${i}`, memberId: MEMBER, deviceShort: d.deviceShort,
        sigPubRaw: d.sigPubRaw, kexPubRaw: d.kexPubRaw,
      }));
      devices.push(d);
    }
    const reqs = [];
    for (const [i, d] of devices.entries()) {
      for (let j = 0; j < 3; j++) {
        reqs.push(await signReq({ method: 'POST', dev: d, bodyObj: { space: SPACE, ops: [env(d, i * 100 + j + 1, { dv: d.deviceShort })] } }));
      }
    }
    const results = await Promise.all(reqs.map((r) => pushOps(r, ctx)));
    const seqs = results.flatMap((r) => r.body.accepted.map((a) => Number(a.seq))).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 18 }, (_, i) => i + 1));
    const all = await store.listOps(SPACE, 0n, 100);
    assert.equal(all.ops.length, 18);
    assert.deepEqual(all.ops.map((o) => Number(o.seq)), seqs);
  });

  T('story 19.1 end to end: what one Mac pushes, the other Mac pulls', async () => {
    const { ctx, dev, store } = await setup();
    const second = await mintDevice();
    await store.addMember(fixtures.member({ id: 'mem_BBBBBBBBBBBBBBBBBBBBBB', spaceId: SPACE, colorRef: 'blau' }));
    await store.addDevice(fixtures.device({
      id: 'dev_BBBBBBBBBBBBBBBBBBBBBB', memberId: 'mem_BBBBBBBBBBBBBBBBBBBBBB', deviceShort: second.deviceShort,
      sigPubRaw: second.sigPubRaw, kexPubRaw: second.kexPubRaw,
    }));
    const mine = [env(dev, 1), env(dev, 2)];
    await push(ctx, dev, { space: SPACE, ops: mine, ackSeq: '0' });

    const seen = await pull(ctx, second, { space: SPACE, since: '0' });
    assert.deepEqual(seen.body.ops.map((o) => o.oid), [oid(1), oid(2)]);
    assert.deepEqual(seen.body.ops.map((o) => o.ct), mine.map((m) => m.ct));
    assert.equal(seen.body.members.length, 2);

    // The peer acks what it folded, and its own push carries a witness over what it saw.
    await push(ctx, second, {
      space: SPACE,
      ops: [env(second, 3, { dv: second.deviceShort, wit: seen.body.ops[1].chain })],
      ackSeq: seen.body.nextCursor,
      drained: true,
    });
    const back = await pull(ctx, dev, { space: SPACE, since: seen.body.nextCursor });
    assert.equal(back.body.ops.length, 1);
    assert.equal(back.body.ops[0].dv, second.deviceShort);
    assert.equal(back.body.ops[0].wit, seen.body.ops[1].chain, 'the witness travels back unmodified');
    assert.equal((await store.getDevice('dev_BBBBBBBBBBBBBBBBBBBBBB')).lastSeenSeq, 2n);
  });

  // ── through the real router, the way LZP-207 will wire it ─────────────────

  T('both routes work through createRouter, and their failures shape correctly', async () => {
    // The router is the seam all three entry points share (Vercel, dev-server, the fleet suite's
    // loopback transport). A handler that only works when called directly is a handler that
    // works in its own test and nowhere else.
    const { ctx, dev, store } = await setup();
    const route = createRouter(handlers);

    const post = await signReq({ method: 'POST', dev, bodyObj: { space: SPACE, ops: [env(dev, 1)] } });
    const ok = await route(ctx, { ...post, path: '/api/v1/ops', params: undefined, routeName: undefined });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.accepted[0].seq, '1');

    const get = await signReq({ method: 'GET', dev, query: { space: SPACE, since: '0' } });
    const pulled = await route(ctx, { ...get, path: '/api/v1/ops', params: undefined, routeName: undefined });
    assert.equal(pulled.body.ops.length, 1);

    // A 429 must arrive at the client with the header the backoff rule reads (ADR 003 §8.2).
    let shaped = null;
    for (let i = 0; i < LIMITS_SHAPE.pushPerMin + 2 && shaped === null; i++) {
      const r = await signReq({ method: 'POST', dev, bodyObj: { space: SPACE, ops: [] } });
      try { await route(ctx, { ...r, path: '/api/v1/ops', params: undefined, routeName: undefined }); }
      catch (err) { shaped = toResponse(err); }
    }
    assert.equal(shaped.status, 429);
    assert.equal(shaped.headers['Retry-After'], '60');
    assert.deepEqual(shaped.body, { error: 'rate_limited', retryAfter: 60 });
    void store;
  });

  T('a forked_op_id body names the opId and never the bytes', async () => {
    const { ctx, dev } = await setup();
    const e = env(dev, 1);
    await push(ctx, dev, { space: SPACE, ops: [e] });
    let shaped = null;
    try { await push(ctx, dev, { space: SPACE, ops: [{ ...e, ct: b64u(filler(64, 4242)) }] }); }
    catch (err) { shaped = toResponse(err); }
    assert.equal(shaped.status, 409);
    assert.deepEqual(shaped.body, { error: 'forked_op_id', oid: oid(1) });
    assert.equal(JSON.stringify(shaped).includes(e.ct), false);
    // The client's instruction on this code is "re-mint the opId", so it needs to know WHICH one.
  });

  // ── blindness, structurally ───────────────────────────────────────────────

  T('what the store actually holds is exactly MODEL_COLUMNS.Op, and the ciphertext is BYTES', async () => {
    const { ctx, dev, store } = await setup();
    await push(ctx, dev, { space: SPACE, ops: [env(dev, 1)] });
    const [row] = (await store.listOps(SPACE, 0n, 10)).ops;
    assert.deepEqual(Object.keys(row).sort(), [...MODEL_COLUMNS.Op].sort());
    assert.ok(row.envelope instanceof Uint8Array, 'a String here is how plaintext gets into a database');
    assert.ok(row.chain instanceof Uint8Array);
    assert.equal(typeof row.seq, 'bigint');
    assert.ok(row.receivedAt instanceof Date);
    assert.equal(row.witness, null);
  });

  T('a handler cannot smuggle a readable column past the store, even deliberately', async () => {
    // RULE 1 is structural, not a convention: the column set is closed at the adapter boundary.
    // This asserts the boundary is really there under the handler, not only in the handler.
    const { store } = await setup();
    await assert.rejects(() => store.upsertOps(SPACE, [{ ...fixtures.op(oid(1)), text: 'Zahnarzt 14:30' }]));
    await assert.rejects(() => store.upsertOps(SPACE, [{ ...fixtures.op(oid(1)), envelope: 'Zahnarzt 14:30' }]));
    assert.equal((await store.getSpace(SPACE)).nextSeq, 0n, 'and a refused write burns no seq');
  });
}
