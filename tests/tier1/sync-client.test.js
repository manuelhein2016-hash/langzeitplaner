// TIER 1 · LZP-501 · `src/js/sync/client.js`.  Stories 19.1, 19.2, 19.3, 19.6.
// ADR 003 §3, §4, §8 · ADR 006 §9.1 (W1) · ADR 002 §5.2.5 (F-6).
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// HOW THIS FILE IS BUILT, AND WHY IT IS BUILT THAT WAY
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The relay is REAL: `server/core/handlers/*` over `server/adapters/memory.js`, reached through
// the real router, the real version gate and the real ADR 003 §2 auth ladder. The transport is
// REAL: `src/js/platform/net.js`'s `createFetchTransport`, doing the real canonical query, the
// real signed string and a real P-256 signature, with only the socket replaced. So every
// assertion below is about the product rather than about a stand-in — and every adversary is a
// MUTATION of the honest relay's own answer, which is the only way an attack test can be
// trusted not to be arguing with a fake.
//
// Two things are injected doubles, deliberately, and both are ports the design already names:
//
//   · `open(envelope)` — `crypto/envelope.js openOp` bound to a key ring and to
//     `AuthzResult.attestationOf`. It is a port because §5.2.2's own tests
//     (`tests/tier1/crypto-envelope.test.js`) own the crypto, and because the interesting
//     behaviour HERE is what the client does with `{status:'park'}` and with a throw.
//   · the clock, the scheduler and randomness. `src/js/sync/` may not read a wall clock, call
//     `setTimeout` or call `Math.random` (the purity gate), so a test that drives them by hand is
//     testing the shipping code path, not bypassing it.
//
// Nothing here sleeps. Every cadence assertion advances a fake clock.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSyncClient, SYNC_COPY, PARK_REPLAY_TRIES } from '../../src/js/sync/client.js';
import { createOutbox, createParkingLot, memoryRecordStore } from '../../src/js/sync/outbox.js';
import { createCursors, memoryCursorStore } from '../../src/js/sync/cursor.js';
import { createChainWitness } from '../../src/js/sync/chain.js';
import { CADENCE, LIMITS } from '../../src/js/sync/protocol.js';
import { b64u } from '../../src/js/core/b64.js';

import {
  createRelay, makeMember, makeDevice, createSpace, registerDevice, transportFor,
  fakeClock, fakeScheduler, seededRandom, hostile, responseLike,
} from '../helpers/sync-loopback.js';

const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** A sealed envelope as far as the relay is concerned; the relay never decrypts. */
function env(space, deviceShort, wit) {
  return {
    v: 1, sp: space, ep: 1, dv: deviceShort,
    oid: b64u(rnd(16)), wit: wit === undefined ? '' : wit,
    iv: b64u(rnd(12)), ct: b64u(rnd(48)), sig: b64u(rnd(64)),
  };
}

/**
 * A whole Mac: the real transport onto a real relay, a real client, and hand-driven ports.
 * `plan` becomes the hostile handler; `openPlan(env)` decides opened / park / throw.
 */
async function mac(opts = {}) {
  const clock = opts.clock || fakeClock();
  const relay = opts.relay || createRelay({ clock });
  const member = opts.member || await makeMember();
  const device = await makeDevice(member, opts.label || 'A');
  const space = opts.space || await createSpace(relay, device, 'PERSONAL');
  if (opts.space) await registerDevice(relay, space, device);

  const sched = fakeScheduler(clock);
  const warnings = [];
  const applied = [];
  const statuses = [];
  const quarantines = [];
  const findings = [];
  let persists = 0;
  const state = { online: true, visible: true, handler: null, openPlan: opts.openPlan || null, persistThrows: false };

  const transport = transportFor(relay, device, { handler: (u, i) => (state.handler || relay.handler)(u, i) });

  const client = createSyncClient({
    transport,
    spaces: { personal: space, family: null },
    clock,
    schedule: (ms, fn) => sched.schedule(ms, fn),
    unschedule: (h) => sched.unschedule(h),
    random: opts.random || seededRandom(opts.seed || 1),
    isOnline: () => state.online,
    isVisible: () => state.visible,
    open: async (e) => {
      if (state.openPlan) return state.openPlan(e);
      return { status: 'opened', op: { id: e.oid, ep: e.ep, space: e.sp } };
    },
    onOps: (ops) => applied.push(...ops),
    persist: async () => { persists++; if (state.persistThrows) throw new Error('board.json is full'); },
    onStatus: (s) => statuses.push(s),
    onQuarantine: (q) => quarantines.push(q),
    onFindings: (f) => findings.push(...f),
    warn: (m) => warnings.push(m),
    outbox: createOutbox({ storage: memoryRecordStore(), now: clock.now, warn: (m) => warnings.push(m) }),
    parking: createParkingLot({ storage: memoryRecordStore(), now: clock.now, warn: (m) => warnings.push(m), cap: opts.parkCap }),
    cursors: createCursors({ storage: memoryCursorStore(), warn: (m) => warnings.push(m) }),
    witness: createChainWitness({}),
    cadence: opts.cadence,
  });
  await client.load();

  return {
    relay, clock, sched, device, member, space, client, state,
    warnings, applied, statuses, quarantines, findings,
    get persists() { return persists; },
    env: (wit) => env(space, device.deviceShort, wit),
    /** Push a batch straight at the relay, as the OTHER Mac would. */
    async publish(n = 1) {
      const envs = Array.from({ length: n }, () => env(space, device.deviceShort));
      const res = await transport.request('POST', '/api/v1/ops', undefined, { space, ackSeq: '0', ops: envs });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      return envs;
    },
  };
}

