// tests/tier1/core-integration.test.js — WP-1's exit gate.
//
// The six machinery packages (registers, authz, materialize, undo, oplog, migrate1to2) were each
// built and tested in isolation, in parallel, by agents forbidden from editing each other's
// files. Every one of them is green on its own. That proves nothing about whether they COMPOSE:
// six modules can each satisfy their own contract and still deadlock, double-count, or disagree
// about who owns a rule at the seams between them.
//
// So this file does not unit-test anything. It builds ONE realistic session — the session WP-3's
// retrofit will have to reproduce inside `store.js` — and drives it end to end:
//
//     board.json (v1)
//       → migrateV1                     ops at GENESIS(i)
//       → oplog.append                  admission, dedupe, parking
//       → foldAuthorized                the staged authorization fold
//       → materialize                   back to the exact v1 state shape
//       → txn / undo / redo             real user actions, real inverse ops
//       → oplog.compact                 checkpoint the past, keep the tail
//       → reload from {checkpoint, tail}
//       → materialize again             and it must STILL be the same board
//
// and asserts at the end that what the user sees is byte-for-byte what v1 would have held.
//
// `IntegrationStore` below is ADR 001 §7.1's transaction snippet wired to the SHIPPING modules.
// It is deliberately the smallest thing that composes them, and it is the working reference the
// retrofit should copy — including the strictly-synchronous txn → apply → materialize → emit
// path that `store.contract.js` §2.2 clause 3 says bar-label editing depends on.

import test from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import { boardState, CAT, note as v1note, bar as v1bar } from '../helpers/fixtures.js';
import {
  pcg32, shuffle, duplicateSome, partition, short16, attestationBlob, attestVerify,
} from '../helpers/gen.js';

import { defaultState } from '../../src/js/store.js';
import { buildBoard } from '../../src/js/layout.js';

import { migrateV1, GENESIS, MIGRATION_LABEL, shouldMigrate } from '../../src/js/core/migrate1to2.js';
import { foldAuthorized, unsharePatch } from '../../src/js/core/authz.js';
import {
  emptyRegisters, applyOp, fold, mergeMaps, serializeRegisters, deserializeRegisters, getRegister,
} from '../../src/js/core/registers.js';
import { materialize, stripV2Fields, SCHEMA_VERSION_V2 } from '../../src/js/core/materialize.js';
import { createUndoStacks, makeTx, shadowContent, ShadowUndoError } from '../../src/js/core/undo.js';
import { createOpLog, APPEND } from '../../src/js/core/oplog.js';
import { createClock, fmt } from '../../src/js/core/stamp.js';
import {
  PERSONAL_PLACEHOLDER, makeOp, familyKey, memberKey, spaceKey, noteKey,
} from '../../src/js/core/ops.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The cast. Fixed ids and a fake clock: nothing in this file reads the wall clock or the CSPRNG,
// so a failure here is replayable from the file alone.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const pad22 = (s) => (s + 'x'.repeat(22)).slice(0, 22);
const ME = `mem_${pad22('ME')}`;
const DEV = `dev_${pad22('MEDESKTOP')}`;
const DEV2 = `dev_${pad22('MELAPTOP')}`;
const SHORT = 'MEDESKTOP0000000'.replace(/[ILOU]/g, '0');
const SHORT2 = 'MELAPTOP00000000'.replace(/[ILOU]/g, '0');
const BASE_MS = 1787836800000;

