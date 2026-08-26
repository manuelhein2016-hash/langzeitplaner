// ─────────────────────────────────────────────────────────────────────────────
// UPGRADE DAY — THE WAYS BACK  (WP-3 adversary)
//
// Every loss the migration takes is supposed to be survivable, because the user has two ropes:
// the daily snapshot (11.5) and the exported file (11.2 / 11.3). Both ropes run through the SAME
// door — `store.replaceAll()`. This file pulls on both.
//
// `replaceAll()` after LZP-402:
//
//     migrate(next)                    ← can throw; state and log intact          SAFE
//     planReplaceAll(...)              ← can throw; state and log intact          SAFE
//     for (op of plan.ops) log.append  ← can throw mid-loop; log half-replaced
//     this.state = this._blankState()  ← the live board is discarded HERE
//     this._project({settings:true})   ← can throw; state is now BLANK            FATAL
//     this.persistNow()
//
// v1's `replaceAll` was `this.state = migrate(next); … this.persistNow()` and could not throw at
// all. The window between the blank and the projection is new, and what is in it is the user's
// entire board.
//
// Rows are PINNED TO CURRENT BEHAVIOUR (`docs/v2/STATUS.md` §5): a `DEFECT` row going RED means
// the defect was fixed — invert it. Scratch only; no real file is touched.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LS, LS_BOARD, LS_SNAP,
  bootV1, bootV2, v1store, v2store, v1board, note, bar, diffDeep,
} from './_upgrade-harness.js';

const J = (o) => JSON.stringify(o);

const REAL_BOARD = () => v1board({
  notes: [note('n1', '2026-04-02', 'Zahnarzt'), note('n2', '2026-05-11', 'Elternabend')],
  bars: [bar('b1', '2026-04-10', '2026-06-20', 'Sommerprojekt')],
  scratchpads: { '2026-04': 'Milch kaufen' },
});

/**
 * A board that `materialize` refuses. `pinnedMonthsRenderable` (entities.js §2b) says no, because
 * `layout.js:25` would turn this into a NaN year and `holidays.js:51` would loop forever on it —
 * so refusing is the RIGHT call (ATT-97). The defect is not the refusal; it is where it lands.
 */
const POISON = (patch) => v1board({ notes: [note('p1', '2026-04-02', 'Poison')], settings: { mode: 'pinned', ...patch } });

