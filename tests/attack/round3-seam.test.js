// ─────────────────────────────────────────────────────────────────────────────
// ROUND 3 — ADVERSARY, ATTACK 1 + 2: THE SEAM BETWEEN store.js AND core/
//
// Rounds 1 and 2 attacked `src/js/core/` in isolation. WP-3 wired the core into the shipping
// app, so this file attacks the JOIN: `txn()` / `apply()` / `applyRemote()`, the materialisation
// and the `reconcileMap` / `reconcileList` layer that copies a projection back into the live
// `store.state`.
//
// It also does what the brief asked of F-1: confirm its scope and hunt for SIBLINGS of the same
// class — "the projection cannot express something, so `state` and the registers disagree" —
// with a worse consequence than key order.
//
// READ THIS BEFORE "FIXING" A RED ROW. Several tests here are green because they ASSERT A DEFECT
// EXISTS, exactly as `recheck-*.test.js` and `convergence-authz.test.js` already do in this
// directory. Each such row is tagged `SUCCEEDED (defect)`. If one goes red, the gap was closed —
// INVERT THE ROW, do not "repair" it. Rows tagged `FAILED (held)` are the attack failing, i.e.
// the code holding, and those must stay green.
//
// Zero npm dependencies. node:test + node:assert + the repo's own env shim.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { localStorage as LS, resetStorage, seedBoard } from '../helpers/env.js';
import { store, defaultState } from '../../src/js/store.js';
import { materialize, stripV2Fields } from '../../src/js/core/materialize.js';
import { prefSet, noteSet } from '../../src/js/core/ops.js';
import { fmt } from '../../src/js/core/stamp.js';

const BOARD_KEY = 'langzeitplaner.board';

const CATS = () => [
  { id: 'c1', name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true },
  { id: 'c2', name: 'Familie', nameEn: 'Family', paletteRef: 'gruen', visible: true },
];
const SETTINGS = () => ({
  bundesland: 'BY',
  layers: { feiertage: true, schulferien: true, otherStates: false, ferienPattern: false },
  mode: 'rolling', startMonth: '2026-01', pageYears: 0, language: 'de',
  launchAtLogin: false, menuBarIcon: true, rowHeight: 22, colWidth: 118,
  paper: 'a4', lastCategoryId: 'c1', seenFirstRun: true,
});
const board = (p = {}) => ({
  schemaVersion: 1, notes: [], bars: [], categories: CATS(), scratchpads: {},
  settings: SETTINGS(), ...p,
});

/** A cold start over exactly these bytes, with every v1 lever the char suite uses. */
async function boot(b = board()) {
  clearTimeout(store._saveTimer);
  store.listeners.clear();
  resetStorage();
  seedBoard(b);
  store.undoStack.length = 0;
  store.redoStack.length = 0;
  store.snapshots.length = 0;
  store._lastSnapshotDay = null;
  store.ready = false;
  await store.init();
  clearTimeout(store._saveTimer);
}
/** A relaunch over whatever is on disk now — no reseed. */
async function relaunch() {
  clearTimeout(store._saveTimer);
  store.listeners.clear();
  store.undoStack.length = 0;
  store.redoStack.length = 0;
  store.snapshots.length = 0;
  store._lastSnapshotDay = null;
  store.ready = false;
  await store.init();
  clearTimeout(store._saveTimer);
}
const quiet = () => clearTimeout(store._saveTimer);

/** What the register map ALONE says the v1 board is — the other half of every disagreement. */
const projected = () => stripV2Fields(materialize(store.registers(), {
  me: store._me,
  familySpaceId: null,
  members: new Map(),
  currentMembers: new Set([store._me]),
  hiddenMembers: new Set(),
  defaultSettings: defaultState().settings,
}));

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const pad22 = (s) => {
  let o = '';
  for (const c of String(s)) o += B64.includes(c) ? c : B64[c.charCodeAt(0) % 64];
  return (o + 'A'.repeat(22)).slice(0, 22);
};
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const short16 = (s) => {
  let o = '';
  for (const c of String(s).toUpperCase()) o += CROCK.includes(c) ? c : CROCK[c.charCodeAt(0) % 32];
  return (o + '0'.repeat(16)).slice(0, 16);
};
/** An OpCtx for an op that arrives from somewhere else — a peer, or my own other Mac. */
const remoteCtx = ({ act = store._me, dev = `dev_${pad22('otherMac')}`, gid = pad22('g1'), space = 'personal', id = pad22('rm1') } = {}) => ({
  act, dev, gid, space, familySpaceId: null,
  mint: () => fmt(Date.now(), 0, short16('other-mac')),
  newOpId: () => id,
});

