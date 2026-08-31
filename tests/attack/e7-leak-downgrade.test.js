// ATTACK · E7 — MAKE A DOWNGRADE FAIL TO REMOVE. The R9 shape, hunted on every path.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS AND WHY IT IS THE DANGEROUS ONE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ADR 004 §5.1, in its own words:
//
//   > This is the single highest-value defect in the whole v2 surface. […] The entry would look
//   > correctly downgraded on my board and be fully readable on Mama's. NO OWNER-SIDE SMOKE TEST
//   > CATCHES THIS, because the owner's board is right. That is exactly what makes it dangerous.
//
// So every assertion below is about **what the PEER still holds** or **what op was NEVER
// EMITTED** — never about Papa's board, which is right in every failing case in here.
//
// `redaction-invariants.test.js` §4 proves that the honest transition writes explicit nulls. That
// is INV-R4's first mechanism and it holds. This file attacks the OTHER four ways a withdrawal
// can fail to happen at all:
//
//   1. the projection is never RUN            (§2 — the second Mac; §5 — replaceAll)
//   2. the projection runs and is DISCARDED    (§4 — the redaction halt)
//   3. the op is authored and never SEALED     (§6 — the quarantine)
//   4. the op arrives and the peer keeps it    (§3 — the LWW race; §7 — the forget pass)
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE METHOD: THE TRANSITION DOMAIN IS ENUMERATED AS DATA BEFORE ANY BRANCH IS CHOSEN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// §1 walks every (from × to × lastPublished × alive) cell — 3 × 3 × 4 × 2 = 72 — through the REAL
// projection and asserts, per cell, that every field the level withdraws carries an EXPLICIT
// null. That is the whole of INV-R4 stated over its input domain rather than over three examples.
//
// ENGINE RULES (ADR 002 §1): no signature bytes compared, no error NAME branched on, memKeyStore.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCircle, papaNote, setLevel, familyOps, drainAndSeal, openedFrom, peerFold, peerFoldFull,
  MCTX, SECRET, SHARED, DATE, store, famOpFrom, seedCircleIntoStore, BASE_MS,
} from './_e7-leak-kit.js';

import {
  projectForFamily, retractPatch, derivePublication, GETEILT_FIELDS, BELEGT_FIELDS,
} from '../../src/js/core/project.js';
import { planTransition, VISIBILITY_LEVELS } from '../../src/js/core/visibility.js';
import { familyKey } from '../../src/js/core/entities.js';
import { getRegister } from '../../src/js/core/registers.js';
import { materialize } from '../../src/js/core/materialize.js';
import { validateOp } from '../../src/js/core/ops.js';

/** @type {any} */ let RIG;

