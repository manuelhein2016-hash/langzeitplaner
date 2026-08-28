// tests/server/pair.test.js — the pairing rendezvous.  LZP-204, story 19.5, ADR 002 §6.
//
// WHAT IS BEING PROVED, AND WHAT IS NOT.
//
// The MITM defence in pairing is the SAS: six decimal digits on two screens, compared by the
// human who owns both machines (ADR 002 §6.3 step 6, §6.4). It lives on the CLIENTS and
// `tests/fleet/pairing-mitm.test.js` is where it is proved. **Nothing in this file can or should
// test it.** What this file tests is the other half of §6.4's argument — the half E3's red team
// found "in a contract and in no code":
//
//   > "the security argument is a short TTL times a hard attempt cap"
//
// so the server must make it impossible to get more than the cap, to replay a burn, to race two
// pairings onto one rendezvous, or to hold one open past its TTL. Each of those is a test below,
// written from the attacker's side.
//
// AND THE BLINDNESS. `boxA`, `boxB` and `delivery` are opaque columns. The relay moves them and
// learns nothing that would let it substitute a key — asserted by round-tripping bytes through
// the handlers and by checking that neither end is ever handed the box it did not need.
//
// EVERY CASE RUNS AGAINST BOTH ADAPTERS, and no case reads the wall clock: a 180-second window
// that expired because CI was slow would be a flake in the one place a flake would be ignored.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { memoryStore } from '../../server/adapters/memory.js';
import { fileStore } from '../../server/adapters/file.js';
import { fail } from '../../server/core/errors.js';
import { bytesToB64u, b64uToBytes } from '../../server/core/handlers/devices.js';
import { LIMITS, RATE_RULES, RATE_COVERAGE } from '../../server/core/limits.js';
import { pairOffer, pairGet, pairAnswer, pairDeliver, PAIR_LIMIT_DEFAULTS, RID_RE } from '../../server/core/handlers/pair.js';

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

function fakeClock(startMs) {
  let t = startMs || 1_700_000_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-pair-'));
  tempDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const ADAPTERS = [
  { name: 'memory', make: (clock) => memoryStore({ now: clock.now }) },
  { name: 'file', make: (clock) => fileStore(tempDir(), { now: clock.now }) },
];

const CTX_LIMITS = Object.freeze({ ...LIMITS, ...PAIR_LIMIT_DEFAULTS });

const DEVICE_A = { deviceShort: '7QAR2MZ9XKPNC0GV', deviceId: 'dev_AAAAAAAAAAAAAAAAAAAAAA', memberId: 'mem_AAAAAAAAAAAAAAAAAAAAAA' };

function makeCtx(store, clock, limits) {
  const state = { authOk: true };
  const ctx = {
    store,
    now: () => clock.now(),
    random: (n) => new Uint8Array(n),
    // Device A is a registered device; anything else that presents a header is a broken or
    // hostile credential and `ctx.auth` says so — which is what `optionalAuth` must NOT swallow.
    auth: async (req) => {
      if (!state.authOk) throw fail('device_revoked');
      const h = (req.headers || {}).authorization;
      if (typeof h !== 'string' || !h.startsWith('LZP1 ')) throw fail('bad_auth');
      return DEVICE_A;
    },
    assertMember: async () => {},
    log: () => {},
    limits: limits || CTX_LIMITS,
  };
  return { ctx, breakAuth: () => { state.authOk = false; } };
}

/** Device A's requests carry credentials; device B's cannot — it has no identity until step 8. */
const AUTHED = { authorization: 'LZP1 device=7QAR2MZ9XKPNC0GV, ts=1, nonce=x, sig=y' };

const rq = (o) => ({ method: 'POST', path: '/api/v1/pair', params: {}, query: {}, headers: {}, body: null, rawBody: new Uint8Array(0), routeName: 'pair', ...o });

async function call(handler, request, ctx) {
  try {
    const res = await handler(request, ctx);
    return { ok: true, status: res.status, body: res.body };
  } catch (e) {
    return { ok: false, status: e.status, code: e.code, extra: e.extra || null };
  }
}

/** `rid = b64u(HKDF(code,…,16))` — 16 bytes, 22 base64url characters. */
function ridOf(n) {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = (n * 37 + i * 11) & 255;
  return bytesToB64u(b);
}

const BOX_A = bytesToB64u(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
const BOX_B = bytesToB64u(Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]));
const DELIVERY = bytesToB64u(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));

