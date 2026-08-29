// TIER 1 · LZP-501 · `src/js/sync/outbox.js` and `src/js/sync/cursor.js`.
// Stories 19.1, 19.6 · ADR 003 §3.1, §3.3, §8.1, §8.2 · ADR 006 §9.1 (W1) · findings F-6, F-7.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS ACTUALLY AT STAKE IN THESE TWO SMALL FILES
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Everything else in this system is forgiving. Ops merge by set union, a duplicate costs nothing,
// a re-push is answered 200. There are exactly three values whose corruption is silent,
// permanent and one-sided, and all three live here:
//
//   1. THE CURSOR. Advance it past an op that was not folded and that op is gone, on one device,
//      for ever, with nothing red anywhere. `advance()` therefore RUNS the commit rather than
//      trusting a caller to have run it — ADR 003 §3.3's ordering, made structural.
//   2. THE OUTBOX. Drop an entry before the relay has it and the edit exists nowhere else.
//      Re-seal one on retry and the relay answers `409 forked_op_id` for ever.
//   3. THE PARK. Finding F-6: an envelope whose attestation has not arrived is PARKED, not
//      rejected — and once the cursor is past it the relay will never serve it again. If the park
//      is not durable, first contact loses data.
//
// §5 is the one that should be read closely: the parking lot's CAP. Every bounded queue has to
// answer "what happens when it is full", and both obvious answers — drop the oldest, drop the
// newest — lose an op. The answer here is to refuse and STALL, and the test asserts the caller
// is told so it can hold the cursor still.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createOutbox, createParkingLot, memoryRecordStore, PARK_CAP,
} from '../../src/js/sync/outbox.js';
import { createCursors, memoryCursorStore } from '../../src/js/sync/cursor.js';
import { LIMITS } from '../../src/js/sync/protocol.js';
import { b64u } from '../../src/js/core/b64.js';

const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const SPACE = 'psp_9xQ2mR7bL0aZ4tV8wKQ1rT';
const FAMILY = 'fsp_9xQ2mR7bL0aZ4tV8wKQ1rT';
const DV = '7QAR2MZ9XKPNC0GV';

function env(space = SPACE, over = {}) {
  return {
    v: 1, sp: space, ep: 1, dv: DV, oid: b64u(rnd(16)), wit: '',
    iv: b64u(rnd(12)), ct: b64u(rnd(48)), sig: b64u(rnd(64)), ...over,
  };
}

/** A clock a test drives, so nothing in this file reads a wall clock. */
function tick(start = 1000) {
  let t = start;
  return { now: () => t, advance(ms) { t += ms; return t; } };
}

