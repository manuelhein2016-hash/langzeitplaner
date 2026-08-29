// TIER 1 · LZP-501 · `src/js/sync/chain.js`.  ADR 002 §5.4 · ADR 003 §3.1, §3.3, §10.6.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CLAIM UNDER TEST
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   "The chain witness is how a client detects a LYING RELAY — a withheld op, a reorder, a fork."
//
// A detector is worth exactly what its positives are worth, so this file is built the only way
// that means anything: the chains it verifies are computed by **the real relay**
// (`server/core/handlers/ops.js chainAfter`, over the real memory adapter, reached through the
// real router and the real ADR 003 §2 auth ladder), and the attacks are MUTATIONS of that relay's
// honest answers rather than fabrications. If the client's `chainAfter` and the server's ever
// disagree about a byte, §1 goes red before any attack is even attempted.
//
// The three attacks are ADR 002 §5.4's own three, and each is asserted to be DETECTED and to be
// NON-BLOCKING — "detection-only, best-effort, and it never blocks sync in v2 (a false positive
// that broke a family's board would be far worse than the attack)".
//
// §5 is the part nobody asked for and that matters most: the interaction between the chain and
// `POST /members/remove`, which purges op rows (ADR 003 §6.3) and therefore breaks the chain for
// ever, benignly. A detector that cries wolf after every member removal is a detector that gets
// muted.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  chainAfter, verifyChain, createChainWitness, CHAIN_FINDINGS,
} from '../../src/js/sync/chain.js';
import { readPullBody } from '../../src/js/sync/protocol.js';
import { b64u, ub64 } from '../../src/js/core/b64.js';

import {
  createRelay, makeMember, makeDevice, createSpace, registerDevice, transportFor,
  fakeClock, hostile,
} from '../helpers/sync-loopback.js';

const S = globalThis.crypto.subtle;
const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/**
 * A sealed envelope, as far as the RELAY is concerned. The relay never decrypts — `ct` is decoded
 * exactly once, to measure its length — so a chain test does not need a key ring, and using one
 * would only hide which layer an assertion is about.
 */
function envelope(space, deviceShort, wit) {
  return {
    v: 1, sp: space, ep: 1, dv: deviceShort,
    oid: b64u(rnd(16)),
    wit: wit === undefined ? '' : wit,
    iv: b64u(rnd(12)), ct: b64u(rnd(48)), sig: b64u(rnd(64)),
  };
}

async function twoMacs() {
  const clock = fakeClock();
  const relay = createRelay({ clock });
  const member = await makeMember();
  const A = await makeDevice(member, 'A');
  const B = await makeDevice(member, 'B');
  const space = await createSpace(relay, A, 'PERSONAL');
  await registerDevice(relay, space, B);
  return { relay, clock, member, A, B, space };
}

async function push(relay, device, space, envs, ack = '0') {
  const t = transportFor(relay, device);
  const res = await t.request('POST', '/api/v1/ops', undefined, { space, ackSeq: ack, ops: envs });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json;
}

