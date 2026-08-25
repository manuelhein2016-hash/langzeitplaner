// tests/attack/recheck-att40-replace.test.js
//
// SECOND ADVERSARY PASS against the ATT-40 fix — the new `src/js/core/replace.js`.
//
// Four attacks were run against it. TWO FAILED, and they are the two the module was built to
// stop: the family-scope gate holds (an import cannot touch `fnote:`, `fbar:`, `member:` or
// `space:`, and the post-build invariant re-check really does re-check every emitted op), and
// two paired devices importing the same file converge.
//
// TWO SUCCEEDED:
//
//   1. VISIBILITY IS TAKEN FROM THE FILE. `IMPORT_DEFAULTS`' own docblock says
//      "`visibility: 'privat'` is … the one default in here that is load-bearing for privacy",
//      and `_alive` is forced "never taken from the file" for exactly that reason — but
//      `visibility` and `coEdit` are not forced. `buildPatch` writes `patch[name] = ok ? value :
//      defaults[name]`, so a board.json that carries `visibility: "geteilt", coEdit: true` sets
//      those truth registers, which is what a publisher reads. `migrateV1` — the other door,
//      reading the same file — forces `privat` and story 16.1 says it must.
//
//   2. AN IMPORT RETRACTS LOCALLY AND PUBLISHES FOREVER. Step 3 tombstones the personal `note:`
//      of every live entry the import lacks, and cannot touch the `fnote:` that published it. The
//      entry disappears from my board and stays on the family's, with `pub.text` intact. That is
//      correct scoping and an incomplete transaction: nothing in the plan marks the outstanding
//      retraction, and `replaceAllOps()` throws away the `removed` list that is the only trace.
//
// Also recorded: `REPLACE_ALL_UNDOABLE` is an exported constant, not a mechanism — nothing in
// core refuses to build an undo image over a replace transaction.
//
// HOLE tests pass by asserting the defect. Red here means fixed; invert, do not repair.

import test from 'node:test';
import assert from 'node:assert/strict';

import { planReplaceAll, replaceAllOps, REPLACE_ALL_UNDOABLE, REPLACEABLE_KINDS } from '../../src/js/core/replace.js';
import { migrateV1 } from '../../src/js/core/migrate1to2.js';
import { captureImages } from '../../src/js/core/undo.js';
import { foldAll, cloneRegisters } from '../../src/js/core/registers.js';
import { noteKey, familyKey, memberKey, spaceKey } from '../../src/js/core/entities.js';
import { fmt } from '../../src/js/core/stamp.js';
import { BASE_MS, DEV, ME, MAMA, PSP, FSP, minter, pad22, regsJSON } from './_kit.js';

const CAT = Object.freeze({ id: 'cat-1', name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true });
const board = (o) => ({ schemaVersion: 1, categories: [CAT], notes: [], bars: [], scratchpads: {}, settings: {}, ...o });
const me = minter(DEV.meDesk);
const mama = minter(DEV.mama);

const ctxAt = (tag, startMs = BASE_MS + 100_000) => {
  let n = 0;
  return {
    mint: () => fmt(startMs + (++n), 0, DEV.meDesk.short),
    me: ME, deviceId: DEV.meDesk.id, personalSpaceId: PSP,
    gid: pad22(`G${tag}`), newOpId: () => pad22(`${tag}${n}`),
  };
};