/** A record store whose disk can be made to fail, and whose contents a test can inspect. */
function flakyStore() {
  let held = [];
  const s = {
    durable: true,
    failNextSave: false,
    saves: 0,
    failLoad: false,
    async loadRecords() {
      if (s.failLoad) throw new Error('disk is on fire');
      return JSON.parse(JSON.stringify(held));
    },
    async saveRecords(list) {
      if (s.failNextSave) { s.failNextSave = false; throw new Error('disk is full'); }
      s.saves++;
      held = JSON.parse(JSON.stringify(list));
    },
    peek() { return JSON.parse(JSON.stringify(held)); },
  };
  return s;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · The outbox holds SEALED envelopes and never re-seals
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · the outbox is a durable queue of sealed bytes', () => {
  test('what goes in is byte-identical to what comes out, for ever', async () => {
    // ADR 003 §8.1, and `server/core/handlers/ops.js` reports it as a CLIENT OBLIGATION: the relay
    // is blind, so it cannot tell an honest re-seal (fresh iv, fresh non-deterministic signature,
    // same plaintext) from a genuine opId collision. A client that re-sealed on retry would meet
    // 409 on every retry and would be right to call it a defect — its own.
    const store = flakyStore();
    const ob = createOutbox({ storage: store, now: tick().now });
    await ob.load();
    const e = env();
    await ob.enqueue(SPACE, [e]);

    for (let retry = 0; retry < 5; retry++) {
      const batch = ob.peek(SPACE, 200);
      assert.equal(batch.length, 1);
      assert.deepEqual(batch[0], e, `retry ${retry} handed back different bytes`);
    }
  });

  test('it survives a quit: a fresh outbox over the same store holds the same queue', async () => {
    const store = flakyStore();
    const a = createOutbox({ storage: store, now: tick().now });
    await a.load();
    const e1 = env();
    const e2 = env();
    await a.enqueue(SPACE, [e1, e2]);

    const b = createOutbox({ storage: store, now: tick().now });
    assert.equal(await b.load(), 2);
    assert.deepEqual(b.peek(SPACE, 10), [e1, e2], 'and in the same order');
  });

  test('`opId` is the identity — a second enqueue of the same oid is a no-op', async () => {
    // ADR 002 §1 rule 1: ECDSA is non-deterministic, so two seals of one op differ in `sig`.
    // Keying dedupe on the bytes would classify every honest retry as a new op.
    const ob = createOutbox({ now: tick().now });
    await ob.load();
    const e = env();
    const resealed = { ...e, iv: b64u(rnd(12)), sig: b64u(rnd(64)) };   // same oid, different bytes
    await ob.enqueue(SPACE, [e]);
    const r = await ob.enqueue(SPACE, [resealed]);
    assert.equal(r.queued, 0);
    assert.equal(ob.size(SPACE), 1);
    assert.deepEqual(ob.peek(SPACE, 10)[0], e, 'the FIRST seal is the one that is kept');
  });

  test('FIFO, and the batch is capped at ADR 003 §6.1\'s 200', async () => {
    const ob = createOutbox({ now: tick().now });
    await ob.load();
    const many = Array.from({ length: 450 }, () => env());
    await ob.enqueue(SPACE, many);
    assert.equal(ob.size(SPACE), 450);

    const first = ob.peek(SPACE, 1000);
    assert.equal(first.length, LIMITS.opsPerPush);
    assert.deepEqual(first.map((e) => e.oid), many.slice(0, 200).map((e) => e.oid));

    // Three weeks offline is ⌈n/200⌉ batches and no special case (story 19.6).
    await ob.ack(SPACE, first.map((e) => e.oid));
    assert.deepEqual(ob.peek(SPACE, 1000).map((e) => e.oid), many.slice(200, 400).map((e) => e.oid));
  });

  test('there is no size limit and no expiry — three weeks of edits all survive', async () => {
    const clock = tick();
    const ob = createOutbox({ now: clock.now });
    await ob.load();
    for (let day = 0; day < 21; day++) {
      await ob.enqueue(SPACE, [env(), env(), env()]);
      clock.advance(24 * 3600 * 1000);
    }
    assert.equal(ob.size(SPACE), 63);
    assert.equal(ob.oldest(SPACE), 1000, 'the oldest entry kept its authoring instant');
  });
});

