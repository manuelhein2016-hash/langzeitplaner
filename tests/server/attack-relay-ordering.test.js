// ATTACK · T1 — BREAK GAPLESSNESS AND PER-SPACE ORDERING UNDER CONCURRENCY.
//
// This is the attack whose success looks like nothing at all. ADR 003 §3.3 makes `seq` a
// per-space, gapless, monotone counter assigned inside the same transaction as the batch insert,
// and gives the reason in one sentence: `WHERE seq > cursor` over a gappy counter SKIPS, and a
// skip is one member's afternoon, gone, with a 200 OK and no error anywhere.
//
// So the adversary here is not only the operator. It is the operator PLUS eight family members
// pushing at once on a Sunday evening, which is when the family actually uses this. Everything
// below runs both adapters, and the invariant asserted is never "the page looked right" — it is:
//
//   · every assigned `seq` is unique, contiguous from 1, and never reused;
//   · a retry, a rejected batch and a rolled-back transaction all burn ZERO numbers;
//   · the UNION of every page a paging client fetches equals the whole log, each seq exactly
//     once, even while writers are appending between pages;
//   · two spaces never share a counter.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE CANNOT PROVE, STATED UP FRONT
// ═════════════════════════════════════════════════════════════════════════════════════════════
// `memory.js` and `file.js` serialise transactions with an in-process mutex, so what is proved
// here is that the HANDLER and the ENGINE are correct given a serialising store. Production is
// `prisma.js`, whose `UNVERIFIED_CLAIMS` include `U-SEQ` — "two pushes take the same seq and one
// member's afternoon is gone with a 200 OK" — and no machine in this repository has a Postgres to
// settle it. §5 asserts that the claim is still DECLARED rather than quietly dropped, because a
// removed claim is how an unverified property becomes a believed one.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADAPTERS, T0, fakeClock, relay, seedSpace, sealFor, spaceKey, b64u, chainAfter,
} from './_attack-relay-kit.js';
import { UNVERIFIED_CLAIMS } from '../../server/adapters/prisma.js';
import { STORE_CONTRACT_CASES } from '../../server/core/store-interface.js';

const SPACE = 'fsp_ORDERINGaaaaaaaaaaaaaz';
const OTHER = 'fsp_ORDERINGbbbbbbbbbbbbbz';

/** Four devices across two members — a plausible family evening. */
async function family(adapter, spaceId) {
  const clock = fakeClock(T0);
  const h = adapter.make(clock);
  const seeded = await seedSpace(h, clock, {
    id: spaceId || SPACE,
    members: [{ name: 'Papa', colorRef: 'gruen', devices: 2 }, { name: 'Mama', colorRef: 'blau', devices: 2 }],
  });
  return { clock, h, r: relay(h, clock), key: await spaceKey(), devs: seeded.members.flatMap((m) => m.devices), seeded };
}

