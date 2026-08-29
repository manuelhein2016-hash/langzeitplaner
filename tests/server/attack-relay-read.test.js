// ATTACK · T1 (the relay operator) — READ THE CONTENT.
//
// ADR 002 §0's T1 holds every envelope, every plaintext header, every IP and every arrival time,
// and holds NO key. The product's central claim (story 21.1, and the first sentence of the
// Datenschutz page) is that this adversary learns nothing readable. This file is the attempt.
//
// It is not `blindness.test.js` again. That file proves the SHAPE is closed — 10 models × 61
// columns, each classified, `PLAINTEXT_STRINGS` total and disjoint — and then searches the store
// after a session. This file is the same adversary standing at the other end: it starts from real
// AES-256-GCM ciphertext over real German, pushes it through the real router, and then does the
// three things an operator with a dump actually does:
//
//   1. `SELECT *` — every row, every column, every Map, and for the file adapter the literal
//      bytes on disk, in three spellings (utf8, latin1, base64-decoded) because a byte column is
//      exactly where text would hide.
//   2. `tail -f` — every log line the handlers emitted during a real session, serialised
//      properly. (The E2 pass found a test regex-scanning `String(line)`, i.e. matching
//      `[object Object]`, which could never fail. `logText()` in the kit serialises.)
//   3. Provoke — nine hostile requests whose bodies, queries, paths and headers carry the
//      family's German, to see whether any error body echoes one back.
//
// EVERY SEARCH HAS A CONTROL. A search that reports "not found" is worthless until the same
// search is shown to report "found" against a store with the text really in it, and §0 does that
// first, before any of the attacks run.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADAPTERS, T0, SECRETS, fakeClock, relay, seedSpace, sealFor, spaceKey,
  readableStrings, findText, opId, assertDocumented, b64u,
} from './_attack-relay-kit.js';
import { MODEL_COLUMNS, PLAINTEXT_STRINGS, OPAQUE_FIELDS } from '../../server/core/store-interface.js';

const SPACE = 'fsp_ATTACKRELAYREADaaAAAAd';