describe('§1b · what the outbox refuses to take', () => {
  test('THE LOCAL SPACE NEVER REACHES A WIRE (F-7, rule U6, ADR 001 §9)', async () => {
    // `pref.set` is settings — device-local, never synced (17.7). A settings change arriving at
    // the relay would be a privacy regression with no story behind it.
    const warns = [];
    const ob = createOutbox({ now: tick().now, warn: (m) => warns.push(m) });
    await ob.load();
    const r = await ob.enqueue('local', [env('local')]);
    assert.equal(r.queued, 0);
    assert.equal(ob.size(), 0);
    assert.match(warns.join('\n'), /local/);
  });

  test('a space that is not a SpaceId is refused, including the personal placeholder', async () => {
    const ob = createOutbox({ now: tick().now });
    await ob.load();
    for (const s of ['personal', '', 'psp_short', 'fsp_' + 'x'.repeat(23), null, undefined, 42]) {
      const r = await ob.enqueue(s, [env(SPACE)]);
      assert.equal(r.queued, 0, `${JSON.stringify(s)} was accepted`);
    }
    assert.equal(ob.size(), 0);
  });

  test('an envelope whose `sp` disagrees with the space it is filed under is refused', async () => {
    // The AAD binds `sp`, so such an envelope could never be opened anywhere, and pushing it earns
    // `400 space_mismatch` for ever.
    const ob = createOutbox({ now: tick().now });
    await ob.load();
    const r = await ob.enqueue(SPACE, [env(FAMILY)]);
    assert.equal(r.queued, 0);
    assert.equal(r.refused[0].why, 'not a sealed envelope for this space');
  });

  test('every malformed envelope shape is refused one at a time, and the good one still passes', async () => {
    const ob = createOutbox({ now: tick().now });
    await ob.load();
    const mutants = {
      'a tenth field': (e) => { e.extra = 1; },
      'no oid': (e) => { delete e.oid; },
      'oid is 21 chars': (e) => { e.oid = e.oid.slice(1); },
      'ep is zero': (e) => { e.ep = 0; },
      'ep is a string': (e) => { e.ep = '1'; },
      'no sig': (e) => { delete e.sig; },
    };
    for (const [name, mutate] of Object.entries(mutants)) {
      const e = env();
      mutate(e);
      const r = await ob.enqueue(SPACE, [e]);
      assert.equal(r.queued, 0, `${name} was accepted`);
    }
    for (const v of [null, undefined, 3, 'x', []]) {
      assert.equal((await ob.enqueue(SPACE, [v])).queued, 0);
    }
    assert.equal((await ob.enqueue(SPACE, [env()])).queued, 1, 'the refusals above were not vacuous');
  });

  test('a stored row that is not a sealed envelope is skipped on load, not fatal', async () => {
    const store = flakyStore();
    const ob = createOutbox({ storage: store, now: tick().now });
    await ob.load();
    await ob.enqueue(SPACE, [env()]);
    const rows = store.peek();
    rows.push({ space: SPACE, env: { junk: true } }, null, 42);
    await store.saveRecords(rows);

    const warns = [];
    const b = createOutbox({ storage: store, now: tick().now, warn: (m) => warns.push(m) });
    assert.equal(await b.load(), 1);
    assert.ok(warns.length >= 1);
  });

  test('a store that cannot be read starts empty and says so — it never refuses to sync', async () => {
    const store = flakyStore();
    store.failLoad = true;
    const warns = [];
    const ob = createOutbox({ storage: store, now: tick().now, warn: (m) => warns.push(m) });
    assert.equal(await ob.load(), 0);
    assert.match(warns.join('\n'), /could not be read/);
  });
});