for (const adapter of ADAPTERS) {
  const T = (name, fn) => test(`[${adapter.name}] ${name}`, fn);

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §1 Concurrent pushes
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('FAILED — 4 devices × 10 batches launched at once still produce 1..N exactly once', async () => {
    const { h, r, key, devs } = await family(adapter);

    // Every request is built BEFORE any is sent, so the sends really do overlap rather than
    // queueing behind an await inside the loop.
    const sends = [];
    let n = 0;
    for (const dev of devs) {
      for (let b = 0; b < 10; b++) {
        const ops = [];
        for (let i = 0; i < 3; i++) {
          ops.push(await sealFor(key, dev, { space: SPACE, n: ++n, op: { k: 'note', text: `x${n}` } }));
        }
        sends.push({ dev, body: { space: SPACE, ops } });
      }
    }
    const results = await Promise.all(sends.map((s) =>
      r.send({ method: 'POST', path: '/api/v1/ops', dev: s.dev, body: s.body })));

    for (const res of results) assert.equal(res.status, 200, JSON.stringify(res.body));

    const assigned = results.flatMap((res) => res.body.accepted.map((a) => Number(a.seq)));
    assert.equal(assigned.length, 120, '4 devices × 10 batches × 3 ops');
    assert.equal(new Set(assigned).size, 120, 'NO SEQ WAS ISSUED TWICE');
    assert.deepEqual(assigned.slice().sort((a, b) => a - b), Array.from({ length: 120 }, (_, i) => i + 1),
      'and the assignment is 1..120 with no hole — a hole is what makes `WHERE seq > cursor` skip');

    // The store agrees with what the callers were told.
    const rows = [...h.dump().ops.get(SPACE).values()].map((o) => Number(o.seq)).sort((a, b) => a - b);
    assert.deepEqual(rows, assigned.slice().sort((a, b) => a - b));
    assert.equal(Number(h.dump().spaces.get(SPACE).nextSeq), 120);
  });

  T('FAILED — a batch retried five times concurrently burns exactly zero extra numbers', async () => {
    const { h, r, key, devs } = await family(adapter);
    const dev = devs[0];
    const ops = [];
    for (let i = 1; i <= 5; i++) ops.push(await sealFor(key, dev, { space: SPACE, n: i, op: { k: 'note', text: 'x' } }));

    // The first push, then five identical retries at once — the shape of a flaky connection.
    const first = await r.send({ method: 'POST', path: '/api/v1/ops', dev, body: { space: SPACE, ops } });
    assert.deepEqual(first.body.accepted.map((a) => a.seq), ['1', '2', '3', '4', '5']);

    const retries = await Promise.all([0, 1, 2, 3, 4].map(() =>
      r.send({ method: 'POST', path: '/api/v1/ops', dev, body: { space: SPACE, ops } })));
    for (const res of retries) {
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.accepted, [], 'a retry accepts nothing…');
      assert.deepEqual(res.body.duplicate.map((d) => d.seq), ['1', '2', '3', '4', '5'],
        '…and reports the EXISTING seq, which is what makes at-least-once delivery sufficient');
    }
    assert.equal(Number(h.dump().spaces.get(SPACE).nextSeq), 5, 'the counter did not move');

    // And the next genuine op is 6, not 6 + (retries × 5).
    const next = await sealFor(key, dev, { space: SPACE, n: 99, op: { k: 'note', text: 'y' } });
    const after = await r.send({ method: 'POST', path: '/api/v1/ops', dev, body: { space: SPACE, ops: [next] } });
    assert.equal(after.body.accepted[0].seq, '6');
  });

  T('FAILED — a batch rejected halfway reserves nothing, so no hole is left for a retry to fall into', async () => {
    const { h, r, key, devs } = await family(adapter);
    const dev = devs[0];
    const good1 = await sealFor(key, dev, { space: SPACE, n: 1, op: { k: 'note', text: 'a' } });
    const good2 = await sealFor(key, dev, { space: SPACE, n: 2, op: { k: 'note', text: 'b' } });
    const bad = { ...(await sealFor(key, dev, { space: SPACE, n: 3, op: { k: 'note', text: 'c' } })), ep: 99 };

    const res = await r.send({ method: 'POST', path: '/api/v1/ops', dev, body: { space: SPACE, ops: [good1, good2, bad] } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'future_epoch');
    assert.equal(Number(h.dump().spaces.get(SPACE).nextSeq), 0,
      'the two valid ops in the rejected batch must not have taken 1 and 2');

    // The client fixes the third op and re-pushes the whole batch. It gets 1, 2, 3.
    const fixed = await sealFor(key, dev, { space: SPACE, n: 3, op: { k: 'note', text: 'c' } });
    const again = await r.send({ method: 'POST', path: '/api/v1/ops', dev, body: { space: SPACE, ops: [good1, good2, fixed] } });
    assert.deepEqual(again.body.accepted.map((a) => a.seq), ['1', '2', '3']);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §2 The chain under concurrency
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('FAILED — the chain is a single total order that agrees with `seq`, however the pushes interleaved', async () => {
    const { r, key, devs } = await family(adapter);
    const sends = [];
    let n = 0;
    for (const dev of devs) {
      for (let b = 0; b < 5; b++) {
        const ops = [await sealFor(key, dev, { space: SPACE, n: ++n, op: { k: 'note', text: 'x' } }),
          await sealFor(key, dev, { space: SPACE, n: ++n, op: { k: 'note', text: 'y' } })];
        sends.push({ dev, body: { space: SPACE, ops } });
      }
    }
    await Promise.all(sends.map((s) => r.send({ method: 'POST', path: '/api/v1/ops', dev: s.dev, body: s.body })));

    const page = await r.send({ method: 'GET', path: '/api/v1/ops', dev: devs[0], query: { space: SPACE } });
    assert.equal(page.body.ops.length, 40);

    // Recompute the whole chain from the ADR. If two concurrent pushes had chained from the same
    // head, this is where it shows: one of the 40 links would not reproduce.
    let prev = null;
    for (const o of page.body.ops) {
      prev = await chainAfter(prev, o.oid);
      assert.equal(b64u(prev), o.chain, `the chain broke at seq ${o.seq}`);
    }
    // …and the served order is strictly ascending, which is the only order the chain can be in.
    const seqs = page.body.ops.map((o) => Number(o.seq));
    assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b));
    assert.deepEqual(seqs, Array.from({ length: 40 }, (_, i) => i + 1));
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §3 The cursor, while writers are still writing
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('FAILED — a paging client interleaved with writers still sees every op exactly once', async () => {
    const { r, key, devs } = await family(adapter);
    const writer = devs[0];
    const reader = devs[3];

    let n = 0;
    const write = async (count) => {
      const ops = [];
      for (let i = 0; i < count; i++) ops.push(await sealFor(key, writer, { space: SPACE, n: ++n, op: { k: 'note', text: 'x' } }));
      const res = await r.send({ method: 'POST', path: '/api/v1/ops', dev: writer, body: { space: SPACE, ops } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    };

    await write(7);
    // Page with limit 2, and append MORE between every page — the race a real 45-second pull loop
    // is in permanently.
    const seen = [];
    let cursor = '0';
    for (let round = 0; round < 12; round++) {
      const page = await r.send({ method: 'GET', path: '/api/v1/ops', dev: reader, query: { space: SPACE, since: cursor, limit: '2' } });
      assert.equal(page.status, 200, JSON.stringify(page.body));
      for (const o of page.body.ops) seen.push(Number(o.seq));
      assert.equal(page.body.nextCursor, page.body.ops.length > 0 ? page.body.ops[page.body.ops.length - 1].seq : cursor,
        'the cursor is the last op RETURNED, never the head — ADR 003 §3.2');
      cursor = page.body.nextCursor;
      if (round % 2 === 0) await write(3);
      if (!page.body.hasMore && page.body.ops.length === 0) break;
    }

    // Everything the reader ever saw, exactly once, in order, with no hole below its own cursor.
    assert.equal(new Set(seen).size, seen.length, 'no op was served twice across pages');
    assert.deepEqual(seen, seen.slice().sort((a, b) => a - b));
    assert.deepEqual(seen, Array.from({ length: seen.length }, (_, i) => i + 1),
      'the union of every page is a gapless prefix — a skip would show as a hole here');
    assert.equal(Number(cursor), seen.length);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §4 Two spaces never share a counter
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('FAILED — concurrent pushes into two spaces do not interleave their numbering', async () => {
    const clock = fakeClock(T0);
    const h = adapter.make(clock);
    const a = await seedSpace(h, clock, { id: SPACE, memberSeed: 1, deviceSeed: 1, members: [{ name: 'a', colorRef: 'gruen', devices: 1 }] });
    const b = await seedSpace(h, clock, { id: OTHER, memberSeed: 50, deviceSeed: 50, members: [{ name: 'b', colorRef: 'gruen', devices: 1 }] });
    const r = relay(h, clock);
    const key = await spaceKey();

    const sends = [];
    let n = 0;
    for (let i = 0; i < 8; i++) {
      sends.push({ dev: a.members[0].devices[0], space: SPACE, env: await sealFor(key, a.members[0].devices[0], { space: SPACE, n: ++n, op: { k: 'n', text: 'x' } }) });
      sends.push({ dev: b.members[0].devices[0], space: OTHER, env: await sealFor(key, b.members[0].devices[0], { space: OTHER, n: ++n, op: { k: 'n', text: 'x' } }) });
    }
    const out = await Promise.all(sends.map((s) =>
      r.send({ method: 'POST', path: '/api/v1/ops', dev: s.dev, body: { space: s.space, ops: [s.env] } })));
    for (const res of out) assert.equal(res.status, 200, JSON.stringify(res.body));

    const state = h.dump();
    for (const space of [SPACE, OTHER]) {
      const seqs = [...state.ops.get(space).values()].map((o) => Number(o.seq)).sort((x, y) => x - y);
      assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8],
        `${space} must number its own ops 1..8 — a shared counter would leave holes that measure `
        + 'the other family\'s traffic');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §5 Rollback
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('FAILED — a throw inside the transaction rolls the counter back with the rows', async () => {
    const { h, clock, key, devs } = await family(adapter);
    const dev = devs[0];
    const env = await sealFor(key, dev, { space: SPACE, n: 1, op: { k: 'note', text: 'x' } });

    // Fail AFTER `upsertOps` has reserved the numbers — the only interesting moment.
    let armed = true;
    const store = new Proxy(h.store, {
      get: (t, k) => (k === 'tx'
        ? (fn) => t.tx(async (tx) => {
          const out = await fn(new Proxy(tx, {
            get: (tt, kk) => (kk === 'setLastSeenSeq' && armed
              ? () => { armed = false; throw new Error('the database went away'); }
              : tt[kk]),
          }));
          return out;
        })
        : t[k]),
    });
    const r2 = relay({ ...h, store }, clock, { store });

    await assert.rejects(() => r2.send({
      method: 'POST', path: '/api/v1/ops', dev,
      body: { space: SPACE, ackSeq: '0', ops: [env] },
    }));

    assert.equal(Number(h.dump().spaces.get(SPACE).nextSeq), 0, 'the reservation was rolled back');
    assert.equal((h.dump().ops.get(SPACE) || new Map()).size, 0, 'and so was the row');

    // The client retries and gets seq 1 — not seq 2 over a hole nobody can fill.
    const again = await r2.send({ method: 'POST', path: '/api/v1/ops', dev, body: { space: SPACE, ops: [env] } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.accepted[0].seq, '1');
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 What is NOT settled — the production adapter
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the Postgres adapter still DECLARES that everything above is unverified there', () => {
  // A removed claim is how an unverified property becomes a believed one. `prisma.js` runs in
  // Frankfurt against a real database with real concurrency; nothing in this repository can
  // execute it, so the honest artefact is the declaration.
  const ids = UNVERIFIED_CLAIMS.map((c) => c.tag);
  assert.ok(ids.includes('U-SEQ'), `U-SEQ must still be declared; saw ${ids}`);
  assert.ok(ids.includes('U-TX'), `U-TX must still be declared; saw ${ids}`);

  const seq = UNVERIFIED_CLAIMS.find((c) => c.tag === 'U-SEQ');
  assert.equal(seq.method, 'reserveSeq');
  assert.match(seq.breaks, /same seq/,
    'and it must still say what breaks: two concurrent pushes taking one number');

  // And the contract suite that would settle them exists and covers ordering, so the day a
  // machine has a `DATABASE_URL` the work is running the cases rather than writing them.
  const tagged = STORE_CONTRACT_CASES.filter((c) => (c.tags || []).some((t) => /seq|tx|ops/.test(t)));
  assert.ok(tagged.length >= 5,
    `expected the store contract to carry ordering cases for prisma to satisfy; saw ${tagged.length}`);
});

test('the ADR states the reason gaplessness is a correctness property and not tidiness', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../docs/v2/adr/003-sync-protocol.md', import.meta.url), 'utf8');
  assert.ok(src.includes('Not a Postgres `SERIAL`/`BIGSERIAL`'),
    'ADR 003 §3.3 must still say why a global sequence is refused');
  assert.ok(src.includes('a silent, intermittent data-loss bug that is very hard to find later'));
});