/** A board that is published to the family: one live shared note of mine, one of MAMA's. */
function publishedWorld() {
  return foldAll(new Map(), [
    me('note.set', noteKey('n1'), {
      date: '2026-09-10', text: 'Zahnarzt', categoryId: 'cat-1', repeatsYearly: false,
      visibility: 'geteilt', coEdit: true, _alive: true,
    }, { ms: BASE_MS, space: PSP }),
    me('pub.set', familyKey('fnote', ME, 'n1'), {
      'pub.level': 'geteilt', 'pub.coEdit': true, 'pub.alive': true,
      'pub.date': '2026-09-10', 'pub.text': 'Zahnarzt',
    }, { ms: BASE_MS + 1, space: FSP }),
    mama('pub.set', familyKey('fnote', MAMA, 'm1'), {
      'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-10-01', 'pub.text': 'Mamas Termin',
    }, { ms: BASE_MS + 2, space: FSP }),
    mama('member.set', memberKey(MAMA), { displayName: 'Mama', colorRef: 'p1', _alive: true },
      { ms: BASE_MS + 3, space: FSP }),
    mama('space.set', spaceKey(FSP), { admin: MAMA, adminPrev: null, name: 'Familie' },
      { ms: BASE_MS + 4, space: FSP }),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-40-1 — ATTACK FAILED. The family-scope gate holds.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-40-1 — CONTROL: an import cannot blank a family member`s entry', () => {
  const regs = publishedWorld();
  const before = regsJSON(regs);

  // An import that lists nothing at all: the maximal sweep this module can produce.
  const plan = planReplaceAll(regs, board({}), ctxAt('A'));

  assert.ok(plan.ops.length > 0, 'non-vacuity: the transaction is not empty');
  for (const op of plan.ops) {
    const kind = op.e.slice(0, op.e.indexOf(':'));
    assert.ok(REPLACEABLE_KINDS.includes(kind), `${op.e} is out of scope`);
    assert.ok(!op.e.startsWith('fnote:') && !op.e.startsWith('fbar:')
      && !op.e.startsWith('member:') && !op.e.startsWith('space:'));
    assert.ok(op.space === PSP || op.space === 'local', `${op.e} landed in ${op.space}`);
    for (const f of Object.keys(op.f)) assert.ok(!f.startsWith('pub.'), `${op.e} wrote ${f}`);
  }
  const after = foldAll(cloneRegisters(regs), plan.ops);
  assert.equal(after.get(familyKey('fnote', MAMA, 'm1')).get('pub.alive').value, true);
  assert.equal(after.get(familyKey('fnote', MAMA, 'm1')).get('pub.text').value, 'Mamas Termin');
  assert.equal(after.get(memberKey(MAMA)).get('_alive').value, true);
  assert.equal(after.get(spaceKey(FSP)).get('admin').value, MAMA);
  assert.equal(regsJSON(regs), before, 'and planReplaceAll did not mutate the register map');
});

test('RECHECK-40-2 — CONTROL: two paired devices importing the same file converge', () => {
  const start = foldAll(new Map(), [
    me('note.set', noteKey('old'), { date: '2026-01-01', text: 'alt', categoryId: 'cat-1', repeatsYearly: false, _alive: true },
      { ms: BASE_MS, space: PSP }),
  ]);
  const file = board({ notes: [{ id: 'n9', date: '2026-09-10', text: 'neu', categoryId: 'cat-1', repeatsYearly: false }] });

  // Desktop imports at T+1000, laptop at T+2000; each ships its ops to the other.
  const deskOps = replaceAllOps(start, file, ctxAt('D', BASE_MS + 1000));
  const lapOps = replaceAllOps(start, file, ctxAt('L', BASE_MS + 2000));
  const one = foldAll(cloneRegisters(start), [...deskOps, ...lapOps]);
  const other = foldAll(cloneRegisters(start), [...lapOps, ...deskOps]);
  assert.equal(regsJSON(one), regsJSON(other), 'order-independent');
  assert.equal(one.get(noteKey('n9')).get('text').value, 'neu');
  assert.equal(one.get(noteKey('old')).get('_alive').value, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-40-3 — HOLE. An import decides visibility, and the file gets to say so.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-40-3 — CLOSED: an imported file cannot set visibility geteilt / coEdit true', () => {
  const file = board({
    notes: [{
      id: 'p1', date: '2026-09-10', text: 'Therapie', categoryId: 'cat-1', repeatsYearly: false,
      visibility: 'geteilt', coEdit: true,
    }],
    bars: [{
      id: 'p2', startDate: '2026-07-01', endDate: '2026-08-31', label: 'Kur', categoryId: 'cat-1',
      visibility: 'geteilt', coEdit: true,
    }],
  });

  const plan = planReplaceAll(new Map(), file, ctxAt('V'));
  const note = plan.ops.find((o) => o.e === 'note:p1');
  const bar = plan.ops.find((o) => o.e === 'bar:p2');
  assert.equal(note.f.visibility, 'privat', 'CLOSED: the file does not decide the exposure');
  assert.equal(note.f.coEdit, false, 'CLOSED: nor whether the family may edit it');
  assert.equal(bar.f.visibility, 'privat');
  assert.equal(bar.f.coEdit, false);

  // The other door, the same file, the same story 16.1: forced private. The two now AGREE, which
  // is the actual fix — `IMPORT_DEFAULTS` is applied the way `migrate1to2.js` applies
  // `V2_ADDITIONS`, unconditionally, rather than as a fallback an understood value can override.
  const migrated = migrateV1(file, { memberId: ME, deviceId: DEV.meDesk.id, personalSpaceId: PSP, acceptLossy: true });
  assert.equal(migrated.ops.find((o) => o.e === 'note:p1').f.visibility, 'privat');
  assert.equal(migrated.ops.find((o) => o.e === 'note:p1').f.coEdit, note.f.coEdit);

  // NOT SILENTLY, in either direction. The file asked for something; the user is told what, and
  // gets to grant it deliberately. Refusing to widen exposure is not data loss, so `lossy` stays
  // false and a store that refuses lossy imports still restores this board.
  assert.deepEqual(plan.reshares, [
    { key: 'note:p1', visibility: 'geteilt', coEdit: true },
    { key: 'bar:p2', visibility: 'geteilt', coEdit: true },
  ]);
  assert.equal(plan.lossy, false);
  assert.ok(plan.warnings.some((w) => /does not decide who may see this entry/.test(w)),
    plan.warnings.join(' | '));

  // Non-vacuity: a file that asks for nothing produces no re-share offer at all.
  const quiet = planReplaceAll(new Map(), board({
    notes: [{ id: 'p4', date: '2026-09-10', text: 'x', categoryId: 'cat-1', repeatsYearly: false }],
  }), ctxAt('X'));
  assert.deepEqual(quiet.reshares, []);

  // And `_alive` is still forced — it always was, and it is not an exposure, so it is not offered
  // back as one.
  const dead = planReplaceAll(new Map(), board({
    notes: [{ id: 'p3', date: '2026-09-10', text: 'x', categoryId: 'cat-1', repeatsYearly: false, _alive: false }],
  }), ctxAt('W'));
  assert.equal(dead.ops.find((o) => o.e === 'note:p3').f._alive, true);
  assert.deepEqual(dead.reshares, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-40-4 — HOLE. The import retracts my entry from my board and leaves it on theirs.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-40-4 — HALF-CLOSED in core: the owed retraction is NAMED; performing it is WP-3\'s', () => {
  const regs = publishedWorld();
  const plan = planReplaceAll(regs, board({}), ctxAt('R'));
  const after = foldAll(cloneRegisters(regs), plan.ops);

  assert.deepEqual(plan.removed, [noteKey('n1')], 'non-vacuity: the import did retract it locally');
  assert.equal(after.get(noteKey('n1')).get('_alive').value, false);

  // STILL TRUE, AND DELIBERATE. This module may not write a family register — the scope gate is
  // what stops one person's snapshot restore from blanking the whole family's board, and ADR 001
  // §8.5 step 5 says so. So the publication is still live after the fold, and it has to be: the
  // publisher re-derives exposure, this module does not.
  assert.equal(after.get(familyKey('fnote', ME, 'n1')).get('pub.alive').value, true);

  // WHAT CHANGED: it is no longer SILENT. The plan names the family keys whose personal truth it
  // just tombstoned, so "a retraction is owed" is data the store can act on rather than something
  // a reader of `removed` has to re-derive by hand. Without this the entry vanished from my board
  // and stayed on theirs with nothing anywhere recording that anything was outstanding.
  assert.deepEqual(plan.retractions, [familyKey('fnote', ME, 'n1')],
    'the owed retraction is named, exactly once, in the plan');

  // Scoped like everything else here: MAMA published too, and her entry is not mine to retract.
  assert.ok(!plan.retractions.some((k) => k.includes(MAMA)), 'never another member\'s publication');

  // Non-vacuity in both directions: an unpublished note owes nothing…
  const plain = planReplaceAll(
    foldAll(new Map(), [me('note.set', noteKey('n9'), { date: '2026-09-10', text: 'x', _alive: true },
      { ms: BASE_MS, space: PSP })]),
    board({}), ctxAt('P'),
  );
  assert.deepEqual(plain.retractions, []);
  // …and an import that KEEPS the entry owes nothing either.
  const kept = planReplaceAll(regs, board({
    notes: [{ id: 'n1', date: '2026-09-10', text: 'Zahnarzt', categoryId: 'cat-1', repeatsYearly: false }],
  }), ctxAt('Q'));
  assert.deepEqual(kept.retractions, []);

  // ── STILL OPEN, AND REPORTED (WP-3) ──────────────────────────────────────────────────────
  // `replaceAllOps()` returns the ops alone, by contract (`ops.contract.js` §9), so the carrier
  // exists only on the PLAN. The store must call `planReplaceAll` — not the short entry point —
  // whenever it restores or imports, and hand `plan.retractions` to the publisher afterwards.
  // Core cannot enforce that from here; nothing in `core/` runs after the transaction lands.
  const ops = replaceAllOps(regs, board({}), ctxAt('S'));
  assert.ok(Array.isArray(ops) && !('removed' in ops),
    'ACCEPTED: the short entry point is still ops-only — use planReplaceAll for a restore');
});

test('RECHECK-40-5 — ACCEPTED (not a defect): an import resurrects a tombstone at a fresh stamp', () => {
  // ACCEPTED DEFECT — the PO-visible reason, stated so nobody "fixes" it later:
  //
  // This is what restore MEANS. v1's `replaceAll` installs the payload, so a snapshot restore
  // brings back what the snapshot held, deleted entries included; that is the entire feature
  // (story 11.5), and a restore that could not resurrect would not be a restore.
  //
  // The FRESH stamp is likewise not optional but load-bearing: ADR 001 §8.5's whole design is
  // that every op in the transaction outranks anything either device already holds, which is
  // what makes a paired Mac converge TO the import instead of fighting it. The consequence —
  // that it also overrides a delete made on my other Mac and not yet synced — is the documented
  // price, and ADR 001 §8.5 step 6 makes the app say so out loud before it happens:
  // „Wiederherstellen ändert auch, was deine Familie von dir sieht."
  //
  // Kept as a test, not deleted, because the day the stamp stops being fresh, convergence breaks
  // silently and this is the test that notices.
  const regs = foldAll(new Map(), [
    me('note.set', noteKey('d1'), { date: '2026-05-05', text: 'geloescht', categoryId: 'cat-1', _alive: false },
      { ms: BASE_MS + 50_000, space: PSP }),
  ]);
  const ops = replaceAllOps(regs, board({
    notes: [{ id: 'd1', date: '2026-05-05', text: 'wieder da', categoryId: 'cat-1', repeatsYearly: false }],
  }), ctxAt('T'));
  const after = foldAll(cloneRegisters(regs), ops);
  assert.equal(after.get(noteKey('d1')).get('_alive').value, true);
  assert.equal(after.get(noteKey('d1')).get('text').value, 'wieder da');
});

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-40-6 — HOLE (governance). "Import is excluded from undo" is a constant, not a rule.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-40-6 — ACCEPTED (open, WP-3): nothing in core refuses an undo image over a replace', () => {
  assert.equal(REPLACE_ALL_UNDOABLE, false, 'the module states the rule…');
  const regs = foldAll(new Map(), [
    me('note.set', noteKey('u1'), { date: '2026-01-01', text: 'alt', categoryId: 'cat-1', repeatsYearly: false, _alive: true },
      { ms: BASE_MS, space: PSP }),
  ]);
  const ops = replaceAllOps(regs, board({
    notes: [{ id: 'u2', date: '2026-02-02', text: 'neu', categoryId: 'cat-1', repeatsYearly: false }],
  }), ctxAt('U'));
  const images = captureImages(regs, ops);
  assert.ok(images.pre.length > 0 && images.post.length > 0,
    '…and `undo.js` will happily capture a before-image for it');

  // ACCEPTED, OPEN, AND OWNED BY WP-3 — the PO-visible reason:
  //
  // `captureImages(regs, ops)` is handed ops and nothing else. An op carries no label and no
  // "this was an import" bit, and it must not: a replace transaction is deliberately built out of
  // ORDINARY `note.set`/`bar.set` ops so that a paired device folds it by the ordinary rule
  // (that is the whole reason ADR 001 §12.6 rejects a `board.reset` primitive). Teaching
  // `undo.js` to recognise one would put back exactly the special case the log was designed
  // without.
  //
  // So story 5.4 is enforced where the transaction has a name: the STORE clears both stacks on
  // replace, as v1 does (`store.js:196-197`), and reads `REPLACE_ALL_UNDOABLE` to know it must.
  // Core exports the constant and cannot do more from here. WP-3 must wire it; there is no test
  // in this package that can prove it did.
});