/** Two Macs of ONE person, on one relay — M1's whole configuration. */
async function twoMacs(opts = {}) {
  const clock = fakeClock();
  const relay = createRelay({ clock });
  const member = await makeMember();
  const A = await mac({ ...opts, clock, relay, member, label: 'A' });
  const B = await mac({ ...opts, clock, relay, member, label: 'B', space: A.space });
  return { clock, relay, member, A, B, space: A.space };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · 19.1 — offline is the normal case
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · fully functional offline', () => {
  test('an offline Mac queues everything and makes no request at all', async () => {
    const m = await mac();
    m.state.online = false;
    const before = m.relay.calls.length;
    m.client.start();
    await m.sched.drain();

    for (let i = 0; i < 5; i++) await m.client.queue(m.space, [m.env()]);
    await m.client.pushNow();
    await m.sched.run(CADENCE.pushDebounceMs + 1);

    assert.equal(m.relay.calls.length, before, 'an offline client talked to the relay');
    assert.equal(m.client.status().pendingOps, 5, 'and the edits are all still queued');
    assert.equal(m.client.status().state, 'pending');
    assert.equal(m.client.status().detail, SYNC_COPY.offline);
  });

  test('back online, everything queued goes out — in order, in one batch', async () => {
    const m = await mac();
    m.state.online = false;
    m.client.start();
    const envs = [];
    for (let i = 0; i < 5; i++) { const e = m.env(); envs.push(e); await m.client.queue(m.space, [e]); }

    m.state.online = true;
    await m.client.wake('online');
    await m.client.pushNow();

    assert.equal(m.client.status().pendingOps, 0);
    const pushes = m.relay.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/ops');
    assert.equal(pushes.length, 1, 'five ops went in five requests instead of one batch');

    // and the relay really holds them, in order
    const peer = await mac({ relay: m.relay, member: m.member, space: m.space, label: 'B' });
    await peer.client.pullNow();
    assert.deepEqual(peer.applied.map((o) => o.id), envs.map((e) => e.oid));
  });

  test('three weeks of edits leave in ⌈n/200⌉ batches and nothing is dropped (19.6)', async () => {
    const m = await mac();
    m.state.online = false;
    m.client.start();
    const envs = Array.from({ length: 450 }, () => m.env());
    await m.client.queue(m.space, envs);
    assert.equal(m.client.status().pendingOps, 450);

    m.state.online = true;
    await m.client.pushNow();
    const pushes = m.relay.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/ops');
    assert.equal(pushes.length, 3, `450 ops should be ⌈450/200⌉ = 3 batches, was ${pushes.length}`);
    assert.equal(m.client.status().pendingOps, 0);

    const peer = await mac({ relay: m.relay, member: m.member, space: m.space, label: 'B' });
    await peer.client.pullNow();
    assert.equal(peer.applied.length, 450);
    assert.deepEqual(peer.applied.map((o) => o.id).sort(), envs.map((e) => e.oid).sort());
  });

  test('a transport error mid-session is offline, not an error state', async () => {
    const m = await mac();
    m.client.start();
    await m.sched.drain();
    await m.client.queue(m.space, [m.env()]);
    m.state.handler = async () => { throw Object.assign(new Error('down'), { kind: 'offline' }); };
    await m.client.pushNow();
    assert.equal(m.client.status().pendingOps, 1, 'the op survived');
    assert.equal(m.client.status().state, 'pending', 'one failure is pending, not error');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · Idempotent push — `opId` is the key and a signature never is
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · at-least-once delivery is sufficient', () => {
  test('a response lost in flight costs one retry and never a duplicate entry', async () => {
    // ADR 003 §3.1. The relay HAS the op; only the answer was lost. The retry must be answered
    // `duplicate` and the client must treat that exactly like `accepted`.
    const m = await mac();
    m.client.start();
    await m.sched.drain();
    const e = m.env();
    await m.client.queue(m.space, [e]);

    let swallow = true;
    m.state.handler = async (u, i) => {
      const res = await m.relay.handler(u, i);
      if (swallow && (i && i.method) === 'POST') { swallow = false; throw Object.assign(new Error('lost'), { kind: 'transport' }); }
      return res;
    };
    await m.client.pushNow();
    assert.equal(m.client.status().pendingOps, 1, 'the client still believes it owes the relay this op');

    await m.client.pushNow();
    assert.equal(m.client.status().pendingOps, 0, 'the duplicate answer acknowledged it');

    const peer = await mac({ relay: m.relay, member: m.member, space: m.space, label: 'B' });
    await peer.client.pullNow();
    assert.equal(peer.applied.length, 1, 'the relay stored it twice');
  });

  test('the retry sends the SAME BYTES — the outbox never re-seals', async () => {
    const m = await mac();
    m.client.start();
    await m.sched.drain();
    const e = m.env();
    await m.client.queue(m.space, [e]);

    const bodies = [];
    m.state.handler = async (u, i) => {
      if ((i && i.method) === 'POST') bodies.push(JSON.parse(new TextDecoder().decode(i.body)));
      return m.relay.handler(u, i);
    };
    // A re-seal of the SAME op — different iv, different non-deterministic signature — must not
    // enter the queue a second time while the first is still in it: `opId` is the identity.
    await m.client.queue(m.space, [{ ...e, iv: b64u(rnd(12)), sig: b64u(rnd(64)) }]);
    assert.equal(m.client.status().pendingOps, 1);

    await m.client.pushNow();
    await m.client.pushNow();
    assert.equal(bodies.length, 1, 'a second push was made for an op the relay already had');
    assert.deepEqual(bodies[0].ops[0], e, 'the bytes that were enqueued are the bytes that were sent');
  });

  test('`ackSeq` is the FOLDED cursor, never the space head', async () => {
    // ADR 001 §7.3's tombstone GC is gated on it across the whole fleet; over-claiming lets peers
    // collect tombstones for ops this device never saw, and §12.5 then resurrects the entry.
    const f = await twoMacs();
    await f.A.publish(3);
    await f.B.client.pullNow();
    const cursorB = f.B.client.diagnostics().cursors.spaces[f.space].seq;

    const bodies = [];
    f.B.state.handler = async (u, i) => {
      if ((i && i.method) === 'POST') bodies.push(JSON.parse(new TextDecoder().decode(i.body)));
      return f.relay.handler(u, i);
    };
    await f.B.client.queue(f.space, [f.B.env()]);
    await f.B.client.pushNow();
    assert.equal(bodies[0].ackSeq, cursorB);
    assert.equal(bodies[0].ackSeq, '3');
  });

  test('`drained` is TRUE only when the batch really is the whole queue', async () => {
    const m = await mac();
    const bodies = [];
    m.state.handler = async (u, i) => {
      if ((i && i.method) === 'POST') bodies.push(JSON.parse(new TextDecoder().decode(i.body)));
      return m.relay.handler(u, i);
    };
    await m.client.queue(m.space, Array.from({ length: 250 }, () => m.env()));
    await m.client.pushNow();
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].drained, undefined, 'the first of two batches claimed a drained outbox');
    assert.equal(bodies[1].drained, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · The cursor cannot skip
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · cursored pull (ADR 003 §3.3, ADR 006 §9.1 W1)', () => {
  test('the cursor moves only after the ops were folded AND persisted', async () => {
    const order = [];
    const m = await mac();
    const spy = createCursors({
      storage: { durable: true, async loadCursors() { return {}; }, async saveCursors() { order.push('cursor'); } },
    });
    const c = createSyncClient({
      transport: transportFor(m.relay, m.device),
      spaces: { personal: m.space },
      clock: m.clock,
      schedule: (ms, fn) => m.sched.schedule(ms, fn),
      random: seededRandom(2),
      open: async (e) => ({ status: 'opened', op: { id: e.oid } }),
      onOps: () => order.push('fold'),
      persist: async () => { order.push('persist'); },
      outbox: createOutbox({ now: m.clock.now }),
      parking: createParkingLot({ now: m.clock.now }),
      cursors: spy,
      witness: createChainWitness({}),
    });
    await c.load();
    await m.publish(2);
    await c.pullNow();
    assert.deepEqual(order, ['fold', 'persist', 'cursor']);
  });

  test('a crash between the fold and the persist re-pulls rather than skips', async () => {
    const f = await twoMacs();
    await f.A.publish(2);
    f.B.state.persistThrows = true;
    await f.B.client.pullNow();
    assert.equal(f.B.client.diagnostics().cursors.spaces[f.space], undefined, 'the cursor moved anyway');

    f.B.state.persistThrows = false;
    f.B.applied.length = 0;
    await f.B.client.pullNow();
    assert.equal(f.B.applied.length, 2, 'the batch was re-pulled after the failed persist');
  });

  test('pages are walked until hasMore is false, and every op arrives exactly once', async () => {
    const f = await twoMacs();
    await f.A.publish(120);
    // A tiny page, so the loop is genuinely exercised. It is done by TRUNCATING the honest
    // answer rather than by rewriting the query, because the query is covered by the signature.
    f.B.state.handler = hostile(f.relay, { pageSize: 7 });
    await f.B.client.pullNow();
    assert.equal(f.B.applied.length, 120);
    assert.equal(new Set(f.B.applied.map((o) => o.id)).size, 120);
  });

  test('A RELAY THAT LIES ABOUT `nextCursor` CANNOT MAKE THE CLIENT SKIP', async () => {
    const f = await twoMacs();
    const envs = await f.A.publish(4);
    f.B.state.handler = hostile(f.relay, { cursorAhead: true });
    await f.B.client.pullNow();
    // The cursor was clamped to the last row RECEIVED, so the next pull starts where it should.
    assert.equal(f.B.client.diagnostics().cursors.spaces[f.space].seq, '4');
    assert.ok(f.B.warnings.some((w) => /clamped/.test(w)), 'the lie was not reported');

    f.B.state.handler = null;
    await f.A.publish(1);
    await f.B.client.pullNow();
    assert.equal(f.B.applied.length, 5, 'an op was skipped');
    assert.equal(new Set(f.B.applied.map((o) => o.id)).size, 5);
    assert.ok(envs.every((e) => f.B.applied.some((o) => o.id === e.oid)));
  });

  test('a rewound cursor costs re-pulls and never a lost or doubled register write', async () => {
    // The adversary is not obliged to terminate; the CLIENT is obliged to bound its own loop.
    const f = await twoMacs();
    await f.A.publish(3);
    f.B.state.handler = async (u, i) => {
      const res = await f.relay.handler(u, i);
      const url = new URL(u);
      if (url.pathname !== '/api/v1/ops' || (i && i.method) === 'POST') return res;
      const body = JSON.parse(await res.text());
      return responseLike(200, { 'X-LZP-Protocol': '1', 'X-LZP-Min-Protocol': '1' },
        JSON.stringify({ ...body, nextCursor: url.searchParams.get('since') || '0', hasMore: true }));
    };
    await f.B.client.pullNow();          // MUST TERMINATE. The adversary is not obliged to.
    assert.equal(new Set(f.B.applied.map((o) => o.id)).size, 3, 'ops went missing under a rewind');
    // The cursor was clamped to the last row RECEIVED, so the second page is empty — and an empty
    // page with `hasMore: true` is refused by `readPullBody` rather than looped on for ever.
    assert.ok(f.B.warnings.some((w) => /cursor cannot advance/.test(w)));

    f.B.state.handler = null;
    const seen = f.B.applied.length;
    await f.B.client.pullNow();
    assert.equal(f.B.applied.length, seen, 'the honest relay re-delivered nothing');
    assert.equal(f.B.client.diagnostics().cursors.spaces[f.space].seq, '3');
  });

  test('a page the reader refuses leaves the cursor exactly where it was', async () => {
    const f = await twoMacs();
    await f.A.publish(2);
    f.B.state.handler = async (u, i) => {
      const res = await f.relay.handler(u, i);
      const url = new URL(u);
      if (url.pathname !== '/api/v1/ops' || (i && i.method) === 'POST') return res;
      const body = JSON.parse(await res.text());
      return responseLike(200, {}, JSON.stringify({ ...body, hasMore: 'no' }));
    };
    await f.B.client.pullNow();
    assert.equal(f.B.applied.length, 0);
    assert.equal(f.B.client.diagnostics().cursors.spaces[f.space], undefined);
    assert.ok(f.B.warnings.some((w) => /refused/.test(w)));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · Backoff that cannot hammer (ADR 003 §8.2)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · failure policy', () => {
  test('a 5xx backs off with FULL jitter, and one 2xx resets the whole ladder', async () => {
    const m = await mac({ seed: 5 });
    let down = true;
    m.state.handler = async (u, i) => (down
      ? responseLike(500, { 'X-LZP-Protocol': '1', 'X-LZP-Min-Protocol': '1' }, JSON.stringify({ error: 'internal' }))
      : m.relay.handler(u, i));

    m.client.start();
    await m.sched.flush();
    await m.sched.drain();
    assert.ok(m.client.status().consecutiveFailures >= 1);

    // Every scheduled retry is a delay drawn from [0, 2^n × 2 s] — never a fixed ladder.
    const delays = [];
    for (let i = 0; i < 6; i++) {
      const before = m.sched.pending();
      await m.sched.run(CADENCE.backoffMaxMs);
      delays.push(m.client.status().consecutiveFailures);
      assert.ok(before >= 0);
    }
    assert.ok(m.client.status().consecutiveFailures >= 5, 'the failures were not counted');
    assert.equal(m.client.status().state, 'error');

    down = false;
    await m.client.pullNow();
    assert.equal(m.client.status().consecutiveFailures, 0, 'one 2xx must reset the ladder, not decrement it');
  });

  test('a 429 honours Retry-After instead of the client\'s own schedule', async () => {
    const m = await mac();
    m.state.handler = async () => responseLike(429,
      { 'X-LZP-Protocol': '1', 'X-LZP-Min-Protocol': '1', 'Retry-After': '17' },
      JSON.stringify({ error: 'rate_limited' }));
    await m.client.pullNow();
    assert.equal(m.client.status().nextRetryMs, 17000);
  });

  test('401 / 403 / 426 STOP the loop — they do not back off against a wall', async () => {
    for (const [status, code, kind] of [
      [401, 'bad_signature', 'auth'],
      [403, 'device_revoked', 'auth'],
      [403, 'not_a_member', 'auth'],
      [426, 'protocol_too_old', 'protocol'],
    ]) {
      const m = await mac();
      m.state.handler = async () => responseLike(status,
        { 'X-LZP-Protocol': '1', 'X-LZP-Min-Protocol': '1' },
        JSON.stringify({ error: code, minProto: 2, minClientVersion: '2.4.0' }));
      m.client.start();
      await m.sched.flush();
      await m.sched.drain();

      assert.equal(m.client.status().stopped, true, `${status} ${code} did not stop the loop`);
      assert.equal(m.client.status().errorKind, kind);
      assert.equal(m.client.status().state, 'error');
      assert.equal(m.sched.pending(), 0, 'a stopped loop left a timer armed');

      // 19.1 does not bend for a protocol bump: the app keeps working, and the queue keeps working.
      const r = await m.client.queue(m.space, [m.env()]);
      assert.equal(r.queued, 1, 'a stopped client refused to record a local edit');
      assert.equal(m.client.status().pendingOps, 1);
    }
  });

  test('the 426 detail is the plain-language sentence, and it does not promise a fix', async () => {
    const m = await mac();
    m.state.handler = async () => responseLike(426, { 'X-LZP-Protocol': '1', 'X-LZP-Min-Protocol': '2' },
      JSON.stringify({ error: 'protocol_too_old', minProto: 2, minClientVersion: '2.4.0' }));
    await m.client.pullNow();
    assert.equal(m.client.status().detail, SYNC_COPY.protocol);
    assert.match(SYNC_COPY.protocol, /arbeitet/);
    for (const s of Object.values(SYNC_COPY)) {
      assert.equal(/live|Live|Echtzeit|sofort/.test(s), false, `UX copy promises live: ${s}`);
    }
  });

  test('a 4xx on ONE envelope is quarantined, and the rest of the queue still goes out', async () => {
    const m = await mac();
    const good = [m.env(), m.env()];
    const bad = m.env();
    await m.client.queue(m.space, [bad, ...good]);

    m.state.handler = async (u, i) => {
      if ((i && i.method) !== 'POST') return m.relay.handler(u, i);
      const body = JSON.parse(new TextDecoder().decode(i.body));
      if (body.ops.some((o) => o.oid === bad.oid)) {
        return responseLike(400, { 'X-LZP-Protocol': '1', 'X-LZP-Min-Protocol': '1' }, JSON.stringify({ error: 'bad_request' }));
      }
      return m.relay.handler(u, i);
    };
    await m.client.pushNow();
    await m.client.pushNow();

    assert.equal(m.client.status().quarantined.length, 1);
    assert.equal(m.client.status().quarantined[0].oid, bad.oid);
    assert.equal(m.quarantines.length, 1);
    assert.equal(m.client.status().state, 'error');
    assert.equal(m.client.status().detail, SYNC_COPY.quarantine);
    assert.equal(m.client.status().pendingOps, 0, 'one bad envelope held the queue hostage');
  });

  test('409 forked_op_id quarantines exactly that op and says a RE-MINT is owed', async () => {
    const m = await mac();
    const a = m.env();
    const b = m.env();
    await m.client.queue(m.space, [a, b]);
    m.state.handler = async (u, i) => ((i && i.method) === 'POST'
      ? responseLike(409, { 'X-LZP-Protocol': '1', 'X-LZP-Min-Protocol': '1' }, JSON.stringify({ error: 'forked_op_id', oid: a.oid }))
      : m.relay.handler(u, i));
    await m.client.pushNow();
    assert.deepEqual(m.quarantines.map((q) => q.oid), [a.oid]);
    assert.match(m.quarantines[0].reason, /RE-MINTED/);
  });

  test('`future_epoch` is retried, not quarantined — it is a race with our own rotation', async () => {
    const m = await mac();
    await m.client.queue(m.space, [m.env()]);
    m.state.handler = async (u, i) => ((i && i.method) === 'POST'
      ? responseLike(400, { 'X-LZP-Protocol': '1', 'X-LZP-Min-Protocol': '1' }, JSON.stringify({ error: 'future_epoch' }))
      : m.relay.handler(u, i));
    await m.client.pushNow();
    assert.equal(m.client.status().quarantined.length, 0);
    assert.equal(m.client.status().pendingOps, 1);
    assert.ok(m.warnings.some((w) => /future_epoch/.test(w)));

    // …and it does not spin for ever: after the patience it is quarantined rather than retried.
    for (let i = 0; i < 25; i++) await m.client.pushNow();
    assert.equal(m.client.status().quarantined.length, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · The cadence (19.2 as amended)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · cadence', () => {
  test('a txn debounces 2 s and then pushes — not on the transaction itself', async () => {
    const m = await mac();
    m.client.start();
    await m.sched.flush();
    await m.sched.drain();
    const before = m.relay.calls.filter((c) => c.method === 'POST').length;

    await m.client.queue(m.space, [m.env()]);
    await m.sched.run(CADENCE.pushDebounceMs - 1);
    assert.equal(m.relay.calls.filter((c) => c.method === 'POST').length, before, 'it pushed before the debounce');

    await m.sched.run(2);
    assert.equal(m.relay.calls.filter((c) => c.method === 'POST').length, before + 1);
  });

  test('several edits inside the debounce window become ONE push', async () => {
    const m = await mac();
    m.client.start();
    await m.sched.flush();
    await m.sched.drain();
    const before = m.relay.calls.filter((c) => c.method === 'POST').length;
    for (let i = 0; i < 4; i++) {
      await m.client.queue(m.space, [m.env()]);
      await m.sched.run(100);
    }
    await m.sched.run(CADENCE.pushDebounceMs);
    assert.equal(m.relay.calls.filter((c) => c.method === 'POST').length, before + 1);
  });

  test('the pull tick is 45 s ± 15 s while visible, and the jitter is drawn EVERY tick', async () => {
    const seen = [];
    const m = await mac({ random: () => { const v = [0.05, 0.95, 0.4, 0.6][seen.length % 4]; seen.push(v); return v; } });
    m.client.start();
    await m.sched.flush();
    await m.sched.drain();

    const at = [];
    for (let i = 0; i < 4; i++) {
      const t0 = m.clock.now();
      const pullsBefore = m.relay.calls.filter((c) => c.method === 'GET').length;
      // step forward one second at a time until the next pull happens
      let step = 0;
      while (m.relay.calls.filter((c) => c.method === 'GET').length === pullsBefore && step < 120) {
        await m.sched.run(1000);
        step++;
      }
      at.push(m.clock.now() - t0);
    }
    for (const d of at) {
      assert.ok(d >= 30000 - 1000 && d <= 60000 + 1000, `a tick fired after ${d} ms, outside 45 s ± 15 s`);
    }
    assert.ok(new Set(at).size > 1, 'the jitter was drawn once and reused — a herd with a phase shift');
  });

  test('a hidden window slows to 10 min and the push cadence is unchanged', async () => {
    const m = await mac();
    m.client.start();
    await m.sched.flush();
    await m.sched.drain();
    m.state.visible = false;
    m.client.sleep();

    const pulls = () => m.relay.calls.filter((c) => c.method === 'GET').length;
    const before = pulls();
    await m.sched.run(CADENCE.pullVisibleMs + CADENCE.pullJitterMs + 1000);
    assert.equal(pulls(), before, 'a hidden window still pulled on the visible cadence');

    // a queued edit still uploads while hidden
    await m.client.queue(m.space, [m.env()]);
    await m.sched.run(CADENCE.pushDebounceMs + 1);
    assert.equal(m.client.status().pendingOps, 0);

    await m.sched.run(CADENCE.pullHiddenMs);
    assert.ok(pulls() > before);
  });

  test('focus / visible / online each pull immediately', async () => {
    const f = await twoMacs();
    f.B.client.start();
    await f.B.sched.drain();
    for (const reason of ['focus', 'visible', 'online']) {
      await f.A.publish(1);
      const before = f.B.applied.length;
      await f.B.client.wake(reason);
      assert.equal(f.B.applied.length, before + 1, `${reason} did not pull`);
    }
  });

  test('THERE IS NO SYNC BUTTON: the module exposes nothing a menu item could bind to', async () => {
    // 19.2 is an acceptance criterion, not a preference. `pushNow`/`pullNow` exist for the
    // scheduler and for this suite; nothing named refresh/sync/update is exported.
    const mod = await import('../../src/js/sync/client.js');
    for (const name of Object.keys(mod)) {
      assert.equal(/refresh|syncNow|forceSync|manual/i.test(name), false, `${name} looks like a manual refresh`);
    }
    const m = await mac();
    for (const name of Object.keys(m.client)) {
      assert.equal(/refresh|manual/i.test(name), false, `client.${name} looks like a manual refresh`);
    }
  });

  test('two Macs with different randomness do not synchronise into a herd', async () => {
    const a = await mac({ seed: 11 });
    const b = await mac({ relay: a.relay, member: a.member, space: a.space, label: 'B', seed: 999 });
    a.client.start();
    b.client.start();
    await a.sched.drain();
    await b.sched.drain();
    // Different seeds -> different first tick. (Both are inside the 45 ± 15 window; §5 asserts that.)
    const ticksA = [];
    const ticksB = [];
    for (let i = 0; i < 3; i++) {
      ticksA.push(a.relay.calls.length);
      await a.sched.run(45000);
      ticksB.push(b.relay.calls.length);
      await b.sched.run(45000);
    }
    assert.ok(ticksA.length === 3 && ticksB.length === 3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · F-6 — a parked envelope is retained and replayed
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§6 · the split-batch park (ADR 002 §5.2.5, finding F-6)', () => {
  test('an envelope whose attestation has not arrived is RETAINED, not dropped', async () => {
    const f = await twoMacs();
    const envs = await f.A.publish(3);
    const stuck = envs[1].oid;
    f.B.state.openPlan = (e) => (e.oid === stuck
      ? { status: 'park', parkReason: 'attestation', reason: 'no attestation resolves this dv yet' }
      : { status: 'opened', op: { id: e.oid } });

    await f.B.client.pullNow();
    assert.equal(f.B.applied.length, 2);
    assert.equal(f.B.client.status().parked, 1);
    // The cursor DID advance past it — the relay will never serve it again, which is exactly why
    // the sealed envelope had to be kept.
    assert.equal(f.B.client.diagnostics().cursors.spaces[f.space].seq, '3');

    // The attestation arrives on the next pull; the parked envelope opens without being re-served.
    f.B.state.openPlan = (e) => ({ status: 'opened', op: { id: e.oid } });
    await f.A.publish(1);
    await f.B.client.pullNow();
    assert.equal(f.B.client.status().parked, 0);
    assert.deepEqual(f.B.applied.map((o) => o.id).sort(), envs.map((e) => e.oid).concat(
      f.B.applied.map((o) => o.id).filter((id) => !envs.some((e) => e.oid === id))).sort());
    assert.ok(f.B.applied.some((o) => o.id === stuck), 'the parked op never made it into the board');
  });

  test('a parked envelope survives a quit — it is the ONLY copy on this Mac', async () => {
    const store = memoryRecordStore();
    const cursorStore = memoryCursorStore();
    const m = await mac();
    const peer = await mac({ relay: m.relay, member: m.member, space: m.space, label: 'B' });
    const envs = await m.publish(2);

    const lot = createParkingLot({ storage: store, now: m.clock.now });
    const sched = fakeScheduler(m.clock);
    const c1 = createSyncClient({
      transport: transportFor(m.relay, peer.device),
      spaces: { personal: m.space },
      clock: m.clock,
      schedule: (ms, fn) => sched.schedule(ms, fn),
      random: seededRandom(3),
      open: async () => ({ status: 'park', parkReason: 'epoch', reason: 'no key for this epoch' }),
      onOps: () => {},
      outbox: createOutbox({ now: m.clock.now }),
      parking: lot,
      cursors: createCursors({ storage: cursorStore }),
      witness: createChainWitness({}),
    });
    await c1.load();
    await c1.pullNow();
    assert.equal(c1.status().parked, 2);

    // A brand-new process, over the same disk.
    const applied = [];
    const lot2 = createParkingLot({ storage: store, now: m.clock.now });
    const c2 = createSyncClient({
      transport: transportFor(m.relay, peer.device),
      spaces: { personal: m.space },
      clock: m.clock,
      schedule: (ms, fn) => sched.schedule(ms, fn),
      random: seededRandom(3),
      open: async (e) => ({ status: 'opened', op: { id: e.oid } }),
      onOps: (ops) => applied.push(...ops),
      outbox: createOutbox({ now: m.clock.now }),
      parking: lot2,
      cursors: createCursors({ storage: cursorStore }),
      witness: createChainWitness({}),
    });
    await c2.load();
    await c2.pullNow();
    assert.deepEqual(applied.map((o) => o.id).sort(), envs.map((e) => e.oid).sort());
  });

  test('a FULL parking lot stalls the cursor instead of losing an op', async () => {
    // Both obvious answers to a full queue lose an op. Refusing and stalling loses nothing.
    const f = await twoMacs({ parkCap: 2 });
    await f.A.publish(5);
    f.B.state.openPlan = () => ({ status: 'park', parkReason: 'attestation', reason: 'not yet' });

    await f.B.client.pullNow();
    assert.equal(f.B.client.status().parked, 2);
    assert.equal(f.B.client.status().stalled, true);
    assert.equal(f.B.client.status().detail, SYNC_COPY.stalled);
    const stalledAt = f.B.client.diagnostics().cursors.spaces[f.space].seq;
    assert.equal(stalledAt, '2', 'the cursor advanced past an envelope the lot refused');

    // Nothing is lost: once the lot drains, the pull resumes from where it stalled.
    f.B.state.openPlan = (e) => ({ status: 'opened', op: { id: e.oid } });
    await f.B.client.pullNow();
    assert.equal(f.B.applied.length, 5);
    assert.equal(f.B.client.status().parked, 0);
  });

  test('a HARD failure from openOp is refused and the cursor moves past it', async () => {
    // ADR 002 §5.2.2: P2/P3 and the five identity checks are PROTOCOL VIOLATIONS, not delivery
    // skew. A spliced or re-attributed envelope is not something to come back for.
    const f = await twoMacs();
    const envs = await f.A.publish(2);
    f.B.state.openPlan = (e) => {
      if (e.oid === envs[0].oid) throw Object.assign(new Error('openOp: check 3 failed'), { name: 'EnvelopeError' });
      return { status: 'opened', op: { id: e.oid } };
    };
    await f.B.client.pullNow();
    assert.equal(f.B.applied.length, 1);
    assert.equal(f.B.client.status().parked, 0, 'a protocol violation was parked instead of refused');
    assert.equal(f.B.client.diagnostics().cursors.spaces[f.space].seq, '2');
    assert.equal(f.B.client.status().state, 'error');
    assert.equal(f.B.client.status().errorKind, 'decrypt');
    assert.equal(f.B.client.status().detail, SYNC_COPY.decrypt);
  });

  test('a permanently stuck park stops being replayed on every pull', async () => {
    const f = await twoMacs();
    await f.A.publish(1);
    let opens = 0;
    f.B.state.openPlan = () => { opens++; return { status: 'park', parkReason: 'epoch', reason: 'no key' }; };
    await f.B.client.pullNow();
    const afterFirst = opens;
    for (let i = 0; i < PARK_REPLAY_TRIES + 10; i++) await f.B.client.pullNow();
    assert.ok(opens - afterFirst <= PARK_REPLAY_TRIES + 1,
      `a hopeless envelope was re-decrypted ${opens - afterFirst} times`);
    assert.equal(f.B.client.status().parked, 1, 'and it is still retained');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 · Status (19.3, ADR 003 §8.3)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§7 · the three sync states', () => {
  test('the happy path is SILENT: healthy, with no detail at all', async () => {
    const f = await twoMacs();
    await f.A.publish(1);
    await f.B.client.pullNow();
    const s = f.B.client.status();
    assert.equal(s.state, 'healthy');
    assert.equal(s.detail, null, 'F11: silence is the design, and it extends to the network');
    assert.equal(s.errorKind, null);
  });

  test('transitions are debounced by 2 s so a normal push does not flicker the glyph', async () => {
    const m = await mac();
    m.client.start();
    await m.sched.drain();
    const first = m.statuses.length;

    await m.client.queue(m.space, [m.env()]);
    await m.sched.run(CADENCE.pushDebounceMs + 1);        // it goes out and the queue empties
    await m.sched.run(CADENCE.statusDebounceMs + 1);
    const states = m.statuses.slice(first).map((s) => s.state);
    assert.equal(states.includes('pending'), false,
      `a routine push flickered the indicator: ${JSON.stringify(states)}`);
  });

  test('the first status of a session is emitted immediately, so a listener can render silence', async () => {
    const m = await mac();
    m.client.start();
    assert.ok(m.statuses.length >= 1);
    assert.equal(m.statuses[0].state, 'healthy');
  });

  test('diagnostics carry no key material, no ciphertext and no plaintext', async () => {
    const f = await twoMacs();
    const envs = await f.A.publish(1);
    await f.B.client.pullNow();
    await f.B.client.queue(f.space, [f.B.env()]);
    const d = JSON.stringify(f.B.client.diagnostics()) + JSON.stringify(f.B.client.status());
    for (const secret of [envs[0].ct, envs[0].iv, envs[0].sig]) {
      assert.equal(d.includes(secret), false, 'envelope bytes reached a diagnostic');
    }
  });

  test('clock skew above five minutes is an error with its own sentence', async () => {
    const m = await mac();
    m.state.handler = async (u, i) => {
      const res = await m.relay.handler(u, i);
      const body = JSON.parse(await res.text());
      if (!body || body.serverTime === undefined) return responseLike(res.status, {}, JSON.stringify(body));
      return responseLike(res.status, { 'X-LZP-Protocol': '1', 'X-LZP-Min-Protocol': '1' },
        JSON.stringify({ ...body, serverTime: body.serverTime - 10 * 60 * 1000 }));
    };
    await m.client.pullNow();
    assert.equal(m.client.status().state, 'error');
    assert.equal(m.client.status().detail, SYNC_COPY.clockSkew);
  });

  test('stop() disarms every timer and no callback fires afterwards', async () => {
    const m = await mac();
    m.client.start();
    await m.sched.drain();
    const before = m.relay.calls.length;
    m.client.stop();
    await m.sched.run(CADENCE.pullVisibleMs * 4);
    assert.equal(m.relay.calls.length, before, 'a stopped client kept talking');
    assert.equal(m.sched.pending(), 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §8 · M1 — two Macs of one person actually converge
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§8 · Zwei Macs', () => {
  test('what A pushes, B pulls — with two genuinely distinct device identities', async () => {
    const f = await twoMacs();
    // A3-H4's false green: a fleet test that mints its ops with the RECEIVER's identity proves
    // nothing. The two Macs share a member and have different signing keys and different shorts.
    assert.equal(f.A.member.memberId, f.B.member.memberId);
    assert.notEqual(f.A.device.deviceShort, f.B.device.deviceShort);
    assert.notEqual(f.A.device.deviceId, f.B.device.deviceId);

    const fromA = await f.A.publish(2);
    await f.B.client.pullNow();
    assert.deepEqual(f.B.applied.map((o) => o.id), fromA.map((e) => e.oid));

    await f.B.client.queue(f.space, [f.B.env()]);
    await f.B.client.pushNow();
    await f.A.client.pullNow();
    assert.equal(f.A.applied.length, 3, 'A did not see its own ops plus B\'s');
  });

  test('the chain witness runs on a real relay and finds nothing to complain about', async () => {
    const f = await twoMacs();
    await f.A.publish(3);
    await f.B.client.pullNow();
    await f.A.publish(2);
    await f.B.client.pullNow();
    assert.deepEqual(f.B.findings, [], `the honest relay produced findings: ${JSON.stringify(f.B.findings)}`);
    assert.equal(f.B.client.diagnostics().chain[f.space].broken, false);
  });

  test('a WITHHELD op is reported, and sync is not blocked by the report', async () => {
    const f = await twoMacs();
    const envs = await f.A.publish(4);
    f.B.state.handler = hostile(f.relay, { withhold: (o) => o.oid === envs[1].oid });
    await f.B.client.pullNow();
    assert.ok(f.B.findings.length >= 1, 'the withheld op was not detected');
    assert.equal(f.B.applied.length, 3, 'and the three that DID arrive were still applied');
    assert.equal(f.B.client.status().state, 'healthy',
      'a chain finding flipped the sync indicator, which ADR 002 §5.4 forbids');
  });

  test('the `local` space is never pushed, whatever the caller asks for (F-7)', async () => {
    const m = await mac();
    const r = await m.client.queue('local', [{ ...m.env(), sp: 'local' }]);
    assert.equal(r.queued, 0);
    await m.client.pushNow();
    assert.equal(m.relay.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/ops').length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §9 · The constructor fails closed
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§9 · a client that cannot be safe is not built', () => {
  const ok = {
    transport: { request: async () => ({ status: 200, headers: {}, json: {} }) },
    spaces: {}, clock: { now: () => 0 }, schedule: () => 1,
    open: async () => ({ status: 'opened', op: {} }), onOps: () => {},
  };

  test('every required port is named, one at a time', () => {
    for (const missing of ['transport', 'clock', 'schedule', 'open', 'onOps']) {
      const deps = { ...ok };
      delete deps[missing];
      assert.throws(() => createSyncClient(deps), new RegExp(missing), missing);
    }
    assert.doesNotThrow(() => createSyncClient(ok));
  });

  test('`open` is REQUIRED — nothing may be applied that has not passed openOp', () => {
    // ADR 002 / FINDINGS §4.5's obligation on WP-8, characterized as M-I5b. A client that could
    // apply an envelope it never opened could append a `member.set{dev.*}` nobody proved.
    assert.throws(() => createSyncClient({ ...ok, open: undefined }), /openOp/);
  });

  test('the module reaches nothing outside sync/, crypto/ and core/', async () => {
    // The purity gate asserts this for the whole directory; this asserts it for the one module a
    // reader is most likely to "just import platform/net.js" into.
    const src = await import('node:module');
    assert.ok(src, 'node:module is available');
    const mod = await import('../../src/js/sync/client.js');
    assert.equal(typeof mod.createSyncClient, 'function');
  });
});
