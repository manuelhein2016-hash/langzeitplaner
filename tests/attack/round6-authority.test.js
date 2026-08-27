// ─────────────────────────────────────────────────────────────────────────────
// ROUND 6 — ADVERSARY, ATTACK 3: WHERE R5-5a's FIX MOVED THE FAILURE
//
// R5-5a found the post-condition's blind spot: `v1ContentOf` compared id→fields maps, so an
// adopted log could disagree with `board.json` about ARRAY ORDER — which ADR 001 §5 step 5 calls
// MANDATORY, NOT COSMETIC — and the check could not see it. The fix put the id SEQUENCE into the
// comparison, so a log that disagrees about order is `reconcile-failed`. That is right.
//
// It is also a rule about a value the reconciler CANNOT MINT. `_born` is write-once. So the
// post-condition now refuses in a case the reconciler was never able to fix, and the question is
// which legitimate boards land in it. The answer is the one ADR 006 §5.4 names by name:
//
//   > "A Time-Machine restore of an older `board.json` is therefore honoured too — which is what
//   >  the user asked for by restoring it."
//
// It is honoured only while every entry the restore brings back was created LAST. `diffCollection`
// mints a re-appearing entry with `born: true` at a FRESH stamp, so it sorts to the END of the
// array; `board.json` has it where the user had it. Restore a board from before a delete in the
// middle and the two orders differ, the post-condition fires, and the ENTIRE history is
// quarantined — every stamp, every tombstone, every parked op, every cursor.
//
// ADR 006 R4 is doing its job: content is kept, whole, and the reason is true. This file is about
// what the reason COSTS on a path the ADR itself describes as ordinary, and about the second
// order effect §9.3 (W2) attaches to any quarantine on a board that carries a lineage.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LS, LS_BOARD, v2store, bootV2, v1board, note,
  J, bound, bootWith, slots, session, texts, addNote, delNote, editNote, bornOf,
} from './_round6-kit.js';

/**
 * The `_born` VALUE — which is what `entities.js:cmpNotes` sorts on, and NOT what the kit's
 * `bornOf` returns. `bornOf` reads the CELL'S STAMP, and for an op minted with `{born: true}` the
 * two coincide because `makeOp` writes `_born = ts`. They stop coinciding the moment the value is
 * chosen rather than taken from the clock, which is exactly what R6-7d is about: the op is stamped
 * NOW (so LWW is unchanged) and the register it writes holds a POSITION.
 */
const bornValue = (s, key) => s.registers().get(key)?.get('_born')?.value ?? null;

const THREE = () => v1board({
  notes: [note('n1', '2026-03-01', 'EINS'), note('n2', '2026-03-02', 'ZWEI'), note('n3', '2026-03-03', 'DREI')],
});

// ─────────────────────────────────────────────────────────────────────────────
// R6-7 — CLOSED. The reconciler can now MINT the order, so cell (b) is cell (d).
//
// WHAT CHANGED, AND WHY IT IS NOT A RELAXED POST-CONDITION. Relaxing R4 is D5's cell (c) and is
// unsound: the reconciler would move a user-visible order and nothing would guard it. The fix is
// on the other side of the table — `store.js:diffCollection` now decides `_born` per row from the
// enumerated input domain rather than from "is this id in `before`?":
//
//   the log holds a `_born` and the entity is NOT alive there  ⇒ a RESTORE. Write `_alive: true`
//       and the fields, and NO `_born`: a delete writes `_alive: false` and nothing else, so the
//       log still carries the original stamp, and that stamp IS the position `board.json` has the
//       entry in. This is R6-7a.
//   the log has never heard of the entity, and `board.json` puts it LAST ⇒ `born: true`. A fresh
//       mint sorts above everything, which is where it belongs. Unchanged — `mutate()`'s ordinary
//       append and R4-4a's "the board is ahead" note both live here.
//   the log has never heard of it and `board.json` puts it in the MIDDLE ⇒ an explicit `_born`
//       strictly between its neighbours', computed by `bornBetween`. This is R6-7d.
//   an entry alive in BOTH ⇒ never re-stamped. That is what keeps R5-5a refused (R6-7f).
//
// The op's own `ts` is still a fresh mint above the log's horizon in every case, so LWW is
// untouched; only the `_born` REGISTER VALUE is chosen, and `_born` is a position, not a time —
// ADR 001 §8.1's `GENESIS(i)` already encodes a v1 array index into that field.
// ─────────────────────────────────────────────────────────────────────────────