/** A wall clock that only ever moves when a test moves it. */
function fakeWall(start = BASE_MS) {
  let ms = start;
  return { now: () => ms, advance(d) { ms += d; return ms; }, set(v) { ms = v; return ms; } };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// IntegrationStore — ADR 001 §7.1 over the shipping modules. The WP-3 reference.
// ═════════════════════════════════════════════════════════════════════════════════════════════

class IntegrationStore {
  constructor(opts = {}) {
    this.act = opts.act ?? ME;
    this.dev = opts.dev ?? DEV;
    this.wall = opts.wall ?? fakeWall();
    this.clock = createClock(opts.short ?? SHORT, this.wall.now);
    this.rnd = pcg32(opts.seed ?? 42);
    this.n = 0;

    // The log is the source of truth on disk; the registers are its fold. Note that the log is
    // constructed with the SHIPPING registers.js — `oplog.js` folds through the real join, not a
    // reference copy, so a divergence between "what the log thinks" and "what the store thinks"
    // is impossible by construction rather than by test.
    this.log = createOpLog({ now: this.wall.now });

    this.stacks = createUndoStacks({
      act: this.act,
      dev: this.dev,
      mint: () => this.clock.tick(),
      newOpId: () => this._id('u'),
      newGid: () => this._id('g'),
      space: PERSONAL_PLACEHOLDER,
      // `?? false` removed for ATT-96: the harness must inherit the process-wide DEV default
      // (`createUndoStacks` uses `cfg.shadow ?? DEV`), or arming the flag changes nothing for the
      // suites that matter most. An explicit `opts.shadow` still wins in both directions.
      shadow: opts.shadow,
    });

    this.events = [];
    this.state = null;
    this._materialize();
  }

  _id(tag) { return pad22(`${tag}${++this.n}_${Math.floor(this.rnd() * 1e9)}`); }

  _ctx() {
    return {
      act: this.act,
      dev: this.dev,
      mint: () => this.clock.tick(),
      newOpId: () => this._id('o'),
      newGid: () => this._id('g'),
      space: PERSONAL_PLACEHOLDER,
    };
  }

  /** Everything the store knows, re-derived. `materialize()` is a full rebuild by ADR 001 §5.1. */
  _materialize() {
    this.state = materialize(this.log.registers(), {
      me: this.act,
      familySpaceId: null,
      members: new Map(),
      currentMembers: new Set([this.act]),
      hiddenMembers: new Set(),
      prefs: {},
      lastSeenSeq: {},
      defaultSettings: defaultState().settings,
    });
    return this.state;
  }

  emit(reason) { this.events.push(reason); }

  /**
   * ADR 001 §7.1, line for line — and the ORDER is the contract, not a style choice.
   * `store.contract.js` §2.2 clause 3: txn → apply → materialize → emit is strictly synchronous,
   * because `interact.js:317` queries the DOM for the freshly created bar's label element the
   * instant this returns. An `await` anywhere above `emit()` silently breaks bar-label editing.
   */
  txn(label, fn) {
    const regs = this.log.registers();
    const tx = makeTx({ state: this.state, regs, ...this._ctx() });
    const r = fn(tx);
    if (r === false || tx.ops.length === 0) return r;      // store.js:150, verbatim
    const { pre, post } = tx.images();                     // captured against the PRE-state
    const shadow = this.stacks.shadowArmed ? shadowContent(this.state) : undefined;
    for (const op of tx.ops) this.log.append(op);
    this._materialize();
    this.stacks.push(tx.gid, label, pre, post, shadow);
    this.emit(label);
    return r;
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

  /** Rule U2 / story 18.4: touches NEITHER stack and never clears redo. */
  applyRemote(ops) {
    for (const op of ops) {
      if (op.dev !== this.dev) this.clock.observe(op.ts);
      this.log.append(op);
    }
    this.stacks.remoteApplied();
    this._materialize();
    this.emit('remote');
  }

  canUndo() { return this.stacks.canUndo(); }
  canRedo() { return this.stacks.canRedo(); }

  /** Seed from a migration: ops fold straight in, no transaction, no undo entry (rule U10). */
  seed(ops) {
    for (const op of ops) {
      const res = this.log.append(op);
      assert.equal(res.status, APPEND.APPENDED, `migration op ${op.id} was ${res.status}: ${res.reason ?? ''}`);
    }
    this._materialize();
    return this;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────────────────────

const MIG_CTX = { memberId: ME, deviceId: DEV };

/** A board with real content in every one of v1's four content buckets. */
function realBoard() {
  return boardState({
    notes: [
      v1note('n-1', '2026-03-04', 'Zahnarzt'),
      v1note('n-2', '2026-03-04', 'Elternabend', { categoryId: CAT[1] }),
      v1note('n-3', '2026-03-04', 'Yoga', { categoryId: CAT[2] }),
      v1note('n-4', '2026-03-04', 'Steuer', { categoryId: CAT[3] }),
      v1note('n-5', '2024-02-29', 'Schaltjahr', { repeatsYearly: true }),
      v1note('n-6', '2026-11-30', 'Advent', { categoryId: CAT[1] }),
    ],
    bars: [
      v1bar('b-1', '2026-02-10', '2026-04-20', 'Projekt Nord'),
      v1bar('b-2', '2026-02-10', '2026-03-01', 'Sprint', { categoryId: CAT[1] }),
      v1bar('b-3', '2026-02-15', '2026-02-28', 'Urlaub', { categoryId: CAT[2] }),
    ],
    scratchpads: { '2026-03': 'Milch\nBrot', '2026-01': 'Vorsätze', '2026-12': 'Geschenke' },
  });
}

/** A store loaded from a migrated board — the state every test below starts from. */
function migrated(board = realBoard(), opts = {}) {
  const { ops, warnings, lossy } = migrateV1(board, MIG_CTX);
  assert.equal(lossy, false, `migration was lossy: ${warnings.join('; ')}`);
  const s = new IntegrationStore(opts);
  s.seed(ops);
  return { store: s, ops, board };
}

const sig = (state) => JSON.stringify(stripV2Fields(state));

/**
 * Just the four v1 CONTENT buckets. The undo retrace compares this rather than the whole state,
 * because `settings` is written through `tx.pref()` — the `local` space, never undone (rule U6,
 * and v1 parity for `settings.lastCategoryId`, which `interact.js:546` writes inside create-note
 * precisely so that ⌘Z does not drag it back). Including settings would assert the opposite of
 * the rule.
 */
function content(state) {
  const v1 = stripV2Fields(state);
  return JSON.stringify({
    notes: v1.notes, bars: v1.bars, categories: v1.categories, scratchpads: v1.scratchpads,
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. The pipeline joins up at all
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('a v1 board survives migrate → oplog → authz → materialize as the same board', () => {
  // The whole point of WP-1 in one assertion. If this fails, nothing downstream is worth running.
  const board = realBoard();
  const { store } = migrated(board);
  assert.deepEqual(stripV2Fields(store.state), board);
  assert.equal(store.state.schemaVersion, SCHEMA_VERSION_V2);
});

test('the authz fold and the raw fold agree on a solo board — the gate admits everything of mine', () => {
  // `oplog.js` folds admitted ops directly; `foldAuthorized` is the gate WP-3 will put in front
  // of the network. On a personal-space log with one member they MUST produce the same registers,
  // or the retrofit would silently change the solo board the moment authorization is wired in.
  const { ops } = migrated();
  const gated = foldAuthorized(ops, { me: ME, nowMs: BASE_MS + 60000, attestVerify: () => false });
  assert.equal(gated.rejected.length, 0, 'a solo board must not have a single inadmissible op');
  assert.equal(gated.parked.length, 0);
  assert.deepEqual(
    JSON.stringify(serializeRegisters(gated.regs)),
    JSON.stringify(serializeRegisters(fold(ops))),
    'the authorization gate changed the state of a solo board',
  );
});

test('the migrated board renders identically through the REAL layout.js', () => {
  // Deep-equal arrays do not prove ORDER survived — and order is user-visible, because v1's
  // capacity slice (layout.js:209) and lane rescue (:162-177) both consume it. Running the real
  // layout over both boards and comparing every column, day and segment does prove it.
  const board = realBoard();
  const { store } = migrated(board);
  const a = buildBoard(board);
  const b = buildBoard(stripV2Fields(store.state));
  assert.equal(a.cols.length, b.cols.length);
  for (let i = 0; i < a.cols.length; i++) {
    assert.deepEqual(b.cols[i].days, a.cols[i].days, `day rows differ in column ${a.cols[i].key}`);
    assert.deepEqual(b.cols[i].segs, a.cols[i].segs, `bar segments differ in column ${a.cols[i].key}`);
  }
});

test('shouldMigrate refuses to run twice — and the log half of the predicate is not optional', () => {
  const board = realBoard();
  assert.equal(shouldMigrate(board, { opsLogExists: false }).migrate, true);
  assert.equal(shouldMigrate(board, { opsLogExists: true }).migrate, false,
    'a board whose version write failed AFTER the ops landed must not migrate twice');
  assert.equal(shouldMigrate({ ...board, schemaVersion: 2 }, { opsLogExists: false }).migrate, false);
  assert.throws(() => shouldMigrate(board, {}), /opsLogExists/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. A realistic session — the user actually doing things
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Twelve gestures drawn from v1's real mutation sites: create, edit, move, resize, recategorise,
 * delete-with-fan-out, scratchpad typing, a settings write, and a declined transaction.
 * Returns the store plus a running log of what the board looked like after each step.
 */
function session(store) {
  const steps = [];
  const step = (label, fn) => {
    const before = store.stacks.size().undo;
    fn();
    // Whether the step recorded an undo entry is a PROPERTY OF THE STEP, not an assumption: a
    // `pref`-only transaction writes no undoable register and pushes nothing (rule U6), so a
    // retrace that assumed one entry per gesture would walk off by one. Recording it here is
    // what lets the undo walk below be exact instead of approximately right.
    steps.push({
      label,
      undoable: store.stacks.size().undo > before,
      content: content(store.state),
      sig: sig(store.state),
    });
  };

  step('note.create', () => store.txn('Notiz anlegen', (tx) => {
    tx.note('n-new').create({
      date: '2026-05-14', text: 'Impfung', categoryId: CAT[0],
      repeatsYearly: false, visibility: 'privat', coEdit: false,
    });
    tx.pref({ lastCategoryId: CAT[0] });          // rule U6: local, no gid, never undone
  }));

  step('note.edit', () => store.txn('Notiz bearbeiten', (tx) => {
    tx.note('n-1').set({ text: 'Zahnarzt 15:00' });
  }));

  step('note.move', () => store.txn('Notiz verschieben', (tx) => {
    tx.note('n-2').set({ date: '2026-03-05' });
  }));

  step('bar.resize', () => store.txn('Balken ändern', (tx) => {
    tx.bar('b-1').set({ endDate: '2026-05-31' });
  }));

  step('bar.create', () => store.txn('Balken anlegen', (tx) => {
    tx.bar('b-new').create({
      startDate: '2026-06-01', endDate: '2026-06-14', label: 'Ferien',
      categoryId: CAT[1], visibility: 'privat', coEdit: false,
    });
  }));

  step('cat.rename', () => store.txn('Kategorie umbenennen', (tx) => {
    tx.cat(CAT[1]).set({ name: 'Schule & Kita' });
  }));

  step('cat.hide', () => store.txn('Kategorie ausblenden', (tx) => {
    tx.cat(CAT[2]).set({ visible: false });
  }));

  // Story 4.6 — creating into a hidden category un-hides it, inside the SAME group, so it is
  // one ⌘Z. This is the case where a transaction writes an entity the user did not name.
  step('note.into-hidden', () => store.txn('Notiz in versteckter Kategorie', (tx) => {
    tx.note('n-hidden').create({
      date: '2026-07-01', text: 'Sommerfest', categoryId: CAT[2],
      repeatsYearly: false, visibility: 'privat', coEdit: false,
    });
    tx.ensureVisible(CAT[2]);
  }));

  // `legend.js:197` — delete a category and reassign every entry in it, in one group.
  step('cat.delete-fanout', () => store.txn('Kategorie löschen', (tx) => {
    const dead = CAT[3];
    const into = CAT[0];
    for (const n of tx.state.notes) if (n.categoryId === dead) tx.note(n.id).set({ categoryId: into });
    for (const b of tx.state.bars) if (b.categoryId === dead) tx.bar(b.id).set({ categoryId: into });
    tx.cat(dead).del();
  }));

  step('note.delete', () => store.txn('Notiz löschen', (tx) => { tx.note('n-6').del(); }));

  step('pad.type', () => store.txn('Zettel tippen', (tx) => {
    tx.pad('2026-03').set({ text: 'Milch\nBrot\nEier' });
  }));

  step('settings', () => store.txn('Einstellungen', (tx) => {
    tx.pref({ layers: { feiertage: false } });
  }));

  return steps;
}

test('a twelve-gesture session lands on a board v1 could have written', () => {
  const { store } = migrated();
  session(store);
  const s = store.state;

  // Every gesture is visible in the result…
  assert.equal(s.notes.find((n) => n.id === 'n-new').text, 'Impfung');
  assert.equal(s.notes.find((n) => n.id === 'n-1').text, 'Zahnarzt 15:00');
  assert.equal(s.notes.find((n) => n.id === 'n-2').date, '2026-03-05');
  assert.equal(s.bars.find((b) => b.id === 'b-1').endDate, '2026-05-31');
  assert.equal(s.bars.find((b) => b.id === 'b-new').label, 'Ferien');
  assert.equal(s.categories.find((c) => c.id === CAT[1]).name, 'Schule & Kita');
  assert.equal(s.categories.find((c) => c.id === CAT[2]).visible, true, 'story 4.6 un-hid it');
  assert.equal(s.notes.find((n) => n.id === 'n-6'), undefined, 'a deleted note is gone');
  assert.equal(s.categories.find((c) => c.id === CAT[3]), undefined, 'a deleted category is gone');
  assert.equal(s.scratchpads['2026-03'], 'Milch\nBrot\nEier');

  // …and the fan-out left no orphan pointing at the dead category.
  const live = new Set(s.categories.map((c) => c.id));
  for (const n of s.notes) assert.ok(live.has(n.categoryId), `note ${n.id} orphaned`);
  for (const b of s.bars) assert.ok(live.has(b.categoryId), `bar ${b.id} orphaned`);

  // The shape is still exactly v1's — no v2 field leaked into a key v1 would have to ignore.
  const v1shape = stripV2Fields(s);
  assert.deepEqual(Object.keys(v1shape).sort(), Object.keys(defaultState()).sort());
  assert.ok(buildBoard(v1shape).cols.length > 0, 'and v1\'s layout still consumes it');
});

test('every transaction emitted exactly one broadcast, and a declined one emitted none', () => {
  const { store } = migrated();
  const before = store.events.length;
  session(store);
  assert.equal(store.events.length - before, 12, 'one emit per gesture, synchronously');

  // `store.js:150`'s decline protocol, which already prevents 16 no-op mutations in v1.
  const evts = store.events.length;
  const undoDepth = store.stacks.size().undo;
  assert.equal(store.txn('nichts', () => false), false);
  assert.equal(store.events.length, evts, 'a declined txn must not emit');
  assert.equal(store.stacks.size().undo, undoDepth, 'and must not record an undo step');

  // Clause 2 of store.contract.js §2.2: emitting zero ops is the same as declining.
  assert.equal(store.txn('leer', () => 'kept'), 'kept', 'the return value still passes through');
  assert.equal(store.events.length, evts, 'a zero-op txn must not emit either');
  assert.equal(store.stacks.size().undo, undoDepth);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. Undo / redo across the whole stack
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('undoing the whole session step by step retraces every intermediate board', () => {
  // Not just "the end state is right" — the board after each ⌘Z must equal the board that was on
  // screen at that point in the session. That is what makes undo trustworthy, and it is the
  // assertion that catches an inverse op which is right about the field and wrong about the group.
  const { store } = migrated();
  const start = content(store.state);
  const steps = session(store);
  const marks = steps.filter((x) => x.undoable);
  assert.equal(marks.length, 11, 'eleven of the twelve gestures are undoable; the pref write is not');

  for (let i = marks.length - 1; i >= 1; i--) {
    assert.equal(store.canUndo(), true, `expected to be able to undo "${marks[i].label}"`);
    assert.equal(store.undo(), true);
    assert.equal(content(store.state), marks[i - 1].content,
      `undoing "${marks[i].label}" did not restore the board that preceded it`);
  }
  assert.equal(store.undo(), true, 'and the first gesture too');
  assert.equal(content(store.state), start, 'a full unwind must land on the migrated board');
  assert.equal(store.canUndo(), false);
});

test('redoing the whole session step by step retraces it forwards', () => {
  const { store } = migrated();
  const steps = session(store).filter((x) => x.undoable);
  while (store.canUndo()) store.undo();

  for (let i = 0; i < steps.length; i++) {
    assert.equal(store.redo(), true, `expected to redo into "${steps[i].label}"`);
    assert.equal(content(store.state), steps[i].content,
      `redoing into "${steps[i].label}" landed elsewhere`);
  }
  assert.equal(store.canRedo(), false);
});

test('undo → redo of a CREATE restores the entry to its original array position, not the end', () => {
  // The reason `_born` is never written by an inverse op (ADR 001 §7.1): it is the sort key, so
  // re-stamping it on redo would move a restored note to the bottom of its day. A user who undid
  // and redid a create would watch their note jump.
  const { store } = migrated();
  store.txn('a', (tx) => tx.note('n-a').create({ date: '2026-03-04', text: 'A', categoryId: CAT[0], repeatsYearly: false, visibility: 'privat', coEdit: false }));
  store.txn('b', (tx) => tx.note('n-b').create({ date: '2026-03-04', text: 'B', categoryId: CAT[0], repeatsYearly: false, visibility: 'privat', coEdit: false }));
  store.txn('c', (tx) => tx.note('n-c').create({ date: '2026-03-04', text: 'C', categoryId: CAT[0], repeatsYearly: false, visibility: 'privat', coEdit: false }));
  const order = store.state.notes.map((n) => n.id);

  store.undo(); store.undo();          // drop b and c
  store.redo(); store.redo();          // and bring them back
  assert.deepEqual(store.state.notes.map((n) => n.id), order,
    'a redone create must return to its original position — _born must not be re-stamped');
});

test('undo of a delete resurrects the entry with the NEWEST text, not the text it died with (18.6)', () => {
  // A tombstone retains its content registers — there is no delete op at the merge layer — so a
  // resurrect is `_alive: true` and nothing else. A remote edit that arrived AFTER the delete
  // therefore survives the round trip, which is exactly story 18.6.
  const { store } = migrated();
  store.txn('löschen', (tx) => tx.note('n-1').del());
  assert.equal(store.state.notes.find((n) => n.id === 'n-1'), undefined);

  // My laptop edits the same note, not knowing it is gone here.
  const laptop = new IntegrationStore({ dev: DEV2, short: SHORT2, seed: 9 });
  laptop.wall.set(store.wall.now() + 5000);
  const remote = [];
  laptop.log.append(store.log.get([...store.log.ops({})].find((o) => o.e === 'note:n-1').id) ?? null);
  const tx = makeTx({ state: store.state, regs: store.log.registers(), act: ME, dev: DEV2, gid: pad22('gremote'), mint: () => laptop.clock.tick(), newOpId: () => pad22('oremote'), space: PERSONAL_PLACEHOLDER });
  tx.note('n-1').set({ text: 'nachträglich geändert' });
  remote.push(...tx.ops);
  store.applyRemote(remote);

  assert.equal(store.undo(), true, 'the delete is still undoable — applyRemote must not touch the stack');
  const back = store.state.notes.find((n) => n.id === 'n-1');
  assert.ok(back, 'the entry came back');
  assert.equal(back.text, 'nachträglich geändert', 'and it came back with the NEWEST text');
});

test('applyRemote moves neither stack and never clears the redo branch (18.4, rule U2)', () => {
  const { store } = migrated();
  store.txn('eins', (tx) => tx.note('n-1').set({ text: 'eins' }));
  store.txn('zwei', (tx) => tx.note('n-1').set({ text: 'zwei' }));
  store.undo();                                    // a redo branch now exists
  assert.equal(store.canRedo(), true);

  const beforeSize = store.stacks.size().undo;
  const beforeLabels = JSON.stringify(store.stacks.labels());

  const laptop = new IntegrationStore({ dev: DEV2, short: SHORT2, seed: 3 });
  laptop.wall.set(store.wall.now() + 10000);
  const tx = makeTx({ state: store.state, regs: store.log.registers(), act: ME, dev: DEV2, gid: pad22('gr2'), mint: () => laptop.clock.tick(), newOpId: () => pad22('or2'), space: PERSONAL_PLACEHOLDER });
  tx.note('n-2').set({ text: 'von der anderen Maschine' });
  store.applyRemote(tx.ops);

  assert.equal(store.stacks.size().undo, beforeSize, 'applyRemote grew or shrank the undo stack');
  assert.equal(JSON.stringify(store.stacks.labels()), beforeLabels);
  assert.equal(store.canRedo(), true, 'applyRemote cleared the redo branch — recon B2/B4');
  assert.equal(store.state.notes.find((n) => n.id === 'n-2').text, 'von der anderen Maschine');
});

test('the undo stack is bounded by 50 GROUPS, not 50 ops (story 5.4)', () => {
  const { store } = migrated();
  for (let i = 0; i < 60; i++) {
    // Each transaction writes THREE registers across two entities — 180 register writes in all.
    store.txn(`bulk-${i}`, (tx) => {
      tx.note('n-1').set({ text: `t${i}`, date: '2026-03-04' });
      tx.note('n-2').set({ text: `u${i}` });
    });
  }
  assert.equal(store.stacks.size().undo, 50, 'the bound is groups');
  let undone = 0;
  while (store.canUndo()) { store.undo(); undone++; }
  assert.equal(undone, 50);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. The log: append, dedupe, checkpoint, compact, reload
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('compaction is transparent: checkpoint + tail reloads to the identical board', () => {
  // ADR 001 §7.2. This is the assertion that makes an op log survivable on disk — if compaction
  // could change the board, every relaunch would be a coin flip.
  const { store } = migrated();
  session(store);
  const before = sig(store.state);
  const regsBefore = JSON.stringify(serializeRegisters(store.log.registers()));

  store.wall.advance(60000);
  const dropped = store.log.compact();
  assert.ok(dropped > 0, 'compaction dropped nothing — the test is not exercising it');

  const cp = JSON.parse(JSON.stringify(store.log.checkpoint()));
  const tail = [...store.log.ops({})];

  const cold = createOpLog({ now: fakeWall(store.wall.now()).now });
  cold.load({ checkpoint: cp, tail });
  assert.equal(JSON.stringify(serializeRegisters(cold.registers())), regsBefore,
    'a cold reload from {checkpoint, tail} produced different registers');

  const reloaded = materialize(cold.registers(), {
    me: ME, familySpaceId: null, members: new Map(), currentMembers: new Set([ME]),
    hiddenMembers: new Set(), prefs: {}, lastSeenSeq: {}, defaultSettings: defaultState().settings,
  });
  assert.equal(sig(reloaded), before, 'the board changed across a compaction + reload');
});

test('re-appending the entire log after a cold start is idempotent, not merely deduped', () => {
  // Dedupe by opId is an optimisation; it must never be load-bearing. Folding the same ops into
  // a log that has already compacted them away has to land on the same registers, because that
  // is what a full re-pull after a cursor reset actually does.
  const { store, ops } = migrated();
  session(store);
  const target = JSON.stringify(serializeRegisters(store.log.registers()));

  const all = [...ops, ...store.log.ops({})];
  store.wall.advance(60000);
  store.log.compact();

  const fresh = createOpLog({ now: fakeWall(store.wall.now()).now });
  const rnd = pcg32(77);
  for (const op of duplicateSome(rnd, shuffle(rnd, all), 0.3)) fresh.append(op);
  // The compacted ops are gone from `store`'s tail, so re-fold from the checkpoint it kept.
  const merged = mergeMaps(
    deserializeRegisters(store.log.checkpoint().regs),
    fresh.registers(),
  );
  assert.equal(JSON.stringify(serializeRegisters(merged)), target,
    'a shuffled, duplicated re-delivery of the whole log changed the state');
});

test('a duplicate opId is deduped; the SAME opId with a different body is a conflict, not a dupe', () => {
  const { store } = migrated();
  const one = [...store.log.ops({})][0];
  assert.equal(store.log.append(one).status, APPEND.DUPLICATE);

  const forged = { ...one, f: { ...one.f, text: 'untergeschoben' } };
  const res = store.log.append(forged);
  assert.equal(res.status, APPEND.CONFLICT,
    'two bodies under one opId is corruption or forgery and must never be silently swallowed');
});

test('the log parks a far-future op and unparks it when the clock catches up — same final state', () => {
  const { store } = migrated();
  const laptop = new IntegrationStore({ dev: DEV2, short: SHORT2, seed: 5 });
  laptop.wall.set(store.wall.now() + 26 * 3600 * 1000);      // beyond MAX_FUTURE_DRIFT_MS
  const tx = makeTx({ state: store.state, regs: store.log.registers(), act: ME, dev: DEV2, gid: pad22('gfut'), mint: () => laptop.clock.tick(), newOpId: () => pad22('ofut'), space: PERSONAL_PLACEHOLDER });
  tx.note('n-1').set({ text: 'aus der Zukunft' });
  const future = tx.ops[0];

  assert.equal(store.log.append(future).status, APPEND.PARKED);
  store._materialize();
  assert.notEqual(store.state.notes.find((n) => n.id === 'n-1').text, 'aus der Zukunft',
    'a parked op must not reach the register map');
  assert.equal(store.log.parkedSize, 1);

  // Two days later the stamp is no longer in the future, and the op is admitted unchanged.
  store.wall.advance(48 * 3600 * 1000);
  const freed = store.log.unpark(() => true);
  assert.equal(freed.length, 1, 'the op was dropped rather than retained');
  store._materialize();
  assert.equal(store.state.notes.find((n) => n.id === 'n-1').text, 'aus der Zukunft');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5. The composition survives adversity — the same session, delivered badly
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the whole session converges under 40 shuffles, duplication and partitioning', () => {
  const { store, ops } = migrated();
  session(store);
  const all = [...ops, ...store.log.ops({})];
  const target = JSON.stringify(serializeRegisters(fold(all)));

  const rnd = pcg32(2026);
  for (let i = 0; i < 40; i++) {
    const delivered = duplicateSome(rnd, shuffle(rnd, all), 0.2);
    assert.equal(JSON.stringify(serializeRegisters(fold(delivered))), target,
      `delivery order ${i} diverged`);

    // …and the same set delivered as three partitions folded in two halves, then merged.
    const [a, b, c] = partition(rnd, delivered, 3);
    const merged = mergeMaps(mergeMaps(fold(a), fold(b)), fold(c));
    assert.equal(JSON.stringify(serializeRegisters(merged)), target,
      `partition ${i} diverged`);
  }
});

test('two Macs running the same session from the same board converge on the same board', () => {
  // The R12 property one level up: both machines migrate the same `board.json` independently,
  // then exchange the ops they each authored. Migration is byte-identical, so the shared history
  // deduplicates instead of doubling, and only the genuinely divergent edits have to merge.
  const board = realBoard();
  const desktop = migrated(board, { dev: DEV, short: SHORT, seed: 1 });
  const laptopWall = fakeWall(BASE_MS + 30000);
  const laptop = migrated(board, { dev: DEV2, short: SHORT2, seed: 2, wall: laptopWall });

  assert.equal(
    JSON.stringify(serializeRegisters(desktop.store.log.registers())),
    JSON.stringify(serializeRegisters(laptop.store.log.registers())),
    'two independent migrations of one board must be byte-identical (R12)',
  );

  desktop.store.txn('desktop', (tx) => tx.note('n-1').set({ text: 'vom Desktop' }));
  laptop.store.txn('laptop', (tx) => tx.note('n-2').set({ text: 'vom Laptop' }));
  laptop.store.txn('laptop2', (tx) => tx.bar('b-1').set({ label: 'Nord II' }));

  const fromDesktop = [...desktop.store.log.ops({})].filter((o) => o.dev === DEV && o.ts > GENESIS(9999));
  const fromLaptop = [...laptop.store.log.ops({})].filter((o) => o.dev === DEV2 && o.ts > GENESIS(9999));

  desktop.store.applyRemote(fromLaptop);
  laptop.store.applyRemote(fromDesktop);

  assert.equal(sig(desktop.store.state), sig(laptop.store.state), 'the two Macs did not converge');
  assert.equal(desktop.store.state.notes.find((n) => n.id === 'n-1').text, 'vom Desktop');
  assert.equal(desktop.store.state.notes.find((n) => n.id === 'n-2').text, 'vom Laptop');
  assert.equal(desktop.store.state.bars.find((b) => b.id === 'b-1').label, 'Nord II');
});

test('a three-weeks-late op is absorbed without disturbing anything it lost to (19.6)', () => {
  const { store } = migrated();
  const late = (() => {
    const old = new IntegrationStore({ dev: DEV2, short: SHORT2, seed: 8, wall: fakeWall(BASE_MS - 21 * 86400000) });
    const tx = makeTx({ state: store.state, regs: emptyRegisters(), act: ME, dev: DEV2, gid: pad22('glate'), mint: () => old.clock.tick(), newOpId: () => pad22('olate'), space: PERSONAL_PLACEHOLDER });
    tx.note('n-1').set({ text: 'drei Wochen alt' });
    return tx.ops;
  })();

  session(store);
  const before = sig(store.state);
  store.applyRemote(late);
  assert.equal(sig(store.state), before, 'a late op with an older stamp changed the board');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6. The seams the reports disagreed about — pinned here, where both sides are loaded at once
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('materialize and registers agree on promotion — there is only one implementation left', async () => {
  // Two of the machinery reports shipped their own copy of ADR 004 §4.1's promotion rule and one
  // of them had a null guard the other did not. They are now one function. This asserts the
  // identity rather than trusting it: `materialize.js` must not re-export a second `promote`.
  const regsMod = await import('../../src/js/core/registers.js');
  const matMod = await import('../../src/js/core/materialize.js');
  assert.equal(typeof regsMod.promoteRegister, 'function');
  assert.equal(typeof regsMod.withdrawnByOther, 'function');
  assert.equal(matMod.promoteRegister, undefined,
    'materialize.js must not export a second promotion — it calls registers.js');
  const src = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../../src/js/core/materialize.js', import.meta.url), 'utf8'));
  assert.ok(src.includes('promoteRegister('),
    'materialize.js stopped delegating to registers.js:promoteRegister');
  assert.ok(!/cmpWrites\(p,\s*t\)/.test(src),
    'materialize.js grew a second hand-rolled promotion comparison');
});

test('createdAt and updatedAt come from ONE implementation, re-exported not reimplemented', async () => {
  const regsMod = await import('../../src/js/core/registers.js');
  const matMod = await import('../../src/js/core/materialize.js');
  assert.equal(matMod.createdAt, regsMod.createdAt, 'two answers to "geändert wann?" is one too many');
  assert.equal(matMod.updatedAt, regsMod.updatedAt);
  assert.equal(matMod.updatedBy, regsMod.updatedBy);
});

test('an entry\'s createdAt survives the whole pipeline and never moves when it is edited', () => {
  // `createdAt` is min over ALL an entity's register stamps (ADR 001 §1.4) — which is why a
  // second `_born` write cannot move it, and therefore why the join does not need to enforce
  // `writeOnce`. That argument is load-bearing; this is the test that keeps it true.
  const { store } = migrated();
  const born = store.state.notes.find((n) => n.id === 'n-1').createdAt;
  assert.equal(born, GENESIS(4), 'the migrated note kept its GENESIS index');
  store.wall.advance(5000);
  store.txn('edit', (tx) => tx.note('n-1').set({ text: 'später' }));
  const after = store.state.notes.find((n) => n.id === 'n-1');
  assert.equal(after.createdAt, born, 'editing moved createdAt');
  assert.ok(after.updatedAt > born, 'but updatedAt moved forward — story 17.6');
  assert.equal(after.updatedBy, ME);
});

test('the migration gid is a real GroupId and the label is the human string (ADR 001 §8.2)', () => {
  const { ops } = migrateV1(realBoard(), MIG_CTX);
  assert.equal(MIGRATION_LABEL, 'migrate:v1');
  const gids = new Set(ops.filter((o) => o.gid !== null).map((o) => o.gid));
  assert.equal(gids.size, 1, 'the whole migration is one group');
  assert.match([...gids][0], /^[A-Za-z0-9_-]{22}$/, 'a gid is a 22-char GroupId, not a label');
});

test('a migration never enters the undo stack — ⌘Z cannot undo the upgrade (rule U10)', () => {
  const { store } = migrated();
  assert.equal(store.canUndo(), false, 'the migration must not be undoable');
  assert.equal(store.stacks.size().undo, 0);
});

test('pref writes never enter history, and never clear a pending redo branch (rule U6)', () => {
  const { store } = migrated();
  store.txn('eins', (tx) => tx.note('n-1').set({ text: 'eins' }));
  store.undo();
  assert.equal(store.canRedo(), true);

  const size = store.stacks.size().undo;
  store.txn('einstellung', (tx) => tx.pref({ pageYears: 2 }));
  assert.equal(store.stacks.size().undo, size, 'a settings write recorded an undo step');
  assert.equal(store.canRedo(), true, 'a settings write cleared the redo branch');
  assert.equal(store.state.settings.pageYears, 2, 'but it did take effect');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7. The shadow-undo assertion, wired the way WP-2 will run it
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('with the shadow armed, the whole session undoes cleanly — LZP-402\'s acceptance criterion', () => {
  // ADR 001 §7.1's DEV assertion: after `undo()`, the materialized content must deep-equal the
  // v1-style snapshot taken before the transaction. This is the mode WP-2's regression suite runs
  // in, and a mutation path whose op set is INCOMPLETE fails here rather than shipping.
  const { store } = migrated(realBoard(), { shadow: true });
  assert.equal(store.stacks.shadowArmed, true);
  const steps = session(store);
  const marks = steps.filter((x) => x.undoable);
  for (let i = marks.length - 1; i >= 0; i--) assert.equal(store.undo(), true);
  while (store.canRedo()) assert.equal(store.redo(), true);
  assert.equal(content(store.state), steps[steps.length - 1].content);
});

test('the shadow assertion actually bites — an incomplete op set is caught, not tolerated', () => {
  // A guard nobody has ever seen fire is a guard that might not work. This drops one register
  // from the captured pre-image, which is precisely what a mutation site that forgot to write a
  // field looks like, and asserts the shadow notices.
  const { store } = migrated(realBoard(), { shadow: true });
  store.txn('zwei Felder', (tx) => tx.note('n-1').set({ text: 'neu', date: '2026-04-01' }));

  const entry = store.stacks.peekUndo();
  const sabotaged = { ...entry, pre: entry.pre.slice(0, 1) };
  store.stacks.clear();
  store.stacks.push(sabotaged.gid, sabotaged.label, sabotaged.pre, sabotaged.post,
    shadowContent(store.state));
  // Restoring only half the pre-image cannot reproduce the shadow, and `verify` must SAY SO
  // LOUDLY — it throws, so a mutation path with an incomplete op set fails the run rather than
  // returning a quiet false nobody checks.
  const ops = store.stacks.undo(store.state);
  for (const op of ops) applyOp(store.log.registers(), op);
  store._materialize();
  assert.throws(() => store.stacks.verify(store.state), ShadowUndoError,
    'the shadow-undo assertion did not notice an incomplete inverse');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 8. The family leg — the composition v2 actually exists for
//
// Everything above runs solo, and solo is the retrofit's acceptance criterion. But the modules
// were built for a family, and the seams that only exist under a family space — the staged
// authorization fold in front of the join, the promotion asymmetry between the truth and the
// publication namespaces, the viewer's `pub.*`-only projection — are not exercised by a solo
// board at all. A negative control that removes the promotion asymmetry passes every test above.
// So this section drives the same stack with three real members in one Kreis.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const FAM_ME = `mem_${pad22('FME')}`;
const MAMA = `mem_${pad22('FMAMA')}`;
const ADMIN = `mem_${pad22('FPAPA')}`;
const FSP = `fsp_${pad22('FAMILIE')}`;
const FDEV = {
  [FAM_ME]: { id: `dev_${pad22('DFME')}`, short: short16('DFME') },
  [MAMA]: { id: `dev_${pad22('DFMAMA')}`, short: short16('DFMAMA') },
  [ADMIN]: { id: `dev_${pad22('DFPAPA')}`, short: short16('DFPAPA') },
};
const U_NOTE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

/** Mint one family-space op for `who`, at wall millisecond `ms`. */
function famOp(who, k, e, f, ms, opts = {}) {
  let n = 0;
  const ctx = {
    act: opts.act ?? who,
    dev: FDEV[who].id,
    gid: opts.gid ?? pad22(`gf${ms}`),
    space: opts.space ?? FSP,
    familySpaceId: FSP,
    mint: () => fmt(ms, opts.ctr ?? 0, FDEV[who].short),
    newOpId: () => pad22(`of${ms}_${opts.tag ?? ''}${++n}`),
  };
  return makeOp(ctx, k, e, f, opts);
}

/** Three attested members, PAPA the genesis admin. The authz preamble, for real. */
function kreis() {
  const ops = [];
  let ms = BASE_MS;
  for (const m of [FAM_ME, MAMA, ADMIN]) {
    ops.push(famOp(m, 'member.set', memberKey(m),
      { [`dev.${FDEV[m].short}`]: attestationBlob(m, FDEV[m]) }, (ms += 1000), { tag: 'a' }));
    ops.push(famOp(m, 'member.set', memberKey(m),
      { displayName: m.slice(4, 8), colorRef: 'p1', _alive: true }, (ms += 1000), { tag: 'm' }));
  }
  ops.push(famOp(ADMIN, 'space.set', spaceKey(FSP),
    { admin: ADMIN, adminPrev: null, name: 'Familie' }, (ms += 1000), { tag: 'g' }));
  return { ops, at: ms };
}

const FAM_CTX = { me: FAM_ME, nowMs: BASE_MS + 3600000, attestVerify };
const FAM_MCTX = {
  me: FAM_ME,
  familySpaceId: FSP,
  members: new Map([FAM_ME, MAMA, ADMIN].map((m) => [m, { displayName: m.slice(4, 8), colorRef: 'p1', initial: m[4] }])),
  currentMembers: new Set([FAM_ME, MAMA, ADMIN]),
  hiddenMembers: new Set(),
  prefs: {},
  lastSeenSeq: {},
  defaultSettings: defaultState().settings,
};

/** My note, shared to the Kreis with co-edit on. */
function sharedNote(at) {
  const fk = familyKey('fnote', FAM_ME, U_NOTE);
  const gid = pad22('gshare');
  return {
    fk,
    at: at + 3000,
    ops: [
      famOp(FAM_ME, 'note.set', noteKey(U_NOTE), {
        date: '2026-12-24', text: 'Bescherung', categoryId: CAT[0], repeatsYearly: false,
        visibility: 'geteilt', coEdit: true, _alive: true,
      }, at + 1000, { space: PERSONAL_PLACEHOLDER, gid, born: true, tag: 't' }),
      famOp(FAM_ME, 'pub.set', fk, {
        'pub.level': 'geteilt', 'pub.alive': true, 'pub.coEdit': true,
        'pub.date': '2026-12-24', 'pub.text': 'Bescherung', 'pub.repeatsYearly': false,
      }, at + 1000, { gid, born: true, ctr: 1, tag: 'p' }),
    ],
  };
}

const famState = (ops) => materialize(foldAuthorized(ops, FAM_CTX).regs, FAM_MCTX);
const mine = (st) => st.notes.find((n) => n.id === U_NOTE && !n.isForeign);

test('family: a shared note reaches the Kreis and stays mine on my own board', () => {
  const k = kreis();
  const share = sharedNote(k.at);
  const st = famState([...k.ops, ...share.ops]);
  const n = mine(st);
  assert.ok(n, 'my own shared note must still be on my own board');
  assert.equal(n.text, 'Bescherung');
  assert.equal(n.level, 'geteilt', 'and the family sees it');
  assert.equal(n.isForeign, false);
  assert.equal(st.notes.filter((x) => x.id === U_NOTE).length, 1,
    'my own publication must never appear as a SECOND entry on my own board');
});

test('family: a co-editor\'s newer write is promoted onto my entry (18.2)', () => {
  const k = kreis();
  const share = sharedNote(k.at);
  const coEdit = famOp(MAMA, 'pub.set', share.fk, { 'pub.text': 'Bescherung 18:00' }, share.at + 5000, { tag: 'c' });
  const st = famState([...k.ops, ...share.ops, coEdit]);
  assert.equal(mine(st).text, 'Bescherung 18:00', 'Mama\'s co-edit did not reach my truth');
  assert.equal(mine(st).updatedBy, MAMA, 'and 17.6 names the co-editor whose value is on screen');
});

test('family: R9 — a co-editor CLEARING my field with an explicit null actually clears it (18.2)', () => {
  // The other half of the null question, and the reason "never promote a null" is the WRONG fix
  // for the admin unshare. `null` is a first-class value (ADR 004 §5.1): when Mama clears a field
  // of an entry I gave her co-edit on, my board must show it cleared. A materializer that skips
  // promoted nulls leaves my stale value on screen and looks like nothing happened — which is
  // exactly what it did until the negative control on this file caught it.
  //
  // `repeatsYearly` rather than `text`, deliberately: see the next test for why.
  const k = kreis();
  const share = sharedNote(k.at);
  const cleared = famOp(MAMA, 'pub.set', share.fk, { 'pub.repeatsYearly': null }, share.at + 5000, { tag: 'z' });
  const st = famState([...k.ops, ...share.ops, cleared]);
  const n = mine(st);
  assert.ok(n, 'the entry itself must survive — a cleared field is not a deleted entry');
  assert.equal('repeatsYearly' in n, false, 'a co-editor\'s explicit null must remove the field, not be ignored');
  assert.equal(n.text, 'Bescherung', 'and must not touch anything else');
  assert.equal(n.date, '2026-12-24');
});

test('family: CHARACTERIZED — a co-editor clearing my TEXT makes the entry non-renderable', () => {
  // Not a bug in promotion; a consequence of ADR 001 §5 step 3, which defines
  //     renderable(note) = has date && (own ? has text : …)
  // and checks it against EXPLICIT fields, never inferring meaning from absence. An own note with
  // no text is not renderable, so it leaves the board — exactly as it would if I cleared the text
  // myself. It is recorded here because the first draft of the test above assumed the opposite,
  // and because a co-editor being able to make my entry disappear from MY board is a product
  // question the PO should answer before co-edit ships (WP-10), not a merge-layer decision.
  const k = kreis();
  const share = sharedNote(k.at);
  const cleared = famOp(MAMA, 'pub.set', share.fk, { 'pub.text': null }, share.at + 5000, { tag: 'y' });
  const st = famState([...k.ops, ...share.ops, cleared]);
  assert.equal(mine(st), undefined, 'a text-less own note is not renderable (ADR 001 §5 step 3)');
  // The register is still there — nothing was destroyed, and re-typing a text brings it back.
  const regs = foldAuthorized([...k.ops, ...share.ops, cleared], FAM_CTX).regs;
  assert.equal(getRegister(regs, noteKey(U_NOTE), 'text').value, 'Bescherung',
    'my own truth register is untouched; only the promoted EFFECTIVE value is null');
});

test('family: P7c — my OWN Geteilt→Belegt downgrade does not blank my own note', () => {
  // The promotion asymmetry, through the whole stack rather than at the register layer. The
  // downgrade publishes `pub.text: null` (ADR 004 §5.1 — omission is not withdrawal), so the
  // family must lose the text while my own board keeps it.
  const k = kreis();
  const share = sharedNote(k.at);
  const gid = pad22('gdown');
  const down = [
    famOp(FAM_ME, 'note.set', noteKey(U_NOTE), { visibility: 'belegt' }, share.at + 9000,
      { space: PERSONAL_PLACEHOLDER, gid, tag: 'd' }),
    famOp(FAM_ME, 'pub.set', share.fk, { 'pub.level': 'belegt', 'pub.text': null, 'pub.coEdit': null },
      share.at + 9000, { gid, ctr: 1, tag: 'e' }),
  ];
  const all = [...k.ops, ...share.ops, ...down];
  const st = famState(all);
  assert.equal(mine(st).text, 'Bescherung', 'a downgrade blanked my own note — INV-R3 violated');
  assert.equal(mine(st).level, 'belegt');

  // …and the peer, folding the identical set, sees a Belegt block with NO text at all.
  const peer = materialize(foldAuthorized(all, { ...FAM_CTX, me: MAMA }).regs, { ...FAM_MCTX, me: MAMA });
  const seen = peer.notes.find((n) => n.isForeign && n.ownerId === FAM_ME);
  assert.ok(seen, 'the family lost the entry entirely — Belegt must still occupy the day');
  assert.equal(seen.redacted, true);
  assert.equal('text' in seen, false, 'the peer must hold no text key at all, not null and not ""');
});

test('family: an ADMIN unshare retracts the publication and leaves my truth intact (18.3, INV-R3)', () => {
  const k = kreis();
  const share = sharedNote(k.at);
  // EXACTLY `unsharePatch('fnote')` — every `pub.*` field present, `pub.level: 'privat'`, every
  // other one explicitly `null` INCLUDING `pub.alive`. Authz checks the patch for exact equality
  // on purpose: an admin who could append one extra field to an unshare would hold a general
  // write primitive on every member's entity. Getting this wrong is why the first draft of this
  // test failed — the op was rejected and the entry stayed Geteilt, which is the safe direction.
  // NOTE FOR WP-10: `project.js:retractPatch('fnote')` must produce this byte for byte.
  const unshare = famOp(ADMIN, 'pub.set', share.fk, {
    'pub.level': 'privat', 'pub.alive': null, 'pub.coEdit': null,
    'pub.date': null, 'pub.text': null, 'pub.repeatsYearly': null,
  }, share.at + 20000, { tag: 'u' });
  const all = [...k.ops, ...share.ops, unshare];
  assert.deepEqual(unshare.f, unsharePatch('fnote'), 'the fixture must be the real unshare patch');

  const st = famState(all);
  assert.equal(mine(st).text, 'Bescherung', 'an admin redaction made my own board lie to me');
  assert.equal(mine(st).date, '2026-12-24');
  assert.equal(mine(st).level, 'privat');

  const peer = materialize(foldAuthorized(all, { ...FAM_CTX, me: MAMA }).regs, { ...FAM_MCTX, me: MAMA });
  assert.equal(peer.notes.filter((n) => n.isForeign).length, 0, 'the peer must no longer see it at all');
});

test('family: the whole Kreis converges under 60 shuffles — authz, join and projection together', () => {
  const k = kreis();
  const share = sharedNote(k.at);
  const coEdit = famOp(MAMA, 'pub.set', share.fk, { 'pub.text': 'Bescherung 18:00' }, share.at + 5000, { tag: 'c' });
  const unshare = famOp(ADMIN, 'pub.set', share.fk, unsharePatch('fnote'), share.at + 20000, { tag: 'u' });
  const all = [...k.ops, ...share.ops, coEdit, unshare];
  const target = JSON.stringify(famState(all));

  const rnd = pcg32(1812);
  for (let i = 0; i < 60; i++) {
    const delivered = duplicateSome(rnd, shuffle(rnd, all), 0.2);
    assert.equal(JSON.stringify(famState(delivered)), target, `family delivery order ${i} diverged`);
  }
});

test('family: a member removed from the Kreis loses their entries instantly, with no purge op (20.2)', () => {
  const k = kreis();
  const share = sharedNote(k.at);
  const hers = famOp(MAMA, 'pub.set', familyKey('fnote', MAMA, U_NOTE), {
    'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-12-25', 'pub.text': 'Oma besuchen',
  }, share.at + 4000, { born: true, tag: 'h' });
  const all = [...k.ops, ...share.ops, hers];

  assert.equal(famState(all).notes.filter((n) => n.isForeign).length, 1, 'Mama\'s entry is on my board');
  const without = materialize(foldAuthorized(all, FAM_CTX).regs,
    { ...FAM_MCTX, currentMembers: new Set([FAM_ME, ADMIN]) });
  assert.equal(without.notes.filter((n) => n.isForeign).length, 0,
    'removing a member must drop their entries from the projection with no crypto and no purge op');
  assert.ok(mine(without), 'and must not touch mine');
});
