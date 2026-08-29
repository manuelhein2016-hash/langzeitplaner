// ATTACK · T1 — THE PAIRING RENDEZVOUS.
//
// `POST /pair/offer` → `GET /pair/:rid` → `POST /pair/answer` → `POST /pair/deliver` is the one
// place in this API where a caller with no identity at all is answered, and the one place where
// guessing a 60-bit secret is the whole attack (ADR 002 §6). The relay operator is the worst
// possible position to attack it from, because T1 sees every `rid` in a URL path and can retry
// from any address it likes.
//
// Four controls exist (`server/core/handlers/pair.js` header) and this file attacks each:
//
//   1. **TTL, 180 s, not extendable by writing** — `putPairSession` sets `expiresAt` only on
//      creation, in the STORE, so holding a rendezvous open by re-posting is not a thing a
//      handler convention could accidentally allow.
//   2. **The 5-attempt budget**, per RENDEZVOUS rather than per identity — so changing address
//      buys nothing.
//   3. **The burn is a tombstone**, so a replayed offer cannot resurrect a rid and reset (2).
//   4. **Write-once boxes**, so a race produces one winner and one refusal, never an overwrite.
//
// The E3 pass already proved these three from the crypto side. This file is the RELAY OPERATOR's
// version — every request goes through the real router, and §5 adds the question that side did
// not ask: **what does the relay LEARN from a pairing, and is it documented?**

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADAPTERS, T0, fakeClock, relay, seedSpace, b64u,
  assertDocumented, documents,
} from './_attack-relay-kit.js';
import { PAIR_LIMIT_DEFAULTS, RID_RE } from '../../server/core/handlers/pair.js';
import { LIMITS } from '../../server/core/limits.js';

const SPACE = 'psp_PAIRINGaaaaaaaaaaaaaaa';
const RID = 'PAIRrendezvous00000001';
const ATTACKER_IP = '198.51.100.9';
const HOME_IP = '203.0.113.7';

const box = (n) => b64u(new Uint8Array(64).fill(n));

async function stage(adapter) {
  const clock = fakeClock(T0);
  const h = (adapter || ADAPTERS[0]).make(clock);
  const seeded = await seedSpace(h, clock, {
    id: SPACE, kind: 'PERSONAL', members: [{ name: 'me', colorRef: 'gruen', devices: 1 }],
  });
  return { clock, h, r: relay(h, clock), a: seeded.members[0].devices[0], member: seeded.members[0] };
}

