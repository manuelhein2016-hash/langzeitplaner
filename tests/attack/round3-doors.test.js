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
//    by over-guarding. The migration door does not brick anything now, but it DROPPED entries
//    that v1 keeps in its file, and `board.json` was then rewritten without them. In solo mode
//    `board.json` IS the checkpoint, so the loss was permanent after one autosave.
//
// Rows tagged `SUCCEEDED (defect)` are green BECAUSE the defect is there. If one goes red the
// gap was closed — invert it, do not repair it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED — A3-H2 IS CLOSED, AND THE ATTACK-5 ROWS ARE INVERTED (2026-08-27)
//
// The PO's decision on A3-H2 was COERCE: when a v1 board holds a value v2's type table rejects,
// read it the way v1 read it rather than dropping the entry, and log every coercion to the
// warnings channel so the change to the user's file is auditable. R3-26, R3-26b and R3-28 are the
// inverted rows; R3-26c is the A3-M1a door policy (neither door throws on a hostile file).
//
// R3-27 is NOT inverted and must not be: it is F-8 (`store.warnings` has no consumer, WP-10). The
// coercions are all on that channel and nothing reads it, so the board is right and the user is
// still not told what was changed on their file.
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
  // 16.4 — the setter `defaultVisibility` never had. It validates against the enum for the same
  // reason `addCategory` does one row above: `visibilityForNewEntry` fails CLOSED on anything
  // outside it, so an accepted bad value would look like the control doing nothing.
  ['setCategoryDefault', { id: 'c1', defaultVisibility: 'nope' }, 'a level outside the enum', 'throw'],
  ['setCategoryDefault', { id: 'c1', defaultVisibility: 3 }, 'a numeric level', 'throw'],
  ['deleteCategory', { id: 'c1', lastCategoryId: 9 }, 'a numeric lastCategoryId — ACCEPTED into a pref register', 'accept'],
  ['deleteCategoryReassign', { id: 'c1', targetId: 'c1', noteIds: [], barIds: [] }, 'reassigning a category to itself', 'throw'],
  ['deleteCategoryReassign', { id: 'c1', targetId: 'c2', noteIds: [null], barIds: [] }, 'a null id in the fan-out', 'throw'],
  // ── THE FAMILY VOCABULARY (E6-1), DRIVEN THROUGH THE SAME DOOR ON A SOLO STORE ──────────────
  // `boot(store)` adopts no Familienkreis, so every one of these is refused BEFORE its arguments
  // are read — and that is the claim worth pinning here, not the arguments: story 15.1 and 21.5
  // say a solo Mac emits no family op and makes no request, and this door is where a caller with
  // hostile args would otherwise try. Each row still carries genuinely hostile input so that the
  // day a family space IS in force the row keeps its meaning rather than becoming a tautology.
  ['setMyProfile', { displayName: 42 }, 'a numeric display name — solo store, no Familienkreis', 'throw'],
  ['attestMyDevice', { deviceShort: 'nope', blob: 'x' }, 'a deviceShort that is not 16 Crockford characters', 'throw'],
  ['renameSpace', { name: '' }, 'an empty Familienkreis name', 'throw'],
  ['claimAdmin', {}, 'claiming the admin seat with no space to be admin of', 'throw'],
  ['transferAdmin', { admin: 'nope', adminPrev: null }, 'a transfer to a non-MemberId with no predecessor link', 'throw'],
  ['removeMember', { memberId: 'mem_nope' }, 'removing a member named by a malformed id (20.2)', 'throw'],
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

  test('R3-20 SUCCEEDED (defect, F-2 widened): 35 of 44 hostile inputs THROW out of apply(); F-2 as filed names four of them', async () => {
    const rows = await runCorpus();
    const wrong = rows.filter((r) => r.actual !== r.expect)
      .map((r) => `${r.name} (${r.why}): expected ${r.expect}, got ${r.actual}${r.err ? ` ${r.err}` : ''}`);
    assert.deepEqual(wrong, [], 'the corpus itself must be accurate');

    const thrown = rows.filter((r) => r.actual === 'throw');
    // 42 → 44, and 33 → 35: 16.4's `setCategoryDefault` contributes two hostile rows, both of
    // which throw, exactly as `addCategory`'s own out-of-enum row does. The defect this row
    // characterises is unchanged in kind; it is two inputs wider.
    assert.equal(rows.length, 44);
    assert.equal(thrown.length, 35,
      'DEFECT: thirty-five inputs a file or a peer can supply reach a THROW rather than a decline');
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

  test('R3-22 FAILED (held): every one of the 28 named mutations is covered by the corpus above', () => {
    const covered = new Set(F2.map(([n]) => n));
    const missing = Object.keys(MUTATIONS).filter((n) => !covered.has(n));
    assert.deepEqual(missing, [], 'a mutation added later without a row here would slip past this attack');
    // 22 v1 retrofits + 6 family rows (E6-1, plus 20.2's removeMember) + the v2 BOARD rows.
    // Counted by their DISCRIMINATOR rather than in one total, so that a family row growing a v1
    // `sites` entry — which would corrupt `V1_MUTATE_SITES` and the 22-site proof built on it —
    // reddens this too.
    //
    // The family count is derived from the KIND now, not from an empty `sites`. That proxy held
    // only while every post-v1 row happened to be a family one; `setCategoryDefault` (16.4) is a
    // v2 row that writes `cat.set`, so it has no v1 site AND is not family.
    const retrofit = Object.keys(MUTATIONS).filter((n) => MUTATIONS[n].sites.length > 0);
    const family = Object.keys(MUTATIONS).filter((n) => MUTATIONS[n].kinds
      .every((k) => k.startsWith('member.') || k.startsWith('space.')));
    const v2board = Object.keys(MUTATIONS).filter((n) => MUTATIONS[n].sites.length === 0
      && !MUTATIONS[n].kinds.every((k) => k.startsWith('member.') || k.startsWith('space.')));
    assert.equal(retrofit.length, 22);
    assert.equal(family.length, 6);
    assert.deepEqual(v2board, ['setCategoryDefault']);
  });

  // ── R3-23 · INVERTED 2026-08-27 · A3-H3 is CLOSED ────────────────────────────
  // Edited by the store agent, whose finding this is; the rest of this file (F-2 / A3-H2 /
  // A3-M1a) is untouched. `applyRemote` now judges every entry in the batch on its own and
  // NEVER throws — the door policy for externally-sourced input.
  test('R3-23 FAILED (held, A3-H3 closed): one bad entry in a remote batch costs that entry and nothing else', () => {
    const good = noteSet(
      { act: store._me, dev: store._device, gid: 'B'.repeat(22), space: 'personal', familySpaceId: null,
        mint: () => fmt(Date.now(), 0, '0'.repeat(16)), newOpId: () => 'A'.repeat(22) },
      'zz', { date: '2026-03-04', text: 'überlebt', categoryId: 'c1', repeatsYearly: false, visibility: 'privat', coEdit: false, _alive: true },
      { born: true },
    );
    const before = store.state.notes.length;
    store.warnings.length = 0;
    assert.doesNotThrow(() => store.applyRemote([null, good]));
    quiet();
    assert.equal(store.state.notes.length, before + 1, 'the well-formed op in the same batch was applied');
    assert.equal(store.state.notes.find((n) => n.id === 'zz').text, 'überlebt');
    assert.ok(store.warnings.some((w) => /refused: not a well-formed op \(null\)/.test(w)),
      'and the null was refused by name: ' + JSON.stringify(store.warnings));
  });

  test('R3-23b FAILED (held): the siblings on the same path — a non-iterable batch, an unobservable stamp, a log that refuses', () => {
    // Audited alongside A3-H3, since "one missing guard" is only true if there is exactly one.
    store.warnings.length = 0;
    for (const notABatch of [42, 'ops', { 0: 'op' }, true]) {
      assert.doesNotThrow(() => store.applyRemote(notABatch), `applyRemote(${JSON.stringify(notABatch)})`);
      quiet();
    }
    assert.equal(store.warnings.filter((w) => /expected an array of ops/.test(w)).length, 4);

    // ── THE UNOBSERVABLE STAMP — corrected 2026-08-27 by mutation testing ─────────────────────
    //
    // The A3-H3 pass wrapped `this._clock.observe(op.ts)` because `observe` throws `TypeError` on
    // anything that is not a 37-character stamp, and called it "a live sibling a peer could
    // trigger". IT IS NOT LIVE, and the row below is the correction: reverting that try/catch
    // killed no test, and a probe of ten hostile `ts` values through `applyRemote` reached the
    // clock with none of them. `ops.js:397` (`validateOp`) refuses `op.ts` that is not a stamp,
    // `foldAuthorized` therefore puts every one of them in `verdict.rejected`, and the loop skips
    // a refused op before it touches the clock. The guard is belt to that braces and is kept for
    // it, but what is ASSERTED here is the reachability claim itself: the gate refuses these, by
    // name and with a reason. If a future change to the gate ever lets one past, this row goes
    // red and the guard stops being redundant — which is the only honest way to pin code whose
    // whole value is that it is currently unreachable.
    const ctx = { act: store._me, dev: 'dev_' + 'C'.repeat(22), gid: 'B'.repeat(22), space: 'personal', familySpaceId: null,
      mint: () => fmt(Date.now(), 0, '0'.repeat(16)), newOpId: () => 'D'.repeat(22) };
    const op = noteSet(ctx, 'yy', { text: 'vom Peer', date: '2026-03-05', categoryId: 'c1', repeatsYearly: false, visibility: 'privat', coEdit: false, _alive: true }, { born: true });
    const badStamps = ['nicht-ein-stempel', '', null, undefined, 42, {}, [],
      'A'.repeat(37), '0'.repeat(37), fmt(Date.now(), 0, '0'.repeat(16)).slice(0, 36)];
    for (const [i, ts] of badStamps.entries()) {
      store.warnings.length = 0;
      const id = 'E'.repeat(21) + String.fromCharCode(65 + i);
      assert.doesNotThrow(() => store.applyRemote([{ ...op, id, ts }]), `ts = ${JSON.stringify(ts)}`);
      quiet();
      assert.ok(store.warnings.some((w) => w.includes(id) && /refused/.test(w)),
        `ts = ${JSON.stringify(ts)} must be refused BY NAME before the clock is asked to observe `
        + `it: ${JSON.stringify(store.warnings)}`);
      assert.equal(store.state.notes.some((n) => n.id === 'yy'), false, 'and it never lands');
    }
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

  test('R3-26 INVERTED (A3-H2 closed): all five boards v1 keeps are kept by v2, and survive the autosave that used to erase them', async () => {
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
      assert.equal(v2kept, 1, `${name}: and so does v2 — the door coerces to v1's meaning`);
      assert.equal(onDisk, 1, `${name}: and the autosave writes it back`);
      assert.ok(warned >= 1, `${name}: and the coercion is on the warnings channel, auditable`);
    }
    // AND IT SURVIVES THE SECOND LAUNCH, which is what made this permanent: in solo mode
    // `board.json` IS the checkpoint (ADR 001 §9), so whatever the first autosave wrote is what
    // the next migration reads. A round trip through the file is the real test.
    for (const [name, b] of Object.entries(LOSSY)) {
      await boot(store, structuredClone(b));
      await store.persistNow();
      quiet();
      const afterFirstLaunch = JSON.parse(LS.getItem(BOARD_KEY));
      await boot(store, afterFirstLaunch);
      const kept = store.state.notes.length + store.state.bars.length + Object.keys(store.state.scratchpads).length;
      assert.equal(kept, 1, `${name}: still there on the SECOND launch`);
    }
  });

  test('R3-26b (A3-H2): what each of the five coerced to — v1\'s meaning, field by field', async () => {
    await boot(store, board({ notes: [{ id: 'n', date: '4.3.2026', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false }] }));
    assert.equal(store.state.notes[0].date, '2026-03-04', 'the German date names one day');
    assert.equal(store.state.notes[0].text, 'Zahnarzt');

    await boot(store, board({ notes: [{ id: 'n', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false }] }));
    assert.equal(store.state.notes[0].date, undefined, 'no date is INVENTED …');
    assert.equal(store.state.notes[0].text, 'Zahnarzt', '… and the entry is kept anyway');
    assert.match(store.warnings.join('\n'), /will not be DRAWN on any day/);

    await boot(store, board({ notes: [{ date: '2026-03-04', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false }] }));
    assert.equal(store.state.notes.length, 1, 'a note with no id gets a derived one');
    assert.ok(store.state.notes[0].id, 'and it is a real id, so the UI can address it');

    // R4-10 OVERRULED THIS ROW'S SECOND HALF. It used to assert `['2026-03-01', '2026-03-01']` —
    // the anchor — on the reasoning that v1 drew this bar to the horizon, the horizon depends on
    // TODAY, and TODAY cannot be migrated (R12). Round 4 painted the same bar with the shipping
    // `layout.js` and found v1 drawing NINE column-segments where the anchor drew one day, plus
    // an `endDate` written into the user's file that the file never held. The premise held; the
    // conclusion did not, because the horizon is not data — it is what `layout.js` does with an
    // absent edge, in v2 exactly as in v1. So the edge stays absent and the renderer does the
    // rest. What this row was really about is unchanged and still asserted: the bar is KEPT.
    await boot(store, board({ bars: [{ id: 'b', startDate: '2026-03-01', label: 'Urlaub', categoryId: 'c1' }] }));
    assert.equal(store.state.bars.length, 1, 'the bar is on the board …');
    assert.deepEqual(
      [store.state.bars[0].startDate, store.state.bars[0].endDate],
      ['2026-03-01', undefined],
      '… with the edge the file carried, and nothing at the edge it did not',
    );

    await boot(store, board({ scratchpads: { '2026-03': 42 } }));
    assert.equal(store.state.scratchpads['2026-03'], '42', 'v1 paints `42 || ""` into the textarea');
  });

  test('R3-27 SUCCEEDED (defect, F-8): store.warnings is a write-only array — nothing in src/ ever reads it, so every coercion above is invisible to the user', async () => {
    await boot(store, board({ notes: [{ id: 'n', date: '4.3.2026', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false }] }));
    assert.ok(store.warnings.length >= 1, 'the diagnosis exists …');
    assert.ok(/COERCED|DROPPED|will not be DRAWN/.test(store.warnings.join(' ')), '… and it is precise …');
    // … and it has no consumer. `grep -rn warnings src/` outside `core/` matches only the eight
    // WRITES in store.js. A3-H2's decision was "coerce, and log every coercion to the warnings
    // channel so it is auditable" — the coercions are all there and nothing reads them, which is
    // F-8, owned by WP-10. Closing A3-H2 makes this row MORE important, not less: the board is
    // now right and the user still has no way to be told what was changed on their file.
  });

  test('R3-28 INVERTED (A3-H2 closed): a repeating note whose flag is truthy-but-not-boolean KEEPS REPEATING', async () => {
    const b = board({ notes: [{ id: 'n', date: '2026-03-04', text: 'Geburtstag', categoryId: 'c1', repeatsYearly: 'yes' }] });
    await boot(v1store, structuredClone(b));
    assert.equal(v1store.state.notes[0].repeatsYearly, 'yes', 'v1 keeps the value, and it is truthy');

    await boot(store, structuredClone(b));
    assert.equal(store.state.notes[0].repeatsYearly, true,
      "v2 reads it the way v1 read it — `layout.js:71` is `if (!n.repeatsYearly)`, so 'yes' repeats");
    await store.persistNow(); quiet();
    assert.equal(JSON.parse(LS.getItem(BOARD_KEY)).notes[0].repeatsYearly, true, 'and the file carries it');
    assert.ok(store.warnings.some((w) => /COERCED/.test(w)), 'and the change to the file is on the record');

    // The counter-case, from v1's OTHER boolean: a category is hidden only by a literal `false`
    // (`layout.js:111`), so `visible: 'ja'` — and `visible: 0` — stay VISIBLE.
    await boot(store, board({ categories: [{ id: 'c1', name: 'A', nameEn: 'A', paletteRef: 'blau', visible: 'ja' }] }));
    assert.equal(store.state.categories[0].visible, true);
    await boot(store, board({ categories: [{ id: 'c1', name: 'A', nameEn: 'A', paletteRef: 'blau', visible: 0 }] }));
    assert.equal(store.state.categories[0].visible, true, '`Boolean(0)` would have hidden a category v1 shows');
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

  test('R3-26c (A3-M1a, the door policy): NEITHER door throws on a hostile file — refuse-or-coerce and warn', async () => {
    // The lead's ruling on A3-M1a: never throw on externally-sourced input; throw only on
    // programmer error. A `board.json` is externally-sourced by definition — it is a file on a
    // disk the user can open in a text editor — so every shape below must be opened, coerced or
    // refused per field, and warned about. None of them may take the app down on launch.
    // A deeply nested `settings` object USED TO BE EXCLUDED from this list, and the exclusion is
    // now gone. Both DOORS always survived it (`core-migrate.test.js` / `core-replace.test.js`
    // put the same shape through `migrateV1` and `planReplaceAll` directly), but `_project`'s
    // `structuredClone(state.settings)` overflowed the stack ABOVE both of them, out of `init()`,
    // and the frozen v1 store crashed on the same file. Closed by `ops.js:PREF_MAX_DEPTH` and its
    // second lock in `materialize.js` — depth by depth in `round3-persistence.test.js` R3-36b,
    // and here as one more shape the door policy has to open. v2 is now strictly better than v1
    // on this input rather than equally bad, which is the only reason parity was ever an argument.
    const deepSettings = (n) => { let o = {}; const r = o; for (let i = 0; i < n; i++) { o.k = {}; o = o.k; } o.leaf = 1; return r; };
    const HOSTILE = {
      'settings nested two thousand deep': () => { const b = board(); b.settings.deepThing = deepSettings(2000); return b; },
      'a note that is an array': () => board({ notes: [[1, 2]] }),
      'an id full of key separators': () => board({ notes: [{ id: 'a/b:c', date: '2026-03-04', text: 'x', categoryId: 'c1' }] }),
      'an id named __proto__': () => board(JSON.parse('{"notes":[{"id":"__proto__","date":"2026-03-04","text":"x","categoryId":"c1"}]}')),
      'a null and an Infinity date': () => board({ notes: [{ id: 'n', date: null, text: 'x', categoryId: 'c1' }, { id: 'm', date: 1e999, text: 'y', categoryId: 'c1' }] }),
      'a bar whose dates are containers': () => board({ bars: [{ id: 'b', startDate: {}, endDate: [], label: 'x', categoryId: 'c1' }] }),
      'scratchpads with forbidden keys': () => board({ scratchpads: JSON.parse('{"__proto__":"x","2026-01":{"a":1},"9999-99":"y"}') }),
      'every field the wrong type at once': () => board({
        notes: [{ id: 5, date: 20260304, text: 7, categoryId: 9, repeatsYearly: 'yes' }],
        bars: [{ id: true, startDate: '4.3.2026', endDate: null, label: {}, categoryId: [] }],
        categories: [{ id: null, name: 1, nameEn: [], paletteRef: 2, visible: 'ja' }],
        scratchpads: { '2026-03': 42 },
      }),
    };
    for (const [name, make] of Object.entries(HOSTILE)) {
      await boot(store, make());
      quiet();
      assert.equal(store.ready, true, `${name}: the app booted`);
      assert.ok(store.state.categories.length >= 1, `${name}: and left a legal v1 board`);
      // …and the same bytes through the OTHER door, which is the one 11.5 restore uses.
      assert.doesNotThrow(() => store.replaceAll(make()), `${name}: replaceAll threw`);
      quiet();
      assert.ok(store.state.categories.length >= 1, `${name}: and again after the restore`);
    }
    assert.ok(Object.prototype.polluted === undefined && ({}).a === undefined,
      'and nothing was written to Object.prototype on the way through');
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