const offer = (rid, ctx, headers) => call(pairOffer, rq({ routeName: 'pairOffer', headers: headers || AUTHED, body: { rid, boxA: BOX_A } }), ctx);
const getAnon = (rid, ctx, headers) => call(pairGet, rq({ method: 'GET', routeName: 'pairGet', params: { rid }, headers: headers || {} }), ctx);
const getAuthed = (rid, ctx) => call(pairGet, rq({ method: 'GET', routeName: 'pairGet', params: { rid }, headers: AUTHED }), ctx);
const answer = (rid, ctx, box) => call(pairAnswer, rq({ routeName: 'pairAnswer', body: { rid, boxB: box || BOX_B } }), ctx);
const deliver = (rid, ctx) => call(pairDeliver, rq({ routeName: 'pairDeliver', headers: AUTHED, body: { rid, delivery: DELIVERY } }), ctx);

// ─────────────────────────────────────────────────────────────────────────────
// Adapter-independent
// ─────────────────────────────────────────────────────────────────────────────

test('E3-5 is reconciled by enforcing all three limiters, not by choosing one', () => {
  // ADR 002 §6.2 publishes 20 pair/get per IP per hour; ADR 003 §6.1 publishes 5 FAILED rid
  // lookups per IP per minute and 10 sessions per member per hour. FINDINGS E3-5 records them as
  // "open — reconcile into one RateBucket" because they are not interchangeable. They are also
  // not contradictory: they bound three different things, and all three now run.
  assert.equal(LIMITS.pairGetPerIpHour, 20, 'ADR 002 §6.2');
  assert.equal(LIMITS.pairRidMissPerIpMin, 5, 'ADR 003 §6.1 — the limiter that actually bounds guessing');
  assert.equal(LIMITS.pairSessionsPerMemberHour, 10, 'ADR 003 §6.1');
  assert.deepEqual([...RATE_COVERAGE.pairGet.pre], ['pairGet', 'pairRidMiss']);
  assert.deepEqual([...RATE_COVERAGE.pairOffer.post], ['pairSession']);
  assert.equal(RATE_RULES.pairRidMiss.onFailureOnly, true, 'the probe budget is spent on a MISS, never on a hit');

  // The two parameters that are NOT rate rules, because neither is keyed on an identity: the
  // TTL is the row's own lifetime and the attempt budget is per RENDEZVOUS.
  assert.equal(PAIR_LIMIT_DEFAULTS.pairTtlMs, 180000, '§6.2 — 180 s, single use');
  assert.equal(PAIR_LIMIT_DEFAULTS.pairAttempts, 5, '§6.2 — 5 failed decrypts, then the rendezvous is burned');
  assert.equal(LIMITS.pairAttempts, 5, 'and the two tables agree');
});

