// ─────────────────────────────────────────────────────────────────────────────
// ATTACK SUITE — v1 FIDELITY
//
// The retrofit's promise is "v1 behaves identically". These tests attack that
// promise by running the SHIPPING core (src/js/core/*) beside the ACTUAL v1
// store (src/js/store.js, unmodified) and looking for behaviours the op model
// silently changes.
//
// Rules: no npm, node:test only, no edits to any v1 file, no edits to the
// characterization suite. Every attack that "succeeds" is a defect in core or a
// retrofit blocker; every attack that "fails" is recorded as evidence that the
// defence held.
//
// Naming: ATT-n in the test title maps to the JSON report.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { localStorage as LS, resetStorage, seedBoard } from '../helpers/env.js';
// v1 = the FROZEN baseline store (`66126e9`), which is what this file's header means by
// "the ACTUAL v1 store … unmodified". WP-3 modified `src/js/store.js`; it did not modify v1.
import { store, defaultState } from '../fixtures/v1-store-frozen.js';
import { buildBoard, visibleStart } from '../../src/js/layout.js';
import { PALETTE } from '../../src/js/palette.js';

import * as coreOps from '../../src/js/core/ops.js';
import * as coreUndo from '../../src/js/core/undo.js';
import * as coreMat from '../../src/js/core/materialize.js';
import * as coreMig from '../../src/js/core/migrate1to2.js';
import * as coreReg from '../../src/js/core/registers.js';
import * as coreEnt from '../../src/js/core/entities.js';
import * as coreOplog from '../../src/js/core/oplog.js';
import * as coreAuthz from '../../src/js/core/authz.js';
import * as coreStamp from '../../src/js/core/stamp.js';
import * as coreReplace from '../../src/js/core/replace.js';
import * as coreDev from '../../src/js/core/dev.js';

const { migrateV1 } = coreMig;
const { materialize, stripV2Fields } = coreMat;
const { createUndoStacks, makeTx, shadowContent } = coreUndo;
const { createOpLog, APPEND } = coreOplog;
const { createClock } = coreStamp;
const { PERSONAL_PLACEHOLDER, buildMutation, catSet, noteSet, barSet, padSet, prefSet } = coreOps;

// ═════════════════════════════════════════════════════════════════════════════
// Harness
// ═════════════════════════════════════════════════════════════════════════════

const pad22 = (s) => (s + 'x'.repeat(22)).slice(0, 22);
const ME = `mem_${pad22('ME')}`;
const DEV = `dev_${pad22('MEDESKTOP')}`;
const SHORT = 'MEDESKTOP0000000'.replace(/[ILOU]/g, '0');   // Crockford base32
const BASE_MS = 1787836800000;

function fakeWall(start = BASE_MS) {
  let ms = start;
  return { now: () => ms, advance(d) { ms += d; return ms; } };
}

/** Deterministic id source — no CSPRNG, no clock, so a failure replays. */
function counterIds() {
  let n = 0;
  return () => pad22(`z${++n}`);
}

/**
 * ADR 001 §7.1 wired to the shipping modules — the same reference the WP-1
 * integration test uses, reproduced here so this file is self-contained and so
 * an attack cannot be blamed on a bespoke store.
 */
class OpStore {
  constructor(opts = {}) {
    this.act = ME;
    this.dev = DEV;
    this.wall = opts.wall ?? fakeWall();
    this.clock = createClock(SHORT, this.wall.now);
    this.next = counterIds();
    this.log = createOpLog({ now: this.wall.now });
    this.events = [];
    this.stacks = createUndoStacks({
      act: this.act,
      dev: this.dev,
      mint: () => this.clock.tick(),
      newOpId: () => this.next(),
      newGid: () => this.next(),
      space: PERSONAL_PLACEHOLDER,
      limitGroups: opts.limitGroups,
      // `?? false` removed for ATT-96: the harness must inherit the process-wide DEV default
      // (`createUndoStacks` uses `cfg.shadow ?? DEV`), or arming the flag changes nothing for the
      // suites that matter most. An explicit `opts.shadow` still wins in both directions.
      shadow: opts.shadow,
    });
    this.state = null;
    this._materialize();
  }

  ctx() {
    return {
      act: this.act,
      dev: this.dev,
      mint: () => this.clock.tick(),
      newOpId: () => this.next(),
      newGid: () => this.next(),
      space: PERSONAL_PLACEHOLDER,
      // ATT-88 — the register view the delete constructors consult before tombstoning. A real
      // retrofitted mutate site has it (it is the same RegisterMap `makeTx` reads), so the
      // harness carries it too; without it the existence gate cannot judge and never fires.
      regs: this.log.registers(),
    };
  }

  _materialize() {
    this.state = materialize(this.log.registers(), {
      me: this.act,
      familySpaceId: null,
      members: new Map(),
      currentMembers: new Set([this.act]),
      hiddenMembers: new Set(),
      defaultSettings: defaultState().settings,
    });
    return this.state;
  }

  emit(reason) { this.events.push(reason); }

  txn(label, fn) {
    const regs = this.log.registers();
    const tx = makeTx({ state: this.state, regs, ...this.ctx() });
    const r = fn(tx);
    if (r === false || tx.ops.length === 0) return r;   // store.js:150, verbatim
    const { pre, post } = tx.images();
    const shadow = this.stacks.shadowArmed ? shadowContent(this.state) : undefined;
    for (const op of tx.ops) this.log.append(op);
    this._materialize();
    this.stacks.push(tx.gid, label, pre, post, shadow);
    this.emit(label);
    return r;
  }

  /** Emit a prebuilt op group (the shape a retrofitted mutate site produces). */
  group(label, ops) {
    const before = this.state;
    const regs = this.log.registers();
    const { pre, post } = coreUndo.captureImages(regs, ops, { me: this.act });
    for (const op of ops) {
      const res = this.log.append(op);
      assert.equal(res.status, APPEND.APPENDED, `${op.e} ${op.id}: ${res.status} ${res.reason ?? ''}`);
    }
    this._materialize();
    const gid = ops.length ? ops[0].gid : this.next();
    const pushed = this.stacks.push(gid, label, pre, post,
      this.stacks.shadowArmed ? shadowContent(before) : undefined);
    this.emit(label);
    return pushed;
  }

  undo() {
    const ops = this.stacks.undo(this.state);
    if (!ops.length) return false;
    for (const op of ops) this.log.append(op);
    this._materialize();
    this.stacks.verify(this.state);
    this.emit('undo');
    return true;
  }

  redo() {
    const ops = this.stacks.redo(this.state);
    if (!ops.length) return false;
    for (const op of ops) this.log.append(op);
    this._materialize();
    this.stacks.verify(this.state);
    this.emit('redo');
    return true;
  }

  canUndo() { return this.stacks.canUndo(); }
  canRedo() { return this.stacks.canRedo(); }

  seed(ops) {
    for (const op of ops) {
      const res = this.log.append(op);
      assert.equal(res.status, APPEND.APPENDED, `${op.e}: ${res.status} ${res.reason ?? ''}`);
    }
    this._materialize();
    return this;
  }

  /** One group of ops built through the real MUTATIONS table. */
  mut(name, args, label) {
    const ctx = this.ctx();
    ctx.gid = this.next();
    const ops = buildMutation(name, ctx, args);
    return this.group(label ?? coreOps.mutation(name).label, ops);
  }
}

// `acceptLossy` is the acknowledgement ATT-82's fix requires: a migration that loses something
// throws unless the caller either takes the report (`onLossy`) or says this. The harness says it
// so that the attacks below can keep destructuring; ATT-82 tests the gate itself, without it.
const MIG_CTX = { memberId: ME, deviceId: DEV, acceptLossy: true };

/** A migrated OpStore over a v1 board object. */
function opStoreFrom(board, opts = {}) {
  const { ops, warnings, lossy } = migrateV1(board, MIG_CTX);
  const s = new OpStore(opts);
  s.seed(ops);
  return { s, ops, warnings, lossy };
}

/** Put the v1 singleton back to a known world (same lever the char suite uses). */
async function freshV1(board) {
  resetStorage();
  if (board) seedBoard(board);
  store.undoStack.length = 0;
  store.redoStack.length = 0;
  store.snapshots.length = 0;
  store._lastSnapshotDay = null;
  store.ready = false;
  store.listeners.clear();
  await store.init();
  return store;
}

/** Kill v1's 700 ms autosave timer so node --test can exit. */
after(() => { clearTimeout(store._saveTimer); });

const CATS = () => [
  { id: 'cat-1', name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true },
  { id: 'cat-2', name: 'Familie', nameEn: 'Family', paletteRef: 'gruen', visible: true },
];

function v1board(patch = {}) {
  const d = defaultState();
  return {
    schemaVersion: 1,
    notes: patch.notes ?? [],
    bars: patch.bars ?? [],
    categories: patch.categories ?? CATS(),
    scratchpads: patch.scratchpads ?? {},
    settings: { ...d.settings, startMonth: '2026-01', mode: 'pinned', lastCategoryId: 'cat-1', ...(patch.settings || {}) },
  };
}

const note = (id, date, text, extra = {}) => ({ id, date, text, categoryId: 'cat-1', repeatsYearly: false, ...extra });
const bar = (id, s, e, label, extra = {}) => ({ id, startDate: s, endDate: e, label, categoryId: 'cat-1', ...extra });

const catOf = (st, id) => st.categories.find((c) => c.id === id);
const noteOf = (st, id) => st.notes.find((n) => n.id === id);

// ═════════════════════════════════════════════════════════════════════════════
// ATT-1 … ATT-6 — undo / redo mechanics against the real v1 store
// ═════════════════════════════════════════════════════════════════════════════