describe('R6-7 · the order post-condition on the paths ADR 006 blesses', () => {
  test('R6-7a INVERTED · a Time-Machine restore over this board\'s OWN log is honoured, history and all', async () => {
    const yesterday = await bound(THREE());         // session 1 — the copy Time Machine keeps
    await session(delNote('n2'));                   // session 2 — the user deletes the MIDDLE note
    const today = slots();
    assert.deepEqual(JSON.parse(today.board).notes.map((n) => n.text), ['EINS', 'DREI']);

    // Session 3: the user restores yesterday's board.json. Same lineage, same machine, same app.
    const s = await bootWith({ board: yesterday.board, ops: today.ops, checkpoint: today.checkpoint });

    assert.equal(s.quarantine, null, 'the restore ADR 006 §5.4 says is honoured is honoured');
    assert.deepEqual(texts(s), ['EINS', 'ZWEI', 'DREI'], 'content whole, in board.json\'s order');
    assert.equal(s._adopted?.reconciled, 1, 'ONE op — the restore — and the history is adopted');
    // The mechanism, asserted rather than inferred: `n2` still carries the stamp it was born with.
    assert.equal(bornValue(s, 'note:n2'), '0000000000000.000003.0000000000000000',
      'the tombstone cleared `_alive` and never touched `_born`, so the position was still there');
    assert.ok(bornValue(s, 'note:n1') < bornValue(s, 'note:n2')
      && bornValue(s, 'note:n2') < bornValue(s, 'note:n3'),
      'and the three `_born` values are in board.json\'s order');
  });

  test('R6-7b FAILED (held) · the same restore with the deleted entry LAST still works — the control', async () => {
    const yesterday = await bound(THREE());
    await session(delNote('n3'));                   // the LAST note, not the middle one
    const today = slots();
    const s = await bootWith({ board: yesterday.board, ops: today.ops, checkpoint: today.checkpoint });
    assert.equal(s.quarantine, null, 'exactly the same event, one array position over');
    assert.deepEqual(texts(s), ['EINS', 'ZWEI', 'DREI']);
    assert.equal(s._adopted?.reconciled, 1, 'one change re-minted, reported, history intact');
  });

  test('R6-7c FAILED (held) · a restore that only changes TEXT reconciles cleanly — the second control', async () => {
    const yesterday = await bound(THREE());
    await session(editNote('n2', 'ZWEI, GEÄNDERT'));
    const today = slots();
    const s = await bootWith({ board: yesterday.board, ops: today.ops, checkpoint: today.checkpoint });
    assert.equal(s.quarantine, null);
    assert.deepEqual(texts(s), ['EINS', 'ZWEI', 'DREI'], 'the restored text wins, as it should');
    assert.equal(s._adopted?.reconciled, 1);
  });

  test('R6-7d INVERTED · a LOST tail: the board is ahead by an entry that is not last, and it lands there', async () => {
    // No Time Machine needed. `ops.jsonl` is the only copy of everything above the checkpoint's
    // horizon, so any loss of that file leaves the board ahead — and the browser fallback's
    // `slice(-LS_OPS_CAP)` drops the OLDEST lines, which are exactly the entries that are NOT
    // last. Here the log has NEVER HEARD of `n2`: there is no `_born` to keep, so one has to be
    // computed, strictly between the two entries `board.json` puts around it.
    LS.clear();
    LS.setItem(LS_BOARD, J(v1board({ notes: [note('n1', '2026-03-01', 'EINS')] })));
    await session();
    await session(addNote('n2', 'ZWEI'));
    await session(addNote('n3', 'DREI'));
    const disk = slots();
    const kept = disk.ops.split('\n').filter(Boolean).slice(1).join('\n');
    const s = await bootWith({ board: disk.board, ops: kept, checkpoint: disk.checkpoint });
    assert.equal(s.quarantine, null, 'the lost head costs the head and nothing else');
    assert.deepEqual(texts(s), ['EINS', 'ZWEI', 'DREI'], 'content whole, history kept');
    const [b1, b2, b3] = ['note:n1', 'note:n2', 'note:n3'].map((k) => bornValue(s, k));
    assert.ok(b1 < b2 && b2 < b3, `the minted \`_born\` sits between its neighbours (${b1} < ${b2} < ${b3})`);
    assert.equal(b2.slice(21), '0000000000000000',
      'and it carries the all-zeros device short — this position was DERIVED, not observed on a device');
  });

  test('R6-7e RESOLVED · ADR 006 §7 and §9.3 W2 do not contradict once W2 stops naming the lineage', async () => {
    // THE CONTRADICTION, AS FILED. §7: "The lineage is re-minted ONLY on `foreign-lineage`."
    // §9.3 W2: "After a quarantine on a board that carried a lineage, the store mints a NEW
    // lineageId and treats the event as a re-join." A `reconcile-failed` (or a `clock-skew`, or an
    // `unreadable-log`) on a board that carries a lineage is inside both sentences.
    //
    // THE RESOLUTION IS §7's, AND W2 IS THE ONE THAT IS AMENDED, because W2 conflated two names:
    //
    //   · `lineageId` is the LOCAL binding between `board.json` and the two files beside it
    //     (§4.1, §4.2). Re-minting it on every quarantine would orphan a log that a later launch
    //     is meant to adopt — `clock-skew` is expressly "expected to stop being true without
    //     anyone touching either file" (§7.1), so a new name there would destroy the very pair the
    //     deferred quarantine exists to preserve. §7's rule is protecting something real.
    //   · What W2 is actually about is the SYNC event, and its substance is already normative and
    //     already implemented — §9.4: a board that carries a lineage whose log was quarantined is
    //     a RE-DERIVATION, and is re-stamped at `now` rather than at `GENESIS`. That is what stops
    //     the "silently re-joins with GENESIS stamps" outcome this row was filed about, and it has
    //     nothing to do with the lineage's name.
    //
    // OWED, one paragraph, to whoever owns `docs/v2/adr/006-board-log-authority.md` this round
    // (it is dirty in another agent's worktree, so this file is the record until then): §9.3's W2
    // should read "…the store treats the event as a re-join: it re-derives at `now` (§9.4) and
    // re-publishes its whole personal projection", with the `lineageId` sentence struck, and §7's
    // table left exactly as it is.
    //
    // Below: the two halves, measured. `restamp: !!binding` is `store.js:_buildSpine`.
    const mine = await bound(THREE());
    const lineage = JSON.parse(mine.board)._v2.lineageId;

    // (i) a quarantine that is NOT `foreign-lineage` keeps the lineage — and does NOT re-join at
    //     GENESIS, which is the half R6-7e was really about.
    const cp = JSON.parse(mine.checkpoint);
    delete cp.lzp;                                  // a checkpoint that carries no lineage at all
    const kept = await bootWith({ board: mine.board, ops: mine.ops, checkpoint: J(cp) });
    assert.equal(kept.quarantine?.reason, 'log-carries-no-lineage');
    assert.equal(kept._lineageId, lineage, '§7: the lineage is KEPT, so the pair is still a pair');
    // §9.4, precisely: what must not be at GENESIS is the thing that DECIDES CONTESTS, and that
    // is the register cell's stamp (= the op's `ts`), which `_buildSpine({restamp: true})` mints
    // fresh. The `_born` VALUE stays at `GENESIS(i)` on purpose — it is a POSITION, it encodes the
    // v1 array index (ADR 001 §8.1), and a re-derivation that reshuffled the user's array order
    // would be a v1 regression. Two different fields, two different jobs; W2's "loses every field
    // contest" is about the first of them.
    assert.notEqual(bornOf(kept, 'note:n1').slice(0, 13), '0000000000000',
      '§9.4: the re-derivation\'s register stamps are at NOW — W2\'s substance, delivered');
    assert.equal(bornValue(kept, 'note:n1').slice(0, 13), '0000000000000',
      'and the `_born` VALUE stays at GENESIS(i), because it is board.json\'s array order');
    assert.deepEqual(texts(kept), ['EINS', 'ZWEI', 'DREI'], 'content whole, as promise 4 requires');

    // (ii) `foreign-lineage` — the one reason that says the old name was never ours — re-mints it.
    const theirs = await bound(v1board({ notes: [note('x1', '2026-02-02', 'FREMD')] }));
    const again = await bound(THREE());
    const foreign = await bootWith({ board: again.board, ops: theirs.ops, checkpoint: theirs.checkpoint });
    assert.equal(foreign.quarantine?.reason, 'foreign-lineage');
    assert.notEqual(foreign._lineageId, JSON.parse(again.board)._v2.lineageId, '§7: re-minted here');
    assert.notEqual(bornOf(foreign, 'note:n1').slice(0, 13), '0000000000000', 'and re-derived at now');
  });

  test('R6-7f · THE NON-VACUITY CONTROL — the post-condition still SEES an order it cannot repair', async () => {
    // D5's cell (c) is what "just relax R4" produces, and this row is what stops the R6-7 fix
    // from sliding into it. Two `_born` values swapped inside an adopted checkpoint is R5-5a's
    // attack: both entries are alive in the log AND in `board.json`, so `diffCollection` treats
    // them as anchors and re-stamps neither — the disagreement survives to the post-condition,
    // which refuses. INV-19, unchanged.
    const mine = await bound(THREE());
    const cp = JSON.parse(mine.checkpoint);
    const regs = cp.regs.regs;
    const a = regs['note:n1']._born;
    const b = regs['note:n3']._born;
    const tmp = a.value; a.value = b.value; b.value = tmp;
    const s = await bootWith({ board: mine.board, ops: mine.ops, checkpoint: J(cp) });
    assert.equal(s.quarantine?.reason, 'reconcile-failed', 'the swap is still refused …');
    assert.match(s.quarantine.detail, /DIFFERENT ORDER/, '… and still named as an ORDER disagreement');
    assert.deepEqual(texts(s), ['EINS', 'ZWEI', 'DREI'], 'board.json\'s order is what is on screen');
  });

  test('R6-7g · INV-4 — an exact match still mints ZERO ops and re-stamps nothing', async () => {
    // The other way the fix could have gone wrong: writing a `_born` on a path where nothing had
    // to change. `_born` is compared byte for byte before and after.
    const mine = await bound(THREE());
    const first = await bootWith({ board: mine.board, ops: mine.ops, checkpoint: mine.checkpoint });
    const stamps = ['note:n1', 'note:n2', 'note:n3'].map((k) => bornValue(first, k));
    assert.equal(first.quarantine, null);
    assert.equal(first._adopted?.reconciled, 0, 'ZERO ops on an exact match');
    const second = await bootWith({ board: mine.board, ops: mine.ops, checkpoint: mine.checkpoint });
    assert.deepEqual(['note:n1', 'note:n2', 'note:n3'].map((k) => bornValue(second, k)), stamps,
      'and the `_born` stamps are byte-identical across the launch');
  });

  test('R6-7h · a RESTORE is not an UNDELETE — the direction the fix must not reverse', async () => {
    // "Never mint `_born` when the log has one" could have been read as "never honour a delete".
    // It is not: the restore branch is only reached when `board.json` CARRIES the entity. When the
    // board agrees the entry is gone, the log's live entry is tombstoned exactly as before, and
    // the entry stays gone across the next launch too.
    const mine = await bound(THREE());
    await session(delNote('n2'));
    const after = slots();
    const s = await bootWith({ board: after.board, ops: after.ops, checkpoint: after.checkpoint });
    assert.equal(s.quarantine, null);
    assert.deepEqual(texts(s), ['EINS', 'DREI'], 'the delete is still a delete');
    assert.equal(s._adopted?.reconciled, 0, 'and nothing had to be re-minted to keep it one');
    // And the mirror: a board that is ahead by a DELETE the log never saw still mints one.
    const yesterdayLog = mine;
    const t = await bootWith({ board: after.board, ops: yesterdayLog.ops, checkpoint: yesterdayLog.checkpoint });
    assert.equal(t.quarantine, null);
    assert.deepEqual(texts(t), ['EINS', 'DREI'], 'the log had three, the board has two, the board wins');
    assert.equal(t._adopted?.reconciled, 1, 'exactly one op: the tombstone');
  });
});