test('a rid is 22 base64url characters and nothing else reaches the store', () => {
  assert.equal(RID_RE.test(ridOf(1)), true);
  for (const bad of ['', 'short', '../../etc/passwd', 'A'.repeat(23), 'A'.repeat(21), 'AAAA+AAAAAAAAAAAAAAAA/', null, 42]) {
    assert.equal(RID_RE.test(String(bad)), false, String(bad));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
for (const adapter of ADAPTERS) {
  const T = (name, fn) => test(`${adapter.name} :: ${name}`, async (t) => {
    const clock = fakeClock();
    const store = adapter.make(clock);
    const { ctx, breakAuth } = makeCtx(store, clock);
    await fn({ store, clock, ctx, breakAuth, t });
  });

  T('the whole §6.3 exchange, and the boxes come back byte-identical', async ({ ctx, store }) => {
    const rid = ridOf(1);

    const o = await offer(rid, ctx);
    assert.equal(o.status, 200);
    assert.equal(o.body.expiresInMs, 180000);
    assert.equal(o.body.attemptsAllowed, 5);

    // Step 3 — B derives the rid from the typed code and pulls box_A.
    const b1 = await getAnon(rid, ctx);
    assert.equal(b1.status, 200);
    assert.deepEqual([...b64uToBytes(b1.body.boxA)], [1, 2, 3, 4, 5, 6, 7, 8], 'ciphertext round-trips unchanged');
    assert.equal(b1.body.boxB, null, 'B is never handed the box it wrote itself');
    assert.equal(b1.body.attempts, 1, 'an anonymous pull of an unanswered rendezvous costs one attempt');

    // Step 4 — B answers.
    assert.equal((await answer(rid, ctx)).status, 200);

    // Step 5 — A polls. Authenticated, so it is not charged and never sees the delivery slot.
    const a1 = await getAuthed(rid, ctx);
    assert.deepEqual([...b64uToBytes(a1.body.boxB)], [9, 8, 7, 6, 5, 4, 3, 2]);
    assert.equal(a1.body.delivery, null);
    assert.equal(a1.body.attempts, 1, 'A’s poll did not spend B’s budget');

    // Step 7 — A delivers, after the humans compared the SAS on two screens.
    const d = await deliver(rid, ctx);
    assert.equal(d.status, 200);
    assert.equal(d.body.rotateRequired, true, 'ADR 002 §4.1 — my device paired ⇒ the personal space rotates');

    // Step 8 — B collects. This is the consumption event.
    const b2 = await getAnon(rid, ctx);
    assert.deepEqual([...b64uToBytes(b2.body.delivery)], [0xde, 0xad, 0xbe, 0xef]);
    assert.equal(b2.body.consumed, true);
    assert.equal(b2.body.attempts, 1, 'a poll after the answer is not charged — B must be able to wait for A');

    // Step 9 — the relay burned rid. It is gone for everyone, forever.
    assert.equal((await getAnon(rid, ctx)).status, 404);
    assert.equal(await store.getPairSession(rid), null);
  });

  T('THE BUDGET: five anonymous pulls of an unanswered rendezvous, then it is dead', async ({ ctx, store }) => {
    const rid = ridOf(2);
    await offer(rid, ctx);

    const seen = [];
    for (let i = 0; i < 8; i++) {
      const r = await getAnon(rid, ctx);
      seen.push(r.status === 200 ? r.body.attempts : r.status);
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 5, 404, 404, 404],
      'exactly ADR 002 §6.2’s five, and the sixth finds nothing — the server cannot help an attacker to a sixth guess');
    assert.equal(await store.getPairSession(rid), null, 'the rendezvous is burned, not merely exhausted');
  });

  T('REPLAY: a burned rid can never be resurrected — by an offer, an answer or a delivery', async ({ ctx, store }) => {
    const rid = ridOf(3);
    await offer(rid, ctx);
    for (let i = 0; i < 5; i++) await getAnon(rid, ctx);          // burn it
    assert.equal(await store.getPairSession(rid), null);

    // The attack the tombstone exists for: replay `pair/offer` and get a fresh 5-attempt budget.
    const again = await offer(rid, ctx);
    assert.equal(again.status, 410);
    assert.equal(again.code, 'pair_burned', 'a burn a later write could undo is not a cap');
    assert.equal(await store.getPairSession(rid), null, 'and the replay wrote nothing');

    assert.equal((await answer(rid, ctx)).status, 404);
    assert.equal((await deliver(rid, ctx)).status, 404);
    assert.equal((await getAnon(rid, ctx)).status, 404);
    assert.equal((await getAuthed(rid, ctx)).status, 404, 'not even the offering device gets it back');
  });

  T('TTL: 180 seconds, and no write extends it', async ({ ctx, clock, store }) => {
    const rid = ridOf(4);
    await offer(rid, ctx);

    clock.advance(100000);
    assert.equal((await answer(rid, ctx)).status, 200, 'still live at 100 s');
    clock.advance(60000);
    assert.equal((await deliver(rid, ctx)).status, 200, 'still live at 160 s');

    // Three writes have landed on this row. If any of them had reset `expiresAt`, the rendezvous
    // would now be good until 340 s and an attacker could hold one open indefinitely by writing.
    clock.advance(20001);
    assert.equal((await getAnon(rid, ctx)).status, 404, 'expired at 180 s from the OFFER, not from the last write');
    assert.equal((await getAuthed(rid, ctx)).status, 404);
    assert.equal(await store.getPairSession(rid), null);

    // An expired rid is reusable — it was never burned, only forgotten. That is correct: the TTL
    // is what makes the code's 60 bits sufficient, and a permanent tombstone for every expiry
    // would be an unbounded table.
    assert.equal((await offer(rid, ctx)).status, 200);
  });

  T('RACE: two pairings on one rid produce one winner, never an overwrite', async ({ ctx, store }) => {
    const rid = ridOf(5);
    assert.equal((await offer(rid, ctx)).status, 200);

    // A second offer on a live rendezvous: either the same 60-bit code was drawn twice, or
    // somebody else knows it. Both deserve a refusal rather than a box from another machine.
    const second = await offer(rid, ctx);
    assert.equal(second.status, 400);
    assert.equal(second.extra.reason, 'rid_in_use');
    assert.deepEqual([...(await store.getPairSession(rid)).boxA], [1, 2, 3, 4, 5, 6, 7, 8], 'the honest box A is intact');

    // Two devices answering. The loser is told; the winner's ephemeral key is not replaced —
    // which is the move a MITM would want, because it would let them swap in an answer the human
    // had already started comparing digits against.
    const hostile = bytesToB64u(Uint8Array.from([0x66, 0x66]));
    const results = await Promise.all([answer(rid, ctx), answer(rid, ctx, hostile)]);
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    const loser = results.find((r) => r.status !== 200);
    assert.equal(loser.status, 400);
    assert.equal(loser.extra.reason, 'already_answered');

    // Likewise for the delivery slot.
    assert.equal((await deliver(rid, ctx)).status, 200);
    const twice = await deliver(rid, ctx);
    assert.equal(twice.extra.reason, 'already_delivered');
  });

  T('RACE: eight simultaneous anonymous pulls cannot exceed the budget', async ({ ctx, store }) => {
    const rid = ridOf(6);
    await offer(rid, ctx);
    const results = await Promise.all([...Array(8)].map(() => getAnon(rid, ctx)));
    const served = results.filter((r) => r.status === 200);
    assert.equal(served.length, 5, 'the atomic increment loses no count under concurrency');
    assert.deepEqual(served.map((r) => r.body.attempts).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    assert.equal(await store.getPairSession(rid), null);
  });

  T('ORDER: an answer before an offer, and a delivery before an answer, are both refused', async ({ ctx, store }) => {
    const rid = ridOf(7);
    // Nothing exists yet — indistinguishable from burned, on purpose.
    assert.equal((await answer(rid, ctx)).status, 404);
    assert.equal((await deliver(rid, ctx)).status, 404);
    assert.equal(await store.getPairSession(rid), null, 'an answer never CREATES a rendezvous');

    await offer(rid, ctx);
    const early = await deliver(rid, ctx);
    assert.equal(early.status, 400);
    assert.equal(early.extra.reason, 'not_answered', 'delivering before the answer means delivering to whoever answers next');
    assert.equal((await store.getPairSession(rid)).delivery, null);
  });

  T('the two ends are told different things, and that IS the control', async ({ ctx }) => {
    const rid = ridOf(8);
    await offer(rid, ctx);
    await answer(rid, ctx);
    await deliver(rid, ctx);

    // A polls. It never receives `delivery`, so its own poll cannot consume the single-use
    // collection out from under B.
    const a = await getAuthed(rid, ctx);
    assert.equal(a.body.delivery, null);
    assert.notEqual(a.body.boxB, null);
    assert.equal(a.body.consumed, false);

    // ...and it is still collectable afterwards, which is the property that assertion protects.
    const b = await getAnon(rid, ctx);
    assert.notEqual(b.body.delivery, null);
    assert.equal(b.body.boxB, null, 'and B is never handed a second ciphertext under the same ck');
    assert.equal(b.body.consumed, true);
  });

  T('a present-but-invalid Authorization header is an error, never a downgrade to anonymous', async ({ ctx, breakAuth }) => {
    const rid = ridOf(9);
    await offer(rid, ctx);
    breakAuth();
    // The anonymous path is the CHARGED one, so a downgrade would not help an attacker here —
    // but a revoked device's request quietly becoming an anonymous one is the shape of a bug
    // that would help somewhere else, so the seam refuses to swallow it anywhere.
    const r = await getAnon(rid, ctx, AUTHED);
    assert.equal(r.status, 403);
    assert.equal(r.code, 'device_revoked');
    // No header at all is still anonymous and still works — B has no identity until step 8.
    assert.equal((await getAnon(rid, ctx)).status, 200);
  });

  T('a malformed rid is refused before the store is touched', async ({ ctx, store }) => {
    for (const bad of ['', 'nope', '../../etc', 'A'.repeat(23), 'AAAAAAAAAAAAAAAAAAAAA+']) {
      assert.equal((await getAnon(bad, ctx)).status, 400, `GET ${bad}`);
      assert.equal((await answer(bad, ctx)).status, 400, `answer ${bad}`);
      assert.equal((await offer(bad, ctx)).status, 400, `offer ${bad}`);
    }
    assert.equal(await store.getPairSession('../../etc'), null);
    // A box that is not base64url, or is absurd, is refused the same way.
    assert.equal((await call(pairOffer, rq({ headers: AUTHED, body: { rid: ridOf(10), boxA: 'not b64!' } }), ctx)).extra.field, 'boxA');
    assert.equal((await call(pairOffer, rq({ headers: AUTHED, body: { rid: ridOf(10), boxA: 'A'.repeat(20000) } }), ctx)).extra.field, 'boxA');
    assert.equal((await call(pairOffer, rq({ headers: AUTHED, body: null }), ctx)).status, 400);
  });

  T('probing the rid space is bounded at 5 failed lookups per IP per minute (ADR 003 §6.1)', async ({ ctx, clock }) => {
    const hostile = { 'x-forwarded-for': '203.0.113.77' };
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await getAnon(ridOf(100 + i), ctx, hostile)).status);
    assert.deepEqual(codes, [404, 404, 404, 404, 404, 429, 429, 429],
      '5 probes/minute against a 2^60 space is the number that makes the 60-bit code sufficient');
    assert.equal((await getAnon(ridOf(150), ctx, hostile)).extra.retryAfter, 60, 'Retry-After is the whole window');

    // A different IP has its own budget, and the window re-opens.
    assert.equal((await getAnon(ridOf(200), ctx, { 'x-forwarded-for': '198.51.100.5' })).status, 404);
    clock.advance(60001);
    assert.equal((await getAnon(ridOf(201), ctx, hostile)).status, 404);
  });

  T('pair/get is capped at 20 per IP per hour, and offers at 10 per member per hour', async ({ ctx }) => {
    const ip = { 'x-forwarded-for': '203.0.113.9' };
    const rid = ridOf(11);
    await offer(rid, ctx);
    await answer(rid, ctx);                                  // answered ⇒ no attempt is charged
    let limited = 0;
    for (let i = 0; i < 24; i++) {
      const r = await getAnon(rid, ctx, ip);
      if (r.status === 429) { limited++; assert.equal(r.extra.retryAfter, 3600); }
    }
    assert.equal(limited, 4, '20 of 24 admitted — ADR 002 §6.2');

    let admitted = 1;                                        // the offer at the top of this test
    for (let i = 0; i < 14; i++) {
      if ((await offer(ridOf(300 + i), ctx)).status === 200) admitted++;
    }
    assert.equal(admitted, 10, '10 sessions per member per hour — ADR 003 §6.1');
  });

  T('the relay stores boxes as BYTES and could not hold a note if a handler tried', async ({ store, ctx }) => {
    const rid = ridOf(12);
    await offer(rid, ctx);
    const row = await store.getPairSession(rid);
    assert.ok(row.boxA instanceof Uint8Array, 'RULE 1 — an opaque column holds bytes or nothing');
    assert.equal(row.burnedAt, null);
    assert.deepEqual(Object.keys(row).sort(), ['attempts', 'boxA', 'boxB', 'burnedAt', 'delivery', 'expiresAt', 'rid'],
      'the PairSession column set is closed: there is nowhere for a name, a note or an owner to go');
    await assert.rejects(() => store.putPairSession(ridOf(13), { boxA: 'Zahnarzt 14:30' }, 1000),
      'a String in an opaque column throws at the adapter boundary, not in review');
  });
}