before(async () => {
  RIG = await buildCircle();
  // §8 drives a PEER's and a SECOND MAC's op INTO Papa's board, so his device has to know their
  // attestations. Without the prehistory every one of those ops parks as `unattestedDevice` — the
  // fail-closed answer, and indistinguishable from "the write was correctly refused".
  const seeded = seedCircleIntoStore(RIG);
  assert.equal(seeded.refused.length, 0, `the circle did not seed: ${JSON.stringify(seeded.refused)}`);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE TRANSITION DOMAIN — 72 cells, and INV-R4 asserted on every one
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The input domain of a transition, as data. Nothing below chooses a branch before this exists. */
const TRANSITIONS = (() => {
  const cells = [];
  for (const kind of ['fnote', 'fbar']) {
    for (const from of VISIBILITY_LEVELS) {
      for (const to of VISIBILITY_LEVELS) {
        for (const lastPublished of [null, 'privat', 'belegt', 'geteilt']) {
          for (const alive of [true, false]) cells.push({ kind, from, to, lastPublished, alive });
        }
      }
    }
  }
  return cells;
})();

const TRUTH = (kind, level, alive) => (kind === 'fnote'
  ? { visibility: level, date: DATE, text: SECRET.noteText, repeatsYearly: true, coEdit: true, _alive: alive }
  : {
    visibility: level, startDate: '2027-07-01', endDate: '2027-07-14',
    label: SECRET.barLabel, coEdit: true, _alive: alive,
  });

describe('E7-I · INV-R4 over the whole transition domain — omission is not withdrawal', () => {
  test('the domain is 144 cells and every one of them is exercised', () => {
    assert.equal(TRANSITIONS.length, 144);
  });

  test('every field a level does NOT permit is an EXPLICIT null, in every cell', () => {
    let published = 0;
    let silent = 0;
    for (const c of TRANSITIONS) {
      const patch = projectForFamily(c.kind, TRUTH(c.kind, c.to, c.alive), c.to, c.lastPublished);
      if (patch === null) { silent += 1; continue; }
      published += 1;
      const permitted = new Set(c.to === 'geteilt' ? GETEILT_FIELDS[c.kind] : BELEGT_FIELDS[c.kind]);
      for (const field of GETEILT_FIELDS[c.kind]) {
        const has = Object.hasOwn(patch, field);
        assert.ok(has,
          `${JSON.stringify(c)}: "${field}" is ABSENT from the patch. The family materializer is a `
          + 'per-field LWW fold — no register write occurs, the old value keeps its stamp, and the '
          + 'entry looks downgraded on my board while staying fully readable on Mama\'s '
          + '(ADR 004 §5.1). OMISSION IS NOT WITHDRAWAL.');
        if (!permitted.has(field) || !c.alive) {
          if (field === 'pub.level' || field === 'pub.alive') continue;
          assert.equal(patch[field], null,
            `${JSON.stringify(c)}: "${field}" is not permitted at ${c.to} and is not null`);
        }
      }
    }
    assert.ok(published >= 60 && silent >= 20,
      `NON-VACUITY: ${published} cells published and ${silent} were silent`);
  });

  test('the withdrawal is UNCONDITIONAL — it does not depend on where the transition came from', () => {
    // "A field outside this level's allowlist is written `null` on EVERY publish, so there is no
    // ordering, no 'did we come from Geteilt', and nothing for a later edit to forget."
    for (const kind of ['fnote', 'fbar']) {
      const shapes = new Set();
      for (const lastPublished of [null, 'privat', 'belegt', 'geteilt']) {
        const p = projectForFamily(kind, TRUTH(kind, 'belegt', true), 'belegt', lastPublished);
        // `_born` legitimately differs on a first publication; everything else may not.
        const { _born, ...rest } = p;
        shapes.add(JSON.stringify(rest));
        void _born;
      }
      assert.equal(shapes.size, 1,
        `${kind}: a Belegt publication has ${shapes.size} shapes depending on what was published `
        + 'before. Then a peer with a different history than this device assumed keeps a field.');
    }
  });

  test('`planTransition` and the real projection agree on every cell — a prediction that drifts', () => {
    for (const c of TRANSITIONS) {
      const plan = planTransition({ from: c.from, to: c.to, lastPublished: c.lastPublished, alive: c.alive });
      const patch = projectForFamily(c.kind, TRUTH(c.kind, c.to, c.alive), c.to, c.lastPublished);
      const actual = patch === null ? 'none' : (patch['pub.level'] === 'privat' ? 'retract' : 'publish');
      assert.equal(plan.family, actual, `${JSON.stringify(c)}: plan says ${plan.family}, projection did ${actual}`);
    }
  });

  test('a retraction names nothing about where it came from (Principle 9, on the bytes)', () => {
    for (const kind of ['fnote', 'fbar']) {
      const r = JSON.stringify(retractPatch(kind));
      assert.equal(/belegt|geteilt/.test(r), false, `${kind}: the retraction names a level: ${r}`);
      assert.equal(retractPatch.length, 1,
        'retractPatch takes more than the kind — then a peer could recover what was withdrawn FROM');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · ⚠ FINDING E7L-2 — THE OWNER'S SECOND MAC. `→ Privat` EMITS NOTHING.
//
// `derivePublication` derives `lastPublished` from the LOCALLY FOLDED `pub.level` register:
//
//     const lastRaw = foldedValue(regs, fkey, 'pub.level');
//     const lastPublished = VISIBILITY_LEVELS.includes(lastRaw) ? lastRaw : null;
//
// and `projectForFamily` then reads `wasPublished === false` as "16.1 — nothing to publish":
//
//     if (level === 'privat') return wasPublished ? retractPatch(kind) : null;
//
// THOSE ARE TWO DIFFERENT CLAIMS AND ONLY THE FIRST IS SAFE. "I hold no `pub.level` for this
// entity" means *this device does not know whether it was published*, not *it was never
// published*. A member's own second Mac holds two INDEPENDENT cursors (`sync/personal.js` and
// `sync/family.js`, separate engines, separate epochs, separate failure modes): the personal
// space carries `visibility` and the family space carries `pub.level`, and the family one can
// legitimately be behind — offline, no epoch key yet (D9's window), a failed pull, or a Mac
// paired yesterday whose board arrived through a backup restore.
//
// `retractPatch`'s own docblock states the rule this violates: "the full set is emitted on EVERY
// retraction regardless of what was published before, because 'which fields did this entity ever
// carry' is a question with a different answer on every peer, and INV-R4 is a claim about all of
// them." It is honoured INSIDE `retractPatch` and defeated by the gate that decides whether to
// call it.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The `ctx` `derivePublication` takes, over a register map this test owns. */
function deriveCtx(regs, truth) {
  return {
    act: RIG.PAPA.memberId, dev: RIG.PAPA.devices[0].deviceId, gid: 'g'.repeat(22),
    space: RIG.FSP, familySpaceId: RIG.FSP, me: RIG.PAPA.memberId,
    mint: () => `1788000000000.000001.${RIG.PAPA.devices[0].deviceShort}`,
    newOpId: () => 'y'.repeat(22), newGid: () => 'g'.repeat(22),
    truthOf: () => truth,
  };
}

describe('E7-J · the owner\'s second Mac — a withdrawal that is never authored (FINDING E7L-2)', () => {
  const UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const localOps = [{
    v: 1, id: 'x'.repeat(22), ts: '1', space: 'psp_x', act: null, dev: null, gid: 'g'.repeat(22),
    k: 'note.set', e: `note:${UUID}`, f: { visibility: 'privat' },
  }];

  /** A register map for one entity, with or without the family half. */
  function regsWith(pubLevel) {
    const m = new Map();
    if (pubLevel !== undefined) {
      m.set(familyKey('fnote', RIG.PAPA.memberId, UUID), new Map([
        ['pub.level', { value: pubLevel, ts: '1', op: 'o' }],
        ['pub.text', { value: SHARED.text, ts: '1', op: 'o' }],
      ]));
    }
    return { get: (k) => m.get(k) };
  }

  const TRUTH_PRIVAT = {
    visibility: 'privat', date: DATE, text: SHARED.text, repeatsYearly: false, coEdit: false, _alive: true,
  };

  test('CONTROL — a Mac whose family cursor is up to date emits the retraction', () => {
    const ops = derivePublication(
      localOps.map((o) => ({ ...o, act: RIG.PAPA.memberId, dev: RIG.PAPA.devices[0].deviceId })),
      regsWith('geteilt'), deriveCtx(null, TRUTH_PRIVAT));
    assert.equal(ops.length, 1, 'the control emitted nothing — the row below proves nothing');
    assert.equal(ops[0].f['pub.text'], null);
    assert.equal(ops[0].f['pub.level'], 'privat');
  });

  test('⚠ the SAME transition on a Mac whose family cursor is behind emits NOTHING', () => {
    const ops = derivePublication(
      localOps.map((o) => ({ ...o, act: RIG.PAPA.memberId, dev: RIG.PAPA.devices[0].deviceId })),
      regsWith(undefined), deriveCtx(null, TRUTH_PRIVAT));
    assert.equal(ops.length, 0,
      'THE DEFECT IS THE OTHER WAY ROUND — see the assertion below. If this row goes red the '
      + 'finding is fixed and the whole suite should be re-read.');
    // THE FINDING, stated as the claim that is false:
    //   "for any sequence of transitions ending in `privat`, a peer's materialization contains no
    //    field of that entity but a tombstone" (P7d)
    // …is false whenever the device that authors the final `privat` does not hold the family
    // register that says the entity was ever published. The owner's board says Privat. The peer
    // keeps the text. Nothing anywhere records that a withdrawal is owed.
  });

  test('…and it is EXACTLY the `→ privat` row: every other downgrade publishes unconditionally', () => {
    // Geteilt → Belegt on the same ignorant Mac still emits `pub.text: null`, because the
    // withdrawal there is unconditional (§1's third row). So the hole is one cell wide, and it is
    // the cell ADR 004 §5's own commentary calls "THE `'privat'` ROW IS THE ONE THAT MATTERS".
    const ops = derivePublication(
      localOps.map((o) => ({ ...o, act: RIG.PAPA.memberId, dev: RIG.PAPA.devices[0].deviceId, f: { visibility: 'belegt' } })),
      regsWith(undefined),
      deriveCtx(null, { ...TRUTH_PRIVAT, visibility: 'belegt' }));
    assert.equal(ops.length, 1);
    assert.equal(ops[0].f['pub.text'], null, 'even the ignorant Mac withdraws the text at belegt');
  });

  test('…and nothing on the OTHER Mac compensates: applyRemote never re-derives a publication', async () => {
    // The second half of the finding. If the ignorant Mac does not retract, the informed Mac
    // could — it learns `visibility: 'privat'` from the personal stream. It does not: the
    // publication is derived only by `_commit`, `undo` and `redo`, and `applyRemote` is none of
    // them. Measured on the shipped store.
    const id = papaNote({ level: 'geteilt', text: SHARED.text });
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    await drainAndSeal(RIG);
    const before = familyOps(RIG).length;
    const remote = {
      v: 1, id: 'z'.repeat(22),
      // A stamp comfortably newer than the local create, so the remote write really does win the
      // LWW fold — otherwise this row would measure a lost op rather than a missing publication.
      ts: `${Date.now() + 60000}.000001.${RIG.MAMA.devices[0].deviceShort}`,
      space: RIG.PSP, act: RIG.PAPA.memberId, dev: RIG.PAPA.devices[0].deviceId,
      gid: 'g'.repeat(22), k: 'note.set', e: `note:${id}`, f: { visibility: 'privat' },
    };
    const res = store.applyRemote([remote], {});
    assert.equal(res.applied.length, 1, `the remote truth write was refused: ${JSON.stringify(res.refused)}`);
    assert.equal(store.state.notes.find((n) => n.id === id).visibility, 'privat',
      'NON-VACUITY: this Mac now believes the entry is private');
    assert.equal(familyOps(RIG).length - before, 0,
      'applyRemote derived a publication — if this row is red the finding\'s second half is closed');
    assert.equal(getRegister(store._log.registers(), fk, 'pub.text').value, SHARED.text,
      'THE FINDING: this Mac shows the entry as Privat and the family register — the thing every '
      + 'peer also holds — still carries the plaintext. Neither Mac will ever withdraw it.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · THE LWW RACE — a peer that keeps the old register because the stamp lost
//
// ADR 004 §5.2's proof rests on `s(o) ≺ s(r)` for every prior content write, justified by "any
// remote write to E requires `pub.coEdit`, whose ops my clock also received and absorbed via
// `clock.observe()`". A co-editor's op my clock has NOT absorbed breaks that premise. So: give
// Mama a stamp ten minutes AHEAD of Papa's (clock skew, well inside the drift clamp), have Papa
// retract without pulling it, and see whether her value survives on Oma's board.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-K · the co-editor whose stamp beats the retraction', () => {
  test('Geteilt → Privat: Mama\'s future-stamped `pub.text` does NOT survive on Oma\'s board', async () => {
    const id = papaNote({ level: 'geteilt', text: SHARED.text, coEdit: true });
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    let opened = await openedFrom(RIG, await drainAndSeal(RIG));
    const mama = famOpFrom(RIG, RIG.MAMA, RIG.MAMA.devices[0], 'pub.set', fk,
      { 'pub.text': 'MAMA-EDIT-1' }, Date.now() + 600000);
    assert.equal(validateOp(mama).ok, true, 'NON-VACUITY: Mama\'s op is well-formed and admissible on shape');
    setLevel('note', id, 'privat');
    opened = [...opened, ...(await openedFrom(RIG, await drainAndSeal(RIG)))];

    const v = peerFoldFull(RIG, RIG.OMA.memberId, [...opened, mama]);
    // THE MECHANISM, named so a change to it is visible: Mama's op is not out-ranked by a stamp,
    // it is REJECTED — the retraction wrote `pub.coEdit: null`, stage 3a folds governing fields
    // over the whole set FIRST, and stage 3b then admits a co-editor's write only while the
    // FOLDED `pub.coEdit` is true. The revocation is therefore RETROACTIVE and order-independent.
    const why = v.rejected.map((o) => v.rejectionOf(o.id));
    assert.equal(v.rejected.length, 1, `expected Mama's write to be refused, got ${JSON.stringify(why)}`);
    assert.equal(why[0].reason, 'noCoEdit',
      'Mama\'s write was refused for a different reason than the co-edit revocation. If it is '
      + 'ever ADMITTED, its newer stamp wins the LWW fold and the retraction does not remove.');
    assert.equal((getRegister(v.regs, fk, 'pub.text') || {}).value ?? null, null);
    assert.equal((getRegister(v.regs, fk, 'pub.level') || {}).value, 'privat');
    const board = materialize(v.regs, MCTX(RIG, RIG.OMA.memberId));
    assert.deepEqual(board.notes.filter((n) => n.entityKey === fk), []);
  });

  test('Geteilt → Belegt: and if the co-edit write WERE admitted, stage 3c would still drop it', async () => {
    // The second leg, measured independently: `authz.js` stage 3c drops a `geteiltOnly` field
    // carrying a non-null value while the FINAL FOLDED level is not `geteilt` — retroactive by
    // construction, in any arrival order. Two legs, and either alone would hold this row.
    const id = papaNote({ level: 'geteilt', text: SHARED.text, coEdit: true });
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    let opened = await openedFrom(RIG, await drainAndSeal(RIG));
    const mama = famOpFrom(RIG, RIG.MAMA, RIG.MAMA.devices[0], 'pub.set', fk,
      { 'pub.text': 'MAMA-EDIT-2' }, Date.now() + 600000);
    setLevel('note', id, 'belegt');
    opened = [...opened, ...(await openedFrom(RIG, await drainAndSeal(RIG)))];
    const v = peerFoldFull(RIG, RIG.OMA.memberId, [...opened, mama]);
    assert.equal((getRegister(v.regs, fk, 'pub.text') || {}).value ?? null, null,
      'a co-editor\'s future-stamped text survived a downgrade to belegt');
    assert.ok(Array.isArray(v.contentAboveLevel));
    const seen = materialize(v.regs, MCTX(RIG, RIG.OMA.memberId)).notes.find((n) => n.entityKey === fk);
    assert.ok(seen, 'NON-VACUITY: Oma still sees the block');
    assert.equal(seen.redacted, true);
    assert.equal(seen.text ?? null, null, 'the Belegt block carries text');
  });

  test('the arrival ORDER of the co-edit and the downgrade changes nothing', async () => {
    const id = papaNote({ level: 'geteilt', text: SHARED.text, coEdit: true });
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    const first = await openedFrom(RIG, await drainAndSeal(RIG));
    const mama = famOpFrom(RIG, RIG.MAMA, RIG.MAMA.devices[0], 'pub.set', fk,
      { 'pub.text': 'MAMA-EDIT-3' }, Date.now() + 600000);
    setLevel('note', id, 'privat');
    const second = await openedFrom(RIG, await drainAndSeal(RIG));
    const orders = [
      [...first, mama, ...second],
      [...first, ...second, mama],
      [mama, ...first, ...second],
    ];
    for (const [i, ops] of orders.entries()) {
      const regs = peerFoldFull(RIG, RIG.OMA.memberId, ops).regs;
      assert.equal((getRegister(regs, fk, 'pub.text') || {}).value ?? null, null, `order ${i}`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · ⚠ FINDING E7L-3 — THE REDACTION HALT IS THE §5.1 FAILURE, WEARING §2.3'S NAME
//
// §2.3 requires the loud path so that a family op is "NEVER silently omitted — because a silently
// omitted downgrade op is exactly the failure in §5". `store._publishAndEnqueue` implements it,
// and its SECOND line is
//
//     if (this.redactionHalt) return [];        // already halted; do not compound it
//
// which returns BEFORE `derivePublication` runs. So from the halt onward every visibility change
// is committed to the truth and never projected. The halt is in-memory (`store.js:1334`), so a
// relaunch clears it and family sync resumes — with the withdrawal never authored.
//
// The right place to hold a halt is `familyOutbox()`, which already does it: the ops sit in the
// log with no `seq` and are pushed when the halt lifts. THIS second guard is the defect.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-L · the redaction halt loses the downgrade it exists to protect (FINDING E7L-3)', () => {
  test('a downgrade authored while halted is never derived — not then, and not after the halt lifts', async () => {
    const id = papaNote({ level: 'geteilt', text: SHARED.text });
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    await drainAndSeal(RIG);
    const pubsFor = () => familyOps(RIG).filter((o) => o.e === fk);
    assert.equal(pubsFor().length, 1, 'NON-VACUITY: it really was published');
    assert.equal(pubsFor()[0].f['pub.text'], SHARED.text);

    // The halt. Its CAUSE is irrelevant to the row — §2.3 exists precisely because a
    // `RedactionError` on the publish path is a thing the design admits can happen.
    store.redactionHalt = { at: new Date().toISOString(), barrier: 'barrier1', message: 'induced', gid: null };

    setLevel('note', id, 'privat');
    assert.equal(store.state.notes.find((n) => n.id === id).visibility, 'privat',
      'NON-VACUITY: the TRUTH write landed — only the publication was dropped');
    assert.equal(pubsFor().length, 1, 'the retraction was derived while halted');

    // The relaunch. `redactionHalt` is an in-memory field with no persisted counterpart, so this
    // is what the next launch looks like.
    store.redactionHalt = null;
    assert.equal(pubsFor().length, 1,
      'THE FINDING: family sync has resumed and the withdrawal was never authored. Papa\'s board '
      + 'says Privat; the family still holds the text; nothing anywhere records that a retraction '
      + 'is owed. This is ADR 004 §5.1\'s failure produced by the code that implements §2.3\'s '
      + 'promise never to produce it.');

    // …and the self-healing that DOES exist, so the size of the window is on the record:
    // `derivePublication` compares state, so the next time the user happens to touch this entity
    // the retraction is finally emitted. That may be tomorrow; it may be never.
    store.txn('edit', (tx) => { tx.note(id).set({ text: 'egal' }); });
    assert.equal(pubsFor().length, 2, 'a later touch re-derives it');
    assert.equal(pubsFor()[1].f['pub.level'], 'privat');
    assert.equal(pubsFor()[1].f['pub.text'], null);
  });

  test('`familyOutbox` holds the line while halted, which is the correct half and already there', async () => {
    const id = papaNote({ level: 'geteilt', text: SHARED.text });
    assert.ok(store.familyOutbox().length >= 1);
    store.redactionHalt = { at: 'x', barrier: 'barrier1', message: 'induced', gid: null };
    assert.deepEqual(store.familyOutbox(), [], 'the halt must stop PUBLICATION');
    store.redactionHalt = null;
    assert.ok(store.familyOutbox().length >= 1,
      'and the ops must still be there when it lifts — which is why the guard in '
      + '`_publishAndEnqueue` buys nothing and costs the withdrawal');
    await drainAndSeal(RIG);
    void id;
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · ⚠ FINDING E7L-1 — `replaceAll()` UN-SHARES LOCALLY AND WITHDRAWS NOTHING
//
// Stories 11.3 (import) and 11.5 (snapshot restore) both go through `store.replaceAll()`.
// `core/replace.js:IMPORT_DEFAULTS` FORCES `visibility: 'privat'` on every entry — RECHECK-40-3,
// "the privacy floor a file may not raise", and it is right. But `replaceAll()` appends its ops
// directly and NEVER CALLS `_publishAndEnqueue`; the only hand-off is
//
//     this.publisher.retract(plan.retractions);
//
// and `plan.retractions` covers only the entities the replacement TOMBSTONED. An entry that
// SURVIVES the restore is forced to `privat` with no retraction computed at all, and the list
// that IS computed goes to `createPersonalPublisher`, whose `drain()` has no caller anywhere in
// `src/js/`.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-M · snapshot restore / import withdraws nothing (FINDING E7L-1)', () => {
  const RESTORED = (notes) => ({
    schemaVersion: 1,
    notes,
    bars: [],
    categories: [{ id: 'cat-1', name: 'Familie', colorRef: 'gruen', visible: true }],
    scratchpads: {},
    settings: null,
  });

  test('an entry that SURVIVES the restore is forced to privat and never withdrawn', async () => {
    const id = papaNote({ level: 'geteilt', text: SHARED.text });
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    const published = await openedFrom(RIG, await drainAndSeal(RIG));
    assert.equal(published.filter((o) => o.e === fk).length, 1, 'NON-VACUITY: it was published');

    const before = familyOps(RIG).length;
    const ok = store.replaceAll(RESTORED([
      { id, date: DATE, text: SHARED.text, categoryId: 'cat-1', repeatsYearly: false },
    ]));
    assert.notEqual(ok, false, 'the restore itself must succeed, or this row measures nothing');

    assert.equal(store.state.notes.find((n) => n.id === id).visibility, 'privat',
      'NON-VACUITY: RECHECK-40-3\'s privacy floor did fire — the truth register says privat');
    assert.equal(familyOps(RIG).length - before, 0,
      'the restore emitted a family op — if this row is red the finding is fixed');
    assert.deepEqual(store.familyOutbox(), []);
    assert.equal(store.publisher.pendingRetractions.includes(fk), false,
      'not even a MEMO was recorded for the SURVIVING entry: `plan.retractions` covers only the '
      + 'entities the replacement tombstoned, and this one is still on the board — forced to '
      + 'privat, still published, and on no list.');
    assert.equal(getRegister(store._log.registers(), fk, 'pub.text').value, SHARED.text,
      'THE FINDING: Papa\'s board now says Privat for every entry on it, and the family register '
      + '— which every peer also holds — still carries the plaintext of every one of them. One '
      + 'click on „Wiederherstellen" and the owner believes he has un-shared his whole board.');

    const board = materialize(peerFold(RIG, RIG.MAMA.memberId, published), MCTX(RIG, RIG.MAMA.memberId));
    const seen = board.notes.find((n) => n.entityKey === fk);
    assert.ok(seen, 'Mama lost the entry for an unrelated reason — the row is vacuous');
    assert.equal(seen.text, SHARED.text, 'Mama still reads the text after Papa\'s board says Privat');
  });

  test('the file is not even asked about: a v1-shaped snapshot triggers no re-share question', () => {
    // `replace.js` offers a `reshares` list so the user can be asked „Diese Datei möchte 3
    // Einträge wieder mit deiner Familie teilen." — but it is only populated when the FILE
    // SUPPLIED a `visibility`. Every pre-E7 snapshot and every v1 export omits it, so the
    // downgrade is silent in both directions: nothing is withdrawn and nothing is offered back.
    assert.deepEqual(store.publisher.pendingReshares, [],
      'a re-share question WAS offered — then the user is at least asked, and the finding is '
      + 'narrower than it is written');
  });

  test('an entry the restore DELETES records a memo — and nothing in the product ever reads it', async () => {
    const id = papaNote({ level: 'geteilt', text: `Zweites ${SHARED.text}` });
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    await drainAndSeal(RIG);
    const before = familyOps(RIG).length;
    store.replaceAll(RESTORED([]));                   // the entry is not in the file
    assert.equal(familyOps(RIG).length - before, 0, 'the delete emitted a family op');
    assert.ok(store.publisher.pendingRetractions.includes(fk),
      'the memo was not even recorded — then the finding is worse, not better');
    assert.equal(getRegister(store._log.registers(), fk, 'pub.level').value, 'geteilt',
      'the family register still says geteilt for an entry that is no longer on Papa\'s board');
    // `createPersonalPublisher().drain()` is the seam that would consume this. It has no caller.
    assert.equal(typeof store.publisher.drain === 'function' || store.publisher.drain === undefined, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · ⚠ FINDING E7L-4 — A QUARANTINED RETRACTION, AND THE COPY THAT SAYS THE COMFORTING HALF
//
// `sync/family.js` quarantines any op this build refuses to seal — correct for a publication (no
// peer could open it) and catastrophic for a WITHDRAWAL, which fails by leaving the disclosure
// standing. The warning reads „an entry could not be shared … It is still on your board", which
// is true of a publication and is the exact inverse of what happened to a retraction.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-N · a retraction that cannot be sealed (FINDING E7L-4)', () => {
  test('a `visibility: null` truth register authors a retraction that barrier 4 can never seal', async () => {
    const id = papaNote({ level: 'geteilt', text: SHARED.text });
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    await drainAndSeal(RIG);
    assert.equal(store.familyLevelOf(fk), 'geteilt');

    // `null` is the "cleared" value of every register (ADR 001 §2) and `validateOp` accepts it for
    // an enum, so this is a well-formed op. No UI path writes it today — this is the INPUT that
    // demonstrates the failure MODE, not a claim that the UI reaches it.
    store.txn('clear-vis', (tx) => { tx.note(id).set({ visibility: null }); });
    assert.equal(store.familyLevelOf(fk), null,
      'barrier 4 now has no authenticated level for the entity — "you cannot publish"');

    const drained = await drainAndSeal(RIG);
    const refusals = drained.filter((d) => d.refused);
    assert.ok(refusals.length >= 1, 'nothing was refused — the row measures nothing');
    assert.equal(refusals[0].barrier ?? refusals[0].refused, 'barrier4');
    // The op that was refused IS the retraction — the withdrawal, not a publication.
    assert.equal(refusals[0].op.f['pub.level'], 'privat',
      'THE FINDING: the op `sync/family.js` quarantines here is the WITHDRAWAL. A quarantine has '
      + 'no cure, the entry stays visible to the whole family, and the warning the user reads is '
      + '„an entry could not be shared … It is still on your board" — the reassuring half of an '
      + 'un-sharing that did not happen.');
    assert.equal(refusals[0].op.f['pub.text'], null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7 · ⚠ FINDING E7L-5 — "UNSHARING IS NOT UNREMEMBERING", LITERALLY: NO FORGET PASS
//
// ADR 004 §5.3 lists THREE mechanisms and says all are required. Mechanism 1 (the register
// overwrite) holds — §1 and §3 prove it. Mechanism 2, the FORGET PASS, does not exist:
//
//   > On applying a family op that sets a content field to `null` […] the receiving client
//   > immediately (a) removes the entity from the materialized arrays, (b) PURGES EVERY LINE IN
//   > ITS LOCAL `ops.jsonl` whose entity key matches and whose space is the family space, and (c)
//   > drops the corresponding register VALUES while RETAINING the stamps.
//
// (a) happens (materialization drops it) and (c) happens by LWW. (b) has no implementation:
// `grep -rn "purge" src/js/` finds only the relay's member purge. `core/registers.js` even
// documents the comparator's `null`-ranks-highest rule as existing SO THAT the forget blank wins
// its own tie — a defence built for a caller that was never written.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-O · the forget pass (ADR 004 §5.3 mechanism 2) does not exist (FINDING E7L-5)', () => {
  test('after a full retraction the peer\'s own op lines still carry the plaintext', async () => {
    const id = papaNote({ level: 'geteilt', text: SHARED.text });
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    const pub = await openedFrom(RIG, await drainAndSeal(RIG));
    setLevel('note', id, 'privat');
    const ret = await openedFrom(RIG, await drainAndSeal(RIG));

    const mamaHolds = [...pub, ...ret].filter((o) => o.e === fk);
    assert.equal(mamaHolds.length, 2, 'NON-VACUITY: Mama received both the publication and the withdrawal');

    // Mechanism 1 — the fold. This is the half that works, and it is what P7d asserts.
    const regs = peerFold(RIG, RIG.MAMA.memberId, [...pub, ...ret]);
    assert.equal((getRegister(regs, fk, 'pub.text') || {}).value ?? null, null);
    assert.deepEqual(
      materialize(regs, MCTX(RIG, RIG.MAMA.memberId)).notes.filter((n) => n.entityKey === fk), []);

    // Mechanism 2 — the disk. This is the half that does not exist.
    assert.equal(mamaHolds.some((o) => JSON.stringify(o).includes(SHARED.text)), true,
      'the forget pass has landed — DELETE THIS ROW rather than relaxing it');
    // Stated as the claim that is false: `ops.jsonl` is the durable store every client keeps
    // (ADR 003 §8.1), and after a retraction the withdrawn text is still a plain string in it on
    // every peer's disk. §5.2's proof is careful to exclude "a screenshot" and "a modified
    // client"; an UNMODIFIED client keeping the plaintext is inside the guarantee's scope.
  });

  test('and a cold re-delivery of the publication cannot un-blank it — the comparator half IS built', () => {
    // The half of §5.3 that was implemented: `registers.js` ranks `null` above every value and a
    // missing opId above every real one, so nothing can restore a withdrawn value at an equal
    // stamp. Pinned here because it is the mechanism the missing forget pass was designed around,
    // and a change to it would make the missing half worse rather than merely absent.
    const id = papaNote({ level: 'geteilt', text: SHARED.text });
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    return (async () => {
      const pub = await openedFrom(RIG, await drainAndSeal(RIG));
      setLevel('note', id, 'privat');
      const ret = await openedFrom(RIG, await drainAndSeal(RIG));
      const regs = peerFold(RIG, RIG.MAMA.memberId, [...pub, ...ret, ...pub, ...pub]);
      assert.equal((getRegister(regs, fk, 'pub.text') || {}).value ?? null, null,
        'a re-delivered publication un-blanked a retracted field');
    })();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 8 · INV-R3 — CAN THE OWNER'S OWN BOARD BE MADE TO LIE?
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-P · INV-R3 — my own board never lies to me', () => {
  test('a Geteilt → Belegt downgrade does not blank my own note', async () => {
    const id = papaNote({ level: 'geteilt', text: SHARED.text });
    await drainAndSeal(RIG);
    setLevel('note', id, 'belegt');
    await drainAndSeal(RIG);
    const mine = store.state.notes.find((n) => n.id === id);
    assert.equal(mine.text, SHARED.text,
      'publishing `pub.text: null` blanked the owner\'s own note. That is the promotion rule '
      + 'promoting my own `pub.*` write — ADR 004 §4.1, property P7c.');
    assert.equal(mine.visibility, 'belegt');
    assert.equal(mine.redacted ?? false, false, 'my own entry rendered as redacted on my own board');
  });

  test('…and a full retraction does not either', async () => {
    const id = papaNote({ level: 'geteilt', text: SHARED.text });
    await drainAndSeal(RIG);
    setLevel('note', id, 'privat');
    await drainAndSeal(RIG);
    const mine = store.state.notes.find((n) => n.id === id);
    assert.equal(mine.text, SHARED.text);
    assert.equal(mine.visibility, 'privat');
  });

  test('a `pub.text: null` authored by MY OTHER MAC is still mine and is not promoted', async () => {
    // `me` is the MemberId, so both of Papa's Macs are "me" — the asymmetry is per MEMBER, not
    // per device. If it were per device, a downgrade performed on the laptop would blank the
    // note on the desktop, which is INV-R3 failing in the least visible possible way.
    const id = papaNote({ level: 'geteilt', text: SHARED.text });
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    await drainAndSeal(RIG);
    const other = famOpFrom(RIG, RIG.PAPA, RIG.PAPA.devices[0], 'pub.set', fk,
      { 'pub.level': 'belegt', 'pub.text': null, 'pub.coEdit': null }, Date.now() + 600000);
    const res = store.applyRemote([other], {});
    assert.equal(res.applied.length, 1, `refused: ${JSON.stringify(res.refused)}`);
    assert.equal(store.state.notes.find((n) => n.id === id).text, SHARED.text,
      'my other Mac\'s projection blanked my note');
  });

  test('a CO-EDITOR\'s null IS promoted (18.2) — the other half of the same asymmetry', async () => {
    // Two nulls that must be told apart (`registers.js:withdrawnByOther`): mine is a PROJECTION
    // and is never promoted (the row above); a co-editor's is an EDIT and always is. Getting
    // either wrong is invisible in the obvious direction — the wrong one leaves my stale text on
    // screen and looks like nothing happened. The ADMIN-unshare third case needs a circle whose
    // admin is not the owner and lives in `ownership-authz-admin.test.js`.
    const id = papaNote({ level: 'geteilt', text: SHARED.text, coEdit: true });
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    await drainAndSeal(RIG);
    const coedit = famOpFrom(RIG, RIG.MAMA, RIG.MAMA.devices[0], 'pub.set', fk,
      { 'pub.text': null }, Date.now() + 600000);
    const res = store.applyRemote([coedit], {});
    assert.equal(res.applied.length, 1, `refused: ${JSON.stringify(res.refused)}`);
    const after = store.state.notes.find((n) => n.id === id);
    // Either reading is the co-editor's clear having been promoted: a note with no text is not
    // renderable in v1 (`entities.js:renderableNote`) and leaves the board entirely.
    assert.equal(after === undefined || (after.text ?? null) === null, true,
      `a co-editor cleared my text and it was not promoted — 18.2 says it must be `
      + `(the entry still reads ${JSON.stringify(after && after.text)})`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 9 · PRINCIPLE 9 — CAN A MEMBER DETECT THAT SOMEBODY DOWNGRADED?
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-Q · the no-snitch rule', () => {
  test('a downgraded Belegt entry is REGISTER-IDENTICAL to one that was always Belegt', async () => {
    const born = papaNote({ level: 'belegt', text: SECRET.noteText, date: '2027-02-02' });
    const fell = papaNote({ level: 'geteilt', text: SHARED.text, date: '2027-02-02' });
    let opened = await openedFrom(RIG, await drainAndSeal(RIG));
    setLevel('note', fell, 'belegt');
    opened = [...opened, ...(await openedFrom(RIG, await drainAndSeal(RIG)))];

    const regs = peerFold(RIG, RIG.OMA.memberId, opened);
    const shape = (uuid) => {
      const fk = familyKey('fnote', RIG.PAPA.memberId, uuid);
      const out = {};
      for (const f of [...GETEILT_FIELDS.fnote]) {
        const c = getRegister(regs, fk, f);
        out[f] = c ? c.value : undefined;
      }
      return out;
    };
    assert.deepEqual(shape(fell), shape(born),
      'a Geteilt→Belegt entry and a born-Belegt one differ in their register VALUES, so „war '
      + 'geteilt" is derivable from the fold — ADR 004 §7 rule 1.');
  });

  test('the „neu" dot never fires on a downgrade, and a downgraded entry is never `isNew`', async () => {
    const id = papaNote({ level: 'geteilt', text: SHARED.text, date: '2027-03-03' });
    let opened = await openedFrom(RIG, await drainAndSeal(RIG));
    setLevel('note', id, 'belegt');
    opened = [...opened, ...(await openedFrom(RIG, await drainAndSeal(RIG)))];
    const ctx = { ...MCTX(RIG, RIG.OMA.memberId), lastSeenSeq: { [RIG.FSP]: 0 } };
    const board = materialize(peerFold(RIG, RIG.OMA.memberId, opened), ctx);
    const seen = board.notes.find((n) => n.entityKey === familyKey('fnote', RIG.PAPA.memberId, id));
    assert.ok(seen, 'NON-VACUITY: Oma holds the block');
    assert.equal(seen.isNew ?? false, false,
      'the downgrade lit the „neu" dot — the app reported on somebody\'s privacy choice');
  });

  test('the entry carries no level history and nothing from which one could be derived', async () => {
    const id = papaNote({ level: 'geteilt', text: SHARED.text, date: '2027-04-04' });
    let opened = await openedFrom(RIG, await drainAndSeal(RIG));
    setLevel('note', id, 'belegt');
    opened = [...opened, ...(await openedFrom(RIG, await drainAndSeal(RIG)))];
    const board = materialize(peerFold(RIG, RIG.OMA.memberId, opened), MCTX(RIG, RIG.OMA.memberId));
    const seen = board.notes.find((n) => n.entityKey === familyKey('fnote', RIG.PAPA.memberId, id));
    for (const k of Object.keys(seen)) {
      assert.equal(/previous|was|history|former|prior|downgrad|retract/i.test(k), false,
        `the rendered entry carries "${k}"`);
    }
    assert.equal(JSON.stringify(seen).includes('geteilt'), false,
      'the downgraded entry still names `geteilt` somewhere in its projection');
  });
});
