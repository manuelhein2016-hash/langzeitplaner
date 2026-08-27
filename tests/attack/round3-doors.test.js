// ─────────────────────────────────────────────────────────────────────────────
// ROUND 3 — ADVERSARY, ATTACK 2 + 5: THE DOORS
//
// Two jobs the brief set out:
//
//  · F-2, confirmed and WIDENED. The open finding says "an over-length value through `apply()`
//    throws an uncaught `OpError`". That is one instance of a much larger class. This file
//    enumerates EVERY entry in the `MUTATIONS` table against the type table in `FIELDS`, and the
//    same hostile inputs on `applyRemote()` — the door F-2 itself says the defect becomes live
//    on. Two facts the original report does not carry: the throw is not always an `OpError` (it
//    can be an `EntityKeyError`, which an `instanceof OpError` guard would miss), and one bad
//    entry in an `applyRemote()` batch discards the WHOLE batch with a bare `TypeError`.
//
//  · Attack 5 — "anything the retrofit newly refuses". WP-1 round 1 bricked four openable boards
//    by over-guarding. The migration door does not brick anything now, but it DROPS entries that
//    v1 keeps in its file, and `board.json` is then rewritten without them. In solo mode
//    `board.json` IS the checkpoint, so the loss is permanent after one autosave.
//
// Rows tagged `SUCCEEDED (defect)` are green BECAUSE the defect is there. If one goes red the
// gap was closed — invert it, do not repair it.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { localStorage as LS, resetStorage, seedBoard } from '../helpers/env.js';
import { store } from '../../src/js/store.js';
import { store as v1store } from '../fixtures/v1-store-frozen.js';
import { MUTATIONS, noteSet } from '../../src/js/core/ops.js';
import { fmt } from '../../src/js/core/stamp.js';

const BOARD_KEY = 'langzeitplaner.board';

const CATS = () => [
  { id: 'c1', name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true },
  { id: 'c2', name: 'Familie', nameEn: 'Family', paletteRef: 'gruen', visible: true },
];
const board = (p = {}) => ({
  schemaVersion: 1, notes: [], bars: [], categories: CATS(), scratchpads: {},
  settings: {
    bundesland: '', layers: { feiertage: true, schulferien: false, otherStates: false, ferienPattern: false },
    mode: 'rolling', startMonth: '2026-01', pageYears: 0, language: 'de',
    launchAtLogin: false, menuBarIcon: true, rowHeight: 22, colWidth: 118,
    paper: 'a4', lastCategoryId: 'c1', seenFirstRun: true,
  },
  ...p,
});
const SEEDED = () => board({
  notes: [{ id: 'n1', date: '2026-03-04', text: 'a', categoryId: 'c1', repeatsYearly: false }],
  bars: [{ id: 'b1', startDate: '2026-03-01', endDate: '2026-03-05', label: 'B', categoryId: 'c1' }],
  scratchpads: { '2026-03': 'Notizen' },
});

async function boot(s, b = SEEDED()) {
  clearTimeout(s._saveTimer);
  s.listeners.clear();
  resetStorage();
  seedBoard(b);
  s.undoStack.length = 0;
  s.redoStack.length = 0;
  s.snapshots.length = 0;
  s._lastSnapshotDay = null;
  s.ready = false;
  await s.init();
  clearTimeout(s._saveTimer);
}
const quiet = () => { clearTimeout(store._saveTimer); clearTimeout(v1store._saveTimer); };

afterEach(quiet);
after(quiet);

const LONG80 = 'x'.repeat(81);
const LONG40 = 'y'.repeat(41);

/**
 * THE F-2 CORPUS. Every row is `[mutation, args, why, expect]`, and `expect` is one of
 *   'throw'   — the door throws instead of declining (the F-2 class)
 *   'accept'  — the door builds and commits an op
 *   'decline' — the door returns false (the ATT-88 existence gate)
 *
 * Every input here is a value that could arrive from a hand-edited `board.json`, an imported
 * file, or — the case F-2 names — a peer over WP-8's wire. None of them is a programming error
 * a `maxLength` attribute can prevent.
 */
