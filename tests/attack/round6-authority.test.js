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

const THREE = () => v1board({
  notes: [note('n1', '2026-03-01', 'EINS'), note('n2', '2026-03-02', 'ZWEI'), note('n3', '2026-03-03', 'DREI')],
});

describe('R6-7 · the order post-condition on the paths ADR 006 blesses', () => {
  test('R6-7a SUCCEEDED (defect) · a Time-Machine restore over this board\'s OWN log ⇒ reconcile-failed, all history gone', async () => {
    const yesterday = await bound(THREE());         // session 1 — the copy Time Machine keeps
    await session(delNote('n2'));                   // session 2 — the user deletes the MIDDLE note
    const today = slots();
    assert.deepEqual(JSON.parse(today.board).notes.map((n) => n.text), ['EINS', 'DREI']);

    // Session 3: the user restores yesterday's board.json. Same lineage, same machine, same app.
    const s = await bootWith({ board: yesterday.board, ops: today.ops, checkpoint: today.checkpoint });

    assert.equal(s.quarantine?.reason, 'reconcile-failed',
      'the restore the ADR says is honoured quarantines the whole log');
    assert.match(s.quarantine.detail, /DIFFERENT ORDER/,
      'and the reason is the ORDER, on an entry the reconciler is structurally unable to mint');
    assert.deepEqual(texts(s), ['EINS', 'ZWEI', 'DREI'], 'content is kept whole — ADR 006 R4 does its job');
    assert.equal(s._adopted, null, 'but every stamp, tombstone, parked op and cursor is discarded');
  });

  test('R6-7b FAILED (held) · the same restore where the deleted entry was LAST reconciles cleanly — the non-vacuity control', async () => {
    const yesterday = await bound(THREE());
    await session(delNote('n3'));                   // the LAST note, not the middle one
    const today = slots();
    const s = await bootWith({ board: yesterday.board, ops: today.ops, checkpoint: today.checkpoint });
    assert.equal(s.quarantine, null, 'exactly the same event, one array position over, and it works');
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

  test('R6-7d SUCCEEDED (defect) · the same shape from a LOST tail: the board is ahead by an entry that is not last', async () => {
    // No Time Machine needed. `ops.jsonl` is the only copy of everything above the checkpoint's
    // horizon (the horizon does not move until a compaction), so any loss of that file leaves the
    // board ahead — and the browser fallback's `slice(-LS_OPS_CAP)` drops the OLDEST lines, which
    // are exactly the entries that are NOT last in the array.
    LS.clear();
    LS.setItem(LS_BOARD, J(v1board({ notes: [note('n1', '2026-03-01', 'EINS')] })));
    await session();
    await session(addNote('n2', 'ZWEI'));
    await session(addNote('n3', 'DREI'));
    const disk = slots();
    // the tail loses its FIRST line and keeps the rest — the browser cap, exactly
    const kept = disk.ops.split('\n').filter(Boolean).slice(1).join('\n');
    const s = await bootWith({ board: disk.board, ops: kept, checkpoint: disk.checkpoint });
    assert.equal(s.quarantine?.reason, 'reconcile-failed');
    assert.match(s.quarantine.detail, /DIFFERENT ORDER/);
    assert.deepEqual(texts(s), ['EINS', 'ZWEI', 'DREI'], 'content whole, history gone');
  });

  test('R6-7e SUCCEEDED (defect) · §7 keeps the lineage on `reconcile-failed`; §9.3 W2 says re-mint it. They cannot both be right', async () => {
    // ADR 006 §7: "The lineage is re-minted ONLY on `foreign-lineage`."
    // ADR 006 §9.3 W2: "After a quarantine on a board that carried a lineage, the store mints a
    // NEW lineageId and treats the event as a re-join." A `reconcile-failed` on a board that
    // carries a lineage is inside both sentences. The code implements §7.
    const yesterday = await bound(THREE());
    const before = JSON.parse(yesterday.board)._v2.lineageId;
    await session(delNote('n2'));
    const today = slots();
    const s = await bootWith({ board: yesterday.board, ops: today.ops, checkpoint: today.checkpoint });
    assert.equal(s.quarantine?.reason, 'reconcile-failed');
    assert.equal(s._lineageId, before,
      'the lineage is KEPT (§7) — so under WP-8 this device silently re-joins with GENESIS stamps '
      + 'under the OLD name, which is the exact divergence W2 exists to prevent');
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