afterEach(quiet);
after(quiet);

// ─────────────────────────────────────────────────────────────────────────────
describe('F-1 — confirming the scope, and the siblings of its class', () => {
  beforeEach(async () => { await boot(); });

  test('R3-1 SUCCEEDED (defect, F-1 confirmed): board.json is not a fixed point once two scratchpads exist', async () => {
    store.apply('padTyping', { month: '2026-05', text: 'Mai', born: true });
    quiet();
    store.apply('padTyping', { month: '2026-03', text: 'März', born: true });
    quiet();

    // `reconcileMap` does `Object.assign` and never reorders, so the LIVE map is in creation
    // order while the projection is in `sortScratchpads` order.
    assert.deepEqual(Object.keys(store.state.scratchpads), ['2026-05', '2026-03']);
    assert.deepEqual(Object.keys(projected().scratchpads), ['2026-03', '2026-05']);

    await store.persistNow(); quiet();
    const gen0 = LS.getItem(BOARD_KEY);
    await relaunch();
    await store.persistNow(); quiet();
    const gen1 = LS.getItem(BOARD_KEY);
    await relaunch();
    await store.persistNow(); quiet();
    const gen2 = LS.getItem(BOARD_KEY);

    assert.notEqual(gen0, gen1, 'F-1: the first save of the second session rewrites the file');
    assert.equal(gen1, gen2, 'it converges after one relaunch — this is a byte, not a content, defect');
    assert.deepEqual(JSON.parse(gen0).scratchpads, JSON.parse(gen1).scratchpads, 'content is identical');
  });

  test('R3-2 SUCCEEDED (defect, NEW sibling): the same class is in reconcileList — an ENTRY object\'s key order also only settles at the next launch', async () => {
    // `reconcileList` DOES rebuild array order, so F-1 was reported as scratchpad-only. But it
    // preserves an entry object's IDENTITY, and therefore its KEY order: a caller that pushed a
    // note with keys in another order keeps that order for the whole session, and gets
    // materialize's order after a relaunch. Same failure, one level down.
    store.mutate('seed', (s) => {
      s.notes.push({ text: 'zwei', id: 'n2', repeatsYearly: false, categoryId: 'c2', date: '2026-05-04' });
    });
    quiet();
    assert.deepEqual(Object.keys(store.state.notes[0]), ['text', 'id', 'repeatsYearly', 'categoryId', 'date']);

    await store.persistNow(); quiet();
    const gen0 = LS.getItem(BOARD_KEY);
    await relaunch();
    assert.deepEqual(Object.keys(store.state.notes[0]), ['id', 'date', 'text', 'categoryId', 'repeatsYearly'],
      'after a relaunch the object comes from materialize and carries v1\'s canonical key order');
    await store.persistNow(); quiet();
    assert.notEqual(gen0, LS.getItem(BOARD_KEY));

    // Reachability, stated honestly: all 22 shipping sites now go through txn()/apply(), whose
    // entries are BORN from materialize, so only a `mutate()` caller can reach this. `mutate()`
    // is a supported door (store.js header note 1) and the WP-2 oracle uses it 60 times.
  });

  test('R3-3 SUCCEEDED (defect, the WORSE sibling): a remote pref.set moves the registers and never reaches state.settings', async () => {
    // THE ANSWER TO "is the same class reachable with a worse consequence than key order?" — yes,
    // on `settings`, through `applyRemote()`. `_project()` deliberately does not re-derive
    // settings (store.js note 4), and `applyPrefOps()` runs only inside `_commit()`. The remote
    // path calls neither, so a `pref.set` that lands in the log is INVISIBLE to the board.
    assert.equal(store.state.settings.rowHeight, 22);
    assert.equal(store.state.settings.layers.feiertage, true);

    const op = prefSet(remoteCtx({ space: 'local' }), { rowHeight: 44, 'layers.feiertage': false });
    store.applyRemote([op]); quiet();

    assert.equal(store.registers().get('pref:app').get('rowHeight').value, 44, 'the register moved');
    assert.equal(store.registers().get('pref:app').get('layers.feiertage').value, false);
    assert.equal(store.state.settings.rowHeight, 22, 'DEFECT: the board did not');
    assert.equal(store.state.settings.layers.feiertage, true, 'DEFECT: a drawn layer disagrees with its register');
    assert.deepEqual(store.warnings, [], 'and nothing was warned about');

    await store.persistNow(); quiet();
    assert.equal(JSON.parse(LS.getItem(BOARD_KEY)).settings.rowHeight, 22,
      'board.json is written from `state`, so in solo mode the remote change is silently DISCARDED …');
    // … and the moment `checkpoint.json` exists (WP-8) the checkpoint wins at the next launch
    // instead, so the row height and the Feiertage layer change under the user with no gesture
    // behind them. Same class as F-1; the consequence is a VALUE, not a byte order.
  });

  test('R3-4 SUCCEEDED (defect): applyRemote has no space filter, so it admits `local`-space ops that ADR 001 §3.3 says are NEVER SYNCED', () => {
    // The op in R3-3 is in the `local` space. `pref` is documented "persisted, never undoable,
    // NEVER SYNCED (17.7 / ADR 001 §3.3)" — so no legitimate remote batch can contain one, and
    // the remote door should refuse the whole class rather than fold it.
    const op = prefSet(remoteCtx({ space: 'local' }), { language: 'en' });
    assert.equal(op.space, 'local');
    store.applyRemote([op]); quiet();
    assert.equal(store.registers().get('pref:app').get('language').value, 'en', 'DEFECT: admitted and folded');
    assert.deepEqual(store.warnings, [], 'DEFECT: not even reported');
  });

  test('R3-5 SUCCEEDED (defect, known-quirk consequence): setSettings\' wholesale replace leaves state and the registers disagreeing about a DRAWN layer', () => {
    // v1's `setSettings({layers})` REPLACES the layer object; the retrofit keeps that quirk
    // (store.js note 4) and `diffSettings` writes the DEFAULT for every key the replace dropped.
    // The two halves therefore disagree about `layers.feiertage` — state says "absent" (falsy,
    // layer OFF, `layout.js:243` is `s.layers.feiertage &&`), the register says `true`.
    store.setSettings({ layers: { otherStates: true } });
    quiet();
    assert.deepEqual(store.state.settings.layers, { otherStates: true });
    assert.deepEqual(projected().settings.layers,
      { feiertage: true, schulferien: false, otherStates: true, ferienPattern: false });
    // No shipping site passes `layers` to setSettings today (all 12 layer writes go through
    // setLayer, which merges) — but this is the same disagreement as R3-3 reached from the LOCAL
    // door, and it becomes visible the day the checkpoint is authoritative.
  });

  test('R3-6 SUCCEEDED (defect, minor): a setSettings() makes the NEXT transaction emit a duplicate pref.set', () => {
    // `_pref()` appends the op but never re-syncs `_projected.settings`, so the next `_adopt()`
    // sees a settings diff that has already been written and says it a second time, at a fresh
    // stamp, outside any group.
    store.setSettings({ colWidth: 200 }); quiet();
    const before = store._log.ops().length;
    store.apply('addCategory', { id: 'c3', name: 'C', nameEn: 'C', paletteRef: 'rot' });
    quiet();
    const added = store._log.ops().slice(before).map((o) => o.k);
    assert.deepEqual(added, ['pref.set', 'cat.set'], 'DEFECT: one add-category emitted two ops');
    // Self-limiting (`_adopt` re-syncs afterwards) and pref is local-space, so it cannot beat a
    // remote write. Log bloat and a misleading log, not a data defect.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the seam — aliasing, ordering and mid-transaction visibility', () => {
  beforeEach(async () => { await boot(board({ notes: [{ id: 'n1', date: '2026-03-04', text: 'a', categoryId: 'c1', repeatsYearly: false }] })); });

  test('R3-7 FAILED (held): an entry object a caller is holding survives an unrelated transaction', () => {
    const held = store.state.notes[0];
    store.apply('addCategory', { id: 'c3', name: 'C', nameEn: 'C', paletteRef: 'rot' });
    quiet();
    assert.equal(held, store.state.notes[0], 'store.js note 3 — identity is preserved');
    store.apply('editNotePopover', { id: 'n1', text: 'b' });
    quiet();
    assert.equal(held, store.state.notes[0]);
    assert.equal(held.text, 'b', 'and the held reference sees the edit');
  });

  test('R3-8 FAILED (held): a listener firing on the transaction already sees the [L] pref and the new content', () => {
    let seen = null;
    store.subscribe((s, why) => { if (why === 'create-note') seen = { last: s.settings.lastCategoryId, n: s.notes.length }; });
    store.apply('createNoteInline', { id: 'n9', date: '2026-03-04', text: 'neu', categoryId: 'c2', lastCategoryId: 'c2' });
    quiet();
    assert.deepEqual(seen, { last: 'c2', n: 2 }, 'applyPrefOps runs before emit — story 4.2 in both directions');
  });

  test('R3-9 FAILED (held): a constructor that throws leaves NOTHING half-applied', () => {
    const ops = store._log.ops().length;
    const undo = store.undoStack.length;
    assert.throws(() => store.apply('editNotePopover', { id: 'n1', text: 'z'.repeat(81) }));
    quiet();
    assert.equal(store._log.ops().length, ops, 'no op reached the log');
    assert.equal(store.undoStack.length, undo, 'no undo step');
    assert.equal(store.state.notes[0].text, 'a', 'the board is untouched');
  });

  test('R3-10 SUCCEEDED (defect, latent): a mutate() callback that throws leaves an edit that the NEXT action adopts with no undo step', () => {
    assert.throws(() => store.mutate('boom', (s) => { s.notes[0].text = 'halb'; throw new Error('boom'); }));
    quiet();
    assert.equal(store.state.notes[0].text, 'halb');
    assert.equal(store.undoStack.length, 0, 'no step for the half-edit — same as v1 so far');

    store.apply('addCategory', { id: 'c3', name: 'C', nameEn: 'C', paletteRef: 'rot' });
    quiet();
    store.undo(); quiet();
    assert.equal(store.state.notes[0].text, 'halb',
      'DEFECT vs v1: `_adopt()` has written the half-edit into the log permanently and no ⌘Z can reach it');
  });

  test('R3-11 SUCCEEDED (defect, latent): a NESTED mutate() builds an undo step that reverts TWO actions — risk R5\'s guard catches it', () => {
    store.mutate('outer', (s) => {
      s.categories.push({ id: 'o1', name: 'O', nameEn: 'O', paletteRef: 'blau', visible: true });
      store.mutate('inner', (t) => {
        t.categories.push({ id: 'i1', name: 'I', nameEn: 'I', paletteRef: 'rot', visible: true });
      });
    });
    quiet();
    assert.deepEqual(store.state.categories.map((c) => c.id), ['c1', 'c2', 'o1', 'i1']);
    assert.equal(store.undoStack.length, 2, 'two entries were recorded …');

    assert.deepEqual(store._stacks.labels(), ['inner', 'outer']);
    // … but the OUTER diff re-describes the inner entity, because `before` was cloned before the
    // callback ran while the inner `_adopt()` + `_commit()` happened inside it. So the top entry
    // un-creates BOTH categories in one step.
    assert.equal(store.undo(), true);
    quiet();
    assert.deepEqual(store.state.categories.map((c) => c.id), ['c1', 'c2'],
      'DEFECT: one ⌘Z reverted two user actions, and it did so without complaint');

    // The step below it is now stale, and R5's mechanical guard catches THAT — one action late,
    // and only because the suite arms `__LZP_DEV`. In the shipping build `DEV` is false and the
    // second ⌘Z is simply a keystroke that does nothing.
    assert.throws(() => store.undo(),
      (e) => e.name === 'ShadowUndoError' && /categories\.length: 3 vs 2/.test(e.message));
    quiet();
    // v1 is also wrong here, differently (its second ⌘Z restores `o1`). No shipping site nests
    // today; `mutate()` remains a supported door (store.js header note 1) and the WP-2 oracle
    // uses it 60 times, so this is an API-contract defect, not a dead branch.
  });

  test('R3-11b SUCCEEDED (defect): when verify() fires, `undo()` has ALREADY changed the board — and never persists or redraws it', () => {
    // `store.undo()` is: append → `_project()` → `verify()` → `schedulePersist()` → `emit()`.
    // The guard is third, so a throw leaves the board mutated, UNSAVED and UN-REDRAWN. A DEV-only
    // diagnostic that leaves the app in that state is a worse outcome than the mismatch it found;
    // `verify()` belongs before the ops are appended, or the throw belongs after `emit()`.
    let emitted = 0;
    store.subscribe((_s, why) => { if (why === 'undo') emitted += 1; });
    store.mutate('outer', (s) => {
      s.categories.push({ id: 'o1', name: 'O', nameEn: 'O', paletteRef: 'blau', visible: true });
      store.mutate('inner', (t) => {
        t.categories.push({ id: 'i1', name: 'I', nameEn: 'I', paletteRef: 'rot', visible: true });
      });
    });
    quiet();
    store.undo(); quiet();                       // the collapsing step from R3-11
    assert.equal(emitted, 1);

    const opsBefore = store._log.ops().length;
    const timerBefore = store._saveTimer;
    assert.throws(() => store.undo(), (e) => e.name === 'ShadowUndoError');
    assert.ok(store._log.ops().length > opsBefore, 'the inverse ops were appended BEFORE the guard ran');
    assert.equal(store._saveTimer, timerBefore, 'DEFECT: schedulePersist() was never reached');
    assert.equal(emitted, 1, 'DEFECT: emit() was never reached, so no listener knows the log moved');
    assert.equal(store.canUndo(), false, 'and the stack was popped, so the step is gone either way');
    quiet();
  });

  test('R3-12 FAILED (held): a listener that mutates during emit() lands as its OWN undo step', () => {
    let fired = 0;
    store.subscribe((s, why) => {
      if (why === 'add-category' && fired++ === 0) {
        store.apply('addCategory', { id: 'inner', name: 'I', nameEn: 'I', paletteRef: 'rot' });
        quiet();
      }
    });
    store.apply('addCategory', { id: 'outer', name: 'O', nameEn: 'O', paletteRef: 'gelb' });
    quiet();
    assert.deepEqual(store.state.categories.map((c) => c.id), ['c1', 'c2', 'outer', 'inner']);
    assert.equal(store.undoStack.length, 2);
    store.undo(); quiet();
    assert.deepEqual(store.state.categories.map((c) => c.id), ['c1', 'c2', 'outer'],
      're-entrancy through emit() is safe — the outer group is already committed when it fires');
  });

  test('R3-13 FAILED (held): registers() hands out a memoised map, but appending invalidates it rather than mutating the copy a caller kept', () => {
    const snap = store.registers();
    const textBefore = snap.get('note:n1').get('text').value;
    store.apply('editNotePopover', { id: 'n1', text: 'b' });
    quiet();
    assert.equal(snap.get('note:n1').get('text').value, textBefore, 'the retained map is a detached fold');
    assert.equal(store.registers().get('note:n1').get('text').value, 'b');
    assert.notEqual(snap, store.registers());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('attack 3 — undo across the retrofit', () => {
  const NOTES = () => [
    { id: 'n1', date: '2026-03-04', text: 'a', categoryId: 'c1', repeatsYearly: false },
    { id: 'n2', date: '2026-04-04', text: 'b', categoryId: 'c1', repeatsYearly: false },
  ];

  test('R3-14 FAILED (held): undo spanning a category delete whose reassign touched entries that were LATER edited', async () => {
    await boot(board({ notes: NOTES() }));
    store.apply('deleteCategoryReassign', { id: 'c1', targetId: 'c2', noteIds: ['n1', 'n2'], barIds: [], lastCategoryId: 'c2' });
    quiet();
    store.apply('editNotePopover', { id: 'n1', text: 'a-edited' }); quiet();
    store.apply('recategoriseNote', { id: 'n2', categoryId: 'c2' }); quiet();

    store.undo(); quiet();                       // the recategorise
    store.undo(); quiet();                       // the text edit
    assert.deepEqual(store.state.notes.map((n) => n.text), ['a', 'b']);
    store.undo(); quiet();                       // the delete-with-reassign, N+1 registers, one gid
    assert.deepEqual(store.state.categories.map((c) => c.id), ['c1', 'c2'], 'the category is resurrected');
    assert.deepEqual(store.state.notes.map((n) => n.categoryId), ['c1', 'c1'], 'and every reassigned entry goes back');
    assert.equal(store.state.settings.lastCategoryId, 'c2', 'rule U6 — the [L] pref is NOT undone, v1 verbatim');

    store.redo(); store.redo(); store.redo(); quiet();
    assert.deepEqual(store.state.categories.map((c) => c.id), ['c2']);
    assert.deepEqual(store.state.notes.map((n) => n.text), ['a-edited', 'b']);
  });

  test('R3-15 FAILED (held): undo after an import is refused, and the retraction list reaches the publisher', async () => {
    await boot(board({ notes: NOTES() }));
    store.apply('editNotePopover', { id: 'n1', text: 'changed' }); quiet();
    assert.equal(store.canUndo(), true);
    store.replaceAll(board({ notes: [{ id: 'm1', date: '2026-06-01', text: 'importiert', categoryId: 'c1', repeatsYearly: false }] }));
    quiet();
    assert.equal(store.canUndo(), false, 'rule U10 — import clears history (5.4)');
    assert.equal(store.undo(), false);
    assert.deepEqual(store.state.notes.map((n) => n.text), ['importiert']);
    assert.ok(Array.isArray(store.publisher.pendingRetractions), 'the WP-3 obligation seam is wired');
  });

  test('R3-16 FAILED (held): redo after a snapshot restore is refused', async () => {
    await boot(board({ notes: NOTES() }));
    store.snapshots = [{ day: '2026-08-26', at: '2026-08-26T10:00:00Z', state: board({ notes: [{ id: 's1', date: '2026-01-02', text: 'gestern', categoryId: 'c1', repeatsYearly: false }] }) }];
    store.apply('editNotePopover', { id: 'n1', text: 'heute' }); quiet();
    store.undo(); quiet();
    assert.equal(store.canRedo(), true);
    assert.equal(store.restoreSnapshot('2026-08-26'), true);
    quiet();
    assert.equal(store.canRedo(), false);
    assert.equal(store.redo(), false);
    assert.deepEqual(store.state.notes.map((n) => n.text), ['gestern']);
  });

  test('R3-17 FAILED (held): undo after a remote fold restores my field and does not throw the shadow assertion', async () => {
    await boot(board({ notes: NOTES() }));
    store.apply('editNotePopover', { id: 'n1', text: 'meins' }); quiet();
    // My own other Mac writes a DIFFERENT field of the same note.
    store.applyRemote([noteSet(remoteCtx({ id: pad22('rm2') }), 'n1', { date: '2026-07-07' })]);
    quiet();
    assert.equal(store.state.notes.find((n) => n.id === 'n1').date, '2026-07-07');
    assert.equal(store.undoStack.length, 1, 'rule U2 — applyRemote touches neither stack');
    assert.equal(store.undo(), true, 'and the shadow expectation was retired rather than fired');
    quiet();
    const n1 = store.state.notes.find((n) => n.id === 'n1');
    assert.equal(n1.text, 'a', 'my text is restored …');
    assert.equal(n1.date, '2026-07-07', '… and the concurrent write to another field rightly survives (18.5)');
  });

  test('R3-18 FAILED (held): undo of a create whose entry was already deleted by a later action', async () => {
    await boot();
    store.apply('createNoteInline', { id: 'x1', date: '2026-03-04', text: 'neu', categoryId: 'c1' }); quiet();
    store.apply('deleteNotePopover', { id: 'x1' }); quiet();
    store.undo(); quiet();
    assert.deepEqual(store.state.notes.map((n) => n.text), ['neu'], '18.6 — undo of a delete resurrects');
    store.undo(); quiet();
    assert.equal(store.state.notes.length, 0, 'and undo of the create un-creates');
    store.redo(); quiet();
    assert.deepEqual(store.state.notes.map((n) => n.text), ['neu'], 'redo brings back the newest content');
  });

  test('R3-19 FAILED (held): export → import → export is a fixed point', async () => {
    await boot(board({ notes: NOTES(), scratchpads: { '2026-05': 'Mai', '2026-03': 'März' } }));
    const e1 = store.exportJSON();
    store.replaceAll(JSON.parse(e1)); quiet();
    const e2 = store.exportJSON();
    store.replaceAll(JSON.parse(e2)); quiet();
    assert.equal(e1, e2);
    assert.equal(e2, store.exportJSON());
  });
});
