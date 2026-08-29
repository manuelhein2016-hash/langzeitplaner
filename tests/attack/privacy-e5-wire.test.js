// ATTACK · THE PRIVACY ADVERSARY, 4 of 5 — 21.1 AT THE WIRE.
//
// `tests/server/blindness.test.js` searches the relay's STORE for the German text a session
// typed. That is the right test for the server. It is not the same test as this one, and the
// difference is the whole point of doing both: the store is what the relay chose to keep, and
// the wire is what the client chose to send. A client that put a note's text in a query string,
// a header, an `oid`, or the `wit` field would be invisible to a store search of a well-behaved
// relay and perfectly visible to `tcpdump`.
//
// So this file records every byte the SHIPPED transport hands to the socket over a real two-Mac
// session — URL, query, headers, body — and searches those.
//
//   §1  is there one readable byte anywhere in a real session?
//   §2  the envelope on the wire: nine fields, no timestamp, and `wit` really is empty
//   §3  the size channel, measured on real bytes and checked against `server-metadata.md` §4
//   §4  Belegt vs Geteilt — what M1 can and cannot say about it
//
// SUCCEEDED / FAILED are from the adversary's point of view.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet } from '../helpers/fleet.js';
import { recordWire, envelopeBytes, repoFile } from '../helpers/privacy-audit.js';
import { PAD_BUCKET, AEAD } from '../../src/js/crypto/suite.js';
import { paddedLength, ENVELOPE_FIELDS } from '../../src/js/crypto/envelope.js';

/** The German a household actually types, and the ids and dates that go with it. */
const SECRETS = [
  'Zahnarzt', 'Blutdruck-Check', 'Praxis Sonnenberg', 'Herbstferien', 'Nordsee',
  'Elternabend', 'Steuerberater', 'Rezept abholen', 'Familie', 'Arbeit',
  '2027-05-06', '2027-03-04', '14:30', 'gruen',
];
/** The structure, which is worth as much as the words. */
const STRUCTURE = ['note.set', 'bar.set', 'pad.set', 'cat.set', 'pref.set', 'notes', 'scratchpads'];

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n0', date: '2027-03-04', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false }],
  bars: [{ id: 'b0', startDate: '2027-07-01', endDate: '2027-07-14', label: 'Herbstferien Nordsee', categoryId: 'c1' }],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: { '2027-03': 'Rezept abholen' },
  settings: { locale: 'de' },
});