const F2 = [
  ['deleteSelected', { type: 'notiz', id: 'n1' }, 'a selection type that is neither note nor bar', 'throw'],
  ['deleteSelected', { type: 'note', id: 'n1' }, 'the honest case', 'accept'],
  ['deleteSelected', { type: 'note', id: 'ghost' }, 'a stale selection (ATT-88)', 'decline'],
  ['createBar', { id: 'nb', startDate: '01.03.2026', endDate: '2026-03-05', categoryId: 'c1' }, 'a German date', 'throw'],
  ['createBar', { id: 'nb', startDate: '2026-03-01', endDate: '2026-03-05', categoryId: '' }, 'an empty categoryId', 'throw'],
  ['createBar', { id: 'nb', startDate: '2026-03-01', endDate: '2026-03-05', categoryId: 'c1', visibility: 'oeffentlich' }, 'a visibility outside the enum', 'throw'],
  ['createBar', { id: '', startDate: '2026-03-01', endDate: '2026-03-05', categoryId: 'c1' }, 'an empty entity id', 'throw'],
  ['moveNote', { id: 'n1', date: 20260304 }, 'a numeric date', 'throw'],
  ['moveBar', { id: 'b1', startDate: '2026-3-1', endDate: '2026-03-05' }, 'an unpadded date', 'throw'],
  ['resizeBar', { id: 'b1' }, 'neither edge given', 'throw'],
  ['resizeBar', { id: 'b1', endDate: '2026-03-09' }, 'the honest case', 'accept'],
  ['createNoteInline', { id: 'nn', date: '2026-03-04', text: LONG80, categoryId: 'c1' }, 'text over 80 (F-2 as filed)', 'throw'],
  ['createNoteInline', { id: 'nn', date: '2026-03-04', text: null, categoryId: 'c1' }, 'a null text — ACCEPTED, and the note is then unrenderable', 'accept'],
  ['editNoteInline', { id: 'n1', text: LONG80 }, 'text over 80', 'throw'],
  ['editNoteInline', { id: 'n1', text: 42 }, 'a non-string text', 'throw'],
  ['editBarLabel', { id: 'b1', label: LONG40 }, 'label over 40', 'throw'],
  ['editBarLabel', { id: 'b1', label: null }, 'a null label — ACCEPTED', 'accept'],
  ['padTyping', { month: '2026-13', text: 'x' }, 'a month that does not exist', 'throw'],
  ['padTyping', { month: '2026-03', text: 7 }, 'a non-string pad', 'throw'],
  ['padBlur', { month: 'Juni', text: 'x' }, 'a non-month scratchpad key', 'throw'],
  ['createNotePopover', { id: 'np', date: '2026-02-30', text: 'x', categoryId: 'c1' }, '30 February — format-valid, deliberately allowed', 'accept'],
  ['recategoriseNote', { id: 'n1', categoryId: null }, 'a null categoryId — ACCEPTED, then silently repaired to the first category', 'accept'],
  ['recategoriseNote', { id: 'n1', categoryId: 5 }, 'a numeric categoryId', 'throw'],
  ['toggleRepeat', { id: 'n1', repeatsYearly: true }, 'switching ON with no anchor date', 'throw'],
  ['toggleRepeat', { id: 'n1', repeatsYearly: 'yes' }, 'a non-boolean repeat flag', 'throw'],
  ['deleteNotePopover', { id: 'ghost' }, 'a note that is gone (ATT-88)', 'decline'],
  ['recategoriseBar', { id: 'b1', categoryId: 5 }, 'a numeric categoryId', 'throw'],
  ['editNotePopover', { id: 'n1', text: LONG80 }, 'text over 80', 'throw'],
  ['toggleCategory', { id: 'c1', visible: 'true' }, 'a stringy boolean', 'throw'],
  ['addCategory', { id: 'nc', name: 7, nameEn: 'x', paletteRef: 'blau' }, 'a numeric category name', 'throw'],
  ['addCategory', { id: 'nc', name: 'x', nameEn: 'x', paletteRef: 'blau', defaultVisibility: 'nope' }, 'a defaultVisibility outside the enum', 'throw'],
  ['renameCategory', { id: 'c1', lang: 'fr', name: 'x' }, 'a language that is not de|en', 'throw'],
  ['recolorCategory', { id: 'c1', paletteRef: 3 }, 'a numeric paletteRef', 'throw'],
  ['deleteCategory', { id: 'c1', lastCategoryId: 9 }, 'a numeric lastCategoryId — ACCEPTED into a pref register', 'accept'],
  ['deleteCategoryReassign', { id: 'c1', targetId: 'c1', noteIds: [], barIds: [] }, 'reassigning a category to itself', 'throw'],
  ['deleteCategoryReassign', { id: 'c1', targetId: 'c2', noteIds: [null], barIds: [] }, 'a null id in the fan-out', 'throw'],
];

