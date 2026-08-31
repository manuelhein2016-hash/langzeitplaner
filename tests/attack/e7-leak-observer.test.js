// ATTACK · E7 — THE RELAY'S CHAIR. Distinguish Belegt from Geteilt WITHOUT A KEY.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ADVERSARY AND WHAT IT ACTUALLY SEES
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The relay operator holds no key and never will (ADR 002 §8). What it does hold, in the clear,
// is `(spaceId, epoch, deviceShort, seq, length)` per envelope plus arrival TIME (ADR 003 §6.3),
// and — because a member's personal space and their family space are two streams pushed from the
// same Mac by the same person — the ability to CORRELATE the two.
//
// 16.7 grants it existence, owner and duration for a Belegt entry, deliberately. It grants it
// NOTHING about the difference between Belegt and Geteilt: P7i says "a Belegt op and a Geteilt op
// of the same entity are THE SAME CIPHERTEXT LENGTH". This file asks the four ways that claim can
// be false — by LENGTH, by FIELD COUNT, by the SHAPE of a transition, and by OP FREQUENCY — and
// only the first of them has ever been written down.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// AND THE OTHER TWO CLAIMS AN OBSERVER TESTS: 16.4 AND A4
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// §4 attacks the category default — "can it publish something the user did not intend?" — which
// is an observer question too: the observer is the FAMILY, and the leak is a settings click.
//
// ENGINE RULES (ADR 002 §1): no signature bytes compared, no error NAME branched on, memKeyStore.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCircle, papaNote, papaBar, setLevel, familyOps, personalOps, drainAndSeal,
  SECRET, SHARED, DATE, store, mkOpId, mkGroupId, fmt, BASE_MS,
} from './_e7-leak-kit.js';

import { sealOp, paddedLength } from '../../src/js/crypto/envelope.js';
import { PAD_BUCKET } from '../../src/js/crypto/suite.js';
import { canonicalBytes } from '../../src/js/core/canon.js';
import { projectForFamily, assertFamilyPatch, GETEILT_FIELDS } from '../../src/js/core/project.js';
import { familyKey } from '../../src/js/core/entities.js';
import { visibilityForNewEntry, CATEGORY_DEFAULT_CONTRACT, DEFAULT_VISIBILITY } from '../../src/js/core/visibility.js';
import { FIELDS } from '../../src/js/core/ops.js';

/** @type {any} */ let RIG;
before(async () => { RIG = await buildCircle(); });

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE LENGTH CHANNEL — P7i at every bucket boundary, for BOTH kinds
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Seal one op of a given kind at a given level with a content string of a chosen length. */
async function sealed(kind, level, len, uuid, filler = 'x') {
  const content = filler.repeat(len);
  const truth = kind === 'fnote'
    ? { visibility: level, date: DATE, text: content, repeatsYearly: false, coEdit: false, _alive: true }
    : {
      visibility: level, startDate: '2027-07-01', endDate: '2027-07-14',
      label: content, coEdit: false, _alive: true,
    };
  // `lastPublished: 'belegt'` unconditionally — a privat projection of a never-published entity is
  // `null` (16.1), and this section is about the LENGTH of an op that exists.
  const patch = projectForFamily(kind, truth, level, 'belegt');
  const op = {
    v: 1, id: mkOpId(), ts: fmt(BASE_MS + 5000, 0, RIG.PAPA.devices[0].deviceShort), space: RIG.FSP,
    act: RIG.PAPA.memberId, dev: RIG.PAPA.devices[0].deviceId, gid: mkGroupId(), k: 'pub.set',
    e: familyKey(kind, RIG.PAPA.memberId, uuid), f: patch,
  };
  const env = await sealOp(op, RIG.keyring, RIG.PAPA.devices[0].devSig.privateKey, {
    v: 1, sp: RIG.FSP, ep: 1, dv: RIG.PAPA.devices[0].deviceShort, oid: op.id, wit: '',
  }, { assertFamilyPatch, levelOf: () => level, attestation: RIG.PAPA.devices[0].att });
  // `env.ct` is the base64url STRING. `x.ct.length` on a number is `undefined`, and
  // `assert.equal(undefined, undefined)` is the shape of a vacuous row.
  return { ct: env.ct, plain: canonicalBytes(op).length };
}