const POISONS = {
  'startMonth "nope"': POISON({ startMonth: 'nope' }),
  'startMonth "999999-01"': POISON({ startMonth: '999999-01' }),
  'pageYears 1e9': POISON({ pageYears: 1e9 }),
  'pageYears "x"': POISON({ pageYears: 'x' }),
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE DEFECT — an import that throws destroys the board it was importing over
// ─────────────────────────────────────────────────────────────────────────────

for (const [what, poison] of Object.entries(POISONS)) {
  test(`DEFECT · importing a board with ${what} blanks store.state, and the next autosave writes the blank to disk`, async () => {
    LS.clear();
    LS.setItem(LS_BOARD, J(REAL_BOARD()));
    await bootV2();
    assert.equal(v2store.state.notes.length, 2, 'the user has a board');

    let err = null;
    try { v2store.replaceAll(JSON.parse(J(poison))); } catch (e) { err = e; }
    assert.equal(err?.constructor.name, 'MaterializeError', 'the projection refused it');

    // The screen still shows the old board: `emit('replace')` is never reached, so no listener
    // redraws. Nothing tells the user anything happened.
    assert.deepEqual(v2store.state, {
      schemaVersion: 1, notes: [], bars: [], categories: [], scratchpads: {}, settings: null,
    }, 'but store.state is now a blank the app can never have produced — categories [], settings null');

    // 700 ms of debounce, or the window closing. Either is enough.
    v2store.flushSync();
    const disk = JSON.parse(LS.getItem(LS_BOARD));
    assert.equal(disk.notes.length, 0);
    assert.equal(disk.categories.length, 0);
    assert.equal(disk.settings, null, 'board.json is now the blank; the user\'s board is gone');
  });
}

test('DEFECT · the ordinary 700 ms autosave is enough — no window close required', async () => {
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  await bootV2();
  try { v2store.replaceAll(JSON.parse(J(POISONS['startMonth "nope"']))); } catch { /* expected */ }
  v2store.schedulePersist();                      // ← what any later keystroke does
  await new Promise((r) => setTimeout(r, 900));
  const disk = JSON.parse(LS.getItem(LS_BOARD));
  assert.equal(disk.notes.length, 0);
  assert.equal(disk.settings, null);
});

test('DEFECT · the frozen v1 store takes the same input without a murmur', async () => {
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  await bootV1();
  v1store.replaceAll(JSON.parse(J(POISONS['startMonth "nope"'])));
  assert.equal(v1store.state.categories.length, 2, 'v1 replaced the board and kept a coherent state object');
  assert.notEqual(v1store.state.settings, null);
  // (v1 then HANGS at render — `holidays.js:51` loops forever. Refusing the board is right.
  //  Refusing it after discarding the previous one is the defect.)
});

test('DEFECT · restoring a poisoned SNAPSHOT (11.5) takes the same door and the same board', async () => {
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  LS.setItem(LS_SNAP, J([{ day: '2026-08-01', at: '2026-08-01T09:00:00.000Z', state: JSON.parse(J(POISONS['startMonth "nope"'])) }]));
  await bootV2();
  assert.equal(v2store.state.notes.length, 2);
  let err = null;
  try { v2store.restoreSnapshot('2026-08-01'); } catch (e) { err = e; }
  assert.equal(err?.constructor.name, 'MaterializeError');
  v2store.flushSync();
  assert.equal(JSON.parse(LS.getItem(LS_BOARD)).settings, null,
    '11.5 — the safety net — is itself a way to lose the board');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE ROPE THAT DOES NOT REACH — a pre-migration snapshot restores post-migration
//
// The upgrade is survivable only if the pre-upgrade board can be got back. It is still on disk:
// v1 rolled today's snapshot before the upgrade and v2 does not overwrite it (`_lastSnapshotDay`
// is seeded from `snapshots[0].day`). But `restoreSnapshot` goes through `replaceAll`, which goes
// through the same migration — so restoring it re-applies every loss.
// ─────────────────────────────────────────────────────────────────────────────

test('DEFECT · the pre-migration snapshot survives on disk and restoring it gives back the LOSSY board', async () => {
  const lossy = v1board({
    notes: [
      { id: 7, date: '2026-04-02', text: 'Zahnarzt', categoryId: 'cat-arbeit', repeatsYearly: false },
      note('n2', '2026-06-10', 'Geburtstag', { repeatsYearly: 'yes' }),
    ],
    bars: [{ startDate: '2026-04-10', endDate: '2026-05-01', label: 'Urlaub', categoryId: 'cat-arbeit' }],
    scratchpads: { '2026-04': 12345 },
  });

  // Yesterday: v1 is still the app, and it rolls today's snapshot.
  LS.clear();
  LS.setItem(LS_BOARD, J(lossy));
  await bootV1();
  await v1store.persistNow();
  const day = JSON.parse(LS.getItem(LS_SNAP))[0].day;
  const inSnapshot = JSON.parse(LS.getItem(LS_SNAP))[0].state;
  assert.equal(inSnapshot.notes.length, 2, 'the snapshot holds both notes');
  assert.equal(inSnapshot.bars.length, 1, 'and the bar');

  // Today: the upgrade.
  await bootV2();
  assert.equal(v2store.state.notes.length, 1, 'the migration kept one note');
  assert.equal(v2store.state.bars.length, 0, 'and no bar');
  assert.deepEqual(v2store.listSnapshots().map((s) => s.day), [day], 'the rope is right there');

  // Pull on it.
  assert.equal(v2store.restoreSnapshot(day), true);
  assert.equal(v2store.state.notes.length, 1, 'and it gives back exactly what the migration left');
  assert.equal(v2store.state.bars.length, 0);
  assert.equal(Object.keys(v2store.state.scratchpads).length, 0);

  // And the data really is still sitting in snapshots.json, unreachable through the app.
  await v2store.persistNow();
  assert.equal(JSON.parse(LS.getItem(LS_SNAP))[0].state.notes.length, 2,
    'the user can read her notes in the file and cannot get them onto the board');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WHAT HELD — the ropes, on boards that do not poison the projection
// ─────────────────────────────────────────────────────────────────────────────

test('HELD · export → wipe → import returns the identical board', async () => {
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  await bootV2();
  const exported = v2store.exportJSON();
  const wanted = structuredClone(v2store.state);

  LS.clear();
  await bootV2();                                  // a brand-new, empty install
  assert.equal(v2store.state.notes.length, 0);
  v2store.replaceAll(JSON.parse(exported));
  assert.deepEqual(diffDeep(wanted, v2store.state), []);
});

test('HELD · the exported file is re-exportable and re-importable, byte-stable both times', async () => {
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  await bootV2();
  const a = v2store.exportJSON();
  v2store.replaceAll(JSON.parse(a));
  const b = v2store.exportJSON();
  v2store.replaceAll(JSON.parse(b));
  const c = v2store.exportJSON();
  assert.equal(a, b, 'export → import → export is a fixed point');
  assert.equal(b, c, 'and stays one');
});

test('HELD · the exported file carries schemaVersion 1 and no v2 leakage, and the FROZEN v1 store opens it', async () => {
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  await bootV2();
  const exported = v2store.exportJSON();
  const parsed = JSON.parse(exported);
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(Object.keys(parsed).sort(), ['bars', 'categories', 'notes', 'scratchpads', 'schemaVersion', 'settings'].sort());
  for (const n of parsed.notes) {
    assert.deepEqual(Object.keys(n).sort(), ['categoryId', 'date', 'id', 'repeatsYearly', 'text']);
  }
  const v2state = structuredClone(v2store.state);
  LS.clear(); LS.setItem(LS_BOARD, exported);
  await bootV1();
  assert.deepEqual(diffDeep(v2state, v1store.state), []);
});

test('HELD · restoring a clean pre-migration snapshot is a no-op, not a rewrite', async () => {
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  LS.setItem(LS_SNAP, J([{ day: '2026-08-01', at: '2026-08-01T09:00:00.000Z', state: REAL_BOARD() }]));
  await bootV2();
  const before = structuredClone(v2store.state);
  assert.equal(v2store.restoreSnapshot('2026-08-01'), true);
  assert.deepEqual(diffDeep(before, v2store.state), []);
});

test('HELD · a throw inside planReplaceAll lands BEFORE the blank, so the board survives', async () => {
  // 1000 entries sharing one id exhausts `rekeyed`'s 998 derivations and raises MigrationError —
  // from inside `planReplaceAll`, which is above the line where `state` is discarded.
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  await bootV2();
  const flood = v1board({ notes: Array.from({ length: 1200 }, (_, i) => note('dup', `2026-04-0${(i % 9) + 1}`, `n${i}`)) });
  let err = null;
  try { v2store.replaceAll(JSON.parse(J(flood))); } catch (e) { err = e; }
  assert.equal(err?.constructor.name, 'MigrationError');
  assert.equal(v2store.state.notes.length, 2, 'the live board is untouched');
  v2store.flushSync();
  assert.equal(JSON.parse(LS.getItem(LS_BOARD)).notes.length, 2, 'and so is the file');
});

test('HELD · init() refusing a poisoned board.json does not damage it — ready stays false', async () => {
  LS.clear();
  const bytes = J(POISONS['startMonth "nope"']);
  LS.setItem(LS_BOARD, bytes);
  let err = null;
  try { await bootV2(); } catch (e) { err = e; }
  assert.equal(err?.constructor.name, 'MaterializeError', 'the app does not boot (no message, no board — a separate defect)');
  assert.equal(v2store.ready, false);
  v2store.flushSync();
  assert.equal(LS.getItem(LS_BOARD), bytes, 'flushSync no-ops on a store that never became ready, so the file is intact');
});