// ─────────────────────────────────────────────────────────────────────────────
describe('F-2 — the full scope of "apply() throws instead of declining"', () => {
  beforeEach(async () => { await boot(store); });

  /** Every row against a FRESH board, so no row can be excused by what a previous row did. */
  async function runCorpus() {
    const out = [];
    for (const [name, args, why, expect] of F2) {
      await boot(store);
      let got;
      let err = null;
      try { got = store.apply(name, { ...args }); quiet(); } catch (e) { err = e; quiet(); }
      const actual = err ? 'throw' : (got === false ? 'decline' : 'accept');
      out.push({ name, why, expect, actual, err: err && err.name });
    }
    return out;
  }

  test('R3-20 SUCCEEDED (defect, F-2 widened): 27 of 36 hostile inputs THROW out of apply(); F-2 as filed names four of them', async () => {
    const rows = await runCorpus();
    const wrong = rows.filter((r) => r.actual !== r.expect)
      .map((r) => `${r.name} (${r.why}): expected ${r.expect}, got ${r.actual}${r.err ? ` ${r.err}` : ''}`);
    assert.deepEqual(wrong, [], 'the corpus itself must be accurate');

    const thrown = rows.filter((r) => r.actual === 'throw');
    assert.equal(rows.length, 36);
    assert.equal(thrown.length, 27,
      'DEFECT: twenty-seven inputs a file or a peer can supply reach a THROW rather than a decline');
    assert.equal(thrown.filter((r) => /over 80|over 40/.test(r.why)).length, 4,
      'F-2 as filed — the over-length case — is four of those twenty-seven');

    // The other twenty-three are not exotic: a German date, an unpadded date, a numeric id, a
    // stringy boolean, a month that does not exist, a category reassigned to itself.
    assert.ok(thrown.some((r) => /German date/.test(r.why)));
    assert.ok(thrown.some((r) => /month that does not exist/.test(r.why)));
    assert.ok(thrown.some((r) => /stringy boolean/.test(r.why)));
  });

  test('R3-21 SUCCEEDED (defect, NEW): the throw is not always an OpError — an `instanceof OpError` guard would miss EntityKeyError', async () => {
    const rows = await runCorpus();
    const names = [...new Set(rows.filter((r) => r.actual === 'throw').map((r) => r.err))].sort();
    assert.deepEqual(names, ['EntityKeyError', 'OpError'],
      'DEFECT: the caller that finally wraps this door has TWO error classes to catch, from two modules');
  });

  test('R3-22 FAILED (held): every one of the 22 named mutations is covered by the corpus above', () => {
    const covered = new Set(F2.map(([n]) => n));
    const missing = Object.keys(MUTATIONS).filter((n) => !covered.has(n));
    assert.deepEqual(missing, [], 'a mutation added later without a row here would slip past this attack');
    assert.equal(Object.keys(MUTATIONS).length, 22);
  });

  test('R3-23 SUCCEEDED (defect, NEW): the SAME class is on applyRemote() — one bad entry in a batch throws a bare TypeError and discards the good ops with it', () => {
    const good = noteSet(
      { act: store._me, dev: store._device, gid: 'B'.repeat(22), space: 'personal', familySpaceId: null,
        mint: () => fmt(Date.now(), 0, '0'.repeat(16)), newOpId: () => 'A'.repeat(22) },
      'zz', { date: '2026-03-04', text: 'überlebt', categoryId: 'c1', repeatsYearly: false, visibility: 'privat', coEdit: false, _alive: true },
      { born: true },
    );
    const before = store.state.notes.length;
    assert.throws(() => store.applyRemote([null, good]), (e) => e.name === 'TypeError' && /reading 'id'/.test(e.message));
    quiet();
    assert.equal(store.state.notes.length, before,
      'DEFECT: the well-formed op in the same batch was never applied');
    // `applyRemote` guards `null` when it builds the refusal set (`(o) => o && o.id`) and then
    // reads `op.id` unguarded in the very next loop. This is F-2's "becomes live the moment WP-8's
    // remote path exists" — already live on the remote path, today, in the shipping tree.
  });

  test('R3-24 FAILED (held): every OTHER malformed remote op shape is refused with a warning rather than a throw', () => {
    for (const bad of [{}, { id: 'x' }, 'string', 42, [], true]) {
      assert.doesNotThrow(() => store.applyRemote([bad]));
      quiet();
    }
    assert.ok(store.warnings.length >= 6, 'each one produced a refusal warning');
    assert.ok(store.warnings.every((w) => /refused/.test(w)));
  });

  test('R3-25 SUCCEEDED (defect): a peer\'s over-length value is REFUSED rather than truncated — the same value through the diff door truncates and warns', () => {
    // The two doors disagree about the same bytes. `mutate()`'s `fitValue` truncates to 80 and
    // warns; the op constructor refuses. F-2 says this becomes live on the wire; it is already
    // live at the import door, which is the same `fitValue` vs `makeOp` split.
    const warnBefore = store.warnings.length;
    store.mutate('long', (s) => { s.notes[0].text = LONG80; });
    quiet();
    assert.equal(store.state.notes[0].text.length, 80, 'the diff door truncates …');
    assert.ok(store.warnings.length > warnBefore, '… and says so');
    assert.throws(() => store.apply('editNotePopover', { id: 'n1', text: LONG80 }), (e) => e.name === 'OpError');
    quiet();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('attack 5 — what the retrofit newly refuses, and what it silently drops', () => {
  /**
   * Boards v1 opens, keeps in `state`, and writes back to `board.json` unchanged. For each one,
   * open it in v1 and in v2 and compare what SURVIVES INTO THE FILE.
   */
  const LOSSY = {
    'a note whose date is not ISO': board({ notes: [{ id: 'n', date: '4.3.2026', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false }] }),
    'a note with no date at all': board({ notes: [{ id: 'n', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false }] }),
    'a note with no id': board({ notes: [{ date: '2026-03-04', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false }] }),
    'a bar with no endDate': board({ bars: [{ id: 'b', startDate: '2026-03-01', label: 'Urlaub', categoryId: 'c1' }] }),
    'a scratchpad holding a number': board({ scratchpads: { '2026-03': 42 } }),
  };

  test('R3-26 SUCCEEDED (defect): five boards v1 keeps are silently emptied by v2, and the loss is written to board.json on the first autosave', async () => {
    const report = [];
    for (const [name, b] of Object.entries(LOSSY)) {
      await boot(v1store, structuredClone(b));
      const v1kept = v1store.state.notes.length + v1store.state.bars.length + Object.keys(v1store.state.scratchpads).length;

      await boot(store, structuredClone(b));
      const v2kept = store.state.notes.length + store.state.bars.length + Object.keys(store.state.scratchpads).length;
      const warned = store.warnings.length;
      await store.persistNow();
      quiet();
      const saved = JSON.parse(LS.getItem(BOARD_KEY));
      const onDisk = saved.notes.length + saved.bars.length + Object.keys(saved.scratchpads).length;
      report.push([name, v1kept, v2kept, onDisk, warned]);
    }
    for (const [name, v1kept, v2kept, onDisk, warned] of report) {
      assert.equal(v1kept, 1, `${name}: v1 keeps it`);
      assert.equal(v2kept, 0, `${name}: DEFECT — v2 drops it from the board`);
      assert.equal(onDisk, 0, `${name}: DEFECT — and rewrites board.json without it`);
      assert.ok(warned >= 1, `${name}: migrateV1 did warn`);
    }
    // The entry usually still EXISTS as a register — but in solo mode `board.json` is the
    // checkpoint (ADR 001 §9), so the next launch re-migrates the FILE and the register is gone
    // with it. One autosave and the note is unrecoverable, including from `snapshots.json`,
    // which stores `_persisted` — the already-emptied board.
  });

  test('R3-27 SUCCEEDED (defect): store.warnings is a write-only array — nothing in src/ ever reads it, so every loss above is silent to the user', async () => {
    await boot(store, board({ notes: [{ id: 'n', date: '4.3.2026', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false }] }));
    assert.ok(store.warnings.length >= 1, 'the diagnosis exists …');
    assert.ok(/DROPPED|not renderable/.test(store.warnings.join(' ')), '… and it is precise …');
    // … and it has no consumer. `grep -rn warnings src/` outside `core/` matches only the eight
    // WRITES in store.js. Principle 6 ("nothing is ever lost") is enforced at this layer by
    // design; here the layer knows it lost something and cannot say so.
  });

  test('R3-28 SUCCEEDED (defect): a repeating note whose flag is truthy-but-not-boolean STOPS REPEATING, silently', async () => {
    const b = board({ notes: [{ id: 'n', date: '2026-03-04', text: 'Geburtstag', categoryId: 'c1', repeatsYearly: 'yes' }] });
    await boot(v1store, structuredClone(b));
    assert.equal(v1store.state.notes[0].repeatsYearly, 'yes', 'v1 keeps the value, and it is truthy');

    await boot(store, structuredClone(b));
    assert.equal('repeatsYearly' in store.state.notes[0], false,
      'DEFECT: v2 drops the KEY — `find.js` / `layout.js` read it as falsy, so a yearly birthday becomes a one-off');
    await store.persistNow(); quiet();
    assert.equal('repeatsYearly' in JSON.parse(LS.getItem(BOARD_KEY)).notes[0], false, 'and the file loses it too');
  });

  test('R3-29 FAILED (held): the boards WP-1 round 1 bricked, and the awkward ones around them, all still open', async () => {
    const OPENABLE = {
      'no categories at all': { schemaVersion: 1, notes: [], bars: [], categories: [], scratchpads: {}, settings: {} },
      'settings.layers is a string': board({ settings: { ...board().settings, layers: 'nope' } }),
      'settings carries an unknown nested key': board({ settings: { ...board().settings, zzz: { deep: 1 } } }),
      'notes is an object, not an array': board({ notes: { 0: { id: 'n' } } }),
      'schemaVersion is 99': board({ schemaVersion: 99 }),
      'schemaVersion is the string "1"': board({ schemaVersion: '1' }),
      'no settings key at all': { schemaVersion: 1, notes: [], bars: [], categories: CATS(), scratchpads: {} },
      'a bar that ends before it starts': board({ bars: [{ id: 'b', startDate: '2026-05-01', endDate: '2026-03-01', label: 'L', categoryId: 'c1' }] }),
      'a note pointing at a category that is gone': board({ notes: [{ id: 'n', date: '2026-03-04', text: 'x', categoryId: 'weg', repeatsYearly: false }] }),
      '400 notes': board({ notes: Array.from({ length: 400 }, (_, i) => ({ id: `n${i}`, date: '2026-03-04', text: `t${i}`, categoryId: 'c1', repeatsYearly: false })) }),
    };
    for (const [name, b] of Object.entries(OPENABLE)) {
      await boot(v1store, structuredClone(b));
      const a = structuredClone(v1store.state);
      await boot(store, structuredClone(b));
      quiet();
      assert.equal(store.ready, true, `${name}: v2 opened it`);
      assert.equal(store.state.notes.length, a.notes.length, `${name}: same notes`);
      assert.equal(store.state.bars.length, a.bars.length, `${name}: same bars`);
      assert.equal(store.state.categories.length, a.categories.length, `${name}: same categories`);
      assert.deepEqual(store.state.settings.layers, a.settings.layers, `${name}: same layers`);
    }
  });

  test('R3-30 FAILED (held): replaceAll() — the import and snapshot-restore door — never throws, whatever it is handed', async () => {
    await boot(store);
    for (const bad of [null, undefined, 'hallo', 7, [], { schemaVersion: 1 }, { notes: null, categories: [] }]) {
      assert.doesNotThrow(() => store.replaceAll(bad), `replaceAll(${JSON.stringify(bad)})`);
      quiet();
      assert.ok(store.state.categories.length >= 1, 'and always leaves a legal v1 board behind');
    }
  });
});