/** One realistic session on two Macs, with every byte recorded. */
async function session() {
  const fleet = await createFleet({ board: BOARD() });
  const rec = recordWire(fleet.wire);
  try {
    await fleet.A.apply('createNotePopover', {
      id: 'p1', date: '2027-05-06', text: 'Blutdruck-Check Praxis Sonnenberg', categoryId: 'c1',
    });
    await fleet.settle(2);
    await fleet.B.apply('editNotePopover', { id: 'p1', text: 'Blutdruck-Check — 14:30' });
    await fleet.B.apply('padBlur', { month: '2027-05', text: 'Elternabend, Steuerberater' });
    await fleet.settle(2);
    await fleet.A.apply('deleteNotePopover', { id: 'n0' });
    await fleet.settle(2);
  } finally {
    rec.restore();
  }
  return { fleet, rec };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 — EVERY BYTE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · a whole session, searched byte by byte', () => {
  test('FAILED — not one readable word, id, date or op kind is on the wire', async () => {
    const { rec } = await session();
    const bytes = rec.bytes();
    assert.ok(rec.calls.length >= 6, `only ${rec.calls.length} requests — the session did not run`);
    assert.ok(bytes.length > 3000, 'the recorder captured almost nothing');

    const found = SECRETS.filter((w) => bytes.includes(w));
    assert.deepEqual(found, [], 'plaintext on the wire');

    // The structure too: an operator who learns that this request was a `note.set` learns that an
    // ENTRY changed rather than a bar or a category, which is §4 of `server-metadata.md`'s size
    // channel handed over for free.
    const shape = STRUCTURE.filter((w) => bytes.includes(w));
    assert.deepEqual(shape, [], 'the op kind is legible on the wire');

    // Entity ids: `n0`, `p1`, `c1` are two characters and would match anything, so the check is
    // the entity KEY form the log uses, which is the thing an operator could correlate on.
    for (const key of ['note:', 'bar:', 'pad:', 'cat:', 'entry:']) {
      assert.equal(bytes.includes(key), false, `${key} is on the wire`);
    }
  });

  test('FAILED — and the search is armed: it finds a planted word in exactly the same bytes', async () => {
    // Without this the row above is satisfied by a recorder that captured nothing, which is the
    // failure mode every "we searched and found nothing" test has.
    const { rec } = await session();
    const planted = `${rec.bytes()} Blutdruck-Check`;
    assert.equal(SECRETS.filter((w) => planted.includes(w)).length, 1,
      'the search cannot find a word that IS there');
  });

  test('FAILED — the query string carries three parameters, and none of them is content', async () => {
    // The channel a store search cannot see. A URL is what a platform request log records
    // (`server-metadata.md` §8) and what an intermediary proxy keeps; anything put there is
    // outside the ciphertext by construction.
    const { rec } = await session();
    const params = new Set();
    for (const c of rec.calls) for (const k of Object.keys(c.query)) params.add(k);
    assert.deepEqual([...params].sort(), ['limit', 'since', 'space']);
    for (const c of rec.calls) {
      if (c.query.since !== undefined) assert.match(c.query.since, /^[0-9]+$/, 'a cursor is not a number');
      if (c.query.limit !== undefined) assert.equal(c.query.limit, '500');
      if (c.query.space !== undefined) assert.match(c.query.space, /^psp_[A-Za-z0-9_-]{22}$/);
    }
  });

  test('FAILED — the push body has four fields, and three of them are numbers or a flag', async () => {
    const { rec } = await session();
    const pushes = rec.calls.filter((c) => c.method === 'POST');
    assert.ok(pushes.length >= 2);
    for (const p of pushes) {
      assert.deepEqual(Object.keys(p.body).sort(), ['ackSeq', 'drained', 'ops', 'space']);
      assert.match(p.body.space, /^psp_/);
      assert.match(String(p.body.ackSeq), /^[0-9]+$/);
      assert.equal(typeof p.body.drained, 'boolean');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE ENVELOPE, AS IT LEAVES
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · nine fields, and what each of them can carry', () => {
  test('FAILED — every envelope on the wire has exactly the nine declared fields and no authoring time', async () => {
    // ADR 002 §5.1 and §11 rule 5: no authoring time in the header, because an arrival time the
    // relay stamps itself is one observable and an authoring time the client volunteers is a
    // second, sharper one — it survives an offline period and says when the person was actually
    // at the machine.
    const { rec } = await session();
    const envelopes = rec.calls.filter((c) => c.method === 'POST').flatMap((c) => c.body.ops);
    assert.ok(envelopes.length >= 3, `only ${envelopes.length} envelopes were sent`);
    for (const e of envelopes) {
      assert.deepEqual(Object.keys(e), [...ENVELOPE_FIELDS], 'the wire shape drifted from ENVELOPE_FIELDS');
      assert.equal(/at$|time|ts|when|date/i.test(Object.keys(e).join(' ')), false);
      assert.equal(e.v, 1);
      assert.match(e.sp, /^psp_/);
      assert.equal(typeof e.ep, 'number');
      assert.match(e.dv, /^[0-9A-Z]{16}$/);
    }
  });

  test('FAILED — the shipped client never uses `wit`, which E3 showed is 86 bytes of free plaintext', async () => {
    // `crypto-relay-read.test.js` established that `wit` is author-chosen plaintext that nothing
    // checks — an exfiltration channel for a MODIFIED client (T2/T5). This is the complementary
    // question for an UNMODIFIED one: does the shipping client put anything there? It does not,
    // and `sync/personal.js` says why in its `sealLine` docblock — the witness is the relay's to
    // compute, and inventing one would put an unverifiable value in the AAD.
    const { rec } = await session();
    const wits = new Set(rec.calls.filter((c) => c.method === 'POST').flatMap((c) => c.body.ops.map((e) => e.wit)));
    assert.deepEqual([...wits], [''], 'the client now writes a witness — audit what goes in it');
    assert.match(repoFile('src/js/sync/personal.js'), /wit: ''/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE SIZE CHANNEL, ON REAL BYTES
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · what length says, measured rather than derived', () => {
  test("FAILED — every envelope on the wire obeys `server-metadata.md` §4's formula exactly", async () => {
    // §4 states `len(envelope) = 92 + 256·k`. That is a promise about the padding actually being
    // applied on the way out, and it is the one arithmetic relation a Datenschutz page can be
    // held to. Checked here against bytes that were really sent.
    const { rec } = await session();
    const envelopes = rec.calls.filter((c) => c.method === 'POST').flatMap((c) => c.body.ops);
    for (const e of envelopes) {
      const n = envelopeBytes(e);
      assert.equal((n - 92) % PAD_BUCKET, 0, `${n} bytes is not 92 + 256k`);
      assert.ok(n >= 92 + PAD_BUCKET, `${n} bytes is smaller than one bucket`);
    }
    assert.equal(AEAD.ivBytes + AEAD.tagLength / 8 + 64, 92, 'the 92 in the formula is iv + tag + sig');
    assert.equal(paddedLength(1), PAD_BUCKET);
  });

  test('SUCCEEDED — a note leaks one bit of length, and a SCRATCHPAD leaks its size to 256 bytes', async () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-10 · LOW · story 21.1 · documented in `server-metadata.md` §4, quantified here.
    //
    // §4 concedes the size class in general terms. This is what it amounts to on M1's actual
    // traffic, which is the number a Datenschutz page could honestly print:
    //
    //   · a `note.set` is 604 bytes (k = 2) for EVERY ASCII text — the field is capped at 80
    //     characters, so no ASCII note can reach bucket 3. German crosses it: about 55
    //     characters of umlauted text, measured below. So a note leaks ONE BIT: "this note is
    //     long, and German".
    //   · a `pad.set` — the monthly scratchpad — is NOT capped, and its envelope tracks its
    //     length in 256-byte steps all the way up. An operator reads the approximate size of
    //     every month's scratchpad off the `envelope` column with arithmetic and no key, and the
    //     same number is in the application log as `byteCount` (§8).
    //
    // Neither is a content leak and neither is fixable without much more padding. It is here so
    // that the honest sentence exists: the relay cannot read the scratchpad, and it can tell a
    // three-line month from a thirty-line one.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const fleet = await createFleet({ board: BOARD() });
    await fleet.settle(1);
    const rec = recordWire(fleet.wire);
    const sizeOf = async (mutation, args) => {
      const before = rec.calls.length;
      await fleet.A.apply(mutation, args);
      await fleet.A.push();
      const p = rec.calls.slice(before).find((c) => c.method === 'POST' && c.body.ops.length);
      return envelopeBytes(p.body.ops[0]);
    };
    try {
      // The note: one class for every ASCII length the field allows.
      const ascii = [];
      for (const n of [1, 20, 40, 60, 79]) {
        // eslint-disable-next-line no-await-in-loop
        ascii.push(await sizeOf('createNotePopover', {
          id: `a${n}`, date: '2027-06-01', text: 'x'.repeat(n), categoryId: 'c1',
        }));
      }
      assert.deepEqual([...new Set(ascii)], [604], 'ASCII notes are no longer one length class');

      // …and the one bit German buys.
      assert.equal(await sizeOf('createNotePopover',
        { id: 'u40', date: '2027-06-02', text: 'ü'.repeat(40), categoryId: 'c1' }), 604);
      assert.equal(await sizeOf('createNotePopover',
        { id: 'u60', date: '2027-06-03', text: 'ü'.repeat(60), categoryId: 'c1' }), 860,
        'the German boundary moved — re-measure P-10');

      // The scratchpad: a gradient, not a class.
      const pads = [];
      for (const n of [4, 200, 400, 800, 1600]) {
        // eslint-disable-next-line no-await-in-loop
        pads.push(await sizeOf('padBlur', { month: '2027-08', text: 'w'.repeat(n) }));
      }
      assert.deepEqual(pads, [604, 604, 860, 1372, 2140],
        'the scratchpad size curve moved — re-measure P-10');
      assert.ok(new Set(pads).size >= 4, 'the scratchpad leaks fewer classes now — good news');
    } finally {
      rec.restore();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 — BELEGT vs GETEILT
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · "a Belegt op is indistinguishable by length from a Geteilt one"', () => {
  test('SUCCEEDED — M1 cannot make that op at all, so the promise is untested by the product', () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-11 · INFORMATIONAL · story 21.1 / 16.7 · scope, not defect.
    //
    // The Belegt/Geteilt distinction lives entirely in `pub.set` ops in a FAMILY space. At M1:
    //
    //   · there is no family space, so no `pub.set` is ever sealed;
    //   · `sealOp` REFUSES every family `pub.set` today, because `core/project.js` (WP-10) does
    //     not exist and barrier 3 demands a branded patch — which is the right default, and it
    //     means the wire cannot carry a Belegt op at all;
    //   · in the PERSONAL space every op carries the full plaintext, because it is going to the
    //     same person's other Mac. There is nothing to redact and no level to hide.
    //
    // So this attack has no target in the shipped product, and saying so is the honest result.
    // The measurement it WOULD make already exists and is red-teamed: `crypto-relay-read.test.js`
    // establishes, on forged plaintexts, that a bare Belegt op is 528 bytes of ciphertext and a
    // Geteilt op crosses to 784 at 140 ASCII or 80 German characters — i.e. **`ct === 784` in a
    // family space is a one-sided proof of Geteilt**, which is exactly the inference 16.7
    // promises not to enable. That finding is E3's, it is open, and it lands on the wire the day
    // WP-10 ships `project.js`. Nothing E5 did makes it better or worse.
    //
    // What E5 SHOULD carry forward: the padding is applied by `pad()` before `sealOp` encrypts,
    // so any widening of `PAD_BUCKET` closes it for both scopes at once, and `envelopeBytes` in
    // `tests/helpers/privacy-audit.js` is the measurement to re-run.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const env = repoFile('src/js/crypto/envelope.js');
    assert.match(env, /spaceClassOf\(hdr\.sp\) === 'family' && op\.k === 'pub\.set'/);
    assert.match(env, /refusing an UNBRANDED family patch/);
    assert.equal(repoFile('src/js/family/engine.js').includes('project.js'), false);

    // The seam is still open, so the E3 finding is still the live one.
    assert.match(env, /src\/js\/core\/project\.js` is WP-10's and DOES NOT EXIST YET/);
    assert.equal(PAD_BUCKET, 256, 'the bucket moved — re-run the E3 Belegt/Geteilt measurement');
  });
});
