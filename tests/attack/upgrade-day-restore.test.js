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
// 1. INVERTED 2026-08-27 · I-1 IS CLOSED — the candidate, and the swap on success
//
// `replaceAll()` now REHEARSES the whole replacement on a throwaway log before anything is
// committed: nothing is appended to the live log, nothing is retracted, `state` is not touched
// and no file is written until a projection has been shown to succeed. A board whose `settings`
// the projection refuses is imported with those three settings reset to the default and a warning
// that says so — every note, bar, category and scratchpad in the file arrives unchanged — and a
// board that cannot be drawn at all is REFUSED, with the board the user had still on screen and
// still on disk.
// ─────────────────────────────────────────────────────────────────────────────

for (const [what, poison] of Object.entries(POISONS)) {
  test(`INVERTED (I-1) · importing a board with ${what} keeps its entries and repairs the settings`, async () => {
    LS.clear();
    LS.setItem(LS_BOARD, J(REAL_BOARD()));
    await bootV2();
    assert.equal(v2store.state.notes.length, 2, 'the user has a board');

    let err = null;
    let r = null;
    try { r = v2store.replaceAll(JSON.parse(J(poison))); } catch (e) { err = e; }
    assert.equal(err, null, 'the door does not throw');
    assert.equal(r, true, 'and the import happened');

    assert.deepEqual(v2store.state.notes.map((n) => n.id), ['p1'], "the imported file's entry is on the board");
    assert.ok(Array.isArray(v2store.state.categories) && v2store.state.categories.length > 0,
      'and `state` is a board the app could have produced — never the blank it used to become');
    assert.notEqual(v2store.state.settings, null);
    assert.ok(v2store.warnings.some((w) => /could not be drawn as given and was reset to the default/.test(w)),
      `the repair is reported: ${JSON.stringify(v2store.warnings)}`);

    v2store.flushSync();
    const disk = JSON.parse(LS.getItem(LS_BOARD));
    assert.equal(disk.notes.length, 1);
    assert.ok(disk.categories.length > 0, 'board.json is a board, not a blank');
    assert.notEqual(disk.settings, null);
  });
}

test('INVERTED (I-1) · the ordinary 700 ms autosave can no longer commit a blank', async () => {
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  await bootV2();
  v2store.replaceAll(JSON.parse(J(POISONS['startMonth "nope"'])));
  v2store.schedulePersist();                      // ← what any later keystroke does
  await new Promise((r) => setTimeout(r, 900));
  const disk = JSON.parse(LS.getItem(LS_BOARD));
  assert.equal(disk.notes.length, 1);
  assert.notEqual(disk.settings, null);
});

test('INVERTED (I-1) · a board that cannot be drawn AT ALL is refused, and changes nothing', async () => {
  // The rehearsal's last resort. `_project` is stubbed to refuse every candidate, which is the
  // mutation-proof for the swap itself: without "project into a candidate, swap only on success"
  // this row leaves `state` blank and the autosave commits it.
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  await bootV2();
  const before = structuredClone(v2store.state);
  const realProjectionOf = v2store._projectionOf.bind(v2store);
  v2store._projectionOf = () => { const e = new Error('refused'); e.name = 'MaterializeError'; throw e; };
  const r = v2store.replaceAll(JSON.parse(J(REAL_BOARD())));
  v2store._projectionOf = realProjectionOf;

  assert.equal(r, false, 'the import is refused');
  assert.deepEqual(diffDeep(before, v2store.state), [], 'and the board the user had is untouched');
  assert.ok(v2store.warnings.some((w) => /import refused/.test(w)));
  v2store.flushSync();
  assert.equal(JSON.parse(LS.getItem(LS_BOARD)).notes.length, 2, 'so is the file');
});

test('DEFECT · the frozen v1 store takes the same input without a murmur', async () => {
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  await bootV1();
  v1store.replaceAll(JSON.parse(J(POISONS['startMonth "nope"'])));
  assert.equal(v1store.state.categories.length, 2, 'v1 replaced the board and kept a coherent state object');
  assert.notEqual(v1store.state.settings, null);
  // (v1 then HANGS at render — `holidays.js:51` loops forever. Refusing the board is right.
  //  Refusing it after discarding the previous one was the defect.)
});