/** The family the whole file attacks: three people, four machines, real German in every op. */
async function household(adapter) {
  const clock = fakeClock(T0);
  const h = adapter.make(clock);
  const seeded = await seedSpace(h, clock, {
    id: SPACE,
    members: [
      { name: 'Papa', colorRef: 'gruen', devices: 2 },
      { name: 'Mama', colorRef: 'blau', devices: 1 },
      { name: 'Kind', colorRef: 'rot', devices: 1 },
    ],
  });
  const r = relay(h, clock);
  const key = await spaceKey();
  return { clock, h, r, key, ...seeded };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 The control — the search is not vacuous
// ═════════════════════════════════════════════════════════════════════════════════════════════

for (const adapter of ADAPTERS) {
  test(`[${adapter.name}] CONTROL — the dump search really does find German when it is there`, async () => {
    const clock = fakeClock(T0);
    const h = adapter.make(clock);
    // `colorRef` is the one String in the schema that carries a user's choice, so it is the one
    // column that will accept this. That is the point: the needle goes in through the ONLY door
    // the schema leaves open, and the search finds it.
    await seedSpace(h, clock, {
      id: SPACE,
      members: [{ name: 'x', colorRef: 'Zahnarzt Mama 14:30', devices: 1 }],
    });
    const found = findText(readableStrings(h.dump()), ['Zahnarzt Mama 14:30']);
    assert.deepEqual(found, ['Zahnarzt Mama 14:30'],
      'if this fails, every "the relay found nothing" result in this file is worthless');
  });

  test(`[${adapter.name}] CONTROL — the search reaches inside a BYTE column, not only Strings`, async () => {
    const clock = fakeClock(T0);
    const h = adapter.make(clock);
    await seedSpace(h, clock, { id: SPACE, members: [{ name: 'x', colorRef: 'gruen', devices: 1 }] });
    // Bypass the handler entirely and write the text into an opaque column as BYTES, which is
    // where a careless implementation would put it. RULE 1 refuses a String there; it cannot
    // refuse bytes, and it should not — bytes are what an envelope is.
    const text = new TextEncoder().encode('Scheidungstermin Anwalt Dr. Weber');
    const pad = new Uint8Array(92 + 256);
    pad.set(text, 0);
    await h.store.upsertOps(SPACE, [{
      opId: opId(1), epoch: 1, deviceShort: (await h.store.listDevices(SPACE))[0].deviceShort,
      witness: null, chain: new Uint8Array(32), envelope: pad,
    }]);
    const found = findText(readableStrings(h.dump()), ['Scheidungstermin Anwalt Dr. Weber']);
    assert.deepEqual(found, ['Scheidungstermin Anwalt Dr. Weber'],
      'a byte column holding UTF-8 text must be findable, or the blindness result is an artefact');
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 The attack: read a column
// ═════════════════════════════════════════════════════════════════════════════════════════════

for (const adapter of ADAPTERS) {
  const T = (name, fn) => test(`[${adapter.name}] ${name}`, fn);

  T('FAILED — a full dump after a real family session contains none of the six German strings', async () => {
    const { h, r, key, members } = await household(adapter);
    const papa = members[0].devices[0];
    const mama = members[1].devices[0];

    // A real session. Six ops, six different German strings, sealed under a key that exists only
    // in this test's closure — the relay was never handed it in any form.
    const ops = [];
    for (const [i, text] of SECRETS.entries()) {
      const dev = i % 2 === 0 ? papa : mama;
      ops.push({ dev, env: await sealFor(key, dev, { space: SPACE, n: i + 1, op: { k: 'note', text } }) });
    }
    for (const { dev, env } of ops) {
      const res = await r.send({ method: 'POST', path: '/api/v1/ops', dev, body: { space: SPACE, ops: [env] } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    // And a pull, so the read path has run too.
    const pulled = await r.send({ method: 'GET', path: '/api/v1/ops', dev: papa, query: { space: SPACE } });
    assert.equal(pulled.status, 200);
    assert.equal(pulled.body.ops.length, 6);

    const hit = findText(readableStrings(h.dump()), SECRETS);
    assert.deepEqual(hit, [], 'the relay read the family');

    // The raw file, unparsed, for the adapter that has one. A dump is bytes before it is rows.
    const raw = h.rawBytes();
    if (raw) {
      for (const s of SECRETS) {
        assert.equal(raw.includes(Buffer.from(s, 'utf8')), false, `${s} is in sync-store.json verbatim`);
        assert.equal(raw.toString('utf8').includes(Buffer.from(s, 'utf8').toString('base64')), false,
          `${s} is in sync-store.json base64-encoded`);
      }
    }
  });

  T('FAILED — and the ciphertext really was the family: the test key opens it, the relay has none', async () => {
    const { h, r, key, members } = await household(adapter);
    const papa = members[0].devices[0];
    const env = await sealFor(key, papa, { space: SPACE, n: 1, op: { k: 'note', text: 'Zahnarzt Mama 14:30' } });
    await r.send({ method: 'POST', path: '/api/v1/ops', dev: papa, body: { space: SPACE, ops: [env] } });

    const page = await r.send({ method: 'GET', path: '/api/v1/ops', dev: papa, query: { space: SPACE } });
    const row = page.body.ops[0];

    // The relay round-tripped the bytes faithfully — so the "nothing found" above is not because
    // the content never arrived. It arrived, it is intact, and it is unreadable without the key.
    const { ub64, TE } = await import('./_attack-relay-kit.js');
    const { unpad } = await import('../../src/js/crypto/envelope.js');
    const aad = TE.encode(`lzp/v2/op\n${JSON.stringify([row.v, row.sp, row.ep, row.dv, row.oid, row.wit])}`);
    const clear = new Uint8Array(await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ub64(row.iv), additionalData: aad, tagLength: 128 }, key, ub64(row.ct)));
    // `unpad` is the shipped inverse of the shipped `pad`, so the round trip proves the relay
    // stored the real thing and not a re-encoding of it.
    assert.equal(new TextDecoder().decode(unpad(clear)),
      JSON.stringify({ k: 'note', text: 'Zahnarzt Mama 14:30' }));
  });

  T('FAILED — the store refuses a readable String in every opaque column, at the adapter boundary', async () => {
    const { h, members } = await household(adapter);
    const dev = members[0].devices[0];
    // RULE 1, enumerated over `OPAQUE_FIELDS` rather than sampled: a column added to that table
    // without a matching type check fails this by name.
    const attempted = [];
    for (const [model, cols] of Object.entries(OPAQUE_FIELDS)) {
      for (const col of cols) {
        if (model !== 'Op') continue;
        attempted.push(col);
        await assert.rejects(
          () => h.store.upsertOps(SPACE, [{
            opId: opId(50), epoch: 1, deviceShort: dev.deviceShort,
            witness: null, chain: new Uint8Array(32), envelope: new Uint8Array(108),
            [col]: 'Zahnarzt Mama 14:30',
          }]),
          (err) => /StoreShapeError|Op\./.test(String(err)),
          `Op.${col} accepted a String`);
      }
    }
    assert.ok(attempted.length >= 3, `expected the Op model to have opaque columns, saw ${attempted}`);
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 The attack: read a log line
// ═════════════════════════════════════════════════════════════════════════════════════════════

for (const adapter of ADAPTERS) {
  test(`[${adapter.name}] FAILED — no log line from a real session carries a byte of content`, async () => {
    const { r, key, members } = await household(adapter);
    const papa = members[0].devices[0];

    for (const [i, text] of SECRETS.entries()) {
      const env = await sealFor(key, papa, { space: SPACE, n: i + 1, op: { k: 'note', text } });
      await r.send({ method: 'POST', path: '/api/v1/ops', dev: papa, body: { space: SPACE, ops: [env] } });
    }
    await r.send({ method: 'GET', path: '/api/v1/ops', dev: papa, query: { space: SPACE } });
    await r.send({ method: 'POST', path: `/api/v1/spaces/${SPACE}/rename`, dev: papa, body: {} });

    assert.ok(r.lines.length >= 8, `expected a real session to log; got ${r.lines.length} lines`);

    const text = r.logText();
    assert.notEqual(text, '', 'the log serialiser produced nothing — this test would pass vacuously');
    assert.ok(text.includes('pushOps'), 'and it must really contain the session');
    for (const s of SECRETS) assert.equal(text.includes(s), false, `${s} reached the log`);

    // Nothing derived from a ciphertext, either — not the envelope, not the iv, not the sig.
    for (const forbidden of ['envelope', '"ct"', '"iv"', '"sig"', 'wrapped', 'boxA', 'delivery']) {
      assert.equal(text.includes(forbidden), false, `${forbidden} reached the log`);
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 The attack: read an error message
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('FAILED — nine hostile requests carrying German in every position; no body echoes one back', async () => {
  const clock = fakeClock(T0);
  const h = ADAPTERS[0].make(clock);
  const { members } = await seedSpace(h, clock, {
    id: SPACE, members: [{ name: 'Papa', colorRef: 'gruen', devices: 1 }],
  });
  const r = relay(h, clock);
  const dev = members[0].devices[0];
  const NEEDLE = 'Zahnarzt Mama 14:30';

  const probes = [
    // The op id — a String field with a strict regex, so the rejection must not quote it.
    { method: 'POST', path: '/api/v1/ops', dev, body: { space: SPACE, ops: [{ v: 1, sp: SPACE, ep: 1, dv: dev.deviceShort, oid: NEEDLE, wit: '', iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAA', sig: 'A'.repeat(86) }] } },
    // A whole extra top-level field, named in German.
    { method: 'POST', path: '/api/v1/ops', dev, body: { space: SPACE, ops: [], [NEEDLE]: NEEDLE } },
    // The space id itself.
    { method: 'POST', path: '/api/v1/ops', dev, body: { space: NEEDLE, ops: [] } },
    // The query string, on the read path.
    { method: 'GET', path: '/api/v1/ops', dev, query: { space: SPACE, since: NEEDLE } },
    { method: 'GET', path: '/api/v1/ops', dev, query: { space: SPACE, limit: NEEDLE } },
    // The PATH — where a URL-shaped leak would live.
    { method: 'GET', path: `/api/v1/pair/${encodeURIComponent(NEEDLE)}` },
    // The rename endpoint, which exists precisely to refuse a readable field.
    { method: 'POST', path: `/api/v1/spaces/${SPACE}/rename`, dev, body: { displayName: NEEDLE } },
    // A wrap addressed to a German recipient id.
    { method: 'POST', path: `/api/v1/spaces/${SPACE}/epoch`, dev, body: { epoch: 2, wraps: [{ recipientId: NEEDLE, epoch: 1, wrapped: b64u(new Uint8Array(64)) }] } },
    // An invite verifier that is text.
    { method: 'POST', path: '/api/v1/invites/redeem', body: { code: NEEDLE } },
  ];

  const statuses = [];
  for (const p of probes) {
    const res = await r.send(p);
    statuses.push(res.status);
    const serialised = JSON.stringify(res.body);
    assert.equal(serialised.includes(NEEDLE), false,
      `an error body echoed the needle: ${serialised}`);
    // And nothing echoed it in a header either (Retry-After is the only header errors carry).
    assert.equal(JSON.stringify(res.headers || {}).includes(NEEDLE), false);
  }
  // Every probe must really have been REJECTED — a 200 would mean the probe was malformed as an
  // attack rather than that the defence held.
  assert.equal(statuses.every((s) => s >= 400), true, `expected all 4xx, got ${statuses}`);

  // The same needle must not have reached the log on the way through, either.
  assert.equal(r.logText().includes(NEEDLE), false);
});

test('FAILED — an unexpected throw becomes `500 internal` with no detail at all', async () => {
  const clock = fakeClock(T0);
  const h = ADAPTERS[0].make(clock);
  const { members } = await seedSpace(h, clock, {
    id: SPACE, members: [{ name: 'Papa', colorRef: 'gruen', devices: 1 }],
  });
  const dev = members[0].devices[0];
  // A store that fails the way a real database fails — with a message built from the query.
  const r = relay(h, clock, {
    store: new Proxy(h.store, {
      get: (t, k) => (k === 'listOps'
        ? () => { throw new Error('ERROR: relation "Op" — near "Zahnarzt Mama 14:30"'); }
        : t[k]),
    }),
  });
  // The router does NOT catch — a non-HttpError propagates to the host. That is the design
  // (`toResponse` is the one shaper and it lives at the host boundary), and it is worth asserting
  // in this direction so that the next line's claim is about the code that really answers.
  let escaped = null;
  await r.send({ method: 'GET', path: '/api/v1/ops', dev, query: { space: SPACE } })
    .catch((err) => { escaped = err; });
  assert.ok(escaped instanceof Error, 'expected the throw to reach the host, not to be swallowed');
  assert.ok(String(escaped.message).includes('Zahnarzt Mama 14:30'),
    'and the leaking message must really be leaking, or the next assertion proves nothing');

  // What the host then puts on the wire. Both hosts use this function and nothing else.
  const { toResponse } = await import('../../server/core/errors.js');
  assert.deepEqual(toResponse(escaped), { status: 500, headers: {}, body: { error: 'internal' } });

  // …and they really do use it. A host that answered from `err.message` would be the leak, and
  // that is a property of two files rather than of a handler, so it is checked by reading them.
  const fs = await import('node:fs');
  for (const host of ['../../server/dev-server.mjs', '../../server/adapters/vercel.js']) {
    const src = fs.readFileSync(new URL(host, import.meta.url), 'utf8');
    assert.match(src, /catch\s*\(\s*err\s*\)\s*\{\s*\n?\s*out = toResponse\(err\);/,
      `${host} must shape a thrown error through toResponse and nothing else`);
    assert.equal(/JSON\.stringify\([^)]*err\.(message|stack)/.test(src), false,
      `${host} serialises a raw error message onto the wire`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 The one thing T1 CAN read — and it is written down
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED — `Member.colorRef` is one palette word per person, in the clear, on every pull', async () => {
  const clock = fakeClock(T0);
  const h = ADAPTERS[0].make(clock);
  const { members } = await seedSpace(h, clock, {
    id: SPACE,
    members: [
      { name: 'Papa', colorRef: 'gruen', devices: 1 },
      { name: 'Mama', colorRef: 'blau', devices: 1 },
      { name: 'Kind', colorRef: 'rot', devices: 1 },
    ],
  });
  const r = relay(h, clock);

  // From the dump.
  const strings = readableStrings(h.dump());
  assert.deepEqual(findText(strings, ['gruen', 'blau', 'rot']).sort(), ['blau', 'gruen', 'rot']);

  // And from the wire, unauthenticated by anything but membership.
  const page = await r.send({ method: 'GET', path: '/api/v1/ops', dev: members[0].devices[0], query: { space: SPACE } });
  assert.deepEqual(page.body.members.map((m) => m.colorRef).sort(), ['blau', 'gruen', 'rot']);

  // It is the ONLY user-chosen String. Asserted against the declaration, so a second one added to
  // `PLAINTEXT_STRINGS` fails here by name rather than by review.
  const contentBearing = Object.entries(PLAINTEXT_STRINGS)
    .filter(([, note]) => /leak|palette/i.test(String(note)))
    .map(([col]) => col);
  assert.deepEqual(contentBearing, ['Member.colorRef'],
    `a second user-chosen plaintext String appeared: ${contentBearing}`);

  assertDocumented(assert, 'each member\'s palette colour, in German, in the clear', [
    'colorRef', 'THE ONE DELIBERATE PLAINTEXT LEAK',
  ]);
});

test('the column set T1 can read at all is closed and declared twice', () => {
  // Not an attack — the precondition that makes every "FAILED" above finite. If a column can
  // appear without appearing here, none of the searches above is exhaustive.
  const models = Object.keys(MODEL_COLUMNS).sort();
  assert.ok(models.length >= 10, `expected ≥10 models, saw ${models.length}`);
  for (const m of models) {
    assert.ok(Array.isArray(MODEL_COLUMNS[m]) && MODEL_COLUMNS[m].length > 0, `${m} has no columns`);
  }
  // Every model with an opaque column must have it typed, or a String could sit there.
  for (const [model, cols] of Object.entries(OPAQUE_FIELDS)) {
    for (const c of cols) {
      assert.ok(MODEL_COLUMNS[model].includes(c), `OPAQUE_FIELDS names ${model}.${c}, which is not a column`);
    }
  }
});