async function pull(relay, device, space, since = '0', handler) {
  const t = transportFor(relay, device, handler ? { handler } : {});
  const res = await t.request('GET', '/api/v1/ops', { space, since }, undefined);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const read = readPullBody(res, since);
  assert.equal(read.ok, true, read.why);
  return read;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · The client's hash and the relay's hash are one function
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · chainAfter is byte-identical to the relay\'s', () => {
  test('every chain the real relay computed is recomputed exactly by the client', async () => {
    const f = await twoMacs();
    const envs = [envelope(f.space, f.A.deviceShort), envelope(f.space, f.A.deviceShort), envelope(f.space, f.A.deviceShort)];
    await push(f.relay, f.A, f.space, envs);
    const page = await pull(f.relay, f.B, f.space);

    assert.equal(page.ops.length, 3);
    let prev = null;
    for (const row of page.ops) {
      prev = await chainAfter(prev, row.env.oid, {});
      assert.equal(b64u(prev), row.chain, `seq ${row.seq}`);
    }
  });

  test('the FIRST link hashes the opId alone — not a 32-byte zero block', async () => {
    // Getting this wrong makes every chain in the space off by one link, and the mismatch looks
    // exactly like an attack. It is the worst possible false positive for a detector.
    const f = await twoMacs();
    const e = envelope(f.space, f.A.deviceShort);
    await push(f.relay, f.A, f.space, [e]);
    const page = await pull(f.relay, f.B, f.space);

    const fromNull = b64u(await chainAfter(null, e.oid, {}));
    const fromZeros = b64u(await chainAfter(new Uint8Array(32), e.oid, {}));
    assert.equal(page.ops[0].chain, fromNull);
    assert.notEqual(page.ops[0].chain, fromZeros);
  });

  test('the hash is over the opId\'s ASCII bytes, so two spellings would be two chains', async () => {
    const a = b64u(await chainAfter(null, 'AAAAAAAAAAAAAAAAAAAAAA', {}));
    const b = b64u(await chainAfter(null, 'aaaaaaaaaaaaaaaaaaaaaa', {}));
    assert.notEqual(a, b);
    assert.equal(ub64(a).length, 32);
  });

  test('an injected subtle is used, and a missing one is a loud refusal', async () => {
    let calls = 0;
    const spy = { digest: (alg, b) => { calls++; return S.digest(alg, b); } };
    await chainAfter(null, 'AAAAAAAAAAAAAAAAAAAAAA', { subtle: spy });
    assert.equal(calls, 1);
    await assert.rejects(() => chainAfter(null, 'x', { subtle: {} }), /SubtleCrypto/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · The three attacks
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · a lying relay is detected, and sync is not blocked', () => {
  test('WITHHOLD — an op removed from the page leaves a hole `seq` cannot hide', async () => {
    const f = await twoMacs();
    const envs = [0, 1, 2, 3].map(() => envelope(f.space, f.A.deviceShort));
    await push(f.relay, f.A, f.space, envs);

    const censored = envs[1].oid;
    const page = await pull(f.relay, f.B, f.space, '0', hostile(f.relay, { withhold: (o) => o.oid === censored }));
    assert.equal(page.ops.length, 3, 'the relay really did withhold one');

    const w = createChainWitness({});
    const found = await w.observe(f.space, page.ops);
    const kinds = found.map((x) => x.kind);
    assert.ok(kinds.includes(CHAIN_FINDINGS.GAP), `no gap reported: ${JSON.stringify(kinds)}`);
    // AND NOT A MISMATCH — which is the honest answer, not a weaker one. Across a hole the client
    // does not know the missing op's chain, so the next link is UNVERIFIABLE rather than wrong.
    // Claiming a mismatch there would be evidence the client cannot actually produce.
    assert.equal(kinds.includes(CHAIN_FINDINGS.MISMATCH), false,
      'the detector claimed a mismatch it cannot prove across a hole');
    // NON-BLOCKING: the head still advanced, so the caller can still fold and move its cursor.
    assert.equal(w.head(f.space).seq, page.ops[page.ops.length - 1].seq);
  });

  test('WITHHOLD, HOLE CLOSED — a relay that also renumbers `seq` is caught by the hash', async () => {
    // `seq` is NOT in the AAD (ADR 002 §5.1), so a relay is free to renumber a page and hide the
    // gap. This is the case the recomputation exists for, and the case a contiguity check alone
    // would miss completely.
    const f = await twoMacs();
    const envs = [0, 1, 2, 3].map(() => envelope(f.space, f.A.deviceShort));
    await push(f.relay, f.A, f.space, envs);

    const censored = envs[1].oid;
    const page = await pull(f.relay, f.B, f.space, '0',
      hostile(f.relay, { withhold: (o) => o.oid === censored, renumber: true }));
    assert.equal(page.ops.length, 3);
    assert.deepEqual(page.ops.map((o) => o.seq), ['1', '2', '3'], 'the relay closed the hole');

    const w = createChainWitness({});
    const found = await w.observe(f.space, page.ops);
    const kinds = found.map((x) => x.kind);
    assert.equal(kinds.includes(CHAIN_FINDINGS.GAP), false, 'there is no gap to see');
    assert.ok(kinds.includes(CHAIN_FINDINGS.MISMATCH), `the hash did not catch it: ${JSON.stringify(kinds)}`);
    assert.equal(found.find((x) => x.kind === CHAIN_FINDINGS.MISMATCH).seq, '2',
      'the mismatch is reported at the first row that differs');
  });

  test('REORDER — two rows swapped break the recomputation without breaking convergence', async () => {
    const f = await twoMacs();
    const envs = [0, 1, 2].map(() => envelope(f.space, f.A.deviceShort));
    await push(f.relay, f.A, f.space, envs);

    const honest = await pull(f.relay, f.B, f.space);
    const swapped = [honest.ops[1], honest.ops[0], honest.ops[2]];

    const w = createChainWitness({});
    const found = await w.observe(f.space, swapped);
    assert.ok(found.some((x) => x.kind === CHAIN_FINDINGS.MISMATCH), 'a reorder was not detected');
    // …and the honest order produces nothing at all.
    const clean = createChainWitness({});
    assert.deepEqual(await clean.observe(f.space, honest.ops), []);
  });

  test('FORK — a peer committing to a chain this device has never been served is caught', async () => {
    // `wit` is what makes this detectable at all: every op a member authors commits to what that
    // member had seen (ADR 002 §5.4). Here Mac A pushes an op whose witness is a chain from a log
    // Mac B was never shown.
    const f = await twoMacs();
    await push(f.relay, f.A, f.space, [envelope(f.space, f.A.deviceShort)]);

    const w = createChainWitness({});
    const first = await pull(f.relay, f.B, f.space);
    assert.deepEqual(await w.observe(f.space, first.ops), [], 'the first page is clean');
    assert.equal(w.head(f.space).chain, first.ops[0].chain);

    const foreign = b64u(await chainAfter(null, 'ZZZZZZZZZZZZZZZZZZZZZZ', {}));
    await push(f.relay, f.A, f.space, [envelope(f.space, f.A.deviceShort, foreign)]);
    const second = await pull(f.relay, f.B, f.space, first.nextCursor);

    const found = await w.observe(f.space, second.ops);
    const fork = found.find((x) => x.kind === CHAIN_FINDINGS.UNKNOWN_WITNESS);
    assert.ok(fork, `no fork reported: ${JSON.stringify(found.map((x) => x.kind))}`);
    assert.equal(fork.wit, foreign);
    assert.equal(fork.dv, f.A.deviceShort);
  });

  test('the witness this device offers on push is the highest chain it has PULLED', async () => {
    const f = await twoMacs();
    const w = createChainWitness({});
    assert.equal(w.witness(f.space), '', "'' on the first push (ADR 002 §5.1)");

    await push(f.relay, f.A, f.space, [envelope(f.space, f.A.deviceShort), envelope(f.space, f.A.deviceShort)]);
    const page = await pull(f.relay, f.B, f.space);
    await w.observe(f.space, page.ops);
    assert.equal(w.witness(f.space), page.ops[1].chain);

    // And the relay accepts it and hands it back verbatim — the AAD binds `wit`, so a relay that
    // rewrote it would break the GCM tag on every honest client.
    await push(f.relay, f.B, f.space, [envelope(f.space, f.B.deviceShort, w.witness(f.space))], page.nextCursor);
    const back = await pull(f.relay, f.A, f.space, page.nextCursor);
    assert.equal(back.ops[0].env.wit, w.witness(f.space));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · What a device that cannot prove a fork says instead
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · the detector never accuses when it cannot prove', () => {
  test('a device that did not pull from genesis reports `unverifiable`, not `fork`', async () => {
    // A restart restores a cursor and a head, not the whole chain. Calling every unrecognised
    // witness a fork after a restart would be a false positive on every launch.
    const f = await twoMacs();
    await push(f.relay, f.A, f.space, [envelope(f.space, f.A.deviceShort), envelope(f.space, f.A.deviceShort)]);
    const first = await pull(f.relay, f.B, f.space);

    const w = createChainWitness({});
    w.restore(f.space, { seq: first.ops[0].seq, chain: first.ops[0].chain }, false);

    const foreign = b64u(await chainAfter(null, 'YYYYYYYYYYYYYYYYYYYYYY', {}));
    await push(f.relay, f.A, f.space, [envelope(f.space, f.A.deviceShort, foreign)], first.nextCursor);
    const second = await pull(f.relay, f.B, f.space, first.nextCursor);

    const found = await w.observe(f.space, second.ops);
    assert.ok(found.some((x) => x.kind === CHAIN_FINDINGS.UNVERIFIABLE_WITNESS));
    assert.equal(found.some((x) => x.kind === CHAIN_FINDINGS.UNKNOWN_WITNESS), false,
      'a device with a partial chain accused the relay of a fork it cannot prove');
  });

  test('a witness this device HAS seen is never reported, however old', async () => {
    const f = await twoMacs();
    await push(f.relay, f.A, f.space, [envelope(f.space, f.A.deviceShort), envelope(f.space, f.A.deviceShort), envelope(f.space, f.A.deviceShort)]);
    const page = await pull(f.relay, f.B, f.space);

    const w = createChainWitness({});
    await w.observe(f.space, page.ops);
    const old = page.ops[0].chain;                      // two links behind the head

    await push(f.relay, f.A, f.space, [envelope(f.space, f.A.deviceShort, old)], page.nextCursor);
    const next = await pull(f.relay, f.B, f.space, page.nextCursor);
    assert.deepEqual(await w.observe(f.space, next.ops), []);
  });

  test('the witness memory is bounded, and falling out of it is `unverifiable`', async () => {
    const f = await twoMacs();
    const w = createChainWitness({ memory: 2 });
    await push(f.relay, f.A, f.space, [0, 1, 2, 3].map(() => envelope(f.space, f.A.deviceShort)));
    const page = await pull(f.relay, f.B, f.space);
    await w.observe(f.space, page.ops);
    assert.equal(w.snapshot()[f.space].remembered, 2, 'the memory did not stay bounded');

    const evicted = page.ops[0].chain;
    await push(f.relay, f.A, f.space, [envelope(f.space, f.A.deviceShort, evicted)], page.nextCursor);
    const next = await pull(f.relay, f.B, f.space, page.nextCursor);
    const found = await w.observe(f.space, next.ops);
    // It fell out of the window, so the honest answer is "I cannot judge this" — not "fork".
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, CHAIN_FINDINGS.UNKNOWN_WITNESS, 'a genesis-anchored device DOES accuse');
  });

  test('a corrupt stored anchor is reported as ours, and re-anchors instead of accusing', async () => {
    const f = await twoMacs();
    await push(f.relay, f.A, f.space, [envelope(f.space, f.A.deviceShort)]);
    const page = await pull(f.relay, f.B, f.space);
    const r = await verifyChain(page.ops, { seq: '1', chain: '!!!not b64u!!!' }, {});
    assert.equal(r.ok, false);
    assert.equal(r.findings[0].kind, CHAIN_FINDINGS.UNREADABLE);
    assert.match(r.findings[0].detail, /this device cannot prove/);
    assert.notEqual(r.head, null, 'and it still hands back a head to re-anchor on');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · Detection-only: it never blocks, never throws, never refuses a row
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · scope (ADR 002 §5.4)', () => {
  test('nothing in this module throws on hostile input', async () => {
    const w = createChainWitness({});
    for (const rows of [null, undefined, [], 'x', 42, [{}], [{ seq: 'x', chain: 'y', env: {} }]]) {
      const found = await w.observe('psp_AAAAAAAAAAAAAAAAAAAAAA', rows);
      assert.ok(Array.isArray(found), `observe threw or returned ${typeof found} for ${JSON.stringify(rows)}`);
    }
  });

  test('verifyChain on an empty page is clean and moves nothing', async () => {
    const r = await verifyChain([], null, {});
    assert.deepEqual(r.findings, []);
    assert.equal(r.head, null);
    assert.equal(r.ok, true);
  });

  test('the snapshot carries counts and hashes — never a key, never a ciphertext', async () => {
    const f = await twoMacs();
    await push(f.relay, f.A, f.space, [envelope(f.space, f.A.deviceShort)]);
    const page = await pull(f.relay, f.B, f.space);
    const w = createChainWitness({});
    await w.observe(f.space, page.ops);
    const snap = JSON.stringify(w.snapshot());
    for (const forbidden of [page.ops[0].env.ct, page.ops[0].env.sig, page.ops[0].env.iv]) {
      assert.equal(snap.includes(forbidden), false, 'the witness snapshot carries envelope bytes');
    }
    assert.deepEqual(Object.keys(w.snapshot()[f.space]).sort(), ['broken', 'fromGenesis', 'head', 'remembered']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · The interaction nobody wrote down: a member purge breaks the chain, benignly
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · a member removal purges op rows (ADR 003 §6.3) and that is not an attack', () => {
  test('the break is reported ONCE, with the benign cause named', async () => {
    // An alarm that fires on every pull for the rest of a family's life is an alarm that gets
    // muted, and then the real one is muted too.
    const f = await twoMacs();
    const envs = [0, 1, 2, 3].map(() => envelope(f.space, f.A.deviceShort));
    await push(f.relay, f.A, f.space, envs);

    const gone = envs[1].oid;
    const purged = hostile(f.relay, { withhold: (o) => o.oid === gone });
    const w = createChainWitness({});

    const first = await pull(f.relay, f.B, f.space, '0', purged);
    const found1 = await w.observe(f.space, first.ops);
    const breaks = found1.filter((x) => x.kind === CHAIN_FINDINGS.GAP || x.kind === CHAIN_FINDINGS.MISMATCH);
    assert.equal(breaks.length, 1);
    assert.equal(breaks[0].benignCause, 'member-purge',
      'the finding does not name the benign cause, so an operator cannot tell the two apart');
    assert.equal(w.broken(f.space), true);

    // The SAME page observed again says nothing at all: every row is at or below the head, and a
    // re-observation must never manufacture a second alarm about one hole.
    assert.deepEqual(await w.observe(f.space, first.ops), []);
  });

  test('verification RESUMES after the break — a withheld op AFTER a purge is still caught', async () => {
    // The honest ceiling: detection degrades to provable-since-the-last-anchor rather than
    // provable-from-genesis, and the anchor is a value the relay itself served.
    const f = await twoMacs();
    const envs = [0, 1, 2, 3, 4].map(() => envelope(f.space, f.A.deviceShort));
    await push(f.relay, f.A, f.space, envs);

    const w = createChainWitness({});
    const purged = hostile(f.relay, { withhold: (o) => o.oid === envs[1].oid });
    const page = await pull(f.relay, f.B, f.space, '0', purged);
    await w.observe(f.space, page.ops);
    assert.equal(w.broken(f.space), true);

    // Now a SECOND, different lie on a later page: a rewritten chain value.
    await push(f.relay, f.A, f.space, [envelope(f.space, f.A.deviceShort)], page.nextCursor);
    const forged = hostile(f.relay, { rewriteChain: () => b64u(rnd(32)) });
    const later = await pull(f.relay, f.B, f.space, page.nextCursor, forged);
    const found = await w.observe(f.space, later.ops);
    assert.ok(found.some((x) => x.kind === CHAIN_FINDINGS.MISMATCH),
      'after one benign break the detector stopped detecting anything at all');
  });
});