describe('R6-8 · the controls ADR 006 §1.1 lists, re-derived', () => {
  test('R6-8a FAILED (held) · R3-35c: a log this build wrote is adopted and NOTHING is re-minted', async () => {
    const mine = await bound(THREE());
    const s = await bootWith({ board: mine.board, ops: mine.ops, checkpoint: mine.checkpoint });
    assert.equal(s.quarantine, null);
    assert.equal(s._adopted?.reconciled, 0, 'INV-4: the plan is EMPTY on an exact match');
    assert.deepEqual(texts(s), ['EINS', 'ZWEI', 'DREI']);
  });

  test('R6-8b FAILED (held) · R4-2a: another board\'s legitimate checkpoint is `foreign-lineage`', async () => {
    const theirs = await bound(v1board({ notes: [note('x1', '2026-02-02', 'FREMD')] }));
    const mine = await bound(THREE());
    const s = await bootWith({ board: mine.board, ops: theirs.ops, checkpoint: theirs.checkpoint });
    assert.equal(s.quarantine?.reason, 'foreign-lineage');
    assert.deepEqual(texts(s), ['EINS', 'ZWEI', 'DREI']);
  });

  test('R6-8c FAILED (held) · R4-4a: a crash between the two writes keeps the note, no quarantine', async () => {
    LS.clear();
    LS.setItem(LS_BOARD, J(THREE()));
    await session();
    const cpBefore = slots();
    // the board moves, the log files do not — `flushSync`'s shape, and every crash's
    await bootV2();
    v2store._opsPersisted = false;                  // solo: board.json only
    v2store.mutate('add', (st) => st.notes.push({ id: 'n4', date: '2026-09-09', text: 'VIER', categoryId: st.categories[0].id, repeatsYearly: false }));
    await v2store.persistNow();
    const s = await bootWith({ board: LS.getItem(LS_BOARD), ops: cpBefore.ops, checkpoint: cpBefore.checkpoint });
    assert.equal(s.quarantine, null, 'being ahead is the EXPECTED state, not an exception');
    assert.deepEqual(texts(s), ['EINS', 'ZWEI', 'DREI', 'VIER']);
    assert.equal(s._adopted?.reconciled, 1);
    assert.ok(s.warnings.some((w) => /reconciled 1 change/.test(w)));
  });
});