test('INVERTED (I-1) · restoring a poisoned SNAPSHOT (11.5) is now a restore, not a way to lose the board', async () => {
  LS.clear();
  LS.setItem(LS_BOARD, J(REAL_BOARD()));
  LS.setItem(LS_SNAP, J([{ day: '2026-08-01', at: '2026-08-01T09:00:00.000Z', state: JSON.parse(J(POISONS['startMonth "nope"'])) }]));
  await bootV2();
  assert.equal(v2store.state.notes.length, 2);
  let err = null;
  let r = null;
  try { r = v2store.restoreSnapshot('2026-08-01'); } catch (e) { err = e; }
  assert.equal(err, null);
  assert.equal(r, true, 'the restore reports what actually happened');
  assert.deepEqual(v2store.state.notes.map((n) => n.id), ['p1'], 'the snapshot is on the board');
  v2store.flushSync();
  assert.notEqual(JSON.parse(LS.getItem(LS_BOARD)).settings, null,
    '11.5 — the safety net — is a safety net again');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE ROPE — INVERTED, A3-H2 CLOSED
//
// The upgrade is survivable only if the pre-upgrade board can be got back. It is still on disk:
// v1 rolled today's snapshot before the upgrade and v2 does not overwrite it (`_lastSnapshotDay`
// is seeded from `snapshots[0].day`). `restoreSnapshot` goes through `replaceAll`, which goes
// through the same conversion — which is why the ROW BELOW USED TO SAY the rope gives back the
// already-emptied board: the two doors lost the same entries, so pulling on the rope changed
// nothing. It is also why fixing only one door would have been worthless.
//
// Both doors coerce now, so there is nothing to get back — and the restore proves it by landing
// on exactly the board the migration built, entry for entry, from bytes that never went through
// the migration door at all.
// ─────────────────────────────────────────────────────────────────────────────

test('INVERTED · the pre-migration snapshot restores to the same board the migration built — nothing was lost either way', async () => {
  const awkward = v1board({
    notes: [
      { id: 7, date: '2026-04-02', text: 'Zahnarzt', categoryId: 'cat-arbeit', repeatsYearly: false },
      note('n2', '2026-06-10', 'Geburtstag', { repeatsYearly: 'yes' }),
    ],
    bars: [{ startDate: '2026-04-10', endDate: '2026-05-01', label: 'Urlaub', categoryId: 'cat-arbeit' }],
    scratchpads: { '2026-04': 12345 },
  });

  // Yesterday: v1 is still the app, and it rolls today's snapshot.
  LS.clear();
  LS.setItem(LS_BOARD, J(awkward));
  await bootV1();
  await v1store.persistNow();
  const day = JSON.parse(LS.getItem(LS_SNAP))[0].day;
  const inSnapshot = JSON.parse(LS.getItem(LS_SNAP))[0].state;
  assert.equal(inSnapshot.notes.length, 2, 'the snapshot holds both notes');
  assert.equal(inSnapshot.bars.length, 1, 'and the bar');

  // Today: the upgrade. Every entry v1 had is still an entry.
  await bootV2();
  assert.equal(v2store.state.notes.length, 2, 'the migration kept BOTH notes');
  assert.equal(v2store.state.bars.length, 1, 'and the id-less bar');
  assert.equal(v2store.state.scratchpads['2026-04'], '12345', 'and the numeric scratchpad');
  assert.equal(v2store.state.notes.find((n) => n.text === 'Geburtstag').repeatsYearly, true);
  const migrated = structuredClone(v2store.state);
  assert.deepEqual(v2store.listSnapshots().map((s) => s.day), [day], 'the rope is right there');

  // Pull on it. The IMPORT door converts the same v1 bytes; P13 says the two doors agree, and
  // this is that property at the seam, on a real store, through the real restore path.
  assert.equal(v2store.restoreSnapshot(day), true);
  assert.equal(v2store.state.notes.length, 2);
  assert.equal(v2store.state.bars.length, 1);
  assert.equal(Object.keys(v2store.state.scratchpads).length, 1);
  for (const key of ['notes', 'bars', 'categories', 'scratchpads']) {
    const strip = (x) => JSON.stringify(x, ['id', 'date', 'text', 'categoryId', 'repeatsYearly',
      'startDate', 'endDate', 'label', 'name', 'nameEn', 'paletteRef', 'visible']);
    assert.equal(strip(v2store.state[key]), strip(migrated[key]),
      `${key}: the restore landed on the board the migration built`);
  }
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

test('INVERTED (I-2 / Finding 2) · a poisoned board.json BOOTS, with its entries and a repaired view', async () => {
  // The white screen A3-H1 closed, reached through `board.json` instead of `checkpoint.json`.
  // `materialize` is right to refuse a `settings` that would hang `holidays.js:51`; what was wrong
  // was where the refusal landed — outside every door, `ready === false`, with an intact
  // `board.json` sitting right there. `_projectSafe()` repairs the three settings the projection
  // can actually refuse, says so, and boots. No entry is ever discarded to make a board drawable.
  LS.clear();
  const bytes = J(POISONS['startMonth "nope"']);
  LS.setItem(LS_BOARD, bytes);
  let err = null;
  try { await bootV2(); } catch (e) { err = e; }

  assert.equal(err, null, 'init() does not throw');
  assert.equal(v2store.ready, true, 'the app boots');
  assert.deepEqual(v2store.state.notes.map((n) => n.id), ['p1'], "with the user's entry on it");
  assert.ok(v2store.warnings.some((w) => /could not be drawn with the settings it was loaded with/.test(w)),
    `and it says what it refused: ${JSON.stringify(v2store.warnings)}`);
  assert.equal(v2store.bootFailure, null, 'a repaired boot is not a failed one');
});

test('HELD · a board NOTHING can draw opens read-only — the file is never replaced by what is on screen', async () => {
  // Step 4 of the policy. `_project` is made to refuse every candidate, including the repaired
  // ones; the app must still open, must say so, and must not write. Removing the read-only guard
  // in `persistNow`/`flushSync` reddens this row by committing an empty board over the user's.
  LS.clear();
  const bytes = J(REAL_BOARD());
  LS.setItem(LS_BOARD, bytes);
  const proto = Object.getPrototypeOf(v2store);
  const real = proto._project;
  proto._project = function refuse() { const e = new Error('refused'); e.name = 'MaterializeError'; throw e; };
  let err = null;
  try { await bootV2(); } catch (e) { err = e; }
  proto._project = real;

  assert.equal(err, null, 'init() still does not throw');
  assert.equal(v2store.ready, true, 'the app opened');
  assert.equal(v2store.bootFailure?.reason, 'unprojectable');
  assert.ok(v2store.warnings.some((w) => /will NOT write to/.test(w)));

  await v2store.persistNow();
  v2store.flushSync();
  assert.equal(LS.getItem(LS_BOARD), bytes, 'board.json is byte-identical: the session is read-only');
});