describe('undo machinery', () => {
  test('ATT-1 the 50-step limit: v1 caps at 50 mutations, core caps at 50 GROUPS', async () => {
    // v1 oracle
    await freshV1(v1board());
    for (let i = 0; i < 60; i++) {
      store.mutate('add', (s) => { s.notes.push({ id: `n${i}`, date: '2026-03-01', text: `t${i}`, categoryId: 'cat-1', repeatsYearly: false }); });
    }
    assert.equal(store.undoStack.length, 50, 'v1 keeps exactly 50');
    let n = 0;
    while (store.undo()) n++;
    assert.equal(n, 50);
    // v1 dropped the ten oldest, so ten notes survive an exhausted undo stack
    assert.equal(store.state.notes.length, 10);

    // core
    const { s } = opStoreFrom(v1board());
    for (let i = 0; i < 60; i++) {
      s.mut('createNoteInline', { id: `n${i}`, date: '2026-03-01', text: `t${i}`, categoryId: 'cat-1' });
    }
    assert.equal(s.stacks.size().undo, 50, 'core keeps exactly 50 groups');
    let m = 0;
    while (s.undo()) m++;
    assert.equal(m, 50);
    assert.equal(s.state.notes.length, 10, 'the ten oldest creates are equally unreachable');
  });

  test('ATT-2 one user action with N+1 ops is ONE undo step (4.4 fan-out)', async () => {
    const board = v1board({
      notes: [note('n1', '2026-03-01', 'a'), note('n2', '2026-03-02', 'b')],
      bars: [bar('b1', '2026-03-01', '2026-03-10', 'x')],
    });
    // v1
    await freshV1(board);
    const before = JSON.stringify(store.state.notes);
    store.mutate('delete-category', (s) => {
      for (const x of s.notes) if (x.categoryId === 'cat-1') x.categoryId = 'cat-2';
      for (const x of s.bars) if (x.categoryId === 'cat-1') x.categoryId = 'cat-2';
      s.categories = s.categories.filter((y) => y.id !== 'cat-1');
    });
    assert.equal(store.undoStack.length, 1);
    assert.equal(store.undo(), true);
    assert.equal(JSON.stringify(store.state.notes), before);
    assert.equal(store.state.categories.length, 2);

    // core
    const { s } = opStoreFrom(board);
    const beforeCore = JSON.stringify(stripV2Fields(s.state));
    s.mut('deleteCategoryReassign', { id: 'cat-1', targetId: 'cat-2', noteIds: ['n1', 'n2'], barIds: ['b1'] });
    assert.equal(s.stacks.size().undo, 1, 'the fan-out is one group');
    assert.equal(s.state.categories.length, 1);
    assert.equal(s.undo(), true);
    assert.equal(JSON.stringify(stripV2Fields(s.state)), beforeCore,
      'one undo restores every reassigned entry AND the category, at its original position');
  });

  test('ATT-3 declined transactions touch nothing — and the redo branch survives', () => {
    const { s } = opStoreFrom(v1board({ notes: [note('n1', '2026-03-01', 'a')] }));
    s.mut('editNoteInline', { id: 'n1', text: 'b' });
    assert.equal(s.undo(), true);
    assert.equal(s.canRedo(), true);

    // `fn` returns false — store.js:150 verbatim
    const r = s.txn('declined', () => false);
    assert.equal(r, false);
    assert.equal(s.canRedo(), true, 'a declined mutation must not drop the redo branch');
    assert.equal(s.stacks.size().undo, 0);

    // zero ops emitted
    const r2 = s.txn('empty', () => {});
    assert.equal(r2, undefined);
    assert.equal(s.canRedo(), true);
    assert.equal(s.events.filter((e) => e === 'declined' || e === 'empty').length, 0,
      'neither decline was broadcast');
  });

  test('ATT-4 a new mutation clears redo; applyRemote-style folds must not', () => {
    const { s } = opStoreFrom(v1board({ notes: [note('n1', '2026-03-01', 'a')] }));
    s.mut('editNoteInline', { id: 'n1', text: 'b' });
    s.undo();
    assert.equal(s.canRedo(), true);
    s.mut('editNoteInline', { id: 'n1', text: 'c' });
    assert.equal(s.canRedo(), false, 'v1: redoStack.length = 0 on every accepted mutate');
  });

  test('ATT-5 RESOLVED: v1 records a step for a falsy-but-not-false return; core declines, on purpose', async () => {
    // Was filed as a contradiction with no owner. It is now a RECORDED DECISION: the core rule
    // wins and v1's is not preserved. `src/js/core/undo.js`'s push() carries the reasoning, and
    // the v1 characterization suite's assertion (tests/tier1/store-persistence.test.js, "only a
    // strict `false` declines") was narrowed to the half both stores agree on. Both halves of
    // this test therefore still assert current, intended behaviour — the divergence is the point.
    await freshV1(v1board());
    store.mutate('falsy', () => 0);
    assert.equal(store.canUndo(), true, 'v1: only a strict false declines — it never asks whether anything changed');

    const { s } = opStoreFrom(v1board());
    s.txn('falsy', () => 0);
    assert.equal(s.canUndo(), false, 'core: emitting zero undoable ops IS the decline, and it is load-bearing');
    // …and the decline leaves the rest of the world exactly as it found it (rule U2 stands).
    assert.equal(s.canRedo(), false);
    assert.equal(s.log.registers().size > 0, true, 'the seeded board is untouched, not cleared');
  });

  test('ATT-6 settings written inside a group are NOT undone (5.4) — both stores', async () => {
    const board = v1board();
    await freshV1(board);
    store.mutate('create-note', (s) => {
      s.notes.push({ id: 'n9', date: '2026-03-01', text: 'x', categoryId: 'cat-2', repeatsYearly: false });
      s.settings.lastCategoryId = 'cat-2';
    });
    store.undo();
    assert.equal(store.state.notes.length, 0);
    assert.equal(store.state.settings.lastCategoryId, 'cat-2', 'v1: settings survive ⌘Z');

    const { s } = opStoreFrom(board);
    s.mut('createNoteInline', { id: 'n9', date: '2026-03-01', text: 'x', categoryId: 'cat-2', lastCategoryId: 'cat-2' });
    assert.equal(s.state.settings.lastCategoryId, 'cat-2');
    s.undo();
    assert.equal(s.state.notes.length, 0);
    assert.equal(s.state.settings.lastCategoryId, 'cat-2', 'core: the pref op is outside the group');
  });

  test('ATT-7 auto-unhide (4.6) is inside the group and IS undone with it', async () => {
    const cats = CATS();
    cats[1].visible = false;
    const board = v1board({ categories: cats });

    await freshV1(board);
    store.mutate('create-note', (s) => {
      store.ensureVisible('cat-2');
      s.notes.push({ id: 'n1', date: '2026-03-01', text: 'x', categoryId: 'cat-2', repeatsYearly: false });
    });
    assert.equal(catOf(store.state, 'cat-2').visible, true);
    store.undo();
    assert.equal(catOf(store.state, 'cat-2').visible, false, 'v1 rolls the unhide back with the create');

    const { s } = opStoreFrom(board);
    s.txn('create-note', (tx) => {
      const unhid = tx.ensureVisible('cat-2');
      assert.equal(unhid, true);
      tx.note('n1').create({ date: '2026-03-01', text: 'x', categoryId: 'cat-2', repeatsYearly: false, visibility: 'privat', coEdit: false });
    });
    assert.equal(catOf(s.state, 'cat-2').visible, true);
    assert.equal(s.stacks.size().undo, 1, 'the unhide is in the same group');
    s.undo();
    assert.equal(catOf(s.state, 'cat-2').visible, false);
    assert.equal(s.state.notes.length, 0);
  });

  test('ATT-8 undo of a delete restores the entry at its ORIGINAL array position', async () => {
    const board = v1board({
      notes: [note('n1', '2026-03-01', 'a'), note('n2', '2026-03-01', 'b'), note('n3', '2026-03-01', 'c')],
    });
    await freshV1(board);
    store.mutate('delete', (s) => { s.notes = s.notes.filter((n) => n.id !== 'n2'); });
    store.undo();
    assert.deepEqual(store.state.notes.map((n) => n.id), ['n1', 'n2', 'n3']);

    const { s } = opStoreFrom(board);
    s.mut('deleteNotePopover', { id: 'n2' });
    assert.deepEqual(s.state.notes.map((n) => n.id), ['n1', 'n3']);
    s.undo();
    assert.deepEqual(s.state.notes.map((n) => n.id), ['n1', 'n2', 'n3'],
      '_born is retained across the tombstone so the sort puts it back');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ATT-10 … ATT-13 — categories
// ═════════════════════════════════════════════════════════════════════════════

describe('categories', () => {
  test('ATT-10 per-language rename: a DE rename drops nameEn, and ⌘Z brings it back', async () => {
    const board = v1board();
    await freshV1(board);
    store.mutate('rename-category', (s) => {
      const x = s.categories.find((y) => y.id === 'cat-1');
      x.name = 'Büro'; delete x.nameEn;
    });
    assert.equal('nameEn' in catOf(store.state, 'cat-1'), false);
    store.undo();
    assert.equal(catOf(store.state, 'cat-1').nameEn, 'Work');

    const { s } = opStoreFrom(board);
    s.mut('renameCategory', { id: 'cat-1', lang: 'de', name: 'Büro' });
    assert.equal(catOf(s.state, 'cat-1').name, 'Büro');
    assert.equal('nameEn' in catOf(s.state, 'cat-1'), false, 'a null register is skipped in projection');
    s.undo();
    assert.equal(catOf(s.state, 'cat-1').nameEn, 'Work', 'the pre-image carried the old English name');
    assert.equal(catOf(s.state, 'cat-1').name, 'Arbeit');
  });

  test('ATT-11 an EN rename leaves the German name alone', () => {
    const { s } = opStoreFrom(v1board());
    s.mut('renameCategory', { id: 'cat-1', lang: 'en', name: 'Office' });
    assert.equal(catOf(s.state, 'cat-1').name, 'Arbeit');
    assert.equal(catOf(s.state, 'cat-1').nameEn, 'Office');
  });

  test('ATT-12 dangling categoryId repair: v1 rewrites at load, core repairs in projection', async () => {
    const board = v1board({ notes: [note('n1', '2026-03-01', 'a', { categoryId: 'ghost' })] });
    await freshV1(board);
    assert.equal(noteOf(store.state, 'n1').categoryId, 'cat-1', 'v1 migrate() repaired it');

    const { s } = opStoreFrom(board);
    assert.equal(noteOf(s.state, 'n1').categoryId, 'cat-1', 'core repaired it in the projection');
    // …but the LOG still says ghost, so an export of the register value differs from v1's file
    const reg = coreReg.getValue(s.log.registers(), 'note:n1', 'categoryId');
    assert.equal(reg, 'ghost', 'the repair is a projection invariant and never rewrites the log');
  });

  test('ATT-13 settings.lastCategoryId repair parity', async () => {
    const board = v1board({ settings: { lastCategoryId: 'ghost' } });
    await freshV1(board);
    assert.equal(store.state.settings.lastCategoryId, 'cat-1');
    const { s } = opStoreFrom(board);
    assert.equal(s.state.settings.lastCategoryId, 'cat-1');
  });

  test('ATT-14 CLOSED: migrateV1 back-fills a missing paletteRef exactly as v1 does', async () => {
    // INVERTED. The back-fill is now in `migrate1to2`, where it can still be deterministic:
    // `nextFreeRef([])` over an empty used-set is always `PALETTE[0].ref`, so v1's `store.js:88`
    // writes one fixed string and so does migration. Without it the legend row and every entry in
    // the category painted with `colorOf(undefined)`.
    const cats = CATS();
    delete cats[0].paletteRef;                      // hand-edited / very old file
    const board = v1board({ categories: cats });

    await freshV1(board);
    const v1cat = catOf(store.state, 'cat-1');
    assert.equal(v1cat.paletteRef, PALETTE[0].ref, 'store.js:88 back-fills with nextFreeRef([])');

    const { s, lossy, warnings } = opStoreFrom(board);
    assert.equal(catOf(s.state, 'cat-1').paletteRef, PALETTE[0].ref, 'and so does core');
    assert.equal(lossy, false, 'a repair is not a loss');
    assert.match(warnings.join('\n'), /back-filled/);
    assert.deepEqual(stripV2Fields(s.state).categories, store.state.categories);
  });

  test('ATT-15 CLOSED: an empty category array gets v1’s four defaults, at DERIVED ids', async () => {
    // INVERTED. The old reasoning — "inventing the four needs crypto.randomUUID() and two
    // migrations would then disagree (R12)" — had a right premise and a wrong conclusion: derive
    // the four ids instead of skipping a repair v1 performs on every load (`store.js:73`).
    // Skipping it produced a board v1 cannot produce and the v1 UI cannot survive:
    // `store.category(x)` returns undefined and `legend.js`/`popover.js` read `.paletteRef` off it.
    const board = v1board({ categories: [], notes: [note('n1', '2026-03-01', 'a')] });

    await freshV1(board);
    assert.equal(store.state.categories.length, 4, 'v1 migrate() falls back to defaultState().categories');
    assert.equal(store.state.notes[0].categoryId, store.state.categories[0].id);

    const { s, warnings, lossy } = opStoreFrom(board);
    assert.equal(s.state.categories.length, 4, 'core substitutes the same four');
    assert.equal(lossy, false);
    assert.ok(warnings.some((w) => /four default categories were substituted/.test(w)));
    assert.deepEqual(s.state.categories.map((c) => c.name), store.state.categories.map((c) => c.name));
    assert.deepEqual(s.state.categories.map((c) => c.paletteRef), store.state.categories.map((c) => c.paletteRef));
    // the downstream consequences are repaired too, because there is now something to repair TO
    assert.equal(s.state.notes[0].categoryId, s.state.categories[0].id, 'the dangling id resolves');
    assert.equal(s.state.settings.lastCategoryId, s.state.categories[0].id);
    assert.ok(stripV2Fields(s.state).categories[0].paletteRef, 'store.category(x) is never undefined');

    // R12: the invented ids are derived, so a second Mac invents the SAME four.
    const again = migrateV1(v1board({ categories: [], notes: [note('n1', '2026-03-01', 'a')] }),
      { memberId: ME, deviceId: 'dev_' + 'Z'.repeat(22), acceptLossy: true });
    assert.deepEqual(again.ops.map((o) => o.e), coreMig.migrateV1(
      v1board({ categories: [], notes: [note('n1', '2026-03-01', 'a')] }), MIG_CTX).ops.map((o) => o.e));
  });

  test('ATT-16 delete-with-reassign only moves entries that name the category exactly', () => {
    const { s } = opStoreFrom(v1board({
      notes: [note('n1', '2026-03-01', 'a'), note('n2', '2026-03-01', 'b', { categoryId: 'cat-2' })],
    }));
    s.mut('deleteCategoryReassign', { id: 'cat-1', targetId: 'cat-2', noteIds: ['n1'], barIds: [] });
    assert.equal(noteOf(s.state, 'n1').categoryId, 'cat-2');
    assert.equal(noteOf(s.state, 'n2').categoryId, 'cat-2');
    assert.equal(s.state.categories.length, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ATT-20 … — repeats (9.3 / 9.5)
// ═════════════════════════════════════════════════════════════════════════════

describe('repeat series (9.3, 9.5)', () => {
  const rep = note('r1', '2024-03-04', 'Geburtstag', { repeatsYearly: true });

  test('ATT-20 moving a repeat keeps the series year — core matches interact.js:330-334', async () => {
    const board = v1board({ notes: [rep] });
    await freshV1(board);
    store.mutate('move-note', (s) => {
      const n = s.notes.find((x) => x.id === 'r1');
      const anchorY = n.date.slice(0, 4);
      const tgt = { m: 9, d: 12 };
      n.date = `${anchorY}-09-12`;
      void tgt;
    });
    assert.equal(noteOf(store.state, 'r1').date, '2024-09-12');

    const { s } = opStoreFrom(board);
    const target = coreEnt.reanchorRepeat('2024-03-04', '2026-09-12');
    assert.equal(target, '2024-09-12');
    s.mut('moveNote', { id: 'r1', date: target });
    assert.equal(noteOf(s.state, 'r1').date, '2024-09-12');
    s.undo();
    assert.equal(noteOf(s.state, 'r1').date, '2024-03-04', 'and ⌘Z restores the anchor');
  });

  test('ATT-21 turning a repeat OFF must not move the anchor date', () => {
    const { s } = opStoreFrom(v1board({ notes: [rep] }));
    // v1: `x.repeatsYearly = !x.repeatsYearly; if (x.repeatsYearly) x.date = date;`
    s.mut('toggleRepeat', { id: 'r1', repeatsYearly: false });
    assert.equal(noteOf(s.state, 'r1').repeatsYearly, false);
    assert.equal(noteOf(s.state, 'r1').date, '2024-03-04', 'the anchor is untouched, exactly as v1');
  });

  test('ATT-22 turning a repeat ON anchors to the viewed occurrence, and ⌘Z restores BOTH fields', () => {
    const { s } = opStoreFrom(v1board({ notes: [note('p1', '2026-03-04', 'Zahnarzt')] }));
    s.mut('toggleRepeat', { id: 'p1', repeatsYearly: true, date: '2028-03-04' });
    assert.equal(noteOf(s.state, 'p1').repeatsYearly, true);
    assert.equal(noteOf(s.state, 'p1').date, '2028-03-04');
    s.undo();
    assert.equal(noteOf(s.state, 'p1').repeatsYearly, false);
    assert.equal(noteOf(s.state, 'p1').date, '2026-03-04', 'one op, two fields, one inverse');
  });

  test('ATT-23 delete and edit hit the whole series — there is exactly one entity', () => {
    const { s } = opStoreFrom(v1board({ notes: [rep] }));
    // 9.3: one object per series, so a delete on any occurrence removes every occurrence.
    const occ = coreEnt.noteOccurrences(s.state.notes, '2024-01-01', '2030-12-31');
    assert.ok(occ.size >= 6, 'the series projects into many years');
    s.mut('deleteNotePopover', { id: 'r1' });
    assert.equal(s.state.notes.length, 0);
    const occ2 = coreEnt.noteOccurrences(s.state.notes, '2024-01-01', '2030-12-31');
    assert.equal(occ2.size, 0);
  });

  test('ATT-24 the Feb-29 v1 quirk survives verbatim (a non-existent anchor date)', () => {
    // interact.js builds `iso(anchorY, 2, 29)` even when anchorY is not a leap year.
    assert.equal(coreEnt.reanchorRepeat('2023-01-05', '2028-02-29'), '2023-02-29');
    assert.equal(coreEnt.projectYearly('2023-02-29', 2025), '2025-02-28');
    // and the op layer accepts it (format, not calendar validity)
    const { s } = opStoreFrom(v1board({ notes: [note('q1', '2023-01-05', 'x', { repeatsYearly: true })] }));
    s.mut('moveNote', { id: 'q1', date: '2023-02-29' });
    assert.equal(noteOf(s.state, 'q1').date, '2023-02-29');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// settings / normalization
// ═════════════════════════════════════════════════════════════════════════════

describe('settings normalization', () => {
  test('ATT-30 CLOSED: "no Bundesland ⇒ schulferien off" (7.5) is a projection invariant', async () => {
    // FIXED in materialize.js `buildSettings`. This test asserted the defect: core carried the
    // un-normalised value forward forever, so a v1 invariant that v1 re-applies on EVERY
    // whole-board load (`replaceAll` → `migrate`, i.e. every import 11.3 and every snapshot
    // restore 11.5) survived in v2 only until the first import and was then gone.
    const board = v1board({ settings: { bundesland: '', layers: { feiertage: true, schulferien: true, otherStates: false, ferienPattern: false } } });

    await freshV1(board);
    assert.equal(store.state.settings.layers.schulferien, false, 'v1 normalises at EVERY load (store.js:90)');

    const { s } = opStoreFrom(board);
    assert.equal(s.state.settings.layers.schulferien, false, 'and so does core, on every projection');
    assert.equal(s.state.settings.bundesland, '');
    assert.deepEqual(s.state.settings, store.state.settings, 'byte for byte, v1 and core agree');

    // It is CONDITIONAL, not a permanent "off": with a Bundesland the authored value stands.
    const withState = v1board({ settings: { bundesland: 'BY', layers: { feiertage: true, schulferien: true, otherStates: false, ferienPattern: false } } });
    await freshV1(withState);
    const { s: s2 } = opStoreFrom(withState);
    assert.equal(s2.state.settings.layers.schulferien, true);
    assert.equal(store.state.settings.layers.schulferien, true);

    // THE PROJECTION-LEVEL CLAIM, which is the half a migration-time repair cannot make.
    // `migrate1to2.js` also normalises on the way in (7.5), so the assertions above would pass
    // even with `buildSettings` unchanged. This one cannot: it writes the layer ON, with no
    // Bundesland, through the REAL `pref.set` op — which is what `store.setLayer()` emits and
    // what an import or a snapshot restore replays — and re-materialises.
    const ctx = s.ctx();
    ctx.gid = null;
    s.log.append(coreOps.layerSet(ctx, { schulferien: true }));
    s._materialize();
    assert.equal(s.state.settings.layers.schulferien, false,
      'the invariant holds on EVERY projection, not only on the migration');
    // …and it is idempotent: re-materialising the same registers never changes the answer again.
    s._materialize();
    assert.equal(s.state.settings.layers.schulferien, false);
    // Setting a Bundesland releases it, with no further op — the register was never rewritten.
    s.log.append(coreOps.settingsSet(s.ctx(), { bundesland: 'BY' }));
    s._materialize();
    assert.equal(s.state.settings.layers.schulferien, true,
      'the register still says true; the projection was masking it, not overwriting it');
  });

  test('ATT-31 settings key order and shape match v1 exactly for a normal board', async () => {
    const board = v1board();
    await freshV1(board);
    const { s } = opStoreFrom(board);
    assert.deepEqual(Object.keys(s.state.settings), Object.keys(store.state.settings));
    assert.deepEqual(Object.keys(s.state.settings.layers), Object.keys(store.state.settings.layers));
    assert.deepEqual(s.state.settings, store.state.settings);
  });

  // ATT-32 — NOT A DEFECT. The attack's finding was that a pref register explicitly set to
  // `null` is indistinguishable from one never set, because both project to the v1 default. The
  // proposed repair was to make `prefSet` reject `null`. It is refused, and this row now pins the
  // behaviour as the CONTRACT so nobody applies that repair later. Two reasons, both PO-visible:
  //
  //  1. There is no third state to lose. Every pref has a default and the renderer needs a value
  //     (a board with no `rowHeight` does not render), so "cleared" and "default" are the same
  //     state by construction. The conflation would matter for a CONTENT field — ADR 004 §5.1
  //     needs `null` to mean redacted, distinct from absent, because an empty note text is a real
  //     value a user can write — and there `null` IS distinguished. Prefs are not content.
  //  2. It is load-bearing. `replace.js:buildPrefOp` (ADR 001 §8.5 step 5) writes `null` for
  //     every pref this device holds that the imported board does not carry, because v1's
  //     `replaceAll()` installs the settings object WHOLESALE — a key the file omits must revert
  //     to its default, not survive the import. Rejecting `null` in `prefSet` would silently
  //     change import and snapshot restore into a settings MERGE. That is the ATT-40 fix, and it
  //     would have been broken by the ATT-32 fix; the collision is the reason this is written out
  //     here and in `ops.js:FIELDS.pref` rather than settled twice in opposite directions.
  test('ATT-32 RESOLVED: null on a pref MEANS "back to the v1 default", and is the contract', () => {
    const { s } = opStoreFrom(v1board({ settings: { rowHeight: 30 } }));
    assert.equal(s.state.settings.rowHeight, 30);
    const ctx = s.ctx();
    ctx.gid = null;
    s.log.append(prefSet(ctx, { rowHeight: null }));
    s._materialize();
    assert.equal(s.state.settings.rowHeight, 22, 'a cleared pref projects as the v1 default');

    // The primitive accepts `null` deliberately — this is the assertion that fails if someone
    // applies the rejected repair, and the message says where to read why.
    assert.doesNotThrow(() => prefSet(s.ctx(), { rowHeight: null }),
      'prefSet must accept null: replace.js:buildPrefOp depends on it (ADR 001 §8.5 step 5)');

    // AND THE COUPLING ITSELF, so this cannot rot into a comment. A real §8.5 transaction over a
    // board that still HOLDS `rowHeight` (a fresh store — the one above has already cleared it)
    // whose incoming file omits the key must emit the clear.
    const { s: s2 } = opStoreFrom(v1board({ settings: { rowHeight: 30 } }));
    assert.equal(s2.state.settings.rowHeight, 30, 'precondition: this device holds a rowHeight');
    // `v1board()` spreads a COMPLETE settings object, so the key has to be removed for the file
    // to genuinely omit it — which is the case v1's whole-object replaceAll() has to handle.
    const incoming = v1board({ settings: { mode: 'rolling' } });
    delete incoming.settings.rowHeight;
    const plan = coreReplace.planReplaceAll(s2.log.registers(), incoming, {
      mint: () => s2.clock.tick(), me: ME, deviceId: DEV, personalSpaceId: null,
      newOpId: () => s2.next(), newGid: () => s2.next(),
    });
    const pref = plan.ops.find((o) => o.k === 'pref.set');
    assert.ok(pref, 'the import emits a pref.set');
    assert.equal(pref.f.rowHeight, null,
      'THE COUPLING: an omitted setting is CLEARED by the import, which is how it reverts to the '
      + 'v1 default — reject null in prefSet and this becomes a merge instead of a replace');

    // …and it really does revert on the board, not merely in the op.
    s2.group('replaceAll', plan.ops);
    s2._materialize();
    assert.equal(s2.state.settings.rowHeight, 22);

    // NOT VACUOUS — a setting the file DOES carry is written, not cleared, so the null above is
    // the omission being expressed and not `buildPrefOp` nulling everything in sight.
    assert.equal(pref.f.mode, 'rolling');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// import / snapshot restore (11.3, 11.5) — the §8.5 diff transaction
// ═════════════════════════════════════════════════════════════════════════════

describe('import and snapshot restore', () => {
  test('ATT-40 DEFENDED: replaceAllOps exists, and it is the §8.5 diff transaction', () => {
    // Was: "declared in the contract and implemented nowhere". It is now implemented in
    // `src/js/core/replace.js` — a NEW level-1 core module, because ADR 005 §1.1's tree has no
    // home for it (reported for an ADR amendment). The full behavioural suite is
    // `tests/tier1/core-replace.test.js`; what this attack re-runs is the three claims it made:
    // the primitive exists, it does not rewind the log, and it does not touch another member.
    const surface = new Set([coreMat, coreMig, coreOps, coreEnt, coreReg, coreUndo, coreAuthz, coreOplog,
      coreStamp, coreReplace].flatMap((m) => Object.keys(m)));
    assert.equal(surface.has('replaceAllOps'), true,
      'ATTACK DEFEATED: import (11.3) and snapshot restore (11.5) have their core primitive');
    assert.equal(typeof coreReplace.replaceAllOps, 'function');

    const { s, ops: genesis } = opStoreFrom(v1board({ notes: [note('n1', '2026-03-01', 'alt')] }));
    s.wall.advance(60_000);
    const incoming = v1board({ notes: [note('n2', '2026-04-01', 'importiert')] });
    const txn = coreReplace.replaceAllOps(s.log.registers(), incoming, {
      mint: () => s.clock.tick(),
      me: ME,
      deviceId: DEV,
      personalSpaceId: null,
      newOpId: () => s.next(),
      newGid: () => s.next(),
    });
    s.group('replaceAll', txn);

    assert.deepEqual(s.state.notes.map((n) => n.id), ['n2'], 'the imported board is what the board shows');
    // NOT A REWIND: the pre-import ops are still in the log and re-delivering one changes nothing,
    // because it LOST ON STAMP rather than having been erased. That is the property a
    // `board.reset` op could not have, and the reason ADR 001 §8.5 rejects one.
    const beforeReplay = JSON.stringify(coreReg.serializeRegisters(s.log.registers()));
    for (const op of genesis) s.log.append(op);
    s._materialize();
    assert.equal(JSON.stringify(coreReg.serializeRegisters(s.log.registers())), beforeReplay);
    assert.deepEqual(s.state.notes.map((n) => n.id), ['n2']);
    // AND IT IS PERSONAL + LOCAL ONLY (§8.5 step 5): nothing here is anybody else's to blank.
    for (const op of txn) {
      assert.equal(coreEnt.parseEntityKey(op.e).owner, null, `${op.e} names an owner`);
      assert.equal(Object.keys(op.f).some((f) => f.startsWith('pub.')), false, `${op.e} writes a pub.* field`);
    }
  });

  test('ATT-41 CLOSED: v1’s migrate() repairs are reproduced on the way into the op log', async () => {
    // A snapshot or an exported file from an older build. v1 repairs all of it on the way in.
    const dirty = {
      schemaVersion: 1,
      notes: [note('n1', '2026-03-01', 'a', { categoryId: 'ghost' })],
      bars: [],
      categories: [{ id: 'c9', name: 'Alt' }],                 // no paletteRef, no visible
      scratchpads: {},
      settings: { bundesland: '', layers: { schulferien: true } },
    };
    await freshV1(v1board());
    store.replaceAll(structuredClone(dirty));
    assert.equal(store.state.notes[0].categoryId, 'c9', 'repaired against the surviving category');
    assert.equal(store.state.categories[0].paletteRef, PALETTE[0].ref);
    assert.equal(store.state.settings.layers.schulferien, false);
    assert.equal(store.canUndo(), false, 'and both stacks are cleared (5.4)');

    // INVERTED. v1's four migrate() repairs are now all reproduced: the paletteRef back-fill,
    // the default-category substitution and the lastCategoryId repair in `migrate1to2` (where
    // they can still be deterministic), the dangling categoryId in the §5 step 7 projection
    // (where it is idempotent and survives a category deleted concurrently with an entry created
    // in it). `palette.js` is NOT imported — `nextFreeRef([])` is always `PALETTE[0].ref`, so the
    // back-fill is one frozen constant in core, pinned to v1's own computation by a tier-1 test.
    const { ops, warnings, lossy } = migrateV1(structuredClone(dirty), MIG_CTX);
    const regs = coreReg.fold(ops);
    const st = materialize(regs, { me: ME, familySpaceId: null, currentMembers: new Set([ME]), defaultSettings: defaultState().settings });
    assert.equal(st.categories[0].paletteRef, PALETTE[0].ref, 'paletteRef back-filled, as v1 does');
    assert.equal(st.notes[0].categoryId, 'c9', 'the dangling categoryId resolves as v1 resolved it');
    assert.equal(st.settings.layers.schulferien, false, 'ATT-30: normalised by buildSettings');
    assert.equal(lossy, false, 'a repair is not a loss');
    assert.ok(warnings.some((w) => /back-filled/.test(w)), warnings.join(' | '));
    // …and the whole board matches v1's own answer, field for field
    assert.deepEqual(stripV2Fields(st).categories, store.state.categories);
    assert.deepEqual(stripV2Fields(st).notes, store.state.notes);
    assert.deepEqual(stripV2Fields(st).settings, store.state.settings);
    // What ATT-41 pointed at that is STILL open is the TRANSACTION, not the repair: §8.5's
    // `replaceAllOps` has no implementation (ATT-40), so nothing calls this on an import yet.
  });

  test('ATT-42 snapshots.json is returned by reference and carries no ops — restore is unimplemented', () => {
    const snaps = [{ day: '2026-08-01', at: '2026-08-01T09:00:00.000Z', state: v1board() }];
    const out = coreMig.migrateSnapshots(snaps);
    assert.equal(out.snapshots, snaps, 'byref, untouched — 11.5 stays v1-shaped');
    assert.deepEqual(out.ops, [], 'and there is no op form of a restore');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// shape / order of the materialized state
// ═════════════════════════════════════════════════════════════════════════════

describe('state shape', () => {
  test('ATT-50 CLOSED: ADR §8.3\'s acceptance criterion holds on a board whose bars are NOT pre-sorted', async () => {
    // FIXED in entities.js: `cmpBars` is `(_born asc, id asc)`, like `cmpNotes` and
    // `cmpCategories`. It used to be `(startDate asc, endDate desc, id asc)`, which threw away
    // the v1 array index that `_born = GENESIS(i)` carries (ADR 001 §8.1) and made §8.3's
    // "deep-equals … for every field INCLUDING array order" FALSE for this board.
    //
    // ADR CORRECTION for the pass that amends the text: ADR 001 §5 step 5 still specifies the
    // date comparator for bars; it must be amended to `(_born asc, id asc)`.
    const board = v1board({
      notes: [note('n1', '2026-03-04', 'Zahnarzt'), note('n2', '2026-05-01', 'Yoga', { categoryId: 'cat-2' })],
      bars: [bar('b1', '2026-02-10', '2026-04-20', 'Projekt'), bar('b2', '2026-01-05', '2026-01-09', 'Sprint')],
      scratchpads: { '2026-03': 'Milch', '2026-01': 'Vorsätze' },
    });
    // The fixture must remain capable of failing: b1 starts AFTER b2, so file order and date
    // order disagree. If somebody "tidies" these two lines, this test stops proving anything.
    assert.ok(board.bars[0].startDate > board.bars[1].startDate,
      'the fixture bars are in date order — this test can no longer fail');

    await freshV1(board);
    const { s } = opStoreFrom(board);
    const got = stripV2Fields(s.state);
    const want = { ...store.state, schemaVersion: 1 };

    // The WHOLE board, in one assertion. That is the acceptance criterion, verbatim.
    assert.deepEqual(got, want);
    assert.deepEqual(got.bars.map((b) => b.id), ['b1', 'b2'], 'v1 file order, preserved');
  });

  test('ATT-51 CLOSED: entry KEY ORDER matches v1 — board.json stays diffable (11.4)', async () => {
    // FIXED in materialize.js `projectCells`, which now seeds the projected object with `{ id }`
    // before the field loop. `id` used to be assigned in the decoration pass and therefore landed
    // LAST, so every entry in `board.json` changed shape on upgrade day and a byte-wise diff of
    // two exports was unreadable — which is what 11.4 promises it stays.
    const board = v1board({
      notes: [note('n1', '2026-03-04', 'Zahnarzt')],
      bars: [bar('b1', '2026-02-10', '2026-04-20', 'Projekt')],
    });
    await freshV1(board);
    const { s } = opStoreFrom(board);
    const v1state = stripV2Fields(s.state);
    assert.deepEqual(Object.keys(v1state.notes[0]), Object.keys(store.state.notes[0]));
    assert.deepEqual(Object.keys(v1state.notes[0]), ['id', 'date', 'text', 'categoryId', 'repeatsYearly']);
    assert.deepEqual(Object.keys(v1state.bars[0]), Object.keys(store.state.bars[0]));
    assert.deepEqual(Object.keys(v1state.categories[0]), Object.keys(store.state.categories[0]));
    // `id` is first on the UNDECORATED entry too — the v2 fields are appended, never interleaved.
    assert.equal(Object.keys(s.state.notes[0])[0], 'id');
    // The claim the story actually makes: v1's own serializer produces identical bytes.
    assert.equal(JSON.stringify(v1state.notes, null, 2), JSON.stringify(store.state.notes, null, 2));
    assert.equal(JSON.stringify(v1state.bars, null, 2), JSON.stringify(store.state.bars, null, 2));
  });

  test('ATT-52 CLOSED: bar ARRAY ORDER is v1 file order, and the render is unchanged', async () => {
    // The user-visible half of ATT-50. Array order is not cosmetic: `layout.js` slices to
    // capacity (:209) and rescues lanes per column (:162-177), and the label-row pass follows
    // array order — so a re-sort moved a long bar's label to a different row on upgrade day.
    const board = v1board({
      bars: [bar('b1', '2026-05-01', '2026-05-10', 'later'), bar('b2', '2026-01-01', '2026-01-10', 'earlier')],
    });
    await freshV1(board);
    assert.deepEqual(store.state.bars.map((b) => b.id), ['b1', 'b2'], 'v1 keeps file order');
    const { s } = opStoreFrom(board);
    assert.deepEqual(s.state.bars.map((b) => b.id), ['b1', 'b2'], 'and so does core');
    // and the REAL layout agrees, column for column — nothing moves on the board
    const a = buildBoard(store.state);
    const b = buildBoard(stripV2Fields(s.state));
    assert.equal(JSON.stringify(a.cols.map((c) => c.segs)), JSON.stringify(b.cols.map((c) => c.segs)));
    assert.equal(JSON.stringify(a.cols.map((c) => c.days)), JSON.stringify(b.cols.map((c) => c.days)));
    // The old comparator is genuinely not in use: it would have produced ['b2', 'b1'] here.
    assert.deepEqual(
      [...s.state.bars].sort((x, y) => (x.startDate < y.startDate ? -1 : 1)).map((x) => x.id),
      ['b2', 'b1'], 'the date order really is the opposite — the assertion above is not vacuous');
  });

  test('ATT-53 CLOSED: a note with no text key migrates as an empty string and stays on the board', async () => {
    // INVERTED. `popover.js:193` is `n.text || '…'`, so v1 draws the same row for an ABSENT text
    // and for an empty one. Migrating the absence AS `''` is therefore not an invention: it is
    // the value that makes the two builds render identically, and it keeps the note renderable
    // under §5 step 3 instead of deleting one of the user's entries on upgrade day.
    const board = v1board({ notes: [{ id: 'n1', date: '2026-03-04', categoryId: 'cat-1', repeatsYearly: false }] });
    await freshV1(board);
    assert.equal(store.state.notes.length, 1, 'v1 keeps it and popover.js:193 renders it as "…"');
    const model = buildBoard(store.state);
    const hit = model.cols.flatMap((c) => c.days).find((d) => !d.empty && d.date === '2026-03-04');
    assert.equal(hit.allNotes.length, 1, 'and it occupies a line on the board');

    const { s, lossy } = opStoreFrom(board);
    assert.equal(s.state.notes.length, 1, 'core keeps it too');
    assert.equal(s.state.notes[0].text, '');
    assert.equal(lossy, false, 'nothing was lost');
    const coreModel = buildBoard(stripV2Fields(s.state));
    const coreHit = coreModel.cols.flatMap((c) => c.days).find((d) => !d.empty && d.date === '2026-03-04');
    assert.equal(coreHit.allNotes.length, 1, 'and the same line, on the same day');
  });

  test('ATT-54 an EMPTY note text is a value, not an absence — parity holds', async () => {
    const board = v1board({ notes: [note('n1', '2026-03-04', '')] });
    await freshV1(board);
    const { s } = opStoreFrom(board);
    assert.equal(store.state.notes.length, 1);
    assert.equal(s.state.notes.length, 1, "'' is present; the defence held");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// scratchpad
// ═════════════════════════════════════════════════════════════════════════════

describe('scratchpad', () => {
  test('ATT-60 the untrimmed value is stored, whitespace deletes the key — parity', async () => {
    const board = v1board({ scratchpads: { '2026-03': 'Milch' } });
    await freshV1(board);
    store.mutate('pad', (s) => { s.scratchpads['2026-03'] = '  Brot  '; });
    assert.equal(store.state.scratchpads['2026-03'], '  Brot  ');
    store.mutate('pad', (s) => { delete s.scratchpads['2026-03']; });
    assert.equal('2026-03' in store.state.scratchpads, false);
    store.undo();
    assert.equal(store.state.scratchpads['2026-03'], '  Brot  ');

    const { s } = opStoreFrom(board);
    s.mut('padTyping', { month: '2026-03', text: '  Brot  ' });
    assert.equal(s.state.scratchpads['2026-03'], '  Brot  ');
    s.mut('padTyping', { month: '2026-03', text: '   ' });
    assert.equal('2026-03' in s.state.scratchpads, false);
    s.undo();
    assert.equal(s.state.scratchpads['2026-03'], '  Brot  ');
  });

  // ATT-61 — INVERTED, and it is the ATT-5 rule applied to the eighth phantom-register path.
  //
  // The finding was parity: blanking a scratchpad for a month that never had one records an undo
  // step in BOTH stores. v1's half is real and stays asserted below — `mutate()` asks only
  // `r === false` (store.js:150) and never whether the callback changed anything, so it pushes a
  // step whose pre-image equals its post-image: a ⌘Z that undoes nothing visible.
  //
  // v2 no longer matches it, on purpose, and this is the same decision recorded at ATT-5 and at
  // ATT-88. Matching would require `padOps` to mint a `pad:2026-04` register for a month with no
  // scratchpad — a permanent phantom that the family relay then syncs to every sibling device and
  // that nothing ever cleans up, because §5 step 3 hides it from the board. v1 could afford the
  // gesture (`delete` on a missing key is a real no-op); a log cannot. So the constructor
  // declines, and "zero ops" carries the decline exactly as rule U6 and the ATT-88 gate use it.
  //
  // THE USER-VISIBLE DIFFERENCE, stated plainly for the PO: after clicking into an empty
  // scratchpad and clicking out again, v1 offers a ⌘Z that does nothing and v2 offers none.
  test('ATT-61 RESOLVED: v1 records an empty undo step for a no-op pad commit; v2 declines', async () => {
    const board = v1board();
    await freshV1(board);
    // v1: `(s.scratchpads[key] || '') === val` is false for '   ', so it does NOT decline
    store.mutate('pad', (s) => {
      if ((s.scratchpads['2026-04'] || '') === '   ') return false;
      delete s.scratchpads['2026-04'];
    });
    assert.equal(store.canUndo(), true, 'v1 records a step that changed nothing');

    const { s } = opStoreFrom(board);
    s.mut('padTyping', { month: '2026-04', text: '   ' });
    assert.equal(s.canUndo(), false, 'v2 declines rather than stack a ⌘Z that undoes nothing');
    assert.deepEqual(s.state.scratchpads, {});
    // THE POINT OF THE GATE: no phantom register was minted for a month that never had a pad.
    assert.equal(s.log.registers().has('pad:2026-04'), false, 'and no phantom pad: register exists');

    // NOT VACUOUS — a month that DOES have a scratchpad still clears, still records a step, and
    // ⌘Z still brings the text back. The gate is an existence test, not a refusal to clear pads.
    const { s: s2 } = opStoreFrom(v1board({ scratchpads: { '2026-04': 'Milch' } }));
    s2.mut('padTyping', { month: '2026-04', text: '   ' });
    assert.deepEqual(s2.state.scratchpads, {}, 'a real scratchpad is cleared as before');
    assert.equal(s2.canUndo(), true);
    s2.undo();
    assert.deepEqual(s2.state.scratchpads, { '2026-04': 'Milch' }, 'and ⌘Z restores it');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// undo-image edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe('undo images', () => {
  test('ATT-70 clearing a note text deletes it, and ⌘Z restores every field', () => {
    const { s } = opStoreFrom(v1board({
      notes: [note('n1', '2026-03-04', 'Zahnarzt', { categoryId: 'cat-2', repeatsYearly: true })],
    }));
    const before = JSON.stringify(stripV2Fields(s.state).notes);
    s.mut('editNoteInline', { id: 'n1', text: '' });
    assert.equal(s.state.notes.length, 0);
    s.undo();
    assert.equal(JSON.stringify(stripV2Fields(s.state).notes), before);
  });

  test('ATT-71 create → undo → redo → undo is stable', () => {
    const { s } = opStoreFrom(v1board());
    const empty = JSON.stringify(stripV2Fields(s.state));
    s.mut('createNoteInline', { id: 'n1', date: '2026-03-04', text: 'x', categoryId: 'cat-1' });
    const created = JSON.stringify(stripV2Fields(s.state));
    s.undo();
    assert.equal(JSON.stringify(stripV2Fields(s.state)), empty);
    s.redo();
    assert.equal(JSON.stringify(stripV2Fields(s.state)), created);
    s.undo();
    assert.equal(JSON.stringify(stripV2Fields(s.state)), empty);
    s.redo();
    assert.equal(JSON.stringify(stripV2Fields(s.state)), created);
  });

  test('ATT-72 the shadow-undo assertion is armed and agrees over a long random-ish session', () => {
    const board = v1board({
      notes: [note('n1', '2026-03-04', 'a'), note('n2', '2026-04-04', 'b', { categoryId: 'cat-2' })],
      bars: [bar('b1', '2026-02-01', '2026-03-01', 'x')],
      scratchpads: { '2026-03': 'p' },
    });
    const { s } = opStoreFrom(board, { shadow: true });
    const actions = [
      () => s.mut('editNoteInline', { id: 'n1', text: `t${Math.random().toString(36).slice(2, 6)}` }),
      () => s.mut('moveNote', { id: 'n2', date: '2026-04-11' }),
      () => s.mut('moveBar', { id: 'b1', startDate: '2026-02-05', endDate: '2026-03-05' }),
      () => s.mut('toggleCategory', { id: 'cat-2', visible: false }),
      () => s.mut('recolorCategory', { id: 'cat-1', paletteRef: 'rot' }),
      () => s.mut('padTyping', { month: '2026-03', text: 'pp' }),
      () => s.mut('renameCategory', { id: 'cat-1', lang: 'de', name: 'X' }),
    ];
    for (const a of actions) a();
    // full retrace, verified by the shadow assertion inside undo()
    while (s.undo());
    assert.deepEqual(stripV2Fields(s.state), { ...board, schemaVersion: 1 });
    while (s.redo());
    assert.equal(s.canRedo(), false);
  });

  test('ATT-73 push() with an image that is entirely pref/family records nothing AND spares redo', () => {
    const { s } = opStoreFrom(v1board({ notes: [note('n1', '2026-03-04', 'a')] }));
    s.mut('editNoteInline', { id: 'n1', text: 'b' });
    s.undo();
    assert.equal(s.canRedo(), true);
    const pushed = s.stacks.push(pad22('g0'), 'prefonly', [], [], undefined);
    assert.equal(pushed, false);
    assert.equal(s.canRedo(), true, 'v1 has no pref-only mutate site, so this is unobservable in v1');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ROUND 2 — export/import, synchronicity, remote folds, lossy fields
// ═════════════════════════════════════════════════════════════════════════════

describe('export and re-import (11.2, 11.3)', () => {
  test('ATT-80 CLOSED: the export seam produces a schemaVersion-1 file that re-imports', () => {
    // FIXED in materialize.js by exposing the seam: `toV1Board(state)` / `exportV1JSON(state)`.
    // v1's `exportJSON()` is `JSON.stringify(this.state, null, 2)` — the state VERBATIM — and
    // over a materialized state that wrote `schemaVersion: 2`, which `migrateV1` then refuses.
    // (The store.js CALL SITE is WP-3's; this proves the seam it must call exists and works.)
    const { s } = opStoreFrom(v1board({ notes: [note('n1', '2026-03-04', 'Zahnarzt')] }));

    // The old, verbatim export is still refused — that is why the store must not use it.
    const verbatim = JSON.parse(JSON.stringify(s.state));
    assert.equal(verbatim.schemaVersion, 2);
    assert.throws(() => migrateV1(verbatim, MIG_CTX), /already at schemaVersion 2/);

    // The seam. Same call shape as v1 (`JSON.stringify(board, null, 2)`), v1 bytes.
    const file = JSON.parse(coreMat.exportV1JSON(s.state));
    assert.equal(file.schemaVersion, 1);
    assert.equal(coreMat.exportV1JSON(s.state), JSON.stringify(coreMat.toV1Board(s.state), null, 2));
    // …and it re-imports, all the way back to an identical board.
    const { ops } = migrateV1(file, MIG_CTX);
    const back = new OpStore().seed(ops).state;
    assert.deepEqual(stripV2Fields(back), file, 'export → import → export is a fixed point');
  });

  test('ATT-81 CLOSED: the export seam leaks nothing — and the strip is TOTAL, not a list', () => {
    // 11.2 mails this file to somebody. The materialized entry carries `ownerId` (a MemberId),
    // `_born` (whose last 16 characters are this device's `deviceShort` fingerprint),
    // `entityKey` and `updatedBy`. `stripV2Fields` existed but was a hand-written BLACKLIST — a
    // list that silently stops being complete the day a field is added to `FIELDS`.
    //
    // It is now a whitelist over `V1_ENTRY_FIELDS`, and `V2_ENTRY_FIELDS` is DERIVED from the
    // `FIELDS` table. This test enumerates `FIELDS` too, so a register added next year is
    // covered here the day it is added rather than the day somebody remembers this file.
    const { s } = opStoreFrom(v1board({
      notes: [note('n1', '2026-03-04', 'Zahnarzt')],
      bars: [bar('b1', '2026-02-10', '2026-04-20', 'Projekt')],
    }));
    const n = s.state.notes[0];
    // The raw state still carries all of it — that is the point of the seam, not a defect.
    for (const f of ['_born', 'entityKey', 'ownerId', 'createdAt', 'updatedAt', 'updatedBy', 'visibility', 'coEdit']) {
      assert.ok(f in n, `${f} is on the in-memory entry`);
    }
    assert.equal(n.ownerId, ME);
    assert.ok(/^\d{13}\.\d{6}\./.test(n._born));

    // Every v2-only register name, derived from the vocabulary rather than typed out here.
    const v1Union = new Set(Object.values(coreMat.V1_ENTRY_FIELDS).flat());
    const v2Only = [...new Set([
      ...['note', 'bar', 'cat'].flatMap((k) => Object.keys(coreOps.FIELDS[k])),
      ...['fnote', 'fbar'].flatMap((k) => Object.keys(coreOps.FIELDS[k])
        .map((f) => (f.startsWith('pub.') ? f.slice(4) : f))),
    ])].filter((f) => !v1Union.has(f));
    assert.ok(v2Only.length >= 5, 'the FIELDS enumeration is empty — this test is vacuous');

    // Plant every one of them on a live entry first, so the strip is proved TOTAL rather than
    // proved-not-to-have-dropped-the-fields-materialize-happens-to-emit-today.
    const planted = {
      ...s.state,
      notes: s.state.notes.map((e) => ({ ...e, ...Object.fromEntries(v2Only.map((f) => [f, 'LEAK'])) })),
      bars: s.state.bars.map((e) => ({ ...e, ...Object.fromEntries(v2Only.map((f) => [f, 'LEAK'])) })),
      categories: s.state.categories.map((e) => ({ ...e, ...Object.fromEntries(v2Only.map((f) => [f, 'LEAK'])) })),
    };
    const json = coreMat.exportV1JSON(planted);
    const file = JSON.parse(json);
    assert.equal(json.includes('LEAK'), false, 'a planted v2 field survived the strip');
    for (const e of [...file.notes, ...file.bars, ...file.categories]) {
      for (const f of [...v2Only, ...coreMat.V2_ENTRY_FIELDS]) {
        assert.equal(f in e, false, `"${f}" reached the exported file`);
      }
    }
    // and by VALUE, not just by key name
    assert.equal(json.includes(ME), false, 'a MemberId reached the file');
    assert.equal(json.includes(DEV), false, 'a DeviceId reached the file');
    assert.equal(json.includes(SHORT), false, 'the device fingerprint reached the file');
    assert.equal(/\d{13}\.\d{6}\./.test(json), false, 'a stamp reached the file');
  });

  test('ATT-82 CLOSED: a >80-char note text is TRUNCATED and the note stays on the board', async () => {
    // INVERTED — the worst defect in the set. v1's 80 is a DOM `maxLength` (`interact.js:466`,
    // `popover.js:146`) that never applied to a file, an import or a pre-v1 build, so a real
    // board can hold a 140-character note. Dropping the `text` register took the whole NOTE off
    // the board, because text is half of a note's renderability (§5 step 3).
    const long = 'x'.repeat(140);          // v1's 80 is a DOM maxLength, not a file constraint
    const board = v1board({ notes: [note('n1', '2026-03-04', long)] });
    await freshV1(board);
    assert.equal(store.state.notes[0].text.length, 140, 'v1 loads and renders it');

    const { s, warnings, lossy } = opStoreFrom(board);
    assert.equal(s.state.notes.length, 1, 'THE NOTE IS STILL THERE');
    assert.equal(s.state.notes[0].text, 'x'.repeat(80));
    assert.equal(s.state.notes[0].date, '2026-03-04');
    assert.equal(s.state.notes[0].categoryId, 'cat-1');
    assert.equal(lossy, true, 'the 60 cut characters are still a loss and still say so');
    assert.ok(warnings.some((w) => /TRUNCATED, not dropped/.test(w)), warnings.join(' | '));

    // …and a lossy migration can no longer COMPLETE IN SILENCE: a caller that neither takes the
    // report (ctx.onLossy) nor acknowledges it (ctx.acceptLossy) gets a throw instead of a
    // quietly shortened board — and the throw discards nothing, the result is on error.result.
    assert.throws(() => migrateV1(board, { memberId: ME, deviceId: DEV }), coreMig.MigrationLossyError);
    let err = null;
    try { migrateV1(board, { memberId: ME, deviceId: DEV }); } catch (e) { err = e; }
    const cut = err.report.losses.find((l) => l.reason === 'truncated');
    assert.equal(cut.kept + cut.dropped, long, 'the report reconstructs the original exactly');
    assert.equal(err.result.ops.length > 0, true, 'the board still opens, from the error object');
  });

  test('ATT-83 CLOSED: a >40-char bar label is truncated, so the bar keeps its name', async () => {
    // INVERTED. The bar always survived — a label is not part of renderability — but it survived
    // UNNAMED, and the label is the one field that tells the user what the bar is.
    const board = v1board({ bars: [bar('b1', '2026-03-01', '2026-03-10', 'y'.repeat(90))] });
    await freshV1(board);
    assert.equal(store.state.bars[0].label.length, 90);
    const { s, lossy, warnings } = opStoreFrom(board);
    assert.equal(lossy, true, 'the 50 cut characters are a loss');
    assert.equal(s.state.bars.length, 1);
    assert.equal(s.state.bars[0].label, 'y'.repeat(40), 'named, not blank');
    assert.ok(warnings.some((w) => /TRUNCATED, not dropped/.test(w)));
  });

  test('ATT-84 a long scratchpad survives (pad.text is unbounded `str`) — the defence held', async () => {
    const board = v1board({ scratchpads: { '2026-03': 'z'.repeat(5000) } });
    await freshV1(board);
    const { s, lossy } = opStoreFrom(board);
    assert.equal(lossy, false);
    assert.equal(s.state.scratchpads['2026-03'].length, 5000);
  });
});

describe('synchronicity and remote folds', () => {
  test('ATT-85 txn → apply → materialize → emit is strictly synchronous (U8, interact.js:316-318)', () => {
    const { s } = opStoreFrom(v1board());
    let seenInsideEmit = null;
    const realEmit = s.emit.bind(s);
    s.emit = (r) => { seenInsideEmit = s.state.bars.length; realEmit(r); };
    s.mut('createBar', { id: 'b9', startDate: '2026-03-01', endDate: '2026-03-05', categoryId: 'cat-1' });
    assert.equal(seenInsideEmit, 1, 'the bar exists in state before emit() returns');
    assert.equal(s.state.bars[0].label, '', "and its label is v1's empty string");
  });

  test('ATT-86 a remote fold does not touch either stack and does not clear redo (U2 / 18.4)', () => {
    const { s } = opStoreFrom(v1board({ notes: [note('n1', '2026-03-04', 'a')] }));
    s.mut('editNoteInline', { id: 'n1', text: 'b' });
    s.undo();
    assert.equal(s.canRedo(), true);

    // a peer's op arrives on one of MY entities
    const ctx = s.ctx();
    ctx.gid = pad22('gr');
    s.clock.observe(coreStamp.fmt(BASE_MS + 5000, 1, SHORT));
    s.log.append(noteSet({ ...ctx, act: ME, dev: DEV }, 'n1', { date: '2026-03-09' }));
    s.stacks.remoteApplied();
    s._materialize();

    assert.equal(s.canRedo(), true, 'the redo branch survived');
    assert.equal(s.stacks.size().undo, 0);
    assert.equal(s.redo(), true, 'and it still applies');
    assert.equal(noteOf(s.state, 'n1').text, 'b');
    assert.equal(noteOf(s.state, 'n1').date, '2026-03-09', 'the remote write is not clobbered by the redo');
  });

  test('ATT-87 redo does not trim the undo stack in EITHER store', async () => {
    await freshV1(v1board());
    for (let i = 0; i < 50; i++) store.mutate('a', (s) => { s.notes.push({ id: `x${i}`, date: '2026-03-01', text: 't', categoryId: 'cat-1', repeatsYearly: false }); });
    assert.equal(store.undoStack.length, 50);
    store.undo(); store.redo();
    assert.equal(store.undoStack.length, 50, 'v1 redo() has no limit check either');

    const { s } = opStoreFrom(v1board());
    for (let i = 0; i < 50; i++) s.mut('createNoteInline', { id: `x${i}`, date: '2026-03-01', text: 't', categoryId: 'cat-1' });
    assert.equal(s.stacks.size().undo, 50);
    s.undo(); s.redo();
    assert.equal(s.stacks.size().undo, 50, 'parity');
  });

  test('ATT-88 FIXED: deleting an entity that does not exist mints NO register and records no step', async () => {
    // The defect this test was written for: `deleteSelected` tombstoned unconditionally, so
    // ⌫ on a stale selection minted `note:ghost` — a register for an entity that never existed,
    // permanent, invisible on the board, and synchronised to every sibling device. v1 gets away
    // with the same gesture because `notes.filter(…)` on a missing id really is a no-op; an
    // append-only log has no no-ops, so the constructor has to decline instead (ops.js `knows`).
    await freshV1(v1board());
    store.mutate('delete', (s) => { s.notes = s.notes.filter((n) => n.id !== 'ghost'); });
    assert.equal(store.canUndo(), true, 'v1 still records an empty step — its delete cannot tell');

    const { s } = opStoreFrom(v1board());
    const before = s.log.registers().size;
    const ops = buildMutation('deleteSelected', { ...s.ctx(), gid: pad22('gdel') }, { type: 'note', id: 'ghost' });
    assert.deepEqual(ops, [], 'the constructor declines: zero ops IS the v2 decline protocol');

    s.mut('deleteSelected', { type: 'note', id: 'ghost' });
    assert.equal(s.log.registers().has('note:ghost'), false, 'no phantom register was minted');
    assert.equal(s.log.registers().size, before, 'and nothing else was written either');
    assert.equal(s.canUndo(), false, 'a group with no undoable register records no undo step');
    assert.equal(s.state.notes.length, 0);

    // The gate is scoped: an entity that DOES exist still deletes, and an already-tombstoned one
    // is still re-deletable (it has registers), so the fix cannot break a resurrect race.
    const { s: t } = opStoreFrom(v1board({ notes: [note('n1', '2026-03-01', 'a')] }));
    t.mut('deleteSelected', { type: 'note', id: 'n1' });
    assert.equal(t.state.notes.length, 0);
    assert.equal(t.canUndo(), true);
    assert.equal(buildMutation('deleteSelected', { ...t.ctx(), gid: pad22('gd2') }, { type: 'note', id: 'n1' }).length, 1,
      'the tombstone left registers standing, so a second delete is still admissible');
  });

  test('ATT-88 the existence gate covers every delete constructor, and only when a view is given', () => {
    const { s } = opStoreFrom(v1board());
    const ctx = { ...s.ctx(), gid: pad22('ggate') };
    const blind = { ...ctx, regs: undefined };          // no view — the constructor cannot judge
    const cases = [
      ['deleteSelected', { type: 'note', id: 'ghost' }],
      ['deleteSelected', { type: 'bar', id: 'ghost' }],
      ['deleteNotePopover', { id: 'ghost' }],
      ['editNoteInline', { id: 'ghost', text: '' }],
      ['editNotePopover', { id: 'ghost', text: '' }],
      ['deleteCategory', { id: 'cat-ghost' }],
      ['deleteCategoryReassign', { id: 'cat-ghost', targetId: 'cat-2', noteIds: ['n1'], barIds: [] }],
      // The blank-pad path was the eighth and last. It mints a phantom `pad:<month>` exactly the
      // way the seven above mint a phantom entity, and it is the most reachable of all of them:
      // `interact.js:631` fires on blur, so clicking into an empty scratchpad and out again used
      // to be enough. See ATT-61 for the v1 parity that was deliberately given up to close it.
      ['padBlur', { month: '2029-09', text: '' }],
      ['padTyping', { month: '2029-09', text: '   ' }],
    ];
    for (const [name, args] of cases) {
      assert.deepEqual(buildMutation(name, ctx, args), [], `${name} must decline an unknown target`);
      assert.ok(buildMutation(name, blind, args).length > 0,
        `${name} with no register view must build as before — "I cannot tell" is not "it is missing"`);
    }
    // and a delete-with-reassign whose category is gone does NOT rewrite the live entries
    assert.deepEqual(buildMutation('deleteCategoryReassign', ctx,
      { id: 'cat-ghost', targetId: 'cat-2', noteIds: ['n1', 'n2'], barIds: ['b1'] }), []);
  });

  test('ATT-89 the 50-group limit counts GROUPS even when a group carries 30 ops', () => {
    const notes = Array.from({ length: 30 }, (_, i) => note(`n${i}`, '2026-03-01', `t${i}`));
    const { s } = opStoreFrom(v1board({ notes }));
    s.mut('deleteCategoryReassign', {
      id: 'cat-1', targetId: 'cat-2', noteIds: notes.map((n) => n.id), barIds: [],
    });
    assert.equal(s.stacks.size().undo, 1, '31 ops, one step (U5)');
    s.undo();
    assert.equal(s.state.notes.every((n) => n.categoryId === 'cat-1'), true);
    assert.equal(s.state.categories.length, 2);
  });

  test('ATT-90 CLOSED: duplicate ids in a v1 file are RE-KEYED, so both entries survive', async () => {
    // INVERTED. Two registers genuinely cannot share an entity key — the second would LWW over
    // the first — but "keep the first, discard the second" is the same data loss with a warning
    // attached. A v1 entity id is OPAQUE: nothing outside the entry refers to a note id, so the
    // second copy is simply given a fresh one, DERIVED so that two Macs agree (R12).
    const dup = () => v1board({ notes: [note('dup', '2026-03-01', 'first'), note('dup', '2026-04-01', 'second')] });
    await freshV1(dup());
    assert.equal(store.state.notes.length, 2, 'v1 tolerates it and renders both');

    const { s, lossy, warnings } = opStoreFrom(dup());
    assert.equal(s.state.notes.length, 2, 'and so does core now');
    assert.deepEqual(s.state.notes.map((n) => n.text), ['first', 'second'], 'in v1 array order');
    assert.equal(s.state.notes[0].id, 'dup', 'the first occurrence keeps the id it had');
    assert.notEqual(s.state.notes[1].id, 'dup');
    assert.equal(lossy, false, 'nothing was lost, so this is a repair and not a loss');
    assert.ok(warnings.some((w) => /RE-KEYED/.test(w)));

    // deterministic: a second Mac, with a different member AND device id, derives the same key
    const again = migrateV1(dup(), { memberId: ME, deviceId: 'dev_' + 'Q'.repeat(22), acceptLossy: true });
    assert.deepEqual(again.ops.filter((o) => o.k === 'note.set').map((o) => o.e),
      ['note:dup', `note:${s.state.notes[1].id}`]);
  });

  test('ATT-91 toggle-category on a category with no `visible` field — parity', async () => {
    const cats = CATS();
    delete cats[0].visible;
    const board = v1board({ categories: cats });
    await freshV1(board);
    store.mutate('toggle-category', (s) => {
      const x = s.categories.find((y) => y.id === 'cat-1');
      x.visible = x.visible === false;
    });
    assert.equal(catOf(store.state, 'cat-1').visible, false, 'v1 hides it');

    const { s } = opStoreFrom(board);
    assert.equal('visible' in catOf(s.state, 'cat-1'), false);
    // the retrofit computes the absolute value the same way v1 does
    s.mut('toggleCategory', { id: 'cat-1', visible: catOf(s.state, 'cat-1').visible === false });
    assert.equal(catOf(s.state, 'cat-1').visible, false, 'parity');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ROUND 3 — guard coverage and ctx hazards
// ═════════════════════════════════════════════════════════════════════════════

describe('guards and ctx hazards', () => {
  // ATT-96 CLOSED. The finding was that the R5 shadow-undo assertion — the mechanism PLAN.md
  // relies on to turn "did we cover every mutation?" into a test failure, and WP-3's exit
  // criterion ("WP-2 stays green WITH THE SHADOW-UNDO ASSERTION ON") — was inert during the very
  // suite it exists to protect. `createUndoStacks` defaulted to `cfg.shadow ?? DEV` correctly,
  // but nothing ever set `DEV`, and both op-store harnesses additionally pinned
  // `shadow: opts.shadow ?? false`, which won over the default even if something had.
  //
  // Three changes, all outside src/: `tests/helpers/dev-flag.mjs` sets the global; the four npm
  // test scripts run with `--import` of it (the only seam that reaches every file in a run —
  // `dev.js` reads the global ONCE at import time, so no test file can arm it for another); and
  // the two harnesses dropped their `?? false` so they inherit the process default. The flag is
  // never set anywhere in `src/`, so the shipping app is unchanged.
  //
  // The whole attack suite and the whole tier-1 suite are green with the assertion armed, which
  // is the substantive result: the shadow content and the op log agree on every mutation the
  // suite performs, rather than nobody having checked.
  test('ATT-96 CLOSED: the shadow-undo assertion is ARMED for the suite, and DOES fire', () => {
    // The default is `cfg.shadow ?? DEV`, and the suite arms DEV. Asserting the mechanism rather
    // than the ambient value: an explicit `false` must still win, or the flag would be a trap.
    const mk = (cfg) => createUndoStacks({ act: ME, dev: DEV, mint: () => coreStamp.fmt(BASE_MS, 1, SHORT), ...cfg });
    // The MECHANISM, which holds however this file is invoked: the default follows DEV, and an
    // explicit value wins in both directions. (Whether the npm scripts actually arm DEV is
    // asserted in `suite-integrity.test.js`, which reads package.json and so cannot be sidestepped
    // by running one file on its own.)
    assert.equal(mk({}).shadowArmed, coreDev.DEV, 'the default is `cfg.shadow ?? DEV`');
    assert.equal(mk({ shadow: false }).shadowArmed, false, 'an explicit opt-out still wins');
    assert.equal(mk({ shadow: true }).shadowArmed, true, 'and an explicit opt-in still wins');
    // The harness must NOT pin it off any more — that `?? false` was the second half of ATT-96,
    // and it beat the default even for a caller who had armed the flag.
    assert.equal(opStoreFrom(v1board()).s.stacks.shadowArmed, coreDev.DEV,
      'THE FIX: the op-store harness inherits the process default instead of pinning `false`');

    // Armed, it catches a group whose image under-describes what the group changed.
    const { s } = opStoreFrom(v1board({ notes: [note('n1', '2026-03-04', 'a'), note('n2', '2026-03-05', 'b')] }), { shadow: true });
    const ctx = s.ctx();
    ctx.gid = pad22('gA');
    const ops = [noteSet(ctx, 'n1', { text: 'A' }), noteSet(ctx, 'n2', { text: 'B' })];
    const regs = s.log.registers();
    const { pre, post } = coreUndo.captureImages(regs, ops, { me: ME });
    const shadow = shadowContent(s.state);
    for (const op of ops) s.log.append(op);
    s._materialize();
    // deliberately drop n2 from the image — the bug a mis-rewritten mutate site would ship
    s.stacks.push(ctx.gid, 'half', pre.filter((t) => t[0] !== 'note:n2'), post, shadow);
    const undoOps = s.stacks.undo(s.state);
    for (const op of undoOps) s.log.append(op);
    s._materialize();
    assert.throws(() => s.stacks.verify(s.state), coreUndo.ShadowUndoError);
  });

  test('ATT-97 CLOSED: a pinned board with no startMonth is REFUSED, so the hang is unreachable', () => {
    // THE HANG. `DEFAULT_SETTINGS.startMonth` is null (core/ may not read a clock, ADR 005 §2),
    // and the ADR called that "repaired downstream by the caller" without anything enforcing it.
    // `layout.js:25` then does `parseISO('null-01')` → `{y: NaN, m: NaN}`, and `holidays.js:51`'s
    // `while (dow(year, 11, d) !== 3) d -= 1;` never terminates. The app hangs, hard.
    //
    // FIXED in materialize.js `buildSettings`: `mode === 'pinned'` with a `startMonth` that
    // `layout.js` cannot parse throws `MaterializeError` naming `ctx.defaultSettings`. Only
    // pinned mode reads `startMonth` (`layout.js:24`), so a rolling board — the headless /
    // bare-ctx case — is untouched.
    const bare = { me: ME, familySpaceId: null, currentMembers: new Set([ME]) };
    const boardWith = (settings) => migrateV1(
      { schemaVersion: 1, notes: [], bars: [], categories: CATS(), scratchpads: {}, settings },
      MIG_CTX).ops;

    assert.throws(
      () => materialize(coreReg.fold(boardWith({ mode: 'pinned' })), bare),
      coreMat.MaterializeError);
    assert.throws(
      () => materialize(coreReg.fold(boardWith({ mode: 'pinned' })), bare),
      /ctx\.defaultSettings/);
    // DEFAULT_SETTINGS is a public export and is NOT a usable ctx.defaultSettings — passing it
    // is refused on the same line, so "unsafe to use directly" is enforced, not documented.
    assert.throws(
      () => materialize(coreReg.fold(boardWith({ mode: 'pinned' })), { ...bare, defaultSettings: coreMat.DEFAULT_SETTINGS }),
      coreMat.MaterializeError);

    // Rolling with a bare ctx still works, and never reaches `startMonth` in layout.
    const rolling = materialize(coreReg.fold(boardWith({})), bare);
    assert.equal(rolling.settings.startMonth, null);
    const rs = visibleStart(rolling.settings, '2026-03-04');
    assert.ok(Number.isInteger(rs.y) && Number.isInteger(rs.m));

    // With a real caller's defaults — what store.js passes — the pinned board projects and
    // renders, and NOTHING materialize can return produces the NaN that hangs holidays.js.
    for (const settings of [{ mode: 'pinned' }, { mode: 'pinned', startMonth: '2026-01' }, {}, { mode: 'rolling' }]) {
      const st = materialize(coreReg.fold(boardWith(settings)), { ...bare, defaultSettings: defaultState().settings });
      const start = visibleStart(st.settings, '2026-03-04');
      assert.ok(Number.isInteger(start.y) && Number.isInteger(start.m),
        `visibleStart returned NaN for ${JSON.stringify(settings)}`);
      assert.ok(buildBoard(stripV2Fields(st), { today: '2026-03-04' }).cols.length > 0,
        'buildBoard did not terminate with a real board');
    }
  });

  test('ATT-98 a bare ctx (no members, no currentMembers) still keeps MY OWN board — fail-closed is scoped', () => {
    const board = v1board({ notes: [note('n1', '2026-03-04', 'a')], bars: [bar('b1', '2026-03-01', '2026-03-09', 'x')] });
    const { ops } = migrateV1(board, MIG_CTX);
    const st = materialize(coreReg.fold(ops), { defaultSettings: defaultState().settings });
    assert.equal(st.notes.length, 1);
    assert.equal(st.bars.length, 1);
    assert.equal(st.categories.length, 2);
  });

  test('ATT-99 solo mode: a stray family register cannot reach the board (ADR 001 §11)', () => {
    const board = v1board({ notes: [note('n1', '2026-03-04', 'a')] });
    const { s } = opStoreFrom(board);
    assert.equal(s.state.notes.length, 1);
    assert.equal(s.state.notes[0].isForeign, false);
    assert.equal(s.state.notes[0].level, null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ROUND 4 — snapshots (11.5)
// ═════════════════════════════════════════════════════════════════════════════

describe('snapshots (11.5)', () => {
  test('ATT-100 v1 snapshots the LAST PERSISTED board, not the edited one', async () => {
    const board = v1board({ notes: [note('n1', '2026-03-04', 'gestern')] });
    await freshV1(board);
    // edit, then force a persist — the day roll must capture the PRE-edit board
    store.mutate('edit-note', (s) => { s.notes[0].text = 'heute'; });
    await store.persistNow();
    assert.equal(store.snapshots.length, 1);
    assert.equal(store.snapshots[0].state.notes[0].text, 'gestern',
      'store.js:229 stores `_persisted` — restoring the day would otherwise return the very edit you wanted to undo');
    // and the rule is a STORE-level invariant with no representation in core:
    const surface = new Set([coreMat, coreMig, coreOps, coreEnt, coreReg, coreUndo, coreOplog]
      .flatMap((m) => Object.keys(m)));
    // `toV1Snapshot` (added for ATT-101) is a SHAPE helper — it says what a snapshot must look
    // like, not WHICH state gets snapshotted. The last-persisted rule still has no home in core.
    assert.equal([...surface].some((k) => /snapshot|persisted|rollSnap/i.test(k)
      && !['migrateSnapshots', 'snapshot', 'toV1Snapshot'].includes(k)), false,
      'nothing in core carries the last-persisted rule; WP-3 must re-derive it by hand');
    assert.equal(typeof coreMig.toV1Snapshot, 'function', 'the SHAPE half does have a home');
  });

  test('ATT-101 CLOSED: core exposes the snapshot seam §8.4 promised, and names a v2-shaped file', () => {
    // INVERTED. §8.4 promises „snapshots.json stays BYTE-IDENTICAL in the v1 shape", but
    // `rollSnapshot` writes `structuredClone(this._persisted)` — the materialized state, which
    // from the first v2 launch carries `_born`, `ownerId`, `visibility`, `updatedBy` and
    // `schemaVersion: 2` on every entry. The promise was broken by DEFAULT, on day one, silently,
    // and 11.5's restore UI (`settings.js:224-254`) was left reading a shape nobody wrote.
    //
    // The store cannot be asked to re-derive "which fields are v2 additions" — that list lives in
    // materialize.js and grows with the model — so core now names the one call the roll must make.
    const { s } = opStoreFrom(v1board({ notes: [note('n1', '2026-03-04', 'a')] }));
    const wouldBeSnapshot = structuredClone(s.state);
    assert.equal(wouldBeSnapshot.schemaVersion, 2);
    assert.ok('_born' in wouldBeSnapshot.notes[0]);

    // 1. the seam: one call, named for the job, that produces the v1 shape
    const snap = coreMig.toV1Snapshot(s.state);
    assert.equal(snap.schemaVersion, 1);
    assert.equal('_born' in snap.notes[0], false);
    assert.equal('ownerId' in snap.notes[0], false);
    assert.deepEqual(coreMig.v1ShapeViolations(snap), [], 'v1-shaped by core’s own predicate');
    assert.deepEqual(Object.keys(snap.notes[0]), ['id', 'date', 'text', 'categoryId', 'repeatsYearly'],
      'the v1 entry shape, key order included — what settings.js:224-254 restores from');
    assert.deepEqual(Object.keys(snap).sort(), ['bars', 'categories', 'notes', 'schemaVersion', 'scratchpads', 'settings']);

    // 2. and a snapshots.json that was already written in the wrong shape is NAMED, not swallowed.
    //    Still byref and still untouched — this file's contract is that migration does not
    //    rewrite it — but no longer silent.
    const out = coreMig.migrateSnapshots([{ day: '2026-08-25', at: 'x', state: wouldBeSnapshot }]);
    assert.ok('_born' in out.snapshots[0].state.notes[0], 'byref and untouched');
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /not in the v1 shape/);
    assert.match(out.warnings[0], /toV1Snapshot/);

    // 3. WP-3 SEAM, reported rather than made here (store.js is WP-3's file): `rollSnapshot()`
    //    at store.js:229 must become
    //      state: coreMig.toV1Snapshot(this._persisted ?? this.state)
    //    A v1-shaped snapshot is silent, so the assertion above doubles as the acceptance test.
    const good = coreMig.migrateSnapshots([{ day: '2026-08-25', at: 'x', state: coreMig.toV1Snapshot(s.state) }]);
    assert.deepEqual(good.warnings, []);
  });
});