test('the rid shape and the published parameters are what ADR 002 §6.2 says', () => {
  assert.equal(RID_RE.source, '^[A-Za-z0-9_-]{22}$', 'a rid is 16 bytes of HKDF, 22 b64url chars');
  assert.ok(RID_RE.test(RID));
  assert.equal(PAIR_LIMIT_DEFAULTS.pairTtlMs, 180000);
  assert.equal(PAIR_LIMIT_DEFAULTS.pairAttempts, 5);
  assert.equal(LIMITS.pairRidMissPerIpMin, 5, 'ADR 003 §6.1 — 5 FAILED rid lookups per IP per minute');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 Exceed the budget
// ═════════════════════════════════════════════════════════════════════════════════════════════

for (const adapter of ADAPTERS) {
  const T = (name, fn) => test(`[${adapter.name}] ${name}`, fn);

  T('FAILED — the 5th anonymous read of an UNANSWERED rendezvous burns it and the 6th is a 404', async () => {
    const { r, a } = await stage(adapter);
    const offer = await r.send({ method: 'POST', path: '/api/v1/pair/offer', dev: a, body: { rid: RID, boxA: box(1) } });
    assert.equal(offer.status, 200, JSON.stringify(offer.body));
    assert.equal(offer.body.attemptsAllowed, 5);

    const seen = [];
    for (let i = 1; i <= 6; i++) {
      const res = await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, ip: ATTACKER_IP });
      seen.push([res.status, res.body.attempts === undefined ? res.body.error : res.body.attempts]);
    }
    assert.deepEqual(seen, [
      [200, 1], [200, 2], [200, 3], [200, 4],
      [200, 5],                       // served, AND burned on the way out
      [404, 'not_found'],             // unknown, expired and burned are one answer
    ], 'the budget is exactly five reads of an unanswered rendezvous');

    // The honest end sees the same thing: the rid is gone for everyone, not just for the guesser.
    const offerer = await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, dev: a });
    assert.equal(offerer.status, 404, 'a burn is not per-caller — it retires the rendezvous');
  });

  T('FAILED — changing IP on every request buys the guesser nothing: the budget is per RENDEZVOUS', async () => {
    const { r, a } = await stage(adapter);
    await r.send({ method: 'POST', path: '/api/v1/pair/offer', dev: a, body: { rid: RID, boxA: box(1) } });

    const statuses = [];
    for (let i = 1; i <= 6; i++) {
      // A fresh /24 every request — a botnet, or one attacker with a VPN.
      const res = await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, ip: `198.51.${i}.${i}` });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 404],
      'the per-IP limiters are a second fence; the one that actually bounds guessing is '
      + '`Store.bumpPairAttempts`, which is keyed on the rid');
  });

  T('FAILED — the OFFERER polling for box_B is charged nothing, so an honest pairing is not starved', async () => {
    const { r, a } = await stage(adapter);
    await r.send({ method: 'POST', path: '/api/v1/pair/offer', dev: a, body: { rid: RID, boxA: box(1) } });

    // Twelve polls at the client's cadence. If these were charged, every real pairing would die
    // after five seconds — which is why the budget distinguishes the two callers.
    for (let i = 0; i < 12; i++) {
      const res = await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, dev: a });
      assert.equal(res.status, 200, `poll ${i}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.attempts, 0, 'an authenticated read must never move the counter');
      assert.equal(res.body.delivery, null, 'and it must never be handed the delivery it wrote');
    }
    // The anonymous budget is still fully intact afterwards.
    const guess = await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, ip: ATTACKER_IP });
    assert.equal(guess.body.attempts, 1);
  });

  T('FAILED — once box_B exists the joiner may poll freely, and neither end is handed the other\'s box', async () => {
    const { r, a } = await stage(adapter);
    await r.send({ method: 'POST', path: '/api/v1/pair/offer', dev: a, body: { rid: RID, boxA: box(1) } });
    const ans = await r.send({ method: 'POST', path: '/api/v1/pair/answer', ip: HOME_IP, body: { rid: RID, boxB: box(2) } });
    assert.equal(ans.status, 200, JSON.stringify(ans.body));

    for (let i = 0; i < 8; i++) {
      const res = await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, ip: HOME_IP });
      assert.equal(res.status, 200, `poll ${i}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.attempts, 0, 'the committed phase is not the guessable phase');
      assert.equal(res.body.boxB, null, 'the joiner never gets back the box it wrote…');
      assert.ok(res.body.boxA, '…and does get the one it needs');
    }
    const offerer = await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, dev: a });
    assert.equal(offerer.body.delivery, null, 'and A never gets its own delivery back');
    assert.ok(offerer.body.boxB, 'A does get box_B, which is what it was polling for');
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §2 Replay a burn
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('FAILED — a burned rid cannot be resurrected by replaying the offer, so the budget cannot be reset', async () => {
    const { r, a } = await stage(adapter);
    await r.send({ method: 'POST', path: '/api/v1/pair/offer', dev: a, body: { rid: RID, boxA: box(1) } });
    for (let i = 0; i < 5; i++) await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, ip: ATTACKER_IP });

    // The obvious reset: re-offer the same rid and start the five over again.
    const again = await r.send({ method: 'POST', path: '/api/v1/pair/offer', dev: a, body: { rid: RID, boxA: box(3) } });
    assert.equal(again.status, 410);
    assert.equal(again.body.error, 'pair_burned');

    // …and there is really nothing there afterwards, from either end.
    assert.equal((await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, ip: ATTACKER_IP })).status, 404);
    assert.equal((await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, dev: a })).status, 404);
    assert.equal((await r.send({ method: 'POST', path: '/api/v1/pair/answer', ip: ATTACKER_IP, body: { rid: RID, boxB: box(4) } })).status, 404);
  });

  T('FAILED — collecting the delivery burns the rendezvous: one collection, ever', async () => {
    const { r, a } = await stage(adapter);
    await r.send({ method: 'POST', path: '/api/v1/pair/offer', dev: a, body: { rid: RID, boxA: box(1) } });
    await r.send({ method: 'POST', path: '/api/v1/pair/answer', ip: HOME_IP, body: { rid: RID, boxB: box(2) } });
    const del = await r.send({ method: 'POST', path: '/api/v1/pair/deliver', dev: a, body: { rid: RID, delivery: box(3) } });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.rotateRequired, true, 'ADR 002 §6.3 step 9 — the personal space rotates after this');

    const collect = await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, ip: HOME_IP });
    assert.equal(collect.status, 200);
    assert.ok(collect.body.delivery, 'the joiner collects it once…');
    assert.equal(collect.body.consumed, true);

    // …and a relay that replayed that GET — the one request it is best placed to replay, since it
    // saw the rid in a URL path — gets nothing.
    const replay = await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, ip: ATTACKER_IP });
    assert.equal(replay.status, 404, 'the single-use collection really is single-use');
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §3 Hold it past its TTL
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('FAILED — writing to a live rendezvous does not move `expiresAt`; 180 s is 180 s', async () => {
    const { r, a, clock } = await stage(adapter);
    const offer = await r.send({ method: 'POST', path: '/api/v1/pair/offer', dev: a, body: { rid: RID, boxA: box(1) } });
    assert.equal(offer.body.expiresInMs, 180000);

    const first = await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, dev: a });
    const deadline = first.body.expiresAt;
    assert.equal(deadline, T0 + 180000);

    // 150 seconds in, an answer arrives — a WRITE onto the live row. If `putPairSession` reset the
    // expiry on a patch, an attacker with the rid could hold the rendezvous open indefinitely by
    // writing to it, and 60-bit guessing would stop being bounded by a three-minute window.
    clock.advance(150000);
    const ans = await r.send({ method: 'POST', path: '/api/v1/pair/answer', ip: HOME_IP, at: clock.now(), body: { rid: RID, boxB: box(2) } });
    assert.equal(ans.status, 200, JSON.stringify(ans.body));
    const after = await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, dev: a, at: clock.now() });
    assert.equal(after.body.expiresAt, deadline, 'THE WRITE DID NOT EXTEND THE TTL');

    // 31 seconds later the window has closed, and the rendezvous is gone for both ends.
    clock.advance(31000);
    assert.equal((await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, dev: a, at: clock.now() })).status, 404);
    assert.equal((await r.send({ method: 'POST', path: '/api/v1/pair/deliver', dev: a, at: clock.now(), body: { rid: RID, delivery: box(3) } })).status, 404);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §4 Race it
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('FAILED — every box is write-once: two offers, two answers and two deliveries each produce one winner', async () => {
    const { r, a } = await stage(adapter);

    // Two offers on one rid. The second is refused rather than overwriting `box_A`, which is what
    // would let somebody swap the key the human is about to compare digits against.
    const offers = await Promise.all([box(1), box(9)].map((b) =>
      r.send({ method: 'POST', path: '/api/v1/pair/offer', dev: a, body: { rid: RID, boxA: b } })));
    assert.equal(offers.filter((o) => o.status === 200).length, 1, 'one offer wins');
    const loser = offers.find((o) => o.status !== 200);
    assert.equal(loser.status, 400);
    assert.equal(loser.body.reason, 'rid_in_use');

    // Two answers. This is the MITM's move — answer over the honest B's ephemeral key while the
    // human is mid-comparison.
    const answers = await Promise.all([box(2), box(8)].map((b) =>
      r.send({ method: 'POST', path: '/api/v1/pair/answer', ip: ATTACKER_IP, body: { rid: RID, boxB: b } })));
    assert.equal(answers.filter((o) => o.status === 200).length, 1, 'one answer wins');
    assert.equal(answers.find((o) => o.status !== 200).body.reason, 'already_answered');

    // Two deliveries.
    const deliveries = await Promise.all([box(3), box(7)].map((b) =>
      r.send({ method: 'POST', path: '/api/v1/pair/deliver', dev: a, body: { rid: RID, delivery: b } })));
    assert.equal(deliveries.filter((o) => o.status === 200).length, 1, 'one delivery wins');
    assert.equal(deliveries.find((o) => o.status !== 200).body.reason, 'already_delivered');

    // Whichever won, the stored box is one of the two offered and was never blanked in between —
    // there is no state in which the rendezvous holds a null box after holding a real one.
    const got = await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, ip: HOME_IP });
    assert.ok(got.body.boxA, 'box_A survived the whole race');
  });

  T('FAILED — an answer with no offer, and a delivery with no answer, are both refused', async () => {
    const { r, a } = await stage(adapter);
    // Nothing at this rid at all: one indistinguishable 404, never "this rid exists but is empty".
    assert.equal((await r.send({ method: 'POST', path: '/api/v1/pair/answer', ip: ATTACKER_IP, body: { rid: RID, boxB: box(2) } })).status, 404);

    await r.send({ method: 'POST', path: '/api/v1/pair/offer', dev: a, body: { rid: RID, boxA: box(1) } });
    const early = await r.send({ method: 'POST', path: '/api/v1/pair/deliver', dev: a, body: { rid: RID, delivery: box(3) } });
    assert.equal(early.status, 400);
    assert.equal(early.body.reason, 'not_answered',
      'delivering before box_B exists means delivering to whoever answers next');
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 The guesser is cut off, and told nothing
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('FAILED — five misses in a minute stop the answers, with a real Retry-After', async () => {
  const { r } = await stage();
  const codes = [];
  for (let i = 0; i < 7; i++) {
    const rid = `guess${String(i).padStart(17, '0')}`;
    const res = await r.send({ method: 'GET', path: `/api/v1/pair/${rid}`, ip: ATTACKER_IP });
    codes.push([res.status, res.headers['Retry-After']]);
  }
  assert.deepEqual(codes.slice(0, 5).map((c) => c[0]), [404, 404, 404, 404, 404]);
  assert.equal(codes[5][0], 429, 'the sixth miss in a minute is refused outright');
  assert.ok(Number(codes[5][1]) > 0, `and carries a real Retry-After; got ${codes[5][1]}`);
  assert.equal(codes[6][0], 429);

  // 5 probes/minute against 2^60 is the number `pair.js` publishes. Assert the arithmetic rather
  // than the prose, so a loosened limit fails here and not in a review.
  const yearsToHalf = (2 ** 60 / 2) / (LIMITS.pairRidMissPerIpMin * 60 * 24 * 365);
  assert.ok(yearsToHalf > 1e10, `expected an astronomical search; got ${yearsToHalf.toExponential(1)} years`);
});

test('FAILED — unknown, expired and burned are one answer, so a hit is never confirmed', async () => {
  const { r, a, clock } = await stage();

  // unknown
  const unknown = await r.send({ method: 'GET', path: `/api/v1/pair/${'unknownRid0000000000AA'}`, ip: `198.51.1.1` });
  // expired
  await r.send({ method: 'POST', path: '/api/v1/pair/offer', dev: a, body: { rid: RID, boxA: box(1) } });
  clock.advance(181000);
  const expired = await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, ip: '198.51.1.2', at: clock.now() });
  // burned
  const rid2 = 'PAIRrendezvous00000002';
  await r.send({ method: 'POST', path: '/api/v1/pair/offer', dev: a, at: clock.now(), body: { rid: rid2, boxA: box(1) } });
  for (let i = 0; i < 5; i++) await r.send({ method: 'GET', path: `/api/v1/pair/${rid2}`, ip: '198.51.1.3', at: clock.now() });
  const burned = await r.send({ method: 'GET', path: `/api/v1/pair/${rid2}`, ip: '198.51.1.4', at: clock.now() });

  for (const [name, res] of [['unknown', unknown], ['expired', expired], ['burned', burned]]) {
    assert.equal(res.status, 404, `${name} must be 404`);
    assert.deepEqual(res.body, { error: 'not_found' },
      `${name} must be byte-identical to the others — a 410 here would confirm to an attacker that `
      + 'they had found a real code, which is the single most valuable bit in the protocol');
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 What the relay LEARNS from a pairing — and whether 21.3 says so
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED — the relay reads the pairing STATE off the null-ness of three opaque columns', async () => {
  const { r, h, a, clock } = await stage();
  const observe = () => {
    const row = h.dump().pairs.get(RID);
    if (!row) return 'gone';
    if (row.delivery) return 'delivered';
    if (row.boxB) return 'answered';
    if (row.boxA) return 'offered';
    return 'empty';
  };

  assert.equal(observe(), 'gone');
  await r.send({ method: 'POST', path: '/api/v1/pair/offer', dev: a, body: { rid: RID, boxA: box(1) } });
  assert.equal(observe(), 'offered', 'a second Mac is being added, right now');
  await r.send({ method: 'POST', path: '/api/v1/pair/answer', ip: HOME_IP, body: { rid: RID, boxB: box(2) } });
  assert.equal(observe(), 'answered', 'the two screens are in front of one person');
  await r.send({ method: 'POST', path: '/api/v1/pair/deliver', dev: a, body: { rid: RID, delivery: box(3) } });
  assert.equal(observe(), 'delivered', 'the human confirmed the SAS on both screens');
  await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, ip: HOME_IP });

  const burnedRow = h.dump().pairs.get(RID);
  assert.ok(burnedRow, 'the tombstone is RETAINED — deliberately, so a replay cannot re-create it');
  assert.ok(burnedRow.burnedAt, 'and it is dated');

  // The relay never learns the code, never opens a box, and still holds a complete narrative of
  // "somebody in this household added a machine on 15 June at 08:00, and it worked".
  assert.equal(documents(['the relay never learns the code']) || documents(['The relay never learns the code']), true);
  assertDocumented(assert, 'the state of every pairing, and whether it succeeded', [
    'whether each is null is the state of the pairing',
    'it started, it got this far, and it succeeded or it did not',
    'how many anonymous reads this rendezvous has taken',
    'A burn is a tombstone and is retained',
  ]);
});

test('SUCCEEDED — the rid rides in a URL PATH, which is exactly where a platform request log looks', async () => {
  const { r, a } = await stage();
  await r.send({ method: 'POST', path: '/api/v1/pair/offer', dev: a, body: { rid: RID, boxA: box(1) } });
  const res = await r.send({ method: 'GET', path: `/api/v1/pair/${RID}`, ip: HOME_IP });
  assert.equal(res.status, 200);

  // The APPLICATION log is clean: `route` is a closed enum of 23 names and no path is ever written.
  const text = r.logText();
  assert.equal(text.includes(RID), false, 'the application log must never carry a rid');
  assert.ok(text.includes('pairGet'), 'it carries the route NAME, which is all it may carry');

  // Vercel's own log is a different file with different retention and a different owner, and the
  // rid is in the request line there by construction. Not a defect in this server — a disclosure
  // that belongs on the Datenschutz page, and it is on it.
  assertDocumented(assert, 'the pairing rid reaching the platform request log via the URL path', [
    'puts the pairing rendezvous id — HKDF output of the pairing code — **into a URL path**',
    'platform request log is exactly where a URL path goes',
    "the platform's does",
    "Vercel's terms, not ours",
  ]);
});