describe('§1c · acknowledgement and quarantine', () => {
  test('`accepted` and `duplicate` are treated identically — ack removes either', async () => {
    const ob = createOutbox({ now: tick().now });
    await ob.load();
    const e1 = env();
    const e2 = env();
    await ob.enqueue(SPACE, [e1, e2]);
    assert.equal(await ob.ack(SPACE, [e1.oid, e2.oid]), 2);
    assert.equal(ob.size(SPACE), 0);
    assert.equal(ob.drained(SPACE), true);
  });

  test('an ack for a space this entry is not in removes nothing', async () => {
    const ob = createOutbox({ now: tick().now });
    await ob.load();
    const e = env();
    await ob.enqueue(SPACE, [e]);
    assert.equal(await ob.ack(FAMILY, [e.oid]), 0);
    assert.equal(ob.size(SPACE), 1);
  });

  test('a quarantined entry leaves the queue, stays on disk, and is reported', async () => {
    // ADR 003 §8.2: "a permanently rejected op must never silently spin forever". And principle 6:
    // nothing is ever lost — the sealed envelope is still the only copy of that authoring event
    // outside the log.
    const store = flakyStore();
    const warns = [];
    const ob = createOutbox({ storage: store, now: tick().now, warn: (m) => warns.push(m) });
    await ob.load();
    const e = env();
    await ob.enqueue(SPACE, [e]);
    assert.equal(await ob.quarantine(SPACE, e.oid, '409 forked_op_id'), true);

    assert.equal(ob.size(SPACE), 0, 'it is out of the queue');
    assert.deepEqual(ob.peek(SPACE, 10), [], 'and is never handed to a push again');
    assert.equal(ob.quarantined().length, 1);
    assert.equal(ob.quarantined()[0].oid, e.oid);
    assert.deepEqual(ob.envelopeOf(SPACE, e.oid), e, 'the bytes are still there for an export or a re-mint');
    assert.match(warns.join('\n'), /on this Mac and on no other/);

    // It survives a restart as a quarantine, not as a queued op.
    const b = createOutbox({ storage: store, now: tick().now });
    await b.load();
    assert.equal(b.size(SPACE), 0);
    assert.equal(b.quarantined().length, 1);
  });

  test('quarantining twice, or an unknown oid, is a no-op', async () => {
    const ob = createOutbox({ now: tick().now });
    await ob.load();
    const e = env();
    await ob.enqueue(SPACE, [e]);
    assert.equal(await ob.quarantine(SPACE, e.oid, 'x'), true);
    assert.equal(await ob.quarantine(SPACE, e.oid, 'y'), false);
    assert.equal(await ob.quarantine(SPACE, 'AAAAAAAAAAAAAAAAAAAAAA', 'z'), false);
  });

  test('a failed persist keeps the queue in memory and says what was risked', async () => {
    const store = flakyStore();
    const warns = [];
    const ob = createOutbox({ storage: store, now: tick().now, warn: (m) => warns.push(m) });
    await ob.load();
    store.failNextSave = true;
    await ob.enqueue(SPACE, [env()]);
    assert.equal(ob.size(SPACE), 1, 'the op is still queued for this session');
    assert.match(warns.join('\n'), /could not be persisted/);
    assert.equal(ob.diagnostics().durable, true);
  });

  test('diagnostics carry counts and ids — never an iv, a ct or a sig', async () => {
    const ob = createOutbox({ now: tick().now });
    await ob.load();
    const e = env();
    await ob.enqueue(SPACE, [e, env()]);
    await ob.quarantine(SPACE, e.oid, 'refused');
    const d = JSON.stringify(ob.diagnostics());
    for (const secret of [e.iv, e.ct, e.sig]) {
      assert.equal(d.includes(secret), false, 'envelope bytes reached diagnostics()');
    }
    assert.equal(ob.diagnostics().queued, 1);
    assert.equal(ob.diagnostics().durable, false, 'an in-memory store says so rather than pretending');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · The cursor cannot move before the batch is durable (ADR 003 §3.3, ADR 006 §9.1 W1)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · advance() runs the commit — the ordering is structural, not remembered', () => {
  test('the commit runs BEFORE the cursor is persisted, every time', async () => {
    const order = [];
    const store = {
      durable: true,
      async loadCursors() { return {}; },
      async saveCursors() { order.push('persist-cursor'); },
    };
    const c = createCursors({ storage: store });
    await c.load();
    await c.advance(SPACE, '10', { seq: '10', chain: 'aaaa' }, async () => { order.push('fold+persist-board'); });
    assert.deepEqual(order, ['fold+persist-board', 'persist-cursor']);
  });

  test('a commit that throws leaves the cursor exactly where it was', async () => {
    // "A crash mid-pull re-fetches rather than skips." Re-applying is free (ADR 001 §6); skipping
    // is permanent.
    const c = createCursors({ storage: memoryCursorStore({ [SPACE]: { seq: '5', chain: 'a', fromGenesis: true } }) });
    await c.load();
    await assert.rejects(() => c.advance(SPACE, '10', null, async () => { throw new Error('board.json is full'); }));
    assert.equal(c.get(SPACE), '5');
  });

  test('there is NO way to move the cursor without a commit', async () => {
    const c = createCursors({});
    await c.load();
    assert.equal(typeof c.set, 'undefined',
      'sync.contract.js §3 declares set(space, seq); implementing it would BE the hazard this module prevents');
    await assert.rejects(() => c.advance(SPACE, '1', null, undefined), /commit/);
    await assert.rejects(() => c.advance(SPACE, '1', null, 'not a function'), /commit/);
    assert.equal(c.get(SPACE), '0');
  });

  test('a cursor store that refuses the write rolls the cursor BACK, not forward', async () => {
    // The safe direction: the next launch re-pulls from the older cursor and re-applies
    // idempotently. The opposite would be the loss this module exists to prevent.
    let fail = false;
    const store = {
      durable: true,
      async loadCursors() { return {}; },
      async saveCursors() { if (fail) throw new Error('disk full'); },
    };
    const warns = [];
    const c = createCursors({ storage: store, warn: (m) => warns.push(m) });
    await c.load();
    await c.advance(SPACE, '5', { seq: '5', chain: 'a' }, async () => {});
    fail = true;
    let committed = false;
    const moved = await c.advance(SPACE, '9', { seq: '9', chain: 'b' }, async () => { committed = true; });
    assert.equal(committed, true, 'the batch WAS folded');
    assert.equal(moved, false);
    assert.equal(c.get(SPACE), '5', 'and the cursor did not move, so the batch is re-pulled');
    assert.match(warns.join('\n'), /re-pulled/);
  });
});

describe('§2b · a cursor is monotone, canonical, and per space', () => {
  test('it refuses to move backwards, loudly', async () => {
    const warns = [];
    const c = createCursors({ storage: memoryCursorStore({ [SPACE]: { seq: '100' } }), warn: (m) => warns.push(m) });
    await c.load();
    let ran = false;
    assert.equal(await c.advance(SPACE, '99', null, async () => { ran = true; }), false);
    assert.equal(ran, false, 'and it does not even run the commit');
    assert.equal(c.get(SPACE), '100');
    assert.match(warns.join('\n'), /BACKWARDS/);
  });

  test('advancing to the SAME seq is allowed and reports "did not move"', async () => {
    // An empty page returns the caller's own cursor (ADR 003 §3.2). That must be a no-op, not a
    // refusal — the parked-envelope replay commits through this same path.
    const c = createCursors({});
    await c.load();
    await c.advance(SPACE, '5', { seq: '5', chain: 'a' }, async () => {});
    let ran = false;
    assert.equal(await c.advance(SPACE, '5', null, async () => { ran = true; }), false);
    assert.equal(ran, true);
  });

  test('a non-canonical seq is refused, not coerced', async () => {
    const c = createCursors({});
    await c.load();
    for (const v of ['007', ' 5', '5.0', '-1', 'x', '', null, undefined, {}, 5.5]) {
      assert.equal(await c.advance(SPACE, v, null, async () => {}), false, JSON.stringify(v));
    }
    assert.equal(c.get(SPACE), '0');
  });

  test('spaces are independent and the chain head rides with the cursor', async () => {
    const store = memoryCursorStore();
    const c = createCursors({ storage: store });
    await c.load();
    await c.advance(SPACE, '5', { seq: '5', chain: 'aaa' }, async () => {}, { fromGenesis: true });
    await c.advance(FAMILY, '9', { seq: '9', chain: 'bbb' }, async () => {});
    assert.equal(c.get(SPACE), '5');
    assert.equal(c.get(FAMILY), '9');
    assert.deepEqual(c.head(SPACE), { seq: '5', chain: 'aaa' });
    assert.equal(c.fromGenesis(SPACE), true);
    assert.equal(c.fromGenesis(FAMILY), false);

    // and both come back after a restart, together
    const d = createCursors({ storage: store });
    await d.load();
    assert.deepEqual(d.head(SPACE), { seq: '5', chain: 'aaa' });
    assert.equal(d.get(FAMILY), '9');
    assert.equal(d.fromGenesis(SPACE), true);
  });

  // ── R9-1 · INVERTED 2026-08-29 ─────────────────────────────────────────────────────────────
  //
  // This row read *"`fromGenesis` is sticky once true — one full pull earns it for good"* and it
  // was green because `advance()` could raise the flag and never lower it. Round 9's chain-witness
  // pass found that the flag is not a reward for a past pull; it is THE RIGHT TO CALL AN UNKNOWN
  // `wit` A FORK, and `chain.js` gives that right up the instant a break makes verification
  // unprovable from genesis. A ratchet hands the right back at the next launch, so the device
  // accuses an honest relay of a fork it can no longer prove — the false positive ADR 002 §5.4
  // forbids in one sentence. Now a boolean is WRITTEN in either direction; only omission carries
  // the stored value forward. Mutant **M-H**.
  test('R9-1 · `fromGenesis` is REPORTED, not ratcheted — a device may give the right up', async () => {
    const c = createCursors({});
    await c.load();
    await c.advance(SPACE, '5', { seq: '5', chain: 'a' }, async () => {}, { fromGenesis: true });
    assert.equal(c.fromGenesis(SPACE), true, 'a pull from genesis earns it');
    await c.advance(SPACE, '6', { seq: '6', chain: 'b' }, async () => {}, { fromGenesis: false });
    assert.equal(c.fromGenesis(SPACE), false,
      'and a break that makes it unprovable takes it away again — DURABLY, which is the point');
    // Omission is not a claim in either direction: a caller with nothing to say changes nothing.
    await c.advance(SPACE, '7', { seq: '7', chain: 'c' }, async () => {});
    assert.equal(c.fromGenesis(SPACE), false);
    await c.advance(SPACE, '8', { seq: '8', chain: 'd' }, async () => {}, { fromGenesis: true });
    await c.advance(SPACE, '9', { seq: '9', chain: 'e' }, async () => {});
    assert.equal(c.fromGenesis(SPACE), true, 'omission carries the STORED value, not `false`');
  });

  test('a hand-edited or truncated record degrades to 0 and warns, never throws', async () => {
    const warns = [];
    const c = createCursors({
      storage: memoryCursorStore({
        a: { seq: 'nonsense' }, b: [], c: 'also nonsense', d: null, e: { chain: 'x' },
        [SPACE]: '42',                       // the tolerated shorthand: a bare seq
        [FAMILY]: { seq: '7', chain: 'z', fromGenesis: true },
      }),
      warn: (m) => warns.push(m),
    });
    await c.load();
    assert.equal(c.get(SPACE), '42');
    assert.equal(c.head(SPACE), null, 'the shorthand restores the cursor and forgoes verification');
    assert.equal(c.get(FAMILY), '7');
    assert.deepEqual(c.spaces().sort(), [FAMILY, SPACE].sort());
    assert.ok(warns.length >= 4, `only ${warns.length} warnings for five broken records`);
  });

  test('forget() drops a deleted space so a re-created id starts from 0', async () => {
    const c = createCursors({});
    await c.load();
    await c.advance(SPACE, '9', { seq: '9', chain: 'a' }, async () => {});
    assert.equal(await c.forget(SPACE), true);
    assert.equal(c.get(SPACE), '0');
    assert.equal(await c.forget(SPACE), false);
  });

  test('diagnostics say whether the store is durable at all', async () => {
    const c = createCursors({});
    await c.load();
    assert.equal(c.diagnostics().durable, false, 'the in-memory default must not claim durability');
    assert.equal(c.diagnostics().loaded, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · The parking lot — finding F-6
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · a parked envelope is retained, unopened, and survives a quit', () => {
  test('the SEALED envelope is what is kept — it was never decrypted', async () => {
    // ADR 002 §5.2.1 correction 1: `att === null` is a PRE-decrypt gate, so what is parked is a
    // sealed envelope. "The outbox/inbox must be able to hold an envelope it has never decrypted."
    const store = flakyStore();
    const lot = createParkingLot({ storage: store, now: tick().now });
    await lot.load();
    const e = env();
    assert.equal(await lot.park(SPACE, e, '17', 'attestation'), true);

    const back = createParkingLot({ storage: store, now: tick().now });
    assert.equal(await back.load(), 1);
    const rows = back.parked(SPACE);
    assert.deepEqual(rows[0].env, e);
    assert.equal(rows[0].seq, '17');
    assert.equal(rows[0].reason, 'attestation');
  });

  test('re-parking the same envelope updates the reason and counts a try', async () => {
    const lot = createParkingLot({ now: tick().now });
    await lot.load();
    const e = env();
    await lot.park(SPACE, e, '1', 'attestation');
    await lot.park(SPACE, e, '1', 'epoch');
    assert.equal(lot.size(), 1);
    assert.equal(lot.parked(SPACE)[0].reason, 'epoch');
    assert.equal(lot.parked(SPACE)[0].tries, 1);
  });

  test('release() takes the ones that opened; touch() records the ones that did not', async () => {
    const lot = createParkingLot({ now: tick().now });
    await lot.load();
    const a = env();
    const b = env();
    await lot.park(SPACE, a, '1', 'attestation');
    await lot.park(SPACE, b, '2', 'epoch');
    assert.equal(await lot.release(SPACE, [a.oid]), 1);
    assert.equal(lot.size(SPACE), 1);
    assert.equal(await lot.touch(SPACE, [b.oid]), 1);
    assert.equal(lot.parked(SPACE)[0].tries, 1);
  });

  test('parking something that is not an envelope does not stall the caller', async () => {
    // It returns `true` — "not parkable, but not a reason to hold the cursor". Returning false
    // here would let one malformed row freeze a space's sync for ever.
    const warns = [];
    const lot = createParkingLot({ now: tick().now, warn: (m) => warns.push(m) });
    await lot.load();
    assert.equal(await lot.park(SPACE, { junk: true }, '1', 'attestation'), true);
    assert.equal(lot.size(), 0);
    assert.ok(warns.length >= 1);
  });

  test('diagnostics group by reason, and carry no envelope bytes', async () => {
    const lot = createParkingLot({ now: tick().now });
    await lot.load();
    const e = env();
    await lot.park(SPACE, e, '1', 'attestation');
    await lot.park(SPACE, env(), '2', 'attestation');
    await lot.park(SPACE, env(), '3', 'epoch');
    assert.deepEqual(lot.diagnostics().byReason, { attestation: 2, epoch: 1 });
    assert.equal(JSON.stringify(lot.diagnostics()).includes(e.ct), false);
  });
});

describe('§4 · the cap, and what happens AT the cap', () => {
  test('the lot refuses rather than dropping — and the refusal is how the caller knows to stall', async () => {
    // Both obvious answers to a full queue lose an op: drop the newest loses it, drop the oldest
    // loses that one. Refusing and stalling loses nothing; the pull just stops advancing.
    const warns = [];
    const lot = createParkingLot({ now: tick().now, warn: (m) => warns.push(m), cap: 3 });
    await lot.load();
    const kept = [env(), env(), env()];
    for (const e of kept) assert.equal(await lot.park(SPACE, e, '1', 'attestation'), true);

    const refused = env();
    assert.equal(await lot.park(SPACE, refused, '4', 'attestation'), false);
    assert.equal(lot.size(), 3);
    assert.deepEqual(lot.parked(SPACE).map((r) => r.oid), kept.map((e) => e.oid),
      'the ones already parked are exactly the ones still parked');
    assert.equal(lot.overflowed, 1);
    assert.match(warns.join('\n'), /will NOT advance/);
  });

  test('space made by a release is space the lot will use again', async () => {
    const lot = createParkingLot({ now: tick().now, cap: 2 });
    await lot.load();
    const a = env();
    await lot.park(SPACE, a, '1', 'attestation');
    await lot.park(SPACE, env(), '2', 'attestation');
    assert.equal(await lot.park(SPACE, env(), '3', 'attestation'), false);
    await lot.release(SPACE, [a.oid]);
    assert.equal(await lot.park(SPACE, env(), '3', 'attestation'), true);
  });

  test('the default cap is a real number and it is not zero', () => {
    assert.equal(Number.isInteger(PARK_CAP), true);
    assert.ok(PARK_CAP >= 1000, `a cap of ${PARK_CAP} would stall a normal catch-up`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · The default stores are honest about not being durable
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · an undurable seam is visible rather than assumed', () => {
  test('the in-memory stores report `durable: false` in every diagnostic', async () => {
    const ob = createOutbox({});
    const lot = createParkingLot({});
    const c = createCursors({});
    await Promise.all([ob.load(), lot.load(), c.load()]);
    assert.equal(ob.diagnostics().durable, false);
    assert.equal(lot.diagnostics().durable, false);
    assert.equal(c.diagnostics().durable, false);
  });

  test('memoryRecordStore and memoryCursorStore deep-copy, so a caller cannot mutate the disk', async () => {
    const s = memoryRecordStore([{ space: SPACE, env: env() }]);
    const first = await s.loadRecords();
    first[0].space = 'tampered';
    const second = await s.loadRecords();
    assert.equal(second[0].space, SPACE);

    const c = memoryCursorStore({ [SPACE]: { seq: '1' } });
    const a = await c.loadCursors();
    a[SPACE].seq = '999';
    assert.equal((await c.loadCursors())[SPACE].seq, '1');
  });
});