const UU = { fnote: 'ffffffff-1111-2222-3333-444455556666', fbar: 'ffffffff-1111-2222-3333-444455556667' };

/**
 * The product's own length caps — `ops.js:FIELDS` types, and the DOM `maxLength` beside them.
 * They count CHARACTERS. The padding bucket counts BYTES. That gap is half of §1's finding.
 */
const CAP = Object.freeze({ fnote: 80, fbar: 40 });

/**
 * The first content length at which a Geteilt op leaves the Belegt op's padding bucket — searched
 * only over the LEGAL input space, because a length `validateOp` rejects is not a length the
 * channel can carry. `null` means the cap keeps every legal value inside one bucket, which is the
 * GOOD answer and the one `fbar` gives in ASCII.
 */
async function boundary(kind, filler = 'x') {
  const b = await sealed(kind, 'belegt', 0, UU[kind]);
  for (let len = 0; len <= CAP[kind]; len++) {
    const g = await sealed(kind, 'geteilt', len, UU[kind], filler);
    if (g.ct.length !== b.ct.length) return { len, belegt: b.ct.length, geteilt: g.ct.length };
  }
  return null;
}

describe('E7-R · the length channel (P7i, 16.7) — measured at both boundaries', () => {
  test('inside the bucket, a Belegt op and a Geteilt op are the SAME ciphertext length', async () => {
    for (const kind of ['fnote', 'fbar']) {
      const edge = await boundary(kind);
      const b = await sealed(kind, 'belegt', 0, UU[kind]);
      const upTo = edge ? edge.len - 1 : CAP[kind];
      assert.ok(upTo >= 8, `${kind}: the bucket holds only ${upTo + 1} lengths — the row is vacuous`);
      for (const len of [0, 1, 8, upTo]) {
        const g = await sealed(kind, 'geteilt', len, UU[kind]);
        assert.equal(g.ct.length, b.ct.length, `${kind} @ ${len}: ${b.ct.length} vs ${g.ct.length}`);
      }
    }
  });

  test('⚠ the note crosses the boundary inside its cap; the BAR crosses it only in bytes (E7-4)', async () => {
    // `redaction-invariants.test.js` measures the `fnote` half and pins it as finding E7-4. The
    // BAR half was never measured, and it splits the finding in two — which matters, because the
    // two halves need different fixes.
    assert.equal(PAD_BUCKET, 256);
    assert.equal(FIELDS.fnote['pub.text'].t, 'str80');
    assert.equal(FIELDS.fbar['pub.label'].t, 'str40');

    // (a) THE NOTE — E7-4, confirmed. A Geteilt note leaves the Belegt bucket well inside `str80`,
    //     so a relay operator can tell "Papa shared something" from "Papa marked himself busy"
    //     with no key at all.
    const note = await boundary('fnote');
    assert.ok(note, 'the note never left the bucket inside its cap — E7-4 is closed, INVERT this row');
    assert.ok(note.len < CAP.fnote,
      `MEASURED: a Geteilt note leaves the Belegt bucket at ${note.len} ASCII characters `
      + `(${note.belegt} → ${note.geteilt} ciphertext chars) against a cap of ${CAP.fnote}.`);

    // (b) THE BAR, IN ASCII — the cap holds. `str40` is short enough that every legal ASCII label
    //     stays in the Belegt op's bucket, so the channel is CLOSED for bars in ASCII. That is
    //     worth knowing precisely because it shows the fix is a cap/bucket ratio and not a new
    //     primitive: 40 characters is inside the bucket and 80 is not.
    const barAscii = await boundary('fbar');
    assert.equal(barAscii, null,
      `a Geteilt bar leaves the Belegt bucket at ${barAscii && barAscii.len} ASCII characters — `
      + 'the ASCII half of the bar case has regressed');

    // (c) THE BAR, IN BYTES — and here it does not. The cap counts CHARACTERS and the bucket
    //     counts BYTES, so the ASCII row above is the BEST case and not the case. THE CAP DOES
    //     NOT BOUND THE LENGTH IT IS BEING RELIED ON TO BOUND, and any fix framed as "keep the
    //     cap below the bucket" is wrong for exactly that reason.
    //
    //     ⚠ AND THE INPUT THAT SHOWS IT IS NOT AN EXOTIC ONE. This is a GERMAN product: „Kur Bad
    //     Wörishofen", „Zahnärztin", „Frühjahrsferien". A two-byte umlaut is the ordinary case,
    //     not the adversarial one, and it crosses the boundary well inside `str40`.
    const barUmlaut = await boundary('fbar', 'ä');
    assert.ok(barUmlaut,
      'an umlauted label no longer crosses the bucket — the byte/character gap is closed and this '
      + 'row should be inverted rather than relaxed');
    assert.ok(barUmlaut.len < CAP.fbar,
      `MEASURED: a Geteilt bar label of two-byte German characters leaves the Belegt bucket at `
      + `${barUmlaut.len} CHARACTERS (${barUmlaut.belegt} → ${barUmlaut.geteilt} ciphertext chars) `
      + `— inside a cap of ${CAP.fbar} that pure ASCII never reaches.`);
    const barAstral = await boundary('fbar', '\u{1F600}');
    assert.ok(barAstral && barAstral.len < barUmlaut.len,
      'and the four-byte case crosses earlier still — the boundary is a BYTE count wearing a '
      + 'character cap');
    // The same gap on the note, for completeness: 73 ASCII characters, far fewer in German.
    const noteAstral = await boundary('fnote', '\u{1F600}');
    assert.ok(noteAstral && noteAstral.len < note.len,
      `the note's boundary is ${note.len} in ASCII and ${noteAstral && noteAstral.len} in astral `
      + 'codepoints — one cap, four boundaries');
  });

  test('a RETRACTION is the same length as any other op of its kind', async () => {
    // Principle 9 in the length channel: if a withdrawal were shorter than a publication, a relay
    // operator could count downgrades across the family without reading a byte.
    for (const kind of ['fnote', 'fbar']) {
      const r = await sealed(kind, 'privat', 0, UU[kind]);
      const b = await sealed(kind, 'belegt', 0, UU[kind]);
      assert.equal(r.ct.length, b.ct.length,
        `${kind}: a retraction is ${r.ct.length} chars and a Belegt publication is ${b.ct.length}`);
    }
  });

  test('the padding is a function of length alone — no op can choose its own bucket', () => {
    for (const n of [1, 255, 256, 257, 512, 513]) {
      assert.equal(paddedLength(n) % PAD_BUCKET, 0);
      assert.ok(paddedLength(n) > n);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE FIELD-COUNT AND TRANSITION-SHAPE CHANNELS — both closed, and by construction
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-S · field count and transition shape', () => {
  test('a Belegt patch and a Geteilt patch have the IDENTICAL key set', () => {
    // This is what makes the length channel a bucket question rather than a counting one: the
    // projection emits EVERY row of `GETEILT_FIELDS` at every level and nulls what it withdraws,
    // so an observer who could somehow count fields would learn nothing from the count.
    for (const kind of ['fnote', 'fbar']) {
      const truth = (level) => (kind === 'fnote'
        ? { visibility: level, date: DATE, text: SHARED.text, repeatsYearly: false, coEdit: false, _alive: true }
        : {
          visibility: level, startDate: '2027-07-01', endDate: '2027-07-14',
          label: SHARED.label, coEdit: false, _alive: true,
        });
      const b = Object.keys(projectForFamily(kind, truth('belegt'), 'belegt', 'belegt')).sort();
      const g = Object.keys(projectForFamily(kind, truth('geteilt'), 'geteilt', 'belegt')).sort();
      assert.deepEqual(b, g, `${kind}: Belegt and Geteilt publish different key sets`);
      assert.deepEqual(b, [...GETEILT_FIELDS[kind]].sort());
    }
  });

  test('every transition emits exactly ONE family op — the count is not a signal', async () => {
    const seen = [];
    for (const from of ['privat', 'belegt', 'geteilt']) {
      for (const to of ['privat', 'belegt', 'geteilt']) {
        if (from === to) continue;
        // ⚠ ALWAYS the legitimate carrier: this loop moves entries UP as well as down, and an
        // entry that reaches `geteilt` publishes its text legitimately — which would blunt every
        // needle in the file.
        const id = papaNote({ level: from, text: SHARED.text });
        await drainAndSeal(RIG);
        const fk = familyKey('fnote', RIG.PAPA.memberId, id);
        const before = familyOps(RIG).filter((o) => o.e === fk).length;
        setLevel('note', id, to);
        const after = familyOps(RIG).filter((o) => o.e === fk).length;
        seen.push({ from, to, ops: after - before });
        await drainAndSeal(RIG);
      }
    }
    for (const row of seen) {
      const expected = row.to === 'privat' && row.from === 'privat' ? 0 : 1;
      assert.equal(row.ops, expected,
        `${row.from} → ${row.to} emitted ${row.ops} ops; a transition whose op COUNT differs from `
        + 'its neighbours is a transition an observer can name.');
    }
    assert.equal(seen.length, 6);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · ⚠ FINDING E7L-6 — THE FREQUENCY CHANNEL. A GETEILT EDIT PUSHES; A BELEGT EDIT DOES NOT.
//
// This is the channel nobody wrote down, and it needs no 73-character note and no key.
//
// `derivePublication` is idempotent by design — "run it twice and the second run emits nothing,
// which is what stops a keystroke storm from becoming an op storm." The consequence nobody costed
// is that WHICH edits produce a family op is a function of the entity's LEVEL:
//
//     edit the TEXT of a Geteilt entry  →  1 personal op  +  1 family op
//     edit the TEXT of a Belegt entry   →  1 personal op  +  0 family ops
//     edit the TEXT of a Privat entry   →  1 personal op  +  0 family ops
//
// A relay operator sees both streams from the same Mac, correlated by arrival time. For a single
// isolated edit — the common case: open the app, change one thing, close it — the presence or
// absence of a paired family op says whether the entity that was touched is Geteilt.
//
// It is NOT a break of INV-R1 and it is not new in kind: ADR 002 §8.7 already owns "padding does
// not hide timing", and 16.7 already grants existence. It IS a counterexample to P7i's PURPOSE —
// "a relay operator watching Papa's stream cannot tell a booking from a shared note" — reached
// without touching the length channel at all.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-T · the frequency channel (FINDING E7L-6)', () => {
  test('a text edit is distinguishable by level, from the relay\'s chair, with no key', async () => {
    const mk = (level) => papaNote({ level, text: level === 'geteilt' ? SHARED.text : SECRET.noteText });
    const ids = { privat: mk('privat'), belegt: mk('belegt'), geteilt: mk('geteilt') };
    await drainAndSeal(RIG);

    /** What the relay sees for one action: how many ops arrived in each stream. */
    const observe = (fn) => {
      const p0 = personalOps(RIG).length;
      const f0 = familyOps(RIG).length;
      fn();
      return { personal: personalOps(RIG).length - p0, family: familyOps(RIG).length - f0 };
    };

    const seen = {};
    for (const level of ['privat', 'belegt', 'geteilt']) {
      seen[level] = observe(() => {
        store.txn('edit-text', (tx) => { tx.note(ids[level]).set({ text: `${level}-edit-1` }); });
      });
    }
    assert.deepEqual(seen.privat, { personal: 1, family: 0 });
    assert.deepEqual(seen.belegt, { personal: 1, family: 0 });
    assert.deepEqual(seen.geteilt, { personal: 1, family: 1 },
      'a Geteilt text edit no longer pushes a family op — the finding is closed and this row '
      + 'should be inverted rather than relaxed.');

    // THE FINDING, stated as the distinguisher it is: the observed pair (personal, family) is
    // 1,1 for Geteilt and 1,0 for everything else. One bit about a level, per edit, in the clear.
    assert.notDeepEqual(seen.geteilt, seen.belegt,
      'Belegt and Geteilt are indistinguishable by op pairing — then E7L-6 is closed.');

    // …and it is not symmetrical: a DATE move pushes at Belegt too, so the channel is specifically
    // about which FIELD was touched. Recorded so a fix is not mis-scoped to "publish on every
    // edit", which would leak the same bit the other way round (a Belegt entry emitting an op per
    // keystroke tells the relay how much a person types into a booking).
    const move = observe(() => {
      store.txn('move', (tx) => { tx.note(ids.belegt).set({ date: '2027-11-11' }); });
    });
    assert.deepEqual(move, { personal: 1, family: 1 });
    await drainAndSeal(RIG);
  });

  test('creating an entry is distinguishable the same way, and 16.1 requires that it be', async () => {
    // The Privat row here is 16.1 working exactly as designed — "private by default costs zero
    // bytes on the wire" IS the absence of a family op — so this row is a CHARACTERIZATION of
    // where the frequency channel is intended and where it is not. Privat vs {Belegt, Geteilt} is
    // intended. Belegt vs Geteilt is the one the row above shows is not.
    const before = { p: personalOps(RIG).length, f: familyOps(RIG).length };
    papaNote({ level: 'privat', text: SECRET.privatOnly });
    assert.equal(familyOps(RIG).length - before.f, 0);
    const mid = familyOps(RIG).length;
    papaNote({ level: 'belegt', text: SECRET.noteText });
    assert.equal(familyOps(RIG).length - mid, 1);
    const mid2 = familyOps(RIG).length;
    papaNote({ level: 'geteilt', text: SHARED.text });
    assert.equal(familyOps(RIG).length - mid2, 1, 'creation is level-symmetric above privat');
    await drainAndSeal(RIG);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · 16.4 — CAN THE CATEGORY DEFAULT PUBLISH SOMETHING THE USER DID NOT INTEND?
//
// ADR 004 §3: "It is read EXACTLY ONCE, at entry creation. […] Changing a category's default
// never re-publishes existing entries — that would be a bulk disclosure triggered by a settings
// click, which 16.1 forbids."
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-U · the category default (16.4) is not a live rule', () => {
  test('raising a category default publishes NOTHING for the entries already in it', async () => {
    const id = papaNote({ level: 'privat', text: SECRET.privatOnly, categoryId: 'cat-2' });
    await drainAndSeal(RIG);
    const before = familyOps(RIG).length;
    store.txn('cat-default', (tx) => { tx.cat('cat-2').set({ defaultVisibility: 'geteilt' }); });
    assert.equal(familyOps(RIG).length - before, 0,
      'a settings click published an existing entry — a bulk disclosure triggered by a settings '
      + 'click, which 16.1 says is structurally impossible.');
    assert.equal(store.state.notes.find((n) => n.id === id).visibility, 'privat',
      'the existing entry\'s own level moved when the category default moved');
    await drainAndSeal(RIG);
  });

  test('MOVING an existing entry into a Geteilt-default category does not share it', async () => {
    // The sharpest form: the default is read at CREATION, and a re-categorisation is not one.
    // If `categoryId` were read again here, dragging an entry into „Familie" would publish it.
    const id = papaNote({ level: 'privat', text: SECRET.privatOnly, categoryId: 'cat-1' });
    await drainAndSeal(RIG);
    const before = familyOps(RIG).length;
    store.txn('recat', (tx) => { tx.note(id).set({ categoryId: 'cat-2' }); });
    assert.equal(familyOps(RIG).length - before, 0, 'a re-categorisation published the entry');
    assert.equal(store.state.notes.find((n) => n.id === id).visibility, 'privat');
  });

  test('RENAMING a category, or deleting it, changes no entry\'s exposure', async () => {
    const id = papaNote({ level: 'belegt', text: SECRET.noteText, categoryId: 'cat-2' });
    await drainAndSeal(RIG);
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    const before = familyOps(RIG).filter((o) => o.e === fk).length;
    store.txn('rename', (tx) => { tx.cat('cat-2').set({ name: 'Umbenannt' }); });
    store.txn('hide', (tx) => { tx.cat('cat-2').set({ visible: false }); });
    assert.equal(familyOps(RIG).filter((o) => o.e === fk).length - before, 0,
      'a category rename or hide produced a family op for an entry in it');
    assert.equal(store.state.notes.find((n) => n.id === id).visibility, 'belegt');
  });

  test('the function\'s ARITY is the enforcement — it cannot become a live rule', () => {
    assert.equal(visibilityForNewEntry.length, 1,
      'a function that takes only a category has nothing to re-evaluate against. A second '
      + 'argument (an entry, a `now`, "the level I used last") is what turns 16.4 into a rule '
      + 'that can fire twice.');
    assert.equal(DEFAULT_VISIBILITY, 'privat');
    assert.equal(visibilityForNewEntry(null), 'privat', 'a dangling categoryId');
    assert.equal(visibilityForNewEntry({}), 'privat');
    assert.equal(visibilityForNewEntry({ defaultVisibility: 'oeffentlich' }), 'privat',
      'a level outside the enum falls to the FLOOR, never to the last level used');
    // Read exactly once, into a const — a getter that answers twice is the cheapest way through a
    // policy that inspects a field twice.
    let reads = 0;
    const cat = { get defaultVisibility() { return ++reads === 1 ? 'privat' : 'geteilt'; } };
    assert.equal(visibilityForNewEntry(cat), 'privat');
    assert.equal(reads, 1, `defaultVisibility was read ${reads} times`);
    assert.ok(CATEGORY_DEFAULT_CONTRACT.notLive.includes('NEVER'));
  });

  test('a category default of Geteilt DOES publish a NEW entry — which is 16.4 working', async () => {
    // The non-vacuity control. If this row were red, every row above would pass over a build in
    // which the default does nothing at all.
    store.txn('cat-default', (tx) => { tx.cat('cat-2').set({ defaultVisibility: 'geteilt' }); });
    const cat = store.category('cat-2');
    assert.equal(visibilityForNewEntry(cat), 'geteilt',
      'NON-VACUITY: the category really does carry a raised default');
    const id = papaNote({ level: visibilityForNewEntry(cat), text: SHARED.text, categoryId: 'cat-2' });
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    assert.equal(familyOps(RIG).filter((o) => o.e === fk).length, 1);
    await drainAndSeal(RIG);
  });

  test('and the default itself is NEVER published — it is a personal-space field (A3)', () => {
    assert.ok(FIELDS.cat.defaultVisibility, 'the default lives on the category');
    for (const kind of ['fnote', 'fbar']) {
      assert.deepEqual(Object.keys(FIELDS[kind]).filter((f) => /default/i.test(f)), [],
        `${kind} has a pub.* counterpart for the category default`);
    }
    const all = familyOps(RIG).filter((o) => o.k === 'pub.set');
    assert.ok(all.length >= 5, `NON-VACUITY: only ${all.length} family ops on the log`);
    for (const op of all) {
      assert.equal(JSON.stringify(op.f).includes('defaultVisibility'), false);
      assert.equal(JSON.stringify(op.f).includes('cat-'), false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · THE TAPE — nothing in this file put a needle on the wire either
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-V · the verdict on the bytes', () => {
  test('no Belegt or Privat content ever left the device across the whole file', async () => {
    for (const needle of [SECRET.noteText, SECRET.barLabel, SECRET.privatOnly, SECRET.category]) {
      RIG.wire.assertNeverTransmitted(needle, { except: [], epochKeys: RIG.epochKeys });
    }
    const r = await RIG.wire.decryptWithEveryEpochKey(RIG.epochKeys, RIG.attestationOf);
    assert.deepEqual(r.offList, []);
    assert.ok(RIG.wire.tape().sealed.length >= 8,
      `NON-VACUITY: only ${RIG.wire.tape().sealed.length} envelopes were sealed`);
    assert.ok(RIG.wire.tape().plaintexts.some((p) => p.json.includes(SHARED.text)),
      'nothing legitimately shared reached the tape — the needle search is blunt');
    void papaBar;
  });
});
